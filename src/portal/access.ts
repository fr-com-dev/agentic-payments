// 013 portal access (SPEC.md §8.2 L2-8, §11 SEC-19, SEC-20; specs/013 contracts/portal-api.md "Access").
// Verifies the person's Entra ID access token before the body is read, then deletes it from the request so nothing
// downstream can forward it (the person's token authenticates to the portal only). The basic checks are shared with
// the hosted agent (src/shared/entra-token.ts); the portal adds its own: a person, not a system identity; a token
// issued for the portal, not for the agent service; the one permission, `Agent.Run`; and a sign-in time.
// 014: with the administration area on, a second permission, `Portal.Admin`, also admits a person. The two are
// independent: `Agent.Run` opens the user's own routes, `Portal.Admin` the administration routes, and holding one
// never gives the other (FR-003).
import type { RequestHandler } from "express";
import type { JWTVerifyGetKey } from "jose";
import { bearerToken, rolesOf, scopesOf, verifyEntraToken } from "../shared/entra-token.js";
import { userIdFor } from "../shared/user-id.js";
import { PORTAL_SCOPE_NAME } from "./config.js";

export const REQUIRED_ROLE = "Agent.Run";
/** 014: the app role of a portal administrator. */
export const ADMIN_ROLE = "Portal.Admin";
const CLOCK_TOLERANCE_SEC = 60;

/** The signed-in person, as the rest of the portal sees them. No name, no email, no token. */
export interface Person {
  userId: string;
  /** When they last signed in interactively (the token's `auth_time`, in ms). L2 judges whether it is fresh enough. */
  identityConfirmedAtMs: number;
  /** 014: holds `Agent.Run`. Every route of 013 except /api/me requires it. */
  user: boolean;
  /** 014: holds `Portal.Admin` and the administration area is on. The /api/admin routes require it. */
  admin: boolean;
}

export interface AccessOptions {
  tenantId: string;
  audience: string;
  issuer: string;
  keys: JWTVerifyGetKey;
  /** The portal web app's client ID. */
  clientId: string;
  now?: () => number;
  /** 014: the administration area is on, so `Portal.Admin` counts. Off: only `Agent.Run` admits, as in 013. */
  adminEnabled?: boolean;
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
      res.locals.person = { userId: userIdFor(claims.tid, claims.oid), identityConfirmedAtMs: now(), user: true, admin: false } satisfies Person;
      delete req.headers.authorization;
      next();
      return;
    }
    // 403: a valid token that is not allowed here. In order: a system identity; a token for another service (its
    // scope, then the client it was issued to); a person with neither permission (014: to start agent runs, or,
    // with the administration area on, to administer).
    const roles = rolesOf(claims);
    const user = roles.includes(REQUIRED_ROLE);
    const admin = o.adminEnabled === true && roles.includes(ADMIN_ROLE);
    if (claims.idtyp !== "user" || !scopesOf(claims).includes(PORTAL_SCOPE_NAME) || claims.azp !== o.clientId || (!user && !admin)) {
      res.status(403).json(forbidden);
      return;
    }
    // A portal token with no usable sign-in time can't back a loosening change: it is not accepted at all.
    const authTime = claims.auth_time;
    if (typeof authTime !== "number" || !Number.isInteger(authTime) || authTime * 1000 > now() + CLOCK_TOLERANCE_SEC * 1000) {
      res.status(401).json(unauthorized);
      return;
    }
    const person: Person = { userId: userIdFor(claims.tid, claims.oid), identityConfirmedAtMs: authTime * 1000, user, admin };
    res.locals.person = person;
    delete req.headers.authorization;
    next();
  };
}

const personOf = (res: { locals: Record<string, unknown> }) => res.locals.person as Person | undefined;

/** 014: the routes of 013 are for people who may start agent runs. An administrator is not thereby a user (FR-006). */
export const requireUser: RequestHandler = (_req, res, next) => {
  if (personOf(res)?.user === true) next();
  else res.status(403).json(forbidden);
};

/**
 * 014: the administration routes are for administrators only (FR-002). The refusal is the same body as any other,
 * reveals nothing, and happens before L2 is called (FR-004). `skip` is the test hook of T-PRT-10's must-fail: without
 * this check, an ordinary user reaches the administration routes. Never set by the entry point.
 */
export function requireAdmin(o: { skip?: boolean } = {}): RequestHandler {
  return (_req, res, next) => {
    if (o.skip === true || personOf(res)?.admin === true) next();
    else res.status(403).json(forbidden);
  };
}
