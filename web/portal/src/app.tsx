// The app shell (specs/013 contracts/portal-ui.md "Screens"): sign-in state, the signed-in person, the route table
// over the History API and the frame around every screen. A person who is refused sees the refusal and nothing
// else; a person who is not onboarded is taken to the first step not done (FR-008).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Api } from "./api.js";
import type { Auth } from "./auth/types.js";
import type { CardFieldsFactory } from "./components/AddCard.js";
import { Link } from "./components/Link.js";
import { Banner, Dialog, ScreenHeading } from "./components/ui.js";
import { AppProvider, type AppContext } from "./context.js";
import { errorMessage } from "./messages.js";
import { firstStepNotDone, matchRoute, resolveRoute } from "./routes.js";
import { Account } from "./screens/Account.js";
import { Home } from "./screens/Home.js";
import { Policies } from "./screens/Policies.js";
import { PolicyEditor } from "./screens/PolicyEditor.js";
import { PolicyHistory } from "./screens/PolicyHistory.js";
import { PolicyStep } from "./screens/PolicyStep.js";
import { Profile } from "./screens/Profile.js";
import { ProfileStep } from "./screens/ProfileStep.js";
import { SignedOut } from "./screens/SignedOut.js";
import { Wallet } from "./screens/Wallet.js";
import { WalletStep } from "./screens/WalletStep.js";
import type { Config, Me } from "./types.js";

export const DISABLED_TEXT = "Your account is disabled";

export interface AppProps {
  api: Api;
  auth: Auth;
  config: Config;
  /** The vault's card fields; tests pass a fake. */
  cardFields?: CardFieldsFactory;
}

type Phase = { name: "signed-out"; refused: boolean } | { name: "loading" } | { name: "failed"; message: string } | { name: "ready"; me: Me };

function Screen({ path, cardFields, onSignOut }: { path: string; cardFields?: CardFieldsFactory; onSignOut(): void }) {
  const screen = matchRoute(path);
  switch (screen.name) {
    case "home":
      return <Home />;
    case "profile-step":
      return <ProfileStep />;
    case "wallet-step":
      return <WalletStep />;
    case "policy-step":
      return <PolicyStep />;
    case "profile":
      return <Profile />;
    case "wallet":
      return <Wallet {...(cardFields && { cardFields })} />;
    case "policies":
      return <Policies />;
    case "policy-new":
      return <PolicyEditor />;
    case "policy-edit":
      return <PolicyEditor policyId={screen.policyId} />;
    case "policy-history":
      return <PolicyHistory policyId={screen.policyId} />;
    case "account":
      return <Account onSignOut={onSignOut} />;
    default:
      return (
        <section>
          <ScreenHeading>Not found</ScreenHeading>
          <p>
            <Link to="/">Go to the start</Link>
          </p>
        </section>
      );
  }
}

/** Dev mode only: confirming identity means pasting a fresh token from the local dev issuer. */
function DevConfirm({ auth, onDone }: { auth: Auth; onDone(ok: boolean): void }) {
  const [token, setToken] = useState("");
  return (
    <Dialog title="Confirm it's you" onClose={() => onDone(false)}>
      <div className="field">
        <label htmlFor="dev-confirm-token">Development sign-in: paste a fresh token from “npm run -s dev-token -- --subject alice --portal”</label>
        <textarea id="dev-confirm-token" rows={4} value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
      </div>
      <button type="button" onClick={() => void auth.confirmIdentity(token).then(onDone)}>
        Confirm
      </button>{" "}
      <button type="button" className="secondary" onClick={() => onDone(false)}>
        Cancel
      </button>
    </Dialog>
  );
}

export function App({ api, auth, config, cardFields }: AppProps) {
  const [phase, setPhase] = useState<Phase>(() => (auth.signedIn() ? { name: "loading" } : { name: "signed-out", refused: false }));
  const [path, setPath] = useState(() => window.location.pathname);
  const [confirming, setConfirming] = useState<((ok: boolean) => void) | null>(null);

  const load = useCallback(async () => {
    setPhase({ name: "loading" });
    const r = await api.me();
    if (r.ok) setPhase({ name: "ready", me: r.data });
    // Refused: no profile, no form, nothing else is asked of the portal for this person (FR-003).
    else if (r.status === 403) setPhase({ name: "signed-out", refused: true });
    else if (r.status === 401) setPhase({ name: "signed-out", refused: false });
    else setPhase({ name: "failed", message: errorMessage(r) });
  }, [api]);
  useEffect(() => {
    if (auth.signedIn()) void load();
  }, [auth, load]);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState(null, "", to);
    setPath(to);
  }, []);

  const me = phase.name === "ready" ? phase.me : null;
  const shown = me ? resolveRoute(path, me.onboarding) : path;
  useEffect(() => {
    // A deep link to a step that is not available lands on the first step not done; the address bar follows.
    if (me && shown !== window.location.pathname) window.history.replaceState(null, "", shown);
  }, [me, shown]);

  const confirmIdentity = useCallback(async (): Promise<boolean> => {
    if (auth.mode !== "dev") return auth.confirmIdentity();
    return new Promise<boolean>((resolve) => setConfirming(() => resolve));
  }, [auth]);
  const signOut = useCallback(() => {
    void auth.signOut().then(() => setPhase({ name: "signed-out", refused: false }));
  }, [auth]);
  const context = useMemo<AppContext | null>(
    () => (me ? { api, auth, config, me, setMe: (next) => setPhase({ name: "ready", me: next }), navigate, confirmIdentity } : null),
    [api, auth, config, me, navigate, confirmIdentity],
  );

  if (phase.name === "signed-out") {
    return (
      <main id="main">
        <SignedOut auth={auth} refused={phase.refused} onSignedIn={() => void load()} />
      </main>
    );
  }
  if (phase.name === "loading" || context === null || me === null) {
    return (
      <main id="main">
        {phase.name === "failed" ? (
          <>
            <Banner kind="error">{phase.message}</Banner>
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </>
        ) : (
          <p role="status">Loading…</p>
        )}
      </main>
    );
  }

  const onboarded = firstStepNotDone(me.onboarding) === null;
  return (
    <AppProvider value={context}>
      <a href="#main" className="skip-link">
        Skip to the content
      </a>
      <header className="site-header">
        <span className="site-name">x402 portal</span>
        {onboarded ? (
          <nav aria-label="Main">
            <Link to="/">Home</Link>
            <Link to="/wallet">Wallet</Link>
            <Link to="/policies">Policies</Link>
            <Link to="/profile">Profile</Link>
            <Link to="/account">Account</Link>
          </nav>
        ) : (
          <button type="button" className="link" onClick={signOut}>
            Sign out
          </button>
        )}
      </header>
      <main id="main">
        {me.enabled ? null : (
          <Banner kind="warning">
            {DISABLED_TEXT}. Your agent can't pay and nothing can be created or changed. {matchRoute(shown).name === "account" ? null : <Link to="/account">Go to your account</Link>}
          </Banner>
        )}
        {/* Keyed by path, so each screen starts fresh and its heading takes focus. */}
        <Screen key={shown} path={shown} onSignOut={signOut} {...(cardFields && { cardFields })} />
      </main>
      {confirming ? (
        <DevConfirm
          auth={auth}
          onDone={(ok) => {
            setConfirming(null);
            confirming(ok);
          }}
        />
      ) : null}
    </AppProvider>
  );
}
