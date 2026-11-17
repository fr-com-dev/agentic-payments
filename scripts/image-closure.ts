// `tsx scripts/image-closure.ts <image> <outDir>`, after `npm run build`: what one container image ships
// (specs/011 research R14). Each layer has its own image, the operator job has its own, the portal (013) has its
// own, and the seller has the root Dockerfile's, so a process carries only its own code: the L1 image holds no
// signer, the L2 and L3 images hold no agent framework, the operator's holds only the operator scripts, and the
// portal's holds no layer at all. Each image is built, promoted and
// rolled back by its own pipeline (.github/workflows/deploy-<unit>.yml).
//
// esbuild walks the import graph of the image's entry points in the TypeScript sources: static imports and
// literal dynamic imports, without the imports tsc drops because they're used only as types. A package the
// code resolves at run time instead (createRequire) must be in the image's `extraPackages`. The files must
// stay inside the image's folders, and the packages must be in package.json `dependencies`. The script then
// copies the compiled files to <outDir>/dist, writes <outDir>/package.json with only those packages (and
// `overrides` with every `$name` written out as its range, which an image without that package can't resolve), and
// writes <outDir>/dist/image-modules.json, the module list the Dockerfile imports once to prove nothing is
// missing.
//
// Exit codes: 0 written; 1 a file outside the image's folders, or a package not declared; 2 usage.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export type ImageName = "l1-agent" | "l2-control" | "l3-verifier" | "operator" | "portal" | "seller";

export interface ImageSpec {
  /** Dockerfile that builds the image, from the repository root. */
  dockerfile: string;
  /** Source entry points. Each app or job in this image runs `node dist/<entry>.js`. */
  entries: string[];
  /** Folders (ending in `/`) and files the image's code may come from. */
  allowed: string[];
  /** Packages the code resolves at run time (see `Closure.resolved`), which the import graph can't see. */
  extraPackages?: string[];
}

const OPERATOR_SCRIPTS = ["scripts/approve.ts", "scripts/reject.ts", "scripts/escalations.ts", "scripts/ledger-verify.ts"];

export const IMAGES: Record<ImageName, ImageSpec> = {
  // The hosted agent service and the L1-4 regression job.
  "l1-agent": {
    dockerfile: "docker/l1-agent.Dockerfile",
    // src/smoke-main.ts (016): the smoke client, the pipeline's hosted smoke run as a job of this image.
    entries: ["src/hosted-main.ts", "src/main.ts", "src/smoke-main.ts"],
    // src/machine-caller/ (016): the machine caller's token, for the scripted regression and the smoke client.
    allowed: ["src/layer1-intent/", "src/shared/", "src/machine-caller/", "src/hosted-main.ts", "src/main.ts", "src/smoke-main.ts", "src/refusal.ts"],
    extraPackages: ["swagger-ui-dist"], // src/shared/api-docs.ts, with API_DOCS=1 (v1.6)
  },
  // L2, the control service and sole signer.
  "l2-control": {
    dockerfile: "docker/l2-control.Dockerfile",
    entries: ["src/layer2-control/service.ts"],
    allowed: ["src/layer2-control/", "src/shared/"],
    extraPackages: ["swagger-ui-dist"], // src/shared/api-docs.ts, with API_DOCS=1
  },
  "l3-verifier": {
    dockerfile: "docker/l3-verifier.Dockerfile",
    entries: ["src/layer3-settlement/service.ts"],
    allowed: ["src/layer3-settlement/", "src/shared/"],
  },
  // The operator job, whose scripts call L2's operator routes over HTTP: no L2 code, no signer.
  operator: {
    dockerfile: "docker/operator.Dockerfile",
    entries: OPERATOR_SCRIPTS,
    allowed: ["src/shared/", ...OPERATOR_SCRIPTS],
  },
  // 013: the portal, which serves the web app and calls L2's portal routes over HTTP: no layer's code, no signer.
  // The web app itself is not in this graph: Vite bundles it into dist/portal-web (docker/portal.Dockerfile).
  portal: {
    dockerfile: "docker/portal.Dockerfile",
    entries: ["src/portal-main.ts"],
    allowed: ["src/portal/", "src/shared/", "src/portal-main.ts"],
    extraPackages: ["swagger-ui-dist"], // src/shared/api-docs.ts, with API_DOCS=1
  },
  // The demo seller, the counterparty, not a layer.
  seller: {
    dockerfile: "Dockerfile",
    entries: ["src/counterparty/seller.ts"],
    allowed: ["src/counterparty/", "src/shared/"],
    extraPackages: ["swagger-ui-dist"], // src/shared/api-docs.ts, with API_DOCS=1 (v1.6)
  },
};

