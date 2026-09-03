import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  SubsidyAdministrativeFees,
  SubsidyFeePlan,
  SubsidyFeeTier,
  SubsidyMaterial,
  SubsidyMaterialKind,
} from "../miniprogram/types";
import {
  normalizeSubsidyConfig,
  normalizeSubsidyQuote,
  normalizeSubsidyReceipt,
} from "../miniprogram/services/api";
import { normalizeSubsidyDemoContact } from "../miniprogram/utils/subsidy-consultation-config";
import {
  allSubsidyMaterialsReady,
  decorateSubsidyTiers,
  defaultMaterialDefinitions,
  findSubsidyTier,
  formatSubsidyFeeBreakdown,
  parseDeclaredValueWan,
  reconcileSubsidyUploads,
  subsidyMaterialInputMode,
  updateSubsidyUpload,
} from "../miniprogram/packages/subsidy/utils/consultation";

const administrativeFees: SubsidyAdministrativeFees = {
  plateFeeFen: 12_000,
  mailingFeeFen: 2_000,
  productionFeeFen: 1_000,
};

const tiers: SubsidyFeeTier[] = [
  { id: "tier-20", label: "20万档", minValueFen: 0, maxValueFen: 20_000_000, feeFen: 15_000, totalTransferCostFen: 30_000, sortOrder: 1 },
  { id: "tier-30", label: "30万档", minValueFen: 20_000_000, maxValueFen: 30_000_000, feeFen: 25_000, totalTransferCostFen: 40_000, sortOrder: 2 },
  { id: "tier-40", label: "40万档", minValueFen: 30_000_000, maxValueFen: 40_000_000, feeFen: 35_000, totalTransferCostFen: 50_000, sortOrder: 3 },
  { id: "tier-50", label: "50万档", minValueFen: 40_000_000, maxValueFen: 50_000_000, feeFen: 45_000, totalTransferCostFen: 60_000, sortOrder: 4 },
];

const feePlan: SubsidyFeePlan = {
  version: "4",
  active: true,
  administrativeFees,
  administrativeFeeFen: 15_000,
  tiers,
};

function material(kind: SubsidyMaterialKind, id: string): SubsidyMaterial {
  return {
    id,
    kind,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    status: "staged",
    expiresAt: "2026-08-23T00:00:00.000Z",
  };
}

test("车辆估值按下开上闭边界命中后台四档价格", () => {
  assert.equal(findSubsidyTier(tiers, 1)?.id, "tier-20");
  assert.equal(findSubsidyTier(tiers, 20_000_000)?.id, "tier-20");
  assert.equal(findSubsidyTier(tiers, 20_100_000)?.id, "tier-30");
  assert.equal(findSubsidyTier(tiers, 50_000_000)?.id, "tier-50");
  assert.equal(findSubsidyTier(tiers, 0), null);
  assert.equal(findSubsidyTier(tiers, 50_100_000), null);
});

test("万元输入只接受一位小数且硬限制不超过50万元", () => {
  assert.equal(parseDeclaredValueWan("20"), 20_000_000);
  assert.equal(parseDeclaredValueWan("20.5"), 20_500_000);
  assert.equal(parseDeclaredValueWan("50.0"), 50_000_000);
  assert.equal(parseDeclaredValueWan("0"), null);
  assert.equal(parseDeclaredValueWan("20.55"), null);
  assert.equal(parseDeclaredValueWan("50.1"), null);
  assert.equal(parseDeclaredValueWan("abc"), null);
});

test("始终展示完整阶梯且只高亮当前命中档位", () => {
  const display = decorateSubsidyTiers({ ...feePlan, tiers: [...tiers].reverse() }, 30_000_000);
  assert.equal(display.length, 4);
  assert.deepEqual(display.map((item) => item.id), ["tier-20", "tier-30", "tier-40", "tier-50"]);
  assert.deepEqual(display.filter((item) => item.selected).map((item) => item.id), ["tier-30"]);
  assert.equal(display[1].rangeText, "20–30万元");
  assert.equal(display[1].consultationFeeText, "¥250");
  assert.equal(display[1].plateFeeText, "¥120");
  assert.equal(display[1].mailingFeeText, "¥20");
  assert.equal(display[1].productionFeeText, "¥10");
  assert.equal(display[1].administrativeFeeText, "¥150");
  assert.equal(display[1].totalTransferCostText, "¥400");
  assert.deepEqual(display.map((item) => item.totalTransferCostText), ["¥300", "¥400", "¥500", "¥600"]);
});

