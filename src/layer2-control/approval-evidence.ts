// Verification of a backchannel approval (SPEC L2-7; specs/012 contracts/auth0-ciba.md "The access token L2
// accepts", research R5). Owner: feature 012. Each check is a separate step in a fixed order, and the first
// failure names the check (FR-020..FR-023). Only the access token proves an approval; it is never stored, logged
// or returned. Evidence keeps the issuer, the subject, an answer ID (jti, or a SHA-256 of the token) and iat.
// `skipChecks` exists only for the must-fail proofs (Constitution VIII); nothing outside tests sets it.
import { createHash } from "node:crypto";
import { compactVerify, createRemoteJWKSet, decodeJwt, decodeProtectedHeader, type CompactVerifyGetKey, type JWTPayload } from "jose";
import { detailsEqual } from "./payment-details.js";

export const CLOCK_TOLERANCE_S = 60;

export const VERIFICATION_CHECKS = [
  "malformed",
  "signature",
  "issuer",
  "audience",
  "client",
  "expired",
  "approver",
  "request",
  "details",
  "replay",
] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];

export type ApprovalKeys = CompactVerifyGetKey;

/** The issuer's published signing keys (cached by jose, refetched on an unknown kid). */
export function issuerKeys(issuer: string, opts: { allowInsecureLoopback?: boolean } = {}): ApprovalKeys {
  const loopback = opts.allowInsecureLoopback === true && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(issuer);
  if (!issuer.startsWith("https://") && !loopback) throw new Error("the approval service's issuer must be https");
  return createRemoteJWKSet(new URL(".well-known/jwks.json", issuer)) as unknown as ApprovalKeys;
}

export interface ExpectedApproval {
  issuer: string;
  audience: string;
  clientId: string;
  approver: string;
  /** The open request L2 recorded for this escalation. */
  requestId: string;
  /** APPROVAL_REQUESTED.data.details, exactly as sent. */
  sentDetails: unknown;
}

export interface VerifyOptions {
  keys: ApprovalKeys;
  nowMs: number;
  /** The token response's authorization_details: the fallback source when the token lacks the claim. */
  responseDetails?: unknown;
  answerIdUsed: (answerId: string) => boolean;
  /** Test-only, for must-fail proofs. */
  skipChecks?: ReadonlySet<VerificationCheck>;
}

export interface ApprovalEvidence {
  issuer: string;
  subject: string;
  answerId: string;
  issuedAt: string;
  detailsSource: "token" | "response";
}

export type VerificationResult = { ok: true; evidence: ApprovalEvidence } | { ok: false; check: VerificationCheck };

const fail = (check: VerificationCheck): VerificationResult => ({ ok: false, check });

function requestIdOf(d: unknown): unknown {
  const props = (d as { properties?: Record<string, { value?: unknown }> } | null)?.properties;
  return props?.request_id?.value;
}

export async function verifyApprovalToken(token: string, expected: ExpectedApproval, opts: VerifyOptions): Promise<VerificationResult> {
  const skip = opts.skipChecks ?? new Set<VerificationCheck>();
  const on = (c: VerificationCheck) => !skip.has(c);

  // 1. malformed: parseable, with the claims the later checks need.
  let claims: JWTPayload;
  try {
    decodeProtectedHeader(token);
    claims = decodeJwt(token);
  } catch {
    return fail("malformed");
  }
  const aud = claims.aud;
  const audOk = typeof aud === "string" || (Array.isArray(aud) && aud.every((a) => typeof a === "string"));
  if (typeof claims.iss !== "string" || typeof claims.sub !== "string" || typeof claims.exp !== "number" || typeof claims.iat !== "number" || !audOk) {
    return fail("malformed");
  }
  // 2. signature, RS256 only, against the issuer's JWKS.
  if (on("signature")) {
    try {
      await compactVerify(token, opts.keys, { algorithms: ["RS256"] });
    } catch {
      return fail("signature");
    }
  }
  // 3. issuer, exact.
  if (on("issuer") && claims.iss !== expected.issuer) return fail("issuer");
  // 4. audience: a string or an array containing it (Auth0 may add /userinfo).
  const audiences = typeof aud === "string" ? [aud] : (aud as string[]);
  if (on("audience") && !audiences.includes(expected.audience)) return fail("audience");
  // 5. client: azp (Auth0 profile) or client_id (RFC 9068 profile).
  const client = typeof claims.azp === "string" ? claims.azp : claims.client_id;
  if (on("client") && client !== expected.clientId) return fail("client");
  // 6. expired: exp, nbf and iat within the tolerance of L2's clock.
  if (on("expired")) {
    const nowS = opts.nowMs / 1000;
    const nbfOk = claims.nbf === undefined || (typeof claims.nbf === "number" && claims.nbf <= nowS + CLOCK_TOLERANCE_S);
    if (!(claims.exp > nowS - CLOCK_TOLERANCE_S) || !(claims.iat <= nowS + CLOCK_TOLERANCE_S) || !nbfOk) return fail("expired");
  }
  // 7. approver.
  if (on("approver") && claims.sub !== expected.approver) return fail("approver");
  // Details: the signed claim when present, otherwise the token response's body (research R5).
  const inToken = claims.authorization_details !== undefined;
  const details = inToken ? claims.authorization_details : opts.responseDetails;
  // 8. request: exactly one object, answering this escalation's open request.
  if (on("request") && (!Array.isArray(details) || details.length !== 1 || requestIdOf(details[0]) !== expected.requestId)) return fail("request");
  // 9. details: field for field, as sent.
  if (on("details") && !detailsEqual(details, expected.sentDetails)) return fail("details");
  // 10. replay: one answer approves one escalation.
  const answerId = typeof claims.jti === "string" && claims.jti.length > 0 ? claims.jti : `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
  if (on("replay") && opts.answerIdUsed(answerId)) return fail("replay");
  return {
    ok: true,
    evidence: {
      issuer: claims.iss,
      subject: claims.sub,
      answerId,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      detailsSource: inToken ? "token" : "response",
    },
  };
}
