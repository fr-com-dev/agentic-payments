// Feature 017: the limit on failed authentications and the undeclared-proxy warning (SPEC.md L1-6, L2-8; specs/017
// contracts/portal-edge.md "429" and "Proxy warning", contracts/hosted-agent-edge.md). T-EDGE-04..05.
// Every request of a case is sent within a few seconds, inside one window: no clock is faked.
import { afterEach, describe, expect, it } from "vitest";
import { DEV_AGENT_CLIENT } from "../scripts/dev-issuer-lib.js";
import { MAX_FAILED_AUTH_PER_ADDRESS } from "../src/shared/address-limit.js";
import { startHostedApp, type HostedTestApp, type StartHostedOptions } from "./helpers/hosted.js";
import { startPortal, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";

/** A sign-in tenant's issuer: the dev sign-in refuses a declared proxy and a forwarded request (T-EDGE-02, -03). */
const SIGN_IN_ISSUER = "https://x402-test.eu.auth0.com/";
const TENANT = { AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: "" };
const FORGED = "a.b.c";
const TOO_MANY = { error: "too many requests" };

let open: Array<PortalTestApp | HostedTestApp> = [];
afterEach(async () => {
  await Promise.all(open.map((o) => o.close()));
  open = [];
});

/** One service as the tests see it: a request with a bearer token (or none) from an address, and its log. */
interface Service {
  name: "portal" | "agent";
  /** Status, body and Retry-After of one API request. `token` null sends no Authorization header. */
  call(token: string | null, o?: { from?: string }): Promise<{ status: number; body: unknown; retryAfter: string | null }>;
  valid(): Promise<string>;
  /** A valid token that the service refuses with 403. */
  forbidden(): Promise<string>;
  /** A request that never needs a token. */
  open(path: string): Promise<number>;
  openPaths: string[];
  lines(): string[];
}

async function portalService(o: StartPortalOptions = {}): Promise<Service> {
  const p = await startPortal(o);
  open.push(p);
  const tenant = o.env?.AUTH_ISSUER === SIGN_IN_ISSUER;
  return {
    name: "portal",
    call: async (token, co = {}) => {
      const res = await fetch(`${p.base}/api/me`, {
        headers: { ...(token !== null && { authorization: `Bearer ${token}` }), ...(co.from !== undefined && { "x-forwarded-for": co.from }) },
      });
      return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
    },
    valid: () => p.token("alice", tenant ? { issuer: SIGN_IN_ISSUER } : {}),
    // A valid person's token from the agent's client: the portal's own client check refuses it (403).
    forbidden: () => p.token("alice", { azp: DEV_AGENT_CLIENT, ...(tenant && { issuer: SIGN_IN_ISSUER }) }),
    open: async (path) => (await fetch(`${p.base}${path}`)).status,
    openPaths: ["/api/config", "/healthz"],
    lines: () => p.rawLogs,
  };
}

async function agentService(o: StartHostedOptions = {}): Promise<Service> {
  const lines: string[] = [];
  const a = await startHostedApp({ log: (l) => lines.push(l), ...o });
  open.push(a);
  return {
    name: "agent",
    call: async (token, co = {}) => {
      const res = await fetch(`${a.base}/v1/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== null && { authorization: `Bearer ${token}` }),
          ...(co.from !== undefined && { "x-forwarded-for": co.from }),
        },
        body: JSON.stringify({ goal: "hi" }),
      });
      return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
    },
    valid: () => a.token("alice"),
    // A person's token without the permission agent:run: 403.
    forbidden: () => a.token("alice", { permissions: [] }),
    open: async (path) => (await fetch(`${a.base}${path}`)).status,
    openPaths: ["/healthz"],
    lines: () => lines,
  };
}

const failures = async (s: Service, n: number, from?: string) => {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await s.call(i % 2 === 0 ? FORGED : null, { ...(from !== undefined && { from }) })).status);
  return statuses;
};
const limitLines = (s: Service) => s.lines().filter((l) => l.includes("auth_failure_limit"));

const services: Array<[string, (o?: { proxied?: boolean; skip?: boolean }) => Promise<Service>]> = [
  [
    "portal",
    (o = {}) =>
      portalService({
        ...(o.proxied && { env: { ...TENANT, TRUSTED_PROXY_HOPS: "1" } }),
        ...(o.skip && { skipFailureLimit: true }),
      }),
  ],
  [
    "agent",
    (o = {}) =>
      agentService({
        ...(o.proxied && { tenant: true, env: { TRUSTED_PROXY_HOPS: "1" } }),
        ...(o.skip && { skipFailureLimit: true }),
      }),
  ],
];

describe("T-EDGE-04 failed authentications are limited per address, before any token is verified (FR-007..FR-009)", () => {
  it("T-EDGE-04 the limit is 20 failures a minute", () => {
    expect(MAX_FAILED_AUTH_PER_ADDRESS).toBe(20);
  });

  for (const [name, make] of services) {
    it(`T-EDGE-04 the ${name}: the 21st failure gets 429 with Retry-After, and so does a valid token from that address`, async () => {
      const s = await make();
      expect(await failures(s, MAX_FAILED_AUTH_PER_ADDRESS)).toEqual(Array(MAX_FAILED_AUTH_PER_ADDRESS).fill(401));
      const over = await s.call(FORGED);
      expect([over.status, over.body]).toEqual([429, TOO_MANY]);
      expect(Number(over.retryAfter)).toBeGreaterThanOrEqual(1);
      expect(Number(over.retryAfter)).toBeLessThanOrEqual(60);
      // Refused before verification: a valid token from the same address waits too.
      expect((await s.call(await s.valid())).status).toBe(429);
      // One line for the burst, however many requests it refused.
      for (let i = 0; i < 5; i++) await s.call(FORGED);
      expect(limitLines(s)).toHaveLength(1);
      const line = JSON.parse(limitLines(s)[0]!) as Record<string, unknown>;
      if (name === "portal") {
        expect(Object.keys(line).sort()).toEqual(["count", "event", "ms", "route", "status", "time"]);
        expect(line).toMatchObject({ route: "/api/*", status: 429, ms: 0, event: "auth_failure_limit", count: 20 });
      } else {
        expect(line).toEqual({ event: "auth_failure_limit", count: 20 });
      }
    });

    it(`T-EDGE-04 the ${name}: behind a declared proxy, each client address has its own count`, async () => {
      const s = await make({ proxied: true });
      expect(await failures(s, MAX_FAILED_AUTH_PER_ADDRESS, "203.0.113.7")).toEqual(Array(MAX_FAILED_AUTH_PER_ADDRESS).fill(401));
      expect((await s.call(FORGED, { from: "203.0.113.7" })).status).toBe(429);
      expect((await s.call(await s.valid(), { from: "203.0.113.8" })).status).toBe(200);
      expect((await s.call(FORGED, { from: "203.0.113.8" })).status).toBe(401);
    });

    it(`T-EDGE-04 the ${name}: what authenticates, what needs no token and what is forbidden never counts`, async () => {
      const s = await make();
      const valid = await s.valid();
      // The agent's own limit allows 20 run starts an hour per requester: 3 is well below it.
      const passes = name === "portal" ? 20 : 3;
      for (let i = 0; i < passes; i++) expect((await s.call(valid)).status).toBe(200);
      for (const path of s.openPaths) for (let i = 0; i < 50; i++) expect(await s.open(path), path).toBe(200);
      const forbidden = await s.forbidden();
      for (let i = 0; i < 25; i++) expect((await s.call(forbidden)).status).toBe(403);
      // Still 20 failures to go.
      expect(await failures(s, MAX_FAILED_AUTH_PER_ADDRESS)).toEqual(Array(MAX_FAILED_AUTH_PER_ADDRESS).fill(401));
      expect((await s.call(FORGED)).status).toBe(429);
    });

    it(`T-EDGE-04 the ${name}: no log line holds a token or a client address (FR-009, NFR-003)`, async () => {
      const s = await make({ proxied: true });
      const valid = await s.valid();
      await s.call(valid, { from: "203.0.113.8" });
      await failures(s, MAX_FAILED_AUTH_PER_ADDRESS + 3, "203.0.113.7");
      const all = s.lines().join("\n");
      expect(limitLines(s)).toHaveLength(1);
      // The request lines' route labels (`/api/me` among them) are expected; a token or an address never is.
      for (const text of [FORGED, valid, valid.split(".")[2]!, "203.0.113", "127.0.0.1", "::1"]) expect(all.includes(text), text).toBe(false);
    });

    it(`T-EDGE-04 the ${name} must-fail: with the test-only skipFailureLimit hook, failures are never limited`, async () => {
      const s = await make({ skip: true });
      const statuses = await failures(s, 40);
      expect(statuses[20]).toBe(401);
      expect(statuses[39]).toBe(401);
      expect(limitLines(s)).toEqual([]);
    });
  }
});

describe("T-EDGE-05 a service with no proxy declared says once when a proxy seems to be in front (FR-010)", () => {
  const proxyLines = (s: Service) => s.lines().filter((l) => l.includes("proxy_undeclared"));
  const sources: Array<[string, (hops?: string) => Promise<Service>]> = [
    ["portal", (hops) => portalService({ env: { ...TENANT, ...(hops !== undefined && { TRUSTED_PROXY_HOPS: hops }) } })],
    ["agent", (hops) => agentService({ tenant: true, ...(hops !== undefined && { env: { TRUSTED_PROXY_HOPS: hops } }) })],
  ];
  for (const [name, make] of sources) {
    it(`T-EDGE-05 the ${name}: one line for the first forwarded request, and every request is served as usual`, async () => {
      const s = await make();
      const valid = await s.valid();
      expect((await s.call(valid, { from: "203.0.113.7" })).status).toBe(200);
      expect((await s.call(valid, { from: "203.0.113.8" })).status).toBe(200);
      expect(proxyLines(s)).toHaveLength(1);
      const line = JSON.parse(proxyLines(s)[0]!) as Record<string, unknown>;
      if (name === "portal") expect(line).toMatchObject({ route: "/api/me", status: 200, event: "proxy_undeclared" });
      else expect(line).toEqual({ event: "proxy_undeclared" });
      expect(s.lines().join("\n")).not.toContain("203.0.113");
    });

    it(`T-EDGE-05 the ${name}: nothing with a proxy declared, and nothing without forwarding headers`, async () => {
      const declared = await make("1");
      await declared.call(await declared.valid(), { from: "203.0.113.7" });
      expect(proxyLines(declared)).toEqual([]);
      const direct = await make();
      await direct.call(await direct.valid());
      await direct.call(FORGED);
      expect(proxyLines(direct)).toEqual([]);
    });
  }
});
