// 020 exact decimal strings (specs/020 research R11, data-model.md "Balances"; Constitution VI). T-DEC-01..03.
import { describe, expect, it } from "vitest";
import { addDecimal, compareDecimal, divideRounded, isZeroDecimal, parseDecimal } from "../src/shared/decimal.js";

describe("T-DEC-01 parseDecimal accepts ^-?[0-9]{1,30}(\\.[0-9]{1,30})?$ only", () => {
  it("T-DEC-01 valid decimal strings parse; everything else is refused", () => {
    for (const ok of ["0", "1", "-1", "39.59000000", "0.000000000000000001", "123456789012345678901234567890.123456789012345678901234567890"]) {
      expect(parseDecimal(ok), ok).toBeDefined();
    }
    for (const bad of ["", "1.", ".5", "+1", "1e3", "0x10", " 1", "1 ", "1,000", "NaN", "Infinity", "--1", "1.2.3", "1234567890123456789012345678901", "1.1234567890123456789012345678901"]) {
      expect(parseDecimal(bad), bad).toBeUndefined();
    }
    expect(parseDecimal(12 as unknown)).toBeUndefined();
    expect(isZeroDecimal("0.00000000")).toBe(true);
    expect(isZeroDecimal("-0.0")).toBe(true);
    expect(isZeroDecimal("0.00000001")).toBe(false);
  });
});

describe("T-DEC-02 addDecimal and compareDecimal are exact", () => {
  it("T-DEC-02 sums of 18- and 30-decimal values lose nothing", () => {
    expect(addDecimal(["0.1", "0.2"])).toBe("0.3");
    expect(addDecimal(["0.000000000000000001", "0.000000000000000002"])).toBe("0.000000000000000003");
    expect(addDecimal(["1.000000000000000000000000000001", "2"])).toBe("3.000000000000000000000000000001");
    expect(addDecimal(["10.50", "-0.50"])).toBe("10.00");
    expect(addDecimal([])).toBe("0");
    expect(addDecimal(["12.34", "0.66"])).toBe("13.00");
    expect(compareDecimal("0.30", "0.3")).toBe(0);
    expect(compareDecimal("1.0000000000000000001", "1")).toBe(1);
    expect(compareDecimal("-2", "1")).toBe(-1);
  });
});

describe("T-DEC-03 divideRounded rounds half to even at the given places", () => {
  it("T-DEC-03 amount divided by a rate, to the cent", () => {
    // 1 USD buys 0.00001 BTC: 0.5 BTC is 50000.00 USD.
    expect(divideRounded("0.5", "0.00001", 2)).toBe("50000.00");
    // Exactly half a cent rounds to the even cent.
    expect(divideRounded("0.125", "1", 2)).toBe("0.12");
    expect(divideRounded("0.135", "1", 2)).toBe("0.14");
    expect(divideRounded("-0.125", "1", 2)).toBe("-0.12");
    // A tiny rate and an 18-decimal amount.
    expect(divideRounded("0.000000000000000001", "0.0000000105", 2)).toBe("0.00");
    expect(divideRounded("39.59", "0.0000105", 2)).toBe("3770476.19");
    // A third.
    expect(divideRounded("1", "3", 2)).toBe("0.33");
    expect(divideRounded("2", "3", 2)).toBe("0.67");
    expect(divideRounded("10", "1", 0)).toBe("10");
    // A zero or invalid rate has no value.
    expect(divideRounded("1", "0", 2)).toBeUndefined();
    expect(divideRounded("1", "0.000", 2)).toBeUndefined();
    expect(divideRounded("1", "abc", 2)).toBeUndefined();
    expect(divideRounded("1", "-2", 2)).toBeUndefined();
  });

  it("T-DEC-03 nothing passes through Number: the source has no Number(, parseFloat or Math.", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/shared/decimal.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/Number\(|parseFloat|parseInt|Math\./);
  });
});
