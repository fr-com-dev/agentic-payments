// 013 shared helpers: the user identifier and USDC parsing (specs/013 data-model.md "Identifiers", FR-025, FR-046).
import { describe, expect, it } from "vitest";
import { formatAtomic, parseUsdc } from "../src/shared/config.js";
import { USER_ID_RE, userIdFor } from "../src/shared/user-id.js";

describe("013 shared userIdFor", () => {
  it("is deterministic and matches the identifier pattern", () => {
    const id = userIdFor("dev", "alice");
    expect(id).toBe(userIdFor("dev", "alice"));
    expect(id).toMatch(USER_ID_RE);
  });

  it("pins one vector, so the hosted agent and the portal can never drift apart", () => {
    expect(userIdFor("dev", "alice")).toBe("usr_deeee4478bc01dab1b0afa3fbe31f010");
  });

  it("differs for another tenant or another object ID", () => {
    const base = userIdFor("dev", "alice");
    expect(userIdFor("dev", "bob")).not.toBe(base);
    expect(userIdFor("other", "alice")).not.toBe(base);
  });

  it("refuses an empty value or one holding the separator, so two pairs never share an input", () => {
    for (const [tid, oid] of [["a|b", "c"], ["a", "b|c"], ["", "c"], ["a", ""]] as const) {
      expect(() => userIdFor(tid, oid)).toThrow(/non-empty and free of/);
    }
  });

  it("reveals neither input", () => {
    const id = userIdFor("contoso-tenant", "ana.perez");
    expect(id).not.toContain("contoso");
    expect(id).not.toContain("ana");
  });
});

describe("013 shared parseUsdc", () => {
  const ok: Array<[string, string]> = [
    ["0.02", "20000"],
    ["1", "1000000"],
    ["0.000001", "1"],
    ["0", "0"],
    ["0.5", "500000"],
    ["  0.10 ", "100000"],
    ["007.5", "7500000"],
    ["12345678901234567890.123456", "12345678901234567890123456"],
  ];
  for (const [text, atomic] of ok) {
    it(`parses ${JSON.stringify(text)} as ${atomic}`, () => {
      expect(parseUsdc(text, 6)).toBe(atomic);
    });
  }

  it("refuses a seventh decimal instead of rounding (FR-025)", () => {
    expect(parseUsdc("0.0000001", 6)).toEqual({ error: "too_many_decimals" });
    expect(parseUsdc("0.0200009", 6)).toEqual({ error: "too_many_decimals" });
  });

  it("refuses a negative value", () => {
    expect(parseUsdc("-1", 6)).toEqual({ error: "negative" });
    expect(parseUsdc("-0.5", 6)).toEqual({ error: "negative" });
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const text of ["", " ", "abc", "1e3", "1,5", ".5", "5.", "0x10", "1 000", "+1", "NaN", "Infinity"]) {
      expect(parseUsdc(text, 6), text).toEqual({ error: "not_a_number" });
    }
  });

  it("round-trips with formatAtomic", () => {
    for (const atomic of ["0", "1", "20000", "100000", "500000", "1000000", "123456789"]) {
      expect(parseUsdc(formatAtomic(atomic, 6), 6)).toBe(atomic);
    }
  });
});
