// 011 hosted agent service: run semantics (SPEC.md L1-6; specs/011 contracts/hosted-agent-api.md, T-AGT-05).
// Response shape, deadline, step limit, body limits, readiness and failure handling.
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { findSecretShapes } from "../scripts/secret-scan-lib.js";
import { fakePorts, mockModel, startHostedApp, text, toolCall, type HostedTestApp } from "./helpers/hosted.js";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function hosted(...args: Parameters<typeof startHostedApp>): Promise<HostedTestApp> {
  const a = await startHostedApp(...args);
  cleanups.push(() => a.close());
  return a;
}

/** A free seller: /api/catalog at once, /api/slow after `slowMs`. */
async function seller(slowMs = 1000): Promise<string> {
  const app = express();
  app.get("/api/catalog", (_req, res) => res.json({ items: ["weather"] }));
  app.get("/api/slow", (_req, res) => {
    setTimeout(() => res.json({ slow: true }), slowMs);
  });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("T-AGT-05 run", () => {
  it("a completed run returns the documented 200 shape", async () => {
    const s = await seller();
    const model = mockModel([toolCall("fetch_resource", { url: `${s}/api/catalog`, purpose: "read the catalog" }), text("Receipts: none")]);
    const a = await hosted({ model, env: { SELLER_URL: s } });
    const r = await a.run("alice", { goal: "what is for sale?" });
    expect(r.status).toBe(200);
    expect(r.body.runId).toMatch(/^run_[0-9a-f-]{36}$/);
    expect(r.body.sessionRef).toMatch(/^sr1\.sess_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(r.body).toMatchObject({ status: "completed", stopReason: null, error: null, finalText: "Receipts: none" });
    expect(r.body.steps).toEqual([
      {
        index: 1,
        tool: "fetch_resource",
        url: `${s}/api/catalog`,
        purpose: "read the catalog",
        result: expect.objectContaining({ outcome: "FREE", httpStatus: 200, body: { items: ["weather"] }, payment: null }),
      },
    ]);
    expect(Date.parse(String(r.body.startedAt))).toBeLessThanOrEqual(Date.parse(String(r.body.finishedAt)));
  });

  it("the deadline stops the run before its next step; the fetch in progress completes and is listed", async () => {
    const s = await seller(1000);
    const model = mockModel([toolCall("fetch_resource", { url: `${s}/api/slow`, purpose: "slow" }), text("never reached")]);
    const a = await hosted({ model, deadlineMs: 300, env: { SELLER_URL: s } });
    const r = await a.run("alice", { goal: "slow" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "stopped", stopReason: "deadline" });
    expect(r.body.steps).toEqual([expect.objectContaining({ index: 1, tool: "fetch_resource", result: expect.objectContaining({ outcome: "FREE", body: { slow: true } }) })]);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("a model that always calls a tool stops at the step limit", async () => {
    const model = mockModel(async () => toolCall("check_budget", {}));
    const a = await hosted({ model });
    const r = await a.run("alice", { goal: "loop" });
    expect(r.body).toMatchObject({ status: "stopped", stopReason: "step_limit" });
    expect(r.body.steps).toHaveLength(10);
  });

  it("the body is validated before any model call: missing, empty, too long or unknown fields → 400; over 16 KB → 413", async () => {
    const model = mockModel();
    const a = await hosted({ model });
    for (const body of [{}, { goal: "" }, { goal: "   " }, { goal: "x".repeat(4001) }, { goal: "ok", extra: 1 }, { goal: 42 }, "not json"]) {
      expect((await a.run("alice", body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await a.run("alice", { goal: "x".repeat(17 * 1024) })).status).toBe(413);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await a.run("alice", { goal: "x".repeat(4000) })).status).toBe(200);
  });

  it("/readyz answers 503 until startup completes, then 200; /healthz answers at once", async () => {
    const a = await hosted({ ready: false });
    const get = async (p: string) => {
      const res = await fetch(a.base + p);
      return { status: res.status, body: await res.json() };
    };
    expect(await get("/readyz")).toEqual({ status: 503, body: { status: "starting" } });
    expect(await get("/healthz")).toEqual({ status: 200, body: { status: "ok" } });
    a.markReady();
    expect(await get("/readyz")).toEqual({ status: 200, body: { status: "ready" } });
  });

  it("a model failure ends the run as failed and still lists the steps finished before it", async () => {
    const s = await seller();
    let n = 0;
    const model = mockModel(async () => {
      if (n++ === 0) return toolCall("fetch_resource", { url: `${s}/api/catalog`, purpose: "read the catalog" });
      throw new Error("model unavailable");
    });
    const a = await hosted({ model, env: { SELLER_URL: s } });
    const r = await a.run("alice", { goal: "read the catalog" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "failed", stopReason: null });
    expect(String(r.body.error)).toContain("model unavailable");
    expect(r.body.steps).toEqual([expect.objectContaining({ index: 1, tool: "fetch_resource", result: expect.objectContaining({ outcome: "FREE" }) })]);
  });
});

// ---------------------------------------------------------------------------
// T-AGT-05 secret shapes (US6, SEC-16): the patterns the cloud log scan uses
// ---------------------------------------------------------------------------

describe("T-AGT-05 secret shapes", () => {
  it.each([
    ["JWT", "token eyJhbGciOiJFUzI1NiJ9.eyJvaWQiOiJhIn0.c2lnbmF0dXJl"],
    ["bearer token", "authorization: Bearer abcdefghijklmnop0123"],
    ["PEM private key", "-----BEGIN EC PRIVATE KEY-----"],
    ["payment signature header", '{"PAYMENT-SIGNATURE":"eyJ..."}'],
    ["API key header", "x-api-key: sk-ant-123"],
    ["secret assignment", "PAYER_PRIVATE_KEY=0xabc"],
    ["secret assignment", "SESSION_REF_SECRET=deadbeef"],
    ["secret assignment", "CONTROL_TOKEN=dev-control-token"],
  ])("finds a %s", (name, text) => {
    expect(findSecretShapes(text)).toContain(name);
  });

  it("ignores what legitimately appears in logs: transaction hashes, IDs, statuses, header names alone", () => {
    const clean = [
      `tx=0x${"ab".repeat(32)}`,
      "authorizationId=auth_009b55fe-307f-43ea-9014-a50e72f5576c sessionId=sess_0123456789abcdef",
      '{"event":"step","outcome":"PAID","status":"CONFIRMED"}',
      "l2-control: 401 unauthorized for /v1/escalations",
      "PAYMENT-REQUIRED header decoded",
      "--env-vars OPERATOR_TOKEN=secretref:operator-token",
    ].join("\n");
    expect(findSecretShapes(clean)).toEqual([]);
  });

  it("scan-logs exits 1 naming the pattern on a hit and 0 on clean input, never echoing the text", async () => {
    const run = (input: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", "scripts/scan-logs.ts"], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.stderr.on("data", (d) => (out += String(d)));
        child.on("close", (code) => resolve({ code, out }));
        child.stdin.end(input);
      });
    const hit = await run("ok line\nauthorization: Bearer abcdefghijklmnop0123\n");
    expect(hit.code).toBe(1);
    expect(hit.out).toContain("line 2: bearer token");
    expect(hit.out).not.toContain("abcdefghijklmnop0123");
    expect((await run("all fine\n")).code).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// T-AGT-05 logs (US7, FR-025, FR-026): whitelisted JSON lines; planted secrets never appear
// ---------------------------------------------------------------------------

describe("T-AGT-05 logs", () => {
  const STEP_KEYS = ["event", "runId", "requester", "sessionId", "index", "tool", "outcome", "intentId", "authorizationId", "ms"];
  const RUN_KEYS = ["event", "runId", "requester", "sessionId", "status", "stopReason", "steps", "ms"];

  it("every line is JSON with only whitelisted keys, and no planted value appears in any line", async () => {
    const s = await seller();
    const lines: string[] = [];
    const planted = {
      control: "planted-control-token-0001",
      verifier: "planted-verifier-token-0002",
      secret: "cd".repeat(32),
      goal: "planted-goal-text-0003",
      purpose: "planted-purpose-0004",
      toolError: "planted-tool-error-token-0005",
    };
    const ports = fakePorts({
      budget: async () => {
        throw new Error(`budget failed: Bearer ${planted.toolError}`);
      },
    });
    const model = mockModel([toolCall("fetch_resource", { url: `${s}/api/catalog`, purpose: planted.purpose }), toolCall("check_budget", {}), text("done")]);
    const a = await hosted({
      model,
      gate: ports.gate,
      settlement: ports.settlement,
      log: (line) => lines.push(line),
      env: { SELLER_URL: s, CONTROL_TOKEN: planted.control, VERIFIER_TOKEN: planted.verifier, SESSION_REF_SECRET: planted.secret },
    });
    const jwt = await a.token("alice");
    const res = await fetch(`${a.base}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ goal: planted.goal }) });
    const body = (await res.json()) as { runId: string; sessionRef: string };
    const mac = body.sessionRef.split(".")[2]!;

    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => p.event)).toEqual(["step", "step", "run"]);
    for (const p of parsed) {
      const allowed = p.event === "run" ? RUN_KEYS : STEP_KEYS;
      for (const k of Object.keys(p)) expect(allowed, `unexpected log key ${k}`).toContain(k);
      expect(p.requester).toBe("urn:x402:dev-issuer:dev|alice");
      expect(p.runId).toBe(body.runId);
    }
    expect(parsed[0]).toMatchObject({ tool: "fetch_resource", outcome: "FREE", index: 1 });
    expect(parsed[1]).toMatchObject({ tool: "check_budget", outcome: "error", index: 2 });
    expect(parsed[2]).toMatchObject({ status: "completed", stopReason: null, steps: 2 });

    const all = lines.join("\n");
    for (const value of [jwt, mac, ...Object.values(planted)]) expect(all).not.toContain(value);
    expect(findSecretShapes(all)).toEqual([]);
  });
});
