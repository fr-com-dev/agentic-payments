// 013 portal configuration (SPEC.md §9 CFG-2 `portal.env`; specs/013 contracts/config-and-secrets.md).
// Errors name the variable and never echo its value. The card vault credential is read in ./card-vault.ts only
// (rule A10); this file just asks it for the result.
import { trustedProxyHops } from "../shared/address-limit.js";
import { apiDocsEnabled, ConfigError, networkProfile, PORTAL_BIND_HOST_DEFAULT, portalPort, serviceUrls, tokenFor } from "../shared/config.js";
import { DEFAULT_AUTH_TIME_CLAIM, DEV_ISSUER, PERSON_ISSUER_RE } from "../shared/identity-token.js";
import { cardVaultFromEnv, type CardVaultConfig } from "./card-vault.js";

type Env = Record<string, string | undefined>;

export const DEFAULT_PROFILE_DIR = ".local/portal/profiles";
export const DEFAULT_WEB_ROOT = "dist/portal-web";

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
  return {
    network,
    rpcUrl: networkProfile(network, { env }).rpcUrl,
    controlUrl: serviceUrls(env).control,
    portalToken: tokenFor("portal-control", env),
    auth: { issuer, audience, ...(jwksFile !== undefined && { jwksFile }), clientId, authTimeClaim, mode: dev ? "dev" : "auth0" },
    profileDir: present(env.PROFILE_DIR) ? env.PROFILE_DIR : DEFAULT_PROFILE_DIR,
    webRoot: present(env.PORTAL_WEB_ROOT) ? env.PORTAL_WEB_ROOT : DEFAULT_WEB_ROOT,
    port: portalPort(env),
    bindHost: present(env.PORTAL_BIND_HOST) ? env.PORTAL_BIND_HOST : PORTAL_BIND_HOST_DEFAULT,
    trustedProxyHops: trustedProxyHops(env),
    apiDocs: apiDocsEnabled(env),
    ...(cardVault && { cardVault }),
  };
}
