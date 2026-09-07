import { api } from "../../../../services/api";
import { invalidateOwnerMedia } from "../../../../services/owner-media";
import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import type { Booking, CheckupMedia, CheckupViewId, RepairRequestSummary, VehicleCheckupReport, VehicleFault } from "../../../../types";
import {
  CHECKUP_REGIONS,
  CHECKUP_SYSTEM_REGIONS,
  SITE_PHOTO_SLOTS,
  annualFailureDetails,
  buildFaultBubbleStyle,
  buildRegionCallout,
  checkupVehicleDiagram,
  conclusionLabel,
  extractSummaryText,
  faultMarkerState,
  faultPhotos,
  faultTypeLabel,
  isCheckupSystemRegion,
  regionLabel,
  reportMedia,
  severityLabel,
} from "../../utils/checkup-report";
import type { CheckupDiagramView } from "../../utils/checkup-report";
import { annualConclusionNarrative, faultAdvice, vehicleConditionNarrative, vehicleConditionTitle } from "../../utils/report-copy";
import { formatShanghaiDateTime } from "../../../../utils/format";

type Tab = { id: CheckupViewId; label: string; imagePath: string; selected: boolean; faultCount: number };
type Marker = {
  code: string;
  label: string;
  dotStyle: string;
  labelStyle: string;
  lineStyle: string;
  count: number;
  markerLabel: string;
  selected: boolean;
  targetFaultId: string;
};
type FaultView = VehicleFault & { number: number; regionLabel: string; typeLabel: string; severityLabel: string; viewLabel: string; isSystemRegion: boolean; descriptionText: string; advice: string; photoCount: number; photos: CheckupMedia[] };
type SystemMarker = { code: string; label: string; hint: string; count: number; markerLabel: string; selected: boolean; targetFaultId: string };
type PhotoView = { kind: string; label: string; media: CheckupMedia; url: string };
type ViewerItem = { url: string; label: string };
type AttachmentView = { kind: string; number: string; label: string; statusText: string; statusTone: "available" | "missing" | "not-applicable"; url: string };
type Bubble = { visible: boolean; title: string; description: string; style: string };
type Data = {
  id: string;
  operatorMode: boolean;
  previewMode: boolean;
  booking: Booking | null;
  report: VehicleCheckupReport | null;
  repairRequest: RepairRequestSummary | null;
  repairAvailable: boolean;
  repairCtaText: string;
  repairCtaHint: string;
  repairCtaTone: "start" | "waiting" | "quoted" | "paid" | "cancelled";
  loading: boolean;
  loadError: string;
  mediaReadFailed: boolean;
  activeView: CheckupViewId;
  activeViewImage: string;
  activeViewMirrored: boolean;
  diagramViews: CheckupDiagramView[];
  diagramVehicleText: string;
  diagramSourceText: string;
  diagramRegions: typeof CHECKUP_REGIONS;
  tabs: Tab[];
  markers: Marker[];
  systemMarkers: SystemMarker[];
  activeFaultId: string;
  activeBubble: Bubble;
  faultViews: FaultView[];
  faultPhotoCount: number;
  sitePhotos: PhotoView[];
  resultMaterials: PhotoView[];
  sitePhotoAttachments: AttachmentView[];
  resultMaterialAttachments: AttachmentView[];
  viewerOpen: boolean;
  viewerItems: ViewerItem[];
  viewerIndex: number;
  viewerUrl: string;
  viewerLabel: string;
  viewerCounter: string;
  viewerHasPrevious: boolean;
  viewerHasNext: boolean;
  conclusionText: string;
  conclusionTone: string;
  annualNarrative: string;
  showFailureDetails: boolean;
  failureCategoryText: string;
  failureReasonText: string;
  retestAdviceText: string;
  observationText: string;
  conditionTitle: string;
  conditionNarrative: string;
  inspectionNoteText: string;
  publishedTime: string;
  reportTimeLabel: string;
  reportNumberText: string;
  reportStatusText: string;
  plateText: string;
  vehicleText: string;
  serviceModeText: string;
  stationText: string;
  appointmentText: string;
  markStatusText: string;
  legalMaterialStatusText: string;
  summaryText: string;
  operatorAccessReady: boolean;
};

