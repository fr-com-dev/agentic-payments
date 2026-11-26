// L1-6 hosted agent service configuration (SPEC.md §9 CFG-2 `l1-hosted.env`; specs/011 contracts/model-access.md).
// Errors name the variable and never echo its value: several of them are secrets.
import { trustedProxyHops } from "../../shared/address-limit.js";
import { isLoopbackBind } from "../../shared/local-only.js";
import { apiDocsEnabled, ConfigError, serviceUrls, tokenFor } from "../../shared/config.js";
import { DEV_ISSUER, PERSON_ISSUER_RE } from "../../shared/identity-token.js";

type Env = Record<string, string | undefined>;

// 013: the dev issuer's name lives in src/shared/identity-token.ts (L2 and the portal use it too); re-exported here.
export { DEV_ISSUER };

/** 016: the organization's directory no longer issues tokens for this service. A leftover setting stops it. */
const REMOVED_SETTINGS = ["AUTH_TENANT_ID", "SERVICE_AUDIENCE"] as const;

/** Recognized model ids. An unrecognized id makes the AI SDK provider add a third `json` tool (research R2). */
export const MODEL_ALLOW_LIST = ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-haiku-5-5"] as const;
export type AllowedModel = (typeof MODEL_ALLOW_LIST)[number];
export const DEFAULT_MODEL: AllowedModel = "claude-sonnet-5-5";

export const DEFAULT_AGENT_PORT = 4024;
export const DEFAULT_AGENT_BIND_HOST = "127.0.0.1";
const MIN_SECRET_BYTES = 32;
/** One client ID on `AGENT_CLIENT_IDS`: no spaces, no commas. */
const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;

export type ModelProvider = "anthropic" | "foundry";

/**
 * 021 (SPEC L1-6, FR-001): how the agent finds what a goal needs. `search` (the default): it may search the public x402
 * discovery index first. `test` (`AGENT_TEST_MODE=1`): exactly the agent of before 021, straight to the configured
 * seller's catalog. The operator's setting only: never a request field, and no caller or model ever sees it (FR-002,
 * FR-003).
 */
export type AgentMode = "search" | "test";

export interface HostedConfig {
  network: string;
  /** 021: the mode every run of this process takes when it starts. */
  mode: AgentMode;
  /**
   * 021: `DISCOVERY_URL`, the index's search address, read in search mode only. Absent: the network's default
   * (the public index on base-sepolia; on local the setting is required).
   */
  discoveryUrl?: string;
  urls: { seller: string; control: string; settlement: string };
  tokens: { control: string; verifier: string };
  provider: ModelProvider;
  model: AllowedModel;
  anthropicApiKey?: string;
  foundryBaseUrl?: string;
  azureClientId?: string;
  /**
   * 016 (specs/016 contracts/hosted-agent-api.md): the one issuer of callers' tokens, the sign-in tenant; people's
   * API's identifier; and the clients a person's token may come from. The portal's client is never among them
   * (SEC-20). A machine caller is not listed: its grant at the tenant is the list.
   */
  auth: {
    issuer: string;
    audience: string;
    clientIds: string[];
    /** Local only: the dev issuer's keys. */
    jwksFile?: string;
    /** `API_DOCS_CLIENT_ID`: the client the docs page signs people in through. Absent: the page offers no sign-in. */
    docsClientId?: string;
    /**
     * 019: `AGENT_DESKTOP_CLIENT_ID`, the desktop client (a person signs in from their own computer: browser, loopback
     * return, PKCE). One of `clientIds`. Set: `GET /.well-known/agent-auth` serves its sign-in settings. Absent: no route.
     */
    desktopClientId?: string;
  };
  sessionRefSecret: Buffer;
  port: number;
  bindHost: string;
  /** Reverse proxies in front of the service (TRUSTED_PROXY_HOPS): 0 locally, 1 behind the Azure ingress. */
  trustedProxyHops?: number;
  /** v1.6: `API_DOCS=1` mounts the token-free Swagger UI routes (SEC-13). Off by default. */
  apiDocs: boolean;
}

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

function required(env: Env, name: string): string {
  const v = env[name];
  if (!present(v)) throw new ConfigError(`${name} is required (env/l1-hosted.env)`);
  return v;
}

/** Hex when it looks like hex, otherwise base64 or base64url. */
function decodeSecret(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return Buffer.from(raw, raw.includes("-") || raw.includes("_") ? "base64url" : "base64");
  return null;
}

