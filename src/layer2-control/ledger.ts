// Hash-chained, append-only audit ledger (SPEC.md §8.2 L2-4, L2-4.1, L2-4.2). Owner: feature 003.
// INV-7: every budget figure is derived from entries here; nothing is stored as a counter.
// INV-9: `append` is the only write path; the constructor refuses a broken chain.
// INV-11: `effectiveReport` ignores anomalous SETTLEMENT entries, so CONFIRMED is final.
// Methods that take `nowMs` never read the clock (NFR-007). Amounts are atomic strings; math is BigInt.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SettlementReport } from "../shared/contracts.js";
import { entryMac, LEDGER_MAC_ENV, macMatches, type LedgerMacKey } from "./ledger-key.js";

export type EntryType =
  | "INTENT"
  | "AUTHORIZED"
  | "DENIED"
  | "ESCALATED"
  | "HUMAN_APPROVAL"
  | "SETTLEMENT"
  // 010 escalation lifecycle (L2-4.3)
  | "HUMAN_REJECTION"
  | "ESCALATION_EXPIRED"
  | "APPROVAL_LAPSED"
  | "ESCALATION_REPEATED"
  // 012 backchannel approval (L2-7)
  | "APPROVAL_REQUESTED"
  | "APPROVAL_REQUEST_FAILED"
  | "APPROVAL_REQUEST_LAPSED"
  | "APPROVAL_VERIFICATION_FAILED"
  // 013 user accounts (L2-8)
  | "PLATFORM_CONFIG"
  | "USER_REGISTERED"
  | "WALLET_CREATED"
  | "CARD_ADDED"
  | "CARD_REMOVED"
  | "POLICY_CREATED"
  | "POLICY_CHANGED"
  | "POLICY_PAUSED"
  | "POLICY_RESUMED"
  | "POLICY_REMOVED"
  | "USER_DISABLED"
  | "USER_ENABLED";

export interface LedgerEntry {
  seq: number;
  ts: string;
  type: EntryType;
  sessionId?: string;
  intentId?: string;
  authorizationId?: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
  /**
   * 1.19 (finding #7): HMAC-SHA256 of `hash` under the ledger key, on every entry written with a key. It is not part
   * of what `hash` covers, so entries written before 1.19 verify exactly as they did.
   */
  mac?: string;
}

export interface AppendInput {
  type: EntryType;
  sessionId?: string;
  intentId?: string;
  authorizationId?: string;
  data: Record<string, unknown>;
}

export interface ChainCheck {
  entries: number;
  ok: boolean;
  brokenAt?: number;
}

export type StoredSettlement = SettlementReport & { anomaly: boolean };

export type ReconcileResult = { found: false } | { found: true; ok: true; anomaly: boolean };

/**
 * 013: whose entries a figure counts. `userId: "usr_…"` is that user; `null` is the platform account (entries with
 * no `data.userId`); omitted is every entry, as before user accounts existed. `policyId` narrows a user's entries to
 * one policy.
 */
export interface OwnerFilter {
  userId?: string | null;
  policyId?: string;
}

/** True when the entry belongs to the filter's owner. */
export function ownedBy(e: LedgerEntry, f: OwnerFilter): boolean {
  if (f.userId !== undefined) {
    const owner = typeof e.data.userId === "string" ? e.data.userId : null;
    if (owner !== f.userId) return false;
  }
  if (f.policyId !== undefined && e.data.policyId !== f.policyId) return false;
  return true;
}

export const GENESIS_PREV_HASH = "0".repeat(64);
const RECONCILED_FIELDS = ["asset", "payer", "payTo", "amount"] as const;

/** Recursively sorted keys, no whitespace, arrays in order, absent (undefined) fields omitted. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJSON(x))).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** origin + pathname; the query string is excluded (L2-4). */
export function resourceKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

