// 013 the portal: the Express app (SPEC.md §8.2 L2-8; specs/013 contracts/portal-api.md). It serves the web app's
// static files and the JSON API under /api to browsers. It is the second public process after the agent service, and
// it holds no payment key: the entry point that loads env and refuses when one is visible is src/portal-main.ts.
// Order per request: headers → health and public config → access (401/403) → limits (429) → body (400/413) → route.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { TokenKeys } from "../shared/identity-token.js";
import { portalAccess, requireAdmin, type Person } from "./access.js";
import type { AdminPort } from "./admin-client.js";
import { mountPortalAdminRoutes } from "./admin-routes.js";
import { mountPortalApiDocs } from "./api-docs.js";
import type { BalanceCache } from "./balance.js";
import { CARD_VAULT_CSP, type CardVault } from "./card-vault.js";
import { Cards } from "./cards.js";
import { addressLimit, trustProxies } from "../shared/address-limit.js";
import type { PortalConfig } from "./config.js";
import type { ControlPort } from "./control-client.js";
import { createPortalLog } from "./log.js";
import type { ProfileStore } from "./profile-store.js";
import { mountPortalRoutes } from "./routes.js";

export const MAX_REQUESTS_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

export interface PortalDeps {
  config: PortalConfig;
  keys: TokenKeys;
  control: ControlPort;
  profiles: ProfileStore;
  balance: BalanceCache;
  /** The card vault client. Absent: cards are off. */
  vault?: CardVault;
  /** 014: the administration client. Absent: the administration area is off and /api/admin is not mounted. */
  admin?: AdminPort;
  /** 014 test hook (T-PRT-10 must-fail): see requireAdmin. Never set by the entry point. */
  skipAdminCheck?: boolean;
  now?: () => number;
  /** Where log lines go (default: stdout, one JSON line each). */
  log?: (line: string) => void;
  /** Test hook (T-PRT-01 must-fail): see portalAccess. Never set by the entry point. */
  bypassAuth?: boolean;
  /** Test hooks (T-PRT-01): another limit per address, or none at all (the must-fail). Never set by the entry point. */
  maxRequestsPerAddress?: number;
  skipAddressLimit?: boolean;
}

export interface PortalApp {
  app: Express;
  markReady(): void;
}

/**
 * The policy every page and API answer carries (contracts/portal-api.md "Limits and headers"). `signInOrigin` is the
 * sign-in tenant's origin: the web app calls it for tokens (the code exchange and the refresh-token renewal). The
 * tenant is never framed: sign-in is a pop-up, and there is no hidden-frame renewal. Absent with the dev issuer,
 * where sign-in is a pasted token.
 */
