// 013 and 016: the shared token verifier (specs/013 research R19; contracts/portal-api.md "Access"; specs/016
// research R2). Every token comes from the sign-in tenant. `verifyPersonToken` is the portal's base check;
// `verifyCaller` is the one check of a caller of the hosted agent, run by the agent and again by L2: a person with
// the permission from a listed client, or a machine caller with the permission. Each check has a refused case, and
// the checks this file owns (issuer, audience, subject, machine token; permission, client, a machine token's
// subject) have a must-fail: with the check left out by the test-only `skipChecks`, the same token is accepted.
// The signature and the expiry are the library's and have refused cases only. The checks the portal adds (its
// client, the sign-in time, the administrator's permission) have their must-fails in test/portal.test.ts.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bearerToken,
  DEFAULT_AUTH_TIME_CLAIM,
  issuerOf,
  PERSON_ISSUER_RE,
  signInTimeOf,
  verifyCaller,
  verifyPersonToken,
  type CallerVerifyOptions,
  type PersonVerifyOptions,
  type TokenKeys,
} from "../src/shared/identity-token.js";

const ISSUER = "https://x402-test.eu.auth0.com/";
const AUDIENCE = "https://x402.example/api";
/** The organization's directory as an issuer: since 016 just another issuer, refused like any other. */
const DIRECTORY_ISSUER = "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0";
const now = () => Math.floor(Date.now() / 1000);

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let rsa: Key;
let otherRsa: Key;
let ec: Key;
let keys: TokenKeys;

async function pair(alg: string, kid: string): Promise<{ privateKey: Key; jwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } };
}

beforeAll(async () => {
  const a = await pair("RS256", "rsa-1");
  const b = await pair("RS256", "rsa-1"); // the same key ID, another key
  const c = await pair("ES256", "ec-1");
  rsa = a.privateKey;
  otherRsa = b.privateKey;
  ec = c.privateKey;
  // The EC key is in the set on purpose: the algorithm list, not the key set, must refuse it.
  keys = { keys: createLocalJWKSet({ keys: [a.jwk, c.jwk] }), algorithms: ["RS256"] };
});

interface SignOptions {
  key?: Key;
  alg?: string;
  kid?: string;
  iss?: string | null;
  aud?: string | string[] | null;
  sub?: string | null;
  exp?: number | null;
  nbf?: number;
}

async function sign(claims: Record<string, unknown>, o: SignOptions = {}): Promise<string> {
  const alg = o.alg ?? "RS256";
  const jwt = new SignJWT(claims).setProtectedHeader({ alg, kid: o.kid ?? (alg === "RS256" ? "rsa-1" : "ec-1"), typ: "at+jwt" }).setIssuedAt();
  if (o.iss !== null) jwt.setIssuer(o.iss ?? ISSUER);
  if (o.aud !== null) jwt.setAudience(o.aud ?? [AUDIENCE, `${ISSUER}userinfo`]);
  if (o.sub !== null) jwt.setSubject(o.sub ?? "auth0|6543210fedcba");
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? now() + 3600);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(o.key ?? (alg === "RS256" ? rsa : ec));
}

const personClaims = (over: Record<string, unknown> = {}) => ({
  azp: "portal-client",
  scope: "openid offline_access",
  permissions: ["agent:run"],
  [DEFAULT_AUTH_TIME_CLAIM]: now() - 5,
  ...over,
});

const person = (over: Partial<PersonVerifyOptions> = {}): PersonVerifyOptions => ({ issuer: ISSUER, audience: AUDIENCE, ...keys, ...over });

