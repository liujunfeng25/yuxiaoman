import { expect, test, type Page, type Route } from "@playwright/test";

const forbiddenTechnicalCopy = [
  "YUXIAOMAN OPERATIONS",
  "YUXIAOMAN BACKOFFICE",
  "ACCOUNT ACTIVATION",
  "CHANGE PASSWORD",
  "NEW SERVICE ACCOUNT",
  "SERVICE ACCOUNTS",
  "REPLACE ADMIN",
  "SET PASSWORD",
  "ACCESS DENIED",
  "STORE OPERATIONS",
  "UPCOMING SERVICES",
  "RECENT ACTIVITY",
  "OFFLINE RECONCILIATION",
  "DRIVING SCHOOL OPERATIONS",
  "SCHOOL DIRECTORY",
  "PRIVACY-SAFE INQUIRIES",
  "MINI-PROGRAM: LIST + DETAIL",
  "MINI-PROGRAM: FILTER + QUALIFICATION",
  "MINI-PROGRAM: COVER + GALLERY",
  "MINI-PROGRAM: PRICE + INQUIRY",
  "annual-workflow-v1",
  "annual-workflow",
  "annual.precheck.pending",
  "pending_precheck",
  "triggerState",
  "nextState",
  "assigneeRole",
  "subjectScope",
  "closureAction",
  "taskKind",
  "prohibitedAutomation",
  "booking.station",
  "booking.precheck.approved_or_action_required",
  "maskedPlate",
  "appointmentTime",
  "stationName",
  "pendingCount",
  "overdueCount",
  "reportConclusion",
  "remainingTime",
  "maskedBusinessCode",
  "maskedBusinessNumber",
  "providerStatus",
  "fieldMappings",
  "actionCode",
  "system-seed",
  "SECURE SIGN IN",
  "Failed to fetch",
  "NetworkError",
  "Unexpected token",
  "Internal Server Error",
  "ECONNREFUSED",
  "TypeError",
  "SyntaxError",
  "HTTP 500",
  "application/json",
  "/api/",
  "API",
  "JSON",
  "token",
  "stack",
  "suspended_by_policy",
  "v1",
] as const;

const platformSession = {
  account: { id: "platform-copy-audit", displayName: "平台文案测试员", role: "platform_admin" },
  subject: null,
  capabilities: ["*"],
  expiresAt: "2099-09-05T00:00:00.000Z",
};

const washStoreSession = {
  account: { id: "wash-copy-audit", displayName: "门店文案测试员", role: "wash_store_admin" },
  subject: { type: "wash_store", id: "wash-store-copy-audit", name: "津湾臻洗中心" },
  capabilities: ["wash.dashboard.read", "wash.orders.read", "wash.store.read", "audit.self.read"],
  expiresAt: "2099-09-05T00:00:00.000Z",
};

function fulfill(route: Route, data: unknown, status = 200, meta?: Record<string, unknown>) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status >= 400 ? { error: { message: data } } : { data, ...(meta ? { meta } : {}) }),
  });
}

async function mockPlatformSession(page: Page) {
  await page.route("**/api/backoffice/session", (route) => fulfill(route, platformSession));
}

const drivingSchool = {
  id: "school-copy-audit",
  name: "海河演示驾校",
  legalName: null,
  description: "驾校公开简介",
  dataKind: "demo",
  isDemo: true,
  district: "南开区",
  address: "天津市南开区示范路 1 号",
  location: {
    poiId: "poi-school-copy-audit",
    title: "海河演示驾校",
    address: "天津市南开区示范路 1 号",
    district: "南开区",
    latitude: 39.12,
    longitude: 117.18,
    source: "demo",
  },
  publicPhone: "022-88886666",
  internalContact: null,
  coverImage: null,
  images: [],
  trainingClasses: [{
    licenseClassCode: "C1",
    name: "小型汽车",
    supportedModes: ["initial"],
    applicationModes: ["initial"],
    catalogConditions: [],
    schoolConditions: [],
    conditions: [],
    status: "active",
  }],
  offers: [],
  startingPriceFen: null,
  tags: ["演示数据"],
  facilities: ["训练场"],
  openHours: "08:00-18:00",
  regulatory: {
    type: "filing",
    number: "演示备案 001",
    authority: "天津市交通运输主管部门",
    sourceUrl: null,
    sourceLabel: "演示备案资料",
    validFrom: null,
    validUntil: null,
    verifiedAt: null,
    status: "demo",
    capabilityLevel: "level_1",
  },
  isActive: true,
  isPublished: false,
  publishedAt: null,
  inquiryAvailable: false,
  sortPriority: 0,
  updatedAt: "2026-09-05T08:00:00.000Z",
  offerUpdatedAt: null,
};

async function expectNoTechnicalCopy(page: import("@playwright/test").Page) {
  const visibleCopy = page.locator("body");
  for (const text of forbiddenTechnicalCopy) {
    await expect(visibleCopy, `运营界面不应展示技术文案：${text}`).not.toContainText(text);
  }
}

