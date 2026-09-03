import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { createDevelopmentSession } from "../auth.js";
import {
  auditBackofficeEvent,
  createInitialPlatformAdmin,
  INSPECTION_STATION_CAPABILITIES,
  REPAIR_SHOP_CAPABILITIES,
  WASH_STORE_CAPABILITIES,
  type BackofficeSession,
} from "../backoffice.js";
import { migrateCustomerCenterDatabase } from "../customer-center.js";
import { createDatabase, seedDemoData, type Database } from "../db.js";
import { createTestDatabase } from "./test-database.js";

type Json = Record<string, any>;

process.env.NODE_ENV = "test";
process.env.YUXIAOMAN_ENV = "test";
process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK = "false";

async function fixture(prefix: string, allowBackofficeFallback = false): Promise<{
  app: FastifyInstance;
  database: Database;
  uploadDir: string;
  insuranceUploadDir: string;
  subsidyConsultationUploadDir: string;
  close: () => Promise<void>;
}> {
  process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK = allowBackofficeFallback ? "true" : "false";
  const database = await createTestDatabase(prefix);
  const privateRoot = mkdtempSync(join(tmpdir(), "yuxiaoman-backoffice-"));
  const uploadDir = join(privateRoot, "uploads");
  const insuranceUploadDir = join(privateRoot, "insurance");
  const subsidyConsultationUploadDir = join(privateRoot, "subsidy");
  const app = await buildApp({
    database,
    uploadDir,
    insuranceUploadDir,
    subsidyConsultationUploadDir,
  });
  await app.ready();
  return {
    app,
    database,
    uploadDir,
    insuranceUploadDir,
    subsidyConsultationUploadDir,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(privateRoot, { recursive: true, force: true });
    },
  };
}

test("客户中心聚合真实数据、支持备注标签，并对门店账号强制隔离", async () => {
  const { app, database, close } = await fixture("customer_center_admin");
  try {
    const platformCookie = await createPlatformSession(app, database, "customer-center");
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/customers?q=%E6%B4%A5A88888&activeWithinDays=90&limit=20",
      headers: { cookie: platformCookie },
    });
    assert.equal(list.statusCode, 200, list.body);
    const payload = list.json<Json>().data;
    assert.ok(payload.items.some((item: Json) => item.id === "demo-user"));
    assert.ok(payload.summary.demo >= 7);
    assert.equal(JSON.stringify(payload).includes("provider_subject"), false);
    const demo = payload.items.find((item: Json) => item.id === "demo-user");
    assert.match(demo.customerNumber, /^CUS-[A-F0-9]{12}$/u);
    assert.equal(demo.identity.bound, false);

    const tagUpdate = await app.inject({
      method: "PUT",
      url: "/api/admin/customers/demo-user/tags",
      headers: { cookie: platformCookie },
      payload: { tags: ["待跟进", "重点客户", "待跟进"] },
    });
    assert.equal(tagUpdate.statusCode, 200, tagUpdate.body);
    assert.deepEqual(tagUpdate.json<Json>().data.tags, ["重点客户", "待跟进"]);

    const noteCreate = await app.inject({
      method: "POST",
      url: "/api/admin/customers/demo-user/notes",
      headers: { cookie: platformCookie },
      payload: { content: "客户希望本周确认年检预约。" },
    });
    assert.equal(noteCreate.statusCode, 201, noteCreate.body);
    const noteId = noteCreate.json<Json>().data.note.id;
    await assert.rejects(
      database.prepare("UPDATE customer_admin_notes SET content = '不可修改' WHERE id = ?").run(noteId),
      (error: unknown) => (error as { code?: string }).code === "P0001",
    );

    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/customers/demo-user",
      headers: { cookie: platformCookie },
    });
    assert.equal(detail.statusCode, 200, detail.body);
    const customer = detail.json<Json>().data;
    assert.deepEqual(customer.tags, ["重点客户", "待跟进"]);
    assert.equal(customer.notes[0].content, "客户希望本周确认年检预约。");
    assert.ok(customer.vehicles.some((vehicle: Json) => vehicle.plateNormalized === "津A88888"));
    assert.equal(customer.identities.length, 0);

    const operatorDetailResponse = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-1",
      headers: { cookie: platformCookie },
    });
    assert.equal(operatorDetailResponse.statusCode, 200, operatorDetailResponse.body);
    const operatorDetail = operatorDetailResponse.json<Json>().data;
    const annual = operatorDetail.recentRecords.find((record: Json) => record.sourceId === "booking-op-1");
    assert.ok(annual);
    assert.equal(annual.domain, "annual_inspection");
    assert.match(annual.businessCode, /^YXM\d{8}OP1$/u);
    assert.equal(annual.amountFen, 26000);
    assert.equal(annual.detailPath, "/bookings?booking=booking-op-1");
    assert.ok(operatorDetail.vehicles[0].lastServiceAt);
    const annualRecords = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-1/records?domain=annual_inspection&limit=1",
      headers: { cookie: platformCookie },
    });
    assert.equal(annualRecords.statusCode, 200, annualRecords.body);
    assert.equal(annualRecords.json<Json>().data.items[0].sourceId, "booking-op-1");

    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO users (id, data_kind, display_name, status, created_at, updated_at)
      VALUES ('customer-real-wechat-test', 'real', '微信真实客户测试', 'active', ?, ?)
    `).run(now, now);
    await database.prepare(`
      INSERT INTO user_identities (
        id, user_id, provider, provider_app_id, provider_subject, union_subject, created_at, updated_at
      ) VALUES (
        'identity-real-wechat-test', 'customer-real-wechat-test', 'wechat',
        'wx-customer-center-test', 'openid-customer-center-test', 'union-customer-center-test', ?, ?
      )
    `).run(now, now);
    const reveal = await app.inject({
      method: "POST",
      url: "/api/admin/customers/customer-real-wechat-test/identities/identity-real-wechat-test/reveal",
      headers: { cookie: platformCookie },
    });
    assert.equal(reveal.statusCode, 200, reveal.body);
    assert.equal(reveal.headers["cache-control"], "private, no-store");
    assert.equal(reveal.json<Json>().data.identity.providerSubject, "openid-customer-center-test");
    const revealAudit = await database.prepare<Json>(`
      SELECT COUNT(*)::integer AS count FROM backoffice_audit_events
      WHERE action = 'customer.identity.reveal'
        AND resource_type = 'customer_identity' AND resource_id = 'identity-real-wechat-test'
    `).get();
    assert.equal(revealAudit?.count, 1);

    const storeId = "wash-store-haihe-demo";
    const invitation = await inviteStoreAdmin(app, platformCookie, storeId, "customer-center");
    const storeSession = await activate(app, invitation.activation.token, "store customer center password 2026");
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/customers",
      headers: { cookie: storeSession.cookie },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/customers" });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
  } finally {
    await close();
  }
});

test("客户资料逐项读取校验完整归属并写入 no-store 审计", async () => {
  const { app, database, uploadDir, close } = await fixture("customer_material_access");
  try {
    const platformCookie = await createPlatformSession(app, database, "customer-material");
    const now = new Date().toISOString();
    const materialId = "customer-material-demo";
    const stagedMaterialId = "customer-material-staged-demo";
    const storageKey = "customer-material-demo.jpg";
    const bytes = Buffer.from("synthetic-private-customer-material");
    writeFileSync(join(uploadDir, storageKey), bytes);
    await database.prepare(`
      INSERT INTO booking_media (
        id, user_id, booking_id, kind, storage_key, mime_type, size_bytes,
        width, height, created_at, bound_at, expires_at
      ) VALUES (?, 'operator-user-1', 'booking-op-1', 'license_front', ?, 'image/jpeg', ?, 10, 10, ?, ?, ?)
    `).run(materialId, storageKey, bytes.length, now, now, "2032-08-25T00:00:00.000Z");
    await database.prepare(`
      INSERT INTO booking_media (
        id, user_id, booking_id, kind, storage_key, mime_type, size_bytes,
        width, height, created_at, bound_at, expires_at
      ) VALUES (?, 'operator-user-1', NULL, 'license_back', ?, 'image/jpeg', ?, 10, 10, ?, NULL, ?)
    `).run(stagedMaterialId, "customer-material-staged-demo.jpg", bytes.length, now, "2032-08-25T00:00:00.000Z");

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-1/materials?domain=annual_inspection",
      headers: { cookie: platformCookie },
    });
    assert.equal(list.statusCode, 200, list.body);
    const material = list.json<Json>().data.items.find((item: Json) => item.id === materialId);
    assert.ok(material);
    assert.equal(material.available, true);
    assert.equal(JSON.stringify(material).includes(storageKey), false);
    assert.equal(material.state, "active");
    assert.equal(material.purpose, "年检预约资料核验");
    const staged = list.json<Json>().data.items.find((item: Json) => item.id === stagedMaterialId);
    assert.ok(staged);
    assert.equal(staged.available, false);
    assert.equal(staged.contentPath, null);

    const content = await app.inject({
      method: "GET",
      url: material.contentPath,
      headers: { cookie: platformCookie },
    });
    assert.equal(content.statusCode, 200, content.body);
    assert.equal(content.headers["cache-control"], "private, no-store");
    assert.deepEqual(content.rawPayload, bytes);

    const crossOwner = await app.inject({
      method: "GET",
      url: `/api/admin/customers/demo-user/materials/annual_inspection/${materialId}/content`,
      headers: { cookie: platformCookie },
    });
    assert.equal(crossOwner.statusCode, 404, crossOwner.body);
    const unbound = await app.inject({
      method: "GET",
      url: `/api/admin/customers/operator-user-1/materials/annual_inspection/${stagedMaterialId}/content`,
      headers: { cookie: platformCookie },
    });
    assert.equal(unbound.statusCode, 404, unbound.body);
    const audit = await database.prepare<Json>(`
      SELECT COUNT(*)::integer AS count FROM backoffice_audit_events
      WHERE action = 'customer.material.read'
        AND resource_type = 'customer_material' AND resource_id = ?
    `).get(materialId);
    assert.equal(audit?.count, 1);
  } finally {
    await close();
  }
});

test("客户资料拒绝体检、补贴与维修错链，迁移会中止且跨域游标严格分页", async () => {
  const { app, database, uploadDir, close } = await fixture("customer_material_chain_guard");
  try {
    const platformCookie = await createPlatformSession(app, database, "customer-chain");
    const now = "2026-08-25T08:00:00.000Z";
    const future = "2032-08-25T08:00:00.000Z";
    const vehicleDir = join(uploadDir, "vehicle-checkup");
    mkdirSync(vehicleDir, { recursive: true });
    const sourceBytes = Buffer.from("synthetic-owned-checkup-source");
    writeFileSync(join(vehicleDir, "owned-source.jpg"), sourceBytes);
    writeFileSync(join(vehicleDir, "cross-checkup.jpg"), Buffer.from("must-not-cross-owner"));
    writeFileSync(join(uploadDir, "annual-cursor.jpg"), Buffer.from("annual-cursor-material"));

    await database.prepare(`
      INSERT INTO vehicle_checkup_reports (
        id, booking_id, report_no, status, created_at, updated_at, published_at, retain_until
      ) VALUES
        ('chain-report-op1', 'booking-op-1', 'VCR-CHAIN-OP1', 'published', ?, ?, ?, ?),
        ('chain-report-op2', 'booking-op-2', 'VCR-CHAIN-OP2', 'published', ?, ?, ?, ?)
    `).run(now, now, now, future, now, now, now, future);
    await database.prepare(`
      INSERT INTO vehicle_checkup_media (
        id, booking_id, report_id, kind, fault_id, sequence_no, status,
        storage_key, mime_type, size_bytes, width, height, sha256,
        uploader_actor_type, created_at, bound_at, expires_at
      ) VALUES (
        'cursor-collision-material', 'booking-op-1', 'chain-report-op1', 'front_left', NULL, NULL, 'bound',
        'owned-source.jpg', 'image/jpeg', ?, 10, 10, 'chain-sha-owned', 'operator', ?, ?, ?
      )
    `).run(sourceBytes.length, now, now, future);
    await database.prepare(`
      INSERT INTO booking_media (
        id, user_id, booking_id, kind, storage_key, mime_type, size_bytes,
        width, height, created_at, bound_at, expires_at
      ) VALUES (
        'cursor-collision-material', 'operator-user-1', 'booking-op-1', 'license_front',
        'annual-cursor.jpg', 'image/jpeg', 22, 10, 10, ?, ?, ?
      )
    `).run(now, now, future);

    await database.execute(`
      ALTER TABLE vehicle_checkup_media
        DROP CONSTRAINT vehicle_checkup_media_report_booking_fk
    `);
    await database.prepare(`
      INSERT INTO vehicle_checkup_media (
        id, booking_id, report_id, kind, fault_id, sequence_no, status,
        storage_key, mime_type, size_bytes, width, height, sha256,
        uploader_actor_type, created_at, bound_at, expires_at
      ) VALUES (
        'cross-checkup-media', 'booking-op-2', 'chain-report-op1', 'front_right', NULL, NULL, 'bound',
        'cross-checkup.jpg', 'image/jpeg', 20, 10, 10, 'chain-sha-cross', 'operator', ?, ?, ?
      )
    `).run(now, now, future);

    const crossCheckup = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-2/materials/vehicle_checkup/cross-checkup-media/content",
      headers: { cookie: platformCookie },
    });
    assert.equal(crossCheckup.statusCode, 404, crossCheckup.body);
    const checkupList = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-2/materials?domain=vehicle_checkup",
      headers: { cookie: platformCookie },
    });
    assert.equal(checkupList.statusCode, 200, checkupList.body);
    assert.equal(checkupList.json<Json>().data.items.some((item: Json) => item.id === "cross-checkup-media"), false);
    await assert.rejects(
      migrateCustomerCenterDatabase(database),
      /inconsistent vehicle checkup media ownership chain/u,
    );
    await database.prepare("DELETE FROM vehicle_checkup_media WHERE id = 'cross-checkup-media'").run();

    const feePlan = await database.prepare<Json>(`
      SELECT id, version FROM subsidy_consultation_fee_plans
      WHERE state = 'published' AND is_current = 1 LIMIT 1
    `).get();
    const disclosure = await database.prepare<Json>(`
      SELECT version FROM subsidy_consultation_disclosures WHERE is_active = 1 LIMIT 1
    `).get();
    assert.ok(feePlan?.id && feePlan?.version && disclosure?.version);
    await database.prepare(`
      INSERT INTO subsidy_consultation_quote_snapshots (
        id, user_id, vehicle_id, declared_value_fen, declared_value_source, is_appraisal,
        fee_plan_id, fee_plan_version, tier_snapshot_json, consultation_fee_fen,
        plate_fee_fen, mailing_fee_fen, production_fee_fen,
        administrative_fee_fen, total_transfer_cost_fen,
        expires_at, used_at, created_at
      ) VALUES (
        'chain-subsidy-quote', 'operator-user-2', 'vehicle-op-2', 100000,
        'owner_self_reported', 0, ?, ?, '{}', 1000,
        12000, 2000, 1000, 15000, 16000, ?, ?, ?
      )
    `).run(feePlan.id, feePlan.version, future, now, now);
    await database.prepare(`
      INSERT INTO subsidy_consultations (
        id, consultation_code, user_id, vehicle_id, quote_id, status,
        declared_value_fen, declared_value_source, is_appraisal, consultation_fee_fen,
        plate_fee_fen, mailing_fee_fen, production_fee_fen,
        administrative_fee_fen, total_transfer_cost_fen,
        fee_plan_version, tier_snapshot_json, vehicle_plate_masked, vehicle_model_name,
        contact_name_masked, masked_phone, disclosure_version, consent_snapshot_json,
        idempotency_key_digest, submitted_at, created_at, updated_at
      ) VALUES (
        'booking-op-2', 'SUB-CHAIN-OP2', 'operator-user-2', 'vehicle-op-2',
        'chain-subsidy-quote', 'new', 100000, 'owner_self_reported', 0, 1000,
        12000, 2000, 1000, 15000, 16000,
        ?, '{}', '津A·***02', '测试车型', '测**', '138****0002', ?, '{}',
        'chain-subsidy-idempotency', ?, ?, ?
      )
    `).run(feePlan.version, disclosure.version, now, now, now);
    await database.prepare("UPDATE bookings SET created_at = ? WHERE id = 'booking-op-2'").run(now);
    await database.execute(`
      ALTER TABLE subsidy_consultation_materials
        DROP CONSTRAINT subsidy_material_consultation_owner_fk
    `);
    await database.prepare(`
      INSERT INTO subsidy_consultation_materials (
        id, user_id, consultation_id, kind, state, storage_key, mime_type,
        size_bytes, width, height, encryption_mode, delete_after, created_at, updated_at
      ) VALUES (
        'cross-subsidy-material', 'operator-user-1', 'booking-op-2', 'id_card_front',
        'bound', 'cross-subsidy.enc', 'image/jpeg', 20, 10, 10, 'demo', ?, ?, ?
      )
    `).run(future, now, now);
    const crossSubsidy = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-2/materials/subsidy_consultation/cross-subsidy-material/content",
      headers: { cookie: platformCookie },
    });
    assert.equal(crossSubsidy.statusCode, 404, crossSubsidy.body);
    await assert.rejects(
      migrateCustomerCenterDatabase(database),
      /inconsistent subsidy material ownership chain/u,
    );
    await database.prepare("DELETE FROM subsidy_consultation_materials WHERE id = 'cross-subsidy-material'").run();
    await database.prepare(`
      INSERT INTO subsidy_consultation_materials (
        id, user_id, consultation_id, kind, state, storage_key, mime_type,
        size_bytes, width, height, encryption_mode, delete_after, created_at, updated_at
      ) VALUES (
        'expired-subsidy-material', 'operator-user-2', 'booking-op-2', 'id_card_front',
        'bound', 'expired-subsidy.bin', 'image/jpeg', 20, 10, 10, 'demo', ?, ?, ?
      )
    `).run(future, now, now);
    await database.prepare(`
      UPDATE subsidy_consultations
      SET status = 'expired', expired_at = ?, updated_at = ?
      WHERE id = 'booking-op-2'
    `).run(now, now);
    const expiredSubsidyList = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-2/materials?domain=subsidy_consultation",
      headers: { cookie: platformCookie },
    });
    assert.equal(expiredSubsidyList.statusCode, 200, expiredSubsidyList.body);
    const expiredSubsidy = expiredSubsidyList.json<Json>().data.items
      .find((item: Json) => item.id === "expired-subsidy-material");
    assert.equal(expiredSubsidy?.state, "expired");
    assert.equal(expiredSubsidy?.available, false);
    const expiredSubsidyContent = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-2/materials/subsidy_consultation/expired-subsidy-material/content",
      headers: { cookie: platformCookie },
    });
    assert.equal(expiredSubsidyContent.statusCode, 404, expiredSubsidyContent.body);

    await database.prepare(`
      INSERT INTO repair_requests (
        id, request_no, user_id, source_report_id, source_booking_id, source_vehicle_id,
        status, vehicle_snapshot_json, report_snapshot_json, synthetic_owner_contact_json,
        created_at, updated_at
      ) VALUES (
        'chain-repair-op2', 'RPR-CHAIN-OP2', 'operator-user-2', 'chain-report-op2',
        'booking-op-2', 'vehicle-op-2', 'open', '{}', '{}', '{}', ?, ?
      )
    `).run(now, now);
    await database.prepare(`
      INSERT INTO repair_request_media (
        id, request_id, fault_id, source_media_id, kind, sequence_no, storage_key,
        mime_type, size_bytes, width, height, sha256, created_at
      ) VALUES (
        'cross-repair-media', 'chain-repair-op2', NULL, 'cursor-collision-material',
        'front_left', NULL, 'owned-source.jpg', 'image/jpeg', ?, 10, 10, 'chain-sha-owned', ?
      )
    `).run(sourceBytes.length, now);
    const crossRepair = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-2/materials/repair/cross-repair-media/content",
      headers: { cookie: platformCookie },
    });
    assert.equal(crossRepair.statusCode, 404, crossRepair.body);
    await assert.rejects(
      migrateCustomerCenterDatabase(database),
      /inconsistent repair media source/u,
    );

    const recordIds: string[] = [];
    let recordCursor: string | null = null;
    do {
      const response: Awaited<ReturnType<FastifyInstance["inject"]>> = await app.inject({
        method: "GET",
        url: `/api/admin/customers/operator-user-2/records?limit=1${recordCursor ? `&cursor=${encodeURIComponent(recordCursor)}` : ""}`,
        headers: { cookie: platformCookie },
      });
      assert.equal(response.statusCode, 200, response.body);
      const pagePayload: Json = response.json<Json>().data;
      recordIds.push(...pagePayload.items.map((item: Json) => `${item.domain}:${item.sourceId}`));
      recordCursor = pagePayload.nextCursor;
    } while (recordCursor);
    assert.equal(recordIds.filter((id) => id === "annual_inspection:booking-op-2").length, 1);
    assert.equal(recordIds.filter((id) => id === "subsidy_consultation:booking-op-2").length, 1);

    const materialIds: string[] = [];
    let materialCursor: string | null = null;
    do {
      const response: Awaited<ReturnType<FastifyInstance["inject"]>> = await app.inject({
        method: "GET",
        url: `/api/admin/customers/operator-user-1/materials?limit=1${materialCursor ? `&cursor=${encodeURIComponent(materialCursor)}` : ""}`,
        headers: { cookie: platformCookie },
      });
      assert.equal(response.statusCode, 200, response.body);
      const pagePayload: Json = response.json<Json>().data;
      materialIds.push(...pagePayload.items.map((item: Json) => `${item.domain}:${item.id}`));
      materialCursor = pagePayload.nextCursor;
    } while (materialCursor);
    assert.equal(materialIds.filter((id) => id === "annual_inspection:cursor-collision-material").length, 1);
    assert.equal(materialIds.filter((id) => id === "vehicle_checkup:cursor-collision-material").length, 1);

    await database.prepare("UPDATE vehicle_checkup_reports SET retain_until = '2000-01-01T00:00:00.000Z' WHERE id = 'chain-report-op1'").run();
    const expiredCheckup = await app.inject({
      method: "GET",
      url: "/api/admin/customers/operator-user-1/materials/vehicle_checkup/cursor-collision-material/content",
      headers: { cookie: platformCookie },
    });
    assert.equal(expiredCheckup.statusCode, 404, expiredCheckup.body);

    await database.prepare("DELETE FROM repair_requests WHERE id = 'chain-repair-op2'").run();
    await database.execute(`
      ALTER TABLE repair_requests DROP CONSTRAINT repair_requests_report_booking_restrict_fk;
      ALTER TABLE repair_requests DROP CONSTRAINT repair_requests_booking_vehicle_user_restrict_fk;
      ALTER TABLE repair_requests DROP CONSTRAINT repair_requests_vehicle_user_restrict_fk;
    `);
    await database.prepare(`
      INSERT INTO repair_requests (
        id, request_no, user_id, source_report_id, source_booking_id, source_vehicle_id,
        status, vehicle_snapshot_json, report_snapshot_json, synthetic_owner_contact_json,
        created_at, updated_at
      ) VALUES (
        'chain-repair-owner-mismatch', 'RPR-CHAIN-MISMATCH', 'operator-user-1',
        'chain-report-op2', 'booking-op-2', 'vehicle-op-2', 'open', '{}', '{}', '{}', ?, ?
      )
    `).run(now, now);
    await assert.rejects(
      migrateCustomerCenterDatabase(database),
      /inconsistent repair source ownership chain/u,
    );
    await database.prepare("DELETE FROM repair_requests WHERE id = 'chain-repair-owner-mismatch'").run();
    await migrateCustomerCenterDatabase(database);
    await database.prepare(`
      INSERT INTO quote_snapshots (
        id, user_id, vehicle_id, station_id, service_mode, vehicle_facts_json,
        pricing_eligibility, inspection_items_json, inspection_fee_fen,
        valet_base_fee_fen, valet_distance_fee_fen, valet_fee_fen, service_fee_fen,
        distance_source, distance_basis, created_at, expires_at
      )
      SELECT 'chain-quote-op1', user_id, vehicle_id, station_id, 'self_drive', '{}',
        'supported', '[]', service_fee_fen, 0, 0, 0, service_fee_fen,
        'not_calculated', 'no_origin', ?, ?
      FROM bookings WHERE id = 'booking-op-1'
    `).run(now, future);
    await database.prepare(`
      INSERT INTO quote_snapshots (
        id, user_id, vehicle_id, station_id, service_mode, vehicle_facts_json,
        pricing_eligibility, inspection_items_json, inspection_fee_fen,
        valet_base_fee_fen, valet_distance_fee_fen, valet_fee_fen, service_fee_fen,
        distance_source, distance_basis, created_at, expires_at
      )
      SELECT 'chain-quote-op2', user_id, vehicle_id, station_id, 'self_drive', '{}',
        'supported', '[]', service_fee_fen, 0, 0, 0, service_fee_fen,
        'not_calculated', 'no_origin', ?, ?
      FROM bookings WHERE id = 'booking-op-2'
    `).run(now, future);
    await database.prepare("UPDATE bookings SET quote_snapshot_id = 'chain-quote-op1' WHERE id = 'booking-op-1'").run();
    await database.prepare("UPDATE bookings SET quote_snapshot_id = 'chain-quote-op2' WHERE id = 'booking-op-2'").run();
    const quoteOp1 = "chain-quote-op1";
    const quoteOp2 = "chain-quote-op2";
    await database.prepare("UPDATE bookings SET quote_snapshot_id = ? WHERE id = 'booking-op-1'").run(quoteOp2);
    await assert.rejects(
      migrateCustomerCenterDatabase(database),
      /inconsistent booking quote snapshot ownership chain/u,
    );
    await database.prepare("UPDATE bookings SET quote_snapshot_id = ? WHERE id = 'booking-op-1'").run(quoteOp1);
    await migrateCustomerCenterDatabase(database);
    const hardConstraints = await database.prepare<Json>(`
      SELECT COUNT(*)::integer AS count FROM pg_constraint
      WHERE connamespace = current_schema()::regnamespace
        AND conname IN (
        'vehicle_checkup_media_report_booking_fk',
        'subsidy_material_consultation_owner_fk',
        'repair_requests_report_booking_restrict_fk',
        'repair_requests_booking_vehicle_user_restrict_fk',
        'repair_requests_vehicle_user_restrict_fk',
        'repair_request_faults_source_fault_restrict_fk',
        'repair_request_media_source_media_restrict_fk'
      )
    `).get();
    assert.equal(hardConstraints?.count, 7);
  } finally {
    await close();
  }
});

test("演示重置在真实或未分类客户存在时先于文件清理安全拒绝", async () => {
  const {
    app, database, uploadDir, insuranceUploadDir, subsidyConsultationUploadDir, close,
  } = await fixture("customer_reset_guard");
  const previous = process.env.ALLOW_DEMO_RESET;
  try {
    process.env.ALLOW_DEMO_RESET = "true";
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO users (id, data_kind, display_name, status, created_at, updated_at)
      VALUES ('customer-reset-guard-real', 'real', '重置保护客户', 'active', ?, ?)
    `).run(now, now);
    const marker = join(uploadDir, "reset-guard-marker.jpg");
    mkdirSync(insuranceUploadDir, { recursive: true });
    mkdirSync(subsidyConsultationUploadDir, { recursive: true });
    const insuranceMarker = join(insuranceUploadDir, "11111111-1111-1111-1111-111111111111.jpg");
    const subsidyMarker = join(subsidyConsultationUploadDir, "22222222-2222-2222-2222-222222222222.bin");
    writeFileSync(marker, Buffer.from("must-survive-rejected-reset"));
    writeFileSync(insuranceMarker, Buffer.from("must-survive-rejected-reset"));
    writeFileSync(subsidyMarker, Buffer.from("must-survive-rejected-reset"));

    const response = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json<Json>().error.code, "DEMO_RESET_UNSAFE");
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(insuranceMarker), true);
    assert.equal(existsSync(subsidyMarker), true);
    assert.ok(await database.prepare("SELECT 1 FROM users WHERE id = 'customer-reset-guard-real'").get());
    await assert.rejects(
      seedDemoData(database, { force: true }),
      /DEMO_RESET_UNSAFE/u,
    );

    await database.prepare("DELETE FROM users WHERE id = 'customer-reset-guard-real'").run();
    await database.prepare(`
      INSERT INTO customer_admin_notes (
        id, user_id, content, actor_account_id, actor_display_name, created_at
      ) VALUES ('reset-guard-note', 'demo-user', '只追加备注必须阻止重置', NULL, '测试管理员', ?::timestamptz)
    `).run(now);
    const noteGuard = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(noteGuard.statusCode, 409, noteGuard.body);
    assert.equal(noteGuard.json<Json>().error.code, "DEMO_RESET_UNSAFE");
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(insuranceMarker), true);
    assert.equal(existsSync(subsidyMarker), true);
  } finally {
    if (previous == null) delete process.env.ALLOW_DEMO_RESET;
    else process.env.ALLOW_DEMO_RESET = previous;
    await close();
  }
});

