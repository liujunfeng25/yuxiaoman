import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DRIVER_PHOTO_SLOTS,
  canStartReturn,
  driverTaskTerminal,
  driverWritableStage,
  normalizeDriverSession,
  normalizeDriverTask,
} from "../miniprogram/packages/driver/model";
import {
  driverPhoneReady,
  driverVerificationCodeGroups,
  driverVerificationCodeReady,
  normalizeDriverPhone,
  normalizeDriverVerificationCode,
} from "../miniprogram/packages/driver/login-model";

function serverTask(status: string, completedStages: string[] = []) {
  return normalizeDriverTask({
    taskId: "assignment-1",
    bookingId: "booking-1",
    bookingNumber: "YXM202608250001",
    status,
    appointmentDate: "2026-08-25",
    startTime: "09:00",
    endTime: "10:00",
    vehicle: { plateNumber: "津A·V826Q", brandName: "银河", modelName: "E8", vehicleType: "小型轿车" },
    owner: { contactName: "孙先生", contactPhone: "13800001006" },
    pickupAddress: { title: "取车点", address: "天津市河西区测试路 1 号", latitude: 39.1, longitude: 117.2 },
    station: { id: "station-1", name: "河西机动车检测站", address: "天津市河西区检测路 8 号", latitude: 39.2, longitude: 117.3 },
    driverAssignment: {
      id: "assignment-1",
      receptionistName: "王师傅",
      receptionistPhone: "13800138000",
      driverName: "王师傅",
      driverPhone: "13800138000",
      status: "bound",
    },
    evidencePackages: ["owner_pickup", "station_arrival", "inspection_complete", "owner_return"].map((stage) => ({
      id: `package-${stage}`,
      stage,
      status: completedStages.includes(stage) ? "completed" : "pending",
      capturedAt: completedStages.includes(stage) ? "2026-08-25T01:00:00.000Z" : null,
      photos: completedStages.includes(stage)
        ? DRIVER_PHOTO_SLOTS.map((slot) => ({ id: `${stage}-${slot.kind}`, kind: slot.kind, url: `/api/media/${stage}/${slot.kind}` }))
        : [],
    })),
  });
}

test("任务码只兑换独立 driver session 所需的最小凭证", () => {
  assert.deepEqual(normalizeDriverSession({
    token: "yxm_drv_opaque",
    expiresAt: "2026-08-25T12:00:00.000Z",
    taskId: "assignment-1",
    bookingId: "booking-1",
  }), {
    token: "yxm_drv_opaque",
    expiresAt: "2026-08-25T12:00:00.000Z",
    taskId: "assignment-1",
    bookingId: "booking-1",
  });
});

test("司机只在取车与送回节点获得写权限，返程依赖检测完成留证", () => {
  assert.equal(driverWritableStage(serverTask("driver_arranged")), "owner_pickup");
  assert.equal(driverWritableStage(serverTask("picked_up", ["owner_pickup"])), null);
  assert.equal(canStartReturn(serverTask("result_received", ["owner_pickup", "station_arrival"])), false);
  assert.equal(canStartReturn(serverTask("result_received", ["owner_pickup", "station_arrival", "inspection_complete"])), true);
  assert.equal(driverWritableStage(serverTask("returning", ["owner_pickup", "station_arrival", "inspection_complete"])), "owner_return");
  assert.equal(driverTaskTerminal(serverTask("completed", ["owner_pickup", "station_arrival", "inspection_complete", "owner_return"])), true);
});

test("五张照片齐全但服务端尚未完成时仍保留节点提交权限", () => {
  const task = normalizeDriverTask({
    taskId: "assignment-1",
    bookingId: "booking-1",
    status: "driver_arranged",
    evidencePackages: [{
      id: "package-owner-pickup",
      stage: "owner_pickup",
      status: "pending",
      photos: DRIVER_PHOTO_SLOTS.map((slot) => ({
        id: `owner_pickup-${slot.kind}`,
        kind: slot.kind,
        url: `/api/media/owner_pickup/${slot.kind}`,
      })),
    }],
  });

  assert.equal(task.evidencePackages[0].status, "in_progress");
  assert.equal(task.evidencePackages[0].photos.length, 5);
  assert.equal(driverWritableStage(task), "owner_pickup");
});