export function hashEntry(entry: Omit<LedgerEntry, "hash">): string {
  const { hash: _ignored, mac: _mac, ...rest } = entry as LedgerEntry;
  return createHash("sha256").update(canonicalJSON(rest), "utf8").digest("hex");
}

/**
 * Verifies raw JSONL lines. `brokenAt` is the 0-based index of the first bad line.
 * 1.19: with a key, also the keyed chain. Every MAC present must match. From `keyedFrom` on every entry must carry
 * one, and after the first keyed entry every later one must too, so MACs can't be stripped to make a rewritten
 * ledger look unkeyed. A ledger shorter than `keyedFrom` was cut back past the point the key was adopted: it is
 * broken at its end. Without a key only the hashes are checked.
 */
export function verifyLines(lines: readonly string[], mac?: LedgerMacKey): ChainCheck {
  let prevHash = GENESIS_PREV_HASH;
  let keyedSeen = false;
  for (let i = 0; i < lines.length; i++) {
    let e: LedgerEntry;
    try {
      e = JSON.parse(lines[i]!) as LedgerEntry;
    } catch {
      return { entries: lines.length, ok: false, brokenAt: i };
    }
    if (
      e === null ||
      typeof e !== "object" ||
      e.seq !== i ||
      e.prevHash !== prevHash ||
      typeof e.hash !== "string" ||
      hashEntry(e) !== e.hash
    ) {
      return { entries: lines.length, ok: false, brokenAt: i };
    }
    if (mac !== undefined) {
      const keyed = e.mac !== undefined;
      const required = keyedSeen || i >= mac.keyedFrom;
      if ((keyed && !macMatches(mac.key, e.hash, e.mac)) || (!keyed && required)) return { entries: lines.length, ok: false, brokenAt: i };
      keyedSeen ||= keyed;
    }
    prevHash = e.hash;
  }
  if (mac !== undefined && lines.length < mac.keyedFrom) return { entries: lines.length, ok: false, brokenAt: lines.length };
  return { entries: lines.length, ok: true };
}

function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  // Every append ends with "\n", so only the final empty segment is expected. Anything else
  // (a missing newline, an empty line in the middle) is left in place and fails verification.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * L2-4.1: whether an AUTHORIZED amount no longer counts. Only a NOT_SETTLED report can release it, and only once its
 * signature can no longer settle (`nowMs > validBefore`). 1.19: when L2 recorded the authorization's nonce, the
 * report must also name that nonce and have been observed after validBefore, which is when L3 reads the nonce's state
 * on-chain (L3-1). A NOT_SETTLED that only repeats the seller's word ("no PAYMENT-RESPONSE"), made while the seller
 * still held a valid authorization, keeps the amount counted: the seller could settle it a moment later. An entry
 * written before 1.19 has no nonce and keeps the old rule.
 */
function released(auth: LedgerEntry, report: Record<string, unknown>, nowMs: number, skipNonceCheck: boolean): boolean {
  if (report.status !== "NOT_SETTLED") return false;
  const validBeforeMs = BigInt(auth.data.validBefore as number) * 1000n;
  if (BigInt(nowMs) <= validBeforeMs) return false;
  const nonce = auth.data.nonce;
  if (typeof nonce !== "string" || skipNonceCheck) return true;
  const verified = (report.verified ?? {}) as Record<string, unknown>;
  const observedMs = Date.parse(String(report.observedAt));
  return typeof verified.nonce === "string" && verified.nonce.toLowerCase() === nonce.toLowerCase() && Number.isFinite(observedMs) && BigInt(observedMs) > validBeforeMs;
}

export class AuditLedger {
  private readonly items: LedgerEntry[];
  /** Test-only (1.19 must-fail, T-LED-08): release on any NOT_SETTLED after validBefore, as before 1.19. */
  skipNonceCheck = false;
  /** 012: in-memory observers of appended entries (they wake the authorize wait, L2-7). Never part of the chain. */
  private readonly listeners = new Set<(e: LedgerEntry) => void>();

