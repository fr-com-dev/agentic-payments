// 019 — T-AGT-17 the account question (SPEC L1-6; specs/019 contracts/hosted-agent-api.md "The account question").
// Before a person's run the hosted agent asks L2, once, through that run's gate, whether the person can pay now, and
// refuses before any model call when they can't. The fake L2 here is the recording gate of test/helpers/hosted.ts,
// answering one row of the contract's table per case. `skipAccountCheck` is the test-only must-fail switch.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_STARTS_PER_HOUR } from "../src/layer1-intent/hosted/run-limits.js";
import { PortHttpError } from "../src/layer1-intent/ports-http.js";
import { MAX_FAILED_AUTH_PER_ADDRESS } from "../src/shared/address-limit.js";
import type { BudgetStatus } from "../src/shared/contracts.js";
import { DEV_DESKTOP_CLIENT } from "../scripts/dev-issuer-lib.js";
import { fakePorts, mockModel, modelCalls, startHostedApp, text, type HostedTestApp } from "./helpers/hosted.js";

let apps: HostedTestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const status = (sessionId: string, over: Partial<BudgetStatus> = {}): BudgetStatus => ({
  sessionId,
  asset: "0xasset",
  decimals: 6,
  sessionCapAtomic: "100000",
  spentOrReservedAtomic: "0",
  remainingAtomic: "100000",
  perPaymentCapAtomic: "20000",
  scope: "user_daily",
  account: "ready",
  ...over,
});
/** What L2's HTTP adapter throws for a refusal with a code (src/layer1-intent/ports-http.ts). */
const refusedBy = (httpStatus: number, code: string) => new PortHttpError("GET", "http://127.0.0.1:4020/v1/budget/sess_x", httpStatus, JSON.stringify({ error: code }));
const notReady = (error_code: string) => ({ error: "account not ready", error_code });
const UNAVAILABLE = { error: "control unavailable", error_code: "control_unavailable" };
const EXPIRED = { error: "unauthorized", error_code: "token_expired" };
const goal = { goal: "Get the weather for Lima" };

async function start(budget: (sessionId: string) => Promise<BudgetStatus>, extra: Parameters<typeof startHostedApp>[0] = {}) {
  const ports = fakePorts({ budget });
  const model = mockModel(text("done"));
  const lines: string[] = [];
  // Object.assign, not a spread: the model's type is too large a union to spread (TS2590, @mastra/core 1.83).
  const a = await startHostedApp(Object.assign({ model, gate: ports.gate, settlement: ports.settlement, log: (line: string) => lines.push(line) }, extra));
  apps.push(a);
  return { a, ports, model, lines };
}

