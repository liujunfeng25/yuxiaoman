import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import { auditBackofficeEvent } from "./backoffice.js";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;
type ProblemFactory = (statusCode: number, code: string, message: string, fields?: Record<string, string>) => Error;

type RentalAuditChange = {
  field?: string;
  label: string;
  before?: unknown;
  after?: unknown;
};

type RentalAuditSnapshot = Record<string, unknown>;

type RentalAuditPresentation = {
  actionLabel: string;
  summary: string;
  subjectName?: string;
  resourceLabel?: string;
  changes?: RentalAuditChange[];
  reason?: string;
};

export type CarRentalRouteOptions = {
  problem: ProblemFactory;
  uploadDir: string;
  now?: () => Date;
  validLocationProof?: (value: z.infer<typeof deliveryAddressSchema>) => boolean;
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

const idSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const phoneSchema = z.string().trim().regex(/^1[3-9]\d{9}$/u, "请输入有效的11位手机号");
const serviceModeSchema = z.enum(["store_pickup", "home_delivery"]);
const energyTypeSchema = z.enum(["gasoline", "diesel", "hybrid", "plug_in_hybrid", "pure_electric", "range_extended"]);
const bodyTypeSchema = z.enum(["sedan", "suv", "mpv", "hatchback", "coupe", "pickup"]);
const vehicleStatusSchema = z.enum(["draft", "active", "maintenance", "offline", "retired"]);
const orderStatusSchema = z.enum(["pending_payment", "confirmed", "ready_for_pickup", "in_use", "return_pending", "completed", "cancelled", "expired"]);
const isoInstantSchema = z.string().datetime({ offset: true });

export const deliveryAddressSchema = z.object({
  poiId: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(120),
  address: z.string().trim().min(2).max(240),
  district: z.string().trim().min(1).max(40),
  latitude: z.number().min(38.4).max(40.3),
  longitude: z.number().min(116.6).max(118.2),
  source: z.enum(["tencent", "wechat", "demo"]),
  locationProof: z.string().trim().max(2_000).optional(),
  detail: z.string().trim().max(120).optional(),
});

const searchSchema = z.object({
  serviceMode: serviceModeSchema,
  storeId: idSchema.optional(),
  pickupAt: isoInstantSchema,
  returnAt: isoInstantSchema,
  deliveryAddress: deliveryAddressSchema.optional(),
  brandId: idSchema.optional(),
  bodyType: bodyTypeSchema.optional(),
  energyType: energyTypeSchema.optional(),
  sort: z.enum(["recommended", "price_asc", "price_desc"]).default("recommended"),
}).superRefine((value, context) => {
  if (value.serviceMode === "store_pickup" && !value.storeId) {
    context.addIssue({ code: "custom", path: ["storeId"], message: "请选择取还门店" });
  }
  if (value.serviceMode === "home_delivery" && !value.deliveryAddress) {
    context.addIssue({ code: "custom", path: ["deliveryAddress"], message: "请选择同址送取地址" });
  }
});

const quoteSchema = searchSchema.and(z.object({
  modelId: idSchema,
  addOptionalProtection: z.boolean().default(false),
}));
const createOrderSchema = z.object({
  quoteId: idSchema,
  driverName: z.string().trim().min(2).max(30),
  driverPhone: phoneSchema,
  licenseConfirmed: z.literal(true, { error: "请确认驾驶员持有效驾驶证" }),
  idempotencyKey: z.string().trim().min(8).max(160),
});
const paymentSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(160) });
const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() }).default({});

const brandInputSchema = z.object({
  id: idSchema.optional(), name: z.string().trim().min(1).max(80), logoUrl: z.string().trim().min(1).max(500).nullable().optional(),
  initial: z.string().trim().toUpperCase().regex(/^[A-Z#]$/u), isHot: z.boolean().default(false),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0), isActive: z.boolean().default(true),
});
const modelInputSchema = z.object({
  id: idSchema.optional(), brandId: idSchema, name: z.string().trim().min(1).max(100),
  coverImageUrl: z.string().trim().max(500).nullable().optional(), bodyType: bodyTypeSchema,
  energyType: energyTypeSchema, transmission: z.enum(["automatic", "manual", "cvt", "dct", "single_speed", "e_cvt"]),
  seats: z.number().int().min(1).max(20), luggage: z.number().int().min(0).max(12).default(2),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0), isActive: z.boolean().default(true),
});
const storeInputSchema = z.object({
  id: idSchema.optional(), name: z.string().trim().min(2).max(100), district: z.string().trim().min(1).max(40),
  address: z.string().trim().min(2).max(240), latitude: z.number().min(38.4).max(40.3),
  longitude: z.number().min(116.6).max(118.2), openHours: z.string().trim().min(5).max(80),
  phone: z.string().trim().max(30).nullable().optional(), isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  deliveryBaseFeeFen: z.number().int().min(0).max(1_000_000).default(2900),
  deliveryIncludedKm: z.number().min(0).max(100).default(3),
  deliveryPerKmFen: z.number().int().min(0).max(100_000).default(600),
  deliveryMaxRadiusKm: z.number().positive().max(200).nullable().default(20),
});
const vehicleInputSchema = z.object({
  id: idSchema.optional(), stockNo: z.string().trim().min(2).max(80), modelId: idSchema, storeId: idSchema,
  plateNumber: z.string().trim().max(20).nullable().optional(), color: z.string().trim().min(1).max(40),
  modelYear: z.number().int().min(1990).max(2100), mileageKm: z.number().int().min(0).max(2_000_000),
  status: vehicleStatusSchema,
});
const ratePlanInputSchema = z.object({
  id: idSchema.optional(), modelId: idSchema, storeId: idSchema.nullable().optional(),
  weekdayRateFen: z.number().int().positive().max(10_000_000), weekendRateFen: z.number().int().positive().max(10_000_000),
  basicProtectionDailyFen: z.number().int().min(0).max(1_000_000).default(6000), prepFeeFen: z.number().int().min(0).max(1_000_000).default(3500),
  optionalProtectionDailyFen: z.number().int().min(0).max(1_000_000).default(6000), vehicleDepositFen: z.number().int().min(0).max(10_000_000),
  violationDepositFen: z.number().int().min(0).max(10_000_000).default(200000), includedMileageKmPerDay: z.number().int().positive().nullable().default(300),
  overagePerKmFen: z.number().int().min(0).max(100_000).default(100), fuelPolicy: z.string().trim().min(1).max(300).default("same_level_return"),
  cancellationPolicy: z.string().trim().min(1).max(500).default("取车前24小时可免费取消；24小时内取消以订单页规则为准"), isActive: z.boolean().default(true),
});
const rateOverrideInputSchema = z.object({
  id: idSchema.optional(), ratePlanId: idSchema, date: z.string().date(), dailyRateFen: z.number().int().positive().max(10_000_000).nullable().optional(),
  isAvailable: z.boolean().default(true), note: z.string().trim().max(300).nullable().optional(),
});

const rentalVehicleStatusLabels: Record<string, string> = {
  draft: "草稿",
  active: "可运营",
  maintenance: "维修中",
  offline: "已下线",
  retired: "已退役",
};
const rentalBodyTypeLabels: Record<string, string> = {
  sedan: "轿车",
  suv: "SUV",
  mpv: "MPV",
  hatchback: "两厢车",
  coupe: "跑车",
  pickup: "皮卡",
};
const rentalEnergyTypeLabels: Record<string, string> = {
  gasoline: "汽油",
  diesel: "柴油",
  hybrid: "油电混合",
  plug_in_hybrid: "插电混动",
  pure_electric: "纯电",
  range_extended: "增程",
};
const rentalTransmissionLabels: Record<string, string> = {
  automatic: "自动挡",
  manual: "手动挡",
  cvt: "CVT",
  dct: "双离合",
  single_speed: "电动车单速",
  e_cvt: "E-CVT",
};
const rentalFuelPolicyLabels: Record<string, string> = {
  same_level_return: "同油量或同电量归还",
};
const rentalOrderStatusLabels: Record<string, string> = {
  pending_payment: "待支付",
  confirmed: "已确认",
  ready_for_pickup: "待取车",
  in_use: "租用中",
  return_pending: "待还车",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已过期",
};
const rentalAdjustmentKindLabels: Record<string, string> = {
  overtime: "超时费用",
  fuel_or_charge: "油量或电量差额",
  cleaning: "清洁费用",
  other: "其他费用",
};

function rentalMoneyLabel(value: unknown): string {
  const fen = Number(value ?? 0);
  return `${fen < 0 ? "-" : ""}¥${(Math.abs(fen) / 100).toFixed(2)}`;
}

function rentalBooleanLabel(value: unknown, yes: string, no: string): string {
  return bool(value) ? yes : no;
}

function rentalAuditValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rentalAuditDiff(before?: RentalAuditSnapshot, after?: RentalAuditSnapshot): {
  before?: RentalAuditSnapshot;
  after?: RentalAuditSnapshot;
  changes: RentalAuditChange[];
} {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const beforeDiff: RentalAuditSnapshot = {};
  const afterDiff: RentalAuditSnapshot = {};
  const changes: RentalAuditChange[] = [];
  for (const key of keys) {
    const beforeValue = before?.[key];
    const afterValue = after?.[key];
    if (rentalAuditValueEqual(beforeValue, afterValue)) continue;
    if (before && Object.prototype.hasOwnProperty.call(before, key)) beforeDiff[key] = beforeValue;
    if (after && Object.prototype.hasOwnProperty.call(after, key)) afterDiff[key] = afterValue;
    changes.push({
      field: key,
      label: key,
      ...(before && Object.prototype.hasOwnProperty.call(before, key) ? { before: beforeValue } : {}),
      ...(after && Object.prototype.hasOwnProperty.call(after, key) ? { after: afterValue } : {}),
    });
  }
  return {
    ...(Object.keys(beforeDiff).length ? { before: beforeDiff } : {}),
    ...(Object.keys(afterDiff).length ? { after: afterDiff } : {}),
    changes,
  };
}

async function auditRentalMutation(
  database: AppDatabase,
  request: FastifyRequest,
  input: {
    action: string;
    resource: { type: string; id: string };
    before?: RentalAuditSnapshot;
    after?: RentalAuditSnapshot;
    presentation: RentalAuditPresentation;
  },
): Promise<boolean> {
  const diff = rentalAuditDiff(input.before, input.after);
  const changes = input.presentation.changes ?? diff.changes;
  if (!changes.length) return false;
  await auditBackofficeEvent(database, {
    request,
    action: input.action,
    outcome: "success",
    resource: input.resource,
    before: diff.before,
    after: diff.after,
    metadata: {
      presentation: {
        category: "car_rental",
        ...input.presentation,
        changes,
      },
    },
  });
  return true;
}

function brandAuditSnapshot(row: Row): RentalAuditSnapshot {
  return {
    品牌名称: String(row.name),
    首字母: String(row.initial),
    热门品牌: rentalBooleanLabel(row.is_hot, "是", "否"),
    排序: Number(row.sort_order),
    状态: rentalBooleanLabel(row.is_active, "已启用", "已停用"),
  };
}

function modelAuditSnapshot(row: Row): RentalAuditSnapshot {
  const bodyType = String(row.body_type);
  const energyType = String(row.energy_type);
  const transmission = String(row.transmission);
  return {
    所属品牌: String(row.brand_name ?? row.brand_id),
    车型名称: String(row.name),
    车身类型: rentalBodyTypeLabels[bodyType] ?? bodyType,
    能源类型: rentalEnergyTypeLabels[energyType] ?? energyType,
    变速箱: rentalTransmissionLabels[transmission] ?? transmission,
    座位数: Number(row.seats),
    行李数: Number(row.luggage),
    排序: Number(row.sort_order),
    状态: rentalBooleanLabel(row.is_active, "已启用", "已停用"),
  };
}

function storeAuditSnapshot(row: Row): RentalAuditSnapshot {
  return {
    门店名称: String(row.name),
    行政区: String(row.district),
    门店地址: String(row.address),
    门店定位: `${Number(row.latitude).toFixed(6)}, ${Number(row.longitude).toFixed(6)}`,
    营业时间: String(row.open_hours),
    联系电话: row.phone == null || String(row.phone) === "" ? "未设置" : "已设置",
    送取基础价: rentalMoneyLabel(row.delivery_base_fee_fen),
    基础包含公里: `${Number(row.delivery_included_km)} km`,
    超出每公里: rentalMoneyLabel(row.delivery_per_km_fen),
    最大服务半径: row.delivery_max_radius_km == null ? "不限制" : `${Number(row.delivery_max_radius_km)} km`,
    排序: Number(row.sort_order),
    状态: rentalBooleanLabel(row.is_active, "营业中", "已停用"),
  };
}

function vehicleAuditSnapshot(row: Row): RentalAuditSnapshot {
  return {
    库存编号: String(row.stock_no),
    车型: String(row.model_name ?? row.model_id),
    所属门店: String(row.store_name ?? row.store_id),
    车牌: maskedPlate(row.plate_number) ?? "未设置",
    颜色: String(row.color),
    年款: Number(row.model_year),
    当前里程: `${Number(row.mileage_km)} km`,
    状态: rentalVehicleStatusLabels[String(row.status)] ?? String(row.status),
  };
}

function ratePlanAuditSnapshot(row: Row): RentalAuditSnapshot {
  const fuelPolicy = String(row.fuel_policy);
  return {
    车型: String(row.model_name ?? row.model_id),
    适用门店: row.store_id == null ? "全部租赁门店" : String(row.store_name ?? row.store_id),
    工作日日租: rentalMoneyLabel(row.weekday_rate_fen),
    周末日租: rentalMoneyLabel(row.weekend_rate_fen),
    基础保障费: rentalMoneyLabel(row.basic_protection_daily_fen),
    整备费: rentalMoneyLabel(row.prep_fee_fen),
    安心保障费: rentalMoneyLabel(row.optional_protection_daily_fen),
    车辆押金: rentalMoneyLabel(row.vehicle_deposit_fen),
    违章押金: rentalMoneyLabel(row.violation_deposit_fen),
    每日包含里程: row.included_mileage_km_per_day == null ? "不限" : `${Number(row.included_mileage_km_per_day)} km`,
    超里程费: rentalMoneyLabel(row.overage_per_km_fen),
    油电归还政策: rentalFuelPolicyLabels[fuelPolicy] ?? fuelPolicy,
    取消政策: String(row.cancellation_policy),
    状态: rentalBooleanLabel(row.is_active, "生效", "停用"),
  };
}

function rateOverrideAuditSnapshot(row: Row): RentalAuditSnapshot {
  return {
    价格方案: `${String(row.model_name ?? row.model_id)} · ${row.store_id == null ? "全部租赁门店" : String(row.store_name ?? row.store_id)}`,
    日期: String(row.date),
    当日安排: bool(row.is_available) ? "可售" : "停售",
    覆盖日租价: row.daily_rate_fen == null ? "使用常规价" : rentalMoneyLabel(row.daily_rate_fen),
    备注: row.note == null || String(row.note) === "" ? "未填写" : "已填写",
  };
}

function rentalOrderResourceLabel(row: Row): string {
  return `租车订单「${String(row.order_number)}」`;
}

function rentalOrderSubjectName(row: Row): string {
  return String(jsonObject(row.store_snapshot_json)?.name ?? row.store_id ?? "汽车租赁");
}

function validationFields(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(error.issues.map((issue) => [issue.path.join(".") || "body", issue.message]));
}
function parseBody<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "提交的信息有误，请检查后重试", fields: validationFields(parsed.error) } });
  return undefined;
}
function bool(value: unknown): boolean { return value === true || Number(value) === 1; }
function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try { const parsed = JSON.parse(String(value ?? "null")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function maskedPhone(value: string): string { return value.replace(/^(\d{3})\d{4}(\d{4})$/u, "$1****$2"); }
function maskedPlate(value: unknown): string | null {
  const plate = String(value ?? "");
  if (!plate) return null;
  return plate.length <= 3 ? "***" : `${plate.slice(0, 2)}***${plate.slice(-1)}`;
}
function multipartField(part: any, name: string): string | undefined {
  const field = part?.fields?.[name];
  if (!field) return undefined;
  if (Array.isArray(field)) return field[0] && "value" in field[0] ? String(field[0].value) : undefined;
  return "value" in field ? String(field.value) : undefined;
}
async function receiveRentalImage(request: unknown, problem: ProblemFactory, maxEdge = 2048) {
  let part: any;
  try { part = await (request as { file: () => Promise<any> }).file(); } catch { throw problem(413, "RENTAL_IMAGE_TOO_LARGE", "单张图片不能超过10MB"); }
  if (!part) throw problem(400, "RENTAL_IMAGE_REQUIRED", "请选择要上传的图片");
  if (!/^image\/(jpeg|png|webp)$/iu.test(String(part.mimetype))) throw problem(415, "RENTAL_IMAGE_TYPE_INVALID", "仅支持 JPEG、PNG 或 WebP 图片");
  let source: Buffer;
  try { source = await part.toBuffer(); } catch { throw problem(413, "RENTAL_IMAGE_TOO_LARGE", "单张图片不能超过10MB"); }
  if (source.length > 10 * 1024 * 1024) throw problem(413, "RENTAL_IMAGE_TOO_LARGE", "单张图片不能超过10MB");
  try {
    const metadata = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) throw new Error("unsupported");
    const processed = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 }).rotate().resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true }).webp({ quality: 86 }).toBuffer({ resolveWithObject: true });
    return { part, data: processed.data, info: processed.info };
  } catch { throw problem(400, "RENTAL_IMAGE_INVALID", "图片损坏或无法识别，请重新选择"); }
}
function adminImageFromRow(row: Row) {
  return { id: String(row.id), url: String(row.image_url), imageUrl: String(row.image_url), mimeType: String(row.mime_type ?? "image/webp"), sizeBytes: Number(row.size_bytes ?? 0), width: Number(row.width ?? 1), height: Number(row.height ?? 1), sortOrder: Number(row.sort_order), isCover: bool(row.is_cover), isSynthetic: bool(row.is_synthetic) };
}

