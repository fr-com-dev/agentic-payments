// Seller API document against the running seller (SPEC.md CP-1; T-API-09..11).
// docs/seller.openapi.yaml is a copy of CP-1 for tools. These tests fail when the copy and the seller disagree on
// routes and prices (T-API-09) or on statuses, headers (decoded x402 headers included) and shapes (T-API-10).
// T-API-11 covers the free Swagger UI routes on the seller: off by default, same-origin, fixed files (SEC-13).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { SELLER_API_DOCS_FILE, servedSellerApiDocument } from "../src/counterparty/api-docs.js";
import { CategorizedFacilitatorClient } from "../src/counterparty/facilitator-client.js";
import { createSellerApp } from "../src/counterparty/seller.js";
import { CATALOG, SELLER_ENDPOINTS } from "../src/counterparty/seller-api.js";
import { networkProfile } from "../src/shared/config.js";
import {
  conformance,
  documentedResponse,
  documentedRoutes,
  isDocsRoute,
  loadDoc as loadDocFile,
  mountedRoutes,
  type OpenApiDoc,
  operations,
  responseContent,
  routeDiff,
  type Schema,
  send,
} from "./helpers/openapi.js";

const DOC_FILE = "docs/seller.openapi.yaml";
const loadDoc = () => loadDocFile(DOC_FILE);
const NET = networkProfile("local");
const PAY_TO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

type Mode = { supported: "ok" | "throw"; verify: "ok" | "reject" | "throw"; settle: "ok" | "fail" };

/** The repository's categorized client around a scripted facilitator, as main() wires the real one. */
function facilitator(mode: Mode) {
  const inner: FacilitatorClient = {
    getSupported: async () => {
      if (mode.supported === "throw") throw new Error("Facilitator getSupported failed (503): down");
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NET.caip2 }], extensions: [], signers: {} } as never;
    },
    verify: async () => {
      if (mode.verify === "throw") throw new Error("Facilitator verify failed (503): down");
      return (mode.verify === "ok" ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: "invalid_signature" }) as never;
    },
    settle: async () =>
      (mode.settle === "ok"
        ? { success: true, transaction: `0x${"ab".repeat(32)}`, network: NET.caip2, payer: PAYER }
        : { success: false, errorReason: "settlement_failed", transaction: "", network: NET.caip2 }) as never,
  };
  return new CategorizedFacilitatorClient(inner);
}

