import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { WashPackage, WashStore } from "../miniprogram/types";
import { normalizeWashStore, washStoreImageUrl } from "../miniprogram/services/api";
import { apiOrigin } from "../miniprogram/config/env";
import {
  WASH_STORE_FALLBACK_COVER,
  buildWashStoreCard,
  washStoreFallbackCover,
  washAvailabilityDates,
  washEarliestSlotLabel,
  washStoreDistance,
} from "../miniprogram/packages/wash/utils/wash-store-picker";

const store: WashStore = {
  id: "wash-store-demo",
  name: "海河精洗中心（演示）",
  district: "河西区",
  address: "天津市河西区演示路 18 号",
  distanceKm: 3.26,
  distanceSource: "estimated",
  distanceBasis: "estimated_distance",
  phone: "022-88886666",
  openHours: "08:00–20:00",
  description: "演示门店介绍",
  tags: ["可代驾", "休息区", "新能源友好", "超长标签"],
  facilities: ["休息区", "卫生间", "免费饮水", "充电位", "第五项"],
  startingPriceFen: 3800,
  isOpen: true,
  isActive: true,
  dataKind: "demo",
};

function offer(id: string, name: string, priceFen: number): WashPackage {
  return { id, storeId: store.id, name, priceFen, isActive: true };
}

test("门店卡起价只使用当前车辆价类 offers，不使用跨车型 startingPriceFen", () => {
  const card = buildWashStoreCard(store, [offer("detail", "精致洗", 12800), offer("standard", "标准洗", 5800)]);
  assert.equal(card.currentVehiclePriceFen, 5800);
  assert.equal(card.startingPackageId, "standard");
  assert.equal(card.startingPackageName, "标准洗");
  assert.equal(card.hasCurrentVehicleOffer, true);
  assert.equal(card.openStateLabel, "可预约");
  assert.notEqual(card.currentVehiclePriceFen, store.startingPriceFen);
  assert.deepEqual(card.visibleTags, ["可代驾", "休息区", "新能源友好"]);
  assert.equal(card.facilitiesText, "休息区 · 卫生间 · 免费饮水 · 充电位");
});

test("真实空套餐与价格读取失败保持不同状态", () => {
  const emptyOfferCard = buildWashStoreCard(store, []);
  assert.equal(emptyOfferCard.hasCurrentVehicleOffer, false);
  assert.equal(emptyOfferCard.priceError, "");
  assert.equal(emptyOfferCard.earliestLabel, "当前车型暂无套餐");
});

test("门店实景优先封面排序，缺图回退到洗车服务环境 raster 并明确标识", () => {
  const withImages = buildWashStoreCard({
    ...store,
    coverImageUrl: "/api/uploads/wash/cover.jpg",
    images: [
      { id: "2", url: "/api/uploads/wash/detail.jpg", sortOrder: 1, isCover: false, dataKind: "demo" },
      { id: "1", url: "/api/uploads/wash/cover.jpg", sortOrder: 9, isCover: true, dataKind: "demo" },
    ],
  }, [offer("standard", "标准洗", 3800)]);
  assert.equal(withImages.coverSrc, "/api/uploads/wash/cover.jpg");
  assert.deepEqual(withImages.gallerySources, ["/api/uploads/wash/cover.jpg", "/api/uploads/wash/detail.jpg"]);
  assert.equal(withImages.usesFallbackCover, false);

  const fallback = buildWashStoreCard(store, []);
  assert.match(WASH_STORE_FALLBACK_COVER, /assets\/wash-stores\/demo-car-wash-cover\.jpg$/);
  assert.equal(fallback.coverSrc, WASH_STORE_FALLBACK_COVER);
  assert.equal(fallback.usesFallbackCover, true);
  assert.deepEqual(fallback.gallerySources, []);
  assert.equal(washStoreFallbackCover(1), WASH_STORE_FALLBACK_COVER);
  assert.equal(washStoreFallbackCover(2), WASH_STORE_FALLBACK_COVER);
  assert.equal(washStoreFallbackCover(3), washStoreFallbackCover(0));
});

test("距离展示不会把估算伪装成真实驾车路线", () => {
  assert.deepEqual(washStoreDistance(store), { text: "约 3.3 km", sourceLabel: "位置估算" });
  assert.deepEqual(washStoreDistance({ distanceKm: 4.2, distanceSource: "tencent_matrix" }), { text: "4.2 km", sourceLabel: "驾车路线" });
  assert.deepEqual(washStoreDistance({ distanceKm: null, distanceSource: "not_calculated" }), { text: "定位后显示距离", sourceLabel: "尚未计算" });
});

