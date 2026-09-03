import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const envPath = path.join(repositoryRoot, ".env");
const outputPath = path.join(scriptDirectory, "transfer.env");

function parseEnv(content) {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function databaseTarget(raw, name) {
  if (!raw) throw new Error(`${name} 未配置`);
  const value = new URL(raw);
  if (!new Set(["postgres:", "postgresql:"]).has(value.protocol)) {
    throw new Error(`${name} 必须是 PostgreSQL URL`);
  }
  const user = decodeURIComponent(value.username);
  const password = decodeURIComponent(value.password);
  const database = decodeURIComponent(value.pathname.replace(/^\//u, ""));
  const port = value.port || "5432";
  for (const [field, fieldValue] of Object.entries({ user, password, database, port })) {
    if (!fieldValue || !/^[A-Za-z0-9._~!%-]+$/u.test(fieldValue)) {
      throw new Error(`${name} 的 ${field} 含 transfer.env 不支持的字符；请改用 URL-safe 值`);
    }
  }
  return { user, password, database, port };
}

const values = parseEnv(readFileSync(envPath, "utf8"));
const runtime = databaseTarget(values.get("DATABASE_URL"), "DATABASE_URL");
const test = databaseTarget(values.get("TEST_DATABASE_URL"), "TEST_DATABASE_URL");

if (runtime.user !== test.user || runtime.password !== test.password || runtime.port !== test.port) {
  throw new Error("DATABASE_URL 与 TEST_DATABASE_URL 必须使用同一容器账号和端口");
}

const content = [
  `POSTGRES_USER=${runtime.user}`,
  `POSTGRES_PASSWORD=${runtime.password}`,
  `POSTGRES_DB=${runtime.database}`,
  `POSTGRES_TEST_DB=${test.database}`,
  `POSTGRES_PORT=${runtime.port}`,
  "",
].join("\n");

writeFileSync(outputPath, content, { encoding: "utf8", mode: 0o600 });
try { chmodSync(outputPath, 0o600); } catch { /* ZIP extraction can ignore POSIX modes. */ }
console.log(`已生成本机数据库容器配置：${path.relative(repositoryRoot, outputPath)}`);
