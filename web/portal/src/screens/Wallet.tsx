// The wallet (specs/013 US2, US6; contracts/portal-ui.md "Onboarding" step 2 and "Wallet"). The crypto account is
// created and held by L2; this screen shows its public address and figures and never a key. Cards are saved at the
// card vault and never pay (FR-021): the notice is always there. No control moves funds out (FR-016).
import { useCallback, useEffect, useState } from "react";
import { Banner, Dialog, ScreenHeading } from "../components/ui.js";
import { useAccount, useApp } from "../context.js";
import { errorMessage } from "../messages.js";
import { formatUsdcFixed } from "../money.js";
import type { Account, Card, Wallet as WalletData } from "../types.js";
import { AddCard, type CardFieldsFactory } from "../components/AddCard.js";

export const CARD_NOTICE = "Agents can't pay with cards yet. A card here is saved for later.";
export const MAX_CARDS = 5;

const NETWORK_NAMES: Record<string, string> = { "eip155:31337": "the local test network", "eip155:84532": "Base Sepolia (testnet)" };
const networkName = (n: string) => NETWORK_NAMES[n] ?? n;
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
};

export function AccountDetails({ a }: { a: Account }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <dl className="figures">
        <dt>Address</dt>
        <dd>
          <code>{a.address}</code>{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              void navigator.clipboard?.writeText(a.address);
              setCopied(true);
            }}
          >
            Copy address
          </button>
          {copied ? <span role="status"> Copied.</span> : null}
        </dd>
        <dt>Network</dt>
        <dd>{networkName(a.network)}</dd>
        <dt>Asset</dt>
        <dd>USDC (test)</dd>
        <dt>Balance</dt>
        <dd>
          {a.balanceAtomic !== undefined ? (
            <>
              {formatUsdcFixed(a.balanceAtomic, a.decimals)} USDC{a.balanceReadAt !== undefined ? <span className="muted"> as of {timeOf(a.balanceReadAt)}</span> : null}
              {a.balanceStale ? <span className="flag"> (couldn't refresh)</span> : null}
            </>
          ) : (
            <span className="flag">Couldn't read the balance right now</span>
          )}
        </dd>
        <dt>Committed to payments that can still settle</dt>
        <dd>{formatUsdcFixed(a.committedAtomic, a.decimals)} USDC</dd>
        <dt>Spent in the last 24 hours</dt>
        <dd>
          {formatUsdcFixed(a.spent24hAtomic, a.decimals)} of {formatUsdcFixed(a.dailyCeilingAtomic, a.decimals)} USDC (your daily ceiling)
        </dd>
      </dl>
      {a.lowBalance ? <Banner kind="warning">Your balance is lower than what one of your policies allows per payment. A payment may fail until you add funds.</Banner> : null}
      <p>
        To fund it, send test USDC on {networkName(a.network)} to this address: <code>{a.address}</code>
        {a.network === "eip155:84532" ? " (for example from faucet.circle.com)" : ""}.
      </p>
    </>
  );
}

function CardRow({ card, onRemove, disabled }: { card: Card; onRemove(): void; disabled: boolean }) {
  return (
    <li className="card-row">
      <span className="card-brand">{card.brand}</span> ending in {card.last4}, expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}
      {card.nickname !== undefined ? <span className="muted"> · {card.nickname}</span> : null}
      {card.expired ? <span className="status status-expired"> Expired</span> : null}{" "}
      <button type="button" className="link" onClick={onRemove} disabled={disabled}>
        Remove <span className="visually-hidden">the card ending in {card.last4}</span>
      </button>
    </li>
  );
}

export function Wallet({ cardFields }: { cardFields?: CardFieldsFactory }) {
  const { api } = useApp();
  const { locked } = useAccount();
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Card | null>(null);
  const load = useCallback(async () => {
    const r = await api.wallet();
    if (r.ok) setWallet(r.data);
    else setProblem(errorMessage(r));
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const cards = wallet?.cards ?? [];
  const disabled = locked || wallet?.disabled === true;
  const addBlocked = disabled
    ? "Your account is disabled."
    : wallet !== null && !wallet.cardsAvailable
      ? "Cards are not available right now."
      : cards.length >= MAX_CARDS
        ? "You can register at most 5 cards."
        : null;
  const remove = async (card: Card) => {
    setRemoving(null);
    const r = await api.removeCard(card.cardId);
    if (r.ok) {
      setProblem(null);
      setWallet((w) => (w === null ? w : { ...w, cards: r.data.cards }));
    } else setProblem(errorMessage(r));
  };

  return (
    <section>
      <ScreenHeading>Wallet</ScreenHeading>
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      <h2>Crypto account</h2>
      {wallet === null ? <p>Loading…</p> : wallet.account ? <AccountDetails a={wallet.account} /> : <p>You have no crypto account yet.</p>}

      <h2>Cards</h2>
      <Banner kind="info">{CARD_NOTICE}</Banner>
      {cards.length === 0 ? (
        <p>No card is registered.</p>
      ) : (
        <ul className="cards" aria-label="Your cards">
          {cards.map((c) => (
            <CardRow key={c.cardId} card={c} disabled={false} onRemove={() => setRemoving(c)} />
          ))}
        </ul>
      )}
      {adding ? (
        <AddCard
          {...(cardFields && { cardFields })}
          onDone={(card) => {
            setAdding(false);
            if (card) setWallet((w) => (w === null ? w : { ...w, cards: [...w.cards, card] }));
          }}
        />
      ) : (
        <>
          <button type="button" onClick={() => setAdding(true)} disabled={addBlocked !== null} aria-describedby={addBlocked !== null ? "add-card-why" : undefined}>
            Add a card
          </button>
          {addBlocked !== null ? (
            <p id="add-card-why" className="field-help">
              {addBlocked}
            </p>
          ) : null}
        </>
      )}
      {removing !== null ? (
        <Dialog title="Remove this card?" onClose={() => setRemoving(null)}>
          <p>
            The {removing.brand} card ending in {removing.last4} will be removed from your wallet.
          </p>
          <button type="button" onClick={() => void remove(removing)}>
            Remove card
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setRemoving(null)}>
            Cancel
          </button>
        </Dialog>
      ) : null}
    </section>
  );
}
