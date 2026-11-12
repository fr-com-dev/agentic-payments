// Sign-in, behind one interface (specs/013 research R19). Two adapters: Auth0 (the real one) and dev (a pasted
// token from `npm run dev-token -- --portal`, local only). The app never sees a password and never stores a token
// outside the sign-in library's own session storage or memory.
export interface AuthAccount {
  name?: string;
  email?: string;
}

export interface Auth {
  readonly mode: "auth0" | "dev";
  /** True once a person is signed in. */
  signedIn(): boolean;
  /** The name and email from the sign-in, to prefill the profile. */
  account(): AuthAccount | null;
  /** Starts a sign-in. Must be called from a click. */
  signIn(input?: string): Promise<boolean>;
  /** A current access token for the portal API, or null when signed out. */
  token(): Promise<string | null>;
  /** Makes the person sign in again, now (FR-007). Must be called from a click. True when they did. */
  confirmIdentity(input?: string): Promise<boolean>;
  signOut(): Promise<void>;
  /**
   * Why the last sign-in or confirmation failed, as a short code (the sign-in library's or the sign-in service's),
   * or null. Never a token, a name or free text.
   */
  lastError(): string | null;
}
