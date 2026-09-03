import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import { auditBackofficeEvent } from "./backoffice.js";
import type { AppDatabase, DatabaseValue } from "./database.js";
import { stableJson } from "./db.js";
import { computeDrivingSchoolDisclosureVersion } from "./driving-school-db.js";

type Row = Record<string, DatabaseValue>;
type ProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

type DrivingSchoolRouteOptions = {
  problem: ProblemFactory;
  now?: () => Date;
  validLocationProof: (location: z.infer<typeof locationSchema>) => boolean;
};

type InquiryMode = "demo" | "real";
type ActorType = "owner" | "admin" | "system";

const DAY_MS = 86_400_000;
const SOURCE = "wechat-owner-services";
const DEMO_DATA_KEY = createHash("sha256").update("yuxiaoman-driving-school-demo-data-key-v1").digest();
const DEMO_PHONE_HMAC_KEY = "yuxiaoman-driving-school-demo-phone-hmac-key-v1";
const DEMO_PHONES = new Set(["13800138000", "13900000000"]);
const LICENSE_CLASS_CODES = [
  "A1", "A2", "A3", "B1", "B2", "C1", "C2", "C3", "C4", "C5", "C6",
  "D", "E", "F", "M", "N", "P",
] as const;

type DrivingSchoolAuditChange = {
  field?: string;
  label: string;
  before?: unknown;
  after?: unknown;
};

const DRIVING_SCHOOL_PRICE_TYPE_LABELS: Record<string, string> = {
  fixed: "固定价",
  starting_from: "起价",
  range: "区间价",
  inquiry: "价格需咨询",
};

const DRIVING_SCHOOL_INQUIRY_STATUS_LABELS: Record<string, string> = {
  new: "新线索",
  contacting: "联系中",
  resolved: "已解决",
  closed: "已关闭",
  withdrawn: "已撤回",
};

function drivingSchoolPresentation(input: {
  actionLabel: string;
  summary: string;
  resourceLabel?: string;
  changes?: DrivingSchoolAuditChange[];
  reason?: string;
}) {
  return {
    category: "driving_school",
    actionLabel: input.actionLabel,
    summary: input.summary,
    subjectName: "驾校服务",
    resourceLabel: input.resourceLabel,
    changes: input.changes,
    reason: input.reason,
  };
}

function drivingSchoolAuditChanges(
  entries: Array<DrivingSchoolAuditChange & { contentOnly?: boolean }>,
): DrivingSchoolAuditChange[] {
  return entries.flatMap(({ contentOnly, ...entry }) => {
    if (stableJson(entry.before) === stableJson(entry.after)) return [];
    return [contentOnly ? { field: entry.field, label: entry.label } : entry];
  });
}

function drivingSchoolMoney(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? `¥${(amount / 100).toFixed(2)}` : null;
}

function drivingSchoolModeLabels(values: string[]): string {
  return values.map((value) => value === "initial" ? "初次申领" : value === "upgrade" ? "增驾" : value).join("、");
}

function withAutoUnpublish(
  summary: string,
  changes: DrivingSchoolAuditChange[],
  reasons: string[],
): { summary: string; changes: DrivingSchoolAuditChange[]; reason?: string } {
  if (reasons.length === 0) return { summary, changes };
  return {
    summary: `${summary}，并因发布条件不满足自动下线`,
    changes: [...changes, { field: "publicationStatus", label: "发布状态", before: "已发布", after: "已下线" }],
    reason: `缺少：${reasons.join("、")}`,
  };
}

const licenseClassSchema = z.enum(LICENSE_CLASS_CODES);
const applicationModeSchema = z.enum(["initial", "upgrade"]);
const priceTypeSchema = z.enum(["fixed", "starting_from", "range", "inquiry"]);
const regulatoryTypeSchema = z.enum(["filing", "legacy_license"]);
const capabilityLevelSchema = z.union([
  z.enum(["level_1", "level_2", "level_3"]),
  z.literal(1), z.literal(2), z.literal(3),
]);
const contactWindowSchema = z.enum(["morning", "afternoon", "evening", "anytime"]);
const inquiryStatusSchema = z.enum(["new", "contacting", "resolved", "closed", "withdrawn"]);
const idSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{2,99}$/iu);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "请使用有效的 YYYY-MM-DD 日期");

const locationSchema = z.object({
  poiId: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(120),
  address: z.string().trim().min(2).max(240),
  district: z.string().trim().min(1).max(40),
  latitude: z.number().min(38.4).max(40.3),
  longitude: z.number().min(116.6).max(118.2),
  source: z.enum(["tencent", "wechat", "demo"]),
  locationProof: z.string().trim().max(2_000).optional(),
});

const regulatorySchema = z.object({
  type: regulatoryTypeSchema,
  number: z.string().trim().min(2).max(120),
  authority: z.string().trim().min(2).max(180),
  sourceUrl: z.string().trim().url().max(800).nullable().optional(),
  sourceLabel: z.string().trim().min(2).max(180),
  validFrom: isoDateSchema.nullable().optional(),
  validUntil: isoDateSchema.nullable().optional(),
  verifiedAt: z.string().datetime().nullable().optional(),
  status: z.enum(["pending", "verified", "rejected", "expired", "demo"]),
  capabilityLevel: capabilityLevelSchema.nullable().optional(),
});

const inquiryRecipientSchema = z.object({
  recipientName: z.literal("驭小满驾校服务团队"),
  dataScope: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  purpose: z.string().trim().min(4).max(500),
  retention: z.string().trim().min(4).max(500),
  consentText: z.string().trim().min(8).max(1_000),
  contactEtaText: z.string().trim().min(2).max(120),
  active: z.boolean().default(true),
  synthetic: z.boolean(),
});

function defaultDemoInquiryRecipient(): z.infer<typeof inquiryRecipientSchema> {
  return {
    recipientName: "驭小满驾校服务团队",
    dataScope: ["联系人姓名", "手机号", "意向准驾车型", "联系时段", "咨询备注（如填写）"],
    purpose: "仅由驭小满平台内部了解报名意向并跟进咨询，不向驾校或其他第三方转交",
    retention: "线索解决、关闭或撤回后 180 天清除联系资料；审计事件保留 365 天",
    consentText: "我已阅读并同意由驭小满驾校服务团队在平台内部处理上述合成演示资料，用于本次咨询；资料不会转交驾校。",
    contactEtaText: "演示咨询人员预计 1 个工作日内联系（不会真实外呼）",
    active: true,
    synthetic: true,
  };
}

const schoolCreateSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(180).nullable().optional(),
  description: z.string().trim().max(2_000).default(""),
  dataKind: z.enum(["demo", "real"]),
  location: locationSchema,
  publicPhone: z.string().trim().max(40).nullable().optional(),
  internalContact: z.object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().min(5).max(40),
  }).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  facilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  openHours: z.string().trim().max(120).default(""),
  weeklySchedule: z.record(z.string(), z.unknown()).default({}),
  regulatory: regulatorySchema,
  inquiryRecipient: inquiryRecipientSchema.optional(),
  isActive: z.boolean().default(true),
  sortPriority: z.number().int().min(-10_000).max(10_000).default(0),
});

const schoolPatchSchema = schoolCreateSchema.omit({ id: true, location: true }).partial().extend({
  location: locationSchema.optional(),
});

const imageCreateSchema = z.object({
  id: idSchema.optional(),
  url: z.string().trim().min(1).max(1_000),
  caption: z.string().trim().max(240).default(""),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  isCover: z.boolean().default(false),
});
const imagePatchSchema = imageCreateSchema.omit({ id: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  "至少提供一个修改字段",
);

const trainingClassCreateSchema = z.object({
  licenseClassCode: licenseClassSchema,
  applicationModes: z.array(applicationModeSchema).min(1).max(2).optional(),
  supportedModes: z.array(applicationModeSchema).min(1).max(2).optional(),
  trainingCapabilityNote: z.string().trim().max(300).nullable().optional(),
  /** @deprecated Compatibility for admin builds that used this field as a note. */
  trainingCapabilityLevel: z.string().trim().max(80).nullable().optional(),
  schoolConditions: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  /** @deprecated Use schoolConditions. */
  conditions: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
}).superRefine((value, context) => {
  if (!value.applicationModes && !value.supportedModes) {
    context.addIssue({ code: "custom", path: ["applicationModes"], message: "请选择报名方式" });
  }
});
const trainingClassPatchSchema = z.object({
  applicationModes: z.array(applicationModeSchema).min(1).max(2).optional(),
  supportedModes: z.array(applicationModeSchema).min(1).max(2).optional(),
  trainingCapabilityNote: z.string().trim().max(300).nullable().optional(),
  /** @deprecated Compatibility for admin builds that used this field as a note. */
  trainingCapabilityLevel: z.string().trim().max(80).nullable().optional(),
  schoolConditions: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  /** @deprecated Use schoolConditions. */
  conditions: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段");

const offerFieldsBaseSchema = z.object({
  licenseClassCode: licenseClassSchema,
  name: z.string().trim().min(2).max(160),
  priceType: priceTypeSchema,
  minPriceFen: z.number().int().min(0).max(100_000_000).nullable().optional(),
  maxPriceFen: z.number().int().min(0).max(100_000_000).nullable().optional(),
  applicationModes: z.array(applicationModeSchema).min(1).max(2),
  unit: z.string().trim().min(1).max(40).default("人/期"),
  includedItems: z.array(z.string().trim().min(1).max(160)).max(40).default([]),
  excludedItems: z.array(z.string().trim().min(1).max(160)).max(40).default([]),
  description: z.string().trim().max(1_000).default(""),
  validFrom: isoDateSchema.nullable().optional(),
  validUntil: isoDateSchema.nullable().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
});
type OfferFields = z.infer<typeof offerFieldsBaseSchema>;
function validateOfferFields(value: OfferFields, context: z.RefinementCtx): void {
  const min = value.minPriceFen ?? null;
  const max = value.maxPriceFen ?? null;
  if (value.priceType === "fixed" && (min == null || max !== min)) {
    context.addIssue({ code: "custom", path: ["maxPriceFen"], message: "固定价的最低价和最高价必须相同" });
  }
  if (value.priceType === "starting_from" && (min == null || max != null)) {
    context.addIssue({ code: "custom", path: ["minPriceFen"], message: "起价仅填写最低价" });
  }
  if (value.priceType === "range" && (min == null || max == null || max < min)) {
    context.addIssue({ code: "custom", path: ["maxPriceFen"], message: "区间价须填写有效的最低价和最高价" });
  }
  if (value.priceType === "inquiry" && (min != null || max != null)) {
    context.addIssue({ code: "custom", path: ["minPriceFen"], message: "面议报价不能填写金额" });
  }
}
const offerFieldsSchema = offerFieldsBaseSchema.superRefine(validateOfferFields);
const offerCreateSchema = offerFieldsBaseSchema.extend({ id: idSchema.optional() }).superRefine(validateOfferFields);
const offerPatchSchema = offerFieldsBaseSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "至少提供一个修改字段",
);

const inquiryCreateSchema = z.object({
  schoolId: idSchema,
  licenseClassCode: licenseClassSchema,
  offerId: idSchema.nullable().optional(),
  applicationMode: applicationModeSchema,
  contactName: z.string().trim().min(1).max(30),
  contactPhone: z.string().trim().regex(/^1[3-9]\d{9}$/u),
  contactWindow: contactWindowSchema,
  message: z.string().trim().max(500).optional(),
  disclosureVersion: z.string().trim().min(8).max(100),
  consentAccepted: z.literal(true),
});

const inquiryPatchSchema = z.object({
  status: inquiryStatusSchema.optional(),
  internalNote: z.string().trim().max(2_000).nullable().optional(),
}).refine((value) => value.status !== undefined || value.internalNote !== undefined, "至少提供状态或内部备注");

function parseBody<T>(schema: z.ZodType<T>, value: unknown, problem: ProblemFactory): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) fields[issue.path.join(".") || "_root"] = issue.message;
  throw problem(400, "VALIDATION_ERROR", "提交的信息有误，请检查后重试", fields);
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function jsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeCapabilityLevel(value: unknown): "level_1" | "level_2" | "level_3" | null {
  if (value === 1 || value === "1" || value === "level_1") return "level_1";
  if (value === 2 || value === "2" || value === "level_2") return "level_2";
  if (value === 3 || value === "3" || value === "level_3") return "level_3";
  return null;
}

function capabilityLevelForClassCount(count: number): "level_1" | "level_2" | "level_3" | null {
  if (count >= 3) return "level_1";
  if (count === 2) return "level_2";
  if (count === 1) return "level_3";
  return null;
}

function legacyCapabilityNote(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value == null || ["level_1", "level_2", "level_3"].includes(value)) return null;
  return value;
}

