// Feature 003 — hash-chained ledger, committed spend, reconciliation (SPEC.md §8.2 L2-4, L2-4.1, L2-5).
import express from "express";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettlementReport } from "../src/shared/contracts.js";
import { AuditLedger, GENESIS_PREV_HASH, canonicalJSON, resourceKey } from "../src/layer2-control/ledger.js";
import { mountLedgerRoutes, type Serialize } from "../src/layer2-control/ledger-routes.js";

const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const PAYER = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const PAY_TO = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";
const T0 = Date.parse("2026-10-16T12:00:00.000Z");

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
  file = join(dir, ".local", "ledger-local.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function authorize(l: AuditLedger, id: string, opts: { amount?: string; sessionId?: string; validBefore?: number; at?: number; approvalRef?: string | null } = {}) {
  return l.append(
    {
      type: "AUTHORIZED",
      sessionId: opts.sessionId ?? "sess_a",
      authorizationId: id,
      data: {
        amount: opts.amount ?? "1000",
        asset: ASSET,
        network: "eip155:31337",
        payTo: PAY_TO,
        payer: PAYER,
        validBefore: opts.validBefore ?? Math.floor(T0 / 1000) + 120,
        resourceUrl: "http://127.0.0.1:4021/api/weather?city=Lima",
        mandateId: "mandate-poc-001",
        approvalRef: opts.approvalRef ?? null,
      },
    },
    opts.at ?? T0,
  );
}

function report(id: string, over: Partial<SettlementReport> = {}): SettlementReport {
  return {
    authorizationId: id,
    status: "CONFIRMED",
    transaction: "0xt1",
    network: "eip155:31337",
    blockNumber: "7",
    confirmations: 1,
    finalityClass: "included",
    detail: "ok",
    observedAt: "2026-10-16T12:00:05.000Z",
    verified: { asset: ASSET, payer: PAYER, payTo: PAY_TO, amount: "1000" },
    ...over,
  };
}

const lines = () => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
const writeLines = (ls: string[]) => writeFileSync(file, ls.map((l) => l + "\n").join(""));

function seed(n = 4): AuditLedger {
  const l = new AuditLedger(file);
  for (let i = 0; i < n; i++) {
    l.append({ type: "INTENT", sessionId: "sess_a", intentId: `int_${i}`, data: { resourceUrl: "http://x/y", purpose: "p", accepts: [] } }, T0 + i);
  }
  return l;
}

// ---------- US1: tamper-evident trail ----------

describe("US1 hash chain (T-LED-01)", () => {
  it("T-LED-01 chain verifies; edited entry makes reload throw integrity", () => {
    const l = seed(4);
    const first = l.entries()[0]!;
    expect(first.seq).toBe(0);
    expect(first.prevHash).toBe(GENESIS_PREV_HASH);
    expect(l.verifyChain()).toEqual({ entries: 4, ok: true });
    expect(new AuditLedger(file).entries()).toHaveLength(4);

    for (let target = 0; target < 4; target++) {
      const ls = lines();
      const original = ls.slice();
      ls[target] = ls[target]!.replace('"purpose":"p"', '"purpose":"q"');
      writeLines(ls);
      expect(() => new AuditLedger(file)).toThrow(/integrity/);
      writeLines(original);
    }
    expect(() => new AuditLedger(file)).not.toThrow();
  });

  it("T-LED-01b truncated last line / deleted line / reordered lines fail closed", () => {
    seed(4);
    const ls = lines();

    writeFileSync(file, ls.slice(0, 3).map((l) => l + "\n").join("") + ls[3]!.slice(0, 20));
    expect(() => new AuditLedger(file)).toThrow(/integrity/);

    writeLines([ls[0]!, ls[2]!, ls[3]!]);
    expect(() => new AuditLedger(file)).toThrow(/integrity/);

    writeLines([ls[0]!, ls[2]!, ls[1]!, ls[3]!]);
    expect(() => new AuditLedger(file)).toThrow(/integrity/);

    // No silent repair: the file is left untouched.
    expect(lines()).toEqual([ls[0], ls[2], ls[1], ls[3]]);
  });

  it("verifyChain reports brokenAt as the 0-based line index", () => {
    const l = seed(5);
    const ls = lines();
    ls[3] = ls[3]!.replace('"int_3"', '"int_X"');
    writeLines(ls);
    expect(l.verifyChain()).toEqual({ entries: 5, ok: false, brokenAt: 3 });

    ls[1] = "{not json";
    writeLines(ls);
    expect(l.verifyChain()).toEqual({ entries: 5, ok: false, brokenAt: 1 });
  });

  it("canonicalJSON is key-order independent and omits absent fields", () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJSON({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJSON({ a: undefined, b: null, c: [2, 1] })).toBe('{"b":null,"c":[2,1]}');
  });

  it("a missing file is an empty ledger; append creates it with a trailing newline per line", () => {
    const l = new AuditLedger(file);
    expect(l.entries()).toHaveLength(0);
    expect(l.verifyChain()).toEqual({ entries: 0, ok: true });
    l.append({ type: "INTENT", data: { resourceUrl: "http://x/y", purpose: "p", accepts: [] } }, T0);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(new AuditLedger(file).entries()[0]!.ts).toBe("2026-10-16T12:00:00.000Z");
  });
});

