// 012 stand-in Auth0 for CIBA poll mode (specs/012 research R15, contracts/auth0-ciba.md). Serves
// POST /bc-authorize, POST /oauth/token and GET /.well-known/jwks.json on 127.0.0.1 over http, verifies each
// call's client authentication, issues real RS256 access tokens from its own JWKS, and answers polls from a
// per-request script. Forgeries cover every verification check. Every request is recorded, including unknown
// paths, so tests can assert that L2 called nothing else.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWK } from "jose";

/** Put in every error_description, so known-value scans can prove Auth0's text never leaks (NFR-003). */
export const PLANTED_ERROR_TEXT = "planted-auth0-error-text-5c1d9e";

export interface TestRsaKeyPair {
  privatePem: string;
  publicPem: string;
}

export function testRsaKeyPair(bits = 2048): TestRsaKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export type StartMode =
  | "ok"
  | "503"
  | "429"
  | "hang"
  | "unreachable"
  | "not_json"
  | { permanent: string }
  | { expiresIn?: number; interval?: number };

export type Forgery =
  | "issuer"
  | "audience"
  | "client"
  | "signature"
  | "expired"
  | "subject"
  | "request"
  | "replay"
  | { details: (d: unknown[]) => unknown[] };

export type Answer =
  | "pending"
  | "deny"
  | "expired_token"
  | "503"
  | "invalid_grant"
  | { slow_down: number | null }
  | { approve: { detailsIn?: "token" | "response" | "both"; profile?: "auth0" | "rfc9068"; forge?: Forgery } };

export interface StubRequest {
  path: string;
  form: Record<string, string>;
}

export interface CibaStubOptions {
  approver: string;
  clientId: string;
  audience: string;
  /** SPKI PEM of the client's private_key_jwt key. */
  clientPublicKeyPem?: string;
  /** Accepted `client_secret` for client_secret_post. */
  clientSecret?: string;
  /** Clock for token iat/exp, in ms (share it with L2's `now`). Default Date.now. */
  now?: () => number;
}

interface PendingRequest {
  authReqId: string;
  form: Record<string, string>;
  details: unknown[];
  polls: number;
  exchanged: boolean;
}

export interface CibaStub {
  issuer: string;
  requests: StubRequest[];
  authReqIds: string[];
  tokensIssued: string[];
  /** Claims of every verified client assertion. */
  assertions: Record<string, unknown>[];
  /** performance.now() of every token poll, per auth_req_id. */
  pollTimes: Map<string, number[]>;
  jwksFetches: number;
  setStart(...modes: StartMode[]): void;
  /** Each request walks this list one answer per poll; the last answer repeats. */
  setAnswers(...answers: Answer[]): void;
  /** Per-request answers, by the request's 0-based start order. Overrides setAnswers for that request. */
  setAnswersFor(index: number, ...answers: Answer[]): void;
  setJwksDelayMs(ms: number): void;
  /** Bodies of bc-authorize calls, in order. */
  startForms(): Record<string, string>[];
  close(): Promise<void>;
}

const ERROR_STATUS: Record<string, number> = { invalid_client: 401, unauthorized_client: 403 };

