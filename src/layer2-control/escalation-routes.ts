// L2 escalation reads for the operator (SPEC.md §8.2 L2-5, L2-4.3). Owner: feature 010.
// GET /v1/escalations and GET /v1/escalations/events?after=<seq>. Operator-only, loopback (via
// listenControl), built from the ledger only; L2 makes no outbound calls (FR-020). Each read runs the
// sweep first inside the serialized section, so expiries are current. The operator guard runs before
// the query is parsed.
import type { Express } from "express";
import { requireRole, type RequireRoleOptions } from "../shared/auth.js";
import { escalationEvents, pendingEscalations, sweep } from "./escalations.js";
import type { AuditLedger } from "./ledger.js";
import type { Serialize } from "./ledger-routes.js";

export interface EscalationRoutesDeps {
  ledger: AuditLedger;
  serialize: Serialize;
  now: () => number;
  /** Test hook: explicit operator token instead of resolving it from the environment. */
  tokens?: { operator?: string };
}

/** `after` defaults to -1; otherwise it must be an integer >= -1. */
export function parseAfter(raw: unknown): number | undefined {
  if (raw === undefined) return -1;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= -1 ? n : undefined;
}

export function mountEscalationRoutes(app: Express, deps: EscalationRoutesDeps): void {
  const opt: RequireRoleOptions = deps.tokens?.operator === undefined ? {} : { token: deps.tokens.operator };

  app.get("/v1/escalations", requireRole("operator", opt), async (_req, res) => {
    const body = await deps.serialize(() => {
      const t = deps.now();
      sweep(deps.ledger, t);
      const entries = deps.ledger.entries();
      return { pending: pendingEscalations(entries, t), cursor: entries.length - 1 };
    });
    res.json(body);
  });

  app.get("/v1/escalations/events", requireRole("operator", opt), async (req, res) => {
    const after = parseAfter(req.query.after);
    if (after === undefined) {
      res.status(400).json({ error: "after must be an integer >= -1" });
      return;
    }
    const body = await deps.serialize(() => {
      sweep(deps.ledger, deps.now());
      const entries = deps.ledger.entries();
      return { events: escalationEvents(entries, after), cursor: entries.length - 1 };
    });
    res.json(body);
  });
}
