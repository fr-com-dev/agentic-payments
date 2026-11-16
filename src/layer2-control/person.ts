// 1.19 the person behind a portal request (SPEC.md §8.2 L2-5, L2-8, §11 SEC-35; Phase 3 findings #5 and #6). Before
// 1.19, L2 took the person on the portal's word: the user in the path, the time of their sign-in in the body, and, for
// an administrator's decision, who decided. Whoever held the portal's role token could therefore act for any user,
// pass any step-up, and approve any payment as any administrator. Now the portal forwards the person's own access
// token, unchanged, beside its role token, and L2 verifies it here, itself, with the portal's own checks:
// - the tenant's signature, issuer, audience, validity and a usable `sub` (401), not a machine token and issued to the
//   portal's client (403), and a sign-in time that is not in the future (401);
// - the user is `userIdFor(issuer, sub)`, never a value of the request: a path's `:userId` must be that user (403);
// - the step-up time is the token's sign-in time; for an administrator's approval, the token's second-factor time;
// - the administration routes need the permission `portal:admin` in the token (403).
// The token opens nothing by itself: without the role token the answer is 401 before the header is looked at. It is
// never stored, logged, echoed or written to the ledger. Rule A17 keeps the header's name in this file and in
// src/portal/person-context.ts.
import type { RequestHandler, Response } from "express";
import { ConfigError } from "../shared/config.js";
import {
  bearerToken,
  CLOCK_TOLERANCE_SEC,
  DEFAULT_AUTH_TIME_CLAIM,
  epochSecondsOf,
  PORTAL_ADMIN_PERMISSION,
  verifyPersonToken,
  type TokenKeys,
} from "../shared/identity-token.js";
import { userIdFor } from "../shared/user-id.js";

/** The header the portal forwards the person's token in: `Bearer <token>`. */
export const PERSON_HEADER = "x-person-authorization";

/**
 * Requests a minute, from one address, that L2 verifies a person's token for. Every portal request reaches L2 from
 * the portal's one address (300 a minute per client address there, many clients), so the bound is wide: it stops a
 * faulty or compromised portal, not a person.
 */
export const MAX_PERSON_CHECKS_PER_MINUTE = 6_000;

export interface PersonDeps extends TokenKeys {
  /** The sign-in tenant's issuer (L2's `AUTH_ISSUER`). */
  issuer: string;
  /** People's API (L2's `AUTH_AUDIENCE`). */
  audience: string;
  /** The portal's client (`PORTAL_CLIENT_ID`): the only client whose tokens these routes accept. */
  portalClientId: string;
  /** The sign-in time claim (`AUTH_TIME_CLAIM`, default `https://x402.dev/auth_time`). */
  authTimeClaim?: string;
  clockToleranceSec?: number;
  /** Test hook (1.19 must-fail, T-PER-01): take the person from the request, as before 1.19. Never set by main(). */
  skipPersonCheck?: boolean;
  /** Test hook: a lower bound on checks a minute. Never set by main(). */
  maxChecksPerMinute?: number;
}

/** The person L2 verified for this request. */
export interface VerifiedPerson {
  userId: string;
  /** The token's sign-in time, in ms: the step-up time of a loosening change (SEC-21). */
  identityConfirmedAtMs: number;
  /** The token's second-factor time, in ms, when it has one: an administrator's approval needs it fresh (SEC-35). */
  mfaConfirmedAtMs?: number;
  /** Holds `portal:admin`. */
  admin: boolean;
}

type Env = Record<string, string | undefined>;
const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;

/** The portal's client and the sign-in time claim from the environment. Needed with user accounts (main()). */
export function personSettingsFromEnv(env: Env): { portalClientId: string; authTimeClaim?: string } {
  const portalClientId = env.PORTAL_CLIENT_ID ?? "";
  if (!CLIENT_ID_RE.test(portalClientId)) {
    throw new ConfigError("USER_ACCOUNTS=1 needs PORTAL_CLIENT_ID (SPEC L2-8, 1.19): L2 verifies the person's portal token itself");
  }
  const claim = env.AUTH_TIME_CLAIM;
  return { portalClientId, ...(claim !== undefined && claim !== "" && { authTimeClaim: claim }) };
}

/** The person `personAuth` left on this response. Present on every route it guards. */
export const verifiedPersonOf = (res: Response): VerifiedPerson => res.locals.person as VerifiedPerson;

/**
 * Mounted after the route's role guard and before its body parser. `admin`: the administration routes, which also
 * need `portal:admin`. A refusal decides nothing and appends nothing.
 */
export function personAuth(deps: PersonDeps, o: { admin?: boolean; now: () => number }): RequestHandler {
  const refuse = (res: Response, status: 401 | 403, error: string) => {
    res.status(status).json({ error });
  };
  return async (req, res, next) => {
    if (deps.skipPersonCheck) {
      // The must-fail proof: the person is whoever the request says.
      const userId = String(req.params.userId ?? "");
      res.locals.person = { userId, identityConfirmedAtMs: o.now(), mfaConfirmedAtMs: o.now(), admin: true } satisfies VerifiedPerson;
      return next();
    }
    const token = bearerToken(req.headers[PERSON_HEADER]);
    if (token === null) return refuse(res, 401, "person_token_required");
    const checked = await verifyPersonToken(token, {
      issuer: deps.issuer,
      audience: deps.audience,
      keys: deps.keys,
      algorithms: deps.algorithms,
      ...(deps.authTimeClaim !== undefined && { authTimeClaim: deps.authTimeClaim }),
      clockToleranceSec: deps.clockToleranceSec ?? CLOCK_TOLERANCE_SEC,
    });
    if (!checked.ok) return refuse(res, checked.status, checked.status === 401 ? "person_token_invalid" : "person_forbidden");
    const t = checked.token;
    if (t.client !== deps.portalClientId) return refuse(res, 403, "person_forbidden");
    const nowMs = o.now();
    const signedInAt = epochSecondsOf(t.signInTime, nowMs);
    if (signedInAt === null) return refuse(res, 401, "person_token_invalid");
    const admin = t.permissions.includes(PORTAL_ADMIN_PERMISSION);
    if (o.admin && !admin) return refuse(res, 403, "person_forbidden");
    let userId: string;
    try {
      userId = userIdFor(t.issuer, t.subject);
    } catch {
      return refuse(res, 401, "person_token_invalid");
    }
    const mfaAt = epochSecondsOf(t.mfaTime, nowMs);
    res.locals.person = {
      userId,
      identityConfirmedAtMs: signedInAt * 1000,
      ...(mfaAt !== null && { mfaConfirmedAtMs: mfaAt * 1000 }),
      admin,
    } satisfies VerifiedPerson;
    next();
  };
}

export { DEFAULT_AUTH_TIME_CLAIM };
