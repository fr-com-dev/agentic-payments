// Entry point of the portal web app (specs/013 contracts/portal-ui.md). It asks the portal for its public settings,
// picks the sign-in for them (Auth0, or the local dev issuer) and renders the app. It holds no credential: the only
// secret in the browser is the person's own sign-in, kept by the sign-in library.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api.js";
import { App } from "./app.js";
import { createDevAuth } from "./auth/dev.js";
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
  if (config.auth.mode === "dev") auth = createDevAuth();
  else {
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
