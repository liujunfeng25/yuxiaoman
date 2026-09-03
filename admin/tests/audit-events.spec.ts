import { expect, test, type Page, type Route } from "@playwright/test";

const platformSession = {
  account: { id: "platform-admin-1", displayName: "平台测试管理员", role: "platform_admin" },
  subject: null,
  capabilities: ["*"],
  expiresAt: "2099-08-25T00:00:00.000Z",
};

const providerSession = {
  account: { id: "store-admin-1", displayName: "王店长", role: "wash_store_admin" },
  subject: { type: "wash_store", id: "wash-store-a", name: "津湾臻洗中心", status: "active" },
  capabilities: ["audit.self.read"],
  expiresAt: "2099-08-25T00:00:00.000Z",
};

const platformEvent = {
  id: "audit-inspection-arrival-1",
  category: { code: "inspection", label: "预约与检测" },
  actionLabel: "确认车辆到站",
  summary: "平台测试管理员已确认订单 YXJ-20260825-001 到站。",
  actor: { id: "platform-admin-1", displayName: "平台测试管理员", roleLabel: "平台管理员" },
  subject: { type: "inspection_station", id: "station-huayang-1", name: "天津市华洋机动车检测有限公司" },
  target: { type: "booking", id: "internal-booking-uuid", label: "订单 YXJ-20260825-001" },
  outcome: { code: "success", label: "成功" },
  occurredAt: "2026-08-25T09:18:00.000+08:00",
  hasDetails: true,
  // Compatibility noise must never leak into the operator-facing page even if an
  // older server accidentally includes it beside the new presentation DTO.
  action: "backoffice.http.admin.get",
  requestId: "req-secret-technical-id",
  resourceType: "route",
};

const platformEventDetail = {
  ...platformEvent,
  changes: [
    { field: "status", label: "履约状态", before: "待到站", after: "已到站" },
    { field: "arrivedAt", label: "到站时间", before: null, after: "2026年8月25日 17:18" },
  ],
  reason: null,
};

const providerEvent = {
  id: "audit-wash-redeem-1",
  category: { code: "wash", label: "洗车服务" },
  actionLabel: "核销洗车订单",
  summary: "已完成订单 YXW-20260825-008 的到店核销。",
  actor: { id: "store-admin-1", displayName: "王店长", roleLabel: "洗车店管理员" },
  subject: { type: "wash_store", id: "wash-store-a", name: "津湾臻洗中心" },
  target: { type: "wash_order", id: "internal-wash-order-uuid", label: "订单 YXW-20260825-008" },
  outcome: { code: "success", label: "成功" },
  occurredAt: "2026-08-25T10:28:00.000+08:00",
  hasDetails: true,
};

function fulfill(route: Route, data: unknown, status = 200, meta?: Record<string, unknown>) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status >= 400
      ? { error: { message: data } }
      : { data, ...(meta ? { meta } : {}) }),
  });
}

async function mockSession(page: Page, session: typeof platformSession | typeof providerSession) {
  await page.route("**/api/backoffice/session", (route) => fulfill(route, session));
}

function isAuditList(url: URL) {
  return url.pathname === "/api/admin/audit-events";
}

