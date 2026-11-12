// Feature 010 — escalation lifecycle derivations and sweep (SPEC.md §8.2 L2-4.3; T-LED-04).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLedger } from "../src/layer2-control/ledger.js";
import {
  activeApprovalRequest,
  answerIdUsed,
  approvalRequestCount,
  approvalRequestState,
  channelOf,
  ESCALATION_TTL_MS,
  escalationEvents,
  escalationState,
  findPendingEscalation,
  findRejection,
  openApprovalRequest,
  pendingEscalations,
  referenceCode,
  requestsToResume,
  sweep,
} from "../src/layer2-control/escalations.js";

const PAY_TO = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";
const KEY = "http://127.0.0.1:4021/api/premium-report";
const T0 = Date.parse("2026-10-18T12:00:00.000Z");

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "escalations-"));
  file = join(dir, ".local", "ledger-local.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Purchase = { sessionId?: string; key?: string; payTo?: string; amount?: string };

function escalate(l: AuditLedger, id: string, opts: Purchase & { at?: number } = {}) {
  return l.append(
    {
      type: "ESCALATED",
      sessionId: opts.sessionId ?? "sess_a",
      intentId: `int_${id}`,
      authorizationId: id,
      data: {
        violations: [{ rule: "human_approval_required", detail: "50000 > auto-approve limit 20000" }],
        resourceKey: opts.key ?? KEY,
        payTo: opts.payTo ?? PAY_TO,
        amount: opts.amount ?? "50000",
      },
    },
    opts.at ?? T0,
  );
}

function approveEntry(l: AuditLedger, escalationId: string, approvalId: string, opts: { at?: number; expiresAtMs?: number } = {}) {
  const esc = l.entries().find((e) => e.type === "ESCALATED" && e.authorizationId === escalationId)!;
  const at = opts.at ?? T0 + 1;
  return l.append(
    {
      type: "HUMAN_APPROVAL",
      sessionId: esc.sessionId!,
      authorizationId: escalationId,
      data: {
        approvalId,
        escalationId,
        resourceKey: esc.data.resourceKey,
        payTo: esc.data.payTo,
        amount: esc.data.amount,
        approver: "operator",
        expiresAtMs: opts.expiresAtMs ?? at + 600_000,
      },
    },
    at,
  );
}

function rejectEntry(l: AuditLedger, escalationId: string, rejectionId: string, opts: { at?: number } = {}) {
  const esc = l.entries().find((e) => e.type === "ESCALATED" && e.authorizationId === escalationId)!;
  return l.append(
    {
      type: "HUMAN_REJECTION",
      sessionId: esc.sessionId!,
      authorizationId: escalationId,
      data: {
        rejectionId,
        escalationId,
        resourceKey: esc.data.resourceKey,
        payTo: esc.data.payTo,
        amount: esc.data.amount,
        operator: "operator",
      },
    },
    opts.at ?? T0 + 1,
  );
}

function expireEntry(l: AuditLedger, escalationId: string, opts: { at?: number } = {}) {
  const esc = l.entries().find((e) => e.type === "ESCALATED" && e.authorizationId === escalationId)!;
  return l.append(
    {
      type: "ESCALATION_EXPIRED",
      sessionId: esc.sessionId!,
      authorizationId: escalationId,
      data: {
        escalationId,
        resourceKey: esc.data.resourceKey,
        payTo: esc.data.payTo,
        amount: esc.data.amount,
        expiresAtMs: Date.parse(esc.ts) + ESCALATION_TTL_MS,
      },
    },
    opts.at ?? Date.parse(esc.ts) + ESCALATION_TTL_MS,
  );
}

describe("T-LED-04 escalation state", () => {
  it("T-LED-04 state: not_found, pending, approved, denied, expired", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_p");
    escalate(l, "auth_a");
    escalate(l, "auth_d");
    escalate(l, "auth_e");
    approveEntry(l, "auth_a", "apr_1");
    rejectEntry(l, "auth_d", "rej_1");
    expireEntry(l, "auth_e");
    const at = T0 + 10;
    expect(escalationState(l.entries(), "auth_missing", at)).toBe("not_found");
    expect(escalationState(l.entries(), "auth_p", at)).toBe("pending");
    expect(escalationState(l.entries(), "auth_a", at)).toBe("approved");
    expect(escalationState(l.entries(), "auth_d", at)).toBe("denied");
    expect(escalationState(l.entries(), "auth_e", at)).toBe("expired");
  });

  it("T-LED-04 state: the 300 s boundary — createdMs + 299 999 is pending, createdMs + 300 000 is expired", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_p", { at: T0 });
    expect(escalationState(l.entries(), "auth_p", T0 + ESCALATION_TTL_MS - 1)).toBe("pending");
    expect(escalationState(l.entries(), "auth_p", T0 + ESCALATION_TTL_MS)).toBe("expired");
  });

  it("T-LED-04 state: final states are never left — a decided escalation keeps its state past 300 s", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_a");
    escalate(l, "auth_d");
    approveEntry(l, "auth_a", "apr_1");
    rejectEntry(l, "auth_d", "rej_1");
    const later = T0 + 10 * ESCALATION_TTL_MS;
    expect(escalationState(l.entries(), "auth_a", later)).toBe("approved");
    expect(escalationState(l.entries(), "auth_d", later)).toBe("denied");
  });
});

