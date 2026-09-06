import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./db.js";
import { runWorkflowWorkerLoop } from "./workflow-worker.js";

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
    // Explicit process environment remains authoritative.
  }
}

loadRepositoryEnv();
const controller = new AbortController();
const database = await createDatabase({ applicationName: "yuxiaoman-workflow-worker" });

const shutdown = () => controller.abort();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await runWorkflowWorkerLoop(database, {
    signal: controller.signal,
    onError: (error) => console.error("workflow worker iteration failed", error),
  });
} finally {
  await database.close();
}