function brandFromRow(row: Row) {
  return { id: String(row.id), name: String(row.name), logoUrl: String(row.logo_url), initial: String(row.initial), isHot: bool(row.is_hot), sortOrder: Number(row.sort_order), isActive: bool(row.is_active) };
}
function modelFromRow(row: Row, availableCount = 0, images?: string[]) {
  return {
    id: String(row.id), brandId: String(row.brand_id), brandName: row.brand_name == null ? undefined : String(row.brand_name),
    name: String(row.name), coverImageUrl: row.cover_image_url == null ? null : String(row.cover_image_url),
    ...(images ? { images } : {}), bodyType: String(row.body_type), energyType: String(row.energy_type), transmission: String(row.transmission),
    seats: Number(row.seats), luggage: Number(row.luggage), sortOrder: Number(row.sort_order), isActive: bool(row.is_active), availableCount,
  };
}
function storeFromRow(row: Row) {
  return {
    id: String(row.id), name: String(row.name), district: String(row.district), address: String(row.address),
    latitude: Number(row.latitude), longitude: Number(row.longitude), openHours: String(row.open_hours), phone: row.phone == null ? null : String(row.phone),
    isActive: bool(row.is_active), isSynthetic: bool(row.is_synthetic), sortOrder: Number(row.sort_order),
    deliveryRule: { baseFeeFen: Number(row.delivery_base_fee_fen), includedKm: Number(row.delivery_included_km), perKmFen: Number(row.delivery_per_km_fen), maxRadiusKm: row.delivery_max_radius_km == null ? null : Number(row.delivery_max_radius_km) },
  };
}
function vehicleFromRow(row: Row, admin = false) {
  return { id: String(row.id), stockNo: String(row.stock_no), modelId: String(row.model_id), modelName: row.model_name == null ? undefined : String(row.model_name),
    storeId: String(row.store_id), storeName: row.store_name == null ? undefined : String(row.store_name), plateMasked: maskedPlate(row.plate_number),
    ...(admin ? { plateNumber: row.plate_number == null ? null : String(row.plate_number) } : {}), color: String(row.color), modelYear: Number(row.model_year), mileageKm: Number(row.mileage_km), status: String(row.status), isSynthetic: bool(row.is_synthetic) };
}

function assertRentalWindow(body: { pickupAt: string; returnAt: string }, now: Date, problem: ProblemFactory): number {
  const pickup = new Date(body.pickupAt);
  const returned = new Date(body.returnAt);
  if (returned <= pickup) throw problem(400, "RENTAL_TIME_INVALID", "还车时间必须晚于取车时间");
  if (pickup.getTime() < now.getTime() + 2 * 60 * 60_000) throw problem(409, "RENTAL_ADVANCE_TIME_REQUIRED", "请至少提前2小时预订");
  const days = Math.ceil((returned.getTime() - pickup.getTime()) / 86_400_000);
  if (days < 1 || days > 30) throw problem(409, "RENTAL_DURATION_INVALID", "租期须为1至30天");
  return days;
}

const shanghaiDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
function dateAtDay(pickupAt: string, day: number): string { return shanghaiDate.format(new Date(Date.parse(pickupAt) + day * 86_400_000)); }
function isWeekend(date: string): boolean { const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay(); return weekday === 0 || weekday === 6; }

async function expireOrders(database: AppDatabase, now: Date): Promise<void> {
  const expired = await database.prepare<Row>(`UPDATE car_rental_orders SET status='expired',updated_at=? WHERE status='pending_payment' AND hold_expires_at<=? RETURNING id`).all(now.toISOString(), now.toISOString());
  for (const row of expired) await database.prepare(`INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,note,created_at) VALUES (?,?,'pending_payment','expired','system','支付保留时间已结束',?)`).run(randomUUID(), String(row.id), now.toISOString());
}

async function activeCount(database: AppDatabase, storeId: string, modelId: string): Promise<number> {
  return Number((await database.prepare<Row>("SELECT COUNT(*) AS count FROM car_rental_vehicles WHERE store_id=? AND model_id=? AND status='active'").get(storeId, modelId))?.count ?? 0);
}
async function reservedCount(database: AppDatabase, storeId: string, modelId: string, pickupAt: string, returnAt: string, now: Date, excludeOrderId = ""): Promise<number> {
  return Number((await database.prepare<Row>(`
    SELECT COUNT(*) AS count FROM car_rental_orders WHERE store_id=? AND model_id=? AND id<>?
      AND pickup_at < ? AND return_at > ? AND (status IN ('confirmed','ready_for_pickup','in_use','return_pending') OR (status='pending_payment' AND hold_expires_at>?))
  `).get(storeId, modelId, excludeOrderId, returnAt, pickupAt, now.toISOString()))?.count ?? 0);
}
async function availableCount(database: AppDatabase, storeId: string, modelId: string, pickupAt: string, returnAt: string, now: Date): Promise<number> {
  return Math.max(0, await activeCount(database, storeId, modelId) - await reservedCount(database, storeId, modelId, pickupAt, returnAt, now));
}

async function ratePlan(database: AppDatabase, storeId: string, modelId: string): Promise<Row | undefined> {
  return database.prepare<Row>(`SELECT * FROM car_rental_rate_plans WHERE model_id=? AND is_active=1 AND (store_id=? OR store_id IS NULL) ORDER BY CASE WHEN store_id=? THEN 0 ELSE 1 END LIMIT 1`).get(modelId, storeId, storeId);
}
async function calculateRates(database: AppDatabase, plan: Row, pickupAt: string, billableDays: number) {
  const dailyRates: Array<{ date: string; rateFen: number }> = [];
  for (let day = 0; day < billableDays; day += 1) {
    const date = dateAtDay(pickupAt, day);
    const override = await database.prepare<Row>("SELECT * FROM car_rental_rate_overrides WHERE rate_plan_id=? AND date=?").get(String(plan.id), date);
    if (override && !bool(override.is_available)) return null;
    dailyRates.push({ date, rateFen: override?.daily_rate_fen == null ? Number(isWeekend(date) ? plan.weekend_rate_fen : plan.weekday_rate_fen) : Number(override.daily_rate_fen) });
  }
  return dailyRates;
}

type ResolvedStore = { row: Row; route: null | { oneWayDistanceKm: number; driveMinutes: number | null; distanceSource: "tencent_matrix"; distanceBasis: "driving_route" }; deliveryFeeFen: number };

async function resolveStore(
  database: AppDatabase, body: z.infer<typeof searchSchema>, options: CarRentalRouteOptions, problem: ProblemFactory, modelId?: string,
): Promise<ResolvedStore> {
  if (body.serviceMode === "store_pickup") {
    const row = await database.prepare<Row>("SELECT * FROM car_rental_stores WHERE id=? AND is_active=1").get(body.storeId!);
    if (!row) throw problem(404, "RENTAL_STORE_NOT_FOUND", "未找到可用租赁门店");
    return { row, route: null, deliveryFeeFen: 0 };
  }
  const address = body.deliveryAddress!;
  const production = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
  if ((production || address.locationProof) && !options.validLocationProof?.(address)) {
    throw problem(409, "RENTAL_DELIVERY_ADDRESS_PROOF_INVALID", "送取地址凭证无效或已过期，请重新选择");
  }
  if (production && address.source === "demo") throw problem(409, "RENTAL_DEMO_ADDRESS_NOT_ALLOWED", "生产环境不能使用演示地址");
  const stores = await database.prepare<Row>("SELECT * FROM car_rental_stores WHERE is_active=1 ORDER BY sort_order,id").all();
  const candidates: Array<ResolvedStore> = [];
  for (const row of stores) {
    const route = await options.calculateDrivingRoute({ latitude: address.latitude, longitude: address.longitude }, { latitude: Number(row.latitude), longitude: Number(row.longitude) });
    if (route.distanceSource !== "tencent_matrix" || route.distanceBasis !== "driving_route" || route.distanceKm == null) continue;
    if (row.delivery_max_radius_km != null && route.distanceKm > Number(row.delivery_max_radius_km)) continue;
    const extraKm = Math.max(0, Math.ceil(route.distanceKm - Number(row.delivery_included_km)));
    candidates.push({ row, route: { oneWayDistanceKm: route.distanceKm, driveMinutes: route.driveMinutes, distanceSource: "tencent_matrix", distanceBasis: "driving_route" }, deliveryFeeFen: Number(row.delivery_base_fee_fen) + extraKm * Number(row.delivery_per_km_fen) });
  }
  candidates.sort((a, b) => a.route!.oneWayDistanceKm - b.route!.oneWayDistanceKm);
  if (modelId) {
    const matching = [] as ResolvedStore[];
    for (const candidate of candidates) {
      if (await availableCount(database, String(candidate.row.id), modelId, body.pickupAt, body.returnAt, (options.now ?? (() => new Date()))()) > 0) matching.push(candidate);
    }
    if (matching.length > 0) return matching[0];
  } else if (candidates.length > 0) return candidates[0];
  throw problem(503, "RENTAL_REAL_ROUTE_REQUIRED", "送车上门必须使用真实驾车路线，当前暂不能报价");
}

