// Feature 006 — counterparty and network profiles (CFG-1, CP-5) unit tests.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { facilitatorChoice, formatAtomic, networkProfile, readDeployment } from "../src/shared/config.js";

const missingDeployment = join(tmpdir(), "x402-no-such-dir", "deployment.json");

describe("CFG-1 network profiles (006 T006)", () => {
  it("local profile has the CFG-1 values", () => {
    const p = networkProfile("local", { env: {}, deploymentFile: missingDeployment });
    expect(p.name).toBe("local");
    expect(p.caip2).toBe("eip155:31337");
    expect(p.chainId).toBe(31337);
    expect(p.decimals).toBe(6);
    expect(p.assetDomain).toEqual({ name: "USD Coin", version: "2" });
    expect(p.facilitatorUrl).toBe("http://127.0.0.1:4022");
    expect(p.confirmationDepth).toBe(1);
    expect(p.supportsSafeTag).toBe(false);
  });

  it("base-sepolia profile has the CFG-1 values", () => {
    const p = networkProfile("base-sepolia", { env: {} });
    expect(p.caip2).toBe("eip155:84532");
    expect(p.chainId).toBe(84532);
    expect(p.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(p.decimals).toBe(6);
    expect(p.assetDomain).toEqual({ name: "USDC", version: "2" });
    expect(p.rpcUrl).toBe("https://sepolia.base.org");
    expect(p.facilitatorUrl).toBe("https://x402.org/facilitator");
    expect(p.confirmationDepth).toBe(2);
    expect(p.supportsSafeTag).toBe(true);
  });

  it("selection defaults to NETWORK, then local", () => {
    expect(networkProfile(undefined, { env: {}, deploymentFile: missingDeployment }).name).toBe("local");
    expect(networkProfile(undefined, { env: { NETWORK: "base-sepolia" } }).name).toBe("base-sepolia");
  });

  it("an unknown name throws", () => {
    expect(() => networkProfile("mainnet", { env: {} })).toThrow(/unknown network/);
  });

  it("BASE_SEPOLIA_RPC_URL and FACILITATOR_URL overrides apply", () => {
    const env = { BASE_SEPOLIA_RPC_URL: "https://rpc.example", FACILITATOR_URL: "https://fac.example" };
    const bs = networkProfile("base-sepolia", { env });
    expect(bs.rpcUrl).toBe("https://rpc.example");
    expect(bs.facilitatorUrl).toBe("https://fac.example");
    const local = networkProfile("local", { env, deploymentFile: missingDeployment });
    expect(local.facilitatorUrl).toBe("https://fac.example");
  });
});

describe("CP-5 local deployment record (006 T007)", () => {
  it("missing deployment: rpcUrl falls back and asset access fails fast", () => {
    const p = networkProfile("local", { env: {}, deploymentFile: missingDeployment });
    expect(p.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(p.hasAsset).toBe(false);
    expect(() => p.asset).toThrow(/deployment\.json/);
  });

  it("present deployment: rpcUrl and asset come from the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-dep-"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "deployment.json");
    const record = {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      accounts: {
        deployer: "0x0000000000000000000000000000000000000001",
        facilitator: "0x0000000000000000000000000000000000000002",
        payer: "0x0000000000000000000000000000000000000003",
        sellerPayTo: "0x0000000000000000000000000000000000000004",
      },
      deployedAt: "2026-10-16T00:00:00.000Z",
    };
    writeFileSync(file, JSON.stringify(record));
    expect(readDeployment(file)).toEqual(record);
    const p = networkProfile("local", { env: {}, deploymentFile: file });
    expect(p.hasAsset).toBe(true);
    expect(p.asset).toBe(record.asset);
    expect(p.rpcUrl).toBe(record.rpcUrl);
  });

  it("a deployment record holding a private key is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-dep-"));
    const file = join(dir, "deployment.json");
    writeFileSync(
      file,
      JSON.stringify({
        chainId: 31337,
        rpcUrl: "http://127.0.0.1:8545",
        asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        accounts: { deployer: "0x01", facilitator: "0x02", payer: "0x03", sellerPayTo: "0x04" },
        payerPrivateKey: "0xabc",
        deployedAt: "2026-10-16T00:00:00.000Z",
      }),
    );
    expect(() => readDeployment(file)).toThrow(/addresses only/);
  });
});

