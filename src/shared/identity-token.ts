// Verification of the access tokens the hosted agent service and the portal accept (SPEC.md §8.1 L1-6, §8.2 L2-8,
// §11 SEC-14, SEC-19, SEC-20; specs/013 research R19). Two kinds, from two issuers:
// - a person's token, from the Auth0 tenant (`verifyPersonToken`), accepted by both services;
// - a system identity's token, from the organization's directory, Microsoft Entra ID (`verifyServiceToken`),
//   accepted by the agent service only.
// Both services share the basic checks here so they can never drift apart. What each requires beyond them (the
// client allow-list, the permission, the sign-in time, the app role) stays in that service. No layer code is
// imported here (rule A2).
import { readFileSync } from "node:fs";
import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";

/** The local dev issuer (`npm run dev-token`), for people. Only valid with NETWORK=local. */
export const DEV_ISSUER = "urn:x402:dev-issuer";
/** The local dev issuer's stand-in for the organization's directory: it signs `--service` tokens. Local only. */
export const DEV_DIRECTORY_ISSUER = "urn:x402:dev-directory";
export const DEV_TENANT = "dev";
/** The one permission a person needs, at the portal and at the agent service (013, clarified 2026-11-10). */
export const AGENT_RUN_PERMISSION = "agent:run";
/** 014: the permission of an administrator of the portal. Only the portal reads it; the agent service ignores it. */
export const PORTAL_ADMIN_PERMISSION = "portal:admin";
/** The app role a system identity needs at the agent service. */
export const SERVICE_ROLE = "Agent.Run";
/** The access-token claim the tenant's post-login Action sets to the time of the person's last sign-in. */
export const DEFAULT_AUTH_TIME_CLAIM = "https://x402.dev/auth_time";
/** An Entra application (client) ID or object ID. */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An Auth0 issuer as its tokens carry it: `https://<domain>/`, with the final slash and nothing after it. */
export const PERSON_ISSUER_RE = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?\/$/;
export const CLOCK_TOLERANCE_SEC = 60;

export const entraIssuer = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/v2.0`;

/** Keys to verify with, and the signature algorithms accepted with them. */
export interface TokenKeys {
  keys: JWTVerifyGetKey;
  algorithms: string[];
}

/** The dev issuer's local JWKS (local only; the caller enforces that). It signs ES256. */
function localKeys(jwksFile: string): TokenKeys {
  let text: string;
  try {
    text = readFileSync(jwksFile, "utf8");
  } catch {
    // The local dev issuer is made by the first `npm run dev-token`; a service started before that has no keys to trust.
    throw new Error(`AUTH_JWKS_FILE: no file at ${jwksFile}. Run \`npm run dev-token\` once to create the local dev issuer, then start again`);
  }
  return { keys: createLocalJWKSet(JSON.parse(text)), algorithms: ["ES256"] };
}

/** The Auth0 tenant's JWKS (`<issuer>.well-known/jwks.json`, RS256), or the dev issuer's file when one is given. */
export function personKeys(auth: { issuer: string; jwksFile?: string }): TokenKeys {
  if (auth.jwksFile !== undefined) return localKeys(auth.jwksFile);
  return { keys: createRemoteJWKSet(new URL(".well-known/jwks.json", auth.issuer)), algorithms: ["RS256"] };
}