test("演示重置仅在数据库提交后清理三类生成文件，失败与未知文件均保留", async () => {
  const {
    app, database, uploadDir, insuranceUploadDir, subsidyConsultationUploadDir, close,
  } = await fixture("customer_reset_atomic_files");
  const previous = process.env.ALLOW_DEMO_RESET;
  try {
    process.env.ALLOW_DEMO_RESET = "true";
    mkdirSync(insuranceUploadDir, { recursive: true });
    mkdirSync(subsidyConsultationUploadDir, { recursive: true });
    const uploadGenerated = join(uploadDir, "33333333-3333-3333-3333-333333333333.jpg");
    const insuranceGenerated = join(insuranceUploadDir, "44444444-4444-4444-4444-444444444444.jpg");
    const subsidyGenerated = join(subsidyConsultationUploadDir, "55555555-5555-5555-5555-555555555555.bin");
    const uploadUnknown = join(uploadDir, "keep-unknown.txt");
    const insuranceUnknown = join(insuranceUploadDir, "keep-unknown.jpg");
    const subsidyUnknown = join(subsidyConsultationUploadDir, "keep-unknown.bin");
    for (const filename of [uploadGenerated, insuranceGenerated, subsidyGenerated, uploadUnknown, insuranceUnknown, subsidyUnknown]) {
      writeFileSync(filename, Buffer.from("reset-file-marker"));
    }

    await database.execute(`
      CREATE OR REPLACE FUNCTION reject_demo_reset_booking_delete()
      RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic reset failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_demo_reset_booking_delete_trigger
        BEFORE DELETE ON bookings FOR EACH STATEMENT
        EXECUTE FUNCTION reject_demo_reset_booking_delete();
    `);
    const failed = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(failed.statusCode, 500, failed.body);
    for (const filename of [uploadGenerated, insuranceGenerated, subsidyGenerated, uploadUnknown, insuranceUnknown, subsidyUnknown]) {
      assert.equal(existsSync(filename), true, filename);
    }
    assert.ok(await database.prepare("SELECT 1 FROM bookings LIMIT 1").get());

    await database.execute(`
      DROP TRIGGER reject_demo_reset_booking_delete_trigger ON bookings;
      DROP FUNCTION reject_demo_reset_booking_delete();
    `);
    const succeeded = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(succeeded.statusCode, 200, succeeded.body);
    assert.equal(existsSync(uploadGenerated), false);
    assert.equal(existsSync(insuranceGenerated), false);
    assert.equal(existsSync(subsidyGenerated), false);
    assert.equal(existsSync(uploadUnknown), true);
    assert.equal(existsSync(insuranceUnknown), true);
    assert.equal(existsSync(subsidyUnknown), true);
  } finally {
    if (previous == null) delete process.env.ALLOW_DEMO_RESET;
    else process.env.ALLOW_DEMO_RESET = previous;
    await close();
  }
});

