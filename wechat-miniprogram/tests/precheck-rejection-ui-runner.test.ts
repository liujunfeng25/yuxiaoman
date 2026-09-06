import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(currentDirectory, "../scripts/qa-precheck-rejection-e2e.cjs");
const source = readFileSync(runnerPath, "utf8");

test("预检退回 QA 只从渲染控件推进业务，不直调业务接口或页面方法", () => {
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\baxios\b|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/u);
  assert.doesNotMatch(source, /\bapi\.|page\.callMethod|page\.setData|miniProgram\.evaluate|setStorage/u);
  assert.match(source, /\.self-drive-job/u);
  assert.match(source, /\.submit-bar > button/u);
  assert.match(source, /\.pay-button/u);
  assert.match(source, /\.workflow-task/u);
  assert.match(source, /\.action-bar \.reject/u);
  assert.match(source, /\.confirm-reject/u);
  assert.match(source, /\.footer \.primary/u);
  assert.match(source, /\.action-bar \.approve/u);
});

test("预检退回 QA 固定核验七张预约资料并只替换检测站标注的车身和仪表盘", () => {
  for (const kind of [
    "vehicle_front_left",
    "vehicle_front_right",
    "vehicle_rear_left",
    "vehicle_rear_right",
    "dashboard_started",
    "license_front",
    "license_back",
  ]) {
    assert.match(source, new RegExp(`['\"]${kind}['\"]`, "u"));
  }
  assert.match(source, /const issuePhotoKinds = Object\.freeze\(\['vehicle_rear_right', 'dashboard_started'\]\)/u);
  assert.match(source, /assertExactKinds\(booking\.media, mediaKinds, 'Second station current media'\)/u);
  assert.match(source, /assertExactKinds\(photos, mediaKinds, 'Second station rendered photos'\)/u);
  assert.match(source, /photos\.some\(\(item\) => !item\.url\)/u);
});

test("检测站真实点击退回会选择脏污、车损、故障灯及两张对应照片，并点击原生确认框", () => {
  assert.match(source, /\['body_dirty', 'body_damage', 'dashboard_warning'\]/u);
  assert.match(source, /elementByAttribute\(precheck, '\.reason-grid button', 'data-code', code/u);
  assert.match(source, /elementByAttribute\(precheck, '\.photo-tags button', 'data-kind', kind/u);
  assert.match(source, /await button\.tap\(\)/u);
  assert.match(source, /\.reject-sheet textarea/u);
  assert.match(source, /miniProgram\.native\(\)\.confirmModal\(\)/u);
  assert.doesNotMatch(source, /mockWxMethod\(['"]showModal/u);
});

test("车主通过真实入口进入洗车与多店维修，并从维修详情点回问题处理页", () => {
  assert.match(source, /\.precheck-owner-card \.pay-button/u);
  assert.match(source, /\.service-card button/u);
  assert.match(source, /miniProgram\.native\(\)\.navigateLeft\(\)/u);
  assert.match(source, /\.repair-card \.consent/u);
  assert.match(source, /\.repair-card \.primary/u);
  assert.match(source, /request\.sourceType !== 'precheck'/u);
  assert.match(source, /request\.sourceBookingId !== bookingId/u);
  assert.match(source, /\.request-card button/u);
  assert.match(source, /item\?\.type === 'repair' && item\?\.status === 'open'/u);
});

test("补传说明改期重提由页面控件完成，并核验付款、时段与媒体替换", () => {
  assert.match(source, /elementByAttribute\(actions, '\.photo-grid button', 'data-kind', kind/u);
  assert.match(source, /await button\.tap\(\)/u);
  assert.match(source, /waitForElement\(actions, 'textarea', 'owner resolution note'\)/u);
  assert.match(source, /waitForElement\(actions, 'picker', 'Huayang replacement-slot picker'\)/u);
  assert.match(source, /picker\.trigger\('change', \{ value: String\(nextSlotIndex\) \}\)/u);
  assert.match(source, /await submit\.tap\(\)/u);
  assert.match(source, /Number\(released\.remaining\) !== Number\(originalSlot\.remaining\)/u);
  assert.match(source, /Number\(booking\.paidFen\) !== feeFen/u);
  assert.match(source, /currentIds\.get\(kind\) !== replacementIds\.get\(kind\)/u);
});

test("首轮待办关闭、复核待办唯一重开并在通过后关闭，终态不重复接单", () => {
  assert.match(source, /matches\.length !== 1/u);
  assert.match(source, /matches\.length !== 0/u);
  assert.match(source, /secondTaskId === firstTaskId/u);
  assert.match(source, /pendingTaskReopenedWithoutDuplicate: firstTaskId !== secondTaskId/u);
  assert.match(source, /finalPendingTaskClosed: true/u);
  assert.match(source, /value\?\.status === 'awaiting_arrival'/u);
  assert.match(source, /'检测站预审通过', 'awaiting_arrival', 'operator'/u);
  assert.match(source, /event\?\.title === '等待车辆到站'/u);
});

test("QA 凭据只从环境变量读取且不会进入截图名或运行摘要", () => {
  assert.match(source, /process\.env\.WECHAT_QA_OPERATOR_LOGIN/u);
  assert.match(source, /process\.env\.WECHAT_QA_OPERATOR_PASSWORD/u);
  assert.doesNotMatch(source, /result\.local\.json|credentials\?\.|stationAdmin/u);
  assert.match(source, /function redact\(value\)/u);
  assert.match(source, /\[operatorPassword, operatorLogin\]/u);
  assert.doesNotMatch(source, /operator(?:Login|Password)\s*:/u);
  assert.doesNotMatch(source, /capture\([^\n]*(login|credential|password)/iu);
});

test("仅 mock 系统媒体选择和定位，业务确认继续走原生弹窗", () => {
  const mockedMethods = [...source.matchAll(/mockWxMethod\('([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(mockedMethods)].sort(), ["chooseMedia", "getLocation"]);
  assert.match(source, /restoreWxMethod\('chooseMedia'\)/u);
  assert.match(source, /restoreWxMethod\('getLocation'\)/u);
});