test("服务端费用 DTO 冻结行政三项、小计和过户费用参考合计", () => {
  const config = normalizeSubsidyConfig({
    mode: "demo",
    acceptsRealData: false,
    feePlan,
    disclosure: { version: "disclosure-v1" },
    materialKinds: [],
  });
  assert.deepEqual(config.feePlan.administrativeFees, administrativeFees);
  assert.equal(config.feePlan.administrativeFeeFen, 15_000);
  assert.deepEqual(config.feePlan.tiers.map((tier) => tier.totalTransferCostFen), [30_000, 40_000, 50_000, 60_000]);

  const quote = normalizeSubsidyQuote({
    quote: {
      id: "quote-1",
      vehicleId: "vehicle-1",
      declaredValueFen: 20_000_000,
      matchedTier: tiers[0],
      consultationFeeFen: 15_000,
      administrativeFees,
      administrativeFeeFen: 15_000,
      totalTransferCostFen: 30_000,
      planVersion: "4",
      createdAt: "2026-08-27T00:00:00.000Z",
      expiresAt: "2026-08-27T00:10:00.000Z",
    },
  });
  assert.deepEqual(formatSubsidyFeeBreakdown(quote), {
    consultationFeeText: "¥150",
    plateFeeText: "¥120",
    mailingFeeText: "¥20",
    productionFeeText: "¥10",
    administrativeFeeText: "¥150",
    totalTransferCostText: "¥300",
  });

  const receipt = normalizeSubsidyReceipt({
    receipt: {
      id: "consultation-1",
      consultationCode: "YXM-ZX-1",
      status: "new",
      vehicle: { plateNumber: "津A·演示", modelName: "演示车辆" },
      declaredValueFen: 20_000_000,
      matchedTier: tiers[0],
      consultationFeeFen: 15_000,
      administrativeFees,
      administrativeFeeFen: 15_000,
      totalTransferCostFen: 30_000,
      planVersion: "4",
      submittedAt: "2026-08-27T00:00:00.000Z",
    },
  });
  assert.equal(receipt.totalTransferCostFen, 30_000);
  assert.equal(receipt.administrativeFees.plateFeeFen, 12_000);
});

test("费用 DTO 缺项、非整数或加总不一致时拒绝展示", () => {
  assert.throws(() => normalizeSubsidyConfig({
    mode: "demo",
    feePlan: { ...feePlan, administrativeFees: { ...administrativeFees, plateFeeFen: "12000" } },
    disclosure: { version: "disclosure-v1" },
  }), /牌照费无效/u);

  assert.throws(() => normalizeSubsidyQuote({
    quote: {
      id: "quote-invalid",
      vehicleId: "vehicle-1",
      declaredValueFen: 20_000_000,
      matchedTier: tiers[0],
      consultationFeeFen: 15_000,
      administrativeFees,
      administrativeFeeFen: 15_000,
      totalTransferCostFen: 29_999,
      planVersion: "4",
      expiresAt: "2026-08-27T00:10:00.000Z",
    },
  }), /费用明细不一致/u);
});

