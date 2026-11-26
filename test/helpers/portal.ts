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
import { DEV_ADMIN_PERMISSION, DEV_AUDIENCE, DEV_PORTAL_CLIENT, devSubject, devUserId, loadOrCreateDevIssuer, signDevToken, type DevTokenOptions } from "../../scripts/dev-issuer-lib.js";
import { AdminClient } from "../../src/portal/admin-client.js";
import { createBalanceCache, type BalanceReader } from "../../src/portal/balance.js";
import { CardVault } from "../../src/portal/card-vault.js";
import { loadPortalConfig, type PortalConfig } from "../../src/portal/config.js";
import { randomBytes } from "node:crypto";
import { CoinbaseClient } from "../../src/portal/coinbase/client.js";
import { GrantStore } from "../../src/portal/coinbase/grants.js";
import { Connections, type ConnectionSwitches } from "../../src/portal/connections.js";
import { ControlClient } from "../../src/portal/control-client.js";
import { connectionEventLog, createPortalLog } from "../../src/portal/log.js";
import { ProfileStore } from "../../src/portal/profile-store.js";
import { createPortalApp, type PortalDeps } from "../../src/portal/server.js";
import { DEV_ISSUER } from "../../src/shared/identity-token.js";
import type { TestIssuer } from "./caller-tokens.js";
import type { CardVaultStub } from "./card-vault-stub.js";
import { STUB_CLIENT_ID, STUB_CLIENT_SECRET, type CoinbaseStub } from "./coinbase-stub.js";
import { startUsersL2, TOKENS, type UsersL2, type UsersL2Options } from "./users.js";