/** 021: `AGENT_TEST_MODE` `1` is test mode; `0`, empty or absent is search mode; anything else stops the agent. */
function agentMode(env: Env): AgentMode {
  const raw = env.AGENT_TEST_MODE;
  if (raw === undefined || raw === "" || raw === "0") return "search";
  if (raw === "1") return "test";
  throw new ConfigError("AGENT_TEST_MODE must be 1 or 0");
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 021: `DISCOVERY_URL`, in search mode only: an absolute URL with no user name or password, `https:` outside the local
 * network, and on it `http:` only to a loopback host. Required on the local network, which has no public index. The
 * errors name the variables, never the value; they reach the operator only, at startup (FR-003, FR-019).
 */
function discoveryUrl(env: Env, local: boolean): string | undefined {
  const raw = env.DISCOVERY_URL;
  if (!present(raw)) {
    if (local) throw new ConfigError("DISCOVERY_URL is required on the local network unless AGENT_TEST_MODE=1");
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError("DISCOVERY_URL must be an absolute URL");
  }
  if (u.username !== "" || u.password !== "") throw new ConfigError("DISCOVERY_URL must not carry a user name or password");
  if (u.protocol === "https:") return u.href;
  if (local && u.protocol === "http:" && LOOPBACK_HOSTNAMES.has(u.hostname)) return u.href;
  throw new ConfigError(local ? "DISCOVERY_URL must be https, or http to a loopback host on the local network" : "DISCOVERY_URL must be https");
}

function agentPort(env: Env): number {
  const raw = env.AGENT_PORT;
  if (!present(raw)) return DEFAULT_AGENT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError("AGENT_PORT is not a valid port");
  return n;
}

export function loadHostedConfig(env: Env = process.env): HostedConfig {
  const network = env.NETWORK ?? "local";
  const local = network === "local";

  const provider = env.MODEL_PROVIDER;
  if (provider !== "anthropic" && provider !== "foundry") {
    throw new ConfigError("MODEL_PROVIDER must be foundry or anthropic");
  }
  const model = present(env.ANTHROPIC_MODEL) ? env.ANTHROPIC_MODEL : DEFAULT_MODEL;
  if (!(MODEL_ALLOW_LIST as readonly string[]).includes(model)) {
    throw new ConfigError(`ANTHROPIC_MODEL must be one of ${MODEL_ALLOW_LIST.join(", ")}`);
  }

  let anthropicApiKey: string | undefined;
  let foundryBaseUrl: string | undefined;
  let azureClientId: string | undefined;
  if (provider === "anthropic") {
    anthropicApiKey = required(env, "ANTHROPIC_API_KEY");
  } else {
    if (present(env.ANTHROPIC_API_KEY)) throw new ConfigError("ANTHROPIC_API_KEY must not be set with MODEL_PROVIDER=foundry");
    foundryBaseUrl = required(env, "FOUNDRY_BASE_URL");
    if (!/^https:\/\/[^/]+\/anthropic\/v1\/?$/.test(foundryBaseUrl)) {
      throw new ConfigError("FOUNDRY_BASE_URL must be https://<resource>.services.ai.azure.com/anthropic/v1");
    }
    foundryBaseUrl = foundryBaseUrl.replace(/\/+$/, "");
    azureClientId = required(env, "AZURE_CLIENT_ID");
  }

  const jwksFile = present(env.AUTH_JWKS_FILE) ? env.AUTH_JWKS_FILE : undefined;
  if (jwksFile !== undefined && !local) throw new ConfigError("AUTH_JWKS_FILE is allowed only with NETWORK=local");
  const dev = jwksFile !== undefined;

  // 016: one issuer. A setting of the organization's directory is never used: it stops the service, by name.
  for (const name of REMOVED_SETTINGS) {
    if (present(env[name])) throw new ConfigError(`${name} is no longer used: remove it (SPEC L1-6). Callers come from the sign-in tenant only`);
  }
  const issuer = required(env, "AUTH_ISSUER");
  if (dev && issuer !== DEV_ISSUER) throw new ConfigError(`AUTH_ISSUER must be ${DEV_ISSUER} with AUTH_JWKS_FILE (the local dev issuer)`);
  if (!dev && !PERSON_ISSUER_RE.test(issuer)) {
    throw new ConfigError("AUTH_ISSUER must be the sign-in tenant's issuer, https://<domain>/ in lower case with the final slash");
  }
  const audience = required(env, "AUTH_AUDIENCE");
  const clientIds = required(env, "AGENT_CLIENT_IDS").split(",").map((c) => c.trim());
  if (clientIds.some((c) => !CLIENT_ID_RE.test(c))) throw new ConfigError("AGENT_CLIENT_IDS must be a comma-separated list of client IDs");
  // SEC-20: a token the portal's web app obtained must never start a run, so its client can't be on the list.
  if (present(env.PORTAL_CLIENT_ID) && clientIds.includes(env.PORTAL_CLIENT_ID)) {
    throw new ConfigError("AGENT_CLIENT_IDS must not contain PORTAL_CLIENT_ID: the agent service never accepts a portal token");
  }
  // The docs page's sign-in (SEC-34): through one of the agent's own clients, at a real tenant.
  const docsClientId = present(env.API_DOCS_CLIENT_ID) ? env.API_DOCS_CLIENT_ID : undefined;
  if (docsClientId !== undefined) {
    if (!clientIds.includes(docsClientId)) throw new ConfigError("API_DOCS_CLIENT_ID must be one of AGENT_CLIENT_IDS");
    if (dev) throw new ConfigError("API_DOCS_CLIENT_ID needs the sign-in tenant: the local dev issuer has no sign-in page");
  }
  // 019: the client the sign-in settings advertise must be one whose tokens this service accepts (so never the
  // portal's: the list above can't hold it), at a real tenant: the dev issuer has no sign-in page. The errors name the
  // variable, never its value.
  const desktopClientId = present(env.AGENT_DESKTOP_CLIENT_ID) ? env.AGENT_DESKTOP_CLIENT_ID : undefined;
  if (desktopClientId !== undefined) {
    if (!clientIds.includes(desktopClientId)) throw new ConfigError("AGENT_DESKTOP_CLIENT_ID must be one of AGENT_CLIENT_IDS");
    if (dev) throw new ConfigError("AGENT_DESKTOP_CLIENT_ID needs the sign-in tenant: the local dev issuer has no sign-in page");
  }

  const bindHost = present(env.AGENT_BIND_HOST) ? env.AGENT_BIND_HOST : DEFAULT_AGENT_BIND_HOST;
  const hops = trustedProxyHops(env);
  // 017 (SEC-44): the dev issuer's tokens can be made by anyone with the repository, so with it the service serves
  // this machine only: a loopback bind and no proxy in front. Each request is checked too (localOnly in server.ts).
  if (dev && !isLoopbackBind(bindHost)) throw new ConfigError("AGENT_BIND_HOST must be a loopback address with AUTH_JWKS_FILE (the local dev issuer)");
  if (dev && hops > 0) throw new ConfigError("TRUSTED_PROXY_HOPS must be 0 with AUTH_JWKS_FILE (the local dev issuer)");

  const secretRaw = required(env, "SESSION_REF_SECRET");
  const sessionRefSecret = decodeSecret(secretRaw);
  if (sessionRefSecret === null || sessionRefSecret.length < MIN_SECRET_BYTES) {
    throw new ConfigError(`SESSION_REF_SECRET must decode (hex or base64) to at least ${MIN_SECRET_BYTES} bytes`);
  }

  // 021: last, so every earlier refusal keeps its place in the order.
  const mode = agentMode(env);
  const discovery = mode === "search" ? discoveryUrl(env, local) : undefined;

  return {
    network,
    mode,
    ...(discovery !== undefined && { discoveryUrl: discovery }),
    urls: serviceUrls(env),
    tokens: { control: tokenFor("agent-control", env), verifier: tokenFor("agent-verifier", env) },
    provider,
    model: model as AllowedModel,
    ...(anthropicApiKey !== undefined && { anthropicApiKey }),
    ...(foundryBaseUrl !== undefined && { foundryBaseUrl }),
    ...(azureClientId !== undefined && { azureClientId }),
    auth: { issuer, audience, clientIds, ...(jwksFile !== undefined && { jwksFile }), ...(docsClientId !== undefined && { docsClientId }), ...(desktopClientId !== undefined && { desktopClientId }) },
    sessionRefSecret,
    port: agentPort(env),
    bindHost,
    trustedProxyHops: hops,
    apiDocs: apiDocsEnabled(env),
  };
}
