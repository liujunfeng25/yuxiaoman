import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { buildApp } from "../app.js";
import type { Database } from "../db.js";
import { insurancePublicBaseUrlIsHttps, insuranceRealConfigurationReady } from "../insurance.js";
import {
  computeInsuranceDisclosureVersion,
  DEMO_INSURANCE_PARTNER_ID,
  seedInsurancePartner,
} from "../insurance-db.js";
import { createTestDatabase } from "./test-database.js";

type Json = Record<string, any>;

async function fixture(cleanupIntervalMs?: number): Promise<{
  app: FastifyInstance;
  database: Database;
  insuranceUploadDir: string;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase("insurance");
  const root = mkdtempSync(join(tmpdir(), "yuxiaoman-insurance-"));
  const uploadDir = join(root, "booking-media");
  const insuranceUploadDir = join(root, "private-insurance");
  const app = await buildApp({
    database,
    uploadDir,
    insuranceUploadDir,
    ...(cleanupIntervalMs == null ? {} : { insuranceCleanupIntervalMs: cleanupIntervalMs }),
  });
  await app.ready();
  return {
    app,
    database,
    insuranceUploadDir,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const licensePng = await sharp({
  create: { width: 18, height: 12, channels: 3, background: "#dce8f8" },
}).png().toBuffer();
const unsupportedGif = await sharp({
  create: { width: 18, height: 12, channels: 3, background: "#dce8f8" },
}).gif().toBuffer();

function multipart(
  fields: Record<string, string>,
  file = licensePng,
  fileField = "licensePhoto",
  filename = "13800138000-license.png",
) {
  const boundary = `----insurance-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  ));
  chunks.push(file);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  return {
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
  };
}

async function disclosure(app: FastifyInstance) {
  const response = await app.inject({ method: "GET", url: "/api/insurance/disclosure" });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Json>().data;
}

async function submitLead(
  app: FastifyInstance,
  version: string,
  idempotencyKey: string,
  overrides: Record<string, string> = {},
  file = licensePng,
) {
  const payload = multipart({
    vehicleId: "vehicle-demo-1",
    contactName: "演示车主",
    contactPhone: "13800138000",
    renewalWindow: "within_30_days",
    contactWindow: "afternoon",
    disclosureVersion: version,
    consentAccepted: "true",
    ...overrides,
  }, file);
  return app.inject({
    method: "POST",
    url: "/api/insurance/leads",
    headers: { ...payload.headers, "idempotency-key": idempotencyKey },
    payload: payload.body,
  });
}

test("保险真实模式只接受显式 HTTPS 公开基址，披露版本覆盖全部可见接收信息", () => {
  assert.equal(insurancePublicBaseUrlIsHttps("https://services.example.test"), true);
  assert.equal(insurancePublicBaseUrlIsHttps("http://services.example.test"), false);
  assert.equal(insurancePublicBaseUrlIsHttps("not-a-url"), false);
  const disclosure = {
    id: "partner-a",
    name: "合作服务机构",
    recipientName: "续保服务一组",
    dataScope: ["联系人姓名", "车辆档案"],
    purpose: "核验续保需求并安排专业服务人员联系",
    retentionText: "关闭后 180 天清除",
    consentText: "我同意将资料提供给上述具体接收方。",
    contactEtaText: "预计 1 个工作日内联系",
  };
  const version = computeInsuranceDisclosureVersion(disclosure);
  assert.notEqual(computeInsuranceDisclosureVersion({ ...disclosure, name: "另一合作服务机构" }), version);
  assert.notEqual(computeInsuranceDisclosureVersion({ ...disclosure, contactEtaText: "预计 2 小时内联系" }), version);
});

test("保险真实模式不依赖运营密码或后台会话配置", () => {
  const keys = [
    "INSURANCE_REAL_MODE",
    "INSURANCE_PUBLIC_BASE_URL",
    "INSURANCE_DATA_KEY",
    "INSURANCE_PHONE_HMAC_KEY",
    "INSURANCE_ADMIN_PASSWORD",
    "INSURANCE_SESSION_SECRET",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.INSURANCE_REAL_MODE = "true";
    process.env.INSURANCE_PUBLIC_BASE_URL = "https://insurance.example.test";
    process.env.INSURANCE_DATA_KEY = "11".repeat(32);
    process.env.INSURANCE_PHONE_HMAC_KEY = "phone-hmac-key-with-at-least-32-characters";
    delete process.env.INSURANCE_ADMIN_PASSWORD;
    delete process.env.INSURANCE_SESSION_SECRET;
    assert.equal(insuranceRealConfigurationReady(), true);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("保险合作方种子会安全更新既有行而不是忽略配置变化", async () => {
  const database = await createTestDatabase("insurance_seed");
  try {
    await database.prepare("UPDATE service_partners SET name = '过期名称', disclosure_version = 'insurance-stale' WHERE id = ?")
      .run(DEMO_INSURANCE_PARTNER_ID);
    await seedInsurancePartner(database, "2026-08-17T00:00:00.000Z");
    const partner = await database.prepare<Json>("SELECT * FROM service_partners WHERE id = ?").get(DEMO_INSURANCE_PARTNER_ID);
    assert.ok(partner);
    assert.equal(partner.name, "驭小满保险服务演示专员");
    assert.notEqual(partner.disclosure_version, "insurance-stale");
    assert.equal(partner.is_default, 1);
  } finally {
    await database.close();
  }
});

test("保险披露 fail closed，multipart 校验且线索敏感字段加密落库", async () => {
  const { app, database, close } = await fixture();
  try {
    const info = await disclosure(app);
    assert.equal(info.mode, "demo");
    assert.equal(info.acceptsRealData, false);
    assert.equal(info.partner.id, "insurance-demo-partner");
    assert.equal(info.partner.recipientName, "驭小满保险服务演示团队（非真实保险机构）");
    assert.match(info.consentText, /合成演示资料/);
    await database.prepare("UPDATE vehicles SET exterior_color = ? WHERE id = ?")
      .run("珍珠白", "vehicle-demo-1");

    const realData = await submitLead(app, info.version, "insurance-real-data-1", { contactPhone: "13712345678" });
    assert.equal(realData.statusCode, 403, realData.body);
    assert.equal(realData.json<Json>().error.code, "REAL_DATA_NOT_ACCEPTED");

    const disguisedGif = await submitLead(app, info.version, "insurance-gif-1", {}, unsupportedGif);
    assert.equal(disguisedGif.statusCode, 415, disguisedGif.body);
    assert.equal(disguisedGif.json<Json>().error.code, "INVALID_MEDIA_TYPE");

    const created = await submitLead(app, info.version, "insurance-create-1", { contactName: "王" });
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json<Json>().data.receipt;
    assert.equal(receipt.status, "new");
    assert.equal(receipt.source, "web-owner-services");
    assert.equal(receipt.maskedPhone, "138****8000");
    assert.equal(receipt.duplicate, false);
    assert.ok(receipt.withdrawToken);
    assert.equal(receipt.vehicle.plateNumber, "津A·88888");
    assert.equal(receipt.vehicle.exteriorColor, "珍珠白");
    assert.equal(receipt.contactNameMasked, "王*");

    const row = await database.prepare<Json>("SELECT * FROM service_leads WHERE lead_code = ?").get(receipt.leadCode);
    assert.ok(row);
    assert.equal(row.source, "web-owner-services");
    assert.equal(row.status, "new");
    assert.match(row.contact_ciphertext, /^v1\.demo\./);
    assert.equal(String(row.contact_ciphertext).includes("13800138000"), false);
    assert.equal(row.phone_hmac.length, 64);
    assert.equal(row.withdraw_token_hash.length, 64);
    assert.equal(row.idempotency_key.length, 64);
    assert.notEqual(row.idempotency_key, "insurance-create-1");
    assert.equal(String(row.consent_snapshot_json).includes(info.version), true);
    const detail = await database.prepare<Json>("SELECT * FROM insurance_lead_details WHERE lead_id = ?").get(row.id);
    assert.ok(detail);
    assert.equal(JSON.parse(detail.vehicle_snapshot_json).plateNumber, "津A·88888");
    assert.equal(JSON.parse(detail.vehicle_snapshot_json).exteriorColor, "珍珠白");
    const media = await database.prepare<Json>("SELECT * FROM service_lead_media WHERE lead_id = ?").get(row.id);
    assert.ok(media);
    assert.equal(media.original_filename, "license-photo.jpg");
    assert.equal(JSON.stringify(media).includes("13800138000-license.png"), false);
  } finally {
    await close();
  }
});

test("保险 Idempotency-Key 和七日手机号车辆去重返回同一可撤回 receipt", async () => {
  const { app, database, close } = await fixture();
  try {
    const info = await disclosure(app);
    const first = await submitLead(app, info.version, "insurance-idempotent-1");
    assert.equal(first.statusCode, 201, first.body);
    const original = first.json<Json>().data.receipt;

    const replay = await submitLead(app, info.version, "insurance-idempotent-1");
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json<Json>().data.receipt.leadCode, original.leadCode);
    assert.equal(replay.json<Json>().data.receipt.withdrawToken, original.withdrawToken);
    assert.equal(replay.json<Json>().data.receipt.duplicate, true);

    const conflict = await submitLead(app, info.version, "insurance-idempotent-1", { contactWindow: "morning" });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json<Json>().error.code, "IDEMPOTENCY_KEY_CONFLICT");

    const sevenDayDuplicate = await submitLead(app, info.version, "insurance-idempotent-2");
    assert.equal(sevenDayDuplicate.statusCode, 200, sevenDayDuplicate.body);
    assert.equal(sevenDayDuplicate.json<Json>().data.receipt.leadCode, original.leadCode);
    assert.equal(sevenDayDuplicate.json<Json>().data.receipt.withdrawToken, original.withdrawToken);

    const count = Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM service_leads").get())?.count);
    assert.equal(count, 1);
    const withdrawn = await app.inject({
      method: "POST",
      url: `/api/insurance/leads/${encodeURIComponent(original.withdrawToken)}/withdraw`,
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(withdrawn.json<Json>().data.receipt.status, "withdrawn");
    assert.equal(withdrawn.json<Json>().data.receipt.withdrawToken, original.withdrawToken);
    assert.equal((await database.prepare<Json>("SELECT status FROM service_leads").get())?.status, "withdrawn");

    const duplicateAfterWithdrawal = await submitLead(app, info.version, "insurance-idempotent-3");
    assert.equal(duplicateAfterWithdrawal.statusCode, 200, duplicateAfterWithdrawal.body);
    assert.equal(duplicateAfterWithdrawal.json<Json>().data.receipt.leadCode, original.leadCode);
    assert.equal(duplicateAfterWithdrawal.json<Json>().data.receipt.status, "withdrawn");
    assert.equal(duplicateAfterWithdrawal.json<Json>().data.receipt.duplicate, true);
  } finally {
    await close();
  }
});

test("保险后台无需密码即可完成脱敏列表、敏感详情媒体审计及 handoff/close 闭环", async () => {
  const { app, database, insuranceUploadDir, close } = await fixture();
  try {
    const info = await disclosure(app);
    await database.prepare("UPDATE vehicles SET exterior_color = ? WHERE id = ?")
      .run("曜石黑", "vehicle-demo-1");
    const created = await submitLead(app, info.version, "insurance-admin-flow-1");
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json<Json>().data.receipt;
    const lead = await database.prepare<Json>("SELECT * FROM service_leads WHERE lead_code = ?").get(receipt.leadCode);
    assert.ok(lead);
    const removedSession = await app.inject({
      method: "POST",
      url: "/api/admin/insurance/session",
      payload: { password: "insurance-demo-admin" },
    });
    assert.equal(removedSession.statusCode, 404);

    const list = await app.inject({ method: "GET", url: "/api/admin/insurance/leads" });
    assert.equal(list.statusCode, 200, list.body);
    const item = list.json<Json>().data.items[0];
    assert.equal(item.maskedPhone, "138****8000");
    assert.equal(JSON.stringify(item).includes("13800138000"), false);
    assert.match(item.vehicle.plateNumber, /\*\*\*/);
    assert.equal(item.vehicle.plateNumber.includes("MVP26"), false);
    assert.equal(item.vehicle.exteriorColor, "曜石黑");

    const closeBeforeHandoff = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/leads/${lead.id}/close`,
      headers: { "content-type": "application/json" },
      payload: { result: "completed_referral" },
    });
    assert.equal(closeBeforeHandoff.statusCode, 409, closeBeforeHandoff.body);

    const detail = await app.inject({ method: "GET", url: `/api/admin/insurance/leads/${lead.id}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json<Json>().data.contact.phone, "13800138000");
    assert.equal(detail.json<Json>().data.vehicle.exteriorColor, "曜石黑");
    assert.ok(detail.json<Json>().data.events.some((event: Json) => event.action === "sensitive_detail_read"));

    const mediaRow = await database.prepare<Json>("SELECT * FROM service_lead_media WHERE lead_id = ?").get(lead.id);
    assert.ok(mediaRow);
    assert.equal(existsSync(join(insuranceUploadDir, mediaRow.storage_key)), true);
    const media = await app.inject({ method: "GET", url: `/api/admin/insurance/leads/${lead.id}/media` });
    assert.equal(media.statusCode, 200, media.body);
    assert.equal(media.headers["cache-control"], "private, no-store");
    assert.equal(media.headers["content-type"], "image/jpeg");
    assert.ok(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM service_lead_events
      WHERE lead_id = ? AND action = 'sensitive_media_read'
    `).get(lead.id))?.count) >= 1);

    const handoff = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/leads/${lead.id}/handoff`,
      headers: { "content-type": "application/json" },
      payload: { partnerId: info.partner.id },
    });
    assert.equal(handoff.statusCode, 200, handoff.body);
    assert.equal(handoff.json<Json>().data.status, "handed_off");
    assert.equal(handoff.json<Json>().data.handoffSnapshot.partner.id, info.partner.id);
    assert.equal(handoff.json<Json>().data.handoffSnapshot.partner.recipientName, info.partner.recipientName);
    assert.equal(handoff.json<Json>().data.handoffSnapshot.disclosureVersion, info.version);
    const handedOffMedia = await database.prepare<Json>("SELECT * FROM service_lead_media WHERE lead_id = ?").get(lead.id);
    assert.ok(handedOffMedia);
    assert.ok(Date.parse(handedOffMedia.delete_after) - Date.now() <= 30 * 24 * 60 * 60 * 1000 + 2_000);

    const closed = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/leads/${lead.id}/close`,
      headers: { "content-type": "application/json" },
      payload: { result: "completed_referral" },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json<Json>().data.status, "closed");
    assert.equal(closed.json<Json>().data.closeResult, "completed_referral");
    const closedRow = await database.prepare<Json>("SELECT * FROM service_leads WHERE id = ?").get(lead.id);
    assert.ok(closedRow);
    assert.ok(Date.parse(closedRow.pii_delete_after) - Date.now() <= 180 * 24 * 60 * 60 * 1000 + 2_000);

    const duplicateAfterClose = await submitLead(app, info.version, "insurance-admin-flow-2");
    assert.equal(duplicateAfterClose.statusCode, 200, duplicateAfterClose.body);
    assert.equal(duplicateAfterClose.json<Json>().data.receipt.leadCode, receipt.leadCode);
    assert.equal(duplicateAfterClose.json<Json>().data.receipt.status, "closed");

    const partners = await app.inject({
      method: "GET",
      url: "/api/admin/insurance/partners/disclosure",
    });
    assert.equal(partners.statusCode, 200, partners.body);
    assert.equal(partners.json<Json>().data.activePartnerId, info.partner.id);
    assert.ok(partners.json<Json>().data.partners.some((partner: Json) => partner.id === info.partner.id));

    const updatedDisclosure = await app.inject({
      method: "PUT",
      url: "/api/admin/insurance/partners/disclosure",
      payload: {
        id: info.partner.id,
        name: info.partner.name,
        recipientName: info.partner.recipientName,
        dataScope: info.dataScope,
        purpose: `${info.purpose}（仅用于语义审计测试）`,
        retention: info.retention,
        consentText: info.consentText,
        contactEtaText: info.contactEtaText,
        active: true,
        isDefault: true,
      },
    });
    assert.equal(updatedDisclosure.statusCode, 200, updatedDisclosure.body);

    const semanticAudits = await database.prepare<Json>(`
      SELECT action,before_json,after_json,metadata_json
      FROM backoffice_audit_events
      WHERE action LIKE 'insurance.%'
      ORDER BY occurred_at,id
    `).all();
    assert.deepEqual(semanticAudits.map((row) => row.action), [
      "insurance.lead.handoff",
      "insurance.lead.close",
      "insurance.disclosure.update",
    ]);
    assert.equal(semanticAudits.every((row) => row.metadata_json.presentation.category === "insurance"), true);
    const serializedAudits = JSON.stringify(semanticAudits);
    assert.doesNotMatch(serializedAudits, /13800138000|演示车主|仅用于语义审计测试/u);
    assert.match(serializedAudits, /转交车险线索|关闭车险线索|更新车险授权说明/u);

  } finally {
    await close();
  }
});

