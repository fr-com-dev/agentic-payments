// L1-6 hosted agent service: the Express app (SPEC.md §8.1 L1-6; specs/011 contracts/hosted-agent-api.md).
// Only `createHostedApp` lives here. The entry point that loads env, enforces INV-3 and listens is
// src/hosted-main.ts, outside this layer, because rule A5 bans the payer key's name in L1 code.
// 016: the caller's token is kept from auth to the end of the run and goes to one place, `gate.forCaller` (SEC-32).
// Order per request: [dev issuer] machine only (421) → health, docs → per address (429) → failed authentications per
// address (429) → [019: GET /.well-known/agent-auth, token-free] → auth (401/403) → run limits (429) → body
// (400/413) → session (400/404) → [019: the account question, a person's run only (409/401/503)] → run. Only
// POST /v1/runs and the two health routes exist, plus the token-free docs routes with API_DOCS=1 (v1.6) and the sign-in
// settings with AGENT_DESKTOP_CLIENT_ID (019); Mastra publishes no routes (research R1). docs/l1-hosted.openapi.yaml
// describes them; test/openapi-hosted.test.ts keeps it in sync.
import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { MastraModelConfig } from "@mastra/core/llm";
import { addressLimit, failedAuthLimit, MAX_FAILED_AUTH_PER_ADDRESS, onceInWindow, proxyWarning, trustProxies } from "../../shared/address-limit.js";
import { localOnly } from "../../shared/local-only.js";
import { networkProfile } from "../../shared/config.js";
import type { CallerGates, SettlementVerifierPort } from "../../shared/contracts.js";
import { bearerChallenge, type TokenKeys } from "../../shared/identity-token.js";
import { checkAccount } from "./account-check.js";
import { runGoal, type SearchNetwork } from "./agent.js";
import { docsSignIn, mountHostedApiDocs } from "./api-docs.js";
import type { AgentMode, HostedConfig } from "./config.js";
import { AGENT_REALM, callerTokenOf, REQUIRED_PERMISSION, requesterAuth, type Requester } from "./requester-auth.js";
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
  /** 017 test hook (T-EDGE-03 must-fail): the dev sign-in serves any host name and any proxy. Never set by the entry point. */
  skipLocalOnly?: boolean;
  /** 017 test hook (T-EDGE-04 must-fail): failed authentications are never limited. Never set by the entry point. */
  skipFailureLimit?: boolean;
  /** 019 test hook (T-AGT-17 must-fail): a person's run starts without the account question. Never set by the entry point. */
  skipAccountCheck?: boolean;
  /**
   * 019 test hook (T-AGT-19 must-fail): the key the run limits count by. Default `requester.key`
   * (`<issuer host>:<sub>`): one person, whatever client and token. Never set by the entry point.
   */
  limitKey?: (requester: Requester) => string;
  /** 019 test hook (T-AGT-16 must-fail): a 401 describes the refused token. Never set by the entry point. */
  revealCheck?: boolean;
  /**
   * 021 test hook: the network a search filters by (CAIP-2, asset, decimals). Default: the profile of
   * `config.network`. Never set by the entry point.
   */
  network?: SearchNetwork;
  /** 021 test hook: the HTTP client the discovery index is called with. Never set by the entry point. */
  discoveryFetch?: typeof fetch;
  /** 021 test hook (T-AGT-21 must-fail): a request header `Agent-Test-Mode` picks the run's mode. Never set by the entry point. */
  modeFromHeader?: boolean;
  /** 021 test hook (T-DISC-02 must-fail): listings reach the model unfiltered. Never set by the entry point. */
  rawListings?: boolean;
  /** 021 test hook (T-AGT-23 must-fail): no cap on a run's searches. Never set by the entry point. */
  skipSearchLimit?: boolean;
  /** 021 test hook (T-AGT-23 must-fail): no 5 s bound on a search. Never set by the entry point. */
  skipSearchTimeout?: boolean;
  /** 021 test hook (T-AGT-22, T-E2E-18 must-fail): a search-mode run fetches any host. Never set by the entry point. */
  skipSellerList?: boolean;
}

/** 019: the desktop client's return address, on the person's own computer (specs/019 FR-002). */
export const DESKTOP_REDIRECT_URI = "http://127.0.0.1:53682/callback";
/** 019: the scopes a desktop client asks for: an ID token, a refresh token, and the agent's permission. */
export const DESKTOP_SCOPES = ["openid", "offline_access", REQUIRED_PERMISSION] as const;

/** 019: `GET /.well-known/agent-auth`, the public values a desktop client signs in with, all from the settings. */
export function agentAuthSettings(auth: Pick<HostedConfig["auth"], "issuer" | "audience">, clientId: string) {
  return {
    issuer: auth.issuer,
    // The tenant's issuer is https://<domain>/ with the final slash, so a custom domain moves both endpoints with it.
    authorization_endpoint: `${auth.issuer}authorize`,
    token_endpoint: `${auth.issuer}oauth/token`,
    audience: auth.audience,
    client_id: clientId,
    scopes: [...DESKTOP_SCOPES],
    redirect_uri: DESKTOP_REDIRECT_URI,
  };
}

export interface HostedApp {
  app: Express;
  markReady(): void;
}

