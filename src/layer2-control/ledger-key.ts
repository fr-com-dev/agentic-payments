// 1.19 (SPEC.md §8.2 L2-4, INV-9; Phase 3 finding #7). The key of the ledger's keyed chain. The hash chain alone is
// tamper-evident only against someone who can't recompute SHA-256: anyone who can write the ledger file (it sits on
// a network share every app of the environment can reach) can rewrite an entry and every hash after it. With a key,
// every new entry also carries `mac = HMAC-SHA256(key, hash)`, which nobody without the key can recompute.
// The only file that names the variable (rule A16). The key never reaches a log, an entry, a response or an error.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigError } from "../shared/config.js";

export const LEDGER_MAC_ENV = "LEDGER_MAC_KEY";
const MIN_KEY_BYTES = 32;
const MAC_RE = /^[0-9a-f]{64}$/;

/**
 * The key and the length of the ledger's unkeyed beginning. `keyedFrom` is the number of entries the ledger had
 * when the key was adopted (0 for a new ledger): every entry at that index or later must carry a valid MAC, and the
 * ledger must never be shorter than that again.
 */
export interface LedgerMacKey {
  key: Buffer;
  keyedFrom: number;
}

type Env = Record<string, string | undefined>;

function decodeKey(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return Buffer.from(raw, raw.includes("-") || raw.includes("_") ? "base64url" : "base64");
  return null;
}

/**
 * `LEDGER_MAC_KEY`: unset or `off` (no key: the chain is hashed only, as before 1.19), `<secret>` (a new ledger, every
 * entry keyed), or `<n>:<secret>` (an existing ledger of n entries, adopted as it is). The secret is hex or base64 of
 * at least 32 bytes. An error names the variable, never its value.
 */
export function ledgerMacKeyFromEnv(env: Env): LedgerMacKey | undefined {
  const raw = env[LEDGER_MAC_ENV];
  if (raw === undefined || raw === "" || raw === "off") return undefined;
  const m = /^(?:(\d{1,12}):)?(\S+)$/.exec(raw);
  const key = m ? decodeKey(m[2]!) : null;
  if (!m || key === null || key.length < MIN_KEY_BYTES) {
    throw new ConfigError(`${LEDGER_MAC_ENV} must be off, or [<entries>:]<hex or base64 of at least ${MIN_KEY_BYTES} bytes>`);
  }
  return { key, keyedFrom: m[1] === undefined ? 0 : Number(m[1]) };
}

/** The MAC of an entry: HMAC-SHA256 over its hash, which already covers every field and the previous hash. */
export function entryMac(key: Buffer, hash: string): string {
  return createHmac("sha256", key).update(`x402-ledger-v1\n${hash}`, "utf8").digest("hex");
}

/** Constant-time check of an entry's MAC. */
export function macMatches(key: Buffer, hash: string, mac: unknown): boolean {
  if (typeof mac !== "string" || !MAC_RE.test(mac)) return false;
  return timingSafeEqual(Buffer.from(entryMac(key, hash), "hex"), Buffer.from(mac, "hex"));
}

/**
 * 1.23 (L2-4, SEC-39): the MAC of the ledger's head, the record L2 keeps outside the share of how many entries the
 * ledger has and the hash of its last one. Its own prefix, so an entry's MAC (which the ledger file shows anyone who
 * can read it) is never a valid head MAC: a head for a shorter ledger can't be made from the file without the key.
 */
export function headMac(key: Buffer, entries: number, hash: string): string {
  return createHmac("sha256", key).update(`x402-ledger-head-v1\n${entries}\n${hash}`, "utf8").digest("hex");
}

/** Constant-time check of a head's MAC. */
export function headMacMatches(key: Buffer, entries: number, hash: string, mac: unknown): boolean {
  if (typeof mac !== "string" || !MAC_RE.test(mac)) return false;
  return timingSafeEqual(Buffer.from(headMac(key, entries, hash), "hex"), Buffer.from(mac, "hex"));
}
