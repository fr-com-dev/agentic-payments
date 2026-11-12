// Local dev issuer for the hosted agent service and the portal (specs/011 contracts/access-and-sessions.md;
// specs/013 research R19). It signs, with one local ES256 key, the two kinds of token the services accept: a
// person's token in the shape of the Auth0 tenant's (`sub`, `permissions`, `azp`, the sign-in time claim), and a
// system identity's token in the shape of the organization's directory (Entra: `tid`, `oid`, `idtyp: app`, `roles`),
// each under its own issuer name. NETWORK=local only: the services refuse AUTH_JWKS_FILE on any other network.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import {
  AGENT_RUN_PERMISSION,
  DEFAULT_AUTH_TIME_CLAIM,
  DEV_DIRECTORY_ISSUER,
  DEV_ISSUER,
  DEV_TENANT,
  PORTAL_ADMIN_PERMISSION,
  SERVICE_ROLE,
} from "../src/shared/identity-token.js";
import { userIdFor } from "../src/shared/user-id.js";

/** The API's identifier with the dev issuer: `AUTH_AUDIENCE` of the agent service and of the portal. */
export const DEV_AUDIENCE = "api://x402-l1-agent";
/** The audience of a system identity's token with the dev issuer: `SERVICE_AUDIENCE` of the agent service. */
export const DEV_SERVICE_AUDIENCE = "api://x402-l1-agent-service";
export const DEV_ROLE = SERVICE_ROLE;
export const DEV_PERMISSION = AGENT_RUN_PERMISSION;
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
  subject: string;
  /** A system identity: an Entra-shaped app-only token from the dev directory issuer. Default: a person's token. */
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
  /** The whole `sub`, instead of `dev|<subject>`; `null` omits it (tests only). */
  sub?: string | null;

  // --- a system identity's token ---
  /** The app roles (`roles`). Default `["Agent.Run"]`. */
  roles?: string[];
  /** Entra `idtyp`. Default `app`; `user` or `null` (omitted) make a person's directory token (tests only). */
  idtyp?: "app" | "user" | null;
  tenant?: string;
  /** Omit the `oid` claim (tests only). */
  omitOid?: boolean;

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
 * `authTime` is given, the sign-in time claim, from the dev issuer for the API's audience. A system identity's
 * (`service`): `tid`, `oid` = subject, `idtyp: app` and `roles`, from the dev directory issuer for the service
 * audience.
 */
export async function signDevToken(issuer: Pick<DevIssuer, "privateKey">, o: DevTokenOptions): Promise<string> {
  let claims: Record<string, unknown>;
  let sub: string | null;
  if (o.service) {
    const idtyp = o.idtyp === undefined ? "app" : o.idtyp;
    sub = o.sub === undefined ? o.subject : o.sub;
    claims = {
      tid: o.tenant ?? DEV_TENANT,
      roles: o.roles ?? [DEV_ROLE],
      ...(o.omitOid ? {} : { oid: o.subject }),
      ...(idtyp !== null && { idtyp }),
    };
  } else {
    const permissions = o.permissions === undefined ? [DEV_PERMISSION] : o.permissions;
    const client = o.azp === undefined ? DEV_AGENT_CLIENT : o.azp;
    sub = o.sub === undefined ? devSubject(o.subject) : o.sub;
    claims = {
      ...(permissions !== null && { permissions }),
      ...(client !== null && { [o.clientClaim ?? "azp"]: client }),
      ...(o.authTime !== undefined && { [o.authTimeClaim ?? DEFAULT_AUTH_TIME_CLAIM]: o.authTime }),
    };
  }
  const jwt = new SignJWT({ ...claims, ...o.claims })
    .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
    .setIssuer(o.issuer ?? (o.service ? DEV_DIRECTORY_ISSUER : DEV_ISSUER))
    .setAudience(o.audience ?? (o.service ? DEV_SERVICE_AUDIENCE : DEV_AUDIENCE))
    .setIssuedAt()
    .setExpirationTime(o.exp ?? o.expiresIn ?? "1h");
  if (sub !== null) jwt.setSubject(sub);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(issuer.privateKey);
}
