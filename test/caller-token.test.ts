// 016 — the caller's token at L2 (SPEC L2-5, L2-8 v1.17, SEC-20, SEC-32, SEC-33; specs/016
// contracts/control-api.md). The hosted agent forwards the access token its caller presented, beside its own role
// token; L2 verifies it itself and takes the user from it. In-process L2 with user accounts on and a test issuer
// (test/helpers/users.ts, test/helpers/caller-tokens.ts): the real routes, the real check, a real ledger.
// T-CTK-01 the order of checks; T-CTK-02 who the payment is for; T-CTK-03 a request names nobody; T-CTK-04 the
// caller's token opens nothing by itself; T-CTK-05 where a token is required; T-CTK-06 startup; T-CTK-07 the token
// is written nowhere; T-CTK-08 it is verified outside the serialized section; T-CTK-09 the check is bounded per
// calling address.
// Every must-fail switch (`trustIntentUser`, `skipRequired`, `skipClientCheck`, `skipPermission`, `echoCaller`,
// `skipLimit`) is a test-only dep of L2's caller check, never an environment variable.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_PORTAL_CLIENT } from "../scripts/dev-issuer-lib.js";
import { callerSettingsFromEnv } from "../src/layer2-control/caller.js";
import { ConfigError } from "../src/shared/config.js";
import type { TokenKeys } from "../src/shared/identity-token.js";
import { createTestIssuer } from "./helpers/caller-tokens.js";
import { ALICE, BOB, PLATFORM_PAYER, startUsersL2, TOKENS, type UsersL2 } from "./helpers/users.js";

const opened: UsersL2[] = [];
async function start(o: Parameters<typeof startUsersL2>[0] = {}) {
  const l2 = await startUsersL2(o);
  opened.push(l2);
  return l2;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const l2 of opened.splice(0)) await l2.close().catch(() => {});
});

const nowSec = () => Math.floor(Date.now() / 1000);
/** 018: the subject a first Google sign-in makes (`google-oauth2|<Google's sub>`, digits only). */
const GOOGLE_SUB = "google-oauth2|104857600012345678901";
const payerOf = (body: unknown) => String((body as { payer?: string }).payer ?? "").toLowerCase();
const rulesOf = (body: unknown) => ((body as { violations?: { rule: string }[] }).violations ?? []).map((v) => v.rule);

