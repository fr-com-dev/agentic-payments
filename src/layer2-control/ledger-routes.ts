// L2 ledger endpoints (SPEC.md §8.2 L2-5): POST /v1/reconcile and GET /v1/ledger/verify. Owner: feature 003.
// The L2 service bootstrap (feature 002) mounts these on its app. Each route's guard runs before
// body parsing, so a wrong token never appends an entry (INV-13).
import express, { type Express } from "express";
import { requireRole, type RequireRoleOptions } from "../shared/auth.js";
import type { SettlementReport } from "../shared/contracts.js";
import type { AuditLedger } from "./ledger.js";

/** Runs `fn` inside the L2 serialized section (single writer, shared with authorize). */
export type Serialize = <T>(fn: () => T | Promise<T>) => Promise<T>;

export interface LedgerRoutesDeps {
  ledger: AuditLedger;
  serialize: Serialize;
  /** Test hook: explicit tokens instead of resolving them from the environment. */
  tokens?: { settlement?: string; operator?: string };
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** 400 when `authorizationId` or any of `verified.{asset, payer, payTo, amount}` is missing. */
export function isWellFormedReport(body: unknown): body is SettlementReport {
  if (body === null || typeof body !== "object") return false;
  const r = body as Record<string, unknown>;
  if (!isNonEmptyString(r.authorizationId)) return false;
  const v = r.verified as Record<string, unknown> | undefined;
  if (v === null || typeof v !== "object") return false;
  return isNonEmptyString(v.asset) && isNonEmptyString(v.payer) && isNonEmptyString(v.payTo) && isNonEmptyString(v.amount);
}

export function mountLedgerRoutes(app: Express, deps: LedgerRoutesDeps): void {
  const opt = (token?: string): RequireRoleOptions => (token === undefined ? {} : { token });

  app.post(
    "/v1/reconcile",
    requireRole("verifier-control", opt(deps.tokens?.settlement)),
    express.json(),
    async (req, res) => {
      if (!isWellFormedReport(req.body)) {
        res.status(400).json({ error: "malformed settlement report" });
        return;
      }
      const report = req.body;
      const result = await deps.serialize(() => deps.ledger.reconcile(report));
      if (!result.found) {
        res.status(404).json({ error: "unknown authorizationId" });
        return;
      }
      res.json({ ok: true, anomaly: result.anomaly });
    },
  );

  app.get("/v1/ledger/verify", requireRole("operator", opt(deps.tokens?.operator)), (_req, res) => {
    res.json(deps.ledger.verifyChain());
  });
}
