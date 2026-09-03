import { expect, test, type Page, type Route } from "@playwright/test";

const platformSession = {
  account: { id: "platform-admin-1", displayName: "平台测试管理员", role: "platform_admin" },
  subject: null,
  capabilities: ["*"],
  expiresAt: "2099-08-24T00:00:00.000Z",
};

const providerSession = {
  account: { id: "store-admin-1", displayName: "王店长", role: "wash_store_admin" },
  subject: { type: "wash_store", id: "wash-store-a", name: "津湾臻洗中心", status: "active" },
  capabilities: ["wash.dashboard.read", "wash.orders.read", "wash.orders.redeem", "wash.slots.read", "wash.slots.write", "wash.store.read", "wash.store.write", "wash.offers.read", "wash.offers.write", "wash.settlements.read", "audit.self.read"],
  expiresAt: "2099-08-24T00:00:00.000Z",
};

const repairSession = {
  account: { id: "repair-admin-1", displayName: "津城钣喷中心管理员", role: "repair_shop_admin" },
  subject: { type: "repair_shop", id: "shop-jincheng-bodypaint", name: "津城钣喷中心（演示）" },
  capabilities: ["repair.requests.read", "repair.quotes.read", "repair.quotes.write", "repair.authorized_details.read", "audit.self.read"],
  expiresAt: "2099-08-24T00:00:00.000Z",
};

function fulfill(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status >= 400 ? { error: { message: data } } : { data }) });
}

async function mockPlatformBusiness(page: Page) {
  await page.route("**/api/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/stations") return fulfill(route, []);
    if (path === "/api/admin/inspection-price-plans") return fulfill(route, []);
    if (path === "/api/admin/bookings") return fulfill(route, []);
    return fulfill(route, { items: [], total: 0 });
  });
}

test("会话确认前不会发出任何后台业务请求", async ({ page }) => {
  let sessionResolved = false;
  const prematureBusinessRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/admin/") && !sessionResolved) prematureBusinessRequests.push(path);
  });
  await page.route("**/api/backoffice/session", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    sessionResolved = true;
    await fulfill(route, platformSession);
  });
  await mockPlatformBusiness(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "正在确认后台身份" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "预约交易与履约中心" })).toBeVisible();
  expect(prematureBusinessRequests).toEqual([]);
});

test("匿名用户只看到统一登录页，登录后进入固定门店工作台", async ({ page }) => {
  let loginBody: Record<string, unknown> | undefined;
  let passwordBody: Record<string, unknown> | undefined;
  let adminBusinessRequests = 0;
  await page.route("**/api/backoffice/session", (route) => fulfill(route, "请先登录", 401));
  await page.route("**/api/backoffice/sessions", async (route) => {
    loginBody = route.request().postDataJSON() as Record<string, unknown>;
    await fulfill(route, providerSession);
  });
  await page.route("**/api/backoffice/password", async (route) => {
    passwordBody = route.request().postDataJSON() as Record<string, unknown>;
    await fulfill(route, {
      ...providerSession,
      account: { ...providerSession.account, displayName: "王店长（新会话）" },
      expiresAt: "2099-08-25T00:00:00.000Z",
    });
  });
  await page.route("**/api/admin/**", async (route) => {
    adminBusinessRequests += 1;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/wash/dashboard") return fulfill(route, { todayOrders: 3, awaitingRedemption: 1, futureSlots: 12, serviceAmountLast7DaysFen: 128800, recentOrders: [], recentEvents: [] });
    return fulfill(route, { items: [], total: 0 });
  });

  await page.goto("/bookings");
  await expect(page.getByRole("heading", { name: "登录运营后台" })).toBeVisible();
  expect(adminBusinessRequests).toBe(0);
  await page.getByLabel("后台登录名").fill("jinwan_manager");
  await page.getByLabel("后台登录密码").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "安全登录" }).click();

  await expect(page.getByRole("heading", { name: "洗车门店经营工作台" })).toBeVisible();
  await expect(page.getByText("津湾臻洗中心", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "订单与核销" })).toBeVisible();
  await expect(page.getByRole("button", { name: "预约履约" })).toHaveCount(0);
  expect(loginBody).toEqual({ loginName: "jinwan_manager", password: "correct-horse-battery-staple" });
  await page.getByRole("button", { name: "修改后台密码" }).click();
  await page.getByLabel("当前后台密码").fill("correct-horse-battery-staple");
  await page.getByLabel("新的后台密码", { exact: true }).fill("new-correct-horse-password");
  await page.getByLabel("确认新的后台密码").fill("new-correct-horse-password");
  await page.getByRole("button", { name: "确认修改密码" }).click();
  await expect.poll(() => passwordBody).toEqual({ currentPassword: "correct-horse-battery-staple", newPassword: "new-correct-horse-password" });
  await expect(page.getByText("王店长（新会话）", { exact: true })).toBeVisible();
});

