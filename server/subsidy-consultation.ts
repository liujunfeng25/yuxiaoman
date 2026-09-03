import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import { auditBackofficeEvent } from "./backoffice.js";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;

export type SubsidyConsultationProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

export type SubsidyConsultationRouteOptions = {
  problem: SubsidyConsultationProblemFactory;
  uploadDir: string;
  cleanupIntervalMs?: number;
  now?: () => Date;
};

export const SUBSIDY_CONSULTATION_MAX_DECLARED_VALUE_FEN = 50_000_000;
export const SUBSIDY_CONSULTATION_QUOTE_VALIDITY_SECONDS = 10 * 60;
export const SUBSIDY_CONSULTATION_ADMINISTRATIVE_ITEM_MAX_FEN = 1_000_000;
export const SUBSIDY_CONSULTATION_MATERIAL_KINDS = [
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

export const SUBSIDY_CONSULTATION_HANDLE_RESULTS = [
  "consultation_completed",
  "customer_declined",
  "unable_to_contact",
  "invalid_submission",
  "compliance_rejected",
] as const;

export type SubsidyConsultationMaterialKind = typeof SUBSIDY_CONSULTATION_MATERIAL_KINDS[number];
export type SubsidyConsultationHandleResult = typeof SUBSIDY_CONSULTATION_HANDLE_RESULTS[number];

type SubsidyAuditChange = {
  field?: string;
  label: string;
  before?: unknown;
  after?: unknown;
};

const SUBSIDY_HANDLE_RESULT_LABELS: Record<SubsidyConsultationHandleResult, string> = {
  consultation_completed: "已完成咨询",
  customer_declined: "车主暂不需要",
  unable_to_contact: "无法联系车主",
  invalid_submission: "提交资料无效",
  compliance_rejected: "不符合合规用途",
};

function subsidyPresentation(input: {
  actionLabel: string;
  summary: string;
  resourceLabel?: string;
  changes?: SubsidyAuditChange[];
  reason?: string;
}) {
  return {
    category: "subsidy",
    actionLabel: input.actionLabel,
    summary: input.summary,
    subjectName: "补贴咨询",
    resourceLabel: input.resourceLabel,
    changes: input.changes,
    reason: input.reason,
  };
}

function subsidyMoney(valueFen: number): string {
  return `¥${(valueFen / 100).toFixed(2)}`;
}

export class SubsidyConsultationDomainError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "SubsidyConsultationDomainError";
  }
}

type SubsidyConsultationMode = "demo" | "real";

const DAY_MS = 24 * 60 * 60 * 1_000;
const STAGED_MATERIAL_DAYS = 1;
const UNHANDLED_EXPIRY_DAYS = 180;
const TERMINAL_RETENTION_DAYS = 90;
const EVENT_RETENTION_DAYS = 365;
const DEFAULT_DISCLOSURE_ID = "subsidy-consultation-disclosure-v1";
const DRAFT_PLAN_ID = "subsidy-consultation-fee-plan-draft";
const DEFAULT_PUBLISHED_PLAN_ID = "subsidy-consultation-fee-plan-v1";
const FILE_MAGIC = Buffer.from("YXMSC1", "ascii");
const DEMO_DATA_KEY = createHash("sha256")
  .update("yuxiaoman-subsidy-consultation-demo-data-key-v1")
  .digest();
const DEMO_PHONE_HMAC_KEY = "yuxiaoman-subsidy-consultation-demo-phone-hmac-key-v1";
const DEMO_CONTACT = { name: "演示车主", phone: "13800138000" } as const;
const DEFAULT_ADMINISTRATIVE_FEES = {
  plateFeeFen: 12_000,
  mailingFeeFen: 2_000,
  productionFeeFen: 1_000,
} as const;

const MATERIAL_LABELS: Record<SubsidyConsultationMaterialKind, { label: string; group: string }> = {
  id_card_front: { label: "身份证人像面", group: "身份证" },
  id_card_back: { label: "身份证国徽面", group: "身份证" },
  driving_license_front: { label: "行驶证主页", group: "行驶证" },
  driving_license_back: { label: "行驶证副页", group: "行驶证" },
  vehicle_front_left: { label: "车辆左前方", group: "车辆咨询参考照片" },
  vehicle_front_right: { label: "车辆右前方", group: "车辆咨询参考照片" },
  vehicle_rear_left: { label: "车辆左后方", group: "车辆咨询参考照片" },
  vehicle_rear_right: { label: "车辆右后方", group: "车辆咨询参考照片" },
  dashboard_started: { label: "车辆启动后仪表盘", group: "车辆咨询参考照片" },
};

const DEMO_PIXEL_GLYPHS: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  C: ["11111", "10000", "10000", "10000", "10000", "10000", "11111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  Y: ["10001", "01010", "00100", "00100", "00100", "00100", "00100"],
};

function demoPixelTextRects(value: string, x: number, y: number, cell = 12): string {
  return [...value].flatMap((character, characterIndex) =>
    (DEMO_PIXEL_GLYPHS[character] ?? DEMO_PIXEL_GLYPHS[" "]).flatMap((row, rowIndex) =>
      [...row].flatMap((bit, columnIndex) => bit === "1"
        ? [`<rect x="${x + characterIndex * cell * 6 + columnIndex * cell}" y="${y + rowIndex * cell}" width="${cell}" height="${cell}" rx="2"/>`]
        : []),
    ),
  ).join("");
}

const DEFAULT_DISCLOSURE = {
  id: DEFAULT_DISCLOSURE_ID,
  title: "补贴政策与资料准备咨询授权",
  summaryText: "本服务仅提供政策信息和资料准备咨询，不代开发票、不代为申报，也不承诺任何补贴结果。",
  consentText: "我同意驭小满为本次咨询处理我提交的联系人、车辆及证件资料，并仅限授权员工按需查看。",
  legalPurposeText: "我确认资料真实、来源合法，仅用于本人车辆的合法政策与材料咨询，不用于虚假交易、虚假申报或套取补贴。",
  retentionText: "未绑定资料 24 小时清理；咨询处理、撤回或过期后 90 天清理影像和敏感字段；未处理咨询 180 天后过期。",
  contactEtaText: "工作人员预计在 1 个工作日内联系",
  officialSourceUrl: "https://www.gov.cn/zhengce/",
};

const DEFAULT_TIERS = [
  { id: "tier-0-200000", label: "20万元以内", minValueFen: 0, maxValueFen: 20_000_000, feeFen: 15_000, sortOrder: 10 },
  { id: "tier-200000-300000", label: "20万至30万元", minValueFen: 20_000_000, maxValueFen: 30_000_000, feeFen: 25_000, sortOrder: 20 },
  { id: "tier-300000-400000", label: "30万至40万元", minValueFen: 30_000_000, maxValueFen: 40_000_000, feeFen: 35_000, sortOrder: 30 },
  { id: "tier-400000-500000", label: "40万至50万元", minValueFen: 40_000_000, maxValueFen: 50_000_000, feeFen: 45_000, sortOrder: 40 },
] as const;

const idSchema = z.string().trim().min(1).max(120);
const materialKindSchema = z.enum(SUBSIDY_CONSULTATION_MATERIAL_KINDS);
const handleResultSchema = z.enum(SUBSIDY_CONSULTATION_HANDLE_RESULTS);
const quoteBodySchema = z.object({
  vehicleId: idSchema,
  declaredValueFen: z.number().int().min(1).max(SUBSIDY_CONSULTATION_MAX_DECLARED_VALUE_FEN),
});
const createConsultationBodySchema = z.object({
  quoteId: idSchema,
  materialIds: z.array(idSchema).length(SUBSIDY_CONSULTATION_MATERIAL_KINDS.length),
  contactName: z.string().trim().min(1).max(30),
  contactPhone: z.string().trim().regex(/^1[3-9]\d{9}$/u),
  disclosureVersion: z.string().trim().min(8).max(120),
  consentAccepted: z.literal(true),
  legalPurposeAccepted: z.literal(true),
});
const handleBodySchema = z.object({
  result: handleResultSchema,
  note: z.string().trim().max(500).optional(),
});
const feeTierInputSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(80),
  minValueFen: z.number().int().min(0).max(SUBSIDY_CONSULTATION_MAX_DECLARED_VALUE_FEN - 1),
  maxValueFen: z.number().int().min(1).max(SUBSIDY_CONSULTATION_MAX_DECLARED_VALUE_FEN),
  feeFen: z.number().int().min(0).max(10_000_000).optional(),
  consultationFeeFen: z.number().int().min(0).max(10_000_000).optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000),
}).refine((value) => value.feeFen !== undefined || value.consultationFeeFen !== undefined, {
  path: ["feeFen"],
  message: "请填写咨询服务价格",
});
const administrativeFeesInputSchema = z.object({
  plateFeeFen: z.number().int().min(0).max(SUBSIDY_CONSULTATION_ADMINISTRATIVE_ITEM_MAX_FEN),
  mailingFeeFen: z.number().int().min(0).max(SUBSIDY_CONSULTATION_ADMINISTRATIVE_ITEM_MAX_FEN),
  productionFeeFen: z.number().int().min(0).max(SUBSIDY_CONSULTATION_ADMINISTRATIVE_ITEM_MAX_FEN),
}).strict();
const feePlanDraftBodySchema = z.object({
  active: z.boolean().optional(),
  isActive: z.boolean().optional(),
  administrativeFees: administrativeFeesInputSchema.optional(),
  tiers: z.array(feeTierInputSchema).min(1).max(20),
}).refine((value) => value.active !== undefined || value.isActive !== undefined, {
  path: ["active"],
  message: "请设置报价方案是否启用",
});
const disclosureBodySchema = z.object({
  title: z.string().trim().min(2).max(120),
  summaryText: z.string().trim().min(8).max(600),
  consentText: z.string().trim().min(8).max(1_000),
  legalPurposeText: z.string().trim().min(8).max(1_000),
  retentionText: z.string().trim().min(8).max(500),
  contactEtaText: z.string().trim().min(2).max(120),
  officialSourceUrl: z.string().trim().min(8).max(500),
});

export type SubsidyConsultationFeeTierInput = {
  id?: string;
  label: string;
  minValueFen: number;
  maxValueFen: number;
  feeFen: number;
  sortOrder: number;
};

export type SubsidyConsultationAdministrativeFees = {
  plateFeeFen: number;
  mailingFeeFen: number;
  productionFeeFen: number;
};

export type SubsidyConsultationFeePlanDraftInput = {
  active: boolean;
  administrativeFees?: SubsidyConsultationAdministrativeFees;
  tiers: SubsidyConsultationFeeTierInput[];
};

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * DAY_MS).toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ownerAuditSubject(userId: string): string {
  return `owner-${sha256(`subsidy-consultation-owner\0${userId}`).slice(0, 24)}`;
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function domainError(
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
): never {
  throw new SubsidyConsultationDomainError(statusCode, code, message, fields);
}

function translateDomainError(error: unknown, problem: SubsidyConsultationProblemFactory): never {
  if (error instanceof SubsidyConsultationDomainError) {
    throw problem(error.statusCode, error.code, error.message, error.fields);
  }
  throw error;
}

async function routeOperation<T>(
  problem: SubsidyConsultationProblemFactory,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateDomainError(error, problem);
  }
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown, problem: SubsidyConsultationProblemFactory): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "_root"] = issue.message;
    throw problem(400, "VALIDATION_ERROR", "提交的信息有误，请检查后重试", fields);
  }
  return parsed.data;
}

function parseConfiguredDataKey(): Buffer | null {
  const value = process.env.SUBSIDY_CONSULTATION_DATA_KEY?.trim();
  if (!value) return null;
  if (/^[a-f0-9]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function configuredAllowedOrigins(): string[] {
  const values = (process.env.SUBSIDY_CONSULTATION_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return [];
  const normalized: string[] = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/u, "")) return [];
      normalized.push(url.origin);
    } catch {
      return [];
    }
  }
  return [...new Set(normalized)];
}

type AdminIdentityConfiguration = { headerName: string; secret: string; subject: string };

function configuredAdminIdentity(): AdminIdentityConfiguration | null {
  const headerName = (
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_HEADER
      ?? process.env.SUBSIDY_CONSULTATION_TRUSTED_ADMIN_HEADER_NAME
      ?? ""
  ).trim().toLowerCase();
  const secret = (
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SECRET
      ?? process.env.SUBSIDY_CONSULTATION_TRUSTED_ADMIN_SECRET
      ?? ""
  ).trim();
  const subject = (
    process.env.SUBSIDY_CONSULTATION_ADMIN_IDENTITY_SUBJECT
      ?? process.env.SUBSIDY_CONSULTATION_TRUSTED_ADMIN_SUBJECT
      ?? ""
  ).trim();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/u.test(headerName) || secret.length < 32 || !subject || subject.length > 160) {
    return null;
  }
  return { headerName, secret, subject };
}

function currentMode(): SubsidyConsultationMode {
  return subsidyConsultationRealConfigurationReady() ? "real" : "demo";
}

function dataKeyForMode(mode: SubsidyConsultationMode): Buffer {
  if (mode === "real") {
    const key = parseConfiguredDataKey();
    if (!key) domainError(503, "SUBSIDY_DATA_KEY_UNAVAILABLE", "补贴咨询加密配置不可用");
    return key;
  }
  return DEMO_DATA_KEY;
}

function phoneHmacKeyForMode(mode: SubsidyConsultationMode): string {
  if (mode === "real") {
    const key = process.env.SUBSIDY_CONSULTATION_PHONE_HMAC_KEY?.trim();
    if (!key || key.length < 32) domainError(503, "SUBSIDY_PHONE_HMAC_KEY_UNAVAILABLE", "补贴咨询去重配置不可用");
    return key;
  }
  return DEMO_PHONE_HMAC_KEY;
}

