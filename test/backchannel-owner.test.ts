// 015 — backchannel approval by the person the run is for (SPEC L2-7 v1.16; specs/015 contracts/control-api.md
// "Tests"). In-process L2 with user accounts, two onboarded people and the stand-in approval service
// (test/helpers/backchannel-l2.ts): T-CIBA-15 (one request, to the owner, and their answer decides).
// Every must-fail switch is a test-only dep of the backchannel, never an environment variable.
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerEntry } from "../src/layer2-control/ledger.js";
import { ALICE_SUB, BOB_SUB, PAY_TO, SELLER, startBackchannelL2, type BackchannelL2, types } from "./helpers/backchannel-l2.js";

const opened: BackchannelL2[] = [];
async function start(o: Parameters<typeof startBackchannelL2>[0] = {}) {
  const l2 = await startBackchannelL2(o);
  opened.push(l2);
  return l2;
}
afterEach(async () => {
  for (const l2 of opened.splice(0)) await l2.close({ closeStub: true }).catch(() => {});
});

const PREMIUM = "/api/premium-report";
const ofType = (l2: BackchannelL2, type: LedgerEntry["type"]) => l2.ledger.entries().filter((e) => e.type === type);
const requested = (n = 1) => (entries: readonly LedgerEntry[]) => entries.filter((e) => e.type === "APPROVAL_REQUESTED").length >= n;
const hintOf = (form: Record<string, string>) => JSON.parse(form.login_hint!) as Record<string, unknown>;
const rulesOf = (body: unknown) => ((body as { violations?: { rule: string }[] }).violations ?? []).map((v) => v.rule);

