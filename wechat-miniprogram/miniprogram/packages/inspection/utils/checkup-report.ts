import type {
  CheckupConclusion,
  CheckupConclusionStatus,
  CheckupFailureCategory,
  CheckupFailureDetails,
  CheckupFaultSeverity,
  CheckupFaultType,
  CheckupMedia,
  CheckupMediaKind,
  CheckupViewId,
  VehicleCheckupReport,
  VehicleCheckupReportInput,
  VehicleFault,
} from "../../../types";

export type CheckupPhotoSlot = {
  kind: CheckupMediaKind;
  label: string;
  hint: string;
  required: boolean;
  media: CheckupMedia | null;
  uploading: boolean;
};

export type CheckupRegion = {
  code: string;
  viewId: CheckupViewId;
  label: string;
  /** Dot center X as percent of stage width. */
  x: number;
  /** Dot center Y as percent of stage height. */
  y: number;
  /** Callout label center X as percent of stage width. */
  labelX: number;
  /** Callout label center Y as percent of stage height. */
  labelY: number;
};

export const SITE_PHOTO_SLOTS: ReadonlyArray<Omit<CheckupPhotoSlot, "media" | "uploading">> = [
  { kind: "front_left", label: "左前", hint: "完整拍到左前车身", required: true },
  { kind: "front_right", label: "右前", hint: "完整拍到右前车身", required: true },
  { kind: "rear_left", label: "左后", hint: "完整拍到左后车身", required: true },
  { kind: "rear_right", label: "右后", hint: "完整拍到右后车身", required: true },
  { kind: "dashboard_started", label: "启动后仪表盘", hint: "车辆启动后拍摄完整仪表", required: true },
];

export const LEGAL_MATERIAL_SLOTS: ReadonlyArray<Omit<CheckupPhotoSlot, "media" | "uploading">> = [
  {
    kind: "safety_inspection_report",
    label: "机动车安全技术检验报告",
    hint: "拍摄检测站出具的报告或检测结果单",
    required: false,
  },
  {
    kind: "emissions_inspection_report",
    label: "排放检验报告",
    hint: "如检测站出具，请一并留证",
    required: false,
  },
  {
    kind: "annual_inspection_mark",
    label: "检验合格标志/电子凭证留证",
    hint: "仅年检通过时上传纸质标志或电子凭证截图",
    required: true,
  },
];

export const ANNUAL_FAILURE_CATEGORIES = [
  { value: "vehicle_uniqueness", label: "车辆唯一性检查" },
  { value: "vehicle_characteristics", label: "车辆特征参数检查" },
  { value: "vehicle_appearance", label: "车辆外观检查（官方年检项目）" },
  { value: "safety_devices", label: "安全装置检查" },
  { value: "chassis_dynamic", label: "底盘动态检验" },
  { value: "vehicle_underbody", label: "车辆底盘部件检查" },
  { value: "instrumented_test", label: "仪器设备检验" },
  { value: "emissions", label: "排放检验" },
  { value: "other_official_item", label: "其他官方检验项目" },
] as const;

export type AnnualFailureCategory = CheckupFailureCategory;
export type AnnualFailureDetails = {
  categories: AnnualFailureCategory[];
  categoryLabels: string[];
  reason: string;
  retestAdvice: string;
};

const ANNUAL_FAILURE_CATEGORY_VALUES = new Set<string>(ANNUAL_FAILURE_CATEGORIES.map((item) => item.value));

export function annualFailureDetails(value: unknown): AnnualFailureDetails {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawCategories = Array.isArray(record.itemCategories) ? record.itemCategories : [];
  const categories = rawCategories
    .map(String)
    .filter((item): item is AnnualFailureCategory => ANNUAL_FAILURE_CATEGORY_VALUES.has(item));
  return {
    categories: [...new Set(categories)],
    categoryLabels: [...new Set(categories)].map((value) => ANNUAL_FAILURE_CATEGORIES.find((item) => item.value === value)?.label || value),
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
    retestAdvice: typeof record.reinspectionAdvice === "string" ? record.reinspectionAdvice.trim() : "",
  };
}

