// 012 (SPEC L2-7, §3.3, rule A9): the only reader of L2's Auth0 client credential. Owner: feature 012.
// Part 1 validates the CIBA_* configuration (errors name the variable, never its value). Part 2 is the CIBA
// poll-mode client (specs/012 contracts/auth0-ciba.md): two form POSTs to fixed issuer-relative HTTPS paths,
// fresh client authentication per call, and the sealed request handle (research R8). Only the OAuth `error`
// code is ever read from an error body, and only from a fixed list; error_description is never read (NFR-003,
// NFR-006). This module never logs.
import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { ConfigError } from "../shared/config.js";

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Part 1: configuration (contracts/config-and-secrets.md, CFG-2)
// ---------------------------------------------------------------------------

export const CIBA_VARIABLES = [
  "CIBA_APPROVAL",
  "CIBA_ISSUER",
  "CIBA_CLIENT_ID",
  "CIBA_AUDIENCE",
  "CIBA_APPROVER",
  "CIBA_CLIENT_KEY",
  "CIBA_CLIENT_SECRET",
  "CIBA_CLIENT_KEY_ID",
] as const;

/**
 * In Azure the l2 vault always holds ciba-client-credential, and while the feature is off it holds this placeholder
 * (specs/012 contracts/config-and-secrets.md "Azure"). Off, it is not reported as a stray variable; on, it is refused.
 */
export const CIBA_CREDENTIAL_PLACEHOLDER = "off";

export type CibaCredential = { kind: "key"; keyPem: string; keyId?: string } | { kind: "secret"; secret: string };

export interface CibaSettings {
  issuer: string;
  clientId: string;
  audience: string;
  approver: string;
  credential: CibaCredential;
}

export type CibaConfig = { enabled: false; ignored: string[] } | ({ enabled: true } & CibaSettings);

const present = (env: Env, name: string) => (env[name] ?? "") !== "";
const noSpace = (s: string) => /^\S+$/.test(s);

function requireText(env: Env, name: string, max: number): string {
  const v = env[name] ?? "";
  if (v === "") throw new ConfigError(`${name} is required when CIBA_APPROVAL=1`);
  if (v.length > max || !noSpace(v)) throw new ConfigError(`${name} must be 1-${max} characters with no whitespace`);
  return v;
}

function issuerFrom(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError("CIBA_ISSUER must be an absolute https:// URL");
  }
  if (u.protocol !== "https:") throw new ConfigError("CIBA_ISSUER must be an absolute https:// URL");
  if (u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "") {
    throw new ConfigError("CIBA_ISSUER must have no query, fragment or credentials");
  }
  return u.href.endsWith("/") ? u.href : `${u.href}/`;
}

/** Auth0's private_key_jwt takes RSA keys of 2048 to 4096 bits, never EC (research R3). */
export const RSA_KEY_BITS = { min: 2048, max: 4096 } as const;

export const rsaKeySizeAllowed = (bits: number): boolean => Number.isInteger(bits) && bits >= RSA_KEY_BITS.min && bits <= RSA_KEY_BITS.max;

/** An RSA private key of 2048-4096 bits, returned as PKCS#8 PEM. `\n` escapes are accepted. */
function clientKeyPem(raw: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: raw.replace(/\\n/g, "\n"), format: "pem" });
  } catch {
    throw new ConfigError("CIBA_CLIENT_KEY is not a PEM private key");
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || !rsaKeySizeAllowed(bits)) {
    throw new ConfigError("CIBA_CLIENT_KEY must be an RSA key of 2048-4096 bits (Auth0 private_key_jwt accepts RS256, never ES256)");
  }
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Validates every CIBA_* variable, in the contract's order. Off unless CIBA_APPROVAL=1. Never reads the network. */
export function cibaConfigFromEnv(env: Env = process.env): CibaConfig {
  const switchValue = env.CIBA_APPROVAL ?? "";
  if (switchValue !== "" && switchValue !== "0" && switchValue !== "1") throw new ConfigError("CIBA_APPROVAL must be 1, 0 or empty");
  if (switchValue !== "1") {
    const placeholder = (n: string) => (n === "CIBA_CLIENT_KEY" || n === "CIBA_CLIENT_SECRET") && env[n] === CIBA_CREDENTIAL_PLACEHOLDER;
    return { enabled: false, ignored: CIBA_VARIABLES.filter((n) => n !== "CIBA_APPROVAL" && present(env, n) && !placeholder(n)) };
  }

  const issuer = issuerFrom(requireText(env, "CIBA_ISSUER", 2048));
  const clientId = requireText(env, "CIBA_CLIENT_ID", 64);
  const audience = requireText(env, "CIBA_AUDIENCE", 255);
  const approver = requireText(env, "CIBA_APPROVER", 255);
  const hasKey = present(env, "CIBA_CLIENT_KEY");
  const hasSecret = present(env, "CIBA_CLIENT_SECRET");
  if (hasKey && hasSecret) throw new ConfigError("set only one of CIBA_CLIENT_KEY and CIBA_CLIENT_SECRET");
  if (!hasKey && !hasSecret) throw new ConfigError("CIBA_CLIENT_KEY or CIBA_CLIENT_SECRET is required when CIBA_APPROVAL=1");
  for (const n of ["CIBA_CLIENT_KEY", "CIBA_CLIENT_SECRET"]) {
    if (env[n] === CIBA_CREDENTIAL_PLACEHOLDER) throw new ConfigError(`${n} still holds the placeholder; seed the real credential in the vault (specs/012 quickstart §6)`);
  }
  let credential: CibaCredential;
  if (hasKey) {
    const keyPem = clientKeyPem(env.CIBA_CLIENT_KEY!);
    if (present(env, "CIBA_CLIENT_KEY_ID")) {
      const keyId = env.CIBA_CLIENT_KEY_ID!;
      if (keyId.length > 255 || !noSpace(keyId)) throw new ConfigError("CIBA_CLIENT_KEY_ID must be 1-255 characters with no whitespace");
      credential = { kind: "key", keyPem, keyId };
    } else {
      credential = { kind: "key", keyPem };
    }
  } else {
    if (present(env, "CIBA_CLIENT_KEY_ID")) throw new ConfigError("CIBA_CLIENT_KEY_ID needs CIBA_CLIENT_KEY");
    const secret = env.CIBA_CLIENT_SECRET!;
    if (secret.length < 16) throw new ConfigError("CIBA_CLIENT_SECRET must be at least 16 characters");
    credential = { kind: "secret", secret };
  }
  return { enabled: true, issuer, clientId, audience, approver, credential };
}

