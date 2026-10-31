import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "apps/desktop/scripts/**/*.test.mjs",
      "phone/test/**/*.test.js",
      "docs/**/*.test.mjs",
    ],
    environment: "node",
    testTimeout: 20000,
  },
});