export function annualInspectionFailureDetails(
  categories: AnnualFailureCategory[] = [],
  reason = "",
  retestAdvice = "",
): CheckupFailureDetails {
  const validCategories = [...new Set(categories.filter((item) => ANNUAL_FAILURE_CATEGORY_VALUES.has(item)))];
  const normalizedReason = reason.trim();
  const normalizedAdvice = retestAdvice.trim();
  return { itemCategories: validCategories, reason: normalizedReason, reinspectionAdvice: normalizedAdvice };
}

export const CHECKUP_REGIONS: ReadonlyArray<CheckupRegion> = [
  // Top view: dots along centerline; labels alternate left/right to avoid stacking.
  { code: "front_bumper", viewId: "top", label: "前保险杠", x: 50, y: 12, labelX: 18, labelY: 10 },
  { code: "front_face", viewId: "top", label: "前脸与灯组", x: 50, y: 21, labelX: 82, labelY: 18 },
  { code: "hood", viewId: "top", label: "发动机舱盖", x: 50, y: 32, labelX: 16, labelY: 30 },
  { code: "windshield", viewId: "top", label: "前挡风玻璃", x: 50, y: 42, labelX: 84, labelY: 40 },
  { code: "roof", viewId: "top", label: "车顶", x: 50, y: 54, labelX: 16, labelY: 54 },
  { code: "rear_glass", viewId: "top", label: "后挡风玻璃", x: 50, y: 65, labelX: 84, labelY: 64 },
  { code: "trunk_tailgate", viewId: "top", label: "后备厢盖与尾门", x: 50, y: 75, labelX: 18, labelY: 76 },
  { code: "rear_bumper", viewId: "top", label: "后保险杠", x: 50, y: 86, labelX: 82, labelY: 88 },
  // Left 3/4 profile (nose toward smaller x): dots on panels; labels fan into margins.
  { code: "left_mirror", viewId: "left", label: "左后视镜", x: 35, y: 46, labelX: 12, labelY: 16 },
  { code: "left_front_fender", viewId: "left", label: "左前翼子板", x: 28, y: 58, labelX: 8, labelY: 48 },
  { code: "left_front_door", viewId: "left", label: "左前门", x: 46, y: 54, labelX: 10, labelY: 70 },
  { code: "left_rear_door", viewId: "left", label: "左后门", x: 66, y: 52, labelX: 82, labelY: 78 },
  { code: "left_rear_quarter", viewId: "left", label: "左后翼子板", x: 88, y: 48, labelX: 96, labelY: 16 },
  { code: "left_sill", viewId: "left", label: "左侧裙", x: 52, y: 76, labelX: 50, labelY: 92 },
  // Right 3/4 profile (nose toward larger x): mirrored layout into outer margins.
  { code: "right_mirror", viewId: "right", label: "右后视镜", x: 62, y: 42, labelX: 88, labelY: 14 },
  { code: "right_front_fender", viewId: "right", label: "右前翼子板", x: 72, y: 54, labelX: 92, labelY: 48 },
  { code: "right_front_door", viewId: "right", label: "右前门", x: 54, y: 50, labelX: 90, labelY: 68 },
  { code: "right_rear_door", viewId: "right", label: "右后门", x: 34, y: 48, labelX: 18, labelY: 74 },
  { code: "right_rear_quarter", viewId: "right", label: "右后翼子板", x: 12, y: 44, labelX: 4, labelY: 16 },
  { code: "right_sill", viewId: "right", label: "右侧裙", x: 48, y: 68, labelX: 50, labelY: 88 },
];

/** Stage frame aspect (height / width) from `.vehicle-visual-frame { padding-top: 66.6667% }`. */
const CALLOUT_STAGE_ASPECT = 2 / 3;

