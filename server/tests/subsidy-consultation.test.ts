import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import multipartPlugin from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { AuthenticationError, createUserSession, seedDevelopmentUser } from "../auth.js";
import type { Database } from "../db.js";
import {
  cleanupSubsidyConsultationData,
  migrateSubsidyConsultationDatabase,
  registerSubsidyConsultationRoutes,
  subsidyConsultationPublicBaseUrlIsHttps,
  subsidyConsultationRealConfigurationReady,
} from "../subsidy-consultation.js";
import { createTestDatabase } from "./test-database.js";

type Json = Record<string, any>;

class TestApiProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

const materialKinds = [
  "id_card_front",
  "id_card_back",
  "driving_license_front",
  "driving_license_back",
  "vehicle_front_left",
  "vehicle_front_right",
  "vehicle_rear_left",
  "vehicle_rear_right",
  "dashboard_started",
] as const;

async function fixture(): Promise<{
  app: FastifyInstance;
  database: Database;
  subsidyConsultationUploadDir: string;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase("subsidy_consult");
  const root = mkdtempSync(join(tmpdir(), "yuxiaoman-subsidy-consult-"));
  const app = Fastify({ logger: false });
  await app.register(multipartPlugin, {
    limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 12 },
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TestApiProblem) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) },
      });
    }
    if (error instanceof AuthenticationError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: error instanceof Error ? String(error.message) : "unknown error" },
    });
  });
  const subsidyConsultationUploadDir = join(root, "subsidy-consultation");
  await registerSubsidyConsultationRoutes(app, database, {
    uploadDir: subsidyConsultationUploadDir,
    problem: (statusCode, code, message, fields) => new TestApiProblem(statusCode, code, message, fields),
  });
  await app.ready();
  return {
    app,
    database,
    subsidyConsultationUploadDir,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function multipart(kind: string, file: Buffer, filename = "synthetic-material.png") {
  const boundary = `----subsidy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
  };
}

async function config(app: FastifyInstance): Promise<Json> {
  const response = await app.inject({ method: "GET", url: "/api/subsidy-consultation/config" });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Json>().data;
}

async function quote(app: FastifyInstance, declaredValueFen: number): Promise<Json> {
  const response = await app.inject({
    method: "POST",
    url: "/api/subsidy-consultation/quotes",
    payload: { vehicleId: "vehicle-demo-1", declaredValueFen },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data.quote;
}

async function uploadAllMaterials(app: FastifyInstance): Promise<string[]> {
  const materialIds: string[] = [];
  for (const kind of materialKinds) {
    const response = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/demo-materials",
      payload: { kind },
    });
    assert.equal(response.statusCode, 201, `${kind}: ${response.body}`);
    const material = response.json<Json>().data.material;
    assert.equal(material.kind, kind);
    assert.equal(material.status, "staged");
    materialIds.push(material.id);
  }
  return materialIds;
}

test("补贴咨询真实资料模式必须同时满足 HTTPS、密钥、受限来源与可信管理员配置", () => {
  assert.equal(subsidyConsultationPublicBaseUrlIsHttps("https://services.example.test"), true);
  assert.equal(subsidyConsultationPublicBaseUrlIsHttps("http://services.example.test"), false);
  const keys = [
    "SUBSIDY_CONSULTATION_REAL_MODE",
    "SUBSIDY_CONSULTATION_PUBLIC_BASE_URL",
    "SUBSIDY_CONSULTATION_DATA_KEY",
    "SUBSIDY_CONSULTATION_PHONE_HMAC_KEY",
    "SUBSIDY_CONSULTATION_ALLOWED_ORIGINS",
    "SUBSIDY_CONSULTATION_ADMIN_IDENTITY_HEADER",
    "SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SECRET",
    "SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SUBJECT",
    "YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.SUBSIDY_CONSULTATION_REAL_MODE = "true";
    process.env.SUBSIDY_CONSULTATION_PUBLIC_BASE_URL = "https://services.example.test";
    process.env.SUBSIDY_CONSULTATION_DATA_KEY = "11".repeat(32);
    process.env.SUBSIDY_CONSULTATION_PHONE_HMAC_KEY = "phone-hmac-key-with-at-least-32-characters";
    delete process.env.SUBSIDY_CONSULTATION_ALLOWED_ORIGINS;
    delete process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_HEADER;
    delete process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SECRET;
    delete process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SUBJECT;
    assert.equal(subsidyConsultationRealConfigurationReady(), false);
    process.env.SUBSIDY_CONSULTATION_ALLOWED_ORIGINS = "https://admin.example.test,https://owner.example.test";
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_HEADER = "x-yuxiaoman-admin-secret";
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SECRET = "admin-header-secret-with-at-least-32-characters";
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SUBJECT = "operations-admin";
    process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "true";
    assert.equal(subsidyConsultationRealConfigurationReady(), false);
    process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "false";
    assert.equal(subsidyConsultationRealConfigurationReady(), true);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("真实模式只接受 Bearer 会话与 multipart，且拒绝合成演示资料接口", async () => {
  const keys = [
    "SUBSIDY_CONSULTATION_REAL_MODE",
    "SUBSIDY_CONSULTATION_PUBLIC_BASE_URL",
    "SUBSIDY_CONSULTATION_DATA_KEY",
    "SUBSIDY_CONSULTATION_PHONE_HMAC_KEY",
    "SUBSIDY_CONSULTATION_ALLOWED_ORIGINS",
    "SUBSIDY_CONSULTATION_ADMIN_IDENTITY_HEADER",
    "SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SECRET",
    "SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SUBJECT",
    "YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  let close: (() => Promise<void>) | undefined;
  try {
    process.env.SUBSIDY_CONSULTATION_REAL_MODE = "true";
    process.env.SUBSIDY_CONSULTATION_PUBLIC_BASE_URL = "https://services.example.test";
    process.env.SUBSIDY_CONSULTATION_DATA_KEY = "22".repeat(32);
    process.env.SUBSIDY_CONSULTATION_PHONE_HMAC_KEY = "real-phone-hmac-key-with-at-least-32-characters";
    process.env.SUBSIDY_CONSULTATION_ALLOWED_ORIGINS = "https://owner.example.test,https://admin.example.test";
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_HEADER = "x-yuxiaoman-admin-secret";
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SECRET = "real-admin-header-secret-with-at-least-32-characters";
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SUBJECT = "operations-admin";
    process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "false";
    const context = await fixture();
    close = context.close;
    const session = await createUserSession(context.database, "demo-user");
    const headers = { authorization: `Bearer ${session.token}` };

    const noBearer = await context.app.inject({
      method: "GET",
      url: "/api/subsidy-consultation/config",
    });
    assert.equal(noBearer.statusCode, 401, noBearer.body);
    const realConfig = await context.app.inject({
      method: "GET",
      url: "/api/subsidy-consultation/config",
      headers,
    });
    assert.equal(realConfig.statusCode, 200, realConfig.body);
    assert.equal(realConfig.json<Json>().data.mode, "real");
    assert.equal(realConfig.json<Json>().data.demoContact, null);
    assert.equal(realConfig.json<Json>().data.materialUploadMode, "multipart");

    const demoMaterial = await context.app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/demo-materials",
      headers,
      payload: { kind: "id_card_front" },
    });
    assert.equal(demoMaterial.statusCode, 403, demoMaterial.body);
    assert.equal(demoMaterial.json<Json>().error.code, "DEMO_MATERIALS_NOT_AVAILABLE");

    const png = await sharp({
      create: { width: 24, height: 16, channels: 3, background: "#dce8f8" },
    }).png().toBuffer();
    const upload = multipart("id_card_front", png, "real-mode-fixture.png");
    const uploaded = await context.app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/materials",
      headers: { ...headers, ...upload.headers },
      payload: upload.body,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    assert.equal(uploaded.json<Json>().data.material.kind, "id_card_front");
  } finally {
    await close?.();
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("默认阶梯由服务端报价，50 万封顶且发布新版本不改写旧报价", async () => {
  const { app, database, close } = await fixture();
  try {
    await migrateSubsidyConsultationDatabase(database);
    await migrateSubsidyConsultationDatabase(database);
    const initial = await config(app);
    assert.equal(initial.mode, "demo");
    assert.equal(initial.acceptsRealData, false);
    assert.deepEqual(initial.demoContact, { name: "演示车主", phone: "13800138000" });
    assert.equal(initial.materialUploadMode, "server_generated_demo");
    assert.equal(initial.materialUploadEndpoint, null);
    assert.equal(initial.demoMaterialEndpoint, "/api/subsidy-consultation/demo-materials");
    assert.equal(initial.maxDeclaredValueFen, 50_000_000);
    assert.deepEqual(initial.administrativeFees, {
      plateFeeFen: 12_000,
      mailingFeeFen: 2_000,
      productionFeeFen: 1_000,
    });
    assert.equal(initial.administrativeFeeFen, 15_000);
    assert.deepEqual(initial.feePlan.administrativeFees, initial.administrativeFees);
    assert.equal(initial.feePlan.administrativeFeeFen, 15_000);
    assert.deepEqual(
      initial.feePlan.tiers.map((tier: Json) => [tier.maxValueFen, tier.feeFen, tier.totalTransferCostFen]),
      [
        [20_000_000, 15_000, 30_000],
        [30_000_000, 25_000, 40_000],
        [40_000_000, 35_000, 50_000],
        [50_000_000, 45_000, 60_000],
      ],
    );

    for (const [value, fee] of [
      [1, 15_000],
      [20_000_000, 15_000],
      [20_000_001, 25_000],
      [30_000_000, 25_000],
      [40_000_000, 35_000],
      [50_000_000, 45_000],
    ] as const) {
      const priced = await quote(app, value);
      assert.equal(priced.consultationFeeFen, fee);
      assert.deepEqual(priced.administrativeFees, initial.administrativeFees);
      assert.equal(priced.administrativeFeeFen, 15_000);
      assert.equal(priced.totalTransferCostFen, fee + 15_000);
      assert.equal(priced.matchedTier.totalTransferCostFen, fee + 15_000);
      assert.equal(priced.declaredValueSource, "owner_self_reported");
      assert.equal(priced.isAppraisal, false);
    }
    const aboveCap = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/quotes",
      payload: { vehicleId: "vehicle-demo-1", declaredValueFen: 50_000_001 },
    });
    assert.equal(aboveCap.statusCode, 400, aboveCap.body);

    const forged = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/quotes",
      payload: {
        vehicleId: "vehicle-demo-1",
        declaredValueFen: 10_000_000,
        consultationFeeFen: 1,
        administrativeFees: { plateFeeFen: 1, mailingFeeFen: 1, productionFeeFen: 1 },
        administrativeFeeFen: 3,
        totalTransferCostFen: 4,
        userId: "forged-user",
      },
    });
    assert.equal(forged.statusCode, 201, forged.body);
    const forgedQuote = forged.json<Json>().data.quote;
    assert.equal(forgedQuote.consultationFeeFen, 15_000);
    assert.deepEqual(forgedQuote.administrativeFees, initial.administrativeFees);
    assert.equal(forgedQuote.administrativeFeeFen, 15_000);
    assert.equal(forgedQuote.totalTransferCostFen, 30_000);

    const frozen = await quote(app, 10_000_000);
    const planResponse = await app.inject({ method: "GET", url: "/api/admin/subsidy-consultation/fee-plan" });
    assert.equal(planResponse.statusCode, 200, planResponse.body);
    const currentPlan = planResponse.json<Json>().data.published;
    const changedTiers = currentPlan.tiers.map((tier: Json, index: number) => ({
      ...tier,
      feeFen: index === 0 ? 16_000 : tier.feeFen,
    }));
    const save = await app.inject({
      method: "PUT",
      url: "/api/admin/subsidy-consultation/fee-plan/draft",
      payload: {
        active: true,
        administrativeFees: { plateFeeFen: 13_000, mailingFeeFen: 3_000, productionFeeFen: 2_000 },
        tiers: changedTiers,
      },
    });
    assert.equal(save.statusCode, 200, save.body);
    const savedDraft = save.json<Json>().data.draft;
    assert.deepEqual(savedDraft.administrativeFees, {
      plateFeeFen: 13_000,
      mailingFeeFen: 3_000,
      productionFeeFen: 2_000,
    });
    assert.equal(savedDraft.administrativeFeeFen, 18_000);
    assert.equal(savedDraft.tiers[0].totalTransferCostFen, 34_000);
    const beforePublish = await quote(app, 10_000_000);
    assert.equal(beforePublish.consultationFeeFen, 15_000);
    assert.equal(beforePublish.administrativeFeeFen, 15_000);
    assert.equal(beforePublish.totalTransferCostFen, 30_000);
    const publish = await app.inject({
      method: "POST",
      url: "/api/admin/subsidy-consultation/fee-plan/publish",
    });
    assert.equal(publish.statusCode, 200, publish.body);
    const repriced = await quote(app, 10_000_000);
    assert.equal(repriced.consultationFeeFen, 16_000);
    assert.deepEqual(repriced.administrativeFees, {
      plateFeeFen: 13_000,
      mailingFeeFen: 3_000,
      productionFeeFen: 2_000,
    });
    assert.equal(repriced.administrativeFeeFen, 18_000);
    assert.equal(repriced.totalTransferCostFen, 34_000);
    assert.notEqual(repriced.planVersion, frozen.planVersion);
    assert.equal(frozen.consultationFeeFen, 15_000);
    assert.equal(frozen.administrativeFeeFen, 15_000);
    assert.equal(frozen.totalTransferCostFen, 30_000);
    const frozenRow = await database.prepare<Json>(`
      SELECT consultation_fee_fen, plate_fee_fen, mailing_fee_fen, production_fee_fen,
        administrative_fee_fen, total_transfer_cost_fen, fee_plan_version
      FROM subsidy_consultation_quote_snapshots WHERE id = ?
    `).get(frozen.id);
    assert.equal(Number(frozenRow?.consultation_fee_fen), 15_000);
    assert.equal(Number(frozenRow?.plate_fee_fen), 12_000);
    assert.equal(Number(frozenRow?.mailing_fee_fen), 2_000);
    assert.equal(Number(frozenRow?.production_fee_fen), 1_000);
    assert.equal(Number(frozenRow?.administrative_fee_fen), 15_000);
    assert.equal(Number(frozenRow?.total_transfer_cost_fen), 30_000);
    assert.equal(Number(frozenRow?.fee_plan_version), frozen.planVersion);

    for (const invalidAdministrativeFees of [
      { plateFeeFen: -1, mailingFeeFen: 2_000, productionFeeFen: 1_000 },
      { plateFeeFen: 1_000_001, mailingFeeFen: 2_000, productionFeeFen: 1_000 },
      { plateFeeFen: 12_000.5, mailingFeeFen: 2_000, productionFeeFen: 1_000 },
    ]) {
      const invalidFees = await app.inject({
        method: "PUT",
        url: "/api/admin/subsidy-consultation/fee-plan/draft",
        payload: { active: true, administrativeFees: invalidAdministrativeFees, tiers: changedTiers },
      });
      assert.equal(invalidFees.statusCode, 400, invalidFees.body);
      assert.equal(invalidFees.json<Json>().error.code, "VALIDATION_ERROR");
    }

    const invalidPlan = await app.inject({
      method: "PUT",
      url: "/api/admin/subsidy-consultation/fee-plan/draft",
      payload: {
        active: true,
        tiers: [
          { id: "overlap-a", label: "A", minValueFen: 0, maxValueFen: 30_000_000, feeFen: 1, sortOrder: 10 },
          { id: "overlap-b", label: "B", minValueFen: 20_000_000, maxValueFen: 50_000_000, feeFen: 2, sortOrder: 20 },
        ],
      },
    });
    assert.equal(invalidPlan.statusCode, 400, invalidPlan.body);

    const gapAndReordered = await app.inject({
      method: "PUT",
      url: "/api/admin/subsidy-consultation/fee-plan/draft",
      payload: {
        active: true,
        tiers: [
          { id: "display-first", label: "20万至30万元", minValueFen: 20_000_000, maxValueFen: 30_000_000, feeFen: 23_000, sortOrder: 10 },
          { id: "display-second", label: "10万元以内", minValueFen: 0, maxValueFen: 10_000_000, feeFen: 13_000, sortOrder: 20 },
        ],
      },
    });
    assert.equal(gapAndReordered.statusCode, 200, gapAndReordered.body);
    assert.deepEqual(
      gapAndReordered.json<Json>().data.draft.tiers.map((tier: Json) => tier.id),
      ["display-first", "display-second"],
    );
    const publishGapPlan = await app.inject({
      method: "POST",
      url: "/api/admin/subsidy-consultation/fee-plan/publish",
    });
    assert.equal(publishGapPlan.statusCode, 200, publishGapPlan.body);
    assert.equal((await quote(app, 5_000_000)).consultationFeeFen, 13_000);
    assert.equal((await quote(app, 25_000_000)).consultationFeeFen, 23_000);
    const unpricedGap = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/quotes",
      payload: { vehicleId: "vehicle-demo-1", declaredValueFen: 15_000_000 },
    });
    assert.equal(unpricedGap.statusCode, 409, unpricedGap.body);
    assert.equal(unpricedGap.json<Json>().error.code, "SUBSIDY_FEE_TIER_NOT_FOUND");
    const semanticAudits = await database.prepare<Json>(`
      SELECT action,before_json,after_json,metadata_json
      FROM backoffice_audit_events
      WHERE action LIKE 'subsidy.%'
      ORDER BY occurred_at,id
    `).all();
    assert.deepEqual(semanticAudits.map((row) => row.action), [
      "subsidy.fee_plan.publish",
      "subsidy.fee_plan.publish",
    ]);
    assert.equal(semanticAudits.every((row) => row.metadata_json.presentation.category === "subsidy"), true);
    assert.match(JSON.stringify(semanticAudits), /发布补贴咨询价格方案|咨询费/u);
  } finally {
    await close();
  }
});

test("补贴价格发布在语义审计写入失败时整体回滚", async () => {
  const { app, database, close } = await fixture();
  try {
    const current = (await app.inject({ method: "GET", url: "/api/admin/subsidy-consultation/fee-plan" })).json<Json>().data.published;
    const draft = await app.inject({
      method: "PUT",
      url: "/api/admin/subsidy-consultation/fee-plan/draft",
      payload: {
        active: true,
        tiers: current.tiers.map((tier: Json, index: number) => ({
          ...tier,
          feeFen: index === 0 ? Number(tier.feeFen) + 100 : tier.feeFen,
        })),
      },
    });
    assert.equal(draft.statusCode, 200, draft.body);
    await database.execute(`
      CREATE OR REPLACE FUNCTION fail_subsidy_audit_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.action LIKE 'subsidy.%' THEN
          RAISE EXCEPTION 'forced subsidy audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_subsidy_audit_insert
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_subsidy_audit_insert();
    `);
    const publish = await app.inject({ method: "POST", url: "/api/admin/subsidy-consultation/fee-plan/publish" });
    assert.equal(publish.statusCode, 500, publish.body);
    const after = (await app.inject({ method: "GET", url: "/api/admin/subsidy-consultation/fee-plan" })).json<Json>().data;
    assert.equal(after.published.version, current.version);
    assert.equal(after.draft.state, "draft");
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'subsidy.%'
    `).get())?.count), 0);
  } finally {
    await close();
  }
});

