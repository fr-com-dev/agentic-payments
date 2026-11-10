// 013 portal access (SPEC.md §8.2 L2-8, §11 SEC-19, SEC-20; specs/013 contracts/portal-api.md "Access").
// Verifies the person's Entra ID access token before the body is read, then deletes it from the request so nothing
// downstream can forward it (the person's token authenticates to the portal only). The basic checks are shared with
// the hosted agent (src/shared/entra-token.ts); the portal adds its own: a person, not a system identity; a token
// issued for the portal, not for the agent service; the one permission, `Agent.Run`; and a sign-in time.
import type { RequestHandler } from "express";
import type { JWTVerifyGetKey } from "jose";
import { bearerToken, rolesOf, scopesOf, verifyEntraToken } from "../shared/entra-token.js";
import { userIdFor } from "../shared/user-id.js";
import { PORTAL_SCOPE_NAME } from "./config.js";

export const REQUIRED_ROLE = "Agent.Run";
const CLOCK_TOLERANCE_SEC = 60;

/** The signed-in person, as the rest of the portal sees them. No name, no email, no token. */
export interface Person {
  userId: string;
  /** When they last signed in interactively (the token's `auth_time`, in ms). L2 judges whether it is fresh enough. */
  identityConfirmedAtMs: number;
}

export interface AccessOptions {
  tenantId: string;
  audience: string;
  issuer: string;
  keys: JWTVerifyGetKey;
  /** The portal web app's client ID. */
  clientId: string;
  now?: () => number;
  /**
   * Test hook (T-PRT-01 must-fail): keep the basic token checks but skip the portal's own (user, scope, client, role,
   * sign-in time), so a token issued for the agent service gets in. Never set by the entry point.
   */
  bypassAuth?: boolean;
}

const unauthorized = { error: "unauthorized" };
const forbidden = { error: "forbidden" };

export function portalAccess(o: AccessOptions): RequestHandler {
  const now = o.now ?? Date.now;
  return async (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    const claims = token === null ? null : await verifyEntraToken(token, { ...o, clockToleranceSec: CLOCK_TOLERANCE_SEC });
    if (claims === null) {
      res.status(401).json(unauthorized);
      return;
    }
    if (o.bypassAuth) {
      res.locals.person = { userId: userIdFor(claims.tid, claims.oid), identityConfirmedAtMs: now() } satisfies Person;
      delete req.headers.authorization;
      next();
      return;
    }
    // 403: a valid token that is not allowed here. In order: a system identity; a token for another service (its
    // scope, then the client it was issued to); a person without the permission to start agent runs.
    if (
      claims.idtyp !== "user" ||
      !scopesOf(claims).includes(PORTAL_SCOPE_NAME) ||
      claims.azp !== o.clientId ||
      !rolesOf(claims).includes(REQUIRED_ROLE)
    ) {
      res.status(403).json(forbidden);
      return;
    }
    // A portal token with no usable sign-in time can't back a loosening change: it is not accepted at all.
    const authTime = claims.auth_time;
    if (typeof authTime !== "number" || !Number.isInteger(authTime) || authTime * 1000 > now() + CLOCK_TOLERANCE_SEC * 1000) {
      res.status(401).json(unauthorized);
      return;
    }
    const person: Person = { userId: userIdFor(claims.tid, claims.oid), identityConfirmedAtMs: authTime * 1000 };
    res.locals.person = person;
    delete req.headers.authorization;
    next();
  };
}