function schoolConditionsFromInput(
  schoolConditions: string[] | undefined,
  legacyConditions: string[] | undefined,
  catalogConditions: string[],
): string[] {
  const selected = schoolConditions ?? legacyConditions ?? [];
  return uniqueStrings(selected.filter((condition) => !catalogConditions.includes(condition)));
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * DAY_MS).toISOString();
}

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function currentDate(now: Date): string {
  const parts = shanghaiDateFormatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shanghaiDayStartIso(date: string, offsetDays = 0): string {
  const start = new Date(`${date}T00:00:00+08:00`);
  return new Date(start.getTime() + offsetDays * DAY_MS).toISOString();
}

function trainingModes(row: Row): Array<"initial" | "upgrade"> {
  const result: Array<"initial" | "upgrade"> = [];
  if (bool(row.initial_available)) result.push("initial");
  if (bool(row.upgrade_available)) result.push("upgrade");
  return result;
}

function capabilitySupportsModes(capability: Row, modes: string[]): boolean {
  if (modes.length === 0 || modes.some((mode) => mode !== "initial" && mode !== "upgrade")) return false;
  if (modes.includes("initial")
    && (!bool(capability.initial_available)
      || (capability.initial_allowed != null && !bool(capability.initial_allowed)))) return false;
  if (modes.includes("upgrade")
    && (!bool(capability.upgrade_available)
      || (capability.upgrade_allowed != null && !bool(capability.upgrade_allowed)))) return false;
  return bool(capability.is_active);
}

function offerMatchesCapabilities(offer: Row, capabilities: Row[]): boolean {
  const capability = capabilities.find((item) =>
    String(item.license_class_code) === String(offer.license_class_code));
  return Boolean(capability && capabilitySupportsModes(capability, jsonArray(offer.application_modes_json)));
}

function classDto(row: Row) {
  const modes: Array<"initial" | "upgrade"> = [];
  if (bool(row.initial_allowed)) modes.push("initial");
  if (bool(row.upgrade_allowed)) modes.push("upgrade");
  return {
    code: String(row.code),
    name: String(row.name),
    vehicleScope: String(row.vehicle_scope),
    initialAllowed: bool(row.initial_allowed),
    upgradeAllowed: bool(row.upgrade_allowed),
    applicationModes: modes,
    conditions: jsonArray(row.conditions_json),
  };
}

function imageDto(row: Row) {
  return {
    id: String(row.id),
    url: String(row.image_url),
    caption: String(row.alt_text ?? ""),
    altText: String(row.alt_text ?? ""),
    isCover: bool(row.is_cover),
    sortOrder: Number(row.sort_order),
  };
}

function trainingClassDto(row: Row, admin = false) {
  const supportedModes = trainingModes(row);
  const catalogConditions = jsonArray(row.catalog_conditions_json);
  const schoolConditions = jsonArray(row.conditions_json);
  const migratedLegacyNote = row.training_capability_level == null
    ? null
    : legacyCapabilityNote(String(row.training_capability_level)) ?? null;
  const result: Record<string, unknown> = {
    licenseClassCode: String(row.license_class_code),
    name: String(row.license_class_name ?? row.name ?? ""),
    supportedModes,
    applicationModes: supportedModes,
    trainingCapabilityNote: row.training_capability_note == null
      ? migratedLegacyNote
      : String(row.training_capability_note),
    catalogConditions,
    schoolConditions,
    conditions: uniqueStrings([...catalogConditions, ...schoolConditions]),
    status: bool(row.is_active) ? "active" : "inactive",
    updatedAt: String(row.updated_at),
  };
  // Old admin clients may still read this property. It is deliberately never
  // included in a public school projection and no longer represents a level.
  if (admin) result.trainingCapabilityLevel = null;
  return result;
}

function offerDto(row: Row) {
  return {
    id: String(row.id),
    licenseClassCode: String(row.license_class_code),
    name: String(row.name),
    priceType: String(row.price_type),
    minPriceFen: row.min_price_fen == null ? null : Number(row.min_price_fen),
    maxPriceFen: row.max_price_fen == null ? null : Number(row.max_price_fen),
    applicationModes: jsonArray(row.application_modes_json),
    unit: String(row.unit),
    includedItems: jsonArray(row.included_items_json),
    excludedItems: jsonArray(row.excluded_items_json),
    description: String(row.description ?? ""),
    validFrom: row.valid_from == null ? null : String(row.valid_from),
    validUntil: row.valid_until == null ? null : String(row.valid_until),
    // Compatibility fields only. Offer availability is controlled by is_active
    // plus its training-class/application-mode mapping, never these dates.
    isExpired: false,
    availabilityStatus: "current",
    status: bool(row.is_active) ? "active" : "inactive",
    sortOrder: Number(row.sort_order),
    updatedAt: String(row.updated_at),
  };
}

async function schoolRelations(database: AppDatabase, schoolId: string) {
  const [images, trainingClasses, offers, recipient] = await Promise.all([
    database.prepare<Row>(`
      SELECT * FROM driving_school_images WHERE school_id = ? ORDER BY is_cover DESC, sort_order ASC, id ASC
    `).all(schoolId),
    database.prepare<Row>(`
      SELECT tc.*, lc.name AS license_class_name, lc.conditions_json AS catalog_conditions_json,
        lc.initial_allowed, lc.upgrade_allowed
      FROM driving_school_training_classes tc
      JOIN driving_license_classes lc ON lc.code = tc.license_class_code
      WHERE tc.school_id = ? ORDER BY lc.sort_order ASC
    `).all(schoolId),
    database.prepare<Row>(`
      SELECT * FROM driving_school_offers WHERE school_id = ? ORDER BY sort_order ASC, updated_at DESC
    `).all(schoolId),
    database.prepare<Row>("SELECT * FROM driving_school_inquiry_recipients WHERE school_id = ?").get(schoolId),
  ]);
  return { images, trainingClasses, offers, recipient };
}

type OfferSummaryFilter = {
  licenseClassCode?: string;
  applicationMode?: "initial" | "upgrade";
  priceType?: "fixed" | "starting_from" | "range" | "inquiry";
};

async function schoolDto(
  database: AppDatabase,
  row: Row,
  today: string,
  admin = false,
  offerFilter: OfferSummaryFilter = {},
) {
  const related = await schoolRelations(database, String(row.id));
  const trainingClasses = (admin ? related.trainingClasses : related.trainingClasses.filter((item) => bool(item.is_active)))
    .map((item) => trainingClassDto(item, admin));
  const publicOfferRows = related.offers.filter((item) =>
    bool(item.is_active)
    && offerMatchesCapabilities(item, related.trainingClasses));
  const offers = (admin ? related.offers : publicOfferRows)
    .map(offerDto);
  const matchesOfferSummary = (offer: Row) =>
    (!offerFilter.licenseClassCode || String(offer.license_class_code) === offerFilter.licenseClassCode)
    && (!offerFilter.applicationMode || jsonArray(offer.application_modes_json).includes(offerFilter.applicationMode))
    && (!offerFilter.priceType || String(offer.price_type) === offerFilter.priceType);
  const validMatchingOffers = publicOfferRows.filter(matchesOfferSummary);
  const validPrices = validMatchingOffers.filter((offer) => offer.min_price_fen != null);
  const startingPriceFen = validPrices.length
    ? Math.min(...validPrices.map((offer) => Number(offer.min_price_fen)))
    : null;
  const offerUpdatedAt = validMatchingOffers.reduce<string | null>((latest, offer) => {
    const value = String(offer.updated_at);
    return latest == null || value > latest ? value : latest;
  }, null);
  const cover = related.images.find((image) => bool(image.is_cover)) ?? related.images[0] ?? null;
  const dataKind = String(row.data_kind) as "demo" | "real";
  const activeTrainingClassCount = related.trainingClasses.filter((item) => bool(item.is_active)).length;
  const capabilityLevel = dataKind === "demo"
    ? capabilityLevelForClassCount(activeTrainingClassCount)
    : normalizeCapabilityLevel(row.capability_level);
  const inquiryAvailable = bool(related.recipient?.is_active)
    && (dataKind === "demo"
      ? bool(related.recipient?.is_synthetic)
      : !bool(related.recipient?.is_synthetic) && drivingSchoolInquiryRealConfigurationReady());
  const result: Record<string, unknown> = {
    id: String(row.id),
    name: String(row.name),
    legalName: row.legal_name == null ? null : String(row.legal_name),
    description: String(row.description ?? ""),
    dataKind,
    isDemo: dataKind === "demo",
    district: String(row.district),
    address: String(row.address),
    location: {
      poiId: String(row.map_poi_id), title: String(row.location_title), address: String(row.address),
      district: String(row.district), latitude: Number(row.latitude), longitude: Number(row.longitude),
      source: String(row.location_source),
    },
    publicPhone: row.public_phone == null ? null : String(row.public_phone),
    coverImage: cover ? imageDto(cover) : null,
    images: related.images.map(imageDto),
    tags: jsonArray(row.tags_json),
    facilities: jsonArray(row.facilities_json),
    openHours: String(row.open_hours ?? ""),
    regulatory: {
      type: String(row.regulatory_type), number: String(row.regulatory_number),
      authority: String(row.regulatory_authority),
      sourceUrl: row.regulatory_source_url == null ? null : String(row.regulatory_source_url),
      sourceLabel: String(row.regulatory_source_label),
      validFrom: row.regulatory_valid_from == null ? null : String(row.regulatory_valid_from),
      validUntil: row.regulatory_valid_until == null ? null : String(row.regulatory_valid_until),
      verifiedAt: row.regulatory_verified_at == null ? null : String(row.regulatory_verified_at),
      status: String(row.regulatory_status),
      capabilityLevel,
    },
    trainingClasses,
    offers,
    startingPriceFen,
    offerUpdatedAt,
    inquiryAvailable,
    isActive: bool(row.is_active),
    isPublished: bool(row.is_published),
    sortPriority: Number(row.sort_priority),
    publishedAt: row.published_at == null ? null : String(row.published_at),
    updatedAt: String(row.updated_at),
  };
  if (admin) {
    result.weeklySchedule = jsonObject(row.weekly_schedule_json);
    result.internalContact = row.internal_contact_name == null && row.internal_contact_phone == null
      ? null
      : { name: row.internal_contact_name, phone: row.internal_contact_phone };
    result.inquiryRecipient = related.recipient
      ? {
          recipientName: String(related.recipient.recipient_name),
          dataScope: jsonArray(related.recipient.data_scope_json),
          purpose: String(related.recipient.purpose),
          retention: String(related.recipient.retention_text),
          consentText: String(related.recipient.consent_text),
          contactEtaText: String(related.recipient.contact_eta_text),
          version: String(related.recipient.disclosure_version),
          active: bool(related.recipient.is_active),
          synthetic: bool(related.recipient.is_synthetic),
        }
      : null;
  }
  return result;
}

function parseConfiguredDataKey(): Buffer | null {
  const value = process.env.DRIVING_SCHOOL_INQUIRY_DATA_KEY?.trim();
  if (!value) return null;
  if (/^[a-f0-9]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function drivingSchoolInquiryRealConfigurationReady(): boolean {
  let https = false;
  try {
    https = new URL(process.env.DRIVING_SCHOOL_INQUIRY_PUBLIC_BASE_URL ?? "").protocol === "https:";
  } catch {
    https = false;
  }
  return process.env.DRIVING_SCHOOL_INQUIRY_REAL_MODE === "true"
    && https
    && parseConfiguredDataKey() !== null
    && (process.env.DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY?.trim().length ?? 0) >= 32
    && configuredInquiryKeysAreDistinct()
    && process.env.DRIVING_SCHOOL_INQUIRY_ADMIN_NETWORK_RESTRICTED === "true"
    && configuredAdminOrigins() !== null;
}

function dataKey(mode: InquiryMode): Buffer {
  return mode === "real" ? parseConfiguredDataKey() ?? DEMO_DATA_KEY : DEMO_DATA_KEY;
}

function phoneKey(mode: InquiryMode): string {
  return mode === "real" ? process.env.DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY!.trim() : DEMO_PHONE_HMAC_KEY;
}

function configuredAdminOrigins(): string[] | null {
  const values = (process.env.DRIVING_SCHOOL_INQUIRY_ADMIN_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return null;
  const origins: string[] = [];
  for (const value of values) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
      origins.push(parsed.origin);
    } catch {
      return null;
    }
  }
  return [...new Set(origins)];
}

function configuredInquiryKeysAreDistinct(): boolean {
  const dataValue = process.env.DRIVING_SCHOOL_INQUIRY_DATA_KEY?.trim() ?? "";
  const phoneValue = process.env.DRIVING_SCHOOL_INQUIRY_PHONE_HMAC_KEY?.trim() ?? "";
  if (!dataValue || !phoneValue || dataValue === phoneValue) return false;
  const parsedData = parseConfiguredDataKey();
  return parsedData != null && !parsedData.equals(Buffer.from(phoneValue, "utf8"));
}

function assertDrivingSchoolAdminBoundary(
  request: FastifyRequest,
  problem: ProblemFactory,
  requiresRealProtection: boolean,
): void {
  if (!requiresRealProtection) return;
  const allowed = configuredAdminOrigins();
  if (!drivingSchoolInquiryRealConfigurationReady() || !allowed) {
    throw problem(503, "DRIVING_SCHOOL_ADMIN_BOUNDARY_NOT_CONFIGURED", "真实咨询后台的隐私密钥、来源白名单或网络隔离尚未完整配置");
  }
  const source = typeof request.headers.origin === "string"
    ? request.headers.origin
    : typeof request.headers.referer === "string" ? request.headers.referer : "";
  let origin = "";
  try { origin = new URL(source).origin; } catch { origin = ""; }
  if (!origin || !allowed.includes(origin)) {
    throw problem(403, "DRIVING_SCHOOL_ADMIN_ORIGIN_FORBIDDEN", "当前来源不能访问真实咨询后台");
  }
}

function inquiryMode(school: Row, recipient: Row, problem: ProblemFactory): InquiryMode {
  if (String(school.data_kind) === "demo") return "demo";
  if (!drivingSchoolInquiryRealConfigurationReady() || bool(recipient.is_synthetic)) {
    throw problem(503, "DRIVING_SCHOOL_INQUIRY_NOT_CONFIGURED", "该真实机构的咨询接收环境尚未完成安全配置");
  }
  return "real";
}

function encryptContact(value: Record<string, unknown>, mode: InquiryMode): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(mode), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", mode, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptContact(value: unknown): Record<string, string> | null {
  if (!value) return null;
  const [version, mode, iv, tag, ciphertext] = String(value).split(".");
  if (version !== "v1" || (mode !== "demo" && mode !== "real") || !iv || !tag || !ciphertext) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey(mode), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item ?? "")])) as Record<string, string>;
  } catch {
    return null;
  }
}

function phoneHmac(phone: string, mode: InquiryMode): string {
  return createHmac("sha256", phoneKey(mode)).update(phone).digest("hex");
}

function requestBodyHmac(value: unknown, mode: InquiryMode): string {
  const digest = createHmac("sha256", dataKey(mode))
    .update("yuxiaoman-driving-school-idempotency-request-v1")
    .update("\0")
    .update(stableJson(value))
    .digest("hex");
  return `hmac-v1:${digest}`;
}

function requestHashMatches(stored: unknown, expected: string): boolean {
  // Legacy unsalted hashes are migrated to NULL. The old receipt remains
  // idempotently retrievable, but its historical request body is unverifiable.
  if (stored == null) return true;
  const actualBuffer = Buffer.from(String(stored));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function maskName(name: string): string {
  return name.length === 1 ? `${name}*` : `${name.slice(0, 1)}${"*".repeat(Math.min(2, name.length - 1))}`;
}

function inquiryCode(now: Date): string {
  return `YXM-DS-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function withdrawToken(id: string, mode: InquiryMode): string {
  const encoded = Buffer.from(id).toString("base64url");
  const signature = createHmac("sha256", dataKey(mode)).update("yuxiaoman-driving-school-withdraw-v1\0").update(id).digest("base64url");
  return `${encoded}.${signature}`;
}

function parseWithdrawToken(token: string): { id: string; mode: InquiryMode } | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  let id: string;
  try { id = Buffer.from(encoded, "base64url").toString("utf8"); } catch { return null; }
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return null;
  for (const mode of ["demo", "real"] as const) {
    if (mode === "real" && !parseConfiguredDataKey()) continue;
    const expected = createHmac("sha256", dataKey(mode)).update("yuxiaoman-driving-school-withdraw-v1\0").update(id).digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)) return { id, mode };
  }
  return null;
}

function withdrawTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function insertInquiryEvent(
  database: AppDatabase,
  inquiryId: string,
  action: string,
  actorType: ActorType,
  detail: Record<string, unknown> = {},
  now = new Date(),
): Promise<void> {
  await database.prepare(`
    INSERT INTO driving_school_inquiry_events (
      id, inquiry_id, action, actor_type, detail_json, created_at, delete_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), inquiryId, action, actorType, JSON.stringify(detail), now.toISOString(), addDays(now, 365));
}

export async function cleanupDrivingSchoolInquiryData(database: AppDatabase, now = new Date()): Promise<void> {
  await database.prepare(`
    UPDATE driving_school_inquiries SET
      contact_ciphertext = NULL, phone_hmac = NULL, internal_note = NULL,
      contact_name_masked = NULL, masked_phone = NULL, request_hash = NULL,
      pii_purged_at = ?, updated_at = ?
    WHERE pii_delete_after IS NOT NULL AND pii_delete_after <= ? AND pii_purged_at IS NULL
  `).run(now.toISOString(), now.toISOString(), now.toISOString());
  await database.prepare("DELETE FROM driving_school_inquiry_events WHERE delete_after <= ?").run(now.toISOString());
}

function inquiryReceipt(row: Row, duplicate: boolean, school: Row, recipient: Row) {
  const mode = bool(row.is_synthetic) ? "demo" : "real";
  const snapshot = jsonObject(row.school_snapshot_json);
  return {
    inquiryCode: String(row.inquiry_code),
    school: { id: String(row.school_id), name: String(snapshot.name ?? school.name) },
    licenseClassCode: String(row.license_class_code),
    applicationMode: String(row.application_mode),
    maskedPhone: row.masked_phone == null ? null : String(row.masked_phone),
    contactNameMasked: row.contact_name_masked == null ? null : String(row.contact_name_masked),
    contactEtaText: String(jsonObject(row.consent_snapshot_json).contactEtaText ?? recipient.contact_eta_text),
    withdrawToken: withdrawToken(String(row.id), mode),
    duplicate,
    status: String(row.status),
    submittedAt: String(row.submitted_at),
  };
}

async function inquiryListItem(database: AppDatabase, row: Row) {
  const school = await database.prepare<Row>("SELECT name FROM driving_schools WHERE id = ?").get(String(row.school_id));
  return {
    id: String(row.id), inquiryCode: String(row.inquiry_code), status: String(row.status),
    school: { id: String(row.school_id), name: String(school?.name ?? "") },
    licenseClassCode: String(row.license_class_code), applicationMode: String(row.application_mode),
    contactNameMasked: row.contact_name_masked == null ? null : String(row.contact_name_masked),
    maskedPhone: row.masked_phone == null ? null : String(row.masked_phone),
    contactWindow: String(row.contact_window), internalNote: row.internal_note == null ? null : String(row.internal_note),
    isSynthetic: bool(row.is_synthetic), submittedAt: String(row.submitted_at), updatedAt: String(row.updated_at),
  };
}