describe("T-CTK-01 the order of checks on the two routes L1 calls (016 contracts/control-api.md)", () => {
  /** Both routes, with `token` as the role token and `caller` as the forwarded one. */
  async function both(l2: UsersL2, o: { token?: string | null; caller?: string; body?: Record<string, unknown> }) {
    const body = o.body ?? l2.intentFor("/api/weather", "1000");
    const args = { ...(o.token !== undefined && { token: o.token }), ...(o.caller !== undefined && { caller: o.caller }) };
    const authorize = await l2.call<{ error?: string }>("POST", "/v1/authorize", { token: TOKENS.control, ...args, body });
    const budget = await l2.call<{ error?: string }>("GET", "/v1/budget/sess_u", { token: TOKENS.control, ...args });
    return [
      [authorize.status, authorize.body.error],
      [budget.status, budget.body.error],
    ];
  }
  const twice = (status: number, error: string) => [
    [status, error],
    [status, error],
  ];

  it("T-CTK-01 row 1: without the control token the answer is 401 unauthorized, whatever the caller's token", async () => {
    const l2 = await start();
    const caller = await l2.callers.forUser(ALICE);
    for (const token of [null, TOKENS.portal, TOKENS.operator, TOKENS.settlement, "wrong"]) {
      expect(await both(l2, { token, caller }), String(token)).toEqual(twice(401, "unauthorized"));
    }
    expect(l2.entries("INTENT")).toEqual([]);
  });

  it("T-CTK-01 row 2: sign-in configured and no caller's token, or one that is not `Bearer <token>`: 401 caller_token_required", async () => {
    const l2 = await start();
    const before = l2.entries().length;
    expect(await both(l2, {})).toEqual(twice(401, "caller_token_required"));
    const jwt = await l2.callers.forUser(ALICE);
    for (const header of [jwt, `Basic ${jwt}`, "Bearer", `Bearer ${jwt} extra`]) {
      const res = await fetch(`${l2.url}/v1/authorize`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKENS.control}`, "x-caller-authorization": header, "content-type": "application/json" },
        body: JSON.stringify(l2.intentFor("/api/weather", "1000")),
      });
      expect([res.status, await res.json()], header.slice(0, 12)).toEqual([401, { error: "caller_token_required" }]);
    }
    expect(l2.entries().length).toBe(before);
  });

  it("T-CTK-01 row 3: sign-in not configured and a caller's token present: 400 caller_token_not_accepted; absent, the request is decided", async () => {
    const l2 = await start({ off: true });
    const stray = await l2.callers.machine();
    expect(await both(l2, { caller: stray })).toEqual(twice(400, "caller_token_not_accepted"));
    expect(l2.entries()).toEqual([]);
    expect((await l2.authorize(l2.intentFor("/api/weather", "1000"))).body.status).toBe("AUTHORIZED");
  });

  it("T-CTK-01 row 4: a token that does not verify is 401: caller_token_expired when only its time is wrong, caller_token_invalid otherwise", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const before = l2.entries().length;
    const other = await createTestIssuer();
    const sub = l2.callers.subjectOf(ALICE)!;
    const cases: Array<[string, string, string]> = [
      ["expired", await l2.callers.forUser(ALICE, { exp: nowSec() - 120 }), "caller_token_expired"],
      ["an expired machine token", await l2.callers.machine({ exp: nowSec() - 120 }), "caller_token_expired"],
      ["not yet valid", await l2.callers.forUser(ALICE, { nbf: nowSec() + 300 }), "caller_token_invalid"],
      ["signed by another key", await other.person(sub), "caller_token_invalid"],
      ["expired and signed by another key", await other.person(sub, { exp: nowSec() - 120 }), "caller_token_invalid"],
      ["another audience", await (await createTestIssuer({ audience: "api://someone-else" })).person(sub), "caller_token_invalid"],
      ["another issuer", await (await createTestIssuer({ issuer: "https://other.eu.auth0.com/" })).person(sub), "caller_token_invalid"],
      ["a machine token whose subject is another client's", await l2.callers.machine({ sub: "other-client@clients" }), "caller_token_invalid"],
      ["text that is not a token", "not-a-token", "caller_token_invalid"],
    ];
    for (const [name, caller, error] of cases) expect(await both(l2, { caller }), name).toEqual(twice(401, error));
    expect(l2.entries().length).toBe(before);
  });

  it("T-CTK-01 row 5: a verified caller who may not call the agent is 403 caller_forbidden: no permission, or a client that is not the agent's", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const before = l2.entries().length;
    const cases: Array<[string, string]> = [
      ["a person without agent:run", await l2.callers.forUser(ALICE, { permissions: [] })],
      ["an administrator without the agent role", await l2.callers.forUser(ALICE, { permissions: ["portal:admin"] })],
      ["a person from the portal's client", await l2.callers.forUser(ALICE, { azp: DEV_PORTAL_CLIENT, authTime: nowSec() })],
      ["a person from a client nobody listed", await l2.callers.forUser(ALICE, { azp: "some-other-client" })],
      ["a machine caller whose grant lacks agent:run", await l2.callers.machine({ scope: "other:thing" })],
      ["a machine caller with no scope", await l2.callers.machine({ scope: null })],
    ];
    for (const [name, caller] of cases) expect(await both(l2, { caller }), name).toEqual(twice(403, "caller_forbidden"));
    expect(l2.entries().length).toBe(before);
  });

  it("T-CTK-01 row 5 a brand-new Google person without agent:run, forwarded by a faulty L1: 403 caller_forbidden, nothing appended (018)", async () => {
    const l2 = await start();
    // A first Google sign-in made this person a moment ago (specs/018 contracts/new-person-access.md): Google's
    // subject shape, no permission. They set up their account in the portal, which needs no role.
    const newcomer = l2.callers.register(GOOGLE_SUB);
    await l2.onboard(newcomer);
    const before = l2.entries().length;
    const caller = await l2.callers.person(GOOGLE_SUB, { permissions: [] });
    expect(await both(l2, { caller })).toEqual(twice(403, "caller_forbidden"));
    expect(l2.entries().length).toBe(before);
  });

  it("T-CTK-01 row 6: a person's token while user accounts are off is 403: a person pays from their own account or not at all", async () => {
    const l2 = await start({ off: true, caller: {} });
    expect(await both(l2, { caller: await l2.callers.forUser(ALICE) })).toEqual(twice(403, "caller_forbidden"));
    expect(l2.entries()).toEqual([]);
    // A machine caller still pays from the platform account there.
    const machine = await l2.authorize(l2.intentFor("/api/weather", "1000"), { caller: await l2.callers.machine() });
    expect([machine.body.status, payerOf(machine.body)]).toEqual(["AUTHORIZED", PLATFORM_PAYER.toLowerCase()]);
  });

  it("T-CTK-01 a refused caller's body is never read: a body that is not JSON gets the caller's refusal, not a 400", async () => {
    const l2 = await start();
    const send = (caller?: string) =>
      fetch(`${l2.url}/v1/authorize`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKENS.control}`, "content-type": "application/json", ...(caller !== undefined && { "x-caller-authorization": `Bearer ${caller}` }) },
        body: "{ this is not JSON",
      });
    expect((await send()).status).toBe(401);
    expect((await send(await l2.callers.forUser(ALICE, { permissions: [] }))).status).toBe(403);
    expect((await send(await l2.callers.forUser(ALICE))).status).toBe(400);
  });

  it("T-CTK-01 must fail without the client check: a token the portal's web app obtained pays from that person's account", async () => {
    const portalToken = (l2: UsersL2) => l2.callers.forUser(ALICE, { azp: DEV_PORTAL_CLIENT, authTime: nowSec() });
    const safe = await start();
    await safe.onboard(ALICE);
    expect((await safe.authorize(safe.intentFor("/api/weather", "1000"), { caller: await portalToken(safe) })).status).toBe(403);
    const unsafe = await start({ caller: { skipClientCheck: true } });
    const { address } = await unsafe.onboard(ALICE);
    const paid = await unsafe.authorize(unsafe.intentFor("/api/weather", "1000"), { caller: await portalToken(unsafe) });
    expect([paid.body.status, payerOf(paid.body)]).toEqual(["AUTHORIZED", address.toLowerCase()]);
  });

  it("T-CTK-01 must fail without the permission: a person without the role, and a machine caller without a grant, both pay", async () => {
    const unsafe = await start({ caller: { skipPermission: true } });
    const { address } = await unsafe.onboard(ALICE);
    const person = await unsafe.authorize(unsafe.intentFor("/api/weather", "1000"), { caller: await unsafe.callers.forUser(ALICE, { permissions: [] }) });
    expect([person.body.status, payerOf(person.body)]).toEqual(["AUTHORIZED", address.toLowerCase()]);
    const machine = await unsafe.authorize(unsafe.intentFor("/api/weather", "1000", { sessionId: "sess_m" }), { caller: await unsafe.callers.machine({ scope: null }) });
    expect([machine.body.status, payerOf(machine.body)]).toEqual(["AUTHORIZED", PLATFORM_PAYER.toLowerCase()]);
    // 018: so does a brand-new Google person without the role, from their own account.
    const newcomer = unsafe.callers.register(GOOGLE_SUB);
    const theirs = await unsafe.onboard(newcomer);
    const google = await unsafe.authorize(unsafe.intentFor("/api/weather", "1000", { sessionId: "sess_g" }), { caller: await unsafe.callers.person(GOOGLE_SUB, { permissions: [] }) });
    expect([google.body.status, payerOf(google.body)]).toEqual(["AUTHORIZED", theirs.address.toLowerCase()]);
  });
});

