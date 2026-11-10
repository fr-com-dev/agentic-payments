// 013 user accounts (SPEC.md §8.2 L2-8; specs/013 data-model.md). Pure functions over ledger entries, like
// escalations.ts: users, wallets, cards, policies and account state are derived from the ledger every time, and
// nothing here is stored anywhere else (INV-7, INV-9). No I/O and no clock read: time is always an argument.
// No function takes text typed by a person: every string is an identifier, a seller host, an ISO date or an atomic
// amount (specs/013 research R6).
import type { NetworkProfile } from "../shared/config.js";
import type {
  PlatformView,
  PolicyDisplayState,
  PolicyEventKind,
  PolicyIssue,
  PolicyState,
  PolicyValues,
  PolicyVersion,
  PolicyView,
  UserView,
} from "../shared/contracts.js";
import type { LedgerEntry } from "./ledger.js";
import type { SpendingMandate } from "./mandate.js";
import { platformDigest, sellerFor, type PlatformConfig } from "./platform.js";
import type { PaymentSignerLike } from "./signer.js";

export const MAX_ACTIVE_POLICIES = 10;
export const MAX_SELLERS_PER_POLICY = 20;
export const MAX_CARDS = 5;
/** FR-007: a loosening change needs the person to have signed in at most this long ago. */
export const STEP_UP_MAX_AGE_MS = 900_000;
/** Clock tolerance between the sign-in service and L2, as for requester tokens (L1-6). */
export const STEP_UP_TOLERANCE_MS = 60_000;
export const TERMS_VERSION = "test-funds-v1";
export const CARD_ID_RE = /^card_[0-9a-f-]{36}$/;
export const POLICY_ID_RE = /^pol_[0-9a-f-]{36}$/;

const DAY_MS = 86_400_000;
const ATOMIC = /^\d+$/;
const AMOUNT_FIELDS = ["autoApproveMaxAtomic", "hardCapPerPaymentAtomic", "sessionBudgetAtomic", "dailyBudgetAtomic"] as const;
type AmountField = (typeof AMOUNT_FIELDS)[number];

type Entries = readonly LedgerEntry[];

/** What the user-account code needs from the signer: one account per wallet index (specs/013 research R3). */
export interface WalletKeyringLike {
  addressOf(index: number): string;
  signerFor(index: number, hardCapAtomic: string): PaymentSignerLike;
}

/**
 * User accounts as L2 runs them. The optional switches are test-only must-fail proofs (Constitution VIII): each one
 * removes a single safety mechanism so its test can show the damage. They are never read from the environment.
 */
export interface UserAccountsDeps {
  platform: PlatformConfig;
  keyring: WalletKeyringLike;
  skipOwnershipCheck?: boolean;
  sharedSigner?: boolean;
  sharedBudgets?: boolean;
  skipPlatformBound?: boolean;
  skipUserCeiling?: boolean;
  skipUserGate?: boolean;
  fallbackToPlatform?: boolean;
  skipSellerOverlapCheck?: boolean;
  unserializedUserWrites?: boolean;
}

export interface WalletRecord {
  walletIndex: number;
  address: string;
  network: string;
}

export interface PolicyRecord {
  policyId: string;
  userId: string;
  version: number;
  values: PolicyValues;
  state: PolicyState;
  updatedAt: string;
  history: PolicyVersion[];
}

export interface UserState {
  userId: string;
  registered: boolean;
  enabled: boolean;
  wallet?: WalletRecord;
  /** Card identifiers, added minus removed, in the order added. */
  cards: string[];
  policies: PolicyRecord[];
  /** FR-011: a profile, a crypto account and a first policy saved. Stays true when policies are paused or removed. */
  onboarded: boolean;
}

const POLICY_KIND: Partial<Record<LedgerEntry["type"], PolicyEventKind>> = {
  POLICY_CREATED: "created",
  POLICY_CHANGED: "changed",
  POLICY_PAUSED: "paused",
  POLICY_RESUMED: "resumed",
  POLICY_REMOVED: "removed",
};

