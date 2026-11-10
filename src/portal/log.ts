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
}

export const LOG_KEYS: readonly string[] = ["time", "route", "status", "ms", "userId", "event"];

export type PortalLog = (line: PortalLogLine) => void;

export function createPortalLog(sink: (line: string) => void = (l) => console.log(l)): PortalLog {
  return (line) => {
    const out: Record<string, unknown> = { time: line.time, route: line.route, status: line.status, ms: line.ms };
    if (line.userId !== undefined) out.userId = line.userId;
    if (line.event !== undefined) out.event = line.event;
    sink(JSON.stringify(out));
  };
}