async function modelRow(database: AppDatabase, modelId: string): Promise<Row | undefined> {
  return database.prepare<Row>(`SELECT m.*,b.name AS brand_name FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE m.id=?`).get(modelId);
}
async function modelImages(database: AppDatabase, modelId: string): Promise<string[]> {
  return (await database.prepare<Row>("SELECT image_url FROM car_rental_model_images WHERE model_id=? ORDER BY sort_order,id").all(modelId)).map((row) => String(row.image_url));
}
function policiesFromPlan(plan: Row) {
  return { exactModel: "保证所选车型，车辆颜色以实际交付为准", includedMileageKmPerDay: plan.included_mileage_km_per_day == null ? null : Number(plan.included_mileage_km_per_day), overagePerKmFen: Number(plan.overage_per_km_fen), fuelPolicy: String(plan.fuel_policy), cancellationPolicy: String(plan.cancellation_policy), graceMinutes: 30 };
}

async function priceOffer(database: AppDatabase, store: ResolvedStore, model: Row, pickupAt: string, billableDays: number, optional: boolean) {
  const plan = await ratePlan(database, String(store.row.id), String(model.id));
  if (!plan) return null;
  const dailyRates = await calculateRates(database, plan, pickupAt, billableDays);
  if (!dailyRates) return null;
  const rentalFeeFen = dailyRates.reduce((sum, item) => sum + item.rateFen, 0);
  const basicProtectionFeeFen = Number(plan.basic_protection_daily_fen) * billableDays;
  const prepFeeFen = Number(plan.prep_fee_fen);
  const optionalProtectionFeeFen = optional ? Number(plan.optional_protection_daily_fen) * billableDays : 0;
  const deliveryFeeFen = store.deliveryFeeFen;
  const totalFeeFen = rentalFeeFen + basicProtectionFeeFen + prepFeeFen + optionalProtectionFeeFen + deliveryFeeFen;
  return { plan, dailyRates, dailyRateFen: dailyRates[0].rateFen, averageDailyRateFen: Math.round(rentalFeeFen / billableDays), rentalFeeFen, basicProtectionFeeFen, prepFeeFen, optionalProtectionFeeFen, deliveryFeeFen, totalFeeFen, mandatoryFeeFen: basicProtectionFeeFen + prepFeeFen + deliveryFeeFen,
    deposits: { vehicleDepositFen: Number(plan.vehicle_deposit_fen), violationDepositFen: Number(plan.violation_deposit_fen), totalDepositFen: Number(plan.vehicle_deposit_fen) + Number(plan.violation_deposit_fen), includedInPayable: false }, policies: policiesFromPlan(plan) };
}

function feeBreakdownFromQuote(row: Row) {
  return { rentalFeeFen: Number(row.rental_fee_fen), basicProtectionFeeFen: Number(row.basic_protection_fee_fen), prepFeeFen: Number(row.prep_fee_fen), optionalProtectionFeeFen: Number(row.optional_protection_fee_fen), deliveryFeeFen: Number(row.delivery_fee_fen), totalFeeFen: Number(row.total_fee_fen) };
}
function depositsFromQuote(row: Row) {
  const vehicleDepositFen = Number(row.vehicle_deposit_fen);
  const violationDepositFen = Number(row.violation_deposit_fen);
  return { vehicleDepositFen, violationDepositFen, totalDepositFen: vehicleDepositFen + violationDepositFen, includedInPayable: false };
}
function orderFromRow(row: Row, events?: unknown[], adjustments?: unknown[]) {
  const feeBreakdown = jsonObject(row.fee_breakdown_json) ?? {};
  const deposits = jsonObject(row.deposits_json) ?? {};
  return {
    id: String(row.id), orderNumber: String(row.order_number), status: String(row.status), serviceMode: String(row.service_mode), modelId: String(row.model_id), storeId: String(row.store_id),
    store: jsonObject(row.store_snapshot_json), model: jsonObject(row.model_snapshot_json), pickupAt: String(row.pickup_at), returnAt: String(row.return_at),
    billableDays: Number(row.billable_days), driverName: String(row.driver_name), driverPhoneMasked: maskedPhone(String(row.driver_phone)),
    feeBreakdown, deposits, route: jsonObject(row.route_json), deliveryAddress: jsonObject(row.delivery_address_json),
    assignedVehicle: row.assigned_vehicle_id == null ? null : { id: String(row.assigned_vehicle_id), stockNo: row.assigned_stock_no == null ? null : String(row.assigned_stock_no), color: row.assigned_color == null ? null : String(row.assigned_color), plateMasked: maskedPlate(row.assigned_plate_number) },
    holdExpiresAt: row.hold_expires_at == null ? null : String(row.hold_expires_at), paidAt: row.paid_at == null ? null : String(row.paid_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at), completedAt: row.completed_at == null ? null : String(row.completed_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), internalNote: row.internal_note == null ? null : String(row.internal_note),
    isSynthetic: true, ...(events ? { events } : {}), ...(adjustments ? { adjustments } : {}),
  };
}

const orderSelect = `
  SELECT o.*,v.stock_no AS assigned_stock_no,v.color AS assigned_color,v.plate_number AS assigned_plate_number
  FROM car_rental_orders o LEFT JOIN car_rental_vehicles v ON v.id=o.assigned_vehicle_id
`;