export const TEST_VAULT_KEY = "rk_test_PORTALTESTKEY0123456789";
export const TEST_PUBLISHABLE_KEY = "pk_test_PORTALPUBLISHABLE0123";
export const TEST_REDIRECT = "http://localhost:4025/wallet/return";
export const TEST_PRIVACY = "https://example.org/privacy";
export const TEST_SUPPORT = "mailto:support@example.org";

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
  /** 017 must-fail switches (PortalDeps): T-EDGE-03, T-EDGE-04 and T-PRT-17. Passed only when true. */
  skipLocalOnly?: boolean;
  skipFailureLimit?: boolean;
  skipNotFoundRules?: boolean;
  env?: Record<string, string>;
  webRoot?: string;
  /** Call markReady() after building the app (default true). */
  ready?: boolean;
  /**
   * 016: sign people in with this issuer (an end-to-end harness's) instead of a dev issuer of the helper's own, so
   * the portal, the agent and L2 all verify one tenant's tokens and a person is the same user at each. With it,
   * `token`, `agentToken` and `userId` take the person's whole `sub` in `o.sub` (default `dev|<subject>`).
   */
  callers?: TestIssuer;
  /**
   * 020: connected platforms on, against this stand-in Coinbase (its address is a dep, never env). `connections` gives
   * the must-fail switches; `connectionsOff` keeps the feature off while still reading `connectionDir` (research R12).
   */
  coinbase?: CoinbaseStub;
  connections?: ConnectionSwitches & { privacyPolicyUrl?: string; supportUrl?: string; skipGrantBinding?: boolean };
  connectionsOff?: boolean;
  /** 020: reuse a grant directory and key (a restart, a feature switched off). */
  connectionDir?: string;
  grantKey?: string;
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
  /** 020: the connections object, when the feature (or its off mode) is wired. */
  connections?: Connections;
  connectionDir: string;
  grantKey: string;
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
  const issuer = await loadOrCreateDevIssuer(join(dir, "issuer"), { NETWORK: "local" });
  // 1.19 (SEC-35): L2 verifies the person's token the portal forwards, so the L2 this helper starts trusts the same
  // issuer, audience, client and keys as the portal does (the same tenant, as in a deployment).
  const person = {
    issuer: o.callers?.issuer ?? o.env?.AUTH_ISSUER ?? DEV_ISSUER,
    audience: o.callers?.audience ?? o.env?.AUTH_AUDIENCE ?? DEV_AUDIENCE,
    portalClientId: o.env?.PORTAL_CLIENT_ID ?? DEV_PORTAL_CLIENT,
    ...(o.callers ? { keys: o.callers.deps.keys, algorithms: o.callers.deps.algorithms } : { keys: createLocalJWKSet(issuer.jwks), algorithms: ["ES256"] }),
  };
  const l2 = isL2(o.l2)
    ? o.l2
    : await startUsersL2({
        ...o.l2,
        ...(o.admin && o.l2?.admin === undefined && { admin: true as const }),
        person: { ...person, ...(o.l2 as UsersL2Options | undefined)?.person },
        signPortalToken: o.callers
          ? (sub, po) => o.callers!.person(sub, po)
          : (sub, po) => signDevToken(issuer, { subject: "", sub, issuer: person.issuer, audience: person.audience, ...po }),
      });
  const profilesDir = join(dir, "profiles");
  const connectionDir = o.connectionDir ?? join(dir, "connections");
  const grantKey = o.grantKey ?? randomBytes(32).toString("base64");
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
    CONNECTION_DIR: connectionDir,
    ...(o.coinbase &&
      !o.connectionsOff && {
        CONNECTED_PLATFORMS: "coinbase",
        COINBASE_CLIENT_ID: STUB_CLIENT_ID,
        COINBASE_CLIENT_SECRET: STUB_CLIENT_SECRET,
        COINBASE_GRANT_KEY: grantKey,
        COINBASE_REDIRECT_URI: TEST_REDIRECT,
        PRIVACY_POLICY_URL: TEST_PRIVACY,
        SUPPORT_URL: TEST_SUPPORT,
      }),
    ...o.env,
  });
  const callers = o.callers;
  if (callers) config.auth = { ...config.auth, issuer: callers.issuer, audience: callers.audience };
  const rawLogs: string[] = [];
  const profiles = new ProfileStore(profilesDir);
  const control = new ControlClient(config.controlUrl, config.portalToken);
  const cb = config.coinbase;
  const { skipGrantBinding, privacyPolicyUrl, supportUrl, ...switches } = o.connections ?? {};
  const connections =
    o.coinbase || o.connectionsOff
      ? new Connections({
          ...(cb && o.coinbase && { client: new CoinbaseClient({ ...cb.credentials, redirectUri: cb.redirectUri, loginBase: o.coinbase.baseUrl, apiBase: o.coinbase.baseUrl }) }),
          grants: new GrantStore(config.connectionDir, { ...(cb && { key: cb.grantKey }), ...(skipGrantBinding && { skipGrantBinding: true }) }),
          control,
          ...(cb && { privacyPolicyUrl: privacyPolicyUrl ?? cb.privacyPolicyUrl, supportUrl: supportUrl ?? cb.supportUrl }),
          now: l2.clock.now,
          onEvent: connectionEventLog(createPortalLog((line) => rawLogs.push(line)), l2.clock.now),
          ...switches,
        })
      : undefined;
  const reader: BalanceReader = o.balance ?? { balanceOf: async () => 0n };
  const deps: PortalDeps = {
    config,
    keys: callers ? { keys: callers.deps.keys, algorithms: callers.deps.algorithms } : { keys: createLocalJWKSet(issuer.jwks), algorithms: ["ES256"] },
    control,
    ...(connections && { connections }),
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
    ...(o.skipLocalOnly && { skipLocalOnly: true }),
    ...(o.skipFailureLimit && { skipFailureLimit: true }),
    ...(o.skipNotFoundRules && { skipNotFoundRules: true }),
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
    let signed: string;
    if (callers) {
      // One tenant for everything: the harness's issuer signs the portal's tokens and the agent's.
      const { subject, sub, service: _service, issuer: _issuer, audience: _audience, ...rest } = options;
      signed = await callers.person(sub ?? devSubject(subject), rest);
    } else {
      signed = await signDevToken(issuer, options);
    }
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

  // 1.19: an administrator's sign-in includes a second factor (the tenant asks for one), at the same time.
  const adminToken: PortalTestApp["adminToken"] = (subject, to = {}) =>
    token(subject, { permissions: [DEV_ADMIN_PERMISSION], mfaTime: Math.floor(l2.clock.now() / 1000), ...to });

  return {
    base,
    app: portal.app,
    config,
    l2,
    ...(connections && { connections }),
    connectionDir,
    grantKey,
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
    userId: (subject: string) => (callers ? callers.register(subject.includes("|") ? subject : devSubject(subject)) : devUserId(subject)),
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
