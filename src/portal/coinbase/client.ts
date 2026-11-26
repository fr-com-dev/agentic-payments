// 020 the portal's Coinbase client (SPEC.md §8.2 L2-8, §3.3, §4.1 A18; specs/020 contracts/coinbase.md). The only file
// under src/ that names the client secret, Coinbase's hosts and its paths (rule A18). Six calls and no other: the
// authorize address (opened by the browser), the code exchange, the renewal, the revocation, the accounts list and the
// public exchange rates. None of them can move funds, and nothing here ever sends Coinbase anything about the person
// but the grant they gave (FR-021, NFR-002). Coinbase's own text (`error_description`, `message`) is never returned to
// a caller: only typed outcomes.
import { REQUESTED_SCOPES } from "./scopes.js";

/** The two hosts. Constants, never configuration; tests point the client at a stand-in through its constructor. */
export const COINBASE_LOGIN = "https://login.coinbase.com";
export const COINBASE_API = "https://api.coinbase.com";
const AUTHORIZE_PATH = "/oauth2/auth";
const TOKEN_PATH = "/oauth2/token";
const REVOKE_PATH = "/oauth2/revoke";
const ACCOUNTS_PATH = "/v2/accounts";
const RATES_PATH = "/v2/exchange-rates";
/** Pinned (research R7): never the current date. */
export const CB_VERSION = "2026-11-01";
const EXCHANGE_TIMEOUT_MS = 5_000;
const RENEW_TIMEOUT_MS = 5_000;
const REVOKE_TIMEOUT_MS = 3_000;
const CHECK_TIMEOUT_MS = 2_000;
const RATES_TIMEOUT_MS = 3_000;
/** The accounts list: 100 a page, 10 pages, 4 s for all of them (contracts/coinbase.md §5). */
export const ACCOUNTS_PAGE_SIZE = 100;
export const ACCOUNTS_MAX_PAGES = 10;
const ACCOUNTS_TIMEOUT_MS = 4_000;

type Env = Record<string, string | undefined>;

export class CoinbaseConfigError extends Error {
  override name = "CoinbaseConfigError";
}

/** The project's OAuth client. The secret is read here only (rule A18). */
export interface CoinbaseCredentials {
  clientId: string;
  clientSecret: string;
}

/** Reads the client ID and secret. Errors name the variable, never its value. */
export function coinbaseCredentialsFromEnv(env: Env): CoinbaseCredentials {
  const clientId = env.COINBASE_CLIENT_ID ?? "";
  const clientSecret = env.COINBASE_CLIENT_SECRET ?? "";
  if (clientId === "") throw new CoinbaseConfigError("COINBASE_CLIENT_ID is required with CONNECTED_PLATFORMS=coinbase");
  if (!/^[A-Za-z0-9._~-]{1,200}$/.test(clientId)) throw new CoinbaseConfigError("COINBASE_CLIENT_ID must be the project's Coinbase OAuth client ID");
  if (clientSecret === "" || clientSecret === "off") throw new CoinbaseConfigError("COINBASE_CLIENT_SECRET is required with CONNECTED_PLATFORMS=coinbase");
  return { clientId, clientSecret };
}

