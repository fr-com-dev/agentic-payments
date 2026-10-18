// Feature 009 US2 — the CDP credential stays with the seller and fails closed (SPEC v1.2 CP-3, SEC-10;
// contracts/seller-config.md). T-CDP-02 startup drills, T-CDP-07 secret scan, T-CDP-08 isolation.
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import {
  cdpCredentialsFromEnv,
  cdpFacilitatorClient,
  containsCdpSecret,
  makeRedactor,
} from "../src/counterparty/cdp-facilitator.js";
import { facilitatorClientFor } from "../src/counterparty/facilitator-client.js";
import { createSellerApp } from "../src/counterparty/seller.js";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../src/layer1-intent/ports-http.js";
import { PaidResourceOrchestrator } from "../src/layer1-intent/orchestrator.js";
import type { FacilitatorChoice } from "../src/shared/config.js";
import { childEnv, type DemoProcess } from "../scripts/demo-lib.js";
import { startHarness, type Harness } from "./helpers/harness.js";
import { startCdpStub, testEd25519Key, type CdpStub } from "./helpers/cdp-stub.js";
import { runSeller } from "./helpers/seller-process.js";

const PAY_TO = "0x00000000000000000000000000000000000000A3";

const cdpChoice = (url: string): FacilitatorChoice => ({ kind: "cdp", url, timeoutMs: 30_000, authenticated: true });

// ---------------------------------------------------------------------------
// T-CDP-02 startup fails closed (FR-003, FR-004, FR-006, FR-008)
// ---------------------------------------------------------------------------

describe("T-CDP-02 seller startup drills", () => {
  const key = testEd25519Key();
  const sepolia = `NETWORK=base-sepolia\nSELLER_PAY_TO=${PAY_TO}`;

  const cases: Array<[string, string, string]> = [
    ["no CDP variables", sepolia, "seller: missing CDP_API_KEY_ID (required for FACILITATOR=cdp)"],
    ["an empty secret", `${sepolia}\nCDP_API_KEY_ID=${key.apiKeyId}\nCDP_API_KEY_SECRET=`, "seller: missing CDP_API_KEY_SECRET (required for FACILITATOR=cdp)"],
    [
      "CDP with FACILITATOR_URL",
      `${sepolia}\nFACILITATOR_URL=https://example.org\nCDP_API_KEY_ID=${key.apiKeyId}\nCDP_API_KEY_SECRET=${key.apiKeySecret}`,
      "seller: invalid facilitator config: FACILITATOR=cdp cannot be combined with FACILITATOR_URL",
    ],
    [
      "CDP on NETWORK=local",
      `NETWORK=local\nSELLER_PAY_TO=${PAY_TO}\nFACILITATOR=cdp`,
      "seller: invalid facilitator config: FACILITATOR=cdp is not valid on NETWORK=local",
    ],
  ];
  for (const [name, text, message] of cases) {
    it(`T-CDP-02 ${name}: exit 1 with the fixed message`, async () => {
      const run = await runSeller(text);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(message);
      expect(run.stdout).not.toContain("seller listening");
      expect(run.stdout + run.stderr).not.toContain(key.apiKeySecret);
    }, 30_000);
  }

  it("T-CDP-02 a malformed secret: exit 1, the fixed message, and the value is never echoed", async () => {
    const garbage = `not-a-key-${Date.now().toString(36)}`;
    const run = await runSeller(`${sepolia}\nCDP_API_KEY_ID=${key.apiKeyId}\nCDP_API_KEY_SECRET=${garbage}`);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("seller: CDP_API_KEY_SECRET is not a valid Ed25519 (base64) or EC (PEM) key");
    expect(run.stdout + run.stderr).not.toContain(garbage);
  }, 30_000);

  it("T-CDP-02 a valid key: listens with the CP-3 log line, key suffix only, no network call at startup", async () => {
    const run = await runSeller(`${sepolia}\nCDP_API_KEY_ID=${key.apiKeyId}\nCDP_API_KEY_SECRET=${key.apiKeySecret}`);
    expect(run.stdout).toMatch(/seller listening on 0\.0\.0\.0:\d+ \(eip155:84532, facilitator=cdp host=api\.cdp\.coinbase\.com key=…[\w-]{4}\)/);
    expect(run.stdout).toContain(`key=…${key.apiKeyId.slice(-4)}`);
    expect(run.stdout + run.stderr).not.toContain(key.apiKeySecret);
    expect(run.stdout + run.stderr).not.toContain(key.apiKeyId.slice(0, -4));
  }, 30_000);

  it("T-CDP-02 a quoted multi-line SEC1 PEM key in the env file is accepted (analysis A1, G3)", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sec1 = privateKey.export({ type: "sec1", format: "pem" }).toString().trim();
    const run = await runSeller(`${sepolia}\nCDP_API_KEY_ID=${key.apiKeyId}\nCDP_API_KEY_SECRET="${sec1}"`);
    expect(run.stdout).toContain("facilitator=cdp host=api.cdp.coinbase.com");
    for (const line of sec1.split("\n").filter((l) => !l.startsWith("-----"))) expect(run.stdout + run.stderr).not.toContain(line);
  }, 30_000);

  it("T-CDP-02 FACILITATOR=public with CDP variables set: listens and warns they are unused", async () => {
    const run = await runSeller(`${sepolia}\nFACILITATOR=public\nCDP_API_KEY_ID=${key.apiKeyId}\nCDP_API_KEY_SECRET=${key.apiKeySecret}`);
    expect(run.stdout).toContain("facilitator=public host=x402.org");
    expect(run.stderr).toContain("seller: CDP credentials set but unused (FACILITATOR=public)");
    expect(run.stdout + run.stderr).not.toContain(key.apiKeySecret);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// T-CDP-07 secret scan (FR-011, SC-004) and the redaction must-fail proof (analysis C1)
// ---------------------------------------------------------------------------

interface Capture {
  texts: string[];
  restore(): void;
}

/** Records every console line and every in-process HTTP exchange (URL, status, headers, body). */
function capture(): Capture {
  const texts: string[] = [];
  const spies = (["log", "warn", "error", "info"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      texts.push(args.map(String).join(" "));
    }),
  );
  const realFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const res = await realFetch(input, init);
    const body = await res.clone().text();
    texts.push(`${String(input instanceof Request ? input.url : input)} ${res.status} ${JSON.stringify([...res.headers])} ${body}`);
    if (init?.headers) texts.push(JSON.stringify(init.headers));
    return res;
  });
  return {
    texts,
    restore: () => {
      for (const s of spies) s.mockRestore();
      fetchSpy.mockRestore();
    },
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [readFileSync(join(dir, e.name), "utf8")],
  );
}

