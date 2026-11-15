// A machine caller's token (SPEC.md §3.3, §8.1 L1-5, §11 SEC-33; specs/016 research R9). A machine caller is a
// process that calls the hosted agent, or L2 through the command-line agent, with no person behind it: the
// deployment pipeline's two checks are the first. It has its own confidential client at the sign-in tenant, whose
// only grant is client credentials for people's API with the permission `agent:run`, and it authenticates with a
// signed assertion (`private_key_jwt`, RS256): no shared secret exists.
//
// This module is outside the layers. It holds the one credential of a machine caller, the private half of its key,
// and rule A15 keeps the two variables that carry it to this file. The token it returns is an ordinary access
// token: the agent and L2 verify it like any caller's (`verifyCaller`), it names no user, and the platform account
// pays. Nothing here signs a payment, and nothing is logged: errors never carry the key, the assertion, the token or
// the tenant's answer.
import { randomBytes } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { ConfigError } from "../shared/config.js";
import { PERSON_ISSUER_RE } from "../shared/identity-token.js";

type Env = Record<string, string | undefined>;

const ASSERTION_TTL_S = 60;
/** A token is reused until this long before it expires. */
const REFRESH_MARGIN_S = 60;
const TIMEOUT_MS = 10_000;
/** What a vault holds before the tenant has the client (specs/016 contracts/tenant-and-config.md). */
const PLACEHOLDER = "off";

export interface MachineCallerSettings {
  /** The sign-in tenant's issuer, `https://<domain>/`. */
  issuer: string;
  /** People's API's identifier. */
  audience: string;
  /** The machine caller's client at the tenant. */
  clientId: string;
  /** The key's ID at the tenant (`kid` of the assertion). Optional: the tenant matches by signature without it. */
  keyId?: string;
  /** The private half of the caller's key, PKCS#8 PEM. */
  keyPem: string;
}

export interface MachineCallerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests only: accept the stand-in tenant on `http://127.0.0.1:<port>/`. Never set by an entry point. */
  allowInsecureLoopback?: boolean;
}

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

/**
 * The machine caller's settings from the environment, or undefined when `MACHINE_CLIENT_ID` is not set. Errors name
 * the variable and never its value.
 */
export function machineCallerFromEnv(env: Env): MachineCallerSettings | undefined {
  if (!present(env.MACHINE_CLIENT_ID)) {
    for (const name of ["MACHINE_CLIENT_KEY", "MACHINE_CLIENT_KEY_ID"] as const) {
      if (present(env[name])) throw new ConfigError(`${name} needs MACHINE_CLIENT_ID (the machine caller's client)`);
    }
    return undefined;
  }
  for (const name of ["AUTH_ISSUER", "AUTH_AUDIENCE", "MACHINE_CLIENT_KEY"] as const) {
    if (!present(env[name])) throw new ConfigError(`${name} is required with MACHINE_CLIENT_ID`);
  }
  if (env.MACHINE_CLIENT_KEY === PLACEHOLDER) {
    throw new ConfigError("MACHINE_CLIENT_KEY holds the placeholder: seed the machine caller's private key in its vault");
  }
  if (!/-----BEGIN PRIVATE KEY-----/.test(env.MACHINE_CLIENT_KEY!)) throw new ConfigError("MACHINE_CLIENT_KEY must be a PKCS#8 private key in PEM");
  return {
    issuer: env.AUTH_ISSUER!,
    audience: env.AUTH_AUDIENCE!,
    clientId: env.MACHINE_CLIENT_ID,
    ...(present(env.MACHINE_CLIENT_KEY_ID) && { keyId: env.MACHINE_CLIENT_KEY_ID }),
    keyPem: env.MACHINE_CLIENT_KEY!,
  };
}

/** Gets, and reuses until shortly before it expires, a client-credentials token for people's API. */
export class MachineCaller {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly key: ReturnType<typeof importPKCS8>;
  private cached: { token: string; expiresAtMs: number } | undefined;

  constructor(
    private readonly settings: MachineCallerSettings,
    opts: MachineCallerOptions = {},
  ) {
    const loopback = opts.allowInsecureLoopback === true && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(settings.issuer);
    if (!loopback && !PERSON_ISSUER_RE.test(settings.issuer)) {
      throw new ConfigError("AUTH_ISSUER must be the sign-in tenant's issuer, https://<domain>/ in lower case with the final slash");
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.key = importPKCS8(settings.keyPem, "RS256");
    // An unusable key is reported when a token is first asked for, by name; never as an unhandled rejection.
    this.key.catch(() => undefined);
  }

  async token(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && nowMs < this.cached.expiresAtMs - REFRESH_MARGIN_S * 1000) return this.cached.token;
    const { issuer, audience, clientId, keyId } = this.settings;
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try {
      key = await this.key;
    } catch {
      throw new ConfigError("MACHINE_CLIENT_KEY is not a usable RS256 private key");
    }
    const iat = Math.floor(nowMs / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT", ...(keyId !== undefined && { kid: keyId }) })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(issuer)
      .setJti(randomBytes(32).toString("base64url"))
      .setIssuedAt(iat)
      .setExpirationTime(iat + ASSERTION_TTL_S)
      .sign(key);
    let res: Response;
    try {
      res = await this.fetchImpl(new URL("oauth/token", issuer), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          audience,
          client_id: clientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new Error("machine caller: the sign-in tenant could not be reached for a token");
    }
    if (res.status !== 200) throw new Error(`machine caller: the sign-in tenant refused the token request (HTTP ${res.status})`);
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error("machine caller: the sign-in tenant's answer was not JSON");
    }
    if (typeof body.access_token !== "string" || body.access_token.length === 0) throw new Error("machine caller: the sign-in tenant's answer carried no token");
    const lifetimeS = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : REFRESH_MARGIN_S;
    this.cached = { token: body.access_token, expiresAtMs: nowMs + lifetimeS * 1000 };
    return body.access_token;
  }
}

/**
 * Where a process that is not the hosted agent gets the caller's token it forwards (the command-line agent, the
 * smoke client): the machine caller's client when `MACHINE_CLIENT_ID` is set; otherwise, locally only, a ready-made
 * token in `CALLER_TOKEN` (a dev machine token, `npm run dev-token -- --service`); otherwise none, which is right
 * where L2 has no sign-in configured (the local scripted demo).
 */
export function callerTokenSourceFromEnv(env: Env, opts: MachineCallerOptions = {}): (() => Promise<string>) | undefined {
  const settings = machineCallerFromEnv(env);
  if (settings !== undefined) {
    const caller = new MachineCaller(settings, opts);
    return () => caller.token();
  }
  if (!present(env.CALLER_TOKEN)) return undefined;
  if ((env.NETWORK ?? "local") !== "local") throw new ConfigError("CALLER_TOKEN is allowed only with NETWORK=local: elsewhere set the machine caller's client");
  const token = env.CALLER_TOKEN;
  return async () => token;
}
