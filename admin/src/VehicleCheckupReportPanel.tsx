import { useEffect, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight, CheckCircle, MagnifyingGlass, Printer, WarningCircle, X } from "@phosphor-icons/react";
import { AuthenticatedEvidenceImage } from "./AuthenticatedEvidenceImage";
import "./vehicle-checkup.css";

export type CheckupView = "top" | "left" | "right";
export type CheckupConclusion = "passed" | "failed";
export type CheckupConclusionStatus = "available" | "pending" | "legacy_requires_reentry";

export type VehicleCheckupFault = {
  id: string;
  sequence?: number;
  clientKey?: string | null;
  viewId: CheckupView;
  regionCode: string;
  faultType: "scratch" | "dent" | "paint_damage" | "crack" | "broken" | "rust" | "other";
  severity: "minor" | "moderate" | "severe";
  description?: string | null;
  photos?: VehicleCheckupMedia[];
};

export type FixedCheckupMediaKind = "front_left" | "front_right" | "rear_left" | "rear_right" | "dashboard_started" | "safety_inspection_report" | "emissions_inspection_report" | "annual_inspection_mark";

export type VehicleCheckupMedia = {
  id: string;
  bookingId: string;
  reportId: string;
  faultId?: string | null;
  kind: FixedCheckupMediaKind | "fault_closeup";
  sequence?: number;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  status: "staged" | "bound";
  createdAt: string;
  boundAt?: string | null;
  expiresAt: string;
};

export type VehicleCheckupReport = {
  id: string;
  bookingId: string;
  reportNo: string;
  schemaVersion: string;
  status: "draft" | "published";
  diagramVersion: string;
  observationMode: "no_visible_faults" | "faults_recorded" | null;
  summary: Record<string, unknown>;
  rowVersion: number;
  annualInspection?: {
    conclusion: CheckupConclusion | null;
    conclusionStatus?: CheckupConclusionStatus;
    summary?: Record<string, unknown> | null;
    failureDetails?: { itemCategories: string[]; reason: string; reinspectionAdvice: string } | null;
    failureDetailsStatus?: "complete" | "not_applicable" | "pending" | "legacy_missing_details";
    markStatus?: "issued" | "not_issued" | null;
    markPhoto?: VehicleCheckupMedia | null;
  } | null;
  legalMaterials?: {
    safetyInspectionReport?: VehicleCheckupMedia | null;
    emissionsInspectionReport?: VehicleCheckupMedia | null;
    annualInspectionMark?: VehicleCheckupMedia | null;
    status?: "available" | "pending" | "legacy_missing";
  } | null;
  sitePhotos: {
    frontLeft: VehicleCheckupMedia | null;
    frontRight: VehicleCheckupMedia | null;
    rearLeft: VehicleCheckupMedia | null;
    rearRight: VehicleCheckupMedia | null;
    dashboardStarted: VehicleCheckupMedia | null;
  };
  faults: VehicleCheckupFault[];
  media: VehicleCheckupMedia[];
  createdAt: string;
  publishedAt?: string | null;
  updatedAt: string;
  retainUntil?: string | null;
};

export type VehicleCheckupBookingContext = {
  bookingNumber: string;
  appointmentDate: string;
  startTime: string;
  endTime: string;
};

export type VehicleCatalogIdentity = string | { id?: string; name?: string };

export type VehicleCheckupVehicleContext = {
  plateNumber: string;
  vehicleType: string;
  seats: number;
  brand?: VehicleCatalogIdentity | null;
  model?: VehicleCatalogIdentity | null;
};

export type VehicleCheckupStationContext = {
  name: string;
  district?: string;
  address?: string;
};

type RegionAnchor = { viewId: CheckupView; regionCode: string; label: string; x: number; y: number };

const regionAnchors: RegionAnchor[] = [
  { viewId: "top", regionCode: "front_bumper", label: "前保险杠", x: 50, y: 13 },
  { viewId: "top", regionCode: "front_face", label: "前脸与灯组", x: 50, y: 22 },
  { viewId: "top", regionCode: "hood", label: "发动机舱盖", x: 50, y: 33 },
  { viewId: "top", regionCode: "windshield", label: "前挡风玻璃", x: 50, y: 43 },
  { viewId: "top", regionCode: "roof", label: "车顶", x: 50, y: 55 },
  { viewId: "top", regionCode: "rear_glass", label: "后挡风玻璃", x: 50, y: 66 },
  { viewId: "top", regionCode: "trunk_tailgate", label: "后备厢盖与尾门", x: 50, y: 76 },
  { viewId: "top", regionCode: "rear_bumper", label: "后保险杠", x: 50, y: 87 },
  { viewId: "left", regionCode: "left_mirror", label: "左后视镜", x: 35, y: 36 },
  { viewId: "left", regionCode: "left_front_fender", label: "左前翼子板", x: 35, y: 59 },
  { viewId: "left", regionCode: "left_front_door", label: "左前门", x: 44, y: 52 },
  { viewId: "left", regionCode: "left_rear_door", label: "左后门", x: 61, y: 52 },
  { viewId: "left", regionCode: "left_rear_quarter", label: "左后翼子板", x: 75, y: 50 },
  { viewId: "left", regionCode: "left_sill", label: "左侧裙", x: 53, y: 72 },
  { viewId: "right", regionCode: "right_mirror", label: "右后视镜", x: 65, y: 36 },
  { viewId: "right", regionCode: "right_front_fender", label: "右前翼子板", x: 65, y: 59 },
  { viewId: "right", regionCode: "right_front_door", label: "右前门", x: 56, y: 52 },
  { viewId: "right", regionCode: "right_rear_door", label: "右后门", x: 39, y: 52 },
  { viewId: "right", regionCode: "right_rear_quarter", label: "右后翼子板", x: 26, y: 48 },
  { viewId: "right", regionCode: "right_sill", label: "右侧裙", x: 47, y: 72 },
];