test("四个留证节点统一使用四角与启动后仪表盘五个稳定槽位", () => {
  assert.deepEqual(DRIVER_PHOTO_SLOTS.map((slot) => slot.kind), [
    "front_left",
    "front_right",
    "rear_left",
    "rear_right",
    "dashboard_started",
  ]);
  const task = serverTask("completed", ["owner_pickup", "station_arrival", "inspection_complete", "owner_return"]);
  assert.deepEqual(task.evidencePackages.map((item) => item.photos.length), [5, 5, 5, 5]);
});

test("代驾验证码严格清洗为六位数字并按 3-3 分组显示", () => {
  assert.equal(normalizeDriverVerificationCode(" 12a34-5678 "), "123456");
  assert.equal(driverVerificationCodeReady("12345"), false);
  assert.equal(driverVerificationCodeReady("123 456"), true);
  assert.deepEqual(driverVerificationCodeGroups("12"), ["1 2 ·", "· · ·"]);
  assert.deepEqual(driverVerificationCodeGroups("123456"), ["1 2 3", "4 5 6"]);
});

test("代驾手机号清洗为 11 位并校验大陆号段", () => {
  assert.equal(normalizeDriverPhone(" 138-0013-8000x "), "13800138000");
  assert.equal(driverPhoneReady("1380013800"), false);
  assert.equal(driverPhoneReady("23800138000"), false);
  assert.equal(driverPhoneReady("13800138000"), true);
});

test("我的页面固定工作人员入口并分流到检测站、维修门店与代驾端", () => {
  const manifest = readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8");
  const profilePage = readFileSync(new URL("../miniprogram/pages/profile/profile.ts", import.meta.url), "utf8");
  const profileMarkup = readFileSync(new URL("../miniprogram/pages/profile/profile.wxml", import.meta.url), "utf8");
  const profileStyle = readFileSync(new URL("../miniprogram/pages/profile/profile.wxss", import.meta.url), "utf8");
  const staffPage = readFileSync(new URL("../miniprogram/packages/operator/pages/staff-entry/staff-entry.ts", import.meta.url), "utf8");
  const staffMarkup = readFileSync(new URL("../miniprogram/packages/operator/pages/staff-entry/staff-entry.wxml", import.meta.url), "utf8");

  assert.match(manifest, /pages\/staff-entry\/staff-entry/u);
  assert.match(manifest, /"root":\s*"packages\/driver"[\s\S]*pages\/login\/login[\s\S]*pages\/task\/task/u);
  assert.match(profilePage, /enterStaff\(\)[\s\S]*packages\/operator\/pages\/staff-entry\/staff-entry/u);
  assert.match(profileMarkup, /staff-entry-dock[\s\S]*工作人员入口[\s\S]*检测站履约 · 维修报价 · 代驾任务/u);
  assert.match(profileStyle, /\.staff-entry-dock\s*\{[^}]*position:\s*fixed[^}]*env\(safe-area-inset-bottom\)/u);
  assert.match(staffPage, /enterStation\(\)[\s\S]*operator-login[\s\S]*enterRepair\(\)[\s\S]*shop-login[\s\S]*enterDriver\(\)[\s\S]*packages\/driver\/pages\/login\/login/u);
  assert.match(staffMarkup, /检测站端[\s\S]*账号登录[\s\S]*维修门店端[\s\S]*账号登录[\s\S]*代驾端[\s\S]*6 位验证码/u);
});

