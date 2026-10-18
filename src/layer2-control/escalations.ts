// Escalation lifecycle (SPEC.md §8.2 L2-4.3). Owner: feature 010.
// Pure derivations over ledger entries; only `sweep` writes. Never reads the clock: every function
// that needs time takes `nowMs` (INV-5, NFR-007 of 003). An escalation is created by its ESCALATED
// entry and ends exactly once: approved (HUMAN_APPROVAL), denied (HUMAN_REJECTION) or expired
// (ESCALATION_EXPIRED, or the clock passing createdMs + ESCALATION_TTL_MS). Final states are never left.
import type { AuditLedger, LedgerEntry } from "./ledger.js";

/** Fixed escalation window (clarification Q3). Not configurable. */
export const ESCALATION_TTL_MS = 300_000;
/** Operator free-text limits (NFR-006). */
export const REASON_MAX = 280;
export const OPERATOR_LABEL_MAX = 64;

export type EscalationState = "not_found" | "pending" | "approved" | "denied" | "expired";

type Entries = readonly LedgerEntry[];

/** The ESCALATED entry that created the escalation. */
export function findEscalation(entries: Entries, escalationId: string): LedgerEntry | undefined {
  return entries.find((e) => e.type === "ESCALATED" && e.authorizationId === escalationId);
}

export function expiresAtMsOf(escalated: LedgerEntry): number {
  return Date.parse(escalated.ts) + ESCALATION_TTL_MS;
}

const decides = (e: LedgerEntry, escalationId: string, type: LedgerEntry["type"]) =>
  e.type === type && e.data.escalationId === escalationId;

/** The first final-state entry for the escalation (HUMAN_APPROVAL, HUMAN_REJECTION or ESCALATION_EXPIRED). */
export function decisionEntry(entries: Entries, escalationId: string): LedgerEntry | undefined {
  return entries.find(
    (e) =>
      decides(e, escalationId, "HUMAN_APPROVAL") ||
      decides(e, escalationId, "HUMAN_REJECTION") ||
      decides(e, escalationId, "ESCALATION_EXPIRED"),
  );
}

/** The most recent HUMAN_REJECTION for (session, resourceKey), whatever the amount or payee (R15 scope). */
export function findRejection(entries: Entries, sessionId: string, resourceKey: string): LedgerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "HUMAN_REJECTION" && e.sessionId === sessionId && e.data.resourceKey === resourceKey) return e;
  }
  return undefined;
}

/**
 * FR-005: the pending escalation for one purchase (session, resourceKey, payee case-insensitive, exact
 * amount string), if any. At most one exists, because a repeat while pending reuses it.
 */
export function findPendingEscalation(
  entries: Entries,
  sessionId: string,
  resourceKey: string,
  payTo: string,
  amount: string,
  nowMs: number,
): LedgerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "ESCALATED" || e.sessionId !== sessionId || e.data.resourceKey !== resourceKey) continue;
    if (String(e.data.payTo).toLowerCase() !== payTo.toLowerCase() || e.data.amount !== amount) continue;
    if (e.authorizationId !== undefined && escalationState(entries, e.authorizationId, nowMs) === "pending") return e;
  }
  return undefined;
}

/** L2-4.3 state, in order: not_found, approved, denied, expired (entry or clock), pending. */
export function escalationState(entries: Entries, escalationId: string, nowMs: number): EscalationState {
  const escalated = findEscalation(entries, escalationId);
  if (!escalated) return "not_found";
  if (entries.some((e) => decides(e, escalationId, "HUMAN_APPROVAL"))) return "approved";
  if (entries.some((e) => decides(e, escalationId, "HUMAN_REJECTION"))) return "denied";
  if (entries.some((e) => decides(e, escalationId, "ESCALATION_EXPIRED"))) return "expired";
  if (nowMs >= expiresAtMsOf(escalated)) return "expired";
  return "pending";
}

/**
 * The only writer (L2-4.3). Appends, at `nowMs`:
 * - one ESCALATION_EXPIRED for each escalation that is expired by the clock with no final-state entry;
 * - one APPROVAL_LAPSED for each approval past its expiresAtMs that no AUTHORIZED consumed and that has
 *   no APPROVAL_LAPSED yet.
 * Idempotent. The caller holds the L2 mutex (INV-8). Returns the appended entries.
 */
