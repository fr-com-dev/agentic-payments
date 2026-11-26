// Feature 020: connected platforms, Coinbase balances (SPEC.md §8.2 L2-8; specs/020 contracts/portal-api.md,
// contracts/coinbase.md). T-CONN-01..12. The real portal against an in-process L2 with user accounts on and the stand-in
// Coinbase (test/helpers/coinbase-stub.ts): Coinbase has no sandbox, so no test reaches it (NFR-005). Every must-fail
// switch is a test-only dep, and each has a test here that fails with it on (Constitution VIII).
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GrantStore, type GrantSecret } from "../src/portal/coinbase/grants.js";
import { CONNECTION_EVENTS, LOG_KEYS } from "../src/portal/log.js";
import type { UserView } from "../src/shared/contracts.js";
import { startCoinbaseStub, type CoinbaseStub, type StubAccount } from "./helpers/coinbase-stub.js";
import { startPortal, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";
import { ALICE, startUsersL2, type UsersL2 } from "./helpers/users.js";
import { createTestIssuer } from "./helpers/caller-tokens.js";

const PROFILE = { displayName: "Ana Pérez", contactEmail: "ana.perez@example.com", acknowledgedTestFunds: true };
type Body = Record<string, unknown>;

let portals: PortalTestApp[] = [];
let stubs: CoinbaseStub[] = [];
let l2s: UsersL2[] = [];
afterEach(async () => {
  await Promise.all(portals.map((p) => p.close()));
  await Promise.all(stubs.map((s) => s.close()));
  await Promise.all(l2s.map((l) => l.close()));
  portals = [];
  stubs = [];
  l2s = [];
});

async function setup(o: Omit<StartPortalOptions, "coinbase"> = {}): Promise<{ p: PortalTestApp; cb: CoinbaseStub }> {
  const cb = await startCoinbaseStub();
  stubs.push(cb);
  const p = await startPortal({ ...o, coinbase: cb });
  portals.push(p);
  return { p, cb };
}

/** A profile for `subject`, through the portal's own route. */
async function register(p: PortalTestApp, subject: string): Promise<void> {
  expect((await p.as(subject)("PUT", "/api/profile", PROFILE)).status).toBe(200);
}

/** Start, agree at the stand-in, complete. */
async function connect(p: PortalTestApp, cb: CoinbaseStub, subject: string, o: { scope?: string } = {}) {
  const me = p.as(subject);
  const started = await me<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const a = cb.authorize(started.body.authorizeUrl, o);
  return me<Body>("POST", "/api/connections/coinbase/complete", { code: a.code, state: a.state });
}

const events = (p: PortalTestApp) => p.logs.filter((l) => l.route === "connections").map((l) => l.event);
const balances = (p: PortalTestApp, subject: string, fresh = false) => p.as(subject)<Body>("GET", `/api/connections/coinbase/balances${fresh ? "?fresh=1" : ""}`);
const tokenCalls = (cb: CoinbaseStub, grant: string) => cb.requests.filter((r) => r.path === "/oauth2/token" && r.form.grant_type === grant);

const ACCOUNTS: StubAccount[] = [
  { code: "BTC", name: "Bitcoin", amount: "0.50000000" },
  { code: "ETH", name: "Ethereum", amount: "1.000000000000000001" },
  { code: "USDC", name: "USD Coin", amount: "12.345678" },
  { code: "SOL", name: "Solana", amount: "0.00000000" },
  { code: "USD", name: "US Dollar", amount: "10.50", type: "fiat" },
  { code: "NOPE", name: "No rate", amount: "3" },
  { code: "DEX", name: "Self custody", amount: "9", type: "dex_wallet" },
  { code: "BAD", name: "Bad", amount: "1e5" },
  { code: "MIX", name: "Mismatch", amount: "1", balanceCurrency: "BTC" },
];
const RATES = { USD: "1", BTC: "0.00001", ETH: "0.0005", USDC: "1" };

// ---------------------------------------------------------------------------
// The grant store (part of T-CONN-06; data-model.md "Grant store")
// ---------------------------------------------------------------------------

describe("T-CONN-06 the grant store seals each grant to its user, connection and platform (FR-026)", () => {
  const BOB = "usr_" + "b".repeat(32);
  const CONN = (n: number) => `conn_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const secret: GrantSecret = { refreshToken: "REFRESH-KNOWN-VALUE-0123", scopes: ["offline_access", "wallet:accounts:read"], refreshedAt: "2026-11-25T00:00:00.000Z" };

  it("T-CONN-06 a sealed grant opens for its own user and connection only, with a new IV each time; files are 0600 and hold no clear token", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-grants-"));
    const store = new GrantStore(dir, { key: randomBytes(32) });
    const g1 = store.seal(ALICE, CONN(1), "coinbase", secret);
    const g2 = store.seal(ALICE, CONN(1), "coinbase", secret);
    expect(g1.iv).not.toBe(g2.iv);
    store.update(ALICE, () => [{ connectionId: CONN(1), platform: "coinbase", status: "connected", connectedAt: secret.refreshedAt, grant: g1 }]);
    const [c] = store.list(ALICE);
    expect(store.open(ALICE, c!)).toEqual(secret);
    // Moved to another user, or to another connection: it doesn't open.
    expect(store.open(BOB, c!)).toBeUndefined();
    expect(store.open(ALICE, { ...c!, connectionId: CONN(2) })).toBeUndefined();
    expect(store.open(ALICE, { ...c!, platform: "kraken" as "coinbase" })).toBeUndefined();
    // Another key: doesn't open.
    expect(new GrantStore(dir, { key: randomBytes(32) }).open(ALICE, c!)).toBeUndefined();
    const file = join(dir, `${ALICE}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(secret.refreshToken);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // A file whose header names another user is none of this user's.
    writeFileSync(join(dir, `${BOB}.json`), readFileSync(file, "utf8"));
    expect(store.list(BOB)).toEqual([]);
    // Empty list: the file goes.
    store.update(ALICE, () => []);
    expect(existsSync(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US1: connecting
// ---------------------------------------------------------------------------

describe("T-CONN-01 a registered user connects Coinbase, read only (US1, FR-001..FR-003, FR-006, FR-007, FR-030)", () => {
  it("T-CONN-01 start asks for exactly the read scopes with S256; complete connects; L2 records it; onboarding is unchanged", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    const me = p.as("alice");
    const before = (await me<Body>("GET", "/api/me")).body.onboarding;
    const started = await me<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const u = new URL(started.body.authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${cb.baseUrl}/oauth2/auth`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "stub-client-id",
      redirect_uri: "http://localhost:4025/wallet/coinbase",
      scope: "wallet:accounts:read offline_access",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const a = cb.authorize(started.body.authorizeUrl);
    const done = await me<Body>("POST", "/api/connections/coinbase/complete", { code: a.code, state: a.state });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ platform: "coinbase", status: "connected", connectedAt: expect.any(String) });
    expect(p.l2.entries("CONNECTION_OPENED")).toHaveLength(1);
    const wallet = await me<{ connections: Body[] }>("GET", "/api/wallet");
    expect(wallet.body.connections).toEqual([
      { platform: "coinbase", status: "connected", connectedAt: done.body.connectedAt, privacyPolicyUrl: "https://example.org/privacy", supportUrl: "mailto:support@example.org" },
    ]);
    expect((await me<Body>("GET", "/api/me")).body.onboarding).toEqual(before);
    // The stand-in saw an exchange and nothing that moves funds.
    expect(cb.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /oauth2/token"]);
    expect(tokenCalls(cb, "authorization_code")[0]!.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(events(p)).toContain("coinbase_connected");
  });

  it("T-CONN-01 no profile: 409 profile_required; a disabled account: 409 account_disabled; the wallet offers the links", async () => {
    const { p } = await setup();
    const bob = p.as("bob");
    expect((await bob<Body>("POST", "/api/connections/coinbase/start")).body).toEqual({ error: "profile_required" });
    await register(p, "bob");
    const wallet = await bob<{ connections: Body[] }>("GET", "/api/wallet");
    expect(wallet.body.connections).toEqual([{ platform: "coinbase", status: "not_connected", privacyPolicyUrl: "https://example.org/privacy", supportUrl: "mailto:support@example.org" }]);
    expect((await bob("POST", "/api/account/disable", { confirm: true })).status).toBe(200);
    expect((await bob<Body>("POST", "/api/connections/coinbase/start")).body).toEqual({ error: "account_disabled" });
    expect((await bob<Body>("POST", "/api/connections/coinbase/complete", { code: "c", state: "s" })).status).toBe(400);
  });

  it("T-CONN-01 the start needs the privacy policy and the support contact (FR-030): 503 not_ready without them", async () => {
    const { p } = await setup({ connections: { privacyPolicyUrl: "" } });
    await register(p, "alice");
    expect((await p.as("alice")<Body>("POST", "/api/connections/coinbase/start")).body).toEqual({ error: "not_ready" });
  });

  it("T-CONN-01 at most 10 starts a minute per user, then 429 with Retry-After; a malformed complete is 400 invalid_request", async () => {
    const { p } = await setup();
    await register(p, "alice");
    const me = p.as("alice");
    for (let i = 0; i < 10; i++) expect((await me("POST", "/api/connections/coinbase/start")).status).toBe(200);
    const limited = await p.call("POST", "/api/connections/coinbase/start", { token: await p.token("alice") });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    for (const body of [{}, { code: "x" }, { code: "x", state: "y", extra: 1 }, { code: "", state: "y" }, { code: "x".repeat(513), state: "y" }, { code: 1, state: "y" }]) {
      expect((await me<Body>("POST", "/api/connections/coinbase/complete", body)).body, JSON.stringify(body)).toEqual({ error: "invalid_request" });
    }
  });
});

describe("T-CONN-02 a cancelled or abandoned connection keeps nothing (US1 scenario 4)", () => {
  it("T-CONN-02 a start never completed expires after 10 minutes with nothing stored and nothing at L2", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    const me = p.as("alice", { authTime: Math.floor(p.l2.clock.now() / 1000) });
    const started = await me<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const refused = cb.authorize(started.body.authorizeUrl, { refused: true });
    expect(refused.error).toBe("access_denied");
    p.l2.clock.advance(600_001);
    const late = cb.authorize(started.body.authorizeUrl);
    const sameSignIn = p.as("alice", { authTime: Math.floor((p.l2.clock.now() - 600_001) / 1000) });
    expect((await sameSignIn<Body>("POST", "/api/connections/coinbase/complete", { code: late.code, state: late.state })).body).toEqual({ error: "invalid_state" });
    expect(existsSync(p.connectionDir) ? readdirSync(p.connectionDir) : []).toEqual([]);
    expect(p.l2.entries("CONNECTION_OPENED")).toEqual([]);
  });
});

describe("T-CONN-03 a return from Coinbase connects only for the person and sign-in that started it, once (FR-009, SEC-54)", () => {
  it("T-CONN-03 unknown, used, another person's or another sign-in's state, and a refused code, are 400 invalid_state", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    await register(p, "bob");
    const alice = p.as("alice");
    const started = await alice<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const a = cb.authorize(started.body.authorizeUrl);
    expect((await alice<Body>("POST", "/api/connections/coinbase/complete", { code: a.code, state: "unknown-state" })).body).toEqual({ error: "invalid_state" });
    // Bob can't complete Alice's start.
    expect((await p.as("bob")<Body>("POST", "/api/connections/coinbase/complete", { code: a.code, state: a.state })).body).toEqual({ error: "invalid_state" });
    // Single use: Bob's attempt consumed it, so Alice can't either.
    expect((await alice<Body>("POST", "/api/connections/coinbase/complete", { code: a.code, state: a.state })).body).toEqual({ error: "invalid_state" });
    // Another sign-in of the same person (signed out and in again) can't complete it.
    const s2 = await alice<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const a2 = cb.authorize(s2.body.authorizeUrl);
    const later = p.as("alice", { authTime: Math.floor(p.l2.clock.now() / 1000) - 120 });
    expect((await later<Body>("POST", "/api/connections/coinbase/complete", { code: a2.code, state: a2.state })).body).toEqual({ error: "invalid_state" });
    // A code Coinbase refuses (already used, or made up).
    const s3 = await alice<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const st3 = new URL(s3.body.authorizeUrl).searchParams.get("state")!;
    expect((await alice<Body>("POST", "/api/connections/coinbase/complete", { code: "made-up", state: st3 })).body).toEqual({ error: "invalid_state" });
    expect(p.l2.entries("CONNECTION_OPENED")).toEqual([]);
    expect(events(p)).toContain("coinbase_state_refused");
  });

  it("T-CONN-03 a fourth pending start of one user drops the oldest", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    const me = p.as("alice");
    const urls: string[] = [];
    for (let i = 0; i < 4; i++) urls.push((await me<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start")).body.authorizeUrl);
    const oldest = cb.authorize(urls[0]!);
    expect((await me<Body>("POST", "/api/connections/coinbase/complete", { code: oldest.code, state: oldest.state })).body).toEqual({ error: "invalid_state" });
    const newest = cb.authorize(urls[3]!);
    expect((await me<Body>("POST", "/api/connections/coinbase/complete", { code: newest.code, state: newest.state })).status).toBe(200);
  });

  it("T-CONN-03 must-fail: with skipStateCheck, Bob completes Alice's start", async () => {
    const { p, cb } = await setup({ connections: { skipStateCheck: true } });
    await register(p, "alice");
    await register(p, "bob");
    const started = await p.as("alice")<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const a = cb.authorize(started.body.authorizeUrl);
    expect((await p.as("bob")<Body>("POST", "/api/connections/coinbase/complete", { code: a.code, state: a.state })).status).toBe(200);
  });

  const inject = async (o: StartPortalOptions["connections"]) => {
    const { p, cb } = await setup({ connections: o });
    await register(p, "alice");
    await register(p, "bob");
    // Alice's code is captured on its way back.
    const aliceStart = await p.as("alice")<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const captured = cb.authorize(aliceStart.body.authorizeUrl);
    // Bob starts his own connection and completes it with Alice's code and his own valid state.
    const bobStart = await p.as("bob")<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const bobState = new URL(bobStart.body.authorizeUrl).searchParams.get("state")!;
    return (await p.as("bob")<Body>("POST", "/api/connections/coinbase/complete", { code: captured.code, state: bobState })).body;
  };

  it("T-CONN-03 code injection: PKCE refuses Alice's captured code in Bob's connection", async () => {
    expect(await inject({})).toEqual({ error: "invalid_state" });
  });

  it("T-CONN-03 must-fail: with skipPkce, Bob's portal account is connected to Alice's Coinbase grant", async () => {
    expect(await inject({ skipPkce: true })).toMatchObject({ status: "connected" });
  });
});

describe("T-CONN-04 only a read-only grant is kept (FR-007, FR-008, SEC-55)", () => {
  const refusedFor = async (o: { scope?: string; noRefresh?: boolean; skipScopeCheck?: boolean }) => {
    const { p, cb } = await setup({ connections: { ...(o.skipScopeCheck && { skipScopeCheck: true }) } });
    await register(p, "alice");
    if (o.scope !== undefined) cb.grantScope(o.scope);
    cb.withoutRefreshToken(o.noRefresh === true);
    const res = await connect(p, cb, "alice");
    return { p, cb, res };
  };

  it("T-CONN-04 wider (a send scope, all, an unknown name) is too_wide; narrower (no read, no refresh token) is too_narrow; each grant is revoked and checked", async () => {
    for (const [o, reason] of [
      [{ scope: "wallet:accounts:read offline_access wallet:transactions:send" }, "too_wide"],
      [{ scope: "all" }, "too_wide"],
      [{ scope: "wallet:accounts:read offline_access wallet:something:new" }, "too_wide"],
      [{ scope: "offline_access" }, "too_narrow"],
      [{ noRefresh: true }, "too_narrow"],
    ] as const) {
      const { p, cb, res } = await refusedFor(o);
      expect(res.body, JSON.stringify(o)).toEqual({ error: "scope_refused", reason });
      expect(cb.liveGrants(), JSON.stringify(o)).toBe(0);
      expect(cb.requests.some((r) => r.path === "/oauth2/revoke")).toBe(true);
      expect(cb.requests.some((r) => r.path === "/v2/accounts" && r.query.limit === "1")).toBe(true);
      expect(p.l2.entries("CONNECTION_OPENED")).toEqual([]);
      expect(existsSync(p.connectionDir) ? readdirSync(p.connectionDir).filter((n) => n.endsWith(".json")) : []).toEqual([]);
      expect(events(p)).toContain("coinbase_scope_refused");
    }
  });

  it("T-CONN-04 must-fail: with skipScopeCheck, a grant that can send funds is kept", async () => {
    const { res } = await refusedFor({ scope: "wallet:accounts:read offline_access wallet:transactions:send", skipScopeCheck: true });
    expect(res.body).toMatchObject({ status: "connected" });
  });
});

describe("T-CONN-05 connecting again replaces the connection and revokes the old grant (FR-010)", () => {
  it("T-CONN-05 two completes end with one connection; L2 closed the first as replaced; its grant is revoked", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    expect((await connect(p, cb, "alice")).status).toBe(200);
    expect((await connect(p, cb, "alice")).status).toBe(200);
    expect(p.l2.entries("CONNECTION_CLOSED").map((e) => e.data.cause)).toEqual(["replaced"]);
    expect(cb.liveGrants()).toBe(1);
    const view = (await p.l2.portal<UserView>("GET", `/v1/users/${p.userId("alice")}`)).body;
    expect(view.connections).toHaveLength(1);
    expect(events(p)).toContain("coinbase_replaced");
  });

  it("T-CONN-05 must-fail: with skipReplaceRevoke, the first grant still reads at Coinbase", async () => {
    const { p, cb } = await setup({ connections: { skipReplaceRevoke: true } });
    await register(p, "alice");
    await connect(p, cb, "alice");
    await connect(p, cb, "alice");
    expect(cb.liveGrants()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// US2: balances
// ---------------------------------------------------------------------------

describe("T-CONN-08 balances: exact amounts, USD values at Coinbase's rates, a total (FR-012..FR-015, SC-002)", () => {
  it("T-CONN-08 the funded assets, validated, valued, sorted and totalled", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    cb.setRates(RATES);
    await connect(p, cb, "alice");
    const t0 = Date.now();
    const res = await balances(p, "alice");
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      readAt: new Date(p.l2.clock.now()).toISOString(),
      stale: false,
      assets: [
        { code: "BTC", name: "Bitcoin", amount: "0.50000000", value: { amount: "50000.00", currency: "USD" } },
        { code: "ETH", name: "Ethereum", amount: "1.000000000000000001", value: { amount: "2000.00", currency: "USD" } },
        { code: "USDC", name: "USD Coin", amount: "12.345678", value: { amount: "12.35", currency: "USD" } },
        { code: "USD", name: "US Dollar", amount: "10.50", value: { amount: "10.50", currency: "USD" } },
        { code: "NOPE", name: "No rate", amount: "3" },
      ],
      more: 0,
      total: { amount: "52022.85", currency: "USD" },
      leftOutOfTotal: ["NOPE"],
    });
    expect(events(p)).toContain("coinbase_bad_amount");
    expect(cb.requests.filter((r) => r.path === "/v2/accounts").every((r) => !("fetch_all" in r.query) && r.headers["cb-version"] === "2026-11-01")).toBe(true);
    expect(cb.requests.filter((r) => r.path === "/v2/exchange-rates").every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it("T-CONN-08 names lose control characters and are cut to 60; codes outside the pattern are dropped", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts([
      { code: "AAA", name: `<img src=x onerror=alert(1)>\u0007${"x".repeat(80)}`, amount: "1" },
      { code: "bad code!", name: "Bad", amount: "1" },
    ]);
    await connect(p, cb, "alice");
    const res = await balances(p, "alice");
    const assets = res.body.assets as Body[];
    expect(assets.map((a) => a.code)).toEqual(["AAA"]);
    expect(String(assets[0]!.name)).toHaveLength(60);
    expect(String(assets[0]!.name)).not.toContain("\u0007");
  });

  it("T-CONN-08 figures come from memory for 20 s; a fresh read at most every 10 s; then a new read", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    const reads = () => cb.requests.filter((r) => r.path === "/v2/accounts").length;
    await balances(p, "alice");
    const n = reads();
    await balances(p, "alice");
    await balances(p, "alice", true);
    expect(reads()).toBe(n);
    p.l2.clock.advance(10_001);
    await balances(p, "alice", true);
    expect(reads()).toBe(n + 1);
    p.l2.clock.advance(20_001);
    await balances(p, "alice");
    expect(reads()).toBe(n + 2);
  });

  it("T-CONN-08 every page up to 10, at most 200 assets listed, `more` counts the rest; 404 without a connection", async () => {
    const cb = await startCoinbaseStub({ pageSize: 50 });
    stubs.push(cb);
    const p = await startPortal({ coinbase: cb });
    portals.push(p);
    await register(p, "alice");
    expect((await balances(p, "alice")).body).toEqual({ error: "not_connected" });
    cb.setAccounts(Array.from({ length: 250 }, (_, i) => ({ code: `C${i}`, name: `Coin ${i}`, amount: "1" })));
    cb.setRates({ USD: "1" });
    await connect(p, cb, "alice");
    const res = await balances(p, "alice");
    expect((res.body.assets as Body[]).length).toBe(200);
    expect(res.body.more).toBe(50);
    expect(cb.requests.filter((r) => r.path === "/v2/accounts" && r.query.limit === "100")).toHaveLength(5);
    expect(res.body.moreIsAtLeast).toBeUndefined();
  });

  it("T-CONN-08 more than 10 pages: 10 are read, and `more` is marked as a lower bound (review 3)", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts(Array.from({ length: 1_100 }, (_, i) => ({ code: `C${i}`, name: `Coin ${i}`, amount: "1" })));
    cb.setRates({ USD: "1" });
    await connect(p, cb, "alice");
    const res = await balances(p, "alice");
    expect(cb.requests.filter((r) => r.path === "/v2/accounts" && r.query.limit === "100")).toHaveLength(10);
    expect(res.body).toMatchObject({ more: 800, moreIsAtLeast: true });
  });
});

describe("T-CONN-09 balances when Coinbase fails, refuses or rotates (FR-016, FR-017, research R5, SEC-58)", () => {
  it("T-CONN-09 a timeout: the last figures marked stale, or unreadable if never read; the answer within 5 s", { timeout: 20_000 }, async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    cb.setFault("timeout");
    let t = Date.now();
    expect((await balances(p, "alice")).body).toEqual({ status: "unreadable" });
    expect(Date.now() - t).toBeLessThan(5_500);
    cb.setFault(undefined);
    p.l2.clock.advance(10_001);
    expect((await balances(p, "alice", true)).body.stale).toBe(false);
    cb.setFault("error500");
    p.l2.clock.advance(20_001);
    t = Date.now();
    const stale = await balances(p, "alice");
    expect(stale.body).toMatchObject({ stale: true });
    expect(Date.now() - t).toBeLessThan(5_500);
    expect(events(p)).toContain("coinbase_unavailable");
  });

  it("T-CONN-09 a 429 skips that user for 60 s; an expired access token renews once and retries", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    cb.setFault("rate_limited");
    expect((await balances(p, "alice")).body).toEqual({ status: "unreadable" });
    cb.setFault(undefined);
    p.l2.clock.advance(30_000);
    const reads = cb.requests.filter((r) => r.path === "/v2/accounts").length;
    expect((await balances(p, "alice")).body).toEqual({ status: "unreadable" });
    expect(cb.requests.filter((r) => r.path === "/v2/accounts").length).toBe(reads);
    p.l2.clock.advance(30_001);
    cb.setFault("expired_once");
    expect((await balances(p, "alice")).body.stale).toBe(false);
    expect(tokenCalls(cb, "refresh_token")).toHaveLength(1);
    expect(events(p)).toContain("coinbase_rate_limited");
  });

  it("T-CONN-09 revoked at Coinbase, a narrowed grant, or a refused renewal: reconnect, no figures, grant forgotten", async () => {
    for (const how of ["revoked", "invalid_scope", "renewal"] as const) {
      const { p, cb } = await setup();
      await register(p, "alice");
      cb.setAccounts(ACCOUNTS);
      await connect(p, cb, "alice");
      if (how === "renewal") {
        cb.revokeAllOutside();
        p.l2.clock.advance(3_600_000);
      } else cb.setFault(how);
      expect((await balances(p, "alice")).body, how).toEqual({ status: "reconnect" });
      const wallet = await p.as("alice")<{ connections: Body[] }>("GET", "/api/wallet");
      expect(wallet.body.connections[0]!.status, how).toBe("reconnect");
      expect(readFileSync(join(p.connectionDir, `${p.userId("alice")}.json`), "utf8"), how).not.toContain('"grant"');
      expect(events(p), how).toContain("coinbase_reconnect_needed");
      // Review 4: nothing is left to revoke, so the person isn't told to go and remove it at Coinbase.
      expect((await p.as("alice")<Body>("DELETE", "/api/connections/coinbase")).body, how).toEqual({ revokedAtPlatform: true });
    }
  });

  it("T-CONN-09 a wrong or rotated client secret refuses the portal, never the person: every grant is kept (review 1)", async () => {
    const callers = await createTestIssuer();
    const { p, cb } = await setup({ callers });
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    // The same deployment restarted with a wrong secret: no access token in memory, so the read needs a renewal.
    const wrong = await startPortal({ l2: p.l2, callers, coinbase: cb, connectionDir: p.connectionDir, grantKey: p.grantKey, env: { COINBASE_CLIENT_SECRET: "wrong-secret" } });
    portals.push(wrong);
    p.l2.clock.advance(3_600_000);
    expect((await balances(wrong, "alice")).body).toEqual({ status: "unreadable" });
    const file = JSON.parse(readFileSync(join(p.connectionDir, `${p.userId("alice")}.json`), "utf8")) as { connections: Body[] };
    expect(file.connections[0]).toMatchObject({ status: "connected", grant: expect.any(Object) });
    expect(events(wrong)).toContain("coinbase_client_refused");
    expect(events(wrong)).not.toContain("coinbase_reconnect_needed");
    // A start and a complete with the wrong secret: 502, never invalid_state.
    const s = await wrong.as("alice")<{ authorizeUrl: string }>("POST", "/api/connections/coinbase/start");
    const a = cb.authorize(s.body.authorizeUrl);
    expect((await wrong.as("alice")<Body>("POST", "/api/connections/coinbase/complete", { code: a.code, state: a.state })).body).toEqual({ error: "platform_unavailable" });
    // Back with the right secret, the grant still reads.
    expect((await balances(p, "alice", true)).body.stale).toBe(false);
  });

  const concurrentRenewals = async (o: StartPortalOptions["connections"]) => {
    const { p, cb } = await setup({ connections: o });
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    // The access token and the figures have expired: both reads need a renewal.
    p.l2.clock.advance(3_600_000);
    const answers = await Promise.all([balances(p, "alice"), balances(p, "alice")]);
    return { p, cb, answers };
  };

  it("T-CONN-09 two reads at once make one renewal; the new refresh token is in the file before it is used", async () => {
    const { p, cb, answers } = await concurrentRenewals({});
    expect(answers.map((a) => a.body.status)).toEqual([undefined, undefined]);
    expect(tokenCalls(cb, "refresh_token")).toHaveLength(1);
    expect(cb.liveGrants()).toBe(1);
    const file = JSON.parse(readFileSync(join(p.connectionDir, `${p.userId("alice")}.json`), "utf8")) as { connections: Body[] };
    expect(file.connections[0]!.status).toBe("connected");
  });

  it("T-CONN-09 must-fail: with unserializedRenewals, the second read reuses the refresh token and Coinbase ends the link", async () => {
    const { cb, answers } = await concurrentRenewals({ unserializedRenewals: true });
    expect(tokenCalls(cb, "refresh_token")).toHaveLength(2);
    expect(answers.map((a) => a.body.status)).toContain("reconnect");
    expect(cb.liveGrants()).toBe(0);
  });

  it("T-CONN-09 a renewal listing a scope outside the allow-list ends the connection; `all` is accepted and logged unverified", async () => {
    for (const [scope, expected] of [
      ["wallet:accounts:read wallet:transactions:send", "reconnect"],
      ["all", undefined],
    ] as const) {
      const { p, cb } = await setup();
      await register(p, "alice");
      cb.setAccounts(ACCOUNTS);
      await connect(p, cb, "alice");
      p.l2.clock.advance(3_600_000);
      cb.renewalScope(scope);
      expect((await balances(p, "alice")).body.status, scope).toBe(expected);
      if (expected === undefined) expect(events(p)).toContain("coinbase_scope_unverified");
    }
  });

  it("T-CONN-09 a failed write after a renewal revokes the new grant and needs a reconnect", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    p.l2.clock.advance(3_600_000);
    chmodSync(p.connectionDir, 0o500);
    try {
      expect((await balances(p, "alice")).body).toEqual({ status: "reconnect" });
    } finally {
      chmodSync(p.connectionDir, 0o700);
    }
    expect(cb.liveGrants()).toBe(0);
    expect(events(p)).toContain("coinbase_grant_write_failed");
  });

  it("T-CONN-09 rates unavailable for more than 60 s: amounts shown, no values and no total", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts([{ code: "BTC", name: "Bitcoin", amount: "1" }]);
    await connect(p, cb, "alice");
    cb.setRates("broken" as unknown as Record<string, string>);
    const res = await balances(p, "alice");
    expect(res.body).toMatchObject({ assets: [{ code: "BTC", amount: "1" }], leftOutOfTotal: ["BTC"] });
    expect(res.body.total).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US3: privacy and separation
// ---------------------------------------------------------------------------

describe("T-CONN-06 a grant moved to another user doesn't read (FR-026, SEC-57)", () => {
  const moveGrant = async (o: StartPortalOptions["connections"]) => {
    const { p, cb } = await setup({ connections: o });
    await register(p, "alice");
    await register(p, "bob");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    // Alice's stored connection, copied into Bob's file under Bob's name.
    const aliceFile = JSON.parse(readFileSync(join(p.connectionDir, `${p.userId("alice")}.json`), "utf8")) as { connections: unknown[] };
    writeFileSync(join(p.connectionDir, `${p.userId("bob")}.json`), JSON.stringify({ userId: p.userId("bob"), connections: aliceFile.connections }), { mode: 0o600 });
    return balances(p, "bob");
  };

  it("T-CONN-06 Bob's copy of Alice's grant doesn't open: reconnect", async () => {
    expect((await moveGrant({})).body).toEqual({ status: "reconnect" });
  });

  it("T-CONN-06 must-fail: with skipGrantBinding, Bob reads Alice's balances", async () => {
    expect((await moveGrant({ skipGrantBinding: true })).body).toMatchObject({ assets: expect.arrayContaining([expect.objectContaining({ code: "BTC" })]) });
  });
});

describe("T-CONN-07 one user never reaches another's connection (FR-005, SEC-57)", () => {
  const bobReads = async (o: StartPortalOptions["connections"]) => {
    const { p, cb } = await setup({ connections: o });
    await register(p, "alice");
    await register(p, "bob");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    return { p, res: await balances(p, "bob") };
  };

  it("T-CONN-07 Bob gets 404 not_connected for balances and for disconnecting; Alice's connection stays", async () => {
    const { p, res } = await bobReads({});
    expect(res.body).toEqual({ error: "not_connected" });
    expect((await p.as("bob")<Body>("DELETE", "/api/connections/coinbase")).body).toEqual({ error: "not_connected" });
    expect(((await p.as("alice")<{ connections: Body[] }>("GET", "/api/wallet")).body.connections[0]!.status)).toBe("connected");
  });

  it("T-CONN-07 must-fail: with skipConnectionOwner, Bob gets Alice's figures", async () => {
    const { res } = await bobReads({ skipConnectionOwner: true });
    expect(res.body).toMatchObject({ assets: expect.arrayContaining([expect.objectContaining({ code: "BTC" })]) });
  });
});

describe("T-CONN-10 nothing of a connection leaves the portal's sealed file (FR-021, FR-023, FR-027, FR-029, SEC-56)", () => {
  it("T-CONN-10 two users connect, read and one disconnects: known values appear nowhere else, and only the six calls were made", async () => {
    const { p, cb } = await setup();
    cb.setAccounts(ACCOUNTS);
    cb.setRates(RATES);
    for (const who of ["alice", "bob"]) {
      await register(p, who);
      await connect(p, cb, who);
      await balances(p, who);
    }
    expect((await p.as("bob")<Body>("DELETE", "/api/connections/coinbase")).status).toBe(200);
    const known = cb.knownValues();
    const ledger = readFileSync(p.l2.ledgerFile, "utf8");
    const logs = p.rawLogs.join("\n");
    const grants = readdirSync(p.connectionDir).map((n) => readFileSync(join(p.connectionDir, n), "utf8")).join("\n");
    const answers = p.responses.join("\n");
    for (const v of known) {
      expect(ledger, "ledger").not.toContain(v);
      expect(logs, "logs").not.toContain(v);
      expect(grants, "grant files").not.toContain(v);
      expect(answers, "answers").not.toContain(v);
    }
    // Amounts and names of the accounts never reach the ledger, the logs or the grant files.
    for (const v of ["0.50000000", "1.000000000000000001", "Bitcoin", "Ethereum", "52022.85"]) {
      expect(ledger).not.toContain(v);
      expect(logs).not.toContain(v);
      expect(grants).not.toContain(v);
    }
    // The connection entries carry identifiers only.
    expect(ledger).not.toMatch(/coinbase\.com|access|refresh/i);
    // Every log line is whitelisted; connection events are fixed labels.
    for (const line of p.logs) {
      for (const k of Object.keys(line)) expect(LOG_KEYS).toContain(k);
      if (line.route === "connections") expect(CONNECTION_EVENTS as readonly unknown[]).toContain(line.event);
      expect(JSON.stringify(line)).not.toMatch(/conn_/);
    }
    // The stand-in saw only the six calls of contracts/coinbase.md (FR-021).
    const allowed = new Set(["POST /oauth2/token", "POST /oauth2/revoke", "GET /v2/accounts", "GET /v2/exchange-rates"]);
    for (const r of cb.requests) {
      expect(allowed.has(`${r.method} ${r.path}`), `${r.method} ${r.path}`).toBe(true);
      expect(r.query).not.toHaveProperty("fetch_all");
    }
  });
});

describe("T-CONN-11 a connection changes no payment decision and no budget answer (FR-020, FR-022, SC-005)", () => {
  it("T-CONN-11 the same intents for a user without and with a connection are decided the same; check_budget names no platform", async () => {
    const l2 = await startUsersL2();
    l2s.push(l2);
    await l2.onboard(ALICE);
    const run = async (sessionId: string) => {
      const out: unknown[] = [];
      for (const [path, amount] of [["/api/a", "1000"], ["/api/b", "30000"], ["/api/c", "200000"]] as const) {
        const d = (await l2.authorize(l2.intentFor(path, amount, { sessionId, userId: ALICE }))).body as unknown as Body;
        out.push({ status: d.status, violations: d.violations, amount: d.amountAtomic });
      }
      const budget = (await l2.budget(sessionId, { userId: ALICE })).body as unknown as Body;
      return { out, budget };
    };
    const without = await run("sess_without");
    const spentBefore = without.budget;
    await l2.portal("PUT", `/v1/users/${ALICE}/connections/conn_00000000-0000-4000-8000-000000000001`, { platform: "coinbase" });
    const withConn = await run("sess_with");
    expect(withConn.out).toEqual(without.out);
    expect(Object.keys(withConn.budget).sort()).toEqual(Object.keys(spentBefore).sort());
    expect(JSON.stringify(withConn.budget)).not.toMatch(/coinbase|conn_|platform/i);
  });
});

// ---------------------------------------------------------------------------
// US4: disconnecting
// ---------------------------------------------------------------------------

describe("T-CONN-12 disconnecting forgets, revokes, checks and records (FR-018, FR-019, research R12, R15)", () => {
  it("T-CONN-12 disconnect: file first, revoked and checked by a 401, then L2; within 10 s; the wallet offers to connect again", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    cb.setAccounts(ACCOUNTS);
    await connect(p, cb, "alice");
    const t = Date.now();
    const res = await p.as("alice")<Body>("DELETE", "/api/connections/coinbase");
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(res.body).toEqual({ revokedAtPlatform: true });
    expect(cb.liveGrants()).toBe(0);
    expect(p.l2.entries("CONNECTION_CLOSED")).toHaveLength(1);
    expect(existsSync(join(p.connectionDir, `${p.userId("alice")}.json`))).toBe(false);
    expect(((await p.as("alice")<{ connections: Body[] }>("GET", "/api/wallet")).body.connections[0]!.status)).toBe("not_connected");
    expect(events(p)).toContain("coinbase_disconnected");
  });

  const unconfirmed = async (o: StartPortalOptions["connections"]) => {
    const { p, cb } = await setup({ connections: o });
    await register(p, "alice");
    await connect(p, cb, "alice");
    cb.revokeDoesNothing(true);
    return { p, cb, res: await p.as("alice")<Body>("DELETE", "/api/connections/coinbase") };
  };

  it("T-CONN-12 Coinbase answers 200 but revokes nothing: revokedAtPlatform false, the grant forgotten anyway", async () => {
    const { p, cb, res } = await unconfirmed({});
    expect(res.body).toEqual({ revokedAtPlatform: false });
    expect(cb.liveGrants()).toBe(1);
    expect(existsSync(join(p.connectionDir, `${p.userId("alice")}.json`))).toBe(false);
    expect(events(p)).toContain("coinbase_revoke_failed");
  });

  it("T-CONN-12 must-fail: with trustRevokeAnswer, the 200 is taken as proof and the person is told it was revoked while it still reads", async () => {
    const { cb, res } = await unconfirmed({ trustRevokeAnswer: true });
    expect(res.body).toEqual({ revokedAtPlatform: true });
    expect(cb.liveGrants()).toBe(1);
  });

  it("T-CONN-12 disabling the account disconnects; L2 records it; a disabled account can still disconnect", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    await connect(p, cb, "alice");
    expect((await p.as("alice")("POST", "/api/account/disable", { confirm: true })).status).toBe(200);
    expect(cb.liveGrants()).toBe(0);
    expect(p.l2.entries("CONNECTION_CLOSED")).toHaveLength(1);
    expect((await p.as("alice")<Body>("DELETE", "/api/connections/coinbase")).body).toEqual({ error: "not_connected" });
  });

  it("T-CONN-12 reconcile: a file entry L2 doesn't show is removed and revoked after the answer; an L2 connection without a file is closed", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    await connect(p, cb, "alice");
    const userId = p.userId("alice");
    const [opened] = p.l2.entries("CONNECTION_OPENED");
    // L2 closes it behind the portal's back (as if the portal's DELETE to L2 had been lost the other way round).
    await p.l2.portal("DELETE", `/v1/users/${userId}/connections/${String(opened!.data.connectionId)}`);
    cb.setFault("timeout", { everywhere: true });
    const t = Date.now();
    const wallet = await p.as("alice")<{ connections: Body[] }>("GET", "/api/wallet");
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(wallet.body.connections[0]!.status).toBe("not_connected");
    cb.setFault(undefined);
    // An L2 connection with no file: closed at L2 by the next wallet read.
    await p.l2.portal("PUT", `/v1/users/${userId}/connections/conn_00000000-0000-4000-8000-000000000009`, { platform: "coinbase" });
    await p.as("alice")("GET", "/api/wallet");
    expect((await p.l2.portal<UserView>("GET", `/v1/users/${userId}`)).body.connections).toEqual([]);
    expect(events(p)).toContain("coinbase_reconciled");
  });

  it("T-CONN-12 an unreadable grant file closes nothing at L2: the wallet shows unavailable and the connection stays (review 2)", async () => {
    const { p, cb } = await setup();
    await register(p, "alice");
    await connect(p, cb, "alice");
    const file = join(p.connectionDir, `${p.userId("alice")}.json`);
    const good = readFileSync(file, "utf8");
    writeFileSync(file, good.slice(0, 20));
    const wallet = await p.as("alice")<{ connections: Body[] }>("GET", "/api/wallet");
    expect(wallet.status).toBe(200);
    expect(wallet.body.connections).toEqual([{ platform: "coinbase", status: "unavailable", privacyPolicyUrl: "https://example.org/privacy", supportUrl: "mailto:support@example.org" }]);
    expect(p.l2.entries("CONNECTION_CLOSED")).toEqual([]);
    expect((await balances(p, "alice")).body).toEqual({ error: "unavailable" });
    expect((await p.as("alice")<Body>("DELETE", "/api/connections/coinbase")).body).toEqual({ error: "unavailable" });
    expect(cb.liveGrants()).toBe(1);
    expect(events(p)).toContain("coinbase_store_unreadable");
    // Readable again: everything as before.
    writeFileSync(file, good);
    expect(((await p.as("alice")<{ connections: Body[] }>("GET", "/api/wallet")).body.connections[0]!.status)).toBe("connected");
  });

  it("T-CONN-12 a wallet read with nothing stored and nothing at L2 makes no extra call to L2 (review 5)", async () => {
    const callers = await createTestIssuer();
    const { p } = await setup({ callers });
    await register(p, "alice");
    const plain = await startPortal({ l2: p.l2, callers });
    portals.push(plain);
    const count = async (on: PortalTestApp) => {
      const before = p.l2.requestCount();
      expect((await on.as("alice")("GET", "/api/wallet")).status).toBe(200);
      return p.l2.requestCount() - before;
    };
    expect(await count(p)).toBe(await count(plain));
  });

  it("T-CONN-12 switched off after connecting: unavailable in the wallet; DELETE forgets it, records it at L2, revokedAtPlatform false", async () => {
    // One sign-in tenant for both portals (the same deployment before and after the switch).
    const callers = await createTestIssuer();
    const { p, cb } = await setup({ callers });
    await register(p, "alice");
    await connect(p, cb, "alice");
    const off = await startPortal({ l2: p.l2, callers, connectionsOff: true, connectionDir: p.connectionDir });
    portals.push(off);
    const reads = cb.requests.length;
    const offWallet = await off.as("alice")<{ connections: Body[] }>("GET", "/api/wallet");
    expect(offWallet.status, JSON.stringify(offWallet.body)).toBe(200);
    expect(offWallet.body.connections).toEqual([
      { platform: "coinbase", status: "unavailable", connectedAt: expect.any(String), privacyPolicyUrl: "", supportUrl: "" },
    ]);
    expect((await off.as("alice")<Body>("POST", "/api/connections/coinbase/start")).body).toEqual({ error: "not found" });
    expect((await off.as("alice")<Body>("DELETE", "/api/connections/coinbase")).body).toEqual({ revokedAtPlatform: false });
    expect(p.l2.entries("CONNECTION_CLOSED")).toHaveLength(1);
    expect(cb.requests.length).toBe(reads);
    expect((await off.as("alice")<Body>("DELETE", "/api/connections/coinbase")).body).toEqual({ error: "not found" });
  });
});
