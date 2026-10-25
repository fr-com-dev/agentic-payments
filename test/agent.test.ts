// Feature 001 — Layer 1 (SPEC.md §8.1): port adapters (L1-2), orchestrator (L1-1), Claude agent
// (L1-3, T-AGT-01), scripted agent (L1-4), composition root (L1-5, INV-3). The real-chain run of the
// scripted plan is T-E2E-01 in test/e2e.local.test.ts (008).
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { HttpAuthorizationGate, HttpSettlementVerifier, PortHttpError } from "../src/layer1-intent/ports-http.js";
import { MAX_TEXT_BODY, PaidResourceOrchestrator, type PaidFetchResult } from "../src/layer1-intent/orchestrator.js";
import {
  AGENT_TOOLS,
  DEFAULT_MODEL,
  MAX_TOKENS,
  MAX_TURNS,
  runClaudeAgent,
  systemPrompt,
  toToolResult,
  type MessagesClient,
} from "../src/layer1-intent/agent.js";
import { checkBaseline, runScriptedAgent, scriptedPlan } from "../src/layer1-intent/scripted.js";
import { REFUSAL, resolveSessionId } from "../src/main.js";
import { formatAtomic } from "../src/shared/config.js";
import { checkBalance } from "../scripts/payer-balance.js";
import type {
  AuthorizationDecision,
  AuthorizationGatePort,
  BudgetStatus,
  PaymentIntent,
  PaymentRequired,
  SettlementClaim,
  SettlementReport,
  SettlementVerifierPort,
} from "../src/shared/contracts.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAY_TO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ASSET = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const requirement = (amount = "1000") => ({
  scheme: "exact",
  network: "eip155:31337",
  asset: ASSET,
  amount,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: "USD Coin", version: "2" },
});
const challenge = (url: string, amounts = ["1000"]): PaymentRequired =>
  ({ x402Version: 2, resource: { url }, accepts: amounts.map(requirement) }) as unknown as PaymentRequired;

const authorized = (intent: PaymentIntent, amount = "1000"): AuthorizationDecision => ({
  status: "AUTHORIZED",
  authorizationId: "auth_ok",
  intentId: intent.intentId,
  requirement: requirement(amount) as never,
  paymentHeaders: { "PAYMENT-SIGNATURE": "opaque-sig==" },
  payer: PAYER,
  validBefore: 1_900_000_000,
  remainingSessionBudgetAtomic: "99000",
});
const report = (c: SettlementClaim, status: SettlementReport["status"] = "CONFIRMED"): SettlementReport => ({
  authorizationId: c.authorizationId,
  status,
  transaction: "0xabc",
  network: c.requirement.network,
  finalityClass: "included",
  detail: status,
  observedAt: new Date().toISOString(),
  verified: { asset: c.requirement.asset, payer: c.payer, payTo: c.requirement.payTo, amount: c.requirement.amount },
});
const budget = (sessionId: string): BudgetStatus => ({
  sessionId,
  asset: ASSET,
  decimals: 6,
  sessionCapAtomic: "100000",
  spentOrReservedAtomic: "1000",
  remainingAtomic: "99000",
  perPaymentCapAtomic: "20000",
});

/** Fake gate recording intents; `decide` picks the decision. */
function fakeGate(decide: (i: PaymentIntent) => AuthorizationDecision | Promise<AuthorizationDecision> = (i) => authorized(i)) {
  const intents: PaymentIntent[] = [];
  const gate: AuthorizationGatePort & { intents: PaymentIntent[] } = {
    intents,
    async authorize(i) {
      intents.push(i);
      return decide(i);
    },
    async budget(s) {
      return budget(s);
    },
  };
  return gate;
}
function fakeVerifier(impl: (c: SettlementClaim) => SettlementReport | Promise<SettlementReport> = (c) => report(c)) {
  const claims: SettlementClaim[] = [];
  const v: SettlementVerifierPort & { claims: SettlementClaim[] } = {
    claims,
    async verify(c) {
      claims.push(c);
      return impl(c);
    },
  };
  return v;
}

