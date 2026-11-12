// Escalation lifecycle (SPEC.md §8.2 L2-4.3). Owner: feature 010.
// Pure derivations over ledger entries; only `sweep` writes. Never reads the clock: every function
// that needs time takes `nowMs` (INV-5, NFR-007 of 003). An escalation is created by its ESCALATED
// entry and ends exactly once: approved (HUMAN_APPROVAL), denied (HUMAN_REJECTION) or expired
// (ESCALATION_EXPIRED, or the clock passing createdMs + ESCALATION_TTL_MS). Final states are never left.
import { REJECTION_REASON_CODES, type EscalationDecision, type EscalationDetail, type EventPage, type RejectionReasonCode } from "../shared/contracts.js";
import type {
  ApprovalRequestMark,
  ApprovalRequestState,
  DecisionChannel,
  EscalationEvent,
  EscalationEventKind,
  EscalationView,
} from "../shared/contracts.js";
import type { AuditLedger, LedgerEntry } from "./ledger.js";
import { referenceCode } from "./payment-details.js";

export { referenceCode };
// 014: the view shapes live in src/shared/contracts.ts (the portal reads them too); re-exported for this layer.
export type { ApprovalRequestMark, ApprovalRequestState, DecisionChannel, EscalationEvent, EscalationEventKind, EscalationView };

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

/** 013: the owner of an escalation, from its ESCALATED entry (`null`: the platform account). */
export function escalationOwner(entries: Entries, escalationId: unknown): string | null {
  const esc = typeof escalationId === "string" ? findEscalation(entries, escalationId) : undefined;
  return typeof esc?.data.userId === "string" ? esc.data.userId : null;
}

/**
 * The most recent HUMAN_REJECTION for (session, resourceKey), whatever the amount or payee (R15 scope).
 * 013: with `userId` given (`null` for the platform account), only a rejection of that owner's escalation counts.
 */
export function findRejection(entries: Entries, sessionId: string, resourceKey: string, userId?: string | null): LedgerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "HUMAN_REJECTION" || e.sessionId !== sessionId || e.data.resourceKey !== resourceKey) continue;
    if (userId !== undefined && escalationOwner(entries, e.data.escalationId) !== userId) continue;
    return e;
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
  userId?: string | null,
): LedgerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "ESCALATED" || e.sessionId !== sessionId || e.data.resourceKey !== resourceKey) continue;
    if (userId !== undefined && (typeof e.data.userId === "string" ? e.data.userId : null) !== userId) continue;
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
      referenceCode: referenceCode(e.authorizationId!),
      ...(typeof e.data.approvalRequest === "string" && { approvalRequest: approvalRequestState(entries, e.authorizationId!)! }),
      ...(typeof e.data.userId === "string" && { userId: e.data.userId }),
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

