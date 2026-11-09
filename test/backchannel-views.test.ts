// 012 US7 — the operator and the auditor see who decided, and how (specs/012 tasks T050, T051): T-CIBA-14 (views,
// events and the audit trail from the ledger alone, SC-010) and T-CIBA-12 (a known-value scan: no credential,
// token, request handle or Auth0 text anywhere, SC-008).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../src/layer2-control/ledger.js";
import { PLANTED_ERROR_TEXT, testRsaKeyPair } from "./helpers/ciba-stub.js";
import { APPROVER, CLIENT_KEY, CLIENT_SECRET, startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";

const opened: BackchannelL2[] = [];
async function start(o: Parameters<typeof startBackchannelL2>[0] = {}) {
  const l2 = await startBackchannelL2(o);
  opened.push(l2);
  return l2;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const l2 of opened.splice(0)) await l2.close({ closeStub: true }).catch(() => {});
});

const PREMIUM = "/api/premium-report";

/** SC-010: an auditor's reading of one escalation, from the ledger file alone. */
function audit(entries: LedgerEntry[], escalationId: string) {
  const of = (type: string) => entries.find((e) => e.type === type && (e.data.escalationId === escalationId || (type === "ESCALATED" && e.authorizationId === escalationId)));
  const esc = of("ESCALATED")!;
  const decision = of("HUMAN_APPROVAL") ?? of("HUMAN_REJECTION");
  const ending = of("APPROVAL_REQUEST_FAILED") ?? of("APPROVAL_REQUEST_LAPSED") ?? of("APPROVAL_VERIFICATION_FAILED");
  const paid = decision?.type === "HUMAN_APPROVAL" ? entries.find((e) => e.type === "AUTHORIZED" && e.data.approvalRef === decision.data.approvalId) : undefined;
  return {
    asked: of("APPROVAL_REQUESTED") !== undefined,
    requestOutcome: ending?.type ?? (decision && decision.data.channel === "backchannel" ? "answered" : (esc.data.approvalRequest as string)),
    channel: decision ? (decision.data.channel ?? "operator") : undefined,
    decidedBy: decision ? (decision.type === "HUMAN_APPROVAL" ? decision.data.approver : (decision.data.operator ?? decision.data.approver)) : undefined,
    paid: paid ? { authorizationId: paid.authorizationId, amount: paid.data.amount, payTo: paid.data.payTo } : undefined,
  };
}

