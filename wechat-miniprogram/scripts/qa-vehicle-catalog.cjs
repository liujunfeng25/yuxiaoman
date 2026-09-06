'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const project = path.resolve(__dirname, '..');
const artifacts = path.join(project, 'artifacts');
const cli = process.env.WECHATIDE_CLI || 'wechatide';
const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";

async function tool(name, options = {}, includeProject = true) {
  const args = ['-c', 'Codex', name];
  if (includeProject) args.push('--project', project);
  for (const [key, value] of Object.entries(options)) args.push('--' + key, String(value));
  const command = process.platform === 'win32' ? 'powershell.exe' : cli;
  const commandArgs = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', '& ' + [cli, ...args].map(quote).join(' ') + '; exit $LASTEXITCODE']
    : args;
  const { stdout } = await exec(command, commandArgs, { windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  const start = stdout.indexOf('{');
  assert.ok(start >= 0, `No structured response from ${name}`);
  const response = JSON.parse(stdout.slice(start));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result?.success, true, JSON.stringify(response.result));
  return response.result;
}
const get = async (field) => (await tool('automation_page_action', { action: 'getData', 'data-path': field })).data;
const tap = (selector) => tool('automation_element_action', { action: 'tap', selector, 'wait-for-selector': selector });
const input = (value) => tool('automation_element_action', { action: 'input', selector: '.catalog-search input', value });
const screenshot = (name) => tool('simulator_screenshot', { path: path.join(artifacts, name), optimize: false });
const currentPage = async () => (await tool('automation_runtime_info', { action: 'currentPage' })).currentPage;
const editorPath = 'packages/vehicle/pages/vehicle-form/vehicle-form';
const category = (index) => {
  const detailFile = path.join(artifacts, 'qa-catalog-category-event.json');
  fs.writeFileSync(detailFile, JSON.stringify({ value: String(index) }));
  return tool('automation_element_action', { action: 'trigger', selector: '.category-picker', type: 'change', 'detail-file': detailFile, 'wait-for-selector': '.category-picker' });
};

async function run() {
  fs.mkdirSync(artifacts, { recursive: true });
  const status = await tool('check_wechatide_status', { 'skill-version': '0.3.9' }, false);
  assert.ok(['equal', 'agent_ahead'].includes(status.versionRelation), 'Load the current WeChat IDE skill before running UI QA');
  assert.equal(status.loginExpired, false, 'WeChat IDE login is required');
  assert.equal(status.tokenRequired, false, 'This runner needs an authorized CLI session without a required access token');
  await tool('automation_navigate', { action: 'reLaunch', url: '/packages/vehicle/pages/vehicle-form/vehicle-form' });
  assert.equal((await currentPage()).path, editorPath);
  await tap('.vehicle-identity-preview');
  const summary = await tool('automation_page_action', { action: 'getData', 'data-path': 'catalogMatchCount', 'wait-for-selector': '.catalog-browser' });
  assert.ok(summary.data > 0);
  const initialBrandCount = (await get('catalogBrandOptions')).length;
  assert.ok(initialBrandCount > 0);
  await tap('.brand-selector button[data-id="brand-volkswagen"]');
  assert.equal(await get('activeBrandId'), 'brand-volkswagen');
  assert.equal((await currentPage()).path, editorPath);
  await screenshot('qa-vehicle-catalog-expanded.png');
  console.log('Native catalog loaded with the reviewed fixed-angle presentation set.');

  await input('斯巴鲁');
  const subaruModels = await get('activeModels');
  const forester = subaruModels.find((model) => model.id === 'vehicle-subaru-forester');
  assert.ok(forester);
  assert.equal(forester.imageKind, 'presentation_cutout');
  assert.match(forester.imageUrl, /\/assets\/used-cars\/owner-presentation-v2\//);
  await screenshot('qa-vehicle-catalog-subaru-real-models.png');
  await tap('.model-grid > button[data-id="vehicle-subaru-forester"]');
  assert.equal(await get('selectedModelName'), '森林人');
  assert.match(await get('selectedModelImage'), /vehicle-subaru-forester\.webp$/);
  assert.equal(await get('catalogOpen'), true);
  assert.equal((await currentPage()).path, editorPath, 'model tap must keep the vehicle editor as the current page');
  await tap('.catalog-heading > button');
  assert.equal(await get('catalogOpen'), false);
  assert.equal((await currentPage()).path, editorPath, 'confirming a model must not navigate away');
  await screenshot('qa-vehicle-form-subaru-forester-preview.png');
  await tap('.vehicle-identity-preview');

  await input('大众途观L');
  assert.equal(await get('catalogMatchCount'), 1);
  assert.equal((await get('activeModels'))[0].id, 'vehicle-volkswagen-tiguan-l');
  await screenshot('qa-vehicle-catalog-search.png');
  await tap('.model-grid > button');
  assert.equal(await get('selectedModelName'), '途观L');
  assert.match(await get('selectedModelImage'), /owner-presentation-v2\/vehicle-volkswagen-tiguan-l\.webp$/);
  assert.equal(await get('catalogOpen'), true);
  await tap('.keyboard-mask');
  assert.equal(await get('catalogOpen'), false);
  assert.equal((await currentPage()).path, editorPath, 'dismissing the sheet must not navigate away');
  await tap('.vehicle-identity-preview');
  assert.equal(await get('catalogQuery'), '');
  assert.equal(await get('activeBrandId'), 'brand-volkswagen');
  console.log('Chinese search, model selection and reopen passed.');

  await input('MODEL-Y');
  assert.ok((await get('activeModels')).some((model) => model.id === 'vehicle-tesla-model-y'));
  await input('没有这个车型');
  assert.equal(await get('catalogMatchCount'), 0);
  await tap('.catalog-empty button');
  assert.equal((await get('catalogBrandOptions')).length, initialBrandCount);
  await tap('.clear-catalog');
  assert.equal(await get('selectedModelId'), '');

  await tap('.exterior-color-option[data-value="蓝色"]');
  assert.equal(await get('exteriorColor'), '蓝色');
  await screenshot('qa-vehicle-passenger-color.png');
  await category(2);
  assert.equal(await get('plateCategory'), 'blue_small_truck');
  assert.equal(await get('passengerColorEnabled'), false);
  assert.equal(await get('exteriorColor'), '');
  await tap('.vehicle-identity-preview');
  await input('帅铃');
  const lightTrucks = await get('activeModels');
  assert.ok(lightTrucks.length > 0);
  assert.ok(lightTrucks.every((model) => model.vehicleClassCodes.includes('small_truck') && model.imageKind === 'presentation_cutout'));
  await screenshot('qa-vehicle-catalog-light-trucks.png');
  await tap('.clear-catalog');

  await category(8);
  await tap('.vehicle-identity-preview');
  const trailers = await get('activeModels');
  assert.equal(await get('activeBrandId'), 'brand-trailer-body');
  assert.ok(trailers.length > 0);
  assert.ok(trailers.every((model) => model.vehicleClassCodes.includes('trailer') && model.imageKind === 'presentation_cutout'));
  await screenshot('qa-vehicle-catalog-trailers.png');
  await tap('.clear-catalog');
  await tap('.vehicle-identity-preview');
  console.log('Native catalog QA passed: fixed-angle passenger/commercial presentation assets, color, class filtering, search, selection and clearing. No vehicle was submitted.');
}
run().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