/** The Entra tenant's JWKS (RS256), or the dev issuer's file when one is given. */
export function serviceKeys(auth: { tenantId: string; jwksFile?: string }): TokenKeys {
  if (auth.jwksFile !== undefined) return localKeys(auth.jwksFile);
  return { keys: createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${auth.tenantId}/discovery/v2.0/keys`)), algorithms: ["RS256"] };
}

/** `Authorization: Bearer <token>` → the token, or null. */
export function bearerToken(header: unknown): string | null {
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1]! : null;
}

/**
 * The `iss` a token claims, read WITHOUT verifying anything. Its only use is to choose which issuer's checks to run;
 * the chosen verifier then checks the signature and the issuer in full. Null when the token can't be read.
 */
export function issuerOf(token: string): string | null {
  try {
    const iss = decodeJwt(token).iss;
    return typeof iss === "string" && iss.length > 0 ? iss : null;
  } catch {
    return null;
  }
}

/** Refused: 401 when the token itself is not valid here, 403 when it is valid but not of the accepted kind. */
export type TokenCheck<T> = { ok: true; token: T } | { ok: false; status: 401 | 403 };
const refused = (status: 401 | 403): { ok: false; status: 401 | 403 } => ({ ok: false, status });

// ---------------------------------------------------------------------------
// A person (Auth0)
// ---------------------------------------------------------------------------

export type PersonCheckName = "issuer" | "audience" | "subject" | "machine";

export interface PersonVerifyOptions extends TokenKeys {
  /** Exactly the token's `iss`. */
  issuer: string;
  /** The API's identifier; the token's `aud` must contain it. */
  audience: string;
  /** Default `DEFAULT_AUTH_TIME_CLAIM`. */
  authTimeClaim?: string;
  clockToleranceSec?: number;
  /** Test hook (must-fail cases in test/identity-token.test.ts): leave these checks out. Never set by a service. */
  skipChecks?: readonly PersonCheckName[];
}

export interface PersonToken {
  issuer: string;
  subject: string;
  /**
   * The client the token was issued to: `azp`, or `client_id` under the tenant's RFC 9068 token dialect. Null when
   * the token names none, or names two different ones.
   */
  client: string | null;
  /** The API permissions the person holds (RBAC, added to the access token by the tenant). */
  permissions: string[];
  /** The value of the sign-in time claim, as found. The portal checks it, and checks it last. */
  signInTime: unknown;
}

const hasLineBreak = (v: string) => /[\n\r]/.test(v);

function clientOf(claims: Record<string, unknown>): string | null {
  const named = [claims.azp, claims.client_id].filter((v) => v !== undefined);
  if (named.length === 0 || !named.every((v) => typeof v === "string" && v.length > 0)) return null;
  return named.every((v) => v === named[0]) ? (named[0] as string) : null;
}

/** A machine-to-machine token of the tenant: the client-credentials grant, whose subject is `<client>@clients`. */
function isMachineToken(claims: Record<string, unknown>, subject: string): boolean {
  const gty = claims.gty;
  const grants = Array.isArray(gty) ? gty : [gty];
  return grants.includes("client-credentials") || subject.endsWith("@clients");
}

/**
 * Checks the signature (the accepted algorithms only), the exact issuer, that the audience contains the API, the
 * validity (60 s tolerance by default) and a usable `sub`: 401 for any failure, with no reason to pass on. Then
 * refuses a machine token with 403. The client, the permissions and the sign-in time are returned for the service
 * to decide on.
 */
export async function verifyPersonToken(token: string, o: PersonVerifyOptions): Promise<TokenCheck<PersonToken>> {
  const skip = new Set(o.skipChecks ?? []);
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(token, o.keys, {
      algorithms: o.algorithms,
      ...(!skip.has("issuer") && { issuer: o.issuer }),
      ...(!skip.has("audience") && { audience: o.audience }),
      clockTolerance: o.clockToleranceSec ?? CLOCK_TOLERANCE_SEC,
      requiredClaims: ["exp"],
    });
    claims = payload as Record<string, unknown>;
  } catch {
    return refused(401);
  }
  const subject = claims.sub;
  if (!skip.has("subject") && (typeof subject !== "string" || subject.length === 0 || hasLineBreak(subject))) return refused(401);
  const sub = typeof subject === "string" ? subject : "";
  if (!skip.has("machine") && isMachineToken(claims, sub)) return refused(403);
  return {
    ok: true,
    token: {
      issuer: o.issuer,
      subject: sub,
      client: clientOf(claims),
      permissions: Array.isArray(claims.permissions) ? claims.permissions.filter((p): p is string => typeof p === "string") : [],
      signInTime: claims[o.authTimeClaim ?? DEFAULT_AUTH_TIME_CLAIM],
    },
  };
}

/**
 * The sign-in time of a person's token as epoch seconds: an integer that is not in the future beyond the tolerance.
 * Null otherwise.
 */
export function signInTimeOf(person: Pick<PersonToken, "signInTime">, nowMs: number, toleranceSec: number = CLOCK_TOLERANCE_SEC): number | null {
  const t = person.signInTime;
  if (typeof t !== "number" || !Number.isInteger(t) || t < 0) return null;
  return t * 1000 > nowMs + toleranceSec * 1000 ? null : t;
}

// ---------------------------------------------------------------------------
// A system identity (Entra)
// ---------------------------------------------------------------------------

export type ServiceCheckName = "tenant" | "appOnly";

export interface ServiceVerifyOptions extends TokenKeys {
  tenantId: string;
  /** The Entra API app's client ID: v2.0 tokens carry it as `aud`. */
  audience: string;
  issuer: string;
  clockToleranceSec?: number;
  /** Test hook (must-fail cases in test/identity-token.test.ts): leave these checks out. Never set by a service. */
  skipChecks?: readonly ServiceCheckName[];
}

export interface ServiceToken {
  tenantId: string;
  objectId: string;
  /** The app roles the identity holds (`roles`). */
  roles: string[];
}

/**
 * Checks the signature, issuer, audience and validity (60 s tolerance by default), then the tenant and a usable
 * `oid`: 401 for any failure. Then the token must be app-only (`idtyp` exactly `app`): a person's token from the
 * directory is refused with 403, because people sign in with the other issuer.
 */
export async function verifyServiceToken(token: string, o: ServiceVerifyOptions): Promise<TokenCheck<ServiceToken>> {
  const skip = new Set(o.skipChecks ?? []);
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(token, o.keys, {
      algorithms: o.algorithms,
      issuer: o.issuer,
      audience: o.audience,
      clockTolerance: o.clockToleranceSec ?? CLOCK_TOLERANCE_SEC,
      requiredClaims: ["exp"],
    });
    claims = payload as Record<string, unknown>;
  } catch {
    return refused(401);
  }
  const { tid, oid } = claims;
  if (!skip.has("tenant") && tid !== o.tenantId) return refused(401);
  if (typeof oid !== "string" || oid.length === 0 || hasLineBreak(oid)) return refused(401);
  if (!skip.has("appOnly") && claims.idtyp !== "app") return refused(403);
  return {
    ok: true,
    token: { tenantId: o.tenantId, objectId: oid, roles: Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === "string") : [] },
  };
}
