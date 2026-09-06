import { PLATE_CATEGORY_CODES, PLATE_CATEGORIES, plateCategory, legacyPlateCategory } from "../wechat-miniprogram/miniprogram/utils/plate-categories.js";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import {
  calculateInspection,
  expectedOnsiteChecksForPowertrain,
  inspectionApplicationWindow,
  INSPECTION_DISCLAIMER,
  INSPECTION_POLICY,
  normalizeInspectionPowertrainType,
  type InspectionFactSource,
  type InspectionPowertrainType,
  type InspectionVehicleFacts,
} from "../src/domain/inspection.js";
import {
  editablePlateValue,
  normalizePlate,
  parsePlate,
  PROVINCE_ABBREVIATIONS,
  validateEditablePlate,
} from "../src/domain/plate.js";
import { inferWashVehicleCategory, normalizeWashVehicleCategory } from "../src/domain/wash.js";
import { AuthenticationError, registerAuthRoutes, requireCurrentUser } from "./auth.js";
import { registerUserProfileRoutes } from "./user-profile.js";
import {
  assertCapability,
  auditBackofficeEvent,
  backofficeForRequest,
  backofficeOriginAllowed,
  BackofficeError,
  isBackofficeOriginControlledPath,
  registerBackofficeRoutes,
  resolveInspectionStationBearer,
  scopedInspectionStationId,
} from "./backoffice.js";
import type { AppDatabase } from "./database.js";
import {
  businessDate,
  createDatabase,
  DemoResetUnsafeError,
  DEMO_INTEGRATION_SECRET,
  DEMO_STATION_ID,
  DEMO_USER_ID,
  HUAYANG_STATION_ID,
  INSPECTION_PRICE_PLAN_IDS,
  inspectionResultRequestHash,
  seedDemoData,
  stableJson,
  toIsoDate,
} from "./db.js";
import {
  OFFICIAL_INSPECTION_CONCLUSIONS,
  OFFICIAL_INSPECTION_FAILURE_CATEGORIES,
  officialInspectionFailureDetailsView,
  officialInspectionConclusionView,
  safeInspectionConclusionSummary,
} from "./inspection-conclusion.js";
import { registerInsuranceRoutes } from "./insurance.js";
import { registerSubsidyConsultationRoutes } from "./subsidy-consultation.js";
import {
  createWashLocationProof,
  registerWashRoutes,
  validWashLocationProof,
  washLocationSuggestionSchema,
} from "./wash.js";
import { assertAnnualBookingFinancialClosureReady } from "./annual-booking-finance.js";
import { registerUsedCarAssetRoutes } from "./used-car-assets.js";
import { registerDrivingSchoolAssetRoutes } from "./driving-school-assets.js";
import { registerDrivingSchoolRoutes } from "./driving-school.js";
import { registerUsedCarRoutes } from "./used-cars.js";
import { registerCarRentalRoutes } from "./car-rental.js";
import {
  resolveVehicleCatalogSelection,
  vehicleCatalogBrand,
  vehicleCatalogDto,
  vehicleCatalogModel,
} from "./vehicle-catalog.js";
import {
  assertVehicleCheckupDeliveryReady,
  publishVehicleCheckupReport,
  registerVehicleCheckupRoutes,
  vehicleCheckupReportDto,
} from "./vehicle-checkup.js";
import { registerRepairRoutes } from "./repair.js";
import { registerWorkflowRoutes, WorkflowDomainError } from "./workflow.js";
import {
  enableAnnualWorkflowForBooking,
  syncAnnualWorkflowForBooking,
} from "./workflow-integration.js";
import {
  bookingPrecheckMediaKinds,
  precheckAction,
  precheckGuidance,
} from "./precheck-policy.js";
import { registerCustomerCenterRoutes } from "./customer-center.js";
import {
  cancelValetDriverTaskForBooking,
  registerValetHandoffRoutes,
  VALET_EVIDENCE_POLICY_VERSION,
  valetHandoffDetail,
} from "./valet-handoff.js";

type Row = Record<string, unknown>;

const ADMIN_BOOKING_PLATE_FILTER_MAX_RAW_LENGTH = 32;
const ADMIN_BOOKING_PLATE_FILTER_MAX_NORMALIZED_LENGTH = 8;
const PLATE_PROVINCE_ABBREVIATION_SET: ReadonlySet<string> = new Set(PROVINCE_ABBREVIATIONS);

function normalizeAdminBookingPlateFilter(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > ADMIN_BOOKING_PLATE_FILTER_MAX_RAW_LENGTH) {
    throw new ApiProblem(
      400,
      "INVALID_PLATE_NUMBER_FILTER",
      "车牌筛选原始输入不得超过 32 个字符",
    );
  }
  const normalized = normalizePlate(value);
  if (!normalized || normalized.length > ADMIN_BOOKING_PLATE_FILTER_MAX_NORMALIZED_LENGTH) {
    throw new ApiProblem(
      400,
      "INVALID_PLATE_NUMBER_FILTER",
      "车牌筛选应包含 1 至 8 个车牌字符，分隔符和空格不计",
    );
  }
  const startsWithProvince = PLATE_PROVINCE_ABBREVIATION_SET.has(normalized[0]);
  const latinNumericPart = startsWithProvince ? normalized.slice(1) : normalized;
  if ((latinNumericPart && !/^[A-Z0-9]+$/u.test(latinNumericPart))
    || (!startsWithProvince && !latinNumericPart)) {
    throw new ApiProblem(
      400,
      "INVALID_PLATE_NUMBER_FILTER",
      "车牌筛选仅支持省简称、英文字母、数字及常见分隔符",
    );
  }
  return normalized;
}

type BuildAppOptions = {
  database?: AppDatabase;
  logger?: boolean;
  uploadDir?: string;
  insuranceUploadDir?: string;
  insuranceCleanupIntervalMs?: number;
  subsidyConsultationUploadDir?: string;
  subsidyConsultationCleanupIntervalMs?: number;
  now?: () => Date;
  slotNow?: () => Date;
  trustProxy?: false | string | string[];
  carRentalCalculateDrivingRoute?: (
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

export function parseTrustProxy(value = process.env.TRUST_PROXY): false | string[] {
  const configured = value?.trim();
  if (!configured || configured.toLowerCase() === "false" || configured === "0") return false;
  const entries = configured.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) return false;
  for (const entry of entries) {
    if (entry === "loopback") continue;
    const [address, prefix, ...rest] = entry.split("/");
    const family = isIP(address);
    if (!family || rest.length > 0) {
      throw new Error("TRUST_PROXY must contain only loopback, IP addresses, or CIDR ranges");
    }
    if (prefix !== undefined) {
      if (!/^\d{1,3}$/u.test(prefix)) {
        throw new Error("TRUST_PROXY contains an invalid CIDR prefix");
      }
      const bits = Number(prefix);
      const maximum = family === 4 ? 32 : 128;
      if (bits <= 0 || bits > maximum) {
        throw new Error("TRUST_PROXY cannot trust an all-address range or invalid CIDR prefix");
      }
    }
  }
  return entries;
}

class ApiProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const phonePattern = /^1[3-9]\d{9}$/;

function isRealIsoDate(value: string): boolean {
  if (!isoDatePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function todayIso(): string {
  return businessDate();
}

const shanghaiTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function shanghaiHourMinute(value: Date): string {
  const parts = shanghaiTimeFormatter.formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${read("hour")}:${read("minute")}`;
}

function inspectionSlotHasStarted(row: Row, now: Date): boolean {
  const date = String(row.date);
  const currentBusinessDate = todayIso();
  if (date < currentBusinessDate) return true;
  if (date > currentBusinessDate) return false;
  return String(row.start_time) <= shanghaiHourMinute(now);
}

const isoDateSchema = z.string().refine(isRealIsoDate, "请使用有效的 YYYY-MM-DD 日期");
const idSchema = z.string().trim().min(1).max(100);
const serviceModeSchema = z.enum(["self_drive", "valet"]);
const valetTripTypeSchema = z.literal("round_trip_same_address");
const originTypeSchema = z.enum(["self_drive", "valet", "current_location", "pickup_address"]);
const vehiclePriceCategorySchema = z.enum(["fuel_small", "new_energy_small", "seven_seat"]);
const powertrainTypeSchema = z
  .enum(["gasoline", "diesel", "hybrid", "pure_electric", "phev", "erev", "other", "unknown", "hev"])
  .transform((value) => normalizeInspectionPowertrainType(value));
const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "请使用有效的 YYYY-MM 月份");
const inspectionValiditySourceSchema = z.enum([
  "traffic_12123",
  "electronic_driving_license",
  "paper_driving_license",
]);
const inspectionValiditySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unconfirmed") }),
  z.object({
    mode: z.literal("confirmed"),
    validThroughMonth: yearMonthSchema,
    source: inspectionValiditySourceSchema,
  }),
]);
const washVehicleCategorySchema = z
  .enum(["sedan", "suv", "mpv", "suv_mpv"])
  .transform((value) => normalizeWashVehicleCategory(value)!);
const inspectionItemSchema = z.enum([
  "safety_basic",
  "safety_chassis_extended",
  "emissions_gasoline",
  "emissions_diesel",
  "new_energy_safety",
  "reinspection",
]);
const mediaKindSchema = z.enum([
  "vehicle_front_left",
  "vehicle_front_right",
  "vehicle_rear_left",
  "vehicle_rear_right",
  "dashboard_started",
  "license_front",
  "license_back",
]);

const pickupAddressSchema = z.object({
  poiId: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(120),
  address: z.string().trim().min(3).max(240),
  district: z.string().trim().min(1).max(60),
  latitude: z.number().min(38.4).max(40.3),
  longitude: z.number().min(116.6).max(118.2),
  source: z.enum(["tencent", "wechat", "demo"]),
  locationProof: z.string().trim().max(2_000).optional(),
  detail: z.string().trim().max(100).optional(),
  note: z.string().trim().max(300).optional(),
});

const locationResolveSchema = z.object({
  latitude: z.number().min(38.4).max(40.3),
  longitude: z.number().min(116.6).max(118.2),
  name: z.string().trim().max(120).optional(),
  address: z.string().trim().max(240).optional(),
});

type LocationResolveInput = z.infer<typeof locationResolveSchema>;

function verifiedAnnualPickupAddress(
  candidate: z.infer<typeof pickupAddressSchema>,
): z.infer<typeof pickupAddressSchema> {
  const production = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
  if (production && candidate.source === "demo") {
    throw new ApiProblem(
      409,
      "PICKUP_ADDRESS_PROOF_INVALID",
      "生产环境不能使用演示取车地址，请重新搜索并选择真实地址",
    );
  }
  if (candidate.locationProof) {
    if (!validWashLocationProof(candidate)) {
      throw new ApiProblem(
        409,
        "PICKUP_ADDRESS_PROOF_INVALID",
        "取车地址凭证无效或已过期，请重新选择地址",
      );
    }
    return candidate;
  }
  if (production) {
    throw new ApiProblem(
      409,
      "PICKUP_ADDRESS_PROOF_REQUIRED",
      "取车地址缺少服务端校验凭证，请重新选择地址",
    );
  }
  // Keep existing local/demo clients usable while locationProof rolls out. In
  // production, the branch above is deliberately fail-closed.
  return candidate;
}

const quoteRequestSchema = z.object({
  vehicleId: idSchema,
  stationId: idSchema,
  serviceMode: serviceModeSchema,
  pickupAddress: pickupAddressSchema.optional(),
  originLat: z.number().min(38.4).max(40.3).optional(),
  originLng: z.number().min(116.6).max(118.2).optional(),
  originType: originTypeSchema.optional(),
  tripType: valetTripTypeSchema.default("round_trip_same_address"),
}).superRefine((value, context) => {
  const hasLat = value.originLat !== undefined;
  const hasLng = value.originLng !== undefined;
  if (hasLat !== hasLng) {
    context.addIssue({ code: "custom", path: [hasLat ? "originLng" : "originLat"], message: "起点经纬度必须同时提供" });
  }
  if ((hasLat || hasLng) && !value.originType) {
    context.addIssue({ code: "custom", path: ["originType"], message: "请说明起点类型" });
  }
});

const stationOriginQuerySchema = z.object({
  originLat: z.coerce.number().min(38.4).max(40.3).optional(),
  originLng: z.coerce.number().min(116.6).max(118.2).optional(),
  originType: originTypeSchema.optional(),
}).superRefine((value, context) => {
  const hasLat = value.originLat !== undefined;
  const hasLng = value.originLng !== undefined;
  if (hasLat !== hasLng) {
    context.addIssue({ code: "custom", path: [hasLat ? "originLng" : "originLat"], message: "起点经纬度必须同时提供" });
  }
  if ((hasLat || hasLng) && !value.originType) {
    context.addIssue({ code: "custom", path: ["originType"], message: "请说明起点类型" });
  }
});

const createVehicleSchema = z.object({
  plateNumber: z.string().trim().min(1, "请输入车牌号").refine(validateEditablePlate, "车牌号包含不支持的字符或过长"),
  plateCategory: z.enum(PLATE_CATEGORY_CODES).optional(),
  vehicleType: z.string().trim().min(1).max(40).default("小型轿车"),
  usageNature: z.string().trim().min(1).max(40).default("非营运"),
  seats: z.coerce.number().int().min(0).max(99).default(5),
  registrationDate: isoDateSchema,
  inspectionDueDate: isoDateSchema.optional(),
  inspectionValidity: inspectionValiditySchema.optional(),
  isDefault: z.boolean().optional(),
  powertrainType: powertrainTypeSchema.optional(),
  vehicleClassCode: z.string().trim().min(1).max(60).optional(),
  isVan: z.boolean().optional(),
  washVehicleCategory: washVehicleCategorySchema.optional(),
  exteriorColor: z.string().trim().min(1).max(20).nullable().optional(),
  brandId: idSchema.nullable().optional(),
  modelId: idSchema.nullable().optional(),
});

const updateVehicleSchema = z
  .object({
    plateNumber: z.string().trim().min(1).refine(validateEditablePlate, "车牌号包含不支持的字符或过长").optional(),
    plateCategory: z.enum(PLATE_CATEGORY_CODES).optional(),
    vehicleType: z.string().trim().min(1).max(40).optional(),
    usageNature: z.string().trim().min(1).max(40).optional(),
    seats: z.coerce.number().int().min(0).max(99).optional(),
    registrationDate: isoDateSchema.optional(),
    inspectionDueDate: isoDateSchema.optional(),
    inspectionValidity: inspectionValiditySchema.optional(),
    isDefault: z.boolean().optional(),
    powertrainType: powertrainTypeSchema.optional(),
    vehicleClassCode: z.string().trim().min(1).max(60).optional(),
    isVan: z.boolean().optional(),
    washVehicleCategory: washVehicleCategorySchema.optional(),
    exteriorColor: z.string().trim().min(1).max(20).nullable().optional(),
    brandId: idSchema.nullable().optional(),
    modelId: idSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "至少提供一个要更新的字段");

type VehicleCatalogInput = { brandId?: string | null; modelId?: string | null };

function catalogSelectionFromInput(input: VehicleCatalogInput, current?: Row) {
  const brandProvided = input.brandId !== undefined;
  const modelProvided = input.modelId !== undefined;
  if (brandProvided !== modelProvided) {
    throw new ApiProblem(400, "VEHICLE_CATALOG_PAIR_REQUIRED", "品牌和车型需要一起选择", {
      brandId: "品牌和车型需要一起提交",
      modelId: "品牌和车型需要一起提交",
    });
  }
  if (!brandProvided && current) {
    return {
      brandId: current.brand_id == null ? null : String(current.brand_id),
      brandName: current.brand_name == null ? null : String(current.brand_name),
      modelId: current.model_id == null ? null : String(current.model_id),
      modelName: current.model_name == null ? null : String(current.model_name),
    };
  }
  if (!brandProvided || (input.brandId === null && input.modelId === null)) {
    return { brandId: null, brandName: null, modelId: null, modelName: null };
  }
  if (typeof input.brandId !== "string" || typeof input.modelId !== "string") {
    throw new ApiProblem(400, "VEHICLE_CATALOG_PAIR_REQUIRED", "品牌和车型需要一起选择");
  }
  const selection = resolveVehicleCatalogSelection(input.brandId, input.modelId);
  if (!selection) {
    throw new ApiProblem(400, "VEHICLE_CATALOG_SELECTION_INVALID", "所选品牌与车型不匹配或已下线", {
      modelId: "请重新选择车型",
    });
  }
  return {
    brandId: selection.brand.id,
    brandName: selection.brand.name,
    modelId: selection.model.id,
    modelName: selection.model.name,
  };
}

function isPassengerVehicleClass(value: unknown): boolean {
  return value === "passenger_car" || value === "large_bus";
}

function exteriorColorForWrite(input: string | null | undefined, current: Row | undefined, vehicleClassCode: string | null): string | null {
  if (!isPassengerVehicleClass(vehicleClassCode)) return null;
  if (input !== undefined) return input;
  return current?.exterior_color == null ? null : String(current.exterior_color);
}

function assertCatalogSelectionVehicleClass(modelId: string | null, vehicleClassCode: string | null): void {
  if (!modelId || !vehicleClassCode) return;
  const model = vehicleCatalogModel(modelId);
  if (!model?.vehicleClassCodes.some((code) => code === vehicleClassCode)) {
    throw new ApiProblem(400, "VEHICLE_CATALOG_CLASS_MISMATCH", "所选车型不适用于当前号牌类型", {
      modelId: "请按当前号牌类型重新选择车型",
    });
  }
}

const inspectionDeclarationAnswerSchema = z.enum(["yes", "no", "unknown"]);
const inspectionDeclarationsSchema = z.object({
  isVan: inspectionDeclarationAnswerSchema,
  hasInjuryAccident: inspectionDeclarationAnswerSchema,
  hasIllegalModificationPenalty: inspectionDeclarationAnswerSchema,
  convertedFromOperational: inspectionDeclarationAnswerSchema,
  delayedFirstRegistrationOver4Years: inspectionDeclarationAnswerSchema,
});
const registrationMonthSchema = yearMonthSchema;
const inspectionCalculationRequestSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("vehicle"),
    vehicleId: idSchema,
    declarations: inspectionDeclarationsSchema,
  }),
  z.object({
    source: z.literal("temporary"),
    vehicle: z.object({
      registrationMonth: registrationMonthSchema,
      vehicleClass: z.enum(["small_micro_passenger", "other", "unknown"]),
      usageNature: z.enum(["non_operational", "operational", "unknown"]),
      seats: z.number().int().min(1).max(99).nullable(),
      powertrainType: powertrainTypeSchema.optional(),
    }),
    inspectionValidity: inspectionValiditySchema.optional(),
    declarations: inspectionDeclarationsSchema,
  }),
]);

const createBookingSchema = z.object({
  vehicleId: idSchema,
  stationId: idSchema,
  slotId: idSchema,
  contactName: z.string().trim().min(2, "联系人至少需要 2 个字符").max(30),
  contactPhone: z.string().trim().regex(phonePattern, "请输入有效的 11 位手机号"),
  serviceMode: serviceModeSchema.default("self_drive"),
  tripType: valetTripTypeSchema.default("round_trip_same_address"),
  pickupAddress: pickupAddressSchema.optional(),
  mediaIds: z.array(idSchema).max(7).default([]),
  quote: z.object({
    inspectionFeeFen: z.number().int().nonnegative(),
    valetFeeFen: z.number().int().nonnegative(),
    serviceFeeFen: z.number().int().nonnegative(),
  }).optional(),
  quoteSnapshotId: idSchema,
  notes: z.string().trim().max(300).optional(),
});

const weeklyScheduleSchema = z.object({
  mon: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  tue: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  wed: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  thu: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  fri: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  sat: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  sun: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
});

const stationPricePlanInputSchema = z.object({
  planId: idSchema,
  isSupported: z.boolean(),
  priceFen: z.number().int().min(0).max(1_000_000),
}).superRefine((value, context) => {
  if (value.isSupported && value.priceFen <= 0) {
    context.addIssue({
      code: "custom",
      path: ["priceFen"],
      message: "启用在线报价的车型方案必须填写大于 0 的价格",
    });
  }
});

const adminStationSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(2).max(100),
  legalName: z.string().trim().min(2).max(160).nullable().optional(),
  location: washLocationSuggestionSchema.optional(),
  openHours: z.string().trim().min(5).max(40),
  phone: z.string().trim().max(30).nullable().optional(),
  isActive: z.boolean(),
  dataKind: z.enum(["demo", "real"]).optional(),
  isDirectOperated: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  sortPriority: z.number().int().min(-10_000).max(10_000).optional(),
  weeklySchedule: weeklyScheduleSchema.optional(),
  businessHoursNotice: z.string().trim().max(300).nullable().optional(),
  internalContact: z.object({
    name: z.string().trim().min(1).max(60),
    phone: z.string().trim().min(5).max(30),
  }).nullable().optional(),
  pricePlans: z.array(stationPricePlanInputSchema).optional(),
});

function verifiedAdminStationLocation(
  candidate: z.infer<typeof washLocationSuggestionSchema>,
): z.infer<typeof washLocationSuggestionSchema> {
  const production = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
  if (production && candidate.source === "demo") {
    throw new ApiProblem(409, "STATION_LOCATION_PROOF_INVALID", "生产环境不能使用演示检测站位置，请重新搜索并选择真实地址");
  }
  if (!candidate.locationProof || !validWashLocationProof(candidate)) {
    throw new ApiProblem(409, "STATION_LOCATION_PROOF_INVALID", "检测站位置凭证无效或已过期，请重新搜索并选择地址");
  }
  return candidate;
}

const adminPricingSchema = z.object({
  stationId: idSchema,
  category: vehiclePriceCategorySchema,
  priceFen: z.number().int().min(1).max(1_000_000),
});

const adminValetRuleSchema = z.object({
  baseFeeFen: z.number().int().min(0).max(1_000_000),
  includedKm: z.number().min(0).max(100),
  perKmFen: z.number().int().min(0).max(100_000),
  maxRadiusKm: z.number().min(1).max(10_000).nullable(),
});

const inspectionPricePlanSchema = z.object({
  id: idSchema.optional(),
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).default(""),
  powertrainTypes: z.array(powertrainTypeSchema).min(1),
  plateCategories: z.array(z.enum(PLATE_CATEGORY_CODES)).min(1).optional(),
  minSeats: z.number().int().min(0).max(99),
  maxSeats: z.number().int().min(0).max(99),
  usageNatures: z.array(z.string().trim().min(1).max(60)).min(1),
  vehicleClassCodes: z.array(z.string().trim().min(1).max(60)).min(1),
  excludeVans: z.boolean().default(true),
  inspectionItems: z.array(inspectionItemSchema).min(1),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  isActive: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.minSeats > value.maxSeats) {
    context.addIssue({ code: "custom", path: ["maxSeats"], message: "最大座位数不能小于最小座位数" });
  }
  if (value.powertrainTypes.includes("pure_electric") && value.inspectionItems.some((item) => item.startsWith("emissions_"))) {
    context.addIssue({ code: "custom", path: ["inspectionItems"], message: "纯电价格方案不能包含尾气检测项目" });
  }
});

const stationPricePlansSchema = z.object({
  pricePlans: z.array(stationPricePlanInputSchema),
});

const paymentSchema = z.object({
  provider: z.literal("mock"),
  idempotencyKey: z.string().trim().min(8).max(160),
  quoteSnapshotId: idSchema.optional(),
});

const requoteBookingSchema = z.object({
  expectedQuoteSnapshotId: idSchema,
}).strict();

const ledgerConfirmationSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160),
});

const fulfillmentStatusSchema = z.enum([
  "pending_payment",
  "paid_pending_confirmation",
  "pending_precheck",
  "precheck_action_required",
  "precheck_rejected",
  "confirmed",
  "driver_arranged",
  "picked_up",
  "awaiting_arrival",
  "checked_in",
  "inspecting",
  "result_received",
  "returning",
  "completed",
  "on_hold",
  "cancelled",
  "no_show",
]);

const precheckReasonCodeSchema = z.enum([
  "license_unclear",
  "vehicle_photos_incomplete",
  "vehicle_information_mismatch",
  "booking_information_mismatch",
  "materials_cannot_be_verified",
  "body_dirty",
  "body_damage",
  "dashboard_warning",
  "other",
]);

const precheckPhotoKindSchema = z.enum([
  "vehicle_front_left",
  "vehicle_front_right",
  "vehicle_rear_left",
  "vehicle_rear_right",
  "dashboard_started",
  "license_front",
  "license_back",
]);

const precheckApproveSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160),
  expectedVersion: z.number().int().min(1),
}).strict();

const precheckRejectSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160),
  expectedVersion: z.number().int().min(1),
  reasonCodes: z.array(precheckReasonCodeSchema).min(1).max(9),
  reasonText: z.string().trim().min(5).max(300),
  issuePhotoKinds: z.array(precheckPhotoKindSchema).max(7).default([]),
}).strict();

const adminBookingUpdateSchema = z.object({
  fulfillmentStatus: fulfillmentStatusSchema.optional(),
  internalDriverNote: z.string().trim().max(1000).nullable().optional(),
  adjustment: z.object({
    amountFen: z.number().int().min(1).max(1_000_000),
    reason: z.string().trim().min(2).max(300),
    idempotencyKey: z.string().trim().min(8).max(160),
  }).optional(),
  refund: z.object({
    amountFen: z.number().int().min(1).max(1_000_000),
    reason: z.string().trim().min(2).max(300),
    idempotencyKey: z.string().trim().min(8).max(160),
  }).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), "至少提供一项更新");

const rescheduleSchema = z.object({
  slotId: idSchema,
  quoteSnapshotId: idSchema.optional(),
});

const verificationSchema = z.object({
  plateMatched: z.boolean().default(true),
  materialsReady: z.boolean().default(true),
  exteriorRecorded: z.boolean().default(true),
  vehicleConditionConfirmed: z.boolean().default(true),
  notes: z.string().trim().max(500).optional(),
});

const resolveHoldSchema = z
  .object({
    plateMatched: z.boolean().optional(),
    materialsReady: z.boolean().optional(),
    exteriorRecorded: z.boolean().optional(),
    vehicleConditionConfirmed: z.boolean().optional(),
    notes: z.string().trim().min(2).max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "请至少提供一项复核结果或处理说明");

const holdSchema = z.object({
  reasonCode: z.enum(["vehicle_mismatch", "materials_missing", "late_arrival", "other"]),
  note: z.string().trim().min(2).max(500),
});

const capacitySchema = z.object({
  capacity: z.coerce.number().int().min(0).max(99),
});

const adminSlotSchema = z.object({
  date: isoDateSchema,
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "开始时间格式应为 HH:mm"),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "结束时间格式应为 HH:mm"),
  capacity: z.coerce.number().int().min(1).max(99),
}).refine((value) => value.endTime > value.startTime, {
  path: ["endTime"], message: "结束时间必须晚于开始时间",
});

const inspectionFailureDetailsSchema = z.object({
  itemCategories: z.array(z.enum(OFFICIAL_INSPECTION_FAILURE_CATEGORIES))
    .min(1, "请选择至少一个不合格项目类别")
    .max(9),
  reason: z.string().trim().min(2, "请填写具体不合格原因").max(1_000),
  reinspectionAdvice: z.string().trim().min(2, "请填写复检建议").max(1_000),
}).strict();

const inspectionResultSchema = z.object({
  bookingId: idSchema,
  externalResultId: z.string().trim().min(3).max(100),
  conclusion: z.enum(OFFICIAL_INSPECTION_CONCLUSIONS),
  failureDetails: inspectionFailureDetailsSchema.nullable().optional(),
  summary: z.record(z.string(), z.unknown()).default({}),
  source: z.string().trim().min(2).max(80).default("external_inspection_system"),
  receivedAt: z.iso.datetime().optional(),
}).superRefine((value, context) => {
  if (value.conclusion === "failed" && !value.failureDetails) {
    context.addIssue({
      code: "custom",
      path: ["failureDetails"],
      message: "年检未通过时必须填写不合格项目、具体原因和复检建议",
    });
  }
  if (value.conclusion === "passed" && value.failureDetails) {
    context.addIssue({
      code: "custom",
      path: ["failureDetails"],
      message: "年检通过时不能填写不合格详情",
    });
  }
});

type ActorType = "owner" | "operator" | "driver" | "external_system" | "system";

function validationFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(body);
  if (!result.success) {
    reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "提交的信息有误，请检查后重试",
        fields: validationFields(result.error),
      },
    });
    return undefined;
  }
  return result.data;
}

function deriveInspectionDueDate(registrationDate: string): string {
  const [, month, day] = registrationDate.split("-").map(Number);
  const currentYear = Number(todayIso().slice(0, 4));
  let due = new Date(`${currentYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00+08:00`);
  if (toIsoDate(due) < todayIso()) {
    due = new Date(`${currentYear + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00+08:00`);
  }
  return toIsoDate(due);
}

function endOfMonthIso(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
}

function inspectionValidityFromRow(row: Row) {
  const source = String(row.inspection_due_date_source ?? "legacy_unverified");
  const confirmedAt = row.inspection_due_date_confirmed_at == null
    ? null
    : String(row.inspection_due_date_confirmed_at);
  if (
    confirmedAt
    && (
      ["traffic_12123", "electronic_driving_license", "paper_driving_license"].includes(source)
      || internalDemoEligibilityOverride(row)
    )
  ) {
    return {
      mode: "confirmed" as const,
      validThroughMonth: String(row.inspection_due_date).slice(0, 7),
      source: source as z.infer<typeof inspectionValiditySourceSchema>,
      confirmedAt,
      ...(source === "internal_placeholder" ? { demoOnly: true as const } : {}),
    };
  }
  return { mode: "unconfirmed" as const };
}

function internalDemoEligibilityOverride(row: Row): boolean {
  return process.env.NODE_ENV === "test"
    && process.env.ALLOW_DEMO_WORKFLOW === "true"
    && process.env.ALLOW_DEMO_ELIGIBILITY_OVERRIDE === "true"
    && String(row.inspection_due_date_source ?? "") === "internal_placeholder"
    && row.inspection_due_date_confirmed_at != null;
}

function createInspectionDueDateState(
  body: z.infer<typeof createVehicleSchema>,
  confirmedAt: string,
) {
  if (body.inspectionValidity?.mode === "confirmed") {
    return {
      dueDate: endOfMonthIso(body.inspectionValidity.validThroughMonth),
      source: body.inspectionValidity.source,
      confirmedAt,
    };
  }
  if (body.inspectionDueDate) {
    return { dueDate: body.inspectionDueDate, source: "legacy_unverified", confirmedAt: null };
  }
  return {
    dueDate: deriveInspectionDueDate(body.registrationDate),
    source: "internal_placeholder",
    confirmedAt: null,
  };
}

function updateInspectionDueDateState(
  body: z.infer<typeof updateVehicleSchema>,
  current: Row,
  registrationDate: string,
  confirmedAt: string,
) {
  if (body.inspectionValidity?.mode === "confirmed") {
    const dueDate = endOfMonthIso(body.inspectionValidity.validThroughMonth);
    const source = body.inspectionValidity.source;
    const currentSource = String(current.inspection_due_date_source ?? "legacy_unverified");
    const currentConfirmedAt = current.inspection_due_date_confirmed_at == null
      ? null
      : String(current.inspection_due_date_confirmed_at);
    const confirmationUnchanged = dueDate === String(current.inspection_due_date)
      && source === currentSource
      && currentConfirmedAt !== null;
    return {
      dueDate,
      source,
      // Re-saving unrelated vehicle fields is not a new user verification.
      // Preserve the original audit timestamp unless the month or source changed.
      confirmedAt: confirmationUnchanged ? currentConfirmedAt : confirmedAt,
    };
  }
  if (body.inspectionValidity?.mode === "unconfirmed") {
    return body.inspectionDueDate
      ? { dueDate: body.inspectionDueDate, source: "legacy_unverified", confirmedAt: null }
      : { dueDate: deriveInspectionDueDate(registrationDate), source: "internal_placeholder", confirmedAt: null };
  }
  if (body.inspectionDueDate) {
    return { dueDate: body.inspectionDueDate, source: "legacy_unverified", confirmedAt: null };
  }
  const currentSource = String(current.inspection_due_date_source ?? "legacy_unverified");
  const registrationChanged = body.registrationDate !== undefined
    && body.registrationDate !== String(current.registration_date);
  if (registrationChanged && !["traffic_12123", "electronic_driving_license", "paper_driving_license"].includes(currentSource)) {
    return { dueDate: deriveInspectionDueDate(registrationDate), source: "internal_placeholder", confirmedAt: null };
  }
  return {
    dueDate: String(current.inspection_due_date),
    source: currentSource,
    confirmedAt: current.inspection_due_date_confirmed_at == null
      ? null
      : String(current.inspection_due_date_confirmed_at),
  };
}

function assertVehicleDates(registrationDate: string, inspectionDueDate: string): void {
  if (registrationDate > todayIso()) {
    throw new ApiProblem(400, "FUTURE_REGISTRATION_DATE", "车辆注册日期不能晚于今天", {
      registrationDate: "请选择今天或更早的日期",
    });
  }
  if (inspectionDueDate < registrationDate) {
    throw new ApiProblem(400, "INVALID_INSPECTION_DUE_DATE", "年检到期日不能早于注册日期", {
      inspectionDueDate: "请选择注册日期之后的日期",
    });
  }
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

type VehiclePriceCategory = z.infer<typeof vehiclePriceCategorySchema>;

type PowertrainType = InspectionPowertrainType;
const QUOTE_SNAPSHOT_VERSION = "quote-v1";
const VEHICLE_FACTS_VERSION = "vehicle-facts-v2-explicit-category";
const INSPECTION_ITEM_PRICING_MODE = "allocated_from_bundle_not_standalone_price";

const inspectionItemNames: Record<z.infer<typeof inspectionItemSchema>, string> = {
  safety_basic: "安全技术基础检测",
  safety_chassis_extended: "底盘安全扩展检测",
  emissions_gasoline: "汽油车尾气检测",
  emissions_diesel: "柴油车尾气检测",
  new_energy_safety: "新能源汽车安全检测",
  reinspection: "复检",
};
type MapErrorCode =
  | "TENCENT_KEY_MISSING"
  | "TENCENT_UNAUTHORIZED"
  | "TENCENT_QUOTA_EXCEEDED"
  | "TENCENT_TIMEOUT"
  | "TENCENT_UNAVAILABLE";

type MapRuntimeState = {
  status: "missing" | "configured" | "ready" | "unauthorized" | "quota_exceeded" | "timeout" | "unavailable";
  lastErrorCode: MapErrorCode | null;
  lastCheckedAt: string | null;
};

function jsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function jsonObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>
      : [];
  } catch {
    return [];
  }
}

function vehiclePlateCategory(row: Row) {
  return plateCategory(row.plate_category) ?? legacyPlateCategory(String(row.vehicle_type), String(row.plate_normalized), row.vehicle_class_code == null ? null : String(row.vehicle_class_code));
}

function assertVehicleSeatCount(seats: number, categoryCode: unknown) {
  if (seats === 0 && plateCategory(categoryCode)?.vehicleClassCode !== "trailer") {
    throw new ApiProblem(400, "VALIDATION_ERROR", "请填写实际核定座位数", { seats: "只有挂车可以填写 0 座" });
  }
}

function deriveVehicleFacts(row: Row) {
  const parsed = parsePlate(String(row.plate_number));
  const configuredPowertrain = powertrainTypeSchema.safeParse(row.powertrain_type);
  const factsConsistencyFailures: string[] = [];
  let powertrainType: PowertrainType;
  let powertrainSource: InspectionFactSource;
  if (configuredPowertrain.success) {
    powertrainType = configuredPowertrain.data;
    powertrainSource = "vehicle_profile";
  } else if (plateCategory(row.plate_category) || (parsed.valid && parsed.normalized.length === 8)) {
    powertrainType = "unknown";
    powertrainSource = "unknown";
  } else if (String(row.vehicle_type).includes("柴油")) {
    powertrainType = "diesel";
    powertrainSource = "vehicle_profile";
  } else {
    // Preserve legacy quote compatibility while marking the weak fallback as
    // unknown evidence. A conventional plate cannot distinguish gasoline,
    // diesel, or non-plug-in hybrid powertrains.
    powertrainType = "gasoline";
    powertrainSource = "unknown";
  }
  const category = vehiclePlateCategory(row);
  const explicitCategory = plateCategory(row.plate_category);
  const vehicleType = String(row.vehicle_type);
  const vehicleTypeSaysVan = vehicleType.includes("面包");
  const configuredIsVan = row.is_van == null ? null : bool(row.is_van);
  if (vehicleTypeSaysVan && configuredIsVan === false) {
    factsConsistencyFailures.push("vehicle_type_van_conflict");
  }
  const isVan = vehicleTypeSaysVan || configuredIsVan === true;
  const vehicleTypeSaysCargo = /货车|货运|卡车/.test(vehicleType);
  const configuredVehicleClass = row.vehicle_class_code == null ? null : String(row.vehicle_class_code);
  if (!explicitCategory && vehicleTypeSaysCargo && configuredVehicleClass === "passenger_car") {
    factsConsistencyFailures.push("vehicle_type_class_conflict");
  }
  const vehicleClassCode = explicitCategory?.vehicleClassCode ?? (vehicleTypeSaysCargo || isVan
    ? "other"
    : configuredVehicleClass ?? "passenger_car");
  return {
    vehicleId: String(row.id),
    plateNumber: String(row.plate_number),
    plateNormalized: String(row.plate_normalized),
    plateCategory: category?.code ?? null,
    vehicleType,
    powertrainType,
    powertrainSource,
    seats: Number(row.seats),
    usageNature: String(row.usage_nature),
    vehicleClassCode,
    isVan,
    registrationDate: String(row.registration_date),
    inspectionDueDate: String(row.inspection_due_date),
    inspectionDueDateSource: String(row.inspection_due_date_source ?? "legacy_unverified"),
    inspectionDueDateConfirmedAt: row.inspection_due_date_confirmed_at == null
      ? null
      : String(row.inspection_due_date_confirmed_at),
    factsConsistencyFailures,
  };
}

function inspectionFactsFromVehicleRow(row: Row): InspectionVehicleFacts {
  const facts = deriveVehicleFacts(row);
  const vehicleTypeIsOutOfScope = /大型客车|中型客车|货车|货运|卡车|摩托|专项|挂车/.test(facts.vehicleType);
  const vehicleClass = !vehicleTypeIsOutOfScope && ["passenger_car", "small_micro_passenger"].includes(facts.vehicleClassCode)
    ? "small_micro_passenger"
    : facts.vehicleClassCode
      ? "other"
      : "unknown";
  const normalizedUsageNature = facts.usageNature.trim();
  const usageNature = ["非营运", "non_operational"].includes(normalizedUsageNature)
    ? "non_operational"
    : normalizedUsageNature
      ? "operational"
      : "unknown";
  return {
    registrationMonth: facts.registrationDate.slice(0, 7),
    vehicleClass,
    usageNature,
    seats: Number.isInteger(facts.seats) && facts.seats > 0 ? facts.seats : null,
    knownIsVan: facts.isVan,
    powertrainType: facts.powertrainType,
    powertrainSource: facts.powertrainSource,
  };
}

function assertNoConfirmedInspectionDateConflict(row: Row): void {
  if (internalDemoEligibilityOverride(row)) return;
  const inspectionValidity = inspectionValidityFromRow(row);
  if (inspectionValidity.mode !== "confirmed") return;
  const calculation = calculateInspection({
    source: "vehicle",
    asOfDate: todayIso(),
    vehicle: inspectionFactsFromVehicleRow(row),
    declarations: {
      isVan: "no",
      hasInjuryAccident: "no",
      hasIllegalModificationPenalty: "no",
      convertedFromOperational: "no",
      delayedFirstRegistrationOver4Years: "no",
    },
    inspectionValidity,
  });
  // 仅硬冲突挡报价/下单：确认日早于登记月等非法组合。
  // 规则申领节点与确认上线月不一致属于软提示（comparison=note），不 409。
  if (calculation.dateEvidence.comparison === "conflict") {
    throw new ApiProblem(
      409,
      "INSPECTION_VALIDITY_CONFLICT",
      "用户确认的检验有效期与登记信息不一致，请先通过交管12123或客服核验",
    );
  }
  const confirmedExpired = calculation.reasons.some((reason) => reason.code === "confirmed_validity_expired");
  if (confirmedExpired) {
    throw new ApiProblem(
      409,
      "INSPECTION_VALIDITY_EXPIRED",
      "用户确认的检验有效期已过，请先通过交管12123核验后再预约",
    );
  }
}

function vehicleFactsFingerprint(row: Row) {
  const facts = deriveVehicleFacts(row);
  return {
    facts,
    version: VEHICLE_FACTS_VERSION,
    hash: inspectionResultRequestHash({ version: VEHICLE_FACTS_VERSION, facts }),
  };
}

function inspectionItemAmounts(items: string[], totalFen: number) {
  if (items.length === 0) return [];
  const baseFen = Math.floor(totalFen / items.length);
  const remainderFen = totalFen % items.length;
  return items.map((code, index) => ({
    code,
    name: inspectionItemNames[code as keyof typeof inspectionItemNames] ?? code,
    amountFen: baseFen + (index < remainderFen ? 1 : 0),
    pricingBasis: "allocated_from_bundle" as const,
    isStandaloneCharge: false as const,
  }));
}

function inspectionItemsForPowertrain(items: string[], powertrainType: PowertrainType) {
  return expectedOnsiteChecksForPowertrain(powertrainType, items);
}

function pricePlanCategories(row: Row): string[] {
  if (row.plate_categories_json != null) return jsonArray(row.plate_categories_json);
  return PLATE_CATEGORIES.filter((item) => item.vehicleClassCode === "passenger_car"
    && jsonArray(row.vehicle_class_codes_json).includes("passenger_car")).map((item) => item.code);
}

function inspectionPricePlanFromRow(row: Row) {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: String(row.description),
    powertrainTypes: jsonArray(row.powertrain_types_json).map((value) => normalizeInspectionPowertrainType(value)) as PowertrainType[],
    minSeats: Number(row.min_seats),
    maxSeats: Number(row.max_seats),
    usageNatures: jsonArray(row.usage_natures_json),
    vehicleClassCodes: jsonArray(row.vehicle_class_codes_json),
    plateCategories: pricePlanCategories(row),
    excludeVans: bool(row.exclude_vans),
    inspectionItems: jsonArray(row.inspection_items_json),
    sortOrder: Number(row.sort_order),
    isActive: bool(row.is_active),
    createdAt: row.created_at == null ? null : String(row.created_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  };
}

async function resolveInspectionPricing(database: AppDatabase, vehicle: Row, station: Row) {
  const facts = deriveVehicleFacts(vehicle);
  const explicitCategory = plateCategory(vehicle.plate_category);
  const hardGuardFailures = explicitCategory ? [
    ...facts.factsConsistencyFailures,
    ...(facts.seats >= (explicitCategory.vehicleClassCode === "trailer" ? 0 : 1) && facts.seats <= 99 ? [] : ["seat_count_out_of_range"]),
  ] : [
    ...facts.factsConsistencyFailures,
    ...(facts.usageNature === "非营运" ? [] : ["usage_nature_not_non_operational"]),
    ...(facts.seats >= 1 && facts.seats <= 9 ? [] : ["seat_count_out_of_range"]),
    ...(!facts.isVan ? [] : ["van_not_auto_priced"]),
    ...(facts.vehicleClassCode === "passenger_car" ? [] : ["vehicle_class_not_passenger_car"]),
  ];
  if (hardGuardFailures.length > 0) {
    return {
      facts,
      eligibility: "manual_review" as const,
      reason: "outside_auto_pricing_scope" as const,
      hardGuardFailures,
      plan: null,
      inspectionItems: [] as string[],
      inspectionFeeFen: 0,
    };
  }
  const rows = await database.prepare<Row>(`
    SELECT p.*, sp.price_fen, sp.is_supported, sp.updated_at AS station_price_updated_at
    FROM inspection_price_plans p
    JOIN station_inspection_price_plans sp ON sp.plan_id = p.id
    WHERE sp.station_id = ? AND p.is_active = 1 AND sp.is_supported = 1
    ORDER BY p.sort_order, p.id
  `).all(String(station.id));
  const matches = rows.filter((row) => {
    const plan = inspectionPricePlanFromRow(row);
    return facts.plateCategory !== null && plan.plateCategories.includes(facts.plateCategory)
      && plan.powertrainTypes.includes(facts.powertrainType)
      && facts.seats >= plan.minSeats
      && facts.seats <= plan.maxSeats
      && plan.usageNatures.includes(facts.usageNature)
      && plan.vehicleClassCodes.includes(facts.vehicleClassCode)
      && !(plan.excludeVans && facts.isVan);
  });
  if (matches.length !== 1) {
    return {
      facts,
      eligibility: "manual_review" as const,
      reason: matches.length === 0 ? "no_matching_price_plan" as const : "ambiguous_price_plan" as const,
      hardGuardFailures: [] as string[],
      plan: null,
      inspectionItems: [] as string[],
      inspectionFeeFen: 0,
    };
  }
  const row = matches[0]!;
  const configuredPriceFen = Number(row.price_fen);
  if (!Number.isInteger(configuredPriceFen) || configuredPriceFen <= 0) {
    return {
      facts,
      eligibility: "manual_review" as const,
      reason: "invalid_price_plan_amount" as const,
      hardGuardFailures: ["non_positive_price"] as string[],
      plan: null,
      inspectionItems: [] as string[],
      inspectionFeeFen: 0,
    };
  }
  const planDefinition = inspectionPricePlanFromRow(row);
  const planWithoutVersion = {
    ...planDefinition,
    priceFen: configuredPriceFen,
    stationPriceUpdatedAt: String(row.station_price_updated_at),
  };
  const plan = {
    ...planWithoutVersion,
    version: inspectionResultRequestHash(planWithoutVersion),
  };
  const inspectionItems = inspectionItemsForPowertrain(plan.inspectionItems, facts.powertrainType);
  return {
    facts,
    eligibility: "supported" as const,
    hardGuardFailures: [] as string[],
    plan,
    inspectionItems,
    inspectionFeeFen: configuredPriceFen,
  };
}

function vehiclePriceCategory(row: Row): VehiclePriceCategory {
  if (Number(row.seats) >= 7) return "seven_seat";
  return vehiclePlateCategory(row)?.code.startsWith("new_energy_") ? "new_energy_small" : "fuel_small";
}

function haversineKm(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = radians(toLat - fromLat);
  const dLng = radians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type RouteOrigin = {
  latitude: number;
  longitude: number;
  type: "self_drive" | "valet";
};

type RouteMetric = {
  distanceKm: number | null;
  driveMinutes: number | null;
  distanceBasis: "driving_route" | "estimated_distance" | "no_origin";
  distanceSource: "tencent_matrix" | "estimated" | "not_calculated";
  mapErrorCode?: MapErrorCode;
};

function noOriginRouteMetric(): RouteMetric {
  return {
    distanceKm: null,
    driveMinutes: null,
    distanceBasis: "no_origin",
    distanceSource: "not_calculated",
  };
}

function normalizedOriginType(value: z.infer<typeof originTypeSchema>): RouteOrigin["type"] {
  return value === "valet" || value === "pickup_address" ? "valet" : "self_drive";
}

function routeOriginFromPickup(pickup: z.infer<typeof pickupAddressSchema>): RouteOrigin {
  return {
    latitude: pickup.latitude,
    longitude: pickup.longitude,
    type: "valet",
  };
}

function routeOriginFromQuote(body: z.infer<typeof quoteRequestSchema>): RouteOrigin | undefined {
  if (body.originLat === undefined || body.originLng === undefined || !body.originType) return undefined;
  return {
    latitude: body.originLat,
    longitude: body.originLng,
    type: normalizedOriginType(body.originType),
  };
}

function routeOriginFromStationQuery(query: unknown): RouteOrigin | undefined {
  const parsed = stationOriginQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiProblem(400, "INVALID_ORIGIN", "起点信息有误，请重新定位或选择地址", validationFields(parsed.error));
  }
  if (parsed.data.originLat === undefined || parsed.data.originLng === undefined || !parsed.data.originType) return undefined;
  return {
    latitude: parsed.data.originLat,
    longitude: parsed.data.originLng,
    type: normalizedOriginType(parsed.data.originType),
  };
}

function estimatedRouteMetric(origin: RouteOrigin, station: Row): RouteMetric {
  const direct = haversineKm(origin.latitude, origin.longitude, Number(station.latitude), Number(station.longitude));
  const distanceKm = Math.max(0.1, Math.ceil(direct * 1.25 * 10) / 10);
  return {
    distanceKm,
    driveMinutes: Math.max(1, Math.ceil((distanceKm / 25) * 60)),
    distanceBasis: "estimated_distance",
    distanceSource: "estimated",
  };
}

/**
 * Uses one Tencent driving-distance matrix for all available stations. If the
 * map service is unavailable, a local straight-line-based estimate remains
 * explicitly labelled as an estimate; it is never presented as a route.
 */
function mapFailureCode(providerStatus?: number, httpStatus?: number, error?: unknown): MapErrorCode {
  if (providerStatus === 121) return "TENCENT_QUOTA_EXCEEDED";
  if ([110, 111, 112, 120].includes(Number(providerStatus)) || httpStatus === 401 || httpStatus === 403) {
    return "TENCENT_UNAUTHORIZED";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "TENCENT_TIMEOUT";
  return "TENCENT_UNAVAILABLE";
}

function updateMapRuntime(state: MapRuntimeState | undefined, errorCode: MapErrorCode | null): void {
  if (!state) return;
  state.lastCheckedAt = new Date().toISOString();
  state.lastErrorCode = errorCode;
  state.status = errorCode === null
    ? "ready"
    : errorCode === "TENCENT_KEY_MISSING"
      ? "missing"
      : errorCode === "TENCENT_UNAUTHORIZED"
        ? "unauthorized"
        : errorCode === "TENCENT_QUOTA_EXCEEDED"
          ? "quota_exceeded"
          : errorCode === "TENCENT_TIMEOUT"
            ? "timeout"
            : "unavailable";
}

function tencentMapTimeoutMs(): number {
  const configured = Number(process.env.TENCENT_MAP_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return 15_000;
  return Math.min(30_000, Math.max(5_000, Math.round(configured)));
}

type ResolvedMapLocation = {
  poiId: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  source: "tencent" | "demo";
};

type TencentLocationResolution =
  | { location: ResolvedMapLocation; errorCode: null; outsideTianjin: false }
  | { location: null; errorCode: MapErrorCode; outsideTianjin: false }
  | { location: null; errorCode: null; outsideTianjin: true };

function providerText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

async function resolveTencentCoordinate(
  input: LocationResolveInput,
  key: string,
  mapRuntime?: MapRuntimeState,
): Promise<TencentLocationResolution> {
  try {
    const parameters = new URLSearchParams({
      location: `${input.latitude},${input.longitude}`,
      get_poi: "1",
      key,
    });
    const response = await fetch(`https://apis.map.qq.com/ws/geocoder/v1/?${parameters}`, {
      signal: AbortSignal.timeout(tencentMapTimeoutMs()),
    });
    const payload = (await response.json()) as {
      status?: number;
      result?: {
        address?: string;
        location?: { lat?: number; lng?: number };
        formatted_addresses?: { recommend?: string; rough?: string };
        address_component?: {
          province?: string;
          city?: string;
          district?: string;
          street?: string;
          street_number?: string;
        };
        ad_info?: { adcode?: string; name?: string };
        pois?: Array<{ id?: string; title?: string; address?: string }>;
        address_reference?: { landmark_l2?: { title?: string } };
      };
    };
    if (payload.status !== 0 || !payload.result) {
      const errorCode = mapFailureCode(payload.status, response.status);
      updateMapRuntime(mapRuntime, errorCode);
      return { location: null, errorCode, outsideTianjin: false };
    }

    const result = payload.result;
    const province = providerText(result.address_component?.province, 40) ?? "";
    const city = providerText(result.address_component?.city, 40) ?? "";
    const adcode = providerText(result.ad_info?.adcode, 20) ?? "";
    const isTianjin = province.includes("天津") || city.includes("天津") || adcode.startsWith("12");
    if (!isTianjin) {
      updateMapRuntime(mapRuntime, null);
      return { location: null, errorCode: null, outsideTianjin: true };
    }

    const address = providerText(result.address, 240)
      ?? providerText(result.formatted_addresses?.rough, 240);
    const title = providerText(result.pois?.[0]?.title, 120)
      ?? providerText(result.formatted_addresses?.recommend, 120)
      ?? providerText(result.address_reference?.landmark_l2?.title, 120)
      ?? address;
    const district = providerText(result.address_component?.district, 40)
      ?? providerText(result.ad_info?.name, 40)
      ?? "天津市";
    if (!address || !title) {
      updateMapRuntime(mapRuntime, "TENCENT_UNAVAILABLE");
      return { location: null, errorCode: "TENCENT_UNAVAILABLE", outsideTianjin: false };
    }
    const poiId = providerText(result.pois?.[0]?.id, 160)
      ?? `tencent-geocoder-${adcode || "tianjin"}-${input.latitude.toFixed(6)}-${input.longitude.toFixed(6)}`;
    updateMapRuntime(mapRuntime, null);
    return {
      location: {
        poiId,
        title,
        address,
        district,
        // The official reverse-geocoder resolved these exact client-selected
        // coordinates. Keep them stable instead of silently moving the pin to
        // a nearby POI returned in the response.
        latitude: input.latitude,
        longitude: input.longitude,
        source: "tencent",
      },
      errorCode: null,
      outsideTianjin: false,
    };
  } catch (error) {
    const errorCode = mapFailureCode(undefined, undefined, error);
    updateMapRuntime(mapRuntime, errorCode);
    return { location: null, errorCode, outsideTianjin: false };
  }
}

function demoCoordinateResolution(input: LocationResolveInput): ResolvedMapLocation {
  const address = input.address?.trim()
    || `天津市坐标 ${input.latitude.toFixed(6)}, ${input.longitude.toFixed(6)}（演示）`;
  const district = [
    "和平区", "河东区", "河西区", "南开区", "河北区", "红桥区",
    "东丽区", "西青区", "津南区", "北辰区", "武清区", "宝坻区",
    "滨海新区", "宁河区", "静海区", "蓟州区",
  ].find((candidate) => address.includes(candidate)) ?? "天津市";
  return {
    poiId: `demo-map-${input.latitude.toFixed(6)}-${input.longitude.toFixed(6)}`,
    title: input.name?.trim() || "地图选点（演示）",
    address,
    district,
    latitude: input.latitude,
    longitude: input.longitude,
    source: "demo",
  };
}

async function calculateRouteMetrics(
  origin: RouteOrigin | undefined,
  stations: Row[],
  mapRuntime?: MapRuntimeState,
): Promise<RouteMetric[]> {
  if (!origin) return stations.map(noOriginRouteMetric);
  const key = process.env.TENCENT_MAP_KEY?.trim();
  let failureCode: MapErrorCode = "TENCENT_KEY_MISSING";
  if (key && stations.length > 0) {
    try {
      const parameters = new URLSearchParams({
        mode: "driving",
        from: `${origin.latitude},${origin.longitude}`,
        to: stations.map((station) => `${Number(station.latitude)},${Number(station.longitude)}`).join(";"),
        key,
      });
      const response = await fetch(`https://apis.map.qq.com/ws/distance/v1/matrix/?${parameters}`, {
        signal: AbortSignal.timeout(tencentMapTimeoutMs()),
      });
      const payload = (await response.json()) as {
        status?: number;
        message?: string;
        result?: {
          rows?: Array<{ elements?: Array<{ distance?: number; duration?: number }> }>;
          elements?: Array<{ distance?: number; duration?: number }>;
        };
      };
      const elements = payload.result?.rows?.[0]?.elements ?? payload.result?.elements;
      if (payload.status === 0 && elements?.length === stations.length) {
        const metrics: Array<RouteMetric | undefined> = elements.map((element) => {
          const meters = Number(element.distance);
          const seconds = Number(element.duration);
          if (!Number.isFinite(meters) || meters < 0 || !Number.isFinite(seconds) || seconds < 0) return undefined;
          return {
            distanceKm: Math.ceil((meters / 1000) * 10) / 10,
            driveMinutes: Math.ceil(seconds / 60),
            distanceBasis: "driving_route" as const,
            distanceSource: "tencent_matrix" as const,
          };
        });
        if (metrics.every((metric): metric is RouteMetric => metric !== undefined)) {
          updateMapRuntime(mapRuntime, null);
          return metrics;
        }
      }
      failureCode = mapFailureCode(payload.status, response.status);
    } catch (error) {
      failureCode = mapFailureCode(undefined, undefined, error);
      // Fall through to a clearly labelled estimate so a transient provider
      // outage cannot masquerade as a successful route calculation.
    }
  }
  updateMapRuntime(mapRuntime, failureCode);
  return stations.map((station) => ({ ...estimatedRouteMetric(origin, station), mapErrorCode: failureCode }));
}

async function resolvedValetRule(database: AppDatabase, stationId: string) {
  const override = await database.prepare<Row>(`
    SELECT * FROM station_valet_pricing_overrides WHERE station_id = ?
  `).get(stationId);
  if (override) {
    const rule = {
      scope: "station" as const,
      stationId,
      baseFeeFen: Number(override.base_fee_fen),
      includedKm: Number(override.included_km),
      perKmFen: Number(override.per_km_fen),
      maxRadiusKm: override.max_radius_km == null ? null : Number(override.max_radius_km),
      updatedAt: String(override.updated_at),
    };
    return { ...rule, version: inspectionResultRequestHash(rule) };
  }
  const rule = await database
    .prepare<Row>("SELECT * FROM valet_pricing_rules WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1")
    .get();
  if (!rule) throw new ApiProblem(409, "VALET_RULE_MISSING", "代驾计价规则尚未配置");
  const resolved = {
    scope: "global" as const,
    stationId: null,
    baseFeeFen: Number(rule.base_fee_fen),
    includedKm: Number(rule.included_km),
    perKmFen: Number(rule.per_km_fen),
    maxRadiusKm: rule.max_radius_km_limit == null ? null : Number(rule.max_radius_km_limit),
    updatedAt: String(rule.updated_at),
  };
  return { ...resolved, version: inspectionResultRequestHash(resolved) };
}

async function calculateQuote(
  database: AppDatabase,
  vehicle: Row,
  station: Row,
  serviceMode: z.infer<typeof serviceModeSchema>,
  pickup?: z.infer<typeof pickupAddressSchema>,
  origin?: RouteOrigin,
  tripType: z.infer<typeof valetTripTypeSchema> = "round_trip_same_address",
  mapRuntime?: MapRuntimeState,
) {
  const category = vehiclePriceCategory(vehicle);
  const inspectionPricing = await resolveInspectionPricing(database, vehicle, station);
  const inspectionFeeFen = inspectionPricing.inspectionFeeFen;
  const fingerprint = vehicleFactsFingerprint(vehicle);
  const frozenContext = {
    snapshotVersion: QUOTE_SNAPSHOT_VERSION,
    vehicleFactsVersion: fingerprint.version,
    vehicleFactsHash: fingerprint.hash,
    vehicleSnapshot: vehicleFromRow(vehicle),
    stationSnapshot: stationFromRow(station),
    inspectionItemPricingMode: INSPECTION_ITEM_PRICING_MODE,
    inspectionItemAmounts: inspectionItemAmounts(inspectionPricing.inspectionItems, inspectionFeeFen),
  };
  const routeOrigin = serviceMode === "valet" && pickup ? routeOriginFromPickup(pickup) : origin;
  const [route] = await calculateRouteMetrics(routeOrigin, [station], mapRuntime);
  if (inspectionPricing.eligibility === "manual_review") {
    return {
      serviceMode,
      tripType: serviceMode === "valet" ? tripType : null,
      serviceScope: serviceMode === "valet" ? tripType : null,
      vehiclePriceCategory: category,
      vehicleFacts: inspectionPricing.facts,
      ...frozenContext,
      pricingEligibility: inspectionPricing.eligibility,
      pricingReason: inspectionPricing.reason,
      hardGuardFailures: inspectionPricing.hardGuardFailures,
      matchedPricePlan: null,
      inspectionItems: [],
      inspectionFeeFen: 0,
      valetFeeFen: 0,
      serviceFeeFen: 0,
      distanceKm: route.distanceKm,
      oneWayDistanceKm: route.distanceKm,
      roundTripDistanceKm: route.distanceKm == null ? null : Math.ceil(route.distanceKm * 2 * 10) / 10,
      billableDistanceKm: route.distanceKm,
      extraKm: 0,
      driveMinutes: route.driveMinutes,
      distanceBasis: route.distanceBasis,
      serviceable: false,
      distanceSource: route.distanceSource,
      reason: "manual_review" as const,
      breakdown: { inspectionFeeFen: 0, valetBaseFeeFen: 0, valetDistanceFeeFen: 0, valetFeeFen: 0, totalFeeFen: 0 },
    };
  }
  if (serviceMode === "self_drive") {
    return {
      serviceMode,
      tripType: null,
      serviceScope: null,
      vehiclePriceCategory: category,
      vehicleFacts: inspectionPricing.facts,
      ...frozenContext,
      pricingEligibility: inspectionPricing.eligibility,
      hardGuardFailures: inspectionPricing.hardGuardFailures,
      matchedPricePlan: inspectionPricing.plan,
      inspectionItems: inspectionPricing.inspectionItems,
      inspectionFeeFen,
      valetFeeFen: 0,
      serviceFeeFen: inspectionFeeFen,
      distanceKm: route.distanceKm,
      driveMinutes: route.driveMinutes,
      distanceBasis: route.distanceBasis,
      serviceable: true,
      distanceSource: route.distanceSource,
      oneWayDistanceKm: route.distanceKm,
      roundTripDistanceKm: null,
      billableDistanceKm: null,
      extraKm: 0,
      breakdown: { inspectionFeeFen, valetBaseFeeFen: 0, valetDistanceFeeFen: 0, valetFeeFen: 0, totalFeeFen: inspectionFeeFen },
    };
  }
  const rule = await resolvedValetRule(database, String(station.id));
  if (route.distanceKm === null) {
    return {
      serviceMode,
      tripType,
      serviceScope: tripType,
      vehiclePriceCategory: category,
      vehicleFacts: inspectionPricing.facts,
      ...frozenContext,
      pricingEligibility: inspectionPricing.eligibility,
      hardGuardFailures: inspectionPricing.hardGuardFailures,
      matchedPricePlan: inspectionPricing.plan,
      inspectionItems: inspectionPricing.inspectionItems,
      inspectionFeeFen,
      valetFeeFen: 0,
      serviceFeeFen: inspectionFeeFen,
      distanceKm: null,
      driveMinutes: null,
      distanceBasis: route.distanceBasis,
      distanceSource: route.distanceSource,
      serviceable: false,
      reason: "origin_required" as const,
      rule,
      oneWayDistanceKm: null,
      roundTripDistanceKm: null,
      billableDistanceKm: null,
      extraKm: 0,
      breakdown: { inspectionFeeFen, valetBaseFeeFen: 0, valetDistanceFeeFen: 0, valetFeeFen: 0, totalFeeFen: inspectionFeeFen },
    };
  }
  if (route.distanceSource !== "tencent_matrix") {
    throw new ApiProblem(503, "REAL_ROUTE_REQUIRED", "上门取送必须使用腾讯真实驾车路线，当前暂不能报价", {
      mapErrorCode: route.mapErrorCode ?? "TENCENT_UNAVAILABLE",
    });
  }
  const serviceable = rule.maxRadiusKm === null || route.distanceKm <= rule.maxRadiusKm;
  const extraKm = Math.max(0, Math.ceil(route.distanceKm - rule.includedKm));
  const valetDistanceFeeFen = extraKm * rule.perKmFen;
  const valetFeeFen = rule.baseFeeFen + valetDistanceFeeFen;
  return {
    serviceMode,
    tripType,
    serviceScope: tripType,
    vehiclePriceCategory: category,
    vehicleFacts: inspectionPricing.facts,
    ...frozenContext,
    pricingEligibility: inspectionPricing.eligibility,
    hardGuardFailures: inspectionPricing.hardGuardFailures,
    matchedPricePlan: inspectionPricing.plan,
    inspectionItems: inspectionPricing.inspectionItems,
    inspectionFeeFen,
    valetFeeFen,
    serviceFeeFen: inspectionFeeFen + valetFeeFen,
    distanceKm: route.distanceKm,
    driveMinutes: route.driveMinutes,
    distanceBasis: route.distanceBasis,
    serviceable,
    distanceSource: route.distanceSource,
    oneWayDistanceKm: route.distanceKm,
    roundTripDistanceKm: Math.ceil(route.distanceKm * 2 * 10) / 10,
    billableDistanceKm: route.distanceKm,
    extraKm,
    rule,
    breakdown: {
      inspectionFeeFen,
      valetBaseFeeFen: rule.baseFeeFen,
      valetDistanceFeeFen,
      valetFeeFen,
      totalFeeFen: inspectionFeeFen + valetFeeFen,
    },
  };
}

async function persistQuoteSnapshot(
  database: AppDatabase,
  userId: string,
  vehicleId: string,
  stationId: string,
  quote: Awaited<ReturnType<typeof calculateQuote>>,
  pickupAddress?: z.infer<typeof pickupAddressSchema>,
) {
  const id = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60_000).toISOString();
  const rule = "rule" in quote ? quote.rule : undefined;
  await database.prepare(`
    INSERT INTO quote_snapshots (
      id, user_id, vehicle_id, station_id, service_mode, trip_type,
      vehicle_facts_json, price_plan_id, pricing_eligibility, inspection_items_json,
      inspection_fee_fen, valet_base_fee_fen, valet_distance_fee_fen,
      valet_fee_fen, service_fee_fen, one_way_distance_km, round_trip_distance_km,
      billable_distance_km, extra_km, distance_source, distance_basis, drive_minutes,
      rule_scope, rule_station_id, rule_base_fee_fen, rule_included_km,
      rule_per_km_fen, rule_max_radius_km, pickup_address_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    vehicleId,
    stationId,
    quote.serviceMode,
    quote.tripType,
    JSON.stringify(quote.vehicleFacts),
    quote.matchedPricePlan?.id ?? null,
    quote.pricingEligibility,
    JSON.stringify(quote.inspectionItems),
    quote.inspectionFeeFen,
    quote.breakdown.valetBaseFeeFen,
    quote.breakdown.valetDistanceFeeFen,
    quote.valetFeeFen,
    quote.serviceFeeFen,
    quote.oneWayDistanceKm,
    quote.roundTripDistanceKm,
    quote.billableDistanceKm,
    quote.extraKm,
    quote.distanceSource,
    quote.distanceBasis,
    quote.driveMinutes,
    rule?.scope ?? null,
    rule?.stationId ?? null,
    rule?.baseFeeFen ?? null,
    rule?.includedKm ?? null,
    rule?.perKmFen ?? null,
    rule?.maxRadiusKm ?? null,
    pickupAddress ? JSON.stringify(pickupAddress) : null,
    createdAt.toISOString(),
    expiresAt,
  );
  await database.prepare(`
    UPDATE quote_snapshots SET
      snapshot_version = ?, vehicle_snapshot_json = ?, vehicle_facts_version = ?,
      vehicle_facts_hash = ?, station_snapshot_json = ?, price_plan_snapshot_json = ?,
      inspection_item_amounts_json = ?, rule_snapshot_json = ?, rule_updated_at = ?,
      rule_version = ?
    WHERE id = ?
  `).run(
    quote.snapshotVersion,
    JSON.stringify(quote.vehicleSnapshot),
    quote.vehicleFactsVersion,
    quote.vehicleFactsHash,
    JSON.stringify(quote.stationSnapshot),
    quote.matchedPricePlan ? JSON.stringify(quote.matchedPricePlan) : null,
    JSON.stringify(quote.inspectionItemAmounts),
    rule ? JSON.stringify(rule) : null,
    rule?.updatedAt ?? null,
    rule?.version ?? null,
    id,
  );
  return { quoteSnapshotId: id, expiresAt };
}

type FrozenInspectionPricePlan = ReturnType<typeof inspectionPricePlanFromRow> & {
  priceFen?: number;
  stationPriceUpdatedAt?: string;
  version?: string;
};
type FrozenValetRule = Awaited<ReturnType<typeof resolvedValetRule>>;

async function quoteFromSnapshot(database: AppDatabase, row: Row) {
  const vehicleFacts = jsonObject(row.vehicle_facts_json) ?? {};
  const frozenPlan = jsonObject(row.price_plan_snapshot_json) as FrozenInspectionPricePlan | null;
  const planRow = !frozenPlan && row.price_plan_id != null
    ? await database.prepare<Row>("SELECT * FROM inspection_price_plans WHERE id = ?").get(String(row.price_plan_id))
    : undefined;
  const frozenRule = jsonObject(row.rule_snapshot_json) as FrozenValetRule | null;
  const rule = frozenRule ?? (row.rule_base_fee_fen == null
    ? undefined
    : {
        scope: String(row.rule_scope) as "global" | "station",
        stationId: row.rule_station_id == null ? null : String(row.rule_station_id),
        baseFeeFen: Number(row.rule_base_fee_fen),
        includedKm: Number(row.rule_included_km),
        perKmFen: Number(row.rule_per_km_fen),
        maxRadiusKm: row.rule_max_radius_km == null ? null : Number(row.rule_max_radius_km),
        updatedAt: row.rule_updated_at == null ? null : String(row.rule_updated_at),
        version: row.rule_version == null ? null : String(row.rule_version),
      });
  const seats = Number(vehicleFacts.seats ?? 0);
  const powertrainType = String(vehicleFacts.powertrainType ?? "other");
  const vehiclePriceCategory: VehiclePriceCategory = seats >= 7
    ? "seven_seat"
    : ["pure_electric", "phev", "erev"].includes(powertrainType)
      ? "new_energy_small"
      : "fuel_small";
  const oneWayDistanceKm = row.one_way_distance_km == null ? null : Number(row.one_way_distance_km);
  const pricingSupported = String(row.pricing_eligibility) === "supported";
  const serviceable = pricingSupported && (
    String(row.service_mode) === "self_drive"
    || (oneWayDistanceKm !== null && (rule?.maxRadiusKm == null || oneWayDistanceKm <= rule.maxRadiusKm))
  );
  return {
    serviceMode: String(row.service_mode) as z.infer<typeof serviceModeSchema>,
    tripType: row.trip_type == null ? null : String(row.trip_type) as z.infer<typeof valetTripTypeSchema>,
    vehiclePriceCategory,
    vehicleFacts,
    snapshotVersion: String(row.snapshot_version ?? QUOTE_SNAPSHOT_VERSION),
    vehicleFactsVersion: String(row.vehicle_facts_version ?? VEHICLE_FACTS_VERSION),
    vehicleFactsHash: row.vehicle_facts_hash == null ? null : String(row.vehicle_facts_hash),
    vehicleSnapshot: jsonObject(row.vehicle_snapshot_json),
    stationSnapshot: jsonObject(row.station_snapshot_json),
    pricingEligibility: String(row.pricing_eligibility) as "supported" | "manual_review",
    hardGuardFailures: [] as string[],
    matchedPricePlan: frozenPlan ?? (planRow ? inspectionPricePlanFromRow(planRow) : null),
    inspectionItems: jsonArray(row.inspection_items_json),
    inspectionItemPricingMode: INSPECTION_ITEM_PRICING_MODE,
    inspectionItemAmounts: jsonObjectArray(row.inspection_item_amounts_json),
    inspectionFeeFen: Number(row.inspection_fee_fen),
    valetFeeFen: Number(row.valet_fee_fen),
    serviceFeeFen: Number(row.service_fee_fen),
    distanceKm: oneWayDistanceKm,
    oneWayDistanceKm,
    roundTripDistanceKm: row.round_trip_distance_km == null ? null : Number(row.round_trip_distance_km),
    billableDistanceKm: row.billable_distance_km == null ? null : Number(row.billable_distance_km),
    extraKm: row.extra_km == null ? 0 : Number(row.extra_km),
    driveMinutes: row.drive_minutes == null ? null : Number(row.drive_minutes),
    distanceBasis: String(row.distance_basis) as RouteMetric["distanceBasis"],
    distanceSource: String(row.distance_source) as RouteMetric["distanceSource"],
    serviceable,
    ...(rule ? { rule } : {}),
    breakdown: {
      inspectionFeeFen: Number(row.inspection_fee_fen),
      valetBaseFeeFen: Number(row.valet_base_fee_fen),
      valetDistanceFeeFen: Number(row.valet_distance_fee_fen),
      valetFeeFen: Number(row.valet_fee_fen),
      totalFeeFen: Number(row.service_fee_fen),
    },
  };
}

function assertQuoteVehicleIsCurrent(snapshot: Row, vehicle: Row): void {
  const fingerprint = vehicleFactsFingerprint(vehicle);
  if (
    String(snapshot.vehicle_facts_version ?? "") !== fingerprint.version
    || String(snapshot.vehicle_facts_hash ?? "") !== fingerprint.hash
  ) {
    throw new ApiProblem(409, "QUOTE_STALE", "车辆信息已发生变化，请重新获取报价", {
      vehicleId: "车辆事实或事实版本与报价快照不一致",
    });
  }
}

function paymentFromRow(row: Row) {
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    provider: String(row.provider),
    idempotencyKey: String(row.idempotency_key),
    amountFen: Number(row.amount_fen),
    status: String(row.status),
    createdAt: String(row.created_at),
    confirmedAt: String(row.confirmed_at),
  };
}

function ledgerEntryFromRow(row: Row) {
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    kind: String(row.kind),
    amountFen: Number(row.amount_fen),
    description: String(row.description),
    actorType: String(row.actor_type),
    paymentId: row.payment_id == null ? null : String(row.payment_id),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    confirmationStatus: String(row.confirmation_status ?? "confirmed"),
    confirmationIdempotencyKey: row.confirmation_idempotency_key == null ? null : String(row.confirmation_idempotency_key),
    confirmedAt: row.confirmed_at == null ? null : String(row.confirmed_at),
    createdAt: String(row.created_at),
  };
}

async function bookingFinancials(database: AppDatabase, bookingId: string) {
  const paymentRows = await database.prepare<Row>(`
    SELECT * FROM booking_payments WHERE booking_id = ? ORDER BY created_at, id
  `).all(bookingId);
  const ledgerRows = await database.prepare<Row>(`
    SELECT * FROM booking_ledger_entries WHERE booking_id = ? ORDER BY created_at, id
  `).all(bookingId);
  const payments = paymentRows.map(paymentFromRow);
  const ledgerEntries = ledgerRows.map(ledgerEntryFromRow);
  const chargedFen = ledgerEntries
    .filter((entry) => entry.kind !== "refund" && entry.confirmationStatus === "confirmed")
    .reduce((sum, entry) => sum + entry.amountFen, 0);
  const pendingAdjustmentFen = ledgerEntries
    .filter((entry) => entry.kind === "surcharge" && entry.confirmationStatus === "pending_owner_confirmation")
    .reduce((sum, entry) => sum + entry.amountFen, 0);
  const refundedFen = Math.abs(ledgerEntries
    .filter((entry) => entry.kind === "refund")
    .reduce((sum, entry) => sum + entry.amountFen, 0));
  const paidFen = payments.filter((payment) => payment.status === "confirmed").reduce((sum, payment) => sum + payment.amountFen, 0);
  return {
    payments,
    ledgerEntries,
    chargedFen,
    pendingAdjustmentFen,
    paidFen,
    refundedFen,
    amountDueFen: Math.max(0, chargedFen - paidFen),
  };
}

function paymentStatusFromFinancials(financials: Awaited<ReturnType<typeof bookingFinancials>>) {
  if (financials.refundedFen > 0) {
    return financials.refundedFen >= financials.paidFen ? "refunded" : "partially_refunded";
  }
  return financials.amountDueFen === 0 && financials.paidFen > 0 ? "paid" : "unpaid";
}

function bookingIsTerminal(row: Row): boolean {
  const terminal = ["cancelled", "completed", "no_show", "precheck_rejected"];
  return terminal.includes(String(row.fulfillment_status)) || terminal.includes(String(row.status));
}

type HoldRestoreTarget = {
  status: string;
  fulfillmentStatus: string;
  reasonCode: string | null;
};

const selfDriveHoldableStatuses = new Set([
  "confirmed",
  "awaiting_arrival",
  "checked_in",
  "inspecting",
  // Recovery compatibility for reports published before self-drive became
  // atomically complete. New reports never stop in this state.
  "result_received",
]);
const valetHoldableStatuses = new Set([
  "confirmed",
  "driver_arranged",
  "picked_up",
  "checked_in",
  "inspecting",
  "result_received",
  "returning",
]);

function canonicalBusinessStatus(row: Row): string {
  const fulfillment = String(row.fulfillment_status ?? "legacy");
  return fulfillment === "legacy" ? String(row.status) : fulfillment;
}

function expectedLegacyStatus(serviceMode: string, fulfillmentStatus: string): string | null {
  if (fulfillmentStatus === "legacy") return null;
  if (fulfillmentStatus === "driver_arranged") return serviceMode === "valet" ? "confirmed" : null;
  if (fulfillmentStatus === "picked_up") return serviceMode === "valet" ? "awaiting_arrival" : null;
  if (fulfillmentStatus === "returning") return serviceMode === "valet" ? "result_received" : null;
  if ([
    "confirmed",
    "awaiting_arrival",
    "checked_in",
    "inspecting",
    "result_received",
  ].includes(fulfillmentStatus)) return fulfillmentStatus;
  return null;
}

function holdableStatusForService(serviceMode: string, status: string): boolean {
  return (serviceMode === "valet" ? valetHoldableStatuses : selfDriveHoldableStatuses).has(status);
}

function assertBookingCanBeHeld(row: Row): void {
  const status = canonicalBusinessStatus(row);
  if (!holdableStatusForService(String(row.service_mode), status)) {
    throw new ApiProblem(409, "BOOKING_HOLD_NOT_ALLOWED", `当前状态 ${status} 不能挂起`);
  }
}

async function setBookingOnHold(
  database: AppDatabase,
  row: Row,
  reasonCode: string,
  note: string,
  actorType: ActorType,
  actorSurface: "operator" | "admin",
  now: string,
): Promise<void> {
  assertBookingCanBeHeld(row);
  const previousStatus = String(row.status);
  const previousFulfillmentStatus = String(row.fulfillment_status ?? "legacy");
  await database.prepare(`
    UPDATE bookings SET status = 'on_hold',
      fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE 'on_hold' END,
      notes = ?, updated_at = ? WHERE id = ?
  `).run(note, now, String(row.id));
  await insertEvent(
    database,
    String(row.id),
    "on_hold",
    "业务已挂起",
    note,
    now,
    actorType,
    {
      holdVersion: "booking-hold-v1",
      previousStatus,
      previousFulfillmentStatus,
      serviceMode: String(row.service_mode),
      reasonCode,
      actorSurface,
    },
  );
}

async function bookingHoldRestoreTarget(database: AppDatabase, row: Row): Promise<HoldRestoreTarget> {
  if (String(row.status) !== "on_hold" && String(row.fulfillment_status) !== "on_hold") {
    throw new ApiProblem(409, "BOOKING_NOT_ON_HOLD", "当前订单不处于挂起状态");
  }
  const holdEvent = await database.prepare<Row>(`
    SELECT metadata_json FROM booking_events
    WHERE booking_id = ? AND status = 'on_hold'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(String(row.id));
  if (!holdEvent) {
    throw new ApiProblem(409, "BOOKING_HOLD_CONTEXT_MISSING", "缺少挂起前节点记录，不能安全恢复，请联系平台处理");
  }
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(holdEvent.metadata_json ?? "{}"));
    metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new ApiProblem(409, "BOOKING_HOLD_CONTEXT_INVALID", "挂起前节点记录无效，不能安全恢复，请联系平台处理");
  }
  const serviceMode = String(row.service_mode);
  if (metadata.serviceMode != null && String(metadata.serviceMode) !== serviceMode) {
    throw new ApiProblem(409, "BOOKING_HOLD_CONTEXT_INVALID", "挂起记录与当前服务方式不一致，不能恢复");
  }
  const previousStatus = String(metadata.previousStatus ?? "");
  let previousFulfillmentStatus = String(metadata.previousFulfillmentStatus ?? "");
  if (!previousFulfillmentStatus && previousStatus) previousFulfillmentStatus = previousStatus;
  if (previousFulfillmentStatus === "legacy") {
    if (!holdableStatusForService(serviceMode, previousStatus)) {
      throw new ApiProblem(409, "BOOKING_HOLD_CONTEXT_INVALID", "挂起前节点与当前服务方式不兼容，不能恢复");
    }
  } else {
    if (!holdableStatusForService(serviceMode, previousFulfillmentStatus)) {
      throw new ApiProblem(409, "BOOKING_HOLD_CONTEXT_INVALID", "挂起前节点与当前服务方式不兼容，不能恢复");
    }
    const expectedStatus = expectedLegacyStatus(serviceMode, previousFulfillmentStatus);
    if (!expectedStatus || previousStatus !== expectedStatus) {
      throw new ApiProblem(409, "BOOKING_HOLD_CONTEXT_INVALID", "挂起前状态记录不一致，不能恢复");
    }
  }
  return {
    status: previousStatus,
    fulfillmentStatus: previousFulfillmentStatus,
    reasonCode: metadata.reasonCode == null ? null : String(metadata.reasonCode),
  };
}

async function restoreBookingFromHold(
  database: AppDatabase,
  row: Row,
  target: HoldRestoreTarget,
  description: string,
  actorType: ActorType,
  actorSurface: "operator" | "admin",
  now: string,
): Promise<void> {
  await database.prepare(`
    UPDATE bookings SET status = ?, fulfillment_status = ?, notes = NULL, updated_at = ? WHERE id = ?
  `).run(target.status, target.fulfillmentStatus, now, String(row.id));
  await insertEvent(
    database,
    String(row.id),
    target.fulfillmentStatus === "legacy" ? target.status : target.fulfillmentStatus,
    "异常已处理",
    description,
    now,
    actorType,
    {
      holdVersion: "booking-hold-v1",
      resolvedFrom: "on_hold",
      restoredStatus: target.status,
      restoredFulfillmentStatus: target.fulfillmentStatus,
      serviceMode: String(row.service_mode),
      reasonCode: target.reasonCode,
      actorSurface,
    },
  );
}

function assertDemoWorkflowEnabled(): void {
  if (process.env.ALLOW_DEMO_WORKFLOW !== "true") {
    throw new ApiProblem(403, "DEMO_WORKFLOW_DISABLED", "当前运行环境禁止演示流程写入业务状态");
  }
}

async function cancellationStage(database: AppDatabase, row: Row): Promise<string> {
  const current = String(row.fulfillment_status ?? "legacy");
  const status = String(row.status);
  const isOnHold = current === "on_hold" || status === "on_hold";
  if (!isOnHold) return current === "legacy" ? status : current;
  const holdEvent = await database.prepare<Row>(`
    SELECT metadata_json FROM booking_events
    WHERE booking_id = ? AND status = 'on_hold'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(String(row.id));
  try {
    const metadata = JSON.parse(String(holdEvent?.metadata_json ?? "{}"));
    const previousFulfillmentStatus = String(metadata.previousFulfillmentStatus ?? "");
    if (previousFulfillmentStatus === "legacy") return String(metadata.previousStatus ?? "on_hold");
    return previousFulfillmentStatus || String(metadata.previousStatus ?? "on_hold");
  } catch {
    return "on_hold";
  }
}

async function cancelBooking(
  database: AppDatabase,
  row: Row,
  actorType: "owner" | "operator",
  idempotent = false,
): Promise<void> {
  if (String(row.status) === "cancelled" || String(row.fulfillment_status) === "cancelled") {
    if (idempotent) return;
    throw new ApiProblem(409, "BOOKING_ALREADY_CANCELLED", "预约已取消");
  }
  if (String(row.status) === "completed" || String(row.fulfillment_status) === "completed") {
    throw new ApiProblem(409, "BOOKING_ALREADY_COMPLETED", "已完成的预约不能取消");
  }
  const effectiveStage = await cancellationStage(database, row);
  if (actorType !== "owner" && ["pending_precheck", "precheck_action_required"].includes(effectiveStage)) {
    throw new ApiProblem(403, "OWNER_REFUND_REQUIRED", "预检订单由车主主动申请退款，检测站或后台不能代为取消退款");
  }
  const serviceMode = String(row.service_mode);
  const cancellableStages = serviceMode === "valet"
    ? ["pending_payment", "paid_pending_confirmation", "pending_precheck", "precheck_action_required", "confirmed", "driver_arranged"]
    : ["pending_payment", "paid_pending_confirmation", "pending_precheck", "precheck_action_required", "confirmed", "awaiting_arrival"];
  if (!cancellableStages.includes(effectiveStage)) {
    throw new ApiProblem(
      409,
      "BOOKING_IN_PROGRESS",
      serviceMode === "valet"
        ? "车辆已取走或进入检测流程，不能直接取消预约；请先挂起并协调安全送回"
        : "车辆已到站或进入检测流程，不能直接取消预约；请先挂起并协调现场处理",
    );
  }

  const now = new Date().toISOString();
  await database.prepare(`
    UPDATE booking_ledger_entries SET confirmation_status = 'voided', confirmed_at = ?
    WHERE booking_id = ? AND kind = 'surcharge' AND confirmation_status = 'pending_owner_confirmation'
  `).run(now, String(row.id));
  const before = await bookingFinancials(database, String(row.id));
  const retainedFen = effectiveStage === "driver_arranged" && String(row.service_mode) === "valet"
    ? Number(row.valet_base_fee_fen ?? 0)
    : 0;
  const cancellationAdjustmentFen = Math.max(0, before.chargedFen - retainedFen);
  if (cancellationAdjustmentFen > 0) {
    await database.prepare(`
      INSERT INTO booking_ledger_entries (
        id, booking_id, kind, amount_fen, description, actor_type,
        payment_id, idempotency_key, confirmation_status, confirmed_at, created_at
      ) VALUES (?, ?, 'cancellation_adjustment', ?, ?, ?, NULL,
        'automatic-cancellation-adjustment', 'confirmed', ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      randomUUID(),
      String(row.id),
      -cancellationAdjustmentFen,
      retainedFen > 0 ? "取消订单应收冲销（仅保留代驾起步价）" : "取消订单应收全额冲销",
      actorType,
      now,
      now,
    );
  }
  const availablePaidFen = Math.max(0, before.paidFen - before.refundedFen);
  const automaticRefundFen = Math.max(0, availablePaidFen - retainedFen);
  if (automaticRefundFen > 0) {
    await database.prepare(`
      INSERT INTO booking_ledger_entries (
        id, booking_id, kind, amount_fen, description, actor_type,
        payment_id, idempotency_key, created_at
      ) VALUES (?, ?, 'refund', ?, ?, ?, NULL, 'automatic-cancellation-refund', ?)
      ON CONFLICT DO NOTHING
    `).run(
      randomUUID(),
      String(row.id),
      -automaticRefundFen,
      retainedFen > 0 ? "取消订单退款（已安排司机，保留起步价）" : "取消订单全额退款",
      actorType,
      now,
    );
  }
  const after = await bookingFinancials(database, String(row.id));
  await database.prepare(`
    UPDATE bookings SET
      status = 'cancelled',
      fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE 'cancelled' END,
      payment_status = ?, cancelled_at = ?, updated_at = ?
    WHERE id = ?
  `).run(paymentStatusFromFinancials(after), now, now, String(row.id));
  if (["pending_precheck", "precheck_action_required"].includes(effectiveStage)) {
    await database.prepare(`
      UPDATE booking_prechecks SET
        refund_status = CASE WHEN ? > 0 THEN 'refunded' ELSE refund_status END,
        refund_amount_fen = CASE WHEN ? > 0 THEN ? ELSE refund_amount_fen END,
        refund_requested_at = CASE WHEN ? > 0 THEN ? ELSE refund_requested_at END,
        refund_completed_at = CASE WHEN ? > 0 THEN ? ELSE refund_completed_at END,
        updated_at = ?
      WHERE booking_id = ?
    `).run(
      automaticRefundFen,
      automaticRefundFen,
      automaticRefundFen,
      automaticRefundFen,
      now,
      automaticRefundFen,
      now,
      now,
      String(row.id),
    );
  }
  await cancelValetDriverTaskForBooking(database, String(row.id), now);
  await markBookingMediaForRetention(database, String(row.id), now);
  if (!Number(row.precheck_slot_released ?? 0)) {
    await database.prepare("UPDATE station_slots SET booked_count = GREATEST(0, booked_count - 1) WHERE id = ?").run(String(row.slot_id));
  }
  await insertEvent(
    database,
    String(row.id),
    "cancelled",
    "预约已取消",
    retainedFen > 0 ? "司机已安排，保留代驾起步价，其余已原路退回" : "该时段已释放，已支付金额将原路退回",
    now,
    actorType,
    { effectiveStage, retainedFen, cancellationAdjustmentFen, automaticRefundFen },
  );
}

function vehicleFromRow(row: Row) {
  const parsedFromDisplay = parsePlate(String(row.plate_number));
  const parsed = parsedFromDisplay.valid ? parsedFromDisplay : parsePlate(String(row.plate_normalized));
  const facts = deriveVehicleFacts(row);
  const catalogBrand = vehicleCatalogBrand(row.brand_id == null ? null : String(row.brand_id));
  const catalogModel = vehicleCatalogModel(row.model_id == null ? null : String(row.model_id));
  const brand = row.brand_id == null
    ? null
    : { id: String(row.brand_id), name: String(row.brand_name ?? catalogBrand?.name ?? "未命名品牌") };
  const model = row.model_id == null
    ? null
    : { id: String(row.model_id), name: String(row.model_name ?? catalogModel?.name ?? "未命名车型") };
  return {
    id: String(row.id),
    washVehicleCategory: inferWashVehicleCategory({
      persisted: row.wash_vehicle_category,
      vehicleType: row.vehicle_type,
      modelName: row.model_name,
      brandName: row.brand_name,
      seats: row.seats,
    }),
    plateNumber: parsed.valid ? parsed.formatted : String(row.plate_number),
    plateKind: vehiclePlateCategory(row)?.plateKind ?? (parsed.valid ? parsed.plateKind : null),
    plateCategory: facts.plateCategory,
    plateCategoryLabel: vehiclePlateCategory(row)?.label ?? "未确认号牌类型",
    plateProvince: parsed.valid ? parsed.province : null,
    plateAgencyCode: parsed.valid ? parsed.agencyCode : null,
    energyCategory: facts.powertrainType === "pure_electric" ? "pure_electric" : ["phev", "erev"].includes(facts.powertrainType) ? "non_pure_electric" : "none",
    vehicleType: String(row.vehicle_type),
    usageNature: String(row.usage_nature),
    seats: Number(row.seats),
    registrationDate: String(row.registration_date),
    inspectionDueDate: String(row.inspection_due_date),
    inspectionDueDateSource: String(row.inspection_due_date_source ?? "legacy_unverified"),
    inspectionDueDateConfirmedAt: row.inspection_due_date_confirmed_at == null
      ? null
      : String(row.inspection_due_date_confirmed_at),
    inspectionValidity: inspectionValidityFromRow(row),
    isDefault: bool(row.is_default),
    powertrainType: facts.powertrainType,
    vehicleClassCode: facts.vehicleClassCode,
    isVan: facts.isVan,
    facts,
    brand,
    model,
    exteriorColor: row.exterior_color == null ? null : String(row.exterior_color),
    visual: catalogModel
      ? {
          imageUrl: catalogModel.imageUrl,
          kind: catalogModel.imageKind,
          label: catalogModel.imageKind === "presentation_cutout" ? "车型展示图" : "未配置车型展示图",
        }
      : null,
  };
}

function stationFromRow(row: Row, route: RouteMetric = noOriginRouteMetric()) {
  let tags: string[] = [];
  let weeklySchedule: Record<string, Array<{ start: string; end: string }>> = {};
  try {
    const parsed = JSON.parse(String(row.tags_json));
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = [];
  }
  try {
    const parsed = JSON.parse(String(row.weekly_schedule_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      weeklySchedule = parsed as Record<string, Array<{ start: string; end: string }>>;
    }
  } catch {
    weeklySchedule = {};
  }
  return {
    id: String(row.id),
    name: String(row.name),
    district: String(row.district),
    address: String(row.address),
    distanceKm: route.distanceKm,
    driveMinutes: route.driveMinutes,
    distanceBasis: route.distanceBasis,
    distanceSource: route.distanceSource,
    rating: Number(row.rating),
    reviewCount: Number(row.review_count),
    tags,
    serviceFeeFen: Number(row.service_fee_fen),
    openHours: String(row.open_hours),
    phone: row.phone == null ? null : String(row.phone),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    isActive: bool(row.is_active),
    legalName: row.legal_name == null ? null : String(row.legal_name),
    dataKind: String(row.data_kind ?? "demo"),
    isDirectOperated: bool(row.is_direct_operated),
    isPinned: bool(row.is_pinned),
    sortPriority: Number(row.sort_priority ?? 0),
    mapPoiId: row.map_poi_id == null ? null : String(row.map_poi_id),
    weeklySchedule,
    businessHoursNotice: row.business_hours_notice == null ? null : String(row.business_hours_notice),
  };
}

async function stationPricePlans(database: AppDatabase, stationId: string) {
  const rows = await database.prepare<Row>(`
    SELECT sp.plan_id, sp.is_supported, sp.price_fen, sp.updated_at
    FROM station_inspection_price_plans sp
    JOIN inspection_price_plans p ON p.id = sp.plan_id
    WHERE sp.station_id = ?
    ORDER BY p.sort_order, p.id
  `).all(stationId);
  return rows.map((row) => ({
    planId: String(row.plan_id),
    isSupported: bool(row.is_supported),
    priceFen: Number(row.price_fen),
    updatedAt: String(row.updated_at),
  }));
}

async function adminStationFromRow(database: AppDatabase, row: Row) {
  const prices = await database.prepare<Row>(`
    SELECT category, price_fen, updated_at FROM station_vehicle_prices
    WHERE station_id = ? ORDER BY category
  `).all(String(row.id));
  return {
    ...stationFromRow(row),
    internalContact: row.internal_contact_name == null && row.internal_contact_phone == null
      ? null
      : {
          name: row.internal_contact_name == null ? "" : String(row.internal_contact_name),
          phone: row.internal_contact_phone == null ? "" : String(row.internal_contact_phone),
        },
    prices: prices.map((price) => ({
      category: String(price.category),
      priceFen: Number(price.price_fen),
      updatedAt: String(price.updated_at),
    })),
    pricePlans: await stationPricePlans(database, String(row.id)),
  };
}

async function replaceStationPricePlans(
  database: AppDatabase,
  stationId: string,
  inputs: Array<z.infer<typeof stationPricePlanInputSchema>>,
): Promise<void> {
  const planIds = new Set(inputs.map((input) => input.planId));
  if (planIds.size !== inputs.length) throw new ApiProblem(400, "DUPLICATE_PRICE_PLAN", "同一价格方案不能重复配置");
  for (const input of inputs) {
    const plan = await database.prepare<Row>("SELECT id FROM inspection_price_plans WHERE id = ?").get(input.planId);
    if (!plan) throw new ApiProblem(404, "PRICE_PLAN_NOT_FOUND", `未找到价格方案 ${input.planId}`);
  }
  const now = new Date().toISOString();
  await database.prepare("DELETE FROM station_inspection_price_plans WHERE station_id = ?").run(stationId);
  const insert = database.prepare(`
    INSERT INTO station_inspection_price_plans (
      station_id, plan_id, is_supported, price_fen, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const input of inputs) await insert.run(stationId, input.planId, input.isSupported ? 1 : 0, input.priceFen, now);

  const byPlan = new Map(inputs.map((input) => [input.planId, input]));
  const legacyMappings: Array<[VehiclePriceCategory, string[]]> = [
    ["fuel_small", [INSPECTION_PRICE_PLAN_IDS.smallIce]],
    ["new_energy_small", [INSPECTION_PRICE_PLAN_IDS.smallPureElectric, INSPECTION_PRICE_PLAN_IDS.smallPlugIn]],
    ["seven_seat", [INSPECTION_PRICE_PLAN_IDS.passengerPureElectric, INSPECTION_PRICE_PLAN_IDS.passengerCombustion]],
  ];
  const upsertLegacy = database.prepare(`
    INSERT INTO station_vehicle_prices (station_id, category, price_fen, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(station_id, category) DO UPDATE SET price_fen = excluded.price_fen, updated_at = excluded.updated_at
  `);
  for (const [category, candidates] of legacyMappings) {
    const configured = candidates.map((id) => byPlan.get(id)).find((item) => item?.isSupported);
    if (configured) await upsertLegacy.run(stationId, category, configured.priceFen, now);
  }
  const fuel = byPlan.get(INSPECTION_PRICE_PLAN_IDS.smallIce);
  if (fuel?.isSupported) await database.prepare("UPDATE stations SET service_fee_fen = ?, updated_at = ? WHERE id = ?").run(fuel.priceFen, now, stationId);
}

function mediaFromRow(row: Row, audience: "owner" | "operator" | "admin" = "owner") {
  const id = String(row.id);
  const bookingId = row.booking_id == null ? null : String(row.booking_id);
  return {
    id,
    bookingId,
    kind: String(row.kind),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    url: audience === "admin" && bookingId
      ? `/api/admin/bookings/${bookingId}/media/${id}`
      : `/api/media/${id}`,
    createdAt: String(row.created_at),
  };
}

function slotFromRow(row: Row) {
  return {
    id: String(row.id),
    stationId: String(row.station_id),
    date: String(row.date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    capacity: Number(row.capacity),
    bookedCount: Number(row.booked_count),
    remaining: Math.max(0, Number(row.capacity) - Number(row.booked_count)),
  };
}

type InspectionAuditChange = {
  field?: string;
  label: string;
  before?: unknown;
  after?: unknown;
};

const fulfillmentAuditLabels: Record<string, string> = {
  legacy: "历史状态",
  pending_payment: "待支付",
  paid_pending_confirmation: "已支付待确认",
  pending_precheck: "待检测站预审",
  precheck_action_required: "预检待处理",
  precheck_rejected: "预审未通过",
  confirmed: "已确认",
  driver_arranged: "已安排司机",
  picked_up: "已取车",
  awaiting_arrival: "等待到站",
  checked_in: "已到站",
  inspecting: "检测中",
  result_received: "结果已回传",
  returning: "送回中",
  completed: "已完成",
  on_hold: "已挂起",
  cancelled: "已取消",
  no_show: "已爽约",
};

function auditMoney(fen: number): string {
  return `¥${(fen / 100).toFixed(2)}`;
}

function auditPhone(value: unknown): string | null {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  if (normalized.length <= 4) return "****";
  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
}

function auditPlate(value: unknown): string {
  const normalized = String(value ?? "").trim().replace(/[·\s-]/gu, "").toUpperCase();
  if (!normalized) return "待核验车辆";
  if (normalized.includes("*")) return normalized;
  if (normalized.length <= 3) return "***";
  return `${normalized.slice(0, 2)}***${normalized.slice(-1)}`;
}

function auditJson(value: unknown, fallback: unknown): unknown {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

async function stationPricePlanAuditSnapshot(database: AppDatabase, stationId: string) {
  const rows = await database.prepare<Row>(`
    SELECT sp.plan_id, p.name AS plan_name, sp.is_supported, sp.price_fen
    FROM station_inspection_price_plans sp
    JOIN inspection_price_plans p ON p.id = sp.plan_id
    WHERE sp.station_id = ?
    ORDER BY p.sort_order, p.id
  `).all(stationId);
  return rows.map((row) => ({
    planId: String(row.plan_id),
    planName: String(row.plan_name),
    isSupported: bool(row.is_supported),
    price: auditMoney(Number(row.price_fen)),
  }));
}

async function stationAuditSnapshot(database: AppDatabase, row: Row) {
  return {
    id: String(row.id),
    name: String(row.name),
    legalName: row.legal_name == null ? null : String(row.legal_name),
    district: String(row.district),
    address: String(row.address),
    openHours: String(row.open_hours),
    publicPhone: auditPhone(row.phone),
    isActive: bool(row.is_active),
    dataKind: String(row.data_kind ?? "demo"),
    isDirectOperated: bool(row.is_direct_operated),
    isPinned: bool(row.is_pinned),
    sortPriority: Number(row.sort_priority ?? 0),
    weeklySchedule: auditJson(row.weekly_schedule_json, {}),
    businessHoursNotice: row.business_hours_notice == null ? null : String(row.business_hours_notice),
    internalContact: row.internal_contact_name == null && row.internal_contact_phone == null
      ? null
      : {
          name: row.internal_contact_name == null ? null : String(row.internal_contact_name),
          phone: auditPhone(row.internal_contact_phone),
        },
    pricePlans: await stationPricePlanAuditSnapshot(database, String(row.id)),
  };
}

function stationAuditChanges(
  before: Awaited<ReturnType<typeof stationAuditSnapshot>>,
  after: Awaited<ReturnType<typeof stationAuditSnapshot>>,
): InspectionAuditChange[] {
  const definitions: Array<[keyof typeof after, string, (value: unknown) => unknown]> = [
    ["name", "展示名称", String],
    ["legalName", "正式主体名称", (value) => value ?? "未填写"],
    ["address", "检测站位置", String],
    ["openHours", "营业时间摘要", String],
    ["publicPhone", "客户咨询电话", (value) => value ?? "未填写"],
    ["isActive", "经营状态", (value) => value ? "已启用" : "已停用"],
    ["dataKind", "数据属性", (value) => value === "real" ? "真实站点" : "演示站点"],
    ["isDirectOperated", "运营属性", (value) => value ? "官方自营" : "合作站点"],
    ["isPinned", "置顶状态", (value) => value ? "已置顶" : "未置顶"],
    ["sortPriority", "排序权重", Number],
    ["weeklySchedule", "每周营业安排", (value) => value],
    ["businessHoursNotice", "营业提示", (value) => value ?? "未填写"],
    ["internalContact", "内部联系人", (value) => value],
    ["pricePlans", "支持车型与年检价格", (value) => value],
  ];
  return definitions.flatMap(([field, label, format]) => {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) return [];
    return [{ field: String(field), label, before: format(before[field]), after: format(after[field]) }];
  });
}

function slotAuditSnapshot(row: Row) {
  return {
    id: String(row.id),
    stationId: String(row.station_id),
    date: String(row.date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    capacity: Number(row.capacity),
    bookedCount: Number(row.booked_count),
  };
}

function slotAuditChanges(before: ReturnType<typeof slotAuditSnapshot>, after: ReturnType<typeof slotAuditSnapshot>): InspectionAuditChange[] {
  const changes: InspectionAuditChange[] = [];
  if (before.date !== after.date) changes.push({ field: "date", label: "预约日期", before: before.date, after: after.date });
  const beforePeriod = `${before.startTime}–${before.endTime}`;
  const afterPeriod = `${after.startTime}–${after.endTime}`;
  if (beforePeriod !== afterPeriod) changes.push({ field: "period", label: "预约时段", before: beforePeriod, after: afterPeriod });
  if (before.capacity !== after.capacity) changes.push({ field: "capacity", label: "总容量", before: before.capacity, after: after.capacity });
  return changes;
}

function pricePlanAuditSnapshot(row: Row) {
  const plan = inspectionPricePlanFromRow(row);
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    powertrainTypes: plan.powertrainTypes,
    minSeats: plan.minSeats,
    maxSeats: plan.maxSeats,
    usageNatures: plan.usageNatures,
    vehicleClassCodes: plan.vehicleClassCodes,
    plateCategories: plan.plateCategories,
    excludeVans: plan.excludeVans,
    inspectionItems: plan.inspectionItems,
    sortOrder: plan.sortOrder,
    isActive: plan.isActive,
  };
}

const auditPowertrainLabels: Record<string, string> = {
  gasoline: "汽油",
  diesel: "柴油",
  hybrid: "混合动力",
  pure_electric: "纯电",
  phev: "插电式混合动力",
  erev: "增程式",
  other: "其他",
  unknown: "未知",
};

function pricePlanAuditDisplayValue(field: keyof ReturnType<typeof pricePlanAuditSnapshot>, value: unknown): unknown {
  if (field === "isActive") return value ? "已启用" : "已停用";
  if (field === "excludeVans") return value ? "排除面包车" : "不排除面包车";
  if (field === "powertrainTypes" && Array.isArray(value)) {
    return value.map((item) => auditPowertrainLabels[String(item)] ?? String(item));
  }
  if (field === "plateCategories" && Array.isArray(value)) return value.map((item) => plateCategory(item)?.label ?? String(item));
  if (field === "inspectionItems" && Array.isArray(value)) {
    return value.map((item) => inspectionItemNames[String(item) as keyof typeof inspectionItemNames] ?? String(item));
  }
  return value;
}

function pricePlanAuditChanges(before: ReturnType<typeof pricePlanAuditSnapshot>, after: ReturnType<typeof pricePlanAuditSnapshot>): InspectionAuditChange[] {
  const definitions: Array<[keyof typeof after, string]> = [
    ["name", "方案名称"], ["code", "稳定代码"], ["description", "运营说明"],
    ["powertrainTypes", "适用动力类型"], ["minSeats", "最少座位"], ["maxSeats", "最多座位"],
    ["usageNatures", "使用性质"], ["plateCategories", "号牌车型"], ["vehicleClassCodes", "车辆类别"], ["excludeVans", "排除面包车"],
    ["inspectionItems", "检验项目"], ["sortOrder", "后台排序"], ["isActive", "启用状态"],
  ];
  return definitions.flatMap(([field, label]) => JSON.stringify(before[field]) === JSON.stringify(after[field])
    ? []
    : [{ field: String(field), label, before: pricePlanAuditDisplayValue(field, before[field]), after: pricePlanAuditDisplayValue(field, after[field]) }]);
}

function valetRuleAuditSnapshot(row: Row) {
  return {
    baseFeeFen: Number(row.base_fee_fen),
    includedKm: Number(row.included_km),
    perKmFen: Number(row.per_km_fen),
    maxRadiusKm: row.max_radius_km_limit === undefined
      ? row.max_radius_km == null ? null : Number(row.max_radius_km)
      : row.max_radius_km_limit == null ? null : Number(row.max_radius_km_limit),
  };
}

function valetRuleAuditChanges(before: ReturnType<typeof valetRuleAuditSnapshot>, after: ReturnType<typeof valetRuleAuditSnapshot>): InspectionAuditChange[] {
  const changes: InspectionAuditChange[] = [];
  if (before.baseFeeFen !== after.baseFeeFen) changes.push({ field: "baseFeeFen", label: "往返起步价", before: auditMoney(before.baseFeeFen), after: auditMoney(after.baseFeeFen) });
  if (before.includedKm !== after.includedKm) changes.push({ field: "includedKm", label: "包含单程里程", before: `${before.includedKm} km`, after: `${after.includedKm} km` });
  if (before.perKmFen !== after.perKmFen) changes.push({ field: "perKmFen", label: "超出单价", before: `${auditMoney(before.perKmFen)}/km`, after: `${auditMoney(after.perKmFen)}/km` });
  if (before.maxRadiusKm !== after.maxRadiusKm) changes.push({ field: "maxRadiusKm", label: "最大服务距离", before: before.maxRadiusKm == null ? "不限制" : `${before.maxRadiusKm} km`, after: after.maxRadiusKm == null ? "不限制" : `${after.maxRadiusKm} km` });
  return changes;
}

async function bookingAuditContext(database: AppDatabase, row: Row) {
  const station = await database.prepare<Row>("SELECT id, name FROM stations WHERE id = ?").get(String(row.station_id));
  const vehicle = await database.prepare<Row>("SELECT plate_number FROM vehicles WHERE id = ?").get(String(row.vehicle_id));
  return {
    id: String(row.id),
    bookingNumber: String(row.booking_number),
    stationId: String(row.station_id),
    stationName: station == null ? "检测站" : String(station.name),
    plateNumber: auditPlate(vehicle?.plate_number),
    appointmentDate: String(row.appointment_date),
    period: `${String(row.start_time)}–${String(row.end_time)}`,
    status: String(row.status),
    fulfillmentStatus: String(row.fulfillment_status ?? "legacy"),
  };
}

function bookingStatusChange(before: string, after: string): InspectionAuditChange[] {
  if (before === after) return [];
  return [{
    field: "fulfillmentStatus",
    label: "履约状态",
    before: fulfillmentAuditLabels[before] ?? before,
    after: fulfillmentAuditLabels[after] ?? after,
  }];
}

function bookingAuditAfterStatus<T extends { status: string; fulfillmentStatus: string }>(
  before: T,
  status: string,
  fulfillmentStatus = status,
): T {
  return {
    ...before,
    status,
    fulfillmentStatus: before.fulfillmentStatus === "legacy" ? "legacy" : fulfillmentStatus,
  };
}

function bookingLifecycleChanges(
  before: { status: string; fulfillmentStatus: string },
  after: { status: string; fulfillmentStatus: string },
): InspectionAuditChange[] {
  if (before.fulfillmentStatus !== after.fulfillmentStatus) {
    return bookingStatusChange(before.fulfillmentStatus, after.fulfillmentStatus);
  }
  if (before.status === after.status) return [];
  return [{
    field: "status",
    label: "履约状态",
    before: fulfillmentAuditLabels[before.status] ?? before.status,
    after: fulfillmentAuditLabels[after.status] ?? after.status,
  }];
}

function bookingFinancialAuditSnapshot(financials: Awaited<ReturnType<typeof bookingFinancials>>) {
  return {
    chargedFen: financials.chargedFen,
    pendingAdjustmentFen: financials.pendingAdjustmentFen,
    paidFen: financials.paidFen,
    refundedFen: financials.refundedFen,
    amountDueFen: financials.amountDueFen,
  };
}

function eventFromRow(row: Row) {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.metadata_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    metadata = {};
  }
  if ("conclusion" in metadata) {
    metadata = {
      ...metadata,
      ...officialInspectionConclusionView(metadata.conclusion),
    };
  }
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    status: String(row.status),
    title: String(row.title),
    description: String(row.description),
    actorType: String(row.actor_type ?? "system"),
    metadata,
    createdAt: String(row.created_at),
  };
}

function precheckFromRow(row: Row | undefined, workflowTask: Row | undefined) {
  if (!row) return null;
  const submittedAt = String(row.submitted_at);
  const taskStatus = workflowTask == null ? null : String(workflowTask.status);
  const firstReminderAt = workflowTask?.first_reminder_at == null ? null : String(workflowTask.first_reminder_at);
  const dueAt = workflowTask?.due_at == null ? null : String(workflowTask.due_at);
  const escalateAt = workflowTask?.escalate_at == null ? null : String(workflowTask.escalate_at);
  const lastRemindedAt = workflowTask?.last_reminded_at == null ? null : String(workflowTask.last_reminded_at);
  const isOpenTask = taskStatus === "open";
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    stationId: String(row.station_id),
    status: String(row.status),
    submittedAt,
    reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
    reviewerName: row.reviewer_name == null ? null : String(row.reviewer_name),
    reasonCodes: jsonArray(row.reason_codes_json),
    reasonText: row.reason_text == null ? null : String(row.reason_text),
    issuePhotoKinds: jsonArray(row.issue_photo_kinds_json),
    guidance: precheckGuidance,
    history: jsonArray(row.history_json),
    resolutionNote: row.resolution_note == null ? null : String(row.resolution_note),
    refundStatus: String(row.refund_status ?? "not_requested"),
    refundAmountFen: Number(row.refund_amount_fen ?? 0),
    refundError: row.refund_error == null ? null : String(row.refund_error),
    refundRequestedAt: row.refund_requested_at == null ? null : String(row.refund_requested_at),
    refundCompletedAt: row.refund_completed_at == null ? null : String(row.refund_completed_at),
    version: Number(row.version ?? 1),
    // Compatibility booleans are now derived from the persisted task and its
    // worker activity, never from the age of the precheck row.
    reminderDue: String(row.status) === "pending" && isOpenTask && lastRemindedAt != null,
    overdue: String(row.status) === "pending" && isOpenTask && dueAt != null && Date.parse(dueAt) <= Date.now(),
    supervision: workflowTask == null ? null : {
      taskId: String(workflowTask.id),
      status: taskStatus,
      policyVersion: Number(workflowTask.policy_version),
      firstReminderAt,
      dueAt,
      escalateAt,
      lastRemindedAt,
      reminderCount: Number(workflowTask.reminder_count ?? 0),
      escalatedAt: workflowTask.escalated_at == null ? null : String(workflowTask.escalated_at),
      inAppCreatedAt: workflowTask.in_app_created_at == null ? null : String(workflowTask.in_app_created_at),
      externalDeliveryStatus: workflowTask.external_delivery_status == null ? null : String(workflowTask.external_delivery_status),
      externalAcceptedAt: workflowTask.external_accepted_at == null ? null : String(workflowTask.external_accepted_at),
      externalLastErrorCode: workflowTask.external_last_error_code == null ? null : String(workflowTask.external_last_error_code),
    },
  };
}

function bookingFromRow(row: Row, includeInternal = false) {
  const inspectionItems = jsonArray(row.inspection_items_json);
  const vehicleSnapshot = jsonObject(row.vehicle_snapshot_json);
  const stationSnapshot = jsonObject(row.station_snapshot_json);
  const pricePlanSnapshot = jsonObject(row.price_plan_snapshot_json);
  const frozenRule = jsonObject(row.rule_snapshot_json);
  const rule = frozenRule ?? (row.rule_base_fee_fen == null
    ? null
    : {
        scope: row.rule_scope == null ? "global" : String(row.rule_scope),
        stationId: row.rule_station_id == null ? null : String(row.rule_station_id),
        baseFeeFen: Number(row.rule_base_fee_fen),
        includedKm: Number(row.rule_included_km),
        perKmFen: Number(row.rule_per_km_fen),
        maxRadiusKm: row.rule_max_radius_km == null ? null : Number(row.rule_max_radius_km),
        updatedAt: row.rule_updated_at == null ? null : String(row.rule_updated_at),
        version: row.rule_version == null ? null : String(row.rule_version),
      });
  const serviceMode = String(row.service_mode);
  const tripType = row.trip_type == null
    ? (serviceMode === "valet" ? "legacy_one_way" : null)
    : String(row.trip_type);
  return {
    id: String(row.id),
    serviceType: "annual_inspection" as const,
    bookingNumber: String(row.booking_number),
    vehicleId: String(row.vehicle_id),
    stationId: String(row.station_id),
    slotId: String(row.slot_id),
    precheckSlotReleased: Boolean(Number(row.precheck_slot_released ?? 0)),
    contactName: String(row.contact_name),
    contactPhone: String(row.contact_phone),
    serviceFeeFen: Number(row.service_fee_fen),
    inspectionFeeFen: Number(row.inspection_fee_fen),
    valetFeeFen: Number(row.valet_fee_fen),
    serviceMode,
    vehiclePriceCategory: String(row.vehicle_price_category),
    quoteDistanceKm: row.quote_distance_km == null ? null : Number(row.quote_distance_km),
    quoteSource: String(row.quote_source),
    quoteSnapshotId: row.quote_snapshot_id == null ? null : String(row.quote_snapshot_id),
    quoteExpiresAt: row.quote_expires_at == null ? null : String(row.quote_expires_at),
    tripType,
    serviceScope: serviceMode === "valet" && tripType === "round_trip_same_address" ? tripType : null,
    isLegacyOneWayValet: serviceMode === "valet" && tripType === "legacy_one_way",
    oneWayDistanceKm: row.one_way_distance_km == null ? null : Number(row.one_way_distance_km),
    roundTripDistanceKm: row.round_trip_distance_km == null ? null : Number(row.round_trip_distance_km),
    billableDistanceKm: row.billable_distance_km == null ? null : Number(row.billable_distance_km),
    extraKm: row.quote_extra_km == null ? null : Number(row.quote_extra_km),
    pricePlanId: row.price_plan_id == null ? null : String(row.price_plan_id),
    pricingSnapshotVersion: row.pricing_snapshot_version == null ? null : String(row.pricing_snapshot_version),
    vehicleFactsVersion: row.vehicle_facts_version == null ? null : String(row.vehicle_facts_version),
    vehicleFactsHash: row.vehicle_facts_hash == null ? null : String(row.vehicle_facts_hash),
    vehicleFacts: jsonObject(vehicleSnapshot?.facts),
    vehicleSnapshot,
    stationSnapshot,
    pricePlanSnapshot,
    pricingEligibility: String(row.pricing_eligibility ?? "legacy"),
    inspectionItems,
    inspectionItemPricingMode: row.pricing_snapshot_version == null
      ? "legacy_unknown"
      : INSPECTION_ITEM_PRICING_MODE,
    inspectionItemAmounts: jsonObjectArray(row.inspection_item_amounts_json),
    priceBreakdown: {
      inspectionFeeFen: Number(row.inspection_fee_fen),
      valetBaseFeeFen: Number(row.valet_base_fee_fen ?? 0),
      valetDistanceFeeFen: Number(row.valet_distance_fee_fen ?? 0),
      valetFeeFen: Number(row.valet_fee_fen),
      totalFeeFen: Number(row.service_fee_fen),
    },
    valetRule: rule,
    paymentStatus: String(row.payment_status ?? "unpaid"),
    fulfillmentStatus: String(row.fulfillment_status ?? "legacy"),
    evidencePolicyVersion: String(row.evidence_policy_version ?? "legacy"),
    ...(includeInternal ? { internalDriverNote: row.internal_driver_note == null ? null : String(row.internal_driver_note) } : {}),
    status: String(row.status),
    appointmentDate: String(row.appointment_date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    notes: row.notes == null ? null : String(row.notes),
    pickupAddress:
      row.pickup_poi_id == null
        ? null
        : {
            poiId: String(row.pickup_poi_id),
            title: String(row.pickup_title),
            address: String(row.pickup_address),
            district: String(row.pickup_district),
            latitude: Number(row.pickup_latitude),
            longitude: Number(row.pickup_longitude),
            detail: row.pickup_detail == null ? "" : String(row.pickup_detail),
            note: row.pickup_note == null ? "" : String(row.pickup_note),
          },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function getVehicleRow(database: AppDatabase, id: string, userId: string, includeDeleted = false): Promise<Row | undefined> {
  const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
  return database
    .prepare<Row>(`SELECT * FROM vehicles WHERE id = ? AND user_id = ? ${deletedClause}`)
    .get(id, userId);
}

async function getVehicleRowAny(database: AppDatabase, id: string, includeDeleted = false): Promise<Row | undefined> {
  const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
  return database.prepare<Row>(`SELECT * FROM vehicles WHERE id = ? ${deletedClause}`).get(id);
}

async function getStationRow(database: AppDatabase, id: string): Promise<Row | undefined> {
  return database.prepare<Row>("SELECT * FROM stations WHERE id = ?").get(id);
}

async function getSlotRow(database: AppDatabase, id: string): Promise<Row | undefined> {
  return database.prepare<Row>("SELECT * FROM station_slots WHERE id = ?").get(id);
}

async function getBookingRow(database: AppDatabase, id: string, userId: string): Promise<Row | undefined> {
  return database
    .prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ?")
    .get(id, userId);
}

async function getOperatorBookingRow(database: AppDatabase, id: string): Promise<Row | undefined> {
  return database.prepare<Row>("SELECT * FROM bookings WHERE id = ?").get(id);
}

function verificationFromRow(row: Row) {
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    plateMatched: bool(row.plate_matched),
    materialsReady: bool(row.materials_ready),
    exteriorRecorded: bool(row.exterior_recorded),
    vehicleConditionConfirmed: bool(row.condition_confirmed),
    notes: row.notes == null ? null : String(row.notes),
    verifiedAt: row.verified_at == null ? null : String(row.verified_at),
    updatedAt: String(row.updated_at),
  };
}

function resultFromRow(row: Row) {
  let summary: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.summary_json));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) summary = parsed;
  } catch {
    summary = {};
  }
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    externalResultId: String(row.external_result_id),
    ...officialInspectionConclusionView(row.conclusion),
    ...officialInspectionFailureDetailsView(
      row.conclusion,
      jsonObject(row.failure_details_json),
    ),
    summary: safeInspectionConclusionSummary(row.conclusion, summary),
    source: String(row.source),
    receivedAt: String(row.received_at),
  };
}

async function bookingDetailFromRow(
  database: AppDatabase,
  row: Row,
  includeEvents = true,
  includeInternal = false,
  reportAudience: "owner" | "operator" | "admin" = includeInternal ? "operator" : "owner",
  revealDriverVerificationCode = false,
) {
  const id = String(row.id);
  const stationRow = await getStationRow(database, String(row.station_id));
  const vehicleRow = await getVehicleRowAny(database, String(row.vehicle_id), true);
  const events = includeEvents
    ? (await database
        .prepare<Row>("SELECT * FROM booking_events WHERE booking_id = ? ORDER BY created_at ASC, id ASC")
        .all(id)).map(eventFromRow)
    : undefined;
  const verificationRow = await database
    .prepare<Row>("SELECT * FROM booking_verifications WHERE booking_id = ?")
    .get(id);
  const resultRow = await database
    .prepare<Row>("SELECT * FROM inspection_results WHERE booking_id = ?")
    .get(id);
  const mediaRows = await database
    .prepare<Row>("SELECT * FROM booking_media WHERE booking_id = ? AND is_current = 1 ORDER BY created_at ASC")
    .all(id);
  const precheckRow = await database
    .prepare<Row>("SELECT * FROM booking_prechecks WHERE booking_id = ?")
    .get(id);
  const precheckWorkflowTask = await database.prepare<Row>(`
    SELECT t.*,
      (SELECT MAX(n.created_at) FROM notification_inbox n WHERE n.task_id = t.id) AS in_app_created_at,
      (SELECT o.status FROM notification_outbox o WHERE o.task_id = t.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS external_delivery_status,
      (SELECT o.accepted_at FROM notification_outbox o WHERE o.task_id = t.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS external_accepted_at,
      (SELECT o.last_error_code FROM notification_outbox o WHERE o.task_id = t.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS external_last_error_code
    FROM workflow_tasks t
    WHERE t.domain = 'annual_inspection' AND t.entity_type = 'booking'
      AND t.entity_id = ? AND t.node_code = 'annual.precheck.pending'
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 1
  `).get(id);
  const vehicleCheckupReport = await vehicleCheckupReportDto(database, id, reportAudience);
  const valetHandoff = await valetHandoffDetail(database, id, reportAudience, {
    revealDriverVerificationCode,
  });

  const booking = bookingFromRow(row, includeInternal);
  const frozenVehicleSnapshot = booking.vehicleSnapshot;
  const hasFrozenVehiclePlate = frozenVehicleSnapshot != null
    && typeof frozenVehicleSnapshot.plateNumber === "string"
    && frozenVehicleSnapshot.plateNumber.trim().length > 0;
  return {
    ...booking,
    station: booking.stationSnapshot ?? (stationRow ? stationFromRow(stationRow) : undefined),
    vehicle: hasFrozenVehiclePlate
      ? booking.vehicleSnapshot
      : vehicleRow ? vehicleFromRow(vehicleRow) : undefined,
    verification: verificationRow ? verificationFromRow(verificationRow) : null,
    inspectionResult: resultRow ? resultFromRow(resultRow) : null,
    vehicleCheckupReport:
      !includeInternal && vehicleCheckupReport?.status !== "published" ? null : vehicleCheckupReport,
    media: mediaRows.map((mediaRow) => mediaFromRow(mediaRow, reportAudience)),
    precheck: precheckFromRow(precheckRow, precheckWorkflowTask),
    precheckServices: precheckRow ? [
      ...(await database.prepare<Row>("SELECT id, request_no, status FROM repair_requests WHERE source_booking_id = ? AND source_type = 'precheck' ORDER BY created_at DESC").all(id))
        .map((item) => ({ id: String(item.id), type: "repair", label: "维修报价", number: String(item.request_no), status: String(item.status) })),
      ...(await database.prepare<Row>("SELECT w.id, w.status FROM precheck_wash_links l JOIN wash_orders w ON w.id = l.wash_order_id WHERE l.booking_id = ? ORDER BY l.created_at DESC").all(id))
        .map((item) => ({ id: String(item.id), type: "wash", label: "洗车预约", status: String(item.status) })),
    ] : [],
    refundStatus: precheckRow == null ? "not_requested" : String(precheckRow.refund_status ?? "not_requested"),
    ...valetHandoff,
    ...await bookingFinancials(database, id),
    ...(events ? { events } : {}),
  };
}

async function getBooking(database: AppDatabase, id: string, userId: string, includeEvents = true) {
  const row = await getBookingRow(database, id, userId);
  if (!row) return undefined;
  return bookingDetailFromRow(database, row, includeEvents);
}

async function getOperatorBooking(database: AppDatabase, id: string, includeEvents = true) {
  const row = await getOperatorBookingRow(database, id);
  return row ? bookingDetailFromRow(database, row, includeEvents, true) : undefined;
}

function runTransaction<T>(database: AppDatabase, operation: (tx: AppDatabase) => T | Promise<T>): Promise<T> {
  return database.transaction(operation);
}

async function insertEvent(
  database: AppDatabase,
  bookingId: string,
  status: string,
  title: string,
  description: string,
  createdAt: string,
  actorType: ActorType = "system",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await database
    .prepare(`
      INSERT INTO booking_events (
        id, booking_id, status, title, description, actor_type, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(randomUUID(), bookingId, status, title, description, actorType, JSON.stringify(metadata), createdAt);
  await syncAnnualWorkflowForBooking(database, bookingId, {
    now: new Date(createdAt),
    actorType: actorType === "operator"
      ? "station"
      : actorType === "owner" || actorType === "driver"
        ? actorType
        : "system",
  });
}

async function upsertVerification(
  database: AppDatabase,
  bookingId: string,
  values: z.infer<typeof verificationSchema>,
  now: string,
): Promise<void> {
  await database.prepare(`
    INSERT INTO booking_verifications (
      id, booking_id, plate_matched, materials_ready, exterior_recorded,
      condition_confirmed, notes, verified_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(booking_id) DO UPDATE SET
      plate_matched = excluded.plate_matched,
      materials_ready = excluded.materials_ready,
      exterior_recorded = excluded.exterior_recorded,
      condition_confirmed = excluded.condition_confirmed,
      notes = excluded.notes,
      verified_at = excluded.verified_at,
      updated_at = excluded.updated_at
  `).run(
    randomUUID(),
    bookingId,
    values.plateMatched ? 1 : 0,
    values.materialsReady ? 1 : 0,
    values.exteriorRecorded ? 1 : 0,
    values.vehicleConditionConfirmed ? 1 : 0,
    values.notes ?? null,
    now,
    now,
  );
}

async function requireOperatorBooking(database: AppDatabase, id: string): Promise<Row> {
  const row = await database.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(id);
  if (!row) throw new ApiProblem(404, "OPERATOR_BOOKING_NOT_FOUND", "未找到本站预约任务");
  return row;
}

function assertTransition(row: Row, allowedFrom: string[], action: string): void {
  if (!allowedFrom.includes(String(row.status))) {
    throw new ApiProblem(409, "INVALID_BOOKING_TRANSITION", `当前状态不能${action}`);
  }
}

async function transitionOperatorBooking(
  database: AppDatabase,
  id: string,
  allowedFrom: string[],
  nextStatus: string,
  title: string,
  description: string,
  metadata: Record<string, unknown> = {},
  canonicalAllowedFrom: string[] = allowedFrom,
  nextFulfillmentStatus: string = nextStatus,
): Promise<void> {
  const row = await requireOperatorBooking(database, id);
  assertTransition(row, allowedFrom, title);
  await assertCanonicalOperatorGate(database, row, canonicalAllowedFrom, title);
  const now = new Date().toISOString();
  await database
    .prepare(`
      UPDATE bookings SET
        status = ?,
        fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE ? END,
        updated_at = ?, completed_at = ?
      WHERE id = ?
    `)
    .run(nextStatus, nextFulfillmentStatus, now, nextStatus === "completed" ? now : null, id);
  if (nextStatus === "completed") await markBookingMediaForRetention(database, id, now);
  await insertEvent(database, id, nextStatus, title, description, now, "operator", metadata);
}

async function assertCanonicalOperatorGate(
  database: AppDatabase,
  row: Row,
  allowedFrom: string[],
  action: string,
): Promise<void> {
  const current = String(row.fulfillment_status ?? "legacy");
  if (current === "legacy") return;
  const financials = await bookingFinancials(database, String(row.id));
  // A later surcharge must not strand the physical workflow. It becomes a
  // hard gate only at terminal completion; ordinary station actions merely
  // require that the original order has a confirmed payment.
  if (financials.paidFen <= 0) {
    throw new ApiProblem(409, "PAYMENT_REQUIRED", `订单完成支付后才能${action}`);
  }
  if (!allowedFrom.includes(current)) {
    throw new ApiProblem(409, "INVALID_FULFILLMENT_TRANSITION", `不能从 ${current} 执行${action}`);
  }
}

async function markBookingMediaForRetention(database: AppDatabase, bookingId: string, terminalAt: string): Promise<void> {
  const expiresAt = new Date(Date.parse(terminalAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  await database.prepare("UPDATE booking_media SET expires_at = ? WHERE booking_id = ?").run(expiresAt, bookingId);
}

function expectedResultSignature(timestamp: string, body: unknown): string {
  const configuredSecret = process.env.YUXIAOMAN_INTEGRATION_SECRET?.trim();
  const production = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
  if (production && !configuredSecret) {
    throw new ApiProblem(
      503,
      "INTEGRATION_SECRET_NOT_CONFIGURED",
      "检测结果回传接口未配置生产签名密钥",
    );
  }
  const secret = configuredSecret || DEMO_INTEGRATION_SECRET;
  const digest = createHmac("sha256", secret).update(`${timestamp}.${stableJson(body)}`).digest("hex");
  return `sha256=${digest}`;
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function receiveInspectionResult(
  database: AppDatabase,
  body: z.infer<typeof inspectionResultSchema>,
  idempotencyKey: string,
) {
  const requestHash = inspectionResultRequestHash(body);
  const existingByKey = await database
    .prepare<Row>("SELECT * FROM inspection_results WHERE idempotency_key = ?")
    .get(idempotencyKey);
  if (existingByKey) {
    if (String(existingByKey.request_hash) !== requestHash) {
      throw new ApiProblem(409, "IDEMPOTENCY_KEY_CONFLICT", "幂等键已用于不同的结果回传载荷");
    }
    return { booking: await getOperatorBooking(database, body.bookingId), idempotent: true };
  }

  const serverReceivedAt = new Date().toISOString();
  const deviceReceivedAt = body.receivedAt ?? serverReceivedAt;
  let idempotent = false;
  await runTransaction(database, async (tx) => {
    const row = await requireOperatorBooking(tx, body.bookingId);
    const concurrentExisting = await tx
      .prepare<Row>("SELECT * FROM inspection_results WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (concurrentExisting) {
      if (String(concurrentExisting.request_hash) !== requestHash) {
        throw new ApiProblem(409, "IDEMPOTENCY_KEY_CONFLICT", "幂等键已用于不同的结果回传载荷");
      }
      idempotent = true;
      return;
    }
    const duplicate = await tx
      .prepare<Row>("SELECT id FROM inspection_results WHERE booking_id = ? OR external_result_id = ?")
      .get(body.bookingId, body.externalResultId);
    if (duplicate) throw new ApiProblem(409, "DUPLICATE_INSPECTION_RESULT", "该检测结果已回传");
    if (String(row.status) !== "inspecting") {
      throw new ApiProblem(409, "INVALID_BOOKING_TRANSITION", "仅检测中的任务可以接收结果");
    }
    await assertCanonicalOperatorGate(tx, row, ["inspecting"], "接收检测结果");
    const completesSelfDriveService = String(row.service_mode) === "self_drive";
    if (completesSelfDriveService) {
      await assertAnnualBookingFinancialClosureReady(
        tx,
        body.bookingId,
        (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
      );
    }
    await publishVehicleCheckupReport(
      tx,
      body.bookingId,
      body.conclusion,
      body.failureDetails ?? null,
      body.summary,
      serverReceivedAt,
      (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
    );

    await tx.prepare(`
      INSERT INTO inspection_results (
        id, booking_id, external_result_id, conclusion, failure_details_json,
        summary_json, source, received_at, idempotency_key, request_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      body.bookingId,
      body.externalResultId,
      body.conclusion,
      body.failureDetails == null ? null : JSON.stringify(body.failureDetails),
      JSON.stringify(body.summary),
      body.source,
      deviceReceivedAt,
      idempotencyKey,
      requestHash,
    );
    const nextStatus = completesSelfDriveService ? "completed" : "result_received";
    // Keep the two audit nodes strictly ordered even on databases that use the
    // event id as the secondary sort key for equal timestamps.
    const completedAt = completesSelfDriveService
      ? new Date(Date.parse(serverReceivedAt) + 1).toISOString()
      : serverReceivedAt;
    await tx
      .prepare(`
        UPDATE bookings SET status = ?,
          fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE ? END,
          updated_at = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
        WHERE id = ?
      `)
      .run(nextStatus, nextStatus, completedAt, nextStatus, completedAt, body.bookingId);
    if (completesSelfDriveService) await markBookingMediaForRetention(tx, body.bookingId, completedAt);
    await insertEvent(
      tx,
      body.bookingId,
      "result_received",
      "检测结果已回传",
      "检测线外部系统已完成结果交接",
      serverReceivedAt,
      "external_system",
      {
        externalResultId: body.externalResultId,
        conclusion: body.conclusion,
        source: body.source,
        deviceReceivedAt,
      },
    );
    if (completesSelfDriveService) {
      await insertEvent(
        tx,
        body.bookingId,
        "completed",
        "自驾年检服务已自动完成",
        "有效检测结果和完整报告已发布给车主，无需再次人工确认",
        completedAt,
        "system",
        { trigger: "report_publication", reportDelivered: true },
      );
    }
  });
  return { booking: await getOperatorBooking(database, body.bookingId), idempotent };
}

function bookingNumber(): string {
  return `YXM${todayIso().replaceAll("-", "")}${randomUUID().slice(0, 6).toUpperCase()}`;
}

async function nextDefaultVehicle(database: AppDatabase, userId: string, excludedId?: string): Promise<void> {
  const next = excludedId
    ? (await database
        .prepare<Row>(`
          SELECT id FROM vehicles
          WHERE user_id = ? AND deleted_at IS NULL AND id <> ?
          ORDER BY created_at ASC LIMIT 1
        `)
        .get(userId, excludedId))
    : (await database
        .prepare<Row>(`
          SELECT id FROM vehicles
          WHERE user_id = ? AND deleted_at IS NULL
          ORDER BY created_at ASC LIMIT 1
        `)
        .get(userId));
  if (next) {
    await database.prepare("UPDATE vehicles SET is_default = 1 WHERE id = ?").run(String(next.id));
  } else if (excludedId) {
    await database
      .prepare("UPDATE vehicles SET is_default = 1 WHERE id = ? AND deleted_at IS NULL")
      .run(excludedId);
  }
}

async function removeStoredMedia(database: AppDatabase, uploadDir: string, rows: Row[]): Promise<void> {
  for (const row of rows) {
    try {
      await unlink(join(uploadDir, String(row.storage_key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await database.prepare("DELETE FROM booking_media WHERE id = ?").run(String(row.id));
  }
}

async function cleanupExpiredMedia(database: AppDatabase, uploadDir: string): Promise<void> {
  const rows = await database.prepare<Row>("SELECT * FROM booking_media WHERE expires_at <= ?").all(new Date().toISOString());
  await removeStoredMedia(database, uploadDir, rows);
}

async function clearUploadDirectory(uploadDir: string): Promise<void> {
  await mkdir(uploadDir, { recursive: true });
  const files = await readdir(uploadDir);
  await Promise.all(
    files.filter((name) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.jpg$/iu.test(name)).map(async (name) => {
      try {
        await unlink(join(uploadDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
  const usedCarUploadDir = join(uploadDir, "used-cars");
  await rm(usedCarUploadDir, { recursive: true, force: true });
  await mkdir(usedCarUploadDir, { recursive: true });
  const vehicleCheckupUploadDir = join(uploadDir, "vehicle-checkup");
  await rm(vehicleCheckupUploadDir, { recursive: true, force: true });
  await mkdir(vehicleCheckupUploadDir, { recursive: true });
  const washUploadDir = join(uploadDir, "wash");
  await rm(washUploadDir, { recursive: true, force: true });
  await mkdir(join(washUploadDir, "stores"), { recursive: true });
}

function pathContains(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function assertResetUploadDirectoriesSafe(
  uploadDir: string,
  insuranceUploadDir: string,
  subsidyConsultationUploadDir: string,
): void {
  const projectRoot = resolve(process.cwd());
  const directories = [uploadDir, insuranceUploadDir, subsidyConsultationUploadDir].map((value) => resolve(value));
  for (const directory of directories) {
    if (directory === parsePath(directory).root || pathContains(directory, projectRoot)) {
      throw new ApiProblem(409, "DEMO_RESET_STORAGE_UNSAFE", "演示重置目录配置不安全");
    }
  }
  for (let left = 0; left < directories.length; left += 1) {
    for (let right = left + 1; right < directories.length; right += 1) {
      if (pathContains(directories[left], directories[right]) || pathContains(directories[right], directories[left])) {
        throw new ApiProblem(409, "DEMO_RESET_STORAGE_UNSAFE", "演示重置目录不能相同或互相包含");
      }
    }
  }
}

async function clearPrivateUploadDirectory(uploadDir: string, generatedFilename: RegExp): Promise<void> {
  await mkdir(uploadDir, { recursive: true });
  const entries = await readdir(uploadDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && generatedFilename.test(entry.name))
    .map(async (entry) => {
      try {
        await unlink(join(uploadDir, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }));
}

async function assertBookingMedia(
  database: AppDatabase,
  mediaIds: string[],
  userId: string,
  serviceMode: "self_drive" | "valet",
): Promise<Row[]> {
  const uniqueIds = [...new Set(mediaIds)];
  if (uniqueIds.length !== mediaIds.length) {
    throw new ApiProblem(400, "DUPLICATE_MEDIA", "同一张照片不能重复提交");
  }
  const rows = await Promise.all(uniqueIds.map((id) =>
    database.prepare<Row>("SELECT * FROM booking_media WHERE id = ? AND user_id = ? AND booking_id IS NULL").get(id, userId),
  ));
  if (rows.some((row) => !row)) throw new ApiProblem(400, "MEDIA_NOT_AVAILABLE", "部分照片不存在、已过期或已绑定");
  const media = rows as Row[];
  const kinds = new Set(media.map((row) => String(row.kind)));
  const required = [...bookingPrecheckMediaKinds];
  const missing = required.filter((kind) => !kinds.has(kind));
  const unexpected = [...kinds].filter((kind) => !required.includes(kind));
  if (missing.length > 0 || unexpected.length > 0 || media.length !== required.length) {
    throw new ApiProblem(400, "BOOKING_MEDIA_REQUIRED", "请补齐预约所需照片", {
      mediaIds: [
        ...(missing.length ? [`缺少：${missing.join("、")}`] : []),
        ...(unexpected.length ? [`本方式不应上传：${unexpected.join("、")}`] : []),
      ].join("；") || `本方式必须恰好上传 ${required.length} 张指定照片`,
    });
  }
  if (kinds.size !== media.length) throw new ApiProblem(400, "DUPLICATE_MEDIA_KIND", "每个照片位置只能上传一张");
  return media;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const ownsDatabase = !options.database;
  const database = options.database ?? await createDatabase();
  const currentTime = options.now ?? (() => new Date());
  const currentSlotTime = options.slotNow ?? currentTime;
  try {
  const uploadDir = options.uploadDir ?? process.env.YUXIAOMAN_UPLOAD_DIR ?? join(process.cwd(), "data", "uploads");
  const insuranceUploadDir = options.insuranceUploadDir
    ?? process.env.INSURANCE_UPLOAD_DIR
    ?? join(process.cwd(), "data", "private", "insurance");
  const subsidyConsultationUploadDir = options.subsidyConsultationUploadDir
    ?? process.env.SUBSIDY_CONSULTATION_UPLOAD_DIR
    ?? join(process.cwd(), "data", "private", "subsidy-consultation");
  await mkdir(uploadDir, { recursive: true });
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? parseTrustProxy(),
  });
  // WeChat wx.request often sends `Content-Type: application/json` with an empty body on
  // DELETE. Fastify 5 rejects that by default (FST_ERR_CTP_EMPTY_JSON_BODY → opaque 400).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : "";
    if (!raw.trim()) {
      done(null, null);
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch (error) {
      const parseError = error instanceof Error ? error : new Error("Invalid JSON");
      (parseError as Error & { statusCode?: number }).statusCode = 400;
      done(parseError, undefined);
    }
  });
  let demoResetInProgress = false;
  app.addHook("preHandler", async (request) => {
    if (demoResetInProgress && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      throw new ApiProblem(503, "DEMO_RESET_IN_PROGRESS", "演示数据正在重置，请稍后重试");
    }
  });
  const mapRuntime: MapRuntimeState = {
    status: process.env.TENCENT_MAP_KEY?.trim() ? "configured" : "missing",
    lastErrorCode: process.env.TENCENT_MAP_KEY?.trim() ? null : "TENCENT_KEY_MISSING",
    lastCheckedAt: null,
  };

  await app.register(cors, {
    delegator: (request, callback) => {
      const path = request.url.split("?", 1)[0] ?? request.url;
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      callback(null, {
        // The owner API keeps its existing reflected-origin behavior. Only the
        // unified backoffice surface is constrained by BACKOFFICE_ALLOWED_ORIGINS.
        origin: !isBackofficeOriginControlledPath(path) || backofficeOriginAllowed(origin),
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      });
    },
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 12 },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiProblem) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      });
    }

    if (error instanceof AuthenticationError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    if (error instanceof BackofficeError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      });
    }

    if (error instanceof WorkflowDomainError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      });
    }

    const postgresCode = (error as Error & { code?: string }).code;
    if (postgresCode && ["23502", "23503", "23505", "23514", "23P01"].includes(postgresCode)) {
      return reply.status(409).send({
        error: { code: "DATA_CONFLICT", message: "数据发生冲突，请刷新后重试" },
      });
    }
    if (postgresCode?.startsWith("28")) {
      app.log.error(error);
      return reply.status(503).send({
        error: { code: "DATABASE_AUTHENTICATION_FAILED", message: "数据库连接认证失败，请联系管理员" },
      });
    }

    const statusCode = (error as Error & { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: "BAD_REQUEST", message: "请求格式有误，请检查后重试" },
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试" },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "请求的接口不存在" } }),
  );

  if (ownsDatabase) {
    app.addHook("onClose", async () => {
      await database.close();
    });
  }

  const healthHandler = async () => ({
    data: {
      status: "ok",
      service: "yuxiaoman-api",
      time: new Date().toISOString(),
      map: {
        provider: "tencent",
        configured: Boolean(process.env.TENCENT_MAP_KEY?.trim()),
        status: mapRuntime.status,
        lastErrorCode: mapRuntime.lastErrorCode,
        lastCheckedAt: mapRuntime.lastCheckedAt,
      },
    },
  });
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);
  registerAuthRoutes(app, database, { uploadDir });
  registerUserProfileRoutes(app, database, { uploadDir });
  registerBackofficeRoutes(app, database);
  await registerWorkflowRoutes(app, database, {
    now: currentTime,
    allowBackofficeTestFallback: process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK === "true",
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
  });
  registerCustomerCenterRoutes(app, database, {
    uploadDir,
    insuranceUploadDir,
    subsidyConsultationUploadDir,
  });

  await cleanupExpiredMedia(database, uploadDir);

  await registerWashRoutes(app, database, {
    uploadDir,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
    now: currentSlotTime,
    calculateDrivingRoute: async (origin, destination) => {
      const [metric] = await calculateRouteMetrics(
        { latitude: origin.latitude, longitude: origin.longitude, type: "valet" },
        [{ latitude: destination.latitude, longitude: destination.longitude }],
        mapRuntime,
      );
      return metric;
    },
  });
  await registerUsedCarAssetRoutes(app);
  await registerDrivingSchoolAssetRoutes(app);
  await registerUsedCarRoutes(app, database, {
    uploadDir,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
  });
  await registerCarRentalRoutes(app, database, {
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
    uploadDir,
    now: currentSlotTime,
    validLocationProof: validWashLocationProof,
    calculateDrivingRoute: options.carRentalCalculateDrivingRoute ?? (async (origin, destination) => {
      const [metric] = await calculateRouteMetrics(
        { latitude: origin.latitude, longitude: origin.longitude, type: "valet" },
        [{ latitude: destination.latitude, longitude: destination.longitude }],
        mapRuntime,
      );
      return metric;
    }),
  });
  await registerInsuranceRoutes(app, database, {
    uploadDir: insuranceUploadDir,
    cleanupIntervalMs: options.insuranceCleanupIntervalMs,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
  });
  await registerSubsidyConsultationRoutes(app, database, {
    uploadDir: subsidyConsultationUploadDir,
    cleanupIntervalMs: options.subsidyConsultationCleanupIntervalMs,
    now: currentTime,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
  });
  await registerDrivingSchoolRoutes(app, database, {
    now: currentTime,
    validLocationProof: validWashLocationProof,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
  });
  await registerVehicleCheckupRoutes(app, database, {
    uploadDir,
    now: currentTime,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
    getOperatorBookingDetail: (bookingId) => getOperatorBooking(database, bookingId),
  });
  await registerValetHandoffRoutes(app, database, {
    uploadDir,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
    getBookingDetail: async (bookingId, audience) => {
      const row = await database.prepare<Row>("SELECT * FROM bookings WHERE id = ?").get(bookingId);
      if (!row) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      return bookingDetailFromRow(database, row, true, audience !== "owner", audience);
    },
  });
  await registerRepairRoutes(app, database, {
    uploadDir,
    now: currentTime,
    problem: (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
  });

  app.get<{ Querystring: { query?: string } }>("/api/locations/suggestions", async (request) => {
    const query = request.query.query?.trim() ?? "";
    if (query.length < 2) return { data: [], meta: { source: "demo", notice: "请输入至少 2 个字符" } };
    const key = process.env.TENCENT_MAP_KEY?.trim();
    if (key) {
      try {
        const parameters = new URLSearchParams({
          keyword: query,
          region: "天津",
          region_fix: "1",
          policy: "1",
          key,
        });
        const response = await fetch(`https://apis.map.qq.com/ws/place/v1/suggestion/?${parameters}`, {
          signal: AbortSignal.timeout(tencentMapTimeoutMs()),
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
        if (payload.status === 0 && Array.isArray(payload.data)) {
          const locations = payload.data.map((item) => ({
            poiId: String(item.id ?? `${item.title}-${item.location?.lat}-${item.location?.lng}`),
            title: String(item.title ?? "天津位置"),
            address: String(item.address ?? item.title ?? "天津市"),
            district: String(item.district ?? "天津市"),
            latitude: Number(item.location?.lat),
            longitude: Number(item.location?.lng),
            source: "tencent" as const,
          })).filter((location) => Number.isFinite(location.latitude) && Number.isFinite(location.longitude)).slice(0, 6);
          return {
            data: locations.map((location) => ({ ...location, locationProof: createWashLocationProof(location) })),
            meta: { source: "tencent", notice: "腾讯位置服务实时联想" },
          };
        }
      } catch {
        // Fall through to clearly labelled synthetic Tianjin suggestions.
      }
    }
    if (process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production") {
      throw new ApiProblem(503, "LOCATION_VERIFICATION_UNAVAILABLE", "当前位置服务暂不可用，请稍后重试");
    }
    if (process.env.YUXIAOMAN_ALLOW_DEMO_LOCATIONS !== "true"
      && process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK !== "true") {
      throw new ApiProblem(503, "DEMO_LOCATIONS_DISABLED", "当前环境未启用演示地址，请配置位置服务后重试");
    }
    const demoPois = [
      ["天津文化中心地下停车场", "河西区平江道 58 号", "河西区", 39.0837, 117.2197],
      ["天津站南广场停车场", "河北区海河东路天津站南广场", "河北区", 39.1362, 117.2106],
      ["鲁能城购物中心停车场", "南开区水上公园北道与水上公园东路交口", "南开区", 39.0878, 117.1776],
      ["天津万象城停车场", "河西区乐园道 9 号", "河西区", 39.0896, 117.2138],
      ["和平大悦城停车场", "和平区南京路 189 号", "和平区", 39.118, 117.1951],
      ["河东万达广场停车场", "河东区津滨大道 53 号", "河东区", 39.1171, 117.2631],
      ["第六大道第博雅园", "河东区昆仑路第六大道博雅园（演示坐标）", "河东区", 39.1059, 117.2445],
    ] as const;
    const normalized = query.toLowerCase();
    const matches = demoPois.filter((poi) => `${poi[0]}${poi[1]}${poi[2]}`.toLowerCase().includes(normalized));
    const selected = (matches.length > 0 ? matches : demoPois).slice(0, 6);
    return {
      data: selected.map((poi, index) => {
        const location = {
          poiId: `demo-tianjin-${index}-${poi[3]}-${poi[4]}`,
          title: poi[0],
          address: poi[1],
          district: poi[2],
          latitude: poi[3],
          longitude: poi[4],
          source: "demo" as const,
        };
        return { ...location, locationProof: createWashLocationProof(location) };
      }),
      meta: { source: "demo", notice: "未配置腾讯位置服务密钥，当前为天津合成演示地址" },
    };
  });

  app.post("/api/locations/resolve", async (request, reply) => {
    const input = parseBody(locationResolveSchema, request.body, reply);
    if (!input) return;
    const production = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
    const key = process.env.TENCENT_MAP_KEY?.trim();
    let errorCode: MapErrorCode = "TENCENT_KEY_MISSING";

    if (key) {
      const resolved = await resolveTencentCoordinate(input, key, mapRuntime);
      if (resolved.outsideTianjin) {
        throw new ApiProblem(400, "LOCATION_OUTSIDE_TIANJIN", "所选位置不在天津市服务范围内，请重新选择");
      }
      if (resolved.location) {
        try {
          return {
            data: {
              ...resolved.location,
              locationProof: createWashLocationProof(resolved.location),
            },
            meta: { source: "tencent", notice: "地址由腾讯位置服务按所选坐标解析" },
          };
        } catch {
          throw new ApiProblem(
            503,
            "LOCATION_RESOLUTION_UNAVAILABLE",
            "地址校验服务尚未正确配置，请稍后重试",
            { mapErrorCode: "LOCATION_PROOF_SECRET_MISSING" },
          );
        }
      }
      errorCode = resolved.errorCode;
    } else {
      updateMapRuntime(mapRuntime, errorCode);
    }

    if (production) {
      throw new ApiProblem(
        503,
        "LOCATION_RESOLUTION_UNAVAILABLE",
        "当前位置暂时无法通过腾讯位置服务验证，请稍后重试",
        { mapErrorCode: errorCode },
      );
    }
    if (process.env.YUXIAOMAN_ALLOW_DEMO_LOCATIONS !== "true"
      && process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK !== "true") {
      throw new ApiProblem(503, "DEMO_LOCATIONS_DISABLED", "当前环境未启用演示地址，请配置位置服务后重试");
    }
    const location = demoCoordinateResolution(input);
    return {
      data: { ...location, locationProof: createWashLocationProof(location) },
      meta: {
        source: "demo",
        notice: "腾讯位置服务不可用，当前为明确标记的演示地址；客户端名称仅用于演示",
        mapErrorCode: errorCode,
      },
    };
  });

  app.post("/api/media", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    await cleanupExpiredMedia(database, uploadDir);
    let part;
    try {
      part = await request.file();
    } catch {
      throw new ApiProblem(413, "MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
    }
    if (!part) throw new ApiProblem(400, "MEDIA_FILE_REQUIRED", "请选择要上传的照片");
    const kindValue = part.fields.kind && "value" in part.fields.kind ? String(part.fields.kind.value) : "";
    const parsedKind = mediaKindSchema.safeParse(kindValue);
    if (!parsedKind.success) throw new ApiProblem(400, "MEDIA_KIND_INVALID", "照片位置无效");
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(part.mimetype)) {
      throw new ApiProblem(415, "MEDIA_TYPE_INVALID", "仅支持 JPEG、PNG、WebP 或 HEIC 图片");
    }
    let source: Buffer;
    try {
      source = await part.toBuffer();
    } catch {
      throw new ApiProblem(413, "MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
    }
    if (source.length > 10 * 1024 * 1024) throw new ApiProblem(413, "MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
    let processed;
    try {
      processed = await sharp(source, { failOn: "error" })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new ApiProblem(400, "MEDIA_INVALID", "图片已损坏或无法识别，请重新选择");
    }
    const id = randomUUID();
    const storageKey = `${randomUUID()}.jpg`;
    await writeFile(join(uploadDir, storageKey), processed.data, { flag: "wx" });
    const now = new Date();
    await database.prepare(`
      INSERT INTO booking_media (
        id, user_id, booking_id, kind, storage_key, mime_type, size_bytes,
        width, height, created_at, bound_at, expires_at
      ) VALUES (?, ?, NULL, ?, ?, 'image/jpeg', ?, ?, ?, ?, NULL, ?)
    `).run(
      id,
      userId,
      parsedKind.data,
      storageKey,
      processed.data.length,
      processed.info.width,
      processed.info.height,
      now.toISOString(),
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    );
    const row = await database.prepare<Row>("SELECT * FROM booking_media WHERE id = ? AND user_id = ?").get(id, userId);
    if (!row) throw new ApiProblem(500, "MEDIA_PERSISTENCE_FAILED", "照片保存失败，请重试");
    return reply.status(201).send({ data: mediaFromRow(row) });
  });

  app.get<{ Params: { id: string } }>("/api/media/:id", async (request, reply) => {
    const stationPrincipal = await resolveInspectionStationBearer(request, database);
    const row = stationPrincipal
      ? await database.prepare<Row>(`
          SELECT media.*
          FROM booking_media media
          JOIN bookings booking
            ON booking.id = media.booking_id AND booking.user_id = media.user_id
          WHERE media.id = ? AND booking.station_id = ?
        `).get(
          request.params.id,
          scopedInspectionStationId(
            assertCapability(stationPrincipal, "inspection.bookings.read"),
          ),
        )
      : await database.prepare<Row>(
          "SELECT * FROM booking_media WHERE id = ? AND user_id = ?",
        ).get(request.params.id, await requireCurrentUser(request, database));
    if (!row) throw new ApiProblem(404, "MEDIA_NOT_FOUND", "照片不存在或已清理");
    reply.type("image/jpeg").header("Cache-Control", "private, max-age=3600");
    return reply.send(createReadStream(join(uploadDir, String(row.storage_key))));
  });

  app.delete<{ Params: { id: string } }>("/api/media/:id", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const row = await database
      .prepare<Row>("SELECT * FROM booking_media WHERE id = ? AND user_id = ? AND booking_id IS NULL")
      .get(request.params.id, userId);
    if (!row) throw new ApiProblem(404, "MEDIA_NOT_FOUND", "照片不存在、已过期或已绑定预约");
    await removeStoredMedia(database, uploadDir, [row]);
    return { data: { id: request.params.id, deleted: true } };
  });

  app.post("/api/bookings/quote", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(quoteRequestSchema, request.body, reply);
    if (!body) return;
    const vehicle = await getVehicleRow(database, body.vehicleId, userId);
    if (!vehicle) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
    assertNoConfirmedInspectionDateConflict(vehicle);
    const station = await getStationRow(database, body.stationId);
    if (!station || !bool(station.is_active)) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到可预约的检测站");
    const pickupAddress = body.serviceMode === "valet" && body.pickupAddress
      ? verifiedAnnualPickupAddress(body.pickupAddress)
      : body.pickupAddress;
    const quote = await calculateQuote(
      database,
      vehicle,
      station,
      body.serviceMode,
      pickupAddress,
      routeOriginFromQuote(body),
      body.tripType,
      mapRuntime,
    );
    const snapshot = await persistQuoteSnapshot(database, userId, body.vehicleId, body.stationId, quote, pickupAddress);
    return { data: { ...quote, ...snapshot } };
  });

  app.get("/api/vehicles", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const rows = await database
      .prepare(`
        SELECT * FROM vehicles
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY is_default DESC, created_at ASC
      `)
      .all(userId) as Row[];
    return { data: rows.map(vehicleFromRow) };
  });

  app.get("/api/vehicle-catalog", async () => ({ data: vehicleCatalogDto() }));

  app.get<{ Params: { id: string } }>("/api/vehicles/:id", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const row = await getVehicleRow(database, request.params.id, userId);
    if (!row) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
    return { data: vehicleFromRow(row) };
  });

  app.post("/api/vehicles", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(createVehicleSchema, request.body, reply);
    if (!body) return;

    const now = new Date().toISOString();
    const dueDateState = createInspectionDueDateState(body, now);
    assertVehicleSeatCount(body.seats, body.plateCategory);
    assertVehicleDates(body.registrationDate, dueDateState.dueDate);
    const editablePlate = editablePlateValue(body.plateNumber);
    if (!editablePlate) {
      throw new ApiProblem(400, "INVALID_PLATE_NUMBER", "请输入有效的车牌号", {
        plateNumber: "车牌号只能包含安全的文字、数字和常见分隔符",
      });
    }
    const plateNormalized = editablePlate.normalized;
    const duplicate = await database
      .prepare(`
        SELECT id FROM vehicles
        WHERE user_id = ? AND plate_normalized = ? AND deleted_at IS NULL
      `)
      .get(userId, plateNormalized);
    if (duplicate) {
      throw new ApiProblem(409, "PLATE_ALREADY_EXISTS", "该车牌已添加", {
        plateNumber: "请勿重复添加同一辆车",
      });
    }

    const id = randomUUID();
    const vehicleCount = Number(
      (await database
        .prepare<Row>("SELECT COUNT(*) AS count FROM vehicles WHERE user_id = ? AND deleted_at IS NULL")
        .get(userId))!.count,
    );
    const makeDefault = body.isDefault === true || vehicleCount === 0;
    const catalogSelection = catalogSelectionFromInput(body);
    const vehicleClassCode = plateCategory(body.plateCategory)?.vehicleClassCode ?? body.vehicleClassCode ?? null;
    assertCatalogSelectionVehicleClass(catalogSelection.modelId, vehicleClassCode);

    await runTransaction(database, async (tx) => {
      if (makeDefault) {
        await tx
          .prepare("UPDATE vehicles SET is_default = 0, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL")
          .run(now, userId);
      }
      await tx
        .prepare(`
          INSERT INTO vehicles (
            id, user_id, plate_number, plate_normalized, vehicle_type, usage_nature,
            seats, registration_date, inspection_due_date, inspection_due_date_source,
            inspection_due_date_confirmed_at, is_default,
            powertrain_type, vehicle_class_code, is_van, wash_vehicle_category,
            brand_id, brand_name, model_id, model_name, plate_category, exterior_color,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `)
        .run(
          id,
          userId,
          editablePlate.formatted,
          plateNormalized,
          body.vehicleType,
          body.usageNature,
          body.seats,
          body.registrationDate,
          dueDateState.dueDate,
          dueDateState.source,
          dueDateState.confirmedAt,
          makeDefault ? 1 : 0,
          body.powertrainType ?? null,
          vehicleClassCode,
          body.isVan === undefined ? null : body.isVan ? 1 : 0,
          body.washVehicleCategory ?? inferWashVehicleCategory({
            vehicleType: body.vehicleType,
            modelName: catalogSelection.modelName,
            brandName: catalogSelection.brandName,
            seats: body.seats,
          }),
          catalogSelection.brandId,
          catalogSelection.brandName,
          catalogSelection.modelId,
          catalogSelection.modelName,
          body.plateCategory ?? null,
          exteriorColorForWrite(body.exteriorColor, undefined, vehicleClassCode),
          now,
          now,
        );
    });

    const row = await getVehicleRow(database, id, userId);
    return reply.status(201).send({ data: vehicleFromRow(row!) });
  });

  app.patch<{ Params: { id: string } }>("/api/vehicles/:id", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(updateVehicleSchema, request.body, reply);
    if (!body) return;

    const current = await getVehicleRow(database, request.params.id, userId);
    if (!current) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");

    const editablePlate = body.plateNumber ? editablePlateValue(body.plateNumber) : undefined;
    assertVehicleSeatCount(body.seats ?? Number(current.seats), body.plateCategory ?? current.plate_category);
    if (body.plateNumber && !editablePlate) {
      throw new ApiProblem(400, "INVALID_PLATE_NUMBER", "请输入有效的车牌号", {
        plateNumber: "车牌号只能包含安全的文字、数字和常见分隔符",
      });
    }
    const plateNumber = editablePlate?.formatted ?? String(current.plate_number);
    const plateNormalized = editablePlate?.normalized ?? String(current.plate_normalized);
    const registrationDate = body.registrationDate ?? String(current.registration_date);
    const now = new Date().toISOString();
    const dueDateState = updateInspectionDueDateState(body, current, registrationDate, now);
    const catalogSelection = catalogSelectionFromInput(body, current);
    const vehicleClassCode = plateCategory(body.plateCategory ?? current.plate_category)?.vehicleClassCode
      ?? body.vehicleClassCode
      ?? (current.vehicle_class_code == null ? null : String(current.vehicle_class_code));
    assertCatalogSelectionVehicleClass(catalogSelection.modelId, vehicleClassCode);
    assertVehicleDates(registrationDate, dueDateState.dueDate);

    const duplicate = await database
      .prepare(`
        SELECT id FROM vehicles
        WHERE user_id = ? AND plate_normalized = ? AND id <> ? AND deleted_at IS NULL
      `)
      .get(userId, plateNormalized, request.params.id);
    if (duplicate) {
      throw new ApiProblem(409, "PLATE_ALREADY_EXISTS", "该车牌已添加", {
        plateNumber: "请使用其他车牌号",
      });
    }

    await runTransaction(database, async (tx) => {
      if (body.isDefault === true) {
        await tx
          .prepare("UPDATE vehicles SET is_default = 0, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL")
          .run(now, userId);
      }

      const nextIsDefault = body.isDefault === false ? 0 : body.isDefault === true ? 1 : Number(current.is_default);
      await tx
        .prepare(`
          UPDATE vehicles SET
            plate_number = ?, plate_normalized = ?, vehicle_type = ?, usage_nature = ?,
            seats = ?, registration_date = ?, inspection_due_date = ?, inspection_due_date_source = ?,
            inspection_due_date_confirmed_at = ?, is_default = ?,
            powertrain_type = ?, vehicle_class_code = ?, is_van = ?, wash_vehicle_category = ?,
            brand_id = ?, brand_name = ?, model_id = ?, model_name = ?, plate_category = ?, exterior_color = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `)
        .run(
          plateNumber,
          plateNormalized,
          body.vehicleType ?? String(current.vehicle_type),
          body.usageNature ?? String(current.usage_nature),
          body.seats ?? Number(current.seats),
          registrationDate,
          dueDateState.dueDate,
          dueDateState.source,
          dueDateState.confirmedAt,
          nextIsDefault,
          body.powertrainType ?? (current.powertrain_type == null ? null : String(current.powertrain_type)),
          vehicleClassCode,
          body.isVan === undefined ? (current.is_van == null ? null : Number(current.is_van)) : body.isVan ? 1 : 0,
          body.washVehicleCategory ?? inferWashVehicleCategory({
            persisted: current.wash_vehicle_category,
            vehicleType: body.vehicleType ?? current.vehicle_type,
            modelName: catalogSelection.modelName,
            brandName: catalogSelection.brandName,
            seats: body.seats ?? current.seats,
          }),
          catalogSelection.brandId,
          catalogSelection.brandName,
          catalogSelection.modelId,
          catalogSelection.modelName,
          body.plateCategory ?? (current.plate_category == null ? null : String(current.plate_category)),
          exteriorColorForWrite(body.exteriorColor, current, vehicleClassCode),
          now,
          request.params.id,
          userId,
        );

      if (bool(current.is_default) && body.isDefault === false) await nextDefaultVehicle(tx, userId, request.params.id);
    });

    return { data: vehicleFromRow((await getVehicleRow(database, request.params.id, userId))!) };
  });

  app.delete<{ Params: { id: string } }>("/api/vehicles/:id", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const current = await getVehicleRow(database, request.params.id, userId);
    if (!current) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");

    const activeBooking = await database
      .prepare(`
        SELECT id FROM bookings
        WHERE vehicle_id = ? AND status NOT IN ('completed', 'cancelled', 'no_show')
        LIMIT 1
      `)
      .get(request.params.id);
    if (activeBooking) {
      throw new ApiProblem(409, "VEHICLE_HAS_ACTIVE_BOOKING", "车辆存在进行中的预约，暂时不能删除");
    }

    const now = new Date().toISOString();
    await runTransaction(database, async (tx) => {
      await tx
        .prepare("UPDATE vehicles SET deleted_at = ?, is_default = 0, updated_at = ? WHERE id = ?")
        .run(now, now, request.params.id);
      if (bool(current.is_default)) await nextDefaultVehicle(tx, userId);
    });
    return { data: { id: request.params.id, deleted: true } };
  });

  app.post("/api/inspection/calculations", async (request, reply) => {
    const body = parseBody(inspectionCalculationRequestSchema, request.body, reply);
    if (!body) return;

    let vehicle: InspectionVehicleFacts;
    let inspectionValidity: ReturnType<typeof inspectionValidityFromRow> | z.infer<typeof inspectionValiditySchema>;
    if (body.source === "vehicle") {
      const userId = await requireCurrentUser(request, database);
      const row = await getVehicleRow(database, body.vehicleId, userId);
      if (!row) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
      vehicle = inspectionFactsFromVehicleRow(row);
      inspectionValidity = inspectionValidityFromRow(row);
    } else {
      vehicle = {
        registrationMonth: body.vehicle.registrationMonth,
        vehicleClass: body.vehicle.vehicleClass,
        usageNature: body.vehicle.usageNature,
        seats: body.vehicle.seats ?? null,
        powertrainType: body.vehicle.powertrainType ?? "unknown",
        powertrainSource: body.vehicle.powertrainType ? "temporary_input" : "unknown",
      };
      inspectionValidity = body.inspectionValidity ?? { mode: "unconfirmed" };
    }

    if (vehicle.registrationMonth > todayIso().slice(0, 7)) {
      throw new ApiProblem(400, "VALIDATION_ERROR", "提交的信息有误，请检查后重试", {
        [body.source === "vehicle" ? "vehicleId" : "vehicle.registrationMonth"]: "车辆注册月份不能晚于当前月份",
      });
    }

    return {
      data: calculateInspection({
        source: body.source,
        asOfDate: todayIso(),
        vehicle,
        declarations: body.declarations,
        inspectionValidity,
      }),
    };
  });

  app.get<{ Params: { vehicleId: string } }>("/api/inspection/status/:vehicleId", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const row = await getVehicleRow(database, request.params.vehicleId, userId);
    if (!row) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");

    const validity = inspectionValidityFromRow(row);
    const dueDate = String(row.inspection_due_date);
    const validityConfirmed = validity.mode === "confirmed";
    const todayUtc = Date.parse(`${todayIso()}T00:00:00Z`);
    const dueDays = validityConfirmed
      ? Math.round((Date.parse(`${dueDate}T00:00:00Z`) - todayUtc) / 86_400_000)
      : null;
    const demoOverride = internalDemoEligibilityOverride(row);
    const calculationValidity = demoOverride && validity.mode === "confirmed"
      ? { ...validity, source: "paper_driving_license" as const }
      : validity;
    const ruleCalculation = calculateInspection({
      source: "vehicle",
      asOfDate: todayIso(),
      vehicle: inspectionFactsFromVehicleRow(row),
      declarations: {
        isVan: "no",
        hasInjuryAccident: "no",
        hasIllegalModificationPenalty: "no",
        convertedFromOperational: "no",
        delayedFirstRegistrationOver4Years: "no",
      },
      inspectionValidity: calculationValidity,
    });
    const calculation = demoOverride
      ? {
          ...ruleCalculation,
          action: "onsite_inspection" as const,
          windowStatus: "open" as const,
          canBookInspection: true,
          title: "隔离演示：可预约上线检验",
          summary: "DEMO-ONLY：该有效期仅用于本机隔离演示，不代表用户或官方确认。",
          manualReviewReasons: [],
          applicationWindow: inspectionApplicationWindow(dueDate.slice(0, 7)),
          dateEvidence: {
            estimate: ruleCalculation.dateEvidence.estimate,
            confirmation: {
              validThroughMonth: dueDate.slice(0, 7),
              validThroughDate: dueDate,
              source: "internal_placeholder",
              confirmedAt: validity.mode === "confirmed" ? validity.confirmedAt : null,
            },
            comparison: "matched" as const,
            decisionBasis: "matched_confirmation" as const,
            explanation: "DEMO-ONLY：隔离 loader 临时设置可预约日期；真实素材日期保留在私有 QA 结果中。",
          },
        }
      : validityConfirmed ? ruleCalculation : null;
    const unconfirmedBookingRule = !validityConfirmed
      && ruleCalculation.canBookInspection
      && (
        ruleCalculation.windowStatus === "overdue"
        || ruleCalculation.reasons.some((reason) => reason.code === "outstanding_onsite_obligation")
      )
      ? ruleCalculation
      : null;
    const bookingCalculation = calculation ?? unconfirmedBookingRule;
    // An unconfirmed official validity date must continue to block direct
    // booking, but it should not hide a policy estimate that can be derived
    // from the vehicle's registration facts.
    const estimatedDueDate = ruleCalculation.dateEvidence.estimate?.dueDate ?? null;
    const eligibility = bookingCalculation?.canBookInspection
      ? "eligible"
      : bookingCalculation?.windowStatus === "not_open"
        ? "not_due"
        : "manual_review";
    const eligibilityLabel = eligibility === "eligible"
      ? "可预约办理"
      : eligibility === "not_due"
        ? "暂未进入办理期"
        : "需要人工确认";
    const title = !validityConfirmed
      ? estimatedDueDate ? `规则估算有效期至 ${estimatedDueDate}` : "暂无法自动估算有效期"
      : calculation?.title ?? "车辆情况需要专员确认";
    const recommendation = !validityConfirmed
      ? estimatedDueDate
        ? "已根据登记日期和车辆档案完成规则估算；预约前请通过交管12123或行驶证核对官方有效期。"
        : "当前车辆资料不足以安全估算，请先补充信息或通过交管12123核验。"
      : calculation?.canBookInspection
        ? "已根据用户确认日期与公开规则完成对照，可继续确认材料并预约。"
        : calculation?.summary ?? "建议先完成官方核验，再安排办理。";

    return {
      data: {
        vehicleId: request.params.vehicleId,
        inspectionDueDate: dueDate,
        inspectionDueDateSource: String(row.inspection_due_date_source ?? "legacy_unverified"),
        inspectionValidity: validity,
        dueDays,
        eligibility,
        eligibilityLabel,
        title,
        recommendation,
        canBook: bookingCalculation?.canBookInspection ?? false,
        applicationWindow: calculation?.applicationWindow ?? null,
        dateEvidence: calculation?.dateEvidence ?? ruleCalculation.dateEvidence ?? {
          estimate: null,
          confirmation: null,
          comparison: "not_provided",
          decisionBasis: "official_verification",
          explanation: "历史到期日没有可信来源，不能用于倒计时或开放预约。",
        },
        materials: [
          { id: "registration", name: "机动车行驶证", description: "请携带原件", required: true, ready: false },
          { id: "insurance", name: "交强险凭证", description: "支持电子保单核验（演示）", required: true, ready: false },
          { id: "tax", name: "车船税凭证", description: "已随交强险缴纳可免提供", required: false, ready: false },
          { id: "warning-triangle", name: "三角警示牌", description: "到站前请放置在车内", required: true, ready: false },
        ],
        ruleSource: "公安交管部门公开办事指南（政策测算演示口径）",
        ruleUpdatedAt: INSPECTION_POLICY.reviewedAt,
        disclaimer: INSPECTION_DISCLAIMER,
      },
    };
  });

  app.get<{
    Querystring: { district?: string; originLat?: string; originLng?: string; originType?: string };
  }>("/api/stations", async (request) => {
    const district = request.query.district?.trim();
    const origin = routeOriginFromStationQuery(request.query);
    const rows = district
      ? await database
          .prepare<Row>(`
            SELECT * FROM stations
            WHERE district = ? AND is_active = 1
            ORDER BY is_pinned DESC, sort_priority DESC, id ASC
          `)
          .all(district)
      : await database.prepare<Row>(`
          SELECT * FROM stations
          WHERE is_active = 1
          ORDER BY is_pinned DESC, sort_priority DESC, id ASC
        `).all();
    const routes = await calculateRouteMetrics(origin, rows, mapRuntime);
    const stations = rows.map((row, index) => ({ row, route: routes[index]! }));
    stations.sort((left, right) => {
      if (String(left.row.id) === HUAYANG_STATION_ID && String(right.row.id) !== HUAYANG_STATION_ID) return -1;
      if (String(right.row.id) === HUAYANG_STATION_ID && String(left.row.id) !== HUAYANG_STATION_ID) return 1;
      const pinned = Number(right.row.is_pinned ?? 0) - Number(left.row.is_pinned ?? 0);
      if (pinned !== 0) return pinned;
      const priority = Number(right.row.sort_priority ?? 0) - Number(left.row.sort_priority ?? 0);
      if (priority !== 0) return priority;
      if (left.route.distanceKm !== null && right.route.distanceKm !== null) {
        const distance = left.route.distanceKm - right.route.distanceKm;
        if (distance !== 0) return distance;
      }
      return String(left.row.id).localeCompare(String(right.row.id));
    });
    return {
      data: stations.map(({ row, route }) => stationFromRow(row, route)),
      meta: {
        originType: origin?.type ?? null,
        distanceNotice: origin ? undefined : "确定起点后计算",
      },
    };
  });

  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    "/api/stations/:id/slots",
    async (request) => {
      if (!await getStationRow(database, request.params.id)) {
        throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
      }
      const date = request.query.date;
      if (date && !isRealIsoDate(date)) {
        throw new ApiProblem(400, "INVALID_DATE", "日期格式无效", { date: "请使用 YYYY-MM-DD 格式" });
      }

      const rows = date
        ? await database
            .prepare<Row>(`
              SELECT * FROM station_slots
              WHERE station_id = ? AND date = ?
              ORDER BY start_time ASC
            `)
            .all(request.params.id, date)
        : await database
            .prepare<Row>(`
              SELECT * FROM station_slots
              WHERE station_id = ? AND date >= ?
              ORDER BY date ASC, start_time ASC
            `)
            .all(request.params.id, todayIso());
      const now = currentSlotTime();
      return { data: rows.filter((row) => !inspectionSlotHasStarted(row, now)).map(slotFromRow) };
    },
  );

  app.get<{ Querystring: { status?: string } }>("/api/bookings", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const allowedStatuses = [
      "confirmed",
      "awaiting_arrival",
      "checked_in",
      "inspecting",
      "result_received",
      "completed",
      "on_hold",
      "cancelled",
      "no_show",
    ];
    const status = request.query.status;
    if (status && !allowedStatuses.includes(status)) {
      throw new ApiProblem(400, "INVALID_STATUS", "预约状态无效");
    }
    const rows = status
      ? await database
          .prepare("SELECT * FROM bookings WHERE user_id = ? AND status = ? ORDER BY created_at DESC")
          .all(userId, status) as Row[]
      : await database
          .prepare("SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC")
          .all(userId) as Row[];
    return {
      data: await Promise.all(rows.map(async (row) => {
        const booking = bookingFromRow(row);
        const station = await getStationRow(database, String(row.station_id));
        const vehicle = await getVehicleRowAny(database, String(row.vehicle_id), true);
        return {
          ...booking,
          station: booking.stationSnapshot ?? (station ? stationFromRow(station) : undefined),
          vehicle: booking.vehicleSnapshot ?? (vehicle ? vehicleFromRow(vehicle) : undefined),
        };
      })),
    };
  });

  app.post("/api/bookings", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(createBookingSchema, request.body, reply);
    if (!body) return;

    if (body.serviceMode === "valet" && !body.pickupAddress) {
      throw new ApiProblem(400, "PICKUP_ADDRESS_REQUIRED", "上门代驾必须从联想结果选择精确取车地址", {
        pickupAddress: "请选择一个天津地址联想结果",
      });
    }
    const pickupAddress = body.serviceMode === "valet"
      ? verifiedAnnualPickupAddress(body.pickupAddress!)
      : body.pickupAddress;
    const vehicleForQuote = await getVehicleRow(database, body.vehicleId, userId);
    if (!vehicleForQuote) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
    assertNoConfirmedInspectionDateConflict(vehicleForQuote);
    const media = await assertBookingMedia(database, body.mediaIds, userId, body.serviceMode);
    const stationForQuote = await getStationRow(database, body.stationId);
    if (!stationForQuote || !bool(stationForQuote.is_active)) {
      throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到可预约的检测站");
    }
    const requestedSnapshotId = body.quoteSnapshotId;
    let quote: Awaited<ReturnType<typeof calculateQuote>>;
    let quoteSnapshotId: string;
    let quoteExpiresAt: string;
    let sourceSnapshot: Row;
    const snapshot = await database.prepare<Row>(`
      SELECT * FROM quote_snapshots
      WHERE id = ? AND user_id = ? AND vehicle_id = ? AND station_id = ? AND service_mode = ?
    `).get(requestedSnapshotId, userId, body.vehicleId, body.stationId, body.serviceMode);
    if (!snapshot) throw new ApiProblem(404, "QUOTE_SNAPSHOT_NOT_FOUND", "报价快照不存在或与本次预约不匹配");
    if (String(snapshot.expires_at) <= new Date().toISOString()) {
      throw new ApiProblem(409, "QUOTE_EXPIRED", "报价已过期，请重新获取");
    }
    if (body.serviceMode === "valet" && String(snapshot.trip_type) !== body.tripType) {
      throw new ApiProblem(409, "QUOTE_TRIP_TYPE_MISMATCH", "取送方式与报价不一致");
    }
    if (body.serviceMode === "valet") {
      let snapshotPickup: z.infer<typeof pickupAddressSchema> | undefined;
      try {
        snapshotPickup = pickupAddressSchema.parse(JSON.parse(String(snapshot.pickup_address_json ?? "null")));
      } catch {
        snapshotPickup = undefined;
      }
      if (
        !snapshotPickup
        || snapshotPickup.poiId !== pickupAddress!.poiId
        || Math.abs(snapshotPickup.latitude - pickupAddress!.latitude) > 0.000001
        || Math.abs(snapshotPickup.longitude - pickupAddress!.longitude) > 0.000001
      ) {
        throw new ApiProblem(409, "QUOTE_PICKUP_MISMATCH", "取车地址与报价不一致，请重新获取报价");
      }
    }
    assertQuoteVehicleIsCurrent(snapshot, vehicleForQuote);
    quote = await quoteFromSnapshot(database, snapshot) as Awaited<ReturnType<typeof calculateQuote>>;
    quoteSnapshotId = String(snapshot.id);
    quoteExpiresAt = String(snapshot.expires_at);
    sourceSnapshot = snapshot;
    if (!quote.serviceable) {
      if (quote.pricingEligibility === "manual_review") {
        throw new ApiProblem(409, "PRICE_REVIEW_REQUIRED", "该车型暂不支持在线报价，请联系客服");
      }
      const maxRadius = "rule" in quote ? quote.rule?.maxRadiusKm : null;
      throw new ApiProblem(409, "PICKUP_OUT_OF_RANGE", maxRadius == null ? "当前取车点暂不可服务" : `取车点超出 ${maxRadius} 公里服务范围`);
    }
    if (
      body.quote &&
      (body.quote.inspectionFeeFen !== quote.inspectionFeeFen ||
        body.quote.valetFeeFen !== quote.valetFeeFen ||
        body.quote.serviceFeeFen !== quote.serviceFeeFen)
    ) {
      throw new ApiProblem(409, "QUOTE_CHANGED", "价格配置已更新，请确认最新报价后再提交");
    }
    const id = randomUUID();
    await runTransaction(database, async (tx) => {
      const lockedSnapshot = await tx.prepare<Row>(`
        SELECT id, expires_at FROM quote_snapshots
        WHERE id = ? AND user_id = ? AND vehicle_id = ? AND station_id = ? AND service_mode = ?
        FOR UPDATE
      `).get(requestedSnapshotId, userId, body.vehicleId, body.stationId, body.serviceMode);
      if (!lockedSnapshot) {
        throw new ApiProblem(404, "QUOTE_SNAPSHOT_NOT_FOUND", "报价快照不存在或与本次预约不匹配");
      }
      if (String(lockedSnapshot.expires_at) <= new Date().toISOString()) {
        throw new ApiProblem(409, "QUOTE_EXPIRED", "报价已过期，请重新获取");
      }
      const vehicle = await tx
        .prepare<Row>("SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE")
        .get(body.vehicleId, userId);
      if (!vehicle) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
      assertQuoteVehicleIsCurrent(sourceSnapshot, vehicle);
      const station = await getStationRow(tx, body.stationId);
      if (!station || !bool(station.is_active)) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到可预约的检测站");
      const slot = await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ? FOR UPDATE").get(body.slotId);
      if (!slot || String(slot.station_id) !== body.stationId) {
        throw new ApiProblem(404, "SLOT_NOT_FOUND", "未找到该站点的预约时段");
      }
      if (inspectionSlotHasStarted(slot, currentSlotTime())) {
        throw new ApiProblem(409, "SLOT_EXPIRED", "该预约时段已过期");
      }
      if (Number(slot.booked_count) >= Number(slot.capacity)) {
        throw new ApiProblem(409, "SLOT_FULL", "该时段已约满，请选择其他时段");
      }
      const activeBooking = await tx
        .prepare(`
          SELECT id FROM bookings
          WHERE vehicle_id = ? AND status NOT IN ('completed', 'cancelled', 'no_show') LIMIT 1
        `)
        .get(body.vehicleId);
      if (activeBooking) {
        throw new ApiProblem(409, "VEHICLE_HAS_ACTIVE_BOOKING", "该车辆已有进行中的预约");
      }

      const now = new Date().toISOString();
      await tx
        .prepare(`
          INSERT INTO bookings (
            id, booking_number, user_id, vehicle_id, station_id, slot_id,
            contact_name, contact_phone, service_fee_fen, inspection_fee_fen, valet_fee_fen,
            service_mode, vehicle_price_category, quote_distance_km, quote_source, status,
            appointment_date, start_time, end_time, notes,
            pickup_poi_id, pickup_title, pickup_address, pickup_district,
            pickup_latitude, pickup_longitude, pickup_detail, pickup_note,
            created_at, updated_at, cancelled_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed',
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
          )
        `)
        .run(
          id,
          bookingNumber(),
          userId,
          body.vehicleId,
          body.stationId,
          body.slotId,
          body.contactName,
          body.contactPhone,
          quote.serviceFeeFen,
          quote.inspectionFeeFen,
          quote.valetFeeFen,
          body.serviceMode,
          quote.vehiclePriceCategory,
          quote.distanceKm,
          quote.distanceSource ?? "station_price",
          String(slot.date),
          String(slot.start_time),
          String(slot.end_time),
          body.notes ?? null,
          pickupAddress?.poiId ?? null,
          pickupAddress?.title ?? null,
          pickupAddress?.address ?? null,
          pickupAddress?.district ?? null,
          pickupAddress?.latitude ?? null,
          pickupAddress?.longitude ?? null,
          pickupAddress?.detail ?? null,
          pickupAddress?.note ?? null,
          now,
          now,
        );
      const rule = "rule" in quote ? quote.rule : undefined;
      await tx.prepare(`
        UPDATE bookings SET
          quote_snapshot_id = ?, trip_type = ?, one_way_distance_km = ?,
          round_trip_distance_km = ?, billable_distance_km = ?, quote_extra_km = ?,
          price_plan_id = ?, pricing_eligibility = ?, inspection_items_json = ?,
          valet_base_fee_fen = ?, valet_distance_fee_fen = ?, rule_scope = ?,
          rule_station_id = ?, rule_base_fee_fen = ?, rule_included_km = ?,
          rule_per_km_fen = ?, rule_max_radius_km = ?, quote_expires_at = ?,
          payment_status = 'unpaid', fulfillment_status = 'pending_payment',
          evidence_policy_version = ?,
          pricing_snapshot_version = ?, vehicle_snapshot_json = ?, vehicle_facts_version = ?,
          vehicle_facts_hash = ?, station_snapshot_json = ?, price_plan_snapshot_json = ?,
          inspection_item_amounts_json = ?, rule_snapshot_json = ?, rule_updated_at = ?,
          rule_version = ?
        WHERE id = ?
      `).run(
        quoteSnapshotId,
        quote.tripType,
        quote.oneWayDistanceKm,
        quote.roundTripDistanceKm,
        quote.billableDistanceKm,
        quote.extraKm,
        quote.matchedPricePlan?.id ?? null,
        quote.pricingEligibility,
        JSON.stringify(quote.inspectionItems),
        quote.breakdown.valetBaseFeeFen,
        quote.breakdown.valetDistanceFeeFen,
        rule?.scope ?? null,
        rule?.stationId ?? null,
        rule?.baseFeeFen ?? null,
        rule?.includedKm ?? null,
        rule?.perKmFen ?? null,
        rule?.maxRadiusKm ?? null,
        quoteExpiresAt,
        body.serviceMode === "valet" ? VALET_EVIDENCE_POLICY_VERSION : "not_applicable",
        sourceSnapshot.snapshot_version == null ? null : String(sourceSnapshot.snapshot_version),
        sourceSnapshot.vehicle_snapshot_json == null ? null : String(sourceSnapshot.vehicle_snapshot_json),
        sourceSnapshot.vehicle_facts_version == null ? null : String(sourceSnapshot.vehicle_facts_version),
        sourceSnapshot.vehicle_facts_hash == null ? null : String(sourceSnapshot.vehicle_facts_hash),
        sourceSnapshot.station_snapshot_json == null ? null : String(sourceSnapshot.station_snapshot_json),
        sourceSnapshot.price_plan_snapshot_json == null ? null : String(sourceSnapshot.price_plan_snapshot_json),
        sourceSnapshot.inspection_item_amounts_json == null ? null : String(sourceSnapshot.inspection_item_amounts_json),
        sourceSnapshot.rule_snapshot_json == null ? null : String(sourceSnapshot.rule_snapshot_json),
        sourceSnapshot.rule_updated_at == null ? null : String(sourceSnapshot.rule_updated_at),
        sourceSnapshot.rule_version == null ? null : String(sourceSnapshot.rule_version),
        id,
      );
      await tx.prepare(`
        INSERT INTO booking_ledger_entries (
          id, booking_id, kind, amount_fen, description, actor_type,
          payment_id, idempotency_key, created_at
        ) VALUES (?, ?, 'booking_charge', ?, '预约服务费', 'system', NULL, 'initial-booking-charge', ?)
      `).run(randomUUID(), id, quote.serviceFeeFen, now);
      const boundExpiry = "9999-12-31T23:59:59.999Z";
      const bindMedia = tx.prepare(`
        UPDATE booking_media SET booking_id = ?, bound_at = ?, expires_at = ?
        WHERE id = ? AND user_id = ? AND booking_id IS NULL
      `);
      for (const item of media) {
        const bound = await bindMedia.run(id, now, boundExpiry, String(item.id), userId);
        if (bound.changes !== 1) {
          throw new ApiProblem(409, "MEDIA_NOT_AVAILABLE", "照片已被使用或发生变化，请重新选择");
        }
      }
      const reserved = await tx
        .prepare("UPDATE station_slots SET booked_count = booked_count + 1 WHERE id = ? AND booked_count < capacity")
        .run(body.slotId);
      if (reserved.changes !== 1) throw new ApiProblem(409, "SLOT_FULL", "该时段已约满，请选择其他时段");
      await enableAnnualWorkflowForBooking(tx, id, {
        now: new Date(now),
        actorType: "owner",
        actorId: userId,
      });
      await insertEvent(
        tx,
        id,
        "pending_payment",
        "预约已创建",
        "检测站与服务时段已暂时保留，支付成功后预约将自动确认",
        now,
        "owner",
      );
    });

    return reply.status(201).send({ data: await getBooking(database, id, userId) });
  });

  app.get<{ Params: { id: string } }>("/api/bookings/:id", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const booking = await getBooking(database, request.params.id, userId);
    if (!booking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    return { data: booking };
  });

  app.post<{ Params: { id: string } }>("/api/bookings/:id/requote", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(requoteBookingSchema, request.body, reply);
    if (!body) return;

    const current = await getBookingRow(database, request.params.id, userId);
    if (!current) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    if (
      String(current.fulfillment_status) !== "pending_payment"
      || String(current.payment_status ?? "unpaid") !== "unpaid"
    ) {
      throw new ApiProblem(409, "BOOKING_REQUOTE_NOT_ALLOWED", "只有待支付订单可以更新报价");
    }
    if (String(current.quote_snapshot_id ?? "") !== body.expectedQuoteSnapshotId) {
      throw new ApiProblem(409, "BOOKING_QUOTE_CHANGED", "订单报价已更新，请刷新后确认最新金额");
    }

    const vehicle = await getVehicleRow(database, String(current.vehicle_id), userId);
    if (!vehicle) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
    assertNoConfirmedInspectionDateConflict(vehicle);
    const station = await getStationRow(database, String(current.station_id));
    if (!station || !bool(station.is_active)) {
      throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到可预约的检测站");
    }
    const slot = await getSlotRow(database, String(current.slot_id));
    if (!slot || String(slot.station_id) !== String(current.station_id)) {
      throw new ApiProblem(404, "SLOT_NOT_FOUND", "未找到该站点的预约时段");
    }
    if (inspectionSlotHasStarted(slot, currentSlotTime())) {
      throw new ApiProblem(409, "SLOT_EXPIRED", "该预约时段已过期，请取消订单后重新选择时段");
    }

    const serviceMode = serviceModeSchema.parse(String(current.service_mode));
    const tripType = serviceMode === "valet"
      ? valetTripTypeSchema.parse(String(current.trip_type))
      : "round_trip_same_address" as const;
    if (serviceMode === "valet" && tripType !== "round_trip_same_address") {
      throw new ApiProblem(409, "BOOKING_REQUOTE_NOT_ALLOWED", "旧版单程代驾订单不能在线更新报价");
    }
    const pickupAddress = serviceMode === "valet"
      ? pickupAddressSchema.parse({
          poiId: current.pickup_poi_id,
          title: current.pickup_title,
          address: current.pickup_address,
          district: current.pickup_district,
          latitude: Number(current.pickup_latitude),
          longitude: Number(current.pickup_longitude),
          source: "tencent",
          detail: current.pickup_detail == null ? undefined : String(current.pickup_detail),
          note: current.pickup_note == null ? undefined : String(current.pickup_note),
        })
      : undefined;
    const quote = await calculateQuote(
      database,
      vehicle,
      station,
      serviceMode,
      pickupAddress,
      undefined,
      tripType,
      mapRuntime,
    );
    if (!quote.serviceable) {
      if (quote.pricingEligibility === "manual_review") {
        throw new ApiProblem(409, "PRICE_REVIEW_REQUIRED", "该车型暂不支持在线报价，请联系客服");
      }
      const maxRadius = "rule" in quote ? quote.rule?.maxRadiusKm : null;
      throw new ApiProblem(
        409,
        "PICKUP_OUT_OF_RANGE",
        maxRadius == null ? "当前取车点暂不可服务" : `取车点超出 ${maxRadius} 公里服务范围`,
      );
    }
    const persisted = await runTransaction(database, async (tx) => {
      const lockedBooking = await tx.prepare<Row>(`
        SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE
      `).get(request.params.id, userId);
      if (!lockedBooking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      if (
        String(lockedBooking.fulfillment_status) !== "pending_payment"
        || String(lockedBooking.payment_status ?? "unpaid") !== "unpaid"
      ) {
        throw new ApiProblem(409, "BOOKING_REQUOTE_NOT_ALLOWED", "只有待支付订单可以更新报价");
      }
      if (String(lockedBooking.quote_snapshot_id ?? "") !== body.expectedQuoteSnapshotId) {
        throw new ApiProblem(409, "BOOKING_QUOTE_CHANGED", "订单报价已更新，请刷新后确认最新金额");
      }
      const payment = await tx.prepare<Row>(
        "SELECT id FROM booking_payments WHERE booking_id = ? LIMIT 1",
      ).get(request.params.id);
      if (payment) {
        throw new ApiProblem(409, "BOOKING_REQUOTE_NOT_ALLOWED", "订单已有支付记录，不能更新基础报价");
      }
      const lockedVehicle = await tx.prepare<Row>(`
        SELECT * FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE
      `).get(String(lockedBooking.vehicle_id), userId);
      if (!lockedVehicle) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
      const appliedSnapshot = await persistQuoteSnapshot(
        tx,
        userId,
        String(lockedBooking.vehicle_id),
        String(lockedBooking.station_id),
        quote,
        pickupAddress,
      );
      const sourceSnapshot = await tx.prepare<Row>(`
        SELECT * FROM quote_snapshots WHERE id = ? AND user_id = ?
      `).get(appliedSnapshot.quoteSnapshotId, userId);
      if (!sourceSnapshot) {
        throw new ApiProblem(500, "QUOTE_PERSISTENCE_FAILED", "新报价保存失败，请重试");
      }
      assertQuoteVehicleIsCurrent(sourceSnapshot, lockedVehicle);
      if (String(sourceSnapshot.expires_at) <= new Date().toISOString()) {
        throw new ApiProblem(409, "QUOTE_EXPIRED", "新报价已过期，请重新更新报价");
      }

      const rule = "rule" in quote ? quote.rule : undefined;
      const now = new Date().toISOString();
      await tx.prepare(`
        UPDATE bookings SET
          service_fee_fen = ?, inspection_fee_fen = ?, valet_fee_fen = ?,
          vehicle_price_category = ?, quote_distance_km = ?, quote_source = ?,
          quote_snapshot_id = ?, trip_type = ?, one_way_distance_km = ?,
          round_trip_distance_km = ?, billable_distance_km = ?, quote_extra_km = ?,
          price_plan_id = ?, pricing_eligibility = ?, inspection_items_json = ?,
          valet_base_fee_fen = ?, valet_distance_fee_fen = ?, rule_scope = ?,
          rule_station_id = ?, rule_base_fee_fen = ?, rule_included_km = ?,
          rule_per_km_fen = ?, rule_max_radius_km = ?, quote_expires_at = ?,
          pricing_snapshot_version = ?, vehicle_snapshot_json = ?, vehicle_facts_version = ?,
          vehicle_facts_hash = ?, station_snapshot_json = ?, price_plan_snapshot_json = ?,
          inspection_item_amounts_json = ?, rule_snapshot_json = ?, rule_updated_at = ?,
          rule_version = ?, updated_at = ?
        WHERE id = ?
      `).run(
        quote.serviceFeeFen,
        quote.inspectionFeeFen,
        quote.valetFeeFen,
        quote.vehiclePriceCategory,
        quote.distanceKm,
        quote.distanceSource ?? "station_price",
        appliedSnapshot.quoteSnapshotId,
        quote.tripType,
        quote.oneWayDistanceKm,
        quote.roundTripDistanceKm,
        quote.billableDistanceKm,
        quote.extraKm,
        quote.matchedPricePlan?.id ?? null,
        quote.pricingEligibility,
        JSON.stringify(quote.inspectionItems),
        quote.breakdown.valetBaseFeeFen,
        quote.breakdown.valetDistanceFeeFen,
        rule?.scope ?? null,
        rule?.stationId ?? null,
        rule?.baseFeeFen ?? null,
        rule?.includedKm ?? null,
        rule?.perKmFen ?? null,
        rule?.maxRadiusKm ?? null,
        appliedSnapshot.expiresAt,
        sourceSnapshot.snapshot_version == null ? null : String(sourceSnapshot.snapshot_version),
        sourceSnapshot.vehicle_snapshot_json == null ? null : String(sourceSnapshot.vehicle_snapshot_json),
        sourceSnapshot.vehicle_facts_version == null ? null : String(sourceSnapshot.vehicle_facts_version),
        sourceSnapshot.vehicle_facts_hash == null ? null : String(sourceSnapshot.vehicle_facts_hash),
        sourceSnapshot.station_snapshot_json == null ? null : String(sourceSnapshot.station_snapshot_json),
        sourceSnapshot.price_plan_snapshot_json == null ? null : String(sourceSnapshot.price_plan_snapshot_json),
        sourceSnapshot.inspection_item_amounts_json == null ? null : String(sourceSnapshot.inspection_item_amounts_json),
        sourceSnapshot.rule_snapshot_json == null ? null : String(sourceSnapshot.rule_snapshot_json),
        sourceSnapshot.rule_updated_at == null ? null : String(sourceSnapshot.rule_updated_at),
        sourceSnapshot.rule_version == null ? null : String(sourceSnapshot.rule_version),
        now,
        request.params.id,
      );
      const chargeUpdated = await tx.prepare(`
        UPDATE booking_ledger_entries SET amount_fen = ?
        WHERE booking_id = ? AND kind = 'booking_charge'
          AND idempotency_key = 'initial-booking-charge'
          AND confirmation_status = 'confirmed'
      `).run(quote.serviceFeeFen, request.params.id);
      if (chargeUpdated.changes !== 1) {
        throw new ApiProblem(409, "BOOKING_REQUOTE_NOT_ALLOWED", "订单基础费用记录异常，不能在线更新报价");
      }
      await insertEvent(
        tx,
        request.params.id,
        "pending_payment",
        "订单报价已更新",
        `最新应付金额为 ¥${(quote.serviceFeeFen / 100).toFixed(2)}，预约时段继续保留`,
        now,
        "owner",
        {
          previousQuoteSnapshotId: body.expectedQuoteSnapshotId,
          quoteSnapshotId: appliedSnapshot.quoteSnapshotId,
          previousAmountFen: Number(lockedBooking.service_fee_fen),
          amountFen: quote.serviceFeeFen,
        },
      );
      return appliedSnapshot;
    });

    return {
      data: {
        booking: await getBooking(database, request.params.id, userId),
        quote: { ...quote, ...persisted },
      },
    };
  });

  app.post<{ Params: { id: string } }>("/api/bookings/:id/payments", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(paymentSchema, request.body, reply);
    if (!body) return;
    const mockAllowed = process.env.NODE_ENV !== "production" || process.env.ALLOW_MOCK_PAYMENT === "true";
    if (!mockAllowed) {
      throw new ApiProblem(503, "MOCK_PAYMENT_DISABLED", "当前环境未启用模拟支付");
    }
    if (process.env.PAYMENT_PROVIDER && process.env.PAYMENT_PROVIDER !== "mock") {
      throw new ApiProblem(503, "PAYMENT_PROVIDER_UNAVAILABLE", "当前支付提供方不可用");
    }
    const bookingRow = await getBookingRow(database, request.params.id, userId);
    if (!bookingRow) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    const existing = await database.prepare<Row>(`
      SELECT * FROM booking_payments WHERE provider = ? AND idempotency_key = ?
    `).get(body.provider, body.idempotencyKey);
    if (existing) {
      if (String(existing.booking_id) !== request.params.id) {
        throw new ApiProblem(409, "PAYMENT_IDEMPOTENCY_CONFLICT", "支付幂等键已用于其他订单");
      }
      return { data: { booking: await getBooking(database, request.params.id, userId), payment: paymentFromRow(existing) } };
    }
    if (bookingIsTerminal(bookingRow)) {
      throw new ApiProblem(409, "PAYMENT_NOT_ALLOWED", "当前订单状态不能继续支付");
    }
    let financials = await bookingFinancials(database, request.params.id);
    const hasConfirmedPayment = financials.payments.some((payment) => payment.status === "confirmed");
    const hasConfirmedSupplement = financials.ledgerEntries.some((entry) =>
      entry.amountFen > 0
      && entry.confirmationStatus === "confirmed"
      && !["booking_charge", "legacy_booking_charge"].includes(entry.kind),
    );
    const isConfirmedSupplementPayment = hasConfirmedPayment
      && hasConfirmedSupplement
      && financials.amountDueFen > 0;
    const snapshot = bookingRow.quote_snapshot_id == null
      ? undefined
      : await database.prepare<Row>("SELECT * FROM quote_snapshots WHERE id = ? AND user_id = ?").get(String(bookingRow.quote_snapshot_id), userId);
    const expectedPaymentQuoteSnapshotId = String(body.quoteSnapshotId ?? "");
    if (String(bookingRow.fulfillment_status) !== "legacy" && !isConfirmedSupplementPayment) {
      if (!expectedPaymentQuoteSnapshotId) {
        throw new ApiProblem(409, "PAYMENT_QUOTE_REQUIRED", "请先确认当前订单报价后再支付");
      }
      if (String(bookingRow.quote_snapshot_id ?? "") !== expectedPaymentQuoteSnapshotId) {
        throw new ApiProblem(409, "BOOKING_QUOTE_CHANGED", "订单报价已更新，请确认最新金额后重新支付");
      }
      const bookingExpiresAt = String(bookingRow.quote_expires_at ?? "");
      const snapshotExpiresAt = String(snapshot?.expires_at ?? "");
      const now = new Date().toISOString();
      if (!snapshot || !bookingExpiresAt || !snapshotExpiresAt || bookingExpiresAt <= now || snapshotExpiresAt <= now) {
        throw new ApiProblem(409, "QUOTE_EXPIRED", "报价已过期，请先更新订单报价再支付");
      }
    }
    if (String(bookingRow.service_mode) === "valet") {
      if (
        !snapshot
        || String(bookingRow.quote_source) !== "tencent_matrix"
        || String(bookingRow.trip_type) !== "round_trip_same_address"
        || String(snapshot.distance_source) !== "tencent_matrix"
        || String(snapshot.trip_type) !== "round_trip_same_address"
        || String(snapshot.service_mode) !== "valet"
      ) {
        throw new ApiProblem(503, "REAL_ROUTE_REQUIRED", "订单缺少有效的腾讯真实往返路线报价，暂不能支付上门取送订单", {
          mapErrorCode: "TENCENT_UNAVAILABLE",
        });
      }
    }
    const now = new Date().toISOString();
    let paymentCreated = false;
    await runTransaction(database, async (tx) => {
      const lockedBooking = await tx
        .prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE")
        .get(request.params.id, userId);
      if (!lockedBooking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      if (bookingIsTerminal(lockedBooking)) {
        throw new ApiProblem(409, "PAYMENT_NOT_ALLOWED", "当前订单状态不能继续支付");
      }
      const concurrentExisting = await tx.prepare<Row>(`
        SELECT * FROM booking_payments WHERE provider = ? AND idempotency_key = ?
      `).get(body.provider, body.idempotencyKey);
      if (concurrentExisting) {
        if (String(concurrentExisting.booking_id) !== request.params.id) {
          throw new ApiProblem(409, "PAYMENT_IDEMPOTENCY_CONFLICT", "支付幂等键已用于其他订单");
        }
        return;
      }
      financials = await bookingFinancials(tx, request.params.id);
      if (financials.chargedFen === 0) {
        await tx.prepare(`
          INSERT INTO booking_ledger_entries (
            id, booking_id, kind, amount_fen, description, actor_type,
            payment_id, idempotency_key, created_at
          ) VALUES (?, ?, 'legacy_booking_charge', ?, '旧订单服务费', 'system', NULL, 'legacy-booking-charge', ?)
        `).run(randomUUID(), request.params.id, Number(lockedBooking.service_fee_fen), now);
        financials = await bookingFinancials(tx, request.params.id);
      }
      const lockedHasConfirmedPayment = financials.payments.some((payment) => payment.status === "confirmed");
      const lockedHasConfirmedSupplement = financials.ledgerEntries.some((entry) =>
        entry.amountFen > 0
        && entry.confirmationStatus === "confirmed"
        && !["booking_charge", "legacy_booking_charge"].includes(entry.kind),
      );
      const lockedSupplementPayment = lockedHasConfirmedPayment
        && lockedHasConfirmedSupplement
        && financials.amountDueFen > 0;
      if (String(lockedBooking.fulfillment_status) !== "legacy" && !lockedSupplementPayment) {
        if (String(lockedBooking.quote_snapshot_id ?? "") !== expectedPaymentQuoteSnapshotId) {
          throw new ApiProblem(409, "BOOKING_QUOTE_CHANGED", "订单报价已更新，请确认最新金额后重新支付");
        }
        const lockedSnapshot = lockedBooking.quote_snapshot_id == null
          ? undefined
          : await tx.prepare<Row>(`
              SELECT * FROM quote_snapshots WHERE id = ? AND user_id = ?
            `).get(String(lockedBooking.quote_snapshot_id), userId);
        const lockedBookingExpiresAt = String(lockedBooking.quote_expires_at ?? "");
        const lockedSnapshotExpiresAt = String(lockedSnapshot?.expires_at ?? "");
        const paymentNow = new Date().toISOString();
        if (
          !lockedSnapshot
          || !lockedBookingExpiresAt
          || !lockedSnapshotExpiresAt
          || lockedBookingExpiresAt <= paymentNow
          || lockedSnapshotExpiresAt <= paymentNow
        ) {
          throw new ApiProblem(409, "QUOTE_EXPIRED", "报价已过期，请先更新订单报价再支付");
        }
      }
      if (financials.amountDueFen <= 0) throw new ApiProblem(409, "PAYMENT_NOT_REQUIRED", "订单当前没有待支付金额");
      const paymentId = randomUUID();
      await tx.prepare(`
        INSERT INTO booking_payments (
          id, booking_id, provider, idempotency_key, amount_fen,
          status, created_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)
      `).run(paymentId, request.params.id, body.provider, body.idempotencyKey, financials.amountDueFen, now, now);
      paymentCreated = true;
      const currentFulfillment = String(lockedBooking.fulfillment_status ?? "legacy");
      const submittedForPrecheck = ["pending_payment", "paid_pending_confirmation"].includes(currentFulfillment);
      const updatedFinancials = await bookingFinancials(tx, request.params.id);
      await tx.prepare(`
        UPDATE bookings SET
          payment_status = ?,
          fulfillment_status = CASE
            WHEN fulfillment_status IN ('pending_payment', 'paid_pending_confirmation') THEN 'pending_precheck'
            ELSE fulfillment_status
          END,
          updated_at = ?
        WHERE id = ?
      `).run(paymentStatusFromFinancials(updatedFinancials), now, request.params.id);
      if (submittedForPrecheck) {
        await tx.prepare(`
          INSERT INTO booking_prechecks (
            id, booking_id, station_id, status, submitted_at,
            reason_codes_json, issue_photo_kinds_json, refund_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, '[]', '[]', 'not_requested', ?, ?)
          ON CONFLICT (booking_id) DO NOTHING
        `).run(randomUUID(), request.params.id, String(lockedBooking.station_id), now, now, now);
      }
      await insertEvent(
        tx,
        request.params.id,
        submittedForPrecheck ? "pending_precheck" : currentFulfillment === "legacy" ? String(lockedBooking.status) : currentFulfillment,
        "支付已确认",
        submittedForPrecheck
          ? `已确认模拟支付 ¥${(financials.amountDueFen / 100).toFixed(2)}，订单已提交检测站进行照片预审`
          : `已确认支付 ¥${(financials.amountDueFen / 100).toFixed(2)}`,
        now,
        "owner",
        {
          paymentId,
          provider: body.provider,
          amountFen: financials.amountDueFen,
          idempotencyKey: body.idempotencyKey,
          quoteSnapshotId: lockedBooking.quote_snapshot_id == null ? null : String(lockedBooking.quote_snapshot_id),
          submittedForPrecheck,
        },
      );
      if (submittedForPrecheck) {
        await insertEvent(
          tx,
          request.params.id,
          "pending_precheck",
          "等待检测站预审",
          "检测站将核对行驶证、车辆四角及启动后仪表盘共 7 张预约资料",
          now,
          "system",
          { supervisionSource: "workflow_task" },
        );
      }
    });
    const payment = await database.prepare<Row>(`
      SELECT * FROM booking_payments WHERE provider = ? AND idempotency_key = ?
    `).get(body.provider, body.idempotencyKey);
    if (!payment) throw new ApiProblem(500, "PAYMENT_PERSISTENCE_FAILED", "支付记录保存失败，请重试");
    if (!paymentCreated) {
      return { data: { booking: await getBooking(database, request.params.id, userId), payment: paymentFromRow(payment) } };
    }
    return reply.status(201).send({ data: { booking: await getBooking(database, request.params.id, userId), payment: paymentFromRow(payment) } });
  });

  app.post<{ Params: { id: string; entryId: string } }>("/api/bookings/:id/ledger/:entryId/confirm", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(ledgerConfirmationSchema, request.body, reply);
    if (!body) return;
    const booking = await getBookingRow(database, request.params.id, userId);
    if (!booking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    const entry = await database.prepare<Row>(`
      SELECT * FROM booking_ledger_entries WHERE id = ? AND booking_id = ?
    `).get(request.params.entryId, request.params.id);
    if (!entry) throw new ApiProblem(404, "LEDGER_ENTRY_NOT_FOUND", "未找到该费用调整");
    if (String(entry.kind) !== "surcharge") {
      throw new ApiProblem(409, "LEDGER_ENTRY_NOT_CONFIRMABLE", "仅附加费用需要车主确认");
    }
    if (String(entry.confirmation_status) === "confirmed") {
      if (String(entry.confirmation_idempotency_key ?? "") !== body.idempotencyKey) {
        throw new ApiProblem(409, "LEDGER_CONFIRMATION_CONFLICT", "该附加费用已使用其他幂等键确认");
      }
      return { data: { booking: await getBooking(database, request.params.id, userId), ledgerEntry: ledgerEntryFromRow(entry), idempotent: true } };
    }
    if (bookingIsTerminal(booking)) {
      throw new ApiProblem(409, "LEDGER_CONFIRMATION_NOT_ALLOWED", "当前订单状态不能确认附加费用");
    }
    if (String(entry.confirmation_status) !== "pending_owner_confirmation") {
      throw new ApiProblem(409, "LEDGER_ENTRY_NOT_PENDING", "该附加费用已失效或不再等待车主确认");
    }
    const now = new Date().toISOString();
    let confirmationWasIdempotent = false;
    await runTransaction(database, async (tx) => {
      const lockedBooking = await tx
        .prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE")
        .get(request.params.id, userId);
      if (!lockedBooking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      if (bookingIsTerminal(lockedBooking)) {
        throw new ApiProblem(409, "LEDGER_CONFIRMATION_NOT_ALLOWED", "当前订单状态不能确认附加费用");
      }
      const lockedEntry = await tx.prepare<Row>(`
        SELECT * FROM booking_ledger_entries WHERE id = ? AND booking_id = ? FOR UPDATE
      `).get(request.params.entryId, request.params.id);
      if (!lockedEntry) throw new ApiProblem(404, "LEDGER_ENTRY_NOT_FOUND", "未找到该费用调整");
      if (String(lockedEntry.confirmation_status) === "confirmed") {
        if (String(lockedEntry.confirmation_idempotency_key ?? "") !== body.idempotencyKey) {
          throw new ApiProblem(409, "LEDGER_CONFIRMATION_CONFLICT", "该附加费用已使用其他幂等键确认");
        }
        confirmationWasIdempotent = true;
        return;
      }
      if (String(lockedEntry.kind) !== "surcharge" || String(lockedEntry.confirmation_status) !== "pending_owner_confirmation") {
        throw new ApiProblem(409, "LEDGER_ENTRY_NOT_PENDING", "该附加费用已失效或不再等待车主确认");
      }
      const keyConflict = await tx.prepare<Row>(`
        SELECT id FROM booking_ledger_entries
        WHERE booking_id = ? AND confirmation_idempotency_key = ? AND id <> ?
      `).get(request.params.id, body.idempotencyKey, request.params.entryId);
      if (keyConflict) throw new ApiProblem(409, "LEDGER_CONFIRMATION_CONFLICT", "确认幂等键已用于其他附加费用");
      await tx.prepare(`
        UPDATE booking_ledger_entries SET
          confirmation_status = 'confirmed', confirmation_idempotency_key = ?, confirmed_at = ?
        WHERE id = ? AND booking_id = ?
      `).run(body.idempotencyKey, now, request.params.entryId, request.params.id);
      const financials = await bookingFinancials(tx, request.params.id);
      await tx.prepare("UPDATE bookings SET payment_status = ?, updated_at = ? WHERE id = ?")
        .run(paymentStatusFromFinancials(financials), now, request.params.id);
      await insertEvent(
        tx,
        request.params.id,
        String(lockedBooking.fulfillment_status ?? lockedBooking.status),
        "车主已确认附加费用",
        `已确认附加费用 ¥${(Number(lockedEntry.amount_fen) / 100).toFixed(2)}`,
        now,
        "owner",
        { ledgerEntryId: request.params.entryId, amountFen: Number(lockedEntry.amount_fen), idempotencyKey: body.idempotencyKey },
      );
    });
    const confirmed = await database.prepare<Row>("SELECT * FROM booking_ledger_entries WHERE id = ?").get(request.params.entryId);
    if (!confirmed) throw new ApiProblem(500, "LEDGER_PERSISTENCE_FAILED", "费用确认记录保存失败，请重试");
    return { data: { booking: await getBooking(database, request.params.id, userId), ledgerEntry: ledgerEntryFromRow(confirmed), idempotent: confirmationWasIdempotent } };
  });

  app.post<{ Params: { id: string } }>("/api/bookings/:id/cancel", async (request) => {
    const userId = await requireCurrentUser(request, database);
    await runTransaction(database, async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE").get(request.params.id, userId);
      if (!booking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      await cancelBooking(tx, booking, "owner", true);
    });
    return { data: await getBooking(database, request.params.id, userId) };
  });

  app.post<{ Params: { id: string } }>("/api/bookings/:id/precheck/resubmit", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(z.object({
      expectedVersion: z.number().int().positive(),
      idempotencyKey: z.string().trim().min(8).max(160),
      slotId: idSchema,
      mediaIds: z.array(idSchema).max(7).default([]),
      resolutionNote: z.string().trim().min(5).max(500),
    }).strict(), request.body, reply);
    if (!body) return;
    const hash = createHash("sha256").update(stableJson(body)).digest("hex");
    await runTransaction(database, async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE").get(request.params.id, userId);
      if (!booking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      const precheck = await tx.prepare<Row>("SELECT * FROM booking_prechecks WHERE booking_id = ? FOR UPDATE").get(request.params.id);
      if (!precheck) throw new ApiProblem(404, "PRECHECK_NOT_FOUND", "未找到预检记录");
      if (precheck.resubmission_key === body.idempotencyKey) {
        if (precheck.resubmission_hash !== hash) throw new ApiProblem(409, "PRECHECK_IDEMPOTENCY_CONFLICT", "提交标识已用于其他资料，请刷新后重试");
        return;
      }
      if (booking.fulfillment_status !== "precheck_action_required" || precheck.status !== "rejected" || booking.payment_status !== "paid") {
        throw new ApiProblem(409, "PRECHECK_STATE_CHANGED", "只有预检待处理且未退款的订单可以重新提交");
      }
      if (Number(precheck.version) !== body.expectedVersion) throw new ApiProblem(409, "PRECHECK_VERSION_CONFLICT", "预检内容已更新，请刷新后再提交");
      const slot = await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ? AND station_id = ? FOR UPDATE").get(body.slotId, String(booking.station_id));
      if (!slot) throw new ApiProblem(404, "SLOT_NOT_FOUND", "请选择原检测站的预约时段");
      if (inspectionSlotHasStarted(slot, currentSlotTime())) throw new ApiProblem(409, "SLOT_EXPIRED", "该时段已开始，请选择新的预约时段");
      const station = await getStationRow(tx, String(booking.station_id));
      if (!station || !bool(station.is_active)) throw new ApiProblem(409, "STATION_UNAVAILABLE", "原检测站当前不可预约，可由车主申请退款");
      const vehicle = await getVehicleRow(tx, String(booking.vehicle_id), userId);
      const snapshot = await tx.prepare<Row>("SELECT * FROM quote_snapshots WHERE id = ? AND user_id = ?").get(String(booking.quote_snapshot_id), userId);
      if (!vehicle || !snapshot) throw new ApiProblem(409, "PRECHECK_VEHICLE_UNAVAILABLE", "原车辆或计价快照不可用，请申请退款后重新预约");
      assertQuoteVehicleIsCurrent(snapshot, vehicle);
      // Same vehicle, station and pickup context: retain the paid price snapshot.
      const now = currentTime().toISOString();
      const serviceMode = String(booking.service_mode);
      const allowedMediaKinds = new Set(bookingPrecheckMediaKinds);
      const replacementKinds = new Set<string>();
      const replacements: Row[] = [];
      for (const mediaId of [...body.mediaIds].sort()) {
        const media = await tx.prepare<Row>("SELECT * FROM booking_media WHERE id = ? AND user_id = ? AND booking_id IS NULL FOR UPDATE").get(mediaId, userId);
        if (!media || String(media.expires_at) <= now) throw new ApiProblem(409, "MEDIA_NOT_AVAILABLE", "补充照片已过期或已绑定，请重新上传");
        const mediaKind = String(media.kind);
        if (!allowedMediaKinds.has(mediaKind)) {
          throw new ApiProblem(400, "PRECHECK_MEDIA_KIND_NOT_ALLOWED", "补充照片与预约服务方式不匹配", {
            mediaIds: `本服务方式不应上传：${mediaKind}`,
          });
        }
        if (replacementKinds.has(mediaKind)) throw new ApiProblem(400, "DUPLICATE_MEDIA_KIND", "每个照片位置只能补充一张");
        replacementKinds.add(mediaKind);
        replacements.push(media);
      }
      const currentMedia = await tx.prepare<Row>("SELECT * FROM booking_media WHERE booking_id = ? AND is_current = 1").all(request.params.id);
      const requiredKinds = new Set(jsonArray(precheck.issue_photo_kinds_json).map(String));
      if (!requiredKinds.size) replacements.forEach((item) => requiredKinds.add(String(item.kind)));
      if (!replacements.length || [...requiredKinds].some((kind) => !replacementKinds.has(kind))) {
        throw new ApiProblem(400, "PRECHECK_UPDATED_MEDIA_REQUIRED", "请补拍检测站标注的问题照片；未指定照片时至少补充一张处理后的资料");
      }
      const completeKinds = new Set([...currentMedia.map((item) => String(item.kind)), ...replacementKinds]);
      const missingKinds = [...allowedMediaKinds].filter((kind) => !completeKinds.has(kind));
      if (missingKinds.length) {
        throw new ApiProblem(400, "PRECHECK_MEDIA_INCOMPLETE", "请补齐预约所需照片", {
          mediaIds: `缺少：${missingKinds.join("、")}`,
        });
      }
      for (const media of replacements) {
        await tx.prepare("UPDATE booking_media SET is_current = 0 WHERE booking_id = ? AND kind = ? AND is_current = 1").run(request.params.id, String(media.kind));
        await tx.prepare("UPDATE booking_media SET booking_id = ?, bound_at = ?, expires_at = '9999-12-31T23:59:59.999Z', is_current = 1 WHERE id = ?").run(request.params.id, now, String(media.id));
      }
      const reserved = await tx.prepare("UPDATE station_slots SET booked_count = booked_count + 1 WHERE id = ? AND booked_count < capacity").run(body.slotId);
      if (reserved.changes !== 1) throw new ApiProblem(409, "SLOT_FULL", "该时段已约满，请选择其他时段");
      await tx.prepare(`UPDATE bookings SET status = 'confirmed', fulfillment_status = 'pending_precheck',
        slot_id = ?, appointment_date = ?, start_time = ?, end_time = ?, precheck_slot_released = 0, updated_at = ? WHERE id = ?`)
        .run(body.slotId, String(slot.date), String(slot.start_time), String(slot.end_time), now, request.params.id);
      await tx.prepare(`UPDATE booking_prechecks SET status = 'pending', submitted_at = ?, resolution_note = ?,
        resubmission_key = ?, resubmission_hash = ?, decision_idempotency_key = NULL, decision_hash = NULL,
        version = version + 1, updated_at = ? WHERE booking_id = ?`)
        .run(now, body.resolutionNote, body.idempotencyKey, hash, now, request.params.id);
      await insertEvent(tx, request.params.id, "pending_precheck", "车主已提交预检复核",
        `${body.resolutionNote}；已选择本站新时段，保留原已付价格，等待检测站审核。`, now, "owner",
        { mediaIds: body.mediaIds, previousVersion: body.expectedVersion, slotId: body.slotId });
    });
    return { data: await getBooking(database, request.params.id, userId) };
  });

  app.post<{ Params: { id: string } }>("/api/bookings/:id/reschedule", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(rescheduleSchema, request.body, reply);
    if (!body) return;

    await runTransaction(database, async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE").get(request.params.id, userId);
      if (!booking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      const canonical = String(booking.fulfillment_status ?? "legacy");
      const canReschedule = canonical === "legacy"
        ? ["confirmed", "awaiting_arrival"].includes(String(booking.status))
        : ["pending_payment", "paid_pending_confirmation", "confirmed"].includes(canonical);
      if (!canReschedule) {
        throw new ApiProblem(409, "BOOKING_CANNOT_RESCHEDULE", "当前预约状态不能改期");
      }
      if (String(booking.slot_id) === body.slotId) return;

      const nextSlot = await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ? FOR UPDATE").get(body.slotId);
      if (!nextSlot) throw new ApiProblem(404, "SLOT_NOT_FOUND", "未找到该预约时段");
      if (inspectionSlotHasStarted(nextSlot, currentSlotTime())) {
        throw new ApiProblem(409, "SLOT_EXPIRED", "该预约时段已过期");
      }
      if (Number(nextSlot.booked_count) >= Number(nextSlot.capacity)) {
        throw new ApiProblem(409, "SLOT_FULL", "该时段已约满，请选择其他时段");
      }
      const nextStation = await getStationRow(tx, String(nextSlot.station_id));
      if (!nextStation || !bool(nextStation.is_active)) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到可预约的检测站");

      const snapshotId = body.quoteSnapshotId
        ?? (String(nextSlot.station_id) === String(booking.station_id) ? String(booking.quote_snapshot_id ?? "") : "");
      if (!snapshotId) {
        throw new ApiProblem(409, "RESCHEDULE_QUOTE_REQUIRED", "跨站改期或原报价失效时必须先获取新报价");
      }
      const snapshot = await tx.prepare<Row>(`
        SELECT * FROM quote_snapshots
        WHERE id = ? AND user_id = ? AND vehicle_id = ? AND station_id = ? AND service_mode = ?
      `).get(
        snapshotId,
        userId,
        String(booking.vehicle_id),
        String(nextSlot.station_id),
        String(booking.service_mode),
      );
      if (!snapshot) throw new ApiProblem(404, "QUOTE_SNAPSHOT_NOT_FOUND", "改期报价不存在或与新时段不匹配");
      if (String(snapshot.expires_at) <= new Date().toISOString()) {
        throw new ApiProblem(409, "QUOTE_EXPIRED", "改期报价已过期，请重新获取");
      }
      const currentVehicle = await getVehicleRow(tx, String(booking.vehicle_id), userId);
      if (!currentVehicle) throw new ApiProblem(404, "VEHICLE_NOT_FOUND", "未找到该车辆");
      assertQuoteVehicleIsCurrent(snapshot, currentVehicle);
      if (String(booking.service_mode) === "valet") {
        let snapshotPickup: z.infer<typeof pickupAddressSchema> | undefined;
        try {
          snapshotPickup = pickupAddressSchema.parse(JSON.parse(String(snapshot.pickup_address_json ?? "null")));
        } catch {
          snapshotPickup = undefined;
        }
        if (
          !snapshotPickup
          || snapshotPickup.poiId !== String(booking.pickup_poi_id)
          || Math.abs(snapshotPickup.latitude - Number(booking.pickup_latitude)) > 0.000001
          || Math.abs(snapshotPickup.longitude - Number(booking.pickup_longitude)) > 0.000001
        ) {
          throw new ApiProblem(409, "QUOTE_PICKUP_MISMATCH", "改期报价的取车地址与订单不一致");
        }
      }
      const quote = await quoteFromSnapshot(tx, snapshot);
      if (!quote.serviceable || quote.pricingEligibility !== "supported") {
        throw new ApiProblem(409, "PRICE_REVIEW_REQUIRED", "该车型暂不支持在线改期报价，请联系客服");
      }

      const now = new Date().toISOString();
      await tx
        .prepare("UPDATE station_slots SET booked_count = GREATEST(0, booked_count - 1) WHERE id = ?")
        .run(String(booking.slot_id));
      const reserved = await tx.prepare(
        "UPDATE station_slots SET booked_count = booked_count + 1 WHERE id = ? AND booked_count < capacity",
      ).run(body.slotId);
      if (reserved.changes !== 1) throw new ApiProblem(409, "SLOT_FULL", "该时段已约满，请选择其他时段");
      await tx
        .prepare(`
          UPDATE bookings SET
            station_id = ?, slot_id = ?, appointment_date = ?,
            start_time = ?, end_time = ?, status = 'confirmed',
            service_fee_fen = ?, inspection_fee_fen = ?, valet_fee_fen = ?,
            vehicle_price_category = ?, quote_distance_km = ?, quote_source = ?,
            quote_snapshot_id = ?, trip_type = ?, one_way_distance_km = ?,
            round_trip_distance_km = ?, billable_distance_km = ?, quote_extra_km = ?,
            price_plan_id = ?, pricing_eligibility = ?, inspection_items_json = ?,
            valet_base_fee_fen = ?, valet_distance_fee_fen = ?, rule_scope = ?,
            rule_station_id = ?, rule_base_fee_fen = ?, rule_included_km = ?,
            rule_per_km_fen = ?, rule_max_radius_km = ?, quote_expires_at = ?,
            pricing_snapshot_version = ?, vehicle_snapshot_json = ?, vehicle_facts_version = ?,
            vehicle_facts_hash = ?, station_snapshot_json = ?, price_plan_snapshot_json = ?,
            inspection_item_amounts_json = ?, rule_snapshot_json = ?, rule_updated_at = ?,
            rule_version = ?,
            updated_at = ?
          WHERE id = ?
        `)
        .run(
          String(nextSlot.station_id),
          body.slotId,
          String(nextSlot.date),
          String(nextSlot.start_time),
          String(nextSlot.end_time),
          quote.serviceFeeFen,
          quote.inspectionFeeFen,
          quote.valetFeeFen,
          quote.vehiclePriceCategory,
          quote.distanceKm,
          quote.distanceSource,
          snapshotId,
          quote.tripType,
          quote.oneWayDistanceKm,
          quote.roundTripDistanceKm,
          quote.billableDistanceKm,
          quote.extraKm,
          quote.matchedPricePlan?.id ?? null,
          quote.pricingEligibility,
          JSON.stringify(quote.inspectionItems),
          quote.breakdown.valetBaseFeeFen,
          quote.breakdown.valetDistanceFeeFen,
          "rule" in quote ? quote.rule?.scope ?? null : null,
          "rule" in quote ? quote.rule?.stationId ?? null : null,
          "rule" in quote ? quote.rule?.baseFeeFen ?? null : null,
          "rule" in quote ? quote.rule?.includedKm ?? null : null,
          "rule" in quote ? quote.rule?.perKmFen ?? null : null,
          "rule" in quote ? quote.rule?.maxRadiusKm ?? null : null,
          String(snapshot.expires_at),
          snapshot.snapshot_version == null ? null : String(snapshot.snapshot_version),
          snapshot.vehicle_snapshot_json == null ? null : String(snapshot.vehicle_snapshot_json),
          snapshot.vehicle_facts_version == null ? null : String(snapshot.vehicle_facts_version),
          snapshot.vehicle_facts_hash == null ? null : String(snapshot.vehicle_facts_hash),
          snapshot.station_snapshot_json == null ? null : String(snapshot.station_snapshot_json),
          snapshot.price_plan_snapshot_json == null ? null : String(snapshot.price_plan_snapshot_json),
          snapshot.inspection_item_amounts_json == null ? null : String(snapshot.inspection_item_amounts_json),
          snapshot.rule_snapshot_json == null ? null : String(snapshot.rule_snapshot_json),
          snapshot.rule_updated_at == null ? null : String(snapshot.rule_updated_at),
          snapshot.rule_version == null ? null : String(snapshot.rule_version),
          now,
          request.params.id,
        );
      const priceDifferenceFen = quote.serviceFeeFen - Number(booking.service_fee_fen);
      if (priceDifferenceFen !== 0) {
        await tx.prepare(`
          INSERT INTO booking_ledger_entries (
            id, booking_id, kind, amount_fen, description, actor_type,
            payment_id, idempotency_key, created_at
          ) VALUES (?, ?, 'reschedule_adjustment', ?, '改期报价差额', 'owner', NULL, ?, ?)
        `).run(randomUUID(), request.params.id, priceDifferenceFen, `reschedule-${snapshotId}-${body.slotId}`, now);
        if (priceDifferenceFen < 0) {
          const adjusted = await bookingFinancials(tx, request.params.id);
          const refundable = Math.max(0, Math.min(-priceDifferenceFen, adjusted.paidFen - adjusted.refundedFen - adjusted.chargedFen));
          if (refundable > 0) {
            await tx.prepare(`
              INSERT INTO booking_ledger_entries (
                id, booking_id, kind, amount_fen, description, actor_type,
                payment_id, idempotency_key, created_at
              ) VALUES (?, ?, 'refund', ?, '改期差价退款', 'owner', NULL, ?, ?)
            `).run(randomUUID(), request.params.id, -refundable, `reschedule-refund-${snapshotId}-${body.slotId}`, now);
          }
        }
      }
      const financials = await bookingFinancials(tx, request.params.id);
      const nextFulfillment = canonical !== "legacy" && financials.amountDueFen > 0 ? "pending_payment" : canonical;
      await tx.prepare(`
        UPDATE bookings SET
          fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE ? END,
          payment_status = ?, updated_at = ?
        WHERE id = ?
      `).run(nextFulfillment, paymentStatusFromFinancials(financials), now, request.params.id);
      await insertEvent(
        tx,
        request.params.id,
        nextFulfillment,
        "预约已改期",
        priceDifferenceFen === 0 ? "新的到站时间已确认，价格不变" : "新的到站时间与报价已确认",
        now,
        "owner",
        { previousSlotId: String(booking.slot_id), nextSlotId: body.slotId, snapshotId, priceDifferenceFen },
      );
      // Strategy/template versions stay frozen, but a customer-approved slot
      // change must re-anchor arrival notifications to the new appointment.
      await syncAnnualWorkflowForBooking(tx, request.params.id, {
        now: new Date(now),
        actorType: "owner",
        forceReopenNodeCodes: ["annual.arrival.owner", "annual.pickup.owner"],
      });
    });
    return { data: await getBooking(database, request.params.id, userId) };
  });

  app.get<{
    Querystring: { status?: string; date?: string; stationId?: string };
  }>("/api/operator/workbench", async (request) => {
    const date = request.query.date ?? todayIso();
    const stationId = scopedInspectionStationId(
      backofficeForRequest(request),
      request.query.stationId,
    ) ?? DEMO_STATION_ID;
    const selectedStation = await getStationRow(database, stationId);
    if (!selectedStation) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
    if (!isRealIsoDate(date)) {
      throw new ApiProblem(400, "INVALID_DATE", "日期格式无效", { date: "请使用 YYYY-MM-DD 格式" });
    }
    const requestedStatus = request.query.status ?? "all";
    const supportedFilters = [
      "all",
      "waiting",
      "confirmed",
      "awaiting_arrival",
      "checked_in",
      "inspecting",
      "result_received",
      "completed",
      "on_hold",
      "cancelled",
      "no_show",
    ];
    if (!supportedFilters.includes(requestedStatus)) {
      throw new ApiProblem(400, "INVALID_STATUS", "任务筛选状态无效");
    }

    const rows = await database
      .prepare(`
        SELECT * FROM bookings
        WHERE station_id = ? AND appointment_date = ?
          AND (fulfillment_status = 'legacy' OR fulfillment_status NOT IN ('pending_payment', 'paid_pending_confirmation', 'pending_precheck', 'precheck_action_required', 'precheck_rejected'))
        ORDER BY start_time ASC, created_at ASC
      `)
      .all(stationId, date) as Row[];
    const pendingPrecheckRow = await database.prepare<Row>(`
      SELECT COUNT(*) AS count
      FROM booking_prechecks p
      JOIN bookings b ON b.id = p.booking_id
      WHERE p.station_id = ? AND p.status = 'pending' AND b.fulfillment_status = 'pending_precheck'
    `).get(stationId);
    const filterMatches = (row: Row) => {
      if (requestedStatus === "all") return true;
      if (requestedStatus === "waiting") return ["confirmed", "awaiting_arrival"].includes(String(row.status));
      return String(row.status) === requestedStatus;
    };
    const filteredRows = rows.filter(filterMatches);
    const slotRows = await database
      .prepare("SELECT * FROM station_slots WHERE station_id = ? AND date = ? ORDER BY start_time ASC")
      .all(stationId, date) as Row[];
    const count = (statuses: string[]) => rows.filter((row) => statuses.includes(String(row.status))).length;
    const totalCapacity = slotRows.reduce((sum, slot) => sum + Number(slot.capacity), 0);
    const bookedCapacity = slotRows.reduce((sum, slot) => sum + Number(slot.booked_count), 0);
    const station = selectedStation;

    return {
      data: {
        station: station ? stationFromRow(station) : null,
        businessDate: date,
        summary: {
          todayBookings: rows.length,
          totalCapacity,
          remainingCapacity: Math.max(0, totalCapacity - bookedCapacity),
          awaitingArrival: count(["confirmed", "awaiting_arrival"]),
          checkedIn: count(["checked_in"]),
          inspecting: count(["inspecting"]),
          resultReceived: count(["result_received"]),
          completed: count(["completed"]),
          onHold: count(["on_hold"]),
          pendingPrecheckCount: Number(pendingPrecheckRow?.count ?? 0),
        },
        pressure: slotRows.map((slot) => {
          const capacity = Number(slot.capacity);
          const booked = Number(slot.booked_count);
          const utilization = capacity === 0 ? 0 : booked / capacity;
          return {
            slotId: String(slot.id),
            label: `${String(slot.start_time)}-${String(slot.end_time)}`,
            startTime: String(slot.start_time),
            endTime: String(slot.end_time),
            booked,
            capacity,
            remaining: Math.max(0, capacity - booked),
            utilization,
            level: utilization >= 0.85 ? "high" : utilization >= 0.5 ? "medium" : "low",
          };
        }),
        bookings: await Promise.all(filteredRows.map(async (row) => {
          const task = await bookingDetailFromRow(database, row, false, true);
          return {
            ...task,
            attention:
              String(row.status) === "on_hold"
                ? "exception"
                : String(row.status) === "result_received"
                  ? "result_pending_completion"
                  : null,
          };
        })),
      },
    };
  });

  app.get<{ Querystring: { status?: string; stationId?: string } }>("/api/operator/prechecks", async (request) => {
    const status = request.query.status ?? "pending";
    if (!["pending", "approved", "rejected", "all"].includes(status)) {
      throw new ApiProblem(400, "INVALID_PRECHECK_STATUS", "预审筛选状态无效");
    }
    const stationId = scopedInspectionStationId(
      backofficeForRequest(request),
      request.query.stationId,
    ) ?? DEMO_STATION_ID;
    const rows = await database.prepare<Row>(`
      SELECT b.*
      FROM booking_prechecks p
      JOIN bookings b ON b.id = p.booking_id
      WHERE p.station_id = ?
        AND (? = 'all' OR p.status = ?)
        AND (p.status <> 'pending' OR b.fulfillment_status = 'pending_precheck')
      ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END,
        p.submitted_at ASC, b.id ASC
    `).all(stationId, status, status);
    return {
      data: {
        items: await Promise.all(rows.map((row) => bookingDetailFromRow(database, row, false, true, "operator"))),
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/operator/prechecks/:id", async (request) => {
    const booking = await getOperatorBooking(database, request.params.id);
    if (!booking || !booking.precheck) {
      throw new ApiProblem(404, "PRECHECK_NOT_FOUND", "未找到本站预审任务");
    }
    return { data: booking };
  });

  const assertPrecheckMediaComplete = async (tx: AppDatabase, bookingId: string) => {
    const rows = await tx.prepare<Row>(`
      SELECT kind FROM booking_media WHERE booking_id = ? AND is_current = 1
    `).all(bookingId);
    const actual = new Set(rows.map((row) => String(row.kind)));
    const required = bookingPrecheckMediaKinds;
    const missing = required.filter((kind) => !actual.has(kind));
    if (missing.length) {
      throw new ApiProblem(409, "PRECHECK_MEDIA_INCOMPLETE", "预约资料不完整，暂不能通过预审", {
        media: `缺少 ${missing.length} 张必需照片`,
      });
    }
    return required.length;
  };

  app.post<{ Params: { id: string } }>("/api/operator/prechecks/:id/approve", async (request, reply) => {
    const body = parseBody(precheckApproveSchema, request.body, reply);
    if (!body) return;
    const principal = backofficeForRequest(request);
    await runTransaction(database, async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(request.params.id);
      const precheck = await tx.prepare<Row>("SELECT * FROM booking_prechecks WHERE booking_id = ? FOR UPDATE").get(request.params.id);
      if (!booking || !precheck) throw new ApiProblem(404, "PRECHECK_NOT_FOUND", "未找到本站预审任务");
      if (String(precheck.status) !== "pending") {
        if (String(precheck.status) === "approved" && String(precheck.decision_idempotency_key) === body.idempotencyKey) return;
        throw new ApiProblem(409, "PRECHECK_ALREADY_DECIDED", "该订单已经完成预审，不能重复操作");
      }
      if (Number(precheck.version) !== body.expectedVersion) {
        throw new ApiProblem(409, "PRECHECK_VERSION_CONFLICT", "预审任务已更新，请刷新后重试");
      }
      if (String(booking.fulfillment_status) !== "pending_precheck" || String(booking.payment_status) !== "paid") {
        throw new ApiProblem(409, "PRECHECK_STATE_CHANGED", "订单状态已变化，请刷新后重试");
      }
      const requiredMediaCount = await assertPrecheckMediaComplete(tx, request.params.id);
      const now = new Date().toISOString();
      const selfDrive = String(booking.service_mode) === "self_drive";
      const nextStatus = selfDrive ? "awaiting_arrival" : "confirmed";
      await tx.prepare(`
        UPDATE booking_prechecks SET status = 'approved', reviewed_at = ?,
          reviewer_account_id = ?, reviewer_name = ?, decision_idempotency_key = ?,
          version = version + 1, updated_at = ?
        WHERE booking_id = ?
      `).run(now, principal.account.id, principal.account.displayName, body.idempotencyKey, now, request.params.id);
      await tx.prepare(`
        UPDATE bookings SET status = ?, fulfillment_status = ?, updated_at = ? WHERE id = ?
      `).run(nextStatus, nextStatus, now, request.params.id);
      await insertEvent(
        tx,
        request.params.id,
        nextStatus,
        "检测站预审通过",
        selfDrive
          ? `检测站已核对 ${requiredMediaCount} 张预约资料并接单，等待车辆按预约时间到站`
          : `检测站已核对 ${requiredMediaCount} 张预约资料并接单，订单进入代驾司机安排阶段`,
        now,
        "operator",
        { reviewerName: principal.account.displayName, precheckVersion: Number(precheck.version) + 1 },
      );
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.precheck.approve",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before: { fulfillmentStatus: "pending_precheck", precheckStatus: "pending" },
        after: { fulfillmentStatus: nextStatus, precheckStatus: "approved" },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/operator/prechecks/:id/reject", async (request, reply) => {
    const body = parseBody(precheckRejectSchema, request.body, reply);
    if (!body) return;
    const principal = backofficeForRequest(request);
    const hash = createHash("sha256").update(stableJson(body)).digest("hex");
    await runTransaction(database, async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(request.params.id);
      const precheck = await tx.prepare<Row>("SELECT * FROM booking_prechecks WHERE booking_id = ? FOR UPDATE").get(request.params.id);
      if (!booking || !precheck) throw new ApiProblem(404, "PRECHECK_NOT_FOUND", "未找到本站预检任务");
      if (String(precheck.status) !== "pending") {
        if (precheck.status === "rejected" && precheck.decision_idempotency_key === body.idempotencyKey) {
          if (precheck.decision_hash && precheck.decision_hash !== hash) throw new ApiProblem(409, "PRECHECK_IDEMPOTENCY_CONFLICT", "同一提交标识不能用于不同问题");
          return;
        }
        throw new ApiProblem(409, "PRECHECK_ALREADY_DECIDED", "该轮预检已处理，请等待车主重新提交");
      }
      if (Number(precheck.version) !== body.expectedVersion) throw new ApiProblem(409, "PRECHECK_VERSION_CONFLICT", "预检任务已更新，请刷新后重试");
      if (booking.fulfillment_status !== "pending_precheck" || booking.payment_status !== "paid") throw new ApiProblem(409, "PRECHECK_STATE_CHANGED", "订单状态已变化，请刷新后重试");
      if (new Set(body.reasonCodes).size !== body.reasonCodes.length || new Set(body.issuePhotoKinds).size !== body.issuePhotoKinds.length) throw new ApiProblem(400, "DUPLICATE_PRECHECK_ISSUE", "问题类型和照片不能重复");
      const allowedMediaKinds = new Set(bookingPrecheckMediaKinds);
      const unsupportedPhotoKinds = body.issuePhotoKinds.filter((kind) => !allowedMediaKinds.has(kind));
      if (unsupportedPhotoKinds.length) {
        throw new ApiProblem(400, "PRECHECK_ISSUE_PHOTO_NOT_ALLOWED", "问题照片与预约服务方式不匹配", {
          issuePhotoKinds: `本服务方式不支持：${unsupportedPhotoKinds.join("、")}`,
        });
      }
      const media = await tx.prepare<Row>("SELECT id, kind FROM booking_media WHERE booking_id = ? AND is_current = 1").all(request.params.id);
      const actualKinds = new Set(media.map((item) => String(item.kind)));
      if (body.reasonCodes.includes("dashboard_warning") && !body.issuePhotoKinds.includes("dashboard_started")) throw new ApiProblem(400, "PRECHECK_ISSUE_PHOTO_REQUIRED", "故障灯问题请标注启动后仪表盘照片");
      if (body.reasonCodes.some((code) => ["body_dirty", "body_damage"].includes(code)) && !body.issuePhotoKinds.some((kind) => kind.startsWith("vehicle_"))) throw new ApiProblem(400, "PRECHECK_ISSUE_PHOTO_REQUIRED", "脏污或车损问题请标注对应车身照片");
      if (body.issuePhotoKinds.some((kind) => !actualKinds.has(kind)) && body.reasonCodes.some((code) => precheckAction(code) !== "materials")) throw new ApiProblem(400, "PRECHECK_ISSUE_PHOTO_REQUIRED", "服务问题必须有实际照片依据");
      const now = currentTime().toISOString();
      const history = [...jsonArray(precheck.history_json), {
        version: Number(precheck.version), reasonCodes: body.reasonCodes, reasonText: body.reasonText,
        issuePhotoKinds: body.issuePhotoKinds, mediaIds: media.map((item) => String(item.id)),
        reviewerName: principal.account.displayName, reviewedAt: now,
        resolutionNote: precheck.resolution_note ?? null,
      }];
      await tx.prepare(`UPDATE booking_prechecks SET status = 'rejected', reviewed_at = ?, reviewer_account_id = ?, reviewer_name = ?,
        reason_codes_json = ?, reason_text = ?, issue_photo_kinds_json = ?, decision_idempotency_key = ?, decision_hash = ?,
        history_json = ?, resolution_note = NULL, version = version + 1, updated_at = ? WHERE booking_id = ?`)
        .run(now, principal.account.id, principal.account.displayName, JSON.stringify(body.reasonCodes), body.reasonText,
          JSON.stringify(body.issuePhotoKinds), body.idempotencyKey, hash, JSON.stringify(history), now, request.params.id);
      await tx.prepare("UPDATE bookings SET status = 'confirmed', fulfillment_status = 'precheck_action_required', precheck_slot_released = 1, updated_at = ? WHERE id = ?").run(now, request.params.id);
      if (!Number(booking.precheck_slot_released ?? 0)) await tx.prepare("UPDATE station_slots SET booked_count = GREATEST(0, booked_count - 1) WHERE id = ?").run(String(booking.slot_id));
      await insertEvent(tx, request.params.id, "precheck_action_required", "预检发现问题，等待车主处理",
        body.reasonText + "；原时段已释放，订单及已付款保留。车主可处理后选择本站时段再次审核，或主动申请退款。", now, "operator",
        { reasonCodes: body.reasonCodes, issuePhotoKinds: body.issuePhotoKinds, reviewerName: principal.account.displayName });
      await auditBackofficeEvent(tx, { request, action: "booking.precheck.reject", outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before: { fulfillmentStatus: "pending_precheck", precheckStatus: "pending" },
        after: { fulfillmentStatus: "precheck_action_required", precheckStatus: "rejected", refundStatus: "not_requested" } });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.get<{ Params: { id: string } }>("/api/operator/bookings/:id", async (request) => {
    const booking = await getOperatorBooking(database, request.params.id);
    if (!booking) throw new ApiProblem(404, "OPERATOR_BOOKING_NOT_FOUND", "未找到本站预约任务");
    return { data: booking };
  });

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/accept", async (request) => {
    await runTransaction(database, async (tx) => {
      const row = await requireOperatorBooking(tx, request.params.id);
      const before = await bookingAuditContext(tx, row);
      if (String(row.fulfillment_status) !== "legacy" && String(row.service_mode) !== "self_drive") {
        throw new ApiProblem(409, "DRIVER_FULFILLMENT_REQUIRED", "上门取送订单需先完成司机安排与取车流程");
      }
      await transitionOperatorBooking(
        tx,
        request.params.id,
        ["confirmed"],
        "awaiting_arrival",
        "等待车辆到站",
        "检测站已接单并为车辆保留接待资源",
        {},
        ["confirmed"],
        "awaiting_arrival",
      );
      const after = bookingAuditAfterStatus(before, "awaiting_arrival");
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.fulfillment.accept",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before,
        after,
        presentation: {
          category: "inspection",
          actionLabel: "检测站接单",
          summary: `${before.stationName}已接收预约 ${before.bookingNumber}`,
          subjectName: before.stationName,
          resourceLabel: `预约 ${before.bookingNumber} · ${before.plateNumber}`,
          changes: bookingLifecycleChanges(before, after),
        },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/check-in", async (request, reply) => {
    const body = parseBody(verificationSchema, request.body ?? {}, reply);
    if (!body) return;
    await runTransaction(database, async (tx) => {
      const row = await requireOperatorBooking(tx, request.params.id);
      if (
        String(row.service_mode) === "valet"
        && String(row.evidence_policy_version) === VALET_EVIDENCE_POLICY_VERSION
      ) {
        throw new ApiProblem(
          409,
          "VALET_STATION_ARRIVAL_EVIDENCE_REQUIRED",
          "请完成五张检测站到车留证；提交留证后将自动确认到站",
        );
      }
      const before = await bookingAuditContext(tx, row);
      assertTransition(row, ["awaiting_arrival"], "确认到站");
      await assertCanonicalOperatorGate(
        tx,
        row,
        String(row.service_mode) === "valet" ? ["picked_up"] : ["awaiting_arrival"],
        "确认到站",
      );
      const now = new Date().toISOString();
      await upsertVerification(tx, request.params.id, body, now);
      await tx.prepare(`
        UPDATE bookings SET status = 'checked_in',
          fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE 'checked_in' END,
          updated_at = ? WHERE id = ?
      `).run(now, request.params.id);
      const verificationComplete =
        body.plateMatched &&
        body.materialsReady &&
        body.exteriorRecorded &&
        body.vehicleConditionConfirmed;
      await insertEvent(
        tx,
        request.params.id,
        "checked_in",
        "车辆已到站",
        verificationComplete ? "已完成车牌、材料、外观与车辆状态核验" : "已记录到站核验，存在待处理项",
        now,
        "operator",
        { verification: body },
      );
      const after = bookingAuditAfterStatus(before, "checked_in");
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.fulfillment.check_in",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before: { ...before, verification: null },
        after: {
          ...after,
          verification: {
            plateMatched: body.plateMatched,
            materialsReady: body.materialsReady,
            exteriorRecorded: body.exteriorRecorded,
            vehicleConditionConfirmed: body.vehicleConditionConfirmed,
            notesProvided: Boolean(body.notes),
          },
        },
        presentation: {
          category: "inspection",
          actionLabel: "确认车辆到站",
          summary: `${before.plateNumber}已在${before.stationName}确认到站`,
          subjectName: before.stationName,
          resourceLabel: `预约 ${before.bookingNumber} · ${before.plateNumber}`,
          changes: [
            ...bookingLifecycleChanges(before, after),
            { field: "verification", label: "到站核验", before: "未核验", after: verificationComplete ? "四项均通过" : "存在待处理项" },
          ],
        },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/hold", async (request, reply) => {
    const body = parseBody(holdSchema, request.body, reply);
    if (!body) return;
    await runTransaction(database, async (tx) => {
      const row = await requireOperatorBooking(tx, request.params.id);
      const before = await bookingAuditContext(tx, row);
      assertTransition(row, ["awaiting_arrival", "checked_in", "inspecting"], "挂起任务");
      await assertCanonicalOperatorGate(tx, row, ["awaiting_arrival", "picked_up", "checked_in", "inspecting"], "挂起任务");
      const now = new Date().toISOString();
      await setBookingOnHold(
        tx,
        row,
        body.reasonCode,
        body.note,
        "operator",
        "operator",
        now,
      );
      const after = bookingAuditAfterStatus(before, "on_hold");
      const reasonLabels: Record<string, string> = {
        vehicle_mismatch: "车辆信息不一致",
        materials_missing: "材料不齐",
        late_arrival: "迟到",
        other: "其他原因",
      };
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.fulfillment.hold",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before,
        after: { ...after, reasonCode: body.reasonCode, noteProvided: true },
        presentation: {
          category: "inspection",
          actionLabel: "挂起预约",
          summary: `预约 ${before.bookingNumber} 已挂起`,
          subjectName: before.stationName,
          resourceLabel: `预约 ${before.bookingNumber} · ${before.plateNumber}`,
          reason: reasonLabels[body.reasonCode] ?? "其他原因",
          changes: bookingLifecycleChanges(before, after),
        },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/resolve-hold", async (request, reply) => {
    const body = parseBody(resolveHoldSchema, request.body ?? {}, reply);
    if (!body) return;
    await runTransaction(database, async (tx) => {
      const row = await requireOperatorBooking(tx, request.params.id);
      const before = await bookingAuditContext(tx, row);
      assertTransition(row, ["on_hold"], "恢复任务");
      await assertCanonicalOperatorGate(tx, row, ["on_hold"], "恢复任务");
      const restoreTarget = await bookingHoldRestoreTarget(tx, row);
      const now = new Date().toISOString();
      const existingVerification = await tx
        .prepare<Row>("SELECT * FROM booking_verifications WHERE booking_id = ?")
        .get(request.params.id);
      if (existingVerification && Object.keys(body).length > 0) {
        await upsertVerification(
          tx,
          request.params.id,
          {
            plateMatched: body.plateMatched ?? bool(existingVerification.plate_matched),
            materialsReady: body.materialsReady ?? bool(existingVerification.materials_ready),
            exteriorRecorded: body.exteriorRecorded ?? bool(existingVerification.exterior_recorded),
            vehicleConditionConfirmed:
              body.vehicleConditionConfirmed ?? bool(existingVerification.condition_confirmed),
            notes: body.notes ?? (existingVerification.notes == null ? undefined : String(existingVerification.notes)),
          },
          now,
        );
      }
      await restoreBookingFromHold(
        tx,
        row,
        restoreTarget,
        "信息复核完成，任务已恢复到原业务阶段",
        "operator",
        "operator",
        now,
      );
      const after = bookingAuditAfterStatus(before, restoreTarget.status, restoreTarget.fulfillmentStatus);
      const verificationChanges = Object.entries(body)
        .filter(([field, value]) => field !== "notes" && value !== undefined)
        .map(([field, value]) => ({ field, label: {
          plateMatched: "车牌一致",
          materialsReady: "材料齐备",
          exteriorRecorded: "外观已记录",
          vehicleConditionConfirmed: "车况已确认",
        }[field] ?? field, after: value ? "是" : "否" }));
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.fulfillment.resume",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before,
        after: { ...after, verificationUpdated: verificationChanges.length > 0, notesProvided: Boolean(body.notes) },
        presentation: {
          category: "inspection",
          actionLabel: "恢复预约",
          summary: `预约 ${before.bookingNumber} 已恢复到${fulfillmentAuditLabels[restoreTarget.fulfillmentStatus === "legacy" ? restoreTarget.status : restoreTarget.fulfillmentStatus] ?? restoreTarget.fulfillmentStatus}`,
          subjectName: before.stationName,
          resourceLabel: `预约 ${before.bookingNumber} · ${before.plateNumber}`,
          changes: [...bookingLifecycleChanges(before, after), ...verificationChanges],
        },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/handoff", async (request) => {
    await runTransaction(database, async (tx) => {
      const row = await requireOperatorBooking(tx, request.params.id);
      const before = await bookingAuditContext(tx, row);
      assertTransition(row, ["checked_in"], "交接检测");
      await assertCanonicalOperatorGate(tx, row, ["checked_in"], "交接检测");
      const verification = await tx
        .prepare<Row>("SELECT * FROM booking_verifications WHERE booking_id = ?")
        .get(request.params.id);
      if (
        !verification ||
        !bool(verification.plate_matched) ||
        !bool(verification.materials_ready) ||
        !bool(verification.exterior_recorded) ||
        !bool(verification.condition_confirmed)
      ) {
        throw new ApiProblem(409, "VERIFICATION_INCOMPLETE", "请先完成全部到站核验项");
      }
      const now = new Date().toISOString();
      await tx.prepare(`
        UPDATE bookings SET status = 'inspecting',
          fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE 'inspecting' END,
          updated_at = ? WHERE id = ?
      `).run(now, request.params.id);
      await insertEvent(
        tx,
        request.params.id,
        "inspecting",
        "已交接检测线",
        "车辆已交由独立检测设备软件处理，等待外部结果回传",
        now,
        "operator",
        { integrationBoundary: "external_inspection_system" },
      );
      const after = bookingAuditAfterStatus(before, "inspecting");
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.fulfillment.handoff",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before,
        after,
        presentation: {
          category: "inspection",
          actionLabel: "交接检测",
          summary: `${before.plateNumber}已交接检测线`,
          subjectName: before.stationName,
          resourceLabel: `预约 ${before.bookingNumber} · ${before.plateNumber}`,
          changes: bookingLifecycleChanges(before, after),
        },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/complete", async (request) => {
    await runTransaction(database, async (tx) => {
      const row = await requireOperatorBooking(tx, request.params.id);
      if (
        String(row.service_mode) === "valet"
        && String(row.evidence_policy_version) === VALET_EVIDENCE_POLICY_VERSION
      ) {
        throw new ApiProblem(
          409,
          "VALET_DRIVER_RETURN_REQUIRED",
          "上门取送订单须由已绑定司机完成送回留证后自动闭环",
        );
      }
      const before = await bookingAuditContext(tx, row);
      await assertAnnualBookingFinancialClosureReady(
        tx,
        request.params.id,
        (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
      );
      await assertVehicleCheckupDeliveryReady(
        tx,
        request.params.id,
        (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
      );
      await transitionOperatorBooking(
        tx,
        request.params.id,
        ["result_received"],
        "completed",
        "服务已完成",
        "结果已向车主交付，本次履约闭环完成",
        {},
        String(row.service_mode) === "valet" ? ["returning"] : ["result_received"],
        "completed",
      );
      const after = bookingAuditAfterStatus(before, "completed");
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.fulfillment.complete",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before,
        after,
        presentation: {
          category: "inspection",
          actionLabel: "完成服务",
          summary: `预约 ${before.bookingNumber} 已完成服务`,
          subjectName: before.stationName,
          resourceLabel: `预约 ${before.bookingNumber} · ${before.plateNumber}`,
          changes: bookingLifecycleChanges(before, after),
        },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/no-show", async (request) => {
    await runTransaction(database, async (tx) => {
      const row = await requireOperatorBooking(tx, request.params.id);
      const before = await bookingAuditContext(tx, row);
      assertTransition(row, ["confirmed", "awaiting_arrival"], "标记爽约");
      if (String(row.fulfillment_status) !== "legacy" && String(row.service_mode) !== "self_drive") {
        throw new ApiProblem(409, "INVALID_FULFILLMENT_TRANSITION", "上门取送订单不能由检测站标记车主未到站");
      }
      await assertCanonicalOperatorGate(tx, row, ["awaiting_arrival"], "标记爽约");
      const now = new Date().toISOString();
      await tx.prepare(`
        UPDATE bookings SET status = 'no_show',
          fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE 'no_show' END,
          updated_at = ? WHERE id = ?
      `).run(now, request.params.id);
      await markBookingMediaForRetention(tx, request.params.id, now);
      await tx
        .prepare("UPDATE station_slots SET booked_count = GREATEST(0, booked_count - 1) WHERE id = ?")
        .run(String(row.slot_id));
      await insertEvent(tx, request.params.id, "no_show", "车主未到站", "预约已标记为爽约", now, "operator");
      const after = bookingAuditAfterStatus(before, "no_show");
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.fulfillment.no_show",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before,
        after,
        presentation: {
          category: "inspection",
          actionLabel: "标记车主爽约",
          summary: `预约 ${before.bookingNumber} 已标记为爽约并释放号源`,
          subjectName: before.stationName,
          resourceLabel: `预约 ${before.bookingNumber} · ${before.plateNumber}`,
          changes: bookingLifecycleChanges(before, after),
        },
      });
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.patch<{ Params: { id: string } }>("/api/operator/station-slots/:id", async (request, reply) => {
    const body = parseBody(capacitySchema, request.body, reply);
    if (!body) return;
    await runTransaction(database, async (tx) => {
      const slot = await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!slot) throw new ApiProblem(404, "OPERATOR_SLOT_NOT_FOUND", "未找到本站号源");
      const station = await tx.prepare<Row>("SELECT id, name FROM stations WHERE id = ?").get(String(slot.station_id));
      if (!station) throw new ApiProblem(404, "OPERATOR_SLOT_NOT_FOUND", "未找到本站号源");
      if (String(slot.date) <= todayIso()) {
        throw new ApiProblem(409, "SLOT_CAPACITY_LOCKED", "仅可调整未来日期的号源容量");
      }
      if (body.capacity < Number(slot.booked_count)) {
        throw new ApiProblem(409, "CAPACITY_BELOW_BOOKED", "容量不能低于当前已预约数量", {
          capacity: `至少设置为 ${Number(slot.booked_count)}`,
        });
      }
      if (body.capacity < 1) {
        throw new ApiProblem(409, "CAPACITY_MINIMUM", "号源容量至少为 1", { capacity: "请输入 1–99" });
      }
      const before = slotAuditSnapshot(slot);
      if (before.capacity === body.capacity) return;
      await tx.prepare("UPDATE station_slots SET capacity = ? WHERE id = ?").run(body.capacity, request.params.id);
      const after = { ...before, capacity: body.capacity };
      await auditBackofficeEvent(tx, {
        request,
        action: "inspection.slot.capacity_update",
        outcome: "success",
        resource: { type: "station_slot", id: request.params.id },
        before,
        after,
        presentation: {
          category: "inspection",
          actionLabel: "调整号源容量",
          summary: `${String(station.name)} ${before.date} ${before.startTime}–${before.endTime} 容量已调整`,
          subjectName: String(station.name),
          resourceLabel: `${before.date} ${before.startTime}–${before.endTime}`,
          changes: slotAuditChanges(before, after),
        },
      });
    });
    return { data: slotFromRow((await getSlotRow(database, request.params.id))!) };
  });

  app.get("/api/admin/stations", async () => {
    const rows = await database.prepare<Row>(`
      SELECT * FROM stations
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
        is_pinned DESC, sort_priority DESC, district, name
    `).all(HUAYANG_STATION_ID);
    return {
      data: await Promise.all(rows.map((row) => adminStationFromRow(database, row))),
      meta: { identity: "固定演示管理员", containsRealStationData: rows.some((row) => String(row.data_kind) === "real") },
    };
  });

  app.post("/api/admin/stations", async (request, reply) => {
    const body = parseBody(adminStationSchema, request.body, reply);
    if (!body) return;
    if (!body.location) throw new ApiProblem(400, "STATION_LOCATION_REQUIRED", "请先搜索并确认检测站地址");
    const location = verifiedAdminStationLocation(body.location);
    const id = body.id ?? `station-${randomUUID()}`;
    if (await getStationRow(database, id)) throw new ApiProblem(409, "STATION_ALREADY_EXISTS", "检测站 ID 已存在");
    const now = new Date().toISOString();
    const serviceFeeFen = body.pricePlans?.find((item) => item.planId === INSPECTION_PRICE_PLAN_IDS.smallIce && item.isSupported)?.priceFen ?? 0;
    await runTransaction(database, async (tx) => {
      await tx.prepare(`
        INSERT INTO stations (
          id, name, district, address, distance_km, drive_minutes, rating,
          review_count, tags_json, service_fee_fen, open_hours, phone, created_at,
          latitude, longitude, is_active, updated_at, legal_name, data_kind,
          is_direct_operated, is_pinned, sort_priority, map_poi_id, weekly_schedule_json,
          business_hours_notice, internal_contact_name, internal_contact_phone
        ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        body.name,
        location.district,
        location.address,
        JSON.stringify(body.isDirectOperated ? ["官方自营"] : []),
        serviceFeeFen,
        body.openHours,
        body.phone ?? null,
        now,
        location.latitude,
        location.longitude,
        body.isActive ? 1 : 0,
        now,
        body.legalName ?? null,
        body.dataKind ?? "demo",
        body.isDirectOperated ? 1 : 0,
        body.isPinned ? 1 : 0,
        body.sortPriority ?? 0,
        location.poiId,
        JSON.stringify(body.weeklySchedule ?? {}),
        body.businessHoursNotice ?? null,
        body.internalContact?.name ?? null,
        body.internalContact?.phone ?? null,
      );
      if (body.pricePlans) await replaceStationPricePlans(tx, id, body.pricePlans);
      const created = (await tx.prepare<Row>("SELECT * FROM stations WHERE id = ?").get(id))!;
      const after = await stationAuditSnapshot(tx, created);
      await auditBackofficeEvent(tx, {
        request,
        action: "inspection.station.create",
        outcome: "success",
        resource: { type: "inspection_station", id },
        before: null,
        after,
        presentation: {
          category: "inspection",
          actionLabel: "新建检测站",
          summary: `新建检测站“${after.name}”`,
          subjectName: after.name,
          resourceLabel: after.name,
          changes: [
            { field: "isActive", label: "经营状态", after: after.isActive ? "已启用" : "已停用" },
            { field: "address", label: "检测站位置", after: after.address },
            { field: "pricePlans", label: "支持车型与年检价格", after: after.pricePlans },
          ],
        },
      });
    });
    return reply.status(201).send({ data: await adminStationFromRow(database, (await getStationRow(database, id))!) });
  });

  app.put<{ Params: { id: string } }>("/api/admin/stations/:id", async (request, reply) => {
    const body = parseBody(adminStationSchema, request.body, reply);
    if (!body) return;
    const current = await getStationRow(database, request.params.id);
    if (!current) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
    const location = body.location
      ? verifiedAdminStationLocation(body.location)
      : {
          district: String(current.district),
          address: String(current.address),
          latitude: Number(current.latitude),
          longitude: Number(current.longitude),
          poiId: current.map_poi_id == null ? null : String(current.map_poi_id),
        };
    if (request.params.id === HUAYANG_STATION_ID && body.isPinned === false) {
      throw new ApiProblem(409, "DIRECT_STATION_PIN_REQUIRED", "华洋机动车检测站为自有站点，必须保持置顶");
    }
    const now = new Date().toISOString();
    await runTransaction(database, async (tx) => {
      const lockedCurrent = await tx.prepare<Row>("SELECT * FROM stations WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!lockedCurrent) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
      const before = await stationAuditSnapshot(tx, lockedCurrent);
      await tx.prepare(`
        UPDATE stations SET
          name = ?, district = ?, address = ?, latitude = ?, longitude = ?,
          open_hours = ?, phone = ?, is_active = ?, updated_at = ?, legal_name = ?,
          data_kind = ?, is_direct_operated = ?, is_pinned = ?, sort_priority = ?, map_poi_id = ?,
          weekly_schedule_json = ?, business_hours_notice = ?,
          internal_contact_name = ?, internal_contact_phone = ?
        WHERE id = ?
      `).run(
        body.name,
        location.district,
        location.address,
        location.latitude,
        location.longitude,
        body.openHours,
        body.phone ?? null,
        body.isActive ? 1 : 0,
        now,
        body.legalName === undefined ? (current.legal_name == null ? null : String(current.legal_name)) : body.legalName,
        body.dataKind ?? String(current.data_kind ?? "demo"),
        body.isDirectOperated === undefined ? Number(current.is_direct_operated ?? 0) : body.isDirectOperated ? 1 : 0,
        body.isPinned === undefined ? Number(current.is_pinned ?? 0) : body.isPinned ? 1 : 0,
        body.sortPriority ?? Number(current.sort_priority ?? 0),
        location.poiId,
        body.weeklySchedule === undefined ? String(current.weekly_schedule_json ?? "{}") : JSON.stringify(body.weeklySchedule),
        body.businessHoursNotice === undefined ? (current.business_hours_notice == null ? null : String(current.business_hours_notice)) : body.businessHoursNotice,
        body.internalContact === undefined ? (current.internal_contact_name == null ? null : String(current.internal_contact_name)) : body.internalContact?.name ?? null,
        body.internalContact === undefined ? (current.internal_contact_phone == null ? null : String(current.internal_contact_phone)) : body.internalContact?.phone ?? null,
        request.params.id,
      );
      if (body.pricePlans) await replaceStationPricePlans(tx, request.params.id, body.pricePlans);
      const updated = (await tx.prepare<Row>("SELECT * FROM stations WHERE id = ?").get(request.params.id))!;
      const after = await stationAuditSnapshot(tx, updated);
      const changes = stationAuditChanges(before, after);
      if (changes.length > 0) {
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.station.update",
          outcome: "success",
          resource: { type: "inspection_station", id: request.params.id },
          before,
          after,
          presentation: {
            category: "inspection",
            actionLabel: "修改检测站配置",
            summary: `修改检测站“${after.name}”的配置`,
            subjectName: after.name,
            resourceLabel: after.name,
            changes,
          },
        });
      }
    });
    return { data: await adminStationFromRow(database, (await getStationRow(database, request.params.id))!) };
  });

  app.put<{ Params: { id: string } }>("/api/admin/stations/:id/price-plans", async (request, reply) => {
    const body = parseBody(stationPricePlansSchema, request.body, reply);
    if (!body) return;
    await runTransaction(database, async (tx) => {
      const station = await tx.prepare<Row>("SELECT * FROM stations WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!station) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
      const before = await stationPricePlanAuditSnapshot(tx, request.params.id);
      await replaceStationPricePlans(tx, request.params.id, body.pricePlans);
      const after = await stationPricePlanAuditSnapshot(tx, request.params.id);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.station_offers.update",
          outcome: "success",
          resource: { type: "inspection_station", id: request.params.id },
          before: { pricePlans: before },
          after: { pricePlans: after },
          presentation: {
            category: "inspection",
            actionLabel: "调整检测站检验报价",
            summary: `调整检测站“${String(station.name)}”支持的车型与价格`,
            subjectName: String(station.name),
            resourceLabel: String(station.name),
            changes: [{ field: "pricePlans", label: "支持车型与年检价格", before, after }],
          },
        });
      }
    });
    return { data: await adminStationFromRow(database, (await getStationRow(database, request.params.id))!) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/stations/:id/slots", async (request, reply) => {
    const body = parseBody(adminSlotSchema, request.body, reply);
    if (!body) return;
    if (body.date < todayIso()) throw new ApiProblem(409, "SLOT_EXPIRED", "不能新增过去日期的号源");
    const id = `slot-${request.params.id}-${body.date}-${body.startTime.replace(":", "")}-${randomUUID().slice(0, 8)}`;
    try {
      await runTransaction(database, async (tx) => {
        const station = await tx.prepare<Row>("SELECT id, name FROM stations WHERE id = ? FOR UPDATE").get(request.params.id);
        if (!station) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
        await tx.prepare(`
          INSERT INTO station_slots (
            id, station_id, date, start_time, end_time, capacity, booked_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `).run(id, request.params.id, body.date, body.startTime, body.endTime, body.capacity, new Date().toISOString());
        const created = (await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ?").get(id))!;
        const after = slotAuditSnapshot(created);
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.slot.create",
          outcome: "success",
          resource: { type: "station_slot", id },
          before: null,
          after,
          presentation: {
            category: "inspection",
            actionLabel: "新增预约时段",
            summary: `${String(station.name)}新增 ${after.date} ${after.startTime}–${after.endTime} 号源`,
            subjectName: String(station.name),
            resourceLabel: `${after.date} ${after.startTime}–${after.endTime}`,
            changes: [{ field: "capacity", label: "总容量", after: after.capacity }],
          },
        });
      });
    } catch (error) {
      if (["23505", "23P01"].includes((error as Error & { code?: string }).code ?? "")) {
        throw new ApiProblem(409, "SLOT_CONFLICT", "该站点同一日期和开始时间的号源已存在");
      }
      throw error;
    }
    return reply.status(201).send({ data: slotFromRow((await getSlotRow(database, id))!) });
  });

  app.put<{ Params: { id: string } }>("/api/admin/station-slots/:id", async (request, reply) => {
    const body = parseBody(adminSlotSchema, request.body, reply);
    if (!body) return;
    try {
      await runTransaction(database, async (tx) => {
        const slot = await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ? FOR UPDATE").get(request.params.id);
        if (!slot) throw new ApiProblem(404, "SLOT_NOT_FOUND", "未找到该号源");
        const station = await tx.prepare<Row>("SELECT id, name FROM stations WHERE id = ?").get(String(slot.station_id));
        if (!station) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
        const before = slotAuditSnapshot(slot);
        if (body.date < todayIso()) throw new ApiProblem(409, "SLOT_EXPIRED", "不能把号源调整到过去日期");
        const scheduleChanged = body.date !== String(slot.date)
          || body.startTime !== String(slot.start_time)
          || body.endTime !== String(slot.end_time);
        const hasBookingHistory = Boolean(
          await tx.prepare<Row>("SELECT 1 FROM bookings WHERE slot_id = ? LIMIT 1").get(request.params.id),
        );
        if (scheduleChanged && hasBookingHistory) {
          throw new ApiProblem(409, "SLOT_SCHEDULE_LOCKED", "已有预约的号源不能修改日期或时间，可仅调整容量");
        }
        if (body.capacity < Number(slot.booked_count)) {
          throw new ApiProblem(409, "CAPACITY_BELOW_BOOKED", "容量不能低于当前已预约数量", {
            capacity: `至少设置为 ${Number(slot.booked_count)}`,
          });
        }
        await tx.prepare(`
          UPDATE station_slots SET date = ?, start_time = ?, end_time = ?, capacity = ? WHERE id = ?
        `).run(body.date, body.startTime, body.endTime, body.capacity, request.params.id);
        const updated = (await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ?").get(request.params.id))!;
        const after = slotAuditSnapshot(updated);
        const changes = slotAuditChanges(before, after);
        if (changes.length > 0) {
          await auditBackofficeEvent(tx, {
            request,
            action: changes.length === 1 && changes[0]?.field === "capacity"
              ? "inspection.slot.capacity_update"
              : "inspection.slot.update",
            outcome: "success",
            resource: { type: "station_slot", id: request.params.id },
            before,
            after,
            presentation: {
              category: "inspection",
              actionLabel: changes.length === 1 && changes[0]?.field === "capacity" ? "调整号源容量" : "调整预约时段",
              summary: `${String(station.name)} ${after.date} ${after.startTime}–${after.endTime} 号源已调整`,
              subjectName: String(station.name),
              resourceLabel: `${after.date} ${after.startTime}–${after.endTime}`,
              changes,
            },
          });
        }
      });
    } catch (error) {
      if (["23505", "23P01"].includes((error as Error & { code?: string }).code ?? "")) {
        throw new ApiProblem(409, "SLOT_CONFLICT", "该站点同一日期和开始时间的号源已存在");
      }
      throw error;
    }
    return { data: slotFromRow((await getSlotRow(database, request.params.id))!) };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/station-slots/:id", async (request) => {
    await runTransaction(database, async (tx) => {
      const slot = await tx.prepare<Row>("SELECT * FROM station_slots WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!slot) throw new ApiProblem(404, "SLOT_NOT_FOUND", "未找到该号源");
      const station = await tx.prepare<Row>("SELECT id, name FROM stations WHERE id = ?").get(String(slot.station_id));
      if (!station) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
      const before = slotAuditSnapshot(slot);
      const bookingCount = Number((await tx.prepare<Row>("SELECT COUNT(*) AS count FROM bookings WHERE slot_id = ?").get(request.params.id))!.count);
      if (Number(slot.booked_count) > 0 || bookingCount > 0) {
        throw new ApiProblem(409, "SLOT_HAS_BOOKINGS", "已有预约或历史订单的号源不能删除，可将容量调整后停用未来时段");
      }
      await tx.prepare(`
        INSERT INTO station_slot_seed_tombstones (slot_id, deleted_at)
        VALUES (?, ?)
        ON CONFLICT(slot_id) DO UPDATE SET deleted_at = excluded.deleted_at
      `).run(request.params.id, new Date().toISOString());
      await tx.prepare("DELETE FROM station_slots WHERE id = ?").run(request.params.id);
      await auditBackofficeEvent(tx, {
        request,
        action: "inspection.slot.delete",
        outcome: "success",
        resource: { type: "station_slot", id: request.params.id },
        before,
        after: null,
        presentation: {
          category: "inspection",
          actionLabel: "删除预约时段",
          summary: `${String(station.name)}删除 ${before.date} ${before.startTime}–${before.endTime} 号源`,
          subjectName: String(station.name),
          resourceLabel: `${before.date} ${before.startTime}–${before.endTime}`,
          changes: [{ field: "deleted", label: "号源状态", before: "可预约", after: "已删除" }],
        },
      });
    });
    return { data: { id: request.params.id, deleted: true } };
  });

  app.get("/api/admin/pricing", async () => {
    const rows = await database.prepare<Row>(`
      SELECT p.*, s.name AS station_name
      FROM station_vehicle_prices p JOIN stations s ON s.id = p.station_id
      ORDER BY s.district, s.name, p.category
    `).all();
    return {
      data: rows.map((row) => ({
        stationId: String(row.station_id),
        stationName: String(row.station_name),
        category: String(row.category),
        priceFen: Number(row.price_fen),
        updatedAt: String(row.updated_at),
      })),
    };
  });

  app.put("/api/admin/pricing", async (request, reply) => {
    const body = parseBody(adminPricingSchema, request.body, reply);
    if (!body) return;
    const now = new Date().toISOString();
    await runTransaction(database, async (tx) => {
      const station = await tx.prepare<Row>("SELECT * FROM stations WHERE id = ? FOR UPDATE").get(body.stationId);
      if (!station) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
      const previous = await tx.prepare<Row>("SELECT * FROM station_vehicle_prices WHERE station_id = ? AND category = ? FOR UPDATE")
        .get(body.stationId, body.category);
      const before = { category: body.category, priceFen: previous == null ? null : Number(previous.price_fen) };
      if (before.priceFen === body.priceFen) return;
      await tx.prepare(`
        INSERT INTO station_vehicle_prices (station_id, category, price_fen, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(station_id, category) DO UPDATE SET price_fen = excluded.price_fen, updated_at = excluded.updated_at
      `).run(body.stationId, body.category, body.priceFen, now);
      const compatiblePlanIds = body.category === "fuel_small"
        ? [INSPECTION_PRICE_PLAN_IDS.smallIce]
        : body.category === "new_energy_small"
          ? [INSPECTION_PRICE_PLAN_IDS.smallPureElectric, INSPECTION_PRICE_PLAN_IDS.smallPlugIn]
          : [INSPECTION_PRICE_PLAN_IDS.passengerPureElectric, INSPECTION_PRICE_PLAN_IDS.passengerCombustion];
      const updatePlanPrice = tx.prepare(`
        UPDATE station_inspection_price_plans
        SET price_fen = ?, updated_at = ?
        WHERE station_id = ? AND plan_id = ?
      `);
      for (const planId of compatiblePlanIds) await updatePlanPrice.run(body.priceFen, now, body.stationId, planId);
      if (body.category === "fuel_small") {
        await tx.prepare("UPDATE stations SET service_fee_fen = ?, updated_at = ? WHERE id = ?").run(body.priceFen, now, body.stationId);
      }
      const after = { category: body.category, priceFen: body.priceFen };
      await auditBackofficeEvent(tx, {
        request,
        action: "inspection.station_offers.update",
        outcome: "success",
        resource: { type: "inspection_station", id: body.stationId },
        before,
        after,
        presentation: {
          category: "inspection",
          actionLabel: "调整检测站检验报价",
          summary: `调整检测站“${String(station.name)}”的检验报价`,
          subjectName: String(station.name),
          resourceLabel: String(station.name),
          changes: [{ field: body.category, label: "车型报价", before: before.priceFen == null ? "未配置" : auditMoney(before.priceFen), after: auditMoney(after.priceFen) }],
        },
      });
    });
    return { data: { ...body, updatedAt: now } };
  });

  const listInspectionPricePlans = async () => {
    const rows = await database.prepare<Row>("SELECT * FROM inspection_price_plans ORDER BY sort_order, id").all();
    return { data: rows.map(inspectionPricePlanFromRow) };
  };
  app.get("/api/admin/inspection-price-plans", listInspectionPricePlans);
  app.get("/api/admin/price-plans", listInspectionPricePlans);

  const createInspectionPricePlan = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(inspectionPricePlanSchema, request.body, reply);
    if (!body) return;
    const id = body.id ?? `plan-${randomUUID()}`;
    const now = new Date().toISOString();
    try {
      await runTransaction(database, async (tx) => {
        await tx.prepare(`
          INSERT INTO inspection_price_plans (
            id, code, name, description, powertrain_types_json, min_seats, max_seats,
            usage_natures_json, vehicle_class_codes_json, exclude_vans, plate_categories_json,
            inspection_items_json, sort_order, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          body.code,
          body.name,
          body.description,
          JSON.stringify(body.powertrainTypes),
          body.minSeats,
          body.maxSeats,
          JSON.stringify(body.usageNatures),
          JSON.stringify(body.vehicleClassCodes),
          body.excludeVans ? 1 : 0,
          body.plateCategories ? JSON.stringify(body.plateCategories) : null,
          JSON.stringify(body.inspectionItems),
          body.sortOrder,
          body.isActive ? 1 : 0,
          now,
          now,
        );
        const created = (await tx.prepare<Row>("SELECT * FROM inspection_price_plans WHERE id = ?").get(id))!;
        const after = pricePlanAuditSnapshot(created);
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.price_plan.create",
          outcome: "success",
          resource: { type: "inspection_price_plan", id },
          before: null,
          after,
          presentation: {
            category: "inspection",
            actionLabel: "新建检验价格方案",
            summary: `新建检验价格方案“${after.name}”`,
            resourceLabel: after.name,
            changes: [
              { field: "isActive", label: "启用状态", after: after.isActive ? "已启用" : "已停用" },
              { field: "powertrainTypes", label: "适用动力类型", after: pricePlanAuditDisplayValue("powertrainTypes", after.powertrainTypes) },
              { field: "inspectionItems", label: "检验项目", after: pricePlanAuditDisplayValue("inspectionItems", after.inspectionItems) },
            ],
          },
        });
      });
    } catch (error) {
      if ((error as Error & { code?: string }).code === "23505") {
        throw new ApiProblem(409, "PRICE_PLAN_CONFLICT", "价格方案 ID 或 code 已存在");
      }
      throw error;
    }
    const row = (await database.prepare<Row>("SELECT * FROM inspection_price_plans WHERE id = ?").get(id))!;
    return reply.status(201).send({ data: inspectionPricePlanFromRow(row) });
  };
  app.post("/api/admin/inspection-price-plans", createInspectionPricePlan);
  app.post("/api/admin/price-plans", createInspectionPricePlan);

  const updateInspectionPricePlan = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const body = parseBody(inspectionPricePlanSchema, request.body, reply);
    if (!body) return;
    const now = new Date().toISOString();
    await runTransaction(database, async (tx) => {
      const current = await tx.prepare<Row>("SELECT * FROM inspection_price_plans WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!current) throw new ApiProblem(404, "PRICE_PLAN_NOT_FOUND", "未找到价格方案");
      const before = pricePlanAuditSnapshot(current);
      await tx.prepare(`
        UPDATE inspection_price_plans SET
          code = ?, name = ?, description = ?, powertrain_types_json = ?,
          min_seats = ?, max_seats = ?, usage_natures_json = ?,
          vehicle_class_codes_json = ?, exclude_vans = ?, plate_categories_json = ?, inspection_items_json = ?,
          sort_order = ?, is_active = ?, updated_at = ?
        WHERE id = ?
      `).run(
        body.code,
        body.name,
        body.description,
        JSON.stringify(body.powertrainTypes),
        body.minSeats,
        body.maxSeats,
        JSON.stringify(body.usageNatures),
        JSON.stringify(body.vehicleClassCodes),
        body.excludeVans ? 1 : 0,
        body.plateCategories ? JSON.stringify(body.plateCategories) : current.plate_categories_json == null ? null : String(current.plate_categories_json),
        JSON.stringify(body.inspectionItems),
        body.sortOrder,
        body.isActive ? 1 : 0,
        now,
        request.params.id,
      );
      const updated = (await tx.prepare<Row>("SELECT * FROM inspection_price_plans WHERE id = ?").get(request.params.id))!;
      const after = pricePlanAuditSnapshot(updated);
      const changes = pricePlanAuditChanges(before, after);
      if (changes.length > 0) {
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.price_plan.update",
          outcome: "success",
          resource: { type: "inspection_price_plan", id: request.params.id },
          before,
          after,
          presentation: {
            category: "inspection",
            actionLabel: "修改检验价格方案",
            summary: `修改检验价格方案“${after.name}”`,
            resourceLabel: after.name,
            changes,
          },
        });
      }
    });
    return { data: inspectionPricePlanFromRow((await database.prepare<Row>("SELECT * FROM inspection_price_plans WHERE id = ?").get(request.params.id))!) };
  };
  app.put<{ Params: { id: string } }>("/api/admin/inspection-price-plans/:id", updateInspectionPricePlan);
  app.put<{ Params: { id: string } }>("/api/admin/price-plans/:id", updateInspectionPricePlan);

  const deleteInspectionPricePlan = async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const now = new Date().toISOString();
    await runTransaction(database, async (tx) => {
      const current = await tx.prepare<Row>("SELECT * FROM inspection_price_plans WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!current) throw new ApiProblem(404, "PRICE_PLAN_NOT_FOUND", "未找到价格方案");
      const before = pricePlanAuditSnapshot(current);
      const linked = await tx.prepare<Row>("SELECT COUNT(*) AS count FROM station_inspection_price_plans WHERE plan_id = ? AND is_supported = 1")
        .get(request.params.id);
      await tx.prepare("UPDATE inspection_price_plans SET is_active = 0, updated_at = ? WHERE id = ?").run(now, request.params.id);
      await tx.prepare("UPDATE station_inspection_price_plans SET is_supported = 0, updated_at = ? WHERE plan_id = ?").run(now, request.params.id);
      if (before.isActive) {
        const after = { ...before, isActive: false };
        const affectedStationCount = Number(linked?.count ?? 0);
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.price_plan.disable",
          outcome: "success",
          resource: { type: "inspection_price_plan", id: request.params.id },
          before,
          after,
          presentation: {
            category: "inspection",
            actionLabel: "停用检验价格方案",
            summary: `停用检验价格方案“${before.name}”`,
            resourceLabel: before.name,
            changes: [
              { field: "isActive", label: "启用状态", before: "已启用", after: "已停用" },
              { field: "affectedStationCount", label: "同步停止支持的检测站", before: affectedStationCount, after: 0 },
            ],
          },
        });
      }
    });
    return { data: { id: request.params.id, deleted: true, deletionMode: "soft" } };
  };
  app.delete<{ Params: { id: string } }>("/api/admin/inspection-price-plans/:id", deleteInspectionPricePlan);
  app.delete<{ Params: { id: string } }>("/api/admin/price-plans/:id", deleteInspectionPricePlan);

  app.get("/api/admin/valet-rules", async () => {
    const row = (await database.prepare<Row>("SELECT * FROM valet_pricing_rules WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1").get())!;
    return {
      data: {
        id: String(row.id),
        baseFeeFen: Number(row.base_fee_fen),
        includedKm: Number(row.included_km),
        perKmFen: Number(row.per_km_fen),
        maxRadiusKm: row.max_radius_km_limit == null ? null : Number(row.max_radius_km_limit),
        scope: "global",
        stationId: null,
        updatedAt: String(row.updated_at),
      },
    };
  });

  app.put("/api/admin/valet-rules", async (request, reply) => {
    const body = parseBody(adminValetRuleSchema, request.body, reply);
    if (!body) return;
    const now = new Date().toISOString();
    await runTransaction(database, async (tx) => {
      const current = await tx.prepare<Row>("SELECT * FROM valet_pricing_rules WHERE id = 'default' FOR UPDATE").get();
      if (!current) throw new ApiProblem(404, "VALET_RULE_NOT_FOUND", "未找到默认取送计价规则");
      const before = valetRuleAuditSnapshot(current);
      await tx.prepare(`
        UPDATE valet_pricing_rules SET
          base_fee_fen = ?, included_km = ?, per_km_fen = ?, max_radius_km = ?,
          max_radius_km_limit = ?, updated_at = ?
        WHERE id = 'default'
      `).run(body.baseFeeFen, body.includedKm, body.perKmFen, body.maxRadiusKm ?? 1000000, body.maxRadiusKm, now);
      const updated = (await tx.prepare<Row>("SELECT * FROM valet_pricing_rules WHERE id = 'default'").get())!;
      const after = valetRuleAuditSnapshot(updated);
      const changes = valetRuleAuditChanges(before, after);
      if (changes.length > 0) {
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.valet_rule.global_update",
          outcome: "success",
          resource: { type: "valet_pricing_rule", id: "default" },
          before,
          after,
          presentation: {
            category: "inspection",
            actionLabel: "修改全局取送计价规则",
            summary: "修改全站默认的往返取送计价规则",
            resourceLabel: "全局默认取送规则",
            changes,
          },
        });
      }
    });
    return { data: { id: "default", scope: "global", stationId: null, ...body, updatedAt: now } };
  });

  app.get<{ Params: { id: string } }>("/api/admin/stations/:id/valet-rule", async (request) => {
    if (!(await getStationRow(database, request.params.id))) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
    const globalRule = await resolvedValetRule(database, "__no_station_override__");
    const override = await database.prepare<Row>("SELECT * FROM station_valet_pricing_overrides WHERE station_id = ?").get(request.params.id);
    const overrideRule = override ? await resolvedValetRule(database, request.params.id) : null;
    return {
      data: {
        stationId: request.params.id,
        mode: override ? "override" : "inherit",
        globalRule,
        overrideRule,
        resolvedRule: overrideRule ?? globalRule,
      },
    };
  });

  app.put<{ Params: { id: string } }>("/api/admin/stations/:id/valet-rule", async (request, reply) => {
    const body = parseBody(adminValetRuleSchema, request.body, reply);
    if (!body) return;
    const now = new Date().toISOString();
    await runTransaction(database, async (tx) => {
      const station = await tx.prepare<Row>("SELECT id, name FROM stations WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!station) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
      const current = await tx.prepare<Row>("SELECT * FROM station_valet_pricing_overrides WHERE station_id = ? FOR UPDATE")
        .get(request.params.id);
      const before = current == null ? null : valetRuleAuditSnapshot(current);
      await tx.prepare(`
        INSERT INTO station_valet_pricing_overrides (
          station_id, base_fee_fen, included_km, per_km_fen, max_radius_km, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(station_id) DO UPDATE SET
          base_fee_fen = excluded.base_fee_fen,
          included_km = excluded.included_km,
          per_km_fen = excluded.per_km_fen,
          max_radius_km = excluded.max_radius_km,
          updated_at = excluded.updated_at
      `).run(request.params.id, body.baseFeeFen, body.includedKm, body.perKmFen, body.maxRadiusKm, now);
      const updated = (await tx.prepare<Row>("SELECT * FROM station_valet_pricing_overrides WHERE station_id = ?").get(request.params.id))!;
      const after = valetRuleAuditSnapshot(updated);
      const changes = before == null
        ? [
            { field: "baseFeeFen", label: "往返起步价", after: auditMoney(after.baseFeeFen) },
            { field: "includedKm", label: "包含单程里程", after: `${after.includedKm} km` },
            { field: "perKmFen", label: "超出单价", after: `${auditMoney(after.perKmFen)}/km` },
            { field: "maxRadiusKm", label: "最大服务距离", after: after.maxRadiusKm == null ? "不限制" : `${after.maxRadiusKm} km` },
          ]
        : valetRuleAuditChanges(before, after);
      if (changes.length > 0) {
        await auditBackofficeEvent(tx, {
          request,
          action: "inspection.valet_rule.station_override",
          outcome: "success",
          resource: { type: "inspection_station", id: request.params.id },
          before,
          after,
          presentation: {
            category: "inspection",
            actionLabel: "设置站点取送计价规则",
            summary: `为检测站“${String(station.name)}”设置独立取送计价规则`,
            subjectName: String(station.name),
            resourceLabel: String(station.name),
            changes,
          },
        });
      }
    });
    return { data: { mode: "override", ...await resolvedValetRule(database, request.params.id) } };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/stations/:id/valet-rule", async (request) => {
    await runTransaction(database, async (tx) => {
      const station = await tx.prepare<Row>("SELECT id, name FROM stations WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!station) throw new ApiProblem(404, "STATION_NOT_FOUND", "未找到该检测站");
      const current = await tx.prepare<Row>("SELECT * FROM station_valet_pricing_overrides WHERE station_id = ? FOR UPDATE")
        .get(request.params.id);
      if (!current) return;
      const before = valetRuleAuditSnapshot(current);
      await tx.prepare("DELETE FROM station_valet_pricing_overrides WHERE station_id = ?").run(request.params.id);
      const global = await tx.prepare<Row>("SELECT * FROM valet_pricing_rules WHERE id = 'default'").get();
      const inherited = global == null ? null : valetRuleAuditSnapshot(global);
      await auditBackofficeEvent(tx, {
        request,
        action: "inspection.valet_rule.station_inherit",
        outcome: "success",
        resource: { type: "inspection_station", id: request.params.id },
        before,
        after: inherited,
        presentation: {
          category: "inspection",
          actionLabel: "恢复继承全局取送规则",
          summary: `检测站“${String(station.name)}”恢复继承全局取送计价规则`,
          subjectName: String(station.name),
          resourceLabel: String(station.name),
          changes: [{ field: "ruleScope", label: "计价规则来源", before: "站点独立规则", after: "继承全局规则" }],
        },
      });
    });
    return { data: { stationId: request.params.id, mode: "inherit", resolvedRule: await resolvedValetRule(database, request.params.id) } };
  });

  app.get<{
    Querystring: { date?: string; stationId?: string; status?: string; serviceMode?: string; plateNumber?: string };
  }>("/api/admin/bookings", async (request) => {
    assertCapability(backofficeForRequest(request), "admin.all");
    const clauses: string[] = [];
    const values: string[] = [];
    if (request.query.date) {
      if (!isRealIsoDate(request.query.date)) throw new ApiProblem(400, "INVALID_DATE", "日期格式无效");
      clauses.push("b.appointment_date = ?");
      values.push(request.query.date);
    }
    if (request.query.stationId) {
      clauses.push("b.station_id = ?");
      values.push(request.query.stationId);
    }
    if (request.query.status) {
      if (["refund_pending", "refund_failed"].includes(request.query.status)) {
        clauses.push("p.refund_status = ?");
        values.push(request.query.status);
      } else {
        clauses.push("(b.fulfillment_status = ? OR b.status = ?)");
        values.push(request.query.status, request.query.status);
      }
    }
    if (request.query.serviceMode) {
      const parsed = serviceModeSchema.safeParse(request.query.serviceMode);
      if (!parsed.success) throw new ApiProblem(400, "INVALID_SERVICE_MODE", "预约方式无效");
      clauses.push("b.service_mode = ?");
      values.push(parsed.data);
    }
    const normalizedPlateFilter = normalizeAdminBookingPlateFilter(request.query.plateNumber);
    if (normalizedPlateFilter) {
      clauses.push(`
        UPPER(regexp_replace(
          COALESCE(
            NULLIF(b.vehicle_snapshot_json::jsonb ->> 'plateNumber', ''),
            v.plate_normalized,
            ''
          ),
          '[·•・.\\s-]',
          '',
          'g'
        )) LIKE ?
      `);
      values.push(`%${normalizedPlateFilter}%`);
    }
    const rows = await database.prepare<Row>(`
      SELECT b.*
      FROM bookings b
      LEFT JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN booking_prechecks p ON p.booking_id = b.id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY b.created_at DESC, b.id DESC
    `).all(...values);
    return { data: await Promise.all(rows.map((row) => bookingDetailFromRow(database, row, false, true, "admin"))) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/bookings/:id", async (request) => {
    const row = await database.prepare<Row>("SELECT * FROM bookings WHERE id = ?").get(request.params.id);
    if (!row) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    return { data: await bookingDetailFromRow(database, row, true, true, "admin", true) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/bookings/:id/precheck-refund/retry", async (request) => {
    assertCapability(backofficeForRequest(request), "admin.all");
    await runTransaction(database, async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(request.params.id);
      const precheck = await tx.prepare<Row>("SELECT * FROM booking_prechecks WHERE booking_id = ? FOR UPDATE").get(request.params.id);
      if (!booking || !precheck || String(precheck.status) !== "rejected") {
        throw new ApiProblem(404, "PRECHECK_REFUND_NOT_FOUND", "未找到可重试的预审退款");
      }
      if (String(precheck.refund_status) === "refunded") return;
      if (String(precheck.refund_status) !== "refund_failed") {
        throw new ApiProblem(409, "PRECHECK_REFUND_NOT_RETRYABLE", "当前退款状态不需要重试");
      }
      if (!precheck.refund_requested_at || !bookingIsTerminal(booking)) {
        throw new ApiProblem(403, "OWNER_REFUND_REQUIRED", "尚无已结束订单的退款申请，不能由后台发起预检退款");
      }
      const now = new Date().toISOString();
      const financials = await bookingFinancials(tx, request.params.id);
      const expectedRefundFen = Number(precheck.refund_amount_fen ?? 0);
      const remainingRefundFen = Math.max(0, expectedRefundFen - financials.refundedFen);
      if (remainingRefundFen > 0) {
        await tx.prepare(`
          INSERT INTO booking_ledger_entries (
            id, booking_id, kind, amount_fen, description, actor_type,
            payment_id, idempotency_key, confirmation_status, confirmed_at, created_at
          ) VALUES (?, ?, 'refund', ?, '重试检测站预审全额退款',
            'operator', NULL, 'precheck-rejection-refund', 'confirmed', ?, ?)
          ON CONFLICT DO NOTHING
        `).run(randomUUID(), request.params.id, -remainingRefundFen, now, now);
      }
      const updatedFinancials = await bookingFinancials(tx, request.params.id);
      await tx.prepare(`
        UPDATE booking_prechecks SET refund_status = 'refunded', refund_error = NULL,
          refund_requested_at = COALESCE(refund_requested_at, ?), refund_completed_at = ?, updated_at = ?
        WHERE booking_id = ?
      `).run(now, now, now, request.params.id);
      await tx.prepare("UPDATE bookings SET payment_status = ?, updated_at = ? WHERE id = ?")
        .run(paymentStatusFromFinancials(updatedFinancials), now, request.params.id);
      await insertEvent(
        tx,
        request.params.id,
        "precheck_rejected",
        "退款重试成功",
        `已完成全额退款 ¥${(expectedRefundFen / 100).toFixed(2)}`,
        now,
        "system",
        { refundStatus: "refunded", refundAmountFen: expectedRefundFen },
      );
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.precheck.refund.retry",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before: { refundStatus: "refund_failed" },
        after: { refundStatus: "refunded", refundAmountFen: expectedRefundFen },
      });
    });
    const row = await database.prepare<Row>("SELECT * FROM bookings WHERE id = ?").get(request.params.id);
    return { data: await bookingDetailFromRow(database, row!, true, true, "admin", true) };
  });

  app.get<{ Params: { id: string; mediaId: string } }>(
    "/api/admin/bookings/:id/media/:mediaId",
    async (request, reply) => {
      const row = await database.prepare<Row>(`
        SELECT media.*
        FROM booking_media media
        JOIN bookings booking
          ON booking.id = media.booking_id AND booking.user_id = media.user_id
        WHERE booking.id = ? AND media.id = ?
      `).get(request.params.id, request.params.mediaId);
      if (!row) throw new ApiProblem(404, "MEDIA_NOT_FOUND", "照片不存在或已清理");
      reply.type(String(row.mime_type || "image/jpeg")).header("Cache-Control", "private, no-store");
      return reply.send(createReadStream(join(uploadDir, String(row.storage_key))));
    },
  );

  app.patch<{ Params: { id: string } }>("/api/admin/bookings/:id", async (request, reply) => {
    const body = parseBody(adminBookingUpdateSchema, request.body, reply);
    if (!body) return;
    if (body.fulfillmentStatus === "cancelled" && (body.adjustment || body.refund)) {
      throw new ApiProblem(400, "CANCELLATION_SETTLEMENT_AUTOMATIC", "取消订单将按履约阶段自动结算，请勿同时提交手工调价或退款");
    }
    const row = await database.prepare<Row>("SELECT * FROM bookings WHERE id = ?").get(request.params.id);
    if (!row) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    if (body.adjustment && bookingIsTerminal(row)) {
      throw new ApiProblem(409, "SURCHARGE_NOT_ALLOWED", "终态订单不能新增待确认附加费用");
    }
    const now = new Date().toISOString();
    const currentFulfillment = String(row.fulfillment_status ?? "legacy");
    const currentStatus = String(row.status);
    const currentBusiness = canonicalBusinessStatus(row);
    const requestedBusiness = body.fulfillmentStatus;
    let requestedRestoreTarget: HoldRestoreTarget | null = null;
    if (requestedBusiness && requestedBusiness !== currentBusiness) {
      if (requestedBusiness === "on_hold") {
        assertBookingCanBeHeld(row);
      } else if (currentBusiness === "on_hold") {
        requestedRestoreTarget = await bookingHoldRestoreTarget(database, row);
        if (requestedBusiness !== "cancelled") {
          const exactRestoreStatus = requestedRestoreTarget.fulfillmentStatus === "legacy"
            ? requestedRestoreTarget.status
            : requestedRestoreTarget.fulfillmentStatus;
          if (requestedBusiness !== exactRestoreStatus) {
            throw new ApiProblem(
              409,
              "BOOKING_HOLD_RESTORE_MISMATCH",
              `挂起订单只能恢复到原节点 ${exactRestoreStatus}`,
            );
          }
        }
      } else if (requestedBusiness === "cancelled") {
        if (bookingIsTerminal(row) && currentBusiness !== "cancelled") {
          throw new ApiProblem(409, "INVALID_FULFILLMENT_TRANSITION", `不能从 ${currentBusiness} 更新为 cancelled`);
        }
      } else if (requestedBusiness === "result_received") {
        throw new ApiProblem(
          409,
          "INSPECTION_RESULT_SUBMISSION_REQUIRED",
          "检测结果必须由结果回传接口提交，后台不能直接推进到结果已回传",
        );
      } else {
        throw new ApiProblem(
          409,
          "ADMIN_WORKFLOW_ADVANCE_FORBIDDEN",
          "普通履约节点必须由检测站或代驾司机在对应页面完成，后台只能处理挂起、恢复和取消",
        );
      }
    }
    await runTransaction(database, async (tx) => {
      const lockedRow = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!lockedRow) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      const lockedFulfillment = String(lockedRow.fulfillment_status ?? "legacy");
      const lockedStatus = String(lockedRow.status);
      const lockedBusiness = canonicalBusinessStatus(lockedRow);
      const beforeAudit = await bookingAuditContext(tx, lockedRow);
      const beforeFinancialState = await bookingFinancials(tx, request.params.id);
      const beforeFinancials = bookingFinancialAuditSnapshot(beforeFinancialState);
      if (lockedFulfillment !== currentFulfillment || lockedStatus !== currentStatus) {
        throw new ApiProblem(409, "BOOKING_STATE_CHANGED", "订单状态刚刚发生变化，请刷新后重试");
      }
      if (
        requestedRestoreTarget
        && requestedBusiness
        && requestedBusiness !== lockedBusiness
        && lockedFulfillment !== "legacy"
      ) {
        const lockedFinancials = await bookingFinancials(tx, request.params.id);
        if (lockedFinancials.paidFen <= 0) {
          throw new ApiProblem(409, "PAYMENT_REQUIRED", "订单支付确认后才能进入履约流程");
        }
      }
      if (body.internalDriverNote !== undefined) {
        await tx.prepare("UPDATE bookings SET internal_driver_note = ?, updated_at = ? WHERE id = ?")
          .run(body.internalDriverNote, now, request.params.id);
        await insertEvent(
          tx,
          request.params.id,
          currentBusiness,
          "内部司机备注已更新",
          body.internalDriverNote ? "后台已更新司机履约备注" : "后台已清空司机履约备注",
          now,
          "operator",
          { cleared: body.internalDriverNote == null },
        );
      }
      const insertLedger = async (kind: "surcharge" | "refund", amountFen: number, reason: string, idempotencyKey: string): Promise<boolean> => {
        const existing = await tx.prepare<Row>(`
          SELECT * FROM booking_ledger_entries WHERE booking_id = ? AND idempotency_key = ?
        `).get(request.params.id, idempotencyKey);
        const signedAmount = kind === "refund" ? -amountFen : amountFen;
        if (existing) {
          if (String(existing.kind) !== kind || Number(existing.amount_fen) !== signedAmount) {
            throw new ApiProblem(409, "LEDGER_IDEMPOTENCY_CONFLICT", "账目幂等键已用于不同操作");
          }
          return false;
        }
        if (kind === "refund") {
          if (["pending_precheck", "precheck_action_required"].includes(lockedBusiness)) throw new ApiProblem(403, "OWNER_REFUND_REQUIRED", "预检退款须由车主主动申请");
          const financials = await bookingFinancials(tx, request.params.id);
          if (financials.refundedFen + amountFen > financials.paidFen) {
            throw new ApiProblem(409, "REFUND_EXCEEDS_PAYMENT", "退款金额不能超过已支付金额");
          }
        }
        await tx.prepare(`
          INSERT INTO booking_ledger_entries (
            id, booking_id, kind, amount_fen, description, actor_type,
            payment_id, idempotency_key, confirmation_status, confirmed_at, created_at
          ) VALUES (?, ?, ?, ?, ?, 'operator', NULL, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          request.params.id,
          kind,
          signedAmount,
          reason,
          idempotencyKey,
          kind === "surcharge" ? "pending_owner_confirmation" : "confirmed",
          kind === "surcharge" ? null : now,
          now,
        );
        await insertEvent(
          tx,
          request.params.id,
          currentBusiness,
          kind === "refund" ? "退款已登记" : "附加费用待车主确认",
          reason,
          now,
          "operator",
          { kind, amountFen: signedAmount, idempotencyKey },
        );
        return true;
      };
      const surchargeCreated = body.adjustment
        ? await insertLedger("surcharge", body.adjustment.amountFen, body.adjustment.reason, body.adjustment.idempotencyKey)
        : false;
      const refundCreated = body.refund
        ? await insertLedger("refund", body.refund.amountFen, body.refund.reason, body.refund.idempotencyKey)
        : false;

      const cancellationCreated = body.fulfillmentStatus === "cancelled"
        && String(lockedRow.status) !== "cancelled"
        && lockedBusiness !== "cancelled";
      const statusChanged = body.fulfillmentStatus === "cancelled"
        ? cancellationCreated
        : Boolean(body.fulfillmentStatus && body.fulfillmentStatus !== lockedBusiness);
      if (body.fulfillmentStatus === "cancelled") {
        await cancelBooking(tx, lockedRow, "operator", true);
      } else if (body.fulfillmentStatus === "on_hold" && body.fulfillmentStatus !== lockedBusiness) {
        await setBookingOnHold(
          tx,
          lockedRow,
          "admin_exception",
          "平台后台暂停履约，等待异常处理",
          "operator",
          "admin",
          now,
        );
      } else if (requestedRestoreTarget && body.fulfillmentStatus !== lockedBusiness) {
        await restoreBookingFromHold(
          tx,
          lockedRow,
          requestedRestoreTarget,
          "平台后台已处理异常，订单恢复到挂起前业务节点",
          "operator",
          "admin",
          now,
        );
      }
      const financialState = await bookingFinancials(tx, request.params.id);
      const financials = bookingFinancialAuditSnapshot(financialState);
      await tx.prepare("UPDATE bookings SET payment_status = ?, updated_at = ? WHERE id = ?")
        .run(paymentStatusFromFinancials(financialState), now, request.params.id);
      if (cancellationCreated || refundCreated || surchargeCreated || statusChanged) {
        const afterRow = (await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ?").get(request.params.id))!;
        const afterAudit = await bookingAuditContext(tx, afterRow);
        const holdCreated = statusChanged && body.fulfillmentStatus === "on_hold";
        const holdRestored = statusChanged && requestedRestoreTarget != null;
        const action = cancellationCreated
          ? "booking.cancel"
          : refundCreated
            ? "booking.refund.record"
            : surchargeCreated
              ? "booking.surcharge.create"
              : holdCreated
                ? "booking.fulfillment.hold"
                : holdRestored
                  ? "booking.fulfillment.resume"
                  : "booking.fulfillment.update";
        const actionLabel = cancellationCreated
          ? "取消预约"
          : refundCreated
            ? "登记订单退款"
            : surchargeCreated
              ? "新增附加费"
              : holdCreated
                ? "挂起预约"
                : holdRestored
                  ? "恢复预约"
                  : "调整履约状态";
        const amountChange: InspectionAuditChange[] = [];
        if (refundCreated && body.refund) {
          amountChange.push({ field: "refundFen", label: "本次退款", after: auditMoney(body.refund.amountFen) });
        }
        if (surchargeCreated && body.adjustment) {
          amountChange.push({ field: "surchargeFen", label: "本次附加费", after: auditMoney(body.adjustment.amountFen) });
        }
        if (cancellationCreated) {
          amountChange.push({ field: "refundedFen", label: "取消后累计已退", before: auditMoney(beforeFinancials.refundedFen), after: auditMoney(financials.refundedFen) });
        }
        const reason = refundCreated || surchargeCreated ? "已填写业务原因（详见订单账目）" : undefined;
        await auditBackofficeEvent(tx, {
          request,
          action,
          outcome: "success",
          resource: { type: "booking", id: request.params.id },
          before: { ...beforeAudit, financials: beforeFinancials },
          after: { ...afterAudit, financials },
          presentation: {
            category: "inspection",
            actionLabel,
            summary: `${actionLabel}：${beforeAudit.bookingNumber} · ${beforeAudit.plateNumber}`,
            subjectName: beforeAudit.stationName,
            resourceLabel: `预约 ${beforeAudit.bookingNumber} · ${beforeAudit.plateNumber}`,
            reason,
            changes: [
              ...bookingLifecycleChanges(beforeAudit, afterAudit),
              ...amountChange,
            ],
          },
        });
      }
    });
    return { data: await getOperatorBooking(database, request.params.id) };
  });

  app.post("/api/integrations/inspection-results", async (request, reply) => {
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    const timestamp = String(request.headers["x-yuxiaoman-timestamp"] ?? "").trim();
    const signature = String(request.headers["x-yuxiaoman-signature"] ?? "").trim();
    if (!idempotencyKey || !timestamp || !signature) {
      throw new ApiProblem(401, "MISSING_INTEGRATION_SIGNATURE", "缺少结果回传认证头");
    }
    const timestampMs = /^\d+$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
      throw new ApiProblem(401, "STALE_INTEGRATION_SIGNATURE", "结果回传签名已过期");
    }
    const expected = expectedResultSignature(timestamp, request.body);
    if (!signaturesMatch(signature, expected)) {
      throw new ApiProblem(401, "INVALID_INTEGRATION_SIGNATURE", "结果回传签名无效");
    }
    const body = parseBody(inspectionResultSchema, request.body, reply);
    if (!body) return;
    if (body.receivedAt && Math.abs(Date.now() - Date.parse(body.receivedAt)) > 5 * 60_000) {
      throw new ApiProblem(
        400,
        "STALE_INSPECTION_DEVICE_TIME",
        "检测设备结果时间与服务器时间偏差超过 5 分钟",
      );
    }
    const received = await receiveInspectionResult(database, body, idempotencyKey);
    return { data: received };
  });

  app.post<{ Params: { id: string } }>("/api/demo/operator/bookings/:id/simulate-result", async (request) => {
    assertDemoWorkflowEnabled();
    const row = await requireOperatorBooking(database, request.params.id);
    if (String(row.status) !== "inspecting") {
      throw new ApiProblem(409, "INVALID_BOOKING_TRANSITION", "仅检测中的任务可以模拟结果回传");
    }
    const now = new Date().toISOString();
    const received = await receiveInspectionResult(
      database,
      {
        bookingId: request.params.id,
        externalResultId: `SIM-${Date.now()}-${request.params.id}`,
        conclusion: "passed",
        summary: {
          conclusionLabel: "检验合格",
          itemsPassed: 12,
          itemsTotal: 12,
          nextInspectionHint: "请以交管部门最终签注为准",
        },
        source: "demo_inspection_simulator",
        receivedAt: now,
      },
      `demo-${randomUUID()}`,
    );
    return { data: received.booking };
  });

  app.post<{ Params: { id: string } }>("/api/demo/bookings/:id/advance", async (request) => {
    assertDemoWorkflowEnabled();
    const userId = await requireCurrentUser(request, database);
    await runTransaction(database, async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE").get(request.params.id, userId);
      if (!booking) throw new ApiProblem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      if (String(booking.fulfillment_status) !== "legacy" && String(booking.service_mode) === "valet") {
        throw new ApiProblem(409, "VALET_DEMO_ADVANCE_UNSUPPORTED", "上门取送订单必须按司机安排、取车和返还流程推进");
      }

      const transitions: Record<string, { status: string; title: string; description: string }> = {
        confirmed: { status: "awaiting_arrival", title: "等待到站", description: "服务人员已准备接待，请按预约时间到站" },
        awaiting_arrival: { status: "checked_in", title: "车辆已到站", description: "车辆与材料核验已完成" },
        checked_in: { status: "inspecting", title: "检测进行中", description: "车辆已交接至独立检测设备系统" },
        inspecting: { status: "completed", title: "自驾年检服务已自动完成", description: "有效检测结果和完整报告已发布，无需再次人工确认" },
        result_received: { status: "completed", title: "检测已完成", description: "本次年检服务已完成，可查看结果摘要" },
      };
      const transition = transitions[String(booking.status)];
      if (!transition) {
        throw new ApiProblem(409, "BOOKING_CANNOT_ADVANCE", "该预约已处于最终状态");
      }
      await assertCanonicalOperatorGate(tx, booking, [String(booking.status)], "推进演示履约状态");
      if (transition.status === "completed") {
        await assertAnnualBookingFinancialClosureReady(
          tx,
          request.params.id,
          (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
        );
      }

      const now = new Date().toISOString();
      const completedAt = String(booking.status) === "inspecting"
        ? new Date(Date.parse(now) + 1).toISOString()
        : now;
      if (transition.status === "checked_in") {
        await upsertVerification(
          tx,
          request.params.id,
          {
            plateMatched: true,
            materialsReady: true,
            exteriorRecorded: true,
            vehicleConditionConfirmed: true,
            notes: "演示模式自动完成到站核验",
          },
          now,
        );
      }
      if (String(booking.status) === "inspecting") {
        const externalResultId = `SIM-${Date.now()}-${request.params.id}`;
        const summary = { conclusionLabel: "检验合格", itemsPassed: 12, itemsTotal: 12 };
        const source = "demo_inspection_simulator";
        const idempotencyKey = `demo-advance-${randomUUID()}`;
        await publishVehicleCheckupReport(
          tx,
          request.params.id,
          "passed",
          null,
          summary,
          now,
          (statusCode, code, message, fields) => new ApiProblem(statusCode, code, message, fields),
        );
        await tx.prepare(`
          INSERT INTO inspection_results (
            id, booking_id, external_result_id, conclusion, summary_json,
            source, received_at, idempotency_key, request_hash
          ) VALUES (?, ?, ?, 'passed', ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          request.params.id,
          externalResultId,
          JSON.stringify(summary),
          source,
          now,
          idempotencyKey,
          inspectionResultRequestHash({
            bookingId: request.params.id,
            externalResultId,
            conclusion: "passed",
            summary,
            source,
            receivedAt: now,
          }),
        );
        await insertEvent(
          tx,
          request.params.id,
          "result_received",
          "检测结果已回传",
          "外部检测系统已回传合成演示结果",
          now,
          "external_system",
          { externalResultId, conclusion: "passed", source },
        );
      }
      await tx
        .prepare(`
          UPDATE bookings SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?
        `)
        .run(
          transition.status,
          transition.status === "completed" ? completedAt : now,
          transition.status === "completed" ? completedAt : null,
          request.params.id,
        );
      await tx.prepare(`
        UPDATE bookings SET
          fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN 'legacy' ELSE ? END
        WHERE id = ?
      `).run(transition.status, request.params.id);
      if (transition.status === "completed") await markBookingMediaForRetention(tx, request.params.id, completedAt);
      await insertEvent(
        tx,
        request.params.id,
        transition.status,
        transition.title,
        transition.description,
        transition.status === "completed" ? completedAt : now,
        "system",
      );
    });
    return { data: await getBooking(database, request.params.id, userId) };
  });

  app.post("/api/demo/reset", async () => {
    const production = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
    if (production || process.env.ALLOW_DEMO_RESET !== "true") {
      throw new ApiProblem(403, "DEMO_RESET_DISABLED", "当前运行环境禁止清空并重置业务数据");
    }
    assertResetUploadDirectoriesSafe(uploadDir, insuranceUploadDir, subsidyConsultationUploadDir);
    if (demoResetInProgress) {
      throw new ApiProblem(503, "DEMO_RESET_IN_PROGRESS", "演示数据正在重置，请稍后重试");
    }
    demoResetInProgress = true;
    try {
      // seedDemoData(force) owns one database transaction, advisory lock and
      // table locks. Files are touched only after that transaction commits.
      await seedDemoData(database, { force: true });
      await Promise.all([
        clearUploadDirectory(uploadDir),
        clearPrivateUploadDirectory(
          insuranceUploadDir,
          /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.jpg$/iu,
        ),
        clearPrivateUploadDirectory(
          subsidyConsultationUploadDir,
          /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.bin$/iu,
        ),
      ]);
    } catch (error) {
      if (error instanceof DemoResetUnsafeError) {
        throw new ApiProblem(
          409,
          "DEMO_RESET_UNSAFE",
          "当前数据库包含真实/未分类客户或只追加客户备注，不能执行演示重置",
        );
      }
      throw error;
    } finally {
      demoResetInProgress = false;
    }
    const vehicleCount = Number(
      (await database
        .prepare<Row>("SELECT COUNT(*) AS count FROM vehicles WHERE user_id = ? AND deleted_at IS NULL")
        .get(DEMO_USER_ID))!.count,
    );
    const operatorTaskCount = Number(
      (await database
        .prepare<Row>("SELECT COUNT(*) AS count FROM bookings WHERE station_id = ? AND appointment_date = ?")
        .get(DEMO_STATION_ID, todayIso()))!.count,
    );
    const stationCount = Number((await database.prepare<Row>("SELECT COUNT(*) AS count FROM stations").get())!.count);
    const slotCount = Number((await database.prepare<Row>("SELECT COUNT(*) AS count FROM station_slots").get())!.count);
    return {
      data: {
        resetAt: new Date().toISOString(),
        vehicles: vehicleCount,
        stations: stationCount,
        slots: slotCount,
        operatorTasks: operatorTaskCount,
        businessDate: todayIso(),
      },
    };
  });

  return app;
  } catch (error) {
    if (ownsDatabase) await database.close().catch(() => undefined);
    throw error;
  }
}
