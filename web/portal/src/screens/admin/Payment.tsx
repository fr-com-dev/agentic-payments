// 014 US2, US4: one payment, the budget behind it, and the two decisions (specs/014 contracts/portal-ui.md "One
// payment"; FR-011 to FR-017, FR-022 to FR-024). The screen shows a payment in any state: what it is, how it ended
// when it has, and the budget it counts against. While it is pending, and not the administrator's own, they can
// approve or reject it. Who decides and when they last signed in come from their token, never from this screen. An
// approval asks them to confirm their identity when their sign-in is older than 15 minutes; a rejection never does,
// and takes one of five fixed reasons: there is no text field anywhere here.
import { useCallback, useEffect, useState } from "react";
import type { ApiError, ApiResult } from "../../api.js";
import { Link } from "../../components/Link.js";
import { useStepUp } from "../../components/StepUp.js";
import { Banner, Dialog, ScreenHeading } from "../../components/ui.js";
import { useApp } from "../../context.js";
import { CHANNEL_TEXT, errorMessage, REASON_LABELS } from "../../messages.js";
import type { AdminEscalation, AdminEscalationDetail, BudgetLine, DecisionOutcome, EscalationBudget, RejectionReasonCode } from "../../types.js";
import { deciderText, ownerName, ownerText, sellerOf, timeLeftText, usdc } from "./format.js";
import { useNow } from "./Waiting.js";

export const APPROVE_STEP_UP_TEXT = "Confirm it's you to approve.";
export const APPROVE_TEXT = "Approve this one payment? The agent can then make it once, if it still fits the rules.";
export const OWN_PAYMENT_TEXT = "This is a payment of your own agent run. Another administrator, the operator or the phone approver can decide it.";
export const NO_SUCH_PAYMENT_TEXT = "No payment has this reference.";
export const WILL_NOT_FIT_TEXT = "Approving this will not make it payable: it is more than what is left.";
export const NOT_APPLYING_TEXT: Record<string, string> = {
  no_active_policy: "No rule set of this user allows this seller right now, so approving will not make it payable.",
  user_disabled: "This user's account is disabled, so approving will not make it payable.",
  user_not_onboarded: "This user has not finished setting up, so approving will not make it payable.",
};
const REASONS = Object.keys(REASON_LABELS) as RejectionReasonCode[];

/** "Approved in the portal by …4f2a." / "Rejected from the command line by ops." Text from outside stays text. */
export function outcomeText(o: { state: string; channel: string; decidedBy: string }): string {
  const verb = o.state === "approved" ? "Approved" : "Rejected";
  return [verb, CHANNEL_TEXT[o.channel] ?? "", `by ${deciderText(o.decidedBy)}.`].filter((part) => part !== "").join(" ");
}

/** How a payment that is no longer pending ended, in one sentence. */
export function endedText(d: Pick<AdminEscalationDetail, "state" | "decision" | "expiresAt">): string {
  if (d.state === "expired" || d.decision === undefined) return `Expired at ${new Date(d.expiresAt).toLocaleTimeString()}.`;
  const base = outcomeText({ state: d.state, channel: d.decision.channel, decidedBy: d.decision.decidedBy });
  const why = d.decision.reasonCode !== undefined ? (REASON_LABELS[d.decision.reasonCode] ?? "") : (d.decision.reason ?? "");
  return why !== "" ? `${base} Reason: ${why}` : base;
}

type Asking = null | "approve" | "reject";

