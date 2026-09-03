'use strict';

const automator = require('miniprogram-automator');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const draftKey = 'yuxiaoman.washDraft';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function run() {
  const miniProgram = await automator.launcher.connectTool({ wsEndpoint: endpoint });
  let previousDraft;
  try {
    previousDraft = await miniProgram.callWxMethod('getStorageSync', draftKey);
    const response = await fetch('http://127.0.0.1:8792/api/locations/suggestions?query=' + encodeURIComponent('天津文化中心'));
    const payload = await response.json();
    const candidate = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!candidate || !candidate.locationProof) throw new Error('地址联想未返回带凭证候选');

    await miniProgram.callWxMethod('removeStorageSync', draftKey);
    await miniProgram.callWxMethod('reLaunch', { url: '/packages/wash/pages/wash-booking/wash-booking' });
    await delay(3_500);
    let page = await miniProgram.currentPage();
    const modes = await page.$$('.mode-option');
    if (!modes[1]) throw new Error('代驾方式入口未渲染');
    await modes[1].tap();
    await delay(500);

    const rawMapPoint = {
      name: candidate.title,
      address: candidate.address,
      latitude: Number(candidate.latitude) + 0.0002,
      longitude: Number(candidate.longitude) + 0.0002,
    };
    await miniProgram.mockWxMethod('chooseLocation', rawMapPoint);
    const mapAction = await page.$('.map-action');
    if (!mapAction) throw new Error('地图选点入口未渲染');
    await mapAction.tap();
    await delay(4_000);
    page = await miniProgram.currentPage();
    const data = await page.data();
    const selected = data.pickupAddress;
    if (!selected || !selected.locationProof) throw new Error('地图选点后未使用带凭证的服务端候选');
    if (Number(selected.latitude) === rawMapPoint.latitude || Number(selected.longitude) === rawMapPoint.longitude) {
      throw new Error('地图裸坐标被直接写入取车地址');
    }
    if (Math.abs(Number(selected.latitude) - Number(candidate.latitude)) > 0.001
      || Math.abs(Number(selected.longitude) - Number(candidate.longitude)) > 0.001) {
      throw new Error('地图选点未匹配到附近服务端候选');
    }
    console.log(`Wash map proof QA passed: ${selected.title} · proof ${String(selected.locationProof).length} chars`);
  } finally {
    await miniProgram.restoreWxMethod('chooseLocation').catch(() => undefined);
    if (previousDraft) await miniProgram.callWxMethod('setStorageSync', draftKey, previousDraft);
    else await miniProgram.callWxMethod('removeStorageSync', draftKey);
    await miniProgram.callWxMethod('reLaunch', { url: '/packages/wash/pages/wash-booking/wash-booking' });
    miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
