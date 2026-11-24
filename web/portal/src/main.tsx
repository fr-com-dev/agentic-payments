// Entry point of the portal web app (specs/013 contracts/portal-ui.md). It asks the portal for its public settings,
// picks the sign-in for them (Auth0, or the local dev issuer) and renders the app. It holds no credential: the only
// secret in the browser is the person's own sign-in, kept by the sign-in library.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api.js";
import { App } from "./app.js";
import type { Auth } from "./auth/types.js";
import "./styles.css";

async function start(): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  const settings = await createApi(async () => null).config();
  if (!settings.ok) {
    root.render(
      <main id="main">
        <h1>x402 portal</h1>
        <p role="alert">The portal can't be reached. Reload the page to try again.</p>
      </main>,
    );
    return;
  }
  const config = settings.data;
  let auth: Auth;
  if (config.auth.mode === "dev") {
    // 017: a deployment build has no dev sign-in at all (T-WEB-16). The mode is tested right here, not through
    // DEV_SIGN_IN: the bundler collects a dynamic import before a constant from another module folds, so only a
    // literal in this module keeps the dev module's chunk out of the build, not just out of reach.
    if (import.meta.env.MODE !== "deployment") auth = (await import("./auth/dev.js")).createDevAuth();
    else {
      root.render(
        <main id="main">
          <h1>x402 portal</h1>
          <p role="alert">This build of the portal has no local sign-in.</p>
        </main>,
      );
      return;
    }
  } else {
    // Loaded only when it is used, so local development never downloads the sign-in library.
    const { createAuth0Auth } = await import("./auth/auth0.js");
    auth = await createAuth0Auth({ domain: config.auth.domain, clientId: config.auth.clientId, audience: config.auth.audience });
  }
  const api = createApi(() => auth.token());
  root.render(
    <StrictMode>
      <App api={api} auth={auth} config={config} />
    </StrictMode>,
  );
}

void start();
