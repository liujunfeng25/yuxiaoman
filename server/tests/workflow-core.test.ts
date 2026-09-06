import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  addWorkflowMinutes,
  applyWorkflowTransition,
  enableWorkflowForEntity,
  estimateSmsSegments,
  getWorkflowPolicies,
  publishWorkflowPolicy,
  publishWorkflowTemplate,
  registerWorkflowRoutes,
  renderWorkflowTemplate,
  saveWorkflowPolicyDraft,
  saveWorkflowTemplateDraft,
  validateWorkflowPolicy,
  workflowExternalAvailableAt,
  workflowIntegrationStatus,
} from "../workflow.js";
import { runWorkflowWorkerOnce } from "../workflow-worker.js";
import { seedDefaultWorkflowConfiguration, workflowSeedSummary } from "../workflow-db.js";
import { createTestDatabase } from "./test-database.js";

test("默认督办策略与模板以不可变发布版本初始化", async () => {
  const database = await createTestDatabase("workflow_seed");
  try {
    const summary = await workflowSeedSummary(database);
    assert.equal(summary.policies, 2);
    assert.ok(summary.nodes >= 18);
    assert.equal(summary.templates, 57);
    const policies = await getWorkflowPolicies(database, "annual_inspection");
    assert.equal(policies.current?.id, "annual-workflow-v1");
    assert.equal(policies.current?.version, 1);
    assert.equal(policies.draft, null);
    const pickupNode = policies.current?.nodes.find((node) => node.nodeCode === "annual.pickup.driver");
    assert.equal(pickupNode?.name, "司机完成取车留证");
    assert.equal(pickupNode?.templateBindings.in_app,
      "workflow-template-annual-pickup-evidence-driver-in_app-v1");
    const pickupTemplate = await database.prepare<Record<string, unknown>>(`
      SELECT title, body, action_code, allowed_variables_json
      FROM notification_templates
      WHERE stable_code = 'annual.pickup.evidence.driver' AND channel = 'in_app' AND is_current = 1
    `).get();
    assert.equal(pickupTemplate?.action_code, "driver.task.detail");
    assert.match(String(pickupTemplate?.body), /5 张取车照片/u);
    assert.doesNotMatch(String(pickupTemplate?.body), /验证码/u);
    assert.doesNotMatch(String(pickupTemplate?.allowed_variables_json), /verificationCode/u);
    const expectedSemanticBindings = new Map([
      ["annual.pending_payment", "annual.payment.pending.owner"],
      ["annual.driver.assign", "annual.driver.assignment.platform"],
      ["annual.pickup.owner", "annual.pickup.reminder.owner"],
      ["annual.return.delivery", "annual.return.delivery.driver"],
    ]);
    for (const [nodeCode, templateCode] of expectedSemanticBindings) {
      const node = policies.current?.nodes.find((candidate) => candidate.nodeCode === nodeCode);
      assert.match(String(node?.templateBindings.in_app), new RegExp(templateCode.replaceAll(".", "-"), "u"));
    }
    const reportReminder = await database.prepare<Record<string, unknown>>(`
      SELECT name, body, allowed_variables_json FROM notification_templates
      WHERE stable_code = 'annual.inspection.overdue' AND channel = 'in_app' AND is_current = 1
    `).get();
    assert.equal(reportReminder?.name, "检测与报告发布提醒");
    assert.doesNotMatch(String(reportReminder?.body), /已超时/u);
    assert.doesNotMatch(String(reportReminder?.allowed_variables_json), /overdueCount/u);
    const validation = await validateWorkflowPolicy(database, "annual-workflow-v1");
    assert.equal(validation.valid, true);
    assert.ok(validation.issues.some((issue) => issue.code === "SMS_RECIPIENTS_MISSING"));

    const releases = await database.prepare<Record<string, unknown>>(`
      SELECT resource_type, resource_id, domain, version, action, summary_json
      FROM workflow_release_events
      ORDER BY resource_type, resource_id
    `).all();
    assert.equal(releases.length, 59);
    assert.equal(new Set(releases.map((release) => `${release.resource_type}:${release.resource_id}:${release.version}`)).size, 59);
    assert.ok(releases.every((release) => release.action === "published" && Number(release.version) === 1));
    assert.equal(releases.filter((release) => release.resource_type === "workflow_policy").length, 2);
    assert.equal(releases.filter((release) => release.resource_type === "notification_template" && release.domain === "annual_inspection").length, 45);
    assert.equal(releases.filter((release) => release.resource_type === "notification_template" && release.domain === "repair_quote").length, 9);
    assert.equal(releases.filter((release) => release.resource_type === "notification_template" && release.domain == null).length, 3);
    assert.ok(releases.every((release) => {
      const summary = JSON.parse(String(release.summary_json)) as Record<string, unknown>;
      return typeof summary.resourceName === "string" && summary.resourceName.length > 0;
    }));

    await seedDefaultWorkflowConfiguration(database, { now: new Date("2026-09-05T08:30:00.000Z") });
    await seedDefaultWorkflowConfiguration(database, { now: new Date("2026-09-05T08:31:00.000Z") });
    const afterRepeatedSeed = await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_release_events
    `).get();
    assert.equal(Number(afterRepeatedSeed?.count), 59);
  } finally {
    await database.close();
  }
});

test("既有年检策略以新发布版本补充司机取车督办且不回填历史订单", async () => {
  const database = await createTestDatabase("workflow_pickup_policy_migration");
  try {
    const historicalBinding = await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "historical-valet-booking",
      ownerUserId: "historical-owner",
      createdAt: new Date("2026-09-05T00:00:00.000Z"),
    });
    assert.equal(historicalBinding?.policySetId, "annual-workflow-v1");
    await database.prepare(`
      DELETE FROM workflow_policy_nodes
      WHERE policy_set_id = 'annual-workflow-v1' AND node_code = 'annual.pickup.driver'
    `).run();

    await seedDefaultWorkflowConfiguration(database, { now: new Date("2026-09-05T00:10:00.000Z") });

    const policies = await getWorkflowPolicies(database, "annual_inspection");
    assert.equal(policies.current?.version, 2);
    assert.notEqual(policies.current?.id, "annual-workflow-v1");
    assert.equal(policies.current?.sourcePolicySetId, "annual-workflow-v1");
    const historicalPolicy = await database.prepare<Record<string, unknown>>(`
      SELECT state, is_current FROM workflow_policy_sets WHERE id = 'annual-workflow-v1'
    `).get();
    assert.equal(historicalPolicy?.state, "published");
    assert.equal(Number(historicalPolicy?.is_current), 0);
    assert.equal(Number((await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_policy_nodes
      WHERE policy_set_id = 'annual-workflow-v1' AND node_code = 'annual.pickup.driver'
    `).get())?.count), 0, "历史已发布版本不得被原地补写");
    assert.equal(Number((await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_policy_nodes
      WHERE policy_set_id = ? AND node_code = 'annual.pickup.driver'
    `).get(String(policies.current?.id)))?.count), 1);
    assert.equal((await validateWorkflowPolicy(database, String(policies.current?.id))).valid, true);

    const frozenHistoricalBinding = await database.prepare<Record<string, unknown>>(`
      SELECT policy_set_id, policy_version FROM workflow_entity_bindings
      WHERE domain = 'annual_inspection' AND entity_id = 'historical-valet-booking'
    `).get();
    assert.equal(frozenHistoricalBinding?.policy_set_id, "annual-workflow-v1");
    assert.equal(Number(frozenHistoricalBinding?.policy_version), 1);
    assert.equal(Number((await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_tasks WHERE entity_id = 'historical-valet-booking'
    `).get())?.count), 0, "升级不能给历史订单补造任务");

    const newBinding = await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "new-valet-booking",
      ownerUserId: "new-owner",
      createdAt: new Date("2026-09-05T00:11:00.000Z"),
    });
    assert.equal(newBinding?.policySetId, policies.current?.id);
    const transition = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "new-valet-booking",
      open: [{
        nodeCode: "annual.pickup.driver",
        subjectType: "driver_assignment",
        subjectId: "new-driver-assignment",
        assigneeRole: "driver",
        recipientUserId: "new-driver",
      }],
      actorType: "driver",
      actorId: "new-driver",
    }, { now: new Date("2026-09-05T00:12:00.000Z") });
    assert.equal(transition.opened[0]?.nodeCode, "annual.pickup.driver");
    assert.equal(transition.opened[0]?.policy.version, 2);
    assert.equal(transition.opened[0]?.dueAt, "2026-09-05T01:12:00.000Z");
    const pickupTask = await database.prepare<Record<string, unknown>>(`
      SELECT template_bindings_snapshot_json FROM workflow_tasks
      WHERE entity_id = 'new-valet-booking' AND node_code = 'annual.pickup.driver'
    `).get();
    const templateSnapshot = String(pickupTask?.template_bindings_snapshot_json ?? "");
    assert.match(templateSnapshot, /annual\.pickup\.evidence\.driver/u);
    assert.doesNotMatch(templateSnapshot, /verificationCode/u);
  } finally {
    await database.close();
  }
});

