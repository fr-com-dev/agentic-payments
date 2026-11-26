// Feature 017: the loopback rule and the dev sign-in that stays on the machine (SPEC.md L1-6, L2-8; specs/017
// contracts/portal-edge.md "421", contracts/hosted-agent-edge.md). T-EDGE-01..03.
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_AGENT_CLIENT, DEV_AUDIENCE, DEV_PORTAL_CLIENT } from "../scripts/dev-issuer-lib.js";
import { loadHostedConfig } from "../src/layer1-intent/hosted/config.js";
import { loadPortalConfig } from "../src/portal/config.js";
import { ConfigError } from "../src/shared/config.js";
import { DEV_ISSUER } from "../src/shared/identity-token.js";
import { FORWARDING_HEADERS, hasForwardingHeader, isLoopbackBind, isLoopbackHost, localOnly } from "../src/shared/local-only.js";
import { startHostedApp, type HostedTestApp, type StartHostedOptions } from "./helpers/hosted.js";
import { startPortal, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";
import { rawRequest } from "./helpers/raw-request.js";

/** A sign-in tenant's issuer, as its tokens carry it: with it, the dev sign-in's checks don't apply (FR-006). */
const SIGN_IN_ISSUER = "https://x402-test.eu.auth0.com/";
const BIND_MESSAGE = (name: string) => `${name} must be a loopback address with AUTH_JWKS_FILE (the local dev issuer)`;
const HOPS_MESSAGE = "TRUSTED_PROXY_HOPS must be 0 with AUTH_JWKS_FILE (the local dev issuer)";

describe("T-EDGE-01 the loopback rule (data-model.md \"Loopback name\")", () => {
  it("names this machine only by localhost, 127.0.0.1 or [::1], with or without a port", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "localhost:4025", "127.0.0.1", "127.0.0.1:4025", "[::1]", "[::1]:4025"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      "127.0.0.2",
      "0.0.0.0",
      "[::ffff:127.0.0.1]",
      "portal.example",
      "localhost.example",
      "",
      undefined,
      "::1",
      "[localhost]",
      "localhost:",
      "localhost:http",
      "127.0.0.1:4025:1",
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });

  it("binds a loopback address only with 127.0.0.1, ::1 or localhost", () => {
    for (const a of ["127.0.0.1", "::1", "localhost"]) expect(isLoopbackBind(a), a).toBe(true);
    for (const a of ["0.0.0.0", "::", "10.0.0.5", "127.0.0.2", ""]) expect(isLoopbackBind(a), a).toBe(false);
  });

  it("sees any of the five forwarding headers, whatever its case", () => {
    for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "via", "X-Forwarded-For", "VIA"]) {
      expect(hasForwardingHeader({ host: "localhost", [name]: "1" }), name).toBe(true);
    }
    expect(hasForwardingHeader({ host: "localhost", "x-real-ip": "203.0.113.1", accept: "text/html" })).toBe(false);
    expect(hasForwardingHeader({})).toBe(false);
  });
});

