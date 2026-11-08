// 012 T-CIBA-01 (configuration) and T-CIBA-02 (request shape) for src/layer2-control/ciba-client.ts, against the
// stand-in Auth0 (test/helpers/ciba-stub.ts). Also the sealed handle and the error classification (NFR-003/006).
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { CibaClient, cibaConfigFromEnv, type CibaSettings, errorCode } from "../src/layer2-control/ciba-client.js";
import { type CibaStub, PLANTED_ERROR_TEXT, startCibaStub, testRsaKeyPair } from "./helpers/ciba-stub.js";

const KEY = testRsaKeyPair();
const SECRET = "s3cret-client-secret-value-0123456789";
const APPROVER = "auth0|approver-1";
const CLIENT_ID = "client-l2";
const AUDIENCE = "https://x402-payments.example/";
const base = {
  CIBA_APPROVAL: "1",
  CIBA_ISSUER: "https://tenant.example.auth0.com/",
  CIBA_CLIENT_ID: CLIENT_ID,
  CIBA_AUDIENCE: AUDIENCE,
  CIBA_APPROVER: APPROVER,
  CIBA_CLIENT_KEY: KEY.privatePem,
};
const pemBody = (pem: string) => pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("T-CIBA-01 configuration", () => {
  it.each([[{}], [{ CIBA_APPROVAL: "" }], [{ CIBA_APPROVAL: "0" }]])("off for %j", (env) => {
    expect(cibaConfigFromEnv(env)).toEqual({ enabled: false, ignored: [] });
  });

  it("off with stray CIBA_* variables lists their names, never their values", () => {
    const cfg = cibaConfigFromEnv({ CIBA_ISSUER: "https://x/", CIBA_CLIENT_SECRET: SECRET });
    expect(cfg).toEqual({ enabled: false, ignored: ["CIBA_ISSUER", "CIBA_CLIENT_SECRET"] });
  });

  it("Azure's placeholder credential: ignored silently while off, refused naming the variable while on", () => {
    expect(cibaConfigFromEnv({ CIBA_APPROVAL: "0", CIBA_CLIENT_KEY: "off", CIBA_ISSUER: "", CIBA_CLIENT_KEY_ID: "" })).toEqual({ enabled: false, ignored: [] });
    expect(cibaConfigFromEnv({ CIBA_APPROVAL: "0", CIBA_CLIENT_SECRET: "off" })).toEqual({ enabled: false, ignored: [] });
    expect(message(() => cibaConfigFromEnv({ ...base, CIBA_CLIENT_KEY: "off" }))).toMatch(/^CIBA_CLIENT_KEY still holds the placeholder/);
    const { CIBA_CLIENT_KEY: _k, ...noKey } = base;
    expect(message(() => cibaConfigFromEnv({ ...noKey, CIBA_CLIENT_SECRET: "off" }))).toMatch(/^CIBA_CLIENT_SECRET still holds the placeholder/);
  });

  it("on with a complete key configuration; the trailing / is added", () => {
    const cfg = cibaConfigFromEnv({ ...base, CIBA_ISSUER: "https://tenant.example.auth0.com", CIBA_CLIENT_KEY_ID: "kid-1" });
    expect(cfg).toMatchObject({ enabled: true, issuer: "https://tenant.example.auth0.com/", clientId: CLIENT_ID, audience: AUDIENCE, approver: APPROVER });
    expect(cfg.enabled && cfg.credential).toMatchObject({ kind: "key", keyId: "kid-1" });
  });

  it("accepts \\n escapes in the key and a client secret instead of a key", () => {
    expect(cibaConfigFromEnv({ ...base, CIBA_CLIENT_KEY: KEY.privatePem.replace(/\n/g, "\\n") }).enabled).toBe(true);
    const { CIBA_CLIENT_KEY: _k, ...noKey } = base;
    const cfg = cibaConfigFromEnv({ ...noKey, CIBA_CLIENT_SECRET: SECRET });
    expect(cfg.enabled && cfg.credential).toEqual({ kind: "secret", secret: SECRET });
  });

  const rsa1024 = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const { CIBA_CLIENT_KEY: _drop, ...withoutKey } = base;
  it.each<[string, Record<string, string>, string]>([
    ["CIBA_APPROVAL=yes", { ...base, CIBA_APPROVAL: "yes" }, "CIBA_APPROVAL"],
    ["no issuer", { ...base, CIBA_ISSUER: "" }, "CIBA_ISSUER"],
    ["http issuer", { ...base, CIBA_ISSUER: "http://tenant.example/" }, "CIBA_ISSUER"],
    ["issuer with a query", { ...base, CIBA_ISSUER: "https://tenant.example/?x=1" }, "CIBA_ISSUER"],
    ["no client id", { ...base, CIBA_CLIENT_ID: "" }, "CIBA_CLIENT_ID"],
    ["client id with a space", { ...base, CIBA_CLIENT_ID: "a b" }, "CIBA_CLIENT_ID"],
    ["client id over 64", { ...base, CIBA_CLIENT_ID: "c".repeat(65) }, "CIBA_CLIENT_ID"],
    ["no audience", { ...base, CIBA_AUDIENCE: "" }, "CIBA_AUDIENCE"],
    ["no approver", { ...base, CIBA_APPROVER: "" }, "CIBA_APPROVER"],
    ["neither credential", withoutKey, "CIBA_CLIENT_KEY or CIBA_CLIENT_SECRET"],
    ["both credentials", { ...base, CIBA_CLIENT_SECRET: SECRET }, "CIBA_CLIENT_KEY and CIBA_CLIENT_SECRET"],
    ["not a PEM", { ...base, CIBA_CLIENT_KEY: "not-a-key" }, "CIBA_CLIENT_KEY"],
    ["a 1024-bit key", { ...base, CIBA_CLIENT_KEY: rsa1024 }, "CIBA_CLIENT_KEY"],
    ["an EC key", { ...base, CIBA_CLIENT_KEY: ec }, "CIBA_CLIENT_KEY"],
    ["a short secret", { ...withoutKey, CIBA_CLIENT_SECRET: "short" }, "CIBA_CLIENT_SECRET"],
    ["a key id with a secret", { ...withoutKey, CIBA_CLIENT_SECRET: SECRET, CIBA_CLIENT_KEY_ID: "k" }, "CIBA_CLIENT_KEY_ID"],
  ])("%s stops startup naming the variable, never a value", (_label, env, name) => {
    const m = message(() => cibaConfigFromEnv(env));
    expect(m).toContain(name);
    expect(m).not.toContain(pemBody(KEY.privatePem).slice(0, 40));
    expect(m).not.toContain(SECRET);
    expect(m).not.toContain(pemBody(rsa1024).slice(0, 40));
  });
});