// ---------- US2: committed spend ----------

describe("US2 committed spend (T-LED-02)", () => {
  it("T-LED-02 NOT_SETTLED released only after validBefore", () => {
    const l = new AuditLedger(file);
    const validBefore = Math.floor(T0 / 1000) + 120;
    authorize(l, "auth_1", { validBefore });
    expect(l.committedAtomic({ sessionId: "sess_a" }, T0)).toBe(1000n);

    l.reconcile(report("auth_1", { status: "NOT_SETTLED", transaction: undefined, detail: "no PAYMENT-RESPONSE" }), T0 + 1);
    expect(l.committedAtomic({ sessionId: "sess_a" }, validBefore * 1000)).toBe(1000n);
    expect(l.committedAtomic({ sessionId: "sess_a" }, validBefore * 1000 + 1)).toBe(0n);
  });

  it("PENDING and MISMATCH keep counting at any time", () => {
    const l = new AuditLedger(file);
    authorize(l, "auth_p");
    authorize(l, "auth_m");
    l.reconcile(report("auth_p", { status: "PENDING" }), T0 + 1);
    l.reconcile(report("auth_m", { status: "MISMATCH", detail: "no matching Transfer" }), T0 + 1);
    const far = T0 + 10 * 86_400_000;
    expect(l.committedAtomic({ sessionId: "sess_a" }, far)).toBe(2000n);
  });

  it("committedAtomic filters by sessionId and sinceMs; authorizedSince counts the trailing window", () => {
    const l = new AuditLedger(file);
    const now = T0 + 86_400_000;
    authorize(l, "auth_old", { amount: "7", at: T0 - 1 }); // outside the 24 h window
    authorize(l, "auth_a", { amount: "100", at: now - 61_000 });
    authorize(l, "auth_b", { amount: "200", at: now - 60_000, sessionId: "sess_b" });
    authorize(l, "auth_c", { amount: "300", at: now - 1 });
    expect(l.committedAtomic({ sessionId: "sess_a" }, now)).toBe(407n);
    expect(l.committedAtomic({ sinceMs: now - 86_400_000 }, now)).toBe(600n);
    expect(l.committedAtomic({ sessionId: "sess_b", sinceMs: now - 86_400_000 }, now)).toBe(200n);
    expect(l.authorizedSince(now - 60_000)).toBe(2);
  });

  it("committedAtomic is deterministic in nowMs and uses BigInt", () => {
    const l = new AuditLedger(file);
    const big = "9007199254740993"; // 2^53 + 1, not representable as a Number
    authorize(l, "auth_x", { amount: big });
    authorize(l, "auth_y", { amount: big });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock read");
    });
    expect(l.committedAtomic({ sessionId: "sess_a" }, T0)).toBe(18014398509481986n);
    expect(l.committedAtomic({ sessionId: "sess_a" }, T0)).toBe(l.committedAtomic({ sessionId: "sess_a" }, T0));
    expect(l.authorizedSince(T0 - 1)).toBe(2);
    expect(l.findOpenApproval("sess_a", "http://x/y", T0)).toBeUndefined();
  });
});

// ---------- US3: reconciliation ----------

