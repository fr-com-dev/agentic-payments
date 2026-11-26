// 020 stand-in Coinbase (specs/020 contracts/coinbase.md, research R13): the six calls the portal makes, with answers
// shaped like Coinbase's documentation, like ciba-stub.ts and card-vault-stub.ts. Coinbase has no sandbox for OAuth,
// so every test uses this. It enforces what Coinbase enforces (the client secret, PKCE S256 when the authorize call
// carried a challenge, single-use refresh tokens whose reuse ends the link, revoke answering 200 whatever happens)
// and records every request so tests can assert exactly what was called. Its known values exist so a scan can look
// for them anywhere they must never be. A test helper only: never a deployed process.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const STUB_CLIENT_ID = "stub-client-id";
export const STUB_CLIENT_SECRET = "STUB-CLIENT-SECRET-must-never-be-relayed";
/** Coinbase's own free text, on every error: it must never reach a log, an answer or the ledger. */
export const COINBASE_MESSAGE = "COINBASE-FREE-TEXT-must-never-be-relayed";

export interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  form: Record<string, string>;
}

export interface StubAccount {
  type?: string;
  code: string;
  name?: string;
  amount: string;
  /** Defaults to `code`. */
  balanceCurrency?: string;
}

export type Fault = "timeout" | "error500" | "rate_limited" | "revoked" | "invalid_scope" | "expired_once";

interface Grant {
  grantId: string;
  scope: string;
  refreshToken?: string;
  /** Refresh tokens this grant used before: sending one ends the link. */
  usedRefresh: Set<string>;
  accessTokens: Set<string>;
  alive: boolean;
}

export interface CoinbaseStub {
  baseUrl: string;
  requests: StubRequest[];
  /** What the authorize page would do: issue a code for these query values (the person agreed). */
  authorize(authorizeUrl: string, o?: { scope?: string; refused?: boolean }): { code?: string; state: string; error?: string };
  /** Scripts the scope the next code exchange grants (default: what was asked). */
  grantScope(scope: string | undefined): void;
  /** Scripts the next renewal's `scope` answer (`all`, a list, or undefined for none). */
  renewalScope(scope: string | undefined): void;
  /** The next exchange answers without a refresh token. */
  withoutRefreshToken(on: boolean): void;
  /** The accounts every live grant reads. */
  setAccounts(accounts: StubAccount[]): void;
  setRates(rates: Record<string, string>): void;
  /** Faults on the accounts list (and `timeout`/`error500` on the token and rates calls when `everywhere`). */
  setFault(fault: Fault | undefined, o?: { everywhere?: boolean }): void;
  /** Revoke answers 200 and revokes nothing. */
  revokeDoesNothing(on: boolean): void;
  /** Every grant still alive. */
  liveGrants(): number;
  /** Ends every grant, as the person removing the access at Coinbase. */
  revokeAllOutside(): void;
  /** Values that must never appear outside the portal's sealed file (the known-value scan). */
  knownValues(): string[];
  close(): Promise<void>;
}

const token = (prefix: string) => `${prefix}-${randomBytes(18).toString("base64url")}`;

