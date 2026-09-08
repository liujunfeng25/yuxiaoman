import { api } from "../../../../services/api";
import { invalidateOwnerMedia, localizeOwnerMedia, ownerMediaSourceUrl } from "../../../../services/owner-media";
import {
  ownerWorkflowApi,
  requestOwnerWorkflowSubscriptions,
} from "../../../../services/workflow";
import type {
  Booking,
  BookingMedia,
  CheckupMedia,
  CheckupMediaKind,
  ValetEvidenceMedia,
  ValetEvidencePackage,
  ValetEvidenceStage,
  VehicleCheckupReport,
} from "../../../../types";
import { formatShanghaiDateTime } from "../../../../utils/format";
import { bookingPaymentPending, bookingPaymentStateView, bookingQuoteView, quoteAmountChanged, quoteClockView } from "./order-detail.model";

// Annual inspection and vehicle-checkup are independent subpackages. Importing
// a sibling subpackage utility works in TypeScript but leaves the module absent
// from WeChat's annual subpackage bundle. Keep this tiny read-only adapter local
// so the owner order detail can load before the inspection package is present.
function reportMedia(report: VehicleCheckupReport | null | undefined, kind: CheckupMediaKind): CheckupMedia | null {
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

type EvidencePhotoView = Omit<ValetEvidenceMedia, "url"> & {
  label: string;
  sourceUrl: string;
  url: string;
  loadState: "loading" | "ready" | "failed";
};
type EvidenceStageView = Omit<ValetEvidencePackage, "photos"> & {
  number: string;
  description: string;
  countText: string;
  statusText: string;
  statusTone: "pending" | "complete" | "legacy";
  photos: EvidencePhotoView[];
};
type ViewerItem = { url: string; label: string; stage: ValetEvidenceStage; photoId: string };

type Data = {
  id: string;
  booking: Booking | null;
  loading: boolean;
  loadError: string;
  missingOrder: boolean;
  paying: boolean;
  requoting: boolean;
  cancelling: boolean;
  paymentError: string;
  paymentPending: boolean;
  paymentStateTitle: string;
  paymentStateCopy: string;
  paymentStateTone: "pending" | "paid" | "refunded" | "unpaid" | "unknown";
  quoteExpired: boolean;
  quoteExpiryText: string;
  payableFen: number;
  paymentSummaryLabel: string;
  paymentSummaryFen: number;
  refundedFen: number;
  quoteSnapshotText: string;
  routeSummaryText: string;
  pricingFormulaText: string;
  priceChangeNotice: string;
  inspectionResultText: string;
  checkupLegalMaterialsText: string;
  checkupPlatformEvidenceText: string;
  checkupLegalMaterialsMissing: boolean;
  evidenceStages: EvidenceStageView[];
  legacyEvidence: boolean;
  viewerOpen: boolean;
  viewerItems: ViewerItem[];
  viewerIndex: number;
  viewerUrl: string;
  viewerLabel: string;
  viewerCounter: string;
  viewerHasPrevious: boolean;
  viewerHasNext: boolean;
  precheckReasonText: string;
  precheckIssueText: string;
  precheckReviewedAt: string;
  precheckSupervisionNote: string;
  wechatPostPaymentTemplateIds: string[];
};

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

const evidenceStageCopy: Record<ValetEvidenceStage, { number: string; label: string; description: string }> = {
  owner_pickup: { number: "01", label: "司机取车", description: "取车现场四角与启动后仪表盘" },
  station_arrival: { number: "02", label: "检测站接车", description: "车辆到站时的现场状态" },
  inspection_complete: { number: "03", label: "检测完成", description: "复用车辆体检报告固定照片" },
  owner_return: { number: "04", label: "车辆送回", description: "送达原地址时的最终状态" },
};

const evidencePhotoLabels: Record<ValetEvidenceMedia["kind"], string> = {
  front_left: "左前",
  front_right: "右前",
  rear_left: "左后",
  rear_right: "右后",
  dashboard_started: "启动后仪表盘",
};

function evidenceViews(booking: Booking): EvidenceStageView[] {
  return (booking.evidencePackages || []).map((item) => {
    const copy = evidenceStageCopy[item.stage];
    const photos = item.status === "completed"
      ? (item.photos || []).map((photo) => ({
        ...photo,
        sourceUrl: ownerMediaSourceUrl(photo.url),
        url: "",
        label: evidencePhotoLabels[photo.kind],
        loadState: "loading" as const,
      }))
      : [];
    return {
      ...item,
      capturedAt: item.capturedAt ? formatShanghaiDateTime(item.capturedAt) : null,
      label: item.label || copy.label,
      number: copy.number,
      description: copy.description,
      photos,
      countText: `${photos.length}/5`,
      statusText: item.status === "completed" ? "留证已完成" : "等待该节点",
      statusTone: item.status === "completed" ? "complete" : "pending",
    };
  });
}

function bookingDisplayView(booking: Booking): Booking {
  return {
    ...booking,
    precheck: booking.precheck ? {
      ...booking.precheck,
      submittedAt: formatShanghaiDateTime(booking.precheck.submittedAt),
      reviewedAt: booking.precheck.reviewedAt ? formatShanghaiDateTime(booking.precheck.reviewedAt) : null,
      refundRequestedAt: booking.precheck.refundRequestedAt ? formatShanghaiDateTime(booking.precheck.refundRequestedAt) : null,
      refundCompletedAt: booking.precheck.refundCompletedAt ? formatShanghaiDateTime(booking.precheck.refundCompletedAt) : null,
    } : null,
    events: (booking.events || []).map((event) => ({
      ...event,
      createdAt: formatShanghaiDateTime(event.createdAt),
    })),
  };
}

function inspectionResultText(booking: Booking): string {
  const conclusion = booking.inspectionResult?.conclusion;
  if (conclusion === "passed") return "本次年检结果：通过";
  if (conclusion === "failed") return "本次年检结果：未通过";
  if (booking.inspectionResult?.conclusionStatus === "legacy_requires_reentry") return "历史结果待重新录入：正式年检结果尚未确认";
  return "";
}

function precheckSupervisionNote(booking: Booking): string {
  const supervision = booking.precheck?.supervision;
  if (!supervision) return "预审通过后才会开始车辆履约；该订单未启用主动督办。";
  if (supervision.status !== "open") return `预审通过后才会开始车辆履约；本单第 ${supervision.policyVersion} 版督办已结束。`;
  const schedule = [
    supervision.firstReminderAt ? `首次提醒 ${formatShanghaiDateTime(supervision.firstReminderAt)}` : "",
    supervision.dueAt ? `处理截止 ${formatShanghaiDateTime(supervision.dueAt)}` : "",
  ].filter(Boolean).join("，");
  const reminded = supervision.reminderCount > 0 ? `；系统已提醒检测站 ${supervision.reminderCount} 次` : "";
  return `预审通过后才会开始车辆履约；本单执行第 ${supervision.policyVersion} 版督办规则${schedule ? `，${schedule}` : ""}${reminded}。`;
}

function checkupMaterialView(booking: Booking) {
  const report = booking.vehicleCheckupReport;
  if (!report) return { legal: "报告尚未生成", platform: "平台留证待生成", missing: false };
  const safety = Boolean(reportMedia(report, "safety_inspection_report"));
  const emissions = Boolean(reportMedia(report, "emissions_inspection_report"));
  const mark = Boolean(reportMedia(report, "annual_inspection_mark"));
  const passed = report.annualInspection?.conclusion === "passed";
  const legacyParts = [
    safety ? "安全检验报告已归档" : "",
    emissions ? "排放报告已归档" : "",
  ].filter(Boolean);
  const markPart = passed ? (mark ? "合格凭证已归档" : "合格凭证待上传") : "合格凭证不适用";
  const legal = [...legacyParts, markPart].join(" · ");
  const siteCount = ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"]
    .filter((kind) => reportMedia(report, kind as Parameters<typeof reportMedia>[1])).length;
  return {
    legal,
    platform: `现场留证 ${siteCount}/5 · 故障特写 ${(report.faults || []).reduce((total, fault) => total + (fault.photos || []).length, 0)} 张`,
    missing: passed && !mark,
  };
}

function money(fen: number): string { return (Number(fen || 0) / 100).toFixed(2); }

function quoteErrorCode(error: unknown): string {
  return error instanceof Error ? String((error as Error & { code?: string }).code || "") : "";
}

async function localizedEvidenceViews(stages: EvidenceStageView[]): Promise<EvidenceStageView[]> {
  return Promise.all(stages.map(async (stage) => ({
    ...stage,
    photos: await Promise.all(stage.photos.map(async (photo) => {
      try {
        return { ...photo, url: await localizeOwnerMedia(photo.sourceUrl), loadState: "ready" as const };
      } catch {
        return { ...photo, url: "", loadState: "failed" as const };
      }
    })),
  })));
}

function updateEvidencePhoto(
  stages: EvidenceStageView[],
  stageId: ValetEvidenceStage,
  photoId: string,
  patch: Partial<Pick<EvidencePhotoView, "url" | "loadState">>,
): EvidenceStageView[] {
  return stages.map((stage) => stage.stage !== stageId ? stage : {
    ...stage,
    photos: stage.photos.map((photo) => photo.id === photoId ? { ...photo, ...patch } : photo),
  });
}

function updateBookingMedia(
  booking: Booking | null,
  mediaId: string,
  patch: Partial<Pick<BookingMedia, "url" | "loadState">>,
): Booking | null {
  if (!booking) return booking;
  return {
    ...booking,
    media: (booking.media || []).map((item) => item.id === mediaId ? { ...item, ...patch } : item),
  };
}

Page<Data>({
  data: {
    id: "", booking: null, loading: true, loadError: "", missingOrder: false, paying: false, requoting: false, cancelling: false, paymentError: "", paymentPending: false,
    paymentStateTitle: "支付状态待同步", paymentStateCopy: "正在读取后台交易记录。", paymentStateTone: "unknown",
    quoteExpired: false, quoteExpiryText: "", payableFen: 0, paymentSummaryLabel: "订单累计应收", paymentSummaryFen: 0, refundedFen: 0,
    quoteSnapshotText: "未记录", routeSummaryText: "", pricingFormulaText: "", priceChangeNotice: "",
    inspectionResultText: "", checkupLegalMaterialsText: "", checkupPlatformEvidenceText: "", checkupLegalMaterialsMissing: false,
    evidenceStages: [], legacyEvidence: false,
    viewerOpen: false, viewerItems: [], viewerIndex: 0, viewerUrl: "", viewerLabel: "", viewerCounter: "", viewerHasPrevious: false, viewerHasNext: false,
    precheckReasonText: "", precheckIssueText: "", precheckReviewedAt: "", precheckSupervisionNote: "",
    wechatPostPaymentTemplateIds: [],
  },
  onLoad(query) {
    const id = query.id || "";
    this.setData({ id, loading: Boolean(id), missingOrder: !id });
    void this.loadWechatPostPaymentTemplates();
  },
  async loadWechatPostPaymentTemplates() {
    try {
      const wechatPostPaymentTemplateIds = await ownerWorkflowApi.wechatSubscriptionTemplateIds("post_payment");
      this.setData({ wechatPostPaymentTemplateIds });
    } catch {
      this.setData({ wechatPostPaymentTemplateIds: [] });
    }
  },
  onShow() {
    if (this.data.id) void this.load();
    else this.setData({ loading: false, missingOrder: true });
  },
  onHide() { this.stopQuoteClock(); },
  onUnload() { this.stopQuoteClock(); },
  stopQuoteClock() {
    if (this.quoteTimer) clearInterval(this.quoteTimer);
    this.quoteTimer = undefined;
  },
  startQuoteClock() {
    this.stopQuoteClock();
    this.refreshQuoteClock();
    if (!this.data.paymentPending) return;
    this.quoteTimer = setInterval(() => this.refreshQuoteClock(), 1000);
  },
  refreshQuoteClock() {
    const booking = this.data.booking;
    if (!booking) return;
    const paymentPending = bookingPaymentPending(booking);
    const clock = paymentPending ? quoteClockView(booking.quoteExpiresAt) : null;
    this.setData({
      paymentPending,
      quoteExpired: Boolean(clock?.expired),
      quoteExpiryText: clock?.text || "",
    });
    if (!paymentPending) this.stopQuoteClock();
  },
  async load() {
    const loadSequence = Number(this.ownerEvidenceLoadSequence || 0) + 1;
    this.ownerEvidenceLoadSequence = loadSequence;
    this.setData({ loading: true, loadError: "" });
    try {
      const booking = await api.booking(this.data.id);
      const evidenceStages = evidenceViews(booking);
      const quoteView = bookingQuoteView(booking);
      const paymentState = bookingPaymentStateView(booking);
      const quoteClock = quoteView.paymentPending ? quoteClockView(booking.quoteExpiresAt) : null;
      const checkupMaterial = checkupMaterialView(booking);
      if (this.ownerEvidenceLoadSequence !== loadSequence) return;
      this.setData({
        booking: bookingDisplayView(booking),
        loading: false,
        loadError: "",
        paymentError: "",
        paymentPending: quoteView.paymentPending,
        paymentStateTitle: paymentState.title,
        paymentStateCopy: paymentState.copy,
        paymentStateTone: paymentState.tone,
        quoteExpired: Boolean(quoteClock?.expired),
        quoteExpiryText: quoteClock?.text || "",
        payableFen: quoteView.payableFen,
        paymentSummaryLabel: quoteView.paymentSummaryLabel,
        paymentSummaryFen: quoteView.paymentSummaryFen,
        refundedFen: quoteView.refundedFen,
        quoteSnapshotText: quoteView.snapshotText,
        routeSummaryText: quoteView.routeSummaryText,
        pricingFormulaText: quoteView.pricingFormulaText,
        priceChangeNotice: "",
        inspectionResultText: inspectionResultText(booking),
        checkupLegalMaterialsText: checkupMaterial.legal,
        checkupPlatformEvidenceText: checkupMaterial.platform,
        checkupLegalMaterialsMissing: checkupMaterial.missing,
        evidenceStages,
        legacyEvidence: booking.serviceMode === "valet" && booking.evidencePolicyVersion !== "valet-handoff-v1",
        precheckReasonText: (booking.precheck?.reasonCodes || []).map((code) => precheckReasonLabels[code] || code).join("、"),
        precheckIssueText: (booking.precheck?.issuePhotoKinds || []).map((kind) => precheckPhotoLabels[kind] || kind).join("、"),
        precheckReviewedAt: booking.precheck?.reviewedAt ? formatShanghaiDateTime(booking.precheck.reviewedAt) : "",
        precheckSupervisionNote: precheckSupervisionNote(booking),
      });
      this.startQuoteClock();
      const localizedStages = await localizedEvidenceViews(evidenceStages);
      if (this.ownerEvidenceLoadSequence === loadSequence) this.setData({ evidenceStages: localizedStages });
    }
    catch (error) {
      if (this.ownerEvidenceLoadSequence === loadSequence) {
        const message = error instanceof Error ? error.message : "读取详情失败";
        this.setData({ loadError: message });
        wx.showToast({ title: message, icon: "none" });
      }
    }
    finally {
      if (this.ownerEvidenceLoadSequence === loadSequence) this.setData({ loading: false });
    }
  },
  retryLoad() {
    if (this.data.id && !this.data.loading) void this.load();
  },
  preview(event) {
    const url = String(event.currentTarget.dataset.url || "");
    const urls = (this.data.booking?.media || []).map((item) => item.url).filter(Boolean);
    if (!url || !urls.length) return;
    wx.previewImage({ current: url, urls });
  },
  async retryBookingMedia(event) {
    const mediaId = String(event.currentTarget.dataset.mediaId || "");
    const item = this.data.booking?.media?.find((candidate) => candidate.id === mediaId);
    if (!item?.sourceUrl || item.loadState === "loading") return;
    this.setData({ booking: updateBookingMedia(this.data.booking, mediaId, { url: "", loadState: "loading" }) });
    try {
      const url = await localizeOwnerMedia(item.sourceUrl, { forceRefresh: true });
      this.setData({ booking: updateBookingMedia(this.data.booking, mediaId, { url, loadState: "ready" }) });
    } catch {
      this.setData({ booking: updateBookingMedia(this.data.booking, mediaId, { url: "", loadState: "failed" }) });
      wx.showToast({ title: "预约照片读取失败，请稍后重试", icon: "none" });
    }
  },
  handleBookingMediaError(event) {
    const mediaId = String(event.currentTarget.dataset.mediaId || "");
    const item = this.data.booking?.media?.find((candidate) => candidate.id === mediaId);
    if (!item?.sourceUrl) return;
    invalidateOwnerMedia(item.sourceUrl);
    this.setData({ booking: updateBookingMedia(this.data.booking, mediaId, { url: "", loadState: "failed" }) });
  },
  previewEvidence(event) {
    const stage = String(event.currentTarget.dataset.stage || "") as ValetEvidenceStage;
    const current = String(event.currentTarget.dataset.url || "");
    const currentStage = this.data.evidenceStages.find((item) => item.stage === stage);
    if (!currentStage?.photos.length) return;
    const items = currentStage.photos
      .filter((item) => item.loadState === "ready" && Boolean(item.url))
      .map((item) => ({
        url: item.url,
        label: `${currentStage.label} · ${item.label}`,
        stage,
        photoId: item.id,
      }));
    if (!items.length) return;
    const currentIndex = Math.max(0, items.findIndex((item) => item.url === current));
    this.applyViewerIndex(items, currentIndex);
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
  async retryEvidencePhoto(event) {
    const stage = String(event.currentTarget.dataset.stage || "") as ValetEvidenceStage;
    const photoId = String(event.currentTarget.dataset.photoId || "");
    const currentStage = this.data.evidenceStages.find((item) => item.stage === stage);
    const photo = currentStage?.photos.find((item) => item.id === photoId);
    if (!photo || photo.loadState === "loading") return;
    this.setData({ evidenceStages: updateEvidencePhoto(this.data.evidenceStages, stage, photoId, { url: "", loadState: "loading" }) });
    try {
      const url = await localizeOwnerMedia(photo.sourceUrl, { forceRefresh: true });
      this.setData({ evidenceStages: updateEvidencePhoto(this.data.evidenceStages, stage, photoId, { url, loadState: "ready" }) });
    } catch {
      this.setData({ evidenceStages: updateEvidencePhoto(this.data.evidenceStages, stage, photoId, { url: "", loadState: "failed" }) });
      wx.showToast({ title: "照片读取失败，请稍后重试", icon: "none" });
    }
  },
  handleEvidenceImageError(event) {
    const viewerItem = this.data.viewerItems[this.data.viewerIndex];
    const stage = String(event.currentTarget.dataset.stage || viewerItem?.stage || "") as ValetEvidenceStage;
    const photoId = String(event.currentTarget.dataset.photoId || viewerItem?.photoId || "");
    const photo = this.data.evidenceStages.find((item) => item.stage === stage)?.photos.find((item) => item.id === photoId);
    if (!photo) return;
    invalidateOwnerMedia(photo.sourceUrl);
    this.setData({
      evidenceStages: updateEvidencePhoto(this.data.evidenceStages, stage, photoId, { url: "", loadState: "failed" }),
      viewerOpen: this.data.viewerItems[this.data.viewerIndex]?.photoId === photoId ? false : this.data.viewerOpen,
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
  openCheckupReport() {
    if (!this.data.booking) return;
    wx.navigateTo({ url: `/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(this.data.booking.id)}` });
  },
  async pay() {
    const booking = this.data.booking;
    if (!booking || this.data.paying) return;
    if (!bookingQuoteView(booking).paymentPending) {
      await this.load();
      return;
    }
    const clock = quoteClockView(booking.quoteExpiresAt);
    if (clock.expired) {
      this.setData({ quoteExpired: true, quoteExpiryText: clock.text, paymentError: "报价已过期，请先重新报价后再支付。" });
      return;
    }
    const quoteSnapshotId = booking.quoteSnapshotId || "";
    if (booking.fulfillmentStatus !== "legacy" && !quoteSnapshotId) {
      this.setData({ paymentError: "订单缺少报价快照，请刷新后重试或联系客服。" });
      return;
    }
    const idempotencyKey = this.paymentOrderId === booking.id && this.paymentKey
      ? this.paymentKey
      : `inspection-pay-${booking.id}-${Date.now()}`;
    this.paymentOrderId = booking.id;
    this.paymentKey = idempotencyKey;
    // Start subscribe synchronously from the pay tap so WeChat still treats it as
    // a user gesture. Prefer precheck-result + report-ready templates for this step.
    const subscribeRequest = this.data.wechatPostPaymentTemplateIds.length
      ? requestOwnerWorkflowSubscriptions(this.data.wechatPostPaymentTemplateIds, "post_payment")
      : null;
    this.setData({ paying: true, paymentError: "" });
    try {
      const paidBooking = await api.payBooking(booking.id, idempotencyKey, quoteSnapshotId);
      const paidQuoteView = bookingQuoteView(paidBooking);
      const paidState = bookingPaymentStateView(paidBooking);
      this.stopQuoteClock();
      this.setData({
        booking: paidBooking,
        paymentPending: paidQuoteView.paymentPending,
        paymentStateTitle: paidState.title,
        paymentStateCopy: paidState.copy,
        paymentStateTone: paidState.tone,
        quoteExpired: false,
        quoteExpiryText: "",
        payableFen: paidQuoteView.payableFen,
        paymentSummaryLabel: paidQuoteView.paymentSummaryLabel,
        paymentSummaryFen: paidQuoteView.paymentSummaryFen,
        refundedFen: paidQuoteView.refundedFen,
        quoteSnapshotText: paidQuoteView.snapshotText,
        routeSummaryText: paidQuoteView.routeSummaryText,
        pricingFormulaText: paidQuoteView.pricingFormulaText,
        priceChangeNotice: "",
      });
      if (paidQuoteView.paymentPending) {
        wx.showToast({ title: "支付处理中，请稍候", icon: "none" });
      } else {
        wx.showToast({ title: "支付成功，等待预审", icon: "success" });
      }
      if (subscribeRequest) {
        void subscribeRequest.then((result) => {
          if (result.acceptedCount > 0) {
            wx.showToast({ title: `已开启 ${result.acceptedCount} 类微信提醒`, icon: "success" });
          }
        }).catch(() => undefined);
      }
      await this.load();
    } catch (error) {
      const code = quoteErrorCode(error);
      if (code === "QUOTE_EXPIRED" || code === "QUOTE_STALE") {
        this.setData({ quoteExpired: true, quoteExpiryText: "报价已过期", paymentError: "报价已过期，请先重新报价后再支付。" });
      } else if (code === "BOOKING_QUOTE_CHANGED") {
        await this.load();
        this.setData({ paymentError: "订单报价已更新，请重新确认最新金额后支付。" });
      } else {
        this.setData({ paymentError: error instanceof Error ? error.message : "支付失败，请重试" });
      }
    } finally {
      this.setData({ paying: false });
    }
  },
  async requote() {
    const booking = this.data.booking;
    if (!booking || this.data.requoting) return;
    if (!bookingPaymentPending(booking)) {
      this.stopQuoteClock();
      this.setData({
        paymentPending: false,
        quoteExpired: false,
        quoteExpiryText: "",
        paymentError: "",
        priceChangeNotice: "",
      });
      return;
    }
    const expectedQuoteSnapshotId = booking.quoteSnapshotId || "";
    if (!expectedQuoteSnapshotId) {
      this.setData({ paymentError: "订单缺少原报价快照，请刷新后重试或联系客服。" });
      return;
    }
    this.setData({ requoting: true, paymentError: "", priceChangeNotice: "" });
    try {
      const previousFen = bookingQuoteView(booking).payableFen;
      const payload = await api.requoteBooking(booking.id, expectedQuoteSnapshotId);
      const next = payload.booking;
      const quoteView = bookingQuoteView(next);
      const paymentState = bookingPaymentStateView(next);
      const quoteClock = quoteClockView(next.quoteExpiresAt);
      const amountChanged = quoteAmountChanged(booking, next);
      const evidenceStages = evidenceViews(next);
      const priceChangeNotice = amountChanged
        ? `本次报价已由 ¥${money(previousFen)} 更新为 ¥${money(quoteView.payableFen)}，支付前需再次确认。`
        : "报价有效期已更新，订单金额未变化。";
      this.setData({
        booking: bookingDisplayView(next),
        paymentPending: quoteView.paymentPending,
        paymentStateTitle: paymentState.title,
        paymentStateCopy: paymentState.copy,
        paymentStateTone: paymentState.tone,
        quoteExpired: quoteView.paymentPending && quoteClock.expired,
        quoteExpiryText: quoteClock.text,
        payableFen: quoteView.payableFen,
        paymentSummaryLabel: quoteView.paymentSummaryLabel,
        paymentSummaryFen: quoteView.paymentSummaryFen,
        refundedFen: quoteView.refundedFen,
        quoteSnapshotText: quoteView.snapshotText,
        routeSummaryText: quoteView.routeSummaryText,
        pricingFormulaText: quoteView.pricingFormulaText,
        priceChangeNotice,
        evidenceStages,
        legacyEvidence: next.serviceMode === "valet" && next.evidencePolicyVersion !== "valet-handoff-v1",
      }, () => {
        this.startQuoteClock();
        if (!amountChanged) {
          wx.showToast({ title: "报价已更新，请确认支付", icon: "none" });
          return;
        }
        wx.showModal({
          title: "报价金额已更新",
          content: `订单应付由 ¥${money(previousFen)} 调整为 ¥${money(quoteView.payableFen)}。请确认最新明细后再支付。`,
          confirmText: "确认并支付",
          success: ({ confirm }) => { if (confirm) void this.pay(); },
        });
      });
    } catch (error) {
      const code = quoteErrorCode(error);
      if (code === "BOOKING_QUOTE_CHANGED") {
        await this.load();
        this.setData({ paymentError: "订单报价已由其他操作更新，请确认当前最新金额。" });
      } else {
        this.setData({ paymentError: error instanceof Error ? error.message : "重新报价失败，请稍后重试" });
      }
    } finally {
      this.setData({ requoting: false });
    }
  },
  openPrecheckActions() { wx.navigateTo({ url: `/packages/annual/pages/precheck-actions/precheck-actions?id=${encodeURIComponent(this.data.id)}` }); },
  cancel() {
    const booking = this.data.booking;
    if (!booking || this.data.cancelling || this.data.paying || this.data.requoting) return;
    wx.showModal({
      title: booking.paymentStatus === "paid" ? "申请退款并取消预约" : "取消预约",
      content: booking.paymentStatus === "paid" ? "由你主动取消本次年检，按订单规则办理模拟退款并释放号源。洗车及维修独立订单不受影响。" : "取消后将释放该时段号源。",
      confirmColor: "#d84646",
      success: async ({ confirm }) => {
        if (!confirm) return;
        this.setData({ cancelling: true });
        try {
          await api.cancelBooking(booking.id);
          wx.showToast({ title: "预约已取消", icon: "success" });
          await this.load();
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "暂不能取消", icon: "none" });
        } finally {
          this.setData({ cancelling: false });
        }
      },
    });
  },
  goOrders() { wx.switchTab({ url: "/pages/orders/orders" }); },
  rebook() { wx.navigateTo({ url: "/packages/annual/pages/service-mode/service-mode" }); },
  goHome() { wx.switchTab({ url: "/pages/home/home" }); },
  callStation() {
    const phone = String(this.data.booking?.station?.phone || "").trim();
    if (!phone) {
      wx.showToast({ title: "检测站暂未提供联系电话", icon: "none" });
      return;
    }
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => wx.showToast({ title: "暂时无法拨打", icon: "none" }),
    });
  },
});
