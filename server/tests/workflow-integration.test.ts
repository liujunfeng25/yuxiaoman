import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  acknowledgeAnnualDriverClaim,
  enableAnnualWorkflowForBooking,
  enableRepairWorkflowForRequest,
  syncAnnualWorkflowForBooking,
  syncRepairWorkflowForRequest,
} from "../workflow-integration.js";
import { applyWorkflowTransition, closeWorkflowTasks } from "../workflow.js";
import { runWorkflowWorkerOnce } from "../workflow-worker.js";
import { createTestDatabase } from "./test-database.js";

type Row = Record<string, unknown>;

async function openNodes(database: Awaited<ReturnType<typeof createTestDatabase>>, entityId: string): Promise<string[]> {
  const rows = await database.prepare<Row>(`
    SELECT node_code FROM workflow_tasks
    WHERE entity_id = ? AND status = 'open' ORDER BY node_code, subject_id
  `).all(entityId);
  return rows.map((row) => String(row.node_code));
}

async function nodeRows(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  entityId: string,
  nodeCode: string,
): Promise<Row[]> {
  return database.prepare<Row>(`
    SELECT * FROM workflow_tasks
    WHERE entity_id = ? AND node_code = ? ORDER BY created_at, id
  `).all(entityId, nodeCode);
}