const KIND: Partial<Record<LedgerEntry["type"], EscalationEventKind>> = {
  ESCALATED: "escalated",
  HUMAN_APPROVAL: "approved",
  HUMAN_REJECTION: "denied",
  ESCALATION_EXPIRED: "expired",
  APPROVAL_LAPSED: "approval_lapsed",
  APPROVAL_REQUESTED: "approval_requested",
  APPROVAL_REQUEST_FAILED: "approval_request_failed",
  APPROVAL_REQUEST_LAPSED: "approval_request_lapsed",
  APPROVAL_VERIFICATION_FAILED: "approval_verification_failed",
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
    if (kind === "escalated") {
      ev.expiresAt = iso(expiresAtMsOf(e));
      ev.referenceCode = referenceCode(String(e.authorizationId));
      if (typeof d.approvalRequest === "string") ev.approvalRequest = d.approvalRequest;
      if (typeof d.userId === "string") ev.userId = d.userId;
    }
    if (kind === "approved") {
      Object.assign(ev, { approvalId: String(d.approvalId), approver: String(d.approver), approvalExpiresAt: iso(d.expiresAtMs as number) });
      Object.assign(ev, { channel: channelOf(e), decidedBy: String(d.approver) });
    }
    if (kind === "denied") {
      const channel = channelOf(e);
      ev.rejectionId = String(d.rejectionId);
      if (channel === "operator") {
        ev.operator = String(d.operator);
        if (typeof d.reason === "string") ev.reason = d.reason;
      }
      // 014: a portal rejection carries a code from a fixed list, never text.
      const reasonCode = channel === "portal" ? reasonCodeOf(e) : undefined;
      if (reasonCode !== undefined) ev.reasonCode = reasonCode;
      Object.assign(ev, { channel, decidedBy: channel === "operator" ? String(d.operator) : String(d.approver) });
    }
    if (kind === "expired") ev.expiresAt = iso(d.expiresAtMs as number);
    if (kind === "approval_lapsed") ev.approvalId = String(d.approvalId);
    if (kind === "approval_requested") {
      Object.assign(ev, { requestId: String(d.requestId), referenceCode: String(d.referenceCode), requestExpiresAt: iso(d.requestExpiresAtMs as number) });
    }
    if (kind === "approval_request_failed") {
      if (typeof d.requestId === "string") ev.requestId = d.requestId;
      ev.failure = String(d.failure);
      if (typeof d.error === "string") ev.error = d.error;
    }
    if (kind === "approval_request_lapsed") Object.assign(ev, { requestId: String(d.requestId), cause: String(d.cause) });
    if (kind === "approval_verification_failed") Object.assign(ev, { requestId: String(d.requestId), check: String(d.check) });
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// 014 one escalation in any state (SPEC L2-5; specs/014 data-model.md "EscalationDetail").
// ---------------------------------------------------------------------------

/** Who decided, as every view shows it: an identifier or a subject, or the operator's label (untrusted text). */
export const deciderOf = (e: LedgerEntry): string => String(channelOf(e) === "operator" && e.type === "HUMAN_REJECTION" ? e.data.operator : e.data.approver);

/** How a person ended an escalation, from a whitelist of the decision entry's fields. */
export function decisionOf(e: LedgerEntry): EscalationDecision {
  const channel = channelOf(e);
  const reasonCode = channel === "portal" ? reasonCodeOf(e) : undefined;
  return {
    at: e.ts,
    channel,
    decidedBy: deciderOf(e),
    ...(e.type === "HUMAN_APPROVAL" && { approvalId: String(e.data.approvalId), approvalExpiresAt: iso(e.data.expiresAtMs as number) }),
    ...(e.type === "HUMAN_REJECTION" && { rejectionId: String(e.data.rejectionId) }),
    ...(reasonCode !== undefined && { reasonCode }),
    ...(channel === "operator" && typeof e.data.reason === "string" && { reason: e.data.reason }),
  };
}

/** The escalation as its ESCALATED entry describes it, whatever became of it. */
function viewOf(entries: Entries, e: LedgerEntry): EscalationView {
  return {
    authorizationId: e.authorizationId!,
    sessionId: String(e.sessionId ?? ""),
    resourceKey: String(e.data.resourceKey),
    payTo: String(e.data.payTo),
    amount: String(e.data.amount),
    createdAt: e.ts,
    expiresAt: iso(expiresAtMsOf(e)),
    referenceCode: referenceCode(e.authorizationId!),
    ...(typeof e.data.approvalRequest === "string" && { approvalRequest: approvalRequestState(entries, e.authorizationId!)! }),
    ...(typeof e.data.userId === "string" && { userId: e.data.userId }),
  };
}

/** One escalation in any state, with how it ended when a person ended it. The budget is added by the caller. */
export function escalationDetail(entries: Entries, escalationId: string, nowMs: number): Omit<EscalationDetail, "budget"> | undefined {
  const escalated = findEscalation(entries, escalationId);
  const state = escalationState(entries, escalationId, nowMs);
  if (!escalated || state === "not_found") return undefined;
  const decision = decisionEntry(entries, escalationId);
  const byPerson = decision !== undefined && decision.type !== "ESCALATION_EXPIRED" && state !== "expired" && state !== "pending";
  return { ...viewOf(entries, escalated), state, ...(byPerson && { decision: decisionOf(decision) }) };
}

// ---------------------------------------------------------------------------
// 014 the trail in pages, for the portal's administration area (SPEC L2-5; specs/014 data-model.md "EventPage").
// ---------------------------------------------------------------------------

export const EVENT_PAGE_DEFAULT = 50;
export const EVENT_PAGE_MAX = 200;

/**
 * One page of lifecycle events, oldest first. `after`: the first `limit` events with a higher `seq` (polling).
 * `before`: the last `limit` events with a lower one ("show earlier"). Neither: the latest `limit`. Sequence numbers
 * are the ledger's own order, so reading by cursor yields every event exactly once (FR-021).
 * Every event here also names the payment's owner and reference code, whatever its kind (FR-020); the operator's
 * feed (`escalationEvents`) is unchanged.
 */
export function eventPage(entries: Entries, q: { after?: number; before?: number; limit: number }): EventPage {
  const all = escalationEvents(entries, -1);
  const pool = q.after !== undefined ? all.filter((e) => e.seq > q.after!) : q.before !== undefined ? all.filter((e) => e.seq < q.before!) : all;
  const events = q.after !== undefined ? pool.slice(0, q.limit) : pool.slice(Math.max(0, pool.length - q.limit));
  const owners = new Map<string, string | null>();
  for (const ev of events) {
    if (!owners.has(ev.authorizationId)) owners.set(ev.authorizationId, escalationOwner(entries, ev.authorizationId));
    const owner = owners.get(ev.authorizationId);
    if (typeof owner === "string") ev.userId = owner;
    ev.referenceCode = referenceCode(ev.authorizationId);
  }
  return {
    events,
    first: events[0]?.seq ?? -1,
    last: events.at(-1)?.seq ?? -1,
    cursor: entries.length - 1,
    more: pool.length > events.length,
  };
}

// ---------------------------------------------------------------------------
// 012 approval request derivations (SPEC L2-7; specs/012 data-model.md "Derived functions"). Pure, like the rest
// of this file: every function takes `nowMs` when it needs time.
// ---------------------------------------------------------------------------

/**
 * The channel of an approval or rejection. An entry written before 012 has none, and reads as `operator`.
 * 014: `portal` is the administrator's decision, relayed by the portal.
 */
export const channelOf = (e: LedgerEntry): DecisionChannel =>
  e.data.channel === "backchannel" ? "backchannel" : e.data.channel === "portal" ? "portal" : "operator";

/** 014: a reason code only if it is one of the fixed list, so nothing else can reach a view. */
export const reasonCodeOf = (e: LedgerEntry): RejectionReasonCode | undefined =>
  (REJECTION_REASON_CODES as readonly unknown[]).includes(e.data.reasonCode) ? (e.data.reasonCode as RejectionReasonCode) : undefined;

const REQUEST_ENDINGS: ReadonlySet<LedgerEntry["type"]> = new Set([
  "APPROVAL_REQUEST_FAILED",
  "APPROVAL_REQUEST_LAPSED",
  "APPROVAL_VERIFICATION_FAILED",
]);

/** FR-008: `ESCALATED` entries marked `requested` within the trailing window (an attempt counts, sent or not). */
export function approvalRequestCount(entries: Entries, nowMs: number, windowMs = 3_600_000): number {
  let n = 0;
  for (const e of entries) {
    if (e.type === "ESCALATED" && e.data.approvalRequest === "requested" && Date.parse(e.ts) > nowMs - windowMs) n++;
  }
  return n;
}

/** The first entry that ended the escalation's approval request, if any. */
function requestEnding(entries: Entries, escalationId: string): LedgerEntry | undefined {
  return entries.find((e) => REQUEST_ENDINGS.has(e.type) && e.data.escalationId === escalationId);
}

/** The approval request's state, or undefined when the escalation carries no mark (feature off, or before 012). */
export function approvalRequestState(entries: Entries, escalationId: string): ApprovalRequestState | undefined {
  const mark = findEscalation(entries, escalationId)?.data.approvalRequest;
  if (typeof mark !== "string") return undefined;
  if (mark !== "requested") return mark as ApprovalRequestMark;
  const decision = decisionEntry(entries, escalationId);
  if (decision && decision.type !== "ESCALATION_EXPIRED" && channelOf(decision) === "backchannel") return "answered";
  const ending = requestEnding(entries, escalationId);
  if (ending) {
    if (ending.type === "APPROVAL_REQUEST_FAILED") return "failed";
    if (ending.type === "APPROVAL_REQUEST_LAPSED") return "lapsed";
    return "verification_failed";
  }
  return decision ? "abandoned" : "requested";
}

/** The escalation's APPROVAL_REQUESTED with no ending entry, whatever the time (lapse and failure recording). */
export function activeApprovalRequest(entries: Entries, escalationId: string): LedgerEntry | undefined {
  if (requestEnding(entries, escalationId)) return undefined;
  return entries.find((e) => e.type === "APPROVAL_REQUESTED" && e.data.escalationId === escalationId);
}

/** The request an answer may approve: active, its escalation pending, and before its own expiry. */
export function openApprovalRequest(entries: Entries, escalationId: string, nowMs: number): LedgerEntry | undefined {
  if (escalationState(entries, escalationId, nowMs) !== "pending") return undefined;
  const req = activeApprovalRequest(entries, escalationId);
  if (!req || nowMs >= (req.data.requestExpiresAtMs as number)) return undefined;
  return req;
}

export interface ResumeSet {
  /** Open requests: poll again from their sealed handles. */
  open: LedgerEntry[];
  /** Active requests past their own expiry while the escalation is pending: record the lapse. */
  stale: LedgerEntry[];
  /** `requested` escalations still pending with no request entry at all: L2 died between the two sections. */
  interrupted: LedgerEntry[];
}

/** What `resume()` must do after a restart (FR-012). Never resends a request. */
export function requestsToResume(entries: Entries, nowMs: number): ResumeSet {
  const out: ResumeSet = { open: [], stale: [], interrupted: [] };
  for (const esc of entries) {
    if (esc.type !== "ESCALATED" || esc.data.approvalRequest !== "requested" || esc.authorizationId === undefined) continue;
    const id = esc.authorizationId;
    if (escalationState(entries, id, nowMs) !== "pending") continue;
    const hasRequest = entries.some((e) => e.type === "APPROVAL_REQUESTED" && e.data.escalationId === id);
    if (!hasRequest) {
      if (!requestEnding(entries, id)) out.interrupted.push(esc);
      continue;
    }
    const req = activeApprovalRequest(entries, id);
    if (!req) continue;
    (nowMs < (req.data.requestExpiresAtMs as number) ? out.open : out.stale).push(req);
  }
  return out;
}

/** Check `replay`: an answer approves at most one escalation. */
export function answerIdUsed(entries: Entries, answerId: string): boolean {
  return entries.some((e) => e.type === "HUMAN_APPROVAL" && (e.data.evidence as { answerId?: unknown } | undefined)?.answerId === answerId);
}