describe("T-LED-04 findRejection", () => {
  it("T-LED-04 findRejection: the most recent HUMAN_REJECTION for (session, resourceKey), whatever the amount or payee", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_1", { amount: "50000" });
    escalate(l, "auth_2", { amount: "60000", payTo: "0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd", at: T0 + 1 });
    rejectEntry(l, "auth_1", "rej_1", { at: T0 + 2 });
    rejectEntry(l, "auth_2", "rej_2", { at: T0 + 3 });
    expect(findRejection(l.entries(), "sess_a", KEY)?.data.rejectionId).toBe("rej_2");
  });

  it("T-LED-04 findRejection: none for another session or resource, and none from approvals or expiries", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_1");
    rejectEntry(l, "auth_1", "rej_1");
    expect(findRejection(l.entries(), "sess_b", KEY)).toBeUndefined();
    expect(findRejection(l.entries(), "sess_a", "http://127.0.0.1:4021/api/weather")).toBeUndefined();

    const l2 = new AuditLedger(join(dir, "other.jsonl"));
    escalate(l2, "auth_a");
    escalate(l2, "auth_e");
    approveEntry(l2, "auth_a", "apr_1");
    expireEntry(l2, "auth_e");
    expect(findRejection(l2.entries(), "sess_a", KEY)).toBeUndefined();
  });
});

describe("T-LED-04 findPendingEscalation", () => {
  const OTHER_PAYEE = "0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd";

  it("T-LED-04 findPendingEscalation: an exact purchase match; the payee comparison is case-insensitive", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_1");
    expect(findPendingEscalation(l.entries(), "sess_a", KEY, PAY_TO, "50000", T0 + 1)?.authorizationId).toBe("auth_1");
    expect(findPendingEscalation(l.entries(), "sess_a", KEY, PAY_TO.toLowerCase(), "50000", T0 + 1)?.authorizationId).toBe("auth_1");
  });

  it("T-LED-04 findPendingEscalation: a different amount string, payee, session or resource is a different purchase", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_1");
    const at = T0 + 1;
    expect(findPendingEscalation(l.entries(), "sess_a", KEY, PAY_TO, "50001", at)).toBeUndefined();
    expect(findPendingEscalation(l.entries(), "sess_a", KEY, OTHER_PAYEE, "50000", at)).toBeUndefined();
    expect(findPendingEscalation(l.entries(), "sess_b", KEY, PAY_TO, "50000", at)).toBeUndefined();
    expect(findPendingEscalation(l.entries(), "sess_a", "http://127.0.0.1:4021/api/weather", PAY_TO, "50000", at)).toBeUndefined();
  });

  it("T-LED-04 findPendingEscalation: approved, denied and expired (by entry or by clock) escalations are not pending", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_a", { sessionId: "s_a" });
    escalate(l, "auth_d", { sessionId: "s_d" });
    escalate(l, "auth_e", { sessionId: "s_e" });
    escalate(l, "auth_c", { sessionId: "s_c" });
    approveEntry(l, "auth_a", "apr_1");
    rejectEntry(l, "auth_d", "rej_1");
    expireEntry(l, "auth_e");
    const at = T0 + 10;
    for (const s of ["s_a", "s_d", "s_e"]) expect(findPendingEscalation(l.entries(), s, KEY, PAY_TO, "50000", at), s).toBeUndefined();
    expect(findPendingEscalation(l.entries(), "s_c", KEY, PAY_TO, "50000", at)?.authorizationId).toBe("auth_c");
    expect(findPendingEscalation(l.entries(), "s_c", KEY, PAY_TO, "50000", T0 + ESCALATION_TTL_MS)).toBeUndefined();
  });
});

