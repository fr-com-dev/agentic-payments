// L1-6 the account question (SPEC.md §8.1 L1-6, L2-5; specs/019 contracts/hosted-agent-api.md "The account question").
// Before a person's run the hosted agent asks L2, once, through that run's own gate, whether the person can pay now.
// L2 answers from its ledger, for the person in the token it verified itself (`account` on the budget user view), so
// nothing the agent sends names the person. A refusal here costs no model call and no payment request.
// - Ready: the run starts. Not onboarded, disabled, or person accounts off at this L2: 409, with a code per reason.
// - The forwarded token expired between the agent's check and L2's: 401 `token_expired`, as for any expired token.
// - Anything else (no answer within the bound, a network error, another status or code, an answer without `account`):
//   503 `control_unavailable`. The agent can't know whether the person can pay, so it starts nothing (NFR-001).
// L2's answer and error text never reach the caller or a log: the bodies below are fixed (SEC-16).
import type { AuthorizationGatePort } from "../../shared/contracts.js";
import { PortHttpError } from "../ports-http.js";

/** NFR-005: the question adds at most this to the start of a person's run. */
export const ACCOUNT_CHECK_TIMEOUT_MS = 1_000;

export interface AccountRefusal {
  ok: false;
  status: 401 | 409 | 503;
  body: { error: string; error_code: string };
  /** Answer with the bearer challenge, as every 401 of the agent does. */
  challenge?: true;
}
export type AccountCheck = { ok: true } | AccountRefusal;

const notReady = (error_code: "account_not_onboarded" | "account_disabled" | "accounts_off"): AccountRefusal => ({
  ok: false,
  status: 409,
  body: { error: "account not ready", error_code },
});
const UNAVAILABLE: AccountRefusal = { ok: false, status: 503, body: { error: "control unavailable", error_code: "control_unavailable" } };
const EXPIRED: AccountRefusal = { ok: false, status: 401, body: { error: "unauthorized", error_code: "token_expired" }, challenge: true };

/** One budget call, raced against the bound, mapped by the contract's table. Never throws. */
export async function checkAccount(gate: Pick<AuthorizationGatePort, "budget">, sessionId: string, o: { timeoutMs?: number } = {}): Promise<AccountCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), o.timeoutMs ?? ACCOUNT_CHECK_TIMEOUT_MS);
  });
  try {
    // Promise.race subscribes to both, so a budget call that fails after the bound is still handled.
    const answer = await Promise.race([gate.budget(sessionId), timedOut]);
    if (answer === "timeout") return UNAVAILABLE;
    switch (answer.account) {
      case "ready":
        return { ok: true };
      case "not_onboarded":
        return notReady("account_not_onboarded");
      case "disabled":
        return notReady("account_disabled");
      default:
        return UNAVAILABLE;
    }
  } catch (e) {
    if (e instanceof PortHttpError) {
      if (e.status === 403 && e.code === "user_accounts_off") return notReady("accounts_off");
      if (e.status === 401 && e.code === "caller_token_expired") return EXPIRED;
    }
    return UNAVAILABLE;
  } finally {
    clearTimeout(timer);
  }
}
