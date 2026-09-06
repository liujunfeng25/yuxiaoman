import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { Database } from "../db.js";
import { createWorkflowTask, enableWorkflowForEntity } from "../workflow.js";
import { createTestDatabase } from "./test-database.js";

type Row = Record<string, unknown>;
type Json = Record<string, any>;

async function workflowFixture(): Promise<{
  app: FastifyInstance;
  database: Database;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase("workflow_admin_api");
  const privateRoot = mkdtempSync(join(tmpdir(), "yuxiaoman-workflow-admin-"));
  const app = await buildApp({
    database,
    uploadDir: join(privateRoot, "uploads"),
    insuranceUploadDir: join(privateRoot, "insurance"),
    subsidyConsultationUploadDir: join(privateRoot, "subsidy"),
  });
  await app.ready();
  return {
    app,
    database,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(privateRoot, { recursive: true, force: true });
    },
  };
}

async function createTask(
  database: Database,
  input: {
    domain: "annual_inspection" | "repair_quote";
    entityId: string;
    nodeCode: string;
    subjectType?: string;
    subjectId?: string;
    assigneeRole: "owner" | "station" | "driver" | "repair_shop" | "platform";
    dueAt?: Date;
    escalateAt?: Date;
  },
) {
  await enableWorkflowForEntity(database, {
    domain: input.domain,
    entityType: input.domain === "annual_inspection" ? "booking" : "repair_request",
    entityId: input.entityId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  });
  const task = await createWorkflowTask(database, {
    domain: input.domain,
    entityType: input.domain === "annual_inspection" ? "booking" : "repair_request",
    entityId: input.entityId,
    nodeCode: input.nodeCode,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    assigneeRole: input.assigneeRole,
    firstReminderAt: new Date(Date.now() + 5 * 60_000),
    dueAt: input.dueAt,
    escalateAt: input.escalateAt,
    metadata: {
      maskedBusinessCode: `YXM-***-${input.entityId.slice(-4)}`,
      subjectName: "测试责任主体",
    },
  });
  assert.ok(task, `workflow node ${input.nodeCode} should create a task`);
  return task;
}