test("代驾登录先验码再手填手机后兑换，并支持继续或切换缓存任务", () => {
  const api = readFileSync(new URL("../miniprogram/packages/driver/services/driver-api.ts", import.meta.url), "utf8");
  const loginPage = readFileSync(new URL("../miniprogram/packages/driver/pages/login/login.ts", import.meta.url), "utf8");
  const loginMarkup = readFileSync(new URL("../miniprogram/packages/driver/pages/login/login.wxml", import.meta.url), "utf8");
  const taskPage = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.ts", import.meta.url), "utf8");

  assert.match(api, /exchangeVerificationCode\(verificationCode:\s*string,\s*driverPhone:\s*string\)[\s\S]*ownerExchange\(\{\s*verificationCode:\s*code,\s*driverPhone:\s*phone\s*\}\)/u);
  assert.match(loginPage, /readDriverTaskSession\(\)[\s\S]*driverApi\.taskSummary\(session\.bookingId\)/u);
  assert.match(loginPage, /goPhoneStep\(\)[\s\S]*step:\s*"phone"/u);
  assert.match(loginPage, /exchangeVerificationCode\(\s*this\.data\.verificationCode,\s*this\.data\.driverPhone,/u);
  assert.match(loginPage, /continueTask\(\)[\s\S]*switchTask\(\)[\s\S]*clearDriverTaskSession\(\)/u);
  assert.match(loginPage, /isDriverSessionAccessError\(error\)[\s\S]*clearDriverTaskSession\(\)/u);
  assert.equal((loginMarkup.match(/<input\b/gu) || []).length, 2, "登录页应包含验证码与手机号两个输入字段");
  assert.match(loginMarkup, /type="number"[^>]*maxlength="6"/u);
  assert.match(loginMarkup, /type="number"[^>]*maxlength="11"/u);
  assert.match(loginMarkup, /code-group[\s\S]*code-divider[\s\S]*code-group/u);
  assert.match(loginMarkup, /下一步[\s\S]*确认手机号/u);
  assert.match(loginMarkup, /继续处理此任务[\s\S]*输入新验证码切换任务/u);
  assert.match(taskPage, /taskCodeFromQuery[\s\S]*query\.taskCode[\s\S]*query\.scene/u, "旧 taskCode 与 scene 深链继续兼容");
  assert.match(taskPage, /isDriverSessionAccessError\(error\)[\s\S]*packages\/driver\/pages\/login\/login\?reason=session/u);
});

test("司机端使用独立 Bearer、私有图片本地化与失败可重试幂等键", () => {
  const api = readFileSync(new URL("../miniprogram/packages/driver/services/driver-api.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.wxss", import.meta.url), "utf8");
  const manifest = readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8");

  assert.match(manifest, /"root":\s*"packages\/driver"[\s\S]*"pages\/task\/task"/);
  assert.match(api, /withOwnerAuthorization[\s\S]*ownerExchange/);
  assert.match(api, /driverAuthorizationHeaders\(\)/);
  assert.match(api, /wx\.downloadFile\([\s\S]*header:\s*headers/);
  assert.match(api, /localizeTaskEvidence/);
  assert.match(page, /sourceType:\s*\["camera",\s*"album"\]/);
  assert.match(page, /const existing = String\(wx\.getStorageSync/);
  assert.match(page, /clearRequestKey\(action, task\.bookingId\)/);
  assert.match(page, /completeEvidence\(\)[\s\S]*void this\.performCompleteEvidence\(stage\);/);
  assert.doesNotMatch(page, /wx\.previewImage/);
  assert.match(markup, /提交取车留证并推进/);
  assert.match(markup, /车主与后台同步可见/);
  assert.match(markup, /<view class="hero-top"><text>代驾执行<\/text><text>代驾执行任务<\/text><\/view>/);
  assert.doesNotMatch(markup, /VALET EXECUTION/);
  assert.match(markup, /inline-task-error[\s\S]*retryTask/, "已有任务刷新失败时应保留旧内容并提供重试入口");
  assert.match(markup, /error-card[\s\S]*bookingId[\s\S]*retryTask/, "任务入口已验证但首次读取失败时应允许直接重试");
  assert.match(page, /retryTask\(\)\s*\{[\s\S]*?void this\.loadTask\(true\);[\s\S]*?\}/);
  assert.match(markup, /aria-label="关闭留证图片查看器"/, "图片弹窗关闭操作应有可访问名称");
  assert.match(style, /\.driver-task-page\s*\{[^}]*env\(safe-area-inset-bottom\)/, "任务页底部应避让安全区");
  assert.match(style, /\.error-card > button\s*\{[^}]*min-height:\s*88rpx/);
  for (const selector of ["inline-task-error button", "route-stop > button,.contact-row > button", "photo-actions button", "primary-action", "return-action-card > button", "handoff-primary", "handoff-code-panel > button", "image-viewer-head button", "image-viewer-controls > button"]) {
    const pattern = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\,/g, ",");
    assert.match(style, new RegExp(`\\.${pattern}\\s*\\{[^}]*min-height:\\s*88rpx`), `${selector} 的触控高度不得小于 88rpx`);
  }
});

test("代驾取车与检测站接车留证均允许相机或相册", () => {
  const driverPage = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.ts", import.meta.url), "utf8");
  const operatorPage = readFileSync(new URL("../miniprogram/packages/operator/pages/operator-detail/operator-detail.ts", import.meta.url), "utf8");
  assert.match(driverPage, /choosePhoto[\s\S]*sourceType:\s*\["camera",\s*"album"\]/u);
  assert.match(operatorPage, /chooseArrivalEvidence[\s\S]*sourceType:\s*\["camera",\s*"album"\]/u);
});

test("到站后取车代驾可二次确认换人并展示可复制换班码", () => {
  const api = readFileSync(new URL("../miniprogram/packages/driver/services/driver-api.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/driver/pages/task/task.wxss", import.meta.url), "utf8");

  assert.match(api, /createHandoffCode\(bookingId:\s*string\)[\s\S]*\/driver\/tasks\/\$\{encodeURIComponent\(bookingId\)\}\/handoff-code/u);
  assert.match(api, /handoffVerificationCode/u);

  assert.match(page, /HANDOFF_ELIGIBLE_STATUSES\s*=\s*new Set\(\["checked_in",\s*"inspecting",\s*"result_received"\]\)/u);
  assert.match(page, /canShowHandoff\([\s\S]*driverTaskTerminal[\s\S]*isPickupDriver[\s\S]*returnDriverBound[\s\S]*HANDOFF_ELIGIBLE_STATUSES/u);
  assert.match(page, /const showHandoff = canShowHandoff\(task\)/u);
  assert.match(page, /showHandoff,/u);
  assert.match(page, /requestHandoff\(\)[\s\S]*wx\.showModal\(\{[\s\S]*title:\s*"确认换人？"/u);
  assert.match(page, /content:\s*"将生成新的送车验证码。接班司机输入新码后，你将无法再操作本单。"/u);
  assert.match(page, /confirmText:\s*"确认换人"/u);
  assert.match(page, /if\s*\(!confirm\)\s*return;[\s\S]*void this\.performCreateHandoffCode\(\)/u);
  assert.match(page, /performCreateHandoffCode\(\)[\s\S]*driverApi\.createHandoffCode\(task\.bookingId\)/u);
  assert.match(page, /copyHandoffCode\(\)[\s\S]*wx\.setClipboardData\(\{[\s\S]*data:\s*code/u);

  assert.match(markup, /wx:if="\{\{showHandoff\}\}"[\s\S]*换人送车/u);
  assert.match(markup, /handoffVerificationCode[\s\S]*bindtap="copyHandoffCode"/u);
  assert.match(markup, /bindtap="requestHandoff"[\s\S]*\{\{handoffVerificationCode \? '重新生成换班码' : '换人'\}\}/u);

  assert.match(style, /\.handoff-action-card\s*\{/u);
  assert.match(style, /\.handoff-primary\s*\{[^}]*min-height:\s*88rpx/u);
  assert.match(style, /\.handoff-code-panel > button\s*\{[^}]*min-height:\s*88rpx/u);
});
