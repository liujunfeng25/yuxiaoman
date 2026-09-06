import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type {
  CheckupMedia,
  VehicleCheckupReport,
  VehicleCheckupReportListData,
  VehicleCheckupReportProgress,
  VehicleCheckupReportSummary,
  VehicleFault,
} from "../miniprogram/types";
import { normalizeVehicleCheckupReportList } from "../miniprogram/services/api";
import {
  progressCard,
  reportCard,
  vehicleFilters,
} from "../miniprogram/packages/inspection/pages/checkup-reports/checkup-reports.model";
import {
  ANNUAL_FAILURE_CATEGORIES,
  CHECKUP_REGIONS,
  CHECKUP_SYSTEM_REGIONS,
  LEGAL_MATERIAL_SLOTS,
  annualFailureDetails,
  annualInspectionFailureDetails,
  buildPhotoSlots,
  buildFaultBubbleStyle,
  buildRegionCallout,
  buildRegionCallouts,
  checkupRegionsForVehicle,
  checkupVehicleDiagram,
  extractSummaryText,
  faultDraftInput,
  faultMarkerState,
  faultPhotoPreviewUrls,
  faultPhotos,
  mergeFaultPhotos,
  removeFaultPhoto,
  replacePhotoSlot,
  replaceFaultPhoto,
  reportMedia,
  reportPreviewUrls,
  summaryPayload,
  upsertFault,
  validateCheckupForSubmit,
} from "../miniprogram/packages/inspection/utils/checkup-report";
import { annualConclusionNarrative, faultAdvice, vehicleConditionNarrative, vehicleConditionTitle } from "../miniprogram/packages/inspection/utils/report-copy";
import { formatShanghaiDateTime } from "../miniprogram/utils/format";

function media(kind: CheckupMedia["kind"]): CheckupMedia {
  return { id: `media-${kind}`, kind, url: `/media/${kind}.jpg` };
}

function closeup(id: string, faultId: string, sequence: number): CheckupMedia {
  return { id, faultId, kind: "fault_closeup", sequence, url: `/media/${id}.jpg` };
}

function report(): VehicleCheckupReport {
  const mediaItems = ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started", "safety_inspection_report"].map((kind) => media(kind as CheckupMedia["kind"]));
  return {
    diagramVersion: "sedan-3view-v1",
    observationMode: "no_visible_faults",
    annualInspection: {
      conclusion: "failed",
      conclusionStatus: "available",
      markStatus: "not_issued",
      summary: { text: "检测完成" },
      failureDetails: annualInspectionFailureDetails(["instrumented_test"], "制动项目检测值不符合要求", "完成整改后预约复检"),
    },
    faults: [],
    media: mediaItems,
  };
}

test("车辆示意图固定为三视图二十八个稳定区域", () => {
  assert.equal(CHECKUP_REGIONS.length, 28);
  assert.equal(CHECKUP_REGIONS.filter((item) => item.viewId === "top").length, 8);
  assert.equal(CHECKUP_REGIONS.filter((item) => item.viewId === "left").length, 10);
  assert.equal(CHECKUP_REGIONS.filter((item) => item.viewId === "right").length, 10);
  assert.equal(new Set(CHECKUP_REGIONS.map((item) => item.code)).size, 28);
  assert.ok([
    "front_face", "windshield", "rear_glass", "trunk_tailgate",
    "left_rear_quarter", "right_rear_quarter", "left_front_window", "right_front_window",
    "left_front_wheel", "right_front_wheel", "left_rear_wheel", "right_rear_wheel",
  ].every((code) => CHECKUP_REGIONS.some((item) => item.code === code)));
});

test("不能准确落在外观图上的八类功能系统使用独立位置入口", () => {
  assert.equal(CHECKUP_SYSTEM_REGIONS.length, 8);
  assert.equal(new Set(CHECKUP_SYSTEM_REGIONS.map((item) => item.code)).size, 8);
  assert.deepEqual(CHECKUP_SYSTEM_REGIONS.map((item) => item.code), [
    "dashboard_obd",
    "engine_powertrain",
    "brake_system",
    "steering_suspension",
    "chassis_exhaust",
    "cabin_electrical",
    "fuel_charging",
    "other_system",
  ]);
});

test("逐槽上传或替换不会清除其他已上传照片", () => {
  let slots = buildPhotoSlots(null);
  slots = replacePhotoSlot(slots, "front_left", media("front_left"));
  slots = replacePhotoSlot(slots, "front_right", media("front_right"));
  assert.equal(slots.find((item) => item.kind === "front_left")?.media?.id, "media-front_left");
  assert.equal(slots.find((item) => item.kind === "front_right")?.media?.id, "media-front_right");

  slots = replacePhotoSlot(slots, "front_right", { ...media("front_right"), id: "replacement" });
  assert.equal(slots.find((item) => item.kind === "front_left")?.media?.id, "media-front_left");
  assert.equal(slots.find((item) => item.kind === "front_right")?.media?.id, "replacement");
});

test("同一区域支持多故障且编辑只替换目标记录", () => {
  const first: VehicleFault = { id: "f1", viewId: "left", regionCode: "left_front_door", faultType: "scratch", severity: "minor" };
  const second: VehicleFault = { id: "f2", viewId: "left", regionCode: "left_front_door", faultType: "dent", severity: "moderate" };
  let faults = upsertFault([], first);
  faults = upsertFault(faults, second);
  faults = upsertFault(faults, { ...first, severity: "severe" });
  assert.equal(faults.length, 2);
  assert.equal(faults.find((item) => item.id === "f1")?.severity, "severe");
  assert.equal(faults.find((item) => item.id === "f2")?.faultType, "dent");
});

test("故障草稿输入不携带只读照片，新故障先以 clientKey 幂等保存", () => {
  const local: VehicleFault = {
    id: "local-100-1",
    viewId: "left",
    regionCode: "left_front_door",
    faultType: "scratch",
    severity: "minor",
    description: "约 5cm",
    photos: [closeup("p1", "server-f1", 1)],
  };
  assert.deepEqual(faultDraftInput(local), {
    clientKey: "local-100-1",
    viewId: "left",
    regionCode: "left_front_door",
    faultType: "scratch",
    severity: "minor",
    description: "约 5cm",
  });
  const persisted = faultDraftInput({ ...local, id: "server-f1", clientKey: "local-100-1" });
  assert.equal(persisted.id, "server-f1");
  assert.equal(persisted.clientKey, "local-100-1");
  assert.ok(!("photos" in persisted));
});

test("同位置多故障的特写按故障 id 隔离，刷新只合并各自服务端照片", () => {
  const local: VehicleFault[] = [
    { id: "f1", viewId: "left", regionCode: "left_front_door", faultType: "scratch", severity: "severe", photos: [closeup("old-1", "f1", 1)] },
    { id: "f2", viewId: "left", regionCode: "left_front_door", faultType: "dent", severity: "moderate", photos: [] },
  ];
  const remote: VehicleFault[] = [
    { ...local[0], severity: "minor", photos: [closeup("new-1", "f1", 1)] },
    { ...local[1], photos: [closeup("new-2", "f2", 1)] },
  ];
  const merged = mergeFaultPhotos(local, remote);
  assert.equal(merged[0].severity, "severe", "未保存的本地文字修改应保留");
  assert.deepEqual(faultPhotoPreviewUrls(merged[0]), ["/media/new-1.jpg"]);
  assert.deepEqual(faultPhotoPreviewUrls(merged[1]), ["/media/new-2.jpg"]);
});

