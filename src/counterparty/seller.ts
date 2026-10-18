// Seller API (SPEC.md CP-1, CP-3). A simulated external party: an x402 v2 resource server with a free
// catalog and four priced routes, each offering exactly one `exact` option priced as an explicit
// AssetAmount (never a "$" string), so the asset and its EIP-712 domain come from the network profile.
import { pathToFileURL } from "node:url";
import express from "express";
import type { FacilitatorClient, RouteConfig, RoutesConfig } from "@x402/core/server";
import {
  ExpressAdapter,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  ConfigError,
  facilitatorChoice,
  loadEnv,
  networkProfile,
  sellerPort,
  SELLER_BIND_HOST,
  type NetworkProfile,
} from "../shared/config.js";
import {
  CategorizedFacilitatorClient,
  categorize,
  facilitatorClientFor,
  failureDetail,
  type FailureHook,
} from "./facilitator-client.js";
import {
  CDP_AUTH_HINT,
  cdpCredentialsFromEnv,
  cdpCredentialsPresent,
  cdpFacilitatorClient,
  keyIdSuffix,
  makeRedactor,
  validateCdpSecret,
  type CdpCredential,
} from "./cdp-facilitator.js";

export interface CatalogItem {
  /** Route path as advertised in the catalog (weather shows its query parameter). */
  path: string;
  route: string;
  priceAtomic: string;
  description: string;
}

/** CP-1 price list. Adding a route here changes the scripted plan: update SPEC L1-4 and T-E2E-01 too. */
export const CATALOG: readonly CatalogItem[] = [
  { path: "/api/weather?city=", route: "/api/weather", priceAtomic: "1000", description: "current weather for a city" },
  { path: "/api/market-brief", route: "/api/market-brief", priceAtomic: "5000", description: "daily market brief" },
  { path: "/api/premium-report", route: "/api/premium-report", priceAtomic: "50000", description: "premium research report" },
  { path: "/api/dataset-export", route: "/api/dataset-export", priceAtomic: "500000", description: "full dataset export" },
];

const SOURCE = "mock-seller (deterministic)";
const CONDITIONS = ["sunny", "cloudy", "rain", "fog"] as const;

/** Deterministic mock weather: seed = sum of the city's char codes (research R4). */
export function weatherBody(city: string) {
  let seed = 0;
  for (const ch of city) seed += ch.codePointAt(0)!;
  return { city, tempC: seed % 35, condition: CONDITIONS[seed % 4]!, source: SOURCE };
}

/** One payment option per route; the query string never affects the price. */
export function sellerRoutes(net: NetworkProfile, payTo: string): Record<string, RouteConfig> {
  const routes: Record<string, RouteConfig> = {};
  for (const item of CATALOG) {
    routes[`GET ${item.route}`] = {
      description: item.description,
      mimeType: "application/json",
      accepts: {
        scheme: "exact",
        network: net.caip2,
        payTo,
        maxTimeoutSeconds: 120,
        price: { asset: net.asset, amount: item.priceAtomic, extra: { ...net.assetDomain } },
      },
    };
  }
  return routes;
}

/**
 * The facilitator when the caller passes none (tests, harness): the profile's URL with the SDK default
 * timeout, as before v1.2. `main()` always passes the CP-3 choice explicitly.
 */
export function defaultFacilitator(net: NetworkProfile): CategorizedFacilitatorClient {
  return facilitatorClientFor({ kind: net.name === "local" ? "local" : "public", url: net.facilitatorUrl, authenticated: false });
}

const identity = (s: string) => s;

/** One stderr line per facilitator failure (contracts/seller-errors.md); excerpts are redacted first. */
export function facilitatorFailureLogger(redact: (s: string) => string = identity, authHint?: string): FailureHook {
  return (category, operation, err) => {
    console.error(`seller: facilitator ${category} during ${operation}: ${redact(failureDetail(err)).slice(0, 200)}`);
    if (authHint && category === "authentication") console.error(`seller: facilitator authentication — ${authHint}`);
  };
}

export interface PaymentMiddlewareOptions {
  facilitator?: FacilitatorClient;
  redact?: (s: string) => string;
  /** Appended to `authentication` failure logs (the CDP clock/credential hint). */
  authHint?: string;
}

/**
 * The x402 middleware with a lazy, retrying facilitator sync. The SDK's own startup sync is turned off:
 * if the facilitator starts after the seller, the first priced request would fail instead of retrying.
 * Here every priced request waits for a successful `/supported` sync, a failed sync is retried on the
 * next request, and while the facilitator fails the seller answers 503 with its category (CP-1 v1.2),
 * never a bogus 402.
 */
