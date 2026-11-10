// 013 card vault client (SPEC.md §8.2 L2-8, §3.3, §11 SEC-22; specs/013 contracts/card-vault.md).
// The only module that holds the card vault credential (rule A10). The vault is Stripe in TEST MODE, used as a
// vault only: cards are saved and removed, never charged (FR-021). This file calls six endpoints and no other; the
// restricted key it expects could not create a charge, a payment intent, a refund or a payout even if it tried.
// The card number and the security code never come here: they go from the vault's own fields in the browser straight
// to the vault (FR-018). Nothing about a payment, a policy, a seller or a person's name is ever sent.
import { randomUUID } from "node:crypto";

export const API_BASE = "https://api.stripe.com";
/** Pinned (a constant, never configuration). The browser loads the matching Stripe.js release. */
export const API_VERSION = "2026-10-28.endive";
export const STRIPE_JS_URL = "https://js.stripe.com/endive/stripe.js";
/** What the portal's Content-Security-Policy must allow for the vault's hosted fields (card-vault.md). */
export const CARD_VAULT_CSP = {
  script: ["https://js.stripe.com", "https://*.js.stripe.com"],
  frame: ["https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com"],
  connect: [API_BASE],
} as const;
export const CARD_NICKNAME_MAX = 40;
const TIMEOUT_MS = 10_000;
/** Vault error codes that may be kept or shown. Anything else becomes `other`; the vault's text never is. */
const CODE_WHITELIST = new Set([
  "card_declined",
  "expired_card",
  "incorrect_cvc",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "incorrect_number",
  "processing_error",
  "setup_intent_authentication_failure",
]);

type Env = Record<string, string | undefined>;

export interface CardVaultConfig {
  key: string;
  publishableKey: string;
}

export class CardVaultConfigError extends Error {
  override name = "CardVaultConfigError";
}

/**
 * Reads the card vault settings. Unset `CARD_VAULT`: cards are off (undefined). `stripe`: both keys are required and
 * both must be TEST keys; a live key is always a startup error. Errors name the variable, never its value.
 */
export function cardVaultFromEnv(env: Env): CardVaultConfig | undefined {
  const mode = env.CARD_VAULT;
  if (mode === undefined || mode === "") return undefined;
  if (mode !== "stripe") throw new CardVaultConfigError('CARD_VAULT must be "stripe" or unset');
  const key = env.CARD_VAULT_KEY ?? "";
  const publishableKey = env.CARD_VAULT_PUBLISHABLE_KEY ?? "";
  if (key === "") throw new CardVaultConfigError("missing CARD_VAULT_KEY (CARD_VAULT=stripe)");
  if (!/^(rk|sk)_test_/.test(key)) throw new CardVaultConfigError("CARD_VAULT_KEY must be a test key (rk_test_… or sk_test_…); a live key is never accepted");
  if (publishableKey === "") throw new CardVaultConfigError("missing CARD_VAULT_PUBLISHABLE_KEY (CARD_VAULT=stripe)");
  if (!/^pk_test_/.test(publishableKey)) throw new CardVaultConfigError("CARD_VAULT_PUBLISHABLE_KEY must be a test key (pk_test_…); a live key is never accepted");
  return { key, publishableKey };
}

export type CardVaultFailure = "unavailable" | "auth" | "not_found" | "live_mode";

/** A failed vault call. It carries a kind, the HTTP status and a whitelisted code; never the vault's message. */
export class CardVaultError extends Error {
  override name = "CardVaultError";
  constructor(
    readonly kind: CardVaultFailure,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`card vault: ${kind}${status === undefined ? "" : ` (${status})`}`);
  }
}

export interface VaultCard {
  /** The vault's own identifier of the saved card. Never leaves the portal process. */
  paymentMethodId: string;
  cardId?: string;
  nickname?: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** Used only to refuse a duplicate. Never returned to the browser, logged or stored. */
  fingerprint?: string;
  createdAtMs: number;
}

export interface VaultSetup {
  id: string;
  status: string;
  customer?: string;
  /** A whitelisted code of the last failed attempt, if any. */
  errorCode?: string;
  /** Present when the saved payment method is a card. */
  card?: VaultCard;
  /** Present when a payment method was saved, card or not. */
  paymentMethodId?: string;
}

