'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const automator = require('miniprogram-automator');
const sharp = require('sharp');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const artifactsDir = path.resolve(__dirname, '..', 'artifacts', 'wash-store-picker-design-qa');
const minimumViewport = { width: 360, height: 780 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(operation, label, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(750);
    }
  }
  throw new Error(`${label} failed: ${lastError && lastError.message ? lastError.message : lastError}`);
}

async function run() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const miniProgram = await automator.launcher.connectTool({ wsEndpoint: endpoint });

  const send = (method, params = {}) => retry(() => miniProgram.send(method, params), method);
  const currentPage = () => send('App.getCurrentPage');

  async function waitForPage(expectedPath, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = await currentPage();
      if (page && page.path === expectedPath) return page;
      await delay(250);
    }
    const page = await currentPage();
    throw new Error(`Expected ${expectedPath}, rendered ${page && page.path}`);
  }

  async function waitForElements(pageId, selector, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await send('Page.getElements', { pageId, selector });
      if (Array.isArray(result.elements) && result.elements.length) return result.elements;
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${selector}`);
  }

  async function textOf(pageId, selector) {
    const [element] = await waitForElements(pageId, selector);
    const result = await send('Element.getDOMProperties', {
      pageId,
      elementId: element.elementId,
      nodeId: element.nodeId,
      names: ['innerText'],
    });
    return String(result.properties && result.properties[0] || '');
  }

  async function pageData(pageId) {
    const result = await send('Page.getData', { pageId });
    return result.data || {};
  }

  async function reLaunch(url) {
    await send('App.callWxMethod', { method: 'reLaunch', args: [{ url }] });
    return waitForPage(url.replace(/^\//, '').split('?')[0]);
  }

  async function navigateTo(url) {
    await send('App.callWxMethod', { method: 'navigateTo', args: [{ url }] });
    return waitForPage(url.replace(/^\//, '').split('?')[0]);
  }

  async function tapElement(pageId, element) {
    await miniProgram.send('Element.tap', {
      pageId,
      elementId: element.elementId,
      nodeId: element.nodeId,
    });
  }

  async function scrollTo(scrollTop) {
    await send('App.callWxMethod', { method: 'pageScrollTo', args: [{ scrollTop, duration: 0 }] });
    await delay(400);
  }

  async function capture(name) {
    const result = await send('App.captureScreenshot', { scale: 1 });
    assert.ok(result.data, 'App.captureScreenshot returned no PNG data');
    const output = path.join(artifactsDir, name);
    fs.writeFileSync(output, Buffer.from(String(result.data).replace(/^data:image\/png;base64,/, ''), 'base64'));
    const metadata = await sharp(output).metadata();
    assert.ok(
      Number(metadata.width) >= minimumViewport.width && Number(metadata.height) >= minimumViewport.height,
      `${name} is only ${metadata.width}×${metadata.height}; expected at least ${minimumViewport.width}×${minimumViewport.height}`,
    );
    console.log(`${name}: ${metadata.width}×${metadata.height}`);
    return output;
  }

  try {
    let page = await reLaunch('/packages/annual/pages/stations/stations?mode=self_drive');
    await waitForElements(page.pageId, '.station-card');
    assert.match(await textOf(page.pageId, '.heading'), /选择检测站/);
    await capture('stations-reference-363x785.png');

    page = await reLaunch('/packages/wash/pages/wash-stores/wash-stores');
    await waitForElements(page.pageId, '.wash-store-card');
    assert.match(await textOf(page.pageId, '.page-heading'), /选一家合适的洗车店/);
    assert.ok((await textOf(page.pageId, '.store-name')).trim(), 'Store name should be visible');
    await capture('wash-store-list-363x785.png');

    const [detailButton] = await waitForElements(page.pageId, '.detail-action');
    await tapElement(page.pageId, detailButton);
    await waitForElements(page.pageId, '.store-details');
    assert.match(await textOf(page.pageId, '.store-details'), /门店介绍/);
    await scrollTo(500);
    await capture('wash-store-details-363x785.png');

    page = await reLaunch('/packages/wash/pages/wash-booking/wash-booking');
    await waitForElements(page.pageId, '.store-card');
    const originalBookingData = await pageData(page.pageId);
    const originalStoreId = String(originalBookingData.selectedStore && originalBookingData.selectedStore.id || '');

    page = await navigateTo('/packages/wash/pages/wash-stores/wash-stores');
    await waitForElements(page.pageId, '.wash-store-card');
    const pickerData = await pageData(page.pageId);
    const stores = Array.isArray(pickerData.stores) ? pickerData.stores : [];
    const targetIndex = stores.findIndex((store) => store.hasCurrentVehicleOffer && store.id !== originalStoreId);
    const chosenIndex = targetIndex >= 0 ? targetIndex : stores.findIndex((store) => store.hasCurrentVehicleOffer);
    assert.ok(chosenIndex >= 0, 'No selectable wash store was available for return-state QA');
    const chosenStore = stores[chosenIndex];
    const selectButtons = await waitForElements(page.pageId, '.select-action');
    assert.ok(selectButtons[chosenIndex], `Missing select action for store index ${chosenIndex}`);
    await tapElement(page.pageId, selectButtons[chosenIndex]);

    page = await waitForPage('packages/wash/pages/wash-booking/wash-booking');
    await waitForElements(page.pageId, '.store-card');
    const selectedBookingData = await pageData(page.pageId);
    assert.equal(selectedBookingData.selectedStore && selectedBookingData.selectedStore.id, chosenStore.id);
    assert.match(await textOf(page.pageId, '.store-card'), new RegExp(chosenStore.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await scrollTo(430);
    await capture('wash-booking-selected-store-363x785.png');

    if (originalStoreId && originalStoreId !== chosenStore.id) {
      page = await navigateTo('/packages/wash/pages/wash-stores/wash-stores');
      await waitForElements(page.pageId, '.wash-store-card');
      const restoreData = await pageData(page.pageId);
      const restoreIndex = restoreData.stores.findIndex((store) => store.id === originalStoreId && store.hasCurrentVehicleOffer);
      if (restoreIndex >= 0) {
        const restoreButtons = await waitForElements(page.pageId, '.select-action');
        await tapElement(page.pageId, restoreButtons[restoreIndex]);
        await waitForPage('packages/wash/pages/wash-booking/wash-booking');
      }
    }

    console.log(`Wash store picker design QA passed: ${artifactsDir}`);
  } finally {
    miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
