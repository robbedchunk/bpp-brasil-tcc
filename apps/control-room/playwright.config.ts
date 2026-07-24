import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4328",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    bypassCSP: true,
    video: "off",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node --import tsx tests/e2e/fixture-server.ts",
    url: "http://127.0.0.1:4328/api/v1/meta",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