describe("T-EDGE-02 with the dev sign-in a service binds loopback only and trusts no proxy, or it doesn't start (FR-004)", () => {
  const portalDev = { NETWORK: "local", AUTH_ISSUER: DEV_ISSUER, AUTH_AUDIENCE: DEV_AUDIENCE, PORTAL_CLIENT_ID: DEV_PORTAL_CLIENT, AUTH_JWKS_FILE: "jwks.json" };
  const portalTenant = { ...portalDev, AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: "" };
  const agentDev = {
    NETWORK: "local",
    AGENT_TEST_MODE: "1", // 021: the agent of before 021 (NFR-006)
    MODEL_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test-key-not-used",
    AUTH_ISSUER: DEV_ISSUER,
    AUTH_AUDIENCE: DEV_AUDIENCE,
    AGENT_CLIENT_IDS: DEV_AGENT_CLIENT,
    AUTH_JWKS_FILE: "jwks.json",
    SESSION_REF_SECRET: "ab".repeat(32),
  };
  const agentTenant = { ...agentDev, AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: "" };

  const refusal = (load: () => unknown): ConfigError => {
    try {
      load();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return err as ConfigError;
    }
    throw new Error("expected a ConfigError");
  };

  for (const [service, load, dev, tenant, bindName] of [
    ["portal", loadPortalConfig, portalDev, portalTenant, "PORTAL_BIND_HOST"],
    ["agent", loadHostedConfig, agentDev, agentTenant, "AGENT_BIND_HOST"],
  ] as const) {
    it(`T-EDGE-02 the ${service}: a public bind and a declared proxy refuse to start, naming the setting and never its value`, () => {
      for (const address of ["0.0.0.0", "::", "10.0.0.5"]) {
        const err = refusal(() => load({ ...dev, [bindName]: address }));
        expect(err.message, address).toBe(BIND_MESSAGE(bindName));
        expect(err.message).not.toContain(address);
      }
      expect(refusal(() => load({ ...dev, TRUSTED_PROXY_HOPS: "1" })).message).toBe(HOPS_MESSAGE);
      for (const address of ["127.0.0.1", "::1", "localhost"]) expect(load({ ...dev, [bindName]: address }).bindHost, address).toBe(address);
      expect(load({ ...dev, TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops).toBe(0);
    });

    it(`T-EDGE-02 the ${service} with the sign-in tenant: a public bind and a declared proxy are allowed (FR-006)`, () => {
      const c = load({ ...tenant, [bindName]: "0.0.0.0", TRUSTED_PROXY_HOPS: "1" });
      expect([c.bindHost, c.trustedProxyHops]).toEqual(["0.0.0.0", 1]);
    });
  }
});

describe("T-EDGE-03 with the dev sign-in a service answers only requests from the machine itself (FR-005)", () => {
  let open: Array<PortalTestApp | HostedTestApp> = [];
  const portal = async (o: StartPortalOptions = {}) => {
    const p = await startPortal(o);
    open.push(p);
    return p;
  };
  const agent = async (o: StartHostedOptions = {}) => {
    const a = await startHostedApp(o);
    open.push(a);
    return a;
  };
  afterEach(async () => {
    await Promise.all(open.map((o) => o.close()));
    open = [];
  });

  const MISDIRECTED = { error: "misdirected request" };
  const runBody = JSON.stringify({ goal: "hi" });
  /** The routes each service answers before anything else: health, then one that needs no token or one that does. */
  const portalPaths = [{ path: "/healthz" }, { path: "/api/config" }, { path: "/api/me" }];
  const agentPaths = [{ path: "/healthz" }, { path: "/v1/runs", method: "POST", body: runBody, headers: { "content-type": "application/json" } }];

  const refusedEverywhere = async (base: string, paths: Array<{ path: string; method?: string; body?: string; headers?: Record<string, string> }>) => {
    const cases: Array<[string, { host?: string; headers?: Record<string, string> }]> = [
      ["a public host name", { host: "portal.example" }],
      ["a public host name with the port", { host: "portal.example:4025" }],
      ["another loopback-looking name", { host: "localhost.example" }],
      ["127.0.0.2", { host: "127.0.0.2" }],
      ...FORWARDING_HEADERS.map((name): [string, { headers: Record<string, string> }] => [`${name} on a loopback host`, { headers: { [name]: "203.0.113.9" } }]),
    ];
    for (const route of paths) {
      for (const [name, o] of cases) {
        const r = await rawRequest(base, { ...route, ...o, headers: { ...route.headers, ...o.headers } });
        expect([r.status, r.json], `${route.path}: ${name}`).toEqual([421, MISDIRECTED]);
        // The answer never says why, nor that a dev sign-in exists.
        expect(r.body).not.toMatch(/dev|jwks|issuer|loopback/i);
        expect(r.headers["www-authenticate"]).toBeUndefined();
      }
    }
  };

  it("T-EDGE-03 the portal: a public name or any forwarding header gets 421 before any route; the machine is served", async () => {
    const p = await portal();
    await refusedEverywhere(p.base, portalPaths);
    // The portal's 421 is an answer like any other: its policies, and HSTS for the public name.
    const r = await rawRequest(p.base, { path: "/healthz", host: "portal.example" });
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    const port = new URL(p.base).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "LOCALHOST"]) {
      const ok = await rawRequest(p.base, { path: "/healthz", host });
      expect([ok.status, ok.json], host).toEqual([200, { status: "ok" }]);
    }
    expect((await rawRequest(p.base, { path: "/api/config" })).status).toBe(200);
    // A request that names no host at all is refused before the app: Node answers 400 to an HTTP/1.1 request
    // without Host, and the check itself answers 421 (below), so it is never served (NFR-004).
    expect([400, 421]).toContain((await rawRequest(p.base, { path: "/healthz", host: null })).status);
  });

  it("T-EDGE-03 the agent: a public name or any forwarding header gets 421 before any route; the machine is served", async () => {
    const a = await agent();
    await refusedEverywhere(a.base, agentPaths);
    const port = new URL(a.base).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const ok = await rawRequest(a.base, { path: "/healthz", host });
      expect([ok.status, ok.json], host).toEqual([200, { status: "ok" }]);
    }
    expect((await a.run("alice", { goal: "hi" })).status).toBe(200);
    expect([400, 421]).toContain((await rawRequest(a.base, { path: "/healthz", host: null })).status);
  });

  it("T-EDGE-03 the check itself refuses a request with no Host header (fail closed, NFR-004)", () => {
    const sent: unknown[] = [];
    let passed = false;
    const res = { status: (code: number) => ({ json: (body: unknown) => sent.push(code, body) }) } as unknown as Response;
    for (const headers of [{}, { host: "" }]) localOnly()({ headers } as Request, res, () => (passed = true));
    expect(passed).toBe(false);
    expect(sent).toEqual([421, MISDIRECTED, 421, MISDIRECTED]);
  });

  it("T-EDGE-03 with the sign-in tenant, a public name and a declared proxy are served (FR-006, US2 scenario 4)", async () => {
    const p = await portal({ env: { AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: "", TRUSTED_PROXY_HOPS: "1" } });
    const a = await agent({ tenant: true, env: { TRUSTED_PROXY_HOPS: "1" } });
    for (const base of [p.base, a.base]) {
      const r = await rawRequest(base, { path: "/healthz", host: "portal.example", headers: { "x-forwarded-for": "203.0.113.9" } });
      expect([r.status, r.json], base).toEqual([200, { status: "ok" }]);
    }
  });

  it("T-EDGE-03 must-fail: with the test-only skipLocalOnly hook, a dev-mode service answers a public name", async () => {
    const p = await portal({ skipLocalOnly: true });
    const a = await agent({ skipLocalOnly: true });
    for (const base of [p.base, a.base]) expect((await rawRequest(base, { path: "/healthz", host: "portal.example" })).status, base).toBe(200);
  });
});
