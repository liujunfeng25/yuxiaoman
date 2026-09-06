import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { energyLabel, rentalDays, validateRentalSearch } from "../miniprogram/packages/car-rental/utils/rental";

const base = join(import.meta.dirname, "..");

test("按每 24 小时向上计算租期", () => {
  assert.equal(rentalDays("2026-08-24T10:00:00+08:00", "2026-08-25T10:00:00+08:00"), 1);
  assert.equal(rentalDays("2026-08-24T10:00:00+08:00", "2026-08-25T10:01:00+08:00"), 2);
  assert.equal(rentalDays("2026-08-24T10:00:00+08:00", "2026-08-24T09:00:00+08:00"), 0);
});

test("租车搜索强制提前量、同店或同址与 30 天边界", () => {
  const now = new Date("2026-08-22T08:00:00+08:00");
  assert.equal(validateRentalSearch({ fulfillmentMode: "store_pickup", storeId: "store-1", pickupAt: "2026-08-22T09:00:00+08:00", returnAt: "2026-08-23T09:00:00+08:00" }, now), "取车时间需至少提前 2 小时");
  assert.equal(validateRentalSearch({ fulfillmentMode: "store_pickup", pickupAt: "2026-08-24T10:00:00+08:00", returnAt: "2026-08-25T10:00:00+08:00" }, now), "请选择同店取还门店");
  assert.equal(validateRentalSearch({ fulfillmentMode: "home_delivery", pickupAt: "2026-08-24T10:00:00+08:00", returnAt: "2026-08-25T10:00:00+08:00" }, now), "请搜索并选择送取车地址");
  assert.equal(validateRentalSearch({ fulfillmentMode: "store_pickup", storeId: "store-1", pickupAt: "2026-08-24T10:00:00+08:00", returnAt: "2026-09-24T10:00:00+08:00" }, now), "当前短租最长支持 30 天");
  assert.equal(validateRentalSearch({ fulfillmentMode: "store_pickup", storeId: "store-1", pickupAt: "2026-08-24T10:00:00+08:00", returnAt: "2026-08-26T10:00:00+08:00" }, now), "");
});

test("能源枚举使用统一租赁合同", () => {
  assert.equal(energyLabel("gasoline"), "汽油");
  assert.equal(energyLabel("plug_in_hybrid"), "插电混动");
  assert.equal(energyLabel("range_extended"), "增程");
  assert.equal(energyLabel("pure_electric"), "纯电");
});

test("小程序仅注册新租赁页面并消费冻结 API", () => {
  const app = JSON.parse(readFileSync(join(base, "miniprogram/app.json"), "utf8")) as {
    pages: string[];
    subPackages: Array<{ root: string; pages: string[] }>;
  };
  const rentalPackage = app.subPackages.find((item) => item.root === "packages/car-rental");
  assert.ok(rentalPackage?.pages.includes("pages/car-rental-home/car-rental-home"));
  assert.ok(rentalPackage?.pages.includes("pages/car-rental-order-detail/car-rental-order-detail"));
  const registeredPages = [
    ...app.pages,
    ...app.subPackages.flatMap((item) => item.pages.map((page) => `${item.root}/${page}`)),
  ];
  assert.equal(registeredPages.some((page) => page.includes("used-car")), false);

  const api = readFileSync(join(base, "miniprogram/services/api.ts"), "utf8");
  for (const endpoint of ["/car-rental/catalog", "/car-rental/stores", "/car-rental/offers/search", "/car-rental/quotes", "/car-rental/orders", "/mock-pay", "/cancel"]) {
    assert.ok(api.includes(endpoint), `missing ${endpoint}`);
  }
  const home = readFileSync(join(base, "miniprogram/pages/home/home.wxml"), "utf8");
  assert.ok(home.includes("汽车租赁"));
});

test("租车首页自定义导航提供可触达返回，深链返回有首页兜底", () => {
  const rentalHome = readFileSync(join(base, "miniprogram/packages/car-rental/pages/car-rental-home/car-rental-home.wxml"), "utf8");
  const rentalHomePage = readFileSync(join(base, "miniprogram/packages/car-rental/pages/car-rental-home/car-rental-home.ts"), "utf8");
  const navigation = readFileSync(join(base, "miniprogram/packages/car-rental/utils/navigation.ts"), "utf8");
  const offers = readFileSync(join(base, "miniprogram/packages/car-rental/pages/car-rental-offers/car-rental-offers.ts"), "utf8");
  const detail = readFileSync(join(base, "miniprogram/packages/car-rental/pages/car-rental-detail/car-rental-detail.ts"), "utf8");
  const confirm = readFileSync(join(base, "miniprogram/packages/car-rental/pages/car-rental-confirm/car-rental-confirm.ts"), "utf8");
  const orderDetail = readFileSync(join(base, "miniprogram/packages/car-rental/pages/car-rental-order-detail/car-rental-order-detail.wxml"), "utf8");

  assert.match(rentalHome, /class="header-back"[^>]+bindtap="goBack"/);
  assert.match(rentalHome, /aria-label="返回上一页，无上一页时返回首页"/);
  assert.match(rentalHomePage, /goBack\(\) \{ leaveRentalHome\(\); \}/);
  assert.ok(navigation.includes('wx.switchTab({ url: OWNER_HOME_URL })'));
  assert.ok(navigation.includes('wx.redirectTo({ url: RENTAL_HOME_URL })'));
  assert.match(offers, /editSearch\(\) \{ backOrRentalHome\(\); \}/);
  assert.match(detail, /backToOffers\(\) \{ backOrRentalHome\(\); \}/);
  assert.match(confirm, /changeTrip\(\) \{ backOrRentalHome\(3\); \}/);
  assert.match(orderDetail, /bindtap="backToRent">返回租车首页/);

  for (const page of ["car-rental-offers", "car-rental-detail", "car-rental-confirm", "car-rental-orders", "car-rental-order-detail"]) {
    const pageConfig = JSON.parse(readFileSync(join(base, `miniprogram/packages/car-rental/pages/${page}/${page}.json`), "utf8")) as { navigationBarTitleText?: string; navigationStyle?: string };
    assert.ok(pageConfig.navigationBarTitleText, `${page} should retain a native navigation title`);
    assert.notEqual(pageConfig.navigationStyle, "custom", `${page} should retain the native back affordance`);
  }
});
