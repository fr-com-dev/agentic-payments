// What the portal API returns (specs/013 contracts/portal-api.md), as the web app uses it. Amounts are always
// decimal strings of atomic units; nothing here is ever a floating-point number of money.
import type { PolicyValues, PolicyVersion } from "../../../src/shared/contracts.js";

export type { PolicyValues, PolicyVersion };

export interface Onboarding {
  profile: boolean;
  wallet: boolean;
  policy: boolean;
}

export interface Me {
  userId: string;
  enabled: boolean;
  onboarding: Onboarding;
  profile?: { displayName: string; contactEmail: string };
}

export interface Config {
  auth: { mode: "entra" | "dev"; tenantId: string; clientId: string; scope: string };
  network: string;
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
}

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
