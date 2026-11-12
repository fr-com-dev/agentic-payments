// 013 the shared token verifier (specs/013 research R19; contracts/portal-api.md "Access"). A person's token comes
// from the Auth0 tenant, a system identity's from the organization's directory. Each check has a refused case, and
// the checks this file owns (issuer, audience, subject, machine token; tenant, app-only) have a must-fail: with the
// check left out by the test-only `skipChecks`, the same token is accepted. The signature and the expiry are the
// library's and have refused cases only. The checks each service adds (client, permission, sign-in time, app role)
// have their must-fails in test/portal.test.ts and test/hosted-access.test.ts.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bearerToken,
  DEFAULT_AUTH_TIME_CLAIM,
  entraIssuer,
  issuerOf,
  PERSON_ISSUER_RE,
  signInTimeOf,
  verifyPersonToken,
  verifyServiceToken,
  type PersonVerifyOptions,
  type ServiceVerifyOptions,
  type TokenKeys,
} from "../src/shared/identity-token.js";

const ISSUER = "https://x402-test.eu.auth0.com/";
const AUDIENCE = "https://x402.example/api";
const TENANT = "11111111-2222-4333-8444-555555555555";
const SERVICE_AUDIENCE = "99999999-8888-4777-8666-555555555555";
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
      ["the organization's directory as issuer", () => sign(personClaims(), { iss: entraIssuer(TENANT) })],
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

describe("013 verifyServiceToken (an Entra app-only token)", () => {
  const service = (over: Partial<ServiceVerifyOptions> = {}): ServiceVerifyOptions => ({
    tenantId: TENANT,
    audience: SERVICE_AUDIENCE,
    issuer: entraIssuer(TENANT),
    ...keys,
    ...over,
  });
  const OID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const appClaims = (over: Record<string, unknown> = {}) => ({ tid: TENANT, oid: OID, idtyp: "app", roles: ["Agent.Run"], ...over });
  const entra: SignOptions = { iss: entraIssuer(TENANT), aud: SERVICE_AUDIENCE, sub: OID };

  it("accepts an app-only token and returns the tenant, the object ID and the roles", async () => {
    expect(await verifyServiceToken(await sign(appClaims({ roles: ["Agent.Run", 5] }), entra), service())).toEqual({
      ok: true,
      token: { tenantId: TENANT, objectId: OID, roles: ["Agent.Run"] },
    });
    const noRoles = await verifyServiceToken(await sign(appClaims({ roles: undefined }), entra), service());
    expect(noRoles.ok && noRoles.token.roles).toEqual([]);
  });

  describe("refuses with 401", () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ["a token signed by another key", () => sign(appClaims(), { ...entra, key: otherRsa })],
      ["an algorithm that is not on the list", () => sign(appClaims(), { ...entra, alg: "ES256" })],
      ["a person's Auth0 token", () => sign(personClaims())],
      ["another tenant's issuer", () => sign(appClaims(), { ...entra, iss: entraIssuer("00000000-0000-4000-8000-000000000000") })],
      ["another audience", () => sign(appClaims(), { ...entra, aud: "api://x402-l1-agent" })],
      ["an expired token", () => sign(appClaims(), { ...entra, exp: now() - 120 })],
      ["another tenant in `tid`", () => sign(appClaims({ tid: "00000000-0000-4000-8000-000000000000" }), entra)],
      ["no object ID", () => sign(appClaims({ oid: undefined }), entra)],
      ["an empty object ID", () => sign(appClaims({ oid: "" }), entra)],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        expect(await verifyServiceToken(await make(), service())).toEqual({ ok: false, status: 401 });
      });
    }
  });

  describe("refuses a person's token from the directory with 403", () => {
    for (const [name, idtyp] of [["idtyp user", "user"], ["no idtyp", undefined], ["idtyp in another case", "App"], ["idtyp as a list", ["app"]]] as const) {
      it(name, async () => {
        const token = await sign(appClaims({ idtyp, scp: "user_impersonation" }), entra);
        expect(await verifyServiceToken(token, service())).toEqual({ ok: false, status: 403 });
      });
    }
  });

  describe("must-fail: without the check, the same token is accepted", () => {
    it("tenant", async () => {
      const token = await sign(appClaims({ tid: "00000000-0000-4000-8000-000000000000" }), entra);
      expect((await verifyServiceToken(token, service())).ok).toBe(false);
      expect((await verifyServiceToken(token, service({ skipChecks: ["tenant"] }))).ok).toBe(true);
    });
    it("app-only", async () => {
      const token = await sign(appClaims({ idtyp: "user" }), entra);
      expect((await verifyServiceToken(token, service())).ok).toBe(false);
      expect((await verifyServiceToken(token, service({ skipChecks: ["appOnly"] }))).ok).toBe(true);
    });
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
      entraIssuer(TENANT),
    ]) {
      expect(PERSON_ISSUER_RE.test(bad), bad).toBe(false);
    }
  });
});