export function contentSecurityPolicy(o: { signInOrigin?: string } = {}): string {
  const signIn = o.signInOrigin !== undefined ? ` ${o.signInOrigin}` : "";
  return [
    "default-src 'none'",
    `script-src 'self' ${CARD_VAULT_CSP.script.join(" ")}`,
    `frame-src ${CARD_VAULT_CSP.frame.join(" ")}`,
    `connect-src 'self' ${CARD_VAULT_CSP.connect.join(" ")}${signIn}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** `https://<domain>` of the sign-in tenant, for the policy. Undefined with the dev issuer. */
export function signInOriginOf(auth: Pick<PortalConfig["auth"], "mode" | "issuer">): string | undefined {
  return auth.mode === "auth0" ? new URL(auth.issuer).origin : undefined;
}

export function createPortalApp(deps: PortalDeps): PortalApp {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const log = createPortalLog(deps.log);
  const app = express();
  app.disable("x-powered-by");
  trustProxies(app, deps.config.trustedProxyHops);
  let ready = false;
  const personOf = (res: Response) => res.locals.person as Person | undefined;
  const signInOrigin = signInOriginOf(config.auth);
  const csp = contentSecurityPolicy({ ...(signInOrigin !== undefined && { signInOrigin }) });

  // Headers and the request log, on everything.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = now();
    const api = req.originalUrl.startsWith("/api");
    res.set("Content-Security-Policy", csp);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    if (config.network !== "local") res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (api) res.set("Cache-Control", "no-store");
    res.on("finish", () => {
      const person = personOf(res);
      const event = res.locals.event as string | undefined;
      log({
        time: new Date(started).toISOString(),
        // The route template, never the concrete path: an identifier in a URL stays out of the log.
        route: (req.route as { path?: string } | undefined)?.path ?? (req.originalUrl.startsWith("/api") ? "/api/*" : "static"),
        status: res.statusCode,
        ms: now() - started,
        ...(person && { userId: person.userId }),
        ...(event !== undefined && { event }),
      });
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    if (ready) res.json({ status: "ready" });
    else res.status(503).json({ status: "starting" });
  });
  // API_DOCS=1 only (SEC-13): Swagger UI and the document, token-free like the health routes, so before access.
  if (config.apiDocs) mountPortalApiDocs(app);

  // Public values the web app needs before anyone signs in. Nothing here is a secret.
  app.get("/api/config", (_req, res) => {
    res.json({
      auth: {
        mode: config.auth.mode,
        // The tenant's domain, for the sign-in library. Empty with the dev issuer, which has none.
        domain: config.auth.mode === "auth0" ? new URL(config.auth.issuer).host : "",
        clientId: config.auth.clientId,
        audience: config.auth.audience,
      },
      network: config.network,
      cards: { available: deps.vault !== undefined, ...(deps.vault && { publishableKey: deps.vault.publishableKey }) },
      // 014: whether the administration area is on. Who may use it is decided from the person's token, not here.
      admin: { available: deps.admin !== undefined },
    });
  });

  const access = portalAccess({
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    keys: deps.keys,
    clientId: config.auth.clientId,
    authTimeClaim: config.auth.authTimeClaim,
    now,
    ...(deps.admin !== undefined && { adminEnabled: true }),
    ...(deps.bypassAuth && { bypassAuth: true }),
  });

  // 120 requests a minute per person, per replica.
  const recent = new Map<string, number[]>();
  const limit = (_req: Request, res: Response, next: NextFunction) => {
    const key = personOf(res)!.userId;
    const t = now();
    const list = (recent.get(key) ?? []).filter((s) => t - s < WINDOW_MS);
    if (list.length >= MAX_REQUESTS_PER_MINUTE) {
      recent.set(key, list);
      res.set("Retry-After", String(Math.max(1, Math.ceil((list[0]! + WINDOW_MS - t) / 1000)))).status(429).json({ error: "too many requests" });
      return;
    }
    list.push(t);
    recent.set(key, list);
    next();
  };

  const cards = deps.vault ? new Cards({ vault: deps.vault, profiles: deps.profiles, control: deps.control, now }) : undefined;
  // Per address first, before any token is verified: a caller without a valid token is bounded too (SEC-19).
  // Then access and the per-person limit, before every /api route below (the routes carry their full paths).
  if (!deps.skipAddressLimit) app.use("/api", addressLimit({ ...(deps.maxRequestsPerAddress !== undefined && { max: deps.maxRequestsPerAddress }) }));
  app.use("/api", access, limit);
  // 014: the administration half first, behind its own permission. Off: nothing is mounted and /api/admin is 404.
  if (deps.admin !== undefined) {
    app.use("/api/admin", requireAdmin({ ...(deps.skipAdminCheck && { skip: true }) }));
    mountPortalAdminRoutes(app, { admin: deps.admin, now });
  }
  mountPortalRoutes(app, { control: deps.control, profiles: deps.profiles, balance: deps.balance, ...(cards && { cards }), now });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // The web app: built files, and index.html for any other path (the app routes in the browser).
  const webRoot = resolve(config.webRoot);
  const indexFile = join(webRoot, "index.html");
  if (existsSync(indexFile)) {
    const index = readFileSync(indexFile, "utf8");
    app.use(express.static(webRoot, { index: false, redirect: false }));
    app.get(/.*/, (_req, res) => {
      res.type("html").send(index);
    });
  }
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Body parser errors: 413 over the limit, 400 for anything unparsable. Never echo the body.
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status === 413 || err.type === "entity.too.large" ? 413 : 400;
    res.status(status).json({ error: status === 413 ? "body too large" : "malformed JSON body" });
  });

  return {
    app,
    markReady: () => {
      ready = true;
    },
  };
}
