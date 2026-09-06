import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { VEHICLE_CATALOG, resolveVehicleCatalogSelection, vehicleCatalogDto } from "../../server/vehicle-catalog";
import { searchVehicleCatalog } from "../miniprogram/packages/vehicle/utils/catalog-search";

test("full catalog keeps unique identities while every visual picker model uses an exact fixed-angle cutout", () => {
  const models = VEHICLE_CATALOG.flatMap((brand) => brand.models);
  const modelsWithPhotos = models.filter((model) => model.imageUrl);
  assert.ok(VEHICLE_CATALOG.length >= 130);
  assert.ok(models.length >= 1500);
  assert.equal(new Set(VEHICLE_CATALOG.map((brand) => brand.id)).size, VEHICLE_CATALOG.length);
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
  for (const brand of VEHICLE_CATALOG) {
    assert.ok(brand.models.length > 0);
    assert.equal(new Set(brand.models.map((model) => model.name)).size, brand.models.length, brand.name);
    for (const model of brand.models) {
      assert.equal(model.brandId, brand.id);
      assert.equal(resolveVehicleCatalogSelection(brand.id, model.id)?.model, model);
      if (model.imageUrl) {
        assert.equal(model.imageKind, "presentation_cutout");
        assert.ok(existsSync(new URL(`../../public${model.imageUrl}`, import.meta.url)), model.imageUrl);
      } else {
        assert.equal(model.imageKind, "unavailable");
      }
    }
  }
  assert.equal(modelsWithPhotos.length, 1581, "all catalog models must have an approved fixed-angle presentation cutout");
  assert.equal(new Set(modelsWithPhotos.map((model) => model.imageUrl)).size, modelsWithPhotos.length,
    "one exact-series presentation cutout must not be reused under another catalog model");
  assert.equal(modelsWithPhotos.length, models.length, "the full catalog must load presentation cutouts from the server");
  assert.ok(models.every((model) => !model.imageUrl.includes("vehicle-generic")));
  assert.equal(resolveVehicleCatalogSelection("brand-toyota", "vehicle-honda-accord"), null);
  assert.equal(resolveVehicleCatalogSelection("brand-toyota", "vehicle-unknown"), null);
  assert.ok(Buffer.byteLength(JSON.stringify(vehicleCatalogDto())) < 512 * 1024, "catalog must fit one native setData update");
});

test("Subaru keeps all model identities and gives every series its own approved fixed-angle cutout", () => {
  const subaru = VEHICLE_CATALOG.find((brand) => brand.id === "brand-subaru");
  assert.ok(subaru);
  assert.equal(subaru.models.length, 9);
  assert.deepEqual(subaru.models.filter((model) => model.imageUrl).map((model) => model.name), ["森林人", "傲虎", "XV", "旭豹", "力狮", "翼豹", "BRZ", "驰鹏", "WRX"]);
  assert.equal(subaru.models.find((model) => model.name === "森林人")?.imageKind, "presentation_cutout");
  assert.deepEqual(subaru.models.map((model) => model.name), ["森林人", "傲虎", "XV", "旭豹", "力狮", "翼豹", "BRZ", "驰鹏", "WRX"]);
  assert.match(resolveVehicleCatalogSelection("brand-mercedes", "vehicle-mercedes-s")?.model.imageUrl || "", /owner-models\/vehicle-mercedes-s\.webp$/);
});

test("catalog filters passenger cars, buses, trucks, tractors and trailers by plate vehicle class", () => {
  const smallPassenger = searchVehicleCatalog(VEHICLE_CATALOG, "", "brand-volkswagen", "passenger_car");
  assert.equal(smallPassenger.activeBrandId, "brand-volkswagen");
  assert.ok(smallPassenger.activeModels.every((model) => model.vehicleClassCodes.includes("passenger_car")));
  assert.ok(!smallPassenger.catalogBrandOptions.some((brand) => brand.id === "brand-trailer-body"));

  const lightTrucks = searchVehicleCatalog(VEHICLE_CATALOG, "", "brand-jac-shuailing", "small_truck");
  assert.deepEqual(lightTrucks.activeModels.map((model) => model.name), ["帅铃N55", "帅铃II"]);
  assert.ok(lightTrucks.activeModels.every((model) => model.imageKind === "presentation_cutout"));

  const tractors = searchVehicleCatalog(VEHICLE_CATALOG, "", "brand-faw-jiefang", "large_tractor");
  assert.equal(tractors.activeModels[0].name, "J7");
  assert.deepEqual(tractors.catalogBrandOptions.map((brand) => brand.id), [
    "brand-faw-jiefang", "brand-sinotruk-howo", "brand-shacman", "brand-foton-auman",
  ]);

  const heavyTrucks = searchVehicleCatalog(VEHICLE_CATALOG, "", "brand-dongfeng-commercial", "large_truck");
  assert.deepEqual(heavyTrucks.activeModels.map((model) => model.name), ["天龙KL", "天锦KR"]);

  const trailers = searchVehicleCatalog(VEHICLE_CATALOG, "", "brand-trailer-body", "trailer");
  assert.equal(trailers.catalogBrandOptions.length, 1);
  assert.deepEqual(trailers.activeModels.map((model) => model.name), [
    "平板半挂车", "栏板半挂车", "车辆运输半挂车", "侧帘半挂车", "集装箱运输半挂车", "罐式半挂车", "厢式半挂车",
  ]);
  assert.ok(trailers.activeModels.every((model) => model.imageKind === "presentation_cutout"));

  const buses = searchVehicleCatalog(VEHICLE_CATALOG, "", "brand-yutong-bus", "large_bus");
  assert.deepEqual(buses.activeModels.map((model) => model.name), ["ZK6126HG"]);
});