describe("T-CIBA-14 operator views and audit trail", () => {
  type Setup = (l2: BackchannelL2) => Promise<void>;
  const STATES: [state: string, setup: Setup, opts?: Parameters<typeof startBackchannelL2>[0]][] = [
    [
      "requested",
      async (l2) => {
        l2.stub.setAnswers("pending");
        void l2.authorize(l2.intentFor(PREMIUM, "50000")).catch(() => undefined);
        await l2.until((es) => es.some((e) => e.type === "APPROVAL_REQUESTED"));
      },
    ],
    ["capped", async (l2) => void (await l2.authorize(l2.intentFor(PREMIUM, "50000"))), { backchannel: { approvalRequestCap: 0 } }],
    ["operator_only", async (l2) => void (await l2.authorize(l2.intentFor(PREMIUM, "50000", { operatorApprovalOnly: true })))],
    [
      "failed",
      async (l2) => {
        l2.stub.setStart({ permanent: "unknown_user_id" });
        await l2.authorize(l2.intentFor(PREMIUM, "50000"));
      },
    ],
    [
      "verification_failed",
      async (l2) => {
        l2.stub.setAnswers({ approve: { forge: "subject" } });
        await l2.authorize(l2.intentFor(PREMIUM, "50000"));
      },
    ],
    [
      "lapsed",
      async (l2) => {
        l2.stub.setAnswers("expired_token");
        await l2.authorize(l2.intentFor(PREMIUM, "50000"));
      },
    ],
  ];

  it.each(STATES)("a pending escalation in state %s shows referenceCode and approvalRequest", async (state, setup, opts) => {
    const l2 = await start(opts ?? {});
    await setup(l2);
    const { pending } = await l2.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.referenceCode).toBe(String(pending[0]!.authorizationId).slice(5, 13));
    expect(pending[0]!.approvalRequest).toBe(state);
  });

  it("the events show each request outcome, the channel and who decided; operator decisions show channel operator", async () => {
    const l2 = await start();
    l2.stub.setAnswersFor(0, { approve: {} });
    l2.stub.setAnswersFor(1, "deny");
    l2.stub.setAnswersFor(2, "expired_token");
    l2.stub.setAnswersFor(3, { approve: { forge: "audience" } });
    l2.stub.setAnswersFor(4, "pending");
    await l2.authorize(l2.intentFor("/api/r1", "50000", { sessionId: "s1" }));
    await l2.authorize(l2.intentFor("/api/r2", "50000", { sessionId: "s2" }));
    await l2.authorize(l2.intentFor("/api/r3", "50000", { sessionId: "s3" }));
    await l2.authorize(l2.intentFor("/api/r4", "50000", { sessionId: "s4" }));
    const op = l2.authorize(l2.intentFor("/api/r5", "50000", { sessionId: "s5" }));
    await l2.until((es) => es.filter((e) => e.type === "APPROVAL_REQUESTED").length === 5);
    const opId = l2.ledger.entries().filter((e) => e.type === "ESCALATED").at(-1)!.authorizationId!;
    await l2.reject(opId, { operator: "dana", reason: "not needed" });
    await op;
    l2.stub.setStart({ permanent: "unauthorized_client" });
    await l2.authorize(l2.intentFor("/api/r6", "50000", { sessionId: "s6" }));

    const { events } = await l2.events();
    const kinds = events.map((e) => e.kind);
    for (const k of ["escalated", "approval_requested", "approved", "denied", "approval_request_lapsed", "approval_verification_failed", "approval_request_failed"]) expect(kinds).toContain(k);
    const escalated = events.find((e) => e.kind === "escalated")!;
    expect(escalated).toMatchObject({ approvalRequest: "requested", referenceCode: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(events.find((e) => e.kind === "approval_requested")).toMatchObject({ requestId: expect.stringMatching(/^apq_/), referenceCode: expect.any(String), requestExpiresAt: expect.any(String) });
    expect(events.find((e) => e.kind === "approved")).toMatchObject({ channel: "backchannel", decidedBy: APPROVER, approver: APPROVER });
    const denied = events.filter((e) => e.kind === "denied");
    const bc = denied.find((e) => e.channel === "backchannel")!;
    expect(bc).toMatchObject({ decidedBy: APPROVER });
    expect(bc.operator).toBeUndefined();
    expect(denied.find((e) => e.channel === "operator")).toMatchObject({ decidedBy: "dana", operator: "dana", reason: "not needed" });
    expect(events.find((e) => e.kind === "approval_request_lapsed")).toMatchObject({ cause: "expired" });
    expect(events.find((e) => e.kind === "approval_verification_failed")).toMatchObject({ check: "audience" });
    expect(events.find((e) => e.kind === "approval_request_failed")).toMatchObject({ failure: "permanent", error: "unauthorized_client" });

    // SC-010: the ledger file alone tells the whole story of each escalation.
    const fromFile = readFileSync(l2.ledgerFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LedgerEntry);
    const ids = fromFile.filter((e) => e.type === "ESCALATED").map((e) => e.authorizationId!);
    const read = ids.map((id) => audit(fromFile, id));
    expect(read[0]).toMatchObject({ asked: true, requestOutcome: "answered", channel: "backchannel", decidedBy: APPROVER, paid: { amount: "50000" } });
    expect(read[1]).toMatchObject({ asked: true, requestOutcome: "answered", channel: "backchannel", decidedBy: APPROVER, paid: undefined });
    expect(read[2]).toMatchObject({ asked: true, requestOutcome: "APPROVAL_REQUEST_LAPSED", channel: undefined });
    expect(read[3]).toMatchObject({ asked: true, requestOutcome: "APPROVAL_VERIFICATION_FAILED", channel: undefined });
    expect(read[4]).toMatchObject({ asked: true, channel: "operator", decidedBy: "dana" });
    expect(read[5]).toMatchObject({ asked: false, requestOutcome: "APPROVAL_REQUEST_FAILED" });
  });
});

describe("T-CIBA-12 known-value scan", () => {
  it.each<["key" | "secret"]>([["key"], ["secret"]])("with a %s credential, no credential, token, handle or Auth0 text appears anywhere", async (credential) => {
    const consoleLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(" ")));
    const l2 = await start({ credential, backchannel: { log: undefined } });
    const bodies: unknown[] = [];
    const keep = async <T extends { body: unknown }>(p: Promise<T>) => {
      const r = await p;
      bodies.push(r.body);
      return r;
    };
    l2.stub.setAnswersFor(0, { approve: {} });
    l2.stub.setAnswersFor(1, "deny");
    l2.stub.setAnswersFor(2, "expired_token");
    l2.stub.setAnswersFor(3, { approve: { forge: "issuer" } });
    await keep(l2.authorize(l2.intentFor("/api/s1", "50000", { sessionId: "k1" })));
    await keep(l2.authorize(l2.intentFor("/api/s2", "50000", { sessionId: "k2" })));
    await keep(l2.authorize(l2.intentFor("/api/s3", "50000", { sessionId: "k3" })));
    await keep(l2.authorize(l2.intentFor("/api/s4", "50000", { sessionId: "k4" })));
    l2.stub.setStart({ permanent: "invalid_client" });
    const failed = await keep(l2.authorize(l2.intentFor("/api/s5", "50000", { sessionId: "k5" })));
    await keep(l2.approve(failed.body.authorizationId));
    bodies.push(await l2.events(), await l2.pending());

    const haystack = [readFileSync(l2.ledgerFile, "utf8"), ...consoleLines, ...l2.logs, JSON.stringify(bodies)].join("\n");
    const needles = [
      ...CLIENT_KEY.privatePem.split("\n").filter((line) => line.length > 20 && !line.startsWith("-----")),
      CLIENT_SECRET,
      ...l2.stub.tokensIssued,
      ...l2.stub.authReqIds,
      PLANTED_ERROR_TEXT,
    ];
    expect(l2.stub.tokensIssued.length).toBeGreaterThan(0);
    expect(l2.stub.authReqIds.length).toBeGreaterThanOrEqual(4);
    expect(needles.filter((n) => haystack.includes(n))).toEqual([]);
    expect(consoleLines.some((l) => l.includes("approval request sent"))).toBe(true);

    // The handles are there, sealed, and open only with this L2's credential and their own escalation.
    const sealed = l2.ledger.entries().filter((e) => e.type === "APPROVAL_REQUESTED");
    expect(sealed.length).toBe(4);
    const other = await start({ credential, clientKey: testRsaKeyPair(), stub: l2.stub });
    for (const e of sealed) {
      const aad = `${String(e.data.escalationId)}|${String(e.data.requestId)}`;
      expect(l2.stub.authReqIds).toContain(l2.port.open(String(e.data.handleSealed), aad));
      expect(l2.port.open(String(e.data.handleSealed), `${aad}x`)).toBeNull();
      if (credential === "key") expect(other.port.open(String(e.data.handleSealed), aad)).toBeNull();
    }
  });
});
