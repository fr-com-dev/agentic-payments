// Feature 009 — facilitator selection (SPEC v1.2 CP-3, CFG-1; contracts/seller-config.md).
// T-CDP-01: the facilitatorChoice matrix, one case per row of research R3.
import { describe, expect, it } from "vitest";
import {
  CDP_FACILITATOR_URL,
  ConfigError,
  HOSTED_FACILITATOR_TIMEOUT_MS,
  facilitatorChoice,
  networkProfile,
} from "../src/shared/config.js";
import { facilitatorClientFor } from "../src/counterparty/facilitator-client.js";
import { startCdpStub } from "./helpers/cdp-stub.js";
import { runSeller } from "./helpers/seller-process.js";

const missingDeployment = "/nonexistent/deployment.json";
type Env = Record<string, string | undefined>;

function choose(network: "local" | "base-sepolia", env: Env) {
  const net = networkProfile(network, { env, deploymentFile: missingDeployment });
  return facilitatorChoice(net, env);
}

function rejects(network: "local" | "base-sepolia", env: Env, message: string) {
  expect(() => choose(network, env)).toThrow(ConfigError);
  expect(() => choose(network, env)).toThrow(message);
}

describe("T-CDP-01 facilitatorChoice matrix (FR-001..FR-004)", () => {
  it("T-CDP-01 local, unset: the local facilitator with the SDK default timeout", () => {
    const c = choose("local", {});
    expect(c).toEqual({ kind: "local", url: "http://127.0.0.1:4022", authenticated: false });
    expect(c.timeoutMs).toBeUndefined();
  });

  it("T-CDP-01 local, FACILITATOR_URL set: the override wins", () => {
    expect(choose("local", { FACILITATOR_URL: "http://fac.example" }).url).toBe("http://fac.example");
    expect(choose("local", { FACILITATOR: "local", FACILITATOR_URL: "http://fac.example" }).kind).toBe("local");
  });

  it("T-CDP-01 local with FACILITATOR=cdp or public: startup error", () => {
    rejects("local", { FACILITATOR: "cdp" }, "FACILITATOR=cdp is not valid on NETWORK=local");
    rejects("local", { FACILITATOR: "public" }, "FACILITATOR=public is not valid on NETWORK=local");
  });

  it("T-CDP-01 base-sepolia, unset: CDP is the default, authenticated, 30 s timeout (FR-002)", () => {
    expect(choose("base-sepolia", {})).toEqual({
      kind: "cdp",
      url: "https://api.cdp.coinbase.com/platform/v2/x402",
      timeoutMs: 30_000,
      authenticated: true,
    });
    expect(CDP_FACILITATOR_URL).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
    expect(HOSTED_FACILITATOR_TIMEOUT_MS).toBe(30_000);
    expect(choose("base-sepolia", { FACILITATOR: "cdp" }).kind).toBe("cdp");
  });

  it("T-CDP-01 base-sepolia, CDP with FACILITATOR_URL: startup error (FR-004)", () => {
    rejects("base-sepolia", { FACILITATOR_URL: "https://example.org" }, "FACILITATOR=cdp cannot be combined with FACILITATOR_URL");
    rejects(
      "base-sepolia",
      { FACILITATOR: "cdp", FACILITATOR_URL: "https://example.org" },
      "FACILITATOR=cdp cannot be combined with FACILITATOR_URL",
    );
  });

  it("T-CDP-01 base-sepolia, FACILITATOR=public: x402.org or the override, unauthenticated, 30 s timeout", () => {
    expect(choose("base-sepolia", { FACILITATOR: "public" })).toEqual({
      kind: "public",
      url: "https://x402.org/facilitator",
      timeoutMs: 30_000,
      authenticated: false,
    });
    expect(choose("base-sepolia", { FACILITATOR: "public", FACILITATOR_URL: "http://fac.example" }).url).toBe(
      "http://fac.example",
    );
  });

  it("T-CDP-01 base-sepolia with FACILITATOR=local: startup error", () => {
    rejects("base-sepolia", { FACILITATOR: "local" }, "FACILITATOR=local is only valid on NETWORK=local");
  });

  it("T-CDP-01 unknown FACILITATOR value: startup error", () => {
    for (const network of ["local", "base-sepolia"] as const) {
      rejects(network, { FACILITATOR: "foo" }, 'unknown FACILITATOR "foo" (expected local, public or cdp)');
    }
  });

  it("T-CDP-01 an empty FACILITATOR behaves as unset", () => {
    expect(choose("local", { FACILITATOR: "" }).kind).toBe("local");
    expect(choose("base-sepolia", { FACILITATOR: "" }).kind).toBe("cdp");
  });
});

describe("T-CDP-01 the choice depends only on NETWORK, FACILITATOR and FACILITATOR_URL (SC-007)", () => {
  const unrelated: Env = {
    CDP_API_KEY_ID: "organizations/x/apiKeys/y",
    CDP_API_KEY_SECRET: "c2VjcmV0",
    PAYER_PRIVATE_KEY: "0x01",
    CONTROL_TOKEN: "t",
    SETTLEMENT_TOKEN: "t",
    VERIFIER_TOKEN: "t",
    ALLOWED_HOSTS: "127.0.0.1:4021",
    SELLER_PAY_TO: "0x0000000000000000000000000000000000000001",
  };
  const cases: Array<["local" | "base-sepolia", Env]> = [
    ["local", {}],
    ["local", { FACILITATOR_URL: "http://fac.example" }],
    ["base-sepolia", {}],
    ["base-sepolia", { FACILITATOR: "public" }],
  ];
  for (const [network, env] of cases) {
    it(`T-CDP-01 ${network} ${JSON.stringify(env)} is unchanged by unrelated variables`, () => {
      const plain = choose(network, env);
      const noisy = choose(network, { ...env, ...unrelated });
      expect(noisy).toEqual(plain);
      expect(Object.keys(noisy).sort()).toEqual(Object.keys(plain).sort());
      expect(JSON.stringify(noisy)).not.toMatch(/organizations|c2VjcmV0/);
    });
  }
});

// ---------------------------------------------------------------------------
// US4: the public facilitator path is unchanged and never sends a credential (T032)
// ---------------------------------------------------------------------------

describe("T-CDP-01 public path", () => {
  it("T-CDP-01 public path: FACILITATOR=public on base-sepolia starts with no CDP variables", async () => {
    const run = await runSeller("NETWORK=base-sepolia\nSELLER_PAY_TO=0x00000000000000000000000000000000000000A3\nFACILITATOR=public");
    expect(run.stdout).toMatch(/seller listening on 0\.0\.0\.0:\d+ \(eip155:84532, facilitator=public host=x402\.org\)/);
    expect(run.stderr).not.toContain("CDP credentials set but unused");
  }, 30_000);

  it("T-CDP-01 public path: the public client sends no Authorization header on supported, verify or settle", async () => {
    const stub = await startCdpStub({ innerUrl: "http://127.0.0.1:9", requireAuth: false, mode: "500" });
    try {
      const client = facilitatorClientFor({ kind: "public", url: stub.baseUrl, timeoutMs: 30_000, authenticated: false });
      const payload = { x402Version: 2 } as unknown as Parameters<typeof client.verify>[0];
      const req = {} as Parameters<typeof client.verify>[1];
      await Promise.allSettled([client.getSupported(), client.verify(payload, req), client.settle(payload, req)]);
      expect(stub.counts.requests).toBe(3);
      expect(stub.counts.authHeaders).toBe(0);
    } finally {
      await stub.close();
    }
  });
});
