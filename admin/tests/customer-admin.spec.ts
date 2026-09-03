import { expect, test, type Page, type Route } from "@playwright/test";

const platformSession = {
  account: { id: "platform-admin-customer", displayName: "客户运营管理员", role: "platform_admin" },
  subject: null,
  capabilities: ["*", "customers.read", "customers.notes.write", "customers.sensitive.read"],
  expiresAt: "2099-08-25T00:00:00.000Z",
};

const providerSession = {
  account: { id: "wash-admin-customer", displayName: "洗车门店管理员", role: "wash_store_admin" },
  subject: { type: "wash_store", id: "wash-store-customer", name: "测试洗车门店" },
  capabilities: ["wash.dashboard.read", "wash.orders.read"],
  expiresAt: "2099-08-25T00:00:00.000Z",
};

function fulfill(route: Route, data: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status >= 400 ? { error: { message: data } } : { data }),
  });
}

async function mockPlatformShell(page: Page) {
  await page.route("**/api/backoffice/session", (route) => fulfill(route, platformSession));
  await page.route("**/api/admin/stations", (route) => fulfill(route, []));
  await page.route("**/api/admin/inspection-price-plans", (route) => fulfill(route, []));
}

const customer = {
  id: "customer-real-1",
  customerNumber: "C202608250001",
  displayName: "李女士",
  avatarUrl: null,
  status: "active",
  dataKind: "real",
  identity: { bound: true, provider: "wechat", maskedSubject: "oi********8888" },
  tags: ["重点客户"],
  vehicleCount: 2,
  recordCount: 3,
  pendingCount: 1,
  lastActiveAt: "2026-08-25T08:20:00+08:00",
  createdAt: "2026-08-20T09:00:00+08:00",
  updatedAt: "2026-08-25T08:20:00+08:00",
};

const annualRecord = {
  domain: "annual_inspection",
  recordType: "booking",
  sourceId: "booking-annual-1",
  businessCode: "YXM-ANNUAL-001",
  vehicleId: "vehicle-1",
  status: "confirmed",
  amountFen: 26000,
  occurredAt: "2026-08-25T08:20:00+08:00",
  detailPath: "/bookings?booking=booking-annual-1",
  title: "自驾年检预约",
};

const detail = {
  customer,
  identities: [{ id: "identity-wechat-1", provider: "wechat", providerAppId: "wx-test-app", maskedProviderSubject: "oi********8888", maskedUnionSubject: "un********6666", boundAt: "2026-08-20T09:01:00+08:00" }],
  tags: ["重点客户"],
  notes: [{ id: "note-1", content: "客户希望周末联系。", author: { id: "admin-1", displayName: "张运营" }, createdAt: "2026-08-24T10:00:00+08:00" }],
  stats: { vehicles: 2, records: 3, pending: 1 },
  vehicles: [
    { id: "vehicle-1", plateNumber: "津A88888", brandName: "奔驰", modelName: "S级", vehicleType: "小型轿车", seats: 5, isDefault: true, isDeleted: false, inspectionValidUntil: "2026-09-30", nextInspectionDate: "2026-09-01", lastServiceAt: "2026-08-25T08:20:00+08:00" },
    { id: "vehicle-2", plateNumber: "津B12345", vehicleType: "SUV", seats: 5, isDefault: false, isDeleted: true, updatedAt: "2026-08-21T09:00:00+08:00" },
  ],
  recentRecords: [annualRecord],
  recentActivity: [{ id: "audit-1", type: "customer.tags.update", label: "更新客户标签", description: "增加重点客户", occurredAt: "2026-08-24T09:00:00+08:00", actorName: "张运营", domain: "customer", resourceId: "customer-real-1", outcome: "success" }],
};

