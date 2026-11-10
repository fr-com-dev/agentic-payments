// 013 registered cards (SPEC.md §8.2 L2-8; specs/013 contracts/card-vault.md, research R8). A card is saved at the
// card vault and never charged (FR-021). This system stores nothing about it: the vault says which cards exist, the
// ledger (through L2) says what happened, and every list reconciles the two. The order of the two writes makes every
// partial failure end with fewer cards, never more, and never a card without its ledger entry (FR-044).
import { randomUUID } from "node:crypto";
import { CARD_NICKNAME_MAX, CardVaultError, type CardVault, type VaultCard } from "./card-vault.js";
import { ControlError, ControlUnavailable, type ControlPort } from "./control-client.js";
import type { ProfileStore } from "./profile-store.js";

export const MAX_CARDS = 5;

/** What the browser gets. Never the vault's identifiers or the fingerprint. */
export interface Card {
  cardId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  nickname?: string;
  addedAt: string;
  expired: boolean;
}

/** A refusal with the status and code the portal API answers (contracts/portal-api.md). */
export class CardRefusal extends Error {
  override name = "CardRefusal";
  constructor(
    readonly status: number,
    readonly code: string,
    /** A whitelisted vault code, when the vault refused the card itself. */
    readonly vaultCode?: string,
  ) {
    super(code);
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** At most 40 characters after trimming, no control characters. An empty value means no nickname. */
export function validNickname(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return undefined;
  return t.length <= CARD_NICKNAME_MAX && !CONTROL_CHARS.test(t) ? t : null;
}

/** True when the card's last valid month has passed at `nowMs` (cards are valid through the end of that month, UTC). */
export function cardExpired(c: Pick<VaultCard, "expMonth" | "expYear">, nowMs: number): boolean {
  return nowMs >= Date.UTC(c.expYear, c.expMonth, 1);
}

const project = (c: VaultCard, nowMs: number): Card => ({
  cardId: c.cardId!,
  brand: c.brand,
  last4: c.last4,
  expMonth: c.expMonth,
  expYear: c.expYear,
  ...(c.nickname !== undefined && { nickname: c.nickname }),
  addedAt: new Date(c.createdAtMs).toISOString(),
  expired: cardExpired(c, nowMs),
});

export interface CardsDeps {
  vault: CardVault;
  profiles: ProfileStore;
  control: ControlPort;
  now?: () => number;
}

export class Cards {
  private readonly now: () => number;
  constructor(private readonly d: CardsDeps) {
    this.now = d.now ?? Date.now;
  }

  private customerOf(userId: string): string | undefined {
    return this.d.profiles.get(userId)?.cardVaultCustomer;
  }

  /** The user's cards, after reconciling the vault and the ledger (research R8). */
  async list(userId: string, knownCardIds: readonly string[]): Promise<Card[]> {
    const customer = this.customerOf(userId);
    const inVault = customer === undefined ? [] : await this.d.vault.listCards(customer);
    const labeled: VaultCard[] = [];
    for (const c of inVault) {
      // A saved card that never got its identifier is an add that was interrupted: it must not stay.
      if (c.cardId === undefined) await this.d.vault.detach(c.paymentMethodId);
      else labeled.push(c);
    }
    // A card the ledger still lists that the vault no longer has was removed at the vault: record it.
    for (const cardId of knownCardIds) {
      if (!labeled.some((c) => c.cardId === cardId)) await this.d.control.removeCard(userId, cardId);
    }
    return labeled.sort((a, b) => a.createdAtMs - b.createdAtMs).map((c) => project(c, this.now()));
  }

  /** Starts a card setup at the vault. The client secret goes to the browser once and is never stored or logged. */
  async setup(userId: string, state: { enabled: boolean; cards: readonly string[] }): Promise<{ clientSecret: string }> {
    if (!state.enabled) throw new CardRefusal(409, "account_disabled");
    if (state.cards.length >= MAX_CARDS) throw new CardRefusal(409, "card_limit");
    let customer = this.customerOf(userId);
    if (customer === undefined) {
      customer = await this.d.vault.createCustomer(userId);
      const saved = this.d.profiles.update(userId, (p) => ({ ...p, cardVaultCustomer: customer! }), this.now());
      if (!saved) throw new CardRefusal(409, "profile_required");
    }
    const intent = await this.d.vault.createSetupIntent(customer, userId);
    return { clientSecret: intent.clientSecret };
  }

  /** Finishes an add: checks the vault's result, labels the card, then records it in the ledger. */
  async confirm(userId: string, setupIntentId: string, nickname: string | undefined): Promise<Card> {
    const customer = this.customerOf(userId);
    // No customer means this user never started a setup: the intent can't be theirs.
    if (customer === undefined) throw new CardRefusal(404, "not found");
    let setup;
    try {
      setup = await this.d.vault.getSetupIntent(setupIntentId);
    } catch (err) {
      if (err instanceof CardVaultError && err.kind === "not_found") throw new CardRefusal(404, "not found");
      throw err;
    }
    // Another user's setup intent answers like an unknown one (FR-004).
    if (setup.customer !== customer) throw new CardRefusal(404, "not found");
    if (setup.status !== "succeeded") throw new CardRefusal(409, "card_not_confirmed", setup.errorCode);
    const detach = async () => {
      if (setup.paymentMethodId !== undefined) await this.d.vault.detach(setup.paymentMethodId);
    };
    const card = setup.card;
    if (!card) {
      await detach();
      throw new CardRefusal(422, "not_a_card");
    }
    if (cardExpired(card, this.now())) {
      await detach();
      throw new CardRefusal(422, "card_expired");
    }
    // Already labeled: this setup was confirmed before (a retry). Return the same card; nothing is recorded twice.
    if (card.cardId !== undefined) {
      await this.d.control.addCard(userId, card.cardId);
      return project(card, this.now());
    }
    const others = (await this.d.vault.listCards(customer)).filter((c) => c.paymentMethodId !== card.paymentMethodId && c.cardId !== undefined);
    if (card.fingerprint !== undefined && others.some((c) => c.fingerprint === card.fingerprint)) {
      await detach();
      throw new CardRefusal(409, "card_already_registered");
    }
    if (others.length >= MAX_CARDS) {
      await detach();
      throw new CardRefusal(409, "card_limit");
    }
    const cardId = `card_${randomUUID()}`;
    await this.d.vault.label(card.paymentMethodId, cardId, nickname);
    try {
      await this.d.control.addCard(userId, cardId);
    } catch (err) {
      // The ledger did not take it: the card must not stay in the wallet without its entry.
      await detach().catch(() => undefined);
      if (err instanceof ControlError) throw new CardRefusal(err.status, err.code);
      if (err instanceof ControlUnavailable) throw err;
      throw err;
    }
    return project({ ...card, cardId, ...(nickname !== undefined && { nickname }) }, this.now());
  }

  /** Removes a card: the vault first (that is what revokes it), then the ledger. */
  async remove(userId: string, cardId: string): Promise<void> {
    const customer = this.customerOf(userId);
    const card = customer === undefined ? undefined : (await this.d.vault.listCards(customer)).find((c) => c.cardId === cardId);
    if (!card) throw new CardRefusal(404, "not found");
    await this.d.vault.detach(card.paymentMethodId);
    // If L2 can't be reached now, the next list reconciles it: the card is already gone from the vault.
    await this.d.control.removeCard(userId, cardId).catch((err: unknown) => {
      if (!(err instanceof ControlUnavailable)) throw err;
    });
  }
}
