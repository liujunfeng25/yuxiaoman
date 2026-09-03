import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDatabase, type Database } from "../db.js";

process.env.NODE_ENV = "test";
process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "true";
process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK = "true";

function loadRepositoryDatabaseUrls(): void {
  if (process.env.TEST_DATABASE_URL?.trim() && process.env.DATABASE_URL?.trim()) return;
  try {
    const filename = fileURLToPath(new URL("../../.env", import.meta.url));
    const content = readFileSync(filename, "utf8");
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (key !== "TEST_DATABASE_URL" && key !== "DATABASE_URL") continue;
      if (process.env[key]?.trim()) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) process.env[key] = value;
      if (process.env.TEST_DATABASE_URL?.trim() && process.env.DATABASE_URL?.trim()) return;
    }
  } catch {
    // CI may provide database URLs directly and need no repository .env file.
  }
}

loadRepositoryDatabaseUrls();

type PostgreSqlTarget = {
  host: string;
  port: string;
  database: string;
};

function postgreSqlTarget(value: string, variableName: string): PostgreSqlTarget {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use the postgres or postgresql protocol`);
  }

  const parsedHost = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const host = ["localhost", "127.0.0.1", "[::1]"].includes(parsedHost)
    ? "loopback"
    : parsedHost;
  const port = parsed.port || "5432";
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/gu, ""));
  if (!host || !database) {
    throw new Error(`${variableName} must include a host and database name`);
  }

  return { host, port, database };
}

export function assertTestDatabaseTargetIsolated(
  testDatabaseUrl: string,
  runtimeDatabaseUrl?: string,
): void {
  if (!runtimeDatabaseUrl?.trim()) return;

  const testTarget = postgreSqlTarget(testDatabaseUrl, "TEST_DATABASE_URL");
  const runtimeTarget = postgreSqlTarget(runtimeDatabaseUrl, "DATABASE_URL");
  if (
    testTarget.host === runtimeTarget.host
    && testTarget.port === runtimeTarget.port
    && testTarget.database === runtimeTarget.database
  ) {
    throw new Error(
      "Refusing to run tests because TEST_DATABASE_URL and DATABASE_URL target the same PostgreSQL database "
      + `(${testTarget.host}:${testTarget.port}/${testTarget.database})`,
    );
  }
}

function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "TEST_DATABASE_URL is required for API tests; tests run against an isolated PostgreSQL schema",
    );
  }
  assertTestDatabaseTargetIsolated(value, process.env.DATABASE_URL);
  return value;
}

export async function createTestDatabase(prefix = "api"): Promise<Database> {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 20) || "api";
  const schema = `yxm_${safePrefix}_${randomUUID().replaceAll("-", "")}`;
  return createDatabase({
    connectionString: testDatabaseUrl(),
    schema,
    createSchema: true,
    dropSchemaOnClose: true,
    max: 4,
    applicationName: `yuxiaoman-test-${safePrefix}`,
  });
}
