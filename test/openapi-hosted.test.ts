// L1 hosted agent API document against the running service (SPEC.md §8.1 L1-6; T-API-05..08).
// docs/l1-hosted.openapi.yaml is a copy of L1-6 for tools. These tests fail when the copy and the service disagree on
// routes (T-API-05), auth (T-API-06) or response statuses, headers and shapes (T-API-07). T-API-08 covers the
// token-free Swagger UI routes on the agent: off by default, never set in Azure, same-origin only (SEC-13).
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import express from "express";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HOSTED_API_DOCS_FILE, servedHostedApiDocument } from "../src/layer1-intent/hosted/api-docs.js";
import { loadHostedConfig } from "../src/layer1-intent/hosted/config.js";
import { ConfigError } from "../src/shared/config.js";
import type { AuthorizationDecision, PaymentIntent } from "../src/shared/contracts.js";
import { fakePorts, mockModel, startHostedApp, text, toolCall, type HostedTestApp } from "./helpers/hosted.js";
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
  send,
} from "./helpers/openapi.js";

const DOC_FILE = "docs/l1-hosted.openapi.yaml";
const loadDoc = () => loadDocFile(DOC_FILE);
const DOCS = { API_DOCS: "1" };

const REQ = {
  scheme: "exact",
  network: "eip155:31337",
  asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  amount: "1000",
  payTo: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  maxTimeoutSeconds: 120,
  extra: { name: "USD Coin", version: "2" },
};

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

/** A seller: /api/catalog is free; /api/weather, /api/premium and /api/export ask for a payment. */
async function seller(): Promise<string> {
  const app = express();
  app.get("/api/catalog", (_req, res) => res.json({ items: ["weather", "premium", "export"] }));
  for (const path of ["/api/weather", "/api/premium", "/api/export"]) {
    app.get(path, (req, res) => {
      if (req.headers["payment-signature"]) {
        res.json({ city: "Lima", tempC: 18 });
        return;
      }
      const url = `http://${req.headers.host}${req.originalUrl}`;
      res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({ x402Version: 2, resource: { url }, accepts: [REQ] } as never)).json({});
    });
  }
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** L2 as a fake: weather is authorized, premium escalates, export is denied. L3 confirms every settlement. */
function ports(o: { budgetDown?: () => boolean } = {}) {
  const decide = (intent: PaymentIntent): AuthorizationDecision => {
    const path = new URL(intent.resourceUrl).pathname;
    if (path === "/api/weather") {
      return {
        status: "AUTHORIZED",
        authorizationId: "auth_paid",
        intentId: intent.intentId,
        requirement: REQ as never,
        paymentHeaders: { "PAYMENT-SIGNATURE": "opaque" },
        payer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        validBefore: 1_900_000_000,
        remainingSessionBudgetAtomic: "99000",
      };
    }
    const escalate = path === "/api/premium";
    return {
      status: escalate ? "ESCALATE" : "DENIED",
      authorizationId: escalate ? "auth_escalated" : "auth_denied",
      intentId: intent.intentId,
      violations: [escalate ? { rule: "human_approval_required", detail: "above auto-approve" } : { rule: "per_payment_cap", detail: "above cap" }],
    };
  };
  const p = fakePorts({
    authorize: async (intent) => decide(intent),
    verify: async (claim) => ({
      authorizationId: claim.authorizationId,
      status: "CONFIRMED",
      transaction: `0x${"ab".repeat(32)}`,
      network: REQ.network,
      finalityClass: "included",
      detail: "transfer log matches",
      observedAt: new Date().toISOString(),
      verified: { asset: REQ.asset, payer: claim.payer, payTo: REQ.payTo, amount: REQ.amount },
    }),
  });
  if (o.budgetDown) {
    const budget = p.gate.budget.bind(p.gate);
    p.gate.budget = async (sessionId) => {
      if (o.budgetDown!()) throw new Error("L2 unreachable");
      return budget(sessionId);
    };
  }
  return p;
}

/** The model's next turns, one function per model call; an empty script answers text("done"). */
type Turn = () => Promise<LanguageModelV3GenerateResult>;
function scriptedModel() {
  const script: Turn[] = [];
  let calls = 0;
  let down = false;
  const model = mockModel(async () => {
    calls++;
    // Down: every call throws, the SDK's retries included.
    if (down) throw new Error("model unavailable");
    return (script.shift() ?? (async () => text("done")))();
  });
  const push = (...turns: (LanguageModelV3GenerateResult | Turn)[]) => {
    for (const t of turns) script.push(typeof t === "function" ? t : async () => t);
  };
  return {
    model,
    push,
    calls: () => calls,
    setDown: (d: boolean) => {
      down = d;
    },
  };
}

