// `tsx scripts/audit-shipped.ts [--audit-level=<low|moderate|high|critical>]`: npm audit over what the container
// images install, not over the whole lockfile (T-IMG-02). A root `npm audit --omit=dev` can never pass: ganache, a
// development dependency, ships its own node_modules, which the lockfile records as extraneous and npm audits
// anyway. No image holds ganache: each one installs only the packages its import graph reaches
// (scripts/image-closure.ts), with the lockfile's versions and package.json's `overrides`.
//
// The script writes the union of those packages to a scratch package.json beside a copy of the lockfile, prunes the
// lockfile to that tree (`npm install --package-lock-only`, nothing downloaded) and runs `npm audit` there. It exits
// with npm audit's status: 0 when nothing at or above the level is found (high by default), 1 otherwise, 2 on usage.
// The deploy workflow runs it in step 1, so an advisory in a shipped package stops a deployment before the build.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closure, IMAGES, imageManifest, type Manifest } from "./image-closure.js";

const LEVELS = ["low", "moderate", "high", "critical"] as const;

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
  const level = arg?.slice("--audit-level=".length) ?? "high";
  if (!(LEVELS as readonly string[]).includes(level) || argv.some((a) => !a.startsWith("--audit-level="))) {
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
    return npm(["audit", "--omit=dev", `--audit-level=${level}`], dir, true);
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
