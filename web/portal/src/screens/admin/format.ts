// 014 how the administration area words things (specs/014 contracts/portal-ui.md). Pure functions, so the wording
// and the countdown are tested without a screen. Nothing here ever turns text from outside into markup.
import { CHANNEL_TEXT, REASON_LABELS } from "../../messages.js";
import { formatUsdcFixed } from "../../money.js";
import type { AdminEscalation, AdminEvent } from "../../types.js";

/** Agents pay in USDC only (Constitution VII), which has 6 decimals. */
export const USDC_DECIMALS = 6;
export const usdc = (atomic: string): string => `${formatUsdcFixed(atomic, USDC_DECIMALS)} USDC`;

/** A user is shown by identifier only: the last 8 characters, with the whole value as the accessible name. */
export const shortUserId = (userId: string): string => `…${userId.slice(-8)}`;

export function ownerText(owner: AdminEscalation["owner"]): string {
  return owner.userId !== undefined ? `User ${shortUserId(owner.userId)}` : "Platform account";
}
export function ownerName(owner: AdminEscalation["owner"]): string {
  return owner.userId !== undefined ? `User ${owner.userId}` : "Platform account";
}

/** The seller's host and the resource's path, from the resource address. Text from outside: only ever shown as text. */
export function sellerOf(resourceKey: string): { host: string; path: string } {
  try {
    const u = new URL(resourceKey);
    return { host: u.host, path: `${u.pathname}${u.search}` };
  } catch {
    return { host: resourceKey, path: "" };
  }
}

/** Time left in words, never by color: "4 min 12 s", "under 1 min (42 s)", "Expired". */
export function timeLeftText(ms: number): string {
  if (ms <= 0) return "Expired";
  const total = Math.ceil(ms / 1000);
  if (total < 60) return `under 1 min (${String(total)} s)`;
  return `${String(Math.floor(total / 60))} min ${String(total % 60)} s`;
}

/** The approver's phone request, in one word, when backchannel approval is on. */
export function phoneText(approvalRequest: string | undefined): string {
  switch (approvalRequest) {
    case undefined:
      return "";
    case "requested":
    case "abandoned":
      return "Asked";
    case "answered":
      return "Answered";
    case "lapsed":
      return "No answer";
    case "failed":
    case "verification_failed":
      return "Failed";
    default:
      return "Not asked";
  }
}

/** A clock time for "Read at …": hours, minutes and seconds in the person's own locale. */
export const clockTime = (iso: string): string => new Date(iso).toLocaleTimeString();

/** "1 new payment is waiting" / "3 new payments are waiting". */
export const newPaymentsText = (n: number): string => (n === 1 ? "1 new payment is waiting" : `${String(n)} new payments are waiting`);

/** A decider as shown: an identifier shortened, anything else (an operator's label, a phone approver's subject) as it is. */
export const deciderText = (decidedBy: string | undefined): string => (decidedBy === undefined ? "" : decidedBy.startsWith("usr_") ? shortUserId(decidedBy) : decidedBy);

const STEP_TEXT: Record<string, string> = {
  escalated: "Asked for approval",
  approval_requested: "Phone request sent",
  approval_request_failed: "Phone request failed",
  approval_request_lapsed: "Phone request not answered",
  approval_verification_failed: "Phone answer not accepted",
  expired: "Expired",
  approval_lapsed: "Approval not used in time",
};

/**
 * What happened, in words (specs/014 contracts/portal-ui.md "Activity"). A decision names its path and who decided;
 * a portal rejection adds its reason's label; an operator's own words are added as they are. The result is a plain
 * string: whatever an operator typed can only ever be shown as text.
 */
export function eventText(e: Pick<AdminEvent, "kind" | "channel" | "decidedBy" | "reasonCode" | "reason">): string {
  if (e.kind !== "approved" && e.kind !== "denied") return STEP_TEXT[e.kind] ?? e.kind;
  const where = e.channel !== undefined ? (CHANNEL_TEXT[e.channel] ?? "") : "";
  const who = deciderText(e.decidedBy);
  const head = [e.kind === "approved" ? "Approved" : "Rejected", where, who !== "" ? `by ${who}` : ""].filter((part) => part !== "").join(" ");
  const why = e.reasonCode !== undefined ? (REASON_LABELS[e.reasonCode] ?? "") : (e.reason ?? "");
  return why !== "" ? `${head}: ${why}` : head;
}
