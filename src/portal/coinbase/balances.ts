// 020 Coinbase accounts → what the wallet shows (SPEC.md §8.2 L2-8; specs/020 data-model.md "Balances", research R7).
// Pure: no I/O, time is an argument. Every figure stays a decimal string (Constitution VI): amounts exactly as Coinbase
// reports them, each value the amount at Coinbase's own USD rate rounded half to even to the cent, the total the exact
// sum of the values shown. Anything Coinbase sends that doesn't fit is dropped, never guessed (FR-013).
import { addDecimal, compareDecimal, divideRounded, isZeroDecimal, parseDecimal } from "../../shared/decimal.js";
import type { RawAccount } from "./client.js";

export const MAX_ASSETS = 200;
export const NAME_MAX = 60;
const CODE_RE = /^[A-Za-z0-9._-]{1,16}$/;
const TYPES = new Set(["wallet", "fiat", "vault"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export interface Money {
  amount: string;
  currency: "USD";
}

export interface PlatformAsset {
  code: string;
  name: string;
  amount: string;
  value?: Money;
}

export interface PlatformBalances {
  readAt: string;
  stale: boolean;
  assets: PlatformAsset[];
  more: number;
  /** Coinbase had more than the 10 pages read: `more` counts only what was read, so it is a lower bound (review 3). */
  moreIsAtLeast?: true;
  total?: Money;
  leftOutOfTotal: string[];
}

export interface BalancesInput {
  accounts: readonly RawAccount[];
  /** Coinbase's USD rates (code → units one dollar buys). Absent: no values and no total. */
  rates?: ReadonlyMap<string, string>;
  readAt: string;
  /** More than the 10 pages were there: `more` counts what was read. */
  truncated?: boolean;
}

export interface BalancesResult {
  balances: PlatformBalances;
  /** How many accounts were dropped because a figure didn't fit (logged `coinbase_bad_amount`, no value). */
  badAmounts: number;
}

export function toPlatformBalances(input: BalancesInput): BalancesResult {
  const funded: PlatformAsset[] = [];
  let badAmounts = 0;
  for (const a of input.accounts) {
    if (typeof a.type !== "string" || !TYPES.has(a.type)) continue;
    if (typeof a.code !== "string" || !CODE_RE.test(a.code)) continue;
    if (typeof a.amount !== "string" || parseDecimal(a.amount) === undefined || a.balanceCurrency !== a.code) {
      badAmounts++;
      continue;
    }
    if (isZeroDecimal(a.amount)) continue;
    const name = typeof a.name === "string" ? a.name.replace(CONTROL_CHARS, "").slice(0, NAME_MAX) : a.code;
    const value = valueOf(a.code, a.amount, input.rates);
    funded.push({ code: a.code, name: name === "" ? a.code : name, amount: a.amount, ...(value !== undefined && { value: { amount: value, currency: "USD" } }) });
  }
  // Largest value first; an asset with no value after every valued one; then by code.
  funded.sort((x, y) => {
    if (x.value && y.value) {
      const c = compareDecimal(y.value.amount, x.value.amount);
      if (c !== 0) return c;
    } else if (x.value || y.value) return x.value ? -1 : 1;
    return x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
  });
  const assets = funded.slice(0, MAX_ASSETS);
  const valued = assets.filter((a) => a.value !== undefined);
  return {
    badAmounts,
    balances: {
      readAt: input.readAt,
      stale: false,
      assets,
      more: funded.length - assets.length,
      ...(input.truncated === true && { moreIsAtLeast: true as const }),
      ...(valued.length > 0 && { total: { amount: addDecimal(valued.map((a) => a.value!.amount)), currency: "USD" as const } }),
      leftOutOfTotal: assets.filter((a) => a.value === undefined).map((a) => a.code),
    },
  };
}

/** The amount in US dollars, to the cent; undefined without a positive rate (or rates at all). */
function valueOf(code: string, amount: string, rates: ReadonlyMap<string, string> | undefined): string | undefined {
  if (!rates) return undefined;
  if (code === "USD") return divideRounded(amount, "1", 2);
  const rate = rates.get(code);
  if (rate === undefined || parseDecimal(rate) === undefined) return undefined;
  return divideRounded(amount, rate, 2);
}
