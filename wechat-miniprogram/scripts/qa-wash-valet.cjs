'use strict';

const fs = require('node:fs');
const path = require('node:path');
const automator = require('miniprogram-automator');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const output = path.resolve(__dirname, '..', 'artifacts', 'qa-smoke-wash-booking-valet.png');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function run() {
  const miniProgram = await automator.launcher.connectTool({ wsEndpoint: endpoint });
  let previousDraft;
  try {
    previousDraft = await miniProgram.callWxMethod('getStorageSync', 'yuxiaoman.washDraft');
    const response = await fetch('http://127.0.0.1:8792/api/locations/suggestions?query=' + encodeURIComponent('天津文化中心'));
    const payload = await response.json();
    const verifiedPickup = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!verifiedPickup || !verifiedPickup.locationProof) throw new Error('地址联想未返回服务端 locationProof');
    await miniProgram.callWxMethod('setStorageSync', 'yuxiaoman.washDraft', {
      serviceMode: 'valet',
      pickupAddress: {
        ...verifiedPickup,
        detail: 'B2-026',
        note: '从北门进入',
      },
    });
    await miniProgram.callWxMethod('reLaunch', { url: '/packages/wash/pages/wash-booking/wash-booking' });
    await delay(5_000);
    const page = await miniProgram.currentPage();
    const pickup = await page.$('.pickup-card');
    const fee = await page.$('.fee-card');
    const routeError = await page.$('.quote-error.blocked');
    if (!pickup) throw new Error('代驾取车地址未渲染');
    if (!fee && !routeError) throw new Error('代驾费用明细或真实路线失败状态均未渲染');
    const resultText = fee ? await fee.text() : await routeError.text();
    if (fee && (!resultText.includes('代驾取送费') || !resultText.includes('往返'))) throw new Error(`代驾报价明细不完整：${resultText}`);
    if (routeError && !['真实驾车路线', '服务范围', '计价规则'].some((label) => resultText.includes(label))) throw new Error(`代驾阻断说明不完整：${resultText}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await miniProgram.screenshot({ path: output });
    console.log(`Wash valet QA passed: ${output}`);
    console.log(resultText);
  } finally {
    if (previousDraft) await miniProgram.callWxMethod('setStorageSync', 'yuxiaoman.washDraft', previousDraft);
    else await miniProgram.callWxMethod('removeStorageSync', 'yuxiaoman.washDraft');
    miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
