// L2 operator decision endpoints (SPEC.md §8.2 L2-5, L2-4.2, L2-4.3). Owner: features 004 and 010.
// POST /v1/approvals/:authorizationId (004) and POST /v1/rejections/:authorizationId (010).
// The L2 service bootstrap (feature 002) mounts these on its app. The operator guard runs before body
// parsing, so a wrong token never appends an entry (INV-13, SEC-8). Payee, amount, resource and session
// are copied from the ESCALATED entry, never from the request body (INV-12). Each decision acts only on a
// pending escalation (L2-4.3); the state check and the append are one synchronous block inside the
// serialized section, so an escalation gets exactly one final state.
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { requireRole, type RequireRoleOptions } from "../shared/auth.js";
import { decisionEntry, escalationState, expiresAtMsOf, findEscalation, OPERATOR_LABEL_MAX, REASON_MAX, sweep } from "./escalations.js";
import type { AuditLedger } from "./ledger.js";
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

export function mountApprovalRoutes(app: Express, deps: ApprovalRoutesDeps): void {
  const opt: RequireRoleOptions = deps.tokens?.operator === undefined ? {} : { token: deps.tokens.operator };

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
      const out = await deps.serialize((): { status: number; body: Record<string, unknown> } => {
        const t = deps.now();
        sweep(deps.ledger, t); // record due expiries first, so a decision never acts on a stale "pending"
        const entries = deps.ledger.entries();
        const state = escalationState(entries, escalationId, t);
        const escalated = findEscalation(entries, escalationId);
        if (state === "not_found" || !escalated) return { status: 404, body: { error: "not found" } };
        const decision = decisionEntry(entries, escalationId);
        if (state === "denied") {
          return { status: 409, body: { error: "escalation is denied", state, rejectionId: decision?.data.rejectionId } };
        }
        if (state === "expired") {
          return { status: 409, body: { error: "escalation is expired", state, expiresAt: iso(expiresAtMsOf(escalated)) } };
        }
        if (state === "approved") {
          // 010 FR-011: one approval per escalation. The request's ttlSeconds and approver are ignored.
          return {
            status: 200,
            body: { ok: true, approvalId: decision!.data.approvalId, expiresAt: iso(decision!.data.expiresAtMs as number), alreadyApproved: true },
          };
        }
        const approvalId = `apr_${randomUUID()}`;
        const expiresAtMs = t + parsed.ttlSeconds * 1000;
        deps.ledger.append(
          {
            type: "HUMAN_APPROVAL",
            ...(escalated.sessionId !== undefined && { sessionId: escalated.sessionId }),
            authorizationId: escalationId,
            data: {
              approvalId,
              escalationId,
              resourceKey: escalated.data.resourceKey,
              payTo: escalated.data.payTo,
              amount: escalated.data.amount,
              approver: parsed.approver,
              expiresAtMs,
            },
          },
          t,
        );
        return { status: 200, body: { ok: true, approvalId, expiresAt: iso(expiresAtMs) } };
      });
      res.status(out.status).json(out.body);
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
      const out = await deps.serialize((): { status: number; body: Record<string, unknown> } => {
        const t = deps.now();
        sweep(deps.ledger, t); // record due expiries first, so a decision never acts on a stale "pending"
        const entries = deps.ledger.entries();
        const state = escalationState(entries, escalationId, t);
        const escalated = findEscalation(entries, escalationId);
        if (state === "not_found" || !escalated) return { status: 404, body: { error: "not found" } };
        const decision = decisionEntry(entries, escalationId);
        if (state === "approved") {
          return { status: 409, body: { error: "escalation is approved", state, approvalId: decision?.data.approvalId } };
        }
        if (state === "expired") {
          return { status: 409, body: { error: "escalation is expired", state, expiresAt: iso(expiresAtMsOf(escalated)) } };
        }
        if (state === "denied") {
          return {
            status: 200,
            body: { ok: true, rejectionId: decision!.data.rejectionId, rejectedAt: decision!.ts, alreadyRejected: true },
          };
        }
        // pending: record the denial. Session, resource, payee and amount come from the escalation only.
        const rejectionId = `rej_${randomUUID()}`;
        deps.ledger.append(
          {
            type: "HUMAN_REJECTION",
            ...(escalated.sessionId !== undefined && { sessionId: escalated.sessionId }),
            authorizationId: escalationId,
            data: {
              rejectionId,
              escalationId,
              resourceKey: escalated.data.resourceKey,
              payTo: escalated.data.payTo,
              amount: escalated.data.amount,
              operator: parsed.operator,
              ...(parsed.reason !== undefined && { reason: parsed.reason }),
            },
          },
          t,
        );
        return { status: 200, body: { ok: true, rejectionId, rejectedAt: iso(t), alreadyRejected: false } };
      });
      res.status(out.status).json(out.body);
    },
  );
}
