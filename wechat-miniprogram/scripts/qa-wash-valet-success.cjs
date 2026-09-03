'use strict';

const fs = require('node:fs');
const path = require('node:path');
const automator = require('miniprogram-automator');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const output = path.resolve(__dirname, '..', 'artifacts', 'qa-wash-valet-success.png');
const draftKey = 'yuxiaoman.washDraft';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function run() {
  const miniProgram = await automator.launcher.connectTool({ wsEndpoint: endpoint });
  let previousDraft;
  try {
    previousDraft = await miniProgram.callWxMethod('getStorageSync', draftKey);
    await miniProgram.callWxMethod('removeStorageSync', draftKey);
    await miniProgram.callWxMethod('reLaunch', { url: '/packages/wash/pages/wash-booking/wash-booking' });
    await delay(4_000);
    const page = await miniProgram.currentPage();
    const data = await page.data();
    if (!data.selectedVehicle || !data.selectedStore || !data.selectedPackage || !data.selectedSlot) {
      throw new Error('洗车基础预约数据未就绪，无法注入视觉验收状态');
    }
    const pickupAddress = {
      poiId: 'qa-success-pickup',
      title: '滨海视觉验收取车点',
      address: '天津市滨海新区第二大街演示停车场',
      district: '滨海新区',
      latitude: 39.0229,
      longitude: 117.5728,
      source: 'demo',
      locationProof: 'qa-page-set-data-only-not-submitted',
      detail: 'B2-026',
      note: '从北门进入',
    };
    await page.setData({
      serviceMode: 'valet',
      pickupAddress,
      addressQuery: '',
      suggestions: [],
      quoteLoading: false,
      quoteError: '',
      quoteErrorCode: '',
      quoteBlocked: false,
      quote: {
        serviceType: 'car_wash',
        vehicleId: data.selectedVehicle.id,
        storeId: data.selectedStore.id,
        packageId: data.selectedPackage.id,
        slotId: data.selectedSlot.id,
        packageName: data.selectedPackage.name,
        serviceMode: 'valet',
        tripType: 'round_trip_same_address',
        serviceable: true,
        washFeeFen: 3800,
        valetFeeFen: 7100,
        serviceFeeFen: 3800,
        totalFeeFen: 10900,
        pickupAddress,
        oneWayDistanceKm: 11.7,
        roundTripDistanceKm: 23.4,
        billableDistanceKm: 11.7,
        driveMinutes: 24,
        extraKm: 4,
        distanceSource: 'tencent_matrix',
        distanceBasis: 'driving_route',
        valetRule: {
          scope: 'global',
          storeId: null,
          baseFeeFen: 5900,
          includedKm: 8,
          perKmFen: 300,
          maxRadiusKm: 25,
          updatedAt: '2026-08-19T00:00:00.000Z',
          version: 'qa-ui-only',
        },
        breakdown: {
          washFeeFen: 3800,
          valetBaseFeeFen: 5900,
          valetDistanceFeeFen: 1200,
          valetFeeFen: 7100,
          totalFeeFen: 10900,
        },
        quoteSnapshotId: 'qa-ui-only',
        expiresAt: '2026-08-19T00:10:00.000Z',
      },
    });
    await delay(800);
    const fee = await page.$('.fee-card');
    if (!fee) throw new Error('成功报价卡未渲染');
    const feeText = await fee.text();
    for (const expected of ['¥38', '¥71', '¥109', '11.7 km', '23.4 km', '25 km']) {
      if (!feeText.includes(expected)) throw new Error(`成功报价视觉状态缺少 ${expected}：${feeText}`);
    }
    const offset = await fee.offset();
    await miniProgram.pageScrollTo(Math.max(0, offset.top - 170));
    await delay(500);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await miniProgram.screenshot({ path: output });
    console.log(`Wash valet success visual QA passed: ${output}`);
    console.log(feeText);
  } finally {
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
