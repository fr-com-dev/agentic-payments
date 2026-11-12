// 013 the portal's client of L2 (SPEC.md §8.2 L2-5; specs/013 contracts/control-api.md "Portal routes").
// The only file in src/portal/ that knows L2's paths, and the only user of the portal's role token. That token
// reaches the user-account routes and nothing else: there is deliberately no method here for authorize, budget,
// approvals, rejections, reconcile or ledger verification (INV-13, FR-049).
import type { PlatformView, PolicyValues, PolicyView, UserView } from "../shared/contracts.js";
import { ControlError, ControlUnavailable } from "./control-errors.js";

// 014: the two error classes live in ./control-errors.ts, shared with the administration client.
export { ControlError, ControlUnavailable };

const TIMEOUT_MS = 5_000;

export interface ControlPort {
  platform(): Promise<PlatformView>;
  user(userId: string): Promise<UserView>;
  register(userId: string): Promise<UserView>;
  createWallet(userId: string): Promise<UserView>;
  createPolicy(userId: string, values: PolicyValues, identityConfirmedAtMs: number): Promise<PolicyView>;
  policy(userId: string, policyId: string): Promise<PolicyView>;
  changePolicy(userId: string, policyId: string, values: PolicyValues, expectedVersion: number, identityConfirmedAtMs: number): Promise<PolicyView>;
  pausePolicy(userId: string, policyId: string): Promise<PolicyView>;
  resumePolicy(userId: string, policyId: string, identityConfirmedAtMs: number): Promise<PolicyView>;
  removePolicy(userId: string, policyId: string): Promise<PolicyView>;
  disable(userId: string): Promise<UserView>;
  enable(userId: string, identityConfirmedAtMs: number): Promise<UserView>;
  addCard(userId: string, cardId: string): Promise<{ cards: string[] }>;
  removeCard(userId: string, cardId: string): Promise<{ cards: string[] }>;
}

export class ControlClient implements ControlPort {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly portalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${this.portalToken}`, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ControlUnavailable("the control service is unreachable");
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // No JSON body: decided by the status below.
    }
    if (res.status >= 200 && res.status < 300) return json as T;
    // 401: the portal's own token is wrong. 5xx: L2 failed. Neither is the person's doing.
    if (res.status === 401 || res.status >= 500) throw new ControlUnavailable(`the control service answered ${res.status}`);
    throw new ControlError(res.status, json);
  }

  private u(userId: string, rest = ""): string {
    return `/v1/users/${encodeURIComponent(userId)}${rest}`;
  }
  private p(userId: string, policyId: string, rest = ""): string {
    return this.u(userId, `/policies/${encodeURIComponent(policyId)}${rest}`);
  }

  platform = () => this.call<PlatformView>("GET", "/v1/platform");
  user = (userId: string) => this.call<UserView>("GET", this.u(userId));
  register = (userId: string) => this.call<UserView>("PUT", this.u(userId, "/registration"), { acknowledgedTestFunds: true });
  createWallet = (userId: string) => this.call<UserView>("PUT", this.u(userId, "/wallet"));
  createPolicy = (userId: string, values: PolicyValues, identityConfirmedAtMs: number) =>
    this.call<PolicyView>("POST", this.u(userId, "/policies"), { ...values, identityConfirmedAtMs });
  policy = (userId: string, policyId: string) => this.call<PolicyView>("GET", this.p(userId, policyId));
  changePolicy = (userId: string, policyId: string, values: PolicyValues, expectedVersion: number, identityConfirmedAtMs: number) =>
    this.call<PolicyView>("PUT", this.p(userId, policyId), { ...values, expectedVersion, identityConfirmedAtMs });
  pausePolicy = (userId: string, policyId: string) => this.call<PolicyView>("POST", this.p(userId, policyId, "/pause"), {});
  resumePolicy = (userId: string, policyId: string, identityConfirmedAtMs: number) =>
    this.call<PolicyView>("POST", this.p(userId, policyId, "/resume"), { identityConfirmedAtMs });
  removePolicy = (userId: string, policyId: string) => this.call<PolicyView>("POST", this.p(userId, policyId, "/remove"), {});
  disable = (userId: string) => this.call<UserView>("POST", this.u(userId, "/disable"));
  enable = (userId: string, identityConfirmedAtMs: number) => this.call<UserView>("POST", this.u(userId, "/enable"), { identityConfirmedAtMs });
  addCard = (userId: string, cardId: string) => this.call<{ cards: string[] }>("PUT", this.u(userId, `/cards/${encodeURIComponent(cardId)}`));
  removeCard = (userId: string, cardId: string) => this.call<{ cards: string[] }>("DELETE", this.u(userId, `/cards/${encodeURIComponent(cardId)}`));
}