test("维修门店管理员登录网页后台后只显示绑定门店与本人操作记录", async ({ page }) => {
  await page.route("**/api/backoffice/session", (route) => fulfill(route, repairSession));
  await page.route("**/api/admin/audit-events?*", (route) => fulfill(route, { items: [], total: 0, page: 1, pageSize: 25 }));

  await page.goto("/");

  await expect(page).toHaveURL(/\/my-audit$/);
  await expect(page.getByText("津城钣喷中心（演示）", { exact: true })).toBeVisible();
  await expect(page.getByText("维修门店管理员", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "我的操作记录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "订单与核销" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "维修服务" })).toBeAttached();
  await expect(page.getByRole("option", { name: "洗车服务" })).toHaveCount(0);

  await page.goto("/bookings");
  await expect(page.getByText("403 · ACCESS DENIED")).toBeVisible();
});

test("服务商账号页面可创建并说明维修门店管理员账号", async ({ page }) => {
  let invitationBody: Record<string, unknown> | undefined;
  await page.route("**/api/backoffice/session", (route) => fulfill(route, platformSession));
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/admin/backoffice/accounts" && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], meta: { directPasswordEnabled: true } }) });
    }
    if (path === "/api/admin/backoffice/accounts/invitations" && request.method() === "POST") {
      invitationBody = request.postDataJSON() as Record<string, unknown>;
      return fulfill(route, { account: { id: "repair-admin-1", ...invitationBody, status: "active" } });
    }
    if (path === "/api/admin/repair/shops") return fulfill(route, [{ id: "shop-jincheng-bodypaint", name: "津城钣喷中心（演示）", isActive: true, isDemo: true }]);
    if (path === "/api/admin/stations" || path === "/api/admin/wash/stores" || path === "/api/admin/inspection-price-plans") return fulfill(route, []);
    return fulfill(route, { items: [], total: 0 });
  });

  await page.goto("/service-accounts");
  await expect(page.getByText("微信小程序维修门店端", { exact: true })).toBeVisible();
  await page.getByLabel("服务商账号类型").selectOption("repair_shop_admin");
  await page.getByLabel("服务商管理员姓名").fill("津城钣喷中心管理员");
  await page.getByLabel("服务商账号登录名").fill("jincheng");
  await page.getByLabel("服务商账号登录密码").fill("yuxiaoman2026");
  await page.getByLabel("服务商绑定主体").selectOption("shop-jincheng-bodypaint");
  await page.getByRole("button", { name: "创建并启用账号" }).click();

  await expect.poll(() => invitationBody).toEqual({
    loginName: "jincheng",
    displayName: "津城钣喷中心管理员",
    role: "repair_shop_admin",
    subject: { type: "repair_shop", id: "shop-jincheng-bodypaint" },
    password: "yuxiaoman2026",
  });
});

test("当前密码错误只保留在改密对话框，不会误判为会话失效", async ({ page }) => {
  await page.route("**/api/backoffice/session", (route) => fulfill(route, providerSession));
  await page.route("**/api/backoffice/password", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "BACKOFFICE_INVALID_CREDENTIALS", message: "当前密码错误" } }),
  }));
  await page.route("**/api/admin/wash/dashboard", (route) => fulfill(route, {
    todayOrders: 0, awaitingRedemption: 0, futureSlots: 0, serviceAmountLast7DaysFen: 0,
    recentOrders: [], recentAuditEvents: [],
  }));
  await page.route("**/api/admin/wash/stores", (route) => fulfill(route, { items: [], total: 0 }));

  await page.goto("/wash/dashboard");
  await page.getByRole("button", { name: "修改后台密码" }).click();
  await page.getByLabel("当前后台密码").fill("wrong-current-password");
  await page.getByLabel("新的后台密码", { exact: true }).fill("new-correct-horse-password");
  await page.getByLabel("确认新的后台密码").fill("new-correct-horse-password");
  await page.getByRole("button", { name: "确认修改密码" }).click();

  await expect(page.getByText("当前密码错误", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "修改后台密码" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录运营后台" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/wash\/dashboard$/);
});

