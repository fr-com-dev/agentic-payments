// The plain-language summary of a policy (specs/013 FR-027, SC-013; contracts/portal-ui.md "Policy editor").
// A pure function: the editor shows it before saving, and the list and the history show the same text for a saved
// version. A person must be able to tell from it alone what their agent may spend, where, and when they are asked.
import { formatUsdcFixed } from "./money.js";
import type { Limits, PolicyValues, Seller } from "./types.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `31 Dec 2027`, from an ISO time, in UTC (the policy ends at the end of that UTC day). */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const joinNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export interface PolicySummary {
  /** One sentence per line, in reading order. Plain text: never HTML. */
  lines: string[];
}

export function summarizePolicy(values: PolicyValues, sellers: readonly Seller[], limits: Pick<Limits, "userDailyCeilingAtomic">, decimals: number): PolicySummary {
  const usdc = (atomic: string) => `${formatUsdcFixed(atomic, decimals)} USDC`;
  const where = joinNames(
    values.sellers.map((host) => {
      const seller = sellers.find((s) => s.host === host);
      return seller ? `${seller.name} (${host})` : host;
    }),
  );
  const lines: string[] = [];
  const atAuto = values.autoApproveMaxAtomic;
  const atCap = values.hardCapPerPaymentAtomic;
  if (values.sellers.length === 0) {
    lines.push("No seller is chosen yet, so your agent can pay nowhere under this policy.");
  } else if (/^0+$/.test(atAuto)) {
    lines.push("Every payment needs a person's approval.");
    lines.push(`Your agent may ask to pay at ${where}, up to ${usdc(atCap)} per payment.`);
  } else {
    lines.push(`At ${where}: your agent pays up to ${usdc(atAuto)} per payment without asking.`);
    lines.push(`From ${formatUsdcFixed(atAuto, decimals)} up to ${usdc(atCap)} a person must approve first.`);
  }
  lines.push(`Above ${usdc(atCap)} it is refused.`);
  lines.push(
    `At most ${usdc(values.sessionBudgetAtomic)} per agent run and ${usdc(values.dailyBudgetAtomic)} per day, at most ${values.maxAuthorizationsPerMinute} payments a minute, until ${formatDay(values.expiresAt)}.`,
  );
  lines.push(`Across all your policies you can spend at most ${usdc(limits.userDailyCeilingAtomic)} in any 24 hours.`);
  return { lines };
}
