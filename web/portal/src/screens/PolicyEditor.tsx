// The policy editor (specs/013 US3, US5, US8; contracts/portal-ui.md "Policy editor"): where, how much, how. It offers
// only the operator's sellers (no free-text host), shows each platform limit beside its field, and says in plain
// words what the policy allows before it is saved. The server decides everything; this form only helps.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ApiResult } from "../api.js";
import { Link } from "../components/Link.js";
import { useStepUp } from "../components/StepUp.js";
import { AmountField, Banner, ErrorSummary, Field, ScreenHeading, StatusLabel, type SummaryItem } from "../components/ui.js";
import { useAccount, useApp } from "../context.js";
import { policyFlags } from "../flags.js";
import { errorMessage, issueField, issueMessage } from "../messages.js";
import { formatUsdc, formatUsdcFixed, lessThan, parseUsdcInput } from "../money.js";
import { formatDay, summarizePolicy } from "../summary.js";
import type { Issue, Platform, Policy, PolicyInput, PolicyValues } from "../types.js";
import { OnboardingSteps } from "./Home.js";

export const NO_SELLERS_TEXT = "No sellers are available yet";
export const CONFLICT_TEXT = "This policy was changed in another window";
export const NAME_MAX = 60;

type AmountKey = "autoApproveUsdc" | "perPaymentUsdc" | "perRunUsdc" | "perDayUsdc";
interface Form extends Record<AmountKey, string> {
  name: string;
  sellers: string[];
  paymentsPerMinute: string;
  endsOn: string;
}

const AMOUNTS: Array<{ key: AmountKey; label: string; value: keyof PolicyValues }> = [
  { key: "autoApproveUsdc", label: "Without asking", value: "autoApproveMaxAtomic" },
  { key: "perPaymentUsdc", label: "Per payment", value: "hardCapPerPaymentAtomic" },
  { key: "perRunUsdc", label: "Per agent run", value: "sessionBudgetAtomic" },
  { key: "perDayUsdc", label: "Per day", value: "dailyBudgetAtomic" },
];

const DAY_MS = 86_400_000;
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function emptyForm(platform: Platform, nowMs: number): Form {
  const days = Math.min(30, platform.limits.maxPolicyDays);
  return {
    name: "",
    sellers: [],
    autoApproveUsdc: "",
    perPaymentUsdc: "",
    perRunUsdc: "",
    perDayUsdc: "",
    paymentsPerMinute: String(platform.limits.maxAuthorizationsPerMinute),
    endsOn: new Date(nowMs + days * DAY_MS).toISOString().slice(0, 10),
  };
}

function formOf(p: Policy, decimals: number): Form {
  const v = p.values;
  return {
    name: p.name,
    sellers: [...v.sellers],
    autoApproveUsdc: formatUsdc(v.autoApproveMaxAtomic, decimals),
    perPaymentUsdc: formatUsdc(v.hardCapPerPaymentAtomic, decimals),
    perRunUsdc: formatUsdc(v.sessionBudgetAtomic, decimals),
    perDayUsdc: formatUsdc(v.dailyBudgetAtomic, decimals),
    paymentsPerMinute: String(v.maxAuthorizationsPerMinute),
    endsOn: v.expiresAt.slice(0, 10),
  };
}

/** What the form would save, when every value can be read; the summary is built from it. */
function valuesOf(f: Form, decimals: number): PolicyValues | null {
  const atomic: string[] = [];
  for (const a of AMOUNTS) {
    const parsed = parseUsdcInput(f[a.key], decimals);
    if (typeof parsed !== "string") return null;
    atomic.push(parsed);
  }
  if (!/^\d+$/.test(f.paymentsPerMinute.trim()) || !isDay(f.endsOn)) return null;
  return {
    sellers: f.sellers,
    autoApproveMaxAtomic: atomic[0]!,
    hardCapPerPaymentAtomic: atomic[1]!,
    sessionBudgetAtomic: atomic[2]!,
    dailyBudgetAtomic: atomic[3]!,
    maxAuthorizationsPerMinute: Number.parseInt(f.paymentsPerMinute.trim(), 10),
    expiresAt: `${f.endsOn}T23:59:59.999Z`,
    paymentMethod: "crypto_account",
  };
}

