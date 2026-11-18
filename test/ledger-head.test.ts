// 1.23 (Phase 3, finding #7) — the ledger's head outside the share (SPEC.md §8.2 L2-4, L2-6, INV-9, SEC-39;
// T-LED-11..14). The keyed chain (T-LED-09) refuses a rewritten entry, but a ledger cut back to a shorter prefix still
// verifies: every entry left is genuine, and what the removed ones recorded (a payment's amount) no longer counts.
// L2 now keeps `{ entries, hash, mac }` where only it can write, rewrites it after every serialized section, and
// refuses at startup a ledger the head doesn't describe.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaymentIntent } from "../src/shared/contracts.js";
import { AuditLedger, GENESIS_PREV_HASH, type LedgerEntry } from "../src/layer2-control/ledger.js";
import { headMac, type LedgerMacKey } from "../src/layer2-control/ledger-key.js";
import { headFor, headProblem, LedgerHeadError, openLedgerHead, type HeadStore, type LedgerHead } from "../src/layer2-control/ledger-head.js";
import { BlobHeadStore, FileHeadStore, headNameFor, ledgerHeadStoreFromEnv } from "../src/layer2-control/ledger-head-store.js";
import { buildMandate } from "../src/layer2-control/mandate.js";
import { createControlService, createSerializer } from "../src/layer2-control/service.js";
import type { PaymentSignerLike } from "../src/layer2-control/signer.js";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const KEY: LedgerMacKey = { key: Buffer.alloc(32, 0x11), keyedFrom: 0 };
const CLIENT_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

