// Feature 007 — per-role bearer guard (INV-13) and role-token resolution (CFG-2).
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { ENDPOINT_ROLES, requireRole, tokensMatch } from "../src/shared/auth.js";
import { DEV_TOKENS, ROLE_TOKEN_VAR, tokenFor, type Role } from "../src/shared/config.js";

interface Outcome {
  status?: number;
  body?: unknown;
  nextCalled: boolean;
}

function run(role: Role, authorization: string | undefined, token = DEV_TOKENS[ROLE_TOKEN_VAR[role]]!): Outcome {
  const out: Outcome = { nextCalled: false };
  const req = { headers: authorization === undefined ? {} : { authorization } } as unknown as Request;
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    out.nextCalled = true;
  };
  requireRole(role, { token })(req, res, next);
  return out;
}

const bearer = (t: string) => `Bearer ${t}`;

describe("T-AUTH requireRole guard (007 T029)", () => {
  it("no Authorization header → 401 unauthorized", () => {
    const o = run("agent-control", undefined);
    expect(o).toEqual({ status: 401, body: { error: "unauthorized" }, nextCalled: false });
  });

  it("header without the Bearer prefix → 401", () => {
    expect(run("agent-control", "dev-control-token").status).toBe(401);
    expect(run("agent-control", "Basic dev-control-token").status).toBe(401);
  });

  it("wrong token → 401", () => {
    expect(run("agent-control", bearer("dev-settlement-token")).status).toBe(401);
    expect(run("agent-control", bearer("dev-control-token ")).status).toBe(401);
    expect(run("agent-control", bearer("")).status).toBe(401);
  });

  it("correct token → next() is called and nothing is written", () => {
    const o = run("agent-control", bearer("dev-control-token"));
    expect(o).toEqual({ nextCalled: true });
  });

  it("the 401 body never names the expected role", () => {
    for (const role of Object.keys(ROLE_TOKEN_VAR) as Role[]) {
      const body = JSON.stringify(run(role, bearer("nope")).body);
      expect(body).toBe('{"error":"unauthorized"}');
      expect(body).not.toContain(role);
      expect(body).not.toContain(ROLE_TOKEN_VAR[role]);
    }
  });

  it("every role rejects every other role's token", () => {
    const roles = Object.keys(ROLE_TOKEN_VAR) as Role[];
    for (const guard of roles) {
      for (const caller of roles) {
        const o = run(guard, bearer(DEV_TOKENS[ROLE_TOKEN_VAR[caller]]!));
        expect(o.nextCalled, `${caller} token on ${guard} route`).toBe(guard === caller);
      }
    }
  });

  it("tokensMatch compares by value, not by length shortcut", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
  });
});

describe("role separation must-fail proof backing T-E2E-05 (007 T033)", () => {
  // The control token presented on /v1/reconcile must be refused. This is what makes T-E2E-05 pass.
  const callReconcile = (roles: Record<string, Role>) =>
    run(roles["POST /v1/reconcile"]!, bearer("dev-control-token"), DEV_TOKENS[ROLE_TOKEN_VAR[roles["POST /v1/reconcile"]!]]);

  it("with the real endpoint table, CONTROL_TOKEN on /v1/reconcile → 401", () => {
    expect(callReconcile(ENDPOINT_ROLES).status).toBe(401);
  });

  it("if /v1/reconcile accepted agent-control, the T-E2E-05 expectation would fail", () => {
    const broken = { ...ENDPOINT_ROLES, "POST /v1/reconcile": "agent-control" as const };
    const o = callReconcile(broken);
    expect(o.status).toBeUndefined();
    expect(o.nextCalled).toBe(true);
  });

  it("each endpoint accepts exactly one role, and endpoint sets do not overlap", () => {
    expect(ENDPOINT_ROLES).toEqual({
      "POST /v1/authorize": "agent-control",
      "GET /v1/budget/:sessionId": "agent-control",
      "POST /v1/settlements": "agent-verifier",
      "POST /v1/reconcile": "verifier-control",
      "POST /v1/approvals/:authorizationId": "operator",
      "GET /v1/ledger/verify": "operator",
    });
  });
});

describe("CFG-2 role token resolution (007 T036)", () => {
  it("local + unset → dev default", () => {
    expect(tokenFor("agent-control", { NETWORK: "local" })).toBe("dev-control-token");
    expect(tokenFor("operator", {})).toBe("dev-operator-token");
  });

  it("an explicit value wins", () => {
    expect(tokenFor("verifier-control", { NETWORK: "base-sepolia", SETTLEMENT_TOKEN: "s3cret" })).toBe("s3cret");
  });

  it("an empty string is always an error", () => {
    expect(() => tokenFor("agent-control", { NETWORK: "local", CONTROL_TOKEN: "" })).toThrow(/empty CONTROL_TOKEN/);
  });

  it("off local, an unset token is an error (fail closed)", () => {
    expect(() => tokenFor("agent-verifier", { NETWORK: "base-sepolia" })).toThrow(/missing VERIFIER_TOKEN/);
  });
});

describe("CFG-2 loadEnv and §3.1 ports (007 T007, T008)", () => {
  it("loads ENV_FILE without overriding variables already set", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadEnv } = await import("../src/shared/config.js");
    const file = join(mkdtempSync(join(tmpdir(), "x402-env-")), "operator.env");
    writeFileSync(file, "X402_TEST_A=from-file\nX402_TEST_B=from-file\n");
    const saved = { ENV_FILE: process.env.ENV_FILE, B: process.env.X402_TEST_B };
    try {
      process.env.ENV_FILE = file;
      process.env.X402_TEST_B = "from-process";
      expect(loadEnv("operator")).toBe(file);
      expect(process.env.X402_TEST_A).toBe("from-file");
      expect(process.env.X402_TEST_B).toBe("from-process");
    } finally {
      delete process.env.X402_TEST_A;
      if (saved.B === undefined) delete process.env.X402_TEST_B;
      else process.env.X402_TEST_B = saved.B;
      if (saved.ENV_FILE === undefined) delete process.env.ENV_FILE;
      else process.env.ENV_FILE = saved.ENV_FILE;
    }
  });

  it("refuses a root .env and a missing explicit ENV_FILE", async () => {
    const { loadEnv } = await import("../src/shared/config.js");
    const saved = process.env.ENV_FILE;
    try {
      process.env.ENV_FILE = ".env";
      expect(() => loadEnv("l2-control")).toThrow(/root-style/);
      process.env.ENV_FILE = "env/does-not-exist.env";
      expect(() => loadEnv("l2-control")).toThrow(/ENV_FILE not found/);
    } finally {
      if (saved === undefined) delete process.env.ENV_FILE;
      else process.env.ENV_FILE = saved;
    }
  });

  it("ports default, override and validate; bind hosts are fixed loopback", async () => {
    const c = await import("../src/shared/config.js");
    expect([c.controlPort({}), c.sellerPort({}), c.facilitatorPort({}), c.settlementPort({})]).toEqual([4020, 4021, 4022, 4023]);
    expect(c.controlPort({ CONTROL_PORT: "5020" })).toBe(5020);
    expect(() => c.settlementPort({ SETTLEMENT_PORT: "abc" })).toThrow(/not a valid port/);
    expect(c.CONTROL_BIND_HOST).toBe("127.0.0.1");
    expect(c.SETTLEMENT_BIND_HOST).toBe("127.0.0.1");
    expect(c.CHAIN_PORT).toBe(8545);
    expect(c.serviceUrls({ CONTROL_PORT: "5020" }).control).toBe("http://127.0.0.1:5020");
  });
});
