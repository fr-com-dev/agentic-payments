// Feature 007 — architecture rules A1–A7 (SPEC.md §4.1), T-ARCH-INV1..INV4 and T-ARCH-ENV.
//
// `checkFile(path, source)` is pure: no file-system or network I/O. The TypeScript 7 package ships no
// JS compiler API, so specifiers and identifiers are extracted with a small comment/string-aware lexer.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Scanner core (T004–T006)
// ---------------------------------------------------------------------------

export type Rule = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7";
export interface ArchViolation {
  rule: Rule;
  file: string;
  line: number;
  detail: string;
}

type Area = "shared" | "L1" | "L2" | "L3" | "CP" | "src-other" | "composition" | "outside";
const LAYERS: Area[] = ["L1", "L2", "L3", "CP"];
const SIGNER = "src/layer2-control/signer.ts";

export function classify(path: string): Area {
  if (path.startsWith("src/shared/")) return "shared";
  if (path.startsWith("src/layer1-intent/")) return "L1";
  if (path.startsWith("src/layer2-control/")) return "L2";
  if (path.startsWith("src/layer3-settlement/")) return "L3";
  if (path.startsWith("src/counterparty/")) return "CP";
  if (path.startsWith("src/")) return "src-other";
  if (path.startsWith("scripts/") || path.startsWith("test/")) return "composition";
  return "outside";
}

interface Lexed {
  /** Source with comments blanked (newlines kept). */
  noComments: string;
  /** Source with comments and string/template/regex contents blanked (delimiters kept). */
  codeOnly: string;
}

/** Blanks comments, and string contents for `codeOnly`, preserving every offset and newline. */
export function lex(src: string): Lexed {
  const nc = src.split("");
  const co = src.split("");
  const blank = (arr: string[], i: number) => {
    if (arr[i] !== "\n") arr[i] = " ";
  };
  let i = 0;
  let lastSignificant = "";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        blank(nc, i);
        blank(co, i);
        i++;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) {
        blank(nc, i);
        blank(co, i);
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          blank(co, i);
          i++;
        }
        if (i < src.length) blank(co, i);
        if (c !== "`" && src[i] === "\n") break;
        i++;
      }
      i++;
      lastSignificant = c;
      continue;
    }
    if (c === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant))) {
      // Regex literal.
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n" && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") {
          blank(co, i);
          i++;
        } else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        if (i < src.length) blank(co, i);
        i++;
      }
      i++;
      lastSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return { noComments: nc.join(""), codeOnly: co.join("") };
}

const lineAt = (src: string, offset: number) => src.slice(0, offset).split("\n").length;

interface Specifier {
  spec: string;
  offset: number;
}

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

function specifiers(noComments: string): Specifier[] {
  const out: Specifier[] = [];
  for (const re of IMPORT_PATTERNS) {
    for (const m of noComments.matchAll(re)) out.push({ spec: m[1]!, offset: m.index! });
  }
  return out;
}

function resolveSpec(fromPath: string, spec: string): string | null {
  if (spec.startsWith(".")) return posix.normalize(posix.join(posix.dirname(fromPath), spec));
  if (spec.startsWith("src/") || spec.startsWith("scripts/") || spec.startsWith("test/")) return posix.normalize(spec);
  return null; // package import
}

function matches(text: string, re: RegExp): number[] {
  return [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].map(
    (m) => m.index!,
  );
}

const A4_IDENTIFIERS = ["createWalletClient", "signTypedData", "writeContract", "sendTransaction", "privateKeyToAccount"];
const A6_BANNED_IMPORT = (s: string) =>
  s.startsWith("node:") ||
  s === "fs" ||
  s.startsWith("fs/") ||
  s === "http" ||
  s === "https" ||
  s === "express" ||
  s === "viem" ||
  s.startsWith("viem/") ||
  s.startsWith("@anthropic-ai/");