test("洗车店管理员的直接 URL 守卫与订单视图不渲染隐私或核销码", async ({ page }) => {
  await page.route("**/api/backoffice/session", (route) => fulfill(route, providerSession));
  await page.route("**/api/admin/wash/orders?*", (route) => fulfill(route, { items: [{
    id: "order-a", orderNumber: "YXW-STORE-A-001", status: "awaiting_redemption", settlementStatus: "unsettled",
    appointmentDate: "2026-08-24", startTime: "10:00", endTime: "11:00", paidFen: 6800, serviceMode: "self_drive",
    storeName: "津湾臻洗中心", packageName: "标准洗护", vehicleType: "sedan", vehiclePlate: "津A·12345",
    contactName: "不应显示的车主", contactPhone: "13800000000", pickupAddress: { address: "不应显示的代驾地址" }, verificationCode: "482731", internalNote: "不应显示的平台备注",
  }], total: 1 }));
  await page.route("**/api/admin/wash/orders/order-a", (route) => fulfill(route, {
    id: "order-a", orderNumber: "YXW-STORE-A-001", status: "awaiting_redemption", settlementStatus: "unsettled",
    appointmentDate: "2026-08-24", startTime: "10:00", endTime: "11:00", paidFen: 6800, serviceMode: "self_drive",
    packageName: "标准洗护", vehicleType: "sedan", vehiclePlate: "津A·12345", contactName: "不应显示的车主", contactPhone: "13800000000", verificationCode: "482731",
  }));

  await page.goto("/bookings");
  await expect(page.getByText("403 · ACCESS DENIED")).toBeVisible();
  await page.getByRole("button", { name: "订单与核销" }).click();
  await expect(page.getByRole("heading", { name: "快速核销" })).toBeVisible();
  await expect(page.getByText("YXW-STORE-A-001")).toBeVisible();
  await page.getByText("YXW-STORE-A-001").click();
  await expect(page.getByRole("complementary", { name: "服务商洗车订单详情" })).toBeVisible();
  await expect(page.getByLabel("订单详情六位核销码")).toBeVisible();
  await expect(page.getByText("不应显示的车主")).toHaveCount(0);
  await expect(page.getByText("13800000000")).toHaveCount(0);
  await expect(page.getByText("不应显示的代驾地址")).toHaveCount(0);
  await expect(page.getByText("482731")).toHaveCount(0);
  await expect(page.getByText("不应显示的平台备注")).toHaveCount(0);
  await expect(page.getByText("最小必要信息")).toBeVisible();
});

