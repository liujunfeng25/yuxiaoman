import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { createUserSession, seedDevelopmentUser } from "../auth.js";
import type { Database } from "../db.js";
import { migrateDatabase } from "../db.js";
import { seedDrivingSchoolDemoData } from "../driving-school-db.js";
import {
  cleanupDrivingSchoolInquiryData,
  drivingSchoolInquiryRealConfigurationReady,
} from "../driving-school.js";
import { createWashLocationProof } from "../wash.js";
import { createTestDatabase } from "./test-database.js";

type Json = Record<string, any>;
const FIXED_NOW = new Date("2026-08-22T04:00:00.000Z");
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
after(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

async function fixture(prefix = "driving_school", fixedNow = FIXED_NOW): Promise<{
  app: FastifyInstance;
  database: Database;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase(prefix);
  const root = mkdtempSync(join(tmpdir(), "yuxiaoman-driving-school-"));
  const app = await buildApp({ database, uploadDir: join(root, "uploads"), now: () => new Date(fixedNow) });
  await app.ready();
  return {
    app,
    database,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function demoLocation() {
  const location = {
    poiId: "demo-poi-admin-school",
    title: "后台新增演示驾校位置",
    address: "天津市南开区测试路 1 号（演示地址）",
    district: "南开区",
    latitude: 39.12,
    longitude: 117.18,
    source: "demo" as const,
  };
  return { ...location, locationProof: createWashLocationProof(location) };
}

function adminSchoolPayload() {
  return {
    id: "driving-school-admin-demo",
    name: "后台维护驾校（演示）",
    legalName: "后台维护驾校虚构主体",
    description: "仅供测试的合成演示机构",
    dataKind: "demo",
    location: demoLocation(),
    publicPhone: "022-0000-6199",
    internalContact: { name: "内部测试人员", phone: "13900000000" },
    tags: ["演示数据"],
    facilities: ["演示训练场"],
    openHours: "08:00-18:00（演示）",
    weeklySchedule: {},
    regulatory: {
      type: "filing",
      number: "DEMO-ADMIN-1",
      authority: "演示字段占位（非真实监管机关）",
      sourceUrl: null,
      sourceLabel: "演示备案资料（非真实核验）",
      validFrom: null,
      validUntil: null,
      verifiedAt: null,
      status: "demo",
      capabilityLevel: "level_2",
    },
    inquiryRecipient: {
      recipientName: "驭小满驾校服务团队",
      dataScope: ["联系人姓名", "手机号", "意向准驾车型"],
      purpose: "仅由驭小满平台内部跟进咨询，不转交驾校或第三方",
      retention: "关闭或撤回后 180 天清除联系资料",
      consentText: "我同意仅由驭小满驾校服务团队在平台内部处理合成演示资料，且不转交驾校。",
      contactEtaText: "演示咨询人员预计 1 个工作日内联系（不会真实外呼）",
      active: true,
      synthetic: true,
    },
    isActive: true,
    sortPriority: 5,
  };
}

async function disclosure(app: FastifyInstance, schoolId = "driving-school-demo-nankai") {
  const response = await app.inject({
    method: "GET",
    url: `/api/driving-school-inquiries/disclosure?schoolId=${schoolId}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Json>().data;
}

function inquiryPayload(version: string, overrides: Json = {}) {
  return {
    schoolId: "driving-school-demo-nankai",
    licenseClassCode: "C1",
    applicationMode: "initial",
    contactName: "演示车主",
    contactPhone: "13800138000",
    contactWindow: "afternoon",
    message: "请介绍演示班型",
    disclosureVersion: version,
    consentAccepted: true,
    ...overrides,
  };
}

test("驾校迁移与种子可重复执行，车型目录和三类演示学校组合完整", async () => {
  const database = await createTestDatabase("driving_school_seed");
  try {
    await migrateDatabase(database);
    await migrateDatabase(database);
    await seedDrivingSchoolDemoData(database, FIXED_NOW.toISOString());
    await seedDrivingSchoolDemoData(database, FIXED_NOW.toISOString());
    const classes = await database.prepare<Json>("SELECT * FROM driving_license_classes ORDER BY sort_order").all();
    assert.deepEqual(classes.map((row) => row.code), [
      "A1", "A2", "A3", "B1", "B2", "C1", "C2", "C3", "C4", "C5", "C6", "D", "E", "F", "M", "N", "P",
    ]);
    const c6 = classes.find((row) => row.code === "C6");
    assert.ok(c6);
    assert.equal(c6.initial_allowed, 0);
    assert.equal(c6.upgrade_allowed, 1);
    assert.match(JSON.parse(c6.conditions_json).join(" "), /C1 或 C2.*满一年.*最近一个记分周期无满分记录/u);
    const schools = await database.prepare<Json>("SELECT id, name, data_kind, tags_json, capability_level FROM driving_schools ORDER BY id").all();
    assert.equal(schools.length, 3);
    assert.ok(schools.every((row) => row.data_kind === "demo" && row.name.includes("演示")));
    const combinations = await database.prepare<Json>(`
      SELECT school_id, string_agg(license_class_code, ',' ORDER BY license_class_code) AS codes
      FROM driving_school_training_classes GROUP BY school_id ORDER BY school_id
    `).all();
    assert.deepEqual(Object.fromEntries(combinations.map((row) => [row.school_id, row.codes])), {
      "driving-school-demo-binhai": "D,E,F",
      "driving-school-demo-hexi": "A3,B2",
      "driving-school-demo-nankai": "C1,C2,C6",
    });
    const schoolById = Object.fromEntries(schools.map((row) => [row.id, row]));
    assert.deepEqual(JSON.parse(schoolById["driving-school-demo-nankai"].tags_json), ["C1/C2/C6", "周末班", "演示数据"]);
    assert.deepEqual(JSON.parse(schoolById["driving-school-demo-hexi"].tags_json), ["A3/B2", "大车培训咨询", "演示数据"]);
    assert.deepEqual(JSON.parse(schoolById["driving-school-demo-binhai"].tags_json), ["D/E/F", "摩托车培训咨询", "演示数据"]);
    assert.equal(schoolById["driving-school-demo-nankai"].capability_level, "level_1");
    assert.equal(schoolById["driving-school-demo-hexi"].capability_level, "level_2");
    assert.equal(schoolById["driving-school-demo-binhai"].capability_level, "level_1");
    const trainingLevels = await database.prepare<Json>(`
      SELECT school_id, license_class_code, training_capability_level, training_capability_note
      FROM driving_school_training_classes ORDER BY school_id, license_class_code
    `).all();
    assert.ok(trainingLevels.every((row) => row.training_capability_level == null));
    assert.ok(trainingLevels.every((row) => row.training_capability_note == null));

    await database.prepare(`
      UPDATE driving_school_training_classes SET training_capability_level = '独立训练场'
      WHERE school_id = 'driving-school-demo-nankai' AND license_class_code = 'C1'
    `).run();
    await database.prepare(`
      UPDATE driving_school_training_classes SET training_capability_level = 'level_2'
      WHERE school_id = 'driving-school-demo-nankai' AND license_class_code = 'C2'
    `).run();
    await migrateDatabase(database);
    await migrateDatabase(database);
    const migratedNotes = await database.prepare<Json>(`
      SELECT license_class_code, training_capability_level, training_capability_note
      FROM driving_school_training_classes
      WHERE school_id = 'driving-school-demo-nankai' AND license_class_code IN ('C1', 'C2')
      ORDER BY license_class_code
    `).all();
    assert.deepEqual(migratedNotes, [
      { license_class_code: "C1", training_capability_level: null, training_capability_note: "独立训练场" },
      { license_class_code: "C2", training_capability_level: "level_2", training_capability_note: null },
    ]);
  } finally {
    await database.close();
  }
});

test("公开目录按车型/方式聚合当前报价，隐藏内部联系并安全提供本地封面", async () => {
  const { app, database, close } = await fixture("driving_school_public");
  try {
    const meta = await app.inject({ method: "GET", url: "/api/driving-schools/meta" });
    assert.equal(meta.statusCode, 200, meta.body);
    const metaData = meta.json<Json>().data;
    assert.equal(metaData.licenseClasses.length, 17);
    assert.match(metaData.trainingCapabilityNotice, /不是教学质量/u);

    const c2 = await app.inject({ method: "GET", url: "/api/driving-schools?licenseClassCode=C2&trainingMode=initial" });
    assert.equal(c2.statusCode, 200, c2.body);
    assert.equal(c2.json<Json>().data.pagination.total, 1);
    assert.equal(c2.json<Json>().data.items[0].startingPriceFen, 428000);
    assert.equal("internalContact" in c2.json<Json>().data.items[0], false);
    assert.equal(c2.json<Json>().data.items[0].coverImage.url, "/assets/driving-schools/c-class.webp");

    const c6 = await app.inject({ method: "GET", url: "/api/driving-schools?licenseClassCode=C6&trainingMode=upgrade" });
    assert.equal(c6.statusCode, 200, c6.body);
    assert.equal(c6.json<Json>().data.items[0].startingPriceFen, null);
    const impossiblePrice = await app.inject({ method: "GET", url: "/api/driving-schools?licenseClassCode=C6&trainingMode=upgrade&priceType=fixed" });
    assert.equal(impossiblePrice.json<Json>().data.pagination.total, 0);

    await database.prepare(`
      INSERT INTO driving_school_offers (
        id, school_id, license_class_code, name, price_type, min_price_fen, max_price_fen,
        application_modes_json, unit, included_items_json, excluded_items_json, description,
        valid_from, valid_until, is_active, sort_order, created_at, updated_at
      ) VALUES ('expired-cheap-c2', 'driving-school-demo-nankai', 'C2', '过期低价（演示）',
        'fixed', 100, 100, '["initial"]', '人/期', '[]', '[]', '', NULL,
        '2026-08-21', 1, 0, '2026-08-21T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
    `).run();
    const afterExpired = await app.inject({ method: "GET", url: "/api/driving-schools?licenseClassCode=C2&trainingMode=initial" });
    assert.equal(afterExpired.json<Json>().data.items[0].startingPriceFen, 100);
    assert.equal(afterExpired.json<Json>().data.items[0].offerUpdatedAt, "2099-01-01T00:00:00.000Z");
    assert.equal(afterExpired.json<Json>().data.items[0].offers.find((item: Json) => item.id === "expired-cheap-c2").isExpired, false);

    await database.prepare("UPDATE driving_school_offers SET updated_at = '2100-01-01T00:00:00.000Z' WHERE id = 'driving-school-demo-binhai-offer-1'").run();
    const updated = await app.inject({ method: "GET", url: "/api/driving-schools?sort=updated" });
    assert.equal(updated.json<Json>().data.items[0].id, "driving-school-demo-binhai");

    await database.prepare(`
      INSERT INTO driving_school_offers (
        id, school_id, license_class_code, name, price_type, min_price_fen, max_price_fen,
        application_modes_json, unit, included_items_json, excluded_items_json, description,
        valid_from, valid_until, is_active, sort_order, created_at, updated_at
      ) VALUES ('dirty-c6-initial', 'driving-school-demo-nankai', 'C6', '能力不匹配报价',
        'fixed', 1, 1, '["initial"]', '人/期', '[]', '[]', '', NULL, NULL,
        1, 0, '2026-08-22T00:00:00.000Z', '2099-01-02T00:00:00.000Z')
    `).run();

    const detail = await app.inject({ method: "GET", url: "/api/driving-schools/driving-school-demo-nankai" });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.ok(Array.isArray(detail.json<Json>().data.images));
    assert.ok(Array.isArray(detail.json<Json>().data.trainingClasses));
    assert.ok(Array.isArray(detail.json<Json>().data.offers[0].includedItems));
    assert.equal(detail.json<Json>().data.offers.some((offer: Json) => offer.id === "dirty-c6-initial"), false);
    assert.equal(detail.json<Json>().data.startingPriceFen, 100);
    assert.equal("internalContact" in detail.json<Json>().data, false);
    assert.equal("weeklySchedule" in detail.json<Json>().data, false);
    assert.ok(Array.isArray(detail.json<Json>().data.trainingClasses[0].catalogConditions));
    assert.ok(Array.isArray(detail.json<Json>().data.trainingClasses[0].schoolConditions));
    assert.equal("trainingCapabilityLevel" in detail.json<Json>().data.trainingClasses[0], false);

    const image = await app.inject({ method: "GET", url: "/assets/driving-schools/c-class.webp" });
    assert.equal(image.statusCode, 200, image.body);
    assert.match(String(image.headers["content-type"]), /^image\/webp/u);
    const traversal = await app.inject({ method: "GET", url: "/assets/driving-schools/%252e%252e%252fpackage.json" });
    assert.equal(traversal.statusCode, 404, traversal.body);
  } finally {
    await close();
  }
});

test("过期或失效的真实机构即使保留 published 标记也不会出现在公开目录", async () => {
  const { app, database, close } = await fixture("driving_school_expired");
  try {
    await database.prepare(`
      UPDATE driving_schools SET data_kind = 'real', regulatory_status = 'verified',
        location_source = 'tencent', regulatory_source_url = 'https://example.test/verified',
        regulatory_valid_from = '2025-08-22', regulatory_verified_at = '2026-08-01T00:00:00.000Z',
        regulatory_valid_until = '2026-08-21'
      WHERE id = 'driving-school-demo-nankai'
    `).run();
    const list = await app.inject({ method: "GET", url: "/api/driving-schools?district=南开区" });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json<Json>().data.pagination.total, 0);
    const detail = await app.inject({ method: "GET", url: "/api/driving-schools/driving-school-demo-nankai" });
    assert.equal(detail.statusCode, 404, detail.body);
    const meta = await app.inject({ method: "GET", url: "/api/driving-schools/meta" });
    assert.equal(meta.json<Json>().data.districts.includes("南开区"), false);
  } finally {
    await close();
  }
});

test("真实机构咨询在 HTTPS、密钥或真实接收配置缺失时 fail closed", async () => {
  const keys = [
    "DRIVING_SCHOOL_INQUIRY_REAL_MODE",
    "DRIVING_SCHOOL_INQUIRY_PUBLIC_BASE_URL",
    "DRIVING_SCHOOL_INQUIRY_DATA_KEY",
    "DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY",
    "DRIVING_SCHOOL_INQUIRY_ADMIN_ORIGINS",
    "DRIVING_SCHOOL_INQUIRY_ADMIN_NETWORK_RESTRICTED",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const { app, database, close } = await fixture("driving_school_fail_closed");
  try {
    await database.execute(`
      UPDATE driving_schools SET data_kind = 'real', location_source = 'tencent',
        regulatory_status = 'verified', regulatory_verified_at = '2026-08-01T00:00:00.000Z',
        regulatory_valid_from = '2025-08-22', regulatory_valid_until = '2027-08-22',
        regulatory_source_url = 'https://example.test/verified'
      WHERE id = 'driving-school-demo-nankai';
      UPDATE driving_school_inquiry_recipients SET is_synthetic = 0
      WHERE school_id = 'driving-school-demo-nankai';
    `);
    const unavailable = await app.inject({
      method: "GET", url: "/api/driving-school-inquiries/disclosure?schoolId=driving-school-demo-nankai",
    });
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(unavailable.json<Json>().error.code, "DRIVING_SCHOOL_INQUIRY_NOT_CONFIGURED");
    const create = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "real-misconfigured-school" },
      payload: inquiryPayload("driving-school-stale"),
    });
    assert.equal(create.statusCode, 503, create.body);
  } finally {
    await close();
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("报价历史日期不再影响公开，上海日界仍用于后台咨询日期筛选", async () => {
  const shanghaiNextDay = new Date("2026-08-22T16:30:00.000Z");
  const { app, database, close } = await fixture("driving_school_timezone", shanghaiNextDay);
  try {
    await database.prepare(`
      UPDATE driving_school_offers SET valid_from = '2026-08-23'
      WHERE id = 'driving-school-demo-nankai-offer-1'
    `).run();
    const detail = await app.inject({ method: "GET", url: "/api/driving-schools/driving-school-demo-nankai" });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json<Json>().data.offers.some((offer: Json) => offer.id === "driving-school-demo-nankai-offer-1"), true);

    const info = await disclosure(app);
    const created = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-shanghai-day" },
      payload: inquiryPayload(info.version),
    });
    assert.equal(created.statusCode, 201, created.body);
    const day23 = await app.inject({
      method: "GET", url: "/api/admin/driving-school-inquiries?dateFrom=2026-08-23&dateTo=2026-08-23",
    });
    assert.equal(day23.json<Json>().data.pagination.total, 1);
    const day22 = await app.inject({
      method: "GET", url: "/api/admin/driving-school-inquiries?dateFrom=2026-08-22&dateTo=2026-08-22",
    });
    assert.equal(day22.json<Json>().data.pagination.total, 0);
  } finally {
    await close();
  }
});

test("真实咨询后台要求 HTTPS 来源白名单、网络隔离和相互独立的密钥", async () => {
  const keys = [
    "DRIVING_SCHOOL_INQUIRY_REAL_MODE",
    "DRIVING_SCHOOL_INQUIRY_PUBLIC_BASE_URL",
    "DRIVING_SCHOOL_INQUIRY_DATA_KEY",
    "DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY",
    "DRIVING_SCHOOL_INQUIRY_ADMIN_ORIGINS",
    "DRIVING_SCHOOL_INQUIRY_ADMIN_NETWORK_RESTRICTED",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.DRIVING_SCHOOL_INQUIRY_REAL_MODE = "true";
  process.env.DRIVING_SCHOOL_INQUIRY_PUBLIC_BASE_URL = "https://services.example.test";
  process.env.DRIVING_SCHOOL_INQUIRY_DATA_KEY = "11".repeat(32);
  process.env.DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY = "phone-hmac-key-with-at-least-32-characters";
  process.env.DRIVING_SCHOOL_INQUIRY_ADMIN_ORIGINS = "https://admin.example.test";
  process.env.DRIVING_SCHOOL_INQUIRY_ADMIN_NETWORK_RESTRICTED = "true";
  const { app, database, close } = await fixture("driving_school_admin_boundary");
  try {
    assert.equal(drivingSchoolInquiryRealConfigurationReady(), true);
    await database.execute(`
      UPDATE driving_schools SET data_kind = 'real', location_source = 'tencent',
        regulatory_status = 'verified', regulatory_verified_at = '2026-08-01T00:00:00.000Z',
        regulatory_valid_from = '2025-08-22', regulatory_valid_until = '2027-08-22',
        regulatory_source_url = 'https://example.test/verified'
      WHERE id = 'driving-school-demo-nankai';
      UPDATE driving_school_inquiry_recipients SET is_synthetic = 0
      WHERE school_id = 'driving-school-demo-nankai';
    `);
    const realDisclosure = await disclosure(app);
    assert.equal(realDisclosure.mode, "real");
    const realCreated = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-real-admin-boundary" },
      payload: inquiryPayload(realDisclosure.version, {
        contactName: "真实测试车主", contactPhone: "13600000000",
      }),
    });
    assert.equal(realCreated.statusCode, 201, realCreated.body);
    const realInquiry = await database.prepare<Json>(`
      SELECT id FROM driving_school_inquiries WHERE inquiry_code = ?
    `).get(realCreated.json<Json>().data.receipt.inquiryCode);
    assert.ok(realInquiry);

    const missingOrigin = await app.inject({ method: "GET", url: "/api/admin/driving-school-inquiries" });
    assert.equal(missingOrigin.statusCode, 403, missingOrigin.body);
    const wrongOrigin = await app.inject({
      method: "GET", url: "/api/admin/driving-school-inquiries", headers: { origin: "https://evil.example.test" },
    });
    assert.equal(wrongOrigin.statusCode, 403, wrongOrigin.body);
    const allowed = await app.inject({
      method: "GET", url: "/api/admin/driving-school-inquiries", headers: { origin: "https://admin.example.test" },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);

    process.env.DRIVING_SCHOOL_INQUIRY_REAL_MODE = "false";
    const disabledModeList = await app.inject({
      method: "GET", url: "/api/admin/driving-school-inquiries",
      headers: { origin: "https://admin.example.test" },
    });
    assert.equal(disabledModeList.statusCode, 503, disabledModeList.body);
    const disabledModeDetail = await app.inject({
      method: "GET", url: `/api/admin/driving-school-inquiries/${realInquiry.id}`,
      headers: { origin: "https://admin.example.test" },
    });
    assert.equal(disabledModeDetail.statusCode, 503, disabledModeDetail.body);
    const disabledModePatch = await app.inject({
      method: "PATCH", url: `/api/admin/driving-school-inquiries/${realInquiry.id}`,
      headers: { origin: "https://admin.example.test" }, payload: { internalNote: "不应写入" },
    });
    assert.equal(disabledModePatch.statusCode, 503, disabledModePatch.body);
    process.env.DRIVING_SCHOOL_INQUIRY_REAL_MODE = "true";

    process.env.DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY = "11".repeat(32);
    assert.equal(drivingSchoolInquiryRealConfigurationReady(), false);
    const reusedKey = await app.inject({
      method: "GET", url: "/api/admin/driving-school-inquiries",
      headers: { origin: "https://admin.example.test" },
    });
    assert.equal(reusedKey.statusCode, 503, reusedKey.body);
    process.env.DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY = "phone-hmac-key-with-at-least-32-characters";
    process.env.DRIVING_SCHOOL_INQUIRY_ADMIN_NETWORK_RESTRICTED = "false";
    const networkMissing = await app.inject({
      method: "GET", url: "/api/admin/driving-school-inquiries", headers: { origin: "https://admin.example.test" },
    });
    assert.equal(networkMissing.statusCode, 503, networkMissing.body);
  } finally {
    await close();
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("历史无盐请求散列迁移为 NULL 后仍可返回既有幂等凭证", async () => {
  const { app, database, close } = await fixture("driving_school_legacy_hash");
  try {
    const info = await disclosure(app);
    const created = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-legacy-hash" }, payload: inquiryPayload(info.version),
    });
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json<Json>().data.receipt;
    await database.prepare(`
      UPDATE driving_school_inquiries SET request_hash = ? WHERE inquiry_code = ?
    `).run("a".repeat(64), receipt.inquiryCode);
    await migrateDatabase(database);
    const migrated = await database.prepare<Json>(`
      SELECT request_hash FROM driving_school_inquiries WHERE inquiry_code = ?
    `).get(receipt.inquiryCode);
    assert.equal(migrated?.request_hash, null);
    const replay = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-legacy-hash" },
      payload: inquiryPayload(info.version, { contactWindow: "morning" }),
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json<Json>().data.receipt.inquiryCode, receipt.inquiryCode);
  } finally {
    await close();
  }
});

test("后台 CRUD 校验签名位置、平台接收方、C6 增驾能力与发布完整性", async () => {
  const { app, database, close } = await fixture("driving_school_admin");
  try {
    const invalidLocationPayload = adminSchoolPayload();
    invalidLocationPayload.location.locationProof = "invalid";
    const invalidLocation = await app.inject({ method: "POST", url: "/api/admin/driving-schools", payload: invalidLocationPayload });
    assert.equal(invalidLocation.statusCode, 409, invalidLocation.body);
    assert.equal(invalidLocation.json<Json>().error.code, "DRIVING_SCHOOL_LOCATION_PROOF_INVALID");

    const invalidRecipient = adminSchoolPayload();
    invalidRecipient.inquiryRecipient.recipientName = "某驾校咨询组";
    const rejectedRecipient = await app.inject({ method: "POST", url: "/api/admin/driving-schools", payload: invalidRecipient });
    assert.equal(rejectedRecipient.statusCode, 400, rejectedRecipient.body);

    const created = await app.inject({ method: "POST", url: "/api/admin/driving-schools", payload: adminSchoolPayload() });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json<Json>().data.internalContact.phone, "13900000000");
    assert.equal(created.json<Json>().data.regulatory.capabilityLevel, null);

    const draftPreview = await app.inject({
      method: "GET", url: "/api/admin/driving-schools/driving-school-admin-demo/preview",
    });
    assert.equal(draftPreview.statusCode, 200, draftPreview.body);
    assert.match(String(draftPreview.headers["cache-control"]), /no-store/u);
    const initialPreview = draftPreview.json<Json>().data;
    assert.equal(initialPreview.visibility.listVisible, false);
    assert.equal(initialPreview.visibility.detailVisible, false);
    assert.equal(initialPreview.summary.openHours, "08:00-18:00（演示）");
    assert.equal("weeklySchedule" in initialPreview.summary, false);
    assert.equal("weeklySchedule" in initialPreview.detail, false);
    assert.equal("internalContact" in initialPreview.summary, false);
    assert.equal("internalContact" in initialPreview.detail, false);
    assert.equal("inquiryRecipient" in initialPreview.summary, false);
    assert.equal("inquiryRecipient" in initialPreview.detail, false);
    assert.equal(JSON.stringify(initialPreview).includes("13900000000"), false);
    assert.equal(initialPreview.testPaths.detail, "/packages/driving-school/pages/detail/detail?id=driving-school-admin-demo");
    const initialListPath = new URL(initialPreview.testPaths.list, "https://mini-program.test");
    assert.equal(initialListPath.searchParams.get("q"), "后台维护驾校（演示）");
    assert.equal(initialListPath.searchParams.has("licenseClassCode"), false);
    assert.equal(initialListPath.searchParams.has("applicationMode"), false);
    assert.ok(initialPreview.checklist.some((item: Json) => item.key === "cover_image" && item.status === "fail"));
    assert.ok(initialPreview.checklist.some((item: Json) => item.key === "training_class" && item.status === "fail"));
    assert.ok(initialPreview.checklist.some((item: Json) => item.key === "aligned_offer" && item.status === "fail"));
    assert.equal((await app.inject({ method: "GET", url: "/api/driving-schools/driving-school-admin-demo" })).statusCode, 404);

    const image = await app.inject({
      method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/images",
      payload: { url: "/assets/driving-schools/c-class.webp", caption: "演示封面", sortOrder: 0, isCover: true },
    });
    assert.equal(image.statusCode, 201, image.body);

    const invalidC6 = await app.inject({
      method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/training-classes",
      payload: { licenseClassCode: "C6", applicationModes: ["initial"], status: "active" },
    });
    assert.equal(invalidC6.statusCode, 409, invalidC6.body);
    assert.equal(invalidC6.json<Json>().error.code, "INITIAL_APPLICATION_NOT_ALLOWED");
    const c6 = await app.inject({
      method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/training-classes",
      payload: {
        licenseClassCode: "C6", applicationModes: ["upgrade"],
        trainingCapabilityNote: "仅接受已具备 C1/C2 资格的增驾学员",
        schoolConditions: ["本校要求先完成材料预审"], status: "active",
      },
    });
    assert.equal(c6.statusCode, 201, c6.body);
    assert.equal(c6.json<Json>().data.trainingCapabilityNote, "仅接受已具备 C1/C2 资格的增驾学员");
    assert.deepEqual(c6.json<Json>().data.schoolConditions, ["本校要求先完成材料预审"]);
    assert.ok(c6.json<Json>().data.catalogConditions.some((item: string) => item.includes("仅可通过增驾取得")));
    assert.ok(c6.json<Json>().data.conditions.includes("本校要求先完成材料预审"));
    assert.equal(c6.json<Json>().data.trainingCapabilityLevel, null);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const repeated = await app.inject({
        method: "PATCH", url: "/api/admin/driving-schools/driving-school-admin-demo/training-classes/C6",
        payload: {
          schoolConditions: ["本校要求先完成材料预审"],
          trainingCapabilityNote: "仅接受已具备 C1/C2 资格的增驾学员",
        },
      });
      assert.equal(repeated.statusCode, 200, repeated.body);
      assert.deepEqual(repeated.json<Json>().data.schoolConditions, ["本校要求先完成材料预审"]);
    }
    const legacyMergedConditions = await app.inject({
      method: "PATCH", url: "/api/admin/driving-schools/driving-school-admin-demo/training-classes/C6",
      payload: { conditions: [...c6.json<Json>().data.catalogConditions, "本校要求先完成材料预审"] },
    });
    assert.equal(legacyMergedConditions.statusCode, 200, legacyMergedConditions.body);
    assert.deepEqual(legacyMergedConditions.json<Json>().data.schoolConditions, ["本校要求先完成材料预审"]);
    const storedCapability = await database.prepare<Json>(`
      SELECT training_capability_level, training_capability_note, conditions_json
      FROM driving_school_training_classes
      WHERE school_id = 'driving-school-admin-demo' AND license_class_code = 'C6'
    `).get();
    assert.ok(storedCapability);
    assert.equal(storedCapability.training_capability_level, null);
    assert.equal(storedCapability.training_capability_note, "仅接受已具备 C1/C2 资格的增驾学员");
    assert.deepEqual(JSON.parse(storedCapability.conditions_json), ["本校要求先完成材料预审"]);

    const invalidOffer = await app.inject({
      method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/offers",
      payload: {
        licenseClassCode: "C6", name: "错误初学报价", priceType: "fixed",
        minPriceFen: 100000, maxPriceFen: 100000, applicationModes: ["initial"],
      },
    });
    assert.equal(invalidOffer.statusCode, 409, invalidOffer.body);
    assert.equal(invalidOffer.json<Json>().error.code, "DRIVING_SCHOOL_OFFER_MODE_UNAVAILABLE");
    const offer = await app.inject({
      method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/offers",
      payload: {
        licenseClassCode: "C6", name: "C6 增驾咨询（演示）", priceType: "inquiry",
        minPriceFen: null, maxPriceFen: null, applicationModes: ["upgrade"],
        includedItems: ["演示培训咨询"], excludedItems: ["考试部门收费"],
        validFrom: "2099-01-01", validUntil: "2000-01-01",
      },
    });
    assert.equal(offer.statusCode, 201, offer.body);
    assert.equal(offer.json<Json>().data.validFrom, null);
    assert.equal(offer.json<Json>().data.validUntil, null);
    assert.equal(offer.json<Json>().data.isExpired, false);

    const readyPreview = await app.inject({
      method: "GET", url: "/api/admin/driving-schools/driving-school-admin-demo/preview",
    });
    assert.equal(readyPreview.statusCode, 200, readyPreview.body);
    const readyData = readyPreview.json<Json>().data;
    assert.notEqual(readyData.revision, initialPreview.revision);
    assert.ok(readyData.checklist.every((item: Json) => item.status !== "fail"));
    assert.equal(readyData.detail.regulatory.capabilityLevel, "level_3");
    assert.equal(readyData.offerMappings.length, 1);
    assert.equal(readyData.offerMappings[0].detailVisible, true);
    assert.equal(readyData.offerMappings[0].inquirySelectable, true);
    assert.equal(readyData.offerMappings[0].listMinimumCandidate, false);
    assert.equal(
      readyData.testPaths.inquiry,
      "/packages/driving-school/pages/inquiry/inquiry?schoolId=driving-school-admin-demo&licenseClassCode=C6&applicationMode=upgrade",
    );
    const readyListPath = new URL(readyData.testPaths.list, "https://mini-program.test");
    assert.equal(readyListPath.searchParams.get("q"), "后台维护驾校（演示）");
    assert.equal(readyListPath.searchParams.get("licenseClassCode"), "C6");
    assert.equal(readyListPath.searchParams.get("applicationMode"), "upgrade");

    const published = await app.inject({ method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/publish" });
    assert.equal(published.statusCode, 200, published.body);
    const publicDetail = await app.inject({ method: "GET", url: "/api/driving-schools/driving-school-admin-demo" });
    assert.equal(publicDetail.statusCode, 200, publicDetail.body);
    assert.equal("internalContact" in publicDetail.json<Json>().data, false);
    assert.equal(publicDetail.json<Json>().data.inquiryAvailable, true);
    assert.deepEqual(publicDetail.json<Json>().data, (await app.inject({
      method: "GET", url: "/api/admin/driving-schools/driving-school-admin-demo/preview",
    })).json<Json>().data.detail);
    assert.equal((await app.inject({
      method: "GET", url: "/api/admin/driving-schools/driving-school-missing/preview",
    })).statusCode, 404);

    const disableCapability = await app.inject({
      method: "PATCH", url: "/api/admin/driving-schools/driving-school-admin-demo/training-classes/C6",
      payload: { status: "inactive" },
    });
    assert.equal(disableCapability.statusCode, 409, disableCapability.body);
    assert.equal(disableCapability.json<Json>().error.code, "DRIVING_SCHOOL_TRAINING_CLASS_IN_USE");
    const deleteCapability = await app.inject({
      method: "DELETE", url: "/api/admin/driving-schools/driving-school-admin-demo/training-classes/C6",
    });
    assert.equal(deleteCapability.statusCode, 409, deleteCapability.body);

    const disableOffer = await app.inject({
      method: "PATCH", url: `/api/admin/driving-schools/driving-school-admin-demo/offers/${offer.json<Json>().data.id}`,
      payload: { status: "inactive" },
    });
    assert.equal(disableOffer.statusCode, 200, disableOffer.body);
    const afterOfferDisabled = await app.inject({ method: "GET", url: "/api/admin/driving-schools/driving-school-admin-demo" });
    assert.equal(afterOfferDisabled.json<Json>().data.isPublished, false);
    assert.equal((await app.inject({ method: "GET", url: "/api/driving-schools/driving-school-admin-demo" })).statusCode, 404);

    assert.equal((await app.inject({
      method: "PATCH", url: `/api/admin/driving-schools/driving-school-admin-demo/offers/${offer.json<Json>().data.id}`,
      payload: { status: "active" },
    })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/publish" })).statusCode, 200);
    assert.equal((await app.inject({
      method: "DELETE", url: `/api/admin/driving-schools/driving-school-admin-demo/images/${image.json<Json>().data.id}`,
    })).statusCode, 204);
    const afterCoverDeleted = await app.inject({ method: "GET", url: "/api/admin/driving-schools/driving-school-admin-demo" });
    assert.equal(afterCoverDeleted.json<Json>().data.isPublished, false);

    const replacementCover = await app.inject({
      method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/images",
      payload: { url: "/assets/driving-schools/c-class.webp", caption: "替换演示封面", sortOrder: 0, isCover: true },
    });
    assert.equal(replacementCover.statusCode, 201, replacementCover.body);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/publish" })).statusCode, 200);
    const disableRecipient = await app.inject({
      method: "PATCH", url: "/api/admin/driving-schools/driving-school-admin-demo",
      payload: { inquiryRecipient: { ...adminSchoolPayload().inquiryRecipient, active: false } },
    });
    assert.equal(disableRecipient.statusCode, 200, disableRecipient.body);
    assert.equal(disableRecipient.json<Json>().data.isPublished, false);

    assert.equal((await app.inject({
      method: "PATCH", url: "/api/admin/driving-schools/driving-school-admin-demo",
      payload: { inquiryRecipient: adminSchoolPayload().inquiryRecipient },
    })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/driving-schools/driving-school-admin-demo/publish" })).statusCode, 200);
    const clearPublicPhone = await app.inject({
      method: "PATCH", url: "/api/admin/driving-schools/driving-school-admin-demo",
      payload: { publicPhone: null },
    });
    assert.equal(clearPublicPhone.statusCode, 200, clearPublicPhone.body);
    assert.equal(clearPublicPhone.json<Json>().data.isPublished, false);

    const semanticAudits = await database.prepare<Json>(`
      SELECT action,before_json,after_json,metadata_json
      FROM backoffice_audit_events
      WHERE action LIKE 'driving_school.%'
      ORDER BY occurred_at,id
    `).all();
    const actions = semanticAudits.map((row) => row.action);
    for (const action of [
      "driving_school.school.create",
      "driving_school.school.update",
      "driving_school.school.publish",
      "driving_school.image.create",
      "driving_school.image.delete",
      "driving_school.training_class.create",
      "driving_school.offer.create",
      "driving_school.offer.update",
    ]) assert.ok(actions.includes(action), `missing semantic audit ${action}`);
    assert.equal(semanticAudits.every((row) => row.metadata_json.presentation.category === "driving_school"), true);
    const imageAudits = semanticAudits.filter((row) => row.action.startsWith("driving_school.image."));
    assert.ok(imageAudits.length >= 3);
    assert.equal(imageAudits.every((row) => (
      row.metadata_json.presentation.resourceLabel === "驾校 后台维护驾校（演示） · 封面图"
    )), true);
    assert.equal(imageAudits.some((row) => (
      String(row.metadata_json.presentation.resourceLabel).includes(String(image.json<Json>().data.id))
      || String(row.metadata_json.presentation.resourceLabel).includes(String(replacementCover.json<Json>().data.id))
    )), false);
    const serializedAudits = JSON.stringify(semanticAudits);
    assert.doesNotMatch(serializedAudits, /13900000000|仅接受已具备 C1\/C2 资格的增驾学员|本校要求先完成材料预审|演示培训咨询|考试部门收费|替换演示封面/u);
    assert.match(serializedAudits, /新增驾校|发布驾校|修改驾校报价/u);
  } finally {
    await close();
  }
});

test("驾校资料变更在语义审计写入失败时整体回滚", async () => {
  const { app, database, close } = await fixture("driving_school_audit_atomicity");
  try {
    await database.execute(`
      CREATE OR REPLACE FUNCTION fail_driving_school_audit_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.action LIKE 'driving_school.%' THEN
          RAISE EXCEPTION 'forced driving school audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_driving_school_audit_insert
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_driving_school_audit_insert();
    `);
    const response = await app.inject({ method: "POST", url: "/api/admin/driving-schools", payload: adminSchoolPayload() });
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM driving_schools WHERE id = 'driving-school-admin-demo'
    `).get())?.count), 0);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM driving_school_inquiry_recipients WHERE school_id = 'driving-school-admin-demo'
    `).get())?.count), 0);
  } finally {
    await close();
  }
});

test("真实机构切换为演示机构时原子重建固定合成接收方并维持发布边界", async () => {
  const { app, database, close } = await fixture("driving_school_real_to_demo");
  try {
    await database.execute(`
      UPDATE driving_schools SET data_kind = 'real', location_source = 'tencent',
        regulatory_status = 'verified', regulatory_verified_at = '2026-08-01T00:00:00.000Z',
        regulatory_valid_from = '2025-08-22', regulatory_valid_until = '2027-08-22',
        regulatory_source_url = 'https://example.test/verified', capability_level = 'level_2'
      WHERE id = 'driving-school-demo-nankai';
      UPDATE driving_school_inquiry_recipients SET is_synthetic = 0
      WHERE school_id = 'driving-school-demo-nankai';
    `);
    const mismatchedRealPreview = await app.inject({
      method: "GET", url: "/api/admin/driving-schools/driving-school-demo-nankai/preview",
    });
    assert.equal(mismatchedRealPreview.statusCode, 200, mismatchedRealPreview.body);
    assert.ok(mismatchedRealPreview.json<Json>().data.checklist.some(
      (item: Json) => item.key === "capability_level" && item.status === "fail",
    ));
    await database.prepare(`
      UPDATE driving_schools SET capability_level = 'level_1'
      WHERE id = 'driving-school-demo-nankai'
    `).run();
    const matchedRealPreview = await app.inject({
      method: "GET", url: "/api/admin/driving-schools/driving-school-demo-nankai/preview",
    });
    assert.ok(matchedRealPreview.json<Json>().data.checklist.some(
      (item: Json) => item.key === "capability_level" && item.status === "pass",
    ));
    const changed = await app.inject({
      method: "PATCH", url: "/api/admin/driving-schools/driving-school-demo-nankai",
      payload: {
        dataKind: "demo",
        regulatory: {
          type: "filing",
          number: "DEMO-RESET-1",
          authority: "演示字段占位（非真实监管机关）",
          sourceUrl: null,
          sourceLabel: "演示备案资料（非真实核验）",
          validFrom: null,
          validUntil: null,
          verifiedAt: null,
          status: "demo",
          capabilityLevel: "level_1",
        },
      },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json<Json>().data.dataKind, "demo");
    assert.equal(changed.json<Json>().data.inquiryRecipient.recipientName, "驭小满驾校服务团队");
    assert.equal(changed.json<Json>().data.inquiryRecipient.synthetic, true);
    assert.equal(changed.json<Json>().data.inquiryRecipient.active, true);
    assert.equal(changed.json<Json>().data.isPublished, true);
    const stored = await database.prepare<Json>(`
      SELECT recipient_name, is_synthetic, is_active
      FROM driving_school_inquiry_recipients WHERE school_id = 'driving-school-demo-nankai'
    `).get();
    assert.equal(stored?.recipient_name, "驭小满驾校服务团队");
    assert.equal(stored?.is_synthetic, 1);
    assert.equal(stored?.is_active, 1);
    assert.equal((await app.inject({
      method: "GET", url: "/api/driving-schools/driving-school-demo-nankai",
    })).statusCode, 200);
    assert.equal((await disclosure(app)).mode, "demo");
  } finally {
    await close();
  }
});

test("咨询线索 fail-closed、加密落库、24 小时去重、owner 撤回与后台审计状态机", async () => {
  const { app, database, close } = await fixture("driving_school_inquiry");
  try {
    const info = await disclosure(app);
    assert.equal(info.mode, "demo");
    assert.equal(info.acceptsRealData, false);
    assert.equal(info.recipient.name, "驭小满驾校服务团队");
    assert.match(info.purpose, /不向驾校或其他第三方转交/u);

    const noConsent = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-no-consent" },
      payload: inquiryPayload(info.version, { consentAccepted: false }),
    });
    assert.equal(noConsent.statusCode, 400, noConsent.body);
    const realPhone = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-real-phone" },
      payload: inquiryPayload(info.version, { contactPhone: "13712345678" }),
    });
    assert.equal(realPhone.statusCode, 403, realPhone.body);
    const realName = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-real-name" },
      payload: inquiryPayload(info.version, { contactName: "真实姓名" }),
    });
    assert.equal(realName.statusCode, 403, realName.body);

    await database.prepare(`
      UPDATE driving_school_offers
      SET valid_from = '2099-01-01', valid_until = '2000-01-01'
      WHERE id = 'driving-school-demo-nankai-offer-1'
    `).run();
    const legacyDatedOffer = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-dated-offer" },
      payload: inquiryPayload(info.version, {
        offerId: "driving-school-demo-nankai-offer-1", contactPhone: "13900000000",
      }),
    });
    assert.equal(legacyDatedOffer.statusCode, 201, legacyDatedOffer.body);
    const futurePublicDetail = await app.inject({ method: "GET", url: "/api/driving-schools/driving-school-demo-nankai" });
    assert.equal(futurePublicDetail.statusCode, 200, futurePublicDetail.body);
    const datedPublicOffer = futurePublicDetail.json<Json>().data.offers.find(
      (item: Json) => item.id === "driving-school-demo-nankai-offer-1",
    );
    assert.ok(datedPublicOffer);
    assert.equal(datedPublicOffer.isExpired, false);
    assert.equal(datedPublicOffer.availabilityStatus, "current");
    await database.prepare(`
      UPDATE driving_school_offers SET valid_from = NULL, valid_until = NULL
      WHERE id = 'driving-school-demo-nankai-offer-1'
    `).run();

    const created = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-create-1" }, payload: inquiryPayload(info.version),
    });
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json<Json>().data.receipt;
    assert.equal(receipt.status, "new");
    assert.equal(receipt.duplicate, false);
    assert.equal(receipt.maskedPhone, "138****8000");

    const stored = await database.prepare<Json>("SELECT * FROM driving_school_inquiries WHERE inquiry_code = ?").get(receipt.inquiryCode);
    assert.ok(stored);
    assert.match(stored.contact_ciphertext, /^v1\.demo\./u);
    assert.equal(String(stored.contact_ciphertext).includes("13800138000"), false);
    assert.equal(stored.phone_hmac.length, 64);
    assert.equal(stored.idempotency_key.length, 64);
    assert.equal(stored.withdraw_token_hash.length, 64);
    assert.match(stored.request_hash, /^hmac-v1:[a-f0-9]{64}$/u);

    const replay = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-create-1" }, payload: inquiryPayload(info.version),
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json<Json>().data.receipt.inquiryCode, receipt.inquiryCode);
    assert.equal(replay.json<Json>().data.receipt.withdrawToken, receipt.withdrawToken);
    const dedup = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-create-2" },
      payload: inquiryPayload(info.version, { message: "同一组合不同内容" }),
    });
    assert.equal(dedup.statusCode, 200, dedup.body);
    assert.equal(dedup.json<Json>().data.receipt.inquiryCode, receipt.inquiryCode);

    await seedDevelopmentUser(database, "other-driving-owner", FIXED_NOW.toISOString());
    const otherSession = await createUserSession(database, "other-driving-owner");
    const wrongOwner = await app.inject({
      method: "POST", url: `/api/driving-school-inquiries/${receipt.withdrawToken}/withdraw`,
      headers: { authorization: `Bearer ${otherSession.token}` },
    });
    assert.equal(wrongOwner.statusCode, 404, wrongOwner.body);

    const list = await app.inject({ method: "GET", url: "/api/admin/driving-school-inquiries?dateFrom=2026-08-22&dateTo=2026-08-22" });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json<Json>().data.pagination.total, 2);
    assert.equal("contact" in list.json<Json>().data.items[0], false);
    const sensitive = await app.inject({ method: "GET", url: `/api/admin/driving-school-inquiries/${stored.id}` });
    assert.equal(sensitive.statusCode, 200, sensitive.body);
    assert.equal(sensitive.json<Json>().data.contact.phone, "13800138000");
    assert.equal(sensitive.json<Json>().data.contact.message, "");
    const audit = await database.prepare<Json>(`
      SELECT * FROM driving_school_inquiry_events WHERE inquiry_id = ? AND action = 'sensitive_detail_read'
    `).get(stored.id);
    assert.ok(audit);

    const contacting = await app.inject({
      method: "PATCH", url: `/api/admin/driving-school-inquiries/${stored.id}`,
      payload: { status: "contacting", internalNote: "已安排演示跟进" },
    });
    assert.equal(contacting.statusCode, 200, contacting.body);
    const semanticCountAfterStatusChange = Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'driving_school.%'
    `).get())?.count);
    const noteOnly = await app.inject({
      method: "PATCH", url: `/api/admin/driving-school-inquiries/${stored.id}`,
      payload: { internalNote: "只修改内部备注，不应进入全局日志" },
    });
    assert.equal(noteOnly.statusCode, 200, noteOnly.body);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'driving_school.%'
    `).get())?.count), semanticCountAfterStatusChange);
    const resolved = await app.inject({
      method: "PATCH", url: `/api/admin/driving-school-inquiries/${stored.id}`,
      payload: { status: "resolved" },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    const semanticAudits = await database.prepare<Json>(`
      SELECT action,before_json,after_json,metadata_json
      FROM backoffice_audit_events
      WHERE action LIKE 'driving_school.%'
      ORDER BY occurred_at,id
    `).all();
    assert.deepEqual(semanticAudits.map((row) => row.action), [
      "driving_school.inquiry.followup_update",
      "driving_school.inquiry.followup_update",
    ]);
    const serializedAudits = JSON.stringify(semanticAudits);
    assert.doesNotMatch(serializedAudits, /13800138000|演示车主|已安排演示跟进|只修改内部备注|请介绍演示班型/u);
    assert.match(serializedAudits, /更新驾校咨询跟进|联系中|已解决/u);
    const finalizedWithdraw = await app.inject({ method: "POST", url: `/api/driving-school-inquiries/${receipt.withdrawToken}/withdraw` });
    assert.equal(finalizedWithdraw.statusCode, 409, finalizedWithdraw.body);

    const second = await app.inject({
      method: "POST", url: "/api/driving-school-inquiries",
      headers: { "idempotency-key": "driving-withdraw-2" },
      payload: inquiryPayload(info.version, { licenseClassCode: "C2" }),
    });
    assert.equal(second.statusCode, 201, second.body);
    const secondReceipt = second.json<Json>().data.receipt;
    const withdrawn = await app.inject({ method: "POST", url: `/api/driving-school-inquiries/${secondReceipt.withdrawToken}/withdraw` });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(withdrawn.json<Json>().data.receipt.status, "withdrawn");
    const secondRow = await database.prepare<Json>("SELECT * FROM driving_school_inquiries WHERE inquiry_code = ?").get(secondReceipt.inquiryCode);
    assert.ok(secondRow);
    const withdrawnStored = await database.prepare<Json>("SELECT * FROM driving_school_inquiries WHERE id = ?").get(secondRow.id);
    assert.ok(withdrawnStored);
    assert.equal(withdrawnStored.contact_ciphertext, null);
    assert.equal(withdrawnStored.phone_hmac, null);
    assert.equal(withdrawnStored.internal_note, null);
    assert.equal(withdrawnStored.request_hash, null);
    const withdrawnDetail = await app.inject({ method: "GET", url: `/api/admin/driving-school-inquiries/${secondRow.id}` });
    assert.equal(withdrawnDetail.statusCode, 200, withdrawnDetail.body);
    assert.equal(withdrawnDetail.json<Json>().data.contact, null);
    const mutateWithdrawn = await app.inject({
      method: "PATCH", url: `/api/admin/driving-school-inquiries/${secondRow.id}`,
      payload: { internalNote: "不应允许修改" },
    });
    assert.equal(mutateWithdrawn.statusCode, 409, mutateWithdrawn.body);

    await database.prepare(`
      UPDATE driving_school_inquiries SET pii_delete_after = '2026-08-21T00:00:00.000Z',
        internal_note = '清理前内部备注' WHERE id = ?
    `).run(secondRow.id);
    await cleanupDrivingSchoolInquiryData(database, FIXED_NOW);
    const purged = await database.prepare<Json>("SELECT * FROM driving_school_inquiries WHERE id = ?").get(secondRow.id);
    assert.ok(purged);
    assert.equal(purged.contact_ciphertext, null);
    assert.equal(purged.phone_hmac, null);
    assert.equal(purged.internal_note, null);
    assert.equal(purged.contact_name_masked, null);
    assert.equal(purged.masked_phone, null);
    assert.equal(purged.request_hash, null);
    assert.equal(purged.pii_purged_at, FIXED_NOW.toISOString());
  } finally {
    await close();
  }
});