test("演示重置拒绝项目根或重叠目录配置且不改写数据库", async () => {
  const database = await createTestDatabase("customer_reset_bad_dir");
  const privateRoot = mkdtempSync(join(tmpdir(), "yuxiaoman-reset-bad-dir-"));
  const app = await buildApp({
    database,
    uploadDir: join(privateRoot, "uploads"),
    insuranceUploadDir: process.cwd(),
    subsidyConsultationUploadDir: join(privateRoot, "subsidy"),
  });
  const previous = process.env.ALLOW_DEMO_RESET;
  try {
    process.env.ALLOW_DEMO_RESET = "true";
    await app.ready();
    const before = await database.prepare<Json>("SELECT COUNT(*)::integer AS count FROM bookings").get();
    const response = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json<Json>().error.code, "DEMO_RESET_STORAGE_UNSAFE");
    const after = await database.prepare<Json>("SELECT COUNT(*)::integer AS count FROM bookings").get();
    assert.equal(after?.count, before?.count);
  } finally {
    if (previous == null) delete process.env.ALLOW_DEMO_RESET;
    else process.env.ALLOW_DEMO_RESET = previous;
    await app.close();
    await database.close();
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("createDatabase forceSeed 在同一外层事务内完成安全锁与初始化", async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  const schema = `yxm_force_seed_${randomUUID().replaceAll("-", "")}`;
  const database = await createDatabase({
    connectionString,
    schema,
    createSchema: true,
    dropSchemaOnClose: true,
    max: 2,
    applicationName: "yuxiaoman-test-force-seed",
    forceSeed: true,
  });
  try {
    const demoUsers = await database.prepare<Json>(`
      SELECT COUNT(*)::integer AS count FROM users WHERE data_kind = 'demo'
    `).get();
    assert.ok(Number(demoUsers?.count ?? 0) >= 7);
    assert.ok(await database.prepare("SELECT 1 FROM bookings WHERE id = 'booking-op-1'").get());
  } finally {
    await database.close();
  }
});

function responseCookie(response: { headers: Record<string, string | string[] | number | undefined> }): string {
  const setCookie = response.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie[0] : String(setCookie ?? "");
  assert.ok(value);
  return value.split(";", 1)[0];
}

async function login(app: FastifyInstance, loginName: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/backoffice/sessions",
    payload: { loginName, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  return responseCookie(response);
}

async function createPlatformSession(
  app: FastifyInstance,
  database: Database,
  suffix: string,
): Promise<string> {
  const loginName = `platform.${suffix}`;
  const password = `correct horse ${suffix} battery staple`;
  await createInitialPlatformAdmin(database, {
    loginName,
    displayName: `平台管理员 ${suffix}`,
    password,
  });
  return login(app, loginName, password);
}

async function inviteStoreAdmin(
  app: FastifyInstance,
  platformCookie: string,
  storeId: string,
  suffix: string,
): Promise<Json> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/backoffice/accounts/invitations",
    headers: { cookie: platformCookie },
    payload: {
      loginName: `store.${suffix}`,
      displayName: `门店管理员 ${suffix}`,
      role: "wash_store_admin",
      subject: { type: "wash_store", id: storeId },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

async function inviteStationAdmin(
  app: FastifyInstance,
  platformCookie: string,
  stationId: string,
  suffix: string,
): Promise<Json> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/backoffice/accounts/invitations",
    headers: { cookie: platformCookie },
    payload: {
      loginName: `station.${suffix}`,
      displayName: `检测站管理员 ${suffix}`,
      role: "inspection_station_admin",
      subject: { type: "inspection_station", id: stationId },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

async function inviteRepairShopAdmin(
  app: FastifyInstance,
  platformCookie: string,
  shopId: string,
  suffix: string,
): Promise<Json> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/backoffice/accounts/invitations",
    headers: { cookie: platformCookie },
    payload: {
      loginName: `repair.${suffix}`,
      displayName: `维修门店管理员 ${suffix}`,
      role: "repair_shop_admin",
      subject: { type: "repair_shop", id: shopId },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

async function activate(
  app: FastifyInstance,
  token: string,
  password: string,
): Promise<{ cookie: string; data: Json }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/backoffice/activations",
    payload: { token, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: responseCookie(response), data: response.json<Json>().data };
}

async function createUnreferencedWashStore(
  app: FastifyInstance,
  platformCookie: string,
  suffix: string,
): Promise<Json> {
  const suggestions = await app.inject({
    method: "GET",
    url: `/api/locations/suggestions?query=${encodeURIComponent(`后台账号删除保护 ${suffix}`)}`,
  });
  assert.equal(suggestions.statusCode, 200, suggestions.body);
  const location = suggestions.json<Json>().data[0];
  assert.ok(location);

  const response = await app.inject({
    method: "POST",
    url: "/api/admin/wash/stores",
    headers: { cookie: platformCookie },
    payload: {
      name: `后台账号删除保护门店 ${suffix}（演示）`,
      legalName: `后台账号删除保护主体 ${suffix}`,
      location,
      phone: "022-0000-2026",
      description: `仅用于后台账号删除保护测试 ${suffix}`,
      tags: ["账号隔离测试"],
      facilities: [],
      openHours: "09:00-18:00",
      weeklySchedule: {
        mon: [{ start: "09:00", end: "18:00" }],
        tue: [{ start: "09:00", end: "18:00" }],
        wed: [{ start: "09:00", end: "18:00" }],
        thu: [{ start: "09:00", end: "18:00" }],
        fri: [{ start: "09:00", end: "18:00" }],
        sat: [],
        sun: [],
      },
      businessHoursNotice: null,
      advanceBookingDays: 14,
      rating: 0,
      reviewCount: 0,
      dataKind: "demo",
      isActive: true,
      sortPriority: 0,
      internalContact: null,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

test("后台生产边界默认拒绝匿名，显式测试 fallback 不能在 production 生效", async () => {
  const { app, close } = await fixture("backoffice_required");
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/wash/orders" });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(anonymous.json<Json>().error.code, "BACKOFFICE_AUTHENTICATION_REQUIRED");
    for (const url of [
      "/api/admin/driving-schools",
      "/api/admin/driving-school-inquiries",
      "/api/operator/bookings",
    ]) {
      const protectedResponse = await app.inject({ method: "GET", url });
      assert.equal(protectedResponse.statusCode, 401, `${url}: ${protectedResponse.body}`);
      assert.equal(protectedResponse.json<Json>().error.code, "BACKOFFICE_AUTHENTICATION_REQUIRED");
    }

    const session = await app.inject({ method: "GET", url: "/api/backoffice/session" });
    assert.equal(session.statusCode, 401, session.body);
  } finally {
    await close();
  }

  const fallback = await fixture("backoffice_explicit_fallback", true);
  try {
    const response = await fallback.app.inject({ method: "GET", url: "/api/backoffice/session" });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<Json>().data.account.role, "platform_admin");
  } finally {
    await fallback.close();
  }

  const previousEnvironment = process.env.YUXIAOMAN_ENV;
  process.env.YUXIAOMAN_ENV = "production";
  const production = await fixture("backoffice_production_required", true);
  try {
    const response = await production.app.inject({ method: "GET", url: "/api/backoffice/session" });
    assert.equal(response.statusCode, 401, response.body);
  } finally {
    await production.close();
    process.env.YUXIAOMAN_ENV = previousEnvironment ?? "test";
    process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK = "false";
  }
});

test("生产后台写请求强制可信 HTTPS Origin 且会话 Cookie 使用 Secure", async () => {
  const previousEnvironment = process.env.YUXIAOMAN_ENV;
  const previousAllowedOrigins = process.env.BACKOFFICE_ALLOWED_ORIGINS;
  process.env.YUXIAOMAN_ENV = "production";
  process.env.BACKOFFICE_ALLOWED_ORIGINS = "https://admin.example.test";
  const production = await fixture("backoffice_production_origin");
  try {
    const password = "production origin password 2026";
    await createInitialPlatformAdmin(production.database, {
      loginName: "platform.production-origin",
      displayName: "生产来源管理员",
      password,
    });
    const payload = { loginName: "platform.production-origin", password };

    const missingOrigin = await production.app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      payload,
    });
    assert.equal(missingOrigin.statusCode, 403, missingOrigin.body);
    assert.equal(missingOrigin.json<Json>().error.code, "BACKOFFICE_ORIGIN_FORBIDDEN");
    const insecureOrigin = await production.app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      headers: { origin: "http://admin.example.test" },
      payload,
    });
    assert.equal(insecureOrigin.statusCode, 403, insecureOrigin.body);
    const foreignOrigin = await production.app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      headers: { origin: "https://evil.example.test" },
      payload,
    });
    assert.equal(foreignOrigin.statusCode, 403, foreignOrigin.body);

    const allowed = await production.app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      headers: { origin: "https://admin.example.test" },
      payload,
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    const setCookie = String(allowed.headers["set-cookie"] ?? "");
    assert.match(setCookie, /HttpOnly/iu);
    assert.match(setCookie, /SameSite=Strict/iu);
    assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/iu);
    assert.equal(allowed.headers["cache-control"], "no-store");
    assert.equal(allowed.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
    const cookie = responseCookie(allowed);

    const logoutWithoutOrigin = await production.app.inject({
      method: "DELETE",
      url: "/api/backoffice/session",
      headers: { cookie },
    });
    assert.equal(logoutWithoutOrigin.statusCode, 403, logoutWithoutOrigin.body);
    const sessionStillActive = await production.app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie },
    });
    assert.equal(sessionStillActive.statusCode, 200, sessionStillActive.body);
  } finally {
    await production.close();
    process.env.YUXIAOMAN_ENV = previousEnvironment ?? "test";
    if (previousAllowedOrigins === undefined) delete process.env.BACKOFFICE_ALLOWED_ORIGINS;
    else process.env.BACKOFFICE_ALLOWED_ORIGINS = previousAllowedOrigins;
  }
});

test("平台管理员使用实名账号和 HttpOnly Cookie 登录，公开会话遵守固定契约", async () => {
  const { app, database, close } = await fixture("backoffice_platform_login");
  try {
    const cookie = await createPlatformSession(app, database, "login");
    const response = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    const session = response.json<Json>().data;
    assert.deepEqual(Object.keys(session).sort(), ["account", "capabilities", "expiresAt", "subject"]);
    assert.deepEqual(Object.keys(session.account).sort(), ["displayName", "id", "role"]);
    assert.equal(session.account.role, "platform_admin");
    assert.equal(session.subject, null);
    assert.ok(session.capabilities.includes("admin.all"));
    assert.ok(Date.parse(session.expiresAt) > Date.now());

    const logout = await app.inject({
      method: "DELETE",
      url: "/api/backoffice/session",
      headers: { cookie },
    });
    assert.equal(logout.statusCode, 204, logout.body);
    assert.match(String(logout.headers["set-cookie"]), /HttpOnly/iu);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie },
    });
    assert.equal(revoked.statusCode, 401, revoked.body);
  } finally {
    await close();
  }
});

test("账号主动改密会撤销全部旧会话并只保留新颁发会话", async () => {
  const { app, database, close } = await fixture("backoffice_password_change_sessions");
  try {
    const platformCookie = await createPlatformSession(app, database, "password-change");
    const store = await database.prepare<Json>("SELECT id FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const invitation = await inviteStoreAdmin(app, platformCookie, store.id, "password-change");
    const currentPassword = "current manager password 2026";
    const nextPassword = "next manager password 2026";
    const first = await activate(app, invitation.activation.token, currentPassword);
    const secondCookie = await login(app, "store.password-change", currentPassword);

    const changed = await app.inject({
      method: "PUT",
      url: "/api/backoffice/password",
      headers: { cookie: first.cookie },
      payload: { currentPassword, newPassword: nextPassword },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const nextCookie = responseCookie(changed);
    assert.notEqual(nextCookie, first.cookie);
    assert.notEqual(nextCookie, secondCookie);

    for (const revokedCookie of [first.cookie, secondCookie]) {
      const revoked = await app.inject({
        method: "GET",
        url: "/api/backoffice/session",
        headers: { cookie: revokedCookie },
      });
      assert.equal(revoked.statusCode, 401, revoked.body);
    }
    const active = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie: nextCookie },
    });
    assert.equal(active.statusCode, 200, active.body);

    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      payload: { loginName: "store.password-change", password: currentPassword },
    });
    assert.equal(oldPassword.statusCode, 401, oldPassword.body);
    assert.equal(oldPassword.json<Json>().error.code, "BACKOFFICE_INVALID_CREDENTIALS");
    const relogin = await login(app, "store.password-change", nextPassword);
    assert.ok(relogin.startsWith("yxm_backoffice_session="));
  } finally {
    await close();
  }
});

test("连续登录失败触发限流且窗口过后恢复", async () => {
  const { app, database, close } = await fixture("backoffice_login_rate_limit");
  try {
    const loginName = "platform.rate-limit";
    const password = "rate limit correct password 2026";
    await createInitialPlatformAdmin(database, {
      loginName,
      displayName: "限流测试管理员",
      password,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/backoffice/sessions",
        payload: { loginName, password: `wrong password ${attempt}` },
      });
      assert.equal(failed.statusCode, 401, failed.body);
      assert.equal(failed.json<Json>().error.code, "BACKOFFICE_INVALID_CREDENTIALS");
    }

    const limited = await app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      payload: { loginName, password },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json<Json>().error.code, "BACKOFFICE_LOGIN_RATE_LIMITED");

    await database.prepare(`
      UPDATE backoffice_login_attempts
      SET attempted_at = NOW() - INTERVAL '16 minutes'
      WHERE login_name_normalized = ?
    `).run(loginName);
    const recovered = await login(app, loginName, password);
    assert.ok(recovered.startsWith("yxm_backoffice_session="));
  } finally {
    await close();
  }
});

test("平台停用门店管理员会立即撤销会话、绑定与再次登录", async () => {
  const { app, database, close } = await fixture("backoffice_account_disable");
  try {
    const platformCookie = await createPlatformSession(app, database, "disable");
    const store = await database.prepare<Json>("SELECT id FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const password = "disabled manager password 2026";
    const invitation = await inviteStoreAdmin(app, platformCookie, store.id, "disable");
    const provider = await activate(app, invitation.activation.token, password);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/admin/backoffice/accounts/${provider.data.account.id}/disable`,
      headers: { cookie: platformCookie },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json<Json>().data.status, "disabled");

    const revokedSession = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie: provider.cookie },
    });
    assert.equal(revokedSession.statusCode, 401, revokedSession.body);
    const rejectedLogin = await app.inject({
      method: "POST",
      url: "/api/backoffice/sessions",
      payload: { loginName: "store.disable", password },
    });
    assert.equal(rejectedLogin.statusCode, 401, rejectedLogin.body);
    assert.equal(rejectedLogin.json<Json>().error.code, "BACKOFFICE_INVALID_CREDENTIALS");

    const assignment = await database.prepare<Json>(`
      SELECT status FROM backoffice_subject_assignments WHERE account_id = ?
    `).get(provider.data.account.id);
    assert.equal(assignment?.status, "revoked");
  } finally {
    await close();
  }
});

test("洗车店邀请激活后只获得单店主体和洗车能力，其他后台模块返回 403", async () => {
  const { app, database, close } = await fixture("backoffice_store_scope");
  try {
    const platformCookie = await createPlatformSession(app, database, "scope");
    const store = await database.prepare<Json>("SELECT id, name FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const invitation = await inviteStoreAdmin(app, platformCookie, store.id, "scope");
    assert.match(invitation.activation.token, /^yxm_activate_/u);
    assert.ok(invitation.activation.url.includes(encodeURIComponent(invitation.activation.token)));
    const activated = await activate(app, invitation.activation.token, "store scope password 2026");
    assert.deepEqual(activated.data.subject, { type: "wash_store", id: store.id, name: store.name });
    assert.equal(activated.data.account.role, "wash_store_admin");
    assert.ok(activated.data.capabilities.includes("wash.orders.redeem"));
    assert.equal(activated.data.capabilities.includes("admin.all"), false);

    const wash = await app.inject({
      method: "GET",
      url: "/api/admin/wash/orders",
      headers: { cookie: activated.cookie },
    });
    assert.equal(wash.statusCode, 200, wash.body);
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/stations",
      headers: { cookie: activated.cookie },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(forbidden.json<Json>().error.code, "BACKOFFICE_FORBIDDEN");

    const secondInvitation = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      headers: { cookie: platformCookie },
      payload: {
        loginName: "store.scope.duplicate",
        displayName: "重复管理员",
        role: "wash_store_admin",
        subject: { type: "wash_store", id: store.id },
      },
    });
    assert.equal(secondInvitation.statusCode, 409, secondInvitation.body);
    assert.equal(secondInvitation.json<Json>().error.code, "BACKOFFICE_SUBJECT_ALREADY_ASSIGNED");
  } finally {
    await close();
  }
});

test("检测站账号绑定单站，工作台、预约、报告媒体、留证和号源跨站统一返回 404", async () => {
  const { app, database, close } = await fixture("backoffice_inspection_station_scope");
  try {
    const platformCookie = await createPlatformSession(app, database, "station-scope");
    const ownBooking = await database.prepare<Json>(`
      SELECT b.id, b.station_id, s.name AS station_name
      FROM bookings b
      JOIN stations s ON s.id = b.station_id
      ORDER BY b.created_at, b.id
      LIMIT 1
    `).get();
    assert.ok(ownBooking);
    const otherStation = await database.prepare<Json>(`
      SELECT id, name FROM stations WHERE id <> ? ORDER BY id LIMIT 1
    `).get(ownBooking.station_id);
    assert.ok(otherStation);
    const otherBooking = await database.prepare<Json>(`
      SELECT id FROM bookings WHERE id <> ? ORDER BY created_at, id LIMIT 1
    `).get(ownBooking.id);
    assert.ok(otherBooking);
    await database.prepare("UPDATE bookings SET station_id = ? WHERE id = ?")
      .run(otherStation.id, otherBooking.id);

    const invitation = await inviteStationAdmin(
      app,
      platformCookie,
      ownBooking.station_id,
      "scope",
    );
    const stationSession = await activate(
      app,
      invitation.activation.token,
      "inspection station scope password 2026",
    );
    assert.deepEqual(stationSession.data.subject, {
      type: "inspection_station",
      id: ownBooking.station_id,
      name: ownBooking.station_name,
    });
    assert.equal(stationSession.data.account.role, "inspection_station_admin");
    for (const capability of INSPECTION_STATION_CAPABILITIES) {
      assert.ok(stationSession.data.capabilities.includes(capability), capability);
    }
    assert.equal(stationSession.data.capabilities.includes("admin.all"), false);
    assert.equal(stationSession.data.capabilities.includes("wash.orders.read"), false);

    const workbench = await app.inject({
      method: "GET",
      url: "/api/operator/workbench",
      headers: { cookie: stationSession.cookie },
    });
    assert.equal(workbench.statusCode, 200, workbench.body);
    assert.equal(workbench.json<Json>().data.station.id, ownBooking.station_id);

    const expandedWorkbench = await app.inject({
      method: "GET",
      url: `/api/operator/workbench?stationId=${encodeURIComponent(otherStation.id)}`,
      headers: { cookie: stationSession.cookie },
    });
    assert.equal(expandedWorkbench.statusCode, 404, expandedWorkbench.body);
    assert.equal(expandedWorkbench.json<Json>().error.code, "BACKOFFICE_RESOURCE_NOT_FOUND");

    const precheckQueue = await app.inject({
      method: "GET",
      url: "/api/operator/prechecks",
      headers: { cookie: stationSession.cookie },
    });
    assert.equal(precheckQueue.statusCode, 200, precheckQueue.body);

    const expandedPrecheckQueue = await app.inject({
      method: "GET",
      url: `/api/operator/prechecks?stationId=${encodeURIComponent(otherStation.id)}`,
      headers: { cookie: stationSession.cookie },
    });
    assert.equal(expandedPrecheckQueue.statusCode, 404, expandedPrecheckQueue.body);
    assert.equal(expandedPrecheckQueue.json<Json>().error.code, "BACKOFFICE_RESOURCE_NOT_FOUND");

    const ownDetail = await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${encodeURIComponent(ownBooking.id)}`,
      headers: { cookie: stationSession.cookie },
    });
    assert.equal(ownDetail.statusCode, 200, ownDetail.body);

    for (const request of [
      { method: "GET", url: `/api/operator/bookings/${otherBooking.id}` },
      { method: "GET", url: `/api/operator/prechecks/${otherBooking.id}` },
      { method: "GET", url: `/api/operator/bookings/${otherBooking.id}/checkup-report` },
      { method: "GET", url: `/api/operator/bookings/${otherBooking.id}/checkup-report/media/not-visible` },
      { method: "POST", url: `/api/operator/bookings/${otherBooking.id}/handoff` },
      { method: "POST", url: `/api/operator/bookings/${otherBooking.id}/evidence/station_arrival/media` },
    ]) {
      const response = await app.inject({
        method: request.method as "GET" | "POST",
        url: request.url,
        headers: { cookie: stationSession.cookie },
      });
      assert.equal(response.statusCode, 404, `${request.method} ${request.url}: ${response.body}`);
      assert.equal(response.json<Json>().error.code, "BACKOFFICE_RESOURCE_NOT_FOUND");
    }

    const otherSlot = await database.prepare<Json>(`
      SELECT id FROM station_slots WHERE station_id = ? ORDER BY date DESC, start_time LIMIT 1
    `).get(otherStation.id);
    assert.ok(otherSlot);
    const crossSlot = await app.inject({
      method: "PATCH",
      url: `/api/operator/station-slots/${encodeURIComponent(otherSlot.id)}`,
      headers: { cookie: stationSession.cookie },
      payload: { capacity: 10 },
    });
    assert.equal(crossSlot.statusCode, 404, crossSlot.body);
    assert.equal(crossSlot.json<Json>().error.code, "BACKOFFICE_RESOURCE_NOT_FOUND");

    const globalAdmin = await app.inject({
      method: "GET",
      url: "/api/admin/bookings",
      headers: { cookie: stationSession.cookie },
    });
    assert.equal(globalAdmin.statusCode, 403, globalAdmin.body);
    assert.equal(globalAdmin.json<Json>().error.code, "BACKOFFICE_FORBIDDEN");

    const platformCrossDetail = await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${otherBooking.id}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(platformCrossDetail.statusCode, 200, platformCrossDetail.body);

    const accounts = await app.inject({
      method: "GET",
      url: "/api/admin/backoffice/accounts?role=inspection_station_admin",
      headers: { cookie: platformCookie },
    });
    assert.equal(accounts.statusCode, 200, accounts.body);
    assert.ok(accounts.json<Json>().data.items.some((item: Json) => item.id === invitation.account.id));
  } finally {
    await close();
  }
});

