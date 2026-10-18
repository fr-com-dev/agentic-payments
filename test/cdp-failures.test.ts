// Feature 009 US3 — facilitator failures never lose or miscount money (SPEC v1.2 CP-1, L3-1 step 2;
// contracts/seller-errors.md, contracts/l3-verify-amendment.md). categorize() units, T-CDP-04, T-CDP-05,
// T-CDP-06 (must-fail proof for FR-020) and T-CDP-09, against the JWT-verifying CDP stub.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicClient, http } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { FacilitatorTimeoutError, RouteConfigurationError } from "@x402/core/server";
import { cdpFacilitatorClient } from "../src/counterparty/cdp-facilitator.js";
import { categorize, facilitatorClientFor, FacilitatorUnavailableError } from "../src/counterparty/facilitator-client.js";
import { createSellerApp } from "../src/counterparty/seller.js";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../src/layer1-intent/ports-http.js";
import { PaidResourceOrchestrator } from "../src/layer1-intent/orchestrator.js";
import { ChainSettlementVerifier, type ReadOnlyChainClient } from "../src/layer3-settlement/verifier.js";
import type { FacilitatorChoice } from "../src/shared/config.js";
import type { SettlementClaim } from "../src/shared/contracts.js";
import { startHarness, type Harness } from "./helpers/harness.js";
import { startCdpStub, testEd25519Key, type CdpStub, type StubMode } from "./helpers/cdp-stub.js";

const cdpChoice = (url: string): FacilitatorChoice => ({ kind: "cdp", url, timeoutMs: 30_000, authenticated: true });

describe("T-CDP-04 categorize() (research R4)", () => {
  const cases: Array<[string, unknown, string]> = [
    ["a facilitator timeout", new FacilitatorTimeoutError("verify", 500), "unavailable"],
    ["a fetch TypeError", new TypeError("fetch failed"), "unavailable"],
    ["a connection refusal in the cause chain", new Error("x", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }), "unavailable"],
    ["401", new Error("Facilitator verify failed (401): unauthorized"), "authentication"],
    ["403", new Error("Facilitator settle failed (403): forbidden"), "authentication"],
    ["429", new Error("Facilitator getSupported failed (429): slow down"), "rate-limited"],
    ["402 (quota or billing)", new Error("Facilitator verify failed (402): quota"), "rate-limited"],
    ["503", new Error("Facilitator verify failed (503): down"), "unavailable"],
    ["a route configuration error", new RouteConfigurationError([]), "unsupported"],
    ["a nested status two causes deep", new Error("Failed to initialize", { cause: new Error("wrap", { cause: new Error("Facilitator getSupported failed (401): x") }) }), "authentication"],
    ["a categorized error", new FacilitatorUnavailableError("rate-limited", "settle"), "rate-limited"],
    ["anything else", "boom", "unavailable"],
  ];
  for (const [name, err, category] of cases) {
    it(`T-CDP-04 categorize: ${name} → ${category}`, () => {
      expect(categorize(err)).toBe(category);
    });
  }
});

interface Exchange {
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody: string;
  status: number;
  resHeaders: Headers;
  resBody: string;
}

/** Records every in-process fetch (pass-through), so seller responses to L1 can be inspected. */
function recordFetch(): { exchanges: Exchange[]; restore(): void } {
  const exchanges: Exchange[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const res = await realFetch(input, init);
    exchanges.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      reqHeaders: Object.fromEntries(new Headers(init?.headers).entries()),
      reqBody: typeof init?.body === "string" ? init.body : "",
      status: res.status,
      resHeaders: res.headers,
      resBody: await res.clone().text(),
    });
    return res;
  });
  return { exchanges, restore: () => spy.mockRestore() };
}