test("九项私有材料可绑定咨询，后台按需读取留痕并保持报价快照", async () => {
  const { app, database, subsidyConsultationUploadDir, close } = await fixture();
  try {
    const initial = await config(app);
    assert.deepEqual(initial.materialKinds.map((item: Json) => item.kind), materialKinds);
    const priced = await quote(app, 20_000_000);
    const arbitraryPng = await sharp({
      create: { width: 24, height: 16, channels: 3, background: "#dce8f8" },
    }).png().toBuffer();
    const forbiddenUpload = multipart("id_card_front", arbitraryPng, "possibly-real.png");
    const rejected = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/materials",
      headers: forbiddenUpload.headers,
      payload: forbiddenUpload.body,
    });
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(rejected.json<Json>().error.code, "REAL_DATA_NOT_ACCEPTED");
    const materialIds = await uploadAllMaterials(app);
    const rejectedRealName = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultations",
      headers: { "idempotency-key": "subsidy-real-name-rejected-1" },
      payload: {
        quoteId: priced.id,
        materialIds,
        contactName: "真实姓名",
        contactPhone: "13800138000",
        disclosureVersion: initial.disclosure.version,
        consentAccepted: true,
        legalPurposeAccepted: true,
        administrativeFees: { plateFeeFen: 1, mailingFeeFen: 1, productionFeeFen: 1 },
        administrativeFeeFen: 3,
        totalTransferCostFen: 4,
      },
    });
    assert.equal(rejectedRealName.statusCode, 403, rejectedRealName.body);
    assert.equal(rejectedRealName.json<Json>().error.code, "REAL_DATA_NOT_ACCEPTED");
    const create = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultations",
      headers: { "idempotency-key": "subsidy-consultation-create-1" },
      payload: {
        quoteId: priced.id,
        materialIds,
        contactName: "演示车主",
        contactPhone: "13800138000",
        disclosureVersion: initial.disclosure.version,
        consentAccepted: true,
        legalPurposeAccepted: true,
        administrativeFees: { plateFeeFen: 1, mailingFeeFen: 1, productionFeeFen: 1 },
        administrativeFeeFen: 3,
        totalTransferCostFen: 4,
      },
    });
    assert.equal(create.statusCode, 201, create.body);
    const receipt = create.json<Json>().data.receipt;
    assert.equal(receipt.status, "new");
    assert.equal(receipt.consultationFeeFen, 15_000);
    assert.deepEqual(receipt.administrativeFees, {
      plateFeeFen: 12_000,
      mailingFeeFen: 2_000,
      productionFeeFen: 1_000,
    });
    assert.equal(receipt.administrativeFeeFen, 15_000);
    assert.equal(receipt.totalTransferCostFen, 30_000);
    assert.equal(receipt.maskedPhone, "138****8000");
    assert.equal(receipt.materialKinds.length, 9);

    const storedConsultation = await database.prepare<Json>(`
      SELECT contact_ciphertext, phone_hmac FROM subsidy_consultations WHERE id = ?
    `).get(receipt.id);
    assert.match(String(storedConsultation?.contact_ciphertext), /^v1\.demo\./u);
    assert.equal(String(storedConsultation?.contact_ciphertext).includes("13800138000"), false);
    assert.equal(String(storedConsultation?.phone_hmac).length, 64);
    const storedMaterial = await database.prepare<Json>(`
      SELECT storage_key FROM subsidy_consultation_materials
      WHERE consultation_id = ? ORDER BY created_at LIMIT 1
    `).get(receipt.id);
    const encryptedBytes = readFileSync(join(subsidyConsultationUploadDir, String(storedMaterial?.storage_key)));
    assert.equal(encryptedBytes.subarray(0, 6).toString("ascii"), "YXMSC1");
    assert.notEqual(encryptedBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const replay = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultations",
      headers: { "idempotency-key": "subsidy-consultation-create-1" },
      payload: {
        quoteId: priced.id,
        materialIds,
        contactName: "演示车主",
        contactPhone: "13800138000",
        disclosureVersion: initial.disclosure.version,
        consentAccepted: true,
        legalPurposeAccepted: true,
      },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json<Json>().data.receipt.id, receipt.id);

    const ownerRead = await app.inject({ method: "GET", url: `/api/subsidy-consultations/${receipt.id}` });
    assert.equal(ownerRead.statusCode, 200, ownerRead.body);
    assert.equal(ownerRead.json<Json>().data.consultation.consultationFeeFen, 15_000);
    assert.equal(ownerRead.json<Json>().data.consultation.administrativeFeeFen, 15_000);
    assert.equal(ownerRead.json<Json>().data.consultation.totalTransferCostFen, 30_000);

    await seedDevelopmentUser(database, "subsidy-other-user");
    const otherSession = await createUserSession(database, "subsidy-other-user");
    const otherHeaders = { authorization: `Bearer ${otherSession.token}` };
    const crossUserQuote = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultation/quotes",
      headers: otherHeaders,
      payload: { vehicleId: "vehicle-demo-1", declaredValueFen: 20_000_000 },
    });
    assert.equal(crossUserQuote.statusCode, 404, crossUserQuote.body);
    const crossUserRead = await app.inject({
      method: "GET",
      url: `/api/subsidy-consultations/${receipt.id}`,
      headers: otherHeaders,
    });
    assert.equal(crossUserRead.statusCode, 404, crossUserRead.body);

    const list = await app.inject({ method: "GET", url: "/api/admin/subsidy-consultations" });
    assert.equal(list.statusCode, 200, list.body);
    const listItem = list.json<Json>().data.items[0];
    assert.equal(JSON.stringify(listItem).includes("13800138000"), false);
    assert.deepEqual(listItem.administrativeFees, receipt.administrativeFees);
    assert.equal(listItem.administrativeFeeFen, 15_000);
    assert.equal(listItem.totalTransferCostFen, 30_000);
    const detail = await app.inject({ method: "GET", url: `/api/admin/subsidy-consultations/${receipt.id}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.deepEqual(detail.json<Json>().data.administrativeFees, receipt.administrativeFees);
    assert.equal(detail.json<Json>().data.administrativeFeeFen, 15_000);
    assert.equal(detail.json<Json>().data.totalTransferCostFen, 30_000);
    const firstMaterial = detail.json<Json>().data.materials[0];
    const eyeRead = await app.inject({
      method: "GET",
      url: `/api/admin/subsidy-consultations/${receipt.id}/materials/${firstMaterial.id}`,
    });
    assert.equal(eyeRead.statusCode, 200, eyeRead.body);
    assert.match(String(eyeRead.headers["cache-control"]), /private.*no-store/u);
    assert.match(String(eyeRead.headers["content-type"]), /^image\/png/u);
    assert.equal(eyeRead.rawPayload.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const auditCount = await database.prepare<{ count: number }>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM subsidy_consultation_events
      WHERE consultation_id = ? AND action IN ('sensitive_detail_read', 'sensitive_material_read')
    `).get(receipt.id);
    assert.equal(Number(auditCount?.count), 2);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'subsidy.%'
    `).get())?.count), 0, "普通列表、敏感详情和私有材料查看不进入全局操作日志");

    const currentPlan = (await app.inject({
      method: "GET",
      url: "/api/admin/subsidy-consultation/fee-plan",
    })).json<Json>().data.published;
    const changedFees = await app.inject({
      method: "PUT",
      url: "/api/admin/subsidy-consultation/fee-plan/draft",
      payload: {
        active: true,
        administrativeFees: { plateFeeFen: 14_000, mailingFeeFen: 4_000, productionFeeFen: 2_000 },
        tiers: currentPlan.tiers,
      },
    });
    assert.equal(changedFees.statusCode, 200, changedFees.body);
    const changedFeesPublish = await app.inject({
      method: "POST",
      url: "/api/admin/subsidy-consultation/fee-plan/publish",
    });
    assert.equal(changedFeesPublish.statusCode, 200, changedFeesPublish.body);
    const currentQuote = await quote(app, 20_000_000);
    assert.equal(currentQuote.consultationFeeFen, 15_000);
    assert.equal(currentQuote.administrativeFeeFen, 20_000);
    assert.equal(currentQuote.totalTransferCostFen, 35_000);

    const frozenOwnerRead = await app.inject({ method: "GET", url: `/api/subsidy-consultations/${receipt.id}` });
    assert.equal(frozenOwnerRead.statusCode, 200, frozenOwnerRead.body);
    assert.equal(frozenOwnerRead.json<Json>().data.consultation.administrativeFeeFen, 15_000);
    assert.equal(frozenOwnerRead.json<Json>().data.consultation.totalTransferCostFen, 30_000);
    const frozenAdminList = await app.inject({ method: "GET", url: "/api/admin/subsidy-consultations" });
    assert.equal(frozenAdminList.statusCode, 200, frozenAdminList.body);
    assert.equal(frozenAdminList.json<Json>().data.items[0].administrativeFeeFen, 15_000);
    assert.equal(frozenAdminList.json<Json>().data.items[0].totalTransferCostFen, 30_000);
    const frozenAdminDetail = await app.inject({
      method: "GET",
      url: `/api/admin/subsidy-consultations/${receipt.id}`,
    });
    assert.equal(frozenAdminDetail.statusCode, 200, frozenAdminDetail.body);
    assert.equal(frozenAdminDetail.json<Json>().data.administrativeFeeFen, 15_000);
    assert.equal(frozenAdminDetail.json<Json>().data.totalTransferCostFen, 30_000);
    const frozenConsultationRow = await database.prepare<Json>(`
      SELECT plate_fee_fen, mailing_fee_fen, production_fee_fen,
        administrative_fee_fen, total_transfer_cost_fen
      FROM subsidy_consultations WHERE id = ?
    `).get(receipt.id);
    assert.deepEqual(
      [
        Number(frozenConsultationRow?.plate_fee_fen),
        Number(frozenConsultationRow?.mailing_fee_fen),
        Number(frozenConsultationRow?.production_fee_fen),
        Number(frozenConsultationRow?.administrative_fee_fen),
        Number(frozenConsultationRow?.total_transfer_cost_fen),
      ],
      [12_000, 2_000, 1_000, 15_000, 30_000],
    );

    const handled = await app.inject({
      method: "POST",
      url: `/api/admin/subsidy-consultations/${receipt.id}/handle`,
      payload: { result: "consultation_completed", note: "已完成合规咨询演示" },
    });
    assert.equal(handled.statusCode, 200, handled.body);
    assert.equal(handled.json<Json>().data.status, "handled");
    const disclosureBefore = (await app.inject({
      method: "GET",
      url: "/api/admin/subsidy-consultation/disclosure",
    })).json<Json>().data;
    const disclosureUpdate = await app.inject({
      method: "PUT",
      url: "/api/admin/subsidy-consultation/disclosure",
      payload: {
        title: disclosureBefore.title,
        summaryText: `${disclosureBefore.summaryText}（语义审计测试）`,
        consentText: disclosureBefore.consentText,
        legalPurposeText: disclosureBefore.legalPurposeText,
        retentionText: disclosureBefore.retentionText,
        contactEtaText: disclosureBefore.contactEtaText,
        officialSourceUrl: disclosureBefore.officialSourceUrl,
      },
    });
    assert.equal(disclosureUpdate.statusCode, 200, disclosureUpdate.body);
    const semanticAudits = await database.prepare<Json>(`
      SELECT action,before_json,after_json,metadata_json
      FROM backoffice_audit_events
      WHERE action LIKE 'subsidy.%'
      ORDER BY occurred_at,id
    `).all();
    assert.deepEqual(semanticAudits.map((row) => row.action), [
      "subsidy.fee_plan.publish",
      "subsidy.consultation.handle",
      "subsidy.disclosure.publish",
    ]);
    const serializedAudits = JSON.stringify(semanticAudits);
    assert.doesNotMatch(serializedAudits, /13800138000|演示车主|已完成合规咨询演示|语义审计测试/u);
    assert.match(serializedAudits, /处理补贴咨询|发布补贴咨询授权说明/u);
    const withdrawHandled = await app.inject({
      method: "POST",
      url: `/api/subsidy-consultations/${receipt.id}/withdraw`,
    });
    assert.equal(withdrawHandled.statusCode, 409, withdrawHandled.body);

    const cleanup = await cleanupSubsidyConsultationData(
      database,
      subsidyConsultationUploadDir,
      new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000),
    );
    assert.equal(cleanup.materialsDeleted, 9);
    assert.equal(cleanup.piiPurged, 1);
    const purged = await database.prepare<Json>(`
      SELECT contact_ciphertext, phone_hmac, pii_purged_at
      FROM subsidy_consultations WHERE id = ?
    `).get(receipt.id);
    assert.equal(purged?.contact_ciphertext, null);
    assert.equal(purged?.phone_hmac, null);
    assert.ok(purged?.pii_purged_at);
    const anonymizedQuote = await database.prepare<Json>(`
      SELECT user_id, vehicle_id FROM subsidy_consultation_quote_snapshots WHERE id = ?
    `).get(priced.id);
    assert.equal(anonymizedQuote?.user_id, null);
    assert.equal(anonymizedQuote?.vehicle_id, null);
  } finally {
    await close();
  }
});

test("单个材料删除失败会保留重试且不阻断后续材料、PII 与事件清理", async () => {
  const { app, database, subsidyConsultationUploadDir, close } = await fixture();
  try {
    const initial = await config(app);
    const priced = await quote(app, 20_000_000);
    const materialIds = await uploadAllMaterials(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/subsidy-consultations",
      headers: { "idempotency-key": "subsidy-retention-isolation-1" },
      payload: {
        quoteId: priced.id,
        materialIds,
        contactName: "演示车主",
        contactPhone: "13800138000",
        disclosureVersion: initial.disclosure.version,
        consentAccepted: true,
        legalPurposeAccepted: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const consultationId = created.json<Json>().data.receipt.id;
    const handled = await app.inject({
      method: "POST",
      url: `/api/admin/subsidy-consultations/${consultationId}/handle`,
      payload: { result: "consultation_completed" },
    });
    assert.equal(handled.statusCode, 200, handled.body);

    const materials = await database.prepare<Json>(`
      SELECT id, storage_key FROM subsidy_consultation_materials
      WHERE consultation_id = ? ORDER BY created_at, id
    `).all(consultationId);
    assert.equal(materials.length, 9);
    const failingStorageKey = "retention-unlink-failure";
    mkdirSync(join(subsidyConsultationUploadDir, failingStorageKey));
    await database.prepare(`
      UPDATE subsidy_consultation_materials SET storage_key = ? WHERE id = ?
    `).run(failingStorageKey, materials[0].id);
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    await database.prepare(`
      UPDATE subsidy_consultation_events SET delete_after = ?
      WHERE id = (
        SELECT id FROM subsidy_consultation_events
        WHERE consultation_id = ? ORDER BY created_at, id LIMIT 1
      )
    `).run(dueAt, consultationId);

    const cleanup = await cleanupSubsidyConsultationData(
      database,
      subsidyConsultationUploadDir,
      new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000),
    );
    assert.equal(cleanup.materialDeleteFailures, 1);
    assert.equal(cleanup.materialsDeleted, 8);
    assert.equal(cleanup.piiPurged, 1);
    assert.ok(cleanup.eventsDeleted >= 1);

    const retained = await database.prepare<Json>(`
      SELECT state, storage_key, user_id, deleted_at
      FROM subsidy_consultation_materials WHERE id = ?
    `).get(materials[0].id);
    assert.equal(retained?.state, "bound");
    assert.equal(retained?.storage_key, failingStorageKey);
    assert.equal(retained?.user_id, null);
    assert.equal(retained?.deleted_at, null);
    const subsequent = await database.prepare<Json>(`
      SELECT state, storage_key, deleted_at
      FROM subsidy_consultation_materials WHERE id = ?
    `).get(materials[1].id);
    assert.equal(subsequent?.state, "deleted");
    assert.equal(subsequent?.storage_key, null);
    assert.ok(subsequent?.deleted_at);
    const purged = await database.prepare<Json>(`
      SELECT contact_ciphertext, phone_hmac, pii_purged_at
      FROM subsidy_consultations WHERE id = ?
    `).get(consultationId);
    assert.equal(purged?.contact_ciphertext, null);
    assert.equal(purged?.phone_hmac, null);
    assert.ok(purged?.pii_purged_at);
    const overdueEvents = await database.prepare<{ count: number }>(`
      SELECT COUNT(*)::INTEGER AS count FROM subsidy_consultation_events
      WHERE delete_after <= ?
    `).get(new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000).toISOString());
    assert.equal(Number(overdueEvents?.count), 0);
  } finally {
    await close();
  }
});
