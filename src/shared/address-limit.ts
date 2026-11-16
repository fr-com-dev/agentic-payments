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
