// 016 — a machine caller's token (SPEC L1-5 v1.17, SEC-33; specs/016 research R9). The client-credentials request
// with a signed assertion, against a stub token address: what is sent, what is reused, and what a refusal says.
// The settings come from the environment by name; errors never carry a value, the key, the assertion or the
// tenant's answer.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicKey } from "node:crypto";
import express from "express";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { callerTokenSourceFromEnv, MachineCaller, machineCallerFromEnv } from "../src/machine-caller/token.js";
import { ConfigError } from "../src/shared/config.js";
import { testRsaKeyPair } from "./helpers/ciba-stub.js";

const KEY = testRsaKeyPair();
const OTHER_KEY = testRsaKeyPair();
const AUDIENCE = "https://x402-api/test";
const CLIENT = "ChecksClient0123";
const SECRET_ANSWER = "tenant-says-something-private-7c1e";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A stand-in for the tenant's token address: records each form and answers as told. */
async function tokenEndpoint(answer: (n: number) => { status: number; body: unknown } = (n) => ({ status: 200, body: { access_token: `token-${n}`, expires_in: 3600, token_type: "Bearer" } })) {
  const forms: Record<string, string>[] = [];
  const app = express();
  app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
    forms.push(req.body as Record<string, string>);
    const a = answer(forms.length);
    res.status(a.status).json(a.body);
  });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return { issuer: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, forms };
}

const settingsFor = (issuer: string, over: Record<string, unknown> = {}) => ({ issuer, audience: AUDIENCE, clientId: CLIENT, keyId: "checks-key-1", keyPem: KEY.privatePem, ...over });