test("运营预约列表按冻结车牌规范化筛选，旧单回退当前车辆且不扩大后台主体权限", async () => {
  const { app, database, close } = await fixture("backoffice_booking_plate_filter");
  try {
    const platformCookie = await createPlatformSession(app, database, "booking-plate-filter");
    const bookings = await database.prepare<Json>(`
      SELECT id, vehicle_id, station_id, vehicle_snapshot_json, created_at
      FROM bookings
      WHERE id IN ('booking-op-1', 'booking-op-2', 'booking-op-3')
      ORDER BY id
    `).all();
    assert.equal(bookings.length, 3);
    const [frozenBooking, partialBooking, legacyBooking] = bookings;

    const withPlate = (row: Json, plateNumber: string) => ({
      ...(row.vehicle_snapshot_json && typeof row.vehicle_snapshot_json === "object"
        ? row.vehicle_snapshot_json
        : JSON.parse(String(row.vehicle_snapshot_json ?? "{}"))),
      plateNumber,
    });
    await database.prepare("UPDATE bookings SET vehicle_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(withPlate(frozenBooking, "津Q·7X9Z1")), frozenBooking.id);
    await database.prepare("UPDATE bookings SET vehicle_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(withPlate(partialBooking, "粤D·F81234")), partialBooking.id);
    await database.prepare("UPDATE bookings SET vehicle_snapshot_json = NULL WHERE id = ?")
      .run(legacyBooking.id);
    await database.prepare(`
      UPDATE vehicles SET plate_number = ?, plate_normalized = ?, updated_at = ? WHERE id = ?
    `).run("津H·00001", "津H00001", new Date().toISOString(), frozenBooking.vehicle_id);
    await database.prepare(`
      UPDATE vehicles SET plate_number = ?, plate_normalized = ?, updated_at = ? WHERE id = ?
    `).run("京C·9Z8Y7", "京C9Z8Y7", new Date().toISOString(), legacyBooking.vehicle_id);

    const filtered = async (plateNumber: string, stationId?: string) => app.inject({
      method: "GET",
      url: `/api/admin/bookings?plateNumber=${encodeURIComponent(plateNumber)}${stationId ? `&stationId=${encodeURIComponent(stationId)}` : ""}`,
      headers: { cookie: platformCookie },
    });

    const exact = await filtered("  津 q - 7x9z1  ");
    assert.equal(exact.statusCode, 200, exact.body);
    assert.equal(Array.isArray(exact.json<Json>().data), true);
    assert.deepEqual(exact.json<Json>().data.map((item: Json) => item.id), [frozenBooking.id]);
    assert.equal(exact.json<Json>().data[0].vehicle.plateNumber, "津Q·7X9Z1");
    assert.equal(exact.json<Json>().data[0].createdAt, String(frozenBooking.created_at));

    const partial = await filtered("f8 12");
    assert.equal(partial.statusCode, 200, partial.body);
    assert.deepEqual(partial.json<Json>().data.map((item: Json) => item.id), [partialBooking.id]);

    const legacy = await filtered("京 c . 9z8");
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.deepEqual(legacy.json<Json>().data.map((item: Json) => item.id), [legacyBooking.id]);
    assert.equal(legacy.json<Json>().data[0].vehicle.plateNumber, "京C·9Z8Y7");
    assert.equal(legacy.json<Json>().data[0].createdAt, String(legacyBooking.created_at));

    const frozenWinsOverCurrentVehicle = await filtered("津H00001");
    assert.equal(frozenWinsOverCurrentVehicle.statusCode, 200, frozenWinsOverCurrentVehicle.body);
    assert.deepEqual(frozenWinsOverCurrentVehicle.json<Json>().data, []);
    const noMatch = await filtered("琼Z99999");
    assert.equal(noMatch.statusCode, 200, noMatch.body);
    assert.deepEqual(noMatch.json<Json>().data, []);

    const otherStation = await database.prepare<Json>(`
      SELECT id FROM stations WHERE id <> ? ORDER BY id LIMIT 1
    `).get(frozenBooking.station_id);
    assert.ok(otherStation);
    const wrongStation = await filtered("津Q7X9Z1", otherStation.id);
    assert.equal(wrongStation.statusCode, 200, wrongStation.body);
    assert.deepEqual(wrongStation.json<Json>().data, []);
    const ownStation = await filtered("津Q7X9Z1", frozenBooking.station_id);
    assert.equal(ownStation.statusCode, 200, ownStation.body);
    assert.deepEqual(ownStation.json<Json>().data.map((item: Json) => item.id), [frozenBooking.id]);

    for (const invalid of ["A".repeat(9), "A".repeat(33), "津A_%"] as const) {
      const response = await filtered(invalid);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json<Json>().error.code, "INVALID_PLATE_NUMBER_FILTER");
    }

    const invitation = await inviteStationAdmin(
      app,
      platformCookie,
      frozenBooking.station_id,
      "booking-plate-filter-scope",
    );
    const stationSession = await activate(
      app,
      invitation.activation.token,
      "inspection booking plate filter password 2026",
    );
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/admin/bookings?plateNumber=${encodeURIComponent("津Q7X9Z1")}&stationId=${encodeURIComponent(frozenBooking.station_id)}`,
      headers: { cookie: stationSession.cookie },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(forbidden.json<Json>().error.code, "BACKOFFICE_FORBIDDEN");
  } finally {
    await close();
  }
});

test("运营预约列表按创建时间稳定倒序并支持预约日期筛选", async () => {
  const { app, database, close } = await fixture("backoffice_booking_created_sort");
  try {
    const platformCookie = await createPlatformSession(app, database, "booking-created-sort");
    const appointmentDate = "2037-05-20";
    await database.prepare("UPDATE bookings SET appointment_date = ?, created_at = ? WHERE id = ?")
      .run(appointmentDate, "2037-05-18T08:00:00.000Z", "booking-op-1");
    await database.prepare("UPDATE bookings SET appointment_date = ?, created_at = ? WHERE id = ?")
      .run(appointmentDate, "2037-05-19T08:00:00.000Z", "booking-op-2");
    await database.prepare("UPDATE bookings SET appointment_date = ?, created_at = ? WHERE id = ?")
      .run(appointmentDate, "2037-05-19T08:00:00.000Z", "booking-op-3");

    const response = await app.inject({
      method: "GET",
      url: `/api/admin/bookings?date=${appointmentDate}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json<Json>().data.map((item: Json) => item.id),
      ["booking-op-3", "booking-op-2", "booking-op-1"],
    );

    const invalidDate = await app.inject({
      method: "GET",
      url: "/api/admin/bookings?date=2037-02-30",
      headers: { cookie: platformCookie },
    });
    assert.equal(invalidDate.statusCode, 400, invalidDate.body);
    assert.equal(invalidDate.json<Json>().error.code, "INVALID_DATE");
  } finally {
    await close();
  }
});

test("检测站 Bearer 仅可读取本站预约已绑定的车主上传照片", async () => {
  const { app, database, uploadDir, close } = await fixture("backoffice_operator_booking_media");
  try {
    const platformCookie = await createPlatformSession(app, database, "operator-booking-media");
    const ownBooking = await database.prepare<Json>(`
      SELECT id, user_id, station_id
      FROM bookings
      ORDER BY created_at, id
      LIMIT 1
    `).get();
    assert.ok(ownBooking);
    const otherStation = await database.prepare<Json>(`
      SELECT id FROM stations WHERE id <> ? ORDER BY id LIMIT 1
    `).get(ownBooking.station_id);
    const otherBooking = await database.prepare<Json>(`
      SELECT id, user_id FROM bookings WHERE id <> ? ORDER BY created_at, id LIMIT 1
    `).get(ownBooking.id);
    assert.ok(otherStation && otherBooking);
    await database.prepare("UPDATE bookings SET station_id = ? WHERE id = ?")
      .run(otherStation.id, otherBooking.id);

    const now = new Date().toISOString();
    const expiresAt = "2032-08-26T00:00:00.000Z";
    const ownBytes = Buffer.from("station-scoped-booking-media");
    const ownMediaId = "operator-own-booking-media";
    const crossMediaId = "operator-cross-booking-media";
    const stagedMediaId = "operator-staged-booking-media";
    const ownStorageKey = `${ownMediaId}.jpg`;
    const crossStorageKey = `${crossMediaId}.jpg`;
    const stagedStorageKey = `${stagedMediaId}.jpg`;
    writeFileSync(join(uploadDir, ownStorageKey), ownBytes);
    writeFileSync(join(uploadDir, crossStorageKey), Buffer.from("cross-station-media"));
    writeFileSync(join(uploadDir, stagedStorageKey), Buffer.from("unbound-owner-media"));
    const insertMedia = database.prepare(`
      INSERT INTO booking_media (
        id, user_id, booking_id, kind, storage_key, mime_type, size_bytes,
        width, height, created_at, bound_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, 10, 10, ?, ?, ?)
    `);
    await insertMedia.run(
      ownMediaId,
      ownBooking.user_id,
      ownBooking.id,
      "license_front",
      ownStorageKey,
      ownBytes.length,
      now,
      now,
      expiresAt,
    );
    await insertMedia.run(
      crossMediaId,
      otherBooking.user_id,
      otherBooking.id,
      "license_front",
      crossStorageKey,
      19,
      now,
      now,
      expiresAt,
    );
    await insertMedia.run(
      stagedMediaId,
      ownBooking.user_id,
      null,
      "license_back",
      stagedStorageKey,
      19,
      now,
      null,
      expiresAt,
    );

    const password = "inspection booking media password 2026";
    const invitation = await inviteStationAdmin(
      app,
      platformCookie,
      ownBooking.station_id,
      "booking-media",
    );
    await activate(app, invitation.activation.token, password);
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: { loginName: "station.booking-media", password },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const authorization = `Bearer ${signedIn.json<Json>().data.token}`;

    const ownDetail = await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${ownBooking.id}`,
      headers: { authorization },
    });
    assert.equal(ownDetail.statusCode, 200, ownDetail.body);
    assert.equal(
      ownDetail.json<Json>().data.media.find((item: Json) => item.id === ownMediaId)?.url,
      `/api/media/${ownMediaId}`,
    );

    const ownMedia = await app.inject({
      method: "GET",
      url: `/api/media/${ownMediaId}`,
      headers: { authorization },
    });
    assert.equal(ownMedia.statusCode, 200, ownMedia.body);
    assert.equal(ownMedia.headers["content-type"], "image/jpeg");
    assert.deepEqual(ownMedia.rawPayload, ownBytes);

    for (const inaccessibleId of [crossMediaId, stagedMediaId, "unknown-booking-media"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/media/${inaccessibleId}`,
        headers: { authorization },
      });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json<Json>().error.code, "MEDIA_NOT_FOUND");
    }

    const invalidSession = await app.inject({
      method: "GET",
      url: `/api/media/${ownMediaId}`,
      headers: { authorization: "Bearer yxm_bo_invalid" },
    });
    assert.equal(invalidSession.statusCode, 401, invalidSession.body);
    assert.equal(invalidSession.json<Json>().error.code, "OPERATOR_AUTHENTICATION_REQUIRED");
  } finally {
    await close();
  }
});

