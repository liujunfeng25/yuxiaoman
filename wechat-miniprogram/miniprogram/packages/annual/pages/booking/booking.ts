import { api, uploadMedia } from "../../../../services/api";
import { clearBookingDraft, getBookingDraft, patchBookingDraft } from "../../../../services/storage";
import type { BookingDraft, BookingQuote, MediaKind, PickupAddress, Vehicle } from "../../../../types";
import { distanceLabel, money } from "../../../../utils/format";
import { bookingQuoteAmountChanged, createBookingWithFreshQuote, isQuoteExpired, QuoteRefreshError } from "./quote-submission";
import { requiredUploadItems, updateUploadItem, type UploadItem } from "./upload-state";
declare function getCurrentPages(): unknown[];

type Data = { draft: BookingDraft | null; vehicles: Vehicle[]; vehicleId: string; vehicleIndex: number; quote: BookingQuote | null; quoteError: string; quoteBlocked: boolean; contactName: string; contactPhone: string; note: string; uploads: UploadItem[]; loading: boolean; loadError: string; canRetryLoad: boolean; quoting: boolean; submitting: boolean; mediaUploadingCount: number; money: typeof money; distanceLabel: typeof distanceLabel; paymentHint: string };
type ApiFailure = Error & { code?: string; statusCode?: number; fields?: Record<string, string> };
const validityConflictMessage = "用户确认日期与规则估算不一致，请先核验";
const quoteRefreshStoppedCode = "QUOTE_REFRESH_STOPPED";

function isValidityConflict(error: unknown): boolean {
  return error instanceof Error && (error as ApiFailure).code === "INSPECTION_VALIDITY_CONFLICT";
}

function quoteRefreshStopped(): ApiFailure {
  const error = new Error("报价刷新未完成") as ApiFailure;
  error.code = quoteRefreshStoppedCode;
  return error;
}

function confirmQuoteUpdate(before: BookingQuote, after: BookingQuote): Promise<boolean> {
  if (!bookingQuoteAmountChanged(before, after)) return Promise.resolve(true);
  return new Promise((resolve) => {
    wx.showModal({
      title: "报价金额已更新",
      content: `应付金额由 ¥${money(before.serviceFeeFen)} 调整为 ¥${money(after.serviceFeeFen)}。请确认最新费用明细后再提交预约。`,
      confirmText: "确认提交",
      success: ({ confirm }) => resolve(Boolean(confirm)),
    });
  });
}