async function start(env: Record<string, string> = DOCS, extra: Parameters<typeof startHostedApp>[0] = {}): Promise<HostedTestApp> {
  const app = await startHostedApp({ env, ...extra });
  cleanups.push(() => app.close());
  return app;
}

// ---------------------------------------------------------------------------------------------------------------
// T-API-05 routes
// ---------------------------------------------------------------------------------------------------------------

describe("T-API-05 every hosted agent route is documented, and every documented route is mounted", () => {
  it("T-API-05 the document's operations equal the routes mounted on the agent (API_DOCS=1)", async () => {
    const { app } = await start();
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-05 without API_DOCS, the mounted routes are exactly the documented non-docs operations", async () => {
    const { app } = await start({});
    const doc = loadDoc();
    expect(routeDiff(documentedRoutes(doc, (op) => !isDocsRoute(op)), mountedRoutes(app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-05 must-fail: a route missing from the document, or documented but not mounted, is reported", async () => {
    const { app } = await start();
    const doc = loadDoc();
    delete doc.paths["/readyz"];
    doc.paths["/v1/runs/{runId}"] = { get: { responses: {} } };
    expect(routeDiff(documentedRoutes(doc), mountedRoutes(app))).toEqual({ undocumented: ["GET /readyz"], unmounted: ["GET /v1/runs/:runId"] });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-API-06 auth
// ---------------------------------------------------------------------------------------------------------------

/**
 * For each operation: without a token, a secured one answers 401 and an open one (`security: []`) doesn't; a token
 * without Agent.Run gets 403 from a secured one; a token with it passes the guard everywhere.
 */
async function authMismatches(doc: OpenApiDoc, a: HostedTestApp): Promise<string[]> {
  const out: string[] = [];
  const withRole = await a.token("alice");
  const noRole = await a.token("mallory", { roles: [] });
  for (const [method, path, op] of operations(doc)) {
    const open = op.security?.length === 0;
    const concrete = path.replace(/\{\w+\}/g, "x");
    const none = (await send(a.base, method, concrete)).status;
    if ((none === 401) === open) out.push(`${method} ${path} no token: ${none}`);
    if (!open) {
      const forbidden = (await send(a.base, method, concrete, noRole)).status;
      if (forbidden !== 403) out.push(`${method} ${path} without Agent.Run: ${forbidden}`);
    }
    const passed = (await send(a.base, method, concrete, withRole)).status;
    if (passed === 401 || passed === 403) out.push(`${method} ${path} with Agent.Run: ${passed}`);
  }
  return out;
}

describe("T-API-06 each operation's security matches the agent's guard", () => {
  it("T-API-06 POST /v1/runs needs an Agent.Run token; the health and docs routes need none", async () => {
    const a = await start();
    expect(await authMismatches(loadDoc(), a)).toEqual([]);
  });

  it("T-API-06 must-fail: a document calling /v1/runs open, or /healthz secured, is reported", async () => {
    const a = await start();
    const doc = loadDoc();
    doc.paths["/v1/runs"]!.post!.security = [];
    doc.paths["/healthz"]!.get!.security = [{ entraBearer: [] }];
    expect(await authMismatches(doc, a)).toEqual(["POST /v1/runs no token: 401", "GET /healthz no token: 200", "GET /healthz without Agent.Run: 200"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-API-07 statuses, headers and shapes
// ---------------------------------------------------------------------------------------------------------------

describe("T-API-07 live responses match the documented status, headers and schema", () => {
  it("T-API-07 a scenario reaching every documented status conforms to the document", async () => {
    const doc = loadDoc();
    const sellerUrl = await seller();
    let budgetDown = false;
    const p = ports({ budgetDown: () => budgetDown });
    const m = scriptedModel();
    const a = await start({ ...DOCS, SELLER_URL: sellerUrl }, { model: m.model, gate: p.gate, settlement: p.settlement, ready: false });
    const seen = new Set<string>();
    const errors: string[] = [];
    const call = async (method: string, path: string, o: { token?: string; body?: unknown; params?: Record<string, string> } = {}) => {
      const concrete = path.replace(/\{(\w+)\}/g, (_, k: string) => o.params?.[k] ?? "x");
      const res = await send(a.base, method, concrete, o.token, o.body);
      seen.add(`${method} ${path} ${res.status}`);
      const documented = documentedResponse(doc, method, path, res.status);
      const schema = responseContent(doc, method, path, res.status)?.[res.type]?.schema;
      if (!documented) errors.push(`${method} ${path}: status ${res.status} not documented`);
      else if (!schema) errors.push(`${method} ${path} ${res.status}: media type ${res.type} not documented`);
      else {
        errors.push(...conformance(doc, schema, res.type === "application/json" ? res.body : res.text).map((e) => `${method} ${path} ${res.status} ${e}`));
        for (const [h, d] of Object.entries(documented.headers ?? {})) if ((d as { required?: boolean }).required && !res.headers.has(h)) errors.push(`${method} ${path} ${res.status}: no ${h} header`);
      }
      return res.body;
    };
    const alice = await a.token("alice");
    const runs = (body: unknown, token = alice) => call("POST", "/v1/runs", { token, body });
    const fetchTurn = (path: string) => toolCall("fetch_resource", { url: `${sellerUrl}${path}`, purpose: `buy ${path}` });

    // health: not ready, then ready
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    a.markReady();
    await call("GET", "/readyz");

    // a completed run with every fetch outcome the fakes produce, and a budget read
    m.push(fetchTurn("/api/catalog"), fetchTurn("/api/weather"), fetchTurn("/api/premium"), fetchTurn("/api/export"), toolCall("check_budget", {}), text("Receipts: weather 0.001"));
    const first = await runs({ goal: "Get the weather for Lima" });
    expect(first.status).toBe("completed");
    const outcomes = (first.steps as { result: { outcome?: string } }[]).map((s) => s.result.outcome ?? "budget");
    expect(outcomes).toEqual(["FREE", "PAID", "ESCALATED", "DENIED", "budget"]);

    // the same session again; a tool that throws; a failed run; a run stopped at the step limit
    await runs({ goal: "And a market brief", sessionRef: first.sessionRef });
    budgetDown = true;
    m.push(toolCall("check_budget", {}), text("L2 is down"));
    const toolError = await runs({ goal: "How much is left?" });
    budgetDown = false;
    expect((toolError.steps as { result: Record<string, unknown> }[])[0]!.result).toEqual({ error: "L2 unreachable" });
    m.setDown(true);
    expect((await runs({ goal: "Anything" })).status).toBe("failed");
    m.setDown(false);
    m.push(...Array.from({ length: 10 }, () => toolCall("check_budget", {})));
    const stopped = await runs({ goal: "Keep checking the budget" });
    expect([stopped.status, stopped.stopReason]).toEqual(["stopped", "step_limit"]);

    // refusals: body, token, role, session, size
    await runs({ goal: "" });
    await call("POST", "/v1/runs", { body: { goal: "no token" } });
    await runs({ goal: "no role" }, await a.token("mallory", { roles: [] }));
    await runs({ goal: "not my session", sessionRef: first.sessionRef }, await a.token("bob"));
    await runs(JSON.stringify({ goal: "x".repeat(17_000) }));

    // 429: two runs held in the model, then a third start for the same requester
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const hold: (() => Promise<LanguageModelV3GenerateResult>) = async () => {
      await held;
      return text("done");
    };
    m.push(hold, hold);
    const before = m.calls();
    const pending = [runs({ goal: "held 1" }), runs({ goal: "held 2" })];
    for (let i = 0; i < 100 && m.calls() < before + 2; i++) await new Promise((r) => setTimeout(r, 10));
    await runs({ goal: "one too many" });
    release();
    await Promise.all(pending);

    // docs (API_DOCS=1): the page, every documented asset, an unknown asset and the document itself
    await call("GET", "/docs");
    const assetParam = doc.paths["/docs/{asset}"]!.get!.parameters!.find((x) => x.name === "asset")!;
    for (const asset of assetParam.schema.enum as string[]) await call("GET", "/docs/{asset}", { params: { asset } });
    await call("GET", "/docs/{asset}", { params: { asset: "index.html" } });
    await call("GET", "/openapi.yaml");

    expect(errors).toEqual([]);
    const documented = operations(doc).flatMap(([meth, path, op]) => Object.keys(op.responses).map((s) => `${meth} ${path} ${s}`));
    expect(documented.filter((d) => !seen.has(d))).toEqual([]);
  });

  it("T-API-07 must-fail: a missing field, a wrong value, an undocumented field and a mixed-up step are reported", () => {
    const doc = loadDoc();
    const run = { $ref: "#/components/schemas/Run" };
    const ok = {
      runId: "run_3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      sessionRef: `sr1.sess_0123456789abcdef.${"A".repeat(43)}`,
      status: "completed",
      stopReason: null,
      error: null,
      finalText: "Receipts: none",
      steps: [{ index: 1, tool: "check_budget", result: { error: "L2 unreachable" } }],
      startedAt: "2026-11-04T13:17:07.575Z",
      finishedAt: "2026-11-04T13:17:47.024Z",
    };
    expect(conformance(doc, run, ok)).toEqual([]);
    const { finalText: _, ...missing } = ok;
    expect(
      conformance(doc, run, { ...missing, status: "done", error: 3, cost: "0.001", steps: [{ index: 1, tool: "check_budget", url: "https://x", result: {} }] }),
    ).toEqual([
      "$.finalText: missing",
      '$.status: "done" not in enum',
      "$.error: expected string or null",
      "$.steps[0]: matches 0 oneOf branches",
      "$.cost: not documented",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-API-08 Swagger UI on the agent
// ---------------------------------------------------------------------------------------------------------------

describe("T-API-08 Swagger UI on the agent is opt-in, never set in Azure, same-origin and fixed (SEC-13)", () => {
  const DOCS_PROBES = ["/docs", "/docs/swagger-ui-bundle.js", "/docs/swagger-initializer.js", "/openapi.yaml"];
  const probe = async (base: string, token?: string) => Promise.all(DOCS_PROBES.map(async (p) => `${p} ${(await send(base, "GET", p, token)).status}`));

  it("T-API-08 off by default: no docs route is mounted; docs URLs answer 401 without a token and 404 with one", async () => {
    const a = await start({});
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(a.app)).unmounted).toEqual(["GET /docs", "GET /docs/:asset", "GET /openapi.yaml"]);
    expect(await probe(a.base)).toEqual(DOCS_PROBES.map((p) => `${p} 401`));
    expect(await probe(a.base, await a.token("alice"))).toEqual(DOCS_PROBES.map((p) => `${p} 404`));
  });

  it("T-API-08 must-fail: with API_DOCS=1 the same probe gets every docs URL without a token, and touches no model or L2", async () => {
    const m = scriptedModel();
    const p = ports();
    const a = await start(DOCS, { model: m.model, gate: p.gate, settlement: p.settlement });
    expect(await probe(a.base)).toEqual(DOCS_PROBES.map((x) => `${x} 200`));
    expect([m.calls(), p.gateCalls.length, p.settlementCalls.length]).toEqual([0, 0, 0]);
  });

  it("T-API-08 API_DOCS accepts 1, 0 or empty in env/l1-hosted.env; anything else is a startup error", () => {
    const env = {
      NETWORK: "local",
      MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      AUTH_TENANT_ID: "dev",
      AUTH_AUDIENCE: "api://x",
      AUTH_JWKS_FILE: "unused.json",
      SESSION_REF_SECRET: randomBytes(32).toString("hex"),
    };
    expect([{}, { API_DOCS: "" }, { API_DOCS: "0" }, { API_DOCS: "1" }].map((e) => loadHostedConfig({ ...env, ...e }).apiDocs)).toEqual([false, false, false, true]);
    for (const bad of ["true", "yes", " 1"]) expect(() => loadHostedConfig({ ...env, API_DOCS: bad })).toThrow(ConfigError);
  });

  it("T-API-08 the Azure deployment never sets API_DOCS on the agent", () => {
    const files = [
      ...readdirSync("infra").filter((f) => /\.(bicep|bicepparam)$/.test(f)).map((f) => join("infra", f)),
      ...readdirSync("infra/modules").map((f) => join("infra/modules", f)),
      ".github/workflows/deploy.yml",
    ];
    expect(files).toContain("infra/modules/l1-apps.bicep");
    expect(files.filter((f) => /API_DOCS/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("T-API-08 the served document is the file with servers set to the serving agent", async () => {
    const a = await start();
    const res = await send(a.base, "GET", "/openapi.yaml");
    expect(res.type).toBe("application/yaml");
    const { servers, ...rest } = parse(res.text) as { servers: { url: string }[] };
    const { servers: fileServers, ...fileRest } = parse(readFileSync(HOSTED_API_DOCS_FILE, "utf8")) as { servers: { url: string }[] };
    expect(servers.map((s) => s.url)).toEqual(["/"]);
    expect(fileServers.map((s) => s.url)).toEqual(["http://127.0.0.1:4024"]);
    expect(rest).toEqual(fileRest);
    // must-fail: a document without a top-level servers block is refused rather than served unchanged
    expect(() => servedHostedApiDocument("openapi: 3.1.0\npaths: {}\n")).toThrow("no top-level servers block");
  });

  it("T-API-08 the page loads scripts and data from its own origin only, under a CSP, and serves no other file", async () => {
    const a = await start();
    const page = await send(a.base, "GET", "/docs");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp.split("; ")).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]));
    expect(csp).not.toMatch(/unsafe-eval|https?:/);
    expect(page.text).not.toMatch(/https?:\/\//);
    expect(page.text).toContain("<title>L1 hosted agent API</title>");
    const bundle = await send(a.base, "GET", "/docs/swagger-ui-bundle.js");
    expect(bundle.text).toBe(readFileSync("node_modules/swagger-ui-dist/swagger-ui-bundle.js", "utf8"));
    const others = ["index.html", "package.json", "swagger-ui-bundle.js.map", "__proto__", "..%2Fpackage.json"];
    const statuses = await Promise.all(others.map(async (x) => `${x} ${(await send(a.base, "GET", `/docs/${x}`)).status}`));
    expect(statuses).toEqual(others.map((x) => `${x} 404`));
  });
});