const viewLabels: Record<CheckupView, string> = { top: "俯视", left: "左侧", right: "右侧" };
const regionLabels = Object.fromEntries(regionAnchors.map((item) => [item.regionCode, item.label]));
const faultLabels: Record<VehicleCheckupFault["faultType"], string> = {
  scratch: "划痕",
  dent: "凹陷",
  paint_damage: "掉漆",
  crack: "裂纹",
  broken: "破损",
  rust: "锈蚀",
  other: "其他",
};
const severityLabels: Record<VehicleCheckupFault["severity"], string> = { minor: "轻微", moderate: "一般", severe: "明显" };
const mediaLabels: Record<FixedCheckupMediaKind, string> = {
  front_left: "车辆左前",
  front_right: "车辆右前",
  rear_left: "车辆左后",
  rear_right: "车辆右后",
  dashboard_started: "启动后仪表盘",
  safety_inspection_report: "机动车安全技术检验报告",
  emissions_inspection_report: "排放检验报告",
  annual_inspection_mark: "检验合格标志/电子凭证留证",
};
const sitePhotoKinds: FixedCheckupMediaKind[] = ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"];
const legalMaterialKinds: FixedCheckupMediaKind[] = ["safety_inspection_report", "emissions_inspection_report", "annual_inspection_mark"];

type PreviewState =
  | { group: "site" | "result"; index: number }
  | { group: "fault"; faultId: string; index: number };

function conclusionLabel(conclusion: CheckupConclusion | null | undefined, status?: CheckupConclusionStatus) {
  if (conclusion === "passed") return "年检通过";
  if (conclusion === "failed") return "年检未通过";
  if (status === "legacy_requires_reentry") return "历史结果待重新录入";
  return "正式结果未确认";
}

function conclusionTone(conclusion: CheckupConclusion | null | undefined) {
  return conclusion === "passed" || conclusion === "failed" ? conclusion : "pending";
}

const annualFailureCategoryLabels: Record<string, string> = {
  vehicle_uniqueness: "车辆唯一性检查",
  vehicle_characteristics: "车辆特征参数检查",
  vehicle_appearance: "车辆外观检查（官方年检项目）",
  safety_devices: "安全装置检查",
  chassis_dynamic: "底盘动态检验",
  vehicle_underbody: "车辆底盘部件检查",
  instrumented_test: "仪器设备检验",
  emissions: "排放检验",
  other_official_item: "其他官方检验项目",
};

function annualFailureDetails(summary: Record<string, unknown> | null | undefined) {
  const source = summary || {};
  const categoryValues = Array.isArray(source.itemCategories) ? source.itemCategories.map(String) : [];
  return {
    categories: categoryValues.map((value) => annualFailureCategoryLabels[value] || value),
    reason: typeof source.reason === "string" ? source.reason.trim() : "",
    retestAdvice: typeof source.reinspectionAdvice === "string" ? source.reinspectionAdvice.trim() : "",
  };
}

