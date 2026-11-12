// 014 portal administration, L2 side (SPEC.md v1.15 L2-5, L2-8; specs/014 contracts/control-api.md "Tests").
// T-ADM-01..10: the six routes under /v1/admin, their own role and token, the two decisions with the checks L2
// keeps (pending only, never one's own payment, a fresh identity confirmation for an approval), the reads that
// write nothing, and the switch. Every must-fail switch is a test-only dep (AdminDeps), never an environment value.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ESCALATION_TTL_MS } from "../src/layer2-control/escalations.js";
import { devUserId } from "../scripts/dev-issuer-lib.js";
import { adminFromEnv, userAccountsFromEnv } from "../src/layer2-control/service.js";
import { ENDPOINT_ROLES } from "../src/shared/auth.js";
import type { EscalationDetail, EscalationEvent, EscalationView, EventPage } from "../src/shared/contracts.js";
import { startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";
import { ALICE, BOB, PAY_TO, SELLER_HOST, startUsersL2, T0, TEST_MNEMONIC, TOKENS, type UsersL2 } from "./helpers/users.js";

/** An administrator: an identifier like any person's. They need no account in L2 to decide. */
const CAROL = devUserId("carol");
const DANA = devUserId("dana");

const NET = { caip2: "eip155:31337", asset: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" } as const;

let open: UsersL2[] = [];
const start = async (o: Parameters<typeof startUsersL2>[0] = {}) => {
  const l2 = await startUsersL2(o);
  open.push(l2);
  return l2;
};
afterEach(async () => {
  await Promise.all(open.map((l) => l.close()));
  open = [];
});

const REPORT = "/api/premium-report";
const NO_SUCH = "auth_00000000-0000-4000-8000-000000000000";

/** A purchase above the auto-approve limit (0.02) and within the cap (0.10): it waits for a person. */
async function escalate(l2: UsersL2, o: { userId?: string; amount?: string; sessionId?: string; path?: string } = {}): Promise<string> {
  const r = await l2.authorize(l2.intentFor(o.path ?? REPORT, o.amount ?? "50000", { ...(o.userId !== undefined && { userId: o.userId }), ...(o.sessionId !== undefined && { sessionId: o.sessionId }) }));
  if (r.body.status !== "ESCALATE") throw new Error(`expected ESCALATE, got ${JSON.stringify(r.body)}`);
  return r.body.authorizationId;
}

describe("T-ADM-10 configuration and the off switch (FR-001, CFG-2, INV-13)", () => {
  const users = { NETWORK: "local", USER_ACCOUNTS: "1", USER_WALLET_MNEMONIC: TEST_MNEMONIC };
  const accounts = (env: Record<string, string>) => userAccountsFromEnv(env, NET);

  it("T-ADM-10 off unless PORTAL_ADMIN=1: the token is ignored and only named", () => {
    expect(adminFromEnv(users, accounts(users))).toEqual({ enabled: false, ignored: [] });
    const off = adminFromEnv({ ...users, PORTAL_ADMIN: "0", PORTAL_ADMIN_TOKEN: "a-secret-value" }, accounts(users));
    expect(off).toEqual({ enabled: false, ignored: ["PORTAL_ADMIN_TOKEN"] });
    expect(JSON.stringify(off)).not.toContain("a-secret-value");
    // Off wins even with user accounts off: nothing is checked.
    expect(adminFromEnv({ NETWORK: "local" }, accounts({ NETWORK: "local" }))).toEqual({ enabled: false, ignored: [] });
  });

  it("T-ADM-10 on needs user accounts on, and says so by naming both settings", () => {
    const env = { NETWORK: "local", PORTAL_ADMIN: "1" };
    expect(() => adminFromEnv(env, accounts(env))).toThrow(/PORTAL_ADMIN=1 needs USER_ACCOUNTS=1/);
  });

  it("T-ADM-10 on: the dev default on local, and a missing token is an error off local", () => {
    const env = { ...users, PORTAL_ADMIN: "1" };
    expect(adminFromEnv(env, accounts(env))).toEqual({ enabled: true, adminToken: "dev-portal-admin-token" });
    const remote = { ...env, NETWORK: "base-sepolia", CONTROL_TOKEN: "c", SETTLEMENT_TOKEN: "s", OPERATOR_TOKEN: "o", PORTAL_TOKEN: "p" };
    expect(() => adminFromEnv(remote, { enabled: true })).toThrow(/missing PORTAL_ADMIN_TOKEN/);
    expect(adminFromEnv({ ...remote, PORTAL_ADMIN_TOKEN: "a" }, { enabled: true })).toEqual({ enabled: true, adminToken: "a" });
  });

  it("T-ADM-10 a token equal to another role's is refused, naming the two settings and no value (INV-13)", () => {
    const env = { ...users, PORTAL_ADMIN: "1" };
    const cases: Array<[Record<string, string>, string]> = [
      [{ PORTAL_ADMIN_TOKEN: "dev-control-token" }, "CONTROL_TOKEN"],
      [{ PORTAL_ADMIN_TOKEN: "same-value", SETTLEMENT_TOKEN: "same-value" }, "SETTLEMENT_TOKEN"],
      [{ PORTAL_ADMIN_TOKEN: "same-value", OPERATOR_TOKEN: "same-value" }, "OPERATOR_TOKEN"],
      [{ PORTAL_ADMIN_TOKEN: "same-value", PORTAL_TOKEN: "same-value" }, "PORTAL_TOKEN"],
    ];
    for (const [over, other] of cases) {
      let message = "";
      try {
        adminFromEnv({ ...env, ...over }, { enabled: true });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe(`PORTAL_ADMIN_TOKEN must differ from ${other} (INV-13)`);
      expect(message).not.toContain("same-value");
    }
  });

  it("T-ADM-10 off: every administration route is 404, even with the right token", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const before = l2.ledger.entries().length;
    for (const [method, path] of [
      ["GET", "/v1/admin/escalations"],
      ["GET", "/v1/admin/escalations/events"],
      ["GET", "/v1/admin/escalations/auth_00000000-0000-4000-8000-000000000000"],
      ["POST", "/v1/admin/escalations/auth_00000000-0000-4000-8000-000000000000/approve"],
      ["POST", "/v1/admin/escalations/auth_00000000-0000-4000-8000-000000000000/reject"],
      ["GET", "/v1/admin/ledger/verify"],
    ] as const) {
      expect((await l2.admin(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(404);
    }
    expect(l2.ledger.entries()).toHaveLength(before);
  });

  it("T-ADM-10 with user accounts off the routes are not mounted either, whatever the admin dep says", async () => {
    const l2 = await start({ off: true, admin: true });
    expect((await l2.admin("GET", "/v1/admin/escalations")).status).toBe(404);
  });

  it("T-ADM-10 on: the guard answers before the route does (401 without the role's token)", async () => {
    const l2 = await start({ admin: true });
    expect(await l2.call("GET", "/v1/admin/escalations", { token: null })).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect((await l2.call("GET", "/v1/admin/escalations", { token: TOKENS.portal })).status).toBe(401);
  });
});

describe("T-ADM-01 the waiting list (US1, FR-007)", () => {
  it("T-ADM-01 lists every pending escalation, oldest first, a user's with their identifier and the platform account's without", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const first = await escalate(l2, { userId: ALICE });
    l2.clock.advance(1_000);
    const second = await escalate(l2, { sessionId: "sess_platform" });
    l2.clock.advance(1_000);
    const r = await l2.admin<{ pending: EscalationView[]; cursor: number; readAt: string }>("GET", "/v1/admin/escalations");
    expect(r.status).toBe(200);
    expect(r.body.pending.map((e) => e.authorizationId)).toEqual([first, second]);
    expect(r.body.pending[0]).toEqual({
      authorizationId: first,
      sessionId: "sess_u",
      resourceKey: `http://${SELLER_HOST}${REPORT}`,
      payTo: PAY_TO,
      amount: "50000",
      createdAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + ESCALATION_TTL_MS).toISOString(),
      referenceCode: first.slice(5, 13),
      userId: ALICE,
    });
    expect(Object.keys(r.body.pending[1]!)).not.toContain("userId");
    expect(r.body.cursor).toBe(l2.ledger.entries().length - 1);
    expect(r.body.readAt).toBe(new Date(T0 + 2_000).toISOString());
  });

  it("T-ADM-01 nothing pending: an empty list, and the cursor of an empty or a non-empty ledger", async () => {
    const l2 = await start({ admin: true });
    const r = await l2.admin<{ pending: unknown[]; cursor: number }>("GET", "/v1/admin/escalations");
    expect(r.body.pending).toEqual([]);
    expect(r.body.cursor).toBe(l2.ledger.entries().length - 1);
  });

  it("T-ADM-01 401 without the token, with a malformed header or with a wrong one, before anything else", async () => {
    const l2 = await start({ admin: true });
    await escalate(l2, {});
    // (A trailing space can't be tested over HTTP: the client trims header values. test/auth.test.ts covers the guard.)
    for (const token of [null, "", `${TOKENS.portalAdmin}x`, "nope"]) {
      expect(await l2.call("GET", "/v1/admin/escalations", { token }), String(token)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
  });
});

describe("T-ADM-02 the sixth role and its token (INV-13, FR-027, FR-028)", () => {
  const concrete = (route: string) => {
    const [method, path] = route.split(" ") as [string, string];
    return [method, path.replace(":authorizationId", NO_SUCH).replace(":userId", ALICE).replace(":policyId", "pol_00000000-0000-4000-8000-000000000000").replace(":cardId", "card_00000000-0000-4000-8000-000000000001").replace(":sessionId", "sess_u")] as const;
  };
  const adminRoutes = Object.entries(ENDPOINT_ROLES).filter(([, role]) => role === "portal-admin").map(([route]) => route);

  it("T-ADM-02 the administration routes are in the endpoint table, each for the one role", () => {
    expect(adminRoutes).toContain("GET /v1/admin/escalations");
    expect(adminRoutes.every((r) => r.split(" ")[1]!.startsWith("/v1/admin/"))).toBe(true);
  });

  it("T-ADM-02 no other role's token opens an administration route, and a refusal appends nothing", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    await escalate(l2, { userId: ALICE });
    const before = l2.ledger.entries().length;
    for (const route of adminRoutes) {
      const [method, path] = concrete(route);
      for (const [name, token] of Object.entries({ control: TOKENS.control, settlement: TOKENS.settlement, operator: TOKENS.operator, portal: TOKENS.portal })) {
        const r = await l2.call(method, path, { token, ...(method === "POST" && { body: {} }) });
        expect(r, `${name} on ${route}`).toEqual({ status: 401, body: { error: "unauthorized" } });
      }
    }
    expect(l2.ledger.entries()).toHaveLength(before);
  });

  it("T-ADM-02 the administration token opens nothing else: no machine capability, no operator route, no user account", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const before = l2.ledger.entries().length;
    const others = Object.entries(ENDPOINT_ROLES)
      .filter(([route, role]) => role !== "portal-admin" && !route.includes("/v1/settlements"))
      .map(([route]) => route)
      // Routes of L2 that the table does not list (010): the operator's rejection and escalation reads.
      .concat(["POST /v1/rejections/:authorizationId", "GET /v1/escalations", "GET /v1/escalations/events"]);
    expect(others).toContain("POST /v1/authorize");
    expect(others).toContain("POST /v1/reconcile");
    for (const route of others) {
      const [method, path] = concrete(route);
      const r = await l2.call(method, path, { token: TOKENS.portalAdmin, ...(method !== "GET" && { body: {} }) });
      expect(r, route).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    expect(l2.ledger.entries()).toHaveLength(before);
  });

  it("T-ADM-02 must-fail: with one portal role for both halves (singlePortalRole), the user-account token reads the list", async () => {
    const l2 = await start({ admin: { singlePortalRole: true } });
    await escalate(l2, {});
    const r = await l2.call<{ pending: unknown[] }>("GET", "/v1/admin/escalations", { token: TOKENS.portal });
    expect(r.status).toBe(200);
    expect(r.body.pending).toHaveLength(1);
  });
});

describe("T-ADM-08 reads write nothing (US1, FR-008, FR-033)", () => {
  it("T-ADM-08 an escalation leaves the list at exactly 300 s by the clock, with no expiry entry written by the read", async () => {
    const l2 = await start({ admin: true });
    const id = await escalate(l2, {});
    const list = async () => (await l2.admin<{ pending: EscalationView[] }>("GET", "/v1/admin/escalations")).body.pending.map((e) => e.authorizationId);
    l2.clock.advance(ESCALATION_TTL_MS - 1);
    expect(await list()).toEqual([id]);
    l2.clock.advance(1);
    expect(await list()).toEqual([]);
    expect(l2.entries("ESCALATION_EXPIRED")).toEqual([]);
  });

  it("T-ADM-08 ten reads leave the ledger exactly as it was", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    await l2.onboard(BOB);
    await escalate(l2, { userId: ALICE });
    await escalate(l2, { userId: BOB });
    l2.clock.advance(ESCALATION_TTL_MS + 5_000); // both are due: a sweep would write two entries
    const before = l2.ledger.entries().length;
    for (let i = 0; i < 10; i++) await l2.admin("GET", "/v1/admin/escalations");
    expect(l2.ledger.entries()).toHaveLength(before);
    expect(l2.ledger.verifyChain().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US2: the two decisions
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;
/** The rules a decision was refused by, or none. */
const rulesOf = (d: unknown): string[] => ((d as { violations?: Array<{ rule: string }> }).violations ?? []).map((v) => v.rule);
const approvePath = (id: string) => `/v1/admin/escalations/${id}/approve`;
const rejectPath = (id: string) => `/v1/admin/escalations/${id}/reject`;
const approve = (l2: UsersL2, id: string, over: Body = {}) => l2.admin<Body>("POST", approvePath(id), { decidedBy: CAROL, identityConfirmedAtMs: l2.clock.now(), ...over });
const reject = (l2: UsersL2, id: string, over: Body = {}) => l2.admin<Body>("POST", rejectPath(id), { decidedBy: CAROL, reasonCode: "amount_too_high", ...over });
const decisions = (l2: UsersL2) => l2.ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL" || e.type === "HUMAN_REJECTION");
const retry = (l2: UsersL2, o: { userId?: string; amount?: string; sessionId?: string } = {}) =>
  l2.authorize(l2.intentFor(REPORT, o.amount ?? "50000", { ...(o.userId !== undefined && { userId: o.userId }), ...(o.sessionId !== undefined && { sessionId: o.sessionId }) }));

describe("T-ADM-01 the decision routes: what is refused before anything is decided (US2)", () => {
  it("T-ADM-01 a malformed ID, decider, confirmation time or reason, and any unknown field, is 400 and appends nothing", async () => {
    const l2 = await start({ admin: true });
    const id = await escalate(l2, {});
    const before = l2.ledger.entries().length;
    const bad: Array<[string, string, Body]> = [
      ["a malformed ID", approvePath("auth_nope"), { decidedBy: CAROL, identityConfirmedAtMs: T0 }],
      ["an ID of another shape", rejectPath("esc_00000000-0000-4000-8000-000000000000"), { decidedBy: CAROL, reasonCode: "other" }],
      ["no decider", approvePath(id), { identityConfirmedAtMs: T0 }],
      ["a decider that is not an identifier", approvePath(id), { decidedBy: "carol", identityConfirmedAtMs: T0 }],
      ["a confirmation time that is not an integer", approvePath(id), { decidedBy: CAROL, identityConfirmedAtMs: "now" }],
      ["a fractional confirmation time", approvePath(id), { decidedBy: CAROL, identityConfirmedAtMs: T0 + 0.5 }],
      ["a validity chosen by the caller", approvePath(id), { decidedBy: CAROL, identityConfirmedAtMs: T0, ttlSeconds: 86_400 }],
      ["the operator's approver label", approvePath(id), { decidedBy: CAROL, identityConfirmedAtMs: T0, approver: "ops" }],
      ["a reason code on an approval", approvePath(id), { decidedBy: CAROL, identityConfirmedAtMs: T0, reasonCode: "other" }],
      ["no reason", rejectPath(id), { decidedBy: CAROL }],
      ["a reason outside the list", rejectPath(id), { decidedBy: CAROL, reasonCode: "because" }],
      ["free text", rejectPath(id), { decidedBy: CAROL, reasonCode: "other", reason: "typed by a person" }],
      ["the operator's label", rejectPath(id), { decidedBy: CAROL, reasonCode: "other", operator: "ops" }],
      ["a confirmation time on a rejection", rejectPath(id), { decidedBy: CAROL, reasonCode: "other", identityConfirmedAtMs: T0 }],
    ];
    for (const [what, path, body] of bad) expect((await l2.admin("POST", path, body)).status, what).toBe(400);
    expect((await l2.admin("POST", approvePath(id), [])).status).toBe(400);
    expect(l2.ledger.entries()).toHaveLength(before);
  });

  it("T-ADM-01 an unknown escalation is 404; a wrong token is 401 before any of it", async () => {
    const l2 = await start({ admin: true });
    expect(await approve(l2, NO_SUCH)).toEqual({ status: 404, body: { error: "not found" } });
    expect(await reject(l2, NO_SUCH)).toEqual({ status: 404, body: { error: "not found" } });
    for (const path of [approvePath("auth_nope"), rejectPath(NO_SUCH)]) {
      expect((await l2.call("POST", path, { token: TOKENS.operator, body: { anything: true } })).status).toBe(401);
    }
  });
});

describe("T-ADM-03 an approval from the portal (US2, FR-011, FR-032, INV-12)", () => {
  it("T-ADM-03 records one HUMAN_APPROVAL: the portal channel, the administrator's identifier, a fixed 600 s", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const id = await escalate(l2, { userId: ALICE });
    l2.clock.advance(5_000);
    const t = l2.clock.now();
    const r = await approve(l2, id, { identityConfirmedAtMs: t - 60_000 });
    expect(r.status).toBe(200);
    const entry = l2.entries("HUMAN_APPROVAL")[0]!;
    expect(r.body).toEqual({ ok: true, state: "approved", approvalId: entry.data.approvalId, expiresAt: new Date(t + 600_000).toISOString(), already: false, channel: "portal", decidedBy: CAROL });
    expect({ sessionId: entry.sessionId, authorizationId: entry.authorizationId, ts: entry.ts, data: entry.data }).toEqual({
      sessionId: "sess_u",
      authorizationId: id,
      ts: new Date(t).toISOString(),
      data: {
        approvalId: entry.data.approvalId,
        escalationId: id,
        resourceKey: `http://${SELLER_HOST}${REPORT}`,
        payTo: PAY_TO,
        amount: "50000",
        expiresAtMs: t + 600_000,
        channel: "portal",
        approver: CAROL,
        identityConfirmedAtMs: t - 60_000,
      },
    });
    expect(String(entry.data.approvalId)).toMatch(/^apr_[0-9a-f-]{36}$/);
    expect(decisions(l2)).toHaveLength(1);
    expect(l2.ledger.verifyChain().ok).toBe(true);
  });

  it("T-ADM-03 the same effect as an operator's: that one payment, once", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const id = await escalate(l2, { userId: ALICE });
    await approve(l2, id);
    // Another amount is not what was approved.
    expect((await retry(l2, { userId: ALICE, amount: "60000" })).body.status).toBe("ESCALATE");
    // Another session is not either.
    expect((await retry(l2, { userId: ALICE, sessionId: "sess_other" })).body.status).toBe("ESCALATE");
    const paid = await retry(l2, { userId: ALICE });
    expect(paid.body.status).toBe("AUTHORIZED");
    expect(l2.entries("AUTHORIZED").at(-1)!.data.approvalRef).toBe(l2.entries("HUMAN_APPROVAL")[0]!.data.approvalId);
    // Used: the same purchase asks again.
    expect((await retry(l2, { userId: ALICE })).body.status).toBe("ESCALATE");
    expect(l2.entries("AUTHORIZED")).toHaveLength(1);
  });

  it("T-ADM-03 an approval never overrides a rule that denies: a paused policy, a disabled account, a used-up budget", async () => {
    // A paused policy: no rule set lists the seller any more.
    const paused = await start({ admin: true });
    const { policyId } = await paused.onboard(ALICE);
    await approve(paused, await escalate(paused, { userId: ALICE }));
    await paused.portal("POST", `/v1/users/${ALICE}/policies/${policyId}/pause`, {});
    const p = await retry(paused, { userId: ALICE });
    expect([p.body.status, rulesOf(p.body)]).toEqual(["DENIED", ["host_not_allowed"]]);

    // A disabled account.
    const disabled = await start({ admin: true });
    await disabled.onboard(ALICE);
    await approve(disabled, await escalate(disabled, { userId: ALICE }));
    await disabled.portal("POST", `/v1/users/${ALICE}/disable`);
    const d = await retry(disabled, { userId: ALICE });
    expect([d.body.status, rulesOf(d.body)]).toEqual(["DENIED", ["user_disabled"]]);

    // A budget used up after the approval: three payments of 0.02 leave 0.04 of the run's 0.10.
    const spent = await start({ admin: true });
    await spent.onboard(ALICE);
    await approve(spent, await escalate(spent, { userId: ALICE }));
    for (const path of ["/api/a", "/api/b", "/api/c"]) {
      expect((await spent.authorize(spent.intentFor(path, "20000", { userId: ALICE }))).body.status, path).toBe("AUTHORIZED");
    }
    const s = await retry(spent, { userId: ALICE });
    expect(s.body.status).toBe("DENIED");
    expect(rulesOf(s.body)).toContain("session_budget_exceeded");
    for (const l2 of [paused, disabled, spent]) expect(l2.entries("AUTHORIZED").filter((e) => e.data.amount === "50000")).toEqual([]);
  });
});

describe("T-ADM-04 a rejection from the portal (US2, FR-012, FR-016, SEC-12)", () => {
  it("T-ADM-04 records one HUMAN_REJECTION: the portal channel, the identifier and a reason code; no label and no text", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const id = await escalate(l2, { userId: ALICE });
    l2.clock.advance(2_000);
    const r = await reject(l2, id);
    const entry = l2.entries("HUMAN_REJECTION")[0]!;
    expect(r).toEqual({
      status: 200,
      body: { ok: true, state: "denied", rejectionId: entry.data.rejectionId, rejectedAt: new Date(l2.clock.now()).toISOString(), already: false, channel: "portal", decidedBy: CAROL },
    });
    expect(entry.data).toEqual({
      rejectionId: entry.data.rejectionId,
      escalationId: id,
      resourceKey: `http://${SELLER_HOST}${REPORT}`,
      payTo: PAY_TO,
      amount: "50000",
      channel: "portal",
      approver: CAROL,
      reasonCode: "amount_too_high",
    });
    expect(String(entry.data.rejectionId)).toMatch(/^rej_[0-9a-f-]{36}$/);
  });

  it("T-ADM-04 the same purchase is then refused, and the agent learns only the rejection's ID (SEC-12)", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    await reject(l2, await escalate(l2, { userId: ALICE }), { reasonCode: "wrong_seller" });
    const rejectionId = String(l2.entries("HUMAN_REJECTION")[0]!.data.rejectionId);
    const r = await retry(l2, { userId: ALICE });
    expect(r.body.status).toBe("DENIED");
    expect(rulesOf(r.body)).toEqual(["human_rejected"]);
    const seen = JSON.stringify(r.body);
    expect(seen).toContain(rejectionId);
    for (const hidden of ["wrong_seller", CAROL, "portal", "reasonCode", "approver"]) expect(seen, hidden).not.toContain(hidden);
  });

  it("T-ADM-04 each of the five reason codes is accepted, and nothing else", async () => {
    const l2 = await start({ admin: true });
    for (const reasonCode of ["not_expected", "amount_too_high", "wrong_seller", "duplicate", "other"]) {
      const id = await escalate(l2, { sessionId: `sess_${reasonCode}` });
      expect((await reject(l2, id, { reasonCode })).status, reasonCode).toBe(200);
    }
    expect(l2.entries("HUMAN_REJECTION").map((e) => e.data.reasonCode)).toEqual(["not_expected", "amount_too_high", "wrong_seller", "duplicate", "other"]);
    const id = await escalate(l2, { sessionId: "sess_bad" });
    for (const reasonCode of ["OTHER", "", "spam", 7, null]) expect((await reject(l2, id, { reasonCode })).status, String(reasonCode)).toBe(400);
  });
});

describe("T-ADM-05 an approval needs a fresh identity confirmation, judged by L2 (US2, FR-014, SEC-21)", () => {
  it("T-ADM-05 the 15 minute window and its 60 s tolerance, to the millisecond", async () => {
    const l2 = await start({ admin: true });
    const t = l2.clock.now();
    const cases: Array<[number, number]> = [
      [t, 200],
      [t - 900_000, 200],
      [t - 900_001, 403],
      [t + 60_000, 200],
      [t + 60_001, 403],
      [t - 86_400_000, 403],
    ];
    for (const [confirmed, status] of cases) {
      const id = await escalate(l2, { sessionId: `sess_${String(confirmed)}` });
      const before = l2.ledger.entries().length;
      const r = await approve(l2, id, { identityConfirmedAtMs: confirmed });
      expect(r.status, String(confirmed - t)).toBe(status);
      if (status === 403) {
        expect(r.body).toEqual({ error: "step_up_required", maxAgeSec: 900 });
        expect(l2.ledger.entries()).toHaveLength(before);
      }
    }
    expect(l2.entries("HUMAN_APPROVAL")).toHaveLength(3);
  });

  it("T-ADM-05 a rejection needs none, however old the sign-in is", async () => {
    const l2 = await start({ admin: true });
    const id = await escalate(l2, {});
    expect((await reject(l2, id)).status).toBe(200);
  });

  it("T-ADM-05 after a stale refusal, a fresh confirmation approves the same escalation", async () => {
    const l2 = await start({ admin: true });
    const id = await escalate(l2, {});
    expect((await approve(l2, id, { identityConfirmedAtMs: l2.clock.now() - 3_600_000 })).status).toBe(403);
    expect((await approve(l2, id)).body).toMatchObject({ state: "approved", already: false });
  });

  it("T-ADM-05 must-fail: with skipDecisionStepUp, a sign-in from a day ago approves", async () => {
    const l2 = await start({ admin: { skipDecisionStepUp: true } });
    const id = await escalate(l2, {});
    const r = await approve(l2, id, { identityConfirmedAtMs: l2.clock.now() - 86_400_000 });
    expect(r.body).toMatchObject({ ok: true, state: "approved", already: false });
    expect(l2.entries("HUMAN_APPROVAL")).toHaveLength(1);
  });
});

describe("T-ADM-06 nobody decides their own payment (US2, FR-015)", () => {
  it("T-ADM-06 the owner can neither approve nor reject; another administrator can", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const id = await escalate(l2, { userId: ALICE });
    const before = l2.ledger.entries().length;
    expect(await approve(l2, id, { decidedBy: ALICE })).toEqual({ status: 403, body: { error: "own_payment" } });
    expect(await reject(l2, id, { decidedBy: ALICE })).toEqual({ status: 403, body: { error: "own_payment" } });
    expect(l2.ledger.entries()).toHaveLength(before);
    expect((await approve(l2, id, { decidedBy: DANA })).body).toMatchObject({ state: "approved", decidedBy: DANA });
  });

  it("T-ADM-06 the check comes before the identity confirmation: an owner is never asked to sign in again", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const id = await escalate(l2, { userId: ALICE });
    expect((await approve(l2, id, { decidedBy: ALICE, identityConfirmedAtMs: 0 })).body).toEqual({ error: "own_payment" });
  });

  it("T-ADM-06 a platform-account escalation has no owner: any administrator decides it, a user among them", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const id = await escalate(l2, {});
    expect((await approve(l2, id, { decidedBy: ALICE })).status).toBe(200);
  });

  it("T-ADM-06 must-fail: with skipOwnPaymentCheck, a person approves their own run's payment", async () => {
    const l2 = await start({ admin: { skipOwnPaymentCheck: true } });
    await l2.onboard(ALICE);
    const id = await escalate(l2, { userId: ALICE });
    expect((await approve(l2, id, { decidedBy: ALICE })).body).toMatchObject({ ok: true, state: "approved", decidedBy: ALICE });
    expect((await retry(l2, { userId: ALICE })).body.status).toBe("AUTHORIZED");
  });
});

describe("T-ADM-07 one final state, whatever the path (US2, FR-017, FR-018, FR-019)", () => {
  const opApprove = (l2: UsersL2, id: string) => l2.operator<Body>("POST", `/v1/approvals/${id}`, { approver: "ops-jane" });
  const opReject = (l2: UsersL2, id: string) => l2.operator<Body>("POST", `/v1/rejections/${id}`, { operator: "ops-jane", reason: "not today" });

  it("T-ADM-07 portal then operator, and operator then portal, for both decisions: the second records nothing", async () => {
    const l2 = await start({ admin: true });
    // Portal approved first.
    const a = await escalate(l2, { sessionId: "s_a" });
    const first = await approve(l2, a);
    expect(await opApprove(l2, a)).toEqual({ status: 200, body: { ok: true, approvalId: first.body.approvalId, expiresAt: first.body.expiresAt, alreadyApproved: true } });
    expect(await opReject(l2, a)).toEqual({ status: 409, body: { error: "escalation is approved", state: "approved", approvalId: first.body.approvalId } });
    // Portal rejected first.
    const b = await escalate(l2, { sessionId: "s_b" });
    const denied = await reject(l2, b);
    expect((await opReject(l2, b)).body).toMatchObject({ rejectionId: denied.body.rejectionId, alreadyRejected: true });
    expect(await opApprove(l2, b)).toEqual({ status: 409, body: { error: "escalation is denied", state: "denied", rejectionId: denied.body.rejectionId } });
    // The operator approved first.
    const c = await escalate(l2, { sessionId: "s_c" });
    const op = await opApprove(l2, c);
    expect(await approve(l2, c)).toEqual({
      status: 200,
      body: { ok: true, state: "approved", approvalId: op.body.approvalId, expiresAt: op.body.expiresAt, already: true, channel: "operator", decidedBy: "ops-jane" },
    });
    expect(await reject(l2, c)).toEqual({ status: 409, body: { error: "not_pending", state: "approved", channel: "operator", decidedBy: "ops-jane", approvalId: op.body.approvalId } });
    // The operator rejected first.
    const d = await escalate(l2, { sessionId: "s_d" });
    const opDenied = await opReject(l2, d);
    expect((await reject(l2, d)).body).toMatchObject({ ok: true, state: "denied", rejectionId: opDenied.body.rejectionId, already: true, channel: "operator", decidedBy: "ops-jane" });
    expect(await approve(l2, d)).toEqual({ status: 409, body: { error: "not_pending", state: "denied", channel: "operator", decidedBy: "ops-jane", rejectionId: opDenied.body.rejectionId } });
    // One decision each, four in all.
    expect(decisions(l2).map((e) => [e.data.escalationId, e.type, e.data.channel])).toEqual([
      [a, "HUMAN_APPROVAL", "portal"],
      [b, "HUMAN_REJECTION", "portal"],
      [c, "HUMAN_APPROVAL", "operator"],
      [d, "HUMAN_REJECTION", "operator"],
    ]);
  });

  it("T-ADM-07 repeating one's own decision returns the first outcome, whoever repeats it", async () => {
    const l2 = await start({ admin: true });
    const id = await escalate(l2, {});
    const first = await approve(l2, id);
    l2.clock.advance(30_000);
    const again = await approve(l2, id, { decidedBy: DANA });
    expect(again.body).toEqual({ ...first.body, already: true });
    // A repeat is answered from the ledger: it needs no fresh confirmation, and the owner check has nothing to guard.
    expect((await approve(l2, id, { identityConfirmedAtMs: 0 })).body).toMatchObject({ already: true });
    expect(decisions(l2)).toHaveLength(1);
  });

  it("T-ADM-07 the 300 s boundary: pending one millisecond before, expired at it, and never revived", async () => {
    const l2 = await start({ admin: true });
    const late = await escalate(l2, { sessionId: "s_late" });
    const justInTime = await escalate(l2, { sessionId: "s_ok" });
    l2.clock.advance(ESCALATION_TTL_MS - 1);
    expect((await approve(l2, justInTime)).status).toBe(200);
    l2.clock.advance(1);
    const expiresAt = new Date(T0 + ESCALATION_TTL_MS).toISOString();
    expect(await approve(l2, late)).toEqual({ status: 409, body: { error: "not_pending", state: "expired", expiresAt } });
    expect(await reject(l2, late)).toEqual({ status: 409, body: { error: "not_pending", state: "expired", expiresAt } });
    // The decision swept first: the expiry is in the ledger, and no decision is.
    expect(l2.entries("ESCALATION_EXPIRED").map((e) => e.data.escalationId)).toEqual([late]);
    expect(decisions(l2)).toHaveLength(1);
  });

  it("T-ADM-07 simultaneous decisions from two paths: exactly one is recorded, every time (SC-003)", async () => {
    const l2 = await start({ admin: true });
    const PAIRS = 100;
    for (let i = 0; i < PAIRS; i++) {
      const id = await escalate(l2, { sessionId: `s_race_${String(i)}` });
      // The four ways two paths can disagree, in turn: which path approves, and which request leaves first.
      const pair = [
        () => [approve(l2, id), opReject(l2, id)],
        () => [opApprove(l2, id), reject(l2, id)],
        () => [opReject(l2, id), approve(l2, id)],
        () => [reject(l2, id), opApprove(l2, id)],
      ][i % 4]!();
      const statuses = (await Promise.all(pair)).map((r) => r.status).sort();
      expect(statuses, String(i)).toEqual([200, 409]);
    }
    expect(decisions(l2)).toHaveLength(PAIRS);
    expect(new Set(decisions(l2).map((e) => e.data.escalationId)).size).toBe(PAIRS);
  }, 60_000);

  it("T-ADM-07 must-fail: with skipPendingCheck, a portal approval is recorded after an operator's rejection", async () => {
    const l2 = await start({ admin: { skipPendingCheck: true } });
    const id = await escalate(l2, {});
    await opReject(l2, id);
    expect((await approve(l2, id)).body).toMatchObject({ ok: true, state: "approved", already: false });
    expect(decisions(l2).map((e) => e.type)).toEqual(["HUMAN_REJECTION", "HUMAN_APPROVAL"]);
  });

  describe("with the approver's phone (012)", () => {
    let bc: BackchannelL2 | undefined;
    afterEach(async () => {
      await bc?.close({ closeStub: true });
      bc = undefined;
    });
    const requested = (entries: readonly { type: string }[]) => entries.some((e) => e.type === "APPROVAL_REQUESTED");
    const bcApprove = (id: string) => bc!.admin("POST", approvePath(id), { decidedBy: CAROL, identityConfirmedAtMs: bc!.clock.now() });
    const bcReject = (id: string) => bc!.admin("POST", rejectPath(id), { decidedBy: CAROL, reasonCode: "not_expected" });

    it("T-ADM-07 a portal approval while the phone is asked ends the wait: the same authorize call is AUTHORIZED, the request abandoned", async () => {
      bc = await startBackchannelL2({ admin: true });
      bc.stub.setAnswers("pending");
      const call = bc.authorize(bc.intentFor(REPORT, "50000"));
      await bc.until(requested);
      const id = bc.ledger.entries().find((e) => e.type === "ESCALATED")!.authorizationId!;
      const listed = await bc.admin("GET", "/v1/admin/escalations");
      expect((listed.body.pending as Array<{ approvalRequest: string }>)[0]!.approvalRequest).toBe("requested");
      expect((await bcApprove(id)).body).toMatchObject({ state: "approved", already: false, channel: "portal" });
      expect((await call).body.status).toBe("AUTHORIZED");
      const { approvalRequestState } = await import("../src/layer2-control/escalations.js");
      expect(approvalRequestState(bc.ledger.entries(), id)).toBe("abandoned");
      expect(bc.ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL").map((e) => e.data.channel)).toEqual(["portal"]);
    });

    it("T-ADM-07 a portal rejection while the phone is asked ends the wait with a denial", async () => {
      bc = await startBackchannelL2({ admin: true });
      bc.stub.setAnswers("pending");
      const call = bc.authorize(bc.intentFor(REPORT, "50000"));
      await bc.until(requested);
      const id = bc.ledger.entries().find((e) => e.type === "ESCALATED")!.authorizationId!;
      expect((await bcReject(id)).body).toMatchObject({ state: "denied", channel: "portal" });
      const decision = (await call).body;
      expect([decision.status, rulesOf(decision)]).toEqual(["DENIED", ["human_rejected"]]);
    });

    it("T-ADM-07 the phone answered first: the portal sees the phone's approval, and can't reject it", async () => {
      bc = await startBackchannelL2({ admin: true });
      bc.stub.setAnswers("pending", { approve: {} });
      const res = await bc.authorize(bc.intentFor(REPORT, "50000"));
      expect(res.body.status).toBe("AUTHORIZED");
      const id = bc.ledger.entries().find((e) => e.type === "ESCALATED")!.authorizationId!;
      const approval = bc.ledger.entries().find((e) => e.type === "HUMAN_APPROVAL")!;
      expect((await bcApprove(id)).body).toMatchObject({ ok: true, already: true, channel: "backchannel", decidedBy: approval.data.approver, approvalId: approval.data.approvalId });
      expect(await bcReject(id)).toMatchObject({ status: 409, body: { error: "not_pending", state: "approved", channel: "backchannel" } });
      expect(bc.ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL" || e.type === "HUMAN_REJECTION")).toHaveLength(1);
    });

    it("T-ADM-07 the phone refused first: the portal sees the phone's rejection, and can't approve it", async () => {
      bc = await startBackchannelL2({ admin: true });
      bc.stub.setAnswers("pending", "deny");
      const res = await bc.authorize(bc.intentFor(REPORT, "50000"));
      expect([res.body.status, rulesOf(res.body)]).toEqual(["DENIED", ["human_rejected"]]);
      const id = bc.ledger.entries().find((e) => e.type === "ESCALATED")!.authorizationId!;
      const rejection = bc.ledger.entries().find((e) => e.type === "HUMAN_REJECTION")!;
      expect(rejection.data.channel).toBe("backchannel");
      expect(await bcApprove(id)).toMatchObject({ status: 409, body: { error: "not_pending", state: "denied", channel: "backchannel", rejectionId: rejection.data.rejectionId } });
      expect((await bcReject(id)).body).toMatchObject({ ok: true, state: "denied", already: true, channel: "backchannel", rejectionId: rejection.data.rejectionId });
      expect(bc.ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL" || e.type === "HUMAN_REJECTION")).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// US3: the trail, in pages
// ---------------------------------------------------------------------------

describe("T-ADM-09 the events, read in pages (US3, FR-020, FR-021)", () => {
  const EVENTS = "/v1/admin/escalations/events";
  /** `n` escalations written straight into the ledger, one event each, a second apart. */
  function seed(l2: UsersL2, n: number): number[] {
    const seqs: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = `auth_${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      const e = l2.ledger.append(
        { type: "ESCALATED", sessionId: `sess_${String(i)}`, intentId: `int_${String(i)}`, authorizationId: id, data: { violations: [], resourceKey: `http://${SELLER_HOST}${REPORT}`, payTo: PAY_TO, amount: "50000", ...(i % 2 === 0 && { userId: ALICE }) } },
        T0 + i * 1_000,
      );
      seqs.push(e.seq);
    }
    return seqs;
  }
  const page = async (l2: UsersL2, query = "") => (await l2.admin<EventPage>("GET", `${EVENTS}${query}`)).body;

  it("T-ADM-09 neither cursor: the latest page, oldest first, with its ends and whether more exist", async () => {
    const l2 = await start({ admin: true });
    const seqs = seed(l2, 130);
    const latest = await page(l2);
    expect(latest.events).toHaveLength(50);
    expect(latest.events.map((e) => e.seq)).toEqual(seqs.slice(-50));
    expect([latest.first, latest.last, latest.more, latest.cursor]).toEqual([seqs[80], seqs[129], true, l2.ledger.entries().length - 1]);
    const small = await page(l2, "?limit=200");
    expect([small.events.length, small.more]).toEqual([130, false]);
  });

  it("T-ADM-09 walking back with before, and forward with after, yields every event once and in order", async () => {
    const l2 = await start({ admin: true });
    const seqs = seed(l2, 130);
    // Back from the latest page to the start.
    const back: number[] = [];
    let p = await page(l2);
    back.unshift(...p.events.map((e) => e.seq));
    while (p.more) {
      p = await page(l2, `?before=${String(p.first)}`);
      back.unshift(...p.events.map((e) => e.seq));
    }
    expect(back).toEqual(seqs);
    // Forward from the start, 40 at a time: continue from `last` while more remain.
    const forward: number[] = [];
    let after = -1;
    for (;;) {
      const f = await page(l2, `?after=${String(after)}&limit=40`);
      forward.push(...f.events.map((e) => e.seq));
      if (!f.more) break;
      after = f.last;
    }
    expect(forward).toEqual(seqs);
    // Caught up: nothing after the cursor, and an empty page says so.
    const empty = await page(l2, `?after=${String(l2.ledger.entries().length - 1)}`);
    expect(empty).toEqual({ events: [], first: -1, last: -1, cursor: l2.ledger.entries().length - 1, more: false });
    // Something happens: exactly that is new.
    const added = l2.ledger.append(
      { type: "ESCALATED", sessionId: "sess_new", intentId: "int_new", authorizationId: "auth_99999999-0000-4000-8000-000000000000", data: { violations: [], resourceKey: `http://${SELLER_HOST}${REPORT}`, payTo: PAY_TO, amount: "50000" } },
      T0 + 999_000,
    ).seq;
    expect((await page(l2, `?after=${String(empty.cursor)}`)).events.map((e) => e.seq)).toEqual([added]);
  });

  it("T-ADM-09 every event names the payment's owner and reference, whatever its kind; a portal decision has its code and no text", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const mine = await escalate(l2, { userId: ALICE, sessionId: "s1" });
    const platform = await escalate(l2, { sessionId: "s2" });
    await approve(l2, mine);
    await reject(l2, platform, { reasonCode: "duplicate" });
    const events = (await page(l2)).events;
    expect(events.map((e) => [e.kind, e.authorizationId, e.userId, e.referenceCode])).toEqual([
      ["escalated", mine, ALICE, mine.slice(5, 13)],
      ["escalated", platform, undefined, platform.slice(5, 13)],
      ["approved", mine, ALICE, mine.slice(5, 13)],
      ["denied", platform, undefined, platform.slice(5, 13)],
    ]);
    expect(events[2]).toMatchObject({ channel: "portal", decidedBy: CAROL });
    expect(events[3]).toMatchObject({ channel: "portal", decidedBy: CAROL, reasonCode: "duplicate" });
    const text = JSON.stringify(events);
    for (const key of ["reason\"", "identityConfirmedAtMs", "purpose", "accepts", "violations"]) expect(text, key).not.toContain(key);
    // The operator's own feed is what it was: no owner on a decision's event.
    const operator = (await l2.operator<{ events: EscalationEvent[] }>("GET", "/v1/escalations/events")).body.events;
    expect(Object.keys(operator[2]!)).not.toContain("userId");
  });

  it("T-ADM-09 a bad limit or cursor, both cursors, or any other query key is 400", async () => {
    const l2 = await start({ admin: true });
    seed(l2, 3);
    for (const q of ["?limit=0", "?limit=201", "?limit=1.5", "?limit=ten", "?after=-2", "?before=-2", "?after=x", "?after=1&before=2", "?userId=" + ALICE, "?sessionId=s", "?after=1&after=2"]) {
      expect((await l2.admin("GET", `${EVENTS}${q}`)).status, q).toBe(400);
    }
    for (const q of ["?limit=1", "?limit=200", "?after=-1", "?before=0", "?before=5&limit=2"]) expect((await l2.admin("GET", `${EVENTS}${q}`)).status, q).toBe(200);
    expect((await l2.call("GET", EVENTS, { token: TOKENS.operator })).status).toBe(401);
  });

  it("T-ADM-09 reading the trail writes nothing, even when expiries are due", async () => {
    const l2 = await start({ admin: true });
    await escalate(l2, {});
    l2.clock.advance(ESCALATION_TTL_MS + 1);
    const before = l2.ledger.entries().length;
    for (const q of ["", "?after=-1", "?before=1000", "?limit=1"]) await page(l2, q);
    expect(l2.ledger.entries()).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// US4: one payment in any state, and the budget behind it
// ---------------------------------------------------------------------------

describe("T-ADM-08 the payment and its budget (US4, FR-022..FR-024, INV-7)", () => {
  const detail = (l2: UsersL2, id: string) => l2.admin<EscalationDetail>("GET", `/v1/admin/escalations/${id}`);
  const DAY = 86_400_000;
  const line = (cap: string, spent: bigint) => ({ capAtomic: cap, spentAtomic: spent.toString(), remainingAtomic: (BigInt(cap) > spent ? BigInt(cap) - spent : 0n).toString() });

  it("T-ADM-08 a pending escalation of a user's run: the view, the state, and three budget lines straight from the ledger", async () => {
    const l2 = await start({ admin: true });
    const { policyId } = await l2.onboard(ALICE);
    // Two payments in the run first, then one in another run of hers.
    for (const path of ["/api/a", "/api/b"]) expect((await l2.authorize(l2.intentFor(path, "15000", { userId: ALICE }))).body.status).toBe("AUTHORIZED");
    expect((await l2.authorize(l2.intentFor("/api/c", "10000", { userId: ALICE, sessionId: "sess_other" }))).body.status).toBe("AUTHORIZED");
    const id = await escalate(l2, { userId: ALICE });
    l2.clock.advance(1_000);
    const t = l2.clock.now();
    const r = await detail(l2, id);
    expect(r.status).toBe(200);
    const { budget, ...view } = r.body;
    expect(view).toEqual({
      authorizationId: id,
      sessionId: "sess_u",
      resourceKey: `http://${SELLER_HOST}${REPORT}`,
      payTo: PAY_TO,
      amount: "50000",
      createdAt: new Date(t - 1_000).toISOString(),
      expiresAt: new Date(t - 1_000 + ESCALATION_TTL_MS).toISOString(),
      referenceCode: id.slice(5, 13),
      userId: ALICE,
      state: "pending",
    });
    // The same figures the decision uses: this user's and this policy's entries for the run and the day, and the
    // user's entries for the ceiling (INV-7).
    const mine = { userId: ALICE, policyId };
    const run = l2.ledger.committedAtomic({ sessionId: "sess_u", ...mine }, t);
    const day = l2.ledger.committedAtomic({ sinceMs: t - DAY, ...mine }, t);
    const userDay = l2.ledger.committedAtomic({ userId: ALICE, sinceMs: t - DAY }, t);
    expect([run, day, userDay]).toEqual([30000n, 40000n, 40000n]);
    expect(budget).toEqual({
      asset: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      decimals: 6,
      applies: true,
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      run: line("100000", run),
      day: line("500000", day),
      userDay: line("500000", userDay),
      fits: true,
    });
    // The user's own wallet view shows the same 24-hour figure.
    const wallet = (await l2.portal<{ wallet: { spent24hAtomic: string } }>("GET", `/v1/users/${ALICE}`)).body.wallet;
    expect(wallet.spent24hAtomic).toBe(budget.userDay!.spentAtomic);
  });

  it("T-ADM-08 fits: true when the amount is exactly what is left, false one atomic unit over", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    // 0.02 + 0.02 + 0.01 = 0.05 spent of the run's 0.10: exactly 0.05 is left.
    for (const [path, amount] of [["/api/a", "20000"], ["/api/b", "20000"], ["/api/c", "10000"]] as const) await l2.authorize(l2.intentFor(path, amount, { userId: ALICE }));
    const exact = await escalate(l2, { userId: ALICE, amount: "50000" });
    expect((await detail(l2, exact)).body.budget).toMatchObject({ run: { remainingAtomic: "50000" }, fits: true });
    await l2.authorize(l2.intentFor("/api/d", "1", { userId: ALICE }));
    const after = (await detail(l2, exact)).body.budget;
    expect(after).toMatchObject({ run: { spentAtomic: "50001", remainingAtomic: "49999" }, fits: false, applies: true });
  });

  it("T-ADM-08 the platform account's payment: the mandate's two lines, and no user line", async () => {
    const l2 = await start({ admin: true });
    expect((await l2.authorize(l2.intentFor("/api/a", "20000", { sessionId: "sess_p" }))).body.status).toBe("AUTHORIZED");
    const id = await escalate(l2, { sessionId: "sess_p" });
    const { budget, userId } = (await detail(l2, id)).body;
    expect(userId).toBeUndefined();
    expect(budget).toEqual({
      asset: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      decimals: 6,
      applies: true,
      autoApproveMaxAtomic: l2.mandate.autoApproveMaxAtomic,
      hardCapPerPaymentAtomic: l2.mandate.hardCapPerPaymentAtomic,
      run: line(l2.mandate.sessionBudgetAtomic, 20000n),
      day: line(l2.mandate.dailyBudgetAtomic, 20000n),
      fits: true,
    });
    // The agent's own budget read gives the same figures for the run.
    const agent = (await l2.call<{ spentOrReservedAtomic: string; remainingAtomic: string }>("GET", "/v1/budget/sess_p", { token: TOKENS.control })).body;
    expect([agent.spentOrReservedAtomic, agent.remainingAtomic]).toEqual([budget.run.spentAtomic, budget.run.remainingAtomic]);
  });

  it("T-ADM-08 the rules as they are now: a paused policy, an unlisted seller, a disabled account", async () => {
    const paused = await start({ admin: true });
    const { policyId } = await paused.onboard(ALICE);
    const a = await escalate(paused, { userId: ALICE });
    await paused.portal("POST", `/v1/users/${ALICE}/policies/${policyId}/pause`, {});
    expect((await detail(paused, a)).body.budget).toMatchObject({ applies: false, notApplying: "no_active_policy", fits: false, run: line("0", 0n), day: line("0", 0n), autoApproveMaxAtomic: "0", hardCapPerPaymentAtomic: "0" });

    const disabled = await start({ admin: true });
    await disabled.onboard(ALICE);
    const b = await escalate(disabled, { userId: ALICE });
    await disabled.portal("POST", `/v1/users/${ALICE}/disable`);
    const d = (await detail(disabled, b)).body.budget;
    expect(d).toMatchObject({ applies: false, notApplying: "user_disabled", fits: false });
    expect(d.userDay).toEqual(line("0", 0n));

    // A lowered budget: the policy now in force is the one the retry will be judged against (INV-12).
    const lowered = await start({ admin: true });
    const made = await lowered.onboard(ALICE);
    const c = await escalate(lowered, { userId: ALICE });
    const changed = await lowered.portal("PUT", `/v1/users/${ALICE}/policies/${made.policyId}`, {
      ...(await import("./helpers/users.js")).policyValues({ hardCapPerPaymentAtomic: "40000", sessionBudgetAtomic: "40000", autoApproveMaxAtomic: "20000" }, lowered.clock.now()),
      expectedVersion: 1,
    });
    expect(changed.status).toBe(200);
    expect((await detail(lowered, c)).body.budget).toMatchObject({ applies: true, hardCapPerPaymentAtomic: "40000", run: line("40000", 0n), fits: false });
  });

  it("T-ADM-08 any state: approved on each path, rejected, expired, each with how it ended", async () => {
    const l2 = await start({ admin: true });
    const byPortal = await escalate(l2, { sessionId: "s1" });
    const byOperator = await escalate(l2, { sessionId: "s2" });
    const rejected = await escalate(l2, { sessionId: "s3" });
    const opRejected = await escalate(l2, { sessionId: "s4" });
    const left = await escalate(l2, { sessionId: "s5" });
    l2.clock.advance(2_000);
    const t = l2.clock.now();
    const a = await approve(l2, byPortal);
    const o = await l2.operator<Body>("POST", `/v1/approvals/${byOperator}`, { approver: "ops-jane", ttlSeconds: 60 });
    const r = await reject(l2, rejected, { reasonCode: "duplicate" });
    const or = await l2.operator<Body>("POST", `/v1/rejections/${opRejected}`, { operator: "ops-jane", reason: "<b>not today</b>" });
    const at = new Date(t).toISOString();
    expect((await detail(l2, byPortal)).body).toMatchObject({ state: "approved", decision: { at, channel: "portal", decidedBy: CAROL, approvalId: a.body.approvalId, approvalExpiresAt: new Date(t + 600_000).toISOString() } });
    expect((await detail(l2, byOperator)).body.decision).toEqual({ at, channel: "operator", decidedBy: "ops-jane", approvalId: o.body.approvalId, approvalExpiresAt: new Date(t + 60_000).toISOString() });
    expect((await detail(l2, rejected)).body).toMatchObject({ state: "denied", decision: { at, channel: "portal", decidedBy: CAROL, rejectionId: r.body.rejectionId, reasonCode: "duplicate" } });
    expect((await detail(l2, opRejected)).body.decision).toEqual({ at, channel: "operator", decidedBy: "ops-jane", rejectionId: or.body.rejectionId, reason: "<b>not today</b>" });
    l2.clock.advance(ESCALATION_TTL_MS);
    const expired = (await detail(l2, left)).body;
    expect(expired.state).toBe("expired");
    expect(Object.keys(expired)).not.toContain("decision");
    // No view carries what a decision recorded for L2 alone.
    const text = JSON.stringify([await detail(l2, byPortal), await detail(l2, rejected)]);
    for (const key of ["identityConfirmedAtMs", "violations", "purpose", "accepts"]) expect(text, key).not.toContain(key);
  });

  it("T-ADM-08 an unknown ID is 404, a malformed one 400, another token 401; and the read appends nothing", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    const id = await escalate(l2, { userId: ALICE });
    l2.clock.advance(ESCALATION_TTL_MS + 1);
    const before = l2.ledger.entries().length;
    expect((await detail(l2, id)).body.state).toBe("expired");
    expect(await detail(l2, NO_SUCH)).toEqual({ status: 404, body: { error: "not found" } });
    expect((await detail(l2, "auth_nope")).status).toBe(400);
    expect((await l2.call("GET", `/v1/admin/escalations/${id}`, { token: TOKENS.operator })).status).toBe(401);
    expect(l2.ledger.entries()).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// US5: the ledger check
// ---------------------------------------------------------------------------

describe("T-ADM-01 the ledger check (US5, FR-025, FR-026, INV-9)", () => {
  const VERIFY = "/v1/admin/ledger/verify";

  it("T-ADM-01 an intact ledger: the entry count and ok; the same answer the operator gets", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    await escalate(l2, { userId: ALICE });
    const before = l2.ledger.entries().length;
    const r = await l2.admin("GET", VERIFY);
    expect(r).toEqual({ status: 200, body: { entries: before, ok: true } });
    expect((await l2.operator("GET", "/v1/ledger/verify")).body).toEqual(r.body);
    expect(l2.ledger.entries()).toHaveLength(before);
  });

  it("T-ADM-01 an altered entry: where the chain breaks, and nothing is repaired or written", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE);
    await escalate(l2, { userId: ALICE });
    const lines = readFileSync(l2.ledgerFile, "utf8").split("\n").filter((l) => l !== "");
    const at = 2;
    const altered = JSON.parse(lines[at]!) as { data: Record<string, unknown> };
    altered.data.tampered = true;
    lines[at] = JSON.stringify(altered);
    writeFileSync(l2.ledgerFile, lines.map((l) => l + "\n").join(""));
    const text = readFileSync(l2.ledgerFile, "utf8");
    const r = await l2.admin<{ entries: number; ok: boolean; brokenAt?: number }>("GET", VERIFY);
    expect(r.body).toEqual({ entries: lines.length, ok: false, brokenAt: at });
    expect(readFileSync(l2.ledgerFile, "utf8")).toBe(text);
  });

  it("T-ADM-01 only the administration token: 401 for the operator's and for none", async () => {
    const l2 = await start({ admin: true });
    expect((await l2.call("GET", VERIFY, { token: TOKENS.operator })).status).toBe(401);
    expect((await l2.call("GET", VERIFY, { token: null })).status).toBe(401);
  });
});
