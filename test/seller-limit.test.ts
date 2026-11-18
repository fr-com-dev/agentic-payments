// T-LIM-03 (SPEC v1.24, CP-1, SEC-41): the seller bounds, per client address, the requests that can reach its
// facilitator. Every request to anything but the free routes can: a payment's /verify (and /settle), or the
// /supported sync that a priced request retries while it fails, each signed with the seller's CDP credential. Before
// v1.24 anyone could replay the public challenge with a junk signature and make the seller call CDP's /verify without
// bound, until CDP throttled the key and every buyer's paid retry failed.
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { createSellerApp, MAX_PRICED_REQUESTS_PER_MINUTE, type SellerOptions } from "../src/counterparty/seller.js";
import { localTestNet } from "./helpers/local-net.js";

const NET = localTestNet();
const PAY_TO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

/** A facilitator that counts every call and rejects every payment, as CDP does a junk signature. */
function countingFacilitator() {
  const calls: string[] = [];
  const client: FacilitatorClient = {
    getSupported: async () => (calls.push("supported"), { kinds: [{ x402Version: 2, scheme: "exact", network: NET.caip2 }], extensions: [], signers: {} }) as never,
    verify: async () => (calls.push("verify"), { isValid: false, invalidReason: "invalid_signature" }) as never,
    settle: async () => (calls.push("settle"), { success: false, errorReason: "settlement_failed", transaction: "", network: NET.caip2 }) as never,
  };
  return { client, calls };
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

async function start(o: Partial<SellerOptions> = {}) {
  const f = countingFacilitator();
  const app = createSellerApp({ net: NET, payTo: PAY_TO, facilitator: f.client, ...o });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return { calls: f.calls, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The public challenge of /api/weather, replayed with a junk signature: what the attacker sends. */
async function junkPayment(base: string): Promise<string> {
  const required = decodePaymentRequiredHeader((await fetch(`${base}/api/weather`)).headers.get("payment-required")!);
  return encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource, accepted: required.accepts[0]!, payload: { signature: "0xjunk", authorization: {} } } as never);
}

const statuses = async (base: string, n: number, headers: Record<string, string> = {}) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fetch(`${base}/api/weather`, { headers })).status);
  return out;
};

describe("T-LIM-03 the seller's priced requests are bounded per address before the facilitator (SEC-41)", () => {
  it("T-LIM-03 beyond the bound: 429 with Retry-After, and no facilitator call", async () => {
    const { base, calls } = await start({ maxPricedRequestsPerAddress: 4 });
    const payment = await junkPayment(base); // request 1: the challenge
    expect(await statuses(base, 3, { "PAYMENT-SIGNATURE": payment })).toEqual([402, 402, 402]); // requests 2-4: verified, refused
    expect(calls.filter((c) => c === "verify")).toHaveLength(3);
    const beyond = await fetch(`${base}/api/weather`, { headers: { "PAYMENT-SIGNATURE": payment } });
    expect([beyond.status, await beyond.json(), Number(beyond.headers.get("retry-after")) > 0]).toEqual([429, { error: "too many requests" }, true]);
    expect(await statuses(base, 20, { "PAYMENT-SIGNATURE": payment })).toEqual(Array(20).fill(429));
    expect(calls.filter((c) => c === "verify")).toHaveLength(3); // nothing more reached the facilitator
  });

  it("T-LIM-03 every priced route shares the count; the free catalog never counts and still answers", async () => {
    const { base } = await start({ maxPricedRequestsPerAddress: 2 });
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/api/catalog`)).status).toBe(200);
    expect((await fetch(`${base}/api/weather`)).status).toBe(402);
    expect((await fetch(`${base}/api/market-brief`)).status).toBe(402);
    expect((await fetch(`${base}/api/premium-report`)).status).toBe(429);
    expect((await fetch(`${base}/api/catalog`)).status).toBe(200);
  });

  it("T-LIM-03 a failing sync is retried only within the bound", async () => {
    const f = countingFacilitator();
    f.client.getSupported = async () => {
      f.calls.push("supported");
      throw new Error("Facilitator getSupported failed (503): down");
    };
    const app = createSellerApp({ net: NET, payTo: PAY_TO, facilitator: f.client, maxPricedRequestsPerAddress: 3 });
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const errors = console.error;
    console.error = () => undefined; // each failed sync logs one line
    try {
      expect(await statuses(base, 10)).toEqual([503, 503, 503, 429, 429, 429, 429, 429, 429, 429]);
    } finally {
      console.error = errors;
    }
    expect(f.calls).toEqual(["supported", "supported", "supported"]);
  });

  it("T-LIM-03 behind the ingress (TRUSTED_PROXY_HOPS=1) each client has its own count; without it X-Forwarded-For is ignored", async () => {
    const proxied = await start({ maxPricedRequestsPerAddress: 1, trustedProxyHops: 1 });
    const a = { "X-Forwarded-For": "203.0.113.1" };
    const b = { "X-Forwarded-For": "203.0.113.2" };
    expect([...(await statuses(proxied.base, 2, a)), ...(await statuses(proxied.base, 2, b))]).toEqual([402, 429, 402, 429]);
    const direct = await start({ maxPricedRequestsPerAddress: 1 });
    expect([...(await statuses(direct.base, 1, a)), ...(await statuses(direct.base, 1, b))]).toEqual([402, 429]);
  });

  it("T-LIM-03 must-fail: without the bound, every replayed junk payment reaches the facilitator", async () => {
    const { base, calls } = await start({ maxPricedRequestsPerAddress: 4, skipAddressLimit: true });
    const payment = await junkPayment(base);
    expect(await statuses(base, 30, { "PAYMENT-SIGNATURE": payment })).toEqual(Array(30).fill(402));
    expect(calls.filter((c) => c === "verify")).toHaveLength(30);
  });

  it("T-LIM-03 the default bound is 600 a minute, and the seller refuses a TRUSTED_PROXY_HOPS other than 0 or 1", async () => {
    expect(MAX_PRICED_REQUESTS_PER_MINUTE).toBe(600);
    const { base } = await start();
    const first = await statuses(base, MAX_PRICED_REQUESTS_PER_MINUTE);
    expect(first.every((s) => s === 402)).toBe(true);
    expect(await statuses(base, 1)).toEqual([429]);
    const r = spawnSync("node_modules/.bin/tsx", ["src/counterparty/seller.ts"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: "/dev/null", NETWORK: "local", SELLER_PAY_TO: PAY_TO, TRUSTED_PROXY_HOPS: "2" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect([r.status, r.stderr.trim()]).toEqual([1, "seller: TRUSTED_PROXY_HOPS must be 0 or 1"]);
  }, 60_000);
});
