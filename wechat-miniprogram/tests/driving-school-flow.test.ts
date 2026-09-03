import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeDrivingSchoolDetail,
  normalizeDrivingSchoolOffer,
  normalizeDrivingSchoolTrainingClass,
} from "../miniprogram/services/api";
import {
  FALLBACK_DRIVING_SCHOOL_META,
  classesForMode,
  localDrivingSchoolCover,
  normalizeDrivingSchoolListEntryOptions,
  quickClasses,
  resolveDrivingSchoolCover,
} from "../miniprogram/packages/driving-school/utils";

const base = join(import.meta.dirname, "..");

test("准驾车型按交管分组且初次申领与增驾快捷项不同", () => {
  assert.deepEqual(FALLBACK_DRIVING_SCHOOL_META.licenseClassGroups.map((group) => group.id), ["ab", "c", "def", "mnp"]);
  const initialCodes = classesForMode(FALLBACK_DRIVING_SCHOOL_META, "initial").flatMap((group) => group.items.map((item) => item.code));
  const upgradeCodes = classesForMode(FALLBACK_DRIVING_SCHOOL_META, "upgrade").flatMap((group) => group.items.map((item) => item.code));
  assert.equal(initialCodes.includes("C6"), false);
  assert.equal(upgradeCodes.includes("C6"), true);
  assert.notDeepEqual(quickClasses(FALLBACK_DRIVING_SCHOOL_META, "initial").map((item) => item.code), quickClasses(FALLBACK_DRIVING_SCHOOL_META, "upgrade").map((item) => item.code));
});

test("驾校列表直达参数校验搜索词、准驾车型与申领方式后再初始化筛选", () => {
  assert.deepEqual(normalizeDrivingSchoolListEntryOptions(FALLBACK_DRIVING_SCHOOL_META, {
    q: "  天津示例驾校  ", licenseClassCode: "c6", applicationMode: "upgrade",
  }), { q: "天津示例驾校", licenseClassCode: "C6", applicationMode: "upgrade" });
  assert.deepEqual(normalizeDrivingSchoolListEntryOptions(FALLBACK_DRIVING_SCHOOL_META, {
    q: "示例", licenseClassCode: "C6", applicationMode: "initial",
  }), { q: "示例", licenseClassCode: "", applicationMode: "initial" });
  assert.deepEqual(normalizeDrivingSchoolListEntryOptions(FALLBACK_DRIVING_SCHOOL_META, {
    licenseClassCode: "NOT-A-CLASS", applicationMode: "unexpected",
  }), { q: "", licenseClassCode: "", applicationMode: "initial" });
  const list = readFileSync(join(base, "miniprogram/packages/driving-school/pages/list/list.ts"), "utf8");
  assert.ok(list.includes("onLoad(options)"));
  assert.ok(list.includes("options.licenseClassCode"));
  assert.ok(list.includes("await this.load(true)"));
});

test("筛选枚举严格使用服务端合同值且能力等级不是质量评价", () => {
  assert.deepEqual(FALLBACK_DRIVING_SCHOOL_META.regulatoryTypes.map((item) => item.value), ["filing", "legacy_license"]);
  assert.deepEqual(FALLBACK_DRIVING_SCHOOL_META.priceTypes.map((item) => item.value), ["fixed", "starting_from", "range", "inquiry"]);
  assert.deepEqual(FALLBACK_DRIVING_SCHOOL_META.capabilityLevels.map((item) => item.value), ["level_1", "level_2", "level_3"]);
  assert.match(FALLBACK_DRIVING_SCHOOL_META.trainingCapabilityNotice, /不代表教学质量/);
});

test("演示学校与失效网络图片有分包内栅格封面回退", () => {
  const motorcycle = [{ licenseClassCode: "D" }];
  assert.equal(localDrivingSchoolCover(motorcycle), "/packages/driving-school/assets/motorcycle.jpg");
  assert.equal(resolveDrivingSchoolCover({ coverImage: "https://example.test/cover.jpg", isDemo: true, trainingClasses: motorcycle }), "/packages/driving-school/assets/motorcycle.jpg");
  assert.equal(resolveDrivingSchoolCover({ coverImage: "/seed/large-vehicle.webp", trainingClasses: [] }), "/packages/driving-school/assets/large-vehicle.jpg");
});

