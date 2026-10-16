// Seller API (SPEC.md CP-1, CP-3). A simulated external party: an x402 v2 resource server with a free
// catalog and four priced routes, each offering exactly one `exact` option priced as an explicit
// AssetAmount (never a "$" string), so the asset and its EIP-712 domain come from the network profile.
import { pathToFileURL } from "node:url";
import express from "express";
import { HTTPFacilitatorClient, type RouteConfig, type RoutesConfig } from "@x402/core/server";
import {
  ExpressAdapter,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { loadEnv, networkProfile, sellerPort, SELLER_BIND_HOST, type NetworkProfile } from "../shared/config.js";

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

/** CP-3: verify and settle always go to the profile's facilitator (local :4022 or the hosted one). */
export function facilitatorClientFor(net: NetworkProfile): HTTPFacilitatorClient {
  return new HTTPFacilitatorClient({ url: net.facilitatorUrl });
}

/**
 * The x402 middleware with a lazy, retrying facilitator sync. The SDK's own startup sync is turned off:
 * if the facilitator starts after the seller, the first priced request would fail instead of retrying.
 * Here every priced request waits for a successful `/supported` sync, a failed sync is retried on the
 * next request, and while the facilitator is unreachable the seller answers 503 (never a bogus 402).
 */
export function sellerPaymentMiddleware(net: NetworkProfile, routes: RoutesConfig): express.RequestHandler {
  const resourceServer = new x402ResourceServer(facilitatorClientFor(net)).register(net.caip2, new ExactEvmScheme());
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
      res.status(503).json({ error: "facilitator unavailable", detail: String(err).slice(0, 200) });
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

export interface SellerOptions {
  net: NetworkProfile;
  payTo: string;
}

/** The seller app: catalog first, then the x402 middleware, then the paid handlers. */
export function createSellerApp({ net, payTo }: SellerOptions): express.Express {
  const app = express();
  mountCatalog(app, net);
  app.use(sellerPaymentMiddleware(net, sellerRoutes(net, payTo)));
  mountPaidHandlers(app);
  return app;
}

function main(): void {
  loadEnv("seller");
  const net = networkProfile();
  const payTo = process.env.SELLER_PAY_TO;
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    console.error("seller: SELLER_PAY_TO must be set to a 0x address (env/seller.env)");
    process.exit(1);
  }
  const port = sellerPort();
  createSellerApp({ net, payTo }).listen(port, SELLER_BIND_HOST, () => {
    console.log(`seller listening on ${SELLER_BIND_HOST}:${port} (${net.caip2}, facilitator ${net.facilitatorUrl})`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
