// 019 — T-AGT-18 the sign-in settings route (SPEC L1-6, CFG-2; specs/019 contracts/hosted-agent-api.md
// "GET /.well-known/agent-auth", FR-024, FR-025). With AGENT_DESKTOP_CLIENT_ID the agent serves, without a token, the
// seven public values a desktop client signs in with, all from its own settings; without it the route doesn't exist.
// The settings refuse an advertised client the service would not accept.
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/shared/config.js";
import { loadHostedConfig } from "../src/layer1-intent/hosted/config.js";
import { DEV_AGENT_CLIENT, DEV_DESKTOP_CLIENT } from "../scripts/dev-issuer-lib.js";
import { fakePorts, mockModel, modelCalls, startHostedApp, TENANT_TEST_ISSUER, type HostedTestApp } from "./helpers/hosted.js";

let apps: HostedTestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const PATH = "/.well-known/agent-auth";

async function start(env: Record<string, string>, extra: Parameters<typeof startHostedApp>[0] = {}) {
  const ports = fakePorts();
  const model = mockModel();
  // The sign-in tenant's issuer: the route needs a real tenant (the dev issuer has no sign-in page).
  // Object.assign, not a spread: the model's type is too large a union to spread (TS2590, @mastra/core 1.83).
  const a = await startHostedApp(Object.assign({ tenant: true as const, model, gate: ports.gate, settlement: ports.settlement, env }, extra));
  apps.push(a);
  return { a, ports, model };
}

describe("T-AGT-18 GET /.well-known/agent-auth (019 FR-024, FR-025)", () => {
  it("T-AGT-18 with AGENT_DESKTOP_CLIENT_ID: 200 without a token, exactly the seven values from the settings, cacheable, and nothing called", async () => {
    const { a, ports, model } = await start({ AGENT_DESKTOP_CLIENT_ID: DEV_DESKTOP_CLIENT });
    const res = await fetch(`${a.base}${PATH}`);
    expect([res.status, res.headers.get("content-type")?.split(";")[0], res.headers.get("cache-control")]).toEqual([200, "application/json", "public, max-age=300"]);
    expect(await res.json()).toEqual({
      issuer: TENANT_TEST_ISSUER,
      authorization_endpoint: `${TENANT_TEST_ISSUER}authorize`,
      token_endpoint: `${TENANT_TEST_ISSUER}oauth/token`,
      audience: a.config.auth.audience,
      client_id: DEV_DESKTOP_CLIENT,
      scopes: ["openid", "offline_access", "agent:run"],
      redirect_uri: "http://127.0.0.1:53682/callback",
    });
    expect(modelCalls(model)).toHaveLength(0);
    expect([ports.gateCalls.length, ports.settlementCalls.length]).toEqual([0, 0]);
  });

  it("T-AGT-18 without AGENT_DESKTOP_CLIENT_ID the route doesn't exist: 401 without a token, 404 with one", async () => {
    const { a } = await start({});
    expect((await fetch(`${a.base}${PATH}`)).status).toBe(401);
    const res = await fetch(`${a.base}${PATH}`, { headers: { authorization: `Bearer ${await a.token("alice")}` } });
    expect([res.status, await res.json()]).toEqual([404, { error: "not found" }]);
  });

  it("T-AGT-18 the route is counted by the per-address limit, like every route after the health and docs routes", async () => {
    const { a } = await start({ AGENT_DESKTOP_CLIENT_ID: DEV_DESKTOP_CLIENT }, { maxRequestsPerAddress: 2 });
    expect([(await fetch(`${a.base}${PATH}`)).status, (await fetch(`${a.base}${PATH}`)).status, (await fetch(`${a.base}${PATH}`)).status]).toEqual([200, 200, 429]);
  });

  describe("the setting (CFG-2)", () => {
    const SECRETISH = "PlantedDesktopClient0019";
    const env = (over: Record<string, string>) => ({
      NETWORK: "local",
      AGENT_TEST_MODE: "1", // 021: the agent of before 021 (NFR-006)
      MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key-not-used",
      AUTH_ISSUER: TENANT_TEST_ISSUER,
      AUTH_AUDIENCE: "https://x402-api/test",
      AGENT_CLIENT_IDS: `${DEV_AGENT_CLIENT},${DEV_DESKTOP_CLIENT}`,
      SESSION_REF_SECRET: "ab".repeat(32),
      ...over,
    });
    const refusal = (over: Record<string, string>): string => {
      try {
        loadHostedConfig(env(over));
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error("the settings were accepted");
    };

    it("T-AGT-18 one of AGENT_CLIENT_IDS is accepted; absent, there is no desktop client", () => {
      expect(loadHostedConfig(env({ AGENT_DESKTOP_CLIENT_ID: DEV_DESKTOP_CLIENT })).auth.desktopClientId).toBe(DEV_DESKTOP_CLIENT);
      expect(loadHostedConfig(env({})).auth.desktopClientId).toBeUndefined();
    });

    it("T-AGT-18 refused: a client not on AGENT_CLIENT_IDS, the portal's client, the dev issuer; the error names the variable, never its value", () => {
      const notListed = refusal({ AGENT_DESKTOP_CLIENT_ID: SECRETISH });
      expect(notListed).toMatch(/AGENT_DESKTOP_CLIENT_ID must be one of AGENT_CLIENT_IDS/);
      // The portal's client can't be advertised: on the list it is refused there, off it here.
      const portalCases: Record<string, string>[] = [
        { AGENT_DESKTOP_CLIENT_ID: SECRETISH, PORTAL_CLIENT_ID: SECRETISH },
        { AGENT_DESKTOP_CLIENT_ID: SECRETISH, PORTAL_CLIENT_ID: SECRETISH, AGENT_CLIENT_IDS: `${DEV_AGENT_CLIENT},${SECRETISH}` },
      ];
      for (const over of portalCases) {
        expect(refusal(over)).toMatch(/AGENT_DESKTOP_CLIENT_ID must be one of AGENT_CLIENT_IDS|AGENT_CLIENT_IDS must not contain PORTAL_CLIENT_ID/);
      }
      const devIssuer = refusal({ AGENT_DESKTOP_CLIENT_ID: DEV_DESKTOP_CLIENT, AUTH_ISSUER: "urn:x402:dev-issuer", AUTH_JWKS_FILE: ".local/dev-issuer/jwks.json" });
      expect(devIssuer).toMatch(/AGENT_DESKTOP_CLIENT_ID needs the sign-in tenant/);
      for (const message of [notListed, devIssuer]) expect(message).not.toContain(SECRETISH);
    });
  });
});
