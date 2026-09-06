import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import {
  inferWashVehicleCategory,
  normalizeWashVehicleCategory,
  type WashStoreImageDto,
  type WashVehicleCategory,
} from "../src/domain/wash.js";
import {
  businessDate,
  inspectionResultRequestHash,
} from "./db.js";
import { requireCurrentUser } from "./auth.js";
import {
  assertCapability,
  auditBackofficeEvent,
  backofficeAuditEventDto,
  backofficeForRequest,
  scopedWashStoreId as scopedBackofficeWashStoreId,
  type BackofficeCapability,
  type BackofficeSession,
} from "./backoffice.js";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;
type ProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

type WashRouteOptions = {
  problem: ProblemFactory;
  uploadDir: string;
  now?: () => Date;
  calculateDrivingRoute: (
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ) => Promise<{
    distanceKm: number | null;
    driveMinutes: number | null;
    distanceBasis: "driving_route" | "estimated_distance" | "no_origin";
    distanceSource: "tencent_matrix" | "estimated" | "not_calculated";
    mapErrorCode?: string;
  }>;
};

type WashBackofficeAccess = {
  session: BackofficeSession;
  /** Null means the authenticated platform administrator may access all stores. */
  storeId: string | null;
};

const WASH_CAPABILITIES = {
  dashboardRead: "wash.dashboard.read",
  ordersRead: "wash.orders.read",
  ordersRedeem: "wash.orders.redeem",
  slotsRead: "wash.slots.read",
  slotsWrite: "wash.slots.write",
  storeRead: "wash.store.read",
  storeWrite: "wash.store.write",
  offersRead: "wash.offers.read",
  offersWrite: "wash.offers.write",
  settlementsRead: "wash.settlements.read",
} as const;

const REDEMPTION_FAILURE_LIMIT = 10;
const REDEMPTION_WINDOW_MINUTES = 5;

function washBackofficeAccess(
  request: FastifyRequest,
  capability: BackofficeCapability,
  _problem: ProblemFactory,
): WashBackofficeAccess {
  const session = assertCapability(backofficeForRequest(request), capability);
  if (session.account.role === "platform_admin") return { session, storeId: null };
  return { session, storeId: scopedBackofficeWashStoreId(session) ?? null };
}

function platformWashAccess(request: FastifyRequest, problem: ProblemFactory): BackofficeSession {
  const session = backofficeForRequest(request);
  if (session.account.role !== "platform_admin") {
    throw problem(403, "BACKOFFICE_FORBIDDEN", "该操作仅限平台管理员");
  }
  return session;
}

function scopedStoreId(
  access: WashBackofficeAccess,
  requestedStoreId: string | undefined,
  problem: ProblemFactory,
): string | undefined {
  if (access.storeId && requestedStoreId && requestedStoreId !== access.storeId) {
    throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
  }
  return access.storeId ?? requestedStoreId;
}

function optionalPagination(
  query: { page?: string; pageSize?: string },
  problem: ProblemFactory,
): { requested: boolean; page: number; pageSize: number; offset: number } {
  const requested = query.page !== undefined || query.pageSize !== undefined;
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 50);
  if (!Number.isInteger(page) || page < 1) {
    throw problem(400, "INVALID_PAGE", "页码必须是大于 0 的整数");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw problem(400, "INVALID_PAGE_SIZE", "每页数量必须是 1 到 200 的整数");
  }
  return { requested, page, pageSize, offset: (page - 1) * pageSize };
}

function assertStoreScope(
  access: WashBackofficeAccess,
  resourceStoreId: unknown,
  problem: ProblemFactory,
): void {
  if (access.storeId && String(resourceStoreId) !== access.storeId) {
    throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
  }
}

function redemptionIpHash(request: FastifyRequest): string {
  const salt = process.env.BACKOFFICE_AUDIT_IP_SALT ?? "yuxiaoman-backoffice-ip";
  return createHash("sha256").update(`${salt}:${request.ip || "unknown"}`).digest("hex");
}

async function lockRedemptionBuckets(
  database: AppDatabase,
  accountId: string,
  storeId: string,
  ipHash: string,
): Promise<void> {
  for (const bucket of [`wash-redeem-account:${storeId}:${accountId}`, `wash-redeem-ip:${storeId}:${ipHash}`].sort()) {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(bucket);
  }
}

async function redemptionIsLimited(
  database: AppDatabase,
  accountId: string,
  storeId: string,
  ipHash: string,
): Promise<boolean> {
  const row = await database.prepare<Row>(`
    SELECT COUNT(*)::text AS count
    FROM backoffice_redemption_attempts
    WHERE store_id = ? AND succeeded = FALSE
      AND attempted_at > NOW() - INTERVAL '${REDEMPTION_WINDOW_MINUTES} minutes'
      AND (account_id = ? OR ip_hash = ?)
  `).get(storeId, accountId, ipHash);
  return Number(row?.count ?? 0) >= REDEMPTION_FAILURE_LIMIT;
}

async function recordRedemptionAttempt(
  database: AppDatabase,
  accountId: string,
  storeId: string,
  ipHash: string,
  succeeded: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  await database.prepare(`
    INSERT INTO backoffice_redemption_attempts (
      id, account_id, store_id, ip_hash, succeeded, attempted_at
    ) VALUES (?, ?, ?, ?, ?, ?::timestamptz)
  `).run(randomUUID(), accountId, storeId, ipHash, succeeded, now);
  if (succeeded) {
    await database.prepare(`
      DELETE FROM backoffice_redemption_attempts
      WHERE account_id = ? AND store_id = ? AND succeeded = FALSE
    `).run(accountId, storeId);
  }
}

async function auditWashMutation(
  database: AppDatabase,
  request: FastifyRequest,
  action: string,
  resource: { type: string; id?: string | null },
  input: {
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
    recordIfUnchanged?: boolean;
  } = {},
): Promise<boolean> {
  if (
    !input.recordIfUnchanged
    && input.before !== undefined
    && input.after !== undefined
    && washAuditValuesEqual(input.before, input.after)
  ) {
    return false;
  }
  const before = input.before && typeof input.before === "object" ? input.before as Record<string, unknown> : {};
  const after = input.after && typeof input.after === "object" ? input.after as Record<string, unknown> : {};
  let storeId = String(after.storeId ?? before.storeId ?? (resource.type === "wash_store" ? resource.id ?? "" : ""));
  let resourceLabel = String(after.orderNumber ?? after.name ?? after.label ?? before.orderNumber ?? before.name ?? before.label ?? "");
  if (resource.type === "wash_order" && resource.id) {
    const order = await database.prepare<Row>("SELECT order_number, store_id FROM wash_orders WHERE id = ?").get(resource.id);
    if (order) {
      storeId ||= String(order.store_id ?? "");
      resourceLabel ||= String(order.order_number ?? "");
    }
  }
  if (resource.type === "wash_order_settlement" && resource.id) {
    const order = await database.prepare<Row>("SELECT order_number, store_id FROM wash_orders WHERE id = ?").get(resource.id);
    if (order) {
      storeId ||= String(order.store_id ?? "");
      resourceLabel ||= String(order.order_number ?? "");
    }
  }
  const store = storeId
    ? await database.prepare<Row>("SELECT name FROM wash_stores WHERE id = ?").get(storeId)
    : undefined;
  const subject = storeId
    ? { type: "wash_store" as const, id: storeId, name: String(store?.name ?? storeId) }
    : undefined;
  await auditBackofficeEvent(database, {
    request,
    action,
    outcome: "success",
    ...(subject ? { subject } : {}),
    resource,
    before: input.before,
    after: input.after,
    metadata: input.metadata,
    presentation: {
      category: "wash",
      subjectName: subject?.name,
      resourceLabel: resourceLabel || subject?.name || null,
      ...(action === "wash.order.redeem" && input.metadata?.idempotent === true
        ? { actionLabel: "重复核销洗车订单", summary: "订单此前已核销，本次未重复处理" }
        : {}),
    },
  });
  return true;
}

const washAuditNonSemanticKeys = new Set([
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  // Valet pricing versions include updatedAt, so they are transport/cache
  // metadata rather than a business-field change.
  "version",
]);

function washAuditComparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(washAuditComparable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !washAuditNonSemanticKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, washAuditComparable(item)]),
  );
}

function washAuditValuesEqual(before: unknown, after: unknown): boolean {
  return JSON.stringify(washAuditComparable(before)) === JSON.stringify(washAuditComparable(after));
}

const phonePattern = /^1[3-9]\d{9}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const shanghaiTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const idSchema = z.string().trim().min(1).max(120);
const washVehicleCategorySchema = z
  .enum(["sedan", "suv", "mpv", "suv_mpv"])
  .transform((value) => normalizeWashVehicleCategory(value)!);
const washOrderStatusSchema = z.enum([
  "pending_payment",
  "awaiting_redemption",
  "redeemed",
  "cancelled",
  "refunded",
  "expired",
]);
const settlementStatusSchema = z.enum(["unsettled", "settled", "void"]);
const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const washServiceModeSchema = z.enum(["self_drive", "valet"]);
const washTripTypeSchema = z.literal("round_trip_same_address");
export const washLocationSuggestionSchema = z.object({
  poiId: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(120),
  address: z.string().trim().min(2).max(240),
  district: z.string().trim().min(1).max(40),
  latitude: z.number().min(38.4).max(40.3),
  longitude: z.number().min(116.6).max(118.2),
  source: z.enum(["tencent", "wechat", "demo"]),
  locationProof: z.string().trim().max(2_000).optional(),
});
const pickupAddressSchema = washLocationSuggestionSchema.extend({
  detail: z.string().trim().max(120).optional(),
  note: z.string().trim().max(200).optional(),
});
const adminStoreLocationSchema = washLocationSuggestionSchema;

const WASH_DEMO_LOCATION_PROOF_SECRET = "wash-demo-location-proof-secret-not-for-production-use";
const WASH_LOCATION_PROOF_SECONDS = 30 * 60;

type WashRuntimeMode = "demo" | "real";

type WashLocationProofValue = z.infer<typeof washLocationSuggestionSchema>;

function isRealIsoDate(value: string): boolean {
  if (!isoDatePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

const isoDateSchema = z.string().refine(isRealIsoDate, "请使用有效的 YYYY-MM-DD 日期");
const dailyPeriodSchema = z.object({
  start: z.string().regex(timePattern),
  end: z.string().regex(timePattern),
}).refine((value) => value.end > value.start, { path: ["end"], message: "结束时间必须晚于开始时间" });
const weeklyScheduleSchema = z.object({
  mon: z.array(dailyPeriodSchema).default([]),
  tue: z.array(dailyPeriodSchema).default([]),
  wed: z.array(dailyPeriodSchema).default([]),
  thu: z.array(dailyPeriodSchema).default([]),
  fri: z.array(dailyPeriodSchema).default([]),
  sat: z.array(dailyPeriodSchema).default([]),
  sun: z.array(dailyPeriodSchema).default([]),
});

const adminStoreSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(2).max(100),
  legalName: z.string().trim().min(2).max(160).nullable().optional(),
  location: adminStoreLocationSchema.optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  description: z.string().trim().max(1000).default(""),
  tags: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
  facilities: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  openHours: z.string().trim().min(5).max(80),
  weeklySchedule: weeklyScheduleSchema,
  businessHoursNotice: z.string().trim().max(300).nullable().optional(),
  advanceBookingDays: z.number().int().min(1).max(60).default(14),
  rating: z.number().min(0).max(5).default(0),
  reviewCount: z.number().int().min(0).default(0),
  dataKind: z.enum(["demo", "real"]).default("demo"),
  isActive: z.boolean(),
  sortPriority: z.number().int().min(-10_000).max(10_000).default(0),
  internalContact: z.object({
    name: z.string().trim().min(1).max(60),
    phone: z.string().trim().min(5).max(30),
  }).nullable().optional(),
});

const adminStoreImageOrderSchema = z.object({
  images: z.array(z.object({
    id: idSchema,
    sortOrder: z.number().int().min(0).max(10_000),
    isCover: z.boolean().optional(),
  })).min(1).max(20),
}).superRefine((value, context) => {
  if (value.images.filter((image) => image.isCover).length > 1) {
    context.addIssue({ code: "custom", path: ["images"], message: "一家门店只能设置一张封面图" });
  }
  if (new Set(value.images.map((image) => image.id)).size !== value.images.length) {
    context.addIssue({ code: "custom", path: ["images"], message: "门店图片不能重复" });
  }
});

const adminPackageSchema = z.object({
  id: idSchema.optional(),
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  name: z.string().trim().min(2).max(100),
  shortDescription: z.string().trim().max(300).default(""),
  serviceItems: z.array(z.string().trim().min(1).max(80)).min(1).max(30).optional(),
  includedItems: z.array(z.string().trim().min(1).max(80)).min(1).max(30).optional(),
  durationMinutes: z.number().int().min(15).max(480),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  isActive: z.boolean(),
}).superRefine((value, context) => {
  if (!value.serviceItems && !value.includedItems) {
    context.addIssue({ code: "custom", path: ["serviceItems"], message: "请至少填写一项服务内容" });
  }
});

const offerInputSchema = z.object({
  packageId: idSchema,
  vehicleCategory: washVehicleCategorySchema.optional(),
  vehicleType: washVehicleCategorySchema.optional(),
  salePriceFen: z.number().int().min(0).max(1_000_000),
  listPriceFen: z.number().int().min(0).max(1_000_000).nullable().optional(),
  estimatedSettlementFen: z.number().int().min(0).max(1_000_000).optional(),
  isAvailable: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).superRefine((value, context) => {
  const category = value.vehicleCategory ?? value.vehicleType;
  if (!category) context.addIssue({ code: "custom", path: ["vehicleCategory"], message: "请选择车型价类" });
  if (value.vehicleCategory && value.vehicleType && value.vehicleCategory !== value.vehicleType) {
    context.addIssue({ code: "custom", path: ["vehicleType"], message: "vehicleType 与 vehicleCategory 不一致" });
  }
  if (value.listPriceFen != null && value.listPriceFen < value.salePriceFen) {
    context.addIssue({ code: "custom", path: ["listPriceFen"], message: "划线价不能低于销售价" });
  }
});
const offerMatrixSchema = z.object({ offers: z.array(offerInputSchema).max(200) });

const adminSlotObjectSchema = z.object({
  storeId: idSchema,
  date: isoDateSchema,
  startTime: z.string().regex(timePattern),
  endTime: z.string().regex(timePattern),
  capacity: z.number().int().min(1).max(99),
  isOpen: z.boolean().default(true),
});
const adminSlotSchema = adminSlotObjectSchema.refine((value) => value.endTime > value.startTime, {
  path: ["endTime"], message: "结束时间必须晚于开始时间",
});
const adminSlotUpdateSchema = adminSlotObjectSchema.omit({ storeId: true }).refine((value) => value.endTime > value.startTime, {
  path: ["endTime"], message: "结束时间必须晚于开始时间",
});
const adminSlotPatchSchema = z.object({
  date: isoDateSchema.optional(),
  startTime: z.string().regex(timePattern).optional(),
  endTime: z.string().regex(timePattern).optional(),
  capacity: z.number().int().min(1).max(99).optional(),
  isOpen: z.boolean().optional(),
  isClosed: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个要更新的字段")
  .superRefine((value, context) => {
    if (value.isOpen !== undefined && value.isClosed !== undefined && value.isOpen === value.isClosed) {
      context.addIssue({ code: "custom", path: ["isClosed"], message: "isOpen 与 isClosed 含义冲突" });
    }
  });
const adminSlotBatchSchema = z.object({
  storeId: idSchema,
  dateFrom: isoDateSchema,
  dateTo: isoDateSchema,
  startTime: z.string().regex(timePattern),
  endTime: z.string().regex(timePattern),
  slotMinutes: z.number().int().min(15).max(240).default(60),
  capacity: z.number().int().min(1).max(99),
  weekdays: z.array(weekdaySchema).min(1).max(7).optional(),
}).superRefine((value, context) => {
  if (value.dateTo < value.dateFrom) {
    context.addIssue({ code: "custom", path: ["dateTo"], message: "结束日期不能早于开始日期" });
  }
  if (value.endTime <= value.startTime) {
    context.addIssue({ code: "custom", path: ["endTime"], message: "结束时间必须晚于开始时间" });
  }
  const span = (Date.parse(`${value.dateTo}T00:00:00Z`) - Date.parse(`${value.dateFrom}T00:00:00Z`)) / 86_400_000;
  if (span > 31) context.addIssue({ code: "custom", path: ["dateTo"], message: "单次最多生成 32 天号源" });
});

const quoteSchema = z.object({
  vehicleId: idSchema,
  storeId: idSchema,
  packageId: idSchema,
  slotId: idSchema,
  vehicleCategory: washVehicleCategorySchema.optional(),
  serviceMode: washServiceModeSchema.default("self_drive"),
  tripType: washTripTypeSchema.default("round_trip_same_address"),
  pickupAddress: pickupAddressSchema.optional(),
}).superRefine((value, context) => {
  if (value.serviceMode === "valet" && !value.pickupAddress) {
    context.addIssue({ code: "custom", path: ["pickupAddress"], message: "请选择上门取车及送回地址" });
  }
});

const adminValetRuleSchema = z.object({
  baseFeeFen: z.number().int().min(0).max(1_000_000),
  includedKm: z.number().min(0).max(1_000),
  perKmFen: z.number().int().min(0).max(100_000),
  maxRadiusKm: z.number().positive().max(1_000).nullable(),
});
const createOrderSchema = z.object({
  precheckBookingId: idSchema.optional(),
  quoteSnapshotId: idSchema,
  idempotencyKey: z.string().trim().min(8).max(160),
  contactName: z.string().trim().min(2).max(30),
  contactPhone: z.string().trim().regex(phonePattern, "请输入有效的 11 位手机号"),
  notes: z.string().trim().max(300).optional(),
});
const paymentSchema = z.object({
  provider: z.literal("mock"),
  idempotencyKey: z.string().trim().min(8).max(160),
});
const cancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
}).default({});
const rescheduleSchema = z.object({ slotId: idSchema });
const redeemSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  source: z.enum(["wechat", "phone", "other"]).default("other"),
  // Kept as an accepted compatibility field for older clients. The server
  // always records the authenticated back-office account as the actor.
  operator: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().max(300).optional(),
});
const adminOrderPatchSchema = z.object({
  action: z.enum(["cancel", "refund"]).optional(),
  reason: z.string().trim().min(2).max(300).optional(),
  operator: z.string().trim().min(1).max(80).optional(),
  internalNote: z.string().trim().max(1000).nullable().optional(),
}).superRefine((value, context) => {
  if (value.action && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "取消或退款必须填写原因" });
  }
  if (!value.action && value.internalNote === undefined) {
    context.addIssue({ code: "custom", path: ["_root"], message: "请提供受控操作或内部备注" });
  }
});
const settlementSchema = z.object({
  status: settlementStatusSchema.optional(),
  operator: z.string().trim().min(1).max(80).optional(),
  reason: z.string().trim().min(2).max(300).optional(),
  correctionReason: z.string().trim().min(2).max(300).optional(),
  amountFen: z.number().int().min(0).max(1_000_000).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个结算字段");

function validationFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reply.status(400).send({
    error: {
      code: "VALIDATION_ERROR",
      message: "提交的信息有误，请检查后重试",
      fields: validationFields(parsed.error),
    },
  });
  return undefined;
}

function washRuntimeMode(): WashRuntimeMode {
  return process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production" ? "real" : "demo";
}

function washLocationProofSecret(): string | null {
  if (washRuntimeMode() === "demo") return WASH_DEMO_LOCATION_PROOF_SECRET;
  const secret = process.env.WASH_LOCATION_PROOF_SECRET?.trim();
  return (secret?.length ?? 0) >= 32 ? secret! : null;
}

function washLocationProofPayload(value: WashLocationProofValue, expiresSeconds: number): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    exp: expiresSeconds,
    poiId: value.poiId,
    title: value.title,
    address: value.address,
    district: value.district,
    latitude: value.latitude,
    longitude: value.longitude,
    source: value.source,
  })).toString("base64url");
}