test("后台相对门店图片地址会规范为小程序可加载的 API 绝对地址", () => {
  assert.equal(washStoreImageUrl("https://cdn.example.com/store.jpg"), "https://cdn.example.com/store.jpg");
  assert.equal(washStoreImageUrl("wxfile://store.jpg"), "wxfile://store.jpg");
  assert.equal(washStoreImageUrl(WASH_STORE_FALLBACK_COVER), WASH_STORE_FALLBACK_COVER);
  assert.equal(washStoreImageUrl("/api/wash/store-images/cover"), `${apiOrigin}/api/wash/store-images/cover`);
  const normalized = normalizeWashStore({
    ...store,
    coverImageUrl: "/api/wash/store-images/cover",
    images: [{ id: "cover", url: "/api/wash/store-images/cover", isCover: true, dataKind: "demo" }],
  });
  assert.equal(String(normalized.coverImageUrl), `${apiOrigin}/api/wash/store-images/cover`);
  assert.equal(String(normalized.images?.[0].url), `${apiOrigin}/api/wash/store-images/cover`);
});

test("最近可约仅查询短期窗口并生成清晰日期文案", () => {
  assert.deepEqual(washAvailabilityDates("2026-08-22", 3), ["2026-08-22", "2026-08-23", "2026-08-24"]);
  assert.equal(washEarliestSlotLabel("2026-08-22", "2026-08-22", "10:00", "标准洗"), "标准洗 · 今天 10:00");
  assert.equal(washEarliestSlotLabel("2026-08-22", "2026-08-24", "09:30", "精致洗"), "精致洗 · 8月24日 09:30");
});

test("独立门店页完整承接详情、选择回传与预约页防串价刷新", () => {
  const pageSource = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-stores/wash-stores.ts", import.meta.url), "utf8");
  const template = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-stores/wash-stores.wxml", import.meta.url), "utf8");
  const bookingSource = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-booking/wash-booking.ts", import.meta.url), "utf8");
  const bookingTemplate = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-booking/wash-booking.wxml", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const appJson = JSON.parse(readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8")) as {
    subPackages: Array<{ root: string; pages: string[] }>;
  };

  const washPackage = appJson.subPackages.find((item) => item.root === "packages/wash");
  assert.ok(washPackage?.pages.includes("pages/wash-stores/wash-stores"));
  assert.match(apiSource, /washStores: async \(params:[\s\S]+originLat/);
  assert.match(apiSource, /washStore: async \(storeId:[\s\S]+\/wash\/stores\//);
  assert.match(pageSource, /api\.washPackages\(store\.id, category\)/);
  assert.match(pageSource, /api\.washSlots\(card\.id, date, card\.startingPackageId\)/);
  assert.match(pageSource, /patchWashDraft\(\{ storeId, packageId: undefined, slotId: undefined \}\)/);
  assert.match(pageSource, /draft\.selfDriveOrigin\?\.type === "self_drive"/);
  assert.match(pageSource, /patchWashDraft\(\{ selfDriveOrigin: \{ \.\.\.origin, type: "self_drive" \} \}\)/);
  assert.match(pageSource, /distanceKm: detail\.distanceKm \?\? latest\.distanceKm/);
  assert.match(pageSource, /coverError\(event\)[\s\S]+washStoreFallbackCover\(index\)/);
  assert.match(pageSource, /return \{ store, packages: \[\], priceError: "价格读取失败" \}/);
  assert.match(pageSource, /retryStorePrice\(event\)/);
  assert.match(pageSource, /priceError: latest\.priceError/);
  assert.match(template, /门店相册/);
  assert.match(template, /businessHoursNotice/);
  assert.match(template, /distanceSourceLabel/);
  assert.match(template, /currentVehiclePriceFen/);
  assert.match(template, /选择这家/);
  assert.match(template, /catchtap="retryStorePrice"/);
  assert.match(template, /item\.priceError/);
  assert.match(template, /aria-label="查看\{\{item\.name\}\}第\{\{imageIndex \+ 1\}\}张门店图片"/);
  assert.match(bookingSource, /chooseStore\(\) \{ wx\.navigateTo\(\{ url: "\/packages\/wash\/pages\/wash-stores\/wash-stores" \}\); \}/);
  assert.match(bookingSource, /pageLoadSequence/);
  assert.doesNotMatch(bookingTemplate, /bindchange="changeStore"/);
  assert.match(bookingTemplate, /bindtap="chooseStore"/);
  assert.match(bookingTemplate, /binderror="selectedStoreCoverError"/);
});