describe("013 verifyPersonToken (an Auth0 access token)", () => {
  it("accepts a person's token and returns what the services decide on", async () => {
    const at = now() - 5;
    const res = await verifyPersonToken(await sign(personClaims({ [DEFAULT_AUTH_TIME_CLAIM]: at })), person());
    expect(res).toEqual({
      ok: true,
      token: { issuer: ISSUER, subject: "auth0|6543210fedcba", client: "portal-client", permissions: ["agent:run"], signInTime: at },
    });
  });

  it("the audience may be one value or a list that contains the API", async () => {
    expect((await verifyPersonToken(await sign(personClaims(), { aud: AUDIENCE }), person())).ok).toBe(true);
    expect((await verifyPersonToken(await sign(personClaims(), { aud: ["https://other", AUDIENCE] }), person())).ok).toBe(true);
  });

  it("reads the client from `azp` or from `client_id`, and trusts neither when they disagree", async () => {
    const client = async (claims: Record<string, unknown>) => {
      const res = await verifyPersonToken(await sign({ permissions: ["agent:run"], ...claims }), person());
      return res.ok ? res.token.client : "refused";
    };
    expect(await client({ azp: "a" })).toBe("a");
    expect(await client({ client_id: "a" })).toBe("a");
    expect(await client({ azp: "a", client_id: "a" })).toBe("a");
    expect(await client({ azp: "a", client_id: "b" })).toBeNull();
    expect(await client({})).toBeNull();
    expect(await client({ azp: "" })).toBeNull();
    expect(await client({ azp: 7 })).toBeNull();
  });

  it("returns only text permissions, and none when the claim is not a list", async () => {
    const perms = async (permissions: unknown) => {
      const res = await verifyPersonToken(await sign(personClaims({ permissions })), person());
      return res.ok ? res.token.permissions : "refused";
    };
    expect(await perms(["agent:run", 3, null, "other"])).toEqual(["agent:run", "other"]);
    expect(await perms("agent:run")).toEqual([]);
    expect(await perms(undefined)).toEqual([]);
  });

  it("reads the sign-in time from the configured claim only", async () => {
    const token = await sign(personClaims({ auth_time: 111, "https://other.example/auth_time": 222 }));
    const def = await verifyPersonToken(token, person());
    const other = await verifyPersonToken(token, person({ authTimeClaim: "https://other.example/auth_time" }));
    const missing = await verifyPersonToken(token, person({ authTimeClaim: "https://nowhere.example/t" }));
    expect(def.ok && def.token.signInTime).not.toBe(111);
    expect(other.ok && other.token.signInTime).toBe(222);
    expect(missing.ok && missing.token.signInTime).toBeUndefined();
  });

  describe("refuses with 401", () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ["text that is not a token", async () => "not-a-token"],
      ["a token signed by another key with the same key ID", () => sign(personClaims(), { key: otherRsa })],
      ["an unsigned token", async () => {
        const [, payload] = (await sign(personClaims())).split(".");
        return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
      }],
      ["an algorithm that is not on the list, from a key that is in the set", () => sign(personClaims(), { alg: "ES256" })],
      ["another issuer", () => sign(personClaims(), { iss: "https://evil.eu.auth0.com/" })],
      ["the issuer without its final slash", () => sign(personClaims(), { iss: ISSUER.slice(0, -1) })],
      ["the organization's directory as issuer", () => sign(personClaims(), { iss: DIRECTORY_ISSUER })],
      ["no issuer", () => sign(personClaims(), { iss: null })],
      ["another audience", () => sign(personClaims(), { aud: "https://other.example/api" })],
      ["only the tenant's userinfo audience", () => sign(personClaims(), { aud: `${ISSUER}userinfo` })],
      ["no audience", () => sign(personClaims(), { aud: null })],
      ["an expired token, beyond the tolerance", () => sign(personClaims(), { exp: now() - 120 })],
      ["a token that is not valid yet, beyond the tolerance", () => sign(personClaims(), { nbf: now() + 120 })],
      ["no expiry", () => sign(personClaims(), { exp: null })],
      ["no subject", () => sign(personClaims(), { sub: null })],
      ["an empty subject", () => sign(personClaims(), { sub: "" })],
      ["a subject with a line break", () => sign(personClaims(), { sub: "auth0|a\nb" })],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        expect(await verifyPersonToken(await make(), person())).toEqual({ ok: false, status: 401 });
      });
    }
  });

  it("allows 60 s of clock difference, and no more", async () => {
    expect((await verifyPersonToken(await sign(personClaims(), { exp: now() - 30 }), person())).ok).toBe(true);
    expect((await verifyPersonToken(await sign(personClaims(), { nbf: now() + 30 }), person())).ok).toBe(true);
    expect((await verifyPersonToken(await sign(personClaims(), { exp: now() - 30 }), person({ clockToleranceSec: 5 }))).ok).toBe(false);
  });

  describe("refuses a machine token with 403", () => {
    const cases: Array<[string, Record<string, unknown>, SignOptions]> = [
      ["the client-credentials grant", { gty: "client-credentials", azp: "m2m" }, { sub: "m2m@clients" }],
      ["a subject that ends in @clients, whatever the grant says", { azp: "m2m" }, { sub: "m2m@clients" }],
      ["the client-credentials grant, whatever the subject says", { gty: "client-credentials" }, {}],
      ["the grant inside a list", { gty: ["refresh_token", "client-credentials"] }, {}],
    ];
    for (const [name, claims, o] of cases) {
      it(name, async () => {
        expect(await verifyPersonToken(await sign(personClaims(claims), o), person())).toEqual({ ok: false, status: 403 });
      });
    }
    it("a person's other grants are not machine tokens", async () => {
      expect((await verifyPersonToken(await sign(personClaims({ gty: "password" })), person())).ok).toBe(true);
      expect((await verifyPersonToken(await sign(personClaims({ gty: ["refresh_token", "password"] })), person())).ok).toBe(true);
    });
  });

  describe("must-fail: without the check, the same token is accepted", () => {
    it("issuer", async () => {
      const token = await sign(personClaims(), { iss: "https://evil.eu.auth0.com/" });
      expect((await verifyPersonToken(token, person())).ok).toBe(false);
      expect((await verifyPersonToken(token, person({ skipChecks: ["issuer"] }))).ok).toBe(true);
    });
    it("audience", async () => {
      const token = await sign(personClaims(), { aud: "https://other.example/api" });
      expect((await verifyPersonToken(token, person())).ok).toBe(false);
      expect((await verifyPersonToken(token, person({ skipChecks: ["audience"] }))).ok).toBe(true);
    });
    it("subject", async () => {
      const token = await sign(personClaims(), { sub: null });
      expect((await verifyPersonToken(token, person())).ok).toBe(false);
      expect((await verifyPersonToken(token, person({ skipChecks: ["subject"] }))).ok).toBe(true);
    });
    it("machine token", async () => {
      const token = await sign(personClaims({ gty: "client-credentials" }), { sub: "m2m@clients" });
      expect(await verifyPersonToken(token, person())).toEqual({ ok: false, status: 403 });
      expect((await verifyPersonToken(token, person({ skipChecks: ["machine"] }))).ok).toBe(true);
    });
  });
});