export function createWashLocationProof(value: WashLocationProofValue): string {
  const secret = washLocationProofSecret();
  if (!secret) throw new Error("WASH_LOCATION_PROOF_NOT_CONFIGURED");
  const payload = washLocationProofPayload(value, Math.floor(Date.now() / 1000) + WASH_LOCATION_PROOF_SECONDS);
  const signature = createHmac("sha256", secret).update(`wash-location-proof:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function validWashLocationProof(value: z.infer<typeof washLocationSuggestionSchema>): boolean {
  const secret = washLocationProofSecret();
  if (!secret || !value.locationProof) return false;
  const [payload, signature] = value.locationProof.split(".");
  if (!payload || !signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`wash-location-proof:${payload}`).digest("base64url"));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return parsed.v === 1
      && Number(parsed.exp) > Math.floor(Date.now() / 1000)
      && parsed.poiId === value.poiId
      && parsed.title === value.title
      && parsed.address === value.address
      && parsed.district === value.district
      && Number(parsed.latitude) === value.latitude
      && Number(parsed.longitude) === value.longitude
      && parsed.source === value.source;
  } catch {
    return false;
  }
}

function verifiedAdminStoreLocation(
  candidate: z.infer<typeof adminStoreLocationSchema>,
  problem: ProblemFactory,
): z.infer<typeof adminStoreLocationSchema> {
  if (washRuntimeMode() === "real" && candidate.source === "demo") {
    throw problem(409, "WASH_STORE_LOCATION_PROOF_INVALID", "生产环境不能使用演示门店位置，请重新搜索并选择真实地址");
  }
  if (!candidate.locationProof || !validWashLocationProof(candidate)) {
    throw problem(409, "WASH_STORE_LOCATION_PROOF_INVALID", "门店位置凭证无效或已过期，请重新搜索并选择地址");
  }
  return candidate;
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value ?? "null"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function multipartField(part: any, name: string): string | undefined {
  const field = part?.fields?.[name];
  if (!field) return undefined;
  if (Array.isArray(field)) {
    const first = field[0];
    return first && "value" in first ? String(first.value) : undefined;
  }
  return "value" in field ? String(field.value) : undefined;
}

async function receiveWashStoreImage(request: unknown, problem: ProblemFactory) {
  let part: any;
  try {
    part = await (request as { file: () => Promise<any> }).file();
  } catch {
    throw problem(413, "WASH_STORE_IMAGE_TOO_LARGE", "单张门店图片不能超过 10MB");
  }
  if (!part) throw problem(400, "WASH_STORE_IMAGE_REQUIRED", "请选择要上传的门店图片");
  if (!/^image\/(jpeg|png|webp)$/iu.test(String(part.mimetype ?? ""))) {
    throw problem(415, "WASH_STORE_IMAGE_TYPE_INVALID", "仅支持 JPEG、PNG 或 WebP 图片");
  }
  let source: Buffer;
  try {
    source = await part.toBuffer();
  } catch {
    throw problem(413, "WASH_STORE_IMAGE_TOO_LARGE", "单张门店图片不能超过 10MB");
  }
  if (source.length > 10 * 1024 * 1024) {
    throw problem(413, "WASH_STORE_IMAGE_TOO_LARGE", "单张门店图片不能超过 10MB");
  }
  try {
    const metadata = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || Number(metadata.pages ?? 1) > 1) {
      throw new Error("unsupported image format");
    }
    const processed = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { part, data: processed.data, info: processed.info };
  } catch {
    throw problem(400, "WASH_STORE_IMAGE_INVALID", "图片损坏或无法识别，请重新选择");
  }
}

type WashStoreAudience = "public" | "provider" | "platform";
type WashStoreImageResponse = Omit<WashStoreImageDto, "dataKind" | "createdAt"> & {
  dataKind?: WashStoreImageDto["dataKind"];
  createdAt?: string;
};

function storeImageFromRow(row: Row, audience: WashStoreAudience = "public"): WashStoreImageResponse {
  return {
    id: String(row.id),
    url: `${audience === "public" ? "/api" : "/api/admin"}/wash/store-images/${String(row.id)}`,
    mimeType: "image/jpeg",
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    sortOrder: Number(row.sort_order),
    isCover: bool(row.is_cover),
    isStored: true,
    ...(audience === "provider" ? {} : {
      dataKind: String(row.data_kind) === "real" ? "real" as const : "demo" as const,
      createdAt: String(row.created_at),
    }),
  };
}

async function storeImages(
  database: AppDatabase,
  storeId: string,
  audience: WashStoreAudience = "public",
) {
  const rows = await database.prepare<Row>(`
    SELECT * FROM wash_store_images
    WHERE store_id = ?
    ORDER BY is_cover DESC, sort_order, created_at, id
  `).all(storeId);
  return rows.map((row) => storeImageFromRow(row, audience));
}

async function removeStoredWashImage(uploadRoot: string, row: Row): Promise<void> {
  if (row.storage_key == null) return;
  const storageKey = String(row.storage_key);
  if (!/^[a-f0-9-]{36}\.jpg$/iu.test(storageKey)) return;
  try {
    await unlink(join(uploadRoot, storageKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function cleanupWashStoreImageOrphans(database: AppDatabase, uploadRoot: string): Promise<void> {
  const referencedRows = await database.prepare<Row>("SELECT storage_key FROM wash_store_images").all();
  const referenced = new Set(referencedRows.map((row) => String(row.storage_key)));
  const entries = await readdir(uploadRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.jpg$/iu.test(entry.name) || referenced.has(entry.name)) continue;
    try {
      await unlink(join(uploadRoot, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function washCategoryFromSnapshot(rawCategory: unknown, rawSnapshot: unknown): WashVehicleCategory {
  const snapshot = jsonObject(rawSnapshot);
  return inferWashVehicleCategory({
    persisted: rawCategory,
    vehicleType: snapshot?.vehicleType,
    modelName: snapshot?.modelName,
    brandName: snapshot?.brandName,
    seats: snapshot?.seats,
  });
}

function canonicalVehicleSnapshot(rawSnapshot: unknown, category: WashVehicleCategory) {
  const snapshot = jsonObject(rawSnapshot);
  return snapshot ? { ...snapshot, washVehicleCategory: category } : null;
}

function toMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function shanghaiTime(now = new Date()): string {
  const parts = shanghaiTimeFormatter.formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("hour")}:${read("minute")}`;
}

function washSlotHasStarted(slot: Row, now = new Date()): boolean {
  const currentDate = businessDate();
  const slotDate = String(slot.date);
  return slotDate < currentDate
    || (slotDate === currentDate && String(slot.start_time) <= shanghaiTime(now));
}

function fromMinutes(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

const weekdayByNumber: Array<z.infer<typeof weekdaySchema>> = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const demoWashPickupPois = [
  { title: "天津文化中心地下停车场", address: "河西区平江道 58 号", district: "河西区", latitude: 39.0837, longitude: 117.2197 },
  { title: "天津站南广场停车场", address: "河北区海河东路天津站南广场", district: "河北区", latitude: 39.1362, longitude: 117.2106 },
  { title: "鲁能城购物中心停车场", address: "南开区水上公园北道与水上公园东路交口", district: "南开区", latitude: 39.0878, longitude: 117.1776 },
  { title: "天津万象城停车场", address: "河西区乐园道 9 号", district: "河西区", latitude: 39.0896, longitude: 117.2138 },
  { title: "和平大悦城停车场", address: "和平区南京路 189 号", district: "和平区", latitude: 39.118, longitude: 117.1951 },
  { title: "河东万达广场停车场", address: "河东区津滨大道 53 号", district: "河东区", latitude: 39.1171, longitude: 117.2631 },
  { title: "第六大道第博雅园", address: "河东区昆仑路第六大道博雅园（演示坐标）", district: "河东区", latitude: 39.1059, longitude: 117.2445 },
] as const;

function pickupCoordinatesMatch(
  candidate: { latitude: number; longitude: number },
  resolved: { latitude: number; longitude: number },
): boolean {
  return Math.abs(candidate.latitude - resolved.latitude) <= 0.001
    && Math.abs(candidate.longitude - resolved.longitude) <= 0.001;
}

async function verifiedWashPickupAddress(
  candidate: z.infer<typeof pickupAddressSchema>,
  problem: ProblemFactory,
): Promise<z.infer<typeof pickupAddressSchema>> {
  const production = washRuntimeMode() === "real";
  const demoLocationsAllowed = !production && (
    process.env.YUXIAOMAN_ALLOW_DEMO_LOCATIONS === "true"
    || process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK === "true"
  );
  if (candidate.source === "demo" && !demoLocationsAllowed) {
    throw problem(409, "WASH_DEMO_PICKUP_NOT_ALLOWED", "当前环境不允许使用演示取车地址");
  }
  if (candidate.locationProof) {
    if (!validWashLocationProof(candidate)) {
      throw problem(409, "WASH_PICKUP_PROOF_INVALID", "取车地址凭证无效或已过期，请重新选择");
    }
    return candidate;
  }
  if (production) {
    throw problem(409, "WASH_PICKUP_PROOF_REQUIRED", "取车地址缺少服务端校验凭证，请重新选择");
  }
  if (candidate.source === "demo") {
    const resolved = demoWashPickupPois.find((poi) =>
      poi.title === candidate.title
      && poi.address === candidate.address
      && poi.district === candidate.district
      && pickupCoordinatesMatch(candidate, poi));
    if (!resolved || !candidate.poiId.startsWith("demo-tianjin-")) {
      throw problem(409, "WASH_PICKUP_POI_INVALID", "取车地址与服务端演示地址不一致，请重新选择");
    }
    return { ...resolved, poiId: candidate.poiId, source: "demo", detail: candidate.detail, note: candidate.note };
  }

  const key = process.env.TENCENT_MAP_KEY?.trim();
  if (!key) {
    throw problem(503, "WASH_REAL_ROUTE_REQUIRED", "当前无法校验取车地址，请稍后重试", {
      mapErrorCode: "TENCENT_KEY_MISSING",
    });
  }
  try {
    const parameters = new URLSearchParams({
      keyword: candidate.title,
      region: "天津",
      region_fix: "1",
      policy: "1",
      key,
    });
    const response = await fetch(`https://apis.map.qq.com/ws/place/v1/suggestion/?${parameters}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const payload = (await response.json()) as {
      status?: number;
      data?: Array<{
        id?: string;
        title?: string;
        address?: string;
        district?: string;
        location?: { lat?: number; lng?: number };
      }>;
    };
    if (payload.status !== 0 || !Array.isArray(payload.data)) {
      const code = payload.status === 121
        ? "TENCENT_QUOTA_EXCEEDED"
        : [110, 111, 112, 120].includes(Number(payload.status)) || response.status === 401 || response.status === 403
          ? "TENCENT_UNAUTHORIZED"
          : "TENCENT_UNAVAILABLE";
      throw problem(503, "WASH_REAL_ROUTE_REQUIRED", "当前无法校验取车地址，请稍后重试", {
        mapErrorCode: code,
      });
    }
    const match = candidate.source === "tencent"
      ? payload.data.find((item) => String(item.id ?? "") === candidate.poiId)
      : payload.data.find((item) => String(item.title ?? "") === candidate.title
        || String(item.address ?? "") === candidate.address);
    const latitude = Number(match?.location?.lat);
    const longitude = Number(match?.location?.lng);
    if (!match || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw problem(409, "WASH_PICKUP_POI_INVALID", "未能在位置服务中确认该取车地址，请重新选择");
    }
    const resolved = { latitude, longitude };
    if (!pickupCoordinatesMatch(candidate, resolved)) {
      throw problem(409, "WASH_PICKUP_POI_MISMATCH", "取车地址坐标与位置服务结果不一致，请重新选择");
    }
    return {
      poiId: String(match.id ?? candidate.poiId),
      title: String(match.title ?? candidate.title),
      address: String(match.address ?? candidate.address),
      district: String(match.district ?? candidate.district),
      latitude,
      longitude,
      source: candidate.source,
      detail: candidate.detail,
      note: candidate.note,
    };
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    throw problem(503, "WASH_REAL_ROUTE_REQUIRED", "当前无法校验取车地址，请稍后重试", {
      mapErrorCode: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
        ? "TENCENT_TIMEOUT"
        : "TENCENT_UNAVAILABLE",
    });
  }
}

function estimatedDistanceKm(originLat: number, originLng: number, row: Row): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(Number(row.latitude) - originLat);
  const dLng = radians(Number(row.longitude) - originLng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(originLat)) * Math.cos(radians(Number(row.latitude))) * Math.sin(dLng / 2) ** 2;
  const direct = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(0.1, Math.ceil(direct * 1.25 * 10) / 10);
}

async function resolvedWashValetRule(
  database: AppDatabase,
  storeId: string,
  problem: ProblemFactory,
) {
  const override = await database.prepare<Row>(`
    SELECT * FROM wash_store_valet_pricing_overrides WHERE store_id = ?
  `).get(storeId);
  if (override) {
    const rule = {
      scope: "store" as const,
      storeId,
      baseFeeFen: Number(override.base_fee_fen),
      includedKm: Number(override.included_km),
      perKmFen: Number(override.per_km_fen),
      maxRadiusKm: override.max_radius_km == null ? null : Number(override.max_radius_km),
      updatedAt: String(override.updated_at),
    };
    return { ...rule, version: inspectionResultRequestHash(rule) };
  }
  const global = await database.prepare<Row>(`
    SELECT * FROM valet_pricing_rules WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1
  `).get();
  if (!global) throw problem(409, "WASH_VALET_RULE_MISSING", "代驾取送计价规则尚未配置");
  const rule = {
    scope: "global" as const,
    storeId: null,
    baseFeeFen: Number(global.base_fee_fen),
    includedKm: Number(global.included_km),
    perKmFen: Number(global.per_km_fen),
    maxRadiusKm: global.max_radius_km_limit == null ? null : Number(global.max_radius_km_limit),
    updatedAt: String(global.updated_at),
  };
  return { ...rule, version: inspectionResultRequestHash(rule) };
}

function packageFromRow(row: Row) {
  const serviceItems = jsonArray(row.service_items_json);
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    shortDescription: String(row.short_description ?? ""),
    serviceItems,
    includedItems: serviceItems,
    durationMinutes: Number(row.duration_minutes),
    sortOrder: Number(row.sort_order),
    isActive: bool(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function storeFromRow(
  database: AppDatabase,
  row: Row,
  origin?: { latitude: number; longitude: number },
  audience: WashStoreAudience = "public",
): Promise<Record<string, unknown>> {
  const images = await storeImages(database, String(row.id), audience);
  const coverImageUrl = images.find((image) => image.isCover)?.url
    ?? images[0]?.url
    ?? (row.cover_image_url == null ? null : String(row.cover_image_url));
  const starting = await database.prepare<Row>(`
    SELECT MIN(sale_price_fen) AS price
    FROM wash_store_offers
    WHERE store_id = ? AND is_available = 1
  `).get(String(row.id)) ?? {};
  const distanceKm = origin ? estimatedDistanceKm(origin.latitude, origin.longitude, row) : null;
  let weeklySchedule: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.weekly_schedule_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) weeklySchedule = parsed;
  } catch {
    weeklySchedule = {};
  }
  return {
    id: String(row.id),
    serviceType: "car_wash" as const,
    name: String(row.name),
    ...(audience !== "public" ? {
      legalName: row.legal_name == null ? null : String(row.legal_name),
    } : {}),
    district: String(row.district),
    address: String(row.address),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    phone: row.phone == null ? null : String(row.phone),
    coverImageUrl,
    imageCount: images.length,
    images,
    description: String(row.description ?? ""),
    tags: jsonArray(row.tags_json),
    facilities: jsonArray(row.facilities_json),
    openHours: String(row.open_hours),
    weeklySchedule,
    businessHoursNotice: row.business_hours_notice == null ? null : String(row.business_hours_notice),
    advanceBookingDays: Number(row.advance_booking_days),
    ...(audience === "provider" ? {} : {
      rating: Number(row.rating),
      reviewCount: Number(row.review_count),
      dataKind: String(row.data_kind) === "real" ? "real" as const : "demo" as const,
    }),
    isActive: bool(row.is_active),
    isOpen: bool(row.is_active),
    ...(audience === "provider" ? {} : { sortPriority: Number(row.sort_priority) }),
    ...(audience === "platform" ? {
      internalContact: row.internal_contact_name == null && row.internal_contact_phone == null
        ? null
        : {
            name: row.internal_contact_name == null ? "" : String(row.internal_contact_name),
            phone: row.internal_contact_phone == null ? "" : String(row.internal_contact_phone),
          },
    } : {}),
    ...(audience === "provider" ? {} : {
      startingPriceFen: starting.price == null ? null : Number(starting.price),
      distanceKm,
      distanceSource: origin ? "estimated" as const : "not_calculated" as const,
      distanceBasis: origin ? "estimated_distance" as const : "no_origin" as const,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }),
  };
}

function offerFromRow(row: Row, includePlatformFields = true) {
  const category = inferWashVehicleCategory({ persisted: row.vehicle_category });
  const serviceItems = jsonArray(row.service_items_json);
  const packageValue = row.package_name == null ? undefined : {
    id: String(row.package_id),
    code: String(row.package_code),
    name: String(row.package_name),
    shortDescription: String(row.package_short_description ?? ""),
    serviceItems,
    includedItems: serviceItems,
    durationMinutes: Number(row.duration_minutes),
    sortOrder: Number(row.package_sort_order ?? 0),
    isActive: bool(row.package_is_active),
  };
  return {
    storeId: String(row.store_id),
    packageId: String(row.package_id),
    ...(packageValue ? { package: packageValue } : {}),
    vehicleCategory: category,
    vehicleType: category,
    salePriceFen: Number(row.sale_price_fen),
    listPriceFen: row.list_price_fen == null ? null : Number(row.list_price_fen),
    ...(includePlatformFields ? {
      estimatedSettlementFen: row.estimated_settlement_fen == null
        ? Number(row.sale_price_fen)
        : Number(row.estimated_settlement_fen),
    } : {}),
    isAvailable: bool(row.is_available),
    isActive: bool(row.is_available),
    updatedAt: String(row.updated_at),
  };
}

async function storeOfferRows(database: AppDatabase, storeId: string, forUpdate = false): Promise<Row[]> {
  return database.prepare<Row>(`
    SELECT o.*, p.code AS package_code, p.name AS package_name,
      p.short_description AS package_short_description, p.service_items_json,
      p.duration_minutes, p.sort_order AS package_sort_order, p.is_active AS package_is_active
    FROM wash_store_offers o JOIN wash_packages p ON p.id = o.package_id
    WHERE o.store_id = ?
    ORDER BY p.sort_order, p.id, o.vehicle_category
    ${forUpdate ? "FOR UPDATE OF o" : ""}
  `).all(storeId);
}

async function findStore(
  database: AppDatabase,
  id: string,
  forUpdate = false,
  scopedToStoreId?: string,
): Promise<Row | undefined> {
  return scopedToStoreId
    ? database.prepare<Row>(`SELECT * FROM wash_stores WHERE id = ? AND id = ?${forUpdate ? " FOR UPDATE" : ""}`)
      .get(id, scopedToStoreId)
    : database.prepare<Row>(`SELECT * FROM wash_stores WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`).get(id);
}

async function findPackage(database: AppDatabase, id: string, forUpdate = false): Promise<Row | undefined> {
  return database.prepare<Row>(`SELECT * FROM wash_packages WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`).get(id);
}

async function findSlot(
  database: AppDatabase,
  id: string,
  forUpdate = false,
  scopedToStoreId?: string,
): Promise<Row | undefined> {
  return scopedToStoreId
    ? database.prepare<Row>(`SELECT * FROM wash_slots WHERE id = ? AND store_id = ?${forUpdate ? " FOR UPDATE" : ""}`)
      .get(id, scopedToStoreId)
    : database.prepare<Row>(`SELECT * FROM wash_slots WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`).get(id);
}

async function findOwnerVehicle(database: AppDatabase, id: string, currentUserId: string, forUpdate = false): Promise<Row | undefined> {
  return database.prepare<Row>(`
    SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    ${forUpdate ? "FOR UPDATE" : ""}
  `).get(id, currentUserId);
}

async function activeReservationCount(database: AppDatabase, slotId: string, now = new Date().toISOString()): Promise<number> {
  const row = await database.prepare<Row>(`
    SELECT COUNT(*) AS count FROM wash_orders
    WHERE slot_id = ? AND (
      status IN ('awaiting_redemption', 'redeemed')
      OR (status = 'pending_payment' AND hold_expires_at > ?)
    )
  `).get(slotId, now);
  return Number(row?.count ?? 0);
}

async function slotFromRow(database: AppDatabase, row: Row) {
  const reservedCount = await activeReservationCount(database, String(row.id));
  return {
    id: String(row.id),
    storeId: String(row.store_id),
    date: String(row.date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    capacity: Number(row.capacity),
    isOpen: bool(row.is_open),
    reservedCount,
    bookedCount: reservedCount,
    remaining: Math.max(0, Number(row.capacity) - reservedCount),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function paymentFromRow(row: Row) {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    provider: String(row.provider),
    kind: String(row.kind),
    idempotencyKey: String(row.idempotency_key),
    amountFen: Number(row.amount_fen),
    status: String(row.status),
    createdAt: String(row.created_at),
    confirmedAt: String(row.confirmed_at),
  };
}

function eventFromRow(row: Row) {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    status: String(row.status),
    title: String(row.title),
    description: String(row.description),
    actorType: String(row.actor_type),
    metadata: jsonObject(row.metadata_json) ?? {},
    createdAt: String(row.created_at),
  };
}

function settlementFromRow(row: Row) {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    status: String(row.status),
    amountFen: Number(row.amount_fen),
    operator: row.operator == null ? null : String(row.operator),
    reason: row.reason == null ? null : String(row.reason),
    note: row.note == null ? null : String(row.note),
    settledAt: row.settled_at == null ? null : String(row.settled_at),
    updatedAt: String(row.updated_at),
  };
}

function settlementAuditSnapshot(row: Row) {
  return {
    status: String(row.status),
    amountFen: Number(row.amount_fen),
    settledAt: row.settled_at == null ? null : String(row.settled_at),
    updatedAt: String(row.updated_at),
  };
}

function washFeeBreakdown(
  value: unknown,
  fallback: {
    washFeeFen: number;
    valetBaseFeeFen: number;
    valetDistanceFeeFen: number;
    valetFeeFen: number;
    totalFeeFen: number;
  },
) {
  const parsed = jsonObject(value);
  if (!parsed) return fallback;
  const required = ["washFeeFen", "valetBaseFeeFen", "valetDistanceFeeFen", "valetFeeFen", "totalFeeFen"] as const;
  if (!required.every((key) => Number.isFinite(Number(parsed[key])) && Number(parsed[key]) >= 0)) return fallback;
  return Object.fromEntries(required.map((key) => [key, Number(parsed[key])])) as typeof fallback;
}

async function orderFromRow(database: AppDatabase, row: Row, includeEvents = true) {
  const id = String(row.id);
  const payments = (await database.prepare<Row>(`
    SELECT * FROM wash_order_payments WHERE order_id = ? ORDER BY created_at, id
  `).all(id)).map(paymentFromRow);
  const settlement = await database.prepare<Row>("SELECT * FROM wash_order_settlements WHERE order_id = ?").get(id);
  const events = includeEvents
    ? (await database.prepare<Row>(`
        SELECT * FROM wash_order_events WHERE order_id = ? ORDER BY created_at, id
      `).all(id)).map(eventFromRow)
    : undefined;
  const chargedFen = payments.filter((item) => item.kind === "charge").reduce((sum, item) => sum + item.amountFen, 0);
  const refundedFen = payments.filter((item) => item.kind === "refund").reduce((sum, item) => sum + item.amountFen, 0);
  const vehicle = jsonObject(row.vehicle_snapshot_json);
  const vehicleCategory = washCategoryFromSnapshot(row.vehicle_category, row.vehicle_snapshot_json);
  const store = jsonObject(row.store_snapshot_json);
  const packageValue = jsonObject(row.package_snapshot_json);
  const serviceMode = washServiceModeSchema.safeParse(row.service_mode).success
    ? String(row.service_mode) as z.infer<typeof washServiceModeSchema>
    : "self_drive" as const;
  const washFeeFen = row.wash_fee_fen == null ? Number(row.total_fee_fen) : Number(row.wash_fee_fen);
  const valetFeeFen = row.valet_fee_fen == null ? 0 : Number(row.valet_fee_fen);
  const pickupAddress = jsonObject(row.pickup_address_json);
  const valetRule = jsonObject(row.valet_rule_json);
  const fallbackBreakdown = {
    washFeeFen,
    valetBaseFeeFen: 0,
    valetDistanceFeeFen: valetFeeFen,
    valetFeeFen,
    totalFeeFen: Number(row.total_fee_fen),
  };
  const breakdown = washFeeBreakdown(row.fee_breakdown_json, fallbackBreakdown);
  const settlementValue = settlement ? settlementFromRow(settlement) : null;
  const redemptionCode = row.redemption_code == null ? null : String(row.redemption_code);
  return {
    id,
    serviceType: "car_wash" as const,
    orderNumber: String(row.order_number),
    vehicleId: String(row.vehicle_id),
    storeId: String(row.store_id),
    packageId: String(row.package_id),
    slotId: String(row.slot_id),
    quoteSnapshotId: String(row.quote_snapshot_id),
    vehicleCategory,
    vehicleType: vehicleCategory,
    contactName: String(row.contact_name),
    contactPhone: String(row.contact_phone),
    serviceMode,
    tripType: serviceMode === "valet" ? "round_trip_same_address" as const : null,
    serviceScope: serviceMode === "valet" ? "round_trip_same_address" as const : null,
    washFeeFen,
    valetFeeFen,
    totalFeeFen: Number(row.total_fee_fen),
    serviceFeeFen: Number(row.total_fee_fen),
    estimatedSettlementFen: row.estimated_settlement_fen == null
      ? Number(row.total_fee_fen)
      : Number(row.estimated_settlement_fen),
    status: String(row.status),
    paymentStatus: String(row.payment_status),
    redemptionCode,
    verificationCode: redemptionCode,
    redemptionCodeActive: row.redemption_code != null && String(row.status) === "awaiting_redemption",
    notes: row.notes == null ? null : String(row.notes),
    internalNote: row.internal_note == null ? null : String(row.internal_note),
    appointmentDate: String(row.appointment_date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    vehicle: canonicalVehicleSnapshot(vehicle, vehicleCategory),
    vehiclePlate: vehicle?.plateNumber == null ? null : String(vehicle.plateNumber),
    store,
    storeName: store?.name == null ? null : String(store.name),
    package: packageValue,
    packageName: packageValue?.name == null ? null : String(packageValue.name),
    slot: jsonObject(row.slot_snapshot_json),
    pickupAddress,
    oneWayDistanceKm: row.one_way_distance_km == null ? null : Number(row.one_way_distance_km),
    roundTripDistanceKm: row.round_trip_distance_km == null ? null : Number(row.round_trip_distance_km),
    billableDistanceKm: row.billable_distance_km == null ? null : Number(row.billable_distance_km),
    driveMinutes: row.drive_minutes == null ? null : Number(row.drive_minutes),
    distanceSource: String(row.distance_source ?? "not_calculated"),
    distanceBasis: String(row.distance_basis ?? "no_origin"),
    extraKm: Number(row.quote_extra_km ?? 0),
    valetRule,
    breakdown,
    holdExpiresAt: String(row.hold_expires_at),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    redeemedAt: row.redeemed_at == null ? null : String(row.redeemed_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    refundedAt: row.refunded_at == null ? null : String(row.refunded_at),
    expiredAt: row.expired_at == null ? null : String(row.expired_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    chargedFen,
    paidFen: chargedFen,
    refundedFen,
    netPaidFen: Math.max(0, chargedFen - refundedFen),
    payments,
    settlement: settlementValue,
    settlementStatus: settlementValue?.status ?? "unsettled",
    actualSettlementFen: settlementValue?.status === "settled" ? settlementValue.amountFen : null,
    ...(events ? { events } : {}),
  };
}

/**
 * A deliberately separate merchant DTO. Do not derive this with object spread
 * from the platform DTO: newly-added private fields must fail closed instead of
 * silently becoming visible to a wash store.
 */
async function washStoreOrderFromRow(database: AppDatabase, row: Row) {
  const vehicle = jsonObject(row.vehicle_snapshot_json);
  const packageValue = jsonObject(row.package_snapshot_json);
  const slot = jsonObject(row.slot_snapshot_json);
  const vehicleCategory = washCategoryFromSnapshot(row.vehicle_category, row.vehicle_snapshot_json);
  const settlement = await database.prepare<Row>(`
    SELECT status, amount_fen, settled_at, updated_at
    FROM wash_order_settlements
    WHERE order_id = ?
  `).get(String(row.id));
  const serviceMode = washServiceModeSchema.safeParse(row.service_mode).success
    ? String(row.service_mode) as z.infer<typeof washServiceModeSchema>
    : "self_drive" as const;

  return {
    id: String(row.id),
    serviceType: "car_wash" as const,
    orderNumber: String(row.order_number),
    storeId: String(row.store_id),
    packageId: String(row.package_id),
    slotId: String(row.slot_id),
    vehicleCategory,
    vehicleType: vehicleCategory,
    vehiclePlate: vehicle?.plateNumber == null ? null : String(vehicle.plateNumber),
    vehicle: vehicle ? {
      plateNumber: vehicle.plateNumber == null ? null : String(vehicle.plateNumber),
      vehicleType: vehicle.vehicleType == null ? null : String(vehicle.vehicleType),
      seats: vehicle.seats == null ? null : Number(vehicle.seats),
      exteriorColor: vehicle.exteriorColor == null ? null : String(vehicle.exteriorColor),
      washVehicleCategory: vehicleCategory,
    } : null,
    package: packageValue ? {
      id: packageValue.id == null ? String(row.package_id) : String(packageValue.id),
      code: packageValue.code == null ? null : String(packageValue.code),
      name: packageValue.name == null ? null : String(packageValue.name),
      shortDescription: packageValue.shortDescription == null ? "" : String(packageValue.shortDescription),
      serviceItems: Array.isArray(packageValue.serviceItems)
        ? packageValue.serviceItems.map(String)
        : Array.isArray(packageValue.includedItems) ? packageValue.includedItems.map(String) : [],
      durationMinutes: packageValue.durationMinutes == null ? null : Number(packageValue.durationMinutes),
    } : null,
    packageName: packageValue?.name == null ? null : String(packageValue.name),
    slot: slot ? {
      id: slot.id == null ? String(row.slot_id) : String(slot.id),
      date: slot.date == null ? String(row.appointment_date) : String(slot.date),
      startTime: slot.startTime == null ? String(row.start_time) : String(slot.startTime),
      endTime: slot.endTime == null ? String(row.end_time) : String(slot.endTime),
    } : {
      id: String(row.slot_id),
      date: String(row.appointment_date),
      startTime: String(row.start_time),
      endTime: String(row.end_time),
    },
    appointmentDate: String(row.appointment_date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    serviceMode,
    tripType: serviceMode === "valet" ? "round_trip_same_address" as const : null,
    washFeeFen: row.wash_fee_fen == null ? Number(row.total_fee_fen) : Number(row.wash_fee_fen),
    valetFeeFen: row.valet_fee_fen == null ? 0 : Number(row.valet_fee_fen),
    totalFeeFen: Number(row.total_fee_fen),
    serviceFeeFen: Number(row.total_fee_fen),
    status: String(row.status),
    paymentStatus: String(row.payment_status),
    redeemedAt: row.redeemed_at == null ? null : String(row.redeemed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    settlement: settlement ? {
      status: String(settlement.status),
      amountFen: String(settlement.status) === "settled" ? Number(settlement.amount_fen) : null,
      settledAt: settlement.settled_at == null ? null : String(settlement.settled_at),
      updatedAt: String(settlement.updated_at),
    } : null,
    settlementStatus: settlement == null ? "unsettled" : String(settlement.status),
    actualSettlementFen: settlement != null && String(settlement.status) === "settled"
      ? Number(settlement.amount_fen)
      : null,
  };
}

function quoteFromRow(row: Row) {
  const serviceMode = washServiceModeSchema.safeParse(row.service_mode).success
    ? String(row.service_mode) as z.infer<typeof washServiceModeSchema>
    : "self_drive" as const;
  const washFeeFen = row.wash_fee_fen == null ? Number(row.sale_price_fen) : Number(row.wash_fee_fen);
  const valetFeeFen = row.valet_fee_fen == null ? 0 : Number(row.valet_fee_fen);
  const totalFeeFen = row.total_fee_fen == null ? washFeeFen + valetFeeFen : Number(row.total_fee_fen);
  const vehicleCategory = washCategoryFromSnapshot(row.vehicle_category, row.vehicle_snapshot_json);
  return {
    id: String(row.id),
    quoteSnapshotId: String(row.id),
    serviceType: "car_wash" as const,
    vehicleId: String(row.vehicle_id),
    storeId: String(row.store_id),
    packageId: String(row.package_id),
    slotId: String(row.slot_id),
    vehicleCategory,
    vehicleType: vehicleCategory,
    serviceMode,
    tripType: serviceMode === "valet" ? "round_trip_same_address" as const : null,
    serviceScope: serviceMode === "valet" ? "round_trip_same_address" as const : null,
    serviceable: true,
    salePriceFen: Number(row.sale_price_fen),
    washFeeFen,
    valetFeeFen,
    totalFeeFen,
    listPriceFen: row.list_price_fen == null ? null : Number(row.list_price_fen),
    estimatedSettlementFen: row.estimated_settlement_fen == null
      ? Number(row.sale_price_fen)
      : Number(row.estimated_settlement_fen),
    vehicle: canonicalVehicleSnapshot(row.vehicle_snapshot_json, vehicleCategory),
    store: jsonObject(row.store_snapshot_json),
    package: jsonObject(row.package_snapshot_json),
    slot: jsonObject(row.slot_snapshot_json),
    pickupAddress: jsonObject(row.pickup_address_json),
    oneWayDistanceKm: row.one_way_distance_km == null ? null : Number(row.one_way_distance_km),
    roundTripDistanceKm: row.round_trip_distance_km == null ? null : Number(row.round_trip_distance_km),
    billableDistanceKm: row.billable_distance_km == null ? null : Number(row.billable_distance_km),
    driveMinutes: row.drive_minutes == null ? null : Number(row.drive_minutes),
    distanceSource: String(row.distance_source ?? "not_calculated"),
    distanceBasis: String(row.distance_basis ?? "no_origin"),
    extraKm: Number(row.quote_extra_km ?? 0),
    valetRule: jsonObject(row.valet_rule_json),
    breakdown: washFeeBreakdown(row.fee_breakdown_json, {
      washFeeFen,
      valetBaseFeeFen: 0,
      valetDistanceFeeFen: valetFeeFen,
      valetFeeFen,
      totalFeeFen,
    }),
    offerVersion: String(row.offer_version),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

async function activeOfferRow(
  database: AppDatabase,
  storeId: string,
  packageId: string,
  category: string,
  forUpdate = false,
): Promise<Row | undefined> {
  return database.prepare<Row>(`
    SELECT o.*, p.code AS package_code, p.name AS package_name,
      p.short_description AS package_short_description,
      p.service_items_json, p.duration_minutes, p.sort_order AS package_sort_order,
      p.is_active AS package_is_active
    FROM wash_store_offers o
    JOIN wash_packages p ON p.id = o.package_id
    WHERE o.store_id = ? AND o.package_id = ? AND o.vehicle_category = ?
      AND o.is_available = 1 AND p.is_active = 1
    ${forUpdate ? "FOR UPDATE OF o" : ""}
  `).get(storeId, packageId, category);
}

async function findOrder(
  database: AppDatabase,
  id: string,
  currentUserId?: string,
  forUpdate = false,
  scopedToStoreId?: string,
): Promise<Row | undefined> {
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  const clauses = ["id = ?"];
  const values: string[] = [id];
  if (currentUserId) {
    clauses.push("user_id = ?");
    values.push(currentUserId);
  }
  if (scopedToStoreId) {
    clauses.push("store_id = ?");
    values.push(scopedToStoreId);
  }
  return database.prepare<Row>(`SELECT * FROM wash_orders WHERE ${clauses.join(" AND ")}${lockClause}`)
    .get(...values);
}

async function insertEvent(
  database: AppDatabase,
  orderId: string,
  status: string,
  title: string,
  description: string,
  actorType: "owner" | "operator" | "system",
  metadata: Record<string, unknown> = {},
  createdAt = new Date().toISOString(),
): Promise<void> {
  await database.prepare(`
    INSERT INTO wash_order_events (
      id, order_id, status, title, description, actor_type, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), orderId, status, title, description, actorType, JSON.stringify(metadata), createdAt);
}

async function expirePendingOrders(database: AppDatabase): Promise<void> {
  const now = new Date().toISOString();
  await database.transaction(async (tx) => {
    const rows = await tx.prepare<Row>(`
      SELECT id FROM wash_orders
      WHERE status = 'pending_payment' AND hold_expires_at <= ?
      FOR UPDATE SKIP LOCKED
    `).all(now);
    for (const row of rows) {
      const id = String(row.id);
      await tx.prepare(`
        UPDATE wash_orders SET status = 'expired', expired_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending_payment'
      `).run(now, now, id);
      await tx.prepare(`
        UPDATE wash_order_settlements
        SET status = 'void', operator = 'system', reason = 'payment_timeout', updated_at = ?
        WHERE order_id = ?
      `).run(now, id);
      await insertEvent(tx, id, "expired", "待支付订单已关闭", "15 分钟支付占位已到期，预约时段已释放", "system", {}, now);
    }
  });
}

function orderNumber(): string {
  return `WASH${businessDate().replaceAll("-", "")}${randomUUID().slice(0, 6).toUpperCase()}`;
}

async function generateRedemptionCode(database: AppDatabase): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!await database.prepare("SELECT 1 FROM wash_orders WHERE redemption_code = ?").get(code)) return code;
  }
  throw new Error("Unable to allocate a unique wash redemption code");
}

