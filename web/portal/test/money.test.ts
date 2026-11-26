// T-WEB-03 (specs/013 FR-025, Constitution VI): amounts in the browser are atomic-unit strings; a seventh decimal is
// refused, never rounded; nothing in the web app does floating-point arithmetic on an amount.
// 020 T-WEB-18 (specs/020 FR-015): Coinbase's amounts and US dollar values are decimal strings, shown by inserting
// group separators and a currency sign into the string, never through a number.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUsdc } from "../../../src/shared/config.js";
import { formatDecimal, formatUsdc, formatUsdcFixed, lessThan, parseUsdcInput } from "../src/money.js";

const SRC = resolve(import.meta.dirname, "../src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

describe("T-WEB-03: money in the browser", () => {
  it("accepts up to six decimals exactly", () => {
    expect(parseUsdcInput("0.02", 6)).toBe("20000");
    expect(parseUsdcInput("0.000001", 6)).toBe("1");
    expect(parseUsdcInput("1", 6)).toBe("1000000");
    expect(parseUsdcInput("0", 6)).toBe("0");
    expect(parseUsdcInput(" 12.5 ", 6)).toBe("12500000");
    expect(parseUsdcInput("123456789012345678.123456", 6)).toBe("123456789012345678123456");
  });

  it("refuses a seventh decimal and never rounds", () => {
    expect(parseUsdcInput("0.0000001", 6)).toEqual({ error: "too_many_decimals" });
    expect(parseUsdcInput("0.0200009", 6)).toEqual({ error: "too_many_decimals" });
    expect(parseUsdcInput("0.1234567", 6)).toEqual({ error: "too_many_decimals" });
  });

  it("refuses what is not a plain amount", () => {
    for (const text of ["", " ", "abc", "1e3", "0x10", "1,5", ".5", "5.", "+1", "1 2", "NaN", "Infinity"]) {
      expect(parseUsdcInput(text, 6), text).toEqual({ error: "not_a_number" });
    }
    expect(parseUsdcInput("-1", 6)).toEqual({ error: "negative" });
    expect(parseUsdcInput("-0.5", 6)).toEqual({ error: "negative" });
  });

  it("agrees with the server's parser on every vector", () => {
    for (const text of ["0", "0.02", "0.000001", "0.0000001", "1", "12.5", "", "abc", "-1", ".5", "5.", "1e3", "00.10", "1.000000"]) {
      expect(parseUsdcInput(text, 6), text).toEqual(parseUsdc(text, 6));
    }
  });

  it("formats atomic amounts and round-trips", () => {
    expect(formatUsdc("20000", 6)).toBe("0.02");
    expect(formatUsdc("1", 6)).toBe("0.000001");
    expect(formatUsdc("1000000", 6)).toBe("1");
    expect(formatUsdc("0", 6)).toBe("0");
    expect(formatUsdcFixed("100000", 6)).toBe("0.10");
    expect(formatUsdcFixed("1000000", 6)).toBe("1.00");
    expect(formatUsdcFixed("20001", 6)).toBe("0.020001");
    // Larger than a double can hold exactly: still exact.
    expect(formatUsdc("9007199254740993000001", 6)).toBe("9007199254740993.000001");
    for (const atomic of ["0", "1", "20000", "999999", "1000000", "123456789", "9007199254740993000001"]) {
      expect(parseUsdcInput(formatUsdc(atomic, 6), 6)).toBe(atomic);
      expect(parseUsdcInput(formatUsdcFixed(atomic, 6), 6)).toBe(atomic);
    }
  });

  it("compares as integers, not as text or floats", () => {
    expect(lessThan("9", "10")).toBe(true);
    expect(lessThan("10", "9")).toBe(false);
    expect(lessThan("9007199254740992", "9007199254740993")).toBe(true);
  });

  it("no source file turns an amount into a floating-point number", () => {
    for (const file of files(SRC)) {
      const code = readFileSync(file, "utf8");
      expect(/parseFloat\(|\.toFixed\(|[^.\w]Number\(|Math\.round\(/.test(code), file).toBe(false);
    }
  });
});

describe("T-WEB-18: formatDecimal, Coinbase's figures as text (020 FR-013, FR-015)", () => {
  it("T-WEB-18 inserts group separators into the whole part, and leaves the fraction as it is", () => {
    expect(formatDecimal("0")).toBe("0");
    expect(formatDecimal("5")).toBe("5");
    expect(formatDecimal("999")).toBe("999");
    expect(formatDecimal("1000")).toBe("1,000");
    expect(formatDecimal("1000.5")).toBe("1,000.5");
    expect(formatDecimal("123456")).toBe("123,456");
    expect(formatDecimal("1234567.891")).toBe("1,234,567.891");
    expect(formatDecimal("0.00012345")).toBe("0.00012345");
    // Trailing zeros are Coinbase's: kept, never trimmed or padded.
    expect(formatDecimal("12.50000")).toBe("12.50000");
    expect(formatDecimal("-1234.5")).toBe("-1,234.5");
  });

  it("T-WEB-18 a dollar sign for US dollars, before the digits and after a minus", () => {
    expect(formatDecimal("12.34", "USD")).toBe("$12.34");
    expect(formatDecimal("0.00", "USD")).toBe("$0.00");
    expect(formatDecimal("4323000.49", "USD")).toBe("$4,323,000.49");
    expect(formatDecimal("-1234.56", "USD")).toBe("-$1,234.56");
  });

  it("T-WEB-18 exact for any length: 18 decimals and 30 digits, past what a double holds", () => {
    expect(formatDecimal("1234.123456789012345678")).toBe("1,234.123456789012345678");
    expect(formatDecimal("0.000000000000000001")).toBe("0.000000000000000001");
    expect(formatDecimal("123456789012345678901234567890.123456789012345678901234567890")).toBe(
      "123,456,789,012,345,678,901,234,567,890.123456789012345678901234567890",
    );
    expect(formatDecimal("9007199254740993", "USD")).toBe("$9,007,199,254,740,993");
  });

  it("T-WEB-18 anything that is not a plain decimal is shown as it came, with no sign added", () => {
    for (const text of ["", "abc", "1e3", "1,000", ".5", "5.", "+1", "NaN", "Infinity", " 12", "0x10"]) {
      expect(formatDecimal(text), text).toBe(text);
      expect(formatDecimal(text, "USD"), text).toBe(text);
    }
  });
});