export function sellerPaymentMiddleware(
  net: NetworkProfile,
  routes: RoutesConfig,
  opts: PaymentMiddlewareOptions = {},
): express.RequestHandler {
  const facilitator = opts.facilitator ?? defaultFacilitator(net);
  const log = facilitatorFailureLogger(opts.redact, opts.authHint);
  // Verify/settle failures are logged by the client hook; /supported failures by the sync catch below.
  if (facilitator instanceof CategorizedFacilitatorClient) {
    facilitator.setFailureHook((category, operation, err) => {
      if (operation !== "supported") log(category, operation, err);
    });
  }
  const resourceServer = new x402ResourceServer(facilitator).register(net.caip2, new ExactEvmScheme());
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  const x402 = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);
  let synced: Promise<void> | null = null;
  const sync = () => {
    synced ??= httpServer.initialize().catch((err: unknown) => {
      synced = null;
      throw err;
    });
    return synced;
  };
  return async (req, res, next) => {
    const priced = httpServer.requiresPayment({
      adapter: new ExpressAdapter(req),
      path: req.path,
      method: req.method,
    });
    if (!priced) return next();
    try {
      await sync();
    } catch (err) {
      const category = categorize(err);
      log(category, "supported", err);
      res.status(503).json({ error: `facilitator ${category}`, category });
      return;
    }
    return x402(req, res, next);
  };
}

/** GET /api/catalog. Must be mounted BEFORE the payment middleware (research R3). */
export function mountCatalog(app: express.Express, net: NetworkProfile): void {
  app.get("/api/catalog", (_req, res) => {
    res.json({
      network: net.caip2,
      asset: net.asset,
      decimals: net.decimals,
      items: CATALOG.map(({ path, priceAtomic, description }) => ({ path, priceAtomic, description })),
    });
  });
}

/** Handlers for the priced routes. They only run after the middleware verified a payment. */
export function mountPaidHandlers(app: express.Express): void {
  app.get("/api/weather", (req, res) => {
    const city = typeof req.query.city === "string" && req.query.city.length > 0 ? req.query.city : "Lima";
    res.json(weatherBody(city));
  });
  app.get("/api/market-brief", (_req, res) => {
    res.json({
      headline: "Stablecoin settlement volumes steady",
      bullets: ["USDC supply unchanged week on week", "Base L2 fees remain sub-cent", "Agentic commerce pilots expand"],
      source: SOURCE,
    });
  });
  app.get("/api/premium-report", (_req, res) => {
    res.json({ title: "Agentic payments: three-layer control", pages: 42, source: SOURCE });
  });
  app.get("/api/dataset-export", (_req, res) => {
    res.json({ rows: 1_000_000, source: SOURCE });
  });
}

export interface SellerOptions extends PaymentMiddlewareOptions {
  net: NetworkProfile;
  payTo: string;
}

/** The seller app: catalog first, then the x402 middleware, then the paid handlers. */
export function createSellerApp({ net, payTo, ...middleware }: SellerOptions): express.Express {
  const app = express();
  mountCatalog(app, net);
  app.use(sellerPaymentMiddleware(net, sellerRoutes(net, payTo), middleware));
  mountPaidHandlers(app);
  return app;
}

function fail(message: string): never {
  console.error(`seller: ${message}`);
  process.exit(1);
}

/** Startup validation order (contracts/seller-config.md): choice, CDP key ID, secret, secret parses, payTo. */
async function main(): Promise<void> {
  loadEnv("seller");
  const net = networkProfile();
  let choice: ReturnType<typeof facilitatorChoice>;
  try {
    choice = facilitatorChoice(net);
  } catch (err) {
    fail(`invalid facilitator config: ${err instanceof ConfigError ? err.message : "unreadable configuration"}`);
  }

  let cred: CdpCredential | undefined;
  if (choice.kind === "cdp") {
    try {
      cred = cdpCredentialsFromEnv(process.env);
      await validateCdpSecret(cred);
    } catch (err) {
      // Only the fixed ConfigError messages from cdp-facilitator.ts are printed, never library text.
      fail(err instanceof ConfigError ? err.message : "invalid CDP credentials");
    }
  } else if (cdpCredentialsPresent(process.env)) {
    console.error(`seller: CDP credentials set but unused (FACILITATOR=${choice.kind})`);
  }

  const payTo = process.env.SELLER_PAY_TO;
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) fail("SELLER_PAY_TO must be set to a 0x address (env/seller.env)");

  const facilitator = cred
    ? facilitatorClientFor(choice, { cdp: cdpFacilitatorClient(cred) })
    : facilitatorClientFor(choice);
  const app = createSellerApp({
    net,
    payTo,
    facilitator,
    ...(cred && { redact: makeRedactor(cred), authHint: CDP_AUTH_HINT }),
  });
  const port = sellerPort();
  const keyNote = cred ? ` key=${keyIdSuffix(cred)}` : "";
  app.listen(port, SELLER_BIND_HOST, () => {
    console.log(
      `seller listening on ${SELLER_BIND_HOST}:${port} (${net.caip2}, facilitator=${choice.kind} host=${new URL(choice.url).host}${keyNote})`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
