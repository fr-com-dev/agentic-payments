// The wallet (specs/013 US2, US6; contracts/portal-ui.md "Onboarding" step 2 and "Wallet"). The crypto account is
// created and held by L2; this screen shows its public address and figures and never a key. Cards are saved at the
// card vault and never pay (FR-021): the notice is always there. No control moves funds out (FR-016).
// 020 (specs/020 contracts/portal-ui.md "The wallet: two parts", FR-012): the account and the cards are the first
// part, the one the agent pays from; Coinbase is a second part, view only. Nothing of Coinbase is ever added to the
// first part, and nothing here moves Coinbase funds (FR-021).
import { useCallback, useEffect, useId, useState } from "react";
import { PlatformBalances } from "../components/PlatformBalances.js";
import { Banner, Dialog, ScreenHeading } from "../components/ui.js";
import { useAccount, useApp } from "../context.js";
import {
  AGENT_PAYS_TITLE,
  COINBASE_CONNECTIONS_URL,
  COINBASE_PART_TITLE,
  COINBASE_READ_ONLY_TEXT,
  COINBASE_RECONNECT_TEXT,
  COINBASE_UNAVAILABLE_TEXT,
  DISCONNECTED_TEXT,
  DISCONNECT_QUESTION,
  DISCONNECT_TEXT,
  GOING_TO_COINBASE_TEXT,
  NOT_REVOKED_TEXT,
  START_FAILED_TEXT,
  errorMessage,
} from "../messages.js";
import { formatUsdcFixed } from "../money.js";
import { formatDay } from "../summary.js";
import type { Account, Card, Connection, ConnectionStatus, Wallet as WalletData } from "../types.js";
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

/** Coinbase's sign-in is an https address; anything else the web app never goes to. */
const COINBASE_SIGN_IN = /^https:\/\//i;

/**
 * 020 Connect Coinbase, Reconnect and Try again (contracts/portal-ui.md "Connecting"): asks the portal to start a
 * connection, then goes to Coinbase in this same tab. No pop-up: the sign-in survives the trip in session storage,
 * and Coinbase's isolation headers would cut a pop-up's opener (research R2).
 */
export function ConnectCoinbase({ label }: { label: string }) {
  const { api } = useApp();
  const [going, setGoing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    // Back from Coinbase with the browser's own Back button, the page can be restored as it was left: ready again.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setGoing(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  const go = async () => {
    if (going) return;
    setGoing(true);
    setProblem(null);
    const r = await api.startCoinbase();
    if (r.ok && COINBASE_SIGN_IN.test(r.data.authorizeUrl)) {
      // The button keeps saying where the person is going until the page is gone.
      window.location.assign(r.data.authorizeUrl);
      return;
    }
    setGoing(false);
    setProblem(r.ok ? START_FAILED_TEXT : errorMessage(r));
  };
  return (
    <>
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      <button type="button" onClick={() => void go()} disabled={going}>
        {going ? GOING_TO_COINBASE_TEXT : label}
      </button>
    </>
  );
}

/** The deployment's own pages (FR-030), linked only when the address is one a link may carry. */
const OWN_PAGE = /^(https:\/\/|mailto:)/i;
const OwnPage = ({ href, children }: { href: string; children: string }) => (OWN_PAGE.test(href) ? <a href={href}>{children}</a> : <span>{children}</span>);

/**
 * 020 the Coinbase part (contracts/portal-ui.md "The wallet: two parts"): one status at a time. While the account is
 * disabled only Disconnect is offered, and nothing is read from Coinbase.
 */