describe("T-CDP-07 secret scan", () => {
  const key = testEd25519Key();
  const cred = cdpCredentialsFromEnv({ CDP_API_KEY_ID: key.apiKeyId, CDP_API_KEY_SECRET: key.apiKeySecret });
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

  it("T-CDP-07 the secret never appears in logs, HTTP exchanges, the ledger or the harness state files", async () => {
    const orchestrator = new PaidResourceOrchestrator({
      gate: new HttpAuthorizationGate(h.urls.control, h.tokens.control),
      settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
      sessionId: "sess_cdp07",
    });
    const cap = capture();
    try {
      stub.setMode("ok");
      await orchestrator.fetchPaid(`${h.urls.seller}/api/weather?city=Lima`, "scan ok");
      for (const [mode, city] of [["decline", "Quito"], ["pending", "Cusco"], ["500", "Arequipa"], ["401", "Puno"]] as const) {
        stub.setMode(mode);
        await orchestrator.fetchPaid(`${h.urls.seller}/api/weather?city=${city}`, `scan ${mode}`);
      }
      // An unsynced seller hitting each failing mode on its first priced request (the 503 path).
      for (const mode of ["401", "500"] as const) {
        stub.setMode(mode);
        const app = createSellerApp({
          net: h.net,
          payTo: h.addresses.payTo,
          facilitator: facilitatorClientFor(cdpChoice(stub.baseUrl), { cdp: cdpFacilitatorClient(cred, { baseUrl: stub.baseUrl }) }),
          redact: makeRedactor(cred),
        });
        const server: Server = await new Promise((r) => {
          const s = app.listen(0, "127.0.0.1", () => r(s));
        });
        await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/market-brief`);
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      stub.setMode("ok");
      cap.restore();
    }
    const corpus = [...cap.texts, ...filesUnder(dirname(h.ledgerPath))].join("\n");
    expect(cap.texts.length).toBeGreaterThan(10);
    expect(corpus).not.toContain(key.apiKeySecret);
    expect(corpus).not.toContain(key.apiKeySecret.slice(0, 32));
    expect(containsCdpSecret({ CDP_API_KEY_SECRET: key.apiKeySecret }, corpus)).toBe(false);
    expect(containsCdpSecret({ CDP_API_KEY_SECRET: key.apiKeySecret }, `x ${key.apiKeySecret} y`)).toBe(true);
  }, 120_000);

  it("T-CDP-07 makeRedactor hides the raw secret, the normalized secret and every PEM body line", () => {
    expect(makeRedactor(cred)(`a ${key.apiKeySecret} b`)).toBe("a [redacted] b");
    expect(makeRedactor(cred)(`prefix ${key.apiKeySecret.slice(0, 32)}`)).toBe("prefix [redacted]");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    for (const type of ["pkcs8", "sec1"] as const) {
      const pem = privateKey.export({ type, format: "pem" }).toString();
      const ec = cdpCredentialsFromEnv({ CDP_API_KEY_ID: "organizations/t/apiKeys/ec", CDP_API_KEY_SECRET: pem });
      const redact = makeRedactor(ec);
      const bodies = [pem, ec.apiKeySecret].flatMap((p) => p.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----")));
      expect(bodies.length).toBeGreaterThan(0);
      for (const line of bodies) expect(redact(`log: ${line}`)).toBe("log: [redacted]");
    }
  });

  it("T-CDP-07 seller logs are redacted (fails without the redactor)", async () => {
    const secret = key.apiKeySecret;
    const echoing: FacilitatorClient = {
      getSupported: async () => {
        throw new Error(`Facilitator getSupported failed (500): echo ${secret}`);
      },
      verify: async () => {
        throw new Error("unused");
      },
      settle: async () => {
        throw new Error("unused");
      },
    };
    for (const [redact, leaks] of [
      [makeRedactor(cred), false],
      [(s: string) => s, true],
    ] as const) {
      const cap = capture();
      let body = "";
      try {
        const app = createSellerApp({
          net: h.net,
          payTo: h.addresses.payTo,
          facilitator: facilitatorClientFor(cdpChoice("https://api.cdp.coinbase.com/platform/v2/x402"), { cdp: echoing }),
          redact,
        });
        const server: Server = await new Promise((r) => {
          const s = app.listen(0, "127.0.0.1", () => r(s));
        });
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/market-brief`);
        expect(res.status).toBe(503);
        body = await res.text();
        await new Promise<void>((r) => server.close(() => r()));
      } finally {
        cap.restore();
      }
      const logs = cap.texts.filter((t) => t.startsWith("seller: facilitator")).join("\n");
      expect(logs).toContain("seller: facilitator unavailable during supported");
      expect(body).toBe('{"error":"facilitator unavailable","category":"unavailable"}');
      expect(logs.includes(secret)).toBe(leaks);
      if (!leaks) expect(logs).toContain("[redacted]");
    }
  });
});

