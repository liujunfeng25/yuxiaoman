import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import {
  assertCapability,
  auditBackofficeEvent,
  backofficeForRequest,
  requireRepairShopBearer,
  scopedRepairShopId,
  type BackofficeCapability,
  type BackofficeSession,
} from "./backoffice.js";
import type { AppDatabase } from "./database.js";
import { officialInspectionConclusionView } from "./inspection-conclusion.js";
import { precheckGuidance, precheckVehiclePhotoKinds } from "./precheck-policy.js";
import {
  enableRepairWorkflowForRequest,
  syncRepairWorkflowForRequest,
} from "./workflow-integration.js";
import {
  buildMiniProgramPayParams,
  createDomesticRefund,
  createJsapiPrepay,
  isMockPaymentAllowed,
  isWechatPayConfigured,
  loadConfig as loadWechatPayConfig,
  scaleWechatChargeAmountFen,
  wechatAmountDivisor,
} from "./wechat-pay.js";

type Row = Record<string, unknown>;
function jsonArray(value: unknown): unknown[] {
  try { const parsed: unknown = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
type ProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

export type RepairRouteOptions = {
  uploadDir: string;
  problem: ProblemFactory;
  now?: () => Date;
};

const idSchema = z.string().trim().min(1).max(160);
const createRequestSchema = z.object({ reportId: idSchema }).strict();
const quoteSchema = z.object({
  totalPriceFen: z.number().int().positive().max(100_000_000),
  note: z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/u.test(value), "报价说明请保持为一句话"),
}).strict();
const paymentSchema = z.object({
  quoteId: idSchema,
  idempotencyKey: z.string().trim().min(8).max(160),
}).strict();

const DEMO_NOTICE = "标有“演示”的维修门店、报价及历史模拟支付为合成数据，不进入真实结算。";
const SERVICE_BOUNDARY = "平台记录本次报价与支付；后续维修范围、现场确认项目和时间由车主与中选门店协商。";

function validationFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown, problem: ProblemFactory): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw problem(400, "VALIDATION_ERROR", "提交的信息有误，请检查后重试", validationFields(parsed.error));
}

function bool(value: unknown): boolean {
  return value === true || Number(value) === 1;
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

function nestedName(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = (value as Record<string, unknown>).name;
  return name == null || String(name).trim() === "" ? null : String(name);
}

function maskedPlate(value: unknown): string {
  const plate = String(value ?? "");
  if (!plate) return "***";
  if (plate.length <= 3) return "***";
  return `${plate.slice(0, 2)}***${plate.slice(-1)}`;
}

function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
}

function assertMockPaymentEnabled(problem: ProblemFactory): void {
  if (!isMockPaymentAllowed() || (isProductionEnvironment() && process.env.ALLOW_MOCK_PAYMENT !== "true")) {
    throw problem(503, "MOCK_PAYMENT_DISABLED", "当前环境未启用模拟支付");
  }
}

