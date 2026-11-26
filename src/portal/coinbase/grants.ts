// 020 the grant store (SPEC.md §8.2 L2-8, §3.3, §4.1 A18; specs/020 data-model.md "Grant store", research R5). The only
// file that names the sealing key (rule A18). One JSON file per user, mode 0600, written whole by a temporary file and a
// rename; each connection's refresh token is sealed with AES-256-GCM under COINBASE_GRANT_KEY, bound by its additional
// data to the user, the connection and the platform, so a grant moved to another user's file or another connection
// doesn't open (T-CONN-06). Nothing else is kept: no balance, no access token, no Coinbase text (FR-026, FR-027).
// Every read-modify-write here is synchronous, so two calls of the same process can never interleave inside one.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectedPlatform } from "../../shared/contracts.js";
import { USER_ID_RE } from "../../shared/user-id.js";

type Env = Record<string, string | undefined>;

export const GRANT_AAD_PREFIX = "x402-grant-v1";
export const CONNECTION_ID_RE = /^conn_[0-9a-f-]{36}$/;

export class GrantKeyError extends Error {
  override name = "GrantKeyError";
}

/** A user's grant file exists but can't be read or parsed: nothing may be concluded from it (never "no connection"). */
export class GrantStoreUnreadable extends Error {
  override name = "GrantStoreUnreadable";
}

/** COINBASE_GRANT_KEY: 32 random bytes, base64. Errors name the variable, never its value. */
export function grantKeyFromEnv(env: Env): Buffer {
  const v = env.COINBASE_GRANT_KEY ?? "";
  if (v === "" || v === "off") throw new GrantKeyError("COINBASE_GRANT_KEY is required with CONNECTED_PLATFORMS=coinbase");
  const key = /^[A-Za-z0-9+/]{43}=$/.test(v) ? Buffer.from(v, "base64") : undefined;
  if (key?.length !== 32) throw new GrantKeyError("COINBASE_GRANT_KEY must be 32 random bytes in base64 (44 characters)");
  return key;
}

/** What is sealed. It never leaves this file unsealed except to the caller that renews or revokes with it. */
export interface GrantSecret {
  refreshToken: string;
  /** As granted, already checked against the allow-list (scopes.ts). */
  scopes: string[];
  refreshedAt: string;
}

export interface SealedGrant {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

export interface StoredConnection {
  connectionId: string;
  platform: ConnectedPlatform;
  /** `reconnect`: Coinbase refused the grant (FR-017); the dead grant is gone. */
  status: "connected" | "reconnect";
  connectedAt: string;
  grant?: SealedGrant;
}

interface GrantFile {
  userId: string;
  connections: StoredConnection[];
}

export interface GrantStoreOptions {
  /** Absent: the store reads and removes metadata only (the feature switched off after users connected, R12). */
  key?: Buffer;
  /** Test-only must-fail switch (T-CONN-06): seals and opens without the additional data. Never set by the entry point. */
  skipGrantBinding?: boolean;
}

const aad = (userId: string, connectionId: string, platform: string) => Buffer.from(`${GRANT_AAD_PREFIX}\n${userId}\n${connectionId}\n${platform}`, "utf8");

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export class GrantStore {
  constructor(
    private readonly dir: string,
    private readonly o: GrantStoreOptions = {},
  ) {}

  /** True when the store can seal and open (the feature is on). */
  get canOpen(): boolean {
    return this.o.key !== undefined;
  }

  private file(userId: string): string {
    if (!USER_ID_RE.test(userId)) throw new Error("invalid userId");
    return join(this.dir, `${userId}.json`);
  }

  /** Every user with a file here. */
  users(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((n) => /^(usr_[0-9a-f]{32})\.json$/.exec(n)?.[1])
      .filter((u): u is string => u !== undefined);
  }

  /**
   * The user's connections, as stored. A missing file is none; a file whose header names another user is none of this
   * user's. A file that exists but can't be read or parsed throws GrantStoreUnreadable: a transient read error must
   * never look like "no connection", or a reconcile would close a connection whose grant still lives (review 2).
   */
  list(userId: string): StoredConnection[] {
    const path = this.file(userId);
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new GrantStoreUnreadable("a grant file can't be read");
    }
    if (!isObject(parsed) || parsed.userId !== userId || !Array.isArray(parsed.connections)) return [];
    return (parsed.connections as unknown[]).filter(isStoredConnection);
  }

