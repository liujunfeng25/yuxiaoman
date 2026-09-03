'use strict';

const path = require('node:path');
const automator = require('miniprogram-automator');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const artifactsDir = path.resolve(__dirname, '..', 'artifacts');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const miniProgram = await automator.launcher.connectTool({ wsEndpoint: endpoint });
  try {
    await miniProgram.callWxMethod('reLaunch', { url: '/packages/annual/pages/eligibility/eligibility' });
    await delay(2_000);
    const page = await miniProgram.currentPage();
    const calculate = await page.$('.calculate');
    if (!calculate) throw new Error('The annual-inspection result CTA was not rendered.');
    await calculate.tap();
    await delay(2_500);
    const result = await page.data('result');
    if (!result) throw new Error('The annual-inspection calculation did not produce a result.');
    await miniProgram.screenshot({ path: path.join(artifactsDir, 'eligibility-redesign-native-result.png') });
    console.log(`Eligibility calculation: ${result.title}`);
    console.log(`Eligibility booking enabled: ${Boolean(result.canBookInspection)}`);
  } finally {
    miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