describe("T-CTK-02 who the payment is for comes from the token L2 verified (016 FR-011, FR-017, SEC-32, SEC-33)", () => {
  it("T-CTK-02 a person's token: their policy decides, their account signs, and every entry names them", async () => {
    const l2 = await start();
    const alice = await l2.onboard(ALICE);
    const bob = await l2.onboard(BOB, { dailyBudgetAtomic: "500" });
    const intent = () => l2.intentFor("/api/weather", "1000");
    const asAlice = await l2.authorize(intent(), { caller: await l2.callers.forUser(ALICE) });
    expect([asAlice.body.status, payerOf(asAlice.body)]).toEqual(["AUTHORIZED", alice.address.toLowerCase()]);
    // The same request with bob's token: bob's policy decides it, and bob's tighter budget denies it.
    const asBob = await l2.authorize(intent(), { caller: await l2.callers.forUser(BOB) });
    expect(asBob.body.status).toBe("DENIED");
    expect(rulesOf(asBob.body)).toContain("daily_budget_exceeded");
    expect(bob.address).not.toBe(alice.address);
    const owners = l2.entries().filter((e) => e.type === "INTENT" || e.type === "AUTHORIZED" || e.type === "DENIED").map((e) => [e.type, e.data.userId]);
    expect(owners).toEqual([
      ["INTENT", ALICE],
      ["AUTHORIZED", ALICE],
      ["INTENT", BOB],
      ["DENIED", BOB],
    ]);
  });

  it("T-CTK-02 a machine caller's token names no user: the platform account pays under the platform mandate, and no entry names anyone", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const before = l2.entries().length;
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000", { sessionId: "sess_machine" }), { caller: await l2.callers.machine() });
    expect([res.body.status, payerOf(res.body)]).toEqual(["AUTHORIZED", PLATFORM_PAYER.toLowerCase()]);
    for (const e of l2.entries().slice(before)) expect("userId" in e.data, e.type).toBe(false);
    const budget = await l2.budget("sess_machine");
    expect(budget.body).toMatchObject({ sessionCapAtomic: l2.mandate.sessionBudgetAtomic, spentOrReservedAtomic: "1000" });
    expect(budget.body.scope).toBeUndefined();
  });

  it("T-CTK-02 a person never falls back to the platform account: with no account they are denied, and the platform payer signs nothing", async () => {
    const l2 = await start();
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000"), { caller: await l2.callers.forUser(ALICE) });
    expect(res.body.status).toBe("DENIED");
    expect(rulesOf(res.body)).toEqual(["user_not_onboarded"]);
    expect(l2.entries("AUTHORIZED")).toEqual([]);
    expect(l2.entries("DENIED").map((e) => e.data.userId)).toEqual([ALICE]);
  });

  it("T-CTK-02 a person's budget view is their own: the daily ceiling, counted for them alone", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    await l2.onboard(BOB);
    await l2.authorize(l2.intentFor("/api/weather", "1000"), { caller: await l2.callers.forUser(ALICE) });
    expect((await l2.budget("sess_u", { userId: ALICE })).body).toMatchObject({ scope: "user_daily", spentOrReservedAtomic: "1000" });
    expect((await l2.budget("sess_u", { userId: BOB })).body).toMatchObject({ scope: "user_daily", spentOrReservedAtomic: "0" });
  });
});

