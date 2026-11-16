// Verification of the access tokens the hosted agent service, L2 and the portal accept (SPEC.md §8.1 L1-6, §8.2
// L2-5 and L2-8, §11 SEC-14, SEC-19, SEC-20, SEC-32, SEC-33; specs/013 research R19; specs/016 research R2). One
// issuer, the sign-in tenant (Auth0), and two checks:
// - `verifyPersonToken`: a person's token. The portal uses it and adds its own client, its sign-in time and the
//   administrator's permission.
// - `verifyCaller`: whoever calls the hosted agent, a person with the permission `agent:run` from a client on the
//   agent's list, or a machine caller (client credentials) with that permission. The agent runs it on the request,
//   and L2 runs it again on the token the agent forwards, so the two can never drift apart.
// No layer code is imported here (rule A2).
import { readFileSync } from "node:fs";
import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

/** The local dev issuer (`npm run dev-token`), for people and for machine callers. Only valid with NETWORK=local. */
export const DEV_ISSUER = "urn:x402:dev-issuer";
/** The permission a caller of the agent service needs: a person through the role, a machine caller through its grant. */
export const AGENT_RUN_PERMISSION = "agent:run";
/** 014: the permission of an administrator of the portal. Only the portal reads it; the agent service ignores it. */
export const PORTAL_ADMIN_PERMISSION = "portal:admin";
/** The access-token claim the tenant's post-login Action sets to the time of the person's last sign-in. */
export const DEFAULT_AUTH_TIME_CLAIM = "https://x402.dev/auth_time";
/**
 * 1.19 (finding #6): the access-token claim the same Action sets to the time of the person's most recent second
 * factor (epoch seconds). An administrator's approval needs it fresh; the Action asks administrators for a second
 * factor on every interactive sign-in.
 */
export const DEFAULT_MFA_TIME_CLAIM = "https://x402.dev/mfa_time";
/** An Auth0 issuer as its tokens carry it: `https://<domain>/`, with the final slash and nothing after it. */
export const PERSON_ISSUER_RE = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?\/$/;
export const CLOCK_TOLERANCE_SEC = 60;

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
  /** 1.19: the value of the second-factor time claim, as found (`DEFAULT_MFA_TIME_CLAIM`). L2 judges it. */
  mfaTime: unknown;
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
      mfaTime: claims[DEFAULT_MFA_TIME_CLAIM],
    },
  };
}

/**
 * The sign-in time of a person's token as epoch seconds: an integer that is not in the future beyond the tolerance.
 * Null otherwise.
 */
export function signInTimeOf(person: Pick<PersonToken, "signInTime">, nowMs: number, toleranceSec: number = CLOCK_TOLERANCE_SEC): number | null {
  return epochSecondsOf(person.signInTime, nowMs, toleranceSec);
}

/** 1.19: the same rule for any time claim (the second factor's included): an integer, not in the future. */
export function epochSecondsOf(t: unknown, nowMs: number, toleranceSec: number = CLOCK_TOLERANCE_SEC): number | null {
  if (typeof t !== "number" || !Number.isInteger(t) || t < 0) return null;
  return t * 1000 > nowMs + toleranceSec * 1000 ? null : t;
}

// ---------------------------------------------------------------------------
// A caller of the hosted agent: a person or a machine caller (016)
// ---------------------------------------------------------------------------

export type CallerCheckName = "permission" | "client" | "machineSubject";

export interface CallerVerifyOptions extends TokenKeys {
  /** Exactly the token's `iss`. */
  issuer: string;
  /** People's API's identifier; the token's `aud` must contain it. */
  audience: string;
  /** The clients a person's token may come from. Machine callers are not listed: their grant at the tenant is the list. */
  clientIds: readonly string[];
  clockToleranceSec?: number;
  /** Test hook (must-fail cases): leave these checks out. Never set by a service. */
  skipChecks?: readonly CallerCheckName[];
}

/** Who a verified token is: a person (`sub` is theirs) or a machine caller (`sub` is `<client>@clients`). */
export interface Caller {
  kind: "person" | "machine";
  issuer: string;
  subject: string;
  client: string;
}

/**
 * Refused: 401 when the token is not valid here (`expired` when its validity period is the only thing wrong,
 * `invalid` otherwise), 403 when it is valid and its holder may not call the agent (`forbidden`).
 */
export type CallerCheck = { ok: true; caller: Caller } | { ok: false; status: 401 | 403; reason: "expired" | "invalid" | "forbidden" };

const unverified = (reason: "expired" | "invalid"): CallerCheck => ({ ok: false, status: 401, reason });
const FORBIDDEN: CallerCheck = { ok: false, status: 403, reason: "forbidden" };

const textList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []);

/**
 * Whether a machine token carries a permission. The tenant writes a client grant's scopes to `scope`, and may also
 * list them in `permissions` (specs/016 research R2): either counts, because both come from the grant and a client
 * without a grant gets no token for the API. A person's `scope` is what the client asked for, so it never counts.
 */
function machineHolds(claims: Record<string, unknown>, permission: string): boolean {
  if (textList(claims.permissions).includes(permission)) return true;
  return typeof claims.scope === "string" && claims.scope.split(" ").includes(permission);
}

/**
 * The one check of a caller of the hosted agent, run by the agent on the request and by L2 on the forwarded token.
 * Signature (the accepted algorithms only), exact issuer, audience, validity (60 s tolerance by default) and a
 * usable `sub`: 401. Then, for a machine token: `sub` is `<client>@clients` for the client the token names (401),
 * and it holds `agent:run` (403). For a person's: it holds `agent:run` and comes from a client on the list (403).
 */
export async function verifyCaller(token: string, o: CallerVerifyOptions): Promise<CallerCheck> {
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
  } catch (e) {
    return unverified(e instanceof errors.JWTExpired ? "expired" : "invalid");
  }
  const subject = claims.sub;
  if (typeof subject !== "string" || subject.length === 0 || hasLineBreak(subject)) return unverified("invalid");
  const client = clientOf(claims);
  if (isMachineToken(claims, subject)) {
    if (client === null) return unverified("invalid");
    if (!skip.has("machineSubject") && subject !== `${client}@clients`) return unverified("invalid");
    if (!skip.has("permission") && !machineHolds(claims, AGENT_RUN_PERMISSION)) return FORBIDDEN;
    return { ok: true, caller: { kind: "machine", issuer: o.issuer, subject, client } };
  }
  if (!skip.has("permission") && !textList(claims.permissions).includes(AGENT_RUN_PERMISSION)) return FORBIDDEN;
  if (!skip.has("client") && (client === null || !o.clientIds.includes(client))) return FORBIDDEN;
  return { ok: true, caller: { kind: "person", issuer: o.issuer, subject, client: client ?? "" } };
}