test("业务接口返回 401 时立即清除会话并回到登录页", async ({ page }) => {
  await page.route("**/api/backoffice/session", (route) => fulfill(route, providerSession));
  await page.route("**/api/admin/wash/dashboard", (route) => fulfill(route, "会话已失效", 401));
  await page.goto("/wash/dashboard");
  await expect(page.getByRole("heading", { name: "登录运营后台" })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("服务商门店资料透传每周营业计划，价格保存不创建缺失报价或携带结算价", async ({ page }) => {
  let storeBody: Record<string, unknown> | undefined;
  let offersBody: Record<string, unknown> | undefined;
  const weeklySchedule = {
    mon: [{ start: "08:00", end: "18:00" }], tue: [{ start: "08:00", end: "18:00" }], wed: [{ start: "08:00", end: "18:00" }],
    thu: [{ start: "08:00", end: "18:00" }], fri: [{ start: "08:00", end: "18:00" }], sat: [], sun: [],
  };
  const store = {
    id: "wash-store-a", name: "津湾臻洗中心", legalName: "天津津湾汽车服务有限公司", district: "滨海新区", address: "天津市滨海新区第二大街 88 号",
    phone: "022-66881234", openHours: "周一至周五 08:00-18:00", latitude: 39.031, longitude: 117.705, description: "精细洗护门店", tags: ["精细洗护"], facilities: ["休息区"],
    businessHoursNotice: "地库 B2 层", advanceBookingDays: 14, weeklySchedule, images: [], imageCount: 0, isActive: true, isOpen: true,
  };
  await page.route("**/api/backoffice/session", (route) => fulfill(route, providerSession));
  await page.route("**/api/admin/wash/stores", (route) => fulfill(route, { items: [store], total: 1 }));
  await page.route("**/api/admin/wash/stores/wash-store-a", async (route) => {
    storeBody = route.request().postDataJSON() as Record<string, unknown>;
    await fulfill(route, { ...store, ...storeBody });
  });
  await page.route("**/api/admin/wash/packages", (route) => fulfill(route, [{ id: "pkg-standard", code: "standard", name: "标准洗护", shortDescription: "基础外观清洁", serviceItems: ["预冲洗", "泡沫清洁"], durationMinutes: 35, isActive: true }]));
  await page.route("**/api/admin/wash/stores/wash-store-a/offers", async (route) => {
    if (route.request().method() === "PUT") {
      offersBody = route.request().postDataJSON() as Record<string, unknown>;
      return fulfill(route, (offersBody.offers as unknown[]) || []);
    }
    return fulfill(route, [{ id: "offer-sedan", storeId: "wash-store-a", packageId: "pkg-standard", vehicleCategory: "sedan", salePriceFen: 3800, isAvailable: true }]);
  });

  await page.goto("/wash/store");
  await expect(page.getByText("经营中", { exact: true })).toBeVisible();
  await page.getByLabel("服务商周三结束时间").fill("19:30");
  await page.getByRole("button", { name: "保存门店资料" }).click();
  await expect.poll(() => ((storeBody?.weeklySchedule as typeof weeklySchedule | undefined)?.wed[0]?.end)).toBe("19:30");
  expect((storeBody?.weeklySchedule as typeof weeklySchedule).mon).toEqual(weeklySchedule.mon);

  await page.getByRole("button", { name: "套餐与价格" }).click();
  await expect(page.getByText("平台未配置").first()).toBeVisible();
  await page.getByLabel("服务商标准洗护小轿车销售价").fill("42.00");
  await page.getByRole("button", { name: "保存本店价格" }).click();
  await expect.poll(() => offersBody).toBeTruthy();
  const submittedOffers = offersBody?.offers as Array<Record<string, unknown>>;
  expect(submittedOffers).toHaveLength(1);
  expect(submittedOffers[0].vehicleCategory).toBe("sedan");
  expect(submittedOffers[0].salePriceFen).toBe(4200);
  expect(submittedOffers[0]).not.toHaveProperty("estimatedSettlementFen");
});

test("服务商门店相册可从原位置连续上传同一图片并立即刷新计数", async ({ page }) => {
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const pixelUrl = `data:image/png;base64,${pixel.toString("base64")}`;
  const weeklySchedule = {
    mon: [{ start: "08:00", end: "18:00" }], tue: [{ start: "08:00", end: "18:00" }], wed: [{ start: "08:00", end: "18:00" }],
    thu: [{ start: "08:00", end: "18:00" }], fri: [{ start: "08:00", end: "18:00" }], sat: [], sun: [],
  };
  const firstImage = { id: "wash-image-1", url: pixelUrl, width: 1600, height: 900, sizeBytes: 73123, sortOrder: 0, isCover: true };
  const store = {
    id: "wash-store-a", name: "津湾臻洗中心", legalName: "天津津湾汽车服务有限公司", district: "滨海新区", address: "天津市滨海新区第二大街 88 号",
    phone: "022-66881234", openHours: "周一至周五 08:00-18:00", latitude: 39.031, longitude: 117.705, description: "精细洗护门店", tags: ["精细洗护"], facilities: ["休息区"],
    businessHoursNotice: "地库 B2 层", advanceBookingDays: 14, weeklySchedule, images: [firstImage], imageCount: 1, coverImageUrl: firstImage.url, isActive: true, isOpen: true,
  };
  let uploadCount = 0;
  const contentTypes: string[] = [];

  await page.route("**/api/backoffice/session", (route) => fulfill(route, providerSession));
  await page.route("**/api/admin/wash/stores", (route) => fulfill(route, { items: [store], total: 1 }));
  await page.route("**/api/admin/wash/stores/wash-store-a/images", async (route) => {
    uploadCount += 1;
    contentTypes.push(route.request().headers()["content-type"] || "");
    if (uploadCount === 4) return fulfill(route, "第二张图片损坏或无法识别", 400);
    await fulfill(route, {
      id: `wash-image-${uploadCount + 1}`, url: pixelUrl, width: 1280, height: 720, sizeBytes: pixel.length,
      sortOrder: uploadCount, isCover: false,
    }, 201);
  });

  await page.goto("/wash/store");
  await expect(page.getByText("1/20 张", { exact: true })).toBeVisible();

  for (const expectedCount of [2, 3]) {
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "same-photo.png", mimeType: "image/png", buffer: pixel });
    await expect(page.getByText(`${expectedCount}/20 张`, { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("门店图片已上传");
  }

  const batchChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传图片", exact: true }).click();
  const batchChooser = await batchChooserPromise;
  await batchChooser.setFiles([
    { name: "batch-first.png", mimeType: "image/png", buffer: pixel },
    { name: "batch-second.png", mimeType: "image/png", buffer: pixel },
  ]);
  await expect(page.getByText("4/20 张", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("第二张图片损坏或无法识别");
  await expect(page.getByRole("button", { name: "上传图片", exact: true })).toHaveAttribute("aria-disabled", "false");

  expect(uploadCount).toBe(4);
  expect(contentTypes).toHaveLength(4);
  expect(contentTypes.every((value) => value.startsWith("multipart/form-data; boundary="))).toBe(true);
  await expect(page.locator(".wash-store-image-grid article")).toHaveCount(4);
});

test("服务商可在地图落针并只保存服务端核验后的可信位置", async ({ page }) => {
  const weeklySchedule = {
    mon: [{ start: "08:00", end: "18:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
  };
  const store = {
    id: "wash-store-a", name: "津湾臻洗中心", legalName: "天津津湾汽车服务有限公司", district: "滨海新区", address: "天津市滨海新区第二大街 88 号",
    phone: "022-66881234", openHours: "周一 08:00-18:00", latitude: 39.031, longitude: 117.705, description: "精细洗护门店", tags: ["精细洗护"], facilities: ["休息区"],
    businessHoursNotice: "地库 B2 层", advanceBookingDays: 14, weeklySchedule, images: [], imageCount: 0, isActive: true, isOpen: true,
  };
  const resolvedLocation = {
    poiId: "tencent-poi-map-pin", title: "天津万象城", address: "天津市河西区乐园道9号", district: "河西区",
    latitude: 39.0896, longitude: 117.2138, source: "tencent", locationProof: "signed-location-proof",
  };
  let resolveBody: Record<string, unknown> | undefined;
  let storeBody: Record<string, unknown> | undefined;
  let releaseResolve: (() => void) | undefined;
  const resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve; });

  await page.route(/https:\/\/map\.qq\.com\/api\/gljs.*/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: `
      class TestLatLng {
        constructor(lat, lng) { this.lat = lat; this.lng = lng; }
        getLat() { return this.lat; }
        getLng() { return this.lng; }
      }
      class TestMap {
        constructor(container, options) { this.handlers = {}; this.center = options.center; container.dataset.mapReady = "true"; window.__providerMap = this; }
        on(name, listener) { this.handlers[name] = listener; }
        off(name) { delete this.handlers[name]; }
        setCenter(point) { this.center = point; }
        destroy() {}
        click(latitude, longitude) { this.handlers.click?.({ latLng: new TestLatLng(latitude, longitude) }); }
      }
      class TestMultiMarker {
        constructor(options) { this.map = options.map; this.geometries = options.geometries; }
        updateGeometries(geometries) { this.geometries = geometries; }
        setMap(map) { this.map = map; }
      }
      window.TMap = { LatLng: TestLatLng, Map: TestMap, MultiMarker: TestMultiMarker };
    `,
  }));
  await page.route("**/api/backoffice/session", (route) => fulfill(route, providerSession));
  await page.route("**/api/admin/wash/stores", (route) => fulfill(route, { items: [store], total: 1 }));
  await page.route("**/api/locations/resolve", async (route) => {
    resolveBody = route.request().postDataJSON() as Record<string, unknown>;
    await resolveGate;
    await fulfill(route, resolvedLocation);
  });
  await page.route("**/api/admin/wash/stores/wash-store-a", async (route) => {
    storeBody = route.request().postDataJSON() as Record<string, unknown>;
    const location = storeBody.location as typeof resolvedLocation;
    await fulfill(route, { ...store, ...storeBody, address: location.address, district: location.district, latitude: location.latitude, longitude: location.longitude });
  });

  await page.goto("/wash/store");
  await page.getByRole("button", { name: "地图扎针" }).click();
  await expect(page.getByLabel("门店地图选点区域")).toHaveAttribute("data-map-ready", "true");
  await page.evaluate(() => (window as typeof window & { __providerMap: { click: (latitude: number, longitude: number) => void } }).__providerMap.click(39.0896, 117.2138));

  await expect.poll(() => resolveBody).toEqual({ latitude: 39.0896, longitude: 117.2138 });
  await expect(page.getByRole("button", { name: "位置核验中…" })).toBeDisabled();
  releaseResolve?.();
  await expect(page.getByRole("status")).toContainText("已定位到 天津万象城");
  await expect(page.getByText("待保存的新位置", { exact: true })).toBeVisible();
  await expect(page.getByText("天津市河西区乐园道9号", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "保存门店资料" }).click();
  await expect.poll(() => storeBody?.location).toEqual(resolvedLocation);
});
