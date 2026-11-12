// 014 administration routes (SPEC.md §8.2 L2-5, L2-8; specs/014 contracts/control-api.md "Administration routes").
// What a person does with the control API, for the portal's administration area: see the pending escalations,
// approve or reject one, follow the events, see the budget behind one, and check the ledger. Every route takes the
// `portal-admin` role's token and nothing else (INV-13): this token opens no user-account route, and it can't
// authorize or reconcile; no other token opens these routes. The operator's routes are separate and unchanged.
// Reads derive state from the entries and the clock and append nothing: they never sweep (FR-033). The two decisions
// run the shared decision core of approval-routes.ts inside the serialized section, with two extra checks that only
// this path has: nobody decides their own payment, and an approval needs a fresh identity confirmation.
// No request carries text typed by a person: bodies hold an identifier, a time and a code from a fixed list.
import express, { type Express, type RequestHandler, type Response } from "express";
import { requireRole } from "../shared/auth.js";
import { ESCALATION_ID_RE, REJECTION_REASON_CODES, type BudgetLine, type DecisionOutcome, type EscalationBudget, type RejectionReasonCode } from "../shared/contracts.js";
import { USER_ID_RE } from "../shared/user-id.js";
import { recordApproval, recordRejection, type DecisionCtx, type DecisionOptions, type DecisionRefusal, type DecisionResult } from "./approval-routes.js";
import { channelOf, deciderOf, escalationDetail, escalationOwner, EVENT_PAGE_DEFAULT, EVENT_PAGE_MAX, eventPage, expiresAtMsOf, findEscalation, pendingEscalations } from "./escalations.js";
import type { AuditLedger, LedgerEntry } from "./ledger.js";
import type { Serialize } from "./ledger-routes.js";
import type { SpendingMandate } from "./mandate.js";
import { STEP_UP_MAX_AGE_MS, stepUpFresh, type UserGate } from "./users.js";

const BODY_LIMIT = "16kb";

/** Must-fail switches (Constitution VIII). Test-only deps, never set by main() and never read from the environment. */
export interface AdminDeps {
  /** T-ADM-06: without the own-payment check, an administrator approves their own run's payment. */
  skipOwnPaymentCheck?: boolean;
  /** T-ADM-05: without the identity confirmation, a sign-in from a day ago approves. */
  skipDecisionStepUp?: boolean;
  /** T-ADM-07: without the pending check, a second final-state entry is recorded for one escalation. */
  skipPendingCheck?: boolean;
  /** T-ADM-02: with one portal role for both halves, the user-account token approves. */
  singlePortalRole?: boolean;
}

