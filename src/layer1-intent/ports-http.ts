// L1-2 Port adapters (SPEC.md §8.1): HTTP clients for the L2 and L3 ports. Each adapter holds one
// base URL and one bearer token (INV-13). Any non-2xx response throws and is never a decision.
// There are deliberately no adapters for /v1/reconcile, /v1/approvals or /v1/ledger/verify.
// 016 (SEC-32): the L2 adapter also carries the caller's access token, unchanged, in a second header, when it was
// made for a caller (`forCaller`). That token is not a role token: L2 accepts it only beside this adapter's own,
// verifies it itself and takes the user from it. The L3 adapter never carries it. Rule A14 keeps the header's name
// in this file and in src/layer2-control/caller.ts.
import type {
  AuthorizationDecision,
  AuthorizationGatePort,
  BudgetStatus,
  PaymentIntent,
  SettlementClaim,
  SettlementReport,
  SettlementVerifierPort,
} from "../shared/contracts.js";

/** The header L2 reads the caller's token from (specs/016 contracts/control-api.md). */
const CALLER_HEADER = "x-caller-authorization";

/** The `error` of a JSON error body when it is a short code, for callers that act on it. */
function errorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export class PortHttpError extends Error {
  /** The body's `error` when it is a code such as `caller_token_expired`. */
  readonly code?: string;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    body: string,
  ) {
    super(`${method} ${url} -> ${status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    this.name = "PortHttpError";
    const code = errorCode(body);
    if (code !== undefined) this.code = code;
  }
}

async function call<T>(fetchImpl: typeof fetch, method: string, url: string, token: string, body?: unknown, callerToken?: string): Promise<T> {
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(callerToken !== undefined && callerToken !== "" && { [CALLER_HEADER]: `Bearer ${callerToken}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (res.status < 200 || res.status >= 300) throw new PortHttpError(method, url, res.status, await res.text());
  return (await res.json()) as T;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export class HttpAuthorizationGate implements AuthorizationGatePort {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly controlToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** The caller this gate was made for (`forCaller`). Absent or empty: no caller's token is sent. */
    private readonly callerToken?: string,
  ) {
    this.base = trimSlash(baseUrl);
  }

  /**
   * 016: the same gate for one caller. Every `authorize` and `budget` call of the returned gate carries that
   * caller's access token beside the control token. An empty token gives a gate that carries none.
   */
  forCaller(callerToken: string): AuthorizationGatePort {
    return new HttpAuthorizationGate(this.base, this.controlToken, this.fetchImpl, callerToken);
  }

  authorize(intent: PaymentIntent): Promise<AuthorizationDecision> {
    return call(this.fetchImpl, "POST", `${this.base}/v1/authorize`, this.controlToken, intent, this.callerToken);
  }

  /** 016: for a person's token L2 answers with the user view of the budget (`scope: "user_daily"`). */
  budget(sessionId: string): Promise<BudgetStatus> {
    return call(this.fetchImpl, "GET", `${this.base}/v1/budget/${encodeURIComponent(sessionId)}`, this.controlToken, undefined, this.callerToken);
  }
}

export class HttpSettlementVerifier implements SettlementVerifierPort {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly verifierToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = trimSlash(baseUrl);
  }

  verify(claim: SettlementClaim): Promise<SettlementReport> {
    return call(this.fetchImpl, "POST", `${this.base}/v1/settlements`, this.verifierToken, claim);
  }
}