test("热更新误写旧版取车节点时恢复历史 v1 并发布修正版", async () => {
  const database = await createTestDatabase("workflow_pickup_hot_reload_recovery");
  try {
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "hot-reload-historical-booking",
      ownerUserId: "historical-owner",
      createdAt: new Date("2026-08-30T00:00:00.000Z"),
    });
    await database.prepare(`
      UPDATE workflow_policy_sets
      SET created_at = '2026-08-30T00:00:00.000Z', updated_at = '2026-08-30T00:00:00.000Z',
        published_at = '2026-08-30T00:00:00.000Z'
      WHERE id = 'annual-workflow-v1'
    `).run();

    await seedDefaultWorkflowConfiguration(database, { now: new Date("2026-09-05T00:10:00.000Z") });

    const current = (await getWorkflowPolicies(database, "annual_inspection")).current;
    assert.equal(current?.version, 2);
    assert.equal(current?.sourcePolicySetId, "annual-workflow-v1");
    assert.equal(current?.nodes.filter((node) => node.nodeCode === "annual.pickup.driver").length, 1);
    assert.equal(Number((await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_policy_nodes
      WHERE policy_set_id = 'annual-workflow-v1' AND node_code = 'annual.pickup.driver'
    `).get())?.count), 0, "误写到历史发布版本的节点应被恢复");
    const frozen = await database.prepare<Record<string, unknown>>(`
      SELECT policy_set_id FROM workflow_entity_bindings
      WHERE entity_id = 'hot-reload-historical-booking'
    `).get();
    assert.equal(frozen?.policy_set_id, "annual-workflow-v1");
    assert.equal(Number((await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_tasks WHERE entity_id = 'hot-reload-historical-booking'
    `).get())?.count), 0);
    const release = await database.prepare<Record<string, unknown>>(`
      SELECT summary_json FROM workflow_release_events
      WHERE resource_id = ? AND action = 'published'
    `).get(String(current?.id));
    assert.equal(JSON.parse(String(release?.summary_json)).restoredLegacyVersion, true);
  } finally {
    await database.close();
  }
});

