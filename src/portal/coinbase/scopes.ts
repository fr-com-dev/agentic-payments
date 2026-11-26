// 020 the read-only allow-list (SPEC.md §8.2 L2-8, §11 SEC-55; specs/020 research R4). Pure. The portal asks Coinbase
// for exactly these scopes and keeps a grant only when Coinbase reports exactly these back: an allow-list, never a
// deny-list, because even a "read" scope of Coinbase's can act on an account (research R4). `all` or any name not
// listed here is too wide; a missing read scope, or no refresh token (no `offline_access`), is too narrow.

/** What the portal asks for: reading accounts and balances, and a refresh token to keep reading until disconnected. */
export const REQUESTED_SCOPES = ["wallet:accounts:read", "offline_access"] as const;

export type ScopeCheck = { ok: true; scopes: string[] } | { ok: false; reason: "too_wide" | "too_narrow" };

/** Coinbase's `scope`, split on spaces and commas (its pages show both), empty names dropped. */
export function splitScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/[\s,]+/).filter((s) => s.length > 0);
}

/** The check at the code exchange (FR-008): the granted set must equal the requested set, with a refresh token. */
export function checkGrantedScopes(scope: string | undefined, hasRefreshToken: boolean): ScopeCheck {
  const granted = splitScopes(scope);
  const allowed = new Set<string>(REQUESTED_SCOPES);
  if (granted.some((s) => !allowed.has(s))) return { ok: false, reason: "too_wide" };
  if (!granted.includes("wallet:accounts:read") || !hasRefreshToken) return { ok: false, reason: "too_narrow" };
  return { ok: true, scopes: [...new Set(granted)].sort() };
}

export type RenewalScopeCheck = { ok: true; unverified: boolean } | { ok: false };

/**
 * The check at a renewal. A listed name outside the allow-list ends the connection. The literal `all` is accepted
 * and flagged, because a renewal can't widen the original grant (RFC 6749 §6) and one of Coinbase's examples returns
 * it (research R4, unverified). No scope at all keeps the original grant's.
 */
export function checkRenewedScopes(scope: string | undefined): RenewalScopeCheck {
  const granted = splitScopes(scope);
  if (granted.length === 1 && granted[0] === "all") return { ok: true, unverified: true };
  const allowed = new Set<string>(REQUESTED_SCOPES);
  if (granted.some((s) => !allowed.has(s))) return { ok: false };
  return { ok: true, unverified: false };
}