describe("013 signInTimeOf", () => {
  const nowMs = 1_800_000_000_000;
  const at = nowMs / 1000;
  it("gives the time when it is an integer that is not in the future beyond 60 s", () => {
    expect(signInTimeOf({ signInTime: at - 600 }, nowMs)).toBe(at - 600);
    expect(signInTimeOf({ signInTime: at + 60 }, nowMs)).toBe(at + 60);
    expect(signInTimeOf({ signInTime: 0 }, nowMs)).toBe(0);
  });
  it("gives null for anything else", () => {
    for (const v of [undefined, null, "1800000000", at + 61, at - 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, {}, [at]]) {
      expect(signInTimeOf({ signInTime: v }, nowMs), String(v)).toBeNull();
    }
  });
});

describe("016 verifyCaller (a caller of the hosted agent: the agent's check, and L2's)", () => {
  const AGENT_CLIENT = "agent-client";
  const MACHINE_CLIENT = "checks-client";
  const caller = (over: Partial<CallerVerifyOptions> = {}): CallerVerifyOptions => ({ issuer: ISSUER, audience: AUDIENCE, clientIds: [AGENT_CLIENT], ...keys, ...over });
  const personOf = (over: Record<string, unknown> = {}) => personClaims({ azp: AGENT_CLIENT, ...over });
  const machineOf = (over: Record<string, unknown> = {}) => ({ gty: "client-credentials", azp: MACHINE_CLIENT, scope: "agent:run", ...over });
  const machine: SignOptions = { sub: `${MACHINE_CLIENT}@clients` };
  const invalid = { ok: false, status: 401, reason: "invalid" };
  const forbidden = { ok: false, status: 403, reason: "forbidden" };

  it("accepts a person with the permission from a listed client, and says who they are", async () => {
    expect(await verifyCaller(await sign(personOf()), caller())).toEqual({
      ok: true,
      caller: { kind: "person", issuer: ISSUER, subject: "auth0|6543210fedcba", client: AGENT_CLIENT },
    });
    // The tenant's other token dialect names the client as `client_id`.
    expect((await verifyCaller(await sign(personOf({ azp: undefined, client_id: AGENT_CLIENT })), caller())).ok).toBe(true);
  });

  it("accepts a machine caller whose grant gives the permission, in `scope` or in `permissions`", async () => {
    const subject = `${MACHINE_CLIENT}@clients`;
    const expected = { ok: true, caller: { kind: "machine", issuer: ISSUER, subject, client: MACHINE_CLIENT } };
    expect(await verifyCaller(await sign(machineOf(), machine), caller())).toEqual(expected);
    expect(await verifyCaller(await sign(machineOf({ scope: "other agent:run" }), machine), caller())).toEqual(expected);
    expect(await verifyCaller(await sign(machineOf({ scope: undefined, permissions: ["agent:run"] }), machine), caller())).toEqual(expected);
    // No `gty` (the tenant's other dialect): the subject alone marks it, and the client is not on any list.
    expect(await verifyCaller(await sign(machineOf({ gty: undefined, azp: undefined, client_id: MACHINE_CLIENT }), machine), caller({ clientIds: [] }))).toEqual(expected);
  });

  describe("refuses with 401", () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ["text that is not a token", async () => "not-a-token"],
      ["a token signed by another key with the same key ID", () => sign(personOf(), { key: otherRsa })],
      ["an algorithm that is not on the list", () => sign(personOf(), { alg: "ES256" })],
      ["another issuer", () => sign(personOf(), { iss: "https://evil.eu.auth0.com/" })],
      ["the organization's directory as issuer", () => sign(personOf(), { iss: DIRECTORY_ISSUER })],
      ["another audience", () => sign(personOf(), { aud: "https://other.example/api" })],
      ["a token that is not valid yet, beyond the tolerance", () => sign(personOf(), { nbf: now() + 120 })],
      ["no expiry", () => sign(personOf(), { exp: null })],
      ["no subject", () => sign(personOf(), { sub: null })],
      ["a subject with a line break", () => sign(personOf(), { sub: "auth0|a\nb" })],
      ["a machine token that names no client", () => sign(machineOf({ azp: undefined }), machine)],
      ["a machine token whose subject is another client's", () => sign(machineOf(), { sub: "other-client@clients" })],
      ["a client-credentials token with a person's subject", () => sign(machineOf(), { sub: "auth0|6543210fedcba" })],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        expect(await verifyCaller(await make(), caller())).toEqual(invalid);
      });
    }

    it("an expired token is told apart, so the agent can say the sign-in expired", async () => {
      expect(await verifyCaller(await sign(personOf(), { exp: now() - 120 }), caller())).toEqual({ ok: false, status: 401, reason: "expired" });
      expect(await verifyCaller(await sign(machineOf(), { ...machine, exp: now() - 120 }), caller())).toEqual({ ok: false, status: 401, reason: "expired" });
      // Expired and from another issuer: the issuer is what is wrong with it.
      expect(await verifyCaller(await sign(personOf(), { exp: now() - 120, key: otherRsa }), caller())).toEqual(invalid);
      // Inside the tolerance it is still valid.
      expect((await verifyCaller(await sign(personOf(), { exp: now() - 30 }), caller())).ok).toBe(true);
    });
  });

  describe("refuses with 403", () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ["a person without the permission", () => sign(personOf({ permissions: [] }))],
      ["a person with another permission only", () => sign(personOf({ permissions: ["portal:admin"] }))],
      ["a person whose permission is only in `scope` (what the client asked for)", () => sign(personOf({ permissions: [], scope: "openid agent:run" }))],
      ["a person from a client that is not on the list (the portal's)", () => sign(personOf({ azp: "portal-client" }))],
      ["a person whose token names no client", () => sign(personOf({ azp: undefined }))],
      ["a person whose token names two clients", () => sign(personOf({ client_id: "other-client" }))],
      ["a machine caller whose grant lacks the permission", () => sign(machineOf({ scope: "other:thing" }), machine)],
      ["a machine caller with no scope and no permissions", () => sign(machineOf({ scope: undefined }), machine)],
      ["a machine caller whose scope only contains the permission's name inside another word", () => sign(machineOf({ scope: "xagent:run agent:runner" }), machine)],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        expect(await verifyCaller(await make(), caller())).toEqual(forbidden);
      });
    }
  });

  describe("must-fail: without the check, the same token is accepted", () => {
    it("permission, for a person and for a machine caller", async () => {
      const person = await sign(personOf({ permissions: [] }));
      expect(await verifyCaller(person, caller())).toEqual(forbidden);
      expect((await verifyCaller(person, caller({ skipChecks: ["permission"] }))).ok).toBe(true);
      const m = await sign(machineOf({ scope: undefined }), machine);
      expect(await verifyCaller(m, caller())).toEqual(forbidden);
      expect((await verifyCaller(m, caller({ skipChecks: ["permission"] }))).ok).toBe(true);
    });
    it("client: a portal token would be a caller's", async () => {
      const token = await sign(personOf({ azp: "portal-client" }));
      expect(await verifyCaller(token, caller())).toEqual(forbidden);
      expect((await verifyCaller(token, caller({ skipChecks: ["client"] }))).ok).toBe(true);
    });
    it("a machine token's subject: one client would pass for another", async () => {
      const token = await sign(machineOf(), { sub: "other-client@clients" });
      expect(await verifyCaller(token, caller())).toEqual(invalid);
      expect(await verifyCaller(token, caller({ skipChecks: ["machineSubject"] }))).toEqual({
        ok: true,
        caller: { kind: "machine", issuer: ISSUER, subject: "other-client@clients", client: MACHINE_CLIENT },
      });
    });
  });

  it("the portal's check still refuses every machine token, with or without the permission", async () => {
    expect(await verifyPersonToken(await sign(machineOf(), machine), person())).toEqual({ ok: false, status: 403 });
  });
});