const A6_PATTERNS: Array<[RegExp, string]> = [
  [/\bDate\s*\.\s*now\b/, "Date.now"],
  [/\bnew\s+Date\s*\(\s*\)/, "new Date()"],
  [/\bfetch\s*\(/, "fetch("],
  [/\bMath\s*\.\s*random\b/, "Math.random"],
  [/\bconsole\s*\./, "console."],
  [/\bpurpose\b/, "purpose"],
];
const X402_HEADER = /PAYMENT-(REQUIRED|SIGNATURE|RESPONSE)/i;

/** Pure rule check of one file at a repository-relative (virtual) path. */
export function checkFile(path: string, source: string): ArchViolation[] {
  const area = classify(path);
  if (area === "outside" || area === "composition") return [];
  const { noComments, codeOnly } = lex(source);
  const out: ArchViolation[] = [];
  const add = (rule: Rule, offset: number, detail: string) =>
    out.push({ rule, file: path, line: lineAt(source, offset), detail });
  const specs = specifiers(noComments);

  // A1 (INV-1): a layer imports only shared and its own folder.
  if (LAYERS.includes(area)) {
    for (const { spec, offset } of specs) {
      const target = resolveSpec(path, spec);
      if (target === null) continue;
      const t = classify(target);
      if (t !== "shared" && t !== area) add("A1", offset, spec);
    }
  }

  // A2 (INV-1): shared never imports or re-exports layer or composition code.
  if (area === "shared") {
    for (const { spec, offset } of specs) {
      const target = resolveSpec(path, spec);
      if (target !== null && classify(target) !== "shared") add("A2", offset, spec);
    }
  }

  // A3 (INV-2): only the L2 signer turns key material into an account.
  if (path !== SIGNER) {
    for (const off of matches(codeOnly, /\b(?:privateKeyToAccount|mnemonicToAccount)\b/)) {
      add("A3", off, codeOnly.slice(off).match(/^\w+/)![0]);
    }
    for (const { spec, offset } of specs) if (spec === "viem/accounts") add("A3", offset, spec);
  }

  // A4 (INV-4): L3 has no signing or write capability.
  if (area === "L3") {
    for (const id of A4_IDENTIFIERS) {
      if (id === "privateKeyToAccount") continue; // already reported by A3 for every non-signer file
      for (const off of matches(codeOnly, new RegExp(`\\b${id}\\b`))) add("A4", off, id);
    }
  }

  // A5 (INV-3): L1 never references the payer key, as identifier or string.
  if (area === "L1") {
    for (const off of matches(noComments, /\bPAYER_PRIVATE_KEY\b/)) add("A5", off, "PAYER_PRIVATE_KEY");
  }

  // A6 (INV-5): policy.ts is pure.
  if (path === "src/layer2-control/policy.ts") {
    for (const { spec, offset } of specs) if (A6_BANNED_IMPORT(spec)) add("A6", offset, spec);
    for (const [re, detail] of A6_PATTERNS) for (const off of matches(codeOnly, re)) add("A6", off, detail);
  }

  // A7 (§10): no hand-rolled base64 in files that handle x402 headers.
  if (LAYERS.includes(area) || area === "shared") {
    if (X402_HEADER.test(noComments)) {
      for (const off of matches(codeOnly, /\bBuffer\s*\.\s*from\s*\(/)) {
        let depth = 0;
        let end = off;
        for (let j = noComments.indexOf("(", off); j < noComments.length; j++) {
          if (noComments[j] === "(") depth++;
          else if (noComments[j] === ")" && --depth === 0) {
            end = j;
            break;
          }
        }
        if (/["'`]base64(url)?["'`]/.test(noComments.slice(off, end + 1))) add("A7", off, 'Buffer.from(…, "base64")');
      }
      for (const off of matches(codeOnly, /\b(?:atob|btoa)\s*\(/)) add("A7", off, codeOnly.slice(off, off + 4));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Repository walk
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = posix.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const format = (v: ArchViolation) => `${v.rule} ${v.file}:${v.line} ${v.detail}`;

function fixture(n: number): { path: string; source: string } {
  const source = readFileSync(`test/fixtures/arch/a${n}-violation.ts`, "utf8");
  const path = source.match(/^\/\/ @virtual-path: (\S+)/)?.[1];
  if (!path) throw new Error(`fixture a${n} has no @virtual-path`);
  return { path, source };
}

describe("T-ARCH scanner on the real tree (T006)", () => {
  it("src/** has no architecture violations", () => {
    const violations = walk("src").flatMap((f) => checkFile(f, readFileSync(f, "utf8")));
    expect(violations.map(format)).toEqual([]);
  });
});

describe("T-ARCH-INV3 / T-ARCH-INV2 (US1)", () => {
  it("must-fail: the A5 fixture trips exactly A5", () => {
    const { path, source } = fixture(5);
    expect(checkFile(path, source).map((v) => v.rule)).toEqual(["A5"]);
  });

  it("must-fail: the A3 fixture trips exactly A3", () => {
    const { path, source } = fixture(3);
    expect(checkFile(path, source).map((v) => v.rule)).toEqual(["A3"]);
  });

  it("T-ARCH-INV2: key-to-account calls occur only in src/layer2-control/signer.ts", () => {
    const files = walk("src").filter((f) =>
      /\b(?:privateKeyToAccount|mnemonicToAccount)\b/.test(lex(readFileSync(f, "utf8")).codeOnly),
    );
    expect(files.filter((f) => f !== SIGNER)).toEqual([]);
    if (existsSync(SIGNER)) expect(files).toEqual([SIGNER]);
  });

  it("A5 also catches the key name as a string literal", () => {
    const v = checkFile("src/layer1-intent/y.ts", 'export const k = process.env["PAYER_PRIVATE_KEY"];');
    expect(v.map((x) => x.rule)).toEqual(["A5"]);
  });

  it("comments never trip a rule", () => {
    const src = "// privateKeyToAccount PAYER_PRIVATE_KEY Date.now()\n/* createWalletClient */\nexport {};\n";
    expect(checkFile("src/layer1-intent/z.ts", src)).toEqual([]);
    expect(checkFile("src/layer3-settlement/z.ts", src)).toEqual([]);
    expect(checkFile("src/layer2-control/policy.ts", src)).toEqual([]);
  });
});

describe("T-ARCH-INV1 / T-ARCH-INV4 and rules A2, A6, A7 (US2)", () => {
  for (const n of [1, 2, 4, 6, 7]) {
    it(`must-fail: the A${n} fixture trips exactly A${n}`, () => {
      const { path, source } = fixture(n);
      expect(checkFile(path, source).map((v) => v.rule)).toEqual([`A${n}`]);
    });
  }

  it("A1 allows shared and own-layer imports and packages", () => {
    const src = [
      'import type { PaymentIntent } from "../shared/contracts.js";',
      'import { x } from "./orchestrator.js";',
      'import { createPublicClient } from "viem";',
    ].join("\n");
    expect(checkFile("src/layer1-intent/agent.ts", src)).toEqual([]);
  });

  it("A1 reports file and line for a cross-layer import", () => {
    const v = checkFile("src/layer3-settlement/service.ts", '\n\nimport { AuditLedger } from "../layer2-control/ledger.js";');
    expect(v.map(format)).toEqual(["A1 src/layer3-settlement/service.ts:3 ../layer2-control/ledger.js"]);
  });

  it("A1 also catches dynamic imports and importing the composition root", () => {
    expect(checkFile("src/layer1-intent/a.ts", 'await import("../layer2-control/signer.js");').map((v) => v.rule)).toEqual([
      "A1",
    ]);
    expect(checkFile("src/counterparty/a.ts", 'import "../main.js";').map((v) => v.rule)).toEqual(["A1"]);
  });

  it("A6 bans I/O imports and the policy-only patterns", () => {
    const src = [
      'import { readFileSync } from "node:fs";',
      "const t = new Date();",
      "console.log(ctx.purpose);",
      "const r = Math.random();",
      'await fetch("x");',
    ].join("\n");
    const rules = checkFile("src/layer2-control/policy.ts", src).map((v) => v.detail);
    expect(rules.sort()).toEqual(["Math.random", "console.", "fetch(", "new Date()", "node:fs", "purpose"].sort());
    expect(checkFile("src/layer2-control/policy.ts", "const d = new Date(input.nowMs);")).toEqual([]);
  });

  it("A7 does not fire in files that never mention an x402 header", () => {
    expect(checkFile("src/layer1-intent/b.ts", 'Buffer.from(v, "base64");')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-ARCH-ENV (US4): per-process env templates (SPEC §3.3, CFG-2)
// ---------------------------------------------------------------------------

interface TemplateSpec {
  required: string[];
  optional: string[];
}

const TEMPLATES: Record<string, TemplateSpec> = {
  "l1-agent": {
    required: ["NETWORK", "ANTHROPIC_API_KEY", "SELLER_URL", "CONTROL_URL", "SETTLEMENT_URL", "CONTROL_TOKEN", "VERIFIER_TOKEN"],
    optional: ["ANTHROPIC_MODEL", "SESSION_ID"],
  },
  "l2-control": {
    required: ["NETWORK", "PAYER_PRIVATE_KEY", "ALLOWED_PAYEES", "ALLOWED_HOSTS", "CONTROL_TOKEN", "SETTLEMENT_TOKEN", "OPERATOR_TOKEN"],
    optional: ["CONTROL_PORT"],
  },
  "l3-verifier": {
    required: ["NETWORK", "CONTROL_URL", "VERIFIER_TOKEN", "SETTLEMENT_TOKEN"],
    optional: ["BASE_SEPOLIA_RPC_URL", "SETTLEMENT_PORT"],
  },
  seller: { required: ["NETWORK", "SELLER_PAY_TO"], optional: ["FACILITATOR_URL", "SELLER_PORT"] },
  facilitator: { required: ["NETWORK", "FACILITATOR_PRIVATE_KEY"], optional: ["FACILITATOR_PORT"] },
  operator: { required: ["CONTROL_URL", "OPERATOR_TOKEN"], optional: [] },
};

interface TemplateEntry {
  key: string;
  value: string;
  commented: boolean;
}

export function parseTemplate(text: string): TemplateEntry[] {
  const out: TemplateEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out.push({ key: m[2]!, value: m[3]!.trim(), commented: m[1] !== undefined });
  }
  return out;
}

export function checkTemplate(name: string, entries: TemplateEntry[]): string[] {
  const spec = TEMPLATES[name];
  if (!spec) return [`${name}: unknown template`];
  const errors: string[] = [];
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const e of entries) if (!allowed.has(e.key)) errors.push(`${name}: forbidden key ${e.key}`);
  for (const k of spec.required) {
    if (!entries.some((e) => e.key === k && !e.commented)) errors.push(`${name}: missing required key ${k}`);
  }
  for (const e of entries) {
    if (/PRIVATE_KEY$/.test(e.key) && e.value !== "") errors.push(`${name}: ${e.key} must be empty in a template`);
  }
  if (name === "facilitator" && !entries.some((e) => e.key === "NETWORK" && e.value === "local")) {
    errors.push("facilitator: NETWORK must be local");
  }
  return errors;
}

describe("T-ARCH-ENV per-process env templates (US4)", () => {
  it("6 of 6 templates exist and match the CFG-2 matrix", () => {
    const errors = Object.keys(TEMPLATES).flatMap((name) => {
      const file = `env/${name}.env.example`;
      if (!existsSync(file)) return [`${file} missing`];
      return checkTemplate(name, parseTemplate(readFileSync(file, "utf8")));
    });
    expect(errors).toEqual([]);
    expect(readdirSync("env").filter((f) => f.endsWith(".env.example")).sort()).toEqual(
      Object.keys(TEMPLATES).map((n) => `${n}.env.example`).sort(),
    );
  });

  it("must-fail: an l1-agent template holding PAYER_PRIVATE_KEY is rejected", () => {
    const good = parseTemplate(readFileSync("env/l1-agent.env.example", "utf8"));
    const errors = checkTemplate("l1-agent", [...good, { key: "PAYER_PRIVATE_KEY", value: "", commented: false }]);
    expect(errors).toEqual(["l1-agent: forbidden key PAYER_PRIVATE_KEY"]);
  });

  it("no root .env exists, and only src/shared/config.ts uses dotenv", () => {
    expect(existsSync(".env")).toBe(false);
    const users = [...walk("src"), ...walk("scripts")].filter((f) =>
      specifiers(lex(readFileSync(f, "utf8")).noComments).some((s) => s.spec === "dotenv" || s.spec.startsWith("dotenv/")),
    );
    expect(users).toEqual(["src/shared/config.ts"]);
  });
});

// ---------------------------------------------------------------------------
// T-ARCH-TRACE (007 T051): every test ID named in the threat matrix appears in a test title.
// ---------------------------------------------------------------------------
const THREAT_MATRIX = "specs/007-process-isolation-security/contracts/threat-matrix.md";

/** All describe/it/test titles under test/ (fixtures excluded). */
function testTitles(): string[] {
  const files = walk("test").filter((f) => f.endsWith(".test.ts") && !f.startsWith("test/fixtures/"));
  const re = /\b(?:describe|it|test)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
  return files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(re)].map((m) => m[2]!));
}

/** Test IDs per SEC row. `T-POL-*` is a prefix; "(A3, A5)" style notes and prose are ignored. */
function matrixRows(markdown: string): { sec: string; ids: string[] }[] {
  return markdown
    .split("\n")
    .filter((l) => /^\| SEC-\d+ \|/.test(l))
    .map((l) => {
      const cells = l.split("|").map((c) => c.trim());
      const ids = [...cells[5]!.matchAll(/T-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:-\*)?/g)].map((m) => m[0]);
      return { sec: cells[1]!, ids };
    });
}

function missingIds(rows: { sec: string; ids: string[] }[], titles: string[]): string[] {
  const has = (id: string) =>
    id.endsWith("-*")
      ? titles.some((t) => t.includes(id.slice(0, -1)))
      : titles.some((t) => new RegExp(`${id.replace(/[-]/g, "\\-")}(?![A-Za-z0-9])`).test(t));
  return rows.flatMap((r) => (r.ids.length === 0 ? [`${r.sec}: no test named`] : r.ids.filter((id) => !has(id)).map((id) => `${r.sec}: ${id}`)));
}

describe("T-ARCH-TRACE threat matrix → test titles (007 T051)", () => {
  it("every SEC-1..SEC-9 row names at least one test, and each named ID is a test title", () => {
    const rows = matrixRows(readFileSync(THREAT_MATRIX, "utf8"));
    expect(rows.map((r) => r.sec)).toEqual(["SEC-1", "SEC-2", "SEC-3", "SEC-4", "SEC-5", "SEC-6", "SEC-7", "SEC-8", "SEC-9"]);
    expect(missingIds(rows, testTitles())).toEqual([]);
  });

  it("must-fail: a row naming a test that does not exist is reported", () => {
    const rows = matrixRows("| SEC-99 | x | y | 007 | T-NOPE-99, T-POL-* |\n| SEC-98 | x | y | 007 | none |");
    expect(missingIds(rows, testTitles())).toEqual(["SEC-99: T-NOPE-99", "SEC-98: no test named"]);
  });
});
