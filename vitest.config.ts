import { defineConfig } from "vitest/config";

// SPEC §5: test files run one at a time; e2e suites share fixed ports and a local chain.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
