import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const suite = process.argv[2] === "admin" ? "admin" : "mobile";
const extraArguments = process.argv.slice(3);

function repositoryEnvironment() {
  const environment = { ...process.env };
  try {
    const content = readFileSync(join(repositoryRoot, ".env"), "utf8");
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || environment[key] !== undefined) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      environment[key] = value;
    }
  } catch {
    // CI can provide all values through its process environment.
  }
  return environment;
}

const environment = repositoryEnvironment();
const databaseUrl = environment.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for PostgreSQL Playwright tests");
}

const schema = `yxm_e2e_${suite}_${randomUUID().replaceAll("-", "")}`;
const playwrightCli = join(repositoryRoot, "node_modules", "@playwright", "test", "cli.js");
const workingDirectory = suite === "admin" ? join(repositoryRoot, "admin") : repositoryRoot;
const configArguments = suite === "admin" ? ["-c", "playwright.config.ts"] : [];
const childEnvironment = {
  ...environment,
  DATABASE_URL: databaseUrl,
  YUXIAOMAN_E2E_SCHEMA: schema,
  YUXIAOMAN_DB_SCHEMA: schema,
  YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK: "true",
  YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK: "true",
};

function configuredPort(name) {
  const raw = environment[name]?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForUrl(url, service, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) {
      throw new Error(`E2E service exited before becoming ready: ${url}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for E2E service: ${url}`);
}

function stopProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) child.kill("SIGKILL");
    return;
  }
  child.kill("SIGTERM");
}

const apiPort = configuredPort(suite === "admin" ? "ADMIN_E2E_API_PORT" : "E2E_API_PORT")
  ?? await availablePort();
const webPort = configuredPort(suite === "admin" ? "ADMIN_E2E_WEB_PORT" : "MOBILE_RUNTIME_TEST_PORT")
  ?? await availablePort();
const services = [];
let exitCode = 1;
try {
  const api = spawn(
    process.execPath,
    ["--import", "tsx", join(repositoryRoot, "server", "index.ts")],
    {
      cwd: repositoryRoot,
      env: {
        ...childEnvironment,
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        NODE_ENV: "test",
        YUXIAOMAN_UPLOAD_DIR: suite === "admin"
          ? ".runtime/admin-playwright-e2e-uploads"
          : ".runtime/playwright-e2e-uploads",
        TENCENT_MAP_KEY: "",
        PAYMENT_PROVIDER: "mock",
        ALLOW_MOCK_PAYMENT: "true",
        ALLOW_DEMO_WORKFLOW: suite === "mobile" ? "true" : "false",
        ALLOW_DEMO_RESET: "false",
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  services.push(api);

  const vite = spawn(
    process.execPath,
    [
      join(repositoryRoot, "node_modules", "vite", "bin", "vite.js"),
      "--host", "127.0.0.1",
      "--port", String(webPort),
      "--strictPort",
    ],
    {
      cwd: workingDirectory,
      env: {
        ...childEnvironment,
        ...(suite === "admin"
          ? {
              YUXIAOMAN_API_TARGET: `http://127.0.0.1:${apiPort}`,
              VITE_TENCENT_MAP_WEB_KEY: environment.VITE_TENCENT_MAP_WEB_KEY || "playwright-tencent-map-web-key",
            }
          : { VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}/api` }),
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  services.push(vite);

  await Promise.all([
    waitForUrl(`http://127.0.0.1:${apiPort}/api/health`, api),
    waitForUrl(
      suite === "admin"
        ? `http://127.0.0.1:${webPort}`
        : `http://127.0.0.1:${webPort}/tests/runtime-fixture.html`,
      vite,
    ),
  ]);

  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, "test", ...configArguments, ...extraArguments],
      {
        cwd: workingDirectory,
        env: {
          ...childEnvironment,
          PLAYWRIGHT_REUSE_EXISTING: "true",
          ...(suite === "admin"
            ? { ADMIN_E2E_API_PORT: String(apiPort), ADMIN_E2E_WEB_PORT: String(webPort) }
            : { E2E_API_PORT: String(apiPort), MOBILE_RUNTIME_TEST_PORT: String(webPort) }),
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} finally {
  for (const service of services.reverse()) stopProcessTree(service);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    application_name: `yuxiaoman-e2e-cleanup-${suite}`,
  });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch (error) {
    console.error(`Failed to clean PostgreSQL E2E schema ${schema}:`, error);
    if (exitCode === 0) exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exit(exitCode);
