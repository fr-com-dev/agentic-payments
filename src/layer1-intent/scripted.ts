// L1-4 Scripted agent (SPEC.md §8.1): the fixed, LLM-free regression baseline.
// Expected outcomes with the default mandate: [FREE, PAID, PAID, ESCALATED, DENIED, DENIED].
import type { PaidFetchResult, PaidResourceOrchestrator } from "./orchestrator.js";

export interface ScriptedStep {
  url: string;
  purpose: string;
}

/** The six steps of SPEC L1-4. Step 6 is step 2 through the `localhost` alias (same port). */
export function scriptedPlan(sellerUrl: string): ScriptedStep[] {
  const base = new URL(sellerUrl);
  const at = (path: string) => new URL(path, base).toString();
  const alias = new URL("/api/weather?city=Lima", base);
  alias.hostname = "localhost";
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
  for (const [i, step] of scriptedPlan(opts.sellerUrl).entries()) {
    const r = await opts.orchestrator.fetchPaid(step.url, step.purpose);
    results.push(r);
    log(describeResult(i + 1, r));
  }
  return results;
}
