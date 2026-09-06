import { expect, test, type Page, type Route } from "@playwright/test";

type Trace = {
  brandPut?: Record<string, unknown>;
  brandLogoContentType?: string;
  modelImageContentType?: string;
  storePut?: Record<string, unknown>;
  retiredVehicleId?: string;
  ratePut?: Record<string, unknown>;
  overridePost?: Record<string, unknown>;
  assignedVehicleId?: string;
  transitionedStatus?: string;
  adjustment?: Record<string, unknown>;
  internalNote?: string;
};

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function installRentalApiMock(page: Page) {
  const trace: Trace = {};
  let brands = [{ id: "brand-li", name: "理想", logoUrl: "/api/admin/car-rental/media/logo-li", initial: "L", isHot: true, sortOrder: 100, isActive: true, modelCount: 1, activeVehicleCount: 1 }];
  let models = [{ id: "model-li-l7", brandId: "brand-li", brandName: "理想", name: "理想 L7", coverImageUrl: "/api/admin/car-rental/media/model-l7", bodyType: "suv", energyType: "range_extended", transmission: "single_speed", seats: 5, luggage: 3, sortOrder: 100, isActive: true, activeVehicleCount: 1, images: [{ id: "image-l7", url: "/api/admin/car-rental/media/model-l7", sortOrder: 0, isCover: true }] }];
  let stores = [{ id: "store-tj", name: "天津南开旗舰店", district: "南开区", address: "天津市南开区红旗路 219 号", latitude: 39.123, longitude: 117.16, openHours: "08:00-20:00", phone: "022-88886666", isActive: true, sortOrder: 100, deliveryBaseFeeFen: 2900, deliveryIncludedKm: 3, deliveryPerKmFen: 600, deliveryMaxRadiusKm: 20, activeVehicleCount: 1 }];
  let vehicles = [
    { id: "vehicle-l7-1", stockNo: "RT-L7-001", modelId: "model-li-l7", modelName: "理想 L7", storeId: "store-tj", storeName: "天津南开旗舰店", plateMasked: "津A·***01", color: "银灰色", modelYear: 2025, status: "active", mileageKm: 12600 },
    { id: "vehicle-l7-2", stockNo: "RT-L7-002", modelId: "model-li-l7", modelName: "理想 L7", storeId: "store-tj", storeName: "天津南开旗舰店", plateMasked: "津A·***02", color: "黑色", modelYear: 2025, status: "active", mileageKm: 9800 },
  ];
  let rates = [{ id: "rate-l7", modelId: "model-li-l7", modelName: "理想 L7", storeId: null, storeName: null, weekdayRateFen: 49800, weekendRateFen: 57300, basicProtectionDailyFen: 6000, prepFeeFen: 3500, optionalProtectionDailyFen: 6000, vehicleDepositFen: 800000, violationDepositFen: 200000, includedMileageKmPerDay: 300, overagePerKmFen: 100, fuelPolicy: "同油量或同电量归还", cancellationPolicy: "取车前24小时可免费取消", isActive: true }];
  let overrides: Array<Record<string, unknown>> = [];
  let order = { id: "rental-order-1", orderNo: "CR202608220001", status: "confirmed", driverName: "演示驾驶员", driverPhoneMasked: "138****8000", serviceMode: "store_pickup", storeId: "store-tj", store: { id: "store-tj", name: "天津南开旗舰店" }, modelId: "model-li-l7", model: { id: "model-li-l7", name: "理想 L7" }, pickupAt: "2026-08-24T10:00:00+08:00", returnAt: "2026-08-27T10:00:00+08:00", billableDays: 3, feeBreakdown: { vehicleRentFen: 149400, basicProtectionFen: 18000, prepFeeFen: 3500, optionalProtectionFen: 0, deliveryFeeFen: 0, adjustmentFen: 0, payableFen: 170900 }, deposits: { vehicleDepositFen: 800000, violationDepositFen: 200000 }, assignedVehicle: null as null | { id: string; stockNo: string; plateMasked: string }, internalNote: "", adjustments: [] as Array<Record<string, unknown>>, events: [{ id: "event-1", status: "confirmed", note: "模拟支付已确认", createdAt: "2026-08-22T10:00:00+08:00" }] };

  const fulfill = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ data }) });
  await page.route("**/api/admin/stations", (route) => fulfill(route, []));
  await page.route("**/api/admin/inspection-price-plans", (route) => fulfill(route, []));
  await page.route("**/api/admin/car-rental/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/admin/car-rental", "");
    const method = request.method();
    if (path.startsWith("/media/") && method === "GET") return route.fulfill({ status: 200, contentType: "image/png", body: pixel });
    if (path === "/brands" && method === "GET") return fulfill(route, brands);
    if (path === "/models" && method === "GET") return fulfill(route, models);
    if (path === "/models/model-li-l7" && method === "GET") return fulfill(route, models[0]);
    if (/^\/brands\/[^/]+$/.test(path) && method === "PUT") {
      trace.brandPut = request.postDataJSON();
      brands = brands.map((item) => item.id === path.split("/")[2] ? { ...item, ...trace.brandPut } as typeof item : item);
      return fulfill(route, brands[0]);
    }
    if (/^\/brands\/[^/]+\/logo$/.test(path) && method === "POST") {
      trace.brandLogoContentType = request.headers()["content-type"];
      return fulfill(route, brands[0], 201);
    }
    if (/^\/models\/[^/]+$/.test(path) && method === "PUT") {
      const body = request.postDataJSON();
      models = models.map((item) => item.id === path.split("/")[2] ? { ...item, ...body } as typeof item : item);
      return fulfill(route, models[0]);
    }
    if (/^\/models\/[^/]+\/images$/.test(path) && method === "POST") {
      trace.modelImageContentType = request.headers()["content-type"];
      const image = { id: "image-l7-2", url: "/api/admin/car-rental/media/model-l7-2", sortOrder: 1, isCover: false };
      models[0].images = [...models[0].images, image];
      return fulfill(route, image, 201);
    }
    if (/^\/models\/[^/]+\/images$/.test(path) && method === "PUT") {
      const body = request.postDataJSON() as { images: Array<{ id: string; sortOrder: number; isCover: boolean }> };
      models[0].images = body.images.map((item) => ({ ...models[0].images.find((image) => image.id === item.id)!, ...item }));
      return fulfill(route, models[0].images);
    }
    if (/^\/models\/[^/]+\/images\/[^/]+$/.test(path) && method === "DELETE") return fulfill(route, { deleted: true });
    if (path === "/stores" && method === "GET") return fulfill(route, stores);
    if (/^\/stores\/[^/]+$/.test(path) && method === "PUT") {
      trace.storePut = request.postDataJSON();
      stores = stores.map((item) => item.id === path.split("/")[2] ? { ...item, ...trace.storePut } as typeof item : item);
      return fulfill(route, stores[0]);
    }
    if (path === "/vehicles" && method === "GET") return fulfill(route, vehicles);
    if (/^\/vehicles\/[^/]+\/retire$/.test(path) && method === "POST") {
      trace.retiredVehicleId = path.split("/")[2];
      vehicles = vehicles.map((item) => item.id === trace.retiredVehicleId ? { ...item, status: "retired" } : item);
      return fulfill(route, vehicles[0]);
    }
    if (path === "/rate-plans" && method === "GET") return fulfill(route, rates);
    if (/^\/rate-plans\/[^/]+$/.test(path) && method === "PUT") {
      trace.ratePut = request.postDataJSON();
      rates = rates.map((item) => item.id === path.split("/")[2] ? { ...item, ...trace.ratePut } as typeof item : item);
      return fulfill(route, rates[0]);
    }
    if (path === "/rate-overrides" && method === "GET") return fulfill(route, overrides);
    if (path === "/rate-overrides" && method === "POST") {
      trace.overridePost = request.postDataJSON();
      overrides = [{ id: "override-1", ...trace.overridePost }];
      return fulfill(route, overrides[0], 201);
    }
    if (path === "/orders" && method === "GET") return fulfill(route, { items: [order], total: 1 });
    if (path === `/orders/${order.id}` && method === "GET") return fulfill(route, order);
    if (path === `/orders/${order.id}/assign-vehicle` && method === "POST") {
      trace.assignedVehicleId = request.postDataJSON().vehicleId;
      const selected = vehicles.find((item) => item.id === trace.assignedVehicleId)!;
      order.assignedVehicle = { id: selected.id, stockNo: selected.stockNo, plateMasked: selected.plateMasked };
      return fulfill(route, order);
    }
    if (path === `/orders/${order.id}/transition` && method === "POST") {
      trace.transitionedStatus = request.postDataJSON().status;
      order.status = trace.transitionedStatus as typeof order.status;
      return fulfill(route, order);
    }
    if (path === `/orders/${order.id}/adjustments` && method === "POST") {
      trace.adjustment = request.postDataJSON();
      order.adjustments.push({ id: "adjustment-1", ...trace.adjustment });
      order.feeBreakdown.adjustmentFen = trace.adjustment.amountFen as number;
      return fulfill(route, order, 201);
    }
    if (path === `/orders/${order.id}/internal-note` && method === "PUT") {
      trace.internalNote = request.postDataJSON().internalNote;
      order.internalNote = trace.internalNote;
      return fulfill(route, order);
    }
    return fulfill(route, { message: `Unhandled rental mock ${method} ${path}` }, 404);
  });
  return trace;
}