function CoinbasePart({ row, disabled, onStatus, reload }: { row: Connection; disabled: boolean; onStatus(status: ConnectionStatus): void; reload(): Promise<void> }) {
  const { api } = useApp();
  const titleId = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ended, setEnded] = useState<{ revokedAtPlatform: boolean } | null>(null);
  const disconnect = async () => {
    setAsking(false);
    setBusy(true);
    const r = await api.deleteCoinbase();
    setBusy(false);
    if (!r.ok) {
      setProblem(errorMessage(r));
      return;
    }
    setProblem(null);
    setEnded({ revokedAtPlatform: r.data.revokedAtPlatform === true });
    // The balances go at once (FR-018); then the portal's own row says what is offered now.
    onStatus("not_connected");
    await reload();
  };
  const beforeConnecting = row.status === "not_connected" || row.status === "reconnect";
  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>{COINBASE_PART_TITLE}</h2>
      {ended?.revokedAtPlatform === true ? <Banner kind="info">{DISCONNECTED_TEXT}</Banner> : null}
      {ended?.revokedAtPlatform === false ? (
        <Banner kind="warning">
          {NOT_REVOKED_TEXT} <a href={COINBASE_CONNECTIONS_URL}>accounts.coinbase.com/security/connections</a>
        </Banner>
      ) : null}
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      {row.status === "not_connected" ? <p>{COINBASE_READ_ONLY_TEXT}</p> : null}
      {row.status === "connected" ? <p>{row.connectedAt !== undefined ? `Connected on ${formatDay(row.connectedAt)}` : "Connected."}</p> : null}
      {row.status === "reconnect" ? <p>{COINBASE_RECONNECT_TEXT}</p> : null}
      {row.status === "unavailable" ? <p>{COINBASE_UNAVAILABLE_TEXT}</p> : null}
      {beforeConnecting ? (
        <p>
          <OwnPage href={row.privacyPolicyUrl}>Privacy policy</OwnPage> · <OwnPage href={row.supportUrl}>Support</OwnPage>
        </p>
      ) : null}
      {row.status === "connected" && !disabled ? <PlatformBalances onStatus={onStatus} /> : null}
      {beforeConnecting ? (
        disabled ? (
          <p className="field-help">Your account is disabled.</p>
        ) : (
          <ConnectCoinbase label={row.status === "reconnect" ? "Reconnect" : "Connect Coinbase"} />
        )
      ) : null}
      {row.status !== "not_connected" ? (
        <>
          {" "}
          <button type="button" className="secondary" onClick={() => setAsking(true)} disabled={busy}>
            Disconnect
          </button>
        </>
      ) : null}
      {asking ? (
        <Dialog title={DISCONNECT_QUESTION} onClose={() => setAsking(false)}>
          <p>{DISCONNECT_TEXT}</p>
          <button type="button" onClick={() => void disconnect()}>
            Disconnect Coinbase
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </Dialog>
      ) : null}
    </section>
  );
}

export function Wallet({ cardFields, notice }: { cardFields?: CardFieldsFactory; notice?: string }) {
  const { api } = useApp();
  const { locked } = useAccount();
  const payId = useId();
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
  const setCoinbaseStatus = useCallback((status: ConnectionStatus) => {
    setWallet((w) => (w === null ? w : { ...w, connections: (w.connections ?? []).map((c) => (c.platform === "coinbase" ? { ...c, status } : c)) }));
  }, []);
  const coinbase = wallet?.connections?.find((c) => c.platform === "coinbase");

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
      {notice !== undefined ? <Banner kind="info">{notice}</Banner> : null}
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      <section aria-labelledby={payId}>
        <h2 id={payId}>{AGENT_PAYS_TITLE}</h2>
        <h3>Crypto account</h3>
        {wallet === null ? <p>Loading…</p> : wallet.account ? <AccountDetails a={wallet.account} /> : <p>You have no crypto account yet.</p>}

        <h3>Cards</h3>
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
      </section>
      {/* 020: shown once the wallet has answered, so the part above never waits for Coinbase (FR-016). */}
      {wallet !== null && coinbase !== undefined ? <CoinbasePart row={coinbase} disabled={disabled} onStatus={setCoinbaseStatus} reload={load} /> : null}
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
