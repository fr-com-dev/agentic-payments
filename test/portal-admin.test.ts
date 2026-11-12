// 014 portal administration, portal side (SPEC.md v1.11 L2-8; specs/014 contracts/portal-api.md "Tests").
// T-PRT-10..14: who may use the administration area (the Portal.Admin role, checked before L2 is called), what the
// portal takes from the verified token only (the decider and the time of their identity confirmation), how each L2
// answer is mapped, the log, and the switch. In-process portal against an in-process L2 and the local dev issuer.
import { afterEach, describe, expect, it } from "vitest";
import { loadPortalConfig } from "../src/portal/config.js";
import { TOKENS } from "./helpers/users.js";
import { startPortal, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";

let open: PortalTestApp[] = [];
const start = async (o: StartPortalOptions = {}) => {
  const p = await startPortal(o);
  open.push(p);
  return p;
};
afterEach(async () => {
  // T-PRT-13 (NFR-003), for every test of this file: no response and no log line holds either of the portal's
  // credentials for L2, or any sign-in token the test issued.
  for (const p of open) {
    const everything = `${p.rawLogs.join("\n")}\n${p.responses.join("\n")}`;
    for (const secret of [TOKENS.portal, TOKENS.portalAdmin, ...p.issued]) expect(everything.includes(secret), "a credential in a response or a log line").toBe(false);
  }
  await Promise.all(open.map((p) => p.close()));
  open = [];
});

const ADMIN_READS = ["/api/admin/escalations", "/api/admin/escalations/events", "/api/admin/escalations/auth_00000000-0000-4000-8000-000000000000", "/api/admin/ledger/verify"];
const ADMIN_WRITES: Array<[string, unknown]> = [
  ["/api/admin/escalations/auth_00000000-0000-4000-8000-000000000000/approve", {}],
  ["/api/admin/escalations/auth_00000000-0000-4000-8000-000000000000/reject", { reasonCode: "other" }],
];

const FORBIDDEN = { error: "forbidden" };
/** Every route of 013 that is about the signed-in user's own data: an administrator alone reaches none of them. */
const USER_ROUTES: Array<[string, string, unknown?]> = [
  ["PUT", "/api/profile", { displayName: "Carol", contactEmail: "carol@example.com", acknowledgedTestFunds: true }],
  ["GET", "/api/platform"],
  ["GET", "/api/wallet"],
  ["PUT", "/api/wallet/account"],
  ["POST", "/api/cards/setup"],
  ["GET", "/api/policies"],
  ["POST", "/api/account/disable", { confirm: true }],
  ["POST", "/api/account/enable"],
];

describe("T-PRT-10 access by role (FR-002, FR-003, FR-004, FR-006)", () => {
  it("T-PRT-10 a user without Portal.Admin is refused on the administration routes, and L2 is not called", async () => {
    const p = await start({ admin: true });
    const before = p.l2Calls();
    const r = await p.as("alice")("GET", "/api/admin/escalations");
    expect(r).toMatchObject({ status: 403, body: FORBIDDEN });
    expect(r.text).toBe(JSON.stringify(FORBIDDEN));
    expect(p.l2Calls()).toBe(before);
    expect((await p.as("alice")("POST", "/api/admin/escalations/auth_00000000-0000-4000-8000-000000000000/approve", {})).status).toBe(403);
    expect(p.l2Calls()).toBe(before);
  });

  it("T-PRT-10 a person with Portal.Admin only: who they are, and none of a user's own routes (FR-003, FR-006)", async () => {
    const p = await start({ admin: true });
    const carol = p.adminAs("carol", { user: false });
    const before = p.l2Calls();
    const me = await carol("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ userId: p.userId("carol"), user: false, admin: true });
    for (const [method, path, body] of USER_ROUTES) {
      expect(await carol(method, path, body), `${method} ${path}`).toMatchObject({ status: 403, body: FORBIDDEN });
    }
    // Nothing was asked of L2, and no profile exists for them.
    expect(p.l2Calls()).toBe(before);
    expect(p.profiles.get(p.userId("carol"))).toBeUndefined();
  });

  it("T-PRT-10 a person with both roles has both halves; a person with neither has none", async () => {
    const p = await start({ admin: true });
    const dana = p.adminAs("dana");
    const me = await dana("GET", "/api/me");
    expect(me.body).toMatchObject({ userId: p.userId("dana"), user: true, admin: true, enabled: true, onboarding: { profile: false, wallet: false, policy: false } });
    expect((await dana("GET", "/api/platform")).status).toBe(200);
    // The administration half is open to them: the route itself answers (or 404 until it exists), never 403.
    expect((await dana("GET", "/api/admin/escalations")).status).not.toBe(403);

    const none = await p.token("erin", { roles: [] });
    expect(await p.call("GET", "/api/me", { token: none })).toMatchObject({ status: 403, body: FORBIDDEN });
    expect(await p.call("GET", "/api/admin/escalations", { token: none })).toMatchObject({ status: 403, body: FORBIDDEN });
  });

  it("T-PRT-10 a user's /api/me says admin: false, and is otherwise what it was", async () => {
    const p = await start({ admin: true });
    const me = await p.as("alice")("GET", "/api/me");
    expect(me.body).toEqual({ userId: p.userId("alice"), enabled: true, onboarding: { profile: false, wallet: false, policy: false }, user: true, admin: false });
  });

  it("T-PRT-10 the permission taken away: the person's next token is refused on every administration route; a token issued before holds until it expires", async () => {
    const p = await start({ admin: true });
    // The role is read from the token and nowhere else: the portal asks no directory per request (research R3).
    const issuedBefore = await p.adminToken("carol", { user: false });
    const issuedAfter = await p.token("carol", { roles: ["Agent.Run"] });
    const before = p.l2Calls();
    for (const path of ADMIN_READS) expect(await p.call("GET", path, { token: issuedAfter }), path).toMatchObject({ status: 403, body: FORBIDDEN });
    for (const [path, body] of ADMIN_WRITES) expect(await p.call("POST", path, { token: issuedAfter, body }), path).toMatchObject({ status: 403, body: FORBIDDEN });
    expect(p.l2Calls()).toBe(before);
    expect((await p.call<{ admin: boolean }>("GET", "/api/me", { token: issuedAfter })).body.admin).toBe(false);
    // With no role left at all, the next token opens nothing.
    expect(await p.call("GET", "/api/me", { token: await p.token("carol", { roles: [] }) })).toMatchObject({ status: 403, body: FORBIDDEN });
    // The bound: the earlier token still carries the role, so it works until its own expiry and not a request longer.
    expect((await p.call("GET", "/api/admin/escalations", { token: issuedBefore })).status).toBe(200);
    const expired = await p.adminToken("carol", { user: false, exp: Math.floor(Date.now() / 1000) - 120 });
    for (const path of ADMIN_READS) expect(await p.call("GET", path, { token: expired }), path).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    for (const [path, body] of ADMIN_WRITES) expect(await p.call("POST", path, { token: expired, body }), path).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  });

  it("T-PRT-10 a token issued for the agent service is refused, whatever its roles; no token is 401", async () => {
    const p = await start({ admin: true });
    const agent = await p.agentToken("carol", { roles: ["Agent.Run", "Portal.Admin"] });
    expect(await p.call("GET", "/api/admin/escalations", { token: agent })).toMatchObject({ status: 403, body: FORBIDDEN });
    expect(await p.call("GET", "/api/me", { token: agent })).toMatchObject({ status: 403, body: FORBIDDEN });
    expect(await p.call("GET", "/api/admin/escalations")).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    const service = await p.token("svc", { idtyp: "app", roles: ["Portal.Admin"] });
    expect((await p.call("GET", "/api/admin/escalations", { token: service })).status).toBe(403);
  });

  it("T-PRT-10 administration off: the routes are not there, and Portal.Admin counts for nothing", async () => {
    const p = await start();
    expect(await p.as("alice")("GET", "/api/admin/escalations")).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(await p.adminAs("dana")("GET", "/api/admin/escalations")).toMatchObject({ status: 404, body: { error: "not found" } });
    // A person with only Portal.Admin is refused everywhere, exactly as before this feature.
    const carol = p.adminAs("carol", { user: false });
    expect(await carol("GET", "/api/me")).toMatchObject({ status: 403, body: FORBIDDEN });
    expect(await carol("GET", "/api/admin/escalations")).toMatchObject({ status: 403, body: FORBIDDEN });
    // A person with both roles is a user and nothing more.
    expect((await p.adminAs("dana")("GET", "/api/me")).body).toMatchObject({ user: true, admin: false });
    expect(await p.call("GET", "/api/admin/escalations")).toMatchObject({ status: 401 });
  });

  it("T-PRT-10 must-fail: with the test-only skipAdminCheck hook, an ordinary user gets past the check", async () => {
    const p = await start({ admin: true, skipAdminCheck: true });
    expect((await p.as("alice")("GET", "/api/admin/escalations")).status).not.toBe(403);
  });
});

describe("T-PRT-14 configuration and the flags (FR-001, CFG-2)", () => {
  const base = {
    NETWORK: "local",
    CONTROL_URL: "http://127.0.0.1:4020",
    AUTH_TENANT_ID: "dev",
    AUTH_AUDIENCE: "api://x402-l1-agent",
    PORTAL_CLIENT_ID: "x402-portal-dev",
    AUTH_JWKS_FILE: ".local/dev-issuer/jwks.json",
  };

  it("T-PRT-14 off unless PORTAL_ADMIN=1; on, the token is the administration role's own", () => {
    expect(loadPortalConfig(base).admin).toBeUndefined();
    expect(loadPortalConfig({ ...base, PORTAL_ADMIN: "0", PORTAL_ADMIN_TOKEN: "ignored" }).admin).toBeUndefined();
    expect(loadPortalConfig({ ...base, PORTAL_ADMIN: "1" }).admin).toEqual({ token: "dev-portal-admin-token" });
    expect(loadPortalConfig({ ...base, PORTAL_ADMIN: "1", PORTAL_ADMIN_TOKEN: "a-value" }).admin).toEqual({ token: "a-value" });
  });

  it("T-PRT-14 on without the token off local: refused, naming the variable only", () => {
    const remote = {
      NETWORK: "base-sepolia",
      CONTROL_URL: "http://l2.internal",
      PORTAL_TOKEN: "a-portal-token-value",
      AUTH_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      AUTH_AUDIENCE: "22222222-2222-4222-8222-222222222222",
      PORTAL_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
      PORTAL_ADMIN: "1",
    };
    let message = "";
    try {
      loadPortalConfig(remote);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("PORTAL_ADMIN_TOKEN is required with PORTAL_ADMIN=1 (env/portal.env)");
    expect(message).not.toContain("a-portal-token-value");
    expect(() => loadPortalConfig({ ...remote, PORTAL_ADMIN_TOKEN: "" })).toThrow(/PORTAL_ADMIN_TOKEN is required/);
    expect(loadPortalConfig({ ...remote, PORTAL_ADMIN_TOKEN: "x" }).admin).toEqual({ token: "x" });
  });

  it("T-PRT-14 /api/config says whether the administration area is on, and nothing about who may use it", async () => {
    const on = await start({ admin: true });
    const off = await start();
    expect((await on.call<{ admin: unknown }>("GET", "/api/config")).body.admin).toEqual({ available: true });
    expect((await off.call<{ admin: unknown }>("GET", "/api/config")).body.admin).toEqual({ available: false });
    expect((await on.call("GET", "/api/config")).text).not.toContain(TOKENS.portalAdmin);
  });

  it("T-PRT-14 with the area off, a user's answers are what they were, plus the two flags on /api/me", async () => {
    const p = await start();
    const alice = p.as("alice");
    expect((await alice("GET", "/api/me")).body).toEqual({ userId: p.userId("alice"), enabled: true, onboarding: { profile: false, wallet: false, policy: false }, user: true, admin: false });
    expect((await alice("GET", "/api/platform")).status).toBe(200);
    expect((await alice("GET", "/api/policies")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// US1: the waiting list
// ---------------------------------------------------------------------------

const REPORT = "/api/premium-report";

/** A purchase above the auto-approve limit and within the cap, for a user (onboarded here if needed) or the platform account. */
async function escalate(p: PortalTestApp, o: { subject?: string; amount?: string; sessionId?: string } = {}): Promise<string> {
  const userId = o.subject === undefined ? undefined : p.userId(o.subject);
  if (userId !== undefined && p.l2.entries("USER_REGISTERED").every((e) => e.data.userId !== userId)) await p.l2.onboard(userId);
  const r = await p.l2.authorize(p.l2.intentFor(REPORT, o.amount ?? "50000", { ...(userId !== undefined && { userId }), sessionId: o.sessionId ?? `sess_${o.subject ?? "platform"}` }));
  if (r.body.status !== "ESCALATE") throw new Error(`expected ESCALATE, got ${JSON.stringify(r.body)}`);
  return r.body.authorizationId;
}

interface Listed {
  pending: Array<Record<string, unknown>>;
  readAt: string;
}

describe("T-PRT-11 the waiting list through the portal (US1, FR-007..FR-010)", () => {
  it("T-PRT-11 each item as the browser gets it: the owner, mine, the atomic amount, and no session", async () => {
    const p = await start({ admin: true });
    const own = await escalate(p, { subject: "dana" });
    p.l2.clock.advance(1_000);
    const alices = await escalate(p, { subject: "alice" });
    p.l2.clock.advance(1_000);
    const platform = await escalate(p);
    const r = await p.adminAs("dana")<Listed>("GET", "/api/admin/escalations");
    expect(r.status).toBe(200);
    expect(r.body.readAt).toBe(new Date(p.l2.clock.now()).toISOString());
    expect(r.body.pending.map((e) => [e.authorizationId, e.mine, e.owner])).toEqual([
      [own, true, { userId: p.userId("dana"), platformAccount: false }],
      [alices, false, { userId: p.userId("alice"), platformAccount: false }],
      [platform, false, { platformAccount: true }],
    ]);
    expect(r.body.pending[1]).toEqual({
      authorizationId: alices,
      referenceCode: alices.slice(5, 13),
      owner: { userId: p.userId("alice"), platformAccount: false },
      mine: false,
      resourceKey: `http://127.0.0.1:4021${REPORT}`,
      payTo: "0xcccccccccccccccccccccccccccccccccccccccc",
      amountAtomic: "50000",
      createdAt: new Date(p.l2.clock.now() - 1_000).toISOString(),
      expiresAt: new Date(p.l2.clock.now() - 1_000 + 300_000).toISOString(),
    });
    for (const item of r.body.pending) {
      expect(Object.keys(item)).not.toContain("sessionId");
      expect(Object.keys(item)).not.toContain("amount");
      expect(Object.keys(item)).not.toContain("userId");
    }
  });

  it("T-PRT-11 an administrator who is not a user sees every payment and owns none", async () => {
    const p = await start({ admin: true });
    await escalate(p, { subject: "alice" });
    const r = await p.adminAs("carol", { user: false })<Listed>("GET", "/api/admin/escalations");
    expect(r.body.pending.map((e) => e.mine)).toEqual([false]);
  });

  it("T-PRT-11 nothing pending: an empty list with the time it was read", async () => {
    const p = await start({ admin: true });
    const r = await p.adminAs("carol", { user: false })<Listed>("GET", "/api/admin/escalations");
    expect(r.body).toEqual({ pending: [], readAt: new Date(p.l2.clock.now()).toISOString() });
  });

  it("T-PRT-11 L2 unreachable: 502, and nothing else", async () => {
    const p = await start({ admin: true, controlDown: true });
    const r = await p.adminAs("carol", { user: false })("GET", "/api/admin/escalations");
    expect(r).toMatchObject({ status: 502, body: { error: "control_unavailable" } });
    expect(r.text).toBe(JSON.stringify({ error: "control_unavailable" }));
  });

  it("T-PRT-10 must-fail (completed): with skipAdminCheck an ordinary user reads the waiting list", async () => {
    const p = await start({ admin: true, skipAdminCheck: true });
    await escalate(p);
    const r = await p.as("alice")<Listed>("GET", "/api/admin/escalations");
    expect(r.status).toBe(200);
    expect(r.body.pending).toHaveLength(1);
  });
});

describe("T-PRT-13 the log and the headers of the administration routes (FR-034, NFR-003)", () => {
  it("T-PRT-13 the list: the route template, the status, the administrator's identifier and no secret", async () => {
    const p = await start({ admin: true });
    await escalate(p, { subject: "alice" });
    const token = await p.adminToken("carol", { user: false });
    const r = await p.call("GET", "/api/admin/escalations", { token });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const line = p.logs.at(-1)!;
    expect(line).toMatchObject({ route: "/api/admin/escalations", status: 200, userId: p.userId("carol") });
    expect(Object.keys(line).sort()).toEqual(["ms", "route", "status", "time", "userId"]);
    const everything = p.rawLogs.join("\n") + r.text;
    for (const secret of [TOKENS.portal, TOKENS.portalAdmin, token]) expect(everything).not.toContain(secret);
    // A refusal is logged with who was refused, and still no route detail beyond the template.
    await p.as("alice")("GET", "/api/admin/escalations");
    expect(p.logs.at(-1)).toMatchObject({ status: 403, userId: p.userId("alice") });
  });
});

// ---------------------------------------------------------------------------
// US2: the two decisions
// ---------------------------------------------------------------------------

const approvePath = (id: string) => `/api/admin/escalations/${id}/approve`;
const rejectPath = (id: string) => `/api/admin/escalations/${id}/reject`;
const UNKNOWN = "auth_00000000-0000-4000-8000-000000000000";
const decisionEntries = (p: PortalTestApp) => p.l2.ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL" || e.type === "HUMAN_REJECTION");

describe("T-PRT-12 deciding through the portal (US2, FR-011..FR-017, FR-030)", () => {
  it("T-PRT-12 an approval: the decider and the time of their identity confirmation come from the token, and from nowhere else", async () => {
    const p = await start({ admin: true });
    const id = await escalate(p, { subject: "alice" });
    const authTime = Math.floor(p.l2.clock.now() / 1000) - 120;
    const r = await p.adminAs("carol", { user: false, authTime })("POST", approvePath(id), {});
    expect(r.status).toBe(200);
    const entry = p.l2.entries("HUMAN_APPROVAL")[0]!;
    expect(entry.data).toMatchObject({ channel: "portal", approver: p.userId("carol"), identityConfirmedAtMs: authTime * 1000, escalationId: id });
    expect(r.body).toEqual({
      ok: true,
      state: "approved",
      approvalId: entry.data.approvalId,
      expiresAt: new Date(p.l2.clock.now() + 600_000).toISOString(),
      already: false,
      channel: "portal",
      decidedBy: p.userId("carol"),
    });
    // The agent's retry now pays, once.
    const retry = await p.l2.authorize(p.l2.intentFor(REPORT, "50000", { userId: p.userId("alice"), sessionId: "sess_alice" }));
    expect(retry.body.status).toBe("AUTHORIZED");
  });

  it("T-PRT-12 an approval with no body at all works too", async () => {
    const p = await start({ admin: true });
    const id = await escalate(p);
    const r = await p.call("POST", approvePath(id), { token: await p.adminToken("carol", { user: false }) });
    expect(r.body).toMatchObject({ state: "approved", already: false });
  });

  it("T-PRT-12 a rejection: one of the five reasons, and the decider from the token", async () => {
    const p = await start({ admin: true });
    const id = await escalate(p, { subject: "alice" });
    const r = await p.adminAs("carol", { user: false })("POST", rejectPath(id), { reasonCode: "duplicate" });
    const entry = p.l2.entries("HUMAN_REJECTION")[0]!;
    expect(entry.data).toMatchObject({ channel: "portal", approver: p.userId("carol"), reasonCode: "duplicate" });
    expect(Object.keys(entry.data)).not.toContain("reason");
    expect(r.body).toEqual({ ok: true, state: "denied", rejectionId: entry.data.rejectionId, rejectedAt: entry.ts, already: false, channel: "portal", decidedBy: p.userId("carol") });
  });

  it("T-PRT-12 anything in the body that could name the decider, the time or free text is refused before L2 is called", async () => {
    const p = await start({ admin: true });
    const id = await escalate(p);
    const carol = p.adminAs("carol", { user: false });
    const before = p.l2Calls();
    const bob = p.userId("bob");
    for (const body of [{ decidedBy: bob }, { identityConfirmedAtMs: 4_102_444_800_000 }, { ttlSeconds: 86_400 }, { approver: "ops" }, { reasonCode: "other" }, { userId: bob }, [bob]]) {
      expect(await carol("POST", approvePath(id), body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: "malformed request" } });
    }
    for (const body of [
      {},
      { reasonCode: "because I said so" },
      { reasonCode: "other", reason: "typed by a person" },
      { reasonCode: "other", operator: "ops" },
      { reasonCode: "other", decidedBy: bob },
      { reasonCode: "other", identityConfirmedAtMs: 1 },
      { reason: "only text" },
    ]) {
      expect(await carol("POST", rejectPath(id), body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: "malformed request" } });
    }
    for (const bad of ["auth_nope", "esc_00000000-0000-4000-8000-000000000000", "..%2F..%2Fv1%2Fauthorize"]) {
      expect((await carol("POST", approvePath(bad), {})).status, bad).toBe(400);
      expect((await carol("POST", rejectPath(bad), { reasonCode: "other" })).status, bad).toBe(400);
    }
    expect(p.l2Calls()).toBe(before);
    expect(decisionEntries(p)).toEqual([]);
  });

  it("T-PRT-12 L2's refusals are relayed with their fields: own payment, an old sign-in, unknown, no longer pending", async () => {
    const p = await start({ admin: true });
    // dana is an administrator and a user: her own payment.
    const own = await escalate(p, { subject: "dana" });
    expect(await p.adminAs("dana")("POST", approvePath(own), {})).toMatchObject({ status: 403, body: { error: "own_payment" } });
    expect(await p.adminAs("dana")("POST", rejectPath(own), { reasonCode: "other" })).toMatchObject({ status: 403, body: { error: "own_payment" } });
    // An old sign-in: an approval is refused, a rejection is not.
    const stale = Math.floor(p.l2.clock.now() / 1000) - 901;
    const old = p.adminAs("carol", { user: false, authTime: stale });
    const r = await old("POST", approvePath(own), {});
    expect(r).toMatchObject({ status: 403, body: { error: "step_up_required", maxAgeSec: 900 } });
    expect(r.text).toBe(JSON.stringify({ error: "step_up_required", maxAgeSec: 900 }));
    expect(decisionEntries(p)).toEqual([]);
    expect(await old("POST", approvePath(UNKNOWN), {})).toMatchObject({ status: 404, body: { error: "not found" } });
    expect((await old("POST", rejectPath(own), { reasonCode: "not_expected" })).status).toBe(200);
    // No longer pending: how it ended, on which path and by whom.
    const carol = p.adminAs("carol", { user: false });
    expect(await carol("POST", approvePath(own), {})).toEqual(
      expect.objectContaining({ status: 409, body: { error: "not_pending", state: "denied", channel: "portal", decidedBy: p.userId("carol"), rejectionId: p.l2.entries("HUMAN_REJECTION")[0]!.data.rejectionId } }),
    );
    const byOperator = await escalate(p);
    await p.l2.operator("POST", `/v1/approvals/${byOperator}`, { approver: "ops-jane" });
    expect((await carol("POST", rejectPath(byOperator), { reasonCode: "other" })).body).toMatchObject({ error: "not_pending", state: "approved", channel: "operator", decidedBy: "ops-jane" });
  });

  it("T-PRT-12 a repeat returns the first outcome; an expired payment says so", async () => {
    const p = await start({ admin: true });
    const carol = p.adminAs("carol", { user: false });
    const id = await escalate(p, { sessionId: "s1" });
    const first = await carol("POST", approvePath(id), {});
    const again = await p.adminAs("erin", { user: false })("POST", approvePath(id), {});
    expect(again.body).toEqual({ ...first.body, already: true });
    expect(decisionEntries(p)).toHaveLength(1);
    const late = await escalate(p, { sessionId: "s2" });
    p.l2.clock.advance(300_000);
    const expired = await p.adminAs("carol", { user: false })("POST", approvePath(late), {});
    expect(expired.status).toBe(409);
    expect(expired.body).toMatchObject({ error: "not_pending", state: "expired" });
    expect(Object.keys(expired.body)).not.toContain("channel");
  });

  it("T-PRT-12 L2 unreachable: 502, and nothing is decided", async () => {
    const p = await start({ admin: true, controlDown: true });
    const carol = p.adminAs("carol", { user: false });
    expect(await carol("POST", approvePath(UNKNOWN), {})).toMatchObject({ status: 502, body: { error: "control_unavailable" } });
    expect(await carol("POST", rejectPath(UNKNOWN), { reasonCode: "other" })).toMatchObject({ status: 502, body: { error: "control_unavailable" } });
  });

  it("T-PRT-12 a user without the role decides nothing, with any body", async () => {
    const p = await start({ admin: true });
    const id = await escalate(p);
    const before = p.l2Calls();
    expect((await p.as("alice")("POST", approvePath(id), {})).status).toBe(403);
    expect((await p.as("alice")("POST", rejectPath(id), { reasonCode: "other" })).status).toBe(403);
    expect(p.l2Calls()).toBe(before);
    expect(decisionEntries(p)).toEqual([]);
  });

  it("T-PRT-10 must-fail (completed): with skipAdminCheck an ordinary user approves a payment", async () => {
    const p = await start({ admin: true, skipAdminCheck: true });
    const id = await escalate(p);
    expect((await p.as("alice")("POST", approvePath(id), {})).body).toMatchObject({ ok: true, state: "approved", decidedBy: p.userId("alice") });
    expect(decisionEntries(p)).toHaveLength(1);
  });
});

describe("T-PRT-13 the log of a decision (FR-034, NFR-003)", () => {
  it("T-PRT-13 each outcome has its fixed label, the route template and the administrator; never the escalation's ID or a secret", async () => {
    const p = await start({ admin: true });
    const token = await p.adminToken("carol", { user: false });
    const post = (path: string, body?: unknown, t = token) => p.call("POST", path, { token: t, ...(body !== undefined && { body }) });
    const label = () => p.logs.at(-1)!;
    const a = await escalate(p, { sessionId: "s_a" });
    const b = await escalate(p, { sessionId: "s_b" });
    const own = await escalate(p, { subject: "dana" });
    const responses: string[] = [];
    const run = async (path: string, body: unknown, expected: Record<string, unknown>, t = token) => {
      responses.push((await post(path, body, t)).text);
      expect(label(), `${path} ${JSON.stringify(expected)}`).toMatchObject({ userId: p.userId("carol"), ...expected });
    };
    const approveRoute = "/api/admin/escalations/:authorizationId/approve";
    const rejectRoute = "/api/admin/escalations/:authorizationId/reject";
    await run(approvePath(a), {}, { route: approveRoute, status: 200, event: "admin_approved" });
    await run(approvePath(a), {}, { route: approveRoute, status: 200, event: "admin_already_decided" });
    await run(rejectPath(a), { reasonCode: "other" }, { route: rejectRoute, status: 409, event: "admin_not_pending" });
    await run(rejectPath(b), { reasonCode: "duplicate" }, { route: rejectRoute, status: 200, event: "admin_rejected" });
    await run(rejectPath(b), { reasonCode: "duplicate" }, { route: rejectRoute, status: 200, event: "admin_already_decided" });
    const stale = await p.adminToken("carol", { user: false, authTime: Math.floor(p.l2.clock.now() / 1000) - 5_000 });
    await run(approvePath(own), {}, { route: approveRoute, status: 403, event: "admin_step_up_required" }, stale);
    responses.push((await post(approvePath(own), {}, await p.adminToken("dana"))).text);
    expect(label()).toMatchObject({ route: approveRoute, status: 403, event: "admin_own_payment", userId: p.userId("dana") });
    // A refusal for a malformed request has no label, and still the template.
    await run(rejectPath(own), { reason: "text" }, { route: rejectRoute, status: 400 });
    expect(Object.keys(label())).not.toContain("event");

    const everything = p.rawLogs.join("\n") + responses.join("\n");
    for (const id of [a, b, own]) expect(p.rawLogs.join("\n"), "an escalation ID in the log").not.toContain(id);
    for (const secret of [TOKENS.portal, TOKENS.portalAdmin, token, stale]) expect(everything).not.toContain(secret);
    for (const line of p.logs) expect(Object.keys(line).every((k) => ["time", "route", "status", "ms", "userId", "event"].includes(k))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US3: the trail
// ---------------------------------------------------------------------------

interface Trail {
  events: Array<Record<string, unknown>>;
  first: number;
  last: number;
  cursor: number;
  more: boolean;
}

describe("T-PRT-11 the trail through the portal (US3, FR-020, FR-021)", () => {
  const EVENTS = "/api/admin/escalations/events";

  it("T-PRT-11 each event without its session reference, with the owner and whether it is the reader's own", async () => {
    const p = await start({ admin: true });
    const own = await escalate(p, { subject: "dana" });
    const other = await escalate(p, { subject: "alice" });
    await p.adminAs("carol", { user: false })("POST", rejectPath(other), { reasonCode: "wrong_seller" });
    const r = await p.adminAs("dana")<Trail>("GET", EVENTS);
    expect(r.status).toBe(200);
    const mine = r.body.events.filter((e) => e.authorizationId === own || e.authorizationId === other);
    expect(mine.map((e) => [e.kind, e.authorizationId, e.userId, e.mine, e.referenceCode])).toEqual([
      ["escalated", own, p.userId("dana"), true, own.slice(5, 13)],
      ["escalated", other, p.userId("alice"), false, other.slice(5, 13)],
      ["denied", other, p.userId("alice"), false, other.slice(5, 13)],
    ]);
    expect(mine[2]).toMatchObject({ channel: "portal", decidedBy: p.userId("carol"), reasonCode: "wrong_seller" });
    for (const e of r.body.events) expect(Object.keys(e)).not.toContain("sessionId");
    expect(r.body.cursor).toBe(p.l2.ledger.entries().length - 1);
    expect(r.body.more).toBe(false);
  });

  it("T-PRT-11 the three query values are passed on; anything else is refused before L2 is called", async () => {
    const p = await start({ admin: true });
    for (let i = 0; i < 6; i++) await escalate(p, { sessionId: `s_${String(i)}` });
    const carol = p.adminAs("carol", { user: false });
    const latest = await carol<Trail>("GET", `${EVENTS}?limit=2`);
    expect([latest.body.events.length, latest.body.more]).toEqual([2, true]);
    const earlier = await carol<Trail>("GET", `${EVENTS}?before=${String(latest.body.first)}&limit=2`);
    expect(earlier.body.last).toBeLessThan(latest.body.first);
    const next = await carol<Trail>("GET", `${EVENTS}?after=${String(earlier.body.last)}&limit=200`);
    expect(next.body.events.map((e) => e.seq)).toEqual(latest.body.events.map((e) => e.seq));
    const before = p.l2Calls();
    for (const q of ["?userId=" + p.userId("alice"), "?sessionId=s_1", "?limit=0", "?limit=201", "?after=x", "?after=1&before=2", "?after=1&after=2", "?limit=5&extra=1"]) {
      expect(await carol("GET", `${EVENTS}${q}`), q).toMatchObject({ status: 400, body: { error: "malformed request" } });
    }
    expect(p.l2Calls()).toBe(before);
  });

  it("T-PRT-11 text an operator typed comes back as the same plain string, never altered and never as anything else", async () => {
    const p = await start({ admin: true });
    const id = await escalate(p);
    const typed = '<script>alert("x")</script> & more';
    await p.l2.operator("POST", `/v1/rejections/${id}`, { operator: "<b>ops</b>", reason: typed });
    const r = await p.adminAs("carol", { user: false })<Trail>("GET", EVENTS);
    const denied = r.body.events.find((e) => e.kind === "denied")!;
    expect([denied.reason, denied.operator, denied.decidedBy, denied.channel]).toEqual([typed, "<b>ops</b>", "<b>ops</b>", "operator"]);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("T-PRT-11 L2 unreachable: 502", async () => {
    const p = await start({ admin: true, controlDown: true });
    expect(await p.adminAs("carol", { user: false })("GET", EVENTS)).toMatchObject({ status: 502, body: { error: "control_unavailable" } });
  });
});

// ---------------------------------------------------------------------------
// US4: one payment in any state, and its budget
// ---------------------------------------------------------------------------

describe("T-PRT-11 one payment through the portal (US4, FR-022..FR-024)", () => {
  const one = (id: string) => `/api/admin/escalations/${id}`;

  it("T-PRT-11 the payment as the browser gets it: the list's item, its state, the budget unchanged, and no session", async () => {
    const p = await start({ admin: true });
    const id = await escalate(p, { subject: "alice" });
    const fromL2 = (await p.l2.admin<{ budget: Record<string, unknown> }>("GET", `/v1/admin/escalations/${id}`)).body;
    const r = await p.adminAs("carol", { user: false })<Record<string, unknown>>("GET", one(id));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      authorizationId: id,
      referenceCode: id.slice(5, 13),
      owner: { userId: p.userId("alice"), platformAccount: false },
      mine: false,
      resourceKey: `http://127.0.0.1:4021${REPORT}`,
      payTo: "0xcccccccccccccccccccccccccccccccccccccccc",
      amountAtomic: "50000",
      createdAt: new Date(p.l2.clock.now()).toISOString(),
      expiresAt: new Date(p.l2.clock.now() + 300_000).toISOString(),
      state: "pending",
      budget: fromL2.budget,
      // The portal's own clock at the read: the browser counts the time left from it.
      readAt: new Date(p.l2.clock.now()).toISOString(),
    });
    p.l2.clock.advance(7_000);
    expect((await p.adminAs("carol", { user: false })<{ readAt: string }>("GET", one(id))).body.readAt).toBe(new Date(p.l2.clock.now()).toISOString());
    expect(fromL2.budget).toMatchObject({ applies: true, fits: true, run: { capAtomic: "100000", spentAtomic: "0", remainingAtomic: "100000" } });
    expect(r.text).not.toContain("sessionId");
  });

  it("T-PRT-11 a decided payment says how it ended; one's own is marked", async () => {
    const p = await start({ admin: true });
    const own = await escalate(p, { subject: "dana" });
    const other = await escalate(p);
    await p.adminAs("carol", { user: false })("POST", rejectPath(other), { reasonCode: "not_expected" });
    const dana = p.adminAs("dana");
    expect((await dana<{ mine: boolean; state: string }>("GET", one(own))).body).toMatchObject({ mine: true, state: "pending", owner: { userId: p.userId("dana") } });
    const decided = (await dana<Record<string, unknown>>("GET", one(other))).body;
    expect(decided).toMatchObject({ mine: false, state: "denied", owner: { platformAccount: true }, decision: { channel: "portal", decidedBy: p.userId("carol"), reasonCode: "not_expected" } });
  });

  it("T-PRT-11 a malformed ID is refused before L2 is called; an unknown one is 404; L2 down is 502", async () => {
    const p = await start({ admin: true });
    const carol = p.adminAs("carol", { user: false });
    const before = p.l2Calls();
    for (const bad of ["auth_nope", "events2", p.userId("alice"), "sess_alice"]) expect(await carol("GET", one(bad)), bad).toMatchObject({ status: 400, body: { error: "malformed request" } });
    expect(p.l2Calls()).toBe(before);
    expect(await carol("GET", one(UNKNOWN))).toMatchObject({ status: 404, body: { error: "not found" } });
    const down = await start({ admin: true, controlDown: true });
    expect(await down.adminAs("carol", { user: false })("GET", one(UNKNOWN))).toMatchObject({ status: 502, body: { error: "control_unavailable" } });
  });
});

// ---------------------------------------------------------------------------
// US5: the ledger check
// ---------------------------------------------------------------------------

describe("T-PRT-11 the ledger check through the portal (US5, FR-025, FR-026, NFR-004)", () => {
  const VERIFY = "/api/admin/ledger/verify";
  interface Check {
    entries: number;
    ok: boolean;
    brokenAt?: number;
    checkedAt: string;
  }

  it("T-PRT-11 the count, that it verifies, and when it was checked", async () => {
    const p = await start({ admin: true });
    await escalate(p, { subject: "alice" });
    const r = await p.adminAs("carol", { user: false })<Check>("GET", VERIFY);
    expect(r).toMatchObject({ status: 200, body: { entries: p.l2.ledger.entries().length, ok: true, checkedAt: new Date(p.l2.clock.now()).toISOString() } });
    expect(Object.keys(r.body).sort()).toEqual(["checkedAt", "entries", "ok"]);
  });

  it("T-PRT-11 one check answers for 10 s, whoever asks; then it runs again", async () => {
    const p = await start({ admin: true });
    const carol = p.adminAs("carol", { user: false });
    const dana = p.adminAs("dana");
    const t0 = p.l2.clock.now();
    const before = p.l2Calls();
    const first = await carol<Check>("GET", VERIFY);
    for (let i = 0; i < 2; i++) {
      p.l2.clock.advance(2_500);
      expect((await carol<Check>("GET", VERIFY)).body).toEqual(first.body);
      expect((await dana<Check>("GET", VERIFY)).body).toEqual(first.body);
    }
    p.l2.clock.advance(5_000); // exactly 10 s after the check: still the same answer
    expect((await dana<Check>("GET", VERIFY)).body.checkedAt).toBe(new Date(t0).toISOString());
    expect(p.l2Calls() - before).toBe(1);
    p.l2.clock.advance(1);
    const again = await carol<Check>("GET", VERIFY);
    expect(again.body.checkedAt).toBe(new Date(t0 + 10_001).toISOString());
    expect(p.l2Calls() - before).toBe(2);
  });

  it("T-PRT-11 a failure is not kept: 502 while L2 is down, and the next request asks again", async () => {
    const p = await start({ admin: true, controlDown: true });
    const carol = p.adminAs("carol", { user: false });
    expect(await carol("GET", VERIFY)).toMatchObject({ status: 502, body: { error: "control_unavailable" } });
    expect(await carol("GET", VERIFY)).toMatchObject({ status: 502, body: { error: "control_unavailable" } });
  });

  it("T-PRT-11 a user without the role is refused, and L2 is not asked", async () => {
    const p = await start({ admin: true });
    const before = p.l2Calls();
    expect((await p.as("alice")("GET", VERIFY)).status).toBe(403);
    expect(p.l2Calls()).toBe(before);
  });
});
