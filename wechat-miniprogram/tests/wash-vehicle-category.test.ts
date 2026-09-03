import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Vehicle, WashVehicleCategory } from "../miniprogram/types";
import {
  isWashCatalogSelectionCurrent,
  nextWashCatalogSelection,
  type WashCatalogSelection,
} from "../miniprogram/packages/wash/utils/wash-catalog-selection";
import { washVehicleCategory, washVehicleCategoryLabel } from "../miniprogram/packages/wash/utils/wash-vehicle-category";

function vehicle(id: string, vehicleType: string, category: Vehicle["washVehicleCategory"], seats = 5): Vehicle {
  return {
    id,
    plateNumber: `津A·${id}`,
    vehicleType,
    washVehicleCategory: category,
    usageNature: "非营运",
    seats,
    registrationDate: "2020-01-01",
    inspectionDueDate: "2027-08-31",
    isDefault: id === "sedan",
  };
}

test("三辆车切换时按 sedan、suv、mpv 分别请求套餐并使用服务端价格", async () => {
  const vehicles = [
    vehicle("sedan", "小型轿车", "sedan"),
    vehicle("suv", "7 座 SUV", "suv", 7),
    vehicle("mpv", "MPV / 多用途乘用车", "mpv", 7),
  ];
  const serverPrices: Record<WashVehicleCategory, number> = { sedan: 3800, suv: 4800, mpv: 5800 };
  const calls: WashVehicleCategory[] = [];
  const washPackages = async (_storeId: string, category: WashVehicleCategory) => {
    calls.push(category);
    return [{ id: "standard", name: "标准洗", priceFen: serverPrices[category] }];
  };

  const visiblePrices: number[] = [];
  const visibleLabels: string[] = [];
  for (const selectedVehicle of vehicles) {
    const category = washVehicleCategory(selectedVehicle);
    const packages = await washPackages("store-demo", category);
    visiblePrices.push(packages[0].priceFen);
    visibleLabels.push(`${washVehicleCategoryLabel(selectedVehicle)}价格`);
  }

  assert.deepEqual(calls, ["sedan", "suv", "mpv"]);
  assert.deepEqual(visiblePrices, [3800, 4800, 5800]);
  assert.deepEqual(visibleLabels, ["小轿车价格", "SUV价格", "MPV价格"]);
  assert.equal(calls.includes("suv_mpv" as WashVehicleCategory), false);
});

test("历史合并档兼容为 SUV，7 座不会把显式 SUV 强推成 MPV", () => {
  assert.equal(washVehicleCategory(vehicle("legacy", "7 座乘用车", "suv_mpv", 7)), "suv");
  assert.equal(washVehicleCategory(vehicle("seven-seat-suv", "7 座 SUV", "suv", 7)), "suv");
  assert.equal(washVehicleCategory(vehicle("unclassified-seven-seat", "7 座乘用车", null, 7)), "sedan");
});

test("预约页以规范化 category 调用 offers，并直接展示服务端 priceFen", () => {
  const source = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-booking/wash-booking.ts", import.meta.url), "utf8");
  const template = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-booking/wash-booking.wxml", import.meta.url), "utf8");
  assert.match(source, /const category = washVehicleCategory\(vehicle\);/);
  assert.match(source, /api\.washPackages\(store\.id, category\)/);
  assert.match(source, /vehicleCategory: washVehicleCategory\(vehicle\)/);
  assert.match(template, /selectedVehicle\.plateNumber/);
  assert.match(template, /selectedVehicleCategoryLabel}}计价/);
  assert.match(template, /package-price-category/);
  assert.match(template, /洗车服务费（{{selectedVehicleCategoryLabel}}）/);
  assert.match(template, /fmt\.money\(item\.priceFen\)/);
  assert.doesNotMatch(source, /seats\s*>=\s*7/);
});

test("车型套餐反序返回时只接受最后选择的 MPV 结果", async () => {
  type Deferred = { promise: Promise<number>; resolve: (value: number) => void };
  const deferred = (): Deferred => {
    let resolve!: (value: number) => void;
    const promise = new Promise<number>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
  };
  const suvResponse = deferred();
  const mpvResponse = deferred();
  let current: WashCatalogSelection | undefined;
  const applied: Array<{ vehicleId: string; priceFen: number }> = [];

  const requestCatalog = async (vehicleId: string, response: Deferred) => {
    const selection = nextWashCatalogSelection(current, "store-demo", vehicleId);
    current = selection;
    const priceFen = await response.promise;
    if (isWashCatalogSelectionCurrent(current, selection)) applied.push({ vehicleId, priceFen });
  };

  const slowSuv = requestCatalog("vehicle-suv", suvResponse);
  const fastMpv = requestCatalog("vehicle-mpv", mpvResponse);
  mpvResponse.resolve(5800);
  await fastMpv;
  suvResponse.resolve(4800);
  await slowSuv;

  assert.deepEqual(applied, [{ vehicleId: "vehicle-mpv", priceFen: 5800 }]);
});

test("预约页用独立 selection token 同时保护套餐与后续时段", () => {
  const source = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-booking/wash-booking.ts", import.meta.url), "utf8");
  assert.match(source, /const catalogSelection = nextWashCatalogSelection\(/);
  assert.match(source, /await api\.washPackages\(store\.id, category\)[\s\S]{0,320}isWashCatalogSelectionCurrent\([^;]+catalogSelection\)/);
  assert.match(source, /const slotRequest = \{[\s\S]{0,320}catalogSequence: catalogSelection\.sequence/);
  assert.match(source, /await api\.washSlots\(catalogSelection\.storeId, date, selectedPackage\.id\)[\s\S]{0,260}this\.slotRequest !== slotRequest/);
});

test("切套餐或日期后旧报价即使最后返回也不会重新显示", async () => {
  const source = readFileSync(new URL("../miniprogram/packages/wash/pages/wash-booking/wash-booking.ts", import.meta.url), "utf8");
  const loadSlots = source.slice(source.indexOf("async loadSlots("), source.indexOf("async refreshQuote("));
  const invalidateAt = loadSlots.indexOf("this.quoteSequence = Number(this.quoteSequence || 0) + 1");
  const clearQuoteAt = loadSlots.indexOf("quote: null");
  const awaitSlotsAt = loadSlots.indexOf("await api.washSlots(");
  assert.ok(invalidateAt >= 0 && invalidateAt < awaitSlotsAt, "loadSlots 必须在等待新时段前废弃旧报价");
  assert.ok(clearQuoteAt >= 0 && clearQuoteAt < awaitSlotsAt, "loadSlots 必须在等待新时段前清空旧报价");

  let quoteSequence = 0;
  let resolveOldQuote!: (value: number) => void;
  const oldQuoteResponse = new Promise<number>((resolve) => { resolveOldQuote = resolve; });
  let visibleQuote: number | null = null;
  const oldSequence = ++quoteSequence;
  const oldRequest = oldQuoteResponse.then((priceFen) => {
    if (quoteSequence === oldSequence) visibleQuote = priceFen;
  });

  // Mirrors the synchronous invalidation and clear performed by loadSlots.
  quoteSequence += 1;
  visibleQuote = null;
  resolveOldQuote(4800);
  await oldRequest;
  assert.equal(visibleQuote, null);
});

test("规范化 legacy 标记只由原始 suv_mpv 值决定", () => {
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  assert.match(apiSource, /washVehicleCategoryLegacy:\s*rawWashCategory === "suv_mpv"/);
  assert.doesNotMatch(apiSource, /washVehicleCategoryLegacy:\s*Boolean\(raw\.washVehicleCategoryLegacy/);
});