function encryptContact(value: { name: string; phone: string }, mode: SubsidyConsultationMode): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKeyForMode(mode), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [
    "v1",
    mode,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptContact(value: unknown): { name: string; phone: string } | null {
  const [version, mode, ivValue, tagValue, ciphertextValue] = String(value ?? "").split(".");
  if (version !== "v1" || (mode !== "demo" && mode !== "real") || !ivValue || !tagValue || !ciphertextValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKeyForMode(mode), Buffer.from(ivValue, "base64url"));
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

function encryptFile(value: Buffer, mode: SubsidyConsultationMode): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKeyForMode(mode), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptFile(value: Buffer, mode: SubsidyConsultationMode): Buffer {
  const prefix = value.subarray(0, FILE_MAGIC.length);
  if (prefix.length !== FILE_MAGIC.length || !timingSafeEqual(prefix, FILE_MAGIC)) {
    domainError(500, "SUBSIDY_MEDIA_ENVELOPE_INVALID", "敏感资料无法读取");
  }
  const ivStart = FILE_MAGIC.length;
  const tagStart = ivStart + 12;
  const ciphertextStart = tagStart + 16;
  if (value.length <= ciphertextStart) domainError(500, "SUBSIDY_MEDIA_ENVELOPE_INVALID", "敏感资料无法读取");
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKeyForMode(mode), value.subarray(ivStart, tagStart));
    decipher.setAuthTag(value.subarray(tagStart, ciphertextStart));
    return Buffer.concat([decipher.update(value.subarray(ciphertextStart)), decipher.final()]);
  } catch {
    domainError(500, "SUBSIDY_MEDIA_DECRYPTION_FAILED", "敏感资料无法读取");
  }
}

function phoneHmac(phone: string, mode: SubsidyConsultationMode): string {
  return createHmac("sha256", phoneHmacKeyForMode(mode)).update(phone).digest("hex");
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function maskName(name: string): string {
  return name.length <= 1 ? `${name}*` : `${name.slice(0, 1)}${"*".repeat(Math.min(2, name.length - 1))}`;
}

function maskPlate(plate: string): string {
  const compact = plate.replace(/[·\s-]/gu, "");
  return compact.length < 4 ? "***" : `${compact.slice(0, 2)}·***${compact.slice(-2)}`;
}

function isGovernmentHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "gov.cn" || url.hostname.endsWith(".gov.cn"));
  } catch {
    return false;
  }
}

function isPathWithin(path: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(path));
  return value === "" || (!isAbsolute(value) && !value.startsWith(`..${sep}`) && value !== "..");
}

function privateUploadDirectoryIsSafe(uploadDir: string): boolean {
  return !isPathWithin(uploadDir, join(process.cwd(), "public"))
    && !isPathWithin(uploadDir, join(process.cwd(), "dist", "client"));
}

