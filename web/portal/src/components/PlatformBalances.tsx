// 020 the Coinbase balances (specs/020 contracts/portal-ui.md "The balances"; FR-013..FR-017). Mounted only once the
// wallet has answered, so the account the agent pays from never waits for Coinbase (FR-016). Every figure is shown
// from its decimal string through formatDecimal, never as a number; every name and code from Coinbase is React text,
// never markup (FR-028). The figures live in this component's state only: nothing is stored in the browser.
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context.js";
import {
  BALANCES_READING_TEXT,
  BALANCES_UNREADABLE_TEXT,
  NO_FUNDS_TEXT,
  NO_RATE_TEXT,
  errorMessage,
  moreAssetsText,
  notCountedText,
  staleBalancesText,
  totalLabel,
} from "../messages.js";
import { formatDecimal } from "../money.js";
import type { PlatformAsset, PlatformBalances as Balances } from "../types.js";
import { Banner } from "./ui.js";

/** A fresh read at most once every 10 s (FR-014): Refresh waits this long after each read. */
export const REFRESH_PAUSE_MS = 10_000;

const isoTime = (iso: string): Date | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
/** `2026-11-25 14:02:11 UTC`, as the rest of the wallet shows a read time. */
const timeOf = (iso: string) => {
  const d = isoTime(iso);
  return d === null ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
};
/** `14:02:11 UTC`: the time of Coinbase's rates, in the total's label. */
const clockOf = (iso: string) => {
  const d = isoTime(iso);
  return d === null ? iso : `${d.toISOString().slice(11, 19)} UTC`;
};
const assetName = (a: PlatformAsset) => (a.name !== "" ? `${a.name} · ${a.code}` : a.code);

type Shown = { kind: "reading" } | { kind: "figures"; balances: Balances } | { kind: "failed"; message: string };

function Figures({ b }: { b: Balances }) {
  if (b.assets.length === 0 && b.more === 0) return <p>{NO_FUNDS_TEXT}</p>;
  return (
    <>
      <table className="stacked">
        <caption>Your Coinbase balances</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Amount</th>
            <th scope="col">Value in US dollars</th>
          </tr>
        </thead>
        <tbody>
          {b.assets.map((a, i) => (
            // A code can appear twice (a wallet and a vault of the same asset): the position keeps rows apart.
            <tr key={`${String(i)}:${a.code}`}>
              <td data-label="Asset">{assetName(a)}</td>
              <td data-label="Amount">{formatDecimal(a.amount)}</td>
              <td data-label="Value in US dollars">{a.value !== undefined ? formatDecimal(a.value.amount, "USD") : NO_RATE_TEXT}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {b.more > 0 || b.moreIsAtLeast === true ? <p>{moreAssetsText(b.more, b.moreIsAtLeast === true)}</p> : null}
      {/* Coinbase's total alone: never added to, or shown beside a sum with, the account the agent pays from (FR-013). */}
      <dl className="figures">
        <dt>{totalLabel(clockOf(b.readAt))}</dt>
        <dd>{b.total !== undefined ? formatDecimal(b.total.amount, "USD") : NO_RATE_TEXT}</dd>
      </dl>
      {b.leftOutOfTotal.length > 0 ? <p>{notCountedText(b.leftOutOfTotal)}</p> : null}
    </>
  );
}

export function PlatformBalances({ onStatus }: { onStatus(status: "reconnect" | "not_connected"): void }) {
  const { api } = useApp();
  const [shown, setShown] = useState<Shown>({ kind: "reading" });
  const [reading, setReading] = useState(true);
  const [paused, setPaused] = useState(false);
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The parent's callback, read when an answer arrives: a new function from the parent never starts another read.
  const status = useRef(onStatus);
  useEffect(() => {
    status.current = onStatus;
  }, [onStatus]);

  const read = useCallback(
    async (fresh: boolean) => {
      setReading(true);
      const r = await api.coinbaseBalances(fresh);
      setReading(false);
      if (pause.current !== undefined) clearTimeout(pause.current);
      setPaused(true);
      pause.current = setTimeout(() => setPaused(false), REFRESH_PAUSE_MS);
      if (!r.ok) {
        // The portal no longer has the connection (reconciled elsewhere): the part goes back to Connect.
        if (r.status === 404 && r.error === "not_connected") return status.current("not_connected");
        setShown({ kind: "failed", message: r.status === 0 || r.status >= 500 ? BALANCES_UNREADABLE_TEXT : errorMessage(r) });
        return;
      }
      const d = r.data;
      if ("status" in d) {
        // No figures, old or new, once Coinbase refuses the grant (FR-017).
        if (d.status === "reconnect") return status.current("reconnect");
        setShown({ kind: "failed", message: BALANCES_UNREADABLE_TEXT });
        return;
      }
      setShown({ kind: "figures", balances: d });
    },
    [api],
  );
  useEffect(() => {
    void read(false);
    return () => {
      if (pause.current !== undefined) clearTimeout(pause.current);
    };
  }, [read]);

  return (
    <div className="platform-balances">
      {shown.kind === "reading" ? (
        <p role="status">{BALANCES_READING_TEXT}</p>
      ) : shown.kind === "failed" ? (
        <Banner kind="warning">{shown.message}</Banner>
      ) : (
        <>
          {shown.balances.stale ? <Banner kind="warning">{staleBalancesText(timeOf(shown.balances.readAt))}</Banner> : null}
          <Figures b={shown.balances} />
          <p className="muted">Read at {timeOf(shown.balances.readAt)}</p>
        </>
      )}
      <button type="button" className="secondary" onClick={() => void read(true)} disabled={reading || paused}>
        Refresh
      </button>
    </div>
  );
}
