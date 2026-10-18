// Hash-chained, append-only audit ledger (SPEC.md §8.2 L2-4, L2-4.1, L2-4.2). Owner: feature 003.
// INV-7: every budget figure is derived from entries here; nothing is stored as a counter.
// INV-9: `append` is the only write path; the constructor refuses a broken chain.
// INV-11: `effectiveReport` ignores anomalous SETTLEMENT entries, so CONFIRMED is final.
// Methods that take `nowMs` never read the clock (NFR-007). Amounts are atomic strings; math is BigInt.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SettlementReport } from "../shared/contracts.js";

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
  | "ESCALATION_REPEATED";

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
  const { hash: _ignored, ...rest } = entry as LedgerEntry;
  return createHash("sha256").update(canonicalJSON(rest), "utf8").digest("hex");
}

/** Verifies raw JSONL lines. `brokenAt` is the 0-based index of the first bad line. */
export function verifyLines(lines: readonly string[]): ChainCheck {
  let prevHash = GENESIS_PREV_HASH;
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
    prevHash = e.hash;
  }
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

export class AuditLedger {
  private readonly items: LedgerEntry[];

  constructor(readonly filePath: string) {
    const lines = readLines(filePath);
    const check = verifyLines(lines);
    if (!check.ok) {
      throw new Error(`integrity: ledger ${filePath} broken at line ${check.brokenAt}`);
    }
    this.items = lines.map((l) => JSON.parse(l) as LedgerEntry);
  }

  /** The only write path. Writes the line synchronously, then records it in memory. */
  append(input: AppendInput, atMs: number = Date.now()): LedgerEntry {
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
    const entry = JSON.parse(JSON.stringify({ ...body, hash: hashEntry(body) })) as LedgerEntry;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    this.items.push(entry);
    return entry;
  }

  entries(): readonly LedgerEntry[] {
    return this.items;
  }

  /** Re-reads the file so tampering after startup is also detected. */
  verifyChain(): ChainCheck {
    return verifyLines(readLines(this.filePath));
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
  committedAtomic(filter: { sessionId?: string; sinceMs?: number }, nowMs: number): bigint {
    const effective = new Map<string, string>();
    for (const e of this.items) {
      if (e.type === "SETTLEMENT" && e.authorizationId !== undefined && e.data.anomaly !== true) {
        effective.set(e.authorizationId, e.data.status as string);
      }
    }
    let total = 0n;
    for (const e of this.items) {
      if (e.type !== "AUTHORIZED") continue;
      if (filter.sessionId !== undefined && e.sessionId !== filter.sessionId) continue;
      if (filter.sinceMs !== undefined && Date.parse(e.ts) < filter.sinceMs) continue;
      const status = e.authorizationId === undefined ? undefined : effective.get(e.authorizationId);
      const validBeforeMs = BigInt(e.data.validBefore as number) * 1000n;
      if (status === "NOT_SETTLED" && BigInt(nowMs) > validBeforeMs) continue;
      total += BigInt(e.data.amount as string);
    }
    return total;
  }

  /** Velocity: AUTHORIZED entries with `ts ≥ sinceMs`. */
  authorizedSince(sinceMs: number): number {
    let n = 0;
    for (const e of this.items) {
      if (e.type === "AUTHORIZED" && Date.parse(e.ts) >= sinceMs) n++;
    }
    return n;
  }

  /**
   * L2-4.2: the most recent open HUMAN_APPROVAL for (session, resourceKey). Open means
   * `nowMs ≤ expiresAtMs` and no AUTHORIZED entry has `approvalRef === approvalId` (single use).
   */
  findOpenApproval(sessionId: string, key: string, nowMs: number): LedgerEntry | undefined {
    const consumed = new Set<string>();
    for (const e of this.items) {
      if (e.type === "AUTHORIZED" && typeof e.data.approvalRef === "string") consumed.add(e.data.approvalRef);
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i]!;
      if (e.type !== "HUMAN_APPROVAL" || e.sessionId !== sessionId || e.data.resourceKey !== key) continue;
      if (nowMs > (e.data.expiresAtMs as number)) continue;
      if (consumed.has(e.data.approvalId as string)) continue;
      return e;
    }
    return undefined;
  }

  /** Reconcile algorithm (L2-5). The caller holds the L2 mutex and has validated the body. */
  reconcile(report: SettlementReport, atMs?: number): ReconcileResult {
    const auth = this.findAuthorized(report.authorizationId);
    if (!auth) return { found: false };
    const diff = RECONCILED_FIELDS.filter(
      (f) => String(report.verified[f]).toLowerCase() !== String(auth.data[f]).toLowerCase(),
    );
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
