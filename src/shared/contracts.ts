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
  budget(sessionId: string): Promise<BudgetStatus>;
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
}

export type { PaymentRequired, PaymentRequirements };
