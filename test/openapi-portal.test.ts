// Portal API document against the running portal (SPEC.md §8.2 L2-8; T-API-12..15).
// docs/portal.openapi.yaml is a copy of specs/013 contracts/portal-api.md for tools. These tests fail when the copy
// and the portal disagree on routes (T-API-12), the bearer scheme (T-API-13) or response statuses and shapes
// (T-API-14). T-API-15 covers the token-free Swagger UI routes: off by default, same-origin only (SEC-13).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PORTAL_API_DOCS_FILE, servedPortalApiDocument } from "../src/portal/api-docs.js";
import { startCardVaultStub, type CardVaultStub } from "./helpers/card-vault-stub.js";
import {
  conformance,
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
import { startPortal, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";
import { OTHER_HOST, SELLER_HOST, STEP_UP_AGE, T0 } from "./helpers/users.js";

const DOC_FILE = "docs/portal.openapi.yaml";
const loadDoc = () => loadDocFile(DOC_FILE);
const DOCS = { API_DOCS: "1" };
/**
 * Statuses every signed-in route can answer for reasons that have nothing to do with the route: the request limit,
 * L2 unreachable, an oversized body. T-PRT-01, T-PRT-06 and T-PRT-07 reach them; here one example of each is checked
 * against the document, and the scenario must reach every other documented status of every operation.
 */
const GENERIC = new Set(["429", "502", "413"]);

let portals: PortalTestApp[] = [];
let stubs: CardVaultStub[] = [];
afterEach(async () => {
  await Promise.all(portals.map((p) => p.close()));
  await Promise.all(stubs.map((s) => s.close()));
  portals = [];
  stubs = [];
});

/** v1.15: the administration operations (tag `administration`), mounted only with `PORTAL_ADMIN=1`. */
const isAdminRoute = (op: { tags?: string[] }) => op.tags?.includes("administration") === true;

/** The full surface: the administration area is on here unless a test says `admin: false`. */
async function start(o: StartPortalOptions = {}) {
  const p = await startPortal({ admin: true, ...o });
  portals.push(p);
  return p;
}
async function startWithVault(o: StartPortalOptions = {}) {
  const vault = await startCardVaultStub();
  stubs.push(vault);
  return { p: await start({ vault, ...o }), vault };
}

const PROFILE = { displayName: "Ana Pérez", contactEmail: "ana.perez@example.com", acknowledgedTestFunds: true };
const POLICY = {
  name: "Research APIs",
  sellers: [SELLER_HOST],
  autoApproveUsdc: "0.02",
  perPaymentUsdc: "0.10",
  perRunUsdc: "0.10",
  perDayUsdc: "0.50",
  paymentsPerMinute: 10,
  endsOn: "2026-12-31",
  paymentMethod: "crypto_account",
};

describe("T-API-12 every portal route is documented, and every documented route is mounted", () => {
  it("T-API-12 the document's operations equal the routes mounted on the portal (API_DOCS=1)", async () => {
    const p = await start({ env: DOCS });
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(p.app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-12 without API_DOCS, the mounted routes are exactly the documented non-docs operations", async () => {
    const p = await start();
    expect(routeDiff(documentedRoutes(loadDoc(), (op) => !isDocsRoute(op)), mountedRoutes(p.app))).toEqual({ undocumented: [], unmounted: [] });
  });

  it("T-API-12 without PORTAL_ADMIN, the administration operations are not mounted and everything else is (v1.15)", async () => {
    const p = await start({ admin: false });
    const doc = loadDoc();
    expect(routeDiff(documentedRoutes(doc, (op) => !isDocsRoute(op) && !isAdminRoute(op)), mountedRoutes(p.app))).toEqual({ undocumented: [], unmounted: [] });
    expect(documentedRoutes(doc, isAdminRoute).length).toBeGreaterThan(0);
    const token = await p.adminToken("dana");
    for (const [method, path, op] of operations(doc)) {
      if (isAdminRoute(op)) expect((await send(p.base, method, path.replace(/\{\w+\}/g, "x"), token)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("T-API-12 no operation takes a user identifier: not in a path, a query or a body schema (FR-004)", () => {
    const doc = loadDoc();
    const text = readFileSync(DOC_FILE, "utf8");
    for (const [, path, op] of operations(doc)) {
      expect(path).not.toMatch(/user/i);
      for (const param of op.parameters ?? []) expect(String((param as { name?: string }).name ?? "")).not.toMatch(/user/i);
    }
    // `userId` appears once: in the answer of /api/me, never in a request.
    const requestSchemas = ["ProfileInput", "PolicyInput", "PolicyChange", "CardConfirm", "DisableRequest"];
    for (const name of requestSchemas) {
      expect(Object.keys(doc.components.schemas[name]!.properties ?? {}), name).not.toContain("userId");
      expect(doc.components.schemas[name]!.additionalProperties, name).toBe(false);
    }
    expect(text.match(/userId/g)?.length).toBeGreaterThan(0);
  });

  it("T-API-12 must-fail: a route missing from the document, or documented but not mounted, is reported", async () => {
    const p = await start({ env: DOCS });
    const doc = loadDoc();
    delete doc.paths["/api/account/enable"];
    doc.paths["/api/withdrawals"] = { post: { responses: {} } };
    expect(routeDiff(documentedRoutes(doc), mountedRoutes(p.app))).toEqual({
      undocumented: ["POST /api/account/enable"],
      unmounted: ["POST /api/withdrawals"],
    });
  });
});

describe("T-API-13 the person's token is the only credential, exactly where documented", () => {
  /** For each operation: no token, a portal token, an agent-service token. Passes the access check iff documented. */
  async function mismatches(doc: OpenApiDoc, p: PortalTestApp): Promise<string[]> {
    const out: string[] = [];
    const portalToken = await p.token("alice");
    const adminToken = await p.adminToken("dana");
    const agentToken = await p.agentToken("alice");
    for (const [method, path, op] of operations(doc)) {
      const open = op.security?.length === 0;
      const concrete = path.replace(/\{\w+\}/g, "x");
      const none = (await send(p.base, method, concrete)).status;
      const agent = (await send(p.base, method, concrete, agentToken)).status;
      // v1.15: an administration operation needs the administrator's token; a user's own token is 403 there.
      const person = (await send(p.base, method, concrete, isAdminRoute(op) ? adminToken : portalToken)).status;
      if (isAdminRoute(op)) {
        const user = (await send(p.base, method, concrete, portalToken)).status;
        if (user !== 403) out.push(`${method} ${path} a user's token: ${user}`);
      }
      if (open) {
        if (none === 401 || none === 403) out.push(`${method} ${path}: documented open, got ${none}`);
        continue;
      }
      if (none !== 401) out.push(`${method} ${path} no token: ${none}`);
      if (agent !== 403) out.push(`${method} ${path} agent-service token: ${agent}`);
      if (person === 401 || person === 403) out.push(`${method} ${path} portal token: ${person}`);
    }
    return out;
  }

  it("T-API-13 no token gets 401, an agent-service token 403, the person's portal token passes; open routes need none", async () => {
    const p = await start({ env: DOCS });
    expect(await mismatches(loadDoc(), p)).toEqual([]);
  });

  it("T-API-13 must-fail: a document that calls a protected route open, or an open one protected, is reported", async () => {
    const p = await start({ env: DOCS });
    const doc = loadDoc();
    doc.paths["/api/me"]!.get!.security = [];
    doc.paths["/api/config"]!.get!.security = [{ personToken: [] }];
    expect(await mismatches(doc, p)).toEqual(["GET /api/config no token: 200", "GET /api/config agent-service token: 200", "GET /api/me: documented open, got 401"]);
  });
});

describe("T-API-14 live responses match the documented status and schema", () => {
  it("T-API-14 a scenario reaching every documented status (except the generic ones) conforms to the document", async () => {
    const doc = loadDoc();
    const { p, vault } = await startWithVault({ env: DOCS });
    const seen = new Set<string>();
    const errors: string[] = [];
    const tokens = {
      alice: await p.token("alice"),
      stale: await p.token("alice", { authTime: Math.floor(T0 / 1000) - STEP_UP_AGE - 1 }),
      bob: await p.token("bob"),
      carol: await p.token("carol"),
      agent: await p.agentToken("alice"),
      // v1.15: an administrator who is also a user, and one who is only an administrator
      admin: await p.adminToken("dana"),
      adminStale: await p.adminToken("dana", { authTime: Math.floor(T0 / 1000) - STEP_UP_AGE - 1 }),
      adminOnly: await p.adminToken("erin"),
    };
    const call = async (method: string, path: string, o: { as?: keyof typeof tokens | null; params?: Record<string, string>; query?: string; body?: unknown } = {}) => {
      const concrete = path.replace(/\{(\w+)\}/g, (_, k: string) => o.params?.[k] ?? "x") + (o.query ?? "");
      const who = o.as === undefined ? "alice" : o.as;
      const res = await send(p.base, method, concrete, who === null ? undefined : tokens[who], o.body);
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
    const pol = (policyId: string) => ({ params: { policyId } });

    // health, public config, the person
    await call("GET", "/healthz", { as: null });
    await call("GET", "/readyz", { as: null });
    await call("GET", "/api/config", { as: null });
    await call("GET", "/api/me");

    // profile
    await call("PUT", "/api/profile", { body: { ...PROFILE, role: "admin" } });
    await call("PUT", "/api/profile", { body: { displayName: "", contactEmail: "nope" } });
    await call("PUT", "/api/profile", { body: PROFILE });
    await call("PUT", "/api/profile", { as: "carol", body: PROFILE });
    await call("GET", "/api/me");
    await call("GET", "/api/platform");

    // wallet: bob has no profile; alice creates her account
    await call("GET", "/api/wallet", { as: "bob" });
    await call("PUT", "/api/wallet/account", { as: "bob" });
    await call("PUT", "/api/wallet/account");
    await call("GET", "/api/wallet");

    // policies: every refusal of a create, then the create
    await call("POST", "/api/policies", { body: { ...POLICY, sellers: "x" } });
    await call("POST", "/api/policies", { body: { ...POLICY, perDayUsdc: "9.99", autoApproveUsdc: "0.0000001" } });
    await call("POST", "/api/policies", { body: { ...POLICY, perDayUsdc: "9.99" } });
    await call("POST", "/api/policies", { as: "stale", body: POLICY });
    await call("POST", "/api/policies", { as: "carol", body: POLICY });
    const p1 = String((await call("POST", "/api/policies", { body: POLICY })).policyId);
    await call("GET", "/api/policies");
    await call("GET", "/api/policies/{policyId}", pol(p1));
    await call("GET", "/api/policies/{policyId}", pol("pol_unknown"));

    // change: malformed, unknown, loosening without a fresh sign-in, invalid, tightened, then a stale version
    const change = (policyId: string, body: unknown, as: keyof typeof tokens = "alice") => call("PUT", "/api/policies/{policyId}", { ...pol(policyId), body, as });
    await change(p1, POLICY);
    await change("pol_unknown", { ...POLICY, perDayUsdc: "0.30", expectedVersion: 1 });
    await change(p1, { ...POLICY, sellers: [SELLER_HOST, OTHER_HOST], expectedVersion: 1 }, "stale");
    await change(p1, { ...POLICY, sellers: [SELLER_HOST, "unlisted.example"], expectedVersion: 1 });
    expect((await change(p1, { ...POLICY, perDayUsdc: "0.30", expectedVersion: 1 })).version).toBe(2);
    expect((await change(p1, { ...POLICY, perDayUsdc: "0.20", expectedVersion: 1 })).error).toBe("version_conflict");

    // pause, resume, and a resume that conflicts with a newer policy for the same seller
    const act = (action: string, policyId: string, as: keyof typeof tokens = "alice") => call("POST", `/api/policies/{policyId}/${action}`, { ...pol(policyId), as });
    await act("pause", p1);
    await act("pause", "pol_unknown");
    await act("resume", p1, "stale");
    await act("resume", p1);
    await act("resume", "pol_unknown");
    await act("remove", "pol_unknown");
    await act("pause", p1);
    const p2 = String((await call("POST", "/api/policies", { body: POLICY })).policyId);
    expect((await act("resume", p1)).error).toBe("invalid_policy");

    // cards: bob has no profile; then the whole add, each refusal, and a removal
    await call("POST", "/api/cards/setup", { as: "bob" });
    const setup = async () => String((await call("POST", "/api/cards/setup")).clientSecret).split("_secret_")[0]!;
    const first = await setup();
    await call("POST", "/api/cards", { body: { setupIntentId: first } });
    vault.confirm(first, { last4: "4242", fingerprint: "fp_1" });
    const card = await call("POST", "/api/cards", { body: { setupIntentId: first, nickname: "Travel" } });
    await call("POST", "/api/cards", { body: { setupIntentId: 7 } });
    await call("POST", "/api/cards", { body: { setupIntentId: "seti_unknown" } });
    const old = await setup();
    vault.confirm(old, { expMonth: 1, expYear: 2020 });
    await call("POST", "/api/cards", { body: { setupIntentId: old } });
    const declined = await setup();
    vault.fail(declined, "card_declined");
    expect((await call("POST", "/api/cards", { body: { setupIntentId: declined } })).vaultCode).toBe("card_declined");
    await call("GET", "/api/wallet");
    await call("DELETE", "/api/cards/{cardId}", { params: { cardId: "card_00000000-0000-4000-8000-000000000009" } });
    // the vault fails: card routes answer 503, nothing else is affected
    vault.setMode({ kind: "down" });
    await call("POST", "/api/cards/setup");
    await call("POST", "/api/cards", { body: { setupIntentId: first } });
    await call("DELETE", "/api/cards/{cardId}", { params: { cardId: String(card.cardId) } });
    await call("GET", "/api/wallet");
    vault.setMode({ kind: "ok" });
    await call("DELETE", "/api/cards/{cardId}", { params: { cardId: String(card.cardId) } });

    // the account: bob can't disable or enable; alice disables, and every policy write then conflicts
    await call("POST", "/api/account/disable", { body: {} });
    await call("POST", "/api/account/disable", { as: "bob", body: { confirm: true } });
    await call("POST", "/api/account/enable", { as: "bob" });
    expect((await call("POST", "/api/account/disable", { body: { confirm: true } })).enabled).toBe(false);
    await act("remove", p2);
    await act("pause", p2);
    await act("resume", p1);
    expect((await change(p2, { ...POLICY, perDayUsdc: "0.10", expectedVersion: 1 })).error).toBe("account_disabled");
    await call("POST", "/api/policies", { body: { ...POLICY, sellers: [OTHER_HOST] } });
    await call("PUT", "/api/wallet/account", { as: "carol" });
    await call("POST", "/api/account/enable", { as: "stale" });
    expect((await call("POST", "/api/account/enable")).enabled).toBe(true);
    expect((await act("remove", p2)).state).toBe("removed");

    // v1.15 the administration area: who the administrator is, then every operation and each of its statuses
    await call("GET", "/api/me", { as: "adminOnly" });
    await call("GET", "/api/admin/escalations", { as: "admin" });
    await call("GET", "/api/admin/escalations");
    // the two decisions: each refusal, then the decision, a repeat, and the opposite decision on a decided one
    const escalated = async (sessionId: string, subject?: string) => {
      const userId = subject === undefined ? undefined : p.userId(subject);
      const r = await p.l2.authorize(p.l2.intentFor("/api/premium-report", "50000", { sessionId, ...(userId !== undefined && { userId }) }));
      expect(r.body.status, sessionId).toBe("ESCALATE");
      return { params: { authorizationId: r.body.authorizationId } };
    };
    const APPROVE = "/api/admin/escalations/{authorizationId}/approve";
    const REJECT = "/api/admin/escalations/{authorizationId}/reject";
    const unknown = { params: { authorizationId: "auth_00000000-0000-4000-8000-000000000000" } };
    await p.l2.onboard(p.userId("dana"));
    const own = await escalated("sess_dana", "dana");
    const e1 = await escalated("sess_adm_1");
    const e2 = await escalated("sess_adm_2");
    await call("POST", APPROVE, { as: "admin", params: { authorizationId: "nope" } });
    const EVENTS = "/api/admin/escalations/events";
    await call("POST", APPROVE, { as: "admin", ...e1, body: { decidedBy: p.userId("bob") } });
    await call("POST", APPROVE, { as: "admin", ...unknown });
    await call("POST", APPROVE, { as: "admin", ...own });
    await call("POST", APPROVE, { as: "adminStale", ...e1 });
    expect((await call("POST", APPROVE, { as: "admin", ...e1 })).already).toBe(false);
    expect((await call("POST", APPROVE, { as: "adminOnly", ...e1 })).already).toBe(true);
    await call("POST", REJECT, { as: "admin", ...e2, body: { reason: "typed text" } });
    await call("POST", REJECT, { as: "admin", ...unknown, body: { reasonCode: "other" } });
    await call("POST", REJECT, { as: "admin", ...own, body: { reasonCode: "other" } });
    expect((await call("POST", REJECT, { as: "admin", ...e2, body: { reasonCode: "wrong_seller" } })).already).toBe(false);
    expect((await call("POST", REJECT, { as: "adminOnly", ...e2, body: { reasonCode: "wrong_seller" } })).already).toBe(true);
    expect((await call("POST", REJECT, { as: "admin", ...e1, body: { reasonCode: "other" } })).error).toBe("not_pending");
    expect((await call("POST", APPROVE, { as: "admin", ...e2 })).error).toBe("not_pending");
    // one payment in any state with its budget: decided, the administrator's own, unknown and malformed
    const ONE = "/api/admin/escalations/{authorizationId}";
    for (const which of [e1, e2, own]) expect((await call("GET", ONE, { as: "admin", ...which })).budget).toBeDefined();
    await call("GET", ONE, { as: "admin", ...unknown });
    await call("GET", ONE, { as: "admin", params: { authorizationId: "nope" } });
    expect((await call("GET", "/api/admin/ledger/verify", { as: "admin" })).ok).toBe(true);
    // the trail: the latest page (every kind of decision is in it by now), and a refused query
    expect(((await call("GET", EVENTS, { as: "admin" })).events as unknown[]).length).toBeGreaterThan(4);
    await call("GET", EVENTS, { as: "admin", query: "?after=1&before=2" });

    // docs (API_DOCS=1): the page, every documented asset, another name, and the document itself
    await call("GET", "/docs", { as: null });
    const assetParam = doc.paths["/docs/{asset}"]!.get!.parameters!.find((x) => x.name === "asset")!;
    for (const asset of assetParam.schema.enum as string[]) await call("GET", "/docs/{asset}", { as: null, params: { asset } });
    await call("GET", "/docs/{asset}", { as: null, params: { asset: "package.json" } });
    await call("GET", "/openapi.yaml", { as: null });

    // every signed-in operation: no token, then a token issued for the agent service
    for (const [method, path, op] of operations(doc)) {
      if (op.security?.length === 0) continue;
      await call(method, path, { as: null });
      await call(method, path, { as: "agent" });
    }

    expect(errors).toEqual([]);
    const documented = operations(doc).flatMap(([m, path, op]) => Object.keys(op.responses).filter((s) => !GENERIC.has(s)).map((s) => `${m} ${path} ${s}`));
    // The one status this (ready) portal can't answer; the next test reaches it on a portal that is still starting.
    expect(documented.filter((d) => !seen.has(d))).toEqual(["GET /readyz 503"]);
  }, 60_000);

  it("T-API-14 the generic statuses conform too: 502 with L2 down, 429 over the limit, 413 for an oversized body, 503 while starting", async () => {
    const doc = loadDoc();
    const check = (method: string, path: string, status: number, body: unknown) => {
      const schema = responseContent(doc, method, path, status)?.["application/json"]?.schema;
      expect(schema, `${method} ${path} ${status}`).toBeDefined();
      expect(conformance(doc, schema!, body)).toEqual([]);
    };
    const down = await start({ controlDown: true, ready: false });
    const me = await down.as("alice")("GET", "/api/me");
    expect(me.status).toBe(502);
    check("GET", "/api/me", 502, me.body);
    const readyz = await down.call("GET", "/readyz");
    expect(readyz.status).toBe(503);
    check("GET", "/readyz", 503, readyz.body);
    const big = await down.as("alice")("PUT", "/api/profile", { ...PROFILE, displayName: "x".repeat(20_000) });
    expect(big.status).toBe(413);
    check("PUT", "/api/profile", 413, big.body);
    const up = await start();
    const token = await up.token("bob");
    let last = await up.call("GET", "/api/platform", { token });
    for (let i = 0; i < 125 && last.status !== 429; i++) last = await up.call("GET", "/api/platform", { token });
    expect(last.status).toBe(429);
    check("GET", "/api/platform", 429, last.body);
    // Every signed-in operation documents the generic statuses.
    for (const [method, path, op] of operations(doc)) {
      if (op.security?.length === 0) continue;
      expect(Object.keys(op.responses), `${method} ${path}`).toEqual(expect.arrayContaining(["401", "403", "429", "502"]));
    }
  });

  it("T-API-14 must-fail: an undocumented field, a missing field and a wrong type are reported", () => {
    const doc = loadDoc();
    const me = { $ref: "#/components/schemas/Me" };
    const ok = { userId: "usr_deeee4478bc01dab1b0afa3fbe31f010", enabled: true, onboarding: { profile: true, wallet: false, policy: false }, admin: false };
    expect(conformance(doc, me, ok)).toEqual([]);
    const { enabled: _, ...missing } = ok;
    expect(conformance(doc, me, { ...missing, userId: 7, displayName: "Ana" })).toEqual(["$.enabled: missing", "$.userId: expected string", "$.displayName: not documented"]);
  });
});

describe("T-API-15 Swagger UI is opt-in, same-origin and serves fixed files only (SEC-13)", () => {
  const DOCS_PROBES = ["/docs", "/docs/swagger-ui-bundle.js", "/docs/swagger-initializer.js", "/openapi.yaml"];
  const probe = async (base: string) => Promise.all(DOCS_PROBES.map(async (path) => `${path} ${(await send(base, "GET", path)).status}`));

  it("T-API-15 off by default: no docs route is mounted and each docs URL answers 404", async () => {
    const p = await start();
    expect(routeDiff(documentedRoutes(loadDoc()), mountedRoutes(p.app)).unmounted).toEqual(["GET /docs", "GET /docs/:asset", "GET /openapi.yaml"]);
    expect(await probe(p.base)).toEqual(DOCS_PROBES.map((path) => `${path} 404`));
  });

  it("T-API-15 must-fail: the same probe sees every docs URL when API_DOCS=1", async () => {
    const p = await start({ env: DOCS });
    expect(await probe(p.base)).toEqual(DOCS_PROBES.map((path) => `${path} 200`));
  });

  it("T-API-15 the served document is the file with servers set to the serving portal", async () => {
    const p = await start({ env: DOCS });
    const res = await send(p.base, "GET", "/openapi.yaml");
    expect(res.type).toBe("application/yaml");
    const { servers, ...rest } = parse(res.text) as { servers: { url: string }[] };
    const { servers: fileServers, ...fileRest } = parse(readFileSync(PORTAL_API_DOCS_FILE, "utf8")) as { servers: { url: string }[] };
    expect(servers.map((s) => s.url)).toEqual(["/"]);
    expect(fileServers.map((s) => s.url)).toEqual(["http://127.0.0.1:4025"]);
    expect(rest).toEqual(fileRest);
    expect(() => servedPortalApiDocument("openapi: 3.1.0\npaths: {}\n")).toThrow("no top-level servers block");
  });

  it("T-API-15 the docs page keeps its own same-origin policy, and the docs routes need no token", async () => {
    const p = await start({ env: DOCS });
    const page = await send(p.base, "GET", "/docs");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp.split("; ")).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]));
    expect(csp).not.toMatch(/unsafe-eval|https?:/);
    expect(page.text).not.toMatch(/https?:\/\//);
    const others = ["index.html", "package.json", "..%2Fpackage.json"];
    expect(await Promise.all(others.map(async (a) => `${a} ${(await send(p.base, "GET", `/docs/${a}`)).status}`))).toEqual(others.map((a) => `${a} 404`));
  });
});
