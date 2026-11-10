// Dev sign-in (local only; the portal is in dev mode when it verifies against the local dev issuer). The "sign-in" is
// a token pasted from `npm run -s dev-token -- --subject alice --portal`. It is kept in memory only: a reload signs
// the person out. Confirming identity means pasting a fresh one.
import type { Auth, AuthAccount } from "./types.js";

function claims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1]!;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createDevAuth(): Auth {
  let token: string | null = null;
  const accept = (input?: string): boolean => {
    const t = (input ?? "").trim();
    if (t.split(".").length !== 3 || claims(t) === null) return false;
    token = t;
    return true;
  };
  return {
    mode: "dev",
    signedIn: () => token !== null,
    account: (): AuthAccount | null => {
      const c = token === null ? null : claims(token);
      // The dev issuer's subject is a short name; it stands in for the person's display name.
      return c === null ? null : { ...(typeof c.oid === "string" && { name: c.oid }) };
    },
    signIn: async (input) => accept(input),
    token: async () => token,
    confirmIdentity: async (input) => accept(input),
    signOut: async () => {
      token = null;
    },
  };
}
