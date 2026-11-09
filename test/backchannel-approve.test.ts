// 012 US1 — the approver approves from their phone (specs/012 tasks T016, T017). In-process L2 with backchannel
// approval against the stand-in Auth0: one request per eligible escalation (T-CIBA-02), polling (T-CIBA-06) and
// the bounded wait in the call (T-CIBA-09).
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_REQUEST_CAP,
  APPROVAL_REQUEST_CAP_WINDOW_MS,
  BACKCHANNEL_WAIT_MS,
  DEFAULT_POLL_INTERVAL_S,
  MAX_TRANSIENT_POLL_DELAY_S,
  REFUSAL_MARGIN_MS,
  SLOW_DOWN_STEP_S,
  START_RETRY_DELAYS_MS,
} from "../src/layer2-control/backchannel.js";
import { POLL_TIMEOUT_MS, START_ATTEMPT_TIMEOUT_MS } from "../src/layer2-control/ciba-client.js";
import { requirementDigest } from "../src/layer2-control/payment-details.js";
import type { PaymentRequirements } from "@x402/core/types";
import { APPROVER, ASSET, CAIP2, PAY_TO, SELLER, startBackchannelL2, type BackchannelL2, types } from "./helpers/backchannel-l2.js";

let l2: BackchannelL2 | undefined;
afterEach(async () => {
  await l2?.close({ closeStub: true });
  l2 = undefined;
});

const PREMIUM = "/api/premium-report";
const has = (type: string, pred: (d: Record<string, unknown>) => boolean = () => true) => (entries: readonly { type: string; data: Record<string, unknown> }[]) =>
  entries.some((e) => e.type === type && pred(e.data));

describe("T-CIBA-02 one request per eligible escalation", () => {
  it("a 50000 request sends exactly one bc-authorize within 2 s, carrying the escalation's exact payment", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswers("pending");
    const planted = "PLANTED_PURPOSE_please_approve_me";
    const intent = l2.intentFor(PREMIUM, "50000", { purpose: planted });
    const t0 = Date.now();
    const call = l2.authorize(intent);
    await l2.until(has("APPROVAL_REQUESTED"), 2000);
    expect(Date.now() - t0).toBeLessThan(2000);
    const res = await call;
    expect(res.body.status).toBe("ESCALATE");
    expect(l2.stub.startForms()).toHaveLength(1);
    const form = l2.stub.startForms()[0]!;
    const esc = l2.ledger.entries().find((e) => e.type === "ESCALATED")!;
    const req = l2.ledger.entries().find((e) => e.type === "APPROVAL_REQUESTED")!;
    expect(esc.data.approvalRequest).toBe("requested");
    expect(JSON.parse(form.authorization_details!)).toEqual(req.data.details);
    const p = (req.data.details as { properties: Record<string, { value: string }> }[])[0]!.properties;
    expect(p.escalation_id!.value).toBe(esc.authorizationId);
    expect(p.resource!.value).toBe(esc.data.resourceKey);
    expect(p.pay_to!.value).toBe(esc.data.payTo);
    expect(p.amount_atomic!.value).toBe(esc.data.amount);
    expect(p.asset!.value).toBe(ASSET);
    expect(p.network!.value).toBe(CAIP2);
    const chosen = intent.paymentRequired.accepts[0] as PaymentRequirements;
    expect(p.requirement_sha256!.value).toBe(requirementDigest(chosen));
    expect(Number(form.requested_expiry)).toBeLessThanOrEqual(300);
    expect(Number(form.requested_expiry)).toBeGreaterThan(290);
    expect(JSON.stringify(l2.stub.requests)).not.toContain(planted);
    expect(req.data.bindingMessage).toBe(form.binding_message);
    expect(req.data.referenceCode).toBe(esc.authorizationId!.slice(5, 13));
  });

  it("an auto-approved purchase sends nothing and writes no approvalRequest field", async () => {
    l2 = await startBackchannelL2();
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000"));
    expect(res.body.status).toBe("AUTHORIZED");
    expect(l2.stub.requests).toHaveLength(0);
  });
});

