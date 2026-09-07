import { expect, test } from "@playwright/test";

function shanghaiDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day") + offsetDays)).toISOString().slice(0, 10);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test(`后台在 ${viewport.width}px 显示交易、真实/演示站点与往返取送规则`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "预约交易与履约中心" })).toBeVisible();
    await expect(page.getByRole("button", { name: "预约履约" })).toBeVisible();
    await expect(page.getByText("已模拟支付", { exact: true })).toBeVisible();
    await expect(page.getByText("模拟已收净额", { exact: true })).toBeVisible();
    await expect(page.locator(".metric-strip").getByText("¥1560.00", { exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "上门往返取送" })).toBeAttached();
    const bookingTable = page.getByRole("table", { name: "预约履约列表" });
    await expect(bookingTable).toBeVisible();
    await expect(bookingTable).toContainText("¥240.00");
    await expect(bookingTable).toContainText("¥260.00");
    await expect(bookingTable).toContainText("¥300.00");
    await expect(page.getByLabel("预约日期筛选")).toBeVisible();
    await expect(page.getByLabel("车牌号筛选")).toBeVisible();
    await expect(page.getByLabel("检测站筛选")).toBeVisible();
    await expect(page.getByLabel("履约状态筛选")).toBeVisible();
    await expect(page.getByLabel("服务方式筛选")).toBeVisible();
    const firstDetailsButton = bookingTable.getByRole("button", { name: /查看.+预约详情/ }).first();
    await expect(firstDetailsButton).toBeVisible();
    await firstDetailsButton.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("预约与账务详情")).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新预约详情" })).toBeVisible();
    await page.getByRole("button", { name: "刷新预约详情" }).click();
    await expect(page.getByLabel("预约与账务详情")).toBeVisible();
    await page.getByRole("button", { name: "关闭预约详情" }).click();
    if (viewport.width <= 1180) {
      await expect(page.getByText(/履约状态和查看详情固定显示/)).toBeVisible();
      await expect(bookingTable.locator("tbody .booking-status-cell").first()).toBeInViewport();
      await expect(firstDetailsButton).toBeInViewport();
    }

    await page.getByRole("button", { name: "站点配置" }).click();
    await expect(page.getByRole("heading", { name: "检测站与服务能力" })).toBeVisible();
    const huayang = page.getByRole("button", { name: /华洋机动车检测站.*自营.*置顶/ });
    await expect(huayang).toBeVisible();
    await huayang.click();
    await expect(page.getByLabel("正式主体名称")).toHaveValue("天津市华洋机动车检测有限公司");
    await expect(page.getByLabel("详细地址")).toHaveValue("天津自贸试验区（天津港保税区）海滨大道3680号");
    await expect(page.getByLabel("客户咨询电话")).toHaveValue("022-25781772");
    await expect(page.getByLabel("数据属性")).toHaveValue("real");
    await expect(page.getByRole("button", { name: /海河机动车检测服务中心（演示）.*演示/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "保存站点配置" })).toBeVisible();
    const enabledInspectionPrice = page.locator(".price-matrix label.supported input[type=number]").first();
    await expect(enabledInspectionPrice).toHaveAttribute("min", "0.01");
    expect(Number(await enabledInspectionPrice.inputValue())).toBeGreaterThan(0);

    await page.getByRole("button", { name: "检验价格方案" }).click();
    await expect(page.getByRole("heading", { name: "受控车型与检验价格方案" })).toBeVisible();
    await expect(page.locator(".plan-editor label").filter({ hasText: "后台排序" }).locator('input[type="number"]')).toBeVisible();
    await expect(page.getByText("匹配优先级", { exact: true })).toHaveCount(0);
    await expect(page.getByText("按所选类别和实际动力匹配报价", { exact: true })).toBeVisible();
    await expect(page.getByText(/纯电方案不能包含尾气|不能把纯电车辆误配尾气检测/)).toBeVisible();
    await expect(page.getByText(/没有匹配或同时匹配多个方案时停止自动报价/)).toBeVisible();

    await page.getByRole("button", { name: "取送计价规则" }).click();
    await expect(page.getByRole("heading", { name: "上门往返取送计价" })).toBeVisible();
    await expect(page.getByText(/往返取送费 =/)).toBeVisible();
    await expect(page.getByText(/已包含送回，不另收返程费/)).toBeVisible();
    await page.getByLabel("配置范围").selectOption({ label: "华洋机动车检测站" });
    await expect(page.locator(".rule-editor h2")).toHaveText("华洋机动车检测站");
    await expect(page.locator(".formula")).toContainText(/11\.7 公里 → ¥99(?:\.00)? \+ 2 公里 × ¥8(?:\.00)? = ¥115(?:\.00)?/);
    await expect(page.locator(".example-card")).toContainText("仅腾讯真实驾车路线可生成取送报价");
    await expect(page.getByRole("button", { name: "保存计价规则" })).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  });
}