export function sweep(ledger: AuditLedger, nowMs: number): LedgerEntry[] {
  const entries = ledger.entries();
  const appended: LedgerEntry[] = [];
  // One pass for the lookups, so the 1 s sweep stays linear in the ledger size.
  const decided = decidedIds(entries);
  const consumed = new Set<string>();
  const lapsed = new Set<string>();
  for (const e of entries) {
    if (e.type === "AUTHORIZED" && typeof e.data.approvalRef === "string") consumed.add(e.data.approvalRef);
    if (e.type === "APPROVAL_LAPSED") lapsed.add(e.data.approvalId as string);
  }
  const due = entries.filter(
    (e) => e.type === "ESCALATED" && e.authorizationId !== undefined && !decided.has(e.authorizationId) && nowMs >= expiresAtMsOf(e),
  );
  const approvals = entries.filter(
    (e) =>
      e.type === "HUMAN_APPROVAL" &&
      nowMs > (e.data.expiresAtMs as number) &&
      !consumed.has(e.data.approvalId as string) &&
      !lapsed.has(e.data.approvalId as string),
  );
  for (const esc of due) {
    const id = esc.authorizationId!;
    appended.push(
      ledger.append(
        {
          type: "ESCALATION_EXPIRED",
          ...(esc.sessionId !== undefined && { sessionId: esc.sessionId }),
          authorizationId: id,
          data: { escalationId: id, resourceKey: esc.data.resourceKey, payTo: esc.data.payTo, amount: esc.data.amount, expiresAtMs: expiresAtMsOf(esc) },
        },
        nowMs,
      ),
    );
  }
  for (const a of approvals) {
    appended.push(
      ledger.append(
        {
          type: "APPROVAL_LAPSED",
          ...(a.sessionId !== undefined && { sessionId: a.sessionId }),
          authorizationId: a.data.escalationId as string,
          data: {
            approvalId: a.data.approvalId,
            escalationId: a.data.escalationId,
            resourceKey: a.data.resourceKey,
            payTo: a.data.payTo,
            amount: a.data.amount,
            expiresAtMs: a.data.expiresAtMs,
          },
        },
        nowMs,
      ),
    );
  }
  return appended;
}

/** One pending escalation as the operator sees it (GET /v1/escalations). */
export interface EscalationView {
  authorizationId: string;
  sessionId: string;
  resourceKey: string;
  payTo: string;
  amount: string;
  createdAt: string;
  expiresAt: string;
}

export type EscalationEventKind = "escalated" | "approved" | "denied" | "expired" | "approval_lapsed";

/**
 * One lifecycle event (GET /v1/escalations/events). Built field by field from a whitelist, never by
 * spreading entry data, so no token, payment header, `accepts` or `purpose` can leak (NFR-007).
 */
export interface EscalationEvent {
  seq: number;
  at: string;
  kind: EscalationEventKind;
  authorizationId: string;
  sessionId: string;
  resourceKey: string;
  payTo: string;
  amount: string;
  expiresAt?: string;
  approvalId?: string;
  approver?: string;
  approvalExpiresAt?: string;
  rejectionId?: string;
  operator?: string;
  reason?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** IDs of escalations with a final-state entry (one pass, so the 1 s reads stay linear). */
function decidedIds(entries: Entries): Set<string> {
  const decided = new Set<string>();
  for (const e of entries) {
    if (e.type === "HUMAN_APPROVAL" || e.type === "HUMAN_REJECTION" || e.type === "ESCALATION_EXPIRED") {
      decided.add(e.data.escalationId as string);
    }
  }
  return decided;
}

/** Pending escalations at `nowMs`, oldest first. */
export function pendingEscalations(entries: Entries, nowMs: number): EscalationView[] {
  const decided = decidedIds(entries);
  return entries
    .filter((e) => e.type === "ESCALATED" && e.authorizationId !== undefined && !decided.has(e.authorizationId) && nowMs < expiresAtMsOf(e))
    .map((e) => ({
      authorizationId: e.authorizationId!,
      sessionId: String(e.sessionId ?? ""),
      resourceKey: String(e.data.resourceKey),
      payTo: String(e.data.payTo),
      amount: String(e.data.amount),
      createdAt: e.ts,
      expiresAt: iso(expiresAtMsOf(e)),
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

const KIND: Partial<Record<LedgerEntry["type"], EscalationEventKind>> = {
  ESCALATED: "escalated",
  HUMAN_APPROVAL: "approved",
  HUMAN_REJECTION: "denied",
  ESCALATION_EXPIRED: "expired",
  APPROVAL_LAPSED: "approval_lapsed",
};

/** Lifecycle events with `seq > after`, in ledger order. ESCALATION_REPEATED produces none. */
export function escalationEvents(entries: Entries, after: number): EscalationEvent[] {
  const events: EscalationEvent[] = [];
  for (const e of entries) {
    if (e.seq <= after) continue;
    const kind = KIND[e.type];
    if (kind === undefined) continue;
    const d = e.data;
    const ev: EscalationEvent = {
      seq: e.seq,
      at: e.ts,
      kind,
      authorizationId: kind === "escalated" ? String(e.authorizationId) : String(d.escalationId),
      sessionId: String(e.sessionId ?? ""),
      resourceKey: String(d.resourceKey),
      payTo: String(d.payTo),
      amount: String(d.amount),
    };
    if (kind === "escalated") ev.expiresAt = iso(expiresAtMsOf(e));
    if (kind === "approved") Object.assign(ev, { approvalId: String(d.approvalId), approver: String(d.approver), approvalExpiresAt: iso(d.expiresAtMs as number) });
    if (kind === "denied") {
      Object.assign(ev, { rejectionId: String(d.rejectionId), operator: String(d.operator) });
      if (typeof d.reason === "string") ev.reason = d.reason;
    }
    if (kind === "expired") ev.expiresAt = iso(d.expiresAtMs as number);
    if (kind === "approval_lapsed") ev.approvalId = String(d.approvalId);
    events.push(ev);
  }
  return events;
}
