// L2 control API document against the running service (SPEC.md §8.2 L2-5; T-API-01..04).
// docs/l2-control.openapi.yaml is a copy of L2-5 for tools. These tests fail when the copy and the service
// disagree on routes (T-API-01), bearer tokens (T-API-02) or response shapes and statuses (T-API-03).
// T-API-04 covers the token-free Swagger UI routes: off by default, same-origin only, fixed files (SEC-13).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { apiDocsEnabled, ConfigError } from "../src/shared/config.js";
import type { PaymentIntent, SettlementReport } from "../src/shared/contracts.js";
import { ESCALATION_TTL_MS } from "../src/layer2-control/escalations.js";
import { API_DOCS_FILE, servedApiDocument } from "../src/layer2-control/api-docs.js";
import { AuditLedger } from "../src/layer2-control/ledger.js";
import { buildMandate } from "../src/layer2-control/mandate.js";
import { createControlService } from "../src/layer2-control/service.js";
import type { PaymentSignerLike } from "../src/layer2-control/signer.js";

const DOC_FILE = "docs/l2-control.openapi.yaml";
const CAIP2 = "eip155:31337";
const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const PAY_TO = "0xcccccccccccccccccccccccccccccccccccccccc";
const PAYER = "0x00000000000000000000000000000000000000f1";
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const TOKENS = { control: "t-control", settlement: "t-settlement", operator: "t-operator" };
/** Security scheme name in the document → the token the service expects for it. */
const SCHEME_TOKENS: Record<string, string> = {
  controlToken: TOKENS.control,
  settlementToken: TOKENS.settlement,
  operatorToken: TOKENS.operator,
};
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  oneOf?: Schema[];
};
type Response = { $ref?: string; content?: Record<string, { schema: Schema }> };
type Operation = {
  tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: { name: string; schema: Schema }[];
  responses: Record<string, Response>;
};
type OpenApiDoc = {
  paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Response> };
};

const loadDoc = () => parse(readFileSync(DOC_FILE, "utf8")) as OpenApiDoc;

/** Every operation as [method, document path, operation]. */
function operations(doc: OpenApiDoc): [string, string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m] !== undefined).map((m): [string, string, Operation] => [m.toUpperCase(), path, item[m]!]),
  );
}

/** `/v1/approvals/{authorizationId}` → `/v1/approvals/:authorizationId` (Express form). */
const expressPath = (path: string) => path.replace(/\{(\w+)\}/g, ":$1");

function documentedRoutes(doc: OpenApiDoc, filter: (op: Operation) => boolean = () => true): string[] {
  return operations(doc)
    .filter(([, , op]) => filter(op))
    .map(([m, p]) => `${m} ${expressPath(p)}`)
    .sort();
}

/** The Swagger UI operations, mounted only with API_DOCS=1. */
const isDocsRoute = (op: Operation) => op.tags?.includes("docs") === true;

