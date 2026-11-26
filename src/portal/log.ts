// 013 portal request log (SPEC.md §11 SEC-16; specs/013 contracts/portal-api.md). One JSON line per request, built
// from a whitelist: the time, the route template, the status, the user identifier and the duration. Never a token, a
// name, an email, a body, a query string or a card vault message (NFR-003, NFR-004).
export interface PortalLogLine {
  time: string;
  route: string;
  status: number;
  ms: number;
  userId?: string;
  /** A fixed label for an internal event (for example `card_vault_auth`). Never free text. */
  event?: string;
  /** 017: a fixed number that goes with an event (the failed-authentication limit's). Never an identifier. */
  count?: number;
}

export const LOG_KEYS: readonly string[] = ["time", "route", "status", "ms", "userId", "event", "count"];

export type PortalLog = (line: PortalLogLine) => void;

export function createPortalLog(sink: (line: string) => void = (l) => console.log(l)): PortalLog {
  return (line) => {
    const out: Record<string, unknown> = { time: line.time, route: line.route, status: line.status, ms: line.ms };
    if (line.userId !== undefined) out.userId = line.userId;
    if (line.event !== undefined) out.event = line.event;
    if (line.count !== undefined) out.count = line.count;
    sink(JSON.stringify(out));
  };
}

/**
 * 020 (specs/020 data-model.md "Portal log events"): the fixed labels a connection event may carry, each on a line of
 * its own (`route: "connections"`, `status: 0`), with the user and nothing else: never a connection identifier, a
 * token, a code, a state, an amount or anything Coinbase said (FR-029).
 */
export const CONNECTION_EVENTS = [
  "coinbase_connected",
  "coinbase_disconnected",
  "coinbase_replaced",
  "coinbase_reconnect_needed",
  "coinbase_scope_refused",
  "coinbase_state_refused",
  "coinbase_unavailable",
  "coinbase_revoke_failed",
  "coinbase_rate_limited",
  "coinbase_bad_amount",
  "coinbase_reconciled",
  "coinbase_scope_unverified",
  "coinbase_grant_write_failed",
  "coinbase_client_refused",
  "coinbase_store_unreadable",
] as const;

/** The `onEvent` of connections.ts, writing one whitelisted line per event. Unknown labels are dropped. */
export function connectionEventLog(log: PortalLog, now: () => number): (userId: string, event: string) => void {
  const known = new Set<string>(CONNECTION_EVENTS);
  return (userId, event) => {
    if (!known.has(event)) return;
    log({ time: new Date(now()).toISOString(), route: "connections", status: 0, ms: 0, userId, event });
  };
}