async function wechatOpenIdForRepairUser(database: AppDatabase, userId: string): Promise<string | null> {
  const appId = process.env.WECHAT_MINIPROGRAM_APP_ID?.trim() ?? "";
  if (!appId) return null;
  const row = await database.prepare<Row>(`
    SELECT provider_subject FROM user_identities
    WHERE user_id = ? AND provider = 'wechat' AND provider_app_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(userId, appId);
  const openid = row?.provider_subject == null ? "" : String(row.provider_subject).trim();
  return openid || null;
}

function requestNumber(now: Date): string {
  return `YXM-REP-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function orderNumber(now: Date): string {
  return `YXM-RO-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function shopSummary(row: Row) {
  return {
    id: String(row.shop_id ?? row.id),
    name: String(row.shop_name ?? row.name),
    district: String(row.shop_district ?? row.district),
    distanceKm: Number(row.shop_distance_km ?? row.distance_km ?? row.distanceKm),
    rating: Number(row.shop_rating ?? row.rating),
    isDemo: bool(row.shop_is_demo ?? row.is_demo ?? row.isDemo),
  };
}

function shopPrivateDto(row: Row) {
  return {
    ...shopSummary(row),
    address: String(row.shop_address ?? row.address),
    contactName: String(row.shop_contact_name ?? row.contact_name ?? row.contactName),
    contactPhone: String(row.shop_contact_phone ?? row.contact_phone ?? row.contactPhone),
    openHours: String(row.shop_open_hours ?? row.open_hours ?? row.openHours),
  };
}

function vehicleSnapshotFromSource(row: Row): Record<string, unknown> {
  const source = jsonObject(row.report_vehicle_snapshot_json);
  const fallback = jsonObject(row.booking_vehicle_snapshot_json);
  const combined = { ...fallback, ...source };
  const brandName = nestedName(combined.brand)
    ?? (combined.brandName == null ? null : String(combined.brandName))
    ?? (row.live_brand_name == null ? null : String(row.live_brand_name));
  const modelName = nestedName(combined.model)
    ?? (combined.modelName == null ? null : String(combined.modelName))
    ?? (row.live_model_name == null ? null : String(row.live_model_name));
  const vehicleType = String(combined.vehicleType ?? row.live_vehicle_type ?? "车辆档案");
  return {
    ...combined,
    id: String(combined.id ?? row.vehicle_id),
    plateNumber: String(combined.plateNumber ?? row.live_plate_number ?? ""),
    vehicleType,
    brandName,
    modelName,
    displayName: [brandName, modelName].filter(Boolean).join(" ") || vehicleType,
  };
}

function ownerVehicleDto(snapshot: Record<string, unknown>) {
  return {
    id: String(snapshot.id ?? ""),
    plateNumber: String(snapshot.plateNumber ?? ""),
    vehicleType: String(snapshot.vehicleType ?? ""),
    exteriorColor: snapshot.exteriorColor == null ? null : String(snapshot.exteriorColor),
    brandName: snapshot.brandName == null ? null : String(snapshot.brandName),
    modelName: snapshot.modelName == null ? null : String(snapshot.modelName),
    displayName: String(snapshot.displayName ?? snapshot.vehicleType ?? "车辆档案"),
  };
}

const repairReportNumberPattern = /^YXM-CHK-\d{8}-[A-F0-9]{8}$/u;
const repairObservationModes = new Set(["no_visible_faults", "faults_recorded"]);

function repairConclusionLabel(
  conclusion: "passed" | "failed" | null,
  status: string,
): string {
  if (conclusion === "passed") return "检验合格";
  if (conclusion === "failed") return "检验不合格";
  return status === "legacy_requires_reentry" ? "历史结论待重新确认" : "检验结论待确认";
}

function safeRepairReportSnapshot(value: unknown): Record<string, unknown> {
  const snapshot = jsonObject(value);
  if (snapshot.sourceType === "precheck") return {
    sourceType: "precheck", reportNo: "年检预检问题", publishedAt: null,
    annualConclusion: null, annualConclusionStatus: "pending", observationMode: "faults_recorded",
    summary: { conclusionLabel: "预检问题记录，非正式检验结论" },
  };
  const conclusion = snapshot.annualConclusion === "passed" || snapshot.annualConclusion === "failed"
    ? snapshot.annualConclusion
    : null;
  const requestedStatus = String(snapshot.annualConclusionStatus ?? "");
  const annualConclusionStatus = conclusion
    ? "available"
    : requestedStatus === "legacy_requires_reentry" ? requestedStatus : "pending";
  const reportNo = String(snapshot.reportNo ?? "");
  const publishedAt = String(snapshot.publishedAt ?? "");
  const observationMode = String(snapshot.observationMode ?? "");
  return {
    reportNo: repairReportNumberPattern.test(reportNo) ? reportNo : "平台检测报告",
    publishedAt: Number.isFinite(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null,
    annualConclusion: conclusion,
    annualConclusionStatus,
    observationMode: repairObservationModes.has(observationMode) ? observationMode : null,
    summary: {
      conclusionLabel: repairConclusionLabel(conclusion, annualConclusionStatus),
    },
  };
}

function reportSnapshotFromSource(row: Row): Record<string, unknown> {
  const conclusionView = officialInspectionConclusionView(row.annual_conclusion);
  return safeRepairReportSnapshot({
    reportNo: String(row.report_no),
    publishedAt: String(row.published_at),
    annualConclusion: conclusionView.conclusion,
    annualConclusionStatus: conclusionView.conclusionStatus,
    observationMode: row.observation_mode == null ? null : String(row.observation_mode),
  });
}

function quoteDto(row: Row) {
  return {
    id: String(row.id),
    status: String(row.status),
    totalPriceFen: Number(row.total_price_fen),
    note: String(row.note),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    shop: shopSummary(row),
  };
}

function mediaDto(row: Row, requestId: string, audience: "owner" | "shop") {
  const id = String(row.id);
  return {
    id,
    sourceMediaId: String(row.source_media_id ?? row.precheck_media_id ?? ""),
    kind: String(row.kind),
    faultId: row.fault_id == null ? null : String(row.fault_id),
    sequence: row.sequence_no == null ? null : Number(row.sequence_no),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    url: audience === "owner"
      ? `/api/repair/requests/${requestId}/media/${id}`
      : `/api/repair-operator/requests/${requestId}/media/${id}`,
  };
}

async function activeRepairShop(
  database: AppDatabase,
  shopId: string,
  problem: ProblemFactory,
): Promise<Row> {
  const shop = await database.prepare<Row>(`
    SELECT * FROM repair_shops
    WHERE id = ? AND is_active = 1
  `).get(shopId);
  if (!shop) throw problem(404, "REPAIR_SHOP_NOT_FOUND", "未找到该维修门店");
  return shop;
}

async function requireRepairOperator(
  request: FastifyRequest,
  database: AppDatabase,
  problem: ProblemFactory,
  capabilities: BackofficeCapability[],
): Promise<{ principal: BackofficeSession; shopId: string; shop: Row }> {
  const principal = await requireRepairShopBearer(request, database);
  for (const capability of capabilities) assertCapability(principal, capability);
  const shopId = scopedRepairShopId(principal);
  if (!shopId) throw problem(404, "REPAIR_SHOP_NOT_FOUND", "未找到该维修门店");
  const shop = await activeRepairShop(database, shopId, problem);
  return { principal, shopId, shop };
}

async function lockAndRevalidateRepairOperator(
  database: AppDatabase,
  principal: BackofficeSession,
  shopId: string,
  problem: ProblemFactory,
): Promise<Row> {
  const row = await database.prepare<Row>(`
    SELECT rs.id, rs.name, rs.is_demo, rs.is_active
    FROM backoffice_sessions bs
    JOIN backoffice_accounts a
      ON a.id = bs.account_id
    JOIN backoffice_subject_assignments sa
      ON sa.account_id = a.id
      AND sa.subject_type = 'repair_shop'
      AND sa.status = 'active'
    JOIN repair_shops rs
      ON rs.id = sa.subject_id
    WHERE bs.id = ?
      AND bs.account_id = ?
      AND bs.revoked_at IS NULL
      AND bs.permission_version = a.permission_version
      AND a.permission_version = ?
      AND a.role = 'repair_shop_admin'
      AND a.status = 'active'
      AND sa.subject_id = ?
      AND rs.is_active = 1
    FOR UPDATE OF bs, a, sa, rs
  `).get(
    principal.sessionId,
    principal.account.id,
    principal.permissionVersion,
    shopId,
  );
  if (!row) throw problem(404, "REPAIR_SHOP_NOT_FOUND", "未找到该维修门店");
  return row;
}

function quoteAmountLabel(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

function operatorListItem(row: Row) {
  const vehicle = jsonObject(row.vehicle_snapshot_json);
  return {
    id: String(row.id),
    requestNo: String(row.request_no),
    status: String(row.status),
    shopStatus: String(row.status) === "paid" ? "won" as const : "quoting" as const,
    vehicle: {
      plateNumberMasked: maskedPlate(vehicle.plateNumber),
      vehicleType: String(vehicle.vehicleType ?? ""),
      exteriorColor: vehicle.exteriorColor == null ? null : String(vehicle.exteriorColor),
      displayName: String(vehicle.displayName ?? vehicle.vehicleType ?? "车辆档案"),
    },
    report: safeRepairReportSnapshot(row.report_snapshot_json),
    ownerContact: null,
    faultCount: Number(row.fault_count ?? 0),
    primaryFault: row.primary_fault_region_code == null ? null : {
      regionCode: String(row.primary_fault_region_code),
      faultType: String(row.primary_fault_type),
      severity: String(row.primary_fault_severity),
    },
    activeQuoteCount: Number(row.active_quote_count ?? 0),
    ownQuote: row.own_quote_id == null ? null : {
      id: String(row.own_quote_id),
      status: String(row.own_quote_status),
      totalPriceFen: Number(row.own_quote_total_price_fen),
      note: String(row.own_quote_note),
      revision: Number(row.own_quote_revision),
    },
    createdAt: String(row.created_at),
    demoNotice: DEMO_NOTICE,
  };
}

async function requestRows(database: AppDatabase, requestId: string) {
  const [request, faults, media, quotes, order] = await Promise.all([
    database.prepare<Row>("SELECT * FROM repair_requests WHERE id = ?").get(requestId),
    database.prepare<Row>("SELECT * FROM repair_request_faults WHERE request_id = ? ORDER BY sequence_no, id").all(requestId),
    database.prepare<Row>("SELECT * FROM repair_request_media WHERE request_id = ? ORDER BY kind, sequence_no NULLS FIRST, id").all(requestId),
    database.prepare<Row>(`
      SELECT q.*,
        s.id AS shop_id, s.name AS shop_name, s.district AS shop_district,
        s.distance_km AS shop_distance_km, s.rating AS shop_rating,
        s.is_demo AS shop_is_demo
      FROM repair_quotes q
      JOIN repair_shops s ON s.id = q.shop_id
      WHERE q.request_id = ?
      ORDER BY
        CASE q.status WHEN 'active' THEN 0 WHEN 'selected' THEN 1 WHEN 'lost' THEN 2 ELSE 3 END,
        q.total_price_fen, q.updated_at DESC, q.id
    `).all(requestId),
    database.prepare<Row>(`
      SELECT o.*,
        COALESCE(p.id, mp.id) AS payment_id,
        COALESCE(p.provider, mp.provider) AS payment_provider,
        COALESCE(p.status, mp.status) AS payment_status,
        COALESCE(p.amount_fen, mp.amount_fen) AS payment_amount_fen,
        COALESCE(p.channel_amount_fen, p.amount_fen, mp.amount_fen) AS payment_channel_amount_fen,
        COALESCE(p.confirmed_at, mp.confirmed_at::timestamptz) AS payment_confirmed_at
      FROM repair_orders o
      LEFT JOIN repair_order_payments p ON p.order_id = o.id AND p.kind = 'charge' AND p.status <> 'failed'
      LEFT JOIN repair_mock_payments mp ON mp.order_id = o.id
      WHERE o.request_id = ?
    `).get(requestId),
  ]);
  return { request, faults, media, quotes, order };
}

async function ownerRequestDetail(database: AppDatabase, requestId: string, userId: string, problem: ProblemFactory) {
  const rows = await requestRows(database, requestId);
  if (!rows.request || String(rows.request.user_id) !== userId) {
    throw problem(404, "REPAIR_REQUEST_NOT_FOUND", "未找到该维修询价");
  }
  const request = rows.request;
  const vehicle = ownerVehicleDto(jsonObject(request.vehicle_snapshot_json));
  const report = jsonObject(request.report_snapshot_json);
  const media = rows.media.map((row) => mediaDto(row, requestId, "owner"));
  const photosByFault = new Map<string, ReturnType<typeof mediaDto>[]>();
  for (const item of media) {
    if (!item.faultId) continue;
    const photos = photosByFault.get(item.faultId) ?? [];
    photos.push(item);
    photosByFault.set(item.faultId, photos);
  }
  const order = rows.order;
  return {
    id: requestId,
    requestNo: String(request.request_no),
    sourceType: String(request.source_type ?? "report"),
    sourceBookingId: String(request.source_booking_id),
    status: String(request.status),
    createdAt: String(request.created_at),
    updatedAt: String(request.updated_at),
    cancelledAt: request.cancelled_at == null ? null : String(request.cancelled_at),
    paidAt: request.paid_at == null ? null : String(request.paid_at),
    demoNotice: DEMO_NOTICE,
    serviceBoundary: SERVICE_BOUNDARY,
    vehicle,
    report,
    faults: rows.faults.map((fault) => ({
      id: String(fault.id),
      sourceFaultId: String(fault.source_fault_id ?? fault.precheck_reason_code ?? ""),
      sequence: Number(fault.sequence_no),
      viewId: String(fault.view_id),
      regionCode: String(fault.region_code),
      faultType: String(fault.fault_type),
      severity: String(fault.severity),
      description: fault.description == null ? null : String(fault.description),
      photos: photosByFault.get(String(fault.id)) ?? [],
    })),
    media,
    quotes: rows.quotes.map(quoteDto),
    selectedQuoteId: request.selected_quote_id == null ? null : String(request.selected_quote_id),
    order: order ? {
      id: String(order.id),
      orderNo: String(order.order_no),
      status: String(order.status),
      totalPriceFen: Number(order.total_price_fen),
      paidAt: order.paid_at == null ? null : String(order.paid_at),
      shop: String(order.status) === "paid" ? shopPrivateDto(jsonObject(order.shop_snapshot_json)) : null,
      payment: {
        provider: String(order.payment_provider ?? "mock"),
        status: String(order.payment_status ?? "pending"),
        amountFen: Number(order.payment_amount_fen ?? order.total_price_fen),
        channelAmountFen: Number(order.payment_channel_amount_fen ?? order.payment_amount_fen ?? 0),
        confirmedAt: order.payment_confirmed_at == null ? null : String(order.payment_confirmed_at),
      },
    } : null,
  };
}

async function assertShopCanReadRequest(
  database: AppDatabase,
  requestId: string,
  shopId: string,
  problem: ProblemFactory,
  httpRequest: FastifyRequest,
  principal: BackofficeSession,
): Promise<Row> {
  const repairRequest = await database.prepare<Row>("SELECT * FROM repair_requests WHERE id = ?").get(requestId);
  if (!repairRequest || String(repairRequest.status) === "cancelled") {
    throw problem(404, "DEMO_REPAIR_REQUEST_NOT_FOUND", "未找到可查看的维修需求");
  }
  if (String(repairRequest.status) === "open") return repairRequest;
  const order = await database.prepare<Row>(`
    SELECT id FROM repair_orders WHERE request_id = ? AND shop_id = ?
  `).get(requestId, shopId);
  if (!order) {
    if (!httpRequest.backofficeDeniedAudited) {
      httpRequest.backofficeDeniedAudited = true;
      await auditBackofficeEvent(database, {
        request: httpRequest,
        principal,
        action: "backoffice.authorization.denied",
        outcome: "denied",
        resource: { type: "repair_request" },
        metadata: { reason: "repair_paid_request_wrong_shop" },
        presentation: {
          category: "account_security",
          actionLabel: "访问未授权维修需求",
          summary: "尝试访问不属于本门店的已成交维修需求，系统已拒绝",
          subjectName: principal.subject?.name ?? "当前维修门店",
          resourceLabel: "已成交维修需求",
          reason: "该需求已成交，仅中标维修门店可以继续查看",
        },
      }).catch(() => undefined);
    }
    throw problem(404, "DEMO_REPAIR_REQUEST_NOT_FOUND", "未找到可查看的维修需求");
  }
  return repairRequest;
}

async function shopRequestDetail(
  database: AppDatabase,
  requestId: string,
  shopId: string,
  problem: ProblemFactory,
  httpRequest: FastifyRequest,
  principal: BackofficeSession,
) {
  const request = await assertShopCanReadRequest(
    database,
    requestId,
    shopId,
    problem,
    httpRequest,
    principal,
  );
  const [faults, media, ownQuote, order] = await Promise.all([
    database.prepare<Row>("SELECT * FROM repair_request_faults WHERE request_id = ? ORDER BY sequence_no, id").all(requestId),
    database.prepare<Row>("SELECT * FROM repair_request_media WHERE request_id = ? ORDER BY kind, sequence_no NULLS FIRST, id").all(requestId),
    database.prepare<Row>("SELECT * FROM repair_quotes WHERE request_id = ? AND shop_id = ?").get(requestId, shopId),
    database.prepare<Row>("SELECT * FROM repair_orders WHERE request_id = ? AND shop_id = ?").get(requestId, shopId),
  ]);
  const vehicleSnapshot = jsonObject(request.vehicle_snapshot_json);
  const mediaDtos = media.map((row) => mediaDto(row, requestId, "shop"));
  const photosByFault = new Map<string, ReturnType<typeof mediaDto>[]>();
  for (const item of mediaDtos) {
    if (!item.faultId) continue;
    const photos = photosByFault.get(item.faultId) ?? [];
    photos.push(item);
    photosByFault.set(item.faultId, photos);
  }
  return {
    id: requestId,
    requestNo: String(request.request_no),
    status: String(request.status),
    createdAt: String(request.created_at),
    demoNotice: DEMO_NOTICE,
    serviceBoundary: SERVICE_BOUNDARY,
    vehicle: {
      id: String(vehicleSnapshot.id ?? ""),
      plateNumberMasked: maskedPlate(vehicleSnapshot.plateNumber),
      vehicleType: String(vehicleSnapshot.vehicleType ?? ""),
      exteriorColor: vehicleSnapshot.exteriorColor == null ? null : String(vehicleSnapshot.exteriorColor),
      brandName: vehicleSnapshot.brandName == null ? null : String(vehicleSnapshot.brandName),
      modelName: vehicleSnapshot.modelName == null ? null : String(vehicleSnapshot.modelName),
      displayName: String(vehicleSnapshot.displayName ?? vehicleSnapshot.vehicleType ?? "车辆档案"),
    },
    report: safeRepairReportSnapshot(request.report_snapshot_json),
    faults: faults.map((fault) => ({
      id: String(fault.id),
      sequence: Number(fault.sequence_no),
      viewId: String(fault.view_id),
      regionCode: String(fault.region_code),
      faultType: String(fault.fault_type),
      severity: String(fault.severity),
      description: fault.description == null ? null : String(fault.description),
      photos: photosByFault.get(String(fault.id)) ?? [],
    })),
    media: mediaDtos,
    ownerContact: order ? jsonObject(order.owner_contact_snapshot_json) : null,
    ownQuote: ownQuote ? {
      id: String(ownQuote.id),
      status: String(ownQuote.status),
      totalPriceFen: Number(ownQuote.total_price_fen),
      note: String(ownQuote.note),
      revision: Number(ownQuote.revision),
      createdAt: String(ownQuote.created_at),
      updatedAt: String(ownQuote.updated_at),
    } : null,
  };
}

/** Complete a real repair payment from the signed WeChat callback. */
export async function confirmRepairWechatPaymentByOutTradeNo(
  database: AppDatabase,
  input: {
    outTradeNo: string;
    amountFen: number;
    transactionId?: string;
    now?: string;
    problem?: ProblemFactory;
  },
): Promise<"confirmed" | "already_confirmed" | "not_found"> {
  const problem = input.problem ?? ((statusCode, code, message) => {
    const error = new Error(message) as Error & { statusCode: number; code: string };
    error.statusCode = statusCode;
    error.code = code;
    return error;
  });
  const paidAt = input.now ?? new Date().toISOString();
  return database.transaction(async (tx) => {
    const payment = await tx.prepare<Row>(`
      SELECT * FROM repair_order_payments WHERE out_trade_no = ? FOR UPDATE
    `).get(input.outTradeNo);
    if (!payment) return "not_found";
    if (String(payment.status) === "confirmed") return "already_confirmed";
    if (String(payment.kind) !== "charge" || String(payment.status) !== "pending") {
      throw problem(409, "REPAIR_PAYMENT_NOT_PENDING", "当前维修支付单不能确认");
    }
    if (input.amountFen > 0 && Number(payment.amount_fen) !== input.amountFen) {
      throw problem(409, "WECHAT_AMOUNT_MISMATCH", "支付金额与维修订单不一致");
    }
    const order = await tx.prepare<Row>("SELECT * FROM repair_orders WHERE id = ? FOR UPDATE")
      .get(String(payment.order_id));
    if (!order) throw problem(404, "REPAIR_ORDER_NOT_FOUND", "未找到维修订单");
    if (String(order.status) === "paid") {
      await tx.prepare(`
        UPDATE repair_order_payments SET status = 'confirmed', confirmed_at = ?::timestamptz,
          transaction_id = COALESCE(?, transaction_id), channel_amount_fen = ?
        WHERE id = ?
      `).run(paidAt, input.transactionId ?? null, input.amountFen || Number(payment.amount_fen), String(payment.id));
      return "already_confirmed";
    }
    if (String(order.status) !== "pending_payment") {
      throw problem(409, "REPAIR_ORDER_NOT_PAYABLE", "当前维修订单不能确认支付");
    }
    await tx.prepare(`
      UPDATE repair_order_payments SET status = 'confirmed', confirmed_at = ?::timestamptz,
        transaction_id = COALESCE(?, transaction_id), channel_amount_fen = ?
      WHERE id = ? AND status = 'pending'
    `).run(paidAt, input.transactionId ?? null, input.amountFen || Number(payment.amount_fen), String(payment.id));
    await tx.prepare("UPDATE repair_orders SET status = 'paid', paid_at = ?::timestamptz WHERE id = ?")
      .run(paidAt, String(order.id));
    await tx.prepare(`
      UPDATE repair_quotes SET status = CASE WHEN id = ? THEN 'selected' ELSE 'lost' END,
        selected_at = CASE WHEN id = ? THEN ?::timestamptz ELSE NULL END, updated_at = ?::timestamptz
      WHERE request_id = ?
    `).run(String(order.quote_id), String(order.quote_id), paidAt, paidAt, String(order.request_id));
    await tx.prepare(`
      UPDATE repair_requests SET status = 'paid', selected_quote_id = ?, paid_at = ?::timestamptz,
        updated_at = ?::timestamptz WHERE id = ?
    `).run(String(order.quote_id), paidAt, paidAt, String(order.request_id));
    await syncRepairWorkflowForRequest(tx, String(order.request_id), {
      now: new Date(paidAt), actorType: "owner", actorId: String(order.user_id),
    });
    return "confirmed";
  });
}

export async function registerRepairRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: RepairRouteOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const checkupUploadDir = join(options.uploadDir, "vehicle-checkup");

  app.post("/api/repair/precheck-requests", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(z.object({
      bookingId: idSchema, expectedVersion: z.number().int().positive(), consented: z.literal(true),
      reasonCodes: z.array(z.enum(["body_damage", "dashboard_warning"])).min(1).max(2),
    }).strict(), request.body, options.problem);
    const copiedFiles: string[] = [];
    const result = await database.transaction(async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE").get(body.bookingId, userId);
      if (!booking) throw options.problem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      const precheck = await tx.prepare<Row>("SELECT * FROM booking_prechecks WHERE booking_id = ? FOR UPDATE").get(body.bookingId);
      if (!precheck || booking.fulfillment_status !== "precheck_action_required" || booking.payment_status !== "paid") throw options.problem(409, "PRECHECK_STATE_CHANGED", "当前预检状态不能发起维修报价");
      const existing = await tx.prepare<Row>("SELECT id FROM repair_requests WHERE source_booking_id = ? AND source_type = 'precheck' AND status IN ('open', 'paid')").get(body.bookingId);
      if (existing) return { id: String(existing.id), created: false };
      if (Number(precheck.version) !== body.expectedVersion) throw options.problem(409, "PRECHECK_VERSION_CONFLICT", "预检记录已更新，请重新确认共享内容");
      const codes = new Set(jsonArray(precheck.reason_codes_json).map(String));
      if (new Set(body.reasonCodes).size !== body.reasonCodes.length || body.reasonCodes.some((code) => !codes.has(code))) throw options.problem(400, "PRECHECK_REPAIR_SCOPE_INVALID", "只能共享检测站本次标注的车损或故障灯问题");
      const selectedKinds = new Set(jsonArray(precheck.issue_photo_kinds_json).map(String));
      const media = (await tx.prepare<Row>("SELECT * FROM booking_media WHERE booking_id = ? AND is_current = 1 ORDER BY kind").all(body.bookingId))
        .filter((item) => precheckVehiclePhotoKinds.includes(String(item.kind)) && selectedKinds.has(String(item.kind))
          && (item.kind === "dashboard_started" ? body.reasonCodes.includes("dashboard_warning") : body.reasonCodes.includes("body_damage")));
      for (const code of body.reasonCodes) {
        if (!media.some((item) => code === "dashboard_warning" ? item.kind === "dashboard_started" : String(item.kind).startsWith("vehicle_"))) throw options.problem(409, "PRECHECK_REPAIR_MEDIA_REQUIRED", "维修问题缺少对应照片，请先联系检测站补充标注");
      }
      const id = randomUUID();
      const createdAt = now().toISOString();
      const vehicle = vehicleSnapshotFromSource({ ...booking, report_vehicle_snapshot_json: booking.vehicle_snapshot_json });
      const report = safeRepairReportSnapshot({ sourceType: "precheck" });
      await tx.prepare(`INSERT INTO repair_requests (id, request_no, user_id, source_report_id, source_booking_id, source_vehicle_id,
        vehicle_snapshot_json, report_snapshot_json, synthetic_owner_contact_json, created_at, updated_at, source_type, source_precheck_version)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'precheck', ?)`)
        .run(id, requestNumber(new Date(createdAt)), userId, body.bookingId, String(booking.vehicle_id), JSON.stringify(vehicle), JSON.stringify(report),
          JSON.stringify({ name: "演示车主", phone: "13800006666", isSynthetic: true, notice: "合成演示联系方式" }), createdAt, createdAt, body.expectedVersion);
      await mkdir(checkupUploadDir, { recursive: true });
      for (const [index, code] of body.reasonCodes.entries()) {
        const faultId = randomUUID();
        const label = precheckGuidance.find((item) => item.code === code)!.label;
        await tx.prepare(`INSERT INTO repair_request_faults (id, request_id, source_fault_id, precheck_reason_code, sequence_no, view_id, region_code, fault_type, severity, description, created_at)
          VALUES (?, ?, NULL, ?, ?, 'top', ?, 'other', 'unassessed', ?, ?)`)
          .run(faultId, id, code, index + 1, code === "dashboard_warning" ? "dashboard" : "body", label + "；由门店核对维修范围，需到店确认的项目和费用应在报价中说明。", createdAt);
        const photos = media.filter((item) => code === "dashboard_warning" ? item.kind === "dashboard_started" : String(item.kind).startsWith("vehicle_"));
        for (const [photoIndex, photo] of photos.entries()) {
          // Independent private copies survive resubmission, cancellation and source retention cleanup.
          const bytes = await readFile(join(options.uploadDir, String(photo.storage_key)));
          const key = `precheck-${randomUUID()}.jpg`;
          await writeFile(join(checkupUploadDir, key), bytes, { flag: "wx" });
          copiedFiles.push(join(checkupUploadDir, key));
          await tx.prepare(`INSERT INTO repair_request_media (id, request_id, fault_id, source_media_id, precheck_media_id, kind, sequence_no, storage_key,
            mime_type, size_bytes, width, height, sha256, created_at) VALUES (?, ?, ?, NULL, ?, 'fault_closeup', ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), id, faultId, String(photo.id), photoIndex + 1, key, String(photo.mime_type), Number(photo.size_bytes),
              Number(photo.width), Number(photo.height), createHash("sha256").update(bytes).digest("hex"), createdAt);
        }
      }
      await tx.prepare(`INSERT INTO booking_events (id, booking_id, status, title, description, actor_type, created_at, metadata_json)
        VALUES (?, ?, 'precheck_action_required', '车主已发起维修报价', '已授权共享所选问题及相关车辆照片，行驶证不向维修大厅共享。', 'owner', ?, ?)`)
        .run(randomUUID(), body.bookingId, createdAt, JSON.stringify({ requestId: id, reasonCodes: body.reasonCodes, consented: true, precheckVersion: body.expectedVersion }));
      await enableRepairWorkflowForRequest(tx, id, {
        now: new Date(createdAt),
        actorType: "owner",
        actorId: userId,
      });
      return { id, created: true };
    }).catch(async (error: unknown) => {
      await Promise.all(copiedFiles.map((path) => unlink(path).catch(() => undefined)));
      throw error;
    });
    if (result.created) reply.status(201);
    return { data: await ownerRequestDetail(database, result.id, userId, options.problem) };
  });

  app.post("/api/repair/requests", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(createRequestSchema, request.body, options.problem);
    const result = await database.transaction(async (transaction) => {
      const source = await transaction.prepare<Row>(`
        SELECT r.*,
          r.vehicle_snapshot_json AS report_vehicle_snapshot_json,
          b.user_id, b.vehicle_id, b.id AS booking_id,
          b.vehicle_snapshot_json AS booking_vehicle_snapshot_json,
          v.plate_number AS live_plate_number,
          v.vehicle_type AS live_vehicle_type,
          v.brand_name AS live_brand_name,
          v.model_name AS live_model_name
        FROM vehicle_checkup_reports r
        JOIN bookings b ON b.id = r.booking_id
        LEFT JOIN vehicles v ON v.id = b.vehicle_id
        WHERE r.id = ? AND b.user_id = ?
        FOR UPDATE OF r, b
      `).get(body.reportId, userId);
      if (!source) throw options.problem(404, "VEHICLE_CHECKUP_REPORT_NOT_FOUND", "未找到可用于询价的车辆体检报告");

      const existing = await transaction.prepare<Row>(`
        SELECT id FROM repair_requests WHERE source_report_id = ?
      `).get(body.reportId);
      if (existing) return { id: String(existing.id), created: false };
      if (String(source.status) !== "published" || source.published_at == null) {
        throw options.problem(409, "REPAIR_REPORT_NOT_PUBLISHED", "车辆体检报告发布后才能发起维修询价");
      }
      const faults = await transaction.prepare<Row>(`
        SELECT * FROM vehicle_checkup_faults WHERE report_id = ? ORDER BY sequence_no, id
      `).all(body.reportId);
      if (faults.length === 0) {
        throw options.problem(409, "REPAIR_REPORT_HAS_NO_FAULTS", "报告未记录车损，不能发起维修询价");
      }
      const sourceMedia = await transaction.prepare<Row>(`
        SELECT * FROM vehicle_checkup_media
        WHERE report_id = ? AND status = 'bound'
          AND kind = 'fault_closeup' AND fault_id IS NOT NULL
        ORDER BY kind, sequence_no NULLS FIRST, id
      `).all(body.reportId);

      const createdAt = now().toISOString();
      const id = randomUUID();
      const vehicleSnapshot = vehicleSnapshotFromSource(source);
      const reportSnapshot = reportSnapshotFromSource(source);
      const syntheticOwnerContact = {
        name: "演示车主",
        phone: "13800006666",
        isSynthetic: true,
        notice: "合成演示联系方式，仅供选中门店演示线下协商",
      };
      await transaction.prepare(`
        INSERT INTO repair_requests (
          id, request_no, user_id, source_report_id, source_booking_id,
          source_vehicle_id, status, vehicle_snapshot_json,
          report_snapshot_json, synthetic_owner_contact_json,
          selected_quote_id, created_at, updated_at, paid_at, cancelled_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?, ?, NULL, NULL)
      `).run(
        id,
        requestNumber(new Date(createdAt)),
        userId,
        body.reportId,
        String(source.booking_id),
        String(source.vehicle_id),
        JSON.stringify(vehicleSnapshot),
        JSON.stringify(reportSnapshot),
        JSON.stringify(syntheticOwnerContact),
        createdAt,
        createdAt,
      );

      const faultIds = new Map<string, string>();
      for (const fault of faults) {
        const faultId = randomUUID();
        faultIds.set(String(fault.id), faultId);
        await transaction.prepare(`
          INSERT INTO repair_request_faults (
            id, request_id, source_fault_id, sequence_no, view_id,
            region_code, fault_type, severity, description, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          faultId,
          id,
          String(fault.id),
          Number(fault.sequence_no),
          String(fault.view_id),
          String(fault.region_code),
          String(fault.fault_type),
          String(fault.severity),
          fault.description == null ? null : String(fault.description),
          createdAt,
        );
      }
      for (const media of sourceMedia) {
        const sourceFaultId = media.fault_id == null ? null : String(media.fault_id);
        const repairFaultId = sourceFaultId == null ? null : faultIds.get(sourceFaultId);
        if (sourceFaultId && !repairFaultId) {
          throw options.problem(409, "REPAIR_REPORT_SNAPSHOT_INCOMPLETE", "报告故障照片关联异常，请刷新报告后重试");
        }
        await transaction.prepare(`
          INSERT INTO repair_request_media (
            id, request_id, fault_id, source_media_id, kind, sequence_no,
            storage_key, mime_type, size_bytes, width, height, sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          id,
          repairFaultId,
          String(media.id),
          String(media.kind),
          media.sequence_no == null ? null : Number(media.sequence_no),
          String(media.storage_key),
          String(media.mime_type),
          Number(media.size_bytes),
          Number(media.width),
          Number(media.height),
          String(media.sha256),
          createdAt,
        );
      }
      await enableRepairWorkflowForRequest(transaction, id, {
        now: new Date(createdAt),
        actorType: "owner",
        actorId: userId,
      });
      return { id, created: true };
    });
    if (result.created) reply.status(201);
    return {
      data: await ownerRequestDetail(database, result.id, userId, options.problem),
      meta: { created: result.created },
    };
  });

  app.get("/api/repair/requests", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const rows = await database.prepare<Row>(`
      SELECT r.*,
        (SELECT COUNT(*)::INTEGER FROM repair_quotes q
          WHERE q.request_id = r.id AND q.status IN ('active', 'selected')) AS quote_count,
        (SELECT MIN(q.total_price_fen)::INTEGER FROM repair_quotes q
          WHERE q.request_id = r.id AND q.status IN ('active', 'selected')) AS lowest_price_fen
      FROM repair_requests r
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC, r.id DESC
    `).all(userId);
    return {
      data: rows.map((row) => ({
        id: String(row.id),
        requestNo: String(row.request_no),
        status: String(row.status),
        vehicle: ownerVehicleDto(jsonObject(row.vehicle_snapshot_json)),
        report: jsonObject(row.report_snapshot_json),
        quoteCount: Number(row.quote_count ?? 0),
        lowestPriceFen: row.lowest_price_fen == null ? null : Number(row.lowest_price_fen),
        selectedQuoteId: row.selected_quote_id == null ? null : String(row.selected_quote_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        paidAt: row.paid_at == null ? null : String(row.paid_at),
        cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
        demoNotice: DEMO_NOTICE,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/repair/requests/:id", async (request) => {
    const userId = await requireCurrentUser(request, database);
    return { data: await ownerRequestDetail(database, request.params.id, userId, options.problem) };
  });

  app.post<{ Params: { id: string } }>("/api/repair/requests/:id/cancel", async (request) => {
    const userId = await requireCurrentUser(request, database);
    await database.transaction(async (transaction) => {
      const row = await transaction.prepare<Row>(`
        SELECT * FROM repair_requests WHERE id = ? AND user_id = ? FOR UPDATE
      `).get(request.params.id, userId);
      if (!row) throw options.problem(404, "REPAIR_REQUEST_NOT_FOUND", "未找到该维修询价");
      if (String(row.status) === "cancelled") return;
      if (String(row.status) !== "open") {
        throw options.problem(409, "REPAIR_REQUEST_NOT_CANCELLABLE", "已支付的维修询价不能取消");
      }
      const cancelledAt = now().toISOString();
      await transaction.prepare(`
        UPDATE repair_requests
        SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE id = ?
      `).run(cancelledAt, cancelledAt, request.params.id);
      await transaction.prepare(`
        UPDATE repair_quotes
        SET status = 'lost', updated_at = ?
        WHERE request_id = ? AND status <> 'lost'
      `).run(cancelledAt, request.params.id);
      await syncRepairWorkflowForRequest(transaction, request.params.id, {
        now: new Date(cancelledAt),
        actorType: "owner",
        actorId: userId,
      });
    });
    return { data: await ownerRequestDetail(database, request.params.id, userId, options.problem) };
  });

  app.post<{ Params: { id: string } }>("/api/repair/requests/:id/payments", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(paymentSchema, request.body, options.problem);
    if (!isWechatPayConfigured()) throw options.problem(503, "WECHAT_PAY_NOT_CONFIGURED", "微信支付尚未配置完成");
    const appId = process.env.WECHAT_MINIPROGRAM_APP_ID?.trim() ?? "";
    if (!appId) throw options.problem(503, "WECHAT_APP_ID_MISSING", "未配置小程序 AppID");
    const openid = await wechatOpenIdForRepairUser(database, userId);
    if (!openid) throw options.problem(409, "WECHAT_OPENID_REQUIRED", "请先完成微信登录后再支付");
    const payConfig = loadWechatPayConfig();
    if (!payConfig) throw options.problem(503, "WECHAT_PAY_NOT_CONFIGURED", "微信支付尚未配置完成");
    const prepared = await database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")
        .get(`repair-wechat:${userId}:${body.idempotencyKey}`);
      const existingPayment = await tx.prepare<Row>(`
        SELECT p.*, o.request_id AS paid_request_id, o.quote_id AS paid_quote_id
        FROM repair_order_payments p JOIN repair_orders o ON o.id = p.order_id
        WHERE p.provider = 'wechat' AND p.idempotency_key = ?
      `).get(body.idempotencyKey);
      if (existingPayment) {
        if (String(existingPayment.user_id) !== userId
          || String(existingPayment.paid_request_id) !== request.params.id
          || String(existingPayment.paid_quote_id) !== body.quoteId) {
          throw options.problem(409, "REPAIR_PAYMENT_IDEMPOTENCY_CONFLICT", "该幂等键已用于其他维修报价");
        }
        if (String(existingPayment.status) === "failed") {
          throw options.problem(409, "REPAIR_PAYMENT_RETRY_KEY_REQUIRED", "本次支付已失败，请重新发起支付");
        }
        return { payment: existingPayment, created: false };
      }
      const repairRequest = await tx.prepare<Row>(`
        SELECT * FROM repair_requests WHERE id = ? AND user_id = ? FOR UPDATE
      `).get(request.params.id, userId);
      if (!repairRequest) throw options.problem(404, "REPAIR_REQUEST_NOT_FOUND", "未找到该维修询价");
      if (["cancelled", "refunded"].includes(String(repairRequest.status))) {
        throw options.problem(409, "REPAIR_REQUEST_NOT_PAYABLE", "当前维修询价状态不能支付");
      }
      const quote = await tx.prepare<Row>(`
        SELECT q.*, s.name AS shop_name, s.district AS shop_district, s.address AS shop_address,
          s.distance_km AS shop_distance_km, s.rating AS shop_rating,
          s.contact_name AS shop_contact_name, s.contact_phone AS shop_contact_phone,
          s.open_hours AS shop_open_hours, s.is_demo AS shop_is_demo
        FROM repair_quotes q JOIN repair_shops s ON s.id = q.shop_id AND s.is_active = 1
        WHERE q.id = ? AND q.request_id = ? FOR UPDATE OF q, s
      `).get(body.quoteId, request.params.id);
      if (!quote) throw options.problem(404, "REPAIR_QUOTE_NOT_FOUND", "未找到该维修报价");
      if (String(repairRequest.status) === "open" && String(quote.status) !== "active") {
        throw options.problem(409, "REPAIR_QUOTE_NOT_ACTIVE", "该维修报价已撤回或失效，请选择其他报价");
      }
      let order = await tx.prepare<Row>("SELECT * FROM repair_orders WHERE request_id = ? FOR UPDATE")
        .get(request.params.id);
      const createdAt = now().toISOString();
      if (order) {
        if (String(order.quote_id) !== body.quoteId) {
          throw options.problem(409, "REPAIR_REQUEST_PAYMENT_LOCKED", "已有另一份维修报价正在支付");
        }
        if (String(order.status) === "paid") {
          const confirmed = await tx.prepare<Row>(`
            SELECT * FROM repair_order_payments WHERE order_id = ? AND kind = 'charge' AND status = 'confirmed'
          `).get(String(order.id));
          if (!confirmed) throw options.problem(409, "REPAIR_PAYMENT_STATE_INVALID", "维修订单支付状态异常");
          return { payment: confirmed, created: false };
        }
        const pendingPayment = await tx.prepare<Row>(`
          SELECT * FROM repair_order_payments
          WHERE order_id = ? AND kind = 'charge' AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1
        `).get(String(order.id));
        if (pendingPayment) return { payment: pendingPayment, created: false };
      } else {
        if (String(repairRequest.status) !== "open") {
          throw options.problem(409, "REPAIR_REQUEST_NOT_PAYABLE", "当前维修询价状态不能支付");
        }
        const [faults, media] = await Promise.all([
          tx.prepare<Row>("SELECT * FROM repair_request_faults WHERE request_id = ? ORDER BY sequence_no, id").all(request.params.id),
          tx.prepare<Row>("SELECT * FROM repair_request_media WHERE request_id = ? ORDER BY kind, sequence_no NULLS FIRST, id").all(request.params.id),
        ]);
        const orderId = randomUUID();
        const requestSnapshot = {
          id: request.params.id, requestNo: String(repairRequest.request_no),
          vehicle: jsonObject(repairRequest.vehicle_snapshot_json), report: jsonObject(repairRequest.report_snapshot_json),
          faults: faults.map((fault) => ({
            id: String(fault.id), sourceFaultId: String(fault.source_fault_id ?? fault.precheck_reason_code ?? ""),
            sequence: Number(fault.sequence_no), viewId: String(fault.view_id), regionCode: String(fault.region_code),
            faultType: String(fault.fault_type), severity: String(fault.severity),
            description: fault.description == null ? null : String(fault.description),
          })),
          media: media.map((item) => ({
            id: String(item.id), sourceMediaId: String(item.source_media_id ?? item.precheck_media_id ?? ""),
            faultId: item.fault_id == null ? null : String(item.fault_id), kind: String(item.kind),
            sequence: item.sequence_no == null ? null : Number(item.sequence_no), mimeType: String(item.mime_type),
            sizeBytes: Number(item.size_bytes), width: Number(item.width), height: Number(item.height), sha256: String(item.sha256),
          })),
        };
        const quoteSnapshot = {
          id: String(quote.id), shopId: String(quote.shop_id), totalPriceFen: Number(quote.total_price_fen),
          note: String(quote.note), revision: Number(quote.revision), updatedAt: String(quote.updated_at),
        };
        await tx.prepare(`
          INSERT INTO repair_orders (
            id, order_no, request_id, quote_id, user_id, shop_id, status, total_price_fen,
            request_snapshot_json, quote_snapshot_json, shop_snapshot_json,
            owner_contact_snapshot_json, created_at, paid_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?::timestamptz, NULL)
        `).run(
          orderId, orderNumber(new Date(createdAt)), request.params.id, body.quoteId, userId,
          String(quote.shop_id), Number(quote.total_price_fen), JSON.stringify(requestSnapshot),
          JSON.stringify(quoteSnapshot), JSON.stringify(shopPrivateDto(quote)),
          JSON.stringify(jsonObject(repairRequest.synthetic_owner_contact_json)), createdAt,
        );
        await tx.prepare(`
          UPDATE repair_requests SET status = 'pending_payment', selected_quote_id = ?, updated_at = ?::timestamptz
          WHERE id = ?
        `).run(body.quoteId, createdAt, request.params.id);
        order = await tx.prepare<Row>("SELECT * FROM repair_orders WHERE id = ?").get(orderId);
      }
      const paymentId = randomUUID();
      const listedFen = Number(order!.total_price_fen);
      const channelFen = scaleWechatChargeAmountFen(listedFen);
      await tx.prepare(`
        INSERT INTO repair_order_payments (
          id, order_id, request_id, quote_id, user_id, provider, kind, idempotency_key,
          amount_fen, channel_amount_fen, status, out_trade_no, transaction_id, created_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, 'wechat', 'charge', ?, ?, NULL, 'pending', ?, NULL, ?::timestamptz, NULL)
      `).run(
        paymentId, String(order!.id), request.params.id, body.quoteId, userId,
        body.idempotencyKey, channelFen, paymentId.replaceAll("-", ""), createdAt,
      );
      const payment = await tx.prepare<Row>("SELECT * FROM repair_order_payments WHERE id = ?").get(paymentId);
      return { payment: payment!, created: true };
    });
    if (String(prepared.payment.status) === "confirmed") {
      return { data: { request: await ownerRequestDetail(database, request.params.id, userId, options.problem), payment: {
        id: String(prepared.payment.id), provider: "wechat", status: "confirmed",
        amountFen: Number(prepared.payment.amount_fen),
      } }, meta: { idempotent: true } };
    }
    let prepayId: string;
    try {
      const prepay = await createJsapiPrepay({
        appId, openid, outTradeNo: String(prepared.payment.out_trade_no),
        description: "驭小满维修服务", amountFen: Number(prepared.payment.amount_fen),
        notifyUrl: payConfig.notifyUrl, attach: `repair:${request.params.id}`,
      });
      prepayId = prepay.prepayId;
    } catch (error) {
      if (prepared.created) {
        await database.prepare("UPDATE repair_order_payments SET status = 'failed' WHERE id = ? AND status = 'pending'")
          .run(String(prepared.payment.id));
      }
      throw options.problem(502, "WECHAT_PREPAY_FAILED", error instanceof Error ? error.message : "微信统一下单失败");
    }
    return reply.status(prepared.created ? 201 : 200).send({
      data: {
        request: await ownerRequestDetail(database, request.params.id, userId, options.problem),
        payment: {
          id: String(prepared.payment.id), provider: "wechat", status: String(prepared.payment.status),
          amountFen: Number(prepared.payment.amount_fen),
          listedAmountFen: Number((await database.prepare<Row>("SELECT total_price_fen FROM repair_orders WHERE id = ?").get(String(prepared.payment.order_id)))?.total_price_fen ?? 0),
          testingAmountDivisor: wechatAmountDivisor(),
        },
        wechatPay: buildMiniProgramPayParams(prepayId, appId),
      },
    });
  });

  app.post<{ Params: { id: string } }>("/api/repair/requests/:id/mock-pay", async (request) => {
    assertMockPaymentEnabled(options.problem);
    const userId = await requireCurrentUser(request, database);
    const body = parseBody(paymentSchema, request.body, options.problem);
    let idempotent = false;
    await database.transaction(async (transaction) => {
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`repair-payment:${userId}:${body.idempotencyKey}`);
      const existingPayment = await transaction.prepare<Row>(`
        SELECT p.*, o.request_id AS paid_request_id, o.quote_id AS paid_quote_id
        FROM repair_mock_payments p
        JOIN repair_orders o ON o.id = p.order_id
        WHERE p.user_id = ? AND p.idempotency_key = ?
      `).get(userId, body.idempotencyKey);
      if (existingPayment) {
        if (
          String(existingPayment.paid_request_id) !== request.params.id
          || String(existingPayment.paid_quote_id) !== body.quoteId
        ) {
          throw options.problem(409, "REPAIR_PAYMENT_IDEMPOTENCY_CONFLICT", "该幂等键已用于其他维修报价");
        }
        idempotent = true;
        return;
      }

      const repairRequest = await transaction.prepare<Row>(`
        SELECT * FROM repair_requests WHERE id = ? AND user_id = ? FOR UPDATE
      `).get(request.params.id, userId);
      if (!repairRequest) throw options.problem(404, "REPAIR_REQUEST_NOT_FOUND", "未找到该维修询价");
      if (String(repairRequest.status) === "paid") {
        const existingOrder = await transaction.prepare<Row>(`
          SELECT quote_id FROM repair_orders WHERE request_id = ?
        `).get(request.params.id);
        if (String(existingOrder?.quote_id ?? "") !== body.quoteId) {
          throw options.problem(409, "REPAIR_REQUEST_ALREADY_PAID", "该维修询价已经选择了其他报价");
        }
        idempotent = true;
        return;
      }
      if (String(repairRequest.status) !== "open") {
        throw options.problem(409, "REPAIR_REQUEST_NOT_PAYABLE", "当前维修询价状态不能支付");
      }
      const quote = await transaction.prepare<Row>(`
        SELECT q.*,
          s.name AS shop_name, s.district AS shop_district, s.address AS shop_address,
          s.distance_km AS shop_distance_km, s.rating AS shop_rating,
          s.contact_name AS shop_contact_name, s.contact_phone AS shop_contact_phone,
          s.open_hours AS shop_open_hours, s.is_demo AS shop_is_demo
        FROM repair_quotes q
        JOIN repair_shops s ON s.id = q.shop_id AND s.is_active = 1
        WHERE q.id = ? AND q.request_id = ?
        FOR UPDATE OF q, s
      `).get(body.quoteId, request.params.id);
      if (!quote) throw options.problem(404, "REPAIR_QUOTE_NOT_FOUND", "未找到该维修报价");
      if (String(quote.status) !== "active") {
        throw options.problem(409, "REPAIR_QUOTE_NOT_ACTIVE", "该维修报价已撤回或失效，请选择其他报价");
      }

      const faults = await transaction.prepare<Row>(
        "SELECT * FROM repair_request_faults WHERE request_id = ? ORDER BY sequence_no, id",
      ).all(request.params.id);
      const media = await transaction.prepare<Row>(
        "SELECT * FROM repair_request_media WHERE request_id = ? ORDER BY kind, sequence_no NULLS FIRST, id",
      ).all(request.params.id);
      const paidAt = now().toISOString();
      const orderId = randomUUID();
      const requestSnapshot = {
        id: request.params.id,
        requestNo: String(repairRequest.request_no),
        vehicle: jsonObject(repairRequest.vehicle_snapshot_json),
        report: jsonObject(repairRequest.report_snapshot_json),
        faults: faults.map((fault) => ({
          id: String(fault.id), sourceFaultId: String(fault.source_fault_id ?? fault.precheck_reason_code ?? ""),
          sequence: Number(fault.sequence_no), viewId: String(fault.view_id),
          regionCode: String(fault.region_code), faultType: String(fault.fault_type),
          severity: String(fault.severity),
          description: fault.description == null ? null : String(fault.description),
        })),
        media: media.map((item) => ({
          id: String(item.id), sourceMediaId: String(item.source_media_id ?? item.precheck_media_id ?? ""),
          faultId: item.fault_id == null ? null : String(item.fault_id),
          kind: String(item.kind), sequence: item.sequence_no == null ? null : Number(item.sequence_no),
          mimeType: String(item.mime_type), sizeBytes: Number(item.size_bytes),
          width: Number(item.width), height: Number(item.height), sha256: String(item.sha256),
        })),
      };
      const quoteSnapshot = {
        id: String(quote.id),
        shopId: String(quote.shop_id),
        totalPriceFen: Number(quote.total_price_fen),
        note: String(quote.note),
        revision: Number(quote.revision),
        updatedAt: String(quote.updated_at),
      };
      const shopSnapshot = shopPrivateDto(quote);
      const contactSnapshot = jsonObject(repairRequest.synthetic_owner_contact_json);
      await transaction.prepare(`
        INSERT INTO repair_orders (
          id, order_no, request_id, quote_id, user_id, shop_id, status,
          total_price_fen, request_snapshot_json, quote_snapshot_json,
          shop_snapshot_json, owner_contact_snapshot_json, created_at, paid_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        orderNumber(new Date(paidAt)),
        request.params.id,
        body.quoteId,
        userId,
        String(quote.shop_id),
        Number(quote.total_price_fen),
        JSON.stringify(requestSnapshot),
        JSON.stringify(quoteSnapshot),
        JSON.stringify(shopSnapshot),
        JSON.stringify(contactSnapshot),
        paidAt,
        paidAt,
      );
      await transaction.prepare(`
        INSERT INTO repair_mock_payments (
          id, order_id, request_id, quote_id, user_id, provider,
          idempotency_key, amount_fen, status, created_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, 'mock', ?, ?, 'confirmed', ?, ?)
      `).run(
        randomUUID(), orderId, request.params.id, body.quoteId, userId,
        body.idempotencyKey, Number(quote.total_price_fen), paidAt, paidAt,
      );
      await transaction.prepare(`
        UPDATE repair_quotes SET
          status = CASE WHEN id = ? THEN 'selected' ELSE 'lost' END,
          selected_at = CASE WHEN id = ? THEN ? ELSE NULL END,
          updated_at = ?
        WHERE request_id = ?
      `).run(body.quoteId, body.quoteId, paidAt, paidAt, request.params.id);
      await transaction.prepare(`
        UPDATE repair_requests SET
          status = 'paid', selected_quote_id = ?, paid_at = ?, updated_at = ?
        WHERE id = ?
      `).run(body.quoteId, paidAt, paidAt, request.params.id);
      await syncRepairWorkflowForRequest(transaction, request.params.id, {
        now: new Date(paidAt),
        actorType: "owner",
        actorId: userId,
      });
    });
    return {
      data: await ownerRequestDetail(database, request.params.id, userId, options.problem),
      meta: { idempotent, paymentProvider: "mock", realMoneyMovement: false },
    };
  });

  app.post<{ Params: { id: string } }>("/api/admin/finance/repair-orders/:id/refund", async (request) => {
    const principal = assertCapability(backofficeForRequest(request), "finance.statements.manage");
    if (principal.account.role !== "platform_admin") {
      throw options.problem(403, "BACKOFFICE_FORBIDDEN", "仅平台管理员可以发起维修退款");
    }
    const body = parseBody(z.object({
      idempotencyKey: z.string().trim().min(8).max(160),
      reason: z.string().trim().min(2).max(300),
    }).strict(), request.body, options.problem);
    const prepared = await database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")
        .get(`repair-refund:${request.params.id}`);
      const existing = await tx.prepare<Row>(`
        SELECT * FROM repair_order_payments WHERE provider = 'wechat' AND idempotency_key = ?
      `).get(body.idempotencyKey);
      if (existing) {
        if (String(existing.order_id) !== request.params.id || String(existing.kind) !== "refund") {
          throw options.problem(409, "REPAIR_REFUND_IDEMPOTENCY_CONFLICT", "退款幂等键已用于其他订单");
        }
        if (String(existing.status) === "confirmed") {
          const completedOrder = await tx.prepare<Row>("SELECT * FROM repair_orders WHERE id = ?").get(request.params.id);
          return { alreadyConfirmed: true, refundId: String(existing.id), order: completedOrder!, channelFen: Number(existing.channel_amount_fen ?? existing.amount_fen), charge: null };
        }
        if (String(existing.status) === "pending") {
          // Recover safely after a process interruption. The WeChat refund
          // request uses a deterministic out_refund_no, so replay is idempotent.
          const pendingOrder = await tx.prepare<Row>(`
            SELECT o.*, p.id AS charge_id, p.amount_fen AS charge_amount_fen,
              p.channel_amount_fen, p.out_trade_no, p.transaction_id
            FROM repair_orders o JOIN repair_order_payments p
              ON p.order_id = o.id AND p.kind = 'charge' AND p.status = 'confirmed'
            WHERE o.id = ?
          `).get(request.params.id);
          if (!pendingOrder) throw options.problem(409, "REPAIR_REFUND_STATE_INVALID", "退款关联的支付记录异常");
          return {
            alreadyConfirmed: false,
            refundId: String(existing.id),
            order: pendingOrder,
            channelFen: Number(existing.channel_amount_fen ?? existing.amount_fen),
            charge: pendingOrder,
          };
        }
        throw options.problem(409, "REPAIR_REFUND_RETRY_KEY_REQUIRED", "上次退款未完成，请使用新的幂等键重试");
      }
      const order = await tx.prepare<Row>(`
        SELECT o.*, p.id AS charge_id, p.amount_fen AS charge_amount_fen,
          p.channel_amount_fen, p.out_trade_no, p.transaction_id
        FROM repair_orders o JOIN repair_order_payments p
          ON p.order_id = o.id AND p.kind = 'charge' AND p.status = 'confirmed'
        WHERE o.id = ? FOR UPDATE OF o, p
      `).get(request.params.id);
      if (!order) throw options.problem(404, "REPAIR_ORDER_NOT_FOUND", "未找到真实支付的维修订单");
      if (String(order.status) !== "paid") throw options.problem(409, "REPAIR_ORDER_NOT_REFUNDABLE", "当前维修订单不能退款");
      const liveRefund = await tx.prepare<Row>(`
        SELECT id FROM repair_order_payments WHERE order_id = ? AND kind = 'refund' AND status IN ('pending', 'confirmed')
      `).get(request.params.id);
      if (liveRefund) throw options.problem(409, "REPAIR_REFUND_ALREADY_EXISTS", "该维修订单已有退款记录");
      const channelFen = Number(order.channel_amount_fen ?? order.charge_amount_fen);
      if (channelFen <= 0) throw options.problem(409, "REPAIR_REFUND_AMOUNT_INVALID", "支付渠道金额异常，不能退款");
      const refundId = randomUUID();
      await tx.prepare(`
        INSERT INTO repair_order_payments (
          id, order_id, request_id, quote_id, user_id, provider, kind, idempotency_key,
          amount_fen, channel_amount_fen, status, out_trade_no, transaction_id, created_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, 'wechat', 'refund', ?, ?, ?, 'pending', NULL, NULL, ?::timestamptz, NULL)
      `).run(
        refundId, request.params.id, String(order.request_id), String(order.quote_id),
        String(order.user_id), body.idempotencyKey, Number(order.total_price_fen), channelFen,
        now().toISOString(),
      );
      return { alreadyConfirmed: false, refundId, order, channelFen, charge: order };
    });
    if (prepared.alreadyConfirmed) {
      return { data: await ownerRequestDetail(database, String(prepared.order.request_id), String(prepared.order.user_id), options.problem), meta: { idempotent: true } };
    }
    try {
      await createDomesticRefund({
        outTradeNo: prepared.charge!.out_trade_no == null ? undefined : String(prepared.charge!.out_trade_no),
        transactionId: prepared.charge!.transaction_id == null ? undefined : String(prepared.charge!.transaction_id),
        outRefundNo: `rr${String(prepared.charge!.charge_id).replaceAll("-", "")}`.slice(0, 64),
        reason: body.reason,
        refundFen: prepared.channelFen,
        totalFen: prepared.channelFen,
      });
    } catch (error) {
      await database.prepare("UPDATE repair_order_payments SET status = 'failed' WHERE id = ? AND status = 'pending'")
        .run(prepared.refundId);
      throw options.problem(502, "WECHAT_REFUND_FAILED", error instanceof Error ? error.message : "微信退款失败");
    }
    const refundedAt = now().toISOString();
    await database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")
        .get(`repair-refund:${request.params.id}`);
      const locked = await tx.prepare<Row>("SELECT * FROM repair_orders WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!locked) throw options.problem(404, "REPAIR_ORDER_NOT_FOUND", "未找到维修订单");
      const refund = await tx.prepare<Row>("SELECT * FROM repair_order_payments WHERE id = ? FOR UPDATE").get(prepared.refundId);
      if (!refund) throw options.problem(409, "REPAIR_REFUND_STATE_INVALID", "退款记录状态异常");
      if (String(refund.status) === "confirmed") return;
      if (String(refund.status) !== "pending") throw options.problem(409, "REPAIR_REFUND_STATE_INVALID", "退款记录状态异常");
      await tx.prepare("UPDATE repair_order_payments SET status = 'confirmed', confirmed_at = ?::timestamptz WHERE id = ?")
        .run(refundedAt, prepared.refundId);
      await tx.prepare("UPDATE repair_orders SET status = 'refunded', refunded_at = ?::timestamptz WHERE id = ?")
        .run(refundedAt, request.params.id);
      await tx.prepare("UPDATE repair_requests SET status = 'refunded', updated_at = ?::timestamptz WHERE id = ?")
        .run(refundedAt, String(locked.request_id));
      await syncRepairWorkflowForRequest(tx, String(locked.request_id), {
        now: new Date(refundedAt), actorType: "platform", actorId: principal.account.id,
      });
      await auditBackofficeEvent(tx, {
        request, action: "repair.payment.refund", outcome: "success",
        resource: { type: "repair_order", id: request.params.id },
        presentation: { category: "finance", actionLabel: "维修订单全额退款", summary: `${locked.order_no} · ${body.reason}` },
      });
    });
    return { data: await ownerRequestDetail(database, String(prepared.order.request_id), String(prepared.order.user_id), options.problem), meta: { idempotent: false } };
  });

  app.get<{ Params: { id: string; mediaId: string } }>(
    "/api/repair/requests/:id/media/:mediaId",
    async (request, reply) => {
      const userId = await requireCurrentUser(request, database);
      const row = await database.prepare<Row>(`
        SELECT m.*
        FROM repair_request_media m
        JOIN repair_requests r ON r.id = m.request_id
        WHERE m.id = ? AND m.request_id = ? AND r.user_id = ?
      `).get(request.params.mediaId, request.params.id, userId);
      if (!row) throw options.problem(404, "REPAIR_MEDIA_NOT_FOUND", "维修需求照片不存在或不可查看");
      reply.type(String(row.mime_type)).header("Cache-Control", "private, max-age=3600");
      return reply.send(createReadStream(join(checkupUploadDir, String(row.storage_key))));
    },
  );

  app.get("/api/repair-operator/requests", async (request) => {
    const { shopId } = await requireRepairOperator(
      request,
      database,
      options.problem,
      ["repair.requests.read", "repair.quotes.read"],
    );
    const rows = await database.prepare<Row>(`
      SELECT r.*,
        q.id AS own_quote_id, q.status AS own_quote_status,
        q.total_price_fen AS own_quote_total_price_fen,
        q.note AS own_quote_note, q.revision AS own_quote_revision,
        (SELECT COUNT(*)::INTEGER FROM repair_quotes q2
          WHERE q2.request_id = r.id AND q2.status = 'active') AS active_quote_count,
        (SELECT COUNT(*)::INTEGER FROM repair_request_faults f
          WHERE f.request_id = r.id) AS fault_count,
        (SELECT f.region_code FROM repair_request_faults f
          WHERE f.request_id = r.id ORDER BY f.sequence_no, f.id LIMIT 1) AS primary_fault_region_code,
        (SELECT f.fault_type FROM repair_request_faults f
          WHERE f.request_id = r.id ORDER BY f.sequence_no, f.id LIMIT 1) AS primary_fault_type,
        (SELECT f.severity FROM repair_request_faults f
          WHERE f.request_id = r.id ORDER BY f.sequence_no, f.id LIMIT 1) AS primary_fault_severity
      FROM repair_requests r
      LEFT JOIN repair_quotes q ON q.request_id = r.id AND q.shop_id = ?
      WHERE r.status = 'open'
        OR EXISTS (
          SELECT 1 FROM repair_orders o
          WHERE o.request_id = r.id AND o.shop_id = ?
        )
      ORDER BY r.created_at DESC, r.id DESC
    `).all(shopId, shopId);
    return { data: rows.map(operatorListItem) };
  });

  app.get<{ Params: { requestId: string } }>(
    "/api/repair-operator/requests/:requestId",
    async (request) => {
      const { principal, shopId } = await requireRepairOperator(
        request,
        database,
        options.problem,
        ["repair.requests.read", "repair.quotes.read", "repair.authorized_details.read"],
      );
      return {
        data: await shopRequestDetail(
          database,
          request.params.requestId,
          shopId,
          options.problem,
          request,
          principal,
        ),
      };
    },
  );

  app.put<{ Params: { requestId: string } }>(
    "/api/repair-operator/requests/:requestId/quote",
    async (request) => {
      const { principal, shopId } = await requireRepairOperator(
        request,
        database,
        options.problem,
        ["repair.requests.read", "repair.quotes.read", "repair.quotes.write"],
      );
      const body = parseBody(quoteSchema, request.body, options.problem);
      await database.transaction(async (transaction) => {
        const lockedShop = await lockAndRevalidateRepairOperator(
          transaction,
          principal,
          shopId,
          options.problem,
        );
        const repairRequest = await transaction.prepare<Row>(`
          SELECT * FROM repair_requests WHERE id = ? FOR UPDATE
        `).get(request.params.requestId);
        if (!repairRequest || String(repairRequest.status) !== "open") {
          throw options.problem(404, "REPAIR_REQUEST_NOT_OPEN", "该维修需求不存在或已停止接收报价");
        }
        const current = await transaction.prepare<Row>(`
          SELECT * FROM repair_quotes WHERE request_id = ? AND shop_id = ? FOR UPDATE
        `).get(request.params.requestId, shopId);
        if (
          current
          && String(current.status) === "active"
          && Number(current.total_price_fen) === body.totalPriceFen
          && String(current.note) === body.note
        ) return;

        const updatedAt = now().toISOString();
        const requestNo = String(repairRequest.request_no);
        if (current) {
          if (["selected", "lost"].includes(String(current.status))) {
            throw options.problem(409, "REPAIR_QUOTE_FINAL", "该报价已进入最终状态，不能修改");
          }
          await transaction.prepare(`
            UPDATE repair_quotes SET
              total_price_fen = ?, note = ?, status = 'active',
              revision = revision + 1, updated_at = ?, withdrawn_at = NULL
            WHERE id = ?
          `).run(body.totalPriceFen, body.note, updatedAt, String(current.id));
          const changes = [
            ...(Number(current.total_price_fen) === body.totalPriceFen ? [] : [{
              field: "totalPriceFen",
              label: "报价金额",
              before: Number(current.total_price_fen),
              after: body.totalPriceFen,
            }]),
            ...(String(current.note) === body.note ? [] : [{
              field: "scopeSummary",
              label: "维修范围说明",
              before: "已填写",
              after: "已修改",
            }]),
            ...(String(current.status) === "withdrawn" ? [{
              field: "status",
              label: "报价状态",
              before: "已撤回",
              after: "报价中",
            }] : []),
          ];
          await auditBackofficeEvent(transaction, {
            request,
            principal,
            action: "repair.quote.update",
            outcome: "success",
            resource: { type: "repair_request", id: request.params.requestId },
            before: {
              totalPriceFen: Number(current.total_price_fen),
              status: String(current.status),
              revision: Number(current.revision),
            },
            after: {
              totalPriceFen: body.totalPriceFen,
              status: "active",
              revision: Number(current.revision) + 1,
            },
            presentation: {
              category: "repair",
              actionLabel: "修改维修报价",
              summary: `修改维修需求 ${requestNo} 的报价，现为 ${quoteAmountLabel(body.totalPriceFen)}`,
              subjectName: String(lockedShop.name),
              resourceLabel: `维修需求 ${requestNo}`,
              changes,
            },
            occurredAt: updatedAt,
          });
        } else {
          const quoteId = randomUUID();
          await transaction.prepare(`
            INSERT INTO repair_quotes (
              id, request_id, shop_id, total_price_fen, note, status,
              revision, created_at, updated_at, withdrawn_at, selected_at
            ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL, NULL)
          `).run(
            quoteId,
            request.params.requestId,
            shopId,
            body.totalPriceFen,
            body.note,
            updatedAt,
            updatedAt,
          );
          await auditBackofficeEvent(transaction, {
            request,
            principal,
            action: "repair.quote.create",
            outcome: "success",
            resource: { type: "repair_request", id: request.params.requestId },
            after: { totalPriceFen: body.totalPriceFen, status: "active", revision: 1 },
            presentation: {
              category: "repair",
              actionLabel: "提交维修报价",
              summary: `为维修需求 ${requestNo} 提交报价 ${quoteAmountLabel(body.totalPriceFen)}`,
              subjectName: String(lockedShop.name),
              resourceLabel: `维修需求 ${requestNo}`,
              changes: [{
                field: "totalPriceFen",
                label: "报价金额",
                before: null,
                after: body.totalPriceFen,
              }],
            },
            occurredAt: updatedAt,
          });
        }
        await syncRepairWorkflowForRequest(transaction, request.params.requestId, {
          now: new Date(updatedAt),
          actorType: "repair_shop",
          actorId: principal.account.id,
        });
      });
      return {
        data: await shopRequestDetail(
          database,
          request.params.requestId,
          shopId,
          options.problem,
          request,
          principal,
        ),
      };
    },
  );

  app.delete<{ Params: { requestId: string } }>(
    "/api/repair-operator/requests/:requestId/quote",
    async (request) => {
      const { principal, shopId } = await requireRepairOperator(
        request,
        database,
        options.problem,
        ["repair.requests.read", "repair.quotes.read", "repair.quotes.write"],
      );
      await database.transaction(async (transaction) => {
        const lockedShop = await lockAndRevalidateRepairOperator(
          transaction,
          principal,
          shopId,
          options.problem,
        );
        const repairRequest = await transaction.prepare<Row>(`
          SELECT * FROM repair_requests WHERE id = ? FOR UPDATE
        `).get(request.params.requestId);
        if (!repairRequest || String(repairRequest.status) !== "open") {
          throw options.problem(404, "REPAIR_REQUEST_NOT_OPEN", "该维修需求不存在或已停止接收报价");
        }
        const quote = await transaction.prepare<Row>(`
          SELECT * FROM repair_quotes WHERE request_id = ? AND shop_id = ? FOR UPDATE
        `).get(request.params.requestId, shopId);
        if (!quote) throw options.problem(404, "REPAIR_QUOTE_NOT_FOUND", "该门店尚未提交报价");
        if (String(quote.status) === "withdrawn") return;
        if (String(quote.status) !== "active") {
          throw options.problem(409, "REPAIR_QUOTE_FINAL", "该报价已进入最终状态，不能撤回");
        }
        const withdrawnAt = now().toISOString();
        await transaction.prepare(`
          UPDATE repair_quotes
          SET status = 'withdrawn', withdrawn_at = ?, updated_at = ?
          WHERE id = ?
        `).run(withdrawnAt, withdrawnAt, String(quote.id));
        const requestNo = String(repairRequest.request_no);
        await auditBackofficeEvent(transaction, {
          request,
          principal,
          action: "repair.quote.delete",
          outcome: "success",
          resource: { type: "repair_request", id: request.params.requestId },
          before: {
            totalPriceFen: Number(quote.total_price_fen),
            status: "active",
            revision: Number(quote.revision),
          },
          after: {
            totalPriceFen: Number(quote.total_price_fen),
            status: "withdrawn",
            revision: Number(quote.revision),
          },
          presentation: {
            category: "repair",
            actionLabel: "撤回维修报价",
            summary: `撤回维修需求 ${requestNo} 的报价`,
            subjectName: String(lockedShop.name),
            resourceLabel: `维修需求 ${requestNo}`,
            changes: [{
              field: "status",
              label: "报价状态",
              before: "报价中",
              after: "已撤回",
            }],
          },
          occurredAt: withdrawnAt,
        });
        await syncRepairWorkflowForRequest(transaction, request.params.requestId, {
          now: new Date(withdrawnAt),
          actorType: "repair_shop",
          actorId: principal.account.id,
        });
      });
      return {
        data: await shopRequestDetail(
          database,
          request.params.requestId,
          shopId,
          options.problem,
          request,
          principal,
        ),
      };
    },
  );

  app.get<{ Params: { requestId: string; mediaId: string } }>(
    "/api/repair-operator/requests/:requestId/media/:mediaId",
    async (request, reply: FastifyReply) => {
      const { principal, shopId } = await requireRepairOperator(
        request,
        database,
        options.problem,
        ["repair.requests.read", "repair.authorized_details.read"],
      );
      await assertShopCanReadRequest(
        database,
        request.params.requestId,
        shopId,
        options.problem,
        request,
        principal,
      );
      const row = await database.prepare<Row>(`
        SELECT * FROM repair_request_media WHERE id = ? AND request_id = ?
      `).get(request.params.mediaId, request.params.requestId);
      if (!row) throw options.problem(404, "REPAIR_MEDIA_NOT_FOUND", "维修需求照片不存在或不可查看");
      reply.type(String(row.mime_type)).header("Cache-Control", "private, max-age=3600");
      return reply.send(createReadStream(join(checkupUploadDir, String(row.storage_key))));
    },
  );

  const removedDemoRoute = () => {
    throw options.problem(
      404,
      "REPAIR_DEMO_ROUTE_REMOVED",
      "维修门店演示切换入口已停用，请使用维修门店账号登录",
    );
  };
  app.all("/api/demo/repair-shops", removedDemoRoute);
  app.all("/api/demo/repair-shops/*", removedDemoRoute);
}
