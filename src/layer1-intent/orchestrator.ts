// L1-1 Orchestrator (SPEC.md §8.1): the x402 transport loop. It holds no key material and makes no
// policy decision. Payment headers from L2 are opaque and forwarded unchanged; settlement status
// comes only from L3, never from the seller's PAYMENT-RESPONSE (INV-10).
import { randomUUID } from "node:crypto";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import {
  PURPOSE_MAX_CHARS,
  type AuthorizationGatePort,
  type PaymentIntent,
  type PaymentRequired,
  type PolicyViolation,
  type SettlementClaim,
  type SettlementReport,
  type SettlementVerifierPort,
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
  /**
   * 012 FR-007: true marks every intent operator-only, so an escalation never notifies the approver. Only the L1-4
   * scripted root (src/main.ts --scripted) sets it; the agents' tools cannot. It only removes an approval path.
   */
  operatorApprovalOnly?: boolean;
  /**
   * 1.19 (L1-1, SEC-1): the hosts (`host[:port]`, as `new URL(...).host` gives them) this orchestrator may fetch at
   * all. The model-driven agents set it to the seller's host, so neither a goal nor text in a fetched page can send
   * the agent to an internal address or anywhere else. Absent (the scripted plan): any http(s) host; L2 still allows
   * a payment only at its own hosts (R6).
   */
  allowedHosts?: readonly string[];
}

/** Non-JSON bodies are returned as text truncated to this many characters (L1-1 step 2). */
export const MAX_TEXT_BODY = 2000;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 016: L2 answers 401 or 403 with a `caller_…` code when it refuses the caller's token (specs/016
 * contracts/control-api.md). The agent is told so in words it can pass on; anything else is not a caller refusal.
 */
function callerRefusal(e: unknown): string | null {
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined;
  if (typeof code !== "string" || !code.startsWith("caller_")) return null;
  return code === "caller_token_expired" ? "the sign-in has expired: sign in again" : "the caller was refused by the control layer";
}

/** A reason code as x402 writes them (`invalid_exact_evm_insufficient_balance`, `settlement_pending`). */
const REASON_CODE = /^[a-z][a-z0-9_]{0,99}$/;

/**
 * 1.29.2 (L1-1 step 7): why the seller did not serve the paid retry, in its own words, decoded with the SDK: a failed
 * settlement's `errorReason` (PAYMENT-RESPONSE), else a failed verification's `error` (PAYMENT-REQUIRED). The text is
 * the seller's and goes to the model, so only a reason code is kept; anything else is dropped. It explains the step's
 * error and decides nothing: whether money moved is L3's word alone (INV-10).
 */
function sellerReason(res: Response): string | null {
  const code = (v: unknown) => (typeof v === "string" && REASON_CODE.test(v) ? v : null);
  const settled = res.headers.get("PAYMENT-RESPONSE");
  if (settled !== null) {
    try {
      const answer = decodePaymentResponseHeader(settled);
      const reason = answer.success === false ? code(answer.errorReason) : null;
      if (reason !== null) return reason;
    } catch {
      // Not decodable: L3 judges the header; here it gives no reason.
    }
  }
  const required = res.headers.get("PAYMENT-REQUIRED");
  if (required === null) return null;
  try {
    return code(decodePaymentRequiredHeader(required).error);
  } catch {
    return null;
  }
}

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

  /** 1.19: why this URL is not fetched at all, or null. Nothing is requested for a refused URL. */
  private refusal(url: string): string | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return "not a URL";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https URLs are fetched";
    if (this.deps.allowedHosts !== undefined && !this.deps.allowedHosts.includes(u.host)) return `the host ${u.host} is not one this agent may fetch`;
    return null;
  }

  async fetchPaid(url: string, purpose: string): Promise<PaidFetchResult> {
    const refused = this.refusal(url);
    if (refused !== null) return { outcome: "ERROR", url, error: refused };
    // Step 1: unpaid request. 1.19: redirects are never followed. A redirect would make the answer come from a host
    // L2's R6 and R7 never saw (they judge `url`), and, on the paid retry, carry the signed payment header to it.
    let first: Response;
    try {
      first = await this.fetchImpl(url, { redirect: "manual" });
    } catch (e) {
      return { outcome: "ERROR", url, error: errorMessage(e) };
    }
    if (first.status >= 300 && first.status < 400) {
      return { outcome: "ERROR", url, httpStatus: first.status, error: "the resource redirected; redirects are not followed" };
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
      // 1.19: L2 keeps at most PURPOSE_MAX_CHARS of the model's text, and refuses a longer one.
      purpose: String(purpose).slice(0, PURPOSE_MAX_CHARS),
      createdAt: new Date().toISOString(),
      ...(this.deps.operatorApprovalOnly === true && { operatorApprovalOnly: true }),
    };
    let decision;
    try {
      decision = await this.deps.gate.authorize(intent);
    } catch (e) {
      // 016: L2 refused the caller, not the payment. Say which, never retry, never try another identity (FR-013).
      const refusal = callerRefusal(e);
      return { outcome: "ERROR", url, httpStatus: 402, error: refusal ?? `authorization failed: ${errorMessage(e)}` };
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

    // Step 6: paid retry with L2's headers, unchanged, to the same URL only (1.19: never through a redirect).
    let paid: Response;
    try {
      paid = await this.fetchImpl(url, { headers: decision.paymentHeaders, redirect: "manual" });
    } catch (e) {
      // The signed authorization may still settle; L3 decides from the chain with no PAYMENT-RESPONSE.
      return this.settle(url, decision, payment, 0, null, undefined, `paid request failed: ${errorMessage(e)}`);
    }
    const ok = paid.status >= 200 && paid.status < 300;
    const body = await readBody(paid);
    // 1.29.2: a paid retry the seller didn't serve says why, when the seller gave a reason code.
    const reason = ok ? null : sellerReason(paid);

    // Step 7: claim from the decision plus the raw PAYMENT-RESPONSE header.
    return this.settle(
      url,
      decision,
      payment,
      paid.status,
      paid.headers.get("PAYMENT-RESPONSE"),
      ok ? body : undefined,
      reason === null ? undefined : `the seller answered HTTP ${paid.status}: ${reason}`,
    );
  }

  private async settle(
    url: string,
    decision: { authorizationId: string; requirement: SettlementClaim["requirement"]; payer: string; validBefore: number; nonce?: string },
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
      ...(decision.nonce !== undefined && { nonce: decision.nonce }),
      httpStatus,
      paymentResponseHeader,
    };
    const base = { url, httpStatus, authorizationId: decision.authorizationId, ...(ok && { body }) };
    let report: SettlementReport;
    try {
      report = await this.deps.settlement.verify(claim);
    } catch (e) {
      // Money may have moved: keep the payment details (SPEC v1.1 L1-1 step 8), and the seller's reason before L3's error.
      const verifyError = `settlement verification failed: ${errorMessage(e)}`;
      return { outcome: "PAYMENT_FAILED", ...base, payment, error: priorError === undefined ? verifyError : `${priorError}; ${verifyError}` };
    }
    // Step 8. 1.19: a PENDING with `settlesBy` is no evidence of a settlement (L3 waits to read the nonce), so it is
    // not "settled" here, exactly as the NOT_SETTLED it replaces was not.
    const settled = report.status === "CONFIRMED" || (report.status === "PENDING" && report.settlesBy === undefined);
    return {
      outcome: ok && settled ? "PAID" : "PAYMENT_FAILED",
      ...base,
      payment: { ...payment, settlement: report },
      ...(priorError !== undefined && { error: priorError }),
    };
  }
}
