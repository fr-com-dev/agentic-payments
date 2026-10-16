// L1-1 Orchestrator (SPEC.md §8.1): the x402 transport loop. It holds no key material and makes no
// policy decision. Payment headers from L2 are opaque and forwarded unchanged; settlement status
// comes only from L3, never from the seller's PAYMENT-RESPONSE (INV-10).
import { randomUUID } from "node:crypto";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type {
  AuthorizationGatePort,
  PaymentIntent,
  PaymentRequired,
  PolicyViolation,
  SettlementClaim,
  SettlementReport,
  SettlementVerifierPort,
} from "../shared/contracts.js";

export type PaidFetchOutcome = "FREE" | "PAID" | "DENIED" | "ESCALATED" | "PAYMENT_FAILED" | "ERROR";

export interface PaidFetchPayment {
  authorizationId: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  /** Absent only when `settlement.verify` threw after the paid retry. */
  settlement?: SettlementReport;
}

export interface PaidFetchResult {
  outcome: PaidFetchOutcome;
  url: string;
  httpStatus?: number;
  body?: unknown;
  payment?: PaidFetchPayment;
  violations?: PolicyViolation[];
  authorizationId?: string;
  error?: string;
}

export interface OrchestratorDeps {
  gate: AuthorizationGatePort;
  settlement: SettlementVerifierPort;
  sessionId: string;
  fetchImpl?: typeof fetch;
}

/** Non-JSON bodies are returned as text truncated to this many characters (L1-1 step 2). */
export const MAX_TEXT_BODY = 2000;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, MAX_TEXT_BODY);
  }
}

export class PaidResourceOrchestrator {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: OrchestratorDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  async fetchPaid(url: string, purpose: string): Promise<PaidFetchResult> {
    // Step 1: unpaid request.
    let first: Response;
    try {
      first = await this.fetchImpl(url);
    } catch (e) {
      return { outcome: "ERROR", url, error: errorMessage(e) };
    }

    // Step 2: anything but 402 is free.
    if (first.status !== 402) {
      return { outcome: "FREE", url, httpStatus: first.status, body: await readBody(first) };
    }

    // Step 3: decode the challenge with the SDK; fall back to a v1 JSON body.
    let paymentRequired: PaymentRequired;
    const header = first.headers.get("PAYMENT-REQUIRED");
    try {
      paymentRequired = header !== null ? decodePaymentRequiredHeader(header) : (JSON.parse(await first.text()) as PaymentRequired);
    } catch (e) {
      return { outcome: "ERROR", url, httpStatus: 402, error: `undecodable payment challenge: ${errorMessage(e)}` };
    }

    // Step 4: ask L2. The whole challenge goes verbatim; option selection is L2's job.
    const intent: PaymentIntent = {
      intentId: `int_${randomUUID()}`,
      sessionId: this.deps.sessionId,
      resourceUrl: url,
      paymentRequired,
      purpose,
      createdAt: new Date().toISOString(),
    };
    let decision;
    try {
      decision = await this.deps.gate.authorize(intent);
    } catch (e) {
      return { outcome: "ERROR", url, httpStatus: 402, error: `authorization failed: ${errorMessage(e)}` };
    }

    // Step 5: DENIED or ESCALATE stops here. No retry.
    if (decision.status !== "AUTHORIZED") {
      return {
        outcome: decision.status === "DENIED" ? "DENIED" : "ESCALATED",
        url,
        httpStatus: 402,
        violations: decision.violations,
        authorizationId: decision.authorizationId,
      };
    }

    const req = decision.requirement;
    const payment: PaidFetchPayment = {
      authorizationId: decision.authorizationId,
      amountAtomic: req.amount,
      asset: req.asset,
      network: req.network,
      payTo: req.payTo,
    };

    // Step 6: paid retry with L2's headers, unchanged.
    let paid: Response;
    try {
      paid = await this.fetchImpl(url, { headers: decision.paymentHeaders });
    } catch (e) {
      // The signed authorization may still settle; L3 decides from the chain with no PAYMENT-RESPONSE.
      return this.settle(url, decision, payment, 0, null, undefined, `paid request failed: ${errorMessage(e)}`);
    }
    const ok = paid.status >= 200 && paid.status < 300;
    const body = await readBody(paid);

    // Step 7: claim from the decision plus the raw PAYMENT-RESPONSE header.
    return this.settle(url, decision, payment, paid.status, paid.headers.get("PAYMENT-RESPONSE"), ok ? body : undefined);
  }

  private async settle(
    url: string,
    decision: { authorizationId: string; requirement: SettlementClaim["requirement"]; payer: string; validBefore: number },
    payment: PaidFetchPayment,
    httpStatus: number,
    paymentResponseHeader: string | null,
    body: unknown,
    priorError?: string,
  ): Promise<PaidFetchResult> {
    const ok = httpStatus >= 200 && httpStatus < 300;
    const claim: SettlementClaim = {
      authorizationId: decision.authorizationId,
      requirement: decision.requirement,
      payer: decision.payer,
      validBefore: decision.validBefore,
      httpStatus,
      paymentResponseHeader,
    };
    const base = { url, httpStatus, authorizationId: decision.authorizationId, ...(ok && { body }) };
    let report: SettlementReport;
    try {
      report = await this.deps.settlement.verify(claim);
    } catch (e) {
      // Money may have moved: keep the payment details (SPEC v1.1 L1-1 step 8).
      return { outcome: "PAYMENT_FAILED", ...base, payment, error: `settlement verification failed: ${errorMessage(e)}` };
    }
    // Step 8.
    const settled = report.status === "CONFIRMED" || report.status === "PENDING";
    return {
      outcome: ok && settled ? "PAID" : "PAYMENT_FAILED",
      ...base,
      payment: { ...payment, settlement: report },
      ...(priorError !== undefined && { error: priorError }),
    };
  }
}
