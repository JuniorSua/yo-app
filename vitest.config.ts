import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    environment: "node",
    testTimeout: 20000,
  },
});