test("预约履约按车牌号查询并独立显示上海时区下单时间", async ({ page }) => {
  const today = shanghaiDate();
  const tomorrow = shanghaiDate(1);
  const bookingRequests: string[] = [];
  let releaseSlowRequest: (() => void) | undefined;
  let markSlowRequestStarted: (() => void) | undefined;
  const slowRequestGate = new Promise<void>((resolve) => { releaseSlowRequest = resolve; });
  const slowRequestStarted = new Promise<void>((resolve) => { markSlowRequestStarted = resolve; });
  await page.route("**/api/admin/bookings**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET" || url.pathname !== "/api/admin/bookings") return route.fallback();
    bookingRequests.push(request.url());
    const requestedPlate = url.searchParams.get("plateNumber") || "";
    if (requestedPlate === "津A") {
      markSlowRequestStarted?.();
      await slowRequestGate;
    }
    const plateNumber = requestedPlate === "津A" ? "津A·STALE" : requestedPlate || "津A·P8888";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [{
        id: `booking-plate-filter-${plateNumber}`,
        bookingNumber: "YXM-PLATE-001",
        status: "confirmed",
        fulfillmentStatus: "confirmed",
        paymentStatus: "paid",
        appointmentDate: "2026-08-30",
        startTime: "10:00",
        endTime: "11:00",
        contactName: "车牌筛选测试",
        contactPhone: "13800008888",
        serviceMode: "self_drive",
        serviceFeeFen: 6800,
        inspectionFeeFen: 6800,
        valetFeeFen: 0,
        quoteDistanceKm: null,
        vehiclePriceCategory: "fuel_small",
        createdAt: "2026-08-28T09:06:00+08:00",
        station: { id: "station-filter", name: "车牌筛选测试站", district: "河西区" },
        vehicle: { plateNumber, vehicleType: "小型轿车", seats: 5 },
      }] }),
    }).catch(() => undefined);
  });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const table = page.getByRole("table", { name: "预约履约列表" });
  const dateFilter = page.getByLabel("预约日期筛选");
  await expect(dateFilter).toHaveValue(today);
  await expect(page.getByRole("button", { name: "今日预约" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => bookingRequests.some((requestUrl) => new URL(requestUrl).searchParams.get("date") === today)).toBe(true);
  await expect(page.locator(".metric-strip").getByText("今日预约", { exact: true })).toBeVisible();
  const requestCountBeforeTomorrow = bookingRequests.length;
  await page.getByRole("button", { name: "明日预约" }).click();
  await expect(dateFilter).toHaveValue(tomorrow);
  await expect(page.getByRole("button", { name: "明日预约" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => bookingRequests.slice(requestCountBeforeTomorrow).some((requestUrl) => new URL(requestUrl).searchParams.get("date") === tomorrow)).toBe(true);
  const requestCountBeforeAllDates = bookingRequests.length;
  await page.getByRole("button", { name: "全部日期" }).click();
  await expect(dateFilter).toHaveValue("");
  await expect(page.getByRole("button", { name: "全部日期" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => bookingRequests.slice(requestCountBeforeAllDates).some((requestUrl) => !new URL(requestUrl).searchParams.has("date"))).toBe(true);
  const requestCountBeforeCustomDate = bookingRequests.length;
  await dateFilter.fill("2030-05-20");
  await expect.poll(() => bookingRequests.slice(requestCountBeforeCustomDate).some((requestUrl) => new URL(requestUrl).searchParams.get("date") === "2030-05-20")).toBe(true);
  await expect(page.getByRole("button", { name: "今日预约" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "明日预约" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "全部日期" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".metric-strip").getByText("指定日预约", { exact: true })).toBeVisible();
  const createdHeader = table.getByRole("columnheader", { name: "下单时间" });
  await expect(createdHeader).toBeVisible();
  await expect(createdHeader).toHaveAttribute("aria-sort", "descending");
  await expect(createdHeader).toContainText("最新优先");
  await expect(table.getByRole("columnheader", { name: "预约时间" })).toBeVisible();
  const orderTimeCell = table.locator("tbody tr").first().locator("td").first();
  await expect(orderTimeCell).toContainText("2026-08-28");
  await expect(orderTimeCell).toContainText("09:06");

  const plateFilter = page.getByLabel("车牌号筛选");
  const stationFilter = page.getByLabel("检测站筛选");
  const statusFilter = page.getByLabel("履约状态筛选");
  const serviceModeFilter = page.getByLabel("服务方式筛选");
  await stationFilter.selectOption({ index: 1 });
  const stationId = await stationFilter.inputValue();
  await statusFilter.selectOption("confirmed");
  await serviceModeFilter.selectOption("valet");
  await expect(plateFilter).toHaveAttribute("maxlength", "32");
  await plateFilter.fill("津A");
  await slowRequestStarted;
  await plateFilter.fill("津A·P8888");
  await expect.poll(() => bookingRequests.some((requestUrl) => {
    const url = new URL(requestUrl);
    return url.searchParams.get("date") === "2030-05-20"
      && url.searchParams.get("plateNumber") === "津A·P8888"
      && url.searchParams.get("stationId") === stationId
      && url.searchParams.get("status") === "confirmed"
      && url.searchParams.get("serviceMode") === "valet";
  })).toBe(true);
  await expect(table.locator("tbody tr").first()).toContainText("津A·P8888");
  releaseSlowRequest?.();
  await page.waitForTimeout(100);
  await expect(table).not.toContainText("津A·STALE");

  const requestCountBeforeClear = bookingRequests.length;
  await page.getByRole("button", { name: "重置预约筛选" }).click();
  await expect(plateFilter).toHaveValue("");
  await expect(dateFilter).toHaveValue(today);
  await expect(stationFilter).toHaveValue("");
  await expect(statusFilter).toHaveValue("");
  await expect(serviceModeFilter).toHaveValue("");
  await expect(page.getByRole("button", { name: "今日预约" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => bookingRequests.slice(requestCountBeforeClear).some((requestUrl) => {
    const url = new URL(requestUrl);
    return url.searchParams.toString() === `date=${today}`;
  })).toBe(true);
});

test("预约深链详情不被默认今日列表清空，普通列表详情仍随筛选关闭", async ({ page }) => {
  const today = shanghaiDate();
  let releaseInitialList: (() => void) | undefined;
  const initialListGate = new Promise<void>((resolve) => { releaseInitialList = resolve; });
  let initialTodayRequest = true;
  const makeBooking = (id: string, plateNumber: string, appointmentDate: string) => ({
    id,
    bookingNumber: `YXM-${id}`,
    status: "completed",
    fulfillmentStatus: "completed",
    paymentStatus: "paid",
    appointmentDate,
    startTime: "10:00",
    endTime: "11:00",
    contactName: "深链回归测试",
    contactPhone: "13800008888",
    serviceMode: "self_drive",
    serviceFeeFen: 26000,
    inspectionFeeFen: 26000,
    valetFeeFen: 0,
    quoteDistanceKm: null,
    vehiclePriceCategory: "fuel_small",
    createdAt: "2026-08-28T09:06:00+08:00",
    station: { id: "station-deep-link", name: "深链回归检测站", district: "河西区" },
    vehicle: { plateNumber, vehicleType: "小型轿车", seats: 5 },
    media: [],
    events: [],
    evidencePackages: [],
  });
  const deepLinked = makeBooking("booking-deep-link-outside-today", "津A·D8888", "2026-08-25");
  const ordinary = makeBooking("booking-filtered-list", "津A·L8888", "2026-08-25");

  await page.route("**/api/admin/bookings**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/admin/bookings/${deepLinked.id}`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: deepLinked }) });
    }
    if (url.pathname === `/api/admin/bookings/${ordinary.id}`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: ordinary }) });
    }
    if (url.pathname !== "/api/admin/bookings") return route.fallback();
    if (url.searchParams.get("date") === today) {
      if (initialTodayRequest) {
        initialTodayRequest = false;
        await initialListGate;
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [ordinary] }) });
  });

  await page.goto(`/bookings?booking=${deepLinked.id}`);
  const drawer = page.getByLabel("预约与账务详情");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("津A·D8888");
  releaseInitialList?.();
  await expect(page.getByText("没有符合条件的预约")).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("已完成");

  await drawer.getByRole("button", { name: "关闭预约详情" }).click();
  await expect(page).toHaveURL(/\/bookings$/);
  await page.getByRole("button", { name: "全部日期" }).click();
  await expect(page.getByText("津A·L8888", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开津A·L8888预约详情" }).click();
  await expect(drawer).toBeVisible();
  await page.getByRole("button", { name: "今日预约" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByText("没有符合条件的预约")).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

test("预约履约列表在768px仍固定显示状态和键盘详情入口", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 768 });
  await page.goto("/");
  const bookingTable = page.getByRole("table", { name: "预约履约列表" });
  const firstRow = bookingTable.locator("tbody tr").first();
  const detailsButton = firstRow.getByRole("button", { name: /查看.+预约详情/ });
  await expect(page.getByText(/履约状态和查看详情固定显示/)).toBeVisible();
  await expect(firstRow.locator(".booking-status-cell")).toBeInViewport();
  await expect(detailsButton).toBeInViewport();
  const buttonBounds = await detailsButton.boundingBox();
  expect(buttonBounds?.width).toBeGreaterThanOrEqual(44);
  expect(buttonBounds?.height).toBeGreaterThanOrEqual(44);
  await detailsButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("预约与账务详情")).toBeVisible();
});