/** The eight rule values of an entry, copied field by field (never by spreading entry data). */
export function valuesOf(d: Record<string, unknown>): PolicyValues {
  return {
    sellers: [...(d.sellers as string[])],
    autoApproveMaxAtomic: String(d.autoApproveMaxAtomic),
    hardCapPerPaymentAtomic: String(d.hardCapPerPaymentAtomic),
    sessionBudgetAtomic: String(d.sessionBudgetAtomic),
    dailyBudgetAtomic: String(d.dailyBudgetAtomic),
    maxAuthorizationsPerMinute: Number(d.maxAuthorizationsPerMinute),
    expiresAt: String(d.expiresAt),
    paymentMethod: "crypto_account",
  };
}

/** Canonical form for storing and comparing: sorted, de-duplicated sellers and an ISO end date. */
export function normalizeValues(v: PolicyValues): PolicyValues {
  return {
    sellers: [...new Set(v.sellers)].sort(),
    autoApproveMaxAtomic: v.autoApproveMaxAtomic,
    hardCapPerPaymentAtomic: v.hardCapPerPaymentAtomic,
    sessionBudgetAtomic: v.sessionBudgetAtomic,
    dailyBudgetAtomic: v.dailyBudgetAtomic,
    maxAuthorizationsPerMinute: v.maxAuthorizationsPerMinute,
    expiresAt: Number.isNaN(Date.parse(v.expiresAt)) ? v.expiresAt : new Date(Date.parse(v.expiresAt)).toISOString(),
    paymentMethod: v.paymentMethod,
  };
}

export function sameValues(a: PolicyValues, b: PolicyValues): boolean {
  const x = normalizeValues(a);
  const y = normalizeValues(b);
  return (
    x.sellers.length === y.sellers.length &&
    x.sellers.every((s, i) => s === y.sellers[i]) &&
    AMOUNT_FIELDS.every((f) => x[f] === y[f]) &&
    x.maxAuthorizationsPerMinute === y.maxAuthorizationsPerMinute &&
    x.expiresAt === y.expiresAt &&
    x.paymentMethod === y.paymentMethod
  );
}

/** One user's state, from that user's entries only. An unknown user is all-false with empty lists. */
export function userState(entries: Entries, userId: string): UserState {
  let registered = false;
  let enabled = true;
  let wallet: WalletRecord | undefined;
  const cards: string[] = [];
  const policies = new Map<string, PolicyRecord>();
  for (const e of entries) {
    const d = e.data;
    if (d.userId !== userId) continue;
    switch (e.type) {
      case "USER_REGISTERED":
        registered = true;
        break;
      case "USER_DISABLED":
        enabled = false;
        break;
      case "USER_ENABLED":
        enabled = true;
        break;
      case "WALLET_CREATED":
        wallet ??= { walletIndex: Number(d.walletIndex), address: String(d.address), network: String(d.network) };
        break;
      case "CARD_ADDED":
        if (!cards.includes(String(d.cardId))) cards.push(String(d.cardId));
        break;
      case "CARD_REMOVED": {
        const at = cards.indexOf(String(d.cardId));
        if (at >= 0) cards.splice(at, 1);
        break;
      }
      case "POLICY_CREATED":
      case "POLICY_CHANGED":
      case "POLICY_PAUSED":
      case "POLICY_RESUMED":
      case "POLICY_REMOVED": {
        const policyId = String(d.policyId);
        const kind = POLICY_KIND[e.type]!;
        let p = policies.get(policyId);
        if (e.type === "POLICY_CREATED") {
          p = { policyId, userId, version: 1, values: valuesOf(d), state: "active", updatedAt: e.ts, history: [] };
          policies.set(policyId, p);
        }
        if (!p) break; // an event for a policy that was never created: ignored, never trusted
        if (e.type === "POLICY_CHANGED") {
          p.version = Number(d.version);
          p.values = valuesOf(d);
        } else if (e.type === "POLICY_PAUSED") p.state = "paused";
        else if (e.type === "POLICY_RESUMED") p.state = "active";
        else if (e.type === "POLICY_REMOVED") p.state = "removed";
        p.updatedAt = e.ts;
        p.history.push({
          seq: e.seq,
          ts: e.ts,
          kind,
          version: p.version,
          ...((kind === "created" || kind === "changed") && { values: valuesOf(d) }),
          ...(kind === "paused" && { cause: d.cause === "account_enabled" ? ("account_enabled" as const) : ("user" as const) }),
        });
        break;
      }
      default:
        break;
    }
  }
  const list = [...policies.values()];
  return {
    userId,
    registered,
    enabled,
    ...(wallet && { wallet }),
    cards,
    policies: list,
    onboarded: registered && wallet !== undefined && list.length > 0,
  };
}