const BYPASS_REQUESTER: Requester = { kind: "user", authority: "bypass", subject: "bypass", key: "bypass:bypass", client: "bypass" };

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
  const limitKey = deps.limitKey ?? ((r: Requester) => r.key);
  // 021: the network a search filters by, read once, when a search-mode run first needs it. On the local chain its
  // asset comes from the deployment record; a search that can't read it is UNAVAILABLE.
  let profile: SearchNetwork | undefined = deps.network;
  const searchNetwork = (): SearchNetwork => {
    try {
      return (profile ??= networkProfile(deps.config.network));
    } catch {
      // An unknown network: every search reads a field that throws, and so is UNAVAILABLE.
      const unknown = (): never => {
        throw new Error("no network profile");
      };
      return { name: deps.config.network, decimals: 6, get caip2() { return unknown(); }, get asset() { return unknown(); } };
    }
  };
  // 021 (FR-002): the run's mode is the operator's setting, read when the run starts. Only the test-only switch lets a
  // header choose it; no body field, session, goal or model output ever does.
  const modeOf = (req: Request): AgentMode => {
    const asked = req.headers["agent-test-mode"];
    if (deps.modeFromHeader && typeof asked === "string") return asked === "1" ? "test" : "search";
    return deps.config.mode;
  };

  // 017 (SEC-44): the dev issuer's tokens are accepted from this machine only. First, before health and every route.
  if (deps.config.auth.jwksFile !== undefined && !deps.skipLocalOnly) app.use(localOnly());
  // 017 (research R5): no proxy declared, and a request came through one: one line, once.
  app.use(proxyWarning(deps.config.trustedProxyHops ?? 0, () => runLog.event({ event: "proxy_undeclared" })));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    if (ready) res.json({ status: "ready" });
    else res.status(503).json({ status: "starting" });
  });
  // API_DOCS=1 only (SEC-13): Swagger UI and the document, token-free like the health routes, so before auth.
  if (deps.config.apiDocs) mountHostedApiDocs(app, docsSignIn(deps.config));

  // Per address, before any token is verified: a caller without a valid token is bounded too (SEC-14).
  if (!deps.skipAddressLimit) app.use(addressLimit({ ...(deps.maxRequestsPerAddress !== undefined && { max: deps.maxRequestsPerAddress }) }));
  // 017 (SEC-45): then failed authentications per address, also before the token is read. One line per burst.
  const firstInWindow = onceInWindow();
  const onLimit = (key: string, resetMs: number) => {
    if (firstInWindow(key, resetMs)) runLog.event({ event: "auth_failure_limit", count: MAX_FAILED_AUTH_PER_ADDRESS });
  };
  if (!deps.skipFailureLimit) app.use(failedAuthLimit({ onLimit }));

  // 019 (specs/019 FR-024, FR-025): the desktop client's sign-in settings, token-free, behind both limits, before auth.
  // A pure function of the settings: no session, model, L2 or L3, and nothing secret.
  const desktopClientId = deps.config.auth.desktopClientId;
  if (desktopClientId !== undefined) {
    const settings = agentAuthSettings(deps.config.auth, desktopClientId);
    app.get("/.well-known/agent-auth", (_req, res) => {
      res.set("Cache-Control", "public, max-age=300").json(settings);
    });
  }

  if (!deps.bypassAuth) {
    app.use(
      requesterAuth({
        issuer: deps.config.auth.issuer,
        audience: deps.config.auth.audience,
        clientIds: deps.config.auth.clientIds,
        keys: deps.keys,
        ...(deps.skipClientCheck && { skipClientCheck: true }),
        ...(deps.skipPermission && { skipPermission: true }),
        ...(deps.revealCheck && { revealCheck: true }),
      }),
    );
  }

  const checkLimits = (_req: Request, res: Response, next: NextFunction) => {
    const retryAfter = limiter.check(limitKey(requesterOf(res)));
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
    // 016 (SEC-32): who every payment of this run is for is decided by L2, from the caller's token. The gate made
    // here carries that token on each call and is the only thing that holds it; neither the goal text, the model
    // nor a tool input can change it or see it. With auth bypassed (tests only) the gate carries none.
    const gate = deps.gate.forCaller(callerTokenOf(res) ?? "");
    // 019 (FR-015..019): before a person's run, ask L2 through that gate whether they can pay now. A refusal is
    // JSON whatever the client asked for, opens no stream, makes no model call and is not counted as a start.
    if (requester.kind === "user" && !deps.skipAccountCheck) {
      const account = await checkAccount(gate, sessionId);
      if (!account.ok) {
        if (account.challenge) res.set("WWW-Authenticate", bearerChallenge(AGENT_REALM, true));
        res.status(account.status).json(account.body);
        return;
      }
    }
    const release = limiter.start(limitKey(requester));
    const mode = modeOf(req);
    const runId = `run_${randomUUID()}`;
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("deadline"), deps.deadlineMs ?? RUN_DEADLINE_MS);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort("client_disconnected");
    });
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
        mode,
        ...(mode === "search" && {
          discovery: { ...(deps.config.discoveryUrl !== undefined && { url: deps.config.discoveryUrl }), network: searchNetwork(), ...(deps.discoveryFetch && { fetchImpl: deps.discoveryFetch }) },
        }),
        ...(deps.rawListings && { rawListings: true }),
        ...(deps.skipSearchLimit && { skipSearchLimit: true }),
        ...(deps.skipSearchTimeout && { skipSearchTimeout: true }),
        ...(deps.skipSellerList && { skipSellerList: true }),
        onStep: (step, ms) => {
          runLog.step({ runId, requester: requester.key, client: requester.client, sessionId, index: step.index, tool: step.tool, ...stepOutcome(step.result, step.tool), ms });
          stream?.send("step", step);
        },
        ...(stream && { onText: (delta: string) => stream.send("text", { delta }) }),
      });
      runLog.run({
        runId,
        requester: requester.key,
        client: requester.client,
        sessionId,
        mode,
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
