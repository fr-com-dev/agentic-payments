// 019 — the desktop client's tokens (SPEC L1-6, L2-5; specs/019 US1, US2). `019 US1`: a person's token from the
// desktop client (the dev issuer's `x402-agent-desktop-dev`, on both services' lists) starts a run at the hosted agent,
// and L2 accepts it and pays from that person's own account; the portal refuses it; the docs page's client and a
// machine caller run as before. T-AGT-19: the run limits count per person, whatever client and token they use.
// `limitKey` is the test-only must-fail switch.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CONCURRENT_RUNS, MAX_STARTS_PER_HOUR } from "../src/layer1-intent/hosted/run-limits.js";
import { DEV_AGENT_CLIENT, DEV_DESKTOP_CLIENT } from "../scripts/dev-issuer-lib.js";
import { fakePorts, mockModel, modelCalls, startHostedApp, text, type HostedTestApp } from "./helpers/hosted.js";
import { startPortal, type PortalTestApp } from "./helpers/portal.js";
import { ALICE, startUsersL2, type UsersL2 } from "./helpers/users.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});
async function hosted(extra: Parameters<typeof startHostedApp>[0] = {}) {
  const a = await startHostedApp(extra);
  closers.push(() => a.close());
  return a;
}
const goal = { goal: "Get the weather for Lima" };
const payerOf = (body: unknown) => String((body as { payer?: string }).payer ?? "").toLowerCase();

describe("019 US1 a desktop client's token runs at the agent and pays at L2", () => {
  it("019 US1 a person's token from the desktop client starts a run, and the run's gate carries exactly that token", async () => {
    const ports = fakePorts();
    const a = await hosted({ model: mockModel(text("done")), gate: ports.gate, settlement: ports.settlement });
    const desktop = await a.token("alice", { azp: DEV_DESKTOP_CLIENT });
    const res = await fetch(`${a.base}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${desktop}`, "content-type": "application/json" }, body: JSON.stringify(goal) });
    expect(res.status).toBe(200);
    expect(ports.gateCalls.length).toBeGreaterThan(0);
    for (const c of ports.gateCalls) expect(c.callerToken === desktop, "the gate carries the desktop token").toBe(true);
  });

  it("019 US1 L2 accepts the desktop token on budget and authorize, and the payment is that person's own", async () => {
    const l2: UsersL2 = await startUsersL2();
    closers.push(() => l2.close());
    const { address } = await l2.onboard(ALICE);
    const caller = await l2.callers.forUser(ALICE, { azp: DEV_DESKTOP_CLIENT });
    const budget = await l2.budget("sess_desktop", { caller });
    expect([budget.status, budget.body.scope, budget.body.account]).toEqual([200, "user_daily", "ready"]);
    const paid = await l2.authorize(l2.intentFor("/api/weather", "1000", { sessionId: "sess_desktop" }), { caller });
    expect([paid.body.status, payerOf(paid.body)]).toEqual(["AUTHORIZED", address.toLowerCase()]);
    expect(l2.entries("AUTHORIZED").map((e) => e.data.userId)).toEqual([ALICE]);
  });

  it("019 US1 the portal refuses the desktop client's token: it accepts its own client's tokens only", async () => {
    const portal: PortalTestApp = await startPortal();
    closers.push(() => portal.close());
    const desktop = await portal.agentToken("alice", { azp: DEV_DESKTOP_CLIENT });
    expect((await portal.call("GET", "/api/me", { token: desktop })).status).toBe(403);
  });

  it("019 US1 the docs page's client and a machine caller run as before", async () => {
    const a = await hosted({ model: mockModel(text("done")) });
    expect((await a.run("alice", goal)).status).toBe(200);
    expect((await a.run("x402-checks-dev", goal, { service: true })).status).toBe(200);
  });
});

describe("T-AGT-19 the run limits count per person, whatever client and token (019 FR-014)", () => {
  /** A model that holds every run until released, so runs stay in flight. */
  function heldModel() {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const model = mockModel(async () => {
      await held;
      return text("done");
    });
    return { model, release };
  }
  const post = (a: HostedTestApp, token: string) =>
    fetch(`${a.base}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(goal) });
  async function untilModelCalls(model: Parameters<typeof modelCalls>[0], n: number) {
    for (let i = 0; i < 200 && modelCalls(model).length < n; i++) await new Promise((r) => setTimeout(r, 10));
    expect(modelCalls(model).length).toBeGreaterThanOrEqual(n);
  }

  async function concurrentThird(extra: Parameters<typeof startHostedApp>[0] = {}) {
    const { model, release } = heldModel();
    const a = await hosted(Object.assign({ model }, extra));
    const docs = await a.token("alice");
    const desktop = await a.token("alice", { azp: DEV_DESKTOP_CLIENT });
    // Two runs through the docs page's client, held in the model.
    const held = Array.from({ length: MAX_CONCURRENT_RUNS }, () => post(a, docs));
    await untilModelCalls(model, MAX_CONCURRENT_RUNS);
    return { a, model, release, held, desktop };
  }

  it("T-AGT-19 two runs in flight through one client: a third through the other client is 429 with Retry-After", async () => {
    const { model, release, held, a, desktop } = await concurrentThird();
    try {
      const third = await post(a, desktop);
      expect([third.status, await third.json()]).toEqual([429, { error: "too many runs" }]);
      expect(third.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(modelCalls(model)).toHaveLength(MAX_CONCURRENT_RUNS);
    } finally {
      release();
      await Promise.all(held);
    }
  });

  it("T-AGT-19 starts in an hour are counted across both clients: the 21st is 429", async () => {
    const a = await hosted({ model: mockModel(text("done")) });
    const tokens = [await a.token("alice"), await a.token("alice", { azp: DEV_DESKTOP_CLIENT })];
    for (let i = 0; i < MAX_STARTS_PER_HOUR; i++) expect((await post(a, tokens[i % 2]!)).status, String(i)).toBe(200);
    for (const token of tokens) expect((await post(a, token)).status).toBe(429);
  });

  it("T-AGT-19 must fail when the limits count by client and person (limitKey): the third run, through the other client, starts", async () => {
    const { model, release, held, a, desktop } = await concurrentThird({ limitKey: (r) => `${r.client}|${r.key}` });
    try {
      const third = post(a, desktop);
      await untilModelCalls(model, MAX_CONCURRENT_RUNS + 1);
      release();
      expect((await third).status).toBe(200);
    } finally {
      release();
      await Promise.all(held);
    }
  });
});

// The dev issuer's two person clients are the ones the helpers' lists hold.
it("019 the test helpers accept both dev clients", async () => {
  const a = await hosted();
  expect(a.config.auth.clientIds).toEqual([DEV_AGENT_CLIENT, DEV_DESKTOP_CLIENT]);
});