test("车险线索转交在语义审计写入失败时整体回滚", async () => {
  const { app, database, close } = await fixture();
  try {
    const info = await disclosure(app);
    const created = await submitLead(app, info.version, "insurance-audit-atomicity-1");
    assert.equal(created.statusCode, 201, created.body);
    const lead = await database.prepare<Json>("SELECT * FROM service_leads WHERE lead_code = ?")
      .get(created.json<Json>().data.receipt.leadCode);
    assert.ok(lead);
    await database.execute(`
      CREATE OR REPLACE FUNCTION fail_insurance_audit_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.action LIKE 'insurance.%' THEN
          RAISE EXCEPTION 'forced insurance audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_insurance_audit_insert
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_insurance_audit_insert();
    `);
    const handoff = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/leads/${lead.id}/handoff`,
      payload: { partnerId: info.partner.id },
    });
    assert.equal(handoff.statusCode, 500, handoff.body);
    const unchanged = await database.prepare<Json>("SELECT status,handed_off_at FROM service_leads WHERE id = ?").get(lead.id);
    assert.equal(unchanged?.status, "new");
    assert.equal(unchanged?.handed_off_at, null);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM service_lead_events
      WHERE lead_id = ? AND action = 'lead_handed_off'
    `).get(lead.id))?.count), 0);
  } finally {
    await close();
  }
});