test("检测站新增和编辑只能通过可信地址候选更新定位", async ({ page }) => {
  const stationWrites: Array<{ method: string; body: Record<string, unknown> }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^\/api\/admin\/stations(?:\/[^/]+)?$/.test(url.pathname) || !["POST", "PUT"].includes(request.method())) return;
    stationWrites.push({ method: request.method(), body: request.postDataJSON() as Record<string, unknown> });
  });
  await page.route("**/api/locations/suggestions?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("query") ?? "";
    if (query === "无结果") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], meta: { source: "demo" } }) });
    }
    if (query === "地址错误") {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "地图地址服务暂不可用" } }) });
    }
    return route.continue();
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "站点配置" }).click();
  await expect(page.getByRole("heading", { name: "检测站与服务能力" })).toBeVisible();
  await page.getByRole("button", { name: /海河机动车检测服务中心（演示）.*演示/ }).click();

  await expect(page.getByLabel("详细地址")).not.toHaveValue("");
  await expect(page.getByLabel("检测站纬度")).toHaveJSProperty("readOnly", true);
  await expect(page.getByLabel("检测站经度")).toHaveJSProperty("readOnly", true);
  await expect(page.getByLabel("所属区")).toHaveJSProperty("readOnly", true);
  await expect(page.getByLabel("详细地址")).toHaveJSProperty("readOnly", true);
  await expect(page.getByLabel("腾讯 POI ID")).toHaveCount(0);

  const unchangedResponse = page.waitForResponse((response) => response.request().method() === "PUT" && /\/api\/admin\/stations\/[^/]+$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "保存站点配置" }).click();
  await unchangedResponse;
  expect(stationWrites.at(-1)?.body.location).toBeUndefined();

  await page.getByLabel("搜索检测站位置").fill("无结果");
  await expect(page.getByText("没有找到匹配位置，请换用道路、地标或完整站点名称")).toBeVisible();
  await page.getByRole("button", { name: "清除检测站地址搜索" }).click();
  await page.getByLabel("搜索检测站位置").fill("地址错误");
  await expect(page.getByText("地图地址服务暂不可用")).toBeVisible();
  await page.getByRole("button", { name: "清除检测站地址搜索" }).click();

  await page.getByLabel("搜索检测站位置").fill("文化中心");
  await page.getByRole("option", { name: /天津文化中心地下停车场.*河西区平江道 58 号/ }).click();
  await expect(page.getByText("已重新定位")).toBeVisible();
  await expect(page.getByLabel("检测站纬度")).toHaveValue("39.083700");
  await expect(page.getByLabel("检测站经度")).toHaveValue("117.219700");
  const relocationResponse = page.waitForResponse((response) => response.request().method() === "PUT" && /\/api\/admin\/stations\/[^/]+$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "保存站点配置" }).click();
  await relocationResponse;
  const relocation = stationWrites.at(-1)?.body.location as { poiId?: string; locationProof?: string } | undefined;
  expect(relocation?.poiId).toContain("demo-tianjin");
  expect(relocation?.locationProof).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  await page.getByRole("button", { name: "新增", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新增检测站" })).toBeVisible();
  await page.getByLabel("展示名称").fill("自动化可信定位检测站（演示）");
  const postCount = stationWrites.filter((item) => item.method === "POST").length;
  await page.getByRole("button", { name: "创建站点" }).click();
  await expect(page.getByText("请先搜索并选择检测站位置，地址与坐标将由系统自动填写")).toBeVisible();
  expect(stationWrites.filter((item) => item.method === "POST")).toHaveLength(postCount);

  await page.getByLabel("搜索检测站位置").fill("天津站");
  await page.getByRole("option", { name: /天津站南广场停车场/ }).click();
  const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin/stations");
  await page.getByRole("button", { name: "创建站点" }).click();
  await createResponse;
  const createdLocation = stationWrites.at(-1)?.body.location as { poiId?: string; locationProof?: string } | undefined;
  expect(createdLocation?.poiId).toContain("demo-tianjin");
  expect(createdLocation?.locationProof).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("预约资料图片可放大、切换并通过键盘关闭", async ({ page }) => {
  const bookingId = "booking-media-preview";
  const mediaRequests: Array<{ resourceType: string; cookie: string; path: string }> = [];
  await page.context().addCookies([{ name: "media_test_session", value: "present", domain: "127.0.0.1", path: "/" }]);
  await page.route(`**/api/admin/bookings/${bookingId}/media/*`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    mediaRequests.push({ resourceType: request.resourceType(), cookie: request.headers().cookie || "", path });
    if (path.endsWith("/media-6")) {
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "MEDIA_FORBIDDEN", message: "无权查看照片" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
  });
  const kinds = [
    "vehicle_front_left",
    "vehicle_front_right",
    "vehicle_rear_left",
    "vehicle_rear_right",
    "dashboard_started",
    "license_front",
    "license_back",
  ];
  await page.route("**/api/admin/bookings?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [{
        id: bookingId,
        bookingNumber: "YXM-PREVIEW-001",
        status: "completed",
        fulfillmentStatus: "completed",
        paymentStatus: "paid",
        appointmentDate: "2026-08-20",
        startTime: "15:00",
        endTime: "16:00",
        contactName: "预览测试",
        contactPhone: "13800000000",
        serviceMode: "valet",
        serviceFeeFen: 36900,
        inspectionFeeFen: 26000,
        valetFeeFen: 10900,
        quoteDistanceKm: 7.8,
        oneWayDistanceKm: 7.8,
        quoteSource: "tencent_matrix",
        vehiclePriceCategory: "fuel_small",
        chargedFen: 36900,
        paidFen: 36900,
        refundedFen: 0,
        pendingAdjustmentFen: 0,
        paymentSummary: { paidFen: 36900, refundedFen: 0, balanceFen: 0 },
        station: { id: "station-preview", name: "预览测试检测站", district: "河西区" },
        vehicle: { plateNumber: "津A·P8888", vehicleType: "小型轿车", seats: 5 },
        media: kinds.map((kind, index) => ({ id: `media-${index}`, kind, url: `/api/admin/bookings/${bookingId}/media/media-${index}`, width: 1200, height: 900 })),
      }] }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText("津A·P8888", { exact: true }).click();

  const drawer = page.getByLabel("预约与账务详情");
  const firstTrigger = drawer.getByRole("button", { name: "查看车辆左前大图" });
  await expect(drawer.getByText("7 / 7", { exact: true })).toBeVisible();
  await expect(firstTrigger).toBeVisible();
  await expect(drawer.getByRole("button", { name: "查看启动后仪表盘大图" })).toBeVisible();
  const failedTrigger = drawer.getByRole("button", { name: "查看行驶证副页大图" });
  await expect(failedTrigger.locator('[data-authenticated-media-state="error"]')).toBeVisible();
  await expect(failedTrigger.locator("img")).toHaveCount(0);
  await expect(failedTrigger.getByRole("img", { name: "行驶证副页加载失败" })).toBeVisible();
  await expect.poll(() => mediaRequests.length).toBeGreaterThanOrEqual(kinds.length);
  expect(mediaRequests.every((request) => request.resourceType === "fetch")).toBe(true);
  expect(mediaRequests.every((request) => request.cookie.includes("media_test_session=present"))).toBe(true);
  await firstTrigger.click();

  const lightbox = page.locator(".media-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox).toHaveAttribute("aria-label", "车辆左前图片预览");
  await expect(lightbox.getByRole("img", { name: "车辆左前大图" })).toBeVisible();
  await expect(lightbox).toContainText("1 / 7");

  await page.keyboard.press("ArrowRight");
  await expect(lightbox).toHaveAttribute("aria-label", "车辆右前图片预览");
  await expect(lightbox.getByRole("img", { name: "车辆右前大图" })).toBeVisible();
  await expect(lightbox).toContainText("2 / 7");

  await lightbox.getByRole("button", { name: "上一张" }).click();
  await expect(lightbox).toHaveAttribute("aria-label", "车辆左前图片预览");
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
  await expect(firstTrigger).toBeFocused();

  await firstTrigger.click();
  await lightbox.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(lightbox).toBeHidden();
  await expect(drawer).toBeVisible();

  await firstTrigger.click();
  await lightbox.click({ position: { x: 8, y: 8 } });
  await expect(lightbox).toBeHidden();
  await expect(drawer).toBeVisible();
});

test("车辆体检报告媒体使用后台会话读取且失败时不回退受保护地址", async ({ page }) => {
  const bookingId = "booking-private-report-media";
  const reportId = "report-private-media";
  const mediaPath = (mediaId: string) => `/api/admin/bookings/${bookingId}/checkup-report/media/${mediaId}`;
  const reportMedia = (id: string, kind: "front_left" | "safety_inspection_report") => ({
    id,
    bookingId,
    reportId,
    kind,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    width: 1200,
    height: 900,
    url: mediaPath(id),
    status: "bound",
    createdAt: "2026-08-22T02:10:00.000Z",
    boundAt: "2026-08-22T03:20:00.000Z",
    expiresAt: "2032-08-22T03:20:00.000Z",
  });
  const frontLeft = reportMedia("report-front-left", "front_left");
  const failedSafetyReport = reportMedia("report-safety-failed", "safety_inspection_report");
  const booking = {
    id: bookingId,
    bookingNumber: "YXM-PRIVATE-REPORT-001",
    status: "completed",
    fulfillmentStatus: "completed",
    paymentStatus: "paid",
    appointmentDate: "2026-08-22",
    startTime: "10:00",
    endTime: "11:00",
    contactName: "私有报告测试",
    contactPhone: "13800000016",
    serviceMode: "self_drive",
    serviceFeeFen: 26000,
    inspectionFeeFen: 26000,
    valetFeeFen: 0,
    chargedFen: 26000,
    paidFen: 26000,
    refundedFen: 0,
    pendingAdjustmentFen: 0,
    paymentSummary: { paidFen: 26000, refundedFen: 0, balanceFen: 0 },
    station: { id: "station-private-report", name: "私有报告测试检测站", district: "河西区", address: "天津市河西区测试路 1 号" },
    vehicle: { plateNumber: "津A·R2608", vehicleType: "小型轿车", seats: 5 },
    events: [],
    media: [],
    vehicleCheckupReport: {
      id: reportId,
      bookingId,
      reportNo: "YXM-CHK-PRIVATE-001",
      schemaVersion: "vehicle-checkup-v2",
      status: "published",
      observationMode: "no_visible_faults",
      diagramVersion: "sedan-3view-v1",
      summary: { summary: "私有媒体鉴权测试报告。" },
      rowVersion: 1,
      annualInspection: {
        conclusion: "passed",
        conclusionStatus: "available",
        failureDetails: null,
        failureDetailsStatus: "not_applicable",
        markStatus: "issued",
        markPhoto: null,
      },
      legalMaterials: {
        safetyInspectionReport: failedSafetyReport,
        emissionsInspectionReport: null,
        annualInspectionMark: null,
        status: "available",
      },
      sitePhotos: { frontLeft, frontRight: null, rearLeft: null, rearRight: null, dashboardStarted: null },
      faults: [],
      media: [frontLeft, failedSafetyReport],
      createdAt: "2026-08-22T02:10:00.000Z",
      publishedAt: "2026-08-22T03:20:00.000Z",
      updatedAt: "2026-08-22T03:20:00.000Z",
      retainUntil: "2032-08-22T03:20:00.000Z",
    },
  };
  const mediaRequests: Array<{ resourceType: string; cookie: string; path: string }> = [];
  await page.context().addCookies([{ name: "media_test_session", value: "present", domain: "127.0.0.1", path: "/" }]);
  await page.route("**/api/admin/bookings**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith(`/api/admin/bookings/${bookingId}/checkup-report/media/`)) {
      mediaRequests.push({ resourceType: request.resourceType(), cookie: request.headers().cookie || "", path: pathname });
      if (pathname.endsWith("/report-safety-failed")) {
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "MEDIA_FORBIDDEN", message: "无权查看报告材料" } }) });
      }
      return route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
    }
    if (pathname === "/api/admin/bookings") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ ...booking, vehicleCheckupReport: null }] }) });
    }
    if (pathname === `/api/admin/bookings/${bookingId}`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: booking }) });
    }
    return route.continue();
  });

  await page.goto("/");
  await page.getByText("津A·R2608", { exact: true }).click();
  const report = page.getByLabel("预约与账务详情").getByLabel("车辆体检报告");
  const frontTrigger = report.getByRole("button", { name: "查看车辆左前大图" });
  const failedTrigger = report.getByRole("button", { name: "查看机动车安全技术检验报告大图" });
  await expect(frontTrigger.locator('[data-authenticated-media-state="ready"]')).toBeVisible();
  await expect(failedTrigger.locator('[data-authenticated-media-state="error"]')).toBeVisible();
  await expect(failedTrigger.locator("img")).toHaveCount(0);
  await expect(failedTrigger.getByRole("img", { name: "机动车安全技术检验报告加载失败" })).toBeVisible();
  await expect.poll(() => mediaRequests.length).toBeGreaterThanOrEqual(2);
  expect(mediaRequests.every((request) => request.resourceType === "fetch")).toBe(true);
  expect(mediaRequests.every((request) => request.cookie.includes("media_test_session=present"))).toBe(true);
  await frontTrigger.click();
  await expect(page.locator(".checkup-lightbox").getByRole("img", { name: /车辆左前.*大图/ })).toBeVisible();
});