describe("T-LED-04 sweep", () => {
  const ofType = (l: AuditLedger, type: string) => l.entries().filter((e) => e.type === type);

  it("T-LED-04 sweep: one ESCALATION_EXPIRED at createdMs + 300 000, none before, none twice", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_1", { at: T0 });
    expect(sweep(l, T0 + ESCALATION_TTL_MS - 1)).toEqual([]);
    const appended = sweep(l, T0 + ESCALATION_TTL_MS);
    expect(appended).toHaveLength(1);
    const [exp] = ofType(l, "ESCALATION_EXPIRED");
    expect(exp!.sessionId).toBe("sess_a");
    expect(exp!.authorizationId).toBe("auth_1");
    expect(exp!.data).toEqual({ escalationId: "auth_1", resourceKey: KEY, payTo: PAY_TO, amount: "50000", expiresAtMs: T0 + ESCALATION_TTL_MS });
    expect(exp!.ts).toBe(new Date(T0 + ESCALATION_TTL_MS).toISOString());
    expect(sweep(l, T0 + 2 * ESCALATION_TTL_MS)).toEqual([]);
    expect(ofType(l, "ESCALATION_EXPIRED")).toHaveLength(1);
  });

  it("T-LED-04 sweep: one APPROVAL_LAPSED after the approval's expiresAtMs when unused; none when consumed", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_u", { sessionId: "s_u" });
    escalate(l, "auth_c", { sessionId: "s_c" });
    const A = T0 + 1000;
    approveEntry(l, "auth_u", "apr_unused", { expiresAtMs: A });
    approveEntry(l, "auth_c", "apr_used", { expiresAtMs: A });
    l.append({ type: "AUTHORIZED", sessionId: "s_c", authorizationId: "auth_pay", data: { amount: "50000", approvalRef: "apr_used", validBefore: Math.floor(A / 1000) } }, T0 + 2);
    expect(sweep(l, A)).toEqual([]);
    sweep(l, A + 1);
    const lapsed = ofType(l, "APPROVAL_LAPSED");
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]!.authorizationId).toBe("auth_u");
    expect(lapsed[0]!.data).toEqual({ approvalId: "apr_unused", escalationId: "auth_u", resourceKey: KEY, payTo: PAY_TO, amount: "50000", expiresAtMs: A });
    sweep(l, A + 2);
    expect(ofType(l, "APPROVAL_LAPSED")).toHaveLength(1);
  });

  it("T-LED-04 sweep: a decided escalation never gets ESCALATION_EXPIRED", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_a");
    escalate(l, "auth_d", { sessionId: "s_d" });
    approveEntry(l, "auth_a", "apr_1", { expiresAtMs: T0 + 10 * ESCALATION_TTL_MS });
    rejectEntry(l, "auth_d", "rej_1");
    sweep(l, T0 + 2 * ESCALATION_TTL_MS);
    expect(ofType(l, "ESCALATION_EXPIRED")).toHaveLength(0);
  });

  it("T-LED-04 sweep: restart — a reloaded ledger expires escalations that came due while L2 was down; the chain verifies", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_1", { at: T0 });
    const reloaded = new AuditLedger(file);
    sweep(reloaded, T0 + 3 * ESCALATION_TTL_MS);
    expect(ofType(reloaded, "ESCALATION_EXPIRED")).toHaveLength(1);
    expect(reloaded.verifyChain().ok).toBe(true);
  });

  it("T-LED-04 must fail without the clock check: with no sweep at all, the state is already expired at 300 s", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_1", { at: T0 });
    expect(ofType(l, "ESCALATION_EXPIRED")).toHaveLength(0);
    expect(escalationState(l.entries(), "auth_1", T0 + ESCALATION_TTL_MS)).toBe("expired");
  });
});

describe("T-LED-04 operator views", () => {
  const FORBIDDEN = ["accepts", "purpose", "paymentHeaders", "signature", "token"];
  const keysDeep = (v: unknown): string[] =>
    v !== null && typeof v === "object" ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...keysDeep(x)]) : [];

  it("T-LED-04 pendingEscalations: only pending, sorted by createdAt, exactly the view fields", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_late", { sessionId: "s_1", at: T0 + 20 });
    escalate(l, "auth_early", { sessionId: "s_2", at: T0 + 10 });
    escalate(l, "auth_done", { sessionId: "s_3", at: T0 + 5 });
    rejectEntry(l, "auth_done", "rej_1", { at: T0 + 30 });
    const views = pendingEscalations(l.entries(), T0 + 40);
    expect(views.map((v) => v.authorizationId)).toEqual(["auth_early", "auth_late"]);
    expect(views[0]).toEqual({
      authorizationId: "auth_early",
      sessionId: "s_2",
      resourceKey: KEY,
      payTo: PAY_TO,
      amount: "50000",
      createdAt: new Date(T0 + 10).toISOString(),
      expiresAt: new Date(T0 + 10 + ESCALATION_TTL_MS).toISOString(),
      referenceCode: referenceCode("auth_early"), // 012: additive (FR-029)
    });
    expect(pendingEscalations(l.entries(), T0 + 20 + ESCALATION_TTL_MS)).toEqual([]);
  });

  it("T-LED-04 escalationEvents: one event per lifecycle entry with the per-kind fields; after filters by seq", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_a", { sessionId: "s_a" });
    escalate(l, "auth_d", { sessionId: "s_d" });
    escalate(l, "auth_e", { sessionId: "s_e" });
    approveEntry(l, "auth_a", "apr_1", { expiresAtMs: T0 + 1000 });
    l.append({ type: "HUMAN_REJECTION", sessionId: "s_d", authorizationId: "auth_d", data: { rejectionId: "rej_1", escalationId: "auth_d", resourceKey: KEY, payTo: PAY_TO, amount: "50000", operator: "alice", reason: "too expensive" } }, T0 + 2);
    expireEntry(l, "auth_e");
    sweep(l, T0 + ESCALATION_TTL_MS + 1); // lapses apr_1
    const events = escalationEvents(l.entries(), -1);
    expect(events.map((e) => e.kind)).toEqual(["escalated", "escalated", "escalated", "approved", "denied", "expired", "approval_lapsed"]);
    const byKind = Object.fromEntries(["escalated", "approved", "denied", "expired", "approval_lapsed"].map((k) => [k, events.find((e) => e.kind === k)])); // first of each kind
    expect(byKind.escalated).toMatchObject({ authorizationId: "auth_a", sessionId: "s_a", resourceKey: KEY, payTo: PAY_TO, amount: "50000", expiresAt: new Date(T0 + ESCALATION_TTL_MS).toISOString() });
    expect(byKind.approved).toMatchObject({ authorizationId: "auth_a", approvalId: "apr_1", approver: "operator", approvalExpiresAt: new Date(T0 + 1000).toISOString() });
    expect(byKind.denied).toMatchObject({ authorizationId: "auth_d", rejectionId: "rej_1", operator: "alice", reason: "too expensive" });
    expect(byKind.expired).toMatchObject({ authorizationId: "auth_e", expiresAt: new Date(T0 + ESCALATION_TTL_MS).toISOString() });
    expect(byKind.approval_lapsed).toMatchObject({ authorizationId: "auth_a", approvalId: "apr_1" });
    for (const e of events) expect(e.at).toBe(l.entries()[e.seq]!.ts);
    const cut = events[3]!.seq;
    expect(escalationEvents(l.entries(), cut).map((e) => e.kind)).toEqual(["denied", "expired", "approval_lapsed"]);
  });

  it("T-LED-04 escalationEvents: ESCALATION_REPEATED, INTENT, AUTHORIZED, DENIED and SETTLEMENT produce no event; no secret-bearing keys (NFR-007)", () => {
    const l = new AuditLedger(file);
    l.append({ type: "INTENT", sessionId: "sess_a", intentId: "int_1", data: { resourceUrl: KEY, purpose: "secret plan", accepts: [{ amount: "50000" }] } }, T0);
    escalate(l, "auth_1");
    l.append({ type: "ESCALATION_REPEATED", sessionId: "sess_a", intentId: "int_2", authorizationId: "auth_1", data: { escalationId: "auth_1", resourceKey: KEY, payTo: PAY_TO, amount: "50000", violations: [] } }, T0 + 1);
    l.append({ type: "AUTHORIZED", sessionId: "sess_a", authorizationId: "auth_p", data: { amount: "1000", approvalRef: null, validBefore: 1 } }, T0 + 2);
    l.append({ type: "DENIED", sessionId: "sess_a", authorizationId: "auth_x", data: { violations: [], resourceKey: KEY } }, T0 + 3);
    l.append({ type: "SETTLEMENT", sessionId: "sess_a", authorizationId: "auth_p", data: { status: "CONFIRMED", anomaly: false } }, T0 + 4);
    const events = escalationEvents(l.entries(), -1);
    expect(events.map((e) => e.kind)).toEqual(["escalated"]);
    for (const e of events) expect(keysDeep(e).filter((k) => FORBIDDEN.includes(k))).toEqual([]);
  });
});