const DEFAULT_DIAGRAM = checkupVehicleDiagram(null);
const VIEWS = DEFAULT_DIAGRAM.views;

function viewLabel(id: CheckupViewId): string { return VIEWS.find((item) => item.id === id)?.label || "车身"; }

function vehicleText(booking: Booking): string {
  const vehicle = booking.vehicle;
  if (!vehicle) return "车辆信息未提供";
  const model = [vehicle.brand?.name, vehicle.model?.name].filter(Boolean).join(" ") || vehicle.vehicleType || "已登记车辆";
  return vehicle.seats ? `${model} · ${vehicle.seats}座` : model;
}

Page<Data>({
  data: {
    id: "", operatorMode: false, previewMode: false, booking: null, report: null, repairRequest: null, repairAvailable: false,
    repairCtaText: "一键咨询维修报价", repairCtaHint: "自动带入本报告的全部车损与故障特写", repairCtaTone: "start", loading: true, loadError: "", mediaReadFailed: false,
    activeView: "left", activeViewImage: VIEWS[1].imagePath, activeViewMirrored: false,
    diagramViews: VIEWS, diagramVehicleText: DEFAULT_DIAGRAM.vehicleLabel, diagramSourceText: DEFAULT_DIAGRAM.sourceLabel,
    diagramRegions: DEFAULT_DIAGRAM.regions,
    tabs: [], markers: [], systemMarkers: [], activeFaultId: "",
    activeBubble: { visible: false, title: "", description: "", style: "" },
    faultViews: [], faultPhotoCount: 0, sitePhotos: [], resultMaterials: [], sitePhotoAttachments: [], resultMaterialAttachments: [],
    viewerOpen: false, viewerItems: [], viewerIndex: 0, viewerUrl: "", viewerLabel: "", viewerCounter: "0 / 0", viewerHasPrevious: false, viewerHasNext: false,
    conclusionText: "待填写", conclusionTone: "neutral", annualNarrative: "检测站尚未回传本次年检结论。",
    showFailureDetails: false, failureCategoryText: "", failureReasonText: "", retestAdviceText: "",
    observationText: "未填写", conditionTitle: "车辆状态尚未完成确认", conditionNarrative: "检测站尚未完成车辆状态确认。", inspectionNoteText: "检测站未填写检测说明。",
    publishedTime: "待发布", reportTimeLabel: "出具时间", reportNumberText: "未生成平台报告编号", reportStatusText: "草稿", plateText: "车辆信息未提供", vehicleText: "车辆信息未提供",
    serviceModeText: "未提供", stationText: "未提供", appointmentText: "未提供", markStatusText: "未核发", legalMaterialStatusText: "待核验", summaryText: "检测站未填写补充说明", operatorAccessReady: true,
  },
  onLoad(query) {
    const id = query.id || "";
    const operatorMode = query.mode === "operator";
    const suffix = `id=${encodeURIComponent(id)}&mode=operator${query.preview === "1" ? "&preview=1" : ""}`;
    const operatorAccessReady = !operatorMode || ensureOperatorPageAccess(`/packages/inspection/pages/checkup-report/checkup-report?${suffix}`);
    this.setData({ id, operatorMode, previewMode: query.preview === "1", operatorAccessReady });
    if (!query.id) this.setData({ loading: false, loadError: "缺少订单信息，请从订单详情或报告中心重新进入。" });
  },
  onShow() { if (this.data.id && this.data.operatorAccessReady) void this.load(); },
  async load() {
    this.setData({ loading: true, loadError: "" });
    try {
      const [booking, repairRequests] = await Promise.all([
        this.data.operatorMode ? api.operatorBooking(this.data.id) : api.booking(this.data.id),
        // Never downgrade a failed request lookup to “no request”: doing so can
        // render the publish CTA for a report that already has an open inquiry.
        this.data.operatorMode ? Promise.resolve([] as RepairRequestSummary[]) : api.repairRequests(),
      ]);
      const report = booking.vehicleCheckupReport || (this.data.operatorMode ? await api.operatorCheckupReport(this.data.id).catch(() => null) : null);
      const repairRequest = report?.id ? repairRequests.find((item) => item.report?.id === report.id) || null : null;
      this.setData({ booking, report, repairRequest, loadError: "" });
      if (report) {
        this.applyReport(report, booking);
        this.applyRepairState(report, repairRequest);
      }
    } catch (error) {
      if (this.data.operatorMode && !ensureOperatorPageAccess(`/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(this.data.id)}&mode=operator`)) return;
      this.setData({ loadError: error instanceof Error ? error.message : "读取体检报告失败，请稍后重试" });
      wx.showToast({ title: error instanceof Error ? error.message : "读取体检报告失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  retryLoad() { if (!this.data.loading && this.data.id) void this.load(); },
  handlePrivateImageError(event) {
    if (this.data.operatorMode) return;
    const sourceUrl = String(event.currentTarget.dataset.sourceUrl || "");
    if (sourceUrl) invalidateOwnerMedia(sourceUrl);
    this.setData({ mediaReadFailed: true });
  },
  goBack() { wx.navigateBack(); },
  applyRepairState(report: VehicleCheckupReport, request: RepairRequestSummary | null) {
    const repairAvailable = !this.data.operatorMode && !this.data.previewMode && report.status === "published" && Boolean(report.id) && (report.faults || []).length > 0;
    if (!repairAvailable) {
      this.setData({ repairAvailable: false });
      return;
    }
    if (!request) {
      this.setData({
        repairAvailable: true,
        repairCtaText: "一键咨询维修报价",
        repairCtaHint: `将自动带入 ${report.faults.length} 处车损与全部故障特写，确认授权后发布`,
        repairCtaTone: "start",
      });
      return;
    }
    if (request.status === "paid") {
      this.setData({ repairAvailable: true, repairCtaText: "查看维修成交回执", repairCtaHint: "模拟全额支付已完成，查看所选门店与线下联系信息", repairCtaTone: "paid" });
      return;
    }
    if (request.status === "cancelled") {
      this.setData({ repairAvailable: true, repairCtaText: "查看已取消的维修询价", repairCtaHint: "该报告的询价已停止接收新报价", repairCtaTone: "cancelled" });
      return;
    }
    if (request.quoteCount > 0) {
      this.setData({ repairAvailable: true, repairCtaText: `查看 ${request.quoteCount} 份维修报价`, repairCtaHint: "按全款总价比较门店，选中后完成模拟支付", repairCtaTone: "quoted" });
      return;
    }
    this.setData({ repairAvailable: true, repairCtaText: "查看维修询价进度", repairCtaHint: "需求已进入接单大厅，正在等待演示门店报价", repairCtaTone: "waiting" });
  },
  openRepairQuote() {
    const report = this.data.report;
    if (!report?.id || !this.data.repairAvailable) return;
    const request = this.data.repairRequest;
    if (!request) {
      wx.navigateTo({ url: `/packages/repair/pages/owner-request-confirm/owner-request-confirm?bookingId=${encodeURIComponent(this.data.id)}&reportId=${encodeURIComponent(report.id)}` });
      return;
    }
    const page = request.status === "paid"
      ? "owner-receipt"
      : request.status === "open" && request.quoteCount > 0
        ? "owner-quotes"
        : "owner-request-detail";
    wx.navigateTo({ url: `/packages/repair/pages/${page}/${page}?id=${encodeURIComponent(request.id)}` });
  },
  applyReport(report: VehicleCheckupReport, booking?: Booking | null) {
    const currentBooking = booking || this.data.booking;
    const faults = report.faults || [];
    const firstBodyFault = faults.find((item) => !isCheckupSystemRegion(item.regionCode));
    const activeView = firstBodyFault?.viewId || "left";
    const activeFaultId = firstBodyFault?.id || faults[0]?.id || "";
    const diagram = checkupVehicleDiagram(currentBooking?.vehicle);
    const activeVisual = diagram.views.find((item) => item.id === activeView) || diagram.views[1];
    const conclusion = report.annualInspection?.conclusion || null;
    const conclusionStatus = report.annualInspection?.conclusionStatus;
    const mediaReadFailed = [
      ...(report.media || []),
      ...faults.flatMap((fault) => fault.photos || []),
    ].some((item) => item.loadState === "failed");
    const sitePhotos = SITE_PHOTO_SLOTS.map((slot) => {
      const media = reportMedia(report, slot.kind);
      return media ? { kind: slot.kind, label: slot.label, media, url: media.url } : null;
    }).filter(Boolean) as PhotoView[];
    const markSlot = { kind: "annual_inspection_mark" as const, label: "检验合格标志/电子凭证留证" };
    const safetyMedia = reportMedia(report, "safety_inspection_report");
    const emissionsMedia = reportMedia(report, "emissions_inspection_report");
    const markMedia = conclusion === "passed" ? reportMedia(report, markSlot.kind) : null;
    const resultMaterials = [
      safetyMedia ? { kind: "safety_inspection_report" as const, label: "机动车安全技术检验报告", media: safetyMedia, url: safetyMedia.url } : null,
      emissionsMedia ? { kind: "emissions_inspection_report" as const, label: "排放检验报告", media: emissionsMedia, url: emissionsMedia.url } : null,
      markMedia ? { kind: markSlot.kind, label: markSlot.label, media: markMedia, url: markMedia.url } : null,
    ].filter(Boolean) as PhotoView[];
    const failure = annualFailureDetails(report.annualInspection?.failureDetails);
    const sitePhotoAttachments = SITE_PHOTO_SLOTS.map((slot, index) => {
      const media = reportMedia(report, slot.kind);
      return {
        kind: slot.kind,
        number: String(index + 1).padStart(2, "0"),
        label: slot.label,
        statusText: media?.loadState === "failed" ? "安全读取失败" : media ? "已附照片" : "未附照片",
        statusTone: media?.loadState === "failed" ? "missing" as const : media ? "available" as const : "missing" as const,
        url: media?.url || "",
      };
    });
    const missingRequiredStatus = report.status === "published" ? "历史报告未采集" : "待上传";
    const resultMaterialAttachments: AttachmentView[] = [
      ...(safetyMedia ? [{
        kind: "safety_inspection_report" as const,
        number: "历史",
        label: "机动车安全技术检验报告",
        statusText: safetyMedia.loadState === "failed" ? "安全读取失败" : "已归档",
        statusTone: (safetyMedia.loadState === "failed" ? "missing" : "available") as AttachmentView["statusTone"],
        url: safetyMedia.url || "",
      }] : []),
      ...(emissionsMedia ? [{
        kind: "emissions_inspection_report" as const,
        number: "历史",
        label: "排放检验报告",
        statusText: emissionsMedia.loadState === "failed" ? "安全读取失败" : "已归档",
        statusTone: (emissionsMedia.loadState === "failed" ? "missing" : "available") as AttachmentView["statusTone"],
        url: emissionsMedia.url || "",
      }] : []),
      {
        kind: markSlot.kind,
        number: "通过",
        label: markSlot.label,
        statusText: markMedia?.loadState === "failed"
          ? "安全读取失败"
          : markMedia
          ? "已归档"
          : conclusion === "passed"
            ? missingRequiredStatus
            : conclusion === "failed"
              ? "未通过，不适用"
              : "结果未确认",
        statusTone: markMedia?.loadState === "failed" ? "missing" : markMedia ? "available" : conclusion === "passed" ? "missing" : "not-applicable",
        url: markMedia?.url || "",
      },
    ];
    const summaryText = extractSummaryText(report.annualInspection?.summary, report.summary);
    this.setData({
      activeView,
      activeViewImage: activeVisual.imagePath,
      activeViewMirrored: activeVisual.mirrored,
      diagramViews: diagram.views,
      diagramVehicleText: diagram.vehicleLabel,
      diagramSourceText: diagram.sourceLabel,
      diagramRegions: diagram.regions,
      activeFaultId,
      faultViews: faults.map((fault, index) => ({
        ...fault,
        number: index + 1,
        regionLabel: regionLabel(fault.regionCode),
        typeLabel: faultTypeLabel(fault.faultType),
        severityLabel: severityLabel(fault.severity),
        viewLabel: isCheckupSystemRegion(fault.regionCode) ? "功能系统" : viewLabel(fault.viewId),
        isSystemRegion: isCheckupSystemRegion(fault.regionCode),
        descriptionText: fault.description || "检测站未填写补充描述",
        advice: faultAdvice(fault),
        photoCount: faultPhotos(fault).length,
        photos: faultPhotos(fault),
      })),
      faultPhotoCount: faults.reduce((total, fault) => total + faultPhotos(fault).length, 0),
      sitePhotos,
      resultMaterials,
      sitePhotoAttachments,
      resultMaterialAttachments,
      mediaReadFailed,
      conclusionText: conclusionLabel(conclusion, conclusionStatus),
      conclusionTone: conclusion === "passed" || conclusion === "failed" ? conclusion : "pending",
      annualNarrative: annualConclusionNarrative(conclusion, conclusionStatus),
      showFailureDetails: conclusion === "failed",
      failureCategoryText: failure.categoryLabels.length ? failure.categoryLabels.join("、") : "未录入未通过项目类别",
      failureReasonText: failure.reason || "未录入具体原因或检测说明",
      retestAdviceText: failure.retestAdvice || "未录入整改与复检建议",
      observationText: report.observationMode === "no_visible_faults" ? "未发现明显异常" : faults.length ? `已记录 ${faults.length} 条车辆问题` : "未填写",
      conditionTitle: vehicleConditionTitle(report),
      conditionNarrative: vehicleConditionNarrative(report),
      inspectionNoteText: summaryText || "检测站已完成现场照片采集、车辆状态记录并回传本次年检结论。",
      publishedTime: formatShanghaiDateTime(report.publishedAt || report.updatedAt, "待发布"),
      reportTimeLabel: report.status === "published" ? "出具时间" : "草稿更新时间",
      reportNumberText: report.reportNo || "未生成平台报告编号",
      reportStatusText: report.status === "published" ? "已出具" : "草稿",
      plateText: currentBooking?.vehicle?.plateNumber || "车辆信息未提供",
      vehicleText: currentBooking ? vehicleText(currentBooking) : "车辆信息未提供",
      serviceModeText: currentBooking ? currentBooking.serviceMode === "valet" ? "上门取送车" : "车主自驾到站" : "未提供",
      stationText: currentBooking?.station?.name || "检测站信息未提供",
      appointmentText: currentBooking ? `${currentBooking.appointmentDate} ${currentBooking.startTime}–${currentBooking.endTime}` : "预约信息未提供",
      markStatusText: markMedia || (conclusion === "passed" && report.annualInspection?.markStatus === "issued")
        ? "检验合格凭证留证已归档"
        : conclusion === "passed"
          ? (report.status === "published" ? "历史报告未采集合格凭证" : "未形成检验合格凭证留证")
          : conclusion === "failed"
            ? "未通过，不适用"
            : "结果未确认",
      legalMaterialStatusText: conclusion === "passed"
        ? markMedia ? "必传合格凭证已归档" : missingRequiredStatus
        : conclusion === "failed"
          ? "必传材料不适用"
          : "年检结果待确认",
      summaryText: summaryText || "检测站未填写补充说明",
    });
    this.refreshDiagram({ activeView, activeFaultId });
  },
  refreshDiagram(next?: { activeView?: CheckupViewId; activeFaultId?: string }) {
    const faults = this.data.report?.faults || [];
    const activeView = next?.activeView ?? this.data.activeView;
    const activeFaultId = next?.activeFaultId ?? this.data.activeFaultId;
    const activeFault = faults.find((item) => item.id === activeFaultId) || null;
    const tabs = this.data.diagramViews.map((item) => ({
      ...item,
      selected: item.id === activeView,
      faultCount: faults.filter((fault) => fault.viewId === item.id && !isCheckupSystemRegion(fault.regionCode)).length,
    }));
    const markers = this.data.diagramRegions.filter((region) => region.viewId === activeView).map((region) => {
      const marker = faultMarkerState(faults, region.code, activeFaultId);
      const callout = buildRegionCallout(region);
      return {
        code: region.code,
        label: region.label,
        dotStyle: callout.dotStyle,
        labelStyle: callout.labelStyle,
        lineStyle: callout.lineStyle,
        count: marker.faultCount,
        markerLabel: marker.markerLabel,
        selected: Boolean(activeFault && activeFault.regionCode === region.code),
        targetFaultId: marker.targetFaultId,
      };
    }).filter((marker) => marker.count > 0);
    const systemMarkers = CHECKUP_SYSTEM_REGIONS.map((region) => {
      const marker = faultMarkerState(faults, region.code, activeFaultId);
      return {
        code: region.code,
        label: region.label,
        hint: region.hint,
        count: marker.faultCount,
        markerLabel: marker.markerLabel,
        selected: Boolean(activeFault && activeFault.regionCode === region.code),
        targetFaultId: marker.targetFaultId,
      };
    }).filter((marker) => marker.count > 0);
    let activeBubble: Bubble = { visible: false, title: "", description: "", style: "" };
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
    this.setData({ tabs, markers, systemMarkers, activeBubble });
  },
  selectView(event) {
    const id = String(event.currentTarget.dataset.id || "left") as CheckupViewId;
    const first = this.data.report?.faults.find((fault) => fault.viewId === id && !isCheckupSystemRegion(fault.regionCode));
    const visual = this.data.diagramViews.find((item) => item.id === id) || this.data.diagramViews[1];
    const activeFaultId = first?.id || "";
    this.setData({ activeView: id, activeViewImage: visual.imagePath, activeViewMirrored: visual.mirrored, activeFaultId });
    this.refreshDiagram({ activeView: id, activeFaultId });
  },
  selectMarker(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (id) this.setData({ activeFaultId: id });
    this.refreshDiagram({ activeFaultId: id || this.data.activeFaultId });
  },
  selectFault(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const fault = this.data.report?.faults.find((item) => item.id === id);
    if (!fault) return;
    // 功能系统记录挂在 top viewId 上，点选时不要把三视图切走，只高亮系统卡片。
    if (isCheckupSystemRegion(fault.regionCode)) {
      this.setData({ activeFaultId: id });
      this.refreshDiagram({ activeFaultId: id });
      return;
    }
    const visual = this.data.diagramViews.find((item) => item.id === fault.viewId) || this.data.diagramViews[1];
    this.setData({ activeFaultId: id, activeView: fault.viewId, activeViewImage: visual.imagePath, activeViewMirrored: visual.mirrored });
    this.refreshDiagram({ activeView: fault.viewId, activeFaultId: id });
  },
  previewPhoto(event) {
    const current = String(event.currentTarget.dataset.url || "");
    this.openImageViewer(this.data.sitePhotos.map((item) => ({ url: item.url, label: item.label })), current);
  },
  previewResultMaterial(event) {
    const current = String(event.currentTarget.dataset.url || "");
    this.openImageViewer(this.data.resultMaterials.map((item) => ({ url: item.url, label: item.label })), current);
  },
  previewFaultPhoto(event) {
    const faultId = String(event.currentTarget.dataset.faultId || "");
    const current = String(event.currentTarget.dataset.url || "");
    const fault = this.data.report?.faults.find((item) => item.id === faultId);
    if (!fault) return;
    const faultNumber = (this.data.report?.faults.findIndex((item) => item.id === faultId) || 0) + 1;
    const items = faultPhotos(fault).map((photo, index) => ({
      url: photo.url,
      label: `故障 #${faultNumber} ${regionLabel(fault.regionCode)} · 特写 ${photo.sequence || index + 1}`,
    }));
    this.openImageViewer(items, current);
  },
  openImageViewer(items: ViewerItem[], current: string) {
    const available = items.filter((item) => Boolean(item.url));
    if (!available.length) return;
    const currentIndex = available.findIndex((item) => item.url === current);
    this.applyViewerIndex(available, currentIndex >= 0 ? currentIndex : 0);
  },
  applyViewerIndex(items: ViewerItem[], index: number) {
    if (!items.length) return;
    const safeIndex = Math.max(0, Math.min(items.length - 1, index));
    const current = items[safeIndex];
    this.setData({
      viewerOpen: true,
      viewerItems: items,
      viewerIndex: safeIndex,
      viewerUrl: current.url,
      viewerLabel: current.label,
      viewerCounter: `${safeIndex + 1} / ${items.length}`,
      viewerHasPrevious: safeIndex > 0,
      viewerHasNext: safeIndex < items.length - 1,
    });
  },
  previousViewerImage() {
    if (this.data.viewerHasPrevious) this.applyViewerIndex(this.data.viewerItems, this.data.viewerIndex - 1);
  },
  nextViewerImage() {
    if (this.data.viewerHasNext) this.applyViewerIndex(this.data.viewerItems, this.data.viewerIndex + 1);
  },
  closeImageViewer() { this.setData({ viewerOpen: false }); },
  blockViewerTouch() { return; },
});
