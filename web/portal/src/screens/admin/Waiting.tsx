// 014 US1: the payments waiting for a person (specs/014 contracts/portal-ui.md "Waiting for approval"; FR-007 to
// FR-010). Every pending escalation of the deployment, oldest first, refreshed every 3 seconds while the tab is
// visible. A user is shown by identifier only. The countdown is text and runs in the browser, corrected by the
// portal's own clock, so a wrong local clock doesn't shift it.
import { useEffect, useRef, useState } from "react";
import { Link } from "../../components/Link.js";
import { Banner, ScreenHeading } from "../../components/ui.js";
import { useApp } from "../../context.js";
import { errorMessage } from "../../messages.js";
import { startPolling } from "../../poll.js";
import type { AdminEscalation } from "../../types.js";
import { clockTime, newPaymentsText, ownerName, ownerText, phoneText, sellerOf, timeLeftText, usdc } from "./format.js";

export const POLL_MS = 3000;
export const NOTHING_WAITING_TEXT = "No payment is waiting for approval.";
export const MINE_TEXT = "Your payment";

interface Loaded {
  pending: AdminEscalation[];
  readAt: string;
  /** The portal's clock minus this browser's, at the read: the countdown is computed on the portal's clock. */
  skewMs: number;
}

/** The current time on the portal's clock, ticking once a second. */
export function useNow(skewMs: number): number {
  const [now, setNow] = useState(() => Date.now() + skewMs);
  useEffect(() => {
    setNow(Date.now() + skewMs);
    const timer = setInterval(() => setNow(Date.now() + skewMs), 1000);
    return () => clearInterval(timer);
  }, [skewMs]);
  return now;
}

export function Waiting() {
  const { api } = useApp();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const known = useRef<Set<string> | null>(null);

  useEffect(
    () =>
      startPolling(async () => {
        const r = await api.adminEscalations();
        if (!r.ok) {
          // The last list stays; the next refresh is tried as usual.
          setFailure(errorMessage(r));
          return;
        }
        setFailure(null);
        setLoaded({ pending: r.data.pending, readAt: r.data.readAt, skewMs: Date.parse(r.data.readAt) - Date.now() });
        const ids = new Set(r.data.pending.map((e) => e.authorizationId));
        // Speak only when something new is waiting, and never on the first read.
        if (known.current !== null) {
          const fresh = [...ids].filter((id) => !known.current!.has(id)).length;
          setAnnouncement(fresh > 0 ? newPaymentsText(fresh) : "");
        }
        known.current = ids;
      }, POLL_MS),
    [api],
  );
  const now = useNow(loaded?.skewMs ?? 0);

  const phone = loaded?.pending.some((e) => e.approvalRequest !== undefined) ?? false;
  return (
    <section>
      <ScreenHeading>Waiting for approval</ScreenHeading>
      <p role="status" aria-live="polite" className="visually-hidden">
        {announcement}
      </p>
      {loaded === null ? (
        failure === null ? (
          <p role="status">Loading…</p>
        ) : (
          <Banner kind="error">{failure}</Banner>
        )
      ) : (
        <>
          <p className="muted">{failure === null ? `Read at ${clockTime(loaded.readAt)}.` : `Couldn't refresh. Last read at ${clockTime(loaded.readAt)}.`}</p>
          {loaded.pending.length === 0 ? (
            <p>{NOTHING_WAITING_TEXT}</p>
          ) : (
            <table className="stacked admin-table">
              <caption>Payments waiting for approval, oldest first</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">For</th>
                  <th scope="col">Seller</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Time left</th>
                  {phone ? <th scope="col">Phone</th> : null}
                  <th scope="col">
                    <span className="visually-hidden">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loaded.pending.map((e) => {
                  const seller = sellerOf(e.resourceKey);
                  return (
                    <tr key={e.authorizationId}>
                      <td data-label="Reference">
                        <code>{e.referenceCode}</code>
                      </td>
                      <td data-label="For">
                        <span aria-label={ownerName(e.owner)}>{ownerText(e.owner)}</span>
                        {e.mine ? <span className="status status-paused"> {MINE_TEXT}</span> : null}
                      </td>
                      <td data-label="Seller">
                        {seller.host}
                        {seller.path !== "" ? <div className="muted">{seller.path}</div> : null}
                      </td>
                      <td data-label="Amount">{usdc(e.amountAtomic)}</td>
                      <td data-label="Time left">{timeLeftText(Date.parse(e.expiresAt) - now)}</td>
                      {phone ? <td data-label="Phone">{phoneText(e.approvalRequest)}</td> : null}
                      <td data-label="Open">
                        <Link to={`/admin/escalations/${encodeURIComponent(e.authorizationId)}`}>
                          Review <span className="visually-hidden">payment {e.referenceCode}</span>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
