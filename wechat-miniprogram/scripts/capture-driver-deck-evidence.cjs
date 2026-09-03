'use strict';

const fs = require('node:fs');
const path = require('node:path');
const automator = require('miniprogram-automator');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9433';
const outputDir = path.resolve(
  process.env.WECHAT_DRIVER_DECK_EVIDENCE_DIR
    || path.join(__dirname, '..', '..', 'deliverables', 'deck-work', 'driver-entry-evidence-20260830'),
);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitUntil(probe, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await delay(200);
  }
  throw new Error(`${label} timed out after ${timeoutMs} ms.`);
}

async function currentPage(miniProgram, expectedPath, label = expectedPath) {
  return waitUntil(async () => {
    const page = await miniProgram.currentPage();
    return page && page.path === expectedPath ? page : null;
  }, `Waiting for ${label}`);
}

async function waitForData(page, key, predicate, label) {
  return waitUntil(async () => {
    const value = await page.data(key);
    return predicate(value) ? { value } : null;
  }, label);
}

async function connect() {
  if (automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return automator.launcher.connectTool({ wsEndpoint: endpoint });
  }
  return automator.connect({ wsEndpoint: endpoint });
}

async function screenshot(miniProgram, filename) {
  await miniProgram.callWxMethod('hideToast').catch(() => undefined);
  await delay(300);
  await miniProgram.screenshot({ path: path.join(outputDir, filename) });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const miniProgram = await connect();
  try {
    await miniProgram.callWxMethod('reLaunch', { url: '/packages/operator/pages/staff-entry/staff-entry' });
    const staffPage = await currentPage(miniProgram, 'packages/operator/pages/staff-entry/staff-entry', 'staff entry');
    await delay(900);
    await screenshot(miniProgram, 'driver-entry-01-switch-to-driver.png');

    await waitUntil(() => staffPage.$('.driver-card'), 'Waiting for driver entry card');
    await staffPage.callMethod('enterDriver');
    const loginPage = await currentPage(miniProgram, 'packages/driver/pages/login/login', 'driver login');
    await waitForData(loginPage, 'checkingSession', (value) => value === false, 'Waiting for driver session check');

    if (await loginPage.data('cachedTask')) {
      await waitUntil(() => loginPage.$('.secondary-action'), 'Waiting for switch-task button');
      await loginPage.callMethod('switchTask');
      await waitForData(loginPage, 'cachedTask', (value) => value === null, 'Waiting for verification-code form');
    }

    await delay(500);
    await screenshot(miniProgram, 'driver-entry-02-code-login.png');
    console.log(JSON.stringify({ outputDir, screenshots: 2 }, null, 2));
  } finally {
    miniProgram.disconnect();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
