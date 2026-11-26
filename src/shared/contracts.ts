// Boundary contracts (SPEC.md §7). These are the ONLY objects that cross layer boundaries.
// Changing anything here is a contract change: update every producer, consumer and test together.
// Owner: feature 001 (T004). All amounts are decimal strings of atomic units; use BigInt, never Number.
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";

// L1 -> L2
export interface PaymentIntent {
  intentId: string; // "int_<uuid>"
  sessionId: string; // agent session
  resourceUrl: string; // URL L1 requested (http/https only)
  paymentRequired: PaymentRequired; // verbatim decoded challenge
  purpose: string; // LLM text, audit only (INV-5)
  createdAt: string; // ISO
  // 012 FR-007: true removes the backchannel approval path, never adds one. Set only by the L1-4 scripted root; the
  // hosted agent never sets it.
  operatorApprovalOnly?: boolean;
  /**
   * The person the payment is for (`^usr_[0-9a-f]{32}$`). 016: set by L2, from the caller's token it verified
   * itself, on the intent it decides and records. It is never accepted from a request: L2 refuses an intent that
   * arrives with it (SEC-32). Absent for a machine caller, the scripted agent and the local demo.
   */
  userId?: string;
}

/**
 * 1.19 (L2-5): the longest `purpose` L2 accepts, in characters. L1 cuts the model's text to it before asking; L2
 * refuses a longer one (400), because every intent is kept in the ledger for good and every decision reads it.
 */
export const PURPOSE_MAX_CHARS = 500;
/** 1.19 (L2-5): the most payment options one challenge may offer. Each one is evaluated against every rule. */
export const ACCEPTS_MAX = 20;

// L2 -> L1
export interface PolicyViolation {
  rule: string;
  detail: string;
}

export type AuthorizationDecision =
  | {
      status: "AUTHORIZED";
      authorizationId: string;
      intentId: string;
      requirement: PaymentRequirements;
      paymentHeaders: Record<string, string>;
      payer: string;
      validBefore: number;
      /** 1.19: the signed authorization's EIP-3009 nonce; L1 passes it to L3 in the settlement claim. */
      nonce?: string;
      remainingSessionBudgetAtomic: string;
    }
  | {
      status: "DENIED" | "ESCALATE";
      authorizationId: string;
      intentId: string;
      violations: PolicyViolation[];
    };

// L1 -> L3
export interface SettlementClaim {
  authorizationId: string;
  requirement: PaymentRequirements;
  payer: string;
  validBefore: number;
  /**
   * 1.19 (L3-1): the authorization's EIP-3009 nonce, from L2's decision. With it, L3 reports NOT_SETTLED only after
   * validBefore and only when the nonce is still unused on-chain; without it (an older L1), as before 1.19.
   */
  nonce?: string;
  httpStatus: number;
  paymentResponseHeader: string | null;
}

// L3 -> L2 and L1
export type SettlementStatus = "CONFIRMED" | "PENDING" | "MISMATCH" | "NOT_SETTLED";
export type FinalityClass = "included" | "confirmed-depth" | "l1-safe";

export interface SettlementReport {
  authorizationId: string;
  status: SettlementStatus;
  transaction?: string;
  network: string;
  blockNumber?: string;
  confirmations?: number;
  finalityClass: FinalityClass;
  detail: string;
  observedAt: string;
  /** 1.19: `nonce` is the authorization's EIP-3009 nonce when the claim carried one; L2 compares it with its own. */
  verified: { asset: string; payer: string; payTo: string; amount: string; nonce?: string };
  /**
   * 1.19: on a PENDING report only, when the authorization could still be used: the time (ISO) after which L3 checks
   * its nonce on-chain (validBefore plus a margin). L3 re-checks then.
   */
  settlesBy?: string;
}

// Ports
export interface AuthorizationGatePort {
  authorize(intent: PaymentIntent): Promise<AuthorizationDecision>;
  /** 016: a gate made for a person answers with that person's view of the budget (`scope: "user_daily"`). */
  budget(sessionId: string): Promise<BudgetStatus>;
}

