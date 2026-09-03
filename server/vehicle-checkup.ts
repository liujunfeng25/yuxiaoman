import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import { assertAnnualBookingFinancialClosureReady } from "./annual-booking-finance.js";
import { auditBackofficeEvent } from "./backoffice.js";
import type { AppDatabase } from "./database.js";
import { inspectionResultRequestHash } from "./db.js";
import {
  OFFICIAL_INSPECTION_CONCLUSIONS,
  OFFICIAL_INSPECTION_FAILURE_CATEGORIES,
  isOfficialInspectionConclusion,
  officialInspectionFailureDetailsView,
  officialInspectionConclusionView,
  safeInspectionConclusionSummary,
  type OfficialInspectionConclusion,
  type OfficialInspectionFailureDetails,
} from "./inspection-conclusion.js";
import { VALET_EVIDENCE_POLICY_VERSION } from "./valet-handoff.js";

type Row = Record<string, unknown>;
type ProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

type ReportAudience = "owner" | "operator" | "admin";

function auditPlate(value: unknown): string {
  const normalized = String(value ?? "").trim().replace(/[·\s-]/gu, "").toUpperCase();
  if (!normalized) return "待核验车辆";
  if (normalized.includes("*")) return normalized;
  if (normalized.length <= 3) return "***";
  return `${normalized.slice(0, 2)}***${normalized.slice(-1)}`;
}

async function checkupAuditBookingContext(database: AppDatabase, bookingId: string) {
  const row = await database.prepare<Row>(`
    SELECT b.id, b.booking_number, b.appointment_date, b.start_time, b.end_time,
      b.status, b.fulfillment_status, s.id AS station_id, s.name AS station_name,
      v.plate_number
    FROM bookings b
    JOIN stations s ON s.id = b.station_id
    JOIN vehicles v ON v.id = b.vehicle_id
    WHERE b.id = ?
  `).get(bookingId);
  if (!row) return null;
  return {
    id: String(row.id),
    bookingNumber: String(row.booking_number),
    stationId: String(row.station_id),
    stationName: String(row.station_name),
    plateNumber: auditPlate(row.plate_number),
    appointmentDate: String(row.appointment_date),
    period: `${String(row.start_time)}–${String(row.end_time)}`,
    status: String(row.status),
    fulfillmentStatus: String(row.fulfillment_status ?? "legacy"),
  };
}

const reportMediaKindSchema = z.enum([
  "front_left",
  "front_right",
  "rear_left",
  "rear_right",
  "dashboard_started",
  "safety_inspection_report",
  "emissions_inspection_report",
  "annual_inspection_mark",
]);

const requiredSitePhotoKinds = [
  "front_left",
  "front_right",
  "rear_left",
  "rear_right",
  "dashboard_started",
] as const;

const faultCloseupKind = "fault_closeup" as const;

const failureDetailsSchema = z.object({
  itemCategories: z.array(z.enum(OFFICIAL_INSPECTION_FAILURE_CATEGORIES))
    .min(1, "请选择至少一个不合格项目类别")
    .max(9),
  reason: z.string().trim().min(2, "请填写具体不合格原因").max(1_000),
  reinspectionAdvice: z.string().trim().min(2, "请填写复检建议").max(1_000),
}).strict();

const faultRegionCodeSchema = z.enum([
  "front_bumper",
  "front_face",
  "hood",
  "windshield",
  "roof",
  "rear_glass",
  "trunk_tailgate",
  "rear_bumper",
  "left_mirror",
  "left_front_fender",
  "left_front_door",
  "left_rear_door",
  "left_rear_quarter",
  "left_sill",
  "right_mirror",
  "right_front_fender",
  "right_front_door",
  "right_rear_door",
  "right_rear_quarter",
  "right_sill",
]);

const faultSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  clientKey: z.string().trim().min(1).max(100).optional(),
  viewId: z.enum(["top", "left", "right"]),
  regionCode: faultRegionCodeSchema,
  faultType: z.enum(["scratch", "dent", "paint_damage", "crack", "broken", "rust", "other"]),
  severity: z.enum(["minor", "moderate", "severe"]),
  description: z.string().trim().max(300).nullable().optional(),
}).superRefine((value, context) => {
  if (value.faultType === "other" && (!value.description || value.description.length < 2)) {
    context.addIssue({ code: "custom", path: ["description"], message: "其他故障请填写至少 2 个字符的描述" });
  }
});

type NormalizedPhoto = {
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
  fields: unknown;
};

