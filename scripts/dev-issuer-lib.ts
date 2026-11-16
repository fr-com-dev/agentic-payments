// Local dev issuer for the hosted agent service, L2 and the portal (specs/011 contracts/access-and-sessions.md;
// specs/013 research R19; specs/016 research R13). It signs, with one local ES256 key and under one issuer name,
// the two kinds of token the sign-in tenant issues: a person's (`sub`, `permissions`, `azp`, the sign-in time
// claim) and a machine caller's (client credentials: `gty`, `sub` = `<client>@clients`, `azp`, `scope`).
// NETWORK=local only: the services refuse AUTH_JWKS_FILE on any other network.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { AGENT_RUN_PERMISSION, DEFAULT_AUTH_TIME_CLAIM, DEFAULT_MFA_TIME_CLAIM, DEV_ISSUER, PORTAL_ADMIN_PERMISSION } from "../src/shared/identity-token.js";
import { userIdFor } from "../src/shared/user-id.js";

/** The API's identifier with the dev issuer: `AUTH_AUDIENCE` of the agent service, of L2 and of the portal. */
export const DEV_AUDIENCE = "api://x402-l1-agent";
export const DEV_PERMISSION = AGENT_RUN_PERMISSION;
/** 016: the client of the dev issuer's machine caller (`--service`). Its `sub` is `<client>@clients`. */
export const DEV_MACHINE_CLIENT = "x402-checks-dev";
/** 014: the permission of a portal administrator. */
export const DEV_ADMIN_PERMISSION = PORTAL_ADMIN_PERMISSION;
/** The client a person's agent token comes from (`AGENT_CLIENT_IDS` in env/l1-hosted.env.example). */
export const DEV_AGENT_CLIENT = "x402-agent-cli-dev";
/** 013: the portal web app's client ID with the dev issuer (`PORTAL_CLIENT_ID` in env/portal.env.example). */
export const DEV_PORTAL_CLIENT = "x402-portal-dev";
/** A person's `sub` with the dev issuer, in the tenant's `<connection>|<id>` shape. */
export const devSubject = (subject: string) => `dev|${subject}`;
/** The user identifier both services compute for a dev issuer person (`--subject <name>`). */
export const devUserId = (subject: string) => userIdFor(DEV_ISSUER, devSubject(subject));
const ALG = "ES256";
const KID = "x402-dev-1";

export interface DevIssuer {
  dir: string;
  jwksPath: string;
  jwks: { keys: JWK[] };
  privateKey: CryptoKey | Uint8Array;
}

/** Loads the key pair from `dir`, creating it on first use. Refuses on any network but `local`. */
export async function loadOrCreateDevIssuer(dir = ".local/dev-issuer", env: NodeJS.ProcessEnv = process.env): Promise<DevIssuer> {
  if ((env.NETWORK ?? "local") !== "local") throw new Error("the dev issuer is for NETWORK=local only");
  const privPath = join(dir, "private.jwk.json");
  const jwksPath = join(dir, "jwks.json");
  if (!existsSync(privPath) || !existsSync(jwksPath)) {
    mkdirSync(dir, { recursive: true });
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    const priv = { ...(await exportJWK(privateKey)), kid: KID, alg: ALG };
    const pub = { ...(await exportJWK(publicKey)), kid: KID, alg: ALG, use: "sig" };
    writeFileSync(privPath, JSON.stringify(priv), { mode: 0o600 });
    chmodSync(privPath, 0o600);
    writeFileSync(jwksPath, JSON.stringify({ keys: [pub] }));
  }
  const priv = JSON.parse(readFileSync(privPath, "utf8")) as JWK;
  return {
    dir,
    jwksPath,
    jwks: JSON.parse(readFileSync(jwksPath, "utf8")) as { keys: JWK[] },
    privateKey: await importJWK(priv, ALG),
  };
}

export interface DevTokenOptions {
  /** A person's name (`sub` becomes `dev|<subject>`); for a machine caller, its client (default the dev machine client). */
  subject: string;
  /** A machine caller: a client-credentials token of the tenant's shape. Default: a person's token. */
  service?: boolean;