/**
 * 016 (SEC-32): where a gate for one caller comes from. The hosted agent takes one per run, for the caller whose
 * token it verified, and every call of that gate carries the token to L2. An empty token gives a gate that
 * carries none (the local scripted agent, where L2 has no sign-in configured).
 */
export interface CallerGates {
  forCaller(callerToken: string): AuthorizationGatePort;
}

export interface SettlementVerifierPort {
  verify(claim: SettlementClaim): Promise<SettlementReport>;
}

export interface ReconciliationPort {
  reconcile(report: SettlementReport): Promise<void>;
}

export interface BudgetStatus {
  sessionId: string;
  asset: string;
  decimals: number;
  sessionCapAtomic: string;
  spentOrReservedAtomic: string;
  remainingAtomic: string;
  perPaymentCapAtomic: string;
  /** 013: what the figures count. Absent means "session", as before. */
  scope?: "session" | "user_daily";
  /**
   * 019: whether the person can pay now. Present only on L2's user view (`scope: "user_daily"`), from `userGate` of
   * the person in the verified token: "ready" when it gives none. The platform view has none. The hosted agent reads
   * it before a person's run (its account question); its `check_budget` tool drops it before the model sees it.
   */
  account?: "ready" | "not_onboarded" | "disabled";
}

// ---------------------------------------------------------------------------
// 013 user accounts (SPEC L2-8): the shapes that cross the portal / L2 boundary.
// No field here carries text typed by a person (specs/013 research R6).
// ---------------------------------------------------------------------------

/** One version's rule values. Amounts are atomic-unit decimal strings. */
export interface PolicyValues {
  /** Seller hosts (`host[:port]`), each on the operator's seller list when saved. */
  sellers: string[];
  autoApproveMaxAtomic: string;
  hardCapPerPaymentAtomic: string;
  sessionBudgetAtomic: string;
  dailyBudgetAtomic: string;
  maxAuthorizationsPerMinute: number;
  /** ISO date-time. */
  expiresAt: string;
  paymentMethod: "crypto_account";
}

/** One reason a policy save was refused (422 `invalid_policy`). */
export interface PolicyIssue {
  field: string;
  code: string;
  host?: string;
  policyId?: string;
  limitAtomic?: string;
  limit?: number;
}

export type PolicyState = "active" | "paused" | "removed";
export type PolicyDisplayState = PolicyState | "expired" | "disabled";
export type PolicyEventKind = "created" | "changed" | "paused" | "resumed" | "removed";

/** One recorded event of a policy, in ledger order. */
export interface PolicyVersion {
  seq: number;
  ts: string;
  kind: PolicyEventKind;
  version: number;
  values?: PolicyValues;
  cause?: "user" | "account_enabled";
}

export interface PolicyView {
  policyId: string;
  version: number;
  values: PolicyValues;
  state: PolicyState;
  displayState: PolicyDisplayState;
  expired: boolean;
  /** Fields where the platform limit is currently stricter than the saved value (FR-043). */
  limitedByPlatform: string[];
  /** Sellers no longer on the seller list (FR-042). */
  unlistedSellers: string[];
  updatedAt: string;
  history?: PolicyVersion[];
}

export interface UserWalletView {
  address: string;
  network: string;
  asset: string;
  decimals: number;
  committedAtomic: string;
  spent24hAtomic: string;
  dailyCeilingAtomic: string;
  dailyRemainingAtomic: string;
}

export interface UserView {
  userId: string;
  registered: boolean;
  enabled: boolean;
  onboarding: { profile: boolean; wallet: boolean; policy: boolean };
  wallet?: UserWalletView;
  cards: string[];
  /** 020: the active connections to outside platforms, identifiers only (specs/020 contracts/control-api.md). */
  connections: UserConnectionView[];
  policies: PolicyView[];
}

/** 020: the one connected platform in this version. */
export type ConnectedPlatform = "coinbase";

/** 020: one active connection, as L2 records it: never a grant, an account identifier or a balance (FR-023). */
export interface UserConnectionView {
  connectionId: string;
  platform: ConnectedPlatform;
  /** ISO time of the CONNECTION_OPENED entry. */
  connectedAt: string;
}

