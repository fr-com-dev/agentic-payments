// Verification of Microsoft Entra ID v2.0 access tokens (SPEC.md §8.1 L1-6, §11 SEC-14; 013 SEC-19, SEC-20).
// Shared by the hosted agent service and the portal (specs/013 research R2): both accept tokens for the same API app
// and must never drift apart on the basic checks. What each service requires beyond them (roles, scopes, the client,
// user or system identity) stays in that service. No layer code is imported here (rule A2).
import { readFileSync } from "node:fs";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Issuer and tenant of the local dev issuer (`npm run dev-token`). Only valid with NETWORK=local. */
export const DEV_ISSUER = "urn:x402:dev-issuer";
export const DEV_TENANT = "dev";
/** An Entra application (client) ID or object ID. */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const entraIssuer = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/v2.0`;

/** The tenant's JWKS, or the dev issuer's local JWKS when a file is given (local only; the caller enforces that). */
export function keysFor(auth: { tenantId: string; jwksFile?: string }): JWTVerifyGetKey {
  if (auth.jwksFile !== undefined) {
    let text: string;
    try {
      text = readFileSync(auth.jwksFile, "utf8");
    } catch {
      // The local dev issuer is made by the first `npm run dev-token`; a service started before that has no keys to trust.
      throw new Error(`AUTH_JWKS_FILE: no file at ${auth.jwksFile}. Run \`npm run dev-token\` once to create the local dev issuer, then start again`);
    }
    return createLocalJWKSet(JSON.parse(text));
  }
  return createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${auth.tenantId}/discovery/v2.0/keys`));
}

export interface EntraVerifyOptions {
  tenantId: string;
  audience: string;
  issuer: string;
  keys: JWTVerifyGetKey;
  clockToleranceSec?: number;
}

export type EntraClaims = Record<string, unknown> & { tid: string; oid: string };

/** `Authorization: Bearer <token>` → the token, or null. */
export function bearerToken(header: unknown): string | null {
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1]! : null;
}

/**
 * Checks the signature, issuer, audience and validity (60 s tolerance by default), then the tenant and a non-empty
 * `oid`. Returns the claims, or null for any failure: the caller answers 401 and learns no reason to pass on.
 */
export async function verifyEntraToken(token: string, o: EntraVerifyOptions): Promise<EntraClaims | null> {
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(token, o.keys, {
      issuer: o.issuer,
      audience: o.audience,
      clockTolerance: o.clockToleranceSec ?? 60,
      requiredClaims: ["exp"],
    });
    claims = payload as Record<string, unknown>;
  } catch {
    return null;
  }
  if (claims.tid !== o.tenantId || typeof claims.oid !== "string" || claims.oid.length === 0) return null;
  return claims as EntraClaims;
}

/** The delegated scopes of a token (`scp`, space-separated). Empty for an app-only token. */
export function scopesOf(claims: Record<string, unknown>): string[] {
  return typeof claims.scp === "string" ? claims.scp.split(" ").filter((s) => s.length > 0) : [];
}

export const rolesOf = (claims: Record<string, unknown>): unknown[] => (Array.isArray(claims.roles) ? claims.roles : []);
