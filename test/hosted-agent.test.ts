// 011 hosted agent service (SPEC.md L1-6): configuration (T-AGT-02 hosted configuration) and the tool set
// the model sees (T-AGT-02 tool set, must-fail). specs/011 contracts/model-access.md.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createTool } from "@mastra/core/tools";
import { generateText, jsonSchema, Output, tool } from "ai";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError } from "../src/shared/config.js";
import { AGENT_TOOLS, systemPrompt } from "../src/layer1-intent/agent.js";
import { runGoal, SEARCH_TOOL_DESCRIPTION, searchSystemPrompt } from "../src/layer1-intent/hosted/agent.js";
import { DEV_ISSUER, loadHostedConfig } from "../src/layer1-intent/hosted/config.js";
import { createModel } from "../src/layer1-intent/hosted/model.js";
import { startDiscoveryStub, STUB_LOCAL } from "./helpers/discovery-stub.js";
import { fakePorts, mockModel, startHostedApp, text, toolCall, toolNamesSeen, type HostedTestApp } from "./helpers/hosted.js";

const SECRET_HEX = "ab".repeat(32);
const API_KEY = "sk-ant-planted-value-0001";
/** What the organization's directory gave before 016: its tenant and the API app's client ID. Refused now. */
const API_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const TENANT_ID = "11111111-1111-1111-1111-111111111111";
/** The sign-in tenant (013 research R19; 016): its issuer, people's API's identifier and the agent's client. */
const SIGN_IN_ISSUER = "https://x402-test.eu.auth0.com/";
const API_IDENTIFIER = "https://x402.example/api";
const AGENT_CLIENT = "AgentCliClient0123456789abcdefgh";

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    NETWORK: "local",
    AGENT_TEST_MODE: "1", // 021: the agent of before 021 (NFR-006)
    MODEL_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: API_KEY,
    AUTH_ISSUER: SIGN_IN_ISSUER,
    AUTH_AUDIENCE: API_IDENTIFIER,
    AGENT_CLIENT_IDS: AGENT_CLIENT,
    SESSION_REF_SECRET: SECRET_HEX,
  };
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== undefined) out[k] = v;
  return out;
}

const foundry = (over: Record<string, string | undefined> = {}) =>
  env({
    NETWORK: "base-sepolia",
    CONTROL_TOKEN: "t-control",
    VERIFIER_TOKEN: "t-verifier",
    MODEL_PROVIDER: "foundry",
    ANTHROPIC_API_KEY: undefined,
    FOUNDRY_BASE_URL: "https://ais-x402.services.ai.azure.com/anthropic/v1",
    AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
    ...over,
  });

