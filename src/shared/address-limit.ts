// A limit on requests per client address, for the two public services (the hosted agent and the portal): SEC-14,
// SEC-19. L2 uses the same limiter for its costly checks: the ledger check of the administration area (014) and of
// the operator (1.19), the check of a caller's token on the authorize and budget routes (016) and of a person's
// portal token on the user and administration routes (1.19); L3 for settlement claims and the local facilitator for
// its requests (1.19). On the public services it runs before the bearer token is verified, so a caller without a
// valid token can't make a service verify signatures without bound; the per-person limits each service applies after
// authentication stay as they are. Pass it to a route as a direct argument before the check it bounds, never inside
// an array: CodeQL (js/missing-rate-limiting) recognizes it only there. Counters are held in memory by the replica.
// Behind the Azure ingress the client's address is the last entry of X-Forwarded-For, which Express reads only when
// TRUSTED_PROXY_HOPS says how many proxies to trust.
import type { Express, Request, RequestHandler, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { ConfigError } from "./config.js";
import { hasForwardingHeader } from "./local-only.js";

/** Requests one address may make in a minute before it gets 429. Above any one person's own limit: people share addresses. */
export const MAX_REQUESTS_PER_ADDRESS = 300;
const WINDOW_MS = 60_000;
/** The Azure ingress is one proxy. More would let a caller's own X-Forwarded-For entries name its address. */
const MAX_HOPS = 1;

/** `TRUSTED_PROXY_HOPS`: how many reverse proxies stand in front of the service: 0 (the default) or 1, behind the Azure ingress. */
export function trustedProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === "") return 0;
  if (!/^\d$/.test(raw) || Number.parseInt(raw, 10) > MAX_HOPS) throw new ConfigError(`TRUSTED_PROXY_HOPS must be 0 or ${MAX_HOPS}`);
  return Number.parseInt(raw, 10);
}

/** Makes Express take the client's address from X-Forwarded-For, through exactly `hops` proxies. 0 leaves the socket's address. */
export function trustProxies(app: Express, hops: number | undefined): void {
  if (hops !== undefined && hops > 0) app.set("trust proxy", hops);
}

/** The limiter. Each call has its own counters, so each app instance (and each test) starts from zero. */
export function addressLimit(o: { max?: number } = {}): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: o.max ?? MAX_REQUESTS_PER_ADDRESS,
    // Only Retry-After is sent, by the handler below: no counters in headers.
    standardHeaders: false,
    legacyHeaders: false,
    // The proxy setting is explicit configuration here (TRUSTED_PROXY_HOPS), so the library's own warning about a
    // forwarded header it wasn't told to trust would only add an unstructured line to the service's log.
    validate: { xForwardedForHeader: false },
    handler: (req: Request, res: Response) => {
      const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const seconds = reset ? Math.ceil((reset.getTime() - Date.now()) / 1000) : WINDOW_MS / 1000;
      res.set("Retry-After", String(Math.max(1, seconds))).status(429).json({ error: "too many requests" });
    },
  });
}

/** 017: failed authentications (401s) one address may get in a minute before every API request from it gets 429. */
export const MAX_FAILED_AUTH_PER_ADDRESS = 20;

/** Seconds until a window ends, at least 1, from the limiter's request info. */
const retryAfter = (reset: Date | undefined): string =>
  String(Math.max(1, reset ? Math.ceil((reset.getTime() - Date.now()) / 1000) : WINDOW_MS / 1000));

/**
 * 017 (SEC-45, research R4): a limit on the answers a service gives with 401, per client address, with its own
 * counters. Every request is counted when it arrives and taken off again when it ends with anything but 401, so only
 * failed authentications stay counted. Over the limit, every request from the address gets the same 429 as
 * `addressLimit` until its window ends, before any token is read. Mount it right after `addressLimit` and before the
 * token check, as a direct argument (CodeQL's js/missing-rate-limiting). `onLimit` is told the client key and the
 * window's end for each refused request; it must not log the key (spec FR-009).
 */
export function failedAuthLimit(o: { onLimit?: (key: string, resetMs: number) => void } = {}): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: MAX_FAILED_AUTH_PER_ADDRESS,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 401,
    // Its own property on the request, so it never overwrites `addressLimit`'s.
    requestPropertyName: "failedAuthLimit",
    standardHeaders: false,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: (req: Request, res: Response) => {
      const info = (req as Request & { failedAuthLimit?: { key: string; resetTime?: Date } }).failedAuthLimit;
      const reset = info?.resetTime;
      if (info !== undefined && o.onLimit) o.onLimit(info.key, reset?.getTime() ?? Date.now() + WINDOW_MS);
      res.set("Retry-After", retryAfter(reset)).status(429).json({ error: "too many requests" });
    },
  });
}

/**
 * 017: true the first time a key is seen for a window (its reset time), false for the rest of that window. Keys
 * whose window has ended are dropped on each call, so the record stays as small as the addresses refused right now.
 */
export function onceInWindow(now: () => number = Date.now): (key: string, resetMs: number) => boolean {
  const logged = new Map<string, number>();
  return (key, resetMs) => {
    const t = now();
    for (const [k, r] of logged) if (r <= t) logged.delete(k);
    if (logged.get(key) === resetMs) return false;
    logged.set(key, resetMs);
    return true;
  };
}

/**
 * 017 (research R5): with no proxy declared (`hops` 0), the first request that carries a forwarding header makes
 * `onProxied` run, once per service instance: a proxy in front that nobody declared makes every client share the
 * proxy's address, and so its per-address counts. It never refuses: the request goes on as usual.
 */
export function proxyWarning(hops: number, onProxied: (req: Request, res: Response) => void): RequestHandler {
  let warned = false;
  return (req, res, next) => {
    if (!warned && hops === 0 && hasForwardingHeader(req.headers)) {
      warned = true;
      onProxied(req, res);
    }
    next();
  };
}
