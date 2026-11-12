// 014 the portal's administration API (SPEC.md §8.2 L2-8; specs/014 contracts/portal-api.md "Administration
// routes"). Every route here is behind `requireAdmin` (server.ts): only a signed-in person whose token carries the
// administrator role gets this far. The decider is `res.locals.person`, set by the access check from the verified
// token; no route reads a person from a path, a query or a body, and none takes a user identifier at all: a user is
// reached only through an escalation's ID (FR-023). A decision is one call to L2 and no write here, so nothing is
// ever half made. This file never imports the user-account client (rule A13).
import express, { type Express, type Request, type Response } from "express";
import {
  ESCALATION_ID_RE,
  REJECTION_REASON_CODES,
  type EscalationBudget,
  type EscalationDecision,
  type EscalationDetail,
  type EscalationEvent,
  type EscalationView,
  type LedgerCheck,
  type RejectionReasonCode,
} from "../shared/contracts.js";
import type { Person } from "./access.js";
import type { AdminPort } from "./admin-client.js";
import { ControlError, ControlUnavailable } from "./control-errors.js";

export interface AdminRoutesDeps {
  admin: AdminPort;
  now: () => number;
}

/** Marks the request with a fixed label for the log line (never free text, never what L2 said). */
export const note = (res: Response, label: string) => {
  res.locals.event = label;
};
export const person = (res: Response) => res.locals.person as Person;

/** The fields of an L2 refusal the browser may see, by error code. Anything else is dropped. */
const RELAYED: Record<string, readonly string[]> = {
  step_up_required: ["maxAgeSec"],
  not_pending: ["state", "channel", "decidedBy", "approvalId", "rejectionId", "expiresAt"],
};
const LABELS: Record<string, string> = {
  step_up_required: "admin_step_up_required",
  own_payment: "admin_own_payment",
  not_pending: "admin_not_pending",
};

/** Turns every failure into the status and body the contract lists. Nothing internal is ever echoed. */
export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ControlUnavailable) {
        res.status(502).json({ error: "control_unavailable" });
      } else if (err instanceof ControlError) {
        const code = err.code;
        const label = LABELS[code];
        if (label !== undefined) note(res, label);
        const extra: Record<string, unknown> = {};
        for (const key of RELAYED[code] ?? []) if (err.body[key] !== undefined) extra[key] = err.body[key];
        // A 400 from L2 means this file let something through that it should have refused: never the person's wording.
        res.status(err.status).json({ error: err.status === 404 ? "not found" : err.status === 400 ? "malformed request" : code, ...extra });
      } else {
        note(res, "internal_error");
        res.status(500).json({ error: "internal error" });
      }
    }
  };

/** One payment waiting for a person, as the browser gets it. */
export interface AdminEscalation {
  authorizationId: string;
  referenceCode: string;
  /** Whose payment it is: a user by identifier only, never by name (FR-009), or the platform account. */
  owner: { userId?: string; platformAccount: boolean };
  /** The signed-in administrator's own payment: they see it and can't decide it (FR-015; L2 enforces it). */
  mine: boolean;
  resourceKey: string;
  payTo: string;
  amountAtomic: string;
  createdAt: string;
  expiresAt: string;
  approvalRequest?: string;
}

/**
 * L2's view → the browser's. Built field by field: the agent's session reference is not passed on (nothing in the
 * administration area needs it), and nothing L2 might add later leaks through.
 */
export function toAdminEscalation(v: EscalationView, p: Pick<Person, "userId">): AdminEscalation {
  return {
    authorizationId: v.authorizationId,
    referenceCode: v.referenceCode,
    owner: v.userId !== undefined ? { userId: v.userId, platformAccount: false } : { platformAccount: true },
    mine: v.userId !== undefined && v.userId === p.userId,
    resourceKey: v.resourceKey,
    payTo: v.payTo,
    amountAtomic: v.amount,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    ...(v.approvalRequest !== undefined && { approvalRequest: v.approvalRequest }),
  };
}

/**
 * A payment in any state, with how it ended and the budget it counts against. `readAt` is the portal's clock at the
 * read: the browser counts the time left from it, so a wrong local clock doesn't shift the countdown.
 */
export interface AdminEscalationDetail extends AdminEscalation {
  state: EscalationDetail["state"];
  decision?: EscalationDecision;
  budget: EscalationBudget;
  readAt: string;
}

export function toAdminEscalationDetail(d: EscalationDetail, p: Pick<Person, "userId">, readAtMs: number): AdminEscalationDetail {
  return { ...toAdminEscalation(d, p), state: d.state, ...(d.decision !== undefined && { decision: d.decision }), budget: d.budget, readAt: new Date(readAtMs).toISOString() };
}

/** One step in an escalation's life, as the browser gets it: no session reference, and whether the payment is the reader's own. */
export type AdminEvent = Omit<EscalationEvent, "sessionId"> & { mine: boolean };

export function toAdminEvent(e: EscalationEvent, p: Pick<Person, "userId">): AdminEvent {
  const { sessionId: _session, ...rest } = e;
  return { ...rest, mine: e.userId !== undefined && e.userId === p.userId };
}

