// The seller's endpoints (SPEC.md CP-1), one decorated method each: its route and its monetization tier
// (./monetization.ts). Adding a priced route here adds it to the catalog and the x402 requirements; it also changes
// what the scripted plan can buy, so update SPEC L1-4 and T-E2E-01, and docs/seller.openapi.yaml (T-API-09, T-API-10).
// The bodies are mock data, deterministic per input (research R4).
import type { Request } from "express";
import type { NetworkProfile } from "../shared/config.js";
import { advertisedPath, declaredEndpoints, Get, type Endpoint } from "./endpoints.js";
import { Enterprise, Free, PayPerUse, Premium, usdc, type PaidTier } from "./monetization.js";

const SOURCE = "mock-seller (deterministic)";
const CONDITIONS = ["sunny", "cloudy", "rain", "fog"] as const;

/** Deterministic mock weather: seed = sum of the city's char codes (research R4). */
export function weatherBody(city: string) {
  let seed = 0;
  for (const ch of city) seed += ch.codePointAt(0)!;
  return { city, tempC: seed % 35, condition: CONDITIONS[seed % 4]!, source: SOURCE };
}

/** One catalog entry: a priced route as the buyer sees it. */
export interface CatalogItem {
  /** The path to call, with the query parameters it reads (`/api/weather?city=`). */
  path: string;
  /** The Express route, without the query. */
  route: string;
  priceAtomic: string;
  description: string;
  tier: PaidTier;
}

export interface CatalogBody {
  network: string;
  asset: string;
  decimals: number;
  items: Omit<CatalogItem, "route">[];
}

export class SellerApi {
  readonly #net: NetworkProfile;

  constructor(net: NetworkProfile) {
    this.#net = net;
  }

  @Get("/api/catalog")
  @Free("the price list: every priced route with its tier and price")
  catalog(): CatalogBody {
    return {
      network: this.#net.caip2,
      asset: this.#net.asset,
      decimals: this.#net.decimals,
      items: CATALOG.map(({ path, priceAtomic, description, tier }) => ({ path, priceAtomic, description, tier })),
    };
  }

  @Get("/api/weather", { query: ["city"] })
  @PayPerUse({ price: usdc("0.001"), description: "current weather for a city" })
  weather(req: Request) {
    const city = typeof req.query.city === "string" && req.query.city.length > 0 ? req.query.city : "Lima";
    return weatherBody(city);
  }

  @Get("/api/market-brief")
  @PayPerUse({ price: usdc("0.005"), description: "daily market brief" })
  marketBrief() {
    return {
      headline: "Stablecoin settlement volumes steady",
      bullets: ["USDC supply unchanged week on week", "Base L2 fees remain sub-cent", "Agentic commerce pilots expand"],
      source: SOURCE,
    };
  }

  @Get("/api/premium-report")
  @Premium({ price: usdc("0.05"), description: "premium research report" })
  premiumReport() {
    return { title: "Agentic payments: three-layer control", pages: 42, source: SOURCE };
  }

  @Get("/api/dataset-export")
  @Enterprise({ price: usdc("0.50"), description: "full dataset export" })
  datasetExport() {
    return { rows: 1_000_000, source: SOURCE };
  }
}

/** Every endpoint the seller declares, in declaration order (validated once, at load). */
export const SELLER_ENDPOINTS: readonly Endpoint[] = declaredEndpoints(SellerApi);
export const FREE_ENDPOINTS = SELLER_ENDPOINTS.filter((e) => e.monetization.tier === "free");
export const PAID_ENDPOINTS = SELLER_ENDPOINTS.filter((e) => e.monetization.tier !== "free");

/** CP-1 price list, derived from the paid endpoints' declarations. */
export const CATALOG: readonly CatalogItem[] = PAID_ENDPOINTS.map((e) => {
  const m = e.monetization as Extract<Endpoint["monetization"], { price: object }>;
  return { path: advertisedPath(e.route), route: e.route.path, priceAtomic: m.price.atomic, description: m.description, tier: m.tier };
});