/** What is being decided, as the screen and both dialogs show it (FR-013). */
function Facts({ e, now }: { e: AdminEscalation; now?: number }) {
  const seller = sellerOf(e.resourceKey);
  return (
    <dl className="figures">
      <dt>Reference</dt>
      <dd>
        <code>{e.referenceCode}</code>
      </dd>
      <dt>For</dt>
      <dd>
        <span aria-label={ownerName(e.owner)}>{ownerText(e.owner)}</span>
      </dd>
      <dt>Seller</dt>
      <dd>
        {seller.host}
        {seller.path !== "" ? ` ${seller.path}` : ""}
      </dd>
      <dt>Pays to</dt>
      <dd>
        <code>{e.payTo}</code>
      </dd>
      <dt>Amount</dt>
      <dd>{usdc(e.amountAtomic)}</dd>
      {now !== undefined ? (
        <>
          <dt>Time left</dt>
          <dd>{timeLeftText(Date.parse(e.expiresAt) - now)}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** The budget the payment counts against, from the same figures the decision uses (FR-022). */
function Budget({ budget, user }: { budget: EscalationBudget; user: boolean }) {
  const rows: Array<[string, BudgetLine]> = [
    ["This agent run", budget.run],
    [user ? "Last 24 hours, under this policy" : "Last 24 hours, platform account", budget.day],
    ...(budget.userDay ? ([["Last 24 hours, all of this user's policies", budget.userDay]] as Array<[string, BudgetLine]>) : []),
  ];
  return (
    <table className="stacked admin-table">
      <caption>The budget this payment counts against</caption>
      <thead>
        <tr>
          <th scope="col">Budget</th>
          <th scope="col">Spent</th>
          <th scope="col">Limit</th>
          <th scope="col">Left</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, line]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td data-label="Spent">{usdc(line.spentAtomic)}</td>
            <td data-label="Limit">{usdc(line.capAtomic)}</td>
            <td data-label="Left">{usdc(line.remainingAtomic)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Payment({ authorizationId }: { authorizationId: string }) {
  const { api } = useApp();
  const stepUp = useStepUp(APPROVE_STEP_UP_TEXT);
  /** undefined: loading. null: no such payment. */
  const [item, setItem] = useState<AdminEscalationDetail | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [reason, setReason] = useState<RejectionReasonCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The portal's clock minus this browser's, at the last read: the time left is computed on the portal's clock. */
  const [skewMs, setSkewMs] = useState(0);

  const load = useCallback(async () => {
    const r = await api.adminEscalation(authorizationId);
    if (r.ok) {
      setLoadError(null);
      setSkewMs(Date.parse(r.data.readAt) - Date.now());
      setItem(r.data);
    } else if (r.status === 404) {
      setLoadError(null);
      setItem(null);
    } else {
      setLoadError(errorMessage(r));
    }
  }, [api, authorizationId]);
  useEffect(() => {
    void load();
  }, [load]);
  // The time left runs on the portal's clock, as on the waiting list, so a wrong local clock doesn't shift it. It
  // only decides when the buttons stop being offered; whether the payment is still pending is L2's to say.
  const now = useNow(skewMs);

  const done = (r: ApiResult<DecisionOutcome>) => {
    setBusy(false);
    if (r.ok) {
      setRefusal(null);
      setRepeat(r.data.already);
    } else {
      setRefusal(errorMessage(r as ApiError));
    }
    // Whatever the answer, show the payment as it now is: decided, expired, or still waiting.
    void load();
  };
  const approve = () => {
    setAsking(null);
    setBusy(true);
    setRefusal(null);
    // An old sign-in parks the request behind "Confirm it's you"; one click confirms and sends it again, once.
    void stepUp.run(() => api.approveEscalation(authorizationId), done).finally(() => setBusy(false));
  };
  const reject = async () => {
    if (reason === null) return;
    setAsking(null);
    setBusy(true);
    setRefusal(null);
    done(await api.rejectEscalation(authorizationId, reason));
  };

  const back = (
    <p>
      <Link to="/admin">Back to the waiting list</Link>
    </p>
  );
  if (item === undefined || item === null) {
    return (
      <section>
        <ScreenHeading>One payment</ScreenHeading>
        {loadError !== null ? <Banner kind="error">{loadError}</Banner> : item === null ? <p>{NO_SUCH_PAYMENT_TEXT}</p> : <p role="status">Loading…</p>}
        {item === null || loadError !== null ? back : null}
      </section>
    );
  }
  const pending = item.state === "pending";
  const expired = pending && Date.parse(item.expiresAt) - now <= 0;
  const { budget } = item;
  return (
    <section>
      <ScreenHeading>One payment</ScreenHeading>
      <Facts e={item} {...(pending && { now })} />
      {!pending ? (
        <Banner kind="info">
          {endedText(item)}
          {repeat ? " It was already decided; nothing new was recorded." : ""}
        </Banner>
      ) : null}
      <Budget budget={budget} user={item.owner.userId !== undefined} />
      {pending && !budget.applies ? <Banner kind="warning">{NOT_APPLYING_TEXT[budget.notApplying ?? ""] ?? WILL_NOT_FIT_TEXT}</Banner> : null}
      {pending && budget.applies && !budget.fits ? <Banner kind="warning">{WILL_NOT_FIT_TEXT}</Banner> : null}
      {refusal !== null ? <Banner kind="error">{refusal}</Banner> : null}
      {loadError !== null ? <Banner kind="error">{loadError}</Banner> : null}
      {!pending ? null : item.mine ? (
        <p>{OWN_PAYMENT_TEXT}</p>
      ) : (
        <>
          {stepUp.prompt}
          <p>
            <button type="button" disabled={busy || expired} onClick={() => setAsking("approve")}>
              Approve
            </button>{" "}
            <button type="button" className="secondary" disabled={busy || expired} onClick={() => setAsking("reject")}>
              Reject
            </button>
          </p>
        </>
      )}
      {back}
      {asking === "approve" ? (
        <Dialog title="Approve this payment?" onClose={() => setAsking(null)}>
          <Facts e={item} now={now} />
          <p>{APPROVE_TEXT}</p>
          <button type="button" onClick={approve}>
            Approve payment
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </Dialog>
      ) : null}
      {asking === "reject" ? (
        <Dialog title="Reject this payment?" onClose={() => setAsking(null)}>
          <Facts e={item} now={now} />
          <fieldset>
            <legend>Why?</legend>
            {/* One reason per line, as every other choice in the portal: an input and its own label. */}
            {REASONS.map((code) => (
              <div key={code} className="check">
                <input id={`reject-reason-${code}`} type="radio" name="reject-reason" value={code} checked={reason === code} onChange={() => setReason(code)} />{" "}
                <label htmlFor={`reject-reason-${code}`}>{REASON_LABELS[code]}</label>
              </div>
            ))}
          </fieldset>
          <button type="button" disabled={reason === null} onClick={() => void reject()}>
            Reject payment
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </Dialog>
      ) : null}
    </section>
  );
}
