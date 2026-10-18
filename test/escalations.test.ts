// Feature 010 — escalation lifecycle derivations and sweep (SPEC.md §8.2 L2-4.3; T-LED-04).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLedger } from "../src/layer2-control/ledger.js";
import { ESCALATION_TTL_MS, escalationEvents, escalationState, findPendingEscalation, findRejection, pendingEscalations, sweep } from "../src/layer2-control/escalations.js";

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