describe("T-LED-04 012 whitelist for the approval request entries", () => {
  const FORBIDDEN_012 = ["accepts", "purpose", "paymentHeaders", "signature", "token", "handleSealed", "details", "bindingMessage", "evidence", "issuer", "access_token", "auth_req_id"];
  const keysDeep = (v: unknown): string[] =>
    v !== null && typeof v === "object" ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...keysDeep(x)]) : [];

  it("no event or view of the new kinds carries a secret-bearing or payload key", () => {
    const l = new AuditLedger(file);
    const base = { resourceKey: KEY, payTo: PAY_TO, amount: "50000", channel: "backchannel" };
    const esc = (id: string, at: number) =>
      l.append({ type: "ESCALATED", sessionId: "sess_w", authorizationId: id, data: { violations: [], resourceKey: KEY, payTo: PAY_TO, amount: "50000", approvalRequest: "requested" } }, at);
    const requested = (id: string, at: number) =>
      l.append(
        {
          type: "APPROVAL_REQUESTED",
          sessionId: "sess_w",
          authorizationId: id,
          data: { escalationId: id, ...base, requestId: `apq_${id}`, issuer: "https://t/", approver: "auth0|a", referenceCode: "abcd1234", bindingMessage: "Pay_x", details: [{ x: 1 }], requestedExpirySec: 300, requestExpiresAtMs: at + 300_000, intervalSec: 5, handleSealed: "v1.a.b.c", attempts: 1 },
        },
        at,
      );
    esc("auth_w1", T0);
    requested("auth_w1", T0 + 1);
    l.append({ type: "HUMAN_APPROVAL", sessionId: "sess_w", authorizationId: "auth_w1", data: { approvalId: "apr_w", escalationId: "auth_w1", ...base, approver: "auth0|a", expiresAtMs: T0 + 600_000, requestId: "apq_auth_w1", evidence: { issuer: "https://t/", subject: "auth0|a", answerId: "jti", issuedAt: "x", detailsSource: "token" } } }, T0 + 2);
    esc("auth_w2", T0 + 3);
    requested("auth_w2", T0 + 4);
    l.append({ type: "HUMAN_REJECTION", sessionId: "sess_w", authorizationId: "auth_w2", data: { rejectionId: "rej_w", escalationId: "auth_w2", ...base, approver: "auth0|a", issuer: "https://t/", requestId: "apq_auth_w2" } }, T0 + 5);
    esc("auth_w3", T0 + 6);
    l.append({ type: "APPROVAL_REQUEST_FAILED", sessionId: "sess_w", authorizationId: "auth_w3", data: { escalationId: "auth_w3", ...base, phase: "start", failure: "permanent", httpStatus: 400, error: "unknown_user_id", attempts: 1 } }, T0 + 7);
    esc("auth_w4", T0 + 8);
    requested("auth_w4", T0 + 9);
    l.append({ type: "APPROVAL_VERIFICATION_FAILED", sessionId: "sess_w", authorizationId: "auth_w4", data: { escalationId: "auth_w4", ...base, requestId: "apq_auth_w4", check: "details" } }, T0 + 10);
    esc("auth_w5", T0 + 11);
    requested("auth_w5", T0 + 12);
    l.append({ type: "APPROVAL_REQUEST_LAPSED", sessionId: "sess_w", authorizationId: "auth_w5", data: { escalationId: "auth_w5", ...base, requestId: "apq_auth_w5", cause: "expired", requestExpiresAtMs: T0 + 300_000 } }, T0 + 13);

    const events = escalationEvents(l.entries(), -1);
    expect(new Set(events.map((e) => e.kind))).toEqual(
      new Set(["escalated", "approval_requested", "approved", "denied", "approval_request_failed", "approval_verification_failed", "approval_request_lapsed"]),
    );
    for (const e of events) expect(keysDeep(e).filter((k) => FORBIDDEN_012.includes(k)), e.kind).toEqual([]);
    const views = pendingEscalations(l.entries(), T0 + 20);
    expect(views.map((v) => v.approvalRequest)).toEqual(["failed", "verification_failed", "lapsed"]);
    for (const v of views) expect(keysDeep(v).filter((k) => FORBIDDEN_012.includes(k))).toEqual([]);
    const denied = events.find((e) => e.kind === "denied")!;
    expect(denied).toMatchObject({ channel: "backchannel", decidedBy: "auth0|a" });
    expect(denied.operator).toBeUndefined();
  });
});

