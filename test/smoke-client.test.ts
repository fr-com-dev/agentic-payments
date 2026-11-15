// 016 — the smoke client (SPEC §3.1 Azure profile v1.17, SEC-33; specs/016 research R9): the deployment pipeline's
// hosted smoke run as a machine caller. T-AGT-13: against a fake agent, it passes only for a completed run that paid
// and confirmed both purchases with no escalation inside the time; it prefers the candidate revision while one
// answers; and it never prints the token.
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { runSmoke, SMOKE_GOAL, smokeFailure } from "../src/smoke-main.js";
import { REFUSAL } from "../src/refusal.js";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.planted-smoke-token.signature-9f2c";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const paid = (path: string) => ({ index: 1, tool: "fetch_resource", url: `https://seller.example${path}`, result: { outcome: "PAID", payment: { settlement: { status: "CONFIRMED" } } } });
const GOOD = { runId: "run_1", status: "completed", steps: [{ index: 1, tool: "fetch_resource", url: "https://seller.example/api/catalog", result: { outcome: "FREE" } }, paid("/api/weather?city=Lima"), paid("/api/market-brief")] };

/** A fake hosted agent: records each run request and answers with `answer`. `healthy: false` gives no health route. */
async function agent(answer: { status?: number; body?: unknown } = {}, o: { healthy?: boolean } = {}) {
  const requests: { authorization: string; accept: string; body: unknown }[] = [];
  const app = express();
  if (o.healthy !== false) app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.post("/v1/runs", express.json(), (req, res) => {
    requests.push({ authorization: String(req.headers.authorization), accept: String(req.headers.accept), body: req.body });
    res.status(answer.status ?? 200).json("body" in answer ? answer.body : GOOD);
  });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const token = async () => TOKEN;

describe("T-AGT-13 the smoke client: the pipeline's hosted smoke run as a machine caller (016 FR-023, SEC-33)", () => {
  it("T-AGT-13 it sends the smoke goal with its token, asks for the JSON answer, and passes for a completed run that paid and confirmed both purchases", async () => {
    const a = await agent();
    const r = await runSmoke({ agentUrl: `${a.url}/`, token });
    expect(r).toEqual({ ok: true, target: a.url, seconds: expect.any(Number) });
    expect(a.requests).toEqual([{ authorization: `Bearer ${TOKEN}`, accept: "application/json", body: { goal: SMOKE_GOAL } }]);
  });

  it.each<[string, number, unknown, string]>([
    ["the agent refuses the caller", 403, { error: "forbidden" }, "the agent answered HTTP 403"],
    ["the run stopped", 200, { ...GOOD, status: "stopped" }, "the run ended as stopped"],
    ["the run failed", 200, { ...GOOD, status: "failed" }, "the run ended as failed"],
    ["the weather was not bought", 200, { ...GOOD, steps: [paid("/api/market-brief")] }, "/api/weather was not paid and confirmed"],
    ["the brief was paid and not confirmed", 200, { ...GOOD, steps: [paid("/api/weather"), { ...paid("/api/market-brief"), result: { outcome: "PAID", payment: { settlement: { status: "PENDING" } } } }] }, "/api/market-brief was not paid and confirmed"],
    ["the brief was denied", 200, { ...GOOD, steps: [paid("/api/weather"), { url: "https://seller.example/api/market-brief", result: { outcome: "DENIED" } }] }, "/api/market-brief was not paid and confirmed"],
    ["a purchase escalated", 200, { ...GOOD, steps: [...GOOD.steps, { url: "https://seller.example/api/premium-report", result: { outcome: "ESCALATED" } }] }, "a purchase escalated"],
    ["the answer is not a run", 200, null, "the agent's answer was not a run"],
    ["there are no steps", 200, { status: "completed" }, "/api/weather was not paid and confirmed"],
  ])("T-AGT-13 it fails when %s", async (_name, status, body, reason) => {
    expect(smokeFailure(status, body)).toBe(reason);
    const a = await agent({ status, body });
    expect(await runSmoke({ agentUrl: a.url, token })).toMatchObject({ ok: false, reason });
  });

  it("T-AGT-13 it fails a run that took longer than the target, and one it could not send", async () => {
    const a = await agent();
    let now = 0;
    // The clock moves 130 s between the start and the answer.
    const slow = await runSmoke({ agentUrl: a.url, token, now: () => (now += 130_000) });
    expect(slow).toMatchObject({ ok: false, reason: expect.stringMatching(/^the run took \d+ s, over 120 s$/) });
    expect(smokeFailure(200, GOOD)).toBeUndefined();
    expect(await runSmoke({ agentUrl: "http://127.0.0.1:1", token })).toMatchObject({ ok: false, reason: "the agent could not be reached" });
    const noToken = await runSmoke({ agentUrl: a.url, token: async () => Promise.reject(new Error("machine caller: the sign-in tenant refused the token request (HTTP 401)")) });
    expect(noToken).toMatchObject({ ok: false, reason: "machine caller: the sign-in tenant refused the token request (HTTP 401)" });
    expect(a.requests).toHaveLength(1);
  });

  it("T-AGT-13 it checks the candidate revision while one answers, and the agent's own address otherwise", async () => {
    const stable = await agent();
    const candidate = await agent();
    expect((await runSmoke({ agentUrl: stable.url, candidateUrl: candidate.url, token })).target).toBe(candidate.url);
    expect([stable.requests.length, candidate.requests.length]).toEqual([0, 1]);
    // No candidate label right now: its address does not answer, or answers without the health route.
    expect((await runSmoke({ agentUrl: stable.url, candidateUrl: "http://127.0.0.1:1", token })).target).toBe(stable.url);
    const notAnAgent = await agent({}, { healthy: false });
    expect((await runSmoke({ agentUrl: stable.url, candidateUrl: notAnAgent.url, token })).target).toBe(stable.url);
    expect((await runSmoke({ agentUrl: stable.url, candidateUrl: "", token })).target).toBe(stable.url);
    expect(stable.requests).toHaveLength(3);
  });

  /** Runs the entry point as the job does, with only the given variables. */
  function runEntry(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/smoke-main.ts"], { env: { PATH: process.env.PATH ?? "", ENV_FILE: "", ...env } });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("exit", (code) => done({ code, out }));
    });
  }

  it("T-AGT-13 the entry point exits 0 or 1 on the outcome, prints the target, the time and the reason, and never the token", async () => {
    const good = await agent();
    const ok = await runEntry({ NETWORK: "local", AGENT_URL: good.url, CALLER_TOKEN: TOKEN });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(new RegExp(`^smoke: ${good.url} \\d+s \\(target: 120 s\\) ok$`, "m"));
    const bad = await agent({ body: { ...GOOD, status: "failed", error: `model said ${TOKEN}` } });
    const failed = await runEntry({ NETWORK: "local", AGENT_URL: bad.url, CALLER_TOKEN: TOKEN });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("failed: the run ended as failed");
    for (const out of [ok.out, failed.out]) {
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain("planted-smoke-token");
    }
  }, 30_000);

  it("T-AGT-13 the entry point refuses to start without an agent address or a caller, and when the payer key is visible (INV-3)", async () => {
    const a = await agent();
    const noAgent = await runEntry({ NETWORK: "local", CALLER_TOKEN: TOKEN });
    expect([noAgent.code, noAgent.out.trim()]).toEqual([1, "smoke: AGENT_URL is required (the hosted agent's address)"]);
    const noCaller = await runEntry({ NETWORK: "local", AGENT_URL: a.url });
    expect([noCaller.code, noCaller.out.trim()]).toEqual([1, "smoke: MACHINE_CLIENT_ID is required (the machine caller's client), or locally CALLER_TOKEN"]);
    const withKey = await runEntry({ NETWORK: "local", AGENT_URL: a.url, CALLER_TOKEN: TOKEN, PAYER_PRIVATE_KEY: `0x${"11".repeat(32)}` });
    expect([withKey.code, withKey.out.trim()]).toEqual([1, REFUSAL]);
    expect(a.requests).toHaveLength(0);
  }, 30_000);
});
