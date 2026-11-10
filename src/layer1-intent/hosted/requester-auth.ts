// L1-6 requester access (SPEC.md §11 SEC-14; specs/011 contracts/access-and-sessions.md). Verifies an Entra
// ID v2.0 access token before the body is read. The requester's token authenticates to L1 only: it is
// deleted from the request after verification so nothing downstream can forward it (FR-009, INV-13).
// 013: the basic token checks are shared with the portal (src/shared/entra-token.ts), and this service now also
// refuses a token that was issued for the portal (SEC-20): a person's token must carry this service's scope, and
// must not come from the portal's web app.
import type { RequestHandler } from "express";
import type { JWTVerifyGetKey } from "jose";
import { bearerToken, keysFor as sharedKeysFor, rolesOf, scopesOf, verifyEntraToken } from "../../shared/entra-token.js";
import type { HostedConfig } from "./config.js";

export const REQUIRED_ROLE = "Agent.Run";
/** The delegated scope a person's token must carry to start a run (013, SEC-20). */
export const REQUIRED_SCOPE = "user_impersonation";

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
  /** 013 (SEC-20): the portal web app's client ID; a token whose `azp` equals it is refused. */
  portalClientId?: string;
  /** Test hook (T-AGT-07 must-fail): skip the scope and client checks. Never set by the entry point. */
  skipScopeCheck?: boolean;
}

const unauthorized = { error: "unauthorized" };
const forbidden = { error: "forbidden" };

/** The tenant's JWKS, or the dev issuer's local JWKS when `AUTH_JWKS_FILE` is set (local only). */
export function keysFor(config: Pick<HostedConfig, "auth">): JWTVerifyGetKey {
  return sharedKeysFor(config.auth);
}

export function requesterAuth(o: RequesterAuthOptions): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (token === null) {
      res.status(401).json(unauthorized);
      return;
    }
    const claims = await verifyEntraToken(token, o);
    if (claims === null) {
      res.status(401).json(unauthorized);
      return;
    }
    if (!rolesOf(claims).includes(REQUIRED_ROLE)) {
      res.status(403).json(forbidden);
      return;
    }
    // A system identity is an app-only token (`idtyp: app`). Anything else is a person's delegated token, which
    // must have been issued for this service (its scope) and not for the portal (its client).
    const kind: Requester["kind"] = claims.idtyp === "app" ? "service" : "user";
    if (kind === "user" && !o.skipScopeCheck) {
      const forPortal = o.portalClientId !== undefined && claims.azp === o.portalClientId;
      if (!scopesOf(claims).includes(REQUIRED_SCOPE) || forPortal) {
        res.status(403).json(forbidden);
        return;
      }
    }
    const requester: Requester = { tenantId: claims.tid, objectId: claims.oid, kind, key: `${claims.tid}:${claims.oid}` };
    res.locals.requester = requester;
    delete req.headers.authorization;
    next();
  };
}