describe("formatAtomic (006 T044)", () => {
  it("formats atomic units with BigInt math", () => {
    expect(formatAtomic("6000", 6)).toBe("0.006");
    expect(formatAtomic("1000000", 6)).toBe("1");
    expect(formatAtomic("0", 6)).toBe("0");
    expect(formatAtomic("1500000", 6)).toBe("1.5");
    expect(formatAtomic("123456789012345678901234567890", 6)).toBe("123456789012345678901234.56789");
  });

  it("rejects non-integer strings", () => {
    expect(() => formatAtomic("1.5", 6)).toThrow();
    expect(() => formatAtomic("-1", 6)).toThrow();
    expect(() => formatAtomic("", 6)).toThrow();
    expect(() => formatAtomic("1e6", 6)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Local chain, seller and facilitator (006 US1, US2, US3, US4, Polish)
// ---------------------------------------------------------------------------
// The chain runs in-process on the fixed port 8545; the deployment record goes to a temp dir so the
// developer's .local/deployment.json is untouched. Seller and facilitator listen on ephemeral ports.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync as readFileSync2 } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  parseSignature,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll } from "vitest";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import {
  ACCOUNT_INDEX,
  LOCAL_MNEMONIC,
  PAYER_MINT_ATOMIC,
  compileMockUsdc,
  deployMockUsdc,
  localChain,
  localDevKeys,
  startLocalChain,
  type LocalChain,
} from "../scripts/local-chain-lib.js";
import {
  createSellerApp,
  defaultFacilitator,
  mountFreeEndpoints,
  mountPaidEndpoints,
  sellerPaymentMiddleware,
  sellerRoutes,
} from "../src/counterparty/seller.js";
import { CATALOG, SellerApi } from "../src/counterparty/seller-api.js";
import { createFacilitatorApp } from "../src/counterparty/facilitator.js";
import { CHAIN_PORT, type NetworkProfile } from "../src/shared/config.js";

const dev = (i: number) => mnemonicToAccount(LOCAL_MNEMONIC, { addressIndex: i });
const payerAccount = dev(ACCOUNT_INDEX.payer);
const facilitatorAccount = dev(ACCOUNT_INDEX.facilitator);
const sellerPayTo = dev(ACCOUNT_INDEX.sellerPayTo).address;
const PRICES: Record<string, string> = {
  "/api/weather": "1000",
  "/api/market-brief": "5000",
  "/api/premium-report": "50000",
  "/api/dataset-export": "500000",
};

async function listen(app: express.Express, host = "127.0.0.1"): Promise<{ server: Server; url: string }> {
  return new Promise((resolveListen) => {
    const server = app.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolveListen({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}
const close = (s?: Server) => new Promise<void>((r) => (s ? s.close(() => r()) : r()));

/** Pays for one resource the way L1+L2 will: decode the challenge, sign with the SDK client, retry. */
async function payAndFetch(url: string, asset: string): Promise<Response> {
  const first = await fetch(url);
  if (first.status !== 402) return first;
  // Same SDK spend-control shape L2's signer uses (SPEC L2-3): MockUSDC is a non-default asset.
  const client = x402Client.fromConfig({
    schemes: [{ network: "eip155:31337", client: new ExactEvmClientScheme(payerAccount) }],
    spendControls: { maxAmountPerPayment: false, allowedAssets: [{ network: "eip155:31337", asset, maxAmountPerPayment: "1000000" }] },
  });
  const httpClient = new x402HTTPClient(client);
  const body = await first.json().catch(() => undefined);
  const paymentRequired = httpClient.getPaymentRequiredResponse((n) => first.headers.get(n), body);
  const payload = await httpClient.createPaymentPayload(paymentRequired);
  return fetch(url, { headers: httpClient.encodePaymentSignatureHeader(payload) });
}

describe("local counterparty (006)", () => {
  const depDir = mkdtempSync(join(tmpdir(), "x402-chain-"));
  const deploymentFile = join(depDir, "deployment.json");
  let chain: LocalChain;
  let net: NetworkProfile;
  let facilitator: { server: Server; url: string };
  let seller: { server: Server; url: string };
  let abi: Abi;
  let publicClient: ReturnType<typeof createPublicClient>;

  const balanceOf = async (who: Address, asset: Address = net.asset) =>
    (await publicClient.readContract({ address: asset, abi, functionName: "balanceOf", args: [who] })) as bigint;

  beforeAll(async () => {
    chain = await startLocalChain({ deploymentFile });
    abi = chain.abi;
    publicClient = createPublicClient({ chain: localChain(chain.rpcUrl), transport: http(chain.rpcUrl) });
    facilitator = await listen(
      createFacilitatorApp({ account: facilitatorAccount, rpcUrl: chain.rpcUrl, caip2: "eip155:31337" }),
    );
    net = networkProfile("local", { env: { FACILITATOR_URL: facilitator.url }, deploymentFile });
    seller = await listen(createSellerApp({ net, payTo: sellerPayTo }), "0.0.0.0");
  });

  afterAll(async () => {
    await close(seller?.server);
    await close(facilitator?.server);
    await chain?.stop();
  });

  describe("M2 local chain (006 T023)", () => {
    it("payer #2 holds exactly 10 USDC after startup (SC-003)", async () => {
      expect(chain.rpcUrl).toBe(`http://127.0.0.1:${CHAIN_PORT}`);
      expect(await balanceOf(payerAccount.address)).toBe(PAYER_MINT_ATOMIC);
      expect(PAYER_MINT_ATOMIC).toBe(10_000_000n);
    });

    it("the deployment record matches the schema, holds no keys and maps roles #0–#3", () => {
      const rec = readDeployment(deploymentFile)!;
      expect(rec.chainId).toBe(31337);
      expect(rec.rpcUrl).toBe(chain.rpcUrl);
      expect(rec.accounts).toEqual({
        deployer: dev(0).address,
        facilitator: dev(1).address,
        payer: dev(2).address,
        sellerPayTo: dev(3).address,
      });
      const raw = readFileSync2(deploymentFile, "utf8");
      const keys = localDevKeys({ NETWORK: "local" });
      expect(raw).not.toContain(keys.payer.slice(2));
      expect(raw).not.toContain(keys.facilitator.slice(2));
      expect(raw).not.toMatch(/private|mnemonic/i);
    });

    it("localDevKeys() derives #2/#1 keys on local only (T046)", () => {
      const keys = localDevKeys({ NETWORK: "local" });
      expect(keys.payer).toMatch(/^0x[0-9a-f]{64}$/);
      expect(keys.facilitator).toMatch(/^0x[0-9a-f]{64}$/);
      expect(() => localDevKeys({ NETWORK: "base-sepolia" })).toThrow(/local only/);
    });

    it("the token metadata on-chain matches the local assetDomain (NFR-002)", async () => {
      const read = (functionName: string) => publicClient.readContract({ address: net.asset, abi, functionName });
      expect(await read("name")).toBe(net.assetDomain.name);
      expect(await read("version")).toBe(net.assetDomain.version);
      expect(await read("symbol")).toBe("USDC");
      expect(await read("decimals")).toBe(6);
    });
  });

  describe("M3 seller challenge (006 T013)", () => {
    for (const [path, amount] of Object.entries(PRICES)) {
      it(`unpaid GET ${path} → 402 with one exact option of ${amount}`, async () => {
        const res = await fetch(`${seller.url}${path}${path === "/api/weather" ? "?city=Lima" : ""}`);
        expect(res.status).toBe(402);
        const header = res.headers.get("PAYMENT-REQUIRED");
        expect(header).toBeTruthy();
        const pr = decodePaymentRequiredHeader(header!);
        expect(pr.x402Version).toBe(2);
        expect(pr.resource.url).toBe(`${seller.url}${path}${path === "/api/weather" ? "?city=Lima" : ""}`);
        expect(pr.accepts).toHaveLength(1);
        expect(pr.accepts[0]).toEqual({
          scheme: "exact",
          network: net.caip2,
          asset: net.asset,
          amount,
          payTo: sellerPayTo,
          maxTimeoutSeconds: 120,
          extra: net.assetDomain,
        });
      });
    }
  });

  describe("seller tolerates a facilitator that starts later (006 T022)", () => {
    it("priced route → 503 while the facilitator is down, then 402 once it is up; catalog stays 200", async () => {
      const lateApp = createFacilitatorApp({ account: facilitatorAccount, rpcUrl: chain.rpcUrl, caip2: "eip155:31337" });
      const probe = await listen(express());
      const lateUrl = probe.url;
      await close(probe.server); // reserve a port that is now closed
      const lateNet = networkProfile("local", { env: { FACILITATOR_URL: lateUrl }, deploymentFile });
      const s = await listen(createSellerApp({ net: lateNet, payTo: sellerPayTo }));
      let late: Server | undefined;
      try {
        expect((await fetch(`${s.url}/api/catalog`)).status).toBe(200);
        const down = await fetch(`${s.url}/api/market-brief`);
        expect(down.status).toBe(503);
        // SPEC v1.2 CP-1 (009 T011): the body names the category and carries no upstream detail.
        expect(await down.json()).toEqual({ error: "facilitator unavailable", category: "unavailable" });
        const port = Number(new URL(lateUrl).port);
        late = await new Promise<Server>((r) => {
          const srv = lateApp.listen(port, "127.0.0.1", () => r(srv));
        });
        const res = await fetch(`${s.url}/api/market-brief`);
        expect(res.status).toBe(402);
        expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).accepts).toHaveLength(1);
      } finally {
        await close(s.server);
        await close(late);
      }
    });
  });

  describe("catalog (006 T014)", () => {
    it("GET /api/catalog is free and lists the four priced routes", async () => {
      const res = await fetch(`${seller.url}/api/catalog`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        network: string;
        asset: string;
        decimals: number;
        items: Array<{ path: string; priceAtomic: string; description: string; tier: string }>;
      };
      expect(body.network).toBe(net.caip2);
      expect(body.asset).toBe(net.asset);
      expect(body.decimals).toBe(6);
      expect(body.items).toHaveLength(4);
      for (const item of body.items) expect(item.priceAtomic).toMatch(/^[1-9]\d*$/);
      expect(body.items.map((i) => [i.path, i.priceAtomic, i.tier])).toEqual([
        ["/api/weather?city=", "1000", "pay-per-use"],
        ["/api/market-brief", "5000", "pay-per-use"],
        ["/api/premium-report", "50000", "premium"],
        ["/api/dataset-export", "500000", "enterprise"],
      ]);
      expect(CATALOG.map((c) => c.priceAtomic)).toEqual(["1000", "5000", "50000", "500000"]);
    });
  });

  describe("mount order keeps the catalog free (006 T015, research R3)", () => {
    // With explicit per-route keys the middleware never matches /api/catalog. A wildcard route map
    // (a plausible misconfiguration) does; only mounting the catalog first keeps it free.
    const wildcard = () => ({
      ...sellerRoutes(net, sellerPayTo),
      "GET /api/*": sellerRoutes(net, sellerPayTo)["GET /api/market-brief"]!,
    });

    it("catalog mounted after a catch-all payment middleware → 402", async () => {
      const app = express();
      app.use(sellerPaymentMiddleware(net, wildcard()));
      mountFreeEndpoints(app, new SellerApi(net));
      const s = await listen(app);
      try {
        expect((await fetch(`${s.url}/api/catalog`)).status).toBe(402);
      } finally {
        await close(s.server);
      }
    });

    it("catalog mounted before the same middleware → 200", async () => {
      const app = express();
      const api = new SellerApi(net);
      mountFreeEndpoints(app, api);
      app.use(sellerPaymentMiddleware(net, wildcard()));
      mountPaidEndpoints(app, api);
      const s = await listen(app);
      try {
        expect((await fetch(`${s.url}/api/catalog`)).status).toBe(200);
      } finally {
        await close(s.server);
      }
    });
  });

  describe("paid responses are deterministic and settle on-chain (006 T016, T017 local half)", () => {
    it("two paid weather calls for Lima return identical bodies; the query never changes the price", async () => {
      const payeeBefore = await balanceOf(sellerPayTo);
      const a = await payAndFetch(`${seller.url}/api/weather?city=Lima`, net.asset);
      const b = await payAndFetch(`${seller.url}/api/weather?city=Lima`, net.asset);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const bodyA = await a.json();
      expect(bodyA).toEqual(await b.json());
      expect(Object.keys(bodyA).sort()).toEqual(["city", "condition", "source", "tempC"]);
      for (const res of [a, b]) {
        const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
        expect(settle.success).toBe(true);
        expect(settle.network).toBe("eip155:31337");
        expect(settle.payer?.toLowerCase()).toBe(payerAccount.address.toLowerCase());
        expect(settle.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      }
      expect((await balanceOf(sellerPayTo)) - payeeBefore).toBe(2000n);
      for (const city of ["Quito", "São Paulo"]) {
        const pr = decodePaymentRequiredHeader(
          (await fetch(`${seller.url}/api/weather?city=${encodeURIComponent(city)}`)).headers.get("PAYMENT-REQUIRED")!,
        );
        expect(pr.accepts[0]!.amount).toBe("1000");
      }
    });

    it("market brief, premium report and dataset export bodies", async () => {
      const brief = (await (await payAndFetch(`${seller.url}/api/market-brief`, net.asset)).json()) as { bullets: string[] };
      expect(brief.bullets).toHaveLength(3);
      const report = (await (await payAndFetch(`${seller.url}/api/premium-report`, net.asset)).json()) as { pages: number };
      expect(report.pages).toBe(42);
      const dataset = (await (await payAndFetch(`${seller.url}/api/dataset-export`, net.asset)).json()) as { rows: number };
      expect(dataset.rows).toBe(1_000_000);
    });
  });

  describe("facilitator API (006 T024)", () => {
    const post = (path: string, body: unknown) =>
      fetch(`${facilitator.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("GET /supported lists exact on eip155:31337, x402 v2", async () => {
      const res = await fetch(`${facilitator.url}/supported`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kinds: Array<Record<string, unknown>> };
      expect(body.kinds).toContainEqual(expect.objectContaining({ x402Version: 2, scheme: "exact", network: "eip155:31337" }));
    });

    it("malformed POST /verify → 400 {isValid:false, invalidReason}, never 500", async () => {
      for (const body of [{}, { x402Version: 2 }, { x402Version: 2, paymentPayload: "x", paymentRequirements: 1 }]) {
        const res = await post("/verify", body);
        expect(res.status).toBe(400);
        const json = (await res.json()) as { isValid: boolean; invalidReason: string };
        expect(json.isValid).toBe(false);
        expect(typeof json.invalidReason).toBe("string");
      }
    });

    it("failing POST /settle → 400 {success:false, errorReason}", async () => {
      const res = await post("/settle", { x402Version: 2, paymentPayload: { x402Version: 2 } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; errorReason: string };
      expect(json.success).toBe(false);
      expect(typeof json.errorReason).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // US4: MockUSDC EIP-3009 parity (T035–T038), with must-fail variants
  // -------------------------------------------------------------------------
  describe("MockUSDC EIP-3009 (006 T035–T038)", () => {
    const submitter = () =>
      createWalletClient({ account: facilitatorAccount, chain: localChain(chain.rpcUrl), transport: http(chain.rpcUrl) });
    const now = async () => Number((await publicClient.getBlock()).timestamp);
    let nonceSeq = 0;
    const freshNonce = (): Hex => toHex(BigInt(Date.now()) * 1000n + BigInt(++nonceSeq), { size: 32 });

    async function signAuth(asset: Address, overrides: Partial<{ validAfter: bigint; validBefore: bigint; value: bigint; signer: typeof payerAccount }> = {}) {
      const t = BigInt(await now());
      const message = {
        from: payerAccount.address,
        to: sellerPayTo,
        value: overrides.value ?? 1000n,
        validAfter: overrides.validAfter ?? t - 600n,
        validBefore: overrides.validBefore ?? t + 600n,
        nonce: freshNonce(),
      };
      const signature = await (overrides.signer ?? payerAccount).signTypedData({
        domain: { name: "USD Coin", version: "2", chainId: 31337, verifyingContract: asset },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message,
      });
      return { message, signature };
    }

    const argsOf = (m: Awaited<ReturnType<typeof signAuth>>["message"]) =>
      [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce] as const;

    async function submitVrs(asset: Address, a: Awaited<ReturnType<typeof signAuth>>, tokenAbi: Abi = abi) {
      const sig = parseSignature(a.signature);
      const hash = await submitter().writeContract({
        address: asset,
        abi: tokenAbi,
        functionName: "transferWithAuthorization",
        args: [...argsOf(a.message), Number(sig.v ?? 27n + BigInt(sig.yParity)), sig.r, sig.s],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    }
    async function submitBytes(asset: Address, a: Awaited<ReturnType<typeof signAuth>>) {
      const hash = await submitter().writeContract({
        address: asset,
        abi,
        functionName: "transferWithAuthorization",
        args: [...argsOf(a.message), a.signature],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    }

    it("T035: both overloads move funds and emit AuthorizationUsed + Transfer", async () => {
      for (const submit of [submitVrs, submitBytes]) {
        const a = await signAuth(net.asset);
        const receipt = await submit(net.asset, a);
        expect(receipt.status).toBe("success");
        const used = parseEventLogs({ abi, logs: receipt.logs, eventName: "AuthorizationUsed" });
        const transfers = parseEventLogs({ abi, logs: receipt.logs, eventName: "Transfer" });
        expect(used).toHaveLength(1);
        expect(transfers).toHaveLength(1);
        expect((transfers[0]!.args as { value: bigint }).value).toBe(1000n);
      }
    });

    it("T036: a used nonce cannot be replayed; authorizationState is true (SC-004)", async () => {
      const a = await signAuth(net.asset);
      await submitVrs(net.asset, a);
      expect(
        await publicClient.readContract({
          address: net.asset,
          abi,
          functionName: "authorizationState",
          args: [payerAccount.address, a.message.nonce],
        }),
      ).toBe(true);
      await expect(submitVrs(net.asset, a)).rejects.toThrow(/authorization is used/);
    });

    it("T037: the token rejects authorizations outside the validity window", async () => {
      const t = BigInt(await now());
      await expect(submitVrs(net.asset, await signAuth(net.asset, { validAfter: t + 3600n, validBefore: t + 7200n }))).rejects.toThrow(
        /not yet valid/,
      );
      await expect(submitVrs(net.asset, await signAuth(net.asset, { validAfter: 0n, validBefore: t - 10n }))).rejects.toThrow(
        /expired/,
      );
    });

    it("T038: non-owner mint and a wrong signer both revert", async () => {
      await expect(
        submitter().writeContract({ address: net.asset, abi, functionName: "mint", args: [facilitatorAccount.address, 1n] }),
      ).rejects.toThrow(/not the owner/);
      await expect(submitVrs(net.asset, await signAuth(net.asset, { signer: dev(5) }))).rejects.toThrow(/invalid signature/);
      const huge = await signAuth(net.asset, { value: PAYER_MINT_ATOMIC * 100n });
      await expect(submitVrs(net.asset, huge)).rejects.toThrow(/exceeds balance/);
    });

    // Must-fail proofs: the same assertions against deliberately weakened tokens would not hold.
    const weakened = async (from: RegExp) => {
      const source = readFileSync2("contracts/MockUSDC.sol", "utf8");
      const lines = source.split("\n");
      const mutated = lines.filter((l) => !from.test(l)).join("\n");
      expect(mutated).not.toBe(source);
      const { abi: wAbi, bytecode } = compileMockUsdc(mutated);
      return { asset: await deployMockUsdc(chain.rpcUrl, wAbi, bytecode), wAbi };
    };

    it("T036 must-fail: without the nonce check, a replay succeeds", async () => {
      const { asset, wAbi } = await weakened(/authorization is used or canceled/);
      const a = await signAuth(asset);
      await submitVrs(asset, a, wAbi);
      const replay = await submitVrs(asset, a, wAbi);
      expect(replay.status).toBe("success"); // the T036 expectation would fail on this token
    });

    it("T037 must-fail: without the window checks, an expired authorization settles", async () => {
      const { asset, wAbi } = await weakened(/authorization is (not yet valid|expired)/);
      const t = BigInt(await now());
      const receipt = await submitVrs(asset, await signAuth(asset, { validAfter: 0n, validBefore: t - 10n }), wAbi);
      expect(receipt.status).toBe("success"); // the T037 expectation would fail on this token
    });
  });
});

// ---------------------------------------------------------------------------
// US2 facilitator network guard (006 T025) and US3 Base Sepolia (T030–T032)
// ---------------------------------------------------------------------------

describe("facilitator entry is local only (006 T025)", () => {
  it("NETWORK=base-sepolia exits non-zero with 'local only' before reading any key", () => {
    const r = spawnSync("npx", ["tsx", "scripts/facilitator.ts"], {
      env: { ...process.env, ENV_FILE: "/dev/null", NETWORK: "base-sepolia", FACILITATOR_PRIVATE_KEY: "0xnot-a-key" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/local only/);
    expect(r.stderr).not.toMatch(/private key|invalid.*key|hex/i);
  });

  it("NETWORK=local with an empty FACILITATOR_PRIVATE_KEY exits with a clear message", () => {
    const r = spawnSync("npx", ["tsx", "scripts/facilitator.ts"], {
      env: { ...process.env, ENV_FILE: "/dev/null", NETWORK: "local", FACILITATOR_PRIVATE_KEY: "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/FACILITATOR_PRIVATE_KEY not set/);
  });
});

describe("Base Sepolia is configuration only (006 T030–T032)", () => {
  it("T030: the seller's challenge uses eip155:84532, Circle USDC and extra {USDC, 2}", async () => {
    const fac = await listen(
      createFacilitatorApp({ account: mnemonicToAccount(LOCAL_MNEMONIC, { addressIndex: 9 }), rpcUrl: "http://127.0.0.1:1", caip2: "eip155:84532" }),
    );
    const bs = networkProfile("base-sepolia", { env: { FACILITATOR_URL: fac.url } });
    const s = await listen(createSellerApp({ net: bs, payTo: sellerPayTo }));
    try {
      const res = await fetch(`${s.url}/api/weather?city=Lima`);
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
      expect(pr.accepts[0]).toMatchObject({
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        extra: { name: "USDC", version: "2" },
      });
    } finally {
      await close(s.server);
      await close(fac.server);
    }
  });

  it("T031: EIP-712 domain names are 'USDC' on base-sepolia and 'USD Coin' on local (§16)", () => {
    expect(networkProfile("base-sepolia", { env: {} }).assetDomain.name).toBe("USDC");
    expect(networkProfile("local", { env: {}, deploymentFile: missingDeployment }).assetDomain.name).toBe("USD Coin");
  });

  it("T032: the seller's facilitator URL comes from the profile, and the override wins (CP-3 v1.2)", () => {
    // base-sepolia defaults to CDP since SPEC v1.2; x402.org is the explicit FACILITATOR=public choice.
    const sepolia = networkProfile("base-sepolia", { env: {} });
    expect(facilitatorChoice(sepolia, { FACILITATOR: "public" }).url).toBe("https://x402.org/facilitator");
    expect(facilitatorChoice(sepolia, {}).url).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
    const local = networkProfile("local", { env: {}, deploymentFile: missingDeployment });
    expect(facilitatorChoice(local, {}).url).toBe("http://127.0.0.1:4022");
    expect(defaultFacilitator(local).url).toBe("http://127.0.0.1:4022");
    for (const name of ["local", "base-sepolia"]) {
      const env = { FACILITATOR_URL: "http://fac.example" };
      const p = networkProfile(name, { env, deploymentFile: missingDeployment });
      expect(facilitatorChoice(p, name === "local" ? env : { ...env, FACILITATOR: "public" }).url).toBe("http://fac.example");
      expect(defaultFacilitator(p).url).toBe("http://fac.example");
    }
  });
});

// ---------------------------------------------------------------------------
// Polish (006 T040): no hand-rolled base64 for x402 headers under src/counterparty
// ---------------------------------------------------------------------------

describe("x402 headers only through SDK helpers (006 T040, NFR-001)", () => {
  it("src/counterparty has no Buffer base64, atob or btoa", () => {
    const files = readdirSync("src/counterparty").filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync2(join("src/counterparty", f), "utf8");
      expect(src, f).not.toMatch(/["'`]base64(url)?["'`]/);
      expect(src, f).not.toMatch(/\b(atob|btoa)\s*\(/);
    }
  });
});
