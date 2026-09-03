import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

function loadRepositoryEnv(): void {
  try {
    const filename = fileURLToPath(new URL("../.env", import.meta.url));
    const content = readFileSync(filename, "utf8");
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] !== undefined) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // A repository .env is optional. Explicit process environment always wins.
  }
}

loadRepositoryEnv();

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

const shutdown = async (signal: string) => {
  if (!app) return;
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

try {
  app = await buildApp({ logger: true });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host, port });
} catch (error) {
  if (app) {
    app.log.error(error);
    await app.close().catch(() => undefined);
  } else {
    console.error(error);
  }
  process.exit(1);
}