  /** 1.19: the ledger key, when L2 runs with one. Every append is then keyed. */
  private readonly mac: LedgerMacKey | undefined;

  /** 1.19: checked before every append (the ledger lock's `assertHeld`); it throws when this process no longer holds it. */
  private readonly fence: (() => void) | undefined;

  constructor(
    readonly filePath: string,
    opts: { mac?: LedgerMacKey; fence?: () => void } = {},
  ) {
    this.mac = opts.mac;
    this.fence = opts.fence;
    const lines = readLines(filePath);
    const check = verifyLines(lines, this.mac);
    if (!check.ok) {
      throw new Error(`integrity: ledger ${filePath} broken at line ${check.brokenAt}`);
    }
    this.items = lines.map((l) => JSON.parse(l) as LedgerEntry);
    // 1.19: a keyed ledger is never opened without its key, which would write unkeyed entries after keyed ones.
    if (this.mac === undefined && this.items.some((e) => e.mac !== undefined)) {
      throw new Error(`integrity: ledger ${filePath} is keyed; start L2 with its ${LEDGER_MAC_ENV}`);
    }
  }

  /** The only write path. Writes the line synchronously, then records it in memory. */
  append(input: AppendInput, atMs: number = Date.now()): LedgerEntry {
    this.fence?.();
    const last = this.items[this.items.length - 1];
    const body: Omit<LedgerEntry, "hash"> = {
      seq: this.items.length,
      ts: new Date(atMs).toISOString(),
      type: input.type,
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      ...(input.intentId !== undefined && { intentId: input.intentId }),
      ...(input.authorizationId !== undefined && { authorizationId: input.authorizationId }),
      data: input.data,
      prevHash: last ? last.hash : GENESIS_PREV_HASH,
    };
    // Round-trip through JSON so the in-memory entry is exactly what was hashed and written.
    const hash = hashEntry(body);
    const entry = JSON.parse(JSON.stringify({ ...body, hash, ...(this.mac !== undefined && { mac: entryMac(this.mac.key, hash) }) })) as LedgerEntry;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    this.items.push(entry);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A listener can never fail an append: the entry is already written and chained.
      }
    }
    return entry;
  }

  /** 012: calls `listener` with each entry appended from now on. Returns the unsubscribe function. */
  subscribe(listener: (e: LedgerEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  entries(): readonly LedgerEntry[] {
    return this.items;
  }

  /** Re-reads the file so tampering after startup is also detected (1.19: the keyed chain too, with the key). */
  verifyChain(): ChainCheck {
    return verifyLines(readLines(this.filePath), this.mac);
  }

  findAuthorized(authorizationId: string): LedgerEntry | undefined {
    return this.items.find((e) => e.type === "AUTHORIZED" && e.authorizationId === authorizationId);
  }

  /** The highest-seq SETTLEMENT for the authorization among entries with `anomaly !== true`. */
  effectiveReport(authorizationId: string): StoredSettlement | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i]!;
      if (e.type === "SETTLEMENT" && e.authorizationId === authorizationId && e.data.anomaly !== true) {
        return e.data as unknown as StoredSettlement;
      }
    }
    return undefined;
  }

  /**
   * Committed spend (L2-4.1): the sum of AUTHORIZED amounts in the filter, except those whose
   * effective report is NOT_SETTLED and whose signature can no longer settle (nowMs > validBefore×1000).
   * MISMATCH and PENDING keep counting.
   */
  committedAtomic(filter: { sessionId?: string; sinceMs?: number } & OwnerFilter, nowMs: number): bigint {
    const effective = new Map<string, Record<string, unknown>>();
    for (const e of this.items) {
      if (e.type === "SETTLEMENT" && e.authorizationId !== undefined && e.data.anomaly !== true) {
        effective.set(e.authorizationId, e.data);
      }
    }
    let total = 0n;
    for (const e of this.items) {
      if (e.type !== "AUTHORIZED") continue;
      if (filter.sessionId !== undefined && e.sessionId !== filter.sessionId) continue;
      if (filter.sinceMs !== undefined && Date.parse(e.ts) < filter.sinceMs) continue;
      if (!ownedBy(e, filter)) continue;
      const report = e.authorizationId === undefined ? undefined : effective.get(e.authorizationId);
      if (report !== undefined && released(e, report, nowMs, this.skipNonceCheck)) continue;
      total += BigInt(e.data.amount as string);
    }
    return total;
  }

  /** Velocity: AUTHORIZED entries with `ts ≥ sinceMs` (013: of the filter's owner, when one is given). */
  authorizedSince(sinceMs: number, filter: OwnerFilter = {}): number {
    let n = 0;
    for (const e of this.items) {
      if (e.type === "AUTHORIZED" && Date.parse(e.ts) >= sinceMs && ownedBy(e, filter)) n++;
    }
    return n;
  }

  /** 013: the owner of an escalation, read from its ESCALATED entry (`null`: the platform account). */
  private escalationOwner(escalationId: unknown): string | null {
    const esc = this.items.find((e) => e.type === "ESCALATED" && e.authorizationId === escalationId);
    return typeof esc?.data.userId === "string" ? esc.data.userId : null;
  }

  /**
   * L2-4.2: the most recent open HUMAN_APPROVAL for (session, resourceKey). Open means
   * `nowMs ≤ expiresAtMs` and no AUTHORIZED entry has `approvalRef === approvalId` (single use).
   * 013: with `userId` given (`null` for the platform account), only an approval of that owner's escalation counts.
   */
  findOpenApproval(sessionId: string, key: string, nowMs: number, userId?: string | null): LedgerEntry | undefined {
    const consumed = new Set<string>();
    for (const e of this.items) {
      if (e.type === "AUTHORIZED" && typeof e.data.approvalRef === "string") consumed.add(e.data.approvalRef);
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i]!;
      if (e.type !== "HUMAN_APPROVAL" || e.sessionId !== sessionId || e.data.resourceKey !== key) continue;
      if (nowMs > (e.data.expiresAtMs as number)) continue;
      if (consumed.has(e.data.approvalId as string)) continue;
      if (userId !== undefined && this.escalationOwner(e.data.escalationId) !== userId) continue;
      return e;
    }
    return undefined;
  }

  /** Reconcile algorithm (L2-5). The caller holds the L2 mutex and has validated the body. */
  reconcile(report: SettlementReport, atMs?: number): ReconcileResult {
    const auth = this.findAuthorized(report.authorizationId);
    if (!auth) return { found: false };
    const diff: string[] = RECONCILED_FIELDS.filter(
      (f) => String(report.verified[f]).toLowerCase() !== String(auth.data[f]).toLowerCase(),
    );
    // 1.19: a report about another authorization's nonce is a mismatch too, when both sides name one.
    if (typeof auth.data.nonce === "string" && report.verified.nonce !== undefined && String(report.verified.nonce).toLowerCase() !== auth.data.nonce.toLowerCase()) {
      diff.push("nonce");
    }
    let stored: StoredSettlement;
    if (diff.length > 0) {
      stored = { ...report, status: "MISMATCH", detail: `verified field mismatch: ${diff.join(",")}`, anomaly: true };
    } else {
      const eff = this.effectiveReport(report.authorizationId);
      const contradicts =
        eff?.status === "CONFIRMED" && !(report.status === "CONFIRMED" && report.transaction === eff.transaction);
      stored = { ...report, anomaly: contradicts };
    }
    this.append(
      {
        type: "SETTLEMENT",
        ...(auth.sessionId !== undefined && { sessionId: auth.sessionId }),
        authorizationId: report.authorizationId,
        data: stored as unknown as Record<string, unknown>,
      },
      atMs,
    );
    return { found: true, ok: true, anomaly: stored.anomaly };
  }
}
