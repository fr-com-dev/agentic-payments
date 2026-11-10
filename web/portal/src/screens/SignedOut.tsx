// Before sign-in, and when access is refused (specs/013 US1 scenario 4, FR-003). No profile is created for a person
// who is refused: nothing is even asked of the portal for them.
import { useState } from "react";
import { Banner, ScreenHeading } from "../components/ui.js";
import type { Auth } from "../auth/types.js";

export const REFUSED_TEXT = "Your organization has not given you access to start agent runs.";

export function SignedOut({ auth, refused, onSignedIn }: { auth: Auth; refused: boolean; onSignedIn(): void }) {
  const [token, setToken] = useState("");
  const [failed, setFailed] = useState(false);
  const signIn = async () => {
    setFailed(false);
    if (await auth.signIn(auth.mode === "dev" ? token : undefined)) onSignedIn();
    else setFailed(true);
  };
  return (
    <section>
      <ScreenHeading>x402 portal</ScreenHeading>
      {refused ? (
        <Banner kind="error">{REFUSED_TEXT}</Banner>
      ) : (
        <p>Set up what your agent may spend: your profile, your wallet and your expense policies.</p>
      )}
      {failed ? <Banner kind="error">The sign-in did not complete. Try again.</Banner> : null}
      {auth.mode === "dev" ? (
        <div className="field">
          <label htmlFor="dev-token">Development sign-in: paste a token from “npm run -s dev-token -- --subject alice --portal”</label>
          <textarea id="dev-token" rows={4} value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
        </div>
      ) : null}
      <button type="button" onClick={() => void signIn()}>
        {refused ? "Sign in with another account" : "Sign in"}
      </button>
    </section>
  );
}
