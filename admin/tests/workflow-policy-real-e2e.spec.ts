import { expect, test } from "@playwright/test";
import { createInitialPlatformAdmin } from "../../server/backoffice.js";
import { createPostgresDatabase, type AppDatabase } from "../../server/database.js";
import { applyWorkflowTransition, enableWorkflowForEntity } from "../../server/workflow.js";

const loginName = "workflow.e2e.admin";
const password = "Workflow-E2E-2026!";
const changedReminderMinutes = "31";

let database: AppDatabase;

test.beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL?.trim();
  const schema = process.env.YUXIAOMAN_E2E_SCHEMA?.trim();
  if (!connectionString || !schema) {
    throw new Error("该测试必须通过隔离 PostgreSQL Playwright 启动器运行");
  }

  database = await createPostgresDatabase({
    connectionString,
    schema,
    createSchema: false,
    dropSchemaOnClose: false,
    max: 2,
    applicationName: "yuxiaoman-workflow-policy-browser-e2e",
  });
  await createInitialPlatformAdmin(database, {
    loginName,
    displayName: "督办配置验收管理员",
    password,
  });
});

test.afterAll(async () => {
  await database?.close();
});

test("管理员通过真实页面发布年检督办策略新版本并留下发布记录", async ({ page }) => {
  test.setTimeout(60_000);

  const oldTaskAnchor = new Date("2026-09-05T01:00:00.000Z");
  await enableWorkflowForEntity(database, {
    domain: "annual_inspection",
    entityType: "booking",
    entityId: "workflow-browser-old-booking",
    ownerUserId: "demo-user",
    createdAt: oldTaskAnchor,
  });
  const oldTransition = await applyWorkflowTransition(database, {
    domain: "annual_inspection",
    entityType: "booking",
    entityId: "workflow-browser-old-booking",
    open: [{
      nodeCode: "annual.precheck.pending",
      subjectType: "inspection_station",
      subjectId: "station-hexi-1",
      metadata: { maskedBusinessCode: "YXM-OLD-E2E" },
    }],
  }, { now: oldTaskAnchor });
  expect(oldTransition.opened).toHaveLength(1);
  expect(oldTransition.opened[0].policy.version).toBe(1);
  expect(oldTransition.opened[0].firstReminderAt).toBe("2026-09-05T01:30:00.000Z");

  // The shared admin E2E server enables an anonymous test fallback for the
  // ordinary operational scenarios. This real-login scenario must instead
  // start as anonymous, regardless of an existing page context or fallback.
  await page.context().clearCookies();
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.route("**/api/backoffice/session", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "请先登录" } }) });
      return;
    }
    await route.continue();
  });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "登录运营后台" })).toBeVisible();
  await page.getByLabel("后台登录名").fill(loginName);
  await page.getByLabel("后台登录密码").fill(password);

  const loginResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/backoffice/sessions")
      && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "安全登录" }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(200);
  await page.unroute("**/api/backoffice/session");
  await expect(page).toHaveURL(/\/bookings$/u);
  await expect(page.getByText("督办配置验收管理员", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "督办策略", exact: true }).click();
  await expect(page).toHaveURL(/\/workflow\/settings$/u);
  await expect(page.getByText("核心业务规则（只读）", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "检测站预约资料预检" })).toBeVisible();
  await expect(page.getByText("第1版", { exact: true }).first()).toBeVisible();

  const reminderInput = page.getByLabel("首次提醒（分钟）");
  await expect(reminderInput).toHaveValue("30");
  await reminderInput.fill(changedReminderMinutes);
  await expect(page.getByText(/有未保存修改/u)).toBeVisible();

  const saveResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/admin/workflow/policies/draft")
      && response.request().method() === "PUT"
  ));
  await page.getByRole("button", { name: "保存草稿" }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status()).toBe(200);
  await expect(page.getByRole("status")).toContainText("草稿已保存，线上生效策略未改变");
  await expect(page.getByText(/草稿修订 \d+ · 已保存/u)).toBeVisible();

  const validateResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/admin/workflow/policies/draft/validate")
      && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const validateResponse = await validateResponsePromise;
  expect(validateResponse.status()).toBe(200);
  await expect(page.getByText("校验通过", { exact: true })).toBeVisible();

  const previewResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/admin/workflow/policies/draft/preview")
      && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "预览", exact: true }).click();
  const previewResponse = await previewResponsePromise;
  expect(previewResponse.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "实际调度预览" })).toBeVisible();
  await expect(page.locator(".workflow-preview-list")).toContainText("首次提醒：");
  await expect(page.locator(".workflow-preview-list")).toContainText("站内");

  const publishResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/admin/workflow/policies/draft/publish")
      && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "发布新版本" }).click();
  const publishResponse = await publishResponsePromise;
  expect(publishResponse.status()).toBe(200);
  await expect(page.getByRole("status")).toContainText("策略第2版已发布");
  await expect(page.getByText("第2版", { exact: true }).first()).toBeVisible();

  const newTaskAnchor = new Date("2026-09-05T02:00:00.000Z");
  await enableWorkflowForEntity(database, {
    domain: "annual_inspection",
    entityType: "booking",
    entityId: "workflow-browser-new-booking",
    ownerUserId: "demo-user",
    createdAt: newTaskAnchor,
  });
  const newTransition = await applyWorkflowTransition(database, {
    domain: "annual_inspection",
    entityType: "booking",
    entityId: "workflow-browser-new-booking",
    open: [{
      nodeCode: "annual.precheck.pending",
      subjectType: "inspection_station",
      subjectId: "station-hexi-1",
      metadata: { maskedBusinessCode: "YXM-NEW-E2E" },
    }],
  }, { now: newTaskAnchor });
  expect(newTransition.opened).toHaveLength(1);
  expect(newTransition.opened[0].policy.version).toBe(2);
  expect(newTransition.opened[0].firstReminderAt).toBe("2026-09-05T02:31:00.000Z");

  const taskVersions = await database.prepare<Record<string, unknown>>(`
    SELECT entity_id, policy_version, first_reminder_at
    FROM workflow_tasks
    WHERE entity_id = ANY(?)
    ORDER BY entity_id
  `).all(["workflow-browser-old-booking", "workflow-browser-new-booking"]);
  expect(taskVersions).toHaveLength(2);
  expect(taskVersions.map((row) => ({
    entityId: row.entity_id,
    policyVersion: Number(row.policy_version),
    firstReminderAt: new Date(String(row.first_reminder_at)).toISOString(),
  }))).toEqual([
    {
      entityId: "workflow-browser-new-booking",
      policyVersion: 2,
      firstReminderAt: "2026-09-05T02:31:00.000Z",
    },
    {
      entityId: "workflow-browser-old-booking",
      policyVersion: 1,
      firstReminderAt: "2026-09-05T01:30:00.000Z",
    },
  ]);

  await page.getByRole("navigation", { name: "履约督办配置导航" })
    .getByRole("button", { name: "履约督办", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflow$/u);
  const newTaskCard = page.locator(".workflow-task-row").filter({ hasText: "YXM-NEW-E2E" }).first();
  await expect(newTaskCard).toBeVisible();
  await newTaskCard.click();
  const taskDrawer = page.getByRole("dialog", { name: "督办任务详情" });
  await expect(taskDrawer).toContainText("第2版");
  await taskDrawer.getByRole("button", { name: "关闭任务详情" }).click();

  await page.getByRole("navigation", { name: "履约督办配置导航" })
    .getByRole("button", { name: "发布记录", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflow\/releases$/u);
  await expect(page.getByRole("heading", { name: "发布与审计记录", level: 2 })).toBeVisible();
  const releaseRow = page.locator(".workflow-release-list article").filter({ hasText: "督办策略" }).filter({ hasText: "第2版" }).first();
  await expect(releaseRow).toBeVisible();
  await expect(releaseRow).toContainText("已发布");

  const persisted = await database.prepare<Record<string, unknown>>(`
    SELECT p.id, p.version, p.is_current, n.first_reminder_minutes
    FROM workflow_policy_sets p
    JOIN workflow_policy_nodes n ON n.policy_set_id = p.id
    WHERE p.domain = 'annual_inspection'
      AND p.state = 'published'
      AND p.is_current = 1
      AND n.node_code = 'annual.precheck.pending'
  `).get();
  expect(Number(persisted?.version)).toBe(2);
  expect(Number(persisted?.is_current)).toBe(1);
  expect(Number(persisted?.first_reminder_minutes)).toBe(Number(changedReminderMinutes));

  const release = await database.prepare<Record<string, unknown>>(`
    SELECT resource_id, domain, version, action
    FROM workflow_release_events
    WHERE resource_type = 'workflow_policy'
      AND domain = 'annual_inspection'
      AND version = 2
  `).get();
  expect(release).toMatchObject({
    resource_id: persisted?.id,
    domain: "annual_inspection",
    version: 2,
    action: "published",
  });
});