export type RegionCalloutLayout = {
  code: string;
  label: string;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  dotStyle: string;
  labelStyle: string;
  lineStyle: string;
  lineLength: number;
  lineAngle: number;
};

/**
 * Build absolute styles for a hotspot callout: pin + leader line + label chip.
 * Line length is percent of stage width; angle accounts for the non-square stage.
 */
export function buildRegionCallout(region: CheckupRegion): RegionCalloutLayout {
  const dx = region.labelX - region.x;
  const dy = region.labelY - region.y;
  const lineLength = Math.hypot(dx, dy * CALLOUT_STAGE_ASPECT);
  const lineAngle = Math.atan2(dy * CALLOUT_STAGE_ASPECT, dx) * (180 / Math.PI);
  return {
    code: region.code,
    label: region.label,
    x: region.x,
    y: region.y,
    labelX: region.labelX,
    labelY: region.labelY,
    dotStyle: `left:${region.x}%;top:${region.y}%`,
    labelStyle: `left:${region.labelX}%;top:${region.labelY}%`,
    lineStyle: `left:${region.x}%;top:${region.y}%;width:${lineLength.toFixed(3)}%;transform:rotate(${lineAngle.toFixed(2)}deg)`,
    lineLength,
    lineAngle,
  };
}

export function buildRegionCallouts(viewId: CheckupViewId): RegionCalloutLayout[] {
  return CHECKUP_REGIONS.filter((item) => item.viewId === viewId).map(buildRegionCallout);
}

/**
 * Place the fault detail bubble near the callout label (outer margin),
 * not over the car body — avoids covering other hotspots.
 */
export function buildFaultBubbleStyle(region: Pick<CheckupRegion, "labelX" | "labelY">): string {
  const widthPct = 36;
  const left = region.labelX >= 50
    ? Math.max(4, Math.min(60, region.labelX - widthPct - 2))
    : Math.max(4, Math.min(60, region.labelX + 4));
  const top = Math.max(4, Math.min(68, region.labelY < 28 ? region.labelY + 10 : region.labelY - 20));
  return `left:${left}%;top:${top}%`;
}

const FAULT_TYPE_LABELS: Record<CheckupFaultType, string> = {
  scratch: "剐蹭/划痕",
  dent: "凹陷",
  paint_damage: "掉漆",
  crack: "裂纹",
  broken: "破损",
  rust: "锈蚀",
  other: "其他",
};

const SEVERITY_LABELS: Record<CheckupFaultSeverity, string> = {
  minor: "轻微",
  moderate: "一般",
  severe: "明显",
};

export function faultTypeLabel(value: CheckupFaultType): string { return FAULT_TYPE_LABELS[value]; }
export function severityLabel(value: CheckupFaultSeverity): string { return SEVERITY_LABELS[value]; }
export function conclusionLabel(value: CheckupConclusion | null | undefined, status?: CheckupConclusionStatus): string {
  if (value === "passed") return "通过";
  if (value === "failed") return "未通过";
  if (status === "legacy_requires_reentry") return "历史结果待重新录入";
  return "待填写";
}
export function regionLabel(code: string): string { return CHECKUP_REGIONS.find((item) => item.code === code)?.label || "车身位置"; }

export function summaryPayload(text: string): Record<string, unknown> {
  const normalized = text.trim();
  return normalized ? { text: normalized } : {};
}