export async function registerCarRentalRoutes(app: FastifyInstance, database: AppDatabase, options: CarRentalRouteOptions): Promise<void> {
  const { problem } = options;
  const now = options.now ?? (() => new Date());
  const imageUploadDir = join(options.uploadDir, "car-rental", "models");
  const brandLogoDir = join(options.uploadDir, "car-rental", "logos");
  await mkdir(imageUploadDir, { recursive: true });
  await mkdir(brandLogoDir, { recursive: true });

  const sendModelImage = async (id: string, reply: FastifyReply) => {
    const row = await database.prepare<Row>("SELECT i.*,m.is_active AS model_is_active FROM car_rental_model_images i JOIN car_rental_models m ON m.id=i.model_id WHERE i.id=?").get(id);
    if (!row || !bool(row.model_is_active)) throw problem(404, "RENTAL_IMAGE_NOT_AVAILABLE", "车型图片不存在或已停用");
    if (bool(row.is_synthetic) || row.storage_key == null) return reply.redirect(String(row.image_url));
    reply.type(String(row.mime_type)).header("Cache-Control", "public, max-age=86400");
    return reply.send(createReadStream(join(imageUploadDir, String(row.storage_key))));
  };
  app.get<{ Params: { id: string } }>("/api/car-rental/images/:id", async (request, reply) => sendModelImage(request.params.id, reply));
  app.get<{ Params: { id: string } }>("/api/admin/car-rental/images/:id", async (request, reply) => sendModelImage(request.params.id, reply));
  const sendBrandLogo = async (id: string, reply: FastifyReply) => {
    const row = await database.prepare<Row>("SELECT * FROM car_rental_brands WHERE id=?").get(id);
    if (!row || !bool(row.is_active)) throw problem(404, "RENTAL_BRAND_LOGO_NOT_AVAILABLE", "品牌车标不存在或已停用");
    if (String(row.logo_url) !== `/api/car-rental/brands/${id}/logo`) return reply.redirect(String(row.logo_url));
    reply.type("image/webp").header("Cache-Control", "public, max-age=86400");
    return reply.send(createReadStream(join(brandLogoDir, `${id}.webp`)));
  };
  app.get<{ Params: { id: string } }>("/api/car-rental/brands/:id/logo", async (request, reply) => sendBrandLogo(request.params.id, reply));

  app.get("/api/car-rental/catalog", async (request) => {
    await requireCurrentUser(request, database);
    const brands = await database.prepare<Row>("SELECT * FROM car_rental_brands WHERE is_active=1 ORDER BY initial,sort_order,id").all();
    const models = await database.prepare<Row>(`SELECT m.*,b.name AS brand_name FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE m.is_active=1 AND b.is_active=1 ORDER BY m.brand_id,m.sort_order,m.id`).all();
    const counts = await database.prepare<Row>("SELECT model_id,COUNT(*) AS count FROM car_rental_vehicles WHERE status='active' GROUP BY model_id").all();
    const countMap = new Map(counts.map((row) => [String(row.model_id), Number(row.count)]));
    const dto = brands.map((brand) => {
      const brandModels = models.filter((model) => model.brand_id === brand.id).map((model) => modelFromRow(model, countMap.get(String(model.id)) ?? 0));
      return { ...brandFromRow(brand), availableCount: brandModels.reduce((sum, model) => sum + model.availableCount, 0), models: brandModels };
    });
    const groupMap = new Map<string, typeof dto>();
    for (const brand of dto) groupMap.set(brand.initial, [...(groupMap.get(brand.initial) ?? []), brand]);
    const groups = [...groupMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([initial, grouped]) => ({ initial, brands: grouped }));
    return { data: { groups, hotBrands: dto.filter((brand) => brand.isHot).sort((a, b) => b.availableCount - a.availableCount || a.sortOrder - b.sortOrder), dataKind: "synthetic_demo" } };
  });

  app.get("/api/car-rental/stores", async (request) => {
    await requireCurrentUser(request, database);
    return { data: (await database.prepare<Row>("SELECT * FROM car_rental_stores WHERE is_active=1 ORDER BY sort_order,id").all()).map(storeFromRow) };
  });

  app.post("/api/car-rental/offers/search", async (request, reply) => {
    await requireCurrentUser(request, database);
    const body = parseBody(searchSchema, request.body, reply);
    if (!body) return;
    const current = now();
    await expireOrders(database, current);
    const billableDays = assertRentalWindow(body, current, problem);
    const store = await resolveStore(database, body, options, problem);
    const clauses = ["m.is_active=1", "b.is_active=1"];
    const values: string[] = [];
    if (body.brandId) { clauses.push("m.brand_id=?"); values.push(body.brandId); }
    if (body.bodyType) { clauses.push("m.body_type=?"); values.push(body.bodyType); }
    if (body.energyType) { clauses.push("m.energy_type=?"); values.push(body.energyType); }
    const models = await database.prepare<Row>(`SELECT m.*,b.name AS brand_name FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE ${clauses.join(" AND ")} ORDER BY m.sort_order,m.id`).all(...values);
    const items = [] as Array<Record<string, unknown>>;
    for (const model of models) {
      const availability = await availableCount(database, String(store.row.id), String(model.id), body.pickupAt, body.returnAt, current);
      if (availability <= 0) continue;
      const pricing = await priceOffer(database, store, model, body.pickupAt, billableDays, false);
      if (!pricing) continue;
      items.push({ model: modelFromRow(model, availability), availability, dailyRateFen: pricing.dailyRateFen, averageDailyRateFen: pricing.averageDailyRateFen,
        rentalFeeFen: pricing.rentalFeeFen, mandatoryFeeFen: pricing.mandatoryFeeFen, totalFeeFen: pricing.totalFeeFen, depositFen: pricing.deposits.totalDepositFen,
        coverImageUrl: model.cover_image_url == null ? null : String(model.cover_image_url), isExactModel: true });
    }
    if (body.sort === "price_asc") items.sort((a, b) => Number(a.totalFeeFen) - Number(b.totalFeeFen));
    else if (body.sort === "price_desc") items.sort((a, b) => Number(b.totalFeeFen) - Number(a.totalFeeFen));
    else items.sort((a, b) => Number(b.availability) - Number(a.availability) || Number(a.totalFeeFen) - Number(b.totalFeeFen));
    return { data: { search: { serviceMode: body.serviceMode, pickupAt: body.pickupAt, returnAt: body.returnAt }, store: storeFromRow(store.row), route: store.route,
      billableDays, items, notice: "合成演示车型与价格；指定车型保障，颜色以实际交付为准" } };
  });

  app.get<{ Params: { id: string }; Querystring: { storeId?: string; pickupAt?: string; returnAt?: string } }>("/api/car-rental/models/:id", async (request) => {
    await requireCurrentUser(request, database);
    const model = await modelRow(database, request.params.id);
    if (!model || !bool(model.is_active)) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到可租车型");
    const images = await modelImages(database, request.params.id);
    const storeId = request.query.storeId ?? String((await database.prepare<Row>("SELECT id FROM car_rental_stores WHERE is_active=1 ORDER BY sort_order,id LIMIT 1").get())?.id ?? "");
    const plan = storeId ? await ratePlan(database, storeId, request.params.id) : undefined;
    return { data: { ...modelFromRow(model, 0, images), policies: plan ? policiesFromPlan(plan) : null, notice: "车型参考图，交付车型保证一致，颜色以门店实际为准" } };
  });

  app.post("/api/car-rental/quotes", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(quoteSchema, request.body, reply);
    if (!body) return;
    const current = now();
    await expireOrders(database, current);
    const billableDays = assertRentalWindow(body, current, problem);
    const model = await modelRow(database, body.modelId);
    if (!model || !bool(model.is_active)) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到可租车型");
    const store = await resolveStore(database, body, options, problem, body.modelId);
    if (await availableCount(database, String(store.row.id), body.modelId, body.pickupAt, body.returnAt, current) <= 0) throw problem(409, "RENTAL_MODEL_UNAVAILABLE", "该车型在所选时间刚刚租完，请选择其他车型或时间");
    const pricing = await priceOffer(database, store, model, body.pickupAt, billableDays, body.addOptionalProtection);
    if (!pricing) throw problem(409, "RENTAL_RATE_UNAVAILABLE", "该车型所选日期暂不可租");
    const id = randomUUID();
    const createdAt = current.toISOString();
    const expiresAt = new Date(current.getTime() + 15 * 60_000).toISOString();
    const images = await modelImages(database, body.modelId);
    const modelDto = modelFromRow(model, 0, images);
    const storeDto = storeFromRow(store.row);
    const feeBreakdown = { rentalFeeFen: pricing.rentalFeeFen, basicProtectionFeeFen: pricing.basicProtectionFeeFen, prepFeeFen: pricing.prepFeeFen,
      optionalProtectionFeeFen: pricing.optionalProtectionFeeFen, deliveryFeeFen: pricing.deliveryFeeFen, totalFeeFen: pricing.totalFeeFen };
    await database.prepare(`
      INSERT INTO car_rental_quote_snapshots (id,user_id,model_id,store_id,rate_plan_id,service_mode,pickup_at,return_at,billable_days,
        delivery_address_json,route_json,model_snapshot_json,store_snapshot_json,rates_json,policies_json,rental_fee_fen,basic_protection_fee_fen,
        prep_fee_fen,optional_protection_fee_fen,delivery_fee_fen,total_fee_fen,vehicle_deposit_fen,violation_deposit_fen,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, userId, body.modelId, String(store.row.id), String(pricing.plan.id), body.serviceMode, body.pickupAt, body.returnAt, billableDays,
      body.deliveryAddress ? JSON.stringify(body.deliveryAddress) : null, store.route ? JSON.stringify(store.route) : null, JSON.stringify(modelDto), JSON.stringify(storeDto),
      JSON.stringify(pricing.dailyRates), JSON.stringify(pricing.policies), pricing.rentalFeeFen, pricing.basicProtectionFeeFen, pricing.prepFeeFen,
      pricing.optionalProtectionFeeFen, pricing.deliveryFeeFen, pricing.totalFeeFen, pricing.deposits.vehicleDepositFen, pricing.deposits.violationDepositFen, createdAt, expiresAt);
    return { data: { id, expiresAt, serviceMode: body.serviceMode, store: storeDto, model: modelDto, pickupAt: body.pickupAt, returnAt: body.returnAt, billableDays,
      feeBreakdown, deposits: pricing.deposits, route: store.route, policies: pricing.policies, dataKind: "synthetic_demo" } };
  });

  app.post("/api/car-rental/orders", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(createOrderSchema, request.body, reply);
    if (!body) return;
    const result = await database.transaction(async (transaction) => {
      const current = now();
      await expireOrders(transaction, current);
      const existing = await transaction.prepare<Row>(`${orderSelect} WHERE o.user_id=? AND o.idempotency_key=?`).get(userId, body.idempotencyKey);
      if (existing) return { order: existing, created: false };
      const quote = await transaction.prepare<Row>("SELECT * FROM car_rental_quote_snapshots WHERE id=? AND user_id=? FOR UPDATE").get(body.quoteId, userId);
      if (!quote) throw problem(404, "RENTAL_QUOTE_NOT_FOUND", "未找到该租车报价");
      if (String(quote.expires_at) <= current.toISOString()) throw problem(409, "RENTAL_QUOTE_EXPIRED", "报价已过期，请重新查询");
      const used = await transaction.prepare<Row>("SELECT id FROM car_rental_orders WHERE quote_id=? LIMIT 1").get(body.quoteId);
      if (used) throw problem(409, "RENTAL_QUOTE_ALREADY_USED", "该报价已创建订单");
      const vehicles = await transaction.prepare<Row>("SELECT id FROM car_rental_vehicles WHERE store_id=? AND model_id=? AND status='active' ORDER BY id FOR UPDATE").all(String(quote.store_id), String(quote.model_id));
      const reserved = await reservedCount(transaction, String(quote.store_id), String(quote.model_id), String(quote.pickup_at), String(quote.return_at), current);
      if (reserved >= vehicles.length) throw problem(409, "RENTAL_MODEL_UNAVAILABLE", "该车型在所选时间刚刚租完，请重新选择");
      const id = randomUUID();
      const createdAt = current.toISOString();
      const holdExpiresAt = new Date(current.getTime() + 15 * 60_000).toISOString();
      const orderNumber = `ZR${createdAt.slice(0, 10).replaceAll("-", "")}${Math.floor(100000 + Math.random() * 900000)}`;
      const feeBreakdown = feeBreakdownFromQuote(quote);
      const deposits = depositsFromQuote(quote);
      await transaction.prepare(`
        INSERT INTO car_rental_orders (id,order_number,user_id,quote_id,model_id,store_id,service_mode,pickup_at,return_at,billable_days,
          driver_name,driver_phone,license_confirmed,delivery_address_json,route_json,model_snapshot_json,store_snapshot_json,fee_breakdown_json,
          deposits_json,policies_json,status,idempotency_key,hold_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, orderNumber, userId, body.quoteId, quote.model_id as string, quote.store_id as string, quote.service_mode as string, quote.pickup_at as string,
        quote.return_at as string, Number(quote.billable_days), body.driverName, body.driverPhone, 1, quote.delivery_address_json as string | null, quote.route_json as string | null,
        quote.model_snapshot_json as string, quote.store_snapshot_json as string, JSON.stringify(feeBreakdown), JSON.stringify(deposits), quote.policies_json as string,
        "pending_payment", body.idempotencyKey, holdExpiresAt, createdAt, createdAt);
      await transaction.prepare("INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,note,created_at) VALUES (?,?,NULL,'pending_payment','owner','已提交租车订单，等待模拟支付',?)").run(randomUUID(), id, createdAt);
      return { order: await transaction.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(id) as Row, created: true };
    }, { isolationLevel: "serializable" });
    if (result.created) reply.status(201);
    return { data: orderFromRow(result.order) };
  });

  app.get("/api/car-rental/orders", async (request) => {
    const userId = await requireCurrentUser(request, database);
    await expireOrders(database, now());
    return { data: (await database.prepare<Row>(`${orderSelect} WHERE o.user_id=? ORDER BY o.created_at DESC`).all(userId)).map((row) => orderFromRow(row)) };
  });

  app.get<{ Params: { id: string } }>("/api/car-rental/orders/:id", async (request) => {
    const userId = await requireCurrentUser(request, database);
    await expireOrders(database, now());
    const row = await database.prepare<Row>(`${orderSelect} WHERE o.id=? AND o.user_id=?`).get(request.params.id, userId);
    if (!row) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
    const events = (await database.prepare<Row>("SELECT * FROM car_rental_order_events WHERE order_id=? ORDER BY created_at,id").all(request.params.id)).map((event) => ({ id: String(event.id), fromStatus: event.from_status == null ? null : String(event.from_status), toStatus: String(event.to_status), actorType: String(event.actor_type), actorName: event.actor_name == null ? null : String(event.actor_name), note: event.note == null ? null : String(event.note), createdAt: String(event.created_at) }));
    return { data: orderFromRow(row, events) };
  });

  app.post<{ Params: { id: string } }>("/api/car-rental/orders/:id/mock-pay", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(paymentSchema, request.body, reply);
    if (!body) return;
    const row = await database.transaction(async (transaction) => {
      const current = now();
      const order = await transaction.prepare<Row>(`${orderSelect} WHERE o.id=? AND o.user_id=? FOR UPDATE OF o`).get(request.params.id, userId);
      if (!order) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
      const existing = await transaction.prepare<Row>("SELECT * FROM car_rental_mock_payments WHERE order_id=? AND idempotency_key=?").get(request.params.id, body.idempotencyKey);
      if (existing) return order;
      if (String(order.status) === "confirmed") return order;
      if (String(order.status) !== "pending_payment") throw problem(409, "RENTAL_ORDER_NOT_PAYABLE", "当前订单状态不能支付");
      if (String(order.hold_expires_at) <= current.toISOString()) {
        await transaction.prepare("UPDATE car_rental_orders SET status='expired',updated_at=? WHERE id=?").run(current.toISOString(), request.params.id);
        throw problem(409, "RENTAL_ORDER_HOLD_EXPIRED", "订单支付保留时间已结束，请重新下单");
      }
      const totalFeeFen = Number((jsonObject(order.fee_breakdown_json) ?? {}).totalFeeFen ?? 0);
      await transaction.prepare("INSERT INTO car_rental_mock_payments (id,order_id,idempotency_key,amount_fen,status,created_at,confirmed_at) VALUES (?,?,?,?, 'confirmed',?,?)").run(randomUUID(), request.params.id, body.idempotencyKey, totalFeeFen, current.toISOString(), current.toISOString());
      await transaction.prepare("UPDATE car_rental_orders SET status='confirmed',hold_expires_at=NULL,paid_at=?,updated_at=? WHERE id=?").run(current.toISOString(), current.toISOString(), request.params.id);
      await transaction.prepare("INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,note,metadata_json,created_at) VALUES (?,?,'pending_payment','confirmed','owner','模拟支付已确认',?,?)").run(randomUUID(), request.params.id, JSON.stringify({ provider: "mock", amountFen: totalFeeFen, realMoneyMovement: false }), current.toISOString());
      return await transaction.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(request.params.id) as Row;
    });
    return { data: orderFromRow(row) };
  });

  app.post<{ Params: { id: string } }>("/api/car-rental/orders/:id/cancel", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(cancelSchema, request.body ?? {}, reply);
    if (!body) return;
    const row = await database.transaction(async (transaction) => {
      const current = now();
      const order = await transaction.prepare<Row>(`${orderSelect} WHERE o.id=? AND o.user_id=? FOR UPDATE OF o`).get(request.params.id, userId);
      if (!order) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
      if (String(order.status) === "cancelled") return order;
      if (!["pending_payment", "confirmed", "ready_for_pickup"].includes(String(order.status))) throw problem(409, "RENTAL_ORDER_NOT_CANCELLABLE", "当前履约状态不能取消");
      const previous = String(order.status);
      await transaction.prepare("UPDATE car_rental_orders SET status='cancelled',hold_expires_at=NULL,cancelled_at=?,updated_at=? WHERE id=?").run(current.toISOString(), current.toISOString(), request.params.id);
      await transaction.prepare("UPDATE car_rental_mock_payments SET status='void' WHERE order_id=? AND status='confirmed'").run(request.params.id);
      await transaction.prepare("INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,note,created_at) VALUES (?,?,?,'cancelled','owner',?,?)").run(randomUUID(), request.params.id, previous, body.reason || "用户取消", current.toISOString());
      return await transaction.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(request.params.id) as Row;
    });
    return { data: orderFromRow(row) };
  });

  registerCarRentalAdminRoutes(app, database, options);
}

function ratePlanFromRow(row: Row) {
  return { id: String(row.id), modelId: String(row.model_id), modelName: row.model_name == null ? undefined : String(row.model_name), storeId: row.store_id == null ? null : String(row.store_id), storeName: row.store_name == null ? null : String(row.store_name),
    weekdayRateFen: Number(row.weekday_rate_fen), weekendRateFen: Number(row.weekend_rate_fen), basicProtectionDailyFen: Number(row.basic_protection_daily_fen), prepFeeFen: Number(row.prep_fee_fen),
    optionalProtectionDailyFen: Number(row.optional_protection_daily_fen), vehicleDepositFen: Number(row.vehicle_deposit_fen), violationDepositFen: Number(row.violation_deposit_fen),
    includedMileageKmPerDay: row.included_mileage_km_per_day == null ? null : Number(row.included_mileage_km_per_day), overagePerKmFen: Number(row.overage_per_km_fen),
    fuelPolicy: String(row.fuel_policy), cancellationPolicy: String(row.cancellation_policy), isActive: bool(row.is_active), updatedAt: String(row.updated_at) };
}
function rateOverrideFromRow(row: Row) {
  return { id: String(row.id), ratePlanId: String(row.rate_plan_id), date: String(row.date), dailyRateFen: row.daily_rate_fen == null ? null : Number(row.daily_rate_fen), isAvailable: bool(row.is_available), note: row.note == null ? null : String(row.note) };
}

