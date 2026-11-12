// Auth0 sign-in (specs/013 research R19): authorization code with PKCE through @auth0/auth0-spa-js, as a public
// client with no secret. The token is requested for the portal's API (its audience). Sign-in is a pop-up started
// from a click; the tenant answers the pop-up with a web message, so no page of the portal's own is loaded there.
// Confirming identity is a new pop-up with `prompt=login` and `max_age=0`, which makes the person enter their
// credentials again; the tenant then puts the new sign-in time in the access token, and the portal and L2 judge
// that time, not this code.
import { Auth0Client, type Auth0ClientOptions, type ICache, type User } from "@auth0/auth0-spa-js";
import type { Auth, AuthAccount } from "./types.js";

export interface Auth0Settings {
  /** The tenant's domain, without `https://`. */
  domain: string;
  clientId: string;
  /** The API's identifier: the access token is issued for it. */
  audience: string;
}

/** The part of the sign-in library this adapter uses. Tests give a stand-in. */
export interface SignInClient {
  loginWithPopup(o?: { authorizationParams?: Record<string, unknown> }): Promise<void>;
  getTokenSilently(): Promise<string | undefined>;
  getUser(): Promise<User | undefined>;
  logout(o?: { openUrl?: false | ((url: string) => void | Promise<void>) }): Promise<void>;
}

const CACHE_PREFIX = "@@auth0spajs@@";

/**
 * The library's cache, kept in session storage: it ends with the tab, and a reload does not sign the person out.
 * This is the only place of the web app that touches browser storage (T-WEB-07).
 */
export function sessionCache(storage: Storage = window.sessionStorage): ICache {
  return {
    get: <T,>(key: string): T | undefined => {
      try {
        const raw = storage.getItem(key);
        return raw === null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    },
    set: (key, entry) => {
      storage.setItem(key, JSON.stringify(entry));
    },
    remove: (key) => {
      storage.removeItem(key);
    },
    allKeys: () => Object.keys(storage).filter((k) => k.startsWith(CACHE_PREFIX)),
  };
}

/** How the library is set up. One place, so the tests can check every choice (T-WEB-07). */
export function clientOptions(s: Auth0Settings, origin: string, cache: ICache): Auth0ClientOptions {
  return {
    domain: s.domain,
    clientId: s.clientId,
    authorizationParams: { audience: s.audience, redirect_uri: origin },
    cache,
    // Renewal by refresh token, rotated by the tenant on every use. No hidden frame of the tenant is ever opened:
    // when the refresh token is gone the person signs in again, from a click.
    useRefreshTokens: true,
    useRefreshTokensFallback: false,
  };
}

/**
 * The reason of a failure: the library's or the tenant's error code, nothing else. The description can hold an
 * address or an identifier and is not shown.
 */
export function describeFailure(err: unknown): string {
  const code = (err as { error?: unknown } | null)?.error;
  return typeof code === "string" && /^[a-z0-9_]{1,60}$/i.test(code) ? code : "unknown_error";
}

export async function createAuth0Auth(
  s: Auth0Settings,
  o: { origin?: string; client?: SignInClient } = {},
): Promise<Auth> {
  const client: SignInClient = o.client ?? new Auth0Client(clientOptions(s, o.origin ?? window.location.origin, sessionCache()));
  // Who is signed in, from the library's cache: a reload keeps the person signed in for as long as the tab lives.
  let user: User | null = (await client.getUser().catch(() => undefined)) ?? null;
  let failure: string | null = null;

  const popup = async (authorizationParams?: Record<string, unknown>): Promise<boolean> => {
    try {
      failure = null;
      await client.loginWithPopup(authorizationParams !== undefined ? { authorizationParams } : undefined);
      user = (await client.getUser()) ?? null;
      if (user === null) failure = "unknown_error";
      return user !== null;
    } catch (err) {
      failure = describeFailure(err);
      return false;
    }
  };

  return {
    mode: "auth0",
    signedIn: () => user !== null,
    account: (): AuthAccount | null => {
      if (user === null) return null;
      const { name, email } = user;
      return {
        // The tenant gives the email as the name when it knows no other: that is not a display name.
        ...(typeof name === "string" && name.length > 0 && name !== email && { name }),
        ...(typeof email === "string" && email.includes("@") && { email }),
      };
    },
    signIn: () => popup(),
    token: async () => {
      if (user === null) return null;
      try {
        return (await client.getTokenSilently()) ?? null;
      } catch {
        // The session ended (the refresh token expired or was revoked): the person must sign in again, from a click.
        return null;
      }
    },
    // A new sign-in, now, whatever session the tenant still holds.
    confirmIdentity: async () => {
      const before = user?.sub;
      if (!(await popup({ prompt: "login", max_age: 0 }))) return false;
      if (before !== undefined && user?.sub !== before) {
        // Somebody else signed in in the pop-up. Their sign-in must not finish this person's change: sign out.
        user = null;
        await client.logout({ openUrl: false }).catch(() => undefined);
        failure = "account_changed";
        return false;
      }
      return true;
    },
    lastError: () => failure,
    signOut: async () => {
      user = null;
      // Clears the library's cache. The tenant's own session is left alone: no navigation away from the portal.
      await client.logout({ openUrl: false }).catch(() => undefined);
    },
  };
}