test("驾校详情归一化保留图库说明并按封面与顺序输出对象", () => {
  const detail = normalizeDrivingSchoolDetail({
    id: "school-1",
    name: "测试驾校",
    coverImage: { id: "cover", url: "/media/cover.webp", caption: "综合训练场", altText: "训练场全景", isCover: true, sortOrder: 8 },
    images: [
      { id: "yard", url: "/media/yard.webp", caption: "科目二训练区", altText: "科目二场地", isCover: false, sortOrder: 2 },
      { id: "cover", url: "/media/cover.webp", caption: "综合训练场", altText: "训练场全景", isCover: true, sortOrder: 8 },
    ],
    trainingClasses: [],
    offers: [],
    regulatory: {},
  });
  assert.equal(detail.images.length, 2);
  assert.deepEqual(detail.images.map((image) => image.id), ["cover", "yard"]);
  assert.equal(detail.images[0].caption, "综合训练场");
  assert.equal(detail.images[0].altText, "训练场全景");
  assert.equal(detail.images[0].isCover, true);
  assert.equal(detail.images[1].sortOrder, 2);
});

test("车型条件合并目录、学校补充与兼容派生值，车型说明不再解释为等级", () => {
  const trainingClass = normalizeDrivingSchoolTrainingClass({
    licenseClassCode: "c1",
    name: "小型汽车",
    supportedModes: ["initial", "upgrade"],
    trainingCapabilityLevel: "level_1",
    trainingCapabilityNote: "设有独立 C1 训练场",
    catalogConditions: ["年满 18 周岁", "身体条件符合要求"],
    schoolConditions: ["须完成入学体检", "年满 18 周岁"],
    conditions: ["携带身份证明"],
  });
  assert.deepEqual(trainingClass.catalogConditions, ["年满 18 周岁", "身体条件符合要求"]);
  assert.deepEqual(trainingClass.schoolConditions, ["须完成入学体检", "年满 18 周岁"]);
  assert.deepEqual(trainingClass.conditions, ["年满 18 周岁", "身体条件符合要求", "须完成入学体检", "携带身份证明"]);
  assert.equal(trainingClass.trainingCapabilityNote, "设有独立 C1 训练场");
});

test("报价只消费服务端 active 状态且忽略兼容有效期字段", () => {
  const active = normalizeDrivingSchoolOffer({
    id: "offer-active",
    status: "active",
    validFrom: "2099-01-01",
    validUntil: "2099-12-31",
    isExpired: true,
  }) as unknown as Record<string, unknown>;
  const inactive = normalizeDrivingSchoolOffer({ id: "offer-inactive", status: "inactive", isActive: true });
  assert.equal(active.status, "active");
  assert.equal(Object.hasOwn(active, "validFrom"), false);
  assert.equal(Object.hasOwn(active, "validUntil"), false);
  assert.equal(Object.hasOwn(active, "isExpired"), false);
  assert.equal(inactive.status, "inactive");
});

test("详情与列表明确展示营业时间、图库说明和机构级备案能力，报价无有效期判断", () => {
  const detailTs = readFileSync(join(base, "miniprogram/packages/driving-school/pages/detail/detail.ts"), "utf8");
  const detailWxml = readFileSync(join(base, "miniprogram/packages/driving-school/pages/detail/detail.wxml"), "utf8");
  const listWxml = readFileSync(join(base, "miniprogram/packages/driving-school/pages/list/list.wxml"), "utf8");
  const inquiryTs = readFileSync(join(base, "miniprogram/packages/driving-school/pages/inquiry/inquiry.ts"), "utf8");
  assert.ok(detailWxml.includes("<swiper"));
  assert.ok(detailWxml.includes("currentGalleryCaption"));
  assert.ok(detailWxml.includes("营业时间"));
  assert.ok(listWxml.includes("营业时间：{{item.openHours"));
  assert.equal((detailWxml.match(/>\{\{school\.regulatoryCapabilityText\}\}；/gu) || []).length, 1);
  assert.match(detailWxml, /非质量评级/);
  assert.match(detailWxml, /不代表教学质量、通过率、星级或推荐排名/);
  assert.equal(detailWxml.includes("trainingCapabilityLevel"), false);
  assert.ok(detailTs.includes("item.trainingCapabilityNote"));
  assert.ok(detailTs.includes('offer.status === "active"'));
  assert.ok(inquiryTs.includes('item.status === "active"'));
  for (const legacyOfferField of ["isExpired", "validityText", "item.validFrom", "item.validUntil"]) {
    assert.equal(detailWxml.includes(legacyOfferField), false);
    assert.equal(detailTs.includes(legacyOfferField), false);
  }
});

