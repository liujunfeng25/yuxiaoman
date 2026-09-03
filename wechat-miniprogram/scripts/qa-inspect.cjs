'use strict';

const automator = require('miniprogram-automator');

const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const route = process.argv[2] || '/pages/home/home';
const selectors = process.argv.slice(3);
const targets = selectors.length
  ? selectors
  : ['.home-brand-row', '.inspection-hero', '.flow-section', '.flow-step', '.services-section'];

async function run() {
  const miniProgram = await automator.launcher.connectTool({ wsEndpoint: endpoint });

  try {
    await miniProgram.callWxMethod('reLaunch', { url: route });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const page = await miniProgram.currentPage();
    const result = { path: page.path, query: page.query, selectors: {} };

    for (const selector of targets) {
      const elements = await page.$$(selector);
      result.selectors[selector] = [];
      for (const element of elements) {
        result.selectors[selector].push({
          size: await element.size(),
          offset: await element.offset(),
          style: {
            display: await element.style('display'),
            width: await element.style('width'),
            minWidth: await element.style('min-width'),
            maxWidth: await element.style('max-width'),
            marginLeft: await element.style('margin-left'),
            marginRight: await element.style('margin-right'),
          },
          text: await element.text(),
        });
      }
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
