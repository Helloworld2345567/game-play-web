import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // A failed create request can leave a sixty-second provisional capacity
  // lease while the Worker finishes its Durable Object initialization. Give
  // CI's shared runners enough time for that request to settle; otherwise a
  // fifteen-second assertion timeout cascades into capacity_reached failures
  // in the following serial room tests.
  timeout: process.env.CI ? 60_000 : 30_000,
  // A shared CI runner can transiently lose a local Worker/DO connection;
  // retry the isolated test context without changing local developer runs.
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  // Durable Objects are cold-started by the in-process Worker on shared CI
  // runners. Keep local assertions fast while allowing those first RPCs time
  // to complete instead of turning a slow startup into a cascading failure.
  expect: {
    timeout: process.env.CI ? 30_000 : 5_000,
  },
  use: {
    baseURL: "http://localhost:5173",
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --mode e2e",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