describe("016 the machine caller asks the tenant for its own token (SEC-33)", () => {
  it("016 the request is client credentials for people's API, authenticated by an assertion signed with the caller's key", async () => {
    const t = await tokenEndpoint();
    const caller = new MachineCaller(settingsFor(t.issuer), { allowInsecureLoopback: true });
    expect(await caller.token()).toBe("token-1");
    expect(t.forms).toHaveLength(1);
    const form = t.forms[0]!;
    expect(Object.keys(form).sort()).toEqual(["audience", "client_assertion", "client_assertion_type", "client_id", "grant_type"]);
    expect(form).toMatchObject({ grant_type: "client_credentials", audience: AUDIENCE, client_id: CLIENT, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" });
    // The assertion: RS256, the key's ID, the client as issuer and subject, the tenant as audience, one minute at most.
    expect(decodeProtectedHeader(form.client_assertion!)).toEqual({ alg: "RS256", typ: "JWT", kid: "checks-key-1" });
    const { payload } = await jwtVerify(form.client_assertion!, createPublicKey(KEY.publicPem), { algorithms: ["RS256"], issuer: CLIENT, subject: CLIENT, audience: t.issuer });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
    expect(String(payload.jti).length).toBeGreaterThan(20);
    // Another key does not verify it: the tenant would refuse a caller that holds the wrong key.
    await expect(jwtVerify(form.client_assertion!, createPublicKey(OTHER_KEY.publicPem), { algorithms: ["RS256"] })).rejects.toThrow();
    // No secret is ever sent.
    expect(JSON.stringify(form)).not.toMatch(/client_secret|PRIVATE KEY/);
  });

  it("016 a token is reused until a minute before it expires, then asked for again with a fresh assertion", async () => {
    const t = await tokenEndpoint((n) => ({ status: 200, body: { access_token: `token-${n}`, expires_in: 600 } }));
    let now = Date.parse("2026-11-15T10:00:00.000Z");
    const caller = new MachineCaller(settingsFor(t.issuer), { allowInsecureLoopback: true, now: () => now });
    expect([await caller.token(), await caller.token()]).toEqual(["token-1", "token-1"]);
    now += 539_000; // 61 s before expiry: still the same token
    expect(await caller.token()).toBe("token-1");
    now += 2_000; // inside the last minute: a new one
    expect(await caller.token()).toBe("token-2");
    expect(t.forms).toHaveLength(2);
    expect(t.forms[0]!.client_assertion).not.toBe(t.forms[1]!.client_assertion);
  });

  it("016 a refusal says the status and nothing else: not the tenant's answer, the assertion or the key", async () => {
    const t = await tokenEndpoint(() => ({ status: 401, body: { error: "access_denied", error_description: SECRET_ANSWER } }));
    const caller = new MachineCaller(settingsFor(t.issuer), { allowInsecureLoopback: true });
    const message = await caller.token().then(
      () => "",
      (e: Error) => e.message,
    );
    expect(message).toBe("machine caller: the sign-in tenant refused the token request (HTTP 401)");
    for (const secret of [SECRET_ANSWER, t.forms[0]!.client_assertion!, "PRIVATE KEY", CLIENT]) expect(message.includes(secret)).toBe(false);
    // An answer without a token, and a tenant that is down, are errors too, in the same plain words.
    const empty = await tokenEndpoint(() => ({ status: 200, body: { token_type: "Bearer" } }));
    await expect(new MachineCaller(settingsFor(empty.issuer), { allowInsecureLoopback: true }).token()).rejects.toThrow("machine caller: the sign-in tenant's answer carried no token");
    await expect(new MachineCaller(settingsFor("http://127.0.0.1:1/"), { allowInsecureLoopback: true }).token()).rejects.toThrow("machine caller: the sign-in tenant could not be reached for a token");
  });

  it("016 the tenant is https outside tests, and an unusable key is named by its variable", async () => {
    expect(() => new MachineCaller(settingsFor("http://127.0.0.1:9/"))).toThrow(/AUTH_ISSUER must be the sign-in tenant's issuer/);
    expect(() => new MachineCaller(settingsFor("http://tenant.example/"), { allowInsecureLoopback: true })).toThrow(ConfigError);
    expect(() => new MachineCaller(settingsFor("https://x402-test.eu.auth0.com/"))).not.toThrow();
    const t = await tokenEndpoint();
    const broken = new MachineCaller(settingsFor(t.issuer, { keyPem: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" }), { allowInsecureLoopback: true });
    await expect(broken.token()).rejects.toThrow("MACHINE_CLIENT_KEY is not a usable RS256 private key");
    expect(t.forms).toHaveLength(0);
  });
});

describe("016 the machine caller's settings come from the environment, by name (CFG-2)", () => {
  const ENV = { AUTH_ISSUER: "https://x402-test.eu.auth0.com/", AUTH_AUDIENCE: AUDIENCE, MACHINE_CLIENT_ID: CLIENT, MACHINE_CLIENT_KEY_ID: "checks-key-1", MACHINE_CLIENT_KEY: KEY.privatePem };

  it("016 with MACHINE_CLIENT_ID the client, its key and the tenant are required; without it there is no machine caller", () => {
    expect(machineCallerFromEnv({})).toBeUndefined();
    expect(machineCallerFromEnv({ MACHINE_CLIENT_ID: "" })).toBeUndefined();
    expect(machineCallerFromEnv(ENV)).toEqual({ issuer: ENV.AUTH_ISSUER, audience: AUDIENCE, clientId: CLIENT, keyId: "checks-key-1", keyPem: KEY.privatePem });
    expect(machineCallerFromEnv({ ...ENV, MACHINE_CLIENT_KEY_ID: "" })).not.toHaveProperty("keyId");
    for (const missing of ["AUTH_ISSUER", "AUTH_AUDIENCE", "MACHINE_CLIENT_KEY"]) {
      expect(() => machineCallerFromEnv({ ...ENV, [missing]: "" }), missing).toThrow(`${missing} is required with MACHINE_CLIENT_ID`);
    }
    // A key with no client to belong to is a mistake, not something to ignore.
    expect(() => machineCallerFromEnv({ MACHINE_CLIENT_KEY: KEY.privatePem })).toThrow("MACHINE_CLIENT_KEY needs MACHINE_CLIENT_ID");
  });

  it("016 the vault's placeholder and a value that is not a key are refused by name, never repeated", () => {
    expect(() => machineCallerFromEnv({ ...ENV, MACHINE_CLIENT_KEY: "off" })).toThrow("MACHINE_CLIENT_KEY holds the placeholder");
    let message = "";
    try {
      machineCallerFromEnv({ ...ENV, MACHINE_CLIENT_KEY: "hunter2-not-a-key" });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      message = (e as Error).message;
    }
    expect(message).toBe("MACHINE_CLIENT_KEY must be a PKCS#8 private key in PEM");
    expect(message).not.toContain("hunter2");
  });

  it("016 a ready-made CALLER_TOKEN is a local convenience only, and the machine client wins over it", async () => {
    expect(callerTokenSourceFromEnv({})).toBeUndefined();
    expect(await callerTokenSourceFromEnv({ NETWORK: "local", CALLER_TOKEN: "dev-machine-token" })!()).toBe("dev-machine-token");
    expect(await callerTokenSourceFromEnv({ CALLER_TOKEN: "dev-machine-token" })!()).toBe("dev-machine-token"); // NETWORK defaults to local
    expect(() => callerTokenSourceFromEnv({ NETWORK: "base-sepolia", CALLER_TOKEN: "dev-machine-token" })).toThrow("CALLER_TOKEN is allowed only with NETWORK=local");
    const t = await tokenEndpoint();
    const source = callerTokenSourceFromEnv({ ...ENV, AUTH_ISSUER: t.issuer, CALLER_TOKEN: "ignored", NETWORK: "local" }, { allowInsecureLoopback: true });
    expect(await source!()).toBe("token-1");
  });
});
