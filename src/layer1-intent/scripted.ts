// L1-4 Scripted agent (SPEC.md §8.1): the fixed, LLM-free regression baseline.
// Expected outcomes with the default mandate: [FREE, PAID, PAID, ESCALATED, DENIED, DENIED].
import type { PaidFetchResult, PaidResourceOrchestrator } from "./orchestrator.js";

export interface ScriptedStep {
  url: string;
  purpose: string;
}

/**
 * The six steps of SPEC L1-4. Step 6 is step 2 through a host L2 does not allow: the `localhost` alias of
 * the same seller (same port) by default, or `aliasUrl` when given (v1.5: a second seller host in the cloud,
 * where `localhost` reaches nothing).
 */
export function scriptedPlan(sellerUrl: string, aliasUrl?: string): ScriptedStep[] {
  const base = new URL(sellerUrl);
  const at = (path: string) => new URL(path, base).toString();
  const alias = new URL("/api/weather?city=Lima", aliasUrl ?? base);
  if (aliasUrl === undefined) alias.hostname = "localhost";
  return [
    { url: at("/api/catalog"), purpose: "read the catalog" },
    { url: at("/api/weather?city=Lima"), purpose: "weather for Lima" },
    { url: at("/api/market-brief"), purpose: "market brief" },
    { url: at("/api/premium-report"), purpose: "premium report" },
    { url: at("/api/dataset-export"), purpose: "dataset export" },
    { url: alias.toString(), purpose: "weather for Lima via host alias" },
  ];
}

export interface ScriptedAgentOptions {
  orchestrator: Pick<PaidResourceOrchestrator, "fetchPaid">;
  sellerUrl: string;
  /** Step 6's seller host (SELLER_ALIAS_URL); default: the localhost alias of `sellerUrl`. */
  aliasUrl?: string;
  log?: (line: string) => void;
}

export function describeResult(i: number, r: PaidFetchResult): string {
  const parts = [`${i}. ${r.outcome}`, r.url];
  if (r.payment) parts.push(`amount=${r.payment.amountAtomic}`, `settlement=${r.payment.settlement?.status ?? "unknown"}`);
  if (r.payment?.settlement?.transaction) parts.push(`tx=${r.payment.settlement.transaction}`);
  if (r.violations?.length) parts.push(`rules=${r.violations.map((v) => v.rule).join(",")}`);
  if (r.authorizationId) parts.push(`authorizationId=${r.authorizationId}`);
  if (r.error) parts.push(`error=${r.error}`);
  return parts.join(" ");
}

export async function runScriptedAgent(opts: ScriptedAgentOptions): Promise<PaidFetchResult[]> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const results: PaidFetchResult[] = [];
  for (const [i, step] of scriptedPlan(opts.sellerUrl, opts.aliasUrl).entries()) {
    const r = await opts.orchestrator.fetchPaid(step.url, step.purpose);
    results.push(r);
    log(describeResult(i + 1, r));
  }
  return results;
}

/** The L1-4 regression baseline (§12, T-E2E-01). */
export const BASELINE_OUTCOMES: readonly PaidFetchResult["outcome"][] = ["FREE", "PAID", "PAID", "ESCALATED", "DENIED", "DENIED"];

/** `--check-baseline` (v1.5): the six outcomes in order, and both payments settled CONFIRMED. */
export function checkBaseline(results: readonly PaidFetchResult[]): { ok: boolean; detail: string } {
  const outcomes = results.map((r) => r.outcome);
  const detail = outcomes.join(", ");
  if (outcomes.length !== BASELINE_OUTCOMES.length || outcomes.some((o, i) => o !== BASELINE_OUTCOMES[i])) {
    return { ok: false, detail: `outcomes ${detail}; expected ${BASELINE_OUTCOMES.join(", ")}` };
  }
  const unsettled = results.filter((r) => r.outcome === "PAID" && r.payment?.settlement?.status !== "CONFIRMED");
  if (unsettled.length > 0) {
    return { ok: false, detail: `${unsettled.map((r) => `${r.url} settlement=${r.payment?.settlement?.status ?? "unknown"}`).join("; ")}` };
  }
  return { ok: true, detail };
}
