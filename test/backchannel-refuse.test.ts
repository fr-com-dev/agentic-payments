// 012 US2 — the approver refuses (specs/012 task T024): T-CIBA-07 (refusal). A refusal ends the escalation as
// denied with the backchannel channel, and R15 applies exactly as for an operator rejection (SEC-12).
import { afterEach, describe, expect, it } from "vitest";
import { PLANTED_ERROR_TEXT } from "./helpers/ciba-stub.js";
import { APPROVER, PAY_TO, SELLER, startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";

let l2: BackchannelL2 | undefined;
afterEach(async () => {
  await l2?.close({ closeStub: true });
  l2 = undefined;
});

const PREMIUM = "/api/premium-report";

describe("T-CIBA-07 outcomes (refusal)", () => {
  it("a refusal well before the request's expiry appends one backchannel HUMAN_REJECTION copied from the escalation", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswers("pending", "deny");
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    const esc = l2.ledger.entries().find((e) => e.type === "ESCALATED")!;
    const rejections = l2.ledger.entries().filter((e) => e.type === "HUMAN_REJECTION");
    expect(rejections).toHaveLength(1);
    const rej = rejections[0]!;
    expect(rej.sessionId).toBe("sess_bc");
    expect(rej.authorizationId).toBe(esc.authorizationId);
    expect(rej.data).toEqual({
      rejectionId: expect.stringMatching(/^rej_/),
      escalationId: esc.authorizationId,
      resourceKey: `${SELLER}${PREMIUM}`,
      payTo: PAY_TO,
      amount: "50000",
      channel: "backchannel",
      approver: APPROVER,
      issuer: l2.stub.issuer,
      requestId: expect.stringMatching(/^apq_/),
    });
    expect(rej.data.operator).toBeUndefined();
    expect(rej.data.reason).toBeUndefined();

    // US2 scenario 2: the waiting call returns DENIED human_rejected, carrying only the rejection ID.
    expect(res.body.status).toBe("DENIED");
    const violations = (res.body as { violations: { rule: string; detail: string }[] }).violations;
    expect(violations).toEqual([{ rule: "human_rejected", detail: `rejected by the operator (${String(rej.data.rejectionId)})` }]);
    expect(JSON.stringify(res.body)).not.toContain(APPROVER);
    expect(JSON.stringify(res.body)).not.toContain(PLANTED_ERROR_TEXT);
    expect(l2.ledger.entries().filter((e) => e.type === "AUTHORIZED")).toHaveLength(0);
  });

  it("a later request in the same session, at another amount, is DENIED human_rejected too (R15 scope); nothing is signed", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswers("deny");
    expect((await l2.authorize(l2.intentFor(PREMIUM, "50000"))).body.status).toBe("DENIED");
    const again = await l2.authorize(l2.intentFor(PREMIUM, "30000"));
    expect(again.body.status).toBe("DENIED");
    expect((again.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toContain("human_rejected");
    expect(l2.stub.startForms()).toHaveLength(1);
    // Another session still escalates and asks again.
    l2.stub.setAnswers("pending");
    const other = await l2.authorize(l2.intentFor(PREMIUM, "50000", { sessionId: "sess_other" }));
    expect(other.body.status).toBe("ESCALATE");
    expect(l2.ledger.entries().filter((e) => e.type === "AUTHORIZED")).toHaveLength(0);
  });
});
