// The history of one policy (specs/013 FR-047): every version and state change, oldest first, with what each version
// allowed in the same words the editor uses. Read-only: history is never edited or deleted.
import { useEffect, useState } from "react";
import { Link } from "../components/Link.js";
import { Banner, ScreenHeading, StatusLabel } from "../components/ui.js";
import { useApp } from "../context.js";
import { describeChanges } from "../changes.js";
import { errorMessage } from "../messages.js";
import { summarizePolicy } from "../summary.js";
import type { Platform, Policy, PolicyVersion } from "../types.js";

const KIND_TEXT: Record<PolicyVersion["kind"], string> = { created: "Created", changed: "Changed", paused: "Paused", resumed: "Resumed", removed: "Removed" };
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
};

export function PolicyHistory({ policyId }: { policyId: string }) {
  const { api } = useApp();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([api.platform(), api.policy(policyId)]).then(([pf, one]) => {
      if (!live) return;
      if (!one.ok) return setProblem(one.status === 404 ? "Not found" : errorMessage(one));
      if (!pf.ok) return setProblem(errorMessage(pf));
      setPlatform(pf.data);
      setPolicy(one.data);
    });
    return () => {
      live = false;
    };
  }, [api, policyId]);

  return (
    <section>
      <ScreenHeading>Policy history</ScreenHeading>
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      {policy === null || platform === null ? (
        problem === null ? (
          <p>Loading…</p>
        ) : null
      ) : (
        <>
          <p>
            {policy.name} <StatusLabel state={policy.displayState} /> · version {policy.version}
          </p>
          <ol className="history">
            {(policy.history ?? []).map((h, i, all) => {
              // The values of the version before this entry: the last earlier entry that carries values.
              const previous = h.kind === "changed" ? all.slice(0, i).reverse().find((e) => e.values !== undefined)?.values : undefined;
              const changes = previous && h.values ? describeChanges(previous, h.values, platform.sellers, platform.decimals) : [];
              return (
              <li key={h.seq}>
                <h2>
                  {KIND_TEXT[h.kind] ?? h.kind}
                  {h.cause === "account_enabled" ? " when the account was enabled again" : ""} · version {h.version}
                </h2>
                <p className="muted">{timeOf(h.ts)}</p>
                {changes.length > 0 ? (
                  <ul className="changes" aria-label={`What changed in version ${h.version}`}>
                    {changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                ) : null}
                {h.values
                  ? summarizePolicy(h.values, platform.sellers, platform.limits, platform.decimals).lines.map((line) => (
                      <p key={line} className="summary-line">
                        {line}
                      </p>
                    ))
                  : null}
              </li>
              );
            })}
          </ol>
          <p>
            {policy.state !== "removed" ? (
              <>
                <Link to={`/policies/${policy.policyId}`}>Edit this policy</Link> ·{" "}
              </>
            ) : null}
            <Link to="/policies">All policies</Link>
          </p>
        </>
      )}
    </section>
  );
}
