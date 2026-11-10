// What the portal's error codes mean, in plain words (specs/013 FR-026: every refusal tells the person what to fix).
// The server sends codes and limits, never sentences; nothing typed by a person or said by an outside service is
// echoed here.
import { formatUsdcFixed } from "./money.js";
import type { ApiError } from "./api.js";
import type { Issue, Policy, Seller } from "./types.js";

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  autoApproveUsdc: "Without asking",
  perPaymentUsdc: "Per payment",
  perRunUsdc: "Per agent run",
  perDayUsdc: "Per day",
  paymentsPerMinute: "Payments per minute",
  endsOn: "End date",
  sellers: "Sellers",
  paymentMethod: "Payment method",
  displayName: "Name",
  contactEmail: "Contact email",
  acknowledgedTestFunds: "Test funds",
};

/** The form field an issue belongs to (`sellers[2]` → `sellers`). */
export const issueField = (issue: Issue): string => issue.field.replace(/\[\d+\]$/, "");

export interface IssueContext {
  decimals: number;
  sellers?: readonly Seller[];
  policies?: readonly Policy[];
}

export function issueMessage(issue: Issue, c: IssueContext): string {
  const label = FIELD_LABELS[issueField(issue)] ?? "This value";
  const seller = issue.host !== undefined ? (c.sellers?.find((s) => s.host === issue.host)?.name ?? issue.host) : "This seller";
  switch (issue.code) {
    case "invalid_name":
      return `${label}: enter a name (at most ${issueField(issue) === "name" ? 60 : 80} characters).`;
    case "invalid_email":
      return "Contact email: enter an email address like name@example.com.";
    case "required":
      return "Tick the box to confirm that this wallet holds test funds only.";
    case "not_a_number":
    case "not_atomic":
      return `${label}: enter an amount in USDC, like 0.02.`;
    case "negative":
      return `${label}: the amount can't be negative.`;
    case "too_many_decimals":
      return `${label}: USDC has at most ${c.decimals} decimals. The amount is never rounded for you.`;
    case "order_auto_below_cap":
      return "Without asking: it must be less than the per-payment amount.";
    case "order_cap_within_session":
      return "Per payment: it can't be more than the per-run budget.";
    case "above_platform_limit":
      return issue.limitAtomic !== undefined
        ? `${label}: the most allowed is ${formatUsdcFixed(issue.limitAtomic, c.decimals)} USDC.`
        : `${label}: the most allowed is ${String(issue.limit)}.`;
    case "rate_invalid":
      return "Payments per minute: enter a whole number, 1 or more.";
    case "no_sellers":
      return "Sellers: choose at least one seller.";
    case "too_many_sellers":
      return `Sellers: choose at most ${String(issue.limit ?? 20)}.`;
    case "seller_not_listed":
      return `${seller} is no longer available. Remove it from this policy.`;
    case "seller_conflict": {
      const other = c.policies?.find((p) => p.policyId === issue.policyId)?.name;
      return other !== undefined ? `${seller} is already in your policy "${other}". A seller can be in one active policy.` : `${seller} is already in another active policy of yours.`;
    }
    case "invalid_date":
      return "End date: choose a date.";
    case "expires_in_past":
      return "End date: choose a date after today.";
    case "expires_too_late":
      return `End date: it can be at most ${String(issue.limit ?? "")} days from today.`;
    case "payment_method_unsupported":
      return "Payment method: only your crypto account can pay. Cards are not available yet.";
    case "policy_limit":
      return `You already have ${String(issue.limit ?? 10)} active policies. Pause or remove one first.`;
    default:
      return `${label}: this value was not accepted.`;
  }
}

/** One sentence for a failure that is not about a field. */
export function errorMessage(e: ApiError): string {
  if (e.status === 0) return "The portal can't be reached. Check your connection and try again.";
  switch (e.error) {
    case "unauthorized":
      return "Your sign-in has ended. Sign in again.";
    case "forbidden":
      return "Your organization has not given you access to start agent runs.";
    case "control_unavailable":
      return "The payment service can't be reached right now. Nothing was changed. Try again in a moment.";
    case "too many requests":
      return "Too many requests. Wait a moment and try again.";
    case "account_disabled":
      return "Your account is disabled. Enable it to make changes.";
    case "profile_required":
      return "Complete your profile first.";
    case "wallet_required":
      return "Create your wallet first.";
    case "policy_removed":
      return "This policy was removed and can't be changed.";
    case "card_limit":
      return "You can register at most 5 cards. Remove one first.";
    case "card_already_registered":
      return "This card is already registered.";
    case "card_expired":
      return "This card has expired.";
    case "not_a_card":
      return "Only cards can be registered.";
    case "card_not_confirmed":
      return e.vaultCode === "card_declined" || e.vaultCode === "expired_card" || e.vaultCode === "incorrect_cvc"
        ? "The card was not accepted. Check its details or try another card."
        : "The card could not be confirmed. Try again.";
    case "cards_unavailable":
      return "Cards are not available here.";
    case "card_vault_unavailable":
      return "The card could not be added. Try again later.";
    case "version_conflict":
      return "This policy was changed in another window. Reload it and try again.";
    case "step_up_required":
      return "Confirm it's you to make this change.";
    case "not found":
      return "Not found.";
    default:
      return "Something went wrong. Nothing was changed.";
  }
}
