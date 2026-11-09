// 012 T-CIBA-08 verification (unit): src/layer2-control/approval-evidence.ts against tokens signed by a local RSA
// key served through a local JWKS. Each check fails on its own forgery, and each (but malformed) is shown to fail
// without its check (Constitution VIII).
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ApprovalKeys,
  type ExpectedApproval,
  type VerificationCheck,
  verifyApprovalToken,
} from "../src/layer2-control/approval-evidence.js";

const ISSUER = "https://tenant.example.auth0.com/";
const AUDIENCE = "https://x402-payments.example/";
const CLIENT = "client-l2";
const APPROVER = "auth0|approver-1";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const nowS = Math.floor(NOW / 1000);
const REQUEST_ID = "apq_11111111-1111-4111-8111-111111111111";
const details = (over: { requestId?: string; amount?: string } = {}) => [
  {
    type: "urn:auth0:schemas:authorization-details:v1:x402-payment",
    instruction: "Approve this payment only if you expect it",
    properties: {
      amount_atomic: { display: false, name: "Amount (atomic)", display_order: 8, value: over.amount ?? "50000" },
      request_id: { display: false, name: "Request", display_order: 7, value: over.requestId ?? REQUEST_ID },
    },
  },
];
const expected = (over: Partial<ExpectedApproval> = {}): ExpectedApproval => ({
  issuer: ISSUER,
  audience: AUDIENCE,
  clientId: CLIENT,
  approver: APPROVER,
  requestId: REQUEST_ID,
  sentDetails: details(),
  ...over,
});

let keys: ApprovalKeys;
let signKey: CryptoKey;
let rogueKey: CryptoKey;
const KID = "kid-test";
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256");
  signKey = pair.privateKey;
  rogueKey = rogue.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] }) as unknown as ApprovalKeys;
});

interface TokenOpts {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  clientId?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  details?: unknown;
  rogue?: boolean;
}
async function token(o: TokenOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    aud: o.aud ?? [AUDIENCE, `${ISSUER}userinfo`],
    ...(o.clientId === undefined ? { azp: o.azp ?? CLIENT } : { client_id: o.clientId }),
    ...(o.jti !== undefined && { jti: o.jti }),
    ...(o.nbf !== undefined && { nbf: o.nbf }),
    ...(o.details !== null && { authorization_details: o.details ?? details() }),
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(o.iss ?? ISSUER)
    .setSubject(o.sub ?? APPROVER)
    .setIssuedAt(o.iat ?? nowS)
    .setExpirationTime(o.exp ?? nowS + 300)
    .sign(o.rogue ? rogueKey : signKey);
}
const verify = (t: string, opts: { exp?: Partial<ExpectedApproval>; used?: boolean; skip?: VerificationCheck[]; responseDetails?: unknown } = {}) =>
  verifyApprovalToken(t, expected(opts.exp), {
    keys,
    nowMs: NOW,
    answerIdUsed: () => opts.used ?? false,
    ...(opts.responseDetails !== undefined && { responseDetails: opts.responseDetails }),
    ...(opts.skip && { skipChecks: new Set(opts.skip) }),
  });

/** One forgery per check (2-10): the token and the verify options that trip only that check. */
const FORGERIES: [VerificationCheck, () => Promise<Parameters<typeof verify>>][] = [
  ["signature", async () => [await token({ rogue: true })]],
  ["issuer", async () => [await token({ iss: "https://evil.example/" })]],
  ["audience", async () => [await token({ aud: "https://other-api.example/" })]],
  ["client", async () => [await token({ azp: "other-client" })]],
  ["expired", async () => [await token({ iat: nowS - 400, exp: nowS - 61 })]],
  ["approver", async () => [await token({ sub: "auth0|someone-else" })]],
  // A token for another request whose details otherwise match what was sent: only the request check stops it.
  ["request", async () => [await token({ details: details({ requestId: "apq_other" }) }), { exp: { sentDetails: details({ requestId: "apq_other" }) } }]],
  ["details", async () => [await token({ details: details({ amount: "99999" }) })]],
  ["replay", async () => [await token(), { used: true }]],
];

describe("T-CIBA-08 verification (unit)", () => {
  it("a valid Auth0-profile token passes; no jti gives a sha256 answer ID", async () => {
    const t = await token();
    const r = await verify(t);
    expect(r).toEqual({
      ok: true,
      evidence: { issuer: ISSUER, subject: APPROVER, answerId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), issuedAt: new Date(nowS * 1000).toISOString(), detailsSource: "token" },
    });
    expect(JSON.stringify(r)).not.toContain(t);
  });

  it("the RFC 9068 profile (client_id and jti) uses the jti as the answer ID", async () => {
    const r = await verify(await token({ clientId: CLIENT, jti: "jti-123" }));
    expect(r.ok && r.evidence.answerId).toBe("jti-123");
  });

  it("details only in the token response give detailsSource: response", async () => {
    const r = await verify(await token({ details: null }), { responseDetails: details() });
    expect(r.ok && r.evidence.detailsSource).toBe("response");
    expect((await verify(await token({ details: null }))).ok).toBe(false);
  });

  it("aud as a plain string passes", async () => {
    expect((await verify(await token({ aud: AUDIENCE }))).ok).toBe(true);
  });

  it("the 60 s clock tolerance: exp 59 s ago passes, 61 s ago fails; iat 59 s ahead passes, 61 s fails", async () => {
    expect((await verify(await token({ iat: nowS - 400, exp: nowS - 59 }))).ok).toBe(true);
    expect(await verify(await token({ iat: nowS - 400, exp: nowS - 61 }))).toEqual({ ok: false, check: "expired" });
    expect((await verify(await token({ iat: nowS + 59, exp: nowS + 400 }))).ok).toBe(true);
    expect(await verify(await token({ iat: nowS + 61, exp: nowS + 400 }))).toEqual({ ok: false, check: "expired" });
    expect(await verify(await token({ nbf: nowS + 61 }))).toEqual({ ok: false, check: "expired" });
  });

  it.each([["not-a-jwt"], ["a.b.c"]])("malformed: %s", async (t) => {
    expect(await verify(t)).toEqual({ ok: false, check: "malformed" });
  });

  it("malformed: a missing sub", async () => {
    const t = await new SignJWT({ aud: AUDIENCE, azp: CLIENT }).setProtectedHeader({ alg: "RS256", kid: KID }).setIssuer(ISSUER).setIssuedAt(nowS).setExpirationTime(nowS + 300).sign(signKey);
    expect(await verify(t)).toEqual({ ok: false, check: "malformed" });
  });

  it.each(FORGERIES)("%s: its forgery fails with exactly that check", async (check, make) => {
    const [t, opts] = await make();
    expect(await verify(t, opts)).toEqual({ ok: false, check });
  });

  it.each(FORGERIES)("must fail without the %s check: the same forgery verifies", async (check, make) => {
    const [t, opts] = await make();
    const r = await verify(t, { ...opts, skip: [check] });
    expect(r.ok).toBe(true);
  });
});