describe("US3 reconciliation (T-LED-03)", () => {
  it("T-LED-03 anomaly reports are ignored for the effective status", () => {
    const l = new AuditLedger(file);
    authorize(l, "auth_1");
    expect(l.reconcile(report("auth_1"))).toEqual({ found: true, ok: true, anomaly: false });
    expect(l.reconcile(report("auth_1", { status: "NOT_SETTLED", transaction: undefined }))).toEqual({
      found: true,
      ok: true,
      anomaly: true,
    });
    expect(l.effectiveReport("auth_1")?.status).toBe("CONFIRMED");
    expect(l.effectiveReport("auth_1")?.transaction).toBe("0xt1");
  });

  it("reconcile: field mismatch → MISMATCH, anomaly, detail names every field", () => {
    const l = new AuditLedger(file);
    authorize(l, "auth_1");
    const r = l.reconcile(report("auth_1", { verified: { asset: ASSET, payer: PAYER, payTo: "0x0000000000000000000000000000000000000001", amount: "999" } }));
    expect(r).toEqual({ found: true, ok: true, anomaly: true });
    const stored = l.entries().at(-1)!;
    expect(stored.type).toBe("SETTLEMENT");
    expect(stored.data.status).toBe("MISMATCH");
    expect(stored.data.anomaly).toBe(true);
    // Field order is fixed by the algorithm: asset, payer, payTo, amount.
    expect(stored.data.detail).toBe("verified field mismatch: payTo,amount");

    // Address casing alone is not a mismatch.
    const ok = l.reconcile(
      report("auth_1", { verified: { asset: ASSET.toLowerCase(), payer: PAYER.toUpperCase().replace("0X", "0x"), payTo: PAY_TO.toLowerCase(), amount: "1000" } }),
    );
    expect(ok.found && ok.anomaly).toBe(false);
  });

  it("reconcile: repeated CONFIRMED same tx is non-anomalous; PENDING→CONFIRMED allowed", () => {
    const l = new AuditLedger(file);
    authorize(l, "auth_1");
    expect(l.reconcile(report("auth_1", { status: "PENDING" }))).toMatchObject({ anomaly: false });
    expect(l.reconcile(report("auth_1"))).toMatchObject({ anomaly: false });
    expect(l.reconcile(report("auth_1"))).toMatchObject({ anomaly: false });
    expect(l.reconcile(report("auth_1", { transaction: "0xother" }))).toMatchObject({ anomaly: true });
    expect(l.effectiveReport("auth_1")?.transaction).toBe("0xt1");
  });

  it("reconcile: unknown authorizationId is not found and appends nothing", () => {
    const l = new AuditLedger(file);
    authorize(l, "auth_1");
    expect(l.reconcile(report("auth_nope"))).toEqual({ found: false });
    expect(l.entries()).toHaveLength(1);
  });
});

// ---------- US3/US4: routes, in-process ----------

const SETTLEMENT = "test-settlement-token";
const OPERATOR = "test-operator-token";
const CONTROL = "test-control-token";