test("平台操作记录使用中文列表、提交业务筛选并以键盘关闭详情抽屉", async ({ page }) => {
  const auditListUrls: string[] = [];
  await mockSession(page, platformSession);
  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (isAuditList(url)) {
      auditListUrls.push(url.toString());
      return fulfill(route, { items: [platformEvent], total: 1 }, 200, { page: 1, pageSize: 25, total: 1 });
    }
    if (url.pathname === `/api/admin/audit-events/${platformEvent.id}`) {
      return fulfill(route, platformEventDetail);
    }
    if (url.pathname === "/api/admin/backoffice/accounts") {
      return fulfill(route, [{ id: "platform-admin-1", displayName: "平台测试管理员", loginName: "platform.test", role: "platform_admin", status: "active" }]);
    }
    if (url.pathname === "/api/admin/wash/stores") {
      return fulfill(route, [{ id: "wash-store-a", name: "津湾臻洗中心" }]);
    }
    if (url.pathname === "/api/admin/stations" || url.pathname === "/api/admin/inspection-price-plans") {
      return fulfill(route, []);
    }
    return fulfill(route, { items: [], total: 0 });
  });

  await page.goto("/audit");

  const card = page.locator(".backoffice-audit-card");
  await expect(card.getByRole("heading", { name: "操作记录" })).toBeVisible();
  await expect(card).toContainText("查看、搜索和翻页不会产生记录");
  await expect(card.getByRole("columnheader", { name: "操作人员" })).toBeVisible();
  await expect(card.getByText("确认车辆到站", { exact: true })).toBeVisible();
  await expect(card.getByText("平台测试管理员已确认订单 YXJ-20260825-001 到站。", { exact: true })).toBeVisible();
  await expect(card.getByText("平台管理员", { exact: true })).toBeVisible();
  await expect(card.getByText("订单 YXJ-20260825-001", { exact: true })).toBeVisible();

  await card.getByLabel("操作记录关键词").fill("YXJ-20260825-001");
  await card.getByLabel("操作记录业务分类").selectOption("inspection");
  await card.getByLabel("操作记录操作人员").selectOption("platform-admin-1");
  await card.getByLabel("操作记录业务主体").selectOption("wash-store-a");
  await card.getByLabel("操作记录结果").selectOption("success");
  await card.getByLabel("操作记录开始日期").fill("2026-08-20");
  await card.getByLabel("操作记录结束日期").fill("2026-08-25");
  await expect.poll(() => auditListUrls.some((rawUrl) => {
    const url = new URL(rawUrl);
    return url.searchParams.get("keyword") === "YXJ-20260825-001"
      && url.searchParams.get("category") === "inspection"
      && url.searchParams.get("accountId") === "platform-admin-1"
      && url.searchParams.get("subjectId") === "wash-store-a"
      && url.searchParams.get("outcome") === "success"
      && url.searchParams.get("dateFrom") === "2026-08-20"
      && url.searchParams.get("dateTo") === "2026-08-25";
  })).toBe(true);

  const detailButton = card.getByRole("button", { name: "查看详情" });
  await detailButton.click();
  const drawer = page.getByRole("dialog", { name: "操作记录详情" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "确认车辆到站" })).toBeVisible();
  await expect(drawer).toContainText("履约状态");
  await expect(drawer).toContainText("待到站");
  await expect(drawer).toContainText("已到站");
  await expect(drawer).toContainText("到站时间");
  await expect(drawer.getByRole("button", { name: "关闭操作记录详情" })).toBeFocused();

  await expect(page.locator("body")).not.toContainText("backoffice.http.admin.get");
  await expect(page.locator("body")).not.toContainText("req-secret-technical-id");
  await expect(page.locator("body")).not.toContainText("platform_admin");
  await expect(page.locator("body")).not.toContainText("internal-booking-uuid");
  await expect(page.locator("body")).not.toContainText("route");

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(detailButton).toBeFocused();
});

test("服务商操作记录是本人本店简版，不重复展示固定操作人和门店", async ({ page }) => {
  await mockSession(page, providerSession);
  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (isAuditList(url)) return fulfill(route, { items: [providerEvent], total: 1 }, 200, { page: 1, pageSize: 25, total: 1 });
    if (url.pathname === `/api/admin/audit-events/${providerEvent.id}`) {
      return fulfill(route, { ...providerEvent, changes: [], reason: null });
    }
    return fulfill(route, { items: [], total: 0 });
  });

  await page.goto("/my-audit");

  const card = page.locator(".backoffice-audit-card");
  const table = card.locator(".backoffice-audit-table");
  await expect(card.getByRole("heading", { name: "我的操作记录" })).toBeVisible();
  await expect(card).toContainText("仅显示你在当前门店完成的关键操作");
  await expect(table.getByRole("columnheader", { name: "操作人员" })).toHaveCount(0);
  await expect(table.getByText("核销洗车订单", { exact: true })).toBeVisible();
  await expect(table.getByText("订单 YXW-20260825-008", { exact: true })).toBeVisible();
  await expect(table.getByText("王店长", { exact: true })).toHaveCount(0);
  await expect(table.getByText("津湾臻洗中心", { exact: true })).toHaveCount(0);
  await expect(card.getByLabel("操作记录业务分类").locator("option[value=wash]")).toHaveCount(1);
  await expect(card.getByLabel("操作记录业务分类").locator("option[value=inspection]")).toHaveCount(0);
  await expect(card.getByLabel("操作记录操作人员")).toHaveCount(0);
  await expect(card.getByLabel("操作记录业务主体")).toHaveCount(0);
});

test("操作记录提供独立加载失败、重试、无记录与筛选无结果状态", async ({ page }) => {
  let shouldFail = true;
  await mockSession(page, platformSession);
  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (isAuditList(url)) {
      if (shouldFail) return fulfill(route, "操作记录服务暂时不可用", 503);
      return fulfill(route, { items: [], total: 0 }, 200, { page: 1, pageSize: 25, total: 0 });
    }
    if (url.pathname === "/api/admin/stations" || url.pathname === "/api/admin/inspection-price-plans") {
      return fulfill(route, []);
    }
    return fulfill(route, { items: [], total: 0 });
  });

  await page.goto("/audit");

  const card = page.locator(".backoffice-audit-card");
  const failure = card.locator(".backoffice-audit-load-error");
  await expect(failure.getByText("操作记录加载失败", { exact: true })).toBeVisible();
  await expect(failure).toContainText("操作记录服务暂时不可用");
  await expect(card.getByText("暂无关键操作记录", { exact: true })).toHaveCount(0);

  shouldFail = false;
  await failure.getByRole("button", { name: "重新加载" }).click();
  await expect(card.getByText("暂无关键操作记录", { exact: true })).toBeVisible();

  await card.getByLabel("操作记录关键词").fill("不存在的订单号");
  await expect(card.getByText("没有符合当前条件的操作记录", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "清除筛选" })).toBeVisible();
});
