'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const automator = require('miniprogram-automator');

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:9421';
const DEFAULT_ROUTE = '/pages/home/home';
const DEFAULT_WAIT_MS = 1_000;

const endpoint = process.env.WECHAT_AUTOMATOR_WS || DEFAULT_ENDPOINT;
const route = process.env.WECHAT_QA_ROUTE || DEFAULT_ROUTE;
const waitMs = parseWaitMs(process.env.WECHAT_QA_WAIT_MS);
const artifactsDir = path.resolve(__dirname, '..', 'artifacts');
const routeSlug = route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
const screenshotName = process.env.WECHAT_QA_SCREENSHOT || `qa-smoke-${routeSlug || 'page'}.png`;
const screenshotPath = path.join(artifactsDir, screenshotName);

function parseWaitMs(value) {
  if (value === undefined || value === '') {
    return DEFAULT_WAIT_MS;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`WECHAT_QA_WAIT_MS must be a non-negative integer; received: ${value}`);
  }

  return parsed;
}

function describeConsoleMessage(message) {
  const args = Array.isArray(message && message.args) ? message.args : [];
  return args
    .map((value) => {
      if (typeof value === 'string') {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(operation, label, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(1_000);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError && lastError.message ? lastError.message : lastError}`);
}

async function connectToDevtools() {
  // Current WeChat DevTools Nightly builds omit SDKVersion from Tool.getInfo.
  // The public connect() path in miniprogram-automator 0.12.1 assumes it is
  // always present and crashes before a page can be inspected. connectTool()
  // uses the same official protocol without that stale client-side guard.
  if (automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return automator.launcher.connectTool({ wsEndpoint: endpoint });
  }

  return automator.connect({ wsEndpoint: endpoint });
}

async function run() {
  let miniProgram;
  const issues = [];

  try {
    miniProgram = await connectToDevtools();

    EventEmitter.prototype.on.call(miniProgram, 'console', (message) => {
      const type = String((message && message.type) || '').toLowerCase();
      if (type !== 'error' && type !== 'assert') {
        return;
      }

      const detail = describeConsoleMessage(message);
      issues.push({ source: 'console', type, detail });
      console.error(`[mini-program console:${type}] ${detail}`);
    });

    EventEmitter.prototype.on.call(miniProgram, 'exception', (exception) => {
      const detail = exception && exception.stack
        ? exception.stack
        : String((exception && exception.message) || exception);
      issues.push({ source: 'exception', type: 'exception', detail });
      console.error(`[mini-program exception] ${detail}`);
    });

    await retry(() => miniProgram.currentPage(), 'Waiting for the simulator runtime');
    await retry(() => miniProgram.send('App.enableLog'), 'Enabling mini-program console capture');

    // Bypass the SDK's stale plugin-path probe. Current Nightly can briefly
    // return an empty current-page record during a route change, which makes
    // miniprogram-automator 0.12.1 call indexOf() on undefined.
    await retry(() => miniProgram.callWxMethod('reLaunch', { url: route }), `Re-launching ${route}`);
    await delay(3_000);
    const page = await retry(() => miniProgram.currentPage(), `Loading ${route}`);
    if (!page || !page.path) {
      throw new Error(`Unable to load ${route}; the mini program may not have compiled.`);
    }
    const expectedPath = route.replace(/^\//, '').split('?')[0];
    if (page.path !== expectedPath) {
      throw new Error(`Expected ${expectedPath}, but the simulator rendered ${page.path}.`);
    }

    await page.waitFor(waitMs);
    fs.mkdirSync(artifactsDir, { recursive: true });
    await miniProgram.screenshot({ path: screenshotPath });

    console.log(`QA smoke page: ${page.path}`);
    console.log(`QA smoke screenshot: ${screenshotPath}`);

    if (issues.length > 0) {
      throw new Error(`QA smoke captured ${issues.length} console error/assert or exception event(s).`);
    }

    console.log('QA smoke passed with no captured console error/assert or exception events.');
  } finally {
    if (miniProgram) {
      miniProgram.disconnect();
    }
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