async function insertRefundPayment(
  database: AppDatabase,
  row: Row,
  idempotencyKey: string,
  now: string,
): Promise<void> {
  const existing = await database.prepare(`
    SELECT id FROM wash_order_payments WHERE provider = 'mock' AND idempotency_key = ?
  `).get(idempotencyKey);
  if (existing) return;
  await database.prepare(`
    INSERT INTO wash_order_payments (
      id, order_id, provider, kind, idempotency_key, amount_fen,
      status, created_at, confirmed_at
    ) VALUES (?, ?, 'mock', 'refund', ?, ?, 'confirmed', ?, ?)
  `).run(randomUUID(), String(row.id), idempotencyKey, Number(row.total_fee_fen), now, now);
}

async function cancelOrRefundOrder(
  database: AppDatabase,
  row: Row,
  actorType: "owner" | "operator",
  reason: string,
  operator?: string,
): Promise<"cancelled" | "refunded"> {
  const current = String(row.status);
  if (current === "cancelled") return "cancelled";
  if (current === "refunded") return "refunded";
  if (current === "expired") throw new Error("WASH_ORDER_EXPIRED");
  if (current === "redeemed") {
    const settlement = await database.prepare<Row>("SELECT status FROM wash_order_settlements WHERE order_id = ? FOR UPDATE").get(String(row.id));
    if (String(settlement?.status) === "settled") throw new Error("WASH_ORDER_ALREADY_SETTLED");
  }
  const now = new Date().toISOString();
  const paid = String(row.payment_status) === "paid";
  const next = paid ? "refunded" as const : "cancelled" as const;
  if (paid) await insertRefundPayment(database, row, `wash-refund-${row.id}`, now);
  await database.prepare(`
    UPDATE wash_orders SET
      status = ?, payment_status = ?, updated_at = ?,
      cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
      refunded_at = CASE WHEN ? = 'refunded' THEN ? ELSE refunded_at END
    WHERE id = ?
  `).run(next, paid ? "refunded" : "unpaid", now, next, now, next, now, String(row.id));
  await database.prepare(`
    UPDATE wash_order_settlements SET
      status = 'void', operator = ?, reason = ?, settled_at = NULL, updated_at = ?
    WHERE order_id = ?
  `).run(operator ?? actorType, reason, now, String(row.id));
  await insertEvent(
    database,
    String(row.id),
    next,
    paid ? "洗车订单已退款" : "洗车订单已取消",
    paid ? "已支付金额已按模拟支付流程原路退回，核销码同步失效" : "待支付预约已取消，预约时段已释放",
    actorType,
    { reason, operator: operator ?? null },
    now,
  );
  return next;
}