describe("T-CDP-04..T-CDP-09 against the CDP stub", () => {
  const key = testEd25519Key();
  const cred = { apiKeyId: key.apiKeyId, apiKeySecret: key.apiKeySecret };
  let h: Harness;
  let stub: CdpStub;

  beforeAll(async () => {
    h = await startHarness({
      sellerFacilitator: async (inner) => {
        stub = await startCdpStub({ publicKey: key.publicKey, apiKeyId: key.apiKeyId, innerUrl: inner });
        return facilitatorClientFor(cdpChoice(stub.baseUrl), { cdp: cdpFacilitatorClient(cred, { baseUrl: stub.baseUrl }) });
      },
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await stub?.close();
  });

  const orchestrator = (sessionId: string) =>
    new PaidResourceOrchestrator({
      gate: new HttpAuthorizationGate(h.urls.control, h.tokens.control),
      settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
      sessionId,
    });

  const budget = async (sessionId: string) => {
    const res = await fetch(`${h.urls.control}/v1/budget/${sessionId}`, { headers: { authorization: `Bearer ${h.tokens.control}` } });
    return (await res.json()) as { spentOrReservedAtomic: string };
  };

  const effectiveStatus = (authorizationId: string) =>
    h
      .ledgerEntries()
      .filter((e) => e.type === "SETTLEMENT" && e.authorizationId === authorizationId && (e.data as { anomaly?: boolean }).anomaly !== true)
      .map((e) => (e.data as { status: string }).status)
      .at(-1);

  const authorizedCount = () => h.ledgerEntries().filter((e) => e.type === "AUTHORIZED").length;

  /** A fresh, unsynced seller in front of the stub. */
  async function freshSeller(timeoutMs = 30_000): Promise<{ url: string; close(): Promise<void> }> {
    const app = createSellerApp({
      net: h.net,
      payTo: h.addresses.payTo,
      facilitator: facilitatorClientFor(cdpChoice(stub.baseUrl), { cdp: cdpFacilitatorClient(cred, { baseUrl: stub.baseUrl, timeoutMs }) }),
    });
    const server: Server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  }

  const preChallenge: Array<[StubMode, string]> = [
    ["401", "authentication"],
    ["429", "rate-limited"],
    ["500", "unavailable"],
    ["hang", "unavailable"],
    ["unsupported", "unsupported"],
  ];
  for (const [mode, category] of preChallenge) {
    it(`T-CDP-04 stub ${mode} before any challenge → 503 {category: ${category}}, catalog 200, nothing authorized`, async () => {
      const silence = vi.spyOn(console, "error").mockImplementation(() => {});
      const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
      stub.setMode(mode);
      const seller = await freshSeller(500);
      const before = authorizedCount();
      try {
        const res = await fetch(`${seller.url}/api/market-brief`);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: `facilitator ${category}`, category });
        expect((await fetch(`${seller.url}/api/catalog`)).status).toBe(200);
        const r = await orchestrator(`sess_cdp04_${mode}`).fetchPaid(`${seller.url}/api/weather?city=Lima`, "probe");
        expect(r.outcome).toBe("FREE");
        expect(r.httpStatus).toBe(503);
        expect(authorizedCount()).toBe(before);
      } finally {
        stub.setMode("ok");
        await seller.close();
        silence.mockRestore();
        quiet.mockRestore();
      }
    }, 30_000);
  }

  it("T-CDP-05 compliance decline during the paid retry → 402 with the reason; PAYMENT_FAILED; NOT_SETTLED; amount stays committed", async () => {
    stub.setMode("ok");
    const rec = recordFetch();
    try {
      stub.setMode("decline");
      const r = await orchestrator("sess_cdp05a").fetchPaid(`${h.urls.seller}/api/weather?city=Quito`, "decline");
      expect(r.outcome).toBe("PAYMENT_FAILED");
      expect(r.httpStatus).toBe(402);
      expect(r.payment?.settlement?.status).toBe("NOT_SETTLED");
      const paidRetry = rec.exchanges.find((x) => x.url.startsWith(h.urls.seller) && x.reqHeaders["payment-signature"]);
      expect(paidRetry?.status).toBe(402);
      const challenge = paidRetry!.resHeaders.get("PAYMENT-REQUIRED");
      const evidence = (challenge ? JSON.stringify(decodePaymentRequiredHeader(challenge)) : "") + paidRetry!.resBody;
      expect(evidence).toContain("compliance_declined");
      expect((await budget("sess_cdp05a")).spentOrReservedAtomic).toBe("1000"); // SEC-9: committed until validBefore
    } finally {
      stub.setMode("ok");
      rec.restore();
    }
  }, 60_000);

  it("T-CDP-05 an auth failure during the paid retry → 502 {error: facilitator authentication}; not served; PAYMENT_FAILED", async () => {
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    const rec = recordFetch();
    try {
      await fetch(`${h.urls.seller}/api/weather?city=Lima`); // the seller is synced before the failure starts
      stub.setMode("401");
      const r = await orchestrator("sess_cdp05b").fetchPaid(`${h.urls.seller}/api/weather?city=Puno`, "auth failure");
      expect(r.outcome).toBe("PAYMENT_FAILED");
      expect(r.httpStatus).toBe(502);
      expect(r.body).toBeUndefined();
      const paidRetry = rec.exchanges.find((x) => x.url.startsWith(h.urls.seller) && x.reqHeaders["payment-signature"]);
      expect(paidRetry?.status).toBe(502);
      expect(JSON.parse(paidRetry!.resBody)).toEqual({ error: "facilitator authentication" });
    } finally {
      stub.setMode("ok");
      rec.restore();
      silence.mockRestore();
    }
  }, 60_000);

  it("T-CDP-06 failure claim with a settled hash is CONFIRMED (fails without FR-020)", async () => {
    const rec = recordFetch();
    let claim: SettlementClaim;
    try {
      stub.setMode("pending");
      const payee0 = await h.balanceOf(h.addresses.payTo);
      const r = await orchestrator("sess_cdp06").fetchPaid(`${h.urls.seller}/api/weather?city=Cusco`, "pending");

      const paidRetry = rec.exchanges.find((x) => x.url.startsWith(h.urls.seller) && x.reqHeaders["payment-signature"]);
      expect(paidRetry?.status).toBe(402);
      const settle = decodePaymentResponseHeader(paidRetry!.resHeaders.get("PAYMENT-RESPONSE")!);
      expect(settle).toMatchObject({ success: false, errorReason: "settlement_pending" });
      expect(settle.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);

      expect(r.outcome).toBe("PAYMENT_FAILED"); // paid but not served (EXT-9 territory)
      expect(r.payment?.settlement?.status).toBe("CONFIRMED");
      expect(effectiveStatus(r.authorizationId!)).toBe("CONFIRMED");
      expect((await budget("sess_cdp06")).spentOrReservedAtomic).toBe("1000");
      expect((await h.balanceOf(h.addresses.payTo)) - payee0).toBe(1000n);

      claim = JSON.parse(rec.exchanges.find((x) => x.url.endsWith("/v1/settlements"))!.reqBody) as SettlementClaim;
    } finally {
      stub.setMode("ok");
      rec.restore();
    }

    // Must-fail proof: the same claim through v1.1 behavior is NOT_SETTLED, so the budget would under-count.
    const publicClient = createPublicClient({ transport: http(h.net.rpcUrl) }) as unknown as ReadOnlyChainClient;
    const v11 = new ChainSettlementVerifier({ publicClient, net: h.net, waitMs: 5_000, pollMs: 100, verifyFailedClaims: false });
    const v12 = new ChainSettlementVerifier({ publicClient, net: h.net, waitMs: 5_000, pollMs: 100 });
    expect((await v11.verify(claim)).status).toBe("NOT_SETTLED");
    expect((await v12.verify(claim)).status).toBe("CONFIRMED");
  }, 60_000);

  it("T-CDP-09 after an outage the next priced request succeeds without a restart", async () => {
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub.setMode("500");
    const seller = await freshSeller();
    try {
      const down = await fetch(`${seller.url}/api/market-brief`);
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ error: "facilitator unavailable", category: "unavailable" });
      stub.setMode("ok");
      const up = await fetch(`${seller.url}/api/market-brief`);
      expect(up.status).toBe(402);
      expect(decodePaymentRequiredHeader(up.headers.get("PAYMENT-REQUIRED")!).accepts).toHaveLength(1);
    } finally {
      stub.setMode("ok");
      await seller.close();
      silence.mockRestore();
      quiet.mockRestore();
    }
  }, 30_000);
});