export function extractSummaryText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    for (const key of ["text", "summary", "description", "note"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return "";
}

export function reportMedia(report: VehicleCheckupReport | null | undefined, kind: CheckupMediaKind): CheckupMedia | null {
  if (!report) return null;
  const fromList = (report.media || []).find((item) => item.kind === kind);
  if (fromList) return fromList;
  const map: Partial<Record<CheckupMediaKind, CheckupMedia | null | undefined>> = {
    front_left: report.sitePhotos?.frontLeft,
    front_right: report.sitePhotos?.frontRight,
    rear_left: report.sitePhotos?.rearLeft,
    rear_right: report.sitePhotos?.rearRight,
    dashboard_started: report.sitePhotos?.dashboardStarted,
    safety_inspection_report: report.legalMaterials?.safetyInspectionReport,
    emissions_inspection_report: report.legalMaterials?.emissionsInspectionReport,
    annual_inspection_mark: report.legalMaterials?.annualInspectionMark || report.annualInspection?.markPhoto,
  };
  return map[kind] || null;
}

export function buildPhotoSlots(report: VehicleCheckupReport | null | undefined): CheckupPhotoSlot[] {
  return SITE_PHOTO_SLOTS.map((slot) => ({ ...slot, media: reportMedia(report, slot.kind), uploading: false }));
}

export function replacePhotoSlot(slots: CheckupPhotoSlot[], kind: CheckupMediaKind, media: CheckupMedia | null, uploading = false): CheckupPhotoSlot[] {
  return slots.map((slot) => slot.kind === kind ? { ...slot, media, uploading } : slot);
}

export function upsertFault(faults: VehicleFault[], next: VehicleFault): VehicleFault[] {
  const index = faults.findIndex((item) => item.id === next.id);
  if (index < 0) return [...faults, next];
  return faults.map((item, itemIndex) => itemIndex === index ? next : item);
}

export function faultPhotos(fault: VehicleFault | null | undefined): CheckupMedia[] {
  return [...(fault?.photos || [])]
    .filter((item) => item.kind === "fault_closeup" && Boolean(item.url))
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
}

export function faultPhotoPreviewUrls(fault: VehicleFault | null | undefined): string[] {
  return faultPhotos(fault).map((item) => item.url);
}

/** Build the fault payload without leaking readonly media fields into PUT. */
export function faultDraftInput(fault: VehicleFault): VehicleCheckupReportInput["faults"][number] {
  const clientKey = fault.clientKey || (fault.id.startsWith("local-") ? fault.id : undefined);
  return {
    ...(fault.id.startsWith("local-") ? {} : { id: fault.id }),
    ...(clientKey ? { clientKey } : {}),
    viewId: fault.viewId,
    regionCode: fault.regionCode,
    faultType: fault.faultType,
    severity: fault.severity,
    description: fault.description || null,
  };
}

/** Refresh server-owned ids/photos while keeping unsaved local text edits. */
export function mergeFaultPhotos(localFaults: VehicleFault[], remoteFaults: VehicleFault[]): VehicleFault[] {
  return localFaults.map((local) => {
    const remote = remoteFaults.find((item) => item.id === local.id)
      || (local.clientKey ? remoteFaults.find((item) => item.clientKey === local.clientKey) : undefined)
      || (local.id.startsWith("local-") ? remoteFaults.find((item) => item.clientKey === local.id) : undefined);
    if (!remote) return local;
    return {
      ...local,
      id: remote.id,
      clientKey: remote.clientKey || local.clientKey,
      photos: faultPhotos(remote),
    };
  });
}

/** Apply a successful append/replacement to one fault only. */
export function replaceFaultPhoto(faults: VehicleFault[], faultId: string, media: CheckupMedia, replacePhotoId = ""): VehicleFault[] {
  return faults.map((fault) => {
    if (fault.id !== faultId) return fault;
    const previous = faultPhotos(fault);
    const photos = replacePhotoId
      ? previous.map((item) => item.id === replacePhotoId ? media : item)
      : [...previous.filter((item) => item.id !== media.id), media];
    return { ...fault, photos: photos.sort((left, right) => (left.sequence || 0) - (right.sequence || 0)) };
  });
}

export function removeFaultPhoto(faults: VehicleFault[], faultId: string, mediaId: string): VehicleFault[] {
  return faults.map((fault) => fault.id === faultId
    ? { ...fault, photos: faultPhotos(fault).filter((item) => item.id !== mediaId) }
    : fault);
}

export function faultsForRegion(faults: VehicleFault[], regionCode: string): VehicleFault[] {
  return faults.filter((item) => item.regionCode === regionCode);
}

export type FaultMarkerState = {
  faultCount: number;
  markerLabel: string;
  targetFaultId: string;
};

/**
 * Hotspot numbers always use the fault's position in the global report list.
 * When one region has multiple faults, the selected fault wins; otherwise the
 * first fault in that region is used. The count is deliberately separate.
 */
export function faultMarkerState(faults: VehicleFault[], regionCode: string, activeFaultId = ""): FaultMarkerState {
  const indexed = faults
    .map((fault, index) => ({ fault, number: index + 1 }))
    .filter(({ fault }) => fault.regionCode === regionCode);
  const target = indexed.find(({ fault }) => fault.id === activeFaultId) || indexed[0];
  return {
    faultCount: indexed.length,
    markerLabel: target ? String(target.number) : "+",
    targetFaultId: target?.fault.id || "",
  };
}

export function validateCheckupForSubmit(report: VehicleCheckupReport): string[] {
  const errors: string[] = [];
  const missing = SITE_PHOTO_SLOTS.filter((slot) => !reportMedia(report, slot.kind)).map((slot) => slot.label);
  if (missing.length) errors.push(`请补齐现场照片：${missing.join("、")}`);
  if (!report.observationMode) errors.push("请确认车辆是否存在可见异常");
  if (report.observationMode === "faults_recorded" && !report.faults.length) errors.push("已选择存在异常，请至少添加一条故障记录");
  if (report.observationMode === "no_visible_faults" && report.faults.length) errors.push("无明显异常与故障记录不能同时存在");
  if (report.faults.length) {
    const missingFaultPhotos = report.faults
      .map((fault, index) => faultPhotos(fault).length ? "" : `#${index + 1} ${regionLabel(fault.regionCode)}`)
      .filter(Boolean);
    if (missingFaultPhotos.length) errors.push(`请为以下故障补拍现场特写：${missingFaultPhotos.join("、")}`);
    const excessiveFaultPhotos = report.faults
      .map((fault, index) => faultPhotos(fault).length > 3 ? `#${index + 1} ${regionLabel(fault.regionCode)}` : "")
      .filter(Boolean);
    if (excessiveFaultPhotos.length) errors.push(`每条故障最多保留 3 张特写：${excessiveFaultPhotos.join("、")}`);
  }
  if (report.annualInspection?.conclusionStatus === "legacy_requires_reentry") errors.push("历史结论已停用，请重新选择通过或未通过");
  else if (!report.annualInspection?.conclusion) errors.push("请选择本次年检结论");
  if (report.annualInspection?.conclusion === "failed") {
    const failure = annualFailureDetails(report.annualInspection.failureDetails);
    if (!failure.categories.length) errors.push("请选择至少一个未通过项目类别");
    if (failure.reason.length < 2) errors.push("请填写至少 2 个字的未通过具体原因或检测说明");
    if (failure.retestAdvice.length < 2) errors.push("请填写至少 2 个字的整改与复检建议");
  }
  if (report.annualInspection?.conclusion === "passed" && !reportMedia(report, "annual_inspection_mark")) errors.push("通过结果需上传检验合格标志/电子凭证留证");
  if (report.annualInspection?.conclusion === "failed" && reportMedia(report, "annual_inspection_mark")) errors.push("未通过结果不能保留检验合格标志/电子凭证留证，请先删除");
  return errors;
}

export function reportPreviewUrls(report: VehicleCheckupReport | null | undefined): string[] {
  if (!report) return [];
  const kinds: CheckupMediaKind[] = [
    ...SITE_PHOTO_SLOTS.map((item) => item.kind),
    ...LEGAL_MATERIAL_SLOTS.map((item) => item.kind),
  ];
  return kinds.map((kind) => reportMedia(report, kind)?.url || "").filter(Boolean);
}
