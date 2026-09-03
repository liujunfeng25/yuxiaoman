import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MINI_API_HOST,
  MINI_API_PORT,
  configureMiniApiEnvironment,
} from "../scripts/configure-mini-api-environment.mjs";

test("native mini-program API overrides loopback repository environment for LAN debugging", () => {
  const environment = {
    HOST: "127.0.0.1",
    PORT: "8787",
    ALLOW_MOCK_PAYMENT: "false",
  };

  const configured = configureMiniApiEnvironment(environment);

  assert.equal(environment.HOST, "0.0.0.0");
  assert.equal(environment.PORT, "8792");
  assert.deepEqual(configured, { host: "0.0.0.0", port: 8792 });
  assert.equal(environment.ALLOW_MOCK_PAYMENT, "false", "explicit safety flags must remain authoritative");
  assert.equal(environment.ALLOW_DEMO_WORKFLOW, "true");
});

test("mini API constants retain the documented LAN listener contract", () => {
  assert.equal(MINI_API_HOST, "0.0.0.0");
  assert.equal(MINI_API_PORT, "8792");
});

test("normal and Tencent-fixture mini API entrypoints share the LAN configuration", async () => {
  const [entrypoint, qaEntrypoint] = await Promise.all([
    readFile(new URL("../scripts/start-mini-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-mini-api-qa-map.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /configureMiniApiEnvironment\(\)/u);
  assert.match(qaEntrypoint, /import\("\.\/start-mini-api\.mjs"\)/u);
  assert.doesNotMatch(entrypoint, /HOST\s*\?\?=/u);
});
