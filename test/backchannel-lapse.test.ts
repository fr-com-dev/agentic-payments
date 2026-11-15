// 012 US3 — no answer: expiry, the operator fallback and restarts (specs/012 tasks T027–T030): T-CIBA-07 (lapse
// and expiry), the operator path during a request, T-CIBA-10 (serialized outcome recording, with its must-fail
// proof) and T-CIBA-11 (restart).
// 015: T-CIBA-22 (a request open at deployment for an escalation with no user is not resumed; two people's
// requests are each resumed from their own handle) and T-CIBA-21 (a request nobody answered reads `unanswered`,
// with L2 running throughout and after a restart: the 2026-11-12 finding, research R9).
import { afterEach, describe, expect, it } from "vitest";
import { approvalRequestCount, approvalRequestState } from "../src/layer2-control/escalations.js";
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
    expect(approvalRequestCount(l2.ledger.entries(), l2.clock.now(), 3_600_000, l2.people.alice.userId)).toBe(2);
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

describe("T-CIBA-22 a request open when v1.16 is deployed (015 US3, research R10)", () => {
  const OLD_ID = "auth_0ld00000-0000-4000-8000-000000000000";
  const OLD_REQUEST = "apq_0ld00000-0000-4000-8000-000000000000";

  /** A ledger as v1.15 left it: an escalation of the platform account marked requested, and its request to the configured approver. */
  async function ledgerWithAnOldRequest(requestLifetimeMs = 300_000) {
    const a = await start({ off: true });
    const t = a.clock.now();
    const base = { resourceKey: `${SELLER}${PREMIUM}`, payTo: PAY_TO, amount: "50000" };
    a.ledger.append({ type: "ESCALATED", sessionId: "sess_old", intentId: "int_old", authorizationId: OLD_ID, data: { violations: [], ...base, approvalRequest: "requested" } }, t);
    a.ledger.append(
      {
        type: "APPROVAL_REQUESTED",
        sessionId: "sess_old",
        authorizationId: OLD_ID,
        data: {
          escalationId: OLD_ID,
          ...base,
          channel: "backchannel",
          requestId: OLD_REQUEST,
          issuer: a.stub.issuer,
          approver: "auth0|approver-1",
          referenceCode: OLD_ID.slice(5, 13),
          bindingMessage: "Pay_0.05_USDC",
          details: [{ type: "x" }],
          requestedExpirySec: 300,
          requestExpiresAtMs: t + requestLifetimeMs,
          intervalSec: 1,
          handleSealed: a.port.seal("areq-from-before-1-16", `${OLD_ID}|${OLD_REQUEST}`),
          attempts: 1,
        },
      },
      t + 1,
    );
    await a.close({ keepLedger: true });
    return a;
  }

  it("T-CIBA-22 an open request of an escalation with no user: no poll, one APPROVAL_REQUEST_FAILED{resume, no_owner}, and the escalation expires at 300 s", async () => {
    const a = await ledgerWithAnOldRequest();
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock: a.clock });
    expect(b.port.open(String(b.ledger.entries().find((e) => e.type === "APPROVAL_REQUESTED")!.data.handleSealed), `${OLD_ID}|${OLD_REQUEST}`)).toBe("areq-from-before-1-16"); // it could have been polled
    b.service.backchannel!.resume();
    await b.until((es) => es.some((e) => e.type === "APPROVAL_REQUEST_FAILED"));
    await new Promise((r) => setTimeout(r, 120)); // several poll intervals of the helper (20 ms)
    expect(b.stub.requests).toHaveLength(0);
    const failures = ofType(b, "APPROVAL_REQUEST_FAILED");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.data).toMatchObject({ escalationId: OLD_ID, requestId: OLD_REQUEST, channel: "backchannel", phase: "resume", failure: "no_owner" });
    // Neither the entry nor the log line repeats the old approver's subject.
    expect(JSON.stringify(failures[0])).not.toContain("auth0|approver-1");
    expect(b.logs.join("\n")).not.toContain("auth0|approver-1");
    expect(b.logs.filter((l) => l.includes(OLD_ID))).toHaveLength(1);
    // The operator path remains, and without it the escalation ends as every unanswered one does.
    expect((await b.pending()).pending.map((p) => p.authorizationId)).toEqual([OLD_ID]);
    b.clock.advance(300_000);
    await b.service.sweep();
    expect(ofType(b, "ESCALATION_EXPIRED").map((e) => e.data.escalationId)).toEqual([OLD_ID]);
    expect(ofType(b, "HUMAN_APPROVAL")).toHaveLength(0);
    expect(b.ledger.verifyChain().ok).toBe(true);
  });

  it("T-CIBA-22 the same request already past its own expiry at the restart is closed the same way, not recorded as a lapse", async () => {
    // The service had granted this request 60 s. Two minutes later its own lifetime is over; the escalation's is not.
    const a = await ledgerWithAnOldRequest(60_000);
    const clock = new TestClock();
    clock.offsetMs = a.clock.offsetMs + 120_000;
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock });
    b.service.backchannel!.resume();
    await b.until((es) => es.some((e) => e.type === "APPROVAL_REQUEST_FAILED" || e.type === "APPROVAL_REQUEST_LAPSED"));
    await new Promise((r) => setTimeout(r, 60));
    expect(b.stub.requests).toHaveLength(0);
    expect(ofType(b, "APPROVAL_REQUEST_LAPSED")).toHaveLength(0);
    expect(ofType(b, "APPROVAL_REQUEST_FAILED").map((e) => [e.data.phase, e.data.failure])).toEqual([["resume", "no_owner"]]);
    expect((await b.pending()).pending.map((p) => p.authorizationId)).toEqual([OLD_ID]);
  });

  it("T-CIBA-22 alice's and bob's requests both open at the restart: each is polled from its own handle, and each answer decides only its own escalation", async () => {
    const a = await start();
    a.stub.setAnswers("pending");
    void a.authorize(a.intentFor(PREMIUM, "50000", { sessionId: "sess_alice" })).catch(() => undefined);
    await a.until((es) => es.filter((e) => e.type === "APPROVAL_REQUESTED").length === 1);
    void a.authorize(a.intentFor(PREMIUM, "50000", { sessionId: "sess_bob", as: "bob" })).catch(() => undefined);
    await a.until((es) => es.filter((e) => e.type === "APPROVAL_REQUESTED").length === 2);
    const [aliceHandle, bobHandle] = a.stub.authReqIds;
    await a.close({ keepLedger: true });
    const polledBefore = a.stub.requests.filter((r) => r.path === "/oauth/token").length;

    a.stub.setAnswersFor(0, { approve: {} }); // alice approves
    a.stub.setAnswersFor(1, "deny"); // bob refuses
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock: a.clock });
    b.service.backchannel!.resume();
    await b.until((es) => es.some((e) => e.type === "HUMAN_APPROVAL") && es.some((e) => e.type === "HUMAN_REJECTION"));
    const polls = b.stub.requests.filter((r) => r.path === "/oauth/token").slice(polledBefore);
    expect(new Set(polls.map((p) => p.form.auth_req_id))).toEqual(new Set([aliceHandle, bobHandle]));
    expect(b.stub.startForms()).toHaveLength(2); // no new request: the subjects are gone, and nothing needs them
    const escalations = ofType(b, "ESCALATED");
    const { alice, bob } = b.people;
    expect(escalations.map((e) => e.data.userId)).toEqual([alice.userId, bob.userId]);
    expect(ofType(b, "HUMAN_APPROVAL").map((e) => [e.data.escalationId, e.data.approver])).toEqual([[escalations[0]!.authorizationId, alice.userId]]);
    expect(ofType(b, "HUMAN_REJECTION").map((e) => [e.data.escalationId, e.data.approver])).toEqual([[escalations[1]!.authorizationId, bob.userId]]);
    expect(ofType(b, "APPROVAL_REQUEST_FAILED")).toHaveLength(0);
  });
});