let servers: Server[] = [];
beforeEach(() => {
  // The seller logs each facilitator failure and the SDK logs undecodable headers; both are expected here.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

async function start(o: { apiDocs?: boolean; mode?: Partial<Mode> } = { apiDocs: true }) {
  const mode: Mode = { supported: "ok", verify: "ok", settle: "ok", ...o.mode };
  const app = createSellerApp({ net: NET, payTo: PAY_TO, facilitator: facilitator(mode), ...(o.apiDocs !== undefined && { apiDocs: o.apiDocs }) });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return { app, mode, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * Each documented operation's `x-monetization-tier` and `x-x402-price-atomic` against the seller's decorators, both
 * ways: every declared endpoint is documented with its tier and price (none for a free one), and every documented
 * monetized operation is declared. The docs routes have no tier.
 */
function monetizationMismatches(doc: OpenApiDoc): string[] {
  type Monetized = { "x-monetization-tier"?: string; "x-x402-price-atomic"?: string };
  const documented = new Map(
    operations(doc)
      .filter(([, , op]) => !isDocsRoute(op))
      .map(([, path, op]) => [path, { tier: (op as Monetized)["x-monetization-tier"], price: (op as Monetized)["x-x402-price-atomic"] }]),
  );
  const out: string[] = [];
  for (const e of SELLER_ENDPOINTS) {
    const d = documented.get(e.route.path);
    const declared = { tier: e.monetization.tier, price: e.monetization.price?.atomic };
    if (d === undefined) out.push(`${e.route.path}: declared ${declared.tier}, not in the document`);
    else if (d.tier !== declared.tier || d.price !== declared.price) {
      out.push(`${e.route.path}: document ${d.tier ?? "no tier"} ${d.price ?? "no price"}, declared ${declared.tier} ${declared.price ?? "no price"}`);
    }
    documented.delete(e.route.path);
  }
  for (const [path, d] of documented) out.push(`${path}: ${d.tier ?? "no tier"} in the document, not declared`);
  return out;
}

/** The decoder the SDK uses for each base64 JSON header. */
const HEADER_DECODERS: Record<string, (v: string) => unknown> = {
  "PAYMENT-REQUIRED": decodePaymentRequiredHeader,
  "PAYMENT-RESPONSE": decodePaymentResponseHeader,
};

// The helper's resolve() knows schemas and responses; headers and parameters are looked up here.
const component = <T>(doc: OpenApiDoc, ref: string): T => {
  const [, section, name] = ref.match(/^#\/components\/(\w+)\/([\w-]+)$/) ?? [];
  const found = (doc.components as unknown as Record<string, Record<string, unknown>>)[section!]?.[name!];
  if (found === undefined) throw new Error(`unresolved $ref ${ref}`);
  return found as T;
};
const deref = <T>(doc: OpenApiDoc, x: unknown): T => ((x as { $ref?: string }).$ref ? component<T>(doc, (x as { $ref: string }).$ref) : (x as T));

// ---------------------------------------------------------------------------------------------------------------
// T-API-09 routes and prices
// ---------------------------------------------------------------------------------------------------------------

describe("T-API-09 every seller route is documented at its catalog price, and every documented route is mounted", () => {
  it("T-API-09 the document's operations equal the routes mounted on the seller (API_DOCS=1)", async () => {
    const { app } = await start();
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-09 without API_DOCS, the mounted routes are exactly the documented non-docs operations", async () => {
    const { app } = await start({});
    const doc = loadDoc();
    expect(routeDiff(documentedRoutes(doc, (op) => !isDocsRoute(op)), mountedRoutes(app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-09 each operation's x-monetization-tier and x-x402-price-atomic are its declared tier and price", () => {
    expect(monetizationMismatches(loadDoc())).toEqual([]);
  });

  it("T-API-09 must-fail: a missing route, an unmounted route, a wrong price and a wrong tier are reported", async () => {
    const { app } = await start();
    const doc = loadDoc();
    delete doc.paths["/api/dataset-export"];
    doc.paths["/api/refund"] = { get: { tags: ["premium"], "x-monetization-tier": "premium", responses: {} } as never };
    (doc.paths["/api/weather"]!.get as unknown as Record<string, string>)["x-x402-price-atomic"] = "100";
    (doc.paths["/api/premium-report"]!.get as unknown as Record<string, string>)["x-monetization-tier"] = "pay-per-use";
    expect(routeDiff(documentedRoutes(doc), mountedRoutes(app))).toEqual({ undocumented: ["GET /api/dataset-export"], unmounted: ["GET /api/refund"] });
    expect(monetizationMismatches(doc)).toEqual([
      "/api/weather: document pay-per-use 100, declared pay-per-use 1000",
      "/api/premium-report: document pay-per-use 50000, declared premium 50000",
      "/api/dataset-export: declared enterprise, not in the document",
      "/api/refund: premium in the document, not declared",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-API-10 statuses, headers and shapes
// ---------------------------------------------------------------------------------------------------------------

describe("T-API-10 live responses match the documented status, headers and schema", () => {
  it("T-API-10 a scenario reaching every documented status conforms, x402 headers decoded", async () => {
    const doc = loadDoc();
    const { base, mode } = await start({ apiDocs: true, mode: { supported: "throw" } });
    const seen = new Set<string>();
    const errors: string[] = [];
    const call = async (path: string, o: { route?: string; query?: string; headers?: Record<string, string> } = {}) => {
      const route = o.route ?? path;
      const res = await fetch(base + path + (o.query ?? ""), { headers: o.headers ?? {} });
      const text = await res.text();
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
      const body = type === "application/json" ? (JSON.parse(text) as Record<string, unknown>) : {};
      seen.add(`GET ${route} ${res.status}`);
      const documented = documentedResponse(doc, "GET", route, res.status);
      const schema = responseContent(doc, "GET", route, res.status)?.[type]?.schema;
      if (!documented) errors.push(`GET ${route}: status ${res.status} not documented`);
      else if (!schema) errors.push(`GET ${route} ${res.status}: media type ${type} not documented`);
      else {
        errors.push(...conformance(doc, schema, type === "application/json" ? body : text).map((e) => `GET ${route} ${res.status} ${e}`));
        for (const [name, h] of Object.entries(documented.headers ?? {})) {
          const header = deref<{ required?: boolean; schema: { contentSchema?: Schema } }>(doc, h);
          const value = res.headers.get(name);
          if (value === null) {
            if (header.required) errors.push(`GET ${route} ${res.status}: no ${name} header`);
            continue;
          }
          const decoded = HEADER_DECODERS[name]!(value);
          errors.push(...conformance(doc, header.schema.contentSchema!, decoded).map((e) => `GET ${route} ${res.status} ${name} ${e}`));
        }
      }
      return { status: res.status, body, headers: res.headers };
    };

    // the catalog, then every priced route answers 503 while the facilitator is down (each request retries the sync)
    const catalog = await call("/api/catalog");
    expect((catalog.body.items as { priceAtomic: string }[]).map((i) => i.priceAtomic)).toEqual(CATALOG.map((i) => i.priceAtomic));
    for (const item of CATALOG) expect((await call(item.route)).status).toBe(503);
    mode.supported = "ok";

    const paymentParam = deref<{ schema: { contentSchema: Schema } }>(doc, { $ref: "#/components/parameters/PaymentSignature" });
    const signatures = new Map<string, string>();
    for (const item of CATALOG) {
      const query = item.route === "/api/weather" ? "?city=Lima" : "";
      // unpaid: the challenge names this route's catalog price
      const challenge = await call(item.route, { query });
      expect(challenge.status).toBe(402);
      const required = decodePaymentRequiredHeader(challenge.headers.get("payment-required")!);
      expect([required.accepts.length, required.accepts[0]!.amount, required.accepts[0]!.payTo]).toEqual([1, item.priceAtomic, PAY_TO]);
      // paid: the payment we send conforms to the documented request header, and the 200 carries the settlement
      const payment = { x402Version: 2, resource: required.resource, accepted: required.accepts[0]!, payload: { signature: "0xfake", authorization: {} } };
      expect(conformance(doc, paymentParam.schema.contentSchema, payment)).toEqual([]);
      signatures.set(item.route, encodePaymentSignatureHeader(payment as never));
      expect((await call(item.route, { query, headers: { "PAYMENT-SIGNATURE": signatures.get(item.route)! } })).status).toBe(200);
    }

    // a rejected payment, a payment for another route and a failed settlement: 402
    const weatherPayment = { "PAYMENT-SIGNATURE": signatures.get("/api/weather")! };
    mode.verify = "reject";
    expect(decodePaymentRequiredHeader((await call("/api/weather", { headers: weatherPayment })).headers.get("payment-required")!).error).toBe("invalid_signature");
    mode.verify = "ok";
    expect(decodePaymentRequiredHeader((await call("/api/market-brief", { headers: weatherPayment })).headers.get("payment-required")!).error).toBe(
      "No matching payment requirements",
    );
    mode.settle = "fail";
    const failed = await call("/api/weather", { headers: weatherPayment });
    expect([failed.status, failed.headers.has("payment-required"), decodePaymentResponseHeader(failed.headers.get("payment-response")!).success]).toEqual([402, false, false]);
    mode.settle = "ok";
    // the facilitator failing during a paid retry: 502 on every priced route
    mode.verify = "throw";
    for (const item of CATALOG) {
      const r = await call(item.route, { headers: { "PAYMENT-SIGNATURE": signatures.get(item.route)! } });
      expect([r.status, r.body]).toEqual([502, { error: "facilitator unavailable" }]);
    }
    mode.verify = "ok";

    // docs (API_DOCS=1): the page, every documented asset, an unknown asset and the document itself
    await call("/docs");
    const assetParam = doc.paths["/docs/{asset}"]!.get!.parameters!.find((x) => x.name === "asset")!;
    for (const asset of assetParam.schema.enum as string[]) await call(`/docs/${asset}`, { route: "/docs/{asset}" });
    await call("/docs/index.html", { route: "/docs/{asset}" });
    await call("/openapi.yaml");

    expect(errors).toEqual([]);
    const documented = operations(doc).flatMap(([meth, path, op]) => Object.keys(op.responses).map((s) => `${meth} ${path} ${s}`));
    expect(documented.filter((d) => !seen.has(d))).toEqual([]);
  });

  it("T-API-10 must-fail: a wrong enum value, a missing field, an undocumented field and a wrong x402 version are reported", () => {
    const doc = loadDoc();
    expect(conformance(doc, { $ref: "#/components/schemas/Weather" }, { city: "Lima", tempC: 2, condition: "snow", wind: 3 })).toEqual([
      "$.source: missing",
      '$.condition: "snow" not in enum',
      "$.wind: not documented",
    ]);
    const challenge = { x402Version: 1, resource: { url: "http://x/api/weather" }, accepts: [] };
    expect(conformance(doc, { $ref: "#/components/schemas/PaymentRequired" }, challenge)).toEqual(["$.x402Version: expected 2"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-API-11 Swagger UI on the seller
// ---------------------------------------------------------------------------------------------------------------

describe("T-API-11 Swagger UI on the seller is opt-in, same-origin and fixed (SEC-13)", () => {
  const DOCS_PROBES = ["/docs", "/docs/swagger-ui-bundle.js", "/docs/swagger-initializer.js", "/openapi.yaml"];
  const probe = async (base: string) => Promise.all(DOCS_PROBES.map(async (p) => `${p} ${(await send(base, "GET", p)).status}`));

  it("T-API-11 off by default: no docs route is mounted and each docs URL answers 404", async () => {
    const { app, base } = await start({});
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(app)).unmounted).toEqual(["GET /docs", "GET /docs/:asset", "GET /openapi.yaml"]);
    expect(await probe(base)).toEqual(DOCS_PROBES.map((p) => `${p} 404`));
  });

  it("T-API-11 must-fail: the same probe sees every docs URL with API_DOCS=1, and makes no facilitator call", async () => {
    const calls: string[] = [];
    const counting: FacilitatorClient = {
      getSupported: async () => (calls.push("supported"), { kinds: [], extensions: [], signers: {} }) as never,
      verify: async () => (calls.push("verify"), { isValid: false }) as never,
      settle: async () => (calls.push("settle"), { success: false, transaction: "", network: NET.caip2 }) as never,
    };
    const app = createSellerApp({ net: NET, payTo: PAY_TO, facilitator: counting, apiDocs: true });
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    servers.push(server);
    expect(await probe(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)).toEqual(DOCS_PROBES.map((p) => `${p} 200`));
    expect(calls).toEqual([]);
  });

  it("T-API-11 the seller refuses to start with an API_DOCS other than 1, 0 or empty; Azure never sets it", () => {
    const r = spawnSync("node_modules/.bin/tsx", ["src/counterparty/seller.ts"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: "/dev/null", NETWORK: "local", SELLER_PAY_TO: PAY_TO, API_DOCS: "yes" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect([r.status, r.stderr.trim()]).toEqual([1, 'seller: API_DOCS must be 1 or 0: "yes"']);
    expect(readFileSync("infra/modules/sellers.bicep", "utf8")).not.toMatch(/API_DOCS/);
  });

  it("T-API-11 the served document is the file with servers set to the serving seller", async () => {
    const { base } = await start();
    const res = await send(base, "GET", "/openapi.yaml");
    expect(res.type).toBe("application/yaml");
    const { servers: served, ...rest } = parse(res.text) as { servers: { url: string }[] };
    const { servers: fileServers, ...fileRest } = parse(readFileSync(SELLER_API_DOCS_FILE, "utf8")) as { servers: { url: string }[] };
    expect(served.map((s) => s.url)).toEqual(["/"]);
    expect(fileServers.map((s) => s.url)).toEqual(["http://127.0.0.1:4021"]);
    expect(rest).toEqual(fileRest);
    // must-fail: a document without a top-level servers block is refused rather than served unchanged
    expect(() => servedSellerApiDocument("openapi: 3.1.0\npaths: {}\n")).toThrow("no top-level servers block");
  });

  it("T-API-11 the page loads scripts and data from its own origin only, under a CSP, and serves no other file", async () => {
    const { base } = await start();
    const page = await send(base, "GET", "/docs");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp.split("; ")).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]));
    expect(csp).not.toMatch(/unsafe-eval|https?:/);
    expect(page.text).not.toMatch(/https?:\/\//);
    expect(page.text).toContain("<title>Seller API</title>");
    const others = ["index.html", "package.json", "swagger-ui-bundle.js.map", "__proto__", "..%2Fpackage.json"];
    const statuses = await Promise.all(others.map(async (x) => `${x} ${(await send(base, "GET", `/docs/${x}`)).status}`));
    expect(statuses).toEqual(others.map((x) => `${x} 404`));
  });
});
