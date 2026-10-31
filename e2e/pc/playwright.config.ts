import { defineConfig, devices } from "@playwright/test";

/** The PC edition against a real install (started by e2e/pc/run.mjs, which sets YO_PC_URL). One worker: it's
 * one Yo, and the tests build on each other (sign in, then use it). */
export default defineConfig({
  testDir: ".",
  testMatch: "pc.spec.ts",
  outputDir: "./results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.YO_PC_URL,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // Firefox needs `pnpm exec playwright install firefox` once; run.mjs skips it when it isn't installed.
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } } },
  ],
});