describe("012 approval request derivations", () => {
  const mark = (l: AuditLedger, id: string, approvalRequest: string, at = T0) => {
    const e = escalate(l, id, { at, sessionId: `sess_${id}` });
    // Re-append with the mark: the helper writes the 010 shape, so write the 012 shape directly here.
    return { e, marked: l.append({ type: "ESCALATED", sessionId: `sess_${id}m`, authorizationId: `${id}m`, data: { ...e.data, approvalRequest } }, at) };
  };
  const requested = (l: AuditLedger, id: string, at = T0, expiresIn = 300_000) => {
    l.append({ type: "ESCALATED", sessionId: "sess_r", authorizationId: id, data: { violations: [], resourceKey: KEY, payTo: PAY_TO, amount: "50000", approvalRequest: "requested" } }, at);
    return (requestId = `apq_${id}`) =>
      l.append(
        {
          type: "APPROVAL_REQUESTED",
          sessionId: "sess_r",
          authorizationId: id,
          data: { escalationId: id, resourceKey: KEY, payTo: PAY_TO, amount: "50000", channel: "backchannel", requestId, requestExpiresAtMs: at + expiresIn, handleSealed: "v1.a.b.c" },
        },
        at + 10,
      );
  };
  const end = (l: AuditLedger, id: string, type: "APPROVAL_REQUEST_FAILED" | "APPROVAL_REQUEST_LAPSED" | "APPROVAL_VERIFICATION_FAILED", at = T0 + 20) =>
    l.append({ type, sessionId: "sess_r", authorizationId: id, data: { escalationId: id, requestId: `apq_${id}`, channel: "backchannel" } }, at);

  it("referenceCode and channelOf (an entry without channel reads as operator)", () => {
    expect(referenceCode("auth_3f9c2a1b-7d4e-4a51-9c0e-2b8f6d1e9a77")).toBe("3f9c2a1b");
    const l = new AuditLedger(file);
    escalate(l, "auth_a");
    expect(channelOf(approveEntry(l, "auth_a", "apr_1"))).toBe("operator");
  });

  it("approvalRequestState: unmarked, each mark, requested, answered, failed, lapsed, verification_failed, abandoned", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_plain");
    expect(approvalRequestState(l.entries(), "auth_plain")).toBeUndefined();
    for (const m of ["capped", "operator_only", "reevaluation"]) {
      const { marked } = mark(l, `auth_${m}`, m);
      expect(approvalRequestState(l.entries(), marked.authorizationId!)).toBe(m);
    }
    requested(l, "auth_r1")();
    expect(approvalRequestState(l.entries(), "auth_r1")).toBe("requested");
    requested(l, "auth_r0");
    expect(approvalRequestState(l.entries(), "auth_r0")).toBe("requested");
    requested(l, "auth_f")();
    end(l, "auth_f", "APPROVAL_REQUEST_FAILED");
    expect(approvalRequestState(l.entries(), "auth_f")).toBe("failed");
    requested(l, "auth_l")();
    end(l, "auth_l", "APPROVAL_REQUEST_LAPSED");
    expect(approvalRequestState(l.entries(), "auth_l")).toBe("lapsed");
    requested(l, "auth_v")();
    end(l, "auth_v", "APPROVAL_VERIFICATION_FAILED");
    expect(approvalRequestState(l.entries(), "auth_v")).toBe("verification_failed");
    requested(l, "auth_ab")();
    approveEntry(l, "auth_ab", "apr_ab");
    expect(approvalRequestState(l.entries(), "auth_ab")).toBe("abandoned");
    requested(l, "auth_ans")();
    l.append({ type: "HUMAN_APPROVAL", sessionId: "sess_r", authorizationId: "auth_ans", data: { approvalId: "apr_b", escalationId: "auth_ans", resourceKey: KEY, payTo: PAY_TO, amount: "50000", approver: "auth0|x", expiresAtMs: T0 + 600_000, channel: "backchannel", evidence: { answerId: "jti-9" } } }, T0 + 30);
    expect(approvalRequestState(l.entries(), "auth_ans")).toBe("answered");
    expect(answerIdUsed(l.entries(), "jti-9")).toBe(true);
    expect(answerIdUsed(l.entries(), "jti-8")).toBe(false);
  });

  it("approvalRequestCount counts `requested` marks in the trailing hour; exactly 3 600 000 ms later the first drops out", () => {
    const l = new AuditLedger(file);
    requested(l, "auth_1", T0);
    requested(l, "auth_2", T0 + 1000);
    mark(l, "auth_c", "capped", T0 + 2000);
    expect(approvalRequestCount(l.entries(), T0 + 5000)).toBe(2);
    expect(approvalRequestCount(l.entries(), T0 + 3_600_000 - 1)).toBe(2);
    expect(approvalRequestCount(l.entries(), T0 + 3_600_000)).toBe(1);
    expect(approvalRequestCount(l.entries(), T0 + 3_601_000)).toBe(0);
  });

  it("openApprovalRequest needs a pending escalation, no ending entry and the request's own expiry ahead", () => {
    const l = new AuditLedger(file);
    requested(l, "auth_o", T0, 100_000)();
    expect(openApprovalRequest(l.entries(), "auth_o", T0 + 50_000)?.data.requestId).toBe("apq_auth_o");
    expect(openApprovalRequest(l.entries(), "auth_o", T0 + 100_000)).toBeUndefined();
    expect(activeApprovalRequest(l.entries(), "auth_o")).toBeDefined();
    expect(openApprovalRequest(l.entries(), "auth_o", T0 + ESCALATION_TTL_MS)).toBeUndefined();
    end(l, "auth_o", "APPROVAL_REQUEST_LAPSED");
    expect(activeApprovalRequest(l.entries(), "auth_o")).toBeUndefined();
  });

  it("requestsToResume: open, stale and interrupted; never a decided or expired escalation", () => {
    const l = new AuditLedger(file);
    requested(l, "auth_open", T0)();
    requested(l, "auth_stale", T0, 60_000)();
    requested(l, "auth_int", T0);
    requested(l, "auth_done", T0)();
    approveEntry(l, "auth_done", "apr_d");
    requested(l, "auth_failed", T0);
    end(l, "auth_failed", "APPROVAL_REQUEST_FAILED");
    const r = requestsToResume(l.entries(), T0 + 120_000);
    expect(r.open.map((e) => e.data.escalationId)).toEqual(["auth_open"]);
    expect(r.stale.map((e) => e.data.escalationId)).toEqual(["auth_stale"]);
    expect(r.interrupted.map((e) => e.authorizationId)).toEqual(["auth_int"]);
    expect(requestsToResume(l.entries(), T0 + ESCALATION_TTL_MS)).toEqual({ open: [], stale: [], interrupted: [] });
  });
});