test("后台督办任务筛选、关闭状态映射和脱敏详情契约", async () => {
  const { app, database, close } = await workflowFixture();
  try {
    const stations = await database.prepare<Row>("SELECT id, name FROM stations ORDER BY id LIMIT 2").all();
    const shops = await database.prepare<Row>("SELECT id, name FROM repair_shops WHERE is_active = 1 ORDER BY id LIMIT 1").all();
    assert.ok(stations.length >= 1);
    assert.ok(shops.length >= 1);
    const current = Date.now();
    const annual = await createTask(database, {
      domain: "annual_inspection",
      entityId: "workflow-filter-annual",
      nodeCode: "annual.precheck.pending",
      subjectType: "inspection_station",
      subjectId: String(stations[0].id),
      assigneeRole: "station",
      dueAt: new Date(current + 10 * 60_000),
      escalateAt: new Date(current + 40 * 60_000),
    });
    const repair = await createTask(database, {
      domain: "repair_quote",
      entityId: "workflow-filter-repair",
      nodeCode: "repair.quote.first",
      subjectType: "repair_shop",
      subjectId: String(shops[0].id),
      assigneeRole: "repair_shop",
      dueAt: new Date(current + 90 * 60_000),
      escalateAt: new Date(current + 120 * 60_000),
    });
    const platform = await createTask(database, {
      domain: "annual_inspection",
      entityId: "workflow-filter-platform",
      nodeCode: "workflow.exception",
      subjectType: "platform_duty",
      subjectId: "workflow-filter-platform-source",
      assigneeRole: "platform",
      dueAt: new Date(current + 30 * 60_000),
      escalateAt: new Date(current + 60 * 60_000),
    });
    const closedStatuses = ["completed", "cancelled", "expired"] as const;
    for (const status of closedStatuses) {
      const task = await createTask(database, {
        domain: "annual_inspection",
        entityId: `workflow-closed-${status}`,
        nodeCode: "annual.driver.claim",
        assigneeRole: "driver",
        dueAt: new Date(current + 60 * 60_000),
        escalateAt: new Date(current + 90 * 60_000),
      });
      await database.prepare(`
        UPDATE workflow_tasks SET status = ?, closed_at = ?, closed_reason = 'test', updated_at = ? WHERE id = ?
      `).run(status, new Date().toISOString(), new Date().toISOString(), task.id);
    }

    const dueSoon = await app.inject({
      method: "GET",
      url: "/api/admin/workflow/tasks?status=open&domain=annual_inspection&role=station&urgency=due_soon",
    });
    assert.equal(dueSoon.statusCode, 200, dueSoon.body);
    assert.deepEqual(dueSoon.json<Json>().data.tasks.map((task: Json) => task.id), [annual.id]);

    const repairOnly = await app.inject({
      method: "GET",
      url: "/api/admin/workflow/tasks?status=open&domain=repair_quote&role=repair_shop",
    });
    assert.equal(repairOnly.statusCode, 200, repairOnly.body);
    assert.deepEqual(repairOnly.json<Json>().data.tasks.map((task: Json) => task.id), [repair.id]);
    assert.equal(repairOnly.json<Json>().data.tasks[0].subjectName, String(shops[0].name));
    assert.equal(dueSoon.json<Json>().data.tasks[0].subjectName, String(stations[0].name));

    const platformWithoutRecipient = await app.inject({
      method: "GET",
      url: "/api/admin/workflow/tasks?status=open&role=platform",
    });
    assert.equal(platformWithoutRecipient.statusCode, 200, platformWithoutRecipient.body);
    assert.deepEqual(platformWithoutRecipient.json<Json>().data.tasks.map((task: Json) => task.id), [platform.id]);
    assert.equal(platformWithoutRecipient.json<Json>().data.tasks[0].subjectName, "平台值班组（联系人未配置）");

    const recipient = await app.inject({
      method: "POST",
      url: "/api/admin/workflow/recipients",
      payload: {
        recipientType: "platform_duty",
        contactName: "测试值班员",
        phone: "13800138123",
        isEnabled: true,
      },
    });
    assert.equal(recipient.statusCode, 200, recipient.body);
    const platformWithRecipient = await app.inject({
      method: "GET",
      url: "/api/admin/workflow/tasks?status=open&role=platform",
    });
    assert.equal(platformWithRecipient.statusCode, 200, platformWithRecipient.body);
    assert.equal(platformWithRecipient.json<Json>().data.tasks[0].subjectName, "平台值班组");

    const closed = await app.inject({ method: "GET", url: "/api/admin/workflow/tasks?status=closed" });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.deepEqual(
      new Set(closed.json<Json>().data.tasks.map((task: Json) => task.status)),
      new Set(closedStatuses),
    );
    const invalid = await app.inject({ method: "GET", url: "/api/admin/workflow/tasks?urgency=urgent" });
    assert.equal(invalid.statusCode, 400, invalid.body);

    const template = await database.prepare<Row>(`
      SELECT id, stable_code, version FROM notification_templates
      WHERE channel = 'sms' AND state = 'published' ORDER BY id LIMIT 1
    `).get();
    assert.ok(template);
    const timestamp = new Date().toISOString();
    await database.prepare(`
      INSERT INTO notification_outbox (
        id, task_id, channel, status, template_id, template_code, template_version,
        rendered_title, rendered_body, action_code, action_params_json,
        recipient_address_encrypted, recipient_address_masked, recipient_address_hash,
        fallback_channels_json, dedupe_key, attempt_count, available_at,
        provider_message_id, provider_state, accepted_at, created_at, updated_at
      ) VALUES (?, ?, 'sms', 'accepted', ?, ?, ?, '', ?, 'annual.order.detail', '{}',
        ?, '138****0000', ?, '[]', ?, 1, ?, ?, 'accepted', ?, ?, ?)
    `).run(
      "workflow-detail-outbox", annual.id, String(template.id), String(template.stable_code), Number(template.version),
      "private rendered body", "v1.secret-ciphertext", "private-recipient-hash", "workflow-detail-dedupe",
      timestamp, "private-provider-message-id", timestamp, timestamp, timestamp,
    );
    await database.prepare(`
      INSERT INTO notification_delivery_attempts (
        id, outbox_id, channel, attempt_number, outcome, provider_code,
        provider_message_id, error_class, recipient_address_hash, started_at, completed_at
      ) VALUES (?, ?, 'sms', 1, 'accepted', '0', ?, NULL, ?, ?, ?)
    `).run(
      "workflow-detail-attempt", "workflow-detail-outbox", "private-provider-message-id",
      "private-recipient-hash", timestamp, timestamp,
    );
    await database.prepare(`
      INSERT INTO workflow_task_events (
        id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
      ) VALUES (?, ?, 'manual_reminder', 'platform', 'private-actor-id', 'open', 'open', ?, ?)
    `).run("workflow-detail-event", annual.id, JSON.stringify({ occurrence: 2, phone: "13800000000" }), timestamp);

    const detail = await app.inject({ method: "GET", url: `/api/admin/workflow/tasks/${annual.id}` });
    assert.equal(detail.statusCode, 200, detail.body);
    const payload = detail.json<Json>().data;
    assert.equal(payload.task.id, annual.id);
    assert.equal(payload.task.deliveryState, "服务商已受理（非最终送达）");
    assert.ok(payload.task.events.some((event: Json) => event.type === "manual_reminder" && event.detail === "第 2 次提醒"));
    assert.equal(payload.outbox[0].recipientAddressMasked, "138****0000");
    assert.equal(payload.deliverySummary.attempts.accepted, 1);
    for (const secret of ["private rendered body", "secret-ciphertext", "private-recipient-hash", "private-provider-message-id", "13800000000", "private-actor-id"]) {
      assert.equal(detail.body.includes(secret), false, `detail response leaked ${secret}`);
    }
  } finally {
    await close();
  }
});

