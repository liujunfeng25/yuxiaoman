import { PLATE_CATEGORIES, plateCategory, type PlateCategoryCode } from "../../wechat-miniprogram/miniprogram/utils/plate-categories";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Buildings,
  CalendarCheck,
  Car,
  ChatCenteredText,
  CaretLeft,
  CaretRight,
  CheckCircle,
  CircleNotch,
  ClipboardText,
  CreditCard,
  CurrencyCny,
  FloppyDisk,
  Gauge,
  ListChecks,
  MagnifyingGlass,
  MapPin,
  Plus,
  Receipt,
  ShieldCheck,
  SlidersHorizontal,
  SteeringWheel,
  Student,
  Trash,
  UserCircle,
  Users,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, money } from "./adminApi";
import { operatorErrorMessage } from "./operatorError";
import { AuthenticatedEvidenceImage } from "./AuthenticatedEvidenceImage";
import {
  AccessDeniedPage,
  AuditEventsPage,
  BackofficeAccountBadge,
  BackofficeGate,
  BackofficeSubjectCard,
  ServiceAccountsPage,
  WashProviderDashboard,
  WashProviderSettlementsPage,
  type BackofficeSession,
} from "./BackofficeAdmin";
import { InsuranceLeadsPage } from "./InsuranceLeadsAdmin";
import { CarRentalAdminPage } from "./RentalAdmin";
import { DrivingSchoolAdminPage } from "./DrivingSchoolAdmin";
import { SubsidyConsultationAdminPage } from "./SubsidyConsultationAdmin";
import { WashCatalogPage, WashOrdersPage, WashStoresPage } from "./WashAdmin";
import { ProviderWashCatalogPage, ProviderWashOrdersPage, ProviderWashSlotsPage, ProviderWashStorePage } from "./ProviderWashAdmin";
import { VehicleCheckupReportPanel, type VehicleCatalogIdentity, type VehicleCheckupReport } from "./VehicleCheckupReportPanel";
import { CustomerDetailPage, CustomersPage } from "./CustomerAdmin";
import { WorkflowAdminPage } from "./WorkflowAdmin";

type Page =
  | "bookings"
  | "customers"
  | "customer_detail"
  | "stations"
  | "valet"
  | "price_plans"
  | "wash_orders"
  | "wash_stores"
  | "wash_catalog"
  | "car_rental"
  | "insurance_leads"
  | "driving_schools"
  | "subsidy_consultation"
  | "workflow_tasks"
  | "workflow_settings"
  | "workflow_templates"
  | "workflow_recipients"
  | "workflow_releases"
  | "service_accounts"
  | "audit_events"
  | "wash_dashboard"
  | "wash_slots"
  | "wash_store_profile"
  | "wash_settlements"
  | "audit_self"
  | "forbidden";
type PriceCategory = "fuel_small" | "new_energy_small" | "seven_seat";
type PowertrainType = "gasoline" | "diesel" | "hybrid" | "pure_electric" | "phev" | "erev" | "other" | "unknown";
type InspectionItem =
  | "safety_basic"
  | "safety_chassis_extended"
  | "emissions_gasoline"
  | "emissions_diesel"
  | "new_energy_safety"
  | "reinspection";
type FulfillmentStatus =
  | "pending_payment"
  | "paid_pending_confirmation"
  | "pending_precheck"
  | "precheck_action_required"
  | "precheck_rejected"
  | "confirmed"
  | "driver_arranged"
  | "picked_up"
  | "awaiting_arrival"
  | "checked_in"
  | "inspecting"
  | "result_received"
  | "returning"
  | "completed"
  | "on_hold"
  | "cancelled"
  | "no_show";

type Price = { category: PriceCategory; priceFen: number; updatedAt: string };
type PricePlanLink = { planId: string; isSupported: boolean; priceFen: number };
type DailyPeriod = { start: string; end: string };
type WeeklySchedule = Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", DailyPeriod[]>;
type Station = {
  id: string;
  name: string;
  legalName: string | null;
  district: string;
  address: string;
  latitude: number;
  longitude: number;
  openHours: string;
  phone: string | null;
  isActive: boolean;
  dataKind: "demo" | "real";
  isDirectOperated: boolean;
  isPinned?: boolean;
  sortPriority: number;
  mapPoiId?: string | null;
  weeklySchedule: WeeklySchedule;
  businessHoursNotice?: string | null;
  internalContact?: { name: string; phone: string } | null;
  prices?: Price[];
  pricePlans: PricePlanLink[];
};
type LocationSuggestion = {
  poiId: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  source: "tencent" | "wechat" | "demo";
  locationProof?: string;
};
type LocationSearchState = "idle" | "loading" | "ready" | "empty" | "error";
type StationSlot = {
  id: string;
  stationId: string;
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
  remaining: number;
  bookedCount: number;
};
type PricePlan = {
  id: string;
  plateCategories: PlateCategoryCode[];
  code: string;
  name: string;
  description: string;
  powertrainTypes: PowertrainType[];
  minSeats: number;
  maxSeats: number;
  usageNatures: string[];
  vehicleClassCodes: string[];
  excludeVans: boolean;
  inspectionItems: InspectionItem[];
  sortOrder: number;
  isActive: boolean;
  updatedAt?: string;
};
type LedgerEntry = {
  id: string;
  kind: string;
  amountFen: number;
  description: string;
  confirmationStatus?: "confirmed" | "pending_owner_confirmation" | "voided";
  confirmedAt?: string | null;
  createdAt: string;
};
type Payment = {
  id: string;
  provider: string;
  status: string;
  amountFen: number;
  confirmedAt?: string;
};
type Media = { id: string; kind: string; url: string; width: number; height: number };
type DriverAssignment = {
  id: string;
  status: string;
  receptionistName?: string;
  receptionistPhone?: string;
  driverName: string;
  driverPhone: string;
  assignedAt?: string | null;
  boundAt?: string | null;
  verificationCode?: string | null;
  verificationCodeExpiresAt?: string | null;
  verificationCodeStatus?: "active" | "bound" | "expired" | "completed" | "cancelled" | "unavailable";
};
type EvidenceStage = "owner_pickup" | "station_arrival" | "inspection_complete" | "owner_return";
type EvidencePhoto = {
  id: string;
  kind: "front_left" | "front_right" | "rear_left" | "rear_right" | "dashboard_started";
  url: string;
  width?: number;
  height?: number;
  createdAt?: string;
};
type EvidencePackage = {
  id: string | null;
  stage: EvidenceStage;
  status: "pending" | "completed";
  source?: "uploaded" | "checkup_report";
  capturedAt?: string | null;
  capturedByLabel?: string | null;
  photos: EvidencePhoto[];
};
type PreviewItem = { id: string; kind: string; url: string; width?: number; height?: number };
type PreviewState = { context: string; label: string; items: PreviewItem[]; index: number };
type BookingEvent = {
  id: string;
  bookingId?: string;
  status: string;
  title: string;
  description: string;
  actorType?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};
type Booking = {
  id: string;
  bookingNumber: string;
  status: string;
  fulfillmentStatus?: FulfillmentStatus | "legacy";
  paymentStatus?: "unpaid" | "paid" | "partially_refunded" | "refunded";
  appointmentDate: string;
  startTime: string;
  endTime: string;
  contactName: string;
  contactPhone: string;
  serviceMode: "self_drive" | "valet";
  serviceFeeFen: number;
  inspectionFeeFen: number;
  valetFeeFen: number;
  quoteDistanceKm: number | null;
  oneWayDistanceKm?: number | null;
  extraKm?: number | null;
  quoteExtraKm?: number | null;
  quoteSource?: string;
  tripType?: string | null;
  vehiclePriceCategory: PriceCategory;
  pricingEligibility?: string;
  inspectionItems?: InspectionItem[];
  ruleBaseFeeFen?: number | null;
  ruleIncludedKm?: number | null;
  rulePerKmFen?: number | null;
  ruleScope?: string | null;
  valetRule?: ValetRule | null;
  paymentSummary?: { paidFen: number; refundedFen: number; balanceFen: number };
  chargedFen?: number;
  pendingAdjustmentFen?: number;
  paidFen?: number;
  refundedFen?: number;
  amountDueFen?: number;
  payments?: Payment[];
  ledgerEntries?: LedgerEntry[];
  events?: BookingEvent[];
  precheckServices?: Array<{ id: string; type: string; label: string; status: string }>;
  precheckSlotReleased?: boolean;
  precheck?: {
    resolutionNote?: string | null;
    history?: Array<{ version: number; reasonText: string; reviewerName: string; reviewedAt: string }>;
    status: "pending" | "approved" | "rejected";
    submittedAt: string;
    reviewedAt: string | null;
    reviewerName: string | null;
    reasonCodes: string[];
    reasonText: string | null;
    issuePhotoKinds: string[];
    refundStatus: "not_requested" | "refund_pending" | "refunded" | "refund_failed";
    refundAmountFen: number;
    refundError: string | null;
    version: number;
    reminderDue: boolean;
    overdue: boolean;
    supervision: null | {
      taskId: string;
      status: string;
      policyVersion: number;
      firstReminderAt: string | null;
      dueAt: string | null;
      escalateAt: string | null;
      lastRemindedAt: string | null;
      reminderCount: number;
      escalatedAt: string | null;
      inAppCreatedAt: string | null;
      externalDeliveryStatus: string | null;
      externalAcceptedAt: string | null;
      externalLastErrorCode: string | null;
    };
  } | null;
  refundStatus?: "not_requested" | "refund_pending" | "refunded" | "refund_failed";
  internalDriverNote?: string | null;
  createdAt?: string;
  updatedAt?: string;
  station?: Station;
  vehicle?: { plateNumber: string; vehicleType: string; seats: number; powertrainType?: PowertrainType; brand?: VehicleCatalogIdentity | null; model?: VehicleCatalogIdentity | null };
  pickupAddress?: {
    title: string;
    address: string;
    district: string;
    detail?: string;
    note?: string;
    latitude: number;
    longitude: number;
  } | null;
  media?: Media[];
  driverAssignment?: DriverAssignment | null;
  evidencePackages?: EvidencePackage[];
  evidencePolicyVersion?: string;
  vehicleCheckupReport?: VehicleCheckupReport | null;
};
type ValetRule = {
  id: string;
  baseFeeFen: number;
  includedKm: number;
  perKmFen: number;
  maxRadiusKm: number | null;
  scope?: "global" | "station";
  stationId?: string | null;
  updatedAt: string;
};
type StationValetRule = {
  mode?: "inherit" | "override";
  inheritsGlobal?: boolean;
  inherited?: boolean;
  globalRule?: ValetRule;
  override?: ValetRule | null;
  overrideRule?: ValetRule | null;
  effectiveRule?: ValetRule;
  resolvedRule?: ValetRule;
  rule?: ValetRule;
};

const emptySchedule: WeeklySchedule = {
  mon: [{ start: "08:00", end: "17:00" }],
  tue: [{ start: "08:00", end: "17:00" }],
  wed: [{ start: "08:00", end: "17:00" }],
  thu: [{ start: "08:00", end: "17:00" }],
  fri: [{ start: "08:00", end: "17:00" }],
  sat: [],
  sun: [{ start: "08:00", end: "17:00" }],
};

const categoryLabels: Record<PriceCategory, string> = {
  fuel_small: "燃油小客车",
  new_energy_small: "新能源小客车",
  seven_seat: "7–9 座乘用车",
};
const powertrainLabels: Record<PowertrainType, string> = {
  gasoline: "汽油",
  diesel: "柴油",
  hybrid: "油电混合",
  pure_electric: "纯电",
  phev: "插电混动",
  erev: "增程",
  other: "其他动力",
  unknown: "未确认动力",
};
const inspectionItemLabels: Record<InspectionItem, string> = {
  safety_basic: "基础安全技术检验",
  safety_chassis_extended: "底盘附加项目",
  emissions_gasoline: "汽油排放检验",
  emissions_diesel: "柴油排放检验",
  new_energy_safety: "新能源运行安全服务",
  reinspection: "复检",
};
const mediaLabels: Record<string, string> = {
  vehicle_front_left: "车辆左前",
  vehicle_front_right: "车辆右前",
  vehicle_rear_left: "车辆左后",
  vehicle_rear_right: "车辆右后",
  dashboard_started: "启动后仪表盘",
  license_front: "行驶证正面",
  license_back: "行驶证副页",
};
const evidencePhotoLabels: Record<EvidencePhoto["kind"], string> = {
  front_left: "车辆左前",
  front_right: "车辆右前",
  rear_left: "车辆左后",
  rear_right: "车辆右后",
  dashboard_started: "启动后仪表盘",
};
const evidenceStageMeta: Array<{ stage: EvidenceStage; label: string; owner: string }> = [
  { stage: "owner_pickup", label: "司机取车", owner: "代驾司机" },
  { stage: "station_arrival", label: "检测站接车", owner: "检测站" },
  { stage: "inspection_complete", label: "检测完成", owner: "检测站" },
  { stage: "owner_return", label: "车辆送回", owner: "代驾司机" },
];
const statusLabels: Record<string, string> = {
  pending_payment: "待支付",
  paid_pending_confirmation: "历史待确认（自动恢复）",
  pending_precheck: "待检测站预审",
  precheck_action_required: "预检待处理",
  precheck_rejected: "历史预审未通过",
  refund_pending: "退款处理中",
  refund_failed: "退款失败",
  confirmed: "已确认",
  driver_arranged: "司机已安排",
  picked_up: "已取车",
  awaiting_arrival: "等待到站",
  checked_in: "车辆已到站",
  inspecting: "检测中",
  result_received: "结果已回传",
  returning: "送回中",
  completed: "已完成",
  on_hold: "异常挂起",
  cancelled: "已取消",
  no_show: "未到站",
  legacy: "历史订单",
};
const paymentLabels: Record<string, string> = {
  unpaid: "未支付",
  paid: "已支付（模拟）",
  partially_refunded: "部分退款",
  refunded: "已退款",
};
const deliveryStatusLabels: Record<string, string> = {
  pending: "等待发送",
  processing: "发送处理中",
  retry: "等待重试",
  accepted: "渠道已受理",
  cancelled: "已取消发送",
  dead_letter: "发送失败，待人工处理",
};
const fulfillmentOptions: FulfillmentStatus[] = [
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
];
const bookingFilterOptions = [...fulfillmentOptions, "refund_pending", "refund_failed"] as const;
const dayLabels: Array<[keyof WeeklySchedule, string]> = [
  ["mon", "周一"],
  ["tue", "周二"],
  ["wed", "周三"],
  ["thu", "周四"],
  ["fri", "周五"],
  ["sat", "周六"],
  ["sun", "周日"],
];