export interface Closure {
  /** Source files, sorted. */
  files: string[];
  /** Imported package names, sorted. */
  packages: string[];
  /** Packages named in `.resolve("pkg…")` in files that call `createRequire` or `import.meta.resolve`. */
  resolved: string[];
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export const packageName = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

export async function closure(entries: string[], root = process.cwd()): Promise<Closure> {
  const r = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outdir: "out", // required for several entries; nothing is written
    logLevel: "silent",
  });
  const packages = new Set<string>();
  for (const input of Object.values(r.metafile.inputs)) {
    for (const i of input.imports) if (i.external && !isBuiltin(i.path)) packages.add(packageName(i.path));
  }
  const files = Object.keys(r.metafile.inputs).sort();
  const resolved = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    if (!/createRequire\(|import\.meta\.resolve\(/.test(text)) continue;
    for (const m of text.matchAll(/\.resolve\(\s*[`'"]((?:@[\w-][\w.-]*\/)?[\w-][\w.-]*)/g)) if (!isBuiltin(m[1]!)) resolved.add(m[1]!);
  }
  return { files, packages: [...packages].sort(), resolved: [...resolved].sort() };
}

const inside = (allowed: string[], file: string) => allowed.some((a) => (a.endsWith("/") ? file.startsWith(a) : file === a));

export type Manifest = Record<string, unknown> & { dependencies: Record<string, string> };

const DIRECT = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * package.json's `overrides` with every `$name` (npm: "the range of my own direct dependency `name`") replaced by
 * that range. An image's package.json lists only the image's packages, so npm can't resolve `$zod` in an image
 * without zod: since 1.18 the L2 and seller images stopped at `npm error Unable to resolve reference $zod` (T-IMG-04).
 */
export function resolveOverrides(overrides: unknown, pkg: Manifest): unknown {
  if (typeof overrides === "string") {
    if (!overrides.startsWith("$")) return overrides;
    const name = overrides.slice(1);
    for (const field of DIRECT) {
      const range = (pkg[field] as Record<string, string> | undefined)?.[name];
      if (range !== undefined) return range;
    }
    throw new Error(`overrides: ${overrides} names no direct dependency of package.json`);
  }
  if (overrides !== null && typeof overrides === "object") {
    return Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, resolveOverrides(v, pkg)]));
  }
  return overrides;
}

/** package.json as an image installs it: `wanted` only, no dev dependencies or scripts, `overrides` resolved. */
export function imageManifest(pkg: Manifest, wanted: Iterable<string>): Manifest {
  const keep = new Set(wanted);
  const { devDependencies: _dev, scripts: _scripts, overrides, ...rest } = pkg;
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([k]) => keep.has(k)));
  return { ...rest, dependencies, ...(overrides === undefined ? {} : { overrides: resolveOverrides(overrides, pkg) }) };
}

/** One message per `$name` in a manifest's `overrides` that npm can't resolve from that manifest's own dependencies. */
export function overrideProblems(m: Manifest): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string" && v.startsWith("$") && !DIRECT.some((f) => (m[f] as Record<string, string> | undefined)?.[v.slice(1)] !== undefined)) {
      out.push(`overrides ${at}: ${v} is not a dependency of this package.json`);
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, at === "" ? k : `${at} > ${k}`);
    }
  };
  walk(m.overrides, "");
  return out;
}

/** One message per file outside the image's folders, unlisted run-time package and package missing from `dependencies`. */
export function problems(spec: ImageSpec, c: Closure, dependencies: Record<string, string>): string[] {
  const out: string[] = [];
  for (const f of c.files) if (!inside(spec.allowed, f)) out.push(`${f} is outside the image's folders`);
  for (const p of c.resolved) {
    if (!c.packages.includes(p) && !spec.extraPackages?.includes(p)) out.push(`${p} is resolved at run time but not in the image's extraPackages`);
  }
  for (const p of [...c.packages, ...(spec.extraPackages ?? [])]) if (!(p in dependencies)) out.push(`${p} is not in package.json dependencies`);
  return out;
}

async function main(name: string | undefined, outDir: string | undefined): Promise<number> {
  const spec = name === undefined ? undefined : IMAGES[name as ImageName];
  if (!spec || !outDir) {
    console.error(`usage: tsx scripts/image-closure.ts <${Object.keys(IMAGES).join("|")}> <outDir>`);
    return 2;
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
  const c = await closure(spec.entries);
  const found = problems(spec, c, pkg.dependencies);
  if (found.length > 0) {
    for (const m of found) console.error(`image-closure: ${name}: ${m}`);
    return 1;
  }
  const modules = c.files.map((f) => `dist/${f.replace(/\.ts$/, ".js")}`);
  for (const m of modules) {
    mkdirSync(dirname(join(outDir, m)), { recursive: true });
    copyFileSync(m, join(outDir, m));
  }
  const manifest = imageManifest(pkg, [...c.packages, ...(spec.extraPackages ?? [])]);
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outDir, "dist/image-modules.json"), `${JSON.stringify(modules)}\n`);
  console.log(`image-closure: ${name}: ${modules.length} modules; packages ${Object.keys(manifest.dependencies).join(", ")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv[3]).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`image-closure: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