export interface PlatformLimits {
  hardCapPerPaymentAtomic: string;
  sessionBudgetAtomic: string;
  userDailyCeilingAtomic: string;
  maxAuthorizationsPerMinute: number;
  maxPolicyDays: number;
}

export interface PlatformSeller {
  host: string;
  name: string;
  payees: string[];
}

export interface PlatformView {
  platformId: string;
  digest: string;
  limits: PlatformLimits;
  sellers: PlatformSeller[];
  network: string;
  asset: string;
  decimals: number;
  /** 015: true when backchannel approval is on in this L2 (a person can be asked on their phone). */
  phoneApproval: boolean;
}

// ---------------------------------------------------------------------------
// Escalation views (010, 012, 013), here since 014 because they cross the portal/L2 boundary
// (SPEC.md §7; specs/014 contracts/control-api.md). `src/layer2-control/escalations.ts` builds them.
// ---------------------------------------------------------------------------

/**
 * Where a decision came from: the operator's command line, a phone (012), or the portal (014). 015: for the
 * backchannel the phone is the owner's, and the decision names them by `usr_…` (entries written before v1.16 hold
 * the configured approver's subject).
 */
export type DecisionChannel = "operator" | "backchannel" | "portal";

/**
 * Written once on `ESCALATED` when backchannel approval is on. 015: `no_owner` (the escalation records no user),
 * `no_identity` (a user and no subject to ask; 016: no longer reached from a request) and `identity_mismatch` (the subject does not resolve to the user)
 * ask nobody.
 */
export type ApprovalRequestMark = "requested" | "capped" | "operator_only" | "reevaluation" | "no_owner" | "no_identity" | "identity_mismatch";
/** 015: `unanswered` is a `requested` escalation that expired with no entry ending its request. */
export type ApprovalRequestState = ApprovalRequestMark | "failed" | "verification_failed" | "lapsed" | "answered" | "abandoned" | "unanswered";

/**
 * 015: why a person's pending payment waits for the operator and not for their phone. A fixed list: the approval
 * service's text is never kept. `request_expired` is the reason for a `lapsed` request, whose escalation is still
 * pending; the state `unanswered` belongs to an expired escalation and never appears here.
 */
export const WAITING_REASONS = ["limit_reached", "sign_in_not_supported", "phone_unreachable", "service_unavailable", "request_expired", "answer_not_accepted"] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

/** 015: one pending escalation of a user, as that user may see it (GET /v1/users/:userId/escalations). Built field by field. */
export interface WaitingPayment {
  authorizationId: string;
  referenceCode: string;
  resourceKey: string;
  payTo: string;
  /** Atomic units. */
  amount: string;
  createdAt: string;
  expiresAt: string;
  waitingFor: "phone" | "operator";
  /** Only with `operator`. */
  reason?: WaitingReason;
}

/** 014: an escalation's ID is the `authorizationId` of its ESCALATE decision. The administration routes accept nothing else. */
export const ESCALATION_ID_RE = /^auth_[0-9a-f-]{36}$/;

/** 014: why an administrator rejected a payment. A fixed list: no text typed in the portal reaches L2 (FR-016). */
export const REJECTION_REASON_CODES = ["not_expected", "amount_too_high", "wrong_seller", "duplicate", "other"] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

/** One pending escalation (GET /v1/escalations, GET /v1/admin/escalations). */
export interface EscalationView {
  authorizationId: string;
  sessionId: string;
  resourceKey: string;
  payTo: string;
  amount: string;
  createdAt: string;
  expiresAt: string;
  /** 012: the first 8 hex characters of the ID, shown to the approver too. */
  referenceCode: string;
  /** 012: present when the escalation carries an approval-request mark (backchannel approval on). */
  approvalRequest?: ApprovalRequestState;
  /** 013 (FR-045): whose payment it is, when the escalation is a user's. An identifier only, never a name. */
  userId?: string;
}