test("检测站、维修店和司机工作台将已升级待办计入已超时，平台仍单列升级", async () => {
  const previousDirectPassword = process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD;
  process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD = "true";
  const { app, database, close } = await workflowFixture();
  try {
    const station = await database.prepare<Row>("SELECT id FROM stations ORDER BY id LIMIT 1").get();
    const shop = await database.prepare<Row>("SELECT id FROM repair_shops WHERE is_active = 1 ORDER BY id LIMIT 1").get();
    const booking = await database.prepare<Row>(`
      SELECT b.id FROM bookings b
      LEFT JOIN valet_driver_assignments a ON a.booking_id = b.id
      WHERE a.id IS NULL
      ORDER BY b.created_at DESC
      LIMIT 1
    `).get();
    const driverUser = await database.prepare<Row>("SELECT id FROM users ORDER BY id LIMIT 1").get();
    assert.ok(station?.id);
    assert.ok(shop?.id);
    assert.ok(booking?.id);
    assert.ok(driverUser?.id);

    const current = Date.now();
    const overdueAt = new Date(current - 10 * 60_000);
    const escalatedAt = new Date(current - 5 * 60_000);
    const stationTask = await createTask(database, {
      domain: "annual_inspection",
      entityId: "workflow-summary-station-escalated",
      nodeCode: "annual.precheck.pending",
      subjectType: "inspection_station",
      subjectId: String(station.id),
      assigneeRole: "station",
      dueAt: overdueAt,
      escalateAt: escalatedAt,
    });
    const repairTask = await createTask(database, {
      domain: "repair_quote",
      entityId: "workflow-summary-repair-escalated",
      nodeCode: "repair.quote.first",
      subjectType: "repair_shop",
      subjectId: String(shop.id),
      assigneeRole: "repair_shop",
      dueAt: overdueAt,
      escalateAt: escalatedAt,
    });
    const driverTask = await createTask(database, {
      domain: "annual_inspection",
      entityId: String(booking.id),
      nodeCode: "annual.pickup.driver",
      subjectType: "driver_assignment",
      subjectId: "workflow-summary-driver-assignment",
      assigneeRole: "driver",
      dueAt: overdueAt,
      escalateAt: escalatedAt,
    });

    const stationPassword = "workflow summary station password";
    const stationAccount = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      payload: {
        loginName: "station.workflow.summary",
        displayName: "汇总测试站长",
        password: stationPassword,
        role: "inspection_station_admin",
        subject: { type: "inspection_station", id: String(station.id) },
      },
    });
    assert.equal(stationAccount.statusCode, 201, stationAccount.body);
    const stationLogin = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: { loginName: "station.workflow.summary", password: stationPassword },
    });
    assert.equal(stationLogin.statusCode, 200, stationLogin.body);
    const stationHeaders = { authorization: `Bearer ${stationLogin.json<Json>().data.token}` };

    const repairPassword = "workflow summary repair password";
    const repairAccount = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      payload: {
        loginName: "repair.workflow.summary",
        displayName: "汇总测试维修店",
        password: repairPassword,
        role: "repair_shop_admin",
        subject: { type: "repair_shop", id: String(shop.id) },
      },
    });
    assert.equal(repairAccount.statusCode, 201, repairAccount.body);
    const repairLogin = await app.inject({
      method: "POST",
      url: "/api/repair-operator/sessions",
      payload: { loginName: "repair.workflow.summary", password: repairPassword },
    });
    assert.equal(repairLogin.statusCode, 200, repairLogin.body);
    const repairHeaders = { authorization: `Bearer ${repairLogin.json<Json>().data.token}` };

    const assignmentId = "workflow-summary-driver-assignment";
    const driverToken = `yxm_drv_${randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date().toISOString();
    await database.prepare(`
      INSERT INTO valet_driver_assignments (
        id, booking_id, driver_name, driver_phone, status, bound_user_id,
        assigned_at, bound_at, updated_at
      ) VALUES (?, ?, '汇总测试司机', '13800138000', 'bound', ?, ?, ?, ?)
    `).run(assignmentId, String(booking.id), String(driverUser.id), timestamp, timestamp, timestamp);
    await database.prepare(`
      INSERT INTO valet_driver_sessions (
        id, assignment_id, user_id, token_hash, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), assignmentId, String(driverUser.id),
      createHash("sha256").update(driverToken).digest("hex"),
      new Date(current + 60 * 60_000).toISOString(), timestamp,
    );
    const driverHeaders = { authorization: `Bearer ${driverToken}` };

    const [stationSummary, repairSummary, driverSummary, platformSummary] = await Promise.all([
      app.inject({ method: "GET", url: "/api/operator/workflow/tasks", headers: stationHeaders }),
      app.inject({ method: "GET", url: "/api/repair-operator/workflow/tasks", headers: repairHeaders }),
      app.inject({ method: "GET", url: `/api/driver/tasks/${booking.id}/workflow`, headers: driverHeaders }),
      app.inject({ method: "GET", url: "/api/admin/workflow/summary" }),
    ]);
    assert.equal(stationSummary.statusCode, 200, stationSummary.body);
    assert.equal(repairSummary.statusCode, 200, repairSummary.body);
    assert.equal(driverSummary.statusCode, 200, driverSummary.body);
    assert.equal(platformSummary.statusCode, 200, platformSummary.body);

    for (const [response, taskId] of [
      [stationSummary, stationTask.id],
      [repairSummary, repairTask.id],
      [driverSummary, driverTask.id],
    ] as const) {
      assert.equal(response.json<Json>().data.summary.pending, 1);
      assert.equal(response.json<Json>().data.summary.dueSoon, 0);
      assert.equal(response.json<Json>().data.summary.overdue, 1);
      assert.equal(response.json<Json>().data.summary.escalated, 1);
      assert.deepEqual(response.json<Json>().data.tasks.map((task: Json) => task.id), [taskId]);
      assert.equal(response.json<Json>().data.tasks[0].urgency, "escalated");
    }

    assert.equal(platformSummary.json<Json>().data.pending, 3);
    assert.equal(platformSummary.json<Json>().data.overdue, 0);
    assert.equal(platformSummary.json<Json>().data.escalated, 3);
  } finally {
    process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD = previousDirectPassword;
    await close();
  }
});

