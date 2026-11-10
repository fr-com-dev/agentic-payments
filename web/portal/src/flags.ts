// The flags a policy can carry (specs/013 US8, FR-034, FR-035): a value the platform now limits, and a seller the
// operator no longer lists. Words, built from the platform's current limits.
import { formatUsdcFixed } from "./money.js";
import type { Limits, Policy } from "./types.js";

/** `per payment up to 0.05 USDC`, for one field of `limitedByPlatform`. */
export function limitText(field: string, limits: Limits, decimals: number): string {
  const usdc = (atomic: string) => `${formatUsdcFixed(atomic, decimals)} USDC`;
  switch (field) {
    case "hardCapPerPaymentAtomic":
      return `per payment up to ${usdc(limits.hardCapPerPaymentAtomic)}`;
    case "sessionBudgetAtomic":
      return `per agent run up to ${usdc(limits.sessionBudgetAtomic)}`;
    case "dailyBudgetAtomic":
      return `per day up to ${usdc(limits.userDailyCeilingAtomic)}`;
    case "maxAuthorizationsPerMinute":
      return `at most ${limits.maxAuthorizationsPerMinute} payments a minute`;
    default:
      return "a value above the platform's limit";
  }
}

/** Every flag of a policy as a sentence. */
export function policyFlags(p: Pick<Policy, "limitedByPlatform" | "unlistedSellers">, limits: Limits, decimals: number): string[] {
  const out: string[] = [];
  if (p.limitedByPlatform.length > 0) {
    out.push(`Limited by the platform: ${p.limitedByPlatform.map((f) => limitText(f, limits, decimals)).join(", ")}`);
  }
  for (const host of p.unlistedSellers) out.push(`Seller no longer available: ${host}`);
  return out;
}
