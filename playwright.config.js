import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for deterministic browser tests of the redesigned
 * Custom Code Connect UI. Tests run against the local Vite dev server so they
 * exercise the real build pipeline without touching paid generation, billing or
 * production project writes.
 */
const PORT = Number(process.env.CCC_TEST_PORT || 3000);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // --strictPort makes a taken port fail loudly instead of silently drifting
    // to another one, which would leave baseURL pointing at a foreign server.
    command: "npm run dev -- --strictPort",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
