// L2 operator decision endpoints (SPEC.md §8.2 L2-5, L2-4.2, L2-4.3). Owner: features 004 and 010.
// POST /v1/approvals/:authorizationId (004) and POST /v1/rejections/:authorizationId (010).
// The L2 service bootstrap (feature 002) mounts these on its app. The operator guard runs before body
// parsing, so a wrong token never appends an entry (INV-13, SEC-8). Payee, amount, resource and session
// are copied from the ESCALATED entry, never from the request body (INV-12). Each decision acts only on a
// pending escalation (L2-4.3); the state check and the append are one synchronous block inside the
// serialized section, so an escalation gets exactly one final state.
// 014: that block is `recordApproval` and `recordRejection` below, the one decision core. The operator's routes
// here and the portal's administration routes (admin-routes.ts) both call it, so the two paths can't drift
// (specs/014 research R4). The operator's requests, answers and recorded fields are what they were.
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { requireRole, type RequireRoleOptions } from "../shared/auth.js";
import type { RejectionReasonCode } from "../shared/contracts.js";
import { decisionEntry, escalationState, expiresAtMsOf, findEscalation, OPERATOR_LABEL_MAX, REASON_MAX, sweep } from "./escalations.js";
import type { AuditLedger, LedgerEntry } from "./ledger.js";
import type { Serialize } from "./ledger-routes.js";

export interface ApprovalRoutesDeps {
  ledger: AuditLedger;
  serialize: Serialize;
  /** Clock, read once per approval. */
  now: () => number;
  /** Test hook: explicit operator token instead of resolving it from the environment. */
  tokens?: { operator?: string };
}

export const DEFAULT_APPROVAL_TTL_SECONDS = 600;
export const DEFAULT_APPROVER = "operator";

type ParsedBody = { ok: true; approver: string; ttlSeconds: number } | { ok: false; error: string };

/** Validates `{ approver?, ttlSeconds? }`. `ttlSeconds` must be a positive integer when present. */
export function parseApprovalBody(body: unknown): ParsedBody {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  let ttlSeconds = DEFAULT_APPROVAL_TTL_SECONDS;
  if (b.ttlSeconds !== undefined) {
    if (typeof b.ttlSeconds !== "number" || !Number.isInteger(b.ttlSeconds) || b.ttlSeconds <= 0) {
      return { ok: false, error: "ttlSeconds must be a positive integer" };
    }
    ttlSeconds = b.ttlSeconds;
  }
  let approver = DEFAULT_APPROVER;
  if (b.approver !== undefined) {
    if (typeof b.approver !== "string" || b.approver.length === 0) {
      return { ok: false, error: "approver must be a non-empty string" };
    }
    approver = b.approver;
  }
  return { ok: true, approver, ttlSeconds };
}

type ParsedRejection = { ok: true; operator: string; reason?: string } | { ok: false; error: string };

/** Validates `{ operator?, reason? }` (NFR-006): label 1–64 characters, reason at most 280. */
export function parseRejectionBody(body: unknown): ParsedRejection {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  let operator = DEFAULT_APPROVER;
  if (b.operator !== undefined) {
    if (typeof b.operator !== "string" || b.operator.length === 0 || b.operator.length > OPERATOR_LABEL_MAX) {
      return { ok: false, error: `operator must be a string of 1-${OPERATOR_LABEL_MAX} characters` };
    }
    operator = b.operator;
  }
  if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > REASON_MAX)) {
    return { ok: false, error: `reason must be a string of at most ${REASON_MAX} characters` };
  }
  return { ok: true, operator, ...(typeof b.reason === "string" && { reason: b.reason }) };
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// The decision core (014 research R4; specs/014 data-model.md "A decision from the portal, step by step")
// ---------------------------------------------------------------------------

export interface DecisionCtx {
  ledger: AuditLedger;
  /** Clock, read once per decision. */
  now: () => number;
}

/** Who decides, and on which path. Session, resource, payee and amount never come from here (INV-12). */
export type DecisionBy =
  | { channel: "operator"; label: string; ttlSeconds?: number; reason?: string }
  | { channel: "portal"; decidedBy: string; identityConfirmedAtMs?: number; reasonCode?: RejectionReasonCode };

