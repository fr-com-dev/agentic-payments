// L1-6 requester access (SPEC.md §11 SEC-14; specs/011 contracts/access-and-sessions.md). Verifies an Entra
// ID v2.0 access token before the body is read. The requester's token authenticates to L1 only: it is
// deleted from the request after verification so nothing downstream can forward it (FR-009, INV-13).
import { readFileSync } from "node:fs";
import type { RequestHandler } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { HostedConfig } from "./config.js";

export const REQUIRED_ROLE = "Agent.Run";

export interface Requester {
  tenantId: string;
  objectId: string;
  kind: "user" | "service";
  /** `tid:oid`, the key for limits, sessions and logs. */
  key: string;
}

export interface RequesterAuthOptions {
  tenantId: string;
  audience: string;
  issuer: string;
  keys: JWTVerifyGetKey;
  clockToleranceSec?: number;
}

const unauthorized = { error: "unauthorized" };
const forbidden = { error: "forbidden" };

/** The tenant's JWKS, or the dev issuer's local JWKS when `AUTH_JWKS_FILE` is set (local only). */
export function keysFor(config: Pick<HostedConfig, "auth">): JWTVerifyGetKey {
  if (config.auth.jwksFile !== undefined) {
    return createLocalJWKSet(JSON.parse(readFileSync(config.auth.jwksFile, "utf8")));
  }
  return createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.auth.tenantId}/discovery/v2.0/keys`));
}

export function requesterAuth(o: RequesterAuthOptions): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match) {
      res.status(401).json(unauthorized);
      return;
    }
    let claims: Record<string, unknown>;
    try {
      const { payload } = await jwtVerify(match[1]!, o.keys, {
        issuer: o.issuer,
        audience: o.audience,
        clockTolerance: o.clockToleranceSec ?? 60,
        requiredClaims: ["exp"],
      });
      claims = payload as Record<string, unknown>;
    } catch {
      res.status(401).json(unauthorized);
      return;
    }
    const tid = claims.tid;
    const oid = claims.oid;
    if (tid !== o.tenantId || typeof oid !== "string" || oid.length === 0) {
      res.status(401).json(unauthorized);
      return;
    }
    const roles = Array.isArray(claims.roles) ? claims.roles : [];
    if (!roles.includes(REQUIRED_ROLE)) {
      res.status(403).json(forbidden);
      return;
    }
    const requester: Requester = { tenantId: tid, objectId: oid, kind: claims.idtyp === "app" ? "service" : "user", key: `${tid}:${oid}` };
    res.locals.requester = requester;
    delete req.headers.authorization;
    next();
  };
}
