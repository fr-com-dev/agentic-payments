// In-process hosted agent service for tests (specs/011): a dev issuer in a temp dir, the real
// createHostedApp, a scripted mock model, and either recording fakes or a harness for the L2/L3 ports.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider";
import type { Express } from "express";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createLocalJWKSet } from "jose";
import { DEV_AGENT_CLIENT, DEV_AUDIENCE, DEV_DESKTOP_CLIENT, devSubject, loadOrCreateDevIssuer, signDevToken, type DevTokenOptions } from "../../scripts/dev-issuer-lib.js";
import { DEV_ISSUER, loadHostedConfig, type HostedConfig } from "../../src/layer1-intent/hosted/config.js";
import { createHostedApp, type HostedDeps } from "../../src/layer1-intent/hosted/server.js";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../../src/layer1-intent/ports-http.js";
import type {
  AuthorizationDecision,
  AuthorizationGatePort,
  BudgetStatus,
  CallerGates,
  PaymentIntent,
  SellerHosts,
  SettlementClaim,
  SettlementReport,
  SettlementVerifierPort,
} from "../../src/shared/contracts.js";
import { STUB_LOCAL } from "./discovery-stub.js";
import type { Harness } from "./harness.js";

// ---------------------------------------------------------------------------
// Mock model results (ai/test MockLanguageModelV3). A test scripts whole turns; the mock streams them (doStream).
// ---------------------------------------------------------------------------

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