test("旧版错配通知通过新策略和模板版本修正且历史任务快照不变", async () => {
  const database = await createTestDatabase("workflow_semantic_migration");
  try {
    const legacyBindings = new Map([
      ["annual.pending_payment", "annual.precheck.action_required.owner"],
      ["annual.driver.assign", "workflow.exception.platform"],
      ["annual.pickup.owner", "annual.arrival.reminder.owner"],
      ["annual.return.delivery", "annual.return.required.driver"],
    ]);
    for (const [nodeCode, templateCode] of legacyBindings) {
      const prefix = `workflow-template-${templateCode.replaceAll(".", "-")}`;
      await database.prepare(`
        UPDATE workflow_policy_nodes SET template_bindings_json = ?
        WHERE policy_set_id = 'annual-workflow-v1' AND node_code = ?
      `).run(JSON.stringify({
        in_app: `${prefix}-in_app-v1`,
        sms: `${prefix}-sms-v1`,
        wechat: `${prefix}-wechat-v1`,
      }), nodeCode);
    }
    for (const channel of ["in_app", "sms", "wechat"]) {
      await database.prepare(`
        UPDATE notification_templates
        SET name = '检测与报告超时',
          body = ?, allowed_variables_json = ?
        WHERE stable_code = 'annual.inspection.overdue' AND channel = ?
          AND state = 'published' AND is_current = 1
      `).run(
        `${channel === "sms" ? "【驭小满】" : ""}当前有 {{pendingCount}} 笔检测报告待发布，其中 {{overdueCount}} 笔已超时，请及时处理。`,
        JSON.stringify(["pendingCount", "overdueCount", "stationName", "remainingTime", "maskedBusinessCode"]),
        channel,
      );
    }

    const historical = await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "semantic-historical-booking",
      ownerUserId: "semantic-historical-owner",
      createdAt: new Date("2026-09-05T00:00:00.000Z"),
    });
    assert.equal(historical?.policySetId, "annual-workflow-v1");
    await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "semantic-historical-booking",
      open: [
        { nodeCode: "annual.pending_payment", recipientUserId: "semantic-historical-owner" },
        { nodeCode: "annual.inspection.report", subjectType: "inspection_station", subjectId: "station-old", assigneeRole: "station" },
      ],
    }, { now: new Date("2026-09-05T00:01:00.000Z") });
    const historicalSnapshotsBefore = await database.prepare<Record<string, unknown>>(`
      SELECT node_code, template_bindings_snapshot_json FROM workflow_tasks
      WHERE entity_id = 'semantic-historical-booking' ORDER BY node_code
    `).all();

    await seedDefaultWorkflowConfiguration(database, { now: new Date("2026-09-05T00:10:00.000Z") });

    const policies = await getWorkflowPolicies(database, "annual_inspection");
    assert.equal(policies.current?.version, 2);
    assert.equal(policies.current?.sourcePolicySetId, "annual-workflow-v1");
    assert.match(String(policies.current?.id), /notification-semantics/u);
    const frozenBinding = await database.prepare<Record<string, unknown>>(`
      SELECT policy_set_id, policy_version FROM workflow_entity_bindings
      WHERE entity_id = 'semantic-historical-booking'
    `).get();
    assert.equal(frozenBinding?.policy_set_id, "annual-workflow-v1");
    assert.equal(Number(frozenBinding?.policy_version), 1);
    const historicalSnapshotsAfter = await database.prepare<Record<string, unknown>>(`
      SELECT node_code, template_bindings_snapshot_json FROM workflow_tasks
      WHERE entity_id = 'semantic-historical-booking' ORDER BY node_code
    `).all();
    assert.deepEqual(historicalSnapshotsAfter, historicalSnapshotsBefore);
    assert.match(String(historicalSnapshotsAfter.find((row) => row.node_code === "annual.pending_payment")?.template_bindings_snapshot_json), /annual\.precheck\.action_required\.owner/u);
    assert.match(String(historicalSnapshotsAfter.find((row) => row.node_code === "annual.inspection.report")?.template_bindings_snapshot_json), /已超时/u);

    const expectedBindings = new Map([
      ["annual.pending_payment", "annual.payment.pending.owner"],
      ["annual.driver.assign", "annual.driver.assignment.platform"],
      ["annual.pickup.owner", "annual.pickup.reminder.owner"],
      ["annual.return.delivery", "annual.return.delivery.driver"],
    ]);
    for (const [nodeCode, templateCode] of expectedBindings) {
      const oldNode = await database.prepare<Record<string, unknown>>(`
        SELECT trigger_state, next_state, assignee_role, subject_scope, closure_action,
          task_kind, timer_mode, first_reminder_minutes, deadline_minutes, escalation_minutes
        FROM workflow_policy_nodes WHERE policy_set_id = 'annual-workflow-v1' AND node_code = ?
      `).get(nodeCode);
      const newNode = await database.prepare<Record<string, unknown>>(`
        SELECT trigger_state, next_state, assignee_role, subject_scope, closure_action,
          task_kind, timer_mode, first_reminder_minutes, deadline_minutes, escalation_minutes,
          template_bindings_json
        FROM workflow_policy_nodes WHERE policy_set_id = ? AND node_code = ?
      `).get(String(policies.current?.id), nodeCode);
      const { template_bindings_json: templateBindings, ...newImmutableFields } = newNode ?? {};
      assert.deepEqual(newImmutableFields, oldNode, `${nodeCode} 的状态、责任和时限不能在通知迁移中改变`);
      assert.match(String(templateBindings), new RegExp(templateCode.replaceAll(".", "-"), "u"));
    }

    const currentReportTemplates = await database.prepare<Record<string, unknown>>(`
      SELECT channel, version, is_current, name, body, allowed_variables_json
      FROM notification_templates
      WHERE stable_code = 'annual.inspection.overdue' AND state = 'published'
      ORDER BY channel, version
    `).all();
    assert.equal(currentReportTemplates.length, 6);
    assert.ok(currentReportTemplates.filter((row) => Number(row.version) === 1)
      .every((row) => Number(row.is_current) === 0 && String(row.body).includes("已超时")));
    assert.ok(currentReportTemplates.filter((row) => Number(row.version) === 2)
      .every((row) => Number(row.is_current) === 1
        && row.name === "检测与报告发布提醒"
        && !String(row.body).includes("已超时")
        && !String(row.allowed_variables_json).includes("overdueCount")));

    const newBinding = await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "semantic-new-booking",
      ownerUserId: "semantic-new-owner",
      createdAt: new Date("2026-09-05T00:11:00.000Z"),
    });
    assert.equal(newBinding?.policySetId, policies.current?.id);
    await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "semantic-new-booking",
      open: [
        { nodeCode: "annual.pending_payment", recipientUserId: "semantic-new-owner" },
        { nodeCode: "annual.driver.assign", subjectType: "platform_duty", subjectId: "semantic-new-booking", assigneeRole: "platform" },
        { nodeCode: "annual.pickup.owner", recipientUserId: "semantic-new-owner" },
        { nodeCode: "annual.return.delivery", subjectType: "driver_assignment", subjectId: "driver-new", assigneeRole: "driver" },
        { nodeCode: "annual.inspection.report", subjectType: "inspection_station", subjectId: "station-new", assigneeRole: "station" },
      ],
    }, { now: new Date("2026-09-05T00:12:00.000Z") });
    const snapshots = await database.prepare<Record<string, unknown>>(`
      SELECT node_code, template_bindings_snapshot_json FROM workflow_tasks
      WHERE entity_id = 'semantic-new-booking' ORDER BY node_code
    `).all();
    for (const [nodeCode, templateCode] of expectedBindings) {
      assert.match(String(snapshots.find((row) => row.node_code === nodeCode)?.template_bindings_snapshot_json), new RegExp(templateCode.replaceAll(".", "\\."), "u"));
    }
    const reportSnapshot = String(snapshots.find((row) => row.node_code === "annual.inspection.report")?.template_bindings_snapshot_json);
    assert.match(reportSnapshot, /"version":2/u);
    assert.doesNotMatch(reportSnapshot, /已超时/u);

    await seedDefaultWorkflowConfiguration(database, { now: new Date("2026-09-05T00:20:00.000Z") });
    assert.equal((await getWorkflowPolicies(database, "annual_inspection")).current?.id, policies.current?.id);
    assert.equal(Number((await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_policy_sets
      WHERE domain = 'annual_inspection' AND state = 'published'
    `).get())?.count), 2);
  } finally {
    await database.close();
  }
});

test("模板新版本发布记录归入对应业务并冻结具体模板名称", async () => {
  const database = await createTestDatabase("workflow_template_release_domain");
  try {
    const saved = await saveWorkflowTemplateDraft(database, {
      stableCode: "repair.quote.first.owner",
      channel: "in_app",
      expectedRevision: 0,
      name: "车主收到维修报价提醒（运营新版）",
      title: "维修报价已更新",
      body: "{{maskedPlate}} 已收到维修报价，请进入需求详情查看。",
      buttonText: "查看报价",
      actionCode: "repair.request.detail",
      allowedVariables: ["maskedPlate", "maskedBusinessCode"],
      exampleData: { maskedPlate: "津A·8***8", maskedBusinessCode: "YXM-***-0001" },
      providerTemplateId: null,
      providerSnapshot: {},
      filingStatus: "not_required",
    }, { actor: "release-test", now: new Date("2026-09-05T09:00:00.000Z") });
    const draft = saved.template as { revision: number };
    const published = await publishWorkflowTemplate(database, {
      stableCode: "repair.quote.first.owner",
      channel: "in_app",
      expectedRevision: draft.revision,
    }, { actor: "release-test", now: new Date("2026-09-05T09:01:00.000Z") });
    const release = await database.prepare<Record<string, unknown>>(`
      SELECT domain, version, summary_json FROM workflow_release_events
      WHERE resource_type = 'notification_template' AND resource_id = ?
    `).get(published.template.id);
    assert.equal(release?.domain, "repair_quote");
    assert.equal(Number(release?.version), 2);
    const summary = JSON.parse(String(release?.summary_json)) as Record<string, unknown>;
    assert.equal(summary.stableCode, "repair.quote.first.owner");
    assert.equal(summary.channel, "in_app");
    assert.equal(summary.resourceName, "车主收到维修报价提醒（运营新版）");
  } finally {
    await database.close();
  }
});

test("旧版不安全默认值通过新发布版本迁移且不篡改历史节点", async () => {
  const database = await createTestDatabase("workflow_legacy_migration");
  try {
    const legacyNodeId = "annual-workflow-v1:annual.arrival.owner";
    await database.prepare(`
      UPDATE workflow_policy_nodes
      SET first_reminder_minutes = NULL, deadline_minutes = NULL, escalation_minutes = NULL,
        enabled_channels_json = '["in_app"]', fallback_order_json = '["wechat","sms"]'
      WHERE id = ?
    `).run(legacyNodeId);
    await database.prepare(`
      UPDATE notification_templates
      SET node_code = 'annual.inspection.report'
      WHERE stable_code = 'annual.report.ready.owner'
        AND state = 'published' AND is_current = 1
    `).run();
    const legacyBefore = await database.prepare<Record<string, unknown>>(`
      SELECT first_reminder_minutes, deadline_minutes, escalation_minutes,
        enabled_channels_json, fallback_order_json
      FROM workflow_policy_nodes WHERE id = ?
    `).get(legacyNodeId);

    await seedDefaultWorkflowConfiguration(database, {
      now: new Date("2026-09-05T06:00:00.000Z"),
    });
    await seedDefaultWorkflowConfiguration(database, {
      now: new Date("2026-09-05T06:01:00.000Z"),
    });

    const policyRows = await database.prepare<Record<string, unknown>>(`
      SELECT id, version, is_current, source_policy_set_id
      FROM workflow_policy_sets WHERE domain = 'annual_inspection' AND state = 'published'
      ORDER BY version
    `).all();
    assert.deepEqual(policyRows.map((row) => [row.id, Number(row.version), Number(row.is_current)]), [
      ["annual-workflow-v1", 1, 0],
      ["annual-workflow-v2-secure-defaults", 2, 1],
    ]);
    assert.equal(policyRows[1].source_policy_set_id, "annual-workflow-v1");

    const legacyAfter = await database.prepare<Record<string, unknown>>(`
      SELECT first_reminder_minutes, deadline_minutes, escalation_minutes,
        enabled_channels_json, fallback_order_json
      FROM workflow_policy_nodes WHERE id = ?
    `).get(legacyNodeId);
    assert.deepEqual(legacyAfter, legacyBefore);
    const upgraded = await database.prepare<Record<string, unknown>>(`
      SELECT first_reminder_minutes, deadline_minutes, escalation_minutes,
        enabled_channels_json, fallback_order_json
      FROM workflow_policy_nodes
      WHERE policy_set_id = 'annual-workflow-v2-secure-defaults'
        AND node_code = 'annual.arrival.owner'
    `).get();
    assert.equal(Number(upgraded?.first_reminder_minutes), 0);
    assert.equal(Number(upgraded?.deadline_minutes), 15);
    assert.equal(Number(upgraded?.escalation_minutes), 30);
    assert.equal(upgraded?.enabled_channels_json, '["in_app"]');
    assert.equal(upgraded?.fallback_order_json, '[]');
    const release = await database.prepare<Record<string, unknown>>(`
      SELECT MIN(action) AS action, MIN(version) AS version, COUNT(*) AS count FROM workflow_release_events
      WHERE resource_id = 'annual-workflow-v2-secure-defaults'
    `).get();
    assert.equal(release?.action, "published");
    assert.equal(Number(release?.version), 2);
    assert.equal(Number(release?.count), 1);
    const migratedTemplates = await database.prepare<Record<string, unknown>>(`
      SELECT channel, version, is_current, node_code
      FROM notification_templates
      WHERE stable_code = 'annual.report.ready.owner' AND state = 'published'
      ORDER BY channel, version
    `).all();
    assert.equal(migratedTemplates.length, 6);
    assert.ok(migratedTemplates
      .filter((row) => Number(row.version) === 1)
      .every((row) => Number(row.is_current) === 0 && row.node_code === 'annual.inspection.report'));
    assert.ok(migratedTemplates
      .filter((row) => Number(row.version) === 2)
      .every((row) => Number(row.is_current) === 1 && row.node_code === 'annual.report.ready'));
    // Published policy bindings still point at immutable v1 ids. Validation
    // must resolve their stable code/channel to v2 rather than forcing an
    // in-place rewrite of the historical policy.
    assert.equal((await validateWorkflowPolicy(database, "annual-workflow-v2-secure-defaults")).valid, true);
  } finally {
    await database.close();
  }
});

test("策略兜底渠道必须先显式启用", async () => {
  const database = await createTestDatabase("workflow_fallback_validation");
  try {
    const current = (await getWorkflowPolicies(database, "annual_inspection")).current!;
    const saved = await saveWorkflowPolicyDraft(database, {
      domain: "annual_inspection",
      expectedRevision: 0,
      name: "非法兜底测试",
      businessHours: current.businessHours,
      nodes: current.nodes.map((node) => ({
        nodeCode: node.nodeCode,
        isEnabled: node.isEnabled,
        timerMode: node.timerMode,
        firstReminderMinutes: node.firstReminderMinutes,
        deadlineMinutes: node.deadlineMinutes,
        escalationMinutes: node.escalationMinutes,
        maxReminders: node.maxReminders,
        reminderIntervalMinutes: node.reminderIntervalMinutes,
        enabledChannels: node.nodeCode === "annual.precheck.pending" ? ["in_app"] : node.enabledChannels,
        fallbackOrder: node.nodeCode === "annual.precheck.pending" ? ["sms"] : node.fallbackOrder,
        templateBindings: node.templateBindings,
        escalationLevel: node.escalationLevel,
        quietHours: node.quietHours,
      })),
    }, { actor: "test-admin", now: new Date("2026-09-05T02:00:00.000Z") });
    const validation = await validateWorkflowPolicy(database, saved!.id);
    assert.equal(validation.valid, false);
    assert.ok(validation.issues.some((issue) => issue.severity === "error"
      && issue.code === "FALLBACK_CHANNEL_NOT_ENABLED"
      && issue.nodeCode === "annual.precheck.pending"));
  } finally {
    await database.close();
  }
});

test("历史实体不补任务，显式绑定后的任务冻结策略与模板并原子产生站内消息", async () => {
  const database = await createTestDatabase("workflow_binding");
  try {
    const historical = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "historical-booking",
      open: [{ nodeCode: "annual.precheck.action_required", recipientUserId: "demo-user" }],
    }, { now: new Date("2026-09-05T01:00:00.000Z") });
    assert.deepEqual(historical, { closed: 0, opened: [] });

    const binding = await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "new-booking",
      ownerUserId: "demo-user",
      createdAt: "2026-09-05T01:00:00.000Z",
    });
    assert.equal(binding?.policyVersion, 1);
    const transition = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "new-booking",
      open: [{
        nodeCode: "annual.precheck.action_required",
        recipientUserId: "demo-user",
        metadata: { maskedPlate: "津A·8***8", maskedBusinessCode: "YXM-***-TEST" },
      }],
    }, { now: new Date("2026-09-05T01:00:00.000Z") });
    assert.equal(transition.opened.length, 1);
    assert.equal(transition.opened[0].policy.version, 1);
    const inbox = await database.prepare<Record<string, unknown>>("SELECT * FROM notification_inbox WHERE recipient_user_id = ?").all("demo-user");
    assert.equal(inbox.length, 1);
    const params = JSON.parse(String(inbox[0].action_params_json)) as Record<string, unknown>;
    assert.equal(params.resourceId, "new-booking");
    assert.equal(params.bookingId, "new-booking");
  } finally {
    await database.close();
  }
});

test("草稿 revision 防并发覆盖且保存不影响已发布策略", async () => {
  const database = await createTestDatabase("workflow_revision");
  try {
    const current = (await getWorkflowPolicies(database, "annual_inspection")).current!;
    const mutableNodes = current.nodes.map((node) => ({
      nodeCode: node.nodeCode,
      isEnabled: node.isEnabled,
      timerMode: node.timerMode,
      firstReminderMinutes: node.firstReminderMinutes,
      deadlineMinutes: node.deadlineMinutes,
      escalationMinutes: node.escalationMinutes,
      maxReminders: node.maxReminders,
      reminderIntervalMinutes: node.reminderIntervalMinutes,
      enabledChannels: node.enabledChannels,
      fallbackOrder: node.fallbackOrder,
      templateBindings: node.templateBindings,
      escalationLevel: node.escalationLevel,
      quietHours: node.quietHours,
    }));
    const saved = await saveWorkflowPolicyDraft(database, {
      domain: "annual_inspection",
      expectedRevision: 0,
      name: "年检督办测试草稿",
      businessHours: current.businessHours,
      nodes: mutableNodes,
    }, { actor: "test-admin", now: new Date("2026-09-05T02:00:00.000Z") });
    assert.equal(saved?.revision, 2);
    assert.equal((await getWorkflowPolicies(database, "annual_inspection")).current?.name, current.name);
    await assert.rejects(
      saveWorkflowPolicyDraft(database, {
        domain: "annual_inspection",
        expectedRevision: 1,
        name: "过期页面覆盖",
        businessHours: current.businessHours,
        nodes: mutableNodes,
      }, { actor: "test-admin" }),
      (error: unknown) => (error as { code?: string }).code === "WORKFLOW_POLICY_REVISION_CONFLICT",
    );
  } finally {
    await database.close();
  }
});

test("策略只在新任务创建时取当前版本且既有任务保持冻结", async () => {
  const database = await createTestDatabase("workflow_policy_freeze");
  try {
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "policy-freeze-booking",
      ownerUserId: "demo-user",
    });
    const first = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "policy-freeze-booking",
      open: [{ nodeCode: "annual.pending_payment", recipientUserId: "demo-user" }],
    }, { now: new Date("2026-09-05T01:00:00.000Z") });
    assert.equal(first.opened[0].policy.version, 1);

    const current = (await getWorkflowPolicies(database, "annual_inspection")).current!;
    const saved = await saveWorkflowPolicyDraft(database, {
      domain: "annual_inspection",
      expectedRevision: 0,
      name: "年检督办第二版",
      businessHours: current.businessHours,
      nodes: current.nodes.map((node) => ({
        nodeCode: node.nodeCode,
        isEnabled: node.isEnabled,
        timerMode: node.timerMode,
        firstReminderMinutes: node.nodeCode === "annual.precheck.pending" ? 31 : node.firstReminderMinutes,
        deadlineMinutes: node.nodeCode === "annual.precheck.pending" ? 180 : node.deadlineMinutes,
        escalationMinutes: node.nodeCode === "annual.precheck.pending" ? 180 : node.escalationMinutes,
        maxReminders: node.maxReminders,
        reminderIntervalMinutes: node.reminderIntervalMinutes,
        enabledChannels: node.enabledChannels,
        fallbackOrder: node.fallbackOrder,
        templateBindings: node.templateBindings,
        escalationLevel: node.escalationLevel,
        quietHours: node.quietHours,
      })),
    }, { actor: "test-admin", now: new Date("2026-09-05T01:05:00.000Z") });
    await publishWorkflowPolicy(database, {
      domain: "annual_inspection",
      expectedRevision: saved!.revision,
    }, { actor: "test-admin", now: new Date("2026-09-05T01:06:00.000Z") });

    const transitioned = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "policy-freeze-booking",
      closeNodeCodes: ["annual.pending_payment"],
      open: [{ nodeCode: "annual.precheck.pending" }],
    }, { now: new Date("2026-09-05T01:07:00.000Z") });
    assert.equal(transitioned.opened[0].policy.version, 2);
    assert.equal(transitioned.opened[0].firstReminderAt, "2026-09-05T01:38:00.000Z");
    const configuredTask = await database.prepare<Record<string, unknown>>(`
      SELECT metadata_json, policy_node_snapshot_json FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'annual.precheck.pending'
    `).get("policy-freeze-booking");
    assert.equal(JSON.parse(String(configuredTask?.metadata_json)).remainingTime, "3 个营业小时");
    assert.equal(JSON.parse(String(configuredTask?.policy_node_snapshot_json)).deadlineMinutes, 180);
    const frozen = await database.prepare<Record<string, unknown>>(`
      SELECT policy_version FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'annual.pending_payment'
    `).get("policy-freeze-booking");
    assert.equal(Number(frozen?.policy_version), 1);
  } finally {
    await database.close();
  }
});

test("worker 对外部渠道只记录受理并清除一次性敏感载荷", async () => {
  const database = await createTestDatabase("workflow_worker");
  const previousSms = {
    enabled: process.env.SMSBAO_ENABLED,
    username: process.env.SMSBAO_USERNAME,
    apiKey: process.env.SMSBAO_API_KEY,
    signature: process.env.SMSBAO_SIGNATURE,
  };
  try {
    process.env.SMSBAO_ENABLED = "true";
    process.env.SMSBAO_USERNAME = "test-account";
    process.env.SMSBAO_API_KEY = "test-api-key";
    process.env.SMSBAO_SIGNATURE = "驭小满";
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "driver-booking",
      ownerUserId: "demo-user",
    });
    // Enable SMS on a test copy of the published policy node to exercise the outbox;
    // the worker sender is injected, so no provider or real phone is contacted.
    await database.prepare(`
      UPDATE workflow_policy_nodes SET enabled_channels_json = '["in_app","sms"]'
      WHERE policy_set_id = 'annual-workflow-v1' AND node_code = 'annual.driver.claim'
    `).run();
    await database.prepare(`
      UPDATE notification_templates SET filing_status = 'approved'
      WHERE id = 'workflow-template-annual-driver-assigned-sms-v1'
    `).run();
    await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "driver-booking",
      open: [{
        nodeCode: "annual.driver.claim",
        firstReminderAt: "2026-09-05T01:00:00.000Z",
        recipientPhone: "13800138000",
        metadata: { maskedBusinessCode: "YXM-***-DRV" },
        sensitiveVariables: { verificationCode: "123456" },
      }],
    }, { now: new Date("2026-09-05T01:00:00.000Z") });
    let observedBody = "";
    const result = await runWorkflowWorkerOnce(database, {
      now: new Date("2026-09-05T01:00:01.000Z"),
      sender: async (message) => {
        observedBody = message.body;
        return { outcome: "accepted", providerCode: "0", providerMessageId: "provider-task-1" };
      },
    });
    assert.equal(result.deliveredOutbox, 1);
    assert.match(observedBody, /123456/u);
    const outbox = await database.prepare<Record<string, unknown>>("SELECT * FROM notification_outbox LIMIT 1").get();
    assert.equal(outbox?.status, "accepted");
    assert.equal(outbox?.provider_state, "accepted");
    assert.equal(outbox?.delivered_at, null);
    assert.equal(outbox?.sensitive_payload_encrypted, null);
    assert.ok(outbox?.sensitive_cleared_at);

    // A provider call whose worker dies before persisting the result is
    // ambiguous. An expired processing lease must be quarantined, not resent.
    await database.prepare(`
      UPDATE notification_outbox SET status = 'processing', provider_state = NULL,
        accepted_at = NULL, lease_owner = 'crashed-worker', leased_until = ?, updated_at = ?
    `).run("2026-09-05T01:00:10.000Z", "2026-09-05T01:00:00.000Z");
    let resendCalls = 0;
    const recovered = await runWorkflowWorkerOnce(database, {
      now: new Date("2026-09-05T01:01:00.000Z"),
      sender: async () => {
        resendCalls += 1;
        return { outcome: "accepted" };
      },
    });
    assert.equal(recovered.quarantinedOutbox, 1);
    assert.equal(resendCalls, 0);
    const quarantined = await database.prepare<Record<string, unknown>>("SELECT * FROM notification_outbox LIMIT 1").get();
    assert.equal(quarantined?.status, "dead_letter");
    assert.equal(quarantined?.provider_state, "unknown");
    assert.equal(quarantined?.last_error_code, "DELIVERY_OUTCOME_UNKNOWN");
    const unknownAttempt = await database.prepare<Record<string, unknown>>(`
      SELECT outcome FROM notification_delivery_attempts
      WHERE outbox_id = ? ORDER BY attempt_number DESC LIMIT 1
    `).get(String(quarantined?.id));
    assert.equal(unknownAttempt?.outcome, "unknown");
  } finally {
    await database.close();
    for (const [key, value] of Object.entries({
      SMSBAO_ENABLED: previousSms.enabled,
      SMSBAO_USERNAME: previousSms.username,
      SMSBAO_API_KEY: previousSms.apiKey,
      SMSBAO_SIGNATURE: previousSms.signature,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("同主体同时间窗短信合并为一次投递并原子完成整组 outbox", async () => {
  const database = await createTestDatabase("workflow_sms_aggregate");
  const previousSms = {
    enabled: process.env.SMSBAO_ENABLED,
    username: process.env.SMSBAO_USERNAME,
    apiKey: process.env.SMSBAO_API_KEY,
    signature: process.env.SMSBAO_SIGNATURE,
  };
  try {
    process.env.SMSBAO_ENABLED = "true";
    process.env.SMSBAO_USERNAME = "aggregate-test";
    process.env.SMSBAO_API_KEY = "aggregate-test-key";
    process.env.SMSBAO_SIGNATURE = "驭小满";
    const now = new Date("2026-09-05T01:05:00.000Z");
    const policy = (await getWorkflowPolicies(database, "annual_inspection")).current!;
    await database.prepare(`
      UPDATE workflow_policy_nodes SET enabled_channels_json = '["in_app","sms"]'
      WHERE policy_set_id = ? AND node_code = 'annual.precheck.pending'
    `).run(policy.id);
    await database.prepare(`
      UPDATE notification_templates SET filing_status = 'approved'
      WHERE stable_code = 'annual.precheck.pending.station' AND channel = 'sms' AND is_current = 1
    `).run();

    for (const entityId of ["aggregate-booking-a", "aggregate-booking-b"]) {
      await enableWorkflowForEntity(database, {
        domain: "annual_inspection",
        entityType: "booking",
        entityId,
        ownerUserId: "demo-user",
        createdAt: now,
      });
      await applyWorkflowTransition(database, {
        domain: "annual_inspection",
        entityType: "booking",
        entityId,
        open: [{
          nodeCode: "annual.precheck.pending",
          subjectType: "inspection_station",
          subjectId: "aggregate-station",
          assigneeRole: "station",
          recipientPhone: "13800138066",
          firstReminderAt: now,
          metadata: { pendingCount: 1, remainingTime: "2小时", maskedBusinessCode: `${entityId}-***` },
        }],
      }, { now });
    }

    const queued = await database.prepare<Record<string, unknown>>(`
      SELECT status, aggregate_key, available_at FROM notification_outbox ORDER BY created_at, id
    `).all();
    assert.equal(queued.length, 2);
    assert.ok(queued.every((row) => row.status === "pending"));
    assert.equal(new Set(queued.map((row) => row.aggregate_key)).size, 1);
    assert.ok(queued.every((row) => row.available_at === "2026-09-05T01:30:00.000Z"));

    let calls = 0;
    let observedPendingCount = 0;
    let observedBody = "";
    const result = await runWorkflowWorkerOnce(database, {
      now: new Date("2026-09-05T01:30:00.000Z"),
      taskLimit: 0,
      sender: async (message) => {
        calls += 1;
        observedPendingCount = Number(message.variables?.pendingCount);
        observedBody = message.body;
        return { outcome: "accepted", providerCode: "0", providerMessageId: "aggregate-provider-id" };
      },
    });
    assert.equal(result.deliveredOutbox, 1);
    assert.equal(calls, 1);
    assert.equal(observedPendingCount, 2);
    assert.match(observedBody, /2/u);
    const persisted = await database.prepare<Record<string, unknown>>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
        COUNT(DISTINCT provider_message_id) AS provider_calls
      FROM notification_outbox
    `).get();
    assert.equal(Number(persisted?.accepted), 2);
    assert.equal(Number(persisted?.provider_calls), 1);
    const attempts = await database.prepare<Record<string, unknown>>(
      "SELECT COUNT(*) AS count FROM notification_delivery_attempts",
    ).get();
    assert.equal(Number(attempts?.count), 1);
  } finally {
    await database.close();
    for (const [key, value] of Object.entries({
      SMSBAO_ENABLED: previousSms.enabled,
      SMSBAO_USERNAME: previousSms.username,
      SMSBAO_API_KEY: previousSms.apiKey,
      SMSBAO_SIGNATURE: previousSms.signature,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("微信临时失败立即整组切换短信兜底且保持聚合", async () => {
  const database = await createTestDatabase("workflow_wechat_fallback");
  const previousEnvironment = {
    smsEnabled: process.env.SMSBAO_ENABLED,
    smsUsername: process.env.SMSBAO_USERNAME,
    smsApiKey: process.env.SMSBAO_API_KEY,
    smsSignature: process.env.SMSBAO_SIGNATURE,
    wechatAppId: process.env.WECHAT_MINIPROGRAM_APP_ID,
    wechatAppSecret: process.env.WECHAT_MINIPROGRAM_APP_SECRET,
  };
  try {
    process.env.SMSBAO_ENABLED = "true";
    process.env.SMSBAO_USERNAME = "fallback-test";
    process.env.SMSBAO_API_KEY = "fallback-test-key";
    process.env.SMSBAO_SIGNATURE = "驭小满";
    process.env.WECHAT_MINIPROGRAM_APP_ID = "wx-workflow-fallback-test";
    process.env.WECHAT_MINIPROGRAM_APP_SECRET = "wechat-fallback-test-secret";
    const now = new Date("2026-09-05T01:05:00.000Z");
    const boundary = new Date("2026-09-05T01:30:00.000Z");
    const recipientUserId = "workflow-fallback-user";
    const wechatTemplateId = "wechat-template-fallback-test";
    const policy = (await getWorkflowPolicies(database, "annual_inspection")).current!;
    await database.prepare(`
      UPDATE workflow_policy_nodes
      SET enabled_channels_json = '["in_app","wechat","sms"]',
        fallback_order_json = '["wechat","sms"]'
      WHERE policy_set_id = ? AND node_code = 'annual.precheck.pending'
    `).run(policy.id);
    await database.prepare(`
      UPDATE notification_templates
      SET provider_template_id = ?, provider_snapshot_json = ?, filing_status = 'configured'
      WHERE stable_code = 'annual.precheck.pending.station' AND channel = 'wechat' AND is_current = 1
    `).run(wechatTemplateId, JSON.stringify({
      fieldMappings: [{ field: "thing1", variable: "pendingCount" }],
    }));
    await database.prepare(`
      UPDATE notification_templates SET filing_status = 'approved'
      WHERE stable_code = 'annual.precheck.pending.station' AND channel = 'sms' AND is_current = 1
    `).run();
    await database.prepare(`
      INSERT INTO wechat_subscription_authorizations (
        id, user_id, template_id, authorization_state, remaining_uses, provider_app_id, updated_at
      ) VALUES (?, ?, ?, 'accepted', 1, ?, ?)
    `).run(
      "workflow-fallback-authorization",
      recipientUserId,
      wechatTemplateId,
      "wx-workflow-fallback-test",
      now.toISOString(),
    );

    for (const entityId of ["fallback-booking-a", "fallback-booking-b"]) {
      await enableWorkflowForEntity(database, {
        domain: "annual_inspection",
        entityType: "booking",
        entityId,
        ownerUserId: recipientUserId,
        createdAt: now,
      });
      await applyWorkflowTransition(database, {
        domain: "annual_inspection",
        entityType: "booking",
        entityId,
        open: [{
          nodeCode: "annual.precheck.pending",
          subjectType: "inspection_station",
          subjectId: "fallback-station",
          assigneeRole: "station",
          recipientUserId,
          recipientPhone: "13800138076",
          recipientWechatOpenId: "openid-workflow-fallback",
          firstReminderAt: now,
          metadata: { pendingCount: 1, remainingTime: "2小时", maskedBusinessCode: `${entityId}-***` },
        }],
      }, { now });
    }

    const initial = await database.prepare<Record<string, unknown>>(`
      SELECT channel, status, aggregate_key, available_at FROM notification_outbox ORDER BY id
    `).all();
    assert.equal(initial.length, 2);
    assert.ok(
      initial.every((row) => row.channel === "wechat" && row.status === "pending"),
      JSON.stringify(initial),
    );
    assert.equal(new Set(initial.map((row) => row.aggregate_key)).size, 1);
    assert.ok(initial.every((row) => row.available_at === boundary.toISOString()));

    let wechatCalls = 0;
    const failedWechat = await runWorkflowWorkerOnce(database, {
      now: boundary,
      taskLimit: 0,
      outboxLimit: 1,
      sender: async (message) => {
        assert.equal(message.channel, "wechat");
        wechatCalls += 1;
        return { outcome: "temporary_failure", providerCode: "WECHAT_NETWORK_ERROR" };
      },
    });
    assert.equal(failedWechat.deliveredOutbox, 1);
    assert.equal(wechatCalls, 1);

    const switched = await database.prepare<Record<string, unknown>>(`
      SELECT channel, status, aggregate_key, available_at, attempt_count, fallback_channels_json
      FROM notification_outbox ORDER BY id
    `).all();
    assert.equal(switched.length, 2);
    assert.ok(switched.every((row) => row.channel === "sms" && row.status === "pending"));
    assert.ok(switched.every((row) => row.available_at === boundary.toISOString()));
    assert.ok(switched.every((row) => Number(row.attempt_count) === 1));
    assert.ok(switched.every((row) => row.fallback_channels_json === "[]"));
    assert.equal(new Set(switched.map((row) => row.aggregate_key)).size, 1);
    assert.notEqual(switched[0].aggregate_key, initial[0].aggregate_key);
    const authorization = await database.prepare<Record<string, unknown>>(`
      SELECT remaining_uses FROM wechat_subscription_authorizations
      WHERE id = 'workflow-fallback-authorization'
    `).get();
    assert.equal(Number(authorization?.remaining_uses), 0);

    let smsCalls = 0;
    const deliveredSms = await runWorkflowWorkerOnce(database, {
      now: boundary,
      taskLimit: 0,
      outboxLimit: 1,
      sender: async (message) => {
        assert.equal(message.channel, "sms");
        assert.equal(Number(message.variables?.pendingCount), 2);
        smsCalls += 1;
        return { outcome: "accepted", providerCode: "0" };
      },
    });
    assert.equal(deliveredSms.deliveredOutbox, 1);
    assert.equal(smsCalls, 1);
    const completed = await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
        COUNT(*) FILTER (WHERE status = 'retry') AS retrying
      FROM notification_outbox
    `).get();
    assert.equal(Number(completed?.accepted), 2);
    assert.equal(Number(completed?.retrying), 0);
  } finally {
    await database.close();
    for (const [key, value] of Object.entries({
      SMSBAO_ENABLED: previousEnvironment.smsEnabled,
      SMSBAO_USERNAME: previousEnvironment.smsUsername,
      SMSBAO_API_KEY: previousEnvironment.smsApiKey,
      SMSBAO_SIGNATURE: previousEnvironment.smsSignature,
      WECHAT_MINIPROGRAM_APP_ID: previousEnvironment.wechatAppId,
      WECHAT_MINIPROGRAM_APP_SECRET: previousEnvironment.wechatAppSecret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("平台异常短信覆盖所有当班联系人且可由平台显式关闭", async () => {
  const database = await createTestDatabase("workflow_multi_duty");
  const app = Fastify({ logger: false });
  const previousSms = {
    enabled: process.env.SMSBAO_ENABLED,
    username: process.env.SMSBAO_USERNAME,
    apiKey: process.env.SMSBAO_API_KEY,
    signature: process.env.SMSBAO_SIGNATURE,
  };
  const now = new Date("2026-09-05T03:05:00.000Z");
  registerWorkflowRoutes(app, database, {
    now: () => now,
    allowBackofficeTestFallback: true,
  });
  await app.ready();
  try {
    process.env.SMSBAO_ENABLED = "true";
    process.env.SMSBAO_USERNAME = "duty-test";
    process.env.SMSBAO_API_KEY = "duty-test-key";
    process.env.SMSBAO_SIGNATURE = "驭小满";
    for (const [contactName, phone] of [["值班甲", "13800138071"], ["值班乙", "13800138072"]]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/workflow/recipients",
        payload: { recipientType: "platform_duty", contactName, phone, isEnabled: true },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const policy = (await getWorkflowPolicies(database, "annual_inspection")).current!;
    await database.prepare(`
      UPDATE workflow_policy_nodes SET enabled_channels_json = '["in_app","sms"]'
      WHERE policy_set_id = ? AND node_code = 'workflow.exception'
    `).run(policy.id);
    await database.prepare(`
      UPDATE notification_templates SET filing_status = 'approved'
      WHERE stable_code = 'workflow.exception.platform' AND channel = 'sms' AND is_current = 1
    `).run();
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "multi-duty-booking",
      ownerUserId: "demo-user",
      createdAt: now,
    });
    const transition = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "multi-duty-booking",
      open: [{
        nodeCode: "workflow.exception",
        subjectType: "platform_duty",
        assigneeRole: "platform",
        firstReminderAt: now,
        metadata: { pendingCount: 1, overdueCount: 1, maskedBusinessCode: "YXM-***-DUTY" },
      }],
    }, { now });
    assert.equal(transition.opened.length, 1);
    const queued = await database.prepare<Record<string, unknown>>(
      "SELECT COUNT(*) AS count FROM notification_outbox WHERE channel = 'sms' AND status = 'pending'",
    ).get();
    assert.equal(Number(queued?.count), 2);

    const recipients = new Set<string>();
    const delivered = await runWorkflowWorkerOnce(database, {
      now: new Date("2026-09-05T03:30:00.000Z"),
      taskLimit: 0,
      sender: async (message) => {
        recipients.add(message.recipient);
        return { outcome: "accepted", providerCode: "0" };
      },
    });
    assert.equal(delivered.deliveredOutbox, 2);
    assert.deepEqual([...recipients].sort(), ["13800138071", "13800138072"]);

    const resolved = await app.inject({
      method: "POST",
      url: `/api/admin/workflow/tasks/${transition.opened[0].id}/resolve`,
      payload: { reason: "平台已完成线下协调" },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    const task = await database.prepare<Record<string, unknown>>(
      "SELECT status, closed_reason FROM workflow_tasks WHERE id = ?",
    ).get(transition.opened[0].id);
    assert.equal(task?.status, "completed");
    assert.match(String(task?.closed_reason), /workflow\.exception_resolved/u);
  } finally {
    await app.close();
    await database.close();
    for (const [key, value] of Object.entries({
      SMSBAO_ENABLED: previousSms.enabled,
      SMSBAO_USERNAME: previousSms.username,
      SMSBAO_API_KEY: previousSms.apiKey,
      SMSBAO_SIGNATURE: previousSms.signature,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("未报备或未配置的外部模板不会进入真实发送队列", async () => {
  const database = await createTestDatabase("workflow_external_guard");
  try {
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection", entityType: "booking", entityId: "guard-booking", ownerUserId: "demo-user",
    });
    await database.prepare(`
      UPDATE workflow_policy_nodes SET enabled_channels_json = '["in_app","wechat","sms"]'
      WHERE policy_set_id = 'annual-workflow-v1' AND node_code = 'annual.driver.claim'
    `).run();
    await applyWorkflowTransition(database, {
      domain: "annual_inspection", entityType: "booking", entityId: "guard-booking",
      open: [{
        nodeCode: "annual.driver.claim", firstReminderAt: "2026-09-05T01:00:00.000Z",
        recipientPhone: "13800138000", recipientWechatOpenId: "openid-test-123456789",
        sensitiveVariables: { verificationCode: "654321" },
      }],
    }, { now: new Date("2026-09-05T01:00:00.000Z") });
    const row = await database.prepare<Record<string, unknown>>("SELECT COUNT(*) AS count FROM notification_outbox").get();
    assert.equal(Number(row?.count), 0);
  } finally {
    await database.close();
  }
});

test("营业时间、模板变量与短信分段计算稳定", () => {
  // Saturday 17:59 Shanghai + 2 business minutes, Sunday is excluded here.
  const result = addWorkflowMinutes(new Date("2026-09-05T09:59:00.000Z"), 2, "business", {
    weekdays: [1, 2, 3, 4, 5, 6], start: "08:00", end: "18:00", holidays: [],
  });
  assert.equal(result?.toISOString(), "2026-09-07T00:01:00.000Z");
  assert.equal(renderWorkflowTemplate("车辆 {{maskedPlate}}", { maskedPlate: "津A·8***8" }), "车辆 津A·8***8");
  assert.throws(() => renderWorkflowTemplate("{{fullPhone}}", {}), /不在白名单/u);
  assert.equal(estimateSmsSegments("测".repeat(70)), 1);
  assert.equal(estimateSmsSegments("测".repeat(71)), 2);
  const integration = workflowIntegrationStatus();
  assert.equal("apiKey" in integration.smsBao, false);
});

test("信息通知入库后自动完成且车主静默时段只延迟非紧急外发", async () => {
  const database = await createTestDatabase("workflow_information");
  try {
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "published-report-booking",
      ownerUserId: "demo-user",
    });
    const transition = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "published-report-booking",
      open: [{
        nodeCode: "annual.report.ready",
        recipientUserId: "demo-user",
        firstReminderAt: "2026-09-05T15:30:00.000Z",
        metadata: { maskedPlate: "津A***8", reportConclusion: "通过" },
      }],
    }, { now: new Date("2026-09-05T15:30:00.000Z") });
    assert.equal(transition.opened[0].status, "completed");
    const task = await database.prepare<Record<string, unknown>>(`
      SELECT status, closed_reason FROM workflow_tasks WHERE entity_id = ?
    `).get("published-report-booking");
    assert.equal(task?.status, "completed");
    assert.equal(task?.closed_reason, "notification_queued");
    assert.equal(Number((await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM notification_inbox WHERE recipient_user_id = ?
    `).get("demo-user"))?.count), 1);

    const quiet = { appliesTo: "owner_non_urgent", start: "22:00", end: "08:00", timezone: "Asia/Shanghai" };
    const duringQuiet = new Date("2026-09-05T15:30:00.000Z"); // 23:30 Shanghai
    assert.equal(
      workflowExternalAvailableAt(duringQuiet, quiet, { ownerNonUrgent: true }).toISOString(),
      "2026-09-06T00:00:00.000Z",
    );
    assert.equal(
      workflowExternalAvailableAt(duringQuiet, quiet, { ownerNonUrgent: false }).toISOString(),
      duringQuiet.toISOString(),
    );
  } finally {
    await database.close();
  }
});

test("车主消息列表在 PostgreSQL 无分页游标时可正常查询", async () => {
  const database = await createTestDatabase("workflow_owner_notifications");
  const app = Fastify({ logger: false });
  registerWorkflowRoutes(app, database, { allowBackofficeTestFallback: true });
  await app.ready();
  try {
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "owner-notification-booking",
      ownerUserId: "demo-user",
    });
    await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "owner-notification-booking",
      open: [{
        nodeCode: "annual.report.ready",
        recipientUserId: "demo-user",
        metadata: { maskedPlate: "津A***8", reportConclusion: "通过" },
      }],
    }, { now: new Date("2026-09-05T15:30:00.000Z") });

    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/notifications?limit=20",
    });
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json<Record<string, any>>().data;
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.category, "annual_inspection");
    assert.equal(page.nextCursor, null);
  } finally {
    await app.close();
    await database.close();
  }
});