let dir: string;
let file: string;
let headFile: string;
let servers: Server[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-head-"));
  file = join(dir, "ledger-local.jsonl");
  headFile = join(dir, "heads", headNameFor(file));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

const lines = () => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
const cutTo = (n: number) => writeFileSync(file, lines().slice(0, n).map((l) => `${l}\n`).join(""));
const storedHead = () => JSON.parse(readFileSync(headFile, "utf8")) as LedgerHead;
const store = () => new FileHeadStore(headFile);

/** One AUTHORIZED of `amount` in session s; it counts until a NOT_SETTLED releases it. */
function pay(l: AuditLedger, i: number, amount = "1000"): void {
  l.append(
    {
      type: "AUTHORIZED",
      sessionId: "s",
      intentId: `int_${i}`,
      authorizationId: `auth_${i}`,
      data: { amount, asset: "0xa", network: "eip155:31337", payTo: "0xc", payer: "0xf", validBefore: T0 / 1000 + 120, resourceUrl: "http://x/y", mandateId: "m", approvalRef: null },
    },
    T0 + i,
  );
}
const committed = (l: AuditLedger) => l.committedAtomic({ sessionId: "s" }, T0 + 60_000);

/** A ledger of `n` payments with its head written, as a running L2 leaves it (null: no key). */
async function paidLedger(n: number, mac: LedgerMacKey | null = KEY): Promise<AuditLedger> {
  const l = new AuditLedger(file, mac ? { mac } : {});
  const { anchor } = await openLedgerHead(l, store(), mac ? { mac } : {});
  for (let i = 0; i < n; i++) {
    pay(l, i);
    await anchor.flush();
  }
  return l;
}

/** Opens the file as main() does: the ledger under its key (null: none), then the head. */
async function reopen(mac: LedgerMacKey | null = KEY, opts: { skipHeadCheck?: boolean } = {}): Promise<AuditLedger> {
  const l = new AuditLedger(file, mac ? { mac } : {});
  await openLedgerHead(l, store(), { ...(mac && { mac }), ...opts });
  return l;
}

describe("T-LED-11 the ledger head refuses a cut ledger at startup", () => {
  it("T-LED-11 a ledger cut back to an earlier prefix verifies on its own, but not against its head", async () => {
    await paidLedger(4);
    expect(storedHead()).toEqual(headFor(lines().map((x) => JSON.parse(x) as LedgerEntry), KEY));
    cutTo(3);
    // The keyed chain alone accepts the cut: the three entries left are genuine.
    expect(new AuditLedger(file, { mac: KEY }).verifyChain()).toEqual({ entries: 3, ok: true });
    await expect(reopen()).rejects.toThrow(/^integrity: the ledger has 3 entries, fewer than the 4 its head records: entries were removed$/);
  });

  it("T-LED-11 must fail: with skipHeadCheck, the cut ledger opens and the removed payment no longer counts", async () => {
    expect(committed(await paidLedger(4))).toBe(4000n);
    cutTo(3);
    expect(committed(await reopen(KEY, { skipHeadCheck: true }))).toBe(3000n);
  });

  it("T-LED-11 an unkeyed ledger replaced by another of the same length is refused at the head's last entry", async () => {
    await paidLedger(3, null);
    rmSync(file);
    const other = new AuditLedger(file);
    for (let i = 0; i < 3; i++) pay(other, i, "1");
    expect(other.verifyChain().ok).toBe(true);
    await expect(reopen(null)).rejects.toThrow(/^integrity: the ledger's entry 2 is not the one its head records$/);
  });

  it("T-LED-11 a head for the shorter ledger is refused unless made with the key: an entry's MAC from the file is not a head's", async () => {
    await paidLedger(4);
    cutTo(3);
    const last = JSON.parse(lines()[2]!) as LedgerEntry;
    // What someone who can write both the share and the head, but has no key, can make from the file.
    writeFileSync(headFile, JSON.stringify({ v: 1, entries: 3, hash: last.hash, mac: last.mac }));
    await expect(reopen()).rejects.toThrow(/^integrity: the ledger head's MAC does not match$/);
    writeFileSync(headFile, JSON.stringify({ v: 1, entries: 3, hash: last.hash }));
    await expect(reopen()).rejects.toThrow(/carries no MAC, but was written after the key was adopted/);
    // With the key, it is a genuine head: only L2 holds the key.
    writeFileSync(headFile, JSON.stringify({ v: 1, entries: 3, hash: last.hash, mac: headMac(KEY.key, 3, last.hash) }));
    expect((await reopen()).entries()).toHaveLength(3);
  });

  it("T-LED-11 a head without a MAC from before the key's adoption is accepted; a keyed head without the key is refused", async () => {
    await paidLedger(2, null);
    expect(storedHead().mac).toBeUndefined();
    const adopted = { ...KEY, keyedFrom: 2 };
    const l = await reopen(adopted);
    expect(storedHead()).toEqual({ v: 1, entries: 2, hash: l.entries()[1]!.hash, mac: headMac(KEY.key, 2, l.entries()[1]!.hash) });
    pay(l, 2);
    await expect(reopen(null)).rejects.toThrow(/is keyed; start L2/);
  });

  it("T-LED-11 a malformed head stops L2; so does a store that can't be read, which is never taken for an empty one", async () => {
    await paidLedger(1);
    for (const bad of ["not json", JSON.stringify({ v: 2, entries: 1, hash: GENESIS_PREV_HASH }), JSON.stringify({ ...storedHead(), extra: 1 }), JSON.stringify({ ...storedHead(), entries: -1 })]) {
      writeFileSync(headFile, bad);
      await expect(reopen(), bad).rejects.toThrow(/^integrity: the ledger head is malformed$/);
    }
    const broken: HeadStore = { where: "nowhere", read: () => Promise.reject(new Error("HTTP 403 (AuthorizationPermissionMismatch)")), write: () => Promise.resolve() };
    await expect(openLedgerHead(new AuditLedger(file, { mac: KEY }), broken, { mac: KEY })).rejects.toThrow(LedgerHeadError);
  });

  it("T-LED-11 no stored head: the ledger is adopted as it is, and its head written before anything is served", async () => {
    const l = new AuditLedger(file, { mac: KEY });
    pay(l, 0);
    pay(l, 1);
    const { adopted, anchor } = await openLedgerHead(l, store(), { mac: KEY });
    expect(adopted).toBe(true);
    expect(anchor.written).toEqual(storedHead());
    expect(storedHead()).toMatchObject({ v: 1, entries: 2, hash: l.entries()[1]!.hash });
    // A longer ledger than the head (a crash between an append and its head) opens, and the head moves up to it.
    pay(l, 2);
    const again = await reopen();
    expect(again.entries()).toHaveLength(3);
    expect(storedHead().entries).toBe(3);
    expect(headProblem(storedHead(), again.entries(), KEY)).toBeUndefined();
  });

  it("T-LED-11 while L2 runs, the operator's check refuses a file shorter than the head L2 last wrote", async () => {
    const l = await paidLedger(3);
    expect(l.verifyChain()).toEqual({ entries: 3, ok: true });
    cutTo(2);
    expect(l.verifyChain()).toEqual({ entries: 2, ok: false, brokenAt: 2 });
  });
});

describe("T-LED-12 every serialized section writes the head before its result is returned", () => {
  it("T-LED-12 the head is written inside the section: before the caller sees the result and before the next section starts", async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const serialize = createSerializer(async () => {
      order.push("flush:start");
      await slow;
      order.push("flush:end");
    });
    const first = serialize(() => order.push("a")).then(() => order.push("a:returned"));
    const second = serialize(() => order.push("b"));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["a", "flush:start"]);
    release();
    await Promise.all([first, second]);
    expect(order.slice(0, 4)).toEqual(["a", "flush:start", "flush:end", "a:returned"]);
    expect(order.indexOf("b")).toBeGreaterThan(order.indexOf("flush:end"));
  });

  it("T-LED-12 a head that can't be written fails its section, also after the section threw, and the next section still runs", async () => {
    let fail = true;
    const serialize = createSerializer(async () => {
      if (fail) throw new LedgerHeadError("ledger head: writing the head answered HTTP 503");
    });
    await expect(serialize(() => 1)).rejects.toThrow(LedgerHeadError);
    await expect(serialize(() => Promise.reject(new Error("section")))).rejects.toThrow(LedgerHeadError);
    fail = false;
    await expect(serialize(() => 2)).resolves.toBe(2);
  });

  it("T-LED-12 an authorize whose head can't be written answers 500 internal error with no payment header; the entry still counts", async () => {
    const l = new AuditLedger(file, { mac: KEY });
    const real = store();
    let failing = false;
    const flaky: HeadStore = { where: real.where, read: () => real.read(), write: (h) => (failing ? Promise.reject(new Error("writing the head answered HTTP 503")) : real.write(h)) };
    const { anchor } = await openLedgerHead(l, flaky, { mac: KEY });
    const base = await startL2(l, anchor);
    const ok = await authorize(base, "0");
    expect(ok.status).toBe(200);
    expect((ok.body as { status: string }).status).toBe("AUTHORIZED");
    expect(storedHead().entries).toBe(l.entries().length);

    failing = true;
    const refused = await authorize(base, "1");
    expect(refused).toEqual({ status: 500, body: { error: "internal error" } });
    expect(l.entries().filter((e) => e.type === "AUTHORIZED")).toHaveLength(2);
    expect(storedHead().entries).toBe(2);
    // The reconcile route fails the same way, with the same fixed answer.
    const rec = await fetch(`${base}/v1/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t-settlement" },
      body: JSON.stringify({ authorizationId: l.entries()[1]!.authorizationId, status: "PENDING", verified: { asset: "0xa", payer: "0xf", payTo: "0xc", amount: "1000" }, observedAt: new Date(T0).toISOString() }),
    });
    expect(rec.status).toBe(500);
    expect(await rec.json()).toEqual({ error: "internal error" });

    // Once the store answers again, the next section's head covers everything before it.
    failing = false;
    expect((await authorize(base, "2")).status).toBe(200);
    expect(storedHead()).toEqual(headFor(l.entries(), KEY));
  });
});

describe("T-LED-13 the head's blob store", () => {
  interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: string;
  }
  /** A stand-in for the identity endpoint and one blob, with ETags. */
  function azure(opts: { blob?: string; tokenStatus?: number; putStatus?: number } = {}) {
    const calls: Call[] = [];
    let blob = opts.blob;
    let etag = blob === undefined ? undefined : '"0x1"';
    let n = 1;
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, method: init?.method ?? "GET", headers, ...(init?.body !== undefined && { body: String(init.body) }), ...(init?.redirect !== undefined && { redirect: init.redirect }) });
      if (url.startsWith("http://localhost:42356/msi/token")) {
        if (opts.tokenStatus !== undefined) return new Response("{}", { status: opts.tokenStatus });
        return Response.json({ access_token: "tok-secret-value", expires_on: String(Math.floor(T0 / 1000) + 3600), token_type: "Bearer" });
      }
      if ((init?.method ?? "GET") === "GET") {
        if (blob === undefined) return new Response("", { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } });
        return new Response(blob, { status: 200, headers: { etag: etag! } });
      }
      if (opts.putStatus !== undefined) return new Response("", { status: opts.putStatus, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } });
      const ifMatch = headers["if-match"];
      const ifNone = headers["if-none-match"];
      if ((ifNone === "*" && blob !== undefined) || (ifMatch !== undefined && ifMatch !== etag)) return new Response("", { status: 412 });
      blob = String(init?.body);
      etag = `"0x${++n}"`;
      return new Response("", { status: 201, headers: { etag } });
    };
    const make = () =>
      new BlobHeadStore({
        containerUrl: "https://stl2headeastus2dev.blob.core.windows.net/ledger-head",
        blobName: "ledger-base-sepolia.head.json",
        clientId: CLIENT_ID,
        identityEndpoint: "http://localhost:42356/msi/token",
        identityHeader: "id-header",
        fetch: fake,
        now: () => T0,
      });
    return { calls, make, blob: () => blob, setBlob: (b: string) => ((blob = b), (etag = `"0x${++n}"`)) };
  }
  const head: LedgerHead = { v: 1, entries: 1, hash: "ab".repeat(32) };

  it("T-LED-13 a token for storage from the head identity, then a conditional write: If-None-Match * first, If-Match after", async () => {
    const az = azure();
    const s = az.make();
    expect(await s.read()).toBeUndefined();
    await s.write(head);
    await s.write({ ...head, entries: 2 });
    const token = az.calls[0]!;
    const u = new URL(token.url);
    expect(Object.fromEntries(u.searchParams)).toEqual({ resource: "https://storage.azure.com/", "api-version": "2019-08-01", client_id: CLIENT_ID });
    expect(token.headers["x-identity-header"]).toBe("id-header");
    const blobCalls = az.calls.filter((c) => c.url.includes(".blob."));
    expect(blobCalls.map((c) => c.method)).toEqual(["GET", "PUT", "PUT"]);
    expect(blobCalls.every((c) => c.url === "https://stl2headeastus2dev.blob.core.windows.net/ledger-head/ledger-base-sepolia.head.json" && c.headers.authorization === "Bearer tok-secret-value" && c.headers["x-ms-version"] === "2023-11-03" && c.redirect === "error")).toBe(true);
    expect(blobCalls[1]!.headers).toMatchObject({ "if-none-match": "*", "x-ms-blob-type": "BlockBlob" });
    expect(blobCalls[2]!.headers["if-match"]).toBe('"0x2"');
    // One token for all three: it is kept until five minutes before it expires.
    expect(az.calls.filter((c) => c.url.includes("/msi/token"))).toHaveLength(1);
    expect(JSON.parse(az.blob()!)).toEqual({ ...head, entries: 2 });
  });

  it("T-LED-13 a head changed by another writer since this store saw it is never overwritten", async () => {
    const az = azure({ blob: JSON.stringify(head) });
    const s = az.make();
    expect(await s.read()).toEqual(head);
    az.setBlob(JSON.stringify({ ...head, entries: 5 }));
    await expect(s.write({ ...head, entries: 2 })).rejects.toThrow(/changed by another writer/);
    expect(JSON.parse(az.blob()!).entries).toBe(5);
  });

  it("T-LED-13 every failure names the status and Azure's error code, never the token", async () => {
    for (const [az, what] of [
      [azure({ tokenStatus: 400 }), /managed identity endpoint answered HTTP 400/],
      [azure({ putStatus: 403 }), /writing the head answered HTTP 403 \(AuthorizationPermissionMismatch\)/],
    ] as const) {
      const s = az.make();
      const err = await s
        .read()
        .then(() => s.write(head))
        .then(
          () => undefined,
          (e: Error) => e,
        );
      expect(err?.message).toMatch(what);
      expect(err?.message).not.toContain("tok-secret-value");
    }
  });
});

describe("T-LED-14 LEDGER_HEAD_URL", () => {
  const ledgerPath = ".local/ledger-base-sepolia.jsonl";
  const identity = { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "h" };

  it("T-LED-14 unset is no head; https is the blob store with its client ID; file is a directory", () => {
    expect(ledgerHeadStoreFromEnv({}, ledgerPath)).toBeUndefined();
    const blob = ledgerHeadStoreFromEnv({ LEDGER_HEAD_URL: "https://stl2headeastus2dev.blob.core.windows.net/ledger-head", LEDGER_HEAD_CLIENT_ID: CLIENT_ID, ...identity }, ledgerPath);
    expect(blob).toBeInstanceOf(BlobHeadStore);
    expect(blob?.where).toBe("https://stl2headeastus2dev.blob.core.windows.net/ledger-head/ledger-base-sepolia.head.json");
    const local = ledgerHeadStoreFromEnv({ LEDGER_HEAD_URL: pathToFileURL(join(dir, "heads")).href }, ledgerPath);
    expect(local).toBeInstanceOf(FileHeadStore);
    expect(local?.where).toBe(join(dir, "heads", "ledger-base-sepolia.head.json"));
  });

  it("T-LED-14 anything else stops L2 before the lock, naming the variable", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ LEDGER_HEAD_URL: "http://stl2head.blob.core.windows.net/ledger-head", LEDGER_HEAD_CLIENT_ID: CLIENT_ID, ...identity }, /^LEDGER_HEAD_URL must be/],
      [{ LEDGER_HEAD_URL: "https://stl2head.blob.core.windows.net/ledger-head?sv=2024&sig=x", LEDGER_HEAD_CLIENT_ID: CLIENT_ID, ...identity }, /^LEDGER_HEAD_URL must be/],
      [{ LEDGER_HEAD_URL: "https://stl2head.blob.core.windows.net/ledger-head/blob", LEDGER_HEAD_CLIENT_ID: CLIENT_ID, ...identity }, /^LEDGER_HEAD_URL must be/],
      [{ LEDGER_HEAD_URL: "https://example.com/ledger-head", LEDGER_HEAD_CLIENT_ID: CLIENT_ID, ...identity }, /^LEDGER_HEAD_URL must be/],
      [{ LEDGER_HEAD_URL: "https://stl2head.blob.core.windows.net/ledger-head", ...identity }, /^LEDGER_HEAD_CLIENT_ID must be/],
      [{ LEDGER_HEAD_URL: "https://stl2head.blob.core.windows.net/ledger-head", LEDGER_HEAD_CLIENT_ID: CLIENT_ID }, /needs a managed identity in the container/],
      [{ LEDGER_HEAD_CLIENT_ID: CLIENT_ID }, /^LEDGER_HEAD_CLIENT_ID is set but LEDGER_HEAD_URL is not$/],
    ];
    for (const [env, want] of cases) expect(() => ledgerHeadStoreFromEnv(env, ledgerPath), JSON.stringify(env)).toThrow(want);
  });
});

// ---- A minimal L2 for T-LED-12 --------------------------------------------------------------------------------
const CAIP2 = "eip155:31337";
const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const PAY_TO = "0xcccccccccccccccccccccccccccccccccccccccc";
const PAYER = "0x00000000000000000000000000000000000000f1";
const fakeSigner: PaymentSignerLike = {
  address: PAYER,
  sign: async () => ({ headers: { "PAYMENT-SIGNATURE": "opaque" }, payer: PAYER, validBefore: Math.floor(T0 / 1000) + 120 }),
};

async function startL2(ledger: AuditLedger, anchor: { flush: () => Promise<void> }): Promise<string> {
  const mandate = buildMandate(
    {
      mandateId: "mandate-ledger-head",
      expiresAt: "2027-12-31T23:59:59Z",
      allowedSchemes: ["exact"],
      allowedPayees: [PAY_TO],
      allowedHosts: ["127.0.0.1:4021"],
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      dailyBudgetAtomic: "500000",
      maxAuthorizationsPerMinute: 10,
      maxTimeoutSeconds: 300,
    },
    { caip2: CAIP2, asset: ASSET },
  );
  const { app } = createControlService({
    mandate,
    signer: fakeSigner,
    ledger,
    asset: { address: ASSET, decimals: 6 },
    tokens: { control: "t-control", settlement: "t-settlement", operator: "t-operator" },
    now: () => T0,
    ledgerHead: anchor,
  });
  const server = (app as express.Express).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function authorize(base: string, n: string): Promise<{ status: number; body: unknown }> {
  const url = "http://127.0.0.1:4021/premium";
  const accepts = [{ scheme: "exact", network: CAIP2, asset: ASSET, amount: "1000", payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }] as PaymentRequirements[];
  const intent: PaymentIntent = {
    intentId: `int_${n}`,
    sessionId: `sess_${n}`,
    resourceUrl: url,
    paymentRequired: { x402Version: 2, resource: { url, description: "", mimeType: "application/json" }, accepts } as PaymentRequired,
    purpose: "ledger head",
    createdAt: new Date(T0).toISOString(),
  };
  const res = await fetch(`${base}/v1/authorize`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t-control" }, body: JSON.stringify(intent) });
  return { status: res.status, body: await res.json() };
}