test.describe("运营后台中文文案", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("登录页不展示英文产品标语或技术文案", async ({ page }) => {
    await page.route("**/api/backoffice/session", (route) => route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "请先登录" } }),
    }));

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "登录运营后台" })).toBeVisible();
    await expect(page.getByLabel("后台登录名")).toBeVisible();
    await expect(page.getByLabel("后台登录密码")).toBeVisible();
    await expect(page.getByRole("button", { name: "安全登录" })).toBeVisible();
    await expectNoTechnicalCopy(page);
  });

  test("督办策略页以运营语言呈现策略、节点和只读规则", async ({ page }) => {
    await page.goto("/workflow/settings");

    await expect(page).toHaveURL(/\/workflow\/settings$/);
    await expect(page.getByText("核心业务规则（只读）", { exact: true })).toBeVisible();
    await expect(page.getByText("当前生效版本", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "检测站预约资料预检", exact: true })).toBeVisible();
    await expect(page.getByText("触发状态", { exact: true })).toBeVisible();
    await expect(page.getByText("下一状态", { exact: true })).toBeVisible();
    await expect(page.getByText("责任角色", { exact: true })).toBeVisible();
    await expectNoTechnicalCopy(page);
  });

  test("模板、联系人和发布记录页不展示内部字段或版本编码", async ({ page }) => {
    const pages = [
      { path: "/workflow/templates", heading: "通知模板目录" },
      { path: "/workflow/recipients", heading: "通知联系人" },
      { path: "/workflow/releases", heading: "发布与审计记录" },
    ] as const;

    for (const destination of pages) {
      await page.goto(destination.path);
      await expect(page).toHaveURL(new RegExp(`${destination.path.replaceAll("/", "\\/")}$`));
      await expect(page.getByText(destination.heading, { exact: true }).first()).toBeVisible();
      await expectNoTechnicalCopy(page);
    }
  });

  test("服务商账号页使用中文眉题并隐藏未知状态枚举", async ({ page }) => {
    await mockPlatformSession(page);
    await page.route("**/api/admin/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/admin/backoffice/accounts") {
        return fulfill(route, [{
          id: "account-copy-audit",
          loginName: "jinwan_manager",
          displayName: "津湾门店管理员",
          role: "wash_store_admin",
          status: "suspended_by_policy",
          subject: { type: "wash_store", id: "wash-store-copy-audit", name: "津湾臻洗中心" },
          activatedAt: null,
          lastLoginAt: "invalid-date",
        }], 200, { directPasswordEnabled: true });
      }
      if ([
        "/api/admin/stations",
        "/api/admin/inspection-price-plans",
        "/api/admin/wash/stores",
        "/api/admin/repair/shops",
      ].includes(path)) return fulfill(route, []);
      return fulfill(route, []);
    });

    await page.goto("/service-accounts");

    await expect(page.getByRole("heading", { name: "服务商账号与主体绑定" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "创建服务主体管理员" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "服务商账号", exact: true })).toBeVisible();
    await expect(page.getByText("1 个服务商账号", { exact: true })).toBeVisible();
    await expect(page.getByText("状态待核对", { exact: true })).toBeVisible();
    await expect(page.getByText("时间待核对", { exact: true })).toBeVisible();
    await expectNoTechnicalCopy(page);
  });

  test("驾校单校工作台不展示英文产品眉题或传输层术语", async ({ page }) => {
    await mockPlatformSession(page);
    await page.route("**/api/admin/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/admin/driving-schools") {
        return fulfill(route, { items: [drivingSchool], pagination: { page: 1, pageSize: 100, total: 1 } });
      }
      if (path === `/api/admin/driving-schools/${drivingSchool.id}`) return fulfill(route, drivingSchool);
      if (path === `/api/admin/driving-schools/${drivingSchool.id}/preview`) {
        return fulfill(route, {
          savedAt: drivingSchool.updatedAt,
          revision: "中文测试版本",
          summary: drivingSchool,
          detail: drivingSchool,
          visibility: { listVisible: false, detailVisible: false, inquiryAvailable: false, reasons: ["学校尚未发布"] },
          checklist: [],
          offerMappings: [],
          testPaths: { list: "", detail: "", inquiry: "" },
        });
      }
      if (["/api/admin/stations", "/api/admin/inspection-price-plans"].includes(path)) return fulfill(route, []);
      return fulfill(route, []);
    });

    await page.goto("/driving-schools");
    await expect(page.getByRole("heading", { name: "驾校服务运营台" })).toBeVisible();
    await page.getByRole("button", { name: `配置与预览 ${drivingSchool.name}` }).click();

    const workbench = page.getByLabel(`驾校配置工作台 ${drivingSchool.name}`);
    await expect(workbench).toBeVisible();
    await expect(workbench.getByRole("heading", { name: drivingSchool.name })).toBeVisible();
    await expect(workbench.getByText("单校配置工作台 · 小程序内容一处维护、保存后统一预览", { exact: true })).toBeVisible();
    await expect(workbench.getByRole("button", { name: "返回驾校列表" })).toBeVisible();
    await expectNoTechnicalCopy(page);
  });

  test("无权限页面只展示中文权限说明", async ({ page }) => {
    await page.route("**/api/backoffice/session", (route) => fulfill(route, washStoreSession));
    await page.route("**/api/admin/wash/stores", (route) => fulfill(route, [{
      id: washStoreSession.subject.id,
      name: washStoreSession.subject.name,
      isActive: true,
      isOpen: true,
    }]));

    await page.goto("/service-accounts");

    await expect(page.getByText("403 · 无权访问", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "这个账号没有访问权限" })).toBeVisible();
    await expectNoTechnicalCopy(page);
  });

  test("登录接口的英文技术错误不会直接展示给运营人员", async ({ page }) => {
    await page.route("**/api/backoffice/session", (route) => fulfill(route, "请先登录", 401));
    await page.route("**/api/backoffice/sessions", (route) => route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Failed to fetch /api/backoffice/sessions: TypeError: NetworkError",
        },
      }),
    }));

    await page.goto("/login");
    await page.getByLabel("后台登录名").fill("copy-audit");
    await page.getByLabel("后台登录密码").fill("correct-horse-battery-staple");
    await page.getByRole("button", { name: "安全登录" }).click();

    const error = page.locator(".backoffice-form-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/登录|连接|网络|稍后|重试/);
    await expectNoTechnicalCopy(page);
  });
});
