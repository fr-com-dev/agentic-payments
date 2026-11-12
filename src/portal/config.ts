// 013 portal configuration (SPEC.md §9 CFG-2 `portal.env`; specs/013 contracts/config-and-secrets.md).
// Errors name the variable and never echo its value. The card vault credential is read in ./card-vault.ts only
// (rule A10); this file just asks it for the result.
import { trustedProxyHops } from "../shared/address-limit.js";
import { apiDocsEnabled, ConfigError, networkProfile, PORTAL_BIND_HOST_DEFAULT, portalPort, serviceUrls, tokenFor } from "../shared/config.js";
import { DEV_ISSUER, entraIssuer, GUID_RE } from "../shared/entra-token.js";
import { cardVaultFromEnv, type CardVaultConfig } from "./card-vault.js";

type Env = Record<string, string | undefined>;

export const DEFAULT_PROFILE_DIR = ".local/portal/profiles";
export const DEFAULT_WEB_ROOT = "dist/portal-web";
export const PORTAL_SCOPE_NAME = "Portal.Access";

export interface PortalConfig {
  network: string;
  rpcUrl: string;
  controlUrl: string;
  portalToken: string;
  auth: {
    tenantId: string;
    /** The API app's client ID: the same audience as the agent service. */
    audience: string;
    issuer: string;
    jwksFile?: string;
    /** The portal web app's client ID: the only `azp` accepted. */
    clientId: string;
    /** The scope the web app requests (`<API app>/Portal.Access`). Public. */
    scope: string;
    mode: "entra" | "dev";
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
  const tenantId = required(env, "AUTH_TENANT_ID");
  const audience = required(env, "AUTH_AUDIENCE");
  const clientId = required(env, "PORTAL_CLIENT_ID");
  const jwksFile = present(env.AUTH_JWKS_FILE) ? env.AUTH_JWKS_FILE : undefined;
  if (jwksFile !== undefined && !local) throw new ConfigError("AUTH_JWKS_FILE is allowed only with NETWORK=local");
  if (jwksFile === undefined) {
    // Entra v2.0 access tokens carry the API app's client ID as `aud` and the client's ID as `azp`: both GUIDs.
    if (!GUID_RE.test(audience)) throw new ConfigError("AUTH_AUDIENCE must be the API app's client ID (a GUID)");
    if (!GUID_RE.test(clientId)) throw new ConfigError("PORTAL_CLIENT_ID must be the portal web app's client ID (a GUID)");
  }
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
  return {
    network,
    rpcUrl: networkProfile(network, { env }).rpcUrl,
    controlUrl: serviceUrls(env).control,
    portalToken: tokenFor("portal-control", env),
    auth: {
      tenantId,
      audience,
      issuer: jwksFile !== undefined ? DEV_ISSUER : entraIssuer(tenantId),
      ...(jwksFile !== undefined && { jwksFile }),
      clientId,
      scope: present(env.PORTAL_SCOPE) ? env.PORTAL_SCOPE : `${audience}/${PORTAL_SCOPE_NAME}`,
      mode: jwksFile !== undefined ? "dev" : "entra",
    },
    profileDir: present(env.PROFILE_DIR) ? env.PROFILE_DIR : DEFAULT_PROFILE_DIR,
    webRoot: present(env.PORTAL_WEB_ROOT) ? env.PORTAL_WEB_ROOT : DEFAULT_WEB_ROOT,
    port: portalPort(env),
    bindHost: present(env.PORTAL_BIND_HOST) ? env.PORTAL_BIND_HOST : PORTAL_BIND_HOST_DEFAULT,
    trustedProxyHops: trustedProxyHops(env),
    apiDocs: apiDocsEnabled(env),
    ...(cardVault && { cardVault }),
    ...(admin && { admin }),
  };
}