describe("T-AGT-02 hosted configuration", () => {
  it("a local anthropic config loads with the documented defaults", () => {
    const c = loadHostedConfig(env());
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-sonnet-5-5");
    expect(c.anthropicApiKey).toBe(API_KEY);
    expect(c.port).toBe(4024);
    expect(c.bindHost).toBe("127.0.0.1");
    expect(c.tokens).toEqual({ control: "dev-control-token", verifier: "dev-verifier-token" });
    expect(c.urls.control).toBe("http://127.0.0.1:4020");
    expect(c.sessionRefSecret.length).toBe(32);
    expect(c.auth).toEqual({ issuer: SIGN_IN_ISSUER, audience: API_IDENTIFIER, clientIds: [AGENT_CLIENT] });
  });

  it("a foundry config loads; every caller comes from the one sign-in tenant", () => {
    const c = loadHostedConfig(foundry());
    expect(c.provider).toBe("foundry");
    expect(c.foundryBaseUrl).toBe("https://ais-x402.services.ai.azure.com/anthropic/v1");
    expect(c.azureClientId).toBe("00000000-0000-0000-0000-000000000001");
    expect(c.anthropicApiKey).toBeUndefined();
    expect(c.auth.issuer).toBe(SIGN_IN_ISSUER);
  });

  const dev = (over: Record<string, string | undefined> = {}) =>
    env({ AUTH_ISSUER: DEV_ISSUER, AUTH_AUDIENCE: "api://x402-l1-agent", AUTH_JWKS_FILE: ".local/dev-issuer/jwks.json", ...over });

  it("AUTH_JWKS_FILE selects the dev issuer on local, for both kinds of caller, and is a startup error on any other network", () => {
    expect(loadHostedConfig(dev()).auth).toEqual({
      issuer: DEV_ISSUER,
      audience: "api://x402-l1-agent",
      clientIds: [AGENT_CLIENT],
      jwksFile: ".local/dev-issuer/jwks.json",
    });
    expect(() => loadHostedConfig(foundry({ AUTH_JWKS_FILE: "x.json" }))).toThrow(ConfigError);
    // With the dev issuer's keys, only the dev issuer's name is accepted: a real tenant's tokens could never verify.
    expect(() => loadHostedConfig(dev({ AUTH_ISSUER: SIGN_IN_ISSUER }))).toThrow(/AUTH_ISSUER must be urn:x402:dev-issuer with AUTH_JWKS_FILE/);
  });

  it("AUTH_ISSUER must be the sign-in tenant's issuer exactly as its tokens carry it", () => {
    for (const bad of [
      "https://x402-test.eu.auth0.com",
      "http://x402-test.eu.auth0.com/",
      "https://x402-test.eu.auth0.com/v2/",
      "x402-test.eu.auth0.com",
      DEV_ISSUER,
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    ]) {
      expect(() => loadHostedConfig(env({ AUTH_ISSUER: bad })), bad).toThrow(/AUTH_ISSUER must be the sign-in tenant's issuer/);
    }
  });

  it("AGENT_CLIENT_IDS is a comma-separated list of client IDs, never empty", () => {
    expect(loadHostedConfig(env({ AGENT_CLIENT_IDS: " a1 ,b2,  c3 " })).auth.clientIds).toEqual(["a1", "b2", "c3"]);
    for (const bad of ["a1,,b2", "a1,", ",", "a 1", "a1;b2", "a1,b/2"]) {
      expect(() => loadHostedConfig(env({ AGENT_CLIENT_IDS: bad })), bad).toThrow(/AGENT_CLIENT_IDS must be a comma-separated list/);
    }
    expect(() => loadHostedConfig(env({ AGENT_CLIENT_IDS: "a1,portal", PORTAL_CLIENT_ID: "portal" }))).toThrow(/must not contain PORTAL_CLIENT_ID/);
    expect(loadHostedConfig(env({ AGENT_CLIENT_IDS: "a1", PORTAL_CLIENT_ID: "portal" })).auth.clientIds).toEqual(["a1"]);
  });

  it("T-AGT-14 the three sign-in settings are required: without one the service does not start, and names it", () => {
    for (const one of ["AUTH_ISSUER", "AUTH_AUDIENCE", "AGENT_CLIENT_IDS"]) {
      expect(() => loadHostedConfig(env({ [one]: undefined })), one).toThrow(new RegExp(`${one} is required`));
      expect(() => loadHostedConfig(env({ [one]: "" })), `${one} empty`).toThrow(new RegExp(`${one} is required`));
    }
    // The sign-in tenant's API identifier is any text the tenant was given: not checked for shape.
    expect(loadHostedConfig(env({ AUTH_AUDIENCE: "api://x402" })).auth.audience).toBe("api://x402");
  });

  it("T-AGT-14 a setting of the organization's directory stops the service, by name and never by value (016 FR-044)", () => {
    for (const [name, value] of [
      ["AUTH_TENANT_ID", TENANT_ID],
      ["SERVICE_AUDIENCE", API_CLIENT_ID],
    ] as const) {
      let message = "";
      try {
        loadHostedConfig(env({ [name]: value }));
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        message = (e as Error).message;
      }
      expect(message, name).toContain(`${name} is no longer used: remove it`);
      expect(message, name).not.toContain(value);
      // An empty value, as a template passes an unset parameter, is not a leftover.
      expect(loadHostedConfig(env({ [name]: "" })).auth.issuer).toBe(SIGN_IN_ISSUER);
    }
    // Both together, and with the dev issuer: still refused.
    expect(() => loadHostedConfig(env({ AUTH_TENANT_ID: TENANT_ID, SERVICE_AUDIENCE: API_CLIENT_ID }))).toThrow(/AUTH_TENANT_ID is no longer used/);
    expect(() => loadHostedConfig(dev({ AUTH_TENANT_ID: "dev" }))).toThrow(/AUTH_TENANT_ID is no longer used/);
  });

  it("T-AGT-14 API_DOCS_CLIENT_ID is one of the agent's own clients, at a real tenant (016 SEC-34)", () => {
    expect(loadHostedConfig(env({ API_DOCS_CLIENT_ID: AGENT_CLIENT })).auth.docsClientId).toBe(AGENT_CLIENT);
    expect(loadHostedConfig(env()).auth.docsClientId).toBeUndefined();
    expect(() => loadHostedConfig(env({ API_DOCS_CLIENT_ID: "some-other-client" }))).toThrow(/API_DOCS_CLIENT_ID must be one of AGENT_CLIENT_IDS/);
    expect(() => loadHostedConfig(dev({ API_DOCS_CLIENT_ID: AGENT_CLIENT }))).toThrow(/API_DOCS_CLIENT_ID needs the sign-in tenant/);
  });

  it.each([
    ["MODEL_PROVIDER missing", { MODEL_PROVIDER: undefined }],
    ["MODEL_PROVIDER unknown", { MODEL_PROVIDER: "openai" }],
    ["ANTHROPIC_MODEL off the allow-list", { ANTHROPIC_MODEL: "my-deployment" }],
    ["anthropic without ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: undefined }],
    ["AUTH_ISSUER alone missing", { AUTH_ISSUER: undefined }],
    ["AUTH_AUDIENCE alone missing", { AUTH_AUDIENCE: undefined }],
    ["AGENT_CLIENT_IDS alone missing", { AGENT_CLIENT_IDS: undefined }],
    ["no sign-in settings at all: nobody could call the service", { AUTH_ISSUER: undefined, AUTH_AUDIENCE: undefined, AGENT_CLIENT_IDS: undefined }],
    ["a leftover directory tenant", { AUTH_TENANT_ID: "11111111-1111-1111-1111-111111111111" }],
    ["a leftover directory audience", { SERVICE_AUDIENCE: "22222222-2222-2222-2222-222222222222" }],
    ["SESSION_REF_SECRET missing", { SESSION_REF_SECRET: undefined }],
    ["SESSION_REF_SECRET shorter than 32 bytes", { SESSION_REF_SECRET: "ab".repeat(31) }],
    ["AGENT_PORT invalid", { AGENT_PORT: "70000" }],
  ])("%s → ConfigError", (_name, over) => {
    expect(() => loadHostedConfig(env(over))).toThrow(ConfigError);
  });

  it.each([
    ["foundry with ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: API_KEY }],
    ["foundry without FOUNDRY_BASE_URL", { FOUNDRY_BASE_URL: undefined }],
    ["FOUNDRY_BASE_URL not ending in /anthropic/v1", { FOUNDRY_BASE_URL: "https://ais-x402.services.ai.azure.com/anthropic" }],
    ["foundry without AZURE_CLIENT_ID", { AZURE_CLIENT_ID: undefined }],
    ["non-local network without CONTROL_TOKEN", { CONTROL_TOKEN: undefined }],
  ])("%s → ConfigError", (_name, over) => {
    expect(() => loadHostedConfig(foundry(over))).toThrow(ConfigError);
  });

  it("every allow-listed model loads; the secret may be base64 as well as hex", () => {
    for (const m of ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-haiku-5-5"]) {
      expect(loadHostedConfig(env({ ANTHROPIC_MODEL: m })).model).toBe(m);
    }
    const b64 = Buffer.alloc(32, 7).toString("base64");
    expect(loadHostedConfig(env({ SESSION_REF_SECRET: b64 })).sessionRefSecret).toEqual(Buffer.alloc(32, 7));
  });

  it("error messages name the variable and never echo a planted secret value", () => {
    const planted = "planted-secret-value-zz";
    const messages: string[] = [];
    for (const over of [
      { SESSION_REF_SECRET: planted },
      { ANTHROPIC_MODEL: planted },
      { MODEL_PROVIDER: planted },
    ]) {
      try {
        loadHostedConfig(env(over));
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    try {
      loadHostedConfig(foundry({ ANTHROPIC_API_KEY: API_KEY }));
    } catch (e) {
      messages.push((e as Error).message);
    }
    expect(messages).toHaveLength(4);
    for (const m of messages) {
      expect(m).not.toContain(planted);
      expect(m).not.toContain(API_KEY);
    }
    expect(messages[0]).toContain("SESSION_REF_SECRET");
  });
});

// ---------------------------------------------------------------------------
// T-AGT-02 tool set (US1): exactly two tools, L1-3 descriptions and schemas, 2048 tokens, 10 steps
// ---------------------------------------------------------------------------

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

/** A free seller: GET /api/catalog answers 200 JSON. */
async function freeSeller(): Promise<string> {
  const app = express();
  app.get("/api/catalog", (_req, res) => res.json({ items: [] }));
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function hosted(...args: Parameters<typeof startHostedApp>): Promise<HostedTestApp> {
  const a = await startHostedApp(...args);
  cleanups.push(() => a.close());
  return a;
}

/** The shape the model receives, without the schema keys research R3 documents as stricter. */
const schemaCore = (s: unknown) => {
  const o = s as { type?: unknown; properties?: unknown; required?: unknown };
  return { type: o.type, properties: o.properties, required: o.required ?? [] };
};

describe("T-AGT-02 tool set", () => {
  it("every model call offers exactly fetch_resource and check_budget, with the L1-3 descriptions and schemas, and 2048 max output tokens", async () => {
    const seller = await freeSeller();
    const model = mockModel([toolCall("fetch_resource", { url: `${seller}/api/catalog`, purpose: "read the catalog" }), toolCall("check_budget", {}), text("done")]);
    const a = await hosted({ model, env: { SELLER_URL: seller } });
    const r = await a.run("alice", { goal: "read the catalog" });
    expect(r.status).toBe(200);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(toolNamesSeen(model)).toEqual([0, 1, 2].map(() => ["fetch_resource", "check_budget"]));
    for (const call of model.doStreamCalls) {
      expect(call.maxOutputTokens).toBe(2048);
      const tools = (call.tools ?? []) as { name: string; description?: string; inputSchema?: unknown }[];
      for (const [i, t] of tools.entries()) {
        expect(t.description).toBe(AGENT_TOOLS[i]!.description);
        expect(schemaCore(t.inputSchema)).toEqual(schemaCore(AGENT_TOOLS[i]!.input_schema));
      }
    }
  });

  it("021 test mode: the L1-3 prompt byte for byte, and no request to the discovery index (NFR-003)", async () => {
    const index = await startDiscoveryStub();
    cleanups.push(() => index.close());
    const seller = await freeSeller();
    const model = mockModel([toolCall("check_budget", {}), text("done")]);
    const a = await hosted({ model, env: { SELLER_URL: seller, DISCOVERY_URL: index.url } });
    expect((await a.run("alice", { goal: "read the catalog" })).status).toBe(200);
    for (const call of model.doStreamCalls) {
      expect(call.prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n")).toBe(systemPrompt(seller));
    }
    expect(index.requests).toHaveLength(0);
  });

  it("021 search mode: exactly fetch_resource, check_budget and search_resources, in that order, with the fixed description and schema and the search-mode prompt", async () => {
    const index = await startDiscoveryStub();
    cleanups.push(() => index.close());
    const seller = await freeSeller();
    const model = mockModel([toolCall("search_resources", { query: "weather" }), toolCall("check_budget", {}), text("done")]);
    const a = await hosted({ model, discovery: { url: index.url }, env: { SELLER_URL: seller } });
    expect((await a.run("alice", { goal: "weather" })).status).toBe(200);
    expect(toolNamesSeen(model)).toEqual([0, 1, 2].map(() => ["fetch_resource", "check_budget", "search_resources"]));
    for (const call of model.doStreamCalls) {
      expect(call.maxOutputTokens).toBe(2048);
      const tools = (call.tools ?? []) as { name: string; description?: string; inputSchema?: unknown }[];
      for (const [i, t] of tools.slice(0, 2).entries()) {
        expect(t.description).toBe(AGENT_TOOLS[i]!.description);
        expect(schemaCore(t.inputSchema)).toEqual(schemaCore(AGENT_TOOLS[i]!.input_schema));
      }
      expect(tools[2]!.description).toBe(SEARCH_TOOL_DESCRIPTION);
      expect(schemaCore(tools[2]!.inputSchema)).toEqual({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
      expect((tools[2]!.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      expect(call.prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n")).toBe(searchSystemPrompt(seller));
    }
  });

  it("019 US4 check_budget's output has no account, even when L2's budget has one: the model and a step's result keep their fields", async () => {
    const model = mockModel([toolCall("check_budget", {}), text("done")]);
    // The default fake L2 answers the user view with `account: "ready"`, as L2 does for a person.
    const a = await hosted({ model });
    const r = await a.run("alice", { goal: "how much is left?" });
    expect(r.status).toBe(200);
    const [step] = r.body.steps as { tool: string; result: Record<string, unknown> }[];
    expect(step!.tool).toBe("check_budget");
    expect(Object.keys(step!.result).sort()).toEqual(["asset", "decimals", "perPaymentCapAtomic", "remainingAtomic", "sessionCapAtomic", "sessionId", "spentOrReservedAtomic"]);
    // What the model read back: the tool's result, without the account answer.
    const seen = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(seen).toContain("remainingAtomic");
    expect(seen).not.toContain("account");
  });

  it("a model that always calls a tool stops after exactly 10 model calls", async () => {
    const model = mockModel(async () => toolCall("check_budget", {}));
    const a = await hosted({ model });
    const r = await a.run("alice", { goal: "loop" });
    expect(r.status).toBe(200);
    expect(model.doStreamCalls).toHaveLength(10);
    expect(r.body).toMatchObject({ status: "stopped", stopReason: "step_limit" });
  });

  /**
   * Fake Anthropic Messages endpoint: records requests and answers one text turn, as server-sent events (016: the
   * agent calls the model through `stream`, so the request asks for a stream and the answer is one).
   */
  function fakeAnthropicFetch() {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      const events: [string, Record<string, unknown>][] = [
        ["message_start", { type: "message_start", message }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "do" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ne" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    return { requests, fetchImpl };
  }

  async function runOnce(model: Parameters<typeof runGoal>[0]["model"]) {
    const { gate, settlement } = fakePorts();
    return runGoal({ goal: "hello", sessionId: "sess_0123456789abcdef", signal: new AbortController().signal, model, gate, settlement, sellerUrl: "http://127.0.0.1:4021", mode: "test" });
  }

  const base = {
    MODEL_PROVIDER: "anthropic",
    AGENT_TEST_MODE: "1", // 021: the agent of before 021 (NFR-006)
    ANTHROPIC_API_KEY: "sk-test",
    AUTH_ISSUER: SIGN_IN_ISSUER,
    AUTH_AUDIENCE: API_IDENTIFIER,
    AGENT_CLIENT_IDS: AGENT_CLIENT,
    SESSION_REF_SECRET: "ab".repeat(32),
  };

  it("HTTP level, anthropic: the request carries exactly the two tools, max_tokens 2048 and x-api-key", async () => {
    const f = fakeAnthropicFetch();
    const model = createModel(loadHostedConfig(base), { fetch: f.fetchImpl });
    const out = await runOnce(model);
    expect([out.status, out.finalText, out.error]).toEqual(["completed", "done", null]);
    expect(f.requests).toHaveLength(1);
    const req = f.requests[0]!;
    expect(req.body.stream).toBe(true);
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect((req.body.tools as { name: string }[]).map((t) => t.name)).toEqual(["fetch_resource", "check_budget"]);
    expect(req.body.max_tokens).toBe(2048);
    expect(req.body.model).toBe("claude-sonnet-5-5");
    expect(req.headers.get("x-api-key")).toBe("sk-test");
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.top_k).toBeUndefined();
  });

  it("HTTP level, foundry: <FOUNDRY_BASE_URL>/messages with an Entra bearer token and no x-api-key", async () => {
    const f = fakeAnthropicFetch();
    const config = loadHostedConfig({
      ...base,
      NETWORK: "base-sepolia",
      CONTROL_TOKEN: "c",
      VERIFIER_TOKEN: "v",
      MODEL_PROVIDER: "foundry",
      ANTHROPIC_API_KEY: "",
      FOUNDRY_BASE_URL: "https://ais-x402.services.ai.azure.com/anthropic/v1",
      AZURE_CLIENT_ID: "client-id",
    });
    const scopes: string[] = [];
    const credential = {
      getToken: async (scope: string | string[]) => {
        scopes.push(String(scope));
        return { token: "entra-token", expiresOnTimestamp: Date.now() + 3_600_000 };
      },
    };
    const model = createModel(config, { fetch: f.fetchImpl, credential });
    const out = await runOnce(model);
    expect([out.status, out.finalText]).toEqual(["completed", "done"]);
    const req = f.requests[0]!;
    expect(req.body.stream).toBe(true);
    expect(req.url).toBe("https://ais-x402.services.ai.azure.com/anthropic/v1/messages");
    expect(req.headers.get("authorization")).toBe("Bearer entra-token");
    expect(req.headers.get("x-api-key")).toBeNull();
    expect(scopes).toEqual(["https://ai.azure.com/.default"]);
    expect((req.body.tools as { name: string }[]).map((t) => t.name)).toEqual(["fetch_resource", "check_budget"]);
    expect(req.body.max_tokens).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// T-AGT-02 must-fail (US2): the check catches a third tool, and the allow-list closes the provider's `json` tool
// ---------------------------------------------------------------------------

describe("T-AGT-02 must-fail", () => {
  it("an extra tool injected through the test-only hook shows up as a third tool name, and the check reports it", async () => {
    const model = mockModel([text("done")]);
    const { gate, settlement } = fakePorts();
    const approve_payment = createTool({ id: "approve_payment", description: "x", inputSchema: z.object({}), execute: async () => ({}) });
    await runGoal({
      goal: "hi",
      sessionId: "sess_0123456789abcdef",
      signal: new AbortController().signal,
      model,
      gate,
      settlement,
      sellerUrl: "http://127.0.0.1:4021",
      mode: "test",
      extraTools: { approve_payment: approve_payment as never },
    });
    const seen = toolNamesSeen(model);
    expect(seen[0]).toEqual(["fetch_resource", "check_budget", "approve_payment"]);
    expect(seen.every((names) => names.length === 2)).toBe(false);
  });

  it("021 an extra tool injected through the test-only hook shows up as a fourth tool name in search mode, and the check reports it", async () => {
    const model = mockModel([text("done")]);
    const { gate, settlement } = fakePorts();
    const approve_payment = createTool({ id: "approve_payment", description: "x", inputSchema: z.object({}), execute: async () => ({}) });
    await runGoal({
      goal: "hi",
      sessionId: "sess_0123456789abcdef",
      signal: new AbortController().signal,
      model,
      gate,
      settlement,
      sellerUrl: "http://127.0.0.1:4021",
      mode: "search",
      discovery: { url: "http://127.0.0.1:1/discovery/search", network: STUB_LOCAL },
      extraTools: { approve_payment: approve_payment as never },
    });
    const seen = toolNamesSeen(model);
    expect(seen[0]).toEqual(["fetch_resource", "check_budget", "search_resources", "approve_payment"]);
    expect(seen.every((names) => names.length === 3)).toBe(false);
  });

  it("an unrecognized model id is refused at startup", () => {
    expect(() => loadHostedConfig(env({ ANTHROPIC_MODEL: "my-deployment" }))).toThrow(ConfigError);
  });

  it("evidence for the allow-list: with an unrecognized model id the provider itself adds a third `json` tool", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await generateText({
      model: createAnthropic({ apiKey: "k", fetch: fetchImpl })("my-deployment"),
      prompt: "x",
      tools: { fetch_resource: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) }), check_budget: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) }) },
      experimental_output: Output.object({ schema: jsonSchema({ type: "object", properties: {} }) }),
    }).catch(() => undefined);
    const names = ((requests[0]?.tools ?? []) as { name: string }[]).map((t) => t.name);
    expect(names).toContain("json");
    expect(names).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 012 FR-007: the hosted agent can never mark an intent operator-only (its tools stay the two of L1-3).
// ---------------------------------------------------------------------------
describe("012 FR-007 operator-only intents (hosted)", () => {
  it("a hosted run's intents never carry operatorApprovalOnly, even when the model passes it", async () => {
    const app = express();
    app.get("/api/premium-report", (_req, res) =>
      res.status(402).json({
        x402Version: 2,
        resource: { url: "http://127.0.0.1/api/premium-report", description: "", mimeType: "application/json" },
        accepts: [{ scheme: "exact", network: "eip155:31337", asset: "0x0000000000000000000000000000000000000a11", amount: "50000", payTo: "0x0000000000000000000000000000000000000b22", maxTimeoutSeconds: 60, extra: {} }],
      }),
    );
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const seller = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const intents: Record<string, unknown>[] = [];
    const { gate, settlement } = fakePorts({
      authorize: async (i) => {
        intents.push(i as unknown as Record<string, unknown>);
        return { status: "ESCALATE", authorizationId: "auth_x", intentId: i.intentId, violations: [{ rule: "human_approval_required", detail: "d" }] };
      },
    });
    const model = mockModel([
      toolCall("fetch_resource", { url: `${seller}/api/premium-report`, purpose: "p" }),
      toolCall("fetch_resource", { url: `${seller}/api/premium-report`, purpose: "p", operatorApprovalOnly: true }),
      text("done"),
    ]);
    await runGoal({ goal: "buy it", sessionId: "sess_0123456789abcdef", signal: new AbortController().signal, model, gate, settlement, sellerUrl: seller, mode: "test" });
    expect(intents.length).toBeGreaterThanOrEqual(1);
    for (const i of intents) expect("operatorApprovalOnly" in i).toBe(false);
  });
});
