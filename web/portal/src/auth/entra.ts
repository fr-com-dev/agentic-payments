// Entra sign-in (specs/013 research R2, R5): authorization code with PKCE through @azure/msal-browser, as a public
// client with no secret. The token is requested for the portal's own scope only. Confirming identity is an
// interactive request with `prompt: "login"`, which makes the person enter their credentials again and gives the
// token a fresh `auth_time`; the portal and L2 judge that time, not this code.
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import type { Auth, AuthAccount } from "./types.js";

export interface EntraSettings {
  tenantId: string;
  clientId: string;
  scope: string;
}

export async function createEntraAuth(s: EntraSettings, origin: string = window.location.origin): Promise<Auth> {
  const app = new PublicClientApplication({
    auth: {
      clientId: s.clientId,
      authority: `https://login.microsoftonline.com/${s.tenantId}`,
      // A dedicated page that runs only the library's bridge (web/portal/redirect.html).
      redirectUri: `${origin}/redirect.html`,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  await app.initialize();
  const scopes = [s.scope];
  const current = (): AccountInfo | null => app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;

  return {
    mode: "entra",
    signedIn: () => current() !== null,
    account: (): AuthAccount | null => {
      const a = current();
      if (a === null) return null;
      return { ...(a.name !== undefined && { name: a.name }), ...(a.username.includes("@") && { email: a.username }) };
    },
    signIn: async () => {
      try {
        const result = await app.loginPopup({ scopes });
        app.setActiveAccount(result.account);
        return true;
      } catch {
        return false;
      }
    },
    token: async () => {
      const account = current();
      if (account === null) return null;
      try {
        return (await app.acquireTokenSilent({ scopes, account })).accessToken;
      } catch (err) {
        // The session ended (a SPA's refresh token lasts 24 hours): the person must sign in again, from a click.
        if (err instanceof InteractionRequiredAuthError) return null;
        return null;
      }
    },
    confirmIdentity: async () => {
      const account = current();
      try {
        const result = await app.acquireTokenPopup({ scopes, prompt: "login", ...(account !== null && { loginHint: account.username }) });
        app.setActiveAccount(result.account);
        return true;
      } catch {
        return false;
      }
    },
    signOut: async () => {
      const account = current();
      app.setActiveAccount(null);
      await app.logoutPopup({ ...(account !== null && { account }) }).catch(() => undefined);
    },
  };
}