/** The user who owns a policy, whoever asks. Used only by the ownership must-fail proof. */
export function policyOwner(entries: Entries, policyId: string): string | undefined {
  const created = entries.find((e) => e.type === "POLICY_CREATED" && e.data.policyId === policyId);
  return typeof created?.data.userId === "string" ? created.data.userId : undefined;
}

/** Number of WALLET_CREATED entries so far: the next wallet index (specs/013 research R3). */
export function nextWalletIndex(entries: Entries): number {
  let n = 0;
  for (const e of entries) if (e.type === "WALLET_CREATED") n++;
  return n;
}

/** Every recorded wallet, for the startup comparison with the keyring. */
export function recordedWallets(entries: Entries): Array<WalletRecord & { userId: string }> {
  return entries
    .filter((e) => e.type === "WALLET_CREATED")
    .map((e) => ({
      userId: String(e.data.userId),
      walletIndex: Number(e.data.walletIndex),
      address: String(e.data.address),
      network: String(e.data.network),
    }));
}

/** The digest of the last PLATFORM_CONFIG entry, if any. */
export function lastPlatformDigest(entries: Entries): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "PLATFORM_CONFIG") return String(e.data.digest);
  }
  return undefined;
}

export type UserGate = "not_onboarded" | "disabled";

/** FR-012, FR-038: why a user can't pay at all, before any policy is looked at. */
export function userGate(state: UserState): UserGate | undefined {
  if (!state.onboarded) return "not_onboarded";
  if (!state.enabled) return "disabled";
  return undefined;
}

// ---------------------------------------------------------------------------
// Saving a policy
// ---------------------------------------------------------------------------

const isAtomic = (v: unknown): v is string => typeof v === "string" && ATOMIC.test(v);

/**
 * Shape check of a request body (400 when it fails): the eight fields, the right JSON types, nothing else.
 * Semantic checks (422) are `validatePolicy`'s.
 */
export function parsePolicyValues(body: Record<string, unknown>): PolicyValues | undefined {
  const sellers = body.sellers;
  if (!Array.isArray(sellers) || sellers.some((s) => typeof s !== "string")) return undefined;
  for (const f of AMOUNT_FIELDS) if (typeof body[f] !== "string") return undefined;
  if (typeof body.maxAuthorizationsPerMinute !== "number") return undefined;
  if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt))) return undefined;
  if (typeof body.paymentMethod !== "string") return undefined;
  return normalizeValues({
    sellers: sellers as string[],
    autoApproveMaxAtomic: body.autoApproveMaxAtomic as string,
    hardCapPerPaymentAtomic: body.hardCapPerPaymentAtomic as string,
    sessionBudgetAtomic: body.sessionBudgetAtomic as string,
    dailyBudgetAtomic: body.dailyBudgetAtomic as string,
    maxAuthorizationsPerMinute: body.maxAuthorizationsPerMinute,
    expiresAt: body.expiresAt,
    paymentMethod: body.paymentMethod as "crypto_account",
  });
}

export const POLICY_VALUE_KEYS: readonly string[] = [
  "sellers",
  ...AMOUNT_FIELDS,
  "maxAuthorizationsPerMinute",
  "expiresAt",
  "paymentMethod",
];

export interface ValidationContext {
  platform: PlatformConfig;
  nowMs: number;
  /** The user's other active policies (the one being saved excluded). */
  others: readonly PolicyRecord[];
  /** True when saving would add one to the user's active policies (a create, or a resume). */
  addsActive: boolean;
  /** Test-only (must-fail proof of FR-028). */
  skipSellerOverlapCheck?: boolean;
}

