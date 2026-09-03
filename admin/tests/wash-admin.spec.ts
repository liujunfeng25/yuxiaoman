import { expect, test, type Page, type Route } from "@playwright/test";

type MockTrace = {
  orderQuery: URLSearchParams;
  locationQuery?: string;
  redeemBody?: Record<string, unknown>;
  settlementBody?: Record<string, unknown>;
  orderPatchBody?: Record<string, unknown>;
  storeBody?: Record<string, unknown>;
  packageBody?: Record<string, unknown>;
  offersBody?: Record<string, unknown>;
  offersStoreId?: string;
  offerGetStarted: string[];
  offerGetFinished: string[];
  offerPutStarted: string[];
  offerPutFinished: string[];
  slotBatchBody?: Record<string, unknown>;
  slotPatchBody?: Record<string, unknown>;
  valetRuleBody?: Record<string, unknown>;
  valetRuleDeleted?: boolean;
  imageUploadBodies: string[];
  imageOrderBody?: Record<string, unknown>;
  deletedImageId?: string;
};

type MockWashImage = {
  id: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sortOrder: number;
  isCover: boolean;
  isStored: boolean;
  dataKind: "demo";
  createdAt: string;
};

async function installWashApiMock(page: Page, options: { reverseOfferResponses?: boolean; slowOfferPutStoreId?: string; corruptFirstStoreLocation?: boolean } = {}) {
  const trace: MockTrace = { orderQuery: new URLSearchParams(), offerGetStarted: [], offerGetFinished: [], offerPutStarted: [], offerPutFinished: [], imageUploadBodies: [] };
  const firstStoreImages: MockWashImage[] = [
    { id: "wash-image-1", url: "/api/admin/wash/store-images/wash-image-1", mimeType: "image/jpeg", sizeBytes: 184320, width: 1600, height: 900, sortOrder: 0, isCover: true, isStored: true, dataKind: "demo", createdAt: "2026-08-16T10:00:00.000Z" },
    { id: "wash-image-2", url: "/api/admin/wash/store-images/wash-image-2", mimeType: "image/jpeg", sizeBytes: 143360, width: 1280, height: 853, sortOrder: 1, isCover: false, isStored: true, dataKind: "demo", createdAt: "2026-08-16T10:01:00.000Z" },
  ];
  let imageSequence = 3;
  const stores = [
    { id: "wash-store-1", name: "津湾臻洗中心", district: "滨海新区", address: "天津市滨海新区第二大街 88 号", phone: "022-66881234", openHours: "08:00-20:00", latitude: 39.031, longitude: 117.705, coverImageUrl: firstStoreImages[0].url, imageCount: firstStoreImages.length, images: firstStoreImages, description: "商场地库内的精细化洗护门店", tags: ["精细洗护", "商场停车"], facilities: ["休息区", "卫生间"], businessHoursNotice: "地下停车场 B2 层", isActive: true, isOpen: true, notice: "地下停车场 B2 层" },
    { id: "wash-store-2", name: "海河洁车坊", district: "河西区", address: "天津市河西区黑牛城道 66 号", phone: "022-88336688", openHours: "09:00-19:00", latitude: 39.081, longitude: 117.224, coverImageUrl: null, imageCount: 0, images: [] as MockWashImage[], description: "", tags: [] as string[], facilities: [] as string[], businessHoursNotice: null, isActive: false, isOpen: false, notice: null },
  ];
  if (options.corruptFirstStoreLocation) {
    stores[0].district = "";
    stores[0].address = "";
    stores[0].latitude = Number.NaN;
    stores[0].longitude = 0;
  }
  const packages = [
    { id: "wash-package-standard", code: "standard", name: "标准洗护", shortDescription: "外观清洁与基础内饰除尘", serviceItems: ["高压预冲", "车身泡沫清洁", "轮毂清洁", "擦干"], includedItems: ["高压预冲", "车身泡沫清洁", "轮毂清洁", "擦干"], durationMinutes: 35, sortOrder: 10, isActive: true },
    { id: "wash-package-detail", code: "detail", name: "精致洗护", shortDescription: "更细致的车身与内饰清洁", serviceItems: ["标准洗护", "内饰吸尘", "玻璃清洁"], includedItems: ["标准洗护", "内饰吸尘", "玻璃清洁"], durationMinutes: 70, sortOrder: 20, isActive: true },
  ];
  let offers = packages.flatMap((item, packageIndex) => (["sedan", "suv", "mpv"] as const).map((vehicleType, vehicleIndex) => ({
    id: `offer-${packageIndex}-${vehicleIndex}`,
    storeId: "wash-store-1",
    packageId: item.id,
    vehicleCategory: vehicleType,
    vehicleType,
    salePriceFen: (packageIndex ? 8800 : 3800) + vehicleIndex * 1000,
    estimatedSettlementFen: (packageIndex ? 6600 : 2800) + vehicleIndex * 800,
    isAvailable: true,
    isActive: true,
  })));
  let slots = [
    { id: "wash-slot-1", storeId: "wash-store-1", date: "2026-08-18", startTime: "08:00", endTime: "09:00", capacity: 4, reservedCount: 1, bookedCount: 1, remaining: 3, isOpen: true },
    { id: "wash-slot-2", storeId: "wash-store-1", date: "2026-08-18", startTime: "09:00", endTime: "10:00", capacity: 3, reservedCount: 0, bookedCount: 0, remaining: 3, isOpen: true },
  ];
  let orders = [
    { id: "wash-order-1", orderNumber: "YXW202608160001", redemptionCode: "482731", verificationCode: "482731", status: "awaiting_redemption", settlementStatus: "unsettled", appointmentDate: "2026-08-18", startTime: "09:00", endTime: "10:00", contactName: "李先生", contactPhone: "13800001111", paidFen: 14700, totalFeeFen: 14700, serviceFeeFen: 14700, washFeeFen: 3800, valetFeeFen: 10900, serviceMode: "valet", tripType: "round_trip_same_address", pickupAddress: { poiId: "pickup-1", title: "天津文化中心地下停车场", address: "天津市河西区平江道 58 号", district: "河西区", latitude: 39.09, longitude: 117.22, detail: "B2-156" }, oneWayDistanceKm: 8.6, roundTripDistanceKm: 17.2, driveMinutes: 24, distanceSource: "tencent_matrix", distanceBasis: "driving_route", breakdown: { washFeeFen: 3800, valetBaseFeeFen: 10900, valetDistanceFeeFen: 0, valetFeeFen: 10900, totalFeeFen: 14700 }, valetRule: { scope: "global", storeId: null, baseFeeFen: 10900, includedKm: 10, perKmFen: 800, maxRadiusKm: 20 }, storeId: "wash-store-1", storeName: "津湾臻洗中心", store: { id: "wash-store-1", name: "津湾臻洗中心" }, packageId: "wash-package-standard", packageName: "标准洗护", package: { id: "wash-package-standard", name: "标准洗护" }, vehicleCategory: "sedan", vehicleType: "sedan", vehiclePlate: "津A·X1234", operationNote: "", redeemedAt: null, estimatedSettlementFen: 2800, actualSettlementFen: 2800, updatedAt: "2026-08-16T14:00:00.000Z" },
    { id: "wash-order-2", orderNumber: "YXW202608160002", redemptionCode: "093624", verificationCode: "093624", status: "redeemed", settlementStatus: "settled", appointmentDate: "2026-08-18", startTime: "10:00", endTime: "11:00", contactName: "周女士", contactPhone: "13900002222", paidFen: 9800, storeId: "wash-store-1", storeName: "津湾臻洗中心", store: { id: "wash-store-1", name: "津湾臻洗中心" }, packageId: "wash-package-detail", packageName: "精致洗护", package: { id: "wash-package-detail", name: "精致洗护" }, vehicleCategory: "suv_mpv", vehicleType: "suv_mpv", vehiclePlate: "津B·D6789", operationNote: "已电话确认", redeemedAt: "2026-08-16T13:00:00.000Z", redeemSource: "phone", redeemNote: "车主手机没电", estimatedSettlementFen: 7400, actualSettlementFen: 7400, settlementNote: "首轮对账", updatedAt: "2026-08-16T14:05:00.000Z" },
  ];
  let valetRule = { scope: "global", storeId: null, baseFeeFen: 10900, includedKm: 10, perKmFen: 800, maxRadiusKm: 20, inherited: true, updatedAt: "2026-08-16T10:00:00.000Z", version: "global-v1" };

  const fulfill = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ data }) });

  await page.route("**/api/locations/suggestions?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("query") ?? "";
    trace.locationQuery = query;
    if (query.includes("无结果")) return fulfill(route, []);
    if (query.includes("错误")) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "地图地址服务暂不可用" } }) });
    }
    return fulfill(route, [
      { poiId: "tencent-wash-store-1", title: "天津文化中心店", address: "天津市河西区平江道 58 号", district: "河西区", latitude: 39.0837, longitude: 117.2197, source: "tencent", locationProof: "signed-location-proof-1" },
      { poiId: "tencent-wash-store-2", title: "天津万象城", address: "天津市河西区乐园道 9 号", district: "河西区", latitude: 39.0896, longitude: 117.2138, source: "tencent", locationProof: "signed-location-proof-2" },
    ]);
  });

  await page.route("**/api/admin/wash/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/admin/wash", "");
    const method = request.method();
    const requestContentType = request.headers()["content-type"] ?? "";
    const body = requestContentType.includes("application/json") ? request.postDataJSON() as Record<string, unknown> : undefined;

    if (/^\/store-images\/[^/]+$/.test(path) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL0AAAAASUVORK5CYII=", "base64") });
    }

    if (path === "/stores" && method === "GET") return fulfill(route, { items: stores, total: stores.length });
    if (path === "/stores" && method === "POST") {
      trace.storeBody = body;
      const created = { ...body, id: "wash-store-new", updatedAt: new Date().toISOString() };
      stores.push(created as typeof stores[number]);
      return fulfill(route, created, 201);
    }
    if (/^\/stores\/[^/]+$/.test(path) && method === "PUT") {
      trace.storeBody = body;
      const id = path.split("/")[2];
      const index = stores.findIndex((item) => item.id === id);
      const imageCover = stores[index].images.find((image) => image.isCover)?.url ?? stores[index].coverImageUrl;
      stores[index] = { ...stores[index], ...body, coverImageUrl: imageCover } as typeof stores[number];
      return fulfill(route, stores[index]);
    }
    if (/^\/stores\/[^/]+\/images$/.test(path) && method === "POST") {
      const storeId = path.split("/")[2];
      const store = stores.find((item) => item.id === storeId);
      if (!store) return fulfill(route, { error: { message: "门店不存在" } }, 404);
      const multipartBody = request.postDataBuffer()?.toString("latin1") ?? "";
      trace.imageUploadBodies.push(multipartBody);
      const requestedCover = /name="isCover"\r?\n\r?\n(?:true|1)/i.test(multipartBody);
      const isCover = !store.images.length || requestedCover;
      if (isCover) store.images = store.images.map((image) => ({ ...image, isCover: false }));
      const image: MockWashImage = {
        id: `wash-image-${imageSequence++}`,
        url: `/api/admin/wash/store-images/wash-image-${imageSequence - 1}`,
        mimeType: "image/jpeg",
        sizeBytes: 102400,
        width: 1440,
        height: 900,
        sortOrder: store.images.length,
        isCover,
        isStored: true,
        dataKind: "demo",
        createdAt: new Date().toISOString(),
      };
      store.images = [...store.images, image];
      store.imageCount = store.images.length;
      store.coverImageUrl = store.images.find((item) => item.isCover)?.url ?? null;
      return fulfill(route, image, 201);
    }
    if (/^\/stores\/[^/]+\/images$/.test(path) && method === "PUT") {
      const storeId = path.split("/")[2];
      const store = stores.find((item) => item.id === storeId);
      if (!store) return fulfill(route, { error: { message: "门店不存在" } }, 404);
      trace.imageOrderBody = body;
      const requested = body?.images as Array<{ id: string; sortOrder: number; isCover?: boolean }>;
      store.images = store.images.map((image) => {
        const update = requested.find((item) => item.id === image.id);
        return update ? { ...image, sortOrder: update.sortOrder, isCover: Boolean(update.isCover) } : image;
      }).sort((left, right) => left.sortOrder - right.sortOrder);
      store.coverImageUrl = store.images.find((item) => item.isCover)?.url ?? store.images[0]?.url ?? null;
      return fulfill(route, { images: store.images });
    }
    if (/^\/stores\/[^/]+\/images\/[^/]+$/.test(path) && method === "DELETE") {
      const [, , storeId, , imageId] = path.split("/");
      const store = stores.find((item) => item.id === storeId);
      if (!store) return fulfill(route, { error: { message: "门店不存在" } }, 404);
      trace.deletedImageId = imageId;
      const deletedWasCover = store.images.find((image) => image.id === imageId)?.isCover;
      store.images = store.images.filter((image) => image.id !== imageId);
      if (deletedWasCover && store.images.length) store.images[0] = { ...store.images[0], isCover: true };
      store.imageCount = store.images.length;
      store.coverImageUrl = store.images.find((image) => image.isCover)?.url ?? null;
      return fulfill(route, { id: imageId, deleted: true, images: store.images });
    }
    if (/^\/stores\/[^/]+$/.test(path) && method === "DELETE") return fulfill(route, { deleted: true });
    if (/^\/stores\/[^/]+\/valet-rule$/.test(path) && method === "GET") return fulfill(route, valetRule);
    if (/^\/stores\/[^/]+\/valet-rule$/.test(path) && method === "PUT") {
      trace.valetRuleBody = body;
      valetRule = { ...valetRule, ...body, scope: "store", storeId: path.split("/")[2], inherited: false, updatedAt: new Date().toISOString(), version: "store-v1" } as typeof valetRule;
      return fulfill(route, valetRule);
    }
    if (/^\/stores\/[^/]+\/valet-rule$/.test(path) && method === "DELETE") {
      trace.valetRuleDeleted = true;
      valetRule = { ...valetRule, scope: "global", storeId: null, inherited: true, version: "global-v1" };
      return fulfill(route, valetRule);
    }
    if (path === "/packages" && method === "GET") return fulfill(route, packages);
    if (path === "/packages" && method === "POST") {
      trace.packageBody = body;
      const created = { ...body, id: "wash-package-new", includedItems: body?.serviceItems, updatedAt: new Date().toISOString() };
      packages.push(created as typeof packages[number]);
      return fulfill(route, created, 201);
    }
    if (/^\/packages\/[^/]+$/.test(path) && method === "PUT") {
      trace.packageBody = body;
      const id = path.split("/")[2];
      const index = packages.findIndex((item) => item.id === id);
      packages[index] = { ...packages[index], ...body, includedItems: body?.serviceItems, updatedAt: new Date().toISOString() } as typeof packages[number];
      return fulfill(route, packages[index]);
    }
    if (/^\/packages\/[^/]+$/.test(path) && method === "DELETE") return fulfill(route, { deleted: true });
    if (/^\/stores\/[^/]+\/offers$/.test(path) && method === "GET") {
      const requestedStoreId = path.split("/")[2];
      trace.offerGetStarted.push(requestedStoreId);
      if (options.reverseOfferResponses && requestedStoreId === "wash-store-1") {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      const responseOffers = options.reverseOfferResponses || options.slowOfferPutStoreId
        ? packages.flatMap((item, packageIndex) => (["sedan", "suv", "mpv"] as const).map((vehicleType, vehicleIndex) => ({
          id: `${requestedStoreId}-${item.id}-${vehicleType}`,
          storeId: requestedStoreId,
          packageId: item.id,
          vehicleCategory: vehicleType,
          vehicleType,
          salePriceFen: (requestedStoreId === "wash-store-2" ? 13800 : 3800) + packageIndex * 5000 + vehicleIndex * 1000,
          estimatedSettlementFen: (requestedStoreId === "wash-store-2" ? 9800 : 2800) + packageIndex * 4000 + vehicleIndex * 800,
          isAvailable: true,
          isActive: true,
        })))
        : offers;
      trace.offerGetFinished.push(requestedStoreId);
      return fulfill(route, responseOffers);
    }
    if (/^\/stores\/[^/]+\/offers$/.test(path) && method === "PUT") {
      const requestedStoreId = path.split("/")[2];
      trace.offerPutStarted.push(requestedStoreId);
      if (options.slowOfferPutStoreId === requestedStoreId) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      trace.offersBody = body;
      trace.offersStoreId = requestedStoreId;
      offers = (body?.offers as typeof offers).map((item, index) => ({ ...item, id: item.id || `saved-offer-${index}`, vehicleType: item.vehicleCategory, isActive: item.isAvailable }));
      trace.offerPutFinished.push(requestedStoreId);
      return fulfill(route, offers);
    }
    if (path === "/slots" && method === "GET") return fulfill(route, { items: slots, total: slots.length });
    if (path === "/slots/batch" && method === "POST") {
      trace.slotBatchBody = body;
      return fulfill(route, { createdCount: 14 }, 201);
    }
    if (/^\/slots\/[^/]+$/.test(path) && method === "PATCH") {
      trace.slotPatchBody = body;
      const id = path.split("/")[2];
      slots = slots.map((slot) => slot.id === id ? { ...slot, capacity: Number(body?.capacity), isOpen: Boolean(body?.isOpen), remaining: Math.max(0, Number(body?.capacity) - slot.reservedCount) } : slot);
      return fulfill(route, slots.find((slot) => slot.id === id));
    }
    if (path === "/orders" && method === "GET") {
      trace.orderQuery = new URLSearchParams(url.search);
      return fulfill(route, { items: orders, total: orders.length });
    }
    if (path === "/orders/redeem" && method === "POST") {
      trace.redeemBody = body;
      const id = String(body?.orderId);
      orders = orders.map((order) => order.id === id ? { ...order, status: "redeemed", redeemedAt: new Date().toISOString(), redeemSource: body?.source, redeemNote: body?.note, updatedAt: new Date().toISOString() } : order) as typeof orders;
      return fulfill(route, orders.find((order) => order.id === id));
    }
    if (/^\/orders\/[^/]+\/settlement$/.test(path) && method === "PUT") {
      trace.settlementBody = body;
      const id = path.split("/")[2];
      const prior = orders.find((order) => order.id === id);
      orders = orders.map((order) => order.id === id ? { ...order, settlementStatus: prior?.settlementStatus === "settled" || prior?.settlementStatus === "adjusted" ? "adjusted" : "settled", actualSettlementFen: Number(body?.amountFen), settlementNote: body?.note, settlementCorrectionReason: body?.correctionReason, updatedAt: new Date().toISOString() } : order) as typeof orders;
      return fulfill(route, orders.find((order) => order.id === id));
    }
    if (/^\/orders\/[^/]+$/.test(path) && method === "PATCH") {
      trace.orderPatchBody = body;
      const id = path.split("/")[2];
      const nextStatus = body?.action === "cancel" ? "cancelled" : body?.action === "refund" ? "refunded" : undefined;
      orders = orders.map((order) => order.id === id ? { ...order, ...body, ...(nextStatus ? { status: nextStatus } : {}), operationNote: body?.internalNote ?? order.operationNote, updatedAt: new Date().toISOString() } : order) as typeof orders;
      return fulfill(route, orders.find((order) => order.id === id));
    }

    return fulfill(route, { error: { message: `Unhandled mock ${method} ${path}` } }, 404);
  });

  return trace;
}

