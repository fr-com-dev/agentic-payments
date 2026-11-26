// What the portal API returns (specs/013 contracts/portal-api.md), as the web app uses it. Amounts are always
// decimal strings of atomic units; nothing here is ever a floating-point number of money.
import type {
  DecisionChannel,
  DecisionOutcome,
  EscalationBudget,
  EscalationDecision,
  EscalationEvent,
  BudgetLine,
  LedgerCheck,
  PolicyValues,
  PolicyVersion,
  RejectionReasonCode,
} from "../../../src/shared/contracts.js";

export type { BudgetLine, DecisionChannel, DecisionOutcome, EscalationBudget, EscalationDecision, PolicyValues, PolicyVersion, RejectionReasonCode };

export interface Onboarding {
  profile: boolean;
  wallet: boolean;
  policy: boolean;
}

export interface Me {
  userId: string;
  /** 014: may use the administration area. Every signed-in person is a user; an administrator is one of them. */
  admin: boolean;
  enabled: boolean;
  onboarding: Onboarding;
  profile?: { displayName: string; contactEmail: string };
}

/** 017: the portal's public configuration, what sign-in and cards need and nothing else (T-PRT-18). */
export interface Config {
  auth: { mode: "auth0" | "dev"; domain: string; clientId: string; audience: string };
  cards: { available: boolean; publishableKey?: string };
}

export interface Limits {
  hardCapPerPaymentAtomic: string;
  sessionBudgetAtomic: string;
  userDailyCeilingAtomic: string;
  maxAuthorizationsPerMinute: number;
  maxPolicyDays: number;
}

export interface Seller {
  host: string;
  name: string;
}

export interface Platform {
  limits: Limits;
  sellers: Seller[];
  network: string;
  asset: string;
  decimals: number;
}

export interface Account {
  address: string;
  network: string;
  asset: string;
  decimals: number;
  balanceAtomic?: string;
  balanceReadAt?: string;
  balanceStale: boolean;
  committedAtomic: string;
  spent24hAtomic: string;
  dailyCeilingAtomic: string;
  dailyRemainingAtomic: string;
  lowBalance: boolean;
}

export interface Card {
  cardId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  nickname?: string;
  addedAt: string;
  expired: boolean;
}

export interface Wallet {
  account?: Account;
  cards: Card[];
  cardsAvailable: boolean;
  disabled: boolean;
  /**
   * 020: one row per platform the deployment offers (only Coinbase). Empty when connected platforms are off, and
   * absent from a portal older than this web app: both show nothing of them.
   */
  connections?: Connection[];
}

// ---------------------------------------------------------------------------
// 020 connected platforms (specs/020 contracts/portal-api.md, data-model.md "Balances"). View only: nothing here ever
// pays, and every amount is a decimal string, never a floating-point number.
// ---------------------------------------------------------------------------

export type ConnectionStatus = "not_connected" | "connected" | "reconnect" | "unavailable";

/** A connected platform as the wallet lists it. No grant, token or Coinbase identifier ever reaches the browser. */
export interface Connection {
  platform: "coinbase";
  status: ConnectionStatus;
  /** With `connected` and `reconnect`. */
  connectedAt?: string;
  /** The deployment's own pages, linked before a person connects (FR-030). */
  privacyPolicyUrl: string;
  supportUrl: string;
}

/** What `complete` answers when the connection is made. */
export interface ConnectionMade {
  platform: "coinbase";
  status: "connected";
  connectedAt: string;
}

/** A US dollar value: a decimal string with exactly two places, e.g. "1234.56". */
export interface Money {
  amount: string;
  currency: "USD";
}

export interface PlatformAsset {
  /** Coinbase's currency code, e.g. "BTC". Text from outside: shown as text only. */
  code: string;
  /** Coinbase's name for it. Text from outside: shown as text only. */
  name: string;
  /** The exact decimal string Coinbase reports, e.g. "0.00012345". */
  amount: string;
  /** Absent when Coinbase gives no rate for `code`. */
  value?: Money;
}

export interface PlatformBalances {
  /** When the figures were read from Coinbase. */
  readAt: string;
  /** The last read failed: these are older figures. */
  stale: boolean;
  /** Funded assets only, largest value first, at most 200. */
  assets: PlatformAsset[];
  /** How many funded assets were not listed. */
  more: number;
  /** 020: `more` is a lower bound (Coinbase had more accounts than the portal reads). */
  moreIsAtLeast?: true;
  /** The exact sum of the listed values; absent when none has one. */
  total?: Money;
  /** Codes of listed assets with no value from Coinbase. */
  leftOutOfTotal: string[];
}

/** The balances route: figures, or why there are none. */
export type BalancesAnswer = PlatformBalances | { status: "reconnect" } | { status: "unreadable" };

export type DisplayState = "active" | "paused" | "removed" | "expired" | "disabled";

export interface Policy {
  policyId: string;
  name: string;
  version: number;
  values: PolicyValues;
  state: "active" | "paused" | "removed";
  displayState: DisplayState;
  expired: boolean;
  limitedByPlatform: string[];
  unlistedSellers: string[];
  updatedAt: string;
  history?: PolicyVersion[];
}

export interface Issue {
  field: string;
  code: string;
  host?: string;
  policyId?: string;
  limitAtomic?: string;
  limit?: number;
}

/** What a person types into the policy editor. Amounts are USDC text, exactly as typed. */
export interface PolicyInput {
  name: string;
  sellers: string[];
  autoApproveUsdc: string;
  perPaymentUsdc: string;
  perRunUsdc: string;
  perDayUsdc: string;
  paymentsPerMinute: number;
  endsOn: string;
  paymentMethod: "crypto_account";
}

// ---------------------------------------------------------------------------
// 014 the administration area (specs/014 contracts/portal-api.md "Administration routes")
// ---------------------------------------------------------------------------

/** One payment waiting for a person. A user is shown by identifier only, never by name (FR-009). */
export interface AdminEscalation {
  authorizationId: string;
  referenceCode: string;
  owner: { userId?: string; platformAccount: boolean };
  /** The payment is the signed-in administrator's own: they can see it and can't decide it. */
  mine: boolean;
  resourceKey: string;
  payTo: string;
  amountAtomic: string;
  createdAt: string;
  expiresAt: string;
  /** The state of the approver's phone request, when backchannel approval is on. */
  approvalRequest?: string;
}

export type EscalationState = "pending" | "approved" | "denied" | "expired";

/** A payment in any state, with how it ended and the budget it counts against. `readAt` is the portal's clock at the read. */
export interface AdminEscalationDetail extends AdminEscalation {
  state: EscalationState;
  decision?: EscalationDecision;
  budget: EscalationBudget;
  readAt: string;
}

/** One step in an escalation's life. `operator` and `reason` are text an operator typed: shown as text only. */
export type AdminEvent = Omit<EscalationEvent, "sessionId"> & { mine: boolean };

export interface AdminEventPage {
  events: AdminEvent[];
  first: number;
  last: number;
  cursor: number;
  more: boolean;
}

export type AdminLedgerCheck = LedgerCheck & { checkedAt: string };
