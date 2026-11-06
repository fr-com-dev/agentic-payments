// The seller's monetization model and endpoint decorators (SPEC.md CP-1, v1.7; T-MON-01..03).
// T-MON-01: the tiers the seller declares, what the seller derives from them, and freemium's guarantee that free
// endpoints answer while payments can't be taken. T-MON-02: usdc() prices. T-MON-03: every declaration mistake
// is refused while the seller is built, never while it serves.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FacilitatorClient } from "@x402/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { declaredEndpoints, EndpointDeclarationError, Get } from "../src/counterparty/endpoints.js";
import { Enterprise, Free, PayPerUse, Premium, TIERS, usdc } from "../src/counterparty/monetization.js";
import { createSellerApp, sellerRoutes } from "../src/counterparty/seller.js";
import { CATALOG, FREE_ENDPOINTS, PAID_ENDPOINTS, SELLER_ENDPOINTS } from "../src/counterparty/seller-api.js";
import { localTestNet } from "./helpers/local-net.js";

const NET = localTestNet();
const PAY_TO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

let servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

describe("T-MON-01 the seller's monetization model: freemium discovery, pay-per-use in tiers", () => {
  it("T-MON-01 each endpoint declares its route and tier; prices are unchanged and rise with the tier", () => {
    expect(SELLER_ENDPOINTS.map((e) => [e.route.path, e.monetization.tier, e.monetization.price?.atomic ?? null])).toEqual([
      ["/api/catalog", "free", null],
      ["/api/weather", "pay-per-use", "1000"],
      ["/api/market-brief", "pay-per-use", "5000"],
      ["/api/premium-report", "premium", "50000"],
      ["/api/dataset-export", "enterprise", "500000"],
    ]);
    // A higher tier never costs less than a lower one.
    const rank = (t: string) => TIERS.indexOf(t as (typeof TIERS)[number]);
    const paid = [...PAID_ENDPOINTS].sort((a, b) => rank(a.monetization.tier) - rank(b.monetization.tier));
    const prices = paid.map((e) => BigInt(e.monetization.price!.atomic));
    expect(prices.every((p, i) => i === 0 || p >= prices[i - 1]!)).toBe(true);
  });

  it("T-MON-01 the catalog and the x402 requirements are derived from the declarations: free never priced, paid always", () => {
    const routes = sellerRoutes(NET, PAY_TO);
    expect(Object.keys(routes)).toEqual(PAID_ENDPOINTS.map((e) => `GET ${e.route.path}`));
    for (const e of FREE_ENDPOINTS) expect(routes[`GET ${e.route.path}`]).toBeUndefined();
    for (const e of PAID_ENDPOINTS) {
      const accepts = routes[`GET ${e.route.path}`]!.accepts as { price: { amount: string } };
      expect([accepts.price.amount, routes[`GET ${e.route.path}`]!.description]).toEqual([e.monetization.price!.atomic, e.monetization.description]);
    }
    expect(CATALOG.map((c) => [c.path, c.route, c.tier])).toEqual([
      ["/api/weather?city=", "/api/weather", "pay-per-use"],
      ["/api/market-brief", "/api/market-brief", "pay-per-use"],
      ["/api/premium-report", "/api/premium-report", "premium"],
      ["/api/dataset-export", "/api/dataset-export", "enterprise"],
    ]);
  });

  it("T-MON-01 freemium: the catalog answers while the facilitator is down; priced routes answer 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down: FacilitatorClient = {
      getSupported: async () => {
        throw new Error("Facilitator getSupported failed (503): down");
      },
      verify: async () => ({ isValid: false }) as never,
      settle: async () => ({ success: false, transaction: "", network: NET.caip2 }) as never,
    };
    const app = createSellerApp({ net: NET, payTo: PAY_TO, facilitator: down });
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const statuses = await Promise.all(SELLER_ENDPOINTS.map(async (e) => `${e.route.path} ${(await fetch(base + e.route.path)).status}`));
    expect(statuses).toEqual([
      "/api/catalog 200",
      "/api/weather 503",
      "/api/market-brief 503",
      "/api/premium-report 503",
      "/api/dataset-export 503",
    ]);
  });
});