function bookingFulfillment(booking: Booking) {
  return booking.fulfillmentStatus && booking.fulfillmentStatus !== "legacy" ? booking.fulfillmentStatus : booking.status;
}

function bookingPaymentText(booking: Booking) {
  if (booking.fulfillmentStatus === "legacy" && !booking.payments?.length) return "历史单·无支付流水";
  return paymentLabels[booking.paymentStatus || "unpaid"];
}

const selfDriveJourney: Array<{ status: FulfillmentStatus; label: string }> = [
  { status: "pending_payment", label: "待支付" },
  { status: "pending_precheck", label: "检测站照片预审" },
  { status: "confirmed", label: "已确认" },
  { status: "awaiting_arrival", label: "待到站" },
  { status: "checked_in", label: "已到站" },
  { status: "inspecting", label: "检测中" },
  { status: "result_received", label: "结果已回传" },
  { status: "completed", label: "已完成" },
];

const valetJourney: Array<{ status: FulfillmentStatus; label: string }> = [
  { status: "pending_payment", label: "待支付" },
  { status: "pending_precheck", label: "检测站照片预审" },
  { status: "confirmed", label: "已确认" },
  { status: "driver_arranged", label: "司机已安排" },
  { status: "picked_up", label: "已取车" },
  { status: "checked_in", label: "已到站" },
  { status: "inspecting", label: "检测中" },
  { status: "result_received", label: "结果已回传" },
  { status: "returning", label: "返程中" },
  { status: "completed", label: "已完成" },
];