async function startRoutes(l: AuditLedger) {
  let tail: Promise<unknown> = Promise.resolve();
  const serialize: Serialize = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
  const app = express();
  mountLedgerRoutes(app, { ledger: l, serialize, tokens: { settlement: SETTLEMENT, operator: OPERATOR } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const post = (base: string, token: string, body: unknown) =>
  fetch(`${base}/v1/reconcile`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("ledger routes (in-process)", () => {
  it("reconcile: malformed body → 400, unknown authorizationId → 404, nothing appended", async () => {
    const l = new AuditLedger(file);
    authorize(l, "auth_1");
    const s = await startRoutes(l);
    try {
      const { verified: _v, ...noVerified } = report("auth_1");
      const missingAmount = { ...report("auth_1"), verified: { asset: ASSET, payer: PAYER, payTo: PAY_TO } };
      const { authorizationId: _a, ...noId } = report("auth_1");
      for (const body of [noVerified, missingAmount, noId, "not json"]) {
        expect((await post(s.base, SETTLEMENT, body)).status).toBe(400);
      }
      const nf = await post(s.base, SETTLEMENT, report("auth_unknown"));
      expect(nf.status).toBe(404);
      expect(l.entries()).toHaveLength(1);

      const ok = await post(s.base, SETTLEMENT, report("auth_1"));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, anomaly: false });
      expect(l.entries()).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("reconcile accepts only the settlement token; other tokens get 401 before any ledger access", async () => {
    const l = new AuditLedger(file);
    authorize(l, "auth_1");
    const s = await startRoutes(l);
    try {
      for (const t of [CONTROL, OPERATOR, "test-verifier-token", ""]) {
        expect((await post(s.base, t, report("auth_1"))).status).toBe(401);
        expect((await post(s.base, t, "not json")).status).toBe(401);
      }
      expect(l.entries()).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("GET /v1/ledger/verify: operator token → {entries, ok}; other tokens → 401", async () => {
    const l = seed(3);
    const s = await startRoutes(l);
    try {
      const get = (t: string) => fetch(`${s.base}/v1/ledger/verify`, { headers: { authorization: `Bearer ${t}` } });
      const r = await get(OPERATOR);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ entries: 3, ok: true });
      for (const t of [CONTROL, SETTLEMENT]) expect((await get(t)).status).toBe(401);
    } finally {
      await s.close();
    }
  });
});

// ---------- Polish: resourceKey, schema ----------

describe("resourceKey", () => {
  it("excludes the query string and keeps the port in the origin", () => {
    expect(resourceKey("http://127.0.0.1:4021/api/weather?city=Lima")).toBe("http://127.0.0.1:4021/api/weather");
    expect(resourceKey("http://127.0.0.1:4021/api/weather?city=Quito")).toBe(resourceKey("http://127.0.0.1:4021/api/weather?city=Lima"));
    expect(resourceKey("http://localhost:4021/api/weather")).not.toBe(resourceKey("http://127.0.0.1:4021/api/weather"));
  });
});

// Minimal JSON Schema subset (type, required, enum, pattern, $ref, if/then on const) — enough for the
// ledger-entry contract without adding a validator dependency.
type Schema = Record<string, any>;
const SCHEMA: Schema = JSON.parse(
  readFileSync(new URL("../specs/003-audit-ledger-reconciliation/contracts/ledger-entry.schema.json", import.meta.url), "utf8"),
);

function validate(schema: Schema, v: unknown, path = "$"): string[] {
  if (schema.$ref) return validate(SCHEMA.$defs[(schema.$ref as string).split("/").pop()!], v, path);
  const errs: string[] = [];
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
    if (!types.includes(actual)) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: not in enum`);
  if (schema.const !== undefined && v !== schema.const) errs.push(`${path}: const`);
  if (schema.pattern && typeof v === "string" && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: pattern ${schema.pattern}`);
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) errs.push(`${path}.${k}: required`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o) errs.push(...validate(s as Schema, o[k], `${path}.${k}`));
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
  for (const sub of schema.allOf ?? []) {
    if (validate(sub.if, v, path).length === 0) errs.push(...validate(sub.then, v, path));
  }
  return errs;
}

describe("ledger entry schema", () => {
  it("sample entries of all six types validate against contracts/ledger-entry.schema.json", () => {
    const l = new AuditLedger(file);
    l.append({ type: "INTENT", sessionId: "sess_a", intentId: "int_1", data: { resourceUrl: "http://127.0.0.1:4021/api/premium-report", purpose: "p", accepts: [] } }, T0);
    l.append(
      { type: "ESCALATED", sessionId: "sess_a", intentId: "int_1", authorizationId: "auth_e", data: { violations: [{ rule: "human_approval_required", detail: "50000 > 20000" }], resourceKey: "http://127.0.0.1:4021/api/premium-report", payTo: PAY_TO, amount: "50000" } },
      T0,
    );
    l.append(
      { type: "HUMAN_APPROVAL", sessionId: "sess_a", authorizationId: "auth_e", data: { approvalId: "apr_1", escalationId: "auth_e", resourceKey: "http://127.0.0.1:4021/api/premium-report", payTo: PAY_TO, amount: "50000", approver: "operator", expiresAtMs: T0 + 600_000 } },
      T0,
    );
    authorize(l, "auth_1", { approvalRef: "apr_1" });
    l.append({ type: "DENIED", sessionId: "sess_a", intentId: "int_2", authorizationId: "auth_d", data: { violations: [{ rule: "hard_cap_exceeded", detail: "x" }], resourceKey: "http://127.0.0.1:4021/api/dataset-export" } }, T0);
    l.reconcile(report("auth_1"), T0);

    const types = new Set(l.entries().map((e) => e.type));
    expect(types.size).toBe(6);
    for (const e of l.entries()) expect(validate(SCHEMA, e), e.type).toEqual([]);

    // The validator does reject a bad entry.
    const bad = { ...l.entries()[3]!, data: { ...l.entries()[3]!.data, approvalRef: "esc_1" } };
    expect(validate(SCHEMA, bad)).not.toEqual([]);
  });
});

// 003 T015: the L2 bootstrap (002) constructs the ledger before anything else and exits on a broken chain.
describe("tampered ledger → L2 process exits non-zero (FR-005, FR-007)", () => {
  it("T015 exits 1 with `integrity` on stderr and never listens", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { createConnection } = await import("node:net");
    const repo = resolve(import.meta.dirname, "..");
    const l = new AuditLedger(file);
    l.append({ type: "INTENT", sessionId: "s", intentId: "i1", data: { resourceUrl: "http://x/", purpose: "p", accepts: [] } }, T0);
    l.append({ type: "INTENT", sessionId: "s", intentId: "i2", data: { resourceUrl: "http://x/", purpose: "p", accepts: [] } }, T0);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[0] = lines[0]!.replace('"purpose":"p"', '"purpose":"q"');
    writeFileSync(file, lines.join("\n"));
    mkdirSync(join(dir, "env"), { recursive: true });
    const port = 47320;
    const r = spawnSync(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "src", "layer2-control", "service.ts")], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NETWORK: "local", CONTROL_PORT: String(port) },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("integrity");
    const listening = await new Promise<boolean>((res) => {
      const c = createConnection({ host: "127.0.0.1", port }, () => (c.end(), res(true)));
      c.on("error", () => res(false));
    });
    expect(listening).toBe(false);
  });
});

// ---------- 004: findOpenApproval semantics (L2-4.2, D2) ----------

describe("findOpenApproval (004 T005)", () => {
  const KEY = "http://127.0.0.1:4021/api/premium-report";
  function approve(l: AuditLedger, approvalId: string, opts: { sessionId?: string; key?: string; payTo?: string; amount?: string; expiresAtMs?: number; at?: number } = {}) {
    return l.append(
      {
        type: "HUMAN_APPROVAL",
        sessionId: opts.sessionId ?? "sess_a",
        authorizationId: "auth_esc",
        data: {
          approvalId,
          escalationId: "auth_esc",
          resourceKey: opts.key ?? KEY,
          payTo: opts.payTo ?? PAY_TO,
          amount: opts.amount ?? "50000",
          approver: "operator",
          expiresAtMs: opts.expiresAtMs ?? T0 + 600_000,
        },
      },
      opts.at ?? T0,
    );
  }
  const id = (e: ReturnType<AuditLedger["findOpenApproval"]>) => e?.data.approvalId;

  it("returns the most recent open approval, and undefined when nothing is open", () => {
    const l = new AuditLedger(file);
    expect(l.findOpenApproval("sess_a", KEY, T0)).toBeUndefined();
    approve(l, "apr_old");
    approve(l, "apr_new", { at: T0 + 1 });
    expect(id(l.findOpenApproval("sess_a", KEY, T0 + 2))).toBe("apr_new");
  });

  it("excludes entries where nowMs > data.expiresAtMs (the boundary is still open)", () => {
    const l = new AuditLedger(file);
    approve(l, "apr_1", { expiresAtMs: T0 + 1000 });
    expect(id(l.findOpenApproval("sess_a", KEY, T0 + 1000))).toBe("apr_1");
    expect(l.findOpenApproval("sess_a", KEY, T0 + 1001)).toBeUndefined();
  });

  it("excludes an approval whose approvalId is an AUTHORIZED approvalRef; a second approval of the same escalation stays open", () => {
    const l = new AuditLedger(file);
    approve(l, "apr_1");
    approve(l, "apr_2", { at: T0 + 1 });
    authorize(l, "auth_p1", { amount: "50000", approvalRef: "apr_2", at: T0 + 2 });
    expect(id(l.findOpenApproval("sess_a", KEY, T0 + 3))).toBe("apr_1");
    authorize(l, "auth_p2", { amount: "50000", approvalRef: "apr_1", at: T0 + 4 });
    expect(l.findOpenApproval("sess_a", KEY, T0 + 5)).toBeUndefined();
  });

  it("most recent wins: a newer open approval masks an older one even if only the older matches payee and amount", () => {
    const l = new AuditLedger(file);
    approve(l, "apr_match", { amount: "50000" });
    approve(l, "apr_other", { amount: "60000", at: T0 + 1 });
    const found = l.findOpenApproval("sess_a", KEY, T0 + 2);
    expect(id(found)).toBe("apr_other");
    expect(found?.data.amount).toBe("60000");
  });

  it("does not match a different sessionId or resourceKey", () => {
    const l = new AuditLedger(file);
    approve(l, "apr_1");
    expect(l.findOpenApproval("sess_b", KEY, T0)).toBeUndefined();
    expect(l.findOpenApproval("sess_a", "http://127.0.0.1:4021/api/weather", T0)).toBeUndefined();
  });
});
