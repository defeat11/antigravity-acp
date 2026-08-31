import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The conversation store reader spawns nothing; integration tests that
    // drive the agent in dry-run get a generous timeout for process startup.
    testTimeout: 20000,
  },
});