test("新自驾订单完整进入督办，历史订单不补任务，预检至报告完成逐节点换责", async () => {
  const database = await createTestDatabase("workflow_annual_sync");
  try {
    const booking = await database.prepare<Row>("SELECT * FROM bookings WHERE id = 'booking-op-1'").get();
    assert.ok(booking);
    const now = new Date("2026-09-05T01:00:00.000Z");
    await database.prepare(`
      UPDATE bookings SET status = 'confirmed', fulfillment_status = 'pending_payment', updated_at = ? WHERE id = ?
    `).run(now.toISOString(), String(booking.id));

    const historicalSync = await syncAnnualWorkflowForBooking(database, String(booking.id), { now });
    assert.equal(historicalSync.enabled, false);
    assert.equal(Number((await database.prepare<Row>("SELECT COUNT(*) AS count FROM workflow_tasks").get())?.count), 0);

    const enabled = await enableAnnualWorkflowForBooking(database, String(booking.id), { now });
    assert.equal(enabled.enabled, true);
    assert.deepEqual(enabled.opened.map((task) => task.nodeCode), ["annual.pending_payment"]);

    await database.prepare(`
      UPDATE bookings SET payment_status = 'paid', fulfillment_status = 'pending_precheck', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 60_000).toISOString(), String(booking.id));
    const precheck = await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 60_000), actorType: "system",
    });
    assert.equal(precheck.closed, 1);
    assert.deepEqual(precheck.opened.map((task) => task.nodeCode), ["annual.precheck.pending"]);
    assert.equal(precheck.opened[0].subject?.type, "inspection_station");

    await database.prepare(`
      UPDATE bookings SET fulfillment_status = 'precheck_action_required', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 120_000).toISOString(), String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 120_000), actorType: "operator",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.precheck.action_required"]);

    await database.prepare(`
      UPDATE bookings SET fulfillment_status = 'pending_precheck', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 180_000).toISOString(), String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 180_000), actorType: "owner",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.precheck.pending"]);
    assert.equal((await nodeRows(database, String(booking.id), "annual.precheck.pending")).length, 2);

    await database.prepare(`
      UPDATE bookings SET status = 'confirmed', fulfillment_status = 'confirmed',
        appointment_date = '2026-09-10', start_time = '10:00', end_time = '11:00', updated_at = ?
      WHERE id = ?
    `).run(new Date(now.getTime() + 240_000).toISOString(), String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 240_000), actorType: "operator",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.arrival.owner"]);

    await database.prepare(`
      UPDATE bookings SET status = 'checked_in', fulfillment_status = 'checked_in', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 300_000).toISOString(), String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 300_000), actorType: "operator",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.inspection.start"]);

    await database.prepare(`
      UPDATE bookings SET status = 'inspecting', fulfillment_status = 'inspecting', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 360_000).toISOString(), String(booking.id));
    const inspecting = await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 360_000), actorType: "operator",
    });
    assert.deepEqual(inspecting.opened.map((task) => task.nodeCode), ["annual.inspection.report"]);
    assert.equal(inspecting.opened[0].subject?.type, "inspection_station");
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.inspection.report"]);
    assert.equal((await nodeRows(database, String(booking.id), "annual.inspection.start")).length, 1);
    assert.equal((await nodeRows(database, String(booking.id), "annual.inspection.report")).length, 1);
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 360_000), actorType: "operator",
    });
    assert.equal((await nodeRows(database, String(booking.id), "annual.inspection.report")).length, 1);

    const reportId = randomUUID();
    const completedAt = new Date(now.getTime() + 420_000).toISOString();
    await database.prepare(`
      INSERT INTO vehicle_checkup_reports (
        id, booking_id, report_no, status, observation_mode, annual_conclusion,
        annual_mark_status, summary_json, vehicle_snapshot_json, station_snapshot_json,
        created_at, updated_at, published_at
      ) VALUES (?, ?, ?, 'published', 'no_visible_faults', 'passed', 'issued',
        '{}', '{}', '{}', ?, ?, ?)
    `).run(reportId, String(booking.id), `YXM-WF-${randomUUID()}`, completedAt, completedAt, completedAt);
    await database.prepare(`
      UPDATE bookings SET status = 'completed', fulfillment_status = 'completed',
        completed_at = ?, updated_at = ? WHERE id = ?
    `).run(completedAt, completedAt, String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(completedAt), actorType: "operator",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), []);
    assert.equal((await nodeRows(database, String(booking.id), "annual.report.ready")).length, 1);
    assert.equal((await nodeRows(database, String(booking.id), "annual.service.completed")).length, 1);

    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(completedAt), actorType: "operator",
    });
    assert.equal((await nodeRows(database, String(booking.id), "annual.report.ready")).length, 1);
    assert.equal((await nodeRows(database, String(booking.id), "annual.service.completed")).length, 1);
  } finally {
    await database.close();
  }
});

test("代驾换派重开领取节点，兑换后换责为司机取车留证并在五图完成后交给检测站", async () => {
  const database = await createTestDatabase("workflow_driver_sync");
  try {
    const now = new Date("2026-09-05T01:00:00.000Z");
    const booking = await database.prepare<Row>("SELECT * FROM bookings WHERE id = 'booking-op-2'").get();
    assert.ok(booking);
    await database.prepare(`
      UPDATE bookings SET service_mode = 'valet', status = 'confirmed', fulfillment_status = 'confirmed',
        appointment_date = '2026-09-10', start_time = '10:00', end_time = '11:00', updated_at = ?
      WHERE id = ?
    `).run(now.toISOString(), String(booking.id));
    await enableAnnualWorkflowForBooking(database, String(booking.id), { now });
    await database.prepare(`
      INSERT INTO valet_driver_assignments (
        id, booking_id, driver_name, driver_phone, status, assigned_at, updated_at
      ) VALUES (?, ?, '测试司机', '13800138009', 'assigned', ?, ?)
    `).run("workflow-driver-assignment", String(booking.id), now.toISOString(), now.toISOString());
    await database.prepare(`
      UPDATE bookings SET fulfillment_status = 'driver_arranged', updated_at = ? WHERE id = ?
    `).run(now.toISOString(), String(booking.id));

    const assigned = await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now,
      verificationCode: "246810",
      actorType: "operator",
    });
    assert.deepEqual(new Set(assigned.opened.map((task) => task.nodeCode)), new Set([
      "annual.driver.claim", "annual.pickup.owner",
    ]));
    const claim = assigned.opened.find((task) => task.nodeCode === "annual.driver.claim")!;
    assert.equal(claim.maxReminders, 3);
    assert.equal(JSON.stringify(claim).includes("246810"), false);

    const reassigned = await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 15_000),
      verificationCode: "135790",
      forceReopenNodeCodes: ["annual.driver.claim"],
      actorType: "operator",
    });
    assert.ok(reassigned.closed >= 1);
    assert.equal((await nodeRows(database, String(booking.id), "annual.driver.claim")).length, 2);
    assert.equal((await nodeRows(database, String(booking.id), "annual.driver.claim"))
      .filter((row) => row.status === "open").length, 1);

    // A rescheduled appointment must reissue an informational pickup notice,
    // even when the previous notice already completed after durable queueing.
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 20_000),
      forceReopenNodeCodes: ["annual.pickup.owner"],
      actorType: "operator",
    });
    assert.equal((await nodeRows(database, String(booking.id), "annual.pickup.owner")).length, 2);

    const claimedAt = new Date(now.getTime() + 30_000).toISOString();
    await database.prepare(`
      UPDATE valet_driver_assignments
      SET task_code_consumed_at = ?, bound_user_id = 'demo-user', status = 'bound', updated_at = ?
      WHERE id = ?
    `).run(claimedAt, claimedAt, "workflow-driver-assignment");
    const exchanged = await acknowledgeAnnualDriverClaim(database, String(booking.id), {
      now: new Date(now.getTime() + 30_000), actorType: "driver",
    });
    assert.equal(exchanged.closed, 1);
    const open = await database.prepare<Row>(`
      SELECT node_code FROM workflow_tasks WHERE entity_id = ? AND status = 'open' ORDER BY node_code
    `).all(String(booking.id));
    assert.deepEqual(open.map((row) => row.node_code), ["annual.pickup.driver", "annual.pickup.owner"]);
    assert.equal(exchanged.opened.some((task) => task.nodeCode === "annual.pickup.driver"), true);
    const pickupTask = (await nodeRows(database, String(booking.id), "annual.pickup.driver"))[0];
    assert.equal(pickupTask.subject_type, "driver_assignment");
    assert.equal(pickupTask.subject_id, "workflow-driver-assignment");
    assert.equal(pickupTask.recipient_user_id, "demo-user");
    assert.equal(pickupTask.due_at, new Date(now.getTime() + 60 * 60_000 + 30_000).toISOString());
    assert.match(String(pickupTask.template_bindings_snapshot_json), /annual\.pickup\.evidence\.driver/u);
    assert.doesNotMatch(String(pickupTask.template_bindings_snapshot_json), /verificationCode/u);

    // Notes, fee adjustments and other ordinary writes can synchronize the
    // same driver_arranged state again. A consumed one-time task must remain
    // closed unless an operator explicitly reassigns the driver with a new code.
    const sameState = await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 45_000), actorType: "operator",
    });
    assert.equal(sameState.opened.some((task) => task.nodeCode === "annual.driver.claim"), false);
    assert.equal((await nodeRows(database, String(booking.id), "annual.driver.claim")).length, 2);
    assert.equal((await nodeRows(database, String(booking.id), "annual.driver.claim"))
      .filter((row) => row.status === "open").length, 0);
    assert.equal((await nodeRows(database, String(booking.id), "annual.pickup.driver")).length, 1,
      "同状态同步不能重复创建司机取车任务");

    await database.prepare(`
      UPDATE bookings SET status = 'awaiting_arrival', fulfillment_status = 'picked_up', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 60_000).toISOString(), String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 60_000), actorType: "driver",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.station.arrival"]);
    assert.equal((await nodeRows(database, String(booking.id), "annual.pickup.driver"))
      .filter((row) => row.status === "open").length, 0);
    assert.equal((await nodeRows(database, String(booking.id), "annual.station.arrival")).length, 1);

    await database.prepare(`
      UPDATE bookings SET status = 'checked_in', fulfillment_status = 'checked_in', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 120_000).toISOString(), String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 120_000), actorType: "operator",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.inspection.start"]);

    await database.prepare(`
      UPDATE bookings SET status = 'inspecting', fulfillment_status = 'inspecting', updated_at = ? WHERE id = ?
    `).run(new Date(now.getTime() + 180_000).toISOString(), String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 180_000), actorType: "operator",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.inspection.report"]);
    assert.equal((await nodeRows(database, String(booking.id), "annual.inspection.start")).length, 1);
    assert.equal((await nodeRows(database, String(booking.id), "annual.inspection.report")).length, 1);
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 180_000), actorType: "operator",
    });
    assert.equal((await nodeRows(database, String(booking.id), "annual.inspection.report")).length, 1);

    const reportAt = new Date(now.getTime() + 240_000).toISOString();
    await database.prepare(`
      INSERT INTO vehicle_checkup_reports (
        id, booking_id, report_no, status, observation_mode, annual_conclusion,
        annual_mark_status, summary_json, vehicle_snapshot_json, station_snapshot_json,
        created_at, updated_at, published_at
      ) VALUES (?, ?, ?, 'published', 'no_visible_faults', 'passed', 'issued',
        '{}', '{}', '{}', ?, ?, ?)
    `).run(randomUUID(), String(booking.id), `YXM-WF-${randomUUID()}`, reportAt, reportAt, reportAt);
    await database.prepare(`
      UPDATE bookings SET status = 'result_received', fulfillment_status = 'result_received', updated_at = ? WHERE id = ?
    `).run(reportAt, String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(reportAt), actorType: "operator",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.return.driver"]);
    assert.equal((await nodeRows(database, String(booking.id), "annual.report.ready")).length, 1);

    const returnAt = new Date(now.getTime() + 300_000).toISOString();
    await database.prepare(`
      UPDATE bookings SET fulfillment_status = 'returning', updated_at = ? WHERE id = ?
    `).run(returnAt, String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(returnAt), actorType: "driver",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), ["annual.return.delivery"]);

    const returnedAt = new Date(now.getTime() + 360_000).toISOString();
    await database.prepare(`
      UPDATE bookings SET status = 'completed', fulfillment_status = 'completed',
        completed_at = ?, updated_at = ? WHERE id = ?
    `).run(returnedAt, returnedAt, String(booking.id));
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(returnedAt), actorType: "driver",
    });
    assert.deepEqual(await openNodes(database, String(booking.id)), []);
    assert.equal((await nodeRows(database, String(booking.id), "annual.report.ready")).length, 1);
    assert.equal((await nodeRows(database, String(booking.id), "annual.service.completed")).length, 1);
  } finally {
    await database.close();
  }
});

test("升级异常在来源任务仍开放时不被同状态同步误关，来源关闭后自动收口", async () => {
  const database = await createTestDatabase("workflow_exception_sync");
  try {
    const now = new Date("2026-09-05T03:00:00.000Z");
    const booking = await database.prepare<Row>("SELECT * FROM bookings WHERE id = 'booking-op-1'").get();
    assert.ok(booking);
    await database.prepare(`
      UPDATE bookings SET payment_status = 'paid', fulfillment_status = 'pending_precheck', updated_at = ?
      WHERE id = ?
    `).run(now.toISOString(), String(booking.id));
    await enableAnnualWorkflowForBooking(database, String(booking.id), { now });
    const source = (await nodeRows(database, String(booking.id), "annual.precheck.pending"))[0];
    assert.ok(source?.id);
    await database.prepare(`
      UPDATE workflow_tasks
      SET first_reminder_at = NULL, next_reminder_at = NULL, due_at = ?, escalate_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      new Date(now.getTime() - 10 * 60_000).toISOString(),
      new Date(now.getTime() - 5 * 60_000).toISOString(),
      now.toISOString(),
      String(source.id),
    );

    await runWorkflowWorkerOnce(database, { now, outboxLimit: 0 });
    const exception = (await nodeRows(database, String(booking.id), "workflow.exception"))[0];
    assert.equal(exception?.status, "open");
    assert.equal(JSON.parse(String(exception?.metadata_json)).sourceTaskId, source.id);

    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 1_000), actorType: "operator",
    });
    assert.equal((await nodeRows(database, String(booking.id), "workflow.exception"))[0]?.status, "open");

    await closeWorkflowTasks(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: String(booking.id),
      nodeCodes: ["annual.precheck.pending"],
      reason: "source_resolved_for_test",
      actorType: "operator",
    }, { now: new Date(now.getTime() + 2_000) });
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 3_000), actorType: "operator",
    });
    const exceptionAfterSourceClose = (await nodeRows(database, String(booking.id), "workflow.exception"))[0];
    assert.equal(exceptionAfterSourceClose?.status, "completed");
    assert.equal(exceptionAfterSourceClose?.closed_reason, "business_state_synchronized");
    assert.equal((await nodeRows(database, String(booking.id), "annual.precheck.pending"))
      .filter((row) => row.status === "open").length, 1);
  } finally {
    await database.close();
  }
});

