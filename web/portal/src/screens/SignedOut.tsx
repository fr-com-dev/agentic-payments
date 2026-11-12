// Before sign-in, and when access is refused (specs/013 US1 scenario 4, FR-003). No profile is created for a person
// who is refused: nothing is even asked of the portal for them.
import { useState } from "react";
import { Banner, ScreenHeading } from "../components/ui.js";
import type { Auth } from "../auth/types.js";

export const REFUSED_TEXT = "Your organization has not given you access to start agent runs.";

/** What a person can do about a failed sign-in, by the code the sign-in gave. The code itself is always shown too. */
export function signInHint(code: string | null): string {
  if (code === null) return "Try again.";
  if (/^popup_open$/.test(code)) return "Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.";
  if (/^cancelled$/.test(code)) return "The sign-in window was closed before it finished. Try again.";
  if (/^timeout$/.test(code)) return "The sign-in window was open too long without an answer. Try again.";
  if (/^access_denied$/.test(code)) return "The sign-in service refused this account. If that is unexpected, give this code to your administrator.";
  if (/^(unauthorized_client|invalid_client|invalid_request)$/.test(code)) {
    return "The sign-in service does not accept this portal's address or its sign-in settings. An administrator must check the portal's application there.";
  }
  if (/^(consent_required|interaction_required)$/.test(code)) return "The sign-in service needs your consent before it can sign you in. Try again and accept it.";
  if (/^(login_required|missing_refresh_token|invalid_grant)$/.test(code)) return "Your session ended. Sign in again.";
  if (/^account_changed$/.test(code)) return "Another person signed in in the sign-in window, so you were signed out. Sign in again as yourself.";
  if (/^mfa_required$/.test(code)) return "The sign-in service asked for a second step that did not finish. Try again.";
  return "Try again, or give this code to your administrator.";
}

export function SignedOut({ auth, refused, onSignedIn }: { auth: Auth; refused: boolean; onSignedIn(): void }) {
  const [token, setToken] = useState("");
  const [failed, setFailed] = useState<{ code: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const signIn = async () => {
    // One sign-in at a time: a second click while the sign-in window is open would start a competing one.
    if (pending) return;
    setFailed(null);
    setPending(true);
    const ok = await auth.signIn(auth.mode === "dev" ? token : undefined);
    setPending(false);
    if (ok) onSignedIn();
    else setFailed({ code: auth.lastError() });
  };
  return (
    <section>
      <ScreenHeading>x402 portal</ScreenHeading>
      {refused ? (
        <Banner kind="error">{REFUSED_TEXT}</Banner>
      ) : (
        <p>Set up what your agent may spend: your profile, your wallet and your expense policies.</p>
      )}
      {failed ? (
        <Banner kind="error">
          The sign-in did not complete{failed.code !== null ? <> (<code>{failed.code}</code>)</> : null}. {signInHint(failed.code)}
        </Banner>
      ) : null}
      {auth.mode === "dev" ? (
        <div className="field">
          <label htmlFor="dev-token">Development sign-in: paste a token from “npm run -s dev-token -- --subject alice --portal”</label>
          <textarea id="dev-token" rows={4} value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
        </div>
      ) : null}
      <button type="button" onClick={() => void signIn()} disabled={pending} aria-describedby={pending ? "sign-in-pending" : undefined}>
        {refused ? "Sign in with another account" : "Sign in"}
      </button>
      {pending && auth.mode === "auth0" ? (
        <p id="sign-in-pending" role="status" className="field-help">
          A sign-in window is open. Finish there, or close it to try again.
        </p>
      ) : null}
    </section>
  );
}
