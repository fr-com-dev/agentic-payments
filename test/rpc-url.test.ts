// SPEC v1.29.3 (SEC-54): T-L3-RPC-01. An RPC endpoint's URL can hold a provider's API key; viem names the endpoint in
// full in its errors, and L3 used to put that text in a report's `detail` (L2's append-only ledger, and L1). Nothing L3
// prints or reports, and no RPC error a script prints, carries more of a URL than its origin.
import { spawn } from "node:child_process";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { listeningLine } from "../src/layer3-settlement/service.js";
import { ChainSettlementVerifier } from "../src/layer3-settlement/verifier.js";
import { networkProfile } from "../src/shared/config.js";
import type { SettlementClaim } from "../src/shared/contracts.js";
import { redactUrls, rpcLabel } from "../src/shared/rpc-url.js";
import { fakePublicClient, transferLog, type FakeChainScript } from "./helpers/fake-public-client.js";

/** A made-up provider key, in the path as most providers put it, and in a query as some do. */
const KEY = "k3y0fTheTestProvider0123456789";
const KEYED = `https://base-sepolia.rpc.example/v2/${KEY}`;
const KEYED_QUERY = `https://lb.rpc.example/ogrpc?network=base-sepolia&dkey=${KEY}`;
const ORIGIN = "https://base-sepolia.rpc.example/…";

const rpcError = (url = KEYED) =>
  new HttpRequestError({ url, status: 401, body: { method: "eth_getTransactionReceipt", params: [] }, details: "Unauthorized" });

describe("T-L3-RPC-01 an RPC URL shows as its origin only", () => {
  it("T-L3-RPC-01 rpcLabel keeps the origin and marks what it hid", () => {
    expect(rpcLabel(KEYED)).toBe(ORIGIN);
    expect(rpcLabel(KEYED_QUERY)).toBe("https://lb.rpc.example/…");
    expect(rpcLabel(`https://user:${KEY}@rpc.example`)).toBe("https://rpc.example/…");
    expect(rpcLabel("https://sepolia.base.org")).toBe("https://sepolia.base.org");
    expect(rpcLabel("https://sepolia.base.org/")).toBe("https://sepolia.base.org");
    expect(rpcLabel("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
    expect(rpcLabel(`not a url ${KEY}`)).toBe("<not a URL>");
  });

  it("T-L3-RPC-01 redactUrls cuts every URL in a text, and leaves the rest as it is", () => {
    const text = `first ${KEYED}, then "${KEYED_QUERY}" and (https://sepolia.base.org/) done`;
    expect(redactUrls(text)).toBe(`first ${ORIGIN} then "https://lb.rpc.example/…" and (https://sepolia.base.org) done`);
    expect(redactUrls("no address here: rpc error 429")).toBe("no address here: rpc error 429");
  });

  it("T-L3-RPC-01 viem's own error names the key (the leak is real), and redactUrls removes it", () => {
    const message = rpcError().message;
    expect(message).toContain(KEY);
    expect(redactUrls(message)).not.toContain(KEY);
    expect(redactUrls(message)).toContain(`URL: ${ORIGIN}`);
    expect(redactUrls(rpcError(`https://user:${KEY}@rpc.example/x`).message)).not.toContain(KEY);
  });

  it("T-L3-RPC-01 L3's startup line names the endpoint's origin, never its key", () => {
    const keyed = networkProfile("base-sepolia", { env: { BASE_SEPOLIA_RPC_URL: KEYED } });
    expect(listeningLine(keyed, 4023)).toBe(`l3-verifier listening on http://127.0.0.1:4023 (network base-sepolia, rpc ${ORIGIN})`);
    expect(listeningLine(networkProfile("base-sepolia", { env: {} }), 4023)).toContain("rpc https://sepolia.base.org)");
  });
});

describe("T-L3-RPC-01 a report's detail never carries the RPC's key", () => {
  const TX = `0x${"12".repeat(32)}`;
  const requirement: PaymentRequirements = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "1000",
    payTo: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2" },
  };
  const claim: SettlementClaim = {
    authorizationId: "auth_rpc",
    requirement,
    payer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    validBefore: 1_900_000_000,
    httpStatus: 200,
    paymentResponseHeader: encodePaymentResponseHeader({ success: true, transaction: TX, network: "eip155:84532", payer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" } as Parameters<
      typeof encodePaymentResponseHeader
    >[0]),
  };
  const NET = { confirmationDepth: 2, supportsSafeTag: true };
  const verify = (script: FakeChainScript, extra: { skipRpcRedaction?: boolean; failHead?: boolean } = {}) => {
    const client = fakePublicClient(script);
    if (extra.failHead) client.getBlockNumber = () => Promise.reject(rpcError());
    return new ChainSettlementVerifier({ publicClient: client, net: NET, waitMs: 500, pollMs: 20, ...(extra.skipRpcRedaction && { skipRpcRedaction: true }) }).verify(claim);
  };

  it("T-L3-RPC-01 an RPC error while waiting for the receipt: PENDING, the origin in the detail, no key", async () => {
    const r = await verify({ receiptError: rpcError() });
    expect(r.status).toBe("PENDING");
    expect(r.detail).toMatch(/^rpc error while waiting for the receipt: HTTP request failed\./);
    expect(r.detail).toContain(`URL: ${ORIGIN}`);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("T-L3-RPC-01 an RPC error after the receipt (the verifier's catch-all): PENDING, the origin in the detail, no key", async () => {
    const settled: FakeChainScript = {
      receipt: { status: "success", blockNumber: 10n, logs: [transferLog(requirement.asset, claim.payer, requirement.payTo, 1000n)] },
      heads: [10n],
    };
    expect((await verify(settled)).status).toBe("CONFIRMED"); // the script is sound: only the failing head read differs
    const r = await verify(settled, { failHead: true });
    expect(r.status).toBe("PENDING");
    expect(r.detail).toMatch(/^verifier error: HTTP request failed\./);
    expect(r.detail).toContain(`URL: ${ORIGIN}`);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("T-L3-RPC-01 must fail: without the redaction (skipRpcRedaction) the key reaches the report", async () => {
    const r = await verify({ receiptError: rpcError() }, { skipRpcRedaction: true });
    expect(r.status).toBe("PENDING");
    expect(r.detail).toContain(KEY);
  });
});

describe("T-L3-RPC-01 the operator's balance check prints no key when the RPC fails", () => {
  it("T-L3-RPC-01 npm run payer-balance against an unreachable keyed endpoint: exit 1, the origin, no key", async () => {
    const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/payer-balance.ts", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", BASE_SEPOLIA_RPC_URL: `http://127.0.0.1:9/v2/${KEY}` },
      });
      let text = "";
      child.stdout.on("data", (d) => (text += String(d)));
      child.stderr.on("data", (d) => (text += String(d)));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve({ code: c, out: text });
      });
    });
    expect(code).toBe(1);
    expect(out).toContain("payer-balance: RPC error:");
    expect(out).toContain("http://127.0.0.1:9/…");
    expect(out).not.toContain(KEY);
  }, 40_000);
});
