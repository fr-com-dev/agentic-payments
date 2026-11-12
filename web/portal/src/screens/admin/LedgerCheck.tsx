// 014 US5: whether the ledger still verifies (specs/014 contracts/portal-ui.md "Ledger check"; FR-025, FR-026).
// One button and its answer. The check runs only when asked, and the screen offers nothing else: no repair, no
// rewrite, no export.
import { useState } from "react";
import { Banner, ScreenHeading } from "../../components/ui.js";
import { useApp } from "../../context.js";
import { errorMessage } from "../../messages.js";
import type { AdminLedgerCheck } from "../../types.js";
import { clockTime } from "./format.js";

export const entriesText = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "entry" : "entries"}`;
export const verifiedText = (c: AdminLedgerCheck): string => `The ledger verifies. ${entriesText(c.entries)}. Checked at ${clockTime(c.checkedAt)}.`;
export const brokenText = (c: AdminLedgerCheck): string =>
  `The ledger does not verify from entry ${String(c.brokenAt ?? "?")}. The operator must act. Nothing can be repaired here. ${entriesText(c.entries)}. Checked at ${clockTime(c.checkedAt)}.`;

export function LedgerCheck() {
  const { api } = useApp();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminLedgerCheck | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const check = async () => {
    setBusy(true);
    const r = await api.adminLedgerCheck();
    setBusy(false);
    if (r.ok) {
      setResult(r.data);
      setFailure(null);
    } else {
      setFailure(errorMessage(r));
    }
  };

  return (
    <section>
      <ScreenHeading>Ledger check</ScreenHeading>
      <p>Every payment decision is recorded in a ledger whose entries are chained together. This checks that no entry was changed.</p>
      <p>
        <button type="button" disabled={busy} onClick={() => void check()}>
          Check the ledger
        </button>
      </p>
      {failure !== null ? <Banner kind="error">{failure}</Banner> : null}
      {result === null ? null : result.ok ? <Banner kind="info">{verifiedText(result)}</Banner> : <Banner kind="error">{brokenText(result)}</Banner>}
    </section>
  );
}
