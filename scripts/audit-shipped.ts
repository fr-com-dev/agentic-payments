// `tsx scripts/audit-shipped.ts [--audit-level=<low|moderate|high|critical>]`: npm audit over what the container
// images install, not over the whole lockfile (T-IMG-02). A root `npm audit --omit=dev` can never pass: ganache, a
// development dependency, ships its own node_modules, which the lockfile records as extraneous and npm audits
// anyway. No image holds ganache: each one installs only the packages its import graph reaches
// (scripts/image-closure.ts), with the lockfile's versions and package.json's `overrides`.
//
// The script writes the union of those packages to a scratch package.json beside a copy of the lockfile, prunes the
// lockfile to that tree (`npm install --package-lock-only`, nothing downloaded) and runs `npm audit --json` there.
// It exits 0 when no advisory at or above the level is found (high by default), 1 otherwise, 2 on usage.
// The deploy workflow runs it in step 1, so an advisory in a shipped package stops a deployment before the build.
//
// SPEC 1.22.1: `AUDIT_EXCEPTIONS` lets one advisory through for one package, with a reason, until a date. An
// exception never covers a severity, a package's other advisories or another package, and it lasts at most
// `MAX_EXCEPTION_DAYS`. From its expiry on the script fails, whether or not the advisory is still reported, until
// the exception is removed or renewed with a new reason. Anything it can't read (no report, an advisory without
// an identifier, an unknown severity) fails the gate. SPEC 1.22.2 removed the one exception; the mechanism stays.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closure, IMAGES, imageManifest, type Manifest } from "./image-closure.js";

const LEVELS = ["low", "moderate", "high", "critical"] as const;
export type AuditLevel = (typeof LEVELS)[number];
/** npm audit's severities, lowest first. One it doesn't list here ranks above critical, so it always fails. */
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const rank = (severity: string) => (SEVERITIES.includes(severity) ? SEVERITIES.indexOf(severity) : SEVERITIES.length);

/** One advisory let through for one package until a date (SPEC 1.22.1). */
export interface AuditException {
  /** The GitHub advisory, as the end of its URL in npm audit's report. */
  advisory: string;
  /** The package npm audit reports the advisory on. */
  package: string;
  /** The day (UTC) it was added. */
  added: string;
  /** The first day (UTC) it no longer applies: from then on the gate fails until it is removed or renewed. */
  expires: string;
  reason: string;
}

export const MAX_EXCEPTION_DAYS = 31;

/**
 * None in force (SPEC 1.22.2): GitHub withdrew GHSA-fc5q-39xc-vjpf (picomatch), the one entry 1.22.1 added, on
 * 2026-11-18. A new entry needs its reason, a reach check like 1.22.1's and a SPEC amendment.
 */
export const AUDIT_EXCEPTIONS: readonly AuditException[] = [];

const DAY_MS = 86_400_000;
const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const dayMs = (day: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN);

/** What is wrong with an exception list: an empty array when every entry is well formed and short-lived. */
export function exceptionProblems(exceptions: readonly AuditException[]): string[] {
  const out: string[] = [];
  for (const e of exceptions) {
    const at = `the exception for ${e.advisory} (${e.package})`;
    const added = dayMs(e.added);
    const expires = dayMs(e.expires);
    if (!GHSA.test(e.advisory)) out.push(`${at} names no GitHub advisory`);
    if (e.package.trim() === "") out.push(`${at} names no package`);
    if (e.reason.trim() === "") out.push(`${at} gives no reason`);
    if (Number.isNaN(added) || Number.isNaN(expires)) out.push(`${at} needs an added and an expires day (YYYY-MM-DD)`);
    else if (expires <= added || expires - added > MAX_EXCEPTION_DAYS * DAY_MS) {
      out.push(`${at} must expire within ${MAX_EXCEPTION_DAYS} days of the day it was added`);
    }
  }
  const ids = exceptions.map((e) => `${e.advisory} ${e.package}`);
  if (new Set(ids).size !== ids.length) out.push("an advisory is excepted twice for the same package");
  return out;
}

interface Advisory {
  name?: unknown;
  title?: unknown;
  url?: unknown;
  severity?: unknown;
}

export interface AuditVerdict {
  ok: boolean;
  /** One line per advisory at or above the level, per exception and per problem, to print. */
  lines: string[];
}

/**
 * The gate's decision on `npm audit --json` output: every advisory at or above `level` fails it unless an exception
 * in force at `now` names that advisory and that package. A package that is vulnerable only through another one
 * (`via` a name) is judged by that one's advisories, where the report lists them.
 */