export interface AdminRoutesDeps {
  ledger: AuditLedger;
  serialize: Serialize;
  now: () => number;
  admin: AdminDeps;
  /** The budget behind an escalation as of `nowMs`, from the same figures the decision uses (service.ts). Reads only. */
  budgetFor: (escalated: LedgerEntry, nowMs: number) => EscalationBudget;
  /** Test hook: explicit tokens instead of resolving them from the environment. */
  tokens?: { portalAdmin?: string; portal?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (b: Record<string, unknown>, allowed: readonly string[]) => Object.keys(b).every((k) => allowed.includes(k));
const iso = (ms: number) => new Date(ms).toISOString();

export interface BudgetInput {
  asset: { address: string; decimals: number };
  amountAtomic: string;
  /** The rules in force for the owner now: the user's effective mandate, or the platform account's. */
  mandate: Pick<SpendingMandate, "autoApproveMaxAtomic" | "hardCapPerPaymentAtomic" | "sessionBudgetAtomic" | "dailyBudgetAtomic">;
  /** Present for a user's payment. */
  user?: { gate?: UserGate; hasPolicy: boolean; dailyCeilingAtomic: string; dailyCommittedAtomic: bigint };
  sessionCommittedAtomic: bigint;
  dailyCommittedAtomic: bigint;
}

const ZERO_LINE: BudgetLine = { capAtomic: "0", spentAtomic: "0", remainingAtomic: "0" };
const budgetLine = (cap: string, spent: bigint): BudgetLine => {
  const left = BigInt(cap) - spent;
  return { capAtomic: cap, spentAtomic: spent.toString(), remainingAtomic: (left > 0n ? left : 0n).toString() };
};

/**
 * The budget view (specs/014 data-model.md "EscalationBudget"). Pure; `BigInt` only. When no rule set applies to the
 * purchase now (the user is not onboarded or is disabled, or no active policy of theirs lists the seller), every
 * line is zero and the payment can't fit. `fits: true` is no promise: the retry is decided again at payment time.
 */
export function toEscalationBudget(i: BudgetInput): EscalationBudget {
  const head = { asset: i.asset.address, decimals: i.asset.decimals };
  const notApplying = !i.user ? undefined : i.user.gate === "not_onboarded" ? "user_not_onboarded" : i.user.gate === "disabled" ? "user_disabled" : !i.user.hasPolicy ? "no_active_policy" : undefined;
  if (notApplying !== undefined) {
    return { ...head, applies: false, notApplying, autoApproveMaxAtomic: "0", hardCapPerPaymentAtomic: "0", run: ZERO_LINE, day: ZERO_LINE, userDay: ZERO_LINE, fits: false };
  }
  const run = budgetLine(i.mandate.sessionBudgetAtomic, i.sessionCommittedAtomic);
  const day = budgetLine(i.mandate.dailyBudgetAtomic, i.dailyCommittedAtomic);
  const userDay = i.user ? budgetLine(i.user.dailyCeilingAtomic, i.user.dailyCommittedAtomic) : undefined;
  const amount = BigInt(i.amountAtomic);
  const within = (l: BudgetLine) => amount <= BigInt(l.remainingAtomic);
  return {
    ...head,
    applies: true,
    autoApproveMaxAtomic: i.mandate.autoApproveMaxAtomic,
    hardCapPerPaymentAtomic: i.mandate.hardCapPerPaymentAtomic,
    run,
    day,
    ...(userDay && { userDay }),
    fits: amount <= BigInt(i.mandate.hardCapPerPaymentAtomic) && within(run) && within(day) && (userDay === undefined || within(userDay)),
  };
}

/** A decision entry as the portal's answer. `already` is true when it was there before this request. */
export function decisionOutcome(e: LedgerEntry, already: boolean): DecisionOutcome {
  const who = { already, channel: channelOf(e), decidedBy: deciderOf(e) };
  return e.type === "HUMAN_APPROVAL"
    ? { ok: true, state: "approved", approvalId: String(e.data.approvalId), expiresAt: iso(e.data.expiresAtMs as number), ...who }
    : { ok: true, state: "denied", rejectionId: String(e.data.rejectionId), rejectedAt: e.ts, ...who };
}

/** The decision core's result as this path's status and body (contracts/control-api.md "Administration routes"). */
function answer(r: DecisionResult): DecisionRefusal {
  switch (r.kind) {
    case "not_found":
      return { status: 404, body: { error: "not found" } };
    case "refused":
      return r.refusal;
    case "recorded":
      return { status: 200, body: { ...decisionOutcome(r.entry, false) } };
    case "already":
      return { status: 200, body: { ...decisionOutcome(r.entry, true) } };
    case "other_state": {
      // The escalation ended another way: say how, on which path and by whom. Nothing was appended.
      const d = r.decision;
      const person = d !== undefined && d.type !== "ESCALATION_EXPIRED";
      return {
        status: 409,
        body: {
          error: "not_pending",
          state: r.state,
          ...(person && { channel: channelOf(d), decidedBy: deciderOf(d) }),
          ...(d?.type === "HUMAN_APPROVAL" && { approvalId: d.data.approvalId }),
          ...(d?.type === "HUMAN_REJECTION" && { rejectionId: d.data.rejectionId }),
          ...(r.state === "expired" && { expiresAt: iso(expiresAtMsOf(r.escalated)) }),
        },
      };
    }
  }
}

export function mountAdminRoutes(app: Express, deps: AdminRoutesDeps): void {
  const guard: RequestHandler = deps.admin.singlePortalRole
    ? requireRole("portal-control", deps.tokens?.portal === undefined ? {} : { token: deps.tokens.portal })
    : requireRole("portal-admin", deps.tokens?.portalAdmin === undefined ? {} : { token: deps.tokens.portalAdmin });
  // The guard covers the whole prefix, so a path that matches no route still needs the token: 401 before 404.
  app.use("/v1/admin", guard);
  const { ledger, admin } = deps;
  const json = express.json({ limit: BODY_LIMIT });
  const ctx: DecisionCtx = { ledger, now: deps.now };
  const refuse = (res: Response, status: number, error: string) => res.status(status).json({ error });

  /**
   * The two checks only this path has, on a pending escalation, in this order (data-model.md "A decision from the
   * portal, step by step"). Both are L2's to make: the portal relays who decided and when they confirmed their
   * identity, and L2 judges (FR-014, FR-015).
   */
  const guardsFor =
    (decidedBy: string, approval?: { identityConfirmedAtMs: number }): NonNullable<DecisionOptions["guards"]> =>
    (escalated, entries, t) => {
      // Nobody decides their own payment. An escalation of the platform account has no owner.
      if (!admin.skipOwnPaymentCheck && escalationOwner(entries, escalated.authorizationId) === decidedBy) {
        return { status: 403, body: { error: "own_payment" } };
      }
      // An approval loosens: it needs credentials entered recently, exactly as a loosening policy change does.
      if (approval && !admin.skipDecisionStepUp && !stepUpFresh(approval.identityConfirmedAtMs, t)) {
        return { status: 403, body: { error: "step_up_required", maxAgeSec: STEP_UP_MAX_AGE_MS / 1000 } };
      }
      return undefined;
    };
  const options = (guards: NonNullable<DecisionOptions["guards"]>): DecisionOptions => ({ guards, ...(admin.skipPendingCheck && { skipPendingCheck: true }) });

  // The waiting list (FR-007). No sweep and no serialized section: the 300 s boundary comes from the clock, and L2's
  // own timer records the expiry entry within a second.
  app.get("/v1/admin/escalations", guard, (_req, res) => {
    const t = deps.now();
    const entries = ledger.entries();
    res.json({ pending: pendingEscalations(entries, t), cursor: entries.length - 1, readAt: iso(t) });
  });

  // The trail, in pages (FR-020, FR-021). Mounted before the routes that take an ID, so `events` is never read as one.
  app.get("/v1/admin/escalations/events", guard, (req, res) => {
    const q = req.query as Record<string, unknown>;
    if (!onlyKeys(q, ["after", "before", "limit"])) return void refuse(res, 400, "unknown query parameter");
    const int = (v: unknown, min: number, max: number): number | undefined => {
      if (typeof v !== "string" || !/^-?\d+$/.test(v)) return undefined;
      const n = Number(v);
      return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
    };
    const limit = q.limit === undefined ? EVENT_PAGE_DEFAULT : int(q.limit, 1, EVENT_PAGE_MAX);
    const after = q.after === undefined ? undefined : int(q.after, -1, Number.MAX_SAFE_INTEGER);
    const before = q.before === undefined ? undefined : int(q.before, -1, Number.MAX_SAFE_INTEGER);
    if (limit === undefined) return void refuse(res, 400, `limit must be an integer from 1 to ${String(EVENT_PAGE_MAX)}`);
    if ((q.after !== undefined && after === undefined) || (q.before !== undefined && before === undefined)) return void refuse(res, 400, "after and before must be integers >= -1");
    if (after !== undefined && before !== undefined) return void refuse(res, 400, "give after or before, not both");
    res.json(eventPage(ledger.entries(), { limit, ...(after !== undefined && { after }), ...(before !== undefined && { before }) }));
  });

  // One payment in any state, and the budget behind it (FR-022 to FR-024). The owner, the session and the resource
  // come from the ESCALATED entry: the caller names a payment, never a user or a session (FR-023). Appends nothing.
  app.get("/v1/admin/escalations/:authorizationId", guard, (req, res) => {
    const id = String(req.params.authorizationId);
    if (!ESCALATION_ID_RE.test(id)) return void refuse(res, 400, "malformed request");
    const t = deps.now();
    const entries = ledger.entries();
    const detail = escalationDetail(entries, id, t);
    const escalated = findEscalation(entries, id);
    if (!detail || !escalated) return void refuse(res, 404, "not found");
    res.json({ ...detail, budget: deps.budgetFor(escalated, t) });
  });

  // The ledger check (FR-025, FR-026): what the operator's route answers. It re-reads the file and verifies the
  // chain; it repairs nothing and appends nothing.
  app.get("/v1/admin/ledger/verify", guard, (_req, res) => {
    res.json(ledger.verifyChain());
  });

  // Approve (FR-011): one HUMAN_APPROVAL with the portal channel, valid for the fixed 600 s. It lifts only the
  // approval requirement, for that one payment, once; every rule is checked again at payment time (INV-12).
  app.post("/v1/admin/escalations/:authorizationId/approve", guard, json, async (req, res) => {
    const id = String(req.params.authorizationId);
    const b = req.body as unknown;
    if (!ESCALATION_ID_RE.test(id) || !isObject(b) || !onlyKeys(b, ["decidedBy", "identityConfirmedAtMs"])) return void refuse(res, 400, "malformed request");
    const { decidedBy, identityConfirmedAtMs } = b;
    if (typeof decidedBy !== "string" || !USER_ID_RE.test(decidedBy)) return void refuse(res, 400, "invalid decidedBy");
    if (typeof identityConfirmedAtMs !== "number" || !Number.isSafeInteger(identityConfirmedAtMs)) return void refuse(res, 400, "invalid identityConfirmedAtMs");
    const out = await deps.serialize(() =>
      answer(recordApproval(ctx, id, { channel: "portal", decidedBy, identityConfirmedAtMs }, options(guardsFor(decidedBy, { identityConfirmedAtMs })))),
    );
    res.status(out.status).json(out.body);
  });

  // Reject (FR-012, FR-016): one HUMAN_REJECTION with a reason from the fixed list. No text is accepted.
  app.post("/v1/admin/escalations/:authorizationId/reject", guard, json, async (req, res) => {
    const id = String(req.params.authorizationId);
    const b = req.body as unknown;
    if (!ESCALATION_ID_RE.test(id) || !isObject(b) || !onlyKeys(b, ["decidedBy", "reasonCode"])) return void refuse(res, 400, "malformed request");
    const { decidedBy, reasonCode } = b;
    if (typeof decidedBy !== "string" || !USER_ID_RE.test(decidedBy)) return void refuse(res, 400, "invalid decidedBy");
    if (!(REJECTION_REASON_CODES as readonly unknown[]).includes(reasonCode)) return void refuse(res, 400, "invalid reasonCode");
    const out = await deps.serialize(() =>
      answer(recordRejection(ctx, id, { channel: "portal", decidedBy, reasonCode: reasonCode as RejectionReasonCode }, options(guardsFor(decidedBy)))),
    );
    res.status(out.status).json(out.body);
  });
}
