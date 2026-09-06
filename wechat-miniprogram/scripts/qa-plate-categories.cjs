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
  for (const [key, value] of Object.entries(options)) {
    // cmd shims strip double quotes inside selectors; CSS single quotes survive
    // PowerShell's literal argument and remain valid in the simulator selector.
    args.push('--' + key, key === 'selector' || key === 'wait-for-selector' ? String(value).replaceAll('"', "'") : String(value));
  }
  const { stdout } = await exec(process.platform === 'win32' ? 'powershell.exe' : cli,
    process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', '& ' + [cli, ...args].map(quote).join(' ') + '; exit $LASTEXITCODE'] : args,
    { windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result?.success, true, JSON.stringify(response.result));
  return response.result;
}
const get = async (field) => (await tool('automation_page_action', { action: 'getData', 'data-path': field })).data;
const tap = (selector) => tool('automation_element_action', { action: 'tap', selector, 'wait-for-selector': selector });
const inputPlate = (value) => tool('automation_element_action', { action: 'input', selector: '.plate-free-input', value });
const category = (index) => {
  const detailFile = path.join(artifacts, 'qa-plate-picker-event.json');
  fs.writeFileSync(detailFile, JSON.stringify({ value: String(index) }));
  return tool('automation_element_action', { action: 'trigger', selector: '.category-picker', type: 'change', 'detail-file': detailFile, 'wait-for-selector': '.category-picker' });
};
async function run() {
  fs.mkdirSync(artifacts, { recursive: true });
  const status = await tool('check_wechatide_status', { 'skill-version': '0.3.9' }, false);
  assert.ok(['equal', 'agent_ahead'].includes(status.versionRelation));
  assert.equal(status.loginExpired, false);
  assert.equal(status.tokenRequired, false);
  await tool('automation_navigate', { action: 'reLaunch', url: '/packages/vehicle/pages/vehicle-form/vehicle-form' });
  assert.equal((await get('plateCategories')).length, 11);
  await category(10);
  assert.equal(await get('plateCategory'), 'new_energy_large_truck');
  await inputPlate('WJ12-D3F4I');
  assert.equal(await get('plateNumber'), 'WJ12-D3F4I');
  assert.equal(await get('plateComplete'), true);
  await tap('.powertrain-option[data-value="gasoline"]');
  assert.equal(await get('powertrainType'), 'gasoline');
  await tool('simulator_screenshot', { path: path.join(artifacts, 'qa-plate-large-new-energy.png'), optimize: false });
  console.log('Native large new-energy plate accepts letters/digits at all serial positions and an independently selected powertrain.');
  await tool('automation_navigate', { action: 'reLaunch', url: '/packages/vehicle/pages/vehicle-form/vehicle-form' });
  await category(8);
  assert.equal(await get('plateCategory'), 'yellow_trailer');
  assert.equal(await get('seats'), 0);
  await inputPlate('津A1234挂');
  assert.equal(await get('plateNumber'), '津A1234挂');
  assert.equal(await get('plateComplete'), true);
  await tool('simulator_screenshot', { path: path.join(artifacts, 'qa-plate-yellow-trailer.png'), optimize: false });
  console.log('Native trailer category, 0 seats, yellow plate rendering and 挂 key passed. No vehicle was submitted.');
}
run().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