async function inquiryDetail(database: AppDatabase, row: Row) {
  const [base, events] = await Promise.all([
    inquiryListItem(database, row),
    database.prepare<Row>(`
      SELECT * FROM driving_school_inquiry_events WHERE inquiry_id = ? ORDER BY created_at ASC, id ASC
    `).all(String(row.id)),
  ]);
  const contact = String(row.status) === "withdrawn" ? null : decryptContact(row.contact_ciphertext);
  return {
    ...base,
    contact: String(row.status) === "withdrawn"
      ? null
      : contact ?? { name: "已按留存策略清除", phone: "已按留存策略清除", message: "" },
    disclosure: jsonObject(row.consent_snapshot_json),
    offerId: row.offer_id == null ? null : String(row.offer_id),
    contactingAt: row.contacting_at == null ? null : String(row.contacting_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    withdrawnAt: row.withdrawn_at == null ? null : String(row.withdrawn_at),
    piiPurgedAt: row.pii_purged_at == null ? null : String(row.pii_purged_at),
    events: events.map((event) => ({
      id: String(event.id), action: String(event.action), actorType: String(event.actor_type),
      detail: jsonObject(event.detail_json), createdAt: String(event.created_at),
    })),
  };
}

async function upsertRecipient(
  database: AppDatabase,
  school: { id: string; name: string; dataKind: "demo" | "real" },
  recipient: z.infer<typeof inquiryRecipientSchema>,
  nowIso: string,
): Promise<void> {
  if (school.dataKind === "demo" && !recipient.synthetic) {
    throw new Error("Demo driving-school recipient must remain synthetic");
  }
  const version = computeDrivingSchoolDisclosureVersion({
    schoolId: school.id, schoolName: school.name, recipientName: recipient.recipientName,
    dataScope: recipient.dataScope, purpose: recipient.purpose, retentionText: recipient.retention,
    consentText: recipient.consentText, contactEtaText: recipient.contactEtaText,
  });
  await database.prepare(`
    INSERT INTO driving_school_inquiry_recipients (
      school_id, recipient_name, data_scope_json, purpose, retention_text, consent_text,
      contact_eta_text, disclosure_version, is_active, is_synthetic, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (school_id) DO UPDATE SET
      recipient_name = excluded.recipient_name, data_scope_json = excluded.data_scope_json,
      purpose = excluded.purpose, retention_text = excluded.retention_text,
      consent_text = excluded.consent_text, contact_eta_text = excluded.contact_eta_text,
      disclosure_version = excluded.disclosure_version, is_active = excluded.is_active,
      is_synthetic = excluded.is_synthetic, updated_at = excluded.updated_at
  `).run(
    school.id, recipient.recipientName, JSON.stringify(recipient.dataScope), recipient.purpose,
    recipient.retention, recipient.consentText, recipient.contactEtaText, version,
    recipient.active ? 1 : 0, recipient.synthetic ? 1 : 0, nowIso, nowIso,
  );
}

function assertVerifiedLocation(
  location: z.infer<typeof locationSchema>,
  dataKind: "demo" | "real",
  options: DrivingSchoolRouteOptions,
): void {
  const production = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
  if (production && (dataKind === "real" || location.source === "demo") && location.source === "demo") {
    throw options.problem(409, "DRIVING_SCHOOL_LOCATION_PROOF_INVALID", "真实机构不能使用演示地址，请重新选择位置");
  }
  if (!location.locationProof || !options.validLocationProof(location)) {
    throw options.problem(409, "DRIVING_SCHOOL_LOCATION_PROOF_INVALID", "位置凭证无效或已过期，请重新搜索并选择地址");
  }
}

async function requireSchool(database: AppDatabase, id: string, problem: ProblemFactory, publicOnly = false): Promise<Row> {
  const row = await database.prepare<Row>(`
    SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL
      ${publicOnly ? "AND is_active = 1 AND is_published = 1" : ""}
  `).get(id);
  if (!row) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
  return row;
}

function publicRegulatoryValid(school: Row, at: Date): boolean {
  const today = currentDate(at);
  return String(school.data_kind) === "demo"
    || (school.legal_name != null && String(school.legal_name).trim().length > 0
      && String(school.location_source) !== "demo"
      && school.regulatory_source_url != null
      && String(school.regulatory_status) === "verified"
      && school.regulatory_verified_at != null
      && String(school.regulatory_verified_at) <= at.toISOString()
      && school.regulatory_valid_from != null
      && String(school.regulatory_valid_from) <= today
      && school.regulatory_valid_until != null
      && String(school.regulatory_valid_until) >= today);
}

function assertPublicRegulatoryValid(school: Row, at: Date, problem: ProblemFactory): void {
  if (!publicRegulatoryValid(school, at)) {
    throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
  }
}

async function assertOfferCapability(
  database: AppDatabase,
  schoolId: string,
  licenseClassCode: string,
  applicationModes: string[],
  problem: ProblemFactory,
): Promise<void> {
  const [catalog, capability] = await Promise.all([
    database.prepare<Row>("SELECT * FROM driving_license_classes WHERE code = ? AND is_active = 1").get(licenseClassCode),
    database.prepare<Row>(`
      SELECT * FROM driving_school_training_classes
      WHERE school_id = ? AND license_class_code = ? AND is_active = 1
    `).get(schoolId, licenseClassCode),
  ]);
  if (!catalog || !capability) {
    throw problem(409, "DRIVING_SCHOOL_OFFER_CAPABILITY_REQUIRED", "请先启用对应准驾车型的培训能力");
  }
  if (applicationModes.includes("initial") && (!bool(catalog.initial_allowed) || !bool(capability.initial_available))) {
    throw problem(409, "DRIVING_SCHOOL_OFFER_MODE_UNAVAILABLE", `${licenseClassCode} 不支持该初次申领报价`);
  }
  if (applicationModes.includes("upgrade") && !bool(capability.upgrade_available)) {
    throw problem(409, "DRIVING_SCHOOL_OFFER_MODE_UNAVAILABLE", `${licenseClassCode} 不支持该增驾报价`);
  }
}

const alignedPublicOfferCapabilitySql = `EXISTS (
  SELECT 1
  FROM driving_school_training_classes otc
  JOIN driving_license_classes olc ON olc.code = otc.license_class_code AND olc.is_active = 1
  WHERE otc.school_id = po.school_id
    AND otc.license_class_code = po.license_class_code
    AND otc.is_active = 1
    AND (
      po.application_modes_json LIKE '%"initial"%'
      OR po.application_modes_json LIKE '%"upgrade"%'
    )
    AND (
      po.application_modes_json NOT LIKE '%"initial"%'
      OR (otc.initial_available = 1 AND olc.initial_allowed = 1)
    )
    AND (
      po.application_modes_json NOT LIKE '%"upgrade"%'
      OR (otc.upgrade_available = 1 AND olc.upgrade_allowed = 1)
    )
)`;

async function lockTrainingOfferPairs(
  database: AppDatabase,
  pairs: Array<{ schoolId: string; licenseClassCode: string }>,
): Promise<void> {
  const locks = [...new Set(pairs.map((pair) =>
    `driving-school-training-offer:${pair.schoolId}:${pair.licenseClassCode}`))].sort();
  for (const lock of locks) {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(lock);
  }
}

async function assertTrainingChangeCompatible(
  database: AppDatabase,
  schoolId: string,
  licenseClassCode: string,
  modes: string[],
  active: boolean,
  problem: ProblemFactory,
): Promise<void> {
  const activeOffers = await database.prepare<Row>(`
    SELECT id, application_modes_json
    FROM driving_school_offers
    WHERE school_id = ? AND license_class_code = ? AND is_active = 1
  `).all(schoolId, licenseClassCode);
  const incompatible = activeOffers.filter((offer) =>
    !active || jsonArray(offer.application_modes_json).some((mode) => !modes.includes(mode)));
  if (incompatible.length > 0) {
    throw problem(
      409,
      "DRIVING_SCHOOL_TRAINING_CLASS_IN_USE",
      "该培训能力仍被启用中的报价使用，请先停用或调整相关报价",
      { offerIds: incompatible.map((offer) => String(offer.id)).join("、") },
    );
  }
}

async function syncDemoCapabilityLevel(
  database: AppDatabase,
  schoolId: string,
  at: Date,
): Promise<void> {
  const countRow = await database.prepare<Row>(`
    SELECT COUNT(*) AS count FROM driving_school_training_classes
    WHERE school_id = ? AND is_active = 1
  `).get(schoolId);
  const level = capabilityLevelForClassCount(Number(countRow?.count ?? 0));
  await database.prepare(`
    UPDATE driving_schools SET capability_level = ?, updated_at = ?
    WHERE id = ? AND data_kind = 'demo'
  `).run(level, at.toISOString(), schoolId);
}

type DrivingSchoolPreviewChecklistItem = {
  key: string;
  label: string;
  status: "pass" | "fail" | "warning";
  section: "base" | "training" | "offers" | "media" | "preview";
  message: string;
};

function requiredChecklistItem(
  key: string,
  label: string,
  section: DrivingSchoolPreviewChecklistItem["section"],
  passed: boolean,
  passedMessage: string,
  failedMessage: string,
): DrivingSchoolPreviewChecklistItem {
  return { key, label, section, status: passed ? "pass" : "fail", message: passed ? passedMessage : failedMessage };
}

async function schoolPublishChecklist(
  database: AppDatabase,
  school: Row,
  at: Date,
): Promise<DrivingSchoolPreviewChecklistItem[]> {
  const schoolId = String(school.id);
  const today = currentDate(at);
  const [cover, capabilityCountRow, alignedOffer, recipient, legacyDatedOffer] = await Promise.all([
    database.prepare<Row>("SELECT 1 FROM driving_school_images WHERE school_id = ? AND is_cover = 1").get(schoolId),
    database.prepare<Row>(`
      SELECT COUNT(*) AS count FROM driving_school_training_classes
      WHERE school_id = ? AND is_active = 1
    `).get(schoolId),
    database.prepare<Row>(`
      SELECT 1 FROM driving_school_offers po
      WHERE po.school_id = ? AND po.is_active = 1
        AND ${alignedPublicOfferCapabilitySql}
      LIMIT 1
    `).get(schoolId),
    database.prepare<Row>(`
      SELECT * FROM driving_school_inquiry_recipients
      WHERE school_id = ? AND is_active = 1
    `).get(schoolId),
    database.prepare<Row>(`
      SELECT 1 FROM driving_school_offers
      WHERE school_id = ? AND (valid_from IS NOT NULL OR valid_until IS NOT NULL)
      LIMIT 1
    `).get(schoolId),
  ]);
  const capabilityCount = Number(capabilityCountRow?.count ?? 0);
  const expectedCapabilityLevel = capabilityLevelForClassCount(capabilityCount);
  const storedCapabilityLevel = normalizeCapabilityLevel(school.capability_level);
  const dataKind = String(school.data_kind);
  const effectiveCapabilityLevel = dataKind === "demo" ? expectedCapabilityLevel : storedCapabilityLevel;
  const capabilityMatches = expectedCapabilityLevel != null
    && effectiveCapabilityLevel === expectedCapabilityLevel;
  const levelText = expectedCapabilityLevel === "level_1" ? "一级" : expectedCapabilityLevel === "level_2" ? "二级" : "三级";
  const checklist: DrivingSchoolPreviewChecklistItem[] = [
    requiredChecklistItem("school_active", "机构启用", "base", bool(school.is_active), "机构已启用", "机构未启用"),
    requiredChecklistItem("public_phone", "公开联系电话", "base", Boolean(school.public_phone), "已维护公开招生电话", "缺少公开联系电话"),
    requiredChecklistItem("verified_location", "已校验位置", "base", Boolean(school.map_poi_id), "已保存可信位置", "缺少已校验位置"),
    requiredChecklistItem("cover_image", "封面图", "media", Boolean(cover), "已设置封面图", "缺少封面图"),
    requiredChecklistItem("training_class", "可培训车型", "training", capabilityCount > 0, `已启用 ${capabilityCount} 类车型`, "缺少可培训车型"),
    requiredChecklistItem(
      "capability_level",
      "机构培训能力等级",
      "training",
      capabilityMatches,
      dataKind === "demo" ? `已按 ${capabilityCount} 类车型派生为${levelText}` : `备案等级与 ${capabilityCount} 类车型一致`,
      expectedCapabilityLevel == null
        ? "至少启用 1 类车型后才能确定机构等级"
        : `备案等级应为${levelText}（当前启用 ${capabilityCount} 类车型）`,
    ),
    requiredChecklistItem("aligned_offer", "匹配报价", "offers", Boolean(alignedOffer), "存在与车型和报名方式匹配的启用报价", "缺少与培训车型及报名方式一致的启用报价"),
    requiredChecklistItem("inquiry_recipient", "咨询接收配置", "preview", Boolean(recipient), "咨询接收与披露配置已启用", "缺少咨询接收与披露配置"),
  ];
  if (legacyDatedOffer) {
    checklist.push({
      key: "legacy_offer_dates_ignored",
      label: "历史报价日期",
      section: "offers",
      status: "warning",
      message: "历史有效期字段仅为兼容数据，不再影响公开、最低价、发布或咨询",
    });
  }
  if (dataKind === "demo") {
    checklist.push(requiredChecklistItem(
      "demo_recipient_synthetic", "演示咨询配置", "preview",
      !recipient || bool(recipient.is_synthetic),
      "演示机构仅使用合成咨询配置", "演示机构必须使用合成咨询接收配置",
    ));
  } else {
    checklist.push(
      requiredChecklistItem("real_legal_name", "真实机构法定名称", "base", Boolean(school.legal_name && String(school.legal_name).trim()), "已维护法定名称", "缺少真实机构法定名称"),
      requiredChecklistItem("real_location", "真实位置来源", "base", String(school.location_source) !== "demo", "位置来自可信候选", "真实机构不能使用演示位置"),
      requiredChecklistItem("real_regulatory_status", "监管资料核验状态", "training", String(school.regulatory_status) === "verified", "监管资料已核验", "监管资料核验状态不是 verified"),
      requiredChecklistItem("real_regulatory_source", "监管来源链接", "training", Boolean(school.regulatory_source_url), "已记录监管来源链接", "缺少监管来源链接"),
      requiredChecklistItem("real_regulatory_valid_from", "资质起始日期", "training", Boolean(school.regulatory_valid_from) && String(school.regulatory_valid_from) <= today, "资质起始日期当前有效", "缺少当前有效的资质起始日期"),
      requiredChecklistItem("real_regulatory_valid_until", "资质截止日期", "training", Boolean(school.regulatory_valid_until) && String(school.regulatory_valid_until) >= today, "资质截止日期当前有效", "缺少当前有效的资质截止日期"),
      requiredChecklistItem("real_verified_at", "核验时间", "training", Boolean(school.regulatory_verified_at) && String(school.regulatory_verified_at) <= at.toISOString(), "核验时间有效且非未来", "缺少有效且非未来的核验时间"),
      requiredChecklistItem("real_recipient", "真实咨询接收配置", "preview", Boolean(recipient) && !bool(recipient?.is_synthetic), "已配置真实咨询接收方", "真实机构不能使用合成咨询接收配置"),
      requiredChecklistItem("production_privacy", "生产隐私配置", "preview", drivingSchoolInquiryRealConfigurationReady(), "生产隐私配置完整", "生产隐私配置未满足 fail-closed 要求"),
    );
  }
  return checklist;
}

async function schoolPublishMissing(database: AppDatabase, school: Row, at: Date): Promise<string[]> {
  return (await schoolPublishChecklist(database, school, at))
    .filter((item) => item.status === "fail")
    .map((item) => item.message);
}

async function drivingSchoolSavedAt(database: AppDatabase, school: Row): Promise<string> {
  const row = await database.prepare<Row>(`
    SELECT MAX(updated_at) AS updated_at FROM (
      SELECT updated_at FROM driving_schools WHERE id = ?
      UNION ALL SELECT updated_at FROM driving_school_images WHERE school_id = ?
      UNION ALL SELECT updated_at FROM driving_school_training_classes WHERE school_id = ?
      UNION ALL SELECT updated_at FROM driving_school_offers WHERE school_id = ?
      UNION ALL SELECT updated_at FROM driving_school_inquiry_recipients WHERE school_id = ?
    ) saved_rows
  `).get(String(school.id), String(school.id), String(school.id), String(school.id), String(school.id));
  return String(row?.updated_at ?? school.updated_at);
}

async function drivingSchoolOfferMappings(database: AppDatabase, schoolId: string) {
  const related = await schoolRelations(database, schoolId);
  return related.offers.map((offer) => {
    const active = bool(offer.is_active);
    const capability = related.trainingClasses.find((item) =>
      String(item.license_class_code) === String(offer.license_class_code));
    const mappingMatches = Boolean(capability
      && capabilitySupportsModes(capability, jsonArray(offer.application_modes_json)));
    const detailVisible = active && mappingMatches;
    const listMinimumCandidate = detailVisible && offer.min_price_fen != null;
    const reasons: string[] = [];
    if (!active) reasons.push("报价未启用");
    if (!capability || !bool(capability.is_active)) reasons.push("对应培训车型未启用");
    else if (!mappingMatches) reasons.push("报价报名方式与培训能力不匹配");
    if (detailVisible && offer.min_price_fen == null) reasons.push("面议报价不参与列表最低价");
    if (offer.valid_from != null || offer.valid_until != null) reasons.push("历史有效期字段已忽略");
    return {
      offerId: String(offer.id),
      listMinimumCandidate,
      detailVisible,
      inquirySelectable: detailVisible,
      reasons,
    };
  });
}

async function autoUnpublishIfInvalid(
  database: AppDatabase,
  schoolId: string,
  at: Date,
): Promise<string[]> {
  const school = await database.prepare<Row>(`
    SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
  `).get(schoolId);
  if (!school || !bool(school.is_published)) return [];
  const missing = await schoolPublishMissing(database, school, at);
  if (missing.length > 0) {
    await database.prepare(`
      UPDATE driving_schools
      SET is_published = 0, published_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(at.toISOString(), schoolId);
  }
  return missing;
}

function pagination(query: { page?: string; pageSize?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? "20", 10) || 20));
  return { page, pageSize };
}

export async function registerDrivingSchoolRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: DrivingSchoolRouteOptions,
): Promise<void> {
  const problem = options.problem;
  const now = options.now ?? (() => new Date());
  await cleanupDrivingSchoolInquiryData(database, now());

  let cleanupStartedAt = Date.now();
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/driving-school") && !request.url.startsWith("/api/admin/driving-school")) return;
    if (Date.now() - cleanupStartedAt < 15 * 60_000) return;
    cleanupStartedAt = Date.now();
    await cleanupDrivingSchoolInquiryData(database, now()).catch((error: unknown) => {
      app.log.error({ error }, "driving-school inquiry retention cleanup failed");
    });
  });

  app.get("/api/driving-schools/meta", async () => {
    const at = now();
    const today = currentDate(at);
    const classes = await database.prepare<Row>(`
      SELECT * FROM driving_license_classes WHERE is_active = 1 ORDER BY sort_order ASC
    `).all();
    const districts = await database.prepare<Row>(`
      SELECT DISTINCT district FROM driving_schools
      WHERE is_active = 1 AND is_published = 1 AND deleted_at IS NULL
        AND (data_kind = 'demo' OR (
          legal_name IS NOT NULL AND BTRIM(legal_name) <> ''
          AND location_source <> 'demo' AND regulatory_source_url IS NOT NULL
          AND regulatory_status = 'verified' AND regulatory_verified_at IS NOT NULL
          AND regulatory_verified_at <= ?
          AND regulatory_valid_from IS NOT NULL AND regulatory_valid_from <= ?
          AND regulatory_valid_until >= ?
        ))
      ORDER BY district ASC
    `).all(at.toISOString(), today, today);
    return {
      data: {
        licenseClasses: classes.map(classDto),
        districts: districts.map((row) => String(row.district)),
        regulatoryTypes: ["filing", "legacy_license"],
        priceTypes: ["fixed", "starting_from", "range", "inquiry"],
        applicationModes: ["initial", "upgrade"],
        sortOptions: ["recommended", "price_asc", "updated"],
        trainingCapabilityNotice: "培训能力等级仅描述备案或可培训范围，不是教学质量、通过率或推荐排序。",
        eligibilityNotice: "准驾车型条件仅作办事引导；年龄、驾龄、记分和身体条件以办理时现行规则及主管部门审核为准。",
        dataNotice: "标记为演示的机构、资质、场地与价格均为合成数据。",
      },
    };
  });

  app.get<{
    Querystring: {
      page?: string; pageSize?: string; district?: string; licenseClassCode?: string;
      trainingMode?: string; priceType?: string; regulatoryType?: string; q?: string; sort?: string;
    };
  }>("/api/driving-schools", async (request) => {
    const { page, pageSize } = pagination(request.query);
    const at = now();
    const today = currentDate(at);
    const where = [
      "s.is_active = 1", "s.is_published = 1", "s.deleted_at IS NULL",
      `(s.data_kind = 'demo' OR (
        s.legal_name IS NOT NULL AND BTRIM(s.legal_name) <> ''
        AND s.location_source <> 'demo' AND s.regulatory_source_url IS NOT NULL
        AND s.regulatory_status = 'verified' AND s.regulatory_verified_at IS NOT NULL
        AND s.regulatory_verified_at <= ?
        AND s.regulatory_valid_from IS NOT NULL AND s.regulatory_valid_from <= ?
        AND s.regulatory_valid_until >= ?
      ))`,
    ];
    const values: DatabaseValue[] = [];
    values.push(at.toISOString(), today, today);
    const code = request.query.licenseClassCode?.trim();
    if (code && !licenseClassSchema.safeParse(code).success) throw problem(400, "INVALID_LICENSE_CLASS", "准驾车型筛选无效");
    const mode = request.query.trainingMode?.trim();
    if (mode && !applicationModeSchema.safeParse(mode).success) throw problem(400, "INVALID_TRAINING_MODE", "报名方式筛选无效");
    if (request.query.district?.trim()) { where.push("s.district = ?"); values.push(request.query.district.trim()); }
    if (request.query.regulatoryType?.trim()) {
      const parsed = regulatoryTypeSchema.safeParse(request.query.regulatoryType.trim());
      if (!parsed.success) throw problem(400, "INVALID_REGULATORY_TYPE", "资质类型筛选无效");
      where.push("s.regulatory_type = ?"); values.push(parsed.data);
    }
    if (request.query.q?.trim()) {
      where.push("(s.name ILIKE ? OR s.legal_name ILIKE ? OR s.address ILIKE ? OR s.location_title ILIKE ?)");
      const q = `%${request.query.q.trim()}%`; values.push(q, q, q, q);
    }
    if (code || mode) {
      const clauses = ["tc.school_id = s.id", "tc.is_active = 1"];
      if (code) { clauses.push("tc.license_class_code = ?"); values.push(code); }
      if (mode === "initial") clauses.push("tc.initial_available = 1");
      if (mode === "upgrade") clauses.push("tc.upgrade_available = 1");
      where.push(`EXISTS (SELECT 1 FROM driving_school_training_classes tc WHERE ${clauses.join(" AND ")})`);
    }
    let selectedPriceType: z.infer<typeof priceTypeSchema> | undefined;
    if (request.query.priceType?.trim()) {
      const parsed = priceTypeSchema.safeParse(request.query.priceType.trim());
      if (!parsed.success) throw problem(400, "INVALID_PRICE_TYPE", "报价类型筛选无效");
      selectedPriceType = parsed.data;
      const offerClauses = [
        "po.school_id = s.id", "po.is_active = 1", "po.price_type = ?",
        alignedPublicOfferCapabilitySql,
      ];
      const offerValues: DatabaseValue[] = [parsed.data];
      if (code) { offerClauses.push("po.license_class_code = ?"); offerValues.push(code); }
      if (mode) { offerClauses.push("po.application_modes_json LIKE ?"); offerValues.push(`%\"${mode}\"%`); }
      where.push(`EXISTS (
        SELECT 1 FROM driving_school_offers po WHERE ${offerClauses.join(" AND ")}
      )`);
      values.push(...offerValues);
    }
    const sort = request.query.sort === "price" ? "price_asc" : (request.query.sort ?? "recommended");
    if (!["recommended", "price_asc", "updated"].includes(sort)) throw problem(400, "INVALID_SORT", "排序方式无效");
    const priceFilterSql = [
      code ? `AND po.license_class_code = '${code}'` : "",
      mode ? `AND po.application_modes_json LIKE '%\"${mode}\"%'` : "",
      selectedPriceType ? `AND po.price_type = '${selectedPriceType}'` : "",
    ].filter(Boolean).join(" ");
    const priceExpression = `(SELECT MIN(po.min_price_fen) FROM driving_school_offers po
      WHERE po.school_id = s.id AND po.is_active = 1 AND po.min_price_fen IS NOT NULL
        AND ${alignedPublicOfferCapabilitySql} ${priceFilterSql})`;
    const offerUpdatedExpression = `(SELECT MAX(po.updated_at) FROM driving_school_offers po
      WHERE po.school_id = s.id AND po.is_active = 1
        AND ${alignedPublicOfferCapabilitySql} ${priceFilterSql})`;
    const orderBy = sort === "price_asc"
      ? `COALESCE(${priceExpression}, 2147483647) ASC, s.sort_priority DESC, s.updated_at DESC`
      : sort === "updated"
        ? `${offerUpdatedExpression} DESC NULLS LAST, s.sort_priority DESC, s.updated_at DESC`
        : "s.sort_priority DESC, s.updated_at DESC";
    const whereSql = where.join(" AND ");
    const count = await database.prepare<Row>(`SELECT COUNT(*) AS count FROM driving_schools s WHERE ${whereSql}`).get(...values);
    const total = Number(count?.count ?? 0);
    const rows = await database.prepare<Row>(`
      SELECT s.* FROM driving_schools s WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize);
    return {
      data: {
        items: await Promise.all(rows.map((row) => schoolDto(database, row, today, false, {
          ...(code ? { licenseClassCode: code } : {}),
          ...(mode ? { applicationMode: mode as "initial" | "upgrade" } : {}),
          ...(selectedPriceType ? { priceType: selectedPriceType } : {}),
        }))),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/driving-schools/:id", async (request) => {
    const school = await requireSchool(database, request.params.id, problem, true);
    const at = now();
    const today = currentDate(at);
    assertPublicRegulatoryValid(school, at, problem);
    return { data: await schoolDto(database, school, today) };
  });

  app.get<{ Querystring: { schoolId?: string } }>("/api/driving-school-inquiries/disclosure", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const schoolId = request.query.schoolId?.trim();
    if (!schoolId) throw problem(400, "SCHOOL_ID_REQUIRED", "请选择要咨询的驾校");
    const school = await requireSchool(database, schoolId, problem, true);
    assertPublicRegulatoryValid(school, now(), problem);
    const recipient = await database.prepare<Row>(`
      SELECT * FROM driving_school_inquiry_recipients WHERE school_id = ? AND is_active = 1
    `).get(schoolId);
    if (!recipient) throw problem(503, "DRIVING_SCHOOL_INQUIRY_UNAVAILABLE", "该驾校暂未开放咨询留资");
    const mode = inquiryMode(school, recipient, problem);
    return {
      data: {
        mode,
        acceptsRealData: mode === "real",
        version: String(recipient.disclosure_version),
        school: { id: String(school.id), name: String(school.name) },
        recipient: { name: String(recipient.recipient_name) },
        dataScope: jsonArray(recipient.data_scope_json), purpose: String(recipient.purpose),
        retention: String(recipient.retention_text), consentText: String(recipient.consent_text),
        contactEtaText: String(recipient.contact_eta_text),
      },
    };
  });

  app.post("/api/driving-school-inquiries", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 160) {
      throw problem(400, "IDEMPOTENCY_KEY_REQUIRED", "请提供 8 至 160 字符的 Idempotency-Key");
    }
    const body = parseBody(inquiryCreateSchema, request.body, problem);
    const school = await requireSchool(database, body.schoolId, problem, true);
    assertPublicRegulatoryValid(school, now(), problem);
    const recipient = await database.prepare<Row>(`
      SELECT * FROM driving_school_inquiry_recipients WHERE school_id = ? AND is_active = 1
    `).get(body.schoolId);
    if (!recipient) throw problem(503, "DRIVING_SCHOOL_INQUIRY_UNAVAILABLE", "该驾校暂未开放咨询留资");
    const mode = inquiryMode(school, recipient, problem);
    if (body.disclosureVersion !== String(recipient.disclosure_version)) {
      throw problem(409, "DISCLOSURE_VERSION_MISMATCH", "授权说明已更新，请重新阅读并确认");
    }
    if (mode === "demo" && (body.contactName !== "演示车主" || !DEMO_PHONES.has(body.contactPhone))) {
      throw problem(403, "REAL_DATA_NOT_ACCEPTED", "演示模式仅接受固定合成资料，请勿提交真实个人信息");
    }
    const capability = await database.prepare<Row>(`
      SELECT * FROM driving_school_training_classes
      WHERE school_id = ? AND license_class_code = ? AND is_active = 1
    `).get(body.schoolId, body.licenseClassCode);
    if (!capability || (body.applicationMode === "initial" && !bool(capability.initial_available))
      || (body.applicationMode === "upgrade" && !bool(capability.upgrade_available))) {
      throw problem(409, "TRAINING_CLASS_UNAVAILABLE", "该驾校暂不提供所选车型和报名方式");
    }
    if (body.offerId) {
      const offer = await database.prepare<Row>(`
        SELECT * FROM driving_school_offers WHERE id = ? AND school_id = ? AND license_class_code = ? AND is_active = 1
      `).get(body.offerId, body.schoolId, body.licenseClassCode);
      if (!offer
        || !jsonArray(offer.application_modes_json).includes(body.applicationMode)) {
        throw problem(409, "DRIVING_SCHOOL_OFFER_UNAVAILABLE", "所选报价不适用于本次咨询");
      }
    }
    const persistedMessage = mode === "demo" ? "" : body.message ?? "";
    const normalized = { ...body, message: persistedMessage, consentAccepted: true };
    const requestHash = requestBodyHmac(normalized, mode);
    const idempotencyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
    const phoneDigest = phoneHmac(body.contactPhone, mode);
    const since = new Date(now().getTime() - DAY_MS).toISOString();
    const findByKey = (tx: AppDatabase) => tx.prepare<Row>(`
      SELECT * FROM driving_school_inquiries WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, idempotencyDigest);
    const findRecent = (tx: AppDatabase) => tx.prepare<Row>(`
      SELECT * FROM driving_school_inquiries
      WHERE user_id = ? AND school_id = ? AND license_class_code = ? AND phone_hmac = ? AND submitted_at >= ?
      ORDER BY submitted_at DESC LIMIT 1
    `).get(userId, body.schoolId, body.licenseClassCode, phoneDigest, since);
    const existing = await findByKey(database);
    if (existing) {
      if (!requestHashMatches(existing.request_hash, requestHash)) throw problem(409, "IDEMPOTENCY_KEY_CONFLICT", "该 Idempotency-Key 已用于不同的提交内容");
      await insertInquiryEvent(database, String(existing.id), "duplicate_receipt_issued", "owner", { reason: "idempotency" }, now());
      return reply.status(200).send({ data: { receipt: inquiryReceipt(existing, true, school, recipient) } });
    }
    const recent = await findRecent(database);
    if (recent) {
      await insertInquiryEvent(database, String(recent.id), "duplicate_receipt_issued", "owner", { reason: "24_hour_owner_school_class_phone" }, now());
      return reply.status(200).send({ data: { receipt: inquiryReceipt(recent, true, school, recipient) } });
    }
    const id = randomUUID();
    const createdAt = now();
    const createdIso = createdAt.toISOString();
    const token = withdrawToken(id, mode);
    const consentSnapshot = {
      version: String(recipient.disclosure_version), acceptedAt: createdIso, mode,
      recipient: { name: String(recipient.recipient_name) }, dataScope: jsonArray(recipient.data_scope_json),
      purpose: String(recipient.purpose), retention: String(recipient.retention_text),
      consentText: String(recipient.consent_text), contactEtaText: String(recipient.contact_eta_text), source: SOURCE,
    };
    const outcome = await database.transaction(async (transaction) => {
      for (const lock of [
        `driving-school-idempotency:${userId}:${idempotencyDigest}`,
        `driving-school-dedup:${userId}:${body.schoolId}:${body.licenseClassCode}:${phoneDigest}`,
      ].sort()) await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(lock);
      const concurrentByKey = await findByKey(transaction);
      if (concurrentByKey) {
        if (!requestHashMatches(concurrentByKey.request_hash, requestHash)) throw problem(409, "IDEMPOTENCY_KEY_CONFLICT", "该 Idempotency-Key 已用于不同的提交内容");
        return { row: concurrentByKey, duplicate: true };
      }
      const concurrentRecent = await findRecent(transaction);
      if (concurrentRecent) return { row: concurrentRecent, duplicate: true };
      await transaction.prepare(`
        INSERT INTO driving_school_inquiries (
          id, inquiry_code, user_id, school_id, license_class_code, offer_id,
          application_mode, status, source, contact_ciphertext, phone_hmac,
          contact_name_masked, masked_phone, contact_window, idempotency_key,
          request_hash, withdraw_token_hash, disclosure_version, consent_snapshot_json,
          school_snapshot_json, recipient_school_id, is_synthetic, submitted_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, inquiryCode(createdAt), userId, body.schoolId, body.licenseClassCode, body.offerId ?? null,
        body.applicationMode, SOURCE,
        encryptContact({ name: body.contactName, phone: body.contactPhone, message: persistedMessage }, mode),
        phoneDigest, maskName(body.contactName), maskPhone(body.contactPhone), body.contactWindow,
        idempotencyDigest, requestHash, withdrawTokenHash(token), String(recipient.disclosure_version),
        JSON.stringify(consentSnapshot), JSON.stringify({ id: school.id, name: school.name, dataKind: school.data_kind }),
        body.schoolId, mode === "demo" ? 1 : 0, createdIso, createdIso, createdIso,
      );
      await insertInquiryEvent(transaction, id, "inquiry_created", "owner", {
        source: SOURCE, disclosureVersion: String(recipient.disclosure_version),
      }, createdAt);
      const created = await transaction.prepare<Row>("SELECT * FROM driving_school_inquiries WHERE id = ?").get(id);
      if (!created) throw new Error("Created driving-school inquiry could not be read back");
      return { row: created, duplicate: false };
    });
    if (outcome.duplicate) {
      await insertInquiryEvent(database, String(outcome.row.id), "duplicate_receipt_issued", "owner", { reason: "race" }, now());
    }
    return reply.status(outcome.duplicate ? 200 : 201).send({
      data: { receipt: inquiryReceipt(outcome.row, outcome.duplicate, school, recipient) },
    });
  });

  app.post<{ Params: { withdrawToken: string } }>("/api/driving-school-inquiries/:withdrawToken/withdraw", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const parsed = parseWithdrawToken(request.params.withdrawToken);
    if (!parsed) throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "撤回凭证无效或咨询不存在");
    const changed = await database.transaction(async (transaction) => {
      const row = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_inquiries WHERE id = ? AND user_id = ? FOR UPDATE
      `).get(parsed.id, userId);
      if (!row || String(row.withdraw_token_hash) !== withdrawTokenHash(request.params.withdrawToken)) {
        throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "撤回凭证无效或咨询不存在");
      }
      if (["resolved", "closed"].includes(String(row.status))) {
        throw problem(409, "DRIVING_SCHOOL_INQUIRY_FINALIZED", "已办结或关闭的咨询不能撤回");
      }
      if (String(row.status) !== "withdrawn") {
        const changedAt = now();
        await transaction.prepare(`
          UPDATE driving_school_inquiries SET status = 'withdrawn', withdrawn_at = ?,
            contact_ciphertext = NULL, phone_hmac = NULL, internal_note = NULL,
            request_hash = NULL, pii_delete_after = ?, updated_at = ? WHERE id = ?
        `).run(changedAt.toISOString(), addDays(changedAt, 180), changedAt.toISOString(), parsed.id);
        await insertInquiryEvent(transaction, parsed.id, "inquiry_withdrawn", "owner", {}, changedAt);
      } else {
        await insertInquiryEvent(transaction, parsed.id, "withdraw_receipt_read", "owner", {}, now());
      }
      return await transaction.prepare<Row>("SELECT * FROM driving_school_inquiries WHERE id = ?").get(parsed.id);
    });
    if (!changed) throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "撤回凭证无效或咨询不存在");
    const [school, recipient] = await Promise.all([
      database.prepare<Row>("SELECT * FROM driving_schools WHERE id = ?").get(String(changed.school_id)),
      database.prepare<Row>("SELECT * FROM driving_school_inquiry_recipients WHERE school_id = ?").get(String(changed.school_id)),
    ]);
    if (!school || !recipient) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
    return { data: { receipt: inquiryReceipt(changed, true, school, recipient) } };
  });

  app.get<{ Querystring: { page?: string; pageSize?: string; q?: string; dataKind?: string; status?: string } }>("/api/admin/driving-schools", async (request) => {
    const { page, pageSize } = pagination(request.query);
    const values: DatabaseValue[] = [];
    let where = "WHERE deleted_at IS NULL";
    if (request.query.q?.trim()) { where += " AND (name ILIKE ? OR legal_name ILIKE ? OR address ILIKE ? OR location_title ILIKE ?)"; const q = `%${request.query.q.trim()}%`; values.push(q, q, q, q); }
    if (request.query.dataKind) {
      if (!["demo", "real"].includes(request.query.dataKind)) throw problem(400, "INVALID_DRIVING_SCHOOL_DATA_KIND", "数据类型筛选无效");
      where += " AND data_kind = ?"; values.push(request.query.dataKind);
    }
    if (request.query.status) {
      if (!["published", "draft"].includes(request.query.status)) throw problem(400, "INVALID_DRIVING_SCHOOL_PUBLISH_STATUS", "发布状态筛选无效");
      where += request.query.status === "published" ? " AND is_published = 1" : " AND is_published = 0";
    }
    const count = await database.prepare<Row>(`SELECT COUNT(*) AS count FROM driving_schools ${where}`).get(...values);
    const total = Number(count?.count ?? 0);
    const rows = await database.prepare<Row>(`
      SELECT * FROM driving_schools ${where} ORDER BY sort_priority DESC, updated_at DESC LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize);
    return { data: { items: await Promise.all(rows.map((row) => schoolDto(database, row, currentDate(now()), true))), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } };
  });

  app.post("/api/admin/driving-schools", async (request, reply) => {
    const body = parseBody(schoolCreateSchema, request.body, problem);
    assertVerifiedLocation(body.location, body.dataKind, options);
    if (body.dataKind === "demo" && body.regulatory.status !== "demo") throw problem(409, "DEMO_REGULATORY_STATUS_REQUIRED", "演示机构的监管状态必须为 demo");
    if (body.dataKind === "real" && body.regulatory.status === "demo") throw problem(409, "REAL_REGULATORY_STATUS_REQUIRED", "真实机构不能使用演示监管状态");
    if (body.dataKind === "demo" && body.inquiryRecipient && !body.inquiryRecipient.synthetic) {
      throw problem(409, "DEMO_RECIPIENT_MUST_BE_SYNTHETIC", "演示机构只能使用合成咨询配置");
    }
    const id = body.id ?? `driving-school-${randomUUID()}`;
    const atDate = now();
    const at = atDate.toISOString();
    await database.transaction(async (transaction) => {
      await transaction.prepare(`
        INSERT INTO driving_schools (
          id, name, legal_name, description, data_kind, district, address, latitude,
          longitude, map_poi_id, location_title, location_source, public_phone,
          internal_contact_name, internal_contact_phone, tags_json, facilities_json,
          open_hours, weekly_schedule_json, regulatory_type, regulatory_number,
          regulatory_authority, regulatory_source_url, regulatory_source_label,
          regulatory_valid_from, regulatory_valid_until, regulatory_verified_at,
          regulatory_status, capability_level, is_active, is_published, sort_priority,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        id, body.name, body.legalName ?? null, body.description, body.dataKind,
        body.location.district, body.location.address, body.location.latitude, body.location.longitude,
        body.location.poiId, body.location.title, body.location.source, body.publicPhone ?? null,
        body.internalContact?.name ?? null, body.internalContact?.phone ?? null,
        JSON.stringify(body.tags), JSON.stringify(body.facilities), body.openHours,
        JSON.stringify(body.weeklySchedule), body.regulatory.type, body.regulatory.number,
        body.regulatory.authority, body.regulatory.sourceUrl ?? null, body.regulatory.sourceLabel,
        body.regulatory.validFrom ?? null, body.regulatory.validUntil ?? null,
        body.regulatory.verifiedAt ?? null, body.regulatory.status,
        body.dataKind === "demo" ? null : normalizeCapabilityLevel(body.regulatory.capabilityLevel),
        body.isActive ? 1 : 0, body.sortPriority, at, at,
      );
      if (body.inquiryRecipient) await upsertRecipient(transaction, { id, name: body.name, dataKind: body.dataKind }, body.inquiryRecipient, at);
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.school.create",
        outcome: "success",
        resource: { type: "driving_school", id },
        before: null,
        after: {
          dataKind: body.dataKind,
          district: body.location.district,
          active: body.isActive,
          published: false,
          inquiryEnabled: body.inquiryRecipient?.active ?? false,
        },
        metadata: {
          presentation: drivingSchoolPresentation({
            actionLabel: "新增驾校",
            summary: `新增驾校 ${body.name}`,
            resourceLabel: `驾校 ${body.name}`,
            changes: [
              { field: "dataKind", label: "数据类型", after: body.dataKind === "demo" ? "演示资料" : "真实资料" },
              { field: "district", label: "所在区域", after: body.location.district },
              { field: "active", label: "记录状态", after: body.isActive ? "启用" : "停用" },
              { field: "publicationStatus", label: "发布状态", after: "未发布" },
              { field: "inquiryEnabled", label: "平台咨询", after: body.inquiryRecipient?.active ? "启用" : "停用" },
            ],
          }),
        },
        occurredAt: at,
      });
    });
    const school = await requireSchool(database, id, problem);
    return reply.status(201).send({ data: await schoolDto(database, school, currentDate(now()), true) });
  });

  app.get<{ Params: { id: string } }>("/api/admin/driving-schools/:id", async (request) => {
    const school = await requireSchool(database, request.params.id, problem);
    return { data: await schoolDto(database, school, currentDate(now()), true) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/driving-schools/:id/preview", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const school = await requireSchool(database, request.params.id, problem);
    const at = now();
    const today = currentDate(at);
    // Intentionally use the public projection while bypassing only the
    // active/published lookup gate. This lets operations preview a persisted
    // draft without exposing admin-only contacts or inquiry configuration.
    const detail = await schoolDto(database, school, today, false);
    const summary = await schoolDto(database, school, today, false);
    const [savedAt, checklist, offerMappings] = await Promise.all([
      drivingSchoolSavedAt(database, school),
      schoolPublishChecklist(database, school, at),
      drivingSchoolOfferMappings(database, String(school.id)),
    ]);
    const regulatoryVisible = publicRegulatoryValid(school, at);
    const listVisible = bool(school.is_active) && bool(school.is_published) && regulatoryVisible;
    const reasons: string[] = [];
    if (!bool(school.is_active)) reasons.push("机构未启用");
    if (!bool(school.is_published)) reasons.push("机构尚未发布");
    if (!regulatoryVisible) reasons.push("真实机构监管资料当前不可公开");
    if (!Boolean(detail.inquiryAvailable)) reasons.push("平台咨询当前不可用");
    const firstTrainingClass = Array.isArray(detail.trainingClasses)
      ? detail.trainingClasses[0] as Record<string, unknown> | undefined
      : undefined;
    const firstTrainingMode = Array.isArray(firstTrainingClass?.supportedModes)
      ? firstTrainingClass.supportedModes[0]
      : undefined;
    const listPath = new URLSearchParams({ q: String(school.name) });
    const inquiryPath = new URLSearchParams({ schoolId: String(school.id) });
    if (firstTrainingClass?.licenseClassCode && firstTrainingMode) {
      listPath.set("licenseClassCode", String(firstTrainingClass.licenseClassCode));
      listPath.set("applicationMode", String(firstTrainingMode));
      inquiryPath.set("licenseClassCode", String(firstTrainingClass.licenseClassCode));
      inquiryPath.set("applicationMode", String(firstTrainingMode));
    }
    const revision = `driving-school-preview-${createHash("sha256")
      .update(stableJson({ schoolId: school.id, savedAt, summary, offerMappings }))
      .digest("hex").slice(0, 20)}`;
    return {
      data: {
        savedAt,
        revision,
        summary,
        detail,
        visibility: {
          listVisible,
          detailVisible: listVisible,
          inquiryAvailable: listVisible && Boolean(detail.inquiryAvailable),
          reasons,
        },
        checklist,
        offerMappings,
        testPaths: {
          list: `/packages/driving-school/pages/list/list?${listPath.toString()}`,
          detail: `/packages/driving-school/pages/detail/detail?id=${encodeURIComponent(String(school.id))}`,
          inquiry: `/packages/driving-school/pages/inquiry/inquiry?${inquiryPath.toString()}`,
        },
      },
    };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/driving-schools/:id", async (request) => {
    const body = parseBody(schoolPatchSchema, request.body, problem);
    const school = await requireSchool(database, request.params.id, problem);
    const dataKind = body.dataKind ?? String(school.data_kind) as "demo" | "real";
    const switchingToDemo = String(school.data_kind) === "real" && dataKind === "demo";
    if (body.location) assertVerifiedLocation(body.location, dataKind, options);
    const regulatory = body.regulatory;
    const status = regulatory?.status ?? String(school.regulatory_status);
    if (dataKind === "demo" && status !== "demo") throw problem(409, "DEMO_REGULATORY_STATUS_REQUIRED", "演示机构的监管状态必须为 demo");
    if (dataKind === "real" && status === "demo") throw problem(409, "REAL_REGULATORY_STATUS_REQUIRED", "真实机构不能使用演示监管状态");
    if (dataKind === "demo" && body.inquiryRecipient && !body.inquiryRecipient.synthetic) {
      throw problem(409, "DEMO_RECIPIENT_MUST_BE_SYNTHETIC", "演示机构只能使用合成咨询配置");
    }
    const atDate = now();
    const at = atDate.toISOString();
    const location = body.location;
    await database.transaction(async (transaction) => {
      const lockedSchool = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!lockedSchool) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const recipientBefore = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_inquiry_recipients WHERE school_id = ? FOR UPDATE
      `).get(request.params.id);
      await transaction.prepare(`
        UPDATE driving_schools SET
          name = ?, legal_name = ?, description = ?, data_kind = ?, district = ?, address = ?,
          latitude = ?, longitude = ?, map_poi_id = ?, location_title = ?, location_source = ?,
          public_phone = ?, internal_contact_name = ?, internal_contact_phone = ?, tags_json = ?,
          facilities_json = ?, open_hours = ?, weekly_schedule_json = ?, regulatory_type = ?,
          regulatory_number = ?, regulatory_authority = ?, regulatory_source_url = ?,
          regulatory_source_label = ?, regulatory_valid_from = ?, regulatory_valid_until = ?,
          regulatory_verified_at = ?, regulatory_status = ?, capability_level = ?, is_active = ?,
          sort_priority = ?, updated_at = ? WHERE id = ?
      `).run(
        body.name ?? lockedSchool.name, body.legalName === undefined ? lockedSchool.legal_name : body.legalName,
        body.description ?? lockedSchool.description, dataKind, location?.district ?? lockedSchool.district,
        location?.address ?? lockedSchool.address, location?.latitude ?? lockedSchool.latitude,
        location?.longitude ?? lockedSchool.longitude, location?.poiId ?? lockedSchool.map_poi_id,
        location?.title ?? lockedSchool.location_title, location?.source ?? lockedSchool.location_source,
        body.publicPhone === undefined ? lockedSchool.public_phone : body.publicPhone,
        body.internalContact === undefined ? lockedSchool.internal_contact_name : body.internalContact?.name ?? null,
        body.internalContact === undefined ? lockedSchool.internal_contact_phone : body.internalContact?.phone ?? null,
        body.tags ? JSON.stringify(body.tags) : lockedSchool.tags_json,
        body.facilities ? JSON.stringify(body.facilities) : lockedSchool.facilities_json,
        body.openHours ?? lockedSchool.open_hours,
        body.weeklySchedule ? JSON.stringify(body.weeklySchedule) : lockedSchool.weekly_schedule_json,
        regulatory?.type ?? lockedSchool.regulatory_type, regulatory?.number ?? lockedSchool.regulatory_number,
        regulatory?.authority ?? lockedSchool.regulatory_authority,
        regulatory && "sourceUrl" in regulatory ? regulatory.sourceUrl ?? null : lockedSchool.regulatory_source_url,
        regulatory?.sourceLabel ?? lockedSchool.regulatory_source_label,
        regulatory && "validFrom" in regulatory ? regulatory.validFrom ?? null : lockedSchool.regulatory_valid_from,
        regulatory && "validUntil" in regulatory ? regulatory.validUntil ?? null : lockedSchool.regulatory_valid_until,
        regulatory && "verifiedAt" in regulatory ? regulatory.verifiedAt ?? null : lockedSchool.regulatory_verified_at,
        status, regulatory && "capabilityLevel" in regulatory
          ? normalizeCapabilityLevel(regulatory.capabilityLevel)
          : lockedSchool.capability_level,
        body.isActive === undefined ? lockedSchool.is_active : body.isActive ? 1 : 0,
        body.sortPriority ?? lockedSchool.sort_priority, at, request.params.id,
      );
      const recipientUpdate = body.inquiryRecipient ?? (switchingToDemo ? defaultDemoInquiryRecipient() : undefined);
      if (recipientUpdate) await upsertRecipient(transaction, {
        id: request.params.id, name: body.name ?? String(lockedSchool.name), dataKind,
      }, recipientUpdate, at);
      if (dataKind === "demo") await syncDemoCapabilityLevel(transaction, request.params.id, atDate);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, atDate);
      const changedSchool = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL
      `).get(request.params.id);
      if (!changedSchool) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const recipientAfter = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_inquiry_recipients WHERE school_id = ?
      `).get(request.params.id);
      const changes = drivingSchoolAuditChanges([
        { field: "name", label: "展示名称", before: lockedSchool.name, after: changedSchool.name },
        { field: "legalName", label: "真实主体名称", before: lockedSchool.legal_name, after: changedSchool.legal_name },
        { field: "description", label: "公开简介已修改", before: lockedSchool.description, after: changedSchool.description, contentOnly: true },
        {
          field: "dataKind",
          label: "数据类型",
          before: String(lockedSchool.data_kind) === "demo" ? "演示资料" : "真实资料",
          after: String(changedSchool.data_kind) === "demo" ? "演示资料" : "真实资料",
        },
        {
          field: "location",
          label: "经营位置",
          before: `${String(lockedSchool.district)} · ${String(lockedSchool.address)}`,
          after: `${String(changedSchool.district)} · ${String(changedSchool.address)}`,
        },
        { field: "publicContact", label: "公开联系电话已修改", before: lockedSchool.public_phone, after: changedSchool.public_phone, contentOnly: true },
        {
          field: "internalContact",
          label: "内部联系方式配置",
          before: lockedSchool.internal_contact_name && lockedSchool.internal_contact_phone ? "已配置" : "未配置",
          after: changedSchool.internal_contact_name && changedSchool.internal_contact_phone ? "已配置" : "未配置",
        },
        { field: "tags", label: "公开标签数量", before: jsonArray(lockedSchool.tags_json).length, after: jsonArray(changedSchool.tags_json).length },
        { field: "facilities", label: "公开设施数量", before: jsonArray(lockedSchool.facilities_json).length, after: jsonArray(changedSchool.facilities_json).length },
        { field: "openHours", label: "营业时间", before: lockedSchool.open_hours, after: changedSchool.open_hours },
        { field: "regulatoryType", label: "监管凭据类型", before: lockedSchool.regulatory_type, after: changedSchool.regulatory_type },
        { field: "regulatoryNumber", label: "备案或许可编号", before: lockedSchool.regulatory_number, after: changedSchool.regulatory_number },
        { field: "regulatoryAuthority", label: "备案或许可机关", before: lockedSchool.regulatory_authority, after: changedSchool.regulatory_authority },
        { field: "regulatorySource", label: "监管来源已修改", before: lockedSchool.regulatory_source_url, after: changedSchool.regulatory_source_url, contentOnly: true },
        { field: "regulatoryValidFrom", label: "资质有效起始日", before: lockedSchool.regulatory_valid_from, after: changedSchool.regulatory_valid_from },
        { field: "regulatoryValidUntil", label: "资质有效截止日", before: lockedSchool.regulatory_valid_until, after: changedSchool.regulatory_valid_until },
        { field: "regulatoryStatus", label: "监管核验状态", before: lockedSchool.regulatory_status, after: changedSchool.regulatory_status },
        { field: "capabilityLevel", label: "培训能力等级", before: lockedSchool.capability_level, after: changedSchool.capability_level },
        { field: "active", label: "记录状态", before: bool(lockedSchool.is_active) ? "启用" : "停用", after: bool(changedSchool.is_active) ? "启用" : "停用" },
        { field: "sortPriority", label: "后台排序", before: Number(lockedSchool.sort_priority), after: Number(changedSchool.sort_priority) },
        {
          field: "inquiryEnabled",
          label: "平台咨询",
          before: recipientBefore && bool(recipientBefore.is_active) ? "启用" : "停用",
          after: recipientAfter && bool(recipientAfter.is_active) ? "启用" : "停用",
        },
        {
          field: "inquiryMode",
          label: "咨询资料类型",
          before: recipientBefore && bool(recipientBefore.is_synthetic) ? "合成演示资料" : "真实资料",
          after: recipientAfter && bool(recipientAfter.is_synthetic) ? "合成演示资料" : "真实资料",
        },
        {
          field: "inquiryDisclosure",
          label: "咨询授权说明已修改",
          before: recipientBefore?.disclosure_version,
          after: recipientAfter?.disclosure_version,
          contentOnly: true,
        },
      ]);
      const presentation = withAutoUnpublish(
        `修改驾校 ${String(changedSchool.name)} 的资料`,
        changes,
        autoUnpublishReasons,
      );
      if (presentation.changes.length > 0) {
        await auditBackofficeEvent(transaction, {
          request,
          action: "driving_school.school.update",
          outcome: "success",
          resource: { type: "driving_school", id: request.params.id },
          before: {
            dataKind: String(lockedSchool.data_kind),
            district: String(lockedSchool.district),
            active: bool(lockedSchool.is_active),
            published: bool(lockedSchool.is_published),
            regulatoryStatus: String(lockedSchool.regulatory_status),
            inquiryEnabled: Boolean(recipientBefore && bool(recipientBefore.is_active)),
          },
          after: {
            dataKind: String(changedSchool.data_kind),
            district: String(changedSchool.district),
            active: bool(changedSchool.is_active),
            published: bool(changedSchool.is_published),
            regulatoryStatus: String(changedSchool.regulatory_status),
            inquiryEnabled: Boolean(recipientAfter && bool(recipientAfter.is_active)),
          },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: "修改驾校资料",
              summary: presentation.summary,
              resourceLabel: `驾校 ${String(changedSchool.name)}`,
              changes: presentation.changes,
              reason: presentation.reason,
            }),
          },
          occurredAt: at,
        });
      }
    });
    const changed = await requireSchool(database, request.params.id, problem);
    return { data: await schoolDto(database, changed, currentDate(now()), true) };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/driving-schools/:id", async (request, reply) => {
    const at = now().toISOString();
    await database.transaction(async (transaction) => {
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      await transaction.prepare(`
        UPDATE driving_schools SET is_active = 0, is_published = 0, published_at = NULL,
          deleted_at = ?, updated_at = ? WHERE id = ?
      `).run(at, at, request.params.id);
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.school.delete",
        outcome: "success",
        resource: { type: "driving_school", id: request.params.id },
        before: { active: bool(school.is_active), published: bool(school.is_published), deleted: false },
        after: { active: false, published: false, deleted: true },
        metadata: {
          presentation: drivingSchoolPresentation({
            actionLabel: "删除驾校",
            summary: `删除驾校 ${String(school.name)}`,
            resourceLabel: `驾校 ${String(school.name)}`,
            changes: [
              { field: "recordStatus", label: "记录状态", before: "正常", after: "已删除" },
              ...(bool(school.is_published)
                ? [{ field: "publicationStatus", label: "发布状态", before: "已发布", after: "已下线" }]
                : []),
            ],
          }),
        },
        occurredAt: at,
      });
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/admin/driving-schools/:id/publish", async (request) => {
    const atDate = now();
    const today = currentDate(atDate);
    const at = atDate.toISOString();
    await database.transaction(async (transaction) => {
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const missing = await schoolPublishMissing(transaction, school, atDate);
      if (missing.length) throw problem(409, "DRIVING_SCHOOL_PUBLISH_VALIDATION_FAILED", "发布条件未满足", { missing: missing.join("、") });
      await transaction.prepare(`UPDATE driving_schools SET is_published = 1, published_at = ?, updated_at = ? WHERE id = ?`)
        .run(at, at, request.params.id);
      if (!bool(school.is_published)) {
        await auditBackofficeEvent(transaction, {
          request,
          action: "driving_school.school.publish",
          outcome: "success",
          resource: { type: "driving_school", id: request.params.id },
          before: { published: false },
          after: { published: true },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: "发布驾校",
              summary: `发布驾校 ${String(school.name)}`,
              resourceLabel: `驾校 ${String(school.name)}`,
              changes: [{ field: "publicationStatus", label: "发布状态", before: "未发布", after: "已发布" }],
            }),
          },
          occurredAt: at,
        });
      }
    });
    const changed = await requireSchool(database, request.params.id, problem);
    return { data: await schoolDto(database, changed, today, true) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/driving-schools/:id/unpublish", async (request) => {
    const at = now().toISOString();
    await database.transaction(async (transaction) => {
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      await transaction.prepare("UPDATE driving_schools SET is_published = 0, published_at = NULL, updated_at = ? WHERE id = ?")
        .run(at, request.params.id);
      if (bool(school.is_published)) {
        await auditBackofficeEvent(transaction, {
          request,
          action: "driving_school.school.unpublish",
          outcome: "success",
          resource: { type: "driving_school", id: request.params.id },
          before: { published: true },
          after: { published: false },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: "下线驾校",
              summary: `下线驾校 ${String(school.name)}`,
              resourceLabel: `驾校 ${String(school.name)}`,
              changes: [{ field: "publicationStatus", label: "发布状态", before: "已发布", after: "已下线" }],
            }),
          },
          occurredAt: at,
        });
      }
    });
    const changed = await requireSchool(database, request.params.id, problem);
    return { data: await schoolDto(database, changed, currentDate(now()), true) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/driving-schools/:id/images", async (request) => {
    await requireSchool(database, request.params.id, problem);
    const rows = await database.prepare<Row>("SELECT * FROM driving_school_images WHERE school_id = ? ORDER BY is_cover DESC, sort_order ASC").all(request.params.id);
    return { data: { items: rows.map(imageDto) } };
  });

  app.post<{ Params: { id: string } }>("/api/admin/driving-schools/:id/images", async (request, reply) => {
    await requireSchool(database, request.params.id, problem);
    const body = parseBody(imageCreateSchema, request.body, problem);
    const id = body.id ?? `driving-school-image-${randomUUID()}`;
    const atDate = now();
    const at = atDate.toISOString();
    await database.transaction(async (transaction) => {
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      if (body.isCover) await transaction.prepare("UPDATE driving_school_images SET is_cover = 0, updated_at = ? WHERE school_id = ?").run(at, request.params.id);
      await transaction.prepare(`
        INSERT INTO driving_school_images (id, school_id, image_url, alt_text, is_cover, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.params.id, body.url, body.caption, body.isCover ? 1 : 0, body.sortOrder, at, at);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, atDate);
      const presentation = withAutoUnpublish(
        `为驾校 ${String(school.name)} 添加图片${body.isCover ? "并设为封面" : ""}`,
        [
          { field: "image", label: "学校图片", after: "已添加" },
          { field: "cover", label: "列表封面", after: body.isCover ? "是" : "否" },
          { field: "sortOrder", label: "图片排序", after: body.sortOrder },
        ],
        autoUnpublishReasons,
      );
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.image.create",
        outcome: "success",
        resource: { type: "driving_school_image", id },
        before: null,
        after: { schoolId: request.params.id, cover: body.isCover, sortOrder: body.sortOrder },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: "添加驾校图片",
              summary: presentation.summary,
              resourceLabel: `驾校 ${String(school.name)} · ${body.isCover ? "封面图" : "学校图片"}`,
              changes: presentation.changes,
              reason: presentation.reason,
            }),
        },
        occurredAt: at,
      });
    });
    const row = await database.prepare<Row>("SELECT * FROM driving_school_images WHERE id = ?").get(id);
    return reply.status(201).send({ data: imageDto(row!) });
  });

  app.patch<{ Params: { id: string; imageId: string } }>("/api/admin/driving-schools/:id/images/:imageId", async (request) => {
    const body = parseBody(imagePatchSchema, request.body, problem);
    const atDate = now();
    const at = atDate.toISOString();
    const changedImage = await database.transaction(async (transaction) => {
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const row = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_images WHERE id = ? AND school_id = ? FOR UPDATE
      `).get(request.params.imageId, request.params.id);
      if (!row) throw problem(404, "DRIVING_SCHOOL_IMAGE_NOT_FOUND", "未找到该图片");
      if (body.isCover) await transaction.prepare("UPDATE driving_school_images SET is_cover = 0, updated_at = ? WHERE school_id = ? AND id <> ?").run(at, request.params.id, request.params.imageId);
      await transaction.prepare(`UPDATE driving_school_images SET image_url = ?, alt_text = ?, is_cover = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
        .run(body.url ?? row.image_url, body.caption ?? row.alt_text, body.isCover === undefined ? row.is_cover : body.isCover ? 1 : 0, body.sortOrder ?? row.sort_order, at, request.params.imageId);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, atDate);
      const changed = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_images WHERE id = ? AND school_id = ?
      `).get(request.params.imageId, request.params.id);
      if (!changed) throw problem(404, "DRIVING_SCHOOL_IMAGE_NOT_FOUND", "未找到该图片");
      const changes = drivingSchoolAuditChanges([
        { field: "imageUrl", label: "图片地址已修改", before: row.image_url, after: changed.image_url, contentOnly: true },
        { field: "caption", label: "图片说明已修改", before: row.alt_text, after: changed.alt_text, contentOnly: true },
        { field: "cover", label: "列表封面", before: bool(row.is_cover) ? "是" : "否", after: bool(changed.is_cover) ? "是" : "否" },
        { field: "sortOrder", label: "图片排序", before: Number(row.sort_order), after: Number(changed.sort_order) },
      ]);
      const presentation = withAutoUnpublish(
        body.isCover && !bool(row.is_cover)
          ? `将驾校 ${String(school.name)} 的图片设为封面`
          : `修改驾校 ${String(school.name)} 的图片`,
        changes,
        autoUnpublishReasons,
      );
      if (presentation.changes.length > 0) {
        await auditBackofficeEvent(transaction, {
          request,
          action: "driving_school.image.update",
          outcome: "success",
          resource: { type: "driving_school_image", id: request.params.imageId },
          before: { cover: bool(row.is_cover), sortOrder: Number(row.sort_order) },
          after: { cover: bool(changed.is_cover), sortOrder: Number(changed.sort_order) },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: body.isCover && !bool(row.is_cover) ? "设置驾校封面" : "修改驾校图片",
              summary: presentation.summary,
              resourceLabel: `驾校 ${String(school.name)} · ${bool(changed.is_cover) ? "封面图" : "学校图片"}`,
              changes: presentation.changes,
              reason: presentation.reason,
            }),
          },
          occurredAt: at,
        });
      }
      return changed;
    });
    return { data: imageDto(changedImage) };
  });

  app.delete<{ Params: { id: string; imageId: string } }>("/api/admin/driving-schools/:id/images/:imageId", async (request, reply) => {
    const at = now();
    await database.transaction(async (transaction) => {
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const row = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_images WHERE id = ? AND school_id = ? FOR UPDATE
      `).get(request.params.imageId, request.params.id);
      if (!row) throw problem(404, "DRIVING_SCHOOL_IMAGE_NOT_FOUND", "未找到该图片");
      await transaction.prepare("DELETE FROM driving_school_images WHERE id = ? AND school_id = ?")
        .run(request.params.imageId, request.params.id);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, at);
      const presentation = withAutoUnpublish(
        `删除驾校 ${String(school.name)} 的图片`,
        [{ field: "image", label: "学校图片", before: "正常", after: "已删除" }],
        autoUnpublishReasons,
      );
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.image.delete",
        outcome: "success",
        resource: { type: "driving_school_image", id: request.params.imageId },
        before: { cover: bool(row.is_cover), sortOrder: Number(row.sort_order), deleted: false },
        after: { deleted: true },
        metadata: {
          presentation: drivingSchoolPresentation({
            actionLabel: "删除驾校图片",
            summary: presentation.summary,
            resourceLabel: `驾校 ${String(school.name)} · ${bool(row.is_cover) ? "封面图" : "学校图片"}`,
            changes: presentation.changes,
            reason: presentation.reason,
          }),
        },
        occurredAt: at.toISOString(),
      });
    });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/admin/driving-schools/:id/training-classes", async (request) => {
    await requireSchool(database, request.params.id, problem);
    const rows = await database.prepare<Row>(`
      SELECT tc.*, lc.name AS license_class_name, lc.conditions_json AS catalog_conditions_json
      FROM driving_school_training_classes tc JOIN driving_license_classes lc ON lc.code = tc.license_class_code
      WHERE tc.school_id = ? ORDER BY lc.sort_order ASC
    `).all(request.params.id);
    return { data: { items: rows.map((row) => trainingClassDto(row, true)) } };
  });

  app.post<{ Params: { id: string } }>("/api/admin/driving-schools/:id/training-classes", async (request, reply) => {
    await requireSchool(database, request.params.id, problem);
    const body = parseBody(trainingClassCreateSchema, request.body, problem);
    const modes = body.applicationModes ?? body.supportedModes ?? [];
    const catalog = await database.prepare<Row>("SELECT * FROM driving_license_classes WHERE code = ? AND is_active = 1").get(body.licenseClassCode);
    if (!catalog) throw problem(404, "LICENSE_CLASS_NOT_FOUND", "未找到该准驾车型");
    if (modes.includes("initial") && !bool(catalog.initial_allowed)) throw problem(409, "INITIAL_APPLICATION_NOT_ALLOWED", `${body.licenseClassCode} 不支持初次申领`);
    const catalogConditions = jsonArray(catalog.conditions_json);
    const schoolConditions = schoolConditionsFromInput(body.schoolConditions, body.conditions, catalogConditions);
    const capabilityNote = body.trainingCapabilityNote !== undefined
      ? body.trainingCapabilityNote
      : legacyCapabilityNote(body.trainingCapabilityLevel) ?? null;
    const atDate = now();
    const at = atDate.toISOString();
    await database.transaction(async (transaction) => {
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      await transaction.prepare(`
        INSERT INTO driving_school_training_classes (
          school_id, license_class_code, initial_available, upgrade_available,
          training_capability_level, training_capability_note, conditions_json,
          is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        request.params.id, body.licenseClassCode, modes.includes("initial") ? 1 : 0,
        modes.includes("upgrade") ? 1 : 0, capabilityNote, JSON.stringify(schoolConditions),
        body.status === "active" ? 1 : 0, at, at,
      );
      await syncDemoCapabilityLevel(transaction, request.params.id, atDate);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, atDate);
      const className = String(catalog.name ?? body.licenseClassCode);
      const presentation = withAutoUnpublish(
        `为驾校 ${String(school.name)} 添加 ${body.licenseClassCode} 培训车型`,
        [
          { field: "applicationModes", label: "申领方式", after: drivingSchoolModeLabels(modes) },
          { field: "status", label: "车型状态", after: body.status === "active" ? "启用" : "停用" },
          { field: "trainingNote", label: "培训备注", after: capabilityNote ? "已填写" : "未填写" },
          { field: "schoolConditions", label: "学校补充条件", after: `${schoolConditions.length} 项` },
        ],
        autoUnpublishReasons,
      );
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.training_class.create",
        outcome: "success",
        resource: { type: "driving_school_training_class", id: `${request.params.id}:${body.licenseClassCode}` },
        before: null,
        after: {
          licenseClassCode: body.licenseClassCode,
          applicationModes: modes,
          active: body.status === "active",
          hasTrainingNote: Boolean(capabilityNote),
          schoolConditionCount: schoolConditions.length,
        },
        metadata: {
          presentation: drivingSchoolPresentation({
            actionLabel: "添加培训车型",
            summary: presentation.summary,
            resourceLabel: `驾校 ${String(school.name)} · ${body.licenseClassCode} ${className}`,
            changes: presentation.changes,
            reason: presentation.reason,
          }),
        },
        occurredAt: at,
      });
    });
    const row = await database.prepare<Row>(`
      SELECT tc.*, lc.name AS license_class_name, lc.conditions_json AS catalog_conditions_json
      FROM driving_school_training_classes tc JOIN driving_license_classes lc ON lc.code = tc.license_class_code
      WHERE tc.school_id = ? AND tc.license_class_code = ?
    `).get(request.params.id, body.licenseClassCode);
    return reply.status(201).send({ data: trainingClassDto(row!, true) });
  });

  app.patch<{ Params: { id: string; licenseClassCode: string } }>("/api/admin/driving-schools/:id/training-classes/:licenseClassCode", async (request) => {
    const code = licenseClassSchema.safeParse(request.params.licenseClassCode);
    if (!code.success) throw problem(400, "INVALID_LICENSE_CLASS", "准驾车型无效");
    const body = parseBody(trainingClassPatchSchema, request.body, problem);
    const at = now();
    const changed = await database.transaction(async (transaction) => {
      await lockTrainingOfferPairs(transaction, [{ schoolId: request.params.id, licenseClassCode: code.data }]);
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const row = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_training_classes
        WHERE school_id = ? AND license_class_code = ? FOR UPDATE
      `).get(request.params.id, code.data);
      if (!row) throw problem(404, "DRIVING_SCHOOL_TRAINING_CLASS_NOT_FOUND", "未找到该培训能力");
      const catalog = await transaction.prepare<Row>("SELECT * FROM driving_license_classes WHERE code = ?").get(code.data);
      const modes = body.applicationModes ?? body.supportedModes ?? trainingModes(row);
      if (modes.includes("initial") && !bool(catalog?.initial_allowed)) {
        throw problem(409, "INITIAL_APPLICATION_NOT_ALLOWED", `${code.data} 不支持初次申领`);
      }
      const active = body.status === undefined ? bool(row.is_active) : body.status === "active";
      await assertTrainingChangeCompatible(transaction, request.params.id, code.data, modes, active, problem);
      const catalogConditions = jsonArray(catalog?.conditions_json);
      const nextConditions = body.schoolConditions !== undefined || body.conditions !== undefined
        ? schoolConditionsFromInput(body.schoolConditions, body.conditions, catalogConditions)
        : jsonArray(row.conditions_json);
      const nextCapabilityNote = body.trainingCapabilityNote !== undefined
        ? body.trainingCapabilityNote
        : body.trainingCapabilityLevel !== undefined
          ? legacyCapabilityNote(body.trainingCapabilityLevel) ?? null
          : row.training_capability_note;
      await transaction.prepare(`
        UPDATE driving_school_training_classes SET initial_available = ?, upgrade_available = ?,
          training_capability_level = NULL, training_capability_note = ?, conditions_json = ?,
          is_active = ?, updated_at = ?
        WHERE school_id = ? AND license_class_code = ?
      `).run(modes.includes("initial") ? 1 : 0, modes.includes("upgrade") ? 1 : 0,
        nextCapabilityNote, JSON.stringify(nextConditions),
        active ? 1 : 0, at.toISOString(), request.params.id, code.data);
      await syncDemoCapabilityLevel(transaction, request.params.id, at);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, at);
      const changedRow = await transaction.prepare<Row>(`
        SELECT tc.*, lc.name AS license_class_name, lc.conditions_json AS catalog_conditions_json
        FROM driving_school_training_classes tc JOIN driving_license_classes lc ON lc.code = tc.license_class_code
        WHERE tc.school_id = ? AND tc.license_class_code = ?
      `).get(request.params.id, code.data);
      if (!changedRow) throw problem(404, "DRIVING_SCHOOL_TRAINING_CLASS_NOT_FOUND", "未找到该培训能力");
      const changes = drivingSchoolAuditChanges([
        {
          field: "applicationModes",
          label: "申领方式",
          before: drivingSchoolModeLabels(trainingModes(row)),
          after: drivingSchoolModeLabels(trainingModes(changedRow)),
        },
        { field: "status", label: "车型状态", before: bool(row.is_active) ? "启用" : "停用", after: bool(changedRow.is_active) ? "启用" : "停用" },
        { field: "trainingNote", label: "培训备注已修改", before: row.training_capability_note, after: changedRow.training_capability_note, contentOnly: true },
        { field: "schoolConditions", label: "学校补充条件数量", before: jsonArray(row.conditions_json).length, after: jsonArray(changedRow.conditions_json).length },
      ]);
      const presentation = withAutoUnpublish(
        `修改驾校 ${String(school.name)} 的 ${code.data} 培训车型`,
        changes,
        autoUnpublishReasons,
      );
      if (presentation.changes.length > 0) {
        await auditBackofficeEvent(transaction, {
          request,
          action: "driving_school.training_class.update",
          outcome: "success",
          resource: { type: "driving_school_training_class", id: `${request.params.id}:${code.data}` },
          before: {
            applicationModes: trainingModes(row),
            active: bool(row.is_active),
            hasTrainingNote: Boolean(row.training_capability_note),
            schoolConditionCount: jsonArray(row.conditions_json).length,
          },
          after: {
            applicationModes: trainingModes(changedRow),
            active: bool(changedRow.is_active),
            hasTrainingNote: Boolean(changedRow.training_capability_note),
            schoolConditionCount: jsonArray(changedRow.conditions_json).length,
          },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: "修改培训车型",
              summary: presentation.summary,
              resourceLabel: `驾校 ${String(school.name)} · ${code.data} ${String(changedRow.license_class_name ?? code.data)}`,
              changes: presentation.changes,
              reason: presentation.reason,
            }),
          },
          occurredAt: at.toISOString(),
        });
      }
      return changedRow;
    });
    return { data: trainingClassDto(changed!, true) };
  });

  app.delete<{ Params: { id: string; licenseClassCode: string } }>("/api/admin/driving-schools/:id/training-classes/:licenseClassCode", async (request, reply) => {
    const code = licenseClassSchema.safeParse(request.params.licenseClassCode);
    if (!code.success) throw problem(400, "INVALID_LICENSE_CLASS", "准驾车型无效");
    const at = now();
    await database.transaction(async (transaction) => {
      await lockTrainingOfferPairs(transaction, [{ schoolId: request.params.id, licenseClassCode: code.data }]);
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const row = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_training_classes
        WHERE school_id = ? AND license_class_code = ? FOR UPDATE
      `).get(request.params.id, code.data);
      if (!row) throw problem(404, "DRIVING_SCHOOL_TRAINING_CLASS_NOT_FOUND", "未找到该培训能力");
      await assertTrainingChangeCompatible(transaction, request.params.id, code.data, [], false, problem);
      await transaction.prepare(`
        DELETE FROM driving_school_training_classes WHERE school_id = ? AND license_class_code = ?
      `).run(request.params.id, code.data);
      await syncDemoCapabilityLevel(transaction, request.params.id, at);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, at);
      const catalog = await transaction.prepare<Row>("SELECT name FROM driving_license_classes WHERE code = ?").get(code.data);
      const presentation = withAutoUnpublish(
        `删除驾校 ${String(school.name)} 的 ${code.data} 培训车型`,
        [{ field: "trainingClass", label: "培训车型", before: "正常", after: "已删除" }],
        autoUnpublishReasons,
      );
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.training_class.delete",
        outcome: "success",
        resource: { type: "driving_school_training_class", id: `${request.params.id}:${code.data}` },
        before: {
          applicationModes: trainingModes(row),
          active: bool(row.is_active),
          hasTrainingNote: Boolean(row.training_capability_note),
          schoolConditionCount: jsonArray(row.conditions_json).length,
          deleted: false,
        },
        after: { deleted: true },
        metadata: {
          presentation: drivingSchoolPresentation({
            actionLabel: "删除培训车型",
            summary: presentation.summary,
            resourceLabel: `驾校 ${String(school.name)} · ${code.data} ${String(catalog?.name ?? code.data)}`,
            changes: presentation.changes,
            reason: presentation.reason,
          }),
        },
        occurredAt: at.toISOString(),
      });
    });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/admin/driving-schools/:id/offers", async (request) => {
    await requireSchool(database, request.params.id, problem);
    const rows = await database.prepare<Row>("SELECT * FROM driving_school_offers WHERE school_id = ? ORDER BY sort_order ASC, updated_at DESC").all(request.params.id);
    return { data: { items: rows.map(offerDto) } };
  });

  app.post<{ Params: { id: string } }>("/api/admin/driving-schools/:id/offers", async (request, reply) => {
    await requireSchool(database, request.params.id, problem);
    const body = parseBody(offerCreateSchema, request.body, problem);
    const id = body.id ?? `driving-school-offer-${randomUUID()}`;
    const at = now();
    await database.transaction(async (transaction) => {
      await lockTrainingOfferPairs(transaction, [{ schoolId: request.params.id, licenseClassCode: body.licenseClassCode }]);
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      if (body.status === "active") {
        await assertOfferCapability(transaction, request.params.id, body.licenseClassCode, body.applicationModes, problem);
      }
      await transaction.prepare(`
        INSERT INTO driving_school_offers (
          id, school_id, license_class_code, name, price_type, min_price_fen, max_price_fen,
          application_modes_json, unit, included_items_json, excluded_items_json, description,
          valid_from, valid_until, is_active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.params.id, body.licenseClassCode, body.name, body.priceType,
        body.minPriceFen ?? null, body.maxPriceFen ?? null, JSON.stringify(body.applicationModes), body.unit,
        JSON.stringify(body.includedItems), JSON.stringify(body.excludedItems), body.description,
        null, null, body.status === "active" ? 1 : 0, body.sortOrder,
        at.toISOString(), at.toISOString());
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, at);
      const presentation = withAutoUnpublish(
        `为驾校 ${String(school.name)} 新增 ${body.licenseClassCode} 服务报价 ${body.name}`,
        [
          { field: "priceType", label: "价格类型", after: DRIVING_SCHOOL_PRICE_TYPE_LABELS[body.priceType] ?? body.priceType },
          { field: "minPrice", label: "最低金额", after: drivingSchoolMoney(body.minPriceFen) },
          { field: "maxPrice", label: "最高金额", after: drivingSchoolMoney(body.maxPriceFen) },
          { field: "applicationModes", label: "申领方式", after: drivingSchoolModeLabels(body.applicationModes) },
          { field: "unit", label: "计价单位", after: body.unit },
          { field: "status", label: "报价状态", after: body.status === "active" ? "启用" : "停用" },
          { field: "includedItems", label: "包含项目", after: `${body.includedItems.length} 项` },
          { field: "excludedItems", label: "不包含项目", after: `${body.excludedItems.length} 项` },
        ],
        autoUnpublishReasons,
      );
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.offer.create",
        outcome: "success",
        resource: { type: "driving_school_offer", id },
        before: null,
        after: {
          licenseClassCode: body.licenseClassCode,
          priceType: body.priceType,
          minPriceFen: body.minPriceFen ?? null,
          maxPriceFen: body.maxPriceFen ?? null,
          applicationModes: body.applicationModes,
          active: body.status === "active",
          sortOrder: body.sortOrder,
          includedItemCount: body.includedItems.length,
          excludedItemCount: body.excludedItems.length,
          hasDescription: Boolean(body.description),
        },
        metadata: {
          presentation: drivingSchoolPresentation({
            actionLabel: "新增服务报价",
            summary: presentation.summary,
            resourceLabel: `驾校 ${String(school.name)} · ${body.licenseClassCode} · ${body.name}`,
            changes: presentation.changes,
            reason: presentation.reason,
          }),
        },
        occurredAt: at.toISOString(),
      });
    });
    const row = await database.prepare<Row>("SELECT * FROM driving_school_offers WHERE id = ?").get(id);
    return reply.status(201).send({ data: offerDto(row!) });
  });

  app.patch<{ Params: { id: string; offerId: string } }>("/api/admin/driving-schools/:id/offers/:offerId", async (request) => {
    const patch = parseBody(offerPatchSchema, request.body, problem);
    const row = await database.prepare<Row>("SELECT * FROM driving_school_offers WHERE id = ? AND school_id = ?").get(request.params.offerId, request.params.id);
    if (!row) throw problem(404, "DRIVING_SCHOOL_OFFER_NOT_FOUND", "未找到该报价");
    const merged = parseBody(offerFieldsSchema, {
      licenseClassCode: patch.licenseClassCode ?? row.license_class_code, name: patch.name ?? row.name,
      priceType: patch.priceType ?? row.price_type,
      minPriceFen: "minPriceFen" in patch ? patch.minPriceFen : row.min_price_fen,
      maxPriceFen: "maxPriceFen" in patch ? patch.maxPriceFen : row.max_price_fen,
      applicationModes: patch.applicationModes ?? jsonArray(row.application_modes_json),
      unit: patch.unit ?? row.unit, includedItems: patch.includedItems ?? jsonArray(row.included_items_json),
      excludedItems: patch.excludedItems ?? jsonArray(row.excluded_items_json),
      description: patch.description ?? row.description,
      validFrom: null,
      validUntil: null,
      status: patch.status ?? (bool(row.is_active) ? "active" : "inactive"),
      sortOrder: patch.sortOrder ?? row.sort_order,
    }, problem);
    const at = now();
    const changedOffer = await database.transaction(async (transaction) => {
      await lockTrainingOfferPairs(transaction, [
        { schoolId: request.params.id, licenseClassCode: String(row.license_class_code) },
        { schoolId: request.params.id, licenseClassCode: merged.licenseClassCode },
      ]);
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      const lockedRow = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_offers WHERE id = ? AND school_id = ? FOR UPDATE
      `).get(request.params.offerId, request.params.id);
      if (!lockedRow) throw problem(404, "DRIVING_SCHOOL_OFFER_NOT_FOUND", "未找到该报价");
      if (merged.status === "active") {
        await assertOfferCapability(transaction, request.params.id, merged.licenseClassCode, merged.applicationModes, problem);
      }
      await transaction.prepare(`
        UPDATE driving_school_offers SET license_class_code = ?, name = ?, price_type = ?,
          min_price_fen = ?, max_price_fen = ?, application_modes_json = ?, unit = ?,
          included_items_json = ?, excluded_items_json = ?, description = ?, valid_from = ?,
          valid_until = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?
      `).run(merged.licenseClassCode, merged.name, merged.priceType, merged.minPriceFen ?? null,
        merged.maxPriceFen ?? null, JSON.stringify(merged.applicationModes), merged.unit,
        JSON.stringify(merged.includedItems), JSON.stringify(merged.excludedItems), merged.description,
        merged.validFrom ?? null, merged.validUntil ?? null, merged.status === "active" ? 1 : 0,
        merged.sortOrder, at.toISOString(), request.params.offerId);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, at);
      const changed = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_offers WHERE id = ? AND school_id = ?
      `).get(request.params.offerId, request.params.id);
      if (!changed) throw problem(404, "DRIVING_SCHOOL_OFFER_NOT_FOUND", "未找到该报价");
      const changes = drivingSchoolAuditChanges([
        { field: "name", label: "报价名称", before: lockedRow.name, after: changed.name },
        { field: "licenseClassCode", label: "准驾车型", before: lockedRow.license_class_code, after: changed.license_class_code },
        {
          field: "priceType",
          label: "价格类型",
          before: DRIVING_SCHOOL_PRICE_TYPE_LABELS[String(lockedRow.price_type)] ?? String(lockedRow.price_type),
          after: DRIVING_SCHOOL_PRICE_TYPE_LABELS[String(changed.price_type)] ?? String(changed.price_type),
        },
        { field: "minPrice", label: "最低金额", before: drivingSchoolMoney(lockedRow.min_price_fen), after: drivingSchoolMoney(changed.min_price_fen) },
        { field: "maxPrice", label: "最高金额", before: drivingSchoolMoney(lockedRow.max_price_fen), after: drivingSchoolMoney(changed.max_price_fen) },
        {
          field: "applicationModes",
          label: "申领方式",
          before: drivingSchoolModeLabels(jsonArray(lockedRow.application_modes_json)),
          after: drivingSchoolModeLabels(jsonArray(changed.application_modes_json)),
        },
        { field: "unit", label: "计价单位", before: lockedRow.unit, after: changed.unit },
        { field: "status", label: "报价状态", before: bool(lockedRow.is_active) ? "启用" : "停用", after: bool(changed.is_active) ? "启用" : "停用" },
        { field: "sortOrder", label: "报价排序", before: Number(lockedRow.sort_order), after: Number(changed.sort_order) },
        { field: "includedItems", label: "包含项目数量", before: jsonArray(lockedRow.included_items_json).length, after: jsonArray(changed.included_items_json).length },
        { field: "excludedItems", label: "不包含项目数量", before: jsonArray(lockedRow.excluded_items_json).length, after: jsonArray(changed.excluded_items_json).length },
        { field: "description", label: "服务说明已修改", before: lockedRow.description, after: changed.description, contentOnly: true },
      ]);
      const presentation = withAutoUnpublish(
        `修改驾校 ${String(school.name)} 的服务报价 ${String(changed.name)}`,
        changes,
        autoUnpublishReasons,
      );
      if (presentation.changes.length > 0) {
        await auditBackofficeEvent(transaction, {
          request,
          action: "driving_school.offer.update",
          outcome: "success",
          resource: { type: "driving_school_offer", id: request.params.offerId },
          before: {
            licenseClassCode: String(lockedRow.license_class_code),
            priceType: String(lockedRow.price_type),
            minPriceFen: lockedRow.min_price_fen == null ? null : Number(lockedRow.min_price_fen),
            maxPriceFen: lockedRow.max_price_fen == null ? null : Number(lockedRow.max_price_fen),
            applicationModes: jsonArray(lockedRow.application_modes_json),
            active: bool(lockedRow.is_active),
            sortOrder: Number(lockedRow.sort_order),
            includedItemCount: jsonArray(lockedRow.included_items_json).length,
            excludedItemCount: jsonArray(lockedRow.excluded_items_json).length,
            hasDescription: Boolean(lockedRow.description),
          },
          after: {
            licenseClassCode: String(changed.license_class_code),
            priceType: String(changed.price_type),
            minPriceFen: changed.min_price_fen == null ? null : Number(changed.min_price_fen),
            maxPriceFen: changed.max_price_fen == null ? null : Number(changed.max_price_fen),
            applicationModes: jsonArray(changed.application_modes_json),
            active: bool(changed.is_active),
            sortOrder: Number(changed.sort_order),
            includedItemCount: jsonArray(changed.included_items_json).length,
            excludedItemCount: jsonArray(changed.excluded_items_json).length,
            hasDescription: Boolean(changed.description),
          },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: "修改服务报价",
              summary: presentation.summary,
              resourceLabel: `驾校 ${String(school.name)} · ${String(changed.license_class_code)} · ${String(changed.name)}`,
              changes: presentation.changes,
              reason: presentation.reason,
            }),
          },
          occurredAt: at.toISOString(),
        });
      }
      return changed;
    });
    return { data: offerDto(changedOffer) };
  });

  app.delete<{ Params: { id: string; offerId: string } }>("/api/admin/driving-schools/:id/offers/:offerId", async (request, reply) => {
    const at = now();
    await database.transaction(async (transaction) => {
      const row = await transaction.prepare<Row>(`
        SELECT * FROM driving_school_offers WHERE id = ? AND school_id = ? FOR UPDATE
      `).get(request.params.offerId, request.params.id);
      if (!row) throw problem(404, "DRIVING_SCHOOL_OFFER_NOT_FOUND", "未找到该报价");
      await lockTrainingOfferPairs(transaction, [{
        schoolId: request.params.id, licenseClassCode: String(row.license_class_code),
      }]);
      const school = await transaction.prepare<Row>(`
        SELECT * FROM driving_schools WHERE id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(request.params.id);
      if (!school) throw problem(404, "DRIVING_SCHOOL_NOT_FOUND", "未找到该驾校");
      await transaction.prepare("DELETE FROM driving_school_offers WHERE id = ?").run(request.params.offerId);
      const autoUnpublishReasons = await autoUnpublishIfInvalid(transaction, request.params.id, at);
      const presentation = withAutoUnpublish(
        `删除驾校 ${String(school.name)} 的服务报价 ${String(row.name)}`,
        [{ field: "offer", label: "服务报价", before: "正常", after: "已删除" }],
        autoUnpublishReasons,
      );
      await auditBackofficeEvent(transaction, {
        request,
        action: "driving_school.offer.delete",
        outcome: "success",
        resource: { type: "driving_school_offer", id: request.params.offerId },
        before: {
          licenseClassCode: String(row.license_class_code),
          priceType: String(row.price_type),
          minPriceFen: row.min_price_fen == null ? null : Number(row.min_price_fen),
          maxPriceFen: row.max_price_fen == null ? null : Number(row.max_price_fen),
          active: bool(row.is_active),
          deleted: false,
        },
        after: { deleted: true },
        metadata: {
          presentation: drivingSchoolPresentation({
            actionLabel: "删除服务报价",
            summary: presentation.summary,
            resourceLabel: `驾校 ${String(school.name)} · ${String(row.license_class_code)} · ${String(row.name)}`,
            changes: presentation.changes,
            reason: presentation.reason,
          }),
        },
        occurredAt: at.toISOString(),
      });
    });
    return reply.status(204).send();
  });

  app.get<{ Querystring: { page?: string; pageSize?: string; status?: string; schoolId?: string; licenseClassCode?: string; dateFrom?: string; dateTo?: string } }>("/api/admin/driving-school-inquiries", async (request) => {
    const { page, pageSize } = pagination(request.query);
    const where: string[] = [];
    const values: DatabaseValue[] = [];
    if (request.query.status) {
      const parsed = inquiryStatusSchema.safeParse(request.query.status);
      if (!parsed.success) throw problem(400, "INVALID_INQUIRY_STATUS", "咨询状态筛选无效");
      where.push("status = ?"); values.push(parsed.data);
    }
    if (request.query.schoolId) { where.push("school_id = ?"); values.push(request.query.schoolId); }
    if (request.query.licenseClassCode) {
      const parsed = licenseClassSchema.safeParse(request.query.licenseClassCode);
      if (!parsed.success) throw problem(400, "INVALID_LICENSE_CLASS", "准驾车型筛选无效");
      where.push("license_class_code = ?"); values.push(parsed.data);
    }
    if (request.query.dateFrom) {
      const parsed = isoDateSchema.safeParse(request.query.dateFrom);
      if (!parsed.success) throw problem(400, "INVALID_DATE_RANGE", "开始日期无效");
      where.push("submitted_at >= ?"); values.push(shanghaiDayStartIso(parsed.data));
    }
    if (request.query.dateTo) {
      const parsed = isoDateSchema.safeParse(request.query.dateTo);
      if (!parsed.success) throw problem(400, "INVALID_DATE_RANGE", "结束日期无效");
      where.push("submitted_at < ?"); values.push(shanghaiDayStartIso(parsed.data, 1));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await database.prepare<Row>(`SELECT COUNT(*) AS count FROM driving_school_inquiries ${whereSql}`).get(...values);
    const total = Number(count?.count ?? 0);
    const rows = await database.prepare<Row>(`
      SELECT * FROM driving_school_inquiries ${whereSql} ORDER BY submitted_at DESC LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize);
    const realInquiry = await database.prepare<Row>(`
      SELECT 1 FROM driving_school_inquiries WHERE is_synthetic = 0 LIMIT 1
    `).get();
    assertDrivingSchoolAdminBoundary(request, problem, Boolean(realInquiry));
    return { data: { items: await Promise.all(rows.map((row) => inquiryListItem(database, row))), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } };
  });

  app.get<{ Params: { id: string } }>("/api/admin/driving-school-inquiries/:id", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const row = await database.prepare<Row>("SELECT * FROM driving_school_inquiries WHERE id = ?").get(request.params.id);
    if (!row) throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "未找到该咨询");
    assertDrivingSchoolAdminBoundary(request, problem, !bool(row.is_synthetic));
    await insertInquiryEvent(database, request.params.id, "sensitive_detail_read", "admin", {}, now());
    return { data: await inquiryDetail(database, row) };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/driving-school-inquiries/:id", async (request) => {
    const boundaryRow = await database.prepare<Row>("SELECT is_synthetic FROM driving_school_inquiries WHERE id = ?").get(request.params.id);
    if (!boundaryRow) throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "未找到该咨询");
    assertDrivingSchoolAdminBoundary(request, problem, !bool(boundaryRow.is_synthetic));
    const body = parseBody(inquiryPatchSchema, request.body, problem);
    const changed = await database.transaction(async (transaction) => {
      const row = await transaction.prepare<Row>("SELECT * FROM driving_school_inquiries WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!row) throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "未找到该咨询");
      const before = String(row.status);
      if (before === "withdrawn") {
        throw problem(409, "DRIVING_SCHOOL_INQUIRY_WITHDRAWN", "已撤回的咨询为终态，不能再修改");
      }
      const after = body.status ?? before;
      if (after !== before) {
        const allowed = before === "new" ? ["contacting"] : before === "contacting" ? ["resolved", "closed"] : [];
        if (!allowed.includes(after)) throw problem(409, "INVALID_DRIVING_SCHOOL_INQUIRY_TRANSITION", `咨询不能从 ${before} 变更为 ${after}`);
      }
      const at = now();
      const terminal = after === "resolved" || after === "closed";
      await transaction.prepare(`
        UPDATE driving_school_inquiries SET status = ?, internal_note = ?,
          contacting_at = CASE WHEN ? = 'contacting' AND contacting_at IS NULL THEN ? ELSE contacting_at END,
          resolved_at = CASE WHEN ? = 'resolved' AND resolved_at IS NULL THEN ? ELSE resolved_at END,
          closed_at = CASE WHEN ? = 'closed' AND closed_at IS NULL THEN ? ELSE closed_at END,
          pii_delete_after = CASE WHEN ? = 1 THEN ? ELSE pii_delete_after END,
          updated_at = ? WHERE id = ?
      `).run(after, body.internalNote === undefined ? row.internal_note : body.internalNote,
        after, at.toISOString(), after, at.toISOString(), after, at.toISOString(),
        terminal ? 1 : 0, terminal ? addDays(at, 180) : null, at.toISOString(), request.params.id);
      if (after !== before) await insertInquiryEvent(transaction, request.params.id, "status_changed", "admin", { from: before, to: after }, at);
      if (body.internalNote !== undefined) await insertInquiryEvent(transaction, request.params.id, "internal_note_updated", "admin", { hasNote: body.internalNote != null }, at);
      const updated = await transaction.prepare<Row>("SELECT * FROM driving_school_inquiries WHERE id = ?").get(request.params.id);
      if (!updated) throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "未找到该咨询");
      const school = await transaction.prepare<Row>("SELECT name FROM driving_schools WHERE id = ?").get(String(row.school_id));
      if (after !== before) {
        const inquiryCode = String(row.inquiry_code);
        const schoolName = String(school?.name ?? row.school_id);
        await auditBackofficeEvent(transaction, {
          request,
          action: "driving_school.inquiry.followup_update",
          outcome: "success",
          resource: { type: "driving_school_inquiry", id: request.params.id },
          before: { status: before },
          after: { status: after },
          metadata: {
            presentation: drivingSchoolPresentation({
              actionLabel: "更新驾校咨询跟进",
              summary: `将咨询 ${inquiryCode} 的状态更新为 ${DRIVING_SCHOOL_INQUIRY_STATUS_LABELS[after] ?? after}`,
              resourceLabel: `咨询 ${inquiryCode} · ${schoolName} · ${String(row.license_class_code)}`,
              changes: [{
                field: "status",
                label: "跟进状态",
                before: DRIVING_SCHOOL_INQUIRY_STATUS_LABELS[before] ?? before,
                after: DRIVING_SCHOOL_INQUIRY_STATUS_LABELS[after] ?? after,
              }],
            }),
          },
          occurredAt: at.toISOString(),
        });
      }
      return updated;
    });
    if (!changed) throw problem(404, "DRIVING_SCHOOL_INQUIRY_NOT_FOUND", "未找到该咨询");
    return { data: await inquiryListItem(database, changed) };
  });
}