const reportDraftSchema = z.object({
  rowVersion: z.number().int().min(1).optional(),
  observationMode: z.enum(["no_visible_faults", "faults_recorded"]).nullable().default(null),
  diagramVersion: z.string().trim().min(1).max(80).default("sedan-3view-v1"),
  summary: z.record(z.string(), z.unknown()).default({}),
  annualInspection: z.object({
    conclusion: z.enum(OFFICIAL_INSPECTION_CONCLUSIONS).nullable().default(null),
    failureDetails: failureDetailsSchema.nullable().optional(),
    summary: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  faults: z.array(faultSchema).max(20, "每份报告最多记录 20 条故障").default([]),
}).superRefine((value, context) => {
  if (value.observationMode === "no_visible_faults" && value.faults.length > 0) {
    context.addIssue({ code: "custom", path: ["faults"], message: "确认未发现明显异常时不能同时保存故障" });
  }
  if (value.observationMode === "faults_recorded" && value.faults.length === 0) {
    context.addIssue({ code: "custom", path: ["faults"], message: "请选择至少一个故障位置" });
  }
  if (value.observationMode === null && value.faults.length > 0) {
    context.addIssue({ code: "custom", path: ["observationMode"], message: "有故障记录时请选择已记录故障" });
  }
  const annual = value.annualInspection;
  if (annual?.conclusion === "failed" && !annual.failureDetails) {
    context.addIssue({
      code: "custom",
      path: ["annualInspection", "failureDetails"],
      message: "年检未通过时必须填写不合格项目、具体原因和复检建议",
    });
  }
  if (annual?.conclusion !== "failed" && annual?.failureDetails) {
    context.addIssue({
      code: "custom",
      path: ["annualInspection", "failureDetails"],
      message: "只有年检未通过时才能填写不合格详情",
    });
  }
});

const manualResultSchema = z.object({
  conclusion: z.enum(OFFICIAL_INSPECTION_CONCLUSIONS).optional(),
  failureDetails: failureDetailsSchema.nullable().optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
  externalResultId: z.string().trim().min(3).max(100).optional(),
}).superRefine((value, context) => {
  if (value.conclusion === "passed" && value.failureDetails) {
    context.addIssue({
      code: "custom",
      path: ["failureDetails"],
      message: "年检通过时不能填写不合格详情",
    });
  }
});

const ownerReportListQuerySchema = z.object({
  vehicleId: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().min(1).max(2_000).optional(),
});

const ownerReportCursorSchema = z.object({
  publishedAt: z.iso.datetime(),
  reportId: z.string().trim().min(1).max(100),
});

type OwnerReportCursor = z.infer<typeof ownerReportCursorSchema>;

const ownerReportPendingStatuses = new Set(["result_received", "returning", "completed"]);

function validationFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

function multipartField(fields: unknown, name: string): string {
  if (!fields || typeof fields !== "object") return "";
  const field = (fields as Record<string, unknown>)[name];
  if (!field || typeof field !== "object" || !("value" in field)) return "";
  return String((field as { value: unknown }).value ?? "").trim();
}

async function normalizeUploadedPhoto(
  request: FastifyRequest,
  problem: ProblemFactory,
): Promise<NormalizedPhoto> {
  let part;
  try {
    part = await request.file();
  } catch {
    throw problem(413, "VEHICLE_CHECKUP_MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
  }
  if (!part) throw problem(400, "VEHICLE_CHECKUP_MEDIA_FILE_REQUIRED", "请选择要上传的照片");
  let source: Buffer;
  try {
    source = await part.toBuffer();
  } catch {
    throw problem(413, "VEHICLE_CHECKUP_MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
  }
  if (source.length > 10 * 1024 * 1024) {
    throw problem(413, "VEHICLE_CHECKUP_MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
  }
  let format: string | undefined;
  try {
    format = (await sharp(source, { failOn: "error" }).metadata()).format;
  } catch {
    throw problem(400, "VEHICLE_CHECKUP_MEDIA_INVALID", "图片已损坏或无法识别，请重新选择");
  }
  if (!format || !["jpeg", "png", "webp", "heif"].includes(format)) {
    throw problem(415, "VEHICLE_CHECKUP_MEDIA_TYPE_INVALID", "仅支持 JPEG、PNG、WebP、HEIC 或 HEIF 图片");
  }
  try {
    const processed = await sharp(source, { failOn: "error" })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      data: processed.data,
      width: processed.info.width,
      height: processed.info.height,
      sha256: createHash("sha256").update(processed.data).digest("hex"),
      fields: part.fields,
    };
  } catch {
    throw problem(400, "VEHICLE_CHECKUP_MEDIA_INVALID", "图片已损坏或无法识别，请重新选择");
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function nonEmptyJsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = jsonObject(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function encodeOwnerReportCursor(cursor: OwnerReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeOwnerReportCursor(value: string, problem: ProblemFactory): OwnerReportCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const parsed = ownerReportCursorSchema.safeParse(decoded);
    if (parsed.success) return parsed.data;
  } catch {
    // Report a stable public error below without exposing parser details.
  }
  throw problem(400, "VEHICLE_CHECKUP_REPORT_CURSOR_INVALID", "报告列表游标无效，请刷新后重试");
}

function nestedName(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = (value as Record<string, unknown>).name;
  return name == null || String(name).trim() === "" ? null : String(name);
}

function ownerVehicleSummary(row: Row) {
  const snapshot = nonEmptyJsonObject(row.report_vehicle_snapshot_json)
    ?? nonEmptyJsonObject(row.booking_vehicle_snapshot_json);
  const brandName = nestedName(snapshot?.brand) ?? (row.live_vehicle_brand_name == null ? null : String(row.live_vehicle_brand_name));
  const modelName = nestedName(snapshot?.model) ?? (row.live_vehicle_model_name == null ? null : String(row.live_vehicle_model_name));
  return {
    id: String(snapshot?.id ?? row.vehicle_id),
    plateNumber: String(snapshot?.plateNumber ?? row.live_vehicle_plate_number ?? ""),
    vehicleType: String(snapshot?.vehicleType ?? row.live_vehicle_type ?? ""),
    brandName,
    modelName,
    displayName: [brandName, modelName].filter(Boolean).join(" ")
      || String(snapshot?.vehicleType ?? row.live_vehicle_type ?? "车辆档案"),
  };
}

function ownerStationSummary(row: Row) {
  const snapshot = nonEmptyJsonObject(row.report_station_snapshot_json)
    ?? nonEmptyJsonObject(row.booking_station_snapshot_json);
  return {
    id: String(snapshot?.id ?? row.station_id),
    name: String(snapshot?.name ?? row.live_station_name ?? "机动车检测站"),
    district: String(snapshot?.district ?? row.live_station_district ?? ""),
    address: String(snapshot?.address ?? row.live_station_address ?? ""),
  };
}

function ownerReportSummary(row: Row) {
  const sitePhotoCount = Number(row.site_photo_count ?? 0);
  const faultPhotoCount = Number(row.fault_photo_count ?? 0);
  const photoCount = Number(row.photo_count ?? 0);
  const hasAnnualMark = row.has_annual_mark === true || Number(row.has_annual_mark ?? 0) === 1;
  const hasSafetyInspectionReport = row.has_safety_inspection_report === true
    || Number(row.has_safety_inspection_report ?? 0) === 1;
  const hasEmissionsInspectionReport = row.has_emissions_inspection_report === true
    || Number(row.has_emissions_inspection_report ?? 0) === 1;
  const conclusionView = officialInspectionConclusionView(row.annual_conclusion);
  return {
    bookingId: String(row.booking_id),
    bookingNumber: String(row.booking_number),
    bookingStatus: String(row.booking_status),
    fulfillmentStatus: String(row.canonical_status),
    appointmentDate: String(row.appointment_date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    reportId: String(row.report_id),
    reportNo: String(row.report_no),
    reportStatus: "published" as const,
    schemaVersion: String(row.schema_version),
    publishedAt: String(row.published_at),
    retainUntil: row.retain_until == null ? null : String(row.retain_until),
    vehicle: ownerVehicleSummary(row),
    station: ownerStationSummary(row),
    serviceMode: String(row.service_mode),
    ...conclusionView,
    observationMode: row.observation_mode == null ? null : String(row.observation_mode),
    faultCount: Number(row.fault_count ?? 0),
    sitePhotoCount,
    faultPhotoCount,
    photoCount,
    markStatus: row.annual_mark_status == null ? null : String(row.annual_mark_status),
    hasAnnualMark,
    hasSafetyInspectionReport,
    hasEmissionsInspectionReport,
    legalMaterialsStatus: conclusionView.conclusion === "failed" || (conclusionView.conclusion === "passed" && hasAnnualMark)
      ? "available"
      : "legacy_missing",
  };
}

function ownerReportProgressSummary(row: Row) {
  const reportReady = row.published_report_id != null;
  const fulfillmentStatus = String(row.canonical_status);
  const rawConclusion = row.result_conclusion == null
    ? row.published_conclusion
    : row.result_conclusion;
  return {
    bookingId: String(row.booking_id),
    bookingNumber: String(row.booking_number),
    bookingStatus: String(row.booking_status),
    fulfillmentStatus,
    paymentStatus: String(row.payment_status ?? "unpaid"),
    appointmentDate: String(row.appointment_date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    vehicle: ownerVehicleSummary(row),
    station: ownerStationSummary(row),
    serviceMode: String(row.service_mode),
    progressType: !reportReady && ownerReportPendingStatuses.has(fulfillmentStatus)
      ? "result_pending_report" as const
      : "booking_in_progress" as const,
    ...officialInspectionConclusionView(rawConclusion),
    resultReceivedAt: row.result_received_at == null ? null : String(row.result_received_at),
    reportReady,
    updatedAt: String(row.booking_updated_at),
  };
}

function sixYearsAfter(value: string): string {
  const date = new Date(value);
  date.setUTCFullYear(date.getUTCFullYear() + 6);
  return date.toISOString();
}

function reportNumber(value: Date): string {
  const day = value.toISOString().slice(0, 10).replaceAll("-", "");
  return `YXM-CHK-${day}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function mediaUrl(audience: ReportAudience, bookingId: string, mediaId: string): string {
  if (audience === "owner") return `/api/bookings/${bookingId}/checkup-report/media/${mediaId}`;
  if (audience === "admin") return `/api/admin/bookings/${bookingId}/checkup-report/media/${mediaId}`;
  return `/api/operator/bookings/${bookingId}/checkup-report/media/${mediaId}`;
}

function mediaFromRow(row: Row, audience: ReportAudience) {
  const bookingId = String(row.booking_id);
  const id = String(row.id);
  return {
    id,
    bookingId,
    reportId: String(row.report_id),
    kind: String(row.kind),
    faultId: row.fault_id == null ? null : String(row.fault_id),
    sequence: row.sequence_no == null ? null : Number(row.sequence_no),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    url: mediaUrl(audience, bookingId, id),
    status: String(row.status),
    createdAt: String(row.created_at),
    boundAt: row.bound_at == null ? null : String(row.bound_at),
    expiresAt: String(row.expires_at),
  };
}

function faultFromRow(row: Row, photos: Array<ReturnType<typeof mediaFromRow>> = []) {
  return {
    id: String(row.id),
    clientKey: row.client_key == null ? null : String(row.client_key),
    sequence: Number(row.sequence_no),
    viewId: String(row.view_id),
    regionCode: String(row.region_code),
    faultType: String(row.fault_type),
    severity: String(row.severity),
    description: row.description == null ? null : String(row.description),
    photos,
  };
}

export async function vehicleCheckupReportDto(
  database: AppDatabase,
  bookingId: string,
  audience: ReportAudience = "owner",
): Promise<Record<string, unknown> | null> {
  const report = await database.prepare<Row>(
    "SELECT * FROM vehicle_checkup_reports WHERE booking_id = ?",
  ).get(bookingId);
  if (!report) return null;
  const [faults, mediaRows] = await Promise.all([
    database.prepare<Row>(
      "SELECT * FROM vehicle_checkup_faults WHERE report_id = ? ORDER BY sequence_no ASC",
    ).all(String(report.id)),
    database.prepare<Row>(
      "SELECT * FROM vehicle_checkup_media WHERE report_id = ? ORDER BY created_at ASC, id ASC",
    ).all(String(report.id)),
  ]);
  const allMedia = mediaRows.map((row) => mediaFromRow(row, audience));
  const media = allMedia.filter((item) => item.kind !== faultCloseupKind);
  const faultPhotos = new Map<string, Array<ReturnType<typeof mediaFromRow>>>();
  for (const item of allMedia) {
    if (item.kind !== faultCloseupKind || !item.faultId) continue;
    const photos = faultPhotos.get(item.faultId) ?? [];
    photos.push(item);
    faultPhotos.set(item.faultId, photos);
  }
  for (const photos of faultPhotos.values()) {
    photos.sort((left, right) => Number(left.sequence) - Number(right.sequence));
  }
  const byKind = new Map(media.map((item) => [item.kind, item]));
  const safetyInspectionReport = byKind.get("safety_inspection_report") ?? null;
  const emissionsInspectionReport = byKind.get("emissions_inspection_report") ?? null;
  const markPhoto = byKind.get("annual_inspection_mark") ?? null;
  const conclusionView = officialInspectionConclusionView(report.annual_conclusion);
  const failureDetailsView = officialInspectionFailureDetailsView(
    report.annual_conclusion,
    jsonObject(report.annual_failure_details_json),
  );
  const requiredLegalMaterialsAvailable = report.annual_conclusion === "failed"
    || (report.annual_conclusion === "passed" && Boolean(markPhoto));
  return {
    id: String(report.id),
    bookingId,
    reportNo: String(report.report_no),
    schemaVersion: String(report.schema_version),
    status: String(report.status),
    observationMode: report.observation_mode == null ? null : String(report.observation_mode),
    diagramVersion: String(report.diagram_version),
    summary: safeInspectionConclusionSummary(
      report.annual_conclusion,
      jsonObject(report.summary_json),
    ),
    rowVersion: Number(report.row_version),
    annualInspection: {
      ...conclusionView,
      ...failureDetailsView,
      markStatus: String(report.status) === "published"
        ? (report.annual_mark_status == null ? null : String(report.annual_mark_status))
        : (markPhoto ? "issued" : "not_issued"),
      markPhoto,
    },
    legalMaterials: {
      safetyInspectionReport,
      emissionsInspectionReport,
      annualInspectionMark: markPhoto,
      status: requiredLegalMaterialsAvailable
        ? "available"
        : String(report.status) === "published"
          ? "legacy_missing"
          : "pending",
    },
    sitePhotos: {
      frontLeft: byKind.get("front_left") ?? null,
      frontRight: byKind.get("front_right") ?? null,
      rearLeft: byKind.get("rear_left") ?? null,
      rearRight: byKind.get("rear_right") ?? null,
      dashboardStarted: byKind.get("dashboard_started") ?? null,
    },
    media,
    faults: faults.map((fault) => faultFromRow(fault, faultPhotos.get(String(fault.id)) ?? [])),
    createdAt: String(report.created_at),
    updatedAt: String(report.updated_at),
    publishedAt: report.published_at == null ? null : String(report.published_at),
    retainUntil: report.retain_until == null ? null : String(report.retain_until),
  };
}

async function ensureDraftReport(
  database: AppDatabase,
  booking: Row,
  now: string,
  problem: ProblemFactory,
): Promise<Row> {
  const bookingId = String(booking.id);
  let report = await database.prepare<Row>(
    "SELECT * FROM vehicle_checkup_reports WHERE booking_id = ? FOR UPDATE",
  ).get(bookingId);
  if (report) {
    if (String(report.status) !== "draft") {
      throw problem(409, "VEHICLE_CHECKUP_REPORT_PUBLISHED", "体检报告已发布，不能再修改");
    }
    return report;
  }
  const vehicleSnapshot = jsonObject(booking.vehicle_snapshot_json);
  const stationSnapshot = jsonObject(booking.station_snapshot_json);
  const id = randomUUID();
  await database.prepare(`
    INSERT INTO vehicle_checkup_reports (
      id, booking_id, report_no, schema_version, status, observation_mode,
      diagram_version, annual_conclusion, annual_mark_status, summary_json,
      vehicle_snapshot_json, station_snapshot_json, row_version,
      created_at, updated_at, published_at, retain_until
    ) VALUES (?, ?, ?, 'vehicle-checkup-v2', 'draft', NULL,
      'sedan-3view-v1', NULL, NULL, '{}', ?, ?, 1, ?, ?, NULL, NULL)
  `).run(
    id,
    bookingId,
    reportNumber(new Date(now)),
    JSON.stringify(vehicleSnapshot),
    JSON.stringify(stationSnapshot),
    now,
    now,
  );
  report = await database.prepare<Row>(
    "SELECT * FROM vehicle_checkup_reports WHERE id = ? FOR UPDATE",
  ).get(id);
  if (!report) throw problem(500, "VEHICLE_CHECKUP_REPORT_PERSISTENCE_FAILED", "体检报告创建失败，请重试");
  return report;
}

async function requireEditableBooking(
  database: AppDatabase,
  bookingId: string,
  problem: ProblemFactory,
): Promise<Row> {
  const booking = await database.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(bookingId);
  if (!booking) throw problem(404, "OPERATOR_BOOKING_NOT_FOUND", "未找到本站预约任务");
  const status = String(booking.status);
  const fulfillment = String(booking.fulfillment_status ?? "legacy");
  if (status !== "inspecting" || (fulfillment !== "legacy" && fulfillment !== "inspecting")) {
    throw problem(409, "VEHICLE_CHECKUP_REPORT_NOT_EDITABLE", "仅检测中的任务可以填写车辆体检报告");
  }
  return booking;
}

async function unlinkStored(checkupUploadDir: string, storageKey: unknown): Promise<void> {
  try {
    await unlink(join(checkupUploadDir, String(storageKey)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function cleanupExpiredStagedMedia(database: AppDatabase, checkupUploadDir: string, now: string): Promise<void> {
  // Claim expired staged rows atomically before touching the filesystem. A
  // concurrent publish either changes the row to bound first (so it does not
  // match this DELETE), or waits for this DELETE and then observes that the
  // required media is gone. We must never unlink a path based on a stale
  // pre-publish SELECT.
  const rows = await database.prepare<Row>(`
    DELETE FROM vehicle_checkup_media
    WHERE status = 'staged' AND expires_at <= ?
    RETURNING storage_key
  `).all(now);
  for (const row of rows) {
    await unlinkStored(checkupUploadDir, row.storage_key);
  }
}

function assertReportComposition(
  report: Row,
  faults: Row[],
  media: Row[],
  conclusion: OfficialInspectionConclusion,
  problem: ProblemFactory,
): void {
  const mode = report.observation_mode == null ? null : String(report.observation_mode);
  if (mode === "no_visible_faults" && faults.length > 0) {
    throw problem(409, "VEHICLE_CHECKUP_OBSERVATION_CONFLICT", "未发现明显异常与故障记录不能同时提交");
  }
  if (mode === "faults_recorded" && faults.length === 0) {
    throw problem(409, "VEHICLE_CHECKUP_FAULT_REQUIRED", "请选择至少一个故障位置");
  }
  if (!mode) {
    throw problem(409, "VEHICLE_CHECKUP_OBSERVATION_REQUIRED", "请确认未发现明显异常或完成故障标记");
  }
  const fixedMedia = media.filter((row) => String(row.kind) !== faultCloseupKind);
  const kinds = new Set(fixedMedia.map((row) => String(row.kind)));
  const missing = requiredSitePhotoKinds.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    throw problem(409, "VEHICLE_CHECKUP_PHOTOS_REQUIRED", "请补齐 5 张车辆现场照片", {
      media: `缺少：${missing.join("、")}`,
    });
  }
  const hasMark = kinds.has("annual_inspection_mark");
  if (conclusion === "passed" && !hasMark) {
    throw problem(409, "ANNUAL_INSPECTION_MARK_REQUIRED", "年检合格后必须上传检验合格标志/电子凭证留证");
  }
  if (conclusion !== "passed" && hasMark) {
    throw problem(409, "ANNUAL_INSPECTION_MARK_NOT_ALLOWED", "年检未通过时不能提交检验合格标志/电子凭证留证");
  }
  if (String(report.schema_version) === "vehicle-checkup-v2") {
    const photoCounts = new Map<string, number>();
    for (const row of media) {
      if (String(row.kind) !== faultCloseupKind || row.fault_id == null) continue;
      const faultId = String(row.fault_id);
      photoCounts.set(faultId, (photoCounts.get(faultId) ?? 0) + 1);
    }
    const missingFaultIds = faults
      .map((fault) => String(fault.id))
      .filter((faultId) => (photoCounts.get(faultId) ?? 0) < 1);
    if (missingFaultIds.length > 0) {
      throw problem(409, "VEHICLE_CHECKUP_FAULT_PHOTOS_REQUIRED", "每条故障至少需要 1 张特写照片", {
        faultPhotos: `缺少故障：${missingFaultIds.join("、")}`,
      });
    }
  }
}

/**
 * Validates and publishes a draft report inside the caller's transaction.
 * The caller remains responsible for inserting inspection_results and moving
 * a valet booking to result_received or atomically completing self-drive in
 * the same transaction.
 */
export async function publishVehicleCheckupReport(
  database: AppDatabase,
  bookingId: string,
  conclusion: OfficialInspectionConclusion,
  failureDetails: OfficialInspectionFailureDetails | null,
  summary: Record<string, unknown>,
  publishedAt: string,
  problem: ProblemFactory,
): Promise<Row> {
  if (!isOfficialInspectionConclusion(conclusion)) {
    throw problem(
      409,
      "ANNUAL_INSPECTION_CONCLUSION_UNSUPPORTED",
      "年检结论只能选择通过或未通过",
    );
  }
  if (conclusion === "failed" && !failureDetails) {
    throw problem(
      409,
      "ANNUAL_INSPECTION_FAILURE_DETAILS_REQUIRED",
      "年检未通过时必须填写不合格项目、具体原因和复检建议",
    );
  }
  if (conclusion === "passed" && failureDetails) {
    throw problem(
      409,
      "ANNUAL_INSPECTION_FAILURE_DETAILS_NOT_ALLOWED",
      "年检通过时不能填写不合格详情",
    );
  }
  const report = await database.prepare<Row>(
    "SELECT * FROM vehicle_checkup_reports WHERE booking_id = ? FOR UPDATE",
  ).get(bookingId);
  if (!report) throw problem(409, "VEHICLE_CHECKUP_REPORT_REQUIRED", "请先填写车辆体检报告");
  if (String(report.status) !== "draft") {
    throw problem(409, "VEHICLE_CHECKUP_REPORT_PUBLISHED", "车辆体检报告已经发布");
  }
  const faults = await database.prepare<Row>(
    "SELECT * FROM vehicle_checkup_faults WHERE report_id = ? ORDER BY sequence_no ASC FOR UPDATE",
  ).all(String(report.id));
  const media = await database.prepare<Row>(
    "SELECT * FROM vehicle_checkup_media WHERE report_id = ? ORDER BY created_at ASC FOR UPDATE",
  ).all(String(report.id));
  assertReportComposition(report, faults, media, conclusion, problem);
  const retainUntil = sixYearsAfter(publishedAt);
  const markStatus = conclusion === "passed" ? "issued" : "not_issued";
  await database.prepare(`
    UPDATE vehicle_checkup_reports SET
      status = 'published', annual_conclusion = ?, annual_mark_status = ?,
      annual_failure_details_json = ?, summary_json = ?, row_version = row_version + 1,
      updated_at = ?, published_at = ?, retain_until = ?
    WHERE id = ? AND status = 'draft'
  `).run(
    conclusion,
    markStatus,
    failureDetails == null ? null : JSON.stringify(failureDetails),
    JSON.stringify(summary),
    publishedAt,
    publishedAt,
    retainUntil,
    String(report.id),
  );
  await database.prepare(`
    UPDATE vehicle_checkup_media SET
      status = 'bound', bound_at = ?, expires_at = ?
    WHERE report_id = ?
  `).run(publishedAt, retainUntil, String(report.id));

  // New valet orders treat the report's fixed five site photos as the
  // inspection-complete handoff package. The package is a reference to the
  // immutable published report, so media is not copied and both records are
  // committed in the same result-publication transaction.
  const booking = await database.prepare<Row>(`
    SELECT service_mode, evidence_policy_version FROM bookings WHERE id = ? FOR UPDATE
  `).get(bookingId);
  if (booking
    && String(booking.service_mode) === "valet"
    && String(booking.evidence_policy_version) === VALET_EVIDENCE_POLICY_VERSION) {
    await database.prepare(`
      INSERT INTO valet_evidence_packages (
        id, booking_id, stage, status, source_type, source_report_id,
        captured_by_actor_type, captured_by_label, created_at, updated_at, completed_at
      ) VALUES (?, ?, 'inspection_complete', 'completed', 'checkup_report', ?,
        'operator', '检测站', ?, ?, ?)
      ON CONFLICT(booking_id, stage) DO UPDATE SET
        status = 'completed', source_type = 'checkup_report',
        source_report_id = excluded.source_report_id,
        captured_by_actor_type = 'operator', captured_by_label = '检测站',
        updated_at = excluded.updated_at, completed_at = excluded.completed_at
    `).run(randomUUID(), bookingId, String(report.id), publishedAt, publishedAt, publishedAt);
  }
  return (await database.prepare<Row>("SELECT * FROM vehicle_checkup_reports WHERE id = ?")
    .get(String(report.id)))!;
}

/** Allows historical result rows to complete without fabricating a report. */
export async function assertVehicleCheckupDeliveryReady(
  database: AppDatabase,
  bookingId: string,
  problem: ProblemFactory,
): Promise<void> {
  const report = await database.prepare<Row>(
    "SELECT status FROM vehicle_checkup_reports WHERE booking_id = ?",
  ).get(bookingId);
  if (report && String(report.status) === "published") return;
  const legacyResult = await database.prepare<Row>(
    "SELECT id FROM inspection_results WHERE booking_id = ?",
  ).get(bookingId);
  if (!report && legacyResult) return;
  throw problem(409, "VEHICLE_CHECKUP_REPORT_INCOMPLETE", "车辆体检报告尚未完整发布");
}

async function sendReportMedia(
  database: AppDatabase,
  checkupUploadDir: string,
  bookingId: string,
  mediaId: string,
  reply: FastifyReply,
  problem: ProblemFactory,
  publishedOnly = false,
) {
  const row = await database.prepare<Row>(`
    SELECT m.*, r.status AS report_status
    FROM vehicle_checkup_media m
    JOIN vehicle_checkup_reports r ON r.id = m.report_id
    WHERE m.id = ? AND m.booking_id = ?
  `).get(mediaId, bookingId);
  if (!row || (publishedOnly && String(row.report_status) !== "published")) {
    throw problem(404, "VEHICLE_CHECKUP_MEDIA_NOT_FOUND", "报告照片不存在或不可查看");
  }
  reply.type("image/jpeg").header("Cache-Control", "private, max-age=3600");
  return reply.send(createReadStream(join(checkupUploadDir, String(row.storage_key))));
}

export type VehicleCheckupRouteOptions = {
  uploadDir: string;
  problem: ProblemFactory;
  now?: () => Date;
  getOperatorBookingDetail: (bookingId: string) => Promise<unknown>;
};

export async function registerVehicleCheckupRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: VehicleCheckupRouteOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const checkupUploadDir = join(options.uploadDir, "vehicle-checkup");
  await mkdir(checkupUploadDir, { recursive: true });
  await cleanupExpiredStagedMedia(database, checkupUploadDir, now().toISOString());

  app.get<{ Params: { id: string } }>("/api/operator/bookings/:id/checkup-report", async (request) => {
    const booking = await database.prepare<Row>("SELECT id FROM bookings WHERE id = ?").get(request.params.id);
    if (!booking) throw options.problem(404, "OPERATOR_BOOKING_NOT_FOUND", "未找到本站预约任务");
    return { data: await vehicleCheckupReportDto(database, request.params.id, "operator") };
  });

  app.put<{ Params: { id: string } }>("/api/operator/bookings/:id/checkup-report", async (request, reply) => {
    const parsed = reportDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      throw options.problem(400, "VALIDATION_ERROR", "请检查体检报告内容", validationFields(parsed.error));
    }
    const removedStorageKeys: unknown[] = [];
    await database.transaction(async (transaction) => {
      const booking = await requireEditableBooking(transaction, request.params.id, options.problem);
      const report = await ensureDraftReport(transaction, booking, now().toISOString(), options.problem);
      if (parsed.data.rowVersion !== undefined && parsed.data.rowVersion !== Number(report.row_version)) {
        throw options.problem(409, "VEHICLE_CHECKUP_REPORT_VERSION_CONFLICT", "报告已被更新，请刷新后继续编辑");
      }
      const updatedAt = now().toISOString();
      const conclusion = parsed.data.annualInspection?.conclusion ?? null;
      const failureDetails = parsed.data.annualInspection?.failureDetails ?? null;
      const summary = parsed.data.annualInspection?.summary ?? parsed.data.summary;
      const existingFaults = await transaction.prepare<Row>(
        "SELECT * FROM vehicle_checkup_faults WHERE report_id = ? ORDER BY sequence_no ASC FOR UPDATE",
      ).all(String(report.id));
      const existingById = new Map(existingFaults.map((fault) => [String(fault.id), fault]));
      const existingByClientKey = new Map(
        existingFaults
          .filter((fault) => fault.client_key != null)
          .map((fault) => [String(fault.client_key), fault]),
      );
      const seenClientKeys = new Set<string>();
      const resolvedFaultIds = new Set<string>();
      const resolvedFaults: Array<{
        id: string;
        clientKey: string | null;
        existing: Row | null;
        fault: z.infer<typeof faultSchema>;
      }> = [];
      for (const fault of parsed.data.faults) {
        const legacyClientKey = fault.id?.startsWith("local-") ? fault.id : undefined;
        const clientKey = fault.clientKey ?? legacyClientKey;
        const persistentId = legacyClientKey ? undefined : fault.id;
        if (clientKey) {
          if (seenClientKeys.has(clientKey)) {
            throw options.problem(400, "VALIDATION_ERROR", "请检查体检报告内容", {
              faults: "同一报告中的故障 clientKey 不能重复",
            });
          }
          seenClientKeys.add(clientKey);
        }
        let existing = persistentId ? existingById.get(persistentId) : undefined;
        if (persistentId && !existing) {
          throw options.problem(409, "VEHICLE_CHECKUP_FAULT_NOT_FOUND", "故障记录已变化，请刷新后继续编辑");
        }
        const clientKeyOwner = clientKey ? existingByClientKey.get(clientKey) : undefined;
        if (existing && clientKeyOwner && String(clientKeyOwner.id) !== String(existing.id)) {
          throw options.problem(409, "VEHICLE_CHECKUP_FAULT_CLIENT_KEY_CONFLICT", "故障本地标识已被其他记录使用");
        }
        if (!existing && clientKey) existing = existingByClientKey.get(clientKey);
        if (existing?.client_key != null && clientKey && String(existing.client_key) !== clientKey) {
          throw options.problem(409, "VEHICLE_CHECKUP_FAULT_CLIENT_KEY_CONFLICT", "故障本地标识不能被更改");
        }
        const id = existing ? String(existing.id) : randomUUID();
        if (resolvedFaultIds.has(id)) {
          throw options.problem(400, "VALIDATION_ERROR", "请检查体检报告内容", {
            faults: "同一故障不能在报告中重复出现",
          });
        }
        resolvedFaultIds.add(id);
        resolvedFaults.push({
          id,
          clientKey: clientKey ?? (existing?.client_key == null ? null : String(existing.client_key)),
          existing: existing ?? null,
          fault,
        });
      }
      await transaction.prepare(`
        UPDATE vehicle_checkup_reports SET
          schema_version = 'vehicle-checkup-v2', observation_mode = ?,
          diagram_version = ?, annual_conclusion = ?,
          annual_failure_details_json = ?, annual_mark_status = ?,
          summary_json = ?, row_version = row_version + 1,
          updated_at = ?
        WHERE id = ? AND status = 'draft'
      `).run(
        parsed.data.observationMode,
        parsed.data.diagramVersion,
        conclusion,
        failureDetails == null ? null : JSON.stringify(failureDetails),
        null,
        JSON.stringify(summary),
        updatedAt,
        String(report.id),
      );
      if (existingFaults.length > 0) {
        await transaction.prepare(`
          UPDATE vehicle_checkup_faults
          SET sequence_no = sequence_no + 1000
          WHERE report_id = ?
        `).run(String(report.id));
      }
      for (const [index, resolved] of resolvedFaults.entries()) {
        if (resolved.existing) {
          await transaction.prepare(`
            UPDATE vehicle_checkup_faults SET
              client_key = ?, sequence_no = ?, view_id = ?, region_code = ?,
              fault_type = ?, severity = ?, description = ?, updated_at = ?
            WHERE id = ? AND report_id = ?
          `).run(
            resolved.clientKey,
            index + 1,
            resolved.fault.viewId,
            resolved.fault.regionCode,
            resolved.fault.faultType,
            resolved.fault.severity,
            resolved.fault.description ?? null,
            updatedAt,
            resolved.id,
            String(report.id),
          );
        } else {
          await transaction.prepare(`
            INSERT INTO vehicle_checkup_faults (
              id, report_id, client_key, sequence_no, view_id, region_code,
              fault_type, severity, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            resolved.id,
            String(report.id),
            resolved.clientKey,
            index + 1,
            resolved.fault.viewId,
            resolved.fault.regionCode,
            resolved.fault.faultType,
            resolved.fault.severity,
            resolved.fault.description ?? null,
            updatedAt,
            updatedAt,
          );
        }
      }
      for (const existing of existingFaults) {
        const faultId = String(existing.id);
        if (resolvedFaultIds.has(faultId)) continue;
        const removedMedia = await transaction.prepare<Row>(`
          DELETE FROM vehicle_checkup_media
          WHERE report_id = ? AND fault_id = ? AND kind = 'fault_closeup'
          RETURNING storage_key
        `).all(String(report.id), faultId);
        removedStorageKeys.push(...removedMedia.map((row) => row.storage_key));
        await transaction.prepare(
          "DELETE FROM vehicle_checkup_faults WHERE id = ? AND report_id = ?",
        ).run(faultId, String(report.id));
      }
    });
    for (const storageKey of removedStorageKeys) {
      await unlinkStored(checkupUploadDir, storageKey).catch((error) => {
        app.log.error({ error, storageKey }, "failed to remove deleted fault photo");
      });
    }
    return reply.send({ data: await vehicleCheckupReportDto(database, request.params.id, "operator") });
  });

  app.post<{
    Params: { id: string };
    Querystring: { kind?: string };
  }>("/api/operator/bookings/:id/checkup-report/media", async (request, reply) => {
    await cleanupExpiredStagedMedia(database, checkupUploadDir, now().toISOString());
    const normalized = await normalizeUploadedPhoto(request, options.problem);
    const fieldKind = multipartField(normalized.fields, "kind");
    const kind = reportMediaKindSchema.safeParse(fieldKind || request.query.kind || "");
    if (!kind.success) throw options.problem(400, "VEHICLE_CHECKUP_MEDIA_KIND_INVALID", "报告材料类型无效");
    const id = randomUUID();
    const storageKey = `${randomUUID()}.jpg`;
    await writeFile(join(checkupUploadDir, storageKey), normalized.data, { flag: "wx" });
    let previous: Row | undefined;
    try {
      await database.transaction(async (transaction) => {
        const booking = await requireEditableBooking(transaction, request.params.id, options.problem);
        const createdAt = now().toISOString();
        const report = await ensureDraftReport(transaction, booking, createdAt, options.problem);
        previous = await transaction.prepare<Row>(
          "SELECT * FROM vehicle_checkup_media WHERE report_id = ? AND kind = ? FOR UPDATE",
        ).get(String(report.id), kind.data);
        if (previous) {
          await transaction.prepare("DELETE FROM vehicle_checkup_media WHERE id = ?")
            .run(String(previous.id));
        }
        await transaction.prepare(`
          INSERT INTO vehicle_checkup_media (
            id, booking_id, report_id, kind, status, storage_key, mime_type,
            size_bytes, width, height, sha256, uploader_actor_type,
            created_at, bound_at, expires_at
          ) VALUES (?, ?, ?, ?, 'staged', ?, 'image/jpeg', ?, ?, ?, ?,
            'operator', ?, NULL, ?)
        `).run(
          id,
          request.params.id,
          String(report.id),
          kind.data,
          storageKey,
          normalized.data.length,
          normalized.width,
          normalized.height,
          normalized.sha256,
          createdAt,
          new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
        );
        await transaction.prepare("UPDATE vehicle_checkup_reports SET updated_at = ? WHERE id = ?")
          .run(createdAt, String(report.id));
      });
    } catch (error) {
      await unlinkStored(checkupUploadDir, storageKey);
      throw error;
    }
    if (previous) await unlinkStored(checkupUploadDir, previous.storage_key);
    const row = await database.prepare<Row>("SELECT * FROM vehicle_checkup_media WHERE id = ?").get(id);
    if (!row) throw options.problem(500, "VEHICLE_CHECKUP_MEDIA_PERSISTENCE_FAILED", "照片保存失败，请重试");
    return reply.status(201).send({ data: mediaFromRow(row, "operator") });
  });

  app.post<{
    Params: { id: string; faultId: string };
    Querystring: { replacePhotoId?: string };
  }>("/api/operator/bookings/:id/checkup-report/faults/:faultId/photos", async (request, reply) => {
    await cleanupExpiredStagedMedia(database, checkupUploadDir, now().toISOString());
    const normalized = await normalizeUploadedPhoto(request, options.problem);
    const replacePhotoId = String(
      request.query.replacePhotoId || multipartField(normalized.fields, "replacePhotoId") || "",
    ).trim() || null;
    const suppliedIdempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    if (suppliedIdempotencyKey.length > 160) {
      throw options.problem(400, "IDEMPOTENCY_KEY_INVALID", "幂等键不能超过 160 个字符");
    }
    const idempotencyKey = suppliedIdempotencyKey || null;
    const requestHash = createHash("sha256").update(JSON.stringify({
      bookingId: request.params.id,
      faultId: request.params.faultId,
      replacePhotoId,
      sha256: normalized.sha256,
    })).digest("hex");
    const id = randomUUID();
    const storageKey = `${randomUUID()}.jpg`;
    await writeFile(join(checkupUploadDir, storageKey), normalized.data, { flag: "wx" });
    let previous: Row | undefined;
    let selected: Row | undefined;
    let idempotent = false;
    try {
      await database.transaction(async (transaction) => {
        const booking = await requireEditableBooking(transaction, request.params.id, options.problem);
        const createdAt = now().toISOString();
        const report = await ensureDraftReport(transaction, booking, createdAt, options.problem);
        if (idempotencyKey) {
          const existingUpload = await transaction.prepare<Row>(`
            SELECT * FROM vehicle_checkup_media
            WHERE report_id = ? AND upload_idempotency_key = ?
            FOR UPDATE
          `).get(String(report.id), idempotencyKey);
          if (existingUpload) {
            if (String(existingUpload.upload_request_hash) !== requestHash) {
              throw options.problem(409, "IDEMPOTENCY_KEY_CONFLICT", "幂等键已用于不同的故障照片载荷");
            }
            selected = existingUpload;
            idempotent = true;
            return;
          }
        }
        const fault = await transaction.prepare<Row>(`
          SELECT * FROM vehicle_checkup_faults
          WHERE id = ? AND report_id = ?
          FOR UPDATE
        `).get(request.params.faultId, String(report.id));
        if (!fault) {
          throw options.problem(404, "VEHICLE_CHECKUP_FAULT_NOT_FOUND", "故障不存在或不属于该预约");
        }
        const currentPhotos = await transaction.prepare<Row>(`
          SELECT * FROM vehicle_checkup_media
          WHERE report_id = ? AND fault_id = ? AND kind = 'fault_closeup'
          ORDER BY sequence_no ASC
          FOR UPDATE
        `).all(String(report.id), request.params.faultId);
        let sequence: number;
        if (replacePhotoId) {
          previous = currentPhotos.find((photo) => String(photo.id) === replacePhotoId);
          if (!previous) {
            throw options.problem(404, "VEHICLE_CHECKUP_FAULT_PHOTO_NOT_FOUND", "要替换的故障照片不存在");
          }
          sequence = Number(previous.sequence_no);
          await transaction.prepare("DELETE FROM vehicle_checkup_media WHERE id = ?")
            .run(String(previous.id));
        } else {
          const occupied = new Set(currentPhotos.map((photo) => Number(photo.sequence_no)));
          const available = [1, 2, 3].find((candidate) => !occupied.has(candidate));
          if (!available) {
            throw options.problem(409, "VEHICLE_CHECKUP_FAULT_PHOTO_LIMIT", "每条故障最多上传 3 张特写照片");
          }
          sequence = available;
        }
        selected = await transaction.prepare<Row>(`
          INSERT INTO vehicle_checkup_media (
            id, booking_id, report_id, kind, fault_id, sequence_no, status,
            storage_key, mime_type, size_bytes, width, height, sha256,
            upload_idempotency_key, upload_request_hash, uploader_actor_type,
            created_at, bound_at, expires_at
          ) VALUES (?, ?, ?, 'fault_closeup', ?, ?, 'staged', ?, 'image/jpeg',
            ?, ?, ?, ?, ?, ?, 'operator', ?, NULL, ?)
          RETURNING *
        `).get(
          id,
          request.params.id,
          String(report.id),
          request.params.faultId,
          sequence,
          storageKey,
          normalized.data.length,
          normalized.width,
          normalized.height,
          normalized.sha256,
          idempotencyKey,
          requestHash,
          createdAt,
          new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
        );
        await transaction.prepare(`
          UPDATE vehicle_checkup_reports
          SET schema_version = 'vehicle-checkup-v2', updated_at = ?
          WHERE id = ? AND status = 'draft'
        `).run(createdAt, String(report.id));
      });
    } catch (error) {
      await unlinkStored(checkupUploadDir, storageKey);
      throw error;
    }
    if (idempotent) {
      await unlinkStored(checkupUploadDir, storageKey);
    } else if (previous) {
      await unlinkStored(checkupUploadDir, previous.storage_key).catch((error) => {
        app.log.error({ error, storageKey: previous?.storage_key }, "failed to remove replaced fault photo");
      });
    }
    if (!selected) {
      throw options.problem(500, "VEHICLE_CHECKUP_MEDIA_PERSISTENCE_FAILED", "照片保存失败，请重试");
    }
    return reply.status(idempotent ? 200 : 201).send({
      data: mediaFromRow(selected, "operator"),
      meta: { idempotent, replacedMediaId: replacePhotoId },
    });
  });

  app.delete<{ Params: { id: string; faultId: string; mediaId: string } }>(
    "/api/operator/bookings/:id/checkup-report/faults/:faultId/photos/:mediaId",
    async (request) => {
      let row: Row | undefined;
      await database.transaction(async (transaction) => {
        await requireEditableBooking(transaction, request.params.id, options.problem);
        const report = await transaction.prepare<Row>(`
          SELECT * FROM vehicle_checkup_reports
          WHERE booking_id = ? AND status = 'draft'
          FOR UPDATE
        `).get(request.params.id);
        if (!report) throw options.problem(404, "VEHICLE_CHECKUP_REPORT_NOT_FOUND", "车辆体检报告不存在或已发布");
        const fault = await transaction.prepare<Row>(`
          SELECT id FROM vehicle_checkup_faults
          WHERE id = ? AND report_id = ?
          FOR UPDATE
        `).get(request.params.faultId, String(report.id));
        if (!fault) throw options.problem(404, "VEHICLE_CHECKUP_FAULT_NOT_FOUND", "故障不存在或不属于该预约");
        row = await transaction.prepare<Row>(`
          SELECT * FROM vehicle_checkup_media
          WHERE id = ? AND booking_id = ? AND report_id = ?
            AND fault_id = ? AND kind = 'fault_closeup'
          FOR UPDATE
        `).get(
          request.params.mediaId,
          request.params.id,
          String(report.id),
          request.params.faultId,
        );
        if (!row) throw options.problem(404, "VEHICLE_CHECKUP_FAULT_PHOTO_NOT_FOUND", "故障照片不存在");
        const bookingContext = await checkupAuditBookingContext(transaction, request.params.id);
        await transaction.prepare("DELETE FROM vehicle_checkup_media WHERE id = ?")
          .run(request.params.mediaId);
        await transaction.prepare("UPDATE vehicle_checkup_reports SET updated_at = ? WHERE id = ?")
          .run(now().toISOString(), String(report.id));
        if (bookingContext) {
          const before = {
            id: String(row.id),
            kind: "fault_closeup",
            faultId: request.params.faultId,
            sequenceNo: Number(row.sequence_no),
            sizeBytes: Number(row.size_bytes),
          };
          await auditBackofficeEvent(transaction, {
            request,
            action: "booking.checkup_photo.delete",
            outcome: "success",
            resource: { type: "vehicle_checkup_media", id: request.params.mediaId },
            before,
            after: null,
            presentation: {
              category: "inspection",
              actionLabel: "删除体检照片",
              summary: `删除预约 ${bookingContext.bookingNumber} 的故障特写照片`,
              subjectName: bookingContext.stationName,
              resourceLabel: `预约 ${bookingContext.bookingNumber} · ${bookingContext.plateNumber}`,
              changes: [{ field: "media", label: "体检材料", before: `故障特写第 ${before.sequenceNo} 张`, after: "已删除" }],
            },
          });
        }
      });
      await unlinkStored(checkupUploadDir, row!.storage_key).catch((error) => {
        app.log.error({ error, storageKey: row?.storage_key }, "failed to remove fault photo");
      });
      return { data: { id: request.params.mediaId, deleted: true } };
    },
  );

  app.delete<{ Params: { id: string; mediaId: string } }>(
    "/api/operator/bookings/:id/checkup-report/media/:mediaId",
    async (request) => {
      let row: Row | undefined;
      await database.transaction(async (transaction) => {
        await requireEditableBooking(transaction, request.params.id, options.problem);
        row = await transaction.prepare<Row>(`
          SELECT m.* FROM vehicle_checkup_media m
          JOIN vehicle_checkup_reports r ON r.id = m.report_id
          WHERE m.id = ? AND m.booking_id = ? AND r.status = 'draft'
            AND m.kind <> 'fault_closeup'
          FOR UPDATE OF m
        `).get(request.params.mediaId, request.params.id);
        if (!row) throw options.problem(404, "VEHICLE_CHECKUP_MEDIA_NOT_FOUND", "照片不存在或报告已发布");
        const bookingContext = await checkupAuditBookingContext(transaction, request.params.id);
        await transaction.prepare("DELETE FROM vehicle_checkup_media WHERE id = ?")
          .run(request.params.mediaId);
        await transaction.prepare("UPDATE vehicle_checkup_reports SET updated_at = ? WHERE id = ?")
          .run(now().toISOString(), String(row.report_id));
        if (bookingContext) {
          const kindLabels: Record<string, string> = {
            front_left: "左前现场照",
            front_right: "右前现场照",
            rear_left: "左后现场照",
            rear_right: "右后现场照",
            dashboard_started: "仪表启动照",
            safety_inspection_report: "机动车安全技术检验报告",
            emissions_inspection_report: "排放检验报告",
            annual_inspection_mark: "检验合格标志/电子凭证留证",
          };
          const before = { id: String(row.id), kind: String(row.kind), sizeBytes: Number(row.size_bytes) };
          await auditBackofficeEvent(transaction, {
            request,
            action: "booking.checkup_photo.delete",
            outcome: "success",
            resource: { type: "vehicle_checkup_media", id: request.params.mediaId },
            before,
            after: null,
            presentation: {
              category: "inspection",
              actionLabel: "删除体检照片",
              summary: `删除预约 ${bookingContext.bookingNumber} 的${kindLabels[before.kind] ?? "体检照片"}`,
              subjectName: bookingContext.stationName,
              resourceLabel: `预约 ${bookingContext.bookingNumber} · ${bookingContext.plateNumber}`,
              changes: [{ field: "media", label: "体检材料", before: kindLabels[before.kind] ?? "体检照片", after: "已删除" }],
            },
          });
        }
      });
      await unlinkStored(checkupUploadDir, row!.storage_key).catch((error) => {
        app.log.error({ error, mediaId: request.params.mediaId }, "failed to remove checkup photo after database commit");
      });
      return { data: { id: request.params.mediaId, deleted: true } };
    },
  );

  app.post<{ Params: { id: string } }>("/api/operator/bookings/:id/inspection-result", async (request) => {
    const parsed = manualResultSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw options.problem(400, "VALIDATION_ERROR", "请检查检测结果", validationFields(parsed.error));
    }
    const suppliedIdempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    if (suppliedIdempotencyKey.length > 160) {
      throw options.problem(400, "IDEMPOTENCY_KEY_INVALID", "幂等键不能超过 160 个字符");
    }
    const idempotencyKey = suppliedIdempotencyKey || `operator-manual-${request.params.id}`;
    let idempotent = false;
    await database.transaction(async (transaction) => {
      const booking = await transaction.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE")
        .get(request.params.id);
      if (!booking) throw options.problem(404, "OPERATOR_BOOKING_NOT_FOUND", "未找到本站预约任务");
      const report = await transaction.prepare<Row>(
        "SELECT * FROM vehicle_checkup_reports WHERE booking_id = ? FOR UPDATE",
      ).get(request.params.id);
      const existingResult = await transaction.prepare<Row>(
        "SELECT * FROM inspection_results WHERE booking_id = ?",
      ).get(request.params.id);
      if (existingResult) {
        if (String(existingResult.source) === "operator_manual" && String(report?.status) === "published") {
          if (String(existingResult.idempotency_key) !== idempotencyKey) {
            throw options.problem(409, "DUPLICATE_INSPECTION_RESULT", "该订单已经使用其他幂等键提交过检测结果");
          }
          const retryPayload = {
            bookingId: request.params.id,
            externalResultId: parsed.data.externalResultId ?? String(existingResult.external_result_id),
            conclusion: parsed.data.conclusion ?? String(existingResult.conclusion),
            summary: parsed.data.summary ?? jsonObject(existingResult.summary_json),
            source: "operator_manual",
            ...(existingResult.failure_details_json == null
              ? {}
              : {
                  failureDetails: officialInspectionFailureDetailsView(
                    existingResult.conclusion,
                    jsonObject(existingResult.failure_details_json),
                  ).failureDetails,
                }),
          };
          if (inspectionResultRequestHash(retryPayload) !== String(existingResult.request_hash)) {
            throw options.problem(409, "IDEMPOTENCY_KEY_CONFLICT", "幂等键已用于不同的检测结果载荷");
          }
          idempotent = true;
          return;
        }
        throw options.problem(409, "DUPLICATE_INSPECTION_RESULT", "该订单已经回传检测结果");
      }
      const beforeAuditContext = await checkupAuditBookingContext(transaction, request.params.id);
      const status = String(booking.status);
      const fulfillment = String(booking.fulfillment_status ?? "legacy");
      if (status !== "inspecting" || (fulfillment !== "legacy" && fulfillment !== "inspecting")) {
        throw options.problem(409, "INVALID_BOOKING_TRANSITION", "仅检测中的任务可以提交结果");
      }
      if (!report) throw options.problem(409, "VEHICLE_CHECKUP_REPORT_REQUIRED", "请先填写车辆体检报告");
      const conclusion = parsed.data.conclusion
        ?? (report.annual_conclusion == null ? undefined : String(report.annual_conclusion));
      if (!conclusion) {
        throw options.problem(409, "ANNUAL_INSPECTION_CONCLUSION_REQUIRED", "请选择年检结论");
      }
      if (!isOfficialInspectionConclusion(conclusion)) {
        throw options.problem(
          409,
          "ANNUAL_INSPECTION_CONCLUSION_UNSUPPORTED",
          "历史报告结论已停用，请重新选择通过或未通过",
        );
      }
      const typedConclusion = conclusion;
      const persistedFailureDetails = officialInspectionFailureDetailsView(
        report.annual_conclusion,
        jsonObject(report.annual_failure_details_json),
      ).failureDetails;
      const failureDetails = typedConclusion === "failed"
        ? (parsed.data.failureDetails ?? persistedFailureDetails)
        : null;
      const summary = parsed.data.summary ?? jsonObject(report.summary_json);
      const externalResultId = parsed.data.externalResultId
        ?? `MANUAL-${createHash("sha256").update(request.params.id).digest("hex").slice(0, 32)}`;
      const resultPayload = {
        bookingId: request.params.id,
        externalResultId,
        conclusion: typedConclusion,
        summary,
        source: "operator_manual",
        ...(failureDetails == null ? {} : { failureDetails }),
      };
      const receivedAt = now().toISOString();
      const completesSelfDriveService = String(booking.service_mode) === "self_drive";
      const completedAt = completesSelfDriveService
        ? new Date(Date.parse(receivedAt) + 1).toISOString()
        : receivedAt;
      if (completesSelfDriveService) {
        await assertAnnualBookingFinancialClosureReady(transaction, request.params.id, options.problem);
      }
      await publishVehicleCheckupReport(
        transaction,
        request.params.id,
        typedConclusion,
        failureDetails,
        summary,
        receivedAt,
        options.problem,
      );
      await transaction.prepare(`
        INSERT INTO inspection_results (
          id, booking_id, external_result_id, conclusion, failure_details_json,
          summary_json, source, received_at, idempotency_key, request_hash
        ) VALUES (?, ?, ?, ?, ?, ?, 'operator_manual', ?, ?, ?)
      `).run(
        randomUUID(),
        request.params.id,
        externalResultId,
        typedConclusion,
        failureDetails == null ? null : JSON.stringify(failureDetails),
        JSON.stringify(summary),
        receivedAt,
        idempotencyKey,
        inspectionResultRequestHash(resultPayload),
      );
      await transaction.prepare(`
        UPDATE bookings SET
          status = ?,
          fulfillment_status = CASE
            WHEN fulfillment_status = 'legacy' THEN 'legacy'
            ELSE ?
          END,
          updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
        WHERE id = ?
      `).run(
        completesSelfDriveService ? "completed" : "result_received",
        completesSelfDriveService ? "completed" : "result_received",
        completesSelfDriveService ? completedAt : receivedAt,
        completesSelfDriveService ? "completed" : "result_received",
        completesSelfDriveService ? completedAt : receivedAt,
        request.params.id,
      );
      if (completesSelfDriveService) {
        const bookingMediaExpiresAt = new Date(Date.parse(completedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
        await transaction.prepare("UPDATE booking_media SET expires_at = ? WHERE booking_id = ?")
          .run(bookingMediaExpiresAt, request.params.id);
      }
      await transaction.prepare(`
        INSERT INTO booking_events (
          id, booking_id, status, title, description, actor_type, metadata_json, created_at
        ) VALUES (?, ?, 'result_received', '检测结果与体检报告已回传',
          '检测站已提交车辆现场记录和年检结论', 'operator', ?, ?)
      `).run(
        randomUUID(),
        request.params.id,
        JSON.stringify({ externalResultId, conclusion: typedConclusion, source: "operator_manual" }),
        receivedAt,
      );
      if (completesSelfDriveService) {
        await transaction.prepare(`
          INSERT INTO booking_events (
            id, booking_id, status, title, description, actor_type, metadata_json, created_at
          ) VALUES (?, ?, 'completed', '自驾年检服务已自动完成',
            '有效检测结果和完整报告已发布给车主，无需再次人工确认', 'system', ?, ?)
        `).run(
          randomUUID(),
          request.params.id,
          JSON.stringify({ trigger: "report_publication", reportDelivered: true }),
          completedAt,
        );
      }
      const bookingContext = await checkupAuditBookingContext(transaction, request.params.id);
      const publishedReport = await transaction.prepare<Row>(`
        SELECT id, report_no, status, annual_conclusion, annual_mark_status
        FROM vehicle_checkup_reports WHERE booking_id = ?
      `).get(request.params.id);
      if (beforeAuditContext && bookingContext && publishedReport) {
        const faultCount = await transaction.prepare<Row>("SELECT COUNT(*) AS count FROM vehicle_checkup_faults WHERE report_id = ?")
          .get(String(publishedReport.id));
        const photoCount = await transaction.prepare<Row>("SELECT COUNT(*) AS count FROM vehicle_checkup_media WHERE report_id = ?")
          .get(String(publishedReport.id));
        const conclusionLabels: Record<string, string> = {
          passed: "通过",
          failed: "未通过",
        };
        const after = {
          ...bookingContext,
          reportNo: String(publishedReport.report_no),
          reportStatus: String(publishedReport.status),
          conclusion: typedConclusion,
          annualMarkStatus: publishedReport.annual_mark_status == null ? null : String(publishedReport.annual_mark_status),
          faultCount: Number(faultCount?.count ?? 0),
          photoCount: Number(photoCount?.count ?? 0),
        };
        await auditBackofficeEvent(transaction, {
          request,
          action: "booking.inspection_result.submit",
          outcome: "success",
          resource: { type: "booking", id: request.params.id },
          before: { ...beforeAuditContext, reportStatus: "draft", inspectionResult: null },
          after,
          presentation: {
            category: "inspection",
            actionLabel: "提交检验结果",
            summary: `提交预约 ${bookingContext.bookingNumber} 的检验结果：${conclusionLabels[typedConclusion]}`,
            subjectName: bookingContext.stationName,
            resourceLabel: `预约 ${bookingContext.bookingNumber} · ${bookingContext.plateNumber}`,
            changes: [
              { field: "conclusion", label: "检验结论", before: "未提交", after: conclusionLabels[typedConclusion] },
              { field: "reportNo", label: "体检报告", before: "草稿", after: String(publishedReport.report_no) },
              { field: "evidence", label: "报告材料", before: "未发布", after: `${after.faultCount} 条故障 · ${after.photoCount} 张照片` },
            ],
          },
        });
      }
    });
    return { data: await options.getOperatorBookingDetail(request.params.id), meta: { idempotent } };
  });

  app.get<{
    Querystring: { vehicleId?: string; limit?: string; cursor?: string };
  }>("/api/vehicle-checkup-reports", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const parsed = ownerReportListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw options.problem(400, "VALIDATION_ERROR", "报告列表参数有误", validationFields(parsed.error));
    }
    const { vehicleId, limit } = parsed.data;
    const cursor = parsed.data.cursor
      ? decodeOwnerReportCursor(parsed.data.cursor, options.problem)
      : null;

    const itemConditions = ["b.user_id = ?", "r.status = 'published'", "r.published_at IS NOT NULL"];
    const itemParameters: Array<string | number> = [userId];
    if (vehicleId) {
      itemConditions.push("b.vehicle_id = ?");
      itemParameters.push(vehicleId);
    }
    if (cursor) {
      itemConditions.push("(r.published_at < ? OR (r.published_at = ? AND r.id < ?))");
      itemParameters.push(cursor.publishedAt, cursor.publishedAt, cursor.reportId);
    }
    itemParameters.push(limit + 1);
    const itemRows = await database.prepare<Row>(`
      SELECT
        b.id AS booking_id,
        b.booking_number,
        b.status AS booking_status,
        CASE
          WHEN COALESCE(b.fulfillment_status, 'legacy') = 'legacy' THEN b.status
          ELSE b.fulfillment_status
        END AS canonical_status,
        b.vehicle_id,
        b.station_id,
        b.service_mode,
        b.appointment_date,
        b.start_time,
        b.end_time,
        b.vehicle_snapshot_json AS booking_vehicle_snapshot_json,
        b.station_snapshot_json AS booking_station_snapshot_json,
        r.id AS report_id,
        r.report_no,
        r.schema_version,
        r.observation_mode,
        r.annual_conclusion,
        r.annual_mark_status,
        r.vehicle_snapshot_json AS report_vehicle_snapshot_json,
        r.station_snapshot_json AS report_station_snapshot_json,
        r.published_at,
        r.retain_until,
        v.plate_number AS live_vehicle_plate_number,
        v.vehicle_type AS live_vehicle_type,
        v.brand_name AS live_vehicle_brand_name,
        v.model_name AS live_vehicle_model_name,
        s.name AS live_station_name,
        s.district AS live_station_district,
        s.address AS live_station_address,
        (SELECT COUNT(*)::INTEGER FROM vehicle_checkup_faults f WHERE f.report_id = r.id) AS fault_count,
        (SELECT COUNT(*)::INTEGER FROM vehicle_checkup_media m
          WHERE m.report_id = r.id
            AND m.kind IN ('front_left', 'front_right', 'rear_left', 'rear_right', 'dashboard_started')) AS site_photo_count,
        (SELECT COUNT(*)::INTEGER FROM vehicle_checkup_media m
          WHERE m.report_id = r.id AND m.kind = 'fault_closeup') AS fault_photo_count,
        (SELECT COUNT(*)::INTEGER FROM vehicle_checkup_media m WHERE m.report_id = r.id) AS photo_count,
        EXISTS (
          SELECT 1 FROM vehicle_checkup_media m
          WHERE m.report_id = r.id AND m.kind = 'annual_inspection_mark'
        ) AS has_annual_mark,
        EXISTS (
          SELECT 1 FROM vehicle_checkup_media m
          WHERE m.report_id = r.id AND m.kind = 'safety_inspection_report'
        ) AS has_safety_inspection_report,
        EXISTS (
          SELECT 1 FROM vehicle_checkup_media m
          WHERE m.report_id = r.id AND m.kind = 'emissions_inspection_report'
        ) AS has_emissions_inspection_report
      FROM vehicle_checkup_reports r
      JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN stations s ON s.id = b.station_id
      WHERE ${itemConditions.join(" AND ")}
      ORDER BY r.published_at DESC, r.id DESC
      LIMIT ?
    `).all(...itemParameters);
    const hasMore = itemRows.length > limit;
    const pageRows = itemRows.slice(0, limit);
    const lastRow = pageRows.at(-1);
    const nextCursor = hasMore && lastRow
      ? encodeOwnerReportCursor({
          publishedAt: String(lastRow.published_at),
          reportId: String(lastRow.report_id),
        })
      : null;

    const progressConditions = ["b.user_id = ?"];
    const progressParameters: string[] = [userId];
    if (vehicleId) {
      progressConditions.push("b.vehicle_id = ?");
      progressParameters.push(vehicleId);
    }
    const progressRows = await database.prepare<Row>(`
      SELECT
        b.id AS booking_id,
        b.booking_number,
        b.status AS booking_status,
        CASE
          WHEN COALESCE(b.fulfillment_status, 'legacy') = 'legacy' THEN b.status
          ELSE b.fulfillment_status
        END AS canonical_status,
        b.payment_status,
        b.vehicle_id,
        b.station_id,
        b.service_mode,
        b.appointment_date,
        b.start_time,
        b.end_time,
        b.updated_at AS booking_updated_at,
        b.vehicle_snapshot_json AS booking_vehicle_snapshot_json,
        b.station_snapshot_json AS booking_station_snapshot_json,
        NULL AS report_vehicle_snapshot_json,
        NULL AS report_station_snapshot_json,
        CASE WHEN r.status = 'published' THEN r.id ELSE NULL END AS published_report_id,
        CASE WHEN r.status = 'published' THEN r.annual_conclusion ELSE NULL END AS published_conclusion,
        ir.id AS result_id,
        ir.conclusion AS result_conclusion,
        ir.received_at AS result_received_at,
        v.plate_number AS live_vehicle_plate_number,
        v.vehicle_type AS live_vehicle_type,
        v.brand_name AS live_vehicle_brand_name,
        v.model_name AS live_vehicle_model_name,
        s.name AS live_station_name,
        s.district AS live_station_district,
        s.address AS live_station_address
      FROM bookings b
      LEFT JOIN vehicle_checkup_reports r ON r.booking_id = b.id
      LEFT JOIN inspection_results ir ON ir.booking_id = b.id
      LEFT JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN stations s ON s.id = b.station_id
      WHERE ${progressConditions.join(" AND ")}
        AND (
          (CASE
            WHEN COALESCE(b.fulfillment_status, 'legacy') = 'legacy' THEN b.status
            ELSE b.fulfillment_status
          END) NOT IN ('completed', 'cancelled', 'no_show')
          OR (
            (CASE
              WHEN COALESCE(b.fulfillment_status, 'legacy') = 'legacy' THEN b.status
              ELSE b.fulfillment_status
            END) IN ('result_received', 'returning', 'completed')
            AND COALESCE(r.status, '') <> 'published'
          )
        )
      ORDER BY
        CASE WHEN (CASE
          WHEN COALESCE(b.fulfillment_status, 'legacy') = 'legacy' THEN b.status
          ELSE b.fulfillment_status
        END) NOT IN ('completed', 'cancelled', 'no_show') THEN 0 ELSE 1 END,
        b.updated_at DESC,
        b.id DESC
    `).all(...progressParameters);

    return {
      data: {
        progress: progressRows.map(ownerReportProgressSummary),
        items: pageRows.map(ownerReportSummary),
      },
      meta: { limit, nextCursor },
    };
  });

  app.get<{ Params: { id: string } }>("/api/bookings/:id/checkup-report", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const booking = await database.prepare<Row>("SELECT id FROM bookings WHERE id = ? AND user_id = ?")
      .get(request.params.id, userId);
    if (!booking) throw options.problem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    const report = await vehicleCheckupReportDto(database, request.params.id, "owner");
    if (report && report.status !== "published") return { data: null };
    return { data: report };
  });

  app.get<{ Params: { id: string } }>("/api/admin/bookings/:id/checkup-report", async (request) => {
    const booking = await database.prepare<Row>("SELECT id FROM bookings WHERE id = ?").get(request.params.id);
    if (!booking) throw options.problem(404, "BOOKING_NOT_FOUND", "未找到该预约");
    return { data: await vehicleCheckupReportDto(database, request.params.id, "admin") };
  });

  app.get<{ Params: { id: string; mediaId: string } }>(
    "/api/operator/bookings/:id/checkup-report/media/:mediaId",
    async (request, reply) => sendReportMedia(
      database,
      checkupUploadDir,
      request.params.id,
      request.params.mediaId,
      reply,
      options.problem,
    ),
  );

  app.get<{ Params: { id: string; mediaId: string } }>(
    "/api/admin/bookings/:id/checkup-report/media/:mediaId",
    async (request, reply) => sendReportMedia(
      database,
      checkupUploadDir,
      request.params.id,
      request.params.mediaId,
      reply,
      options.problem,
    ),
  );

  app.get<{ Params: { id: string; mediaId: string } }>(
    "/api/bookings/:id/checkup-report/media/:mediaId",
    async (request, reply) => {
      const userId = await requireCurrentUser(request, database);
      const booking = await database.prepare<Row>("SELECT id FROM bookings WHERE id = ? AND user_id = ?")
        .get(request.params.id, userId);
      if (!booking) throw options.problem(404, "VEHICLE_CHECKUP_MEDIA_NOT_FOUND", "报告照片不存在或不可查看");
      return sendReportMedia(
        database,
        checkupUploadDir,
        request.params.id,
        request.params.mediaId,
        reply,
        options.problem,
        true,
      );
    },
  );
}
