import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
const children = [];
let shuttingDown = false;

function start(name, args, env = process.env) {
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const child = spawn(command, commandArgs, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`${name} exited with ${signal ?? `code ${code}`}`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

start("api", ["run", "api:dev"]);
start("workflow-worker", ["run", "workflow:worker"]);
start(
  "web",
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
  {
    ...process.env,
    VITE_API_BASE_URL:
      process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8792/api",
  },
);

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
