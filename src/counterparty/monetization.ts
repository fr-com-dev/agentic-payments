// The seller's monetization model (SPEC.md CP-1, v1.7), after Stripe's "What is API monetization?" Two of the
// article's models, combined as it suggests ("hybrid pricing"):
// - Freemium: discovery is free. The catalog costs nothing and stays up while payments can't be taken.
// - Pay-per-use, in tiers priced by the value of what a call returns ("price sensitive or high-value data higher").
// x402 has no accounts or contracts, so every paid call is a single purchase: the article's subscription, quota and
// enterprise-licensing models have no per-call form here, and the Enterprise tier is a large one-off purchase (bulk
// data), not a license.
//
//   tier          decorator     for                                   what an agent's L2 (default mandate) does
//   free          @Free         discovery; no payment                 nothing to authorize
//   pay-per-use   @PayPerUse    everyday data, cents or less a call   auto-approves
//   premium       @Premium      high-value data, priced higher        escalates to an operator (above auto-approve)
//   enterprise    @Enterprise   bulk data, a substantial price        denies (above the per-payment cap)
//
// Tiers are labels with a price, not policy: L2 decides from the price alone (INV-5), whatever the tier says.
import { declarePart } from "./endpoints.js";

export type Tier = "free" | "pay-per-use" | "premium" | "enterprise";
export const TIERS: readonly Tier[] = ["free", "pay-per-use", "premium", "enterprise"];
export type PaidTier = Exclude<Tier, "free">;

/** USDC has 6 decimals on every network profile (CFG-1); the seller refuses a profile that disagrees. */
export const USDC_DECIMALS = 6;

/** A price in USDC, as written (`usdc`) and in atomic units (`atomic`), the form x402 and L2 use. */
export interface Price {
  usdc: string;
  atomic: string;
}

/** `usdc("0.001")` → `{ usdc: "0.001", atomic: "1000" }`. BigInt math only (rule 8); positive, at most 6 decimals. */
export function usdc(amount: string): Price {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (m === null || (m[2] ?? "").length > USDC_DECIMALS) {
    throw new RangeError(`usdc("${amount}"): a decimal string with at most ${USDC_DECIMALS} decimals`);
  }
  const atomic = BigInt(m[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  if (atomic <= 0n) throw new RangeError(`usdc("${amount}"): a paid tier needs a price above zero; use @Free`);
  return { usdc: amount, atomic: atomic.toString() };
}

/** How an endpoint earns: free, or a paid tier with its per-call price. `description` is what the buyer sees. */
export type Monetization = { tier: "free"; description: string; price: null } | { tier: PaidTier; description: string; price: Price };

interface Paid {
  price: Price;
  description: string;
}

type Method = (this: unknown, ...args: never[]) => unknown;

function tier(monetization: Monetization) {
  if (monetization.description.trim() === "") throw new RangeError(`@${monetization.tier}: needs a description`);
  return <T extends Method>(method: T, context: ClassMethodDecoratorContext): T => {
    declarePart(method, context, { monetization });
    return method;
  };
}

/** Freemium entry: no payment. Mounted before the payment middleware, so it answers while payments can't be taken. */
export const Free = (description: string) => tier({ tier: "free", description, price: null });

/** Pay-per-use: everyday data, paid per call. */
export const PayPerUse = ({ price, description }: Paid) => tier({ tier: "pay-per-use", description, price });

/** Premium: high-value data, priced higher. */
export const Premium = ({ price, description }: Paid) => tier({ tier: "premium", description, price });

/** Enterprise: extensive access, bulk data, at a substantial per-call price. */
export const Enterprise = ({ price, description }: Paid) => tier({ tier: "enterprise", description, price });
