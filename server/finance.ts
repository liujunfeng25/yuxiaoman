import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { z } from "zod";
import {
  assertCapability,
  auditBackofficeEvent,
  backofficeForRequest,
  type BackofficeCapability,
  type BackofficeSession,
} from "./backoffice.js";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;
type ProblemFactory = (statusCode: number, code: string, message: string, fields?: Record<string, string>) => Error;

export type FinanceRouteOptions = {
  problem: ProblemFactory;
  uploadDir: string;
  now?: () => Date;
  /** Shanghai wall-clock hour for the once-daily close (default 2). */
  dailyCloseHourShanghai?: number;
  /** Disable the in-process daily-close scheduler (tests). */
  disableDailyCloseScheduler?: boolean;
};

const BUSINESS_TYPES = ["annual_inspection", "car_wash", "repair", "valet"] as const;
const COUNTERPARTY_TYPES = ["inspection_station", "wash_store", "repair_shop", "valet_company"] as const;
type BusinessType = typeof BUSINESS_TYPES[number];
type CounterpartyType = typeof COUNTERPARTY_TYPES[number];

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function shanghaiDate(value: Date): string {
  const parts = shanghaiDateFormatter.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shanghaiDateParts(value: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dateParts = shanghaiDateFormatter.formatToParts(value);
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? "0");
  return {
    year: part(dateParts, "year"),
    month: part(dateParts, "month"),
    day: part(dateParts, "day"),
    hour: part(timeParts, "hour"),
    minute: part(timeParts, "minute"),
    second: part(timeParts, "second"),
  };
}

