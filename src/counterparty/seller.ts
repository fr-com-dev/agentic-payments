// Seller API (SPEC.md CP-1, CP-3). A simulated external party: an x402 v2 resource server. Its endpoints, each
// with its route and monetization tier, are declared in ./seller-api.ts; this file wires them up. Free endpoints
// are mounted before the x402 middleware, priced ones after it, and each priced route offers exactly one `exact`
// option priced as an explicit AssetAmount (never a "$" string), so the asset and its EIP-712 domain come from the
// network profile. docs/seller.openapi.yaml describes the routes; with API_DOCS=1 the seller also serves it.
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
  apiDocsEnabled,
  ConfigError,
  facilitatorChoice,
  loadEnv,
  networkProfile,
  sellerPort,
  SELLER_BIND_HOST,
  type NetworkProfile,
} from "../shared/config.js";
import { mountSellerApiDocs } from "./api-docs.js";
import { mountEndpoints } from "./endpoints.js";
import { USDC_DECIMALS } from "./monetization.js";
import { FREE_ENDPOINTS, PAID_ENDPOINTS, SellerApi } from "./seller-api.js";
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

/** One payment option per route; the query string never affects the price. */
export function sellerRoutes(net: NetworkProfile, payTo: string): Record<string, RouteConfig> {
  const routes: Record<string, RouteConfig> = {};
  for (const { route, monetization } of PAID_ENDPOINTS) {
    if (monetization.price === null) continue;
    routes[`${route.method} ${route.path}`] = {
      description: monetization.description,
      mimeType: "application/json",
      accepts: {
        scheme: "exact",
        network: net.caip2,
        payTo,
        maxTimeoutSeconds: 120,
        price: { asset: net.asset, amount: monetization.price.atomic, extra: { ...net.assetDomain } },
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

/** The free endpoints (the catalog). Mount them BEFORE the payment middleware, so they never pay (research R3). */
export function mountFreeEndpoints(app: express.Express, api: SellerApi): void {
  mountEndpoints(app, api, FREE_ENDPOINTS);
}

/** The priced endpoints. Mount them AFTER the payment middleware: they run only once a payment verified. */
export function mountPaidEndpoints(app: express.Express, api: SellerApi): void {
  mountEndpoints(app, api, PAID_ENDPOINTS);
}

export interface SellerOptions extends PaymentMiddlewareOptions {
  net: NetworkProfile;
  payTo: string;
  /** v1.6: `API_DOCS=1` mounts the free Swagger UI routes (SEC-13). Default false. */
  apiDocs?: boolean;
}

/**
 * The seller app: the free endpoints (and, with apiDocs, the docs routes) first, then the x402 middleware, then the
 * priced endpoints. Prices are written in USDC (`usdc()`), so a network whose asset has other decimals is refused.
 */
export function createSellerApp({ net, payTo, apiDocs = false, ...middleware }: SellerOptions): express.Express {
  if (net.decimals !== USDC_DECIMALS) {
    throw new ConfigError(`the seller prices in USDC (${USDC_DECIMALS} decimals); ${net.name}'s asset has ${net.decimals}`);
  }
  const api = new SellerApi(net);
  const app = express();
  app.disable("x-powered-by");
  mountFreeEndpoints(app, api);
  if (apiDocs) mountSellerApiDocs(app);
  app.use(sellerPaymentMiddleware(net, sellerRoutes(net, payTo), middleware));
  mountPaidEndpoints(app, api);
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
  let apiDocs = false;
  try {
    apiDocs = apiDocsEnabled();
  } catch (err) {
    fail(err instanceof ConfigError ? err.message : "invalid API_DOCS");
  }

  const facilitator = cred
    ? facilitatorClientFor(choice, { cdp: cdpFacilitatorClient(cred) })
    : facilitatorClientFor(choice);
  const app = createSellerApp({
    net,
    payTo,
    apiDocs,
    facilitator,
    ...(cred && { redact: makeRedactor(cred), authHint: CDP_AUTH_HINT }),
  });
  const port = sellerPort();
  const keyNote = cred ? ` key=${keyIdSuffix(cred)}` : "";
  app.listen(port, SELLER_BIND_HOST, () => {
    console.log(
      `seller listening on ${SELLER_BIND_HOST}:${port} (${net.caip2}, facilitator=${choice.kind} host=${new URL(choice.url).host}${keyNote})`,
    );
    if (apiDocs) console.log(`seller API docs on http://${SELLER_BIND_HOST}:${port}/docs (API_DOCS=1)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