export function auditVerdict(report: unknown, level: AuditLevel, now: Date, exceptions: readonly AuditException[] = AUDIT_EXCEPTIONS): AuditVerdict {
  const lines: string[] = [];
  let ok = true;
  const fail = (line: string) => {
    ok = false;
    lines.push(`FAIL ${line}`);
  };
  for (const p of exceptionProblems(exceptions)) fail(p);
  for (const e of exceptions) {
    if (now.getTime() >= dayMs(e.expires)) fail(`the exception for ${e.advisory} (${e.package}) expired on ${e.expires}: take the fix, or renew it with a new reason and expiry`);
  }
  const vulnerabilities = (report as { vulnerabilities?: unknown } | null)?.vulnerabilities;
  if (typeof vulnerabilities !== "object" || vulnerabilities === null || Array.isArray(vulnerabilities)) {
    fail("npm audit gave no report of vulnerabilities");
    return { ok, lines };
  }
  const entries = vulnerabilities as Record<string, { severity?: unknown; via?: unknown }>;
  const inForce = exceptions.filter((e) => now.getTime() < dayMs(e.expires));
  const used = new Set<AuditException>();
  for (const [pkg, entry] of Object.entries(entries)) {
    const via = Array.isArray(entry.via) ? (entry.via as unknown[]) : [];
    if (via.length === 0 && rank(String(entry.severity)) >= rank(level)) fail(`${pkg}: ${String(entry.severity)}, with no advisory named`);
    for (const v of via) {
      if (typeof v === "string") {
        // Judged where `v` is listed; a name the report doesn't list can't be judged, so it fails the gate.
        if (!(v in entries) && rank(String(entry.severity)) >= rank(level)) fail(`${pkg}: ${String(entry.severity)} through ${v}, which the report doesn't list`);
        continue;
      }
      const a = v as Advisory;
      const severity = String(a.severity);
      if (rank(severity) < rank(level)) continue;
      const url = typeof a.url === "string" ? a.url : "";
      const id = url.split("/").pop() ?? "";
      const name = typeof a.name === "string" ? a.name : pkg;
      const what = `${name}: ${severity} ${id || "(no advisory identifier)"} ${typeof a.title === "string" ? a.title : ""}`.trimEnd();
      const exception = GHSA.test(id) ? inForce.find((e) => e.advisory === id && e.package === name && name === pkg) : undefined;
      if (exception === undefined) {
        fail(what);
        continue;
      }
      used.add(exception);
      lines.push(`let through until ${exception.expires} ${what}: ${exception.reason}`);
    }
  }
  for (const e of inForce) if (!used.has(e)) lines.push(`note: the exception for ${e.advisory} (${e.package}) matched nothing; remove it`);
  return { ok, lines };
}

/** Every package any image installs: each image's import graph and its run-time packages. Sorted. */
export async function shippedPackages(): Promise<string[]> {
  const all = new Set<string>();
  for (const spec of Object.values(IMAGES)) {
    const c = await closure(spec.entries);
    for (const p of [...c.packages, ...(spec.extraPackages ?? [])]) all.add(p);
  }
  return [...all].sort();
}

/** The manifest the audit runs on: package.json as an image installs it (`imageManifest`), `wanted` only. */
export function auditManifest(pkg: Manifest, wanted: readonly string[]): Manifest {
  return imageManifest(pkg, wanted);
}

function npm(args: string[], cwd: string, inherit: boolean): number {
  const r = spawnSync("npm", args, { cwd, stdio: inherit ? "inherit" : ["ignore", "ignore", "inherit"] });
  return r.status ?? 1;
}

async function main(argv: string[]): Promise<number> {
  const arg = argv.find((a) => a.startsWith("--audit-level="));
  const level = (arg?.slice("--audit-level=".length) ?? "high") as AuditLevel;
  if (!LEVELS.includes(level) || argv.some((a) => !a.startsWith("--audit-level="))) {
    console.error(`usage: tsx scripts/audit-shipped.ts [--audit-level=${LEVELS.join("|")}]`);
    return 2;
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
  const wanted = await shippedPackages();
  const dir = mkdtempSync(join(tmpdir(), "audit-shipped-"));
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(auditManifest(pkg, wanted), null, 2)}\n`);
    copyFileSync("package-lock.json", join(dir, "package-lock.json"));
    console.log(`audit-shipped: ${wanted.length} packages the images install: ${wanted.join(", ")}`);
    if (npm(["install", "--package-lock-only", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir, false) !== 0) {
      console.error("audit-shipped: npm could not prune the lockfile to the shipped packages");
      return 1;
    }
    // npm exits non-zero whenever it reports anything, so the verdict comes from the report alone.
    const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let report: unknown;
    try {
      report = JSON.parse(audit.stdout);
    } catch {
      report = undefined;
    }
    const verdict = auditVerdict(report, level, new Date());
    for (const line of verdict.lines) console.log(`audit-shipped: ${line}`);
    console.log(verdict.ok ? `audit-shipped: ok: no advisory at or above ${level} outside the exceptions` : "audit-shipped: failed (the FAIL lines above)");
    return verdict.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`audit-shipped: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
