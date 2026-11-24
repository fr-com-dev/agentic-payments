// Feature 017: the portal image's web build has no pasted-token sign-in (SPEC.md L2-8; specs/017 research R11).
// T-WEB-16. The web app's dev sign-in is behind `DEV_SIGN_IN`, which is false when Vite builds with
// `--mode deployment`: the constant folds, and the branch, its dynamic import and the module's chunk are dropped.
// The default build is the control: it keeps them, so the module and the marker strings below do appear there.
import { resolve } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const MARKERS = ["Development sign-in", "dev-token"];
const DEV_MODULE = resolve("web/portal/src/auth/dev.ts");

/** The part of the bundler's output this test reads (Vite 8 bundles with Rolldown; its types aren't a direct dependency). */
type Emitted = { type: "chunk"; fileName: string; code: string; moduleIds: string[] } | { type: "asset"; fileName: string; source: string | Uint8Array };
type Output = { output: Emitted[] };

/** What one build emits, without writing it: the modules in its chunks, and the files holding a marker. */
async function built(mode?: string): Promise<{ devModule: boolean; marked: string[] }> {
  const out = (await build({ configFile: "web/portal/vite.config.ts", logLevel: "silent", ...(mode !== undefined && { mode }), build: { write: false } })) as unknown as Output | Output[];
  const files = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
  return {
    devModule: files.some((f) => f.type === "chunk" && f.moduleIds.includes(DEV_MODULE)),
    marked: files.filter((f) => /\.(js|html)$/.test(f.fileName) && MARKERS.some((m) => (f.type === "chunk" ? f.code : String(f.source)).includes(m))).map((f) => f.fileName),
  };
}

describe("T-WEB-16 the deployment build of the web app has no pasted-token sign-in", { timeout: 120_000 }, () => {
  it("T-WEB-16 --mode deployment emits neither the dev sign-in's module nor its text; the default build does (the control)", async () => {
    expect(await built("deployment")).toEqual({ devModule: false, marked: [] });
    const control = await built();
    expect(control.devModule).toBe(true);
    expect(control.marked.length).toBeGreaterThan(0);
  });
});
