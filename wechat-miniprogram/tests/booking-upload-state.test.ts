import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Booking, BookingMedia, MediaKind, VehicleCheckupReportListPage } from "../miniprogram/types";
import { requiredUploadItems, updateUploadItem } from "../miniprogram/packages/annual/pages/booking/upload-state";
import { bookingQuoteAmountChanged, createBookingWithFreshQuote, QuoteRefreshError } from "../miniprogram/packages/annual/pages/booking/quote-submission";
import { stationEntryState } from "../miniprogram/packages/annual/pages/stations/entry-state";
import { homeReportEntry } from "../miniprogram/pages/home/home-report";
import { bookingPaymentStateView, bookingQuoteView, quoteAmountChanged, quoteClockView } from "../miniprogram/packages/annual/pages/order-detail/order-detail.model";
import { distanceLabel, driveDuration, stationDistance } from "../miniprogram/utils/format";

function media(kind: MediaKind, id: string): BookingMedia {
  return {
    id,
    kind,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    width: 1200,
    height: 900,
    url: `/api/media/${id}`,
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

test("较长驾车时长按小时和分钟展示，避免把 119 分钟误读为异常单位", () => {
  assert.equal(driveDuration(15), "15 分钟");
  assert.equal(driveDuration(119), "1 小时 59 分钟");
  assert.equal(driveDuration(120), "2 小时");
  assert.equal(stationDistance({ distanceKm: 55.4, driveMinutes: 119, distanceBasis: "driving_route" }), "55.4 km · 约 1 小时 59 分钟");
  assert.equal(distanceLabel(55.4, 119, "driving_route"), "55.4 km · 约 1 小时 59 分钟");

  const wxs = readFileSync(new URL("../miniprogram/utils/format.wxs", import.meta.url), "utf8");
  assert.match(wxs, /function driveDuration\(minutes\)/u);
  assert.match(wxs, /hours \+ ' 小时 ' \+ remainder \+ ' 分钟'/u);
  assert.match(wxs, /station\.distanceKm \+ ' km · 约 ' \+ driveDuration\(station\.driveMinutes\)/u);
});

test("自驾预约逐张上传时保留所有已完成方位", () => {
  let uploads = requiredUploadItems("self_drive");
  const leftFront = media("vehicle_front_left", "media-left-front");
  const rightFront = media("vehicle_front_right", "media-right-front");

  uploads = updateUploadItem(uploads, leftFront.kind, { media: leftFront, uploading: false });
  uploads = requiredUploadItems("self_drive", uploads);
  uploads = updateUploadItem(uploads, rightFront.kind, { media: rightFront, uploading: false });
  uploads = requiredUploadItems("self_drive", uploads);

  assert.equal(uploads.find((item) => item.kind === leftFront.kind)?.media?.id, leftFront.id);
  assert.equal(uploads.find((item) => item.kind === rightFront.kind)?.media?.id, rightFront.id);
  assert.equal(uploads.filter((item) => item.media).length, 2);
});

test("重选或上传失败只改变当前方位", () => {
  const leftFront = media("vehicle_front_left", "media-left-front");
  const rightFront = media("vehicle_front_right", "media-right-front");
  let uploads = requiredUploadItems("self_drive");
  uploads = updateUploadItem(uploads, leftFront.kind, { media: leftFront, uploading: false });
  uploads = updateUploadItem(uploads, rightFront.kind, { media: rightFront, uploading: false });

  uploads = updateUploadItem(uploads, rightFront.kind, { media: rightFront, uploading: true });
  uploads = updateUploadItem(uploads, rightFront.kind, { media: rightFront, uploading: false });

  assert.equal(uploads.find((item) => item.kind === leftFront.kind)?.media?.id, leftFront.id);
  assert.equal(uploads.find((item) => item.kind === rightFront.kind)?.media?.id, rightFront.id);
});

test("预约上传完成后保留本地缩略图，重算必传槽位不会让预览消失", () => {
  const leftFront = media("vehicle_front_left", "media-left-front");
  let uploads = requiredUploadItems("self_drive");
  uploads = updateUploadItem(uploads, leftFront.kind, {
    media: leftFront,
    previewUrl: "wxfile://tmp-left-front.jpg",
    uploading: false,
  });
  uploads = requiredUploadItems("self_drive", uploads);

  const completed = uploads.find((item) => item.kind === leftFront.kind);
  assert.equal(completed?.media?.id, leftFront.id);
  assert.equal(completed?.previewUrl, "wxfile://tmp-left-front.jpg");

  const template = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxss", import.meta.url), "utf8");
  assert.match(template, /wx:if="\{\{item\.previewUrl\}\}"[\s\S]*class="upload-preview" src="\{\{item\.previewUrl\}\}"/);
  assert.match(template, /已上传 · 点击重选/);
  assert.match(style, /\.upload-preview\s*\{[^}]*position:\s*absolute/);
  assert.match(style, /\.upload-card\.has-preview \.upload-label/);
});

test("七类资料以任意完成顺序上传后都能提交", () => {
  const completionOrder: MediaKind[] = [
    "vehicle_rear_right",
    "license_front",
    "vehicle_front_left",
    "vehicle_rear_left",
    "dashboard_started",
    "license_back",
    "vehicle_front_right",
  ];
  let uploads = requiredUploadItems("self_drive");

  for (const [index, kind] of completionOrder.entries()) {
    uploads = updateUploadItem(uploads, kind, { media: media(kind, `media-${index}`), uploading: false });
    uploads = requiredUploadItems("self_drive", uploads);
  }

  assert.equal(uploads.length, 7);
  assert.equal(uploads.filter((item) => item.media).length, 7);
  assert.equal(new Set(uploads.map((item) => item.media?.id)).size, 7);
  assert.deepEqual(new Set(uploads.map((item) => item.kind)), new Set(completionOrder));
});

test("预约页只在首次加载时初始化，不在相册或相机返回的 onShow 中重置", () => {
  const source = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.ts", import.meta.url), "utf8");
  assert.match(source, /async onLoad\(\) \{ await this\.load\(\); \}/);
  assert.doesNotMatch(source, /\bonShow\s*\(/);
});

test("自驾和代驾预约都要求四角、仪表盘与两页行驶证共七张", () => {
  const selfDrive = requiredUploadItems("self_drive");
  const valet = requiredUploadItems("valet");
  const requiredKinds: MediaKind[] = [
    "vehicle_front_left",
    "vehicle_front_right",
    "vehicle_rear_left",
    "vehicle_rear_right",
    "dashboard_started",
    "license_front",
    "license_back",
  ];

  assert.deepEqual(selfDrive.map((item) => item.kind), requiredKinds);
  assert.deepEqual(valet.map((item) => item.kind), requiredKinds);
});

test("预约页统一显示七项必传且每个槽位单次只选一张", () => {
  const source = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.ts", import.meta.url), "utf8");
  const template = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxml", import.meta.url), "utf8");

  assert.match(template, /车身四角、启动后仪表盘和行驶证两页/);
  assert.match(template, /7 项必传/);
  assert.match(template, /司机取车时仍会另行拍摄五张履约留证/);
  assert.doesNotMatch(template, /预约仅提交行驶证/);
  assert.doesNotMatch(template, /6 项必传/);
  assert.match(source, /wx\.chooseMedia\(\{ count: 1/);
  assert.match(source, /mediaIds: this\.data\.uploads\.map/);
});

test("代驾履约留证由司机、检测站和报告分阶段展示且不要求客户确认", () => {
  const ownerTemplate = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxml", import.meta.url), "utf8");
  const operatorTemplate = readFileSync(new URL("../miniprogram/packages/operator/pages/operator-detail/operator-detail.wxml", import.meta.url), "utf8");
  const operatorSource = readFileSync(new URL("../miniprogram/packages/operator/pages/operator-detail/operator-detail.ts", import.meta.url), "utf8");
  const operatorStyle = readFileSync(new URL("../miniprogram/packages/operator/pages/operator-detail/operator-detail.wxss", import.meta.url), "utf8");
  const workbenchTemplate = readFileSync(new URL("../miniprogram/packages/operator/pages/operator/operator.wxml", import.meta.url), "utf8");
  const workbenchSource = readFileSync(new URL("../miniprogram/packages/operator/pages/operator/operator.ts", import.meta.url), "utf8");
  const workbenchStyle = readFileSync(new URL("../miniprogram/packages/operator/pages/operator/operator.wxss", import.meta.url), "utf8");

  assert.match(ownerTemplate, /履约留证/);
  assert.match(ownerTemplate, /取车、到站、检测与送回全程可查看/);
  assert.match(ownerTemplate, /evidenceStages/);
  assert.doesNotMatch(ownerTemplate, /确认交车|发起异议|确认送达/);
  assert.match(operatorTemplate, /检测站接车留证/);
  assert.match(operatorTemplate, /照片完整提交后系统自动推进到“已到站”/);
  assert.match(operatorTemplate, /class="arrival-slot-preview"[\s\S]*bindtap="previewArrivalEvidence"/);
  assert.match(operatorTemplate, /class="arrival-slot-retake"[\s\S]*bindtap="chooseArrivalEvidence"/);
  assert.doesNotMatch(operatorTemplate, /确认车辆已送回并完成服务/);
  assert.match(operatorSource, /sourceType: \["camera", "album"\]/);
  assert.match(operatorSource, /operatorStationEvidenceComplete/);
  assert.match(operatorTemplate, /detail-error-state[\s\S]*retry[\s\S]*goTasks/, "检测端详情失败时应有明确恢复路径");
  assert.match(operatorSource, /\["driver_arranged", "picked_up", "awaiting_arrival", "on_hold"\]\.includes\(status\)\) return 1;/, "司机已安排和已取车应落在到站前节点");
  assert.match(operatorSource, /\["checked_in", "inspecting"\]\.includes\(status\)\) return 2;/, "到站和检测中应落在检测节点");
  assert.match(operatorSource, /\["result_received", "returning"\]\.includes\(status\)\) return 3;/, "结果回传和送回中应落在结果节点");
  assert.match(operatorSource, /if \(status === "completed"\) return 5;/, "服务完成后五个流程节点都应显示已完成");
  assert.match(operatorStyle, /\.detail-error-actions button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(operatorStyle, /\.navigate-button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(operatorStyle, /\.arrival-evidence-submit\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(operatorStyle, /\.booking-meta\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(operatorStyle, /\.booking-meta > view:nth-child\(3\)\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(workbenchTemplate, /检测站工作台暂时无法加载/);
  assert.match(workbenchTemplate, /当前保留的是上次成功同步的任务/);
  assert.match(workbenchSource, /onPullDownRefresh\(\)/);
  assert.match(workbenchSource, /if \(status === "result_received"\) return "结果已回传"/);
  assert.match(workbenchSource, /if \(status === "completed"\) return "服务已完成"/);
  assert.match(workbenchStyle, /\.filter-row button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(workbenchStyle, /\.task-heading button\s*\{[^}]*min-height:\s*88rpx/);
});

test("预约时段与资料确认页提供明确的任务内返回导航", () => {
  const slotsTemplate = readFileSync(new URL("../miniprogram/packages/annual/pages/slots/slots.wxml", import.meta.url), "utf8");
  const slotsSource = readFileSync(new URL("../miniprogram/packages/annual/pages/slots/slots.ts", import.meta.url), "utf8");
  const slotsStyle = readFileSync(new URL("../miniprogram/packages/annual/pages/slots/slots.wxss", import.meta.url), "utf8");
  const bookingTemplate = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxml", import.meta.url), "utf8");
  const bookingSource = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.ts", import.meta.url), "utf8");
  const bookingStyle = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxss", import.meta.url), "utf8");

  assert.match(slotsTemplate, /class="flow-toolbar"[\s\S]*bindtap="goBack"[\s\S]*返回站点[\s\S]*站点已选 · 下一步确认资料/);
  assert.match(bookingTemplate, /class="flow-toolbar"[\s\S]*bindtap="goBack"[\s\S]*返回时段[\s\S]*最后确认 · 提交后生成订单/);
  assert.match(slotsSource, /goBack\(\)[\s\S]*getCurrentPages\(\)\.length > 1[\s\S]*wx\.navigateBack\(\)/);
  assert.match(bookingSource, /goBack\(\)[\s\S]*getCurrentPages\(\)\.length > 1[\s\S]*wx\.navigateBack\(\)/);
  assert.match(slotsStyle, /\.flow-back\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(bookingStyle, /\.flow-back\s*\{[^}]*min-height:\s*88rpx/);
});

test("首页与资格回流会用所选模式重建干净草稿", () => {
  const staleSelfDrive = {
    serviceMode: "self_drive" as const,
    vehicleId: "vehicle-old",
    origin: { latitude: 39.1, longitude: 117.2, type: "self_drive" as const },
    station: { id: "station-old" } as never,
  };
  const valetEntry = stationEntryState({ serviceMode: "valet", vehicleId: "vehicle-new", entry: "home" }, staleSelfDrive);

  assert.equal(valetEntry.mode, "valet");
  assert.equal(valetEntry.replace, true);
  assert.deepEqual(valetEntry.draft, { serviceMode: "valet", vehicleId: "vehicle-new" });

  const staleValet = {
    serviceMode: "valet" as const,
    vehicleId: "vehicle-old",
    pickupAddress: { title: "旧取车地址" } as never,
  };
  const selfDriveEntry = stationEntryState({ serviceMode: "self_drive", vehicleId: "vehicle-new", returnTo: "inspection_booking" }, staleValet);
  assert.deepEqual(selfDriveEntry.draft, { serviceMode: "self_drive", vehicleId: "vehicle-new" });
});

test("旧 service-mode 入口保留同模式草稿且无草稿代驾不会退回自驾", () => {
  const current = {
    serviceMode: "valet" as const,
    vehicleId: "vehicle-1",
    pickupAddress: { title: "现有取车地址" } as never,
  };
  const legacy = stationEntryState({ mode: "valet" }, current);
  assert.equal(legacy.replace, false);
  assert.equal(legacy.draft, current);

  const directValet = stationEntryState({ mode: "valet" }, null);
  assert.equal(directValet.replace, true);
  assert.deepEqual(directValet.draft, { serviceMode: "valet" });

  const shortcutAlias = stationEntryState({ serviceMode: "valet", mode: "self_drive", entry: "home" }, null);
  assert.equal(shortcutAlias.mode, "valet");
});

test("首页三入口和资格及建档回流保持快捷导航契约", () => {
  const homeWxml = readFileSync(new URL("../miniprogram/pages/home/home.wxml", import.meta.url), "utf8");
  const homeSource = readFileSync(new URL("../miniprogram/pages/home/home.ts", import.meta.url), "utf8");
  const eligibilitySource = readFileSync(new URL("../miniprogram/packages/annual/pages/eligibility/eligibility.ts", import.meta.url), "utf8");
  const vehicleFormSource = readFileSync(new URL("../miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form.ts", import.meta.url), "utf8");

  assert.match(homeWxml, /自驾验车/);
  assert.match(homeWxml, /代驾验车/);
  assert.match(homeWxml, /检测报告/);
  assert.match(homeWxml, /aria-label="自驾验车，自己开车到检测站"/);
  assert.match(homeWxml, /activeBooking \? '继续当前年检' : '选站点与时间'/);
  assert.match(homeWxml, /aria-label="代驾验车，上门取车并送回原地址"/);
  assert.match(homeWxml, /activeBooking \? '继续当前年检' : '填地址并预约'/);
  assert.match(homeWxml, /disabled="\{\{entryTarget !== ''\}\}"/);
  assert.match(homeWxml, /正在进入…/);
  assert.match(homeWxml, /正在打开报告中心…/);
  assert.match(homeWxml, /首页信息暂时无法加载/);
  assert.match(homeWxml, /bindtap="retryLoad"/);
  assert.doesNotMatch(homeWxml, /job-copy/);
  assert.doesNotMatch(homeWxml, /年检服务流程|data-step=/);
  assert.match(homeSource, /actionLabel: canBookInspection \? "选择验车方式"/);
  assert.match(homeSource, /loadError: message/);
  assert.match(homeSource, /if \(this\.data\.entryTarget\) return/);
  assert.match(homeSource, /navigateEntry\("\/packages\/inspection\/pages\/checkup-reports\/checkup-reports", "report"\)/);
  assert.match(homeSource, /checkup-reports\/checkup-reports/);
  assert.match(homeSource, /api\.vehicleCheckupReports\(\{ limit: 1 \}\)/);
  assert.doesNotMatch(homeSource, /item\.vehicleCheckupReport/);
  assert.match(homeSource, /vehicle-form\?next=inspection_booking&serviceMode=\$\{mode\}&returnTo=inspection_booking/);
  assert.match(homeSource, /order-detail\/order-detail\?id=\$\{encodeURIComponent\(this\.data\.activeBooking\.id\)\}/);
  assert.match(homeSource, /eligibility\?vehicleId=\$\{vehicleId\}&serviceMode=\$\{mode\}&returnTo=inspection_booking/);
  assert.match(homeSource, /stations\?serviceMode=\$\{mode\}&vehicleId=\$\{vehicleId\}&entry=home/);
  assert.match(eligibilitySource, /stations\?serviceMode=\$\{this\.data\.requestedServiceMode\}&vehicleId=\$\{vehicleId\}&returnTo=inspection_booking/);
  assert.match(eligibilitySource, /service-mode\/service-mode\?vehicleId=\$\{vehicleId\}/);
  assert.match(vehicleFormSource, /stations\?serviceMode=\$\{this\.data\.requestedServiceMode\}&vehicleId=\$\{vehicleId\}&returnTo=inspection_booking/);
  assert.match(vehicleFormSource, /eligibility\?vehicleId=\$\{encodeURIComponent\(vehicle\.id\)\}\$\{modeQuery\}/);
  assert.match(vehicleFormSource, /function isSerialKeyAllowed/);
  assert.doesNotMatch(vehicleFormSource, /lockedIndex/);
});

test("首页报告入口诚实区分空态、进行中、结论与缺报告异常", () => {
  const progress = {
    bookingId: "booking-1",
    bookingNumber: "YXM-1",
    bookingStatus: "inspecting",
    fulfillmentStatus: "inspecting",
    paymentStatus: "paid",
    appointmentDate: "2026-08-25",
    startTime: "09:00",
    endTime: "10:00",
    vehicle: { id: "vehicle-1", plateNumber: "津A·12345", vehicleType: "小型轿车", brandName: null, modelName: null, displayName: "小型轿车" },
    station: { id: "station-1", name: "河西检测站", district: "河西区", address: "天津市河西区" },
    serviceMode: "self_drive",
    progressType: "booking_in_progress",
    conclusion: null,
    resultReceivedAt: null,
    reportReady: false,
    updatedAt: "2026-08-25T01:00:00.000Z",
  } as VehicleCheckupReportListPage["progress"][number];
  const report = {
    bookingId: "booking-2",
    bookingNumber: "YXM-2",
    bookingStatus: "completed",
    fulfillmentStatus: "completed",
    appointmentDate: "2026-08-24",
    startTime: "09:00",
    endTime: "10:00",
    reportId: "report-1",
    reportNo: "YXM-CHK-1",
    reportStatus: "published",
    schemaVersion: "vehicle-checkup-v2",
    publishedAt: "2026-08-25T02:00:00.000Z",
    retainUntil: null,
    vehicle: progress.vehicle,
    station: progress.station,
    serviceMode: "self_drive",
    conclusion: "passed",
    observationMode: "no_visible_faults",
    faultCount: 0,
    sitePhotoCount: 5,
    faultPhotoCount: 0,
    photoCount: 6,
    markStatus: "issued",
    hasAnnualMark: true,
  } as VehicleCheckupReportListPage["items"][number];
  const page = (items = [report], progressItems = [progress]): VehicleCheckupReportListPage => ({ items, progress: progressItems, limit: 20, nextCursor: null });

  assert.equal(homeReportEntry(page([], []), true).badge, "暂无报告");
  assert.equal(homeReportEntry(page([], [progress]), true).badge, "报告待生成");
  assert.equal(homeReportEntry(page([{ ...report, conclusion: "passed" }], []), true).badge, "报告已生成 · 通过");
  assert.equal(homeReportEntry(page([{ ...report, conclusion: "failed", hasAnnualMark: false, markStatus: "not_issued" }], []), true).badge, "报告已生成 · 未通过");
  const historical = homeReportEntry(page([{ ...report, conclusion: null, conclusionStatus: "legacy_requires_reentry", hasAnnualMark: false, markStatus: "not_issued" }], []), true);
  assert.equal(historical.badge, "报告已生成 · 结果未确认");
  assert.equal(historical.tone, "unavailable");
  assert.match(historical.detail, /旧结论.*重新录入/);
  const missing = { ...progress, bookingStatus: "completed", fulfillmentStatus: "completed", progressType: "result_pending_report", updatedAt: "2026-08-25T03:00:00.000Z" } as VehicleCheckupReportListPage["progress"][number];
  const mixed = homeReportEntry(page([report], [missing]), true);
  assert.equal(mixed.badge, "报告尚未形成", "缺报告异常应优先于其他历史报告显示");
  assert.match(mixed.detail, /结果已回传|材料待补齐/);
  assert.equal(homeReportEntry(null, false).badge, "同步失败");
});

test("年检下单提交前强制刷新服务端报价快照", () => {
  const source = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.ts", import.meta.url), "utf8");
  assert.match(source, /createBookingWithFreshQuote/);
  assert.match(source, /quoteSnapshotId: quote\.quoteSnapshotId/);
  assert.match(source, /requiredUploadItems\(draft\.serviceMode/);
  assert.match(source, /confirmQuoteUpdate\(acceptedQuote, freshQuote\)/);
  assert.match(source, /报价金额已更新/);
});

test("预约提交前的新报价发生金额变化时必须重新确认", () => {
  const before = bookingQuote("snapshot-before");
  const sameAmount = { ...before, quoteSnapshotId: "snapshot-after" };
  const changedInspection = { ...sameAmount, inspectionFeeFen: 28000, serviceFeeFen: 28000 };
  const changedValet = { ...sameAmount, serviceMode: "valet" as const, valetFeeFen: 10900, serviceFeeFen: 36900 };
  assert.equal(bookingQuoteAmountChanged(before, sameAmount), false);
  assert.equal(bookingQuoteAmountChanged(before, changedInspection), true);
  assert.equal(bookingQuoteAmountChanged(before, changedValet), true);
});

function bookingQuote(quoteSnapshotId: string): import("../miniprogram/types").BookingQuote {
  return {
    quoteSnapshotId,
    serviceMode: "self_drive",
    vehiclePriceCategory: "fuel_small",
    inspectionFeeFen: 26000,
    valetFeeFen: 0,
    serviceFeeFen: 26000,
    serviceable: true,
    distanceKm: 0,
    driveMinutes: 0,
    distanceBasis: "self_drive",
  };
}

test("下单前始终使用刚刷新的报价而不是页面旧快照", async () => {
  const usedIds: string[] = [];
  let refreshCount = 0;
  const result = await createBookingWithFreshQuote(
    async () => bookingQuote(`fresh-${++refreshCount}`),
    async (quote) => { usedIds.push(quote.quoteSnapshotId); return { id: "booking-1" }; },
  );

  assert.equal(result.booking.id, "booking-1");
  assert.deepEqual(usedIds, ["fresh-1"]);
  assert.equal(refreshCount, 1);
});

test("QUOTE_EXPIRED 会换新快照重试一次且不复用旧快照", async () => {
  const refreshIds = ["snapshot-old", "snapshot-new"];
  const usedIds: string[] = [];
  let refreshCount = 0;
  let createCount = 0;
  const result = await createBookingWithFreshQuote(
    async () => bookingQuote(refreshIds[refreshCount++]!),
    async (quote) => {
      usedIds.push(quote.quoteSnapshotId);
      createCount += 1;
      if (createCount === 1) {
        const error = new Error("报价已过期") as Error & { code?: string };
        error.code = "QUOTE_EXPIRED";
        throw error;
      }
      return { id: "booking-2" };
    },
  );

  assert.equal(result.booking.id, "booking-2");
  assert.deepEqual(usedIds, ["snapshot-old", "snapshot-new"]);
  assert.equal(refreshCount, 2);
  assert.equal(createCount, 2);
});

test("报价连续过期最多创建两次，防止无限刷新重试", async () => {
  let refreshCount = 0;
  let createCount = 0;
  await assert.rejects(
    createBookingWithFreshQuote(
      async () => bookingQuote(`snapshot-${++refreshCount}`),
      async () => {
        createCount += 1;
        const error = new Error("报价已过期") as Error & { code?: string };
        error.code = "QUOTE_EXPIRED";
        throw error;
      },
    ),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "QUOTE_EXPIRED",
  );
  assert.equal(refreshCount, 2);
  assert.equal(createCount, 2);
});

test("报价刷新缺少快照或复用已拒绝快照时停止重试", async () => {
  await assert.rejects(
    createBookingWithFreshQuote(
      async () => bookingQuote(""),
      async () => ({ id: "should-not-create" }),
    ),
    (error: unknown) => error instanceof QuoteRefreshError && error.code === "QUOTE_SNAPSHOT_MISSING",
  );

  let refreshCount = 0;
  let createCount = 0;
  await assert.rejects(
    createBookingWithFreshQuote(
      async () => { refreshCount += 1; return bookingQuote("same-snapshot"); },
      async () => {
        createCount += 1;
        const error = new Error("报价已过期") as Error & { code?: string };
        error.code = "QUOTE_EXPIRED";
        throw error;
      },
    ),
    (error: unknown) => error instanceof QuoteRefreshError && error.code === "QUOTE_REFRESH_REUSED_SNAPSHOT",
  );
  assert.equal(refreshCount, 2);
  assert.equal(createCount, 1);
});

test("代驾地图选点先由服务端解析并签发地址凭证", () => {
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const stationSource = readFileSync(new URL("../miniprogram/packages/annual/pages/stations/stations.ts", import.meta.url), "utf8");
  const stationWxml = readFileSync(new URL("../miniprogram/packages/annual/pages/stations/stations.wxml", import.meta.url), "utf8");
  assert.match(apiSource, /resolveLocation:[\s\S]*\/locations\/resolve/);
  assert.match(stationSource, /await api\.resolveLocation/);
  assert.match(stationSource, /if \(!pickupAddress\.locationProof\)/);
  assert.match(stationSource, /patchBookingDraft\([\s\S]*pickupAddress/);
  assert.match(stationSource, /onShow\(\)[\s\S]*initialLocationAttempted[\s\S]*locateCurrentOrigin/);
  assert.match(stationSource, /if \(this\.data\.mode === "valet" && !draft\.pickupAddress\?\.locationProof\)/);
  assert.doesNotMatch(stationSource, /source:\s*["']wechat["']/);
  assert.match(stationWxml, /loading="\{\{locating\}\}" disabled="\{\{locating\}\}" bindtap="chooseOnMap"/);
  assert.match(stationWxml, /canSelectStation \? '选择站点' : '先确定取车地址'/);
  assert.match(
    stationWxml,
    /<input[^>]*class="pickup-search-input"[^>]*bindinput="search"/,
    "代驾地址搜索框不可绑定 value，否则异步联想 setData 后真机会把输入框渲成 undefined",
  );
  assert.doesNotMatch(
    stationWxml,
    /pickup-search-input[^>]*value=/,
    "pickup-search-input 必须是非受控输入",
  );
  assert.match(stationSource, /if \(raw == null\) return/, "忽略 input 脏事件");
  assert.match(stationSource, /fetchSuggestions/, "输入与异步联想分离");
  assert.match(stationSource, /searchBoxVisible/, "选中地点后通过销毁重建输入框清空");
});

test("代驾年检确认页费用明细拆分起步价与超里程", () => {
  const bookingWxml = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxml", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const typesSource = readFileSync(new URL("../miniprogram/types/index.ts", import.meta.url), "utf8");
  assert.match(bookingWxml, /代驾起步价/);
  assert.match(bookingWxml, /超出里程加价/);
  assert.match(bookingWxml, /上门代驾费小计/);
  assert.match(bookingWxml, /quote\.breakdown\.valetBaseFeeFen/);
  assert.match(bookingWxml, /quote\.breakdown\.valetDistanceFeeFen/);
  assert.match(apiSource, /normalizeBookingQuote[\s\S]*valetBaseFeeFen/);
  assert.match(typesSource, /breakdown\?:\s*\{[\s\S]*valetBaseFeeFen/);
});

function pendingBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-requote",
    bookingNumber: "YXM202608260001",
    vehicleId: "vehicle-1",
    stationId: "station-1",
    slotId: "slot-1",
    contactName: "测试车主",
    contactPhone: "13800138000",
    serviceFeeFen: 36900,
    inspectionFeeFen: 26000,
    valetFeeFen: 10900,
    serviceMode: "valet",
    vehiclePriceCategory: "fuel_small",
    quoteDistanceKm: 7.8,
    quoteSource: "tencent_matrix",
    quoteSnapshotId: "quote-old",
    quoteExpiresAt: "2026-08-26T04:10:00.000Z",
    oneWayDistanceKm: 7.8,
    extraKm: 0,
    valetRule: { baseFeeFen: 10900, includedKm: 10, perKmFen: 800 },
    chargedFen: 36900,
    amountDueFen: 36900,
    status: "pending_payment",
    fulfillmentStatus: "pending_payment",
    paymentStatus: "unpaid",
    appointmentDate: "2026-08-27",
    startTime: "09:00",
    endTime: "10:00",
    notes: null,
    pickupAddress: null,
    createdAt: "2026-08-26T03:00:00.000Z",
    updatedAt: "2026-08-26T03:00:00.000Z",
    ...overrides,
  };
}

test("待支付报价按截止时间进入过期态且代驾展示腾讯单程路线与往返公式", () => {
  const booking = pendingBooking();
  const before = quoteClockView(booking.quoteExpiresAt, Date.parse("2026-08-26T04:09:30.000Z"));
  const after = quoteClockView(booking.quoteExpiresAt, Date.parse("2026-08-26T04:10:01.000Z"));
  assert.equal(before.expired, false);
  assert.match(before.text, /剩余 0:30/);
  assert.equal(after.expired, true);
  assert.match(after.text, /报价已过期/);

  const view = bookingQuoteView(booking);
  assert.equal(view.paymentPending, true);
  assert.equal(view.payableFen, 36900);
  assert.equal(view.paymentSummaryLabel, "当前待付");
  assert.equal(view.paymentSummaryFen, 36900);
  assert.match(view.routeSummaryText, /腾讯驾车单程路线 7\.8 km/);
  assert.match(view.routeSummaryText, /返程已包含/);
  assert.match(view.pricingFormulaText, /往返取送费 = ¥109\.00/);
});

test("重报价金额变化必须再次确认，待支付订单仍可取消", () => {
  const before = pendingBooking();
  const after = pendingBooking({ quoteSnapshotId: "quote-new", serviceFeeFen: 38900, chargedFen: 38900, amountDueFen: 38900 });
  assert.equal(quoteAmountChanged(before, after), true);
  assert.equal(quoteAmountChanged(before, pendingBooking({ quoteSnapshotId: "quote-new" })), false);

  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const pageSource = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxss", import.meta.url), "utf8");
  assert.match(apiSource, /requoteBooking:[\s\S]*\/bookings\/\$\{encodeURIComponent\(id\)\}\/requote[\s\S]*expectedQuoteSnapshotId/);
  assert.match(apiSource, /payBooking:[\s\S]*quoteSnapshotId[\s\S]*\{ quoteSnapshotId \}/);
  assert.match(pageSource, /code === "QUOTE_EXPIRED" \|\| code === "QUOTE_STALE"/);
  assert.match(pageSource, /booking\.fulfillmentStatus !== "legacy" && !quoteSnapshotId/);
  assert.match(pageSource, /api\.payBooking\(booking\.id, idempotencyKey, quoteSnapshotId\)/);
  assert.match(pageSource, /code === "BOOKING_QUOTE_CHANGED"[\s\S]*订单报价已更新，请重新确认最新金额后支付/);
  assert.match(pageSource, /title: "报价金额已更新"[\s\S]*confirmText: "确认并支付"[\s\S]*if \(confirm\) void this\.pay\(\)/);
  assert.match(markup, /报价有效截止时间/);
  assert.match(markup, /代驾路线与计价依据/);
  assert.match(markup, /bindtap="requote"/);
  assert.match(style, /\.quote-expired-actions\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s);
  assert.match(style, /\.quote-expired-actions button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*margin:\s*0[^}]*box-sizing:\s*border-box/s);
  assert.match(markup, /booking\.status === 'pending_payment' \|\| booking\.status === 'pending_precheck' \|\| booking\.status === 'confirmed'/);
  assert.match(pageSource, /this\.data\.cancelling \|\| this\.data\.paying \|\| this\.data\.requoting/);
  assert.match(markup, /bindtap="cancel" loading="\{\{cancelling\}\}" disabled="\{\{cancelling \|\| paying \|\| requoting\}\}"/);
  assert.match(markup, /cancelling \? '正在取消…' : '取消预约'/);
  assert.match(pageSource, /loadError:\s*message/);
  assert.match(markup, /当前保留的是上次成功同步的订单信息/);
  assert.match(markup, /bindtap="retryLoad"/);
});

test("取消、退款和历史缺状态订单不会误显示支付已确认", () => {
  assert.equal(bookingPaymentStateView(pendingBooking()).tone, "pending");
  assert.equal(bookingPaymentStateView(pendingBooking({ status: "confirmed", paymentStatus: "paid" })).tone, "paid");
  const cancelled = bookingPaymentStateView(pendingBooking({ status: "cancelled", paymentStatus: "unpaid" }));
  assert.equal(cancelled.tone, "unpaid");
  assert.match(cancelled.title, /未完成/);
  assert.doesNotMatch(cancelled.title, /已确认/);
  const refunded = bookingPaymentStateView(pendingBooking({ status: "cancelled", paymentStatus: "refunded" }));
  assert.equal(refunded.tone, "refunded");
  assert.match(refunded.title, /退款/);
  const historical = bookingPaymentStateView(pendingBooking({ status: "completed", paymentStatus: undefined }));
  assert.equal(historical.tone, "unknown");
  assert.match(historical.title, /待同步/);
});

test("已支付订单即使报价时间已过也不再显示或允许重新报价", () => {
  const paid = pendingBooking({
    status: "confirmed",
    fulfillmentStatus: "confirmed",
    paymentStatus: "paid",
    paidFen: 36900,
    amountDueFen: 0,
  });
  const quote = bookingQuoteView(paid);
  const expiredClock = quoteClockView(paid.quoteExpiresAt, Date.parse("2026-08-27T04:10:01.000Z"));
  assert.equal(expiredClock.expired, true, "原报价时钟本身可以已经过期");
  assert.equal(quote.paymentPending, false, "支付确认后报价过期不再影响订单");
  assert.equal(quote.payableFen, 0, "已支付订单的当前待付金额为零");
  assert.equal(quote.paymentSummaryLabel, "已模拟支付");
  assert.equal(quote.paymentSummaryFen, 36900, "交易卡应展示真实模拟实付，不能把待付零元当成实付");
  assert.equal(quote.refundedFen, 0);

  const pageSource = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxml", import.meta.url), "utf8");
  assert.match(pageSource, /const paidBooking = await api\.payBooking[\s\S]*this\.stopQuoteClock\(\);[\s\S]*booking:\s*paidBooking[\s\S]*quoteExpired:\s*false[\s\S]*await this\.load\(\)/);
  assert.match(pageSource, /if \(!bookingPaymentPending\(booking\)\) \{[\s\S]*quoteExpired:\s*false[\s\S]*return;/);
  assert.match(markup, /booking\.status === 'pending_payment'[\s\S]*booking\.paymentStatus !== 'paid'[\s\S]*quoteExpired/);
  assert.doesNotMatch(markup, /wx:if="\{\{quoteExpired\}\}" class="quote-expired-actions"/);
  assert.match(markup, /\{\{paymentSummaryLabel\}\}[\s\S]*fmt\.money\(paymentSummaryFen\)/);
  assert.doesNotMatch(markup, /payment-summary-row[^\n]*fmt\.money\(payableFen\)/);
});

test("退款订单分别展示原模拟实付与退款金额", () => {
  const refunded = bookingQuoteView(pendingBooking({
    status: "cancelled",
    fulfillmentStatus: "cancelled",
    paymentStatus: "partially_refunded",
    paidFen: 36900,
    refundedFen: 10900,
    amountDueFen: 0,
  }));
  assert.equal(refunded.paymentSummaryLabel, "已模拟支付");
  assert.equal(refunded.paymentSummaryFen, 36900);
  assert.equal(refunded.refundedFen, 10900);
  assert.equal(bookingPaymentStateView(pendingBooking({ paymentStatus: "partially_refunded" })).tone, "refunded");
});

test("年检快捷预约页面使用明确阶段文案、错误恢复和安全区触控约束", () => {
  const stationTemplate = readFileSync(new URL("../miniprogram/packages/annual/pages/stations/stations.wxml", import.meta.url), "utf8");
  const stationSource = readFileSync(new URL("../miniprogram/packages/annual/pages/stations/stations.ts", import.meta.url), "utf8");
  const stationStyle = readFileSync(new URL("../miniprogram/packages/annual/pages/stations/stations.wxss", import.meta.url), "utf8");
  const slotTemplate = readFileSync(new URL("../miniprogram/packages/annual/pages/slots/slots.wxml", import.meta.url), "utf8");
  const slotStyle = readFileSync(new URL("../miniprogram/packages/annual/pages/slots/slots.wxss", import.meta.url), "utf8");
  const bookingTemplate = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxml", import.meta.url), "utf8");
  const bookingStyle = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.wxss", import.meta.url), "utf8");
  const bookingSource = readFileSync(new URL("../miniprogram/packages/annual/pages/booking/booking.ts", import.meta.url), "utf8");

  assert.match(stationTemplate, /年检预约 · 选择站点/);
  assert.match(slotTemplate, /年检预约 · 选择时段/);
  assert.match(bookingTemplate, /年检预约 · 确认资料/);
  assert.doesNotMatch(`${stationTemplate}${slotTemplate}${bookingTemplate}`, /第 [234] 步/);
  assert.match(stationSource, /this\.searchSequence === sequence/);
  assert.match(stationTemplate, /检测站读取失败/);
  assert.match(slotTemplate, /号源读取失败/);
  assert.match(stationStyle, /\.origin-action[\s\S]*min-height:\s*88rpx/);
  assert.match(stationStyle, /\.origin-action\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*line-height:\s*1\.2/);
  assert.match(slotStyle, /\.empty-state button[\s\S]*min-height:\s*88rpx/);
  assert.match(bookingStyle, /\.submit-spacer[\s\S]*env\(safe-area-inset-bottom\)/);
  assert.match(bookingStyle, /\.submit-bar > button[\s\S]*min-height:\s*88rpx/);
  assert.match(bookingTemplate, /booking-load-error[\s\S]*retryLoad[\s\S]*goHome/, "预约资料读取失败不能停留在永久加载态");
  assert.match(bookingTemplate, /no-vehicle-card[\s\S]*addVehicle/, "异常深链没有车辆时应提供建档恢复入口");
  assert.match(bookingTemplate, /mediaUploadingCount > 0 \? '等待图片上传'/, "图片上传期间提交按钮应给出明确状态");
  assert.match(bookingSource, /if \(this\.data\.mediaUploadingCount > 0\)[\s\S]*请等待图片上传完成/, "图片上传期间逻辑层也必须阻止提交");
  assert.match(bookingStyle, /\.booking-load-actions button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(bookingSource, /eligibility\?vehicleId=\$\{vehicleId\}&serviceMode=\$\{mode\}&returnTo=inspection_booking/);
  assert.match(bookingTemplate, /!quote\.serviceable/);
});

test("车牌键盘与检测站任务卡在窄屏保持可滚动且不重叠", () => {
  const vehicleMarkup = readFileSync(new URL("../miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form.wxml", import.meta.url), "utf8");
  const vehicleStyle = readFileSync(new URL("../miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form.wxss", import.meta.url), "utf8");
  const operatorMarkup = readFileSync(new URL("../miniprogram/packages/operator/pages/operator/operator.wxml", import.meta.url), "utf8");
  const operatorStyle = readFileSync(new URL("../miniprogram/packages/operator/pages/operator/operator.wxss", import.meta.url), "utf8");

  assert.match(vehicleMarkup, /wx:if="\{\{provinceOpen\}\}" scroll-y[^>]*class="plate-keyboard-scroll"/);
  assert.match(vehicleMarkup, /<scroll-view scroll-y[^>]*class="plate-keyboard-scroll">[\s\S]*serial-numbers[\s\S]*serial-letters/);
  assert.match(vehicleMarkup, /class="plate-key[^"]*"[^>]*>\s*<text>\{\{item\}\}<\/text>/, "省份/序号键必须用 view+text，避免真机 Grid 内 button 文字被裁没");
  assert.doesNotMatch(vehicleMarkup, /green_small' && index === 2\)/, "新能源小型不应再锁定第 3 格 D/F");
  assert.match(vehicleMarkup, /按实际号牌填写字母或数字/);
  assert.match(vehicleMarkup, /plate-prefix-row/);
  assert.match(vehicleMarkup, /清空序号/);
  assert.match(vehicleStyle, /\.plate-key\s*\{[^}]*display:\s*flex[^}]*min-height:\s*88rpx/);
  assert.match(vehicleStyle, /\.plate-keyboard-sheet\s*\{[^}]*height:\s*74vh[^}]*max-height:\s*calc\(100vh - 48rpx\)[^}]*overflow:\s*hidden/);
  assert.match(vehicleStyle, /\.plate-keyboard-scroll\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(vehicleStyle, /\.serial-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(vehicleStyle, /\.serial-controls \.done\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(vehicleStyle, /@media \(max-width:\s*340px\)[\s\S]*grid-template-columns:\s*repeat\(4,/);

  assert.match(operatorMarkup, /class="task-time"><text>\{\{item\.startTime\}\}<\/text><text>至 \{\{item\.endTime\}\}<\/text><text>\{\{item\.dateLabel\}\}<\/text>/);
  assert.match(operatorStyle, /\.task-row\s*\{[^}]*grid-template-columns:\s*104rpx minmax\(0, 1fr\) 26rpx[^}]*grid-template-rows:\s*auto auto auto/);
  assert.match(operatorStyle, /\.task-status\s*\{[^}]*grid-column:\s*2 \/ 4[^}]*grid-row:\s*2[^}]*flex-wrap:\s*wrap/);
  assert.match(operatorStyle, /\.filter-row\s*\{[^}]*padding:\s*0 28rpx 2rpx 0/);
  assert.match(operatorStyle, /@media \(max-width:\s*340px\)[\s\S]*grid-template-columns:\s*92rpx minmax\(0, 1fr\) 24rpx/);
});
