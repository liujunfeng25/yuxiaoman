import { api } from "../../../../services/api";
import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import type {
  Booking,
  CheckupConclusion,
  CheckupFaultSeverity,
  CheckupFaultType,
  CheckupMedia,
  CheckupMediaKind,
  CheckupObservationMode,
  CheckupViewId,
  VehicleCheckupReport,
  VehicleFault,
} from "../../../../types";
import type { AnnualFailureCategory } from "../../utils/checkup-report";
import {
  ANNUAL_FAILURE_CATEGORIES,
  CHECKUP_REGIONS,
  CHECKUP_SYSTEM_REGIONS,
  annualFailureDetails,
  annualInspectionFailureDetails,
  buildFaultBubbleStyle,
  buildPhotoSlots,
  buildRegionCallout,
  checkupVehicleDiagram,
  checkupRegionDefinition,
  conclusionLabel,
  extractSummaryText,
  faultDraftInput,
  faultMarkerState,
  faultPhotoPreviewUrls,
  faultPhotos,
  faultTypeLabel,
  isCheckupSystemRegion,
  mergeFaultPhotos,
  removeFaultPhoto,
  replaceFaultPhoto,
  regionLabel,
  reportMedia,
  reportPreviewUrls,
  severityLabel,
  summaryPayload,
  upsertFault,
  validateCheckupForSubmit,
} from "../../utils/checkup-report";

type ViewTab = { id: CheckupViewId; label: string; imagePath: string; mirrored: boolean; selected: boolean };
type RegionView = {
  code: string;
  label: string;
  dotStyle: string;
  labelStyle: string;
  lineStyle: string;
  faultCount: number;
  markerLabel: string;
  selected: boolean;
};
type SystemRegionView = {
  code: string;
  label: string;
  hint: string;
  faultCount: number;
  markerLabel: string;
  selected: boolean;
};
type FaultView = VehicleFault & {
  number: number;
  regionLabel: string;
  typeLabel: string;
  severityLabel: string;
  viewLabel: string;
  photoCount: number;
  photoStatus: string;
  photoStatusTone: "complete" | "missing" | "uploading" | "failed";
  thumbnailUrl: string;
};
type Choice<T extends string> = { value: T; label: string; selected: boolean };
type PhotoSlotView = ReturnType<typeof buildPhotoSlots>[number] & { mediaUrl: string; stateLabel: string };
type ActiveBubble = { visible: boolean; title: string; description: string; style: string };
type FaultPhotoAttempt = {
  faultId: string;
  tempPath: string;
  replacePhotoId: string;
  idempotencyKey: string;
  status: "uploading" | "failed";
  error: string;
};

type Data = {
  id: string;
  booking: Booking | null;
  report: VehicleCheckupReport | null;
  loading: boolean;
  loadError: string;
  saving: boolean;
  submitting: boolean;
  dirty: boolean;
  activeView: CheckupViewId;
  activeViewImage: string;
  activeViewMirrored: boolean;
  diagramVehicleText: string;
  diagramSourceText: string;
  diagramRegions: typeof CHECKUP_REGIONS;
  viewTabs: ViewTab[];
  totalRegionCount: number;
  regions: RegionView[];
  systemRegionCount: number;
  systemRegions: SystemRegionView[];
  faults: VehicleFault[];
  faultViews: FaultView[];
  faultPhotoCount: number;
  faultMissingPhotoCount: number;
  faultPhotoAttempts: FaultPhotoAttempt[];
  faultPhotoDeletingIds: string[];
  faultPhotoBusyCount: number;
  activeFaultId: string;
  activeBubble: ActiveBubble;
  photoSlots: PhotoSlotView[];
  photoCompleteCount: number;
  fixedPhotoUploadingCount: number;
  markMedia: CheckupMedia | null;
  markUploading: boolean;
  observationMode: CheckupObservationMode | null;
  conclusion: CheckupConclusion | null;
  conclusionLabel: string;
  legacyConclusionNeedsReentry: boolean;
  failureCategories: AnnualFailureCategory[];
  failureCategoryOptions: Choice<AnnualFailureCategory>[];
  failureReason: string;
  retestAdvice: string;
  summary: string;
  previewOpen: boolean;
  faultEditorOpen: boolean;
  persistingFault: boolean;
  editingFaultId: string;
  editingFaultPersisted: boolean;
  editingFaultPhotos: CheckupMedia[];
  editingPhotoAttempt: FaultPhotoAttempt | null;
  editingPhotoCanAdd: boolean;
  editingRegionCode: string;
  editingRegionLabel: string;
  editingFaultType: CheckupFaultType;
  editingSeverity: CheckupFaultSeverity;
  editingDescription: string;
  faultTypeOptions: Choice<CheckupFaultType>[];
  severityOptions: Choice<CheckupFaultSeverity>[];
  conclusionOptions: Choice<CheckupConclusion>[];
  operatorAccessReady: boolean;
};

const VIEW_META: Array<Omit<ViewTab, "selected">> = checkupVehicleDiagram(null).views;

const FAULT_TYPES: Array<{ value: CheckupFaultType; label: string }> = [
  { value: "scratch", label: "剐蹭/划痕" },
  { value: "dent", label: "凹陷" },
  { value: "paint_damage", label: "掉漆" },
  { value: "crack", label: "裂纹" },
  { value: "broken", label: "破损" },
  { value: "rust", label: "锈蚀" },
  { value: "warning_light", label: "故障灯/报码" },
  { value: "malfunction", label: "功能异常" },
  { value: "abnormal_noise", label: "异响/抖动" },
  { value: "leakage", label: "渗漏" },
  { value: "wear", label: "磨损/老化" },
  { value: "other", label: "其他" },
];

