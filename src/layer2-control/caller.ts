// L2-5 the caller's token (SPEC.md §8.2 L2-5, L2-8, §11 SEC-20, SEC-32, SEC-33; specs/016 contracts/control-api.md).
// The hosted agent forwards, beside its own role token, the access token its caller presented. L2 verifies that
// token here, itself, with the check the agent ran (`verifyCaller`), and takes the user from it: a payment request
// can no longer name a user, so L1's word alone spends nobody's account.
// - The token is read from one header, on the authorize and budget routes only, after the role token was accepted.
//   It opens nothing by itself (INV-13).
// - It is verified before the body is parsed and before the serialized section. Verification may fetch the
//   tenant's keys; nothing inside the section does (hard rule 5).
// - Nothing here stores, logs or returns the token. What stays, for the length of the request, is the forwarded
//   identity: the user and, for a phone approval (L2-7), the subject.
// Rule A14 keeps the header's name in this file and in src/layer1-intent/ports-http.ts.
import type { RequestHandler, Response } from "express";
import { ConfigError } from "../shared/config.js";
import { bearerToken, DEV_ISSUER, PERSON_ISSUER_RE, personKeys, verifyCaller, type CallerCheckName, type TokenKeys } from "../shared/identity-token.js";
import { userIdFor } from "../shared/user-id.js";

type Env = Record<string, string | undefined>;

/** The header the hosted agent forwards the caller's token in: `Bearer <token>`. */
export const CALLER_HEADER = "x-caller-authorization";

/** The four settings (CFG-2). Sign-in is configured at L2 exactly when this exists. */
export interface CallerSettings {
  /** The sign-in tenant's issuer; locally the dev issuer. */
  issuer: string;
  /** People's API's identifier. */
  audience: string;
  /** The clients a person's token may come from: the agent's. Never the portal's. */
  clientIds: string[];
  /** Local only: the dev issuer's keys. */
  jwksFile?: string;
}

export interface CallerDeps extends Omit<CallerSettings, "jwksFile">, TokenKeys {
  clockToleranceSec?: number;
  /** Test hook (T-CTK-03 must-fail): take the user from the request, as before 016. Never set by main(). */
  trustIntentUser?: boolean;
  /** Test hook (T-CTK-05 must-fail): accept a request without a caller's token. Never set by main(). */
  skipRequired?: boolean;
  /** Test hook (T-CTK-01 must-fail): accept a person's token from any client, the portal's included. Never set by main(). */
  skipClientCheck?: boolean;
  /** Test hook (T-CTK-01 must-fail): accept a caller without the permission. Never set by main(). */
  skipPermission?: boolean;
  /** Test hook (T-CTK-07 must-fail): write the token to the log. Never set by main(). */
  echoCaller?: boolean;
}

/** Who the verified token is, as L2 uses it. `none`: sign-in is not configured and no token came. */
export type ForwardedIdentity = { kind: "person"; userId: string; subject: string } | { kind: "machine" } | { kind: "none" };

const NONE: ForwardedIdentity = { kind: "none" };
const present = (v: string | undefined): v is string => v !== undefined && v !== "";
const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const SETTINGS = ["AUTH_ISSUER", "AUTH_AUDIENCE", "AGENT_CLIENT_IDS"] as const;

/**
 * The settings from the environment, or undefined when sign-in is not configured. All three variables or none.
 * Errors name the variable and never its value. No network call.
 */
