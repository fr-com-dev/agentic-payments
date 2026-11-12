// L1-6 session references (SPEC.md §11 SEC-15; specs/011 contracts/access-and-sessions.md, research R7).
// A stateless, HMAC-bound handle: `sr1.<sessionId>.<mac>`, where the MAC binds the session to one
// requester: its kind, who vouches for it (a person's issuer, a system identity's tenant) and its subject. The
// service assigns every session; a requester never chooses a raw session ID. 013: a person is now the Auth0
// issuer and `sub`, so a reference issued under the earlier sign-in no longer verifies (404).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Requester } from "./requester-auth.js";

export const SESSION_REF_RE = /^sr1\.(sess_[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

export const newSessionId = (): string => `sess_${randomBytes(8).toString("hex")}`;

export type SessionOwner = Pick<Requester, "kind" | "authority" | "subject">;

/** Newline-separated: a `sub` may hold `|`, and neither field can hold a line break (the verifier refuses one). */
export function sessionMac(secret: Buffer, requester: SessionOwner, sessionId: string): string {
  return createHmac("sha256", secret)
    .update(["sr1", requester.kind, requester.authority, requester.subject, sessionId].join("\n"))
    .digest("base64url");
}

export function issueSessionRef(secret: Buffer, requester: SessionOwner, sessionId: string): string {
  return `sr1.${sessionId}.${sessionMac(secret, requester, sessionId)}`;
}

export type SessionRefCheck = { ok: true; sessionId: string } | { ok: false; status: 400 | 404 };

/**
 * A raw session ID or anything malformed → 400. A well-formed reference whose MAC doesn't match this
 * requester → 404, the same answer as a reference that was never issued (no existence oracle).
 */
export function verifySessionRef(secret: Buffer, requester: SessionOwner, ref: string): SessionRefCheck {
  const m = SESSION_REF_RE.exec(ref);
  if (ref.startsWith("sess_") || m === null) return { ok: false, status: 400 };
  const sessionId = m[1]!;
  // Compare the canonical encodings, not decoded bytes: base64url's last character carries padding bits
  // that decoding ignores, so a byte comparison would accept several spellings of one reference.
  const given = Buffer.from(m[2]!, "utf8");
  const expected = Buffer.from(sessionMac(secret, requester, sessionId), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, status: 404 };
  return { ok: true, sessionId };
}
