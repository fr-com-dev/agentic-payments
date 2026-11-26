// 020 connected platforms (SPEC.md §8.2 L2-8; specs/020 contracts/portal-api.md, research R2–R5, R9, R12, R15). The one
// place that orders a connection's steps between the browser, Coinbase, the grant store and L2:
// - start / complete: PKCE S256 and a `state` bound to the person's verified token, single use, 10 minutes (FR-009);
//   the scope allow-list, a refused grant revoked at once (FR-008); one connection per platform (FR-010);
// - balances: renewals and reads serialized per user, the new refresh token written before the access token is used
//   (research R5); figures 20 s in memory, a fresh read at most every 10 s, 5 s at most for an answer (FR-014, FR-016);
// - disconnect: the grant out of the file first, then revoked and checked, then L2 (FR-018, research R15);
// - reconcile: L2 records what happened and the file what can still read; every partial failure ends with fewer.
// This file holds no Coinbase credential (rule A18): it asks client.ts and grants.ts. Nothing it handles reaches L2 but
// identifiers (FR-023), and nothing here pays or decides (FR-020).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ConnectedPlatform, UserView } from "../shared/contracts.js";
import { toPlatformBalances, type PlatformBalances } from "./coinbase/balances.js";
import type { CoinbaseClient } from "./coinbase/client.js";
import { GrantStoreUnreadable, type GrantSecret, type GrantStore, type StoredConnection } from "./coinbase/grants.js";
import { checkGrantedScopes, checkRenewedScopes } from "./coinbase/scopes.js";
import { ControlError, ControlUnavailable, type ControlPort } from "./control-client.js";

export const PENDING_MAX_AGE_MS = 600_000;
export const MAX_PENDING_PER_USER = 3;
export const MAX_STARTS_PER_MINUTE = 10;
export const FIGURES_MAX_AGE_MS = 20_000;
export const FRESH_MIN_INTERVAL_MS = 10_000;
export const RATES_MAX_AGE_MS = 60_000;
export const RATE_LIMIT_BACKOFF_MS = 60_000;
export const ANSWER_DEADLINE_MS = 5_000;
const ACCESS_TOKEN_MARGIN_MS = 60_000;
const PLATFORM: ConnectedPlatform = "coinbase";

/** A refusal with the status and body the portal API answers (contracts/portal-api.md). */
export class ConnectionRefusal extends Error {
  override name = "ConnectionRefusal";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export type ConnectionStatus = "not_connected" | "connected" | "reconnect" | "unavailable";

export interface ConnectionRow {
  platform: ConnectedPlatform;
  status: ConnectionStatus;
  connectedAt?: string;
  privacyPolicyUrl: string;
  supportUrl: string;
}

export type BalancesAnswer = PlatformBalances | { status: "reconnect" } | { status: "unreadable" };

/** Test-only must-fail switches (contracts/portal-api.md). Never read from the environment. */
export interface ConnectionSwitches {
  skipStateCheck?: boolean;
  skipPkce?: boolean;
  skipScopeCheck?: boolean;
  skipConnectionOwner?: boolean;
  skipReplaceRevoke?: boolean;
  unserializedRenewals?: boolean;
  trustRevokeAnswer?: boolean;
}

export interface ConnectionsDeps extends ConnectionSwitches {
  /** Absent: the feature is switched off; stored connections show as `unavailable` and can only be forgotten (R12). */
  client?: CoinbaseClient;
  grants: GrantStore;
  control: ControlPort;
  privacyPolicyUrl?: string;
  supportUrl?: string;
  now: () => number;
  /** One fixed label per event, for the portal's log (never a value). */
  onEvent: (userId: string, event: string) => void;
}

interface Pending {
  userId: string;
  /** The sign-in that started it (the token's sign-in time): a sign-out or another sign-in can't complete it. */
  signedInAtMs: number;
  codeVerifier: string;
  createdAtMs: number;
}

interface Figures {
  balances: PlatformBalances;
  atMs: number;
}

const b64url = (b: Buffer) => b.toString("base64url");
/** Memory is keyed by the owner and the connection: a connection copied into another user's file finds nothing (T-CONN-06). */
const keyOf = (userId: string, connectionId: string) => `${userId}\n${connectionId}`;

export class Connections {
  private readonly pending = new Map<string, Pending>();
  private readonly starts = new Map<string, number[]>();
  private readonly accessTokens = new Map<string, { token: string; expiresAtMs: number }>();
  private readonly figures = new Map<string, Figures>();
  private readonly lastReadStart = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private rates: { rates: Map<string, string>; atMs: number } | undefined;
  /** Two chains per user: writes (complete, disconnect, reconcile) and renewals (every use of a refresh token). */
  private readonly writeChains = new Map<string, Promise<unknown>>();
  private readonly renewChains = new Map<string, Promise<unknown>>();

