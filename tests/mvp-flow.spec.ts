import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const E2E_API_BASE = process.env.E2E_API_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_API_PORT ?? 8787}/api`;

type E2eBooking = {
  id: string;
  fulfillmentStatus?: string;
  paymentStatus?: string;
  vehicle?: { plateNumber?: string };
};

function mockInspectionCalculation(overrides: Record<string, unknown> = {}) {
  return {
    source: "temporary",
    action: "claim_mark",
    windowStatus: "not_open",
    estimatedDueDate: "2028-08-31",
    applicationWindow: { start: "2028-06-01", end: "2028-08-31" },
    cycleYear: 2,
    canBookInspection: false,
    title: "办理窗口尚未开始",
    summary: "预计本轮需申领检验标志、无需上线，办理窗口将于2028-06-01开启。",
    reasons: [
      { code: "supported_vehicle_scope", label: "符合自动测算范围", detail: "车辆为9座及以下非营运小微型载客汽车。" },
      { code: "cycle_year_2", label: "命中检验周期规则", detail: "注册后第2年预计申领检验标志，无需上线检验。" },
    ],
    manualReviewReasons: [],
    evidence: {
      normalizedFacts: [
        { code: "registration_month", label: "注册月份", value: "2026-08", source: "temporary_input" },
        { code: "seats", label: "核定座位", value: "5座", source: "temporary_input" },
        { code: "usage_nature", label: "使用性质", value: "非营运", source: "temporary_input" },
        { code: "powertrain", label: "动力类型", value: "汽油", source: "temporary_input" },
      ],
      steps: [
        { id: "scope", title: "适用范围", expression: "5座 ∩ 非营运 ∩ 小微型载客汽车 ∩ 非面包车 ∩ 5项特殊情况均为否", result: "符合自动测算边界", sourceIds: ["joint_reform_2022"] },
        { id: "cycle", title: "周期节点", expression: "2026-08 + 第2年 = 2028-08", result: "第2年属于申领检验标志节点", sourceIds: ["joint_reform_2022"] },
        { id: "due_date", title: "有效期估算", expression: "2028年8月最后一天", result: "2028-08-31", sourceIds: ["joint_reform_2022"] },
        { id: "window", title: "办理窗口", expression: "到期月前2个自然月起", result: "2028-06-01 至 2028-08-31", sourceIds: ["joint_reform_2022"] },
        { id: "current_status", title: "当前结论", expression: "今天2026-08-17与办理窗口比较", result: "办理窗口尚未开始", sourceIds: ["joint_reform_2022"] },
      ],
      assumptions: ["规则估算基于当前填写事实，并假设历史应检均已按期办理；车辆真实检验记录以交管12123为准。"],
      powertrainImpact: {
        powertrainType: "gasoline",
        affectsCycle: false,
        status: "not_applicable_this_cycle",
        expectedOnsiteCheckCodes: ["safety_basic", "emissions_gasoline"],
        explanation: "你的车是汽油车。动力类型不改变检验周期；本轮无需上线，因此不会增加本轮检验项目。",
        sourceIds: ["joint_reform_2022"],
      },
    },
    dateEvidence: {
      estimate: { dueDate: "2028-08-31", basis: "policy_estimate" },
      confirmation: null,
      comparison: "not_provided",
      decisionBasis: "policy_estimate",
      explanation: "当前仅有政策规则估算。",
    },
    policy: {
      id: "cn-small-micro-passenger-inspection-2022",
      version: "2022-10-01.v1",
      effectiveFrom: "2022-10-01",
      reviewedAt: "2026-08-16",
      sources: [{ id: "joint_reform_2022", title: "四部门车检制度改革意见", issuer: "四部门", topics: ["inspection_cycle"], url: "https://www.mee.gov.cn/xxgk2018/xxgk/xxgk10/202209/t20220920_994430.html" }],
    },
    disclaimer: "本结果依据公开规则进行政策测算，不是政务实时查询。",
    ...overrides,
  };
}

async function adminBookings(page: Page) {
  const response = await page.request.get(`${E2E_API_BASE}/admin/bookings`);
  expect(response.ok()).toBe(true);
  return (await response.json()).data as E2eBooking[];
}

function currentFlow(page: Page) {
  // AnimatePresence may keep an exiting scene mounted briefly with its former
  // test id. The newest scene is the authoritative interactive route.
  return page.getByTestId("flow-current").last();
}

async function openMvp(page: Page) {
  await page.goto("/");
  await expect(currentFlow(page).getByTestId("home-page")).toBeVisible();
  await expect(currentFlow(page).getByTestId("vehicle-hero")).toBeVisible();
}

async function openAddVehicle(page: Page) {
  await openMvp(page);
  await page.getByRole("button", { name: /管理车辆|我的车辆/ }).first().click();
  await expect(page.getByTestId("flow-fixed-header").getByText("我的车辆", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /新增车辆/ }).click();
  await expect(page.getByTestId("flow-fixed-header").getByText("添加车辆", { exact: true })).toBeVisible();
  await expect(page.getByTestId("plate-province-trigger")).toBeVisible();
}

async function chooseProvince(page: Page, province: string) {
  await page.getByTestId("plate-province-trigger").click();
  await expect(page.getByText("选择省份", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^选择省份 / })).toHaveCount(31);
  await page.getByRole("button", { name: `选择省份 ${province}`, exact: true }).click();
  await expect(page.getByText("选择发牌机关", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择发牌机关 A", exact: true }).click();
  await expect(page.getByText("输入车牌序号", { exact: true })).toBeVisible();
  await expect(page.getByTestId("plate-input-0")).toHaveAttribute("data-value", province);
  await expect(page.getByTestId("plate-input-1")).toHaveAttribute("data-value", "A");
}

async function typePlateCharacters(page: Page, startIndex: number, characters: string[]) {
  const serialKeyboard = page.getByText("输入车牌序号", { exact: true });
  if (!(await serialKeyboard.isVisible().catch(() => false))) {
    await page.getByTestId(`plate-input-${startIndex}`).click();
    await expect(serialKeyboard).toBeVisible();
  }
  for (const character of characters) {
    await page.getByRole("button", { name: `输入 ${character}`, exact: true }).click();
  }
  await page.getByRole("button", { name: "完成", exact: true }).click();
}

async function expectPlateSlot(page: Page, index: number, value: string) {
  await expect(page.getByTestId(`plate-input-${index}`)).toHaveAttribute("data-value", value);
}

async function expectPlateSlotCount(page: Page, count: number) {
  await expect(page.locator('[data-testid^="plate-input-"]')).toHaveCount(count);
}

async function returnToConsumerHome(page: Page) {
  for (let index = 0; index < 6; index += 1) {
    const homeNav = page.getByTestId("owner-nav-home");
    if (await homeNav.isVisible().catch(() => false)) {
      if (!(await currentFlow(page).getByTestId("home-page").isVisible().catch(() => false))) await homeNav.click();
      await expect(currentFlow(page).getByTestId("home-page")).toBeVisible();
      return;
    }
    const back = page.getByTestId("flow-fixed-header").getByRole("button", { name: "返回", exact: true });
    if (!(await back.isVisible().catch(() => false))) break;
    await back.click();
    await page.waitForTimeout(450);
  }
  await expect(page.getByTestId("owner-nav-home")).toBeVisible();
  await page.getByTestId("owner-nav-home").click();
  await expect(currentFlow(page).getByTestId("home-page")).toBeVisible();
}

async function switchToOperator(page: Page) {
  if (await page.getByTestId("operator-workbench").isVisible().catch(() => false)) return;
  await returnToConsumerHome(page);
  await page.getByTestId("owner-nav-profile").click();
  await expect(page.getByTestId("consumer-profile-page")).toBeVisible();
  await page.getByTestId("profile-demo-tools").click();
  await page.getByTestId("role-switch-operator").click();
  await expect(page.getByTestId("operator-workbench")).toBeVisible();
  await expect(page.getByTestId("operator-nav-workbench")).toHaveAttribute("aria-current", "page");
}

async function switchToConsumer(page: Page) {
  if (await currentFlow(page).getByTestId("home-page").isVisible().catch(() => false)) return;
  const detailBack = page.getByRole("button", { name: "返回", exact: true });
  if (await detailBack.isVisible().catch(() => false)) await detailBack.click();
  await currentFlow(page).getByTestId("demo-menu-trigger").click();
  await page.getByTestId("role-switch-consumer").click();
  await expect(currentFlow(page).getByTestId("home-page")).toBeVisible();
}

async function selectDefaultOperatorScope(page: Page) {
  const response = await page.request.get(`${E2E_API_BASE}/operator/workbench`);
  expect(response.ok()).toBe(true);
  const workbench = (await response.json()).data as { businessDate: string; station: { id: string } };
  await page.getByLabel("选择检测站").selectOption(workbench.station.id);
  await page.getByLabel("选择预约日期").fill(workbench.businessDate);
}

async function createConsumerBooking(page: Page) {
  const previousIds = new Set((await adminBookings(page)).map((booking) => booking.id));
  await openMvp(page);
  await page.getByTestId("inspection-stage-entry-booking").click();
  await page.getByTestId("inspection-stage-primary").click();
  await expect(page.getByText("选择检测站", { exact: true })).toBeVisible();
  await page.locator(".station-card").filter({ hasText: "海河机动车检测服务中心（演示）" }).click();
  await expect(page.getByTestId("flow-fixed-header").getByText("站点与时段", { exact: true })).toBeVisible();

  const availableSlot = page.getByRole("button", { name: /^\d{2}:\d{2}.*余 \d+ 位/ }).first();
  await expect(availableSlot).toBeEnabled();
  await availableSlot.click();
  await page.getByRole("button", { name: "确认时段，下一步" }).click();
  await expect(page.getByTestId("booking-form")).toBeVisible();
  await page.waitForTimeout(550);
  for (const kind of ["vehicle_front_left", "vehicle_front_right", "vehicle_rear_left", "vehicle_rear_right", "dashboard_started", "license_front", "license_back"]) {
    await page.getByTestId(`media-${kind}`).locator('input[type="file"]').setInputFiles("public/assets/inspection/vehicle-front.png");
    await expect(page.getByTestId(`media-${kind}`).locator("img")).toBeVisible();
  }
  const submit = page.getByRole("button", { name: /提交预约/ });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId("mock-payment-page")).toBeVisible();
  await expect(page.getByText("订单待支付", { exact: true })).toBeVisible();
  await expect(page.getByText("模拟支付不会扣款", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /确认模拟支付/ }).click();
  await expect(page.getByTestId("consumer-order-detail")).toBeVisible();
  await expect(page.getByTestId("consumer-order-detail").getByRole("heading", { name: "预约已确认" })).toBeVisible();

  const created = (await adminBookings(page)).find((booking) => !previousIds.has(booking.id));
  expect(created).toBeTruthy();
  expect(created?.paymentStatus).toBe("paid");
  expect(created?.fulfillmentStatus).toBe("confirmed");
  return created!.id;
}

test.describe("上海时区预约时段防过期", () => {
  test("洗车当天已过时段禁用，已选时段跨过开始时间后确认失效", async ({ page }) => {
    const bookingDate = "2026-08-20";
    await page.clock.setFixedTime(new Date("2026-08-20T01:59:00.000Z"));
    await page.route("**/api/wash/stores/*/slots?**", async (route) => {
      const url = new URL(route.request().url());
      const storeId = url.pathname.split("/").at(-2) || "wash-store-haihe-demo";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [
          { id: `${storeId}-past`, storeId, date: bookingDate, startTime: "09:00", endTime: "09:30", capacity: 4, reservedCount: 0, remaining: 4, isOpen: true },
          { id: `${storeId}-boundary`, storeId, date: bookingDate, startTime: "10:00", endTime: "10:30", capacity: 4, reservedCount: 0, remaining: 4, isOpen: true },
          { id: `${storeId}-future`, storeId, date: bookingDate, startTime: "11:00", endTime: "11:30", capacity: 4, reservedCount: 0, remaining: 4, isOpen: true },
        ] }),
      });
    });

    await openMvp(page);
    await page.getByTestId("wash-entry-service").click();
    const pastSlot = page.getByTestId("wash-slot-09:00");
    const boundarySlot = page.getByTestId("wash-slot-10:00");
    await expect(pastSlot).toBeDisabled();
    await expect(pastSlot).toContainText("已过时段");
    await expect(boundarySlot).toBeEnabled();
    await boundarySlot.click();
    await expect(page.getByTestId("wash-confirm-booking")).toBeEnabled();

    await page.clock.setFixedTime(new Date("2026-08-20T02:00:00.000Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(boundarySlot).toBeDisabled();
    await expect(boundarySlot).toContainText("已过时段");
    await expect(page.getByTestId("wash-confirm-booking")).toBeDisabled();
    await page.getByTestId("wash-slot-11:00").click();
    await expect(page.getByTestId("wash-confirm-booking")).toBeEnabled();
  });

  test("年检当天已过时段禁用，确认页跨时后阻止提交", async ({ page }) => {
    const bookingDate = "2026-08-20";
    await page.clock.setFixedTime(new Date("2026-08-20T01:59:00.000Z"));
    await page.route("**/api/stations/*/slots*", async (route) => {
      const url = new URL(route.request().url());
      const stationId = url.pathname.split("/").at(-2) || "station-hexi-1";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [
          { id: `${stationId}-past`, stationId, date: bookingDate, startTime: "09:00", endTime: "09:30", capacity: 6, remaining: 4 },
          { id: `${stationId}-boundary`, stationId, date: bookingDate, startTime: "10:00", endTime: "10:30", capacity: 6, remaining: 4 },
          { id: `${stationId}-future`, stationId, date: bookingDate, startTime: "11:00", endTime: "11:30", capacity: 6, remaining: 4 },
        ] }),
      });
    });

    await openMvp(page);
    await page.getByRole("button", { name: /在线预约.*选择时间网点/ }).click();
    await page.getByRole("button", { name: "选择检测站与时间", exact: true }).click();
    await expect(page.getByText("选择检测站", { exact: true })).toBeVisible();
    await page.locator(".station-card").first().click();
    const pastSlot = page.getByTestId("inspection-slot-09:00");
    const boundarySlot = page.getByTestId("inspection-slot-10:00");
    await expect(pastSlot).toBeDisabled();
    await expect(pastSlot).toContainText("已过时段");
    await expect(boundarySlot).toBeEnabled();
    await boundarySlot.click();
    await page.getByRole("button", { name: "确认时段，下一步" }).click();
    await expect(page.getByTestId("booking-form")).toBeVisible();

    await page.clock.setFixedTime(new Date("2026-08-20T02:00:00.000Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("所选时段已过，请返回重新选择", { exact: true })).toBeVisible();
    await expect(page.getByTestId("booking-submit")).toBeDisabled();
    await expect(page.getByTestId("booking-submit")).toContainText("时段已过，请重选");
  });
});

test.describe("驭小满洗车人工报码闭环", () => {
  test("canonical 洗车价类保存后不会保留历史合并档提示", () => {
    const source = readFileSync(new URL("../src/Prototype.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/washVehicleCategoryLegacy:\s*rawWashCategory === "suv_mpv"/);
    expect(source).not.toMatch(/washVehicleCategoryLegacy:\s*Boolean\(raw\.washVehicleCategoryLegacy/);
    expect(source).toMatch(/mpv:\s*\[5800, 12800\]/);
  });

  test("切换小轿车、SUV、MPV 时只读取服务端对应价类且价格不串档", async ({ page }) => {
    const categories: string[] = [];
    let slotRequestCount = 0;
    const prices: Record<string, number> = { sedan: 3800, suv: 4800, mpv: 5800 };
    const vehicles = [
      { id: "wash-veh-sedan", plateNumber: "津A·S3800", vehicleType: "小型轿车", usageNature: "非营运", seats: 5, registrationDate: "2020-01-01", inspectionDueDate: "2027-08-31", isDefault: true, powertrainType: "gasoline", isVan: false, washVehicleCategory: "sedan" },
      { id: "wash-veh-suv", plateNumber: "津B·V4800", vehicleType: "小型SUV", usageNature: "非营运", seats: 7, registrationDate: "2021-01-01", inspectionDueDate: "2027-08-31", isDefault: false, powertrainType: "gasoline", isVan: false, washVehicleCategory: "suv" },
      { id: "wash-veh-mpv", plateNumber: "津C·M5800", vehicleType: "MPV / 多用途乘用车", usageNature: "非营运", seats: 7, registrationDate: "2022-01-01", inspectionDueDate: "2027-08-31", isDefault: false, powertrainType: "gasoline", isVan: false, washVehicleCategory: "mpv" },
    ];
    const store = { id: "wash-store-category-test", name: "三档价类演示门店（演示）", district: "河西区", address: "天津市河西区演示地址", openHours: "09:00–20:00", isActive: true, isOpen: true };

    await page.route("**/api/vehicles", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: vehicles }) }));
    await page.route("**/api/wash/stores", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [store] }) }));
    await page.route("**/api/wash/stores/*/offers?**", async (route) => {
      const category = new URL(route.request().url()).searchParams.get("vehicleCategory") || "";
      categories.push(category);
      const priceFen = prices[category];
      expect(priceFen, `unexpected wash vehicle category: ${category}`).toBeTruthy();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{
        storeId: store.id,
        packageId: "wash-package-standard-test",
        vehicleCategory: category,
        salePriceFen: priceFen,
        listPriceFen: priceFen + 1000,
        isAvailable: true,
        package: { id: "wash-package-standard-test", code: "standard", name: "标准洗", subtitle: "日常快速焕新", serviceItems: ["车身清洗", "轮毂清洁"], durationMinutes: 35 },
      }] }) });
    });
    await page.route("**/api/wash/stores/*/slots?**", async (route) => {
      slotRequestCount += 1;
      const url = new URL(route.request().url());
      const date = url.searchParams.get("date") || "2026-08-22";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: `wash-slot-${date}`, storeId: store.id, date, startTime: "23:59", endTime: "23:59", capacity: 4, remaining: 4, isOpen: true }] }) });
    });
    await page.route("**/api/wash/quotes", async (route) => {
      const body = route.request().postDataJSON() as Record<string, string>;
      categories.push(body.vehicleCategory);
      const washFeeFen = prices[body.vehicleCategory];
      expect(washFeeFen, `unexpected quote category: ${body.vehicleCategory}`).toBeTruthy();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        quoteSnapshotId: `quote-${body.vehicleCategory}`,
        expiresAt: "2026-08-22T12:30:00.000Z",
        serviceType: "car_wash",
        ...body,
        serviceMode: "self_drive",
        serviceable: true,
        salePriceFen: washFeeFen,
        listPriceFen: washFeeFen + 1000,
        washFeeFen,
        valetFeeFen: 0,
        totalFeeFen: washFeeFen,
        serviceFeeFen: washFeeFen,
      } }) });
    });

    await openMvp(page);
    await page.getByTestId("wash-entry-service").click();
    const standard = page.getByTestId("wash-package-standard");
    await expect(page.getByText("小轿车价格", { exact: true })).toBeVisible();
    await expect(standard).toContainText("¥38");
    await expect(page.getByTestId("wash-slot-23:59")).toBeVisible();
    await expect(page.getByTestId("wash-confirm-booking")).toBeEnabled();
    const sedanSlotRequests = slotRequestCount;

    await page.getByTestId("wash-vehicle-selector").click();
    await page.getByTestId("wash-vehicle-option-wash-veh-suv").click();
    await expect(page.getByText("SUV价格", { exact: true })).toBeVisible();
    await expect(standard).toContainText("¥48");
    await expect.poll(() => slotRequestCount).toBeGreaterThan(sedanSlotRequests);
    await expect(page.getByTestId("wash-slot-23:59")).toBeVisible();
    await expect(page.getByTestId("wash-confirm-booking")).toBeEnabled();
    const suvSlotRequests = slotRequestCount;

    await page.getByTestId("wash-vehicle-selector").click();
    await page.getByTestId("wash-vehicle-option-wash-veh-mpv").click();
    await expect(page.getByText("MPV价格", { exact: true })).toBeVisible();
    await expect(standard).toContainText("¥58");
    await expect.poll(() => slotRequestCount).toBeGreaterThan(suvSlotRequests);
    await expect(page.getByTestId("wash-slot-23:59")).toBeVisible();
    await expect(page.getByTestId("wash-confirm-booking")).toBeEnabled();
    expect(categories).toEqual(expect.arrayContaining(["sedan", "suv", "mpv"]));
    expect(categories).not.toContain("suv_mpv");
  });

  test("洗车可选择代驾取送并展示真实单程路线与往返费用", async ({ page }) => {
    const pickupAddress = {
      poiId: "wash-pickup-tencent-1",
      title: "天津文化中心地下停车场",
      address: "天津市河西区平江道 58 号",
      district: "河西区",
      latitude: 39.0837,
      longitude: 117.2197,
      source: "tencent",
    };
    await page.route("**/api/locations/suggestions?**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [pickupAddress], meta: { source: "tencent", notice: "地址结果来自腾讯位置服务" } }) });
    });
    await page.route("**/api/wash/quotes", async (route) => {
      const body = route.request().postDataJSON() as Record<string, any>;
      expect(body.serviceMode).toBe("valet");
      expect(body.tripType).toBe("round_trip_same_address");
      expect(body.pickupAddress.poiId).toBe(pickupAddress.poiId);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: {
          quoteSnapshotId: "wash-valet-quote-test",
          expiresAt: "2026-08-19T12:30:00.000Z",
          serviceType: "car_wash",
          vehicleId: body.vehicleId,
          storeId: body.storeId,
          packageId: body.packageId,
          slotId: body.slotId,
          vehicleCategory: body.vehicleCategory,
          serviceMode: "valet",
          tripType: "round_trip_same_address",
          serviceable: true,
          salePriceFen: 3800,
          listPriceFen: 4800,
          washFeeFen: 3800,
          valetFeeFen: 7100,
          totalFeeFen: 10900,
          serviceFeeFen: 10900,
          pickupAddress,
          oneWayDistanceKm: 6.4,
          roundTripDistanceKm: 12.8,
          billableDistanceKm: 6.4,
          driveMinutes: 21,
          extraKm: 2,
          distanceSource: "tencent_matrix",
          distanceBasis: "driving_route",
          valetRule: { scope: "global", storeId: null, baseFeeFen: 5900, includedKm: 5, perKmFen: 600, maxRadiusKm: 20, version: "wash-valet-v1" },
          breakdown: { washFeeFen: 3800, valetBaseFeeFen: 5900, valetDistanceFeeFen: 1200, valetFeeFen: 7100, totalFeeFen: 10900 },
        } }),
      });
    });

    await openMvp(page);
    await page.getByTestId("wash-entry-service").click();
    await expect(page.getByTestId("wash-mode-self-drive")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("wash-mode-valet").click();
    await page.getByPlaceholder("例如：天津文化中心").fill("天津文化中心");
    await page.getByRole("button", { name: /天津文化中心地下停车场/ }).click();
    await page.getByTestId("wash-pickup-confirm").click();

    await expect(page.getByTestId("wash-valet-quote")).toContainText("单程 6.4 km · 约 21 分钟");
    await expect(page.getByTestId("wash-valet-quote")).toContainText("返程已包含");
    await expect(page.getByTestId("wash-valet-quote")).toContainText("+¥71");
    await expect(page.getByText("洗车 ¥38 + 代驾 ¥71", { exact: true })).toBeVisible();
    await expect(page.getByTestId("wash-confirm-booking")).toBeEnabled();
  });

  test("预约支付后生成六位码，取消退款后核销码立即失效", async ({ page }) => {
    await openMvp(page);
    await page.getByTestId("wash-entry-service").click();
    await expect(page.getByTestId("wash-booking-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "今天，把车洗干净" })).toBeVisible();
    await expect(page.getByTestId("wash-store-selector")).toContainText("（演示）");

    const confirmBooking = page.getByTestId("wash-confirm-booking");
    await expect(confirmBooking).toBeEnabled();
    await confirmBooking.click();
    await expect(page.getByTestId("wash-mock-payment-page")).toBeVisible();
    await expect(page.getByTestId("wash-redemption-code")).toHaveCount(0);

    await page.getByRole("button", { name: /确认模拟支付/ }).click();
    await expect(page.getByTestId("wash-payment-success")).toBeVisible();
    await expect(page.getByTestId("wash-redemption-code").locator("strong")).toHaveText(/^\d{3} \d{3}$/);
    await expect(page.getByText("仅限本订单使用一次", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "查看洗车订单", exact: true }).click();
    await expect(page.getByTestId("wash-order-detail")).toBeVisible();
    await expect(page.getByRole("heading", { name: "待核销", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消预约", exact: true }).click();
    await expect(page.getByText("取消后会完成模拟退款，六位核销码立即失效。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "确认取消", exact: true }).click();

    await expect(page.getByRole("heading", { name: "已退款", exact: true })).toBeVisible();
    await expect(page.getByText("该订单的核销码已失效", { exact: true })).toBeVisible();
    await expect(page.getByTestId("wash-redemption-code")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "再次预约", exact: true })).toBeVisible();
  });
});

test.describe("驭小满年检 MVP", () => {
  test("首页在 iPhone 与 Pixel 10 均保留品牌 Hero 和年检主入口", async ({ page }) => {
    await openMvp(page);

    await expect(page.getByTestId("device-screen")).toHaveAttribute("data-device", "iphone");
    await expect(page.getByText("驭小满", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "当前城市天津" })).toBeVisible();
    await expect(page.getByRole("img", { name: "天津城市天际线与白色轿车演示图" })).toBeVisible();
    await expect(page.getByText("津A·MVP26", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /立即预约/ })).toBeVisible();
    await expect(page.getByTestId("hero-date-evidence")).toContainText(/规则估算有效期止|用户确认有效期止|日期待核验/);
    await expect(page.getByTestId("hero-date-evidence")).not.toContainText("年检到期日");
    await expect(page.getByTestId("owner-bottom-nav")).toBeVisible();
    await expect(page.getByTestId("owner-nav-home")).toHaveAttribute("aria-current", "page");

    await page.getByTestId("device-picker").click();
    await page.getByTestId("device-option-pixel-10").click();
    await expect(page.getByTestId("device-screen")).toHaveAttribute("data-device", "pixel-10");
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByText("驭小满", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /立即预约/ })).toBeVisible();
    await expect(page.getByTestId("owner-bottom-nav")).toBeVisible();

    await page.getByTestId("device-picker").click();
    await page.getByTestId("device-option-iphone").click();
    await expect(page.getByTestId("device-screen")).toHaveAttribute("data-device", "iphone");

    await page.getByTestId("owner-nav-profile").click();
    await expect(page.getByTestId("consumer-profile-page")).toBeVisible();
    await page.getByTestId("profile-demo-tools").click();
    await expect(page.getByText("持久化数据保护已开启", { exact: true })).toBeVisible();
    await expect(page.getByText(/当前环境不提供数据库重置入口/)).toBeVisible();
    await expect(page.getByRole("button", { name: /恢复.*演示数据|重置/ })).toHaveCount(0);
  });

  test("首页立即预约与查询年检保持分工，二级流程不显示根导航", async ({ page }) => {
    await openMvp(page);

    await page.getByTestId("inspection-entry-booking").click();
    await expect(page.getByTestId("flow-fixed-header").getByText("选择检测站", { exact: true })).toBeVisible();
    await expect(page.locator(".station-card").first()).toBeVisible();
    await expect(page.getByTestId("owner-bottom-nav")).toHaveCount(0);
    await page.getByTestId("flow-fixed-header").getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByTestId("home-page")).toBeVisible();

    for (const entry of ["inspection-entry-query", "inspection-entry-service"]) {
      await page.getByTestId(entry).click();
      await expect(page.getByTestId("flow-fixed-header").getByText("年检查询", { exact: true })).toBeVisible();
      await expect(page.getByTestId("inspection-page")).toBeVisible();
      await expect(page.getByTestId("owner-bottom-nav")).toHaveCount(0);
      await page.getByTestId("flow-fixed-header").getByRole("button", { name: "返回", exact: true }).click();
      await expect(page.getByTestId("home-page")).toBeVisible();
    }

    await expect(page.getByTestId("owner-bottom-nav")).toBeVisible();
  });

  test("车辆有效期仅接受结构化确认或带确认时间的可信平铺兼容数据", async ({ page }) => {
    const vehicle = (id: string, plateNumber: string, extra: Record<string, unknown>) => ({
      id,
      plateNumber,
      vehicleType: "小型轿车",
      usageNature: "非营运",
      seats: 5,
      registrationDate: "2020-08-28",
      inspectionDueDate: "2026-08-31",
      powertrainType: "gasoline",
      isVan: false,
      isDefault: id === "structured-unconfirmed",
      ...extra,
    });
    await page.route("**/api/vehicles", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [
          vehicle("structured-unconfirmed", "津A·UN001", { inspectionValidity: { mode: "unconfirmed" }, inspectionDueDateSource: "traffic_12123", inspectionDueDateConfirmedAt: "2026-08-01T00:00:00.000Z" }),
          vehicle("flat-without-time", "津A·UN002", { inspectionDueDateSource: "traffic_12123", inspectionDueDateConfirmedAt: null }),
          vehicle("flat-trusted", "津A·OK003", { inspectionDueDateSource: "electronic_driving_license", inspectionDueDateConfirmedAt: "2026-08-01T00:00:00.000Z" }),
        ] }),
      });
    });

    await openMvp(page);
    await page.getByRole("button", { name: /管理车辆|我的车辆/ }).first().click();
    await expect(page.getByTestId("vehicle-date-evidence-structured-unconfirmed")).toContainText("规则估算有效期止");
    await expect(page.getByTestId("vehicle-date-evidence-flat-without-time")).toContainText("规则估算有效期止");
    await expect(page.getByTestId("vehicle-date-evidence-flat-trusted")).toContainText("用户确认有效期止");
  });

  test("站点基础价格标为参考价，无法自动报价时引导联系现有客服", async ({ page }) => {
    await page.route("**/api/bookings/quote", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            serviceMode: "self_drive",
            vehiclePriceCategory: "fuel_small",
            inspectionFeeFen: 0,
            valetFeeFen: 0,
            serviceFeeFen: 0,
            distanceKm: null,
            pricingEligibility: "manual_review",
            reason: "manual_review",
            serviceable: false,
          },
        }),
      });
    });

    await openMvp(page);
    await page.getByTestId("inspection-entry-booking").click();
    const firstStation = page.locator(".station-card").first();
    await expect(firstStation).toBeVisible();
    await expect(firstStation.locator(".station-price")).toBeVisible();
    await expect(firstStation.locator(".station-price")).toContainText("年检参考价");
    await firstStation.click();

    const referencePrice = page.locator(".transparent-price");
    await expect(referencePrice).toContainText("年检服务参考价");
    await expect(referencePrice).toContainText("精确价格根据所选车辆在确认预约页计算");
    const availableSlot = page.getByRole("button", { name: /^\d{2}:\d{2}.*余 \d+ 位/ }).first();
    await expect(availableSlot).toBeEnabled();
    await availableSlot.click();
    await page.getByRole("button", { name: "确认时段，下一步" }).click();

    await expect(page.getByTestId("booking-form")).toBeVisible();
    await expect(page.locator(".quote-warning")).toContainText("该车型暂不支持在线报价，请联系客服");
    await expect(page.getByRole("button", { name: "等待人工确认车型" })).toHaveCount(0);
    const supportButton = page.getByRole("button", { name: "联系客服", exact: true });
    await expect(supportButton).toBeEnabled();
    await supportButton.click();
    await expect(page.getByRole("heading", { name: "年检专属客服", exact: true })).toBeVisible();
  });

  test("有效期冲突导致报价 409 时关闭自驾预约并引导核验", async ({ page }) => {
    await page.route("**/api/bookings/quote", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INSPECTION_VALIDITY_CONFLICT", message: "用户确认日期与规则估算不一致，请先核验" } }),
      });
    });

    await openMvp(page);
    await page.getByTestId("inspection-entry-booking").click();
    await page.locator(".station-card").first().click();
    const availableSlot = page.getByRole("button", { name: /^\d{2}:\d{2}.*余 \d+ 位/ }).first();
    await expect(availableSlot).toBeEnabled();
    await availableSlot.click();
    await page.getByRole("button", { name: "确认时段，下一步" }).click();

    await expect(page.getByTestId("quote-validity-conflict")).toContainText("有效期信息不一致，暂不能预约");
    await expect(page.getByTestId("quote-validity-conflict")).toContainText("用户确认日期与规则估算不一致，请先核验");
    await expect(page.getByTestId("booking-submit")).toBeDisabled();
    await expect(page.getByTestId("booking-submit")).toHaveText("请先核验有效期");
    await expect(page.getByTestId("quote-conflict-back-query")).toBeVisible();
    await expect(page.getByTestId("quote-conflict-official")).toBeVisible();
    await expect(page.locator(".booking-fee-card")).not.toContainText("计算中");

    await page.getByTestId("quote-conflict-back-query").click();
    await expect(page.getByTestId("flow-fixed-header").getByText("年检查询", { exact: true })).toBeVisible();
    await expect(page.getByTestId("inspection-page")).toBeVisible();
  });

  test("四个年检阶段入口各自打开上下文页，结果页不再跳订单中心", async ({ page }) => {
    await openMvp(page);

    for (const stage of ["booking", "arrival", "materials", "result"] as const) {
      await page.getByTestId(`inspection-stage-entry-${stage}`).click();
      const stagePage = currentFlow(page).getByTestId("inspection-stage-page");
      await expect(stagePage).toBeVisible();
      await expect(stagePage).toHaveAttribute("data-stage", stage);
      await expect(page.getByTestId("owner-bottom-nav")).toHaveCount(0);

      if (stage === "result") {
        await expect(page.getByTestId("consumer-orders-page")).toHaveCount(0);
        await expect(stagePage).toContainText(/交管\s*12123/);
        await expect(stagePage).not.toContainText(/电子检验合格标已领取|已同步交管/);
      }

      await page.getByTestId("flow-fixed-header").getByRole("button", { name: "返回", exact: true }).click();
      await expect(page.getByTestId("home-page")).toBeVisible();
    }
  });

  test("首页、订单、我的为三个一级 Tab，切换后保留同一根导航", async ({ page }) => {
    await openMvp(page);
    await expect(page.getByTestId("owner-nav-home")).toHaveAttribute("aria-current", "page");

    await page.getByTestId("owner-nav-orders").click();
    await expect(currentFlow(page).getByTestId("consumer-orders-page")).toBeVisible();
    await expect(page.getByTestId("owner-bottom-nav")).toBeVisible();
    await expect(page.getByTestId("owner-nav-orders")).toHaveAttribute("aria-current", "page");

    await page.getByTestId("owner-nav-profile").click();
    await expect(currentFlow(page).getByTestId("consumer-profile-page")).toBeVisible();
    await expect(page.getByTestId("owner-bottom-nav")).toBeVisible();
    await expect(page.getByTestId("owner-nav-profile")).toHaveAttribute("aria-current", "page");

    await page.getByTestId("owner-nav-home").click();
    await expect(currentFlow(page).getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("owner-nav-home")).toHaveAttribute("aria-current", "page");
  });

  test("临时测算无需车牌，并给出 2026-08 注册车辆的第 2 年办事窗口", async ({ page }) => {
    let postedBody: Record<string, any> | null = null;
    await page.route("**/api/inspection/calculations", async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, any>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: mockInspectionCalculation() }),
      });
    });

    await openMvp(page);
    await page.getByTestId("inspection-entry-hero").click();
    await page.getByTestId("inspection-mode-temporary").click();
    await expect(page.getByTestId("inspection-mode-temporary")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("inspection-registration-month").fill("2026-08");
    await page.getByTestId("inspection-vehicle-class").selectOption("small_micro_passenger");
    await page.getByTestId("inspection-usage-non-operational").click();
    await page.getByTestId("inspection-seats").selectOption("5");
    await expect(page.getByTestId("inspection-declaration-isVan-no")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("inspection-calculate").click();

    await expect(page.getByTestId("inspection-result")).toContainText("办理窗口尚未开始");
    await expect(page.getByTestId("inspection-result-due")).toHaveText("2028-08-31");
    await expect(page.getByTestId("inspection-result")).toContainText("临时测算");
    await expect(page.getByTestId("inspection-cta-save-vehicle")).toBeVisible();
    await expect(page.getByTestId("inspection-cta-book")).toHaveCount(0);
    expect(postedBody).toMatchObject({
      source: "temporary",
      vehicle: { registrationMonth: "2026-08", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5, powertrainType: "gasoline" },
      declarations: { isVan: "no" },
    });
    expect(postedBody).not.toHaveProperty("plateNumber");
  });

  test("结果默认展开五步推导，并说明油电混合只影响上线项目", async ({ page }) => {
    await page.route("**/api/inspection/calculations", async (route) => {
      const data = mockInspectionCalculation({
        evidence: {
          ...mockInspectionCalculation().evidence,
          normalizedFacts: [
            { code: "registration_month", label: "注册月份", value: "2026-08", source: "temporary_input" },
            { code: "seats", label: "核定座位", value: "5座", source: "temporary_input" },
            { code: "powertrain", label: "动力类型", value: "油电混合（非插电）", source: "temporary_input" },
          ],
          powertrainImpact: {
            powertrainType: "hybrid",
            affectsCycle: false,
            status: "not_applicable_this_cycle",
            expectedOnsiteCheckCodes: ["safety_basic", "emissions_gasoline"],
            explanation: "你的车是油电混合（非插电）。动力类型不改变检验周期；需要上线时仍有适用的汽油排放项目。",
            sourceIds: ["joint_reform_2022"],
          },
        },
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    });

    await openMvp(page);
    await page.getByTestId("inspection-entry-hero").click();
    await page.getByTestId("inspection-mode-temporary").click();
    await page.getByTestId("inspection-powertrain").selectOption("hybrid");
    await page.getByTestId("inspection-calculate").click();

    await expect.poll(() => page.getByTestId("device-screen").evaluate((screen) => screen.scrollTop)).toBe(0);
    await expect(page.getByTestId("inspection-evidence")).toContainText("车辆事实 → 公式 → 结果 → 政策来源");
    await expect(page.locator('[data-testid^="inspection-evidence-step-"]')).toHaveCount(5);
    await expect(page.getByTestId("inspection-evidence")).toContainText("2026-08 + 第2年 = 2028-08");
    await expect(page.getByTestId("inspection-powertrain-impact")).toContainText("油电混合（非插电）");
    await expect(page.getByTestId("inspection-powertrain-impact")).toContainText("周期不变，只影响上线项目");
    await expect(page.getByTestId("inspection-powertrain-impact")).toContainText("本轮只需申领检验标志、无需上线");
    await page.getByTestId("inspection-powertrain-comparison").getByText("查看全部动力类型对照").click();
    await expect(page.getByTestId("inspection-powertrain-comparison")).toContainText("纯电车免尾气排放检验，但不等于免年检");
  });

  test("临时有效期对照发现冲突后关闭普通预约", async ({ page }) => {
    let comparedValidity: Record<string, any> | null = null;
    const requestedValidityModes: string[] = [];
    await page.route("**/api/inspection/calculations", async (route) => {
      const requestBody = route.request().postDataJSON() as Record<string, any>;
      requestedValidityModes.push(requestBody.inspectionValidity?.mode || "missing");
      const base = mockInspectionCalculation();
      const confirmation = requestBody.inspectionValidity?.mode === "confirmed" ? requestBody.inspectionValidity : null;
      if (confirmation) comparedValidity = confirmation;
      const data = mockInspectionCalculation({
        action: confirmation ? "official_verification" : "onsite_inspection",
        windowStatus: confirmation ? "manual_review" : "open",
        estimatedDueDate: "2026-08-31",
        applicationWindow: { start: "2026-06-01", end: "2026-08-31" },
        cycleYear: 6,
        canBookInspection: !confirmation,
        title: confirmation ? "有效期信息不一致，请先核验" : "需要上线检验",
        summary: confirmation ? "用户确认月份与规则估算不一致，暂不开放普通预约。" : "当前已进入预计办理窗口。",
        dateEvidence: {
          estimate: { dueDate: "2026-08-31", basis: "policy_estimate" },
          confirmation: confirmation ? { validThroughMonth: confirmation.validThroughMonth, validThroughDate: `${confirmation.validThroughMonth}-30`, source: confirmation.source, confirmedAt: null } : null,
          comparison: confirmation ? "conflict" : "not_provided",
          decisionBasis: confirmation ? "official_verification" : "policy_estimate",
          explanation: confirmation ? "用户确认日期与规则估算不一致。" : "当前仅有政策规则估算。",
        },
        evidence: {
          ...base.evidence,
          powertrainImpact: { ...base.evidence.powertrainImpact, status: "applicable" },
        },
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    });

    await openMvp(page);
    await page.getByTestId("inspection-entry-hero").click();
    await page.getByTestId("inspection-mode-temporary").click();
    await page.getByTestId("inspection-calculate").click();
    await expect(page.getByTestId("inspection-cta-book")).toBeVisible();
    expect(requestedValidityModes).toEqual(["unconfirmed"]);

    await page.getByTestId("inspection-validity-compare").click();
    const quickForm = page.getByTestId("inspection-validity-quick-form");
    const validityMonth = quickForm.getByLabel("12123/行驶证显示的检验有效期至（月份）");
    const validitySource = page.getByTestId("inspection-validity-source");
    const compareButton = page.getByTestId("inspection-validity-submit");
    await expect(validityMonth).toHaveValue("");
    await expect(validitySource).toBeDisabled();
    await expect(compareButton).toBeDisabled();
    expect(requestedValidityModes).toEqual(["unconfirmed"]);

    await validityMonth.fill("2026-09");
    await expect(validitySource).toBeEnabled();
    await expect(validitySource).toHaveValue("");
    await expect(compareButton).toBeDisabled();
    expect(requestedValidityModes).toEqual(["unconfirmed"]);
    await validitySource.selectOption("electronic_driving_license");
    await expect(compareButton).toBeEnabled();
    expect(requestedValidityModes).toEqual(["unconfirmed"]);
    await compareButton.click();
    await expect(page.getByTestId("inspection-date-evidence")).toContainText("日期冲突，先核验");
    expect(requestedValidityModes).toEqual(["unconfirmed", "confirmed"]);
    expect(comparedValidity).toMatchObject({ mode: "confirmed", validThroughMonth: "2026-09", source: "electronic_driving_license" });
    await expect(page.getByTestId("inspection-cta-book")).toHaveCount(0);
    await expect(page.getByTestId("inspection-cta-official-check")).toBeVisible();

    await page.getByTestId("inspection-validity-use-estimate").click();
    await expect(page.getByTestId("inspection-date-evidence")).toContainText("仅规则估算");
    await expect(page.getByTestId("inspection-cta-book")).toBeVisible();
    await expect(page.getByTestId("inspection-validity-quick-form")).toHaveCount(0);
    expect(requestedValidityModes).toEqual(["unconfirmed", "confirmed", "unconfirmed"]);
  });

  test("年检测算接口缺失时静默回退共享本地规则", async ({ page }) => {
    let calculationRequests = 0;
    await page.route("**/api/inspection/calculations", async (route) => {
      calculationRequests += 1;
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "ROUTE_NOT_FOUND", message: "请求的接口不存在" } }),
      });
    });

    await openMvp(page);
    await page.getByTestId("inspection-entry-hero").click();
    await page.getByTestId("inspection-mode-temporary").click();
    await page.getByTestId("inspection-registration-month").fill("2026-08");
    await page.getByTestId("inspection-calculate").click();

    await expect(page.getByTestId("inspection-result")).toContainText("办理窗口尚未开始");
    await expect(page.getByTestId("inspection-result-due")).toHaveText("2028-08-31");
    await expect(page.getByTestId("inspection-cta-save-vehicle")).toBeVisible();
    await expect(page.getByText("请求的接口不存在", { exact: true })).toHaveCount(0);
    expect(calculationRequests).toBe(1);
  });

  test("车辆切换会丢弃旧请求，且上线检验与人工核验展示正确 CTA", async ({ page }) => {
    let requestCount = 0;
    await page.route("**/api/inspection/calculations", async (route) => {
      requestCount += 1;
      const body = route.request().postDataJSON() as Record<string, any>;
      if (requestCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: mockInspectionCalculation() }) });
        return;
      }
      const needsReview = body.declarations?.hasInjuryAccident === "yes";
      const data = needsReview
        ? mockInspectionCalculation({
            source: "vehicle",
            action: "official_verification",
            windowStatus: "manual_review",
            estimatedDueDate: null,
            applicationWindow: null,
            cycleYear: null,
            title: "需要交管或人工核验",
            summary: "伤亡事故记录可能影响免检，请先核验。",
            reasons: [{ code: "injury_accident", label: "伤亡事故记录影响免检", detail: "请以交管部门记录为准。" }],
            manualReviewReasons: ["存在需要核验的事故记录"],
          })
        : mockInspectionCalculation({
            source: "vehicle",
            action: "onsite_inspection",
            windowStatus: "open",
            estimatedDueDate: "2026-08-31",
            applicationWindow: { start: "2026-06-01", end: "2026-08-31" },
            cycleYear: 6,
            canBookInspection: true,
            title: "需要上线检验",
            summary: "当前已进入预计办理窗口。",
          });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    });

    await openMvp(page);
    await page.getByTestId("inspection-entry-hero").click();
    await page.getByTestId("inspection-mode-temporary").click();
    await page.getByTestId("inspection-calculate").click();
    await page.getByTestId("inspection-mode-vehicle").click();
    await page.getByTestId("inspection-calculate").click();

    await expect(page.getByTestId("inspection-result")).toContainText("需要上线检验");
    await expect(page.getByTestId("inspection-cta-book")).toBeVisible();
    await page.waitForTimeout(450);
    await expect(page.getByTestId("inspection-result")).toContainText("需要上线检验");

    await page.getByTestId("inspection-edit-query").click();
    await page.getByTestId("inspection-declaration-hasInjuryAccident-yes").click();
    await page.getByTestId("inspection-calculate").click();
    await expect(page.getByTestId("inspection-result")).toContainText("需要交管或人工核验");
    await expect(page.getByTestId("inspection-manual-review")).toContainText("为什么无法自动测算");
    await expect(page.getByTestId("inspection-evidence")).toHaveCount(0);
    await expect(page.getByTestId("inspection-cta-official-check")).toBeVisible();
    await expect(page.getByTestId("inspection-cta-support")).toBeVisible();
    await expect(page.getByTestId("inspection-cta-book")).toHaveCount(0);
  });

  test("蓝牌使用省份选择和 7 格专用键盘，并支持添加、编辑、删除", async ({ page }) => {
    const vehiclePatchPayloads: Record<string, any>[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH" && /\/api\/vehicles\/[^/]+$/.test(request.url())) {
        vehiclePatchPayloads.push(request.postDataJSON() as Record<string, any>);
      }
    });
    await openAddVehicle(page);

    await page.getByTestId("plate-type-blue").click();
    await expect(page.getByTestId("plate-type-blue")).toHaveAttribute("aria-pressed", "true");
    await expectPlateSlotCount(page, 7);
    await chooseProvince(page, "京");
    await expect(page.getByRole("button", { name: "输入 I", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "输入 O", exact: true })).toBeDisabled();

    // 表单默认保留发牌机关 A，只需通过专用键盘输入 5 位序号。
    await expectPlateSlot(page, 1, "A");
    await typePlateCharacters(page, 2, ["E", "2", "E", "0", "1"]);
    for (const [index, value] of ["京", "A", "E", "2", "E", "0", "1"].entries()) {
      await expectPlateSlot(page, index, value);
    }
    await page.getByTestId("vehicle-powertrain").selectOption("hybrid");
    await expect(page.getByTestId("vehicle-powertrain")).toHaveValue("hybrid");
    await page.getByLabel("我已看到检验有效期").check();
    const vehicleValidityMonth = page.getByTestId("vehicle-validity-card").getByLabel("12123/行驶证显示的检验有效期至（月份）");
    await expect(vehicleValidityMonth).toHaveValue("");
    await expect(page.getByTestId("vehicle-validity-source")).toBeDisabled();
    await vehicleValidityMonth.fill("2026-08");
    await expect(page.getByTestId("vehicle-validity-source")).toBeEnabled();
    await expect(page.getByTestId("vehicle-validity-source")).toHaveValue("");
    await page.getByTestId("vehicle-validity-source").selectOption("electronic_driving_license");

    await page.getByRole("button", { name: /确认保存/ }).click();
    const createdVehicle = page.getByRole("article").filter({ hasText: "京A·E2E01" });
    await expect(createdVehicle).toBeVisible();
    await expect(createdVehicle).toContainText("油电混合（非插电）");
    await expect(createdVehicle).toContainText("用户确认有效期止");

    await createdVehicle.getByRole("button", { name: /编辑/ }).click();
    await expect(page.getByTestId("flow-fixed-header").getByText("编辑车辆", { exact: true })).toBeVisible();
    await expectPlateSlotCount(page, 7);
    await expectPlateSlot(page, 0, "京");
    await expectPlateSlot(page, 6, "1");

    await page.getByTestId("plate-input-6").click();
    await page.getByRole("button", { name: "退格", exact: true }).click();
    await page.getByRole("button", { name: "输入 2", exact: true }).click();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expectPlateSlot(page, 6, "2");
    await page.getByRole("button", { name: /确认保存/ }).click();

    const editedVehicle = page.getByRole("article").filter({ hasText: "京A·E2E02" });
    await expect(editedVehicle).toBeVisible();
    expect(vehiclePatchPayloads.at(-1)?.inspectionValidity).toMatchObject({ mode: "confirmed", validThroughMonth: "2026-08", source: "electronic_driving_license" });

    await editedVehicle.getByRole("button", { name: /编辑/ }).click();
    await page.getByLabel("我已看到检验有效期").uncheck();
    await page.getByRole("button", { name: /确认保存/ }).click();
    await expect(editedVehicle).toBeVisible();
    expect(vehiclePatchPayloads.at(-1)?.inspectionValidity).toEqual({ mode: "unconfirmed" });

    await editedVehicle.getByRole("button", { name: /移除/ }).click();
    await expect(page.getByRole("button", { name: "确认移除" })).toBeVisible();
    await page.getByRole("button", { name: "确认移除" }).click();
    await expect(page.getByText("京A·E2E02", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("article").filter({ hasText: "津A·MVP26" })).toBeVisible();
  });

  test("小型新能源绿牌使用 8 格，并把 D 放在第 3 位", async ({ page }) => {
    let createVehiclePayload: Record<string, any> | null = null;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/vehicles$/.test(request.url())) {
        createVehiclePayload = request.postDataJSON() as Record<string, any>;
      }
    });
    await openAddVehicle(page);

    await page.getByTestId("plate-type-green").click();
    await page.getByTestId("vehicle-size-small").click();
    await page.getByTestId("vehicle-kind-D").click();
    await page.getByTestId("vehicle-wash-category-mpv").click();
    await expect(page.getByTestId("plate-type-green")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("vehicle-size-small")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("vehicle-kind-D")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("vehicle-wash-category-mpv")).toHaveAttribute("aria-checked", "true");
    await expectPlateSlotCount(page, 8);

    await chooseProvince(page, "沪");
    await expectPlateSlot(page, 1, "A");
    await expectPlateSlot(page, 2, "D");
    await typePlateCharacters(page, 3, ["1", "2", "3", "4", "5"]);

    for (const [index, value] of ["沪", "A", "D", "1", "2", "3", "4", "5"].entries()) {
      await expectPlateSlot(page, index, value);
    }
    await page.getByRole("button", { name: /确认保存/ }).click();
    await expect(page.getByRole("article").filter({ hasText: "沪A·D12345" })).toBeVisible();
    expect(createVehiclePayload?.inspectionValidity).toEqual({ mode: "unconfirmed" });
    expect(createVehiclePayload?.washVehicleCategory).toBe("mpv");
    expect(createVehiclePayload?.washVehicleCategory).not.toBe("suv_mpv");
    expect(createVehiclePayload).not.toHaveProperty("inspectionDueDate");
  });

  test("大型新能源绿牌使用 8 格，并把 F 放在末位", async ({ page }) => {
    await openAddVehicle(page);

    await page.getByTestId("plate-type-green").click();
    await page.getByTestId("vehicle-size-large").click();
    await page.getByTestId("vehicle-kind-F").click();
    await expect(page.getByTestId("vehicle-size-large")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("vehicle-kind-F")).toHaveAttribute("aria-pressed", "true");
    await expectPlateSlotCount(page, 8);

    await chooseProvince(page, "粤");
    await expectPlateSlot(page, 1, "A");
    await expectPlateSlot(page, 7, "F");
    await expect(page.getByRole("button", { name: "输入 A", exact: true })).toBeDisabled();
    await typePlateCharacters(page, 2, ["1", "2", "3", "4", "5"]);

    for (const [index, value] of ["粤", "A", "1", "2", "3", "4", "5", "F"].entries()) {
      await expectPlateSlot(page, index, value);
    }
    await page.getByRole("button", { name: /确认保存/ }).click();
    await expect(page.getByRole("article").filter({ hasText: "粤A·12345F" })).toBeVisible();
  });

  test("蓝绿牌与大小型切换保留省份机关并清理不兼容序号", async ({ page }) => {
    await openAddVehicle(page);

    await chooseProvince(page, "京");
    await typePlateCharacters(page, 2, ["1", "2", "3", "4", "5"]);
    await expectPlateSlot(page, 6, "5");

    await page.getByTestId("plate-type-green").click();
    await expectPlateSlotCount(page, 8);
    await expectPlateSlot(page, 0, "京");
    await expectPlateSlot(page, 1, "A");
    await expectPlateSlot(page, 2, "D");
    for (const index of [3, 4, 5, 6, 7]) await expectPlateSlot(page, index, "");

    await typePlateCharacters(page, 3, ["1", "2", "3", "4", "5"]);
    await page.getByTestId("vehicle-size-large").click();
    await expectPlateSlot(page, 0, "京");
    await expectPlateSlot(page, 1, "A");
    await expectPlateSlot(page, 7, "D");
    for (const index of [2, 3, 4, 5, 6]) await expectPlateSlot(page, index, "");

    await page.getByTestId("plate-type-blue").click();
    await expectPlateSlotCount(page, 7);
    await expectPlateSlot(page, 0, "京");
    await expectPlateSlot(page, 1, "A");
    for (const index of [2, 3, 4, 5, 6]) await expectPlateSlot(page, index, "");
  });

  test("C 端预约可在 B 端完成到站、交接与结果回传，并同步回 C 端", async ({ page }) => {
    test.setTimeout(40_000);
    const createdBookingId = await createConsumerBooking(page);
    await switchToOperator(page);

    const task = page.locator(`[data-testid="operator-task-card"][data-task-id="${createdBookingId}"]`);
    await expect(task).toBeVisible();
    await task.click();
    await expect(page.getByTestId("operator-detail")).toBeVisible();

    const accept = page.getByTestId("operator-action-accept");
    await expect(accept).toBeVisible();
    await accept.click();
    await expect(page.locator(".operator-detail-status")).toHaveText("等待到站");

    for (const testId of ["verification-plate", "verification-materials", "verification-exterior", "verification-condition"]) {
      const control = page.getByTestId(testId);
      await expect(control).toBeVisible();
      if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
    }
    await page.getByTestId("operator-action-check-in").click();
    await expect(page.locator(".operator-detail-status")).toHaveText("已到站核验");

    await page.getByTestId("operator-action-handoff").click();
    await expect(page.locator(".operator-detail-status")).toHaveText("检测中");
    await expect(page.getByText(/检测设备软件属于外部系统/)).toBeVisible();

    await page.getByTestId("operator-action-simulate-result").click();
    await expect(page.locator(".operator-detail-status")).toHaveText("结果已回传");
    await expect(page.getByText(/合格/).first()).toBeVisible();

    await page.getByTestId("operator-action-complete").click();
    await expect(page.locator(".operator-detail-status")).toHaveText("已完成");

    await switchToConsumer(page);
    await page.getByTestId("owner-nav-orders").click();
    const consumerOrder = currentFlow(page).getByTestId(`inspection-order-card-${createdBookingId}`);
    await expect(consumerOrder).toContainText("已完成");
    await consumerOrder.click();
    await expect(currentFlow(page).getByText("结果已回传", { exact: true })).toBeVisible();
    await expect(currentFlow(page).getByText("本次检验结论：合格", { exact: true })).toBeVisible();
    await expect(page.getByText("本次服务体验如何？", { exact: true })).toBeVisible();

    await page.getByTestId("flow-fixed-header").getByRole("button", { name: "返回", exact: true }).click();
    await page.getByTestId("owner-nav-home").click();
    await page.getByTestId("inspection-stage-entry-result").click();
    const resultStage = currentFlow(page).getByTestId("inspection-stage-page");
    await expect(resultStage).toHaveAttribute("data-stage", "result");
    await expect(resultStage).toContainText("检测结果已回传");
    await expect(resultStage).toContainText("本次检验结论：合格");
    await expect(resultStage).toContainText(/交管\s*12123/);
  });

  test("车辆信息不一致会挂起任务，解决后恢复到已到站节点", async ({ page }) => {
    await openMvp(page);
    await switchToOperator(page);
    await selectDefaultOperatorScope(page);
    await page.getByTestId("operator-filter-checked-in").click();

    const checkedInTask = page.getByTestId("operator-task-card").first();
    await expect(checkedInTask).toBeVisible();
    await checkedInTask.click();
    await page.getByTestId("operator-action-hold").click();

    const mismatchReason = page.getByRole("button", { name: /车辆信息不一致/ });
    if (await mismatchReason.isVisible().catch(() => false)) await mismatchReason.click();
    const confirmHold = page.getByRole("button", { name: /确认挂起/ });
    if (await confirmHold.isVisible().catch(() => false)) await confirmHold.click();

    await expect(page.getByText(/异常处理中|任务已挂起/).first()).toBeVisible();
    await expect(page.getByText(/车辆信息不一致/).first()).toBeVisible();
    await page.getByTestId("operator-action-resolve-hold").click();
    await expect(page.locator(".operator-detail-status")).toHaveText("已到站核验");
    await expect(page.getByText(/异常已解决|核验已恢复/).first()).toBeVisible();
  });

  test("待到站队列显式标记晚到任务，重复主操作不会继续暴露", async ({ page }) => {
    await openMvp(page);
    await switchToOperator(page);
    await selectDefaultOperatorScope(page);
    await page.getByTestId("operator-filter-awaiting-arrival").click();

    const lateTask = page.getByTestId("operator-task-card").filter({ hasText: "津B·T1001" }).first();
    await expect(lateTask).toBeVisible();
    await expect(lateTask).toContainText("晚到");
    await lateTask.click();
    await expect(page.locator(".operator-detail-status")).toHaveText("等待到站");

    for (const testId of ["verification-plate", "verification-materials", "verification-exterior", "verification-condition"]) {
      const control = page.getByTestId(testId);
      if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
    }
    await page.getByTestId("operator-action-check-in").click();
    await expect(page.locator(".operator-detail-status")).toHaveText("已到站核验");
    await expect(page.getByTestId("operator-action-check-in")).toBeHidden();
  });

  test("未来时段容量不得调到已预约数量以下", async ({ page, request }) => {
    const vehiclesResponse = await request.get(`${E2E_API_BASE}/vehicles`);
    expect(vehiclesResponse.ok()).toBe(true);
    const vehicles = (await vehiclesResponse.json()).data as Array<{ id: string }>;

    const workbenchResponse = await request.get(`${E2E_API_BASE}/operator/workbench`);
    const businessDate = (await workbenchResponse.json()).data.businessDate as string;
    const nextDate = new Date(Date.parse(`${businessDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const slotsResponse = await request.get(`${E2E_API_BASE}/stations/station-hexi-1/slots?date=${nextDate}`);
    expect(slotsResponse.ok()).toBe(true);
    const slots = (await slotsResponse.json()).data as Array<{
      id: string;
      startTime: string;
      endTime: string;
      capacity: number;
      bookedCount: number;
    }>;
    const firstSlot = slots.find((slot) => slot.capacity > 0 && slot.bookedCount === 0);
    expect(firstSlot).toBeTruthy();
    if (!firstSlot) throw new Error("未找到可用于容量边界测试的未来号源");

    const uploadBuffer = readFileSync("public/assets/inspection/vehicle-front.png");
    const mediaIds: string[] = [];
    for (const kind of ["vehicle_front_left", "vehicle_front_right", "vehicle_rear_left", "vehicle_rear_right", "dashboard_started", "license_front", "license_back"]) {
      const uploaded = await request.post(`${E2E_API_BASE}/media`, { multipart: { kind, file: { name: `${kind}.png`, mimeType: "image/png", buffer: uploadBuffer } } });
      expect(uploaded.status()).toBe(201);
      mediaIds.push((await uploaded.json()).data.id);
    }

    const quoteResponse = await request.post(`${E2E_API_BASE}/bookings/quote`, {
      data: {
        vehicleId: vehicles[0].id,
        stationId: "station-hexi-1",
        serviceMode: "self_drive",
      },
    });
    expect(quoteResponse.ok()).toBe(true);
    const quote = (await quoteResponse.json()).data as { quoteSnapshotId: string };

    const booking = await request.post(`${E2E_API_BASE}/bookings`, {
      data: {
        vehicleId: vehicles[0].id,
        stationId: "station-hexi-1",
        slotId: firstSlot.id,
        contactName: "容量边界测试车主",
        contactPhone: "13800138000",
        serviceMode: "self_drive",
        mediaIds,
        quoteSnapshotId: quote.quoteSnapshotId,
      },
    });
    expect(booking.status()).toBe(201);

    await openMvp(page);
    await switchToOperator(page);
    await page.getByTestId("operator-nav-station").click();

    const firstSlotCard = page.getByTestId("operator-slot-card").filter({ hasText: firstSlot.startTime }).first();
    await expect(firstSlotCard).toBeVisible();
    await expect(firstSlotCard).toContainText(/已约\s*1/);

    for (let remaining = firstSlot.capacity; remaining > 0; remaining -= 1) {
      await firstSlotCard.getByTestId("operator-slot-decrease").click();
    }
    await expect(firstSlotCard).toContainText(/容量\s*0/);
    await firstSlotCard.getByTestId("operator-slot-save").click();
    await expect(page.getByTestId("operator-capacity-error")).toContainText(/容量不能低于当前已预约数量|容量不能低于已预约数量/);
  });

  test("上门取送车（往返）在腾讯真实路线不可用时严格阻止计价和下单", async ({ page }) => {
    test.setTimeout(35_000);
    const previousIds = new Set((await adminBookings(page)).map((booking) => booking.id));
    await openMvp(page);
    await page.getByRole("button", { name: /立即预约/ }).click();
    const stationCards = page.locator(".station-card");
    await expect(stationCards.first()).toContainText("华洋机动车检测站");
    await expect(stationCards.first()).toContainText("自营站 · 置顶推荐");
    await expect(page.getByText(/华洋站名称、地址与腾讯坐标已核验/)).toBeVisible();

    const demoStation = stationCards.filter({ hasText: "海河机动车检测服务中心（演示）" });
    await expect(demoStation).toContainText("演示站");
    await demoStation.click();
    const availableSlot = page.getByRole("button", { name: /^\d{2}:\d{2}.*余 \d+ 位/ }).first();
    await expect(availableSlot).toBeEnabled();
    await availableSlot.click();
    await page.getByRole("button", { name: "确认时段，下一步" }).click();
    await expect(page.getByTestId("booking-form")).toBeVisible();
    await page.waitForTimeout(500);

    await page.getByRole("button", { name: /上门取送车（往返）/ }).click();
    await page.getByLabel("小区 / 商场 / 写字楼").fill("文化中心");
    const suggestion = page.locator(".address-suggestions button").first();
    await expect(suggestion).toBeVisible();
    await suggestion.click();
    await expect(page.locator(".selected-address")).toContainText("天津文化中心地下停车场");
    await expect(page.locator(".address-source")).toContainText("合成演示地址");
    await page.getByLabel("楼栋 / 门牌（选填）").fill("地库 B2-156");
    await expect(page.locator(".booking-fee-card")).toContainText("上门取送车（往返）");
    await expect(page.locator(".booking-fee-card")).toContainText("取得腾讯真实路线后才能计价");
    await expect(page.locator('[aria-label="上门取送车计价明细"]')).toHaveCount(0);
    // The same strict branch is required for quota exhaustion, unauthorized keys and timeouts:
    // no estimated distance may be presented as a Tencent quote and no valet order may be created.
    await expect(page.getByRole("alert")).toContainText(/腾讯真实驾车路线|暂不能使用上门取送/);

    const selfDriveFallback = page.getByRole("button", { name: "改选自驾到站" });
    await expect(selfDriveFallback).toBeEnabled();
    await selfDriveFallback.click();
    await expect(page.getByRole("button", { name: /自驾到店/ })).toHaveClass(/active/);
    await expect(page.locator(".booking-fee-card")).toContainText("自驾到店不收取");
    expect((await adminBookings(page)).map((booking) => booking.id).filter((id) => !previousIds.has(id))).toHaveLength(0);
  });

  test("检测站工作台和单车详情在 iPhone 与 Pixel 10 均无横向溢出", async ({ page }) => {
    await openMvp(page);
    await switchToOperator(page);
    await expect(page.getByTestId("device-screen")).toHaveAttribute("data-device", "iphone");
    await expect(page.getByTestId("operator-nav-workbench")).toBeVisible();
    await expect(page.getByTestId("operator-nav-orders")).toBeVisible();
    await expect(page.getByTestId("operator-nav-station")).toBeVisible();
    expect(await page.getByTestId("device-screen").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    await page.getByTestId("operator-task-card").first().click();
    await expect(page.getByTestId("operator-detail")).toBeVisible();
    expect(await page.getByTestId("device-screen").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "返回", exact: true }).click();

    await page.getByTestId("device-picker").click();
    await page.getByTestId("device-option-pixel-10").click();
    await expect(page.getByTestId("device-screen")).toHaveAttribute("data-device", "pixel-10");
    await expect(page.getByTestId("operator-workbench")).toBeVisible();
    expect(await page.getByTestId("device-screen").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
});

const insuranceDisclosure = {
  mode: "demo",
  acceptsRealData: false,
  version: "insurance-demo-2026-08-16",
  partner: { id: "partner-demo", name: "驭小满续保服务团队（演示）" },
  dataScope: ["车辆档案与预计续保时间", "联系人姓名与手机号码", "行驶证主页"],
  purpose: "识别车辆续保需求并安排专业服务人员对接",
  retention: "需求撤回后30日内删除，法律法规另有要求的除外",
  consentText: "仅提交合成演示资料，不会转交真实保险机构",
  contactEtaText: "1个工作日内",
};

function insuranceReceipt(overrides: Record<string, unknown> = {}) {
  return {
    leadCode: "BX202608160001",
    submittedAt: "2026-08-16T09:30:00.000Z",
    vehicle: { id: "veh-demo-001", plateNumber: "津A·MVP26", modelName: "小型轿车" },
    maskedPhone: "138****8000",
    contactEtaText: "1个工作日内",
    withdrawToken: "withdraw-demo",
    duplicate: false,
    status: "submitted",
    ...overrides,
  };
}

async function openInsuranceLead(page: Page) {
  await page.route("**/api/insurance/disclosure", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: insuranceDisclosure }) });
  });
  await openMvp(page);
  await page.getByTestId("insurance-entry-service").click();
  await expect(page.getByTestId("insurance-lead-page")).toBeVisible();
  await expect(page.getByTestId("flow-fixed-header").getByText("车险续保对接", { exact: true })).toBeVisible();
  await expect(page.getByText("演示环境请勿上传真实资料，仅使用合成演示图片", { exact: true })).toBeVisible();
}

