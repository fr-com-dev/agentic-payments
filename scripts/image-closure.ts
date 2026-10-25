// `tsx scripts/image-closure.ts <image> <outDir>`, after `npm run build`: what one container image ships
// (specs/011 research R14). Each layer has its own image, and the seller has the root Dockerfile's, so a
// process carries only its own code: the L1 image holds no signer, and the L2 and L3 images hold no agent
// framework.
//
// esbuild walks the import graph of the image's entry points in the TypeScript sources: static imports and
// literal dynamic imports, without the imports tsc drops because they're used only as types. A package the
// code resolves at run time instead (createRequire) must be in the image's `extraPackages`. The files must
// stay inside the image's folders, and the packages must be in package.json `dependencies`. The script then
// copies the compiled files to <outDir>/dist, writes <outDir>/package.json with only those packages, and
// writes <outDir>/dist/image-modules.json, the module list the Dockerfile imports once to prove nothing is
// missing.
//
// Exit codes: 0 written; 1 a file outside the image's folders, or a package not declared; 2 usage.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export type ImageName = "l1-agent" | "l2-control" | "l3-verifier" | "seller";

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
    entries: ["src/hosted-main.ts", "src/main.ts"],
    allowed: ["src/layer1-intent/", "src/shared/", "src/hosted-main.ts", "src/main.ts", "src/refusal.ts"],
  },
  // L2 and the operator job, whose scripts call L2's operator routes.
  "l2-control": {
    dockerfile: "docker/l2-control.Dockerfile",
    entries: ["src/layer2-control/service.ts", ...OPERATOR_SCRIPTS],
    allowed: ["src/layer2-control/", "src/shared/", ...OPERATOR_SCRIPTS],
    extraPackages: ["swagger-ui-dist"], // src/layer2-control/api-docs.ts
  },
  "l3-verifier": {
    dockerfile: "docker/l3-verifier.Dockerfile",
    entries: ["src/layer3-settlement/service.ts"],
    allowed: ["src/layer3-settlement/", "src/shared/"],
  },
  // The demo seller, the counterparty, not a layer.
  seller: {
    dockerfile: "Dockerfile",
    entries: ["src/counterparty/seller.ts"],
    allowed: ["src/counterparty/", "src/shared/"],
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
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown> & { dependencies: Record<string, string> };
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
  const wanted = new Set([...c.packages, ...(spec.extraPackages ?? [])]);
  const { devDependencies: _dev, scripts: _scripts, ...rest } = pkg;
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([k]) => wanted.has(k)));
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify({ ...rest, dependencies }, null, 2)}\n`);
  writeFileSync(join(outDir, "dist/image-modules.json"), `${JSON.stringify(modules)}\n`);
  console.log(`image-closure: ${name}: ${modules.length} modules; packages ${Object.keys(dependencies).join(", ")}`);
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