describe("T-CTK-03 a request names nobody (016 FR-012, SEC-32)", () => {
  it("T-CTK-03 alice's token and a request that names bob: refused, on the payment and on the budget, and nothing is decided", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    await l2.onboard(BOB);
    const before = l2.entries().length;
    const caller = await l2.callers.forUser(ALICE);
    for (const extra of [{ userId: BOB }, { userId: ALICE }, { approvalSubject: "auth0|bob" }, { userId: BOB, approvalSubject: "auth0|bob" }]) {
      const res = await l2.authorize({ ...l2.intentFor("/api/weather", "1000"), ...extra }, { caller });
      expect([res.status, res.body.error], JSON.stringify(extra)).toEqual([400, "malformed PaymentIntent"]);
    }
    const budget = await l2.call<{ error?: string }>("GET", `/v1/budget/sess_u?userId=${BOB}`, { token: TOKENS.control, caller });
    expect([budget.status, budget.body.error]).toEqual([400, "userId is not accepted: the user comes from the caller's token"]);
    expect(l2.entries().length).toBe(before);
  });

  it("T-CTK-03 must fail when L2 takes the user from the request, as before 016: with alice's token, bob's account signs and bob's budget is read", async () => {
    const l2 = await start({ caller: { trustIntentUser: true } });
    const alice = await l2.onboard(ALICE);
    const bob = await l2.onboard(BOB);
    const caller = await l2.callers.forUser(ALICE);
    const res = await l2.authorize({ ...l2.intentFor("/api/weather", "1000"), userId: BOB }, { caller });
    // Bob never called anything, and his account paid.
    expect([res.body.status, payerOf(res.body)]).toEqual(["AUTHORIZED", bob.address.toLowerCase()]);
    expect(payerOf(res.body)).not.toBe(alice.address.toLowerCase());
    expect(l2.entries("AUTHORIZED").map((e) => e.data.userId)).toEqual([BOB]);
    const budget = await l2.call<{ spentOrReservedAtomic?: string }>("GET", `/v1/budget/sess_u?userId=${BOB}`, { token: TOKENS.control, caller });
    expect([budget.status, budget.body.spentOrReservedAtomic]).toEqual([200, "1000"]);
  });
});