test("search supports Chinese brands, combined names, English, pinyin, case and separators", () => {
  const cases = [
    ["大众途观L", "vehicle-volkswagen-tiguan-l"], ["途观L", "vehicle-volkswagen-tiguan-l"],
    ["丰田 凯美瑞", "vehicle-toyota-camry"], ["BMW 5系", "vehicle-bmw-5"],
    ["ＢＭＷ ５系", "vehicle-bmw-5"], ["dazhong", "vehicle-volkswagen-tiguan-l"],
    ["本田雅阁", "vehicle-honda-accord"], ["MODEL-Y", "vehicle-tesla-model-y"],
    ["小米SU7", "vehicle-xiaomi-su7"], ["森林人", "vehicle-subaru-forester"],
  ];
  for (const [query, expected] of cases) {
    const result = searchVehicleCatalog(VEHICLE_CATALOG, query);
    assert.ok(result.activeModels.some((model) => model.id === expected), query);
  }
  assert.ok(VEHICLE_CATALOG.flatMap((brand) => brand.models).every((model) => model.imageUrl && model.imageKind === "presentation_cutout"),
    "every full-catalog model must remain selectable with its approved presentation cutout");
});

test("filtering keeps only matching models when changing brands and clears stale results", () => {
  const results = searchVehicleCatalog(VEHICLE_CATALOG, "L7", "brand-li");
  assert.equal(results.activeBrandId, "brand-li");
  assert.deepEqual(results.activeModels.map((model) => model.name), ["L7"]);
  const noMatch = searchVehicleCatalog(VEHICLE_CATALOG, "这不是一个车型", "brand-li");
  assert.equal(noMatch.activeBrandId, "");
  assert.equal(noMatch.catalogMatchCount, 0);
  assert.deepEqual(noMatch.activeModels, []);
  const cleared = searchVehicleCatalog(VEHICLE_CATALOG, "", "brand-xiaomi");
  assert.equal(cleared.activeBrandId, "brand-xiaomi");
  assert.equal(cleared.catalogBrandOptions.length, VEHICLE_CATALOG.length,
    "clearing a brand filter must retain every brand now that all catalog models have presentation cutouts");
  assert.ok(cleared.activeModels.every((model) => model.imageUrl && model.imageKind === "presentation_cutout"));
});

