// 012 US7 — the operator and the auditor see who decided, and how (specs/012 tasks T050, T051): T-CIBA-14 (views,
// events and the audit trail from the ledger alone, SC-010) and T-CIBA-12 (a known-value scan: no credential,
// token, request handle or Auth0 text anywhere, SC-008).
// 015 US7: T-CIBA-14 extended (every outcome shows whose payment it is, the request's state, the path and who
// decided, from a whitelist) and T-CIBA-23 (entries written before v1.16 still verify and read).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLedger, type LedgerEntry } from "../src/layer2-control/ledger.js";
import { PLANTED_ERROR_TEXT, testRsaKeyPair } from "./helpers/ciba-stub.js";
import { BOB_SUB, CLIENT_KEY, CLIENT_SECRET, PAY_TO, SELLER, startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";

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
    const OWNER = l2.people.alice.userId; // 015: who was asked and who decided, by usr_…
    for (const k of ["escalated", "approval_requested", "approved", "denied", "approval_request_lapsed", "approval_verification_failed", "approval_request_failed"]) expect(kinds).toContain(k);
    const escalated = events.find((e) => e.kind === "escalated")!;
    expect(escalated).toMatchObject({ approvalRequest: "requested", referenceCode: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(events.find((e) => e.kind === "approval_requested")).toMatchObject({ requestId: expect.stringMatching(/^apq_/), referenceCode: expect.any(String), requestExpiresAt: expect.any(String) });
    expect(events.find((e) => e.kind === "approved")).toMatchObject({ channel: "backchannel", decidedBy: OWNER, approver: OWNER });
    const denied = events.filter((e) => e.kind === "denied");
    const bc = denied.find((e) => e.channel === "backchannel")!;
    expect(bc).toMatchObject({ decidedBy: OWNER });
    expect(bc.operator).toBeUndefined();
    expect(denied.find((e) => e.channel === "operator")).toMatchObject({ decidedBy: "dana", operator: "dana", reason: "not needed" });
    expect(events.find((e) => e.kind === "approval_request_lapsed")).toMatchObject({ cause: "expired" });
    expect(events.find((e) => e.kind === "approval_verification_failed")).toMatchObject({ check: "audience" });
    expect(events.find((e) => e.kind === "approval_request_failed")).toMatchObject({ failure: "permanent", error: "unauthorized_client" });

    // SC-010: the ledger file alone tells the whole story of each escalation.
    const fromFile = readFileSync(l2.ledgerFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LedgerEntry);
    const ids = fromFile.filter((e) => e.type === "ESCALATED").map((e) => e.authorizationId!);
    const read = ids.map((id) => audit(fromFile, id));
    expect(read[0]).toMatchObject({ asked: true, requestOutcome: "answered", channel: "backchannel", decidedBy: OWNER, paid: { amount: "50000" } });
    expect(read[1]).toMatchObject({ asked: true, requestOutcome: "answered", channel: "backchannel", decidedBy: OWNER, paid: undefined });
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

// ---------------------------------------------------------------------------
// 015 US7: whose phone was asked and how each request ended
// ---------------------------------------------------------------------------

/** Every key `EscalationEvent` declares (src/shared/contracts.ts). An event row holds nothing else. */
const EVENT_KEYS = [
  "seq", "at", "kind", "authorizationId", "sessionId", "resourceKey", "payTo", "amount", "expiresAt", "approvalId", "approver", "approvalExpiresAt",
  "rejectionId", "operator", "reason", "referenceCode", "approvalRequest", "channel", "decidedBy", "requestId", "requestExpiresAt", "failure", "error",
  "cause", "check", "userId", "reasonCode",
];
/** Every key `EscalationView` and `EscalationDetail` declare. */
const VIEW_KEYS = ["authorizationId", "sessionId", "resourceKey", "payTo", "amount", "createdAt", "expiresAt", "referenceCode", "approvalRequest", "userId", "state", "decision", "budget"];

describe("T-CIBA-14 extended: every outcome shows the owner, the request's state, the path and who decided (015 US7, FR-024)", () => {
  type Row = Record<string, unknown>;
  interface Outcome {
    name: string;
    opts?: Parameters<typeof startBackchannelL2>[0];
    /** Drives one escalation to its outcome and returns the escalation's ID. */
    run: (l2: BackchannelL2) => Promise<void>;
    /** Whose payment: alice's, or nobody's (the platform account). */
    owner: "alice" | "platform";
    /** `approvalRequest` on the escalated event (the mark) and in the views (the state). */
    mark: string;
    state: string;
    escalation: "pending" | "approved" | "denied" | "expired";
    /** A phone decision names the owner. */
    decidedByPhone?: boolean;
  }
  const PREMIUM_INTENT = (l2: BackchannelL2, o: Parameters<BackchannelL2["intentFor"]>[2] = {}) => l2.intentFor(PREMIUM, "50000", o);
  const OUTCOMES: Outcome[] = [
    { name: "approved", owner: "alice", mark: "requested", state: "answered", escalation: "approved", decidedByPhone: true, run: async (l2) => { l2.stub.setAnswers({ approve: {} }); await l2.authorize(PREMIUM_INTENT(l2)); } },
    { name: "refused", owner: "alice", mark: "requested", state: "answered", escalation: "denied", decidedByPhone: true, run: async (l2) => { l2.stub.setAnswers("deny"); await l2.authorize(PREMIUM_INTENT(l2)); } },
    {
      name: "unanswered", owner: "alice", mark: "requested", state: "unanswered", escalation: "expired", opts: { backchannel: { waitMs: 60 } },
      run: async (l2) => { l2.stub.setStart({ expiresIn: "as_requested" }); l2.stub.setAnswers("pending"); await l2.authorize(PREMIUM_INTENT(l2)); l2.clock.advance(300_001); await l2.service.sweep(); },
    },
    { name: "failed", owner: "alice", mark: "requested", state: "failed", escalation: "pending", run: async (l2) => { l2.stub.setStart({ permanent: "invalid_request" }); await l2.authorize(PREMIUM_INTENT(l2)); } },
    { name: "capped", owner: "alice", mark: "capped", state: "capped", escalation: "pending", opts: { backchannel: { approvalRequestCap: 0 } }, run: async (l2) => void (await l2.authorize(PREMIUM_INTENT(l2))) },
    { name: "no_owner", owner: "platform", mark: "no_owner", state: "no_owner", escalation: "pending", run: async (l2) => void (await l2.authorize(PREMIUM_INTENT(l2, { as: "platform" }))) },
    {
      name: "identity_mismatch", owner: "alice", mark: "identity_mismatch", state: "identity_mismatch", escalation: "pending",
      run: async (l2) => void (await l2.authorize({ ...PREMIUM_INTENT(l2), approvalSubject: BOB_SUB })),
    },
  ];

  it.each(OUTCOMES)("T-CIBA-14 $name: the operator's list and events and the administration list and detail agree, from the whitelist", async (o) => {
    const l2 = await start({ admin: true, ...o.opts, backchannel: { ...o.opts?.backchannel } });
    await o.run(l2);
    const { alice } = l2.people;
    const owner = o.owner === "alice" ? alice.userId : undefined;
    const id = l2.ledger.entries().find((e) => e.type === "ESCALATED")!.authorizationId!;

    // The events: the escalated one names the owner and the mark; a decision names the path and who decided.
    const { events } = await l2.events();
    const adminEvents = ((await l2.admin("GET", "/v1/admin/escalations/events")).body.events as Row[]).filter((e) => e.authorizationId === id);
    const mine = (events as Row[]).filter((e) => e.authorizationId === id);
    expect(adminEvents.map((e) => e.kind)).toEqual(mine.map((e) => e.kind));
    for (const e of [...mine, ...adminEvents]) expect(Object.keys(e).filter((k) => !EVENT_KEYS.includes(k)), String(e.kind)).toEqual([]);
    const escalated = mine.find((e) => e.kind === "escalated")!;
    expect(escalated.approvalRequest).toBe(o.mark);
    expect(escalated.userId).toBe(owner);
    for (const e of adminEvents) expect(e.userId, String(e.kind)).toBe(owner); // the administration page names the owner on every row
    const decision = mine.find((e) => e.kind === "approved" || e.kind === "denied");
    // (`approver` is a field of `approved` events only, as before; a refusal names who decided in `decidedBy`.)
    if (o.decidedByPhone) expect(decision).toMatchObject({ channel: "backchannel", decidedBy: alice.userId, ...(decision?.kind === "approved" && { approver: alice.userId }) });
    else expect(decision).toBeUndefined();
    if (decision) expect(decision.operator).toBeUndefined();
    if (o.mark === "requested" && o.name !== "failed") expect(mine.find((e) => e.kind === "approval_requested")).toMatchObject({ referenceCode: id.slice(5, 13) });

    // The lists show it while it is pending, with the request's state.
    const pending = ((await l2.pending()).pending as Row[]).filter((p) => p.authorizationId === id);
    const adminPending = ((await l2.admin("GET", "/v1/admin/escalations")).body.pending as Row[]).filter((p) => p.authorizationId === id);
    expect(pending).toHaveLength(o.escalation === "pending" ? 1 : 0);
    expect(adminPending).toEqual(pending);
    for (const p of pending) {
      expect(p).toMatchObject({ approvalRequest: o.state, referenceCode: id.slice(5, 13) });
      expect(p.userId).toBe(owner);
    }
    // The detail shows it in any state, with how it ended when a person ended it.
    const detail = (await l2.admin("GET", `/v1/admin/escalations/${id}`)).body;
    expect(detail).toMatchObject({ state: o.escalation, approvalRequest: o.state });
    expect(detail.userId).toBe(owner);
    expect(Object.keys(detail).filter((k) => !VIEW_KEYS.includes(k))).toEqual([]);
    if (o.decidedByPhone) expect(detail.decision).toMatchObject({ channel: "backchannel", decidedBy: alice.userId });
    else expect(detail.decision).toBeUndefined();
    // Nobody's subject is in any of it.
    const all = JSON.stringify([events, adminEvents, pending, adminPending, detail]);
    for (const hidden of [alice.subject, BOB_SUB, "approvalSubject", "subject"]) expect(all, hidden).not.toContain(hidden);
  });
});

describe("015 US7 the operator's CLI prints the new request states and who decided (FR-024)", () => {
  it("015 US7 escalations lines: approvalRequest prints every state in the same column; approver and decidedBy print what the entry holds", async () => {
    const { formatEvent, formatPending } = await import("../scripts/escalations.js");
    const USER = `usr_${"a".repeat(32)}`;
    const view = { authorizationId: "auth_1", sessionId: "s", resourceKey: "http://x/y", payTo: "0xp", amount: "50000", expiresAt: "2026-11-12T12:05:00.000Z", referenceCode: "abcd1234" };
    const head = "PENDING auth_1 session=s resource=http://x/y payTo=0xp amount=50000 expiresAt=2026-11-12T12:05:00.000Z referenceCode=abcd1234";
    for (const state of ["requested", "capped", "no_owner", "no_identity", "identity_mismatch", "unanswered"]) {
      expect(formatPending({ ...view, approvalRequest: state })).toBe(`${head} approvalRequest=${state}`);
      expect(formatPending({ ...view, approvalRequest: state, userId: USER })).toBe(`${head} approvalRequest=${state} userId=${USER}`);
    }
    const base = { authorizationId: "auth_1", sessionId: "s", resourceKey: "http://x/y", amount: "50000" };
    const escalated = { ...base, kind: "escalated", expiresAt: "2026-11-12T12:05:00.000Z", referenceCode: "abcd1234" };
    for (const mark of ["no_owner", "no_identity", "identity_mismatch"]) {
      expect(formatEvent({ ...escalated, approvalRequest: mark })).toBe(`ESCALATED auth_1 session=s resource=http://x/y amount=50000 expiresAt=2026-11-12T12:05:00.000Z referenceCode=abcd1234 approvalRequest=${mark}`);
    }
    // A phone approval since v1.16 names the owner; one written before names the configured approver's subject.
    const approved = { ...base, kind: "approved", approvalId: "apr_1", approvalExpiresAt: "2026-11-12T12:10:00.000Z", channel: "backchannel" };
    expect(formatEvent({ ...approved, approver: USER, decidedBy: USER })).toBe(
      `APPROVED auth_1 session=s resource=http://x/y amount=50000 approvalId=apr_1 approver=${USER} approvalExpiresAt=2026-11-12T12:10:00.000Z channel=backchannel decidedBy=${USER}`,
    );
    expect(formatEvent({ ...approved, approver: "auth0|approver-1", decidedBy: "auth0|approver-1" })).toBe(
      "APPROVED auth_1 session=s resource=http://x/y amount=50000 approvalId=apr_1 approver=auth0|approver-1 approvalExpiresAt=2026-11-12T12:10:00.000Z channel=backchannel decidedBy=auth0|approver-1",
    );
    expect(formatEvent({ ...base, kind: "approval_verification_failed", requestId: "apq_1", check: "owner" })).toBe(
      "APPROVAL_VERIFICATION_FAILED auth_1 session=s resource=http://x/y amount=50000 requestId=apq_1 check=owner",
    );
    expect(formatEvent({ ...base, kind: "approval_request_failed", requestId: "apq_1", failure: "no_owner" })).toBe(
      "APPROVAL_REQUEST_FAILED auth_1 session=s resource=http://x/y amount=50000 requestId=apq_1 failure=no_owner",
    );
  });
});

describe("T-CIBA-23 entries written before v1.16 still verify and read (015 US7, FR-022)", () => {
  const OLD_APPROVER = "auth0|approver-1";
  const A = "auth_a0000000-0000-4000-8000-000000000000";
  const B = "auth_b0000000-0000-4000-8000-000000000000";
  const C = "auth_c0000000-0000-4000-8000-000000000000";

  /** A ledger as v1.15 wrote it: the platform account's escalations, asked of and decided by the one configured approver. */
  async function v115Ledger() {
    const a = await start({ off: true, admin: true });
    const l = a.ledger;
    const t = a.clock.now();
    const base = { resourceKey: `${SELLER}${PREMIUM}`, payTo: PAY_TO, amount: "50000" };
    const escalated = (id: string, at: number) => l.append({ type: "ESCALATED", sessionId: `sess_${id.slice(5, 6)}`, intentId: `int_${id.slice(5, 6)}`, authorizationId: id, data: { violations: [], ...base, approvalRequest: "requested" } }, at);
    const asked = (id: string, at: number) =>
      l.append(
        {
          type: "APPROVAL_REQUESTED",
          sessionId: `sess_${id.slice(5, 6)}`,
          authorizationId: id,
          data: { escalationId: id, ...base, channel: "backchannel", requestId: `apq_${id}`, issuer: "https://tenant.example.auth0.com/", approver: OLD_APPROVER, referenceCode: id.slice(5, 13), bindingMessage: "Pay_0.05_USDC", details: [{ type: "x" }], requestedExpirySec: 300, requestExpiresAtMs: at + 300_000, intervalSec: 5, handleSealed: "v1.a.b.c", attempts: 1 },
        },
        at,
      );
    escalated(A, t);
    asked(A, t + 1);
    l.append(
      {
        type: "HUMAN_APPROVAL",
        sessionId: "sess_a",
        authorizationId: A,
        data: { approvalId: "apr_old", escalationId: A, ...base, approver: OLD_APPROVER, expiresAtMs: t + 600_000, channel: "backchannel", requestId: `apq_${A}`, evidence: { issuer: "https://tenant.example.auth0.com/", subject: OLD_APPROVER, answerId: "jti-old", issuedAt: new Date(t).toISOString(), detailsSource: "token" } },
      },
      t + 2,
    );
    escalated(B, t + 3);
    asked(B, t + 4);
    l.append({ type: "HUMAN_REJECTION", sessionId: "sess_b", authorizationId: B, data: { rejectionId: "rej_old", escalationId: B, ...base, channel: "backchannel", approver: OLD_APPROVER, issuer: "https://tenant.example.auth0.com/", requestId: `apq_${B}` } }, t + 5);
    escalated(C, t + 6);
    asked(C, t + 7);
    l.append({ type: "APPROVAL_VERIFICATION_FAILED", sessionId: "sess_c", authorizationId: C, data: { escalationId: C, ...base, channel: "backchannel", requestId: `apq_${C}`, check: "approver" } }, t + 8);
    await a.close({ keepLedger: true });
    return a;
  }

  it("T-CIBA-23 a v1.15 ledger loads and verifies, and every view shows the configured approver's decisions as they were written", async () => {
    const a = await v115Ledger();
    const fileBefore = readFileSync(a.ledgerFile, "utf8");
    // A new L2 (v1.16, backchannel approval on) starts on that file: the hashes are real, so a failed chain would throw here.
    const b = await start({ stub: a.stub, ledgerFile: a.ledgerFile, clock: a.clock, admin: true });
    expect(new AuditLedger(a.ledgerFile).verifyChain().ok).toBe(true);
    expect(b.ledger.verifyChain().ok).toBe(true);
    b.service.backchannel!.resume();
    await new Promise((r) => setTimeout(r, 60));

    const { events } = (await b.events()) as { events: Record<string, unknown>[] };
    const of = (id: string, kind: string) => events.find((e) => e.authorizationId === id && e.kind === kind)!;
    expect(of(A, "approved")).toMatchObject({ channel: "backchannel", decidedBy: OLD_APPROVER, approver: OLD_APPROVER, approvalId: "apr_old" });
    expect(of(B, "denied")).toMatchObject({ channel: "backchannel", decidedBy: OLD_APPROVER, rejectionId: "rej_old" });
    expect(of(C, "approval_verification_failed")).toMatchObject({ check: "approver" });
    for (const e of events) expect(Object.keys(e).filter((k) => !EVENT_KEYS.includes(k))).toEqual([]);

    // The administrators' reads: the pages, and each escalation with its decision.
    const page = (await b.admin("GET", "/v1/admin/escalations/events")).body.events as Record<string, unknown>[];
    expect(page.find((e) => e.authorizationId === A && e.kind === "approved")).toMatchObject({ decidedBy: OLD_APPROVER });
    expect((await b.admin("GET", `/v1/admin/escalations/${A}`)).body).toMatchObject({ state: "approved", approvalRequest: "answered", decision: { channel: "backchannel", decidedBy: OLD_APPROVER, approvalId: "apr_old" } });
    expect((await b.admin("GET", `/v1/admin/escalations/${B}`)).body).toMatchObject({ state: "denied", approvalRequest: "answered", decision: { channel: "backchannel", decidedBy: OLD_APPROVER, rejectionId: "rej_old" } });
    // The third is still pending, for the operator: its old request ended with the failed check, so nothing is resumed.
    expect((await b.pending()).pending).toMatchObject([{ authorizationId: C, approvalRequest: "verification_failed" }]);
    expect((await b.admin("GET", `/v1/admin/escalations/${C}`)).body).toMatchObject({ state: "pending", approvalRequest: "verification_failed" });
    // An operator decision on an old escalation that was already decided names the old decision, as before.
    expect(await b.reject(A)).toMatchObject({ status: 409, body: { state: "approved", approvalId: "apr_old" } });
    // Reading rewrote nothing: the file is byte for byte what v1.15 left.
    expect(readFileSync(a.ledgerFile, "utf8")).toBe(fileBefore);
    expect(b.stub.requests).toHaveLength(0);
  });
});