describe("T-CTK-04 the caller's token opens nothing by itself (016 FR-016, INV-13)", () => {
  it("T-CTK-04 as the only token, or in place of the role token, a person's valid token is 401 on the two routes and on every other", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const jwt = await l2.callers.forUser(ALICE);
    const before = l2.entries().length;
    const routes: Array<[string, string]> = [
      ["POST", "/v1/authorize"],
      ["GET", "/v1/budget/sess_u"],
      ["GET", "/v1/escalations"],
      ["POST", "/v1/approvals/auth_x"],
      ["POST", "/v1/reconcile"],
      ["GET", "/v1/ledger/verify"],
      ["GET", `/v1/users/${ALICE}`],
      ["GET", "/v1/admin/escalations"],
    ];
    for (const [method, path] of routes) {
      const body = method === "POST" ? l2.intentFor("/api/weather", "1000") : undefined;
      // In the caller's header alone, and as the bearer token itself.
      const alone = await l2.call(method, path, { token: null, caller: jwt, ...(body && { body }) });
      const asRole = await l2.call(method, path, { token: jwt, ...(body && { body }) });
      expect([alone.status, asRole.status], `${method} ${path}`).toEqual([401, 401]);
    }
    expect(l2.entries().length).toBe(before);
  });

  it("T-CTK-04 no other route reads the header: the portal's and the operator's routes answer the same with and without it", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const jwt = await l2.callers.forUser(BOB);
    const plain = await l2.call("GET", `/v1/users/${ALICE}`, {});
    const withHeader = await l2.call("GET", `/v1/users/${ALICE}`, { caller: jwt });
    expect(withHeader).toEqual(plain);
    expect((await l2.call("GET", "/v1/escalations", { token: TOKENS.operator, caller: "garbage" })).status).toBe(200);
  });
});

describe("T-CTK-05 where sign-in is configured every payment request needs a caller's token (016 FR-014)", () => {
  it("T-CTK-05 configured: the control token alone is refused; not configured: it decides for the platform account, as before 016", async () => {
    const on = await start();
    const refused = await on.authorize(on.intentFor("/api/weather", "1000"), { caller: null });
    expect([refused.status, refused.body.error]).toEqual([401, "caller_token_required"]);
    expect(on.entries("INTENT")).toEqual([]);

    const off = await start({ caller: false });
    const paid = await off.authorize(off.intentFor("/api/weather", "1000"));
    expect([paid.body.status, payerOf(paid.body)]).toEqual(["AUTHORIZED", PLATFORM_PAYER.toLowerCase()]);
  });

  it("T-CTK-05 must fail without the requirement: L1's word alone spends the platform account", async () => {
    const l2 = await start({ caller: { skipRequired: true } });
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000"), { caller: null });
    expect([res.body.status, payerOf(res.body)]).toEqual(["AUTHORIZED", PLATFORM_PAYER.toLowerCase()]);
  });
});