export interface CoinbaseClientOptions extends CoinbaseCredentials {
  redirectUri: string;
  /** Test-only: the stand-in's addresses. The entry point never sets them. */
  loginBase?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/**
 * A token endpoint answer, reduced to what the portal uses. `refused`: Coinbase says this code or grant is no good
 * (`invalid_grant`), the only answer that may end a person's connection. `client_refused`: Coinbase refused the portal
 * itself (a wrong or rotated client secret, `invalid_client`, any other OAuth error): the operator's problem, which
 * must never erase anybody's grant. `unavailable`: no usable answer.
 */
export type TokenOutcome =
  | { ok: true; accessToken: string; refreshToken?: string; expiresInSec: number; scope?: string }
  | { ok: false; kind: "refused" | "client_refused" | "unavailable" };

/** One account as Coinbase lists it, reduced to the fields the portal reads (contracts/coinbase.md §5). */
export interface RawAccount {
  type: unknown;
  code: unknown;
  name: unknown;
  amount: unknown;
  balanceCurrency: unknown;
}

export type AccountsOutcome =
  | { ok: true; accounts: RawAccount[]; truncated: boolean }
  | { ok: false; kind: "expired" | "revoked" | "rate_limited" | "unavailable" };

export type RatesOutcome = { ok: true; rates: Map<string, string> } | { ok: false };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export class CoinbaseClient {
  private readonly login: string;
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: CoinbaseClientOptions) {
    this.login = (o.loginBase ?? COINBASE_LOGIN).replace(/\/+$/, "");
    this.api = (o.apiBase ?? COINBASE_API).replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** §1: the address the browser opens. PKCE S256 unless `codeChallenge` is absent (only the `skipPkce` proof). */
  authorizeUrl(o: { state: string; codeChallenge?: string }): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      scope: REQUESTED_SCOPES.join(" "),
      state: o.state,
      ...(o.codeChallenge !== undefined && { code_challenge: o.codeChallenge, code_challenge_method: "S256" }),
    });
    return `${this.login}${AUTHORIZE_PATH}?${q.toString()}`;
  }

  /** §2: the code exchange. */
  exchange(code: string, codeVerifier: string | undefined): Promise<TokenOutcome> {
    return this.token(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: this.o.redirectUri,
        ...(codeVerifier !== undefined && { code_verifier: codeVerifier }),
      },
      EXCHANGE_TIMEOUT_MS,
    );
  }

  /** §3: a renewal. The caller seals the new refresh token before using the access token (research R5). */
  renew(refreshToken: string): Promise<TokenOutcome> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken }, RENEW_TIMEOUT_MS);
  }

  private async token(fields: Record<string, string>, timeoutMs: number): Promise<TokenOutcome> {
    const body = new URLSearchParams({ ...fields, client_id: this.o.clientId, client_secret: this.o.clientSecret });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.login}${TOKEN_PATH}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      });
    } catch {
      return { ok: false, kind: "unavailable" };
    }
    const json = await res.json().catch(() => undefined);
    if (res.status === 400 || res.status === 401) {
      const error = isObject(json) ? json.error : undefined;
      return { ok: false, kind: error === "invalid_grant" ? "refused" : "client_refused" };
    }
    if (res.status !== 200 || !isObject(json) || typeof json.access_token !== "string" || json.access_token === "") return { ok: false, kind: "unavailable" };
    const expires = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    return {
      ok: true,
      accessToken: json.access_token,
      ...(typeof json.refresh_token === "string" && json.refresh_token !== "" && { refreshToken: json.refresh_token }),
      expiresInSec: expires,
      ...(typeof json.scope === "string" && { scope: json.scope }),
    };
  }

  /** §4: revokes the access token (and with it its refresh token). Coinbase answers 200 whatever happened. */
  async revoke(accessToken: string): Promise<void> {
    const body = new URLSearchParams({ token: accessToken, client_id: this.o.clientId, client_secret: this.o.clientSecret });
    try {
      await this.fetchImpl(`${this.login}${REVOKE_PATH}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${accessToken}` },
        body,
      });
    } catch {
      // Nothing to learn from the answer either way: the check below decides (research R15).
    }
  }

  /** §5 as the revocation check: true only when Coinbase answers 401 to the revoked token. */
  async revokedCheck(accessToken: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.api}${ACCOUNTS_PATH}?limit=1`, {
        redirect: "error",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        headers: { authorization: `Bearer ${accessToken}`, "CB-VERSION": CB_VERSION },
      });
      await res.body?.cancel();
      return res.status === 401;
    } catch {
      return false;
    }
  }

  /** §5: every page, at most 10, never `fetch_all`, never a `next_uri` to another host. */
  async listAccounts(accessToken: string): Promise<AccountsOutcome> {
    const signal = AbortSignal.timeout(ACCOUNTS_TIMEOUT_MS);
    const accounts: RawAccount[] = [];
    let path: string | undefined = `${ACCOUNTS_PATH}?limit=${ACCOUNTS_PAGE_SIZE}`;
    for (let page = 0; page < ACCOUNTS_MAX_PAGES && path !== undefined; page++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.api}${path}`, {
          redirect: "error",
          signal,
          headers: { authorization: `Bearer ${accessToken}`, "CB-VERSION": CB_VERSION, accept: "application/json" },
        });
      } catch {
        return { ok: false, kind: "unavailable" };
      }
      const json = await res.json().catch(() => undefined);
      if (res.status === 401) {
        const id = isObject(json) && Array.isArray(json.errors) && isObject(json.errors[0]) ? json.errors[0].id : undefined;
        return { ok: false, kind: id === "expired_token" ? "expired" : "revoked" };
      }
      if (res.status === 403) return { ok: false, kind: "revoked" };
      if (res.status === 429) return { ok: false, kind: "rate_limited" };
      if (res.status !== 200 || !isObject(json) || !Array.isArray(json.data)) return { ok: false, kind: "unavailable" };
      for (const a of json.data) {
        if (!isObject(a)) continue;
        const currency = isObject(a.currency) ? a.currency : {};
        const balance = isObject(a.balance) ? a.balance : {};
        accounts.push({ type: a.type, code: currency.code, name: currency.name, amount: balance.amount, balanceCurrency: balance.currency });
      }
      path = nextPath(json.pagination);
    }
    return { ok: true, accounts, truncated: path !== undefined };
  }

  /** §6: Coinbase's public USD rates, no Authorization header. */
  async usdRates(): Promise<RatesOutcome> {
    try {
      const res = await this.fetchImpl(`${this.api}${RATES_PATH}?currency=USD`, {
        redirect: "error",
        signal: AbortSignal.timeout(RATES_TIMEOUT_MS),
        headers: { "CB-VERSION": CB_VERSION, accept: "application/json" },
      });
      const json = await res.json().catch(() => undefined);
      if (res.status !== 200 || !isObject(json) || !isObject(json.data) || !isObject(json.data.rates)) return { ok: false };
      const rates = new Map<string, string>();
      for (const [code, rate] of Object.entries(json.data.rates)) if (typeof rate === "string") rates.set(code, rate);
      return { ok: true, rates };
    } catch {
      return { ok: false };
    }
  }
}

/** The next page's path and query, only when it is a path on the same host (never a full address). */
function nextPath(pagination: unknown): string | undefined {
  if (!isObject(pagination)) return undefined;
  const next = pagination.next_uri;
  if (typeof next !== "string" || next === "") return undefined;
  if (!next.startsWith(`${ACCOUNTS_PATH}?`) || next.includes("//") || /fetch_all/i.test(next)) return undefined;
  return next;
}