async function openWashAdmin(page: Page, destination: "洗车订单" | "洗车门店" | "洗车套餐与价格") {
  await page.getByRole("button", { name: destination }).click();
}

test("显式测试身份可进入平台洗车后台，生产不再依赖匿名访问", async ({ page }) => {
  await installWashApiMock(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");

  await page.getByRole("button", { name: "洗车订单" }).click();
  await expect(page.getByRole("heading", { name: "洗车订单与人工核销" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /482731/ })).toBeVisible();
  await expect(page.getByLabel("洗车运营后台密码")).toHaveCount(0);

  await page.getByRole("button", { name: "预约履约" }).click();
  await expect(page.getByRole("heading", { name: "预约交易与履约中心" })).toBeVisible();
  await page.getByRole("button", { name: "洗车门店" }).click();
  await expect(page.getByRole("heading", { name: "洗车门店与预约产能" })).toBeVisible();
});

test("洗车订单支持六位码筛选、人工核销和带原因的结算修正", async ({ page }) => {
  const trace = await installWashApiMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openWashAdmin(page, "洗车订单");
  await expect(page.getByRole("heading", { name: "洗车订单与人工核销" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /482731/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /YXW202608160001/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /YXW202608160001/ })).toContainText("小轿车");
  await expect(page.getByRole("row", { name: /YXW202608160002/ })).toContainText("SUV / MPV（历史）");

  await page.getByLabel("洗车服务方式").selectOption("valet");
  await expect.poll(() => trace.orderQuery.get("serviceMode")).toBe("valet");
  await page.getByLabel("核销验证码").fill("482731");
  await expect.poll(() => trace.orderQuery.get("verificationCode")).toBe("482731");
  await page.getByRole("row", { name: /YXW202608160001.*482731/ }).click();
  await expect(page.getByText("核销码 482731")).toBeVisible();
  await expect(page.getByText("上门代驾取送（往返）")).toBeVisible();
  await expect(page.getByText("天津文化中心地下停车场")).toBeVisible();
  await expect(page.getByText(/8.6 km.*24 分钟/)).toBeVisible();
  await expect(page.getByText("¥109.00").first()).toBeVisible();
  await page.getByLabel("核销来源").selectOption("phone");
  await page.getByLabel("核销备注").fill("车主来电确认，门店人工核验");
  await page.getByRole("button", { name: "确认核销" }).click();
  await expect.poll(() => trace.redeemBody?.source).toBe("phone");
  await expect(page.getByRole("button", { name: "登记线下结算" })).toBeVisible();

  await page.getByLabel("实际线下结算金额").fill("28.50");
  await page.getByLabel("线下结算备注").fill("8 月第 3 批对账");
  await page.getByRole("button", { name: "登记线下结算" }).click();
  await expect.poll(() => trace.settlementBody?.amountFen).toBe(2850);
  await expect(page.getByRole("button", { name: "保存结算修正" })).toBeVisible();

  await page.getByLabel("实际线下结算金额").fill("29.00");
  await page.getByRole("button", { name: "保存结算修正" }).click();
  await expect(page.getByText("修正已登记结算金额或备注必须填写原因")).toBeVisible();
  await page.getByLabel("结算修正原因").fill("门店补录耗材差额");
  await page.getByRole("button", { name: "保存结算修正" }).click();
  await expect.poll(() => trace.settlementBody?.correctionReason).toBe("门店补录耗材差额");
  const refundButton = page.getByRole("button", { name: "登记退款" });
  await expect(refundButton).toBeEnabled();
  await page.getByLabel("取消退款原因").fill("用户反馈服务争议");
  await refundButton.click();
  await expect.poll(() => trace.orderPatchBody?.action).toBe("refund");
});

test("新增洗车门店通过地址搜索自动定位，不要求运营填写经纬度", async ({ page }) => {
  const trace = await installWashApiMock(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await openWashAdmin(page, "洗车门店");
  await page.getByRole("button", { name: "新增", exact: true }).click();

  await expect(page.getByRole("heading", { name: "新增洗车门店" })).toBeVisible();
  await expect(page.getByText("尚未选择门店位置")).toBeVisible();
  await page.getByLabel("搜索洗车门店位置").fill("文");
  await expect(page.getByText("请再输入至少 1 个字")).toBeVisible();

  await page.getByLabel("搜索洗车门店位置").fill("无结果");
  await expect(page.getByText("没有找到匹配位置，请换用道路、商场或完整门店名称")).toBeVisible();
  await page.getByRole("button", { name: "清除门店地址搜索" }).click();
  await expect(page.getByLabel("搜索洗车门店位置")).toHaveValue("");

  await page.getByLabel("搜索洗车门店位置").fill("地址错误");
  await expect(page.getByText("地图地址服务暂不可用")).toBeVisible();
  await page.getByRole("button", { name: "清除门店地址搜索" }).click();

  await page.getByLabel("搜索洗车门店位置").fill("文化中心");
  await expect.poll(() => trace.locationQuery).toBe("文化中心");
  await page.getByRole("option", { name: /天津文化中心店.*天津市河西区平江道 58 号/ }).click();

  await expect(page.getByText("已完成定位")).toBeVisible();
  await expect(page.getByLabel("洗车门店所属区")).toHaveValue("河西区");
  await expect(page.getByLabel("洗车门店详细地址")).toHaveValue("天津市河西区平江道 58 号");
  await expect(page.getByLabel("洗车门店纬度")).toHaveValue("39.083700");
  await expect(page.getByLabel("洗车门店经度")).toHaveValue("117.219700");
  await expect(page.getByLabel("洗车门店纬度")).toHaveJSProperty("readOnly", true);
  await expect(page.getByLabel("洗车门店经度")).toHaveJSProperty("readOnly", true);

  await page.getByLabel("洗车门店名称").fill("文化中心精洗店");
  await page.getByRole("button", { name: "创建门店", exact: true }).click();
  await expect.poll(() => (trace.storeBody?.location as { poiId?: string } | undefined)?.poiId).toBe("tencent-wash-store-1");
  expect((trace.storeBody?.location as { locationProof?: string } | undefined)?.locationProof).toBe("signed-location-proof-1");
  expect(trace.storeBody?.address).toBe("天津市河西区平江道 58 号");
  expect(trace.storeBody?.district).toBe("河西区");
  expect(trace.storeBody?.latitude).toBe(39.0837);
  expect(trace.storeBody?.longitude).toBe(117.2197);
});

test("缺失或损坏坐标的旧洗车门店必须重新选择可信位置", async ({ page }) => {
  const trace = await installWashApiMock(page, { corruptFirstStoreLocation: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await openWashAdmin(page, "洗车门店");

  await expect(page.getByText("已保存位置不可用")).toBeVisible();
  await expect(page.getByText("等待选点")).toBeVisible();
  await expect(page.getByLabel("洗车门店纬度")).toHaveCount(0);
  await page.getByRole("button", { name: "保存门店", exact: true }).click();
  await expect(page.getByText("请先搜索并选择门店位置，系统会自动填写地址与坐标")).toBeVisible();
  expect(trace.storeBody).toBeUndefined();

  await page.getByLabel("搜索洗车门店位置").fill("文化中心");
  await page.getByRole("option", { name: /天津文化中心店.*天津市河西区平江道 58 号/ }).click();
  await expect(page.getByLabel("洗车门店纬度")).toHaveValue("39.083700");
  await page.getByRole("button", { name: "保存门店", exact: true }).click();
  await expect.poll(() => (trace.storeBody?.location as { locationProof?: string } | undefined)?.locationProof).toBe("signed-location-proof-1");
});

test("洗车门店可维护对外详情与真实相册，并在窄桌面保持无横向溢出", async ({ page }) => {
  const trace = await installWashApiMock(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/");
  await openWashAdmin(page, "洗车门店");

  await expect(page.getByRole("heading", { name: "车主端展示详情" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "封面与门店相册" })).toBeVisible();
  await expect(page.locator(".wash-store-image-grid article")).toHaveCount(2);
  await expect(page.getByText("封面", { exact: true })).toBeVisible();

  await page.getByLabel("洗车门店联系电话").fill("022-66889999");
  await page.getByLabel("洗车门店营业时间").fill("周一至周日 08:30-21:00");
  await page.getByLabel("洗车门店简介").fill("商场地库内的预约制精细洗护门店，提供透明套餐与往返代驾取送。");
  await page.getByLabel("洗车门店服务标签").fill("精细洗护，商场停车，夜间营业");
  await page.getByLabel("洗车门店设施").fill("休息区，卫生间，充电桩");
  await page.getByLabel("洗车门店运营提示").fill("由东门进入地库 B2 层，节假日请以预约时段为准");
  await expect(page.getByText("仅演示数据", { exact: true })).toBeVisible();
  await page.getByLabel("洗车门店演示评分").fill("4.7");
  await page.getByLabel("洗车门店演示评价数").fill("126");
  await page.getByRole("button", { name: "保存门店", exact: true }).click();

  await expect.poll(() => trace.storeBody?.phone).toBe("022-66889999");
  expect(trace.storeBody?.description).toContain("预约制精细洗护门店");
  expect(trace.storeBody?.tags).toEqual(["精细洗护", "商场停车", "夜间营业"]);
  expect(trace.storeBody?.facilities).toEqual(["休息区", "卫生间", "充电桩"]);
  expect(trace.storeBody?.businessHoursNotice).toContain("地库 B2 层");
  expect(trace.storeBody?.rating).toBe(4.7);
  expect(trace.storeBody?.reviewCount).toBe(126);
  expect(trace.storeBody?.coverImageUrl).toBe("/api/wash/store-images/wash-image-1");
  expect(trace.storeBody?.images).toBeUndefined();

  await page.getByLabel("上传洗车门店图片").setInputFiles({
    name: "wash-shop.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL0AAAAASUVORK5CYII=", "base64"),
  });
  await expect.poll(() => trace.imageUploadBodies.length).toBe(1);
  expect(trace.imageUploadBodies[0]).toContain('name="sortOrder"');
  expect(trace.imageUploadBodies[0]).toContain('name="file"; filename="wash-shop.png"');
  await expect(page.locator(".wash-store-image-grid article")).toHaveCount(3);

  await page.getByLabel("门店图片 3 上移").click();
  await expect.poll(() => {
    const images = trace.imageOrderBody?.images as Array<{ id: string; sortOrder: number }> | undefined;
    return images?.sort((left, right) => left.sortOrder - right.sortOrder).map((image) => image.id).join("|");
  }).toBe("wash-image-1|wash-image-3|wash-image-2");

  await expect(page.locator(".wash-store-image-grid article").nth(1).locator("img")).toHaveAttribute("src", "/api/admin/wash/store-images/wash-image-3");
  await page.locator(".wash-store-image-grid article").nth(1).getByRole("button", { name: "设为封面" }).click();
  await expect.poll(() => {
    const images = trace.imageOrderBody?.images as Array<{ id: string; isCover?: boolean }> | undefined;
    return images?.find((image) => image.isCover)?.id;
  }).toBe("wash-image-3");
  await expect(page.locator(".wash-store-image-grid article").nth(1)).toContainText("封面");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByLabel("删除门店图片 3").click();
  await expect.poll(() => trace.deletedImageId).toBe("wash-image-2");
  await expect(page.locator(".wash-store-image-grid article")).toHaveCount(2);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("洗车门店、时段、套餐和价格矩阵可维护且在窄桌面不撑开页面", async ({ page }) => {
  const trace = await installWashApiMock(page);
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.goto("/");

  await openWashAdmin(page, "洗车门店");
  await expect(page.getByRole("heading", { name: "洗车门店与预约产能" })).toBeVisible();
  await expect(page.getByRole("button", { name: /津湾臻洗中心.*开放预约/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "洗车代驾取送计价" })).toBeVisible();
  await expect(page.getByText("继承全局规则")).toBeVisible();
  await page.getByLabel("洗车代驾往返起步价").fill("118.00");
  await page.getByRole("button", { name: "创建门店覆盖" }).click();
  await expect.poll(() => trace.valetRuleBody?.baseFeeFen).toBe(11800);
  await expect(page.getByText("门店独立规则")).toBeVisible();
  await page.getByRole("button", { name: "恢复继承" }).click();
  await expect.poll(() => trace.valetRuleDeleted).toBe(true);
  await page.getByLabel("洗车门店运营提示").fill("由东门进入，地库 B2 层");
  await page.getByRole("button", { name: "保存门店", exact: true }).click();
  await expect.poll(() => trace.storeBody?.notice).toBe("由东门进入，地库 B2 层");
  expect(trace.storeBody?.location).toBeUndefined();

  await page.getByLabel("搜索洗车门店位置").fill("万象城");
  await page.getByRole("option", { name: /天津万象城.*天津市河西区乐园道 9 号/ }).click();
  await page.getByRole("button", { name: "保存门店", exact: true }).click();
  await expect.poll(() => (trace.storeBody?.location as { poiId?: string } | undefined)?.poiId).toBe("tencent-wash-store-2");

  await page.getByRole("button", { name: "批量生成" }).click();
  await expect.poll(() => trace.slotBatchBody?.slotMinutes).toBe(60);
  await page.getByLabel("2026-08-18 08:00关闭时段").check();
  await page.locator(".wash-slot-list article").first().getByRole("button", { name: "保存" }).click();
  await expect.poll(() => trace.slotPatchBody?.isOpen).toBe(false);

  await page.getByRole("button", { name: "洗车套餐与价格" }).click();
  await expect(page.getByRole("heading", { name: "洗车套餐与门店价格" })).toBeVisible();
  await page.getByLabel("洗车套餐包含项").fill("高压预冲，车身泡沫清洁，轮毂清洁，擦干，脚垫除尘");
  await page.getByRole("button", { name: "保存套餐", exact: true }).click();
  await expect.poll(() => (trace.packageBody?.serviceItems as string[] | undefined)?.includes("脚垫除尘")).toBe(true);

  const priceGuidance = page.getByRole("note", { name: "销售价与预计结算价说明" });
  await expect(priceGuidance).toContainText("销售价 · 车主可见");
  await expect(priceGuidance).toContainText("会展示在小程序");
  await expect(priceGuidance).toContainText("洗车服务报价和车主应付金额的基础");
  await expect(priceGuidance).toContainText("预计结算价 · 仅平台内部");
  await expect(priceGuidance).toContainText("车主页面不展示");
  await expect(priceGuidance).toContainText("不会改变车主报价或应付金额");
  await expect(page.getByRole("columnheader", { name: "小轿车销售价 / 预计结算价" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "SUV销售价 / 预计结算价" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "MPV销售价 / 预计结算价" })).toBeVisible();
  await expect(page.locator(".wash-offer-cell").first()).toContainText("销售价 车主可见");
  await expect(page.locator(".wash-offer-cell").first()).toContainText("预计结算价 仅内部");
  await expect(page.getByLabel("标准洗护小轿车销售价")).toHaveAttribute("aria-describedby", "wash-price-visibility-note");
  await expect(page.getByLabel("标准洗护小轿车预计结算价")).toHaveAttribute("aria-describedby", "wash-price-visibility-note");
  await page.getByLabel("标准洗护小轿车销售价").fill("42.00");
  await page.getByLabel("标准洗护小轿车预计结算价").fill("31.00");
  await page.getByLabel("标准洗护SUV销售价").fill("53.00");
  await page.getByLabel("标准洗护SUV预计结算价").fill("42.00");
  await page.getByLabel("标准洗护MPV销售价").fill("64.00");
  await page.getByLabel("标准洗护MPV预计结算价").fill("53.00");
  await page.getByRole("button", { name: "保存价格矩阵" }).click();
  await expect.poll(() => {
    const savedOffers = trace.offersBody?.offers as Array<{ packageId: string; vehicleCategory: string; salePriceFen: number }> | undefined;
    return savedOffers?.filter((item) => item.packageId === "wash-package-standard").map((item) => `${item.vehicleCategory}:${item.salePriceFen}`).sort().join("|");
  }).toBe("mpv:6400|sedan:4200|suv:5300");
  const savedOffers = trace.offersBody?.offers as Array<{ packageId: string; vehicleCategory: string; salePriceFen: number; estimatedSettlementFen: number }>;
  const standardMatrix = savedOffers.filter((item) => item.packageId === "wash-package-standard");
  expect(standardMatrix).toHaveLength(3);
  expect(standardMatrix.find((item) => item.vehicleCategory === "sedan")?.estimatedSettlementFen).toBe(3100);
  expect(standardMatrix.find((item) => item.vehicleCategory === "suv")?.estimatedSettlementFen).toBe(4200);
  expect(standardMatrix.find((item) => item.vehicleCategory === "mpv")?.estimatedSettlementFen).toBe(5300);
  expect(standardMatrix.some((item) => item.vehicleCategory === "suv_mpv")).toBe(false);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("快速切换价格矩阵门店时丢弃旧门店的迟到响应", async ({ page }) => {
  const trace = await installWashApiMock(page, { reverseOfferResponses: true });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await openWashAdmin(page, "洗车套餐与价格");

  const storeSelect = page.getByLabel("价格矩阵门店");
  await expect(storeSelect).toHaveValue("wash-store-1");
  await expect.poll(() => trace.offerGetStarted).toContain("wash-store-1");
  await storeSelect.selectOption("wash-store-2");

  await expect(page.getByText("正在读取门店价格…")).toBeVisible();
  await expect(page.getByLabel("标准洗护小轿车销售价")).toHaveValue("138.00");
  await expect.poll(() => trace.offerGetFinished.join("|")).toBe("wash-store-2|wash-store-1");
  await expect(page.getByLabel("标准洗护小轿车销售价")).toHaveValue("138.00");
  await expect(page.getByLabel("标准洗护SUV销售价")).toHaveValue("148.00");
  await expect(page.getByLabel("标准洗护MPV销售价")).toHaveValue("158.00");

  await page.getByRole("button", { name: "保存价格矩阵" }).click();
  await expect.poll(() => trace.offersStoreId).toBe("wash-store-2");
  const savedOffers = trace.offersBody?.offers as Array<{ packageId: string; vehicleCategory: string; salePriceFen: number }>;
  expect(savedOffers.filter((item) => item.packageId === "wash-package-standard").map((item) => `${item.vehicleCategory}:${item.salePriceFen}`).sort().join("|")).toBe("mpv:15800|sedan:13800|suv:14800");
});

test("保存价格期间锁定门店且旧门店慢响应不会覆盖新门店", async ({ page }) => {
  const trace = await installWashApiMock(page, { slowOfferPutStoreId: "wash-store-1" });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await openWashAdmin(page, "洗车套餐与价格");

  const storeSelect = page.getByLabel("价格矩阵门店");
  await expect(storeSelect).toHaveValue("wash-store-1");
  await expect(page.getByLabel("标准洗护小轿车销售价")).toHaveValue("38.00");
  await page.getByLabel("标准洗护小轿车销售价").fill("41.00");
  await page.getByRole("button", { name: "保存价格矩阵" }).click();
  await expect.poll(() => trace.offerPutStarted).toContain("wash-store-1");
  await expect(storeSelect).toBeDisabled();

  await storeSelect.evaluate((element) => {
    const select = element as HTMLSelectElement;
    select.disabled = false;
    select.value = "wash-store-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(storeSelect).toHaveValue("wash-store-2");
  await expect(page.getByLabel("标准洗护小轿车销售价")).toHaveValue("138.00");
  await expect.poll(() => trace.offerPutFinished).toContain("wash-store-1");
  await expect(page.getByLabel("标准洗护小轿车销售价")).toHaveValue("138.00");
  await expect(page.getByLabel("标准洗护SUV销售价")).toHaveValue("148.00");
  await expect(page.getByLabel("标准洗护MPV销售价")).toHaveValue("158.00");
});