function throwWashProblem(problem: ProblemFactory, error: unknown): never {
  if (error instanceof Error && error.message === "WASH_ORDER_EXPIRED") {
    throw problem(409, "WASH_ORDER_EXPIRED", "待支付订单已过期");
  }
  if (error instanceof Error && error.message === "WASH_ORDER_ALREADY_SETTLED") {
    throw problem(409, "WASH_ORDER_ALREADY_SETTLED", "已结算订单需要先填写原因修正结算状态后才能退款");
  }
  throw error;
}

function vehicleSnapshot(row: Row, category: WashVehicleCategory) {
  return {
    id: String(row.id),
    plateNumber: String(row.plate_number),
    vehicleType: String(row.vehicle_type),
    seats: Number(row.seats),
    exteriorColor: row.exterior_color == null ? null : String(row.exterior_color),
    washVehicleCategory: category,
  };
}

function washCategoryFromVehicle(row: Row): WashVehicleCategory {
  return inferWashVehicleCategory({
    persisted: row.wash_vehicle_category,
    vehicleType: row.vehicle_type,
    modelName: row.model_name,
    brandName: row.brand_name,
    seats: row.seats,
  });
}

async function assertSlotCanReserve(
  database: AppDatabase,
  problem: ProblemFactory,
  slot: Row,
  durationMinutes: number,
  slotNow: Date,
  excludeOrderId?: string,
): Promise<void> {
  if (!bool(slot.is_open)) throw problem(409, "WASH_SLOT_CLOSED", "该预约时段已关闭");
  if (washSlotHasStarted(slot, slotNow)) throw problem(409, "WASH_SLOT_PAST", "不能预约已开始或已过去的时段");
  if (toMinutes(String(slot.end_time)) - toMinutes(String(slot.start_time)) < durationMinutes) {
    throw problem(409, "WASH_SLOT_TOO_SHORT", "该时段不足以完成所选服务");
  }
  const now = new Date().toISOString();
  const row = await database.prepare<Row>(`
    SELECT COUNT(*) AS count FROM wash_orders
    WHERE slot_id = ? AND id <> ? AND (
      status IN ('awaiting_redemption', 'redeemed')
      OR (status = 'pending_payment' AND hold_expires_at > ?)
    )
  `).get(String(slot.id), excludeOrderId ?? "", now);
  if (Number(row?.count ?? 0) >= Number(slot.capacity)) {
    throw problem(409, "WASH_SLOT_FULL", "该时段刚刚约满，请选择其他时段");
  }
}

async function assertVehicleHasNoOverlap(
  database: AppDatabase,
  problem: ProblemFactory,
  vehicleId: string,
  slot: Row,
  excludeOrderId?: string,
): Promise<void> {
  const overlap = await database.prepare(`
    SELECT id FROM wash_orders
    WHERE vehicle_id = ? AND appointment_date = ? AND id <> ?
      AND start_time < ? AND end_time > ?
      AND (
        status IN ('awaiting_redemption', 'redeemed')
        OR (status = 'pending_payment' AND hold_expires_at > ?)
      )
    LIMIT 1
  `).get(
    vehicleId,
    String(slot.date),
    excludeOrderId ?? "",
    String(slot.end_time),
    String(slot.start_time),
    new Date().toISOString(),
  );
  if (overlap) throw problem(409, "WASH_VEHICLE_TIME_CONFLICT", "该车辆在此时间已有洗车预约");
}

export function registerWashRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: WashRouteOptions,
): Promise<void> {
  return registerWashRoutesAsync(app, database, options);
}

