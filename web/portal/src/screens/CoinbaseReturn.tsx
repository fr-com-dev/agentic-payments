// 020 the Coinbase return screen, /wallet/coinbase (specs/020 FR-009; contracts/portal-ui.md "Connecting",
// contracts/portal-api.md "The return screen"). Coinbase sends the browser back here with `code` and `state`, or with
// `error` when the person cancelled or refused. The screen reads them once, takes them out of the address and the
// history before anything else (history.replaceState), and only then hands them to the portal with the person's own
// token. They live in this screen's state only, never in the browser's storage; Coinbase's own words are not shown.
import { useEffect, useRef, useState } from "react";
import type { CardFieldsFactory } from "../components/AddCard.js";
import { Link } from "../components/Link.js";
import { Banner, ScreenHeading } from "../components/ui.js";
import { useApp } from "../context.js";
import { COINBASE_CONNECTED_TEXT, NOTHING_CONNECTED_TEXT, connectRefusal } from "../messages.js";
import { ConnectCoinbase, Wallet } from "./Wallet.js";

export const COINBASE_RETURN_PATH = "/wallet/coinbase";

interface Returned {
  code: string | null;
  state: string | null;
  error: string | null;
}

type Outcome =
  /** Opened again without a query (a reload, the history): nothing to hand over, so it is the wallet. */
  | { kind: "wallet" }
  | { kind: "connecting" }
  | { kind: "connected" }
  /** Cancelled or refused at Coinbase, or a return without both values: nothing is asked of the portal. */
  | { kind: "nothing" }
  | { kind: "refused"; message: string; retry: boolean };

const readReturn = (search: string): Returned => {
  const q = new URLSearchParams(search);
  return { code: q.get("code"), state: q.get("state"), error: q.get("error") };
};

const firstOutcome = (r: Returned): Outcome => {
  if (r.code === null && r.state === null && r.error === null) return { kind: "wallet" };
  return r.error === null && r.code !== null && r.state !== null ? { kind: "connecting" } : { kind: "nothing" };
};

export function CoinbaseReturn({ cardFields }: { cardFields?: CardFieldsFactory }) {
  const { api } = useApp();
  // Read at the first render, once: the address loses them right after.
  const [returned] = useState(() => readReturn(window.location.search));
  const [outcome, setOutcome] = useState<Outcome>(() => firstOutcome(returned));
  // Handed over once, StrictMode's second run of the effect included: a state is single use (FR-009).
  const handed = useRef(false);
  useEffect(() => {
    if (handed.current) return;
    handed.current = true;
    window.history.replaceState(null, "", COINBASE_RETURN_PATH);
    const { code, state, error } = returned;
    if (error !== null || code === null || state === null) return;
    void api.completeCoinbase(code, state).then((r) => setOutcome(r.ok ? { kind: "connected" } : { kind: "refused", ...connectRefusal(r) }));
  }, [api, returned]);

  if (outcome.kind === "wallet") return <Wallet {...(cardFields && { cardFields })} />;
  if (outcome.kind === "connected") return <Wallet notice={COINBASE_CONNECTED_TEXT} {...(cardFields && { cardFields })} />;
  return (
    <section>
      <ScreenHeading>Connect Coinbase</ScreenHeading>
      {outcome.kind === "connecting" ? <p role="status">Connecting Coinbase…</p> : null}
      {outcome.kind === "nothing" ? <Banner kind="info">{NOTHING_CONNECTED_TEXT}</Banner> : null}
      {outcome.kind === "refused" ? (
        <>
          <Banner kind="error">{outcome.message}</Banner>
          {outcome.retry ? <ConnectCoinbase label="Try again" /> : null}
        </>
      ) : null}
      {outcome.kind !== "connecting" ? (
        <p>
          <Link to="/wallet">Back to your wallet</Link>
        </p>
      ) : null}
    </section>
  );
}
