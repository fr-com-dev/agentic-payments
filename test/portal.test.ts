// Feature 013: the portal backend (SPEC.md §8.2 L2-8; specs/013 contracts/portal-api.md). T-PRT-01..09.
// The real createPortalApp runs against an in-process L2 with user accounts on, the dev issuer and a fake balance
// reader (test/helpers/portal.ts). Card routes are covered in test/card-vault.test.ts.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_AGENT_CLIENT, DEV_AUDIENCE, DEV_PORTAL_CLIENT } from "../scripts/dev-issuer-lib.js";
import { createBalanceCache } from "../src/portal/balance.js";
import { loadPortalConfig } from "../src/portal/config.js";
import { LOG_KEYS } from "../src/portal/log.js";
import { endOfDayUtc, parsePolicyInput } from "../src/portal/routes.js";
import { ProfileStore, validDisplayName, validEmail, validPolicyName } from "../src/portal/profile-store.js";
import { contentSecurityPolicy, MAX_REQUESTS_PER_MINUTE, signInOriginOf } from "../src/portal/server.js";
import { DEV_DIRECTORY_ISSUER } from "../src/shared/identity-token.js";
import { userIdFor } from "../src/shared/user-id.js";
import { OTHER_HOST, SELLER_HOST, STEP_UP_AGE, T0, TEST_MNEMONIC, TOKENS } from "./helpers/users.js";
import { startPortal, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";

let open: PortalTestApp[] = [];
const start = async (o: StartPortalOptions = {}) => {
  const p = await startPortal(o);
  open.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(open.map((p) => p.close()));
  open = [];
});

/** A sign-in tenant's issuer, as its tokens carry it (013 research R19). */
const SIGN_IN_ISSUER = "https://x402-test.eu.auth0.com/";

const PROFILE = { displayName: "Ana Pérez", contactEmail: "ana.perez@example.com", acknowledgedTestFunds: true };
const POLICY = {
  name: "Research APIs",
  sellers: [SELLER_HOST],
  autoApproveUsdc: "0.02",
  perPaymentUsdc: "0.10",
  perRunUsdc: "0.10",
  perDayUsdc: "0.50",
  paymentsPerMinute: 10,
  endsOn: "2026-12-31",
  paymentMethod: "crypto_account",
};

/** Profile, wallet and one policy for `subject`, through the portal's own routes. Returns the policy ID. */
async function onboard(p: PortalTestApp, subject: string, policy: Record<string, unknown> = {}): Promise<string> {
  const me = p.as(subject);
  expect((await me("PUT", "/api/profile", PROFILE)).status).toBe(200);
  expect((await me("PUT", "/api/wallet/account")).status).toBe(200);
  const created = await me("POST", "/api/policies", { ...POLICY, ...policy });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return String(created.body.policyId);
}

// ---------------------------------------------------------------------------
// T-PRT-09: configuration and the entry point
// ---------------------------------------------------------------------------