async function registerWashRoutesAsync(
  app: FastifyInstance,
  database: AppDatabase,
  options: WashRouteOptions,
): Promise<void> {
  const { problem, calculateDrivingRoute } = options;
  const currentTime = options.now ?? (() => new Date());
  const imageUploadDir = join(options.uploadDir, "wash", "stores");
  await mkdir(imageUploadDir, { recursive: true });
  await cleanupWashStoreImageOrphans(database, imageUploadDir).catch((error) => app.log.error(error));
  app.addHook("onError", async (request, _reply, error) => {
    if (!request.url.startsWith("/api/admin/wash") || request.backofficeDeniedAudited) return;
    const code = String((error as Error & { code?: string }).code ?? "");
    if (!["BACKOFFICE_RESOURCE_NOT_FOUND", "BACKOFFICE_FORBIDDEN", "BACKOFFICE_SUBJECT_REQUIRED"].includes(code)) return;
    try {
      await auditBackofficeEvent(database, {
        request,
        action: "backoffice.authorization.denied",
        outcome: "denied",
        metadata: { reason: code },
        presentation: {
          category: "account_security",
          actionLabel: "访问其他门店数据",
          summary: "尝试访问不属于当前账号的洗车门店数据，系统已拒绝本次请求",
          reason: code,
        },
      });
      request.backofficeDeniedAudited = true;
    } catch (auditError) {
      request.log.error(auditError, "failed to persist denied wash back-office request audit");
    }
  });
  const removeWashImageBestEffort = async (row: Row) => {
    try {
      await removeStoredWashImage(imageUploadDir, row);
    } catch (error) {
      app.log.error(error);
      await cleanupWashStoreImageOrphans(database, imageUploadDir).catch((cleanupError) => app.log.error(cleanupError));
    }
  };

  app.get<{ Querystring: { originLat?: string; originLng?: string } }>("/api/wash/stores", async (request) => {
    await requireCurrentUser(request, database);
    const hasLat = request.query.originLat !== undefined;
    const hasLng = request.query.originLng !== undefined;
    if (hasLat !== hasLng) throw problem(400, "INVALID_ORIGIN", "起点经纬度必须同时提供");
    let origin: { latitude: number; longitude: number } | undefined;
    if (hasLat && hasLng) {
      const latitude = Number(request.query.originLat);
      const longitude = Number(request.query.originLng);
      if (!Number.isFinite(latitude) || latitude < 38.4 || latitude > 40.3
        || !Number.isFinite(longitude) || longitude < 116.6 || longitude > 118.2) {
        throw problem(400, "INVALID_ORIGIN", "起点经纬度超出天津演示范围");
      }
      origin = { latitude, longitude };
    }
    const storeRows = await database.prepare<Row>(`
      SELECT * FROM wash_stores WHERE is_active = 1 ORDER BY sort_priority DESC, id
    `).all();
    const stores = await Promise.all(storeRows.map((row) => storeFromRow(database, row, origin)));
    if (origin) stores.sort((left, right) => Number(left.distanceKm) - Number(right.distanceKm));
    return { data: stores };
  });

  app.get<{ Params: { id: string } }>("/api/wash/stores/:id", async (request) => {
    await requireCurrentUser(request, database);
    const store = await findStore(database, request.params.id);
    if (!store || !bool(store.is_active)) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到可预约的洗车门店");
    return { data: await storeFromRow(database, store) };
  });

  const sendStoreImage = async (
    id: string,
    reply: FastifyReply,
    includeInactive: boolean,
    scopedToStoreId?: string,
  ) => {
    const image = await database.prepare<Row>(`
      SELECT image.*
      FROM wash_store_images AS image
      JOIN wash_stores AS store ON store.id = image.store_id
      WHERE image.id = ?
        ${includeInactive ? "" : " AND store.is_active = 1"}
        ${scopedToStoreId ? " AND image.store_id = ?" : ""}
    `).get(...(scopedToStoreId ? [id, scopedToStoreId] : [id]));
    if (!image) throw problem(404, "WASH_STORE_IMAGE_NOT_FOUND", "未找到门店图片");
    reply
      .header("content-type", String(image.mime_type))
      .header("content-length", String(image.size_bytes))
      .header("cache-control", includeInactive ? "private, no-store" : "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff");
    if (includeInactive) reply.header("vary", "Cookie");
    return reply.send(createReadStream(join(imageUploadDir, String(image.storage_key))));
  };

  app.get<{ Params: { id: string } }>("/api/wash/store-images/:id", async (request, reply) => (
    sendStoreImage(request.params.id, reply, false)
  ));
  app.get<{ Params: { id: string } }>("/api/admin/wash/store-images/:id", async (request, reply) => (
    sendStoreImage(
      request.params.id,
      reply,
      true,
      washBackofficeAccess(request, WASH_CAPABILITIES.storeRead, problem).storeId ?? undefined,
    )
  ));

  app.get<{
    Params: { id: string };
    Querystring: { vehicleCategory?: string; vehicleType?: string };
  }>("/api/wash/stores/:id/offers", async (request) => {
    await requireCurrentUser(request, database);
    const store = await findStore(database, request.params.id);
    if (!store || !bool(store.is_active)) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到可预约的洗车门店");
    const rawCategory = request.query.vehicleCategory ?? request.query.vehicleType;
    let category: string | undefined;
    if (rawCategory !== undefined) {
      const parsed = washVehicleCategorySchema.safeParse(rawCategory);
      if (!parsed.success) throw problem(400, "INVALID_WASH_VEHICLE_CATEGORY", "洗车车型价类无效");
      category = parsed.data;
    }
    const clauses = ["o.store_id = ?", "o.is_available = 1", "p.is_active = 1"];
    const values: Array<string | number | null> = [request.params.id];
    if (category) {
      clauses.push("o.vehicle_category = ?");
      values.push(category);
    }
    const offers = (await database.prepare<Row>(`
      SELECT o.*, p.code AS package_code, p.name AS package_name,
        p.short_description AS package_short_description,
        p.service_items_json, p.duration_minutes, p.sort_order AS package_sort_order,
        p.is_active AS package_is_active
      FROM wash_store_offers o
      JOIN wash_packages p ON p.id = o.package_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY p.sort_order, p.id, o.vehicle_category
    `).all(...values)).map((row) => offerFromRow(row));
    return { data: offers };
  });

  app.get<{
    Params: { id: string };
    Querystring: { date?: string; packageId?: string };
  }>("/api/wash/stores/:id/slots", async (request) => {
    await requireCurrentUser(request, database);
    await expirePendingOrders(database);
    const store = await findStore(database, request.params.id);
    if (!store || !bool(store.is_active)) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到可预约的洗车门店");
    if (request.query.date && !isRealIsoDate(request.query.date)) {
      throw problem(400, "INVALID_DATE", "日期格式无效");
    }
    let packageValue: Row | undefined;
    if (request.query.packageId) {
      packageValue = await findPackage(database, request.query.packageId);
      if (!packageValue || !bool(packageValue.is_active)) throw problem(404, "WASH_PACKAGE_NOT_FOUND", "未找到可用洗车套餐");
    }
    const clauses = ["store_id = ?", "date >= ?", "is_open = 1"];
    const values: Array<string | number | null> = [request.params.id, businessDate()];
    if (request.query.date) {
      clauses.push("date = ?");
      values.push(request.query.date);
    }
    const now = currentTime();
    const slotRows = (await database.prepare<Row>(`
      SELECT * FROM wash_slots WHERE ${clauses.join(" AND ")}
      ORDER BY date, start_time
    `).all(...values))
      .filter((row) => !washSlotHasStarted(row, now))
      .filter((row) => !packageValue
        || toMinutes(String(row.end_time)) - toMinutes(String(row.start_time)) >= Number(packageValue.duration_minutes));
    const slots = await Promise.all(slotRows.map((row) => slotFromRow(database, row)));
    return { data: slots };
  });

  app.post("/api/wash/quotes", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(quoteSchema, request.body, reply);
    if (!body) return;
    await expirePendingOrders(database);
    const vehicle = await findOwnerVehicle(database, body.vehicleId, currentUserId);
    if (!vehicle) throw problem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
    const category = washCategoryFromVehicle(vehicle);
    if (body.vehicleCategory !== undefined && body.vehicleCategory !== category) {
      throw problem(409, "WASH_VEHICLE_CATEGORY_MISMATCH", "提交的洗车车型价类与车辆档案不一致，请刷新后重试", {
        vehicleCategory: category,
      });
    }
    const store = await findStore(database, body.storeId);
    if (!store || !bool(store.is_active)) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到可预约的洗车门店");
    const packageValue = await findPackage(database, body.packageId);
    if (!packageValue || !bool(packageValue.is_active)) throw problem(404, "WASH_PACKAGE_NOT_FOUND", "未找到可用洗车套餐");
    const offer = await activeOfferRow(database, body.storeId, body.packageId, category);
    if (!offer) throw problem(409, "WASH_OFFER_UNAVAILABLE", "当前门店暂未提供该车型与套餐组合");
    const slot = await findSlot(database, body.slotId);
    if (!slot || String(slot.store_id) !== body.storeId) throw problem(404, "WASH_SLOT_NOT_FOUND", "未找到该门店预约时段");
    await assertSlotCanReserve(database, problem, slot, Number(packageValue.duration_minutes), currentTime());

    const now = new Date();
    const id = randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const vehicleValue = vehicleSnapshot(vehicle, category);
    const storeValue = await storeFromRow(database, store);
    const packageSnapshot = packageFromRow(packageValue);
    const slotValue = await slotFromRow(database, slot);
    const washFeeFen = Number(offer.sale_price_fen);
    let valetFeeFen = 0;
    let oneWayDistanceKm: number | null = null;
    let roundTripDistanceKm: number | null = null;
    let billableDistanceKm: number | null = null;
    let driveMinutes: number | null = null;
    let distanceSource = "not_calculated";
    let distanceBasis = "no_origin";
    let extraKm = 0;
    let valetRule: Awaited<ReturnType<typeof resolvedWashValetRule>> | null = null;
    let verifiedPickupAddress: z.infer<typeof pickupAddressSchema> | null = null;
    let valetBaseFeeFen = 0;
    let valetDistanceFeeFen = 0;
    if (body.serviceMode === "valet") {
      const pickup = await verifiedWashPickupAddress(body.pickupAddress!, problem);
      verifiedPickupAddress = pickup;
      const route = await calculateDrivingRoute(
        { latitude: pickup.latitude, longitude: pickup.longitude },
        { latitude: Number(store.latitude), longitude: Number(store.longitude) },
      );
      if (route.distanceSource !== "tencent_matrix" || route.distanceBasis !== "driving_route" || route.distanceKm == null) {
        throw problem(503, "WASH_REAL_ROUTE_REQUIRED", "洗车代驾取送必须使用腾讯真实驾车路线，当前暂不能报价", {
          mapErrorCode: route.mapErrorCode ?? "TENCENT_UNAVAILABLE",
        });
      }
      valetRule = await resolvedWashValetRule(database, body.storeId, problem);
      if (valetRule.maxRadiusKm !== null && route.distanceKm > valetRule.maxRadiusKm) {
        throw problem(409, "WASH_VALET_OUT_OF_RANGE", "取车地址超出该洗车门店的代驾服务范围", {
          oneWayDistanceKm: String(route.distanceKm),
          maxRadiusKm: String(valetRule.maxRadiusKm),
        });
      }
      oneWayDistanceKm = route.distanceKm;
      roundTripDistanceKm = Math.ceil(route.distanceKm * 2 * 10) / 10;
      billableDistanceKm = route.distanceKm;
      driveMinutes = route.driveMinutes;
      distanceSource = route.distanceSource;
      distanceBasis = route.distanceBasis;
      extraKm = Math.max(0, Math.ceil(route.distanceKm - valetRule.includedKm));
      valetBaseFeeFen = valetRule.baseFeeFen;
      valetDistanceFeeFen = extraKm * valetRule.perKmFen;
      valetFeeFen = valetBaseFeeFen + valetDistanceFeeFen;
    }
    const totalFeeFen = washFeeFen + valetFeeFen;
    const feeBreakdown = {
      washFeeFen,
      valetBaseFeeFen,
      valetDistanceFeeFen,
      valetFeeFen,
      totalFeeFen,
    };
    const offerVersion = inspectionResultRequestHash({
      storeId: body.storeId,
      packageId: body.packageId,
      vehicleCategory: category,
      salePriceFen: Number(offer.sale_price_fen),
      listPriceFen: offer.list_price_fen == null ? null : Number(offer.list_price_fen),
      estimatedSettlementFen: offer.estimated_settlement_fen == null
        ? Number(offer.sale_price_fen)
        : Number(offer.estimated_settlement_fen),
      updatedAt: String(offer.updated_at),
    });
    await database.prepare(`
      INSERT INTO wash_quote_snapshots (
        id, user_id, vehicle_id, store_id, package_id, slot_id, vehicle_category,
        sale_price_fen, list_price_fen, estimated_settlement_fen, vehicle_snapshot_json, store_snapshot_json,
        package_snapshot_json, slot_snapshot_json, offer_version, created_at, expires_at,
        service_mode, trip_type, pickup_address_json, wash_fee_fen, valet_fee_fen, total_fee_fen,
        one_way_distance_km, round_trip_distance_km, billable_distance_km, drive_minutes,
        distance_source, distance_basis, quote_extra_km, valet_rule_json, fee_breakdown_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      currentUserId,
      body.vehicleId,
      body.storeId,
      body.packageId,
      body.slotId,
      category,
      Number(offer.sale_price_fen),
      offer.list_price_fen == null ? null : Number(offer.list_price_fen),
      offer.estimated_settlement_fen == null ? Number(offer.sale_price_fen) : Number(offer.estimated_settlement_fen),
      JSON.stringify(vehicleValue),
      JSON.stringify(storeValue),
      JSON.stringify(packageSnapshot),
      JSON.stringify(slotValue),
      offerVersion,
      createdAt,
      expiresAt,
      body.serviceMode,
      body.serviceMode === "valet" ? body.tripType : null,
      verifiedPickupAddress == null ? null : JSON.stringify(verifiedPickupAddress),
      washFeeFen,
      valetFeeFen,
      totalFeeFen,
      oneWayDistanceKm,
      roundTripDistanceKm,
      billableDistanceKm,
      driveMinutes,
      distanceSource,
      distanceBasis,
      extraKm,
      valetRule == null ? null : JSON.stringify(valetRule),
      JSON.stringify(feeBreakdown),
    );
    const row = await database.prepare<Row>("SELECT * FROM wash_quote_snapshots WHERE id = ?").get(id);
    if (!row) throw problem(500, "WASH_QUOTE_CREATE_FAILED", "洗车报价创建失败");
    return reply.status(201).send({ data: quoteFromRow(row) });
  });

  app.post("/api/wash/orders", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(createOrderSchema, request.body, reply);
    if (!body) return;
    await expirePendingOrders(database);
    const existing = await database.prepare<Row>(`
      SELECT o.*, l.booking_id AS precheck_booking_id FROM wash_orders o
      LEFT JOIN precheck_wash_links l ON l.wash_order_id = o.id
      WHERE o.user_id = ? AND o.idempotency_key = ?
    `).get(currentUserId, body.idempotencyKey);
    if (existing) {
      if (String(existing.quote_snapshot_id) !== body.quoteSnapshotId) {
        throw problem(409, "WASH_ORDER_IDEMPOTENCY_CONFLICT", "下单幂等键已用于其他报价");
      }
      if ((existing.precheck_booking_id ?? null) !== (body.precheckBookingId ?? null)) {
        throw problem(409, "WASH_ORDER_IDEMPOTENCY_CONFLICT", "下单幂等键已用于其他预检关联，请返回原订单查看");
      }
      return { data: await orderFromRow(database, existing) };
    }

    const createdId = await database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(
        `wash-order-idempotency:${currentUserId}:${body.idempotencyKey}`,
      );
      const duplicate = await tx.prepare<Row>(`
        SELECT o.*, l.booking_id AS precheck_booking_id FROM wash_orders o
        LEFT JOIN precheck_wash_links l ON l.wash_order_id = o.id
        WHERE o.user_id = ? AND o.idempotency_key = ?
      `).get(currentUserId, body.idempotencyKey);
      if (duplicate) {
        if (String(duplicate.quote_snapshot_id) !== body.quoteSnapshotId) {
          throw problem(409, "WASH_ORDER_IDEMPOTENCY_CONFLICT", "下单幂等键已用于其他报价");
        }
        if ((duplicate.precheck_booking_id ?? null) !== (body.precheckBookingId ?? null)) {
          throw problem(409, "WASH_ORDER_IDEMPOTENCY_CONFLICT", "下单幂等键已用于其他预检关联，请返回原订单查看");
        }
        return String(duplicate.id);
      }
      const quote = await tx.prepare<Row>(`
        SELECT * FROM wash_quote_snapshots WHERE id = ? AND user_id = ?
        FOR UPDATE
      `).get(body.quoteSnapshotId, currentUserId);
      if (!quote) throw problem(404, "WASH_QUOTE_NOT_FOUND", "未找到该洗车报价");
      if (body.precheckBookingId) {
        const origin = await tx.prepare<Row>(`SELECT b.vehicle_id, b.fulfillment_status, p.reason_codes_json
          FROM bookings b JOIN booking_prechecks p ON p.booking_id = b.id
          WHERE b.id = ? AND b.user_id = ? FOR UPDATE OF b`).get(body.precheckBookingId, currentUserId);
        if (!origin) throw problem(404, "PRECHECK_NOT_FOUND", "未找到预检记录");
        if (origin.fulfillment_status !== "precheck_action_required" || origin.vehicle_id !== quote.vehicle_id
          || !String(origin.reason_codes_json).includes('"body_dirty"')) throw problem(409, "PRECHECK_WASH_NOT_APPLICABLE", "该预检订单未记录洗车需求或车辆不一致");
      }
      const now = new Date();
      const nowIso = now.toISOString();
      if (String(quote.expires_at) <= nowIso) throw problem(409, "WASH_QUOTE_EXPIRED", "洗车报价已过期，请重新获取");
      const used = await tx.prepare("SELECT id FROM wash_orders WHERE quote_snapshot_id = ?").get(body.quoteSnapshotId);
      if (used) throw problem(409, "WASH_QUOTE_ALREADY_USED", "该洗车报价已创建订单");
      const store = await findStore(tx, String(quote.store_id), true);
      const packageValue = await findPackage(tx, String(quote.package_id), true);
      const vehicle = await findOwnerVehicle(tx, String(quote.vehicle_id), currentUserId, true);
      const slot = await findSlot(tx, String(quote.slot_id), true);
      if (!vehicle) throw problem(409, "WASH_VEHICLE_UNAVAILABLE", "车辆已不可用，请重新选择");
      if (!store || !bool(store.is_active)) throw problem(409, "WASH_STORE_UNAVAILABLE", "门店已暂停预约，请重新选择");
      if (!packageValue || !bool(packageValue.is_active)) throw problem(409, "WASH_PACKAGE_UNAVAILABLE", "套餐已暂停，请重新选择");
      const quoteCategory = washCategoryFromSnapshot(quote.vehicle_category, quote.vehicle_snapshot_json);
      const currentVehicleCategory = washCategoryFromVehicle(vehicle);
      if (quoteCategory !== currentVehicleCategory) {
        throw problem(409, "WASH_QUOTE_STALE", "车辆洗车价类已变化，请重新获取报价");
      }
      if (!await activeOfferRow(tx, String(quote.store_id), String(quote.package_id), quoteCategory, true)) {
        throw problem(409, "WASH_OFFER_UNAVAILABLE", "当前报价组合已暂停，请重新选择");
      }
      if (!slot || String(slot.store_id) !== String(quote.store_id)) {
        throw problem(409, "WASH_SLOT_UNAVAILABLE", "预约时段已不可用，请重新选择");
      }
      await assertSlotCanReserve(tx, problem, slot, Number(packageValue.duration_minutes), currentTime());
      await assertVehicleHasNoOverlap(tx, problem, String(quote.vehicle_id), slot);

      const nextId = randomUUID();
      const holdExpiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
      await tx.prepare(`
        INSERT INTO wash_orders (
          id, order_number, idempotency_key, user_id, vehicle_id, store_id, package_id,
          slot_id, quote_snapshot_id, vehicle_category, contact_name, contact_phone,
          total_fee_fen, estimated_settlement_fen, status, payment_status, redemption_code, notes, internal_note,
          appointment_date, start_time, end_time, vehicle_snapshot_json, store_snapshot_json,
          package_snapshot_json, slot_snapshot_json, hold_expires_at, paid_at, redeemed_at,
          cancelled_at, refunded_at, expired_at, created_at, updated_at,
          service_mode, trip_type, pickup_address_json, wash_fee_fen, valet_fee_fen,
          one_way_distance_km, round_trip_distance_km, billable_distance_km, drive_minutes,
          distance_source, distance_basis, quote_extra_km, valet_rule_json, fee_breakdown_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', 'unpaid', NULL,
          ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nextId,
        orderNumber(),
        body.idempotencyKey,
        currentUserId,
        String(quote.vehicle_id),
        String(quote.store_id),
        String(quote.package_id),
        String(quote.slot_id),
        String(quote.id),
        quoteCategory,
        body.contactName,
        body.contactPhone,
        Number(quote.total_fee_fen ?? quote.sale_price_fen),
        quote.estimated_settlement_fen == null ? Number(quote.sale_price_fen) : Number(quote.estimated_settlement_fen),
        body.notes ?? null,
        String(slot.date),
        String(slot.start_time),
        String(slot.end_time),
        jsonText(quote.vehicle_snapshot_json),
        jsonText(quote.store_snapshot_json),
        jsonText(quote.package_snapshot_json),
        jsonText(quote.slot_snapshot_json),
        holdExpiresAt,
        nowIso,
        nowIso,
        String(quote.service_mode ?? "self_drive"),
        quote.trip_type == null ? null : String(quote.trip_type),
        quote.pickup_address_json == null ? null : jsonText(quote.pickup_address_json),
        Number(quote.wash_fee_fen ?? quote.sale_price_fen),
        Number(quote.valet_fee_fen ?? 0),
        quote.one_way_distance_km == null ? null : Number(quote.one_way_distance_km),
        quote.round_trip_distance_km == null ? null : Number(quote.round_trip_distance_km),
        quote.billable_distance_km == null ? null : Number(quote.billable_distance_km),
        quote.drive_minutes == null ? null : Number(quote.drive_minutes),
        String(quote.distance_source ?? "not_calculated"),
        String(quote.distance_basis ?? "no_origin"),
        Number(quote.quote_extra_km ?? 0),
        quote.valet_rule_json == null ? null : jsonText(quote.valet_rule_json),
        jsonText(quote.fee_breakdown_json ?? "{}"),
      );
      await tx.prepare(`
        INSERT INTO wash_order_settlements (
          id, order_id, status, amount_fen, operator, reason, note, settled_at, updated_at
        ) VALUES (?, ?, 'unsettled', ?, NULL, NULL, NULL, NULL, ?)
      `).run(
        randomUUID(),
        nextId,
        quote.estimated_settlement_fen == null ? Number(quote.sale_price_fen) : Number(quote.estimated_settlement_fen),
        nowIso,
      );
      await insertEvent(
        tx,
        nextId,
        "pending_payment",
        "洗车预约待支付",
        String(quote.service_mode) === "valet"
          ? "已为你保留洗车与往返取送时段 15 分钟，支付成功后生成核销码"
          : "已为你保留该时段 15 分钟，支付成功后生成核销码",
        "owner",
        { holdExpiresAt, serviceMode: String(quote.service_mode ?? "self_drive") },
        nowIso,
      );
      if (body.precheckBookingId) {
        await tx.prepare("INSERT INTO precheck_wash_links (wash_order_id, booking_id, created_at) VALUES (?, ?, ?)").run(nextId, body.precheckBookingId, nowIso);
        await tx.prepare(`INSERT INTO booking_events (id, booking_id, status, title, description, actor_type, created_at, metadata_json)
          VALUES (?, ?, 'precheck_action_required', '车主已预约洗车', '洗车单独计价和核销；清洁后由车主补充照片提交预检复核。', 'owner', ?, ?)`)
          .run(randomUUID(), body.precheckBookingId, nowIso, JSON.stringify({ washOrderId: nextId }));
      }
      return nextId;
    });
    const row = await findOrder(database, createdId, currentUserId);
    if (!row) throw problem(500, "WASH_ORDER_CREATE_FAILED", "洗车订单创建失败");
    return reply.status(201).send({ data: await orderFromRow(database, row) });
  });

  app.get<{ Querystring: { status?: string } }>("/api/wash/orders", async (request) => {
    const currentUserId = await requireCurrentUser(request, database);
    await expirePendingOrders(database);
    const values: Array<string | number | null> = [currentUserId];
    let statusSql = "";
    if (request.query.status) {
      const parsed = washOrderStatusSchema.safeParse(request.query.status);
      if (!parsed.success) throw problem(400, "INVALID_WASH_ORDER_STATUS", "洗车订单状态无效");
      statusSql = " AND status = ?";
      values.push(parsed.data);
    }
    const rows = await database.prepare<Row>(`
      SELECT * FROM wash_orders WHERE user_id = ?${statusSql}
      ORDER BY created_at DESC, id DESC
    `).all(...values);
    return { data: await Promise.all(rows.map((row) => orderFromRow(database, row, false))) };
  });

  app.get<{ Params: { id: string } }>("/api/wash/orders/:id", async (request) => {
    const currentUserId = await requireCurrentUser(request, database);
    await expirePendingOrders(database);
    const row = await findOrder(database, request.params.id, currentUserId);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到该洗车订单");
    return { data: await orderFromRow(database, row) };
  });

  app.post<{ Params: { id: string } }>("/api/wash/orders/:id/payments", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(paymentSchema, request.body, reply);
    if (!body) return;
    const mockAllowed = process.env.NODE_ENV !== "production" || process.env.ALLOW_MOCK_PAYMENT === "true";
    if (!mockAllowed) throw problem(503, "MOCK_PAYMENT_DISABLED", "当前环境未启用模拟支付");
    if (process.env.PAYMENT_PROVIDER && process.env.PAYMENT_PROVIDER !== "mock") {
      throw problem(503, "PAYMENT_PROVIDER_UNAVAILABLE", "当前支付提供方不可用");
    }
    await expirePendingOrders(database);
    const result = await database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(
        `wash-payment:${body.provider}:${body.idempotencyKey}`,
      );
      const current = await findOrder(tx, request.params.id, currentUserId, true);
      if (!current) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到该洗车订单");
      const existing = await tx.prepare<Row>(`
        SELECT * FROM wash_order_payments WHERE provider = ? AND idempotency_key = ?
      `).get(body.provider, body.idempotencyKey);
      if (existing) {
        if (String(existing.order_id) !== request.params.id) {
          throw problem(409, "PAYMENT_IDEMPOTENCY_CONFLICT", "支付幂等键已用于其他订单");
        }
        return { payment: existing, created: false };
      }
      if (String(current.status) !== "pending_payment" || String(current.hold_expires_at) <= new Date().toISOString()) {
        throw problem(409, "WASH_PAYMENT_NOT_ALLOWED", "当前订单状态不能继续支付");
      }
      const now = new Date().toISOString();
      const paymentId = randomUUID();
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended('wash-redemption-code', 0))").get();
      const code = await generateRedemptionCode(tx);
      await tx.prepare(`
        INSERT INTO wash_order_payments (
          id, order_id, provider, kind, idempotency_key, amount_fen, status, created_at, confirmed_at
        ) VALUES (?, ?, 'mock', 'charge', ?, ?, 'confirmed', ?, ?)
      `).run(paymentId, request.params.id, body.idempotencyKey, Number(current.total_fee_fen), now, now);
      const updated = await tx.prepare(`
        UPDATE wash_orders SET status = 'awaiting_redemption', payment_status = 'paid',
          redemption_code = ?, paid_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending_payment' AND hold_expires_at > ?
      `).run(code, now, now, request.params.id, now);
      if (updated.changes !== 1) throw problem(409, "WASH_PAYMENT_NOT_ALLOWED", "当前订单状态不能继续支付");
      await insertEvent(
        tx,
        request.params.id,
        "awaiting_redemption",
        "支付成功",
        String(current.service_mode) === "valet"
          ? "预约已生效，运营将按约定地址协调往返取送；六位码仍用于门店线下核销"
          : "预约已生效，到店后向工作人员出示六位核销码",
        "owner",
        { provider: "mock", paymentId, serviceMode: String(current.service_mode ?? "self_drive") },
        now,
      );
      const payment = await tx.prepare<Row>("SELECT * FROM wash_order_payments WHERE id = ?").get(paymentId);
      if (!payment) throw problem(500, "WASH_PAYMENT_CREATE_FAILED", "支付记录创建失败");
      return { payment, created: true };
    });
    const row = await findOrder(database, request.params.id, currentUserId);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到该洗车订单");
    const order = await orderFromRow(database, row);
    const response = { data: { order, payment: paymentFromRow(result.payment), redemptionCode: order.redemptionCode } };
    return result.created ? reply.status(201).send(response) : response;
  });

  app.post<{ Params: { id: string } }>("/api/wash/orders/:id/cancel", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(cancelSchema, request.body, reply);
    if (!body) return;
    await expirePendingOrders(database);
    try {
      await database.transaction(async (tx) => {
        const row = await findOrder(tx, request.params.id, currentUserId, true);
        if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到该洗车订单");
        if (String(row.status) === "redeemed") throw problem(409, "WASH_CANCEL_NOT_ALLOWED", "已核销订单请联系门店处理");
        await cancelOrRefundOrder(tx, row, "owner", body.reason ?? "车主取消");
      });
    } catch (error) {
      throwWashProblem(problem, error);
    }
    const row = await findOrder(database, request.params.id, currentUserId);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到该洗车订单");
    return { data: await orderFromRow(database, row) };
  });

  app.post<{ Params: { id: string } }>("/api/wash/orders/:id/reschedule", async (request, reply) => {
    const currentUserId = await requireCurrentUser(request, database);
    const body = parseBody(rescheduleSchema, request.body, reply);
    if (!body) return;
    await expirePendingOrders(database);
    await database.transaction(async (tx) => {
      const row = await findOrder(tx, request.params.id, currentUserId, true);
      if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到该洗车订单");
      if (String(row.status) === "pending_payment" && String(row.hold_expires_at) <= new Date().toISOString()) {
        throw problem(409, "WASH_ORDER_EXPIRED", "待支付订单已过期，不能改期");
      }
      if (!["pending_payment", "awaiting_redemption"].includes(String(row.status))) {
        throw problem(409, "WASH_RESCHEDULE_NOT_ALLOWED", "当前订单状态不能改期");
      }
      const packageValue = await findPackage(tx, String(row.package_id), true);
      if (!packageValue) throw problem(409, "WASH_PACKAGE_UNAVAILABLE", "原套餐已不可用，请联系客服");
      await tx.prepare("SELECT id FROM vehicles WHERE id = ? AND user_id = ? FOR UPDATE")
        .get(String(row.vehicle_id), currentUserId);
      const slot = await findSlot(tx, body.slotId, true);
      if (!slot || String(slot.store_id) !== String(row.store_id)) {
        throw problem(404, "WASH_SLOT_NOT_FOUND", "未找到该门店预约时段");
      }
      await assertSlotCanReserve(tx, problem, slot, Number(packageValue.duration_minutes), currentTime(), request.params.id);
      await assertVehicleHasNoOverlap(tx, problem, String(row.vehicle_id), slot, request.params.id);
      const now = new Date().toISOString();
      const slotSnapshot = await slotFromRow(tx, slot);
      const updated = await tx.prepare(`
        UPDATE wash_orders SET slot_id = ?, appointment_date = ?, start_time = ?, end_time = ?,
          slot_snapshot_json = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending_payment', 'awaiting_redemption')
      `).run(
        String(slot.id),
        String(slot.date),
        String(slot.start_time),
        String(slot.end_time),
        JSON.stringify(slotSnapshot),
        now,
        request.params.id,
      );
      if (updated.changes !== 1) throw problem(409, "WASH_RESCHEDULE_NOT_ALLOWED", "当前订单状态不能改期");
      await insertEvent(
        tx,
        request.params.id,
        String(row.status),
        "预约时间已调整",
        `已改期至 ${String(slot.date)} ${String(slot.start_time)}-${String(slot.end_time)}`,
        "owner",
        { previousSlotId: String(row.slot_id), slotId: String(slot.id) },
        now,
      );
    });
    const row = await findOrder(database, request.params.id, currentUserId);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到该洗车订单");
    return { data: await orderFromRow(database, row) };
  });

  app.get("/api/admin/wash/stores", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.storeRead, problem);
    const audience: WashStoreAudience = access.storeId ? "provider" : "platform";
    const rows = access.storeId
      ? await database.prepare<Row>(`
          SELECT * FROM wash_stores WHERE id = ? ORDER BY sort_priority DESC, id
        `).all(access.storeId)
      : await database.prepare<Row>(`
          SELECT * FROM wash_stores ORDER BY sort_priority DESC, id
        `).all();
    return { data: await Promise.all(rows.map((row) => storeFromRow(database, row, undefined, audience))) };
  });

  app.post("/api/admin/wash/stores", async (request, reply) => {
    platformWashAccess(request, problem);
    const body = parseBody(adminStoreSchema, request.body, reply);
    if (!body) return;
    if (!body.location) {
      throw problem(400, "WASH_STORE_LOCATION_REQUIRED", "请先搜索并确认门店地址");
    }
    const location = verifiedAdminStoreLocation(body.location, problem);
    const id = body.id ?? randomUUID();
    const now = new Date().toISOString();
    const created = await database.transaction(async (tx) => {
      if (await findStore(tx, id)) throw problem(409, "WASH_STORE_ID_EXISTS", "洗车门店 ID 已存在");
      const duplicateName = await tx.prepare("SELECT id FROM wash_stores WHERE name = ?").get(body.name);
      if (duplicateName) throw problem(409, "WASH_STORE_NAME_EXISTS", "洗车门店名称已存在");
      await tx.prepare(`
        INSERT INTO wash_stores (
          id, name, legal_name, district, address, latitude, longitude, phone, cover_image_url,
          description, tags_json, facilities_json, open_hours, weekly_schedule_json,
          business_hours_notice, advance_booking_days, rating, review_count, data_kind,
          is_active, sort_priority, internal_contact_name, internal_contact_phone,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        body.name,
        body.legalName ?? null,
        location.district,
        location.address,
        location.latitude,
        location.longitude,
        body.phone ?? null,
        null,
        body.description,
        JSON.stringify(body.tags),
        JSON.stringify(body.facilities),
        body.openHours,
        JSON.stringify(body.weeklySchedule),
        body.businessHoursNotice ?? null,
        body.advanceBookingDays,
        body.rating,
        body.reviewCount,
        body.dataKind,
        body.isActive ? 1 : 0,
        body.sortPriority,
        body.internalContact?.name ?? null,
        body.internalContact?.phone ?? null,
        now,
        now,
      );
      const row = await findStore(tx, id);
      if (!row) throw problem(500, "WASH_STORE_CREATE_FAILED", "洗车门店创建失败");
      const result = await storeFromRow(tx, row, undefined, "platform");
      await auditWashMutation(tx, request, "wash.store.create", { type: "wash_store", id }, { after: result });
      return result;
    });
    return reply.status(201).send({ data: created });
  });

  app.put<{ Params: { id: string } }>("/api/admin/wash/stores/:id", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.storeWrite, problem);
    const body = parseBody(adminStoreSchema, request.body, reply);
    if (!body) return;
    const selectedLocation = body.location ? verifiedAdminStoreLocation(body.location, problem) : null;
    const now = new Date().toISOString();
    const audience: WashStoreAudience = access.storeId ? "provider" : "platform";
    const result = await database.transaction(async (tx) => {
      // Re-resolve and lock the tenant resource inside the write transaction. The
      // path id is a selector only; the authenticated assignment remains the scope.
      const current = await findStore(tx, request.params.id, true, access.storeId ?? undefined);
      if (!current) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      const beforeResult = await storeFromRow(tx, current, undefined, audience);
      const location = selectedLocation ?? {
        district: String(current.district),
        address: String(current.address),
        latitude: Number(current.latitude),
        longitude: Number(current.longitude),
      };
      const duplicateName = await tx.prepare("SELECT id FROM wash_stores WHERE name = ? AND id <> ?")
        .get(body.name, request.params.id);
      if (duplicateName) throw problem(409, "WASH_STORE_NAME_EXISTS", "洗车门店名称已存在");
      if (!body.isActive && bool(current.is_active)) {
        const active = await tx.prepare(`
          SELECT id FROM wash_orders
          WHERE store_id = ? AND status IN ('pending_payment', 'awaiting_redemption') LIMIT 1
        `).get(request.params.id);
        if (active) throw problem(409, "WASH_STORE_HAS_ACTIVE_ORDERS", "门店仍有待支付或待核销订单，不能直接停用");
      }
      await tx.prepare(`
        UPDATE wash_stores SET name = ?, district = ?, address = ?, latitude = ?, longitude = ?,
          legal_name = ?, phone = ?, cover_image_url = ?, description = ?, tags_json = ?, facilities_json = ?,
          open_hours = ?, weekly_schedule_json = ?, business_hours_notice = ?, advance_booking_days = ?,
          rating = ?, review_count = ?, data_kind = ?, is_active = ?, sort_priority = ?, internal_contact_name = ?,
          internal_contact_phone = ?, updated_at = ? WHERE id = ?
      `).run(
        body.name,
        location.district,
        location.address,
        location.latitude,
        location.longitude,
        body.legalName ?? null,
        body.phone ?? null,
        current.cover_image_url == null ? null : String(current.cover_image_url),
        body.description,
        JSON.stringify(body.tags),
        JSON.stringify(body.facilities),
        body.openHours,
        JSON.stringify(body.weeklySchedule),
        body.businessHoursNotice ?? null,
        body.advanceBookingDays,
        access.storeId ? Number(current.rating) : body.rating,
        access.storeId ? Number(current.review_count) : body.reviewCount,
        access.storeId ? String(current.data_kind) : body.dataKind,
        body.isActive ? 1 : 0,
        access.storeId ? Number(current.sort_priority) : body.sortPriority,
        access.storeId
          ? current.internal_contact_name == null ? null : String(current.internal_contact_name)
          : body.internalContact?.name ?? null,
        access.storeId
          ? current.internal_contact_phone == null ? null : String(current.internal_contact_phone)
          : body.internalContact?.phone ?? null,
        now,
        request.params.id,
      );
      const updated = await findStore(tx, request.params.id, false, access.storeId ?? undefined);
      if (!updated) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      const result = await storeFromRow(tx, updated, undefined, audience);
      await auditWashMutation(tx, request, "wash.store.update", {
        type: "wash_store",
        id: request.params.id,
      }, { before: beforeResult, after: result });
      return result;
    });
    return { data: result };
  });

  app.post<{ Params: { id: string } }>("/api/admin/wash/stores/:id/images", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.storeWrite, problem);
    const processed = await receiveWashStoreImage(request, problem);
    const coverField = multipartField(processed.part, "isCover");
    if (coverField !== undefined && !["true", "false", "1", "0"].includes(coverField.toLowerCase())) {
      throw problem(400, "WASH_STORE_IMAGE_COVER_INVALID", "封面设置无效");
    }
    const sortField = multipartField(processed.part, "sortOrder");
    const requestedSort = sortField === undefined ? null : Number(sortField);
    if (requestedSort !== null && (!Number.isInteger(requestedSort) || requestedSort < 0 || requestedSort > 10_000)) {
      throw problem(400, "WASH_STORE_IMAGE_SORT_INVALID", "图片排序值无效");
    }
    const id = randomUUID();
    const storageKey = `${id}.jpg`;
    await writeFile(join(imageUploadDir, storageKey), processed.data, { flag: "wx" });
    const audience: WashStoreAudience = access.storeId ? "provider" : "platform";
    let created: WashStoreImageResponse;
    try {
      created = await database.transaction(async (tx) => {
        const store = await findStore(tx, request.params.id, true, access.storeId ?? undefined);
        if (!store) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
        const countRow = await tx.prepare<Row>(`
          SELECT COUNT(*) AS count, COALESCE(MAX(sort_order), -1) + 1 AS next_sort
          FROM wash_store_images WHERE store_id = ?
        `).get(request.params.id) ?? {};
        const count = Number(countRow.count ?? 0);
        if (count >= 20) throw problem(409, "WASH_STORE_IMAGE_LIMIT", "每家门店最多维护 20 张图片");
        const sortOrder = requestedSort ?? Number(countRow.next_sort ?? count);
        const isCover = count === 0 || coverField?.toLowerCase() === "true" || coverField === "1";
        if (isCover) {
          await tx.prepare("UPDATE wash_store_images SET is_cover = 0 WHERE store_id = ?")
            .run(request.params.id);
        }
        const now = new Date().toISOString();
        await tx.prepare(`
          INSERT INTO wash_store_images (
            id, store_id, storage_key, mime_type, size_bytes, width, height,
            sort_order, is_cover, data_kind, created_at
          ) VALUES (?, ?, ?, 'image/jpeg', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          request.params.id,
          storageKey,
          processed.data.length,
          processed.info.width,
          processed.info.height,
          sortOrder,
          isCover ? 1 : 0,
          String(store.data_kind) === "real" ? "real" : "demo",
          now,
        );
        if (isCover) {
          await tx.prepare("UPDATE wash_stores SET cover_image_url = ?, updated_at = ? WHERE id = ?")
            .run(`/api/wash/store-images/${id}`, now, request.params.id);
        }
        const createdRow = await tx.prepare<Row>("SELECT * FROM wash_store_images WHERE id = ?").get(id);
        if (!createdRow) throw problem(500, "WASH_STORE_IMAGE_CREATE_FAILED", "门店图片保存失败");
        const result = storeImageFromRow(createdRow, audience);
        await auditWashMutation(tx, request, "wash.store_image.create", {
          type: "wash_store_image",
          id,
        }, { after: result, metadata: { storeId: request.params.id } });
        return result;
      });
    } catch (error) {
      await removeWashImageBestEffort({ storage_key: storageKey });
      throw error;
    }
    return reply.status(201).send({ data: created });
  });

  app.put<{ Params: { id: string } }>("/api/admin/wash/stores/:id/images", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.storeWrite, problem);
    const body = parseBody(adminStoreImageOrderSchema, request.body, reply);
    if (!body) return;
    const audience: WashStoreAudience = access.storeId ? "provider" : "platform";
    const images = await database.transaction(async (tx) => {
      const store = await findStore(tx, request.params.id, true, access.storeId ?? undefined);
      if (!store) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      const rows = await tx.prepare<Row>(`
        SELECT * FROM wash_store_images WHERE store_id = ?
        ORDER BY is_cover DESC, sort_order, created_at, id
        FOR UPDATE
      `).all(request.params.id);
      const beforeImages = rows.map((row) => storeImageFromRow(row, audience));
      const existingIds = new Set(rows.map((row) => String(row.id)));
      for (const item of body.images) {
        if (!existingIds.has(item.id)) {
          throw problem(404, "WASH_STORE_IMAGE_NOT_FOUND", "门店图片不存在或不属于当前门店");
        }
      }
      const requestedCover = body.images.find((item) => item.isCover);
      if (requestedCover) {
        await tx.prepare("UPDATE wash_store_images SET is_cover = 0 WHERE store_id = ?")
          .run(request.params.id);
      }
      for (const item of body.images) {
        await tx.prepare("UPDATE wash_store_images SET sort_order = ? WHERE id = ? AND store_id = ?")
          .run(item.sortOrder, item.id, request.params.id);
      }
      if (requestedCover) {
        await tx.prepare("UPDATE wash_store_images SET is_cover = 1 WHERE id = ? AND store_id = ?")
          .run(requestedCover.id, request.params.id);
      }
      let cover = await tx.prepare<Row>(`
        SELECT * FROM wash_store_images WHERE store_id = ? AND is_cover = 1 LIMIT 1
      `).get(request.params.id);
      if (!cover && rows.length > 0) {
        cover = await tx.prepare<Row>(`
          SELECT * FROM wash_store_images WHERE store_id = ? ORDER BY sort_order, created_at, id LIMIT 1
        `).get(request.params.id);
        if (cover) await tx.prepare("UPDATE wash_store_images SET is_cover = 1 WHERE id = ?").run(String(cover.id));
      }
      const now = new Date().toISOString();
      await tx.prepare("UPDATE wash_stores SET cover_image_url = ?, updated_at = ? WHERE id = ?")
        .run(cover ? `/api/wash/store-images/${String(cover.id)}` : null, now, request.params.id);
      const result = await storeImages(tx, request.params.id, audience);
      await auditWashMutation(tx, request, "wash.store_image.reorder", {
        type: "wash_store",
        id: request.params.id,
      }, { before: { images: beforeImages }, after: { images: result } });
      return result;
    });
    return { data: { images } };
  });

  app.delete<{ Params: { id: string; imageId: string } }>(
    "/api/admin/wash/stores/:id/images/:imageId",
    async (request) => {
      const access = washBackofficeAccess(request, WASH_CAPABILITIES.storeWrite, problem);
      const audience: WashStoreAudience = access.storeId ? "provider" : "platform";
      const { deleted, images } = await database.transaction(async (tx) => {
        const store = await findStore(tx, request.params.id, true, access.storeId ?? undefined);
        if (!store) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
        const image = await tx.prepare<Row>(`
          SELECT * FROM wash_store_images WHERE id = ? AND store_id = ? FOR UPDATE
        `).get(request.params.imageId, request.params.id);
        if (!image) throw problem(404, "WASH_STORE_IMAGE_NOT_FOUND", "门店图片不存在");
        await tx.prepare("DELETE FROM wash_store_images WHERE id = ? AND store_id = ?")
          .run(request.params.imageId, request.params.id);
        let cover = await tx.prepare<Row>(`
          SELECT * FROM wash_store_images WHERE store_id = ? AND is_cover = 1 LIMIT 1
        `).get(request.params.id);
        if (!cover) {
          cover = await tx.prepare<Row>(`
            SELECT * FROM wash_store_images WHERE store_id = ? ORDER BY sort_order, created_at, id LIMIT 1
          `).get(request.params.id);
          if (cover) await tx.prepare("UPDATE wash_store_images SET is_cover = 1 WHERE id = ?").run(String(cover.id));
        }
        const now = new Date().toISOString();
        await tx.prepare("UPDATE wash_stores SET cover_image_url = ?, updated_at = ? WHERE id = ?")
          .run(cover ? `/api/wash/store-images/${String(cover.id)}` : null, now, request.params.id);
        const images = await storeImages(tx, request.params.id, audience);
        await auditWashMutation(tx, request, "wash.store_image.delete", {
          type: "wash_store_image",
          id: request.params.imageId,
        }, {
          before: storeImageFromRow(image, audience),
          after: { deleted: true, images },
          metadata: { storeId: request.params.id },
        });
        return { deleted: image, images };
      });
      await removeWashImageBestEffort(deleted);
      return {
        data: {
          id: request.params.imageId,
          deleted: true,
          images,
        },
      };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/wash/stores/:id", async (request) => {
    platformWashAccess(request, problem);
    const outcome = await database.transaction(async (tx) => {
      const row = await findStore(tx, request.params.id, true);
      if (!row) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      const beforeStore = await storeFromRow(tx, row, undefined, "platform");

      // Invitation creation locks the store before it creates an assignment.
      // Taking the same lock first makes the access check and deletion mutually
      // exclusive with a concurrent invite/replacement flow.
      const assignments = await tx.prepare<Row>(`
        SELECT id FROM backoffice_subject_assignments
        WHERE subject_type = 'wash_store' AND subject_id = ?
          AND status IN ('active', 'pending')
        FOR UPDATE
      `).all(request.params.id);
      const activeInvites = await tx.prepare<Row>(`
        SELECT i.id
        FROM backoffice_invites i
        JOIN backoffice_subject_assignments sa ON sa.account_id = i.account_id
        WHERE sa.subject_type = 'wash_store' AND sa.subject_id = ?
          AND i.kind IN ('activation', 'password_reset')
          AND i.consumed_at IS NULL AND i.invalidated_at IS NULL
          AND i.expires_at > NOW()
        FOR UPDATE OF i
      `).all(request.params.id);
      if (assignments.length > 0 || activeInvites.length > 0) {
        throw problem(
          409,
          "WASH_STORE_BACKOFFICE_ACCESS_EXISTS",
          "门店仍绑定后台账号或存在有效邀请，不能删除",
        );
      }

      const activeOrder = await tx.prepare(`
        SELECT id FROM wash_orders
        WHERE store_id = ? AND status IN ('pending_payment', 'awaiting_redemption') LIMIT 1
      `).get(request.params.id);
      if (activeOrder) throw problem(409, "WASH_STORE_HAS_ACTIVE_ORDERS", "门店仍有待支付或待核销订单，不能删除");
      const history = await tx.prepare("SELECT id FROM wash_orders WHERE store_id = ? LIMIT 1")
        .get(request.params.id);
      if (history) {
        const now = new Date().toISOString();
        await tx.prepare("UPDATE wash_stores SET is_active = 0, updated_at = ? WHERE id = ?")
          .run(now, request.params.id);
        await tx.prepare("UPDATE wash_store_offers SET is_available = 0, updated_at = ? WHERE store_id = ?")
          .run(now, request.params.id);
        await tx.prepare("UPDATE wash_slots SET is_open = 0, updated_at = ? WHERE store_id = ? AND date >= ?")
          .run(now, request.params.id, businessDate());
        const archived = await findStore(tx, request.params.id);
        if (!archived) throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
        const archivedStore = await storeFromRow(tx, archived, undefined, "platform");
        await auditWashMutation(tx, request, "wash.store.archive", {
          type: "wash_store",
          id: request.params.id,
        }, { before: beforeStore, after: archivedStore });
        return {
          images: [] as Row[],
          data: {
            id: request.params.id,
            deleted: false,
            archived: true,
            store: archivedStore,
          },
        };
      }

      const images = await tx.prepare<Row>(`
        SELECT * FROM wash_store_images WHERE store_id = ? FOR UPDATE
      `).all(request.params.id);
      await tx.prepare("DELETE FROM wash_stores WHERE id = ?").run(request.params.id);
      await auditWashMutation(tx, request, "wash.store.delete", {
        type: "wash_store",
        id: request.params.id,
      }, { before: beforeStore, after: { deleted: true } });
      return {
        images,
        data: { id: request.params.id, deleted: true, archived: false },
      };
    });
    for (const image of outcome.images) {
      await removeWashImageBestEffort(image);
    }
    return { data: outcome.data };
  });

  app.get<{ Params: { id: string } }>("/api/admin/wash/stores/:id/valet-rule", async (request) => {
    platformWashAccess(request, problem);
    if (!await findStore(database, request.params.id)) {
      throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
    }
    const rule = await resolvedWashValetRule(database, request.params.id, problem);
    return { data: { ...rule, inherited: rule.scope === "global" } };
  });

  app.put<{ Params: { id: string } }>("/api/admin/wash/stores/:id/valet-rule", async (request, reply) => {
    platformWashAccess(request, problem);
    const body = parseBody(adminValetRuleSchema, request.body, reply);
    if (!body) return;
    const now = new Date().toISOString();
    const rule = await database.transaction(async (tx) => {
      if (!await findStore(tx, request.params.id, true)) {
        throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      }
      const before = await resolvedWashValetRule(tx, request.params.id, problem);
      await tx.prepare(`
        INSERT INTO wash_store_valet_pricing_overrides (
          store_id, base_fee_fen, included_km, per_km_fen, max_radius_km, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(store_id) DO UPDATE SET
          base_fee_fen = excluded.base_fee_fen,
          included_km = excluded.included_km,
          per_km_fen = excluded.per_km_fen,
          max_radius_km = excluded.max_radius_km,
          updated_at = excluded.updated_at
      `).run(
        request.params.id,
        body.baseFeeFen,
        body.includedKm,
        body.perKmFen,
        body.maxRadiusKm,
        now,
      );
      const result = await resolvedWashValetRule(tx, request.params.id, problem);
      await auditWashMutation(tx, request, "wash.valet_rule.update", {
        type: "wash_store_valet_rule",
        id: request.params.id,
      }, { before, after: result });
      return result;
    });
    return { data: { ...rule, inherited: false } };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/wash/stores/:id/valet-rule", async (request) => {
    platformWashAccess(request, problem);
    const rule = await database.transaction(async (tx) => {
      if (!await findStore(tx, request.params.id, true)) {
        throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      }
      const before = await resolvedWashValetRule(tx, request.params.id, problem);
      await tx.prepare("DELETE FROM wash_store_valet_pricing_overrides WHERE store_id = ?")
        .run(request.params.id);
      const result = await resolvedWashValetRule(tx, request.params.id, problem);
      await auditWashMutation(tx, request, "wash.valet_rule.delete", {
        type: "wash_store_valet_rule",
        id: request.params.id,
      }, { before, after: result });
      return result;
    });
    return { data: { ...rule, inherited: true } };
  });

  app.get("/api/admin/wash/packages", async (request) => {
    washBackofficeAccess(request, WASH_CAPABILITIES.offersRead, problem);
    const rows = await database.prepare<Row>("SELECT * FROM wash_packages ORDER BY sort_order, id").all();
    return { data: rows.map(packageFromRow) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/wash/packages/:id", async (request) => {
    washBackofficeAccess(request, WASH_CAPABILITIES.offersRead, problem);
    const row = await findPackage(database, request.params.id);
    if (!row) throw problem(404, "WASH_PACKAGE_NOT_FOUND", "未找到洗车套餐");
    return { data: packageFromRow(row) };
  });

  app.post("/api/admin/wash/packages", async (request, reply) => {
    platformWashAccess(request, problem);
    const body = parseBody(adminPackageSchema, request.body, reply);
    if (!body) return;
    const id = body.id ?? randomUUID();
    const now = new Date().toISOString();
    const items = body.serviceItems ?? body.includedItems ?? [];
    const created = await database.transaction(async (tx) => {
      if (await findPackage(tx, id)) throw problem(409, "WASH_PACKAGE_ID_EXISTS", "洗车套餐 ID 已存在");
      if (await tx.prepare("SELECT id FROM wash_packages WHERE code = ?").get(body.code)) {
        throw problem(409, "WASH_PACKAGE_CODE_EXISTS", "洗车套餐编码已存在");
      }
      await tx.prepare(`
        INSERT INTO wash_packages (
          id, code, name, short_description, service_items_json, duration_minutes,
          sort_order, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        body.code,
        body.name,
        body.shortDescription,
        JSON.stringify(items),
        body.durationMinutes,
        body.sortOrder,
        body.isActive ? 1 : 0,
        now,
        now,
      );
      const row = await findPackage(tx, id);
      if (!row) throw problem(500, "WASH_PACKAGE_CREATE_FAILED", "洗车套餐创建失败");
      const result = packageFromRow(row);
      await auditWashMutation(tx, request, "wash.package.create", { type: "wash_package", id }, { after: result });
      return result;
    });
    return reply.status(201).send({ data: created });
  });

  app.put<{ Params: { id: string } }>("/api/admin/wash/packages/:id", async (request, reply) => {
    platformWashAccess(request, problem);
    const body = parseBody(adminPackageSchema, request.body, reply);
    if (!body) return;
    const now = new Date().toISOString();
    const items = body.serviceItems ?? body.includedItems ?? [];
    const result = await database.transaction(async (tx) => {
      const current = await findPackage(tx, request.params.id, true);
      if (!current) throw problem(404, "WASH_PACKAGE_NOT_FOUND", "未找到洗车套餐");
      if (await tx.prepare("SELECT id FROM wash_packages WHERE code = ? AND id <> ?").get(body.code, request.params.id)) {
        throw problem(409, "WASH_PACKAGE_CODE_EXISTS", "洗车套餐编码已存在");
      }
      const before = packageFromRow(current);
      await tx.prepare(`
        UPDATE wash_packages SET code = ?, name = ?, short_description = ?, service_items_json = ?,
          duration_minutes = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?
      `).run(
        body.code,
        body.name,
        body.shortDescription,
        JSON.stringify(items),
        body.durationMinutes,
        body.sortOrder,
        body.isActive ? 1 : 0,
        now,
        request.params.id,
      );
      if (!body.isActive) {
        await tx.prepare("UPDATE wash_store_offers SET is_available = 0, updated_at = ? WHERE package_id = ?")
          .run(now, request.params.id);
      }
      const updated = await findPackage(tx, request.params.id);
      if (!updated) throw problem(404, "WASH_PACKAGE_NOT_FOUND", "未找到洗车套餐");
      const result = packageFromRow(updated);
      await auditWashMutation(tx, request, "wash.package.update", {
        type: "wash_package",
        id: request.params.id,
      }, { before, after: result });
      return result;
    });
    return { data: result };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/wash/packages/:id", async (request) => {
    platformWashAccess(request, problem);
    const now = new Date().toISOString();
    const result = await database.transaction(async (tx) => {
      const row = await findPackage(tx, request.params.id, true);
      if (!row) throw problem(404, "WASH_PACKAGE_NOT_FOUND", "未找到洗车套餐");
      const before = packageFromRow(row);
      await tx.prepare("UPDATE wash_packages SET is_active = 0, updated_at = ? WHERE id = ?")
        .run(now, request.params.id);
      await tx.prepare("UPDATE wash_store_offers SET is_available = 0, updated_at = ? WHERE package_id = ?")
        .run(now, request.params.id);
      const updated = await findPackage(tx, request.params.id);
      if (!updated) throw problem(404, "WASH_PACKAGE_NOT_FOUND", "未找到洗车套餐");
      const result = packageFromRow(updated);
      await auditWashMutation(tx, request, "wash.package.disable", {
        type: "wash_package",
        id: request.params.id,
      }, { before, after: result });
      return result;
    });
    return { data: result };
  });

  app.get<{ Params: { id: string } }>("/api/admin/wash/stores/:id/offers", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.offersRead, problem);
    if (!await findStore(database, request.params.id, false, access.storeId ?? undefined)) {
      throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
    }
    const rows = await storeOfferRows(database, request.params.id);
    return { data: rows.map((row) => offerFromRow(row, access.storeId === null)) };
  });

  app.put<{ Params: { id: string } }>("/api/admin/wash/stores/:id/offers", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.offersWrite, problem);
    const parsed = offerMatrixSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "报价矩阵信息有误", fields: validationFields(parsed.error) } });
      return;
    }
    const normalized = parsed.data.offers.map((item) => ({
      ...item,
      vehicleCategory: item.vehicleCategory ?? item.vehicleType!,
      isAvailable: item.isAvailable ?? item.isActive ?? true,
    }));
    const now = new Date().toISOString();
    const result = await database.transaction(async (tx) => {
      // Lock and re-check the authenticated store scope in the same transaction
      // that mutates the matrix; preflight ids and request bodies are not authority.
      if (!await findStore(tx, request.params.id, true, access.storeId ?? undefined)) {
        throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      }
      const beforeRows = await storeOfferRows(tx, request.params.id, true);
      const beforeOffers = beforeRows.map((row) => offerFromRow(row, access.storeId === null));
      const existingOfferKeys = new Set(beforeOffers.map(
        (offer) => `${offer.packageId}:${offer.vehicleCategory}`,
      ));
      const seen = new Set<string>();
      for (const item of normalized) {
        const key = `${item.packageId}:${item.vehicleCategory}`;
        if (seen.has(key)) throw problem(400, "WASH_OFFER_DUPLICATE", "报价矩阵包含重复套餐与车型组合");
        seen.add(key);
        if (!await findPackage(tx, item.packageId)) {
          throw problem(404, "WASH_PACKAGE_NOT_FOUND", `未找到套餐 ${item.packageId}`);
        }
        if (access.storeId && !existingOfferKeys.has(key)) {
          throw problem(403, "WASH_OFFER_CREATE_FORBIDDEN", "门店管理员只能修改平台已配置的报价项");
        }
      }
      await tx.prepare("UPDATE wash_store_offers SET is_available = 0, updated_at = ? WHERE store_id = ?")
        .run(now, request.params.id);
      if (access.storeId) {
        const update = tx.prepare(`
          UPDATE wash_store_offers
          SET sale_price_fen = ?, is_available = ?, updated_at = ?
          WHERE store_id = ? AND package_id = ? AND vehicle_category = ?
        `);
        for (const item of normalized) {
          const result = await update.run(
            item.salePriceFen,
            item.isAvailable ? 1 : 0,
            now,
            request.params.id,
            item.packageId,
            item.vehicleCategory,
          );
          if (result.changes !== 1) {
            throw problem(404, "WASH_OFFER_NOT_FOUND", "报价项不存在或不属于当前门店");
          }
        }
      } else {
        const upsert = tx.prepare(`
          INSERT INTO wash_store_offers (
            store_id, package_id, vehicle_category, sale_price_fen, list_price_fen,
            estimated_settlement_fen, is_available, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(store_id, package_id, vehicle_category) DO UPDATE SET
            sale_price_fen = excluded.sale_price_fen,
            list_price_fen = excluded.list_price_fen,
            estimated_settlement_fen = excluded.estimated_settlement_fen,
            is_available = excluded.is_available,
            updated_at = excluded.updated_at
        `);
        for (const item of normalized) {
          await upsert.run(
            request.params.id,
            item.packageId,
            item.vehicleCategory,
            item.salePriceFen,
            item.listPriceFen ?? null,
            item.estimatedSettlementFen ?? item.salePriceFen,
            item.isAvailable ? 1 : 0,
            now,
          );
        }
      }
      const rows = await storeOfferRows(tx, request.params.id);
      const result = rows.map((row) => offerFromRow(row, access.storeId === null));
      await auditWashMutation(tx, request, "wash.store_offers.update", {
        type: "wash_store",
        id: request.params.id,
      }, { before: beforeOffers, after: result });
      return result;
    });
    return { data: result };
  });

  app.get<{
    Querystring: { storeId?: string; date?: string; dateFrom?: string; dateTo?: string; page?: string; pageSize?: string };
  }>("/api/admin/wash/slots", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.slotsRead, problem);
    const pagination = optionalPagination(request.query, problem);
    await expirePendingOrders(database);
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];
    const effectiveStoreId = scopedStoreId(access, request.query.storeId, problem);
    if (effectiveStoreId) {
      clauses.push("store_id = ?");
      values.push(effectiveStoreId);
    }
    if (request.query.date) {
      if (!isRealIsoDate(request.query.date)) throw problem(400, "INVALID_DATE", "日期格式无效");
      clauses.push("date = ?");
      values.push(request.query.date);
    }
    if (request.query.dateFrom) {
      if (!isRealIsoDate(request.query.dateFrom)) throw problem(400, "INVALID_DATE", "起始日期格式无效");
      clauses.push("date >= ?");
      values.push(request.query.dateFrom);
    }
    if (request.query.dateTo) {
      if (!isRealIsoDate(request.query.dateTo)) throw problem(400, "INVALID_DATE", "结束日期格式无效");
      clauses.push("date <= ?");
      values.push(request.query.dateTo);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = pagination.requested
      ? Number((await database.prepare<Row>(`
          SELECT COUNT(*)::text AS count FROM wash_slots ${whereSql}
        `).get(...values))?.count ?? 0)
      : 0;
    const rows = await database.prepare<Row>(`
      SELECT * FROM wash_slots ${whereSql}
      ORDER BY date DESC, start_time, store_id
      ${pagination.requested ? "LIMIT ? OFFSET ?" : ""}
    `).all(...values, ...(pagination.requested ? [pagination.pageSize, pagination.offset] : []));
    const items = await Promise.all(rows.map((row) => slotFromRow(database, row)));
    if (!pagination.requested) return { data: items };
    return {
      data: { items, total, page: pagination.page, pageSize: pagination.pageSize },
      meta: { total, page: pagination.page, pageSize: pagination.pageSize },
    };
  });

  app.post("/api/admin/wash/slots", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.slotsWrite, problem);
    const body = parseBody(adminSlotSchema, request.body, reply);
    if (!body) return;
    const storeId = scopedStoreId(access, body.storeId, problem)!;
    const id = randomUUID();
    const now = new Date().toISOString();
    const created = await database.transaction(async (tx) => {
      if (!await findStore(tx, storeId, true, access.storeId ?? undefined)) {
        throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      }
      const conflict = await tx.prepare(`
        SELECT id FROM wash_slots WHERE store_id = ? AND date = ? AND start_time = ?
      `).get(storeId, body.date, body.startTime);
      if (conflict) throw problem(409, "WASH_SLOT_EXISTS", "该门店同一开始时间的号源已存在");
      await tx.prepare(`
        INSERT INTO wash_slots (
          id, store_id, date, start_time, end_time, capacity, is_open, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, storeId, body.date, body.startTime, body.endTime, body.capacity, body.isOpen ? 1 : 0, now, now);
      const row = await findSlot(tx, id, false, access.storeId ?? undefined);
      if (!row) throw problem(500, "WASH_SLOT_CREATE_FAILED", "洗车号源创建失败");
      const result = await slotFromRow(tx, row);
      await auditWashMutation(tx, request, "wash.slot.create", { type: "wash_slot", id }, { after: result });
      return result;
    });
    return reply.status(201).send({ data: created });
  });

  app.post("/api/admin/wash/slots/batch", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.slotsWrite, problem);
    const body = parseBody(adminSlotBatchSchema, request.body, reply);
    if (!body) return;
    const storeId = scopedStoreId(access, body.storeId, problem)!;
    const dates = dateRange(body.dateFrom, body.dateTo).filter((date) => {
      if (!body.weekdays) return true;
      return body.weekdays.includes(weekdayByNumber[new Date(`${date}T00:00:00Z`).getUTCDay()]);
    });
    const starts: Array<{ start: string; end: string }> = [];
    for (let minute = toMinutes(body.startTime); minute + body.slotMinutes <= toMinutes(body.endTime); minute += body.slotMinutes) {
      starts.push({ start: fromMinutes(minute), end: fromMinutes(minute + body.slotMinutes) });
    }
    if (starts.length === 0) throw problem(400, "WASH_SLOT_BATCH_EMPTY", "营业时间范围不足以生成一个时段");
    const now = new Date().toISOString();
    const result = await database.transaction(async (tx) => {
      if (!await findStore(tx, storeId, true, access.storeId ?? undefined)) {
        throw problem(404, "WASH_STORE_NOT_FOUND", "未找到洗车门店");
      }
      const created: Row[] = [];
      let skippedCount = 0;
      const exists = tx.prepare(`
        SELECT id FROM wash_slots WHERE store_id = ? AND date = ? AND start_time = ?
      `);
      const insert = tx.prepare(`
        INSERT INTO wash_slots (
          id, store_id, date, start_time, end_time, capacity, is_open, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const date of dates) {
        for (const period of starts) {
          if (await exists.get(storeId, date, period.start)) {
            skippedCount += 1;
            continue;
          }
          const id = randomUUID();
          await insert.run(id, storeId, date, period.start, period.end, body.capacity, now, now);
          const row = await findSlot(tx, id, false, access.storeId ?? undefined);
          if (row) created.push(row);
        }
      }
      const result = {
        createdCount: created.length,
        skippedCount,
        slots: await Promise.all(created.map((row) => slotFromRow(tx, row))),
      };
      if (created.length > 0) {
        await auditWashMutation(tx, request, "wash.slot.batch_create", {
          type: "wash_store",
          id: storeId,
        }, { after: result });
      }
      return result;
    });
    return reply.status(201).send({ data: result });
  });

  const updateSlot = async (
    id: string,
    raw: unknown,
    partial: boolean,
    reply: FastifyReply,
    access: WashBackofficeAccess,
    request: FastifyRequest,
  ) => {
    await expirePendingOrders(database);
    return database.transaction(async (tx) => {
      const current = await findSlot(tx, id, true, access.storeId ?? undefined);
      if (!current) throw problem(404, "WASH_SLOT_NOT_FOUND", "未找到洗车号源");
      const before = await slotFromRow(tx, current);
      let next: z.infer<typeof adminSlotUpdateSchema>;
      if (partial) {
        const patch = parseBody(adminSlotPatchSchema, raw, reply);
        if (!patch) return undefined;
        const isOpen = patch.isOpen ?? (patch.isClosed === undefined ? bool(current.is_open) : !patch.isClosed);
        const candidate = {
          date: patch.date ?? String(current.date),
          startTime: patch.startTime ?? String(current.start_time),
          endTime: patch.endTime ?? String(current.end_time),
          capacity: patch.capacity ?? Number(current.capacity),
          isOpen,
        };
        const checked = adminSlotUpdateSchema.safeParse(candidate);
        if (!checked.success) {
          reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "号源信息有误", fields: validationFields(checked.error) } });
          return undefined;
        }
        next = checked.data;
      } else {
        const parsed = parseBody(adminSlotUpdateSchema, raw, reply);
        if (!parsed) return undefined;
        next = parsed;
      }
      const reserved = await activeReservationCount(tx, id);
      if (next.capacity < reserved) throw problem(409, "WASH_SLOT_CAPACITY_BELOW_RESERVED", "容量不能低于当前已占用数量");
      const timingChanged = next.date !== String(current.date)
        || next.startTime !== String(current.start_time)
        || next.endTime !== String(current.end_time);
      if (reserved > 0 && (timingChanged || !next.isOpen)) {
        throw problem(409, "WASH_SLOT_HAS_RESERVATIONS", "该时段已有订单，不能改时间或关闭");
      }
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(
        `wash-slot:${String(current.store_id)}:${next.date}:${next.startTime}`,
      );
      const conflict = await tx.prepare(`
        SELECT id FROM wash_slots WHERE store_id = ? AND date = ? AND start_time = ? AND id <> ?
      `).get(String(current.store_id), next.date, next.startTime, id);
      if (conflict) throw problem(409, "WASH_SLOT_EXISTS", "该门店同一开始时间的号源已存在");
      const now = new Date().toISOString();
      await tx.prepare(`
        UPDATE wash_slots SET date = ?, start_time = ?, end_time = ?, capacity = ?, is_open = ?, updated_at = ?
        WHERE id = ?
      `).run(next.date, next.startTime, next.endTime, next.capacity, next.isOpen ? 1 : 0, now, id);
      const updated = await findSlot(tx, id, false, access.storeId ?? undefined);
      if (!updated) throw problem(404, "WASH_SLOT_NOT_FOUND", "未找到洗车号源");
      const result = await slotFromRow(tx, updated);
      await auditWashMutation(tx, request, "wash.slot.update", {
        type: "wash_slot",
        id,
      }, { before, after: result });
      return result;
    });
  };

  app.patch<{ Params: { id: string } }>("/api/admin/wash/slots/:id", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.slotsWrite, problem);
    const slot = await updateSlot(request.params.id, request.body, true, reply, access, request);
    if (!slot) return;
    return { data: slot };
  });

  app.put<{ Params: { id: string } }>("/api/admin/wash/slots/:id", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.slotsWrite, problem);
    const slot = await updateSlot(request.params.id, request.body, false, reply, access, request);
    if (!slot) return;
    return { data: slot };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/wash/slots/:id", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.slotsWrite, problem);
    await database.transaction(async (tx) => {
      const row = await findSlot(tx, request.params.id, true, access.storeId ?? undefined);
      if (!row) throw problem(404, "WASH_SLOT_NOT_FOUND", "未找到洗车号源");
      const before = await slotFromRow(tx, row);
      if (await tx.prepare("SELECT id FROM wash_orders WHERE slot_id = ? LIMIT 1").get(request.params.id)) {
        throw problem(409, "WASH_SLOT_HAS_ORDER_HISTORY", "该号源已有订单历史，只能关闭不能删除");
      }
      await tx.prepare("DELETE FROM wash_slots WHERE id = ?").run(request.params.id);
      await auditWashMutation(tx, request, "wash.slot.delete", {
        type: "wash_slot",
        id: request.params.id,
      }, { before, after: { deleted: true } });
    });
    return { data: { id: request.params.id, deleted: true } };
  });

  app.get("/api/admin/wash/dashboard", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.dashboardRead, problem);
    await expirePendingOrders(database);
    const today = businessDate();
    const sevenDayStartValue = new Date(`${today}T00:00:00Z`);
    sevenDayStartValue.setUTCDate(sevenDayStartValue.getUTCDate() - 6);
    const sevenDayStart = sevenDayStartValue.toISOString().slice(0, 10);
    const storeClause = access.storeId ? "WHERE store_id = ?" : "";
    const orderMetrics = await database.prepare<Row>(`
      SELECT
        COUNT(*) FILTER (WHERE appointment_date = ?) AS today_orders,
        COUNT(*) FILTER (WHERE status = 'awaiting_redemption') AS awaiting_redemption,
        COALESCE(SUM(total_fee_fen) FILTER (
          WHERE appointment_date BETWEEN ? AND ?
            AND payment_status = 'paid'
            AND status IN ('awaiting_redemption', 'redeemed')
        ), 0) AS seven_day_service_amount_fen
      FROM wash_orders
      ${storeClause}
    `).get(...(access.storeId
      ? [today, sevenDayStart, today, access.storeId]
      : [today, sevenDayStart, today])) ?? {};

    const futureSlotClauses = [
      "s.is_open = 1",
      "(s.date > ? OR (s.date = ? AND s.start_time > ?))",
    ];
    const futureSlotValues: Array<string | number | null> = [today, today, shanghaiTime(currentTime())];
    if (access.storeId) {
      futureSlotClauses.push("s.store_id = ?");
      futureSlotValues.push(access.storeId);
    }
    const futureSlots = await database.prepare<Row>(`
      SELECT COALESCE(SUM(GREATEST(s.capacity - COALESCE(reserved.count, 0), 0)), 0) AS future_capacity
      FROM wash_slots AS s
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS count
        FROM wash_orders AS o
        WHERE o.slot_id = s.id AND (
          o.status IN ('awaiting_redemption', 'redeemed')
          OR (o.status = 'pending_payment' AND o.hold_expires_at > ?)
        )
      ) AS reserved ON TRUE
      WHERE ${futureSlotClauses.join(" AND ")}
    `).get(new Date().toISOString(), ...futureSlotValues) ?? {};

    const recentOrderRows = access.storeId
      ? await database.prepare<Row>(`
          SELECT * FROM wash_orders WHERE store_id = ? ORDER BY created_at DESC, id DESC LIMIT 5
        `).all(access.storeId)
      : await database.prepare<Row>(`
          SELECT * FROM wash_orders ORDER BY created_at DESC, id DESC LIMIT 5
        `).all();
    const recentAuditRows = access.storeId
      ? await database.prepare<Row>(`
          SELECT e.*, ws.name AS subject_name
          FROM backoffice_audit_events e
          LEFT JOIN wash_stores ws ON e.subject_type = 'wash_store' AND ws.id = e.subject_id
          WHERE e.account_id = ? AND e.subject_type = 'wash_store' AND e.subject_id = ?
            AND e.action NOT LIKE 'backoffice.http.%'
            AND e.action <> 'backoffice.accounts.listed'
            AND e.action <> 'wash.request.rejected'
            AND e.action <> 'wash.order.note_update'
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 5
        `).all(access.session.account.id, access.storeId)
      : await database.prepare<Row>(`
          SELECT e.*, ws.name AS subject_name
          FROM backoffice_audit_events e
          LEFT JOIN wash_stores ws ON e.subject_type = 'wash_store' AND ws.id = e.subject_id
          WHERE e.action NOT LIKE 'backoffice.http.%'
            AND e.action <> 'backoffice.accounts.listed'
            AND e.action <> 'wash.request.rejected'
            AND e.action <> 'wash.order.note_update'
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 5
        `).all();
    const todayOrders = Number(orderMetrics.today_orders ?? 0);
    const awaitingRedemption = Number(orderMetrics.awaiting_redemption ?? 0);
    const futureCapacity = Number(futureSlots.future_capacity ?? 0);
    const sevenDayServiceAmountFen = Number(orderMetrics.seven_day_service_amount_fen ?? 0);
    const recentOrders = await Promise.all(recentOrderRows.map((row) => washStoreOrderFromRow(database, row)));
    const recentAuditEvents = recentAuditRows.map((row) => backofficeAuditEventDto(row));
    const metrics = {
      todayOrders,
      awaitingRedemption,
      futureCapacity,
      futureSlots: futureCapacity,
      availableFutureSlots: futureCapacity,
      sevenDayServiceAmountFen,
      serviceAmountLast7DaysFen: sevenDayServiceAmountFen,
    };

    return {
      data: {
        storeId: access.storeId,
        businessDate: today,
        ...metrics,
        metrics,
        recentOrders,
        recentAuditEvents,
        recentEvents: recentAuditEvents,
      },
    };
  });

  app.get<{
    Querystring: { storeId?: string; status?: string; dateFrom?: string; dateTo?: string; page?: string; pageSize?: string };
  }>("/api/admin/wash/settlements", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.settlementsRead, problem);
    const pagination = optionalPagination(request.query, problem);
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];
    const effectiveStoreId = scopedStoreId(access, request.query.storeId, problem);
    if (effectiveStoreId) {
      clauses.push("o.store_id = ?");
      values.push(effectiveStoreId);
    }
    if (request.query.status) {
      const status = settlementStatusSchema.safeParse(request.query.status);
      if (!status.success) throw problem(400, "INVALID_SETTLEMENT_STATUS", "结算状态无效");
      clauses.push("s.status = ?");
      values.push(status.data);
    }
    if (request.query.dateFrom) {
      if (!isRealIsoDate(request.query.dateFrom)) throw problem(400, "INVALID_DATE", "起始日期格式无效");
      clauses.push("o.appointment_date >= ?");
      values.push(request.query.dateFrom);
    }
    if (request.query.dateTo) {
      if (!isRealIsoDate(request.query.dateTo)) throw problem(400, "INVALID_DATE", "结束日期格式无效");
      clauses.push("o.appointment_date <= ?");
      values.push(request.query.dateTo);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = pagination.requested
      ? Number((await database.prepare<Row>(`
          SELECT COUNT(*)::text AS count
          FROM wash_order_settlements AS s
          JOIN wash_orders AS o ON o.id = s.order_id
          ${whereSql}
        `).get(...values))?.count ?? 0)
      : 0;
    const rows = await database.prepare<Row>(`
      SELECT s.*, o.order_number, o.store_id, o.appointment_date, o.start_time, o.end_time,
        o.total_fee_fen, o.status AS order_status,
        COALESCE((o.store_snapshot_json::jsonb)->>'name', '') AS store_name
      FROM wash_order_settlements AS s
      JOIN wash_orders AS o ON o.id = s.order_id
      ${whereSql}
      ORDER BY o.appointment_date DESC, o.start_time DESC, o.created_at DESC
      ${pagination.requested ? "LIMIT ? OFFSET ?" : ""}
    `).all(...values, ...(pagination.requested ? [pagination.pageSize, pagination.offset] : []));
    const items = rows.map((row) => ({
        orderId: String(row.order_id),
        orderNumber: String(row.order_number),
        storeId: String(row.store_id),
        storeName: String(row.store_name ?? ""),
        appointmentDate: String(row.appointment_date),
        startTime: String(row.start_time),
        endTime: String(row.end_time),
        orderStatus: String(row.order_status),
        orderAmountFen: Number(row.total_fee_fen),
        status: String(row.status),
        amountFen: String(row.status) === "settled" ? Number(row.amount_fen) : null,
        settledAt: row.settled_at == null ? null : String(row.settled_at),
        updatedAt: String(row.updated_at),
        ...(access.storeId ? {} : {
          operator: row.operator == null ? null : String(row.operator),
          reason: row.reason == null ? null : String(row.reason),
          note: row.note == null ? null : String(row.note),
        }),
      }));
    if (!pagination.requested) return { data: items };
    return {
      data: { items, total, page: pagination.page, pageSize: pagination.pageSize },
      meta: { total, page: pagination.page, pageSize: pagination.pageSize },
    };
  });

  app.get<{
    Querystring: {
      date?: string;
      dateFrom?: string;
      dateTo?: string;
      storeId?: string;
      status?: string;
      serviceMode?: string;
      settlementStatus?: string;
      verificationCode?: string;
      code?: string;
      orderNumber?: string;
      page?: string;
      pageSize?: string;
    };
  }>("/api/admin/wash/orders", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.ordersRead, problem);
    const pagination = optionalPagination(request.query, problem);
    await expirePendingOrders(database);
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];
    if (request.query.date) {
      if (!isRealIsoDate(request.query.date)) throw problem(400, "INVALID_DATE", "日期格式无效");
      clauses.push("o.appointment_date = ?");
      values.push(request.query.date);
    }
    if (request.query.dateFrom) {
      if (!isRealIsoDate(request.query.dateFrom)) throw problem(400, "INVALID_DATE", "起始日期格式无效");
      clauses.push("o.appointment_date >= ?");
      values.push(request.query.dateFrom);
    }
    if (request.query.dateTo) {
      if (!isRealIsoDate(request.query.dateTo)) throw problem(400, "INVALID_DATE", "结束日期格式无效");
      clauses.push("o.appointment_date <= ?");
      values.push(request.query.dateTo);
    }
    const effectiveStoreId = scopedStoreId(access, request.query.storeId, problem);
    if (effectiveStoreId) {
      clauses.push("o.store_id = ?");
      values.push(effectiveStoreId);
    }
    if (request.query.status) {
      const parsed = washOrderStatusSchema.safeParse(request.query.status);
      if (!parsed.success) throw problem(400, "INVALID_WASH_ORDER_STATUS", "洗车订单状态无效");
      clauses.push("o.status = ?");
      values.push(parsed.data);
    }
    if (request.query.serviceMode) {
      const parsed = washServiceModeSchema.safeParse(request.query.serviceMode);
      if (!parsed.success) throw problem(400, "INVALID_WASH_SERVICE_MODE", "洗车服务方式无效");
      clauses.push("o.service_mode = ?");
      values.push(parsed.data);
    }
    if (request.query.settlementStatus) {
      const parsed = settlementStatusSchema.safeParse(request.query.settlementStatus);
      if (!parsed.success) throw problem(400, "INVALID_SETTLEMENT_STATUS", "结算状态无效");
      clauses.push("s.status = ?");
      values.push(parsed.data);
    }
    const verificationCode = request.query.verificationCode ?? request.query.code;
    if (verificationCode) {
      if (access.storeId) throw problem(403, "BACKOFFICE_FORBIDDEN", "门店订单列表不支持按核销码检索");
      if (!/^\d{1,6}$/.test(verificationCode)) throw problem(400, "INVALID_REDEMPTION_CODE", "核销码格式无效");
      clauses.push("o.redemption_code LIKE ?");
      values.push(`%${verificationCode}%`);
    }
    if (request.query.orderNumber) {
      const orderNumber = request.query.orderNumber.trim();
      if (!orderNumber) throw problem(400, "INVALID_ORDER_NUMBER", "订单号不能为空");
      clauses.push("o.order_number ILIKE ?");
      values.push(`%${orderNumber}%`);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = pagination.requested
      ? Number((await database.prepare<Row>(`
          SELECT COUNT(*)::text AS count
          FROM wash_orders o
          LEFT JOIN wash_order_settlements s ON s.order_id = o.id
          ${whereSql}
        `).get(...values))?.count ?? 0)
      : 0;
    const rows = await database.prepare<Row>(`
      SELECT o.* FROM wash_orders o
      LEFT JOIN wash_order_settlements s ON s.order_id = o.id
      ${whereSql}
      ORDER BY o.appointment_date DESC, o.start_time DESC, o.created_at DESC
      ${pagination.requested ? "LIMIT ? OFFSET ?" : ""}
    `).all(...values, ...(pagination.requested ? [pagination.pageSize, pagination.offset] : []));
    const items = await Promise.all(rows.map((row) => access.storeId
      ? washStoreOrderFromRow(database, row)
      : orderFromRow(database, row, false)));
    if (!pagination.requested) return { data: items };
    return {
      data: { items, total, page: pagination.page, pageSize: pagination.pageSize },
      meta: { total, page: pagination.page, pageSize: pagination.pageSize },
    };
  });

  app.get<{ Params: { id: string } }>("/api/admin/wash/orders/:id", async (request) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.ordersRead, problem);
    await expirePendingOrders(database);
    const row = await findOrder(database, request.params.id, undefined, false, access.storeId ?? undefined);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
    return { data: access.storeId ? await washStoreOrderFromRow(database, row) : await orderFromRow(database, row) };
  });

  app.post("/api/admin/wash/orders/redeem", async (request, reply) => {
    const access = washBackofficeAccess(request, WASH_CAPABILITIES.ordersRedeem, problem);
    const body = parseBody(redeemSchema, request.body, reply);
    if (!body) return;
    await expirePendingOrders(database);
    type RedeemFailure = { statusCode: number; code: string; message: string };
    const ipHash = access.storeId ? redemptionIpHash(request) : "";
    const attempt = await database.transaction(async (tx): Promise<{ orderId?: string; failure?: RedeemFailure }> => {
      if (access.storeId) {
        await lockRedemptionBuckets(tx, access.session.account.id, access.storeId, ipHash);
        if (await redemptionIsLimited(tx, access.session.account.id, access.storeId, ipHash)) {
          return {
            failure: {
              statusCode: 429,
              code: "WASH_REDEMPTION_RATE_LIMITED",
              message: "核销尝试过于频繁，请稍后再试",
            },
          };
        }
      }
      const row = await tx.prepare<Row>(
        `SELECT * FROM wash_orders WHERE redemption_code = ?
          ${access.storeId ? "AND store_id = ?" : ""} FOR UPDATE`,
      ).get(...(access.storeId ? [body.code, access.storeId] : [body.code]));
      if (!row) {
        // Store accounts receive the same response for a code belonging to
        // another store and for a code that does not exist. Never turn the
        // six-digit input into a cross-tenant existence oracle.
        if (access.storeId) {
          await recordRedemptionAttempt(tx, access.session.account.id, access.storeId, ipHash, false);
          return { failure: { statusCode: 404, code: "WASH_ORDER_NOT_FOUND", message: "未找到洗车订单" } };
        }
        throw problem(409, "WASH_REDEMPTION_CODE_INVALID", "核销码错误或已失效");
      }
      const before = {
        status: String(row.status),
        paymentStatus: String(row.payment_status),
      };
      if (String(row.status) === "redeemed") {
        if (access.storeId) {
          await recordRedemptionAttempt(tx, access.session.account.id, access.storeId, ipHash, true);
        }
        await auditWashMutation(tx, request, "wash.order.redeem", {
          type: "wash_order",
          id: String(row.id),
        }, {
          before,
          after: before,
          metadata: { source: body.source, idempotent: true },
          recordIfUnchanged: true,
        });
        return { orderId: String(row.id) };
      }
      if (String(row.status) !== "awaiting_redemption" || String(row.payment_status) !== "paid") {
        if (access.storeId) {
          await recordRedemptionAttempt(tx, access.session.account.id, access.storeId, ipHash, false);
          return { failure: { statusCode: 404, code: "WASH_ORDER_NOT_FOUND", message: "未找到洗车订单" } };
        }
        throw problem(409, "WASH_REDEMPTION_CODE_INACTIVE", "核销码错误或已失效");
      }
      const now = new Date().toISOString();
      const updated = await tx.prepare(`
        UPDATE wash_orders SET status = 'redeemed', redeemed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'awaiting_redemption'
      `).run(now, now, String(row.id));
      if (updated.changes !== 1) {
        if (access.storeId) {
          await recordRedemptionAttempt(tx, access.session.account.id, access.storeId, ipHash, false);
          return { failure: { statusCode: 404, code: "WASH_ORDER_NOT_FOUND", message: "未找到洗车订单" } };
        }
        throw problem(409, "WASH_REDEMPTION_CODE_INACTIVE", "核销码错误或已失效");
      }
      await insertEvent(
        tx,
        String(row.id),
        "redeemed",
        "洗车服务已核销",
        body.note ? `门店已完成核销：${body.note}` : "门店已完成核销",
        "operator",
        { source: body.source, operator: access.session.account.displayName, note: body.note ?? null },
        now,
      );
      if (access.storeId) {
        await recordRedemptionAttempt(tx, access.session.account.id, access.storeId, ipHash, true);
      }
      const finalRow = await findOrder(tx, String(row.id), undefined, false, access.storeId ?? undefined);
      if (!finalRow) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
      await auditWashMutation(tx, request, "wash.order.redeem", {
        type: "wash_order",
        id: String(row.id),
      }, {
        before,
        after: {
          status: String(finalRow.status),
          paymentStatus: String(finalRow.payment_status),
        },
        metadata: { source: body.source, idempotent: false },
      });
      return { orderId: String(row.id) };
    });
    if (attempt.failure) {
      await auditBackofficeEvent(database, {
        request,
        action: "wash.order.redeem",
        outcome: "denied",
        resource: { type: "wash_store", id: access.storeId },
        metadata: { reason: attempt.failure.code },
        presentation: {
          category: "wash",
          actionLabel: "核销洗车订单失败",
          summary: "核销码无效、已失效或订单不属于当前门店，本次核销未执行",
          subjectName: access.session.subject?.name ?? null,
          resourceLabel: access.session.subject?.name ?? null,
          reason: attempt.failure.code,
        },
      }).catch(() => undefined);
      throw problem(attempt.failure.statusCode, attempt.failure.code, attempt.failure.message);
    }
    const orderId = attempt.orderId;
    if (!orderId) throw problem(409, "WASH_REDEMPTION_CODE_INVALID", "核销码错误或已失效");
    const row = await findOrder(database, orderId, undefined, false, access.storeId ?? undefined);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
    const result = access.storeId ? await washStoreOrderFromRow(database, row) : await orderFromRow(database, row);
    return { data: result };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/wash/orders/:id", async (request, reply) => {
    const session = platformWashAccess(request, problem);
    const body = parseBody(adminOrderPatchSchema, request.body, reply);
    if (!body) return;
    await expirePendingOrders(database);
    try {
      await database.transaction(async (tx) => {
        const row = await findOrder(tx, request.params.id, undefined, true);
        if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
        const status = String(row.status);
        const before = {
          status,
          paymentStatus: String(row.payment_status),
        };
        if (body.action === "cancel" && !["pending_payment", "cancelled"].includes(status)) {
          throw problem(409, "WASH_ADMIN_CANCEL_NOT_ALLOWED", "仅待支付订单可执行取消；已支付订单请执行退款");
        }
        if (body.action === "refund" && !["awaiting_redemption", "redeemed", "refunded"].includes(status)) {
          throw problem(409, "WASH_ADMIN_REFUND_NOT_ALLOWED", "仅已支付订单可执行退款");
        }
        if (body.action) {
          await cancelOrRefundOrder(tx, row, "operator", body.reason!, session.account.displayName);
        }
        if (body.internalNote !== undefined) {
          const now = new Date().toISOString();
          await tx.prepare("UPDATE wash_orders SET internal_note = ?, updated_at = ? WHERE id = ?")
            .run(body.internalNote, now, request.params.id);
          const updated = await findOrder(tx, request.params.id);
          await insertEvent(
            tx,
            request.params.id,
            String(updated?.status ?? status),
            "内部备注已更新",
            body.internalNote ? "后台已更新洗车订单内部备注" : "后台已清空洗车订单内部备注",
            "operator",
            { operator: session.account.displayName },
            now,
          );
        }
        const finalRow = await findOrder(tx, request.params.id);
        if (!finalRow) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
        if (body.action) {
          await auditWashMutation(
            tx,
            request,
            `wash.order.${body.action}`,
            { type: "wash_order", id: request.params.id },
            {
              before,
              after: {
                status: String(finalRow.status),
                paymentStatus: String(finalRow.payment_status),
              },
            },
          );
        }
      });
    } catch (error) {
      throwWashProblem(problem, error);
    }
    const row = await findOrder(database, request.params.id);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
    const result = await orderFromRow(database, row);
    return { data: result };
  });

  app.put<{ Params: { id: string } }>("/api/admin/wash/orders/:id/settlement", async (request, reply) => {
    const session = platformWashAccess(request, problem);
    const body = parseBody(settlementSchema, request.body, reply);
    if (!body) return;
    const targetStatus = body.status ?? "settled";
    const operator = session.account.displayName;
    const reason = body.correctionReason ?? body.reason;
    const settlement = await database.transaction(async (tx) => {
      const row = await findOrder(tx, request.params.id, undefined, true);
      if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
      const current = await tx.prepare<Row>(
        "SELECT * FROM wash_order_settlements WHERE order_id = ? FOR UPDATE",
      ).get(request.params.id);
      if (!current) throw problem(409, "WASH_SETTLEMENT_MISSING", "洗车订单缺少结算记录");
      const before = settlementAuditSnapshot(current);
      const amountFen = body.amountFen ?? Number(current.amount_fen);
      const note = body.note === undefined ? (current.note == null ? null : String(current.note)) : body.note;
      const changesSettledRecord = String(current.status) === "settled"
        && (targetStatus !== "settled"
          || amountFen !== Number(current.amount_fen)
          || String(note ?? "") !== String(current.note ?? ""));
      if (changesSettledRecord && !reason) {
        throw problem(400, "WASH_SETTLEMENT_CORRECTION_REASON_REQUIRED", "修正已结算记录必须填写原因");
      }
      if (targetStatus === "settled" && String(row.status) !== "redeemed") {
        throw problem(409, "WASH_SETTLEMENT_ORDER_NOT_REDEEMED", "只有已核销订单才能登记结算");
      }
      if (targetStatus !== "settled" && String(current.status) === "settled" && !reason) {
        throw problem(400, "WASH_SETTLEMENT_CORRECTION_REASON_REQUIRED", "撤销结算必须填写原因");
      }
      const now = new Date().toISOString();
      const settledAt = targetStatus === "settled"
        ? (current.settled_at == null ? now : String(current.settled_at))
        : null;
      const nextReason = reason ?? null;
      const hasSemanticChange = targetStatus !== String(current.status)
        || amountFen !== Number(current.amount_fen)
        || String(note ?? "") !== String(current.note ?? "")
        || String(nextReason ?? "") !== String(current.reason ?? "")
        || String(settledAt ?? "") !== String(current.settled_at ?? "");
      if (!hasSemanticChange) return current;
      await tx.prepare(`
        UPDATE wash_order_settlements SET status = ?, amount_fen = ?, operator = ?, reason = ?,
          note = ?, settled_at = ?, updated_at = ? WHERE order_id = ?
      `).run(
        targetStatus,
        amountFen,
        operator,
        nextReason,
        note,
        settledAt,
        now,
        request.params.id,
      );
      await insertEvent(
        tx,
        request.params.id,
        String(row.status),
        targetStatus === "settled" ? "结算已登记" : "结算状态已修正",
        targetStatus === "settled" ? `实际结算金额 ¥${(amountFen / 100).toFixed(2)}` : `结算状态已调整为 ${targetStatus}`,
        "operator",
        { status: targetStatus, amountFen, operator, reason: reason ?? null, note: note ?? null },
        now,
      );
      const updated = await tx.prepare<Row>("SELECT * FROM wash_order_settlements WHERE order_id = ?").get(request.params.id);
      if (!updated) throw problem(409, "WASH_SETTLEMENT_MISSING", "洗车订单缺少结算记录");
      await auditWashMutation(tx, request, "wash.settlement.update", {
        type: "wash_order_settlement",
        id: request.params.id,
      }, {
        before,
        after: settlementAuditSnapshot(updated),
        // A note/reason-only correction is still a real business mutation, but
        // its free text must never be copied into the append-only audit record.
        recordIfUnchanged: true,
      });
      return updated;
    });
    const row = await findOrder(database, request.params.id);
    if (!row) throw problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
    const result = { order: await orderFromRow(database, row), settlement: settlementFromRow(settlement) };
    return { data: result };
  });
}
