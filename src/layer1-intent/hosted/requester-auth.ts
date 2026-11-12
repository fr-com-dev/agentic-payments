// L1-6 requester access (SPEC.md §11 SEC-14; specs/011 contracts/access-and-sessions.md; specs/013 research R19).
// Verifies the access token before the body is read. The requester's token authenticates to L1 only: it is deleted
// from the request after verification so nothing downstream can forward it (FR-009, INV-13).
// Two issuers. A person signs in with the Auth0 tenant: the token needs the `agent:run` permission and must come
// from a client on this service's allow-list, which never holds the portal's client (SEC-20). A system identity
// comes from the organization's directory (Entra): an app-only token with the `Agent.Run` app role, and it never
// names a user. The token's `iss` is read first, unverified, only to choose which of the two sets of checks runs;
// the checks themselves are shared with the portal (src/shared/identity-token.ts).
import type { RequestHandler } from "express";
import {
  AGENT_RUN_PERMISSION,
  bearerToken,
  issuerOf,
  personKeys,
  SERVICE_ROLE,
  serviceKeys,
  verifyPersonToken,
  verifyServiceToken,
  type TokenKeys,
} from "../../shared/identity-token.js";
import { issuerHost } from "../../shared/user-id.js";
import type { HostedConfig } from "./config.js";

/** The app role a system identity needs. */
export const REQUIRED_ROLE = SERVICE_ROLE;
/** The permission a person needs (013: the one permission, the same as the portal's). */
export const REQUIRED_PERMISSION = AGENT_RUN_PERMISSION;

export interface Requester {
  kind: "user" | "service";
  /** Who vouches for the requester: the token's issuer for a person, the directory's tenant for a system identity. */
  authority: string;
  /** The token's `sub` for a person, its `oid` for a system identity. */
  subject: string;
  /** The key for limits and logs: `<issuer host>:<sub>` or `<tid>:<oid>`. */
  key: string;
}

export interface RequesterKeys {
  /** Absent: no person is accepted. */
  person?: TokenKeys;
  /** Absent: no system identity is accepted. */
  service?: TokenKeys;
}

export interface RequesterAuthOptions {
  /** Absent: no person is accepted. */
  person?: { issuer: string; audience: string; clientIds: readonly string[] };
  /** Absent: no system identity is accepted. */
  service?: { tenantId: string; audience: string; issuer: string };
  keys: RequesterKeys;
  clockToleranceSec?: number;
  /** Test hook (T-AGT-07 must-fail): skip the client allow-list. Never set by the entry point. */
  skipClientCheck?: boolean;
}

const unauthorized = { error: "unauthorized" };
const forbidden = { error: "forbidden" };

/** The two issuers' keys: each tenant's JWKS, or the dev issuer's local JWKS when `AUTH_JWKS_FILE` is set (local only). */
export function keysFor(config: Pick<HostedConfig, "auth">): RequesterKeys {
  const { person, service, jwksFile } = config.auth;
  const file = jwksFile !== undefined ? { jwksFile } : {};
  return {
    ...(person !== undefined && { person: personKeys({ issuer: person.issuer, ...file }) }),
    ...(service !== undefined && { service: serviceKeys({ tenantId: service.tenantId, ...file }) }),
  };
}

export function requesterAuth(o: RequesterAuthOptions): RequestHandler {
  const tolerance = o.clockToleranceSec !== undefined ? { clockToleranceSec: o.clockToleranceSec } : {};
  return async (req, res, next) => {
    const refuse = (status: 401 | 403) => {
      res.status(status).json(status === 401 ? unauthorized : forbidden);
    };
    const token = bearerToken(req.headers.authorization);
    if (token === null) return refuse(401);
    // Unverified: it only chooses the checks. Each verifier then checks the signature and the issuer itself.
    const claimedIssuer = issuerOf(token);
    let requester: Requester;
    if (o.person !== undefined && o.keys.person !== undefined && claimedIssuer === o.person.issuer) {
      const checked = await verifyPersonToken(token, { issuer: o.person.issuer, audience: o.person.audience, ...o.keys.person, ...tolerance });
      if (!checked.ok) return refuse(checked.status);
      const person = checked.token;
      if (!person.permissions.includes(REQUIRED_PERMISSION)) return refuse(403);
      // The client allow-list: a token the portal's web app obtained is not on it (SEC-20).
      if (!o.skipClientCheck && (person.client === null || !o.person.clientIds.includes(person.client))) return refuse(403);
      requester = { kind: "user", authority: person.issuer, subject: person.subject, key: `${issuerHost(person.issuer)}:${person.subject}` };
    } else if (o.service !== undefined && o.keys.service !== undefined && claimedIssuer === o.service.issuer) {
      const checked = await verifyServiceToken(token, { ...o.service, ...o.keys.service, ...tolerance });
      if (!checked.ok) return refuse(checked.status);
      const service = checked.token;
      if (!service.roles.includes(REQUIRED_ROLE)) return refuse(403);
      requester = { kind: "service", authority: service.tenantId, subject: service.objectId, key: `${service.tenantId}:${service.objectId}` };
    } else {
      return refuse(401);
    }
    res.locals.requester = requester;
    delete req.headers.authorization;
    next();
  };
}
