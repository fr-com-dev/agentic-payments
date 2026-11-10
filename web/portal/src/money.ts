// Money in the browser (specs/013 FR-025, Constitution VI): amounts are atomic-unit strings, and every conversion
// goes through BigInt. A value with more decimals than the asset has is refused, never rounded. The rules and test
// vectors are the same as `parseUsdc` / `formatAtomic` in src/shared/config.ts (the server decides; this is for the
// form's immediate feedback).

export type AmountError = "not_a_number" | "too_many_decimals" | "negative";

/** USDC text → atomic string, or the reason it was refused. */
export function parseUsdcInput(text: string, decimals: number): string | { error: AmountError } {
  const t = text.trim();
  if (/^-\d+(\.\d+)?$/.test(t)) return { error: "negative" };
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return { error: "not_a_number" };
  const frac = m[2] ?? "";
  if (frac.length > decimals) return { error: "too_many_decimals" };
  return (BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

/** Atomic string → USDC text with no trailing zeros. An amount that is not atomic is shown as it is. */
export function formatUsdc(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) return atomic;
  const value = BigInt(atomic);
  const scale = 10n ** BigInt(decimals);
  const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const whole = (value / scale).toString();
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/** Like formatUsdc with at least two decimals, for reading amounts in sentences ("0.10 USDC"). */
export function formatUsdcFixed(atomic: string, decimals: number): string {
  const s = formatUsdc(atomic, decimals);
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const [whole, frac = ""] = s.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/** True when `a` is less than `b`; both atomic strings. */
export const lessThan = (a: string, b: string): boolean => BigInt(a) < BigInt(b);
