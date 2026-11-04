// T-IMG-01 per-layer images (specs/011 research R14; scripts/image-closure.ts). Each image's code is the
// import graph of its entry points, and it must stay inside its own layer: only the L2 image holds the
// signer, and only the L1 image holds the agent framework and the model SDKs. Every package must be a
// runtime dependency, including those resolved at run time. Each Dockerfile builds the image the table
// names, from the same pinned base. The Docker builds themselves run in the deploy workflow (step 3) and in
// quickstart §1, where each image also loads every module once.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { IMAGES, closure, problems, type Closure, type ImageName } from "../scripts/image-closure.js";

const DEPS = (JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> }).dependencies;
const NAMES = Object.keys(IMAGES) as ImageName[];
const SIGNER = "src/layer2-control/signer.ts";
const AGENT_PACKAGES = ["@mastra/core", "@ai-sdk/anthropic", "@anthropic-ai/sdk", "@azure/identity"];

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

  it("T-IMG-01 only the L2 image holds the signer, and only the L1 image holds the agent framework and model SDKs", () => {
    expect(holders((c) => c.files.includes(SIGNER))).toEqual(["l2-control"]);
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
