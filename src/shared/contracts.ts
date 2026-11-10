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
   * 013 FR-033: the verified person who started the run (`^usr_[0-9a-f]{32}$`). Set by the hosted agent service only,
   * never from model text or a tool input. Absent for system identities, the scripted agent and the local demo.
   */
  userId?: string;
}

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
  verified: { asset: string; payer: string; payTo: string; amount: string };
}

// Ports
export interface AuthorizationGatePort {
  authorize(intent: PaymentIntent): Promise<AuthorizationDecision>;
  /** 013: with `userId`, the user view of the budget (`scope: "user_daily"`). */
  budget(sessionId: string, userId?: string): Promise<BudgetStatus>;
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
  policies: PolicyView[];
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
}

export type { PaymentRequired, PaymentRequirements };
