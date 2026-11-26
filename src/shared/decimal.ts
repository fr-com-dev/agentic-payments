// 020 exact decimal strings (specs/020 research R11, data-model.md "Balances"; Constitution VI). Pure: no I/O. Every
// value is a string, scaled to a BigInt for the arithmetic and written back as a string: floating-point numbers are
// never used (T-DEC-03 checks the source). Used for the balances an outside platform reports, which come with their
// own number of decimal places and are shown exactly as reported.

/** At most 30 digits on each side of the point, an optional minus sign, nothing else. */
const DECIMAL_RE = /^-?[0-9]{1,30}(\.[0-9]{1,30})?$/;

/** A decimal as an integer and its number of places: `units / 10^scale`. */
export interface ScaledDecimal {
  units: bigint;
  scale: number;
}

/** The scaled value of a decimal string, or undefined if it isn't one. */
export function parseDecimal(v: unknown): ScaledDecimal | undefined {
  if (typeof v !== "string" || !DECIMAL_RE.test(v)) return undefined;
  const negative = v.startsWith("-");
  const body = negative ? v.slice(1) : v;
  const [whole, fraction = ""] = body.split(".") as [string, string?];
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);

/** The same value at a larger scale. */
function rescale(d: ScaledDecimal, scale: number): bigint {
  return d.units * pow10(scale - d.scale);
}

/** A scaled value written back, with exactly `scale` places. */
export function formatScaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative && units !== 0n ? "-" : ""}${whole}${fraction}`;
}

/** True for a decimal string equal to zero ("0", "0.000", "-0.0"). */
export function isZeroDecimal(v: string): boolean {
  const d = parseDecimal(v);
  return d !== undefined && d.units === 0n;
}

/** -1, 0 or 1. Both must be decimal strings. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) throw new Error("not a decimal string");
  const scale = x.scale > y.scale ? x.scale : y.scale;
  const p = rescale(x, scale);
  const q = rescale(y, scale);
  return p < q ? -1 : p > q ? 1 : 0;
}

/** The exact sum, with as many places as the most precise term. `[]` is "0". */
export function addDecimal(values: readonly string[]): string {
  const parsed = values.map((v) => {
    const d = parseDecimal(v);
    if (!d) throw new Error("not a decimal string");
    return d;
  });
  const scale = parsed.reduce((m, d) => (d.scale > m ? d.scale : m), 0);
  const total = parsed.reduce((sum, d) => sum + rescale(d, scale), 0n);
  return formatScaled(total, scale);
}

/**
 * `amount / rate`, rounded half to even at `places`. Undefined when either isn't a decimal string or the rate isn't
 * above zero. Exact: the quotient is computed at `places` plus the remainder, then rounded once.
 */
export function divideRounded(amount: string, rate: string, places: number): string | undefined {
  const a = parseDecimal(amount);
  const r = parseDecimal(rate);
  if (!a || !r || r.units <= 0n) return undefined;
  // amount / rate = (a.units / 10^a.scale) / (r.units / 10^r.scale) = a.units * 10^r.scale / (r.units * 10^a.scale)
  // Scaled to `places`: multiply the numerator by 10^places.
  const numerator = a.units * pow10(r.scale + places);
  const denominator = r.units * pow10(a.scale);
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let q = n / denominator;
  const rem = n % denominator;
  const twice = rem * 2n;
  if (twice > denominator || (twice === denominator && q % 2n === 1n)) q += 1n;
  return formatScaled(negative ? -q : q, places);
}