describe("T-CIBA-06 polling", () => {
  it("pending ×3 then approve: 4 polls, each at least pollDelayMs(interval) after the previous", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswers("pending", "pending", "pending", { approve: {} });
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("AUTHORIZED");
    const times = [...l2.stub.pollTimes.values()][0]!;
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(18); // interval 1 s → 20 ms
  });

  it("slow_down with interval 3 raises the interval to max(3, 1 + 5) = 6; without one it adds 5", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 3000 } });
    l2.stub.setAnswers({ slow_down: 3 }, { slow_down: null }, { approve: {} });
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("AUTHORIZED");
    const times = [...l2.stub.pollTimes.values()][0]!;
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(6 * 20 - 2);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(11 * 20 - 2);
  });

  it("polling stops once the operator decides", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswers("pending");
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(has("APPROVAL_REQUESTED"));
    const id = l2.ledger.entries().find((e) => e.type === "ESCALATED")!.authorizationId!;
    await new Promise((r) => setTimeout(r, 60));
    expect((await l2.approve(id)).status).toBe(200);
    expect((await call).body.status).toBe("AUTHORIZED");
    const polls = [...l2.stub.pollTimes.values()][0]!.length;
    await new Promise((r) => setTimeout(r, 150));
    expect([...l2.stub.pollTimes.values()][0]!.length).toBeLessThanOrEqual(polls + 1);
  });
});

