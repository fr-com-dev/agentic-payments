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

/** 016: an agent whose docs page signs in at a tenant (the tenant's name with the test's own keys). */
const TENANT = "https://x402-test.eu.auth0.com/";
const SIGN_IN = { API_DOCS: "1", AUTH_ISSUER: TENANT, AUTH_AUDIENCE: "https://x402-api/test", AUTH_JWKS_FILE: "", AGENT_CLIENT_IDS: "AgentDocsClient01", API_DOCS_CLIENT_ID: "AgentDocsClient01" };

type Doc = { servers: { url: string }[]; paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>; components: { securitySchemes: Record<string, unknown> } };
/** The committed document as an agent without a docs client serves it: no sign-in scheme, and no use of it. */
function withoutSignIn(doc: Doc): Doc {
  const { signIn: _scheme, ...schemes } = doc.components.securitySchemes;
  const paths = Object.fromEntries(
    Object.entries(doc.paths).map(([path, item]) => [
      path,
      Object.fromEntries(Object.entries(item).map(([method, op]) => [method, op.security ? { ...op, security: op.security.filter((s) => !("signIn" in s)) } : op])),
    ]),
  );
  return { ...doc, paths, components: { ...doc.components, securitySchemes: schemes } };
}

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
    // 016: the app takes a gate per run (`forCaller`); the outage is put on each of those.
    const forCaller = p.gate.forCaller.bind(p.gate);
    p.gate.forCaller = (callerToken) => {
      const gate = forCaller(callerToken);
      return {
        authorize: (intent) => gate.authorize(intent),
        budget: async (sessionId) => {
          if (o.budgetDown!()) throw new Error("L2 unreachable");
          return gate.budget(sessionId);
        },
      };
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
 * without agent:run gets 403 from a secured one; a token with it passes the guard everywhere.
 */
async function authMismatches(doc: OpenApiDoc, a: HostedTestApp): Promise<string[]> {
  const out: string[] = [];
  const withRole = await a.token("alice");
  const noRole = await a.token("mallory", { permissions: [] });
  for (const [method, path, op] of operations(doc)) {
    const open = op.security?.length === 0;
    const concrete = path.replace(/\{\w+\}/g, "x");
    const none = (await send(a.base, method, concrete)).status;
    if ((none === 401) === open) out.push(`${method} ${path} no token: ${none}`);
    if (!open) {
      const forbidden = (await send(a.base, method, concrete, noRole)).status;
      if (forbidden !== 403) out.push(`${method} ${path} without agent:run: ${forbidden}`);
    }
    const passed = (await send(a.base, method, concrete, withRole)).status;
    if (passed === 401 || passed === 403) out.push(`${method} ${path} with agent:run: ${passed}`);
  }
  return out;
}

describe("T-API-06 each operation's security matches the agent's guard", () => {
  it("T-API-06 POST /v1/runs needs a caller's token with agent:run; the health and docs routes need none", async () => {
    const a = await start();
    expect(await authMismatches(loadDoc(), a)).toEqual([]);
  });

  it("T-API-06 must-fail: a document calling /v1/runs open, or /healthz secured, is reported", async () => {
    const a = await start();
    const doc = loadDoc();
    doc.paths["/v1/runs"]!.post!.security = [];
    doc.paths["/healthz"]!.get!.security = [{ requesterBearer: [] }];
    expect(await authMismatches(doc, a)).toEqual(["POST /v1/runs no token: 401", "GET /healthz no token: 200", "GET /healthz without agent:run: 200"]);
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
    await runs({ goal: "no role" }, await a.token("mallory", { permissions: [] }));
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

  it("T-API-07 the run stream is documented as the run route's other 200 form, and its last event conforms to the Run schema (v1.17)", async () => {
    const doc = loadDoc();
    const content = responseContent(doc, "POST", "/v1/runs", 200)!;
    expect(Object.keys(content).sort()).toEqual(["application/json", "text/event-stream"]);
    const a = await start(DOCS, { model: mockModel([text("done")]) });
    const res = await fetch(`${a.base}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${await a.token("alice")}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ goal: "hi" }),
    });
    expect([res.status, res.headers.get("content-type")!.split(";")[0]]).toEqual([200, "text/event-stream"]);
    const blocks = (await res.text()).split("\n\n").filter((b) => b.startsWith("event: "));
    const names = blocks.map((b) => b.split("\n")[0]!.slice("event: ".length));
    // Only the four documented events.
    const documented = String((content["text/event-stream"]!.schema as { description?: string }).description);
    for (const name of new Set(names)) expect(documented, name).toContain(`| \`${name}\` |`);
    expect([names[0], names.at(-1)]).toEqual(["run", "result"]);
    const result = JSON.parse(blocks.at(-1)!.split("\n")[1]!.slice("data: ".length)) as unknown;
    expect(conformance(doc, content["application/json"]!.schema!, result)).toEqual([]);
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

describe("T-API-08 the docs routes are off by default, and in Azure only the agent can serve them, where its environment says so", () => {
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
      AUTH_ISSUER: "urn:x402:dev-issuer",
      AUTH_AUDIENCE: "api://x",
      AGENT_CLIENT_IDS: "agent-client",
      AUTH_JWKS_FILE: "unused.json",
      SESSION_REF_SECRET: randomBytes(32).toString("hex"),
    };
    expect([{}, { API_DOCS: "" }, { API_DOCS: "0" }, { API_DOCS: "1" }].map((e) => loadHostedConfig({ ...env, ...e }).apiDocs)).toEqual([false, false, false, true]);
    for (const bad of ["true", "yes", " 1"]) expect(() => loadHostedConfig({ ...env, API_DOCS: bad })).toThrow(ConfigError);
  });

  it("T-API-08 in Azure only the agent can serve the docs, and only where its environment's parameter file says so", () => {
    const files = [
      ...readdirSync("infra").filter((f) => /\.(bicep|bicepparam)$/.test(f)).map((f) => join("infra", f)),
      ...readdirSync("infra/modules").map((f) => join("infra/modules", f)),
      ...readdirSync(".github/workflows").map((f) => join(".github/workflows", f)),
    ];
    expect(files).toContain(".github/workflows/deploy.yml");
    expect(files).toContain("infra/main.bicep");
    // 016 (FR-032): the switch is named in one file, the agent's module, and no workflow sets it.
    const AGENT_MODULE = "infra/modules/l1-apps.bicep";
    expect(files.filter((f) => /API_DOCS/.test(readFileSync(f, "utf8")))).toEqual([AGENT_MODULE]);
    // There, outside comments, it is two env entries: the switch, which is the parameter file's agent.apiDocs and
    // nothing else, and the client the docs page signs people in through, the agent's own, only while the switch is on.
    const code = readFileSync(AGENT_MODULE, "utf8").split("\n").filter((l) => !l.trim().startsWith("//"));
    expect(code.filter((l) => /API_DOCS/.test(l)).map((l) => l.trim())).toEqual([
      "{ name: 'API_DOCS', value: agent.apiDocs ? '1' : '0' }",
      "{ name: 'API_DOCS_CLIENT_ID', value: agent.apiDocs ? agent.clientId : '' }",
    ]);
    // Both are in the agent's container, the one that runs the hosted service: no job gets them.
    const containers = code.join("\n").split(/\n {8}\{\n {10}name: '/).slice(1);
    expect(containers.map((c) => [c.slice(0, c.indexOf("'")), /API_DOCS/.test(c)])).toEqual([["agent", true], ["regression", false], ["smoke", false]]);
    expect(containers[0]).toContain("command: ['node', 'dist/src/hosted-main.js']");
    // Each environment decides in its own parameter file, with a literal true or false.
    const parameterFiles = readdirSync("infra").filter((f) => /^main\.[a-z0-9]+\.bicepparam$/.test(f));
    expect(parameterFiles).toContain("main.dev.bicepparam");
    for (const f of parameterFiles) expect(readFileSync(join("infra", f), "utf8"), f).toMatch(/^param agent = \{\n(?: {2}.*\n)*? {2}apiDocs: (?:true|false)\n/m);
  });

  it("T-API-08 the served document is the file with servers set to the serving agent", async () => {
    const a = await start();
    const res = await send(a.base, "GET", "/openapi.yaml");
    expect(res.type).toBe("application/yaml");
    const { servers, ...rest } = parse(res.text) as { servers: { url: string }[] };
    const { servers: fileServers, ...fileRest } = withoutSignIn(parse(readFileSync(HOSTED_API_DOCS_FILE, "utf8")) as Doc);
    expect(servers.map((s) => s.url)).toEqual(["/"]);
    expect(fileServers.map((s) => s.url)).toEqual(["http://127.0.0.1:4024"]);
    // 016: this agent has no docs client, so the sign-in scheme and its use are left out of what it serves.
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

  it("T-API-16 with a docs client, the page signs in at the tenant: the scheme names the tenant, the initializer uses PKCE with that client and the API, and nothing is persisted (016 SEC-34)", async () => {
    const a = await start(SIGN_IN);
    expect(a.config.auth.docsClientId).toBe("AgentDocsClient01");
    // The served document: the committed scheme with the tenant's two addresses, offered beside the bearer scheme.
    const served = parse((await send(a.base, "GET", "/openapi.yaml")).text) as Doc;
    expect(served.components.securitySchemes.signIn).toMatchObject({
      type: "oauth2",
      flows: { authorizationCode: { authorizationUrl: `${TENANT}authorize`, tokenUrl: `${TENANT}oauth/token`, scopes: {} } },
    });
    expect(served.paths["/v1/runs"]!.post!.security).toEqual([{ signIn: [] }, { requesterBearer: [] }]);
    // The sign-in comes first in the Authorize dialog, which lists the schemes in the document's order: after the
    // bearer scheme's long text, it sat below the fold and looked missing (2026-11-24).
    expect(Object.keys(served.components.securitySchemes)).toEqual(["signIn", "requesterBearer"]);
    const file = parse(readFileSync(HOSTED_API_DOCS_FILE, "utf8")) as Doc;
    expect(JSON.stringify(file)).toContain("https://sign-in-tenant.invalid/");
    expect(JSON.stringify(served)).not.toContain("sign-in-tenant.invalid");
    expect(JSON.parse(JSON.stringify(served).replaceAll(TENANT, "https://sign-in-tenant.invalid/"))).toEqual({ ...file, servers: served.servers });
    // The initializer: public values only, PKCE, the audience on the authorize address, the page's own redirect.
    const init = (await send(a.base, "GET", "/docs/swagger-initializer.js")).text;
    expect(init).toContain('oauth2RedirectUrl: window.location.origin + "/docs/oauth2-redirect.html"');
    const oauth = JSON.parse(init.match(/initOAuth\((\{.*\})\);/)![1]!) as Record<string, unknown>;
    expect(oauth).toEqual({ clientId: "AgentDocsClient01", usePkceWithAuthorizationCodeGrant: true, additionalQueryStringParams: { audience: "https://x402-api/test" } });
    expect(init).not.toMatch(/persistAuthorization|clientSecret|secret/i);
    // The redirect page and its script come from the pinned package, and the page holds no inline script.
    const redirect = await send(a.base, "GET", "/docs/oauth2-redirect.html");
    expect([redirect.status, redirect.type]).toEqual([200, "text/html"]);
    expect(redirect.text).toBe(readFileSync("node_modules/swagger-ui-dist/oauth2-redirect.html", "utf8"));
    expect(redirect.text.match(/<script[^>]*>/gi)).toEqual(['<script src="oauth2-redirect.js">']);
    expect((await send(a.base, "GET", "/docs/oauth2-redirect.js")).text).toBe(readFileSync("node_modules/swagger-ui-dist/oauth2-redirect.js", "utf8"));
    // The policy: the tenant's origin in connect-src and nowhere else; scripts from this origin only; on both pages.
    for (const page of [await send(a.base, "GET", "/docs"), redirect]) {
      const csp = (page.headers.get("content-security-policy") ?? "").split("; ");
      expect(csp).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'self'", "connect-src 'self' https://x402-test.eu.auth0.com", "frame-ancestors 'none'"]));
      expect(csp.filter((d) => /https?:/.test(d))).toEqual(["connect-src 'self' https://x402-test.eu.auth0.com"]);
      expect(csp.join("; ")).not.toMatch(/unsafe-eval/);
    }
    // Still token-free, static, and nothing else is served.
    expect((await send(a.base, "GET", "/docs/index.html")).status).toBe(404);
  });

  it("T-API-17 without a docs client the page is as before: no sign-in scheme, no redirect page, no origin but its own; and the dev issuer can't have one", async () => {
    const a = await start();
    const served = parse((await send(a.base, "GET", "/openapi.yaml")).text) as Doc;
    expect(Object.keys(served.components.securitySchemes)).toEqual(["requesterBearer"]);
    expect(served.paths["/v1/runs"]!.post!.security).toEqual([{ requesterBearer: [] }]);
    expect((await send(a.base, "GET", "/openapi.yaml")).text).not.toMatch(/sign-in:|sign-in-tenant|oauth2/);
    expect((await send(a.base, "GET", "/docs/swagger-initializer.js")).text).toBe('window.ui = SwaggerUIBundle({ url: "/openapi.yaml", dom_id: "#swagger-ui", validatorUrl: null });\n');
    for (const asset of ["oauth2-redirect.html", "oauth2-redirect.js"]) expect((await send(a.base, "GET", `/docs/${asset}`)).status, asset).toBe(404);
    expect((await send(a.base, "GET", "/docs")).headers.get("content-security-policy")).toContain("connect-src 'self';");
    // The local dev issuer has no sign-in page, so the service refuses a docs client with it.
    await expect(start({ API_DOCS: "1", API_DOCS_CLIENT_ID: "x402-agent-cli-dev" })).rejects.toThrow(/API_DOCS_CLIENT_ID needs the sign-in tenant/);
    // must-fail: a document without the scheme can't be served with sign-in, rather than offering a broken button
    expect(() => servedHostedApiDocument("openapi: 3.1.0\nservers:\n  - url: http://x\npaths: {}\n", { issuer: TENANT, clientId: "c", audience: "a" })).toThrow("no sign-in scheme to fill");
  });
});