describe("T-PRT-09 configuration and the entry point (CFG-2, INV-2)", () => {
  const dev = { NETWORK: "local", AUTH_ISSUER: "urn:x402:dev-issuer", AUTH_AUDIENCE: "api://x402-l1-agent", PORTAL_CLIENT_ID: "x402-portal-dev", AUTH_JWKS_FILE: "jwks.json" };
  const TENANT = { NETWORK: "base-sepolia", PORTAL_TOKEN: "t", AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_AUDIENCE: "https://x402.example/api", PORTAL_CLIENT_ID: "PortalSpaClient0123456789abcdefg" };

  it("T-PRT-09 the local dev settings load, with the defaults", () => {
    const c = loadPortalConfig(dev);
    expect(c.auth).toEqual({
      mode: "dev",
      issuer: "urn:x402:dev-issuer",
      audience: "api://x402-l1-agent",
      clientId: "x402-portal-dev",
      jwksFile: "jwks.json",
      authTimeClaim: "https://x402.dev/auth_time",
    });
    expect([c.port, c.bindHost, c.profileDir, c.portalToken, c.apiDocs, c.cardVault]).toEqual([4025, "127.0.0.1", ".local/portal/profiles", "dev-portal-token", false, undefined]);
  });

  it("T-PRT-09 each error names the variable and never a value", () => {
    const bad: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ ...dev, AUTH_ISSUER: undefined }, /AUTH_ISSUER is required/],
      [{ ...dev, AUTH_AUDIENCE: "" }, /AUTH_AUDIENCE is required/],
      [{ ...dev, PORTAL_CLIENT_ID: undefined }, /PORTAL_CLIENT_ID is required/],
      [{ ...dev, PORTAL_CLIENT_ID: "two clients" }, /PORTAL_CLIENT_ID must be the portal's client ID/],
      [{ ...dev, NETWORK: "base-sepolia", PORTAL_TOKEN: "t" }, /AUTH_JWKS_FILE is allowed only with NETWORK=local/],
      [{ ...dev, NETWORK: "mainnet" }, /unknown network/],
      // The dev issuer's keys go with the dev issuer's name only, and a tenant's name needs the tenant's keys.
      [{ ...dev, AUTH_ISSUER: SIGN_IN_ISSUER }, /AUTH_ISSUER must be urn:x402:dev-issuer with AUTH_JWKS_FILE/],
      [{ ...dev, AUTH_JWKS_FILE: undefined }, /AUTH_ISSUER must be the sign-in tenant's issuer/],
      [{ ...TENANT, AUTH_ISSUER: SIGN_IN_ISSUER.slice(0, -1) }, /AUTH_ISSUER must be the sign-in tenant's issuer/],
      [{ ...TENANT, AUTH_ISSUER: "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0" }, /AUTH_ISSUER must be the sign-in tenant's issuer/],
      [{ ...TENANT, AUTH_TIME_CLAIM: "auth_time" }, /AUTH_TIME_CLAIM must be a namespaced claim name/],
      [{ ...TENANT, PORTAL_TOKEN: undefined }, /missing PORTAL_TOKEN/],
      [{ ...dev, PORTAL_PORT: "99999" }, /PORTAL_PORT is not a valid port/],
      [{ ...dev, API_DOCS: "yes" }, /API_DOCS must be 1 or 0/],
      [{ ...dev, CARD_VAULT: "adyen" }, /CARD_VAULT must be "stripe" or unset/],
    ];
    for (const [env, message] of bad) expect(() => loadPortalConfig(env), String(message)).toThrow(message);
  });

  it("T-PRT-09 against the sign-in tenant: its issuer, the API's identifier, the portal's client and the sign-in time claim", () => {
    const c = loadPortalConfig(TENANT);
    expect(c.auth).toEqual({
      mode: "auth0",
      issuer: SIGN_IN_ISSUER,
      audience: "https://x402.example/api",
      clientId: "PortalSpaClient0123456789abcdefg",
      authTimeClaim: "https://x402.dev/auth_time",
    });
    expect(loadPortalConfig({ ...TENANT, AUTH_TIME_CLAIM: "https://example.org/signed_in_at" }).auth.authTimeClaim).toBe("https://example.org/signed_in_at");
    // The earlier sign-in's settings are gone: they are neither needed nor read.
    expect(JSON.stringify(loadPortalConfig({ ...TENANT, AUTH_TENANT_ID: "contoso", PORTAL_SCOPE: "api://x/Portal.Access" }).auth)).not.toMatch(/contoso|Portal\.Access/);
  });

  const runEntry = (env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/portal-main.ts"], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ENV_FILE: "env/portal.env.example", PORTAL_PORT: "0", ...env },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });

  it("T-PRT-09 the entry point exits 1 when a payment key is visible, naming it and printing no value", async () => {
    const key = `0x${"ab".repeat(32)}`;
    const payer = await runEntry({ PAYER_PRIVATE_KEY: key });
    expect(payer.code).toBe(1);
    expect(payer.out).toContain("refusing to start: PAYER_PRIVATE_KEY is visible to the portal process");
    expect(payer.out).not.toContain(key);
    const mnemonic = await runEntry({ USER_WALLET_MNEMONIC: TEST_MNEMONIC });
    expect(mnemonic.code).toBe(1);
    expect(mnemonic.out).toContain("refusing to start: USER_WALLET_MNEMONIC is visible to the portal process");
    expect(mnemonic.out).not.toContain("sausage");
    expect(mnemonic.out).not.toContain("listening");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T-PRT-01: access
// ---------------------------------------------------------------------------

describe("T-PRT-01 access (FR-003, FR-005, SEC-19, SEC-20)", () => {
  it("T-PRT-01 /api/config needs no token and holds public values only", async () => {
    const p = await start();
    const res = await p.call("GET", "/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      auth: { mode: "dev", domain: "", clientId: "x402-portal-dev", audience: "api://x402-l1-agent" },
      network: "local",
      cards: { available: false },
    });
    expect(res.text).not.toContain(TOKENS.portal);
  });

  it("T-PRT-01 each row of the access table: 401 or 403, with a fixed body, no call to L2 and nothing written", async () => {
    const p = await start();
    const nowSec = Math.floor(p.l2.clock.now() / 1000);
    const entriesBefore = p.l2.ledger.entries().length;
    const cases: Array<[string, Parameters<typeof p.token>[1], number]> = [
      // 401: not a valid token of the sign-in tenant.
      ["expired", { exp: Math.floor(Date.now() / 1000) - 120 }, 401],
      ["not yet valid", { nbf: Math.floor(Date.now() / 1000) + 300 }, 401],
      ["wrong audience", { audience: "api://someone-else" }, 401],
      ["another sign-in tenant", { issuer: SIGN_IN_ISSUER }, 401],
      ["the organization's directory as issuer", { issuer: "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0" }, 401],
      ["the dev directory as issuer", { issuer: DEV_DIRECTORY_ISSUER }, 401],
      ["no subject", { sub: null }, 401],
      ["an empty subject", { sub: "" }, 401],
      // 403: valid, but not allowed here.
      ["a machine token of the sign-in tenant", { sub: "x402-portal-dev@clients", claims: { gty: "client-credentials" } }, 403],
      ["a machine token by its subject alone", { sub: "some-client@clients" }, 403],
      ["an agent client", { azp: DEV_AGENT_CLIENT }, 403],
      ["another client", { azp: "some-other-client" }, 403],
      ["no client", { azp: null }, 403],
      ["two client claims that disagree", { claims: { client_id: DEV_AGENT_CLIENT } }, 403],
      ["no permission", { permissions: [] }, 403],
      ["no permissions claim", { permissions: null }, 403],
      ["another permission", { permissions: ["agent:read"] }, 403],
      ["the directory's role instead of the permission", { permissions: null, claims: { roles: ["Agent.Run"] } }, 403],
      // 401, checked last: the portal's own token, without a usable sign-in time.
      ["a sign-in time in the future", { authTime: nowSec + 600 }, 401],
      ["a sign-in time that is not a whole number", { authTime: nowSec + 0.5 }, 401],
      ["a sign-in time as text", { authTime: String(nowSec) }, 401],
      ["the sign-in time under another claim name", { authTimeClaim: "auth_time" }, 401],
    ];
    for (const [name, o, status] of cases) {
      const res = await p.call("GET", "/api/me", { token: await p.token("alice", o) });
      expect(res.status, name).toBe(status);
      expect(res.body, name).toEqual(status === 401 ? { error: "unauthorized" } : { error: "forbidden" });
    }
    // No sign-in time at all, from the portal's own client: 401. From an agent client: 403, with the claim or not.
    const noAuthTime = await p.agentToken("alice", { azp: DEV_PORTAL_CLIENT });
    expect((await p.call("GET", "/api/me", { token: noAuthTime })).status).toBe(401);
    expect((await p.call("GET", "/api/me", { token: await p.agentToken("alice") })).status).toBe(403);
    expect((await p.call("GET", "/api/me", { token: await p.agentToken("alice", { authTime: nowSec }) })).status).toBe(403);
    // The other dialect of the tenant's tokens names the client in `client_id`: the same person gets in.
    expect((await p.call("GET", "/api/me", { token: await p.token("alice", { clientClaim: "client_id" }) })).status).toBe(200);
    for (const token of [undefined, "not-a-jwt"]) {
      const res = await p.call("PUT", "/api/profile", { ...(token !== undefined && { token }), body: PROFILE });
      expect(res.status).toBe(401);
    }
    expect(p.l2.ledger.entries().length).toBe(entriesBefore);
    expect(existsSync(p.profilesDir)).toBe(false);
  });

  it("T-PRT-01 no role token opens the portal: the agent's, the verifier's, the operator's, or the portal's own (FR-005)", async () => {
    const p = await start();
    const before = p.l2.entries().length;
    // The tokens this L2 verifies, and the local dev defaults of all five roles: none is a person's sign-in.
    const roleTokens = [...Object.values(TOKENS), "dev-control-token", "dev-verifier-token", "dev-settlement-token", "dev-operator-token", "dev-portal-token"];
    for (const token of roleTokens) {
      for (const [method, path] of [
        ["GET", "/api/me"],
        ["PUT", "/api/profile"],
        ["GET", "/api/wallet"],
        ["POST", "/api/policies"],
        ["POST", "/api/account/disable"],
      ] as const) {
        const res = await p.call(method, path, { token, ...(method !== "GET" && { body: {} }) });
        expect([res.status, res.body], `${token} ${method} ${path}`).toEqual([401, { error: "unauthorized" }]);
      }
    }
    expect(p.l2.entries().length).toBe(before);
    expect(existsSync(p.profilesDir)).toBe(false);
  });

  it("T-PRT-01 a token issued for the agent service is refused, on every route (FR-005)", async () => {
    const p = await start();
    const agent = await p.agentToken("alice");
    for (const token of [agent]) {
      for (const [method, path] of [
        ["GET", "/api/me"],
        ["PUT", "/api/profile"],
        ["GET", "/api/wallet"],
        ["PUT", "/api/wallet/account"],
        ["GET", "/api/policies"],
        ["POST", "/api/policies"],
        ["POST", "/api/account/disable"],
        ["GET", "/api/platform"],
      ] as const) {
        expect((await p.call(method, path, { token, body: method === "GET" ? undefined : PROFILE })).status, `${method} ${path}`).toBe(403);
      }
    }
    expect(existsSync(p.profilesDir)).toBe(false);
  });

  it("T-PRT-01 a token of the organization's directory is not valid here at all: a system identity's or a person's (401)", async () => {
    const p = await start();
    const before = p.l2.entries().length;
    const tokens = [
      await p.agentToken("svc-app-id", { service: true }),
      // Even made to look as much like the portal's own token as the directory could.
      await p.agentToken("alice", { service: true, audience: DEV_AUDIENCE, claims: { azp: DEV_PORTAL_CLIENT, permissions: ["agent:run"], "https://x402.dev/auth_time": Math.floor(p.l2.clock.now() / 1000) } }),
      await p.agentToken("alice", { service: true, idtyp: "user", claims: { scp: "Portal.Access", roles: ["Agent.Run"], auth_time: Math.floor(p.l2.clock.now() / 1000) } }),
    ];
    for (const token of tokens) {
      for (const [method, path] of [["GET", "/api/me"], ["PUT", "/api/profile"], ["POST", "/api/policies"]] as const) {
        const res = await p.call(method, path, { token, ...(method !== "GET" && { body: PROFILE }) });
        expect([res.status, res.body], `${method} ${path}`).toEqual([401, { error: "unauthorized" }]);
      }
    }
    expect(p.l2.entries().length).toBe(before);
    expect(existsSync(p.profilesDir)).toBe(false);
  });

  it("T-PRT-01 against a sign-in tenant: its tokens open the portal, the dev issuer's do not, and the settings name its domain", async () => {
    // The tenant's name with the test's own keys: everything but the JWKS download is the real path.
    const p = await start({ env: { AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: "" } });
    expect(p.config.auth.mode).toBe("auth0");
    expect((await p.call("GET", "/api/config")).body).toMatchObject({
      auth: { mode: "auth0", domain: "x402-test.eu.auth0.com", clientId: "x402-portal-dev", audience: "api://x402-l1-agent" },
    });
    const sub = "auth0|6543210fedcba";
    const res = await p.call<{ userId: string }>("GET", "/api/me", { token: await p.token("alice", { issuer: SIGN_IN_ISSUER, sub }) });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userIdFor(SIGN_IN_ISSUER, sub));
    expect(res.body.userId).toBe(userIdFor("https://x402-test.eu.auth0.com", sub));
    expect((await p.call("GET", "/api/me", { token: await p.token("alice") })).status).toBe(401);
  });

  it("T-PRT-01 the user is the issuer and the subject: the same name from another connection is another person", async () => {
    const p = await start();
    const id = async (o: Parameters<typeof p.token>[1]) => (await p.call<{ userId: string }>("GET", "/api/me", { token: await p.token("alice", o) })).body.userId;
    expect(await id({})).toBe(p.userId("alice"));
    expect(await id({})).toBe(userIdFor("urn:x402:dev-issuer", "dev|alice"));
    expect(await id({ sub: "google-oauth2|alice" })).not.toBe(p.userId("alice"));
    // A subject with the old separator inside is accepted as it is.
    expect(await id({ sub: "dev|a|b" })).toBe(userIdFor("urn:x402:dev-issuer", "dev|a|b"));
  });

  it("T-PRT-01 a person without the permission to start agent runs is refused, and no profile exists afterwards (US1 scenario 4)", async () => {
    const p = await start();
    const res = await p.call("PUT", "/api/profile", { token: await p.token("mallory", { permissions: [] }), body: PROFILE });
    expect(res.status).toBe(403);
    expect(existsSync(p.profilesDir)).toBe(false);
    expect(p.l2.entries("USER_REGISTERED")).toEqual([]);
  });

  it("T-PRT-01 must-fail: with the test-only bypassAuth hook, an agent-service token reaches a route", async () => {
    const p = await start({ bypassAuth: true });
    expect((await p.call("GET", "/api/me", { token: await p.agentToken("alice") })).status).toBe(200);
  });

  it("T-PRT-01 a caller without a valid token is limited per address, before any token is verified", async () => {
    const p = await start({ maxRequestsPerAddress: 3 });
    const noToken = () => fetch(`${p.base}/api/me`);
    for (let i = 0; i < 3; i++) expect((await noToken()).status).toBe(401);
    const over = await noToken();
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "too many requests" });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    // A forged token is refused by the limit, not examined; and a real one from the same address waits too.
    expect((await fetch(`${p.base}/api/me`, { headers: { authorization: "Bearer not-a-jwt" } })).status).toBe(429);
    expect((await p.call("GET", "/api/me", { token: await p.token("alice") })).status).toBe(429);
    // What needs no token is not counted: health, and the public settings.
    expect((await fetch(`${p.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${p.base}/api/config`)).status).toBe(200);
    expect(p.l2.entries("USER_REGISTERED")).toEqual([]);
  });

  it("T-PRT-01 must-fail: with the test-only skipAddressLimit hook, token-less requests are never limited", async () => {
    const p = await start({ maxRequestsPerAddress: 3, skipAddressLimit: true });
    for (let i = 0; i < 12; i++) expect((await fetch(`${p.base}/api/me`)).status).toBe(401);
  });

  it("T-PRT-01 behind a trusted proxy each client address has its own count; without one the header is ignored", async () => {
    const from = (base: string, address: string) => fetch(`${base}/api/me`, { headers: { "x-forwarded-for": address } }).then((r) => r.status);
    const proxied = await start({ maxRequestsPerAddress: 2, env: { TRUSTED_PROXY_HOPS: "1" } });
    expect([await from(proxied.base, "203.0.113.7"), await from(proxied.base, "203.0.113.7"), await from(proxied.base, "203.0.113.7")]).toEqual([401, 401, 429]);
    expect(await from(proxied.base, "203.0.113.8")).toBe(401);
    // Not behind a proxy: a caller can't pick its own address by sending the header.
    const direct = await start({ maxRequestsPerAddress: 2 });
    expect([await from(direct.base, "203.0.113.7"), await from(direct.base, "203.0.113.8"), await from(direct.base, "203.0.113.9")]).toEqual([401, 401, 429]);
  });

  it("T-PRT-09 TRUSTED_PROXY_HOPS is a whole number from 0 to 3, and 0 by default", async () => {
    const { trustedProxyHops } = await import("../src/shared/address-limit.js");
    expect([trustedProxyHops({}), trustedProxyHops({ TRUSTED_PROXY_HOPS: "" }), trustedProxyHops({ TRUSTED_PROXY_HOPS: "0" }), trustedProxyHops({ TRUSTED_PROXY_HOPS: "1" })]).toEqual([0, 0, 0, 1]);
    for (const bad of ["true", "-1", "4", "1.5", "one", "10"]) expect(() => trustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), bad).toThrow(/TRUSTED_PROXY_HOPS must be a whole number from 0 to 3/);
  });

  it("T-PRT-01 the 121st request in a minute gets 429 with Retry-After; another person is unaffected", async () => {
    const p = await start();
    const token = await p.token("alice");
    for (let i = 0; i < MAX_REQUESTS_PER_MINUTE; i++) expect((await p.call("GET", "/api/platform", { token })).status).toBe(200);
    const over = await p.call("GET", "/api/platform", { token });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await p.as("bob")("GET", "/api/platform")).status).toBe(200);
    p.l2.clock.advance(61_000);
    expect((await p.as("alice")("GET", "/api/platform")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// T-PRT-03: profile (US1)
// ---------------------------------------------------------------------------

describe("T-PRT-03 profile (US1, FR-008..FR-011)", () => {
  it("T-PRT-03 a new person: three steps, none done, no profile", async () => {
    const p = await start();
    const res = await p.as("alice")("GET", "/api/me");
    expect(res.body).toEqual({ userId: p.userId("alice"), enabled: true, onboarding: { profile: false, wallet: false, policy: false } });
  });

  it("T-PRT-03 the first save writes the profile, then registers the user at L2", async () => {
    const p = await start();
    const res = await p.as("alice")("PUT", "/api/profile", { ...PROFILE, displayName: "  Ana Pérez  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: p.userId("alice"),
      enabled: true,
      onboarding: { profile: true, wallet: false, policy: false },
      profile: { displayName: "Ana Pérez", contactEmail: "ana.perez@example.com" },
    });
    expect(p.l2.entries("USER_REGISTERED").map((e) => e.data.userId)).toEqual([p.userId("alice")]);
    const file = join(p.profilesDir, `${p.userId("alice")}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ userId: p.userId("alice"), displayName: "Ana Pérez", contactEmail: "ana.perez@example.com", policyNames: {} });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Signing in again later: the saved values, and the wallet as the next step (US1 scenario 3).
    expect((await p.as("alice")("GET", "/api/me")).body).toMatchObject({ onboarding: { profile: true, wallet: false }, profile: { displayName: "Ana Pérez" } });
  });

  it("T-PRT-03 validation: every issue by field, and nothing written", async () => {
    const p = await start();
    const me = p.as("alice");
    const issues = async (body: Record<string, unknown>) => {
      const res = await me("PUT", "/api/profile", body);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_profile");
      return (res.body.issues as { field: string; code: string }[]).map((i) => `${i.field}:${i.code}`);
    };
    expect(await issues({ displayName: "", contactEmail: "ana@example.com", acknowledgedTestFunds: true })).toEqual(["displayName:invalid_name"]);
    expect(await issues({ displayName: "x".repeat(81), contactEmail: "nope", acknowledgedTestFunds: true })).toEqual(["displayName:invalid_name", "contactEmail:invalid_email"]);
    expect(await issues({ displayName: "Ana\u0000", contactEmail: "a@b@c.com" })).toEqual(["displayName:invalid_name", "contactEmail:invalid_email", "acknowledgedTestFunds:required"]);
    expect(await issues({ displayName: "Ana", contactEmail: "ana@example.com" })).toEqual(["acknowledgedTestFunds:required"]);
    expect(await issues({ displayName: "Ana", contactEmail: "ana@example.com", acknowledgedTestFunds: false })).toEqual(["acknowledgedTestFunds:required"]);
    expect((await me("PUT", "/api/profile", { ...PROFILE, role: "admin" })).status).toBe(400);
    expect((await me("PUT", "/api/profile", { ...PROFILE, userId: p.userId("bob") })).status).toBe(400);
    expect(existsSync(p.profilesDir)).toBe(false);
    expect(p.l2.entries("USER_REGISTERED")).toEqual([]);
  });

  it("T-PRT-03 the field rules: names, emails and policy names", () => {
    expect(validDisplayName("x".repeat(80))).toBe("x".repeat(80));
    expect([validDisplayName(" "), validDisplayName(7), validDisplayName("a\tb")]).toEqual([undefined, undefined, undefined]);
    expect(validEmail(" ana@example.com ")).toBe("ana@example.com");
    for (const bad of ["ana", "ana@", "@example.com", "ana@example", "ana @example.com", "ana@example..com", `${"a".repeat(250)}@x.co`]) {
      expect(validEmail(bad), bad).toBeUndefined();
    }
    expect(validPolicyName("x".repeat(60))).toBe("x".repeat(60));
    expect([validPolicyName("x".repeat(61)), validPolicyName("")]).toEqual([undefined, undefined]);
  });

  it("T-PRT-03 a later edit changes the file and writes nothing to L2 (FR-010)", async () => {
    const p = await start();
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    const before = p.l2.ledger.entries().length;
    const res = await me("PUT", "/api/profile", { displayName: "Ana P.", contactEmail: "ana@work.example" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toEqual({ displayName: "Ana P.", contactEmail: "ana@work.example" });
    expect(p.l2.ledger.entries().length).toBe(before);
  });

  it("T-PRT-03 the store never builds a path from anything but a user identifier, and trusts a file only for its own user", () => {
    const store = new ProfileStore("/tmp/never-used");
    for (const bad of ["../../etc/passwd", "usr_ZZ", "alice", ""]) expect(() => store.get(bad), bad).toThrow(/not a user identifier/);
  });
});

// ---------------------------------------------------------------------------
// T-PRT-04: wallet (US2)
// ---------------------------------------------------------------------------

describe("T-PRT-04 wallet (US2, FR-013..FR-016)", () => {
  it("T-PRT-04 no profile: 409; then one account, the same on a second call", async () => {
    const p = await start();
    const me = p.as("alice");
    expect((await me("GET", "/api/wallet")).body).toEqual({ error: "profile_required" });
    expect((await me("PUT", "/api/wallet/account")).body).toEqual({ error: "profile_required" });
    await me("PUT", "/api/profile", PROFILE);
    expect((await me("GET", "/api/wallet")).body).toEqual({ cards: [], cardsAvailable: false, disabled: false });
    const first = await me<{ account: { address: string } }>("PUT", "/api/wallet/account");
    const second = await me<{ account: { address: string } }>("PUT", "/api/wallet/account");
    expect(first.status).toBe(200);
    expect(second.body.account.address).toBe(first.body.account.address);
    expect(first.body.account.address).toBe(p.l2.keyring.addressOf(0));
    expect(p.l2.entries("WALLET_CREATED")).toHaveLength(1);
  });

  it("T-PRT-04 the view: balance with its read time, L2's figures, and no key anywhere", async () => {
    let balance = 0n;
    let reads = 0;
    const p = await start({
      balance: {
        balanceOf: async () => {
          reads++;
          return balance;
        },
      },
    });
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    const created = await me("PUT", "/api/wallet/account");
    expect(created.body.account).toEqual({
      address: p.l2.keyring.addressOf(0),
      network: "eip155:31337",
      asset: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      decimals: 6,
      balanceAtomic: "0",
      balanceReadAt: new Date(T0).toISOString(),
      balanceStale: false,
      committedAtomic: "0",
      spent24hAtomic: "0",
      dailyCeilingAtomic: "500000",
      dailyRemainingAtomic: "500000",
      lowBalance: false,
    });
    // Funds arrive. Within 20 s the cached value is served; after it, the reader is asked again (FR-015).
    balance = 1_000_000n;
    p.l2.clock.advance(19_000);
    expect((await me("GET", "/api/wallet")).body.account).toMatchObject({ balanceAtomic: "0" });
    expect(reads).toBe(1);
    p.l2.clock.advance(2_000);
    const fresh = await me("GET", "/api/wallet");
    expect(fresh.body.account).toMatchObject({ balanceAtomic: "1000000", balanceReadAt: new Date(T0 + 21_000).toISOString(), balanceStale: false });
    expect(reads).toBe(2);
    expect(fresh.text).not.toMatch(/sausage|winner/);
    expect(fresh.text).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("T-PRT-04 when the read fails, the last value comes back marked stale and the rest of the view is intact", async () => {
    let fail = false;
    const p = await start({
      balance: {
        balanceOf: async () => {
          if (fail) throw new Error("rpc down");
          return 250_000n;
        },
      },
    });
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    await me("PUT", "/api/wallet/account");
    fail = true;
    p.l2.clock.advance(60_000);
    const res = await me("GET", "/api/wallet");
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ balanceAtomic: "250000", balanceReadAt: new Date(T0).toISOString(), balanceStale: true, dailyCeilingAtomic: "500000" });
  });

  it("T-PRT-04 a balance never read and unreadable: no figure, marked stale, never a made-up zero", async () => {
    const cache = createBalanceCache({ balanceOf: async () => Promise.reject(new Error("down")) });
    expect(await cache.get("0xasset", "0xaddr")).toBeUndefined();
    const p = await start({ balance: { balanceOf: async () => Promise.reject(new Error("down")) } });
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    const res = await me("PUT", "/api/wallet/account");
    expect(res.status).toBe(200);
    expect((res.body.account as Record<string, unknown>).balanceStale).toBe(true);
    expect("balanceAtomic" in (res.body.account as object)).toBe(false);
  });

  it("T-PRT-04 lowBalance: the balance is below an active policy's per-payment cap", async () => {
    let balance = 50_000n;
    const p = await start({ balance: { balanceOf: async () => balance } });
    await onboard(p, "alice");
    expect((await p.as("alice")("GET", "/api/wallet")).body.account).toMatchObject({ lowBalance: true });
    balance = 100_000n;
    p.l2.clock.advance(21_000);
    expect((await p.as("alice")("GET", "/api/wallet")).body.account).toMatchObject({ lowBalance: false });
  });
});

// ---------------------------------------------------------------------------
// T-PRT-05: policies (US3, US5)
// ---------------------------------------------------------------------------

describe("T-PRT-05 policies (US3, US5, FR-024..FR-027)", () => {
  it("T-PRT-05 the platform as a person sees it: limits and sellers by name and host, never a payee address", async () => {
    const p = await start();
    const res = await p.as("alice")("GET", "/api/platform");
    expect(res.body).toEqual({
      limits: p.l2.platform.limits,
      sellers: [
        { host: SELLER_HOST, name: "Local demo seller" },
        { host: OTHER_HOST, name: "Second seller" },
      ],
      network: "eip155:31337",
      asset: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      decimals: 6,
    });
    expect(res.text).not.toContain("0xcccc");
  });

  it("T-PRT-05 create: USDC text becomes exact atomic amounts, the end date the end of that UTC day, and the name stays in the portal", async () => {
    const p = await start();
    const policyId = await onboard(p, "alice");
    const e = p.l2.entries("POLICY_CREATED")[0]!;
    expect(e.data).toMatchObject({
      policyId,
      sellers: [SELLER_HOST],
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      dailyBudgetAtomic: "500000",
      maxAuthorizationsPerMinute: 10,
      expiresAt: "2026-12-31T23:59:59.999Z",
      paymentMethod: "crypto_account",
      identityConfirmedAtMs: T0,
    });
    // The name is the person's own: in the profile file, never in the ledger (research R6).
    expect(JSON.stringify(p.l2.ledger.entries())).not.toContain("Research APIs");
    expect(p.profiles.get(p.userId("alice"))?.policyNames).toEqual({ [policyId]: "Research APIs" });
    const list = await p.as("alice")<{ policies: Array<Record<string, unknown>> }>("GET", "/api/policies");
    expect(list.body.policies).toHaveLength(1);
    expect(list.body.policies[0]).toMatchObject({ policyId, name: "Research APIs", version: 1, state: "active", displayState: "active" });
    const one = await p.as("alice")("GET", `/api/policies/${policyId}`);
    expect((one.body.history as unknown[]).length).toBe(1);
    expect((await p.as("alice")("GET", "/api/me")).body.onboarding).toEqual({ profile: true, wallet: true, policy: true });
  });

  it("T-PRT-05 a seventh decimal is refused on its field and nothing reaches L2 (FR-025)", async () => {
    const p = await start();
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    await me("PUT", "/api/wallet/account");
    const res = await me("POST", "/api/policies", { ...POLICY, autoApproveUsdc: "0.0200001", perDayUsdc: "abc", perRunUsdc: "-1", name: " ", endsOn: "2026-02-30" });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "invalid_policy",
      issues: [
        { field: "name", code: "invalid_name" },
        { field: "autoApproveUsdc", code: "too_many_decimals" },
        { field: "perRunUsdc", code: "negative" },
        { field: "perDayUsdc", code: "not_a_number" },
        { field: "endsOn", code: "invalid_date" },
      ],
    });
    expect(p.l2.entries("POLICY_CREATED")).toEqual([]);
  });

  it("T-PRT-05 the input parser: exact amounts and real dates only", () => {
    const parsed = parsePolicyInput({ ...POLICY, autoApproveUsdc: "0.000001", perPaymentUsdc: "1", perRunUsdc: "1.5", perDayUsdc: "2" }, 6);
    expect("values" in parsed && parsed.values).toMatchObject({ autoApproveMaxAtomic: "1", hardCapPerPaymentAtomic: "1000000", sessionBudgetAtomic: "1500000", dailyBudgetAtomic: "2000000" });
    expect(endOfDayUtc("2026-12-31")).toBe("2026-12-31T23:59:59.999Z");
    for (const bad of ["2026-13-01", "2026-02-30", "31/12/2026", "2026-12-31T00:00:00Z", 20261231, undefined]) expect(endOfDayUtc(bad), String(bad)).toBeUndefined();
    for (const malformed of [null, [], { ...POLICY, sellers: "x" }, { ...POLICY, paymentsPerMinute: "10" }, { ...POLICY, autoApproveUsdc: 0.02 }, { ...POLICY, userId: "usr_x" }]) {
      expect(parsePolicyInput(malformed, 6)).toEqual({ malformed: true });
    }
  });

  it("T-PRT-05 L2's issues come back under the names of the fields the person filled in", async () => {
    const p = await start();
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    await me("PUT", "/api/wallet/account");
    const res = await me("POST", "/api/policies", { ...POLICY, perPaymentUsdc: "0.20", perRunUsdc: "0.20", perDayUsdc: "0.60", paymentsPerMinute: 500, sellers: ["unlisted.example"], endsOn: "2020-01-01" });
    expect(res.status).toBe(422);
    expect(res.body.issues).toEqual([
      { field: "perPaymentUsdc", code: "above_platform_limit", limitAtomic: "100000" },
      { field: "perRunUsdc", code: "above_platform_limit", limitAtomic: "100000" },
      { field: "perDayUsdc", code: "above_platform_limit", limitAtomic: "500000" },
      { field: "paymentsPerMinute", code: "above_platform_limit", limit: 100 },
      { field: "sellers[0]", code: "seller_not_listed", host: "unlisted.example" },
      { field: "endsOn", code: "expires_in_past" },
    ]);
  });

  it("T-PRT-05 step-up: a stale sign-in is relayed as 403 with maxAgeSec; a fresh one saves", async () => {
    const p = await start();
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    await me("PUT", "/api/wallet/account");
    const stale = p.as("alice", { authTime: Math.floor(T0 / 1000) - STEP_UP_AGE - 1 });
    const res = await stale("POST", "/api/policies", POLICY);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "step_up_required", maxAgeSec: 900 });
    expect(p.profiles.get(p.userId("alice"))?.policyNames).toEqual({});
    const created = await me("POST", "/api/policies", POLICY);
    expect(created.status).toBe(201);
    const policyId = String(created.body.policyId);
    // Tightening with the stale sign-in is fine; loosening is not (US5 scenario 2).
    expect((await stale("PUT", `/api/policies/${policyId}`, { ...POLICY, perDayUsdc: "0.30", expectedVersion: 1 })).status).toBe(200);
    expect((await stale("PUT", `/api/policies/${policyId}`, { ...POLICY, perDayUsdc: "0.40", expectedVersion: 2 })).status).toBe(403);
    expect((await me("PUT", `/api/policies/${policyId}`, { ...POLICY, perDayUsdc: "0.40", expectedVersion: 2 })).body.version).toBe(3);
  });

  it("T-PRT-05 change: needs expectedVersion, relays a version conflict with the current policy, and a rename records nothing at L2", async () => {
    const p = await start();
    const policyId = await onboard(p, "alice");
    const me = p.as("alice");
    expect((await me("PUT", `/api/policies/${policyId}`, POLICY)).status).toBe(400);
    expect((await me("POST", "/api/policies", { ...POLICY, sellers: [OTHER_HOST], expectedVersion: 1 })).status).toBe(400);
    const changed = await me("PUT", `/api/policies/${policyId}`, { ...POLICY, perDayUsdc: "0.30", expectedVersion: 1 });
    expect(changed.body).toMatchObject({ version: 2, name: "Research APIs" });
    const conflict = await me("PUT", `/api/policies/${policyId}`, { ...POLICY, perDayUsdc: "0.20", expectedVersion: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: "version_conflict", current: { version: 2, name: "Research APIs" } });
    const before = p.l2.ledger.entries().length;
    const renamed = await me("PUT", `/api/policies/${policyId}`, { ...POLICY, perDayUsdc: "0.30", name: "Renamed", expectedVersion: 2 });
    expect(renamed.body).toMatchObject({ version: 2, name: "Renamed" });
    expect(p.l2.ledger.entries().length).toBe(before);
  });

  it("T-PRT-05 pause, resume and remove relay L2's statuses; the history carries every version", async () => {
    const p = await start();
    const policyId = await onboard(p, "alice");
    const me = p.as("alice");
    expect((await me("POST", `/api/policies/${policyId}/pause`)).body).toMatchObject({ state: "paused", name: "Research APIs" });
    const stale = p.as("alice", { authTime: Math.floor(T0 / 1000) - STEP_UP_AGE - 1 });
    expect((await stale("POST", `/api/policies/${policyId}/resume`)).status).toBe(403);
    expect((await me("POST", `/api/policies/${policyId}/resume`)).body.state).toBe("active");
    expect((await me("POST", `/api/policies/${policyId}/remove`)).body.state).toBe("removed");
    expect((await me("POST", `/api/policies/${policyId}/resume`)).body).toEqual({ error: "policy_removed" });
    expect((await me("POST", "/api/policies/pol_unknown/pause")).status).toBe(404);
    const history = (await me("GET", `/api/policies/${policyId}`)).body.history as Array<{ kind: string }>;
    expect(history.map((h) => h.kind)).toEqual(["created", "paused", "resumed", "removed"]);
    // A removed policy keeps its name, for the history.
    expect((await me("GET", "/api/policies")).body.policies).toMatchObject([{ state: "removed", name: "Research APIs" }]);
  });

  it("T-PRT-05 a policy needs a wallet first", async () => {
    const p = await start();
    const me = p.as("alice");
    await me("PUT", "/api/profile", PROFILE);
    expect((await me("POST", "/api/policies", POLICY)).body).toEqual({ error: "wallet_required" });
    expect((await p.as("bob")("POST", "/api/policies", POLICY)).body).toEqual({ error: "profile_required" });
  });
});

// ---------------------------------------------------------------------------
// T-PRT-02: only your own data (US4)
// ---------------------------------------------------------------------------

describe("T-PRT-02 a person reaches only their own data (US4, FR-004)", () => {
  it("T-PRT-02 another person's policy ID is a 404 on every route, like an unknown one", async () => {
    const p = await start();
    await onboard(p, "alice");
    const bobs = await onboard(p, "bob", { sellers: [OTHER_HOST], name: "Bob's secret plan" });
    const alice = p.as("alice");
    const before = p.l2.ledger.entries().length;
    for (const [method, path, body] of [
      ["GET", `/api/policies/${bobs}`, undefined],
      ["PUT", `/api/policies/${bobs}`, { ...POLICY, sellers: [OTHER_HOST], expectedVersion: 1 }],
      ["POST", `/api/policies/${bobs}/pause`, undefined],
      ["POST", `/api/policies/${bobs}/resume`, undefined],
      ["POST", `/api/policies/${bobs}/remove`, undefined],
    ] as const) {
      const theirs = await alice(method, path, body);
      const unknown = await alice(method, path.replace(bobs, "pol_00000000-0000-4000-8000-000000000000"), body);
      expect(theirs.status, `${method} ${path}`).toBe(404);
      expect(theirs.body).toEqual(unknown.body);
      expect(theirs.text).not.toContain("Bob");
    }
    expect(p.l2.ledger.entries().length).toBe(before);
    expect(p.profiles.get(p.userId("alice"))?.policyNames[bobs]).toBeUndefined();
    expect((await p.as("bob")("GET", `/api/policies/${bobs}`)).body).toMatchObject({ state: "active", name: "Bob's secret plan" });
  });

  it("T-PRT-02 no route takes a user identifier: a body field is refused, and a query or header changes nothing", async () => {
    const p = await start();
    await onboard(p, "alice");
    await onboard(p, "bob", { sellers: [OTHER_HOST] });
    const bob = p.userId("bob");
    const token = await p.token("alice");
    expect((await p.call("PUT", "/api/profile", { token, body: { displayName: "A", contactEmail: "a@b.co", userId: bob } })).status).toBe(400);
    expect((await p.call("POST", "/api/policies", { token, body: { ...POLICY, sellers: [OTHER_HOST], userId: bob } })).status).toBe(400);
    expect((await p.call("POST", "/api/account/disable", { token, body: { confirm: true, userId: bob } })).status).toBe(400);
    const res = await fetch(`${p.base}/api/me?userId=${bob}`, { headers: { authorization: `Bearer ${token}`, "x-user-id": bob } });
    expect(((await res.json()) as { userId: string }).userId).toBe(p.userId("alice"));
    // Every answer alice gets is about alice only.
    for (const path of ["/api/me", "/api/wallet", "/api/policies"]) {
      const text = (await p.call("GET", path, { token })).text;
      expect(text, path).not.toContain(bob);
      expect(text, path).not.toContain(p.l2.keyring.addressOf(1));
    }
    expect(p.l2.entries("USER_DISABLED")).toEqual([]);
  });

  it("T-PRT-02 must-fail: with L2's skipOwnershipCheck, alice reads bob's policy through the portal", async () => {
    const p = await start({ l2: { users: { skipOwnershipCheck: true } } });
    await onboard(p, "alice");
    const bobs = await onboard(p, "bob", { sellers: [OTHER_HOST] });
    const res = await p.as("alice")("GET", `/api/policies/${bobs}`);
    expect(res.status).toBe(200);
    expect((res.body.values as { sellers: string[] }).sellers).toEqual([OTHER_HOST]);
  });
});

// ---------------------------------------------------------------------------
// US7 through the portal: disable and enable
// ---------------------------------------------------------------------------

describe("013 US7 the account through the portal (FR-037..FR-039)", () => {
  it("013 US7 disable needs an explicit confirmation; afterwards everything is still readable, marked disabled", async () => {
    const p = await start();
    const policyId = await onboard(p, "alice");
    const me = p.as("alice");
    for (const body of [undefined, {}, { confirm: false }, { confirm: "true" }]) expect((await me("POST", "/api/account/disable", body)).status).toBe(400);
    expect(p.l2.entries("USER_DISABLED")).toEqual([]);
    const off = await me("POST", "/api/account/disable", { confirm: true });
    expect(off.body).toMatchObject({ enabled: false, profile: { displayName: "Ana Pérez" } });
    expect((await me("GET", "/api/wallet")).body).toMatchObject({ disabled: true, account: { address: p.l2.keyring.addressOf(0) } });
    expect((await me("GET", "/api/policies")).body.policies).toMatchObject([{ policyId, state: "active", displayState: "disabled", name: "Research APIs" }]);
    // No create or change while disabled; the profile can still be corrected (FR-038).
    expect((await me("POST", "/api/policies", { ...POLICY, sellers: [OTHER_HOST] })).body).toEqual({ error: "account_disabled" });
    expect((await me("POST", `/api/policies/${policyId}/pause`)).body).toEqual({ error: "account_disabled" });
    expect((await me("PUT", "/api/profile", { displayName: "Ana", contactEmail: "ana@example.com" })).status).toBe(200);
  });

  it("013 US7 enable relays the step-up, then every policy is paused until resumed", async () => {
    const p = await start();
    const policyId = await onboard(p, "alice");
    const me = p.as("alice");
    await me("POST", "/api/account/disable", { confirm: true });
    const stale = p.as("alice", { authTime: Math.floor(T0 / 1000) - STEP_UP_AGE - 1 });
    expect((await stale("POST", "/api/account/enable")).body).toEqual({ error: "step_up_required", maxAgeSec: 900 });
    expect((await me("POST", "/api/account/enable")).body).toMatchObject({ enabled: true });
    expect((await me("GET", `/api/policies/${policyId}`)).body).toMatchObject({ state: "paused", displayState: "paused" });
  });
});

// ---------------------------------------------------------------------------
// T-PRT-06: L2 down
// ---------------------------------------------------------------------------

describe("T-PRT-06 L2 unreachable (NFR-005)", () => {
  it("T-PRT-06 every route that needs L2 answers 502 and nothing is granted", async () => {
    const p = await start({ controlDown: true });
    const me = p.as("alice");
    for (const [method, path, body] of [
      ["GET", "/api/me", undefined],
      ["GET", "/api/platform", undefined],
      ["GET", "/api/wallet", undefined],
      ["PUT", "/api/wallet/account", undefined],
      ["GET", "/api/policies", undefined],
      ["POST", "/api/policies", POLICY],
      ["POST", "/api/account/disable", { confirm: true }],
      ["POST", "/api/account/enable", undefined],
    ] as const) {
      const res = await me(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(502);
      expect(res.body).toEqual({ error: "control_unavailable" });
    }
    // /api/config and the health routes need nothing else.
    expect((await p.call("GET", "/api/config")).status).toBe(200);
    expect((await p.call("GET", "/healthz")).status).toBe(200);
    expect(existsSync(p.profilesDir)).toBe(false);
  });

  it("T-PRT-06 a first profile save with L2 down: the user is not registered, and the next save completes it", async () => {
    const down = await start({ controlDown: true });
    expect((await down.as("alice")("PUT", "/api/profile", PROFILE)).status).toBe(502);
    expect(down.l2.entries("USER_REGISTERED")).toEqual([]);
    // With L2 reachable the same request registers the user.
    const up = await start();
    expect((await up.as("alice")("PUT", "/api/profile", PROFILE)).body).toMatchObject({ onboarding: { profile: true } });
  });
});

// ---------------------------------------------------------------------------
// T-PRT-07: headers; T-PRT-08: the log
// ---------------------------------------------------------------------------

describe("T-PRT-07 headers on every response", () => {
  it("T-PRT-07 the Content-Security-Policy, nosniff, no-referrer, and no-store on /api", async () => {
    const p = await start();
    const csp = contentSecurityPolicy();
    expect(csp.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self' https://js.stripe.com https://*.js.stripe.com",
      "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
      "connect-src 'self' https://api.stripe.com",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    const token = await p.token("alice");
    for (const [path, withToken] of [["/api/config", false], ["/api/me", true], ["/api/me", false], ["/healthz", false], ["/api/nope", true], ["/nope", false]] as const) {
      const res = await p.call("GET", path, withToken ? { token } : {});
      expect(res.headers.get("content-security-policy"), path).toBe(csp);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("x-powered-by"), path).toBeNull();
      expect(res.headers.get("cache-control"), path).toBe(path.startsWith("/api") ? "no-store" : null);
      // Loopback, local network: no HSTS.
      expect(res.headers.get("strict-transport-security"), path).toBeNull();
    }
  });

  it("T-PRT-07 with a sign-in tenant the policy lets the web app call that tenant, and nothing of the earlier sign-in", async () => {
    const p = await start({ env: { AUTH_ISSUER: SIGN_IN_ISSUER, AUTH_JWKS_FILE: "" } });
    const csp = contentSecurityPolicy({ signInOrigin: "https://x402-test.eu.auth0.com" });
    expect(signInOriginOf(p.config.auth)).toBe("https://x402-test.eu.auth0.com");
    expect(csp.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self' https://js.stripe.com https://*.js.stripe.com",
      // The tenant is never framed: sessions are renewed with a refresh token, and sign-in is a pop-up.
      "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
      "connect-src 'self' https://api.stripe.com https://x402-test.eu.auth0.com",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
    for (const path of ["/api/config", "/api/me", "/healthz", "/nope", "/redirect.html"]) {
      const header = (await p.call("GET", path)).headers.get("content-security-policy");
      expect(header, path).toBe(csp);
      expect(header, path).not.toContain("login.microsoftonline.com");
      // No page may be framed any more, the earlier sign-in's redirect page included.
      expect(header, path).toContain("frame-ancestors 'none'");
    }
  });

  it("T-PRT-07 bodies: over 16 KB is 413, unparsable JSON is 400, an unknown /api path is 404", async () => {
    const p = await start();
    const token = await p.token("alice");
    expect((await p.call("PUT", "/api/profile", { token, body: { ...PROFILE, displayName: "x".repeat(20_000) } })).status).toBe(413);
    expect((await p.call("PUT", "/api/profile", { token, raw: "{not json" })).status).toBe(400);
    expect((await p.call("GET", "/api/users", { token })).body).toEqual({ error: "not found" });
    expect((await p.call("GET", "/api/users")).status).toBe(401);
  });

  it("T-PRT-07 the built web app is served with index.html for any other path, when it exists", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "portal-web-"));
    try {
      writeFileSync(join(root, "index.html"), "<!doctype html><title>x402 portal</title>");
      const p = await start({ webRoot: root });
      for (const path of ["/", "/policies", "/policies/pol_1/history"]) {
        const res = await p.call("GET", path);
        expect(res.status, path).toBe(200);
        expect(res.text).toContain("x402 portal");
      }
      // The earlier sign-in's redirect page is gone: its path is the app like any other.
      const redirect = await p.call("GET", "/redirect.html");
      expect(redirect.text).toContain("x402 portal");
      expect(redirect.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      // The API is never shadowed by the page.
      expect((await p.call("GET", "/api/me")).status).toBe(401);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("T-PRT-08 the log holds route templates and identifiers only (NFR-003, NFR-004)", () => {
  it("T-PRT-08 every line has only whitelisted keys, and no token, name, email or policy name appears anywhere", async () => {
    const p = await start();
    const policyId = await onboard(p, "alice");
    const token = await p.token("alice");
    await p.call("GET", `/api/policies/${policyId}?secret=QUERYSECRET`, { token });
    await p.call("GET", "/api/me");
    await p.call("PUT", "/api/profile", { token, body: { displayName: "", contactEmail: "x" } });
    expect(p.logs.length).toBeGreaterThan(5);
    for (const line of p.logs) expect(Object.keys(line).every((k) => LOG_KEYS.includes(k)), JSON.stringify(line)).toBe(true);
    const all = p.rawLogs.join("\n");
    for (const secret of [token, token.split(".")[2]!, TOKENS.portal, "Ana", "ana.perez", "Research APIs", "QUERYSECRET", policyId]) {
      expect(all.includes(secret), secret.slice(0, 20)).toBe(false);
    }
    // Routes are templates; the user is the opaque identifier.
    expect(new Set(p.logs.map((l) => l.route))).toEqual(new Set(["/api/profile", "/api/wallet/account", "/api/policies", "/api/policies/:policyId", "/api/*"]));
    expect(p.logs.filter((l) => l.status === 201)[0]).toMatchObject({ route: "/api/policies", userId: p.userId("alice") });
    expect(p.logs.find((l) => l.status === 401)).not.toHaveProperty("userId");
  });

  it("T-PRT-08 the ledger and L2's answers never hold a name, an email or a policy name (FR-046)", async () => {
    const p = await start();
    await onboard(p, "alice");
    const ledger = readFileSync(p.l2.ledgerFile, "utf8");
    for (const text of ["Ana", "ana.perez", "example.com", "Research APIs"]) expect(ledger.includes(text), text).toBe(false);
    // The profile store holds them, in one file named after the user.
    expect(readdirSync(p.profilesDir)).toEqual([`${p.userId("alice")}.json`]);
  });
});

describe("T-PRT-09 the local dev issuer must exist before a service that trusts it starts", () => {
  it("T-PRT-09 a missing AUTH_JWKS_FILE says how to create it, instead of a bare file error", async () => {
    const { personKeys, serviceKeys } = await import("../src/shared/identity-token.js");
    expect(() => personKeys({ issuer: "urn:x402:dev-issuer", jwksFile: ".local/no-such-issuer/jwks.json" })).toThrow(/AUTH_JWKS_FILE: no file at .*npm run dev-token/);
    expect(() => serviceKeys({ tenantId: "dev", jwksFile: ".local/no-such-issuer/jwks.json" })).toThrow(/AUTH_JWKS_FILE: no file at .*npm run dev-token/);
  });
});
