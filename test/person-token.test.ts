// 1.19 (Phase 3, findings #5 and #6) — L2 verifies the person behind a portal request itself (SPEC.md §8.2 L2-5,
// L2-8, §11 SEC-35; T-PER-01..03). Before 1.19 the portal's role token alone let its holder act for any user: the
// user came from the path, the step-up time from the body, the administrator from the body.
import { afterEach, describe, expect, it } from "vitest";
import { DEV_AGENT_CLIENT, DEV_PORTAL_CLIENT } from "../scripts/dev-issuer-lib.js";
import { ALICE, BOB, CAROL, policyValues, startUsersL2, T0, TOKENS, type UsersL2 } from "./helpers/users.js";

let l2s: UsersL2[] = [];
afterEach(async () => {
  for (const l of l2s.splice(0)) await l.close();
});
const start = async (o: Parameters<typeof startUsersL2>[0] = {}) => {
  const l = await startUsersL2(o);
  l2s.push(l);
  return l;
};
const policies = (l2: UsersL2) => `/v1/users/${ALICE}/policies`;

describe("T-PER-01 a user-account route needs the person's own token, for their own account", () => {
  it("T-PER-01 the portal's role token alone is 401 person_token_required on every user route, and nothing is appended", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const before = l2.ledger.entries().length;
    for (const [method, path, body] of [
      ["GET", `/v1/users/${ALICE}`, undefined],
      ["PUT", `/v1/users/${ALICE}/registration`, { acknowledgedTestFunds: true }],
      ["PUT", `/v1/users/${ALICE}/wallet`, undefined],
      ["POST", policies(l2), policyValues()],
      ["POST", `/v1/users/${ALICE}/disable`, undefined],
    ] as const) {
      expect((await l2.call(method, path, { ...(body !== undefined && { body }) })).body, `${method} ${path}`).toEqual({ error: "person_token_required" });
    }
    expect(l2.ledger.entries()).toHaveLength(before);
    // The platform view names nobody: the role token is enough.
    expect((await l2.call("GET", "/v1/platform")).status).toBe(200);
  });

  it("T-PER-01 another person's token is 403 person_mismatch: nobody acts on someone else's account", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    const bob = await l2.portalToken(BOB);
    expect((await l2.call("POST", policies(l2), { person: bob, body: policyValues() })).body).toEqual({ error: "person_mismatch" });
    expect((await l2.call("POST", `/v1/users/${ALICE}/disable`, { person: bob })).body).toEqual({ error: "person_mismatch" });
    expect(l2.entries("POLICY_CREATED")).toEqual([]);
    expect(l2.entries("USER_DISABLED")).toEqual([]);
  });

  it("T-PER-01 an agent client's token, a machine token, or a portal token without a sign-in time is refused", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    const agent = await l2.callers.forUser(ALICE, { azp: DEV_AGENT_CLIENT, authTime: Math.floor(T0 / 1000) });
    const machine = await l2.callers.machine({ client: DEV_PORTAL_CLIENT });
    const noTime = await l2.callers.forUser(ALICE, { azp: DEV_PORTAL_CLIENT });
    expect((await l2.call("GET", `/v1/users/${ALICE}`, { person: agent })).body).toEqual({ error: "person_forbidden" });
    expect((await l2.call("GET", `/v1/users/${ALICE}`, { person: machine })).body).toEqual({ error: "person_forbidden" });
    expect((await l2.call("GET", `/v1/users/${ALICE}`, { person: noTime })).body).toEqual({ error: "person_token_invalid" });
    // A person's token in the caller's header is no person's token here.
    expect((await l2.call("GET", `/v1/users/${ALICE}`, { caller: await l2.portalToken(ALICE) })).body).toEqual({ error: "person_token_required" });
  });

  it("T-PER-01 the step-up time is the token's: a body can't claim a fresh sign-in", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    const stale = await l2.portalToken(ALICE, { authMs: T0 - 86_400_000 });
    expect((await l2.call("POST", policies(l2), { person: stale, body: policyValues() })).body).toEqual({ error: "step_up_required", maxAgeSec: 900 });
    expect((await l2.call("POST", policies(l2), { person: stale, body: { ...policyValues(), identityConfirmedAtMs: T0 } })).status).toBe(400);
    expect(l2.entries("POLICY_CREATED")).toEqual([]);
  });

  it("T-PER-01 must fail: without the person check (skipPersonCheck), the portal's role token alone creates a policy for any user", async () => {
    const l2 = await start({ person: { skipPersonCheck: true } });
    await l2.withWallet(ALICE);
    expect((await l2.call("POST", policies(l2), { body: policyValues() })).status).toBe(201);
    expect(l2.entries("POLICY_CREATED")).toHaveLength(1);
  });
});

describe("T-PER-02 an administration route needs the administrator's own token, with portal:admin", () => {
  it("T-PER-02 the administration role's token alone is 401; a person's token without portal:admin is 403; nothing is decided", async () => {
    const l2 = await start({ admin: true });
    expect((await l2.call("GET", "/v1/admin/escalations", { token: TOKENS.portalAdmin })).body).toEqual({ error: "person_token_required" });
    const plain = await l2.portalToken(CAROL);
    expect((await l2.call("GET", "/v1/admin/escalations", { token: TOKENS.portalAdmin, person: plain })).body).toEqual({ error: "person_forbidden" });
    expect((await l2.call("GET", "/v1/admin/escalations", { token: TOKENS.portalAdmin, person: await l2.portalToken(CAROL, { admin: true }) })).status).toBe(200);
  });

  it("T-PER-02 the decider is the token's person: the own-payment check can't be dodged by naming someone else", async () => {
    const l2 = await start({ admin: true });
    await l2.onboard(ALICE, { autoApproveMaxAtomic: "1000" });
    const esc = await l2.authorize(l2.intentFor("/api/report", "50000", { userId: ALICE }));
    expect(esc.body.status).toBe("ESCALATE");
    const alice = await l2.portalToken(ALICE, { admin: true });
    const path = `/v1/admin/escalations/${esc.body.authorizationId}/approve`;
    expect((await l2.call("POST", path, { token: TOKENS.portalAdmin, person: alice, body: {} })).body).toEqual({ error: "own_payment" });
    expect((await l2.call("POST", path, { token: TOKENS.portalAdmin, person: alice, body: { decidedBy: CAROL } })).status).toBe(400);
    expect(l2.entries("HUMAN_APPROVAL")).toEqual([]);
  });
});