test("汽车租赁品牌车型支持启停、车标和真实车型图片上传", async ({ page }) => {
  const trace = await installRentalApiMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "汽车租赁" }).click();
  await expect(page.getByRole("heading", { name: "平台自营汽车租赁中心" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "品牌车型" })).toHaveAttribute("aria-selected", "true");

  await page.getByLabel("编辑品牌 理想").click();
  await page.getByLabel("租赁热门品牌").uncheck();
  await page.getByLabel("租赁品牌标志").setInputFiles("../public/assets/inspection/vehicle-front.png");
  await page.getByRole("button", { name: "保存品牌" }).click();
  await expect.poll(() => trace.brandPut?.isHot).toBe(false);
  await expect.poll(() => trace.brandLogoContentType).toContain("multipart/form-data");
  expect(trace.brandLogoContentType).not.toContain("application/json");

  await page.getByLabel("编辑车型 理想 L7").click();
  await expect(page.getByRole("complementary", { name: "编辑租赁车型" })).toBeVisible();
  await page.getByLabel("上传租赁车型图片").setInputFiles("../public/assets/inspection/vehicle-front.png");
  await expect.poll(() => trace.modelImageContentType).toContain("multipart/form-data");
  await expect(page.getByText("第 2 张")).toBeVisible();
  await page.getByLabel("设为封面车型图片 2").click();
  await expect(page.locator(".used-car-image-grid figure.cover")).toHaveCount(1);
});