test("同节点按主体精确对账，多个来源异常互不覆盖且只随各自来源收口", async () => {
  const database = await createTestDatabase("workflow_composite_identity");
  try {
    const now = new Date("2026-09-05T04:00:00.000Z");
    const booking = await database.prepare<Row>("SELECT * FROM bookings WHERE id = 'booking-op-1'").get();
    assert.ok(booking);
    await database.prepare(`
      UPDATE bookings SET payment_status = 'paid', fulfillment_status = 'pending_precheck', updated_at = ?
      WHERE id = ?
    `).run(now.toISOString(), String(booking.id));
    await enableAnnualWorkflowForBooking(database, String(booking.id), { now });
    const canonicalSource = (await nodeRows(database, String(booking.id), "annual.precheck.pending"))[0];
    assert.ok(canonicalSource?.id);

    const extraSource = (await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: String(booking.id),
      open: [{
        nodeCode: "annual.precheck.pending",
        subjectType: "inspection_station",
        subjectId: "other-station-for-reconciliation",
        assigneeRole: "station",
      }],
    }, { now: new Date(now.getTime() + 1_000) })).opened[0];
    assert.ok(extraSource?.id);

    const exceptions = (await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: String(booking.id),
      open: [canonicalSource, extraSource].map((source) => ({
        nodeCode: "workflow.exception",
        subjectType: "platform_duty",
        subjectId: null,
        assigneeRole: "platform",
        metadata: { sourceTaskId: source.id, escalationLevel: "platform_l1" },
      })),
    }, { now: new Date(now.getTime() + 2_000) })).opened;
    assert.equal(exceptions.length, 2);
    assert.deepEqual(new Set(exceptions.map((task) => task.subject?.id)), new Set([
      canonicalSource.id,
      extraSource.id,
    ]));

    // Exact-id resolution must not close the sibling exception for this order.
    await closeWorkflowTasks(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: String(booking.id),
      taskIds: [exceptions[1].id],
      reason: "one_source_manually_resolved",
      actorType: "platform",
    }, { now: new Date(now.getTime() + 3_000) });
    assert.equal((await database.prepare<Row>("SELECT status FROM workflow_tasks WHERE id = ?").get(exceptions[0].id))?.status, "open");
    assert.equal((await database.prepare<Row>("SELECT status FROM workflow_tasks WHERE id = ?").get(exceptions[1].id))?.status, "completed");

    const recreatedExtraException = (await applyWorkflowTransition(database, {
      domain: "annual_inspection",
      entityType: "booking",
      entityId: String(booking.id),
      open: [{
        nodeCode: "workflow.exception",
        subjectType: "platform_duty",
        subjectId: null,
        assigneeRole: "platform",
        metadata: { sourceTaskId: extraSource.id, escalationLevel: "platform_l1" },
      }],
    }, { now: new Date(now.getTime() + 4_000) })).opened[0];
    assert.ok(recreatedExtraException?.id);

    // One synchronization pass atomically removes the noncanonical station
    // source and only that source's platform exception.
    await syncAnnualWorkflowForBooking(database, String(booking.id), {
      now: new Date(now.getTime() + 5_000), actorType: "operator",
    });
    assert.equal((await database.prepare<Row>("SELECT status FROM workflow_tasks WHERE id = ?").get(String(canonicalSource.id)))?.status, "open");
    assert.equal((await database.prepare<Row>("SELECT status FROM workflow_tasks WHERE id = ?").get(extraSource.id))?.status, "completed");
    assert.equal((await database.prepare<Row>("SELECT status FROM workflow_tasks WHERE id = ?").get(exceptions[0].id))?.status, "open");
    assert.equal((await database.prepare<Row>("SELECT status FROM workflow_tasks WHERE id = ?").get(recreatedExtraException.id))?.status, "completed");
  } finally {
    await database.close();
  }
});

