// Verification of a backchannel approval (SPEC L2-7; specs/012 contracts/auth0-ciba.md "The access token L2
// accepts", research R5). Owner: feature 012. Each check is a separate step in a fixed order, and the first
// failure names the check (FR-020..FR-023). Only the access token proves an approval; it is never stored, logged
// or returned. Evidence keeps the issuer, the owner's one-way identifier, an answer ID (jti, or a SHA-256 of the
// token) and iat.
// 015 (v1.16, specs/015 research R3): step 7 is the owner check. The answer's subject is used for one comparison,
// `userIdFor(iss, sub)` against the user recorded on the escalation, and then dropped: it is never in the evidence.
// The check needs nothing stored and nothing configured, so it works the same after a restart.
// `skipChecks` exists only for the must-fail proofs (Constitution VIII); nothing outside tests sets it.
import { createHash } from "node:crypto";
import { compactVerify, createRemoteJWKSet, decodeJwt, decodeProtectedHeader, type CompactVerifyGetKey, type JWTPayload } from "jose";
import { userIdFor } from "../shared/user-id.js";
import { detailsEqual } from "./payment-details.js";

export const CLOCK_TOLERANCE_S = 60;

/** The ten steps, in order. Since v1.16 step 7 is `owner`. */
export const VERIFICATION_STEPS = ["malformed", "signature", "issuer", "audience", "client", "expired", "owner", "request", "details", "replay"] as const;
/**
 * Every value an `APPROVAL_VERIFICATION_FAILED.data.check` may hold: the ten steps, plus `approver`, step 7's name
 * before v1.16. `approver` is read from entries written then and is never produced.
 */
export const VERIFICATION_CHECKS = [...VERIFICATION_STEPS, "approver"] as const;
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
  /** 015: the user recorded on the escalation (`ESCALATED.data.userId`). Only their answer counts. */
  ownerUserId: string;
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
  /** 015: the owner's one-way identifier. The answer's subject is never kept. */
  userId: string;
  answerId: string;
  issuedAt: string;
  detailsSource: "token" | "response";
}

export type VerificationResult = { ok: true; evidence: ApprovalEvidence } | { ok: false; check: VerificationCheck };

const fail = (check: VerificationCheck): VerificationResult => ({ ok: false, check });

/** Step 7: the answer's subject, read under the answer's issuer (pinned by step 3), is the escalation's owner. */
function answeredByOwner(iss: string, sub: string, ownerUserId: string): boolean {
  try {
    return userIdFor(iss, sub) === ownerUserId;
  } catch {
    return false; // an empty subject, or one holding a line break, is nobody
  }
}

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
  // 7. owner: only the person the escalation is for (FR-013).
  if (on("owner") && !answeredByOwner(claims.iss, claims.sub, expected.ownerUserId)) return fail("owner");
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
      userId: expected.ownerUserId,
      answerId,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      detailsSource: inToken ? "token" : "response",
    },
  };
}
