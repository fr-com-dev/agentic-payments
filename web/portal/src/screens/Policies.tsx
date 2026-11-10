// The policy list (specs/013 US3, US5, US8): every policy with its state in words, where it applies, what it allows
// (the same summary the editor shows) and its flags. Pause and remove only restrict, so they need no confirmation of
// identity; resume loosens, so it may ask for one (FR-007).
import { useCallback, useEffect, useState } from "react";
import type { ApiResult } from "../api.js";
import { Link } from "../components/Link.js";
import { useStepUp } from "../components/StepUp.js";
import { Banner, Dialog, ErrorSummary, ScreenHeading, StatusLabel, type SummaryItem } from "../components/ui.js";
import { useAccount, useApp } from "../context.js";
import { policyFlags } from "../flags.js";
import { errorMessage, issueMessage } from "../messages.js";
import { summarizePolicy } from "../summary.js";
import type { Platform, Policy } from "../types.js";

export function Policies() {
  const { api } = useApp();
  const { locked } = useAccount();
  const stepUp = useStepUp();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [problems, setProblems] = useState<SummaryItem[]>([]);
  const [removing, setRemoving] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [pf, list] = await Promise.all([api.platform(), api.policies()]);
    if (!pf.ok) return setProblems([{ message: errorMessage(pf) }]);
    if (!list.ok) return setProblems([{ message: errorMessage(list) }]);
    setPlatform(pf.data);
    setPolicies(list.data.policies);
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const done = (r: ApiResult<Policy>) => {
    if (r.ok) {
      setProblems([]);
      setPolicies((list) => (list ?? []).map((p) => (p.policyId === r.data.policyId ? r.data : p)));
      return;
    }
    const context = { decimals: platform?.decimals ?? 6, sellers: platform?.sellers ?? [], policies: policies ?? [] };
    setProblems(r.issues && r.issues.length > 0 ? r.issues.map((i) => ({ message: issueMessage(i, context) })) : [{ message: r.status === 404 ? "Not found" : errorMessage(r) }]);
  };
  const act = async (call: () => Promise<ApiResult<Policy>>) => {
    if (busy || locked) return;
    setBusy(true);
    await stepUp.run(call, done);
    setBusy(false);
  };

  return (
    <section>
      <ScreenHeading>Expense policies</ScreenHeading>
      <p>A policy says where your agent may pay, how much, and when a person is asked first. A seller with no active policy can't be paid.</p>
      <ErrorSummary title="That didn't work" items={problems} />
      {stepUp.prompt}
      <p>
        {locked ? (
          <button type="button" disabled aria-describedby="new-policy-why">
            New policy
          </button>
        ) : (
          <Link to="/policies/new" className="button">
            New policy
          </Link>
        )}
        {locked ? (
          <span id="new-policy-why" className="field-help">
            {" "}
            Your account is disabled.
          </span>
        ) : null}
      </p>
      {policies === null || platform === null ? (
        problems.length > 0 ? null : (
          <p>Loading…</p>
        )
      ) : policies.length === 0 ? (
        <p>You have no policy yet.</p>
      ) : (
        <ul className="policies">
          {policies.map((p) => (
            <li key={p.policyId} className="policy">
              <h2>
                <Link to={`/policies/${p.policyId}`}>{p.name}</Link> <StatusLabel state={p.displayState} />
                {p.expired && p.displayState !== "expired" ? <span className="status status-expired"> Expired</span> : null}
              </h2>
              {policyFlags(p, platform.limits, platform.decimals).map((flag) => (
                <p key={flag} className="flag">
                  {flag}
                </p>
              ))}
              {summarizePolicy(p.values, platform.sellers, platform.limits, platform.decimals).lines.map((line) => (
                <p key={line} className="summary-line">
                  {line}
                </p>
              ))}
              <p className="actions">
                {p.state === "active" ? (
                  <button type="button" className="secondary" disabled={locked || busy} onClick={() => void act(() => api.pausePolicy(p.policyId))}>
                    Pause <span className="visually-hidden">{p.name}</span>
                  </button>
                ) : null}
                {p.state === "paused" ? (
                  <button type="button" className="secondary" disabled={locked || busy} onClick={() => void act(() => api.resumePolicy(p.policyId))}>
                    Resume <span className="visually-hidden">{p.name}</span>
                  </button>
                ) : null}{" "}
                {p.state !== "removed" ? (
                  <button type="button" className="secondary" disabled={locked || busy} onClick={() => setRemoving(p)}>
                    Remove <span className="visually-hidden">{p.name}</span>
                  </button>
                ) : null}{" "}
                <Link to={`/policies/${p.policyId}/history`}>
                  History <span className="visually-hidden">of {p.name}</span>
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}
      {removing !== null ? (
        <Dialog title="Remove this policy?" onClose={() => setRemoving(null)}>
          <p>Your agent will no longer be able to pay under “{removing.name}”. Its history is kept, and a removed policy can't be brought back.</p>
          <button
            type="button"
            onClick={() => {
              const target = removing;
              setRemoving(null);
              void act(() => api.removePolicy(target.policyId));
            }}
          >
            Remove policy
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setRemoving(null)}>
            Cancel
          </button>
        </Dialog>
      ) : null}
    </section>
  );
}
