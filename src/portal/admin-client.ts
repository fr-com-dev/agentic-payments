// 014 the portal's client of L2's administration routes (SPEC.md §8.2 L2-5, L2-8; specs/014 contracts/control-api.md
// "Administration routes"). The only file in src/portal/ that knows those paths, and the only user of the portal's
// second role token, `portal-admin` (PORTAL_ADMIN_TOKEN): rule A13 keeps both out of the rest of the portal, and
// keeps the user-account client out of this file. That token reaches the administration routes and nothing else:
// there is deliberately no method here for authorize, budget, reconcile, the operator's routes or a user account
// (INV-13, FR-027, FR-028). It carries identifiers, times and codes only: never text a person typed.
import type { DecisionOutcome, EscalationDetail, EscalationView, EventPage, LedgerCheck, RejectionReasonCode } from "../shared/contracts.js";
import { ControlError, ControlUnavailable } from "./control-errors.js";

const TIMEOUT_MS = 5_000;

/** What the administration routes of the portal need from L2. Each story adds its method. */
export interface AdminPort {
  /** The pending escalations, oldest first, with the time L2 read them. */
  pending(): Promise<{ pending: EscalationView[]; cursor: number; readAt: string }>;
  /** Approves a pending escalation for `decidedBy`, who confirmed their identity at `identityConfirmedAtMs`. L2 judges both. */
  approve(authorizationId: string, decidedBy: string, identityConfirmedAtMs: number): Promise<DecisionOutcome>;
  /** Rejects a pending escalation for `decidedBy`, with a reason from the fixed list. */
  reject(authorizationId: string, decidedBy: string, reasonCode: RejectionReasonCode): Promise<DecisionOutcome>;
  /** One escalation in any state, with how it ended and the budget behind it. */
  escalation(authorizationId: string): Promise<EscalationDetail>;
  /** One page of escalation events: after a cursor, before one, or the latest. */
  events(q: { after?: number; before?: number; limit?: number }): Promise<EventPage>;
  /** Whether the ledger's hash chain verifies. L2 re-reads the whole file for it. */
  verifyLedger(): Promise<LedgerCheck>;
}

export class AdminClient implements AdminPort {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly adminToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  protected async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${this.adminToken}`, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ControlUnavailable("the control service is unreachable");
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // No JSON body: decided by the status below.
    }
    if (res.status >= 200 && res.status < 300) return json as T;
    // 401: the portal's own token is wrong. 5xx: L2 failed. Neither is the administrator's doing.
    if (res.status === 401 || res.status >= 500) throw new ControlUnavailable(`the control service answered ${res.status}`);
    throw new ControlError(res.status, json);
  }

  private e(authorizationId: string, rest = ""): string {
    return `/v1/admin/escalations/${encodeURIComponent(authorizationId)}${rest}`;
  }

  pending = () => this.call<{ pending: EscalationView[]; cursor: number; readAt: string }>("GET", "/v1/admin/escalations");
  approve = (authorizationId: string, decidedBy: string, identityConfirmedAtMs: number) =>
    this.call<DecisionOutcome>("POST", this.e(authorizationId, "/approve"), { decidedBy, identityConfirmedAtMs });
  reject = (authorizationId: string, decidedBy: string, reasonCode: RejectionReasonCode) =>
    this.call<DecisionOutcome>("POST", this.e(authorizationId, "/reject"), { decidedBy, reasonCode });
  verifyLedger = () => this.call<LedgerCheck>("GET", "/v1/admin/ledger/verify");
  escalation = (authorizationId: string) => this.call<EscalationDetail>("GET", this.e(authorizationId));
  events = (q: { after?: number; before?: number; limit?: number }) => {
    const parts = (["after", "before", "limit"] as const).flatMap((k) => (q[k] === undefined ? [] : [`${k}=${String(q[k])}`]));
    return this.call<EventPage>("GET", `/v1/admin/escalations/events${parts.length > 0 ? `?${parts.join("&")}` : ""}`);
  };
}
