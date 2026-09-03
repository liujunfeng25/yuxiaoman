import { defineConfig } from "@playwright/test";

const testPort = Number(process.env.MOBILE_RUNTIME_TEST_PORT ?? 4174);
const apiPort = Number(process.env.E2E_API_PORT ?? 8787);
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING === "true";
const databaseSchema = process.env.YUXIAOMAN_E2E_SCHEMA ?? `yxm_e2e_mobile_${process.pid}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 20_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${testPort}`,
    channel: "chrome",
    viewport: { width: 1100, height: 1100 },
  },
  webServer: reuseExistingServer ? undefined : [
    {
      command: "node --import tsx server/index.ts",
      env: {
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        YUXIAOMAN_DB_SCHEMA: databaseSchema,
        YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK: "true",
        YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK: "true",
        YUXIAOMAN_UPLOAD_DIR: ".runtime/playwright-e2e-uploads",
        // Keep E2E deterministic and avoid consuming Tencent quota. The MVP must
        // take the same strict no-quote branch for missing, exhausted or invalid keys.
        TENCENT_MAP_KEY: "",
        PAYMENT_PROVIDER: "mock",
        ALLOW_MOCK_PAYMENT: "true",
        ALLOW_DEMO_WORKFLOW: "true",
        ALLOW_DEMO_RESET: "false",
        NODE_ENV: "test",
      },
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer,
    },
    {
      command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${testPort} --strictPort`,
      env: {
        VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}/api`,
      },
      url: `http://127.0.0.1:${testPort}/tests/runtime-fixture.html`,
      reuseExistingServer,
    },
  ],
});
