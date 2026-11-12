// 013 in-process portal for tests (specs/013 research R15): the real createPortalApp against an in-process L2 with
// user accounts on (test/helpers/users.ts), a dev issuer in a temp dir, a fake balance reader and, when asked, the
// stand-in card vault. Nothing here reads the environment; every switch is a dep.
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { createLocalJWKSet } from "jose";
import { DEV_ADMIN_PERMISSION, DEV_AUDIENCE, DEV_PORTAL_CLIENT, devUserId, loadOrCreateDevIssuer, signDevToken, type DevTokenOptions } from "../../scripts/dev-issuer-lib.js";
import { AdminClient } from "../../src/portal/admin-client.js";
import { createBalanceCache, type BalanceReader } from "../../src/portal/balance.js";
import { CardVault } from "../../src/portal/card-vault.js";
import { loadPortalConfig, type PortalConfig } from "../../src/portal/config.js";
import { ControlClient } from "../../src/portal/control-client.js";
import { ProfileStore } from "../../src/portal/profile-store.js";
import { createPortalApp, type PortalDeps } from "../../src/portal/server.js";
import { DEV_ISSUER } from "../../src/shared/identity-token.js";
import type { CardVaultStub } from "./card-vault-stub.js";
import { startUsersL2, TOKENS, type UsersL2, type UsersL2Options } from "./users.js";

export const TEST_VAULT_KEY = "rk_test_PORTALTESTKEY0123456789";
export const TEST_PUBLISHABLE_KEY = "pk_test_PORTALPUBLISHABLE0123";

export interface StartPortalOptions {
  /** An L2 to use (the caller closes it), or options for a new one. */
  l2?: UsersL2 | UsersL2Options;
  /** The stand-in card vault. Absent: cards are off. */
  vault?: CardVaultStub;
  /** Balances by address (lower-case), or a reader. Default: every balance is 0. */
  balance?: BalanceReader;
  /** L2 can't be reached (the portal's client points at a closed port). */
  controlDown?: boolean;
  bypassAuth?: boolean;
  /** 014: the administration area on, in the portal and in the L2 this helper starts. */
  admin?: boolean;
  /** 014 test hook (T-PRT-10 must-fail): the administration routes let every signed-in person through. */
  skipAdminCheck?: boolean;
  /** The per-address limit's test hooks (PortalDeps). */
  maxRequestsPerAddress?: number;
  skipAddressLimit?: boolean;
  env?: Record<string, string>;
  webRoot?: string;
  /** Call markReady() after building the app (default true). */
  ready?: boolean;
}

export interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

export interface PortalTestApp {
  base: string;
  app: Express;
  config: PortalConfig;
  l2: UsersL2;
  profilesDir: string;
  profiles: ProfileStore;
  /** Every log line the portal wrote, parsed. */
  logs: Record<string, unknown>[];
  rawLogs: string[];
  /** 014 (T-PRT-13): the text of every response `call` received, and every token this helper signed. */
  responses: string[];
  issued: string[];
  /** A portal token for `subject` (fresh sign-in on L2's clock unless `authTime` is given). */
  token(subject: string, o?: Omit<DevTokenOptions, "subject">): Promise<string>;
  /** 014: a portal token for an administrator: it carries `portal:admin`, the only permission the portal reads. */
  adminToken(subject: string, o?: Omit<DevTokenOptions, "subject">): Promise<string>;
  /** 014: calls as the administrator `subject`, with a fresh token each time. */
  adminAs(subject: string, o?: Omit<DevTokenOptions, "subject">): <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<Reply<T>>;
  /** 014: how many requests the L2 behind this portal has received. */
  l2Calls(): number;
  /** An agent-service token for `subject` (what `npm run dev-token` prints by default). */
  agentToken(subject: string, o?: Omit<DevTokenOptions, "subject">): Promise<string>;
  userId(subject: string): string;
  call<T = Record<string, unknown>>(method: string, path: string, o?: { token?: string; body?: unknown; raw?: string }): Promise<Reply<T>>;
  /** Calls as `subject`, with a fresh portal token each time. */
  as(subject: string, o?: Omit<DevTokenOptions, "subject">): <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<Reply<T>>;
  close(): Promise<void>;
}

const isL2 = (v: unknown): v is UsersL2 => typeof v === "object" && v !== null && "ledger" in v;