export function callerSettingsFromEnv(env: Env, network: string): CallerSettings | undefined {
  const given = SETTINGS.filter((name) => present(env[name]));
  const jwksFile = present(env.AUTH_JWKS_FILE) ? env.AUTH_JWKS_FILE : undefined;
  if (jwksFile !== undefined && network !== "local") throw new ConfigError("AUTH_JWKS_FILE is allowed only with NETWORK=local");
  if (given.length === 0) {
    if (jwksFile !== undefined) throw new ConfigError("AUTH_JWKS_FILE needs AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS (SPEC L2-5)");
    return undefined;
  }
  if (given.length !== SETTINGS.length) {
    throw new ConfigError("AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS go together: set all three to verify callers' tokens, or none");
  }
  const issuer = env.AUTH_ISSUER!;
  if (jwksFile !== undefined && issuer !== DEV_ISSUER) throw new ConfigError(`AUTH_ISSUER must be ${DEV_ISSUER} with AUTH_JWKS_FILE (the local dev issuer)`);
  if (jwksFile === undefined && !PERSON_ISSUER_RE.test(issuer)) {
    throw new ConfigError("AUTH_ISSUER must be the sign-in tenant's issuer, https://<domain>/ in lower case with the final slash");
  }
  const clientIds = env.AGENT_CLIENT_IDS!.split(",").map((c) => c.trim());
  if (clientIds.some((c) => !CLIENT_ID_RE.test(c))) throw new ConfigError("AGENT_CLIENT_IDS must be a comma-separated list of client IDs");
  // SEC-20: a token the portal's web app obtained never pays for a run, so its client can't be on the list.
  if (present(env.PORTAL_CLIENT_ID) && clientIds.includes(env.PORTAL_CLIENT_ID)) {
    throw new ConfigError("AGENT_CLIENT_IDS must not contain PORTAL_CLIENT_ID: L2 never accepts a portal token as a caller's");
  }
  return { issuer, audience: env.AUTH_AUDIENCE!, clientIds, ...(jwksFile !== undefined && { jwksFile }) };
}

/** The settings and the keys to verify with: the tenant's JWKS, or the dev issuer's file. No network call yet. */
export function callerDepsFor(settings: CallerSettings): CallerDeps {
  const { jwksFile, ...rest } = settings;
  return { ...rest, ...personKeys({ issuer: settings.issuer, ...(jwksFile !== undefined && { jwksFile }) }) };
}

/** The forwarded identity `callerAuth` left on this response. */
export const forwardedIdentityOf = (res: Response): ForwardedIdentity => (res.locals.caller as ForwardedIdentity | undefined) ?? NONE;

/**
 * The checks of specs/016 contracts/control-api.md "Order of checks", rows 2 to 6. Mounted after `requireRole` and
 * before the body parser. `deps` absent: sign-in is not configured, so a token is not accepted and none is needed.
 */
export function callerAuth(deps: CallerDeps | undefined, o: { usersOn: boolean }): RequestHandler {
  const refuse = (res: Response, status: 400 | 401 | 403, error: string) => {
    res.status(status).json({ error });
  };
  const skipChecks: CallerCheckName[] = [
    ...(deps?.skipClientCheck ? (["client"] as const) : []),
    ...(deps?.skipPermission ? (["permission"] as const) : []),
  ];
  return async (req, res, next) => {
    const header = req.headers[CALLER_HEADER];
    if (deps === undefined) {
      if (header !== undefined) return refuse(res, 400, "caller_token_not_accepted");
      res.locals.caller = NONE;
      return next();
    }
    const token = bearerToken(header);
    if (token === null) {
      if (!deps.skipRequired || header !== undefined) return refuse(res, 401, "caller_token_required");
      res.locals.caller = NONE;
      return next();
    }
    if (deps.echoCaller) console.log(`l2-control: caller ${token}`);
    const checked = await verifyCaller(token, {
      issuer: deps.issuer,
      audience: deps.audience,
      clientIds: deps.clientIds,
      keys: deps.keys,
      algorithms: deps.algorithms,
      ...(deps.clockToleranceSec !== undefined && { clockToleranceSec: deps.clockToleranceSec }),
      ...(skipChecks.length > 0 && { skipChecks }),
    });
    if (!checked.ok) {
      if (checked.status === 403) return refuse(res, 403, "caller_forbidden");
      return refuse(res, 401, checked.reason === "expired" ? "caller_token_expired" : "caller_token_invalid");
    }
    const { caller } = checked;
    if (caller.kind === "machine") {
      res.locals.caller = { kind: "machine" } satisfies ForwardedIdentity;
      return next();
    }
    // A person pays from their own account or not at all (hard rule 11): with user accounts off there is none.
    if (!o.usersOn) return refuse(res, 403, "caller_forbidden");
    let userId: string;
    try {
      userId = userIdFor(caller.issuer, caller.subject);
    } catch {
      return refuse(res, 401, "caller_token_invalid");
    }
    res.locals.caller = { kind: "person", userId, subject: caller.subject } satisfies ForwardedIdentity;
    next();
  };
}