test("预约详情展示车辆体检报告并联动车况定位与现场影像预览", async ({ page }) => {
  const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const bookingId = "booking-checkup-report";
  const createdAt = "2026-08-22T02:10:00.000Z";
  const publishedAt = "2026-08-22T03:20:00.000Z";
  const retainUntil = "2032-08-22T03:20:00.000Z";
  const mediaKinds = [
    "front_left",
    "front_right",
    "rear_left",
    "rear_right",
    "dashboard_started",
    "safety_inspection_report",
    "emissions_inspection_report",
    "annual_inspection_mark",
  ] as const;
  const checkupMedia = mediaKinds.map((kind, index) => ({
    id: `checkup-media-${index + 1}`,
    bookingId,
    reportId: "checkup-report-1",
    kind,
    mimeType: "image/jpeg",
    sizeBytes: 32_768 + index,
    width: 1600,
    height: 1200,
    url: pixel,
    status: "bound",
    createdAt,
    boundAt: publishedAt,
    expiresAt: retainUntil,
  }));
  const faultEvidence = (faultId: string, count: number) => Array.from({ length: count }, (_, index) => ({
    id: `${faultId}-photo-${index + 1}`,
    bookingId,
    reportId: "checkup-report-1",
    faultId,
    kind: "fault_closeup" as const,
    sequence: index + 1,
    mimeType: "image/jpeg",
    sizeBytes: 40_960 + index,
    width: 1440,
    height: 1080,
    url: pixel,
    status: "bound" as const,
    createdAt,
    boundAt: publishedAt,
    expiresAt: retainUntil,
  }));
  const booking = {
    id: bookingId,
    bookingNumber: "YXM-CHECKUP-001",
    status: "completed",
    fulfillmentStatus: "completed",
    paymentStatus: "paid",
    appointmentDate: "2026-08-22",
    startTime: "10:00",
    endTime: "11:00",
    contactName: "车况报告测试",
    contactPhone: "13800000006",
    serviceMode: "self_drive",
    serviceFeeFen: 26000,
    inspectionFeeFen: 26000,
    valetFeeFen: 0,
    quoteDistanceKm: null,
    oneWayDistanceKm: null,
    quoteSource: "station_reference",
    vehiclePriceCategory: "fuel_small",
    chargedFen: 26000,
    paidFen: 26000,
    refundedFen: 0,
    pendingAdjustmentFen: 0,
    paymentSummary: { paidFen: 26000, refundedFen: 0, balanceFen: 0 },
    station: { id: "station-checkup", name: "车辆体检测试检测站", district: "滨海新区", address: "天津市滨海新区测试大道 26 号" },
    vehicle: {
      plateNumber: "津A·C2606",
      vehicleType: "小型轿车",
      seats: 5,
      brand: { id: "brand-bmw", name: "宝马" },
      model: { id: "vehicle-bmw-5", name: "5系" },
    },
    createdAt,
    events: [
      { id: "event-confirmed", status: "confirmed", title: "预约已确认", description: "模拟支付后自动确认", createdAt: "2026-08-22T02:12:00.000Z" },
      { id: "event-awaiting", status: "awaiting_arrival", title: "等待到站", description: "检测站准备接待", createdAt: "2026-08-22T02:20:00.000Z" },
      { id: "event-checked", status: "checked_in", title: "车辆已到站", description: "完成到站核验", createdAt: "2026-08-22T02:32:00.000Z" },
      { id: "event-inspecting", status: "inspecting", title: "检测中", description: "进入检测环节", createdAt: "2026-08-22T02:40:00.000Z" },
      { id: "event-result", status: "result_received", title: "结果已回传", description: "检测结果已接收", createdAt: publishedAt },
      { id: "event-completed", status: "completed", title: "服务完成", description: "客户已收到结果", createdAt: "2026-08-22T03:25:00.000Z" },
    ],
    media: [],
    vehicleCheckupReport: {
      id: "checkup-report-1",
      bookingId,
      reportNo: "YXM-CHK-20260822-TEST0001",
      schemaVersion: "vehicle-checkup-v2",
      status: "published",
      observationMode: "faults_recorded",
      diagramVersion: "sedan-3view-v1",
      summary: { summary: "车身存在四条外观记录，车辆年检结论为通过。" },
      rowVersion: 4,
      annualInspection: {
        conclusion: "passed",
        conclusionStatus: "available",
        failureDetails: null,
        failureDetailsStatus: "not_applicable",
        markStatus: "issued",
        markPhoto: checkupMedia[7],
      },
      legalMaterials: {
        safetyInspectionReport: checkupMedia[5],
        emissionsInspectionReport: checkupMedia[6],
        annualInspectionMark: checkupMedia[7],
        status: "available",
      },
      sitePhotos: {
        frontLeft: checkupMedia[0],
        frontRight: checkupMedia[1],
        rearLeft: checkupMedia[2],
        rearRight: checkupMedia[3],
        dashboardStarted: checkupMedia[4],
      },
      media: checkupMedia,
      faults: [
        {
          id: "fault-front-bumper",
          sequence: 1,
          viewId: "top",
          regionCode: "front_bumper",
          faultType: "scratch",
          severity: "minor",
          description: "右侧边缘约 4 厘米划痕",
          photos: faultEvidence("fault-front-bumper", 1),
        },
        {
          id: "fault-right-quarter",
          sequence: 2,
          viewId: "right",
          regionCode: "right_rear_quarter",
          faultType: "paint_damage",
          severity: "severe",
          description: "轮眉上方掉漆",
          photos: faultEvidence("fault-right-quarter", 2),
        },
        {
          id: "fault-left-door",
          sequence: 3,
          viewId: "left",
          regionCode: "left_front_door",
          faultType: "dent",
          severity: "moderate",
          description: "门板中部浅凹陷",
          photos: faultEvidence("fault-left-door", 3),
        },
        {
          id: "fault-right-quarter-scratch",
          sequence: 4,
          viewId: "right",
          regionCode: "right_rear_quarter",
          faultType: "scratch",
          severity: "minor",
          description: "轮眉后缘轻微划痕",
          photos: faultEvidence("fault-right-quarter-scratch", 1),
        },
      ],
      createdAt,
      updatedAt: publishedAt,
      publishedAt,
      retainUntil,
    },
  };
  const legacyBookingId = "booking-checkup-report-v1";
  const legacyBooking = {
    ...booking,
    id: legacyBookingId,
    bookingNumber: "YXM-CHECKUP-V1",
    vehicle: { ...booking.vehicle, plateNumber: "津A·V1001" },
    vehicleCheckupReport: {
      ...booking.vehicleCheckupReport,
      id: "checkup-report-v1",
      bookingId: legacyBookingId,
      reportNo: "YXM-CHK-20260822-LEGACY",
      schemaVersion: "vehicle-checkup-v1",
      annualInspection: { conclusion: null, conclusionStatus: "legacy_requires_reentry", failureDetails: null, failureDetailsStatus: "pending", markStatus: "not_issued", markPhoto: null },
      legalMaterials: { safetyInspectionReport: null, emissionsInspectionReport: null, annualInspectionMark: null, status: "legacy_missing" },
      media: checkupMedia.slice(0, 5),
      faults: booking.vehicleCheckupReport.faults.map(({ photos: _photos, ...fault }) => fault),
    },
  };
  const failedBookingId = "booking-checkup-report-failed";
  const failedBooking = {
    ...booking,
    id: failedBookingId,
    bookingNumber: "YXM-CHECKUP-FAILED",
    vehicle: { ...booking.vehicle, plateNumber: "津A·F2608" },
    vehicleCheckupReport: {
      ...booking.vehicleCheckupReport,
      id: "checkup-report-failed",
      bookingId: failedBookingId,
      reportNo: "YXM-CHK-20260822-FAILED",
      annualInspection: {
        conclusion: "failed",
        conclusionStatus: "available",
        markStatus: "not_issued",
        markPhoto: null,
        failureDetails: {
          itemCategories: ["instrumented_test", "safety_devices"],
          reason: "制动项目检测值不符合要求，安全带固定状态异常。",
          reinspectionAdvice: "完成制动系统与安全带固定点整改后，预约相关项目复检。",
        },
        failureDetailsStatus: "complete",
      },
      media: checkupMedia,
    },
  };

  await page.route("**/api/admin/bookings**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/admin/bookings") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [{ ...booking, vehicleCheckupReport: null }, { ...legacyBooking, vehicleCheckupReport: null }, { ...failedBooking, vehicleCheckupReport: null }] }),
      });
    }
    if (pathname === `/api/admin/bookings/${bookingId}`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: booking }),
      });
    }
    if (pathname === `/api/admin/bookings/${legacyBookingId}`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: legacyBooking }) });
    }
    if (pathname === `/api/admin/bookings/${failedBookingId}`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: failedBooking }) });
    }
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByText("津A·C2606", { exact: true }).click();

  const drawer = page.getByLabel("预约与账务详情");
  const journey = drawer.getByLabel("履约全景");
  await expect(journey).toContainText("履约流程");
  await expect(journey).not.toContainText("FULFILLMENT JOURNEY");
  await expect(journey).toContainText("车主自驾到站");
  await expect(journey.locator('[data-status="completed"]')).toContainText("2026-08-22 11:25");
  const selfDriveService = drawer.getByLabel("自驾到站服务信息");
  await expect(selfDriveService).toContainText("服务方式");
  await expect(selfDriveService).not.toContainText("SERVICE MODE");
  await expect(selfDriveService).toContainText("天津市滨海新区测试大道 26 号");
  const report = drawer.getByLabel("车辆体检报告");
  await expect(report).toBeVisible();
  await expect(report).toContainText("YXM-CHK-20260822-TEST0001");
  await expect(report.locator(".checkup-conclusion")).toHaveText("年检通过");
  const materialSummary = report.getByLabel("报告材料摘要");
  await expect(materialSummary).toContainText("法定检测材料安全报告已归档");
  await expect(materialSummary).toContainText("平台车辆体检留证5 / 5");
  await expect(materialSummary).toContainText("故障证据4 / 4 项完整");
  await expect(materialSummary).toContainText("共 7 张故障特写");
  await expect(report.getByRole("alert", { name: "报告材料完整性提示" })).toHaveCount(0);
  await expect(report.getByRole("heading", { name: "报告基本信息" })).toBeVisible();
  const reportMeta = report.getByLabel("报告基本信息");
  await expect(reportMeta).toContainText("津A·C2606 · 宝马 5系 小型轿车");
  await expect(reportMeta).not.toContainText("[object Object]");
  await expect(reportMeta).toContainText("车辆体检测试检测站");
  await expect(report.getByLabel("年检结论与检测说明")).toContainText("车身存在四条外观记录");
  await expect(report.getByLabel("车身状况文字结论")).toContainText("明显 1 项、一般 1 项、轻微 2 项");
  await expect(report.getByRole("region", { name: "故障明细", exact: true })).toContainText("轮眉上方掉漆");
  await expect(report.getByRole("region", { name: "故障明细", exact: true })).toContainText("尽快安排钣金或漆面专业检修");
  await expect(report.getByLabel("汇总处理建议")).toContainText("共 1 项明显问题");
  await expect(report.getByLabel("报告备注")).toContainText("不生成检测机构签章或监管系统凭证");
  await expect(report.getByRole("button", { name: "打印报告" })).toBeVisible();
  await expect(report.locator(".checkup-fault-list > button")).toHaveCount(4);
  await expect(report.locator(".checkup-diagram-note")).toHaveText("轿车 · 通用车身示意（不代表实车外观）；故障以位置文字和现场照片为准");
  await expect(report.getByRole("list", { name: "车辆故障明细列表" }).getByRole("listitem")).toHaveCount(4);
  await expect(report.locator(".checkup-fault-photo-grid figure")).toHaveCount(7);

  const topTab = report.getByRole("tab", { name: "俯视" });
  const leftTab = report.getByRole("tab", { name: "左侧" });
  const rightTab = report.getByRole("tab", { name: "右侧" });
  await expect(topTab).toHaveAttribute("aria-selected", "true");
  await leftTab.click();
  await expect(leftTab).toHaveAttribute("aria-selected", "true");
  await expect(report.getByRole("img", { name: "左侧车辆示意图" })).toBeVisible();
  await rightTab.click();
  await expect(rightTab).toHaveAttribute("aria-selected", "true");
  await expect(report.getByRole("img", { name: "右侧车辆示意图" })).toBeVisible();
  const rightQuarterFault = report.locator(".checkup-fault-list > button").filter({ hasText: "掉漆 · 明显" });
  await rightQuarterFault.click();
  await expect(rightQuarterFault).toHaveClass(/active/);
  await expect(report.getByRole("status")).toContainText("故障 #2");
  const rightQuarterHotspot = report.getByRole("button", { name: "右后翼子板，故障 #2，共2条车况记录" });
  await expect(rightQuarterHotspot.locator("b")).toHaveText("2");
  await expect(rightQuarterHotspot).toHaveAttribute("style", /left: 11%; top: 54%/);
  const rightQuarterEvidence = report.getByLabel("故障 #2 影像证据");
  await expect(rightQuarterEvidence).toContainText("2 张特写");
  await rightQuarterEvidence.getByRole("button", { name: "查看故障 #2 右后翼子板特写 1" }).click();
  const faultPreview = page.getByRole("dialog", { name: "故障 #2 · 右后翼子板特写图片预览" });
  await expect(faultPreview).toBeVisible();
  await expect(faultPreview).toContainText("1 / 2");
  await faultPreview.getByRole("button", { name: "下一张" }).click();
  await expect(faultPreview.getByRole("img", { name: "故障 #2 · 右后翼子板特写 2大图" })).toBeVisible();
  await faultPreview.getByRole("button", { name: "关闭体检图片预览" }).click();
  await expect(faultPreview).toBeHidden();
  await expect(rightQuarterFault).toHaveClass(/active/);
  await expect(drawer).toBeVisible();

  const leftDoorFault = report.locator(".checkup-fault-list > button").filter({ hasText: "左前门" });
  await leftDoorFault.click();
  await expect(leftDoorFault).toHaveClass(/active/);
  await expect(leftTab).toHaveAttribute("aria-selected", "true");
  await expect(report.getByRole("status")).toContainText("左前门 · 凹陷");
  await expect(report.getByRole("status")).toContainText("门板中部浅凹陷");

  await topTab.click();
  await report.getByRole("button", { name: "前保险杠，故障 #1，共1条车况记录" }).click();
  await expect(report.locator(".checkup-fault-list > button").filter({ hasText: "前保险杠" })).toHaveClass(/active/);
  await expect(report.getByRole("status")).toContainText("前保险杠 · 划痕");

  const sitePhotoSection = report.getByLabel("平台车辆体检留证");
  await expect(sitePhotoSection.getByRole("heading", { name: "平台车辆体检留证" })).toBeVisible();
  await expect(sitePhotoSection).toContainText("5 / 5 · 固定 5 张");
  await expect(sitePhotoSection.locator(".checkup-media-grid figure")).toHaveCount(5);
  const resultMaterialSection = report.getByRole("region", { name: "法定检测材料", exact: true });
  await expect(resultMaterialSection.getByRole("heading", { name: "法定检测材料" })).toBeVisible();
  await expect(resultMaterialSection).toContainText("3 件 · 安全报告已归档");
  await expect(resultMaterialSection).toContainText("法定材料 01 · 机动车安全技术检验报告");
  await expect(resultMaterialSection).toContainText("法定材料 03 · 检验合格标志/电子凭证留证");
  await expect(resultMaterialSection.locator(".checkup-media-grid figure")).toHaveCount(3);
  const annualMarkTrigger = resultMaterialSection.getByRole("button", { name: "查看检验合格标志/电子凭证留证大图" });
  await annualMarkTrigger.click();
  const annualMarkPreview = page.getByRole("dialog", { name: "检验合格标志/电子凭证留证图片预览" });
  await expect(annualMarkPreview).toBeVisible();
  const singlePreviewImageBounds = await annualMarkPreview.getByRole("img", { name: "检验合格标志/电子凭证留证 3大图" }).boundingBox();
  expect(singlePreviewImageBounds?.width).toBeGreaterThan(300);
  await page.keyboard.press("Escape");
  await expect(annualMarkPreview).toBeHidden();
  await expect(annualMarkTrigger).toBeFocused();
  const fixedPhotoTrigger = report.getByRole("button", { name: "查看车辆左前大图" });
  await fixedPhotoTrigger.click();

  const preview = page.getByRole("dialog", { name: "车辆左前图片预览" });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("img", { name: "车辆左前 1大图" })).toBeVisible();
  const closePreview = preview.getByRole("button", { name: "关闭体检图片预览" });
  const nextPreview = preview.getByRole("button", { name: "下一张" });
  await expect(closePreview).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(nextPreview).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closePreview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(fixedPhotoTrigger).toBeFocused();
  await expect(drawer).toBeVisible();
  await expect(report).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer).toBeVisible();
  expect(Math.round((await drawer.boundingBox())?.width ?? 0)).toBe(390);
  const drawerCloseBounds = await drawer.getByRole("button", { name: "关闭预约详情" }).boundingBox();
  expect(drawerCloseBounds?.width).toBeGreaterThanOrEqual(44);
  expect(drawerCloseBounds?.height).toBeGreaterThanOrEqual(44);
  const touchTargets = [
    report.getByRole("button", { name: "打印报告" }),
    topTab,
    leftTab,
    rightTab,
    report.locator(".checkup-hotspot").first(),
    report.getByRole("button", { name: "在三视图定位" }).first(),
    drawer.getByRole("button", { name: "保存协调备注" }),
    drawer.getByRole("button", { name: "提交附加费待车主确认" }),
  ];
  for (const target of touchTargets) {
    const bounds = await target.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await drawer.locator(".drawer-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await journey.locator("ol").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(journey.locator("li strong").first()).not.toHaveCSS("white-space", "nowrap");
  await fixedPhotoTrigger.click();
  await expect(preview).toBeVisible();
  const previewBounds = await preview.boundingBox();
  const previewPanelBounds = await preview.locator(":scope > div").boundingBox();
  expect(previewBounds?.width).toBe(390);
  expect((previewPanelBounds?.width ?? 391) <= 370).toBe(true);
  expect((previewPanelBounds?.height ?? 845) <= 824).toBe(true);
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(fixedPhotoTrigger).toBeFocused();

  await page.emulateMedia({ media: "print" });
  const printLocator = report.getByLabel("打印版故障位置总览");
  await expect(printLocator).toBeVisible();
  await expect(printLocator).toContainText("2、4");
  await expect(report.locator(".checkup-tech-panel")).toBeHidden();
  await expect(report.locator(".checkup-fault-photo-grid figure")).toHaveCount(7);
  await page.emulateMedia({ media: "screen" });

  await drawer.getByRole("button", { name: "关闭预约详情" }).click();
  await page.getByRole("button", { name: "查看津A·V1001预约详情" }).click();
  const legacyDrawer = page.getByLabel("预约与账务详情");
  const legacyReport = legacyDrawer.getByLabel("车辆体检报告");
  await expect(legacyReport.getByRole("alert", { name: "法定检测材料缺失提示" })).toContainText(/历史报告未采集法定检测材料[\s\S]*不补造材料/);
  await expect(legacyReport.getByLabel("报告材料摘要")).toContainText("故障证据0 / 4 项完整");
  await expect(legacyReport.getByRole("alert", { name: "报告材料完整性提示" })).toContainText(/历史报告未采集故障特写[\s\S]*旧版报告有 4 项故障未关联特写照片[\s\S]*不补造影像/);
  await expect(legacyReport.getByRole("alert", { name: "历史年检结果待重新录入" })).toContainText(/正式年检结果尚未确认[\s\S]*不会自动算作未通过/);
  await expect(legacyReport.locator(".checkup-conclusion")).toHaveText("历史结果待重新录入");
  await expect(legacyReport.getByRole("listitem", { name: "故障 #1 前保险杠" })).toContainText("系统不会补造图片");
  await legacyDrawer.getByRole("button", { name: "关闭预约详情" }).click();
  await page.getByRole("button", { name: "查看津A·F2608预约详情" }).click();
  const failedReport = page.getByLabel("预约与账务详情").getByLabel("车辆体检报告");
  await expect(failedReport.locator(".checkup-conclusion")).toHaveText("年检未通过");
  const failedDetails = failedReport.getByLabel("年检未通过明细");
  await expect(failedDetails).toContainText("仪器设备检验、安全装置检查");
  await expect(failedDetails).toContainText("制动项目检测值不符合要求");
  await expect(failedDetails).toContainText("整改后，预约相关项目复检");
  const failedSitePhotos = failedReport.getByLabel("平台车辆体检留证");
  await expect(failedSitePhotos).toContainText("5 / 5 · 固定 5 张");
  await expect(failedSitePhotos.locator(".checkup-media-grid figure")).toHaveCount(5);
  const failedResultMaterials = failedReport.getByRole("region", { name: "法定检测材料", exact: true });
  await expect(failedResultMaterials).toContainText("未通过 · 不适用");
  await expect(failedResultMaterials).toContainText("机动车安全技术检验报告");
  await expect(failedResultMaterials.locator(".checkup-media-grid figure")).toHaveCount(2);
  await expect(failedReport.getByText(/法定材料 \d+ · 检验合格标志\/电子凭证留证/)).toHaveCount(0);
});

