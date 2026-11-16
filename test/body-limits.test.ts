// L2's request bodies (SPEC.md §8.2 L2-5; T-BODY-01..02). Every route that takes a body checks its token first,
// reads at most 16 KB of JSON (the payment request 256 KB) as sent, never inflates a compressed body, and answers a
// body it can't read with a fixed JSON message, never Express's default handler.
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody } from "../src/layer2-control/json-body.js";
import { AuditLedger } from "../src/layer2-control/ledger.js";
import { buildMandate } from "../src/layer2-control/mandate.js";
import { createControlService } from "../src/layer2-control/service.js";
import type { PaymentSignerLike } from "../src/layer2-control/signer.js";

const CAIP2 = "eip155:31337";
const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const PAYER = "0x00000000000000000000000000000000000000f1";
const TOKENS = { control: "t-control", settlement: "t-settlement", operator: "t-operator" };
const KB = 1024;

const fakeSigner: PaymentSignerLike = {
  address: PAYER,
  sign: async () => ({ headers: { "PAYMENT-SIGNATURE": "opaque" }, payer: PAYER, validBefore: Math.floor(Date.now() / 1000) + 120 }),
};

/** The routes that read a body with the 16 KB limit, with the token each one accepts. */
const ROUTES = [
  { path: "/v1/reconcile", token: TOKENS.settlement },
  { path: "/v1/approvals/esc_unknown", token: TOKENS.operator },
  { path: "/v1/rejections/esc_unknown", token: TOKENS.operator },
] as const;

/** A JSON object of about `bytes` bytes. */
const padded = (bytes: number) => JSON.stringify({ approver: "ops", pad: "a".repeat(bytes) });

let dir: string;
let servers: Server[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "body-limits-"));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startL2() {
  const mandate = buildMandate(
    {
      mandateId: "mandate-body-limits",
      expiresAt: "2027-12-31T23:59:59Z",
      allowedSchemes: ["exact"],
      allowedPayees: ["0xcccccccccccccccccccccccccccccccccccccccc"],
      allowedHosts: ["127.0.0.1:4021"],
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      dailyBudgetAtomic: "500000",
      maxAuthorizationsPerMinute: 10,
      maxTimeoutSeconds: 300,
    },
    { caip2: CAIP2, asset: ASSET },
  );
  const ledger = new AuditLedger(join(dir, ".local", "ledger-local.jsonl"));
  const { app } = createControlService({ mandate, signer: fakeSigner, ledger, asset: { address: ASSET, decimals: 6 }, tokens: TOKENS });
  return { base: await listen(app), ledger };
}

async function post(url: string, body: string | Buffer, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : new Uint8Array(body) });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", text };
}

describe("T-BODY-01 L2 checks a route's token before it reads the body", () => {
  it("T-BODY-01 an oversized body without the route's token gets 401, never 413, and nothing is appended", async () => {
    const { base, ledger } = await startL2();
    for (const r of ROUTES) {
      for (const authorization of [undefined, "Bearer t-control", "Bearer wrong"]) {
        const out = await post(`${base}${r.path}`, padded(64 * KB), authorization === undefined ? {} : { authorization });
        expect(out.status, `${r.path} with ${authorization ?? "no token"}`).toBe(401);
        expect(JSON.parse(out.text)).toEqual({ error: "unauthorized" });
      }
    }
    expect(ledger.entries()).toHaveLength(0);
  });
});

describe("T-BODY-02 L2 reads at most 16 KB of JSON, as sent", () => {
  it("T-BODY-02 over 16 KB is 413 and a compressed body is 415, each with a fixed JSON answer; nothing is appended", async () => {
    const { base, ledger } = await startL2();
    for (const r of ROUTES) {
      const auth = { authorization: `Bearer ${r.token}` };
      const big = await post(`${base}${r.path}`, padded(17 * KB), auth);
      expect([big.status, big.type.startsWith("application/json"), JSON.parse(big.text)], r.path).toEqual([413, true, { error: "request body refused" }]);
      expect(big.text).not.toContain("aaaa");

      const zipped = await post(`${base}${r.path}`, gzipSync(JSON.stringify({ approver: "ops" })), { ...auth, "content-encoding": "gzip" });
      expect([zipped.status, JSON.parse(zipped.text)], r.path).toEqual([415, { error: "request body refused" }]);

      const broken = await post(`${base}${r.path}`, '{"approver":', auth);
      expect([broken.status, JSON.parse(broken.text)], r.path).toEqual([400, { error: "malformed request body" }]);

      // Under the limit the route itself answers: 400 for a report without its fields, 404 for an unknown escalation.
      const small = await post(`${base}${r.path}`, padded(8 * KB), auth);
      expect(small.status, r.path).toBe(r.path === "/v1/reconcile" ? 400 : 404);
    }
    expect(ledger.entries()).toHaveLength(0);
  });

  it("T-BODY-02 a payment request keeps its own limit and messages, and is read as sent too", async () => {
    const { base } = await startL2();
    const auth = { authorization: `Bearer ${TOKENS.control}` };
    const zipped = await post(`${base}/v1/authorize`, gzipSync(JSON.stringify({ sessionId: "s" })), { ...auth, "content-encoding": "gzip" });
    expect([zipped.status, JSON.parse(zipped.text)]).toEqual([415, { error: "PaymentIntent body refused" }]);
    const big = await post(`${base}/v1/authorize`, padded(257 * KB), auth);
    expect([big.status, JSON.parse(big.text)]).toEqual([413, { error: "PaymentIntent body refused" }]);
  });

  it("T-BODY-02 must-fail: the parser these routes had (`express.json()`) reads both bodies", async () => {
    const read = async (parser: express.RequestHandler) => {
      const app = express();
      app.post("/x", parser, (_req, res) => {
        res.json({ ok: true });
      });
      const base = await listen(app);
      return [
        (await post(`${base}/x`, padded(17 * KB))).status,
        (await post(`${base}/x`, gzipSync(JSON.stringify({ a: 1 })), { "content-encoding": "gzip" })).status,
      ];
    };
    expect(await read(express.json())).toEqual([200, 200]);
    expect(await read(jsonBody())).toEqual([413, 415]);
  });
});