describe("T-CTK-06 L2's sign-in settings are checked at startup (016 FR-015, CFG-2)", () => {
  const TENANT = { AUTH_ISSUER: "https://x402-test.eu.auth0.com/", AUTH_AUDIENCE: "https://x402-api/test", AGENT_CLIENT_IDS: "AgentClient0123" };
  const DEV = { AUTH_ISSUER: "urn:x402:dev-issuer", AUTH_AUDIENCE: "api://x402-l1-agent", AGENT_CLIENT_IDS: "x402-agent-cli-dev", AUTH_JWKS_FILE: ".local/dev-issuer/jwks.json" };

  it("T-CTK-06 all three settings, or none: none means sign-in is not configured", () => {
    expect(callerSettingsFromEnv({}, "local")).toBeUndefined();
    expect(callerSettingsFromEnv({ AUTH_ISSUER: "", AUTH_AUDIENCE: "", AGENT_CLIENT_IDS: "" }, "base-sepolia")).toBeUndefined();
    expect(callerSettingsFromEnv(TENANT, "base-sepolia")).toEqual({ issuer: TENANT.AUTH_ISSUER, audience: TENANT.AUTH_AUDIENCE, clientIds: ["AgentClient0123"] });
    expect(callerSettingsFromEnv({ ...TENANT, AGENT_CLIENT_IDS: " a1 , b2 " }, "local")?.clientIds).toEqual(["a1", "b2"]);
    for (const missing of ["AUTH_ISSUER", "AUTH_AUDIENCE", "AGENT_CLIENT_IDS"]) {
      expect(() => callerSettingsFromEnv({ ...TENANT, [missing]: "" }, "local"), missing).toThrow(/AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS go together/);
    }
  });

  it("T-CTK-06 the issuer is the tenant's, exactly as its tokens carry it; the dev issuer needs its key file, and only locally", () => {
    for (const bad of ["https://x402-test.eu.auth0.com", "http://x402-test.eu.auth0.com/", "urn:x402:dev-issuer", "https://login.microsoftonline.com/t/v2.0"]) {
      expect(() => callerSettingsFromEnv({ ...TENANT, AUTH_ISSUER: bad }, "local"), bad).toThrow(/AUTH_ISSUER must be the sign-in tenant's issuer/);
    }
    expect(callerSettingsFromEnv(DEV, "local")).toEqual({ issuer: DEV.AUTH_ISSUER, audience: DEV.AUTH_AUDIENCE, clientIds: ["x402-agent-cli-dev"], jwksFile: DEV.AUTH_JWKS_FILE });
    expect(() => callerSettingsFromEnv(DEV, "base-sepolia")).toThrow(/AUTH_JWKS_FILE is allowed only with NETWORK=local/);
    expect(() => callerSettingsFromEnv({ ...TENANT, AUTH_JWKS_FILE: "x.json" }, "local")).toThrow(/AUTH_ISSUER must be urn:x402:dev-issuer with AUTH_JWKS_FILE/);
    expect(() => callerSettingsFromEnv({ AUTH_JWKS_FILE: "x.json" }, "local")).toThrow(/AUTH_JWKS_FILE needs AUTH_ISSUER/);
  });

  it("T-CTK-06 the portal's client is never one of the agent's, and a refusal names the variable, never a value", () => {
    expect(() => callerSettingsFromEnv({ ...TENANT, AGENT_CLIENT_IDS: "AgentClient0123,PortalClient9", PORTAL_CLIENT_ID: "PortalClient9" }, "local")).toThrow(/AGENT_CLIENT_IDS must not contain PORTAL_CLIENT_ID/);
    expect(callerSettingsFromEnv({ ...TENANT, PORTAL_CLIENT_ID: "PortalClient9" }, "local")?.clientIds).toEqual(["AgentClient0123"]);
    for (const env of [{ ...TENANT, AGENT_CLIENT_IDS: "a b" }, { ...TENANT, AUTH_ISSUER: "https://secret-tenant.example" }, { ...TENANT, AGENT_CLIENT_IDS: "SecretClient,PortalSecret", PORTAL_CLIENT_ID: "PortalSecret" }]) {
      let message = "";
      try {
        callerSettingsFromEnv(env, "local");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      for (const secret of ["secret-tenant", "SecretClient", "PortalSecret", "a b"]) expect(message.includes(secret), message).toBe(false);
    }
  });

  it("T-CTK-06 main() refuses user accounts without sign-in, before the ledger lock, naming the three settings", () => {
    const main = readFileSync("src/layer2-control/service.ts", "utf8");
    const refusal = main.indexOf('"USER_ACCOUNTS=1 needs AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(main.indexOf("await acquireLedgerLock("));
    expect(main.slice(refusal - 400, refusal)).toMatch(/callerSettingsFromEnv\(process\.env, [^)]+\)[\s\S]*accounts\.enabled && signIn === undefined/);
  });
});

describe("T-CTK-07 the caller's token is written nowhere (016 FR-020, NFR-004)", () => {
  async function scan(o: Parameters<typeof start>[0] = {}) {
    const consoleLines: string[] = [];
    const printed = (...a: unknown[]) => void consoleLines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(printed);
    vi.spyOn(console, "error").mockImplementation(printed);
    const l2 = await start({ admin: true, ...o });
    await l2.onboard(ALICE);
    const person = await l2.callers.forUser(ALICE);
    const machine = await l2.callers.machine();
    const expired = await l2.callers.forUser(ALICE, { exp: nowSec() - 120 });
    const noRole = await l2.callers.forUser(ALICE, { permissions: [] });
    const bodies: unknown[] = [];
    const keep = async <T extends { body: unknown }>(p: Promise<T>) => {
      const r = await p;
      bodies.push(r.body);
      return r;
    };
    // A payment, an escalation and a denial for a person; a payment for a machine caller; four refusals.
    await keep(l2.authorize(l2.intentFor("/api/weather", "1000"), { caller: person }));
    const escalated = await keep(l2.authorize(l2.intentFor("/api/premium-report", "50000", { sessionId: "sess_e" }), { caller: person }));
    await keep(l2.authorize(l2.intentFor("/api/too-much", "200000", { sessionId: "sess_d" }), { caller: person }));
    await keep(l2.authorize(l2.intentFor("/api/weather", "1000", { sessionId: "sess_m" }), { caller: machine }));
    await keep(l2.authorize(l2.intentFor("/api/weather", "1000"), { caller: expired }));
    await keep(l2.authorize(l2.intentFor("/api/weather", "1000"), { caller: noRole }));
    await keep(l2.authorize({ ...l2.intentFor("/api/weather", "1000"), userId: BOB }, { caller: person }));
    const notJson = await fetch(`${l2.url}/v1/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.control}`, "x-caller-authorization": `Bearer ${person}`, "content-type": "application/json" },
      body: "{ not JSON",
    });
    bodies.push(await notJson.text());
    await keep(l2.budget("sess_u", { caller: person }));
    // Every read anyone can make afterwards.
    await keep(l2.operator("GET", "/v1/escalations"));
    await keep(l2.operator("GET", "/v1/escalations/events?after=-1"));
    await keep(l2.operator("POST", `/v1/approvals/${String(escalated.body.authorizationId)}`, {}));
    await keep(l2.admin("GET", "/v1/admin/escalations"));
    await keep(l2.admin("GET", `/v1/admin/escalations/${String(escalated.body.authorizationId)}`));
    await keep(l2.portal("GET", `/v1/users/${ALICE}`));
    await keep(l2.call("GET", "/v1/ledger/verify", { token: TOKENS.operator }));
    const haystack = [readFileSync(l2.ledgerFile, "utf8"), ...consoleLines, JSON.stringify(bodies)].join("\n");
    return { haystack, needles: [person, machine, expired, noRole], l2 };
  }

  it("T-CTK-07 after payments, an escalation, a denial and every kind of refusal, no token is in the ledger, a response, an event or a log line", async () => {
    const { haystack, needles, l2 } = await scan();
    for (const needle of needles) {
      expect(haystack.includes(needle), "a whole token").toBe(false);
      // Nor its signature or its payload on their own.
      for (const part of needle.split(".").slice(1)) expect(haystack.includes(part), "a part of a token").toBe(false);
    }
    expect(haystack).not.toMatch(/x-caller-authorization/i);
    // The scan saw something: the ledger names the person by usr_… and has their payments.
    expect(haystack).toContain(ALICE);
    expect(l2.entries("AUTHORIZED").length).toBe(2);
    expect(l2.ledger.verifyChain().ok).toBe(true);
  });

  it("T-CTK-07 must fail when L2 logs the caller: the scan finds the token", async () => {
    const { haystack, needles } = await scan({ caller: { echoCaller: true } });
    expect(needles.some((n) => haystack.includes(n))).toBe(true);
  });
});

