// What changed between two versions of a policy, in words (specs/013 FR-047). Pure: the history screen shows it
// under each "Changed" entry. Amounts are compared and shown as exact atomic strings, never as numbers.
import { formatUsdcFixed } from "./money.js";
import { formatDay } from "./summary.js";
import type { PolicyValues, Seller } from "./types.js";

const AMOUNTS: Array<[keyof PolicyValues, string]> = [
  ["autoApproveMaxAtomic", "Without asking"],
  ["hardCapPerPaymentAtomic", "Per payment"],
  ["sessionBudgetAtomic", "Per agent run"],
  ["dailyBudgetAtomic", "Per day"],
];

/** One sentence per difference, in the editor's order. Empty when the two versions hold the same values. */
export function describeChanges(before: PolicyValues, after: PolicyValues, sellers: readonly Seller[], decimals: number): string[] {
  const nameOf = (host: string) => {
    const seller = sellers.find((s) => s.host === host);
    return seller ? `${seller.name} (${host})` : host;
  };
  const out: string[] = [];
  for (const host of after.sellers) if (!before.sellers.includes(host)) out.push(`Seller added: ${nameOf(host)}.`);
  for (const host of before.sellers) if (!after.sellers.includes(host)) out.push(`Seller removed: ${nameOf(host)}.`);
  for (const [key, label] of AMOUNTS) {
    const was = String(before[key]);
    const now = String(after[key]);
    if (was !== now) out.push(`${label}: was ${formatUsdcFixed(was, decimals)} USDC, now ${formatUsdcFixed(now, decimals)} USDC.`);
  }
  if (before.maxAuthorizationsPerMinute !== after.maxAuthorizationsPerMinute) {
    out.push(`Payments per minute: was ${before.maxAuthorizationsPerMinute}, now ${after.maxAuthorizationsPerMinute}.`);
  }
  if (before.expiresAt !== after.expiresAt) out.push(`End date: was ${formatDay(before.expiresAt)}, now ${formatDay(after.expiresAt)}.`);
  return out;
}