// ---------------------------------------------------------------------------
// T-CDP-08 isolation (FR-010, SC-005) and no fallback (FR-005)
// ---------------------------------------------------------------------------

describe("T-CDP-08 credential isolation and no fallback", () => {
  afterEach(() => {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
  });

  it("T-CDP-08 demo child environments carry no CDP key, on local and on base-sepolia", () => {
    process.env.CDP_API_KEY_ID = "organizations/x/apiKeys/leak";
    process.env.CDP_API_KEY_SECRET = "bGVhaw==";
    const roles = ["chain", "facilitator", "seller", "l2", "l3", "agent"];
    const allowed = /^(PATH|HOME|NODE_\w+|ENV_FILE|PAYER_PRIVATE_KEY|ALLOWED_PAYEES|FACILITATOR_PRIVATE_KEY|SELLER_PAY_TO|SESSION_ID)$/;
    for (const network of ["local", "base-sepolia"]) {
      for (const role of roles) {
        const p: DemoProcess = { role, tag: role, entry: "x.ts", args: [], envFile: `env/${role}.env` };
        const env = childEnv(p, { path: `/tmp/${role}.env`, values: {} }, { network, sessionId: "sess_x" });
        expect(Object.keys(env).filter((k) => k.startsWith("CDP_")), `${network}/${role}`).toEqual([]);
        expect(Object.keys(env).filter((k) => !allowed.test(k)), `${network}/${role}`).toEqual([]);
        if (network !== "local") {
          expect(Object.keys(env).filter((k) => /PRIVATE_KEY|PAYEES|PAY_TO/.test(k)), `${network}/${role}`).toEqual([]);
        }
      }
    }
  });

  it("T-CDP-08 a failing CDP facilitator never causes a request to any other facilitator (fails if a fallback is added)", async () => {
    const key = testEd25519Key();
    const stub = await startCdpStub({ publicKey: key.publicKey, apiKeyId: key.apiKeyId, innerUrl: "http://127.0.0.1:9", mode: "500" });
    const cap = capture();
    const urls: string[] = [];
    const fetchSpy = vi.mocked(globalThis.fetch);
    let server: Server | undefined;
    try {
      const cred = { apiKeyId: key.apiKeyId, apiKeySecret: key.apiKeySecret };
      const net = { ...(await import("../src/shared/config.js")).networkProfile("base-sepolia", { env: {} }) };
      const app = createSellerApp({
        net,
        payTo: PAY_TO,
        facilitator: facilitatorClientFor(cdpChoice(stub.baseUrl), { cdp: cdpFacilitatorClient(cred, { baseUrl: stub.baseUrl }) }),
      });
      server = await new Promise((r) => {
        const s = app.listen(0, "127.0.0.1", () => r(s));
      });
      const sellerHost = `127.0.0.1:${(server!.address() as AddressInfo).port}`;
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`http://${sellerHost}/api/market-brief`);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "facilitator unavailable", category: "unavailable" });
      }
      for (const call of fetchSpy.mock.calls) urls.push(String(call[0] instanceof Request ? call[0].url : call[0]));
      expect(urls.length).toBeGreaterThanOrEqual(6);
      const hosts = new Set(urls.map((u) => new URL(u).host));
      expect([...hosts].sort()).toEqual([sellerHost, stub.host].sort());
      expect(stub.counts.requests).toBeGreaterThanOrEqual(3);
      expect(stub.counts.rejected).toBe(0);
    } finally {
      cap.restore();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      await stub.close();
    }
  });
});