test("正式鉴权下平台后台与车主通过各自私有端点读取预约及体检媒体", async () => {
  const previousDemoAuthFallback = process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK;
  process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "false";
  const { app, database, uploadDir, close } = await fixture("backoffice_private_booking_report_media");
  try {
    const platformCookie = await createPlatformSession(app, database, "private-booking-report-media");
    const booking = await database.prepare<Json>(`
      SELECT id, user_id, station_id
      FROM bookings
      ORDER BY created_at, id
      LIMIT 1
    `).get();
    assert.ok(booking);

    const now = "2026-08-27T01:00:00.000Z";
    const expiresAt = "2032-08-27T01:00:00.000Z";
    const bookingMediaId = "admin-private-booking-media";
    const bookingStorageKey = `${bookingMediaId}.jpg`;
    const bookingBytes = Buffer.from("private-booking-media-bytes");
    writeFileSync(join(uploadDir, bookingStorageKey), bookingBytes);
    await database.prepare(`
      INSERT INTO booking_media (
        id, user_id, booking_id, kind, storage_key, mime_type, size_bytes,
        width, height, created_at, bound_at, expires_at
      ) VALUES (?, ?, ?, 'license_front', ?, 'image/jpeg', ?, 10, 10, ?, ?, ?)
    `).run(
      bookingMediaId,
      booking.user_id,
      booking.id,
      bookingStorageKey,
      bookingBytes.length,
      now,
      now,
      expiresAt,
    );

    const reportId = "admin-private-checkup-report";
    const reportMediaId = "admin-private-checkup-media";
    const reportStorageKey = `${reportMediaId}.jpg`;
    const reportBytes = Buffer.from("private-checkup-media-bytes");
    const reportUploadDir = join(uploadDir, "vehicle-checkup");
    mkdirSync(reportUploadDir, { recursive: true });
    writeFileSync(join(reportUploadDir, reportStorageKey), reportBytes);
    await database.prepare(`
      INSERT INTO vehicle_checkup_reports (
        id, booking_id, report_no, schema_version, status, observation_mode,
        diagram_version, annual_conclusion, annual_mark_status, summary_json,
        vehicle_snapshot_json, station_snapshot_json, row_version,
        created_at, updated_at, published_at, retain_until
      ) VALUES (
        ?, ?, 'YXM-CHK-PRIVATE-MEDIA', 'vehicle-checkup-v2', 'published',
        'no_visible_faults', 'sedan-3view-v1', 'passed', 'issued', '{}', '{}', '{}', 2,
        ?, ?, ?, ?
      )
    `).run(reportId, booking.id, now, now, now, expiresAt);
    await database.prepare(`
      INSERT INTO vehicle_checkup_media (
        id, booking_id, report_id, kind, fault_id, sequence_no, status,
        storage_key, mime_type, size_bytes, width, height, sha256,
        uploader_actor_type, created_at, bound_at, expires_at
      ) VALUES (
        ?, ?, ?, 'front_left', NULL, NULL, 'bound', ?, 'image/jpeg', ?, 10, 10,
        'admin-private-checkup-sha', 'operator', ?, ?, ?
      )
    `).run(
      reportMediaId,
      booking.id,
      reportId,
      reportStorageKey,
      reportBytes.length,
      now,
      now,
      expiresAt,
    );

    const adminDetail = await app.inject({
      method: "GET",
      url: `/api/admin/bookings/${booking.id}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(adminDetail.statusCode, 200, adminDetail.body);
    const adminBooking = adminDetail.json<Json>().data;
    const adminBookingMediaUrl = `/api/admin/bookings/${booking.id}/media/${bookingMediaId}`;
    const adminReportMediaUrl = `/api/admin/bookings/${booking.id}/checkup-report/media/${reportMediaId}`;
    assert.equal(adminBooking.media.find((item: Json) => item.id === bookingMediaId)?.url, adminBookingMediaUrl);
    assert.equal(adminBooking.vehicleCheckupReport.media.find((item: Json) => item.id === reportMediaId)?.url, adminReportMediaUrl);

    const adminBookingMedia = await app.inject({
      method: "GET",
      url: adminBookingMediaUrl,
      headers: { cookie: platformCookie },
    });
    assert.equal(adminBookingMedia.statusCode, 200, adminBookingMedia.body);
    assert.equal(adminBookingMedia.headers["cache-control"], "private, no-store");
    assert.deepEqual(adminBookingMedia.rawPayload, bookingBytes);
    const adminReportMedia = await app.inject({
      method: "GET",
      url: adminReportMediaUrl,
      headers: { cookie: platformCookie },
    });
    assert.equal(adminReportMedia.statusCode, 200, adminReportMedia.body);
    assert.deepEqual(adminReportMedia.rawPayload, reportBytes);

    for (const url of [adminBookingMediaUrl, adminReportMediaUrl]) {
      const anonymous = await app.inject({ method: "GET", url });
      assert.equal(anonymous.statusCode, 401, anonymous.body);
    }
    const wrongBooking = await app.inject({
      method: "GET",
      url: `/api/admin/bookings/not-this-booking/media/${bookingMediaId}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(wrongBooking.statusCode, 404, wrongBooking.body);
    assert.ok(booking.station_id);
    const stationInvitation = await inviteStationAdmin(
      app,
      platformCookie,
      booking.station_id,
      "private-booking-report-media",
    );
    const stationAdmin = await activate(
      app,
      stationInvitation.activation.token,
      "station private media password 2026",
    );
    const stationCannotUsePlatformMedia = await app.inject({
      method: "GET",
      url: adminBookingMediaUrl,
      headers: { cookie: stationAdmin.cookie },
    });
    assert.equal(stationCannotUsePlatformMedia.statusCode, 403, stationCannotUsePlatformMedia.body);
    assert.equal(stationCannotUsePlatformMedia.json<Json>().error.code, "BACKOFFICE_FORBIDDEN");

    const ownerSession = await createDevelopmentSession(database, { userId: booking.user_id });
    const ownerAuthorization = `Bearer ${ownerSession.token}`;
    const ownerDetail = await app.inject({
      method: "GET",
      url: `/api/bookings/${booking.id}`,
      headers: { authorization: ownerAuthorization },
    });
    assert.equal(ownerDetail.statusCode, 200, ownerDetail.body);
    const ownerBooking = ownerDetail.json<Json>().data;
    assert.equal(ownerBooking.media.find((item: Json) => item.id === bookingMediaId)?.url, `/api/media/${bookingMediaId}`);
    assert.equal(
      ownerBooking.vehicleCheckupReport.media.find((item: Json) => item.id === reportMediaId)?.url,
      `/api/bookings/${booking.id}/checkup-report/media/${reportMediaId}`,
    );
    const ownerBookingMedia = await app.inject({
      method: "GET",
      url: `/api/media/${bookingMediaId}`,
      headers: { authorization: ownerAuthorization },
    });
    assert.equal(ownerBookingMedia.statusCode, 200, ownerBookingMedia.body);
    assert.deepEqual(ownerBookingMedia.rawPayload, bookingBytes);
    const ownerReportMedia = await app.inject({
      method: "GET",
      url: `/api/bookings/${booking.id}/checkup-report/media/${reportMediaId}`,
      headers: { authorization: ownerAuthorization },
    });
    assert.equal(ownerReportMedia.statusCode, 200, ownerReportMedia.body);
    assert.deepEqual(ownerReportMedia.rawPayload, reportBytes);

    const adminCookieCannotUseOwnerEndpoint = await app.inject({
      method: "GET",
      url: `/api/media/${bookingMediaId}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(adminCookieCannotUseOwnerEndpoint.statusCode, 401, adminCookieCannotUseOwnerEndpoint.body);
    const ownerCannotUseAdminEndpoint = await app.inject({
      method: "GET",
      url: adminBookingMediaUrl,
      headers: { authorization: ownerAuthorization },
    });
    assert.equal(ownerCannotUseAdminEndpoint.statusCode, 401, ownerCannotUseAdminEndpoint.body);
  } finally {
    await close();
    if (previousDemoAuthFallback === undefined) delete process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK;
    else process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = previousDemoAuthFallback;
  }
});

test("检测站小程序使用同一后台会话签发 bearer，拒绝其他角色并支持过期与撤销", async () => {
  const { app, database, close } = await fixture("backoffice_operator_bearer");
  const previousEnvironment = process.env.YUXIAOMAN_ENV;
  try {
    const platformSuffix = "operator-bearer";
    const platformCookie = await createPlatformSession(app, database, platformSuffix);
    const ownBooking = await database.prepare<Json>(`
      SELECT b.id, b.station_id, s.name AS station_name
      FROM bookings b
      JOIN stations s ON s.id = b.station_id
      ORDER BY CASE WHEN b.status = 'confirmed' AND b.service_mode = 'self_drive' THEN 0 ELSE 1 END,
        b.created_at, b.id
      LIMIT 1
    `).get();
    assert.ok(ownBooking);
    await database.prepare(`
      UPDATE bookings
      SET status = 'confirmed', fulfillment_status = 'confirmed', service_mode = 'self_drive'
      WHERE id = ?
    `).run(ownBooking.id);
    const otherStation = await database.prepare<Json>(`
      SELECT id FROM stations WHERE id <> ? ORDER BY id LIMIT 1
    `).get(ownBooking.station_id);
    const otherBooking = await database.prepare<Json>(`
      SELECT id FROM bookings WHERE id <> ? ORDER BY created_at, id LIMIT 1
    `).get(ownBooking.id);
    assert.ok(otherStation && otherBooking);
    await database.prepare("UPDATE bookings SET station_id = ? WHERE id = ?")
      .run(otherStation.id, otherBooking.id);

    const stationPassword = "inspection bearer password 2026";
    const invitation = await inviteStationAdmin(
      app,
      platformCookie,
      ownBooking.station_id,
      "bearer",
    );
    const activated = await activate(app, invitation.activation.token, stationPassword);

    const signedIn = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: { loginName: "station.bearer", password: stationPassword },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(signedIn.headers["set-cookie"], undefined);
    assert.equal(signedIn.headers["cache-control"], "no-store");
    const operatorSession = signedIn.json<Json>().data;
    assert.match(operatorSession.token, /^yxm_bo_[A-Za-z0-9_-]+$/u);
    assert.equal(operatorSession.account.role, "inspection_station_admin");
    assert.equal(operatorSession.account.loginName, "station.bearer");
    assert.equal(operatorSession.subject.id, ownBooking.station_id);
    const authorization = `Bearer ${operatorSession.token}`;

    const current = await app.inject({
      method: "GET",
      url: "/api/operator/session",
      headers: { authorization },
    });
    assert.equal(current.statusCode, 200, current.body);
    assert.equal(current.json<Json>().data.subject.id, ownBooking.station_id);
    assert.equal(current.json<Json>().data.account.loginName, "station.bearer");
    assert.equal(current.json<Json>().data.token, undefined);

    const ownerBearer = await app.inject({
      method: "GET",
      url: "/api/operator/session",
      headers: { authorization: "Bearer yxm_owner_session_token" },
    });
    assert.equal(ownerBearer.statusCode, 401, ownerBearer.body);
    assert.equal(ownerBearer.json<Json>().error.code, "OPERATOR_AUTHENTICATION_REQUIRED");

    const platformRejected = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: {
        loginName: `platform.${platformSuffix}`,
        password: `correct horse ${platformSuffix} battery staple`,
      },
    });
    assert.equal(platformRejected.statusCode, 403, platformRejected.body);
    assert.equal(platformRejected.json<Json>().error.code, "OPERATOR_ACCOUNT_REQUIRED");

    const store = await database.prepare<Json>("SELECT id FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const washPassword = "wash role bearer password 2026";
    const washInvitation = await inviteStoreAdmin(app, platformCookie, store.id, "bearer-role");
    const washActivated = await activate(app, washInvitation.activation.token, washPassword);
    const washRejected = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: { loginName: "store.bearer-role", password: washPassword },
    });
    assert.equal(washRejected.statusCode, 403, washRejected.body);
    assert.equal(washRejected.json<Json>().error.code, "OPERATOR_ACCOUNT_REQUIRED");

    for (const roleCookie of [platformCookie, washActivated.cookie]) {
      const roleToken = decodeURIComponent(roleCookie.split("=", 2)[1] ?? "");
      const roleBearer = await app.inject({
        method: "GET",
        url: "/api/operator/workbench",
        headers: { authorization: `Bearer ${roleToken}` },
      });
      assert.equal(roleBearer.statusCode, 403, roleBearer.body);
      assert.equal(roleBearer.json<Json>().error.code, "OPERATOR_ACCOUNT_REQUIRED");
    }

    const crossStation = await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${otherBooking.id}`,
      headers: { authorization },
    });
    assert.equal(crossStation.statusCode, 404, crossStation.body);
    assert.equal(crossStation.json<Json>().error.code, "BACKOFFICE_RESOURCE_NOT_FOUND");

    process.env.YUXIAOMAN_ENV = "production";
    const nativeWrite = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${ownBooking.id}/accept`,
      headers: { authorization },
    });
    assert.equal(nativeWrite.statusCode, 200, nativeWrite.body);
    const cookieWrite = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${ownBooking.id}/accept`,
      headers: { cookie: activated.cookie },
    });
    assert.equal(cookieWrite.statusCode, 403, cookieWrite.body);
    assert.equal(cookieWrite.json<Json>().error.code, "BACKOFFICE_ORIGIN_FORBIDDEN");
    process.env.YUXIAOMAN_ENV = previousEnvironment ?? "test";

    await database.prepare(`
      UPDATE backoffice_sessions SET expires_at = NOW() - INTERVAL '1 minute'
      WHERE account_id = ?
    `).run(operatorSession.account.id);
    const expired = await app.inject({
      method: "GET",
      url: "/api/operator/session",
      headers: { authorization },
    });
    assert.equal(expired.statusCode, 401, expired.body);

    const replacementLogin = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: { loginName: "station.bearer", password: stationPassword },
    });
    assert.equal(replacementLogin.statusCode, 200, replacementLogin.body);
    const replacementAuthorization = `Bearer ${replacementLogin.json<Json>().data.token}`;
    const logout = await app.inject({
      method: "DELETE",
      url: "/api/operator/session",
      headers: { authorization: replacementAuthorization },
    });
    assert.equal(logout.statusCode, 204, logout.body);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/operator/session",
      headers: { authorization: replacementAuthorization },
    });
    assert.equal(revoked.statusCode, 401, revoked.body);
  } finally {
    process.env.YUXIAOMAN_ENV = previousEnvironment ?? "test";
    await close();
  }
});

test("同一门店已有待激活邀请时稳定返回 409 且不遗留第二个账号", async () => {
  const { app, database, close } = await fixture("backoffice_pending_invitation");
  try {
    const platformCookie = await createPlatformSession(app, database, "pending-invitation");
    const store = await database.prepare<Json>("SELECT id FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const first = await inviteStoreAdmin(app, platformCookie, store.id, "pending-first");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      headers: { cookie: platformCookie },
      payload: {
        loginName: "store.pending-second",
        displayName: "第二位待激活管理员",
        role: "wash_store_admin",
        subject: { type: "wash_store", id: store.id },
      },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(duplicate.json<Json>().error.code, "BACKOFFICE_SUBJECT_INVITATION_PENDING");

    const assignments = await database.prepare<Json>(`
      SELECT account_id, status FROM backoffice_subject_assignments
      WHERE subject_type = 'wash_store' AND subject_id = ? AND status IN ('active', 'pending')
    `).all(store.id);
    assert.deepEqual(assignments, [{ account_id: first.account.id, status: "pending" }]);
    const leakedAccount = await database.prepare<Json>(`
      SELECT id FROM backoffice_accounts WHERE login_name_normalized = 'store.pending-second'
    `).get();
    assert.equal(leakedAccount, undefined);
  } finally {
    await close();
  }
});

test("待激活或已绑定服务商账号的门店拒绝删除且不产生悬空绑定、邀请或会话", async () => {
  const { app, database, close } = await fixture("backoffice_store_delete_guard");
  try {
    const platformCookie = await createPlatformSession(app, database, "store-delete-guard");
    const pendingStore = await createUnreferencedWashStore(app, platformCookie, "pending");
    const activeStore = await createUnreferencedWashStore(app, platformCookie, "active");

    const pendingInvitation = await inviteStoreAdmin(
      app,
      platformCookie,
      pendingStore.id,
      "delete-pending",
    );
    const activeInvitation = await inviteStoreAdmin(
      app,
      platformCookie,
      activeStore.id,
      "delete-active",
    );
    const activeAdmin = await activate(
      app,
      activeInvitation.activation.token,
      "active delete guard password 2026",
    );

    for (const storeId of [pendingStore.id, activeStore.id]) {
      const deletion = await app.inject({
        method: "DELETE",
        url: `/api/admin/wash/stores/${storeId}`,
        headers: { cookie: platformCookie },
      });
      assert.equal(deletion.statusCode, 409, deletion.body);
      assert.equal(deletion.json<Json>().error.code, "WASH_STORE_BACKOFFICE_ACCESS_EXISTS");
    }

    const pendingState = await database.prepare<Json>(`
      SELECT store.id AS store_id, account.status AS account_status,
        assignment.status AS assignment_status,
        invite.consumed_at, invite.invalidated_at,
        (SELECT COUNT(*)::int FROM backoffice_sessions session
          WHERE session.account_id = account.id) AS session_count
      FROM wash_stores store
      JOIN backoffice_subject_assignments assignment
        ON assignment.subject_type = 'wash_store' AND assignment.subject_id = store.id
      JOIN backoffice_accounts account ON account.id = assignment.account_id
      JOIN backoffice_invites invite ON invite.account_id = account.id
      WHERE store.id = ? AND account.id = ?
    `).get(pendingStore.id, pendingInvitation.account.id);
    assert.deepEqual(pendingState, {
      store_id: pendingStore.id,
      account_status: "pending_activation",
      assignment_status: "pending",
      consumed_at: null,
      invalidated_at: null,
      session_count: 0,
    });

    const activeState = await database.prepare<Json>(`
      SELECT store.id AS store_id, account.status AS account_status,
        assignment.status AS assignment_status,
        invite.consumed_at, invite.invalidated_at,
        COUNT(session.id)::int AS active_session_count
      FROM wash_stores store
      JOIN backoffice_subject_assignments assignment
        ON assignment.subject_type = 'wash_store' AND assignment.subject_id = store.id
      JOIN backoffice_accounts account ON account.id = assignment.account_id
      JOIN backoffice_invites invite ON invite.account_id = account.id
      LEFT JOIN backoffice_sessions session
        ON session.account_id = account.id AND session.revoked_at IS NULL
      WHERE store.id = ? AND account.id = ?
      GROUP BY store.id, account.status, assignment.status, invite.consumed_at, invite.invalidated_at
    `).get(activeStore.id, activeInvitation.account.id);
    assert.equal(activeState?.store_id, activeStore.id);
    assert.equal(activeState?.account_status, "active");
    assert.equal(activeState?.assignment_status, "active");
    assert.ok(activeState?.consumed_at);
    assert.equal(activeState?.invalidated_at, null);
    assert.equal(activeState?.active_session_count, 1);

    const stillAuthorized = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie: activeAdmin.cookie },
    });
    assert.equal(stillAuthorized.statusCode, 200, stillAuthorized.body);
    assert.equal(stillAuthorized.json<Json>().data.subject.id, activeStore.id);
  } finally {
    await close();
  }
});

