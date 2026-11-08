// 012 US4 — L2 trusts only a verified approval of this exact payment (specs/012 task T034): T-CIBA-08 through L2.
// Each forgery from the stand-in Auth0 records one APPROVAL_VERIFICATION_FAILED naming the check, leaves the
// escalation pending and signs nothing. Must-fail: without a check, its forgery approves and pays.
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationCheck } from "../src/layer2-control/approval-evidence.js";
import type { Forgery } from "./helpers/ciba-stub.js";
import { startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";

let l2: BackchannelL2 | undefined;
afterEach(async () => {
  await l2?.close({ closeStub: true });
  l2 = undefined;
});

const PREMIUM = "/api/premium-report";
type Props = { properties: Record<string, { value: string }> }[];
const setValue = (key: string, value: string) => (d: unknown[]) => {
  (d as Props)[0]!.properties[key]!.value = value;
  return d;
};

const CASES: [label: string, forge: Forgery, check: VerificationCheck][] = [
  ["another issuer", "issuer", "issuer"],
  ["another audience", "audience", "audience"],
  ["another client", "client", "client"],
  ["a bad signature", "signature", "signature"],
  ["an expired answer", "expired", "expired"],
  ["another user", "subject", "approver"],
  ["another amount", { details: setValue("amount_atomic", "99999") }, "details"],
  ["another payee", { details: setValue("pay_to", "0x000000000000000000000000000000000000dEaD") }, "details"],
  ["another escalation", { details: setValue("escalation_id", "auth_00000000-0000-4000-8000-000000000000") }, "details"],
  ["a request L2 never made", "request", "request"],
];

describe("T-CIBA-08 verification through L2", () => {
  it.each(CASES)("%s: one APPROVAL_VERIFICATION_FAILED, nothing signed, the escalation pending, the operator path still pays", async (_l, forge, check) => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswers({ approve: { forge } });
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("ESCALATE");
    const failures = l2.ledger.entries().filter((e) => e.type === "APPROVAL_VERIFICATION_FAILED");
    expect(failures.map((e) => e.data.check)).toEqual([check]);
    expect(l2.ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL" || e.type === "AUTHORIZED")).toHaveLength(0);
    const pending = (await l2.pending()).pending;
    expect(pending.map((p) => p.authorizationId)).toEqual([res.body.authorizationId]);
    expect((await l2.approve(res.body.authorizationId)).status).toBe(200);
    expect((await l2.authorize(l2.intentFor(PREMIUM, "50000"))).body.status).toBe("AUTHORIZED");
  });

  it("a replayed answer from another escalation is refused (by request, then by replay when request and details are off)", async () => {
    l2 = await startBackchannelL2({ backchannel: { skipChecks: new Set<VerificationCheck>(["request", "details"]) } });
    l2.stub.setAnswersFor(0, { approve: {} });
    l2.stub.setAnswersFor(1, { approve: { forge: "replay" } });
    expect((await l2.authorize(l2.intentFor(PREMIUM, "50000"))).body.status).toBe("AUTHORIZED");
    const second = await l2.authorize(l2.intentFor("/api/other-report", "50000"));
    expect(second.body.status).toBe("ESCALATE");
    expect(l2.ledger.entries().filter((e) => e.type === "APPROVAL_VERIFICATION_FAILED").map((e) => e.data.check)).toEqual(["replay"]);
  });

  it("with every check on, the replayed answer already fails the request check", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswersFor(0, { approve: {} });
    l2.stub.setAnswersFor(1, { approve: { forge: "replay" } });
    await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.authorize(l2.intentFor("/api/other-report", "50000"));
    expect(l2.ledger.entries().filter((e) => e.type === "APPROVAL_VERIFICATION_FAILED").map((e) => e.data.check)).toEqual(["request"]);
  });

  it.each<[VerificationCheck[], Forgery, string]>([
    [["details"], { details: setValue("amount_atomic", "99999") }, "an answer for a different amount"],
    [["approver"], "subject", "another user's approval"],
    [["issuer"], "issuer", "a token from another issuer"],
    [["request", "details", "replay"], "replay", "one token for two escalations"],
  ])("must fail without %j: %s approves and pays", async (skip, forge) => {
    l2 = await startBackchannelL2({ backchannel: { skipChecks: new Set(skip) } });
    if (forge === "replay") {
      l2.stub.setAnswersFor(0, { approve: {} });
      l2.stub.setAnswersFor(1, { approve: { forge } });
      await l2.authorize(l2.intentFor("/api/first-report", "50000"));
    } else {
      l2.stub.setAnswers({ approve: { forge } });
    }
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("AUTHORIZED");
    expect(l2.ledger.entries().filter((e) => e.type === "APPROVAL_VERIFICATION_FAILED")).toHaveLength(0);
  });

  it("US4 scenario 4: two pending escalations; approving the second leaves the first pending", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswersFor(0, "pending");
    l2.stub.setAnswersFor(1, { approve: {} });
    const first = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
    const second = await l2.authorize(l2.intentFor("/api/other-report", "60000"));
    expect(second.body.status).toBe("AUTHORIZED");
    const firstRes = await first;
    expect(firstRes.body.status).toBe("ESCALATE");
    expect((await l2.pending()).pending.map((p) => p.authorizationId)).toEqual([firstRes.body.authorizationId]);
    expect(l2.ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL")).toHaveLength(1);
  });
});
