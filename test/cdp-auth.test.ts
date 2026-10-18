// Feature 009 US1 — paid fetch through the CDP facilitator (SPEC v1.2 CP-3; contracts/cdp-facilitator-api.md).
// T-CDP-03: JWT auth headers, and the scripted plan through a JWT-verifying CDP stub on the 008 harness.
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  cdpFacilitatorClient,
  normalizeCdpSecret,
  validateCdpSecret,
  type CdpCredential,
} from "../src/counterparty/cdp-facilitator.js";
import { facilitatorClientFor } from "../src/counterparty/facilitator-client.js";
import { createSellerApp } from "../src/counterparty/seller.js";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../src/layer1-intent/ports-http.js";
import { PaidResourceOrchestrator } from "../src/layer1-intent/orchestrator.js";
import { runScriptedAgent } from "../src/layer1-intent/scripted.js";
import { ConfigError } from "../src/shared/config.js";
import { RegressionBaseline, startHarness, type Harness } from "./helpers/harness.js";
import { decodeJwt, startCdpStub, testEd25519Key, verifyJwtSignature, type CdpStub } from "./helpers/cdp-stub.js";

const CDP_BASE = "https://api.cdp.coinbase.com/platform/v2/x402";

async function bearer(cred: CdpCredential, op: "verify" | "settle" | "supported"): Promise<string> {
  const { headers } = await cdpFacilitatorClient(cred, { baseUrl: CDP_BASE }).createAuthHeaders(op);
  const value = headers.Authorization ?? "";
  expect(value.startsWith("Bearer ")).toBe(true);
  return value.slice("Bearer ".length);
}