function reportSummaryText(summary: Record<string, unknown>) {
  for (const key of ["text", "summary", "message", "note", "description"]) {
    const value = summary[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "检测站已完成车辆外观、现场影像与检测结论记录。";
}

function reportTime(value: string | null | undefined) {
  if (!value) return "待发布";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function vehicleCatalogName(value: VehicleCatalogIdentity | null | undefined) {
  if (typeof value === "string") return value.trim();
  if (!value) return "";
  if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
  if (typeof value.id === "string" && value.id.trim()) return value.id.trim();
  return "";
}

function reportMediaGroups(report: VehicleCheckupReport) {
  const result = new Map<FixedCheckupMediaKind, VehicleCheckupMedia>();
  const includeAnnualMark = report.annualInspection?.conclusion === "passed";
  for (const item of report.media || []) {
    if (item.kind !== "fault_closeup" && (item.kind !== "annual_inspection_mark" || includeAnnualMark)) result.set(item.kind, item);
  }
  const structured: Record<FixedCheckupMediaKind, VehicleCheckupMedia | null | undefined> = {
    front_left: report.sitePhotos?.frontLeft,
    front_right: report.sitePhotos?.frontRight,
    rear_left: report.sitePhotos?.rearLeft,
    rear_right: report.sitePhotos?.rearRight,
    dashboard_started: report.sitePhotos?.dashboardStarted,
    safety_inspection_report: report.legalMaterials?.safetyInspectionReport,
    emissions_inspection_report: report.legalMaterials?.emissionsInspectionReport,
    annual_inspection_mark: includeAnnualMark
      ? report.legalMaterials?.annualInspectionMark || report.annualInspection?.markPhoto
      : null,
  };
  const visibleKinds = includeAnnualMark
    ? [...sitePhotoKinds, ...legalMaterialKinds]
    : [...sitePhotoKinds, "safety_inspection_report" as const, "emissions_inspection_report" as const];
  for (const kind of visibleKinds) {
    const item = structured[kind];
    if (!result.has(kind) && item) result.set(kind, item);
  }
  const visible = visibleKinds.flatMap((kind) => {
    const item = result.get(kind);
    return item ? [item] : [];
  });
  return {
    sitePhotos: visible.filter((item) => item.kind !== "fault_closeup" && sitePhotoKinds.includes(item.kind)),
    legalMaterials: visible.filter((item) => item.kind !== "fault_closeup" && legalMaterialKinds.includes(item.kind)),
  };
}

function faultPhotos(fault: VehicleCheckupFault) {
  return [...(fault.photos || [])].sort((left, right) =>
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt.localeCompare(right.createdAt),
  );
}

function faultEvidenceComplete(fault: VehicleCheckupFault) {
  const count = fault.photos?.length ?? 0;
  return count >= 1 && count <= 3;
}

function mediaLabel(media: VehicleCheckupMedia) {
  return media.kind === "fault_closeup" ? "故障特写" : mediaLabels[media.kind];
}

function conditionConclusion(report: VehicleCheckupReport) {
  if (report.observationMode === "no_visible_faults" || report.faults.length === 0) {
    return "本次人工环车检查未记录明显车身外观异常。";
  }
  const counts = report.faults.reduce((result, fault) => ({ ...result, [fault.severity]: result[fault.severity] + 1 }), { minor: 0, moderate: 0, severe: 0 });
  return `本次人工环车检查共记录 ${report.faults.length} 项外观问题，其中明显 ${counts.severe} 项、一般 ${counts.moderate} 项、轻微 ${counts.minor} 项。`;
}

function faultRecommendation(fault: VehicleCheckupFault) {
  if (fault.faultType === "broken" || fault.faultType === "crack") return "建议尽快交由专业维修机构检查，确认结构与使用安全后再处理。";
  if (fault.faultType === "rust") return "建议清理锈蚀并检查漆层，避免锈蚀范围继续扩大。";
  if (fault.severity === "severe") return "建议交车前与客户确认，并尽快安排钣金或漆面专业检修。";
  if (fault.severity === "moderate") return "建议留存照片并安排钣金或漆面检查，确认后续修复方案。";
  return "建议清洁后复核，可视情况局部抛光、补漆并持续观察。";
}

function summaryRecommendation(report: VehicleCheckupReport) {
  if (!report.faults.length) return "建议交车或送回前再次环车确认，并由客户核对现场照片。";
  const severeCount = report.faults.filter((fault) => fault.severity === "severe").length;
  if (severeCount) return `共 ${severeCount} 项明显问题，建议优先与客户确认并安排专业检修；其余项目按明细留存、跟进。`;
  return "建议交车或送回前与客户逐项核对，保留照片记录，并按明细安排外观维护。";
}

export function VehicleCheckupReportPanel({
  report,
  booking,
  vehicle,
  station,
  serviceMode,
}: {
  report: VehicleCheckupReport;
  booking: VehicleCheckupBookingContext;
  vehicle?: VehicleCheckupVehicleContext;
  station?: VehicleCheckupStationContext;
  serviceMode: "self_drive" | "valet";
}) {
  const initialFault = report.faults[0] ?? null;
  const [viewId, setViewId] = useState<CheckupView>(initialFault?.viewId ?? "left");
  const [activeFaultId, setActiveFaultId] = useState<string | null>(initialFault?.id ?? null);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const activeFault = report.faults.find((item) => item.id === activeFaultId) ?? null;
  const activeFaultNumber = activeFault ? report.faults.findIndex((item) => item.id === activeFault.id) + 1 : 0;
  const activeFaultPhotos = activeFault ? faultPhotos(activeFault) : [];
  const currentFaults = report.faults.filter((item) => item.viewId === viewId);
  const currentAnchors = regionAnchors.filter((item) => item.viewId === viewId);
  const mediaGroups = useMemo(() => reportMediaGroups(report), [report]);
  const siteMedia = mediaGroups.sitePhotos;
  const legalMaterials = mediaGroups.legalMaterials;
  const sitePhotoCount = siteMedia.length;
  const missingSiteLabels = sitePhotoKinds.filter((kind) => !siteMedia.some((item) => item.kind === kind)).map((kind) => mediaLabels[kind]);
  const hasSafetyInspectionReport = legalMaterials.some((item) => item.kind === "safety_inspection_report");
  const hasEmissionsInspectionReport = legalMaterials.some((item) => item.kind === "emissions_inspection_report");
  const hasAnnualInspectionMark = legalMaterials.some((item) => item.kind === "annual_inspection_mark");
  const evidenceCompleteCount = report.faults.filter(faultEvidenceComplete).length;
  const faultPhotoCount = report.faults.reduce((count, fault) => count + (fault.photos?.length ?? 0), 0);
  const incompleteFaultCount = report.faults.length - evidenceCompleteCount;
  const legacyWithoutFaultPhotos = report.schemaVersion === "vehicle-checkup-v1" && incompleteFaultCount > 0;
  const legacyUnconfirmedConclusion = report.annualInspection?.conclusionStatus === "legacy_requires_reentry";
  const failureDetails = annualFailureDetails(report.annualInspection?.failureDetails);
  const previewFault = previewState?.group === "fault" ? report.faults.find((item) => item.id === previewState.faultId) ?? null : null;
  const previewItems = previewState?.group === "site"
    ? siteMedia
    : previewState?.group === "result"
      ? legalMaterials
    : previewFault
      ? faultPhotos(previewFault)
      : [];
  const preview = previewState ? previewItems[previewState.index] ?? null : null;
  const previewFaultNumber = previewFault ? report.faults.findIndex((item) => item.id === previewFault.id) + 1 : 0;
  const previewTitle = previewState?.group === "fault" && previewFault
    ? `故障 #${previewFaultNumber} · ${regionLabels[previewFault.regionCode] || previewFault.regionCode}特写`
    : preview ? mediaLabel(preview) : "报告照片";

  const closePreview = () => {
    setPreviewState(null);
    window.requestAnimationFrame(() => previewTriggerRef.current?.focus());
  };

  useEffect(() => {
    if (!previewState || !previewItems.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        setPreviewState((current) => current ? { ...current, index: (current.index + direction + previewItems.length) % previewItems.length } : null);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = lightboxRef.current;
      const focusable = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [previewState, previewItems.length]);

  const activateFault = (fault: VehicleCheckupFault) => {
    setViewId(fault.viewId);
    setActiveFaultId(fault.id);
  };

  const selectView = (nextViewId: CheckupView) => {
    setViewId(nextViewId);
    setActiveFaultId(report.faults.find((fault) => fault.viewId === nextViewId)?.id ?? null);
  };

  const previewFixedMedia = (group: "site" | "result", index: number, trigger: HTMLButtonElement) => {
    previewTriggerRef.current = trigger;
    setPreviewState({ group, index });
  };

  const previewFaultMedia = (fault: VehicleCheckupFault, index: number, trigger: HTMLButtonElement) => {
    previewTriggerRef.current = trigger;
    setPreviewState({ group: "fault", faultId: fault.id, index });
  };

  return <section className="checkup-report" aria-label="车辆体检报告">
    <header className="checkup-report-head">
      <div><small>VEHICLE CONDITION REPORT</small><h3>车辆体检报告</h3><p>{report.reportNo}</p></div>
      <div className="checkup-report-actions"><span className={`checkup-conclusion conclusion-${report.status === "published" ? conclusionTone(report.annualInspection?.conclusion) : "pending"}`}>{report.status === "published" ? conclusionLabel(report.annualInspection?.conclusion, report.annualInspection?.conclusionStatus) : "报告草稿"}</span><button type="button" onClick={() => window.print()}><Printer />打印报告</button></div>
    </header>

    <section className="checkup-evidence-summary" aria-label="报告材料摘要">
      <div className={hasSafetyInspectionReport ? "complete" : "incomplete"}><small>法定检测材料</small><strong>{hasSafetyInspectionReport ? "安全报告已归档" : "安全报告缺失"}</strong><span>{hasEmissionsInspectionReport ? "含排放检验报告" : "排放报告未提供（选填）"}</span></div>
      <div className={sitePhotoCount === 5 ? "complete" : "incomplete"}><small>平台车辆体检留证</small><strong>{sitePhotoCount} / 5</strong><span>四个车身方位与启动后仪表盘</span></div>
      <div className={incompleteFaultCount === 0 ? "complete" : "incomplete"}><small>故障证据</small><strong>{evidenceCompleteCount} / {report.faults.length} 项完整</strong><span>共 {faultPhotoCount} 张故障特写</span></div>
    </section>

    {!hasSafetyInspectionReport ? <section className={`checkup-material-alert ${report.status === "published" ? "legacy" : "incomplete"}`} role="alert" aria-label="法定检测材料缺失提示"><WarningCircle weight="fill" /><div><strong>{report.status === "published" ? "历史报告未采集法定检测材料" : "机动车安全技术检验报告待上传"}</strong><p>{report.status === "published" ? "该历史报告没有对应附件，系统仅展示真实缺失状态，不补造材料。" : "通过或未通过结果发布前，都必须上传检测站出具的机动车安全技术检验报告或检测结果单。"} 平台车辆体检报告不能替代法定检测报告。</p></div></section> : null}

    {missingSiteLabels.length || incompleteFaultCount ? <section className={`checkup-material-alert ${legacyWithoutFaultPhotos ? "legacy" : "incomplete"}`} role="alert" aria-label="报告材料完整性提示"><WarningCircle weight="fill" /><div><strong>{legacyWithoutFaultPhotos ? "历史报告未采集故障特写" : "报告材料闭环不完整"}</strong><p>{missingSiteLabels.length ? `现场基准缺少：${missingSiteLabels.join("、")}。` : ""}{incompleteFaultCount ? legacyWithoutFaultPhotos ? `旧版报告有 ${incompleteFaultCount} 项故障未关联特写照片，仅展示原有文字与固定现场照，不补造影像。` : `有 ${incompleteFaultCount} 项故障的特写数量不符合每项 1–3 张要求，请核对检测站原始材料。` : ""}</p></div></section> : null}

    {legacyUnconfirmedConclusion ? <section className="checkup-material-alert legacy" role="alert" aria-label="历史年检结果待重新录入"><WarningCircle weight="fill" /><div><strong>历史结果待重新录入</strong><p>旧版“待复核”结论已停用。本次正式年检结果尚未确认，需由检测站重新录入“通过”或“未通过”；该历史值不会自动算作未通过。</p></div></section> : null}

    <section className="checkup-report-section checkup-report-meta" aria-label="报告基本信息">
      <header><div><small>REPORT PROFILE</small><h4>报告基本信息</h4></div><span>车身状况为检测站人工记录</span></header>
      <dl>
        <div><dt>平台报告编号</dt><dd>{report.reportNo}</dd></div>
        <div><dt>预约编号</dt><dd>{booking.bookingNumber}</dd></div>
        <div><dt>车辆</dt><dd>{vehicle?.plateNumber || "待核验"} · {[vehicleCatalogName(vehicle?.brand), vehicleCatalogName(vehicle?.model), vehicle?.vehicleType].filter(Boolean).join(" ") || "车型未记录"}</dd></div>
        <div><dt>服务方式</dt><dd>{serviceMode === "valet" ? "上门往返取送" : "车主自驾到站"}</dd></div>
        <div><dt>检测站</dt><dd>{station?.name || "站点未记录"}{station?.district ? ` · ${station.district}` : ""}</dd></div>
        <div><dt>预约时段</dt><dd>{booking.appointmentDate} {booking.startTime}–{booking.endTime}</dd></div>
        <div><dt>报告状态</dt><dd>{report.status === "published" ? "已发布" : "草稿"}</dd></div>
        <div><dt>发布时间</dt><dd>{reportTime(report.publishedAt)}</dd></div>
      </dl>
    </section>

    <section className="checkup-report-section checkup-result-section" aria-label="年检结论与检测说明">
      <div className={`checkup-result-emblem conclusion-${conclusionTone(report.annualInspection?.conclusion)}`}><small>年检结论</small><strong>{report.status === "published" ? conclusionLabel(report.annualInspection?.conclusion, report.annualInspection?.conclusionStatus) : "尚未发布"}</strong><span>{legacyUnconfirmedConclusion ? "正式结果未确认" : hasAnnualInspectionMark ? "检验合格凭证留证已归档" : report.annualInspection?.conclusion === "failed" ? "未通过，不适用合格凭证" : "未形成检验合格凭证留证"}</span></div>
      <div><small>检测说明</small><p>{reportSummaryText(report.summary)}</p><em>年检结论与车身状况分别展示；车况记录不会自动改变年检结论。</em></div>
    </section>

    {report.annualInspection?.conclusion === "failed" ? <section className="checkup-report-section checkup-annual-failure" aria-label="年检未通过明细"><header><div><small>FAILED INSPECTION DETAILS</small><h4>未通过项目与复检安排</h4></div><span>检测站回传</span></header><dl><div><dt>未通过项目类别</dt><dd>{failureDetails.categories.length ? failureDetails.categories.join("、") : "未录入"}</dd></div><div><dt>具体原因 / 检测说明</dt><dd>{failureDetails.reason || "未录入"}</dd></div><div><dt>整改与复检建议</dt><dd>{failureDetails.retestAdvice || "未录入"}</dd></div></dl></section> : null}

    <section className="checkup-report-section checkup-condition-copy" aria-label="车身状况文字结论">
      <small>VEHICLE CONDITION</small><h4>车身状况文字结论</h4><p>{conditionConclusion(report)}</p><span>{report.observationMode === "faults_recorded" ? "以下故障位置、描述及照片由检测站人工确认。" : "检测站已完成现场环车确认。"}</span>
    </section>

    <div className="checkup-tech-panel">
      <div className="checkup-tech-title"><span>车辆故障定位</span><small>{report.faults.length ? `已记录 ${report.faults.length} 项` : "未发现明显异常"}</small></div>
      <div className="checkup-view-tabs" role="tablist" aria-label="车辆视图">
        {(Object.keys(viewLabels) as CheckupView[]).map((item) => <button type="button" role="tab" aria-selected={viewId === item} className={viewId === item ? "active" : ""} key={item} onClick={() => selectView(item)}>{viewLabels[item]}</button>)}
      </div>
      <div className={`checkup-stage view-${viewId}`}>
        <img className="checkup-car" src={`/assets/inspection-checkup/car-${viewId}.webp`} alt={`${viewLabels[viewId]}车辆示意图`} />
        {currentAnchors.map((anchor) => {
          const faults = currentFaults.filter((item) => item.regionCode === anchor.regionCode);
          if (!faults.length) return null;
          const selected = faults.some((item) => item.id === activeFaultId);
          const representativeFault = faults.find((item) => item.id === activeFaultId) ?? faults[0];
          const faultNumber = report.faults.findIndex((item) => item.id === representativeFault.id) + 1;
          const countLabel = `共${faults.length}条车况记录`;
          return <button type="button" key={anchor.regionCode} className={`checkup-hotspot ${selected ? "active" : ""}`} style={{ left: `${anchor.x}%`, top: `${anchor.y}%` }} onClick={() => activateFault(representativeFault)} aria-label={`${anchor.label}，故障 #${faultNumber}，${countLabel}`} title={`${anchor.label} · ${countLabel}`}><i /><b>{faultNumber}</b></button>;
        })}
        {activeFault && activeFault.viewId === viewId ? <div className="checkup-callout" role="status">
          <small>故障 #{report.faults.findIndex((item) => item.id === activeFault.id) + 1}</small>
          <strong>{regionLabels[activeFault.regionCode] || activeFault.regionCode} · {faultLabels[activeFault.faultType]}</strong>
          <span>{severityLabels[activeFault.severity]}{activeFault.description ? ` · ${activeFault.description}` : ""}</span>
        </div> : null}
      </div>
      <p className="checkup-diagram-note">通用车身示意，不代表实车车型；故障以位置文字和现场照片为准</p>
      {activeFault && activeFault.viewId === viewId ? <section className={`checkup-active-evidence ${faultEvidenceComplete(activeFault) ? "complete" : "incomplete"}`} aria-label={`故障 #${activeFaultNumber} 影像证据`}>
        <header><div><small>FAULT EVIDENCE</small><strong>故障 #{activeFaultNumber} · {regionLabels[activeFault.regionCode] || activeFault.regionCode}</strong></div><span>{activeFaultPhotos.length ? `${activeFaultPhotos.length} 张特写` : report.schemaVersion === "vehicle-checkup-v1" ? "历史记录无特写" : "特写缺失"}</span></header>
        {activeFaultPhotos.length ? <div className="checkup-active-evidence-grid">{activeFaultPhotos.map((photo, photoIndex) => <button type="button" key={photo.id} onClick={(event) => previewFaultMedia(activeFault, photoIndex, event.currentTarget)} aria-label={`查看故障 #${activeFaultNumber} ${regionLabels[activeFault.regionCode] || activeFault.regionCode}特写 ${photoIndex + 1}`}><AuthenticatedEvidenceImage url={photo.url} alt={`故障 #${activeFaultNumber} 特写 ${photoIndex + 1}`} /><span><MagnifyingGlass />查看特写 {photoIndex + 1}</span></button>)}</div> : <div className="checkup-evidence-missing"><WarningCircle weight="fill" /><span><strong>{report.schemaVersion === "vehicle-checkup-v1" ? "旧版报告未采集故障特写" : "故障特写缺失"}</strong><small>{report.schemaVersion === "vehicle-checkup-v1" ? "仅保留原有文字记录，不补造影像" : "材料闭环不完整，请核对检测站原始报告"}</small></span></div>}
      </section> : null}
      <div className="checkup-fault-list">
        {report.faults.map((fault, index) => <button type="button" key={fault.id} className={activeFaultId === fault.id ? "active" : ""} onClick={() => activateFault(fault)}><span>{index + 1}</span><div><strong>{regionLabels[fault.regionCode] || fault.regionCode}</strong><small>{faultLabels[fault.faultType]} · {severityLabels[fault.severity]}</small></div>{fault.severity === "severe" ? <WarningCircle weight="fill" /> : null}</button>)}
        {!report.faults.length ? <div className="checkup-no-fault"><span><CheckCircle weight="fill" /></span><div><strong>未发现明显车身异常</strong><small>检测站已完成车辆外观确认</small></div></div> : null}
      </div>
    </div>

    <section className="checkup-report-section checkup-fault-detail" aria-label="故障明细">
      <header><div><small>FAULT DETAILS</small><h4>故障明细</h4></div><span>{report.faults.length} 项</span></header>
      {report.faults.length ? <div className="checkup-fault-cards" role="list" aria-label="车辆故障明细列表">{report.faults.map((fault, index) => {
        const photos = faultPhotos(fault);
        const region = regionLabels[fault.regionCode] || fault.regionCode;
        const evidenceComplete = faultEvidenceComplete(fault);
        return <article className={`checkup-fault-card ${evidenceComplete ? "complete" : "incomplete"}`} role="listitem" aria-label={`故障 #${index + 1} ${region}`} key={fault.id}>
          <header><span>#{index + 1}</span><div><strong>{region} · {faultLabels[fault.faultType]}</strong><small>{viewLabels[fault.viewId]}定位 · 检测站人工记录</small></div><i className={`severity-${fault.severity}`}>{severityLabels[fault.severity]}</i><button type="button" className="checkup-fault-card-locate" onClick={() => activateFault(fault)}>在三视图定位</button></header>
          <div className="checkup-fault-card-copy"><div><small>现场描述</small><p>{fault.description || "检测站未补充描述"}</p></div><div><small>处理建议</small><p>{faultRecommendation(fault)}</p></div></div>
          <section className="checkup-fault-evidence" aria-label={`故障 #${index + 1} 特写照片`}><header><div><small>FAULT CLOSE-UP</small><strong>故障特写</strong></div><span>{photos.length ? `${photos.length} 张 · 已关联故障 #${index + 1}` : report.schemaVersion === "vehicle-checkup-v1" ? "历史记录无特写" : "证据缺失"}</span></header>
            {photos.length ? <div className="checkup-fault-photo-grid">{photos.map((photo, photoIndex) => <figure key={photo.id}><button type="button" onClick={(event) => previewFaultMedia(fault, photoIndex, event.currentTarget)} aria-label={`查看故障 #${index + 1} ${region}特写 ${photoIndex + 1}`}><AuthenticatedEvidenceImage url={photo.url} alt={`故障 #${index + 1} ${region}特写 ${photoIndex + 1}`} /><span><MagnifyingGlass />查看大图</span></button><figcaption>特写 {photo.sequence ?? photoIndex + 1} · {photo.width} × {photo.height}</figcaption></figure>)}</div> : <div className={`checkup-fault-photo-missing ${report.schemaVersion === "vehicle-checkup-v1" ? "legacy" : ""}`}><WarningCircle weight="fill" /><span><strong>{report.schemaVersion === "vehicle-checkup-v1" ? "旧版报告未采集故障特写" : "未形成该故障的影像证据"}</strong><small>{report.schemaVersion === "vehicle-checkup-v1" ? "历史材料仅保留文字与固定现场照片；系统不会补造图片。" : "材料闭环不完整，请核对检测站原始报告与现场资料。"}</small></span></div>}
          </section>
        </article>;
      })}</div> : <div className="checkup-fault-empty"><CheckCircle weight="fill" /><span><strong>未记录明显异常</strong><small>本次报告没有故障明细项</small></span></div>}
    </section>

    <section className="checkup-print-locator" aria-label="打印版故障位置总览">
      <header><div><small>FAULT LOCATION INDEX</small><h4>故障位置总览</h4></div><span>编号与故障明细一致</span></header>
      <div>{(Object.keys(viewLabels) as CheckupView[]).map((printView) => <figure key={printView}><div className={`checkup-print-stage view-${printView}`}><img src={`/assets/inspection-checkup/car-${printView}.webp`} alt={`${viewLabels[printView]}车辆打印示意图`} />{regionAnchors.filter((anchor) => anchor.viewId === printView).map((anchor) => {
        const numbers = report.faults.flatMap((fault, faultIndex) => fault.regionCode === anchor.regionCode && fault.viewId === printView ? [faultIndex + 1] : []);
        return numbers.length ? <span className="checkup-print-marker" key={anchor.regionCode} style={{ left: `${anchor.x}%`, top: `${anchor.y}%` }}><b>{numbers.join("、")}</b></span> : null;
      })}</div><figcaption>{viewLabels[printView]} · {report.faults.filter((fault) => fault.viewId === printView).length} 项</figcaption></figure>)}</div>
    </section>

    <section className="checkup-report-section checkup-advice" aria-label="汇总处理建议">
      <small>ACTION SUGGESTION</small><h4>汇总处理建议</h4><p>{summaryRecommendation(report)}</p><span>建议为平台依据人工车况记录生成的履约提示，具体维修方案由客户与专业维修机构确认。</span>
    </section>

    <section className="checkup-report-section checkup-remarks" aria-label="报告备注">
      <small>REMARKS</small><h4>备注</h4><ul><li>机动车安全技术检验报告、排放检验报告及检验合格标志/电子凭证均作为法定检测材料留证，与平台车辆体检留证分开。</li><li>车身故障位置、程度与描述由检测站人员现场人工记录，并与现场照片共同留存。</li><li>本平台车辆体检报告只呈现履约信息，不替代法定检测报告，不生成检测机构签章或监管系统凭证。</li></ul>
    </section>

    <section className="checkup-media-section checkup-result-material-section" aria-label="法定检测材料">
      <div className="checkup-media-head"><div><small>STATUTORY INSPECTION MATERIALS</small><h4>法定检测材料</h4></div><span>{legalMaterials.length} 件 · {hasSafetyInspectionReport ? "安全报告已归档" : "安全报告缺失"}</span></div>
      <div className="checkup-legal-material-status" role="list" aria-label="法定检测材料完整性"><div className={hasSafetyInspectionReport ? "available" : "missing"}><strong>机动车安全技术检验报告</strong><span>{hasSafetyInspectionReport ? "已归档" : report.status === "published" ? "历史报告未采集" : "必传 · 待上传"}</span></div><div className={hasEmissionsInspectionReport ? "available" : "optional"}><strong>排放检验报告</strong><span>{hasEmissionsInspectionReport ? "已归档" : "选填 · 未提供"}</span></div><div className={hasAnnualInspectionMark ? "available" : report.annualInspection?.conclusion === "passed" ? "missing" : "optional"}><strong>检验合格标志/电子凭证留证</strong><span>{hasAnnualInspectionMark ? "已归档" : report.annualInspection?.conclusion === "passed" ? report.status === "published" ? "历史报告未采集" : "必传 · 待上传" : "未通过 · 不适用"}</span></div></div>
      {legalMaterials.length ? <div className="checkup-media-grid checkup-result-material-grid">{legalMaterials.map((item, index) => <figure key={item.id}><button type="button" onClick={(event) => previewFixedMedia("result", index, event.currentTarget)} aria-label={`查看${mediaLabel(item)}大图`}><AuthenticatedEvidenceImage url={item.url} alt={mediaLabel(item)} /><span><MagnifyingGlass />查看</span></button><figcaption><strong>法定材料 {String(index + 1).padStart(2, "0")} · {mediaLabel(item)}</strong><small>{item.width} × {item.height} · {item.status === "bound" ? "已归档" : "待绑定"}</small></figcaption></figure>)}</div> : <div className="checkup-result-material-empty"><span><strong>{report.status === "published" ? "历史报告未采集法定检测材料" : "法定检测材料尚未上传"}</strong><small>{report.status === "published" ? "系统不会为历史记录补造附件。" : "发布结果前必须补齐机动车安全技术检验报告；排放检验报告为选填。"}</small></span></div>}
    </section>

    <section className="checkup-media-section" aria-label="平台车辆体检留证">
      <div className="checkup-media-head"><div><small>PLATFORM VEHICLE CONDITION EVIDENCE</small><h4>平台车辆体检留证</h4></div><span>{sitePhotoCount} / 5 · 固定 5 张</span></div>
      <div className="checkup-media-grid">{siteMedia.map((item, index) => <figure key={item.id}><button type="button" onClick={(event) => previewFixedMedia("site", index, event.currentTarget)} aria-label={`查看${mediaLabel(item)}大图`}><AuthenticatedEvidenceImage url={item.url} alt={mediaLabel(item)} /><span><MagnifyingGlass />查看</span></button><figcaption><strong>平台留证 {String(index + 1).padStart(2, "0")} · {mediaLabel(item)}</strong><small>{item.width} × {item.height} · {item.status === "bound" ? "已归档" : "待绑定"}</small></figcaption></figure>)}</div>
    </section>

    <footer className="checkup-report-foot"><span>更新时间：{reportTime(report.updatedAt)}</span><span>至少保留至：{report.retainUntil ? reportTime(report.retainUntil).split(" ")[0] : "提交后计算"}</span></footer>

    {previewState && preview ? <div ref={lightboxRef} className="checkup-lightbox" role="dialog" aria-modal="true" aria-label={`${previewTitle}图片预览`} onMouseDown={(event) => event.target === event.currentTarget && closePreview()}>
      <div><header><strong>{previewTitle}</strong><span>{previewState.index + 1} / {previewItems.length}</span><button type="button" autoFocus onClick={closePreview} aria-label="关闭体检图片预览"><X /></button></header><main>{previewItems.length > 1 ? <button type="button" onClick={() => setPreviewState((current) => current ? { ...current, index: (current.index - 1 + previewItems.length) % previewItems.length } : null)} aria-label="上一张"><CaretLeft /></button> : null}<AuthenticatedEvidenceImage url={preview.url} alt={`${previewTitle} ${previewState.index + 1}大图`} variant="preview" />{previewItems.length > 1 ? <button type="button" onClick={() => setPreviewState((current) => current ? { ...current, index: (current.index + 1) % previewItems.length } : null)} aria-label="下一张"><CaretRight /></button> : null}</main><footer>{preview.width} × {preview.height} · {previewState.group === "fault" ? "仅在当前故障特写组内切换" : previewState.group === "result" ? "仅在法定检测材料组内切换" : "仅在平台车辆体检留证组内切换"}</footer></div>
    </div> : null}
  </section>;
}
