// The profile, as the first onboarding step and as a screen of its own (specs/013 US1, FR-009, FR-010).
import { useState, type FormEvent } from "react";
import { ErrorSummary, Field, ScreenHeading, type SummaryItem } from "../components/ui.js";
import { useApp } from "../context.js";
import { errorMessage, issueMessage } from "../messages.js";
import { OnboardingSteps } from "./Home.js";

const NAME_MAX = 80;
const validEmail = (v: string) => {
  const parts = v.trim().split("@");
  return parts.length === 2 && parts[0]!.length > 0 && /^[^.\s]+(\.[^.\s]+)+$/.test(parts[1]!) && !/\s/.test(v.trim()) && v.trim().length <= 254;
};

export function ProfileForm({ step }: { step: boolean }) {
  const { api, auth, me, setMe, navigate } = useApp();
  const first = !me.onboarding.profile;
  const account = auth.account();
  const [displayName, setDisplayName] = useState(me.profile?.displayName ?? account?.name ?? "");
  const [contactEmail, setContactEmail] = useState(me.profile?.contactEmail ?? account?.email ?? "");
  const [acknowledged, setAcknowledged] = useState(false);
  const [problems, setProblems] = useState<SummaryItem[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameOk = displayName.trim().length >= 1 && displayName.trim().length <= NAME_MAX;
  const emailOk = validEmail(contactEmail);
  const ready = nameOk && emailOk && (!first || acknowledged);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setSaved(false);
    const r = await api.saveProfile({ displayName: displayName.trim(), contactEmail: contactEmail.trim(), ...(first && { acknowledgedTestFunds: true }) });
    setBusy(false);
    if (r.ok) {
      setProblems([]);
      setMe(r.data);
      if (step) navigate("/onboarding/wallet");
      else setSaved(true);
      return;
    }
    setProblems(
      r.issues && r.issues.length > 0
        ? r.issues.map((i) => ({ fieldId: `profile-${i.field}`, message: issueMessage(i, { decimals: 6 }) }))
        : [{ message: errorMessage(r) }],
    );
  };

  return (
    <section>
      <ScreenHeading>{step ? "Create your profile" : "Profile"}</ScreenHeading>
      {step ? <OnboardingSteps /> : null}
      <ErrorSummary title="The profile was not saved" items={problems} />
      {saved ? (
        <p role="status" className="saved">
          Saved.
        </p>
      ) : null}
      <form onSubmit={submit} noValidate>
        <Field
          id="profile-displayName"
          label="Name"
          value={displayName}
          onChange={setDisplayName}
          required
          maxLength={NAME_MAX}
          autoComplete="name"
          {...(displayName !== "" && !nameOk && { error: "Enter your name (at most 80 characters)." })}
        />
        <Field
          id="profile-contactEmail"
          label="Contact email"
          type="email"
          inputMode="email"
          value={contactEmail}
          onChange={setContactEmail}
          required
          autoComplete="email"
          {...(contactEmail !== "" && !emailOk && { error: "Enter an email address like name@example.com." })}
        />
        {first ? (
          <div className="field">
            <input id="profile-acknowledgedTestFunds" type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />{" "}
            <label htmlFor="profile-acknowledgedTestFunds">I understand this wallet holds test funds only (test USDC, never real money).</label>
          </div>
        ) : null}
        <button type="submit" disabled={!ready || busy}>
          {step ? "Save and continue" : "Save"}
        </button>
      </form>
    </section>
  );
}
