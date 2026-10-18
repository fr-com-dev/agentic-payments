// Pure policy engine (SPEC.md §8.2 L2-2). Owner: feature 002.
// INV-5: the decision is a pure function of (accepts, mandate, context). No I/O, no clock reads
// (time is ctx.nowMs), no randomness, and the agent's free text is never an input.
import type { PaymentRequirements } from "@x402/core/types";
import type { PolicyViolation } from "../shared/contracts.js";
import type { SpendingMandate } from "./mandate.js";

export interface PolicyContext {
  nowMs: number;
  requestedUrl: string;
  challengeResourceUrl: string;
  sessionCommittedAtomic: bigint;
  dailyCommittedAtomic: bigint;
  authorizationsLastMinute: number;
  humanApprovedFor?: { payTo: string; amount: string; approvalId: string };
  /** 010: present when an operator rejected this (session, resourceKey). Drives R15. */
  humanRejected?: { rejectionId: string };
}

export type EvalStatus = "AUTHORIZED" | "DENIED" | "ESCALATE";

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host.length > 0 ? u.host : null;
  } catch {
    return null;
  }
}

/** Evaluates one offered requirement against the mandate (rules R1–R15, in SPEC table order). */
export function evaluateRequirement(
  req: PaymentRequirements,
  m: SpendingMandate,
  ctx: PolicyContext,
): { status: EvalStatus; violations: PolicyViolation[] } {
  const v: PolicyViolation[] = [];
  const deny = (rule: string, detail: string) => v.push({ rule, detail });

  // R1
  if (ctx.nowMs > Date.parse(m.expiresAt)) deny("mandate_expired", `mandate expired at ${m.expiresAt}`);
  // R2
  if (!m.allowedSchemes.includes(req.scheme)) deny("scheme_not_allowed", `scheme ${req.scheme} not allowed`);
  // R3
  if (!m.allowedNetworks.includes(req.network)) deny("network_not_allowed", `network ${req.network} not allowed`);
  // R4
  const assets = m.allowedAssets[req.network] ?? [];
  if (!assets.includes(String(req.asset).toLowerCase())) deny("asset_not_allowed", `asset ${req.asset} not allowed`);
  // R5
  if (m.allowedPayees.length > 0 && !m.allowedPayees.includes(String(req.payTo).toLowerCase())) {
    deny("payee_not_allowed", `payee ${req.payTo} not allowed`);
  }
  // R6
  const requestedHost = hostOf(ctx.requestedUrl);
  if (requestedHost === null || !m.allowedHosts.includes(requestedHost)) {
    deny("host_not_allowed", `host ${requestedHost ?? "(invalid)"} not allowed`);
  }
  // R7
  const challengeHost = hostOf(ctx.challengeResourceUrl);
  if (challengeHost !== requestedHost) {
    deny("resource_binding_mismatch", `challenge host ${challengeHost ?? "(invalid)"} ≠ requested host ${requestedHost ?? "(invalid)"}`);
  }
  // R8
  const t = req.maxTimeoutSeconds;
  if (!(typeof t === "number" && t > 0 && t <= m.maxTimeoutSeconds)) {
    deny("timeout_out_of_range", `maxTimeoutSeconds ${t} not in (0, ${m.maxTimeoutSeconds}]`);
  }
  // R9: return immediately, the amount cannot be used by later rules.
  const raw = String(req.amount);
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    deny("amount_invalid", `amount "${raw}" is not a positive integer`);
    return { status: "DENIED", violations: v };
  }
  const amount = BigInt(raw);
  // R10
  if (amount > BigInt(m.hardCapPerPaymentAtomic)) deny("hard_cap_exceeded", `${amount} > ${m.hardCapPerPaymentAtomic}`);
  // R11
  const sessionCap = BigInt(m.sessionBudgetAtomic);
  if (ctx.sessionCommittedAtomic + amount > sessionCap) {
    deny("session_budget_exceeded", `${ctx.sessionCommittedAtomic} + ${amount} > ${sessionCap}`);
  }
  // R12
  const dailyCap = BigInt(m.dailyBudgetAtomic);
  if (ctx.dailyCommittedAtomic + amount > dailyCap) {
    deny("daily_budget_exceeded", `${ctx.dailyCommittedAtomic} + ${amount} > ${dailyCap}`);
  }
  // R13
  if (ctx.authorizationsLastMinute >= m.maxAuthorizationsPerMinute) {
    deny("velocity_limit", `${ctx.authorizationsLastMinute} authorizations in the last 60 s (max ${m.maxAuthorizationsPerMinute})`);
  }
  // R15 (010): an operator rejected this (session, resource). The detail carries only the ID, never
  // operator free text, because violations reach the LLM agent (SEC-12).
  if (ctx.humanRejected) deny("human_rejected", `rejected by the operator (${ctx.humanRejected.rejectionId})`);
  if (v.length > 0) return { status: "DENIED", violations: v };

  // R14: only when nothing denies. An approval lifts it for the exact payee and amount string.
  if (amount > BigInt(m.autoApproveMaxAtomic)) {
    const a = ctx.humanApprovedFor;
    const approved = a !== undefined && a.payTo.toLowerCase() === String(req.payTo).toLowerCase() && a.amount === raw;
    if (!approved) {
      return {
        status: "ESCALATE",
        violations: [{ rule: "human_approval_required", detail: `${amount} > auto-approve limit ${m.autoApproveMaxAtomic}` }],
      };
    }
  }
  return { status: "AUTHORIZED", violations: [] };
}

/**
 * Chooses across all offered requirements (L2-2 decide):
 * the cheapest AUTHORIZED one (ties go to the first offered), else the first ESCALATE, else DENIED.
 */
export function decide(
  accepts: readonly PaymentRequirements[],
  m: SpendingMandate,
  ctx: PolicyContext,
): { status: EvalStatus; chosen?: PaymentRequirements; violations: PolicyViolation[] } {
  if (accepts.length === 0) {
    return { status: "DENIED", violations: [{ rule: "no_payment_options", detail: "the challenge offers no payment options" }] };
  }
  const evals = accepts.map((req) => ({ req, ...evaluateRequirement(req, m, ctx) }));
  let best: (typeof evals)[number] | undefined;
  for (const e of evals) {
    if (e.status !== "AUTHORIZED") continue;
    if (best === undefined || BigInt(e.req.amount) < BigInt(best.req.amount)) best = e;
  }
  if (best) return { status: "AUTHORIZED", chosen: best.req, violations: [] };
  const esc = evals.find((e) => e.status === "ESCALATE");
  if (esc) return { status: "ESCALATE", chosen: esc.req, violations: esc.violations };
  return { status: "DENIED", violations: evals.flatMap((e) => e.violations) };
}