const SEVERITIES: Array<{ value: CheckupFaultSeverity; label: string }> = [
  { value: "minor", label: "轻微" },
  { value: "moderate", label: "一般" },
  { value: "severe", label: "明显" },
];

const CONCLUSIONS: Array<{ value: CheckupConclusion; label: string }> = [
  { value: "passed", label: "通过" },
  { value: "failed", label: "未通过" },
];

function emptyReport(bookingId: string): VehicleCheckupReport {
  return {
    bookingId,
    diagramVersion: "sedan-3view-v1",
    observationMode: null,
    annualInspection: { conclusion: null, markStatus: "not_issued", markPhoto: null },
    faults: [],
    media: [],
  };
}

function choices<T extends string>(items: Array<{ value: T; label: string }>, selected: T | null): Choice<T>[] {
  return items.map((item) => ({ ...item, selected: item.value === selected }));
}

function multiChoices<T extends string>(items: ReadonlyArray<{ value: T; label: string }>, selected: T[]): Choice<T>[] {
  return items.map((item) => ({ ...item, selected: selected.includes(item.value) }));
}

function viewLabel(viewId: CheckupViewId): string {
  return VIEW_META.find((item) => item.id === viewId)?.label || "车身";
}

function photoViews(report: VehicleCheckupReport, uploadingKinds: string[] = []): PhotoSlotView[] {
  return buildPhotoSlots(report).map((slot) => ({
    ...slot,
    uploading: uploadingKinds.includes(slot.kind),
    mediaUrl: slot.media?.url || "",
    stateLabel: uploadingKinds.includes(slot.kind) ? "上传中" : slot.media ? "已完成" : "待上传",
  }));
}

function reportFromData(data: Data): VehicleCheckupReport {
  const base = data.report || emptyReport(data.id);
  const siteMedia = data.photoSlots.map((slot) => slot.media).filter(Boolean) as CheckupMedia[];
  const legacyLegalMedia = [
    reportMedia(base, "safety_inspection_report"),
    reportMedia(base, "emissions_inspection_report"),
  ].filter(Boolean) as CheckupMedia[];
  const markMedia = data.markMedia ? [data.markMedia] : [];
  return {
    ...base,
    observationMode: data.observationMode,
    summary: summaryPayload(data.summary),
    faults: data.faults,
    annualInspection: {
      ...(base.annualInspection || { conclusion: null }),
      conclusion: data.conclusion,
      conclusionStatus: data.conclusion ? "available" : base.annualInspection?.conclusionStatus || "pending",
      summary: summaryPayload(data.summary),
      failureDetails: data.conclusion === "failed"
        ? annualInspectionFailureDetails(data.failureCategories, data.failureReason, data.retestAdvice)
        : null,
      markStatus: data.conclusion === "passed" && data.markMedia ? "issued" : "not_issued",
      markPhoto: data.markMedia,
    },
    legalMaterials: {
      safetyInspectionReport: reportMedia(base, "safety_inspection_report"),
      emissionsInspectionReport: reportMedia(base, "emissions_inspection_report"),
      annualInspectionMark: data.markMedia,
      status: data.conclusion === "failed" || (data.conclusion === "passed" && Boolean(data.markMedia))
        ? "available"
        : "pending",
    },
    media: [...siteMedia, ...legacyLegalMedia, ...markMedia],
  };
}