function shanghaiTime(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function shanghaiDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  const shifted = new Date(Date.UTC(part("year"), part("month") - 1, part("day") + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function evidencePackagesForBooking(booking: Booking): EvidencePackage[] {
  const packages = [...(booking.evidencePackages ?? [])];
  if (packages.some((item) => item.stage === "inspection_complete")) return packages;
  const report = booking.vehicleCheckupReport;
  if (!report || report.status !== "published") return packages;
  const sitePhotoCandidates: Array<{ kind: EvidencePhoto["kind"]; item: NonNullable<typeof report.sitePhotos.frontLeft> }> = [
    { kind: "front_left", item: report.sitePhotos.frontLeft! },
    { kind: "front_right", item: report.sitePhotos.frontRight! },
    { kind: "rear_left", item: report.sitePhotos.rearLeft! },
    { kind: "rear_right", item: report.sitePhotos.rearRight! },
    { kind: "dashboard_started", item: report.sitePhotos.dashboardStarted! },
  ];
  const sitePhotos = sitePhotoCandidates.filter(({ item }) => Boolean(item));
  if (!sitePhotos.length) return packages;
  packages.push({
    id: `checkup-report-${report.id}`,
    stage: "inspection_complete",
    status: sitePhotos.length === 5 ? "completed" : "pending",
    source: "checkup_report",
    capturedAt: report.publishedAt ?? report.updatedAt,
    capturedByLabel: booking.station?.name || "检测站",
    photos: sitePhotos.map(({ kind, item }) => ({
      id: item.id,
      kind,
      url: item.url,
      width: item.width,
      height: item.height,
      createdAt: item.createdAt,
    })),
  });
  return packages;
}

function holdRestoreStatus(booking: Booking): FulfillmentStatus | null {
  const latest = [...(booking.events ?? [])].reverse().find((event) => event.status === "on_hold");
  const metadata = latest?.metadata;
  const restored = String(metadata?.previousFulfillmentStatus ?? metadata?.previousStatus ?? "");
  if (restored === "legacy") {
    const previousStatus = String(metadata?.previousStatus ?? "");
    return fulfillmentOptions.includes(previousStatus as FulfillmentStatus)
      ? previousStatus as FulfillmentStatus
      : null;
  }
  return fulfillmentOptions.includes(restored as FulfillmentStatus) ? restored as FulfillmentStatus : null;
}

function adminExceptionOptions(booking: Booking, current: FulfillmentStatus): FulfillmentStatus[] {
  if (["completed", "cancelled", "no_show", "precheck_rejected"].includes(current)) return [current];
  if (current === "on_hold") {
    const restore = holdRestoreStatus(booking);
    const canCancel = restore && (booking.serviceMode === "valet"
      ? ["pending_payment", "paid_pending_confirmation", "confirmed", "driver_arranged"].includes(restore)
      : ["pending_payment", "paid_pending_confirmation", "confirmed", "awaiting_arrival"].includes(restore));
    return [current, ...(restore ? [restore] : []), ...(canCancel ? ["cancelled" as FulfillmentStatus] : [])];
  }
  const holdable = booking.serviceMode === "valet"
    ? ["confirmed", "driver_arranged", "picked_up", "checked_in", "inspecting", "result_received", "returning"].includes(current)
    : ["confirmed", "awaiting_arrival", "checked_in", "inspecting", "result_received"].includes(current);
  const canCancel = booking.serviceMode === "valet"
    ? ["pending_payment", "paid_pending_confirmation", "confirmed", "driver_arranged"].includes(current)
    : ["pending_payment", "paid_pending_confirmation", "confirmed", "awaiting_arrival"].includes(current);
  return [
    current,
    ...(holdable ? ["on_hold" as FulfillmentStatus] : []),
    ...(canCancel ? ["cancelled" as FulfillmentStatus] : []),
  ];
}

function bookingMediaCountLabel(booking: Booking, count: number) {
  if (booking.serviceMode === "self_drive" || booking.evidencePolicyVersion === "valet-handoff-v1") return `${count} / 7`;
  if (booking.evidencePolicyVersion === "legacy") return `历史资料 ${count} 张`;
  return `${count} / 7`;
}

function previewItemLabel(context: string, item: PreviewItem) {
  if (context === "预约上传资料") return mediaLabels[item.kind] || "其他预约资料";
  const stageLabel = context.replace("履约留证 · ", "");
  return `${stageLabel}${evidencePhotoLabels[item.kind as EvidencePhoto["kind"]] || "其他留证照片"}`;
}

function shiftPreview(current: PreviewState | null, direction: number): PreviewState | null {
  if (!current || current.items.length === 0) return current;
  const index = (current.index + direction + current.items.length) % current.items.length;
  return { ...current, index, label: previewItemLabel(current.context, current.items[index]) };
}

type JourneyEventRecord = {
  present: boolean;
  occurredAt: string | null;
  timestamp: number | null;
  formatted: string | null;
  invalidTime: boolean;
};

function eventForStatus(booking: Booking, status: FulfillmentStatus): JourneyEventRecord {
  const aliases = status === "confirmed" ? ["confirmed", "paid_pending_confirmation"] : [status];
  const candidates = (booking.events ?? [])
    .filter((item) => aliases.includes(item.status))
    .map((item) => ({ occurredAt: item.createdAt, timestamp: new Date(item.createdAt).getTime() }));
  if (status === "pending_payment" && booking.createdAt) {
    candidates.push({ occurredAt: booking.createdAt, timestamp: new Date(booking.createdAt).getTime() });
  }
  if (!candidates.length) return { present: false, occurredAt: null, timestamp: null, formatted: null, invalidTime: false };
  const valid = candidates.filter((item) => Number.isFinite(item.timestamp)).sort((left, right) => left.timestamp - right.timestamp);
  const selected = valid[0] ?? candidates[0];
  const invalidTime = !Number.isFinite(selected.timestamp);
  return {
    present: true,
    occurredAt: selected.occurredAt,
    timestamp: invalidTime ? null : selected.timestamp,
    formatted: invalidTime ? null : shanghaiTime(selected.occurredAt),
    invalidTime,
  };
}

function normalizedJourneyStatus(booking: Booking) {
  const status = bookingFulfillment(booking);
  return status === "paid_pending_confirmation" ? "confirmed" : status;
}

function BookingJourney({ booking }: { booking: Booking }) {
  const steps = booking.serviceMode === "valet" ? valetJourney : selfDriveJourney;
  const currentStatus = normalizedJourneyStatus(booking);
  const currentIndex = steps.findIndex((step) => step.status === currentStatus);
  const exceptional = ["on_hold", "cancelled", "no_show", "precheck_rejected"].includes(currentStatus);
  const records = steps.map((step) => eventForStatus(booking, step.status));
  const anomalyIndexes = new Set<number>();
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  records.forEach((record, index) => {
    if (record.invalidTime) anomalyIndexes.add(index);
    if (record.timestamp !== null) {
      if (record.timestamp < latestTimestamp) anomalyIndexes.add(index);
      latestTimestamp = Math.max(latestTimestamp, record.timestamp);
    }
    if (!exceptional && currentIndex >= 0 && index > currentIndex && record.present) anomalyIndexes.add(index);
  });
  const inferredWithoutEventCount = exceptional || currentIndex < 0
    ? 0
    : records.filter((record, index) => index < currentIndex && !record.present).length;
  return <section className="detail-section booking-journey" aria-label="履约全景">
    <header><div><small>履约流程</small><h3>履约全景 / 业务流状态机</h3></div><span className={`service-mode-tag ${booking.serviceMode}`}>{booking.serviceMode === "valet" ? "代驾往返取送" : "车主自驾到站"}</span></header>
    <ol>{steps.map((step, index) => {
      const record = records[index];
      const isCurrent = step.status === currentStatus;
      const inferredPassed = !exceptional && currentIndex >= 0 && index < currentIndex && !record.present;
      const futureRecord = !exceptional && currentIndex >= 0 && index > currentIndex && record.present;
      const anomalous = anomalyIndexes.has(index);
      const isDone = !futureRecord && record.present && (!isCurrent || step.status === "completed");
      const detail = record.invalidTime
        ? "存在节点记录 · 时间格式异常"
        : futureRecord
          ? `存在超前记录 · ${record.formatted || "时间未记录"}`
          : anomalous
            ? `记录时间顺序异常 · ${record.formatted || "时间未记录"}`
            : record.formatted
              ? record.formatted
              : isCurrent
                ? "当前节点 · 未记录时间"
                : inferredPassed
                  ? "流程已越过 · 未记录节点事件"
                  : "待进行";
      return <li key={step.status} data-status={step.status} className={`${isDone ? "done" : ""} ${isCurrent ? "current" : ""} ${inferredPassed ? "inferred" : ""} ${anomalous ? "anomalous" : ""}`}><span>{anomalous ? <WarningCircle weight="fill" /> : isDone ? <CheckCircle weight="fill" /> : <CircleNotch />}</span><div><strong>{step.label}</strong><small>{detail}</small></div></li>;
    })}</ol>
    {anomalyIndexes.size ? <p className="journey-data-warning" role="alert"><WarningCircle weight="fill" />检测到节点时间倒序、格式异常或超前状态记录。页面按服务端原始记录展示，不自动改写时间或推断业务已完成。</p> : null}
    {inferredWithoutEventCount ? <p className="journey-data-note"><CircleNotch />有 {inferredWithoutEventCount} 个已越过节点缺少独立事件记录，仅根据当前状态标示“流程已越过”，不会补造完成时间。</p> : null}
    {exceptional ? <p className="journey-exception"><WarningCircle weight="fill" />当前业务处于“{statusLabels[currentStatus] || "待人工核对"}”，请结合事件记录处理；正常链路节点仍保留原始时间。</p> : null}
  </section>;
}

function metadataText(events: BookingEvent[] | undefined, keys: string[]) {
  for (const event of [...(events ?? [])].reverse()) {
    for (const key of keys) {
      const value = event.metadata?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function ServiceFulfillmentSnapshot({ booking }: { booking: Booking }) {
  const driverName = booking.driverAssignment?.driverName || metadataText(booking.events, ["driverName", "driver_name"]);
  const driverPhone = booking.driverAssignment?.driverPhone || metadataText(booking.events, ["driverPhone", "driver_phone"]);
  const dispatcherName = metadataText(booking.events, ["dispatcherName", "dispatcher_name", "coordinatorName"]);
  const dispatcherPhone = metadataText(booking.events, ["dispatcherPhone", "dispatcher_phone", "coordinatorPhone"]);
  const driverHasBeenArranged = valetJourney.findIndex((step) => step.status === normalizedJourneyStatus(booking)) >= valetJourney.findIndex((step) => step.status === "driver_arranged")
    || Boolean(booking.events?.some((event) => event.status === "driver_arranged"));
  if (booking.serviceMode === "self_drive") {
    return <section className="detail-section service-fulfillment-snapshot self-drive-snapshot" aria-label="自驾到站服务信息">
      <header><div><small>服务方式</small><h3>自驾到站信息</h3></div><span className="service-mode-tag self_drive"><Car weight="fill" />车主自驾</span></header>
      <div className="service-snapshot-address"><MapPin weight="duotone" /><span><small>到站站点</small><strong>{booking.station?.name || "检测站未回传"}</strong><em>{booking.station?.address || booking.station?.district || "站点地址未回传"}</em></span></div>
      <dl><div><dt>到站联系人</dt><dd>{booking.contactName} · {booking.contactPhone}</dd></div><div><dt>预约时段</dt><dd>{booking.appointmentDate} {booking.startTime}–{booking.endTime}</dd></div></dl>
    </section>;
  }
  const pickup = booking.pickupAddress;
  return <section className="detail-section service-fulfillment-snapshot valet-snapshot" aria-label="代驾取送服务信息">
    <header><div><small>代驾履约</small><h3>代驾取送履约信息</h3></div><span className="service-mode-tag valet"><SteeringWheel weight="fill" />往返取送</span></header>
    <div className="service-snapshot-address"><MapPin weight="duotone" /><span><small>取车并送回同一地址</small><strong>{pickup ? `${pickup.title}${pickup.detail ? ` · ${pickup.detail}` : ""}` : "取送地址未回传"}</strong><em>{pickup?.address || "请核对原始订单地址快照"}</em>{pickup?.note ? <b>备注：{pickup.note}</b> : null}</span></div>
    <div className="valet-people-grid"><article><small>车主联系人</small><strong>{booking.contactName}</strong><span>{booking.contactPhone}</span></article><article><small>执行司机</small><strong>{driverName || (driverHasBeenArranged ? "司机信息未回传" : "司机尚未安排")}</strong><span>{driverPhone || (driverHasBeenArranged ? "请向调度核实联系方式" : "待调度安排")}</span></article><article><small>调度人员</small><strong>{dispatcherName || "调度人员未记录"}</strong><span>{dispatcherPhone || "联系电话未记录"}</span></article><article><small>送检站点</small><strong>{booking.station?.name || "检测站未回传"}</strong><span>{booking.station?.address || booking.station?.district || "站点地址未回传"}</span></article></div>
    <div className="dispatch-note"><SteeringWheel /><span><small>司机 / 调度备注</small><strong>{booking.internalDriverNote || "暂无司机与调度备注"}</strong></span></div>
  </section>;
}

const precheckReasonLabels: Record<string, string> = {
  license_unclear: "行驶证模糊或缺页",
  vehicle_photos_incomplete: "车辆照片不完整或不清晰",
  vehicle_information_mismatch: "车牌或车辆信息不一致",
  booking_information_mismatch: "预约车型、动力或用途不一致",
  materials_cannot_be_verified: "现有资料无法完成核对",
  body_dirty: "车身脏污", body_damage: "车损需处理", dashboard_warning: "仪表盘故障灯",
  other: "其他",
};
const precheckPhotoLabels: Record<string, string> = {
  license_front: "行驶证正页", license_back: "行驶证副页", vehicle_front_left: "车辆左前",
  vehicle_front_right: "车辆右前", vehicle_rear_left: "车辆左后", vehicle_rear_right: "车辆右后",
  dashboard_started: "启动后仪表盘",
};

function PrecheckAuditPanel({ booking, onRetryRefund, retrying = false }: { booking: Booking; onRetryRefund?: () => void; retrying?: boolean }) {
  const precheck = booking.precheck;
  if (!precheck) return null;
  const fulfillmentStatus = bookingFulfillment(booking);
  const statusText = fulfillmentStatus === "precheck_action_required" ? "预检待车主处理" : precheck.status === "pending" && fulfillmentStatus === "cancelled"
    ? "车主已取消，预审终止"
    : precheck.status === "pending" ? "待检测站预审" : precheck.status === "approved" ? "预审已通过" : "预审未通过";
  const refundText = precheck.refundStatus === "refunded" ? "模拟退款已完成" : precheck.refundStatus === "refund_pending" ? "退款处理中" : precheck.refundStatus === "refund_failed" ? "退款失败，待平台处理" : "未发起退款";
  const supervision = precheck.supervision;
  const timingText = !supervision
    ? "历史订单未启用督办"
    : supervision.status !== "open"
      ? "节点待办已关闭"
      : precheck.overdue
        ? `已超时 · 截止 ${shanghaiTime(supervision.dueAt) || "时间待记录"}`
        : supervision.lastRemindedAt
          ? `已提醒 ${supervision.reminderCount} 次 · 截止 ${shanghaiTime(supervision.dueAt) || "未设截止"}`
          : supervision.firstReminderAt
            ? `首次提醒 ${shanghaiTime(supervision.firstReminderAt)}`
            : "已创建站内待办";
  return <section className={`detail-section precheck-audit-panel ${precheck.status}`} aria-label="检测站预约资料预审">
    <header><div><small>预约资料审核</small><h3>检测站预约资料预审</h3></div><span className={`status-pill status-${fulfillmentStatus}`}>{statusText}</span></header>
    {fulfillmentStatus === "precheck_action_required" ? <p className="journey-data-warning">订单与已付款保留，原时段已释放。车主处理后选择本站时段重新提交；退款只能由车主主动申请。车损与故障灯进入维修报价，脏污进入洗车预约。</p> : null}
    <dl>
      <div><dt>支付提交时间</dt><dd>{shanghaiTime(precheck.submittedAt) || "时间待记录"}</dd></div>
      <div><dt>督办状态</dt><dd>{timingText}</dd></div>
      {supervision ? <div><dt>策略与投递</dt><dd>第 {supervision.policyVersion} 版 · {supervision.externalDeliveryStatus ? `外发：${deliveryStatusLabels[supervision.externalDeliveryStatus] || "状态待核对"}` : supervision.inAppCreatedAt ? "站内消息已生成" : "待触发提醒"}</dd></div> : null}
      {precheck.reviewerName ? <div><dt>审核人员</dt><dd>{precheck.reviewerName} · {shanghaiTime(precheck.reviewedAt) || "时间待记录"}</dd></div> : null}
      {precheck.reasonCodes.length ? <div><dt>问题类型</dt><dd>{precheck.reasonCodes.map((code) => precheckReasonLabels[code] || "其他待核对问题").join("、")}</dd></div> : null}
      {precheck.issuePhotoKinds.length ? <div><dt>涉及照片</dt><dd>{precheck.issuePhotoKinds.map((kind) => precheckPhotoLabels[kind] || "其他资料照片").join("、")}</dd></div> : null}
      {precheck.reasonText ? <div className="wide"><dt>具体说明</dt><dd>{precheck.reasonText}</dd></div> : null}
      {precheck.resolutionNote ? <div className="wide"><dt>车主处理说明</dt><dd>{precheck.resolutionNote}</dd></div> : null}
      {precheck.status === "rejected" ? <div><dt>退款状态</dt><dd>{refundText} · ¥{money(precheck.refundAmountFen)}</dd></div> : null}
    </dl>
    {precheck.refundStatus === "refund_failed" ? <div className="precheck-refund-failed"><p className="journey-data-warning"><WarningCircle weight="fill" />退款失败，需要平台管理员核对支付通道后重试；订单不会恢复履约。</p><button type="button" disabled={retrying} onClick={onRetryRefund}><ArrowCounterClockwise />{retrying ? "重试中…" : "重试全额退款"}</button></div> : null}
  </section>;
}

type DriverAssignmentMutation = {
  assignment: DriverAssignment;
  taskCode?: null;
  entryPath?: null;
  driverEntryPath?: string | null;
};

function driverVerificationCode(value: string | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

function groupedDriverVerificationCode(value: string) {
  return `${value.slice(0, 3)} ${value.slice(3)}`;
}

function DriverAssignmentPanel({ booking, refresh, onError }: { booking: Booking; refresh: () => void; onError: (message: string) => void }) {
  const assignment = booking.driverAssignment ?? null;
  const assignmentActive = Boolean(assignment && ["assigned", "bound", "in_progress"].includes(assignment.status));
  const initialReceptionistName = assignment?.receptionistName || assignment?.driverName || "";
  const initialReceptionistPhone = assignment?.receptionistPhone || assignment?.driverPhone || "";
  const [receptionistName, setReceptionistName] = useState(initialReceptionistName);
  const [receptionistPhone, setReceptionistPhone] = useState(initialReceptionistPhone);
  const [latestVerificationCode, setLatestVerificationCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setReceptionistName(assignment?.receptionistName || assignment?.driverName || "");
    setReceptionistPhone(assignment?.receptionistPhone || assignment?.driverPhone || "");
    setLatestVerificationCode(driverVerificationCode(assignment?.verificationCode));
  }, [booking.id, assignment?.id, assignment?.receptionistName, assignment?.receptionistPhone, assignment?.driverName, assignment?.driverPhone, assignment?.verificationCode]);

  const generate = async () => {
    const normalizedName = receptionistName.trim();
    const normalizedPhone = receptionistPhone.replace(/\s+/g, "");
    if (normalizedName.length < 2) {
      onError("请填写至少两个字的接待人员姓名");
      return;
    }
    if (!/^1\d{10}$/.test(normalizedPhone)) {
      onError("请填写有效的11位接待人员手机号");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await api<DriverAssignmentMutation>(`/admin/bookings/${booking.id}/driver-assignment`, {
        method: "POST",
        body: JSON.stringify({ receptionistName: normalizedName, receptionistPhone: normalizedPhone }),
      });
      setLatestVerificationCode(driverVerificationCode(result.assignment.verificationCode));
      setMessage(assignmentActive ? "取车任务验证码已重新生成，旧验证码已失效" : "接待人已安排，取车任务验证码已生成（可发群抢单）");
      refresh();
    } catch (error) {
      onError(operatorErrorMessage(error, "接待人安排失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!assignment || !assignmentActive) return;
    setBusy(true);
    setMessage("");
    try {
      await api(`/admin/bookings/${booking.id}/driver-assignment`, { method: "DELETE" });
      setLatestVerificationCode(null);
      setMessage("取车任务验证码已失效，订单已恢复为等待安排接待人");
      refresh();
    } catch (error) {
      onError(operatorErrorMessage(error, "接待人安排撤销失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  const copyVerificationCode = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setMessage("6位取车任务验证码已复制");
    } catch {
      onError("浏览器未允许复制，请手动记录6位验证码");
    }
  };

  if (booking.evidencePolicyVersion === "legacy") {
    return <section className="detail-section driver-assignment-panel legacy-evidence-notice" aria-label="接待人安排">
      <header><div><small>历史订单</small><h3>历史代驾订单</h3></div><span className="assignment-status inactive">历史口径</span></header>
      <p><WarningCircle weight="fill" />该订单创建于取车任务验证码上线前，继续保留原线下安排记录，后台不会补发或伪造取车任务。</p>
    </section>;
  }

  const fulfillmentStage = booking.fulfillmentStatus && booking.fulfillmentStatus !== "legacy" ? booking.fulfillmentStatus : booking.status;
  const assignmentEditable = ["confirmed", "driver_arranged"].includes(fulfillmentStage);
  const codeStatus = assignment?.verificationCodeStatus
    ?? (assignment?.boundAt ? "bound" : assignmentActive ? "active" : assignment ? "unavailable" : null);
  const taskEnded = ["completed", "cancelled"].includes(fulfillmentStage)
    || codeStatus === "completed"
    || codeStatus === "cancelled";
  const verificationCode = taskEnded
    ? null
    : driverVerificationCode(latestVerificationCode ?? assignment?.verificationCode);
  const assignmentStatusLabel = taskEnded
    ? "任务已结束"
    : codeStatus === "bound"
      ? "已绑定"
      : codeStatus === "expired"
        ? "验证码已过期"
        : codeStatus === "active"
          ? "验证码有效"
          : assignment
            ? "验证码不可用"
            : "尚未安排";
  const codeUsageText = codeStatus === "bound"
    ? "已绑定，仅原微信可继续使用"
    : codeStatus === "expired"
      ? "首次领取有效期已结束，请重新生成验证码"
      : codeStatus === "active"
        ? `24小时内首次领取${assignment?.verificationCodeExpiresAt ? ` · 有效至 ${shanghaiTime(assignment.verificationCodeExpiresAt) || "时间未记录"}` : ""}`
        : "验证码当前不可领取";
  const shownReceptionistName = assignment?.receptionistName || assignment?.driverName || "";
  const shownReceptionistPhone = assignment?.receptionistPhone || assignment?.driverPhone || "";
  return <section className="detail-section driver-assignment-panel" aria-label="接待人安排">
    <header><div><small>取车任务入口</small><h3>取车任务验证码（发群抢单）</h3></div><span className={`assignment-status ${codeStatus === "active" || codeStatus === "bound" ? "active" : "inactive"}`}>{assignmentStatusLabel}</span></header>
    <div className="driver-assignment-fields">
      <label><span>接待人员姓名</span><input aria-label="接待人员姓名" value={receptionistName} maxLength={30} onChange={(event) => setReceptionistName(event.target.value)} placeholder="例如：站务小刘" disabled={busy || !assignmentEditable} /></label>
      <label><span>接待人员电话</span><input aria-label="接待人员电话" value={receptionistPhone} inputMode="numeric" maxLength={11} onChange={(event) => setReceptionistPhone(event.target.value)} placeholder="11位手机号" disabled={busy || !assignmentEditable} /></label>
    </div>
    {assignment ? <div className="assignment-snapshot">
      <span><UserCircle weight="duotone" /><small>当前接待人</small><strong>{shownReceptionistName} · {shownReceptionistPhone}</strong></span>
      <span><CalendarCheck weight="duotone" /><small>安排时间</small><strong>{shanghaiTime(assignment.assignedAt) || "时间未记录"}</strong></span>
      <span><ShieldCheck weight="duotone" /><small>任务领取</small><strong>{assignment.boundAt ? `已绑定 · ${shanghaiTime(assignment.boundAt)}` : codeStatus === "expired" ? "验证码已过期" : "等待代驾输入验证码抢单"}</strong></span>
    </div> : null}
    {verificationCode ? <div className={`driver-verification-panel ${codeStatus || "unavailable"}`} aria-label="取车任务验证码">
      <div className="driver-verification-copy"><small>代驾进入小程序代驾端后输入</small><strong aria-label={`取车任务验证码 ${verificationCode}`}>{groupedDriverVerificationCode(verificationCode)}</strong><em>{codeUsageText}</em></div>
      <button type="button" aria-label="复制取车任务验证码" onClick={() => void copyVerificationCode(verificationCode)}><ClipboardText />复制验证码</button>
    </div> : assignmentActive && !taskEnded ? <p className="assignment-security-note">验证码暂不可用，请刷新详情；如已过期，可重新生成，旧验证码会立即失效。</p> : null}
    <div className="driver-assignment-actions">
      <button type="button" className="primary" disabled={busy || !assignmentEditable} onClick={() => void generate()}><SteeringWheel />{busy ? "处理中…" : assignmentActive ? "重新生成验证码" : "安排接待人并生成验证码"}</button>
      {assignmentActive ? <button type="button" className="revoke" disabled={busy || !assignmentEditable} onClick={() => void revoke()}><Trash />使当前验证码失效</button> : null}
    </div>
    {!assignmentEditable && !taskEnded ? <p className="assignment-security-note">车辆已进入现场履约，接待人安排和验证码绑定已锁定，后台不能中途换人或撤销。</p> : null}
    {message ? <p className="assignment-success" role="status"><CheckCircle weight="fill" />{message}</p> : null}
    <p className="assignment-boundary"><ShieldCheck />生成验证码会自动推进到“任务已安排”；验证码首次领取后绑定代驾微信，取车、到站和送回必须由对应端完成留证，后台不能代替推进。</p>
  </section>;
}

function FulfillmentEvidencePanel({ booking, onPreview }: { booking: Booking; onPreview: (stageLabel: string, photos: EvidencePhoto[], index: number, trigger: HTMLButtonElement) => void }) {
  if (booking.evidencePolicyVersion === "legacy") {
    return <section className="detail-section fulfillment-evidence legacy-evidence-notice" aria-label="代驾履约留证">
      <header><div><small>履约留证</small><h3>四阶段履约留证</h3></div><span>历史订单</span></header>
      <p><WarningCircle weight="fill" />该历史订单未启用四阶段留证规则，系统不会补造取车、到站、检测完成或送回照片。</p>
    </section>;
  }
  const packages = evidencePackagesForBooking(booking);
  const completedCount = evidenceStageMeta.filter(({ stage }) => packages.some((item) => item.stage === stage && item.status === "completed" && item.photos.length === 5)).length;
  return <section className="detail-section fulfillment-evidence" aria-label="代驾履约留证">
    <header><div><small>履约留证</small><h3>四阶段履约留证</h3></div><span>{completedCount} / 4 阶段完整</span></header>
    <p className="evidence-intro">按取车、检测站接车、检测完成和送回归档。客户与后台查看同一份留证；无需客户确认，不提供后台补拍。</p>
    <div className="evidence-stage-grid">
      {evidenceStageMeta.map((meta, index) => {
        const item = packages.find((candidate) => candidate.stage === meta.stage);
        const count = item?.photos.length ?? 0;
        const complete = item?.status === "completed" && count === 5;
        const reportSource = item?.source === "checkup_report" || item?.id?.startsWith("checkup-report-") || (meta.stage === "inspection_complete" && booking.vehicleCheckupReport?.status === "published");
        return <article key={meta.stage} data-evidence-stage={meta.stage} className={complete ? "complete" : count ? "pending" : "empty"}>
          <header><span>{complete ? <CheckCircle weight="fill" /> : index + 1}</span><div><strong>{meta.label}</strong><small>{complete ? "留证已完成" : count ? "留证上传中" : "待业务节点留证"}</small></div><em>{count} / 5</em></header>
          <p>{item?.capturedByLabel || meta.owner} · {shanghaiTime(item?.capturedAt) || "时间待记录"}</p>
          {reportSource ? <div className="evidence-source"><ShieldCheck />复用车辆体检报告现场影像，不重复拍摄</div> : null}
          {count ? <div className="evidence-photo-grid">
            {item!.photos.map((photo, photoIndex) => <button type="button" key={photo.id} aria-label={`查看${meta.label}${evidencePhotoLabels[photo.kind]}大图`} onClick={(event) => onPreview(meta.label, item!.photos, photoIndex, event.currentTarget)}><AuthenticatedEvidenceImage url={photo.url} alt={`${meta.label}${evidencePhotoLabels[photo.kind]}`} /><span>{evidencePhotoLabels[photo.kind]}</span></button>)}
          </div> : <div className="evidence-empty"><CircleNotch /><span>由{meta.owner}现场拍摄并自动推进</span></div>}
        </article>;
      })}
    </div>
    <p className="evidence-role-note"><ShieldCheck />司机负责取车与送回；检测站负责到站与检测完成。检测站不能替司机完成送回。</p>
  </section>;
}

function splitList(value: string) {
  return value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
}

function cloneStation(station: Station): Station {
  return JSON.parse(JSON.stringify(station)) as Station;
}

function newStation(pricePlans: PricePlan[]): Station {
  return {
    id: "",
    name: "",
    legalName: null,
    district: "",
    address: "",
    latitude: 0,
    longitude: 0,
    openHours: "08:00-17:00",
    phone: null,
    isActive: false,
    dataKind: "demo",
    isDirectOperated: false,
    isPinned: false,
    sortPriority: 0,
    mapPoiId: null,
    weeklySchedule: JSON.parse(JSON.stringify(emptySchedule)) as WeeklySchedule,
    businessHoursNotice: "新建演示站点；正式启用前请核验主体、地图位置和营业时间",
    internalContact: null,
    pricePlans: pricePlans.map((plan) => ({ planId: plan.id, isSupported: false, priceFen: 0 })),
  };
}

function emptyPricePlan(): PricePlan {
  return {
    id: "",
    code: "",
    name: "",
    description: "",
    powertrainTypes: ["gasoline"],
    minSeats: 1,
    maxSeats: 6,
    usageNatures: ["非营运"],
    plateCategories: ["blue_small_passenger", "new_energy_small_passenger"],
    vehicleClassCodes: ["passenger_car"],
    excludeVans: true,
    inspectionItems: ["safety_basic", "emissions_gasoline"],
    sortOrder: 0,
    isActive: true,
  };
}

const pagePaths: Record<Page, string> = {
  bookings: "/bookings",
  customers: "/customers",
  customer_detail: "/customers",
  stations: "/stations",
  price_plans: "/inspection-price-plans",
  valet: "/valet-pricing",
  wash_orders: "/wash/orders",
  wash_stores: "/wash/stores",
  wash_catalog: "/wash/catalog",
  car_rental: "/car-rental",
  insurance_leads: "/insurance",
  driving_schools: "/driving-schools",
  subsidy_consultation: "/subsidy-consultation",
  workflow_tasks: "/workflow",
  workflow_settings: "/workflow/settings",
  workflow_templates: "/workflow/templates",
  workflow_recipients: "/workflow/recipients",
  workflow_releases: "/workflow/releases",
  service_accounts: "/service-accounts",
  audit_events: "/audit",
  wash_dashboard: "/wash/dashboard",
  wash_slots: "/wash/slots",
  wash_store_profile: "/wash/store",
  wash_settlements: "/wash/settlements",
  audit_self: "/my-audit",
  forbidden: "/forbidden",
};

function pageFromPath(pathname: string): Page {
  if (/^\/customers\/[^/]+\/?$/.test(pathname)) return "customer_detail";
  const match = (Object.entries(pagePaths) as Array<[Page, string]>).find(([, path]) => path === pathname);
  return match?.[0] ?? "forbidden";
}

export default function App() {
  return <BackofficeGate>{(session, logout) => <OperationsApp session={session} logout={logout} />}</BackofficeGate>;
}

function OperationsApp({ session, logout }: { session: BackofficeSession; logout: () => Promise<void> }) {
  const providerMode = session.account.role === "wash_store_admin";
  const stationMode = session.account.role === "inspection_station_admin";
  const repairMode = session.account.role === "repair_shop_admin";
  const scopedMode = providerMode || stationMode || repairMode;
  const defaultPage: Page = providerMode ? "wash_dashboard" : stationMode || repairMode ? "audit_self" : "bookings";
  const [page, setPage] = useState<Page>(() => window.location.pathname === "/" ? defaultPage : pageFromPath(window.location.pathname));
  const [stations, setStations] = useState<Station[]>([]);
  const [pricePlans, setPricePlans] = useState<PricePlan[]>([]);
  const [error, setError] = useState("");
  const [apiOnline, setApiOnline] = useState(true);
  const showError = useCallback((reason: unknown) => setError(operatorErrorMessage(reason)), []);
  const loadStations = () => api<Station[]>("/admin/stations").then((items) => { setStations(items); setApiOnline(true); }).catch((reason) => { setApiOnline(false); setError(operatorErrorMessage(reason, "检测站资料读取失败，请稍后重试")); throw reason; });
  const loadPricePlans = () => api<PricePlan[]>("/admin/inspection-price-plans").then((items) => { setPricePlans(items); setApiOnline(true); }).catch((reason) => { setApiOnline(false); setError(operatorErrorMessage(reason, "检验价格方案读取失败，请稍后重试")); throw reason; });
  useEffect(() => {
    if (!scopedMode) void Promise.all([loadStations(), loadPricePlans()]).catch(() => undefined);
  }, [scopedMode]);
  useEffect(() => {
    const handleHistory = () => setPage(window.location.pathname === "/" ? defaultPage : pageFromPath(window.location.pathname));
    window.addEventListener("popstate", handleHistory);
    return () => window.removeEventListener("popstate", handleHistory);
  }, [defaultPage]);
  const platformNavigation: Array<[Page, string, typeof ClipboardText]> = [
    ["bookings", "预约履约", ClipboardText],
    ["customers", "客户中心", Users],
    ["stations", "站点配置", Buildings],
    ["price_plans", "检验价格方案", ListChecks],
    ["valet", "取送计价规则", SteeringWheel],
    ["wash_orders", "洗车订单", Receipt],
    ["wash_stores", "洗车门店", Buildings],
    ["wash_catalog", "洗车套餐与价格", CurrencyCny],
    ["car_rental", "汽车租赁", Car],
    ["insurance_leads", "车险线索", ShieldCheck],
    ["driving_schools", "驾校服务", Student],
    ["subsidy_consultation", "补贴咨询", ChatCenteredText],
    ["workflow_tasks", "履约督办", Gauge],
    ["workflow_settings", "督办策略", SlidersHorizontal],
    ["workflow_templates", "通知模板", ChatCenteredText],
    ["workflow_recipients", "通知联系人", Users],
    ["workflow_releases", "发布记录", ShieldCheck],
    ["service_accounts", "服务商账号", Users],
    ["audit_events", "操作记录", ShieldCheck],
  ];
  const providerNavigation: Array<[Page, string, typeof ClipboardText]> = [
    ["wash_dashboard", "工作台", Gauge],
    ["wash_orders", "订单与核销", Receipt],
    ["wash_slots", "预约时段", CalendarCheck],
    ["wash_catalog", "套餐与价格", CurrencyCny],
    ["wash_store_profile", "门店资料", Buildings],
    ["wash_settlements", "对账记录", ListChecks],
    ["audit_self", "我的操作记录", ShieldCheck],
  ];
  const stationNavigation: Array<[Page, string, typeof ClipboardText]> = [
    ["workflow_tasks", "本主体待办", Gauge],
    ["workflow_settings", "生效督办规则", SlidersHorizontal],
    ["audit_self", "我的操作记录", ShieldCheck],
  ];
  const navigation = providerMode ? providerNavigation : stationMode || repairMode ? stationNavigation : platformNavigation;
  const titles: Record<Page, string> = {
    bookings: "预约交易与履约中心",
    customers: "客户中心与全业务视图",
    customer_detail: "客户 360 档案",
    stations: "检测站与服务能力",
    price_plans: "受控车型与检验价格方案",
    valet: "上门往返取送计价",
    wash_orders: "洗车订单与人工核销",
    wash_stores: "洗车门店与预约产能",
    wash_catalog: "洗车套餐与门店价格",
    car_rental: "汽车租赁供给、价格与履约",
    insurance_leads: "车险线索与合规转交",
    driving_schools: "驾校服务资料、报价与咨询",
    subsidy_consultation: "补贴咨询与价格维护",
    workflow_tasks: "履约督办与通知中心",
    workflow_settings: "督办策略",
    workflow_templates: "通知模板",
    workflow_recipients: "通知联系人和值班组",
    workflow_releases: "发布与审计记录",
    service_accounts: "服务商账号与主体绑定",
    audit_events: "操作记录",
    wash_dashboard: "洗车门店经营工作台",
    wash_slots: "本店预约时段与容量",
    wash_store_profile: "本店主体与展示资料",
    wash_settlements: "本店只读对账记录",
    audit_self: "我的操作记录",
    forbidden: "无权访问",
  };
  const platformOnlyPages: Page[] = ["bookings", "customers", "customer_detail", "stations", "price_plans", "valet", "wash_stores", "car_rental", "insurance_leads", "driving_schools", "subsidy_consultation", "workflow_templates", "workflow_recipients", "workflow_releases", "service_accounts", "audit_events"];
  const providerCapabilities: Partial<Record<Page, string>> = {
    wash_dashboard: "wash.dashboard.read", wash_orders: "wash.orders.read", wash_slots: "wash.slots.read", wash_catalog: "wash.offers.read",
    wash_store_profile: "wash.store.read", wash_settlements: "wash.settlements.read", audit_self: "audit.self.read",
    workflow_tasks: "workflow.tasks.read", workflow_settings: "workflow.tasks.read",
  };
  const allowed = page !== "forbidden" && (!scopedMode || (!platformOnlyPages.includes(page) && Boolean(providerCapabilities[page] && session.capabilities.includes(providerCapabilities[page]!))));
  const navigate = (next: Page | string) => {
    const nextPage = typeof next === "string" && next.startsWith("/") ? pageFromPath(new URL(next, window.location.origin).pathname) : next as Page;
    const target = typeof next === "string" && next.startsWith("/") ? next : pagePaths[nextPage];
    window.history.pushState({}, "", target);
    setPage(nextPage);
  };
  const customerId = page === "customer_detail" ? decodeURIComponent(window.location.pathname.replace(/^\/customers\//, "").replace(/\/$/, "")) : "";
  return <div className="admin-shell">
    <aside className={`sidebar ${scopedMode ? "provider-sidebar" : ""}`}>
      <div className="admin-brand"><span><Car weight="fill" /></span><div><strong>驭小满</strong><small>{stationMode ? "检测站账号中心" : repairMode ? "维修门店账号中心" : providerMode ? "服务商经营后台" : "运营管理后台"}</small></div></div>
      {scopedMode ? <BackofficeSubjectCard session={session} /> : null}
      <nav>{navigation.map(([value, label, Icon]) => <button key={value} className={page === value || (value === "customers" && page === "customer_detail") ? "active" : ""} onClick={() => navigate(value)}><Icon size={20} /><span>{label}</span><CaretRight size={14} /></button>)}</nav>
      <div className="demo-admin"><ShieldCheck size={20} /><div><strong>{scopedMode ? "单主体数据空间" : "平台全局数据空间"}</strong><small>{scopedMode ? "仅当前主体 · 服务端强制隔离" : "全部模块 · 全部经营主体"}</small></div></div>
    </aside>
    <main className="admin-main">
      <header className="topbar"><div><small>{stationMode ? "检测站工作台" : repairMode ? "维修门店工作台" : providerMode ? "服务门店工作台" : "驭小满运营后台"}</small><h1>{titles[page]}</h1></div><div className="topbar-actions"><span className={`system-state ${apiOnline ? "" : "offline"}`}><i />{apiOnline ? "安全会话已连接" : "后台服务未连接"}</span><BackofficeAccountBadge session={session} logout={logout} /></div></header>
      {error ? <div className="admin-alert"><WarningCircle />{error}<button onClick={() => setError("")}><X /></button></div> : null}
      {!allowed ? <AccessDeniedPage home={() => navigate(defaultPage)} /> : null}
      {allowed && page === "bookings" ? <BookingsPage stations={stations} onError={showError} /> : null}
      {allowed && page === "customers" ? <CustomersPage onNavigate={navigate} onError={showError} /> : null}
      {allowed && page === "customer_detail" ? <CustomerDetailPage customerId={customerId} onNavigate={navigate} onError={showError} /> : null}
      {allowed && page === "stations" ? <StationsPage stations={stations} pricePlans={pricePlans} reload={loadStations} onError={showError} /> : null}
      {allowed && page === "price_plans" ? <PricePlansPage plans={pricePlans} reload={() => Promise.all([loadPricePlans(), loadStations()]).then(() => undefined)} onError={showError} /> : null}
      {allowed && page === "valet" ? <ValetPage stations={stations} onError={showError} /> : null}
      {allowed && page === "wash_orders" ? providerMode ? <ProviderWashOrdersPage canRedeem={session.capabilities.includes("wash.orders.redeem")} onError={showError} /> : <WashOrdersPage onError={showError} /> : null}
      {allowed && page === "wash_stores" ? <WashStoresPage onError={showError} /> : null}
      {allowed && page === "wash_catalog" ? providerMode ? <ProviderWashCatalogPage subjectId={session.subject?.id || ""} onError={showError} /> : <WashCatalogPage onError={showError} /> : null}
      {allowed && page === "car_rental" ? <CarRentalAdminPage onError={showError} /> : null}
      {allowed && page === "insurance_leads" ? <InsuranceLeadsPage onError={showError} /> : null}
      {allowed && page === "driving_schools" ? <DrivingSchoolAdminPage onError={showError} /> : null}
      {allowed && page === "subsidy_consultation" ? <SubsidyConsultationAdminPage onError={showError} /> : null}
      {allowed && page === "workflow_tasks" ? <WorkflowAdminPage section="tasks" onNavigate={navigate} onError={showError} canManage={session.capabilities.includes("workflow.settings.manage")} canRemind={session.capabilities.includes("workflow.tasks.remind")} viewerRole={session.account.role} /> : null}
      {allowed && page === "workflow_settings" ? <WorkflowAdminPage section="settings" onNavigate={navigate} onError={showError} canManage={session.capabilities.includes("workflow.settings.manage")} canRemind={session.capabilities.includes("workflow.tasks.remind")} viewerRole={session.account.role} /> : null}
      {allowed && page === "workflow_templates" ? <WorkflowAdminPage section="templates" onNavigate={navigate} onError={showError} canManage={session.capabilities.includes("workflow.settings.manage")} canRemind={session.capabilities.includes("workflow.tasks.remind")} viewerRole={session.account.role} /> : null}
      {allowed && page === "workflow_recipients" ? <WorkflowAdminPage section="recipients" onNavigate={navigate} onError={showError} canManage={session.capabilities.includes("workflow.settings.manage")} canRemind={session.capabilities.includes("workflow.tasks.remind")} viewerRole={session.account.role} /> : null}
      {allowed && page === "workflow_releases" ? <WorkflowAdminPage section="releases" onNavigate={navigate} onError={showError} canManage={session.capabilities.includes("workflow.settings.manage")} canRemind={session.capabilities.includes("workflow.tasks.remind")} viewerRole={session.account.role} /> : null}
      {allowed && page === "service_accounts" ? <ServiceAccountsPage onError={showError} /> : null}
      {allowed && page === "audit_events" ? <AuditEventsPage onError={showError} /> : null}
      {allowed && page === "wash_dashboard" ? <WashProviderDashboard onNavigate={navigate} onError={showError} /> : null}
      {allowed && page === "wash_slots" ? <ProviderWashSlotsPage subjectId={session.subject?.id || ""} onError={showError} /> : null}
      {allowed && page === "wash_store_profile" ? <ProviderWashStorePage subjectId={session.subject?.id || ""} onError={showError} /> : null}
      {allowed && page === "wash_settlements" ? <WashProviderSettlementsPage onError={showError} /> : null}
      {allowed && page === "audit_self" ? <AuditEventsPage selfOnly selfRole={session.account.role} onError={showError} /> : null}
    </main>
  </div>;
}

function BookingsPage({ stations, onError }: { stations: Station[]; onError: (message: string) => void }) {
  const todayDate = shanghaiDate();
  const tomorrowDate = shanghaiDate(1);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [selected, setSelected] = useState<Booking | null>(null);
  const deepLinkOpenedRef = useRef("");
  const deepLinkSelectionRef = useRef("");
  const listRequestGeneration = useRef(0);
  const listRequestController = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(() => ({ plateNumber: "", date: todayDate, stationId: "", status: "", serviceMode: "" }));
  const openBooking = (booking: Booking) => {
    deepLinkSelectionRef.current = "";
    const url = new URL(window.location.href);
    if (url.searchParams.has("booking")) {
      url.searchParams.delete("booking");
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    }
    setSelected(booking);
    const bookingId = booking.id;
    void api<Booking>(`/admin/bookings/${bookingId}`).then((detail) => {
      setSelected((current) => current?.id === bookingId ? detail : current);
    }).catch((reason) => onError(operatorErrorMessage(reason, "预约详情读取失败，请稍后重试")));
  };
  useEffect(() => {
    const bookingId = new URLSearchParams(window.location.search).get("booking") || "";
    if (!bookingId || deepLinkOpenedRef.current === bookingId) return;
    deepLinkOpenedRef.current = bookingId;
    deepLinkSelectionRef.current = bookingId;
    void api<Booking>(`/admin/bookings/${encodeURIComponent(bookingId)}`).then((booking) => {
      if (deepLinkSelectionRef.current === bookingId) setSelected(booking);
    }).catch((reason) => {
      if (deepLinkSelectionRef.current === bookingId) deepLinkSelectionRef.current = "";
      onError(operatorErrorMessage(reason, "预约详情读取失败，请稍后重试"));
    });
  }, [onError]);
  const load = () => {
    const generation = ++listRequestGeneration.current;
    listRequestController.current?.abort();
    const controller = new AbortController();
    listRequestController.current = controller;
    setLoading(true);
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    void api<Booking[]>(`/admin/bookings?${query}`, { signal: controller.signal }).then((items) => {
      if (generation !== listRequestGeneration.current || controller.signal.aborted) return;
      setBookings(items);
      setSelected((current) => {
        if (!current) return null;
        if (deepLinkSelectionRef.current === current.id) return current;
        return items.some((item) => item.id === current.id) ? current : null;
      });
    }).catch((reason: Error) => {
      if (generation === listRequestGeneration.current && reason.name !== "AbortError") onError(operatorErrorMessage(reason, "预约列表读取失败，请稍后重试"));
    }).finally(() => {
      if (generation !== listRequestGeneration.current) return;
      if (listRequestController.current === controller) listRequestController.current = null;
      setLoading(false);
    });
  };
  useEffect(() => {
    load();
    return () => {
      listRequestGeneration.current += 1;
      listRequestController.current?.abort();
      listRequestController.current = null;
    };
  }, [filters.plateNumber, filters.date, filters.stationId, filters.status, filters.serviceMode]);
  const metrics = useMemo(() => ({
    all: bookings.length,
    paid: bookings.filter((item) => item.paymentStatus === "paid").length,
    active: bookings.filter((item) => !["completed", "cancelled", "no_show"].includes(bookingFulfillment(item))).length,
    revenue: bookings.reduce((sum, item) => sum + Math.max(0, (item.paidFen ?? item.paymentSummary?.paidFen ?? (item.paymentStatus === "paid" ? item.serviceFeeFen : 0)) - (item.refundedFen ?? item.paymentSummary?.refundedFen ?? 0)), 0),
  }), [bookings]);
  const metricScopeLabel = filters.date === todayDate
    ? "今日预约"
    : filters.date === tomorrowDate
      ? "明日预约"
      : filters.date
        ? "指定日预约"
        : "筛选订单";
  const setFilter = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  return <>
    <section className="metric-strip">
      <div><span><CalendarCheck /></span><small>{metricScopeLabel}</small><strong>{metrics.all}<em> 笔</em></strong></div>
      <div><span><Gauge /></span><small>履约中</small><strong>{metrics.active}<em> 笔</em></strong></div>
      <div><span><CreditCard /></span><small>已模拟支付</small><strong>{metrics.paid}<em> 笔</em></strong></div>
      <div><span><CurrencyCny /></span><small>模拟已收净额</small><strong>¥{money(metrics.revenue)}</strong></div>
    </section>
    <section className="content-card booking-list-card">
      <div className="filters booking-filters" role="search" aria-label="预约筛选">
        <span><SlidersHorizontal />筛选</span>
        <div className="booking-date-shortcuts" role="group" aria-label="预约日期快捷筛选">
          <button type="button" className={filters.date === todayDate ? "active" : ""} aria-pressed={filters.date === todayDate} onClick={() => setFilter("date", todayDate)}>今日预约</button>
          <button type="button" className={filters.date === tomorrowDate ? "active" : ""} aria-pressed={filters.date === tomorrowDate} onClick={() => setFilter("date", tomorrowDate)}>明日预约</button>
          <button type="button" className={!filters.date ? "active" : ""} aria-pressed={!filters.date} onClick={() => setFilter("date", "")}>全部日期</button>
        </div>
        <input aria-label="预约日期筛选" title="选择其他预约日期" type="date" value={filters.date} onChange={(event) => setFilter("date", event.target.value)} />
        <input aria-label="车牌号筛选" maxLength={32} value={filters.plateNumber} onChange={(event) => setFilter("plateNumber", event.target.value)} placeholder="车牌号" autoComplete="off" />
        <select aria-label="检测站筛选" value={filters.stationId} onChange={(event) => setFilter("stationId", event.target.value)}><option value="">全部站点</option>{stations.map((station) => <option value={station.id} key={station.id}>{station.name}</option>)}</select>
        <select aria-label="履约状态筛选" value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部状态</option>{bookingFilterOptions.map((value) => <option value={value} key={value}>{statusLabels[value]}</option>)}</select>
        <select aria-label="服务方式筛选" value={filters.serviceMode} onChange={(event) => setFilter("serviceMode", event.target.value)}><option value="">全部方式</option><option value="self_drive">自驾到站</option><option value="valet">上门往返取送</option></select>
        <button type="button" className="booking-filter-reset" aria-label="重置预约筛选" onClick={() => setFilters({ plateNumber: "", date: shanghaiDate(), stationId: "", status: "", serviceMode: "" })}>重置</button>
      </div>
      <p className="booking-table-hint"><span aria-hidden="true">↔</span>可左右滚动查看全部信息；履约状态和查看详情固定显示</p>
      <div className="table-wrap booking-table-wrap"><table className="booking-table" aria-label="预约履约列表"><thead><tr><th scope="col" aria-sort="descending">下单时间 <span className="booking-sort-note" aria-hidden="true">↓ 最新优先</span></th><th scope="col">预约时间</th><th scope="col">车辆 / 联系人</th><th scope="col">检测站</th><th scope="col">服务方式</th><th scope="col">交易</th><th scope="col" className="booking-status-cell">履约状态</th><th scope="col" className="booking-action-cell">操作</th></tr></thead><tbody>{bookings.map((booking) => {
        const fulfillment = bookingFulfillment(booking);
        const legacy = booking.fulfillmentStatus === "legacy";
        const plate = booking.vehicle?.plateNumber || "待核验车辆";
        const orderedAt = shanghaiTime(booking.createdAt);
        return <tr key={booking.id} data-booking-id={booking.id}><td className="booking-created-cell"><strong>{orderedAt?.slice(0, 10) || "—"}</strong><small>{orderedAt?.slice(11) || "时间待补全"}</small></td><td><strong>{booking.appointmentDate}</strong><small>{booking.startTime}–{booking.endTime}</small></td><td><button type="button" className="booking-primary-link" aria-label={`打开${plate}预约详情`} onClick={() => openBooking(booking)}><strong>{plate}</strong><small>{booking.contactName} · {booking.contactPhone}</small></button></td><td><strong>{booking.station?.name}</strong><small>{booking.station?.district}</small></td><td><span className={`mode-pill ${booking.serviceMode}`}>{booking.serviceMode === "valet" ? legacy ? "历史单程口径" : "往返取送" : "自驾到站"}</span></td><td><strong>¥{money(booking.serviceFeeFen)}</strong><small>{bookingPaymentText(booking)}</small></td><td className="booking-status-cell"><span className={`status-pill status-${fulfillment}`}>{statusLabels[fulfillment] || "状态待核对"}</span>{legacy ? <small>历史订单</small> : null}</td><td className="booking-action-cell"><button type="button" className="booking-detail-button" aria-label={`查看${plate}预约详情`} onClick={() => openBooking(booking)}><span>查看详情</span><CaretRight aria-hidden="true" /></button></td></tr>;
      })}</tbody></table>{!bookings.length && !loading ? <div className="empty-table">没有符合条件的预约</div> : null}{loading ? <div className="table-loading">正在同步预约数据…</div> : null}</div>
    </section>
    {selected ? <BookingDrawer booking={selected} close={() => { deepLinkSelectionRef.current = ""; setSelected(null); const url = new URL(window.location.href); url.searchParams.delete("booking"); window.history.replaceState({}, "", `${url.pathname}${url.search}`); }} refresh={async () => {
      load();
      const bookingId = selected.id;
      try {
        const booking = await api<Booking>(`/admin/bookings/${bookingId}`);
        setSelected((current) => current?.id === bookingId ? booking : current);
      } catch (reason) {
        onError(operatorErrorMessage(reason, "预约详情刷新失败，请稍后重试"));
      }
    }} onError={onError} /> : null}
  </>;
}

function BookingDrawer({ booking, close, refresh, onError }: { booking: Booking; close: () => void; refresh: () => void | Promise<void>; onError: (message: string) => void }) {
  const initialStatus = (booking.fulfillmentStatus && booking.fulfillmentStatus !== "legacy" ? booking.fulfillmentStatus : booking.status) as FulfillmentStatus;
  const [status, setStatus] = useState<FulfillmentStatus>(initialStatus);
  const [driverNote, setDriverNote] = useState(booking.internalDriverNote || "");
  const [adjustmentType, setAdjustmentType] = useState<"adjustment" | "refund">("adjustment");
  const [adjustmentYuan, setAdjustmentYuan] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const media = booking.media ?? [];
  const previewMedia = preview ? preview.items[preview.index] ?? null : null;
  const previewLabel = preview?.label || "";
  useEffect(() => {
    setStatus(initialStatus);
    setDriverNote(booking.internalDriverNote || "");
  }, [booking.id, initialStatus, booking.internalDriverNote]);
  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.resolve(refresh()).finally(() => setRefreshing(false));
  };
  const retryPrecheckRefund = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api(`/admin/bookings/${booking.id}/precheck-refund/retry`, { method: "POST" });
      setSaved("退款重试已完成");
      await Promise.resolve(refresh());
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError(operatorErrorMessage(error, "预约退款重试失败，请稍后再试"));
    } finally {
      setSaving(false);
    }
  };
  const closePreview = () => {
    setPreview(null);
    window.requestAnimationFrame(() => previewTriggerRef.current?.focus());
  };
  useEffect(() => {
    if (!preview || preview.items.length === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        setPreview((current) => shiftPreview(current, direction));
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(lightboxRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [preview]);
  const saveFulfillment = async (includeMoney = false) => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { internalDriverNote: driverNote || null };
      if (booking.fulfillmentStatus !== "legacy" || status !== initialStatus) payload.fulfillmentStatus = status;
      if (includeMoney) {
        const amountFen = Math.round(Number(adjustmentYuan) * 100);
        if (!amountFen || reason.trim().length < 2) throw new Error("请填写有效金额和至少两个字的原因");
        payload[adjustmentType] = { amountFen, reason: reason.trim(), idempotencyKey: `${adjustmentType}-${booking.id}-${Date.now()}` };
      }
      await api(`/admin/bookings/${booking.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      setAdjustmentYuan("");
      setReason("");
      setSaved(includeMoney ? "费用账目已记录" : "履约信息已保存");
      refresh();
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError(operatorErrorMessage(error, "预约履约信息保存失败，请稍后重试"));
    } finally {
      setSaving(false);
    }
  };
  const distance = booking.oneWayDistanceKm ?? booking.quoteDistanceKm;
  const isTencentRoute = booking.quoteSource === "tencent_matrix";
  const valetRule = booking.valetRule ?? (booking.ruleBaseFeeFen == null ? null : {
    id: "snapshot",
    baseFeeFen: booking.ruleBaseFeeFen,
    includedKm: booking.ruleIncludedKm ?? 0,
    perKmFen: booking.rulePerKmFen ?? 0,
    maxRadiusKm: null,
    updatedAt: "",
  });
  const chargedFen = booking.chargedFen ?? booking.serviceFeeFen;
  const paidFen = booking.paidFen ?? booking.paymentSummary?.paidFen ?? 0;
  const refundedFen = booking.refundedFen ?? booking.paymentSummary?.refundedFen ?? 0;
  const exceptionOptions = adminExceptionOptions(booking, initialStatus);
  const checkupReportExpected = (["result_received", "returning", "completed"] as FulfillmentStatus[]).includes(initialStatus);
  return <><div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && close()}><aside className="detail-drawer wide-drawer booking-detail-drawer" aria-label="预约与账务详情">
    <header><div><small>预约与账务详情</small><h2>{booking.vehicle?.plateNumber || "待核验车辆"}</h2><p>{booking.bookingNumber || "业务编号待补全"}</p></div><div className="drawer-header-actions"><button type="button" onClick={handleRefresh} disabled={refreshing} aria-label="刷新预约详情" title="刷新详情"><ArrowClockwise className={refreshing ? "drawer-refresh-spin" : undefined} /></button><button type="button" onClick={close} aria-label="关闭预约详情"><X /></button></div></header>
    <div className="drawer-scroll">
      <section className="drawer-status"><span className={`status-pill status-${status}`}>{statusLabels[status]}</span><strong>{booking.appointmentDate} · {booking.startTime}–{booking.endTime}</strong><small>{booking.station?.name} · {booking.serviceMode === "valet" ? "代驾往返取送" : "车主自驾到站"}</small></section>
      <BookingJourney booking={booking} />
      <PrecheckAuditPanel booking={booking} onRetryRefund={() => void retryPrecheckRefund()} retrying={saving} />
      <ServiceFulfillmentSnapshot booking={booking} />
      {booking.serviceMode === "valet" ? <DriverAssignmentPanel booking={booking} refresh={refresh} onError={onError} /> : null}
      {booking.serviceMode === "valet" ? <FulfillmentEvidencePanel booking={booking} onPreview={(stageLabel, photos, index, trigger) => {
        previewTriggerRef.current = trigger;
        setPreview({ context: `履约留证 · ${stageLabel}`, label: `${stageLabel}${evidencePhotoLabels[photos[index].kind]}`, items: photos, index });
      }} /> : null}
      <section className="detail-section"><h3>交易状态</h3><div className="payment-summary"><div><small>应付</small><strong>¥{money(chargedFen)}</strong></div><div><small>已收</small><strong>¥{money(paidFen)}</strong></div><div><small>已退</small><strong>¥{money(refundedFen)}</strong></div><span className={`payment-pill payment-${booking.paymentStatus || "unpaid"}`}>{paymentLabels[booking.paymentStatus || "unpaid"]}</span></div>{booking.pendingAdjustmentFen ? <p className="pending-money-note">另有 ¥{money(booking.pendingAdjustmentFen)} 附加费等待车主确认；确认或作废前，服务不能结束。</p> : null}{booking.amountDueFen ? <p className="pending-money-note">尚有 ¥{money(booking.amountDueFen)} 已确认费用待支付，结清后才能完成服务。</p> : null}<p className="muted">当前为模拟支付环境，仅记录交易状态，不会发生真实扣款。</p></section>
      <section className="detail-section"><h3>后台例外处理</h3><div className="ops-form"><label><span>当前状态 / 可用例外</span><select aria-label="后台例外处理" value={status} onChange={(event) => setStatus(event.target.value as FulfillmentStatus)}>{exceptionOptions.map((value) => <option key={value} value={value}>{statusLabels[value]}{value === "on_hold" && value !== initialStatus ? "（暂停履约）" : value === "cancelled" && value !== initialStatus ? "（终止订单）" : value !== initialStatus ? "（恢复原节点）" : ""}</option>)}</select></label><label className="wide"><span>线下司机协调备注（仅后台可见）</span><textarea value={driverNote} onChange={(event) => setDriverNote(event.target.value)} placeholder="例如：微信群已确认司机王师傅，预计 09:20 到达" /></label><button disabled={saving} onClick={() => void saveFulfillment(false)}><FloppyDisk />{saving ? "保存中…" : status === initialStatus ? "保存协调备注" : "保存例外处理"}</button>{saved ? <em className="saved-inline"><CheckCircle weight="fill" />{saved}</em> : null}</div><p className="protected-transition-note"><ShieldCheck />后台只处理挂起、恢复原节点、取消和协调备注。接单、到站核验、交接检测、结果发布及代驾留证由检测站或司机在对应业务端完成。</p>{initialStatus === "on_hold" && !holdRestoreStatus(booking) ? <p className="pending-money-note">该历史挂起记录缺少可验证的原节点，已禁止猜测恢复，请联系平台核对数据。</p> : null}</section>
      <section className="detail-section"><h3>不可变价格快照</h3><dl><div><dt>年检服务费</dt><dd>¥{money(booking.inspectionFeeFen)}</dd></div><div><dt>{booking.fulfillmentStatus === "legacy" && booking.serviceMode === "valet" ? "历史单程服务费" : "往返取送费"}</dt><dd>¥{money(booking.valetFeeFen)}{distance ? `（${isTencentRoute ? "腾讯单程" : "历史估算/未核验"} ${distance} 公里）` : ""}</dd></div>{valetRule && booking.fulfillmentStatus !== "legacy" ? <div><dt>取送公式</dt><dd>¥{money(valetRule.baseFeeFen)} + 超出 {booking.extraKm ?? booking.quoteExtraKm ?? 0} 公里 × ¥{money(valetRule.perKmFen)}</dd></div> : null}<div className="total"><dt>下单快照总价</dt><dd>¥{money(booking.serviceFeeFen)}</dd></div></dl></section>
      <section className="detail-section"><h3>费用调整与退款</h3><div className="ledger-editor"><select value={adjustmentType} onChange={(event) => setAdjustmentType(event.target.value as "adjustment" | "refund")}><option value="adjustment">新增附加费</option><option value="refund" disabled={["pending_precheck", "precheck_action_required"].includes(initialStatus)}>记录退款</option></select><div><i>¥</i><input type="number" min="0.01" step="0.01" value={adjustmentYuan} onChange={(event) => setAdjustmentYuan(event.target.value)} placeholder="0.00" /></div><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="必须填写收费或退款原因" /><button disabled={saving} onClick={() => void saveFulfillment(true)}>{adjustmentType === "refund" ? <ArrowCounterClockwise /> : <Plus />}{adjustmentType === "refund" ? "确认退款记录" : "提交附加费待车主确认"}</button></div><div className="ledger-list">{booking.ledgerEntries?.filter((entry) => !["booking_charge", "legacy_booking_charge"].includes(entry.kind)).map((entry) => <div key={entry.id}><span><Receipt />{entry.description}<small>{entry.confirmationStatus === "pending_owner_confirmation" ? "等待车主确认 · 尚未计入应付" : entry.confirmationStatus === "voided" ? "已作废" : shanghaiTime(entry.createdAt) || "时间待核对"}</small></span><strong className={entry.amountFen < 0 ? "negative" : ""}>{entry.amountFen < 0 ? "−" : "+"}¥{money(Math.abs(entry.amountFen))}</strong></div>)}{!booking.ledgerEntries?.some((entry) => !["booking_charge", "legacy_booking_charge"].includes(entry.kind)) ? <p className="muted">暂无后续调整或退款</p> : null}</div></section>
      {booking.vehicleCheckupReport ? <section className="detail-section checkup-detail-section"><VehicleCheckupReportPanel report={booking.vehicleCheckupReport} booking={{ bookingNumber: booking.bookingNumber, appointmentDate: booking.appointmentDate, startTime: booking.startTime, endTime: booking.endTime }} vehicle={booking.vehicle} station={booking.station} serviceMode={booking.serviceMode} /></section> : checkupReportExpected ? <section className="detail-section checkup-detail-section checkup-report-missing" role="alert" aria-label="车辆体检报告缺失"><span><WarningCircle weight="fill" /></span><div><small>报告材料缺失</small><h3>未形成结构化车辆体检报告</h3><p>材料闭环不完整，请核对原始检测站报告和现场影像。系统不会伪造或自动补齐体检报告。</p></div></section> : null}
      <section className="detail-section"><h3>上传资料 <em>{bookingMediaCountLabel(booking, media.length)}</em></h3><div className="media-gallery">{media.map((item, index) => {
        const label = mediaLabels[item.kind] || "其他预约资料";
        return <figure key={item.id}><button type="button" className="media-preview-trigger" aria-label={`查看${label}大图`} title="点击查看大图" onClick={(event) => { previewTriggerRef.current = event.currentTarget; setPreview({ context: "预约上传资料", label, items: media, index }); }}><AuthenticatedEvidenceImage url={item.url} alt={label} /><span><MagnifyingGlass />查看大图</span></button><figcaption>{label}</figcaption></figure>;
      })}</div>{media.length === 0 ? <p className="muted">该订单没有上传资料</p> : null}</section>
    </div>
  </aside></div>{previewMedia && preview ? <div ref={lightboxRef} className="media-lightbox" role="dialog" aria-modal="true" aria-label={`${previewLabel}图片预览`} onMouseDown={(event) => event.target === event.currentTarget && closePreview()}>
    <div className="media-lightbox-panel">
      <header><div><small>{preview.context}</small><strong>{previewLabel}</strong></div><span aria-live="polite">{preview.index + 1} / {preview.items.length}</span><button type="button" autoFocus onClick={closePreview} aria-label="关闭图片预览"><X /></button></header>
      <div className="media-lightbox-stage">
        {preview.items.length > 1 ? <button type="button" className="media-lightbox-nav previous" onClick={() => setPreview((current) => shiftPreview(current, -1))} aria-label="上一张"><CaretLeft /></button> : null}
        <AuthenticatedEvidenceImage url={previewMedia.url} alt={`${previewLabel}大图`} variant="preview" />
        {preview.items.length > 1 ? <button type="button" className="media-lightbox-nav next" onClick={() => setPreview((current) => shiftPreview(current, 1))} aria-label="下一张"><CaretRight /></button> : null}
      </div>
      <footer><span>{previewMedia.width && previewMedia.height ? `${previewMedia.width} × ${previewMedia.height}` : "原始留证影像"}</span><small>可使用键盘方向键切换，退出键关闭</small></footer>
    </div>
  </div> : null}</>;
}

function StationsPage({ stations, pricePlans, reload, onError }: { stations: Station[]; pricePlans: PricePlan[]; reload: () => void; onError: (message: string) => void }) {
  const [selectedId, setSelectedId] = useState(stations[0]?.id || "");
  const [draft, setDraft] = useState<Station | null>(stations[0] ? cloneStation(stations[0]) : null);
  const [creating, setCreating] = useState(false);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [slotDate, setSlotDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [slots, setSlots] = useState<StationSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [newSlot, setNewSlot] = useState({ startTime: "08:00", endTime: "09:00", capacity: 4 });
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSuggestions, setLocationSuggestions] = useState<LocationSuggestion[]>([]);
  const [locationSearchState, setLocationSearchState] = useState<LocationSearchState>("idle");
  const [locationSearchError, setLocationSearchError] = useState("");
  const [locationConfirmed, setLocationConfirmed] = useState(Boolean(stations[0]));
  const [locationTitle, setLocationTitle] = useState(stations[0]?.name || "");
  const [selectedLocation, setSelectedLocation] = useState<LocationSuggestion | null>(null);
  const locationRequestId = useRef(0);
  const loadedStationId = useRef(stations[0]?.id || "");

  const clearLocationSearch = () => {
    locationRequestId.current += 1;
    setLocationQuery("");
    setLocationSuggestions([]);
    setLocationSearchState("idle");
    setLocationSearchError("");
  };

  useEffect(() => {
    if (creating) return;
    const station = stations.find((item) => item.id === selectedId) || (!selectedId ? stations[0] : undefined);
    if (!station) return;
    const stationChanged = loadedStationId.current !== station.id;
    loadedStationId.current = station.id;
    setSelectedId(station.id);
    setDraft(cloneStation(station));
    setLocationConfirmed(true);
    setLocationTitle(station.name);
    if (stationChanged) {
      setSelectedLocation(null);
      clearLocationSearch();
    }
  }, [selectedId, stations, creating]);

  useEffect(() => {
    const requestId = ++locationRequestId.current;
    const query = locationQuery.trim();
    if (query.length < 2) {
      setLocationSuggestions([]);
      setLocationSearchState("idle");
      setLocationSearchError("");
      return;
    }

    const controller = new AbortController();
    setLocationSuggestions([]);
    setLocationSearchState("loading");
    setLocationSearchError("");
    const timer = window.setTimeout(async () => {
      try {
        const parameters = new URLSearchParams({ query });
        const next = (await api<LocationSuggestion[]>(`/locations/suggestions?${parameters.toString()}`, { signal: controller.signal }))
          .filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
        if (requestId !== locationRequestId.current) return;
        setLocationSuggestions(next);
        setLocationSearchState(next.length ? "ready" : "empty");
      } catch (error) {
        if (controller.signal.aborted || requestId !== locationRequestId.current || (error as Error).name === "AbortError") return;
        setLocationSuggestions([]);
        setLocationSearchState("error");
        setLocationSearchError(operatorErrorMessage(error, "地址服务暂不可用，请稍后重试"));
      }
    }, 320);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [locationQuery]);
  useEffect(() => {
    if (creating || !draft?.id) {
      setSlots([]);
      return;
    }
    setSlotsLoading(true);
    void api<Omit<StationSlot, "bookedCount">[]>(`/stations/${draft.id}/slots?date=${slotDate}`).then((items) => {
      setSlots(items.map((item) => ({ ...item, bookedCount: Math.max(0, item.capacity - item.remaining) })));
    }).catch((error) => onError(error.message)).finally(() => setSlotsLoading(false));
  }, [draft?.id, slotDate, creating]);
  const beginCreate = () => {
    setCreating(true);
    setSelectedId("");
    setDraft(newStation(pricePlans));
    setLocationConfirmed(false);
    setLocationTitle("");
    setSelectedLocation(null);
    loadedStationId.current = "";
    clearLocationSearch();
  };
  if (!draft) return <div className="content-card empty-table">正在读取站点配置…</div>;
  const update = <K extends keyof Station>(key: K, value: Station[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const updateSchedule = (day: keyof WeeklySchedule, enabled: boolean) => update("weeklySchedule", { ...draft.weeklySchedule, [day]: enabled ? [{ start: "08:00", end: "17:00" }] : [] });
  const updateScheduleTime = (day: keyof WeeklySchedule, field: keyof DailyPeriod, value: string) => {
    const current = draft.weeklySchedule[day]?.[0] ?? { start: "08:00", end: "17:00" };
    update("weeklySchedule", { ...draft.weeklySchedule, [day]: [{ ...current, [field]: value }] });
  };
  const selectLocation = (location: LocationSuggestion) => {
    setDraft((current) => current ? {
      ...current,
      district: location.district,
      address: location.address,
      latitude: location.latitude,
      longitude: location.longitude,
      mapPoiId: location.poiId,
    } : current);
    setLocationConfirmed(true);
    setLocationTitle(location.title);
    setSelectedLocation(location);
    clearLocationSearch();
  };
  const saveSlot = async (slot: StationSlot) => {
    try {
      const next = await api<StationSlot>(`/admin/station-slots/${slot.id}`, { method: "PUT", body: JSON.stringify({ date: slot.date, startTime: slot.startTime, endTime: slot.endTime, capacity: slot.capacity }) });
      setSlots((current) => current.map((item) => item.id === slot.id ? { ...next, bookedCount: Math.max(0, next.capacity - next.remaining) } : item));
      setSaved(`${slot.startTime} 号源容量已保存`);
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    }
  };
  const createSlot = async () => {
    if (!draft.id || creating) return;
    if (newSlot.startTime >= newSlot.endTime) return onError("号源结束时间必须晚于开始时间");
    try {
      const created = await api<StationSlot>(`/admin/stations/${draft.id}/slots`, {
        method: "POST",
        body: JSON.stringify({ date: slotDate, ...newSlot }),
      });
      setSlots((current) => [...current, { ...created, bookedCount: created.bookedCount ?? 0 }].sort((a, b) => a.startTime.localeCompare(b.startTime)));
      setSaved(`${created.startTime}–${created.endTime} 号源已新增`);
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    }
  };
  const deleteSlot = async (slot: StationSlot) => {
    if (slot.bookedCount > 0) return onError("已有预约的号源不能删除");
    if (!window.confirm(`确认删除 ${slot.date} ${slot.startTime}–${slot.endTime} 号源？`)) return;
    try {
      await api(`/admin/station-slots/${slot.id}`, { method: "DELETE" });
      setSlots((current) => current.filter((item) => item.id !== slot.id));
      setSaved("号源已删除");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    }
  };
  const updatePlanLink = (planId: string, patch: Partial<PricePlanLink>) => update("pricePlans", pricePlans.map((plan) => {
    const current = draft.pricePlans.find((item) => item.planId === plan.id) || { planId: plan.id, isSupported: false, priceFen: 0 };
    return plan.id === planId ? { ...current, ...patch } : current;
  }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (draft.pricePlans.some((item) => item.isSupported && (!Number.isInteger(item.priceFen) || item.priceFen <= 0))) {
      return onError("已启用的车型方案必须填写大于 0 元的年检价格");
    }
    if (!locationConfirmed || !draft.address || !draft.district || !Number.isFinite(draft.latitude) || !Number.isFinite(draft.longitude) || (creating && !selectedLocation)) {
      return onError("请先搜索并选择检测站位置，地址与坐标将由系统自动填写");
    }
    if (selectedLocation && !selectedLocation.locationProof) {
      return onError("该位置缺少地图校验凭证，请重新搜索并选择");
    }
    setSaving(true);
    try {
      const payload = {
        ...draft,
        id: creating ? undefined : draft.id,
        legalName: draft.legalName || null,
        phone: draft.phone || null,
        mapPoiId: draft.mapPoiId || null,
        internalContact: draft.internalContact?.name && draft.internalContact.phone ? draft.internalContact : null,
        sortPriority: draft.sortPriority,
        ...(selectedLocation ? { location: selectedLocation } : {}),
      };
      const next = await api<Station>(creating ? "/admin/stations" : `/admin/stations/${draft.id}`, { method: creating ? "POST" : "PUT", body: JSON.stringify(payload) });
      setCreating(false);
      setSelectedId(next.id);
      setLocationConfirmed(true);
      setLocationTitle(next.name);
      setSelectedLocation(null);
      setSaved("站点、服务能力与价格已保存");
      reload();
      window.setTimeout(() => setSaved(""), 2600);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return <div className="station-layout"><section className="station-list"><header><div><small>共 {stations.length} 个站点</small><h2>检测站</h2></div><button className="icon-action" onClick={beginCreate}><Plus />新增</button></header>{stations.map((item) => <button className={!creating && item.id === draft.id ? "active" : ""} key={item.id} onClick={() => { setCreating(false); setSelectedId(item.id); }}><span className="station-icon"><Buildings /></span><span><strong>{item.name}</strong><small>{item.isDirectOperated ? "自营" : item.dataKind === "demo" ? "演示" : "合作"} · {item.isActive ? "已启用" : "已停用"}</small></span>{item.isPinned ? <em>置顶</em> : null}<CaretRight /></button>)}</section><form className="station-editor" onSubmit={save}><header><div><small>{creating ? "创建检测站" : "检测站配置"}</small><h2>{creating ? "新增检测站" : draft.name}</h2></div><div className="header-switches"><label className="switch"><input type="checkbox" checked={draft.isActive} onChange={(event) => update("isActive", event.target.checked)} /><span />{draft.isActive ? "已启用" : "已停用"}</label><label className="switch"><input type="checkbox" checked={Boolean(draft.isPinned)} onChange={(event) => update("isPinned", event.target.checked)} /><span />置顶</label></div></header><div className="form-grid">
      <label><span>展示名称</span><input aria-label="展示名称" required value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
      <label><span>正式主体名称</span><input aria-label="正式主体名称" value={draft.legalName || ""} onChange={(event) => update("legalName", event.target.value || null)} /></label>
      <section className="wash-store-location station-location-picker" aria-labelledby="station-location-title">
        <header>
          <div><span id="station-location-title">检测站位置</span><small>{creating ? "运营无需查询坐标，搜索并选择真实站点位置即可" : "现有定位默认保留；站点搬迁时重新搜索并选择"}</small></div>
          {locationConfirmed ? <em><CheckCircle weight="fill" />{selectedLocation ? "已重新定位" : "已保存位置"}</em> : <em className="pending"><MapPin />等待选点</em>}
        </header>
        <div className={`wash-location-search ${locationSearchState === "error" ? "has-error" : ""}`}>
          <MagnifyingGlass aria-hidden="true" />
          <input aria-label="搜索检测站位置" autoComplete="off" type="search" value={locationQuery} onChange={(event) => setLocationQuery(event.target.value)} placeholder={locationConfirmed ? "输入站点、道路或地标名称重新定位" : "输入站点、道路或地标名称（至少 2 个字）"} />
          {locationSearchState === "loading" ? <CircleNotch className="location-spinner" aria-label="正在搜索检测站位置" /> : null}
          {locationQuery ? <button type="button" aria-label="清除检测站地址搜索" onClick={clearLocationSearch}><X /></button> : null}
        </div>
        <div className="wash-location-feedback" aria-live="polite">
          {locationSearchState === "idle" && locationQuery.trim().length === 1 ? <span>请再输入至少 1 个字</span> : null}
          {locationSearchState === "loading" ? <span>正在从地图服务查找匹配位置…</span> : null}
          {locationSearchState === "empty" ? <span>没有找到匹配位置，请换用道路、地标或完整站点名称</span> : null}
          {locationSearchState === "error" ? <span className="error"><WarningCircle weight="fill" />{locationSearchError}</span> : null}
        </div>
        {locationSuggestions.length ? <div className="wash-location-suggestions" role="listbox" aria-label="检测站位置候选">{locationSuggestions.map((location) => <button key={location.poiId} type="button" role="option" aria-selected="false" onClick={() => selectLocation(location)}><MapPin weight="duotone" /><span><strong>{location.title}</strong><small>{location.address}</small></span><em>{location.district}{location.source === "demo" ? " · 演示" : ""}</em></button>)}</div> : null}
        {locationConfirmed && draft.address ? <div className="wash-location-selected"><span className="location-pin"><MapPin weight="fill" /></span><div><small>当前用于距离、代驾费与导航的位置</small><strong>{locationTitle || draft.name || "已选择检测站位置"}</strong><p>{draft.address}</p></div><span className="location-district">{draft.district}</span></div> : <div className="wash-location-placeholder"><MapPin /><span><strong>尚未选择检测站位置</strong><small>保存前必须从搜索结果中选择，地址、地图点位与坐标由系统写入</small></span></div>}
        {locationConfirmed ? <div className="wash-location-coordinates station-location-coordinates">
          <label><span>所属区（自动识别）</span><input aria-label="所属区" readOnly value={draft.district} /></label>
          <label><span>标准地址（自动回填）</span><input aria-label="详细地址" readOnly value={draft.address} /></label>
          <label><span>纬度（系统生成）</span><input aria-label="检测站纬度" readOnly value={draft.latitude.toFixed(6)} /></label>
          <label><span>经度（系统生成）</span><input aria-label="检测站经度" readOnly value={draft.longitude.toFixed(6)} /></label>
        </div> : null}
      </section>
      <label><span>数据属性</span><select aria-label="数据属性" value={draft.dataKind} onChange={(event) => update("dataKind", event.target.value as "demo" | "real")}><option value="real">真实站点</option><option value="demo">演示站点</option></select></label>
      <label><span>排序权重</span><input aria-label="排序权重" type="number" step="1" value={draft.sortPriority} onChange={(event) => update("sortPriority", Number(event.target.value))} /><small>同为置顶或同为普通站时，数值越大越靠前</small></label>
      <label><span>客户咨询电话</span><input aria-label="客户咨询电话" value={draft.phone || ""} onChange={(event) => update("phone", event.target.value || null)} /></label>
      <label><span>内部联系人</span><input aria-label="内部联系人" value={draft.internalContact?.name || ""} onChange={(event) => update("internalContact", { name: event.target.value, phone: draft.internalContact?.phone || "" })} /></label>
      <label><span>内部联系电话</span><input aria-label="内部联系电话" value={draft.internalContact?.phone || ""} onChange={(event) => update("internalContact", { name: draft.internalContact?.name || "", phone: event.target.value })} /></label>
      <label className="wide check-field"><input type="checkbox" checked={draft.isDirectOperated} onChange={(event) => update("isDirectOperated", event.target.checked)} /><span><strong>标记为官方自营站</strong><small>自营属性、置顶、排序权重与取送优惠分别配置</small></span></label>
    </div>
    <section className="schedule-editor"><header><div><small>每周营业安排</small><h3>每周营业安排</h3></div><input value={draft.openHours} onChange={(event) => update("openHours", event.target.value)} aria-label="营业时间摘要" /></header><div>{dayLabels.map(([day, label]) => { const period = draft.weeklySchedule[day]?.[0]; return <label key={day} className={period ? "active" : ""}><input type="checkbox" checked={Boolean(period)} onChange={(event) => updateSchedule(day, event.target.checked)} /><strong>{label}</strong>{period ? <span className="day-times"><input aria-label={`${label}开始时间`} type="time" value={period.start} onChange={(event) => updateScheduleTime(day, "start", event.target.value)} /><i>至</i><input aria-label={`${label}结束时间`} type="time" value={period.end} onChange={(event) => updateScheduleTime(day, "end", event.target.value)} /></span> : <small>休息</small>}</label>; })}</div><input className="notice-input" value={draft.businessHoursNotice || ""} onChange={(event) => update("businessHoursNotice", event.target.value)} placeholder="营业时间提示" /></section>
    {!creating ? <section className="slot-editor"><header><div><small>预约容量</small><h3>号源容量管理</h3></div><label><span>预约日期</span><input type="date" min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} value={slotDate} onChange={(event) => setSlotDate(event.target.value)} /></label></header><div className="slot-create-row"><label><span>开始</span><input type="time" value={newSlot.startTime} onChange={(event) => setNewSlot((current) => ({ ...current, startTime: event.target.value }))} /></label><label><span>结束</span><input type="time" value={newSlot.endTime} onChange={(event) => setNewSlot((current) => ({ ...current, endTime: event.target.value }))} /></label><label><span>容量</span><input type="number" min="1" max="99" value={newSlot.capacity} onChange={(event) => setNewSlot((current) => ({ ...current, capacity: Number(event.target.value) }))} /></label><button type="button" onClick={() => void createSlot()}><Plus />新增时段</button></div>{slotsLoading ? <p className="muted">正在读取号源…</p> : slots.length ? <div className="slot-grid">{slots.map((slot) => <article key={slot.id}><span><strong>{slot.startTime}–{slot.endTime}</strong><small>已约 {slot.bookedCount} · 剩余 {Math.max(0, slot.capacity - slot.bookedCount)}</small></span><label><small>总容量</small><input type="number" min={Math.max(1, slot.bookedCount)} max="99" value={slot.capacity} onChange={(event) => setSlots((current) => current.map((item) => item.id === slot.id ? { ...item, capacity: Number(event.target.value) } : item))} /></label><button type="button" onClick={() => void saveSlot(slot)}><FloppyDisk />保存</button><button type="button" className="slot-delete" disabled={slot.bookedCount > 0} title={slot.bookedCount > 0 ? "已有预约，不能删除" : "删除号源"} onClick={() => void deleteSlot(slot)}><Trash />删除</button></article>)}</div> : <p className="muted">该日期暂无号源，可在上方新增。</p>}</section> : null}
    <section className="price-matrix dynamic-prices"><header><div><small>检测站价格方案</small><h3>支持车型与年检价格</h3></div><span>方案定义由系统约束；本站只决定是否支持及实际价格</span></header><div>{pricePlans.map((plan) => {
      const link = draft.pricePlans.find((item) => item.planId === plan.id) || { planId: plan.id, isSupported: false, priceFen: 0 };
      return <label key={plan.id} className={link.isSupported ? "supported" : ""}><span><input type="checkbox" checked={link.isSupported} onChange={(event) => updatePlanLink(plan.id, { isSupported: event.target.checked })} /><span><strong>{plan.name}</strong><small>{plan.plateCategories.map((code) => plateCategory(code)?.label || "未识别号牌类型").join(" / ")}</small><small>{plan.powertrainTypes.map((item) => powertrainLabels[item]).join(" / ")} · {plan.minSeats}–{plan.maxSeats} 座</small></span></span><div><i>¥</i><input aria-label={`${plan.name}年检价格`} disabled={!link.isSupported} required={link.isSupported} type="number" step="0.01" min="0.01" value={money(link.priceFen)} onChange={(event) => updatePlanLink(plan.id, { priceFen: Math.round(Number(event.target.value) * 100) })} /></div></label>;
    })}</div></section><footer>{saved ? <span><CheckCircle weight="fill" />{saved}</span> : <span className="muted">历史订单价格快照不会被覆盖</span>}<button type="submit" disabled={saving}><FloppyDisk />{saving ? "保存中…" : creating ? "创建站点" : "保存站点配置"}</button></footer></form></div>;
}

function PricePlansPage({ plans, reload, onError }: { plans: PricePlan[]; reload: () => Promise<void>; onError: (message: string) => void }) {
  const [selectedId, setSelectedId] = useState(plans[0]?.id || "");
  const [draft, setDraft] = useState<PricePlan>(plans[0] ? { ...plans[0] } : emptyPricePlan());
  const [creating, setCreating] = useState(!plans.length);
  const [usageText, setUsageText] = useState(draft.usageNatures.join("，"));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    if (creating) return;
    const plan = plans.find((item) => item.id === selectedId) || plans[0];
    if (!plan) return;
    setSelectedId(plan.id);
    setDraft({ ...plan });
    setUsageText(plan.usageNatures.join("，"));
  }, [plans, selectedId, creating]);
  const togglePowertrain = (value: PowertrainType) => setDraft((current) => ({ ...current, powertrainTypes: current.powertrainTypes.includes(value) ? current.powertrainTypes.filter((item) => item !== value) : [...current.powertrainTypes, value] }));
  const toggleItem = (value: InspectionItem) => setDraft((current) => ({ ...current, inspectionItems: current.inspectionItems.includes(value) ? current.inspectionItems.filter((item) => item !== value) : [...current.inspectionItems, value] }));
  const beginCreate = () => {
    const next = emptyPricePlan();
    setCreating(true);
    setSelectedId("");
    setDraft(next);
    setUsageText(next.usageNatures.join("，"));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.plateCategories.length) return onError("至少选择一个号牌车型");
    if (!draft.powertrainTypes.length || !draft.inspectionItems.length) return onError("至少选择一个动力类型和一个检验项目");
    if (draft.powertrainTypes.includes("pure_electric") && draft.inspectionItems.some((item) => item.startsWith("emissions_"))) return onError("纯电方案不能包含尾气排放检验");
    setSaving(true);
    try {
      const payload = { ...draft, id: creating ? undefined : draft.id, usageNatures: splitList(usageText), vehicleClassCodes: [...new Set(draft.plateCategories.map((code) => plateCategory(code)!.vehicleClassCode))] };
      const next = await api<PricePlan>(creating ? "/admin/inspection-price-plans" : `/admin/inspection-price-plans/${draft.id}`, { method: creating ? "POST" : "PUT", body: JSON.stringify(payload) });
      await reload();
      setCreating(false);
      setSelectedId(next.id);
      setSaved("价格方案已保存");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (creating || !draft.id) return;
    if (!window.confirm(`确认停用并删除“${draft.name}”？已存在订单的快照不会受影响。`)) return;
    try {
      await api(`/admin/inspection-price-plans/${draft.id}`, { method: "DELETE" });
      setCreating(true);
      setDraft(emptyPricePlan());
      await reload();
    } catch (error) {
      onError((error as Error).message);
    }
  };
  return <div className="station-layout plan-layout"><section className="station-list"><header><div><small>共 {plans.length} 个受控方案</small><h2>价格方案</h2></div><button className="icon-action" onClick={beginCreate}><Plus />新增</button></header>{plans.map((plan) => <button className={!creating && plan.id === draft.id ? "active" : ""} key={plan.id} onClick={() => { setCreating(false); setSelectedId(plan.id); }}><span className="station-icon"><ListChecks /></span><span><strong>{plan.name}</strong><small>{plan.isActive ? "已启用" : "已停用"} · {plan.minSeats}–{plan.maxSeats} 座</small></span><CaretRight /></button>)}</section><form className="station-editor plan-editor" onSubmit={save}><header><div><small>{creating ? "创建受控方案" : "受控价格方案"}</small><h2>{creating ? "新增检验价格方案" : draft.name}</h2></div><label className="switch"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /><span />{draft.isActive ? "已启用" : "已停用"}</label></header><div className="form-grid"><label><span>方案名称</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>系统识别码</span><input aria-label="价格方案系统识别码" required pattern="[a-z0-9][a-z0-9_-]+" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toLowerCase() })} /><small>用于系统区分方案，创建后请勿随意修改</small></label><label className="wide"><span>运营说明</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label><span>最少座位</span><input type="number" min="0" max="99" value={draft.minSeats} onChange={(event) => setDraft({ ...draft, minSeats: Number(event.target.value) })} /></label><label><span>最多座位</span><input type="number" min="0" max="99" value={draft.maxSeats} onChange={(event) => setDraft({ ...draft, maxSeats: Number(event.target.value) })} /></label><label><span>使用性质</span><input value={usageText} onChange={(event) => setUsageText(event.target.value)} placeholder="非营运" /></label><label><span>后台排序</span><input type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) })} /><small>仅控制方案列表顺序，不用于解决规则重叠</small></label><label className="check-field"><input type="checkbox" checked={draft.excludeVans} onChange={(event) => setDraft({ ...draft, excludeVans: event.target.checked })} /><span><strong>排除面包车</strong><small>本方案不匹配面包车</small></span></label></div><section className="condition-panel category-conditions"><div><header><h3>适用号牌车型（11 类）</h3></header><div className="option-grid">{PLATE_CATEGORIES.map((category) => <label key={category.code} className={draft.plateCategories.includes(category.code) ? "selected" : ""}><input type="checkbox" checked={draft.plateCategories.includes(category.code)} onChange={() => setDraft((current) => ({ ...current, plateCategories: current.plateCategories.includes(category.code) ? current.plateCategories.filter((code) => code !== category.code) : [...current.plateCategories, category.code] }))} /><span>{category.label}</span></label>)}</div></div></section><section className="condition-panel"><div><header><small>动力条件</small><h3>适用动力类型</h3></header><div className="option-grid">{(Object.keys(powertrainLabels) as PowertrainType[]).map((value) => <label key={value} className={draft.powertrainTypes.includes(value) ? "selected" : ""}><input type="checkbox" checked={draft.powertrainTypes.includes(value)} onChange={() => togglePowertrain(value)} /><span>{powertrainLabels[value]}</span></label>)}</div></div><div><header><small>检验项目</small><h3>包含检验项目</h3></header><div className="option-grid item-options">{(Object.keys(inspectionItemLabels) as InspectionItem[]).map((value) => <label key={value} className={draft.inspectionItems.includes(value) ? "selected" : ""}><input type="checkbox" checked={draft.inspectionItems.includes(value)} onChange={() => toggleItem(value)} /><span>{inspectionItemLabels[value]}</span></label>)}</div></div></section><div className="compliance-note"><ShieldCheck /><div><strong>按所选类别和实际动力匹配报价</strong><p>号牌车型、动力、座位数和使用性质共同决定报价，不根据新能源号牌字母判断动力。新增类别需在检测站配置中启用并填写价格；没有匹配或同时匹配多个方案时停止自动报价。纯电方案不能包含尾气项目。</p></div></div><footer>{!creating ? <button type="button" className="danger-button" onClick={() => void remove()}><Trash />删除方案</button> : <span />}{saved ? <span><CheckCircle weight="fill" />{saved}</span> : null}<button disabled={saving}><FloppyDisk />{saving ? "保存中…" : "保存价格方案"}</button></footer></form></div>;
}

function normalizedStationValet(payload: StationValetRule, global: ValetRule): { rule: ValetRule; inherited: boolean } {
  const override = payload.overrideRule ?? payload.override;
  const inherited = payload.mode ? payload.mode === "inherit" : payload.inheritsGlobal ?? payload.inherited ?? !override;
  return { rule: override ?? payload.resolvedRule ?? payload.effectiveRule ?? payload.rule ?? global, inherited };
}

function ValetPage({ stations, onError }: { stations: Station[]; onError: (message: string) => void }) {
  const [globalRule, setGlobalRule] = useState<ValetRule | null>(null);
  const [rule, setRule] = useState<ValetRule | null>(null);
  const [scopeId, setScopeId] = useState("global");
  const [inherited, setInherited] = useState(false);
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void api<ValetRule>("/admin/valet-rules").then((next) => {
      setGlobalRule(next);
      setRule(next);
    }).catch((error) => onError(error.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!globalRule) return;
    if (scopeId === "global") {
      setRule(globalRule);
      setInherited(false);
      return;
    }
    setLoading(true);
    void api<StationValetRule>(`/admin/stations/${scopeId}/valet-rule`).then((payload) => {
      const normalized = normalizedStationValet(payload, globalRule);
      setRule({ ...normalized.rule, stationId: scopeId });
      setInherited(normalized.inherited);
    }).catch((error) => onError(error.message)).finally(() => setLoading(false));
  }, [scopeId, globalRule?.updatedAt]);
  if (!rule || !globalRule || loading) return <div className="content-card empty-table">正在读取取送计价规则…</div>;
  const update = (key: keyof ValetRule, value: number | null) => setRule((current) => current ? { ...current, [key]: value } : current);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const body = { baseFeeFen: rule.baseFeeFen, includedKm: rule.includedKm, perKmFen: rule.perKmFen, maxRadiusKm: rule.maxRadiusKm };
      const next = await api<ValetRule>(scopeId === "global" ? "/admin/valet-rules" : `/admin/stations/${scopeId}/valet-rule`, { method: "PUT", body: JSON.stringify(body) });
      if (scopeId === "global") setGlobalRule(next);
      setRule(next);
      setInherited(false);
      setSaved(scopeId === "global" ? "全局默认规则已生效" : "站点覆盖规则已生效");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    }
  };
  const restore = async () => {
    if (scopeId === "global") return;
    try {
      await api(`/admin/stations/${scopeId}/valet-rule`, { method: "DELETE" });
      setRule({ ...globalRule, stationId: scopeId });
      setInherited(true);
      setSaved("已恢复继承全局规则");
    } catch (error) {
      onError((error as Error).message);
    }
  };
  const exampleDistances = [3, 10, 11.7, 25];
  const examples = exampleDistances.map((distance) => ({ distance, extra: Math.max(0, Math.ceil(distance - rule.includedKm)), fee: rule.baseFeeFen + Math.max(0, Math.ceil(distance - rule.includedKm)) * rule.perKmFen }));
  const selectedStation = stations.find((item) => item.id === scopeId);
  return <div className="valet-layout"><form className="rule-editor" onSubmit={save}><header><span><SteeringWheel weight="duotone" /></span><div><small>往返取送规则</small><h2>{scopeId === "global" ? "全站统一默认" : selectedStation?.name}</h2><p>费用包含上门取车、送检、正常检测等待及送回原地址；只按取车点到站的腾讯单程路线计价。</p></div></header><div className="scope-selector"><label><span>配置范围</span><select value={scopeId} onChange={(event) => setScopeId(event.target.value)}><option value="global">全局默认规则</option>{stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>{scopeId !== "global" ? <span className={inherited ? "inherit-pill" : "override-pill"}>{inherited ? "当前继承全局" : "当前为站点覆盖"}</span> : null}{scopeId !== "global" && !inherited ? <button type="button" className="text-button" onClick={() => void restore()}><ArrowCounterClockwise />恢复继承</button> : null}</div><div className="rule-fields"><label><span>往返起步价</span><div><i>¥</i><input type="number" step="1" value={money(rule.baseFeeFen)} onChange={(event) => update("baseFeeFen", Math.round(Number(event.target.value) * 100))} /></div><small>已包含送回，不另收返程费</small></label><label><span>包含单程里程</span><div><input type="number" step="0.1" value={rule.includedKm} onChange={(event) => update("includedKm", Number(event.target.value))} /><i>公里</i></div><small>取车点到检测站</small></label><label><span>超出单价</span><div><i>¥</i><input type="number" step="1" value={money(rule.perKmFen)} onChange={(event) => update("perKmFen", Math.round(Number(event.target.value) * 100))} /></div><small>超出部分按整公里向上取整</small></label><label className="radius-field"><span>最大服务距离</span><label className="inline-check"><input type="checkbox" checked={rule.maxRadiusKm == null} onChange={(event) => update("maxRadiusKm", event.target.checked ? null : 20)} />不限制距离</label><div><input disabled={rule.maxRadiusKm == null} type="number" step="1" value={rule.maxRadiusKm ?? ""} onChange={(event) => update("maxRadiusKm", Number(event.target.value))} /><i>公里</i></div><small>为空表示有钱即可预约；仍须腾讯路线可用</small></label></div><div className="formula"><strong>公开计算公式</strong><code>往返取送费 = 起步价 ¥{money(rule.baseFeeFen)} + 向上取整（腾讯单程距离 − 包含里程 {rule.includedKm} 公里，最低按 0 计算）× 超出单价 ¥{money(rule.perKmFen)}</code><p>示例：11.7 公里 → ¥{money(rule.baseFeeFen)} + {Math.max(0, Math.ceil(11.7 - rule.includedKm))} 公里 × ¥{money(rule.perKmFen)} = ¥{money(rule.baseFeeFen + Math.max(0, Math.ceil(11.7 - rule.includedKm)) * rule.perKmFen)}</p></div><footer><span>{saved ? <><CheckCircle weight="fill" />{saved}</> : `最后更新：${shanghaiTime(rule.updatedAt) || "时间待核对"}`}</span><button><FloppyDisk />{scopeId !== "global" && inherited ? "创建站点覆盖" : "保存计价规则"}</button></footer></form><section className="example-card"><header><small>价格试算</small><h2>真实口径试算</h2></header>{examples.map((item) => <div key={item.distance}><span><MapPin />单程 {item.distance} 公里<small>超出 {item.extra} 公里</small></span><strong>¥{money(item.fee)}</strong></div>)}<p><ShieldCheck />仅腾讯真实驾车路线可生成取送报价；地图服务密钥无权限、超时或超额时会阻止下单，不回退估算。</p></section></div>;
}