let callSeq = 0;
/** A model turn that calls one tool. */
export const toolCall = (toolName: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: `call_${++callSeq}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: "tool_use" },
  usage,
  warnings: [],
});

/** A final model turn with text. */
export const text = (t: string): LanguageModelV3GenerateResult => ({
  content: [{ type: "text", text: t }],
  finishReason: { unified: "stop", raw: "end_turn" },
  usage,
  warnings: [],
});

/** One model turn as a test scripts it: a value, one per call in order, or a function of the call's options. */
export type ModelScript =
  | LanguageModelV3GenerateResult
  | LanguageModelV3GenerateResult[]
  | ((options: LanguageModelV3CallOptions) => LanguageModelV3GenerateResult | Promise<LanguageModelV3GenerateResult>);

/**
 * The turn as the provider streams it (016: the agent calls the model through `stream`): text in pieces, a tool call
 * whole, then the finish part.
 */
function asStream(turn: LanguageModelV3GenerateResult): LanguageModelV3StreamResult {
  const chunks: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
  let n = 0;
  for (const part of turn.content) {
    if (part.type === "text") {
      const id = `text_${++n}`;
      chunks.push({ type: "text-start", id });
      // Word by word, so a test of the run stream sees more than one piece.
      for (const piece of part.text.match(/\S+\s*|\s+/g) ?? []) chunks.push({ type: "text-delta", id, delta: piece });
      chunks.push({ type: "text-end", id });
    } else if (part.type === "tool-call") {
      chunks.push(part);
    }
  }
  chunks.push({ type: "finish", usage: turn.usage, finishReason: turn.finishReason });
  return { stream: simulateReadableStream({ chunks }) };
}

/** A scripted model. A turn that throws, or a script that runs out, fails the model call as a provider error would. */
export const mockModel = (script: ModelScript = text("done")) => {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async (options) => {
      const i = call++;
      const turn = typeof script === "function" ? await script(options) : Array.isArray(script) ? script[i] : script;
      if (turn === undefined) throw new Error(`mock model: no turn scripted for call ${i + 1}`);
      return asStream(turn);
    },
  });
};

/** The calls the agent made to the model. */
export const modelCalls = (model: MockLanguageModelV3) => model.doStreamCalls;

/** The tool names the model saw on each call. */
export const toolNamesSeen = (model: MockLanguageModelV3) => model.doStreamCalls.map((c) => (c.tools ?? []).map((t) => t.name));

// ---------------------------------------------------------------------------
// Recording fake ports
// ---------------------------------------------------------------------------

export interface FakePortsOptions {
  authorize?: (intent: PaymentIntent) => Promise<AuthorizationDecision>;
  budget?: (sessionId: string) => Promise<BudgetStatus>;
  verify?: (claim: SettlementClaim) => Promise<SettlementReport>;
  /** 021: L2's seller hosts (`GET /v1/sellers`). Default `{ hosts: [] }`: the run keeps the configured seller's host. */
  sellers?: () => Promise<SellerHosts>;
}

export function fakePorts(o: FakePortsOptions = {}) {
  /**
   * 016: `callerToken` is the token the gate of that call was made for (`forCaller`): what L1 forwards to L2.
   * `intent` is the whole intent of an authorize call, to check that it names no user.
   */
  // 019: `gate` numbers the gate the call came through: 0 the plain gate, then 1, 2, … one per run (`forCaller`), so a
  // test can tell a person's account question (the first budget call of a run) from the check_budget tool's.
  // 021: a `sellers` call has no session; `callerToken` is the token of the gate it came through (the real adapter sends none).
  const gateCalls: { op: "authorize" | "budget" | "sellers"; sessionId: string; callerToken: string; gate: number; intent?: PaymentIntent }[] = [];
  const settlementCalls: SettlementClaim[] = [];
  const gateOf = (callerToken: string, gate: number): AuthorizationGatePort => ({
    authorize: async (intent) => {
      gateCalls.push({ op: "authorize", sessionId: intent.sessionId, callerToken, gate, intent });
      return o.authorize
        ? o.authorize(intent)
        : { status: "DENIED", authorizationId: "auth_fake", intentId: intent.intentId, violations: [{ rule: "fake", detail: "fake gate" }] };
    },
    budget: async (sessionId) => {
      gateCalls.push({ op: "budget", sessionId, callerToken, gate });
      return o.budget
        ? o.budget(sessionId)
        : // 019: as L2's user view, the person can pay, so the agent's account question lets the run start.
          { sessionId, asset: "0xasset", decimals: 6, sessionCapAtomic: "100000", spentOrReservedAtomic: "0", remainingAtomic: "100000", perPaymentCapAtomic: "20000", account: "ready" };
    },
    sellers: async () => {
      gateCalls.push({ op: "sellers", sessionId: "", callerToken, gate });
      return o.sellers ? o.sellers() : { hosts: [] };
    },
  });
  /**
   * The hosted app takes one gate per run, for that run's caller (`forCaller`). The same object is also a plain
   * gate that carries no token, for the tests that call `runGoal` or the orchestrator directly.
   */
  let gates = 0;
  const gate: CallerGates & AuthorizationGatePort = { ...gateOf("", 0), forCaller: (callerToken) => gateOf(callerToken, ++gates) };
  const settlement: SettlementVerifierPort = {
    verify: async (claim) => {
      settlementCalls.push(claim);
      if (o.verify) return o.verify(claim);
      throw new Error("fake settlement: not configured");
    },
  };
  return { gate, settlement, gateCalls, settlementCalls };
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

/** 017: an issuer in the sign-in tenant's shape, for tests that need the agent out of dev mode (`tenant: true`). */
export const TENANT_TEST_ISSUER = "https://x402-test.eu.auth0.com/";

export interface StartHostedOptions extends Partial<Omit<HostedDeps, "config" | "keys">> {
  /** Use a harness's URLs and tokens, with real HTTP port adapters. */
  harness?: Harness;
  /**
   * 017: start the agent with the sign-in tenant's issuer (TENANT_TEST_ISSUER) instead of the dev one, with the same
   * local keys, and sign `token()` with that issuer. The dev sign-in refuses a declared proxy and a public `Host`
   * (T-EDGE-02, T-EDGE-03); a test that needs either uses this.
   */
  tenant?: true;
  /** Extra or overriding env for loadHostedConfig. */
  env?: Record<string, string>;
  /**
   * 021: start the agent in search mode against a stand-in discovery index (test/helpers/discovery-stub.ts), on the
   * stub's test network unless `network` is given. Without it the agent is in test mode (`AGENT_TEST_MODE=1`), the agent
   * of before 021, so every older test sees what it saw (NFR-006).
   */
  discovery?: { url: string };
  /** Call markReady() after listen (default true). */
  ready?: boolean;
}

export interface HostedTestApp {
  base: string;
  /** The Express app (its mounted routes, for T-API-05). */
  app: Express;
  config: HostedConfig;
  markReady(): void;
  /** A dev-issuer token for `subject`: a person's with `agent:run` from the agent client, or with `service: true` a machine caller's. */
  token(subject: string, o?: Omit<DevTokenOptions, "subject">): Promise<string>;
  /** POST /v1/runs with a token for `subject` (or no token when subject is null). */
  run(subject: string | null, body: unknown, o?: Omit<DevTokenOptions, "subject">): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }>;
  close(): Promise<void>;
}

const devKeys = (jwks: Parameters<typeof createLocalJWKSet>[0]) => ({ keys: createLocalJWKSet(jwks), algorithms: ["ES256"] });

export async function startHostedApp(opts: StartHostedOptions = {}): Promise<HostedTestApp> {
  const { env: envOver, ready, harness, tenant, discovery, ...deps } = opts;
  const dir = mkdtempSync(join(tmpdir(), "hosted-"));
  const issuer = await loadOrCreateDevIssuer(join(dir, "issuer"), { NETWORK: "local" });
  // 016: with a harness whose L2 verifies callers' tokens, the agent verifies the same issuer's tokens with the
  // same keys, so a token it accepts and forwards is one L2 accepts too.
  const callers = harness?.callers;
  const loaded = loadHostedConfig({
    NETWORK: "local",
    MODEL_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test-key-not-used",
    AUTH_ISSUER: DEV_ISSUER,
    AUTH_AUDIENCE: DEV_AUDIENCE,
    AGENT_CLIENT_IDS: `${DEV_AGENT_CLIENT},${DEV_DESKTOP_CLIENT}`, // 019: the docs page client and the desktop client
    AUTH_JWKS_FILE: issuer.jwksPath,
    SESSION_REF_SECRET: randomBytes(32).toString("hex"),
    // 021: test mode unless a test asks for search mode; before envOver, so a test can still set either.
    AGENT_TEST_MODE: discovery ? "0" : "1",
    ...(discovery && { DISCOVERY_URL: discovery.url }),
    ...(tenant && { AUTH_ISSUER: TENANT_TEST_ISSUER, AUTH_JWKS_FILE: "" }),
    ...(harness && {
      SELLER_URL: harness.urls.seller,
      CONTROL_URL: harness.urls.control,
      SETTLEMENT_URL: harness.urls.settlement,
      CONTROL_TOKEN: harness.tokens.control,
      VERIFIER_TOKEN: harness.tokens.verifier,
    }),
    ...envOver,
  });
  const config: HostedConfig = callers ? { ...loaded, auth: { ...loaded.auth, issuer: callers.issuer, audience: callers.audience } } : loaded;
  const ports = harness
    ? { gate: new HttpAuthorizationGate(config.urls.control, config.tokens.control), settlement: new HttpSettlementVerifier(config.urls.settlement, config.tokens.verifier) }
    : fakePorts();
  // Object.assign, not a spread: since @mastra/core 1.83 the model's type is a union too large for TypeScript to
  // spread into a literal (TS2590).
  const hosted = createHostedApp(
    Object.assign(
      {
        config,
        // One local key, one issuer: it signs a person's token and a machine caller's.
        keys: callers ? { keys: callers.deps.keys, algorithms: callers.deps.algorithms } : devKeys(issuer.jwks),
        model: mockModel(),
        log: () => undefined,
        // 021: search mode searches the stub's test network unless the test names another.
        ...(discovery && { network: STUB_LOCAL }),
      },
      ports,
      deps,
    ) as HostedDeps,
  );
  if (ready !== false) hosted.markReady();
  const server = await new Promise<Server>((r) => {
    const s = hosted.app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token: HostedTestApp["token"] = (subject, o = {}) => {
    if (!callers) return signDevToken(issuer, { subject, ...(tenant && { issuer: TENANT_TEST_ISSUER }), ...o });
    const { service, sub, issuer: _issuer, audience: _audience, ...rest } = o;
    return service ? callers.machine({ client: subject, ...rest }) : callers.person(sub ?? devSubject(subject), rest);
  };
  return {
    base,
    app: hosted.app,
    config,
    markReady: hosted.markReady,
    token,
    run: async (subject, body, o) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (subject !== null) headers.authorization = `Bearer ${await token(subject, o)}`;
      const res = await fetch(`${base}/v1/runs`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
      const textBody = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(textBody) as Record<string, unknown>;
      } catch {
        parsed = { raw: textBody };
      }
      return { status: res.status, body: parsed, headers: res.headers };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
