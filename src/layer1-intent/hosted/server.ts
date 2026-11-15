// L1-6 hosted agent service: the Express app (SPEC.md §8.1 L1-6; specs/011 contracts/hosted-agent-api.md).
// Only `createHostedApp` lives here. The entry point that loads env, enforces INV-3 and listens is
// src/hosted-main.ts, outside this layer, because rule A5 bans the payer key's name in L1 code.
// 016: the caller's token is kept from auth to the end of the run and goes to one place, `gate.forCaller` (SEC-32).
// Order per request: auth (401/403) → limits (429) → body (400/413) → session → run. Only POST /v1/runs and the two
// health routes exist, plus the token-free docs routes with API_DOCS=1 (v1.6); Mastra publishes no routes
// (research R1). docs/l1-hosted.openapi.yaml describes them; test/openapi-hosted.test.ts keeps it in sync.
import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { MastraModelConfig } from "@mastra/core/llm";
import { addressLimit, trustProxies } from "../../shared/address-limit.js";
import type { CallerGates, SettlementVerifierPort } from "../../shared/contracts.js";
import type { TokenKeys } from "../../shared/identity-token.js";
import { runGoal } from "./agent.js";
import { mountHostedApiDocs } from "./api-docs.js";
import type { HostedConfig } from "./config.js";
import { callerTokenOf, requesterAuth, type Requester } from "./requester-auth.js";
import { createRunLimiter } from "./run-limits.js";
import { createRunLog, stepOutcome } from "./run-log.js";
import { issueSessionRef, newSessionId, SESSION_REF_RE, verifySessionRef } from "./session-ref.js";
import { openEventStream, wantsStream } from "./sse.js";

/**
 * Under the Container Apps ingress's 240 s idle timeout: a JSON answer sends nothing until the run ends (research
 * R5). A stream (016) sends events and keep-alives all along, and keeps the same deadline.
 */
export const RUN_DEADLINE_MS = 200_000;
export const GOAL_MAX_CHARS = 4_000;
export const BODY_LIMIT = "16kb";
const BODY_KEYS = new Set(["goal", "sessionRef"]);

export interface HostedDeps {
  config: HostedConfig;
  keys: TokenKeys;
  model: MastraModelConfig;
  /** 016: a gate per run, made for the caller whose token was verified. */
  gate: CallerGates;
  settlement: SettlementVerifierPort;
  /** Test hook: a shorter run deadline. Never set by the entry point. */
  deadlineMs?: number;
  /** Test hook: skip requester auth (T-AGT-03 must-fail). Never set by the entry point. */
  bypassAuth?: boolean;
  /** Test hook: the limiter's clock. */
  now?: () => number;
  /** Test hook: accept any well-formed session reference (T-AGT-04 must-fail). Never set by the entry point. */
  skipSessionMac?: boolean;
  /** Test hook: accept a person's token from any client, the portal's included (T-AGT-07 must-fail). Never set by the entry point. */
  skipClientCheck?: boolean;
  /** Test hook: accept a caller without the permission `agent:run` (T-AGT-09 must-fail). Never set by the entry point. */
  skipPermission?: boolean;
  /** Test hooks (T-AGT-03): another limit per address, or none at all (the must-fail). Never set by the entry point. */
  maxRequestsPerAddress?: number;
  skipAddressLimit?: boolean;
  /** Where run-log lines go (default: stdout, one JSON line each). */
  log?: (line: string) => void;
  /** Test hook (T-AGT-11): a shorter keep-alive period for the run stream. Never set by the entry point. */
  keepAliveMs?: number;
}

export interface HostedApp {
  app: Express;
  markReady(): void;
}

const BYPASS_REQUESTER: Requester = { kind: "user", authority: "bypass", subject: "bypass", key: "bypass:bypass" };

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
  trustProxies(app, deps.config.trustedProxyHops);
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
  // API_DOCS=1 only (SEC-13): Swagger UI and the document, token-free like the health routes, so before auth.
  if (deps.config.apiDocs) mountHostedApiDocs(app);

  // Per address, before any token is verified: a caller without a valid token is bounded too (SEC-14).
  if (!deps.skipAddressLimit) app.use(addressLimit({ ...(deps.maxRequestsPerAddress !== undefined && { max: deps.maxRequestsPerAddress }) }));

  if (!deps.bypassAuth) {
    app.use(
      requesterAuth({
        issuer: deps.config.auth.issuer,
        audience: deps.config.auth.audience,
        clientIds: deps.config.auth.clientIds,
        keys: deps.keys,
        ...(deps.skipClientCheck && { skipClientCheck: true }),
        ...(deps.skipPermission && { skipPermission: true }),
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
    // 016 (SEC-32): who every payment of this run is for is decided by L2, from the caller's token. The gate made
    // here carries that token on each call and is the only thing that holds it; neither the goal text, the model
    // nor a tool input can change it or see it. With auth bypassed (tests only) the gate carries none.
    const gate = deps.gate.forCaller(callerTokenOf(res) ?? "");
    // 016: every refusal is behind us, so the answer's form is chosen here. A stream starts with the run's
    // identifier, at once; the JSON form says nothing until the run ends.
    const stream = wantsStream(req) ? openEventStream(res, { ...(deps.keepAliveMs !== undefined && { keepAliveMs: deps.keepAliveMs }) }) : undefined;
    stream?.send("run", { runId, startedAt });
    try {
      const outcome = await runGoal({
        goal: parsed.goal,
        sessionId,
        signal: controller.signal,
        model: deps.model,
        gate,
        settlement: deps.settlement,
        sellerUrl: deps.config.urls.seller,
        onStep: (step, ms) => {
          runLog.step({ runId, requester: requester.key, sessionId, index: step.index, tool: step.tool, ...stepOutcome(step.result), ms });
          stream?.send("step", step);
        },
        ...(stream && { onText: (delta: string) => stream.send("text", { delta }) }),
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
      const answer = {
        runId,
        sessionRef: issueSessionRef(deps.config.sessionRefSecret, requester, sessionId),
        status: outcome.status,
        stopReason: outcome.stopReason,
        error: outcome.error,
        finalText: outcome.finalText,
        steps: outcome.steps,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      // The same object in both forms: the stream's last event, or the JSON body.
      if (stream) stream.send("result", answer);
      else res.json(answer);
    } finally {
      clearTimeout(timer);
      release();
      stream?.end();
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