describe("T-CTK-08 the token is verified before the serialized section, with no network call inside it (016 FR-019, hard rule 5)", () => {
  it("T-CTK-08 a key fetch that does not return blocks only its own request; another caller's payment is decided meanwhile", async () => {
    const issuer = await createTestIssuer();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let lookups = 0;
    // The first key lookup hangs, as a tenant's key endpoint could; later ones answer at once.
    const slowFirst: TokenKeys["keys"] = async (header, token) => {
      if (++lookups === 1) await gate;
      return (issuer.deps.keys as (h: typeof header, t: typeof token) => Promise<CryptoKey | Uint8Array>)(header, token);
    };
    const l2 = await start({ caller: { ...issuer.deps, keys: slowFirst } });
    const alice = issuer.register("dev|alice");
    await l2.onboard(alice);
    const stuck = l2.authorize(l2.intentFor("/api/weather", "1000", { sessionId: "sess_stuck" }), { caller: await issuer.person("dev|alice") });
    await vi.waitFor(() => expect(lookups).toBe(1));
    // While the first request waits for keys it holds no lock: a machine caller's payment goes through.
    const other = await l2.authorize(l2.intentFor("/api/weather", "1000", { sessionId: "sess_free" }), { caller: await issuer.machine() });
    expect(other.body.status).toBe("AUTHORIZED");
    expect(l2.entries("INTENT").map((e) => e.sessionId)).toEqual(["sess_free"]);
    release();
    expect((await stuck).body.status).toBe("AUTHORIZED");
    expect(l2.entries("INTENT").map((e) => e.sessionId)).toEqual(["sess_free", "sess_stuck"]);
  });

  it("T-CTK-08 the caller check is mounted before the body parser and before the serialized section", () => {
    const service = readFileSync("src/layer2-control/service.ts", "utf8");
    expect(service).toMatch(/app\.post\("\/v1\/authorize", requireRole\("agent-control", [^)]*\)\), callerLimit, caller, jsonBody\(AUTHORIZE_BODY_LIMIT\)/);
    expect(service).toMatch(/app\.get\("\/v1\/budget\/:sessionId", requireRole\("agent-control", [^)]*\)\), callerLimit, caller, \(req, res\)/);
    // The caller module reaches nothing of L2's state: it imports the shared verifier and nothing of its own layer.
    const imports = [...readFileSync("src/layer2-control/caller.ts", "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../shared/config.js", "../shared/identity-token.js", "../shared/user-id.js", "express"]);
  });
});