const inputOf = (f: Form): PolicyInput => ({
  name: f.name.trim(),
  sellers: f.sellers,
  autoApproveUsdc: f.autoApproveUsdc.trim(),
  perPaymentUsdc: f.perPaymentUsdc.trim(),
  perRunUsdc: f.perRunUsdc.trim(),
  perDayUsdc: f.perDayUsdc.trim(),
  paymentsPerMinute: Number.parseInt(f.paymentsPerMinute.trim(), 10),
  endsOn: f.endsOn,
  paymentMethod: "crypto_account",
});

/** What the form itself can tell is wrong, as the same issues the server would send. */
function clientIssues(f: Form, decimals: number): Issue[] {
  const issues: Issue[] = [];
  const name = f.name.trim();
  if (name.length < 1 || name.length > NAME_MAX) issues.push({ field: "name", code: "invalid_name" });
  if (f.sellers.length === 0) issues.push({ field: "sellers", code: "no_sellers" });
  const atomic: Partial<Record<AmountKey, string>> = {};
  for (const a of AMOUNTS) {
    const parsed = parseUsdcInput(f[a.key], decimals);
    if (typeof parsed === "string") atomic[a.key] = parsed;
    else issues.push({ field: a.key, code: parsed.error });
  }
  const auto = atomic.autoApproveUsdc;
  const cap = atomic.perPaymentUsdc;
  const run = atomic.perRunUsdc;
  if (auto !== undefined && cap !== undefined && !lessThan(auto, cap)) issues.push({ field: "autoApproveUsdc", code: "order_auto_below_cap" });
  if (cap !== undefined && run !== undefined && lessThan(run, cap)) issues.push({ field: "perPaymentUsdc", code: "order_cap_within_session" });
  if (!/^[1-9]\d*$/.test(f.paymentsPerMinute.trim())) issues.push({ field: "paymentsPerMinute", code: "rate_invalid" });
  if (!isDay(f.endsOn)) issues.push({ field: "endsOn", code: "invalid_date" });
  return issues;
}

function SummaryPanel({ values, platform }: { values: PolicyValues | null; platform: Platform }) {
  return (
    <section className="summary" aria-labelledby="policy-summary-title">
      <h2 id="policy-summary-title">What this policy allows</h2>
      {values === null ? (
        <p>Fill in the amounts, the payments per minute and the end date to see what this policy allows.</p>
      ) : (
        summarizePolicy(values, platform.sellers, platform.limits, platform.decimals).lines.map((line) => <p key={line}>{line}</p>)
      )}
    </section>
  );
}

interface Conflict {
  current: Policy;
  mine: Form;
}

function ConflictView({ c, platform, onKeepMine, onUseCurrent }: { c: Conflict; platform: Platform; onKeepMine(): void; onUseCurrent(): void }) {
  const theirs = formOf(c.current, platform.decimals);
  const sellerNames = (hosts: string[]) => hosts.map((h) => platform.sellers.find((s) => s.host === h)?.name ?? h).join(", ");
  const rows: Array<[string, string, string]> = [
    ["Name", theirs.name, c.mine.name],
    ["Sellers", sellerNames(theirs.sellers), sellerNames(c.mine.sellers)],
    ...AMOUNTS.map((a): [string, string, string] => [a.label, `${theirs[a.key]} USDC`, `${c.mine[a.key]} USDC`]),
    ["Payments per minute", theirs.paymentsPerMinute, c.mine.paymentsPerMinute],
    ["End date", theirs.endsOn, c.mine.endsOn],
  ];
  return (
    <div className="conflict" role="alert">
      <h2>{CONFLICT_TEXT}</h2>
      <p>Nothing was overwritten. Compare the current values with yours, then choose.</p>
      <table className="stacked">
        <thead>
          <tr>
            <th scope="col">Value</th>
            <th scope="col">Current</th>
            <th scope="col">Yours</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, current, mine]) => (
            <tr key={label} className={current === mine ? undefined : "differs"}>
              <th scope="row">{label}</th>
              <td data-label="Current">{current}</td>
              <td data-label="Yours">
                {mine}
                {current === mine ? null : <span className="flag"> (different)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={onKeepMine}>
        Keep editing my values
      </button>{" "}
      <button type="button" className="secondary" onClick={onUseCurrent}>
        Use the current values
      </button>
    </div>
  );
}