/** FR-026: every reason a save is refused, all at once (specs/013 data-model.md "Validation of a policy save"). */
export function validatePolicy(v: PolicyValues, c: ValidationContext): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const limits = c.platform.limits;
  const ok: Partial<Record<AmountField, bigint>> = {};
  for (const f of AMOUNT_FIELDS) {
    if (!isAtomic(v[f])) issues.push({ field: f, code: "not_atomic" });
    else ok[f] = BigInt(v[f]);
  }
  const auto = ok.autoApproveMaxAtomic;
  const cap = ok.hardCapPerPaymentAtomic;
  const session = ok.sessionBudgetAtomic;
  const daily = ok.dailyBudgetAtomic;
  if (auto !== undefined && cap !== undefined && !(auto < cap)) issues.push({ field: "autoApproveMaxAtomic", code: "order_auto_below_cap" });
  if (cap !== undefined && session !== undefined && !(cap <= session)) issues.push({ field: "hardCapPerPaymentAtomic", code: "order_cap_within_session" });
  const above = (field: AmountField, value: bigint | undefined, limitAtomic: string) => {
    if (value !== undefined && value > BigInt(limitAtomic)) issues.push({ field, code: "above_platform_limit", limitAtomic });
  };
  above("hardCapPerPaymentAtomic", cap, limits.hardCapPerPaymentAtomic);
  above("sessionBudgetAtomic", session, limits.sessionBudgetAtomic);
  above("dailyBudgetAtomic", daily, limits.userDailyCeilingAtomic);

  const rate = v.maxAuthorizationsPerMinute;
  if (!Number.isInteger(rate) || rate < 1) issues.push({ field: "maxAuthorizationsPerMinute", code: "rate_invalid" });
  else if (rate > limits.maxAuthorizationsPerMinute) {
    issues.push({ field: "maxAuthorizationsPerMinute", code: "above_platform_limit", limit: limits.maxAuthorizationsPerMinute });
  }

  if (v.sellers.length === 0) issues.push({ field: "sellers", code: "no_sellers" });
  if (v.sellers.length > MAX_SELLERS_PER_POLICY) issues.push({ field: "sellers", code: "too_many_sellers", limit: MAX_SELLERS_PER_POLICY });
  v.sellers.forEach((host, i) => {
    if (!sellerFor(c.platform, host)) {
      issues.push({ field: `sellers[${i}]`, code: "seller_not_listed", host });
      return;
    }
    if (c.skipSellerOverlapCheck) return;
    const other = c.others.find((p) => p.state === "active" && p.values.sellers.includes(host));
    if (other) issues.push({ field: `sellers[${i}]`, code: "seller_conflict", host, policyId: other.policyId });
  });

  const expires = Date.parse(v.expiresAt);
  if (!(expires > c.nowMs)) issues.push({ field: "expiresAt", code: "expires_in_past" });
  else if (expires > c.nowMs + limits.maxPolicyDays * DAY_MS) issues.push({ field: "expiresAt", code: "expires_too_late", limit: limits.maxPolicyDays });

  if (v.paymentMethod !== "crypto_account") issues.push({ field: "paymentMethod", code: "payment_method_unsupported" });
  if (c.addsActive && c.others.filter((p) => p.state === "active").length >= MAX_ACTIVE_POLICIES) {
    issues.push({ field: "policy", code: "policy_limit", limit: MAX_ACTIVE_POLICIES });
  }
  return issues;
}

/**
 * FR-007: a save loosens when it raises an amount or the rate, adds a seller or moves the end date later. Creating a
 * policy always loosens. An unparsable amount never counts as a rise here: `validatePolicy` refuses it anyway.
 */
export function isLoosening(previous: PolicyValues | undefined, next: PolicyValues): boolean {
  if (previous === undefined) return true;
  for (const f of AMOUNT_FIELDS) {
    if (isAtomic(previous[f]) && isAtomic(next[f]) && BigInt(next[f]) > BigInt(previous[f])) return true;
  }
  if (next.maxAuthorizationsPerMinute > previous.maxAuthorizationsPerMinute) return true;
  if (next.sellers.some((s) => !previous.sellers.includes(s))) return true;
  return Date.parse(next.expiresAt) > Date.parse(previous.expiresAt);
}