function registerCarRentalAdminRoutes(app: FastifyInstance, database: AppDatabase, options: CarRentalRouteOptions): void {
  const { problem } = options;
  const now = options.now ?? (() => new Date());
  const imageUploadDir = join(options.uploadDir, "car-rental", "models");
  const brandLogoDir = join(options.uploadDir, "car-rental", "logos");

  app.get("/api/admin/car-rental/brands", async () => ({ data: (await database.prepare<Row>(`SELECT b.*,(SELECT COUNT(*) FROM car_rental_models m WHERE m.brand_id=b.id) AS model_count FROM car_rental_brands b ORDER BY b.initial,b.sort_order,b.id`).all()).map((row) => ({ ...brandFromRow(row), modelCount: Number(row.model_count) })) }));
  app.get<{ Params: { id: string } }>("/api/admin/car-rental/brands/:id", async (request) => {
    const row = await database.prepare<Row>("SELECT * FROM car_rental_brands WHERE id=?").get(request.params.id);
    if (!row) throw problem(404, "RENTAL_BRAND_NOT_FOUND", "未找到该品牌");
    return { data: brandFromRow(row) };
  });
  app.post("/api/admin/car-rental/brands", async (request, reply) => {
    const body = parseBody(brandInputSchema, request.body, reply); if (!body) return;
    const id = body.id ?? `rental-brand-${randomUUID()}`; const timestamp = now().toISOString();
    const logoUrl = body.logoUrl ?? `/assets/used-cars/logos/${id}.webp`;
    const created = await database.transaction(async (tx) => {
      await tx.prepare("INSERT INTO car_rental_brands (id,name,logo_url,initial,is_hot,sort_order,is_active,is_synthetic,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)").run(id, body.name, logoUrl, body.initial, body.isHot ? 1 : 0, body.sortOrder, body.isActive ? 1 : 0, timestamp, timestamp);
      const row = (await tx.prepare<Row>("SELECT * FROM car_rental_brands WHERE id=?").get(id))!;
      await auditRentalMutation(tx, request, {
        action: "car_rental.brand.created",
        resource: { type: "car_rental_brand", id },
        after: brandAuditSnapshot(row),
        presentation: {
          actionLabel: "新增租赁品牌",
          summary: `新增了租赁品牌「${String(row.name)}」`,
          subjectName: "汽车租赁",
          resourceLabel: `品牌「${String(row.name)}」`,
        },
      });
      return row;
    });
    reply.status(201); return { data: brandFromRow(created) };
  });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/brands/:id", async (request, reply) => {
    const body = parseBody(brandInputSchema.omit({ id: true }), request.body, reply); if (!body) return;
    const updated = await database.transaction(async (tx) => {
      const current = await tx.prepare<Row>("SELECT * FROM car_rental_brands WHERE id=? FOR UPDATE").get(request.params.id);
      if (!current) throw problem(404, "RENTAL_BRAND_NOT_FOUND", "未找到该品牌");
      const result = await tx.prepare("UPDATE car_rental_brands SET name=?,logo_url=?,initial=?,is_hot=?,sort_order=?,is_active=?,updated_at=? WHERE id=?").run(body.name, body.logoUrl ?? current.logo_url as string, body.initial, body.isHot ? 1 : 0, body.sortOrder, body.isActive ? 1 : 0, now().toISOString(), request.params.id);
      if (!result.changes) throw problem(404, "RENTAL_BRAND_NOT_FOUND", "未找到该品牌");
      const row = (await tx.prepare<Row>("SELECT * FROM car_rental_brands WHERE id=?").get(request.params.id))!;
      const before = brandAuditSnapshot(current);
      const after = brandAuditSnapshot(row);
      if (String(current.logo_url) !== String(row.logo_url)) {
        before.品牌车标 = "更新前";
        after.品牌车标 = "已更新";
      }
      const changes = rentalAuditDiff(before, after).changes;
      const onlyStatus = changes.length === 1 && changes[0]?.field === "状态";
      const enabled = bool(row.is_active);
      await auditRentalMutation(tx, request, {
        action: onlyStatus ? `car_rental.brand.${enabled ? "enabled" : "disabled"}` : "car_rental.brand.updated",
        resource: { type: "car_rental_brand", id: request.params.id },
        before,
        after,
        presentation: {
          actionLabel: onlyStatus ? `${enabled ? "启用" : "停用"}租赁品牌` : "修改租赁品牌",
          summary: `${onlyStatus ? enabled ? "启用" : "停用" : "修改"}了租赁品牌「${String(row.name)}」`,
          subjectName: "汽车租赁",
          resourceLabel: `品牌「${String(row.name)}」`,
        },
      });
      return row;
    });
    return { data: brandFromRow(updated) };
  });
  app.post<{ Params: { id: string } }>("/api/admin/car-rental/brands/:id/logo", async (request, reply) => {
    if (!await database.prepare<Row>("SELECT id FROM car_rental_brands WHERE id=?").get(request.params.id)) throw problem(404, "RENTAL_BRAND_NOT_FOUND", "未找到该品牌");
    const processed = await receiveRentalImage(request, problem, 512);
    const logoPath = join(brandLogoDir, `${request.params.id}.webp`);
    const previousLogo = await readFile(logoPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    await writeFile(logoPath, processed.data);
    try {
      const updated = await database.transaction(async (tx) => {
        const current = await tx.prepare<Row>("SELECT * FROM car_rental_brands WHERE id=? FOR UPDATE").get(request.params.id);
        if (!current) throw problem(404, "RENTAL_BRAND_NOT_FOUND", "未找到该品牌");
        await tx.prepare("UPDATE car_rental_brands SET logo_url=?,updated_at=? WHERE id=?").run(`/api/car-rental/brands/${request.params.id}/logo`, now().toISOString(), request.params.id);
        const row = (await tx.prepare<Row>("SELECT * FROM car_rental_brands WHERE id=?").get(request.params.id))!;
        await auditRentalMutation(tx, request, {
          action: "car_rental.brand.logo_updated",
          resource: { type: "car_rental_brand", id: request.params.id },
          before: { 品牌车标: "更新前" },
          after: { 品牌车标: "已更新" },
          presentation: {
            actionLabel: "更换品牌车标",
            summary: `更换了租赁品牌「${String(row.name)}」的车标`,
            subjectName: "汽车租赁",
            resourceLabel: `品牌「${String(row.name)}」`,
          },
        });
        return row;
      });
      return reply.status(201).send({ data: brandFromRow(updated) });
    } catch (error) {
      if (previousLogo) await writeFile(logoPath, previousLogo);
      else await unlink(logoPath).catch((cleanupError) => {
        app.log.error({ cleanupError, brandId: request.params.id }, "failed to clean up rental brand logo after rollback");
      });
      throw error;
    }
  });

  app.get<{ Querystring: { brandId?: string; includeInactive?: string } }>("/api/admin/car-rental/models", async (request) => {
    const clauses = request.query.includeInactive === "true" ? ["1=1"] : ["m.is_active=1"]; const values: string[] = [];
    if (request.query.brandId) { clauses.push("m.brand_id=?"); values.push(request.query.brandId); }
    const rows = await database.prepare<Row>(`SELECT m.*,b.name AS brand_name,(SELECT COUNT(*) FROM car_rental_vehicles v WHERE v.model_id=m.id) AS vehicle_count FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE ${clauses.join(" AND ")} ORDER BY b.sort_order,m.sort_order,m.id`).all(...values);
    return { data: rows.map((row) => ({ ...modelFromRow(row, 0), vehicleCount: Number(row.vehicle_count) })) };
  });
  app.get<{ Params: { id: string } }>("/api/admin/car-rental/models/:id", async (request) => {
    const row = await modelRow(database, request.params.id); if (!row) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到该车型");
    const images = await database.prepare<Row>("SELECT * FROM car_rental_model_images WHERE model_id=? ORDER BY sort_order,id").all(request.params.id);
    return { data: { ...modelFromRow(row, 0), images: images.map(adminImageFromRow) } };
  });
  app.post("/api/admin/car-rental/models", async (request, reply) => {
    const body = parseBody(modelInputSchema, request.body, reply); if (!body) return;
    const id = body.id ?? `rental-model-${randomUUID()}`; const timestamp = now().toISOString();
    const created = await database.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO car_rental_models (id,brand_id,name,cover_image_url,body_type,energy_type,transmission,seats,luggage,sort_order,is_active,is_synthetic,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(id, body.brandId, body.name, body.coverImageUrl ?? null, body.bodyType, body.energyType, body.transmission, body.seats, body.luggage, body.sortOrder, body.isActive ? 1 : 0, timestamp, timestamp);
      const row = (await modelRow(tx, id))!;
      await auditRentalMutation(tx, request, {
        action: "car_rental.model.created",
        resource: { type: "car_rental_model", id },
        after: modelAuditSnapshot(row),
        presentation: {
          actionLabel: "新增租赁车型",
          summary: `新增了租赁车型「${String(row.brand_name)} ${String(row.name)}」`,
          subjectName: "汽车租赁",
          resourceLabel: `车型「${String(row.brand_name)} ${String(row.name)}」`,
        },
      });
      return row;
    });
    reply.status(201); return { data: modelFromRow(created) };
  });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/models/:id", async (request, reply) => {
    const body = parseBody(modelInputSchema.omit({ id: true }), request.body, reply); if (!body) return;
    const updated = await database.transaction(async (tx) => {
      const current = await tx.prepare<Row>("SELECT m.*,b.name AS brand_name FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE m.id=? FOR UPDATE OF m").get(request.params.id);
      if (!current) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到该车型");
      const result = await tx.prepare("UPDATE car_rental_models SET brand_id=?,name=?,cover_image_url=?,body_type=?,energy_type=?,transmission=?,seats=?,luggage=?,sort_order=?,is_active=?,updated_at=? WHERE id=?").run(body.brandId, body.name, body.coverImageUrl ?? null, body.bodyType, body.energyType, body.transmission, body.seats, body.luggage, body.sortOrder, body.isActive ? 1 : 0, now().toISOString(), request.params.id);
      if (!result.changes) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到该车型");
      const row = (await modelRow(tx, request.params.id))!;
      const before = modelAuditSnapshot(current);
      const after = modelAuditSnapshot(row);
      if (String(current.cover_image_url ?? "") !== String(row.cover_image_url ?? "")) {
        before.封面图片 = "更新前";
        after.封面图片 = "已更新";
      }
      const changes = rentalAuditDiff(before, after).changes;
      const onlyStatus = changes.length === 1 && changes[0]?.field === "状态";
      const enabled = bool(row.is_active);
      await auditRentalMutation(tx, request, {
        action: onlyStatus ? `car_rental.model.${enabled ? "enabled" : "disabled"}` : "car_rental.model.updated",
        resource: { type: "car_rental_model", id: request.params.id },
        before,
        after,
        presentation: {
          actionLabel: onlyStatus ? `${enabled ? "启用" : "停用"}租赁车型` : "修改租赁车型",
          summary: `${onlyStatus ? enabled ? "启用" : "停用" : "修改"}了租赁车型「${String(row.brand_name)} ${String(row.name)}」`,
          subjectName: "汽车租赁",
          resourceLabel: `车型「${String(row.brand_name)} ${String(row.name)}」`,
        },
      });
      return row;
    });
    return { data: modelFromRow(updated) };
  });
  app.post<{ Params: { id: string } }>("/api/admin/car-rental/models/:id/images", async (request, reply) => {
    const model = await modelRow(database, request.params.id); if (!model) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到该车型");
    const multipart = Boolean((request as unknown as { isMultipart?: () => boolean }).isMultipart?.());
    let processed: Awaited<ReturnType<typeof receiveRentalImage>> | null = null;
    let imageUrl: string;
    let sortOrder: number;
    let isCover: boolean;
    if (multipart) {
      processed = await receiveRentalImage(request, problem);
      const requestedSort = Number(multipartField(processed.part, "sortOrder"));
      sortOrder = Number.isInteger(requestedSort) && requestedSort >= 0 ? requestedSort : Number((await database.prepare<Row>("SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM car_rental_model_images WHERE model_id=?").get(request.params.id))?.next ?? 0);
      const cover = multipartField(processed.part, "isCover");
      isCover = cover === "true" || cover === "1";
      imageUrl = "";
    } else {
      const body = parseBody(z.object({ imageUrl: z.string().trim().min(1).max(500), sortOrder: z.number().int().min(0).default(0), isCover: z.boolean().default(false) }), request.body, reply); if (!body) return;
      imageUrl = body.imageUrl; sortOrder = body.sortOrder; isCover = body.isCover;
    }
    const id = `rental-model-image-${randomUUID()}`; const timestamp = now().toISOString();
    const storageKey = processed ? `${randomUUID()}.webp` : null;
    if (processed && storageKey) { await writeFile(join(imageUploadDir, storageKey), processed.data, { flag: "wx" }); imageUrl = `/api/car-rental/images/${id}`; }
    try {
      const created = await database.transaction(async (tx) => {
        const lockedModel = await tx.prepare<Row>("SELECT m.*,b.name AS brand_name FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE m.id=? FOR UPDATE OF m").get(request.params.id);
        if (!lockedModel) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到该车型");
        const count = Number((await tx.prepare<Row>("SELECT COUNT(*) AS count FROM car_rental_model_images WHERE model_id=?").get(request.params.id))?.count ?? 0);
        if (count >= 30) throw problem(409, "RENTAL_IMAGE_LIMIT_REACHED", "每个车型最多维护30张图片");
        isCover = isCover || count === 0;
        if (isCover) await tx.prepare("UPDATE car_rental_model_images SET is_cover=0 WHERE model_id=?").run(request.params.id);
        await tx.prepare("INSERT INTO car_rental_model_images (id,model_id,image_url,storage_key,mime_type,size_bytes,width,height,sort_order,is_cover,is_synthetic,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)").run(id, request.params.id, imageUrl, storageKey, "image/webp", processed?.data.length ?? 0, processed?.info.width ?? 1, processed?.info.height ?? 1, sortOrder, isCover ? 1 : 0, timestamp);
        if (isCover) await tx.prepare("UPDATE car_rental_models SET cover_image_url=?,updated_at=? WHERE id=?").run(imageUrl, timestamp, request.params.id);
        const row = await tx.prepare<Row>("SELECT * FROM car_rental_model_images WHERE id=?").get(id) as Row;
        await auditRentalMutation(tx, request, {
          action: "car_rental.model_image.added",
          resource: { type: "car_rental_model_image", id },
          before: { 图片数量: count, 封面图片: isCover ? "更新前" : "未变更" },
          after: { 图片数量: count + 1, 封面图片: isCover ? "已更新" : "未变更" },
          presentation: {
            actionLabel: "添加车型图片",
            summary: `为租赁车型「${String(lockedModel.brand_name)} ${String(lockedModel.name)}」添加了展示图片`,
            subjectName: "汽车租赁",
            resourceLabel: `车型「${String(lockedModel.brand_name)} ${String(lockedModel.name)}」的展示图片`,
          },
        });
        return row;
      });
      return reply.status(201).send({ data: adminImageFromRow(created) });
    } catch (error) {
      if (storageKey) await unlink(join(imageUploadDir, storageKey)).catch((cleanupError) => {
        app.log.error({ cleanupError, modelId: request.params.id }, "failed to clean up rental model image after rollback");
      });
      throw error;
    }
  });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/models/:id/images", async (request, reply) => {
    const body = parseBody(z.object({ images: z.array(z.object({ id: idSchema, sortOrder: z.number().int().min(0), isCover: z.boolean().default(false) })).min(1).max(30) }), request.body, reply); if (!body) return;
    if (body.images.filter((image) => image.isCover).length > 1) throw problem(400, "RENTAL_IMAGE_COVER_CONFLICT", "只能设置一张封面图");
    const rows = await database.transaction(async (tx) => {
      const model = await tx.prepare<Row>("SELECT m.*,b.name AS brand_name FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE m.id=? FOR UPDATE OF m").get(request.params.id);
      if (!model) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到该车型");
      const beforeRows = await tx.prepare<Row>("SELECT * FROM car_rental_model_images WHERE model_id=? ORDER BY sort_order,id FOR UPDATE").all(request.params.id);
      const beforeOrder = beforeRows.map((image) => String(image.id));
      const beforeCover = beforeRows.find((image) => bool(image.is_cover));
      await tx.prepare("UPDATE car_rental_model_images SET is_cover=0 WHERE model_id=?").run(request.params.id);
      for (const image of body.images) {
        const result = await tx.prepare("UPDATE car_rental_model_images SET sort_order=?,is_cover=? WHERE id=? AND model_id=?").run(image.sortOrder, image.isCover ? 1 : 0, image.id, request.params.id);
        if (!result.changes) throw problem(404, "RENTAL_MODEL_IMAGE_NOT_FOUND", "车型图片不存在");
      }
      const cover = body.images.find((image) => image.isCover);
      if (cover) {
        const row = await tx.prepare<Row>("SELECT image_url FROM car_rental_model_images WHERE id=?").get(cover.id);
        await tx.prepare("UPDATE car_rental_models SET cover_image_url=?,updated_at=? WHERE id=?").run(row?.image_url as string, now().toISOString(), request.params.id);
      }
      const finalRows = await tx.prepare<Row>("SELECT * FROM car_rental_model_images WHERE model_id=? ORDER BY sort_order,id").all(request.params.id);
      const finalOrder = finalRows.map((image) => String(image.id));
      const finalCover = finalRows.find((image) => bool(image.is_cover));
      const before: RentalAuditSnapshot = {};
      const after: RentalAuditSnapshot = {};
      if (!rentalAuditValueEqual(beforeOrder, finalOrder)) {
        before.展示顺序 = "调整前";
        after.展示顺序 = "已调整";
      }
      if (String(beforeCover?.id ?? "") !== String(finalCover?.id ?? "")) {
        before.封面图片 = beforeCover ? "原封面" : "未设置";
        after.封面图片 = finalCover ? "已更换" : "未设置";
      }
      await auditRentalMutation(tx, request, {
        action: "car_rental.model_images.arranged",
        resource: { type: "car_rental_model_images", id: request.params.id },
        before,
        after,
        presentation: {
          actionLabel: "调整车型图片展示",
          summary: `调整了租赁车型「${String(model.brand_name)} ${String(model.name)}」的图片展示`,
          subjectName: "汽车租赁",
          resourceLabel: `车型「${String(model.brand_name)} ${String(model.name)}」的展示图片`,
        },
      });
      return finalRows;
    });
    return { data: { images: rows.map(adminImageFromRow) } };
  });
  app.delete<{ Params: { id: string; imageId: string } }>("/api/admin/car-rental/models/:id/images/:imageId", async (request) => {
    const image = await database.transaction(async (tx) => {
      const model = await tx.prepare<Row>("SELECT m.*,b.name AS brand_name FROM car_rental_models m JOIN car_rental_brands b ON b.id=m.brand_id WHERE m.id=? FOR UPDATE OF m").get(request.params.id);
      if (!model) throw problem(404, "RENTAL_MODEL_NOT_FOUND", "未找到该车型");
      const count = Number((await tx.prepare<Row>("SELECT COUNT(*) AS count FROM car_rental_model_images WHERE model_id=?").get(request.params.id))?.count ?? 0);
      const deleted = await tx.prepare<Row>("DELETE FROM car_rental_model_images WHERE id=? AND model_id=? RETURNING *").get(request.params.imageId, request.params.id);
      if (!deleted) throw problem(404, "RENTAL_MODEL_IMAGE_NOT_FOUND", "车型图片不存在");
      if (bool(deleted.is_cover)) {
        const replacement = await tx.prepare<Row>("SELECT * FROM car_rental_model_images WHERE model_id=? ORDER BY sort_order,id LIMIT 1").get(request.params.id);
        if (replacement) {
          await tx.prepare("UPDATE car_rental_model_images SET is_cover=1 WHERE id=?").run(replacement.id as string);
          await tx.prepare("UPDATE car_rental_models SET cover_image_url=?,updated_at=? WHERE id=?").run(replacement.image_url as string, now().toISOString(), request.params.id);
        } else {
          await tx.prepare("UPDATE car_rental_models SET cover_image_url=NULL,updated_at=? WHERE id=?").run(now().toISOString(), request.params.id);
        }
      }
      await auditRentalMutation(tx, request, {
        action: "car_rental.model_image.removed",
        resource: { type: "car_rental_model_image", id: request.params.imageId },
        before: { 车型图片: "删除前", 图片数量: count },
        after: { 车型图片: "已删除", 图片数量: Math.max(0, count - 1) },
        presentation: {
          actionLabel: "删除车型图片",
          summary: `删除了租赁车型「${String(model.brand_name)} ${String(model.name)}」的展示图片`,
          subjectName: "汽车租赁",
          resourceLabel: `车型「${String(model.brand_name)} ${String(model.name)}」的展示图片`,
        },
      });
      return deleted;
    });
    if (image.storage_key != null) {
      await unlink(join(imageUploadDir, String(image.storage_key))).catch((cleanupError) => {
        app.log.error({ cleanupError, imageId: request.params.imageId }, "failed to remove rental model image after database commit");
      });
    }
    return { data: { id: request.params.imageId, deleted: true } };
  });

  app.get("/api/admin/car-rental/stores", async () => ({ data: (await database.prepare<Row>("SELECT * FROM car_rental_stores ORDER BY sort_order,id").all()).map(storeFromRow) }));
  app.get<{ Params: { id: string } }>("/api/admin/car-rental/stores/:id", async (request) => { const row = await database.prepare<Row>("SELECT * FROM car_rental_stores WHERE id=?").get(request.params.id); if (!row) throw problem(404, "RENTAL_STORE_NOT_FOUND", "未找到该门店"); return { data: storeFromRow(row) }; });
  const saveStore = async (request: FastifyRequest, id: string, body: z.infer<typeof storeInputSchema>, insert: boolean) => database.transaction(async (tx) => {
    const timestamp = now().toISOString();
    const current = insert ? undefined : await tx.prepare<Row>("SELECT * FROM car_rental_stores WHERE id=? FOR UPDATE").get(id);
    if (!insert && !current) throw problem(404, "RENTAL_STORE_NOT_FOUND", "未找到该门店");
    if (insert) {
      await tx.prepare(`INSERT INTO car_rental_stores (id,name,district,address,latitude,longitude,open_hours,phone,delivery_base_fee_fen,delivery_included_km,delivery_per_km_fen,delivery_max_radius_km,sort_order,is_active,is_synthetic,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(id, body.name, body.district, body.address, body.latitude, body.longitude, body.openHours, body.phone ?? null, body.deliveryBaseFeeFen, body.deliveryIncludedKm, body.deliveryPerKmFen, body.deliveryMaxRadiusKm, body.sortOrder, body.isActive ? 1 : 0, timestamp, timestamp);
    } else {
      const result = await tx.prepare("UPDATE car_rental_stores SET name=?,district=?,address=?,latitude=?,longitude=?,open_hours=?,phone=?,delivery_base_fee_fen=?,delivery_included_km=?,delivery_per_km_fen=?,delivery_max_radius_km=?,sort_order=?,is_active=?,updated_at=? WHERE id=?").run(body.name, body.district, body.address, body.latitude, body.longitude, body.openHours, body.phone ?? null, body.deliveryBaseFeeFen, body.deliveryIncludedKm, body.deliveryPerKmFen, body.deliveryMaxRadiusKm, body.sortOrder, body.isActive ? 1 : 0, timestamp, id);
      if (!result.changes) throw problem(404, "RENTAL_STORE_NOT_FOUND", "未找到该门店");
    }
    const row = (await tx.prepare<Row>("SELECT * FROM car_rental_stores WHERE id=?").get(id))!;
    const before = current ? storeAuditSnapshot(current) : undefined;
    const after = storeAuditSnapshot(row);
    if (current && before && String(current.phone ?? "") !== String(row.phone ?? "") && before.联系电话 === after.联系电话) {
      before.联系电话 = "更新前（已脱敏）";
      after.联系电话 = "已更新（已脱敏）";
    }
    const changes = rentalAuditDiff(before, after).changes;
    const onlyStatus = Boolean(current) && changes.length === 1 && changes[0]?.field === "状态";
    const enabled = bool(row.is_active);
    await auditRentalMutation(tx, request, {
      action: insert ? "car_rental.store.created" : onlyStatus ? `car_rental.store.${enabled ? "enabled" : "disabled"}` : "car_rental.store.updated",
      resource: { type: "car_rental_store", id },
      before,
      after,
      presentation: {
        actionLabel: insert ? "新增租赁门店" : onlyStatus ? `${enabled ? "启用" : "停用"}租赁门店` : "修改租赁门店",
        summary: `${insert ? "新增" : onlyStatus ? enabled ? "启用" : "停用" : "修改"}了租赁门店「${String(row.name)}」`,
        subjectName: String(row.name),
        resourceLabel: `租赁门店「${String(row.name)}」`,
      },
    });
    return storeFromRow(row);
  });
  app.post("/api/admin/car-rental/stores", async (request, reply) => { const body = parseBody(storeInputSchema, request.body, reply); if (!body) return; const id = body.id ?? `rental-store-${randomUUID()}`; reply.status(201); return { data: await saveStore(request, id, body, true) }; });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/stores/:id", async (request, reply) => { const body = parseBody(storeInputSchema.omit({ id: true }), request.body, reply); if (!body) return; return { data: await saveStore(request, request.params.id, body, false) }; });

  app.get<{ Querystring: { storeId?: string; modelId?: string; status?: string } }>("/api/admin/car-rental/vehicles", async (request) => { const clauses = ["1=1"]; const values: string[] = []; if (request.query.storeId) { clauses.push("v.store_id=?"); values.push(request.query.storeId); } if (request.query.modelId) { clauses.push("v.model_id=?"); values.push(request.query.modelId); } if (request.query.status) { clauses.push("v.status=?"); values.push(request.query.status); } const rows = await database.prepare<Row>(`SELECT v.*,m.name AS model_name,s.name AS store_name FROM car_rental_vehicles v JOIN car_rental_models m ON m.id=v.model_id JOIN car_rental_stores s ON s.id=v.store_id WHERE ${clauses.join(" AND ")} ORDER BY v.stock_no`).all(...values); return { data: rows.map((row) => vehicleFromRow(row, true)) }; });
  app.get<{ Params: { id: string } }>("/api/admin/car-rental/vehicles/:id", async (request) => { const row = await database.prepare<Row>("SELECT v.*,m.name AS model_name,s.name AS store_name FROM car_rental_vehicles v JOIN car_rental_models m ON m.id=v.model_id JOIN car_rental_stores s ON s.id=v.store_id WHERE v.id=?").get(request.params.id); if (!row) throw problem(404, "RENTAL_VEHICLE_NOT_FOUND", "未找到该车辆"); return { data: vehicleFromRow(row, true) }; });
  const saveVehicle = async (request: FastifyRequest, id: string, body: z.infer<typeof vehicleInputSchema>, insert: boolean) => database.transaction(async (tx) => {
    const timestamp = now().toISOString();
    const current = insert ? undefined : await tx.prepare<Row>("SELECT v.*,m.name AS model_name,s.name AS store_name FROM car_rental_vehicles v JOIN car_rental_models m ON m.id=v.model_id JOIN car_rental_stores s ON s.id=v.store_id WHERE v.id=? FOR UPDATE OF v").get(id);
    if (!insert && !current) throw problem(404, "RENTAL_VEHICLE_NOT_FOUND", "未找到该车辆");
    if (current && String(current.status) === "retired" && body.status !== "retired") throw problem(409, "RENTAL_VEHICLE_RETIRED", "已退役车辆不能重新启用");
    if (insert) {
      await tx.prepare("INSERT INTO car_rental_vehicles (id,stock_no,model_id,store_id,plate_number,color,model_year,mileage_km,status,is_synthetic,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)").run(id, body.stockNo, body.modelId, body.storeId, body.plateNumber ?? null, body.color, body.modelYear, body.mileageKm, body.status, timestamp, timestamp);
    } else {
      await tx.prepare("UPDATE car_rental_vehicles SET stock_no=?,model_id=?,store_id=?,plate_number=?,color=?,model_year=?,mileage_km=?,status=?,updated_at=? WHERE id=?").run(body.stockNo, body.modelId, body.storeId, body.plateNumber ?? null, body.color, body.modelYear, body.mileageKm, body.status, timestamp, id);
    }
    const row = (await tx.prepare<Row>("SELECT v.*,m.name AS model_name,s.name AS store_name FROM car_rental_vehicles v JOIN car_rental_models m ON m.id=v.model_id JOIN car_rental_stores s ON s.id=v.store_id WHERE v.id=?").get(id))!;
    const before = current ? vehicleAuditSnapshot(current) : undefined;
    const after = vehicleAuditSnapshot(row);
    if (current && before && String(current.plate_number ?? "") !== String(row.plate_number ?? "") && before.车牌 === after.车牌) {
      before.车牌 = "更新前（已脱敏）";
      after.车牌 = "已更新（已脱敏）";
    }
    const changes = rentalAuditDiff(before, after).changes;
    const onlyStatus = Boolean(current) && changes.length === 1 && changes[0]?.field === "状态";
    const resourceLabel = `车辆「${String(row.stock_no)}」${maskedPlate(row.plate_number) ? ` · ${maskedPlate(row.plate_number)}` : ""}`;
    await auditRentalMutation(tx, request, {
      action: insert ? "car_rental.vehicle.created" : onlyStatus ? "car_rental.vehicle.status_changed" : "car_rental.vehicle.updated",
      resource: { type: "car_rental_vehicle", id },
      before,
      after,
      presentation: {
        actionLabel: insert ? "新增车队车辆" : onlyStatus ? "调整车辆运营状态" : "修改车队车辆",
        summary: insert ? `新增了车辆「${String(row.stock_no)}」` : onlyStatus ? `调整了车辆「${String(row.stock_no)}」的运营状态` : `修改了车辆「${String(row.stock_no)}」`,
        subjectName: String(row.store_name),
        resourceLabel,
      },
    });
    return vehicleFromRow(row, true);
  });
  app.post("/api/admin/car-rental/vehicles", async (request, reply) => { const body = parseBody(vehicleInputSchema, request.body, reply); if (!body) return; const id = body.id ?? `rental-vehicle-${randomUUID()}`; reply.status(201); return { data: await saveVehicle(request, id, body, true) }; });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/vehicles/:id", async (request, reply) => { const body = parseBody(vehicleInputSchema.omit({ id: true }), request.body, reply); if (!body) return; return { data: await saveVehicle(request, request.params.id, body, false) }; });
  app.post<{ Params: { id: string } }>("/api/admin/car-rental/vehicles/:id/retire", async (request) => {
    const row = await database.transaction(async (tx) => {
      const current = await tx.prepare<Row>("SELECT v.*,m.name AS model_name,s.name AS store_name FROM car_rental_vehicles v JOIN car_rental_models m ON m.id=v.model_id JOIN car_rental_stores s ON s.id=v.store_id WHERE v.id=? FOR UPDATE OF v").get(request.params.id);
      if (!current) throw problem(404, "RENTAL_VEHICLE_NOT_FOUND", "未找到该车辆");
      await tx.prepare("UPDATE car_rental_vehicles SET status='retired',updated_at=? WHERE id=?").run(now().toISOString(), request.params.id);
      const finalRow = (await tx.prepare<Row>("SELECT v.*,m.name AS model_name,s.name AS store_name FROM car_rental_vehicles v JOIN car_rental_models m ON m.id=v.model_id JOIN car_rental_stores s ON s.id=v.store_id WHERE v.id=?").get(request.params.id))!;
      await auditRentalMutation(tx, request, {
        action: "car_rental.vehicle.retired",
        resource: { type: "car_rental_vehicle", id: request.params.id },
        before: vehicleAuditSnapshot(current),
        after: vehicleAuditSnapshot(finalRow),
        presentation: {
          actionLabel: "退役车辆",
          summary: `退役了车辆「${String(finalRow.stock_no)}」`,
          subjectName: String(finalRow.store_name),
          resourceLabel: `车辆「${String(finalRow.stock_no)}」${maskedPlate(finalRow.plate_number) ? ` · ${maskedPlate(finalRow.plate_number)}` : ""}`,
        },
      });
      return finalRow;
    });
    return { data: vehicleFromRow(row, true) };
  });

  app.get("/api/admin/car-rental/rate-plans", async () => ({ data: (await database.prepare<Row>(`SELECT r.*,m.name AS model_name,s.name AS store_name FROM car_rental_rate_plans r JOIN car_rental_models m ON m.id=r.model_id LEFT JOIN car_rental_stores s ON s.id=r.store_id ORDER BY m.name,s.name NULLS FIRST`).all()).map(ratePlanFromRow) }));
  app.get<{ Params: { id: string } }>("/api/admin/car-rental/rate-plans/:id", async (request) => { const row = await database.prepare<Row>("SELECT r.*,m.name AS model_name,s.name AS store_name FROM car_rental_rate_plans r JOIN car_rental_models m ON m.id=r.model_id LEFT JOIN car_rental_stores s ON s.id=r.store_id WHERE r.id=?").get(request.params.id); if (!row) throw problem(404, "RENTAL_RATE_PLAN_NOT_FOUND", "未找到该价格方案"); return { data: ratePlanFromRow(row) }; });
  const saveRate = async (request: FastifyRequest, id: string, body: z.infer<typeof ratePlanInputSchema>, insert: boolean) => database.transaction(async (tx) => {
    const timestamp = now().toISOString();
    const current = insert ? undefined : await tx.prepare<Row>("SELECT r.*,m.name AS model_name,s.name AS store_name FROM car_rental_rate_plans r JOIN car_rental_models m ON m.id=r.model_id LEFT JOIN car_rental_stores s ON s.id=r.store_id WHERE r.id=? FOR UPDATE OF r").get(id);
    if (!insert && !current) throw problem(404, "RENTAL_RATE_PLAN_NOT_FOUND", "未找到该价格方案");
    if (insert) {
      await tx.prepare(`INSERT INTO car_rental_rate_plans (id,model_id,store_id,weekday_rate_fen,weekend_rate_fen,basic_protection_daily_fen,prep_fee_fen,optional_protection_daily_fen,vehicle_deposit_fen,violation_deposit_fen,included_mileage_km_per_day,overage_per_km_fen,fuel_policy,cancellation_policy,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, body.modelId, body.storeId ?? null, body.weekdayRateFen, body.weekendRateFen, body.basicProtectionDailyFen, body.prepFeeFen, body.optionalProtectionDailyFen, body.vehicleDepositFen, body.violationDepositFen, body.includedMileageKmPerDay, body.overagePerKmFen, body.fuelPolicy, body.cancellationPolicy, body.isActive ? 1 : 0, timestamp, timestamp);
    } else {
      const result = await tx.prepare("UPDATE car_rental_rate_plans SET model_id=?,store_id=?,weekday_rate_fen=?,weekend_rate_fen=?,basic_protection_daily_fen=?,prep_fee_fen=?,optional_protection_daily_fen=?,vehicle_deposit_fen=?,violation_deposit_fen=?,included_mileage_km_per_day=?,overage_per_km_fen=?,fuel_policy=?,cancellation_policy=?,is_active=?,updated_at=? WHERE id=?").run(body.modelId, body.storeId ?? null, body.weekdayRateFen, body.weekendRateFen, body.basicProtectionDailyFen, body.prepFeeFen, body.optionalProtectionDailyFen, body.vehicleDepositFen, body.violationDepositFen, body.includedMileageKmPerDay, body.overagePerKmFen, body.fuelPolicy, body.cancellationPolicy, body.isActive ? 1 : 0, timestamp, id);
      if (!result.changes) throw problem(404, "RENTAL_RATE_PLAN_NOT_FOUND", "未找到该价格方案");
    }
    const row = (await tx.prepare<Row>("SELECT r.*,m.name AS model_name,s.name AS store_name FROM car_rental_rate_plans r JOIN car_rental_models m ON m.id=r.model_id LEFT JOIN car_rental_stores s ON s.id=r.store_id WHERE r.id=?").get(id))!;
    const before = current ? ratePlanAuditSnapshot(current) : undefined;
    const after = ratePlanAuditSnapshot(row);
    const changes = rentalAuditDiff(before, after).changes;
    const onlyStatus = Boolean(current) && changes.length === 1 && changes[0]?.field === "状态";
    const enabled = bool(row.is_active);
    const scopeName = row.store_id == null ? "全部租赁门店" : String(row.store_name);
    const resourceLabel = `${String(row.model_name)} · ${scopeName}`;
    await auditRentalMutation(tx, request, {
      action: insert ? "car_rental.rate_plan.created" : onlyStatus ? `car_rental.rate_plan.${enabled ? "enabled" : "disabled"}` : "car_rental.rate_plan.updated",
      resource: { type: "car_rental_rate_plan", id },
      before,
      after,
      presentation: {
        actionLabel: insert ? "新增租赁价格方案" : onlyStatus ? `${enabled ? "启用" : "停用"}租赁价格方案` : "调整租赁价格方案",
        summary: `${insert ? "新增" : onlyStatus ? enabled ? "启用" : "停用" : "调整"}了「${resourceLabel}」的价格方案`,
        subjectName: scopeName,
        resourceLabel,
      },
    });
    return ratePlanFromRow(row);
  });
  app.post("/api/admin/car-rental/rate-plans", async (request, reply) => { const body = parseBody(ratePlanInputSchema, request.body, reply); if (!body) return; const id = body.id ?? `rental-rate-${randomUUID()}`; reply.status(201); return { data: await saveRate(request, id, body, true) }; });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/rate-plans/:id", async (request, reply) => { const body = parseBody(ratePlanInputSchema.omit({ id: true }), request.body, reply); if (!body) return; return { data: await saveRate(request, request.params.id, body, false) }; });

  app.get<{ Querystring: { ratePlanId?: string } }>("/api/admin/car-rental/rate-overrides", async (request) => { const rows = request.query.ratePlanId ? await database.prepare<Row>("SELECT * FROM car_rental_rate_overrides WHERE rate_plan_id=? ORDER BY date").all(request.query.ratePlanId) : await database.prepare<Row>("SELECT * FROM car_rental_rate_overrides ORDER BY date,rate_plan_id").all(); return { data: rows.map(rateOverrideFromRow) }; });
  const overrideAuditSelect = `SELECT o.*,r.model_id,r.store_id,m.name AS model_name,s.name AS store_name
    FROM car_rental_rate_overrides o
    JOIN car_rental_rate_plans r ON r.id=o.rate_plan_id
    JOIN car_rental_models m ON m.id=r.model_id
    LEFT JOIN car_rental_stores s ON s.id=r.store_id`;
  const saveOverride = async (request: FastifyRequest, id: string, body: z.infer<typeof rateOverrideInputSchema>, insert: boolean) => database.transaction(async (tx) => {
    const timestamp = now().toISOString();
    const current = insert ? undefined : await tx.prepare<Row>(`${overrideAuditSelect} WHERE o.id=? FOR UPDATE OF o`).get(id);
    if (!insert && !current) throw problem(404, "RENTAL_RATE_OVERRIDE_NOT_FOUND", "未找到该日期价格");
    if (insert) {
      await tx.prepare("INSERT INTO car_rental_rate_overrides (id,rate_plan_id,date,daily_rate_fen,is_available,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, body.ratePlanId, body.date, body.dailyRateFen ?? null, body.isAvailable ? 1 : 0, body.note ?? null, timestamp, timestamp);
    } else {
      const result = await tx.prepare("UPDATE car_rental_rate_overrides SET rate_plan_id=?,date=?,daily_rate_fen=?,is_available=?,note=?,updated_at=? WHERE id=?").run(body.ratePlanId, body.date, body.dailyRateFen ?? null, body.isAvailable ? 1 : 0, body.note ?? null, timestamp, id);
      if (!result.changes) throw problem(404, "RENTAL_RATE_OVERRIDE_NOT_FOUND", "未找到该日期价格");
    }
    const row = (await tx.prepare<Row>(`${overrideAuditSelect} WHERE o.id=?`).get(id))!;
    const before = current ? rateOverrideAuditSnapshot(current) : undefined;
    const after = rateOverrideAuditSnapshot(row);
    if (current && before && String(current.note ?? "") !== String(row.note ?? "") && before.备注 === after.备注) {
      before.备注 = "更新前（正文不记录）";
      after.备注 = "已更新（正文不记录）";
    }
    const available = bool(row.is_available);
    const scopeName = row.store_id == null ? "全部租赁门店" : String(row.store_name);
    const resourceLabel = `${String(row.model_name)} · ${scopeName} · ${String(row.date)}`;
    await auditRentalMutation(tx, request, {
      action: insert ? "car_rental.rate_override.created" : "car_rental.rate_override.updated",
      resource: { type: "car_rental_rate_override", id },
      before,
      after,
      presentation: {
        actionLabel: insert ? available ? "设置指定日期租赁价" : "设置指定日期停售" : available ? "调整指定日期租赁价" : "调整指定日期停售",
        summary: `${insert ? "设置" : "调整"}了「${resourceLabel}」的${available ? "日期价格" : "停售安排"}`,
        subjectName: scopeName,
        resourceLabel,
      },
    });
    return rateOverrideFromRow(row);
  });
  app.post("/api/admin/car-rental/rate-overrides", async (request, reply) => { const body = parseBody(rateOverrideInputSchema, request.body, reply); if (!body) return; const id = body.id ?? `rental-override-${randomUUID()}`; reply.status(201); return { data: await saveOverride(request, id, body, true) }; });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/rate-overrides/:id", async (request, reply) => { const body = parseBody(rateOverrideInputSchema.omit({ id: true }), request.body, reply); if (!body) return; return { data: await saveOverride(request, request.params.id, body, false) }; });
  app.delete<{ Params: { id: string } }>("/api/admin/car-rental/rate-overrides/:id", async (request) => {
    await database.transaction(async (tx) => {
      const current = await tx.prepare<Row>(`${overrideAuditSelect} WHERE o.id=? FOR UPDATE OF o`).get(request.params.id);
      if (!current) throw problem(404, "RENTAL_RATE_OVERRIDE_NOT_FOUND", "未找到该日期价格");
      await tx.prepare("DELETE FROM car_rental_rate_overrides WHERE id=?").run(request.params.id);
      const scopeName = current.store_id == null ? "全部租赁门店" : String(current.store_name);
      const resourceLabel = `${String(current.model_name)} · ${scopeName} · ${String(current.date)}`;
      await auditRentalMutation(tx, request, {
        action: "car_rental.rate_override.removed",
        resource: { type: "car_rental_rate_override", id: request.params.id },
        before: rateOverrideAuditSnapshot(current),
        after: { 当日安排: "已取消覆盖，将使用常规价格" },
        presentation: {
          actionLabel: "取消指定日期覆盖",
          summary: `取消了「${resourceLabel}」的日期覆盖`,
          subjectName: scopeName,
          resourceLabel,
        },
      });
    });
    return { data: { id: request.params.id, deleted: true } };
  });

  registerCarRentalAdminOrderRoutes(app, database, options);
}

const adminTransitionSchema = z.object({
  status: orderStatusSchema, operator: z.string().trim().min(1).max(80).default("运营后台"), note: z.string().trim().max(500).optional(),
});
const transitionTargets: Record<string, string[]> = {
  pending_payment: ["cancelled", "expired"], confirmed: ["ready_for_pickup", "cancelled"],
  ready_for_pickup: ["in_use", "cancelled"], in_use: ["return_pending"], return_pending: ["completed"],
  completed: [], cancelled: [], expired: [],
};

function registerCarRentalAdminOrderRoutes(app: FastifyInstance, database: AppDatabase, options: CarRentalRouteOptions): void {
  const { problem } = options;
  const now = options.now ?? (() => new Date());

  app.get<{ Querystring: { status?: string; storeId?: string; query?: string } }>("/api/admin/car-rental/orders", async (request) => {
    await expireOrders(database, now());
    const clauses = ["1=1"]; const values: string[] = [];
    if (request.query.status) { clauses.push("o.status=?"); values.push(request.query.status); }
    if (request.query.storeId) { clauses.push("o.store_id=?"); values.push(request.query.storeId); }
    if (request.query.query) { clauses.push("(o.order_number ILIKE ? OR o.driver_name ILIKE ? OR o.driver_phone ILIKE ?)"); const q = `%${request.query.query}%`; values.push(q, q, q); }
    return { data: (await database.prepare<Row>(`${orderSelect} WHERE ${clauses.join(" AND ")} ORDER BY o.created_at DESC`).all(...values)).map((row) => orderFromRow(row)) };
  });
  app.get<{ Params: { id: string } }>("/api/admin/car-rental/orders/:id", async (request) => {
    await expireOrders(database, now());
    const row = await database.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(request.params.id);
    if (!row) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
    const events = (await database.prepare<Row>("SELECT * FROM car_rental_order_events WHERE order_id=? ORDER BY created_at,id").all(request.params.id)).map((event) => ({ id: String(event.id), fromStatus: event.from_status == null ? null : String(event.from_status), toStatus: String(event.to_status), actorType: String(event.actor_type), actorName: event.actor_name == null ? null : String(event.actor_name), note: event.note == null ? null : String(event.note), metadata: jsonObject(event.metadata_json), createdAt: String(event.created_at) }));
    const adjustments = (await database.prepare<Row>("SELECT * FROM car_rental_order_adjustments WHERE order_id=? ORDER BY created_at,id").all(request.params.id)).map((item) => ({ id: String(item.id), kind: String(item.kind), amountFen: Number(item.amount_fen), note: String(item.note), operator: String(item.operator), createdAt: String(item.created_at) }));
    return { data: orderFromRow(row, events, adjustments) };
  });
  app.post<{ Params: { id: string } }>("/api/admin/car-rental/orders/:id/assign-vehicle", async (request, reply) => {
    const body = parseBody(z.object({ vehicleId: idSchema, operator: z.string().trim().min(1).max(80).default("运营后台"), note: z.string().trim().max(300).optional() }), request.body, reply); if (!body) return;
    const row = await database.transaction(async (tx) => {
      const order = await tx.prepare<Row>(`${orderSelect} WHERE o.id=? FOR UPDATE OF o`).get(request.params.id); if (!order) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
      if (!["confirmed", "ready_for_pickup"].includes(String(order.status))) throw problem(409, "RENTAL_ASSIGNMENT_NOT_ALLOWED", "当前状态不能分配车辆");
      const vehicle = await tx.prepare<Row>("SELECT * FROM car_rental_vehicles WHERE id=? FOR UPDATE").get(body.vehicleId); if (!vehicle) throw problem(404, "RENTAL_VEHICLE_NOT_FOUND", "未找到该车辆");
      if (String(vehicle.status) !== "active" || String(vehicle.store_id) !== String(order.store_id) || String(vehicle.model_id) !== String(order.model_id)) throw problem(409, "RENTAL_VEHICLE_NOT_ELIGIBLE", "只能分配同门店、同车型的启用车辆");
      const conflict = await tx.prepare<Row>(`SELECT id FROM car_rental_orders WHERE assigned_vehicle_id=? AND id<>? AND pickup_at<? AND return_at>? AND status IN ('confirmed','ready_for_pickup','in_use','return_pending') LIMIT 1`).get(body.vehicleId, request.params.id, order.return_at as string, order.pickup_at as string);
      if (conflict) throw problem(409, "RENTAL_VEHICLE_TIME_CONFLICT", "该车辆在所选租期已被分配");
      const actorName = request.backoffice?.account.displayName ?? "运营后台";
      const timestamp = now().toISOString(); await tx.prepare("UPDATE car_rental_orders SET assigned_vehicle_id=?,updated_at=? WHERE id=?").run(body.vehicleId, timestamp, request.params.id);
      await tx.prepare("INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,actor_name,note,metadata_json,created_at) VALUES (?,?,?,?, 'admin',?,?,?,?)").run(randomUUID(), request.params.id, order.status as string, order.status as string, actorName, body.note ?? "已分配履约车辆", JSON.stringify({ vehicleId: body.vehicleId }), timestamp);
      const finalRow = await tx.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(request.params.id) as Row;
      const previousVehicle = order.assigned_vehicle_id == null ? "未分配" : `${String(order.assigned_stock_no ?? "车辆")}${maskedPlate(order.assigned_plate_number) ? ` · ${maskedPlate(order.assigned_plate_number)}` : ""}`;
      const finalVehicle = `${String(finalRow.assigned_stock_no ?? vehicle.stock_no)}${maskedPlate(finalRow.assigned_plate_number ?? vehicle.plate_number) ? ` · ${maskedPlate(finalRow.assigned_plate_number ?? vehicle.plate_number)}` : ""}`;
      const changed = String(order.assigned_vehicle_id ?? "") !== String(finalRow.assigned_vehicle_id ?? "");
      await auditRentalMutation(tx, request, {
        action: order.assigned_vehicle_id == null ? "car_rental.order.vehicle_assigned" : "car_rental.order.vehicle_changed",
        resource: { type: "car_rental_order", id: request.params.id },
        before: changed ? { 履约车辆: previousVehicle } : {},
        after: changed ? { 履约车辆: finalVehicle } : {},
        presentation: {
          actionLabel: order.assigned_vehicle_id == null ? "为订单分配车辆" : "更换订单履约车辆",
          summary: order.assigned_vehicle_id == null ? `为${rentalOrderResourceLabel(finalRow)}分配履约车辆「${finalVehicle}」` : `将${rentalOrderResourceLabel(finalRow)}的履约车辆更换为「${finalVehicle}」`,
          subjectName: rentalOrderSubjectName(finalRow),
          resourceLabel: rentalOrderResourceLabel(finalRow),
        },
      });
      return finalRow;
    });
    return { data: orderFromRow(row) };
  });
  app.post<{ Params: { id: string } }>("/api/admin/car-rental/orders/:id/transition", async (request, reply) => {
    const body = parseBody(adminTransitionSchema, request.body, reply); if (!body) return;
    const row = await database.transaction(async (tx) => {
      const order = await tx.prepare<Row>(`${orderSelect} WHERE o.id=? FOR UPDATE OF o`).get(request.params.id); if (!order) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
      const previous = String(order.status); if (previous === body.status) return await tx.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(request.params.id) as Row;
      if (!(transitionTargets[previous] ?? []).includes(body.status)) throw problem(409, "RENTAL_STATUS_TRANSITION_INVALID", `不能从 ${previous} 变更为 ${body.status}`);
      if (body.status === "ready_for_pickup" && order.assigned_vehicle_id == null) throw problem(409, "RENTAL_VEHICLE_ASSIGNMENT_REQUIRED", "备车前必须分配实际车辆");
      const actorName = request.backoffice?.account.displayName ?? "运营后台";
      const timestamp = now().toISOString();
      await tx.prepare("UPDATE car_rental_orders SET status=?,hold_expires_at=CASE WHEN ? IN ('cancelled','expired') THEN NULL ELSE hold_expires_at END,cancelled_at=CASE WHEN ?='cancelled' THEN ? ELSE cancelled_at END,completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,updated_at=? WHERE id=?").run(body.status, body.status, body.status, timestamp, body.status, timestamp, timestamp, request.params.id);
      await tx.prepare("INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,actor_name,note,created_at) VALUES (?,?,?,?, 'admin',?,?,?)").run(randomUUID(), request.params.id, previous, body.status, actorName, body.note ?? "运营推进履约状态", timestamp);
      const finalRow = await tx.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(request.params.id) as Row;
      const actionLabel = body.status === "ready_for_pickup" ? "标记备车完成"
        : body.status === "in_use" ? "确认车辆已取走"
          : body.status === "return_pending" ? "标记订单待还车"
            : body.status === "completed" ? "完成租车订单"
              : body.status === "cancelled" ? "取消租车订单"
                : body.status === "expired" ? "标记订单已过期"
                  : "调整租车订单状态";
      await auditRentalMutation(tx, request, {
        action: "car_rental.order.status_changed",
        resource: { type: "car_rental_order", id: request.params.id },
        before: { 订单状态: rentalOrderStatusLabels[previous] ?? previous },
        after: { 订单状态: rentalOrderStatusLabels[body.status] ?? body.status },
        presentation: {
          actionLabel,
          summary: `${actionLabel}：${rentalOrderResourceLabel(finalRow)}`,
          subjectName: rentalOrderSubjectName(finalRow),
          resourceLabel: rentalOrderResourceLabel(finalRow),
        },
      });
      return finalRow;
    });
    return { data: orderFromRow(row) };
  });
  app.post<{ Params: { id: string } }>("/api/admin/car-rental/orders/:id/adjustments", async (request, reply) => {
    const body = parseBody(z.object({ kind: z.enum(["overtime", "fuel_or_charge", "cleaning", "other"]).default("other"), amountFen: z.number().int().min(-10_000_000).max(10_000_000), note: z.string().trim().min(2).max(500), operator: z.string().trim().min(1).max(80).default("运营后台") }), request.body, reply); if (!body) return;
    const result = await database.transaction(async (tx) => {
      const order = await tx.prepare<Row>(`${orderSelect} WHERE o.id=? FOR UPDATE OF o`).get(request.params.id); if (!order) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
      const actorName = request.backoffice?.account.displayName ?? "运营后台";
      const id = randomUUID(); const timestamp = now().toISOString();
      await tx.prepare("INSERT INTO car_rental_order_adjustments (id,order_id,kind,amount_fen,note,operator,created_at) VALUES (?,?,?,?,?,?,?)").run(id, request.params.id, body.kind, body.amountFen, body.note, actorName, timestamp);
      await tx.prepare("INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,actor_name,note,metadata_json,created_at) VALUES (?,?,?,?, 'admin',?,?,?,?)").run(randomUUID(), request.params.id, order.status as string, order.status as string, actorName, "录入租后费用调整", JSON.stringify({ adjustmentId: id, kind: body.kind, amountFen: body.amountFen }), timestamp);
      const actionLabel = body.amountFen < 0 ? "登记租后费用减免" : "登记租后附加费";
      await auditRentalMutation(tx, request, {
        action: "car_rental.order.adjustment_created",
        resource: { type: "car_rental_order_adjustment", id },
        after: {
          费用类型: rentalAdjustmentKindLabels[body.kind] ?? body.kind,
          金额: rentalMoneyLabel(body.amountFen),
          原因: "已填写（正文不记录）",
        },
        presentation: {
          actionLabel,
          summary: `${actionLabel} ${rentalMoneyLabel(body.amountFen)}：${rentalOrderResourceLabel(order)}`,
          subjectName: rentalOrderSubjectName(order),
          resourceLabel: rentalOrderResourceLabel(order),
        },
      });
      return { id, orderId: request.params.id, kind: body.kind, amountFen: body.amountFen, note: body.note, operator: actorName, createdAt: timestamp };
    });
    reply.status(201); return { data: result };
  });
  app.put<{ Params: { id: string } }>("/api/admin/car-rental/orders/:id/internal-note", async (request, reply) => {
    const body = parseBody(z.object({ internalNote: z.string().trim().max(2_000).nullable(), operator: z.string().trim().min(1).max(80).default("运营后台") }), request.body, reply); if (!body) return;
    const row = await database.transaction(async (tx) => {
      const current = await tx.prepare<Row>("SELECT id FROM car_rental_orders WHERE id=? FOR UPDATE").get(request.params.id);
      if (!current) throw problem(404, "RENTAL_ORDER_NOT_FOUND", "未找到该租车订单");
      const timestamp = now().toISOString();
      const actorName = request.backoffice?.account.displayName ?? "运营后台";
      await tx.prepare("UPDATE car_rental_orders SET internal_note=?,updated_at=? WHERE id=?").run(body.internalNote, timestamp, request.params.id);
      await tx.prepare("INSERT INTO car_rental_order_events (id,order_id,from_status,to_status,actor_type,actor_name,note,created_at) SELECT ?,id,status,status,'admin',?,'更新内部备注',? FROM car_rental_orders WHERE id=?").run(randomUUID(), actorName, timestamp, request.params.id);
      return (await tx.prepare<Row>(`${orderSelect} WHERE o.id=?`).get(request.params.id))!;
    });
    return { data: orderFromRow(row) };
  });
}