export async function startPortal(o: StartPortalOptions = {}): Promise<PortalTestApp> {
  const dir = mkdtempSync(join(tmpdir(), "x402-portal-"));
  const ownL2 = !isL2(o.l2);
  const l2 = isL2(o.l2) ? o.l2 : await startUsersL2({ ...o.l2, ...(o.admin && o.l2?.admin === undefined && { admin: true as const }) });
  const issuer = await loadOrCreateDevIssuer(join(dir, "issuer"), { NETWORK: "local" });
  const profilesDir = join(dir, "profiles");
  const config = loadPortalConfig({
    NETWORK: "local",
    CONTROL_URL: o.controlDown ? "http://127.0.0.1:9" : l2.url,
    PORTAL_TOKEN: TOKENS.portal,
    AUTH_ISSUER: DEV_ISSUER,
    AUTH_AUDIENCE: DEV_AUDIENCE,
    PORTAL_CLIENT_ID: DEV_PORTAL_CLIENT,
    AUTH_JWKS_FILE: issuer.jwksPath,
    PROFILE_DIR: profilesDir,
    PORTAL_WEB_ROOT: o.webRoot ?? join(dir, "no-web-root"),
    ...(o.vault && { CARD_VAULT: "stripe", CARD_VAULT_KEY: TEST_VAULT_KEY, CARD_VAULT_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY }),
    ...(o.admin && { PORTAL_ADMIN: "1", PORTAL_ADMIN_TOKEN: TOKENS.portalAdmin }),
    ...o.env,
  });
  const rawLogs: string[] = [];
  const profiles = new ProfileStore(profilesDir);
  const reader: BalanceReader = o.balance ?? { balanceOf: async () => 0n };
  const deps: PortalDeps = {
    config,
    keys: { keys: createLocalJWKSet(issuer.jwks), algorithms: ["ES256"] },
    control: new ControlClient(config.controlUrl, config.portalToken),
    profiles,
    balance: createBalanceCache(reader, { now: l2.clock.now }),
    ...(o.vault && config.cardVault && { vault: new CardVault(config.cardVault, { baseUrl: o.vault.baseUrl, timeoutMs: 400 }) }),
    now: l2.clock.now,
    log: (line) => rawLogs.push(line),
    ...(o.bypassAuth && { bypassAuth: true }),
    ...(config.admin && { admin: new AdminClient(config.controlUrl, config.admin.token) }),
    ...(o.skipAdminCheck && { skipAdminCheck: true }),
    ...(o.maxRequestsPerAddress !== undefined && { maxRequestsPerAddress: o.maxRequestsPerAddress }),
    ...(o.skipAddressLimit && { skipAddressLimit: true }),
  };
  const portal = createPortalApp(deps);
  if (o.ready !== false) portal.markReady();
  const server = await new Promise<Server>((r) => {
    const s = portal.app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const responses: string[] = [];
  const issued: string[] = [];
  const sign = async (options: DevTokenOptions): Promise<string> => {
    const signed = await signDevToken(issuer, options);
    issued.push(signed);
    return signed;
  };
  const token: PortalTestApp["token"] = (subject, to = {}) => sign({ subject, azp: DEV_PORTAL_CLIENT, authTime: Math.floor(l2.clock.now() / 1000), ...to });
  const call: PortalTestApp["call"] = async (method, path, co = {}) => {
    const body = co.raw ?? (co.body === undefined ? undefined : JSON.stringify(co.body));
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(co.token !== undefined && { authorization: `Bearer ${co.token}` }), ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body }),
    });
    const text = await res.text();
    responses.push(text);
    let parsed: unknown = {};
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed as never, headers: res.headers, text };
  };

  const adminToken: PortalTestApp["adminToken"] = (subject, to = {}) => token(subject, { permissions: [DEV_ADMIN_PERMISSION], ...to });

  return {
    base,
    app: portal.app,
    config,
    l2,
    profilesDir,
    profiles,
    rawLogs,
    responses,
    issued,
    get logs() {
      return rawLogs.map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    token,
    adminToken,
    adminAs:
      (subject, to = {}) =>
      async (method, path, body) =>
        call(method, path, { token: await adminToken(subject, to), ...(body !== undefined && { body }) }),
    l2Calls: () => l2.requestCount(),
    agentToken: (subject, to = {}) => sign({ subject, ...to }),
    userId: devUserId,
    call,
    as:
      (subject, to = {}) =>
      async (method, path, body) =>
        call(method, path, { token: await token(subject, to), ...(body !== undefined && { body }) }),
    close: async () => {
      await new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      });
      if (ownL2) await l2.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