export async function startCoinbaseStub(o: { pageSize?: number } = {}): Promise<CoinbaseStub> {
  const requests: StubRequest[] = [];
  const codes = new Map<string, { scope: string; challenge?: string; redirectUri: string }>();
  const grants: Grant[] = [];
  let accounts: StubAccount[] = [];
  let rates: Record<string, string> = { USD: "1" };
  let fault: Fault | undefined;
  let faultEverywhere = false;
  let nextScope: string | undefined | null = null;
  let nextRenewalScope: string | undefined | null = null;
  let noRefresh = false;
  let revokeNoop = false;
  const issued: string[] = [];
  const pageSize = o.pageSize ?? 100;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const apiError = (res: ServerResponse, status: number, id: string) => json(res, status, { errors: [{ id, message: COINBASE_MESSAGE }] });
  const oauthError = (res: ServerResponse, status: number, error: string) => json(res, status, { error, error_description: COINBASE_MESSAGE });
  const grantOfAccess = (access: string | undefined) => grants.find((g) => access !== undefined && g.accessTokens.has(access));

  const issueAccess = (g: Grant) => {
    const a = token("stub-access");
    g.accessTokens.add(a);
    issued.push(a);
    return a;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const form = Object.fromEntries(new URLSearchParams(raw));
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    requests.push({ method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), headers, form });
    const slow = fault === "timeout" && (faultEverywhere || url.pathname.startsWith("/v2/accounts"));
    if (slow) {
      await new Promise((r) => setTimeout(r, 6_000));
      if (!res.writableEnded) json(res, 504, {});
      return;
    }
    if (fault === "error500" && (faultEverywhere || url.pathname.startsWith("/v2/accounts"))) return json(res, 500, { errors: [{ id: "internal_server_error", message: COINBASE_MESSAGE }] });

    if (req.method === "POST" && url.pathname === "/oauth2/token") {
      if (form.client_id !== STUB_CLIENT_ID || form.client_secret !== STUB_CLIENT_SECRET) return oauthError(res, 401, "invalid_client");
      if (form.grant_type === "authorization_code") {
        const c = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        if (!c || c.redirectUri !== form.redirect_uri) return oauthError(res, 400, "invalid_grant");
        if (c.challenge !== undefined) {
          const v = form.code_verifier ?? "";
          if (createHash("sha256").update(v).digest("base64url") !== c.challenge) return oauthError(res, 400, "invalid_grant");
        }
        const scope = nextScope === null ? c.scope : nextScope;
        nextScope = null;
        const g: Grant = { grantId: token("grant"), scope: scope ?? "", usedRefresh: new Set(), accessTokens: new Set(), alive: true };
        if (!noRefresh) {
          g.refreshToken = token("stub-refresh");
          issued.push(g.refreshToken);
        }
        grants.push(g);
        const access = issueAccess(g);
        return json(res, 200, { access_token: access, token_type: "bearer", expires_in: 3600, ...(g.refreshToken && { refresh_token: g.refreshToken }), ...(scope !== undefined && { scope }) });
      }
      if (form.grant_type === "refresh_token") {
        const rt = form.refresh_token ?? "";
        const reused = grants.find((g) => g.usedRefresh.has(rt));
        if (reused) {
          // Sending an invalidated refresh token ends the link (research R5).
          reused.alive = false;
          return oauthError(res, 400, "invalid_grant");
        }
        const g = grants.find((x) => x.refreshToken === rt);
        if (!g || !g.alive) return oauthError(res, 400, "invalid_grant");
        g.usedRefresh.add(rt);
        g.refreshToken = token("stub-refresh");
        issued.push(g.refreshToken);
        const access = issueAccess(g);
        const scope = nextRenewalScope === null ? g.scope : nextRenewalScope;
        nextRenewalScope = null;
        return json(res, 200, { access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: g.refreshToken, ...(scope !== undefined && { scope }) });
      }
      return oauthError(res, 400, "unsupported_grant_type");
    }

    if (req.method === "POST" && url.pathname === "/oauth2/revoke") {
      // 200 whatever happened, as Coinbase (research R15).
      if (!revokeNoop && form.client_id === STUB_CLIENT_ID && form.client_secret === STUB_CLIENT_SECRET) {
        const g = grantOfAccess(form.token);
        if (g) g.alive = false;
      }
      return json(res, 200, {});
    }

    if (req.method === "GET" && url.pathname === "/v2/exchange-rates") {
      if (url.searchParams.get("currency") !== "USD") return apiError(res, 400, "invalid_request");
      return json(res, 200, { data: { currency: "USD", rates } });
    }

    if (req.method === "GET" && url.pathname === "/v2/accounts") {
      const access = (headers.authorization ?? "").replace(/^Bearer /, "");
      const g = grantOfAccess(access);
      if (fault === "expired_once" && g) {
        fault = undefined;
        g.accessTokens.delete(access);
        return apiError(res, 401, "expired_token");
      }
      if (!g || !g.alive) return apiError(res, 401, "revoked_token");
      if (fault === "revoked") return apiError(res, 401, "revoked_token");
      if (fault === "invalid_scope") return apiError(res, 403, "invalid_scope");
      if (fault === "rate_limited") return apiError(res, 429, "rate_limit_exceeded");
      if (url.searchParams.has("fetch_all")) return apiError(res, 400, "invalid_request");
      const limit = Number(url.searchParams.get("limit") ?? "25");
      const after = url.searchParams.get("starting_after");
      const start = after === null ? 0 : Number(after);
      const size = Math.min(limit, pageSize);
      const page = accounts.slice(start, start + size);
      const end = start + page.length;
      return json(res, 200, {
        pagination: { limit: size, next_uri: end < accounts.length ? `/v2/accounts?limit=${limit}&starting_after=${end}` : "" },
        data: page.map((a, i) => ({
          id: `acct-${start + i}`,
          name: `My ${a.code} wallet`,
          primary: false,
          type: a.type ?? "wallet",
          currency: { code: a.code, name: a.name ?? a.code, exponent: 8, type: "crypto" },
          balance: { amount: a.amount, currency: a.balanceCurrency ?? a.code },
        })),
      });
    }
    return apiError(res, 404, "not_found");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.writableEnded) json(res, 500, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    requests,
    authorize(authorizeUrl, ao = {}) {
      const u = new URL(authorizeUrl);
      const state = u.searchParams.get("state") ?? "";
      if (ao.refused) return { state, error: "access_denied" };
      const code = token("stub-code");
      issued.push(code);
      codes.set(code, {
        scope: ao.scope ?? (u.searchParams.get("scope") ?? ""),
        ...(u.searchParams.get("code_challenge_method") === "S256" && { challenge: u.searchParams.get("code_challenge") ?? "" }),
        redirectUri: u.searchParams.get("redirect_uri") ?? "",
      });
      return { code, state };
    },
    grantScope: (s) => {
      nextScope = s;
    },
    renewalScope: (s) => {
      nextRenewalScope = s;
    },
    withoutRefreshToken: (on) => {
      noRefresh = on;
    },
    setAccounts: (a) => {
      accounts = a;
    },
    setRates: (r) => {
      rates = r;
    },
    setFault: (f, fo = {}) => {
      fault = f;
      faultEverywhere = fo.everywhere === true;
    },
    revokeDoesNothing: (on) => {
      revokeNoop = on;
    },
    liveGrants: () => grants.filter((g) => g.alive).length,
    revokeAllOutside: () => {
      for (const g of grants) g.alive = false;
    },
    knownValues: () => [STUB_CLIENT_SECRET, COINBASE_MESSAGE, ...issued, ...grants.map((g) => g.grantId)],
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