const QUERY_INT = /^-?\d+$/;
/** An integer query value within bounds, `null` when absent, `undefined` when it is anything else. */
function queryInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === undefined) return null;
  if (typeof v !== "string" || !QUERY_INT.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

/** How long one ledger check answers for, whoever asks: the check reads the whole ledger on L2's single thread. */
export const LEDGER_CHECK_CACHE_MS = 10_000;

const BODY_LIMIT = "16kb";
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const malformed = (res: Response) => res.status(400).json({ error: "malformed request" });

/** Mounts every /api/admin route on the app itself, so the mounted routes can be compared with the OpenAPI document. */
export function mountPortalAdminRoutes(r: Express, d: AdminRoutesDeps): void {
  const json = express.json({ limit: BODY_LIMIT });
  /** The escalation named by the path, or undefined after answering 400. Nothing else in a path is ever read. */
  const escalationId = (req: Request, res: Response): string | undefined => {
    const id = String(req.params.authorizationId);
    if (ESCALATION_ID_RE.test(id)) return id;
    malformed(res);
    return undefined;
  };

  // The ledger check (FR-025, FR-026), read-only. One answer serves every administrator for 10 seconds, so no
  // number of people or reloads can make L2 re-read its ledger more than six times a minute (NFR-004). A failure
  // is never kept: the next request asks again.
  let lastCheck: { atMs: number; result: LedgerCheck } | undefined;
  r.get(
    "/api/admin/ledger/verify",
    handle(async (_req, res) => {
      const t = d.now();
      if (lastCheck === undefined || t - lastCheck.atMs > LEDGER_CHECK_CACHE_MS || t < lastCheck.atMs) {
        const { entries, ok, brokenAt } = await d.admin.verifyLedger();
        lastCheck = { atMs: t, result: { entries, ok, ...(brokenAt !== undefined && { brokenAt }) } };
      }
      res.json({ ...lastCheck.result, checkedAt: new Date(lastCheck.atMs).toISOString() });
    }),
  );

  // The waiting list (FR-007, FR-008): every pending escalation, oldest first, and when L2 read it.
  r.get(
    "/api/admin/escalations",
    handle(async (_req, res) => {
      const { pending, readAt } = await d.admin.pending();
      res.json({ pending: pending.map((v) => toAdminEscalation(v, person(res))), readAt });
    }),
  );

  // The trail, in pages (FR-020, FR-021). Three query values and no other; mounted before the routes that take an ID.
  r.get(
    "/api/admin/escalations/events",
    handle(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const after = queryInt(q.after, -1, Number.MAX_SAFE_INTEGER);
      const before = queryInt(q.before, -1, Number.MAX_SAFE_INTEGER);
      const limit = queryInt(q.limit, 1, 200);
      const known = Object.keys(q).every((k) => k === "after" || k === "before" || k === "limit");
      if (!known || after === undefined || before === undefined || limit === undefined || (after !== null && before !== null)) return void malformed(res);
      const page = await d.admin.events({ ...(after !== null && { after }), ...(before !== null && { before }), ...(limit !== null && { limit }) });
      res.json({ events: page.events.map((e) => toAdminEvent(e, person(res))), first: page.first, last: page.last, cursor: page.cursor, more: page.more });
    }),
  );

  // One payment in any state, with the budget behind it (FR-022 to FR-024). A payment's ID is the only thing asked:
  // the user and the run it belongs to are L2's to look up (FR-023).
  r.get(
    "/api/admin/escalations/:authorizationId",
    handle(async (req, res) => {
      const id = escalationId(req, res);
      if (id === undefined) return;
      res.json(toAdminEscalationDetail(await d.admin.escalation(id), person(res), d.now()));
    }),
  );

  // Approve (FR-011, FR-014). The request says only which payment. Who decides and when they last entered their
  // credentials come from the verified token (FR-030); a body that tries to say either is refused before L2 is
  // called. L2 then checks that the payment is pending, that it is not the decider's own, and that the identity
  // confirmation is recent enough.
  r.post(
    "/api/admin/escalations/:authorizationId/approve",
    json,
    handle(async (req, res) => {
      const id = escalationId(req, res);
      if (id === undefined) return;
      const body = (req.body ?? {}) as unknown;
      if (!isObject(body) || Object.keys(body).length > 0) return void malformed(res);
      const { userId, identityConfirmedAtMs } = person(res);
      const outcome = await d.admin.approve(id, userId, identityConfirmedAtMs);
      note(res, outcome.already ? "admin_already_decided" : "admin_approved");
      res.json(outcome);
    }),
  );

  // Reject (FR-012, FR-016): a reason from the fixed list and nothing else. There is no text to pass on.
  r.post(
    "/api/admin/escalations/:authorizationId/reject",
    json,
    handle(async (req, res) => {
      const id = escalationId(req, res);
      if (id === undefined) return;
      const body = req.body as unknown;
      if (!isObject(body) || Object.keys(body).some((k) => k !== "reasonCode") || !(REJECTION_REASON_CODES as readonly unknown[]).includes(body.reasonCode)) {
        return void malformed(res);
      }
      const outcome = await d.admin.reject(id, person(res).userId, body.reasonCode as RejectionReasonCode);
      note(res, outcome.already ? "admin_already_decided" : "admin_rejected");
      res.json(outcome);
    }),
  );
}
