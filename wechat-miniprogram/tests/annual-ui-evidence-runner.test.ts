import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(currentDirectory, "../scripts/qa-annual-booking-e2e.cjs");
const source = readFileSync(runnerPath, "utf8");

test("年检原生 QA 的上传证据截图会定位上传网格并核验完成槽位与计数", () => {
  assert.match(source, /async function frameBookingUploadEvidence/u);
  assert.match(source, /waitForElement\(booking, '\.media-section'/u);
  assert.match(source, /mediaSection\.\$\('\.required-count'\)/u);
  assert.match(source, /booking\.\$\$\('\.upload-card\.complete'\)/u);
  assert.match(source, /miniProgram\.pageScrollTo\(Math\.max\(0, sectionTop - 16\)\)/u);
  assert.match(
    source,
    /frameBookingUploadEvidence\(miniProgram, booking, scenarioName, uploadedKinds\.length\);\s*await capture\(miniProgram, scenarioName, '04-two-uploads-retained'\)/u,
  );
  assert.match(
    source,
    /frameBookingUploadEvidence\(miniProgram, booking, scenarioName, uploadedKinds\.length\);\s*await capture\(miniProgram, scenarioName, '05-all-uploads-retained'\)/u,
  );
});

test("代驾站点搜索在输入测试地址前显式清空，避免残留 undefined", () => {
  assert.match(source, /await searchInput\.input\(''\)/u);
  assert.match(source, /waitForPageData\(stations, 'searchQuery', \(value\) => value === ''/u);
  assert.match(source, /await searchInput\.input\(pickupQuery\)/u);
});

test("检测站列表在页面、数据和全部卡片落稳后再截图，避免转场叠帧", () => {
  assert.match(source, /async function waitForStationPickerSettled\(miniProgram, stations, expectedCount\)/u);
  assert.match(source, /currentPage\(miniProgram, STATIONS_ROUTE, 'settled inspection station picker'\)/u);
  assert.match(source, /waitForPageData\(stations, 'loading', \(value\) => value === false, 'Waiting for settled inspection stations'\)/u);
  assert.match(source, /cards\.length !== expectedCount/u);
  assert.match(source, /Promise\.all\(cards\.map\(\(card\) => card\.size\(\)\)\)/u);
  assert.match(source, /await delay\(900\)/u);
  assert.match(source, /currentPage\(miniProgram, STATIONS_ROUTE, 'stable inspection station picker'\)/u);
  assert.match(
    source,
    /waitForStationPickerSettled\(miniProgram, stations, stationItems\.length\);\s*await capture\(miniProgram, scenarioName, '02-station-picker'\)/u,
  );
});

test("年检演示备注使用面向业务的纯中文场景名，不暴露自动化内部标识", () => {
  assert.match(source, /noteLabel: '自驾验车'/u);
  assert.match(source, /noteLabel: '代驾验车'/u);
  assert.match(source, /`全流程演示 · \$\{definition\.noteLabel\}`/u);
  assert.doesNotMatch(source, /原生点击回归/u);
  assert.doesNotMatch(source, /noteInput\.input\(`[^`]*\$\{scenarioName\}`\)/u);
});

test("取证截图前关闭瞬时 toast，避免遮挡关键页面内容", () => {
  assert.match(source, /callWxMethod\('hideToast'\)/u);
  assert.match(source, /await delay\(120\)/u);
});

test("年检 QA 不保存司机验证码，并只截取后台代驾留证模块", () => {
  assert.doesNotMatch(source, /08-admin-driver-assigned\.png/u);
  assert.match(source, /let screenshotTarget = drawer/u);
  assert.match(source, /screenshotTarget = evidence/u);
  assert.match(
    source,
    /await screenshotTarget\.screenshot\(\{ path: path\.join\(artifactsDir, `\$\{scenarioName\}-18-admin-final-detail\.png`\) \}\)/u,
  );
});

test("代驾故障特写复用站内右后留证素材键", () => {
  assert.match(source, /rear_right: 'rearRight\.jpg'/u);
  assert.match(source, /resolveSiteAsset\(scenarioName, 'rear_right'\)/u);
  assert.doesNotMatch(source, /resolveSiteAsset\(scenarioName, 'rearRight'\)/u);
});

test("年检 QA 会在上传故障特写前保存故障编辑弹层布局证据", () => {
  assert.match(
    source,
    /faultDescription\.input\([\s\S]*capture\(miniProgram, scenarioName, '13a-fault-editor-layout'\)[\s\S]*resolveSiteAsset\(scenarioName, 'rear_right'\)/u,
  );
});
