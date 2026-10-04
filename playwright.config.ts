import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "https://localhost:3443",
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "node --import tsx server/index.ts",
    url: "https://localhost:3443/api/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: true,
    timeout: 120000,
    stdout: "pipe",
  },
});
