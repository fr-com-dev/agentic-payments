// 012 US6 — the approver is not flooded with requests (specs/012 tasks T040, T041): T-CIBA-03 (repeats and
// operator-only intents) and T-CIBA-04 (the cap, with its must-fail proof).
// 015 US5: T-CIBA-19, the cap counted for each person (with its must-fail proof).
import { afterEach, describe, expect, it } from "vitest";
import { ALICE_SUB, BOB_SUB, startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";

let l2: BackchannelL2 | undefined;
afterEach(async () => {
  await l2?.close({ closeStub: true });
  l2 = undefined;
});

const PREMIUM = "/api/premium-report";
const marks = (b: BackchannelL2) => b.ledger.entries().filter((e) => e.type === "ESCALATED").map((e) => e.data.approvalRequest);

describe("T-CIBA-03 repeats and operator-only", () => {
  it("the same purchase five times: one approval request; the repeats return the same ID at once", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 400 } });
    l2.stub.setAnswers("pending");
    const first = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    const id = l2.ledger.entries().find((e) => e.type === "ESCALATED")!.authorizationId;
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      const r = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
      expect(Date.now() - t0).toBeLessThan(200);
      expect(r.body).toMatchObject({ status: "ESCALATE", authorizationId: id });
    }
    await first;
    expect(l2.stub.authReqIds).toHaveLength(1);
    expect(l2.ledger.entries().filter((e) => e.type === "ESCALATION_REPEATED")).toHaveLength(4);
  });

  it("operatorApprovalOnly: true records operator_only, sends nothing and returns at once", async () => {
    l2 = await startBackchannelL2();
    const t0 = Date.now();
    const r = await l2.authorize(l2.intentFor(PREMIUM, "50000", { operatorApprovalOnly: true }));
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.body.status).toBe("ESCALATE");
    expect(marks(l2)).toEqual(["operator_only"]);
    expect(l2.stub.requests).toHaveLength(0);
  });

  it("operatorApprovalOnly that is not a boolean is 400, and the ledger is unchanged", async () => {
    l2 = await startBackchannelL2();
    const before = l2.ledger.entries().length; // 015: the two people's onboarding entries
    const r = await l2.authorize(l2.intentFor(PREMIUM, "50000", { operatorApprovalOnly: "yes" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("malformed PaymentIntent");
    expect(l2.ledger.entries()).toHaveLength(before);
  });

  it("operatorApprovalOnly: false behaves like an absent field", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 200 } });
    l2.stub.setAnswers("pending");
    await l2.authorize(l2.intentFor(PREMIUM, "50000", { operatorApprovalOnly: false }));
    expect(marks(l2)).toEqual(["requested"]);
    expect(l2.stub.startForms()).toHaveLength(1);
  });
});

describe("T-CIBA-04 cap", () => {
  async function elevenPurchases(b: BackchannelL2) {
    b.stub.setAnswers("pending");
    for (let i = 0; i < 11; i++) {
      const t0 = Date.now();
      const r = await b.authorize(b.intentFor(PREMIUM, "50000", { sessionId: `sess_cap_${i}` }));
      expect(r.body.status).toBe("ESCALATE");
      if (i === 10) expect(Date.now() - t0).toBeLessThan(200);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  it("11 purchases in an hour: 10 requests, the 11th capped and returned at once; after the hour, requested again", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 50 } });
    await elevenPurchases(l2);
    expect(l2.stub.startForms()).toHaveLength(10);
    expect(marks(l2)).toEqual([...Array(10).fill("requested"), "capped"]);
    expect(l2.ledger.entries().filter((e) => e.type === "APPROVAL_REQUESTED")).toHaveLength(10);
    l2.clock.advance(3_600_001);
    await l2.authorize(l2.intentFor(PREMIUM, "50000", { sessionId: "sess_cap_late" }));
    expect(marks(l2).at(-1)).toBe("requested");
  });

  it("must fail without the cap: with approvalRequestCap Infinity, 11 requests are sent", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 50, approvalRequestCap: Infinity } });
    await elevenPurchases(l2);
    expect(l2.stub.startForms()).toHaveLength(11);
  });
});

describe("T-CIBA-19 the limit is counted for each person (015 US5, FR-015, SEC-18)", () => {
  const subjects = (b: BackchannelL2) => b.stub.startForms().map((f) => (JSON.parse(f.login_hint!) as { sub: string }).sub);
  /** 11 escalations of alice's, on 11 resources of one run, then one of bob's. */
  async function aliceElevenThenBob(b: BackchannelL2) {
    b.stub.setAnswers("pending");
    for (let i = 0; i < 11; i++) {
      const r = await b.authorize(b.intentFor(`/api/report-${i}`, "50000", { sessionId: "sess_alice" }));
      expect(r.body.status).toBe("ESCALATE");
    }
    const t0 = Date.now();
    const bobs = await b.authorize(b.intentFor(PREMIUM, "50000", { sessionId: "sess_bob", as: "bob" }));
    expect(bobs.body.status).toBe("ESCALATE");
    await new Promise((r) => setTimeout(r, 100));
    return { bobs, bobTookMs: Date.now() - t0 };
  }

  it("T-CIBA-19 11 escalations for alice and one for bob in an hour: alice is asked 10 times, her 11th is capped and pending, bob is asked", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 50 } });
    const { alice, bob } = l2.people;
    const { bobs } = await aliceElevenThenBob(l2);
    expect(marks(l2)).toEqual([...Array(10).fill("requested"), "capped", "requested"]);
    expect(subjects(l2)).toEqual([...Array(10).fill(ALICE_SUB), BOB_SUB]);
    const pending = (await l2.pending()).pending;
    expect(pending).toHaveLength(12);
    expect(pending[10]).toMatchObject({ userId: alice.userId, approvalRequest: "capped" });
    expect(pending[11]).toMatchObject({ authorizationId: bobs.body.authorizationId, userId: bob.userId, approvalRequest: "requested" });
    // The capped one waits for the operator like any other: an approval pays it.
    expect((await l2.approve(String(pending[10]!.authorizationId))).status).toBe(200);
    expect((await l2.authorize(l2.intentFor("/api/report-10", "50000", { sessionId: "sess_alice" }))).body.status).toBe("AUTHORIZED");

    // A repeat of a pending purchase counts nothing and asks nobody again (T-CIBA-03).
    const repeat = await l2.authorize(l2.intentFor(PREMIUM, "50000", { sessionId: "sess_bob", as: "bob" }));
    expect(repeat.body).toMatchObject({ status: "ESCALATE", authorizationId: bobs.body.authorizationId });
    expect(subjects(l2)).toHaveLength(11);

    // An hour and a second after alice's first, her next escalation is asked again.
    l2.clock.advance(3_601_000);
    await l2.authorize(l2.intentFor("/api/report-late", "50000", { sessionId: "sess_alice_late" }));
    expect(marks(l2).at(-1)).toBe("requested");
    expect(subjects(l2).at(-1)).toBe(ALICE_SUB);
  });

  it("T-CIBA-19 must fail with one shared count: with sharedRequestCap, alice at the limit stops bob from being asked", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 50, sharedRequestCap: true } });
    const { bobTookMs } = await aliceElevenThenBob(l2);
    expect(marks(l2)).toEqual([...Array(10).fill("requested"), "capped", "capped"]);
    expect(subjects(l2)).toEqual(Array(10).fill(ALICE_SUB)); // bob's phone never rings
    expect(bobTookMs).toBeLessThan(500);
  });
});