test("代驾详情按真实事件展示全链路、取送地址与司机调度信息", async ({ page }) => {
  const station = { id: "station-valet-flow", name: "华洋机动车检测站", district: "滨海新区", address: "天津市滨海新区海滨大道 3680 号" };
  const bookingBase = {
    status: "confirmed",
    paymentStatus: "paid",
    appointmentDate: "2026-08-23",
    startTime: "14:00",
    endTime: "15:00",
    contactName: "赵先生",
    contactPhone: "13800001380",
    serviceMode: "valet",
    serviceFeeFen: 36900,
    inspectionFeeFen: 26000,
    valetFeeFen: 10900,
    quoteDistanceKm: 7.8,
    oneWayDistanceKm: 7.8,
    quoteSource: "tencent_matrix",
    vehiclePriceCategory: "fuel_small",
    chargedFen: 36900,
    paidFen: 36900,
    refundedFen: 0,
    pendingAdjustmentFen: 0,
    paymentSummary: { paidFen: 36900, refundedFen: 0, balanceFen: 0 },
    station,
    pickupAddress: { title: "天津文化中心地下停车场", address: "天津市河西区平江道 58 号", district: "河西区", detail: "B2-156", note: "从北门进入，提前电话联系", latitude: 39.0837, longitude: 117.2197 },
    media: [],
    vehicleCheckupReport: null,
    createdAt: "2026-08-23T01:00:00+08:00",
  };
  const assigned = {
    ...bookingBase,
    id: "booking-valet-assigned",
    bookingNumber: "YXM-VALET-ASSIGNED",
    fulfillmentStatus: "returning",
    status: "result_received",
    vehicle: { plateNumber: "津A·V5208", vehicleType: "小型轿车", seats: 5 },
    internalDriverNote: "司机完成检测站交接，预计 16:20 送回原地址。",
    events: [
      { id: "v-confirmed", status: "confirmed", title: "预约已确认", description: "模拟支付成功", createdAt: "2026-08-23T01:05:00+08:00" },
      { id: "v-driver", status: "driver_arranged", title: "司机已安排", description: "调度已确认", metadata: { driverName: "王师傅", driverPhone: "13800138888", dispatcherName: "李调度", dispatcherPhone: "022-88886666" }, createdAt: "2026-08-23T01:18:00+08:00" },
      { id: "v-picked", status: "picked_up", title: "车辆已取走", description: "完成取车", createdAt: "2026-08-23T01:45:00+08:00" },
      { id: "v-checked", status: "checked_in", title: "车辆已到站", description: "完成到站核验", createdAt: "2026-08-23T02:12:00+08:00" },
      { id: "v-inspecting", status: "inspecting", title: "检测中", description: "进入检测", createdAt: "2026-08-23T02:20:00+08:00" },
      { id: "v-result", status: "result_received", title: "结果已回传", description: "检测结果接收", createdAt: "2026-08-23T03:10:00+08:00" },
      { id: "v-returning", status: "returning", title: "返程中", description: "司机送回车辆", createdAt: "2026-08-23T03:18:00+08:00" },
    ],
  };
  const unassigned = {
    ...bookingBase,
    id: "booking-valet-unassigned",
    bookingNumber: "YXM-VALET-UNASSIGNED",
    fulfillmentStatus: "confirmed",
    vehicle: { plateNumber: "津B·U2608", vehicleType: "小型轿车", seats: 5 },
    internalDriverNote: null,
    events: [{ id: "u-confirmed", status: "confirmed", title: "预约已确认", description: "等待调度", createdAt: "2026-08-23T01:06:00+08:00" }],
  };
  const inconsistent = {
    ...bookingBase,
    id: "booking-valet-inconsistent",
    bookingNumber: "YXM-VALET-INCONSISTENT",
    fulfillmentStatus: "inspecting",
    vehicle: { plateNumber: "津C·T2608", vehicleType: "小型轿车", seats: 5 },
    events: [
      { id: "i-confirmed", status: "confirmed", title: "预约已确认", description: "已确认", createdAt: "2026-08-23T10:00:00+08:00" },
      { id: "i-picked", status: "picked_up", title: "车辆已取走", description: "完成取车", createdAt: "2026-08-23T11:00:00+08:00" },
      { id: "i-checked", status: "checked_in", title: "车辆已到站", description: "倒序测试记录", createdAt: "2026-08-23T10:30:00+08:00" },
      { id: "i-inspecting", status: "inspecting", title: "检测中", description: "无效时间测试记录", createdAt: "invalid-time" },
      { id: "i-completed", status: "completed", title: "已完成", description: "超前测试记录", createdAt: "2026-08-23T12:00:00+08:00" },
    ],
  };

  await page.route("**/api/admin/bookings**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/admin/bookings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [assigned, unassigned, inconsistent] }) });
    if (pathname === `/api/admin/bookings/${assigned.id}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: assigned }) });
    if (pathname === `/api/admin/bookings/${unassigned.id}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: unassigned }) });
    if (pathname === `/api/admin/bookings/${inconsistent.id}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: inconsistent }) });
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByText("津A·V5208", { exact: true }).click();
  let drawer = page.getByLabel("预约与账务详情");
  const assignedJourney = drawer.getByLabel("履约全景");
  await expect(assignedJourney.locator("li")).toHaveCount(10);
  await expect(assignedJourney.locator('[data-status="driver_arranged"]')).toContainText("2026-08-23 01:18");
  await expect(assignedJourney.locator('[data-status="returning"]')).toHaveClass(/current/);
  await expect(assignedJourney.locator('[data-status="returning"]')).toContainText("2026-08-23 03:18");
  await expect(assignedJourney.locator('[data-status="completed"]')).toContainText("待进行");
  const valetInfo = drawer.getByLabel("代驾取送服务信息");
  await expect(valetInfo).toContainText("天津文化中心地下停车场 · B2-156");
  await expect(valetInfo).toContainText("取车并送回同一地址");
  await expect(valetInfo).toContainText("赵先生");
  await expect(valetInfo).toContainText("王师傅");
  await expect(valetInfo).toContainText("13800138888");
  await expect(valetInfo).toContainText("李调度");
  await expect(valetInfo).toContainText("022-88886666");
  await expect(valetInfo).toContainText("预计 16:20 送回原地址");
  await expect(drawer.getByRole("alert", { name: "车辆体检报告缺失" })).toContainText(/未形成结构化车辆体检报告[\s\S]*材料闭环不完整[\s\S]*核对原始检测站报告[\s\S]*不会伪造或自动补齐/);

  await drawer.getByRole("button", { name: "关闭预约详情" }).click();
  await page.getByText("津B·U2608", { exact: true }).click();
  drawer = page.getByLabel("预约与账务详情");
  const unassignedInfo = drawer.getByLabel("代驾取送服务信息");
  await expect(unassignedInfo).toContainText("接待人尚未安排");
  await expect(unassignedInfo).toContainText("调度人员未记录");
  await expect(unassignedInfo).toContainText("暂无司机与调度备注");
  await expect(drawer.getByLabel("接待人安排").getByRole("button", { name: "安排接待人并生成验证码" })).toBeVisible();

  await drawer.getByRole("button", { name: "关闭预约详情" }).click();
  await page.getByText("津C·T2608", { exact: true }).click();
  const inconsistentJourney = page.getByLabel("预约与账务详情").getByLabel("履约全景");
  await expect(inconsistentJourney.locator('[data-status="driver_arranged"]')).toContainText("流程已越过 · 未记录节点事件");
  await expect(inconsistentJourney.locator('[data-status="checked_in"]')).toContainText("记录时间顺序异常");
  await expect(inconsistentJourney.locator('[data-status="inspecting"]')).toContainText("存在节点记录 · 时间格式异常");
  await expect(inconsistentJourney.locator('[data-status="completed"]')).toContainText("存在超前记录");
  await expect(inconsistentJourney.getByRole("alert")).toContainText("按服务端原始记录展示");
  await expect(inconsistentJourney).toContainText("有 2 个已越过节点缺少独立事件记录");
});

test("代驾详情支持一单一司机验证码、四阶段留证预览并保护现场状态", async ({ page }) => {
  const bookingId = "booking-valet-evidence";
  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const photoKinds = ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"] as const;
  const evidence = (stage: "owner_pickup" | "station_arrival" | "inspection_complete" | "owner_return", status: "pending" | "completed", count = 5) => ({
    id: `evidence-${stage}`,
    stage,
    status,
    capturedAt: "2026-08-24T10:20:00+08:00",
    capturedByLabel: stage === "owner_pickup" || stage === "owner_return" ? "王师傅" : "华洋机动车检测站",
    photos: photoKinds.slice(0, count).map((kind, index) => ({
      id: `${stage}-${index}`,
      kind,
      url: `/api/admin/bookings/${bookingId}/evidence/evidence-${stage}/media/${stage}-${index}`,
      createdAt: "2026-08-24T10:20:00+08:00",
    })),
  });
  const booking = {
    id: bookingId,
    bookingNumber: "YXM-VALET-EVIDENCE",
    status: "confirmed",
    fulfillmentStatus: "driver_arranged",
    paymentStatus: "paid",
    appointmentDate: "2026-08-24",
    startTime: "14:00",
    endTime: "15:00",
    contactName: "赵先生",
    contactPhone: "13800001380",
    serviceMode: "valet",
    serviceFeeFen: 36900,
    inspectionFeeFen: 26000,
    valetFeeFen: 10900,
    quoteDistanceKm: 7.8,
    oneWayDistanceKm: 7.8,
    quoteSource: "tencent_matrix",
    vehiclePriceCategory: "fuel_small",
    chargedFen: 36900,
    paidFen: 36900,
    refundedFen: 0,
    pendingAdjustmentFen: 0,
    paymentSummary: { paidFen: 36900, refundedFen: 0, balanceFen: 0 },
    station: { id: "station-evidence", name: "华洋机动车检测站", district: "滨海新区", address: "天津市滨海新区海滨大道 3680 号" },
    pickupAddress: { title: "天津文化中心地下停车场", address: "天津市河西区平江道 58 号", district: "河西区", detail: "B2-156", latitude: 39.0837, longitude: 117.2197 },
    vehicle: { plateNumber: "津A·E0520", vehicleType: "小型轿车", seats: 5 },
    driverAssignment: { id: "assignment-1", status: "assigned", receptionistName: "王师傅", receptionistPhone: "13800138888", assignedAt: "2026-08-24T09:00:00+08:00", boundAt: null, verificationCode: "351240", verificationCodeExpiresAt: "2026-08-25T09:00:00+08:00", verificationCodeStatus: "active" },
    evidencePolicyVersion: "valet-handoff-v1",
    evidencePackages: [
      evidence("owner_pickup", "completed"),
      evidence("station_arrival", "completed"),
      evidence("inspection_complete", "completed"),
      evidence("owner_return", "pending", 2),
    ],
    media: [],
    events: [],
    vehicleCheckupReport: null,
    createdAt: "2026-08-24T08:30:00+08:00",
  };
  const assignmentWrites: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const evidenceMediaRequests: Array<{ resourceType: string; cookie: string; path: string }> = [];
  await page.route("**/api/admin/bookings**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.includes(`/api/admin/bookings/${booking.id}/evidence/`)) {
      evidenceMediaRequests.push({ resourceType: request.resourceType(), cookie: request.headers().cookie || "", path: url.pathname });
      if (url.pathname.endsWith("/owner_return-0")) {
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "无权读取这张留证" } }) });
      }
      return route.fulfill({ status: 200, contentType: "image/gif", body: pixel });
    }
    if (url.pathname === `/api/admin/bookings/${booking.id}/driver-assignment`) {
      assignmentWrites.push({ method: request.method(), body: request.postDataJSON() as Record<string, unknown> | undefined });
      if (request.method() === "POST") {
        Object.assign(booking.driverAssignment, { verificationCode: "482719", verificationCodeExpiresAt: "2026-08-25T10:00:00+08:00", verificationCodeStatus: "active" });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { assignment: booking.driverAssignment, verificationCode: "482719", taskCode: null, scene: null, entryPath: null, driverEntryPath: "/packages/driver/pages/login/login" } }) });
      }
      if (request.method() === "DELETE") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) });
    }
    if (url.pathname === "/api/admin/bookings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [booking] }) });
    if (url.pathname === `/api/admin/bookings/${booking.id}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: booking }) });
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByText("津A·E0520", { exact: true })).toBeVisible();
  await page.context().addCookies([{ name: "yxm_backoffice_session", value: "authenticated-media-e2e", url: page.url() }]);
  await page.getByText("津A·E0520", { exact: true }).click();
  const drawer = page.getByLabel("预约与账务详情");

  const driverPanel = drawer.getByLabel("接待人安排");
  await expect(driverPanel).toContainText("取车任务验证码（发群抢单）");
  await expect(driverPanel.getByLabel("接待人员姓名")).toHaveValue("王师傅");
  await expect(driverPanel.getByLabel("接待人员电话")).toHaveValue("13800138888");
  await expect(driverPanel.getByLabel("取车任务验证码", { exact: true })).toContainText("351 240");
  await expect(driverPanel.getByLabel("取车任务验证码", { exact: true })).toContainText("24小时内首次领取");
  await driverPanel.getByRole("button", { name: "重新生成验证码" }).click();
  await expect(driverPanel.getByLabel("取车任务验证码", { exact: true })).toContainText("482 719");
  await expect(driverPanel).not.toContainText("legacy-long-entry");
  await expect(driverPanel.getByRole("button", { name: "复制取车任务验证码" })).toBeVisible();
  expect(assignmentWrites.at(-1)).toEqual({ method: "POST", body: { receptionistName: "王师傅", receptionistPhone: "13800138888" } });
  await driverPanel.getByRole("button", { name: "使当前验证码失效" }).click();
  await expect(driverPanel).toContainText("取车任务验证码已失效，订单已恢复为等待安排接待人");
  expect(assignmentWrites.at(-1)?.method).toBe("DELETE");
  await page.setViewportSize({ width: 390, height: 844 });
  const arrangeDriverBounds = await driverPanel.locator(".driver-assignment-actions button").first().boundingBox();
  expect(arrangeDriverBounds?.width).toBeGreaterThanOrEqual(44);
  expect(arrangeDriverBounds?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);

  const evidencePanel = drawer.getByLabel("代驾履约留证");
  await expect(evidencePanel).toContainText("履约留证");
  await expect(evidencePanel).not.toContainText("FULFILLMENT EVIDENCE");
  await expect(evidencePanel).toContainText("3 / 4 阶段完整");
  await expect(evidencePanel.locator('[data-evidence-stage="owner_pickup"]')).toContainText("5 / 5");
  await expect(evidencePanel.locator('[data-evidence-stage="owner_return"]')).toContainText("2 / 5");
  await expect(evidencePanel).toContainText("检测站不能替司机完成送回");
  await expect(drawer.getByText("0 / 7", { exact: true })).toBeVisible();
  const firstEvidence = evidencePanel.getByRole("button", { name: "查看司机取车车辆左前大图" });
  await expect(firstEvidence.locator('[data-authenticated-media-state="ready"]')).toBeVisible();
  await expect(firstEvidence.locator("img")).toHaveAttribute("src", /^blob:/);
  const failedEvidence = evidencePanel.locator('[data-evidence-stage="owner_return"] button').first();
  await expect(failedEvidence.locator('[data-authenticated-media-state="error"]')).toBeVisible();
  await expect(failedEvidence.locator("img")).toHaveCount(0);
  await expect.poll(() => evidenceMediaRequests.length).toBeGreaterThan(0);
  expect(evidenceMediaRequests.every((request) => request.resourceType === "fetch")).toBe(true);
  expect(evidenceMediaRequests.every((request) => request.cookie.includes("yxm_backoffice_session="))).toBe(true);
  await firstEvidence.click();
  const lightbox = page.locator(".media-lightbox");
  await expect(lightbox).toHaveAttribute("aria-label", "司机取车车辆左前图片预览");
  await expect(lightbox).toContainText("履约留证 · 司机取车");
  await expect(lightbox).toContainText("1 / 5");
  await expect(lightbox.locator('[data-authenticated-media-state="ready"] img')).toHaveAttribute("src", /^blob:/);
  await lightbox.getByRole("button", { name: "下一张" }).click();
  await expect(lightbox).toHaveAttribute("aria-label", "司机取车车辆右前图片预览");
  await page.keyboard.press("Escape");
  await expect(firstEvidence).toBeFocused();

  const statusSelect = drawer.locator(".ops-form select");
  await expect(statusSelect.getByRole("option", { name: /已取车/ })).toHaveCount(0);
  await expect(statusSelect.getByRole("option", { name: "异常挂起（暂停履约）" })).toBeAttached();
  await expect(drawer).toContainText("检测站不能替司机完成送回");

  Object.assign(booking, { fulfillmentStatus: "picked_up" });
  Object.assign(booking.driverAssignment, {
    status: "bound",
    boundAt: "2026-08-24T10:10:00+08:00",
    verificationCode: "482719",
    verificationCodeStatus: "bound",
  });
  // The synthetic cookie above exists only to assert authenticated media
  // transport. Remove it before reload so the test server can resume its
  // explicit backoffice test identity instead of treating it as a forged
  // production session token.
  await page.context().clearCookies();
  await page.reload();
  await page.getByRole("button", { name: "查看津A·E0520预约详情" }).click();
  const boundDriverPanel = page.getByLabel("预约与账务详情").getByLabel("接待人安排");
  await expect(boundDriverPanel.getByLabel("取车任务验证码", { exact: true })).toContainText("482 719");
  await expect(boundDriverPanel.getByLabel("取车任务验证码", { exact: true })).toContainText("已绑定，仅原微信可继续使用");
  await expect(boundDriverPanel.getByRole("button", { name: "重新生成验证码" })).toBeDisabled();

  Object.assign(booking, { fulfillmentStatus: "completed" });
  Object.assign(booking.driverAssignment, { status: "completed", verificationCodeStatus: "completed" });
  await page.reload();
  await page.getByRole("button", { name: "查看津A·E0520预约详情" }).click();
  const completedDriverPanel = page.getByLabel("预约与账务详情").getByLabel("接待人安排");
  await expect(completedDriverPanel).toContainText("任务已结束");
  await expect(completedDriverPanel.getByLabel("取车任务验证码", { exact: true })).toHaveCount(0);
});