// 014 (SPEC v1.14 L2-4, L2-4.3): a decision can also come from the portal. Same entry types, a third channel.
describe("T-LED-07 the portal channel in the derivations (014)", () => {
  const ADMIN = "usr_0123456789abcdef0123456789abcdef";
  const portalApproval = (l: AuditLedger, id: string, at = T0 + 1) =>
    l.append(
      {
        type: "HUMAN_APPROVAL",
        sessionId: "sess_a",
        authorizationId: id,
        data: { approvalId: `apr_${id}`, escalationId: id, resourceKey: KEY, payTo: PAY_TO, amount: "50000", expiresAtMs: at + 600_000, channel: "portal", approver: ADMIN, identityConfirmedAtMs: at - 1_000 },
      },
      at,
    );
  const portalRejection = (l: AuditLedger, id: string, reasonCode: unknown = "amount_too_high", at = T0 + 1) =>
    l.append(
      {
        type: "HUMAN_REJECTION",
        sessionId: "sess_a",
        authorizationId: id,
        data: { rejectionId: `rej_${id}`, escalationId: id, resourceKey: KEY, payTo: PAY_TO, amount: "50000", channel: "portal", approver: ADMIN, reasonCode },
      },
      at,
    );

  it("T-LED-07 channelOf: portal, backchannel, operator, and operator for an entry with no channel", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_p");
    escalate(l, "auth_o");
    expect(channelOf(portalApproval(l, "auth_p"))).toBe("portal");
    expect(channelOf(approveEntry(l, "auth_o", "apr_o"))).toBe("operator");
    const back = l.append({ type: "HUMAN_REJECTION", sessionId: "sess_a", authorizationId: "auth_b", data: { rejectionId: "rej_b", escalationId: "auth_b", channel: "backchannel", approver: "auth0|x" } }, T0 + 2);
    expect(channelOf(back)).toBe("backchannel");
    const unknown = l.append({ type: "HUMAN_REJECTION", sessionId: "sess_a", authorizationId: "auth_u", data: { rejectionId: "rej_u", escalationId: "auth_u", channel: "something-else", operator: "x" } }, T0 + 3);
    expect(channelOf(unknown)).toBe("operator");
  });

  it("T-LED-07 the state machine needs no new case: a portal decision is final like any other", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_a");
    escalate(l, "auth_d");
    portalApproval(l, "auth_a");
    portalRejection(l, "auth_d");
    expect(escalationState(l.entries(), "auth_a", T0 + ESCALATION_TTL_MS + 1)).toBe("approved");
    expect(escalationState(l.entries(), "auth_d", T0 + ESCALATION_TTL_MS + 1)).toBe("denied");
    expect(pendingEscalations(l.entries(), T0 + 5)).toEqual([]);
    expect(findRejection(l.entries(), "sess_a", KEY)?.data.rejectionId).toBe("rej_auth_d");
  });

  it("T-LED-07 escalationEvents: a portal approval names the channel and the decider's identifier", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_a");
    portalApproval(l, "auth_a");
    const ev = escalationEvents(l.entries(), -1).find((e) => e.kind === "approved")!;
    expect(ev).toMatchObject({ channel: "portal", decidedBy: ADMIN, approvalId: "apr_auth_a", approver: ADMIN });
  });

  it("T-LED-07 escalationEvents: a portal rejection has its reason code and the identifier, and no operator label or free text", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_d");
    portalRejection(l, "auth_d");
    const ev = escalationEvents(l.entries(), -1).find((e) => e.kind === "denied")!;
    expect(ev).toMatchObject({ channel: "portal", decidedBy: ADMIN, rejectionId: "rej_auth_d", reasonCode: "amount_too_high" });
    expect(Object.keys(ev)).not.toContain("operator");
    expect(Object.keys(ev)).not.toContain("reason");
  });

  it("T-LED-07 escalationEvents: a reason code outside the fixed list never reaches a view; an operator rejection has none", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_x");
    escalate(l, "auth_o");
    portalRejection(l, "auth_x", "<b>free text</b>");
    rejectEntry(l, "auth_o", "rej_o");
    const events = escalationEvents(l.entries(), -1).filter((e) => e.kind === "denied");
    expect(events.map((e) => "reasonCode" in e)).toEqual([false, false]);
    expect(events[1]).toMatchObject({ channel: "operator", decidedBy: "operator", operator: "operator" });
  });

  it("T-LED-07 approvalRequestState: a portal decision while the phone request is open leaves it abandoned", () => {
    const l = new AuditLedger(file);
    for (const id of ["auth_r1", "auth_r2"]) {
      l.append({ type: "ESCALATED", sessionId: "sess_a", authorizationId: id, data: { violations: [], resourceKey: KEY, payTo: PAY_TO, amount: "50000", approvalRequest: "requested" } }, T0);
      l.append(
        { type: "APPROVAL_REQUESTED", sessionId: "sess_a", authorizationId: id, data: { escalationId: id, resourceKey: KEY, payTo: PAY_TO, amount: "50000", channel: "backchannel", requestId: `apq_${id}`, requestExpiresAtMs: T0 + 300_000, handleSealed: "v1.a.b.c" } },
        T0 + 10,
      );
    }
    portalApproval(l, "auth_r1", T0 + 20);
    portalRejection(l, "auth_r2", "duplicate", T0 + 20);
    expect(approvalRequestState(l.entries(), "auth_r1")).toBe("abandoned");
    expect(approvalRequestState(l.entries(), "auth_r2")).toBe("abandoned");
    expect(openApprovalRequest(l.entries(), "auth_r1", T0 + 30)).toBeUndefined();
  });

  it("T-LED-07 no view carries a secret-bearing or internal key", () => {
    const l = new AuditLedger(file);
    escalate(l, "auth_a");
    escalate(l, "auth_d");
    escalate(l, "auth_p");
    portalApproval(l, "auth_a");
    portalRejection(l, "auth_d");
    const text = JSON.stringify([escalationEvents(l.entries(), -1), pendingEscalations(l.entries(), T0 + 5)]);
    for (const key of ["identityConfirmedAtMs", "purpose", "accepts", "details", "bindingMessage", "handleSealed", "evidence"]) {
      expect(text, key).not.toContain(`"${key}"`);
    }
  });
});