describe("T-CIBA-21 a request nobody answered (015 US7, FR-023, research R9)", () => {
  const stateOf = (l2: BackchannelL2) => approvalRequestState(l2.ledger.entries(), escalationOf(l2).authorizationId!, l2.clock.now());
  const trailOf = (l2: BackchannelL2) => l2.trail({ escalationId: escalationOf(l2).authorizationId! }).map((e) => e.type);
  /** An escalation of alice's whose request the service accepted for its full requested lifetime, as Auth0 does, and nobody answers. */
  async function askedAndSilent(o: Parameters<typeof startBackchannelL2>[0] = {}) {
    const l2 = await start({ backchannel: { waitMs: 80 }, ...o });
    l2.stub.setStart({ expiresIn: "as_requested" });
    l2.stub.setAnswers("pending");
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("ESCALATE");
    const req = ofType(l2, "APPROVAL_REQUESTED")[0]!;
    // The request lives exactly as long as its escalation: it asked for the escalation's remaining window.
    const escalationExpiresAt = Date.parse(escalationOf(l2).ts) + 300_000;
    expect(req.data.requestExpiresAtMs as number).toBeGreaterThan(escalationExpiresAt - 2_000);
    expect(req.data.requestExpiresAtMs as number).toBeLessThanOrEqual(escalationExpiresAt);
    expect(stateOf(l2)).toBe("requested");
    return l2;
  }

  it("T-CIBA-21 with L2 running throughout: APPROVAL_REQUESTED, then ESCALATION_EXPIRED, no APPROVAL_REQUEST_LAPSED; the state is unanswered, before the sweep and after it", async () => {
    const l2 = await askedAndSilent();
    l2.clock.advance(300_001);
    // Before any sweep: the clock alone says the window has passed.
    expect(ofType(l2, "ESCALATION_EXPIRED")).toHaveLength(0);
    expect(stateOf(l2)).toBe("unanswered");
    await new Promise((r) => setTimeout(r, 120)); // the poll loop wakes (20 ms), finds the escalation over and stops
    const polls = l2.stub.requests.filter((r) => r.path === "/oauth/token").length;
    await l2.service.sweep();
    await l2.service.sweep();
    await new Promise((r) => setTimeout(r, 80));
    expect(trailOf(l2)).toEqual(["ESCALATED", "APPROVAL_REQUESTED", "ESCALATION_EXPIRED"]);
    expect(ofType(l2, "APPROVAL_REQUEST_LAPSED")).toHaveLength(0);
    expect(stateOf(l2)).toBe("unanswered");
    expect(l2.stub.requests.filter((r) => r.path === "/oauth/token")).toHaveLength(polls); // polling stopped
    // Every view names it the same way: the administrators' detail, read by the escalation's ID.
    const admin = await start({ stub: l2.stub, ledgerFile: l2.ledgerFile, clock: l2.clock, admin: true });
    const detail = await admin.admin("GET", `/v1/admin/escalations/${escalationOf(l2).authorizationId!}`);
    expect(detail.body).toMatchObject({ state: "expired", approvalRequest: "unanswered", userId: l2.people.alice.userId });
  });

  it("T-CIBA-21 with L2 closed while the request is open and a new instance started after the window: unanswered, and nothing is appended but the expiry", async () => {
    const a = await askedAndSilent();
    await a.close({ keepLedger: true });
    const before = new AuditLedger(a.ledgerFile).entries().length;
    const clock = new TestClock();
    clock.offsetMs = a.clock.offsetMs + 301_000;
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock });
    const polledBefore = b.stub.requests.length;
    expect(stateOf(b)).toBe("unanswered"); // from the ledger alone, before resume and before any sweep
    b.service.backchannel!.resume();
    await b.service.sweep();
    await new Promise((r) => setTimeout(r, 100));
    expect(b.stub.requests).toHaveLength(polledBefore);
    expect(b.ledger.entries().slice(before).map((e) => e.type)).toEqual(["ESCALATION_EXPIRED"]);
    expect(trailOf(b)).toEqual(["ESCALATED", "APPROVAL_REQUESTED", "ESCALATION_EXPIRED"]);
    expect(stateOf(b)).toBe("unanswered");
  });

  it("T-CIBA-21 an operator approval while the request is open is abandoned, not unanswered, also once the window has passed", async () => {
    const l2 = await askedAndSilent();
    expect((await l2.approve(escalationOf(l2).authorizationId!)).status).toBe(200);
    expect(stateOf(l2)).toBe("abandoned");
    l2.clock.advance(301_000);
    await l2.service.sweep();
    expect(stateOf(l2)).toBe("abandoned");
    expect(ofType(l2, "ESCALATION_EXPIRED")).toHaveLength(0);
  });

  it("T-CIBA-21 a request that ends before its escalation is still APPROVAL_REQUEST_LAPSED and reads lapsed, also after the escalation expires", async () => {
    const l2 = await start({ backchannel: { waitMs: 3000 } });
    l2.stub.setStart({ expiresIn: 1 }); // the service grants less than the window
    l2.stub.setAnswers("pending");
    await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(ofType(l2, "APPROVAL_REQUEST_LAPSED")).toHaveLength(1);
    expect(stateOf(l2)).toBe("lapsed");
    l2.clock.advance(300_000);
    await l2.service.sweep();
    expect(trailOf(l2)).toEqual(["ESCALATED", "APPROVAL_REQUESTED", "APPROVAL_REQUEST_LAPSED", "ESCALATION_EXPIRED"]);
    expect(stateOf(l2)).toBe("lapsed");
  });
});