  /** One synchronous read-modify-write of the user's file. An empty list removes the file. */
  update(userId: string, fn: (list: StoredConnection[]) => StoredConnection[]): StoredConnection[] {
    const next = fn(this.list(userId));
    const path = this.file(userId);
    if (next.length === 0) {
      if (existsSync(path)) unlinkSync(path);
      return next;
    }
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const body: GrantFile = { userId, connections: next };
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return next;
  }

  /** Seals a grant for this user, connection and platform. */
  seal(userId: string, connectionId: string, platform: ConnectedPlatform, secret: GrantSecret): SealedGrant {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    if (!this.o.skipGrantBinding) cipher.setAAD(aad(userId, connectionId, platform));
    const ct = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
    return { v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  /** Opens a stored connection's grant for this user. Undefined when it is absent or doesn't open (wrong key, moved). */
  open(userId: string, c: StoredConnection): GrantSecret | undefined {
    if (!c.grant || !this.o.key) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.o.key, Buffer.from(c.grant.iv, "base64"));
      if (!this.o.skipGrantBinding) decipher.setAAD(aad(userId, c.connectionId, c.platform));
      decipher.setAuthTag(Buffer.from(c.grant.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(c.grant.ct, "base64")), decipher.final()]).toString("utf8");
      const s = JSON.parse(plain) as unknown;
      if (!isObject(s) || typeof s.refreshToken !== "string" || !Array.isArray(s.scopes) || typeof s.refreshedAt !== "string") return undefined;
      return { refreshToken: s.refreshToken, scopes: s.scopes.filter((x): x is string => typeof x === "string"), refreshedAt: s.refreshedAt };
    } catch {
      return undefined;
    }
  }

  private requireKey(): Buffer {
    if (!this.o.key) throw new Error("the grant store has no key (connected platforms are off)");
    return this.o.key;
  }
}

/**
 * The startup check (contracts/config-and-secrets.md): every connected grant in `dir` opens with `key`, so a rotated or
 * wrong key is noticed at once, not one user at a time. Returns the number of files that failed.
 */
export function grantFilesThatFail(dir: string, key: Buffer): number {
  if (!existsSync(dir)) return 0;
  const store = new GrantStore(dir, { key });
  let failed = 0;
  for (const name of readdirSync(dir)) {
    const m = /^(usr_[0-9a-f]{32})\.json$/.exec(name);
    if (!m) continue;
    const userId = m[1]!;
    let list: StoredConnection[];
    try {
      list = store.list(userId);
    } catch {
      failed++;
      continue;
    }
    for (const c of list) if (c.grant && store.open(userId, c) === undefined) failed++;
  }
  return failed;
}

/** The startup refusal: throws when any grant in `dir` doesn't open with `key`. */
export function checkGrantFiles(dir: string, key: Buffer): void {
  if (grantFilesThatFail(dir, key) > 0) throw new GrantKeyError("connection grants don't open with COINBASE_GRANT_KEY");
}

function isStoredConnection(v: unknown): v is StoredConnection {
  if (!isObject(v)) return false;
  if (typeof v.connectionId !== "string" || !CONNECTION_ID_RE.test(v.connectionId)) return false;
  if (v.platform !== "coinbase" || (v.status !== "connected" && v.status !== "reconnect") || typeof v.connectedAt !== "string") return false;
  if (v.grant !== undefined) {
    const g = v.grant;
    if (!isObject(g) || g.v !== 1 || typeof g.iv !== "string" || typeof g.ct !== "string" || typeof g.tag !== "string") return false;
  }
  return true;
}
