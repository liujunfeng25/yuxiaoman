import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createDevelopmentSession } from "../auth.js";
import { buildApp } from "../app.js";
import { hashBackofficePassword } from "../backoffice.js";
import type { Database } from "../db.js";
import { clearRepairData, DEMO_REPAIR_SHOPS } from "../repair-db.js";
import { createTestDatabase } from "./test-database.js";

process.env.NODE_ENV = "test";
process.env.YUXIAOMAN_ENV = "test";
process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "false";

type Json = Record<string, any>;

type Fixture = {
  app: FastifyInstance;
  database: Database;
  uploadDir: string;
  close: () => Promise<void>;
};

async function fixture(prefix: string): Promise<Fixture> {
  const database = await createTestDatabase(prefix);
  const privateRoot = mkdtempSync(join(tmpdir(), "yuxiaoman-repair-"));
  const uploadDir = join(privateRoot, "uploads");
  const app = await buildApp({
    database,
    uploadDir,
    insuranceUploadDir: join(privateRoot, "insurance"),
    subsidyConsultationUploadDir: join(privateRoot, "subsidy"),
  });
  await app.ready();
  return {
    app,
    database,
    uploadDir,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(privateRoot, { recursive: true, force: true });
    },
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function count(database: Database, table: string, where = "", parameters: unknown[] = []): Promise<number> {
  const row = await database.prepare<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`,
  ).get(...parameters as Array<string | number | null>);
  return Number(row?.count ?? 0);
}

async function seedSourceReport(
  fixtureValue: Fixture,
  userId: string,
  suffix: string,
  options: {
    status?: "draft" | "published";
    faultCount?: number;
    includeFixedPhoto?: boolean;
    summary?: Record<string, unknown>;
  } = {},
) {
  const { database, uploadDir } = fixtureValue;
  const status = options.status ?? "published";
  const faultCount = options.faultCount ?? 1;
  const now = "2026-08-24T08:00:00.000Z";
  const vehicleId = `repair-vehicle-${suffix}`;
  const bookingId = `repair-booking-${suffix}`;
  const reportId = `repair-report-${suffix}`;
  const slot = await database.prepare<{ id: string; station_id: string; date: string; start_time: string; end_time: string }>(`
    SELECT id, station_id, date, start_time, end_time FROM station_slots ORDER BY id LIMIT 1
  `).get();
  assert.ok(slot);
  const plate = `津A·R${suffix.slice(-4).padStart(4, "0")}`;
  const normalizedPlate = plate.replace("·", "");
  const vehicleSnapshot = {
    id: vehicleId,
    plateNumber: plate,
    vehicleType: "小型轿车",
    brand: { name: "演示品牌" },
    model: { name: `演示车型${suffix}` },
  };
  await database.prepare(`
    INSERT INTO vehicles (
      id, user_id, plate_number, plate_normalized, vehicle_type, usage_nature,
      seats, registration_date, inspection_due_date, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '小型轿车', '非营运', 5, '2020-01-01', '2027-01-01', 0, ?, ?)
  `).run(vehicleId, userId, plate, normalizedPlate, now, now);
  await database.prepare(`
    INSERT INTO bookings (
      id, booking_number, user_id, vehicle_id, station_id, slot_id,
      contact_name, contact_phone, service_fee_fen, status,
      appointment_date, start_time, end_time, notes,
      created_at, updated_at, completed_at,
      vehicle_snapshot_json, station_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, '真实联系人不应共享', '13900009999', 26000,
      'completed', ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    bookingId,
    `REPAIR-BOOKING-${suffix}`,
    userId,
    vehicleId,
    slot.station_id,
    slot.id,
    slot.date,
    slot.start_time,
    slot.end_time,
    now,
    now,
    now,
    JSON.stringify(vehicleSnapshot),
    JSON.stringify({ id: slot.station_id, name: "检测站（演示）" }),
  );
  await database.prepare(`
    INSERT INTO vehicle_checkup_reports (
      id, booking_id, report_no, schema_version, status, observation_mode,
      diagram_version, annual_conclusion, annual_mark_status, summary_json,
      vehicle_snapshot_json, station_snapshot_json, row_version,
      created_at, updated_at, published_at, retain_until
    ) VALUES (?, ?, ?, 'vehicle-checkup-v2', ?, 'faults_recorded',
      'sedan-3view-v1', 'passed', 'issued', ?, ?, ?, 2, ?, ?, ?, ?)
  `).run(
    reportId,
    bookingId,
    `YXM-CHK-20260824-${suffix.padStart(8, "0").toUpperCase()}`,
    status,
    JSON.stringify(options.summary ?? { conclusionLabel: "检验合格", sourceVersion: suffix }),
    JSON.stringify(vehicleSnapshot),
    JSON.stringify({ id: slot.station_id, name: "检测站（演示）" }),
    now,
    now,
    status === "published" ? now : null,
    status === "published" ? "2032-08-24T08:00:00.000Z" : null,
  );

  const mediaIds: string[] = [];
  mkdirSync(join(uploadDir, "vehicle-checkup"), { recursive: true });
  for (let index = 0; index < faultCount; index += 1) {
    const faultId = `source-fault-${suffix}-${index + 1}`;
    await database.prepare(`
      INSERT INTO vehicle_checkup_faults (
        id, report_id, client_key, sequence_no, view_id, region_code,
        fault_type, severity, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'left', ?, 'scratch', ?, ?, ?, ?)
    `).run(
      faultId,
      reportId,
      `client-${suffix}-${index + 1}`,
      index + 1,
      index === 0 ? "left_front_door" : "left_rear_door",
      index === 0 ? "moderate" : "minor",
      `冻结前故障描述 ${index + 1}`,
      now,
      now,
    );
    const mediaId = `source-media-${suffix}-${index + 1}`;
    const storageKey = `${mediaId}.jpg`;
    writeFileSync(join(uploadDir, "vehicle-checkup", storageKey), Buffer.from(`synthetic-${mediaId}`));
    await database.prepare(`
      INSERT INTO vehicle_checkup_media (
        id, booking_id, report_id, kind, fault_id, sequence_no, status,
        storage_key, mime_type, size_bytes, width, height, sha256,
        created_at, bound_at, expires_at
      ) VALUES (?, ?, ?, 'fault_closeup', ?, 1, 'bound', ?, 'image/jpeg', 20, 640, 480, ?, ?, ?, ?)
    `).run(mediaId, bookingId, reportId, faultId, storageKey, `hash-${mediaId}`, now, now, "2032-08-24T08:00:00.000Z");
    mediaIds.push(mediaId);
  }

  if (options.includeFixedPhoto) {
    const mediaId = `source-fixed-${suffix}`;
    const storageKey = `${mediaId}.jpg`;
    writeFileSync(join(uploadDir, "vehicle-checkup", storageKey), Buffer.from("fixed-photo-must-not-leak"));
    await database.prepare(`
      INSERT INTO vehicle_checkup_media (
        id, booking_id, report_id, kind, fault_id, sequence_no, status,
        storage_key, mime_type, size_bytes, width, height, sha256,
        created_at, bound_at, expires_at
      ) VALUES (?, ?, ?, 'front_left', NULL, NULL, 'bound', ?, 'image/jpeg', 25, 640, 480, ?, ?, ?, ?)
    `).run(mediaId, bookingId, reportId, storageKey, `hash-${mediaId}`, now, now, "2032-08-24T08:00:00.000Z");
  }
  return { vehicleId, bookingId, reportId, plate, mediaIds };
}

async function createRepairRequest(app: FastifyInstance, token: string, reportId: string) {
  return app.inject({
    method: "POST",
    url: "/api/repair/requests",
    headers: bearer(token),
    payload: { reportId },
  });
}

async function submitQuote(
  app: FastifyInstance,
  token: string,
  requestId: string,
  totalPriceFen: number,
  note: string,
) {
  return app.inject({
    method: "PUT",
    url: `/api/repair-operator/requests/${requestId}/quote`,
    headers: bearer(token),
    payload: { totalPriceFen, note },
  });
}

async function createRepairSession(
  app: FastifyInstance,
  database: Database,
  shopId: string,
  suffix: string,
): Promise<{ accountId: string; token: string }> {
  const accountId = randomUUID();
  const loginName = `repair-test-${suffix}-${randomUUID().slice(0, 8)}`;
  const password = `repair test ${suffix} password 2026`;
  const passwordHash = await hashBackofficePassword(password);
  const now = new Date().toISOString();
  await database.prepare(`
    INSERT INTO backoffice_accounts (
      id, login_name, login_name_normalized, display_name, password_hash,
      role, status, permission_version, last_login_at, created_at, updated_at, disabled_at
    ) VALUES (?, ?, ?, ?, ?, 'repair_shop_admin', 'active', 1, NULL,
      ?::timestamptz, ?::timestamptz, NULL)
  `).run(accountId, loginName, loginName.toLowerCase(), `维修管理员 ${suffix}`, passwordHash, now, now);
  await database.prepare(`
    INSERT INTO backoffice_subject_assignments (
      id, account_id, subject_type, subject_id, status, replaces_assignment_id,
      created_at, activated_at, revoked_at
    ) VALUES (?, ?, 'repair_shop', ?, 'active', NULL, ?::timestamptz, ?::timestamptz, NULL)
  `).run(randomUUID(), accountId, shopId, now, now);
  const response = await app.inject({
    method: "POST",
    url: "/api/repair-operator/sessions",
    payload: { loginName, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json<Json>().data;
  assert.equal(data.account.role, "repair_shop_admin");
  assert.equal(data.subject.id, shopId);
  assert.ok(String(data.token).startsWith("yxm_bo_"));
  return { accountId, token: String(data.token) };
}

async function createRepairSessions(app: FastifyInstance, database: Database) {
  return Promise.all(DEMO_REPAIR_SHOPS.map((shop, index) => createRepairSession(
    app,
    database,
    shop.id,
    String(index + 1),
  )));
}

async function rejectRepairQuoteAudit(database: Database, enabled: boolean): Promise<void> {
  if (!enabled) {
    await database.execute(`
      DROP TRIGGER IF EXISTS reject_repair_quote_audit_test ON backoffice_audit_events;
      DROP FUNCTION IF EXISTS reject_repair_quote_audit_test();
    `);
    return;
  }
  await database.execute(`
    CREATE OR REPLACE FUNCTION reject_repair_quote_audit_test()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.action LIKE 'repair.quote.%' THEN
        RAISE EXCEPTION 'forced repair quote audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS reject_repair_quote_audit_test ON backoffice_audit_events;
    CREATE TRIGGER reject_repair_quote_audit_test
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_repair_quote_audit_test();
  `);
}

async function rejectRepairDeniedAudit(database: Database, enabled: boolean): Promise<void> {
  if (!enabled) {
    await database.execute(`
      DROP TRIGGER IF EXISTS reject_repair_denied_audit_test ON backoffice_audit_events;
      DROP FUNCTION IF EXISTS reject_repair_denied_audit_test();
    `);
    return;
  }
  await database.execute(`
    CREATE OR REPLACE FUNCTION reject_repair_denied_audit_test()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'backoffice.authorization.denied'
        AND NEW.metadata_json->>'reason' = 'repair_paid_request_wrong_shop' THEN
        RAISE EXCEPTION 'forced repair denied audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS reject_repair_denied_audit_test ON backoffice_audit_events;
    CREATE TRIGGER reject_repair_denied_audit_test
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_repair_denied_audit_test();
  `);
}

test("车主仅能从自己的已发布有故障报告创建唯一询价，并冻结最小车损快照", async () => {
  const current = await fixture("repair_owner");
  try {
    const ownerA = await createDevelopmentSession(current.database, { userId: "repair-owner-a" });
    const ownerB = await createDevelopmentSession(current.database, { userId: "repair-owner-b" });
    const published = await seedSourceReport(current, ownerA.userId, "1001", {
      faultCount: 1,
      includeFixedPhoto: true,
      summary: {
        conclusionLabel: "检验合格",
        sourceVersion: "station-extension-1001",
        contactName: "不应进入维修快照的检测员姓名",
        phone: "13900001234",
        plateNumber: "津A·SENSITIVE",
        internal: { secret: "station-private-extension" },
      },
    });
    const draft = await seedSourceReport(current, ownerA.userId, "1002", { status: "draft", faultCount: 1 });
    const zeroFault = await seedSourceReport(current, ownerA.userId, "1003", { faultCount: 0 });

    const crossOwner = await createRepairRequest(current.app, ownerB.token, published.reportId);
    assert.equal(crossOwner.statusCode, 404, crossOwner.body);
    const draftResponse = await createRepairRequest(current.app, ownerA.token, draft.reportId);
    assert.equal(draftResponse.statusCode, 409, draftResponse.body);
    assert.equal(draftResponse.json<Json>().error.code, "REPAIR_REPORT_NOT_PUBLISHED");
    const zeroResponse = await createRepairRequest(current.app, ownerA.token, zeroFault.reportId);
    assert.equal(zeroResponse.statusCode, 409, zeroResponse.body);
    assert.equal(zeroResponse.json<Json>().error.code, "REPAIR_REPORT_HAS_NO_FAULTS");

    const created = await createRepairRequest(current.app, ownerA.token, published.reportId);
    assert.equal(created.statusCode, 201, created.body);
    const detail = created.json<Json>().data;
    assert.equal(detail.status, "open");
    assert.equal(detail.vehicle.plateNumber, published.plate);
    assert.equal(detail.faults.length, 1);
    assert.equal(detail.media.length, 1);
    assert.deepEqual(detail.media.map((item: Json) => item.kind), ["fault_closeup"]);
    assert.equal(JSON.stringify(detail).includes("13900009999"), false);
    assert.equal(JSON.stringify(detail).includes("真实联系人不应共享"), false);
    assert.deepEqual(detail.report.summary, { conclusionLabel: "检验合格" });
    assert.equal(JSON.stringify(detail.report).includes("station-extension-1001"), false);
    assert.equal(JSON.stringify(detail.report).includes("13900001234"), false);
    assert.equal(JSON.stringify(detail.report).includes("津A·SENSITIVE"), false);
    const storedReportSnapshot = await current.database.prepare<{ report_snapshot_json: string }>(`
      SELECT report_snapshot_json FROM repair_requests WHERE id = ?
    `).get(detail.id);
    const storedReportText = String(storedReportSnapshot?.report_snapshot_json ?? "");
    assert.equal(storedReportText.includes("station-extension-1001"), false);
    assert.equal(storedReportText.includes("station-private-extension"), false);
    assert.equal(storedReportText.includes("13900001234"), false);
    assert.equal(await count(current.database, "repair_request_media"), 1);

    const duplicate = await createRepairRequest(current.app, ownerA.token, published.reportId);
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json<Json>().data.id, detail.id);
    assert.equal(duplicate.json<Json>().meta.created, false);
    assert.equal(await count(current.database, "repair_requests"), 1);

    await current.database.prepare("UPDATE vehicles SET plate_number = '津Z·CHANGED' WHERE id = ?")
      .run(published.vehicleId);
    await current.database.prepare("UPDATE vehicle_checkup_reports SET summary_json = '{\"changed\":true}' WHERE id = ?")
      .run(published.reportId);
    await current.database.prepare("UPDATE vehicle_checkup_faults SET description = '源报告已变化' WHERE report_id = ?")
      .run(published.reportId);
    await current.database.prepare("UPDATE vehicle_checkup_media SET size_bytes = 999 WHERE id = ?")
      .run(published.mediaIds[0]);
    const frozen = await current.app.inject({
      method: "GET",
      url: `/api/repair/requests/${detail.id}`,
      headers: bearer(ownerA.token),
    });
    assert.equal(frozen.statusCode, 200, frozen.body);
    assert.equal(frozen.json<Json>().data.vehicle.plateNumber, published.plate);
    assert.deepEqual(frozen.json<Json>().data.report.summary, { conclusionLabel: "检验合格" });
    assert.equal(frozen.json<Json>().data.faults[0].description, "冻结前故障描述 1");
    assert.equal(frozen.json<Json>().data.media[0].sizeBytes, 20);

    const forbiddenDetail = await current.app.inject({
      method: "GET",
      url: `/api/repair/requests/${detail.id}`,
      headers: bearer(ownerB.token),
    });
    assert.equal(forbiddenDetail.statusCode, 404, forbiddenDetail.body);
    const listB = await current.app.inject({ method: "GET", url: "/api/repair/requests", headers: bearer(ownerB.token) });
    assert.deepEqual(listB.json<Json>().data, []);
  } finally {
    await current.close();
  }
});

test("三家维修账号只能以固定主体查看脱敏需求和维护自己的幂等报价", async () => {
  const current = await fixture("repair_quotes");
  try {
    const owner = await createDevelopmentSession(current.database, { userId: "repair-quote-owner" });
    const sessions = await createRepairSessions(current.app, current.database);
    const source = await seedSourceReport(current, owner.userId, "2001", {
      faultCount: 2,
      summary: {
        conclusionLabel: "检测站自定义标签不应透传",
        inspectorName: "敏感检测员",
        inspectorPhone: "13812345678",
        fullPlate: "津A·R2001",
        arbitraryExtension: { privateValue: "station-extension-private" },
      },
    });
    const requestResponse = await createRepairRequest(current.app, owner.token, source.reportId);
    assert.equal(requestResponse.statusCode, 201, requestResponse.body);
    const requestId = requestResponse.json<Json>().data.id;

    const anonymous = await current.app.inject({ method: "GET", url: "/api/repair-operator/requests" });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    const removedDemoList = await current.app.inject({ method: "GET", url: "/api/demo/repair-shops" });
    assert.equal(removedDemoList.statusCode, 404, removedDemoList.body);
    const removedDemoDetail = await current.app.inject({
      method: "GET",
      url: `/api/demo/repair-shops/${DEMO_REPAIR_SHOPS[0].id}/requests/${requestId}`,
    });
    assert.equal(removedDemoDetail.statusCode, 404, removedDemoDetail.body);

    const lobby = await current.app.inject({
      method: "GET",
      url: "/api/repair-operator/requests",
      headers: bearer(sessions[0].token),
    });
    assert.equal(lobby.statusCode, 200, lobby.body);
    const lobbyItem = lobby.json<Json>().data.find((item: Json) => item.id === requestId);
    assert.ok(lobbyItem);
    assert.notEqual(lobbyItem.vehicle.plateNumberMasked, source.plate);
    assert.equal(lobbyItem.ownerContact, null);
    assert.equal(lobbyItem.faultCount, 2);
    assert.deepEqual(lobbyItem.primaryFault, {
      regionCode: "left_front_door",
      faultType: "scratch",
      severity: "moderate",
    });
    assert.equal(JSON.stringify(lobbyItem).includes("13900009999"), false);
    assert.deepEqual(lobbyItem.report.summary, { conclusionLabel: "检验合格" });
    assert.equal(JSON.stringify(lobbyItem.report).includes("敏感检测员"), false);
    assert.equal(JSON.stringify(lobbyItem.report).includes("13812345678"), false);
    assert.equal(JSON.stringify(lobbyItem.report).includes("station-extension-private"), false);

    for (const [index, shop] of DEMO_REPAIR_SHOPS.entries()) {
      const quoted = await submitQuote(
        current.app,
        sessions[index].token,
        requestId,
        shop.basePriceFen,
        shop.quoteNote,
      );
      assert.equal(quoted.statusCode, 200, quoted.body);
      assert.equal(quoted.json<Json>().data.ownQuote.totalPriceFen, shop.basePriceFen);
    }
    const quoteAuditBeforeRetry = await count(
      current.database,
      "backoffice_audit_events",
      "action LIKE 'repair.quote.%'",
    );
    const idempotent = await submitQuote(
      current.app,
      sessions[0].token,
      requestId,
      DEMO_REPAIR_SHOPS[0].basePriceFen,
      DEMO_REPAIR_SHOPS[0].quoteNote,
    );
    assert.equal(idempotent.statusCode, 200, idempotent.body);
    assert.equal(idempotent.json<Json>().data.ownQuote.revision, 1);
    assert.equal(await count(
      current.database,
      "backoffice_audit_events",
      "action LIKE 'repair.quote.%'",
    ), quoteAuditBeforeRetry);

    const updated = await submitQuote(
      current.app,
      sessions[0].token,
      requestId,
      169000,
      "调整后的合成维修范围说明",
    );
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json<Json>().data.ownQuote.revision, 2);
    assert.equal(await count(current.database, "repair_quotes", "request_id = ?", [requestId]), 3);

    const withdrawn = await current.app.inject({
      method: "DELETE",
      url: `/api/repair-operator/requests/${requestId}/quote`,
      headers: bearer(sessions[1].token),
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(withdrawn.json<Json>().data.ownQuote.status, "withdrawn");
    const withdrawnAgain = await current.app.inject({
      method: "DELETE",
      url: `/api/repair-operator/requests/${requestId}/quote`,
      headers: bearer(sessions[1].token),
    });
    assert.equal(withdrawnAgain.statusCode, 200, withdrawnAgain.body);
    assert.equal(withdrawnAgain.json<Json>().data.ownQuote.status, "withdrawn");
    const reactivated = await submitQuote(
      current.app,
      sessions[1].token,
      requestId,
      DEMO_REPAIR_SHOPS[1].basePriceFen,
      DEMO_REPAIR_SHOPS[1].quoteNote,
    );
    assert.equal(reactivated.statusCode, 200, reactivated.body);
    assert.equal(reactivated.json<Json>().data.ownQuote.status, "active");
    assert.equal(reactivated.json<Json>().data.ownQuote.revision, 2);

    const ownerDetail = await current.app.inject({
      method: "GET",
      url: `/api/repair/requests/${requestId}`,
      headers: bearer(owner.token),
    });
    assert.equal(ownerDetail.statusCode, 200, ownerDetail.body);
    assert.deepEqual(ownerDetail.json<Json>().data.quotes.map((quote: Json) => quote.totalPriceFen), [169000, 198000, 235000]);
    assert.equal(JSON.stringify(ownerDetail.json<Json>().data.quotes).includes("contactPhone"), false);
    assert.equal(JSON.stringify(ownerDetail.json<Json>().data.quotes).includes("address"), false);

    const firstView = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}`,
      headers: bearer(sessions[0].token),
    });
    const secondView = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}`,
      headers: bearer(sessions[1].token),
    });
    assert.equal(firstView.statusCode, 200, firstView.body);
    assert.equal(secondView.statusCode, 200, secondView.body);
    assert.equal(firstView.json<Json>().data.ownQuote.totalPriceFen, 169000);
    assert.equal(secondView.json<Json>().data.ownQuote.totalPriceFen, 198000);
    assert.equal(JSON.stringify(firstView.json<Json>().data).includes(DEMO_REPAIR_SHOPS[1].quoteNote), false);
    assert.equal(JSON.stringify(secondView.json<Json>().data).includes("调整后的合成维修范围说明"), false);
    assert.deepEqual(firstView.json<Json>().data.report.summary, { conclusionLabel: "检验合格" });
    assert.equal(JSON.stringify(firstView.json<Json>().data.report).includes("敏感检测员"), false);

    const audits = await current.database.prepare<Json>(`
      SELECT action, before_json::text, after_json::text, metadata_json::text
      FROM backoffice_audit_events
      WHERE action LIKE 'repair.quote.%'
      ORDER BY occurred_at, id
    `).all();
    assert.equal(audits.filter((row) => row.action === "repair.quote.create").length, 3);
    assert.equal(audits.filter((row) => row.action === "repair.quote.update").length, 2);
    assert.equal(audits.filter((row) => row.action === "repair.quote.delete").length, 1);
    const auditText = JSON.stringify(audits);
    assert.equal(auditText.includes(DEMO_REPAIR_SHOPS[0].quoteNote), false);
    assert.equal(auditText.includes("调整后的合成维修范围说明"), false);
  } finally {
    await current.close();
  }
});

test("维修报价审计写入失败时新增、修改和撤回均整体回滚", async () => {
  const current = await fixture("repair_quote_audit_atomicity");
  try {
    const owner = await createDevelopmentSession(current.database, { userId: "repair-audit-owner" });
    const session = await createRepairSession(
      current.app,
      current.database,
      DEMO_REPAIR_SHOPS[0].id,
      "audit",
    );
    const source = await seedSourceReport(current, owner.userId, "2501", { faultCount: 1 });
    const requestId = (await createRepairRequest(current.app, owner.token, source.reportId)).json<Json>().data.id;

    await rejectRepairQuoteAudit(current.database, true);
    const createFailure = await submitQuote(
      current.app,
      session.token,
      requestId,
      168000,
      "审计失败时不得新增报价",
    );
    assert.equal(createFailure.statusCode, 500, createFailure.body);
    assert.equal(await count(current.database, "repair_quotes", "request_id = ?", [requestId]), 0);

    await rejectRepairQuoteAudit(current.database, false);
    const created = await submitQuote(
      current.app,
      session.token,
      requestId,
      168000,
      "原始报价范围",
    );
    assert.equal(created.statusCode, 200, created.body);
    const quoteId = created.json<Json>().data.ownQuote.id;

    await rejectRepairQuoteAudit(current.database, true);
    const updateFailure = await submitQuote(
      current.app,
      session.token,
      requestId,
      188000,
      "修改后的报价范围",
    );
    assert.equal(updateFailure.statusCode, 500, updateFailure.body);
    let persisted = await current.database.prepare<Json>(`
      SELECT total_price_fen, note, status, revision FROM repair_quotes WHERE id = ?
    `).get(quoteId);
    assert.deepEqual(persisted, {
      total_price_fen: 168000,
      note: "原始报价范围",
      status: "active",
      revision: 1,
    });

    const deleteFailure = await current.app.inject({
      method: "DELETE",
      url: `/api/repair-operator/requests/${requestId}/quote`,
      headers: bearer(session.token),
    });
    assert.equal(deleteFailure.statusCode, 500, deleteFailure.body);
    persisted = await current.database.prepare<Json>(`
      SELECT total_price_fen, note, status, revision FROM repair_quotes WHERE id = ?
    `).get(quoteId);
    assert.deepEqual(persisted, {
      total_price_fen: 168000,
      note: "原始报价范围",
      status: "active",
      revision: 1,
    });
  } finally {
    await rejectRepairQuoteAudit(current.database, false).catch(() => undefined);
    await current.close();
  }
});

test("选择报价模拟支付在并发和重试下只生成一个冻结订单，且仅中标店得到合成联系", async () => {
  const current = await fixture("repair_payment");
  try {
    const owner = await createDevelopmentSession(current.database, { userId: "repair-payment-owner" });
    const otherOwner = await createDevelopmentSession(current.database, { userId: "repair-payment-other" });
    const sessions = await createRepairSessions(current.app, current.database);
    const source = await seedSourceReport(current, owner.userId, "3001", { faultCount: 1 });
    const created = await createRepairRequest(current.app, owner.token, source.reportId);
    const requestId = created.json<Json>().data.id;
    for (const [index, shop] of DEMO_REPAIR_SHOPS.entries()) {
      const response = await submitQuote(
        current.app,
        sessions[index].token,
        requestId,
        shop.basePriceFen,
        shop.quoteNote,
      );
      assert.equal(response.statusCode, 200, response.body);
    }
    const beforePay = await current.app.inject({ method: "GET", url: `/api/repair/requests/${requestId}`, headers: bearer(owner.token) });
    const selectedQuote = beforePay.json<Json>().data.quotes.find((quote: Json) => quote.shop.id === DEMO_REPAIR_SHOPS[0].id);

    const crossOwner = await current.app.inject({
      method: "POST",
      url: `/api/repair/requests/${requestId}/mock-pay`,
      headers: bearer(otherOwner.token),
      payload: { quoteId: selectedQuote.id, idempotencyKey: "repair-cross-owner-key" },
    });
    assert.equal(crossOwner.statusCode, 404, crossOwner.body);

    const paymentCall = () => current.app.inject({
      method: "POST",
      url: `/api/repair/requests/${requestId}/mock-pay`,
      headers: bearer(owner.token),
      payload: { quoteId: selectedQuote.id, idempotencyKey: "repair-payment-key-0001" },
    });
    const concurrent = await Promise.all([paymentCall(), paymentCall()]);
    assert.deepEqual(concurrent.map((response) => response.statusCode), [200, 200]);
    assert.equal(await count(current.database, "repair_orders", "request_id = ?", [requestId]), 1);
    assert.equal(await count(current.database, "repair_mock_payments", "request_id = ?", [requestId]), 1);

    const paid = concurrent[0].json<Json>().data;
    assert.equal(paid.status, "paid");
    assert.equal(paid.order.totalPriceFen, DEMO_REPAIR_SHOPS[0].basePriceFen);
    assert.equal(paid.order.payment.provider, "mock");
    assert.equal(paid.order.payment.status, "confirmed");
    assert.equal(paid.order.shop.address, DEMO_REPAIR_SHOPS[0].address);
    assert.equal(paid.quotes.filter((quote: Json) => quote.status === "selected").length, 1);
    assert.equal(paid.quotes.filter((quote: Json) => quote.status === "lost").length, 2);

    await current.database.prepare(`
      UPDATE repair_shops SET name = '后改门店', address = '后改地址', contact_phone = '13899999999'
      WHERE id = ?
    `).run(DEMO_REPAIR_SHOPS[0].id);
    await current.database.prepare(`
      UPDATE repair_quotes SET total_price_fen = 999999, note = '后改报价' WHERE id = ?
    `).run(selectedQuote.id);
    const frozen = await current.app.inject({ method: "GET", url: `/api/repair/requests/${requestId}`, headers: bearer(owner.token) });
    assert.equal(frozen.json<Json>().data.order.totalPriceFen, DEMO_REPAIR_SHOPS[0].basePriceFen);
    assert.equal(frozen.json<Json>().data.order.shop.name, DEMO_REPAIR_SHOPS[0].name);
    assert.equal(frozen.json<Json>().data.order.shop.address, DEMO_REPAIR_SHOPS[0].address);
    const orderSnapshot = await current.database.prepare<{ quote_snapshot_json: string }>(
      "SELECT quote_snapshot_json FROM repair_orders WHERE request_id = ?",
    ).get(requestId);
    assert.equal(JSON.parse(String(orderSnapshot?.quote_snapshot_json)).totalPriceFen, DEMO_REPAIR_SHOPS[0].basePriceFen);

    const wonDetail = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}`,
      headers: bearer(sessions[0].token),
    });
    assert.equal(wonDetail.statusCode, 200, wonDetail.body);
    assert.deepEqual(wonDetail.json<Json>().data.ownerContact, {
      name: "演示车主",
      phone: "13800006666",
      isSynthetic: true,
      notice: "合成演示联系方式，仅供选中门店演示线下协商",
    });
    const lostDetail = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}`,
      headers: bearer(sessions[1].token),
    });
    assert.equal(lostDetail.statusCode, 404, lostDetail.body);
    const deniedWhere = `
      action = 'backoffice.authorization.denied'
      AND account_id = ?
      AND metadata_json->>'reason' = 'repair_paid_request_wrong_shop'
    `;
    assert.equal(await count(
      current.database,
      "backoffice_audit_events",
      deniedWhere,
      [sessions[1].accountId],
    ), 1);
    const deniedAudit = await current.database.prepare<Json>(`
      SELECT resource_id, metadata_json::text
      FROM backoffice_audit_events
      WHERE ${deniedWhere}
    `).get(sessions[1].accountId);
    assert.equal(deniedAudit?.resource_id, null);
    const deniedAuditText = String(deniedAudit?.metadata_json ?? "");
    assert.equal(deniedAuditText.includes(requestId), false);
    assert.equal(deniedAuditText.includes(source.plate), false);

    const nonexistentDetail = await current.app.inject({
      method: "GET",
      url: "/api/repair-operator/requests/nonexistent-repair-request",
      headers: bearer(sessions[1].token),
    });
    assert.equal(nonexistentDetail.statusCode, 404, nonexistentDetail.body);
    assert.equal(await count(
      current.database,
      "backoffice_audit_events",
      deniedWhere,
      [sessions[1].accountId],
    ), 1);

    const wonLobby = await current.app.inject({
      method: "GET",
      url: "/api/repair-operator/requests",
      headers: bearer(sessions[0].token),
    });
    const lostLobby = await current.app.inject({
      method: "GET",
      url: "/api/repair-operator/requests",
      headers: bearer(sessions[1].token),
    });
    assert.equal(wonLobby.json<Json>().data.find((item: Json) => item.id === requestId).shopStatus, "won");
    assert.equal(lostLobby.json<Json>().data.some((item: Json) => item.id === requestId), false);

    const ownerMediaId = paid.media[0].id;
    const ownerMedia = await current.app.inject({
      method: "GET",
      url: `/api/repair/requests/${requestId}/media/${ownerMediaId}`,
      headers: bearer(owner.token),
    });
    assert.equal(ownerMedia.statusCode, 200, ownerMedia.body);
    const otherOwnerMedia = await current.app.inject({
      method: "GET",
      url: `/api/repair/requests/${requestId}/media/${ownerMediaId}`,
      headers: bearer(otherOwner.token),
    });
    assert.equal(otherOwnerMedia.statusCode, 404, otherOwnerMedia.body);
    const wonMedia = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}/media/${ownerMediaId}`,
      headers: bearer(sessions[0].token),
    });
    assert.equal(wonMedia.statusCode, 200, wonMedia.body);
    const lostMedia = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}/media/${ownerMediaId}`,
      headers: bearer(sessions[1].token),
    });
    assert.equal(lostMedia.statusCode, 404, lostMedia.body);
    assert.equal(await count(
      current.database,
      "backoffice_audit_events",
      deniedWhere,
      [sessions[1].accountId],
    ), 2);

    await rejectRepairDeniedAudit(current.database, true);
    const deniedAuditFailure = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}/media/${ownerMediaId}`,
      headers: bearer(sessions[1].token),
    });
    assert.equal(deniedAuditFailure.statusCode, 404, deniedAuditFailure.body);
    assert.equal(await count(
      current.database,
      "backoffice_audit_events",
      deniedWhere,
      [sessions[1].accountId],
    ), 2);
    await rejectRepairDeniedAudit(current.database, false);

    const secondSource = await seedSourceReport(current, owner.userId, "3002", { faultCount: 1 });
    const secondRequest = (await createRepairRequest(current.app, owner.token, secondSource.reportId)).json<Json>().data;
    const firstQuoteResponse = await submitQuote(current.app, sessions[0].token, secondRequest.id, 168000, "报价一");
    const secondQuoteResponse = await submitQuote(current.app, sessions[1].token, secondRequest.id, 198000, "报价二");
    const firstQuoteId = firstQuoteResponse.json<Json>().data.ownQuote.id;
    const secondQuoteId = secondQuoteResponse.json<Json>().data.ownQuote.id;
    const competing = await Promise.all([
      current.app.inject({ method: "POST", url: `/api/repair/requests/${secondRequest.id}/mock-pay`, headers: bearer(owner.token), payload: { quoteId: firstQuoteId, idempotencyKey: "repair-compete-key-1" } }),
      current.app.inject({ method: "POST", url: `/api/repair/requests/${secondRequest.id}/mock-pay`, headers: bearer(owner.token), payload: { quoteId: secondQuoteId, idempotencyKey: "repair-compete-key-2" } }),
    ]);
    assert.deepEqual(competing.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(await count(current.database, "repair_orders", "request_id = ?", [secondRequest.id]), 1);
    assert.equal(await count(current.database, "repair_mock_payments", "request_id = ?", [secondRequest.id]), 1);
  } finally {
    await rejectRepairDeniedAudit(current.database, false).catch(() => undefined);
    await current.close();
  }
});

test("取消、旧演示入口、维修媒体 scope 与演示重置均 fail closed", async () => {
  const current = await fixture("repair_cancel");
  const originalYuxiaomanEnv = process.env.YUXIAOMAN_ENV;
  const originalMockPaymentFlag = process.env.ALLOW_MOCK_PAYMENT;
  try {
    const owner = await createDevelopmentSession(current.database, { userId: "repair-cancel-owner" });
    const sessions = await createRepairSessions(current.app, current.database);
    const source = await seedSourceReport(current, owner.userId, "4001", { faultCount: 1 });
    const created = await createRepairRequest(current.app, owner.token, source.reportId);
    const requestId = created.json<Json>().data.id;
    const mediaId = created.json<Json>().data.media[0].id;
    const quote = await submitQuote(current.app, sessions[0].token, requestId, 168000, "取消前报价");
    const quoteId = quote.json<Json>().data.ownQuote.id;

    process.env.YUXIAOMAN_ENV = "production";
    delete process.env.ALLOW_MOCK_PAYMENT;
    const productionPayment = await current.app.inject({
      method: "POST",
      url: `/api/repair/requests/${requestId}/mock-pay`,
      headers: bearer(owner.token),
      payload: { quoteId, idempotencyKey: "repair-production-payment" },
    });
    assert.equal(productionPayment.statusCode, 503, productionPayment.body);
    assert.equal(productionPayment.json<Json>().error.code, "MOCK_PAYMENT_DISABLED");
    process.env.YUXIAOMAN_ENV = "test";

    const cancel = () => current.app.inject({
      method: "POST",
      url: `/api/repair/requests/${requestId}/cancel`,
      headers: bearer(owner.token),
      payload: {},
    });
    const first = await cancel();
    const second = await cancel();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json<Json>().data.status, "cancelled");
    assert.equal(second.json<Json>().data.quotes[0].status, "lost");
    const payAfterCancel = await current.app.inject({
      method: "POST",
      url: `/api/repair/requests/${requestId}/mock-pay`,
      headers: bearer(owner.token),
      payload: { quoteId, idempotencyKey: "repair-cancel-payment" },
    });
    assert.equal(payAfterCancel.statusCode, 409, payAfterCancel.body);

    const ownerMedia = await current.app.inject({ method: "GET", url: `/api/repair/requests/${requestId}/media/${mediaId}`, headers: bearer(owner.token) });
    assert.equal(ownerMedia.statusCode, 200, ownerMedia.body);
    const shopMedia = await current.app.inject({
      method: "GET",
      url: `/api/repair-operator/requests/${requestId}/media/${mediaId}`,
      headers: bearer(sessions[0].token),
    });
    assert.equal(shopMedia.statusCode, 404, shopMedia.body);
    assert.equal(await count(
      current.database,
      "backoffice_audit_events",
      `action = 'backoffice.authorization.denied'
        AND account_id = ?
        AND metadata_json->>'reason' = 'repair_paid_request_wrong_shop'`,
      [sessions[0].accountId],
    ), 0);

    const removedList = await current.app.inject({ method: "GET", url: "/api/demo/repair-shops" });
    assert.equal(removedList.statusCode, 404, removedList.body);
    const removedWrite = await current.app.inject({
      method: "PUT",
      url: `/api/demo/repair-shops/${DEMO_REPAIR_SHOPS[0].id}/requests/${requestId}/quote`,
      payload: { totalPriceFen: 1, note: "旧入口不可用" },
    });
    assert.equal(removedWrite.statusCode, 404, removedWrite.body);

    await clearRepairData(current.database);
    assert.equal(await count(current.database, "repair_shops"), DEMO_REPAIR_SHOPS.length);
    assert.equal(await count(
      current.database,
      "backoffice_subject_assignments",
      "account_id = ? AND subject_type = 'repair_shop' AND status = 'active'",
      [sessions[0].accountId],
    ), 1);
  } finally {
    process.env.YUXIAOMAN_ENV = originalYuxiaomanEnv;
    if (originalMockPaymentFlag === undefined) delete process.env.ALLOW_MOCK_PAYMENT;
    else process.env.ALLOW_MOCK_PAYMENT = originalMockPaymentFlag;
    await current.close();
  }
});
