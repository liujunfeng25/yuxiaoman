import { defineConfig } from "@playwright/test";

const apiPort = Number(process.env.ADMIN_E2E_API_PORT ?? 8790);
const webPort = Number(process.env.ADMIN_E2E_WEB_PORT ?? 5175);
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING === "true";
const databaseSchema = process.env.YUXIAOMAN_E2E_SCHEMA ?? `yxm_e2e_admin_${process.pid}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 20_000,
  // Admin scenarios share one seeded PostgreSQL schema and intentionally mutate
  // the same operational records. Serial execution keeps the suite deterministic.
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${webPort}`, channel: "chrome" },
  webServer: reuseExistingServer ? undefined : [
    {
      command: "node --import tsx ../server/index.ts",
      env: {
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        YUXIAOMAN_DB_SCHEMA: databaseSchema,
        YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK: "true",
        YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK: "true",
        YUXIAOMAN_UPLOAD_DIR: ".runtime/admin-playwright-e2e-uploads",
        TENCENT_MAP_KEY: "",
        PAYMENT_PROVIDER: "mock",
        ALLOW_MOCK_PAYMENT: "true",
        ALLOW_DEMO_RESET: "false",
        NODE_ENV: "test",
      },
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer,
    },
    {
      command: `node ../node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${webPort} --strictPort`,
      env: {
        YUXIAOMAN_API_TARGET: `http://127.0.0.1:${apiPort}`,
        VITE_TENCENT_MAP_WEB_KEY: "playwright-tencent-map-web-key",
      },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer,
    },
  ],
});