test("后台不能绕过取车和到站留证状态", async ({ page }) => {
  const base = {
    status: "confirmed",
    paymentStatus: "paid",
    appointmentDate: "2026-08-25",
    startTime: "10:00",
    endTime: "11:00",
    contactName: "留证测试",
    contactPhone: "13800001111",
    serviceMode: "valet",
    serviceFeeFen: 36900,
    inspectionFeeFen: 26000,
    valetFeeFen: 10900,
    quoteDistanceKm: 7.8,
    quoteSource: "tencent_matrix",
    vehiclePriceCategory: "fuel_small",
    chargedFen: 36900,
    paidFen: 36900,
    refundedFen: 0,
    pendingAdjustmentFen: 0,
    station: { id: "station-guard", name: "留证检测站", district: "河西区" },
    media: [],
    events: [],
    evidencePackages: [],
  };
  const bookings = [
    { ...base, id: "guard-arranged", bookingNumber: "GUARD-ARRANGED", fulfillmentStatus: "driver_arranged", vehicle: { plateNumber: "津A·G1001", vehicleType: "小型轿车", seats: 5 } },
    { ...base, id: "guard-picked", bookingNumber: "GUARD-PICKED", fulfillmentStatus: "picked_up", vehicle: { plateNumber: "津A·G1002", vehicleType: "小型轿车", seats: 5 } },
    { ...base, id: "guard-returning", bookingNumber: "GUARD-RETURNING", status: "result_received", fulfillmentStatus: "returning", vehicle: { plateNumber: "津A·G1003", vehicleType: "小型轿车", seats: 5 } },
    { ...base, id: "guard-result", bookingNumber: "GUARD-RESULT", status: "result_received", fulfillmentStatus: "result_received", vehicle: { plateNumber: "津A·G1004", vehicleType: "小型轿车", seats: 5 } },
  ];
  await page.route("**/api/admin/bookings**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/bookings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: bookings }) });
    const booking = bookings.find((item) => path === `/api/admin/bookings/${item.id}`);
    if (booking) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: booking }) });
    return route.continue();
  });

  await page.goto("/");
  await page.getByText("津A·G1001", { exact: true }).click();
  let drawer = page.getByLabel("预约与账务详情");
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: /已取车/ })).toHaveCount(0);
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: "已取消（终止订单）" })).toBeAttached();
  await drawer.getByRole("button", { name: "关闭预约详情" }).click();
  await page.getByText("津A·G1002", { exact: true }).click();
  drawer = page.getByLabel("预约与账务详情");
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: /车辆已到站/ })).toHaveCount(0);
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: /已取消/ })).toHaveCount(0);
  await drawer.getByRole("button", { name: "关闭预约详情" }).click();
  await page.getByText("津A·G1003", { exact: true }).click();
  drawer = page.getByLabel("预约与账务详情");
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: /已完成/ })).toHaveCount(0);
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: /已取消/ })).toHaveCount(0);
  await drawer.getByRole("button", { name: "关闭预约详情" }).click();
  await page.getByText("津A·G1004", { exact: true }).click();
  drawer = page.getByLabel("预约与账务详情");
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: /送回中/ })).toHaveCount(0);
  await expect(drawer.locator(".ops-form select").getByRole("option", { name: /已取消/ })).toHaveCount(0);
  await expect(drawer).toContainText("后台只处理挂起、恢复原节点、取消和协调备注");
});
