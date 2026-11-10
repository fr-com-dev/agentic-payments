// L1-2 Port adapters (SPEC.md §8.1): HTTP clients for the L2 and L3 ports. Each adapter holds one
// base URL and one bearer token (INV-13). Any non-2xx response throws and is never a decision.
// There are deliberately no adapters for /v1/reconcile, /v1/approvals or /v1/ledger/verify.
import type {
  AuthorizationDecision,
  AuthorizationGatePort,
  BudgetStatus,
  PaymentIntent,
  SettlementClaim,
  SettlementReport,
  SettlementVerifierPort,
} from "../shared/contracts.js";

export class PortHttpError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    body: string,
  ) {
    super(`${method} ${url} -> ${status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    this.name = "PortHttpError";
  }
}

async function call<T>(fetchImpl: typeof fetch, method: string, url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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
  ) {
    this.base = trimSlash(baseUrl);
  }

  authorize(intent: PaymentIntent): Promise<AuthorizationDecision> {
    return call(this.fetchImpl, "POST", `${this.base}/v1/authorize`, this.controlToken, intent);
  }

  /** 013: with `userId`, L2 answers with the user view of the budget (`scope: "user_daily"`). */
  budget(sessionId: string, userId?: string): Promise<BudgetStatus> {
    const query = userId === undefined ? "" : `?userId=${encodeURIComponent(userId)}`;
    return call(this.fetchImpl, "GET", `${this.base}/v1/budget/${encodeURIComponent(sessionId)}${query}`, this.controlToken);
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
