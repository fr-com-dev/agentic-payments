// 012 US6 — the approver is not flooded with requests (specs/012 tasks T040, T041): T-CIBA-03 (repeats and
// operator-only intents) and T-CIBA-04 (the cap, with its must-fail proof).
import { afterEach, describe, expect, it } from "vitest";
import { startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";

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
    const r = await l2.authorize(l2.intentFor(PREMIUM, "50000", { operatorApprovalOnly: "yes" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("malformed PaymentIntent");
    expect(l2.ledger.entries()).toHaveLength(0);
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