export async function startCibaStub(opts: CibaStubOptions): Promise<CibaStub> {
  const now = opts.now ?? Date.now;
  const kid = `kid-${randomUUID().slice(0, 8)}`;
  const signing = testRsaKeyPair();
  const rogue = testRsaKeyPair();
  const signKey = await importPKCS8(signing.privatePem, "RS256");
  const rogueKey = await importPKCS8(rogue.privatePem, "RS256");
  const publicJwk: JWK = { ...(await exportJWK(await importSPKI(signing.publicPem, "RS256", { extractable: true }))), kid, alg: "RS256", use: "sig" };
  const clientKey = opts.clientPublicKeyPem ? await importSPKI(opts.clientPublicKeyPem, "RS256") : undefined;

  const requests: StubRequest[] = [];
  const authReqIds: string[] = [];
  const tokensIssued: string[] = [];
  const assertions: Record<string, unknown>[] = [];
  const pollTimes = new Map<string, number[]>();
  const pending = new Map<string, PendingRequest>();
  const sockets = new Set<Socket>();
  let startModes: StartMode[] = ["ok"];
  let startCalls = 0;
  let answers: Answer[] = ["pending"];
  const answersFor = new Map<number, Answer[]>();
  let jwksDelayMs = 0;
  let jwksFetches = 0;
  let lastApprovalToken: string | undefined;
  let issuer = "";

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const oauthError = (res: ServerResponse, error: string, extra: Record<string, unknown> = {}) =>
    send(res, ERROR_STATUS[error] ?? 400, { error, error_description: PLANTED_ERROR_TEXT, ...extra });

  async function clientAuthenticated(form: Record<string, string>): Promise<boolean> {
    if (form.client_id !== opts.clientId) return false;
    if (form.client_assertion !== undefined) {
      if (!clientKey || form.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return false;
      try {
        const { payload } = await jwtVerify(form.client_assertion, clientKey, { algorithms: ["RS256"], issuer: opts.clientId, subject: opts.clientId, audience: issuer });
        if (typeof payload.exp !== "number" || typeof payload.iat !== "number" || payload.exp - payload.iat > 300 || typeof payload.jti !== "string") return false;
        assertions.push(payload as Record<string, unknown>);
        return true;
      } catch {
        return false;
      }
    }
    return opts.clientSecret !== undefined && form.client_secret === opts.clientSecret;
  }

  async function issueToken(req: PendingRequest, a: Extract<Answer, { approve: unknown }>["approve"]): Promise<Record<string, unknown>> {
    const forge = a.forge;
    if (forge === "replay" && lastApprovalToken !== undefined) {
      return { access_token: lastApprovalToken, token_type: "Bearer", expires_in: 300, scope: "openid", authorization_details: req.details };
    }
    let details: unknown[] = structuredClone(req.details);
    if (typeof forge === "object") details = forge.details(details);
    if (forge === "request") {
      const d = details[0] as { properties?: { request_id?: { value?: string } } };
      if (d?.properties?.request_id) d.properties.request_id.value = "apq_forged-request";
    }
    const detailsIn = a.detailsIn ?? "both";
    const profile = a.profile ?? "auth0";
    const t = Math.floor(now() / 1000);
    const claims: Record<string, unknown> = {
      sub: forge === "subject" ? "auth0|someone-else" : opts.approver,
      aud: forge === "audience" ? ["https://other-api.example/"] : [opts.audience, `${issuer}userinfo`],
      scope: "openid",
      ...(profile === "auth0" ? { azp: forge === "client" ? "other-client" : opts.clientId } : { client_id: forge === "client" ? "other-client" : opts.clientId, jti: randomUUID() }),
      ...((detailsIn === "token" || detailsIn === "both") && { authorization_details: details }),
    };
    const iat = forge === "expired" ? t - 420 : t;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid, typ: profile === "rfc9068" ? "at+jwt" : "JWT" })
      .setIssuer(forge === "issuer" ? "https://evil-tenant.example/" : issuer)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .sign(forge === "signature" ? rogueKey : signKey);
    tokensIssued.push(token);
    if (forge === undefined) lastApprovalToken = token;
    const idToken = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: opts.approver, n: randomUUID() })).toString("base64url")}.sig`;
    tokensIssued.push(idToken);
    return {
      access_token: token,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 300,
      scope: "openid",
      ...((detailsIn === "response" || detailsIn === "both") && { authorization_details: details }),
    };
  }

  async function onStart(req: IncomingMessage, res: ServerResponse, form: Record<string, string>) {
    const mode = startModes[Math.min(startCalls, startModes.length - 1)]!;
    startCalls++;
    if (mode === "hang") return; // never answers; close() destroys the socket
    if (mode === "unreachable") {
      req.socket.destroy();
      return;
    }
    if (mode === "503" || mode === "429") {
      res.writeHead(Number(mode), { "content-type": "text/plain" });
      res.end(PLANTED_ERROR_TEXT);
      return;
    }
    if (mode === "not_json") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html>${PLANTED_ERROR_TEXT}</html>`);
      return;
    }
    if (!(await clientAuthenticated(form))) return oauthError(res, "invalid_client");
    if (typeof mode === "object" && "permanent" in mode) return oauthError(res, mode.permanent);
    const authReqId = `areq-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32)}`;
    let details: unknown[] = [];
    try {
      details = JSON.parse(form.authorization_details ?? "[]") as unknown[];
    } catch {
      return oauthError(res, "invalid_authorization_details");
    }
    pending.set(authReqId, { authReqId, form, details, polls: 0, exchanged: false });
    authReqIds.push(authReqId);
    const o = typeof mode === "object" ? mode : {};
    send(res, 200, { auth_req_id: authReqId, expires_in: o.expiresIn ?? 300, interval: o.interval ?? 1 });
  }

  async function onToken(res: ServerResponse, form: Record<string, string>) {
    if (!(await clientAuthenticated(form))) return oauthError(res, "invalid_client");
    if (form.grant_type !== "urn:openid:params:grant-type:ciba") return oauthError(res, "unsupported_grant_type");
    const r = pending.get(form.auth_req_id ?? "");
    if (!r || r.exchanged) return oauthError(res, "invalid_grant");
    const times = pollTimes.get(r.authReqId) ?? [];
    times.push(performance.now());
    pollTimes.set(r.authReqId, times);
    const index = authReqIds.indexOf(r.authReqId);
    const script = answersFor.get(index) ?? answers;
    const a = script[Math.min(r.polls, script.length - 1)]!;
    r.polls++;
    if (a === "pending") return oauthError(res, "authorization_pending");
    if (a === "deny") return oauthError(res, "access_denied");
    if (a === "expired_token") return oauthError(res, "expired_token");
    if (a === "invalid_grant") return oauthError(res, "invalid_grant");
    if (a === "503") {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end(PLANTED_ERROR_TEXT);
      return;
    }
    if ("slow_down" in a) return oauthError(res, "slow_down", a.slow_down === null ? {} : { interval: a.slow_down });
    r.exchanged = true;
    send(res, 200, await issueToken(r, a.approve));
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0]!;
      const raw = Buffer.concat(chunks).toString("utf8");
      const form = Object.fromEntries(new URLSearchParams(raw));
      requests.push({ path, form });
      void (async () => {
        if (req.method === "POST" && path === "/bc-authorize") return onStart(req, res, form);
        if (req.method === "POST" && path === "/oauth/token") return onToken(res, form);
        if (req.method === "GET" && path === "/.well-known/jwks.json") {
          jwksFetches++;
          if (jwksDelayMs > 0) await new Promise((r) => setTimeout(r, jwksDelayMs));
          return send(res, 200, { keys: [publicJwk] });
        }
        send(res, 404, { error: "not_found" });
      })().catch(() => {
        if (!res.headersSent) send(res, 500, { error: "stub_failure" });
      });
    });
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  return {
    issuer,
    requests,
    authReqIds,
    tokensIssued,
    assertions,
    pollTimes,
    get jwksFetches() {
      return jwksFetches;
    },
    setStart: (...modes) => {
      startModes = modes;
      startCalls = 0;
    },
    setAnswers: (...a) => {
      answers = a;
    },
    setAnswersFor: (index, ...a) => {
      answersFor.set(index, a);
    },
    setJwksDelayMs: (ms) => {
      jwksDelayMs = ms;
    },
    startForms: () => requests.filter((r) => r.path === "/bc-authorize").map((r) => r.form),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
