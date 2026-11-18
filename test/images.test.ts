// T-IMG-01 per-layer images (specs/011 research R14; scripts/image-closure.ts). Each image's code is the
// import graph of its entry points, and it must stay inside its own layer: only the L2 image holds the
// signer, and only the L1 image holds the agent framework and the model SDKs. Every package must be a
// runtime dependency, including those resolved at run time. Each Dockerfile builds the image the table
// names, from the same pinned base. The Docker builds themselves run in the deploy workflow (step 3) and in
// quickstart §1, where each image also loads every module once. 013: the portal image holds only src/portal and
// src/shared: no layer, no seller, no agent package, and no web package (React and the others are bundled into
// dist/portal-web at build time, which its Dockerfile copies).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXCEPTIONS, auditManifest, auditVerdict, exceptionProblems, MAX_EXCEPTION_DAYS, shippedPackages, type AuditException } from "../scripts/audit-shipped.js";
import { IMAGES, closure, imageManifest, overrideProblems, problems, resolveOverrides, type Closure, type ImageName, type Manifest } from "../scripts/image-closure.js";

const DEPS = (JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> }).dependencies;
const NAMES = Object.keys(IMAGES) as ImageName[];
const SIGNER = "src/layer2-control/signer.ts";
const AGENT_PACKAGES = ["@mastra/core", "@ai-sdk/anthropic", "@anthropic-ai/sdk", "@azure/identity"];
/** 013: the folders the portal image may hold nothing of, and the web app's packages, which are build-time only. */
const NOT_IN_PORTAL = ["src/layer1-intent/", "src/layer2-control/", "src/layer3-settlement/", "src/counterparty/"];
const WEB_PACKAGES = ["react", "react-dom", "@auth0/auth0-spa-js", "vite"];

