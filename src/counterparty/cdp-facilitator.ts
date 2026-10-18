// CDP facilitator client (SPEC v1.2 CP-3; specs/009 contracts/cdp-facilitator-api.md). The only file that
// reads the CDP API credential (architecture rule A8). The credential authenticates the seller to CDP and
// cannot authorize an on-chain transfer: it is not payment key material (INV-2 unchanged).
import { createPrivateKey } from "node:crypto";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { CDP_FACILITATOR_URL, ConfigError, HOSTED_FACILITATOR_TIMEOUT_MS } from "../shared/config.js";

type Env = Record<string, string | undefined>;

export interface CdpCredential {
  apiKeyId: string;
  /** Normalized: trimmed, literal `\n` expanded, SEC1 EC keys converted to PKCS#8. */
  apiKeySecret: string;
}

const ID_VAR = "CDP_API_KEY_ID";
const SECRET_VAR = "CDP_API_KEY_SECRET";
const INVALID_SECRET = `${SECRET_VAR} is not a valid Ed25519 (base64) or EC (PEM) key`;
const SEC1_HEADER = "-----BEGIN EC PRIVATE KEY-----";

/** Second log line for `authentication` failures under FACILITATOR=cdp (contracts/seller-errors.md). */
export const CDP_AUTH_HINT = `check ${ID_VAR}/SECRET and the host clock (JWTs expire in 120 s)`;

/** Raw env values, kept only so redaction also covers the form the operator typed. */
const rawSecrets = new WeakMap<CdpCredential, string>();

/**
 * `generateJwt` detects EC keys with jose's `importPKCS8`, which accepts only PKCS#8 with no leading
 * whitespace. CDP also issues SEC1 keys, so those are converted here (research R1).
 */
export function normalizeCdpSecret(raw: string): string {
  let secret = raw.trim().replace(/\\n/g, "\n");
  if (secret.includes(SEC1_HEADER)) {
    try {
      secret = createPrivateKey({ key: secret, format: "pem" }).export({ type: "pkcs8", format: "pem" }).toString();
    } catch {
      throw new ConfigError(INVALID_SECRET);
    }
  }
  return secret.trim();
}

/** Throws a fixed ConfigError naming the missing variable; never echoes a value. */
export function cdpCredentialsFromEnv(env: Env = process.env): CdpCredential {
  const id = env[ID_VAR]?.trim();
  if (!id) throw new ConfigError(`missing ${ID_VAR} (required for FACILITATOR=cdp)`);
  const raw = env[SECRET_VAR];
  if (!raw?.trim()) throw new ConfigError(`missing ${SECRET_VAR} (required for FACILITATOR=cdp)`);
  const cred: CdpCredential = { apiKeyId: id, apiKeySecret: normalizeCdpSecret(raw) };
  rawSecrets.set(cred, raw);
  return cred;
}

/** Presence only, so scripts can check an env file without naming the variables (A8). */
export function cdpCredentialStatus(values: Env): { keyId: boolean; secret: boolean } {
  return { keyId: Boolean(values[ID_VAR]?.trim()), secret: Boolean(values[SECRET_VAR]?.trim()) };
}

export function cdpCredentialsPresent(env: Env = process.env): boolean {
  const s = cdpCredentialStatus(env);
  return s.keyId || s.secret;
}

/** Every form of the secret worth hiding, longest first: whole values, PEM body lines, 32-char prefixes. */
function secretFragments(secrets: string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    const t = s.trim();
    if (t === "") continue;
    out.add(t);
    if (t.length > 32) out.add(t.slice(0, 32));
    for (const line of t.split(/\r?\n|\\n/)) {
      const l = line.trim();
      if (l.length >= 16 && !l.startsWith("-----")) out.add(l);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function fragmentsFor(raw: string): string[] {
  let normalized: string | undefined;
  try {
    normalized = normalizeCdpSecret(raw);
  } catch {
    normalized = undefined;
  }
  return secretFragments(normalized === undefined ? [raw] : [raw, normalized]);
}

/** True if `text` contains the seller's CDP secret in any form. Returns only the boolean (SC-004). */
export function containsCdpSecret(values: Env, text: string): boolean {
  const raw = values[SECRET_VAR];
  if (!raw?.trim()) return false;
  return fragmentsFor(raw).some((f) => text.includes(f));
}

/** Replaces every form of the secret with `[redacted]` (FR-011, research R8). */
export function makeRedactor(cred: CdpCredential): (text: string) => string {
  const fragments = secretFragments([rawSecrets.get(cred) ?? "", cred.apiKeySecret]);
  return (text) => fragments.reduce((acc, f) => acc.split(f).join("[redacted]"), text);
}

export const keyIdSuffix = (cred: CdpCredential) => `…${cred.apiKeyId.slice(-4)}`;

function jwtFor(cred: CdpCredential, method: "GET" | "POST", host: string, path: string): Promise<string> {
  return generateJwt({
    apiKeyId: cred.apiKeyId,
    apiKeySecret: cred.apiKeySecret,
    requestMethod: method,
    requestHost: host,
    requestPath: path,
  });
}

/** Signs one JWT locally (no network) to prove the secret parses. Never forwards the library's error text. */
export async function validateCdpSecret(cred: CdpCredential): Promise<void> {
  const u = new URL(CDP_FACILITATOR_URL);
  try {
    await jwtFor(cred, "GET", u.host, `${u.pathname}/supported`);
  } catch {
    throw new ConfigError(INVALID_SECRET);
  }
}

export interface CdpClientOptions {
  /** Test-only override; configuration never changes it (FR-004). */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * The pinned x402 HTTPFacilitatorClient with a fresh CDP JWT per request (research R1). Each JWT is
 * bound to its method, host and path through the `uris` claim and expires after 120 s.
 */
export function cdpFacilitatorClient(cred: CdpCredential, opts: CdpClientOptions = {}): HTTPFacilitatorClient {
  const baseUrl = opts.baseUrl ?? CDP_FACILITATOR_URL;
  const u = new URL(baseUrl);
  const basePath = u.pathname.replace(/\/$/, "");
  const header = async (method: "GET" | "POST", op: string) => ({
    Authorization: `Bearer ${await jwtFor(cred, method, u.host, `${basePath}/${op}`)}`,
  });
  return new HTTPFacilitatorClient({
    url: baseUrl,
    timeoutMs: opts.timeoutMs ?? HOSTED_FACILITATOR_TIMEOUT_MS,
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([
        header("POST", "verify"),
        header("POST", "settle"),
        header("GET", "supported"),
      ]);
      return { verify, settle, supported };
    },
  });
}