test("检测站管理员只能读取本主体的任务详情", async () => {
  const previousDirectPassword = process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD;
  process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD = "true";
  const { app, database, close } = await workflowFixture();
  try {
    const stations = await database.prepare<Row>("SELECT id FROM stations ORDER BY id LIMIT 2").all();
    assert.ok(stations.length >= 2);
    const ownTask = await createTask(database, {
      domain: "annual_inspection",
      entityId: "workflow-provider-own",
      nodeCode: "annual.precheck.pending",
      subjectType: "inspection_station",
      subjectId: String(stations[0].id),
      assigneeRole: "station",
    });
    const otherTask = await createTask(database, {
      domain: "annual_inspection",
      entityId: "workflow-provider-other",
      nodeCode: "annual.precheck.pending",
      subjectType: "inspection_station",
      subjectId: String(stations[1].id),
      assigneeRole: "station",
    });
    const password = "workflow station password";
    const account = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      payload: {
        loginName: "station.workflow.api",
        displayName: "督办测试站长",
        password,
        role: "inspection_station_admin",
        subject: { type: "inspection_station", id: String(stations[0].id) },
      },
    });
    assert.equal(account.statusCode, 201, account.body);
    const login = await app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      payload: { loginName: "station.workflow.api", password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0] };

    const own = await app.inject({ method: "GET", url: `/api/admin/workflow/tasks/${ownTask.id}`, headers });
    assert.equal(own.statusCode, 200, own.body);
    const hidden = await app.inject({ method: "GET", url: `/api/admin/workflow/tasks/${otherTask.id}`, headers });
    assert.equal(hidden.statusCode, 404, hidden.body);
    const list = await app.inject({ method: "GET", url: "/api/admin/workflow/tasks?status=open", headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json<Json>().data.tasks.map((task: Json) => task.id), [ownTask.id]);

    const operatorLogin = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: { loginName: "station.workflow.api", password },
    });
    assert.equal(operatorLogin.statusCode, 200, operatorLogin.body);
    const operatorHeaders = { authorization: `Bearer ${operatorLogin.json<Json>().data.token}` };
    const operatorList = await app.inject({
      method: "GET",
      url: "/api/operator/workflow/tasks?limit=100",
      headers: operatorHeaders,
    });
    assert.equal(operatorList.statusCode, 200, operatorList.body);
    assert.deepEqual(operatorList.json<Json>().data.tasks.map((task: Json) => task.id), [ownTask.id]);
    const operatorSummary = await app.inject({
      method: "GET",
      url: "/api/operator/workflow/tasks/summary",
      headers: operatorHeaders,
    });
    assert.equal(operatorSummary.statusCode, 200, operatorSummary.body);
    assert.equal(operatorSummary.json<Json>().data.pending, 1);
  } finally {
    process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD = previousDirectPassword;
    await close();
  }
});

