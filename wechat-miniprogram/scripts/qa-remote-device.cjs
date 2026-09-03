'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const automator = require('miniprogram-automator');
const { decodeQrCode, printQrCode } = require('miniprogram-automator/out/util');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const autoRemote = process.env.WECHAT_REMOTE_AUTO !== 'false';
const timeoutMs = parsePositiveInteger(process.env.WECHAT_REMOTE_TIMEOUT_MS, 180_000);
const artifactsDir = path.resolve(__dirname, '..', 'artifacts');
const reportPath = path.join(artifactsDir, 'qa-remote-device-report.json');

const routes = [
  {
    name: 'home',
    url: '/pages/home/home',
    validate(data) {
      if (data.loading) return '首页仍在加载';
      if (!data.vehicle || !data.hero) return '首页未取得当前车辆或年检摘要';
      return null;
    },
    summary(data) {
      return { hasVehicle: Boolean(data.vehicle), hasInspectionHero: Boolean(data.hero) };
    },
  },
  {
    name: 'vehicles',
    url: '/packages/vehicle/pages/vehicles/vehicles',
    validate(data) {
      if (data.loading) return '车辆页仍在加载';
      if (!Array.isArray(data.vehicles) || data.vehicles.length === 0) return '车辆页未取得任何车辆';
      return null;
    },
    summary(data) {
      return { vehicleCount: data.vehicles.length };
    },
  },
  {
    name: 'eligibility',
    url: '/packages/annual/pages/eligibility/eligibility',
    validate(data) {
      if (data.loadingVehicles) return '年检查询页仍在加载车辆';
      if (!Array.isArray(data.vehicles) || data.vehicles.length === 0) return '年检查询页未取得车辆';
      return null;
    },
    summary(data) {
      return { vehicleCount: data.vehicles.length, hasSelectedVehicle: Boolean(data.selectedId) };
    },
  },
  {
    name: 'orders',
    url: '/pages/orders/orders',
    validate(data) {
      if (data.loading) return '订单页仍在加载';
      if (!Array.isArray(data.orders)) return '订单页数据不是数组';
      return null;
    },
    summary(data) {
      return { orderCount: data.orders.length };
    },
  },
];

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function retry(operation, label, attempts = 12, waitMs = 1_000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(waitMs);
    }
  }
  throw new Error(`${label} failed: ${lastError && lastError.message ? lastError.message : lastError}`);
}

async function waitForPageData(page, route) {
  let lastReason = '页面数据尚未就绪';
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const data = await page.data();
    const reason = route.validate(data);
    if (!reason) return data;
    lastReason = reason;
    await delay(1_000);
  }
  throw new Error(`${route.name}: ${lastReason}`);
}

function describeConsoleMessage(message) {
  const args = Array.isArray(message && message.args) ? message.args : [];
  return args.map((value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(' ').slice(0, 1_000);
}

async function connectToDevtools() {
  if (automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return automator.launcher.connectTool({ wsEndpoint: endpoint });
  }
  return automator.connect({ wsEndpoint: endpoint });
}

async function enterRemoteDebug(miniProgram, report) {
  const connection = miniProgram.connection;
  if (!connection || typeof connection.once !== 'function') {
    await withTimeout(miniProgram.remote(autoRemote), timeoutMs, 'Waiting for a real device');
    return;
  }

  const connected = new Promise((resolve) => {
    connection.once('Tool.onRemoteDebugConnected', resolve);
  });
  const startedAt = Date.now();

  try {
    const response = await miniProgram.send('Tool.enableRemoteDebug', { auto: autoRemote });
    if (response && response.qrCode) {
      await printQrCode(await decodeQrCode(response.qrCode));
    }
  } catch (error) {
    const detail = String((error && error.message) || error);
    if (!/timeout waiting for automator response/i.test(detail)) throw error;

    report.remoteHandshakeFallback = detail;
    console.warn('REMOTE_DEBUG_BRIDGE_TIMEOUT_CONTINUING');
    console.warn('DevTools timed out while preparing remote debug; keeping the automation socket open for the device connection.');
  }

  const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
  await withTimeout(connected, remainingMs, 'Waiting for a real device');
}

async function run() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    endpoint,
    autoRemote,
    device: null,
    routes: [],
    issues: [],
    passed: false,
  };
  let miniProgram;

  try {
    miniProgram = await connectToDevtools();

    EventEmitter.prototype.on.call(miniProgram, 'console', (message) => {
      const type = String((message && message.type) || '').toLowerCase();
      if (type !== 'error' && type !== 'assert') return;
      const issue = { source: 'console', type, detail: describeConsoleMessage(message) };
      report.issues.push(issue);
      console.error(`[remote console:${type}] ${issue.detail}`);
    });

    EventEmitter.prototype.on.call(miniProgram, 'exception', (exception) => {
      const detail = String((exception && (exception.stack || exception.message)) || exception).slice(0, 2_000);
      report.issues.push({ source: 'exception', type: 'exception', detail });
      console.error(`[remote exception] ${detail}`);
    });

    console.log(`REMOTE_DEBUG_WAITING auto=${autoRemote} endpoint=${endpoint}`);
    console.log('If WeChat does not open automatically, scan the remote-debug QR code shown by DevTools.');
    await enterRemoteDebug(miniProgram, report);
    console.log('REMOTE_DEBUG_CONNECTED');

    await retry(() => miniProgram.send('App.enableLog'), 'Enabling real-device console capture');
    await retry(() => miniProgram.currentPage(), 'Waiting for the real-device runtime');

    const systemInfo = await retry(() => miniProgram.systemInfo(), 'Reading real-device system information');
    report.device = {
      platform: systemInfo.platform || '',
      brand: systemInfo.brand || '',
      model: systemInfo.model || '',
      system: systemInfo.system || '',
      version: systemInfo.version || '',
      SDKVersion: systemInfo.SDKVersion || '',
    };
    if (!report.device.platform || report.device.platform === 'devtools') {
      throw new Error(`Expected a real-device runtime, received platform=${report.device.platform || 'unknown'}`);
    }

    for (const route of routes) {
      await retry(
        () => miniProgram.callWxMethod('reLaunch', { url: route.url }),
        `Re-launching ${route.url}`,
      );
      await delay(3_000);
      const page = await retry(() => miniProgram.currentPage(), `Loading ${route.url}`);
      const expectedPath = route.url.replace(/^\//, '').split('?')[0];
      if (!page || page.path !== expectedPath) {
        throw new Error(`Expected ${expectedPath}, received ${(page && page.path) || 'no page'}`);
      }

      const data = await waitForPageData(page, route);
      const screenshotPath = path.join(artifactsDir, `qa-remote-${route.name}.png`);
      await miniProgram.screenshot({ path: screenshotPath });
      const routeReport = {
        name: route.name,
        path: page.path,
        screenshot: screenshotPath,
        ...route.summary(data),
      };
      report.routes.push(routeReport);
      console.log(`REMOTE_ROUTE_OK ${route.name} ${JSON.stringify(routeReport)}`);
    }

    if (report.issues.length > 0) {
      throw new Error(`Captured ${report.issues.length} console error/assert or exception event(s).`);
    }

    report.passed = true;
    console.log(`REMOTE_QA_PASSED ${report.routes.length} routes`);
  } catch (error) {
    report.failure = String((error && (error.stack || error.message)) || error).slice(0, 4_000);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`REMOTE_QA_REPORT ${reportPath}`);
    if (miniProgram) miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