/** True when the person's sign-in time, as the portal reports it, is recent enough for a loosening change. */
export function stepUpFresh(identityConfirmedAtMs: unknown, nowMs: number): boolean {
  if (typeof identityConfirmedAtMs !== "number" || !Number.isFinite(identityConfirmedAtMs)) return false;
  const age = nowMs - identityConfirmedAtMs;
  return age >= -STEP_UP_TOLERANCE_MS && age <= STEP_UP_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Deciding with a policy
// ---------------------------------------------------------------------------

/**
 * FR-029: the user's one active policy that lists the host, provided the host is still on the seller list (FR-042).
 * FR-028 guarantees at most one; if the overlap check was ever bypassed, the first created wins, deterministically.
 * An expired policy is still selected: rule R1 denies it as `mandate_expired`.
 */
export function selectPolicy(state: UserState, host: string | null, platform: PlatformConfig): PolicyRecord | undefined {
  if (host === null || !sellerFor(platform, host)) return undefined;
  return state.policies.find((p) => p.state === "active" && p.values.sellers.includes(host));
}

const minAtomic = (a: string, b: string) => (BigInt(a) <= BigInt(b) ? a : b);
const NO_POLICY_EXPIRES = "9999-12-31T23:59:59.000Z";

export interface EffectiveMandateInput {
  policy: PolicyRecord | undefined;
  host: string | null;
  platform: PlatformConfig;
  /** The platform account's mandate: schemes and the timeout range come from it. */
  platformMandate: SpendingMandate;
  net: Pick<NetworkProfile, "caip2" | "asset">;
  /** Test-only (must-fail proof of FR-041): the policy's own values, unbounded. */
  skipPlatformBound?: boolean;
}

/**
 * FR-030: the mandate the unchanged engine evaluates for one request. With a policy: its values, made no looser than
 * the platform limits, for the requested host and that seller's payees only. Without one: no allowed host, so R6
 * denies with `host_not_allowed`.
 */
export function effectiveMandate(i: EffectiveMandateInput): SpendingMandate {
  const limits = i.platform.limits;
  const base = {
    allowedSchemes: i.platformMandate.allowedSchemes,
    allowedNetworks: [i.net.caip2],
    allowedAssets: { [i.net.caip2]: [i.net.asset.toLowerCase()] },
    maxTimeoutSeconds: i.platformMandate.maxTimeoutSeconds,
  };
  if (!i.policy || i.host === null) {
    return {
      ...base,
      mandateId: `${i.platform.platformId}:no-policy`,
      expiresAt: NO_POLICY_EXPIRES,
      allowedPayees: [],
      allowedHosts: [],
      autoApproveMaxAtomic: "0",
      hardCapPerPaymentAtomic: limits.hardCapPerPaymentAtomic,
      sessionBudgetAtomic: limits.sessionBudgetAtomic,
      dailyBudgetAtomic: limits.userDailyCeilingAtomic,
      maxAuthorizationsPerMinute: limits.maxAuthorizationsPerMinute,
    };
  }
  const v = i.policy.values;
  const bound = !i.skipPlatformBound;
  return {
    ...base,
    mandateId: `${i.policy.policyId}@${i.policy.version}`,
    expiresAt: v.expiresAt,
    allowedPayees: sellerFor(i.platform, i.host)?.payees ?? [],
    allowedHosts: [i.host],
    autoApproveMaxAtomic: v.autoApproveMaxAtomic,
    hardCapPerPaymentAtomic: bound ? minAtomic(v.hardCapPerPaymentAtomic, limits.hardCapPerPaymentAtomic) : v.hardCapPerPaymentAtomic,
    sessionBudgetAtomic: bound ? minAtomic(v.sessionBudgetAtomic, limits.sessionBudgetAtomic) : v.sessionBudgetAtomic,
    dailyBudgetAtomic: bound ? minAtomic(v.dailyBudgetAtomic, limits.userDailyCeilingAtomic) : v.dailyBudgetAtomic,
    maxAuthorizationsPerMinute: bound ? Math.min(v.maxAuthorizationsPerMinute, limits.maxAuthorizationsPerMinute) : v.maxAuthorizationsPerMinute,
  };
}

// ---------------------------------------------------------------------------
// Views (whitelist projections)
// ---------------------------------------------------------------------------

/** FR-043: the fields the platform limits currently make stricter than the user wrote them. */
export function limitedByPlatform(v: PolicyValues, platform: PlatformConfig): string[] {
  const l = platform.limits;
  const out: string[] = [];
  const over = (field: AmountField, limit: string) => {
    if (isAtomic(v[field]) && BigInt(v[field]) > BigInt(limit)) out.push(field);
  };
  over("hardCapPerPaymentAtomic", l.hardCapPerPaymentAtomic);
  over("sessionBudgetAtomic", l.sessionBudgetAtomic);
  over("dailyBudgetAtomic", l.userDailyCeilingAtomic);
  if (v.maxAuthorizationsPerMinute > l.maxAuthorizationsPerMinute) out.push("maxAuthorizationsPerMinute");
  return out;
}

export function policyView(p: PolicyRecord, o: { platform: PlatformConfig; nowMs: number; enabled: boolean; history?: boolean }): PolicyView {
  const expired = o.nowMs > Date.parse(p.values.expiresAt);
  let displayState: PolicyDisplayState = p.state;
  if (p.state !== "removed") {
    if (!o.enabled) displayState = "disabled";
    else if (p.state === "active" && expired) displayState = "expired";
  }
  return {
    policyId: p.policyId,
    version: p.version,
    values: p.values,
    state: p.state,
    displayState,
    expired,
    limitedByPlatform: limitedByPlatform(p.values, o.platform),
    unlistedSellers: p.values.sellers.filter((s) => !sellerFor(o.platform, s)),
    updatedAt: p.updatedAt,
    ...(o.history && { history: p.history }),
  };
}

export interface UserFigures {
  /** Amounts of this user's authorizations that can still move money. */
  committedAtomic: bigint;
  /** The same, over the last 24 hours: the figure R12 counts. */
  spent24hAtomic: bigint;
}

export function userView(
  state: UserState,
  o: { platform: PlatformConfig; net: Pick<NetworkProfile, "asset" | "decimals">; nowMs: number; figures: UserFigures },
): UserView {
  const ceiling = BigInt(o.platform.limits.userDailyCeilingAtomic);
  const remaining = ceiling - o.figures.spent24hAtomic;
  return {
    userId: state.userId,
    registered: state.registered,
    enabled: state.enabled,
    onboarding: { profile: state.registered, wallet: state.wallet !== undefined, policy: state.policies.length > 0 },
    ...(state.wallet && {
      wallet: {
        address: state.wallet.address,
        network: state.wallet.network,
        asset: o.net.asset,
        decimals: o.net.decimals,
        committedAtomic: o.figures.committedAtomic.toString(),
        spent24hAtomic: o.figures.spent24hAtomic.toString(),
        dailyCeilingAtomic: ceiling.toString(),
        dailyRemainingAtomic: (remaining < 0n ? 0n : remaining).toString(),
      },
    }),
    cards: state.cards,
    policies: state.policies
      .map((p) => policyView(p, { platform: o.platform, nowMs: o.nowMs, enabled: state.enabled }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
  };
}

export function platformView(platform: PlatformConfig, net: Pick<NetworkProfile, "caip2" | "asset" | "decimals">): PlatformView {
  return {
    platformId: platform.platformId,
    digest: platformDigest(platform),
    limits: platform.limits,
    sellers: platform.sellers,
    network: net.caip2,
    asset: net.asset,
    decimals: net.decimals,
  };
}

/** The highest auto-approve limit among a user's active, unexpired policies, bounded by the platform cap. */
export function highestAutoApprove(state: UserState, platform: PlatformConfig, nowMs: number): string {
  let best = 0n;
  for (const p of state.policies) {
    if (p.state !== "active" || nowMs > Date.parse(p.values.expiresAt) || !isAtomic(p.values.autoApproveMaxAtomic)) continue;
    const v = BigInt(p.values.autoApproveMaxAtomic);
    if (v > best) best = v;
  }
  const cap = BigInt(platform.limits.hardCapPerPaymentAtomic);
  return (best > cap ? cap : best).toString();
}
