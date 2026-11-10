// 013 user identifier (specs/013 data-model.md "Identifiers"). Pure: the hosted agent service and the portal compute
// the same value from the same verified token claims, with no shared secret. It reveals neither a name nor an email
// (FR-046), so it is the only way the ledger names a person.
import { createHash } from "node:crypto";

export const USER_ID_RE = /^usr_[0-9a-f]{32}$/;

/**
 * `usr_` + the first 32 hex characters of SHA-256 over `x402-user-v1|<tid>|<oid>`. An empty value, or one that holds
 * the separator, is refused: two different (tid, oid) pairs must never share an input string.
 */
export function userIdFor(tid: string, oid: string): string {
  if (tid.length === 0 || oid.length === 0 || tid.includes("|") || oid.includes("|")) {
    throw new Error("userIdFor: tid and oid must be non-empty and free of '|'");
  }
  const digest = createHash("sha256").update(`x402-user-v1|${tid}|${oid}`, "utf8").digest("hex");
  return `usr_${digest.slice(0, 32)}`;
}