test("汽车租赁门店、车队、价格和订单具备运营维护闭环", async ({ page }) => {
  const trace = await installRentalApiMock(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "汽车租赁" }).click();

  await page.getByRole("tab", { name: "租赁门店" }).click();
  await expect(page.getByText("天津南开旗舰店", { exact: true })).toBeVisible();
  await page.getByLabel("编辑门店 天津南开旗舰店").click();
  await page.getByLabel("送取基础费用").fill("39");
  await page.getByRole("button", { name: "保存门店" }).click();
  await expect.poll(() => trace.storePut?.deliveryBaseFeeFen).toBe(3900);

  await page.getByRole("tab", { name: "车队车辆" }).click();
  await expect(page.getByText("RT-L7-001", { exact: true })).toBeVisible();
  await page.getByLabel("退役车辆 RT-L7-001").click();
  await expect.poll(() => trace.retiredVehicleId).toBe("vehicle-l7-1");

  await page.getByRole("tab", { name: "租赁价格" }).click();
  await page.getByLabel("编辑价格 理想 L7").click();
  await page.getByLabel("工作日日租价").fill("528");
  await expect(page.getByText(/3 天应付预览/)).toBeVisible();
  await page.getByRole("button", { name: "保存价格" }).click();
  await expect.poll(() => trace.ratePut?.weekdayRateFen).toBe(52800);
  await page.getByLabel("新增日期价格 理想 L7").click();
  await page.getByLabel("覆盖日租价").fill("688");
  await page.getByRole("button", { name: "保存日期价格" }).click();
  await expect.poll(() => trace.overridePost?.dailyRateFen).toBe(68800);

  await page.getByRole("tab", { name: "租车订单" }).click();
  await page.getByLabel("管理租车订单 CR202608220001").click();
  await page.getByLabel("订单分配车辆").selectOption("vehicle-l7-2");
  await page.getByRole("button", { name: "分配车辆" }).click();
  await expect.poll(() => trace.assignedVehicleId).toBe("vehicle-l7-2");
  await page.getByLabel("租车订单下一状态").selectOption("ready_for_pickup");
  await page.getByRole("button", { name: "推进状态" }).click();
  await expect.poll(() => trace.transitionedStatus).toBe("ready_for_pickup");
  await page.getByRole("textbox", { name: "租车订单附加费", exact: true }).fill("80");
  await page.getByLabel("租车订单附加费原因").fill("演示超时费用");
  await page.getByRole("button", { name: "登记附加费" }).click();
  await expect.poll(() => trace.adjustment?.amountFen).toBe(8000);
  await page.getByLabel("租车订单内部备注").fill("车辆已完成清洁与充电");
  await page.getByRole("button", { name: "保存内部备注" }).click();
  await expect.poll(() => trace.internalNote).toBe("车辆已完成清洁与充电");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
