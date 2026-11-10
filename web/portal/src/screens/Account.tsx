// The account (specs/013 US7, FR-037..FR-039). Nothing is ever deleted: a person disables their account, which stops
// every payment at once, and can enable it again. Enabling loosens, so it may ask to confirm identity, and it leaves
// every policy paused for the person to resume one by one.
import { useState } from "react";
import type { ApiResult } from "../api.js";
import { Link } from "../components/Link.js";
import { useStepUp } from "../components/StepUp.js";
import { Banner, Dialog, ScreenHeading, StatusLabel } from "../components/ui.js";
import { useApp } from "../context.js";
import { errorMessage } from "../messages.js";
import type { Me } from "../types.js";

export const DISABLE_TEXT = "Your agent will not be able to pay. Nothing is deleted.";
export const ENABLED_TEXT = "Your policies are paused. Resume the ones you want.";

export function Account({ onSignOut }: { onSignOut?: () => void }) {
  const { api, me, setMe } = useApp();
  const stepUp = useStepUp();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const disable = async () => {
    setAsking(false);
    setBusy(true);
    const r = await api.disableAccount();
    setBusy(false);
    setJustEnabled(false);
    if (r.ok) {
      setProblem(null);
      setMe(r.data);
    } else setProblem(errorMessage(r));
  };
  const enabled = (r: ApiResult<Me>) => {
    if (r.ok) {
      setProblem(null);
      setJustEnabled(true);
      setMe(r.data);
    } else setProblem(errorMessage(r));
  };
  const enable = async () => {
    setBusy(true);
    await stepUp.run(() => api.enableAccount(), enabled);
    setBusy(false);
  };

  return (
    <section>
      <ScreenHeading>Account</ScreenHeading>
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      {stepUp.prompt}
      <p>
        Your account is <StatusLabel state={me.enabled ? "active" : "disabled"} />
      </p>
      {justEnabled && me.enabled ? (
        <Banner kind="info">
          {ENABLED_TEXT} <Link to="/policies">Go to your policies</Link>
        </Banner>
      ) : null}
      {me.enabled ? (
        <>
          <p>Disabling your account stops every payment by your agent at once. Your profile, wallet, policies and history are kept, and you can enable it again.</p>
          <button type="button" onClick={() => setAsking(true)} disabled={busy}>
            Disable my account
          </button>
        </>
      ) : (
        <>
          <p>While it is disabled your agent can't pay and nothing can be created or changed, except your name and email. Nothing was deleted.</p>
          <button type="button" onClick={() => void enable()} disabled={busy}>
            Enable my account
          </button>
        </>
      )}
      {onSignOut ? (
        <p>
          <button type="button" className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      ) : null}
      {asking ? (
        <Dialog title="Disable your account?" onClose={() => setAsking(false)}>
          <p>{DISABLE_TEXT}</p>
          <button type="button" onClick={() => void disable()}>
            Disable account
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </Dialog>
      ) : null}
    </section>
  );
}
