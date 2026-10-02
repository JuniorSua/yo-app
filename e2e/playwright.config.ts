import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.YO_E2E_PORT ?? 5174);

/** UI E2E against the in-memory mock backend (`?mock=1`). */
export default defineConfig({
  testDir: "./tests",
  outputDir: "./results",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  // GitHub's 2-core runners would otherwise get a single worker.
  workers: process.env.CI ? 2 : undefined,
  // CI also writes an HTML report (uploaded when a test fails). Kept outside outputDir so it isn't wiped.
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]]
    : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `pnpm --filter @yo/web exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { VITE_MOCK: "1" },
  },
});