test("重拍成功只原子替换目标照片，失败前旧图与其他故障保持不变", () => {
  const faults: VehicleFault[] = [
    { id: "f1", viewId: "left", regionCode: "left_front_door", faultType: "scratch", severity: "minor", photos: [closeup("old", "f1", 1)] },
    { id: "f2", viewId: "left", regionCode: "left_front_door", faultType: "dent", severity: "moderate", photos: [closeup("other", "f2", 1)] },
  ];
  assert.equal(faultPhotos(faults[0])[0].id, "old", "上传失败时不应用更新，原图仍在");
  const replaced = replaceFaultPhoto(faults, "f1", closeup("replacement", "f1", 1), "old");
  assert.deepEqual(faultPhotos(replaced[0]).map((item) => item.id), ["replacement"]);
  assert.deepEqual(faultPhotos(replaced[1]).map((item) => item.id), ["other"]);
  const removed = removeFaultPhoto(replaced, "f1", "replacement");
  assert.deepEqual(faultPhotos(removed[0]), []);
  assert.deepEqual(faultPhotos(removed[1]).map((item) => item.id), ["other"]);
});

test("故障特写不混入固定附件统计或固定附件预览", () => {
  const value = report();
  value.faults = [{
    id: "f1",
    viewId: "left",
    regionCode: "left_front_door",
    faultType: "scratch",
    severity: "minor",
    photos: [closeup("p1", "f1", 1)],
  }];
  assert.equal(value.media.length, 6);
  assert.equal(reportPreviewUrls(value).length, 6);
  assert.ok(!reportPreviewUrls(value).includes("/media/p1.jpg"));
});

test("热点编号与全局故障序号一致，同区域多故障优先显示当前选中序号", () => {
  const faults: VehicleFault[] = [
    { id: "f1", viewId: "left", regionCode: "left_front_door", faultType: "scratch", severity: "minor" },
    { id: "f2", viewId: "right", regionCode: "right_rear_quarter", faultType: "dent", severity: "moderate" },
    { id: "f3", viewId: "right", regionCode: "right_rear_quarter", faultType: "paint_damage", severity: "severe" },
  ];
  assert.deepEqual(faultMarkerState(faults, "right_rear_quarter"), { faultCount: 2, markerLabel: "2", targetFaultId: "f2" });
  assert.deepEqual(faultMarkerState(faults, "right_rear_quarter", "f3"), { faultCount: 2, markerLabel: "3", targetFaultId: "f3" });
  assert.deepEqual(faultMarkerState(faults, "right_front_door"), { faultCount: 0, markerLabel: "+", targetFaultId: "" });
});

test("左右侧后视镜、前后车门和翼子板热点按镜像关系落在对应部件", () => {
  const byCode = new Map(CHECKUP_REGIONS.map((item) => [item.code, item]));
  assert.deepEqual({ x: byCode.get("left_mirror")?.x, y: byCode.get("left_mirror")?.y }, { x: 69, y: 38 });
  assert.deepEqual({ x: byCode.get("left_front_fender")?.x, y: byCode.get("left_front_fender")?.y }, { x: 48, y: 51 });
  assert.deepEqual({ x: byCode.get("left_front_door")?.x, y: byCode.get("left_front_door")?.y }, { x: 67, y: 55 });
  assert.deepEqual({ x: byCode.get("left_rear_door")?.x, y: byCode.get("left_rear_door")?.y }, { x: 80, y: 53 });
  assert.deepEqual({ x: byCode.get("left_rear_quarter")?.x, y: byCode.get("left_rear_quarter")?.y }, { x: 89, y: 54 });
  for (const leftCode of ["mirror", "front_fender", "front_door", "rear_door", "rear_quarter", "sill", "front_window", "rear_window", "front_wheel", "rear_wheel"]) {
    const left = byCode.get(`left_${leftCode}`)!;
    const right = byCode.get(`right_${leftCode}`)!;
    assert.equal(right.x, 100 - left.x, `${leftCode} 左右坐标必须镜像`);
    assert.equal(right.y, left.y, `${leftCode} 左右高度必须一致`);
  }
  assert.ok((byCode.get("left_rear_door")?.x || 0) > (byCode.get("left_front_door")?.x || 0));
  assert.ok((byCode.get("right_rear_door")?.x || 0) < (byCode.get("right_front_door")?.x || 0));
});

test("车辆定位图优先使用车主所选车型图片并为右侧生成镜像", () => {
  const exact = checkupVehicleDiagram({
    id: "vehicle-1", plateNumber: "津A00001", vehicleType: "小型轿车", usageNature: "非营运", seats: 5,
    registrationDate: "2022-01-01", inspectionDueDate: "2026-12-31", isDefault: true,
    brand: { id: "brand-byd", name: "比亚迪" }, model: { id: "vehicle-byd-han", name: "汉" },
    visual: { imageUrl: "http://127.0.0.1:8792/assets/vehicle-byd-han.webp", kind: "presentation_cutout", label: "车型展示图" },
  });
  assert.equal(exact.vehicleLabel, "比亚迪 汉");
  assert.equal(exact.bodyType, "sedan");
  assert.equal(exact.sourceLabel, "轿车 · 车主所选车型参考图");
  assert.equal(exact.views.find((item) => item.id === "left")?.imagePath, exact.views.find((item) => item.id === "right")?.imagePath);
  assert.equal(exact.views.find((item) => item.id === "left")?.mirrored, false);
  assert.equal(exact.views.find((item) => item.id === "right")?.mirrored, true);

  const baseVehicle = {
    id: "vehicle-2", plateNumber: "津A00002", vehicleType: "小型轿车", usageNature: "非营运", seats: 5,
    registrationDate: "2022-01-01", inspectionDueDate: "2026-12-31", isDefault: true, washVehicleCategory: "sedan",
  } as const;
  const fallback = checkupVehicleDiagram(baseVehicle);
  assert.match(fallback.views.find((item) => item.id === "left")?.imagePath || "", /car-sedan-left-v1\.png$/u);
  assert.match(fallback.views.find((item) => item.id === "top")?.imagePath || "", /car-sedan-top-v1\.png$/u);

  const suv = checkupVehicleDiagram({
    ...baseVehicle,
    id: "vehicle-3",
    washVehicleCategory: "suv",
    visual: { imageUrl: "http://127.0.0.1:8792/assets/vehicle-li-l7.webp", kind: "presentation_cutout", label: "车型展示图" },
  });
  assert.equal(suv.bodyType, "suv");
  assert.equal(suv.sourceLabel, "SUV · 车主所选车型参考图");
  assert.equal(suv.regions.find((item) => item.code === "left_front_wheel")?.y, 66);

  const mpv = checkupVehicleDiagram({ ...baseVehicle, id: "vehicle-4", washVehicleCategory: "mpv", vehicleType: "小型MPV" });
  assert.equal(mpv.bodyType, "mpv");
  assert.match(mpv.views.find((item) => item.id === "left")?.imagePath || "", /car-mpv-left-v1\.png$/u);
  assert.match(mpv.views.find((item) => item.id === "top")?.imagePath || "", /car-mpv-top-v1\.png$/u);
  assert.equal(mpv.regions.find((item) => item.code === "left_mirror")?.x, 59);
});