/** Additive and repeatable PostgreSQL schema migration. */
export async function migrateSubsidyConsultationDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS subsidy_consultation_disclosures (
      version TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      consent_text TEXT NOT NULL,
      legal_purpose_text TEXT NOT NULL,
      retention_text TEXT NOT NULL,
      contact_eta_text TEXT NOT NULL,
      official_source_url TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS subsidy_consultation_disclosure_active_unique
      ON subsidy_consultation_disclosures(is_active)
      WHERE is_active = 1;

    CREATE TABLE IF NOT EXISTS subsidy_consultation_fee_plans (
      id TEXT PRIMARY KEY,
      version INTEGER,
      state TEXT NOT NULL CHECK (state IN ('draft', 'published')),
      is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      plate_fee_fen INTEGER NOT NULL DEFAULT 12000 CHECK (plate_fee_fen >= 0 AND plate_fee_fen <= 1000000),
      mailing_fee_fen INTEGER NOT NULL DEFAULT 2000 CHECK (mailing_fee_fen >= 0 AND mailing_fee_fen <= 1000000),
      production_fee_fen INTEGER NOT NULL DEFAULT 1000 CHECK (production_fee_fen >= 0 AND production_fee_fen <= 1000000),
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      published_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      CHECK ((state = 'draft' AND version IS NULL AND is_current = 0 AND published_at IS NULL)
        OR (state = 'published' AND version IS NOT NULL AND version > 0 AND published_at IS NOT NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS subsidy_consultation_fee_plan_version_unique
      ON subsidy_consultation_fee_plans(version)
      WHERE version IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS subsidy_consultation_fee_plan_draft_unique
      ON subsidy_consultation_fee_plans(state)
      WHERE state = 'draft';
    CREATE UNIQUE INDEX IF NOT EXISTS subsidy_consultation_fee_plan_current_unique
      ON subsidy_consultation_fee_plans(is_current)
      WHERE state = 'published' AND is_current = 1;

    CREATE TABLE IF NOT EXISTS subsidy_consultation_fee_tiers (
      plan_id TEXT NOT NULL REFERENCES subsidy_consultation_fee_plans(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      min_value_fen INTEGER NOT NULL CHECK (min_value_fen >= 0 AND min_value_fen < 50000000),
      max_value_fen INTEGER NOT NULL CHECK (max_value_fen > 0 AND max_value_fen <= 50000000),
      fee_fen INTEGER NOT NULL CHECK (fee_fen >= 0 AND fee_fen <= 10000000),
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, id),
      UNIQUE (plan_id, sort_order),
      CHECK (min_value_fen < max_value_fen)
    );

    CREATE INDEX IF NOT EXISTS subsidy_consultation_fee_tiers_plan_range_index
      ON subsidy_consultation_fee_tiers(plan_id, min_value_fen, max_value_fen);

    CREATE TABLE IF NOT EXISTS subsidy_consultation_quote_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
      declared_value_fen INTEGER NOT NULL CHECK (declared_value_fen > 0 AND declared_value_fen <= 50000000),
      declared_value_source TEXT NOT NULL CHECK (declared_value_source = 'owner_self_reported'),
      is_appraisal INTEGER NOT NULL DEFAULT 0 CHECK (is_appraisal = 0),
      fee_plan_id TEXT NOT NULL REFERENCES subsidy_consultation_fee_plans(id),
      fee_plan_version INTEGER NOT NULL CHECK (fee_plan_version > 0),
      tier_snapshot_json TEXT NOT NULL,
      consultation_fee_fen INTEGER NOT NULL CHECK (consultation_fee_fen >= 0),
      plate_fee_fen INTEGER NOT NULL CHECK (plate_fee_fen >= 0 AND plate_fee_fen <= 1000000),
      mailing_fee_fen INTEGER NOT NULL CHECK (mailing_fee_fen >= 0 AND mailing_fee_fen <= 1000000),
      production_fee_fen INTEGER NOT NULL CHECK (production_fee_fen >= 0 AND production_fee_fen <= 1000000),
      administrative_fee_fen INTEGER NOT NULL CHECK (administrative_fee_fen >= 0),
      total_transfer_cost_fen INTEGER NOT NULL CHECK (total_transfer_cost_fen >= 0),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      CHECK (administrative_fee_fen = plate_fee_fen + mailing_fee_fen + production_fee_fen),
      CHECK (total_transfer_cost_fen = consultation_fee_fen + administrative_fee_fen)
    );

    CREATE INDEX IF NOT EXISTS subsidy_consultation_quotes_user_expiry_index
      ON subsidy_consultation_quote_snapshots(user_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS subsidy_consultations (
      id TEXT PRIMARY KEY,
      consultation_code TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
      quote_id TEXT NOT NULL UNIQUE REFERENCES subsidy_consultation_quote_snapshots(id),
      status TEXT NOT NULL CHECK (status IN ('new', 'handled', 'withdrawn', 'expired')),
      declared_value_fen INTEGER NOT NULL CHECK (declared_value_fen > 0 AND declared_value_fen <= 50000000),
      declared_value_source TEXT NOT NULL CHECK (declared_value_source = 'owner_self_reported'),
      is_appraisal INTEGER NOT NULL DEFAULT 0 CHECK (is_appraisal = 0),
      consultation_fee_fen INTEGER NOT NULL CHECK (consultation_fee_fen >= 0),
      plate_fee_fen INTEGER NOT NULL CHECK (plate_fee_fen >= 0 AND plate_fee_fen <= 1000000),
      mailing_fee_fen INTEGER NOT NULL CHECK (mailing_fee_fen >= 0 AND mailing_fee_fen <= 1000000),
      production_fee_fen INTEGER NOT NULL CHECK (production_fee_fen >= 0 AND production_fee_fen <= 1000000),
      administrative_fee_fen INTEGER NOT NULL CHECK (administrative_fee_fen >= 0),
      total_transfer_cost_fen INTEGER NOT NULL CHECK (total_transfer_cost_fen >= 0),
      fee_plan_version INTEGER NOT NULL CHECK (fee_plan_version > 0),
      tier_snapshot_json TEXT NOT NULL,
      vehicle_plate_masked TEXT NOT NULL,
      vehicle_model_name TEXT NOT NULL,
      contact_ciphertext TEXT,
      phone_hmac TEXT,
      contact_name_masked TEXT NOT NULL,
      masked_phone TEXT NOT NULL,
      disclosure_version TEXT NOT NULL REFERENCES subsidy_consultation_disclosures(version),
      consent_snapshot_json TEXT NOT NULL,
      idempotency_key_digest TEXT NOT NULL,
      request_hash TEXT,
      handle_result TEXT CHECK (
        handle_result IS NULL OR handle_result IN (
          'consultation_completed', 'customer_declined', 'unable_to_contact',
          'invalid_submission', 'compliance_rejected'
        )
      ),
      internal_note TEXT,
      submitted_at TEXT NOT NULL,
      handled_at TEXT,
      withdrawn_at TEXT,
      expired_at TEXT,
      pii_delete_after TEXT,
      pii_purged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key_digest),
      CHECK (administrative_fee_fen = plate_fee_fen + mailing_fee_fen + production_fee_fen),
      CHECK (total_transfer_cost_fen = consultation_fee_fen + administrative_fee_fen)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS subsidy_consultations_one_new_per_vehicle_unique
      ON subsidy_consultations(user_id, vehicle_id)
      WHERE status = 'new' AND vehicle_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS subsidy_consultations_status_submitted_index
      ON subsidy_consultations(status, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS subsidy_consultations_phone_vehicle_index
      ON subsidy_consultations(phone_hmac, vehicle_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS subsidy_consultations_pii_retention_index
      ON subsidy_consultations(pii_delete_after)
      WHERE pii_purged_at IS NULL AND pii_delete_after IS NOT NULL;

    CREATE TABLE IF NOT EXISTS subsidy_consultation_materials (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      consultation_id TEXT REFERENCES subsidy_consultations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'id_card_front', 'id_card_back', 'driving_license_front', 'driving_license_back',
        'vehicle_front_left', 'vehicle_front_right', 'vehicle_rear_left',
        'vehicle_rear_right', 'dashboard_started'
      )),
      state TEXT NOT NULL CHECK (state IN ('staged', 'bound', 'deleted')),
      storage_key TEXT UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      content_hash TEXT,
      encryption_mode TEXT NOT NULL CHECK (encryption_mode IN ('demo', 'real')),
      staged_expires_at TEXT,
      delete_after TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((state = 'staged' AND consultation_id IS NULL AND staged_expires_at IS NOT NULL AND deleted_at IS NULL)
        OR (state = 'bound' AND consultation_id IS NOT NULL AND deleted_at IS NULL)
        OR (state = 'deleted' AND deleted_at IS NOT NULL AND storage_key IS NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS subsidy_consultation_material_kind_unique
      ON subsidy_consultation_materials(consultation_id, kind)
      WHERE consultation_id IS NOT NULL AND state = 'bound';
    CREATE INDEX IF NOT EXISTS subsidy_consultation_material_staged_expiry_index
      ON subsidy_consultation_materials(staged_expires_at)
      WHERE state = 'staged';
    CREATE INDEX IF NOT EXISTS subsidy_consultation_material_retention_index
      ON subsidy_consultation_materials(delete_after)
      WHERE state = 'bound' AND delete_after IS NOT NULL;

    CREATE TABLE IF NOT EXISTS subsidy_consultation_events (
      id TEXT PRIMARY KEY,
      consultation_id TEXT REFERENCES subsidy_consultations(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'admin', 'system')),
      actor_subject TEXT,
      material_kind TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      delete_after TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS subsidy_consultation_events_consultation_created_index
      ON subsidy_consultation_events(consultation_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS subsidy_consultation_events_retention_index
      ON subsidy_consultation_events(delete_after);

    ALTER TABLE subsidy_consultation_fee_plans
      ADD COLUMN IF NOT EXISTS plate_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS mailing_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS production_fee_fen INTEGER;
    UPDATE subsidy_consultation_fee_plans SET
      plate_fee_fen = COALESCE(plate_fee_fen, 12000),
      mailing_fee_fen = COALESCE(mailing_fee_fen, 2000),
      production_fee_fen = COALESCE(production_fee_fen, 1000)
    WHERE plate_fee_fen IS NULL OR mailing_fee_fen IS NULL OR production_fee_fen IS NULL;
    ALTER TABLE subsidy_consultation_fee_plans
      ALTER COLUMN plate_fee_fen SET DEFAULT 12000,
      ALTER COLUMN plate_fee_fen SET NOT NULL,
      ALTER COLUMN mailing_fee_fen SET DEFAULT 2000,
      ALTER COLUMN mailing_fee_fen SET NOT NULL,
      ALTER COLUMN production_fee_fen SET DEFAULT 1000,
      ALTER COLUMN production_fee_fen SET NOT NULL;

    ALTER TABLE subsidy_consultation_quote_snapshots
      ADD COLUMN IF NOT EXISTS plate_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS mailing_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS production_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS administrative_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS total_transfer_cost_fen INTEGER;
    UPDATE subsidy_consultation_quote_snapshots q SET
      plate_fee_fen = COALESCE(q.plate_fee_fen, p.plate_fee_fen, 12000),
      mailing_fee_fen = COALESCE(q.mailing_fee_fen, p.mailing_fee_fen, 2000),
      production_fee_fen = COALESCE(q.production_fee_fen, p.production_fee_fen, 1000)
    FROM subsidy_consultation_fee_plans p
    WHERE q.fee_plan_id = p.id
      AND (q.plate_fee_fen IS NULL OR q.mailing_fee_fen IS NULL OR q.production_fee_fen IS NULL);
    UPDATE subsidy_consultation_quote_snapshots SET
      plate_fee_fen = COALESCE(plate_fee_fen, 12000),
      mailing_fee_fen = COALESCE(mailing_fee_fen, 2000),
      production_fee_fen = COALESCE(production_fee_fen, 1000);
    UPDATE subsidy_consultation_quote_snapshots SET
      administrative_fee_fen = plate_fee_fen + mailing_fee_fen + production_fee_fen,
      total_transfer_cost_fen = consultation_fee_fen + plate_fee_fen + mailing_fee_fen + production_fee_fen
    WHERE administrative_fee_fen IS NULL OR total_transfer_cost_fen IS NULL;
    ALTER TABLE subsidy_consultation_quote_snapshots
      ALTER COLUMN plate_fee_fen SET NOT NULL,
      ALTER COLUMN mailing_fee_fen SET NOT NULL,
      ALTER COLUMN production_fee_fen SET NOT NULL,
      ALTER COLUMN administrative_fee_fen SET NOT NULL,
      ALTER COLUMN total_transfer_cost_fen SET NOT NULL;

    ALTER TABLE subsidy_consultations
      ADD COLUMN IF NOT EXISTS plate_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS mailing_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS production_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS administrative_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS total_transfer_cost_fen INTEGER;
    UPDATE subsidy_consultations c SET
      plate_fee_fen = COALESCE(c.plate_fee_fen, q.plate_fee_fen, 12000),
      mailing_fee_fen = COALESCE(c.mailing_fee_fen, q.mailing_fee_fen, 2000),
      production_fee_fen = COALESCE(c.production_fee_fen, q.production_fee_fen, 1000),
      administrative_fee_fen = COALESCE(c.administrative_fee_fen, q.administrative_fee_fen, 15000),
      total_transfer_cost_fen = COALESCE(c.total_transfer_cost_fen, q.total_transfer_cost_fen, c.consultation_fee_fen + 15000)
    FROM subsidy_consultation_quote_snapshots q
    WHERE c.quote_id = q.id
      AND (c.plate_fee_fen IS NULL OR c.mailing_fee_fen IS NULL OR c.production_fee_fen IS NULL
        OR c.administrative_fee_fen IS NULL OR c.total_transfer_cost_fen IS NULL);
    UPDATE subsidy_consultations SET
      plate_fee_fen = COALESCE(plate_fee_fen, 12000),
      mailing_fee_fen = COALESCE(mailing_fee_fen, 2000),
      production_fee_fen = COALESCE(production_fee_fen, 1000),
      administrative_fee_fen = COALESCE(administrative_fee_fen, 15000),
      total_transfer_cost_fen = COALESCE(total_transfer_cost_fen, consultation_fee_fen + 15000);
    ALTER TABLE subsidy_consultations
      ALTER COLUMN plate_fee_fen SET NOT NULL,
      ALTER COLUMN mailing_fee_fen SET NOT NULL,
      ALTER COLUMN production_fee_fen SET NOT NULL,
      ALTER COLUMN administrative_fee_fen SET NOT NULL,
      ALTER COLUMN total_transfer_cost_fen SET NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'subsidy_fee_plan_admin_fees_check'
          AND conrelid = 'subsidy_consultation_fee_plans'::regclass
      ) THEN
        ALTER TABLE subsidy_consultation_fee_plans ADD CONSTRAINT subsidy_fee_plan_admin_fees_check
          CHECK (plate_fee_fen BETWEEN 0 AND 1000000 AND mailing_fee_fen BETWEEN 0 AND 1000000
            AND production_fee_fen BETWEEN 0 AND 1000000);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'subsidy_quote_admin_fees_check'
          AND conrelid = 'subsidy_consultation_quote_snapshots'::regclass
      ) THEN
        ALTER TABLE subsidy_consultation_quote_snapshots ADD CONSTRAINT subsidy_quote_admin_fees_check
          CHECK (plate_fee_fen BETWEEN 0 AND 1000000 AND mailing_fee_fen BETWEEN 0 AND 1000000
            AND production_fee_fen BETWEEN 0 AND 1000000
            AND administrative_fee_fen = plate_fee_fen + mailing_fee_fen + production_fee_fen
            AND total_transfer_cost_fen = consultation_fee_fen + administrative_fee_fen);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'subsidy_consultation_admin_fees_check'
          AND conrelid = 'subsidy_consultations'::regclass
      ) THEN
        ALTER TABLE subsidy_consultations ADD CONSTRAINT subsidy_consultation_admin_fees_check
          CHECK (plate_fee_fen BETWEEN 0 AND 1000000 AND mailing_fee_fen BETWEEN 0 AND 1000000
            AND production_fee_fen BETWEEN 0 AND 1000000
            AND administrative_fee_fen = plate_fee_fen + mailing_fee_fen + production_fee_fen
            AND total_transfer_cost_fen = consultation_fee_fen + administrative_fee_fen);
      END IF;
    END $$;
  `);
}

/** Repeatable initial disclosure and fee-plan seed. */
export async function seedSubsidyConsultationData(
  database: AppDatabase,
  now = new Date().toISOString(),
): Promise<void> {
  await database.prepare(`
    INSERT INTO subsidy_consultation_disclosures (
      version, title, summary_text, consent_text, legal_purpose_text,
      retention_text, contact_eta_text, official_source_url, is_active,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'system-seed', ?)
    ON CONFLICT (version) DO NOTHING
  `).run(
    DEFAULT_DISCLOSURE.id,
    DEFAULT_DISCLOSURE.title,
    DEFAULT_DISCLOSURE.summaryText,
    DEFAULT_DISCLOSURE.consentText,
    DEFAULT_DISCLOSURE.legalPurposeText,
    DEFAULT_DISCLOSURE.retentionText,
    DEFAULT_DISCLOSURE.contactEtaText,
    DEFAULT_DISCLOSURE.officialSourceUrl,
    now,
  );
  const activeDisclosure = await database.prepare<Row>(`
    SELECT version FROM subsidy_consultation_disclosures WHERE is_active = 1 LIMIT 1
  `).get();
  if (!activeDisclosure) {
    await database.prepare(`
      UPDATE subsidy_consultation_disclosures SET is_active = 1 WHERE version = ?
    `).run(DEFAULT_DISCLOSURE.id);
  }

  const published = await database.prepare<Row>(`
    SELECT id FROM subsidy_consultation_fee_plans
    WHERE state = 'published' AND is_current = 1
  `).get();
  if (!published) {
    await database.prepare(`
      INSERT INTO subsidy_consultation_fee_plans (
        id, version, state, is_current, is_enabled,
        plate_fee_fen, mailing_fee_fen, production_fee_fen, created_by, updated_by,
        published_by, created_at, updated_at, published_at
      ) VALUES (?, 1, 'published', 1, 1, ?, ?, ?, 'system-seed', 'system-seed', 'system-seed', ?, ?, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(
      DEFAULT_PUBLISHED_PLAN_ID,
      DEFAULT_ADMINISTRATIVE_FEES.plateFeeFen,
      DEFAULT_ADMINISTRATIVE_FEES.mailingFeeFen,
      DEFAULT_ADMINISTRATIVE_FEES.productionFeeFen,
      now,
      now,
      now,
    );
    for (const tier of DEFAULT_TIERS) {
      await database.prepare(`
        INSERT INTO subsidy_consultation_fee_tiers (
          plan_id, id, label, min_value_fen, max_value_fen, fee_fen, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (plan_id, id) DO NOTHING
      `).run(
        DEFAULT_PUBLISHED_PLAN_ID,
        tier.id,
        tier.label,
        tier.minValueFen,
        tier.maxValueFen,
        tier.feeFen,
        tier.sortOrder,
        now,
      );
    }
  }

  const draft = await database.prepare<Row>(`
    SELECT id FROM subsidy_consultation_fee_plans WHERE state = 'draft'
  `).get();
  if (!draft) {
    const currentPlan = await database.prepare<Row>(`
      SELECT * FROM subsidy_consultation_fee_plans
      WHERE state = 'published' AND is_current = 1
    `).get();
    if (currentPlan) {
      await database.prepare(`
        INSERT INTO subsidy_consultation_fee_plans (
          id, version, state, is_current, is_enabled,
          plate_fee_fen, mailing_fee_fen, production_fee_fen, created_by, updated_by,
          published_by, created_at, updated_at, published_at
        ) VALUES (?, NULL, 'draft', 0, ?, ?, ?, ?, 'system-seed', 'system-seed', NULL, ?, ?, NULL)
        ON CONFLICT (id) DO NOTHING
      `).run(
        DRAFT_PLAN_ID,
        Number(currentPlan.is_enabled),
        Number(currentPlan.plate_fee_fen),
        Number(currentPlan.mailing_fee_fen),
        Number(currentPlan.production_fee_fen),
        now,
        now,
      );
      const tiers = await database.prepare<Row>(`
        SELECT * FROM subsidy_consultation_fee_tiers WHERE plan_id = ? ORDER BY sort_order, min_value_fen
      `).all(String(currentPlan.id));
      for (const tier of tiers) {
        await database.prepare(`
          INSERT INTO subsidy_consultation_fee_tiers (
            plan_id, id, label, min_value_fen, max_value_fen, fee_fen, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (plan_id, id) DO NOTHING
        `).run(
          DRAFT_PLAN_ID,
          String(tier.id),
          String(tier.label),
          Number(tier.min_value_fen),
          Number(tier.max_value_fen),
          Number(tier.fee_fen),
          Number(tier.sort_order),
          now,
        );
      }
    }
  }
}

/** Used by force-reset before core user/vehicle records are removed. */
export async function clearSubsidyConsultationData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM subsidy_consultation_events;
    DELETE FROM subsidy_consultation_materials;
    DELETE FROM subsidy_consultations;
    DELETE FROM subsidy_consultation_quote_snapshots;
    DELETE FROM subsidy_consultation_fee_tiers;
    DELETE FROM subsidy_consultation_fee_plans;
    DELETE FROM subsidy_consultation_disclosures;
  `);
}

function tierDto(row: Row) {
  const feeFen = Number(row.fee_fen);
  return {
    id: String(row.id),
    label: String(row.label),
    minValueFen: Number(row.min_value_fen),
    maxValueFen: Number(row.max_value_fen),
    feeFen,
    consultationFeeFen: feeFen,
    sortOrder: Number(row.sort_order),
  };
}

function administrativeFeesFromRow(row: Row): SubsidyConsultationAdministrativeFees {
  return {
    plateFeeFen: Number(row.plate_fee_fen ?? DEFAULT_ADMINISTRATIVE_FEES.plateFeeFen),
    mailingFeeFen: Number(row.mailing_fee_fen ?? DEFAULT_ADMINISTRATIVE_FEES.mailingFeeFen),
    productionFeeFen: Number(row.production_fee_fen ?? DEFAULT_ADMINISTRATIVE_FEES.productionFeeFen),
  };
}

function administrativeFeeSubtotal(fees: SubsidyConsultationAdministrativeFees): number {
  return fees.plateFeeFen + fees.mailingFeeFen + fees.productionFeeFen;
}

function normalizeAdministrativeFees(
  fees: SubsidyConsultationAdministrativeFees,
): SubsidyConsultationAdministrativeFees {
  for (const value of [fees.plateFeeFen, fees.mailingFeeFen, fees.productionFeeFen]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > SUBSIDY_CONSULTATION_ADMINISTRATIVE_ITEM_MAX_FEN) {
      domainError(400, "SUBSIDY_ADMINISTRATIVE_FEE_INVALID", "行政性收费参考金额无效");
    }
  }
  return { ...fees };
}

function frozenTransferCostDto(row: Row) {
  const administrativeFees = administrativeFeesFromRow(row);
  const administrativeFeeFen = Number(
    row.administrative_fee_fen ?? administrativeFeeSubtotal(administrativeFees),
  );
  const consultationFeeFen = Number(row.consultation_fee_fen);
  return {
    consultationFeeFen,
    administrativeFees,
    administrativeFeeFen,
    totalTransferCostFen: Number(
      row.total_transfer_cost_fen ?? consultationFeeFen + administrativeFeeFen,
    ),
  };
}

async function feePlanDto(database: AppDatabase, row: Row | undefined) {
  if (!row) return null;
  const tiers = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultation_fee_tiers
    WHERE plan_id = ? ORDER BY sort_order ASC, min_value_fen ASC, id ASC
  `).all(String(row.id));
  const active = Number(row.is_enabled) === 1;
  const administrativeFees = administrativeFeesFromRow(row);
  const administrativeFeeFen = administrativeFeeSubtotal(administrativeFees);
  return {
    id: String(row.id),
    version: row.version == null ? null : Number(row.version),
    state: String(row.state),
    active,
    isActive: active,
    isCurrent: Number(row.is_current) === 1,
    updatedAt: String(row.updated_at),
    publishedAt: row.published_at == null ? null : String(row.published_at),
    administrativeFees,
    administrativeFeeFen,
    tiers: tiers.map((tier) => {
      const dto = tierDto(tier);
      return {
        ...dto,
        totalTransferCostFen: dto.consultationFeeFen + administrativeFeeFen,
      };
    }),
  };
}

export async function getSubsidyConsultationFeePlans(database: AppDatabase) {
  const [draft, published] = await Promise.all([
    database.prepare<Row>(`
      SELECT * FROM subsidy_consultation_fee_plans WHERE state = 'draft' LIMIT 1
    `).get(),
    database.prepare<Row>(`
      SELECT * FROM subsidy_consultation_fee_plans
      WHERE state = 'published' AND is_current = 1 LIMIT 1
    `).get(),
  ]);
  const draftDto = await feePlanDto(database, draft);
  const publishedDto = await feePlanDto(database, published);
  return {
    draft: draftDto,
    published: publishedDto,
    active: publishedDto?.active ? publishedDto : null,
  };
}

function normalizeFeeTiers(tiers: SubsidyConsultationFeeTierInput[]): Required<SubsidyConsultationFeeTierInput>[] {
  const normalized = tiers.map((tier) => ({
    ...tier,
    id: tier.id?.trim() || `tier-${randomUUID()}`,
    label: tier.label.trim(),
  })).sort((left, right) => left.sortOrder - right.sortOrder || left.minValueFen - right.minValueFen);
  if (normalized.length < 1 || normalized.length > 20) {
    domainError(400, "SUBSIDY_FEE_TIERS_COUNT_INVALID", "价格档位应为 1 至 20 个");
  }
  const ids = new Set<string>();
  const sortOrders = new Set<number>();
  for (const [index, tier] of normalized.entries()) {
    if (!tier.id || tier.id.length > 120 || !tier.label || tier.label.length > 80) {
      domainError(400, "SUBSIDY_FEE_TIER_INVALID", "价格档位标识或名称无效");
    }
    if (ids.has(tier.id)) domainError(400, "SUBSIDY_FEE_TIER_ID_DUPLICATE", "价格档位标识不能重复");
    if (sortOrders.has(tier.sortOrder)) domainError(400, "SUBSIDY_FEE_TIER_ORDER_DUPLICATE", "价格档位排序不能重复");
    ids.add(tier.id);
    sortOrders.add(tier.sortOrder);
    if (!Number.isSafeInteger(tier.minValueFen) || !Number.isSafeInteger(tier.maxValueFen)
      || !Number.isSafeInteger(tier.feeFen) || tier.minValueFen < 0
      || tier.maxValueFen > SUBSIDY_CONSULTATION_MAX_DECLARED_VALUE_FEN
      || tier.minValueFen >= tier.maxValueFen || tier.feeFen < 0 || tier.feeFen > 10_000_000) {
      domainError(400, "SUBSIDY_FEE_TIER_RANGE_INVALID", "价格档位区间或服务价格无效");
    }
  }
  const byRange = [...normalized].sort((left, right) =>
    left.minValueFen - right.minValueFen || left.maxValueFen - right.maxValueFen || left.sortOrder - right.sortOrder,
  );
  for (let index = 1; index < byRange.length; index += 1) {
    if (byRange[index].minValueFen < byRange[index - 1].maxValueFen) {
      domainError(400, "SUBSIDY_FEE_TIER_OVERLAP", "估值档位不能重叠");
    }
  }
  return normalized;
}

async function insertSubsidyEvent(
  database: AppDatabase,
  consultationId: string | null,
  action: string,
  actorType: "owner" | "admin" | "system",
  actorSubject: string | null,
  options: { materialKind?: SubsidyConsultationMaterialKind; detail?: Record<string, unknown>; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await database.prepare(`
    INSERT INTO subsidy_consultation_events (
      id, consultation_id, action, actor_type, actor_subject, material_kind,
      detail_json, created_at, delete_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    consultationId,
    action,
    actorType,
    actorSubject,
    options.materialKind ?? null,
    JSON.stringify(options.detail ?? {}),
    now.toISOString(),
    addDays(now, EVENT_RETENTION_DAYS),
  );
}

export async function saveSubsidyConsultationFeePlanDraft(
  database: AppDatabase,
  input: SubsidyConsultationFeePlanDraftInput,
  options: { actor?: string; now?: Date } = {},
) {
  const tiers = normalizeFeeTiers(input.tiers);
  const actor = options.actor?.trim() || "operations-admin";
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  await database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext('subsidy-consultation-fee-plan'))").get();
    const draft = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_fee_plans WHERE state = 'draft' FOR UPDATE
    `).get();
    const draftId = draft ? String(draft.id) : DRAFT_PLAN_ID;
    const administrativeFees = normalizeAdministrativeFees(
      input.administrativeFees ?? (draft ? administrativeFeesFromRow(draft) : { ...DEFAULT_ADMINISTRATIVE_FEES }),
    );
    if (draft) {
      await transaction.prepare(`
        UPDATE subsidy_consultation_fee_plans
        SET is_enabled = ?, plate_fee_fen = ?, mailing_fee_fen = ?, production_fee_fen = ?,
          updated_by = ?, updated_at = ? WHERE id = ?
      `).run(
        input.active ? 1 : 0,
        administrativeFees.plateFeeFen,
        administrativeFees.mailingFeeFen,
        administrativeFees.productionFeeFen,
        actor,
        nowIso,
        draftId,
      );
    } else {
      await transaction.prepare(`
        INSERT INTO subsidy_consultation_fee_plans (
          id, version, state, is_current, is_enabled,
          plate_fee_fen, mailing_fee_fen, production_fee_fen, created_by, updated_by,
          published_by, created_at, updated_at, published_at
        ) VALUES (?, NULL, 'draft', 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
      `).run(
        draftId,
        input.active ? 1 : 0,
        administrativeFees.plateFeeFen,
        administrativeFees.mailingFeeFen,
        administrativeFees.productionFeeFen,
        actor,
        actor,
        nowIso,
        nowIso,
      );
    }
    await transaction.prepare("DELETE FROM subsidy_consultation_fee_tiers WHERE plan_id = ?").run(draftId);
    for (const tier of tiers) {
      await transaction.prepare(`
        INSERT INTO subsidy_consultation_fee_tiers (
          plan_id, id, label, min_value_fen, max_value_fen, fee_fen, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        draftId,
        tier.id,
        tier.label,
        tier.minValueFen,
        tier.maxValueFen,
        tier.feeFen,
        tier.sortOrder,
        nowIso,
      );
    }
    await insertSubsidyEvent(transaction, null, "fee_plan_draft_saved", "admin", actor, {
      detail: {
        active: input.active,
        tierCount: tiers.length,
        administrativeFeeFen: administrativeFeeSubtotal(administrativeFees),
      },
      now,
    });
  });
  return (await getSubsidyConsultationFeePlans(database)).draft;
}

export async function publishSubsidyConsultationFeePlan(
  database: AppDatabase,
  options: { actor?: string; now?: Date; request: FastifyRequest },
) {
  const actor = options.actor?.trim() || "operations-admin";
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const publishedId = await database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext('subsidy-consultation-fee-plan'))").get();
    const draft = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_fee_plans WHERE state = 'draft' FOR UPDATE
    `).get();
    if (!draft) domainError(409, "SUBSIDY_FEE_PLAN_DRAFT_MISSING", "请先保存价格草稿");
    const draftTiers = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_fee_tiers WHERE plan_id = ? ORDER BY sort_order, min_value_fen
    `).all(String(draft.id));
    const previousCurrent = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_fee_plans
      WHERE state = 'published' AND is_current = 1 FOR UPDATE
    `).get();
    const normalized = normalizeFeeTiers(draftTiers.map((tier) => ({
      id: String(tier.id),
      label: String(tier.label),
      minValueFen: Number(tier.min_value_fen),
      maxValueFen: Number(tier.max_value_fen),
      feeFen: Number(tier.fee_fen),
      sortOrder: Number(tier.sort_order),
    })));
    const versionRow = await transaction.prepare<Row>(`
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM subsidy_consultation_fee_plans WHERE state = 'published'
    `).get();
    const version = Number(versionRow?.next_version ?? 1);
    const planId = `subsidy-consultation-fee-plan-v${version}-${randomBytes(4).toString("hex")}`;
    const administrativeFees = normalizeAdministrativeFees(administrativeFeesFromRow(draft));
    const administrativeFeeFen = administrativeFeeSubtotal(administrativeFees);
    await transaction.prepare(`
      UPDATE subsidy_consultation_fee_plans SET is_current = 0, updated_at = ?, updated_by = ?
      WHERE state = 'published' AND is_current = 1
    `).run(nowIso, actor);
    await transaction.prepare(`
      INSERT INTO subsidy_consultation_fee_plans (
        id, version, state, is_current, is_enabled,
        plate_fee_fen, mailing_fee_fen, production_fee_fen, created_by, updated_by,
        published_by, created_at, updated_at, published_at
      ) VALUES (?, ?, 'published', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      version,
      Number(draft.is_enabled),
      administrativeFees.plateFeeFen,
      administrativeFees.mailingFeeFen,
      administrativeFees.productionFeeFen,
      actor,
      actor,
      actor,
      nowIso,
      nowIso,
      nowIso,
    );
    for (const tier of normalized) {
      await transaction.prepare(`
        INSERT INTO subsidy_consultation_fee_tiers (
          plan_id, id, label, min_value_fen, max_value_fen, fee_fen, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(planId, tier.id, tier.label, tier.minValueFen, tier.maxValueFen, tier.feeFen, tier.sortOrder, nowIso);
    }
    await insertSubsidyEvent(transaction, null, "fee_plan_published", "admin", actor, {
      detail: {
        version,
        active: Number(draft.is_enabled) === 1,
        tierCount: normalized.length,
        administrativeFeeFen,
      },
      now,
    });
    const active = Number(draft.is_enabled) === 1;
    const changes: SubsidyAuditChange[] = [
      {
        field: "version",
        label: "发布版本",
        before: previousCurrent?.version == null ? "尚未发布" : `v${Number(previousCurrent.version)}`,
        after: `v${version}`,
      },
      {
        field: "active",
        label: "方案状态",
        before: previousCurrent ? (Number(previousCurrent.is_enabled) === 1 ? "启用" : "停用") : "尚未发布",
        after: active ? "启用" : "停用",
      },
      { field: "tierCount", label: "价格档位", after: `${normalized.length} 档` },
      {
        field: "administrativeFees",
        label: "行政性收费参考",
        after: `牌照办理 ${subsidyMoney(administrativeFees.plateFeeFen)}，邮寄 ${subsidyMoney(administrativeFees.mailingFeeFen)}，制作工本 ${subsidyMoney(administrativeFees.productionFeeFen)}，小计 ${subsidyMoney(administrativeFeeFen)}`,
      },
      ...normalized.map((tier) => ({
        field: `tier.${tier.id}`,
        label: `档位：${tier.label}`,
        after: `车主自报价值 ${subsidyMoney(tier.minValueFen)}–${subsidyMoney(tier.maxValueFen)}，咨询费 ${subsidyMoney(tier.feeFen)}，过户费用合计（参考）${subsidyMoney(tier.feeFen + administrativeFeeFen)}`,
      })),
    ];
    await auditBackofficeEvent(transaction, {
      request: options.request,
      action: "subsidy.fee_plan.publish",
      outcome: "success",
      resource: { type: "subsidy_fee_plan", id: planId },
      before: previousCurrent ? {
        version: Number(previousCurrent.version),
        active: Number(previousCurrent.is_enabled) === 1,
      } : null,
      after: { version, active, tierCount: normalized.length, administrativeFeeFen },
      metadata: {
        presentation: subsidyPresentation({
          actionLabel: "发布补贴咨询价格方案",
          summary: `发布补贴咨询价格方案 v${version}，共 ${normalized.length} 个档位`,
          resourceLabel: `补贴咨询价格方案 v${version}`,
          changes,
        }),
      },
      occurredAt: nowIso,
    });
    return planId;
  });
  const row = await database.prepare<Row>("SELECT * FROM subsidy_consultation_fee_plans WHERE id = ?").get(publishedId);
  return feePlanDto(database, row);
}

function disclosureDto(row: Row, mode: SubsidyConsultationMode) {
  return {
    version: String(row.version),
    title: String(row.title),
    summaryText: String(row.summary_text),
    consentText: String(row.consent_text),
    legalPurposeText: String(row.legal_purpose_text),
    retentionText: String(row.retention_text),
    contactEtaText: String(row.contact_eta_text),
    officialSourceUrl: String(row.official_source_url),
    modeNotice: mode === "real"
      ? "资料将按已披露目的加密处理，仅限授权员工按需查看。"
      : "当前为演示模式，仅可提交合成演示资料，请勿上传真实个人证件或车辆资料。",
  };
}

async function activeDisclosure(database: AppDatabase): Promise<Row> {
  const row = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultation_disclosures WHERE is_active = 1 LIMIT 1
  `).get();
  if (!row) domainError(503, "SUBSIDY_DISCLOSURE_UNAVAILABLE", "补贴咨询授权说明暂不可用");
  return row;
}

export async function updateSubsidyConsultationDisclosure(
  database: AppDatabase,
  input: z.infer<typeof disclosureBodySchema>,
  options: { actor?: string; now?: Date; request: FastifyRequest },
) {
  if (!isGovernmentHttpsUrl(input.officialSourceUrl)) {
    domainError(400, "SUBSIDY_OFFICIAL_SOURCE_INVALID", "政策来源必须是 HTTPS 政府网站链接", {
      officialSourceUrl: "请填写有效的 gov.cn 政府网站链接",
    });
  }
  const actor = options.actor?.trim() || "operations-admin";
  const now = options.now ?? new Date();
  const version = `subsidy-${sha256(stableJson(input)).slice(0, 16)}`;
  await database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext('subsidy-consultation-disclosure'))").get();
    const previous = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_disclosures WHERE is_active = 1 FOR UPDATE
    `).get();
    await transaction.prepare(`
      UPDATE subsidy_consultation_disclosures SET is_active = 0 WHERE is_active = 1 AND version <> ?
    `).run(version);
    await transaction.prepare(`
      INSERT INTO subsidy_consultation_disclosures (
        version, title, summary_text, consent_text, legal_purpose_text,
        retention_text, contact_eta_text, official_source_url, is_active,
        created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (version) DO UPDATE SET is_active = 1
    `).run(
      version,
      input.title,
      input.summaryText,
      input.consentText,
      input.legalPurposeText,
      input.retentionText,
      input.contactEtaText,
      input.officialSourceUrl,
      actor,
      now.toISOString(),
    );
    await insertSubsidyEvent(transaction, null, "disclosure_published", "admin", actor, {
      detail: { version },
      now,
    });
    const fields: Array<{ field: string; label: string; before: unknown; after: unknown }> = [
      { field: "title", label: "授权说明标题已修改", before: previous?.title, after: input.title },
      { field: "summaryText", label: "服务边界摘要已修改", before: previous?.summary_text, after: input.summaryText },
      { field: "consentText", label: "用户授权文案已修改", before: previous?.consent_text, after: input.consentText },
      { field: "legalPurposeText", label: "合法用途说明已修改", before: previous?.legal_purpose_text, after: input.legalPurposeText },
      { field: "retentionText", label: "资料保存期限已修改", before: previous?.retention_text, after: input.retentionText },
      { field: "contactEtaText", label: "预计联系时效已修改", before: previous?.contact_eta_text, after: input.contactEtaText },
      { field: "officialSourceUrl", label: "官方政策来源已修改", before: previous?.official_source_url, after: input.officialSourceUrl },
    ];
    const changes: SubsidyAuditChange[] = fields
      .filter((field) => stableJson(field.before) !== stableJson(field.after))
      .map((field) => ({ field: field.field, label: field.label }));
    if (previous?.version !== version) {
      changes.push({ field: "version", label: "授权版本", before: previous?.version ?? "尚未发布", after: version });
    }
    if (changes.length > 0) {
      await auditBackofficeEvent(transaction, {
        request: options.request,
        action: "subsidy.disclosure.publish",
        outcome: "success",
        resource: { type: "subsidy_disclosure", id: version },
        before: previous ? { version: String(previous.version) } : null,
        after: { version },
        metadata: {
          presentation: subsidyPresentation({
            actionLabel: "发布补贴咨询授权说明",
            summary: `发布补贴咨询授权说明 ${version}`,
            resourceLabel: `补贴咨询授权说明 ${version}`,
            changes,
          }),
        },
        occurredAt: now.toISOString(),
      });
    }
  });
  return disclosureDto(await activeDisclosure(database), currentMode());
}

