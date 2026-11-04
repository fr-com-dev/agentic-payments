import { transform } from "esbuild";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * TC39 decorators (the seller's endpoint and monetization decorators, src/counterparty/) in tests. tsc emits them
 * lowered for the build and tsx lowers them with esbuild, but vite 8's oxc transformer only knows TypeScript's legacy
 * decorators, and Node can't run decorators natively yet. So a source file that uses one is lowered by the same
 * esbuild that tsx uses, before oxc sees it. Files without a decorator are left to oxc.
 */
const tc39Decorators: Plugin = {
  name: "tc39-decorators",
  enforce: "pre",
  async transform(code, id) {
    if (!/\.[cm]?ts$/.test(id) || id.includes("/node_modules/") || !/^\s*@[A-Za-z]/m.test(code)) return null;
    const out = await transform(code, { loader: "ts", format: "esm", target: "es2023", sourcemap: true, sourcefile: id });
    return { code: out.code, map: out.map };
  },
};

// SPEC §5: test files run one at a time; e2e suites share fixed ports and a local chain.
export default defineConfig({
  plugins: [tc39Decorators],
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