test("保险路由周期清理删除私有图片、180 天后清除 PII、1 年后清理审计", async () => {
  const { app, database, insuranceUploadDir, close } = await fixture(0);
  try {
    const info = await disclosure(app);
    const created = await submitLead(app, info.version, "insurance-cleanup-1");
    assert.equal(created.statusCode, 201, created.body);
    const lead = await database.prepare<Json>("SELECT * FROM service_leads").get();
    const media = await database.prepare<Json>("SELECT * FROM service_lead_media").get();
    assert.ok(lead);
    assert.ok(media);
    assert.equal(existsSync(join(insuranceUploadDir, media.storage_key)), true);
    await database.prepare("UPDATE service_lead_media SET delete_after = '2020-01-01T00:00:00.000Z'").run();
    await database.prepare(`
      UPDATE service_leads SET status = 'closed', closed_at = '2020-01-01T00:00:00.000Z',
        pii_delete_after = '2020-06-29T00:00:00.000Z'
    `).run();
    await database.prepare("UPDATE service_lead_events SET delete_after = '2020-12-31T00:00:00.000Z'").run();
    await disclosure(app);
    assert.equal(existsSync(join(insuranceUploadDir, media.storage_key)), false);
    assert.equal((await database.prepare<Json>("SELECT content_hash FROM service_lead_media WHERE id = ?").get(media.id))?.content_hash, "purged");
    const purged = await database.prepare<Json>("SELECT * FROM service_leads WHERE id = ?").get(lead.id);
    assert.ok(purged);
    assert.equal(purged.contact_ciphertext, null);
    assert.equal(purged.phone_hmac, null);
    assert.equal(purged.vehicle_id, null);
    assert.equal(purged.masked_phone, "已清除");
    assert.ok((await database.prepare(`
      SELECT 1 FROM service_lead_events WHERE lead_id = ? AND action = 'pii_retention_purged'
    `).get(lead.id)));
  } finally {
    await close();
  }
});
