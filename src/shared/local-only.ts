// 017 the loopback rule (SPEC.md §8.1 L1-6, §8.2 L2-8; specs/017 research R2, R3). One definition of "this request
// comes from the machine itself", shared by the portal and the hosted agent. It decides where HSTS is sent (any host
// name but a loopback one gets it) and keeps the local dev sign-in (`AUTH_JWKS_FILE`) on the machine: with it, a
// service binds a loopback address only, trusts no proxy, and answers 421 to any request that names another host or
// carries a forwarding header. The rule reads the raw `Host` header and the headers' names only: never a token, a
// body or the socket's address (behind a proxy on the same machine, that address is loopback for everyone).
import type { IncomingHttpHeaders } from "node:http";
import type { RequestHandler } from "express";

/** The headers a proxy adds. Any one of them means the request came through a proxy. */
export const FORWARDING_HEADERS: readonly string[] = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "via"];

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const PORT_RE = /^\d{1,5}$/;

/**
 * True when a `Host` header names this machine: `localhost` (any case, with or without the final dot),
 * `127.0.0.1` or `[::1]`, each with or without a port. Anything else is false, an empty or missing header included,
 * so a request whose host can't be told is treated as public (fail closed, spec NFR-004).
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === "") return false;
  let name: string;
  let rest: string;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    name = host.slice(1, end);
    rest = host.slice(end + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon >= 0 && host.indexOf(":", colon + 1) >= 0) return false; // an unbracketed IPv6 address is not a Host
    name = colon < 0 ? host : host.slice(0, colon);
    rest = colon < 0 ? "" : host.slice(colon);
  }
  if (rest !== "" && !(rest.startsWith(":") && PORT_RE.test(rest.slice(1)))) return false;
  name = name.toLowerCase();
  if (name === "localhost.") name = "localhost";
  // A bracketed name must be an IPv6 address: `[localhost]` and `[127.0.0.1]` are not host names.
  if (host.startsWith("[")) return name === "::1";
  return name !== "::1" && LOOPBACK_NAMES.has(name);
}

/** True for a bind address that only this machine can reach: `127.0.0.1`, `::1` or `localhost`. */
export function isLoopbackBind(address: string): boolean {
  return LOOPBACK_NAMES.has(address.toLowerCase());
}

/** True when any forwarding header is present, whatever its case or value. */
export function hasForwardingHeader(headers: IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((name) => FORWARDING_HEADERS.includes(name.toLowerCase()));
}

const misdirected = { error: "misdirected request" };

/**
 * The dev sign-in's request check (spec FR-005, research R3): served only when the `Host` header is a loopback name
 * and no forwarding header is present; anything else gets 421 before any route, without reading `Authorization` or
 * the body. The answer never says why, nor that a dev sign-in exists.
 */
export function localOnly(): RequestHandler {
  return (req, res, next) => {
    if (isLoopbackHost(req.headers.host) && !hasForwardingHeader(req.headers)) {
      next();
      return;
    }
    res.status(421).json(misdirected);
  };
}
