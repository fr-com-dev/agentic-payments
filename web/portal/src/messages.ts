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

/** 014: why an administrator rejects a payment. A fixed list: there is no text field (FR-016). */
export const REASON_LABELS: Record<string, string> = {
  not_expected: "I didn't expect this payment",
  amount_too_high: "The amount is too high",
  wrong_seller: "It is the wrong seller",
  duplicate: "It is a duplicate",
  other: "Another reason",
};

/** 014: where a decision was made, in words. */
export const CHANNEL_TEXT: Record<string, string> = { portal: "in the portal", operator: "from the command line", backchannel: "by phone" };

/** 014: a decision arrived too late: how the payment actually ended, and on which path. Nothing was recorded. */
export function notPendingMessage(e: Pick<ApiError, "state" | "channel">): string {
  const where = e.channel !== undefined && CHANNEL_TEXT[e.channel] !== undefined ? `, ${CHANNEL_TEXT[e.channel]}` : "";
  if (e.state === "approved") return `This payment was already approved${where}.`;
  if (e.state === "denied") return `This payment was already rejected${where}.`;
  if (e.state === "expired") return "This payment expired before it was decided.";
  return "This payment is no longer waiting.";
}

/** One sentence for a failure that is not about a field. */
export function errorMessage(e: ApiError): string {
  if (e.status === 0) return "The portal can't be reached. Check your connection and try again.";
  switch (e.error) {
    case "unauthorized":
      return "Your sign-in has ended. Sign in again.";
    case "forbidden":
      return "This sign-in can't be used for the portal. Sign in again from this page.";
    // 014 the administration area
    case "own_payment":
      return "You can't decide your own payment.";
    case "not_pending":
      return notPendingMessage(e);
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
    // 020 connected platforms
    case "not_ready":
      return "Coinbase can't be connected on this deployment yet.";
    case "not_connected":
      return "Coinbase isn't connected.";
    default:
      return "Something went wrong. Nothing was changed.";
  }
}

// ---------------------------------------------------------------------------
// 020 connected platforms (specs/020 contracts/portal-ui.md). "Coinbase" is plain text everywhere: no logo and no
// button artwork (research R8). Nothing Coinbase says (an error's description, a name) is part of a sentence here.
// ---------------------------------------------------------------------------

/** Where a person removes the portal's access in Coinbase themselves (research R8). */
export const COINBASE_CONNECTIONS_URL = "https://accounts.coinbase.com/security/connections";

export const AGENT_PAYS_TITLE = "Your agent pays from this";
export const COINBASE_PART_TITLE = "Coinbase · View only";
export const COINBASE_READ_ONLY_TEXT = "See your Coinbase balances here. The portal will only read them: your agent can't spend Coinbase funds.";
export const COINBASE_RECONNECT_TEXT = "Coinbase no longer accepts this connection. Reconnect to see your balances.";
export const COINBASE_UNAVAILABLE_TEXT = "Coinbase isn't available on this deployment.";
export const GOING_TO_COINBASE_TEXT = "Going to Coinbase…";
/** A start the portal answered with an address the web app won't go to. */
export const START_FAILED_TEXT = "Something went wrong. Nothing was connected.";

// The return screen, one sentence per answer (contracts/portal-ui.md "Connecting").
export const COINBASE_CONNECTED_TEXT = "Coinbase connected.";
export const NOTHING_CONNECTED_TEXT = "Nothing was connected.";
export const INVALID_STATE_TEXT = "This connection wasn't started here, or took too long. Nothing was connected.";
export const SCOPE_TOO_NARROW_TEXT = "Coinbase didn't give permission to read your balances. Nothing was connected.";
export const SCOPE_TOO_WIDE_TEXT = "Coinbase gave more access than reading. We refused it and nothing was connected.";
export const COINBASE_UNREACHABLE_TEXT = "Coinbase couldn't be reached. Nothing was connected. Try again later.";

/** Why `complete` didn't connect, and whether starting again can help. */
export function connectRefusal(e: ApiError): { message: string; retry: boolean } {
  if (e.error === "invalid_state" || e.error === "invalid_request") return { message: INVALID_STATE_TEXT, retry: true };
  if (e.error === "scope_refused" && e.reason === "too_narrow") return { message: SCOPE_TOO_NARROW_TEXT, retry: true };
  // Starting again would bring back the same wide grant.
  if (e.error === "scope_refused") return { message: SCOPE_TOO_WIDE_TEXT, retry: false };
  // Coinbase (platform_unavailable), L2 (control_unavailable) or the grant store (unavailable).
  if (e.status === 502 || e.status === 503) return { message: COINBASE_UNREACHABLE_TEXT, retry: false };
  return { message: errorMessage(e), retry: false };
}

// The balances (contracts/portal-ui.md "The balances").
export const NO_RATE_TEXT = "no rate from Coinbase";
export const NO_FUNDS_TEXT = "Your Coinbase account holds no funds.";
export const BALANCES_READING_TEXT = "Reading your Coinbase balances…";
export const BALANCES_UNREADABLE_TEXT = "Couldn't read your Coinbase balances. Try again in a moment.";
export const staleBalancesText = (time: string): string => `Couldn't reach Coinbase. These figures are from ${time}.`;
export const totalLabel = (time: string): string => `Total in US dollars (at Coinbase's rates, ${time})`;
export const notCountedText = (codes: readonly string[]): string => `Not counted: ${codes.join(", ")}`;
export const moreAssetsText = (n: number, atLeast = false): string => `and ${atLeast ? "at least " : ""}${String(n)} more ${n === 1 && !atLeast ? "asset" : "assets"}`;

// Disconnecting (contracts/portal-ui.md "Disconnecting").
export const DISCONNECT_QUESTION = "Disconnect Coinbase?";
export const DISCONNECT_TEXT = "The portal will forget its access and stop showing these balances.";
export const DISCONNECTED_TEXT = "Coinbase disconnected.";
export const NOT_REVOKED_TEXT = "Disconnected here. Coinbase didn't confirm, so also remove the access in Coinbase:";
