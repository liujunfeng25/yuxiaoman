import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInitialPlatformAdmin } from "../server/backoffice.js";
import { createDatabase } from "../server/db.js";

function loadRepositoryEnv(): void {
  try {
    const filename = fileURLToPath(new URL("../.env", import.meta.url));
    for (const rawLine of readFileSync(filename, "utf8").split(/\r?\n/u)) {
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
    // Explicit environment variables are sufficient on production hosts.
  }
}

function argument(name: string): string | undefined {
  const marker = `--${name}`;
  const index = process.argv.indexOf(marker);
  if (index < 0) return undefined;
  return process.argv[index + 1]?.trim() || undefined;
}

loadRepositoryEnv();

const loginName = argument("login") ?? process.env.BACKOFFICE_ADMIN_LOGIN?.trim();
const displayName = argument("display-name") ?? process.env.BACKOFFICE_ADMIN_DISPLAY_NAME?.trim();
const password = process.env.BACKOFFICE_ADMIN_PASSWORD;

if (!loginName || !displayName || !password) {
  console.error(
    "Usage: set BACKOFFICE_ADMIN_PASSWORD to a new 12+ character password, then run "
    + "npm run backoffice:create-admin -- --login <login> --display-name <real name>",
  );
  process.exit(2);
}

const database = await createDatabase({ seed: false });
try {
  const account = await createInitialPlatformAdmin(database, { loginName, displayName, password });
  console.log(JSON.stringify({
    created: true,
    account: {
      id: account.id,
      loginName: account.loginName,
      displayName: account.displayName,
      role: account.role,
      status: account.status,
    },
  }, null, 2));
} finally {
  await database.close();
}
