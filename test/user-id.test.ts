// 013 shared helpers: the user identifier and USDC parsing (specs/013 data-model.md "Identifiers", FR-025, FR-046).
import { describe, expect, it } from "vitest";
import { formatAtomic, parseUsdc } from "../src/shared/config.js";
import { issuerHost, USER_ID_RE, userIdFor } from "../src/shared/user-id.js";

describe("013 shared userIdFor", () => {
  const TENANT = "https://x402-dev.eu.auth0.com/";

  it("is deterministic and matches the identifier pattern", () => {
    const id = userIdFor(TENANT, "auth0|6543210fedcba");
    expect(id).toBe(userIdFor(TENANT, "auth0|6543210fedcba"));
    expect(id).toMatch(USER_ID_RE);
  });

  it("pins the v2 vectors, so the hosted agent and the portal can never drift apart", () => {
    // sha256("x402-user-v2\n<issuer host>\n<sub>"), first 32 hex characters; worked out apart from the code.
    expect(userIdFor(TENANT, "auth0|6543210fedcba")).toBe("usr_0ff9ed6a6382b9be927c8d68e1734685");
    expect(userIdFor("urn:x402:dev-issuer", "dev|alice")).toBe("usr_e788b761935d1cdd2710436f6a033eed");
  });

  it("takes the issuer's host: the trailing slash and the letter case of the host don't make another person", () => {
    const base = userIdFor(TENANT, "auth0|abc");
    expect(userIdFor("https://x402-dev.eu.auth0.com", "auth0|abc")).toBe(base);
    expect(userIdFor("https://X402-Dev.EU.auth0.com/", "auth0|abc")).toBe(base);
    expect(issuerHost(TENANT)).toBe("x402-dev.eu.auth0.com");
    // Not a web address (the dev issuer): the whole value.
    expect(issuerHost("urn:x402:dev-issuer")).toBe("urn:x402:dev-issuer");
  });

  it("differs for another issuer or another subject", () => {
    const base = userIdFor(TENANT, "auth0|abc");
    expect(userIdFor(TENANT, "auth0|abd")).not.toBe(base);
    expect(userIdFor("https://other.eu.auth0.com/", "auth0|abc")).not.toBe(base);
    // The same subject text from another connection is another person.
    expect(userIdFor(TENANT, "google-oauth2|abc")).not.toBe(base);
  });

  it("accepts a subject that holds the old separator", () => {
    expect(userIdFor(TENANT, "auth0|a|b")).toMatch(USER_ID_RE);
    expect(userIdFor(TENANT, "auth0|a|b")).not.toBe(userIdFor(TENANT, "auth0|a"));
  });

  it("refuses an empty value or one holding a line break, so two pairs never share an input", () => {
    for (const [issuer, subject] of [["a\nb", "c"], ["a", "b\nc"], ["a", "b\rc"], ["", "c"], ["a", ""]] as const) {
      expect(() => userIdFor(issuer, subject)).toThrow(/non-empty and free of line breaks/);
    }
    // Without the rule these two pairs would hash the same text.
    expect(["x402-user-v2", "a", "b\nc"].join("\n")).toBe(["x402-user-v2", "a\nb", "c"].join("\n"));
  });

  it("no longer makes a v1 identifier", () => {
    // v1 was sha256("x402-user-v1|dev|alice"): nobody signs in as that user any more.
    expect(userIdFor("dev", "alice")).not.toBe("usr_deeee4478bc01dab1b0afa3fbe31f010");
  });

  it("reveals neither input", () => {
    const id = userIdFor("https://contoso.eu.auth0.com/", "auth0|ana.perez");
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