test("服务角色站内督办记录任务中心可见且与车主消息入箱严格区分", async () => {
  const database = await createTestDatabase("workflow_task_center_visibility");
  const app = Fastify({ logger: false });
  try {
    const createdAt = new Date("2026-09-05T01:00:00.000Z");
    const reminderAt = new Date("2026-09-05T01:01:00.000Z");
    const serviceCases = [
      { role: "station", domain: "annual_inspection" as const, entityType: "booking", nodeCode: "annual.precheck.pending", subjectType: "inspection_station" },
      { role: "driver", domain: "annual_inspection" as const, entityType: "booking", nodeCode: "annual.pickup.driver", subjectType: "assigned_driver" },
      { role: "platform", domain: "annual_inspection" as const, entityType: "booking", nodeCode: "annual.driver.assign", subjectType: "platform_duty" },
      { role: "repair_shop", domain: "repair_quote" as const, entityType: "repair_request", nodeCode: "repair.request.opportunity", subjectType: "repair_shop" },
    ];
    const taskIds: Record<string, string> = {};
    for (const item of serviceCases) {
      const entityId = `task-center-${item.role}`;
      await enableWorkflowForEntity(database, {
        domain: item.domain,
        entityType: item.entityType,
        entityId,
        ownerUserId: "demo-user",
        createdAt,
      });
      const transition = await applyWorkflowTransition(database, {
        domain: item.domain,
        entityType: item.entityType,
        entityId,
        open: [{
          nodeCode: item.nodeCode,
          assigneeRole: item.role,
          subjectType: item.subjectType,
          subjectId: `${item.role}-subject`,
          firstReminderAt: reminderAt,
          dueAt: "2026-09-05T03:00:00.000Z",
          escalateAt: "2026-09-05T04:00:00.000Z",
          metadata: { maskedBusinessCode: `***${item.role}` },
        }],
      }, { now: createdAt });
      assert.equal(transition.opened[0].taskCenterVisible, true);
      assert.equal(transition.opened[0].inAppSupervisionMode, "task_center");
      taskIds[item.role] = transition.opened[0].id;
    }

    await runWorkflowWorkerOnce(database, { now: reminderAt, outboxLimit: 0 });
    for (const item of serviceCases) {
      const task = await database.prepare<Record<string, unknown>>(`
        SELECT status, reminder_count, last_reminded_at FROM workflow_tasks WHERE id = ?
      `).get(taskIds[item.role]);
      assert.equal(task?.status, "open", `${item.role} task must remain visible`);
      assert.equal(Number(task?.reminder_count), 1, `${item.role} task-centre reminder must be recorded`);
      assert.equal(task?.last_reminded_at, reminderAt.toISOString());
      const event = await database.prepare<Record<string, unknown>>(`
        SELECT event_type, metadata_json FROM workflow_task_events
        WHERE task_id = ? AND event_type = 'task_center_reminder'
      `).get(taskIds[item.role]);
      assert.equal(event?.event_type, "task_center_reminder");
      const metadata = JSON.parse(String(event?.metadata_json)) as Record<string, unknown>;
      assert.equal(metadata.taskCenterVisible, true);
      assert.equal(metadata.inboxQueued, false);
      assert.equal(metadata.outboxQueued, false);
    }
    assert.equal(Number((await database.prepare<Record<string, unknown>>(
      "SELECT COUNT(*) AS count FROM notification_inbox",
    ).get())?.count), 0);
    assert.equal(Number((await database.prepare<Record<string, unknown>>(
      "SELECT COUNT(*) AS count FROM notification_outbox",
    ).get())?.count), 0);

    // The owner path is different: "in_app" means an actual owner inbox row,
    // never service task-centre visibility. Its information task may retain the
    // existing close-after-queue behaviour because a real inbox row exists.
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "owner-inbox-booking",
      ownerUserId: "owner-inbox-user",
      createdAt,
    });
    const ownerTransition = await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "owner-inbox-booking",
      open: [{
        nodeCode: "annual.report.ready",
        recipientUserId: "owner-inbox-user",
        firstReminderAt: reminderAt,
        metadata: { maskedBusinessCode: "***OWNER", reportConclusion: "通过" },
      }],
    }, { now: createdAt });
    assert.equal(ownerTransition.opened[0].taskCenterVisible, false);
    assert.equal(ownerTransition.opened[0].inAppSupervisionMode, "owner_inbox");
    await runWorkflowWorkerOnce(database, { now: reminderAt, outboxLimit: 0 });
    const ownerInbox = await database.prepare<Record<string, unknown>>(`
      SELECT task_id FROM notification_inbox WHERE recipient_user_id = 'owner-inbox-user'
    `).all();
    assert.equal(ownerInbox.length, 1);
    assert.equal(ownerInbox[0].task_id, ownerTransition.opened[0].id);

    registerWorkflowRoutes(app, database, { allowBackofficeTestFallback: true });
    await app.ready();
    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/admin/workflow/tasks/${taskIds.station}`,
    });
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detail = detailResponse.json<Record<string, any>>().data.task;
    assert.equal(detail.taskCenterVisible, true);
    const taskCenterEvent = detail.events.find((event: Record<string, unknown>) => event.type === "task_center_reminder");
    assert.equal(taskCenterEvent.label, "任务中心站内督办已生效");
    assert.equal(taskCenterEvent.detail, "任务中心站内督办已生效，未配置额外推送渠道");
    assert.equal(taskCenterEvent.supervision.taskCenterVisible, true);
  } finally {
    await app.close();
    await database.close();
  }
});

test("责任方任务升级时幂等创建平台异常待办", async () => {
  const database = await createTestDatabase("workflow_escalation");
  try {
    const now = new Date("2026-09-05T03:00:00.000Z");
    await enableWorkflowForEntity(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "overdue-booking",
      ownerUserId: "demo-user",
      createdAt: new Date(now.getTime() - 60 * 60_000),
    });
    await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: "overdue-booking",
      open: [{
        nodeCode: "annual.precheck.pending",
        recipientUserId: "demo-user",
        firstReminderAt: null,
        dueAt: new Date(now.getTime() - 10 * 60_000),
        escalateAt: new Date(now.getTime() - 5 * 60_000),
        metadata: { maskedBusinessCode: "***DUE001" },
      }],
    }, { now: new Date(now.getTime() - 60 * 60_000) });
    await runWorkflowWorkerOnce(database, { now, outboxLimit: 0 });
    await runWorkflowWorkerOnce(database, { now, outboxLimit: 0 });
    const exception = await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'workflow.exception' AND status = 'open'
    `).get("overdue-booking");
    assert.equal(Number(exception?.count), 1);
    const source = await database.prepare<Record<string, unknown>>(`
      SELECT escalated_at FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'annual.precheck.pending'
    `).get("overdue-booking");
    assert.equal(source?.escalated_at, now.toISOString());
    const notifications = await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM notification_inbox WHERE task_id = (
        SELECT id FROM workflow_tasks
        WHERE entity_id = ? AND node_code = 'annual.precheck.pending' LIMIT 1
      )
    `).get("overdue-booking");
    assert.equal(Number(notifications?.count), 1);
    const milestones = await database.prepare<Record<string, unknown>>(`
      SELECT event_type, COUNT(*) AS count FROM workflow_task_events
      WHERE task_id = (SELECT id FROM workflow_tasks
        WHERE entity_id = ? AND node_code = 'annual.precheck.pending' LIMIT 1)
        AND event_type IN ('overdue', 'escalated')
      GROUP BY event_type ORDER BY event_type
    `).all("overdue-booking");
    assert.deepEqual(milestones.map((row) => [row.event_type, Number(row.count)]), [
      ["escalated", 1], ["overdue", 1],
    ]);
  } finally {
    await database.close();
  }
});

test("通知联系人写入、停用与脱敏审计在同一事务提交", async () => {
  const database = await createTestDatabase("workflow_recipient_audit");
  const app = Fastify({ logger: false });
  let current = new Date("2026-09-05T04:00:00.000Z");
  registerWorkflowRoutes(app, database, {
    now: () => current,
    allowBackofficeTestFallback: true,
  });
  await app.ready();
  try {
    const rawPhone = "13800138000";
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/admin/workflow/recipients",
      payload: {
        recipientType: "platform_duty",
        contactName: "白班值守",
        phone: rawPhone,
        isEnabled: true,
        dutySchedule: { weekdays: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" },
      },
    });
    assert.equal(createdResponse.statusCode, 200, createdResponse.body);
    const created = createdResponse.json<Record<string, any>>().data;
    assert.equal(created.phoneMasked, "138****8000");

    current = new Date(current.getTime() + 1_000);
    const updatedResponse = await app.inject({
      method: "PUT",
      url: `/api/admin/workflow/recipients/${created.id}`,
      payload: {
        recipientType: "platform_duty",
        contactName: "夜班值守",
        isEnabled: true,
        dutySchedule: { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "18:00", end: "23:59" },
      },
    });
    assert.equal(updatedResponse.statusCode, 200, updatedResponse.body);
    assert.equal(updatedResponse.json<Record<string, any>>().data.phoneMasked, "138****8000");

    current = new Date(current.getTime() + 1_000);
    const deletedResponse = await app.inject({
      method: "DELETE",
      url: `/api/admin/workflow/recipients/${created.id}`,
    });
    assert.equal(deletedResponse.statusCode, 204, deletedResponse.body);

    const stored = await database.prepare<Record<string, unknown>>(`
      SELECT phone_encrypted, phone_hash, is_enabled
      FROM workflow_notification_recipients WHERE id = ?
    `).get(created.id);
    assert.equal(Number(stored?.is_enabled), 0);
    const audits = await database.prepare<Record<string, unknown>>(`
      SELECT action, before_json, after_json
      FROM backoffice_audit_events
      WHERE resource_type = 'workflow_notification_recipient' AND resource_id = ?
      ORDER BY occurred_at, action
    `).all(created.id);
    assert.deepEqual(audits.map((row) => row.action), [
      "workflow.recipient.create",
      "workflow.recipient.update",
      "workflow.recipient.disable",
    ]);
    const serializedAudit = JSON.stringify(audits);
    assert.equal(serializedAudit.includes(rawPhone), false);
    assert.equal(serializedAudit.includes(String(stored?.phone_encrypted)), false);
    assert.equal(serializedAudit.includes(String(stored?.phone_hash)), false);

    // If audit persistence fails, the recipient mutation must roll back too.
    await database.execute("ALTER TABLE backoffice_audit_events RENAME TO backoffice_audit_events_unavailable");
    const failedResponse = await app.inject({
      method: "POST",
      url: "/api/admin/workflow/recipients",
      payload: {
        recipientType: "platform_duty",
        contactName: "事务失败联系人",
        phone: "13900139000",
        isEnabled: true,
      },
    });
    assert.equal(failedResponse.statusCode, 500, failedResponse.body);
    const rolledBack = await database.prepare<Record<string, unknown>>(`
      SELECT COUNT(*) AS count FROM workflow_notification_recipients WHERE contact_name = ?
    `).get("事务失败联系人");
    assert.equal(Number(rolledBack?.count), 0);
  } finally {
    await app.close();
    await database.close();
  }
});

test("测试短信用事务锁执行分钟/日限频并只审计脱敏投递摘要", async () => {
  const database = await createTestDatabase("workflow_test_sms_safety");
  const app = Fastify({ logger: false });
  let current = new Date("2026-09-05T05:00:00.000Z");
  registerWorkflowRoutes(app, database, {
    now: () => current,
    allowBackofficeTestFallback: true,
  });
  await app.ready();
  try {
    const rawPhone = "13700137000";
    const recipientResponse = await app.inject({
      method: "POST",
      url: "/api/admin/workflow/recipients",
      payload: {
        recipientType: "platform_duty",
        contactName: "短信测试值守",
        phone: rawPhone,
        isEnabled: true,
      },
    });
    assert.equal(recipientResponse.statusCode, 200, recipientResponse.body);
    const recipient = recipientResponse.json<Record<string, any>>().data;
    const template = await database.prepare<Record<string, unknown>>(`
      SELECT id FROM notification_templates
      WHERE stable_code = 'workflow.exception.platform' AND channel = 'sms'
        AND state = 'published'
      LIMIT 1
    `).get();
    assert.ok(template?.id);
    await database.prepare(`
      UPDATE notification_templates SET filing_status = 'approved' WHERE id = ?
    `).run(String(template!.id));

    const send = () => app.inject({
      method: "POST",
      url: "/api/admin/workflow/test-sms",
      payload: {
        templateId: String(template!.id),
        recipientId: recipient.id,
        variables: { pendingCount: 2, overdueCount: 1, maskedBusinessCode: "YXM-***-TEST" },
      },
    });

    const concurrent = await Promise.all([send(), send()]);
    assert.deepEqual(concurrent.map((response) => response.statusCode).sort((a, b) => a - b), [200, 429]);
    const accepted = concurrent.find((response) => response.statusCode === 200)!;
    assert.equal(accepted.json<Record<string, any>>().data.deliverySemantics, "accepted_not_delivered");

    // Four additional calls outside the rolling minute fill the five-per-day
    // quota. The next call is rejected even though its minute bucket is clear.
    for (let index = 0; index < 4; index += 1) {
      current = new Date(current.getTime() + 61_000);
      const response = await send();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<Record<string, any>>().data.deliverySemantics, "accepted_not_delivered");
    }
    current = new Date(current.getTime() + 61_000);
    const dailyLimited = await send();
    assert.equal(dailyLimited.statusCode, 429, dailyLimited.body);

    const counts = await database.prepare<Record<string, unknown>>(`
      SELECT
        (SELECT COUNT(*) FROM workflow_test_sms_limits) AS limits,
        (SELECT COUNT(*) FROM notification_outbox WHERE task_id IS NULL AND channel = 'sms') AS outbox,
        (SELECT COUNT(*) FROM backoffice_audit_events WHERE action = 'workflow.test_sms.queue') AS audits
    `).get();
    assert.equal(Number(counts?.limits), 5);
    assert.equal(Number(counts?.outbox), 5);
    assert.equal(Number(counts?.audits), 5);
    const stored = await database.prepare<Record<string, unknown>>(`
      SELECT phone_encrypted, phone_hash FROM workflow_notification_recipients WHERE id = ?
    `).get(recipient.id);
    const smsAudits = await database.prepare<Record<string, unknown>>(`
      SELECT before_json, after_json, metadata_json FROM backoffice_audit_events
      WHERE action = 'workflow.test_sms.queue'
    `).all();
    const serializedAudit = JSON.stringify(smsAudits);
    assert.equal(serializedAudit.includes(rawPhone), false);
    assert.equal(serializedAudit.includes(String(stored?.phone_encrypted)), false);
    assert.equal(serializedAudit.includes(String(stored?.phone_hash)), false);
    assert.equal(serializedAudit.includes("verificationCode"), false);

    // Queue, rate reservation and audit are one transaction: an audit outage
    // cannot consume quota or leave an unsupervised outbox message behind.
    const beforeFailure = { limits: Number(counts?.limits), outbox: Number(counts?.outbox) };
    await database.execute("ALTER TABLE backoffice_audit_events RENAME TO backoffice_audit_events_unavailable");
    current = new Date(current.getTime() + 25 * 60 * 60_000);
    const failedResponse = await send();
    assert.equal(failedResponse.statusCode, 500, failedResponse.body);
    const afterFailure = await database.prepare<Record<string, unknown>>(`
      SELECT
        (SELECT COUNT(*) FROM workflow_test_sms_limits) AS limits,
        (SELECT COUNT(*) FROM notification_outbox WHERE task_id IS NULL AND channel = 'sms') AS outbox
    `).get();
    assert.equal(Number(afterFailure?.limits), beforeFailure.limits);
    assert.equal(Number(afterFailure?.outbox), beforeFailure.outbox);
  } finally {
    await app.close();
    await database.close();
  }
});

test("车主微信订阅只暴露当前策略已启用模板且授权次数与 AppID 由服务端决定", async () => {
  const previousAppId = process.env.WECHAT_MINIPROGRAM_APP_ID;
  const previousSecret = process.env.WECHAT_MINIPROGRAM_APP_SECRET;
  const previousAliasAppId = process.env.WECHAT_APP_ID;
  const previousAliasSecret = process.env.WECHAT_APP_SECRET;
  process.env.WECHAT_MINIPROGRAM_APP_ID = "wx-owner-subscription-test";
  process.env.WECHAT_MINIPROGRAM_APP_SECRET = "server-only-test-secret";
  delete process.env.WECHAT_APP_ID;
  delete process.env.WECHAT_APP_SECRET;
  const database = await createTestDatabase("workflow_owner_wechat");
  const app = Fastify({ logger: false });
  registerWorkflowRoutes(app, database, { allowBackofficeTestFallback: true });
  await app.ready();
  try {
    await database.prepare(`
      UPDATE workflow_policy_nodes SET enabled_channels_json = '["in_app","wechat"]'
      WHERE node_code IN ('annual.report.ready', 'repair.quote.owner_action', 'annual.precheck.pending')
        AND policy_set_id IN (
          SELECT id FROM workflow_policy_sets
          WHERE state = 'published' AND is_current = 1
        )
    `).run();
    const configuredTemplates = [
      ["annual.report.ready.owner", "wx-owner-report"],
      ["repair.quote.first.owner", "wx-owner-repair"],
      ["annual.precheck.pending.station", "wx-station-precheck"],
      // A configured owner template whose policy channel is disabled must not
      // make the subscription prompt appear.
      ["annual.service.completed.owner", "wx-owner-disabled"],
    ] as const;
    for (const [stableCode, providerTemplateId] of configuredTemplates) {
      await database.prepare(`
        UPDATE notification_templates
        SET provider_template_id = ?, provider_snapshot_json = ?, filing_status = 'configured'
        WHERE stable_code = ? AND channel = 'wechat'
          AND state = 'published' AND is_current = 1
      `).run(
        providerTemplateId,
        JSON.stringify({ fieldMappings: [{ field: "thing1", variable: "maskedPlate" }] }),
        stableCode,
      );
    }

    const templates = await app.inject({ method: "GET", url: "/api/workflow/wechat-subscription-templates" });
    assert.equal(templates.statusCode, 200, templates.body);
    assert.deepEqual(templates.json<Record<string, any>>().data.templateIds, ["wx-owner-report", "wx-owner-repair"]);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/workflow/wechat-subscriptions",
      payload: { templateId: "wx-owner-report", state: "accepted" },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    let stored = await database.prepare<Record<string, unknown>>(`
      SELECT authorization_state, remaining_uses, provider_app_id
      FROM wechat_subscription_authorizations
      WHERE user_id = 'demo-user' AND template_id = 'wx-owner-report'
    `).get();
    assert.equal(stored?.authorization_state, "accepted");
    assert.equal(Number(stored?.remaining_uses), 1);
    assert.equal(stored?.provider_app_id, "wx-owner-subscription-test");

    const untrustedCounters = await app.inject({
      method: "POST",
      url: "/api/workflow/wechat-subscriptions",
      payload: {
        templateId: "wx-owner-report",
        state: "accepted",
        remainingUses: 100,
        providerAppId: "attacker-controlled-app",
      },
    });
    assert.equal(untrustedCounters.statusCode, 400, untrustedCounters.body);
    stored = await database.prepare<Record<string, unknown>>(`
      SELECT authorization_state, remaining_uses, provider_app_id
      FROM wechat_subscription_authorizations
      WHERE user_id = 'demo-user' AND template_id = 'wx-owner-report'
    `).get();
    assert.equal(Number(stored?.remaining_uses), 1);
    assert.equal(stored?.provider_app_id, "wx-owner-subscription-test");

    const unavailable = await app.inject({
      method: "POST",
      url: "/api/workflow/wechat-subscriptions",
      payload: { templateId: "wx-station-precheck", state: "accepted" },
    });
    assert.equal(unavailable.statusCode, 400, unavailable.body);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/workflow/wechat-subscriptions",
      payload: { templateId: "wx-owner-report", state: "rejected" },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    stored = await database.prepare<Record<string, unknown>>(`
      SELECT authorization_state, remaining_uses, provider_app_id
      FROM wechat_subscription_authorizations
      WHERE user_id = 'demo-user' AND template_id = 'wx-owner-report'
    `).get();
    assert.equal(stored?.authorization_state, "rejected");
    assert.equal(Number(stored?.remaining_uses), 0);

    delete process.env.WECHAT_MINIPROGRAM_APP_SECRET;
    const notConfigured = await app.inject({ method: "GET", url: "/api/workflow/wechat-subscription-templates" });
    assert.equal(notConfigured.statusCode, 200, notConfigured.body);
    assert.deepEqual(notConfigured.json<Record<string, any>>().data.templateIds, []);
    const cannotRecord = await app.inject({
      method: "POST",
      url: "/api/workflow/wechat-subscriptions",
      payload: { templateId: "wx-owner-report", state: "accepted" },
    });
    assert.equal(cannotRecord.statusCode, 503, cannotRecord.body);
  } finally {
    if (previousAppId == null) delete process.env.WECHAT_MINIPROGRAM_APP_ID;
    else process.env.WECHAT_MINIPROGRAM_APP_ID = previousAppId;
    if (previousSecret == null) delete process.env.WECHAT_MINIPROGRAM_APP_SECRET;
    else process.env.WECHAT_MINIPROGRAM_APP_SECRET = previousSecret;
    if (previousAliasAppId == null) delete process.env.WECHAT_APP_ID;
    else process.env.WECHAT_APP_ID = previousAliasAppId;
    if (previousAliasSecret == null) delete process.env.WECHAT_APP_SECRET;
    else process.env.WECHAT_APP_SECRET = previousAliasSecret;
    await app.close();
    await database.close();
  }
});