describe("T-CIBA-15 one request, addressed to the owner, and their answer decides (US1, FR-006, FR-020)", () => {
  it("T-CIBA-15 an escalation of alice's sends exactly one request, to alice; bob's subject is in no request", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending");
    const { alice, bob } = l2.people;
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("ESCALATE");
    const forms = l2.stub.startForms();
    expect(forms).toHaveLength(1);
    expect(hintOf(forms[0]!)).toEqual({ format: "iss_sub", iss: l2.stub.issuer, sub: ALICE_SUB });
    expect(JSON.stringify(l2.stub.requests)).not.toContain(BOB_SUB);
    const esc = ofType(l2, "ESCALATED")[0]!;
    expect(esc.data).toMatchObject({ approvalRequest: "requested", userId: alice.userId });
    const req = ofType(l2, "APPROVAL_REQUESTED");
    expect(req).toHaveLength(1);
    expect(req[0]!.data.approver).toBe(alice.userId);
    expect(alice.userId).not.toBe(bob.userId);
  });

  it("T-CIBA-15 alice approves within the wait: AUTHORIZED, and the approval names her by usr_… with evidence that holds no subject", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending", { approve: {} });
    const { alice } = l2.people;
    const intent = l2.intentFor(PREMIUM, "50000");
    const res = await l2.authorize(intent);
    expect(res.body.status).toBe("AUTHORIZED");
    expect((res.body as { payer: string }).payer.toLowerCase()).toBe(alice.address.toLowerCase());
    const approvals = ofType(l2, "HUMAN_APPROVAL");
    expect(approvals).toHaveLength(1);
    const approval = approvals[0]!;
    expect(approval.data).toMatchObject({ channel: "backchannel", approver: alice.userId, payTo: PAY_TO, amount: "50000" });
    const evidence = approval.data.evidence as Record<string, unknown>;
    expect(Object.keys(evidence).sort()).toEqual(["answerId", "detailsSource", "issuedAt", "issuer", "userId"]);
    expect(evidence).toMatchObject({ issuer: l2.stub.issuer, userId: alice.userId });
    const esc = ofType(l2, "ESCALATED")[0]!;
    const trail = l2.ledger.entries().filter((e) => e.intentId === intent.intentId || e.data.escalationId === esc.authorizationId);
    expect(types(trail)).toEqual(["INTENT", "ESCALATED", "APPROVAL_REQUESTED", "HUMAN_APPROVAL", "INTENT", "AUTHORIZED"]);
    expect(trail[5]!.data).toMatchObject({ approvalRef: approval.data.approvalId, userId: alice.userId });
    expect(l2.ledger.verifyChain().ok).toBe(true);
  });

  it("T-CIBA-15 alice refuses: one rejection naming her by usr_…; the session's next request is DENIED human_rejected; nothing is signed", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending", "deny");
    const { alice } = l2.people;
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect([res.body.status, rulesOf(res.body)]).toEqual(["DENIED", ["human_rejected"]]);
    const rejections = ofType(l2, "HUMAN_REJECTION");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.data).toMatchObject({ channel: "backchannel", approver: alice.userId, resourceKey: `${SELLER}${PREMIUM}`, amount: "50000" });
    const again = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect([again.body.status, rulesOf(again.body)]).toEqual(["DENIED", ["human_rejected"]]);
    expect(l2.stub.startForms()).toHaveLength(1);
    expect(ofType(l2, "AUTHORIZED")).toHaveLength(0);
  });

  it("T-CIBA-15 alice and bob each have a pending escalation and each answers: each answer decides only its own (US1 scenario 5)", async () => {
    const l2 = await start();
    const { alice, bob } = l2.people;
    l2.stub.setAnswersFor(0, "pending", "pending", "pending", { approve: {} }); // alice's request: she approves
    l2.stub.setAnswersFor(1, "pending", "pending", "pending", "deny"); // bob's request: he refuses
    const a = l2.authorize(l2.intentFor(PREMIUM, "50000", { sessionId: "sess_alice" }));
    await l2.until(requested(1));
    const b = l2.authorize(l2.intentFor(PREMIUM, "50000", { sessionId: "sess_bob", as: "bob" }));
    await l2.until(requested(2));
    // Both are pending at once, each with its own request, addressed to its own owner.
    expect((await l2.pending()).pending.map((p) => [p.userId, p.approvalRequest])).toEqual([
      [alice.userId, "requested"],
      [bob.userId, "requested"],
    ]);
    expect(l2.stub.startForms().map((f) => hintOf(f).sub)).toEqual([ALICE_SUB, BOB_SUB]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body.status).toBe("AUTHORIZED");
    expect((ra.body as { payer: string }).payer.toLowerCase()).toBe(alice.address.toLowerCase());
    expect([rb.body.status, rulesOf(rb.body)]).toEqual(["DENIED", ["human_rejected"]]);
    const escalations = ofType(l2, "ESCALATED");
    const [approval] = ofType(l2, "HUMAN_APPROVAL");
    const [rejection] = ofType(l2, "HUMAN_REJECTION");
    expect(ofType(l2, "HUMAN_APPROVAL")).toHaveLength(1);
    expect(ofType(l2, "HUMAN_REJECTION")).toHaveLength(1);
    expect(approval!.data).toMatchObject({ escalationId: escalations[0]!.authorizationId, approver: alice.userId });
    expect(rejection!.data).toMatchObject({ escalationId: escalations[1]!.authorizationId, approver: bob.userId });
    expect(ofType(l2, "AUTHORIZED").map((e) => e.data.userId)).toEqual([alice.userId]);
  });

  it("T-CIBA-15 INV-12: a DENY rule at the re-evaluation wins over alice's approval, and the approval stays open", async () => {
    const l2 = await start({ backchannel: { pollDelayMs: (s) => s * 50 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(requested());
    // Meanwhile her run spends 60000 of its 100000 budget: 50000 more no longer fits.
    for (const path of ["/api/a", "/api/b", "/api/c"]) expect((await l2.authorize(l2.intentFor(path, "20000"))).body.status).toBe("AUTHORIZED");
    const res = await call;
    expect(res.body.status).toBe("DENIED");
    expect(rulesOf(res.body)).toContain("session_budget_exceeded");
    expect(ofType(l2, "HUMAN_APPROVAL").map((e) => e.data.approver)).toEqual([l2.people.alice.userId]);
    expect(ofType(l2, "AUTHORIZED").map((e) => e.data.amount)).toEqual(["20000", "20000", "20000"]);
  });

  it("T-CIBA-15 alice's account is disabled while her request is open, then she approves: the answer is recorded, the re-evaluation is DENIED, nothing is signed", async () => {
    const l2 = await start({ backchannel: { pollDelayMs: (s) => s * 50 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const { alice } = l2.people;
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(requested());
    expect((await l2.portal("POST", `/v1/users/${alice.userId}/disable`)).status).toBe(200);
    const res = await call;
    expect([res.body.status, rulesOf(res.body)]).toEqual(["DENIED", ["user_disabled"]]);
    expect(ofType(l2, "HUMAN_APPROVAL").map((e) => [e.data.channel, e.data.approver])).toEqual([["backchannel", alice.userId]]);
    expect(ofType(l2, "AUTHORIZED")).toHaveLength(0);
  });

  it("T-CIBA-15 alice is an administrator too: the portal refuses her own payment (own_payment, SEC-29), and her phone answer approves it (FR-014)", async () => {
    const l2 = await start({ admin: true, backchannel: { pollDelayMs: (s) => s * 50 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const { alice } = l2.people;
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(requested());
    const id = ofType(l2, "ESCALATED")[0]!.authorizationId!;
    const portal = await l2.admin("POST", `/v1/admin/escalations/${id}/approve`, { decidedBy: alice.userId, identityConfirmedAtMs: l2.clock.now() });
    expect(portal).toMatchObject({ status: 403, body: { error: "own_payment" } });
    expect(ofType(l2, "HUMAN_APPROVAL")).toHaveLength(0);
    const res = await call;
    expect(res.body.status).toBe("AUTHORIZED");
    expect(ofType(l2, "HUMAN_APPROVAL").map((e) => [e.data.channel, e.data.approver])).toEqual([["backchannel", alice.userId]]);
  });
});
