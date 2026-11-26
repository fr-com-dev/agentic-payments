// 013 portal configuration (SPEC.md §9 CFG-2 `portal.env`; specs/013 contracts/config-and-secrets.md).
// Errors name the variable and never echo its value. The card vault credential is read in ./card-vault.ts only
// (rule A10); this file just asks it for the result. 020: likewise the Coinbase client secret (./coinbase/client.ts)
// and the grant key (./coinbase/grants.ts), rule A18.
import { trustedProxyHops } from "../shared/address-limit.js";
import { isLoopbackBind } from "../shared/local-only.js";
import { apiDocsEnabled, ConfigError, networkProfile, PORTAL_BIND_HOST_DEFAULT, portalPort, serviceUrls, tokenFor } from "../shared/config.js";
import { DEFAULT_AUTH_TIME_CLAIM, DEV_ISSUER, PERSON_ISSUER_RE } from "../shared/identity-token.js";
import { relative, resolve, isAbsolute } from "node:path";
import { cardVaultFromEnv, type CardVaultConfig } from "./card-vault.js";
import { CoinbaseConfigError, coinbaseCredentialsFromEnv, type CoinbaseCredentials } from "./coinbase/client.js";
import { checkGrantFiles, GrantKeyError, grantKeyFromEnv } from "./coinbase/grants.js";

type Env = Record<string, string | undefined>;

export const DEFAULT_PROFILE_DIR = ".local/portal/profiles";
export const DEFAULT_WEB_ROOT = "dist/portal-web";
/** 020: where the sealed grant files are (one per user). */
export const DEFAULT_CONNECTION_DIR = ".local/portal/connections";
/**
 * 020: the public names read only with CONNECTED_PLATFORMS=coinbase; with it off they are ignored. The two credentials'
 * names are coinbase/client.ts's and coinbase/grants.ts's to say (rule A18).
 */
export const COINBASE_SETTING_NAMES = ["COINBASE_CLIENT_ID", "COINBASE_REDIRECT_URI", "PRIVACY_POLICY_URL", "SUPPORT_URL"] as const;

/** 020: the Coinbase connection's settings, present only with CONNECTED_PLATFORMS=coinbase (FR-001). */
export interface CoinbaseSettings {
  credentials: CoinbaseCredentials;
  grantKey: Buffer;
  redirectUri: string;
  privacyPolicyUrl: string;
  supportUrl: string;
}

export interface PortalConfig {
  network: string;
  rpcUrl: string;
  controlUrl: string;
  portalToken: string;
  auth: {
    /** The Auth0 tenant's issuer, `https://<domain>/` (the dev issuer's name with `AUTH_JWKS_FILE`). */
    issuer: string;
    /** The API's identifier: the same audience as the agent service. */
    audience: string;
    jwksFile?: string;
    /** The portal's single-page client: the only client whose tokens are accepted. Public. */
    clientId: string;
    /** The access-token claim that holds the time of the person's last sign-in. */
    authTimeClaim: string;
    mode: "auth0" | "dev";
  };
  profileDir: string;
  webRoot: string;
  port: number;
  bindHost: string;
  /** Reverse proxies in front of the service (TRUSTED_PROXY_HOPS): 0 locally, 1 behind the Azure ingress. */
  trustedProxyHops?: number;
  apiDocs: boolean;
  /** Absent: cards are off. */
  cardVault?: CardVaultConfig;
  /** 014: the administration area. Absent: off (`PORTAL_ADMIN` is not `1`). The token is the `portal-admin` role's. */
  admin?: { token: string };
  /** 020: where grant files are, read also with the feature off (stored connections then show as unavailable). */
  connectionDir: string;
  /** 020: absent: connected platforms are off. */
  coinbase?: CoinbaseSettings;
}

const inside = (dir: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** 020 (contracts/config-and-secrets.md): the redirect is the portal's own return screen, exactly as registered. */
function validRedirect(v: string, local: boolean): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.pathname !== "/wallet/return" || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "") return false;
  if (u.protocol === "https:") return true;
  return local && u.protocol === "http:" && u.hostname === "localhost";
}

function validHttps(v: string | undefined, o: { mailto?: boolean } = {}): boolean {
  if (v === undefined || v === "") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || (o.mailto === true && u.protocol === "mailto:");
  } catch {
    return false;
  }
}

/** 020: CONNECTED_PLATFORMS and, with `coinbase`, every setting the connection needs (T-PRT-21). */
function coinbaseSettings(env: Env, local: boolean, dirs: { connectionDir: string; profileDir: string; webRoot: string }): CoinbaseSettings | undefined {
  const mode = env.CONNECTED_PLATFORMS ?? "";
  if (mode === "") return undefined;
  if (mode !== "coinbase") throw new ConfigError('CONNECTED_PLATFORMS must be "coinbase" or unset');
  let credentials: CoinbaseCredentials;
  let grantKey: Buffer;
  try {
    credentials = coinbaseCredentialsFromEnv(env);
    grantKey = grantKeyFromEnv(env);
  } catch (err) {
    if (err instanceof CoinbaseConfigError || err instanceof GrantKeyError) throw new ConfigError(err.message);
    throw err;
  }
  const redirectUri = env.COINBASE_REDIRECT_URI ?? "";
  if (!validRedirect(redirectUri, local)) {
    throw new ConfigError("COINBASE_REDIRECT_URI must be https://<portal host>/wallet/return (http://localhost:<port>/wallet/return only with NETWORK=local)");
  }
  if (!validHttps(env.PRIVACY_POLICY_URL)) throw new ConfigError("PRIVACY_POLICY_URL must be an https address with CONNECTED_PLATFORMS=coinbase");
  if (!validHttps(env.SUPPORT_URL, { mailto: true })) throw new ConfigError("SUPPORT_URL must be an https or mailto: address with CONNECTED_PLATFORMS=coinbase");
  if (inside(dirs.connectionDir, dirs.profileDir) || inside(dirs.connectionDir, dirs.webRoot)) {
    throw new ConfigError("CONNECTION_DIR must not be inside PROFILE_DIR or PORTAL_WEB_ROOT");
  }
  try {
    checkGrantFiles(dirs.connectionDir, grantKey);
  } catch (err) {
    if (err instanceof GrantKeyError) throw new ConfigError(err.message);
    throw err;
  }
  return { credentials, grantKey, redirectUri, privacyPolicyUrl: env.PRIVACY_POLICY_URL!, supportUrl: env.SUPPORT_URL! };
}

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

