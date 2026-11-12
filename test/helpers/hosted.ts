// In-process hosted agent service for tests (specs/011): a dev issuer in a temp dir, the real
// createHostedApp, a scripted mock model, and either recording fakes or a harness for the L2/L3 ports.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { Express } from "express";
import { MockLanguageModelV3 } from "ai/test";
import { createLocalJWKSet } from "jose";
import { DEV_AGENT_CLIENT, DEV_AUDIENCE, DEV_SERVICE_AUDIENCE, loadOrCreateDevIssuer, signDevToken, type DevTokenOptions } from "../../scripts/dev-issuer-lib.js";
import { DEV_ISSUER, DEV_TENANT, loadHostedConfig, type HostedConfig } from "../../src/layer1-intent/hosted/config.js";
import { createHostedApp, type HostedDeps } from "../../src/layer1-intent/hosted/server.js";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../../src/layer1-intent/ports-http.js";
import type {
  AuthorizationDecision,
  AuthorizationGatePort,
  BudgetStatus,
  PaymentIntent,
  SettlementClaim,
  SettlementReport,
  SettlementVerifierPort,
} from "../../src/shared/contracts.js";
import type { Harness } from "./harness.js";

// ---------------------------------------------------------------------------
// Mock model results (ai/test MockLanguageModelV3, scripted through doGenerate)
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

export type DoGenerate = ConstructorParameters<typeof MockLanguageModelV3>[0] extends infer O ? (O extends { doGenerate?: infer G } ? G : never) : never;

export const mockModel = (doGenerate: DoGenerate = text("done")) => new MockLanguageModelV3({ doGenerate });

/** The tool names the model saw on each call. */
export const toolNamesSeen = (model: MockLanguageModelV3) => model.doGenerateCalls.map((c) => (c.tools ?? []).map((t) => t.name));

// ---------------------------------------------------------------------------
// Recording fake ports
// ---------------------------------------------------------------------------

export interface FakePortsOptions {
  authorize?: (intent: PaymentIntent) => Promise<AuthorizationDecision>;
  budget?: (sessionId: string, userId?: string) => Promise<BudgetStatus>;
  verify?: (claim: SettlementClaim) => Promise<SettlementReport>;
}

export function fakePorts(o: FakePortsOptions = {}) {
  /** 013: `userId` is what the service named for the call (absent for a system identity). */
  const gateCalls: { op: "authorize" | "budget"; sessionId: string; userId?: string }[] = [];
  const settlementCalls: SettlementClaim[] = [];
  const gate: AuthorizationGatePort = {
    authorize: async (intent) => {
      gateCalls.push({ op: "authorize", sessionId: intent.sessionId, ...(intent.userId !== undefined && { userId: intent.userId }) });
      return o.authorize
        ? o.authorize(intent)
        : { status: "DENIED", authorizationId: "auth_fake", intentId: intent.intentId, violations: [{ rule: "fake", detail: "fake gate" }] };
    },
    budget: async (sessionId, userId) => {
      gateCalls.push({ op: "budget", sessionId, ...(userId !== undefined && { userId }) });
      return o.budget
        ? o.budget(sessionId, userId)
        : { sessionId, asset: "0xasset", decimals: 6, sessionCapAtomic: "100000", spentOrReservedAtomic: "0", remainingAtomic: "100000", perPaymentCapAtomic: "20000" };
    },
  };
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

export interface StartHostedOptions extends Partial<Omit<HostedDeps, "config" | "keys">> {
  /** Use a harness's URLs and tokens, with real HTTP port adapters. */
  harness?: Harness;
  /** Extra or overriding env for loadHostedConfig. */
  env?: Record<string, string>;
  /** Call markReady() after listen (default true). */
  ready?: boolean;
}

export interface HostedTestApp {
  base: string;
  /** The Express app (its mounted routes, for T-API-05). */
  app: Express;
  config: HostedConfig;
  markReady(): void;
  /** A dev-issuer token for `subject`: a person's with `agent:run` from the agent client, or with `service: true` a system identity's. */
  token(subject: string, o?: Omit<DevTokenOptions, "subject">): Promise<string>;
  /** POST /v1/runs with a token for `subject` (or no token when subject is null). */
  run(subject: string | null, body: unknown, o?: Omit<DevTokenOptions, "subject">): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }>;
  close(): Promise<void>;
}

const devKeys = (jwks: Parameters<typeof createLocalJWKSet>[0]) => ({ keys: createLocalJWKSet(jwks), algorithms: ["ES256"] });

export async function startHostedApp(opts: StartHostedOptions = {}): Promise<HostedTestApp> {
  const { env: envOver, ready, harness, ...deps } = opts;
  const dir = mkdtempSync(join(tmpdir(), "hosted-"));
  const issuer = await loadOrCreateDevIssuer(join(dir, "issuer"), { NETWORK: "local" });
  const config = loadHostedConfig({
    NETWORK: "local",
    MODEL_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test-key-not-used",
    AUTH_ISSUER: DEV_ISSUER,
    AUTH_AUDIENCE: DEV_AUDIENCE,
    AGENT_CLIENT_IDS: DEV_AGENT_CLIENT,
    AUTH_TENANT_ID: DEV_TENANT,
    SERVICE_AUDIENCE: DEV_SERVICE_AUDIENCE,
    AUTH_JWKS_FILE: issuer.jwksPath,
    SESSION_REF_SECRET: randomBytes(32).toString("hex"),
    ...(harness && {
      SELLER_URL: harness.urls.seller,
      CONTROL_URL: harness.urls.control,
      SETTLEMENT_URL: harness.urls.settlement,
      CONTROL_TOKEN: harness.tokens.control,
      VERIFIER_TOKEN: harness.tokens.verifier,
    }),
    ...envOver,
  });
  const ports = harness
    ? { gate: new HttpAuthorizationGate(config.urls.control, config.tokens.control), settlement: new HttpSettlementVerifier(config.urls.settlement, config.tokens.verifier) }
    : fakePorts();
  const hosted = createHostedApp({
    config,
    // One local key signs both kinds of token; which checks run is chosen by the issuer each token names.
    keys: { ...(config.auth.person && { person: devKeys(issuer.jwks) }), ...(config.auth.service && { service: devKeys(issuer.jwks) }) },
    model: mockModel(),
    log: () => undefined,
    ...ports,
    ...deps,
  } as HostedDeps);
  if (ready !== false) hosted.markReady();
  const server = await new Promise<Server>((r) => {
    const s = hosted.app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token: HostedTestApp["token"] = (subject, o = {}) => signDevToken(issuer, { subject, ...o });
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