describe("013 issuerOf, bearerToken and the issuer pattern", () => {
  it("issuerOf reads `iss` without verifying, and gives null for anything it can't read", async () => {
    expect(issuerOf(await sign(personClaims()))).toBe(ISSUER);
    // Signed by a key nobody trusts: still read, because the value only chooses which checks run.
    expect(issuerOf(await sign(personClaims(), { key: otherRsa, iss: "https://evil.example/" }))).toBe("https://evil.example/");
    expect(issuerOf(await sign(personClaims(), { iss: null }))).toBeNull();
    for (const bad of ["", "abc", "a.b.c", "a.b"]) expect(issuerOf(bad), bad).toBeNull();
    const numeric = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"iss":5}').toString("base64url")}.`;
    expect(issuerOf(numeric)).toBeNull();
  });

  it("bearerToken takes exactly one token after Bearer", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    for (const bad of [undefined, "", "Bearer", "Bearer a b", "Basic abc", ["Bearer abc"]]) expect(bearerToken(bad)).toBeNull();
  });

  it("an Auth0 issuer is https://<domain>/ with the final slash and nothing after it", () => {
    for (const ok of ["https://x402-dev.eu.auth0.com/", "https://login.example.com/"]) expect(PERSON_ISSUER_RE.test(ok), ok).toBe(true);
    for (const bad of [
      "https://x402-dev.eu.auth0.com",
      "http://x402-dev.eu.auth0.com/",
      "https://x402-dev.eu.auth0.com/v2/",
      "https://X402.eu.auth0.com/",
      "https://a b/",
      "urn:x402:dev-issuer",
      DIRECTORY_ISSUER,
    ]) {
      expect(PERSON_ISSUER_RE.test(bad), bad).toBe(false);
    }
  });
});