// ---------------------------------------------------------------------------
// Part 2: the CIBA poll-mode client (contracts/auth0-ciba.md)
// ---------------------------------------------------------------------------

export const START_ATTEMPT_TIMEOUT_MS = 1_500;
export const POLL_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;
const ASSERTION_TTL_S = 60;
const SEAL_SALT = "x402/ciba/handle/v1";

/** The only OAuth `error` values ever stored; anything else becomes "other". */
export const CIBA_ERROR_CODES = [
  "invalid_request",
  "invalid_scope",
  "expired_login_hint_token",
  "unknown_user_id",
  "unauthorized_client",
  "missing_user_code",
  "invalid_user_code",
  "invalid_binding_message",
  "invalid_client",
  "access_denied",
  "invalid_grant",
  "expired_token",
  "invalid_authorization_details",
  "too_many_requests",
] as const;

export const errorCode = (e: unknown): string =>
  typeof e === "string" && (CIBA_ERROR_CODES as readonly string[]).includes(e) ? e : "other";

export type StartResult =
  | { kind: "ok"; authReqId: string; expiresIn: number; interval: number }
  | { kind: "transient"; failure: "unreachable" | "transient"; httpStatus?: number }
  | { kind: "permanent"; httpStatus: number; error: string };

export type PollResult =
  | { kind: "token"; accessToken: string; responseDetails?: unknown }
  | { kind: "pending" }
  | { kind: "slow_down"; interval?: number }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "transient"; httpStatus?: number }
  | { kind: "permanent"; httpStatus: number; error: string };

export interface StartParams {
  bindingMessage: string;
  requestedExpiry: number;
  authorizationDetails: unknown[];
}

/** What the backchannel coordinator sees: no credential, no settings beyond the calls themselves. */
export interface CibaPort {
  start(p: StartParams): Promise<StartResult>;
  poll(authReqId: string): Promise<PollResult>;
  /** AES-256-GCM under a key derived from the credential; `aad` binds it to one escalation and request. */
  seal(authReqId: string, aad: string): string;
  /** null on any failure (wrong key, wrong aad, tampering). */
  open(sealed: string, aad: string): string | null;
}

export interface CibaClientOptions {
  fetchImpl?: typeof fetch;
  startTimeoutMs?: number;
  pollTimeoutMs?: number;
  /** Test-only: accept an http://127.0.0.1:<port>/ issuer (the stand-in Auth0). Never set from env. */
  allowInsecureLoopback?: boolean;
}

type Posted = { network: "unreachable" | "timeout" } | { status: number; json: Record<string, unknown> | undefined };

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

