// 012 US3 — no answer: expiry, the operator fallback and restarts (specs/012 tasks T027–T030): T-CIBA-07 (lapse
// and expiry), the operator path during a request, T-CIBA-10 (serialized outcome recording, with its must-fail
// proof) and T-CIBA-11 (restart).
import { afterEach, describe, expect, it } from "vitest";
import { approvalRequestCount } from "../src/layer2-control/escalations.js";
import { AuditLedger } from "../src/layer2-control/ledger.js";
import { testRsaKeyPair } from "./helpers/ciba-stub.js";
import { PAY_TO, SELLER, startBackchannelL2, TestClock, type BackchannelL2 } from "./helpers/backchannel-l2.js";

const opened: BackchannelL2[] = [];
async function start(o: Parameters<typeof startBackchannelL2>[0] = {}) {
  const l2 = await startBackchannelL2(o);
  opened.push(l2);
  return l2;
}
afterEach(async () => {
  for (const l2 of opened.splice(0).reverse()) await l2.close({ closeStub: true }).catch(() => {});
});

const PREMIUM = "/api/premium-report";
const ofType = (l2: BackchannelL2, type: string) => l2.ledger.entries().filter((e) => e.type === type);
const escalationOf = (l2: BackchannelL2) => l2.ledger.entries().find((e) => e.type === "ESCALATED")!;

describe("T-CIBA-07 outcomes (lapse and expiry)", () => {
  async function lapsedThenExpired(l2: BackchannelL2, cause: "expired" | "late_refusal") {
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("ESCALATE");
    const lapses = ofType(l2, "APPROVAL_REQUEST_LAPSED");
    expect(lapses).toHaveLength(1);
    expect(lapses[0]!.data).toMatchObject({ cause, channel: "backchannel", payTo: PAY_TO, amount: "50000" });
    expect(ofType(l2, "HUMAN_REJECTION")).toHaveLength(0);
    expect((await l2.pending()).pending).toHaveLength(1);
    l2.clock.advance(300_000);
    await l2.service.sweep();
    await l2.service.sweep();
    expect(ofType(l2, "ESCALATION_EXPIRED")).toHaveLength(1);
  }

  it("expired_token appends APPROVAL_REQUEST_LAPSED{expired}; the escalation then expires at 300 s", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending", "expired_token");
    await lapsedThenExpired(l2, "expired");
  });

  it("a refusal within 5 s of the request's expiry is a lapse (late_refusal), never a rejection", async () => {
    const l2 = await start();
    l2.stub.setStart({ expiresIn: 4 });
    l2.stub.setAnswers("deny");
    await lapsedThenExpired(l2, "late_refusal");
  });

  it("no answer until the request's own expiry appends APPROVAL_REQUEST_LAPSED{expired} and stops polling", async () => {
    const l2 = await start({ backchannel: { waitMs: 3000 } });
    l2.stub.setStart({ expiresIn: 1 });
    l2.stub.setAnswers("pending");
    await lapsedThenExpired(l2, "expired");
    const polls = [...l2.stub.pollTimes.values()][0]!.length;
    await new Promise((r) => setTimeout(r, 100));
    expect([...l2.stub.pollTimes.values()][0]!.length).toBe(polls);
  });

  it("US3 scenario 1: once the escalation's window has passed, a later answer changes nothing", async () => {
    const l2 = await start({ backchannel: { pollDelayMs: (s) => s * 60 } });
    l2.stub.setAnswers("pending", "pending", { approve: {} });
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    l2.clock.advance(301_000);
    await l2.service.sweep();
    await call;
    await new Promise((r) => setTimeout(r, 250));
    expect(ofType(l2, "HUMAN_APPROVAL")).toHaveLength(0);
    expect(ofType(l2, "ESCALATION_EXPIRED")).toHaveLength(1);
    expect((await l2.approve(escalationOf(l2).authorizationId!)).status).toBe(409);
  });

  it("edge case: an escalation after an expiry sends a new request, and both count toward the cap", async () => {
    const l2 = await start({ backchannel: { waitMs: 100 } });
    l2.stub.setAnswers("pending");
    const first = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    l2.clock.advance(301_000);
    await l2.service.sweep();
    const second = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(second.body.status).toBe("ESCALATE");
    expect(second.body.authorizationId).not.toBe(first.body.authorizationId);
    await l2.until((es) => es.filter((e) => e.type === "APPROVAL_REQUESTED").length === 2);
    expect(l2.stub.authReqIds).toHaveLength(2);
    expect(approvalRequestCount(l2.ledger.entries(), l2.clock.now())).toBe(2);
  });
});

describe("012 US3 operator path during a request", () => {
  it("an operator approval during the wait: the call returns AUTHORIZED, and polling stops", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending");
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    expect((await l2.approve(escalationOf(l2).authorizationId!, { approver: "alice" })).status).toBe(200);
    expect((await call).body.status).toBe("AUTHORIZED");
    const polls = [...l2.stub.pollTimes.values()][0]?.length ?? 0;
    await new Promise((r) => setTimeout(r, 120));
    expect([...l2.stub.pollTimes.values()][0]?.length ?? 0).toBeLessThanOrEqual(polls + 1);
    expect(ofType(l2, "HUMAN_APPROVAL")[0]!.data.channel).toBe("operator");
  });

  it("an operator rejection during the wait: the call returns DENIED human_rejected", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending");
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    expect((await l2.reject(escalationOf(l2).authorizationId!, { operator: "bob" })).status).toBe(200);
    const res = await call;
    expect(res.body.status).toBe("DENIED");
    expect((res.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toEqual(["human_rejected"]);
  });

  it("after a backchannel approval, an operator reject is 409 naming the approval", async () => {
    const l2 = await start();
    l2.stub.setAnswers({ approve: {} });
    await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    const approvalId = ofType(l2, "HUMAN_APPROVAL")[0]!.data.approvalId;
    const r = await l2.reject(escalationOf(l2).authorizationId!);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ state: "approved", approvalId });
  });

  it("after a backchannel refusal, an operator approve is 409 naming the rejection", async () => {
    const l2 = await start();
    l2.stub.setAnswers("deny");
    await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    const rejectionId = ofType(l2, "HUMAN_REJECTION")[0]!.data.rejectionId;
    const r = await l2.approve(escalationOf(l2).authorizationId!);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ state: "denied", rejectionId });
  });
});

