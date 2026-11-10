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

export type Rule = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9" | "A10" | "A11" | "A12";
export interface ArchViolation {
  rule: Rule;
  file: string;
  line: number;
  detail: string;
}

type Area = "shared" | "L1" | "L2" | "L3" | "CP" | "PORTAL" | "src-other" | "composition" | "outside";
// 013: the portal (src/portal/) is an area of its own, isolated like a layer: it imports only shared and itself.
const LAYERS: Area[] = ["L1", "L2", "L3", "CP", "PORTAL"];
const SIGNER = "src/layer2-control/signer.ts";

export function classify(path: string): Area {
  if (path.startsWith("src/shared/")) return "shared";
  if (path.startsWith("src/layer1-intent/")) return "L1";
  if (path.startsWith("src/layer2-control/")) return "L2";
  if (path.startsWith("src/layer3-settlement/")) return "L3";
  if (path.startsWith("src/counterparty/")) return "CP";
  if (path.startsWith("src/portal/")) return "PORTAL";
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

  // A4 (INV-4): L3 has no signing or write capability. 013: neither has the portal, which only reads balances.
  if (area === "L3" || area === "PORTAL") {
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
// A8 (009, SPEC v1.2 §4.1, SEC-10): the CDP API credential is confined to one file. Its scope is wider
// than checkFile's: src/**, scripts/** and env templates (test/** is exempt).
// ---------------------------------------------------------------------------

const A8_ALLOWED = new Set(["src/counterparty/cdp-facilitator.ts", "env/seller.env.example"]);
const A8_NAME = /\bCDP_API_KEY_(?:ID|SECRET)\b/;

export function checkCdpConfinement(path: string, source: string): ArchViolation[] {
  if (A8_ALLOWED.has(path)) return [];
  const template = /^env\/[^/]+\.env\.example$/.test(path);
  if (!template && !path.startsWith("src/") && !path.startsWith("scripts/")) return [];
  // In TS files comments cannot leak a value, so they are ignored; templates are checked whole.
  const text = template ? source : lex(source).noComments;
  const out: ArchViolation[] = [];
  for (const off of matches(text, A8_NAME)) {
    out.push({ rule: "A8", file: path, line: lineAt(source, off), detail: text.slice(off).match(/^\w+/)![0] });
  }
  if (!template) {
    for (const { spec, offset } of specifiers(text)) {
      if (spec.startsWith("@coinbase/cdp-sdk")) out.push({ rule: "A8", file: path, line: lineAt(source, offset), detail: spec });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A9 (012, SPEC v1.8 §4.1, FR-030): L2's Auth0 client credential is confined to one file, like A8. Same scope:
// src/**, scripts/** and env templates (test/** is exempt). CIBA_CLIENT_KEY_ID is not the credential.
// ---------------------------------------------------------------------------

const A9_ALLOWED = new Set(["src/layer2-control/ciba-client.ts", "env/l2-control.env.example"]);
const A9_NAME = /\bCIBA_CLIENT_(?:KEY|SECRET)\b/;

export function checkCibaConfinement(path: string, source: string): ArchViolation[] {
  if (A9_ALLOWED.has(path)) return [];
  const template = /^env\/[^/]+\.env\.example$/.test(path);
  if (!template && !path.startsWith("src/") && !path.startsWith("scripts/")) return [];
  const text = template ? source : lex(source).noComments;
  return matches(text, A9_NAME).map((off) => ({ rule: "A9" as const, file: path, line: lineAt(source, off), detail: text.slice(off).match(/^\w+/)![0] }));
}

// ---------------------------------------------------------------------------
// A10 (013, SPEC v1.10 §4.1, SEC-22): the card vault credential is confined to one file, like A8 and A9. Same scope:
// src/**, scripts/** and env templates (test/** is exempt). It also confines the vault's API host, so no other file
// can call it. CARD_VAULT_KEY_… names and the publishable key are not the credential.
// ---------------------------------------------------------------------------

const A10_ALLOWED = new Set(["src/portal/card-vault.ts", "env/portal.env.example"]);
const A10_NAME = /\bCARD_VAULT_KEY\b/;
const A10_HOST = /api\.stripe\.com/;

export function checkCardVaultConfinement(path: string, source: string): ArchViolation[] {
  if (A10_ALLOWED.has(path)) return [];
  const template = /^env\/[^/]+\.env\.example$/.test(path);
  if (!template && !path.startsWith("src/") && !path.startsWith("scripts/")) return [];
  const text = template ? source : lex(source).noComments;
  const out: ArchViolation[] = matches(text, A10_NAME).map((off) => ({ rule: "A10" as const, file: path, line: lineAt(source, off), detail: "CARD_VAULT_KEY" }));
  for (const off of matches(text, A10_HOST)) out.push({ rule: "A10", file: path, line: lineAt(source, off), detail: "api.stripe.com" });
  return out;
}

// ---------------------------------------------------------------------------
// A11 (013, SPEC v1.10 §4.1, INV-2): the user wallets' mnemonic is payment key material. Its name appears only where
// it is read (the signer), where it is refused (the portal's entry point), where the local development value is set
// (scripts/demo-lib.ts) and in L2's template. Same scope as A8.
// ---------------------------------------------------------------------------

const A11_ALLOWED = new Set(["src/layer2-control/signer.ts", "src/portal-main.ts", "scripts/demo-lib.ts", "env/l2-control.env.example"]);
const A11_NAME = /\bUSER_WALLET_MNEMONIC\b/;

export function checkMnemonicConfinement(path: string, source: string): ArchViolation[] {
  if (A11_ALLOWED.has(path)) return [];
  const template = /^env\/[^/]+\.env\.example$/.test(path);
  if (!template && !path.startsWith("src/") && !path.startsWith("scripts/")) return [];
  const text = template ? source : lex(source).noComments;
  return matches(text, A11_NAME).map((off) => ({ rule: "A11" as const, file: path, line: lineAt(source, off), detail: "USER_WALLET_MNEMONIC" }));
}

// ---------------------------------------------------------------------------
// A12 (013, SPEC v1.10 §4.1, INV-13, FR-006): role isolation around the portal. No agent, verifier or counterparty
// code names the portal's token; no portal code names the payer key or another role's token. src/** only.
// ---------------------------------------------------------------------------

const A12_PORTAL_TOKEN = /\bPORTAL_TOKEN\b/;
const A12_OTHERS = /\b(?:PAYER_PRIVATE_KEY|CONTROL_TOKEN|OPERATOR_TOKEN|SETTLEMENT_TOKEN|VERIFIER_TOKEN)\b/;

export function checkPortalIsolation(path: string, source: string): ArchViolation[] {
  const area = classify(path);
  const text = lex(source).noComments;
  const hits = (re: RegExp) => matches(text, re).map((off) => ({ rule: "A12" as const, file: path, line: lineAt(source, off), detail: text.slice(off).match(/^\w+/)![0] }));
  if (area === "L1" || area === "L3" || area === "CP") return hits(A12_PORTAL_TOKEN);
  if (area === "PORTAL") return hits(A12_OTHERS);
  return [];
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

  it("010 US5 L1 never references operator routes or the operator token (SEC-8, INV-13)", () => {
    // Both L1 entry points (011 adds src/hosted-main.ts, which builds the L1 port adapters).
    const l1Files = [...walk("src/layer1-intent"), "src/main.ts", "src/hosted-main.ts"];
    expect(l1Files.length).toBeGreaterThan(1);
    for (const f of l1Files) {
      // Comments may document the absence (ports-http.ts does); only code counts, as for A8.
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const needle of ["/v1/rejections", "/v1/approvals", "/v1/escalations", "OPERATOR_TOKEN"]) {
        expect(src.includes(needle), `${f} references ${needle}`).toBe(false);
      }
    }
  });
});

describe("011 US2 hosted agent service (SEC-8, INV-13)", () => {
  it("011 US2 the hosted root offers no operator path", () => {
    const files = [...walk("src/layer1-intent/hosted"), "src/hosted-main.ts"];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const needle of ["OPERATOR_TOKEN", "/v1/approvals", "/v1/rejections", "/v1/escalations", "/v1/ledger/verify", "operator"]) {
        expect(src.includes(needle), `${f} references ${needle}`).toBe(false);
      }
    }
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
    optional: ["ANTHROPIC_MODEL", "SESSION_ID", "SELLER_ALIAS_URL"],
  },
  "l1-hosted": {
    required: ["NETWORK", "SELLER_URL", "CONTROL_URL", "SETTLEMENT_URL", "CONTROL_TOKEN", "VERIFIER_TOKEN", "MODEL_PROVIDER", "AUTH_TENANT_ID", "AUTH_AUDIENCE", "SESSION_REF_SECRET"],
    optional: ["ANTHROPIC_MODEL", "ANTHROPIC_API_KEY", "FOUNDRY_BASE_URL", "AZURE_CLIENT_ID", "AUTH_JWKS_FILE", "AGENT_PORT", "AGENT_BIND_HOST", "TRUSTED_PROXY_HOPS", "API_DOCS", "PORTAL_CLIENT_ID"],
  },
  "l2-control": {
    required: ["NETWORK", "PAYER_PRIVATE_KEY", "ALLOWED_PAYEES", "ALLOWED_HOSTS", "CONTROL_TOKEN", "SETTLEMENT_TOKEN", "OPERATOR_TOKEN"],
    optional: [
      "CONTROL_PORT",
      "API_DOCS",
      // 012 backchannel approval (CFG-2)
      "CIBA_APPROVAL",
      "CIBA_ISSUER",
      "CIBA_CLIENT_ID",
      "CIBA_AUDIENCE",
      "CIBA_APPROVER",
      "CIBA_CLIENT_KEY",
      "CIBA_CLIENT_SECRET",
      "CIBA_CLIENT_KEY_ID",
      // 013 user accounts (CFG-2)
      "USER_ACCOUNTS",
      "PORTAL_TOKEN",
      "USER_WALLET_MNEMONIC",
      "PLATFORM_FILE",
      "PLATFORM_SELLERS",
    ],
  },
  "l3-verifier": {
    required: ["NETWORK", "CONTROL_URL", "VERIFIER_TOKEN", "SETTLEMENT_TOKEN"],
    optional: ["BASE_SEPOLIA_RPC_URL", "SETTLEMENT_PORT"],
  },
  seller: {
    required: ["NETWORK", "SELLER_PAY_TO"],
    optional: ["FACILITATOR", "FACILITATOR_URL", "SELLER_PORT", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "API_DOCS"],
  },
  facilitator: { required: ["NETWORK", "FACILITATOR_PRIVATE_KEY"], optional: ["FACILITATOR_PORT"] },
  operator: { required: ["CONTROL_URL", "OPERATOR_TOKEN"], optional: [] },
  // 013: the portal. No payment key, and no other role's token.
  portal: {
    required: ["NETWORK", "CONTROL_URL", "PORTAL_TOKEN", "AUTH_TENANT_ID", "AUTH_AUDIENCE", "PORTAL_CLIENT_ID"],
    optional: [
      "AUTH_JWKS_FILE",
      "PORTAL_SCOPE",
      "PROFILE_DIR",
      "PORTAL_WEB_ROOT",
      "CARD_VAULT",
      "CARD_VAULT_KEY",
      "CARD_VAULT_PUBLISHABLE_KEY",
      "BASE_SEPOLIA_RPC_URL",
      "PORTAL_PORT",
      "PORTAL_BIND_HOST",
      "TRUSTED_PROXY_HOPS",
      "API_DOCS",
    ],
  },
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
    if (/PRIVATE_KEY$|_SECRET$|_API_KEY$|_MNEMONIC$|^CARD_VAULT_KEY$/.test(e.key) && e.value !== "") errors.push(`${name}: ${e.key} must be empty in a template`);
  }
  if (name === "facilitator" && !entries.some((e) => e.key === "NETWORK" && e.value === "local")) {
    errors.push("facilitator: NETWORK must be local");
  }
  return errors;
}

describe("T-ARCH-ENV per-process env templates (US4)", () => {
  it("8 of 8 templates exist and match the CFG-2 matrix", () => {
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

  it("T-ARCH-A8 fixture trips A8, and no other rule catches it (must fail without the rule)", () => {
    const { path, source } = fixture(8);
    expect(checkFile(path, source)).toEqual([]);
    const violations = checkCdpConfinement(path, source);
    expect([...new Set(violations.map((v) => v.rule))]).toEqual(["A8"]);
    expect(violations.map((v) => v.detail).sort()).toEqual(["@coinbase/cdp-sdk/auth", "CDP_API_KEY_SECRET"]);
  });

  it("T-ARCH-A8 repository is clean: the CDP credential lives only in cdp-facilitator.ts and the seller template", () => {
    const templates = readdirSync("env")
      .filter((f) => f.endsWith(".env.example"))
      .map((f) => `env/${f}`);
    const files = [...walk("src"), ...walk("scripts"), ...templates];
    const violations = files.flatMap((f) => checkCdpConfinement(f, readFileSync(f, "utf8")));
    expect(violations.map(format)).toEqual([]);
    // The allowed files really hold it, so the rule is not vacuous.
    expect(checkCdpConfinement("src/layer3-settlement/x.ts", readFileSync("src/counterparty/cdp-facilitator.ts", "utf8")).length).toBeGreaterThan(0);
    expect(checkCdpConfinement("env/l2-control.env.example", readFileSync("env/seller.env.example", "utf8")).length).toBeGreaterThan(0);
  });

  it("T-ARCH-A8 comments in TS never trip it; any other template naming the variables does", () => {
    expect(checkCdpConfinement("scripts/x.ts", "// CDP_API_KEY_SECRET\nexport {};\n")).toEqual([]);
    expect(checkCdpConfinement("env/l1-agent.env.example", "# CDP_API_KEY_ID=\n").map((v) => v.rule)).toEqual(["A8"]);
    expect(checkCdpConfinement("test/x.test.ts", 'process.env.CDP_API_KEY_SECRET = "x";')).toEqual([]);
  });

  it("T-ARCH-A9 fixture trips A9, and no other rule catches it (must fail without the rule)", () => {
    const { path, source } = fixture(9);
    expect(checkFile(path, source)).toEqual([]);
    expect(checkCdpConfinement(path, source)).toEqual([]);
    const violations = checkCibaConfinement(path, source);
    expect(violations.map((v) => [v.rule, v.detail])).toEqual([["A9", "CIBA_CLIENT_KEY"]]);
  });

  it("T-ARCH-A9 repository is clean: the Auth0 credential lives only in ciba-client.ts and the L2 template", () => {
    const templates = readdirSync("env")
      .filter((f) => f.endsWith(".env.example"))
      .map((f) => `env/${f}`);
    const files = [...walk("src"), ...walk("scripts"), ...templates];
    const violations = files.flatMap((f) => checkCibaConfinement(f, readFileSync(f, "utf8")));
    expect(violations.map(format)).toEqual([]);
    // The allowed files really hold it, so the rule is not vacuous.
    expect(checkCibaConfinement("src/layer2-control/service.ts", readFileSync("src/layer2-control/ciba-client.ts", "utf8")).length).toBeGreaterThan(0);
    expect(checkCibaConfinement("env/l1-hosted.env.example", readFileSync("env/l2-control.env.example", "utf8")).length).toBeGreaterThan(0);
  });

  it("T-ARCH-A9 CIBA_CLIENT_KEY_ID never trips it; a comment never does; any other template naming CIBA_CLIENT_SECRET does", () => {
    expect(checkCibaConfinement("src/layer2-control/x.ts", 'export const k = process.env.CIBA_CLIENT_KEY_ID;\n')).toEqual([]);
    expect(checkCibaConfinement("scripts/x.ts", "// CIBA_CLIENT_SECRET\nexport {};\n")).toEqual([]);
    expect(checkCibaConfinement("env/operator.env.example", "# CIBA_CLIENT_SECRET=\n").map((v) => v.rule)).toEqual(["A9"]);
    expect(checkCibaConfinement("test/x.test.ts", 'process.env.CIBA_CLIENT_KEY = "x";')).toEqual([]);
  });

  // ---- 013: A10, A11, A12 and the portal as an area ---------------------------------------------------------

  const templates = () =>
    readdirSync("env")
      .filter((f) => f.endsWith(".env.example"))
      .map((f) => `env/${f}`);
  const scoped = () => [...walk("src"), ...walk("scripts"), ...templates()];
  const other13 = (path: string, source: string) => [
    ...checkFile(path, source),
    ...checkCdpConfinement(path, source),
    ...checkCibaConfinement(path, source),
  ];

  it("T-ARCH-A10 fixture trips A10 for the key and for the vault's host, and no other rule catches it", () => {
    const { path, source } = fixture(10);
    expect(other13(path, source)).toEqual([]);
    expect([...checkMnemonicConfinement(path, source), ...checkPortalIsolation(path, source)]).toEqual([]);
    expect(checkCardVaultConfinement(path, source).map((v) => [v.rule, v.detail])).toEqual([
      ["A10", "CARD_VAULT_KEY"],
      ["A10", "api.stripe.com"],
    ]);
  });

  it("T-ARCH-A10 repository is clean: the card vault key and host live only in card-vault.ts and the portal template", () => {
    expect(scoped().flatMap((f) => checkCardVaultConfinement(f, readFileSync(f, "utf8"))).map(format)).toEqual([]);
    // Not vacuous: the allowed files really hold both.
    const vault = checkCardVaultConfinement("src/portal/server.ts", readFileSync("src/portal/card-vault.ts", "utf8")).map((v) => v.detail);
    expect(new Set(vault)).toEqual(new Set(["CARD_VAULT_KEY", "api.stripe.com"]));
    expect(checkCardVaultConfinement("env/l2-control.env.example", readFileSync("env/portal.env.example", "utf8")).length).toBeGreaterThan(0);
  });

  it("T-ARCH-A10 the publishable key and comments never trip it; any other template naming the key does", () => {
    expect(checkCardVaultConfinement("src/portal/config.ts", "export const k = env.CARD_VAULT_PUBLISHABLE_KEY;\n")).toEqual([]);
    expect(checkCardVaultConfinement("src/portal/x.ts", "// CARD_VAULT_KEY at api.stripe.com\nexport {};\n")).toEqual([]);
    expect(checkCardVaultConfinement("env/l1-hosted.env.example", "# CARD_VAULT_KEY=\n").map((v) => v.rule)).toEqual(["A10"]);
    expect(checkCardVaultConfinement("test/x.test.ts", 'process.env.CARD_VAULT_KEY = "x";')).toEqual([]);
  });

  it("T-ARCH-A11 fixture trips A11, and no other rule catches it", () => {
    const { path, source } = fixture(11);
    expect(other13(path, source)).toEqual([]);
    expect([...checkCardVaultConfinement(path, source), ...checkPortalIsolation(path, source)]).toEqual([]);
    expect(checkMnemonicConfinement(path, source).map((v) => [v.rule, v.detail])).toEqual([["A11", "USER_WALLET_MNEMONIC"]]);
  });

  it("T-ARCH-A11 repository is clean: the mnemonic's name lives only in the signer, the portal's refusal, the local dev value and L2's template", () => {
    expect(scoped().flatMap((f) => checkMnemonicConfinement(f, readFileSync(f, "utf8"))).map(format)).toEqual([]);
    for (const allowed of ["src/layer2-control/signer.ts", "src/portal-main.ts", "scripts/demo-lib.ts"]) {
      expect(checkMnemonicConfinement("src/layer2-control/service.ts", readFileSync(allowed, "utf8")).length, allowed).toBeGreaterThan(0);
    }
    expect(checkMnemonicConfinement("env/portal.env.example", readFileSync("env/l2-control.env.example", "utf8")).length).toBeGreaterThan(0);
  });

  it("T-ARCH-A12 fixture trips A12, and no other rule catches it", () => {
    const { path, source } = fixture(12);
    expect(other13(path, source)).toEqual([]);
    expect([...checkCardVaultConfinement(path, source), ...checkMnemonicConfinement(path, source)]).toEqual([]);
    expect(checkPortalIsolation(path, source).map((v) => [v.rule, v.detail])).toEqual([["A12", "CONTROL_TOKEN"]]);
  });

  it("T-ARCH-A12 repository is clean: no layer names the portal's token, and the portal names no other role's secret", () => {
    expect(walk("src").flatMap((f) => checkPortalIsolation(f, readFileSync(f, "utf8"))).map(format)).toEqual([]);
    expect(checkPortalIsolation("src/layer1-intent/x.ts", 'export const t = process.env["PORTAL_TOKEN"];').map((v) => v.rule)).toEqual(["A12"]);
    expect(checkPortalIsolation("src/layer3-settlement/x.ts", "tokenFor(PORTAL_TOKEN)").map((v) => v.rule)).toEqual(["A12"]);
    for (const name of ["PAYER_PRIVATE_KEY", "CONTROL_TOKEN", "OPERATOR_TOKEN", "SETTLEMENT_TOKEN", "VERIFIER_TOKEN"]) {
      expect(checkPortalIsolation("src/portal/x.ts", `export const v = env.${name};`).map((v) => v.detail), name).toEqual([name]);
    }
    // L2 verifies the portal's token, and shared config maps roles to variables: both may name it.
    expect(checkPortalIsolation("src/layer2-control/x.ts", "PORTAL_TOKEN")).toEqual([]);
    expect(checkPortalIsolation("src/shared/config.ts", readFileSync("src/shared/config.ts", "utf8"))).toEqual([]);
    expect(walk("src/portal").length).toBeGreaterThan(8);
  });

  it("T-ARCH-A1 and A4 cover the portal: it imports only shared and itself, no layer imports it, and it can't sign", () => {
    expect(checkFile("src/portal/x.ts", 'import { AuditLedger } from "../layer2-control/ledger.js";').map((v) => v.rule)).toEqual(["A1"]);
    expect(checkFile("src/portal/x.ts", 'import { requesterAuth } from "../layer1-intent/hosted/requester-auth.js";').map((v) => v.rule)).toEqual(["A1"]);
    expect(checkFile("src/layer2-control/x.ts", 'import { ProfileStore } from "../portal/profile-store.js";').map((v) => v.rule)).toEqual(["A1"]);
    expect(checkFile("src/layer1-intent/x.ts", 'import "../portal/server.js";').map((v) => v.rule)).toEqual(["A1"]);
    expect(checkFile("src/portal/x.ts", 'import { verifyEntraToken } from "../shared/entra-token.js";\nimport { x } from "./config.js";')).toEqual([]);
    for (const id of ["createWalletClient", "signTypedData", "writeContract", "sendTransaction"]) {
      expect(checkFile("src/portal/x.ts", `const y = ${id}({});`).map((v) => v.rule), id).toEqual(["A4"]);
    }
    expect(checkFile("src/portal/x.ts", 'import { mnemonicToAccount } from "viem/accounts";').map((v) => v.rule)).toEqual(["A3", "A3"]);
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
  // SEC-10 and SEC-11 were added by 009 (SPEC v1.2), SEC-12 by 010 (v1.3), SEC-13 by the API docs (v1.4),
  // SEC-14..16 by 011 (v1.5, hosted agent service), SEC-17..18 by 012 (v1.8, backchannel approval),
  // SEC-19..24 by 013 (v1.10, user accounts and the portal), SEC-25 by 012's convergence (v1.11, the Auth0 pipeline).
  const SEC_ROWS = Array.from({ length: 25 }, (_, i) => `SEC-${i + 1}`);
  it(`every ${SEC_ROWS[0]}..${SEC_ROWS.at(-1)} row names at least one test, and each named ID is a test title`, () => {
    const rows = matrixRows(readFileSync(THREAT_MATRIX, "utf8"));
    expect(rows.map((r) => r.sec)).toEqual(SEC_ROWS);
    expect(missingIds(rows, testTitles())).toEqual([]);
  });

  it("must-fail: a row naming a test that does not exist is reported", () => {
    const rows = matrixRows("| SEC-99 | x | y | 007 | T-NOPE-99, T-POL-* |\n| SEC-98 | x | y | 007 | none |");
    expect(missingIds(rows, testTitles())).toEqual(["SEC-99: T-NOPE-99", "SEC-98: no test named"]);
  });
});