async function fillInsuranceLead(page: Page, options: { consent?: boolean; phone?: string } = {}) {
  await page.getByLabel("保险联系人").fill("林先生");
  await page.getByLabel("保险联系电话").fill(options.phone ?? "13800138000");
  await page.getByTestId("insurance-renewal-one_to_three_months").click();
  await page.getByTestId("insurance-contact-anytime").click();
  await page.getByTestId("insurance-license-photo").setInputFiles({
    name: "demo-license.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  if (options.consent !== false) await page.getByTestId("insurance-consent").check();
}

test.describe("车险续保专业对接闭环", () => {
  test("模拟键盘打开时联系人和手机号始终滚到固定 CTA 上方", async ({ page }) => {
    await openInsuranceLead(page);
    const keyboardDock = page.getByTestId("keyboard-dock");

    const expectFocusedFieldVisible = async (label: string) => {
      await page.getByLabel(label).click();
      await expect(keyboardDock).toHaveAttribute("data-visible", "true");
      await page.waitForTimeout(520);
      const geometry = await page.getByLabel(label).evaluate((input) => {
        const field = input.closest(".insurance-linear-fields > label");
        const scroll = input.closest(".mobile-scroll");
        const flow = input.closest(".flow-stack");
        const footer = flow?.querySelector(".flow-fixed-footer");
        const keyboard = document.querySelector('.keyboard-dock[data-visible="true"]');
        const deviceScreen = input.closest('[data-testid="device-screen"]');
        if (!(field instanceof HTMLElement) || !(scroll instanceof HTMLElement) || !(footer instanceof HTMLElement) || !(keyboard instanceof HTMLElement) || !(deviceScreen instanceof HTMLElement)) throw new Error("车险键盘布局节点缺失");
        return {
          fieldTop: field.getBoundingClientRect().top,
          fieldBottom: field.getBoundingClientRect().bottom,
          scrollTopEdge: scroll.getBoundingClientRect().top,
          footerTop: footer.getBoundingClientRect().top,
          footerBottom: footer.getBoundingClientRect().bottom,
          keyboardTop: keyboard.getBoundingClientRect().top,
          deviceScrollTop: deviceScreen.scrollTop,
        };
      });
      expect(geometry.fieldTop).toBeGreaterThanOrEqual(geometry.scrollTopEdge + 12);
      expect(geometry.fieldBottom).toBeLessThanOrEqual(geometry.footerTop - 14);
      expect(Math.abs(geometry.footerBottom - geometry.keyboardTop)).toBeLessThanOrEqual(2);
      expect(geometry.deviceScrollTop).toBe(0);
    };

    await expectFocusedFieldVisible("保险联系人");
    await expectFocusedFieldVisible("保险联系电话");

    await page.getByTestId("insurance-submit").click();
    await expect(keyboardDock).toHaveAttribute("data-visible", "false");
    await expect(page.getByTestId("device-screen")).toHaveJSProperty("scrollTop", 0);
  });

  test("从首页登记需求并展示最小化服务凭证", async ({ page }) => {
    let multipartBody = "";
    let idempotencyKey = "";
    await page.route("**/api/insurance/leads", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      multipartBody = request.postDataBuffer()?.toString("utf8") || "";
      idempotencyKey = request.headers()["idempotency-key"] || "";
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: { receipt: insuranceReceipt() } }) });
    });

    await openInsuranceLead(page);
    await expect(page.getByTestId("insurance-consent")).not.toBeChecked();
    await page.getByTestId("insurance-disclosure-trigger").click();
    await expect(page.getByTestId("insurance-disclosure-sheet")).toContainText("驭小满续保服务团队（演示）");
    await expect(page.getByTestId("insurance-disclosure-sheet")).toContainText(insuranceDisclosure.purpose);
    await expect(page.getByTestId("insurance-disclosure-sheet")).toContainText(insuranceDisclosure.retention);
    await expect(page.getByTestId("insurance-disclosure-sheet")).toContainText("行驶证主页");
    await page.getByRole("button", { name: "同意并继续", exact: true }).click();
    await expect(page.getByTestId("insurance-consent")).toBeChecked();

    await fillInsuranceLead(page);
    await page.getByTestId("insurance-submit").click();
    await expect(page.getByTestId("insurance-receipt-page")).toBeVisible();
    await expect(page.getByTestId("insurance-lead-code")).toHaveText("BX202608160001");
    await expect(page.getByText("2026-08-16 17:30", { exact: true })).toBeVisible();
    await expect(page.getByText("津A·MVP26 · 小型轿车", { exact: true })).toBeVisible();
    await expect(page.getByText("138****8000", { exact: true })).toBeVisible();
    await expect(page.getByText("1个工作日内", { exact: true })).toBeVisible();
    await expect(page.locator(".insurance-timeline, .timeline")).toHaveCount(0);

    expect(idempotencyKey.length).toBeGreaterThan(10);
    for (const field of ["vehicleId", "renewalWindow", "contactName", "contactPhone", "contactWindow", "consentAccepted", "disclosureVersion", "licensePhoto"]) {
      expect(multipartBody).toContain(`name="${field}"`);
    }
    expect(multipartBody).toContain("one_to_three_months");
    expect(multipartBody).toContain("林先生");
    expect(multipartBody).toContain("13800138000");
    expect(multipartBody).toContain("anytime");
    expect(multipartBody).toContain(insuranceDisclosure.version);
    expect(multipartBody).toContain('filename="demo-license.png"');
  });

  test("手机号错误与未授权时在表单内阻止提交", async ({ page }) => {
    let submitCount = 0;
    await page.route("**/api/insurance/leads", async (route) => {
      submitCount += 1;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: { receipt: insuranceReceipt() } }) });
    });
    await openInsuranceLead(page);
    await fillInsuranceLead(page, { phone: "12000000000", consent: false });
    await page.getByTestId("insurance-submit").click();
    await expect(page.getByRole("alert").filter({ hasText: "请输入正确的11位手机号" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "请先阅读并同意信息使用说明" })).toBeVisible();
    expect(submitCount).toBe(0);
  });

  test("行驶证主页格式或大小不合规时立即提示", async ({ page }) => {
    await openInsuranceLead(page);
    const upload = page.getByTestId("insurance-license-photo");
    await upload.setInputFiles({ name: "license.txt", mimeType: "text/plain", buffer: Buffer.from("not-an-image") });
    await expect(page.getByRole("alert").filter({ hasText: "仅支持JPG、PNG或WebP图片" })).toBeVisible();

    await upload.setInputFiles({ name: "oversized.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await expect(page.getByRole("alert").filter({ hasText: "图片大小不能超过5MB" })).toBeVisible();
  });

  test("近期重复需求返回同一凭证且车主可撤回", async ({ page }) => {
    await page.route("**/api/insurance/leads", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { receipt: insuranceReceipt({ duplicate: true }) } }) });
    });
    await page.route("**/api/insurance/leads/withdraw-demo/withdraw", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postData()).toBeNull();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { receipt: insuranceReceipt({ duplicate: true, status: "withdrawn", withdrawToken: "" }) } }) });
    });

    await openInsuranceLead(page);
    await fillInsuranceLead(page);
    await page.getByTestId("insurance-submit").click();
    await expect(page.getByTestId("insurance-lead-code")).toHaveText("BX202608160001");
    await expect(page.getByText("已返回原提交凭证", { exact: true })).toBeVisible();
    await expect(page.getByText(/本次返回同一凭证，不会重复派单/)).toBeVisible();

    await page.getByTestId("insurance-withdraw").click();
    await expect(page.getByText("需求已撤回", { exact: true })).toBeVisible();
    await expect(page.getByText("本次对接已停止", { exact: true })).toBeVisible();
    await expect(page.getByTestId("insurance-withdraw")).toHaveCount(0);
  });
});