test("picker tap handlers are isolated from the editor beneath the sheet", () => {
  const markup = readFileSync(new URL("../miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form.wxml", import.meta.url), "utf8");
  assert.match(markup, /class="keyboard-mask" catchtap="closeCatalog" catchtouchmove="noop"/u);
  assert.match(markup, /class="vehicle-catalog-sheet" catchtap="noop" catchtouchmove="noop"/u);
  assert.match(markup, /data-id="\{\{item\.id\}\}" catchtap="chooseCatalogModel"/u);
  assert.match(markup, /<button catchtap="closeCatalog">\{\{selectedModelId/u);
});

test("native add/edit handlers load, search, select and save new catalog identities without changing vehicle facts", async () => {
  type PageData = Record<string, any>;
  type Page = { data: PageData; setData(patch: PageData): void; [key: string]: any };
  let definition: Page;
  const navigationCalls: string[] = [];
  const globals = globalThis as any;
  globals.Page = (options: Page) => { definition = options; };
  globals.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getSystemInfoSync: () => ({ platform: "devtools" }),
    hideKeyboard() {}, showToast() {}, setNavigationBarTitle() {},
    navigateBack() { navigationCalls.push("navigateBack"); },
    redirectTo() { navigationCalls.push("redirectTo"); },
    reLaunch() { navigationCalls.push("reLaunch"); },
    switchTab() { navigationCalls.push("switchTab"); },
  };
  const { api } = await import("../miniprogram/services/api");
  await import("../miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form");
  const originals = { vehicleCatalog: api.vehicleCatalog, vehicles: api.vehicles, updateVehicle: api.updateVehicle };
  const oldVehicle = {
    id: "owner-car", plateNumber: "津A·12345", vehicleType: "小型轿车", seats: 5, usageNature: "非营运",
    registrationDate: "2020-01-01", powertrainType: "gasoline", washVehicleCategory: "sedan",
    exteriorColor: "珍珠白",
    brand: { id: "brand-bmw", name: "宝马" }, model: { id: "vehicle-bmw-5", name: "5系" },
    facts: { powertrainSource: "user_confirmed" },
    visual: { imageUrl: "/assets/used-cars/owner-models/vehicle-bmw-5.webp", kind: "presentation_cutout", label: "车型展示图" },
  };
  let saved: PageData | undefined;
  const catalog = vehicleCatalogDto();
  api.vehicleCatalog = async () => catalog;
  api.vehicles = async () => [oldVehicle] as any;
  api.updateVehicle = async (_id, payload) => { saved = payload; return oldVehicle as any; };
  const page: Page = { ...definition!, data: structuredClone(definition!.data), setData(patch) { Object.assign(this.data, patch); } };
  try {
    await page.onLoad({ id: "owner-car" });
    assert.equal(page.data.selectedModelId, "vehicle-bmw-5");
    assert.equal(page.data.passengerColorEnabled, true);
    assert.equal(page.data.exteriorColor, "珍珠白", "editing a passenger car must restore its saved exterior color");
    page.openCatalog();
    page.chooseCatalogBrand({ currentTarget: { dataset: { id: "brand-volkswagen" } } });
    assert.equal(page.data.activeBrandId, "brand-volkswagen");
    assert.ok(page.data.activeModels.length > 0);
    assert.deepEqual(navigationCalls, [], "opening and switching brands must stay on the editor page");
    page.searchCatalog({ detail: { value: "大众途观L" } });
    assert.equal(page.data.activeModels.length, 1);
    page.chooseCatalogModel({ currentTarget: { dataset: { id: "vehicle-volkswagen-tiguan-l" } } });
    assert.equal(page.data.selectedModelName, "途观L");
    assert.match(page.data.selectedModelImage, /owner-presentation-v2\/vehicle-volkswagen-tiguan-l\.webp$/);
    assert.equal(page.data.catalogOpen, true, "selecting a model must not dismiss the picker or navigate away");
    assert.deepEqual(navigationCalls, [], "brand/model selection must not call a navigation API");
    page.catalogModelImageError({ currentTarget: { dataset: { id: "vehicle-volkswagen-tiguan-l" } } });
    assert.equal(page.data.activeModels.length, 1, "a failed network image must not remove the model choice");
    assert.equal(page.data.activeModels[0].imageLoadFailed, true);
    assert.equal(page.data.selectedModelImage, "");
    assert.equal(page.data.catalogOpen, true);
    assert.deepEqual(navigationCalls, [], "image fallback must not change pages");
    page.closeCatalog();
    assert.equal(page.data.catalogOpen, false);
    assert.deepEqual(navigationCalls, [], "closing the picker must leave the editor route in place");
    page.chooseExteriorColor({ currentTarget: { dataset: { value: "蓝色" } } });
    assert.equal(page.data.exteriorColor, "蓝色", "passenger cars must accept a common exterior color");
    page.exteriorColorInput({ detail: { value: "海湾蓝（个性定制）" } });
    await page.submit();
    assert.equal(saved?.brandId, "brand-volkswagen");
    assert.equal(saved?.modelId, "vehicle-volkswagen-tiguan-l");
    assert.equal(saved?.seats, 5);
    assert.equal(saved?.washVehicleCategory, "sedan");
    assert.equal(saved?.exteriorColor, "海湾蓝（个性定制）", "a custom passenger-car exterior color must be saved");
    assert.ok(!Object.hasOwn(saved!, "powertrainType"));
    assert.ok(!Object.hasOwn(saved!, "inspectionValidity"));
    assert.deepEqual(navigationCalls, ["navigateBack"], "only a successful explicit save may leave the editor");

    page.openCatalog();
    assert.equal(page.data.catalogQuery, "");
    assert.equal(page.data.activeBrandId, "brand-volkswagen");
    api.vehicleCatalog = async () => { throw new Error("offline"); };
    await page.loadCatalog();
    assert.equal(page.data.catalogError, true);
    assert.equal(page.data.selectedModelId, "vehicle-volkswagen-tiguan-l");
    api.vehicleCatalog = async () => catalog;
    await page.loadCatalog();
    assert.equal(page.data.catalogError, false);
    page.clearCatalogSelection();
    assert.equal(page.data.selectedBrandId, "");
    assert.equal(page.data.selectedModelId, "");

    page.categoryChange({ detail: { value: 4 } });
    assert.equal(page.data.passengerColorEnabled, true, "large buses must support exterior colors");
    page.chooseExteriorColor({ currentTarget: { dataset: { value: "金色" } } });
    assert.equal(page.data.exteriorColor, "金色");
    page.exteriorColorInput({ detail: { value: "企业定制蓝" } });
    assert.equal(page.data.exteriorColor, "企业定制蓝", "large buses must accept a custom exterior color");

    page.categoryChange({ detail: { value: 2 } });
    assert.equal(page.data.passengerColorEnabled, false);
    assert.equal(page.data.exteriorColor, "");
    assert.equal(page.data.activeBrandId, "brand-dongfeng-commercial");
    assert.ok(page.data.activeModels.every((model: any) => model.vehicleClassCodes.includes("small_truck")));
  } finally {
    Object.assign(api, originals);
    delete globals.Page;
    delete globals.wx;
  }
});