interface SellerCall {
  url: string;
  headers: Record<string, string>;
}
/** Fake seller as a fetch implementation: 402 without payment headers, then `paid` with them. */
function fakeSeller(opts: {
  first?: () => Response;
  paid?: () => Response;
  amounts?: string[];
} = {}) {
  const calls: SellerCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers });
    if (calls.length === 1) {
      if (opts.first) return opts.first();
      return new Response(JSON.stringify({}), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge(url, opts.amounts)) },
      });
    }
    if (opts.paid) return opts.paid();
    return new Response(JSON.stringify({ city: "Lima", tempC: 21 }), {
      status: 200,
      headers: { "PAYMENT-RESPONSE": "raw-payment-response" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const URL_W = "http://127.0.0.1:4021/api/weather?city=Lima";

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});
async function listen(app: express.Express): Promise<string> {
  const s = await new Promise<Server>((r) => {
    const srv = app.listen(0, "127.0.0.1", () => r(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

// ---------------------------------------------------------------------------
// L1-2 port adapters (T006)
// ---------------------------------------------------------------------------

describe("L1-2 ports-http (001 T006)", () => {
  function stub(status = 200) {
    const seen: { method: string; path: string; auth: string | undefined; body: unknown }[] = [];
    const app = express();
    app.use(express.json());
    app.all(/.*/, (req, res) => {
      seen.push({ method: req.method, path: req.path, auth: req.headers.authorization, body: req.body });
      if (status !== 200) return void res.status(status).json({ error: "nope" });
      if (req.path === "/v1/authorize") return void res.json({ status: "DENIED", authorizationId: "a1", intentId: "i1", violations: [] });
      if (req.path.startsWith("/v1/budget/")) return void res.json(budget(decodeURIComponent(req.path.slice(11))));
      return void res.json({ status: "CONFIRMED" });
    });
    return { app, seen };
  }

  it("authorize POSTs /v1/authorize and budget GETs /v1/budget/:id with Bearer CONTROL_TOKEN only", async () => {
    const { app, seen } = stub();
    const gate = new HttpAuthorizationGate(await listen(app), "ctl-token");
    const intent = { intentId: "int_x", sessionId: "sess_1" } as PaymentIntent;
    expect((await gate.authorize(intent)).status).toBe("DENIED");
    expect((await gate.budget("sess_1")).sessionId).toBe("sess_1");
    expect(seen.map((s) => [s.method, s.path, s.auth])).toEqual([
      ["POST", "/v1/authorize", "Bearer ctl-token"],
      ["GET", "/v1/budget/sess_1", "Bearer ctl-token"],
    ]);
    expect(seen[0]!.body).toEqual(intent);
  });

  it("verify POSTs /v1/settlements with Bearer VERIFIER_TOKEN only", async () => {
    const { app, seen } = stub();
    const v = new HttpSettlementVerifier(await listen(app), "ver-token");
    await v.verify({ authorizationId: "a1" } as SettlementClaim);
    expect(seen.map((s) => [s.method, s.path, s.auth])).toEqual([["POST", "/v1/settlements", "Bearer ver-token"]]);
  });

  it("CONTROL_TOKEN never goes to L3 and VERIFIER_TOKEN never goes to L2 (INV-13)", async () => {
    const l2 = stub();
    const l3 = stub();
    const gate = new HttpAuthorizationGate(await listen(l2.app), "ctl-token");
    const ver = new HttpSettlementVerifier(await listen(l3.app), "ver-token");
    await gate.authorize({} as PaymentIntent);
    await ver.verify({} as SettlementClaim);
    expect(l2.seen.every((s) => s.auth === "Bearer ctl-token")).toBe(true);
    expect(l3.seen.every((s) => s.auth === "Bearer ver-token")).toBe(true);
  });

  it.each([400, 401, 500])("a %i response throws and is never returned as a decision", async (status) => {
    const { app } = stub(status);
    const base = await listen(app);
    await expect(new HttpAuthorizationGate(base, "t").authorize({} as PaymentIntent)).rejects.toBeInstanceOf(PortHttpError);
    await expect(new HttpAuthorizationGate(base, "t").budget("s")).rejects.toBeInstanceOf(PortHttpError);
    await expect(new HttpSettlementVerifier(base, "t").verify({} as SettlementClaim)).rejects.toBeInstanceOf(PortHttpError);
  });
});

// ---------------------------------------------------------------------------
// L1-1 orchestrator (T008, T009, T014)
// ---------------------------------------------------------------------------

describe("L1-1 orchestrator: FREE and ERROR branches (001 T008)", () => {
  const orch = (fetchImpl: typeof fetch, gate = fakeGate()) =>
    new PaidResourceOrchestrator({ gate, settlement: fakeVerifier(), sessionId: "sess_t", fetchImpl });

  it("a network error on the first request returns ERROR", async () => {
    const r = await orch((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch).fetchPaid(URL_W, "p");
    expect(r.outcome).toBe("ERROR");
    expect(r.error).toContain("fetch failed");
  });

  it("a non-402 returns FREE with status and JSON body and never calls authorize", async () => {
    const gate = fakeGate();
    const r = await orch((async () => Response.json({ items: [1] }, { status: 200 })) as typeof fetch, gate).fetchPaid(URL_W, "p");
    expect(r).toMatchObject({ outcome: "FREE", httpStatus: 200, body: { items: [1] } });
    expect(gate.intents).toHaveLength(0);
  });

  it("a non-JSON body is returned as text truncated to 2000 chars", async () => {
    const r = await orch((async () => new Response("x".repeat(5000), { status: 404 })) as typeof fetch).fetchPaid(URL_W, "p");
    expect(r.outcome).toBe("FREE");
    expect(r.httpStatus).toBe(404);
    expect((r.body as string).length).toBe(MAX_TEXT_BODY);
  });

  it("a 402 with no PAYMENT-REQUIRED header but a JSON body uses the v1 fallback", async () => {
    const gate = fakeGate((i) => ({ status: "DENIED", authorizationId: "a", intentId: i.intentId, violations: [] }));
    const body = JSON.stringify(challenge(URL_W));
    const { fetchImpl } = fakeSeller({ first: () => new Response(body, { status: 402 }) });
    await orch(fetchImpl, gate).fetchPaid(URL_W, "p");
    expect(gate.intents[0]!.paymentRequired).toEqual(JSON.parse(body));
  });

  it("a 402 with no header and a non-JSON body returns ERROR", async () => {
    const gate = fakeGate();
    const { fetchImpl } = fakeSeller({ first: () => new Response("pay me", { status: 402 }) });
    const r = await orch(fetchImpl, gate).fetchPaid(URL_W, "p");
    expect(r.outcome).toBe("ERROR");
    expect(gate.intents).toHaveLength(0);
  });
});

describe("L1-1 orchestrator: paid path (001 T009)", () => {
  it("builds the intent, forwards headers byte-for-byte, claims with the raw PAYMENT-RESPONSE, returns PAID", async () => {
    const gate = fakeGate();
    const ver = fakeVerifier();
    const seller = fakeSeller({ amounts: ["5000", "1000"] });
    const o = new PaidResourceOrchestrator({ gate, settlement: ver, sessionId: "sess_const", fetchImpl: seller.fetchImpl });
    const r = await o.fetchPaid(URL_W, "need weather");

    const intent = gate.intents[0]!;
    expect(intent.intentId).toMatch(/^int_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(intent.sessionId).toBe("sess_const");
    expect(intent.resourceUrl).toBe(URL_W);
    expect(intent.purpose).toBe("need weather");
    expect(intent.paymentRequired.accepts).toHaveLength(2); // verbatim, all accepts[] entries
    expect(intent.paymentRequired).toEqual(challenge(URL_W, ["5000", "1000"]));
    expect(new Date(intent.createdAt).toISOString()).toBe(intent.createdAt);

    expect(seller.calls[1]!.headers["payment-signature"]).toBe("opaque-sig==");
    expect(ver.claims[0]).toMatchObject({
      authorizationId: "auth_ok",
      payer: PAYER,
      validBefore: 1_900_000_000,
      httpStatus: 200,
      paymentResponseHeader: "raw-payment-response",
    });
    expect(r).toMatchObject({
      outcome: "PAID",
      httpStatus: 200,
      body: { city: "Lima" },
      authorizationId: "auth_ok",
      payment: { authorizationId: "auth_ok", amountAtomic: "1000", asset: ASSET, payTo: PAY_TO, settlement: { status: "CONFIRMED" } },
    });
  });

  it("intentId is unique per call and sessionId is constant", async () => {
    const gate = fakeGate((i) => ({ status: "DENIED", authorizationId: "a", intentId: i.intentId, violations: [] }));
    const o = new PaidResourceOrchestrator({
      gate,
      settlement: fakeVerifier(),
      sessionId: "sess_same",
      fetchImpl: (async (u: string) =>
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge(String(u))) } })) as typeof fetch,
    });
    await o.fetchPaid(URL_W, "a");
    await o.fetchPaid(URL_W, "b");
    expect(new Set(gate.intents.map((i) => i.intentId)).size).toBe(2);
    expect(gate.intents.map((i) => i.sessionId)).toEqual(["sess_same", "sess_same"]);
  });

  it("PENDING counts as PAID", async () => {
    const o = new PaidResourceOrchestrator({
      gate: fakeGate(),
      settlement: fakeVerifier((c) => report(c, "PENDING")),
      sessionId: "s",
      fetchImpl: fakeSeller().fetchImpl,
    });
    expect((await o.fetchPaid(URL_W, "p")).outcome).toBe("PAID");
  });

  it.each(["MISMATCH", "NOT_SETTLED"] as const)("2xx with %s gives PAYMENT_FAILED with the body", async (status) => {
    const o = new PaidResourceOrchestrator({
      gate: fakeGate(),
      settlement: fakeVerifier((c) => report(c, status)),
      sessionId: "s",
      fetchImpl: fakeSeller().fetchImpl,
    });
    const r = await o.fetchPaid(URL_W, "p");
    expect(r.outcome).toBe("PAYMENT_FAILED");
    expect(r.body).toEqual({ city: "Lima", tempC: 21 });
    expect(r.payment?.settlement?.status).toBe(status);
  });

  it("a non-2xx paid response gives PAYMENT_FAILED without the body; the claim has a null header", async () => {
    const ver = fakeVerifier((c) => report(c, "NOT_SETTLED"));
    const o = new PaidResourceOrchestrator({
      gate: fakeGate(),
      settlement: ver,
      sessionId: "s",
      fetchImpl: fakeSeller({ paid: () => Response.json({ secret: "content" }, { status: 500 }) }).fetchImpl,
    });
    const r = await o.fetchPaid(URL_W, "p");
    expect(r.outcome).toBe("PAYMENT_FAILED");
    expect(r.httpStatus).toBe(500);
    expect(r.body).toBeUndefined();
    expect(ver.claims[0]!.paymentResponseHeader).toBeNull();
  });

  it("a gate.authorize error gives ERROR and is never treated as AUTHORIZED", async () => {
    const seller = fakeSeller();
    const ver = fakeVerifier();
    const o = new PaidResourceOrchestrator({
      gate: fakeGate(() => {
        throw new PortHttpError("POST", "x", 401, "unauthorized");
      }),
      settlement: ver,
      sessionId: "s",
      fetchImpl: seller.fetchImpl,
    });
    const r = await o.fetchPaid(URL_W, "p");
    expect(r.outcome).toBe("ERROR");
    expect(seller.calls).toHaveLength(1);
    expect(ver.claims).toHaveLength(0);
  });

  it("a settlement.verify error after a 2xx paid retry gives PAYMENT_FAILED and keeps payment (SPEC v1.1 L1-1)", async () => {
    const o = new PaidResourceOrchestrator({
      gate: fakeGate(),
      settlement: fakeVerifier(() => {
        throw new PortHttpError("POST", "x", 503, "down");
      }),
      sessionId: "s",
      fetchImpl: fakeSeller().fetchImpl,
    });
    const r = await o.fetchPaid(URL_W, "p");
    expect(r.outcome).toBe("PAYMENT_FAILED");
    expect(r.authorizationId).toBe("auth_ok");
    expect(r.payment).toMatchObject({ authorizationId: "auth_ok", amountAtomic: "1000", payTo: PAY_TO });
    expect(r.error).toContain("settlement verification failed");
  });
});

describe("L1-1 orchestrator: denials and escalations are not retried (001 T014)", () => {
  it.each([
    ["DENIED", "DENIED", "hard_cap_exceeded"],
    ["ESCALATE", "ESCALATED", "human_approval_required"],
  ] as const)("%s → %s with violations and authorizationId; one seller request; no verify", async (status, outcome, rule) => {
    const seller = fakeSeller();
    const ver = fakeVerifier();
    const gate = fakeGate((i) => ({ status, authorizationId: "auth_stop", intentId: i.intentId, violations: [{ rule, detail: "d" }] }));
    const r = await new PaidResourceOrchestrator({ gate, settlement: ver, sessionId: "s", fetchImpl: seller.fetchImpl }).fetchPaid(URL_W, "p");
    expect(r).toMatchObject({ outcome, authorizationId: "auth_stop", violations: [{ rule }] });
    expect(seller.calls).toHaveLength(1);
    expect(ver.claims).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// L1-5 composition root (T017, T018, T019)
// ---------------------------------------------------------------------------

describe("L1-5 composition root (001 T017, T019)", () => {
  it("T-AGT-KEY (T017): with PAYER_PRIVATE_KEY set, main.ts exits 1 with the refusal and makes no network call (INV-3)", async () => {
    let connections = 0;
    const counter = createServer((_req, res) => res.end("{}"));
    counter.on("connection", () => connections++);
    servers.push(counter);
    await new Promise<void>((r) => counter.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(counter.address() as AddressInfo).port}`;

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PAYER_PRIVATE_KEY: "0x1",
      ENV_FILE: "/dev/null",
      NETWORK: "local",
      CONTROL_URL: url,
      SETTLEMENT_URL: url,
      SELLER_URL: url,
    };
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--scripted"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(code).toBe(1);
    expect(stderr).toContain(REFUSAL);
    expect(connections).toBe(0);
  });

  it("T019: sessionId is SESSION_ID when set, otherwise sess_<8 hex>", () => {
    expect(resolveSessionId({ SESSION_ID: "sess_fixed" })).toBe("sess_fixed");
    expect(resolveSessionId({})).toMatch(/^sess_[0-9a-f]{8}$/);
    expect(resolveSessionId({})).not.toBe(resolveSessionId({}));
  });

  it("the refusal check is the first statement after loadEnv in main.ts", () => {
    const src = readFileSync("src/main.ts", "utf8");
    const body = src.slice(src.indexOf("async function main"));
    const load = body.indexOf('loadEnv("l1-agent")');
    const check = body.indexOf("PAYER_PRIVATE_KEY !== undefined");
    expect(load).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(load);
    for (const later of ["serviceUrls(", "tokenFor(", "import(", "fetch("]) {
      const at = body.indexOf(later);
      if (at >= 0) expect(at).toBeGreaterThan(check);
    }
  });
});

// ---------------------------------------------------------------------------
// 011 hosted entry point (src/hosted-main.ts): INV-3 in both env sources
// ---------------------------------------------------------------------------

describe("T-AGT-KEY hosted (INV-3)", () => {
  async function runHosted(extraEnv: NodeJS.ProcessEnv) {
    let connections = 0;
    const counter = createServer((_req, res) => res.end("{}"));
    counter.on("connection", () => connections++);
    servers.push(counter);
    await new Promise<void>((r) => counter.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(counter.address() as AddressInfo).port}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NETWORK: "local",
      CONTROL_URL: url,
      SETTLEMENT_URL: url,
      SELLER_URL: url,
      ...extraEnv,
    };
    const child = spawn(process.execPath, ["--import", "tsx", "src/hosted-main.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    return { code, stderr, connections };
  }

  it("T-AGT-KEY hosted: with PAYER_PRIVATE_KEY in the process env, hosted-main exits 1 with the refusal and makes no network call", async () => {
    const r = await runHosted({ PAYER_PRIVATE_KEY: "0x1", ENV_FILE: "/dev/null" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(REFUSAL);
    expect(r.connections).toBe(0);
  });

  it("T-AGT-KEY hosted: a payer key present only in ENV_FILE is refused too (the check runs after loadEnv)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-key-"));
    try {
      const file = join(dir, "l1-hosted.env");
      writeFileSync(file, "PAYER_PRIVATE_KEY=0x1\n");
      const r = await runHosted({ ENV_FILE: file });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(REFUSAL);
      expect(r.connections).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the refusal check is the first statement after loadEnv in hosted-main.ts", () => {
    const src = readFileSync("src/hosted-main.ts", "utf8");
    const body = src.slice(src.indexOf("async function main"));
    const load = body.indexOf('loadEnv("l1-hosted")');
    const check = body.indexOf("PAYER_PRIVATE_KEY !== undefined");
    expect(load).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(load);
    for (const later of ["loadHostedConfig(", "keysFor(", "import(", "listen("]) {
      const at = body.indexOf(later);
      if (at >= 0) expect(at).toBeGreaterThan(check);
    }
  });
});

// ---------------------------------------------------------------------------
// L1-3 Claude agent (T023–T026, T-AGT-01)
// ---------------------------------------------------------------------------

type Block = Message["content"][number];
const msg = (content: Block[], stop: Message["stop_reason"]): Message =>
  ({ id: "msg", type: "message", role: "assistant", model: "fake", content, stop_reason: stop, stop_sequence: null, usage: {} }) as unknown as Message;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as unknown as Block;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Block;

/** Fake Messages client: returns scripted responses and records every request. */
function fakeClient(responses: (req: MessageCreateParamsNonStreaming, n: number) => Message) {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient & { requests: typeof requests } = {
    requests,
    messages: {
      async create(params) {
        requests.push(structuredClone(params));
        return responses(params, requests.length);
      },
    },
  };
  return client;
}

describe("L1-3 Claude agent (001 T023–T026)", () => {
  it("T-AGT-01: exactly two tools, purpose reaches the intent, tool result has PAID + CONFIRMED", async () => {
    const gate = fakeGate();
    const orchestrator = new PaidResourceOrchestrator({ gate, settlement: fakeVerifier(), sessionId: "sess_agt", fetchImpl: fakeSeller().fetchImpl });
    const client = fakeClient((_req, n) =>
      n === 1
        ? msg([toolUse("tu_1", "fetch_resource", { url: URL_W, purpose: "user asked for Lima weather" })], "tool_use")
        : msg([text("Receipt: weather, $0.001, CONFIRMED, 0xabc")], "end_turn"),
    );
    const out = await runClaudeAgent({ goal: "weather in Lima", orchestrator, gate, sessionId: "sess_agt", sellerUrl: "http://127.0.0.1:4021", client, decimals: 6 });

    const contract = JSON.parse(readFileSync("specs/001-agent-paid-fetch/contracts/agent-tools.json", "utf8"));
    for (const req of client.requests) {
      expect(req.tools).toHaveLength(2);
      expect(req.tools).toEqual(contract);
    }
    expect(gate.intents.map((i) => i.purpose)).toEqual(["user asked for Lima weather"]);

    const toolResultMsg = client.requests[1]!.messages.at(-1)!;
    const block = (toolResultMsg.content as { type: string; tool_use_id: string; content: string }[])[0]!;
    expect(block).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    const result = JSON.parse(block.content);
    expect(result.outcome).toBe("PAID");
    expect(result.payment.settlement.status).toBe("CONFIRMED");
    expect(out).toMatchObject({ turns: 2, stopReason: "end_turn" });
    expect(out.finalText).toContain("Receipt");
  });

  it("T024: stops after exactly 10 turns; max_tokens 2048; default model claude-sonnet-5-5", async () => {
    const prev = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    try {
      const client = fakeClient(() => msg([toolUse("tu", "check_budget", {})], "tool_use"));
      const out = await runClaudeAgent({ goal: "g", orchestrator: { fetchPaid: async () => ({ outcome: "FREE", url: "" }) }, gate: fakeGate(), sessionId: "s", sellerUrl: "http://x", client });
      expect(MAX_TURNS).toBe(10);
      expect(out.turns).toBe(10);
      expect(client.requests).toHaveLength(10);
      expect(client.requests.every((r) => r.max_tokens === MAX_TOKENS && MAX_TOKENS === 2048)).toBe(true);
      expect(client.requests.every((r) => r.model === DEFAULT_MODEL && DEFAULT_MODEL === "claude-sonnet-5-5")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_MODEL = prev;
    }
  });

  it("T025: tool-result JSON has exactly the L1-3 keys and amountUsd = formatAtomic(amount, decimals)", () => {
    const r: PaidFetchResult = {
      outcome: "PAID",
      url: URL_W,
      httpStatus: 200,
      body: { ok: 1 },
      authorizationId: "auth_ok",
      payment: { authorizationId: "auth_ok", amountAtomic: "5000", asset: ASSET, network: "eip155:31337", payTo: PAY_TO, settlement: report({ ...({} as SettlementClaim), authorizationId: "auth_ok", requirement: requirement("5000") as never, payer: PAYER, validBefore: 0, httpStatus: 200, paymentResponseHeader: null }) },
    };
    const j = toToolResult(r, 6);
    expect(Object.keys(j).sort()).toEqual(["authorizationId", "body", "error", "httpStatus", "outcome", "payment", "violations"]);
    expect(Object.keys(j.payment!).sort()).toEqual(["amountUsd", "authorizationId", "settlement"]);
    expect(Object.keys(j.payment!.settlement).sort()).toEqual(["finality", "status", "tx"]);
    expect(j.payment!.amountUsd).toBe(formatAtomic("5000", 6));
    expect(j.payment!.amountUsd).toBe("0.005");
    expect(j.payment!.settlement).toEqual({ status: "CONFIRMED", tx: "0xabc", finality: "included" });
  });

  it("T026: the system prompt carries every L1-3 duty", () => {
    const p = systemPrompt("http://127.0.0.1:4021/");
    expect(p).toContain("http://127.0.0.1:4021/api/catalog");
    expect(p).toMatch(/atomic units/i);
    expect(p).toMatch(/only what the goal needs/i);
    expect(p).toMatch(/prefer cheaper/i);
    expect(p).toMatch(/never retry a DENIED payment/i);
    expect(p).toMatch(/explain which rule/i);
    expect(p).toMatch(/ESCALATED.*authorizationId/i);
    expect(p).toMatch(/receipt list: resource, USD, settlement status, tx/i);
  });

  it("an unknown tool name returns an error result and performs no action", async () => {
    const gate = fakeGate();
    let fetches = 0;
    const client = fakeClient((_r, n) => (n === 1 ? msg([toolUse("tu_x", "sign_payment", { amount: "1" })], "tool_use") : msg([text("done")], "end_turn")));
    await runClaudeAgent({ goal: "g", orchestrator: { fetchPaid: async () => (fetches++, { outcome: "FREE", url: "" }) }, gate, sessionId: "s", sellerUrl: "http://x", client });
    const block = (client.requests[1]!.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
    expect(block.is_error).toBe(true);
    expect(block.content).toContain("unknown tool");
    expect(fetches).toBe(0);
    expect(gate.intents).toHaveLength(0);
  });

  it("AGENT_TOOLS offers no signing, approval or policy capability (SEC-1)", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["fetch_resource", "check_budget"]);
  });
});

// ---------------------------------------------------------------------------
// L1-4 scripted agent (T031)
// ---------------------------------------------------------------------------

describe("L1-4 scripted agent (001 T031)", () => {
  it("requests the six steps in order, step 6 via host localhost on the same port", async () => {
    const urls: string[] = [];
    const results = await runScriptedAgent({
      orchestrator: { fetchPaid: async (url) => (urls.push(url), { outcome: "FREE", url }) },
      sellerUrl: "http://127.0.0.1:4021",
      log: () => {},
    });
    expect(urls).toEqual([
      "http://127.0.0.1:4021/api/catalog",
      "http://127.0.0.1:4021/api/weather?city=Lima",
      "http://127.0.0.1:4021/api/market-brief",
      "http://127.0.0.1:4021/api/premium-report",
      "http://127.0.0.1:4021/api/dataset-export",
      "http://localhost:4021/api/weather?city=Lima",
    ]);
    expect(results).toHaveLength(6);
    expect(scriptedPlan("http://127.0.0.1:4021")).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// L1-4 seller alias and baseline check (011 US6): step 6 in the cloud, and the regression job's gate
// ---------------------------------------------------------------------------

describe("L1-4 seller alias (011 US6)", () => {
  it("without an alias, the plan is unchanged: step 6 is step 2 through localhost", () => {
    const plan = scriptedPlan("http://127.0.0.1:4021");
    expect(plan[5]!.url).toBe("http://localhost:4021/api/weather?city=Lima");
  });

  it("with an alias, step 6 is the alias seller's weather; steps 1–5 are identical", () => {
    const plain = scriptedPlan("https://seller.example");
    const aliased = scriptedPlan("https://seller.example", "https://alias.example");
    expect(aliased[5]!.url).toBe("https://alias.example/api/weather?city=Lima");
    expect(aliased.slice(0, 5)).toEqual(plain.slice(0, 5));
  });

  const result = (outcome: PaidFetchResult["outcome"], settlement?: "CONFIRMED" | "PENDING"): PaidFetchResult => ({
    outcome,
    url: "u",
    ...(outcome === "PAID" && {
      payment: { authorizationId: "a", amountAtomic: "1", asset: "x", network: "n", payTo: "p", settlement: { status: settlement ?? "CONFIRMED" } as never },
    }),
  });
  const baseline = () => [result("FREE"), result("PAID"), result("PAID"), result("ESCALATED"), result("DENIED"), result("DENIED")];

  it("checkBaseline accepts the L1-4 outcomes with both payments CONFIRMED", () => {
    expect(checkBaseline(baseline())).toEqual({ ok: true, detail: "FREE, PAID, PAID, ESCALATED, DENIED, DENIED" });
  });

  it("checkBaseline rejects a different outcome, a missing step or a PENDING payment", () => {
    const changed = baseline();
    changed[4] = result("PAID");
    expect(checkBaseline(changed).ok).toBe(false);
    expect(checkBaseline(baseline().slice(0, 5)).ok).toBe(false);
    const pending = baseline();
    pending[2] = result("PAID", "PENDING");
    expect(checkBaseline(pending)).toMatchObject({ ok: false });
    expect(checkBaseline(pending).detail).toContain("PENDING");
  });
});

describe("011 US6 payer-balance preflight", () => {
  const asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
  const payer = "0x0048A66969cE8886A5e9bC00059Cb8c5D3989516" as const;
  const reader = (balance: bigint) => {
    const calls: unknown[] = [];
    return { calls, readContract: async (args: unknown) => (calls.push(args), balance) };
  };

  it("011 US6 payer-balance preflight: at or above the minimum passes; below it asks to fund the payer", async () => {
    const enough = reader(50_000n);
    expect(await checkBalance(enough, asset, payer, 50_000n)).toEqual({ code: 0, line: "balance=50000" });
    expect(enough.calls[0]).toMatchObject({ address: asset, functionName: "balanceOf", args: [payer] });
    const low = await checkBalance(reader(49_999n), asset, payer, 50_000n);
    expect(low.code).toBe(2);
    expect(low.line).toContain("fund the payer");
  });
});