test("阶梯、报价、底部栏与回执均展示冻结费用拆分且提交体不传价格", () => {
  const formTemplate = readFileSync(new URL("../miniprogram/packages/subsidy/pages/form/form.wxml", import.meta.url), "utf8");
  const receiptTemplate = readFileSync(new URL("../miniprogram/packages/subsidy/pages/receipt/receipt.wxml", import.meta.url), "utf8");
  for (const label of ["咨询服务费", "牌照费（参考）", "邮寄费（参考）", "制作工本费（参考）", "行政收费参考小计", "过户费用合计（参考）"]) {
    assert.match(formTemplate, new RegExp(label, "u"));
    assert.match(receiptTemplate, new RegExp(label, "u"));
  }
  assert.match(formTemplate, /实际费用以办理机构及所选服务为准/u);
  assert.match(receiptTemplate, /实际费用以办理机构及所选服务为准/u);

  const source = readFileSync(new URL("../miniprogram/packages/subsidy/pages/form/form.ts", import.meta.url), "utf8");
  const submitStart = source.indexOf("api.createSubsidyConsultation({");
  const submitEnd = source.indexOf("}, this.submitKey)", submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  const submittedPayload = source.slice(submitStart, submitEnd);
  assert.doesNotMatch(submittedPayload, /consultationFeeFen|administrativeFees|administrativeFeeFen|totalTransferCostFen/u);
});

test("九项资料按任意顺序上传时累计保留所有成功槽位", () => {
  const completionOrder = [...defaultMaterialDefinitions].reverse().map((item) => item.kind);
  let uploads = reconcileSubsidyUploads();
  for (const [index, kind] of completionOrder.entries()) {
    uploads = updateSubsidyUpload(uploads, kind, {
      localPath: `/tmp/${kind}.jpg`,
      fileSize: 1024,
      material: material(kind, `material-${index}`),
      uploading: false,
      error: "",
    });
    uploads = reconcileSubsidyUploads(defaultMaterialDefinitions, uploads);
  }
  assert.equal(uploads.length, 9);
  assert.equal(new Set(uploads.map((item) => item.material?.id)).size, 9);
  assert.equal(allSubsidyMaterialsReady(uploads), true);
});

test("重选或移除只改变当前资料槽位", () => {
  let uploads = reconcileSubsidyUploads();
  uploads = updateSubsidyUpload(uploads, "id_card_front", {
    localPath: "/tmp/id-front.jpg",
    material: material("id_card_front", "id-front-1"),
  });
  uploads = updateSubsidyUpload(uploads, "driving_license_front", {
    localPath: "/tmp/license-front.jpg",
    material: material("driving_license_front", "license-front-1"),
  });
  uploads = updateSubsidyUpload(uploads, "id_card_front", {
    localPath: "/tmp/id-front-new.jpg",
    material: material("id_card_front", "id-front-2"),
  });

  assert.equal(uploads.find((item) => item.kind === "id_card_front")?.material?.id, "id-front-2");
  assert.equal(uploads.find((item) => item.kind === "driving_license_front")?.material?.id, "license-front-1");

  uploads = updateSubsidyUpload(uploads, "id_card_front", { localPath: "", fileSize: 0, material: null });
  assert.equal(uploads.find((item) => item.kind === "id_card_front")?.material, null);
  assert.equal(uploads.find((item) => item.kind === "driving_license_front")?.material?.id, "license-front-1");
});

test("演示模式强制使用服务端合成资料且不会进入相机相册分支", () => {
  assert.equal(subsidyMaterialInputMode(false, "multipart"), "server_generated_demo");
  assert.equal(subsidyMaterialInputMode(false, "server_generated_demo"), "server_generated_demo");
  assert.equal(subsidyMaterialInputMode(true, "multipart"), "multipart");

  const source = readFileSync(new URL("../miniprogram/packages/subsidy/pages/form/form.ts", import.meta.url), "utf8");
  const handlerStart = source.indexOf("chooseMaterial(event)");
  const demoBranch = source.indexOf("void this.useDemoMaterial(kind);", handlerStart);
  const pickerBranch = source.indexOf("wx.chooseMedia({", handlerStart);
  assert.ok(handlerStart >= 0 && demoBranch > handlerStart && pickerBranch > demoBranch);
  assert.match(source.slice(demoBranch, pickerBranch), /return;/u);
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  assert.match(apiSource, /createDemoSubsidyConsultationMaterial:[\s\S]*\/subsidy-consultation\/demo-materials/u);
});

test("演示联系人只在 demo 配置合法时读取并在表单中锁定", () => {
  assert.deepEqual(normalizeSubsidyDemoContact("demo", { name: " 演示车主 ", phone: "13800138000" }), {
    name: "演示车主",
    phone: "13800138000",
  });
  assert.equal(normalizeSubsidyDemoContact("real", { name: "演示车主", phone: "13800138000" }), null);
  assert.equal(normalizeSubsidyDemoContact("demo", { name: "演示车主", phone: "123" }), null);

  const source = readFileSync(new URL("../miniprogram/packages/subsidy/pages/form/form.ts", import.meta.url), "utf8");
  assert.match(source, /if \(this\.data\.config\?\.demoContact\) return;/u);
  assert.match(source, /contactName = config\.demoContact\?\.name/u);
  const template = readFileSync(new URL("../miniprogram/packages/subsidy/pages/form/form.wxml", import.meta.url), "utf8");
  assert.match(template, /disabled="\{\{config && config\.demoContact\}\}"/u);
  assert.match(template, /合成演示联系人/u);
});