export interface CardVaultOptions {
  /** Test-only: the stand-in's address. Production always uses API_BASE. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const whitelisted = (code: unknown): string | undefined => (typeof code === "string" ? (CODE_WHITELIST.has(code) ? code : "other") : undefined);

function cardOf(pm: Record<string, unknown>): VaultCard | undefined {
  const card = pm.card as Record<string, unknown> | undefined;
  if (!card || typeof pm.id !== "string") return undefined;
  const metadata = (pm.metadata ?? {}) as Record<string, unknown>;
  return {
    paymentMethodId: pm.id,
    ...(typeof metadata.x402_card_id === "string" && metadata.x402_card_id !== "" && { cardId: metadata.x402_card_id }),
    ...(typeof metadata.nickname === "string" && metadata.nickname !== "" && { nickname: metadata.nickname }),
    brand: String(card.brand ?? "unknown"),
    last4: String(card.last4 ?? ""),
    expMonth: Number(card.exp_month),
    expYear: Number(card.exp_year),
    ...(typeof card.fingerprint === "string" && { fingerprint: card.fingerprint }),
    createdAtMs: Number(pm.created ?? 0) * 1000,
  };
}

export class CardVault {
  readonly publishableKey: string;
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(config: CardVaultConfig, o: CardVaultOptions = {}) {
    this.#key = config.key;
    this.publishableKey = config.publishableKey;
    this.#base = o.baseUrl ?? API_BASE;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  /** One call, with one retry (same idempotency key) on a network error, a 429 or a 5xx. Redirects are not followed. */
  async #call(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    const idempotencyKey = method === "POST" ? randomUUID() : undefined;
    let last: CardVaultError = new CardVaultError("unavailable");
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(`${this.#base}${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(this.#timeoutMs),
          headers: {
            authorization: `Bearer ${this.#key}`,
            "stripe-version": API_VERSION,
            ...(method === "POST" && { "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey! }),
          },
          ...(method === "POST" && { body: new URLSearchParams(form ?? {}).toString() }),
        });
      } catch {
        last = new CardVaultError("unavailable");
        continue;
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // A non-JSON answer is treated like the status says, with no body.
      }
      if (res.status === 429 || res.status >= 500) {
        last = new CardVaultError("unavailable", res.status);
        if (res.headers.get("stripe-should-retry") === "false") break;
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new CardVaultError("auth", res.status);
      if (res.status === 404) throw new CardVaultError("not_found", 404);
      if (res.status < 200 || res.status >= 300) {
        const error = (body.error ?? {}) as Record<string, unknown>;
        if (error.code === "resource_missing") throw new CardVaultError("not_found", res.status);
        throw new CardVaultError("unavailable", res.status, whitelisted(error.code));
      }
      // Test mode only: an answer from live mode is refused, whatever it says.
      if (body.livemode === true) throw new CardVaultError("live_mode");
      return body;
    }
    throw last;
  }

  /** One customer per user. It carries the opaque user identifier and nothing else. */
  async createCustomer(userId: string): Promise<string> {
    const body = await this.#call("POST", "/v1/customers", { "metadata[x402_user_id]": userId });
    return String(body.id);
  }

  async createSetupIntent(customer: string, userId: string): Promise<{ id: string; clientSecret: string }> {
    const body = await this.#call("POST", "/v1/setup_intents", {
      customer,
      "allowed_payment_method_types[]": "card",
      usage: "off_session",
      "metadata[x402_user_id]": userId,
    });
    return { id: String(body.id), clientSecret: String(body.client_secret) };
  }

  async getSetupIntent(id: string): Promise<VaultSetup> {
    const body = await this.#call("GET", `/v1/setup_intents/${encodeURIComponent(id)}?expand[]=payment_method`);
    const pm = body.payment_method;
    const expanded = pm !== null && typeof pm === "object" ? (pm as Record<string, unknown>) : undefined;
    const card = expanded ? cardOf(expanded) : undefined;
    const errorCode = whitelisted(((body.last_setup_error ?? {}) as Record<string, unknown>).code);
    const paymentMethodId = expanded && typeof expanded.id === "string" ? expanded.id : typeof pm === "string" ? pm : undefined;
    return {
      id: String(body.id),
      status: String(body.status),
      ...(typeof body.customer === "string" && { customer: body.customer }),
      ...(errorCode !== undefined && { errorCode }),
      ...(card && { card }),
      ...(paymentMethodId !== undefined && { paymentMethodId }),
    };
  }

  async listCards(customer: string): Promise<VaultCard[]> {
    const body = await this.#call("GET", `/v1/customers/${encodeURIComponent(customer)}/payment_methods?type=card&limit=100`);
    const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    return data.flatMap((pm) => cardOf(pm) ?? []);
  }

  async label(paymentMethodId: string, cardId: string, nickname?: string): Promise<void> {
    await this.#call("POST", `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`, {
      "metadata[x402_card_id]": cardId,
      ...(nickname !== undefined && { "metadata[nickname]": nickname }),
    });
  }

  /** Removes the saved card from the vault. Permanent there. */
  async detach(paymentMethodId: string): Promise<void> {
    await this.#call("POST", `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {});
  }
}