test("邀请严格执行 24 小时过期与单次消费且失败激活不创建会话", async () => {
  const { app, database, close } = await fixture("backoffice_invitation_lifecycle");
  try {
    const platformCookie = await createPlatformSession(app, database, "invitation-lifecycle");
    const stores = await database.prepare<Json>("SELECT id FROM wash_stores ORDER BY id LIMIT 2").all();
    assert.equal(stores.length, 2);

    const expiredInvite = await inviteStoreAdmin(app, platformCookie, stores[0].id, "expired");
    await database.prepare(`
      UPDATE backoffice_invites SET expires_at = NOW() - INTERVAL '1 minute'
      WHERE account_id = ? AND consumed_at IS NULL
    `).run(expiredInvite.account.id);
    const expired = await app.inject({
      method: "POST",
      url: "/api/backoffice/activations",
      payload: { token: expiredInvite.activation.token, password: "expired invitation password 2026" },
    });
    assert.equal(expired.statusCode, 410, expired.body);
    assert.equal(expired.json<Json>().error.code, "BACKOFFICE_INVITE_INVALID");
    assert.equal(expired.headers["set-cookie"], undefined);
    const expiredState = await database.prepare<Json>(`
      SELECT a.status, sa.status AS assignment_status,
        (SELECT COUNT(*)::int FROM backoffice_sessions s WHERE s.account_id = a.id) AS session_count
      FROM backoffice_accounts a
      JOIN backoffice_subject_assignments sa ON sa.account_id = a.id
      WHERE a.id = ?
    `).get(expiredInvite.account.id);
    assert.deepEqual(expiredState, {
      status: "pending_activation",
      assignment_status: "pending",
      session_count: 0,
    });

    const singleUseInvite = await inviteStoreAdmin(app, platformCookie, stores[1].id, "single-use");
    const activated = await activate(
      app,
      singleUseInvite.activation.token,
      "single use invitation password 2026",
    );
    assert.equal(activated.data.account.id, singleUseInvite.account.id);
    const replay = await app.inject({
      method: "POST",
      url: "/api/backoffice/activations",
      payload: { token: singleUseInvite.activation.token, password: "another valid password 2026" },
    });
    assert.equal(replay.statusCode, 410, replay.body);
    assert.equal(replay.json<Json>().error.code, "BACKOFFICE_INVITE_INVALID");
    assert.equal(replay.headers["set-cookie"], undefined);
    const sessionCount = await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_sessions WHERE account_id = ?
    `).get(singleUseInvite.account.id);
    assert.equal(sessionCount?.count, 1);
  } finally {
    await close();
  }
});

test("更换门店管理员在新账号激活前保留旧账号，激活事务原子撤销旧绑定与会话", async () => {
  const { app, database, close } = await fixture("backoffice_replacement");
  try {
    const platformCookie = await createPlatformSession(app, database, "replacement");
    const store = await database.prepare<Json>("SELECT id FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const firstInvite = await inviteStoreAdmin(app, platformCookie, store.id, "first");
    const first = await activate(app, firstInvite.activation.token, "first manager password 2026");
    const firstAccountId = first.data.account.id;

    const replacementResponse = await app.inject({
      method: "POST",
      url: `/api/admin/backoffice/accounts/${firstAccountId}/replacements`,
      headers: { cookie: platformCookie },
      payload: { loginName: "store.second", displayName: "第二任管理员" },
    });
    assert.equal(replacementResponse.statusCode, 201, replacementResponse.body);
    const replacement = replacementResponse.json<Json>().data;

    const stillActive = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie: first.cookie },
    });
    assert.equal(stillActive.statusCode, 200, stillActive.body);

    const second = await activate(app, replacement.activation.token, "second manager password 2026");
    assert.equal(second.data.subject.id, store.id);
    const oldRevoked = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie: first.cookie },
    });
    assert.equal(oldRevoked.statusCode, 401, oldRevoked.body);

    const accounts = await database.prepare<Json>(`
      SELECT a.id, a.status, sa.status AS assignment_status
      FROM backoffice_accounts a
      LEFT JOIN backoffice_subject_assignments sa ON sa.account_id = a.id
      WHERE a.id IN (?, ?)
      ORDER BY a.id
    `).all(firstAccountId, second.data.account.id);
    assert.equal(accounts.find((item) => item.id === firstAccountId)?.status, "disabled");
    assert.equal(accounts.find((item) => item.id === firstAccountId)?.assignment_status, "revoked");
    assert.equal(accounts.find((item) => item.id === second.data.account.id)?.assignment_status, "active");
  } finally {
    await close();
  }
});

test("洗车店 A/B 的门店、媒体、报价、号源、订单和核销在 SQL 边界隔离", async () => {
  const { app, database, close } = await fixture("backoffice_wash_tenant_scope");
  try {
    const platformCookie = await createPlatformSession(app, database, "wash-scope");
    const stores = await database.prepare<Json>("SELECT * FROM wash_stores ORDER BY id LIMIT 2").all();
    assert.equal(stores.length, 2);
    const [storeA, storeB] = stores;
    const adminA = await activate(
      app,
      (await inviteStoreAdmin(app, platformCookie, storeA.id, "wash-a")).activation.token,
      "wash store A password 2026",
    );
    const adminB = await activate(
      app,
      (await inviteStoreAdmin(app, platformCookie, storeB.id, "wash-b")).activation.token,
      "wash store B password 2026",
    );

    const listA = await app.inject({ method: "GET", url: "/api/admin/wash/stores", headers: { cookie: adminA.cookie } });
    assert.equal(listA.statusCode, 200, listA.body);
    assert.deepEqual(listA.json<Json>().data.map((item: Json) => item.id), [storeA.id]);
    const providerStore = listA.json<Json>().data[0];
    assert.equal("legalName" in providerStore, true);
    for (const platformOnlyField of ["rating", "reviewCount", "dataKind", "sortPriority", "internalContact", "createdAt", "updatedAt"]) {
      assert.equal(platformOnlyField in providerStore, false, platformOnlyField);
    }
    for (const image of providerStore.images ?? []) assert.equal("dataKind" in image, false);

    const offerA = await database.prepare<Json>(`
      SELECT * FROM wash_store_offers WHERE store_id = ? ORDER BY package_id, vehicle_category LIMIT 1
    `).get(storeA.id);
    assert.ok(offerA);
    const preservedOffer = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/stores/${storeA.id}/offers`,
      headers: { cookie: adminA.cookie },
      payload: {
        offers: [{
          packageId: offerA.package_id,
          vehicleCategory: offerA.vehicle_category,
          salePriceFen: Number(offerA.sale_price_fen),
          listPriceFen: 999_999,
          estimatedSettlementFen: 1,
          isAvailable: true,
        }],
      },
    });
    assert.equal(preservedOffer.statusCode, 200, preservedOffer.body);
    const storedOffer = await database.prepare<Json>(`
      SELECT * FROM wash_store_offers WHERE store_id = ? AND package_id = ? AND vehicle_category = ?
    `).get(storeA.id, offerA.package_id, offerA.vehicle_category);
    assert.equal(Number(storedOffer?.list_price_fen), Number(offerA.list_price_fen));
    assert.equal(Number(storedOffer?.estimated_settlement_fen), Number(offerA.estimated_settlement_fen));

    const crossOffers = await app.inject({
      method: "GET",
      url: `/api/admin/wash/stores/${storeB.id}/offers`,
      headers: { cookie: adminA.cookie },
    });
    assert.equal(crossOffers.statusCode, 404, crossOffers.body);
    const forbiddenValetRule = await app.inject({
      method: "GET",
      url: `/api/admin/wash/stores/${storeA.id}/valet-rule`,
      headers: { cookie: adminA.cookie },
    });
    assert.equal(forbiddenValetRule.statusCode, 403, forbiddenValetRule.body);

    const slotB = await database.prepare<Json>("SELECT * FROM wash_slots WHERE store_id = ? ORDER BY id LIMIT 1").get(storeB.id);
    assert.ok(slotB);
    const crossSlotList = await app.inject({
      method: "GET",
      url: `/api/admin/wash/slots?storeId=${encodeURIComponent(storeB.id)}`,
      headers: { cookie: adminA.cookie },
    });
    assert.equal(crossSlotList.statusCode, 404, crossSlotList.body);
    const crossSlotWrite = await app.inject({
      method: "PATCH",
      url: `/api/admin/wash/slots/${slotB.id}`,
      headers: { cookie: adminA.cookie },
      payload: { capacity: Number(slotB.capacity) },
    });
    assert.equal(crossSlotWrite.statusCode, 404, crossSlotWrite.body);

    const imageId = "11111111-1111-4111-8111-111111111111";
    await database.prepare(`
      INSERT INTO wash_store_images (
        id, store_id, storage_key, mime_type, size_bytes, width, height,
        sort_order, is_cover, data_kind, created_at
      ) VALUES (?, ?, ?, 'image/jpeg', 10, 1, 1, 99, 0, 'demo', ?)
    `).run(imageId, storeB.id, `${imageId}.jpg`, new Date().toISOString());
    const crossImage = await app.inject({
      method: "GET",
      url: `/api/admin/wash/store-images/${imageId}`,
      headers: { cookie: adminA.cookie },
    });
    assert.equal(crossImage.statusCode, 404, crossImage.body);

    const user = await database.prepare<Json>("SELECT id FROM users ORDER BY id LIMIT 1").get();
    const vehicle = await database.prepare<Json>("SELECT * FROM vehicles WHERE deleted_at IS NULL ORDER BY id LIMIT 1").get();
    const offerB = await database.prepare<Json>(`
      SELECT o.*, p.name AS package_name FROM wash_store_offers o
      JOIN wash_packages p ON p.id = o.package_id
      WHERE o.store_id = ? ORDER BY o.package_id, o.vehicle_category LIMIT 1
    `).get(storeB.id);
    assert.ok(user && vehicle && offerB);
    const now = new Date().toISOString();
    const quoteId = "wash-tenant-quote-b";
    const orderId = "wash-tenant-order-b";
    const vehicleSnapshot = JSON.stringify({
      plateNumber: vehicle.plate_number,
      vehicleType: vehicle.vehicle_type,
      seats: vehicle.seats,
      privateOwnerFact: "must-not-leak",
    });
    const storeSnapshot = JSON.stringify({ id: storeB.id, name: storeB.name });
    const packageSnapshot = JSON.stringify({ id: offerB.package_id, name: offerB.package_name, serviceItems: [] });
    const slotSnapshot = JSON.stringify({
      id: slotB.id,
      date: slotB.date,
      startTime: slotB.start_time,
      endTime: slotB.end_time,
    });
    await database.prepare(`
      INSERT INTO wash_quote_snapshots (
        id, user_id, vehicle_id, store_id, package_id, slot_id, vehicle_category,
        sale_price_fen, list_price_fen, estimated_settlement_fen, wash_fee_fen, total_fee_fen,
        vehicle_snapshot_json, store_snapshot_json, package_snapshot_json, slot_snapshot_json,
        offer_version, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tenant-test', ?, ?)
    `).run(
      quoteId, user.id, vehicle.id, storeB.id, offerB.package_id, slotB.id, offerB.vehicle_category,
      offerB.sale_price_fen, offerB.list_price_fen, offerB.estimated_settlement_fen,
      offerB.sale_price_fen, offerB.sale_price_fen, vehicleSnapshot, storeSnapshot, packageSnapshot,
      slotSnapshot, now, new Date(Date.now() + 600_000).toISOString(),
    );
    await database.prepare(`
      INSERT INTO wash_orders (
        id, order_number, idempotency_key, user_id, vehicle_id, store_id, package_id, slot_id,
        quote_snapshot_id, vehicle_category, contact_name, contact_phone, wash_fee_fen,
        total_fee_fen, estimated_settlement_fen, status, payment_status, redemption_code,
        notes, internal_note, appointment_date, start_time, end_time, vehicle_snapshot_json,
        store_snapshot_json, package_snapshot_json, slot_snapshot_json, hold_expires_at,
        paid_at, created_at, updated_at
      ) VALUES (?, 'WASHTENANTB', 'wash-tenant-order-key', ?, ?, ?, ?, ?, ?, ?,
        '隐私姓名', '13900000000', ?, ?, ?, 'awaiting_redemption', 'paid', '654321',
        '车主备注隐私', '平台内部备注', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId, user.id, vehicle.id, storeB.id, offerB.package_id, slotB.id, quoteId,
      offerB.vehicle_category, offerB.sale_price_fen, offerB.sale_price_fen,
      offerB.estimated_settlement_fen, slotB.date, slotB.start_time, slotB.end_time,
      vehicleSnapshot, storeSnapshot, packageSnapshot, slotSnapshot,
      new Date(Date.now() + 900_000).toISOString(), now, now, now,
    );
    await database.prepare(`
      INSERT INTO wash_order_settlements (id, order_id, status, amount_fen, updated_at)
      VALUES ('wash-tenant-settlement-b', ?, 'unsettled', ?, ?)
    `).run(orderId, offerB.estimated_settlement_fen, now);

    const expectedOrderCountA = Number((await database.prepare<Json>(`
      SELECT COUNT(*)::text AS count FROM wash_orders WHERE store_id = ?
    `).get(storeA.id))?.count ?? 0);
    const pagedOrdersA = await app.inject({
      method: "GET",
      url: "/api/admin/wash/orders?page=1&pageSize=1",
      headers: { cookie: adminA.cookie },
    });
    assert.equal(pagedOrdersA.statusCode, 200, pagedOrdersA.body);
    assert.equal(pagedOrdersA.json<Json>().data.total, expectedOrderCountA);
    assert.ok(pagedOrdersA.json<Json>().data.items.length <= 1);
    assert.ok(pagedOrdersA.json<Json>().data.items.every((item: Json) => item.storeId === storeA.id));
    const crossPagedOrders = await app.inject({
      method: "GET",
      url: `/api/admin/wash/orders?storeId=${encodeURIComponent(storeB.id)}&page=1&pageSize=1`,
      headers: { cookie: adminA.cookie },
    });
    assert.equal(crossPagedOrders.statusCode, 404, crossPagedOrders.body);

    const crossOrder = await app.inject({
      method: "GET",
      url: `/api/admin/wash/orders/${orderId}`,
      headers: { cookie: adminA.cookie },
    });
    assert.equal(crossOrder.statusCode, 404, crossOrder.body);
    const ownOrder = await app.inject({
      method: "GET",
      url: `/api/admin/wash/orders/${orderId}`,
      headers: { cookie: adminB.cookie },
    });
    assert.equal(ownOrder.statusCode, 200, ownOrder.body);
    const dto = ownOrder.json<Json>().data;
    for (const forbidden of [
      "contactName", "contactPhone", "pickupAddress", "redemptionCode", "verificationCode",
      "notes", "internalNote", "payments", "events", "quoteSnapshotId",
    ]) assert.equal(forbidden in dto, false, forbidden);
    assert.equal(dto.vehiclePlate, vehicle.plate_number);

    const existingCodes = new Set((await database.prepare<Json>(`
      SELECT redemption_code FROM wash_orders WHERE redemption_code IS NOT NULL
    `).all()).map((item) => String(item.redemption_code)));
    const unusedCodes: string[] = [];
    for (let candidate = 0; candidate <= 999_999 && unusedCodes.length < 10; candidate += 1) {
      const code = String(candidate).padStart(6, "0");
      if (!existingCodes.has(code)) unusedCodes.push(code);
    }
    assert.equal(unusedCodes.length, 10);
    const unknownRedeem = await app.inject({
      method: "POST",
      url: "/api/admin/wash/orders/redeem",
      headers: { cookie: adminA.cookie },
      payload: { code: unusedCodes[0] },
    });
    assert.equal(unknownRedeem.statusCode, 404, unknownRedeem.body);
    assert.equal(unknownRedeem.json<Json>().error.code, "WASH_ORDER_NOT_FOUND");
    const crossRedeem = await app.inject({
      method: "POST",
      url: "/api/admin/wash/orders/redeem",
      headers: { cookie: adminA.cookie },
      payload: { code: "654321" },
    });
    assert.equal(crossRedeem.statusCode, 404, crossRedeem.body);
    assert.equal(crossRedeem.json<Json>().error.code, unknownRedeem.json<Json>().error.code);
    for (const code of unusedCodes.slice(1, 9)) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/admin/wash/orders/redeem",
        headers: { cookie: adminA.cookie },
        payload: { code },
      });
      assert.equal(failed.statusCode, 404, failed.body);
    }
    const limitedRedeem = await app.inject({
      method: "POST",
      url: "/api/admin/wash/orders/redeem",
      headers: { cookie: adminA.cookie },
      payload: { code: unusedCodes[9] },
    });
    assert.equal(limitedRedeem.statusCode, 429, limitedRedeem.body);
    assert.equal(limitedRedeem.json<Json>().error.code, "WASH_REDEMPTION_RATE_LIMITED");
    const ownRedeem = await app.inject({
      method: "POST",
      url: "/api/admin/wash/orders/redeem",
      headers: { cookie: adminB.cookie },
      payload: { code: "654321", operator: "伪造操作人" },
    });
    assert.equal(ownRedeem.statusCode, 200, ownRedeem.body);
    assert.equal("redemptionCode" in ownRedeem.json<Json>().data, false);
    const event = await database.prepare<Json>(`
      SELECT metadata_json FROM wash_order_events WHERE order_id = ? AND status = 'redeemed'
    `).get(orderId);
    const eventMetadata = typeof event?.metadata_json === "string"
      ? JSON.parse(event.metadata_json)
      : event?.metadata_json;
    assert.equal(eventMetadata.operator, "门店管理员 wash-b");

    const forbiddenSettlement = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/orders/${orderId}/settlement`,
      headers: { cookie: adminB.cookie },
      payload: { amountFen: 1, operator: "伪造操作人" },
    });
    assert.equal(forbiddenSettlement.statusCode, 403, forbiddenSettlement.body);
  } finally {
    await close();
  }
});

test("洗车关键写入与审计同事务且审计失败会回滚业务变更", async () => {
  const { app, database, close } = await fixture("backoffice_wash_audit_atomicity");
  try {
    const platformCookie = await createPlatformSession(app, database, "wash-audit-atomicity");
    const store = await createUnreferencedWashStore(app, platformCookie, "audit-atomicity");
    const invitation = await inviteStoreAdmin(
      app,
      platformCookie,
      store.id,
      "audit-atomicity",
    );
    const provider = await activate(
      app,
      invitation.activation.token,
      "audit atomicity password 2026",
    );

    const storeList = await app.inject({
      method: "GET",
      url: "/api/admin/wash/stores",
      headers: { cookie: provider.cookie },
    });
    assert.equal(storeList.statusCode, 200, storeList.body);
    const editableStore = storeList.json<Json>().data[0];
    assert.equal(editableStore.id, store.id);

    const firstDescription = "服务商正常修改并形成可信前后快照";
    const successfulUpdate = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}`,
      headers: { cookie: provider.cookie },
      payload: { ...editableStore, description: firstDescription },
    });
    assert.equal(successfulUpdate.statusCode, 200, successfulUpdate.body);

    const successfulAudit = await database.prepare<Json>(`
      SELECT id, before_json, after_json
      FROM backoffice_audit_events
      WHERE action = 'wash.store.update'
        AND resource_type = 'wash_store' AND resource_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `).get(store.id);
    assert.ok(successfulAudit);
    const before = typeof successfulAudit.before_json === "string"
      ? JSON.parse(successfulAudit.before_json)
      : successfulAudit.before_json;
    const after = typeof successfulAudit.after_json === "string"
      ? JSON.parse(successfulAudit.after_json)
      : successfulAudit.after_json;
    assert.equal(before.description, store.description);
    assert.equal(after.description, firstDescription);

    await database.query(`
      CREATE OR REPLACE FUNCTION fail_test_wash_store_update_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'wash.store.update' THEN
          RAISE EXCEPTION 'forced wash store audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await database.query(`
      CREATE TRIGGER fail_test_wash_store_update_audit
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_wash_store_update_audit()
    `);

    const auditCountBeforeFailure = await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events
      WHERE action = 'wash.store.update' AND resource_id = ?
    `).get(store.id);
    const failedDescription = "这次修改必须随审计插入失败一起回滚";
    const failedUpdate = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}`,
      headers: { cookie: provider.cookie },
      payload: { ...editableStore, description: failedDescription },
    });
    assert.equal(failedUpdate.statusCode, 500, failedUpdate.body);

    const persistedStore = await database.prepare<Json>(`
      SELECT description FROM wash_stores WHERE id = ?
    `).get(store.id);
    assert.equal(persistedStore?.description, firstDescription);
    const auditCountAfterFailure = await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events
      WHERE action = 'wash.store.update' AND resource_id = ?
    `).get(store.id);
    assert.equal(auditCountAfterFailure?.count, auditCountBeforeFailure?.count);
  } finally {
    await close();
  }
});