export function subsidyConsultationPublicBaseUrlIsHttps(
  value = process.env.SUBSIDY_CONSULTATION_PUBLIC_BASE_URL,
): boolean {
  try {
    return new URL(value ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

export function subsidyConsultationRealConfigurationReady(): boolean {
  return process.env.SUBSIDY_CONSULTATION_REAL_MODE === "true"
    && process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK !== "true"
    && subsidyConsultationPublicBaseUrlIsHttps()
    && parseConfiguredDataKey() !== null
    && (process.env.SUBSIDY_CONSULTATION_PHONE_HMAC_KEY?.trim().length ?? 0) >= 32
    && configuredAllowedOrigins().length > 0
    && configuredAdminIdentity() !== null;
}

export async function getSubsidyConsultationConfig(database: AppDatabase) {
  const mode = currentMode();
  const [disclosure, plans] = await Promise.all([
    activeDisclosure(database),
    getSubsidyConsultationFeePlans(database),
  ]);
  const administrativeFees = plans.published?.administrativeFees ?? { ...DEFAULT_ADMINISTRATIVE_FEES };
  const administrativeFeeFen = administrativeFeeSubtotal(administrativeFees);
  return {
    mode,
    acceptsRealData: mode === "real",
    demoContact: mode === "demo" ? DEMO_CONTACT : null,
    maxDeclaredValueFen: SUBSIDY_CONSULTATION_MAX_DECLARED_VALUE_FEN,
    quoteValiditySeconds: SUBSIDY_CONSULTATION_QUOTE_VALIDITY_SECONDS,
    disclosure: disclosureDto(disclosure, mode),
    feePlan: plans.published,
    administrativeFees,
    administrativeFeeFen,
    materialUploadMode: mode === "real" ? "multipart" as const : "server_generated_demo" as const,
    materialUploadEndpoint: mode === "real" ? "/api/subsidy-consultation/materials" : null,
    demoMaterialEndpoint: mode === "demo" ? "/api/subsidy-consultation/demo-materials" : null,
    materialKinds: SUBSIDY_CONSULTATION_MATERIAL_KINDS.map((kind) => ({
      kind,
      label: MATERIAL_LABELS[kind].label,
      group: MATERIAL_LABELS[kind].group,
    })),
    serviceBoundary: {
      declaredValueLabel: "车主自报车辆估值",
      feeLabel: "咨询服务费",
      administrativeFeesLabel: "行政性收费参考",
      totalTransferCostLabel: "过户费用合计（参考）",
      administrativeFeesNotice: "实际金额以办理机构及所选服务为准，本模块不收取该费用。",
      officialSubsidyAmountProvided: false,
      isAppraisal: false,
      notice: "本服务不代开发票、不代为申报，也不承诺补贴结果。车辆照片仅作咨询参考。",
    },
  };
}

function quoteDto(row: Row) {
  const tier = jsonObject(row.tier_snapshot_json);
  const transferCost = frozenTransferCostDto(row);
  return {
    id: String(row.id),
    quoteId: String(row.id),
    vehicleId: String(row.vehicle_id),
    declaredValueFen: Number(row.declared_value_fen),
    declaredValueSource: "owner_self_reported" as const,
    isAppraisal: false,
    matchedTier: {
      id: String(tier.id ?? ""),
      label: String(tier.label ?? ""),
      minValueFen: Number(tier.minValueFen ?? 0),
      maxValueFen: Number(tier.maxValueFen ?? 0),
      feeFen: Number(tier.feeFen ?? row.consultation_fee_fen),
      consultationFeeFen: Number(tier.consultationFeeFen ?? tier.feeFen ?? row.consultation_fee_fen),
      totalTransferCostFen: transferCost.totalTransferCostFen,
      sortOrder: Number(tier.sortOrder ?? 0),
    },
    ...transferCost,
    planVersion: Number(row.fee_plan_version),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
  };
}

export async function createSubsidyConsultationQuote(
  database: AppDatabase,
  currentUserId: string,
  input: { vehicleId: string; declaredValueFen: number },
  options: { now?: Date } = {},
) {
  if (!Number.isSafeInteger(input.declaredValueFen)
    || input.declaredValueFen <= 0
    || input.declaredValueFen > SUBSIDY_CONSULTATION_MAX_DECLARED_VALUE_FEN) {
    domainError(400, "SUBSIDY_DECLARED_VALUE_INVALID", "车主自报车辆估值必须大于 0 且不超过 50 万元", {
      declaredValueFen: "请输入 0 至 50 万元范围内的估值",
    });
  }
  const vehicle = await database.prepare<Row>(`
    SELECT id FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(input.vehicleId, currentUserId);
  if (!vehicle) domainError(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
  const plan = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultation_fee_plans
    WHERE state = 'published' AND is_current = 1 LIMIT 1
  `).get();
  if (!plan || plan.version == null) domainError(503, "SUBSIDY_FEE_PLAN_UNAVAILABLE", "补贴咨询价格暂不可用");
  if (Number(plan.is_enabled) !== 1) domainError(409, "SUBSIDY_FEE_PLAN_INACTIVE", "补贴咨询当前暂停接收新报价");
  const tier = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultation_fee_tiers
    WHERE plan_id = ? AND ? > min_value_fen AND ? <= max_value_fen
    ORDER BY sort_order ASC LIMIT 1
  `).get(String(plan.id), input.declaredValueFen, input.declaredValueFen);
  if (!tier) domainError(409, "SUBSIDY_FEE_TIER_NOT_FOUND", "当前估值没有可用价格档位，请联系工作人员");
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + SUBSIDY_CONSULTATION_QUOTE_VALIDITY_SECONDS * 1_000).toISOString();
  const id = randomUUID();
  const tierSnapshot = tierDto(tier);
  const administrativeFees = administrativeFeesFromRow(plan);
  const administrativeFeeFen = administrativeFeeSubtotal(administrativeFees);
  const consultationFeeFen = Number(tier.fee_fen);
  const totalTransferCostFen = consultationFeeFen + administrativeFeeFen;
  await database.prepare(`
    INSERT INTO subsidy_consultation_quote_snapshots (
      id, user_id, vehicle_id, declared_value_fen, declared_value_source,
      is_appraisal, fee_plan_id, fee_plan_version, tier_snapshot_json,
      consultation_fee_fen, plate_fee_fen, mailing_fee_fen, production_fee_fen,
      administrative_fee_fen, total_transfer_cost_fen, expires_at, used_at, created_at
    ) VALUES (?, ?, ?, ?, 'owner_self_reported', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    currentUserId,
    input.vehicleId,
    input.declaredValueFen,
    String(plan.id),
    Number(plan.version),
    JSON.stringify(tierSnapshot),
    consultationFeeFen,
    administrativeFees.plateFeeFen,
    administrativeFees.mailingFeeFen,
    administrativeFees.productionFeeFen,
    administrativeFeeFen,
    totalTransferCostFen,
    expiresAt,
    now.toISOString(),
  );
  const row = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultation_quote_snapshots WHERE id = ?
  `).get(id);
  if (!row) throw new Error("Created subsidy consultation quote could not be read back");
  return quoteDto(row);
}

type ProcessedMaterial = {
  kind: SubsidyConsultationMaterialKind;
  data: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  contentHash: string;
};

async function syntheticDemoMaterial(kind: SubsidyConsultationMaterialKind): Promise<ProcessedMaterial> {
  const marker = demoPixelTextRects("SYNTHETIC DEMO", 102, 310);
  const svg = Buffer.from(`
    <svg width="1200" height="800" viewBox="0 0 1200 800" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="800" fill="#edf5ff"/>
      <rect x="48" y="48" width="1104" height="704" rx="36" fill="#ffffff" stroke="#2f6fed" stroke-width="6"/>
      <g fill="#2f6fed">${marker}</g>
      <rect x="180" y="520" width="840" height="18" rx="9" fill="#d04f35"/>
      <rect x="280" y="570" width="640" height="12" rx="6" fill="#66758c"/>
      <circle cx="600" cy="675" r="24" fill="#2f6fed" opacity="0.35"/>
    </svg>
  `, "utf8");
  const output = await sharp(svg).png().toBuffer({ resolveWithObject: true });
  return {
    kind,
    data: output.data,
    mimeType: "image/png",
    width: output.info.width,
    height: output.info.height,
    contentHash: sha256(output.data),
  };
}

async function parseMaterialMultipart(
  request: FastifyRequest,
  problem: SubsidyConsultationProblemFactory,
): Promise<ProcessedMaterial> {
  if (!request.isMultipart()) throw problem(415, "MULTIPART_REQUIRED", "请使用 multipart/form-data 上传资料");
  let source: Buffer | null = null;
  let kindValue: string | null = null;
  let fileCount = 0;
  try {
    for await (const part of request.parts({
      limits: { fields: 2, files: 1, fileSize: 5 * 1024 * 1024, parts: 3 },
    })) {
      if (part.type === "file") {
        fileCount += 1;
        if (part.fieldname !== "file") throw problem(400, "SUBSIDY_MEDIA_FIELD_INVALID", "图片字段必须为 file");
        if (!/^image\/(jpeg|png|webp)$/iu.test(part.mimetype)) {
          throw problem(415, "SUBSIDY_MEDIA_TYPE_INVALID", "资料图片仅支持 JPG、PNG 或 WebP");
        }
        source = await part.toBuffer();
        if (source.length > 5 * 1024 * 1024 || Boolean((part.file as typeof part.file & { truncated?: boolean }).truncated)) {
          throw problem(413, "SUBSIDY_MEDIA_TOO_LARGE", "单张资料图片不能超过 5MB");
        }
      } else if (part.fieldname === "kind") {
        if (kindValue !== null) throw problem(400, "SUBSIDY_MEDIA_KIND_DUPLICATE", "资料类型不能重复提交");
        kindValue = String(part.value);
      } else {
        throw problem(400, "UNEXPECTED_FIELD", `不支持字段 ${part.fieldname}`);
      }
    }
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw problem(413, "SUBSIDY_MEDIA_TOO_LARGE", "单张资料图片不能超过 5MB");
    if (code === "FST_FILES_LIMIT") throw problem(400, "SUBSIDY_MEDIA_COUNT_INVALID", "每次只能上传一张资料图片");
    throw error;
  }
  if (fileCount !== 1 || !source) throw problem(400, "SUBSIDY_MEDIA_REQUIRED", "请选择一张资料图片");
  const kindParsed = materialKindSchema.safeParse(kindValue);
  if (!kindParsed.success) throw problem(400, "SUBSIDY_MEDIA_KIND_INVALID", "资料类型无效");
  try {
    const metadata = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
      throw problem(415, "SUBSIDY_MEDIA_TYPE_INVALID", "资料图片实际格式仅支持 JPG、PNG 或 WebP");
    }
    const output = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      kind: kindParsed.data,
      data: output.data,
      mimeType: "image/jpeg",
      width: output.info.width,
      height: output.info.height,
      contentHash: sha256(output.data),
    };
  } catch (error) {
    if (error instanceof SubsidyConsultationDomainError || (error as { statusCode?: unknown }).statusCode) throw error;
    throw problem(400, "SUBSIDY_MEDIA_INVALID", "资料图片已损坏或无法识别");
  }
}

function materialDto(row: Row) {
  const kind = String(row.kind) as SubsidyConsultationMaterialKind;
  return {
    id: String(row.id),
    kind,
    label: MATERIAL_LABELS[kind]?.label ?? kind,
    group: MATERIAL_LABELS[kind]?.group ?? "资料",
    status: String(row.state),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    expiresAt: row.state === "staged" ? String(row.staged_expires_at) : null,
    createdAt: String(row.created_at),
  };
}

export async function stageSubsidyConsultationMaterial(
  database: AppDatabase,
  currentUserId: string,
  input: ProcessedMaterial,
  uploadDir: string,
  options: { now?: Date; mode?: SubsidyConsultationMode } = {},
) {
  const now = options.now ?? new Date();
  const mode = options.mode ?? currentMode();
  const id = randomUUID();
  const storageKey = `${randomUUID()}.bin`;
  const encrypted = encryptFile(input.data, mode);
  await writeFile(join(uploadDir, storageKey), encrypted, { flag: "wx", mode: 0o600 });
  try {
    await database.prepare(`
      INSERT INTO subsidy_consultation_materials (
        id, user_id, consultation_id, kind, state, storage_key, mime_type,
        size_bytes, width, height, content_hash, encryption_mode,
        staged_expires_at, delete_after, deleted_at, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      id,
      currentUserId,
      input.kind,
      storageKey,
      input.mimeType,
      input.data.length,
      input.width,
      input.height,
      input.contentHash,
      mode,
      addDays(now, STAGED_MATERIAL_DAYS),
      now.toISOString(),
      now.toISOString(),
    );
  } catch (error) {
    await unlink(join(uploadDir, storageKey)).catch(() => undefined);
    throw error;
  }
  const row = await database.prepare<Row>("SELECT * FROM subsidy_consultation_materials WHERE id = ?").get(id);
  if (!row) throw new Error("Created subsidy consultation material could not be read back");
  return materialDto(row);
}

export async function deleteStagedSubsidyConsultationMaterial(
  database: AppDatabase,
  currentUserId: string,
  materialId: string,
  uploadDir: string,
  options: { now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await database.transaction(async (transaction) => {
    const row = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_materials WHERE id = ? AND user_id = ? FOR UPDATE
    `).get(materialId, currentUserId);
    if (!row || String(row.state) === "deleted") return;
    if (String(row.state) !== "staged" || row.consultation_id != null) {
      domainError(409, "SUBSIDY_MEDIA_ALREADY_BOUND", "已提交的咨询资料不能单独删除，请撤回咨询");
    }
    if (row.storage_key != null) {
      await unlink(join(uploadDir, String(row.storage_key))).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await transaction.prepare(`
      UPDATE subsidy_consultation_materials SET
        state = 'deleted', storage_key = NULL, user_id = NULL, content_hash = NULL,
        staged_expires_at = NULL, delete_after = NULL, deleted_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now.toISOString(), now.toISOString(), materialId);
  });
}

export type CreateSubsidyConsultationInput = {
  quoteId: string;
  materialIds: string[];
  contactName: string;
  contactPhone: string;
  disclosureVersion: string;
  consentAccepted: true;
  legalPurposeAccepted: true;
};

function consultationCode(now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `YXM-ZX-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function consultationPublicDto(row: Row, duplicate = false) {
  const tier = jsonObject(row.tier_snapshot_json);
  const consent = jsonObject(row.consent_snapshot_json);
  const status = String(row.status);
  const transferCost = frozenTransferCostDto(row);
  return {
    id: String(row.id),
    consultationId: String(row.id),
    consultationCode: String(row.consultation_code),
    status,
    declaredValueFen: Number(row.declared_value_fen),
    declaredValueSource: "owner_self_reported" as const,
    declaredValueLabel: "车主自报车辆估值",
    isAppraisal: false,
    ...transferCost,
    feeLabel: "咨询服务费",
    administrativeFeesLabel: "行政性收费参考",
    totalTransferCostLabel: "过户费用合计（参考）",
    administrativeFeesNotice: "实际金额以办理机构及所选服务为准，本模块不收取该费用。",
    matchedTier: {
      id: String(tier.id ?? ""),
      label: String(tier.label ?? ""),
      minValueFen: Number(tier.minValueFen ?? 0),
      maxValueFen: Number(tier.maxValueFen ?? 0),
      feeFen: Number(tier.feeFen ?? row.consultation_fee_fen),
      consultationFeeFen: Number(tier.consultationFeeFen ?? tier.feeFen ?? row.consultation_fee_fen),
      totalTransferCostFen: transferCost.totalTransferCostFen,
      sortOrder: Number(tier.sortOrder ?? 0),
    },
    planVersion: Number(row.fee_plan_version),
    contactNameMasked: String(row.contact_name_masked),
    maskedPhone: String(row.masked_phone),
    vehicle: {
      plateNumber: String(row.vehicle_plate_masked),
      modelName: String(row.vehicle_model_name),
    },
    disclosureVersion: String(row.disclosure_version),
    contactEtaText: String(consent.contactEtaText ?? "工作人员预计在 1 个工作日内联系"),
    submittedAt: String(row.submitted_at),
    handledAt: row.handled_at == null ? null : String(row.handled_at),
    withdrawnAt: row.withdrawn_at == null ? null : String(row.withdrawn_at),
    expiredAt: row.expired_at == null ? null : String(row.expired_at),
    canWithdraw: status === "new",
    duplicate,
    serviceBoundaryNotice: "本服务不代开发票、不代为申报，也不承诺补贴结果。",
  };
}

async function consultationReceipt(database: AppDatabase, row: Row, duplicate = false) {
  const materials = await database.prepare<Row>(`
    SELECT kind FROM subsidy_consultation_materials
    WHERE consultation_id = ? AND state = 'bound'
    ORDER BY kind
  `).all(String(row.id));
  const availableKinds = new Set(materials.map((material) => String(material.kind)));
  return {
    ...consultationPublicDto(row, duplicate),
    materialKinds: SUBSIDY_CONSULTATION_MATERIAL_KINDS.filter((kind) => availableKinds.has(kind)),
  };
}

export async function createSubsidyConsultation(
  database: AppDatabase,
  currentUserId: string,
  input: CreateSubsidyConsultationInput,
  options: { idempotencyKey: string; now?: Date; mode?: SubsidyConsultationMode },
) {
  const idempotencyKey = options.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 160) {
    domainError(400, "IDEMPOTENCY_KEY_REQUIRED", "请提供 8 至 160 字符的 Idempotency-Key");
  }
  if (new Set(input.materialIds).size !== SUBSIDY_CONSULTATION_MATERIAL_KINDS.length) {
    domainError(400, "SUBSIDY_MEDIA_IDS_INVALID", "九项资料必须分别选择且不能重复");
  }
  const mode = options.mode ?? currentMode();
  if (mode === "demo"
    && (input.contactName.trim() !== DEMO_CONTACT.name || input.contactPhone.trim() !== DEMO_CONTACT.phone)) {
    domainError(403, "REAL_DATA_NOT_ACCEPTED", "演示模式仅接受固定合成联系人，请勿提交真实个人信息");
  }
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const normalized = {
    quoteId: input.quoteId,
    materialIds: [...input.materialIds].sort(),
    contactName: input.contactName.trim(),
    contactPhone: input.contactPhone.trim(),
    disclosureVersion: input.disclosureVersion,
    consentAccepted: true,
    legalPurposeAccepted: true,
  };
  const requestHash = sha256(stableJson(normalized));
  const idempotencyDigest = sha256(idempotencyKey);

  return database.transaction(async (transaction) => {
    const quoteForLock = await transaction.prepare<Row>(`
      SELECT vehicle_id FROM subsidy_consultation_quote_snapshots
      WHERE id = ? AND user_id = ?
    `).get(input.quoteId, currentUserId);
    if (!quoteForLock) domainError(404, "SUBSIDY_QUOTE_NOT_FOUND", "未找到该补贴咨询报价");
    const lockNames = [
      `subsidy-consultation-idempotency:${currentUserId}:${idempotencyDigest}`,
      `subsidy-consultation-vehicle:${currentUserId}:${String(quoteForLock.vehicle_id)}`,
    ].sort();
    for (const lockName of lockNames) {
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(lockName);
    }

    const existing = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultations WHERE user_id = ? AND idempotency_key_digest = ?
    `).get(currentUserId, idempotencyDigest);
    if (existing) {
      if (String(existing.request_hash ?? "") !== requestHash) {
        domainError(409, "IDEMPOTENCY_KEY_CONFLICT", "该 Idempotency-Key 已用于不同的咨询提交");
      }
      await insertSubsidyEvent(
        transaction,
        String(existing.id),
        "duplicate_receipt_issued",
        "owner",
        ownerAuditSubject(currentUserId),
        {
        detail: { reason: "idempotency" },
        now,
        },
      );
      return { receipt: await consultationReceipt(transaction, existing, true), duplicate: true };
    }

    const quote = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_quote_snapshots
      WHERE id = ? AND user_id = ? FOR UPDATE
    `).get(input.quoteId, currentUserId);
    if (!quote) domainError(404, "SUBSIDY_QUOTE_NOT_FOUND", "未找到该补贴咨询报价");
    if (String(quote.expires_at) <= nowIso) domainError(409, "SUBSIDY_QUOTE_EXPIRED", "报价已过期，请重新获取");
    if (quote.used_at != null) domainError(409, "SUBSIDY_QUOTE_ALREADY_USED", "该报价已提交过咨询");
    const vehicle = await transaction.prepare<Row>(`
      SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE
    `).get(String(quote.vehicle_id), currentUserId);
    if (!vehicle) domainError(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
    const openConsultation = await transaction.prepare<Row>(`
      SELECT id FROM subsidy_consultations
      WHERE user_id = ? AND vehicle_id = ? AND status = 'new' LIMIT 1
    `).get(currentUserId, String(vehicle.id));
    if (openConsultation) {
      domainError(409, "SUBSIDY_CONSULTATION_ALREADY_OPEN", "该车辆已有一条待处理咨询，请勿重复提交");
    }
    const disclosure = await activeDisclosure(transaction);
    if (String(disclosure.version) !== input.disclosureVersion) {
      domainError(409, "SUBSIDY_DISCLOSURE_VERSION_MISMATCH", "授权说明已更新，请重新阅读并确认");
    }

    const materials = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultation_materials
      WHERE id = ANY(?) AND user_id = ? FOR UPDATE
    `).all(input.materialIds, currentUserId);
    if (materials.length !== SUBSIDY_CONSULTATION_MATERIAL_KINDS.length) {
      domainError(400, "SUBSIDY_MEDIA_NOT_AVAILABLE", "部分资料不存在、已过期或不属于当前用户");
    }
    const kinds = new Set<SubsidyConsultationMaterialKind>();
    for (const material of materials) {
      const kind = String(material.kind) as SubsidyConsultationMaterialKind;
      if (String(material.state) !== "staged" || material.consultation_id != null
        || material.deleted_at != null || String(material.staged_expires_at) <= nowIso) {
        domainError(400, "SUBSIDY_MEDIA_NOT_AVAILABLE", "部分资料已过期、已删除或已绑定");
      }
      if (String(material.encryption_mode) !== mode) {
        domainError(409, "SUBSIDY_MEDIA_MODE_CHANGED", "资料处理模式已变化，请重新上传");
      }
      if (kinds.has(kind)) domainError(400, "SUBSIDY_MEDIA_KIND_DUPLICATE", "每种资料只能提交一张");
      kinds.add(kind);
    }
    const missingKinds = SUBSIDY_CONSULTATION_MATERIAL_KINDS.filter((kind) => !kinds.has(kind));
    if (missingKinds.length > 0) {
      domainError(400, "SUBSIDY_MEDIA_REQUIRED", "请补齐九项咨询资料", {
        materialIds: `缺少：${missingKinds.map((kind) => MATERIAL_LABELS[kind].label).join("、")}`,
      });
    }

    const id = randomUUID();
    const modelName = String(vehicle.model_name ?? vehicle.vehicle_type ?? "车辆");
    const consentSnapshot = {
      version: String(disclosure.version),
      acceptedAt: nowIso,
      consentAccepted: true,
      legalPurposeAccepted: true,
      title: String(disclosure.title),
      summaryText: String(disclosure.summary_text),
      consentText: String(disclosure.consent_text),
      legalPurposeText: String(disclosure.legal_purpose_text),
      retentionText: String(disclosure.retention_text),
      contactEtaText: String(disclosure.contact_eta_text),
      officialSourceUrl: String(disclosure.official_source_url),
      serviceBoundary: {
        invoiceIssuance: false,
        applicationSubmission: false,
        subsidyGuarantee: false,
        appraisal: false,
      },
    };
    await transaction.prepare(`
      INSERT INTO subsidy_consultations (
        id, consultation_code, user_id, vehicle_id, quote_id, status,
        declared_value_fen, declared_value_source, is_appraisal,
        consultation_fee_fen, plate_fee_fen, mailing_fee_fen, production_fee_fen,
        administrative_fee_fen, total_transfer_cost_fen, fee_plan_version, tier_snapshot_json,
        vehicle_plate_masked, vehicle_model_name, contact_ciphertext, phone_hmac,
        contact_name_masked, masked_phone, disclosure_version, consent_snapshot_json,
        idempotency_key_digest, request_hash, submitted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'new', ?, 'owner_self_reported', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      consultationCode(now),
      currentUserId,
      String(vehicle.id),
      String(quote.id),
      Number(quote.declared_value_fen),
      Number(quote.consultation_fee_fen),
      Number(quote.plate_fee_fen),
      Number(quote.mailing_fee_fen),
      Number(quote.production_fee_fen),
      Number(quote.administrative_fee_fen),
      Number(quote.total_transfer_cost_fen),
      Number(quote.fee_plan_version),
      String(quote.tier_snapshot_json),
      maskPlate(String(vehicle.plate_number)),
      modelName,
      encryptContact({ name: normalized.contactName, phone: normalized.contactPhone }, mode),
      phoneHmac(normalized.contactPhone, mode),
      maskName(normalized.contactName),
      maskPhone(normalized.contactPhone),
      input.disclosureVersion,
      JSON.stringify(consentSnapshot),
      idempotencyDigest,
      requestHash,
      nowIso,
      nowIso,
      nowIso,
    );
    await transaction.prepare(`
      UPDATE subsidy_consultation_quote_snapshots SET used_at = ? WHERE id = ?
    `).run(nowIso, String(quote.id));
    await transaction.prepare(`
      UPDATE subsidy_consultation_materials SET
        consultation_id = ?, state = 'bound', staged_expires_at = NULL,
        delete_after = ?, updated_at = ?
      WHERE id = ANY(?) AND user_id = ?
    `).run(id, addDays(now, UNHANDLED_EXPIRY_DAYS + TERMINAL_RETENTION_DAYS), nowIso, input.materialIds, currentUserId);
    await insertSubsidyEvent(transaction, id, "consultation_created", "owner", ownerAuditSubject(currentUserId), {
      detail: {
        feePlanVersion: Number(quote.fee_plan_version),
        administrativeFeeFen: Number(quote.administrative_fee_fen),
        totalTransferCostFen: Number(quote.total_transfer_cost_fen),
        materialKinds: [...kinds].sort(),
        declaredValueSource: "owner_self_reported",
        isAppraisal: false,
      },
      now,
    });
    const created = await transaction.prepare<Row>("SELECT * FROM subsidy_consultations WHERE id = ?").get(id);
    if (!created) throw new Error("Created subsidy consultation could not be read back");
    return { receipt: await consultationReceipt(transaction, created), duplicate: false };
  });
}

export async function getOwnerSubsidyConsultation(
  database: AppDatabase,
  currentUserId: string,
  consultationId: string,
) {
  const row = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultations WHERE id = ? AND user_id = ?
  `).get(consultationId, currentUserId);
  if (!row) domainError(404, "SUBSIDY_CONSULTATION_NOT_FOUND", "未找到该补贴咨询");
  return consultationReceipt(database, row);
}