export function PolicyEditor({ policyId, step = false }: { policyId?: string; step?: boolean }) {
  const { api, setMe, navigate } = useApp();
  const { locked } = useAccount();
  const stepUp = useStepUp();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [others, setOthers] = useState<Policy[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [problems, setProblems] = useState<SummaryItem[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [pf, list, one] = await Promise.all([api.platform(), api.policies(), policyId === undefined ? null : api.policy(policyId)]);
      if (!live) return;
      if (!pf.ok) return setLoadProblem(errorMessage(pf));
      if (one !== null && !one.ok) return setLoadProblem(one.status === 404 ? "Not found" : errorMessage(one));
      setPlatform(pf.data);
      setOthers(list.ok ? list.data.policies.filter((p) => p.policyId !== policyId) : []);
      if (one !== null) {
        setPolicy(one.data);
        setExpectedVersion(one.data.version);
        setForm(formOf(one.data, pf.data.decimals));
      } else setForm(emptyForm(pf.data, Date.now()));
    })();
    return () => {
      live = false;
    };
  }, [api, policyId]);

  const live = useMemo(() => (form && platform ? valuesOf(form, platform.decimals) : null), [form, platform]);
  const title = step ? "Write your first expense policy" : policyId === undefined ? "New policy" : "Edit policy";
  const heading = (
    <>
      <ScreenHeading>{title}</ScreenHeading>
      {step ? <OnboardingSteps /> : null}
    </>
  );

  if (loadProblem !== null) {
    return (
      <section>
        {heading}
        <Banner kind="error">{loadProblem}</Banner>
      </section>
    );
  }
  if (platform === null || form === null) {
    return (
      <section>
        {heading}
        <p>Loading…</p>
      </section>
    );
  }
  if (policyId === undefined && platform.sellers.length === 0) {
    return (
      <section>
        {heading}
        <Banner kind="info">{NO_SELLERS_TEXT}. Your operator has not listed a seller, so there is nowhere a policy could allow a payment.</Banner>
      </section>
    );
  }
  if (policy !== null && policy.state === "removed") {
    return (
      <section>
        {heading}
        <p>
          {policy.name} <StatusLabel state="removed" />
        </p>
        <Banner kind="info">This policy was removed and can't be changed.</Banner>
        <SummaryPanel values={policy.values} platform={platform} />
        <p>
          <Link to={`/policies/${policy.policyId}/history`}>History</Link> · <Link to="/policies">All policies</Link>
        </p>
      </section>
    );
  }

  const decimals = platform.decimals;
  const limits = platform.limits;
  const context = { decimals, sellers: platform.sellers, policies: others };
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  /** The message under a field: what the form sees now, else what the server said about it on the last save. */
  const fieldError = (key: string): string | undefined => {
    const now = form[key as AmountKey] !== undefined && form[key as AmountKey] !== "" ? clientIssues(form, decimals).find((i) => i.field === key) : undefined;
    const issue = now ?? issues.find((i) => issueField(i) === key);
    return issue ? issueMessage(issue, context) : undefined;
  };
  const showIssues = (list: Issue[]) => {
    setIssues(list);
    setProblems(list.map((i) => ({ fieldId: `policy-${issueField(i)}`, message: issueMessage(i, context) })));
  };

  const saved = async (r: ApiResult<Policy>, sent: Form) => {
    if (r.ok) {
      if (step) {
        const me = await api.me();
        if (me.ok) setMe(me.data);
        navigate("/");
      } else navigate("/policies");
      return;
    }
    if (r.status === 409 && r.error === "version_conflict" && r.current) {
      setProblems([]);
      setConflict({ current: r.current, mine: sent });
    } else if (r.issues && r.issues.length > 0) showIssues(r.issues);
    else {
      setIssues([]);
      setProblems([{ message: r.status === 404 ? "Not found" : errorMessage(r) }]);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || locked) return;
    const mine = clientIssues(form, decimals);
    if (mine.length > 0) return showIssues(mine);
    setIssues([]);
    setProblems([]);
    setConflict(null);
    // The exact values that are sent now are the ones sent again after "Confirm it's you".
    const sent = form;
    const input = inputOf(sent);
    setBusy(true);
    await stepUp.run(
      () => (policyId === undefined ? api.createPolicy(input) : api.changePolicy(policyId, input, expectedVersion)),
      (r) => void saved(r, sent),
    );
    setBusy(false);
  };

  const usedBy = (host: string) => others.find((p) => p.state === "active" && p.values.sellers.includes(host));
  const unlisted = policy?.unlistedSellers ?? [];
  const toggle = (host: string, on: boolean) => set("sellers", on ? [...form.sellers, host] : form.sellers.filter((h) => h !== host));
  const helps: Record<AmountKey, string> = {
    autoApproveUsdc: "Your agent pays up to this amount without asking. Enter 0 to be asked every time. It must be less than the per-payment amount.",
    perPaymentUsdc: `The most one payment can be: up to ${formatUsdcFixed(limits.hardCapPerPaymentAtomic, decimals)} USDC.`,
    perRunUsdc: `The most one agent run can spend: up to ${formatUsdcFixed(limits.sessionBudgetAtomic, decimals)} USDC.`,
    perDayUsdc: `The most this policy can spend in 24 hours: up to ${formatUsdcFixed(limits.userDailyCeilingAtomic, decimals)} USDC.`,
  };
  const sellersError = issues.filter((i) => issueField(i) === "sellers").map((i) => issueMessage(i, context));
  const flags = policy ? policyFlags(policy, limits, decimals) : [];

  return (
    <section>
      {heading}
      {policy ? (
        <p>
          <StatusLabel state={policy.displayState} /> · version {policy.version} · <Link to={`/policies/${policy.policyId}/history`}>History</Link>
        </p>
      ) : null}
      {flags.map((flag) => (
        <Banner key={flag} kind="warning">
          {flag}
        </Banner>
      ))}
      {locked ? <Banner kind="warning">Your account is disabled, so this policy can't be saved.</Banner> : null}
      <ErrorSummary title="The policy was not saved" items={problems} />
      {stepUp.prompt}
      {conflict ? (
        <ConflictView
          c={conflict}
          platform={platform}
          onKeepMine={() => {
            // Saving again is a deliberate choice against the version the person has now seen.
            setExpectedVersion(conflict.current.version);
            setPolicy(conflict.current);
            setConflict(null);
          }}
          onUseCurrent={() => {
            setExpectedVersion(conflict.current.version);
            setPolicy(conflict.current);
            setForm(formOf(conflict.current, decimals));
            setConflict(null);
          }}
        />
      ) : null}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field
          id="policy-name"
          label="Policy name"
          value={form.name}
          onChange={(v) => set("name", v)}
          required
          maxLength={NAME_MAX}
          disabled={locked}
          help="Only you see this name."
          {...(fieldError("name") !== undefined && { error: fieldError("name")! })}
        />

        <fieldset id="policy-sellers" tabIndex={-1} aria-describedby={sellersError.length > 0 ? "policy-sellers-error" : undefined}>
          <legend>Where</legend>
          <p className="field-help">The sellers your agent may pay under this policy. Choose at least one.</p>
          {platform.sellers.map((s, i) => {
            const other = usedBy(s.host);
            const id = `policy-seller-${i}`;
            return (
              <div key={s.host} className="check">
                <input
                  id={id}
                  type="checkbox"
                  checked={form.sellers.includes(s.host)}
                  disabled={locked || other !== undefined}
                  aria-describedby={other ? `${id}-why` : undefined}
                  onChange={(e) => toggle(s.host, e.target.checked)}
                />{" "}
                <label htmlFor={id}>
                  {s.name} ({s.host})
                </label>
                {other ? (
                  <span id={`${id}-why`} className="muted">
                    {" "}
                    Already in {other.name}
                  </span>
                ) : null}
              </div>
            );
          })}
          {unlisted.map((host, i) => {
            const id = `policy-unlisted-${i}`;
            return (
              <div key={host} className="check">
                <input id={id} type="checkbox" checked={form.sellers.includes(host)} disabled={locked} aria-describedby={`${id}-why`} onChange={(e) => toggle(host, e.target.checked)} />{" "}
                <label htmlFor={id}>{host}</label>
                <span id={`${id}-why`} className="flag">
                  {" "}
                  Seller no longer available. Untick it to remove it from this policy.
                </span>
              </div>
            );
          })}
          {sellersError.length > 0 ? (
            <p id="policy-sellers-error" className="field-error">
              {sellersError.join(" ")}
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>How much</legend>
          <p className="field-help">Amounts in USDC with at most {decimals} decimals. An amount is never rounded for you.</p>
          {AMOUNTS.map((a) => (
            <AmountField
              key={a.key}
              id={`policy-${a.key}`}
              label={a.label}
              value={form[a.key]}
              onChange={(v) => set(a.key, v)}
              required
              disabled={locked}
              help={helps[a.key]}
              {...(fieldError(a.key) !== undefined && { error: fieldError(a.key)! })}
            />
          ))}
        </fieldset>

        <fieldset>
          <legend>How</legend>
          <div className="field" role="radiogroup" aria-labelledby="policy-method-label">
            <span id="policy-method-label" className="label">
              Payment method
            </span>
            <div className="check">
              <input id="policy-method-crypto" type="radio" name="paymentMethod" checked readOnly /> <label htmlFor="policy-method-crypto">My crypto account</label>
            </div>
            <div className="check">
              <input id="policy-method-card" type="radio" name="paymentMethod" checked={false} disabled readOnly aria-describedby="policy-method-card-why" />{" "}
              <label htmlFor="policy-method-card">A card</label>
              <span id="policy-method-card-why" className="muted">
                {" "}
                not available yet
              </span>
            </div>
          </div>
          <Field
            id="policy-paymentsPerMinute"
            label="Payments per minute"
            inputMode="numeric"
            value={form.paymentsPerMinute}
            onChange={(v) => set("paymentsPerMinute", v)}
            required
            disabled={locked}
            help={`A whole number, up to ${limits.maxAuthorizationsPerMinute}.`}
            {...(fieldError("paymentsPerMinute") !== undefined && { error: fieldError("paymentsPerMinute")! })}
          />
          <Field
            id="policy-endsOn"
            label="End date"
            type="date"
            value={form.endsOn}
            onChange={(v) => set("endsOn", v)}
            required
            disabled={locked}
            help={`The policy stops at the end of this day (UTC). After today, at most ${limits.maxPolicyDays} days from today${isDay(form.endsOn) ? `: ${formatDay(`${form.endsOn}T00:00:00Z`)}` : ""}.`}
            {...(fieldError("endsOn") !== undefined && { error: fieldError("endsOn")! })}
          />
        </fieldset>

        <SummaryPanel values={live} platform={platform} />

        <button type="submit" disabled={busy || locked}>
          {policyId === undefined ? "Save policy" : "Save changes"}
        </button>
        {step ? null : (
          <>
            {" "}
            <Link to="/policies" className="button secondary">
              Cancel
            </Link>
          </>
        )}
      </form>
    </section>
  );
}