test("洗车同值保存不产生语义审计且结算审计不记录自由文本，重复核销仍留痕", async () => {
  const { app, database, close } = await fixture("backoffice_wash_semantic_noop");
  try {
    const platformCookie = await createPlatformSession(app, database, "wash-semantic-noop");
    const headers = { cookie: platformCookie };
    const auditCount = async (action: string, resourceId: string): Promise<number> => Number((await database.prepare<Json>(`
      SELECT COUNT(*)::integer AS count
      FROM backoffice_audit_events
      WHERE action = ? AND resource_id = ?
    `).get(action, resourceId))?.count ?? 0);

    const storesResponse = await app.inject({ method: "GET", url: "/api/admin/wash/stores", headers });
    assert.equal(storesResponse.statusCode, 200, storesResponse.body);
    const store = storesResponse.json<Json>().data[0];
    assert.ok(store);
    const storeAuditBefore = await auditCount("wash.store.update", store.id);
    const sameStore = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}`,
      headers,
      payload: store,
    });
    assert.equal(sameStore.statusCode, 200, sameStore.body);
    assert.equal(await auditCount("wash.store.update", store.id), storeAuditBefore);

    const offersResponse = await app.inject({
      method: "GET",
      url: `/api/admin/wash/stores/${store.id}/offers`,
      headers,
    });
    assert.equal(offersResponse.statusCode, 200, offersResponse.body);
    const offers = offersResponse.json<Json>().data;
    assert.ok(offers.length > 0);
    const offersAuditBefore = await auditCount("wash.store_offers.update", store.id);
    const sameOffers = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}/offers`,
      headers,
      payload: {
        offers: offers.map((offer: Json) => ({
          packageId: offer.packageId,
          vehicleCategory: offer.vehicleCategory,
          salePriceFen: offer.salePriceFen,
          listPriceFen: offer.listPriceFen,
          estimatedSettlementFen: offer.estimatedSettlementFen,
          isAvailable: offer.isAvailable,
        })),
      },
    });
    assert.equal(sameOffers.statusCode, 200, sameOffers.body);
    assert.equal(await auditCount("wash.store_offers.update", store.id), offersAuditBefore);

    const slot = await database.prepare<Json>(`
      SELECT * FROM wash_slots WHERE store_id = ? ORDER BY date, start_time LIMIT 1
    `).get(store.id);
    assert.ok(slot);
    const slotAuditBefore = await auditCount("wash.slot.update", slot.id);
    const sameSlot = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/slots/${slot.id}`,
      headers,
      payload: {
        date: slot.date,
        startTime: slot.start_time,
        endTime: slot.end_time,
        capacity: Number(slot.capacity),
        isOpen: Boolean(slot.is_open),
      },
    });
    assert.equal(sameSlot.statusCode, 200, sameSlot.body);
    assert.equal(await auditCount("wash.slot.update", slot.id), slotAuditBefore);

    const user = await database.prepare<Json>("SELECT id FROM users ORDER BY id LIMIT 1").get();
    const vehicle = await database.prepare<Json>(`
      SELECT * FROM vehicles WHERE deleted_at IS NULL ORDER BY id LIMIT 1
    `).get();
    const offer = await database.prepare<Json>(`
      SELECT o.*, p.name AS package_name
      FROM wash_store_offers o
      JOIN wash_packages p ON p.id = o.package_id
      WHERE o.store_id = ? AND o.is_available = 1
      ORDER BY o.package_id, o.vehicle_category LIMIT 1
    `).get(store.id);
    assert.ok(user && vehicle && offer);
    const now = new Date().toISOString();
    const quoteId = randomUUID();
    const orderId = randomUUID();
    const redemptionCode = "778899";
    const vehicleSnapshot = JSON.stringify({
      plateNumber: vehicle.plate_number,
      vehicleType: vehicle.vehicle_type,
      seats: vehicle.seats,
    });
    const storeSnapshot = JSON.stringify({ id: store.id, name: store.name });
    const packageSnapshot = JSON.stringify({ id: offer.package_id, name: offer.package_name, serviceItems: [] });
    const slotSnapshot = JSON.stringify({
      id: slot.id,
      date: slot.date,
      startTime: slot.start_time,
      endTime: slot.end_time,
    });
    await database.prepare(`
      INSERT INTO wash_quote_snapshots (
        id, user_id, vehicle_id, store_id, package_id, slot_id, vehicle_category,
        sale_price_fen, list_price_fen, estimated_settlement_fen, wash_fee_fen, total_fee_fen,
        vehicle_snapshot_json, store_snapshot_json, package_snapshot_json, slot_snapshot_json,
        offer_version, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'semantic-noop-test', ?, ?)
    `).run(
      quoteId, user.id, vehicle.id, store.id, offer.package_id, slot.id, offer.vehicle_category,
      offer.sale_price_fen, offer.list_price_fen, offer.estimated_settlement_fen,
      offer.sale_price_fen, offer.sale_price_fen, vehicleSnapshot, storeSnapshot, packageSnapshot,
      slotSnapshot, now, new Date(Date.now() + 600_000).toISOString(),
    );
    await database.prepare(`
      INSERT INTO wash_orders (
        id, order_number, idempotency_key, user_id, vehicle_id, store_id, package_id, slot_id,
        quote_snapshot_id, vehicle_category, contact_name, contact_phone, wash_fee_fen,
        total_fee_fen, estimated_settlement_fen, status, payment_status, redemption_code,
        appointment_date, start_time, end_time, vehicle_snapshot_json, store_snapshot_json,
        package_snapshot_json, slot_snapshot_json, hold_expires_at, paid_at, redeemed_at,
        created_at, updated_at
      ) VALUES (?, 'WASHSEMANTICNOOP', ?, ?, ?, ?, ?, ?, ?, ?, '结算测试车主', '13900001111',
        ?, ?, ?, 'redeemed', 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId, `wash-semantic-noop-${orderId}`, user.id, vehicle.id, store.id, offer.package_id,
      slot.id, quoteId, offer.vehicle_category, offer.sale_price_fen, offer.sale_price_fen,
      offer.estimated_settlement_fen, redemptionCode, slot.date, slot.start_time, slot.end_time,
      vehicleSnapshot, storeSnapshot, packageSnapshot, slotSnapshot,
      new Date(Date.now() + 900_000).toISOString(), now, now, now, now,
    );
    await database.prepare(`
      INSERT INTO wash_order_settlements (id, order_id, status, amount_fen, updated_at)
      VALUES (?, ?, 'unsettled', ?, ?)
    `).run(randomUUID(), orderId, offer.estimated_settlement_fen, now);

    const sensitiveReason = "结算修正密语-不得进入后台审计";
    const sensitiveNote = "结算备注密语-不得进入后台审计";
    const settlementPayload = {
      status: "settled",
      amountFen: Number(offer.estimated_settlement_fen),
      reason: sensitiveReason,
      note: sensitiveNote,
    };
    const settled = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/orders/${orderId}/settlement`,
      headers,
      payload: settlementPayload,
    });
    assert.equal(settled.statusCode, 200, settled.body);
    const settlementAudit = await database.prepare<Json>(`
      SELECT before_json, after_json, metadata_json
      FROM backoffice_audit_events
      WHERE action = 'wash.settlement.update' AND resource_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1
    `).get(orderId);
    assert.ok(settlementAudit);
    const auditSerialized = JSON.stringify(settlementAudit);
    assert.doesNotMatch(auditSerialized, new RegExp(`${sensitiveReason}|${sensitiveNote}`, "u"));
    const auditBefore = typeof settlementAudit.before_json === "string"
      ? JSON.parse(settlementAudit.before_json)
      : settlementAudit.before_json;
    const auditAfter = typeof settlementAudit.after_json === "string"
      ? JSON.parse(settlementAudit.after_json)
      : settlementAudit.after_json;
    const safeSettlementKeys = ["amountFen", "settledAt", "status", "updatedAt"];
    assert.deepEqual(Object.keys(auditBefore).sort(), safeSettlementKeys.slice().sort());
    assert.deepEqual(Object.keys(auditAfter).sort(), safeSettlementKeys.slice().sort());

    const settlementAuditBeforeRepeat = await auditCount("wash.settlement.update", orderId);
    const repeatedSettlement = await app.inject({
      method: "PUT",
      url: `/api/admin/wash/orders/${orderId}/settlement`,
      headers,
      payload: settlementPayload,
    });
    assert.equal(repeatedSettlement.statusCode, 200, repeatedSettlement.body);
    assert.equal(await auditCount("wash.settlement.update", orderId), settlementAuditBeforeRepeat);

    const redeemAuditBefore = await auditCount("wash.order.redeem", orderId);
    const repeatedRedeem = await app.inject({
      method: "POST",
      url: "/api/admin/wash/orders/redeem",
      headers,
      payload: { code: redemptionCode },
    });
    assert.equal(repeatedRedeem.statusCode, 200, repeatedRedeem.body);
    assert.equal(await auditCount("wash.order.redeem", orderId), redeemAuditBefore + 1);
  } finally {
    await close();
  }
});

test("密码重置立即撤销旧会话，审计日志脱敏且数据库拒绝改写", async () => {
  const { app, database, close } = await fixture("backoffice_reset_audit");
  try {
    const platformCookie = await createPlatformSession(app, database, "reset");
    const store = await database.prepare<Json>("SELECT id FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const invitation = await inviteStoreAdmin(app, platformCookie, store.id, "reset");
    const first = await activate(app, invitation.activation.token, "original password 2026");

    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/backoffice/accounts/${first.data.account.id}/password-reset`,
      headers: { cookie: platformCookie },
    });
    assert.equal(reset.statusCode, 200, reset.body);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie: first.cookie },
    });
    assert.equal(revoked.statusCode, 401, revoked.body);

    const resetData = reset.json<Json>().data;
    const next = await activate(app, resetData.activation.token, "replacement password 2026");
    assert.equal(next.data.account.id, first.data.account.id);
    const relogin = await login(app, "store.reset", "replacement password 2026");
    assert.ok(relogin.startsWith("yxm_backoffice_session="));

    const auditSecrets = {
      openId: "openid-raw-value",
      unionId: "unionid-raw-value",
      providerSubject: "provider-subject-raw-value",
      storageKey: "private/storage/object.jpg",
      sha256: "sha256-raw-value",
      phoneHmac: "hmac-raw-value",
      cipherText: "cipher-raw-value",
      encryptedPayload: "encrypted-raw-value",
      sessionHash: "session-hash-raw-value",
    };
    await auditBackofficeEvent(database, {
      action: "backoffice.audit.sanitize_probe",
      outcome: "success",
      before: {
        open_id: auditSecrets.openId,
        nested: {
          union_id: auditSecrets.unionId,
          providerSubject: auditSecrets.providerSubject,
          storage_key: auditSecrets.storageKey,
        },
      },
      after: {
        sha256: auditSecrets.sha256,
        phone_hmac: auditSecrets.phoneHmac,
        cipherText: auditSecrets.cipherText,
        encrypted_payload: auditSecrets.encryptedPayload,
        session_hash: auditSecrets.sessionHash,
        safeStatus: "active",
      },
      metadata: {
        provider_subject: auditSecrets.providerSubject,
        safeReason: "sanitization regression coverage",
      },
    });
    const sanitizedAudit = await database.prepare<Json>(`
      SELECT before_json, after_json, metadata_json
      FROM backoffice_audit_events
      WHERE action = 'backoffice.audit.sanitize_probe'
      LIMIT 1
    `).get();
    assert.ok(sanitizedAudit);
    const sanitizedBefore = typeof sanitizedAudit.before_json === "string"
      ? JSON.parse(sanitizedAudit.before_json)
      : sanitizedAudit.before_json;
    const sanitizedAfter = typeof sanitizedAudit.after_json === "string"
      ? JSON.parse(sanitizedAudit.after_json)
      : sanitizedAudit.after_json;
    const sanitizedMetadata = typeof sanitizedAudit.metadata_json === "string"
      ? JSON.parse(sanitizedAudit.metadata_json)
      : sanitizedAudit.metadata_json;
    assert.equal(sanitizedBefore.open_id, "[redacted]");
    assert.deepEqual(sanitizedBefore.nested, {
      union_id: "[redacted]",
      providerSubject: "[redacted]",
      storage_key: "[redacted]",
    });
    assert.deepEqual(sanitizedAfter, {
      sha256: "[redacted]",
      phone_hmac: "[redacted]",
      cipherText: "[redacted]",
      encrypted_payload: "[redacted]",
      session_hash: "[redacted]",
      safeStatus: "active",
    });
    assert.deepEqual(sanitizedMetadata, {
      provider_subject: "[redacted]",
      safeReason: "sanitization regression coverage",
    });
    const sanitizedSerialized = JSON.stringify(sanitizedAudit);
    Object.values(auditSecrets).forEach((secret) => assert.equal(sanitizedSerialized.includes(secret), false));

    const audit = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?page=1&pageSize=100",
      headers: { cookie: platformCookie },
    });
    assert.equal(audit.statusCode, 200, audit.body);
    const auditItems = audit.json<Json>().data.items as Json[];
    assert.ok(auditItems.some((event: Json) => event.actionLabel === "发起密码重置"));
    assert.equal(auditItems.every((event: Json) => !("action" in event) && !("requestId" in event)), true);
    const persisted = JSON.stringify(await database.prepare<Json>(`
      SELECT before_json, after_json, metadata_json FROM backoffice_audit_events
    `).all());
    assert.equal(persisted.includes("original password 2026"), false);
    assert.equal(persisted.includes(resetData.activation.token), false);

    const event = await database.prepare<Json>("SELECT id FROM backoffice_audit_events LIMIT 1").get();
    assert.ok(event);
    await assert.rejects(
      database.prepare("UPDATE backoffice_audit_events SET action = 'tampered' WHERE id = ?").run(event.id),
      /append-only/iu,
    );
  } finally {
    await close();
  }
});

test("运营操作记录的读取不制造新记录且列表只返回中文展示契约", async () => {
  const { app, database, close } = await fixture("backoffice_audit_read_contract");
  try {
    const platformCookie = await createPlatformSession(app, database, "audit-read-contract");
    const countBefore = await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events
    `).get();

    const first = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?page=1&pageSize=100",
      headers: { cookie: platformCookie },
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstData = first.json<Json>().data;
    assert.ok(firstData.items.length > 0);

    const washStores = await app.inject({
      method: "GET",
      url: "/api/admin/wash/stores",
      headers: { cookie: platformCookie },
    });
    assert.equal(washStores.statusCode, 200, washStores.body);
    const refreshed = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?page=1&pageSize=100&keyword=%E5%B9%B3%E5%8F%B0",
      headers: { cookie: platformCookie },
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);

    const countAfter = await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events
    `).get();
    assert.equal(countAfter?.count, countBefore?.count);

    const forbiddenKeys = new Set([
      "action",
      "requestId",
      "request_id",
      "route",
      "before",
      "after",
      "beforeJson",
      "afterJson",
      "metadata",
      "metadataJson",
      "before_json",
      "after_json",
      "metadata_json",
    ]);
    const assertNoTechnicalFields = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(assertNoTechnicalFields);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        assert.equal(forbiddenKeys.has(key), false, `运营列表不应返回技术字段 ${key}`);
        assertNoTechnicalFields(nested);
      }
    };
    for (const item of firstData.items as Json[]) {
      assert.deepEqual(Object.keys(item).sort(), [
        "actionLabel",
        "actor",
        "category",
        "hasDetails",
        "id",
        "occurredAt",
        "outcome",
        "subject",
        "summary",
        "target",
      ]);
      assert.equal(typeof item.actionLabel, "string");
      assert.equal(typeof item.summary, "string");
      assertNoTechnicalFields(item);
    }
  } finally {
    await close();
  }
});