export async function withdrawSubsidyConsultation(
  database: AppDatabase,
  currentUserId: string,
  consultationId: string,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const updated = await database.transaction(async (transaction) => {
    const row = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultations WHERE id = ? AND user_id = ? FOR UPDATE
    `).get(consultationId, currentUserId);
    if (!row) domainError(404, "SUBSIDY_CONSULTATION_NOT_FOUND", "未找到该补贴咨询");
    if (String(row.status) === "withdrawn") return row;
    if (String(row.status) !== "new") {
      domainError(409, "SUBSIDY_CONSULTATION_WITHDRAW_NOT_ALLOWED", "仅待处理的咨询可以撤回");
    }
    const nowIso = now.toISOString();
    const deleteAfter = addDays(now, TERMINAL_RETENTION_DAYS);
    await transaction.prepare(`
      UPDATE subsidy_consultations SET status = 'withdrawn', withdrawn_at = ?,
        pii_delete_after = ?, updated_at = ? WHERE id = ?
    `).run(nowIso, deleteAfter, nowIso, consultationId);
    await transaction.prepare(`
      UPDATE subsidy_consultation_materials SET delete_after = ?, updated_at = ?
      WHERE consultation_id = ? AND state = 'bound'
    `).run(deleteAfter, nowIso, consultationId);
    await insertSubsidyEvent(
      transaction,
      consultationId,
      "consultation_withdrawn",
      "owner",
      ownerAuditSubject(currentUserId),
      { now },
    );
    const changed = await transaction.prepare<Row>("SELECT * FROM subsidy_consultations WHERE id = ?").get(consultationId);
    if (!changed) throw new Error("Withdrawn subsidy consultation could not be read back");
    return changed;
  });
  return consultationReceipt(database, updated);
}

function adminListItem(row: Row) {
  return {
    id: String(row.id),
    consultationCode: String(row.consultation_code),
    status: String(row.status),
    contactNameMasked: String(row.contact_name_masked),
    maskedPhone: String(row.masked_phone),
    vehiclePlateMasked: String(row.vehicle_plate_masked),
    vehicleModelName: String(row.vehicle_model_name),
    declaredValueFen: Number(row.declared_value_fen),
    ...frozenTransferCostDto(row),
    administrativeFeesLabel: "行政性收费参考",
    totalTransferCostLabel: "过户费用合计（参考）",
    administrativeFeesNotice: "实际金额以办理机构及所选服务为准，本模块不收取该费用。",
    planVersion: Number(row.fee_plan_version),
    submittedAt: String(row.submitted_at),
    handledAt: row.handled_at == null ? null : String(row.handled_at),
    withdrawnAt: row.withdrawn_at == null ? null : String(row.withdrawn_at),
    expiredAt: row.expired_at == null ? null : String(row.expired_at),
    handleResult: row.handle_result == null ? null : String(row.handle_result),
  };
}

export async function listAdminSubsidyConsultations(
  database: AppDatabase,
  options: { status?: string; page?: number; pageSize?: number } = {},
) {
  const status = options.status?.trim();
  if (status && !["new", "handled", "withdrawn", "expired"].includes(status)) {
    domainError(400, "SUBSIDY_CONSULTATION_STATUS_INVALID", "咨询状态筛选无效");
  }
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 20)));
  const where = status ? "WHERE status = ?" : "";
  const parameters = status ? [status] : [];
  const count = await database.prepare<Row>(`
    SELECT COUNT(*) AS count FROM subsidy_consultations ${where}
  `).get(...parameters);
  const rows = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultations ${where}
    ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(...parameters, pageSize, (page - 1) * pageSize);
  return { items: rows.map(adminListItem), total: Number(count?.count ?? 0), page, pageSize };
}

export async function getAdminSubsidyConsultationDetail(
  database: AppDatabase,
  consultationId: string,
  options: { actor: string; now?: Date },
) {
  const row = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultations WHERE id = ?
  `).get(consultationId);
  if (!row) domainError(404, "SUBSIDY_CONSULTATION_NOT_FOUND", "未找到该补贴咨询");
  const [materials, events] = await Promise.all([
    database.prepare<Row>(`
      SELECT * FROM subsidy_consultation_materials
      WHERE consultation_id = ? ORDER BY created_at, id
    `).all(consultationId),
    database.prepare<Row>(`
      SELECT * FROM subsidy_consultation_events
      WHERE consultation_id = ? ORDER BY created_at, id
    `).all(consultationId),
  ]);
  const contact = decryptContact(row.contact_ciphertext);
  await insertSubsidyEvent(database, consultationId, "sensitive_detail_read", "admin", options.actor, {
    now: options.now,
  });
  return {
    ...adminListItem(row),
    declaredValueSource: "owner_self_reported",
    isAppraisal: false,
    matchedTier: jsonObject(row.tier_snapshot_json),
    contact: contact ?? { name: "已按留存策略清除", phone: "已按留存策略清除" },
    disclosure: jsonObject(row.consent_snapshot_json),
    internalNote: row.internal_note == null ? null : String(row.internal_note),
    piiPurgedAt: row.pii_purged_at == null ? null : String(row.pii_purged_at),
    materials: materials.map((material) => ({
      ...materialDto(material),
      available: String(material.state) === "bound" && material.deleted_at == null && material.storage_key != null,
      viewPath: `/api/admin/subsidy-consultations/${encodeURIComponent(consultationId)}/materials/${encodeURIComponent(String(material.id))}`,
    })),
    events: events.map((event) => ({
      id: String(event.id),
      action: String(event.action),
      actorType: String(event.actor_type),
      actorSubject: event.actor_subject == null ? null : String(event.actor_subject),
      materialKind: event.material_kind == null ? null : String(event.material_kind),
      detail: jsonObject(event.detail_json),
      createdAt: String(event.created_at),
    })),
  };
}

export async function readAdminSubsidyConsultationMaterial(
  database: AppDatabase,
  consultationId: string,
  materialId: string,
  uploadDir: string,
  options: { actor: string; now?: Date },
): Promise<{ data: Buffer; mimeType: string; kind: SubsidyConsultationMaterialKind }> {
  const row = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultation_materials
    WHERE id = ? AND consultation_id = ? AND state = 'bound'
      AND deleted_at IS NULL AND storage_key IS NOT NULL
  `).get(materialId, consultationId);
  if (!row) domainError(404, "SUBSIDY_MEDIA_NOT_FOUND", "资料图片不存在或已按策略清除");
  const encrypted = await readFile(join(uploadDir, String(row.storage_key))).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") domainError(404, "SUBSIDY_MEDIA_NOT_FOUND", "资料图片不存在或已按策略清除");
    throw error;
  });
  const mode = String(row.encryption_mode);
  if (mode !== "demo" && mode !== "real") domainError(500, "SUBSIDY_MEDIA_MODE_INVALID", "敏感资料无法读取");
  const kind = String(row.kind) as SubsidyConsultationMaterialKind;
  const data = decryptFile(encrypted, mode);
  await insertSubsidyEvent(database, consultationId, "sensitive_material_read", "admin", options.actor, {
    materialKind: kind,
    now: options.now,
  });
  return { data, mimeType: String(row.mime_type), kind };
}

export async function handleSubsidyConsultation(
  database: AppDatabase,
  consultationId: string,
  input: { result: SubsidyConsultationHandleResult; note?: string },
  options: { actor: string; now?: Date; request: FastifyRequest },
) {
  const now = options.now ?? new Date();
  const changed = await database.transaction(async (transaction) => {
    const row = await transaction.prepare<Row>(`
      SELECT * FROM subsidy_consultations WHERE id = ? FOR UPDATE
    `).get(consultationId);
    if (!row) domainError(404, "SUBSIDY_CONSULTATION_NOT_FOUND", "未找到该补贴咨询");
    if (String(row.status) !== "new") {
      domainError(409, "SUBSIDY_CONSULTATION_TRANSITION_INVALID", "仅待处理咨询可以标记为已处理");
    }
    if (!SUBSIDY_CONSULTATION_HANDLE_RESULTS.includes(input.result)) {
      domainError(400, "SUBSIDY_CONSULTATION_RESULT_INVALID", "处理结果无效");
    }
    const nowIso = now.toISOString();
    const deleteAfter = addDays(now, TERMINAL_RETENTION_DAYS);
    await transaction.prepare(`
      UPDATE subsidy_consultations SET status = 'handled', handle_result = ?,
        internal_note = ?, handled_at = ?, pii_delete_after = ?, updated_at = ?
      WHERE id = ?
    `).run(input.result, input.note?.trim() || null, nowIso, deleteAfter, nowIso, consultationId);
    await transaction.prepare(`
      UPDATE subsidy_consultation_materials SET delete_after = ?, updated_at = ?
      WHERE consultation_id = ? AND state = 'bound'
    `).run(deleteAfter, nowIso, consultationId);
    await insertSubsidyEvent(transaction, consultationId, "consultation_handled", "admin", options.actor, {
      detail: { result: input.result, hasNote: Boolean(input.note?.trim()) },
      now,
    });
    const updated = await transaction.prepare<Row>("SELECT * FROM subsidy_consultations WHERE id = ?").get(consultationId);
    if (!updated) throw new Error("Handled subsidy consultation could not be read back");
    const resultLabel = SUBSIDY_HANDLE_RESULT_LABELS[input.result];
    const resourceLabel = `咨询 ${String(row.consultation_code)} · ${String(row.vehicle_plate_masked)}`;
    await auditBackofficeEvent(transaction, {
      request: options.request,
      action: "subsidy.consultation.handle",
      outcome: "success",
      resource: { type: "subsidy_consultation", id: consultationId },
      before: { status: "new" },
      after: { status: "handled", result: input.result },
      metadata: {
        presentation: subsidyPresentation({
          actionLabel: "处理补贴咨询",
          summary: `处理咨询 ${String(row.consultation_code)}：${resultLabel}`,
          resourceLabel,
          changes: [
            { field: "status", label: "咨询状态", before: "新提交", after: "已处理" },
            { field: "result", label: "处理结果", after: resultLabel },
          ],
        }),
      },
      occurredAt: nowIso,
    });
    return updated;
  });
  return adminListItem(changed);
}

export async function cleanupSubsidyConsultationData(
  database: AppDatabase,
  uploadDir: string,
  now = new Date(),
): Promise<{
  consultationsExpired: number;
  materialsDeleted: number;
  materialDeleteFailures: number;
  piiPurged: number;
  unusedQuotesDeleted: number;
  eventsDeleted: number;
}> {
  const nowIso = now.toISOString();
  const expiryThreshold = new Date(now.getTime() - UNHANDLED_EXPIRY_DAYS * DAY_MS).toISOString();
  const expiredRows = await database.transaction(async (transaction) => {
    const rows = await transaction.prepare<Row>(`
      SELECT id FROM subsidy_consultations
      WHERE status = 'new' AND submitted_at <= ? FOR UPDATE
    `).all(expiryThreshold);
    for (const row of rows) {
      const id = String(row.id);
      const deleteAfter = addDays(now, TERMINAL_RETENTION_DAYS);
      await transaction.prepare(`
        UPDATE subsidy_consultations SET status = 'expired', expired_at = ?,
          pii_delete_after = ?, updated_at = ? WHERE id = ?
      `).run(nowIso, deleteAfter, nowIso, id);
      await transaction.prepare(`
        UPDATE subsidy_consultation_materials SET delete_after = ?, updated_at = ?
        WHERE consultation_id = ? AND state = 'bound'
      `).run(deleteAfter, nowIso, id);
      await insertSubsidyEvent(transaction, id, "consultation_expired", "system", "retention-cleanup", { now });
    }
    return rows;
  });

  const materialRows = await database.prepare<Row>(`
    SELECT * FROM subsidy_consultation_materials
    WHERE state <> 'deleted' AND (
      (state = 'staged' AND staged_expires_at <= ?)
      OR (state = 'bound' AND delete_after IS NOT NULL AND delete_after <= ?)
    )
    ORDER BY created_at, id
  `).all(nowIso, nowIso);
  let materialsDeleted = 0;
  let materialDeleteFailures = 0;
  for (const material of materialRows) {
    const storageKey = material.storage_key == null ? null : String(material.storage_key);
    if (storageKey) {
      try {
        await unlink(join(uploadDir, storageKey));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          materialDeleteFailures += 1;
          continue;
        }
      }
    }
    const changed = await database.prepare(`
      UPDATE subsidy_consultation_materials SET
        state = 'deleted', storage_key = NULL, user_id = NULL, content_hash = NULL,
        staged_expires_at = NULL, delete_after = NULL, deleted_at = ?, updated_at = ?
      WHERE id = ? AND state <> 'deleted'
    `).run(nowIso, nowIso, String(material.id));
    if (changed.changes > 0) {
      materialsDeleted += 1;
      if (material.consultation_id != null) {
        await insertSubsidyEvent(
          database,
          String(material.consultation_id),
          "material_retention_deleted",
          "system",
          "retention-cleanup",
          { materialKind: String(material.kind) as SubsidyConsultationMaterialKind, now },
        );
      }
    }
  }

  const piiRows = await database.prepare<Row>(`
    SELECT id, quote_id FROM subsidy_consultations
    WHERE pii_purged_at IS NULL AND pii_delete_after IS NOT NULL AND pii_delete_after <= ?
  `).all(nowIso);
  for (const row of piiRows) {
    await database.transaction(async (transaction) => {
      await transaction.prepare(`
        UPDATE subsidy_consultations SET
          vehicle_id = NULL, contact_ciphertext = NULL, phone_hmac = NULL,
          request_hash = NULL, contact_name_masked = '已清除', masked_phone = '已清除',
          vehicle_plate_masked = '已清除', vehicle_model_name = '已清除',
          pii_purged_at = ?, updated_at = ?
        WHERE id = ? AND pii_purged_at IS NULL
      `).run(nowIso, nowIso, String(row.id));
      await transaction.prepare(`
        UPDATE subsidy_consultation_quote_snapshots
        SET user_id = NULL, vehicle_id = NULL WHERE id = ?
      `).run(String(row.quote_id));
      await transaction.prepare(`
        UPDATE subsidy_consultation_materials
        SET user_id = NULL, updated_at = ? WHERE consultation_id = ?
      `).run(nowIso, String(row.id));
      await insertSubsidyEvent(
        transaction,
        String(row.id),
        "pii_retention_purged",
        "system",
        "retention-cleanup",
        { now },
      );
    });
  }
  const unusedQuoteCutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const deletedQuotes = await database.prepare(`
    DELETE FROM subsidy_consultation_quote_snapshots
    WHERE used_at IS NULL AND expires_at <= ?
  `).run(unusedQuoteCutoff);
  const deletedEvents = await database.prepare(`
    DELETE FROM subsidy_consultation_events WHERE delete_after <= ?
  `).run(nowIso);
  return {
    consultationsExpired: expiredRows.length,
    materialsDeleted,
    materialDeleteFailures,
    piiPurged: piiRows.length,
    unusedQuotesDeleted: Number(deletedQuotes.changes),
    eventsDeleted: Number(deletedEvents.changes),
  };
}

function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function adminSubjectForRequest(
  request: FastifyRequest,
  problem: SubsidyConsultationProblemFactory,
): string {
  if (currentMode() === "demo") {
    const demoSubject = request.headers["x-yuxiaoman-admin-subject"];
    const value = Array.isArray(demoSubject) ? demoSubject[0] : demoSubject;
    return typeof value === "string" && value.trim()
      ? value.trim().slice(0, 160)
      : "operations-demo-admin";
  }
  const config = configuredAdminIdentity();
  if (!config) throw problem(503, "SUBSIDY_ADMIN_IDENTITY_UNAVAILABLE", "补贴咨询后台身份配置不可用");
  const header = request.headers[config.headerName];
  const received = Array.isArray(header) ? header[0] : header;
  if (typeof received !== "string" || !constantTimeStringEqual(received, config.secret)) {
    throw problem(401, "SUBSIDY_ADMIN_IDENTITY_REQUIRED", "需要可信的后台管理员身份");
  }
  return config.subject;
}

function assertAllowedOrigin(request: FastifyRequest, problem: SubsidyConsultationProblemFactory): void {
  if (currentMode() !== "real") return;
  const originHeader = request.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin) return;
  if (!configuredAllowedOrigins().includes(origin)) {
    throw problem(403, "SUBSIDY_ORIGIN_NOT_ALLOWED", "当前来源无权访问补贴咨询资料");
  }
}

export async function registerSubsidyConsultationRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: SubsidyConsultationRouteOptions,
): Promise<void> {
  const { problem, uploadDir } = options;
  const currentTime = options.now ?? (() => new Date());
  const cleanupIntervalMs = Math.max(0, options.cleanupIntervalMs ?? 15 * 60 * 1_000);
  await database.transaction(async (transaction) => {
    await transaction.prepare(
      "SELECT pg_advisory_xact_lock(hashtext('subsidy-consultation-schema-v1'))",
    ).get();
    await migrateSubsidyConsultationDatabase(transaction);
    await seedSubsidyConsultationData(transaction, currentTime().toISOString());
  });
  if (process.env.SUBSIDY_CONSULTATION_REAL_MODE === "true"
    && !subsidyConsultationRealConfigurationReady()) {
    throw new Error(
      "SUBSIDY_CONSULTATION_REAL_MODE requires Bearer-only owner auth (demo fallback disabled), HTTPS, a 32-byte data key, a 32-character phone HMAC key, explicit HTTPS allowed origins, and trusted admin header secret/subject configuration",
    );
  }
  if (currentMode() === "real" && !privateUploadDirectoryIsSafe(uploadDir)) {
    throw new Error("SUBSIDY_CONSULTATION_UPLOAD_DIR must not be inside a public web directory");
  }
  await mkdir(uploadDir, { recursive: true });
  const initialCleanup = await cleanupSubsidyConsultationData(database, uploadDir, currentTime());
  if (initialCleanup.materialDeleteFailures > 0) {
    app.log.warn(
      { count: initialCleanup.materialDeleteFailures },
      "subsidy consultation materials remain pending after retention cleanup",
    );
  }

  let lastCleanupAt = currentTime().getTime();
  let cleanupInFlight: Promise<void> | null = null;
  app.addHook("onRequest", async (request) => {
    const inScope = request.url.startsWith("/api/subsidy-consultation/")
      || request.url.startsWith("/api/subsidy-consultations")
      || request.url.startsWith("/api/admin/subsidy-consultation/")
      || request.url.startsWith("/api/admin/subsidy-consultations");
    if (!inScope) return;
    assertAllowedOrigin(request, problem);
    if (request.url.startsWith("/api/admin/")) adminSubjectForRequest(request, problem);
    const now = currentTime();
    if (!cleanupInFlight && cleanupIntervalMs > 0 && now.getTime() - lastCleanupAt < cleanupIntervalMs) return;
    if (!cleanupInFlight) {
      lastCleanupAt = now.getTime();
      cleanupInFlight = cleanupSubsidyConsultationData(database, uploadDir, now)
        .then((summary) => {
          if (summary.materialDeleteFailures > 0) {
            app.log.warn(
              { count: summary.materialDeleteFailures },
              "subsidy consultation materials remain pending after retention cleanup",
            );
          }
        })
        .catch((error: unknown) => {
          app.log.error({ error }, "subsidy consultation retention cleanup failed");
        })
        .finally(() => {
          cleanupInFlight = null;
        });
    }
    await cleanupInFlight;
  });

  app.get("/api/subsidy-consultation/config", async (request, reply) => {
    await requireCurrentUser(request, database);
    reply.header("Cache-Control", "private, no-store");
    const data = await routeOperation(problem, () => getSubsidyConsultationConfig(database));
    return { data };
  });

  app.post("/api/subsidy-consultation/quotes", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(quoteBodySchema, request.body, problem);
    const quote = await routeOperation(problem, () => createSubsidyConsultationQuote(
      database,
      currentUserId,
      body,
      { now: currentTime() },
    ));
    reply.header("Cache-Control", "private, no-store");
    return reply.status(201).send({ data: { quote } });
  });

  app.post("/api/subsidy-consultation/materials", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    if (currentMode() !== "real") {
      throw problem(
        403,
        "REAL_DATA_NOT_ACCEPTED",
        "演示模式不接受任意文件上传，请使用服务端生成的合成演示资料",
      );
    }
    const materialInput = await parseMaterialMultipart(request, problem);
    const material = await routeOperation(problem, () => stageSubsidyConsultationMaterial(
      database,
      currentUserId,
      materialInput,
      uploadDir,
      { now: currentTime(), mode: currentMode() },
    ));
    reply.header("Cache-Control", "private, no-store");
    return reply.status(201).send({ data: { material } });
  });

  app.post("/api/subsidy-consultation/demo-materials", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    if (currentMode() !== "demo") {
      throw problem(403, "DEMO_MATERIALS_NOT_AVAILABLE", "真实资料模式不能创建合成演示资料");
    }
    const body = parseBody(z.object({ kind: materialKindSchema }), request.body, problem);
    const materialInput = await syntheticDemoMaterial(body.kind);
    const material = await routeOperation(problem, () => stageSubsidyConsultationMaterial(
      database,
      currentUserId,
      materialInput,
      uploadDir,
      { now: currentTime(), mode: "demo" },
    ));
    reply.header("Cache-Control", "private, no-store");
    return reply.status(201).send({ data: { material } });
  });

  app.delete<{ Params: { id: string } }>("/api/subsidy-consultation/materials/:id", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    await routeOperation(problem, () => deleteStagedSubsidyConsultationMaterial(
      database,
      currentUserId,
      request.params.id,
      uploadDir,
      { now: currentTime() },
    ));
    return reply.status(204).send();
  });

  app.delete("/api/subsidy-consultation/materials", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(z.object({ materialId: idSchema }), request.body, problem);
    await routeOperation(problem, () => deleteStagedSubsidyConsultationMaterial(
      database,
      currentUserId,
      body.materialId,
      uploadDir,
      { now: currentTime() },
    ));
    return reply.status(204).send();
  });

  app.post("/api/subsidy-consultations", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(createConsultationBodySchema, request.body, problem);
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    const result = await routeOperation(problem, () => createSubsidyConsultation(
      database,
      currentUserId,
      body,
      { idempotencyKey, now: currentTime(), mode: currentMode() },
    ));
    reply.header("Cache-Control", "private, no-store");
    return reply.status(result.duplicate ? 200 : 201).send({ data: { receipt: result.receipt } });
  });

  app.get<{ Params: { id: string } }>("/api/subsidy-consultations/:id", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const consultation = await routeOperation(problem, () => getOwnerSubsidyConsultation(
      database,
      currentUserId,
      request.params.id,
    ));
    reply.header("Cache-Control", "private, no-store");
    return { data: { consultation } };
  });

  app.post<{ Params: { id: string } }>("/api/subsidy-consultations/:id/withdraw", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const consultation = await routeOperation(problem, () => withdrawSubsidyConsultation(
      database,
      currentUserId,
      request.params.id,
      { now: currentTime() },
    ));
    reply.header("Cache-Control", "private, no-store");
    return { data: { consultation } };
  });

  app.get("/api/admin/subsidy-consultation/fee-plan", async (request, reply) => {
    adminSubjectForRequest(request, problem);
    reply.header("Cache-Control", "private, no-store");
    return { data: await getSubsidyConsultationFeePlans(database) };
  });

  app.put("/api/admin/subsidy-consultation/fee-plan/draft", async (request, reply) => {
    const actor = adminSubjectForRequest(request, problem);
    const raw = parseBody(feePlanDraftBodySchema, request.body, problem);
    const draftInput: SubsidyConsultationFeePlanDraftInput = {
      active: raw.active ?? raw.isActive!,
      administrativeFees: raw.administrativeFees,
      tiers: raw.tiers.map((tier) => ({
        id: tier.id,
        label: tier.label,
        minValueFen: tier.minValueFen,
        maxValueFen: tier.maxValueFen,
        feeFen: tier.feeFen ?? tier.consultationFeeFen!,
        sortOrder: tier.sortOrder,
      })),
    };
    await routeOperation(problem, () => saveSubsidyConsultationFeePlanDraft(
      database,
      draftInput,
      { actor, now: currentTime() },
    ));
    reply.header("Cache-Control", "private, no-store");
    return { data: await getSubsidyConsultationFeePlans(database) };
  });

  app.post("/api/admin/subsidy-consultation/fee-plan/publish", async (request, reply) => {
    const actor = adminSubjectForRequest(request, problem);
    await routeOperation(problem, () => publishSubsidyConsultationFeePlan(
      database,
      { actor, now: currentTime(), request },
    ));
    reply.header("Cache-Control", "private, no-store");
    return { data: await getSubsidyConsultationFeePlans(database) };
  });

  app.get("/api/admin/subsidy-consultation/disclosure", async (request, reply) => {
    adminSubjectForRequest(request, problem);
    const row = await routeOperation(problem, () => activeDisclosure(database));
    reply.header("Cache-Control", "private, no-store");
    return { data: disclosureDto(row, currentMode()) };
  });

  app.put("/api/admin/subsidy-consultation/disclosure", async (request, reply) => {
    const actor = adminSubjectForRequest(request, problem);
    const body = parseBody(disclosureBodySchema, request.body, problem);
    const data = await routeOperation(problem, () => updateSubsidyConsultationDisclosure(
      database,
      body,
      { actor, now: currentTime(), request },
    ));
    reply.header("Cache-Control", "private, no-store");
    return { data };
  });

  app.get<{ Querystring: { status?: string; page?: string; pageSize?: string } }>(
    "/api/admin/subsidy-consultations",
    async (request, reply) => {
      adminSubjectForRequest(request, problem);
      const data = await routeOperation(problem, () => listAdminSubsidyConsultations(database, {
        status: request.query.status,
        page: Number.parseInt(request.query.page ?? "1", 10) || 1,
        pageSize: Number.parseInt(request.query.pageSize ?? "20", 10) || 20,
      }));
      reply.header("Cache-Control", "private, no-store");
      return { data };
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/subsidy-consultations/:id", async (request, reply) => {
    const actor = adminSubjectForRequest(request, problem);
    const data = await routeOperation(problem, () => getAdminSubsidyConsultationDetail(
      database,
      request.params.id,
      { actor, now: currentTime() },
    ));
    reply.header("Cache-Control", "private, no-store");
    return { data };
  });

  app.get<{ Params: { id: string; materialId: string } }>(
    "/api/admin/subsidy-consultations/:id/materials/:materialId",
    async (request, reply) => {
      const actor = adminSubjectForRequest(request, problem);
      const material = await routeOperation(problem, () => readAdminSubsidyConsultationMaterial(
        database,
        request.params.id,
        request.params.materialId,
        uploadDir,
        { actor, now: currentTime() },
      ));
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Disposition", "inline");
      reply.type(material.mimeType);
      return reply.send(material.data);
    },
  );

  app.post<{ Params: { id: string } }>("/api/admin/subsidy-consultations/:id/handle", async (request, reply) => {
    const actor = adminSubjectForRequest(request, problem);
    const body = parseBody(handleBodySchema, request.body, problem);
    const data = await routeOperation(problem, () => handleSubsidyConsultation(
      database,
      request.params.id,
      body,
      { actor, now: currentTime(), request },
    ));
    reply.header("Cache-Control", "private, no-store");
    return { data };
  });
}