// 014 (FR-019): the operator's two decision routes are pinned here before their logic moves into a shared core
// (research R4). Every body and every recorded field must be what it was in v1.10.
describe("014 the operator's decisions are unchanged (FR-019)", () => {
  const OPERATOR = "pin-operator-token";
  let now = T0;

  async function startOperatorRoutes(l: AuditLedger) {
    const { default: express } = await import("express");
    const { mountApprovalRoutes } = await import("../src/layer2-control/approval-routes.js");
    const { createSerializer } = await import("../src/layer2-control/service.js");
    const app = express();
    mountApprovalRoutes(app, { ledger: l, serialize: createSerializer(), now: () => now, tokens: { operator: OPERATOR } });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = async (path: string, body?: unknown, token = OPERATOR) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  beforeEach(() => {
    now = T0 + 1_000;
  });

  it("014 operator approval: the entry's data, and every answer by state", async () => {
    const l = new AuditLedger(file);
    for (const id of ["auth_p", "auth_d", "auth_e"]) escalate(l, id);
    rejectEntry(l, "auth_d", "rej_d");
    const s = await startOperatorRoutes(l);
    try {
      expect(await s.call("/v1/approvals/auth_p", {}, "wrong")).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect(await s.call("/v1/approvals/auth_p", { ttlSeconds: 0 })).toEqual({ status: 400, body: { error: "ttlSeconds must be a positive integer" } });
      expect(await s.call("/v1/approvals/auth_none")).toEqual({ status: 404, body: { error: "not found" } });
      const before = l.entries().length;

      const first = await s.call("/v1/approvals/auth_p", { approver: "ops-jane", ttlSeconds: 120 });
      expect(first.status).toBe(200);
      const approvalId = first.body.approvalId as string;
      expect(approvalId.replace(/^apr_/, "")).toMatch(UUID);
      expect(first.body).toEqual({ ok: true, approvalId, expiresAt: iso(now + 120_000) });
      const entry = l.entries().at(-1)!;
      expect(l.entries()).toHaveLength(before + 1);
      expect({ type: entry.type, sessionId: entry.sessionId, authorizationId: entry.authorizationId, ts: entry.ts, data: entry.data }).toEqual({
        type: "HUMAN_APPROVAL",
        sessionId: "sess_a",
        authorizationId: "auth_p",
        ts: iso(now),
        data: { approvalId, escalationId: "auth_p", resourceKey: KEY, payTo: PAY_TO, amount: "50000", approver: "ops-jane", expiresAtMs: now + 120_000, channel: "operator" },
      });

      // A repeat returns the first approval; its own ttl and approver are ignored and nothing is appended.
      expect(await s.call("/v1/approvals/auth_p", { approver: "someone-else", ttlSeconds: 5 })).toEqual({
        status: 200,
        body: { ok: true, approvalId, expiresAt: iso(now + 120_000), alreadyApproved: true },
      });
      expect(await s.call("/v1/approvals/auth_d")).toEqual({ status: 409, body: { error: "escalation is denied", state: "denied", rejectionId: "rej_d" } });
      now = T0 + ESCALATION_TTL_MS;
      expect(await s.call("/v1/approvals/auth_e")).toEqual({
        status: 409,
        body: { error: "escalation is expired", state: "expired", expiresAt: iso(T0 + ESCALATION_TTL_MS) },
      });
      // The sweep ran inside the section: the expiry is recorded, and no approval was.
      expect(l.entries().filter((e) => e.type === "HUMAN_APPROVAL")).toHaveLength(1);
      expect(l.entries().some((e) => e.type === "ESCALATION_EXPIRED" && e.data.escalationId === "auth_e")).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("014 operator rejection: the entry's data, and every answer by state", async () => {
    const l = new AuditLedger(file);
    for (const id of ["auth_p", "auth_q", "auth_a", "auth_e"]) escalate(l, id);
    approveEntry(l, "auth_a", "apr_a");
    const s = await startOperatorRoutes(l);
    try {
      expect(await s.call("/v1/rejections/auth_p", {}, "wrong")).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect((await s.call("/v1/rejections/auth_p", { operator: "" })).status).toBe(400);
      expect((await s.call("/v1/rejections/auth_p", { reason: "x".repeat(281) })).status).toBe(400);
      expect(await s.call("/v1/rejections/auth_none")).toEqual({ status: 404, body: { error: "not found" } });

      const first = await s.call("/v1/rejections/auth_p", { operator: "ops-jane", reason: "not expected" });
      const rejectionId = first.body.rejectionId as string;
      expect(rejectionId.replace(/^rej_/, "")).toMatch(UUID);
      expect(first).toEqual({ status: 200, body: { ok: true, rejectionId, rejectedAt: iso(now), alreadyRejected: false } });
      const entry = l.entries().at(-1)!;
      expect({ type: entry.type, sessionId: entry.sessionId, authorizationId: entry.authorizationId, data: entry.data }).toEqual({
        type: "HUMAN_REJECTION",
        sessionId: "sess_a",
        authorizationId: "auth_p",
        data: { rejectionId, escalationId: "auth_p", resourceKey: KEY, payTo: PAY_TO, amount: "50000", operator: "ops-jane", reason: "not expected", channel: "operator" },
      });

      // Without a label or a reason: the default label, and no `reason` key at all.
      const plain = await s.call("/v1/rejections/auth_q");
      expect(l.entries().at(-1)!.data).toEqual({
        rejectionId: plain.body.rejectionId,
        escalationId: "auth_q",
        resourceKey: KEY,
        payTo: PAY_TO,
        amount: "50000",
        operator: "operator",
        channel: "operator",
      });

      expect(await s.call("/v1/rejections/auth_p", { reason: "again" })).toEqual({
        status: 200,
        body: { ok: true, rejectionId, rejectedAt: iso(now), alreadyRejected: true },
      });
      expect(await s.call("/v1/rejections/auth_a")).toEqual({ status: 409, body: { error: "escalation is approved", state: "approved", approvalId: "apr_a" } });
      now = T0 + ESCALATION_TTL_MS;
      expect(await s.call("/v1/rejections/auth_e")).toEqual({
        status: 409,
        body: { error: "escalation is expired", state: "expired", expiresAt: iso(T0 + ESCALATION_TTL_MS) },
      });
      expect(l.entries().filter((e) => e.type === "HUMAN_REJECTION")).toHaveLength(2);
    } finally {
      await s.close();
    }
  });
});
