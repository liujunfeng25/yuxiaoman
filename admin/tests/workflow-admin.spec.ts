import { expect, test, type Page } from "@playwright/test";

const desktopViewport = { width: 1280, height: 800 };

async function expectNoDocumentHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.documentElement.clientWidth,
  }))).toEqual({ document: 0, body: 0 });
}

test.describe("履约督办后台", () => {
  test.use({ viewport: desktopViewport });

  test("平台管理员可打开全部工作流页面且桌面外壳不横向溢出", async ({ page }) => {
    const pages = [
      { path: "/workflow", heading: "履约督办任务" },
      { path: "/workflow/settings", heading: "核心业务规则（只读）" },
      { path: "/workflow/templates", heading: "通知模板目录" },
      { path: "/workflow/recipients", heading: "通知联系人" },
      { path: "/workflow/releases", heading: "发布与审计记录" },
    ] as const;

    for (const destination of pages) {
      await page.goto(destination.path);
      await expect(page).toHaveURL(new RegExp(`${destination.path.replaceAll("/", "\\/")}$`));
      await expect(page.getByText(destination.heading, { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("navigation", { name: "履约督办配置导航" })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page);
    }
  });

  test("策略页只读呈现核心状态机，平台管理员只能编辑督办参数", async ({ page }) => {
    await page.goto("/workflow/settings");

    const lockedRules = page.locator(".workflow-locked-section");
    await expect(lockedRules).toBeVisible();
    await expect(lockedRules).toContainText("触发状态");
    await expect(lockedRules).toContainText("下一状态");
    await expect(lockedRules).toContainText("责任角色");
    await expect(lockedRules).toContainText("主体范围");
    await expect(lockedRules).toContainText("关闭动作");
    await expect(lockedRules).toContainText("任务类型");
    await expect(lockedRules.locator("input, select, textarea, button")).toHaveCount(0);

    await expect(page.getByText("首次提醒（分钟）", { exact: true })).toBeVisible();
    await expect(page.getByText("截止时间（分钟）", { exact: true })).toBeVisible();
    await expect(page.getByText("升级时间（分钟）", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "保存草稿" })).toBeVisible();
    await expectNoDocumentHorizontalOverflow(page);
  });

  test("督办列表展示接口返回的责任主体名称", async ({ page }) => {
    await page.route("**/api/admin/workflow/summary?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { pending: 1, dueSoon: 0, overdue: 0, escalated: 0 } }),
      });
    });
    await page.route("**/api/admin/workflow/tasks?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            tasks: [{
              id: "workflow-subject-name",
              domain: "repair_quote",
              nodeCode: "repair.order.selected",
              entityType: "repair_request",
              entityId: "repair-request-subject-name",
              assigneeRole: "repair_shop",
              subject: { type: "repair_shop", id: "shop-haihe-auto" },
              subjectName: "海河汽车服务（演示）",
              status: "open",
              taskKind: "information",
              policy: { id: "repair-workflow-v1", version: 1 },
              anchorAt: "2026-09-06T00:00:00.000Z",
              firstReminderAt: null,
              dueAt: null,
              escalateAt: null,
              reminderCount: 0,
              urgency: "normal",
              metadata: { maskedBusinessCode: "***6DCD22" },
              createdAt: "2026-09-06T00:00:00.000Z",
              updatedAt: "2026-09-06T00:00:00.000Z",
            }],
            summary: { pending: 1, dueSoon: 0, overdue: 0, escalated: 0 },
          },
        }),
      });
    });

    await page.goto("/workflow");
    const task = page.locator(".workflow-task-row").filter({ hasText: "***6DCD22" });
    await expect(task).toContainText("海河汽车服务（演示）");
    await expect(task).not.toContainText("责任主体待补全");
  });

  test("平台异常任务未配置值班联系人时展示明确责任主体", async ({ page }) => {
    await page.route("**/api/admin/workflow/summary?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { pending: 1, dueSoon: 0, overdue: 0, escalated: 1 } }),
      });
    });
    await page.route("**/api/admin/workflow/tasks?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            tasks: [{
              id: "workflow-platform-no-recipient",
              domain: "annual_inspection",
              nodeCode: "workflow.exception",
              entityType: "booking",
              entityId: "booking-platform-no-recipient",
              assigneeRole: "platform",
              subject: { type: "platform_duty", id: "source-task" },
              subjectName: null,
              status: "open",
              taskKind: "blocking",
              policy: { id: "annual-workflow-v1", version: 1 },
              anchorAt: "2026-09-06T00:00:00.000Z",
              firstReminderAt: null,
              dueAt: null,
              escalateAt: null,
              reminderCount: 0,
              urgency: "escalated",
              metadata: { maskedBusinessCode: "***PLATFORM" },
              createdAt: "2026-09-06T00:00:00.000Z",
              updatedAt: "2026-09-06T00:00:00.000Z",
            }],
            summary: { pending: 1, dueSoon: 0, overdue: 0, escalated: 1 },
          },
        }),
      });
    });

    await page.goto("/workflow");
    const task = page.locator(".workflow-task-row").filter({ hasText: "***PLATFORM" });
    await expect(task).toContainText("平台值班组（联系人未配置）");
    await expect(task).not.toContainText("责任主体待补全");
  });

  test("任务详情区分任务中心督办与额外推送", async ({ page }) => {
    const task = {
      id: "workflow-task-center-only",
      domain: "annual_inspection",
      nodeCode: "annual.precheck.pending",
      entityType: "booking",
      entityId: "booking-task-center-only",
      assigneeRole: "station",
      subject: { type: "inspection_station", id: "station-task-center" },
      subjectName: "华洋机动车检测站",
      status: "open",
      taskKind: "blocking",
      policy: { id: "annual-workflow-v1", version: 1 },
      anchorAt: "2026-09-06T00:00:00.000Z",
      firstReminderAt: "2026-09-06T00:30:00.000Z",
      lastRemindedAt: "2026-09-06T00:30:00.000Z",
      dueAt: "2026-09-06T02:00:00.000Z",
      escalateAt: "2026-09-06T02:00:00.000Z",
      reminderCount: 1,
      urgency: "due_soon",
      taskCenterVisible: true,
      inAppSupervisionMode: "task_center",
      deliveryState: "尚未投递",
      metadata: { maskedBusinessCode: "***CENTER" },
      events: [{
        id: "event-task-center",
        type: "task_center_reminder",
        label: "任务中心站内督办已生效",
        createdAt: "2026-09-06T00:30:00.000Z",
        detail: "任务中心站内督办已生效，未配置额外推送渠道",
      }],
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:30:00.000Z",
    };
    await page.route("**/api/admin/workflow/summary?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { pending: 1, dueSoon: 1, overdue: 0, escalated: 0 } }),
    }));
    await page.route("**/api/admin/workflow/tasks?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { tasks: [task], summary: { pending: 1, dueSoon: 1, overdue: 0, escalated: 0 } } }),
    }));
    await page.route(`**/api/admin/workflow/tasks/${task.id}`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { task } }),
    }));

    await page.goto("/workflow");
    await page.locator(".workflow-task-main").filter({ hasText: "***CENTER" }).click();
    const drawer = page.getByRole("dialog", { name: "督办任务详情" });
    await expect(drawer.getByText("任务中心已生效", { exact: true })).toBeVisible();
    await expect(drawer.getByText("未配置额外推送渠道（不影响任务中心督办）", { exact: true })).toBeVisible();
    await expect(drawer.getByText("任务中心站内督办已生效，未配置额外推送渠道", { exact: true })).toBeVisible();
    await expect(drawer.getByText("本次通知未发送", { exact: true })).toHaveCount(0);
  });

  test("责任角色筛选按运营语义去重并使用标准检测站角色查询", async ({ page }) => {
    await page.goto("/workflow");

    const roleFilter = page.getByLabel("责任角色筛选");
    await expect(roleFilter.locator("option")).toHaveText([
      "全部责任方",
      "车主",
      "检测站",
      "代驾司机",
      "维修店",
      "平台值班组",
    ]);
    await expect(roleFilter.locator("option", { hasText: "检测站" })).toHaveCount(1);

    const filteredRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/admin/workflow/tasks" && url.searchParams.get("role") === "station";
    });
    await roleFilter.selectOption("station");
    await filteredRequest;
    await expect(roleFilter).toHaveValue("station");
  });
});