describe("T-MON-02 usdc() prices with BigInt math", () => {
  it("T-MON-02 converts a USDC decimal string to atomic units (6 decimals)", () => {
    expect(["0.001", "0.005", "0.05", "0.50", "1", "12.345678"].map((a) => usdc(a).atomic)).toEqual([
      "1000",
      "5000",
      "50000",
      "500000",
      "1000000",
      "12345678",
    ]);
    expect(usdc("0.50")).toEqual({ usdc: "0.50", atomic: "500000" });
  });

  it("T-MON-02 must-fail: zero, more than 6 decimals, signs, exponents and blanks are refused", () => {
    for (const bad of ["0", "0.000000", "0.0000001", "-1", "+1", "1e3", "", ".5", "1.", " 1", "0x10"]) {
      expect(() => usdc(bad), bad).toThrow(RangeError);
    }
  });
});

describe("T-MON-03 a declaration mistake is refused while the seller is built, never while it serves", () => {
  const price = usdc("0.001");

  it("T-MON-03 must-fail: an endpoint without a tier, or without a route", () => {
    class NoTier {
      @Get("/a")
      a() {
        return {};
      }
    }
    expect(() => declaredEndpoints(NoTier)).toThrow(new EndpointDeclarationError("a: GET /a has no monetization tier (@Free, @PayPerUse, @Premium or @Enterprise)"));
    class NoRoute {
      @Premium({ price, description: "p" })
      b() {
        return {};
      }
    }
    expect(() => declaredEndpoints(NoRoute)).toThrow(new EndpointDeclarationError("b: has a monetization tier but no route (@Get)"));
  });

  it("T-MON-03 must-fail: two tiers, two routes, or one route for two endpoints", () => {
    expect(() => {
      class TwoTiers {
        @Get("/a")
        @Free("free")
        @PayPerUse({ price, description: "paid" })
        a() {
          return {};
        }
      }
      return TwoTiers;
    }).toThrow(new EndpointDeclarationError("a: has two monetization tiers"));
    expect(() => {
      class TwoRoutes {
        @Get("/a")
        @Get("/b")
        @Free("free")
        a() {
          return {};
        }
      }
      return TwoRoutes;
    }).toThrow(new EndpointDeclarationError("a: has two routes"));
    class SameRoute {
      @Get("/a")
      @Free("free")
      a() {
        return {};
      }

      @Get("/a")
      @Enterprise({ price, description: "bulk" })
      b() {
        return {};
      }
    }
    expect(() => declaredEndpoints(SameRoute)).toThrow(new EndpointDeclarationError("GET /a: declared by two endpoints"));
  });

  it("T-MON-03 must-fail: a static method, a path with a query, an empty description or a non-USDC network", () => {
    expect(() => {
      class Static {
        @Get("/a")
        @Free("free")
        static a() {
          return {};
        }
      }
      return Static;
    }).toThrow(new EndpointDeclarationError("a: an endpoint must be a public instance method"));
    expect(() => Get("/api/weather?city=")).toThrow(EndpointDeclarationError);
    expect(() => Free(" ")).toThrow(RangeError);
    // The decimals refusal itself: on a clean checkout, `{ ...NET }` used to throw the missing-deployment ConfigError
    // before createSellerApp ran, so a bare toThrow(ConfigError) passed without testing it.
    expect(() => createSellerApp({ net: { ...NET, decimals: 18 }, payTo: PAY_TO })).toThrow(/the seller prices in USDC \(6 decimals\); local's asset has 18/);
  });

  it("T-MON-03 undecorated methods are helpers, not endpoints", () => {
    class WithHelper {
      @Get("/a")
      @Free("free")
      a() {
        return this.helper();
      }

      helper() {
        return { ok: true };
      }
    }
    expect(declaredEndpoints(WithHelper).map((e) => e.name)).toEqual(["a"]);
  });
});
