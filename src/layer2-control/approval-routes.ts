// L2 approvals endpoint (SPEC.md §8.2 L2-5, L2-4.2): POST /v1/approvals/:authorizationId. Owner: feature 004.
// The L2 service bootstrap (feature 002) mounts this on its app. The operator guard runs before body
// parsing, so a wrong token never appends an entry (INV-13, SEC-8). Payee, amount, resource and session
// are copied from the ESCALATED entry, never from the request body (INV-12).
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { requireRole, type RequireRoleOptions } from "../shared/auth.js";
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
      const result = await deps.serialize(() => {
        const escalated = deps.ledger
          .entries()
          .find((e) => e.type === "ESCALATED" && e.authorizationId === escalationId);
        if (!escalated) return undefined;
        const t = deps.now();
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
        return { approvalId, expiresAtMs };
      });
      if (!result) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ ok: true, approvalId: result.approvalId, expiresAt: new Date(result.expiresAtMs).toISOString() });
    },
  );
}
