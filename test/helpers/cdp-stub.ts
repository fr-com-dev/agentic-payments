// Feature 009 offline CDP facilitator stub (contracts/cdp-facilitator-api.md "Offline stub").
// Serves /platform/v2/x402/{supported,verify,settle} on loopback, verifies every request's CDP JWT
// with node:crypto, and delegates verify/settle to a real local facilitator (CP-2) so payments settle
// on ganache. Failure modes are switchable per test; request counters support the no-fallback check.
import { createPublicKey, generateKeyPairSync, randomUUID, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import express from "express";

export type StubMode = "ok" | "401" | "429" | "500" | "hang" | "unsupported" | "decline" | "pending";

export interface TestKey {
  apiKeyId: string;
  /** base64(seed32 ‖ pub32): the CDP Ed25519 secret format. */
  apiKeySecret: string;
  publicKey: KeyObject;
}

/** A fresh Ed25519 key in CDP's secret format. */
export function testEd25519Key(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
  return { apiKeyId: `organizations/test/apiKeys/${randomUUID()}`, apiKeySecret: secret, publicKey };
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

/** Splits a JWT without checking it. */
export function decodeJwt(token: string): DecodedJwt {
  const [h, p] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Record<string, unknown>,
  };
}

/** Verifies an EdDSA or ES256 JWT signature with node:crypto. */
export function verifyJwtSignature(token: string, publicKey: KeyObject): boolean {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  const { header } = decodeJwt(token);
  if (header.alg === "EdDSA") return cryptoVerify(null, data, publicKey, sig);
  if (header.alg === "ES256") return cryptoVerify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig);
  return false;
}

export interface CdpStubOptions {
  /** Public key of the API key the stub accepts. Required when `requireAuth` is true. */
  publicKey?: KeyObject;
  apiKeyId?: string;
  /** Base URL of the local CP-2 facilitator that really verifies and settles. */
  innerUrl: string;
  mode?: StubMode;
  requireAuth?: boolean;
}

export interface CdpStub {
  url: string;
  /** `${url}/platform/v2/x402`, the base URL a CDP client is pointed at. */
  baseUrl: string;
  host: string;
  setMode(mode: StubMode): void;
  /** `requests` counts every request, including those a failure mode answers before routing. */
  counts: { requests: number; supported: number; verify: number; settle: number; rejected: number; authHeaders: number };
  close(): Promise<void>;
}

const BASE_PATH = "/platform/v2/x402";

export async function startCdpStub(opts: CdpStubOptions): Promise<CdpStub> {
  const requireAuth = opts.requireAuth ?? true;
  if (requireAuth && (!opts.publicKey || !opts.apiKeyId)) throw new Error("cdp stub: publicKey and apiKeyId are required");
  let mode: StubMode = opts.mode ?? "ok";
  const counts = { requests: 0, supported: 0, verify: 0, settle: 0, rejected: 0, authHeaders: 0 };
  const pendingByNonce = new Map<string, Record<string, unknown>>();
  let host = "";

  const authorized = (req: express.Request): boolean => {
    const header = req.get("authorization");
    if (header) counts.authHeaders++;
    if (!requireAuth) return true;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !verifyJwtSignature(token, opts.publicKey!)) return false;
    const { header: h, claims } = decodeJwt(token);
    const now = Math.floor(Date.now() / 1000);
    const nbf = Number(claims.nbf);
    const exp = Number(claims.exp);
    const uris = claims.uris as unknown;
    return (
      h.alg === "EdDSA" &&
      h.kid === opts.apiKeyId &&
      h.typ === "JWT" &&
      claims.iss === "cdp" &&
      claims.sub === opts.apiKeyId &&
      nbf <= now + 5 &&
      now <= exp &&
      exp - nbf <= 120 &&
      Array.isArray(uris) &&
      uris[0] === `${req.method} ${host}${req.baseUrl}${req.path}`
    );
  };

  const forward = async (path: "verify" | "settle", body: unknown) => {
    const res = await fetch(`${opts.innerUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(BASE_PATH, (req, res, next) => {
    counts.requests++;
    if (!authorized(req)) {
      counts.rejected++;
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (mode === "hang") return; // never answers; the client's timeout fires
    if (mode === "401") return void res.status(401).json({ error: "unauthorized" });
    if (mode === "429") return void res.status(429).set("Retry-After", "0").json({ error: "rate limited" });
    if (mode === "500") return void res.status(500).json({ error: "internal error" });
    next();
  });
  app.get(`${BASE_PATH}/supported`, async (_req, res) => {
    counts.supported++;
    if (mode === "unsupported") {
      res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
      return;
    }
    const inner = await fetch(`${opts.innerUrl}/supported`);
    res.status(inner.status).json(await inner.json());
  });
  app.post(`${BASE_PATH}/verify`, async (req, res) => {
    counts.verify++;
    if (mode === "decline") {
      const payer = (req.body as { paymentPayload?: { payload?: { authorization?: { from?: string } } } }).paymentPayload?.payload
        ?.authorization?.from;
      res.json({ isValid: false, invalidReason: "compliance_declined", payer });
      return;
    }
    const { status, json } = await forward("verify", req.body);
    res.status(status).json(json);
  });
  app.post(`${BASE_PATH}/settle`, async (req, res) => {
    counts.settle++;
    if (mode !== "pending") {
      const { status, json } = await forward("settle", req.body);
      res.status(status).json(json);
      return;
    }
    const nonce = String(
      (req.body as { paymentPayload?: { payload?: { authorization?: { nonce?: string } } } }).paymentPayload?.payload
        ?.authorization?.nonce ?? "",
    );
    let body = pendingByNonce.get(nonce);
    if (!body) {
      const { json } = await forward("settle", req.body);
      body = {
        success: false,
        errorReason: "settlement_pending",
        transaction: json.transaction,
        network: json.network,
        payer: json.payer,
      };
      pendingByNonce.set(nonce, body);
    }
    res.json(body);
  });

  const sockets = new Set<Socket>();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  const url = `http://${host}`;

  return {
    url,
    baseUrl: `${url}${BASE_PATH}`,
    host,
    setMode: (m) => {
      mode = m;
    },
    counts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Public key for an EC PEM private key, for ES256 checks in tests. */
export const publicKeyOf = (privatePem: string): KeyObject => createPublicKey(privatePem);