test("维修首份报价全局去重，最后一份撤回恢复 SLA，选店支付只通知中选门店一次", async () => {
  const database = await createTestDatabase("workflow_repair_sync");
  try {
    const source = await database.prepare<Row>("SELECT * FROM bookings WHERE id = 'booking-op-1'").get();
    assert.ok(source);
    const now = new Date("2026-09-05T01:00:00.000Z");
    const requestId = randomUUID();
    await database.prepare(`
      INSERT INTO repair_requests (
        id, request_no, user_id, source_report_id, source_booking_id, source_vehicle_id,
        status, vehicle_snapshot_json, report_snapshot_json, synthetic_owner_contact_json,
        selected_quote_id, created_at, updated_at, source_type, source_precheck_version
      ) VALUES (?, ?, ?, NULL, ?, ?, 'open', ?, '{}', ?, NULL, ?, ?, 'precheck', 1)
    `).run(
      requestId, "WX-WORKFLOW-TEST", String(source.user_id), String(source.id), String(source.vehicle_id),
      JSON.stringify({ plateNumber: "津A12345" }),
      JSON.stringify({ name: "测试车主", phone: "13800138008" }),
      now.toISOString(), now.toISOString(),
    );
    assert.equal((await syncRepairWorkflowForRequest(database, requestId, { now })).enabled, false);
    await enableRepairWorkflowForRequest(database, requestId, { now });
    const activeShops = Number((await database.prepare<Row>(`
      SELECT COUNT(*) AS count FROM repair_shops WHERE is_active = 1
    `).get())?.count);
    const firstSla = await database.prepare<Row>(`
      SELECT subject_type, subject_id FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'repair.quote.first' AND status = 'open'
    `).all(requestId);
    assert.equal(firstSla.length, activeShops);
    assert.ok(firstSla.every((row) => row.subject_type === "repair_shop" && row.subject_id));

    const shopId = String(firstSla[0].subject_id);
    const quoteId = randomUUID();
    await database.prepare(`
      INSERT INTO repair_quotes (
        id, request_id, shop_id, total_price_fen, note, status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 88000, '测试报价', 'active', 1, ?, ?)
    `).run(quoteId, requestId, shopId, now.toISOString(), now.toISOString());
    const quoted = await syncRepairWorkflowForRequest(database, requestId, {
      now: new Date(now.getTime() + 60_000), actorType: "repair_shop", actorId: shopId,
    });
    assert.ok(quoted.closed >= activeShops);
    assert.deepEqual(quoted.opened.map((task) => task.nodeCode), ["repair.quote.owner_action"]);
    assert.equal(Number((await database.prepare<Row>(`
      SELECT COUNT(*) AS count FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'repair.quote.first' AND status = 'open'
    `).get(requestId))?.count), 0);

    const duplicateSync = await syncRepairWorkflowForRequest(database, requestId, {
      now: new Date(now.getTime() + 90_000), actorType: "repair_shop", actorId: shopId,
    });
    assert.equal(duplicateSync.closed, 0);
    assert.equal((await nodeRows(database, requestId, "repair.quote.owner_action")).length, 1);

    await database.prepare(`
      UPDATE repair_quotes SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE id = ?
    `).run(
      new Date(now.getTime() + 120_000).toISOString(),
      new Date(now.getTime() + 120_000).toISOString(),
      quoteId,
    );
    await syncRepairWorkflowForRequest(database, requestId, {
      now: new Date(now.getTime() + 120_000), actorType: "repair_shop", actorId: shopId,
    });
    const restored = await database.prepare<Row>(`
      SELECT subject_id FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'repair.quote.first' AND status = 'open'
      ORDER BY subject_id
    `).all(requestId);
    assert.equal(restored.length, activeShops);
    assert.ok(restored.every((row) => row.subject_id));

    const selectedShopId = String(restored.find((row) => String(row.subject_id) !== shopId)?.subject_id ?? shopId);
    const selectedQuoteId = randomUUID();
    const secondQuoteAt = new Date(now.getTime() + 180_000).toISOString();
    await database.prepare(`
      INSERT INTO repair_quotes (
        id, request_id, shop_id, total_price_fen, note, status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 99000, '二次测试报价', 'active', 1, ?, ?)
    `).run(selectedQuoteId, requestId, selectedShopId, secondQuoteAt, secondQuoteAt);
    await syncRepairWorkflowForRequest(database, requestId, {
      now: new Date(secondQuoteAt), actorType: "repair_shop", actorId: selectedShopId,
    });
    assert.deepEqual(await openNodes(database, requestId), ["repair.quote.owner_action"]);
    assert.equal((await nodeRows(database, requestId, "repair.quote.owner_action")).length, 2);

    const paidAt = new Date(now.getTime() + 240_000).toISOString();
    await database.prepare(`
      UPDATE repair_quotes SET status = 'selected', selected_at = ?, updated_at = ? WHERE id = ?
    `).run(paidAt, paidAt, selectedQuoteId);
    await database.prepare(`
      UPDATE repair_quotes SET status = 'lost', updated_at = ? WHERE request_id = ? AND id <> ?
    `).run(paidAt, requestId, selectedQuoteId);
    await database.prepare(`
      UPDATE repair_requests SET status = 'paid', selected_quote_id = ?, paid_at = ?, updated_at = ? WHERE id = ?
    `).run(selectedQuoteId, paidAt, paidAt, requestId);
    await syncRepairWorkflowForRequest(database, requestId, {
      now: new Date(paidAt), actorType: "owner", actorId: String(source.user_id),
    });
    assert.deepEqual(await openNodes(database, requestId), ["repair.order.selected"]);
    const selectedTasks = await nodeRows(database, requestId, "repair.order.selected");
    assert.equal(selectedTasks.length, 1);
    assert.equal(selectedTasks[0].subject_id, selectedShopId);

    await syncRepairWorkflowForRequest(database, requestId, {
      now: new Date(paidAt), actorType: "owner", actorId: String(source.user_id),
    });
    assert.equal((await nodeRows(database, requestId, "repair.order.selected")).length, 1);
  } finally {
    await database.close();
  }
});
