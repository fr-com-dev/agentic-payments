// L1-6 requester access (SPEC.md §11 SEC-14, SEC-20; specs/016 contracts/hosted-agent-api.md "Who is accepted").
// Verifies the access token before the body is read. One issuer, the sign-in tenant, and one check, shared with L2
// (`verifyCaller` in src/shared/identity-token.ts): a person needs the permission `agent:run` and a client on this
// service's list, which never holds the portal's client; a machine caller needs that permission from its grant.
// 016: the token is kept for the run, beside the requester, because L1 forwards it to L2 with each payment request
// and budget question. Only the run route reads it, and it goes to `gate.forCaller` and nowhere else: never to L3,
// the model, a step, a log line or the answer (SEC-32).
// 019 (specs/019 FR-020..022): every 401 keeps the DAST remediation's challenge and adds `error_code`, the one thing a
// client needs to choose what to do next: `missing_token` (send one), `token_expired` (renew), `invalid_token` (sign
// in again). Nothing tells two invalid tokens apart: no description, no claim value, no key ID.
import type { RequestHandler, Response } from "express";
import { AGENT_RUN_PERMISSION, bearerChallenge, bearerToken, personKeys, verifyCaller, type CallerCheckName, type TokenKeys } from "../../shared/identity-token.js";
import { issuerHost } from "../../shared/user-id.js";
import type { HostedConfig } from "./config.js";

/** The permission every caller needs. */
export const REQUIRED_PERMISSION = AGENT_RUN_PERMISSION;

export interface Requester {
  /** `user`: a person. `service`: a machine caller. */
  kind: "user" | "service";
  /** Who vouches for the requester: the token's issuer. */
  authority: string;
  /** The token's `sub`: a person's own, or `<client>@clients` for a machine caller. */
  subject: string;
  /** The key for limits and logs: `<issuer host>:<sub>`. */
  key: string;
  /** 019: the client the token was issued to (a person's `azp`/`client_id`, a machine caller's own), for the run log only. */
  client: string;
}

export interface RequesterAuthOptions {
  issuer: string;
  audience: string;
  clientIds: readonly string[];
  keys: TokenKeys;
  clockToleranceSec?: number;
  /** Test hook (T-AGT-07 must-fail): skip the client allow-list. Never set by the entry point. */
  skipClientCheck?: boolean;
  /** Test hook (T-AGT-09 must-fail): skip the permission. Never set by the entry point. */
  skipPermission?: boolean;
  /**
   * Test hook (T-AGT-16 must-fail, 019): a 401 for an invalid token describes what the token claims, so two invalid
   * tokens get different answers. Never set by the entry point.
   */
  revealCheck?: boolean;
}

/** 019: the reason a 401 gives, beside `error: "unauthorized"` (FR-021). */
export type UnauthorizedCode = "missing_token" | "token_expired" | "invalid_token";
export const unauthorizedBody = (error_code: UnauthorizedCode) => ({ error: "unauthorized", error_code });
const forbidden = { error: "forbidden" };

/** The leak `revealCheck` stands for: the claims a refused token carries, in the answer (tests only). */
function describeClaims(token: string): string {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return `issuer ${String(claims.iss)}, audience ${JSON.stringify(claims.aud)}, subject ${JSON.stringify(claims.sub)}`;
  } catch {
    return "not a token";
  }
}
/** 017: the realm of the agent's bearer challenge. */
export const AGENT_REALM = "x402-agent";

/** The tenant's JWKS, or the dev issuer's local JWKS when `AUTH_JWKS_FILE` is set (local only). */
export function keysFor(config: Pick<HostedConfig, "auth">): TokenKeys {
  const { issuer, jwksFile } = config.auth;
  return personKeys({ issuer, ...(jwksFile !== undefined && { jwksFile }) });
}

/** The verified requester of this request, set by `requesterAuth`. */
export const requesterOf = (res: Response): Requester | undefined => res.locals.requester as Requester | undefined;
/** The caller's token of this request, for `gate.forCaller` only. */
export const callerTokenOf = (res: Response): string | undefined => res.locals.callerToken as string | undefined;

export function requesterAuth(o: RequesterAuthOptions): RequestHandler {
  const skipChecks: CallerCheckName[] = [...(o.skipClientCheck ? (["client"] as const) : []), ...(o.skipPermission ? (["permission"] as const) : [])];
  return async (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (token === null) {
      // 017 (FR-024): every 401 says how to authenticate. 019: and why, in `error_code`.
      res.set("WWW-Authenticate", bearerChallenge(AGENT_REALM, false)).status(401).json(unauthorizedBody("missing_token"));
      return;
    }
    const checked = await verifyCaller(token, {
      issuer: o.issuer,
      audience: o.audience,
      clientIds: o.clientIds,
      ...o.keys,
      ...(o.clockToleranceSec !== undefined && { clockToleranceSec: o.clockToleranceSec }),
      ...(skipChecks.length > 0 && { skipChecks }),
    });
    if (!checked.ok) {
      if (checked.status === 403) {
        res.status(403).json(forbidden);
        return;
      }
      // 019: an expiry is reported only when signature, issuer and audience passed (jose checks them first), so
      // `token_expired` tells a client to renew; every other failure is the same `invalid_token`.
      const body = unauthorizedBody(checked.reason === "expired" ? "token_expired" : "invalid_token");
      res.set("WWW-Authenticate", bearerChallenge(AGENT_REALM, true)).status(401).json(o.revealCheck ? { ...body, detail: describeClaims(token) } : body);
      return;
    }
    const { caller } = checked;
    const requester: Requester = {
      kind: caller.kind === "person" ? "user" : "service",
      authority: caller.issuer,
      subject: caller.subject,
      key: `${issuerHost(caller.issuer)}:${caller.subject}`,
      client: caller.client,
    };
    res.locals.requester = requester;
    res.locals.callerToken = token;
    next();
  };
}