  constructor(private readonly d: ConnectionsDeps) {}

  /** True when the feature is on: start, complete and balances exist. */
  get on(): boolean {
    return this.d.client !== undefined;
  }

  private chained<T>(chains: Map<string, Promise<unknown>>, userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    chains.set(userId, tail);
    void tail.then(() => {
      if (chains.get(userId) === tail) chains.delete(userId);
    });
    return run;
  }
  private writes<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.chained(this.writeChains, userId, fn);
  }
  private renewals<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.d.unserializedRenewals ? fn() : this.chained(this.renewChains, userId, fn);
  }

  private event(userId: string, label: string): void {
    this.d.onEvent(userId, label);
  }

  /** The user's stored list. An unreadable file is a 503 for the request, never "nothing stored". */
  private listed(userId: string): StoredConnection[] {
    try {
      return this.d.grants.list(userId);
    } catch (err) {
      if (!(err instanceof GrantStoreUnreadable)) throw err;
      this.event(userId, "coinbase_store_unreadable");
      throw new ConnectionRefusal(503, "unavailable");
    }
  }

  private stored(userId: string): StoredConnection | undefined {
    return this.listed(userId).find((c) => c.platform === PLATFORM);
  }

  private accountCheck(user: UserView): void {
    if (!user.registered) throw new ConnectionRefusal(409, "profile_required");
    if (!user.enabled) throw new ConnectionRefusal(409, "account_disabled");
  }

  // ---- the wallet's rows and the reconcile ----------------------------------------------------------------

  /**
   * The rows `GET /api/wallet` shows, after reconciling the file with L2's view (contracts/portal-api.md
   * "Reconcile"). The L2 side runs within the request; a revocation it needs runs after, in the background.
   */
  async walletRows(userId: string, user: UserView): Promise<ConnectionRow[]> {
    let c: StoredConnection | undefined;
    try {
      // Nothing stored and nothing at L2: no reconcile, so no second call to L2 (review 5).
      if (this.d.grants.list(userId).length > 0 || user.connections.length > 0) await this.reconcile(userId);
      c = this.d.grants.list(userId).find((x) => x.platform === PLATFORM);
    } catch (err) {
      // An unreadable file: nothing is reconciled and nothing concluded; the wallet still shows (FR-016).
      if (!(err instanceof GrantStoreUnreadable)) throw err;
      this.event(userId, "coinbase_store_unreadable");
      return [this.row(undefined, "unavailable")];
    }
    if (!this.on) return c ? [this.row(c, "unavailable")] : [];
    return [this.row(c, c ? c.status : "not_connected")];
  }

  private row(c: StoredConnection | undefined, status: ConnectionStatus): ConnectionRow {
    return {
      platform: PLATFORM,
      status,
      ...(c !== undefined && status !== "not_connected" && { connectedAt: c.connectedAt }),
      privacyPolicyUrl: this.d.privacyPolicyUrl ?? "",
      supportUrl: this.d.supportUrl ?? "",
    };
  }

  /** L2's view is read inside the user's write chain, so a connection completing meanwhile is never undone. */
  reconcile(userId: string): Promise<void> {
    return this.writes(userId, async () => {
      const user = await this.d.control.user(userId);
      const active = new Set(user.connections.map((c) => c.connectionId));
      const removed: Array<{ c: StoredConnection; secret?: GrantSecret }> = [];
      this.d.grants.update(userId, (list) =>
        list.filter((c) => {
          if (active.has(c.connectionId)) return true;
          const secret = this.d.grants.open(userId, c);
          removed.push(secret ? { c, secret } : { c });
          return false;
        }),
      );
      const inFile = new Set(this.d.grants.list(userId).map((c) => c.connectionId));
      for (const c of user.connections) {
        if (inFile.has(c.connectionId)) continue;
        await this.d.control.closeConnection(userId, c.connectionId);
        this.event(userId, "coinbase_reconciled");
      }
      for (const r of removed) {
        this.event(userId, "coinbase_reconciled");
        this.forgetMemory(userId, r.c.connectionId);
        // After the answer: the wallet never waits for Coinbase (I2).
        if (r.secret) setImmediate(() => void this.revokeGrant(userId, r.c, r.secret!).catch(() => undefined));
      }
    });
  }

  // ---- start and complete (US1) ---------------------------------------------------------------------------

  start(userId: string, signedInAtMs: number, user: UserView): { authorizeUrl: string } {
    const client = this.requireOn();
    if (!this.d.privacyPolicyUrl || !this.d.supportUrl) throw new ConnectionRefusal(503, "not_ready");
    this.accountCheck(user);
    const t = this.d.now();
    // Forget every user whose last start is over a minute old, so the map never grows without bound (review 6).
    for (const [u, list] of this.starts) if (list.every((s) => t - s >= 60_000)) this.starts.delete(u);
    const recent = (this.starts.get(userId) ?? []).filter((s) => t - s < 60_000);
    if (recent.length >= MAX_STARTS_PER_MINUTE) {
      this.starts.set(userId, recent);
      throw new ConnectionRefusal(429, "too many requests", { retryAfterSec: Math.max(1, Math.ceil((recent[0]! + 60_000 - t) / 1000)) });
    }
    recent.push(t);
    this.starts.set(userId, recent);
    // At most three pending per person: a fourth drops the oldest.
    const mine = [...this.pending.entries()].filter(([, p]) => p.userId === userId).sort((a, b) => a[1].createdAtMs - b[1].createdAtMs);
    while (mine.length >= MAX_PENDING_PER_USER) this.pending.delete(mine.shift()![0]);
    for (const [s, p] of this.pending) if (t - p.createdAtMs > PENDING_MAX_AGE_MS) this.pending.delete(s);
    const state = b64url(randomBytes(32));
    const codeVerifier = b64url(randomBytes(32));
    this.pending.set(state, { userId, signedInAtMs, codeVerifier, createdAtMs: t });
    const codeChallenge = this.d.skipPkce ? undefined : b64url(createHash("sha256").update(codeVerifier).digest());
    return { authorizeUrl: client.authorizeUrl({ state, ...(codeChallenge !== undefined && { codeChallenge }) }) };
  }

  complete(userId: string, signedInAtMs: number, user: UserView, code: string, state: string): Promise<{ platform: ConnectedPlatform; status: "connected"; connectedAt: string }> {
    const client = this.requireOn();
    return this.writes(userId, async () => {
      const t = this.d.now();
      const p = this.pending.get(state);
      // Single use: the start is gone now, whatever follows (FR-009).
      if (!this.d.skipStateCheck) this.pending.delete(state);
      const valid =
        p !== undefined && (this.d.skipStateCheck || (p.userId === userId && p.signedInAtMs === signedInAtMs && t - p.createdAtMs <= PENDING_MAX_AGE_MS));
      if (!valid) {
        this.event(userId, "coinbase_state_refused");
        throw new ConnectionRefusal(400, "invalid_state");
      }
      this.accountCheck(user);
      const exchanged = await client.exchange(code, this.d.skipPkce ? undefined : p.codeVerifier);
      if (!exchanged.ok) {
        if (exchanged.kind === "refused") {
          this.event(userId, "coinbase_state_refused");
          throw new ConnectionRefusal(400, "invalid_state");
        }
        // The portal's own client was refused (a wrong secret): the person did nothing wrong.
        this.event(userId, exchanged.kind === "client_refused" ? "coinbase_client_refused" : "coinbase_unavailable");
        throw new ConnectionRefusal(502, "platform_unavailable");
      }
      const scopes = this.d.skipScopeCheck
        ? { ok: true as const, scopes: [] as string[] }
        : checkGrantedScopes(exchanged.scope, exchanged.refreshToken !== undefined);
      if (!scopes.ok || exchanged.refreshToken === undefined) {
        await this.revokeAccess(userId, exchanged.accessToken);
        this.event(userId, "coinbase_scope_refused");
        throw new ConnectionRefusal(400, "scope_refused", { reason: scopes.ok ? "too_narrow" : scopes.reason });
      }
      const connectionId = `conn_${randomUUID()}`;
      const connectedAt = new Date(t).toISOString();
      const secret: GrantSecret = { refreshToken: exchanged.refreshToken, scopes: scopes.scopes, refreshedAt: connectedAt };
      try {
        const grant = this.d.grants.seal(userId, connectionId, PLATFORM, secret);
        this.d.grants.update(userId, (list) => [...list, { connectionId, platform: PLATFORM, status: "connected", connectedAt, grant }]);
      } catch {
        await this.revokeAccess(userId, exchanged.accessToken);
        this.event(userId, "coinbase_grant_write_failed");
        throw new ConnectionRefusal(503, "unavailable");
      }
      let replaced: string | undefined;
      try {
        replaced = (await this.d.control.openConnection(userId, connectionId, PLATFORM)).replaced;
      } catch (err) {
        // L2 didn't record it: the grant must not stay (fewer, never more).
        this.d.grants.update(userId, (list) => list.filter((c) => c.connectionId !== connectionId));
        await this.revokeAccess(userId, exchanged.accessToken);
        throw err;
      }
      this.accessTokens.set(keyOf(userId, connectionId), { token: exchanged.accessToken, expiresAtMs: t + exchanged.expiresInSec * 1000 });
      // Every other connection of this platform in the file is the one L2 replaced (or a leftover): out, and revoked.
      const olds: Array<{ c: StoredConnection; secret?: GrantSecret }> = [];
      this.d.grants.update(userId, (list) =>
        list.filter((c) => {
          if (c.connectionId === connectionId || c.platform !== PLATFORM) return true;
          const s = this.d.grants.open(userId, c);
          olds.push(s ? { c, secret: s } : { c });
          return false;
        }),
      );
      for (const o of olds) {
        this.forgetMemory(userId, o.c.connectionId);
        if (o.secret && !this.d.skipReplaceRevoke) {
          const ok = await this.revokeGrant(userId, o.c, o.secret).catch(() => false);
          if (!ok) this.event(userId, "coinbase_revoke_failed");
        }
      }
      if (replaced !== undefined || olds.length > 0) this.event(userId, "coinbase_replaced");
      this.event(userId, "coinbase_connected");
      return { platform: PLATFORM, status: "connected" as const, connectedAt };
    });
  }

  // ---- balances (US2) -------------------------------------------------------------------------------------

  async balances(userId: string, user: UserView, fresh: boolean): Promise<BalancesAnswer> {
    this.requireOn();
    this.accountCheck(user);
    const found = this.ownConnection(userId);
    if (!found) throw new ConnectionRefusal(404, "not_connected");
    const { owner, c } = found;
    if (c.status === "reconnect") return { status: "reconnect" };
    const t = this.d.now();
    const k = keyOf(owner, c.connectionId);
    const cached = this.figures.get(k);
    const lastStart = this.lastReadStart.get(k);
    if (cached && !fresh && t - cached.atMs < FIGURES_MAX_AGE_MS) return cached.balances;
    if (cached && fresh && lastStart !== undefined && t - lastStart < FRESH_MIN_INTERVAL_MS) return cached.balances;
    if ((this.backoffUntil.get(k) ?? 0) > t) return cached ? { ...cached.balances, stale: true } : { status: "unreadable" };
    this.lastReadStart.set(k, t);
    const read = this.readFigures(owner, c);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => {
      timer = setTimeout(() => r("late"), ANSWER_DEADLINE_MS);
    });
    const out = await Promise.race([read, late]);
    if (timer) clearTimeout(timer);
    if (out === "late") {
      this.event(userId, "coinbase_unavailable");
      const last = this.figures.get(k);
      return last ? { ...last.balances, stale: true } : { status: "unreadable" };
    }
    return out;
  }

  /**
   * The connection the token's user owns, and that owner. `skipConnectionOwner` (the T-CONN-07 must-fail) takes the
   * first one stored for anybody when the user has none: the damage the check prevents.
   */
  private ownConnection(userId: string): { owner: string; c: StoredConnection } | undefined {
    const own = this.stored(userId);
    if (own || !this.d.skipConnectionOwner) return own ? { owner: userId, c: own } : undefined;
    for (const other of this.d.grants.users()) {
      const c = this.stored(other);
      if (c) return { owner: other, c };
    }
    return undefined;
  }

  private async readFigures(userId: string, c: StoredConnection): Promise<BalancesAnswer> {
    const client = this.requireOn();
    const k = keyOf(userId, c.connectionId);
    const stale = (): BalancesAnswer => {
      const last = this.figures.get(k);
      return last ? { ...last.balances, stale: true } : { status: "unreadable" };
    };
    let token = await this.accessToken(userId, c);
    if (token === "reconnect") return { status: "reconnect" };
    if (token === undefined) {
      this.event(userId, "coinbase_unavailable");
      return stale();
    }
    let listed = await client.listAccounts(token);
    if (!listed.ok && listed.kind === "expired") {
      this.accessTokens.delete(k);
      token = await this.accessToken(userId, c);
      if (token === "reconnect") return { status: "reconnect" };
      if (token === undefined) return stale();
      listed = await client.listAccounts(token);
    }
    if (!listed.ok) {
      if (listed.kind === "revoked" || listed.kind === "expired") {
        this.toReconnect(userId, c.connectionId);
        return { status: "reconnect" };
      }
      if (listed.kind === "rate_limited") {
        this.backoffUntil.set(k, this.d.now() + RATE_LIMIT_BACKOFF_MS);
        this.event(userId, "coinbase_rate_limited");
      } else this.event(userId, "coinbase_unavailable");
      return stale();
    }
    const rates = await this.usdRates();
    const readAt = new Date(this.d.now()).toISOString();
    const built = toPlatformBalances({ accounts: listed.accounts, ...(rates && { rates }), readAt, truncated: listed.truncated });
    if (built.badAmounts > 0) this.event(userId, "coinbase_bad_amount");
    this.figures.set(k, { balances: built.balances, atMs: this.d.now() });
    return built.balances;
  }

  private async usdRates(): Promise<Map<string, string> | undefined> {
    const t = this.d.now();
    if (this.rates && t - this.rates.atMs < RATES_MAX_AGE_MS) return this.rates.rates;
    const got = await this.requireOn().usdRates();
    if (got.ok) {
      this.rates = { rates: got.rates, atMs: t };
      return got.rates;
    }
    return undefined;
  }

  /**
   * A live access token: from memory, or by one renewal inside the user's renewal chain (research R5). `reconnect`:
   * Coinbase refused the grant; undefined: Coinbase couldn't be reached (the grant is kept).
   */
  private accessToken(userId: string, c: StoredConnection): Promise<string | "reconnect" | undefined> {
    return this.renewals(userId, async () => {
      const t = this.d.now();
      const mem = this.accessTokens.get(keyOf(userId, c.connectionId));
      if (mem && mem.expiresAtMs - ACCESS_TOKEN_MARGIN_MS > t) return mem.token;
      const current = this.listed(userId).find((x) => x.connectionId === c.connectionId);
      const secret = current ? this.d.grants.open(userId, current) : undefined;
      if (!current || current.status !== "connected" || !secret) {
        if (current) this.toReconnect(userId, c.connectionId);
        return "reconnect";
      }
      return this.renewWith(userId, c.connectionId, secret);
    });
  }

  /** One renewal with `secret`; the new refresh token is sealed and written before the access token is returned. */
  private async renewWith(userId: string, connectionId: string, secret: GrantSecret, o: { keepInFile?: boolean } = { keepInFile: true }): Promise<string | "reconnect" | undefined> {
    const client = this.requireOn();
    const renewed = await client.renew(secret.refreshToken);
    if (!renewed.ok) {
      // Only Coinbase saying the grant itself is gone ends the connection; a refused client keeps every grant.
      if (renewed.kind === "refused") {
        if (o.keepInFile) this.toReconnect(userId, connectionId);
        return "reconnect";
      }
      if (renewed.kind === "client_refused") this.event(userId, "coinbase_client_refused");
      return undefined;
    }
    const scopes = checkRenewedScopes(renewed.scope);
    if (!scopes.ok) {
      await this.revokeAccess(userId, renewed.accessToken);
      if (o.keepInFile) this.toReconnect(userId, connectionId);
      return "reconnect";
    }
    if (scopes.unverified) this.event(userId, "coinbase_scope_unverified");
    const t = this.d.now();
    if (o.keepInFile) {
      const next: GrantSecret = { refreshToken: renewed.refreshToken ?? secret.refreshToken, scopes: secret.scopes, refreshedAt: new Date(t).toISOString() };
      try {
        const grant = this.d.grants.seal(userId, connectionId, PLATFORM, next);
        let found = false;
        this.d.grants.update(userId, (list) =>
          list.map((x) => {
            if (x.connectionId !== connectionId) return x;
            found = true;
            return { ...x, grant };
          }),
        );
        if (!found) throw new Error("gone");
      } catch {
        // Never a live grant that the file doesn't hold.
        await this.revokeAccess(userId, renewed.accessToken);
        this.event(userId, "coinbase_grant_write_failed");
        this.toReconnect(userId, connectionId);
        return "reconnect";
      }
      this.accessTokens.set(keyOf(userId, connectionId), { token: renewed.accessToken, expiresAtMs: t + renewed.expiresInSec * 1000 });
    }
    return renewed.accessToken;
  }

  private toReconnect(userId: string, connectionId: string): void {
    this.forgetMemory(userId, connectionId);
    let changed = false;
    try {
      this.d.grants.update(userId, (list) =>
        list.map((x) => {
          if (x.connectionId !== connectionId || x.status === "reconnect") return x;
          changed = true;
          const { grant: _gone, ...rest } = x;
          return { ...rest, status: "reconnect" as const };
        }),
      );
    } catch {
      // The store can't be written: the grant it still holds is a rotated, dead one, refused at the next renewal.
      changed = true;
    }
    if (changed) this.event(userId, "coinbase_reconnect_needed");
  }

  private forgetMemory(userId: string, connectionId: string): void {
    const k = keyOf(userId, connectionId);
    this.accessTokens.delete(k);
    this.figures.delete(k);
    this.lastReadStart.delete(k);
    this.backoffUntil.delete(k);
  }

  // ---- revocation (research R15) --------------------------------------------------------------------------

  /** Revokes an access token and checks it: true only on a 401 afterwards (or with the `trustRevokeAnswer` proof). */
  private async revokeAccess(_userId: string, accessToken: string): Promise<boolean> {
    const client = this.d.client;
    if (!client) return false;
    await client.revoke(accessToken);
    if (this.d.trustRevokeAnswer) return true;
    return client.revokedCheck(accessToken);
  }

  /** Revokes a stored grant: a live access token from memory or one renewal (inside the renewal chain), then revoke. */
  private revokeGrant(userId: string, c: StoredConnection, secret: GrantSecret): Promise<boolean> {
    return this.renewals(userId, async () => {
      if (!this.d.client) return false;
      const k = keyOf(userId, c.connectionId);
      const mem = this.accessTokens.get(k);
      const token = mem && mem.expiresAtMs - ACCESS_TOKEN_MARGIN_MS > this.d.now() ? mem.token : await this.renewWith(userId, c.connectionId, secret, { keepInFile: false });
      this.accessTokens.delete(k);
      // A grant Coinbase already refuses is as good as revoked.
      if (token === "reconnect") return true;
      if (token === undefined) return false;
      return this.revokeAccess(userId, token);
    });
  }

  // ---- disconnect (US4) -----------------------------------------------------------------------------------

  disconnect(userId: string): Promise<{ revokedAtPlatform: boolean }> {
    return this.writes(userId, async () => {
      const found = this.ownConnection(userId);
      // Off and nothing stored: as if the route didn't exist (FR-001).
      if (!found) throw this.on ? new ConnectionRefusal(404, "not_connected") : new ConnectionRefusal(404, "not found");
      const { owner, c } = found;
      const secret = this.d.grants.open(owner, c);
      // First out of the file: from now on nothing can read with it (FR-018).
      this.d.grants.update(owner, (list) => list.filter((x) => x.connectionId !== c.connectionId));
      // A connection Coinbase already refused (`reconnect`) has no live grant left to revoke (review 4).
      let revoked = c.status === "reconnect";
      if (secret && this.d.client) {
        revoked = await withDeadline(this.revokeGrant(owner, c, secret), ANSWER_DEADLINE_MS, false);
      }
      this.forgetMemory(owner, c.connectionId);
      if (!revoked) this.event(userId, "coinbase_revoke_failed");
      try {
        await this.d.control.closeConnection(owner, c.connectionId);
      } catch (err) {
        // The next wallet read reconciles.
        if (!(err instanceof ControlUnavailable) && !(err instanceof ControlError)) throw err;
      }
      this.event(userId, "coinbase_disconnected");
      return { revokedAtPlatform: revoked };
    });
  }

  /** FR-019: every connection of a user who just disabled their account. Never fails the disabling. */
  async disconnectAll(userId: string): Promise<void> {
    for (;;) {
      try {
        if (!this.stored(userId)) return;
        await this.disconnect(userId);
      } catch {
        return;
      }
    }
  }

  private requireOn(): CoinbaseClient {
    if (!this.d.client) throw new ConnectionRefusal(404, "not found");
    return this.d.client;
  }
}

async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((r) => {
    timer = setTimeout(() => r(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