function required(env: Env, name: string): string {
  const v = env[name];
  if (!present(v)) throw new ConfigError(`${name} is required (env/portal.env)`);
  return v;
}

export function loadPortalConfig(env: Env = process.env): PortalConfig {
  const network = env.NETWORK ?? "local";
  const local = network === "local";
  if (!local && network !== "base-sepolia") throw new ConfigError(`unknown network "${network}" (expected "local" or "base-sepolia")`);
  const jwksFile = present(env.AUTH_JWKS_FILE) ? env.AUTH_JWKS_FILE : undefined;
  if (jwksFile !== undefined && !local) throw new ConfigError("AUTH_JWKS_FILE is allowed only with NETWORK=local");
  const dev = jwksFile !== undefined;
  const issuer = required(env, "AUTH_ISSUER");
  if (dev && issuer !== DEV_ISSUER) throw new ConfigError(`AUTH_ISSUER must be ${DEV_ISSUER} with AUTH_JWKS_FILE (the local dev issuer)`);
  if (!dev && !PERSON_ISSUER_RE.test(issuer)) {
    throw new ConfigError("AUTH_ISSUER must be the sign-in tenant's issuer, https://<domain>/ in lower case with the final slash");
  }
  const audience = required(env, "AUTH_AUDIENCE");
  const clientId = required(env, "PORTAL_CLIENT_ID");
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(clientId)) throw new ConfigError("PORTAL_CLIENT_ID must be the portal's client ID");
  const authTimeClaim = present(env.AUTH_TIME_CLAIM) ? env.AUTH_TIME_CLAIM : DEFAULT_AUTH_TIME_CLAIM;
  // The tenant drops a custom claim whose name is not a namespaced web address, so anything else would never arrive.
  if (!/^https:\/\/[^\s]+$/.test(authTimeClaim)) throw new ConfigError("AUTH_TIME_CLAIM must be a namespaced claim name (https://…)");
  let cardVault: CardVaultConfig | undefined;
  try {
    cardVault = cardVaultFromEnv(env);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  // 014: the administration area needs its own role token, never the user-account one.
  let admin: { token: string } | undefined;
  if (env.PORTAL_ADMIN === "1") {
    try {
      admin = { token: tokenFor("portal-admin", env) };
    } catch {
      throw new ConfigError("PORTAL_ADMIN_TOKEN is required with PORTAL_ADMIN=1 (env/portal.env)");
    }
  }
  const bindHost = present(env.PORTAL_BIND_HOST) ? env.PORTAL_BIND_HOST : PORTAL_BIND_HOST_DEFAULT;
  const hops = trustedProxyHops(env);
  // 017 (SEC-44): the dev sign-in accepts tokens anyone can make, so it serves this machine only: a loopback bind and
  // no proxy in front. Each request is checked too (localOnly in server.ts).
  if (dev && !isLoopbackBind(bindHost)) throw new ConfigError("PORTAL_BIND_HOST must be a loopback address with AUTH_JWKS_FILE (the local dev issuer)");
  if (dev && hops > 0) throw new ConfigError("TRUSTED_PROXY_HOPS must be 0 with AUTH_JWKS_FILE (the local dev issuer)");
  const profileDir = present(env.PROFILE_DIR) ? env.PROFILE_DIR : DEFAULT_PROFILE_DIR;
  const webRoot = present(env.PORTAL_WEB_ROOT) ? env.PORTAL_WEB_ROOT : DEFAULT_WEB_ROOT;
  const connectionDir = present(env.CONNECTION_DIR) ? env.CONNECTION_DIR : DEFAULT_CONNECTION_DIR;
  const coinbase = coinbaseSettings(env, local, { connectionDir, profileDir, webRoot });
  return {
    network,
    rpcUrl: networkProfile(network, { env }).rpcUrl,
    controlUrl: serviceUrls(env).control,
    portalToken: tokenFor("portal-control", env),
    auth: { issuer, audience, ...(jwksFile !== undefined && { jwksFile }), clientId, authTimeClaim, mode: dev ? "dev" : "auth0" },
    profileDir,
    webRoot,
    port: portalPort(env),
    bindHost,
    trustedProxyHops: hops,
    apiDocs: apiDocsEnabled(env),
    ...(cardVault && { cardVault }),
    ...(admin && { admin }),
    connectionDir,
    ...(coinbase && { coinbase }),
  };
}