test("小程序只消费锁定的驾校与咨询公开路径", () => {
  const api = readFileSync(join(base, "miniprogram/services/api.ts"), "utf8");
  for (const endpoint of [
    "/driving-schools/meta",
    "/driving-schools/${encodeURIComponent(id)}",
    "/driving-school-inquiries/disclosure?schoolId=",
    '"/driving-school-inquiries", "POST"',
    "/driving-school-inquiries/${encodeURIComponent(withdrawToken)}/withdraw",
    '"Idempotency-Key": idempotencyKey',
  ]) assert.ok(api.includes(endpoint), `missing ${endpoint}`);
  assert.equal(api.includes("/driving-school/inquiries"), false);
});

test("快速切换筛选不会让旧分页覆盖新结果，演示咨询锁定真实资料输入", () => {
  const list = readFileSync(join(base, "miniprogram/packages/driving-school/pages/list/list.ts"), "utf8");
  assert.ok(list.includes("const requestSequence = ++this.requestSequence"));
  assert.ok(list.includes("if (requestSequence !== this.requestSequence) return"));
  assert.ok(list.includes("const previousItems = reset ? [] : this.data.items"));
  const inquiry = readFileSync(join(base, "miniprogram/packages/driving-school/pages/inquiry/inquiry.wxml"), "utf8");
  assert.ok((inquiry.match(/disabled="\{\{!disclosure\.acceptsRealData\}\}"/gu) || []).length >= 3);
});

test("驾校筛选先提交最新状态再请求，常用车型完整展示且选中结果可见", () => {
  const listTs = readFileSync(join(base, "miniprogram/packages/driving-school/pages/list/list.ts"), "utf8");
  const listWxml = readFileSync(join(base, "miniprogram/packages/driving-school/pages/list/list.wxml"), "utf8");
  const listWxss = readFileSync(join(base, "miniprogram/packages/driving-school/pages/list/list.wxss"), "utf8");
  assert.match(listTs, /applyFilters\(patch: Partial<Data>\)[\s\S]*?this\.setData\(patch, \(\) => \{[\s\S]*?this\.load\(true\)/u);
  for (const handler of ["submitSearch", "chooseMode", "chooseQuickClass", "chooseClass", "districtChange", "regulatoryChange", "clearFilters"]) {
    assert.match(listTs, new RegExp(`${handler}\\([^)]*\\)[\\s\\S]*?this\\.applyFilters\\(`, "u"), `${handler} must reload after its filter state is committed`);
  }
  for (const queryKey of ["trainingMode: this.data.applicationMode", "licenseClassCode: this.data.licenseClassCode", "district: this.data.district", "regulatoryType: this.data.regulatoryType", "priceType: this.data.priceType"]) {
    assert.ok(listTs.includes(queryKey), `missing list query field: ${queryKey}`);
  }
  assert.ok(listWxml.includes('class="quick-grid"'));
  assert.ok(listWxml.includes('class="filter-feedback"'));
  assert.ok(listWxml.includes("{{total}} 家匹配"));
  assert.equal(listWxml.includes('class="quick-scroll"'), false);
  assert.match(listWxss, /\.quick-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,minmax\(0,1fr\)\)/u);
});

test("驾校分包和首页入口已注册", () => {
  const app = JSON.parse(readFileSync(join(base, "miniprogram/app.json"), "utf8")) as { subPackages: Array<{ root: string; pages: string[] }> };
  const schoolPackage = app.subPackages.find((item) => item.root === "packages/driving-school");
  assert.deepEqual(schoolPackage?.pages, ["pages/list/list", "pages/detail/detail", "pages/inquiry/inquiry", "pages/receipt/receipt"]);
  const home = readFileSync(join(base, "miniprogram/pages/home/home.wxml"), "utf8");
  assert.ok(home.includes("驾校服务"));
  assert.ok(home.includes("按准驾车型筛选 · 价格可查"));
  assert.equal((home.match(/class="service-item/gu) || []).length, 9);
});