export type EscalationEventKind =
  | "escalated"
  | "approved"
  | "denied"
  | "expired"
  | "approval_lapsed"
  // 012 (L2-7): the approval request's own events
  | "approval_requested"
  | "approval_request_failed"
  | "approval_request_lapsed"
  | "approval_verification_failed";

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
  // 012 (FR-029): whitelisted fields only. Never a token, a handle, details, the binding message or evidence.
  referenceCode?: string;
  approvalRequest?: string;
  channel?: DecisionChannel;
  decidedBy?: string;
  requestId?: string;
  requestExpiresAt?: string;
  failure?: string;
  error?: string;
  cause?: string;
  check?: string;
  /** 013 (FR-045): on `escalated` events of a user's payment. */
  userId?: string;
  /** 014: on a `denied` event of the portal channel. */
  reasonCode?: RejectionReasonCode;
}

// ---------------------------------------------------------------------------
// 014 portal administration (SPEC.md §8.2 L2-5, L2-8; specs/014 data-model.md "Derived views")
// ---------------------------------------------------------------------------

/** One budget an escalation counts against. Atomic-unit decimal strings; `remainingAtomic` is never below 0. */
export interface BudgetLine {
  capAtomic: string;
  spentAtomic: string;
  remainingAtomic: string;
}

/** The budget behind an escalation, as of the read, against the rules that apply now (INV-12). */
export interface EscalationBudget {
  asset: string;
  decimals: number;
  /** False when no rule set applies to this purchase now. The lines are then zeros. */
  applies: boolean;
  /** Why not, when `applies` is false. */
  notApplying?: "user_not_onboarded" | "user_disabled" | "no_active_policy";
  autoApproveMaxAtomic: string;
  hardCapPerPaymentAtomic: string;
  /** The agent run's budget: the policy's run budget, or the mandate's session budget. */
  run: BudgetLine;
  /** The last 24 hours under the same policy, or under the mandate. */
  day: BudgetLine;
  /** A user's payment only: the user daily ceiling across all their policies. */
  userDay?: BudgetLine;
  /** `applies`, and the amount is within the per-payment cap and within every `remainingAtomic`. */
  fits: boolean;
}

/** How an escalation ended, when a person ended it. */
export interface EscalationDecision {
  at: string;
  channel: DecisionChannel;
  /**
   * `usr_…` for the portal; for the backchannel the owner's `usr_…` (entries written before v1.16 hold the configured
   * approver's subject); the operator's label (untrusted text).
   */
  decidedBy: string;
  approvalId?: string;
  approvalExpiresAt?: string;
  rejectionId?: string;
  /** Portal rejections. */
  reasonCode?: RejectionReasonCode;
  /** Operator rejections: untrusted text, shown as text only. */
  reason?: string;
}

/** An escalation in any state, with its decision and its budget (GET /v1/admin/escalations/:authorizationId). */
export interface EscalationDetail extends EscalationView {
  state: "pending" | "approved" | "denied" | "expired";
  decision?: EscalationDecision;
  budget: EscalationBudget;
}

/** One page of escalation events, oldest first (GET /v1/admin/escalations/events). */
export interface EventPage {
  events: EscalationEvent[];
  /** `seq` of the first event of the page, or -1 when it is empty. */
  first: number;
  /** `seq` of the last event of the page, or -1 when it is empty. */
  last: number;
  /** The ledger's last `seq` at the read. */
  cursor: number;
  /** Events exist beyond this page, in the direction asked. */
  more: boolean;
}

/** The answer to an administrator's decision. `already` is true when the same decision existed, on any path. */
export type DecisionOutcome =
  | { ok: true; state: "approved"; approvalId: string; expiresAt: string; already: boolean; channel: DecisionChannel; decidedBy: string }
  | { ok: true; state: "denied"; rejectionId: string; rejectedAt: string; already: boolean; channel: DecisionChannel; decidedBy: string };

/** The ledger's hash chain (GET /v1/ledger/verify, GET /v1/admin/ledger/verify). */
export interface LedgerCheck {
  entries: number;
  ok: boolean;
  brokenAt?: number;
}

export type { PaymentRequired, PaymentRequirements };