test("区域引出标注提供圆点、线段与可点文字位置", () => {
  const callout = buildRegionCallout(CHECKUP_REGIONS.find((item) => item.code === "right_rear_door")!);
  assert.equal(callout.label, "右后门");
  assert.match(callout.dotStyle, /left:20%;top:53%/u);
  assert.match(callout.labelStyle, /left:23%;top:80%/u);
  assert.match(callout.lineStyle, /transform:rotate\(/u);
  assert.ok(callout.lineLength > 5 && callout.lineLength < 80);
  assert.ok(Number.isFinite(callout.lineAngle));
});

test("同视角标签中心保持可读间距", () => {
  for (const viewId of ["top", "left", "right"] as const) {
    const callouts = buildRegionCallouts(viewId);
    assert.ok(callouts.length >= 6);
    for (let i = 0; i < callouts.length; i += 1) {
      for (let j = i + 1; j < callouts.length; j += 1) {
        const dx = callouts[i].labelX - callouts[j].labelX;
        const dy = (callouts[i].labelY - callouts[j].labelY) * (2 / 3);
        const distance = Math.hypot(dx, dy);
        assert.ok(distance >= 8, `${viewId} ${callouts[i].code} vs ${callouts[j].code} 标签过近: ${distance.toFixed(2)}`);
      }
    }
  }
});

test("每个区域都配置了引出标签锚点", () => {
  for (const region of CHECKUP_REGIONS) {
    assert.ok(region.labelX >= 18 && region.labelX <= 82, `${region.code} 标签必须处在横向安全区`);
    assert.ok(region.labelY >= 8 && region.labelY <= 91, `${region.code} 标签必须处在纵向安全区`);
    assert.ok(Math.hypot(region.labelX - region.x, region.labelY - region.y) >= 8, `${region.code} 引出过短`);
  }
});

test("故障气泡贴着引出标签外侧，避免盖住车身中部热点", () => {
  const rear = CHECKUP_REGIONS.find((item) => item.code === "left_rear_quarter")!;
  const style = buildFaultBubbleStyle(rear);
  const left = Number(/left:([\d.]+)%/u.exec(style)?.[1]);
  const top = Number(/top:([\d.]+)%/u.exec(style)?.[1]);
  assert.ok(left >= 40 && left <= 60, `后部故障气泡应在右侧安全区，实际 left=${left}`);
  assert.ok(top <= 40, `后部故障气泡应靠上，实际 top=${top}`);
  const front = CHECKUP_REGIONS.find((item) => item.code === "left_front_door")!;
  const frontLeft = Number(/left:([\d.]+)%/u.exec(buildFaultBubbleStyle(front))?.[1]);
  assert.ok(frontLeft <= 30, `前部故障气泡应靠左外缘，实际 left=${frontLeft}`);
});

test("轿车、SUV、MPV 三套定位热点落在对应模板车辆区域内", async () => {
  const filenames = {
    sedan: { top: "car-sedan-top-v1.png", side: "car-sedan-left-v1.png" },
    suv: { top: "car-top.png", side: "car-suv-left-v1.png" },
    mpv: { top: "car-mpv-top-v1.png", side: "car-mpv-left-v1.png" },
  } as const;
  for (const bodyType of ["sedan", "suv", "mpv"] as const) {
    const regions = checkupRegionsForVehicle(bodyType, false);
    for (const viewId of ["top", "left", "right"] as const) {
      const filename = viewId === "top" ? filenames[bodyType].top : filenames[bodyType].side;
      const imagePath = fileURLToPath(new URL(`../miniprogram/packages/inspection/assets/inspection-checkup/${filename}`, import.meta.url));
      const source = sharp(imagePath).ensureAlpha();
      const { data, info } = await (viewId === "right" ? source.flop() : source).raw().toBuffer({ resolveWithObject: true });
      for (const region of regions.filter((item) => item.viewId === viewId)) {
        const centerX = Math.round((region.x / 100) * (info.width - 1));
        const centerY = Math.round((region.y / 100) * (info.height - 1));
        let opaque = 0;
        let sampled = 0;
        for (let y = Math.max(0, centerY - 20); y <= Math.min(info.height - 1, centerY + 20); y += 1) {
          for (let x = Math.max(0, centerX - 20); x <= Math.min(info.width - 1, centerX + 20); x += 1) {
            sampled += 1;
            if (data[(y * info.width + x) * info.channels + 3] > 32) opaque += 1;
          }
        }
        assert.ok(opaque / sampled >= 0.35, `${bodyType} ${region.code} 热点中心必须位于对应车型图像内`);
      }
    }
  }
});

test("车主所选轿车、SUV、MPV 展示图使用各自校准后的定位坐标", async () => {
  const samples = {
    sedan: "owner-models/vehicle-byd-han.webp",
    suv: "owner-models/vehicle-li-l7.webp",
    mpv: "owner-presentation-v2/vehicle-honda-odyssey.webp",
  } as const;
  for (const bodyType of ["sedan", "suv", "mpv"] as const) {
    const imagePath = fileURLToPath(new URL(`../../public/assets/used-cars/${samples[bodyType]}`, import.meta.url));
    const { data, info } = await sharp(imagePath)
      .ensureAlpha()
      .resize({ width: 800, height: 533, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (const region of checkupRegionsForVehicle(bodyType, true).filter((item) => item.viewId === "left")) {
      const centerX = Math.round((region.x / 100) * (info.width - 1));
      const centerY = Math.round((region.y / 100) * (info.height - 1));
      let opaque = 0;
      let sampled = 0;
      for (let y = Math.max(0, centerY - 18); y <= Math.min(info.height - 1, centerY + 18); y += 1) {
        for (let x = Math.max(0, centerX - 18); x <= Math.min(info.width - 1, centerX + 18); x += 1) {
          sampled += 1;
          if (data[(y * info.width + x) * info.channels + 3] > 32) opaque += 1;
        }
      }
      assert.ok(opaque / sampled >= 0.2, `${bodyType} 车型展示图的 ${region.code} 定位不得落到透明区`);
    }
  }
});

test("提交校验要求五张现场照和状态确认，仅通过结果强制要求检验合格凭证", () => {
  const complete = report();
  assert.deepEqual(validateCheckupForSubmit(complete), []);

  const passed = { ...complete, annualInspection: { conclusion: "passed" as const, markStatus: "not_issued" as const } };
  assert.match(validateCheckupForSubmit(passed).join(" "), /检验合格标志\/电子凭证留证/);
  passed.media.push(media("annual_inspection_mark"));
  assert.deepEqual(validateCheckupForSubmit(passed), []);

  const failedWithMark = { ...passed, annualInspection: { conclusion: "failed" as const, markStatus: "not_issued" as const } };
  assert.match(validateCheckupForSubmit(failedWithMark).join(" "), /不能保留检验合格标志\/电子凭证留证/);

  const missingSafety = { ...complete, media: complete.media.filter((item) => !["safety_inspection_report", "annual_inspection_mark"].includes(item.kind)) };
  assert.deepEqual(validateCheckupForSubmit(missingSafety), []);
  assert.deepEqual(LEGAL_MATERIAL_SLOTS.map((item) => [item.kind, item.required]), [
    ["safety_inspection_report", false],
    ["emissions_inspection_report", false],
    ["annual_inspection_mark", true],
  ]);

  const missing = { ...complete, media: complete.media.filter((item) => item.kind !== "rear_right") };
  assert.match(validateCheckupForSubmit(missing).join(" "), /右后/);
});

test("履约时间统一按北京时间显示并正确跨日", () => {
  assert.equal(formatShanghaiDateTime("2026-08-31T14:10:52.398Z"), "2026-08-31 22:10:52");
  assert.equal(formatShanghaiDateTime("2026-08-31T20:30:00.000Z"), "2026-09-01 04:30:00");
  assert.equal(formatShanghaiDateTime("not-a-time", "时间待记录"), "时间待记录");
});

test("车辆热点、故障弹层与报告预览使用窄屏安全布局", () => {
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  assert.match(markup, /vehicle-stage[\s\S]*vehicle-visual-frame[\s\S]*region-callout-line[\s\S]*region-hotspot[\s\S]*region-callout-label[\s\S]*vehicle-caption/u);
  assert.match(markup, /点击定位点或部位名称，先选择故障程度/u);
  assert.match(markup, /功能系统部位[\s\S]*system-region-button[\s\S]*tapSystemRegion/u);
  assert.match(style, /\.vehicle-visual-frame\s*\{[^}]*padding-top:\s*66\.6667%/u);
  assert.match(style, /\.region-callout-label\s*\{/u);
  assert.match(style, /\.region-callout-line\s*\{/u);
  assert.match(style, /\.fault-actions\s*\{[^}]*grid-column:\s*2/u);
  assert.match(style, /\.choice-grid\.fault-types,[^}]*repeat\(2/u);
  assert.match(style, /\.preview-document-button\s*\{[^}]*display:\s*flex[^}]*width:\s*100%/u);
});

test("点击车辆位置先进入独立程度选择页，再回到故障详情与照片", () => {
  const editorScript = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  const severityMarkup = readFileSync(new URL("../miniprogram/packages/inspection/pages/fault-severity/fault-severity.wxml", import.meta.url), "utf8");
  const severityScript = readFileSync(new URL("../miniprogram/packages/inspection/pages/fault-severity/fault-severity.ts", import.meta.url), "utf8");
  const appConfig = readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8");
  assert.match(editorScript, /pages\/fault-severity\/fault-severity\?regionCode=/u);
  assert.match(editorScript, /faultSeveritySelected/u);
  assert.match(severityMarkup, /选择故障程度[\s\S]*当前故障位置[\s\S]*下一步：填写故障详情/u);
  assert.match(severityScript, /轻微[\s\S]*一般[\s\S]*明显[\s\S]*faultSeveritySelected/u);
  assert.match(appConfig, /pages\/fault-severity\/fault-severity/u);
});

test("结果回传逐条精确校验故障特写 1–3 张", () => {
  const value = report();
  value.observationMode = "faults_recorded";
  value.faults = [
    { id: "f1", viewId: "left", regionCode: "left_front_door", faultType: "scratch", severity: "minor", photos: [closeup("p1", "f1", 1)] },
    { id: "f2", viewId: "right", regionCode: "right_rear_quarter", faultType: "dent", severity: "moderate", photos: [] },
  ];
  assert.match(validateCheckupForSubmit(value).join(" "), /#2 右后翼子板/);
  value.faults[1].photos = [closeup("p2", "f2", 1)];
  assert.deepEqual(validateCheckupForSubmit(value), []);
  value.faults[0].photos = [1, 2, 3, 4].map((sequence) => closeup(`p1-${sequence}`, "f1", sequence));
  assert.match(validateCheckupForSubmit(value).join(" "), /每条故障最多保留 3 张特写：#1 左前门/);
});

test("报告说明始终以结构化对象提交且只渲染其中的文本", () => {
  assert.deepEqual(summaryPayload("  车身问题已记录  "), { text: "车身问题已记录" });
  assert.deepEqual(summaryPayload("  "), {});
  assert.equal(extractSummaryText({ text: "主说明" }, { note: "后备说明" }), "主说明");
  assert.equal(extractSummaryText({ summary: "兼容说明" }), "兼容说明");
  assert.equal(extractSummaryText({ count: 2 }), "");
});

test("年检正式结论只允许通过或未通过，未通过明细必须完整且不受车况故障影响", () => {
  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  assert.match(source, /\{ value: "passed", label: "通过" \}/);
  assert.match(source, /\{ value: "failed", label: "未通过" \}/);
  assert.doesNotMatch(source, /value: "conditional"/);
  assert.match(markup, /conclusion === 'failed'/);
  for (const text of ["未通过项目类别", "具体原因 / 检测说明", "整改与复检建议", "车身剐蹭、凹陷等体检记录不会自动生成未通过结论"]) {
    assert.match(markup, new RegExp(text));
  }
  const readonlyMarkup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxml", import.meta.url), "utf8");
  assert.match(readonlyMarkup, /showFailureDetails/);
  for (const field of ["failureCategoryText", "failureReasonText", "retestAdviceText"]) assert.match(readonlyMarkup, new RegExp(field));

  const value = report();
  value.annualInspection = { conclusion: "failed", conclusionStatus: "available", markStatus: "not_issued", failureDetails: null };
  const errors = validateCheckupForSubmit(value).join(" ");
  assert.match(errors, /至少一个未通过项目类别/);
  assert.match(errors, /具体原因/);
  assert.match(errors, /整改与复检建议/);

  value.annualInspection.failureDetails = annualInspectionFailureDetails(["instrumented_test"], "制动不符合要求", "整改后复检");
  assert.deepEqual(validateCheckupForSubmit(value), []);
  assert.deepEqual(annualFailureDetails(value.annualInspection.failureDetails), {
    categories: ["instrumented_test"],
    categoryLabels: ["仪器设备检验"],
    reason: "制动不符合要求",
    retestAdvice: "整改后复检",
  });
  assert.deepEqual(annualInspectionFailureDetails(["instrumented_test"], "制动不符合要求", "整改后复检"), {
    itemCategories: ["instrumented_test"], reason: "制动不符合要求", reinspectionAdvice: "整改后复检",
  });
  assert.equal(ANNUAL_FAILURE_CATEGORIES.length, 9);
  assert.equal(ANNUAL_FAILURE_CATEGORIES.find((item) => item.value === "vehicle_appearance")?.label, "车辆外观检查（官方年检项目）");
});

test("结论从未通过切换为通过时清空失败字段，避免恢复旧判断", () => {
  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  const passBranch = source.match(/if \(conclusion === "passed"\) \{[\s\S]*?return;\s*\}/)?.[0] || "";
  assert.match(passBranch, /failureCategories:\s*\[\]/);
  assert.match(passBranch, /failureCategoryOptions:\s*multiChoices\(ANNUAL_FAILURE_CATEGORIES, \[\]\)/);
  assert.match(passBranch, /failureReason:\s*""/);
  assert.match(passBranch, /retestAdvice:\s*""/);
});

test("短屏未通过预览使用可滚动正文并把安全区操作按钮固定在正文外", () => {
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  assert.match(markup, /<scroll-view class="preview-scroll"[\s\S]*preview-failure-details[\s\S]*<\/scroll-view>\s*<view class="preview-actions"/);
  const previewSheet = style.match(/\.preview-sheet\s*\{[^}]*\}/)?.[0] || "";
  assert.match(previewSheet, /height:\s*calc\(100vh - 24rpx\)/);
  assert.match(previewSheet, /overflow:\s*hidden/);
  assert.match(previewSheet, /env\(safe-area-inset-bottom\)/);
  assert.match(style, /\.preview-scroll\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(style, /\.preview-actions button\s*\{[^}]*min-height:\s*96rpx/);
});

test("短屏故障编辑器固定标题和安全区操作栏，仅正文使用原生纵向滚动", () => {
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  const sheet = markup.match(/<view class="fault-sheet"[\s\S]*?<\/view>\s*<\/view>\s*<view wx:if="\{\{previewOpen\}\}"/)?.[0] || "";
  assert.match(sheet, /<view class="sheet-head"[\s\S]*<scroll-view class="fault-sheet-scroll"/);
  assert.match(sheet, /<scroll-view class="fault-sheet-scroll"[^>]*scroll-y="\{\{true\}\}"[^>]*show-scrollbar="\{\{true\}\}"/);
  assert.match(sheet, /<\/scroll-view>\s*<view wx:if="\{\{editingFaultPersisted\}\}" class="sheet-actions"/);
  assert.match(sheet, /aria-label="关闭故障编辑"/);
  assert.match(sheet, /<textarea[^>]*fixed="\{\{true\}\}"[^>]*cursor-spacing="96"[^>]*disable-default-padding="\{\{true\}\}"/);
  assert.doesNotMatch(sheet, /catchtouchmove=/, "故障编辑器不能拦截自身纵向滚动");
  const rule = style.match(/\.fault-sheet\s*\{[^}]*\}/)?.[0] || "";
  assert.match(rule, /display:\s*flex/);
  assert.match(rule, /height:\s*calc\(100vh - 88rpx\)/);
  assert.doesNotMatch(rule, /max-height:/, "纵向上限不能使用随屏宽换算的 rpx，否则高窄屏会把抽屉压成半屏");
  assert.match(rule, /overflow:\s*hidden/);
  assert.match(rule, /env\(safe-area-inset-bottom\)/);
  assert.match(style, /\.fault-sheet-scroll\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(style, /\.fault-description textarea\s*\{[^}]*height:\s*144rpx/);
  assert.match(style, /\.new-fault-actions\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(style, /\.sheet-head > button\s*\{[^}]*margin:\s*0 0 0 auto/);
});

test("故障类型最后一项跨整行且选中态包含可读文字", () => {
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  assert.match(markup, /aria-label="\{\{item\.label\}\}，\{\{item\.selected \? '已选择' : '未选择'\}\}"/);
  assert.match(markup, /<text wx:if="\{\{item\.selected\}\}">已选<\/text>/);
  assert.match(style, /\.choice-grid\.fault-types button:last-child,[^}]*\.choice-grid\.severity-types button:last-child\s*\{[^}]*width:\s*100%[^}]*grid-column:\s*1 \/ -1/);
});

test("打开故障编辑器会先收起上一张照片的成功提示，避免遮挡弹层", () => {
  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  assert.match(source, /openFaultEditor\(regionCode:[\s\S]*wx\.hideToast\(\);[\s\S]*faultEditorOpen:\s*true/);
});

test("检测端上传或提交期间锁定可变字段并给出明确等待状态", () => {
  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  assert.match(source, /fixedPhotoUploadingCount:\s*this\.data\.fixedPhotoUploadingCount \+ 1/);
  assert.match(source, /faultPhotoBusyCount:\s*this\.data\.faultPhotoAttempts\.filter/);
  assert.match(source, /if \(this\.data\.fixedPhotoUploadingCount > 0 \|\| this\.data\.safetyReportUploading \|\| this\.data\.emissionsReportUploading \|\| this\.data\.markUploading \|\| this\.data\.faultPhotoBusyCount > 0\)/);
  assert.match(markup, /disabled="\{\{saving \|\| submitting \|\| fixedPhotoUploadingCount > 0 \|\| safetyReportUploading \|\| emissionsReportUploading \|\| markUploading \|\| faultPhotoBusyCount > 0\}\}"/);
  assert.match(markup, /材料处理中/);
  assert.match(markup, /等待材料完成/);
  assert.match(markup, /bindtap="selectConclusion" disabled="\{\{saving \|\| submitting\}\}"/);
  assert.match(markup, /bindinput="inputFailureReason" disabled="\{\{saving \|\| submitting\}\}"/);
});

test("历史旧结论不会转成未通过，而是要求重新录入正式结果", () => {
  const legacy = report();
  legacy.annualInspection = { conclusion: null, conclusionStatus: "legacy_requires_reentry", markStatus: "not_issued" };
  assert.match(validateCheckupForSubmit(legacy).join(" "), /历史结论已停用/);
  assert.match(annualConclusionNarrative(null, "legacy_requires_reentry"), /正式年检结果尚未确认/);
  assert.match(annualConclusionNarrative(null, "legacy_requires_reentry"), /不能视为未通过/);
});

test("体检编辑页只在首次 onLoad 拉取报告，相机或相册返回不会重置未保存草稿", () => {
  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  assert.match(source, /this\.setData\(\{ id, operatorAccessReady \}, \(\) => \{ if \(operatorAccessReady\) void this\.load\(\); \}\)/);
  assert.doesNotMatch(source, /\bonShow\s*\(/);
  assert.doesNotMatch(source, /api\.operatorCheckupReport\(this\.data\.id\)\.catch\(\(\) => null\)/, "报告读取错误不能伪装成一份空白新报告");
  assert.match(source, /loadError:\s*error instanceof Error/);
  assert.match(markup, /暂时无法填写检测结果/);
  assert.match(markup, /retryLoad/);
  assert.match(style, /\.editor-error-actions button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(source, /this\.setData\(\{ previewOpen: true \}\)/);
  assert.match(source, /confirmSubmit\(\)/);
  assert.match(source, /itemList: \["拍照", "从相册选择"\]/, "故障特写应相机优先并支持相册");
  assert.match(source, /const saved = await this\.saveDraft\(false\)[\s\S]*promptFaultPhotoSource\(persisted\.id/, "新故障应先保存取得稳定 id 再拍摄");
});

test("体检舞台背景使用 WXML 图片层，避免 DevTools 禁止 WXSS 本地 url", () => {
  const template = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  assert.match(template, /class="vehicle-stage-background"[^>]+src="\/packages\/inspection\/assets\/inspection-checkup\/diagnostic-stage\.jpg"/);
  assert.match(styles, /\.vehicle-stage-background\s*\{[^}]*position:\s*absolute[^}]*width:\s*100%[^}]*height:\s*100%/);
  assert.doesNotMatch(styles, /url\([^)]*(?:\/packages\/|\/assets\/|\.\.\/)/);
});

test("媒体可从扁平列表和结构化照片字段读取", () => {
  const value = report();
  assert.equal(reportMedia(value, "front_left")?.id, "media-front_left");
  value.media = [];
  value.sitePhotos = { frontLeft: media("front_left") };
  assert.equal(reportMedia(value, "front_left")?.id, "media-front_left");
});

test("文字报告明确拆分年检结论与车辆体检记录", () => {
  const noFault = report();
  assert.equal(vehicleConditionTitle(noFault), "本次记录未发现明显异常");
  assert.match(vehicleConditionNarrative(noFault), /现场照片与可见范围/);
  assert.match(vehicleConditionNarrative(noFault), /不替代年检结论/);
  assert.match(annualConclusionNarrative("passed"), /交管官方记录/);

  const withFaults: VehicleCheckupReport = {
    ...noFault,
    observationMode: "faults_recorded",
    faults: [
      { id: "f1", viewId: "left", regionCode: "left_front_door", faultType: "scratch", severity: "minor" },
      { id: "f2", viewId: "right", regionCode: "right_rear_quarter", faultType: "dent", severity: "moderate" },
    ],
  };
  assert.equal(vehicleConditionTitle(withFaults), "本次记录发现 2 项车辆问题");
  assert.match(vehicleConditionNarrative(withFaults), /不会自动判定年检未通过/);
});

test("每条故障生成克制且与类型程度相关的处理建议", () => {
  const minorScratch: VehicleFault = { id: "f1", viewId: "left", regionCode: "left_front_door", faultType: "scratch", severity: "minor" };
  const severeBroken: VehicleFault = { id: "f2", viewId: "right", regionCode: "right_rear_quarter", faultType: "broken", severity: "severe" };
  assert.match(faultAdvice(minorScratch), /留存照片/);
  assert.match(faultAdvice(minorScratch), /底漆/);
  assert.match(faultAdvice(severeBroken), /尽快安排专业检查/);
  assert.match(faultAdvice(severeBroken), /固定、照明或密封/);
  assert.doesNotMatch(faultAdvice(severeBroken), /已经损坏|必须更换|保证安全/);
});

test("只读页面包含完整文字报告结构且不伪造官方报告要素", () => {
  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxml", import.meta.url), "utf8");
  for (const heading of ["报告与车辆信息", "年检结论", "车辆体检记录", "故障明细与建议", "法定检测材料", "平台车辆体检留证", "车辆问题定位", "照片材料预览"]) {
    assert.match(source, new RegExp(heading));
  }
  assert.match(source, /平台报告编号/);
  assert.match(source, /不是机动车安全技术检验机构出具的官方报告/);
  assert.match(source, /不含官方报告号或检验机构签章/);
  assert.doesNotMatch(source, />授权签字</);
  assert.doesNotMatch(source, />检验机构盖章</);
  assert.match(source, /item\.photos/);
  assert.match(source, /bindtap="previewFaultPhoto"/);
  assert.match(source, /历史记录未提供此附件/);
});

test("故障特写使用专用端点与幂等上传键，固定附件接口保持独立", () => {
  const source = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  assert.match(source, /checkup-report\/faults\/\$\{encodeURIComponent\(faultId\)\}\/photos/);
  assert.match(source, /"Idempotency-Key": options\.idempotencyKey/);
  assert.match(source, /checkup-report\/media/);
});

test("车主报告图片使用页面内分组查看器而不是全屏系统预览", () => {
  const script = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxss", import.meta.url), "utf8");

  assert.doesNotMatch(script, /wx\.previewImage/, "车主报告不能再拉起系统全屏预览");
  assert.match(script, /this\.data\.sitePhotos\.map\(\(item\) => \(\{ url: item\.url, label: item\.label \}\)\)/, "固定现场照片应使用独立图片组");
  assert.match(script, /this\.data\.resultMaterials\.map\(\(item\) => \(\{ url: item\.url, label: item\.label \}\)\)/, "年检标应使用独立结果材料图片组");
  assert.match(script, /const fault = this\.data\.report\?\.faults\.find[\s\S]*faultPhotos\(fault\)[\s\S]*this\.openImageViewer\(items, current\)/, "故障特写只能使用当前故障图片组");
  assert.match(markup, /class="report-image-viewer-mask" bindtap="closeImageViewer"/);
  assert.match(markup, /aria-label="关闭图片查看器" bindtap="closeImageViewer"/);
  assert.match(markup, /mode="aspectFit" aria-label="\{\{viewerLabel\}\}"/);
  assert.match(markup, /bindtap="previousViewerImage"/);
  assert.match(markup, /bindtap="nextViewerImage"/);
  assert.match(markup, /catchtouchmove="blockViewerTouch"/);
  assert.match(style, /\.report-image-viewer \{ position: fixed/);
  assert.match(style, /env\(safe-area-inset-top\)/);
  assert.match(style, /env\(safe-area-inset-bottom\)/);
});

test("报告详情区分读取失败与尚未形成报告并提供恢复操作", () => {
  const script = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxss", import.meta.url), "utf8");
  assert.match(script, /loadError:\s*error instanceof Error/);
  assert.match(script, /retryLoad\(\)/);
  assert.match(markup, /暂时无法显示车辆体检报告/);
  assert.match(markup, /检测结果尚未形成车辆体检报告/);
  assert.match(markup, /当前展示的是上次成功同步的报告/);
  assert.match(style, /\.report-error-actions button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(style, /\.report-inline-error > button\s*\{[^}]*min-height:\s*88rpx/);
});

test("检测端三视图、结论与固定操作按钮在窄屏保持完整等分", () => {
  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  assert.deepEqual(checkupVehicleDiagram(null).views.map((view) => view.label), ["俯视", "左侧", "右侧"]);
  assert.match(style, /\.view-tabs\s*\{[^}]*display:\s*flex[^}]*box-sizing:\s*border-box/);
  assert.match(style, /\.view-tabs button\s*\{[^}]*width:\s*0[^}]*min-width:\s*0[^}]*flex:\s*1 1 0[^}]*box-sizing:\s*border-box/);
  assert.match(style, /\.conclusion-options\s*\{[^}]*display:\s*flex[^}]*box-sizing:\s*border-box/);
  assert.match(style, /\.conclusion-options button\s*\{[^}]*width:\s*0[^}]*min-width:\s*0[^}]*flex:\s*1 1 0[^}]*box-sizing:\s*border-box/);
  assert.match(style, /\.sticky-actions\s*\{[^}]*right:\s*24rpx[^}]*left:\s*24rpx[^}]*border-radius:\s*22rpx[^}]*box-sizing:\s*border-box/);
  assert.match(style, /\.sticky-actions button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/);
  assert.match(source, /status:\s*data\.conclusion === "failed" \|\| \(data\.conclusion === "passed" && Boolean\(data\.markMedia\)\)/);
  assert.match(markup, /\{\{markMedia \? '已上传' : \(conclusion === 'passed' \? '待上传' : '不适用'\)\}\}<\/text><text>合格凭证/);
  assert.doesNotMatch(markup, /\{\{safetyReportMedia \? '已上传' : '待上传'\}\}/);
});

