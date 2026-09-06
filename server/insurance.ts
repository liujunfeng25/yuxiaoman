import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import { auditBackofficeEvent } from "./backoffice.js";
import type { AppDatabase } from "./database.js";
import { stableJson } from "./db.js";
import {
  computeInsuranceDisclosureVersion,
  DEMO_INSURANCE_PARTNER_ID,
  seedInsurancePartner,
} from "./insurance-db.js";

type Row = Record<string, unknown>;
type ProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

type InsuranceMode = "demo" | "real";

type InsuranceRouteOptions = {
  problem: ProblemFactory;
  uploadDir: string;
  cleanupIntervalMs?: number;
};

const SOURCE = "web-owner-services";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_DATA_KEY = createHash("sha256").update("yuxiaoman-insurance-demo-data-key-v1").digest();
const DEMO_PHONE_HMAC_KEY = "yuxiaoman-insurance-demo-phone-hmac-key-v1";
const DEMO_PHONES = new Set(["13800138000", "13900000000"]);

const renewalWindowSchema = z.enum([
  "within_30_days",
  "one_to_three_months",
  "over_three_months",
]);
const contactWindowSchema = z.enum(["morning", "afternoon", "evening", "anytime"]);
const closeResultSchema = z.enum([
  "completed_referral",
  "customer_declined",
  "unable_to_contact",
  "invalid_lead",
]);

type InsuranceAuditChange = {
  field?: string;
  label: string;
  before?: unknown;
  after?: unknown;
};

const INSURANCE_CLOSE_RESULT_LABELS: Record<z.infer<typeof closeResultSchema>, string> = {
  completed_referral: "完成服务转介",
  customer_declined: "客户暂不需要",
  unable_to_contact: "多次联系未果",
  invalid_lead: "无效线索",
};

function insurancePresentation(input: {
  actionLabel: string;
  summary: string;
  resourceLabel?: string;
  changes?: InsuranceAuditChange[];
  reason?: string;
}) {
  return {
    category: "insurance",
    actionLabel: input.actionLabel,
    summary: input.summary,
    subjectName: "车险服务",
    resourceLabel: input.resourceLabel,
    changes: input.changes,
    reason: input.reason,
  };
}

const leadFieldsSchema = z.object({
  vehicleId: z.string().trim().min(1).max(100),
  contactName: z.string().trim().min(1).max(30),
  contactPhone: z.string().trim().regex(/^1[3-9]\d{9}$/u),
  renewalWindow: renewalWindowSchema,
  contactWindow: contactWindowSchema,
  disclosureVersion: z.string().trim().min(8).max(100),
  consentAccepted: z.literal("true"),
});

const handoffSchema = z.object({ partnerId: z.string().trim().min(1).max(100) });
const closeSchema = z.object({ result: closeResultSchema });
const partnerSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{2,99}$/u),
  name: z.string().trim().min(2).max(120),
  recipientName: z.string().trim().min(2).max(180),
  dataScope: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  purpose: z.string().trim().min(4).max(500),
  retention: z.string().trim().min(4).max(500),
  consentText: z.string().trim().min(8).max(1000),
  contactEtaText: z.string().trim().min(2).max(120),
  active: z.boolean(),
  isDefault: z.boolean(),
});

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * DAY_MS).toISOString();
}

function jsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function insurancePublicBaseUrlIsHttps(value = process.env.INSURANCE_PUBLIC_BASE_URL): boolean {
  try {
    return new URL(value ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

function parseConfiguredDataKey(): Buffer | null {
  const value = process.env.INSURANCE_DATA_KEY?.trim();
  if (!value) return null;
  if (/^[a-f0-9]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

async function defaultPartner(database: AppDatabase, synthetic: boolean): Promise<Row | undefined> {
  if (synthetic) {
    return await database.prepare<Row>(`
      SELECT * FROM service_partners
      WHERE id = ? AND service_type = 'insurance' AND is_active = 1
    `).get(DEMO_INSURANCE_PARTNER_ID);
  }
  return await database.prepare<Row>(`
    SELECT * FROM service_partners
    WHERE service_type = 'insurance' AND is_active = 1 AND is_default = 1 AND is_synthetic = 0
  `).get();
}

export function insuranceRealConfigurationReady(): boolean {
  return process.env.INSURANCE_REAL_MODE === "true"
    && insurancePublicBaseUrlIsHttps()
    && parseConfiguredDataKey() !== null
    && (process.env.INSURANCE_PHONE_HMAC_KEY?.trim().length ?? 0) >= 32;
}

async function requestMode(_request: FastifyRequest, database: AppDatabase): Promise<InsuranceMode> {
  return insuranceRealConfigurationReady() && Boolean(await defaultPartner(database, false))
    ? "real"
    : "demo";
}

function dataKeyForLabel(label: InsuranceMode): Buffer {
  if (label === "real") return parseConfiguredDataKey() ?? DEMO_DATA_KEY;
  return DEMO_DATA_KEY;
}

function phoneHmacKey(mode: InsuranceMode): string {
  return mode === "real"
    ? process.env.INSURANCE_PHONE_HMAC_KEY!.trim()
    : DEMO_PHONE_HMAC_KEY;
}

function encryptContact(value: { name: string; phone: string }, mode: InsuranceMode): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKeyForLabel(mode), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", mode, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptContact(value: unknown): { name: string; phone: string } | null {
  if (!value) return null;
  const [version, label, ivValue, tagValue, ciphertextValue] = String(value).split(".");
  if (version !== "v1" || (label !== "demo" && label !== "real") || !ivValue || !tagValue || !ciphertextValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKeyForLabel(label), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as { name?: unknown; phone?: unknown };
    return typeof parsed.name === "string" && typeof parsed.phone === "string"
      ? { name: parsed.name, phone: parsed.phone }
      : null;
  } catch {
    return null;
  }
}

function phoneHmac(phone: string, mode: InsuranceMode): string {
  return createHmac("sha256", phoneHmacKey(mode)).update(phone).digest("hex");
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function maskName(name: string): string {
  return name.length <= 1 ? `${name}*` : `${name.slice(0, 1)}${"*".repeat(Math.min(2, name.length - 1))}`;
}

function maskPlate(plate: string): string {
  const compact = plate.replace(/[·\s-]/gu, "");
  if (compact.length < 4) return "***";
  return `${compact.slice(0, 2)}·***${compact.slice(-2)}`;
}

function leadCode(now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `YXM-INS-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function signedDigest(secret: string | Buffer, value: string): string {
  return createHmac("sha256", secret)
    .update("yuxiaoman-insurance-withdraw-v1")
    .update("\0")
    .update(value)
    .digest("base64url");
}

function withdrawToken(leadId: string, mode: InsuranceMode): string {
  const encoded = Buffer.from(leadId, "utf8").toString("base64url");
  const signature = signedDigest(dataKeyForLabel(mode), leadId);
  return `${encoded}.${signature}`;
}

function withdrawTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseWithdrawToken(token: string): { id: string; mode: InsuranceMode } | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  let id: string;
  try {
    id = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) return null;
  for (const mode of ["real", "demo"] as const) {
    if (mode === "real" && parseConfiguredDataKey() === null) continue;
    const expected = signedDigest(dataKeyForLabel(mode), id);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)) return { id, mode };
  }
  return null;
}

function partnerDisclosure(row: Row, mode: InsuranceMode) {
  return {
    mode,
    acceptsRealData: mode === "real",
    version: String(row.disclosure_version),
    partner: {
      id: String(row.id),
      name: String(row.name),
      recipientName: String(row.recipient_name),
    },
    dataScope: jsonArray(row.data_scope_json),
    purpose: String(row.purpose),
    retention: String(row.retention_text),
    consentText: String(row.consent_text),
    contactEtaText: String(row.contact_eta_text),
  };
}

async function disclosureForRequest(request: FastifyRequest, database: AppDatabase) {
  const mode = await requestMode(request, database);
  const partner = await defaultPartner(database, mode === "demo");
  if (!partner) throw new Error("Insurance disclosure partner is missing");
  return { mode, partner, data: partnerDisclosure(partner, mode) };
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown, problem: ProblemFactory): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "_root"] = issue.message;
    throw problem(400, "VALIDATION_ERROR", "提交的信息有误，请检查后重试", fields);
  }
  return parsed.data;
}

function runTransaction<T>(
  database: AppDatabase,
  operation: (transaction: AppDatabase) => T | Promise<T>,
): Promise<T> {
  return database.transaction(operation);
}

async function insertEvent(
  database: AppDatabase,
  leadId: string,
  action: string,
  actorType: "owner" | "admin" | "system",
  detail: Record<string, unknown> = {},
  now = new Date(),
): Promise<void> {
  await database.prepare(`
    INSERT INTO service_lead_events (
      id, lead_id, action, actor_type, detail_json, created_at, delete_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), leadId, action, actorType, JSON.stringify(detail), now.toISOString(), addDays(now, 365));
}

async function leadRows(database: AppDatabase, id: string) {
  const lead = await database.prepare<Row>("SELECT * FROM service_leads WHERE id = ? AND service_type = 'insurance'").get(id);
  if (!lead) return null;
  const [details, partner, media] = await Promise.all([
    database.prepare<Row>("SELECT * FROM insurance_lead_details WHERE lead_id = ?").get(id),
    database.prepare<Row>("SELECT * FROM service_partners WHERE id = ?").get(String(lead.partner_id)),
    database.prepare<Row>("SELECT * FROM service_lead_media WHERE lead_id = ?").get(id),
  ]);
  return { lead, details, partner, media };
}

async function publicReceipt(database: AppDatabase, lead: Row, duplicate: boolean) {
  const rows = await leadRows(database, String(lead.id));
  const snapshot = jsonObject(rows?.details?.vehicle_snapshot_json);
  const consent = jsonObject(lead.consent_snapshot_json);
  const tokenMode = Number(lead.is_synthetic) === 1 ? "demo" : "real";
  return {
    leadCode: String(lead.lead_code),
    submittedAt: String(lead.submitted_at),
    vehicle: {
      id: snapshot.id == null ? null : String(snapshot.id),
      plateNumber: String(snapshot.plateNumber ?? lead.vehicle_plate_masked),
      modelName: String(snapshot.modelName ?? lead.vehicle_model_name),
      exteriorColor: snapshot.exteriorColor == null ? null : String(snapshot.exteriorColor),
    },
    maskedPhone: String(lead.masked_phone),
    contactNameMasked: String(lead.contact_name_masked),
    contactEtaText: String(consent.contactEtaText ?? rows?.partner?.contact_eta_text ?? "专业服务人员将在 1 个工作日内联系"),
    withdrawToken: withdrawToken(String(lead.id), tokenMode),
    duplicate,
    status: String(lead.status),
    source: SOURCE,
  };
}

async function adminListItem(database: AppDatabase, lead: Row) {
  const rows = await leadRows(database, String(lead.id));
  const snapshot = jsonObject(rows?.details?.vehicle_snapshot_json);
  return {
    id: String(lead.id),
    leadCode: String(lead.lead_code),
    status: String(lead.status),
    source: String(lead.source),
    vehicle: {
      id: snapshot.id == null ? null : String(snapshot.id),
      plateNumber: String(lead.vehicle_plate_masked),
      modelName: String(snapshot.modelName ?? lead.vehicle_model_name),
      exteriorColor: snapshot.exteriorColor == null ? null : String(snapshot.exteriorColor),
    },
    contactNameMasked: String(lead.contact_name_masked),
    maskedPhone: String(lead.masked_phone),
    renewalWindow: String(rows?.details?.renewal_window ?? ""),
    contactWindow: String(rows?.details?.contact_window ?? ""),
    partnerName: rows?.partner ? String(rows.partner.name) : null,
    submittedAt: String(lead.submitted_at),
    handedOffAt: lead.handed_off_at == null ? null : String(lead.handed_off_at),
    closedAt: lead.closed_at == null ? null : String(lead.closed_at),
  };
}

async function adminDetail(database: AppDatabase, lead: Row) {
  const rows = await leadRows(database, String(lead.id));
  if (!rows) return null;
  const contact = decryptContact(lead.contact_ciphertext);
  const consent = jsonObject(lead.consent_snapshot_json);
  const events = await database.prepare<Row>(`
    SELECT * FROM service_lead_events WHERE lead_id = ? ORDER BY created_at ASC, id ASC
  `).all(String(lead.id));
  return {
    ...await adminListItem(database, lead),
    contact: contact ?? { name: "已按留存策略清除", phone: "已按留存策略清除" },
    disclosure: {
      version: String(consent.version ?? lead.disclosure_version),
      partnerName: String((consent.partner as Record<string, unknown> | undefined)?.name ?? rows.partner?.name ?? ""),
      dataScope: Array.isArray(consent.dataScope) ? consent.dataScope.map(String) : [],
      purpose: String(consent.purpose ?? ""),
      retention: String(consent.retention ?? ""),
      consentText: String(consent.consentText ?? ""),
      acceptedAt: String(consent.acceptedAt ?? lead.submitted_at),
    },
    media: rows.media
      ? {
          available: rows.media.deleted_at == null,
          filename: String(rows.media.original_filename),
          mimeType: String(rows.media.mime_type),
          sizeBytes: Number(rows.media.size_bytes),
          deleteAfter: String(rows.media.delete_after),
        }
      : { available: false, filename: null, mimeType: null, sizeBytes: 0, deleteAfter: null },
    events: events.map((event) => ({
      id: String(event.id),
      action: String(event.action),
      actorType: String(event.actor_type),
      detail: jsonObject(event.detail_json),
      createdAt: String(event.created_at),
    })),
    closeResult: lead.close_result == null ? null : String(lead.close_result),
    withdrawnAt: lead.withdrawn_at == null ? null : String(lead.withdrawn_at),
    handoffSnapshot: lead.handoff_snapshot_json == null ? null : jsonObject(lead.handoff_snapshot_json),
    piiPurgedAt: lead.pii_purged_at == null ? null : String(lead.pii_purged_at),
  };
}

type ParsedLeadMultipart = {
  fields: z.infer<typeof leadFieldsSchema>;
  processed: Buffer;
  width: number;
  height: number;
  contentHash: string;
};

async function parseLeadMultipart(request: FastifyRequest, problem: ProblemFactory): Promise<ParsedLeadMultipart> {
  if (!request.isMultipart()) throw problem(415, "MULTIPART_REQUIRED", "请使用 multipart/form-data 提交保险需求");
  const allowedFields = new Set([
    "vehicleId",
    "contactName",
    "contactPhone",
    "renewalWindow",
    "contactWindow",
    "disclosureVersion",
    "consentAccepted",
  ]);
  const fields: Record<string, string> = {};
  let source: Buffer | null = null;
  let fileCount = 0;
  try {
    for await (const part of request.parts({
      limits: { fields: 12, files: 1, fileSize: 5 * 1024 * 1024, parts: 13 },
    })) {
      if (part.type === "file") {
        fileCount += 1;
        if (part.fieldname !== "licensePhoto") throw problem(400, "INVALID_MEDIA_FIELD", "行驶证照片字段必须为 licensePhoto");
        if (!/^image\/(jpeg|png|webp)$/iu.test(part.mimetype)) {
          throw problem(415, "INVALID_MEDIA_TYPE", "行驶证照片仅支持 JPG、PNG 或 WebP");
        }
        source = await part.toBuffer();
        if (source.length > 5 * 1024 * 1024 || Boolean((part.file as typeof part.file & { truncated?: boolean }).truncated)) {
          throw problem(413, "MEDIA_TOO_LARGE", "行驶证照片不能超过 5MB");
        }
      } else {
        if (!allowedFields.has(part.fieldname)) throw problem(400, "UNEXPECTED_FIELD", `不支持字段 ${part.fieldname}`);
        if (part.fieldname in fields) throw problem(400, "DUPLICATE_FIELD", `字段 ${part.fieldname} 不能重复`);
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw problem(413, "MEDIA_TOO_LARGE", "行驶证照片不能超过 5MB");
    if (code === "FST_FILES_LIMIT") throw problem(400, "MEDIA_COUNT_INVALID", "必须且只能上传一张行驶证照片");
    throw error;
  }
  if (fileCount !== 1 || !source) throw problem(400, "LICENSE_PHOTO_REQUIRED", "请上传一张行驶证照片");
  const parsedFields = parseBody(leadFieldsSchema, fields, problem);
  let detectedFormat: string | undefined;
  try {
    detectedFormat = (await sharp(source, { failOn: "error" }).metadata()).format;
  } catch {
    throw problem(400, "INVALID_MEDIA", "行驶证照片已损坏或无法识别");
  }
  if (!detectedFormat || !["jpeg", "png", "webp"].includes(detectedFormat)) {
    throw problem(415, "INVALID_MEDIA_TYPE", "行驶证照片实际格式仅支持 JPG、PNG 或 WebP");
  }
  let output;
  try {
    output = await sharp(source, { failOn: "error" })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw problem(400, "INVALID_MEDIA", "行驶证照片已损坏或无法识别");
  }
  return {
    fields: parsedFields,
    processed: output.data,
    width: output.info.width,
    height: output.info.height,
    contentHash: createHash("sha256").update(output.data).digest("hex"),
  };
}

export async function cleanupInsuranceData(
  database: AppDatabase,
  uploadDir: string,
  now = new Date(),
): Promise<{ mediaDeleted: number; piiPurged: number; eventsDeleted: number }> {
  const nowIso = now.toISOString();
  const mediaRows = await database.prepare<Row>(`
    SELECT * FROM service_lead_media WHERE deleted_at IS NULL AND delete_after <= ?
  `).all(nowIso);
  let mediaDeleted = 0;
  for (const media of mediaRows) {
    try {
      await unlink(join(uploadDir, String(media.storage_key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await database.prepare(`
      UPDATE service_lead_media SET deleted_at = ?, content_hash = 'purged' WHERE id = ?
    `).run(nowIso, String(media.id));
    await insertEvent(database, String(media.lead_id), "media_retention_deleted", "system", {}, now);
    mediaDeleted += 1;
  }

  const piiRows = await database.prepare<Row>(`
    SELECT id FROM service_leads
    WHERE pii_purged_at IS NULL AND pii_delete_after IS NOT NULL AND pii_delete_after <= ?
  `).all(nowIso);
  for (const row of piiRows) {
    await database.prepare(`
      UPDATE service_leads SET
        vehicle_id = NULL, contact_ciphertext = NULL, phone_hmac = NULL,
        request_hash = NULL, contact_name_masked = '已清除', masked_phone = '已清除',
        vehicle_plate_masked = '已清除', vehicle_model_name = '已清除',
        pii_purged_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso, nowIso, String(row.id));
    await database.prepare(`
      UPDATE insurance_lead_details SET vehicle_snapshot_json = '{}', updated_at = ? WHERE lead_id = ?
    `).run(nowIso, String(row.id));
    await insertEvent(database, String(row.id), "pii_retention_purged", "system", {}, now);
  }
  const deleted = await database.prepare("DELETE FROM service_lead_events WHERE delete_after <= ?").run(nowIso);
  return { mediaDeleted, piiPurged: piiRows.length, eventsDeleted: Number(deleted.changes) };
}

async function partnersAdminPayload(request: FastifyRequest, database: AppDatabase) {
  const mode = await requestMode(request, database);
  const selected = (await defaultPartner(database, mode === "demo"))!;
  const rows = await database.prepare<Row>(`
    SELECT * FROM service_partners WHERE service_type = 'insurance' ORDER BY is_default DESC, created_at ASC
  `).all();
  return {
    mode,
    activePartnerId: String(selected.id),
    partners: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      recipientName: String(row.recipient_name),
      active: Number(row.is_active) === 1,
      isDefault: Number(row.is_default) === 1,
    })),
    disclosure: partnerDisclosure(selected, mode),
  };
}

export async function registerInsuranceRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: InsuranceRouteOptions,
): Promise<void> {
  const { problem, uploadDir } = options;
  const cleanupIntervalMs = Math.max(0, options.cleanupIntervalMs ?? 15 * 60 * 1000);
  await mkdir(uploadDir, { recursive: true });
  await seedInsurancePartner(database);
  await cleanupInsuranceData(database, uploadDir);
  let lastCleanupStartedAt = Date.now();
  let cleanupInFlight: Promise<void> | null = null;
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/insurance/") && !request.url.startsWith("/api/admin/insurance/")) return;
    const now = Date.now();
    if (!cleanupInFlight && now - lastCleanupStartedAt < cleanupIntervalMs) return;
    if (!cleanupInFlight) {
      lastCleanupStartedAt = now;
      cleanupInFlight = cleanupInsuranceData(database, uploadDir)
        .then(() => undefined)
        .catch((error: unknown) => {
          app.log.error({ error }, "insurance retention cleanup failed");
        })
        .finally(() => {
          cleanupInFlight = null;
        });
    }
    await cleanupInFlight;
  });

  app.get("/api/insurance/disclosure", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { data: (await disclosureForRequest(request, database)).data };
  });

  app.post("/api/insurance/leads", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 160) {
      throw problem(400, "IDEMPOTENCY_KEY_REQUIRED", "请提供 8 至 160 字符的 Idempotency-Key");
    }
    const parsed = await parseLeadMultipart(request, problem);
    const disclosure = await disclosureForRequest(request, database);
    if (parsed.fields.disclosureVersion !== disclosure.data.version) {
      throw problem(409, "DISCLOSURE_VERSION_MISMATCH", "授权说明已更新，请重新阅读并确认");
    }
    if (disclosure.mode === "demo" && !DEMO_PHONES.has(parsed.fields.contactPhone)) {
      throw problem(403, "REAL_DATA_NOT_ACCEPTED", "演示模式仅接受固定合成资料，请勿提交真实个人信息");
    }
    const vehicle = await database.prepare<Row>(`
      SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(parsed.fields.vehicleId, currentUserId);
    if (!vehicle) throw problem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");

    const normalized = {
      vehicleId: parsed.fields.vehicleId,
      contactName: parsed.fields.contactName,
      contactPhone: parsed.fields.contactPhone,
      renewalWindow: parsed.fields.renewalWindow,
      contactWindow: parsed.fields.contactWindow,
      disclosureVersion: parsed.fields.disclosureVersion,
      consentAccepted: true,
      mediaHash: parsed.contentHash,
    };
    const requestHash = createHash("sha256").update(stableJson(normalized)).digest("hex");
    const idempotencyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
    const findByIdempotencyKey = (tx: AppDatabase = database) => tx.prepare<Row>(
      "SELECT * FROM service_leads WHERE user_id = ? AND idempotency_key = ?",
    ).get(currentUserId, idempotencyDigest);
    const existingByKey = await findByIdempotencyKey();
    if (existingByKey) {
      if (String(existingByKey.request_hash ?? "") !== requestHash) {
        throw problem(409, "IDEMPOTENCY_KEY_CONFLICT", "该 Idempotency-Key 已用于不同的提交内容");
      }
      await insertEvent(database, String(existingByKey.id), "duplicate_receipt_issued", "owner", { reason: "idempotency" });
      return reply.status(200).send({ data: { receipt: await publicReceipt(database, existingByKey, true) } });
    }

    const phoneDigest = phoneHmac(parsed.fields.contactPhone, disclosure.mode);
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const findRecentPhoneVehicle = (tx: AppDatabase = database) => tx.prepare<Row>(`
      SELECT * FROM service_leads
      WHERE service_type = 'insurance' AND user_id = ? AND phone_hmac = ? AND vehicle_id = ?
        AND submitted_at >= ?
      ORDER BY submitted_at DESC LIMIT 1
    `).get(currentUserId, phoneDigest, parsed.fields.vehicleId, since);
    const recent = await findRecentPhoneVehicle();
    if (recent) {
      await insertEvent(database, String(recent.id), "duplicate_receipt_issued", "owner", { reason: "seven_day_phone_vehicle" });
      return reply.status(200).send({ data: { receipt: await publicReceipt(database, recent, true) } });
    }

    const id = randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();
    const token = withdrawToken(id, disclosure.mode);
    const storageKey = `${randomUUID()}.jpg`;
    const maskedPlate = maskPlate(String(vehicle.plate_number));
    const modelName = String(vehicle.vehicle_type);
    const vehicleSnapshot = {
      id: String(vehicle.id),
      plateNumber: String(vehicle.plate_number),
      modelName,
      exteriorColor: vehicle.exterior_color == null ? null : String(vehicle.exterior_color),
    };
    const consentSnapshot = {
      version: disclosure.data.version,
      acceptedAt: nowIso,
      mode: disclosure.mode,
      partner: {
        id: String(disclosure.partner.id),
        name: String(disclosure.partner.name),
        recipientName: String(disclosure.partner.recipient_name),
      },
      dataScope: disclosure.data.dataScope,
      purpose: disclosure.data.purpose,
      retention: disclosure.data.retention,
      consentText: disclosure.data.consentText,
      contactEtaText: disclosure.data.contactEtaText,
      source: SOURCE,
    };
    await writeFile(join(uploadDir, storageKey), parsed.processed, { flag: "wx" });
    let outcome: { lead: Row; duplicate: boolean };
    try {
      outcome = await runTransaction(database, async (transaction) => {
        const locks = [
          `insurance-idempotency:${currentUserId}:${idempotencyDigest}`,
          `insurance-dedup:${currentUserId}:${phoneDigest}:${parsed.fields.vehicleId}`,
        ].sort();
        for (const lock of locks) {
          await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(lock);
        }

        const concurrentByKey = await findByIdempotencyKey(transaction);
        if (concurrentByKey) {
          if (String(concurrentByKey.request_hash ?? "") !== requestHash) {
            throw problem(409, "IDEMPOTENCY_KEY_CONFLICT", "该 Idempotency-Key 已用于不同的提交内容");
          }
          await insertEvent(transaction, String(concurrentByKey.id), "duplicate_receipt_issued", "owner", {
            reason: "idempotency_race",
          });
          return { lead: concurrentByKey, duplicate: true };
        }

        const concurrentRecent = await findRecentPhoneVehicle(transaction);
        if (concurrentRecent) {
          await insertEvent(transaction, String(concurrentRecent.id), "duplicate_receipt_issued", "owner", {
            reason: "seven_day_phone_vehicle_race",
          });
          return { lead: concurrentRecent, duplicate: true };
        }

        await transaction.prepare(`
          INSERT INTO service_leads (
            id, lead_code, service_type, user_id, vehicle_id, vehicle_plate_masked,
            vehicle_model_name, status, source, contact_ciphertext, phone_hmac,
            contact_name_masked, masked_phone, idempotency_key, request_hash,
            withdraw_token_hash, disclosure_version, consent_snapshot_json, partner_id,
            handoff_snapshot_json, is_synthetic, submitted_at, created_at, updated_at
          ) VALUES (?, ?, 'insurance', ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `).run(
          id,
          leadCode(now),
          currentUserId,
          parsed.fields.vehicleId,
          maskedPlate,
          modelName,
          SOURCE,
          encryptContact({ name: parsed.fields.contactName, phone: parsed.fields.contactPhone }, disclosure.mode),
          phoneDigest,
          maskName(parsed.fields.contactName),
          maskPhone(parsed.fields.contactPhone),
          idempotencyDigest,
          requestHash,
          withdrawTokenHash(token),
          disclosure.data.version,
          JSON.stringify(consentSnapshot),
          String(disclosure.partner.id),
          disclosure.mode === "demo" ? 1 : 0,
          nowIso,
          nowIso,
          nowIso,
        );
        await transaction.prepare(`
          INSERT INTO insurance_lead_details (
            lead_id, renewal_window, contact_window, vehicle_snapshot_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, parsed.fields.renewalWindow, parsed.fields.contactWindow, JSON.stringify(vehicleSnapshot), nowIso, nowIso);
        await transaction.prepare(`
          INSERT INTO service_lead_media (
            id, lead_id, kind, storage_key, original_filename, mime_type, size_bytes,
            width, height, content_hash, delete_after, created_at
          ) VALUES (?, ?, 'license_photo', ?, ?, 'image/jpeg', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          id,
          storageKey,
          "license-photo.jpg",
          parsed.processed.length,
          parsed.width,
          parsed.height,
          parsed.contentHash,
          addDays(now, 60),
          nowIso,
        );
        await insertEvent(transaction, id, "lead_created", "owner", {
          source: SOURCE,
          disclosureVersion: disclosure.data.version,
        }, now);
        const created = await transaction.prepare<Row>("SELECT * FROM service_leads WHERE id = ?").get(id);
        if (!created) throw new Error("Created insurance lead could not be read back");
        return { lead: created, duplicate: false };
      });
    } catch (error) {
      await unlink(join(uploadDir, storageKey)).catch(() => undefined);
      throw error;
    }
    if (outcome.duplicate) await unlink(join(uploadDir, storageKey)).catch(() => undefined);
    return reply.status(outcome.duplicate ? 200 : 201).send({
      data: { receipt: await publicReceipt(database, outcome.lead, outcome.duplicate) },
    });
  });

  app.post<{ Params: { withdrawToken: string } }>("/api/insurance/leads/:withdrawToken/withdraw", async (request) => {
    const parsed = parseWithdrawToken(request.params.withdrawToken);
    if (!parsed) throw problem(404, "INSURANCE_LEAD_NOT_FOUND", "撤回凭证无效或线索不存在");
    const row = await database.prepare<Row>("SELECT * FROM service_leads WHERE id = ?").get(parsed.id);
    if (!row || String(row.withdraw_token_hash) !== withdrawTokenHash(request.params.withdrawToken)) {
      throw problem(404, "INSURANCE_LEAD_NOT_FOUND", "撤回凭证无效或线索不存在");
    }
    if (String(row.status) === "closed") throw problem(409, "INSURANCE_LEAD_ALREADY_CLOSED", "已关闭的线索不能撤回");
    if (String(row.status) !== "withdrawn") {
      const now = new Date();
      await runTransaction(database, async (transaction) => {
        const locked = await transaction.prepare<Row>("SELECT * FROM service_leads WHERE id = ? FOR UPDATE").get(parsed.id);
        if (!locked || String(locked.withdraw_token_hash) !== withdrawTokenHash(request.params.withdrawToken)) {
          throw problem(404, "INSURANCE_LEAD_NOT_FOUND", "撤回凭证无效或线索不存在");
        }
        if (String(locked.status) === "closed") {
          throw problem(409, "INSURANCE_LEAD_ALREADY_CLOSED", "已关闭的线索不能撤回");
        }
        if (String(locked.status) === "withdrawn") return;
        await transaction.prepare(`
          UPDATE service_leads SET status = 'withdrawn', withdrawn_at = ?, closed_at = ?,
            pii_delete_after = ?, updated_at = ? WHERE id = ?
        `).run(now.toISOString(), now.toISOString(), addDays(now, 180), now.toISOString(), parsed.id);
        await insertEvent(transaction, parsed.id, "lead_withdrawn", "owner", {}, now);
      });
    } else {
      await insertEvent(database, parsed.id, "withdraw_receipt_read", "owner");
    }
    const updated = await database.prepare<Row>("SELECT * FROM service_leads WHERE id = ?").get(parsed.id);
    if (!updated) throw problem(404, "INSURANCE_LEAD_NOT_FOUND", "撤回凭证无效或线索不存在");
    return { data: { receipt: await publicReceipt(database, updated, String(row.status) === "withdrawn") } };
  });

  app.get<{ Querystring: { status?: string; page?: string; pageSize?: string } }>("/api/admin/insurance/leads", async (request) => {
    const mode = await requestMode(request, database);
    const status = request.query.status?.trim();
    if (status && !["new", "handed_off", "closed", "withdrawn"].includes(status)) {
      throw problem(400, "INVALID_INSURANCE_LEAD_STATUS", "保险线索状态筛选无效");
    }
    const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query.pageSize ?? "20", 10) || 20));
    const where = status ? "WHERE service_type = 'insurance' AND status = ?" : "WHERE service_type = 'insurance'";
    const values = status ? [status] : [];
    const countRow = await database.prepare<Row>(`SELECT COUNT(*) AS count FROM service_leads ${where}`).get(...values);
    const total = Number(countRow?.count ?? 0);
    const rows = await database.prepare<Row>(`
      SELECT * FROM service_leads ${where} ORDER BY submitted_at DESC LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize);
    return { data: { items: await Promise.all(rows.map((row) => adminListItem(database, row))), total, mode } };
  });

  app.get<{ Params: { id: string } }>("/api/admin/insurance/leads/:id", async (request) => {
    const row = await database.prepare<Row>("SELECT * FROM service_leads WHERE id = ?").get(request.params.id);
    if (!row) throw problem(404, "INSURANCE_LEAD_NOT_FOUND", "未找到该保险线索");
    await insertEvent(database, request.params.id, "sensitive_detail_read", "admin");
    return { data: await adminDetail(database, row) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/insurance/leads/:id/media", async (request, reply) => {
    const media = await database.prepare<Row>(`
      SELECT * FROM service_lead_media WHERE lead_id = ? AND deleted_at IS NULL
    `).get(request.params.id);
    if (!media) throw problem(404, "INSURANCE_MEDIA_NOT_FOUND", "保险线索图片不存在或已按策略清除");
    await insertEvent(database, request.params.id, "sensitive_media_read", "admin", { mediaId: String(media.id) });
    reply.header("Cache-Control", "private, no-store");
    reply.header("Content-Disposition", `inline; filename="${String(media.storage_key)}"`);
    reply.type(String(media.mime_type));
    return reply.send(createReadStream(join(uploadDir, String(media.storage_key))));
  });

  app.post<{ Params: { id: string } }>("/api/admin/insurance/leads/:id/handoff", async (request) => {
    const body = parseBody(handoffSchema, request.body, problem);
    const now = new Date();
    const updated = await runTransaction(database, async (transaction) => {
      const row = await transaction.prepare<Row>("SELECT * FROM service_leads WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!row) throw problem(404, "INSURANCE_LEAD_NOT_FOUND", "未找到该保险线索");
      if (String(row.status) !== "new") throw problem(409, "INVALID_INSURANCE_LEAD_TRANSITION", "仅新线索可以转交");
      if (String(row.partner_id) !== body.partnerId) {
        throw problem(409, "PARTNER_NOT_DISCLOSED", "所选接收方不在用户已确认的授权范围内");
      }
      const partner = await transaction.prepare<Row>(
        "SELECT * FROM service_partners WHERE id = ? AND is_active = 1",
      ).get(body.partnerId);
      if (!partner) throw problem(404, "INSURANCE_PARTNER_NOT_FOUND", "未找到可用的保险服务接收方");
      if (String(partner.disclosure_version) !== String(row.disclosure_version)) {
        throw problem(409, "PARTNER_DISCLOSURE_CHANGED", "接收方披露信息已变化，需要用户重新确认授权");
      }
      const consent = jsonObject(row.consent_snapshot_json);
      const handoffSnapshot = {
        partner: consent.partner,
        disclosureVersion: String(row.disclosure_version),
        dataScope: consent.dataScope,
        purpose: consent.purpose,
        handedOffAt: now.toISOString(),
      };
      await transaction.prepare(`
        UPDATE service_leads SET status = 'handed_off', handed_off_at = ?,
          handoff_snapshot_json = ?, updated_at = ? WHERE id = ?
      `).run(now.toISOString(), JSON.stringify(handoffSnapshot), now.toISOString(), request.params.id);
      await transaction.prepare("UPDATE service_lead_media SET delete_after = ? WHERE lead_id = ? AND deleted_at IS NULL")
        .run(addDays(now, 30), request.params.id);
      await insertEvent(transaction, request.params.id, "lead_handed_off", "admin", {
        partnerId: body.partnerId,
        disclosureVersion: String(row.disclosure_version),
      }, now);
      const changed = await transaction.prepare<Row>("SELECT * FROM service_leads WHERE id = ?").get(request.params.id);
      if (!changed) throw new Error("Handed-off insurance lead could not be read back");
      const resourceLabel = `线索 ${String(row.lead_code)} · ${String(row.vehicle_plate_masked)}`;
      const changes: InsuranceAuditChange[] = [
        { field: "status", label: "线索状态", before: "新线索", after: "已转交" },
        { field: "partner", label: "接收合作方", after: String(partner.name) },
        { field: "disclosureVersion", label: "授权版本", after: String(row.disclosure_version) },
      ];
      await auditBackofficeEvent(transaction, {
        request,
        action: "insurance.lead.handoff",
        outcome: "success",
        resource: { type: "insurance_lead", id: request.params.id },
        before: { status: "new", partnerId: String(row.partner_id) },
        after: { status: "handed_off", partnerId: body.partnerId, disclosureVersion: String(row.disclosure_version) },
        metadata: {
          presentation: insurancePresentation({
            actionLabel: "转交车险线索",
            summary: `将车险线索 ${String(row.lead_code)} 转交给 ${String(partner.name)}`,
            resourceLabel,
            changes,
          }),
        },
        occurredAt: now.toISOString(),
      });
      return changed;
    });
    return { data: await adminDetail(database, updated) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/insurance/leads/:id/close", async (request) => {
    const body = parseBody(closeSchema, request.body, problem);
    const now = new Date();
    const updated = await runTransaction(database, async (transaction) => {
      const row = await transaction.prepare<Row>("SELECT * FROM service_leads WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!row) throw problem(404, "INSURANCE_LEAD_NOT_FOUND", "未找到该保险线索");
      if (String(row.status) !== "handed_off") {
        throw problem(409, "INVALID_INSURANCE_LEAD_TRANSITION", "仅已转交的保险线索可以关闭");
      }
      await transaction.prepare(`
        UPDATE service_leads SET status = 'closed', close_result = ?, closed_at = ?,
          pii_delete_after = ?, updated_at = ? WHERE id = ?
      `).run(body.result, now.toISOString(), addDays(now, 180), now.toISOString(), request.params.id);
      await insertEvent(transaction, request.params.id, "lead_closed", "admin", { result: body.result }, now);
      const changed = await transaction.prepare<Row>("SELECT * FROM service_leads WHERE id = ?").get(request.params.id);
      if (!changed) throw new Error("Closed insurance lead could not be read back");
      const resultLabel = INSURANCE_CLOSE_RESULT_LABELS[body.result];
      const resourceLabel = `线索 ${String(row.lead_code)} · ${String(row.vehicle_plate_masked)}`;
      await auditBackofficeEvent(transaction, {
        request,
        action: "insurance.lead.close",
        outcome: "success",
        resource: { type: "insurance_lead", id: request.params.id },
        before: { status: "handed_off" },
        after: { status: "closed", result: body.result },
        metadata: {
          presentation: insurancePresentation({
            actionLabel: "关闭车险线索",
            summary: `关闭车险线索 ${String(row.lead_code)}：${resultLabel}`,
            resourceLabel,
            changes: [
              { field: "status", label: "线索状态", before: "已转交", after: "已关闭" },
              { field: "result", label: "关闭结果", after: resultLabel },
            ],
          }),
        },
        occurredAt: now.toISOString(),
      });
      return changed;
    });
    return { data: await adminDetail(database, updated) };
  });

  app.get("/api/admin/insurance/partners/disclosure", async (request) => {
    return { data: await partnersAdminPayload(request, database) };
  });

  app.put("/api/admin/insurance/partners/disclosure", async (request) => {
    const body = parseBody(partnerSchema, request.body, problem);
    const version = computeInsuranceDisclosureVersion({
      id: body.id,
      name: body.name,
      recipientName: body.recipientName,
      dataScope: body.dataScope,
      purpose: body.purpose,
      retentionText: body.retention,
      consentText: body.consentText,
      contactEtaText: body.contactEtaText,
    });
    const now = new Date().toISOString();
    const synthetic = await requestMode(request, database) !== "real";
    await runTransaction(database, async (transaction) => {
      const existing = await transaction.prepare<Row>(`
        SELECT * FROM service_partners WHERE id = ? AND service_type = 'insurance' FOR UPDATE
      `).get(body.id);
      if (body.active && body.isDefault) {
        await transaction.prepare(`
          UPDATE service_partners SET is_default = 0, updated_at = ?
          WHERE service_type = 'insurance' AND id <> ?
        `).run(now, body.id);
      }
      await transaction.prepare(`
        INSERT INTO service_partners (
          id, service_type, name, recipient_name, data_scope_json, purpose,
          retention_text, consent_text, contact_eta_text, disclosure_version,
          is_active, is_default, is_synthetic, created_at, updated_at
        ) VALUES (?, 'insurance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, recipient_name = excluded.recipient_name,
          data_scope_json = excluded.data_scope_json, purpose = excluded.purpose,
          retention_text = excluded.retention_text, consent_text = excluded.consent_text,
          contact_eta_text = excluded.contact_eta_text, disclosure_version = excluded.disclosure_version,
          is_active = excluded.is_active, is_default = excluded.is_default,
          is_synthetic = excluded.is_synthetic, updated_at = excluded.updated_at
      `).run(
        body.id,
        body.name,
        body.recipientName,
        JSON.stringify(body.dataScope),
        body.purpose,
        body.retention,
        body.consentText,
        body.contactEtaText,
        version,
        body.active ? 1 : 0,
        body.active && body.isDefault ? 1 : 0,
        synthetic ? 1 : 0,
        now,
        now,
      );
      const changes: InsuranceAuditChange[] = [];
      const pushVisibleChange = (field: string, label: string, before: unknown, after: unknown) => {
        if (stableJson(before) !== stableJson(after)) changes.push({ field, label, before, after });
      };
      const pushContentChange = (field: string, label: string, before: unknown, after: unknown) => {
        if (stableJson(before) !== stableJson(after)) changes.push({ field, label });
      };
      pushVisibleChange("partnerName", "合作方名称", existing?.name ?? null, body.name);
      pushVisibleChange(
        "dataKind",
        "资料类型",
        existing ? (Number(existing.is_synthetic) === 1 ? "演示资料" : "真实资料") : "未创建",
        synthetic ? "演示资料" : "真实资料",
      );
      pushContentChange("recipient", "资料接收主体已修改", existing?.recipient_name ?? null, body.recipientName);
      pushContentChange("dataScope", "授权资料范围已修改", existing ? jsonArray(existing.data_scope_json) : null, body.dataScope);
      pushContentChange("purpose", "使用目的已修改", existing?.purpose ?? null, body.purpose);
      pushContentChange("retention", "保存期限已修改", existing?.retention_text ?? null, body.retention);
      pushContentChange("consentText", "用户授权文案已修改", existing?.consent_text ?? null, body.consentText);
      pushContentChange("contactEta", "预计联系时效已修改", existing?.contact_eta_text ?? null, body.contactEtaText);
      pushVisibleChange(
        "active",
        "合作方状态",
        existing ? (Number(existing.is_active) === 1 ? "启用" : "停用") : "未创建",
        body.active ? "启用" : "停用",
      );
      pushVisibleChange(
        "default",
        "默认接收方",
        existing ? (Number(existing.is_default) === 1 ? "是" : "否") : "否",
        body.active && body.isDefault ? "是" : "否",
      );
      pushVisibleChange("version", "授权版本", existing?.disclosure_version ?? null, version);
      if (changes.length > 0) {
        await auditBackofficeEvent(transaction, {
          request,
          action: "insurance.disclosure.update",
          outcome: "success",
          resource: { type: "insurance_partner", id: body.id },
          before: existing ? {
            active: Number(existing.is_active) === 1,
            isDefault: Number(existing.is_default) === 1,
            synthetic: Number(existing.is_synthetic) === 1,
            version: String(existing.disclosure_version),
          } : null,
          after: { active: body.active, isDefault: body.active && body.isDefault, synthetic, version },
          metadata: {
            presentation: insurancePresentation({
              actionLabel: "更新车险授权说明",
              summary: `更新车险合作方 ${body.name} 的授权说明`,
              resourceLabel: `车险合作方 ${body.name}`,
              changes,
            }),
          },
          occurredAt: now,
        });
      }
    });
    return { data: await partnersAdminPayload(request, database) };
  });
}
