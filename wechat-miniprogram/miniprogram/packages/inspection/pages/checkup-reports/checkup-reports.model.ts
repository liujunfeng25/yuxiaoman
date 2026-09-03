import type {
  BookingStatus,
  CheckupConclusion,
  CheckupConclusionStatus,
  Vehicle,
  VehicleCheckupReportProgress,
  VehicleCheckupReportSummary,
  VehicleCheckupReportVehicleSummary,
} from "../../../../types";

export type VehicleFilterSource = { id: string; plateNumber: string; displayName: string };
export type VehicleFilterView = VehicleFilterSource & { selected: boolean; className: string; ariaLabel: string };

export type ProgressCardView = VehicleCheckupReportProgress & {
  kind: "active" | "report-ready" | "report-missing";
  tone: "primary" | "success" | "danger";
  badgeText: string;
  iconPath: string;
  title: string;
  statusText: string;
  appointmentText: string;
  updatedText: string;
  serviceModeText: string;
  conclusionText: string;
  stationText: string;
  ariaLabel: string;
};

export type ReportCardView = VehicleCheckupReportSummary & {
  publishedText: string;
  appointmentText: string;
  serviceModeText: string;
  conclusionText: string;
  conclusionTone: "passed" | "failed" | "pending";
  stationText: string;
  fixedPhotoText: string;
  faultText: string;
  faultPhotoText: string;
  markText: string;
  legalMaterialText: string;
  isLegacyV1: boolean;
  ariaLabel: string;
};

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending_payment: "待支付",
  paid_pending_confirmation: "已支付",
  pending_precheck: "待检测站预审",
  precheck_rejected: "预审未通过",
  confirmed: "预约已确认",
  driver_arranged: "司机已安排",
  picked_up: "司机已取车，前往检测站",
  awaiting_arrival: "待到站",
  checked_in: "车辆已到检测站",
  inspecting: "检测中",
  result_received: "检测结果已回传",
  returning: "车辆送回中",
  completed: "服务已完成",
  on_hold: "服务暂缓",
  cancelled: "已取消",
  no_show: "已爽约",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function dateTimeText(value?: string | null): string {
  if (!value) return "时间待同步";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).replace("T", " ").slice(0, 16);
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function appointmentText(date: string, startTime: string, endTime: string): string {
  const day = String(date || "日期待确认").replace(/-/g, ".");
  const slot = [startTime, endTime].filter(Boolean).join("–");
  return slot ? `${day} · ${slot}` : day;
}

export function serviceModeText(mode: string): string {
  return mode === "valet" ? "上门取送车" : "车主自驾到站";
}

export function conclusionText(value: CheckupConclusion | null, status?: CheckupConclusionStatus): string {
  if (value === "passed") return "通过";
  if (value === "failed") return "未通过";
  if (status === "legacy_requires_reentry") return "历史结果待重新录入";
  return "结果未确认";
}

function stationText(name: string, district: string): string {
  return [name || "机动车检测站", district].filter(Boolean).join(" · ");
}

export function progressCard(item: VehicleCheckupReportProgress): ProgressCardView {
  const missing = item.progressType === "result_pending_report" && !item.reportReady;
  const ready = item.reportReady;
  const kind = missing ? "report-missing" : ready ? "report-ready" : "active";
  const badgeText = missing ? "材料闭环不完整" : ready ? "报告已生成 · 履约继续" : "履约中 · 报告待回传";
  const title = missing ? "未形成结构化车辆体检报告" : ready ? "报告可查看，服务尚未结束" : "检测站正在推进年检服务";
  const statusText = STATUS_LABELS[item.fulfillmentStatus] || STATUS_LABELS[item.bookingStatus] || "进度待同步";
  const plate = item.vehicle.plateNumber || "待补充车牌";
  return {
    ...item,
    kind,
    tone: missing ? "danger" : ready ? "success" : "primary",
    badgeText,
    iconPath: missing ? "/assets/icons/warning-circle.png" : ready ? "/assets/icons/check-circle.png" : "/assets/icons/clock.png",
    title,
    statusText,
    appointmentText: appointmentText(item.appointmentDate, item.startTime, item.endTime),
    updatedText: dateTimeText(item.resultReceivedAt || item.updatedAt),
    serviceModeText: serviceModeText(item.serviceMode),
    conclusionText: conclusionText(item.conclusion, item.conclusionStatus),
    stationText: stationText(item.station.name, item.station.district),
    ariaLabel: `${plate}，${badgeText}，当前${statusText}，${ready ? "可查看报告和履约进度" : "可查看订单进度"}`,
  };
}