describe("T-IMG-01 per-layer images", { timeout: 30_000 }, () => {
  const closures = new Map<ImageName, Closure>();
  const holders = (has: (c: Closure) => boolean) => NAMES.filter((n) => has(closures.get(n)!));
  beforeAll(async () => {
    for (const n of NAMES) closures.set(n, await closure(IMAGES[n].entries));
  });

  it("T-IMG-01 each image's import graph stays inside its own folders and uses only runtime dependencies", () => {
    for (const n of NAMES) expect(problems(IMAGES[n], closures.get(n)!, DEPS), n).toEqual([]);
    for (const n of NAMES) for (const e of IMAGES[n].entries) expect(closures.get(n)!.files, n).toContain(e);
  });

  it("T-IMG-01 only the L2 image holds the signer (and any L2 code: not the operator's), and only the L1 image holds the agent framework and model SDKs", () => {
    expect(holders((c) => c.files.includes(SIGNER))).toEqual(["l2-control"]);
    expect(holders((c) => c.files.some((f) => f.startsWith("src/layer2-control/")))).toEqual(["l2-control"]);
    for (const p of AGENT_PACKAGES) expect(holders((c) => c.packages.includes(p)), p).toEqual(["l1-agent"]);
    expect(holders((c) => c.files.some((f) => f.startsWith("src/counterparty/")))).toEqual(["seller"]);
  });

  it("T-IMG-01 each Dockerfile builds its own image from the same pinned base, checks its modules and runs as node", () => {
    const bases = new Set<string>();
    for (const n of NAMES) {
      const text = readFileSync(IMAGES[n].dockerfile, "utf8");
      expect(text, n).toContain(`npx tsx scripts/image-closure.ts ${n} /out`);
      expect(text, n).toContain("readFileSync('dist/image-modules.json', 'utf8')");
      expect(text, n).toMatch(/\nUSER node\n$/);
      bases.add(/^ARG NODE_IMAGE=(\S+)$/m.exec(text)?.[1] ?? "");
    }
    expect([...bases]).toHaveLength(1);
    expect([...bases][0]).toMatch(/^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
  });

  it("T-IMG-01 013 the portal image holds no layer's or seller's file, none of the agent's packages and no web package; its Dockerfile builds and copies the web app and owns the profile mount", () => {
    const c = closures.get("portal")!;
    for (const folder of NOT_IN_PORTAL) expect(c.files.filter((f) => f.startsWith(folder)), folder).toEqual([]);
    expect(c.files.some((f) => f.startsWith("src/portal/"))).toBe(true);
    for (const p of [...AGENT_PACKAGES, ...WEB_PACKAGES]) expect([...c.packages, ...c.resolved], p).not.toContain(p);
    // The web packages are devDependencies: a runtime image, installed with --omit=dev, can't hold them.
    for (const p of WEB_PACKAGES) expect(Object.keys(DEPS), p).not.toContain(p);
    const text = readFileSync(IMAGES.portal.dockerfile, "utf8");
    expect(text).toContain("RUN npm run build && npm run build:web && npx tsx scripts/image-closure.ts portal /out\n");
    expect(text).toContain("COPY --from=build /app/dist/portal-web ./dist/portal-web\n");
    expect(text).toContain("COPY docs/portal.openapi.yaml ./dist/docs/\n");
    expect(text).toContain("RUN mkdir -p /app/.local/portal && chown node:node /app/.local/portal\n");
    // The build stage has the web app's sources; the runtime stage gets only its built files.
    expect(text.slice(0, text.indexOf("AS runtime"))).toContain("COPY web ./web\n");
    expect(text.slice(text.indexOf("AS runtime"))).not.toContain("COPY web");
  });

  it("T-IMG-01 013 must-fail: the portal reaching L2's code, or the agent's, through an import is reported", async () => {
    const l2 = await closure([...IMAGES.portal.entries, "src/layer2-control/service.ts"]);
    expect(problems(IMAGES.portal, l2, DEPS)).toContain(`${SIGNER} is outside the image's folders`);
    const l1 = await closure([...IMAGES.portal.entries, "src/hosted-main.ts"]);
    expect(problems(IMAGES.portal, l1, DEPS).some((m) => m.startsWith("src/layer1-intent/") && m.endsWith("is outside the image's folders"))).toBe(true);
    expect(AGENT_PACKAGES.filter((p) => l1.packages.includes(p))).toEqual(AGENT_PACKAGES);
  });

  it("T-IMG-01 must-fail: L1 reaching the signer through an import is reported", async () => {
    const c = await closure([...IMAGES["l1-agent"].entries, "src/layer2-control/service.ts"]);
    expect(problems(IMAGES["l1-agent"], c, DEPS)).toContain(`${SIGNER} is outside the image's folders`);
  });

  it("T-IMG-01 must-fail: a package resolved at run time but not listed is reported", () => {
    const c = closures.get("l2-control")!;
    expect(c.packages).not.toContain("swagger-ui-dist");
    expect(c.resolved).toEqual(["swagger-ui-dist"]);
    expect(problems({ ...IMAGES["l2-control"], extraPackages: [] }, c, DEPS)).toEqual([
      "swagger-ui-dist is resolved at run time but not in the image's extraPackages",
    ]);
  });

  it("T-IMG-01 must-fail: an imported package missing from dependencies is reported", () => {
    const { express: _express, ...rest } = DEPS;
    expect(problems(IMAGES["l3-verifier"], closures.get("l3-verifier")!, rest)).toContain("express is not in package.json dependencies");
  });
});

describe("T-IMG-02 the dependency audit covers what the images install", { timeout: 30_000 }, () => {
  const PKG = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown> & { dependencies: Record<string, string>; devDependencies: Record<string, string> };

  it("T-IMG-02 the audited set is the union of every image's packages: runtime dependencies only, never ganache", async () => {
    const shipped = await shippedPackages();
    const union = new Set<string>();
    for (const n of NAMES) {
      const c = await closure(IMAGES[n].entries);
      for (const p of [...c.packages, ...(IMAGES[n].extraPackages ?? [])]) union.add(p);
    }
    expect(shipped).toEqual([...union].sort());
    for (const p of shipped) expect(DEPS, p).toHaveProperty([p]);
    expect(shipped.filter((p) => p in PKG.devDependencies)).toEqual([]);
    expect(shipped).not.toContain("ganache");
  });

  it("T-IMG-02 the audit's manifest is package.json as an image sees it: overrides kept, no dev dependencies or scripts", () => {
    const m = auditManifest(PKG, ["express", "zod"]);
    expect(Object.keys(m.dependencies)).toEqual(["express", "zod"]);
    expect(m).not.toHaveProperty("devDependencies");
    expect(m).not.toHaveProperty("scripts");
    // The images install with the same overrides (image-closure writes them, T-IMG-04), so the audit must too.
    expect(m).toEqual(imageManifest(PKG, ["express", "zod"]));
    expect(m.overrides).toEqual({ "@coinbase/cdp-sdk": { zod: PKG.dependencies.zod } });
  });

  it("T-IMG-02 the deploy pipeline runs the audit before the typecheck, the builds and the suites", () => {
    expect(stepOne()).toEqual(["npm install --no-audit --no-fund", "npm run audit:shipped", "npm run typecheck", "npm run build", "npm run build:web", "npm test"]);
    expect((PKG.scripts as Record<string, string>)["audit:shipped"]).toBe("tsx scripts/audit-shipped.ts");
  });
});

// SPEC 1.22.1: one advisory for one package, until a date. The report below is npm audit's own (`--json`, 2026-11-17)
// for the shipped tree, trimmed: picomatch carries the advisory, and @mastra/core is vulnerable only through it.
const advisory = (name: string, id: string, severity: string, title = "an advisory") => ({ source: 1, name, dependency: name, title, url: `https://github.com/advisories/${id}`, severity, range: "*" });
const PICOMATCH = advisory("picomatch", "GHSA-fc5q-39xc-vjpf", "high", "picomatch vulnerable to ReDoS through single-branch repeated extglobs");
type Report = { vulnerabilities: Record<string, { name: string; severity: string; via: unknown[] }> };
const REPORT_2026_11_17 = (): Report => ({
  vulnerabilities: {
    "@mastra/core": { name: "@mastra/core", severity: "high", via: ["picomatch"] },
    picomatch: { name: "picomatch", severity: "high", via: [PICOMATCH] },
  },
});
const BEFORE_EXPIRY = new Date("2026-12-16T23:59:59Z");
const AT_EXPIRY = new Date("2026-12-17T00:00:00Z");

describe("T-IMG-02 the gate lets one advisory through, until its expiry", () => {
  it("T-IMG-02 the exceptions are well formed: one GitHub advisory, one package, a reason, at most 31 days", () => {
    expect(exceptionProblems(AUDIT_EXCEPTIONS)).toEqual([]);
    expect(MAX_EXCEPTION_DAYS).toBe(31);
    const picomatch = AUDIT_EXCEPTIONS.find((e) => e.advisory === "GHSA-fc5q-39xc-vjpf");
    expect(picomatch).toMatchObject({ package: "picomatch", added: "2026-11-17", expires: "2026-12-17" });
  });

  it("T-IMG-02 the report of 2026-11-17 passes: the picomatch advisory is let through, and @mastra/core is judged by it", () => {
    const v = auditVerdict(REPORT_2026_11_17(), "high", BEFORE_EXPIRY);
    expect(v.ok).toBe(true);
    expect(v.lines).toEqual([expect.stringMatching(/^let through until 2026-12-17 picomatch: high GHSA-fc5q-39xc-vjpf /)]);
    expect(auditVerdict({ vulnerabilities: {} }, "high", BEFORE_EXPIRY).ok).toBe(true);
  });

  it("T-IMG-02 must-fail: another advisory still fails the gate, on picomatch, on @mastra/core or on another package", () => {
    const onPicomatch = REPORT_2026_11_17();
    onPicomatch.vulnerabilities.picomatch!.via.push(advisory("picomatch", "GHSA-aaaa-bbbb-cccc", "high"));
    const onMastra = REPORT_2026_11_17();
    onMastra.vulnerabilities["@mastra/core"]!.via.push(advisory("@mastra/core", "GHSA-dddd-eeee-ffff", "critical"));
    const elsewhere = REPORT_2026_11_17();
    elsewhere.vulnerabilities.express = { name: "express", severity: "high", via: [advisory("express", "GHSA-gggg-hhhh-jjjj", "high")] };
    for (const [report, failing] of [
      [onPicomatch, "picomatch: high GHSA-aaaa-bbbb-cccc"],
      [onMastra, "@mastra/core: critical GHSA-dddd-eeee-ffff"],
      [elsewhere, "express: high GHSA-gggg-hhhh-jjjj"],
    ] as const) {
      const v = auditVerdict(report, "high", BEFORE_EXPIRY);
      expect(v.ok, failing).toBe(false);
      expect(v.lines.filter((l) => l.startsWith("FAIL "))).toEqual([expect.stringContaining(failing)]);
    }
  });

  it("T-IMG-02 must-fail: the excepted advisory reported on another package fails; below the level nothing does, as before", () => {
    const moved = REPORT_2026_11_17();
    moved.vulnerabilities.minimatch = { name: "minimatch", severity: "high", via: [advisory("minimatch", "GHSA-fc5q-39xc-vjpf", "high")] };
    expect(auditVerdict(moved, "high", BEFORE_EXPIRY).lines.filter((l) => l.startsWith("FAIL "))).toEqual([expect.stringContaining("minimatch: high GHSA-fc5q-39xc-vjpf")]);
    const moderate = REPORT_2026_11_17();
    moderate.vulnerabilities.jose = { name: "jose", severity: "moderate", via: [advisory("jose", "GHSA-kkkk-mmmm-nnnn", "moderate")] };
    expect(auditVerdict(moderate, "high", BEFORE_EXPIRY).ok).toBe(true);
    expect(auditVerdict(moderate, "moderate", BEFORE_EXPIRY).ok).toBe(false);
  });

  it("T-IMG-02 must-fail: from its expiry day the exception fails the gate, even once the advisory is gone", () => {
    for (const report of [REPORT_2026_11_17(), { vulnerabilities: {} }]) {
      const v = auditVerdict(report, "high", AT_EXPIRY);
      expect(v.ok).toBe(false);
      expect(v.lines).toContainEqual(expect.stringContaining("the exception for GHSA-fc5q-39xc-vjpf (picomatch) expired on 2026-12-17"));
    }
    // Past its expiry the advisory itself fails too: nothing lets it through any longer.
    expect(auditVerdict(REPORT_2026_11_17(), "high", AT_EXPIRY).lines).toContainEqual(expect.stringMatching(/^FAIL picomatch: high GHSA-fc5q-39xc-vjpf/));
  });

  it("T-IMG-02 must-fail: what the gate can't read fails it: no report, an advisory without an identifier, an unknown severity, an unlisted dependency", () => {
    for (const report of [undefined, null, {}, { error: { code: "ENOAUDIT" } }, { vulnerabilities: [] }]) {
      expect(auditVerdict(report, "high", BEFORE_EXPIRY).ok, JSON.stringify(report)).toBe(false);
    }
    const noId = { vulnerabilities: { x: { name: "x", severity: "high", via: [{ name: "x", severity: "high", title: "no url" }] } } };
    const unknownSeverity = { vulnerabilities: { x: { name: "x", severity: "severe", via: [{ ...advisory("x", "GHSA-pppp-qqqq-rrrr", "severe") }] } } };
    const unlisted = { vulnerabilities: { x: { name: "x", severity: "high", via: ["y"] } } };
    for (const report of [noId, unknownSeverity, unlisted]) expect(auditVerdict(report, "high", BEFORE_EXPIRY).ok, JSON.stringify(report)).toBe(false);
  });

  it("T-IMG-02 must-fail: a malformed or long-lived exception fails the gate", () => {
    const good = AUDIT_EXCEPTIONS[0]!;
    const bad: AuditException[] = [
      { ...good, expires: "2027-11-17" },
      { ...good, advisory: "CVE-2026-112366" },
      { ...good, reason: " " },
      { ...good, expires: "17/12/2026" },
      { ...good, expires: good.added },
    ];
    for (const e of bad) {
      expect(exceptionProblems([e]), JSON.stringify(e)).not.toEqual([]);
      expect(auditVerdict(REPORT_2026_11_17(), "high", BEFORE_EXPIRY, [e]).ok, JSON.stringify(e)).toBe(false);
    }
    expect(exceptionProblems([good, good])).toEqual(["an advisory is excepted twice for the same package"]);
    // Without the exception, the report of 2026-11-17 fails: the gate itself is unchanged.
    expect(auditVerdict(REPORT_2026_11_17(), "high", BEFORE_EXPIRY, []).ok).toBe(false);
  });
});

/** The commands of deploy.yml's step 1, which the pull request check runs too (T-CI-01), one per line. */
function stepOne(deploy = readFileSync(".github/workflows/deploy.yml", "utf8")): string[] {
  const run = deploy.match(/id: tests\n\s+run: \|\n((?:\s{10}.+\n)+)/)?.[1] ?? "";
  return run.trim().split("\n").map((l) => l.trim());
}

/** The npm scripts a Dockerfile's build stage runs (`RUN … npm run <script> …`), in order. */
export function buildStageScripts(dockerfile: string): string[] {
  const stage = dockerfile.split(/^FROM /m).find((s) => / AS build\n/.test(`${s.split("\n")[0]}\n`)) ?? "";
  return [...stage.matchAll(/^RUN .+$/gm)].flatMap((m) => [...m[0].matchAll(/\bnpm run ([\w:.-]+)/g)].map((r) => r[1]!));
}

/**
 * T-IMG-03: deploy.yml's step 1 runs every npm script an image's build stage runs, before the suites. Step 2 builds the
 * images, but the pull request check only runs step 1: without this a change that breaks only the build (a dependency's
 * new types, a web app that no longer bundles) merges green and fails at deployment.
 */
export function stepOneBuildProblems(dockerfiles: Record<string, string>, step1: string[]): string[] {
  const out = new Set<string>();
  const tests = step1.indexOf("npm test");
  for (const [file, text] of Object.entries(dockerfiles)) {
    for (const s of buildStageScripts(text)) {
      const at = step1.indexOf(`npm run ${s}`);
      if (at < 0 || at > tests) out.add(`${file}'s build stage runs npm run ${s}: deploy.yml's step 1 must run it before npm test`);
    }
  }
  return [...out];
}

describe("T-IMG-03 the deploy pipeline's step 1 runs the images' builds", () => {
  const dockerfiles = Object.fromEntries(NAMES.map((n) => [IMAGES[n].dockerfile, readFileSync(IMAGES[n].dockerfile, "utf8")]));

  it("T-IMG-03 every script an image's build stage runs is in step 1, before the suites", () => {
    expect(stepOneBuildProblems(dockerfiles, stepOne())).toEqual([]);
    // Not vacuous: every image builds its code, and the portal's also builds the web app.
    for (const n of NAMES) expect(buildStageScripts(dockerfiles[IMAGES[n].dockerfile]!), n).toEqual(n === "portal" ? ["build", "build:web"] : ["build"]);
  });

  it("T-IMG-03 must-fail: a build step 1 doesn't run, a build after the suites, or a script a build stage gained, is reported", () => {
    const portal = IMAGES.portal.dockerfile;
    const web = `${portal}'s build stage runs npm run build:web: deploy.yml's step 1 must run it before npm test`;
    expect(stepOneBuildProblems(dockerfiles, stepOne().filter((c) => c !== "npm run build:web"))).toEqual([web]);
    const late = stepOne().filter((c) => c !== "npm run build").concat("npm run build");
    expect(stepOneBuildProblems(dockerfiles, late)).toEqual(NAMES.map((n) => `${IMAGES[n].dockerfile}'s build stage runs npm run build: deploy.yml's step 1 must run it before npm test`));
    const gained = { ...dockerfiles, [portal]: dockerfiles[portal]!.replace("npm run build:web &&", "npm run build:web && npm run build:docs &&") };
    expect(gained[portal]).not.toBe(dockerfiles[portal]);
    expect(stepOneBuildProblems(gained, stepOne())).toEqual([`${portal}'s build stage runs npm run build:docs: deploy.yml's step 1 must run it before npm test`]);
    // A script the runtime stage runs is not a build.
    const runtime = { [portal]: `${dockerfiles[portal]!}RUN npm run build:docs\n` };
    expect(stepOneBuildProblems(runtime, stepOne())).toEqual([]);
  });
});

// T-IMG-04 (v1.22): each image's package.json installs. An image's package.json lists only the image's packages, so
// npm's `$name` in `overrides` ("my own dependency's range") can't resolve in an image without that package: from
// 1.18 to 1.21 the L2 and seller images stopped at `npm error Unable to resolve reference $zod`. image-closure writes
// every `$name` out as the root's range. Nothing here runs npm: the builds themselves run in deploy step 2.
describe("T-IMG-04 each image's package.json resolves its own overrides", { timeout: 30_000 }, () => {
  const PKG = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
  const wanted = new Map<ImageName, string[]>();
  beforeAll(async () => {
    for (const n of NAMES) {
      const c = await closure(IMAGES[n].entries);
      wanted.set(n, [...c.packages, ...(IMAGES[n].extraPackages ?? [])]);
    }
  });

  it("T-IMG-04 every image's manifest has no reference npm can't resolve, and cdp-sdk still gets the root's zod", () => {
    // Not vacuous: package.json has a `$` reference, and most images don't list the package it names.
    expect(JSON.stringify(PKG.overrides)).toContain('"$zod"');
    expect(NAMES.filter((n) => !wanted.get(n)!.includes("zod")).length).toBeGreaterThan(0);
    for (const n of NAMES) {
      const m = imageManifest(PKG, wanted.get(n)!);
      expect(overrideProblems(m), n).toEqual([]);
      expect(m.overrides, n).toEqual({ "@coinbase/cdp-sdk": { zod: PKG.dependencies.zod } });
      expect(Object.keys(m.dependencies).sort(), n).toEqual([...new Set(wanted.get(n)!)].sort());
    }
  });

  it("T-IMG-04 resolveOverrides writes out nested references, keeps plain ranges and refuses a reference to nothing", () => {
    const pkg: Manifest = { dependencies: { zod: "^4.6.7" }, devDependencies: { vitest: "^4.0.0" } };
    const o = { a: { zod: "$zod", ".": "1.2.3", b: { vitest: "$vitest" } }, c: "^2.0.0" };
    expect(resolveOverrides(o, pkg)).toEqual({ a: { zod: "^4.6.7", ".": "1.2.3", b: { vitest: "^4.0.0" } }, c: "^2.0.0" });
    expect(() => resolveOverrides({ a: "$nope" }, pkg)).toThrow("overrides: $nope names no direct dependency of package.json");
  });

  it("T-IMG-04 must-fail: overrides copied as they are (1.18 to 1.21) are reported for every image without zod, L2 and the seller included", () => {
    const copied = (n: ImageName): Manifest => ({ ...imageManifest(PKG, wanted.get(n)!), overrides: PKG.overrides });
    const failing = NAMES.filter((n) => overrideProblems(copied(n)).length > 0);
    expect(failing).toEqual(NAMES.filter((n) => !wanted.get(n)!.includes("zod")));
    expect(failing).toEqual(expect.arrayContaining(["l2-control", "seller"]));
    expect(overrideProblems(copied("seller"))).toEqual(["overrides @coinbase/cdp-sdk > zod: $zod is not a dependency of this package.json"]);
    // The root package.json lists zod itself, so a root install never showed it.
    expect(overrideProblems(PKG)).toEqual([]);
  });
});