describe("T-CTK-09 the caller check is bounded per calling address (016, SEC-32)", () => {
  const AUTHORIZE = "/v1/authorize";
  const BUDGET = "/v1/budget/sess_u";

  it("T-CTK-09 beyond the bound both routes answer 429 with Retry-After, and nothing is verified, read or appended", async () => {
    // An issuer of the test's own, so that each key lookup (one per token whose signature is checked) is counted.
    const issuer = await createTestIssuer();
    let lookups = 0;
    const counting: TokenKeys["keys"] = async (header, token) => {
      lookups += 1;
      return (issuer.deps.keys as (h: typeof header, t: typeof token) => Promise<CryptoKey | Uint8Array>)(header, token);
    };
    const l2 = await start({ caller: { ...issuer.deps, keys: counting, maxChecksPerMinute: 4 } });
    const caller = await issuer.machine();
    const body = l2.intentFor("/api/weather", "1000");
    // A request without the control token is refused before it counts: it can't use up the agent's checks.
    for (let i = 0; i < 6; i++) expect((await l2.call("POST", AUTHORIZE, { token: TOKENS.portal, caller, body })).status).toBe(401);
    // The bound is one for both routes together, and a refused caller's request counts like any other.
    expect((await l2.call("POST", AUTHORIZE, { token: TOKENS.control, caller, body })).status).toBe(200);
    expect((await l2.call("GET", BUDGET, { token: TOKENS.control, caller })).status).toBe(200);
    expect((await l2.call("POST", AUTHORIZE, { token: TOKENS.control, caller: "not-a-token", body })).status).toBe(401);
    expect((await l2.call("GET", BUDGET, { token: TOKENS.control })).status).toBe(401);
    const before = l2.ledger.entries().length;
    expect(lookups).toBe(2);
    // The fifth and later: 429 on both, for a good token, a bad one, none, and a body that is not JSON.
    const refused = [
      await fetch(`${l2.url}${AUTHORIZE}`, { method: "POST", headers: { authorization: `Bearer ${TOKENS.control}`, "x-caller-authorization": `Bearer ${caller}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
      await fetch(`${l2.url}${BUDGET}`, { headers: { authorization: `Bearer ${TOKENS.control}`, "x-caller-authorization": `Bearer ${caller}` } }),
      await fetch(`${l2.url}${AUTHORIZE}`, { method: "POST", headers: { authorization: `Bearer ${TOKENS.control}`, "x-caller-authorization": "Bearer not-a-token", "content-type": "application/json" }, body: "{not json" }),
      await fetch(`${l2.url}${BUDGET}`, { headers: { authorization: `Bearer ${TOKENS.control}` } }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "too many requests" });
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    }
    expect(lookups).toBe(2);
    expect(l2.ledger.entries()).toHaveLength(before);
    // The bound is the caller check's own: the portal's and the operator's routes answer as before.
    expect((await l2.call("GET", "/v1/platform")).status).toBe(200);
    expect((await l2.call("GET", "/v1/ledger/verify", { token: TOKENS.operator })).status).toBe(200);
  });

  it("T-CTK-09 must fail without the bound: the same calls are all verified and decided", async () => {
    const l2 = await start({ caller: { maxChecksPerMinute: 4, skipLimit: true } });
    const caller = await l2.callers.machine();
    for (let i = 0; i < 10; i++) {
      expect((await l2.call("GET", BUDGET, { token: TOKENS.control, caller })).status, String(i)).toBe(200);
    }
  });

  it("T-CTK-09 where sign-in is not configured no token is verified, so nothing is bounded: the platform's calls are decided as before 016", async () => {
    const l2 = await start({ caller: false });
    for (let i = 0; i < 10; i++) {
      expect((await l2.call("GET", BUDGET, { token: TOKENS.control })).status, String(i)).toBe(200);
    }
  });
});
