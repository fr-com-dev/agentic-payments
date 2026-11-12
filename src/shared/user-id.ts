// 013 user identifier (specs/013 data-model.md "Identifiers"). Pure: the hosted agent service and the portal compute
// the same value from the same verified token claims, with no shared secret. It reveals neither a name nor an email
// (FR-046), so it is the only way the ledger names a person.
import { createHash } from "node:crypto";

export const USER_ID_RE = /^usr_[0-9a-f]{32}$/;

/**
 * The issuer as it enters the identifier. A web address gives its host in lower case, so `https://tenant/` and
 * `https://tenant` are one issuer; anything else (the local dev issuer's URN) is taken whole.
 */
export function issuerHost(issuer: string): string {
  const m = /^https:\/\/([^/?#\s]+)\/?$/i.exec(issuer);
  return m ? m[1]!.toLowerCase() : issuer;
}

/**
 * `usr_` + the first 32 hex characters of SHA-256 over `x402-user-v2`, the issuer's host and the token's `sub`,
 * separated by newlines. An empty value, or one that holds a line break, is refused: two different (issuer, subject)
 * pairs must never share an input string. A subject may hold `|` (`auth0|…`), which is why v1's separator went.
 */
export function userIdFor(issuer: string, subject: string): string {
  const host = issuerHost(issuer);
  if (host.length === 0 || subject.length === 0 || /[\n\r]/.test(host) || /[\n\r]/.test(subject)) {
    throw new Error("userIdFor: issuer and subject must be non-empty and free of line breaks");
  }
  const digest = createHash("sha256").update(`x402-user-v2\n${host}\n${subject}`, "utf8").digest("hex");
  return `usr_${digest.slice(0, 32)}`;
}