let stub: CibaStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function setup(credential: "key" | "secret" = "key") {
  stub = await startCibaStub({ approver: APPROVER, clientId: CLIENT_ID, audience: AUDIENCE, clientPublicKeyPem: KEY.publicPem, clientSecret: SECRET });
  const settings: CibaSettings = {
    issuer: stub.issuer,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    approver: APPROVER,
    credential: credential === "key" ? { kind: "key", keyPem: KEY.privatePem, keyId: "kid-l2" } : { kind: "secret", secret: SECRET },
  };
  return { stub, client: new CibaClient(settings, { allowInsecureLoopback: true, startTimeoutMs: 300, pollTimeoutMs: 300 }), settings };
}
const DETAILS = [{ type: "urn:auth0:schemas:authorization-details:v1:x402-payment", instruction: "i", properties: { a: { display: true, name: "A", display_order: 1, value: "1" } } }];
const params = { bindingMessage: "Pay_0.05_USDC_to_0x95Ac..f057_#3f9c2a1b", requestedExpiry: 298, authorizationDetails: DETAILS };

describe("T-CIBA-02 request shape", () => {
  it("bc-authorize gets exactly the contract's fields and a private_key_jwt assertion that verifies", async () => {
    const { stub: s, client } = await setup();
    const r = await client.start(params);
    expect(r).toMatchObject({ kind: "ok", expiresIn: 300, interval: 1 });
    const form = s.startForms()[0]!;
    expect(Object.keys(form).sort()).toEqual(
      ["audience", "authorization_details", "binding_message", "client_assertion", "client_assertion_type", "client_id", "login_hint", "requested_expiry", "scope"].sort(),
    );
    expect(form).toMatchObject({ client_id: CLIENT_ID, scope: "openid", audience: AUDIENCE, binding_message: params.bindingMessage, requested_expiry: "298" });
    expect(JSON.parse(form.login_hint!)).toEqual({ format: "iss_sub", iss: s.issuer, sub: APPROVER });
    expect(JSON.parse(form.authorization_details!)).toEqual(DETAILS);
    expect(form.client_assertion_type).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    const claims = s.assertions[0]!;
    expect(claims).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: s.issuer });
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    expect(typeof claims.jti).toBe("string");
  });

  it("each call gets a fresh assertion (unique jti)", async () => {
    const { stub: s, client } = await setup();
    const r = await client.start(params);
    await client.poll((r as { authReqId: string }).authReqId);
    expect(s.assertions).toHaveLength(2);
    expect(s.assertions[0]!.jti).not.toBe(s.assertions[1]!.jti);
  });

  it("client_secret_post sends client_id and client_secret and no assertion", async () => {
    const { stub: s, client } = await setup("secret");
    expect((await client.start(params)).kind).toBe("ok");
    const form = s.startForms()[0]!;
    expect(form.client_secret).toBe(SECRET);
    expect(form.client_assertion).toBeUndefined();
  });

  it("polls hit the token endpoint with the CIBA grant; only the two POST paths are ever called", async () => {
    const { stub: s, client } = await setup();
    s.setAnswers("pending", { approve: {} });
    const r = (await client.start(params)) as { authReqId: string };
    expect(await client.poll(r.authReqId)).toEqual({ kind: "pending" });
    const t = await client.poll(r.authReqId);
    expect(t.kind).toBe("token");
    expect(decodeJwt((t as { accessToken: string }).accessToken).sub).toBe(APPROVER);
    const polls = s.requests.filter((q) => q.path === "/oauth/token");
    expect(polls.every((q) => q.form.grant_type === "urn:openid:params:grant-type:ciba" && q.form.auth_req_id === r.authReqId)).toBe(true);
    expect([...new Set(s.requests.map((q) => q.path))].sort()).toEqual(["/bc-authorize", "/oauth/token"]);
  });

  it("an http issuer is refused unless the test-only loopback switch is set", async () => {
    const { settings } = await setup();
    expect(() => new CibaClient(settings)).toThrow(/CIBA_ISSUER/);
  });
});

