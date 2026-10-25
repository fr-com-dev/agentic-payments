// L1-6 hosted agent service configuration (SPEC.md §9 CFG-2 `l1-hosted.env`; specs/011 contracts/model-access.md).
// Errors name the variable and never echo its value: several of them are secrets.
import { ConfigError, serviceUrls, tokenFor } from "../../shared/config.js";

type Env = Record<string, string | undefined>;

/** Issuer and tenant of the local dev issuer (`npm run dev-token`). Only valid with NETWORK=local. */
export const DEV_ISSUER = "urn:x402:dev-issuer";
export const DEV_TENANT = "dev";

/** Recognized model ids. An unrecognized id makes the AI SDK provider add a third `json` tool (research R2). */
export const MODEL_ALLOW_LIST = ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-haiku-5-5"] as const;
export type AllowedModel = (typeof MODEL_ALLOW_LIST)[number];
export const DEFAULT_MODEL: AllowedModel = "claude-sonnet-5-5";

export const DEFAULT_AGENT_PORT = 4024;
export const DEFAULT_AGENT_BIND_HOST = "127.0.0.1";
const MIN_SECRET_BYTES = 32;
/** An Entra application (client) ID. */
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ModelProvider = "anthropic" | "foundry";

export interface HostedConfig {
  network: string;
  urls: { seller: string; control: string; settlement: string };
  tokens: { control: string; verifier: string };
  provider: ModelProvider;
  model: AllowedModel;
  anthropicApiKey?: string;
  foundryBaseUrl?: string;
  azureClientId?: string;
  auth: { tenantId: string; audience: string; issuer: string; jwksFile?: string };
  sessionRefSecret: Buffer;
  port: number;
  bindHost: string;
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

  const tenantId = required(env, "AUTH_TENANT_ID");
  const audience = required(env, "AUTH_AUDIENCE");
  const jwksFile = present(env.AUTH_JWKS_FILE) ? env.AUTH_JWKS_FILE : undefined;
  if (jwksFile !== undefined && !local) throw new ConfigError("AUTH_JWKS_FILE is allowed only with NETWORK=local");
  const issuer = jwksFile !== undefined ? DEV_ISSUER : `https://login.microsoftonline.com/${tenantId}/v2.0`;
  // Entra v2.0 access tokens always carry the API app's client ID as `aud`, never its api:// URI, so any other
  // value would refuse every real token (research R6).
  if (jwksFile === undefined && !CLIENT_ID_RE.test(audience)) {
    throw new ConfigError("AUTH_AUDIENCE must be the API app's client ID (a GUID): Entra v2.0 tokens carry it as aud");
  }

  const secretRaw = required(env, "SESSION_REF_SECRET");
  const sessionRefSecret = decodeSecret(secretRaw);
  if (sessionRefSecret === null || sessionRefSecret.length < MIN_SECRET_BYTES) {
    throw new ConfigError(`SESSION_REF_SECRET must decode (hex or base64) to at least ${MIN_SECRET_BYTES} bytes`);
  }

  return {
    network,
    urls: serviceUrls(env),
    tokens: { control: tokenFor("agent-control", env), verifier: tokenFor("agent-verifier", env) },
    provider,
    model: model as AllowedModel,
    ...(anthropicApiKey !== undefined && { anthropicApiKey }),
    ...(foundryBaseUrl !== undefined && { foundryBaseUrl }),
    ...(azureClientId !== undefined && { azureClientId }),
    auth: { tenantId, audience, issuer, ...(jwksFile !== undefined && { jwksFile }) },
    sessionRefSecret,
    port: agentPort(env),
    bindHost: present(env.AGENT_BIND_HOST) ? env.AGENT_BIND_HOST : DEFAULT_AGENT_BIND_HOST,
  };
}
