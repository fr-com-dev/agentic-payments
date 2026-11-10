// T-WEB-03 (specs/013 FR-025, Constitution VI): amounts in the browser are atomic-unit strings; a seventh decimal is
// refused, never rounded; nothing in the web app does floating-point arithmetic on an amount.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUsdc } from "../../../src/shared/config.js";
import { formatUsdc, formatUsdcFixed, lessThan, parseUsdcInput } from "../src/money.js";

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
