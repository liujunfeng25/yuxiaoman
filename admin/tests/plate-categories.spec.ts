import { expect, test } from "@playwright/test";
import { PLATE_CATEGORIES } from "../../wechat-miniprogram/miniprogram/utils/plate-categories";

test("后台按 11 类号牌配置方案和站点报价，并用于车主实际报价", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "检验价格方案" }).click();
  await expect(page.getByRole("heading", { name: "适用号牌车型（11 类）" })).toBeVisible();
  for (const category of PLATE_CATEGORIES) {
    await expect(page.locator(".plan-editor").getByRole("checkbox", { name: category.label, exact: true })).toBeVisible();
  }
  await page.locator(".plan-layout .station-list").getByRole("button", { name: "新增" }).click();
  await page.getByLabel("方案名称", { exact: true }).fill("号牌分类报价测试");
  await page.getByLabel("价格方案系统识别码", { exact: true }).fill("plate-category-ui-test");
  await page.locator(".plan-editor").getByRole("checkbox", { name: "蓝牌小型普通客车", exact: true }).uncheck();
  await page.locator(".plan-editor").getByRole("checkbox", { name: "新能源小型普通客车", exact: true }).uncheck();
  await page.locator(".plan-editor").getByRole("checkbox", { name: "新能源小型货车", exact: true }).check();
  await page.getByLabel("使用性质", { exact: true }).fill("货运");
  const savedPlan = page.waitForResponse((response) => response.url().endsWith("/api/admin/inspection-price-plans") && response.request().method() === "POST");
  await page.getByRole("button", { name: "保存价格方案", exact: true }).click();
  const response = await savedPlan;
  expect(response.status()).toBe(201);
  const plan = (await response.json()).data;
  expect(plan.plateCategories).toEqual(["new_energy_small_truck"]);
  expect(plan.vehicleClassCodes).toEqual(["small_truck"]);
  await expect(page.locator(".plan-editor h2")).toHaveText("号牌分类报价测试");
  await page.screenshot({ path: testInfo.outputPath("plate-category-plan.png"), fullPage: true });

  await page.getByRole("button", { name: "站点配置", exact: true }).click();
  await page.getByRole("button", { name: /海河机动车检测服务中心（演示）.*演示/ }).click();
  const offer = page.locator(".price-matrix label").filter({ hasText: "号牌分类报价测试" });
  await offer.getByRole("checkbox").check();
  await offer.getByRole("spinbutton").fill("357.12");
  const stationSaved = page.waitForResponse((item) => item.url().includes("/api/admin/stations/station-hexi-1") && item.request().method() === "PUT");
  await page.getByRole("button", { name: "保存站点配置", exact: true }).click();
  expect((await stationSaved).status()).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: /海河机动车检测服务中心（演示）.*演示/ }).click();
  await expect(page.locator(".price-matrix label").filter({ hasText: "号牌分类报价测试" }).getByRole("spinbutton")).toHaveValue("357.12");
  const created = await page.request.post("/api/vehicles", { data: {
    plateNumber: "津DA1B2C3", plateCategory: "new_energy_small_truck", vehicleType: "小型货车",
    usageNature: "货运", seats: 2, powertrainType: "gasoline", registrationDate: "2020-01-01",
  } });
  expect(created.status()).toBe(201);
  const vehicle = (await created.json()).data;
  const quote = await page.request.post("/api/bookings/quote", { data: {
    vehicleId: vehicle.id, stationId: "station-hexi-1", serviceMode: "self_drive",
  } });
  expect(quote.status()).toBe(200);
  const price = (await quote.json()).data;
  expect(price.pricingEligibility).toBe("supported");
  expect(price.matchedPricePlan.id).toBe(plan.id);
  expect(price.inspectionFeeFen).toBe(35712);
});
