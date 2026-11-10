// Home (specs/013 contracts/portal-ui.md): the three onboarding steps until they are done (FR-008), then an overview.
import { useEffect, useState } from "react";
import { Banner, ScreenHeading, StatusLabel } from "../components/ui.js";
import { useApp } from "../context.js";
import { formatUsdcFixed } from "../money.js";
import type { Policy, Wallet } from "../types.js";

const STEPS: Array<{ key: "profile" | "wallet" | "policy"; label: string; path: string }> = [
  { key: "profile", label: "Create your profile", path: "/onboarding/profile" },
  { key: "wallet", label: "Create your wallet", path: "/onboarding/wallet" },
  { key: "policy", label: "Write your first expense policy", path: "/onboarding/policy" },
];

/** The steps with done / next / later, as a list anyone can read. Used on every onboarding screen. */
export function OnboardingSteps() {
  const { me, navigate } = useApp();
  const next = STEPS.find((s) => !me.onboarding[s.key]);
  return (
    <ol className="steps" aria-label="Setup steps">
      {STEPS.map((s) => {
        const done = me.onboarding[s.key];
        const state = done ? "Done" : s === next ? "Next" : "Later";
        return (
          <li key={s.key} className={`step step-${state.toLowerCase()}`} aria-current={s === next ? "step" : undefined}>
            <span className="step-state">{state}</span>{" "}
            {s === next ? (
              <a
                href={s.path}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(s.path);
                }}
              >
                {s.label}
              </a>
            ) : (
              s.label
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function Home() {
  const { api, me, navigate } = useApp();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  useEffect(() => {
    let live = true;
    void api.wallet().then((r) => live && r.ok && setWallet(r.data));
    void api.policies().then((r) => live && r.ok && setPolicies(r.data.policies));
    return () => {
      live = false;
    };
  }, [api]);
  const link = (path: string, text: string) => (
    <a
      href={path}
      onClick={(e) => {
        e.preventDefault();
        navigate(path);
      }}
    >
      {text}
    </a>
  );
  const a = wallet?.account;
  const active = (policies ?? []).filter((p) => p.displayState === "active");
  return (
    <section>
      <ScreenHeading>{me.profile ? `Hello, ${me.profile.displayName}` : "Your agent's spending"}</ScreenHeading>
      {a ? (
        <dl className="figures">
          <dt>Balance</dt>
          <dd>{a.balanceAtomic !== undefined ? `${formatUsdcFixed(a.balanceAtomic, a.decimals)} USDC` : "Not available right now"}</dd>
          <dt>Spent in the last 24 hours</dt>
          <dd>
            {formatUsdcFixed(a.spent24hAtomic, a.decimals)} of {formatUsdcFixed(a.dailyCeilingAtomic, a.decimals)} USDC
          </dd>
        </dl>
      ) : null}
      {a?.lowBalance ? <Banner kind="warning">Your balance is lower than what one of your policies allows per payment. A payment may fail until you add funds.</Banner> : null}
      <h2>Active policies</h2>
      {policies === null ? (
        <p>Loading…</p>
      ) : active.length === 0 ? (
        <p>No policy is active, so your agent can't pay anywhere. {link("/policies", "See your policies")}.</p>
      ) : (
        <ul>
          {active.map((p) => (
            <li key={p.policyId}>
              {link(`/policies/${p.policyId}`, p.name)} <StatusLabel state={p.displayState} />
              {p.limitedByPlatform.length > 0 ? <span className="flag"> Limited by the platform</span> : null}
              {p.unlistedSellers.length > 0 ? <span className="flag"> A seller is no longer available</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p>
        {link("/wallet", "Wallet")} · {link("/policies", "Policies")} · {link("/profile", "Profile")} · {link("/account", "Account")}
      </p>
    </section>
  );
}