test("车主报告把法定检测材料与平台车辆体检留证分组且关键触控区不少于88rpx", () => {
  const script = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxml", import.meta.url), "utf8");
  const editorStyle = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxss", import.meta.url), "utf8");
  const reportStyle = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxss", import.meta.url), "utf8");
  for (const field of ["sitePhotos", "resultMaterials", "sitePhotoAttachments", "resultMaterialAttachments"]) assert.match(script, new RegExp(`${field}:`));
  assert.match(markup, /\{\{sitePhotos\.length\}\}\/5/);
  assert.doesNotMatch(markup, /\{\{photos\.length\}\}/);
  assert.match(markup, /平台车辆体检报告不替代法定检测报告/);
  assert.match(markup, /历史报告未采集法定检测材料，不补造附件/);
  assert.match(markup, /仅年检通过时必传/);
  assert.match(markup, /class="mark-summary"/);
  for (const selector of ["view-tabs button", "failure-category-options button", "fault-closeup-actions button"]) {
    assert.match(editorStyle, new RegExp(`\\.${selector.replace(" ", "\\s+")}\\s*\\{[^}]*min-height:\\s*88rpx`));
  }
  assert.match(editorStyle, /\.preview-actions button\s*\{[^}]*min-height:\s*96rpx/);
  assert.match(reportStyle, /\.report-image-viewer-head > button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(reportStyle, /\.report-image-viewer-controls > button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(reportStyle, /\.report-image-viewer-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(80rpx,\s*120rpx\)\s+minmax\(0,\s*1fr\)[^}]*box-sizing:\s*border-box/);
  assert.match(reportStyle, /\.report-image-viewer-controls > button\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/);
  assert.match(reportStyle, /\.summary-grid \.mark-summary text:first-child\s*\{[^}]*white-space:\s*normal/);
});

test("订单详情同时概览法定检测材料与平台车辆体检留证且诚实提示历史缺失", () => {
  const script = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxml", import.meta.url), "utf8");
  assert.match(script, /reportMedia\(report, "safety_inspection_report"\)/);
  assert.match(script, /安全检验报告选填 · 未提供/);
  assert.match(script, /排放报告选填 · 未提供/);
  assert.match(script, /missing:\s*passed && !mark/);
  assert.match(markup, /法定检测材料/);
  assert.match(markup, /平台车辆体检留证/);
  assert.match(markup, /平台车辆体检报告不替代法定检测报告/);
});

test("检测编辑与车主报告共用车主车型与定位证据说明", () => {
  const editorScript = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.ts", import.meta.url), "utf8");
  const ownerScript = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.ts", import.meta.url), "utf8");
  const editorTemplate = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-editor/checkup-editor.wxml", import.meta.url), "utf8");
  const ownerTemplate = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-report/checkup-report.wxml", import.meta.url), "utf8");
  assert.match(editorScript, /checkupVehicleDiagram\(booking\.vehicle\)/);
  assert.match(ownerScript, /checkupVehicleDiagram\(currentBooking\?\.vehicle\)/);
  for (const template of [editorTemplate, ownerTemplate]) {
    assert.match(template, /\{\{diagramVehicleText\}\}/);
    assert.match(template, /\{\{diagramSourceText\}\}/);
    assert.match(template, /故障定位以标注部位和现场照片为准/);
  }
  assert.match(ownerTemplate, /region-callout-line[\s\S]*region-callout-label/u);
  assert.match(ownerTemplate, /点击红色定位或部位名称查看问题/u);
});

function reportSummary(overrides: Partial<VehicleCheckupReportSummary> = {}): VehicleCheckupReportSummary {
  return {
    bookingId: "booking-1",
    bookingNumber: "YXM202608240001",
    bookingStatus: "completed",
    fulfillmentStatus: "completed",
    appointmentDate: "2026-08-24",
    startTime: "09:00",
    endTime: "10:00",
    reportId: "report-1",
    reportNo: "YXM-CHK-20260824-0001",
    reportStatus: "published",
    schemaVersion: "vehicle-checkup-v2",
    publishedAt: "2026-08-24T04:00:00.000Z",
    retainUntil: "2032-08-24T04:00:00.000Z",
    vehicle: { id: "vehicle-1", plateNumber: "津A·V826Q", vehicleType: "小型轿车", brandName: "银河", modelName: "E8", displayName: "银河 E8" },
    station: { id: "station-1", name: "河西机动车检测站", district: "河西区", address: "天津市河西区测试路 1 号" },
    serviceMode: "self_drive",
    conclusion: "passed",
    observationMode: "faults_recorded",
    faultCount: 2,
    sitePhotoCount: 5,
    faultPhotoCount: 4,
    photoCount: 10,
    markStatus: "issued",
    hasAnnualMark: true,
    hasSafetyInspectionReport: true,
    hasEmissionsInspectionReport: false,
    legalMaterialsStatus: "available",
    ...overrides,
  };
}

function reportProgress(overrides: Partial<VehicleCheckupReportProgress> = {}): VehicleCheckupReportProgress {
  return {
    bookingId: "booking-progress",
    bookingNumber: "YXM202608240002",
    bookingStatus: "inspecting",
    fulfillmentStatus: "inspecting",
    paymentStatus: "paid",
    appointmentDate: "2026-08-24",
    startTime: "10:00",
    endTime: "11:00",
    vehicle: { id: "vehicle-2", plateNumber: "津B·T5208", vehicleType: "小型轿车", brandName: "测试", modelName: "MPV", displayName: "测试 MPV" },
    station: { id: "station-1", name: "河西机动车检测站", district: "河西区", address: "天津市河西区测试路 1 号" },
    serviceMode: "valet",
    progressType: "booking_in_progress",
    conclusion: null,
    resultReceivedAt: null,
    reportReady: false,
    updatedAt: "2026-08-24T03:30:00.000Z",
    ...overrides,
  };
}

test("报告中心规范化服务端 envelope 元数据并稳定按发布时间倒序", () => {
  const raw: VehicleCheckupReportListData = {
    progress: [reportProgress()],
    items: [
      reportSummary({ reportId: "older", publishedAt: "2026-08-23T04:00:00.000Z" }),
      reportSummary({ reportId: "newer", publishedAt: "2026-08-24T04:00:00.000Z", faultCount: -3, sitePhotoCount: 8 }),
    ],
  };
  const page = normalizeVehicleCheckupReportList(raw, { limit: 10, nextCursor: "opaque-cursor" });
  assert.equal(page.limit, 10);
  assert.equal(page.nextCursor, "opaque-cursor");
  assert.deepEqual(page.items.map((item) => item.reportId), ["newer", "older"]);
  assert.equal(page.items[0].faultCount, 0);
  assert.equal(page.items[0].sitePhotoCount, 8, "服务端原始计数保留，展示层再按 5 张基准照封顶");
  assert.equal(page.progress[0].vehicle.plateNumber, "津B·T5208");
});

test("报告中心区分报告待回传、履约继续和结果后缺报告三种状态", () => {
  const active = progressCard(reportProgress());
  const ready = progressCard(reportProgress({ reportReady: true, fulfillmentStatus: "returning", conclusion: "passed" }));
  const missing = progressCard(reportProgress({ progressType: "result_pending_report", fulfillmentStatus: "result_received", conclusion: "failed", resultReceivedAt: "2026-08-24T04:10:00.000Z" }));
  assert.equal(active.kind, "active");
  assert.match(active.badgeText, /报告待回传/);
  assert.equal(ready.kind, "report-ready");
  assert.match(ready.badgeText, /履约继续/);
  assert.equal(missing.kind, "report-missing");
  assert.match(missing.title, /未形成结构化车辆体检报告/);
});

test("报告卡完整展示固定照片、故障证据和历史 v1 诚实提示", () => {
  const current = reportCard(reportSummary());
  assert.equal(current.fixedPhotoText, "5/5");
  assert.equal(current.faultText, "2 项");
  assert.equal(current.faultPhotoText, "4 张");
  assert.equal(current.markText, "检验合格标志/电子凭证留证已附");
  assert.equal(current.legalMaterialText, "安全检验报告已附");
  assert.match(current.ariaLabel, /河西机动车检测站/);
  assert.match(current.ariaLabel, /车主自驾到站/);
  assert.match(current.ariaLabel, /平台车辆体检留证5\/5/);
  assert.match(current.ariaLabel, /4张故障特写/);
  assert.match(current.ariaLabel, /检验合格标志\/电子凭证留证已附/);
  assert.equal(current.isLegacyV1, false);
  const legacy = reportCard(reportSummary({ schemaVersion: "vehicle-checkup-v1", sitePhotoCount: 0, faultPhotoCount: 0, hasAnnualMark: false, hasSafetyInspectionReport: false, legalMaterialsStatus: "legacy_missing" }));
  assert.equal(legacy.isLegacyV1, true);
  assert.equal(legacy.fixedPhotoText, "0/5");
  assert.equal(legacy.markText, "历史报告未提供检验合格凭证留证");
  assert.equal(legacy.legalMaterialText, "历史报告未采集法定检测材料");
  assert.equal(reportCard(reportSummary({ conclusion: "failed", hasAnnualMark: false })).markText, "未通过，不形成检验合格凭证留证");
  const historical = reportCard(reportSummary({ conclusion: null, conclusionStatus: "legacy_requires_reentry", hasAnnualMark: false }));
  assert.equal(historical.conclusionText, "历史结果待重新录入");
  assert.equal(historical.conclusionTone, "pending");
  assert.equal(historical.markText, "旧结论已停用，年检结果待重新录入");
});

test("车辆筛选默认全部且去重，多辆车不会自动跳转最新报告", () => {
  const filters = vehicleFilters([
    { id: "vehicle-1", plateNumber: "津A·V826Q", displayName: "银河 E8" },
    { id: "vehicle-1", plateNumber: "津A·V826Q", displayName: "银河 E8" },
    { id: "vehicle-2", plateNumber: "津B·T5208", displayName: "测试 MPV" },
  ], "");
  assert.deepEqual(filters.map((item) => item.id), ["", "vehicle-1", "vehicle-2"]);
  assert.equal(filters[0].selected, true);

  const source = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-reports/checkup-reports.ts", import.meta.url), "utf8");
  assert.match(source, /activeVehicleId:\s*""/);
  assert.match(source, /onReachBottom\(\)/);
  assert.match(source, /cursor:\s*reset \? undefined : this\.data\.nextCursor/);
  assert.doesNotMatch(source, /onShow\s*\(/, "从报告详情返回时应保留列表实例与筛选/游标状态");
  assert.match(source, /onLoad\(\)\s*\{[\s\S]*loadVehicles\(\)[\s\S]*loadReports\(true\)[\s\S]*\}/);
  assert.match(source, /packages\/inspection\/pages\/checkup-report\/checkup-report\?id=/);
  assert.match(source, /packages\/annual\/pages\/order-detail\/order-detail\?id=/);
});

test("报告中心路由、列表接口、异常提示和无障碍入口完整", () => {
  const manifest = readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-reports/checkup-reports.wxml", import.meta.url), "utf8");
  const modelSource = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-reports/checkup-reports.model.ts", import.meta.url), "utf8");
  const pageSource = readFileSync(new URL("../miniprogram/packages/inspection/pages/checkup-reports/checkup-reports.ts", import.meta.url), "utf8");
  assert.match(manifest, /pages\/checkup-reports\/checkup-reports/);
  assert.match(apiSource, /requestEnvelope<VehicleCheckupReportListData>\(`\/vehicle-checkup-reports/);
  assert.match(apiSource, /nextCursor:\s*typeof meta\.nextCursor/);
  for (const text of ["检测报告中心", "履约关注", "已生成报告", "平台体检留证", "故障特写", "历史版报告", "重新加载", "加载更多报告"]) {
    assert.match(markup, new RegExp(text));
  }
  for (const text of ["报告待回传", "报告已生成 · 履约继续", "未形成结构化车辆体检报告", "材料闭环不完整"]) {
    assert.match(`${modelSource}\n${markup}`, new RegExp(text));
  }
  assert.match(markup, /aria-label="按车辆筛选报告"/);
  assert.match(markup, /aria-label="\{\{item\.ariaLabel\}\}"/);
  assert.match(markup, /bindtap="selectVehicle" disabled="\{\{loading \|\| loadingMore\}\}"/);
  assert.match(markup, /bindtap="retry" loading="\{\{loading\}\}" disabled="\{\{loading\}\}"/);
  assert.match(markup, /bindtap="retryLoadMore" loading="\{\{loadingMore\}\}" disabled="\{\{loadingMore \|\| loading\}\}"/);
  assert.match(pageSource, /if \(this\.data\.loading \|\| this\.data\.loadingMore\) return/);
  assert.match(pageSource, /loaded:\s*hasExistingContent,\s*isEmpty:\s*false/, "无现有内容时重试应恢复骨架屏，而不是短暂白屏");
  assert.match(markup, /平台留存的车辆体检记录，不替代检测机构出具的官方检验报告/);
});