test("发布记录接口返回默认发布历史、正确业务分类和具体资源名称", async () => {
  const { app, close } = await workflowFixture();
  try {
    const response = await app.inject({ method: "GET", url: "/api/admin/workflow/releases?limit=100" });
    assert.equal(response.statusCode, 200, response.body);
    const items = response.json<Json>().data.items as Json[];
    assert.equal(items.length, 59);

    const annualPolicy = items.find((item) => item.resourceId === "annual-workflow-v1");
    assert.ok(annualPolicy);
    assert.equal(annualPolicy.name, "年检履约督办默认策略");
    assert.equal(annualPolicy.code, "annual-workflow");
    assert.equal(annualPolicy.domain, "annual_inspection");

    const repairTemplate = items.find((item) => (
      item.resourceId === "workflow-template-repair-quote-first-owner-in_app-v1"
    ));
    assert.ok(repairTemplate);
    assert.equal(repairTemplate.name, "车主收到首份报价");
    assert.equal(repairTemplate.code, "repair.quote.first.owner");
    assert.equal(repairTemplate.channel, "in_app");
    assert.equal(repairTemplate.domain, "repair_quote");

    const sharedTemplate = items.find((item) => (
      item.resourceId === "workflow-template-workflow-exception-platform-sms-v1"
    ));
    assert.ok(sharedTemplate);
    assert.equal(sharedTemplate.name, "平台履约异常");
    assert.equal(sharedTemplate.domain, null);
  } finally {
    await close();
  }
});