export interface DecisionRefusal {
  status: number;
  body: Record<string, unknown>;
}

export interface DecisionOptions {
  /** Extra checks on a pending escalation, run after the state check and before the append. A refusal appends nothing. */
  guards?: (escalated: LedgerEntry, entries: readonly LedgerEntry[], nowMs: number) => DecisionRefusal | undefined;
  /**
   * Test hook (014 T-ADM-07 must-fail, never set by main()): skip the pending check, to show what it prevents: a
   * second final-state entry for one escalation.
   */
  skipPendingCheck?: boolean;
}

export type DecisionResult =
  | { kind: "not_found" }
  /** One entry was appended at `atMs`. */
  | { kind: "recorded"; entry: LedgerEntry; atMs: number }
  /** The same decision already exists, on any path: its entry, and nothing appended. */
  | { kind: "already"; entry: LedgerEntry }
  /** The escalation ended another way. `decision` is absent when it expired by the clock alone. */
  | { kind: "other_state"; state: "approved" | "denied" | "expired"; decision?: LedgerEntry; escalated: LedgerEntry }
  | { kind: "refused"; refusal: DecisionRefusal };

/** The portal channel's fixed approval validity: the operator's default, and not a request field. */
export const PORTAL_APPROVAL_TTL_MS = DEFAULT_APPROVAL_TTL_SECONDS * 1000;

function decide(
  ctx: DecisionCtx,
  escalationId: string,
  same: "approved" | "denied",
  opts: DecisionOptions,
  entryFor: (escalated: LedgerEntry, t: number) => Parameters<AuditLedger["append"]>[0],
): DecisionResult {
  const t = ctx.now();
  sweep(ctx.ledger, t); // record due expiries first, so a decision never acts on a stale "pending"
  const entries = ctx.ledger.entries();
  const state = escalationState(entries, escalationId, t);
  const escalated = findEscalation(entries, escalationId);
  if (state === "not_found" || !escalated) return { kind: "not_found" };
  if (!opts.skipPendingCheck && state !== "pending") {
    const decision = decisionEntry(entries, escalationId);
    // 010 FR-011: one decision per escalation. A repeat of the same one returns it.
    if (state === same && decision) return { kind: "already", entry: decision };
    return { kind: "other_state", state, ...(decision && { decision }), escalated };
  }
  const refusal = opts.guards?.(escalated, entries, t);
  if (refusal) return { kind: "refused", refusal };
  return { kind: "recorded", entry: ctx.ledger.append(entryFor(escalated, t), t), atMs: t };
}

/**
 * Approves a pending escalation: one HUMAN_APPROVAL. Must run inside the serialized section; it is one synchronous
 * block, so nothing can come between the state check and the append (INV-8).
 */
export function recordApproval(ctx: DecisionCtx, escalationId: string, by: DecisionBy, opts: DecisionOptions = {}): DecisionResult {
  return decide(ctx, escalationId, "approved", opts, (escalated, t) => ({
    type: "HUMAN_APPROVAL",
    ...(escalated.sessionId !== undefined && { sessionId: escalated.sessionId }),
    authorizationId: escalationId,
    data: {
      approvalId: `apr_${randomUUID()}`,
      escalationId,
      resourceKey: escalated.data.resourceKey,
      payTo: escalated.data.payTo,
      amount: escalated.data.amount,
      ...(by.channel === "operator"
        ? // 012 FR-024: which path decided. The backchannel path writes "backchannel".
          { approver: by.label, expiresAtMs: t + (by.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS) * 1000, channel: "operator" }
        : // 014: the administrator by identifier, and when they confirmed their identity. Never a name.
          {
            approver: by.decidedBy,
            expiresAtMs: t + PORTAL_APPROVAL_TTL_MS,
            channel: "portal",
            ...(by.identityConfirmedAtMs !== undefined && { identityConfirmedAtMs: by.identityConfirmedAtMs }),
          }),
    },
  }));
}