Page<Data>({
  data: { draft: null, vehicles: [], vehicleId: "", vehicleIndex: 0, quote: null, quoteError: "", quoteBlocked: false, contactName: "", contactPhone: "", note: "", uploads: [], loading: true, loadError: "", canRetryLoad: false, quoting: false, submitting: false, mediaUploadingCount: 0, money, distanceLabel, paymentHint: "当前为本地演示流程，提交后可继续体验模拟支付，不会产生真实扣款。" },
  uploadSequences: {} as Partial<Record<MediaKind, number>>,
  async onLoad() {
    void this.loadPaymentHint();
    await this.load();
  },
  async loadPaymentHint() {
    try {
      const info = await api.paymentProvider();
      this.setData({
        paymentHint: info.wechatConfigured
          ? "提交预约后将进入订单详情，可通过微信支付完成付款。"
          : "当前为本地演示流程，提交后可继续体验模拟支付，不会产生真实扣款。",
      });
    } catch {
      // Keep mock hint when provider probe fails.
    }
  },
  async load() {
    this.setData({ loading: true, loadError: "", canRetryLoad: false });
    const draft = getBookingDraft();
    if (!draft?.station || !draft.slot) {
      this.setData({ loading: false, loadError: "预约草稿不完整，请返回首页重新选择验车方式、站点和时段。", canRetryLoad: false });
      return;
    }
    try {
      const vehicles = await api.vehicles(); const vehicleId = vehicles.some((item) => item.id === draft.vehicleId) ? draft.vehicleId! : vehicles.find((item) => item.isDefault)?.id || vehicles[0]?.id || "";
      this.setData({ draft, vehicles, vehicleId, vehicleIndex: Math.max(0, vehicles.findIndex((item) => item.id === vehicleId)), uploads: requiredUploadItems(draft.serviceMode, this.data.uploads), loadError: "", canRetryLoad: false });
      if (vehicleId) await this.quote();
    } catch (error) {
      const loadError = error instanceof Error ? error.message : "读取预约资料失败，请稍后重试";
      this.setData({ loadError, canRetryLoad: true });
      wx.showToast({ title: "预约资料读取失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  retryLoad() { if (!this.data.loading) void this.load(); },
  goHome() { wx.switchTab({ url: "/pages/home/home" }); },
  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    const draft = getBookingDraft();
    if (draft?.station) {
      wx.redirectTo({ url: `/packages/annual/pages/slots/slots?stationId=${encodeURIComponent(draft.station.id)}` });
      return;
    }
    this.goHome();
  },
  addVehicle() {
    const mode = this.data.draft?.serviceMode || "self_drive";
    wx.navigateTo({ url: `/packages/vehicle/pages/vehicle-form/vehicle-form?next=inspection_booking&serviceMode=${mode}&returnTo=inspection_booking` });
  },
  async quote(): Promise<BookingQuote | null> {
    const draft = getBookingDraft(); if (!draft?.station || !this.data.vehicleId) return null;
    this.setData({ quoting: true, quote: null, quoteError: "", quoteBlocked: false });
    try {
      const quote = await api.quote({ vehicleId: this.data.vehicleId, stationId: draft.station.id, serviceMode: draft.serviceMode, pickupAddress: draft.pickupAddress, originLat: draft.origin?.latitude, originLng: draft.origin?.longitude, originType: draft.origin?.type });
      this.setData({ quote, quoteError: "", quoteBlocked: false });
      return quote;
    } catch (error) {
      const conflict = isValidityConflict(error);
      const quoteError = conflict ? validityConflictMessage : error instanceof Error ? error.message : "报价计算失败，请稍后重试";
      this.setData({ quote: null, quoteError, quoteBlocked: conflict });
      wx.showToast({ title: conflict ? "请先核验年检日期" : "报价计算失败", icon: "none" });
      return null;
    }
    finally { this.setData({ quoting: false }); }
  },
  changeVehicle(event) { const vehicleIndex = Number(event.detail.value); const vehicleId = this.data.vehicles[vehicleIndex]?.id || ""; this.setData({ vehicleId, vehicleIndex }); void this.quote(); },
  input(event) { const field = event.currentTarget.dataset.field as "contactName" | "contactPhone" | "note"; this.setData({ [field]: event.detail.value }); },
  pickupInput(event) {
    const field = event.currentTarget.dataset.field as "detail" | "note"; const draft = getBookingDraft(); if (!draft?.pickupAddress) return;
    const pickupAddress: PickupAddress = { ...draft.pickupAddress, [field]: event.detail.value };
    patchBookingDraft({ pickupAddress }); this.setData({ draft: getBookingDraft() });
  },
  chooseMedia(event) {
    const kind = event.currentTarget.dataset.kind as MediaKind;
    const current = this.data.uploads.find((item) => item.kind === kind);
    if (!current || current.uploading) return;
    wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], success: async ({ tempFiles }) => {
      const file = tempFiles[0]; if (!file) return;
      const sequence = (this.uploadSequences[kind] || 0) + 1;
      this.uploadSequences[kind] = sequence;
      this.setData({ uploads: updateUploadItem(this.data.uploads, kind, { media: current.media, previewUrl: current.previewUrl, uploading: true }), mediaUploadingCount: this.data.mediaUploadingCount + 1 });
      try {
        const media = await uploadMedia(kind, file.tempFilePath);
        if (this.uploadSequences[kind] !== sequence) return;
        this.setData({ uploads: updateUploadItem(this.data.uploads, kind, { media, previewUrl: file.tempFilePath, uploading: false }) });
      } catch (error) {
        if (this.uploadSequences[kind] !== sequence) return;
        wx.showToast({ title: error instanceof Error ? error.message : "上传失败", icon: "none" });
        this.setData({ uploads: updateUploadItem(this.data.uploads, kind, { media: current.media, previewUrl: current.previewUrl, uploading: false }) });
      } finally {
        this.setData({ mediaUploadingCount: Math.max(0, this.data.mediaUploadingCount - 1) });
      }
    } });
  },
  async submit() {
    if (this.data.submitting || this.data.quoting) return;
    if (this.data.mediaUploadingCount > 0) { wx.showToast({ title: "请等待图片上传完成", icon: "none" }); return; }
    const draft = getBookingDraft(); const displayedQuote = this.data.quote;
    if (!draft?.station || !draft.slot || !this.data.vehicleId) { wx.showToast({ title: "预约信息不完整", icon: "none" }); return; }
    const station = draft.station; const slot = draft.slot; const vehicleId = this.data.vehicleId;
    if (this.data.quoteBlocked) { wx.showToast({ title: "请先核验年检日期", icon: "none" }); return; }
    if (this.data.contactName.trim().length < 2) { wx.showToast({ title: "联系人至少填写 2 个字", icon: "none" }); return; }
    if (!/^1[3-9]\d{9}$/.test(this.data.contactPhone.trim())) { wx.showToast({ title: "请输入正确手机号", icon: "none" }); return; }
    const missing = this.data.uploads.find((item) => !item.media);
    if (missing) { wx.showToast({ title: `请上传${missing.label}`, icon: "none" }); return; }
    if (!displayedQuote || !displayedQuote.serviceable) { wx.showToast({ title: displayedQuote?.reason === "origin_required" ? "请先确定取车地址" : "当前地址不可提供代驾", icon: "none" }); return; }
    this.setData({ submitting: true });
    try {
      let acceptedQuote = displayedQuote;
      const { booking } = await createBookingWithFreshQuote(
        async () => {
          const freshQuote = await this.quote();
          if (!freshQuote) throw quoteRefreshStopped();
          if (!freshQuote.serviceable) {
            wx.showToast({ title: freshQuote.reason === "origin_required" ? "请先确定取车地址" : "当前地址不可提供代驾", icon: "none" });
            throw quoteRefreshStopped();
          }
          if (!(await confirmQuoteUpdate(acceptedQuote, freshQuote))) throw quoteRefreshStopped();
          acceptedQuote = freshQuote;
          return freshQuote;
        },
        (quote) => api.createBooking({ vehicleId, stationId: station.id, slotId: slot.id, quoteSnapshotId: quote.quoteSnapshotId, contactName: this.data.contactName.trim(), contactPhone: this.data.contactPhone.trim(), serviceMode: draft.serviceMode, pickupAddress: draft.pickupAddress, mediaIds: this.data.uploads.map((item) => item.media!.id), quote: { inspectionFeeFen: quote.inspectionFeeFen, valetFeeFen: quote.valetFeeFen, serviceFeeFen: quote.serviceFeeFen }, notes: this.data.note || undefined }),
      );
      clearBookingDraft(); wx.showToast({ title: "订单已创建，请完成支付", icon: "success" }); wx.reLaunch({ url: `/packages/annual/pages/order-detail/order-detail?id=${booking.id}` });
    } catch (error) {
      if (error instanceof Error && (error as ApiFailure).code === quoteRefreshStoppedCode) {
        return;
      } else if (isValidityConflict(error)) {
        this.setData({ quote: null, quoteError: validityConflictMessage, quoteBlocked: true });
        wx.showToast({ title: "请先核验年检日期", icon: "none" });
      } else if (isQuoteExpired(error)) {
        this.setData({ quote: null, quoteError: "报价连续失效，请重新提交", quoteBlocked: false });
        wx.showToast({ title: "报价已失效，请重新提交", icon: "none" });
      } else if (error instanceof QuoteRefreshError) {
        this.setData({ quote: null, quoteError: error.message, quoteBlocked: false });
        wx.showToast({ title: error.message, icon: "none" });
      } else {
        const fields = (error as ApiFailure)?.fields;
        const fieldMessage = fields ? Object.values(fields).find((item) => Boolean(item)) : "";
        wx.showToast({ title: fieldMessage || (error instanceof Error ? error.message : "提交失败"), icon: "none" });
      }
    }
    finally { this.setData({ submitting: false }); }
  },
  verifyInspectionDate() {
    const draft = getBookingDraft();
    const vehicleId = encodeURIComponent(this.data.vehicleId || "");
    const mode = draft?.serviceMode || "self_drive";
    wx.redirectTo({ url: `/packages/annual/pages/eligibility/eligibility?vehicleId=${vehicleId}&serviceMode=${mode}&returnTo=inspection_booking` });
  },
});
