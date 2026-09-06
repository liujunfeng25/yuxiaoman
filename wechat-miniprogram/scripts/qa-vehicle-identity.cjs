'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const automator = require('miniprogram-automator');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const apiBase = process.env.WECHAT_QA_API || 'http://127.0.0.1:8792/api';
const artifactsDir = path.resolve(__dirname, '..', 'artifacts');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${payload.error?.code || ''} ${payload.error?.message || response.statusText}`);
  return payload.data;
}

async function relaunch(miniProgram, url) {
  await miniProgram.callWxMethod('reLaunch', { url });
  await delay(2_000);
  const page = await miniProgram.currentPage();
  if (!page) throw new Error(`Unable to load ${url}`);
  return page;
}

async function run() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const vehicles = await api('/vehicles');
  const catalog = await api('/vehicle-catalog');
  const original = vehicles.find((vehicle) => vehicle.isDefault) || vehicles[0];
  if (!original) throw new Error('Vehicle identity QA needs one vehicle.');

  const originalSelection = original.brand && original.model
    ? { brandId: original.brand.id, modelId: original.model.id }
    : { brandId: null, modelId: null };
  let miniProgram;
  const issues = [];
  const assetBase = apiBase.replace(/\/api\/?$/, '');

  try {
    miniProgram = await automator.launcher.connectTool({ wsEndpoint: endpoint });
    EventEmitter.prototype.on.call(miniProgram, 'console', (message) => {
      const type = String(message?.type || '').toLowerCase();
      if (type === 'error' || type === 'assert') issues.push(`console:${type}`);
    });
    EventEmitter.prototype.on.call(miniProgram, 'exception', (exception) => issues.push(String(exception?.message || exception)));

    if (vehicles.length > 1) {
      let page = await relaunch(miniProgram, '/packages/vehicle/pages/vehicles/vehicles');
      const defaultActions = await page.$$('.default-action');
      assert.ok(defaultActions.length > 0, 'A non-current vehicle must offer “设为当前车辆”.');
      await defaultActions[0].tap();
      await delay(1_000);
      const switchedVehicles = await api('/vehicles');
      assert.equal(switchedVehicles.find((vehicle) => vehicle.isDefault)?.id, vehicles.find((vehicle) => !vehicle.isDefault).id);
      await api(`/vehicles/${encodeURIComponent(original.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
    }

    let page = await relaunch(miniProgram, `/packages/vehicle/pages/vehicle-form/vehicle-form?id=${encodeURIComponent(original.id)}`);
    const preview = await page.$('.vehicle-identity-preview');
    assert.ok(preview, 'Vehicle identity preview must be rendered.');
    await preview.tap();
    await delay(1_000);

    const brandButtons = await page.$$('.brand-selector button');
    const visibleBrands = await page.data('catalogBrandOptions');
    assert.equal(brandButtons.length, visibleBrands.length, 'Catalog must render every presentation-ready brand.');
    assert.ok(brandButtons.length > 0 && brandButtons.length <= catalog.brands.length,
      'The visual picker must contain only catalog brands with presentation-ready models.');
    const search = await page.$('.catalog-search input');
    assert.ok(search, 'Catalog search must be rendered.');
    await search.input('斯巴鲁');
    await delay(300);
    const subaruModels = await page.data('activeModels');
    const modelButtons = await page.$$('.model-selector button');
    assert.equal(modelButtons.length, subaruModels.length, 'Rendered Subaru choices must match current catalog data.');
    const foresterIndex = subaruModels.findIndex((model) => model.id === 'vehicle-subaru-forester');
    assert.ok(foresterIndex >= 0, 'The Forester presentation model must remain selectable.');
    await miniProgram.screenshot({ path: path.join(artifactsDir, 'qa-vehicle-catalog-sheet.png') });
    await modelButtons[foresterIndex].tap();
    await delay(800);
    assert.equal(await page.data('selectedBrandName'), '斯巴鲁');
    assert.equal(await page.data('selectedModelName'), '森林人');
    assert.equal(await page.data('selectedModelImage'), `${assetBase}/assets/used-cars/owner-presentation-v2/vehicle-subaru-forester.webp`);
    const useModel = await page.$('.catalog-heading > button');
    assert.ok(useModel, 'Selected model must require an explicit confirmation.');
    await useModel.tap();
    await delay(300);
    await miniProgram.screenshot({ path: path.join(artifactsDir, 'qa-vehicle-form-subaru-forester-preview.png') });

    await api(`/vehicles/${encodeURIComponent(original.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ brandId: 'brand-subaru', modelId: 'vehicle-subaru-forester' }),
    });

    page = await relaunch(miniProgram, '/pages/home/home');
    const homeData = await page.data();
    assert.equal(homeData.hero.vehicleCopy, '斯巴鲁 森林人');
    assert.equal(homeData.hero.vehicleImage, `${assetBase}/assets/used-cars/owner-presentation-v2/vehicle-subaru-forester.webp`);
    await miniProgram.screenshot({ path: path.join(artifactsDir, 'qa-home-subaru-forester.png') });

    page = await relaunch(miniProgram, '/packages/annual/pages/eligibility/eligibility');
    const eligibilityData = await page.data();
    assert.equal(eligibilityData.selectedVehicleName, '斯巴鲁 森林人');
    assert.equal(eligibilityData.selectedVehicleImage, `${assetBase}/assets/used-cars/owner-presentation-v2/vehicle-subaru-forester.webp`);
    await miniProgram.screenshot({ path: path.join(artifactsDir, 'qa-eligibility-subaru-forester.png') });

    if (issues.length) throw new Error(`Captured mini-program issues: ${issues.join(', ')}`);
    console.log('Vehicle identity QA passed: picker preview, API persistence, home and eligibility stayed synchronized.');
  } finally {
    try {
      await api(`/vehicles/${encodeURIComponent(original.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...originalSelection, isDefault: true }),
      });
    } finally {
      if (miniProgram) miniProgram.disconnect();
    }
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
