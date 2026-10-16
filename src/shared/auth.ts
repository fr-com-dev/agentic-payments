// Per-caller bearer guard (SPEC.md INV-13, CFG-2). Owner: feature 007.
// Each endpoint's owning feature mounts `requireRole(<role>)` on its own route, before body validation,
// so a 401 never appends a ledger entry, triggers a reconcile or consumes an approval.
import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { tokenFor, type Role } from "./config.js";

/** Role → endpoint table (contracts/auth-roles.md). Each endpoint accepts exactly one role. */
export const ENDPOINT_ROLES = {
  "POST /v1/authorize": "agent-control",
  "GET /v1/budget/:sessionId": "agent-control",
  "POST /v1/settlements": "agent-verifier",
  "POST /v1/reconcile": "verifier-control",
  "POST /v1/approvals/:authorizationId": "operator",
  "GET /v1/ledger/verify": "operator",
} as const satisfies Record<string, Role>;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison over SHA-256 digests, so neither length nor content leaks through timing. */
export function tokensMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export interface RequireRoleOptions {
  /** Expected token; defaults to the role's token resolved from the environment at mount time. */
  token?: string;
}

/** Express middleware: lets the request through only with `Authorization: Bearer <role's token>`. */
export function requireRole(role: Role, opts: RequireRoleOptions = {}): RequestHandler {
  const expected = opts.token ?? tokenFor(role);
  return (req, res, next) => {
    const header = req.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
    if (presented === null || presented.length === 0 || !tokensMatch(presented, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