describe("T-CIBA-10 serialized outcome recording", () => {
  async function raceOperatorRejectionDuringVerification(serializeOutcomes: boolean) {
    const l2 = await start({ backchannel: { serializeOutcomes } });
    l2.stub.setJwksDelayMs(250);
    l2.stub.setAnswers({ approve: {} });
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(() => l2.stub.jwksFetches >= 1); // the token arrived; verification is fetching the keys
    expect((await l2.reject(escalationOf(l2).authorizationId!, { operator: "carol" })).status).toBe(200);
    await call;
    await new Promise((r) => setTimeout(r, 400));
    const id = escalationOf(l2).authorizationId!;
    return l2.ledger.entries().filter((e) => (e.type === "HUMAN_APPROVAL" || e.type === "HUMAN_REJECTION") && e.data.escalationId === id);
  }

  it("an operator rejection during verification: exactly one final-state entry, the operator's", async () => {
    const finals = await raceOperatorRejectionDuringVerification(true);
    expect(finals.map((e) => [e.type, e.data.channel])).toEqual([["HUMAN_REJECTION", "operator"]]);
  });

  it("must fail without it: with serializeOutcomes false, the escalation gets two final states", async () => {
    const finals = await raceOperatorRejectionDuringVerification(false);
    expect(finals.map((e) => e.type).sort()).toEqual(["HUMAN_APPROVAL", "HUMAN_REJECTION"]);
  });
});

describe("T-CIBA-11 restart", () => {
  it("a new instance resumes polling the same request from the ledger, sends no new request, and records the approval", async () => {
    const a = await start();
    a.stub.setAnswers("pending");
    void a.authorize(a.intentFor(PREMIUM, "50000")).catch(() => undefined);
    await a.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    const handle = a.stub.authReqIds[0]!;
    await a.close({ keepLedger: true }); // the stub stays up
    const polledBefore = a.stub.requests.filter((r) => r.path === "/oauth/token").length;
    expect(JSON.stringify(new AuditLedger(a.ledgerFile).entries())).not.toContain(handle);

    a.stub.setAnswers({ approve: {} });
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock: a.clock });
    b.service.backchannel!.resume();
    await b.until((es) => es.some((e) => e.type === "HUMAN_APPROVAL"));
    const polls = b.stub.requests.filter((r) => r.path === "/oauth/token").slice(polledBefore);
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((p) => p.form.auth_req_id === handle)).toBe(true);
    expect(b.stub.startForms()).toHaveLength(1);
    expect((await b.authorize(b.intentFor(PREMIUM, "50000"))).body.status).toBe("AUTHORIZED");
  });

  it("with the window already past at resume: no poll; the sweep expires the escalation", async () => {
    const a = await start();
    a.stub.setAnswers("pending");
    void a.authorize(a.intentFor(PREMIUM, "50000")).catch(() => undefined);
    await a.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    await a.close({ keepLedger: true });
    const polledBefore = a.stub.requests.length;
    const clock = new TestClock();
    clock.offsetMs = a.clock.offsetMs + 301_000;
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock });
    b.service.backchannel!.resume();
    await b.service.sweep();
    await new Promise((r) => setTimeout(r, 100));
    expect(b.stub.requests.length).toBe(polledBefore);
    expect(b.ledger.entries().filter((e) => e.type === "ESCALATION_EXPIRED")).toHaveLength(1);
  });

  it("an escalation marked requested with no request entry is recorded as interrupted, and never sent", async () => {
    const a = await start({ off: true });
    a.ledger.append(
      {
        type: "ESCALATED",
        sessionId: "sess_bc",
        intentId: "int_crash",
        authorizationId: "auth_crash0000-0000-4000-8000-000000000000",
        data: { violations: [], resourceKey: `${SELLER}${PREMIUM}`, payTo: PAY_TO, amount: "50000", approvalRequest: "requested" },
      },
      a.clock.now(),
    );
    await a.close({ keepLedger: true });
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock: a.clock });
    b.service.backchannel!.resume();
    await b.until((es) => es.some((e) => e.type === "APPROVAL_REQUEST_FAILED"));
    expect(b.ledger.entries().find((e) => e.type === "APPROVAL_REQUEST_FAILED")!.data).toMatchObject({ phase: "resume", failure: "interrupted" });
    expect(b.stub.startForms()).toHaveLength(0);
  });

  it("a different client key cannot open the sealed handle: APPROVAL_REQUEST_FAILED{unrecoverable}", async () => {
    const a = await start();
    a.stub.setAnswers("pending");
    void a.authorize(a.intentFor(PREMIUM, "50000")).catch(() => undefined);
    await a.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    await a.close({ keepLedger: true });
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock: a.clock, clientKey: testRsaKeyPair() });
    b.service.backchannel!.resume();
    await b.until((es) => es.some((e) => e.type === "APPROVAL_REQUEST_FAILED"));
    expect(b.ledger.entries().find((e) => e.type === "APPROVAL_REQUEST_FAILED")!.data).toMatchObject({ phase: "resume", failure: "unrecoverable" });
  });
});