describe("012 sealed handle", () => {
  it("opens with the same key and aad only; never contains the handle", async () => {
    const { client, settings } = await setup();
    const handle = "areq-0123456789abcdef";
    const sealed = client.seal(handle, "auth_x|apq_y");
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain(handle);
    expect(client.open(sealed, "auth_x|apq_y")).toBe(handle);
    expect(client.open(sealed, "auth_x|apq_z")).toBeNull();
    const other = new CibaClient({ ...settings, credential: { kind: "key", keyPem: testRsaKeyPair().privatePem } }, { allowInsecureLoopback: true });
    expect(other.open(sealed, "auth_x|apq_y")).toBeNull();
    const [v, iv, ct, tag] = sealed.split(".");
    const bytes = Buffer.from(ct!, "base64url");
    bytes[0] = bytes[0]! ^ 0xff; // always a different ciphertext
    const flipped = `${v}.${iv}.${bytes.toString("base64url")}.${tag}`;
    expect(client.open(flipped, "auth_x|apq_y")).toBeNull();
  });
});

describe("012 error classification", () => {
  it.each<[string, Parameters<CibaStub["setStart"]>[0], Record<string, unknown>]>([
    ["503", "503", { kind: "transient", failure: "transient", httpStatus: 503 }],
    ["429", "429", { kind: "transient", failure: "transient", httpStatus: 429 }],
    ["a non-JSON body", "not_json", { kind: "transient", failure: "transient", httpStatus: 200 }],
    ["a timeout", "hang", { kind: "transient", failure: "transient" }],
    ["a dropped connection", "unreachable", { kind: "transient", failure: "unreachable" }],
    ["unknown_user_id", { permanent: "unknown_user_id" }, { kind: "permanent", httpStatus: 400, error: "unknown_user_id" }],
    ["an unknown error code", { permanent: "weird_new_error" }, { kind: "permanent", httpStatus: 400, error: "other" }],
  ])("start: %s", async (_l, mode, expected) => {
    const { stub: s, client } = await setup();
    s.setStart(mode);
    const r = await client.start(params);
    expect(r).toEqual(expected);
    expect(JSON.stringify(r)).not.toContain(PLANTED_ERROR_TEXT);
  });

  it("poll: each documented answer maps to its kind, never carrying Auth0's text", async () => {
    const { stub: s, client } = await setup();
    s.setAnswers({ slow_down: 7 }, { slow_down: null }, "deny", "expired_token", "503", "invalid_grant");
    const { authReqId } = (await client.start(params)) as { authReqId: string };
    const got = [];
    for (let i = 0; i < 6; i++) got.push(await client.poll(authReqId));
    expect(got).toEqual([
      { kind: "slow_down", interval: 7 },
      { kind: "slow_down" },
      { kind: "denied" },
      { kind: "expired" },
      { kind: "transient", httpStatus: 503 },
      { kind: "permanent", httpStatus: 400, error: "invalid_grant" },
    ]);
    expect(JSON.stringify(got)).not.toContain(PLANTED_ERROR_TEXT);
  });

  it("errorCode keeps only the fixed list", () => {
    expect(errorCode("unauthorized_client")).toBe("unauthorized_client");
    expect(errorCode(PLANTED_ERROR_TEXT)).toBe("other");
    expect(errorCode(42)).toBe("other");
  });
});
