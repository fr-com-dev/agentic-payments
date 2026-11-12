// 014 US3: what happened to each escalation (specs/014 contracts/portal-ui.md "Activity"; FR-020, FR-021). The
// trail, newest at the top, 50 events at a time. While the screen is open it asks for what came after the last
// read, so every event appears exactly once and in order; "Show earlier" reads back from the oldest shown. Events
// that arrive while the screen is open are marked "New". Nothing is kept in the browser between visits: the web app
// stores nothing of its own (T-WEB-07). Whatever an operator typed on a command line is shown as text.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "../../components/Link.js";
import { Banner, ScreenHeading } from "../../components/ui.js";
import { useApp } from "../../context.js";
import { errorMessage } from "../../messages.js";
import { startPolling } from "../../poll.js";
import type { AdminEvent } from "../../types.js";
import { eventText, ownerName, ownerText, usdc } from "./format.js";

export const TRAIL_POLL_MS = 5000;
export const PAGE_SIZE = 50;
export const NO_ACTIVITY_TEXT = "Nothing has happened yet.";

const eventOwner = (e: AdminEvent) => (e.userId !== undefined ? { userId: e.userId, platformAccount: false } : { platformAccount: true });

export function Activity() {
  const { api } = useApp();
  /** Oldest first, as read; shown newest first. */
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** The ledger's position when the screen opened: what arrives after it is "New" for as long as the screen stays open. */
  const openedAt = useRef<number | null>(null);
  /** Where the next read continues: the ledger's position at the last read, or the last event of a full page. */
  const cursor = useRef<number | null>(null);

  useEffect(
    () =>
      startPolling(async () => {
        if (cursor.current === null) {
          const first = await api.adminEvents({ limit: PAGE_SIZE });
          if (!first.ok) return void setFailure(errorMessage(first));
          cursor.current = first.data.cursor;
          openedAt.current = first.data.cursor;
          setEarlier(first.data.more);
          setEvents(first.data.events);
          setFailure(null);
          return;
        }
        // Everything after the last read, a page at a time until there is no more.
        for (let pages = 0; pages < 20; pages++) {
          const next = await api.adminEvents({ after: cursor.current, limit: PAGE_SIZE });
          if (!next.ok) return void setFailure(errorMessage(next));
          setFailure(null);
          if (next.data.events.length > 0) setEvents((known) => [...(known ?? []), ...next.data.events]);
          cursor.current = next.data.more ? next.data.last : next.data.cursor;
          if (!next.data.more) return;
        }
      }, TRAIL_POLL_MS),
    [api],
  );

  const showEarlier = useCallback(async () => {
    if (events === null || events.length === 0) return;
    setLoadingEarlier(true);
    const r = await api.adminEvents({ before: events[0]!.seq, limit: PAGE_SIZE });
    setLoadingEarlier(false);
    if (!r.ok) return void setFailure(errorMessage(r));
    setFailure(null);
    setEarlier(r.data.more);
    setEvents((known) => [...r.data.events, ...(known ?? [])]);
  }, [api, events]);

  const isNew = (e: AdminEvent) => openedAt.current !== null && e.seq > openedAt.current;
  return (
    <section>
      <ScreenHeading>Activity</ScreenHeading>
      {failure !== null ? <Banner kind="error">{failure}</Banner> : null}
      {events === null ? (
        failure === null ? (
          <p role="status">Loading…</p>
        ) : null
      ) : events.length === 0 ? (
        <p>{NO_ACTIVITY_TEXT}</p>
      ) : (
        <table className="stacked admin-table">
          <caption>What happened to each payment that needed approval, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Reference</th>
              <th scope="col">For</th>
              <th scope="col">Amount</th>
              <th scope="col">What happened</th>
            </tr>
          </thead>
          <tbody>
            {[...events].reverse().map((e) => (
              <tr key={e.seq}>
                <td data-label="When">
                  <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                  {isNew(e) ? <span className="status status-active"> New</span> : null}
                </td>
                <td data-label="Reference">
                  <Link to={`/admin/escalations/${encodeURIComponent(e.authorizationId)}`}>
                    <span className="visually-hidden">Payment</span> <code>{e.referenceCode ?? ""}</code>
                  </Link>
                </td>
                <td data-label="For">
                  <span aria-label={ownerName(eventOwner(e))}>{ownerText(eventOwner(e))}</span>
                  {e.mine ? <span className="status status-paused"> Your payment</span> : null}
                </td>
                <td data-label="Amount">{usdc(e.amount)}</td>
                <td data-label="What happened">{eventText(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {earlier ? (
        <p>
          <button type="button" className="secondary" disabled={loadingEarlier} onClick={() => void showEarlier()}>
            Show earlier
          </button>
        </p>
      ) : null}
    </section>
  );
}
