// L1-6 hosted agent service configuration (SPEC.md §9 CFG-2 `l1-hosted.env`; specs/011 contracts/model-access.md).
// Errors name the variable and never echo its value: several of them are secrets.
import { trustedProxyHops } from "../../shared/address-limit.js";
import { apiDocsEnabled, ConfigError, serviceUrls, tokenFor } from "../../shared/config.js";
import { DEV_DIRECTORY_ISSUER, DEV_ISSUER, DEV_TENANT, entraIssuer, GUID_RE, PERSON_ISSUER_RE } from "../../shared/identity-token.js";

type Env = Record<string, string | undefined>;

// 013: the dev issuer's constants live in src/shared/identity-token.ts (the portal uses them too); re-exported here.
export { DEV_DIRECTORY_ISSUER, DEV_ISSUER, DEV_TENANT };

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

export interface HostedConfig {
  network: string;
  urls: { seller: string; control: string; settlement: string };
  tokens: { control: string; verifier: string };
  provider: ModelProvider;
  model: AllowedModel;
  anthropicApiKey?: string;
  foundryBaseUrl?: string;
  azureClientId?: string;
  auth: {
    /**
     * People (013, research R19): the Auth0 tenant's issuer, the API's identifier, and the clients whose tokens
     * start runs. The portal's client is never among them (SEC-20). Absent: no person is accepted.
     */
    person?: { issuer: string; audience: string; clientIds: string[] };
    /** System identities: the organization's directory (Entra). Absent: no system identity is accepted. */
    service?: { tenantId: string; audience: string; issuer: string };
    jwksFile?: string;
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

  // People sign in with the Auth0 tenant (013, research R19). All three variables, or none: without them no person
  // is accepted, which is how an environment runs until its sign-in tenant is set up.
  const personVars = ["AUTH_ISSUER", "AUTH_AUDIENCE", "AGENT_CLIENT_IDS"] as const;
  const personGiven = personVars.filter((name) => present(env[name]));
  if (personGiven.length !== 0 && personGiven.length !== personVars.length) {
    throw new ConfigError("AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS go together: set all three to accept people, or none");
  }
  let person: HostedConfig["auth"]["person"];
  if (personGiven.length === personVars.length) {
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
    person = { issuer, audience, clientIds };
  }

  // System identities stay with the organization's directory. Both variables, or neither (then none is accepted).
  let service: HostedConfig["auth"]["service"];
  if (present(env.AUTH_TENANT_ID) !== present(env.SERVICE_AUDIENCE)) {
    throw new ConfigError("AUTH_TENANT_ID and SERVICE_AUDIENCE go together: set both to accept system identities, or neither");
  }
  if (present(env.AUTH_TENANT_ID) && present(env.SERVICE_AUDIENCE)) {
    const tenantId = env.AUTH_TENANT_ID;
    const serviceAudience = env.SERVICE_AUDIENCE;
    if (!dev) {
      if (!GUID_RE.test(tenantId)) throw new ConfigError("AUTH_TENANT_ID must be the directory's tenant ID (a GUID)");
      // Entra v2.0 access tokens always carry the API app's client ID as `aud`, never its api:// URI, so any other
      // value would refuse every real token (specs/011 research R6).
      if (!GUID_RE.test(serviceAudience)) {
        throw new ConfigError("SERVICE_AUDIENCE must be the API app's client ID (a GUID): Entra v2.0 tokens carry it as aud");
      }
    }
    service = { tenantId, audience: serviceAudience, issuer: dev ? DEV_DIRECTORY_ISSUER : entraIssuer(tenantId) };
  }
  if (person === undefined && service === undefined) {
    throw new ConfigError(
      "nobody could call the service: set AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS (people), AUTH_TENANT_ID and SERVICE_AUDIENCE (system identities), or both",
    );
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
    auth: { ...(person !== undefined && { person }), ...(service !== undefined && { service }), ...(jwksFile !== undefined && { jwksFile }) },
    sessionRefSecret,
    port: agentPort(env),
    bindHost: present(env.AGENT_BIND_HOST) ? env.AGENT_BIND_HOST : DEFAULT_AGENT_BIND_HOST,
    trustedProxyHops: trustedProxyHops(env),
    apiDocs: apiDocsEnabled(env),
  };
}
