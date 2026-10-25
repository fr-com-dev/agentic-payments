// L1-6 model access (specs/011 contracts/model-access.md, research R2). The model is always an AI SDK
// instance (never a router string, which would take Mastra's models.dev and gateway code paths).
// `foundry`: keyless Entra ID through the agent's managed identity. `anthropic`: an API key.
import { createAnthropic } from "@ai-sdk/anthropic";
import { ManagedIdentityCredential, type AccessToken } from "@azure/identity";
import type { HostedConfig } from "./config.js";

export const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

/**
 * Set to true only if the first Foundry deployment shows it rejects the provider's `anthropic-beta`
 * header (quickstart §4). Unconfirmed at design time, so it stays off.
 */
export const STRIP_ANTHROPIC_BETA = false;

export interface TokenSource {
  getToken(scope: string): Promise<AccessToken | null>;
}

export interface ModelOptions {
  /** Test hook: the HTTP client the provider uses. */
  fetch?: typeof fetch;
  /** Test hook: the Entra token source (default: the agent's user-assigned managed identity). */
  credential?: TokenSource;
}

/** Sets a fresh Entra bearer token on every request. Tokens expire after about an hour; the credential caches them. */
export function withEntraToken(credential: TokenSource, base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const token = await credential.getToken(FOUNDRY_SCOPE);
    if (!token) throw new Error("no Entra token for Foundry");
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token.token}`);
    headers.delete("x-api-key");
    if (STRIP_ANTHROPIC_BETA) headers.delete("anthropic-beta");
    return base(input, { ...init, headers });
  };
}

export function createModel(config: HostedConfig, opts: ModelOptions = {}) {
  if (config.provider === "anthropic") {
    return createAnthropic({ apiKey: config.anthropicApiKey!, ...(opts.fetch && { fetch: opts.fetch }) })(config.model);
  }
  const credential = opts.credential ?? new ManagedIdentityCredential({ clientId: config.azureClientId! });
  // `authToken` is a placeholder so the provider sends neither `x-api-key` nor the ANTHROPIC_API_KEY
  // fallback; the fetch wrapper replaces its Authorization header with the real token.
  return createAnthropic({
    baseURL: config.foundryBaseUrl!,
    authToken: "entra",
    fetch: withEntraToken(credential, opts.fetch ?? fetch),
  })(config.model);
}