const booking = {
  id: "booking-annual-1",
  bookingNumber: "YXM-ANNUAL-001",
  status: "confirmed",
  fulfillmentStatus: "confirmed",
  paymentStatus: "paid",
  appointmentDate: "2026-08-29",
  startTime: "10:00",
  endTime: "11:00",
  contactName: "李女士",
  contactPhone: "13800000000",
  serviceMode: "self_drive",
  serviceFeeFen: 26000,
  inspectionFeeFen: 26000,
  valetFeeFen: 0,
  quoteDistanceKm: null,
  vehiclePriceCategory: "fuel_small",
  station: { id: "station-1", name: "华洋机动车检测站", district: "滨海新区", address: "天津市滨海新区海滨大道 3680 号" },
  vehicle: { plateNumber: "津A88888", vehicleType: "小型轿车", seats: 5 },
  payments: [],
  ledgerEntries: [],
  events: [{ id: "event-1", status: "confirmed", title: "预约已确认", description: "模拟支付后自动确认", createdAt: "2026-08-25T08:20:00+08:00" }],
  media: [],
  vehicleCheckupReport: null,
  createdAt: "2026-08-25T08:20:00+08:00",
};

test("平台客户中心完成脱敏身份、标签备注、车辆资料和业务深链闭环", async ({ page }) => {
  await mockPlatformShell(page);
  let tagBody: unknown;
  let noteBody: unknown;
  let revealCount = 0;

  await page.route("**/api/admin/customers**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/api/admin/customers" && method === "GET") return fulfill(route, {
      items: [customer],
      summary: { real: 1, demo: 2, unknown: 0, wechatBound: 1, withBusinessRecords: 1 },
      nextCursor: null,
    });
    if (path === "/api/admin/customers/customer-real-1" && method === "GET") return fulfill(route, detail);
    if (path === "/api/admin/customers/customer-real-1/records" && method === "GET") return fulfill(route, { items: [annualRecord, { ...annualRecord, domain: "repair", recordType: "quote_request", sourceId: "repair-1", businessCode: "YXM-REPAIR-001", title: "维修询价", detailPath: null }], nextCursor: null });
    if (path === "/api/admin/customers/customer-real-1/materials" && method === "GET") return fulfill(route, { items: [
      { id: "material-1", domain: "annual_inspection", businessId: "booking-annual-1", businessCode: "YXM-ANNUAL-001", kind: "license_front", label: "行驶证正面", state: "active", mimeType: "image/jpeg", sizeBytes: 128000, createdAt: "2026-08-25T08:00:00+08:00", expiresAt: "2026-11-25T08:00:00+08:00", deleteAfter: "2026-11-26T00:00:00+08:00", available: true },
      { id: "material-2", domain: "insurance", businessId: "lead-1", businessCode: "YXM-INS-001", kind: "driving_license", label: "驾驶证", state: "withdrawn", mimeType: "image/jpeg", sizeBytes: 98000, createdAt: "2026-08-22T08:00:00+08:00", available: false },
    ], nextCursor: null });
    if (path === "/api/admin/customers/customer-real-1/tags" && method === "PUT") {
      tagBody = route.request().postDataJSON();
      return fulfill(route, { tags: ["重点客户", "待跟进"] });
    }
    if (path === "/api/admin/customers/customer-real-1/notes" && method === "POST") {
      noteBody = route.request().postDataJSON();
      return fulfill(route, { note: { id: "note-2", content: "已电话确认周六到站。", author: { id: "admin-current", displayName: "客户运营管理员" }, createdAt: "2026-08-25T09:00:00+08:00" } });
    }
    if (path === "/api/admin/customers/customer-real-1/identities/identity-wechat-1/reveal" && method === "POST") {
      revealCount += 1;
      return fulfill(route, { identity: { id: "identity-wechat-1", provider: "wechat", providerAppId: "wx-test-app", providerSubject: "openid-full-should-only-appear-after-reveal", unionSubject: "unionid-full-audited" } });
    }
    return fulfill(route, "未找到客户资源", 404);
  });

  await page.route("**/api/admin/bookings**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/bookings/booking-annual-1") return fulfill(route, booking);
    if (path === "/api/admin/bookings") return fulfill(route, [booking]);
    return fulfill(route, "未找到预约", 404);
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "客户中心与全业务视图" })).toBeVisible();
  await expect(page.getByRole("button", { name: "客户中心" })).toBeVisible();
  await expect(page.getByLabel("客户指标")).toContainText("真实客户1 人");
  await expect(page.getByLabel("客户指标")).toContainText("演示客户2 人");
  await expect(page.getByText("C202608250001", { exact: true })).toBeVisible();
  await expect(page.getByText("openid-full-should-only-appear-after-reveal")).toHaveCount(0);
  await expect(page.locator(".customer-center")).toHaveCSS("font-size", "12px");

  const activeRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/admin/customers" && new URL(request.url()).searchParams.get("activeWithinDays") === "30");
  await page.getByLabel("客户最近活跃").selectOption("30");
  await activeRequest;
  await page.getByRole("button", { name: "查看客户 李女士" }).click();

  await expect(page).toHaveURL(/\/customers\/customer-real-1$/);
  await expect(page.getByRole("heading", { name: "客户 360 档案" })).toBeVisible();
  await expect(page.locator(".customer-detail-page .detail-drawer")).toHaveCount(0);
  await expect(page.getByText("oi********8888", { exact: false })).toBeVisible();
  await expect(page.getByText("openid-full-should-only-appear-after-reveal")).toHaveCount(0);

  await page.getByRole("button", { name: "查看完整标识" }).click();
  await expect(page.getByRole("dialog", { name: "完整微信身份标识" })).toContainText("本次查看已记录到操作日志");
  await expect(page.getByRole("dialog", { name: "完整微信身份标识" })).toContainText("openid-full-should-only-appear-after-reveal");
  expect(revealCount).toBe(1);
  await page.getByRole("button", { name: "关闭敏感信息" }).click();

  await page.getByRole("button", { name: "待跟进" }).click();
  await expect.poll(() => tagBody).toEqual({ tags: ["重点客户", "待跟进"] });
  await expect(page.getByRole("button", { name: "待跟进" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("新增客户内部备注").fill("已电话确认周六到站。");
  await page.getByRole("button", { name: "追加备注" }).click();
  await expect.poll(() => noteBody).toEqual({ content: "已电话确认周六到站。" });
  await expect(page.getByText("已电话确认周六到站。", { exact: true })).toBeVisible();

  await page.locator(".customer-detail-tabs").getByRole("button", { name: /车辆/ }).click();
  await expect(page.getByText("津A88888", { exact: false })).toBeVisible();
  await expect(page.getByText("已删除档案", { exact: true })).toBeVisible();

  await page.locator(".customer-detail-tabs").getByRole("button", { name: /资料与授权/ }).click();
  await expect(page.getByText("列表仅包含元数据。内容需逐项查看，不提供批量下载或全量导出。")).toBeVisible();
  await expect(page.getByRole("region", { name: "年检服务 YXM-ANNUAL-001 资料" })).toContainText("1 项资料");
  const materialLink = page.getByRole("link", { name: "逐项查看资料 行驶证正面" });
  await expect(materialLink).toHaveAttribute("href", "/api/admin/customers/customer-real-1/materials/annual_inspection/material-1/content");
  await expect(page.getByRole("button", { name: "不可查看" })).toBeDisabled();

  await page.locator(".customer-detail-tabs").getByRole("button", { name: /操作记录/ }).click();
  await expect(page.getByText("更新客户标签", { exact: true })).toBeVisible();
  await page.locator(".customer-detail-tabs").getByRole("button", { name: /业务记录/ }).click();
  await expect(page.getByText("维修询价", { exact: true })).toBeVisible();
  await expect(page.getByText("暂无独立后台详情", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开业务详情" }).first().click();

  await expect(page).toHaveURL(/\/bookings\?booking=booking-annual-1$/);
  await expect(page.getByRole("complementary", { name: "预约与账务详情" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "预约与账务详情" })).toContainText("YXM-ANNUAL-001");
});

test("洗车门店管理员没有客户中心入口且直达 URL 被拒绝", async ({ page }) => {
  let customerRequests = 0;
  await page.route("**/api/backoffice/session", (route) => fulfill(route, providerSession));
  await page.route("**/api/admin/customers**", (route) => { customerRequests += 1; return fulfill(route, "无权访问", 403); });
  await page.goto("/customers");
  await expect(page.getByText("403 · ACCESS DENIED")).toBeVisible();
  await expect(page.getByRole("button", { name: "客户中心" })).toHaveCount(0);
  expect(customerRequests).toBe(0);
});
