// The portal API client (specs/013 contracts/portal-api.md). One function per route. Every call carries the person's
// own token and nothing else: no call sends a user identifier, because the portal takes the user from the token.
// Failures come back as values, never as exceptions, so a screen always has something to show.
import type { Card, Config, Issue, Me, Platform, Policy, PolicyInput, Wallet } from "./types.js";

export interface ApiError {
  ok: false;
  /** The HTTP status; 0 when the portal could not be reached. */
  status: number;
  error: string;
  issues?: Issue[];
  current?: Policy;
  maxAgeSec?: number;
  vaultCode?: string;
}
export type ApiResult<T> = { ok: true; data: T } | ApiError;

export interface Api {
  config(): Promise<ApiResult<Config>>;
  me(): Promise<ApiResult<Me>>;
  saveProfile(input: { displayName: string; contactEmail: string; acknowledgedTestFunds?: boolean }): Promise<ApiResult<Me>>;
  platform(): Promise<ApiResult<Platform>>;
  wallet(): Promise<ApiResult<Wallet>>;
  createAccount(): Promise<ApiResult<Wallet>>;
  cardSetup(): Promise<ApiResult<{ clientSecret: string }>>;
  confirmCard(setupIntentId: string, nickname?: string): Promise<ApiResult<Card>>;
  removeCard(cardId: string): Promise<ApiResult<{ cards: Card[] }>>;
  policies(): Promise<ApiResult<{ policies: Policy[] }>>;
  policy(policyId: string): Promise<ApiResult<Policy>>;
  createPolicy(input: PolicyInput): Promise<ApiResult<Policy>>;
  changePolicy(policyId: string, input: PolicyInput, expectedVersion: number): Promise<ApiResult<Policy>>;
  pausePolicy(policyId: string): Promise<ApiResult<Policy>>;
  resumePolicy(policyId: string): Promise<ApiResult<Policy>>;
  removePolicy(policyId: string): Promise<ApiResult<Policy>>;
  disableAccount(): Promise<ApiResult<Me>>;
  enableAccount(): Promise<ApiResult<Me>>;
}

export function createApi(token: () => Promise<string | null>, fetchImpl: typeof fetch = fetch, base = ""): Api {
  async function call<T>(method: string, path: string, body?: unknown, open = false): Promise<ApiResult<T>> {
    let res: Response;
    try {
      const bearer = open ? null : await token();
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { ...(bearer !== null && { authorization: `Bearer ${bearer}` }), ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      return { ok: false, status: 0, error: "network" };
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // No JSON body: the status decides.
    }
    if (res.ok) return { ok: true, data: json as T };
    return {
      ok: false,
      status: res.status,
      error: typeof json.error === "string" ? json.error : "error",
      ...(Array.isArray(json.issues) && { issues: json.issues as Issue[] }),
      ...(json.current !== undefined && { current: json.current as Policy }),
      ...(typeof json.maxAgeSec === "number" && { maxAgeSec: json.maxAgeSec }),
      ...(typeof json.vaultCode === "string" && { vaultCode: json.vaultCode }),
    };
  }
  const id = encodeURIComponent;
  return {
    config: () => call("GET", "/api/config", undefined, true),
    me: () => call("GET", "/api/me"),
    saveProfile: (input) => call("PUT", "/api/profile", input),
    platform: () => call("GET", "/api/platform"),
    wallet: () => call("GET", "/api/wallet"),
    createAccount: () => call("PUT", "/api/wallet/account"),
    cardSetup: () => call("POST", "/api/cards/setup"),
    confirmCard: (setupIntentId, nickname) => call("POST", "/api/cards", { setupIntentId, ...(nickname !== undefined && nickname !== "" && { nickname }) }),
    removeCard: (cardId) => call("DELETE", `/api/cards/${id(cardId)}`),
    policies: () => call("GET", "/api/policies"),
    policy: (policyId) => call("GET", `/api/policies/${id(policyId)}`),
    createPolicy: (input) => call("POST", "/api/policies", input),
    changePolicy: (policyId, input, expectedVersion) => call("PUT", `/api/policies/${id(policyId)}`, { ...input, expectedVersion }),
    pausePolicy: (policyId) => call("POST", `/api/policies/${id(policyId)}/pause`),
    resumePolicy: (policyId) => call("POST", `/api/policies/${id(policyId)}/resume`),
    removePolicy: (policyId) => call("POST", `/api/policies/${id(policyId)}/remove`),
    disableAccount: () => call("POST", "/api/account/disable", { confirm: true }),
    enableAccount: () => call("POST", "/api/account/enable"),
  };
}
