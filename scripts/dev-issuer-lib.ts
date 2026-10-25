// Local dev issuer for the hosted agent service (specs/011 contracts/access-and-sessions.md). It signs
// Entra-shaped access tokens with a local ES256 key so the service and its tests run without Azure.
// NETWORK=local only: the service refuses AUTH_JWKS_FILE on any other network.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { DEV_ISSUER, DEV_TENANT } from "../src/layer1-intent/hosted/config.js";

export const DEV_AUDIENCE = "api://x402-l1-agent";
export const DEV_ROLE = "Agent.Run";
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
  roles?: string[];
  /** `app` marks a service identity (Entra `idtyp`). */
  idtyp?: "app" | "user";
  audience?: string;
  tenant?: string;
  issuer?: string;
  /** Lifetime from now, e.g. "1h". Ignored when `exp` is given. */
  expiresIn?: string;
  /** Absolute expiry, epoch seconds (for expired-token tests). */
  exp?: number;
  /** Absolute not-before, epoch seconds. */
  nbf?: number;
  /** Omit the `oid` claim (tests only). */
  omitOid?: boolean;
}

/** Signs an Entra-shaped v2.0 access token: `oid` = subject, `tid` = tenant, `roles`, optional `idtyp`. */
export async function signDevToken(issuer: Pick<DevIssuer, "privateKey">, o: DevTokenOptions): Promise<string> {
  const claims: Record<string, unknown> = {
    tid: o.tenant ?? DEV_TENANT,
    roles: o.roles ?? [DEV_ROLE],
    ...(o.omitOid ? {} : { oid: o.subject }),
    ...(o.idtyp !== undefined && { idtyp: o.idtyp }),
  };
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
    .setSubject(o.subject)
    .setIssuer(o.issuer ?? DEV_ISSUER)
    .setAudience(o.audience ?? DEV_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? o.expiresIn ?? "1h");
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(issuer.privateKey);
}
