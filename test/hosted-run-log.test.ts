// 019 — T-AGT-20 the client in the run log (SPEC L1-6 logs, SEC-16; specs/019 FR-023, NFR-003). Each step and run line
// names the client the caller's token was issued to, beside the requester, the run, the session and, for a payment,
// the authorization. A known-value scan finds no token in the log, the JSON answer or a stream. 021: the run line says
// which mode the run used, and a search step's line has its outcome and the number of results, never the query, a
// listing's text or an address.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_AGENT_CLIENT, DEV_DESKTOP_CLIENT, DEV_MACHINE_CLIENT } from "../scripts/dev-issuer-lib.js";
import { listing, startDiscoveryStub } from "./helpers/discovery-stub.js";
import { fakePorts, mockModel, startHostedApp, text, toolCall, type HostedTestApp } from "./helpers/hosted.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A seller whose one route asks for a payment, so a run's step reaches L2's authorize (the fake answers DENIED). */
async function payingSeller(): Promise<string> {
  const app = express();
  app.get("/api/report", (req, res) => {
    const url = `http://${req.headers.host}/api/report`;
    const requirement = { scheme: "exact", network: "eip155:31337", asset: "0xasset", amount: "1000", payTo: "0xpayto", maxTimeoutSeconds: 120 };
    res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({ x402Version: 2, resource: { url }, accepts: [requirement] } as never)).json({});
  });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function start(): Promise<{ a: HostedTestApp; lines: string[] }> {
  const seller = await payingSeller();
  const ports = fakePorts();
  // Each run: buy the report, read the budget, answer.
  const model = mockModel(async (opts) => {
    const turns = opts.prompt.filter((m) => m.role === "tool").length;
    if (turns === 0) return toolCall("fetch_resource", { url: `${seller}/api/report`, purpose: "the report" });
    if (turns === 1) return toolCall("check_budget", {});
    return text("done");
  });
  const lines: string[] = [];
  // Object.assign, not a spread: the model's type is too large a union to spread (TS2590, @mastra/core 1.83).
  const a = await startHostedApp(Object.assign({ model, gate: ports.gate, settlement: ports.settlement, log: (line: string) => lines.push(line), env: { SELLER_URL: seller } }));
  closers.push(() => a.close());
  return { a, lines };
}

async function post(a: HostedTestApp, token: string, stream = false): Promise<string> {
  const res = await fetch(`${a.base}/v1/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(stream && { accept: "text/event-stream" }) },
    body: JSON.stringify({ goal: "Buy the report" }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe("T-AGT-20 the run log names each run's client, and no token is written (019 FR-023, NFR-003)", () => {
  it("T-AGT-20 a desktop run, a docs page run and a machine caller's run: each line names its token's client, beside the run's identifiers", async () => {
    const { a, lines } = await start();
    const tokens = {
      [DEV_DESKTOP_CLIENT]: await a.token("alice", { azp: DEV_DESKTOP_CLIENT }),
      [DEV_AGENT_CLIENT]: await a.token("alice"),
      [DEV_MACHINE_CLIENT]: await a.token(DEV_MACHINE_CLIENT, { service: true }),
    };
    const answers: string[] = [];
    for (const token of Object.values(tokens)) answers.push(await post(a, token));

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => [p.event, p.client])).toEqual(
      Object.keys(tokens).flatMap((client) => [
        ["step", client],
        ["step", client],
        ["run", client],
      ]),
    );
    for (const p of parsed) expect(Object.keys(p)).toEqual(expect.arrayContaining(["runId", "requester", "client", "sessionId"]));
    // 021: these runs are in test mode, and the run line says so.
    for (const p of parsed.filter((x) => x.event === "run")) expect(p.mode).toBe("test");
    // The payment step names its authorization; the run lines tie each run to its requester.
    for (const p of parsed.filter((x) => x.tool === "fetch_resource")) expect(p).toMatchObject({ outcome: "DENIED", authorizationId: "auth_fake" });
    const runs = parsed.filter((p) => p.event === "run");
    expect(runs.map((p) => p.requester)).toEqual(["urn:x402:dev-issuer:dev|alice", "urn:x402:dev-issuer:dev|alice", `urn:x402:dev-issuer:${DEV_MACHINE_CLIENT}@clients`]);
    expect(new Set(runs.map((p) => p.runId)).size).toBe(3);

    // A stream of the desktop run, then the known-value scan of everything written or sent.
    answers.push(await post(a, tokens[DEV_DESKTOP_CLIENT]!, true));
    const written = { log: lines.join("\n"), answers: answers.join("\n") };
    for (const [where, content] of Object.entries(written)) {
      for (const token of Object.values(tokens)) expect(content.includes(token), `a token is in the ${where}`).toBe(false);
      expect(/eyJ[A-Za-z0-9_-]+\.eyJ/.test(content), `a JWT-shaped value is in the ${where}`).toBe(false);
    }
  });
});

describe("T-AGT-20 021: the run line's mode, and a search step's line", () => {
  it("T-AGT-20 a search-mode run: the run line says search; the search step has its outcome and count; the query, a listing's text and its address are in no line", async () => {
    const description = "planted-listing-description-31f0 for the log scan";
    const address = "https://planted-listing-host.example/api/weather";
    const index = await startDiscoveryStub({ listings: [listing("http://127.0.0.1:4021/api/weather"), listing(address, { description })] });
    closers.push(() => index.close());
    index.script({ listings: [listing("http://127.0.0.1:4021/api/weather"), listing(address, { description })] }, { status: 500 });
    const query = "planted-query-8c2e current weather for a city";
    const model = mockModel([toolCall("search_resources", { query }), toolCall("search_resources", { query: "again" }), text("done")]);
    const lines: string[] = [];
    const a = await startHostedApp(Object.assign({ model, discovery: { url: index.url }, log: (line: string) => lines.push(line) }));
    closers.push(() => a.close());
    expect(await post(a, await a.token("alice"))).toContain(description);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const run = parsed.find((p) => p.event === "run")!;
    expect(run.mode).toBe("search");
    const steps = parsed.filter((p) => p.event === "step");
    expect(steps.map((p) => [p.tool, p.outcome, p.results])).toEqual([
      ["search_resources", "ok", 2],
      ["search_resources", "unavailable", 0],
    ]);
    for (const p of steps) expect(Object.keys(p).sort()).toEqual(["client", "event", "index", "ms", "outcome", "requester", "results", "runId", "sessionId", "tool"]);
    const log = lines.join("\n");
    for (const planted of [query, "planted-query-8c2e", description, "planted-listing-description-31f0", address, "planted-listing-host.example", "again"]) expect(log, planted).not.toContain(planted);
  });
});