describe("T-AGT-17 the account question before a person's run (019 FR-015..019)", () => {
  type Row = [name: string, budget: (sessionId: string) => Promise<BudgetStatus>, status: number, body: Record<string, string>];
  const rows: Row[] = [
    ["not onboarded", async (id) => status(id, { account: "not_onboarded", sessionCapAtomic: "0" }), 409, notReady("account_not_onboarded")],
    ["disabled", async (id) => status(id, { account: "disabled", sessionCapAtomic: "0" }), 409, notReady("account_disabled")],
    ["person accounts off at L2", async () => Promise.reject(refusedBy(403, "user_accounts_off")), 409, notReady("accounts_off")],
    ["the token expired between the agent's check and L2's", async () => Promise.reject(refusedBy(401, "caller_token_expired")), 401, EXPIRED],
    ["a 200 without account", async (id) => {
      const { account: _account, ...rest } = status(id);
      return rest;
    }, 503, UNAVAILABLE],
    ["a 200 with another account value", async (id) => status(id, { account: "frozen" as never }), 503, UNAVAILABLE],
    ["L2 refuses the token (a misconfiguration)", async () => Promise.reject(refusedBy(403, "caller_forbidden")), 503, UNAVAILABLE],
    ["another 401 code", async () => Promise.reject(refusedBy(401, "caller_token_invalid")), 503, UNAVAILABLE],
    ["a 500", async () => Promise.reject(refusedBy(500, "boom")), 503, UNAVAILABLE],
    ["a network error", async () => Promise.reject(new TypeError("fetch failed")), 503, UNAVAILABLE],
  ];

  it("T-AGT-17 each refusal of the table: its status and fixed body, no model call, no payment request, no session reference; the 401 carries the challenge", async () => {
    for (const [name, budget, code, body] of rows) {
      const { a, ports, model } = await start(budget);
      const r = await a.run("alice", goal, { azp: DEV_DESKTOP_CLIENT });
      expect([r.status, r.body], name).toEqual([code, body]);
      expect(r.headers.get("www-authenticate"), name).toBe(code === 401 ? 'Bearer realm="x402-agent", error="invalid_token"' : null);
      expect(modelCalls(model), name).toHaveLength(0);
      expect(ports.gateCalls.map((c) => c.op), name).toEqual(["budget"]);
    }
  });

  it("T-AGT-17 ready: the run starts, after exactly one budget call, with the run's own gate", async () => {
    const { a, ports, model } = await start(async (id) => status(id));
    const r = await a.run("alice", goal);
    expect(r.status).toBe(200);
    expect(r.body.sessionRef).toEqual(expect.any(String));
    expect(modelCalls(model).length).toBeGreaterThan(0);
    expect(ports.gateCalls.map((c) => [c.op, c.gate, c.sessionId])).toEqual([["budget", 1, String(r.body.sessionRef).split(".")[1]]]);
  });

  it("T-AGT-17 L2 answers after the 1 s bound: 503, and the run does not start", async () => {
    const { a, model } = await start(async (id) => {
      await new Promise((r) => setTimeout(r, 1_100));
      return status(id);
    });
    const t0 = Date.now();
    const r = await a.run("alice", goal);
    expect([r.status, r.body]).toEqual([503, UNAVAILABLE]);
    expect(Date.now() - t0).toBeLessThan(1_090);
    expect(modelCalls(model)).toHaveLength(0);
  });

  it("T-AGT-17 a refusal is not a start: after more refusals than a person's hourly starts, their next goal runs", async () => {
    let ready = false;
    const { a, model } = await start(async (id) => status(id, { account: ready ? "ready" : "not_onboarded" }));
    for (let i = 0; i <= MAX_STARTS_PER_HOUR; i++) expect((await a.run("alice", goal)).status).toBe(409);
    expect(modelCalls(model)).toHaveLength(0);
    ready = true;
    expect((await a.run("alice", goal)).status).toBe(200);
  });

  it("T-AGT-17 a run that asked for a stream is refused with the same JSON, before the stream opens", async () => {
    const { a, model } = await start(async (id) => status(id, { account: "not_onboarded" }));
    const res = await fetch(`${a.base}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${await a.token("alice")}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(goal),
    });
    expect([res.status, res.headers.get("content-type")?.split(";")[0], await res.json()]).toEqual([409, "application/json", notReady("account_not_onboarded")]);
    expect(modelCalls(model)).toHaveLength(0);
  });

  it("T-AGT-17 a machine caller's run is never asked: the platform's budget is no person's account", async () => {
    const { a, ports, model } = await start(async (id) => status(id, { account: "not_onboarded" }));
    const r = await a.run("x402-checks-dev", goal, { service: true });
    expect(r.status).toBe(200);
    expect(modelCalls(model).length).toBeGreaterThan(0);
    expect(ports.gateCalls).toEqual([]);
  });

  it("T-AGT-17 the expired answer counts toward the failed-authentication limit, as every 401 of the agent does", async () => {
    const { a } = await start(async () => Promise.reject(refusedBy(401, "caller_token_expired")));
    for (let i = 0; i < MAX_FAILED_AUTH_PER_ADDRESS; i++) expect((await a.run("alice", goal)).status).toBe(401);
    expect((await a.run("alice", goal)).status).toBe(429);
  });

  it("T-AGT-17 L2's error text never reaches the caller or the log: a planted value in it gives the fixed 503 body", async () => {
    const planted = "planted-l2-error-token-0019";
    const { a, lines } = await start(async () => Promise.reject(new Error(`budget failed: Bearer ${planted}`)));
    const res = await fetch(`${a.base}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${await a.token("alice")}`, "content-type": "application/json" }, body: JSON.stringify(goal) });
    const raw = await res.text();
    expect([res.status, JSON.parse(raw)]).toEqual([503, UNAVAILABLE]);
    expect(raw.includes(planted)).toBe(false);
    expect(lines.join("\n").includes(planted)).toBe(false);
  });

  it("T-AGT-17 must fail without the account question (skipAccountCheck): the not-onboarded person's run calls the model", async () => {
    const { a, model } = await start(async (id) => status(id, { account: "not_onboarded" }), { skipAccountCheck: true });
    expect((await a.run("alice", goal)).status).toBe(200);
    expect(modelCalls(model).length).toBeGreaterThan(0);
  });
});