/** Rejects a pending escalation: one HUMAN_REJECTION. Same rules as `recordApproval`. */
export function recordRejection(ctx: DecisionCtx, escalationId: string, by: DecisionBy, opts: DecisionOptions = {}): DecisionResult {
  // pending: record the denial. Session, resource, payee and amount come from the escalation only.
  return decide(ctx, escalationId, "denied", opts, (escalated) => ({
    type: "HUMAN_REJECTION",
    ...(escalated.sessionId !== undefined && { sessionId: escalated.sessionId }),
    authorizationId: escalationId,
    data: {
      rejectionId: `rej_${randomUUID()}`,
      escalationId,
      resourceKey: escalated.data.resourceKey,
      payTo: escalated.data.payTo,
      amount: escalated.data.amount,
      ...(by.channel === "operator"
        ? { operator: by.label, ...(by.reason !== undefined && { reason: by.reason }), channel: "operator" }
        : // 014: a code from a fixed list, never text typed in the portal (FR-016).
          { approver: by.decidedBy, ...(by.reasonCode !== undefined && { reasonCode: by.reasonCode }), channel: "portal" }),
    },
  }));
}

export function mountApprovalRoutes(app: Express, deps: ApprovalRoutesDeps): void {
  const opt: RequireRoleOptions = deps.tokens?.operator === undefined ? {} : { token: deps.tokens.operator };
  const ctx: DecisionCtx = { ledger: deps.ledger, now: deps.now };
  const send = (res: express.Response, out: DecisionRefusal) => res.status(out.status).json(out.body);
  const notFound: DecisionRefusal = { status: 404, body: { error: "not found" } };
  const expired = (escalated: LedgerEntry): DecisionRefusal => ({
    status: 409,
    body: { error: "escalation is expired", state: "expired", expiresAt: iso(expiresAtMsOf(escalated)) },
  });

  app.post(
    "/v1/approvals/:authorizationId",
    requireRole("operator", opt),
    express.json(),
    async (req, res) => {
      const parsed = parseApprovalBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const escalationId = String(req.params.authorizationId);
      const out = await deps.serialize((): DecisionRefusal => {
        const r = recordApproval(ctx, escalationId, { channel: "operator", label: parsed.approver, ttlSeconds: parsed.ttlSeconds });
        if (r.kind === "not_found") return notFound;
        if (r.kind === "refused") return r.refusal;
        if (r.kind === "other_state") {
          if (r.state === "denied") return { status: 409, body: { error: "escalation is denied", state: r.state, rejectionId: r.decision?.data.rejectionId } };
          return expired(r.escalated);
        }
        const d = r.entry.data;
        // 010 FR-011: one approval per escalation. On a repeat the request's ttlSeconds and approver are ignored.
        return {
          status: 200,
          body: { ok: true, approvalId: d.approvalId, expiresAt: iso(d.expiresAtMs as number), ...(r.kind === "already" && { alreadyApproved: true }) },
        };
      });
      send(res, out);
    },
  );

  // 010: the operator rejects a pending escalation (L2-4.3). Repeating returns the first rejection.
  app.post(
    "/v1/rejections/:authorizationId",
    requireRole("operator", opt),
    express.json(),
    async (req, res) => {
      const parsed = parseRejectionBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const escalationId = String(req.params.authorizationId);
      const out = await deps.serialize((): DecisionRefusal => {
        const r = recordRejection(ctx, escalationId, { channel: "operator", label: parsed.operator, ...(parsed.reason !== undefined && { reason: parsed.reason }) });
        if (r.kind === "not_found") return notFound;
        if (r.kind === "refused") return r.refusal;
        if (r.kind === "other_state") {
          if (r.state === "approved") return { status: 409, body: { error: "escalation is approved", state: r.state, approvalId: r.decision?.data.approvalId } };
          return expired(r.escalated);
        }
        if (r.kind === "already") return { status: 200, body: { ok: true, rejectionId: r.entry.data.rejectionId, rejectedAt: r.entry.ts, alreadyRejected: true } };
        return { status: 200, body: { ok: true, rejectionId: r.entry.data.rejectionId, rejectedAt: iso(r.atMs), alreadyRejected: false } };
      });
      send(res, out);
    },
  );
}