export function reportCard(item: VehicleCheckupReportSummary): ReportCardView {
  const conclusion = conclusionText(item.conclusion, item.conclusionStatus);
  const conclusionTone = item.conclusion === "passed" || item.conclusion === "failed" ? item.conclusion : "pending";
  const plate = item.vehicle.plateNumber || "待补充车牌";
  const fixedCount = Math.min(5, Math.max(0, item.sitePhotoCount));
  const station = stationText(item.station.name, item.station.district);
  const serviceMode = serviceModeText(item.serviceMode);
  const markText = item.hasAnnualMark
    ? "检验合格标志/电子凭证留证已附"
    : item.conclusion === "failed"
      ? "未通过，不形成检验合格凭证留证"
      : item.conclusionStatus === "legacy_requires_reentry"
        ? "旧结论已停用，年检结果待重新录入"
        : item.schemaVersion === "vehicle-checkup-v1"
          ? "历史报告未提供检验合格凭证留证"
          : item.conclusion === "passed"
            ? "检验合格凭证留证尚未同步"
            : "检验合格凭证留证状态待同步";
  const legalMaterialText = item.hasSafetyInspectionReport
    ? `安全检验报告已附${item.hasEmissionsInspectionReport ? " · 排放报告已附" : ""}`
    : "历史报告未采集法定检测材料";
  return {
    ...item,
    publishedText: dateTimeText(item.publishedAt),
    appointmentText: appointmentText(item.appointmentDate, item.startTime, item.endTime),
    serviceModeText: serviceModeText(item.serviceMode),
    conclusionText: conclusion,
    conclusionTone,
    stationText: station,
    fixedPhotoText: `${fixedCount}/5`,
    faultText: `${Math.max(0, item.faultCount)} 项`,
    faultPhotoText: `${Math.max(0, item.faultPhotoCount)} 张`,
    markText,
    legalMaterialText,
    isLegacyV1: item.schemaVersion === "vehicle-checkup-v1",
    ariaLabel: `${plate}，平台报告编号${item.reportNo || "待同步"}，年检结论${conclusion}，${station}，${serviceMode}，生成时间${dateTimeText(item.publishedAt)}，平台车辆体检留证${fixedCount}/5，${item.faultCount}项车身问题，${item.faultPhotoCount}张故障特写，${legalMaterialText}，${markText}，点击查看报告`,
  };
}

export function vehicleSource(value: Vehicle | VehicleCheckupReportVehicleSummary): VehicleFilterSource {
  const vehicle = value as Vehicle;
  const brandName = "brandName" in value ? value.brandName : vehicle.brand?.name;
  const modelName = "modelName" in value ? value.modelName : vehicle.model?.name;
  const displayName = "displayName" in value
    ? value.displayName
    : [brandName, modelName].filter(Boolean).join(" ") || vehicle.vehicleType || "车辆档案";
  return { id: String(value.id || ""), plateNumber: String(value.plateNumber || "待补充车牌"), displayName: String(displayName) };
}

export function vehicleFilters(sources: VehicleFilterSource[], selectedId: string): VehicleFilterView[] {
  const unique = new Map<string, VehicleFilterSource>();
  for (const source of sources) {
    if (source.id && !unique.has(source.id)) unique.set(source.id, source);
  }
  const all: VehicleFilterSource[] = [{ id: "", plateNumber: "全部车辆", displayName: "查看所有报告" }, ...unique.values()];
  return all.map((item) => {
    const selected = item.id === selectedId;
    const label = item.id ? item.plateNumber : "全部车辆";
    return {
      ...item,
      selected,
      className: selected ? "vehicle-filter-chip selected" : "vehicle-filter-chip",
      ariaLabel: `${label}筛选${selected ? "，当前已选中" : ""}`,
    };
  });
}