function mountedRoutes(app: Express): string[] {
  const { stack } = app.router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  return stack
    .flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`) : []))
    .sort();
}

function routeDiff(documented: string[], mounted: string[]) {
  return {
    undocumented: mounted.filter((r) => !documented.includes(r)),
    unmounted: documented.filter((r) => !mounted.includes(r)),
  };
}

const resolve = <T>(doc: OpenApiDoc, ref: string): T => {
  const [, section, name] = ref.match(/^#\/components\/(schemas|responses)\/(\w+)$/) ?? [];
  const found = section === "schemas" ? doc.components.schemas[name!] : section === "responses" ? doc.components.responses[name!] : undefined;
  if (found === undefined) throw new Error(`unresolved $ref ${ref}`);
  return found as T;
};

/**
 * Checks `value` against the subset of JSON Schema the document uses ($ref, oneOf, const, enum, type,
 * pattern, properties, required, additionalProperties, items). Returns one message per violation.
 */
function conformance(doc: OpenApiDoc, schema: Schema, value: unknown, at = "$"): string[] {
  if (schema.$ref) return conformance(doc, resolve<Schema>(doc, schema.$ref), value, at);
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => conformance(doc, s, value, at).length === 0).length;
    return n === 1 ? [] : [`${at}: matches ${n} oneOf branches`];
  }
  if ("const" in schema && value !== schema.const) return [`${at}: expected ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} not in enum`];
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const typeOk: Record<string, boolean> = {
    object: isObject,
    array: Array.isArray(value),
    string: typeof value === "string",
    integer: Number.isInteger(value),
    number: typeof value === "number",
    boolean: typeof value === "boolean",
  };
  if (schema.type && !typeOk[schema.type]) return [`${at}: expected ${schema.type}`];
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) return [`${at}: does not match ${schema.pattern}`];
  const errors: string[] = [];
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...conformance(doc, schema.items!, v, `${at}[${i}]`)));
  if (isObject) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${at}.${k}: missing`);
    for (const [k, v] of Object.entries(obj)) {
      const prop = schema.properties?.[k];
      if (prop) errors.push(...conformance(doc, prop, v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: not documented`);
      else if (typeof schema.additionalProperties === "object") errors.push(...conformance(doc, schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errors;
}

/** The documented content (media type → schema) for one (operation, status), or undefined when the status is not documented. */
function responseContent(doc: OpenApiDoc, method: string, path: string, status: number): Response["content"] | undefined {
  const op = doc.paths[path]?.[method.toLowerCase() as (typeof METHODS)[number]];
  const res = op?.responses[String(status)];
  if (!res) return undefined;
  return (res.$ref ? resolve<Response>(doc, res.$ref) : res).content ?? {};
}

const fakeSigner: PaymentSignerLike = {
  address: PAYER,
  sign: async () => ({ headers: { "PAYMENT-SIGNATURE": "opaque" }, payer: PAYER, validBefore: Math.floor(NOW / 1000) + 120 }),
};

let dir: string;
let servers: Server[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openapi-"));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

/**
 * T-API-01..03 describe the full surface, so API docs are on by default here. `startService({})` leaves
 * `apiDocs` unset, which is what main() passes without API_DOCS, so it tests the service's own default.
 */
async function startService(opts: { apiDocs?: boolean } = { apiDocs: true }) {
  let t = NOW;
  const mandate = buildMandate(
    {
      mandateId: "mandate-openapi",
      expiresAt: "2027-12-31T23:59:59Z",
      allowedSchemes: ["exact"],
      allowedPayees: [PAY_TO],
      allowedHosts: ["127.0.0.1:4021"],
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      dailyBudgetAtomic: "500000",
      maxAuthorizationsPerMinute: 10,
      maxTimeoutSeconds: 300,
    },
    { caip2: CAIP2, asset: ASSET },
  );
  const svc = createControlService({
    mandate,
    signer: fakeSigner,
    ledger: new AuditLedger(join(dir, ".local", "ledger-local.jsonl")),
    asset: { address: ASSET, decimals: 6 },
    tokens: TOKENS,
    now: () => t,
    ...(opts.apiDocs !== undefined && { apiDocs: opts.apiDocs }),
  });
  const server = await new Promise<Server>((r) => {
    const s = svc.app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return {
    app: svc.app,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** `body` is the parsed JSON (empty for other media types); `text` is the raw body; `type` has no parameters. */
async function send(base: string, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token !== undefined && { authorization: `Bearer ${token}` }) },
    ...(method !== "GET" && { body: JSON.stringify(body ?? {}) }),
  });
  const text = await res.text();
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const json = type === "application/json" ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, type, text, body: json, headers: res.headers };
}

/**
 * For each operation and each caller (no token, then each scheme's token): passes the guard iff documented.
 * `security: []` documents a route with no token, which every caller passes.
 */
async function authMismatches(doc: OpenApiDoc, base: string): Promise<string[]> {
  const out: string[] = [];
  for (const [method, path, op] of operations(doc)) {
    const open = op.security?.length === 0;
    const documented = Object.keys(op.security?.[0] ?? {});
    const concrete = path.replace(/\{\w+\}/g, "x");
    for (const [scheme, token] of [["none", undefined], ...Object.entries(SCHEME_TOKENS)] as [string, string | undefined][]) {
      const { status } = await send(base, method, concrete, token);
      const passedGuard = status !== 401;
      if (passedGuard !== (open || documented.includes(scheme))) out.push(`${method} ${path} ${scheme}: ${status}`);
    }
  }
  return out;
}

let n = 0;
function intent(sessionId: string, path: string, amount: string): PaymentIntent {
  const url = `http://127.0.0.1:4021${path}`;
  const accepts = [
    { scheme: "exact", network: CAIP2, asset: ASSET, amount, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } },
  ] as PaymentRequirements[];
  return {
    intentId: `int_${++n}`,
    sessionId,
    resourceUrl: url,
    paymentRequired: { x402Version: 2, resource: { url, description: "", mimeType: "application/json" }, accepts } as PaymentRequired,
    purpose: "openapi conformance",
    createdAt: new Date(NOW).toISOString(),
  };
}

describe("T-API-01 every L2 route is documented, and every documented route is mounted", () => {
  it("T-API-01 the document's operations equal the routes mounted on the L2 app (API_DOCS=1)", async () => {
    const { app } = await startService();
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-01 without API_DOCS, the mounted routes are exactly the documented non-docs operations", async () => {
    const { app } = await startService({});
    const doc = loadDoc();
    expect(routeDiff(documentedRoutes(doc, (op) => !isDocsRoute(op)), mountedRoutes(app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-01 must-fail: a route missing from the document, or documented but not mounted, is reported", async () => {
    const { app } = await startService();
    const doc = loadDoc();
    delete doc.paths["/v1/rejections/{authorizationId}"];
    doc.paths["/v1/refunds"] = { post: { responses: {} } };
    expect(routeDiff(documentedRoutes(doc), mountedRoutes(app))).toEqual({
      undocumented: ["POST /v1/rejections/:authorizationId"],
      unmounted: ["POST /v1/refunds"],
    });
  });
});

describe("T-API-02 each operation's security scheme is the only token its guard accepts", () => {
  it("T-API-02 no token and the other two tokens get 401; the documented token passes the guard", async () => {
    const { base } = await startService();
    expect(await authMismatches(loadDoc(), base)).toEqual([]);
  });

  it("T-API-02 must-fail: a document naming the wrong token is reported", async () => {
    const { base } = await startService();
    const doc = loadDoc();
    doc.paths["/v1/authorize"]!.post!.security = [{ operatorToken: [] }];
    expect(await authMismatches(doc, base)).toEqual(["POST /v1/authorize controlToken: 400", "POST /v1/authorize operatorToken: 401"]);
  });
});

describe("T-API-03 live responses match the documented status and schema", () => {
  it("T-API-03 a scenario reaching every documented status (except 500) conforms to the document", async () => {
    const doc = loadDoc();
    const { base, advance } = await startService();
    const seen = new Set<string>();
    const errors: string[] = [];
    const call = async (method: string, path: string, opts: { token?: string; params?: Record<string, string>; query?: string; body?: unknown } = {}) => {
      const concrete = path.replace(/\{(\w+)\}/g, (_, k: string) => opts.params?.[k] ?? "x") + (opts.query ?? "");
      const res = await send(base, method, concrete, opts.token, opts.body);
      seen.add(`${method} ${path} ${res.status}`);
      const content = responseContent(doc, method, path, res.status);
      const schema = content?.[res.type]?.schema;
      if (!content) errors.push(`${method} ${path}: status ${res.status} not documented`);
      else if (!schema) errors.push(`${method} ${path} ${res.status}: media type ${res.type} not documented`);
      else {
        const value = res.type === "application/json" ? res.body : res.text;
        errors.push(...conformance(doc, schema, value).map((e) => `${method} ${path} ${res.status} ${e}`));
      }
      return res.body;
    };
    const C = { token: TOKENS.control };
    const O = { token: TOKENS.operator };
    const authorize = (i: PaymentIntent) => call("POST", "/v1/authorize", { ...C, body: i });
    const approve = (id: string, body?: unknown) => call("POST", "/v1/approvals/{authorizationId}", { ...O, params: { authorizationId: id }, body });
    const reject = (id: string, body?: unknown) => call("POST", "/v1/rejections/{authorizationId}", { ...O, params: { authorizationId: id }, body });

    // agent: budget and the three decisions, plus a malformed intent
    await call("GET", "/v1/budget/{sessionId}", { ...C, params: { sessionId: "sess_a" } });
    const paid = await authorize(intent("sess_a", "/api/weather", "1000"));
    expect(paid.status).toBe("AUTHORIZED");
    const e1 = await authorize(intent("sess_a", "/api/premium-report", "50000"));
    expect(e1.status).toBe("ESCALATE");
    expect((await authorize(intent("sess_a", "/api/dataset-export", "200000"))).status).toBe("DENIED");
    await call("POST", "/v1/authorize", { ...C, body: { sessionId: "sess_a" } });

    // operator: approve twice, then a reject conflicts with the approval
    await call("GET", "/v1/escalations", O);
    await approve(String(e1.authorizationId), { approver: "alice" });
    expect((await approve(String(e1.authorizationId))).alreadyApproved).toBe(true);
    await reject(String(e1.authorizationId));

    // reject twice, then an approve conflicts with the rejection; invalid bodies; unknown IDs
    const e2 = await authorize(intent("sess_b", "/api/premium-report", "50000"));
    await reject(String(e2.authorizationId), { operator: "alice", reason: "too expensive" });
    expect((await reject(String(e2.authorizationId))).alreadyRejected).toBe(true);
    await approve(String(e2.authorizationId));
    await approve(String(e2.authorizationId), { ttlSeconds: 0 });
    await reject(String(e2.authorizationId), { operator: "" });
    await approve("auth_unknown");
    await reject("auth_unknown");

    // expiry: both decisions conflict; later the first approval lapses unused
    const e3 = await authorize(intent("sess_c", "/api/premium-report", "50000"));
    advance(ESCALATION_TTL_MS + 1);
    await approve(String(e3.authorizationId));
    await reject(String(e3.authorizationId));
    advance(600_000);

    // events carry every kind, so every optional event field is checked
    const { events } = await call("GET", "/v1/escalations/events", { ...O, query: "?after=-1" });
    expect(new Set((events as { kind: string }[]).map((e) => e.kind))).toEqual(new Set(["escalated", "approved", "denied", "expired", "approval_lapsed"]));
    await call("GET", "/v1/escalations/events", { ...O, query: "?after=nope" });

    // settlement: a report for the paid authorization, an unknown one and a malformed one
    const report: SettlementReport = {
      authorizationId: String(paid.authorizationId),
      status: "CONFIRMED",
      transaction: `0x${"ab".repeat(32)}`,
      network: CAIP2,
      blockNumber: "1",
      confirmations: 1,
      finalityClass: "included",
      detail: "transfer log matches",
      observedAt: new Date(NOW).toISOString(),
      verified: { asset: ASSET, payer: PAYER, payTo: PAY_TO, amount: "1000" },
    };
    await call("POST", "/v1/reconcile", { token: TOKENS.settlement, body: report });
    await call("POST", "/v1/reconcile", { token: TOKENS.settlement, body: { ...report, authorizationId: "auth_unknown" } });
    await call("POST", "/v1/reconcile", { token: TOKENS.settlement, body: { authorizationId: "auth_x" } });

    await call("GET", "/v1/ledger/verify", O);

    // docs (API_DOCS=1): the page, every documented asset and the document itself
    await call("GET", "/docs");
    const assetParam = doc.paths["/docs/{asset}"]!.get!.parameters!.find((p) => p.name === "asset")!;
    for (const asset of assetParam.schema.enum as string[]) await call("GET", "/docs/{asset}", { params: { asset } });
    await call("GET", "/openapi.yaml");
    expect([...seen].filter((s) => s.startsWith("GET /docs/{asset} "))).toEqual(["GET /docs/{asset} 200"]);

    for (const [method, path] of operations(doc)) await call(method, path);

    expect(errors).toEqual([]);
    const documented = operations(doc).flatMap(([m, p, op]) => Object.keys(op.responses).map((s) => `${m} ${p} ${s}`));
    expect(documented.filter((d) => !seen.has(d))).toEqual(["POST /v1/authorize 500"]);
  });

  it("T-API-03 must-fail: an undocumented field, a missing field and a wrong type are reported", () => {
    const doc = loadDoc();
    const budget = { $ref: "#/components/schemas/BudgetStatus" };
    const ok = { sessionId: "s", asset: ASSET, decimals: 6, sessionCapAtomic: "100000", spentOrReservedAtomic: "0", remainingAtomic: "100000", perPaymentCapAtomic: "20000" };
    expect(conformance(doc, budget, ok)).toEqual([]);
    const { remainingAtomic: _, ...missing } = ok;
    expect(conformance(doc, budget, { ...missing, decimals: "6", currency: "USDC" })).toEqual([
      "$.remainingAtomic: missing",
      "$.decimals: expected integer",
      "$.currency: not documented",
    ]);
  });
});

describe("T-API-04 Swagger UI is opt-in, same-origin and serves fixed files only (SEC-13)", () => {
  const DOCS_PROBES = ["/docs", "/docs/swagger-ui-bundle.js", "/docs/swagger-initializer.js", "/openapi.yaml"];
  const probe = async (base: string) => Promise.all(DOCS_PROBES.map(async (p) => `${p} ${(await send(base, "GET", p)).status}`));

  it("T-API-04 off by default: no docs route is mounted and each docs URL answers 404", async () => {
    const { app, base } = await startService({});
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(app)).unmounted).toEqual(["GET /docs", "GET /docs/:asset", "GET /openapi.yaml"]);
    expect(await probe(base)).toEqual(DOCS_PROBES.map((p) => `${p} 404`));
  });

  it("T-API-04 must-fail: the same probe sees every docs URL when API_DOCS=1", async () => {
    const { base } = await startService({ apiDocs: true });
    expect(await probe(base)).toEqual(DOCS_PROBES.map((p) => `${p} 200`));
  });

  it("T-API-04 API_DOCS accepts 1 to enable and unset, empty or 0 to disable; anything else is a startup error", () => {
    expect([{}, { API_DOCS: "" }, { API_DOCS: "0" }, { API_DOCS: "1" }].map((env) => apiDocsEnabled(env))).toEqual([false, false, false, true]);
    for (const bad of ["true", "yes", " 1"]) expect(() => apiDocsEnabled({ API_DOCS: bad })).toThrow(ConfigError);
  });

  it("T-API-04 the served document is the file with servers set to the serving L2", async () => {
    const { base } = await startService();
    const res = await send(base, "GET", "/openapi.yaml");
    expect(res.type).toBe("application/yaml");
    const { servers, ...rest } = parse(res.text) as { servers: { url: string }[] };
    const { servers: fileServers, ...fileRest } = parse(readFileSync(API_DOCS_FILE, "utf8")) as { servers: { url: string }[] };
    expect(servers.map((s) => s.url)).toEqual(["/"]);
    expect(fileServers.map((s) => s.url)).toEqual(["http://127.0.0.1:4020"]);
    expect(rest).toEqual(fileRest);
    // must-fail: a document without a top-level servers block is refused rather than served unchanged
    expect(() => servedApiDocument("openapi: 3.1.0\npaths: {}\n")).toThrow("no top-level servers block");
  });

  it("T-API-04 the page loads scripts and data from its own origin only, under a CSP", async () => {
    const { base } = await startService();
    const page = await send(base, "GET", "/docs");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp.split("; ")).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]));
    expect(csp).not.toMatch(/unsafe-eval|https?:/);
    expect(page.text).not.toMatch(/https?:\/\//);
    const init = await send(base, "GET", "/docs/swagger-initializer.js");
    expect(init.text).toContain('url: "/openapi.yaml"');
    expect(init.text).toContain("validatorUrl: null");
    // the bundle is the pinned swagger-ui-dist file, served by L2
    const bundle = await send(base, "GET", "/docs/swagger-ui-bundle.js");
    expect(bundle.text).toBe(readFileSync("node_modules/swagger-ui-dist/swagger-ui-bundle.js", "utf8"));
  });

  it("T-API-04 /docs/{asset} serves the three documented files and nothing else from the package", async () => {
    const { base } = await startService();
    const others = ["index.html", "package.json", "swagger-ui-bundle.js.map", "__proto__", "constructor", "..%2Fpackage.json", "%2E%2E%2Fservice.ts"];
    const statuses = await Promise.all(others.map(async (a) => `${a} ${(await send(base, "GET", `/docs/${a}`)).status}`));
    expect(statuses).toEqual(others.map((a) => `${a} 404`));
  });
});
