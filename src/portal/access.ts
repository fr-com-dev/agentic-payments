// 013 portal access (SPEC.md §8.2 L2-8, §11 SEC-19, SEC-20; specs/013 contracts/portal-api.md "Access").
// Verifies the person's access token before the body is read, then deletes it from the request so nothing downstream
// can forward it (the person's token authenticates to the portal only). People sign in with the Auth0 tenant
// (research R19); the basic checks are shared with the hosted agent (src/shared/identity-token.ts). The portal adds
// its own: a token issued to the portal's client, not to an agent client, and a sign-in time. It asks for no
// permission and no role (research R21): whoever signs in through the portal's client may use the portal, for their
// own account only. A token of any other issuer, the organization's directory included, is not valid here at all.
// 014: the administration area is the one thing that needs a permission, `portal:admin`, which an administrator of
// the tenant gives to a person by hand; it is read here and nowhere else.
import type { RequestHandler } from "express";
import { bearerToken, PORTAL_ADMIN_PERMISSION, signInTimeOf, verifyPersonToken, type TokenKeys } from "../shared/identity-token.js";

/** 014: the permission that opens the administration area. The only permission the portal reads. */
export const ADMIN_PERMISSION = PORTAL_ADMIN_PERMISSION;
import { userIdFor } from "../shared/user-id.js";

/** The signed-in person, as the rest of the portal sees them. No name, no email, no token. */
export interface Person {
  userId: string;
  /** When they last signed in interactively (the token's sign-in time claim, in ms). L2 judges whether it is fresh enough. */
  identityConfirmedAtMs: number;
  /** 014: holds `portal:admin` and the administration area is on. The /api/admin routes require it. */
  admin: boolean;
}

export interface AccessOptions {
  /** The Auth0 tenant's issuer (or the dev issuer's), exactly as tokens carry it. */
  issuer: string;
  /** The API's identifier. */
  audience: string;
  keys: TokenKeys;
  /** The portal web app's client ID: the only client whose tokens are accepted. */
  clientId: string;
  /** The access-token claim that holds the time of the person's last sign-in. */
  authTimeClaim?: string;
  now?: () => number;
  /** 014: the administration area is on, so `portal:admin` counts. Off: no permission is read at all, as in 013. */
  adminEnabled?: boolean;
  /**
   * Test hook (T-PRT-01 must-fail): keep the basic token checks but skip the portal's own (client, sign-in time),
   * so a token issued for the agent service gets in. Never set by the entry point.
   */
  bypassAuth?: boolean;
}

const unauthorized = { error: "unauthorized" };
const forbidden = { error: "forbidden" };

export function portalAccess(o: AccessOptions): RequestHandler {
  const now = o.now ?? Date.now;
  return async (req, res, next) => {
    const refuse = (status: 401 | 403) => {
      res.status(status).json(status === 401 ? unauthorized : forbidden);
    };
    const token = bearerToken(req.headers.authorization);
    if (token === null) return refuse(401);
    // 401: not a valid token of the sign-in tenant. 403 from here: a machine token (a system identity).
    const checked = await verifyPersonToken(token, {
      issuer: o.issuer,
      audience: o.audience,
      ...o.keys,
      ...(o.authTimeClaim !== undefined && { authTimeClaim: o.authTimeClaim }),
    });
    if (!checked.ok) return refuse(checked.status);
    const person = checked.token;
    const userId = userIdFor(person.issuer, person.subject);
    if (o.bypassAuth) {
      res.locals.person = { userId, identityConfirmedAtMs: now(), admin: false } satisfies Person;
      delete req.headers.authorization;
      next();
      return;
    }
    // 403: a valid token that is not allowed here: one another client obtained (an agent client's, so a token meant
    // for the agent service). The permissions in the token are not read: the portal needs none (research R21).
    if (person.client !== o.clientId) return refuse(403);
    // Last: a portal token with no usable sign-in time can't back a loosening change, so it is not accepted at all.
    const signedInAt = signInTimeOf(person, now());
    if (signedInAt === null) return refuse(401);
    // 014: every signed-in person is a user. An administrator is one whose token also carries the permission.
    const admin = o.adminEnabled === true && person.permissions.includes(ADMIN_PERMISSION);
    res.locals.person = { userId, identityConfirmedAtMs: signedInAt * 1000, admin } satisfies Person;
    delete req.headers.authorization;
    next();
  };
}

/**
 * 014: the administration routes are for administrators only (FR-002). The refusal is the same body as any other,
 * reveals nothing, and happens before L2 is called (FR-004). `skip` is the test hook of T-PRT-10's must-fail: without
 * this check, an ordinary user reaches the administration routes. Never set by the entry point.
 */
export function requireAdmin(o: { skip?: boolean } = {}): RequestHandler {
  return (_req, res, next) => {
    if (o.skip === true || (res.locals.person as Person | undefined)?.admin === true) next();
    else res.status(403).json(forbidden);
  };
}