function faultPhotoRequestKey(bookingId: string, faultId: string): string {
  return `fault-photo-${bookingId}-${faultId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function initialData(): Data {
  const report = emptyReport("");
  return {
    id: "", booking: null, report: null, loading: true, loadError: "", saving: false, submitting: false, dirty: false,
    activeView: "left", activeViewImage: VIEW_META[1].imagePath, activeViewMirrored: false,
    diagramVehicleText: "已登记车辆", diagramSourceText: "按登记车身类型匹配",
    diagramRegions: CHECKUP_REGIONS,
    viewTabs: VIEW_META.map((item) => ({ ...item, selected: item.id === "left" })),
    totalRegionCount: CHECKUP_REGIONS.length,
    regions: [], systemRegionCount: CHECKUP_SYSTEM_REGIONS.length, systemRegions: [],
    faults: [], faultViews: [], faultPhotoCount: 0, faultMissingPhotoCount: 0,
    faultPhotoAttempts: [], faultPhotoDeletingIds: [], faultPhotoBusyCount: 0, activeFaultId: "",
    activeBubble: { visible: false, title: "", description: "", style: "" },
    photoSlots: photoViews(report), photoCompleteCount: 0, fixedPhotoUploadingCount: 0,
    markMedia: null, markUploading: false,
    observationMode: null, conclusion: null, conclusionLabel: conclusionLabel(null), legacyConclusionNeedsReentry: false,
    failureCategories: [], failureCategoryOptions: multiChoices(ANNUAL_FAILURE_CATEGORIES, []), failureReason: "", retestAdvice: "",
    summary: "", previewOpen: false,
    faultEditorOpen: false, persistingFault: false, editingFaultId: "", editingFaultPersisted: false,
    editingFaultPhotos: [], editingPhotoAttempt: null, editingPhotoCanAdd: false,
    editingRegionCode: "", editingRegionLabel: "",
    editingFaultType: "scratch", editingSeverity: "minor", editingDescription: "",
    faultTypeOptions: choices(FAULT_TYPES, "scratch"), severityOptions: choices(SEVERITIES, "minor"),
    conclusionOptions: choices(CONCLUSIONS, null), operatorAccessReady: false,
  };
}

Page<Data>({
  data: initialData(),
  onLoad(query) {
    const id = query.id || "";
    if (!id) {
      this.setData({ id, loading: false, loadError: "缺少检测任务编号，请从检测任务详情重新进入。" });
      return;
    }
    const returnUrl = `/packages/inspection/pages/checkup-editor/checkup-editor?id=${encodeURIComponent(id)}`;
    const operatorAccessReady = ensureOperatorPageAccess(returnUrl);
    this.setData({ id, operatorAccessReady }, () => { if (operatorAccessReady) void this.load(); });
  },
  async load() {
    this.setData({ loading: true, loadError: "" });
    try {
      const [booking, report] = await Promise.all([
        api.operatorBooking(this.data.id),
        api.operatorCheckupReport(this.data.id),
      ]);
      const diagram = checkupVehicleDiagram(booking.vehicle);
      const activeVisual = diagram.views.find((item) => item.id === this.data.activeView) || diagram.views[1];
      this.setData({
        booking,
        loadError: "",
        activeViewImage: activeVisual.imagePath,
        activeViewMirrored: activeVisual.mirrored,
        diagramVehicleText: diagram.vehicleLabel,
        diagramSourceText: diagram.sourceLabel,
        diagramRegions: diagram.regions,
        viewTabs: diagram.views.map((item) => ({ ...item, selected: item.id === this.data.activeView })),
      });
      this.applyReport(report || booking.vehicleCheckupReport || emptyReport(booking.id), false);
    } catch (error) {
      if (!ensureOperatorPageAccess(`/packages/inspection/pages/checkup-editor/checkup-editor?id=${encodeURIComponent(this.data.id)}`)) return;
      this.setData({ loadError: error instanceof Error ? error.message : "读取体检报告失败，请稍后重试" });
      wx.showToast({ title: error instanceof Error ? error.message : "读取体检报告失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  retryLoad() { if (!this.data.loading && this.data.id) void this.load(); },
  goTasks() { wx.redirectTo({ url: "/packages/operator/pages/operator/operator" }); },
  applyReport(report: VehicleCheckupReport, preserveDraft: boolean) {
    const faults = preserveDraft ? mergeFaultPhotos(this.data.faults, report.faults || []) : (report.faults || []);
    const observationMode = preserveDraft ? this.data.observationMode : report.observationMode;
    const storedConclusion = report.annualInspection?.conclusion || null;
    const conclusion = preserveDraft
      ? this.data.conclusion
      : storedConclusion;
    const legacyConclusionNeedsReentry = preserveDraft
      ? this.data.legacyConclusionNeedsReentry
      : report.annualInspection?.conclusionStatus === "legacy_requires_reentry";
    const storedFailure = annualFailureDetails(report.annualInspection?.failureDetails);
    const failureCategories = preserveDraft ? this.data.failureCategories : storedFailure.categories;
    const failureReason = preserveDraft ? this.data.failureReason : storedFailure.reason;
    const retestAdvice = preserveDraft ? this.data.retestAdvice : storedFailure.retestAdvice;
    const summary = preserveDraft ? this.data.summary : extractSummaryText(report.annualInspection?.summary, report.summary);
    const uploadingKinds = this.data.photoSlots.filter((slot) => slot.uploading).map((slot) => slot.kind);
    const slots = photoViews(report, uploadingKinds);
    this.setData({
      report: { ...report, faults },
      faults,
      observationMode,
      conclusion,
      conclusionLabel: conclusionLabel(conclusion),
      legacyConclusionNeedsReentry,
      failureCategories,
      failureCategoryOptions: multiChoices(ANNUAL_FAILURE_CATEGORIES, failureCategories),
      failureReason,
      retestAdvice,
      summary,
      photoSlots: slots,
      photoCompleteCount: slots.filter((slot) => slot.media).length,
      markMedia: reportMedia(report, "annual_inspection_mark"),
      dirty: preserveDraft ? this.data.dirty : false,
      conclusionOptions: choices(CONCLUSIONS, conclusion),
    });
    this.refreshDiagram();
  },
  refreshDiagram(next?: { activeView?: CheckupViewId; activeFaultId?: string }) {
    const activeView = next?.activeView ?? this.data.activeView;
    const faults = this.data.faults;
    const activeFaultId = next?.activeFaultId ?? this.data.activeFaultId;
    const activeFault = faults.find((item) => item.id === activeFaultId) || null;
    const regions = this.data.diagramRegions.filter((item) => item.viewId === activeView).map((region) => {
      const marker = faultMarkerState(faults, region.code, activeFaultId);
      const callout = buildRegionCallout(region);
      return {
        code: region.code,
        label: region.label,
        dotStyle: callout.dotStyle,
        labelStyle: callout.labelStyle,
        lineStyle: callout.lineStyle,
        faultCount: marker.faultCount,
        markerLabel: marker.markerLabel,
        selected: Boolean(activeFault && activeFault.regionCode === region.code),
      };
    });
    const faultViews = faults.map((fault, index) => ({
      ...fault,
      number: index + 1,
      regionLabel: regionLabel(fault.regionCode),
      typeLabel: faultTypeLabel(fault.faultType),
      severityLabel: severityLabel(fault.severity),
      viewLabel: isCheckupSystemRegion(fault.regionCode) ? "功能系统" : viewLabel(fault.viewId),
      photoCount: faultPhotos(fault).length,
      photoStatus: this.data.faultPhotoAttempts.find((item) => item.faultId === fault.id)?.status === "uploading"
        ? "上传中"
        : this.data.faultPhotoAttempts.find((item) => item.faultId === fault.id)?.status === "failed"
          ? "上传失败，可重试"
          : faultPhotos(fault).length
            ? `${faultPhotos(fault).length} 张特写`
            : "缺少现场特写",
      photoStatusTone: this.data.faultPhotoAttempts.find((item) => item.faultId === fault.id)?.status === "uploading"
        ? "uploading" as const
        : this.data.faultPhotoAttempts.find((item) => item.faultId === fault.id)?.status === "failed"
          ? "failed" as const
          : faultPhotos(fault).length ? "complete" as const : "missing" as const,
      thumbnailUrl: faultPhotos(fault)[0]?.url || "",
    }));
    const systemRegions = CHECKUP_SYSTEM_REGIONS.map((region) => {
      const marker = faultMarkerState(faults, region.code, activeFaultId);
      return {
        code: region.code,
        label: region.label,
        hint: region.hint,
        faultCount: marker.faultCount,
        markerLabel: marker.markerLabel,
        selected: Boolean(activeFault && activeFault.regionCode === region.code),
      };
    });
    let activeBubble: ActiveBubble = { visible: false, title: "", description: "", style: "" };
    if (activeFault && activeFault.viewId === activeView) {
      const region = this.data.diagramRegions.find((item) => item.code === activeFault.regionCode);
      if (region) {
        activeBubble = {
          visible: true,
          title: `${region.label} · ${faultTypeLabel(activeFault.faultType)}`,
          description: `${severityLabel(activeFault.severity)}${activeFault.description ? ` · ${activeFault.description}` : ""}`,
          style: buildFaultBubbleStyle(region),
        };
      }
    }
    const editingFault = faults.find((fault) => fault.id === this.data.editingFaultId) || null;
    const editingPhotos = faultPhotos(editingFault);
    const editingPhotoAttempt = editingFault ? this.data.faultPhotoAttempts.find((item) => item.faultId === editingFault.id) || null : null;
    this.setData({
      regions,
      systemRegions,
      faultViews,
      activeBubble,
      faultPhotoCount: faults.reduce((total, fault) => total + faultPhotos(fault).length, 0),
      faultMissingPhotoCount: faults.filter((fault) => !faultPhotos(fault).length).length,
      faultPhotoBusyCount: this.data.faultPhotoAttempts.filter((item) => item.status === "uploading").length + this.data.faultPhotoDeletingIds.length,
      editingFaultPersisted: Boolean(editingFault && !editingFault.id.startsWith("local-")),
      editingFaultPhotos: editingPhotos,
      editingPhotoAttempt,
      editingPhotoCanAdd: Boolean(editingFault && !editingFault.id.startsWith("local-") && editingPhotos.length < 3 && editingPhotoAttempt?.status !== "uploading"),
    });
  },
  selectView(event) {
    const id = String(event.currentTarget.dataset.id || "left") as CheckupViewId;
    const meta = this.data.viewTabs.find((item) => item.id === id) || this.data.viewTabs[1];
    const activeFaultId = this.data.faults.find((fault) => fault.viewId === id && !isCheckupSystemRegion(fault.regionCode))?.id || "";
    this.setData({
      activeView: id,
      activeViewImage: meta.imagePath,
      activeViewMirrored: meta.mirrored,
      viewTabs: this.data.viewTabs.map((item) => ({ ...item, selected: item.id === id })),
      activeFaultId,
    });
    this.refreshDiagram({ activeView: id, activeFaultId });
  },
  tapRegion(event) {
    if (this.data.saving || this.data.submitting) return;
    const code = String(event.currentTarget.dataset.code || "");
    const region = this.data.diagramRegions.find((item) => item.code === code);
    if (!region) return;
    this.chooseFaultSeverity(region.code);
  },
  tapSystemRegion(event) {
    if (this.data.saving || this.data.submitting) return;
    const code = String(event.currentTarget.dataset.code || "");
    if (!CHECKUP_SYSTEM_REGIONS.some((item) => item.code === code)) return;
    this.chooseFaultSeverity(code);
  },
  chooseFaultSeverity(regionCode: string) {
    const region = checkupRegionDefinition(regionCode);
    if (!region) return;
    wx.navigateTo({
      url: `/packages/inspection/pages/fault-severity/fault-severity?regionCode=${encodeURIComponent(region.code)}`,
      success: ({ eventChannel }) => {
        eventChannel.on("faultSeveritySelected", (payload: unknown) => {
          const selection = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
          const severity = String(selection.severity || "") as CheckupFaultSeverity;
          if (String(selection.regionCode || "") !== region.code || !["minor", "moderate", "severe"].includes(severity)) return;
          this.openFaultEditor(region.code, undefined, severity);
        });
      },
    });
  },
  selectFault(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const fault = this.data.faults.find((item) => item.id === id);
    if (!fault) return;
    const meta = this.data.viewTabs.find((item) => item.id === fault.viewId) || this.data.viewTabs[1];
    this.setData({
      activeFaultId: id,
      activeView: fault.viewId,
      activeViewImage: meta.imagePath,
      activeViewMirrored: meta.mirrored,
      viewTabs: this.data.viewTabs.map((item) => ({ ...item, selected: item.id === fault.viewId })),
    });
    this.refreshDiagram();
  },
  openFaultEditor(regionCode: string, fault?: VehicleFault, initialSeverity?: CheckupFaultSeverity) {
    wx.hideToast();
    const type = fault?.faultType || (regionCode === "dashboard_obd" ? "warning_light" : isCheckupSystemRegion(regionCode) ? "malfunction" : "scratch");
    const severity = fault?.severity || initialSeverity || "minor";
    this.setData({
      faultEditorOpen: true,
      editingFaultId: fault?.id || "",
      editingRegionCode: regionCode,
      editingRegionLabel: regionLabel(regionCode),
      editingFaultType: type,
      editingSeverity: severity,
      editingDescription: fault?.description || "",
      faultTypeOptions: choices(FAULT_TYPES, type),
      severityOptions: choices(SEVERITIES, severity),
    }, () => this.refreshDiagram());
  },
  editFault(event) {
    if (this.data.saving || this.data.submitting) return;
    const id = String(event.currentTarget.dataset.id || "");
    const fault = this.data.faults.find((item) => item.id === id);
    if (fault) this.openFaultEditor(fault.regionCode, fault);
  },
  closeFaultEditor() { this.setData({ faultEditorOpen: false }); },
  blockSheetTouch() { return; },
  selectFaultType(event) {
    const value = String(event.currentTarget.dataset.value || "scratch") as CheckupFaultType;
    this.setData({ editingFaultType: value, faultTypeOptions: choices(FAULT_TYPES, value) });
  },
  selectSeverity(event) {
    const value = String(event.currentTarget.dataset.value || "minor") as CheckupFaultSeverity;
    this.setData({ editingSeverity: value, severityOptions: choices(SEVERITIES, value) });
  },
  inputFaultDescription(event) { this.setData({ editingDescription: String(event.detail.value || "") }); },
  saveFault() { void this.persistEditingFault(false); },
  saveFaultAndPhoto() { void this.persistEditingFault(true); },
  async persistEditingFault(openPhotoAfter: boolean) {
    if (this.data.persistingFault || this.data.saving) return;
    const description = this.data.editingDescription.trim();
    if (this.data.editingFaultType === "other" && !description) {
      wx.showToast({ title: "选择其他时请填写问题描述", icon: "none" });
      return null;
    }
    const region = checkupRegionDefinition(this.data.editingRegionCode);
    if (!region) return null;
    const existing = this.data.faults.find((item) => item.id === this.data.editingFaultId);
    const id = existing?.id || `local-${Date.now()}-${this.data.faults.length + 1}`;
    const clientKey = existing?.clientKey || (id.startsWith("local-") ? id : undefined);
    const next: VehicleFault = {
      ...(existing || {}),
      id,
      ...(clientKey ? { clientKey } : {}),
      viewId: region.viewId,
      regionCode: region.code,
      faultType: this.data.editingFaultType,
      severity: this.data.editingSeverity,
      description: description || null,
      photos: existing?.photos || [],
    };
    this.setData({
      faults: upsertFault(this.data.faults, next),
      observationMode: "faults_recorded",
      activeFaultId: id,
      editingFaultId: id,
      persistingFault: true,
      dirty: true,
    });
    this.refreshDiagram();
    try {
      const saved = await this.saveDraft(false);
      if (!saved) return null;
      const persisted = saved.faults.find((item) => item.id === id)
        || (clientKey ? saved.faults.find((item) => item.clientKey === clientKey) : undefined);
      if (!persisted) {
        wx.showToast({ title: "故障保存成功，但未取得照片绑定编号", icon: "none" });
        return null;
      }
      this.setData({
        editingFaultId: persisted.id,
        activeFaultId: persisted.id,
        faultEditorOpen: openPhotoAfter,
      });
      this.refreshDiagram();
      if (openPhotoAfter) this.promptFaultPhotoSource(persisted.id, "");
      else wx.showToast({ title: "故障已保存", icon: "success" });
      return persisted;
    } finally {
      this.setData({ persistingFault: false });
    }
  },
  removeFault(event) {
    if (this.data.saving || this.data.submitting || this.data.persistingFault) return;
    const id = String(event.currentTarget.dataset.id || this.data.editingFaultId || "");
    if (!id) return;
    const fault = this.data.faults.find((item) => item.id === id);
    const photoCount = faultPhotos(fault).length;
    wx.showModal({
      title: "删除这条故障？",
      content: photoCount ? `该故障的 ${photoCount} 张现场特写也会一并删除，其他故障不受影响。` : "仅删除当前故障记录，其他故障不受影响。",
      confirmText: "删除",
      confirmColor: "#d84646",
      success: ({ confirm }) => { if (confirm) void this.performRemoveFault(id); },
    });
  },
  async performRemoveFault(id: string) {
    const remaining = this.data.faults.filter((item) => item.id !== id);
    this.setData({
      faults: remaining,
      faultPhotoAttempts: this.data.faultPhotoAttempts.filter((item) => item.faultId !== id),
      activeFaultId: remaining[0]?.id || "",
      observationMode: remaining.length ? "faults_recorded" : null,
      faultEditorOpen: false,
      dirty: true,
    });
    this.refreshDiagram();
    await this.saveDraft(false);
  },
  chooseObservation(event) {
    if (this.data.saving || this.data.submitting) return;
    const value = String(event.currentTarget.dataset.value || "") as CheckupObservationMode;
    if (value === "no_visible_faults" && this.data.faults.length) {
      wx.showModal({
        title: "确认未发现明显异常？",
        content: "切换后将清空已记录的车辆故障及其现场特写，固定 5 张状态照片不受影响。",
        confirmText: "清空并确认",
        confirmColor: "#1768cf",
        success: ({ confirm }) => {
          if (!confirm) return;
          this.setData({ observationMode: value, faults: [], faultPhotoAttempts: [], activeFaultId: "", dirty: true });
          this.refreshDiagram();
        },
      });
      return;
    }
    this.setData({ observationMode: value, dirty: true });
  },
  async choosePhoto(event) {
    if (this.data.saving || this.data.submitting) return;
    const kind = String(event.currentTarget.dataset.kind || "") as CheckupMediaKind;
    if (!kind) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      success: ({ tempFiles }) => {
        const path = tempFiles[0]?.tempFilePath;
        if (path) void this.uploadPhoto(kind, path);
      },
    });
  },
  async uploadPhoto(kind: CheckupMediaKind, filePath: string) {
    if (kind === "annual_inspection_mark") this.setData({ markUploading: true });
    else this.setData({
      photoSlots: this.data.photoSlots.map((slot) => slot.kind === kind ? { ...slot, uploading: true, stateLabel: "上传中" } : slot),
      fixedPhotoUploadingCount: this.data.fixedPhotoUploadingCount + 1,
    });
    try {
      await api.uploadOperatorCheckupMedia(this.data.id, kind, filePath);
      const report = await api.operatorCheckupReport(this.data.id);
      if (report) this.applyReport(report, true);
      wx.showToast({
        title: kind === "annual_inspection_mark" ? "材料已保存" : "照片已保存",
        icon: "success",
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "照片上传失败", icon: "none" });
    } finally {
      if (kind === "annual_inspection_mark") this.setData({ markUploading: false });
      else this.setData({
        photoSlots: this.data.photoSlots.map((slot) => slot.kind === kind ? { ...slot, uploading: false, stateLabel: slot.media ? "已完成" : "待上传" } : slot),
        fixedPhotoUploadingCount: Math.max(0, this.data.fixedPhotoUploadingCount - 1),
      });
    }
  },
  chooseFaultPhoto(event) {
    if (this.data.saving || this.data.submitting) return;
    const faultId = String(event.currentTarget.dataset.faultId || this.data.editingFaultId || "");
    const replacePhotoId = String(event.currentTarget.dataset.photoId || "");
    this.promptFaultPhotoSource(faultId, replacePhotoId);
  },
  promptFaultPhotoSource(faultId: string, replacePhotoId: string) {
    const fault = this.data.faults.find((item) => item.id === faultId);
    if (!fault || fault.id.startsWith("local-")) {
      wx.showToast({ title: "请先保存故障，再拍摄现场特写", icon: "none" });
      return;
    }
    const photos = faultPhotos(fault);
    if (!replacePhotoId && photos.length >= 3) {
      wx.showToast({ title: "每条故障最多保留 3 张特写", icon: "none" });
      return;
    }
    if (replacePhotoId && !photos.some((item) => item.id === replacePhotoId)) {
      wx.showToast({ title: "该照片不属于当前故障，请刷新后重试", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: ["拍照", "从相册选择"],
      success: ({ tapIndex }) => {
        const sourceType: Array<"camera" | "album"> = tapIndex === 0 ? ["camera"] : ["album"];
        wx.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType,
          success: ({ tempFiles }) => {
            const path = tempFiles[0]?.tempFilePath;
            if (path) void this.uploadFaultPhoto(faultId, path, replacePhotoId, faultPhotoRequestKey(this.data.id, faultId));
          },
        });
      },
    });
  },
  updateFaultPhotoAttempt(attempt: FaultPhotoAttempt | null, faultId: string) {
    const remaining = this.data.faultPhotoAttempts.filter((item) => item.faultId !== faultId);
    this.setData({ faultPhotoAttempts: attempt ? [...remaining, attempt] : remaining }, () => this.refreshDiagram());
  },
  async uploadFaultPhoto(faultId: string, filePath: string, replacePhotoId: string, idempotencyKey: string) {
    const current = this.data.faultPhotoAttempts.find((item) => item.faultId === faultId);
    if (current?.status === "uploading") return;
    const attempt: FaultPhotoAttempt = {
      faultId,
      tempPath: filePath,
      replacePhotoId,
      idempotencyKey,
      status: "uploading",
      error: "",
    };
    this.updateFaultPhotoAttempt(attempt, faultId);
    try {
      const media = await api.uploadOperatorFaultPhoto(this.data.id, faultId, filePath, {
        ...(replacePhotoId ? { replacePhotoId } : {}),
        idempotencyKey,
      });
      this.setData({ faults: replaceFaultPhoto(this.data.faults, faultId, media, replacePhotoId) });
      try {
        const report = await api.operatorCheckupReport(this.data.id);
        if (report) this.applyReport(report, true);
      } catch {
        this.setData({ report: this.data.report ? { ...this.data.report, rowVersion: undefined } : null });
      }
      this.updateFaultPhotoAttempt(null, faultId);
      wx.showToast({ title: replacePhotoId ? "特写已重拍" : "特写已保存", icon: "success" });
    } catch (error) {
      this.updateFaultPhotoAttempt({
        ...attempt,
        status: "failed",
        error: error instanceof Error ? error.message : "故障特写上传失败",
      }, faultId);
      wx.showToast({ title: error instanceof Error ? error.message : "故障特写上传失败", icon: "none" });
    }
  },
  retryFaultPhoto(event) {
    const faultId = String(event.currentTarget.dataset.faultId || this.data.editingFaultId || "");
    const attempt = this.data.faultPhotoAttempts.find((item) => item.faultId === faultId && item.status === "failed");
    if (attempt) void this.uploadFaultPhoto(faultId, attempt.tempPath, attempt.replacePhotoId, attempt.idempotencyKey);
  },
  discardFaultPhotoAttempt(event) {
    const faultId = String(event.currentTarget.dataset.faultId || this.data.editingFaultId || "");
    if (faultId) this.updateFaultPhotoAttempt(null, faultId);
  },
  previewFaultPhoto(event) {
    const faultId = String(event.currentTarget.dataset.faultId || "");
    const current = String(event.currentTarget.dataset.url || "");
    const urls = faultPhotoPreviewUrls(this.data.faults.find((item) => item.id === faultId));
    if (current && urls.length) wx.previewImage({ current, urls });
  },
  deleteFaultPhoto(event) {
    const faultId = String(event.currentTarget.dataset.faultId || "");
    const mediaId = String(event.currentTarget.dataset.photoId || "");
    if (!faultId || !mediaId) return;
    wx.showModal({
      title: "删除这张故障特写？",
      content: "只会删除当前故障下的这张照片，其他故障和固定现场照片不受影响。",
      confirmText: "删除",
      confirmColor: "#d84646",
      success: ({ confirm }) => { if (confirm) void this.performDeleteFaultPhoto(faultId, mediaId); },
    });
  },
  async performDeleteFaultPhoto(faultId: string, mediaId: string) {
    if (this.data.faultPhotoDeletingIds.includes(mediaId)) return;
    this.setData({ faultPhotoDeletingIds: [...this.data.faultPhotoDeletingIds, mediaId] }, () => this.refreshDiagram());
    try {
      await api.deleteOperatorFaultPhoto(this.data.id, faultId, mediaId);
      this.setData({ faults: removeFaultPhoto(this.data.faults, faultId, mediaId) });
      try {
        const report = await api.operatorCheckupReport(this.data.id);
        if (report) this.applyReport(report, true);
      } catch {
        this.setData({ report: this.data.report ? { ...this.data.report, rowVersion: undefined } : null });
      }
      wx.showToast({ title: "特写已删除", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "故障特写删除失败", icon: "none" });
    } finally {
      this.setData({ faultPhotoDeletingIds: this.data.faultPhotoDeletingIds.filter((id) => id !== mediaId) });
      this.refreshDiagram();
    }
  },
  previewPhoto(event) {
    const current = String(event.currentTarget.dataset.url || "");
    const urls = reportPreviewUrls(reportFromData(this.data));
    if (current && urls.length) wx.previewImage({ current, urls });
  },
  deletePhoto(event) {
    if (this.data.saving || this.data.submitting) return;
    const mediaId = String(event.currentTarget.dataset.id || "");
    if (!mediaId) return;
    wx.showModal({
      title: "删除这张照片？",
      content: "删除后该槽位需要重新上传。",
      confirmText: "删除",
      confirmColor: "#d84646",
      success: ({ confirm }) => { if (confirm) void this.performDeletePhoto(mediaId); },
    });
  },
  async performDeletePhoto(mediaId: string) {
    try {
      await api.deleteOperatorCheckupMedia(this.data.id, mediaId);
      const report = await api.operatorCheckupReport(this.data.id);
      if (report) this.applyReport(report, true);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "照片删除失败", icon: "none" });
    }
  },
  selectConclusion(event) {
    if (this.data.saving || this.data.submitting) return;
    const conclusion = String(event.currentTarget.dataset.value || "") as CheckupConclusion;
    if (conclusion !== "passed" && this.data.markMedia) {
      wx.showModal({
        title: "删除检验合格凭证留证？",
        content: "未通过结论不能保留检验合格标志/电子凭证留证。确认后将先删除留证，再切换结论。",
        confirmText: "删除并切换",
        confirmColor: "#d84646",
        success: ({ confirm }) => { if (confirm) void this.removeMarkAndSelectConclusion(conclusion); },
      });
      return;
    }
    this.applyConclusion(conclusion);
  },
  applyConclusion(conclusion: CheckupConclusion) {
    const common = {
      conclusion,
      conclusionLabel: conclusionLabel(conclusion),
      legacyConclusionNeedsReentry: false,
      conclusionOptions: choices(CONCLUSIONS, conclusion),
      dirty: true,
    };
    if (conclusion === "passed") {
      this.setData({
        ...common,
        failureCategories: [],
        failureCategoryOptions: multiChoices(ANNUAL_FAILURE_CATEGORIES, []),
        failureReason: "",
        retestAdvice: "",
      });
      return;
    }
    this.setData(common);
  },
  toggleFailureCategory(event) {
    if (this.data.saving || this.data.submitting) return;
    const value = String(event.currentTarget.dataset.value || "") as AnnualFailureCategory;
    if (!ANNUAL_FAILURE_CATEGORIES.some((item) => item.value === value)) return;
    const failureCategories = this.data.failureCategories.includes(value)
      ? this.data.failureCategories.filter((item) => item !== value)
      : [...this.data.failureCategories, value];
    this.setData({
      failureCategories,
      failureCategoryOptions: multiChoices(ANNUAL_FAILURE_CATEGORIES, failureCategories),
      dirty: true,
    });
  },
  inputFailureReason(event) { this.setData({ failureReason: String(event.detail.value || ""), dirty: true }); },
  inputRetestAdvice(event) { this.setData({ retestAdvice: String(event.detail.value || ""), dirty: true }); },
  async removeMarkAndSelectConclusion(conclusion: CheckupConclusion) {
    const mediaId = this.data.markMedia?.id;
    if (!mediaId) { this.applyConclusion(conclusion); return; }
    try {
      await api.deleteOperatorCheckupMedia(this.data.id, mediaId);
      const report = await api.operatorCheckupReport(this.data.id);
      if (report) this.applyReport(report, true);
      this.setData({ markMedia: null });
      this.applyConclusion(conclusion);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "检验合格凭证留证删除失败", icon: "none" });
    }
  },
  inputSummary(event) { this.setData({ summary: String(event.detail.value || ""), dirty: true }); },
  async saveDraft(showToast = true): Promise<VehicleCheckupReport | null> {
    if (this.data.saving) return null;
    if (this.data.fixedPhotoUploadingCount > 0 || this.data.markUploading || this.data.faultPhotoBusyCount > 0) {
      if (showToast) wx.showToast({ title: "请等待照片处理完成", icon: "none" });
      return null;
    }
    this.setData({ saving: true });
    try {
      const current = reportFromData(this.data);
      const report = await api.saveOperatorCheckupReport(this.data.id, {
        ...(current.rowVersion === undefined ? {} : { rowVersion: current.rowVersion }),
        observationMode: current.observationMode,
        diagramVersion: "sedan-3view-v1",
        summary: summaryPayload(this.data.summary),
        annualInspection: {
          conclusion: this.data.conclusion,
          summary: summaryPayload(this.data.summary),
          failureDetails: this.data.conclusion === "failed"
            ? annualInspectionFailureDetails(this.data.failureCategories, this.data.failureReason, this.data.retestAdvice)
            : null,
        },
        faults: this.data.faults.map(faultDraftInput),
      });
      this.applyReport(report, false);
      if (showToast) wx.showToast({ title: "草稿已保存", icon: "success" });
      return report;
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "草稿保存失败", icon: "none" });
      return null;
    } finally {
      this.setData({ saving: false });
    }
  },
  async submitReport() {
    if (this.data.submitting) return;
    if (this.data.fixedPhotoUploadingCount > 0 || this.data.markUploading || this.data.faultPhotoBusyCount > 0) {
      wx.showModal({ title: "材料仍在上传", content: "请等待现场状态照片或检测证明材料上传完成。", confirmText: "我知道了", success: () => undefined });
      return;
    }
    const uploadingFaults = this.data.faultPhotoAttempts
      .filter((item) => item.status === "uploading")
      .map((attempt) => {
        const index = this.data.faults.findIndex((fault) => fault.id === attempt.faultId);
        const fault = this.data.faults[index];
        return fault ? `#${index + 1} ${regionLabel(fault.regionCode)}` : "未知故障";
      });
    if (uploadingFaults.length) {
      wx.showModal({ title: "照片仍在上传", content: `请等待以下故障特写上传完成：${uploadingFaults.join("、")}`, confirmText: "我知道了", success: () => undefined });
      return;
    }
    let errors = validateCheckupForSubmit(reportFromData(this.data));
    if (errors.length) {
      wx.showModal({ title: "还不能回传结果", content: errors.join("\n"), confirmText: "继续填写", success: () => undefined });
      return;
    }
    const saved = await this.saveDraft(false);
    if (!saved) return;
    errors = validateCheckupForSubmit(saved);
    if (errors.length) {
      wx.showModal({ title: "还不能回传结果", content: errors.join("\n"), confirmText: "继续填写", success: () => undefined });
      return;
    }
    this.setData({ previewOpen: true });
  },
  closePreview() { this.setData({ previewOpen: false }); },
  openFullReportPreview() {
    wx.navigateTo({ url: `/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(this.data.id)}&mode=operator&preview=1` });
  },
  confirmSubmit() {
    this.setData({ previewOpen: false });
    void this.performSubmit();
  },
  async performSubmit() {
    if (this.data.submitting) return;
    const conclusion = this.data.conclusion;
    if (!conclusion) return;
    this.setData({ submitting: true });
    try {
      const saved = await this.saveDraft(false);
      if (!saved) return;
      const errors = validateCheckupForSubmit(saved);
      if (errors.length) {
        wx.showModal({ title: "还不能回传结果", content: errors.join("\n"), confirmText: "继续填写", success: () => undefined });
        return;
      }
      await api.submitOperatorInspectionResult(this.data.id, {
        conclusion,
        failureDetails: conclusion === "failed"
          ? annualInspectionFailureDetails(this.data.failureCategories, this.data.failureReason, this.data.retestAdvice)
          : null,
        summary: summaryPayload(this.data.summary || "车辆现场检查与年检结果已回传"),
      });
      wx.showToast({
        title: this.data.booking?.serviceMode === "self_drive" ? "报告已发布，服务完成" : "结果已回传",
        icon: "success",
        duration: 1400,
      });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "结果回传失败", icon: "none" });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