describe("T-CDP-03 auth headers (FR-007, research R1)", () => {
  it("T-CDP-03 auth headers: an Ed25519 key yields EdDSA JWTs bound to method, host and path", async () => {
    const key = testEd25519Key();
    const cred = { apiKeyId: key.apiKeyId, apiKeySecret: key.apiKeySecret };
    const verifyJwt = await bearer(cred, "verify");
    const { header, claims } = decodeJwt(verifyJwt);
    expect(header).toMatchObject({ alg: "EdDSA", kid: key.apiKeyId, typ: "JWT" });
    expect(typeof header.nonce).toBe("string");
    expect(claims).toMatchObject({ sub: key.apiKeyId, iss: "cdp", uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"] });
    expect(Number(claims.exp) - Number(claims.nbf)).toBe(120);
    expect(verifyJwtSignature(verifyJwt, key.publicKey)).toBe(true);

    expect(decodeJwt(await bearer(cred, "settle")).claims.uris).toEqual(["POST api.cdp.coinbase.com/platform/v2/x402/settle"]);
    expect(decodeJwt(await bearer(cred, "supported")).claims.uris).toEqual(["GET api.cdp.coinbase.com/platform/v2/x402/supported"]);
  });

  it("T-CDP-03 auth headers: every call signs a fresh JWT", async () => {
    const key = testEd25519Key();
    const cred = { apiKeyId: key.apiKeyId, apiKeySecret: key.apiKeySecret };
    expect(await bearer(cred, "verify")).not.toBe(await bearer(cred, "verify"));
  });

  it("T-CDP-03 auth headers: EC keys work as PKCS#8 and as SEC1, including one-line \\n form (analysis A1)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sec1 = privateKey.export({ type: "sec1", format: "pem" }).toString();
    expect(sec1).toContain("-----BEGIN EC PRIVATE KEY-----");
    for (const pem of [pkcs8, sec1, sec1.replace(/\n/g, "\\n"), `  ${sec1}  `]) {
      const cred = { apiKeyId: "organizations/test/apiKeys/ec", apiKeySecret: normalizeCdpSecret(pem) };
      await expect(validateCdpSecret(cred)).resolves.toBeUndefined();
      const jwt = await bearer(cred, "settle");
      expect(decodeJwt(jwt).header.alg).toBe("ES256");
      expect(verifyJwtSignature(jwt, publicKey)).toBe(true);
    }
  });

  it("T-CDP-03 auth headers: a raw SEC1 key is rejected without normalization (must-fail proof for A1)", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sec1 = privateKey.export({ type: "sec1", format: "pem" }).toString();
    await expect(validateCdpSecret({ apiKeyId: "organizations/test/apiKeys/ec", apiKeySecret: sec1 })).rejects.toThrow(ConfigError);
  });

  it("T-CDP-03 auth headers: a malformed secret fails with the fixed message and never echoes it", async () => {
    const secret = `not-a-key-${Date.now()}`;
    const err = await validateCdpSecret({ apiKeyId: "organizations/test/apiKeys/x", apiKeySecret: secret }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe("CDP_API_KEY_SECRET is not a valid Ed25519 (base64) or EC (PEM) key");
    expect((err as Error).message).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// T-CDP-03 offline end-to-end: the T-E2E-01 plan through a JWT-verifying CDP stub (US1, FR-013)
// ---------------------------------------------------------------------------

describe("T-CDP-03 scripted plan through the CDP stub", () => {
  const key = testEd25519Key();
  let h: Harness;
  let stub: CdpStub;

  beforeAll(async () => {
    h = await startHarness({
      sellerFacilitator: async (inner) => {
        stub = await startCdpStub({ publicKey: key.publicKey, apiKeyId: key.apiKeyId, innerUrl: inner });
        const cred = { apiKeyId: key.apiKeyId, apiKeySecret: key.apiKeySecret };
        return facilitatorClientFor(
          { kind: "cdp", url: stub.baseUrl, timeoutMs: 30_000, authenticated: true },
          { cdp: cdpFacilitatorClient(cred, { baseUrl: stub.baseUrl }) },
        );
      },
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await stub?.close();
  });

  it("T-CDP-03 outcomes, on-chain delta, settlements and hash chain match T-E2E-01; every request carried a valid JWT", async () => {
    const orchestrator = new PaidResourceOrchestrator({
      gate: new HttpAuthorizationGate(h.urls.control, h.tokens.control),
      settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
      sessionId: "sess_cdp03",
    });
    const payee0 = await h.balanceOf(h.addresses.payTo);
    const results = await runScriptedAgent({ orchestrator, sellerUrl: h.urls.seller, log: () => {} });

    expect(results.map((r) => r.outcome)).toEqual(RegressionBaseline.outcomes);
    expect((await h.balanceOf(h.addresses.payTo)) - payee0).toBe(BigInt(RegressionBaseline.onChainDeltaAtomic));
    const confirmed = h
      .ledgerEntries()
      .filter((e) => e.type === "SETTLEMENT" && (e.data as { status?: string }).status === "CONFIRMED");
    expect(confirmed).toHaveLength(2);
    const verify = await fetch(`${h.urls.control}/v1/ledger/verify`, { headers: { authorization: `Bearer ${h.tokens.operator}` } });
    expect(((await verify.json()) as { ok: boolean }).ok).toBe(true);

    expect(stub.counts.rejected).toBe(0);
    expect(stub.counts.verify).toBe(2);
    expect(stub.counts.settle).toBe(2);
    expect(stub.counts.supported).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("T-CDP-03 the 402 challenge is identical to the local facilitator's (FR-013)", async () => {
    const plain = createSellerApp({ net: h.net, payTo: h.addresses.payTo });
    const server: Server = await new Promise((r) => {
      const s = plain.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      const plainUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const challenge = async (base: string) => {
        const res = await fetch(`${base}/api/weather?city=Lima`);
        expect(res.status).toBe(402);
        const decoded = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
        return { ...decoded, resource: { ...decoded.resource, url: new URL(decoded.resource.url).pathname } };
      };
      expect(await challenge(h.urls.seller)).toEqual(await challenge(plainUrl));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("T-CDP-03 the stub rejects an unauthenticated client with 401", async () => {
    await expect(new HTTPFacilitatorClient({ url: stub.baseUrl }).getSupported()).rejects.toThrow(/\(401\)/);
  });
});