  // --- a person's token ---
  /** The API permissions (`permissions`). Default `["agent:run"]`; `null` omits the claim (tests only). */
  permissions?: string[] | null;
  /** The client the token was issued to. Default the agent CLI's client; `null` omits the claim (tests only). */
  azp?: string | null;
  /** The claim that names the client: `azp` (default) or `client_id`, the tenant's other token dialect. */
  clientClaim?: "azp" | "client_id";
  /** When the person last signed in, epoch seconds: the sign-in time claim. Absent: no claim. */
  authTime?: unknown;
  /** The name of the sign-in time claim. Default `https://x402.dev/auth_time`. */
  authTimeClaim?: string;
  /** 1.19: when the person last completed a second factor, epoch seconds (`https://x402.dev/mfa_time`). Absent: no claim. */
  mfaTime?: unknown;
  /** The whole `sub`, instead of `dev|<subject>`; `null` omits it (tests only). */
  sub?: string | null;

  // --- a machine caller's token ---
  /** The grant's scopes (`scope`). Default `agent:run`; `null` omits the claim (tests only). */
  scope?: string | null;
  /** The grant type claim (`gty`). Default `client-credentials`; `null` omits it, as the tenant's other dialect does. */
  gty?: string | null;

  // --- both ---
  audience?: string;
  issuer?: string;
  /** Lifetime from now, e.g. "1h". Ignored when `exp` is given. */
  expiresIn?: string;
  /** Absolute expiry, epoch seconds (for expired-token tests). */
  exp?: number;
  /** Absolute not-before, epoch seconds. */
  nbf?: number;
  /** More claims, set last (tests only). */
  claims?: Record<string, unknown>;
}

/**
 * Signs one access token. A person's (default): `sub` `dev|<subject>`, `permissions`, the client as `azp` and, when
 * `authTime` is given, the sign-in time claim. A machine caller's (`service`): `gty: client-credentials`, the
 * client as `azp`, `sub` `<client>@clients` and the grant's scopes in `scope` (and in `permissions` only when
 * given). Both come from the dev issuer for the API's audience.
 */
export async function signDevToken(issuer: Pick<DevIssuer, "privateKey">, o: DevTokenOptions): Promise<string> {
  let claims: Record<string, unknown>;
  let sub: string | null;
  if (o.service) {
    const client = o.azp === undefined ? o.subject : o.azp;
    const scope = o.scope === undefined ? DEV_PERMISSION : o.scope;
    const gty = o.gty === undefined ? "client-credentials" : o.gty;
    sub = o.sub === undefined ? `${o.subject}@clients` : o.sub;
    claims = {
      ...(gty !== null && { gty }),
      ...(client !== null && { [o.clientClaim ?? "azp"]: client }),
      ...(scope !== null && { scope }),
      ...(o.permissions !== undefined && o.permissions !== null && { permissions: o.permissions }),
    };
  } else {
    const permissions = o.permissions === undefined ? [DEV_PERMISSION] : o.permissions;
    const client = o.azp === undefined ? DEV_AGENT_CLIENT : o.azp;
    sub = o.sub === undefined ? devSubject(o.subject) : o.sub;
    claims = {
      ...(permissions !== null && { permissions }),
      ...(client !== null && { [o.clientClaim ?? "azp"]: client }),
      ...(o.authTime !== undefined && { [o.authTimeClaim ?? DEFAULT_AUTH_TIME_CLAIM]: o.authTime }),
      ...(o.mfaTime !== undefined && { [DEFAULT_MFA_TIME_CLAIM]: o.mfaTime }),
    };
  }
  const jwt = new SignJWT({ ...claims, ...o.claims })
    .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
    .setIssuer(o.issuer ?? DEV_ISSUER)
    .setAudience(o.audience ?? DEV_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? o.expiresIn ?? "1h");
  if (sub !== null) jwt.setSubject(sub);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(issuer.privateKey);
}