/** Previous calendar day in Asia/Shanghai (not raw UTC-24h). */
export function previousShanghaiDate(value: Date): string {
  const parts = shanghaiDateParts(value);
  const previous = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}-${String(previous.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Milliseconds until the next Asia/Shanghai `closeHour`:00:00.
 * If `now` is exactly that instant, returns 0 so the scheduler can fire immediately.
 */
export function msUntilNextShanghaiDailyClose(now: Date, closeHour = 2): number {
  const parts = shanghaiDateParts(now);
  let { year, month, day } = parts;
  const alreadyPassed =
    parts.hour > closeHour
    || (parts.hour === closeHour && (parts.minute > 0 || parts.second > 0));
  if (alreadyPassed) {
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  const target = Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(closeHour).padStart(2, "0")}:00:00+08:00`,
  );
  return Math.max(target - now.getTime(), 0);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function safeDate(value: unknown, fallback: Date): Date {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function isoTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : safeDate(value, new Date(0)).toISOString();
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value ?? "");
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] ?? safeDate(value, new Date(0)).toISOString().slice(0, 10);
}

async function financeSettings(database: AppDatabase): Promise<Row> {
  return (await database.prepare<Row>("SELECT * FROM finance_settings WHERE id = 1").get()) ?? {
    id: 1,
    enabled: false,
    cutover_at: null,
    default_valet_company_id: null,
  };
}

async function ruleFor(database: AppDatabase, businessType: BusinessType, eligibleDate: string): Promise<Row | undefined> {
  return database.prepare<Row>(`
    SELECT * FROM finance_rule_versions
    WHERE business_type = ? AND status IN ('active', 'retired') AND effective_from <= ?::date
    ORDER BY effective_from DESC, version DESC LIMIT 1
  `).get(businessType, eligibleDate);
}

function ruleSnapshot(rule: Row): Record<string, unknown> {
  return {
    id: String(rule.id),
    businessType: String(rule.business_type),
    ruleKind: String(rule.rule_kind),
    calculationMode: String(rule.calculation_mode),
    rateBps: rule.rate_bps == null ? null : Number(rule.rate_bps),
    fixedFen: rule.fixed_fen == null ? null : Number(rule.fixed_fen),
    baseFeeFen: rule.base_fee_fen == null ? null : Number(rule.base_fee_fen),
    includedKm: rule.included_km == null ? null : Number(rule.included_km),
    perKmFen: rule.per_km_fen == null ? null : Number(rule.per_km_fen),
    effectiveFrom: isoDate(rule.effective_from),
    version: Number(rule.version),
  };
}

export function calculateCommissionFen(grossFen: number, rule: { calculation_mode?: unknown; rate_bps?: unknown; fixed_fen?: unknown }): number {
  if (grossFen <= 0) return 0;
  const amount = String(rule.calculation_mode) === "fixed"
    ? numberValue(rule.fixed_fen)
    : Math.round(grossFen * numberValue(rule.rate_bps) / 10_000);
  return Math.max(0, Math.min(grossFen, amount));
}

export function calculateValetCostFen(distanceKm: number, rule: { base_fee_fen?: unknown; included_km?: unknown; per_km_fen?: unknown }): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) throw new Error("VALID_DISTANCE_REQUIRED");
  const extraKm = Math.ceil(Math.max(0, distanceKm - numberValue(rule.included_km) - 1e-9));
  return numberValue(rule.base_fee_fen) + extraKm * numberValue(rule.per_km_fen);
}

async function insertPaymentProjection(database: AppDatabase, cutoverAt: string): Promise<void> {
  const statements = [`
    INSERT INTO finance_payment_transactions (
      id, source_payment_type, source_payment_id, source_order_type, source_order_id,
      order_number, transaction_kind, provider, listed_amount_fen, channel_amount_fen,
      transaction_id, out_trade_no, status, is_real, occurred_at, created_at
    )
    SELECT 'annual-charge-' || p.id, 'booking_payment', p.id, 'annual_inspection', b.id,
      b.booking_number, 'charge', p.provider, p.amount_fen,
      COALESCE(p.channel_amount_fen, p.amount_fen), p.transaction_id, p.out_trade_no,
      CASE WHEN p.status = 'confirmed' THEN 'confirmed' WHEN p.status = 'failed' THEN 'failed' ELSE 'pending' END,
      p.provider = 'wechat' AND p.status = 'confirmed',
      COALESCE(p.confirmed_at, p.created_at)::timestamptz, now()
    FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
    WHERE b.created_at::timestamptz >= ?::timestamptz
    ON CONFLICT (source_payment_type, source_payment_id, transaction_kind) DO UPDATE SET
      provider = excluded.provider, listed_amount_fen = excluded.listed_amount_fen,
      channel_amount_fen = excluded.channel_amount_fen, transaction_id = excluded.transaction_id,
      out_trade_no = excluded.out_trade_no, status = excluded.status,
      is_real = excluded.is_real, occurred_at = excluded.occurred_at
  `, `
    INSERT INTO finance_payment_transactions (
      id, source_payment_type, source_payment_id, source_order_type, source_order_id,
      order_number, transaction_kind, provider, listed_amount_fen, channel_amount_fen,
      transaction_id, out_trade_no, status, is_real, occurred_at, created_at
    )
    SELECT 'annual-refund-' || l.id, 'booking_ledger', l.id, 'annual_inspection', b.id,
      b.booking_number, 'refund',
      CASE WHEN EXISTS (SELECT 1 FROM booking_payments p WHERE p.booking_id = b.id AND p.provider = 'wechat' AND p.status = 'confirmed') THEN 'wechat' ELSE 'mock' END,
      abs(l.amount_fen), abs(l.amount_fen), NULL, NULL, 'confirmed',
      EXISTS (SELECT 1 FROM booking_payments p WHERE p.booking_id = b.id AND p.provider = 'wechat' AND p.status = 'confirmed'),
      COALESCE(l.confirmed_at, l.created_at)::timestamptz, now()
    FROM booking_ledger_entries l JOIN bookings b ON b.id = l.booking_id
    WHERE l.kind = 'refund' AND l.confirmation_status = 'confirmed'
      AND b.created_at::timestamptz >= ?::timestamptz
    ON CONFLICT (source_payment_type, source_payment_id, transaction_kind) DO UPDATE SET
      provider = excluded.provider, listed_amount_fen = excluded.listed_amount_fen,
      channel_amount_fen = excluded.channel_amount_fen, transaction_id = excluded.transaction_id,
      out_trade_no = excluded.out_trade_no, status = excluded.status,
      is_real = excluded.is_real, occurred_at = excluded.occurred_at
  `, `
    INSERT INTO finance_payment_transactions (
      id, source_payment_type, source_payment_id, source_order_type, source_order_id,
      order_number, transaction_kind, provider, listed_amount_fen, channel_amount_fen,
      transaction_id, out_trade_no, status, is_real, occurred_at, created_at
    )
    SELECT 'wash-' || p.kind || '-' || p.id, 'wash_order_payment', p.id, 'car_wash', o.id,
      o.order_number, p.kind, p.provider,
      CASE WHEN p.kind = 'charge' THEN o.total_fee_fen ELSE p.amount_fen END,
      COALESCE(p.channel_amount_fen, p.amount_fen), p.transaction_id, p.out_trade_no,
      CASE WHEN p.status = 'confirmed' THEN 'confirmed' WHEN p.status = 'failed' THEN 'failed' ELSE 'pending' END,
      p.provider = 'wechat' AND p.status = 'confirmed',
      COALESCE(p.confirmed_at, p.created_at)::timestamptz, now()
    FROM wash_order_payments p JOIN wash_orders o ON o.id = p.order_id
    WHERE o.created_at::timestamptz >= ?::timestamptz
    ON CONFLICT (source_payment_type, source_payment_id, transaction_kind) DO UPDATE SET
      provider = excluded.provider, listed_amount_fen = excluded.listed_amount_fen,
      channel_amount_fen = excluded.channel_amount_fen, transaction_id = excluded.transaction_id,
      out_trade_no = excluded.out_trade_no, status = excluded.status,
      is_real = excluded.is_real, occurred_at = excluded.occurred_at
  `, `
    INSERT INTO finance_payment_transactions (
      id, source_payment_type, source_payment_id, source_order_type, source_order_id,
      order_number, transaction_kind, provider, listed_amount_fen, channel_amount_fen,
      transaction_id, out_trade_no, status, is_real, occurred_at, created_at
    )
    SELECT 'repair-' || p.kind || '-' || p.id, 'repair_order_payment', p.id, 'repair', o.id,
      o.order_no, p.kind, p.provider,
      CASE WHEN p.kind = 'charge' THEN o.total_price_fen ELSE p.amount_fen END,
      COALESCE(p.channel_amount_fen, p.amount_fen), p.transaction_id, p.out_trade_no,
      CASE WHEN p.status = 'confirmed' THEN 'confirmed' WHEN p.status = 'failed' THEN 'failed' ELSE 'pending' END,
      p.provider = 'wechat' AND p.status = 'confirmed',
      COALESCE(p.confirmed_at, p.created_at), now()
    FROM repair_order_payments p JOIN repair_orders o ON o.id = p.order_id
    WHERE o.created_at::timestamptz >= ?::timestamptz
    ON CONFLICT (source_payment_type, source_payment_id, transaction_kind) DO UPDATE SET
      provider = excluded.provider, listed_amount_fen = excluded.listed_amount_fen,
      channel_amount_fen = excluded.channel_amount_fen, transaction_id = excluded.transaction_id,
      out_trade_no = excluded.out_trade_no, status = excluded.status,
      is_real = excluded.is_real, occurred_at = excluded.occurred_at
  `];
  for (const statement of statements) await database.prepare(statement).run(cutoverAt);
}

type AccrualInput = {
  sourceOrderType: "annual_inspection" | "car_wash" | "repair";
  sourceOrderId: string;
  orderNumber: string;
  componentType: "inspection_fee" | "wash_fee" | "repair_fee" | "valet_cost";
  counterpartyType: CounterpartyType;
  counterpartyId: string;
  counterpartyName: string;
  customerComponentFen: number;
  grossFen: number;
  commissionFen: number;
  netFen: number;
  distanceKm?: number | null;
  rule: Row;
  eligibleAt: string;
};

async function insertAccrual(database: AppDatabase, input: AccrualInput): Promise<void> {
  const idempotencyKey = `finance-accrual:${input.sourceOrderType}:${input.sourceOrderId}:${input.componentType}`;
  await database.prepare(`
    INSERT INTO finance_accruals (
      id, idempotency_key, source_order_type, source_order_id, order_number,
      component_type, entry_kind, reversal_of_id, counterparty_type, counterparty_id,
      counterparty_name, gross_amount_fen, commission_amount_fen, net_amount_fen,
      customer_component_amount_fen, one_way_distance_km, rule_version_id,
      rule_snapshot_json, status, eligible_at, eligible_date, statement_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'accrual', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb,
      'pending_statement', ?::timestamptz, ?::date, NULL, now())
    ON CONFLICT (idempotency_key) DO NOTHING
  `).run(
    randomUUID(), idempotencyKey, input.sourceOrderType, input.sourceOrderId, input.orderNumber,
    input.componentType, input.counterpartyType, input.counterpartyId, input.counterpartyName,
    input.grossFen, input.commissionFen, input.netFen, input.customerComponentFen,
    input.distanceKm ?? null, String(input.rule.id), JSON.stringify(ruleSnapshot(input.rule)),
    input.eligibleAt, shanghaiDate(new Date(input.eligibleAt)),
  );
}

async function syncAnnualAccruals(database: AppDatabase, settings: Row, now: Date): Promise<void> {
  const cutoverAt = isoTimestamp(settings.cutover_at);
  const rows = await database.prepare<Row>(`
    SELECT b.*, s.name AS station_name, s.data_kind AS station_data_kind,
      COALESCE((SELECT SUM(p.amount_fen) FROM booking_payments p
        WHERE p.booking_id = b.id AND p.provider = 'wechat' AND p.status = 'confirmed'), 0) AS real_paid_fen
    FROM bookings b JOIN stations s ON s.id = b.station_id
    WHERE b.created_at::timestamptz >= ?::timestamptz
      AND COALESCE(b.fulfillment_status, b.status) = 'completed'
  `).all(cutoverAt);
  for (const row of rows) {
    if (String(row.station_data_kind ?? "demo") !== "real") continue;
    const orderTotal = numberValue(row.service_fee_fen);
    if (orderTotal <= 0 || numberValue(row.real_paid_fen) !== orderTotal) continue;
    const eligibleAt = safeDate(row.completed_at ?? row.updated_at, now).toISOString();
    const eligibleDate = shanghaiDate(new Date(eligibleAt));
    const commissionRule = await ruleFor(database, "annual_inspection", eligibleDate);
    if (!commissionRule) continue;
    const inspectionFen = numberValue(row.inspection_fee_fen);
    const commissionFen = calculateCommissionFen(inspectionFen, commissionRule);
    await insertAccrual(database, {
      sourceOrderType: "annual_inspection",
      sourceOrderId: String(row.id),
      orderNumber: String(row.booking_number),
      componentType: "inspection_fee",
      counterpartyType: "inspection_station",
      counterpartyId: String(row.station_id),
      counterpartyName: text(row.station_name, "检测站"),
      customerComponentFen: inspectionFen,
      grossFen: inspectionFen,
      commissionFen,
      netFen: inspectionFen - commissionFen,
      rule: commissionRule,
      eligibleAt,
    });
    const valetFen = numberValue(row.valet_fee_fen);
    if (String(row.service_mode) !== "valet" || valetFen <= 0) continue;
    const companyId = text(settings.default_valet_company_id);
    const distanceKm = row.one_way_distance_km == null ? NaN : Number(row.one_way_distance_km);
    if (!companyId || !Number.isFinite(distanceKm)) continue;
    const [company, valetRule] = await Promise.all([
      database.prepare<Row>("SELECT * FROM valet_companies WHERE id = ? AND is_active = TRUE").get(companyId),
      ruleFor(database, "valet", eligibleDate),
    ]);
    if (!company || !valetRule) continue;
    const costFen = calculateValetCostFen(distanceKm, valetRule);
    await insertAccrual(database, {
      sourceOrderType: "annual_inspection",
      sourceOrderId: String(row.id),
      orderNumber: String(row.booking_number),
      componentType: "valet_cost",
      counterpartyType: "valet_company",
      counterpartyId: companyId,
      counterpartyName: String(company.name),
      customerComponentFen: valetFen,
      grossFen: valetFen,
      commissionFen: 0,
      netFen: costFen,
      distanceKm,
      rule: valetRule,
      eligibleAt,
    });
  }
}

async function syncWashAccruals(database: AppDatabase, settings: Row, now: Date): Promise<void> {
  const rows = await database.prepare<Row>(`
    SELECT o.*, s.name AS store_name, s.data_kind AS store_data_kind,
      COALESCE((SELECT SUM(p.amount_fen) FROM wash_order_payments p
        WHERE p.order_id = o.id AND p.provider = 'wechat' AND p.kind = 'charge' AND p.status = 'confirmed'), 0) AS real_paid_fen
    FROM wash_orders o JOIN wash_stores s ON s.id = o.store_id
    WHERE o.created_at::timestamptz >= ?::timestamptz
      AND ((o.service_mode = 'self_drive' AND o.status = 'redeemed')
        OR (o.service_mode = 'valet' AND COALESCE(o.fulfillment_status, '') = 'completed'))
  `).all(isoTimestamp(settings.cutover_at));
  for (const row of rows) {
    if (String(row.store_data_kind ?? "demo") !== "real") continue;
    const orderTotal = numberValue(row.total_fee_fen);
    if (orderTotal <= 0 || numberValue(row.real_paid_fen) !== orderTotal) continue;
    const eligibleAt = safeDate(row.completed_at ?? row.redeemed_at ?? row.updated_at, now).toISOString();
    const eligibleDate = shanghaiDate(new Date(eligibleAt));
    const commissionRule = await ruleFor(database, "car_wash", eligibleDate);
    if (!commissionRule) continue;
    const washFen = numberValue(row.wash_fee_fen);
    const commissionFen = calculateCommissionFen(washFen, commissionRule);
    await insertAccrual(database, {
      sourceOrderType: "car_wash",
      sourceOrderId: String(row.id),
      orderNumber: String(row.order_number),
      componentType: "wash_fee",
      counterpartyType: "wash_store",
      counterpartyId: String(row.store_id),
      counterpartyName: text(row.store_name, "洗车门店"),
      customerComponentFen: washFen,
      grossFen: washFen,
      commissionFen,
      netFen: washFen - commissionFen,
      rule: commissionRule,
      eligibleAt,
    });
    const valetFen = numberValue(row.valet_fee_fen);
    if (String(row.service_mode) !== "valet" || valetFen <= 0) continue;
    const companyId = text(settings.default_valet_company_id);
    const distanceKm = row.one_way_distance_km == null ? NaN : Number(row.one_way_distance_km);
    if (!companyId || !Number.isFinite(distanceKm)) continue;
    const [company, valetRule] = await Promise.all([
      database.prepare<Row>("SELECT * FROM valet_companies WHERE id = ? AND is_active = TRUE").get(companyId),
      ruleFor(database, "valet", eligibleDate),
    ]);
    if (!company || !valetRule) continue;
    const costFen = calculateValetCostFen(distanceKm, valetRule);
    await insertAccrual(database, {
      sourceOrderType: "car_wash",
      sourceOrderId: String(row.id),
      orderNumber: String(row.order_number),
      componentType: "valet_cost",
      counterpartyType: "valet_company",
      counterpartyId: companyId,
      counterpartyName: String(company.name),
      customerComponentFen: valetFen,
      grossFen: valetFen,
      commissionFen: 0,
      netFen: costFen,
      distanceKm,
      rule: valetRule,
      eligibleAt,
    });
  }
}

async function syncRepairAccruals(database: AppDatabase, settings: Row, now: Date): Promise<void> {
  const rows = await database.prepare<Row>(`
    SELECT o.*, s.name AS shop_name, s.is_demo,
      COALESCE((SELECT SUM(p.amount_fen) FROM repair_order_payments p
        WHERE p.order_id = o.id AND p.provider = 'wechat' AND p.kind = 'charge' AND p.status = 'confirmed'), 0) AS real_paid_fen
    FROM repair_orders o JOIN repair_shops s ON s.id = o.shop_id
    WHERE o.created_at::timestamptz >= ?::timestamptz AND o.status = 'paid'
  `).all(isoTimestamp(settings.cutover_at));
  for (const row of rows) {
    if (bool(row.is_demo)) continue;
    const totalFen = numberValue(row.total_price_fen);
    if (totalFen <= 0 || numberValue(row.real_paid_fen) !== totalFen) continue;
    const eligibleAt = safeDate(row.paid_at ?? row.created_at, now).toISOString();
    const rule = await ruleFor(database, "repair", shanghaiDate(new Date(eligibleAt)));
    if (!rule) continue;
    const commissionFen = calculateCommissionFen(totalFen, rule);
    await insertAccrual(database, {
      sourceOrderType: "repair",
      sourceOrderId: String(row.id),
      orderNumber: String(row.order_no),
      componentType: "repair_fee",
      counterpartyType: "repair_shop",
      counterpartyId: String(row.shop_id),
      counterpartyName: text(row.shop_name, "维修门店"),
      customerComponentFen: totalFen,
      grossFen: totalFen,
      commissionFen,
      netFen: totalFen - commissionFen,
      rule,
      eligibleAt,
    });
  }
}

async function refundSummary(database: AppDatabase, orderType: string, orderId: string): Promise<{ amountFen: number; occurredAt: string | null }> {
  if (orderType === "annual_inspection") {
    const row = await database.prepare<Row>(`
      SELECT COALESCE(SUM(abs(amount_fen)), 0) AS amount_fen,
        MAX(COALESCE(confirmed_at, created_at)::timestamptz) AS occurred_at
      FROM booking_ledger_entries WHERE booking_id = ? AND kind = 'refund' AND confirmation_status = 'confirmed'
    `).get(orderId);
    return { amountFen: numberValue(row?.amount_fen), occurredAt: row?.occurred_at ? isoTimestamp(row.occurred_at) : null };
  }
  if (orderType === "car_wash") {
    const row = await database.prepare<Row>(`
      SELECT COALESCE(SUM(amount_fen), 0) AS amount_fen,
        MAX(COALESCE(confirmed_at, created_at)::timestamptz) AS occurred_at
      FROM wash_order_payments WHERE order_id = ? AND kind = 'refund' AND status = 'confirmed'
    `).get(orderId);
    return { amountFen: numberValue(row?.amount_fen), occurredAt: row?.occurred_at ? isoTimestamp(row.occurred_at) : null };
  }
  const row = await database.prepare<Row>(`
    SELECT COALESCE(SUM(amount_fen), 0) AS amount_fen,
      MAX(COALESCE(confirmed_at, created_at)) AS occurred_at
    FROM repair_order_payments WHERE order_id = ? AND kind = 'refund' AND status = 'confirmed'
  `).get(orderId);
  return { amountFen: numberValue(row?.amount_fen), occurredAt: row?.occurred_at ? isoTimestamp(row.occurred_at) : null };
}

async function syncReversals(database: AppDatabase, now: Date): Promise<void> {
  const bases = await database.prepare<Row>(`
    SELECT * FROM finance_accruals WHERE entry_kind = 'accrual'
    ORDER BY source_order_type, source_order_id, component_type
  `).all();
  const groups = new Map<string, Row[]>();
  for (const base of bases) {
    const key = `${base.source_order_type}:${base.source_order_id}`;
    const items = groups.get(key) ?? [];
    items.push(base);
    groups.set(key, items);
  }
  for (const entries of groups.values()) {
    const first = entries[0];
    const refund = await refundSummary(database, String(first.source_order_type), String(first.source_order_id));
    if (refund.amountFen <= 0) continue;
    const orderGross = entries.reduce((sum, item) => sum + numberValue(item.customer_component_amount_fen), 0);
    if (orderGross <= 0) continue;
    const cappedRefund = Math.min(orderGross, refund.amountFen);
    let allocated = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const base = entries[index];
      const componentGross = numberValue(base.customer_component_amount_fen);
      const targetGross = index === entries.length - 1
        ? cappedRefund - allocated
        : Math.min(componentGross, Math.round(cappedRefund * componentGross / orderGross));
      allocated += targetGross;
      const prior = await database.prepare<Row>(`
        SELECT COALESCE(SUM(abs(gross_amount_fen)), 0) AS gross_fen,
          COALESCE(SUM(abs(commission_amount_fen)), 0) AS commission_fen,
          COALESCE(SUM(abs(net_amount_fen)), 0) AS net_fen
        FROM finance_accruals WHERE reversal_of_id = ?
      `).get(String(base.id));
      const priorGross = numberValue(prior?.gross_fen);
      if (targetGross <= priorGross) continue;
      const targetCommission = componentGross > 0
        ? Math.round(numberValue(base.commission_amount_fen) * targetGross / componentGross)
        : 0;
      const targetNet = componentGross > 0
        ? Math.round(numberValue(base.net_amount_fen) * targetGross / componentGross)
        : 0;
      const deltaGross = targetGross - priorGross;
      const deltaCommission = targetCommission - numberValue(prior?.commission_fen);
      const deltaNet = targetNet - numberValue(prior?.net_fen);
      const eligibleAt = safeDate(refund.occurredAt, now).toISOString();
      await database.prepare(`
        INSERT INTO finance_accruals (
          id, idempotency_key, source_order_type, source_order_id, order_number,
          component_type, entry_kind, reversal_of_id, counterparty_type, counterparty_id,
          counterparty_name, gross_amount_fen, commission_amount_fen, net_amount_fen,
          customer_component_amount_fen, one_way_distance_km, rule_version_id,
          rule_snapshot_json, status, eligible_at, eligible_date, statement_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'reversal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb,
          'pending_statement', ?::timestamptz, ?::date, NULL, now())
        ON CONFLICT (idempotency_key) DO NOTHING
      `).run(
        randomUUID(), `finance-reversal:${base.id}:${targetGross}`,
        String(base.source_order_type), String(base.source_order_id), String(base.order_number),
        String(base.component_type), String(base.id), String(base.counterparty_type),
        String(base.counterparty_id), String(base.counterparty_name), -deltaGross,
        -deltaCommission, -deltaNet, -deltaGross,
        typeof base.one_way_distance_km === "number" ? base.one_way_distance_km : null,
        String(base.rule_version_id), JSON.stringify(jsonObject(base.rule_snapshot_json)),
        eligibleAt, shanghaiDate(new Date(eligibleAt)),
      );
    }
  }
}

export async function syncFinanceFacts(database: AppDatabase, now = new Date()): Promise<{ enabled: boolean }> {
  const settings = await financeSettings(database);
  if (!bool(settings.enabled) || !settings.cutover_at) return { enabled: false };
  await insertPaymentProjection(database, isoTimestamp(settings.cutover_at));
  await syncAnnualAccruals(database, settings, now);
  await syncWashAccruals(database, settings, now);
  await syncRepairAccruals(database, settings, now);
  await syncReversals(database, now);
  return { enabled: true };
}

function statementPrefix(type: CounterpartyType): string {
  return ({ inspection_station: "JC", wash_store: "XC", repair_shop: "WX", valet_company: "DJ" })[type];
}

export async function runFinanceDailyClose(database: AppDatabase, statementDate: string, now = new Date()): Promise<number> {
  await syncFinanceFacts(database, now);
  return database.transaction(async (tx) => {
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`finance-daily-close:${statementDate}`);
    const rows = await tx.prepare<Row>(`
      SELECT * FROM finance_accruals
      WHERE status = 'pending_statement' AND eligible_date <= ?::date
      ORDER BY counterparty_type, counterparty_id, eligible_at, id
    `).all(statementDate);
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.counterparty_type}:${row.counterparty_id}`;
      const items = groups.get(key) ?? [];
      items.push(row);
      groups.set(key, items);
    }
    let created = 0;
    for (const items of groups.values()) {
      const first = items[0];
      const type = String(first.counterparty_type) as CounterpartyType;
      const counterpartyId = String(first.counterparty_id);
      const exists = await tx.prepare<Row>(`
        SELECT id FROM finance_daily_statements
        WHERE statement_date = ?::date AND counterparty_type = ? AND counterparty_id = ?
          AND status <> 'void'
      `).get(statementDate, type, counterpartyId);
      if (exists) continue;
      const balance = await tx.prepare<Row>(`
        SELECT * FROM finance_counterparty_balances
        WHERE counterparty_type = ? AND counterparty_id = ? FOR UPDATE
      `).get(type, counterpartyId);
      const opening = numberValue(balance?.balance_fen);
      const gross = items.reduce((sum, item) => sum + numberValue(item.gross_amount_fen), 0);
      const commission = items.reduce((sum, item) => sum + numberValue(item.commission_amount_fen), 0);
      const itemNet = items.reduce((sum, item) => sum + numberValue(item.net_amount_fen), 0);
      const available = opening + itemNet;
      const payable = Math.max(0, available);
      const closing = Math.min(0, available);
      // A zeroed statement still carries auditable items (for example a charge
      // and same-day refund); reserve `void` for an explicit administrator action.
      const status = payable > 0 ? "pending_payment" : "carried_forward";
      const statementId = randomUUID();
      const statementNumber = `YXM${statementDate.replaceAll("-", "")}${statementPrefix(type)}${statementId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
      const nowIso = now.toISOString();
      await tx.prepare(`
        INSERT INTO finance_daily_statements (
          id, statement_number, statement_date, counterparty_type, counterparty_id,
          counterparty_name, opening_balance_fen, gross_amount_fen, commission_amount_fen,
          item_net_amount_fen, payable_amount_fen, closing_balance_fen, item_count,
          status, generated_at, paid_at, voided_at, updated_at
        ) VALUES (?, ?, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, NULL, NULL, ?::timestamptz)
      `).run(
        statementId, statementNumber, statementDate, type, counterpartyId,
        String(first.counterparty_name), opening, gross, commission, itemNet, payable,
        closing, items.length, status, nowIso, nowIso,
      );
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        await tx.prepare(`
          INSERT INTO finance_statement_items (
            id, statement_id, accrual_id, sequence_no, order_number, component_type,
            entry_kind, gross_amount_fen, commission_amount_fen, net_amount_fen,
            eligible_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
        `).run(
          randomUUID(), statementId, String(item.id), index + 1, String(item.order_number),
          String(item.component_type), String(item.entry_kind), numberValue(item.gross_amount_fen),
          numberValue(item.commission_amount_fen), numberValue(item.net_amount_fen),
          isoTimestamp(item.eligible_at), nowIso,
        );
      }
      await tx.prepare(`
        UPDATE finance_accruals SET status = 'statemented', statement_id = ?
        WHERE id = ANY(?::text[])
      `).run(statementId, items.map((item) => String(item.id)));
      await tx.prepare(`
        INSERT INTO finance_counterparty_balances (counterparty_type, counterparty_id, balance_fen, updated_at)
        VALUES (?, ?, ?, ?::timestamptz)
        ON CONFLICT (counterparty_type, counterparty_id) DO UPDATE SET
          balance_fen = excluded.balance_fen, updated_at = excluded.updated_at
      `).run(type, counterpartyId, closing, nowIso);
      created += 1;
    }
    return created;
  });
}

function ruleDto(row: Row) {
  return { ...ruleSnapshot(row), status: String(row.status), createdAt: isoTimestamp(row.created_at), publishedAt: row.published_at ? isoTimestamp(row.published_at) : null };
}

function statementDto(row: Row) {
  return {
    id: String(row.id), statementNumber: String(row.statement_number), statementDate: isoDate(row.statement_date),
    counterpartyType: String(row.counterparty_type), counterpartyId: String(row.counterparty_id),
    counterpartyName: String(row.counterparty_name), openingBalanceFen: numberValue(row.opening_balance_fen),
    grossAmountFen: numberValue(row.gross_amount_fen), commissionAmountFen: numberValue(row.commission_amount_fen),
    itemNetAmountFen: numberValue(row.item_net_amount_fen), payableAmountFen: numberValue(row.payable_amount_fen),
    closingBalanceFen: numberValue(row.closing_balance_fen), itemCount: numberValue(row.item_count),
    status: String(row.status), generatedAt: isoTimestamp(row.generated_at), paidAt: row.paid_at ? isoTimestamp(row.paid_at) : null,
  };
}

function subjectScope(principal: BackofficeSession): { type: CounterpartyType; id: string } | null {
  if (principal.account.role === "platform_admin") return null;
  if (!principal.subject) throw new Error("BACKOFFICE_SUBJECT_REQUIRED");
  const type = ({ inspection_station: "inspection_station", wash_store: "wash_store", repair_shop: "repair_shop" })[principal.subject.type] as CounterpartyType;
  return { type, id: principal.subject.id };
}

function assertFinanceCapability(principal: BackofficeSession, capability: BackofficeCapability): void {
  assertCapability(principal, capability);
}

const ruleInputSchema = z.discriminatedUnion("businessType", [
  z.object({ businessType: z.enum(["annual_inspection", "car_wash", "repair"]), calculationMode: z.literal("percentage"), rateBps: z.number().int().min(0).max(10_000), effectiveFrom: z.string().date() }),
  z.object({ businessType: z.enum(["annual_inspection", "car_wash", "repair"]), calculationMode: z.literal("fixed"), fixedFen: z.number().int().min(0).max(100_000_000), effectiveFrom: z.string().date() }),
  z.object({ businessType: z.literal("valet"), calculationMode: z.literal("distance"), baseFeeFen: z.number().int().min(0).max(10_000_000), includedKm: z.number().min(0).max(1000), perKmFen: z.number().int().min(0).max(1_000_000), effectiveFrom: z.string().date() }),
]);
const companySchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/u),
  name: z.string().trim().min(2).max(120),
  contactName: z.string().trim().max(80).nullable().optional(),
  contactPhone: z.string().trim().max(30).nullable().optional(),
});
const payoutSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  paymentMethod: z.enum(["bank_transfer", "other"]),
  bankReference: z.string().trim().min(2).max(120),
  paidAt: z.string().datetime(),
  note: z.string().trim().max(1000).nullable().optional(),
});

function parseQueryNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

async function statementDetail(database: AppDatabase, statementId: string, scope: { type: CounterpartyType; id: string } | null): Promise<Record<string, unknown> | null> {
  const values: Array<string> = [statementId];
  const scopeSql = scope ? " AND counterparty_type = ? AND counterparty_id = ?" : "";
  if (scope) values.push(scope.type, scope.id);
  const row = await database.prepare<Row>(`SELECT * FROM finance_daily_statements WHERE id = ?${scopeSql}`).get(...values);
  if (!row) return null;
  const [items, payout] = await Promise.all([
    database.prepare<Row>(`SELECT * FROM finance_statement_items WHERE statement_id = ? ORDER BY sequence_no`).all(statementId),
    database.prepare<Row>(`SELECT * FROM finance_payouts WHERE statement_id = ? AND status = 'posted'`).get(statementId),
  ]);
  return {
    ...statementDto(row),
    items: items.map((item) => ({
      id: String(item.id), orderNumber: String(item.order_number), componentType: String(item.component_type),
      entryKind: String(item.entry_kind), grossAmountFen: numberValue(item.gross_amount_fen),
      commissionAmountFen: numberValue(item.commission_amount_fen), netAmountFen: numberValue(item.net_amount_fen),
      eligibleAt: isoTimestamp(item.eligible_at),
    })),
    payout: payout ? (scope ? {
      id: String(payout.id), amountFen: numberValue(payout.amount_fen), paymentMethod: String(payout.payment_method),
      paidAt: isoTimestamp(payout.paid_at), hasEvidence: false,
    } : {
      id: String(payout.id), amountFen: numberValue(payout.amount_fen), paymentMethod: String(payout.payment_method),
      bankReference: String(payout.bank_reference), note: payout.note ? String(payout.note) : null,
      paidAt: isoTimestamp(payout.paid_at), postedByName: String(payout.posted_by_name), hasEvidence: Boolean(payout.evidence_storage_key),
    }) : null,
  };
}

async function statementWorkbook(detail: Record<string, unknown>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "驭小满";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("日账单", { views: [{ state: "frozen", ySplit: 6 }] });
  sheet.columns = [
    { header: "序号", key: "sequence", width: 9 },
    { header: "订单号", key: "orderNumber", width: 28 },
    { header: "费用类型", key: "component", width: 18 },
    { header: "条目", key: "kind", width: 12 },
    { header: "服务金额（元）", key: "gross", width: 18 },
    { header: "平台佣金（元）", key: "commission", width: 18 },
    { header: "应收/应付（元）", key: "net", width: 20 },
    { header: "计入时间", key: "eligibleAt", width: 24 },
  ];
  sheet.insertRows(1, [
    ["驭小满合作方日账单"],
    ["账单编号", detail.statementNumber],
    ["账单日期", detail.statementDate, "合作方", detail.counterpartyName],
    ["状态", detail.status, "应付金额（元）", (numberValue(detail.payableAmountFen) / 100).toFixed(2)],
    [],
  ]);
  sheet.mergeCells("A1:H1");
  sheet.getCell("A1").font = { bold: true, size: 18, color: { argb: "FF163A5F" } };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };
  sheet.getRow(1).height = 32;
  const items = Array.isArray(detail.items) ? detail.items as Array<Record<string, unknown>> : [];
  items.forEach((item, index) => sheet.addRow({
    sequence: index + 1,
    orderNumber: item.orderNumber,
    component: ({ inspection_fee: "年检费用", wash_fee: "洗车费用", repair_fee: "维修费用", valet_cost: "代驾费用" } as Record<string, string>)[String(item.componentType)] ?? String(item.componentType),
    kind: item.entryKind === "reversal" ? "退款冲正" : "服务应收",
    gross: numberValue(item.grossAmountFen) / 100,
    commission: numberValue(item.commissionAmountFen) / 100,
    net: numberValue(item.netAmountFen) / 100,
    eligibleAt: String(item.eligibleAt),
  }));
  const header = sheet.getRow(6);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1768CF" } };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 6) {
      row.getCell(5).numFmt = "¥0.00;[Red]-¥0.00";
      row.getCell(6).numFmt = "¥0.00;[Red]-¥0.00";
      row.getCell(7).numFmt = "¥0.00;[Red]-¥0.00";
    }
    row.alignment = { vertical: "middle" };
  });
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

export async function registerFinanceRoutes(app: FastifyInstance, database: AppDatabase, options: FinanceRouteOptions): Promise<void> {
  const now = options.now ?? (() => new Date());
  const problem = options.problem;
  const payoutEvidenceDir = join(options.uploadDir, "finance-payout-evidence");
  await mkdir(payoutEvidenceDir, { recursive: true });

  const overview = async (request: FastifyRequest) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.read");
    const scope = subjectScope(principal);
    const scopeSql = scope ? "WHERE counterparty_type = ? AND counterparty_id = ?" : "";
    const values = scope ? [scope.type, scope.id] : [];
    const [settings, pending, statements, transactions, paid, commissions, valet] = await Promise.all([
      financeSettings(database),
      database.prepare<Row>(`SELECT COALESCE(SUM(net_amount_fen), 0) AS amount_fen, COUNT(*)::text AS count FROM finance_accruals ${scopeSql ? `${scopeSql} AND` : "WHERE"} status = 'pending_statement'`).get(...values),
      database.prepare<Row>(`SELECT COALESCE(SUM(payable_amount_fen), 0) AS amount_fen, COUNT(*)::text AS count FROM finance_daily_statements ${scopeSql ? `${scopeSql} AND` : "WHERE"} status = 'pending_payment'`).get(...values),
      database.prepare<Row>(`SELECT
        COALESCE(SUM(channel_amount_fen) FILTER (WHERE transaction_kind = 'charge' AND status = 'confirmed'), 0) AS charge_fen,
        COALESCE(SUM(channel_amount_fen) FILTER (WHERE transaction_kind = 'refund' AND status = 'confirmed'), 0) AS refund_fen
        FROM finance_payment_transactions
        WHERE (occurred_at AT TIME ZONE 'Asia/Shanghai')::date = ?::date`).get(shanghaiDate(now())),
      database.prepare<Row>(`SELECT COALESCE(SUM(amount_fen), 0) AS amount_fen FROM finance_payouts WHERE status = 'posted' ${scope ? "AND statement_id IN (SELECT id FROM finance_daily_statements WHERE counterparty_type = ? AND counterparty_id = ?)" : ""}`).get(...values),
      database.prepare<Row>(`SELECT COALESCE(SUM(commission_amount_fen), 0) AS amount_fen FROM finance_accruals ${scopeSql}`).get(...values),
      database.prepare<Row>(`SELECT COALESCE(SUM(customer_component_amount_fen - net_amount_fen), 0) AS margin_fen FROM finance_accruals WHERE component_type = 'valet_cost'`).get(),
    ]);
    return {
      data: {
        enabled: bool(settings.enabled), cutoverAt: settings.cutover_at ? isoTimestamp(settings.cutover_at) : null,
        pendingAccrualFen: numberValue(pending?.amount_fen), pendingAccrualCount: numberValue(pending?.count),
        pendingPayoutFen: numberValue(statements?.amount_fen), pendingStatementCount: numberValue(statements?.count),
        todayCollectedFen: scope ? null : numberValue(transactions?.charge_fen),
        todayRefundedFen: scope ? null : numberValue(transactions?.refund_fen),
        todayNetCollectedFen: scope ? null : numberValue(transactions?.charge_fen) - numberValue(transactions?.refund_fen),
        paidPayoutFen: numberValue(paid?.amount_fen),
        platformCommissionFen: scope ? null : numberValue(commissions?.amount_fen),
        valetMarginFen: scope ? null : numberValue(valet?.margin_fen),
      },
    };
  };

  app.get("/api/admin/finance/overview", overview);
  app.get("/api/admin/wash/finance/overview", overview);
  app.get("/api/operator/finance/overview", overview);
  app.get("/api/repair-operator/finance/overview", overview);

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/admin/finance/transactions", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.read");
    if (principal.account.role !== "platform_admin") throw problem(403, "BACKOFFICE_FORBIDDEN", "仅平台管理员可以查看支付流水");
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (request.query.businessType) { clauses.push("source_order_type = ?"); values.push(request.query.businessType); }
    if (request.query.kind) { clauses.push("transaction_kind = ?"); values.push(request.query.kind); }
    if (request.query.provider) { clauses.push("provider = ?"); values.push(request.query.provider); }
    if (request.query.status === "abnormal") clauses.push("status IN ('failed', 'anomaly')");
    else if (request.query.status) { clauses.push("status = ?"); values.push(request.query.status); }
    if (request.query.isReal === "true" || request.query.isReal === "false") { clauses.push("is_real = ?"); values.push(request.query.isReal === "true" ? 1 : 0); }
    if (request.query.orderNumber) { clauses.push("order_number ILIKE ?"); values.push(`%${request.query.orderNumber.trim()}%`); }
    if (request.query.transactionId) { clauses.push("transaction_id ILIKE ?"); values.push(`%${request.query.transactionId.trim()}%`); }
    if (request.query.fulfillmentStatus) {
      clauses.push(`CASE source_order_type
        WHEN 'annual_inspection' THEN (SELECT COALESCE(b.fulfillment_status, b.status) FROM bookings b WHERE b.id = finance_payment_transactions.source_order_id)
        WHEN 'car_wash' THEN (SELECT COALESCE(o.fulfillment_status, o.status) FROM wash_orders o WHERE o.id = finance_payment_transactions.source_order_id)
        WHEN 'repair' THEN (SELECT o.status FROM repair_orders o WHERE o.id = finance_payment_transactions.source_order_id)
        ELSE NULL END = ?`);
      values.push(request.query.fulfillmentStatus);
    }
    if (request.query.counterpartyId) { clauses.push("EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.counterparty_id = ?)"); values.push(request.query.counterpartyId); }
    if (request.query.counterpartyName) { clauses.push("EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.counterparty_name ILIKE ?)"); values.push(`%${request.query.counterpartyName.trim()}%`); }
    if (request.query.plate) {
      const normalizedPlate = request.query.plate.normalize("NFKC").replace(/[\s·•・.\-]/gu, "").toUpperCase();
      clauses.push(`CASE source_order_type
        WHEN 'annual_inspection' THEN EXISTS (SELECT 1 FROM bookings b WHERE b.id = finance_payment_transactions.source_order_id AND regexp_replace(upper(COALESCE((b.vehicle_snapshot_json::jsonb)->>'plateNumber', '')), '[[:space:]·•・.\\-]', '', 'g') ILIKE ?)
        WHEN 'car_wash' THEN EXISTS (SELECT 1 FROM wash_orders o WHERE o.id = finance_payment_transactions.source_order_id AND regexp_replace(upper(COALESCE((o.vehicle_snapshot_json::jsonb)->>'plateNumber', '')), '[[:space:]·•・.\\-]', '', 'g') ILIKE ?)
        WHEN 'repair' THEN EXISTS (SELECT 1 FROM repair_orders o WHERE o.id = finance_payment_transactions.source_order_id AND regexp_replace(upper(COALESCE((o.request_snapshot_json::jsonb)->'vehicle'->>'plateNumber', '')), '[[:space:]·•・.\\-]', '', 'g') ILIKE ?)
        ELSE FALSE END`);
      values.push(`%${normalizedPlate}%`, `%${normalizedPlate}%`, `%${normalizedPlate}%`);
    }
    if (request.query.settlementStatus === "statemented") {
      clauses.push(`EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'statemented')
        AND NOT EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'pending_statement')`);
    }
    if (request.query.settlementStatus === "pending") {
      clauses.push(`EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'pending_statement')
        AND NOT EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'statemented')`);
    }
    if (request.query.settlementStatus === "partial") {
      clauses.push(`EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'statemented')
        AND EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'pending_statement')`);
    }
    if (request.query.dateFrom) { clauses.push("(occurred_at AT TIME ZONE 'Asia/Shanghai')::date >= ?::date"); values.push(request.query.dateFrom); }
    if (request.query.dateTo) { clauses.push("(occurred_at AT TIME ZONE 'Asia/Shanghai')::date <= ?::date"); values.push(request.query.dateTo); }
    const page = parseQueryNumber(request.query.page, 1, 1, 100_000);
    const pageSize = parseQueryNumber(request.query.pageSize, 30, 1, 100);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = numberValue((await database.prepare<Row>(`SELECT COUNT(*)::text AS count FROM finance_payment_transactions ${where}`).get(...values))?.count);
    const rows = await database.prepare<Row>(`
      SELECT finance_payment_transactions.*,
        CASE source_order_type
          WHEN 'annual_inspection' THEN (SELECT COALESCE(b.fulfillment_status, b.status) FROM bookings b WHERE b.id = source_order_id)
          WHEN 'car_wash' THEN (SELECT COALESCE(o.fulfillment_status, o.status) FROM wash_orders o WHERE o.id = source_order_id)
          WHEN 'repair' THEN (SELECT o.status FROM repair_orders o WHERE o.id = source_order_id)
        END AS fulfillment_status,
        CASE
          WHEN EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'statemented')
           AND EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'pending_statement')
            THEN 'partial'
          WHEN EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'statemented')
            THEN 'statemented'
          WHEN EXISTS (SELECT 1 FROM finance_accruals a WHERE a.source_order_type = finance_payment_transactions.source_order_type AND a.source_order_id = finance_payment_transactions.source_order_id AND a.status = 'pending_statement')
            THEN 'pending'
          ELSE 'not_eligible' END AS settlement_status
      FROM finance_payment_transactions ${where}
      ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize);
    return { data: { items: rows.map((row) => ({
      id: String(row.id), businessType: String(row.source_order_type), sourceOrderId: String(row.source_order_id),
      orderNumber: String(row.order_number), kind: String(row.transaction_kind), provider: String(row.provider),
      listedAmountFen: numberValue(row.listed_amount_fen), channelAmountFen: numberValue(row.channel_amount_fen),
      transactionId: row.transaction_id ? String(row.transaction_id) : null, outTradeNo: row.out_trade_no ? String(row.out_trade_no) : null,
      status: String(row.status), isReal: bool(row.is_real), occurredAt: isoTimestamp(row.occurred_at),
      fulfillmentStatus: row.fulfillment_status ? String(row.fulfillment_status) : null,
      settlementStatus: String(row.settlement_status),
    })), total, page, pageSize } };
  });

  app.get<{ Params: { id: string } }>("/api/admin/finance/transactions/:id", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.read");
    if (principal.account.role !== "platform_admin") throw problem(403, "BACKOFFICE_FORBIDDEN", "仅平台管理员可以查看支付流水");
    const payment = await database.prepare<Row>("SELECT * FROM finance_payment_transactions WHERE id = ?").get(request.params.id);
    if (!payment) throw problem(404, "FINANCE_TRANSACTION_NOT_FOUND", "未找到订单流水");
    const orderType = String(payment.source_order_type);
    const orderId = String(payment.source_order_id);
    const accruals = await database.prepare<Row>(`
      SELECT a.*, s.statement_number, s.status AS statement_status
      FROM finance_accruals a LEFT JOIN finance_daily_statements s ON s.id = a.statement_id
      WHERE a.source_order_type = ? AND a.source_order_id = ? ORDER BY a.eligible_at, a.id
    `).all(orderType, orderId);
    let order: Row | undefined;
    let events: Row[] = [];
    let valetExecution: Row | undefined;
    if (orderType === "annual_inspection") {
      order = await database.prepare<Row>("SELECT * FROM bookings WHERE id = ?").get(orderId);
      events = await database.prepare<Row>("SELECT status, title, description, created_at FROM booking_events WHERE booking_id = ? ORDER BY created_at, id").all(orderId);
      valetExecution = await database.prepare<Row>(`SELECT a.driver_name, a.driver_phone, a.status, u.display_name AS account_name
        FROM valet_driver_assignments a LEFT JOIN users u ON u.id = a.bound_user_id WHERE a.booking_id = ?`).get(orderId);
    } else if (orderType === "car_wash") {
      order = await database.prepare<Row>("SELECT * FROM wash_orders WHERE id = ?").get(orderId);
      events = await database.prepare<Row>("SELECT status, title, description, created_at FROM wash_order_events WHERE order_id = ? ORDER BY created_at, id").all(orderId);
      valetExecution = await database.prepare<Row>(`SELECT COALESCE(u.display_name, '待认领') AS account_name,
        a.driver_phone, a.status, a.dispatcher_name FROM wash_valet_assignments a
        LEFT JOIN users u ON u.id = a.bound_user_id WHERE a.order_id = ?`).get(orderId);
    } else {
      order = await database.prepare<Row>("SELECT * FROM repair_orders WHERE id = ?").get(orderId);
    }
    return { data: {
      payment: {
        id: String(payment.id), businessType: orderType, orderNumber: String(payment.order_number),
        kind: String(payment.transaction_kind), provider: String(payment.provider), status: String(payment.status),
        listedAmountFen: numberValue(payment.listed_amount_fen), channelAmountFen: numberValue(payment.channel_amount_fen),
        transactionId: payment.transaction_id ? String(payment.transaction_id) : null,
        outTradeNo: payment.out_trade_no ? String(payment.out_trade_no) : null,
        isReal: bool(payment.is_real), occurredAt: isoTimestamp(payment.occurred_at),
      },
      order: order ? {
        id: orderId,
        status: String(order.status),
        fulfillmentStatus: String(order.fulfillment_status ?? order.status),
        paymentStatus: String(order.payment_status ?? payment.status),
        inspectionFeeFen: numberValue(order.inspection_fee_fen), valetFeeFen: numberValue(order.valet_fee_fen),
        washFeeFen: numberValue(order.wash_fee_fen), repairFeeFen: numberValue(order.total_price_fen),
        totalFen: numberValue(order.service_fee_fen ?? order.total_fee_fen ?? order.total_price_fen),
      } : null,
      accruals: accruals.map((row) => ({
        id: String(row.id), componentType: String(row.component_type), entryKind: String(row.entry_kind),
        counterpartyType: String(row.counterparty_type), counterpartyName: String(row.counterparty_name),
        grossAmountFen: numberValue(row.gross_amount_fen), commissionAmountFen: numberValue(row.commission_amount_fen),
        netAmountFen: numberValue(row.net_amount_fen), eligibleAt: isoTimestamp(row.eligible_at),
        statementNumber: row.statement_number ? String(row.statement_number) : null,
        statementStatus: row.statement_status ? String(row.statement_status) : null,
        ruleSnapshot: jsonObject(row.rule_snapshot_json),
      })),
      timeline: events.map((row) => ({ status: String(row.status), title: String(row.title), description: String(row.description), createdAt: isoTimestamp(row.created_at) })),
      valetExecution: valetExecution ? {
        driverName: text(valetExecution.account_name, text(valetExecution.driver_name, "待认领")),
        driverPhone: valetExecution.driver_phone ? String(valetExecution.driver_phone) : null,
        dispatcherName: valetExecution.dispatcher_name ? String(valetExecution.dispatcher_name) : null,
        status: String(valetExecution.status),
      } : null,
    } };
  });

  const listStatements = async (request: FastifyRequest<{ Querystring: Record<string, string | undefined> }>) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.read");
    const scope = subjectScope(principal);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (scope) { clauses.push("counterparty_type = ?", "counterparty_id = ?"); values.push(scope.type, scope.id); }
    if (!scope && request.query.counterpartyType) { clauses.push("counterparty_type = ?"); values.push(request.query.counterpartyType); }
    if (!scope && request.query.counterpartyId) { clauses.push("counterparty_id = ?"); values.push(request.query.counterpartyId); }
    if (request.query.status) { clauses.push("status = ?"); values.push(request.query.status); }
    if (request.query.dateFrom) { clauses.push("statement_date >= ?::date"); values.push(request.query.dateFrom); }
    if (request.query.dateTo) { clauses.push("statement_date <= ?::date"); values.push(request.query.dateTo); }
    const page = parseQueryNumber(request.query.page, 1, 1, 100_000);
    const pageSize = parseQueryNumber(request.query.pageSize, 30, 1, 100);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = numberValue((await database.prepare<Row>(`SELECT COUNT(*)::text AS count FROM finance_daily_statements ${where}`).get(...values))?.count);
    const rows = await database.prepare<Row>(`
      SELECT * FROM finance_daily_statements ${where}
      ORDER BY statement_date DESC, generated_at DESC LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize);
    return { data: { items: rows.map(statementDto), total, page, pageSize } };
  };
  app.get("/api/admin/finance/statements", listStatements);
  app.get("/api/admin/wash/finance/statements", listStatements);
  app.get("/api/operator/finance/statements", listStatements);
  app.get("/api/repair-operator/finance/statements", listStatements);

  const getStatement = async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.read");
    const detail = await statementDetail(database, request.params.id, subjectScope(principal));
    if (!detail) throw problem(404, "FINANCE_STATEMENT_NOT_FOUND", "未找到账单");
    return { data: detail };
  };
  app.get("/api/admin/finance/statements/:id", getStatement);
  app.get("/api/admin/wash/finance/statements/:id", getStatement);
  app.get("/api/operator/finance/statements/:id", getStatement);
  app.get("/api/repair-operator/finance/statements/:id", getStatement);

  const exportStatement = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.export");
    const detail = await statementDetail(database, request.params.id, subjectScope(principal));
    if (!detail) throw problem(404, "FINANCE_STATEMENT_NOT_FOUND", "未找到账单");
    const buffer = await statementWorkbook(detail);
    reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${detail.statementNumber}.xlsx`)}`);
    return reply.send(buffer);
  };
  app.get("/api/admin/finance/statements/:id/export", exportStatement);
  app.get("/api/admin/wash/finance/statements/:id/export", exportStatement);
  app.get("/api/operator/finance/statements/:id/export", exportStatement);
  app.get("/api/repair-operator/finance/statements/:id/export", exportStatement);

  app.get("/api/admin/finance/rules", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.rules.manage");
    const rows = await database.prepare<Row>("SELECT * FROM finance_rule_versions ORDER BY business_type, version DESC").all();
    return { data: rows.map(ruleDto) };
  });

  app.post("/api/admin/finance/rules", async (request, reply) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.rules.manage");
    const parsed = ruleInputSchema.safeParse(request.body);
    if (!parsed.success) throw problem(400, "FINANCE_RULE_INVALID", "结算规则填写不完整");
    const input = parsed.data;
    const version = numberValue((await database.prepare<Row>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM finance_rule_versions WHERE business_type = ?").get(input.businessType))?.version);
    const id = randomUUID();
    const ruleKind = input.businessType === "valet" ? "valet_cost" : "commission";
    const nowIso = now().toISOString();
    await database.prepare(`
      INSERT INTO finance_rule_versions (
        id, business_type, rule_kind, calculation_mode, rate_bps, fixed_fen,
        base_fee_fen, included_km, per_km_fen, effective_from, version, status,
        created_by_account_id, published_by_account_id, created_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, 'draft', ?, NULL, ?::timestamptz, NULL)
    `).run(
      id, input.businessType, ruleKind, input.calculationMode,
      "rateBps" in input ? input.rateBps : null, "fixedFen" in input ? input.fixedFen : null,
      "baseFeeFen" in input ? input.baseFeeFen : null, "includedKm" in input ? input.includedKm : null,
      "perKmFen" in input ? input.perKmFen : null, input.effectiveFrom, version,
      principal.account.id, nowIso,
    );
    await auditBackofficeEvent(database, { request, action: "finance.rule.draft.create", outcome: "success", resource: { type: "finance_rule", id }, presentation: { category: "finance", actionLabel: "创建结算规则草稿", summary: `${input.businessType} v${version}` } });
    const row = await database.prepare<Row>("SELECT * FROM finance_rule_versions WHERE id = ?").get(id);
    return reply.status(201).send({ data: ruleDto(row!) });
  });

  app.post<{ Params: { id: string } }>("/api/admin/finance/rules/:id/publish", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.rules.manage");
    const nowIso = now().toISOString();
    await database.transaction(async (tx) => {
      const rule = await tx.prepare<Row>("SELECT * FROM finance_rule_versions WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!rule) throw problem(404, "FINANCE_RULE_NOT_FOUND", "未找到结算规则");
      if (String(rule.status) === "active") return;
      if (String(rule.status) !== "draft") throw problem(409, "FINANCE_RULE_NOT_PUBLISHABLE", "只有草稿规则可以发布");
      await tx.prepare("UPDATE finance_rule_versions SET status = 'retired' WHERE business_type = ? AND status = 'active'").run(String(rule.business_type));
      await tx.prepare("UPDATE finance_rule_versions SET status = 'active', published_by_account_id = ?, published_at = ?::timestamptz WHERE id = ?")
        .run(principal.account.id, nowIso, request.params.id);
      await auditBackofficeEvent(tx, { request, action: "finance.rule.publish", outcome: "success", resource: { type: "finance_rule", id: request.params.id }, presentation: { category: "finance", actionLabel: "发布结算规则", summary: `${rule.business_type} v${rule.version}` } });
    });
    const row = await database.prepare<Row>("SELECT * FROM finance_rule_versions WHERE id = ?").get(request.params.id);
    return { data: ruleDto(row!) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/finance/rules/:id/preview", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.rules.manage");
    const parsed = z.object({ amountFen: z.number().int().nonnegative().optional(), distanceKm: z.number().nonnegative().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) throw problem(400, "FINANCE_RULE_PREVIEW_INVALID", "预览参数无效");
    const rule = await database.prepare<Row>("SELECT * FROM finance_rule_versions WHERE id = ?").get(request.params.id);
    if (!rule) throw problem(404, "FINANCE_RULE_NOT_FOUND", "未找到结算规则");
    if (String(rule.business_type) === "valet") {
      const distanceKm = parsed.data.distanceKm ?? 8;
      return { data: { businessType: "valet", distanceKm, payableFen: calculateValetCostFen(distanceKm, rule), rule: ruleDto(rule) } };
    }
    const amountFen = parsed.data.amountFen ?? 10_000;
    const commissionFen = calculateCommissionFen(amountFen, rule);
    return { data: { businessType: String(rule.business_type), amountFen, commissionFen, receivableFen: amountFen - commissionFen, rule: ruleDto(rule) } };
  });

  app.get("/api/admin/finance/settings", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.rules.manage");
    const [settings, company] = await Promise.all([
      financeSettings(database),
      database.prepare<Row>("SELECT * FROM valet_companies WHERE is_active = TRUE ORDER BY created_at LIMIT 1").get(),
    ]);
    return { data: { enabled: bool(settings.enabled), cutoverAt: settings.cutover_at ? isoTimestamp(settings.cutover_at) : null, valetCompany: company ? { id: String(company.id), code: String(company.code), name: String(company.name), contactName: company.contact_name ? String(company.contact_name) : null, contactPhone: company.contact_phone ? String(company.contact_phone) : null } : null } };
  });

  app.put("/api/admin/finance/valet-company", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.rules.manage");
    const parsed = companySchema.safeParse(request.body);
    if (!parsed.success) throw problem(400, "VALET_COMPANY_INVALID", "代驾公司资料填写不完整");
    const nowIso = now().toISOString();
    const existing = await database.prepare<Row>("SELECT id FROM valet_companies WHERE is_active = TRUE ORDER BY created_at LIMIT 1").get();
    const id = existing ? String(existing.id) : randomUUID();
    await database.transaction(async (tx) => {
      await tx.prepare("UPDATE valet_companies SET is_active = FALSE, updated_at = ?::timestamptz WHERE id <> ? AND is_active = TRUE").run(nowIso, id);
      await tx.prepare(`
        INSERT INTO valet_companies (id, code, name, contact_name, contact_phone, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, TRUE, ?::timestamptz, ?::timestamptz)
        ON CONFLICT (id) DO UPDATE SET code = excluded.code, name = excluded.name,
          contact_name = excluded.contact_name, contact_phone = excluded.contact_phone,
          is_active = TRUE, updated_at = excluded.updated_at
      `).run(id, parsed.data.code, parsed.data.name, parsed.data.contactName ?? null, parsed.data.contactPhone ?? null, nowIso, nowIso);
      await tx.prepare("UPDATE finance_settings SET default_valet_company_id = ?, updated_by_account_id = ?, updated_at = ?::timestamptz WHERE id = 1")
        .run(id, principal.account.id, nowIso);
      await auditBackofficeEvent(tx, { request, action: "finance.valet_company.update", outcome: "success", resource: { type: "valet_company", id }, presentation: { category: "finance", actionLabel: "更新合作代驾公司", summary: parsed.data.name } });
    });
    return { data: { id, ...parsed.data } };
  });

  app.post("/api/admin/finance/enable", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.rules.manage");
    const active = await database.prepare<Row>("SELECT business_type FROM finance_rule_versions WHERE status = 'active'").all();
    const activeTypes = new Set(active.map((row) => String(row.business_type)));
    const missing = BUSINESS_TYPES.filter((type) => !activeTypes.has(type));
    const company = await database.prepare<Row>("SELECT id FROM valet_companies WHERE is_active = TRUE LIMIT 1").get();
    if (missing.length || !company) throw problem(409, "FINANCE_SETUP_INCOMPLETE", "请先发布年检、洗车、维修和代驾规则，并配置合作代驾公司", { missing: missing.join(",") });
    const current = await financeSettings(database);
    if (bool(current.enabled)) return { data: { enabled: true, cutoverAt: isoTimestamp(current.cutover_at) } };
    const cutoverAt = now().toISOString();
    await database.prepare("UPDATE finance_settings SET enabled = TRUE, cutover_at = ?, default_valet_company_id = ?, updated_by_account_id = ?, updated_at = ? WHERE id = 1")
      .run(cutoverAt, String(company.id), principal.account.id, cutoverAt);
    await auditBackofficeEvent(database, { request, action: "finance.enable", outcome: "success", resource: { type: "finance_settings", id: "1" }, presentation: { category: "finance", actionLabel: "启用统一财务", summary: `切换时间 ${cutoverAt}` } });
    return { data: { enabled: true, cutoverAt } };
  });

  app.post("/api/admin/finance/sync", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.statements.manage");
    const result = await syncFinanceFacts(database, now());
    await auditBackofficeEvent(database, {
      request,
      action: "finance.sync",
      outcome: "success",
      resource: { type: "finance_settings", id: "1" },
      presentation: { category: "finance", actionLabel: "同步财务投影", summary: result.enabled ? "已同步支付与应计" : "财务未启用，未写入投影" },
    });
    return { data: result };
  });

  app.post("/api/admin/finance/daily-close", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.statements.manage");
    const parsed = z.object({ statementDate: z.string().date() }).safeParse(request.body);
    if (!parsed.success) throw problem(400, "FINANCE_CLOSE_DATE_INVALID", "日结日期无效");
    if (parsed.data.statementDate >= shanghaiDate(now())) throw problem(409, "FINANCE_CLOSE_DATE_NOT_FINISHED", "只能封账已结束的自然日");
    const created = await runFinanceDailyClose(database, parsed.data.statementDate, now());
    await auditBackofficeEvent(database, { request, action: "finance.daily_close", outcome: "success", resource: { type: "finance_statement_batch", id: parsed.data.statementDate }, presentation: { category: "finance", actionLabel: "补跑日结", summary: `${parsed.data.statementDate} · 新增 ${created} 张账单` } });
    return { data: { statementDate: parsed.data.statementDate, created } };
  });

  app.post<{ Params: { id: string } }>("/api/admin/finance/statements/:id/payout", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.payouts.manage");
    const parsed = payoutSchema.safeParse(request.body);
    if (!parsed.success) throw problem(400, "FINANCE_PAYOUT_INVALID", "付款登记填写不完整");
    await database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`finance-payout:${request.params.id}`);
      const statement = await tx.prepare<Row>("SELECT * FROM finance_daily_statements WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!statement) throw problem(404, "FINANCE_STATEMENT_NOT_FOUND", "未找到账单");
      const existing = await tx.prepare<Row>("SELECT * FROM finance_payouts WHERE idempotency_key = ?").get(parsed.data.idempotencyKey);
      if (existing) {
        if (String(existing.statement_id) !== request.params.id) throw problem(409, "FINANCE_PAYOUT_IDEMPOTENCY_CONFLICT", "付款幂等键已用于其他账单");
        return;
      }
      if (String(statement.status) !== "pending_payment" || numberValue(statement.payable_amount_fen) <= 0) throw problem(409, "FINANCE_STATEMENT_NOT_PAYABLE", "当前账单不能登记付款");
      const payoutId = randomUUID();
      const createdAt = now().toISOString();
      await tx.prepare(`
        INSERT INTO finance_payouts (
          id, statement_id, idempotency_key, amount_fen, payment_method,
          bank_reference, note, evidence_storage_key, evidence_mime_type,
          status, posted_by_account_id, posted_by_name, paid_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'posted', ?, ?, ?::timestamptz, ?::timestamptz)
      `).run(
        payoutId, request.params.id, parsed.data.idempotencyKey, numberValue(statement.payable_amount_fen),
        parsed.data.paymentMethod, parsed.data.bankReference, parsed.data.note ?? null,
        principal.account.id, principal.account.displayName, parsed.data.paidAt, createdAt,
      );
      await tx.prepare("UPDATE finance_daily_statements SET status = 'paid', paid_at = ?::timestamptz, updated_at = ?::timestamptz WHERE id = ?")
        .run(parsed.data.paidAt, createdAt, request.params.id);
      await auditBackofficeEvent(tx, { request, action: "finance.payout.post", outcome: "success", resource: { type: "finance_statement", id: request.params.id }, presentation: { category: "finance", actionLabel: "登记线下付款", summary: `${statement.statement_number} · ¥${(numberValue(statement.payable_amount_fen) / 100).toFixed(2)}` } });
    });
    return { data: await statementDetail(database, request.params.id, null) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/finance/statements/:id/payout/evidence", async (request, reply) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.payouts.manage");
    const payout = await database.prepare<Row>("SELECT * FROM finance_payouts WHERE statement_id = ? AND status = 'posted'").get(request.params.id);
    if (!payout) throw problem(404, "FINANCE_PAYOUT_NOT_FOUND", "请先登记账单付款");
    let part;
    try { part = await request.file(); } catch { throw problem(413, "FINANCE_PAYOUT_EVIDENCE_TOO_LARGE", "付款凭证不能超过 10MB"); }
    if (!part || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(part.mimetype)) {
      throw problem(415, "FINANCE_PAYOUT_EVIDENCE_INVALID", "付款凭证仅支持 JPG、PNG、WebP 或 PDF");
    }
    const buffer = await part.toBuffer();
    if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw problem(413, "FINANCE_PAYOUT_EVIDENCE_TOO_LARGE", "付款凭证不能超过 10MB");
    const extension = part.mimetype === "application/pdf" ? "pdf" : part.mimetype.split("/")[1].replace("jpeg", "jpg");
    const storageKey = `${String(payout.id)}-${randomUUID()}.${extension}`;
    await writeFile(join(payoutEvidenceDir, storageKey), buffer, { flag: "wx" });
    await database.prepare("UPDATE finance_payouts SET evidence_storage_key = ?, evidence_mime_type = ? WHERE id = ?")
      .run(storageKey, part.mimetype, String(payout.id));
    if (payout.evidence_storage_key) await unlink(join(payoutEvidenceDir, String(payout.evidence_storage_key))).catch(() => undefined);
    await auditBackofficeEvent(database, { request, action: "finance.payout.evidence.upload", outcome: "success", resource: { type: "finance_payout", id: String(payout.id) }, presentation: { category: "finance", actionLabel: "上传付款凭证", summary: String(payout.bank_reference) } });
    return reply.status(201).send({ data: { uploaded: true } });
  });

  app.get<{ Params: { id: string } }>("/api/admin/finance/statements/:id/payout/evidence", async (request, reply) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.payouts.manage");
    const payout = await database.prepare<Row>("SELECT * FROM finance_payouts WHERE statement_id = ? AND status = 'posted'").get(request.params.id);
    if (!payout?.evidence_storage_key) throw problem(404, "FINANCE_PAYOUT_EVIDENCE_NOT_FOUND", "未上传付款凭证");
    await auditBackofficeEvent(database, { request, action: "finance.payout.evidence.read", outcome: "success", resource: { type: "finance_payout", id: String(payout.id) }, presentation: { category: "finance", actionLabel: "查看付款凭证", summary: String(payout.bank_reference) } });
    reply.type(String(payout.evidence_mime_type ?? "application/octet-stream")).header("cache-control", "private, no-store");
    return reply.send(createReadStream(join(payoutEvidenceDir, String(payout.evidence_storage_key))));
  });

  app.post<{ Params: { id: string } }>("/api/admin/finance/statements/:id/void", async (request) => {
    const principal = backofficeForRequest(request);
    assertFinanceCapability(principal, "finance.statements.manage");
    const parsed = z.object({ reason: z.string().trim().min(2).max(500) }).safeParse(request.body);
    if (!parsed.success) throw problem(400, "FINANCE_VOID_REASON_REQUIRED", "请填写作废原因");
    await database.transaction(async (tx) => {
      const statement = await tx.prepare<Row>("SELECT * FROM finance_daily_statements WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!statement) throw problem(404, "FINANCE_STATEMENT_NOT_FOUND", "未找到账单");
      if (String(statement.status) === "void") return;
      if (String(statement.status) === "paid") throw problem(409, "FINANCE_PAID_STATEMENT_NOT_VOIDABLE", "已登记付款的账单不能作废");
      const later = await tx.prepare<Row>(`SELECT id FROM finance_daily_statements WHERE counterparty_type = ? AND counterparty_id = ? AND statement_date > ?::date AND status <> 'void' LIMIT 1`).get(String(statement.counterparty_type), String(statement.counterparty_id), isoDate(statement.statement_date));
      if (later) throw problem(409, "FINANCE_STATEMENT_NOT_LATEST", "已有后续账单，不能回退本期账单");
      await tx.prepare("UPDATE finance_accruals SET status = 'pending_statement', statement_id = NULL WHERE statement_id = ?").run(request.params.id);
      await tx.prepare("DELETE FROM finance_statement_items WHERE statement_id = ?").run(request.params.id);
      await tx.prepare(`INSERT INTO finance_counterparty_balances (counterparty_type, counterparty_id, balance_fen, updated_at)
        VALUES (?, ?, ?, now()) ON CONFLICT (counterparty_type, counterparty_id) DO UPDATE SET balance_fen = excluded.balance_fen, updated_at = excluded.updated_at`)
        .run(String(statement.counterparty_type), String(statement.counterparty_id), Math.min(0, numberValue(statement.opening_balance_fen)));
      await tx.prepare("UPDATE finance_daily_statements SET status = 'void', voided_at = now(), updated_at = now() WHERE id = ?").run(request.params.id);
      await auditBackofficeEvent(tx, { request, action: "finance.statement.void", outcome: "success", resource: { type: "finance_statement", id: request.params.id }, presentation: { category: "finance", actionLabel: "作废日账单", summary: `${statement.statement_number} · ${parsed.data.reason}` } });
    });
    return { data: await statementDetail(database, request.params.id, null) };
  });

  if (!options.disableDailyCloseScheduler) {
    const closeHour = options.dailyCloseHourShanghai ?? 2;
    let closeTimer: NodeJS.Timeout | null = null;
    let closeRunning = false;
    const scheduleNextClose = () => {
      const delayMs = msUntilNextShanghaiDailyClose(now(), closeHour);
      closeTimer = setTimeout(() => {
        void (async () => {
          if (closeRunning) {
            scheduleNextClose();
            return;
          }
          closeRunning = true;
          try {
            const tick = now();
            await runFinanceDailyClose(database, previousShanghaiDate(tick), tick);
          } catch (error) {
            app.log.error({ err: error }, "finance daily close failed");
          } finally {
            closeRunning = false;
            scheduleNextClose();
          }
        })();
      }, delayMs);
      closeTimer.unref?.();
    };
    scheduleNextClose();
    app.addHook("onClose", async () => {
      if (closeTimer) clearTimeout(closeTimer);
    });
  }
}