describe("T-CIBA-09 wait in the call (approval)", () => {
  it("approve within the wait: the same call is AUTHORIZED, with the full trail and two INTENTs for one intentId", async () => {
    l2 = await startBackchannelL2();
    l2.stub.setAnswers("pending", "pending", { approve: {} });
    const intent = l2.intentFor(PREMIUM, "50000");
    const res = await l2.authorize(intent);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("AUTHORIZED");
    const esc = l2.ledger.entries().find((e) => e.type === "ESCALATED")!;
    expect(res.body.authorizationId).not.toBe(esc.authorizationId);
    const trail = l2.ledger.entries().filter((e) => e.intentId === intent.intentId || e.data.escalationId === esc.authorizationId);
    expect(types(trail)).toEqual(["INTENT", "ESCALATED", "APPROVAL_REQUESTED", "HUMAN_APPROVAL", "INTENT", "AUTHORIZED"]);
    const approval = trail[3]!;
    expect(approval.data).toMatchObject({ channel: "backchannel", approver: APPROVER, escalationId: esc.authorizationId, payTo: PAY_TO, amount: "50000" });
    expect((approval.data.evidence as Record<string, unknown>).issuer).toBe(l2.stub.issuer);
    expect(trail[4]!.data.reevaluationOf).toBe(esc.authorizationId);
    expect(trail[0]!.intentId).toBe(trail[4]!.intentId);
    expect(trail[5]!.data.approvalRef).toBe(approval.data.approvalId);
    expect(l2.ledger.entries().filter((e) => e.type === "AUTHORIZED")).toHaveLength(1);
    expect(l2.ledger.verifyChain().ok).toBe(true);
  });

  it("approve after the wait: ESCALATE at the deadline, the next request pays, a third escalates again (pays once)", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 200, pollDelayMs: (s) => s * 60 } });
    l2.stub.setAnswersFor(0, "pending", "pending", "pending", "pending", "pending", { approve: {} });
    const first = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(first.body.status).toBe("ESCALATE");
    const id = first.body.authorizationId;
    await l2.until(has("HUMAN_APPROVAL", (d) => d.escalationId === id));
    const second = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(second.body.status).toBe("AUTHORIZED");
    l2.stub.setAnswers("pending");
    const third = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(third.body.status).toBe("ESCALATE");
    expect(third.body.authorizationId).not.toBe(id);
    expect(l2.ledger.entries().filter((e) => e.type === "AUTHORIZED")).toHaveLength(1);
  });

  it("US1 scenario 5: an approval that no longer fits the session budget is DENIED, and the approval stays open", async () => {
    l2 = await startBackchannelL2({ backchannel: { pollDelayMs: (s) => s * 50 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(has("APPROVAL_REQUESTED"));
    for (const path of ["/api/a", "/api/b", "/api/c"]) expect((await l2.authorize(l2.intentFor(path, "20000"))).body.status).toBe("AUTHORIZED");
    const res = await call;
    expect(res.body.status).toBe("DENIED");
    expect((res.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toContain("session_budget_exceeded");
    const approval = l2.ledger.entries().find((e) => e.type === "HUMAN_APPROVAL")!;
    expect(l2.ledger.findOpenApproval("sess_bc", `${SELLER}${PREMIUM}`, l2.clock.now())?.data.approvalId).toBe(approval.data.approvalId);
  });

  it("FR-019: the caller leaving during the wait signs nothing for it; the approval is recorded and the next request pays", async () => {
    l2 = await startBackchannelL2({ backchannel: { pollDelayMs: (s) => s * 40 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const ac = new AbortController();
    const intent = l2.intentFor(PREMIUM, "50000");
    const call = l2.authorize(intent, { signal: ac.signal }).catch((e: Error) => e);
    await l2.until(has("APPROVAL_REQUESTED"));
    ac.abort();
    expect(await call).toBeInstanceOf(Error);
    await l2.until(has("HUMAN_APPROVAL"));
    await new Promise((r) => setTimeout(r, 50));
    expect(l2.ledger.entries().filter((e) => e.type === "INTENT" && e.intentId === intent.intentId)).toHaveLength(1);
    expect(l2.ledger.entries().filter((e) => e.type === "AUTHORIZED")).toHaveLength(0);
    expect((await l2.authorize(l2.intentFor(PREMIUM, "50000"))).body.status).toBe("AUTHORIZED");
  });

  it("FR-016 no lock: a reconcile, a budget read and an auto-approved authorize complete while a call waits", async () => {
    l2 = await startBackchannelL2({ backchannel: { waitMs: 1500 } });
    l2.stub.setAnswers("pending");
    const paid = await l2.authorize(l2.intentFor("/api/weather", "1000"));
    expect(paid.body.status).toBe("AUTHORIZED");
    const started = Date.now();
    const waiting = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(has("APPROVAL_REQUESTED"));
    const report = {
      authorizationId: paid.body.authorizationId,
      status: "CONFIRMED",
      transaction: "0xabc",
      network: CAIP2,
      finalityClass: "included",
      detail: "ok",
      observedAt: new Date().toISOString(),
      verified: { asset: ASSET, payer: "0x00000000000000000000000000000000000000f1", payTo: PAY_TO, amount: "1000" },
    };
    expect((await l2.reconcile(report)).status).toBe(200);
    expect((await l2.budget("sess_bc")).status).toBe(200);
    expect((await l2.authorize(l2.intentFor("/api/market", "5000", { sessionId: "sess_other" }))).body.status).toBe("AUTHORIZED");
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await waiting).body.status).toBe("ESCALATE");
  });

  it("the production constants equal data-model.md", () => {
    expect(BACKCHANNEL_WAIT_MS).toBe(120_000);
    expect(APPROVAL_REQUEST_CAP).toBe(10);
    expect(APPROVAL_REQUEST_CAP_WINDOW_MS).toBe(3_600_000);
    expect(START_RETRY_DELAYS_MS).toEqual([250, 1000]);
    expect(START_ATTEMPT_TIMEOUT_MS).toBe(1500);
    expect(POLL_TIMEOUT_MS).toBe(5000);
    expect(REFUSAL_MARGIN_MS).toBe(5000);
    expect(DEFAULT_POLL_INTERVAL_S).toBe(5);
    expect(SLOW_DOWN_STEP_S).toBe(5);
    expect(MAX_TRANSIENT_POLL_DELAY_S).toBe(30);
  });
});