async function readCapped(res: Response): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class CibaClient implements CibaPort {
  private readonly fetchImpl: typeof fetch;
  private readonly startTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly signingKey: Promise<CryptoKey> | undefined;
  private readonly sealKey: Buffer;

  constructor(
    private readonly settings: CibaSettings,
    opts: CibaClientOptions = {},
  ) {
    const loopback = opts.allowInsecureLoopback === true && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(settings.issuer);
    if (!settings.issuer.startsWith("https://") && !loopback) throw new ConfigError("CIBA_ISSUER must be an absolute https:// URL");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.startTimeoutMs = opts.startTimeoutMs ?? START_ATTEMPT_TIMEOUT_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    const cred = settings.credential;
    let ikm: Buffer;
    if (cred.kind === "key") {
      this.signingKey = importPKCS8(cred.keyPem, "RS256");
      ikm = createPrivateKey(cred.keyPem).export({ type: "pkcs8", format: "der" });
    } else {
      ikm = Buffer.from(cred.secret, "utf8");
    }
    this.sealKey = Buffer.from(hkdfSync("sha256", ikm, SEAL_SALT, `${settings.issuer}|${settings.clientId}`, 32));
  }

  /** Fresh client authentication for one call (research R3). */
  private async clientAuth(): Promise<Record<string, string>> {
    const { clientId, issuer, credential } = this.settings;
    if (credential.kind === "secret") return { client_id: clientId, client_secret: credential.secret };
    const iat = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT", ...(credential.keyId !== undefined && { kid: credential.keyId }) })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(issuer)
      .setJti(randomBytes(32).toString("base64url"))
      .setIssuedAt(iat)
      .setExpirationTime(iat + ASSERTION_TTL_S)
      .sign(await this.signingKey!);
    return {
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    };
  }

  private async post(path: "bc-authorize" | "oauth/token", form: Record<string, string>, timeoutMs: number): Promise<Posted> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.settings.issuer), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      return { network: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "unreachable" };
    }
    let text: string | undefined;
    try {
      text = await readCapped(res);
    } catch {
      return { network: "timeout" };
    }
    if (text === undefined) return { status: res.status, json: undefined };
    try {
      const parsed: unknown = JSON.parse(text);
      return { status: res.status, json: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined };
    } catch {
      return { status: res.status, json: undefined };
    }
  }

  async start(p: StartParams): Promise<StartResult> {
    const { clientId, issuer, approver, audience } = this.settings;
    const form = {
      client_id: clientId,
      scope: "openid",
      login_hint: JSON.stringify({ format: "iss_sub", iss: issuer, sub: approver }),
      binding_message: p.bindingMessage,
      audience,
      requested_expiry: String(p.requestedExpiry),
      authorization_details: JSON.stringify(p.authorizationDetails),
      ...(await this.clientAuth()),
    };
    const r = await this.post("bc-authorize", form, this.startTimeoutMs);
    if ("network" in r) return { kind: "transient", failure: r.network === "timeout" ? "transient" : "unreachable" };
    const j = r.json;
    if (r.status === 200 && j && typeof j.auth_req_id === "string" && j.auth_req_id.length > 0 && isPosInt(j.expires_in) && (j.interval === undefined || isPosInt(j.interval))) {
      return { kind: "ok", authReqId: j.auth_req_id, expiresIn: j.expires_in, interval: isPosInt(j.interval) ? j.interval : 5 };
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 429 && j && typeof j.error === "string") {
      return { kind: "permanent", httpStatus: r.status, error: errorCode(j.error) };
    }
    return { kind: "transient", failure: "transient", httpStatus: r.status };
  }

  async poll(authReqId: string): Promise<PollResult> {
    const form = { grant_type: "urn:openid:params:grant-type:ciba", auth_req_id: authReqId, ...(await this.clientAuth()) };
    const r = await this.post("oauth/token", form, this.pollTimeoutMs);
    if ("network" in r) return { kind: "transient" };
    const j = r.json;
    if (r.status === 200 && j && typeof j.access_token === "string" && j.access_token.length > 0) {
      return { kind: "token", accessToken: j.access_token, ...(j.authorization_details !== undefined && { responseDetails: j.authorization_details }) };
    }
    const error = j && typeof j.error === "string" ? j.error : undefined;
    if (error === "authorization_pending") return { kind: "pending" };
    if (error === "slow_down") return { kind: "slow_down", ...(isPosInt(j!.interval) && { interval: j!.interval }) };
    if (error === "access_denied") return { kind: "denied" };
    if (error === "expired_token") return { kind: "expired" };
    if (r.status === 429 || r.status >= 500 || error === undefined) return { kind: "transient", httpStatus: r.status };
    return { kind: "permanent", httpStatus: r.status, error: errorCode(error) };
  }

  seal(authReqId: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.sealKey, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([c.update(authReqId, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
  }

  open(sealed: string, aad: string): string | null {
    try {
      const [v, iv, ct, tag] = sealed.split(".");
      if (v !== "v1" || !iv || !ct || !tag) return null;
      const d = createDecipheriv("aes-256-gcm", this.sealKey, Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

/** The non-secret settings the rest of L2 may see (issuer, client, audience, approver). */
export function publicSettings(s: CibaSettings): Omit<CibaSettings, "credential"> {
  return { issuer: s.issuer, clientId: s.clientId, audience: s.audience, approver: s.approver };
}