test("运营操作记录默认排除旧技术噪声并提供中文变更与失败原因详情", async () => {
  const { app, database, close } = await fixture("backoffice_audit_visibility_contract");
  try {
    const platformCookie = await createPlatformSession(app, database, "audit-visibility-contract");
    const baseline = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?page=1&pageSize=100",
      headers: { cookie: platformCookie },
    });
    assert.equal(baseline.statusCode, 200, baseline.body);
    const baselineTotal = Number(baseline.json<Json>().meta.total);

    const hiddenIds = await Promise.all([
      auditBackofficeEvent(database, {
        action: "backoffice.http.admin.get",
        outcome: "success",
        resource: { type: "route", id: "/api/admin/wash/stores" },
      }),
      auditBackofficeEvent(database, {
        action: "backoffice.accounts.listed",
        outcome: "success",
        resource: { type: "backoffice_account_collection" },
      }),
      auditBackofficeEvent(database, {
        action: "wash.request.rejected",
        outcome: "denied",
        resource: { type: "route", id: "/api/admin/wash/orders" },
      }),
      auditBackofficeEvent(database, {
        action: "customer.identity.reveal",
        outcome: "success",
        resource: { type: "customer_identity", id: "legacy-customer-identity" },
        presentation: {
          category: "customer",
          actionLabel: "查看客户身份绑定",
          summary: "查看客户身份绑定信息",
        },
      }),
    ]);

    const changedEventId = await auditBackofficeEvent(database, {
      action: "wash.store.update",
      outcome: "success",
      resource: { type: "wash_store", id: "wash-store-audit-detail" },
      presentation: {
        category: "wash",
        actionLabel: "修改洗车门店",
        summary: "将海河演示洗车店调整为停用状态",
        subjectName: "海河演示洗车店",
        resourceLabel: "海河演示洗车店",
        changes: [{ field: "status", label: "经营状态", before: "active", after: "inactive" }],
      },
    });
    const deniedEventId = await auditBackofficeEvent(database, {
      action: "backoffice.authorization.denied",
      outcome: "denied",
      resource: { type: "backoffice_account", id: "restricted-account" },
      presentation: {
        category: "account_security",
        actionLabel: "拒绝越权访问",
        summary: "系统拒绝了无权限的账号管理操作",
        resourceLabel: "后台账号",
        reason: "BACKOFFICE_FORBIDDEN",
      },
    });
    const deniedRouteEventId = await auditBackofficeEvent(database, {
      action: "backoffice.authorization.denied",
      outcome: "denied",
      resource: { type: "route", id: "/api/admin/private-technical-route" },
      metadata: { reason: "BACKOFFICE_FORBIDDEN" },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?page=1&pageSize=100",
      headers: { cookie: platformCookie },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const listedPayload = listed.json<Json>();
    assert.equal(listedPayload.meta.total, baselineTotal + 3);
    const listedIds = (listedPayload.data.items as Json[]).map((item) => item.id);
    assert.ok(listedIds.includes(changedEventId));
    assert.ok(listedIds.includes(deniedEventId));
    assert.ok(listedIds.includes(deniedRouteEventId));
    hiddenIds.forEach((id) => assert.equal(listedIds.includes(id), false));
    const deniedRouteItem = (listedPayload.data.items as Json[]).find((item) => item.id === deniedRouteEventId);
    assert.equal(deniedRouteItem?.target.id, null);
    assert.equal(JSON.stringify(deniedRouteItem).includes("/api/admin/private-technical-route"), false);

    const changedDetail = await app.inject({
      method: "GET",
      url: `/api/admin/audit-events/${changedEventId}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(changedDetail.statusCode, 200, changedDetail.body);
    assert.deepEqual(changedDetail.json<Json>().data.changes, [{
      field: "status",
      label: "经营状态",
      before: "启用",
      after: "停用",
    }]);
    assert.equal(changedDetail.json<Json>().data.reason, null);

    const deniedDetail = await app.inject({
      method: "GET",
      url: `/api/admin/audit-events/${deniedEventId}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(deniedDetail.statusCode, 200, deniedDetail.body);
    assert.equal(deniedDetail.json<Json>().data.reason, "当前账号没有该功能权限");
    assert.equal(deniedDetail.body.includes("BACKOFFICE_FORBIDDEN"), false);
    assert.equal(deniedDetail.body.includes("backoffice.authorization.denied"), false);

    for (const hiddenId of hiddenIds) {
      const hiddenDetail = await app.inject({
        method: "GET",
        url: `/api/admin/audit-events/${hiddenId}`,
        headers: { cookie: platformCookie },
      });
      assert.equal(hiddenDetail.statusCode, 404, hiddenDetail.body);
    }
  } finally {
    await close();
  }
});

test("洗车服务商的操作记录列表与详情均强制本人本店范围", async () => {
  const { app, database, close } = await fixture("backoffice_audit_provider_scope");
  try {
    const platformCookie = await createPlatformSession(app, database, "audit-provider-scope");
    const stores = await database.prepare<Json>(`
      SELECT id, name FROM wash_stores ORDER BY id LIMIT 2
    `).all();
    assert.equal(stores.length, 2);

    const invitationA = await inviteStoreAdmin(app, platformCookie, stores[0].id, "audit-scope-a");
    const invitationB = await inviteStoreAdmin(app, platformCookie, stores[1].id, "audit-scope-b");
    const sessionA = await activate(app, invitationA.activation.token, "audit provider a password 2026");
    const sessionB = await activate(app, invitationB.activation.token, "audit provider b password 2026");

    const providerPrincipal = (
      invitation: Json,
      activated: { data: Json },
    ): BackofficeSession => ({
      sessionId: null,
      permissionVersion: 1,
      account: {
        id: activated.data.account.id,
        loginName: invitation.account.loginName,
        displayName: activated.data.account.displayName,
        role: "wash_store_admin",
      },
      subject: activated.data.subject,
      capabilities: [...WASH_STORE_CAPABILITIES],
      expiresAt: activated.data.expiresAt,
    });
    const principalA = providerPrincipal(invitationA, sessionA);
    const principalB = providerPrincipal(invitationB, sessionB);
    const eventA = await auditBackofficeEvent(database, {
      principal: principalA,
      action: "wash.slot.update",
      outcome: "success",
      resource: { type: "wash_slot", id: "provider-a-slot" },
      presentation: {
        category: "wash",
        actionLabel: "调整洗车预约时段",
        summary: `${stores[0].name}调整了明日预约时段`,
        subjectName: stores[0].name,
        resourceLabel: "明日 09:00-10:00 时段",
        changes: [{ field: "capacity", label: "可预约数量", before: 3, after: 4 }],
      },
    });
    const eventB = await auditBackofficeEvent(database, {
      principal: principalB,
      action: "wash.slot.update",
      outcome: "success",
      resource: { type: "wash_slot", id: "provider-b-slot" },
      presentation: {
        category: "wash",
        actionLabel: "调整洗车预约时段",
        summary: `${stores[1].name}调整了明日预约时段`,
        subjectName: stores[1].name,
        resourceLabel: "明日 10:00-11:00 时段",
        changes: [{ field: "capacity", label: "可预约数量", before: 2, after: 3 }],
      },
    });

    const listA = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?page=1&pageSize=100",
      headers: { cookie: sessionA.cookie },
    });
    assert.equal(listA.statusCode, 200, listA.body);
    const itemsA = listA.json<Json>().data.items as Json[];
    assert.ok(itemsA.some((item) => item.id === eventA));
    assert.equal(itemsA.some((item) => item.id === eventB), false);
    assert.equal(itemsA.every((item) => item.actor.id === principalA.account.id), true);
    assert.equal(itemsA.every((item) => item.subject?.id === stores[0].id), true);

    const ownDetail = await app.inject({
      method: "GET",
      url: `/api/admin/audit-events/${eventA}`,
      headers: { cookie: sessionA.cookie },
    });
    assert.equal(ownDetail.statusCode, 200, ownDetail.body);
    assert.equal(ownDetail.json<Json>().data.id, eventA);

    const crossDetail = await app.inject({
      method: "GET",
      url: `/api/admin/audit-events/${eventB}`,
      headers: { cookie: sessionA.cookie },
    });
    assert.equal(crossDetail.statusCode, 404, crossDetail.body);
    assert.equal(crossDetail.json<Json>().error.code, "BACKOFFICE_RESOURCE_NOT_FOUND");

    for (const url of [
      `/api/admin/audit-events?accountId=${encodeURIComponent(principalB.account.id)}`,
      `/api/admin/audit-events?subjectId=${encodeURIComponent(stores[1].id)}`,
    ]) {
      const crossFilter = await app.inject({ method: "GET", url, headers: { cookie: sessionA.cookie } });
      assert.equal(crossFilter.statusCode, 404, crossFilter.body);
      assert.equal(crossFilter.json<Json>().error.code, "BACKOFFICE_RESOURCE_NOT_FOUND");
    }
  } finally {
    await close();
  }
});

test("账号安全审计保存主体名称快照、忽略重复停用且注销审计失败会回滚会话", async () => {
  const { app, database, close } = await fixture("backoffice_account_audit_atomicity");
  try {
    const platformCookie = await createPlatformSession(app, database, "account-audit-atomicity");
    const store = await database.prepare<Json>("SELECT id, name FROM wash_stores ORDER BY id LIMIT 1").get();
    assert.ok(store);
    const originalStoreName = String(store.name);
    const invitation = await inviteStoreAdmin(app, platformCookie, store.id, "account-audit-target");
    await activate(app, invitation.activation.token, "account audit target password 2026");

    const invitationEvent = await database.prepare<Json>(`
      SELECT id FROM backoffice_audit_events
      WHERE action = 'backoffice.account.invited' AND resource_id = ?
      ORDER BY occurred_at DESC LIMIT 1
    `).get(invitation.account.id);
    assert.ok(invitationEvent);
    await database.prepare("UPDATE wash_stores SET name = ? WHERE id = ?")
      .run(`${originalStoreName}（新名称）`, store.id);
    const invitationDetail = await app.inject({
      method: "GET",
      url: `/api/admin/audit-events/${invitationEvent.id}`,
      headers: { cookie: platformCookie },
    });
    assert.equal(invitationDetail.statusCode, 200, invitationDetail.body);
    assert.equal(invitationDetail.json<Json>().data.subject.name, originalStoreName);

    const disable = () => app.inject({
      method: "POST",
      url: `/api/admin/backoffice/accounts/${invitation.account.id}/disable`,
      headers: { cookie: platformCookie },
    });
    const firstDisable = await disable();
    assert.equal(firstDisable.statusCode, 200, firstDisable.body);
    const disabledCount = Number((await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events
      WHERE action = 'backoffice.account.disabled' AND resource_id = ?
    `).get(invitation.account.id))?.count ?? 0);
    assert.equal(disabledCount, 1);
    const secondDisable = await disable();
    assert.equal(secondDisable.statusCode, 200, secondDisable.body);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events
      WHERE action = 'backoffice.account.disabled' AND resource_id = ?
    `).get(invitation.account.id))?.count ?? 0), disabledCount);

    await database.query(`
      CREATE OR REPLACE FUNCTION fail_logout_audit_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'backoffice.session.logout' THEN
          RAISE EXCEPTION 'forced logout audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await database.query(`
      CREATE TRIGGER fail_logout_audit_insert
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_logout_audit_insert()
    `);
    const failedLogout = await app.inject({
      method: "DELETE",
      url: "/api/backoffice/session",
      headers: { cookie: platformCookie },
    });
    assert.equal(failedLogout.statusCode, 500, failedLogout.body);
    const stillSignedIn = await app.inject({
      method: "GET",
      url: "/api/backoffice/session",
      headers: { cookie: platformCookie },
    });
    assert.equal(stillSignedIn.statusCode, 200, stillSignedIn.body);
  } finally {
    await close();
  }
});

test("本地开发可直接创建并设置服务商账号密码，无需激活链接", async () => {
  const previous = process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD;
  process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD = "true";
  const { app, database, close } = await fixture("backoffice_direct_password");
  try {
    const platformCookie = await createPlatformSession(app, database, "direct-password");
    const station = await database.prepare<Json>("SELECT id FROM stations ORDER BY id LIMIT 1 OFFSET 1").get();
    assert.ok(station);
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      headers: { cookie: platformCookie },
      payload: {
        loginName: "station.direct",
        displayName: "直接设密检测站管理员",
        role: "inspection_station_admin",
        subject: { type: "inspection_station", id: station.id },
        password: "direct station password 2026",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json<Json>();
    assert.equal(body.data.activation, undefined);
    assert.equal(body.data.account.status, "active");
    assert.equal(body.meta.directPasswordEnabled, true);

    const operatorLogin = await app.inject({
      method: "POST",
      url: "/api/operator/sessions",
      payload: {
        loginName: "station.direct",
        password: "direct station password 2026",
      },
    });
    assert.equal(operatorLogin.statusCode, 200, operatorLogin.body);
  } finally {
    if (previous === undefined) delete process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD;
    else process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD = previous;
    await close();
  }
});

test("维修门店账号绑定单一主体并使用独立 Bearer 登录，网页后台仅开放本人操作记录", async () => {
  const { app, database, close } = await fixture("backoffice_repair_shop_bearer");
  try {
    const platformSuffix = "repair-shop";
    const platformCookie = await createPlatformSession(app, database, platformSuffix);
    const shopsResponse = await app.inject({
      method: "GET",
      url: "/api/admin/repair/shops",
      headers: { cookie: platformCookie },
    });
    assert.equal(shopsResponse.statusCode, 200, shopsResponse.body);
    const shops = shopsResponse.json<Json>().data.items;
    assert.equal(shops.length, 3);
    assert.ok(shops.every((shop: Json) => typeof shop.isDemo === "boolean"));
    const shop = shops.find((item: Json) => item.id === "shop-jincheng-bodypaint");
    assert.ok(shop);

    const mismatched = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      headers: { cookie: platformCookie },
      payload: {
        loginName: "repair.mismatched",
        displayName: "主体不匹配维修管理员",
        role: "repair_shop_admin",
        subject: { type: "wash_store", id: "wash-store-haihe-demo" },
      },
    });
    assert.equal(mismatched.statusCode, 400, mismatched.body);

    const password = "repair shop bearer password 2026";
    const invitation = await inviteRepairShopAdmin(
      app,
      platformCookie,
      shop.id,
      "bearer",
    );
    const activated = await activate(app, invitation.activation.token, password);
    assert.equal(activated.data.account.role, "repair_shop_admin");
    assert.equal(activated.data.subject.type, "repair_shop");
    assert.equal(activated.data.subject.id, shop.id);
    assert.deepEqual(activated.data.capabilities, REPAIR_SHOP_CAPABILITIES);

    const signedIn = await app.inject({
      method: "POST",
      url: "/api/repair-operator/sessions",
      payload: { loginName: "repair.bearer", password },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(signedIn.headers["set-cookie"], undefined);
    assert.equal(signedIn.headers["cache-control"], "no-store");
    const repairSession = signedIn.json<Json>().data;
    assert.match(repairSession.token, /^yxm_bo_[A-Za-z0-9_-]+$/u);
    assert.equal(repairSession.account.role, "repair_shop_admin");
    assert.equal(repairSession.subject.id, shop.id);
    assert.deepEqual(repairSession.capabilities, REPAIR_SHOP_CAPABILITIES);
    const authorization = `Bearer ${repairSession.token}`;

    const current = await app.inject({
      method: "GET",
      url: "/api/repair-operator/session",
      headers: { authorization },
    });
    assert.equal(current.statusCode, 200, current.body);
    assert.equal(current.json<Json>().data.account.loginName, "repair.bearer");
    assert.equal(current.json<Json>().data.subject.name, shop.name);
    assert.equal(current.json<Json>().data.token, undefined);

    const cookieCannotActAsNativeBearer = await app.inject({
      method: "GET",
      url: "/api/repair-operator/session",
      headers: { cookie: activated.cookie },
    });
    assert.equal(cookieCannotActAsNativeBearer.statusCode, 401, cookieCannotActAsNativeBearer.body);
    assert.equal(
      cookieCannotActAsNativeBearer.json<Json>().error.code,
      "REPAIR_OPERATOR_AUTHENTICATION_REQUIRED",
    );

    const repairBearerCannotEnterStation = await app.inject({
      method: "GET",
      url: "/api/operator/workbench",
      headers: { authorization },
    });
    assert.equal(repairBearerCannotEnterStation.statusCode, 403, repairBearerCannotEnterStation.body);

    const platformRejected = await app.inject({
      method: "POST",
      url: "/api/repair-operator/sessions",
      payload: {
        loginName: `platform.${platformSuffix}`,
        password: `correct horse ${platformSuffix} battery staple`,
      },
    });
    assert.equal(platformRejected.statusCode, 403, platformRejected.body);
    assert.equal(platformRejected.json<Json>().error.code, "REPAIR_OPERATOR_ACCOUNT_REQUIRED");

    const unrelatedAdminModule = await app.inject({
      method: "GET",
      url: "/api/admin/bookings",
      headers: { cookie: activated.cookie },
    });
    assert.equal(unrelatedAdminModule.statusCode, 403, unrelatedAdminModule.body);
    assert.equal(unrelatedAdminModule.json<Json>().error.code, "BACKOFFICE_FORBIDDEN");

    const ownAudit = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?pageSize=100",
      headers: { cookie: activated.cookie },
    });
    assert.equal(ownAudit.statusCode, 200, ownAudit.body);
    assert.ok(ownAudit.json<Json>().data.items.length >= 1);
    assert.ok(ownAudit.json<Json>().data.items.every((item: Json) => (
      item.actor.id === invitation.account.id && item.subject.id === shop.id
    )));
    assert.ok(ownAudit.json<Json>().data.items.every((item: Json) => item.actor.roleLabel === "维修门店管理员"));

    const accounts = await app.inject({
      method: "GET",
      url: "/api/admin/backoffice/accounts?role=repair_shop_admin",
      headers: { cookie: platformCookie },
    });
    assert.equal(accounts.statusCode, 200, accounts.body);
    assert.deepEqual(accounts.json<Json>().data.items.map((item: Json) => item.id), [invitation.account.id]);
    assert.equal(accounts.json<Json>().data.items[0].subject.name, shop.name);

    const logout = await app.inject({
      method: "DELETE",
      url: "/api/repair-operator/session",
      headers: { authorization },
    });
    assert.equal(logout.statusCode, 204, logout.body);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/repair-operator/session",
      headers: { authorization },
    });
    assert.equal(revoked.statusCode, 401, revoked.body);
  } finally {
    await close();
  }
});

test("维修门店停用后立即拒绝新旧会话、邀请与管理员更换", async () => {
  const { app, database, close } = await fixture("backoffice_repair_shop_disabled");
  try {
    const platformCookie = await createPlatformSession(app, database, "repair-disabled");
    const shop = await database.prepare<Json>(`
      SELECT id, name FROM repair_shops WHERE id = 'shop-haihe-auto'
    `).get();
    assert.ok(shop);
    const password = "repair disabled shop password 2026";
    const invitation = await inviteRepairShopAdmin(
      app,
      platformCookie,
      shop.id,
      "disabled",
    );
    const activated = await activate(app, invitation.activation.token, password);
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/repair-operator/sessions",
      payload: { loginName: "repair.disabled", password },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const authorization = `Bearer ${signedIn.json<Json>().data.token}`;

    await database.prepare(`
      UPDATE repair_shops SET is_active = 0, updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), shop.id);

    const staleBearer = await app.inject({
      method: "GET",
      url: "/api/repair-operator/session",
      headers: { authorization },
    });
    assert.equal(staleBearer.statusCode, 401, staleBearer.body);
    assert.equal(staleBearer.json<Json>().error.code, "REPAIR_OPERATOR_AUTHENTICATION_REQUIRED");

    const staleCookie = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events",
      headers: { cookie: activated.cookie },
    });
    assert.equal(staleCookie.statusCode, 401, staleCookie.body);
    assert.equal(staleCookie.json<Json>().error.code, "BACKOFFICE_AUTHENTICATION_REQUIRED");

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/repair-operator/sessions",
      payload: { loginName: "repair.disabled", password },
    });
    assert.equal(newLogin.statusCode, 401, newLogin.body);
    assert.equal(newLogin.json<Json>().error.code, "BACKOFFICE_ACCOUNT_UNAVAILABLE");

    const secondInvitation = await app.inject({
      method: "POST",
      url: "/api/admin/backoffice/accounts/invitations",
      headers: { cookie: platformCookie },
      payload: {
        loginName: "repair.disabled.second",
        displayName: "停用维修门店第二管理员",
        role: "repair_shop_admin",
        subject: { type: "repair_shop", id: shop.id },
      },
    });
    assert.equal(secondInvitation.statusCode, 409, secondInvitation.body);
    assert.equal(secondInvitation.json<Json>().error.code, "REPAIR_SHOP_INACTIVE");

    const replacement = await app.inject({
      method: "POST",
      url: `/api/admin/backoffice/accounts/${invitation.account.id}/replacements`,
      headers: { cookie: platformCookie },
      payload: {
        loginName: "repair.disabled.replacement",
        displayName: "停用维修门店替换管理员",
      },
    });
    assert.equal(replacement.statusCode, 409, replacement.body);
    assert.equal(replacement.json<Json>().error.code, "REPAIR_SHOP_INACTIVE");

    const leakedAccounts = await database.prepare<Json>(`
      SELECT COUNT(*)::integer AS count
      FROM backoffice_accounts
      WHERE login_name_normalized IN ('repair.disabled.second', 'repair.disabled.replacement')
    `).get();
    assert.equal(leakedAccounts?.count, 0);
  } finally {
    await close();
  }
});
