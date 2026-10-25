// L1-6 hosted agent service: the Express app (SPEC.md §8.1 L1-6; specs/011 contracts/hosted-agent-api.md).
// Only `createHostedApp` lives here. The entry point that loads env, enforces INV-3 and listens is
// src/hosted-main.ts, outside this layer, because rule A5 bans the payer key's name in L1 code.
// Order per request: auth (401/403) → limits (429) → body (400/413) → session → run. Only POST /v1/runs and the two
// health routes exist; Mastra publishes no routes (research R1).
import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { JWTVerifyGetKey } from "jose";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { AuthorizationGatePort, SettlementVerifierPort } from "../../shared/contracts.js";
import { runGoal } from "./agent.js";
import type { HostedConfig } from "./config.js";
import { requesterAuth, type Requester } from "./requester-auth.js";
import { createRunLimiter } from "./run-limits.js";
import { createRunLog, stepOutcome } from "./run-log.js";
import { issueSessionRef, newSessionId, SESSION_REF_RE, verifySessionRef } from "./session-ref.js";

/** Under the Container Apps ingress's 240 s idle timeout: a run sends nothing until it ends (research R5). */
export const RUN_DEADLINE_MS = 200_000;
export const GOAL_MAX_CHARS = 4_000;
export const BODY_LIMIT = "16kb";
const BODY_KEYS = new Set(["goal", "sessionRef"]);

export interface HostedDeps {
  config: HostedConfig;
  keys: JWTVerifyGetKey;
  model: MastraModelConfig;
  gate: AuthorizationGatePort;
  settlement: SettlementVerifierPort;
  /** Test hook: a shorter run deadline. Never set by the entry point. */
  deadlineMs?: number;
  /** Test hook: skip requester auth (T-AGT-03 must-fail). Never set by the entry point. */
  bypassAuth?: boolean;
  /** Test hook: the limiter's clock. */
  now?: () => number;
  /** Test hook: accept any well-formed session reference (T-AGT-04 must-fail). Never set by the entry point. */
  skipSessionMac?: boolean;
  /** Where run-log lines go (default: stdout, one JSON line each). */
  log?: (line: string) => void;
}

export interface HostedApp {
  app: Express;
  markReady(): void;
}

const BYPASS_REQUESTER: Requester = { tenantId: "bypass", objectId: "bypass", kind: "user", key: "bypass:bypass" };

/** `goal` (1–4,000 characters after trimming) and optional `sessionRef`; nothing else. */
function parseBody(body: unknown): { goal: string; sessionRef?: string } | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!BODY_KEYS.has(k)) return { error: `unknown field: ${k}` };
  if (typeof b.goal !== "string") return { error: "goal must be a string" };
  const goal = b.goal.trim();
  if (goal.length === 0 || goal.length > GOAL_MAX_CHARS) return { error: `goal must be 1–${GOAL_MAX_CHARS} characters` };
  if (b.sessionRef !== undefined && typeof b.sessionRef !== "string") return { error: "sessionRef must be a string" };
  return b.sessionRef === undefined ? { goal } : { goal, sessionRef: b.sessionRef };
}

export function createHostedApp(deps: HostedDeps): HostedApp {
  const app = express();
  app.disable("x-powered-by");
  let ready = false;
  const limiter = createRunLimiter({ ...(deps.now && { now: deps.now }) });
  const runLog = createRunLog(deps.log);
  const requesterOf = (res: Response) => (res.locals.requester as Requester | undefined) ?? BYPASS_REQUESTER;

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    if (ready) res.json({ status: "ready" });
    else res.status(503).json({ status: "starting" });
  });

  if (!deps.bypassAuth) {
    app.use(
      requesterAuth({
        tenantId: deps.config.auth.tenantId,
        audience: deps.config.auth.audience,
        issuer: deps.config.auth.issuer,
        keys: deps.keys,
      }),
    );
  }

  const checkLimits = (_req: Request, res: Response, next: NextFunction) => {
    const retryAfter = limiter.check(requesterOf(res).key);
    if (retryAfter !== null) {
      res.set("Retry-After", String(retryAfter)).status(429).json({ error: "too many runs" });
      return;
    }
    next();
  };

  app.post("/v1/runs", checkLimits, express.json({ limit: BODY_LIMIT, type: () => true }), async (req: Request, res: Response) => {
    const requester = requesterOf(res);
    const parsed = parseBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    let sessionId: string;
    if (parsed.sessionRef === undefined) {
      sessionId = newSessionId();
    } else if (deps.skipSessionMac) {
      const m = SESSION_REF_RE.exec(parsed.sessionRef);
      if (m === null) {
        res.status(400).json({ error: "invalid sessionRef" });
        return;
      }
      sessionId = m[1]!;
    } else {
      const check = verifySessionRef(deps.config.sessionRefSecret, requester, parsed.sessionRef);
      if (!check.ok) {
        res.status(check.status).json({ error: check.status === 400 ? "invalid sessionRef" : "unknown session" });
        return;
      }
      sessionId = check.sessionId;
    }
    const release = limiter.start(requester.key);
    const runId = `run_${randomUUID()}`;
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("deadline"), deps.deadlineMs ?? RUN_DEADLINE_MS);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort("client_disconnected");
    });
    try {
      const outcome = await runGoal({
        goal: parsed.goal,
        sessionId,
        signal: controller.signal,
        model: deps.model,
        gate: deps.gate,
        settlement: deps.settlement,
        sellerUrl: deps.config.urls.seller,
        onStep: (step, ms) =>
          runLog.step({ runId, requester: requester.key, sessionId, index: step.index, tool: step.tool, ...stepOutcome(step.result), ms }),
      });
      runLog.run({
        runId,
        requester: requester.key,
        sessionId,
        status: outcome.status,
        stopReason: outcome.stopReason,
        steps: outcome.steps.length,
        ms: Date.now() - startedMs,
      });
      if (res.writableEnded || res.destroyed) return;
      res.json({
        runId,
        sessionRef: issueSessionRef(deps.config.sessionRefSecret, requester, sessionId),
        status: outcome.status,
        stopReason: outcome.stopReason,
        error: outcome.error,
        finalText: outcome.finalText,
        steps: outcome.steps,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(timer);
      release();
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Body parser errors: 413 over the limit, 400 for anything unparsable. Never echo the body.
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status === 413 || err.type === "entity.too.large" ? 413 : 400;
    res.status(status).json({ error: status === 413 ? "body too large" : "malformed JSON body" });
  });

  return {
    app,
    markReady: () => {
      ready = true;
    },
  };
}
