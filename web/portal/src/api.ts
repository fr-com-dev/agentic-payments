// The portal API client (specs/013 contracts/portal-api.md). One function per route. Every call carries the person's
// own token and nothing else: no call sends a user identifier, because the portal takes the user from the token.
// Failures come back as values, never as exceptions, so a screen always has something to show.
import type {
  AdminEscalation,
  AdminEscalationDetail,
  AdminEventPage,
  AdminLedgerCheck,
  Card,
  Config,
  DecisionOutcome,
  Issue,
  Me,
  Platform,
  Policy,
  PolicyInput,
  RejectionReasonCode,
  Wallet,
} from "./types.js";

export interface ApiError {
  ok: false;
  /** The HTTP status; 0 when the portal could not be reached. */
  status: number;
  error: string;
  issues?: Issue[];
  current?: Policy;
  maxAgeSec?: number;
  vaultCode?: string;
  /** 014: on 409 `not_pending`: how the payment actually ended, on which path and by whom. */
  state?: string;
  channel?: string;
  decidedBy?: string;
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
  // 014 the administration area (specs/014 contracts/portal-api.md). No call sends a user identifier or any text.
  adminEscalations(): Promise<ApiResult<{ pending: AdminEscalation[]; readAt: string }>>;
  adminEscalation(authorizationId: string): Promise<ApiResult<AdminEscalationDetail>>;
  approveEscalation(authorizationId: string): Promise<ApiResult<DecisionOutcome>>;
  rejectEscalation(authorizationId: string, reasonCode: RejectionReasonCode): Promise<ApiResult<DecisionOutcome>>;
  adminEvents(q?: { after?: number; before?: number; limit?: number }): Promise<ApiResult<AdminEventPage>>;
  adminLedgerCheck(): Promise<ApiResult<AdminLedgerCheck>>;
}

/**
 * 014: /api/me as the app uses it. A person who is only an administrator has no account state and no onboarding;
 * the two fields are filled with neutral values so no screen has to ask. An answer without the two flags (a portal
 * older than this web app) is a user and not an administrator.
 */
export function normalizeMe(raw: Partial<Me> & { userId: string }): Me {
  const user = raw.user ?? true;
  return {
    ...raw,
    user,
    admin: raw.admin ?? false,
    enabled: raw.enabled ?? true,
    onboarding: raw.onboarding ?? { profile: false, wallet: false, policy: false },
  };
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
      ...(typeof json.state === "string" && { state: json.state }),
      ...(typeof json.channel === "string" && { channel: json.channel }),
      ...(typeof json.decidedBy === "string" && { decidedBy: json.decidedBy }),
    };
  }
  const asMe = async (r: Promise<ApiResult<Me>>): Promise<ApiResult<Me>> => {
    const res = await r;
    return res.ok ? { ok: true, data: normalizeMe(res.data) } : res;
  };
  const query = (q: Record<string, number | undefined>) => {
    const parts = Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${encodeURIComponent(String(v))}`]));
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  };
  const id = encodeURIComponent;
  return {
    config: () => call("GET", "/api/config", undefined, true),
    me: () => asMe(call("GET", "/api/me")),
    saveProfile: (input) => asMe(call("PUT", "/api/profile", input)),
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
    disableAccount: () => asMe(call("POST", "/api/account/disable", { confirm: true })),
    enableAccount: () => asMe(call("POST", "/api/account/enable")),
    adminEscalations: () => call("GET", "/api/admin/escalations"),
    adminEscalation: (authorizationId) => call("GET", `/api/admin/escalations/${id(authorizationId)}`),
    approveEscalation: (authorizationId) => call("POST", `/api/admin/escalations/${id(authorizationId)}/approve`, {}),
    rejectEscalation: (authorizationId, reasonCode) => call("POST", `/api/admin/escalations/${id(authorizationId)}/reject`, { reasonCode }),
    adminEvents: (q = {}) => call("GET", `/api/admin/escalations/events${query({ after: q.after, before: q.before, limit: q.limit })}`),
    adminLedgerCheck: () => call("GET", "/api/admin/ledger/verify"),
  };
}
