// 013 portal access (SPEC.md §8.2 L2-8, §11 SEC-19, SEC-20; specs/013 contracts/portal-api.md "Access").
// Verifies the person's access token before the body is read, then deletes it from the request so nothing downstream
// can forward it (the person's token authenticates to the portal only). People sign in with the Auth0 tenant
// (research R19); the basic checks are shared with the hosted agent (src/shared/identity-token.ts). The portal adds
// its own: a token issued to the portal's client, not to an agent client; the one permission, `agent:run`; and a
// sign-in time. A token of any other issuer, the organization's directory included, is not valid here at all.
import type { RequestHandler } from "express";
import { AGENT_RUN_PERMISSION, bearerToken, signInTimeOf, verifyPersonToken, type TokenKeys } from "../shared/identity-token.js";
import { userIdFor } from "../shared/user-id.js";

export const REQUIRED_PERMISSION = AGENT_RUN_PERMISSION;

/** The signed-in person, as the rest of the portal sees them. No name, no email, no token. */
export interface Person {
  userId: string;
  /** When they last signed in interactively (the token's sign-in time claim, in ms). L2 judges whether it is fresh enough. */
  identityConfirmedAtMs: number;
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
  /**
   * Test hook (T-PRT-01 must-fail): keep the basic token checks but skip the portal's own (client, permission,
   * sign-in time), so a token issued for the agent service gets in. Never set by the entry point.
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
      res.locals.person = { userId, identityConfirmedAtMs: now() } satisfies Person;
      delete req.headers.authorization;
      next();
      return;
    }
    // 403: a valid token that is not allowed here. In order: a token another client obtained (an agent client's, so
    // a token meant for the agent service); a person without the permission to start agent runs.
    if (person.client !== o.clientId || !person.permissions.includes(REQUIRED_PERMISSION)) return refuse(403);
    // Last: a portal token with no usable sign-in time can't back a loosening change, so it is not accepted at all.
    const signedInAt = signInTimeOf(person, now());
    if (signedInAt === null) return refuse(401);
    res.locals.person = { userId, identityConfirmedAtMs: signedInAt * 1000 } satisfies Person;
    delete req.headers.authorization;
    next();
  };
}
