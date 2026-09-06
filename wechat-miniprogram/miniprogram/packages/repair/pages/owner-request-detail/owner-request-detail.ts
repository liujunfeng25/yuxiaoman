import { api } from "../../../../services/api";
import { localizeOwnerMedia } from "../../../../services/owner-media";
import type { RepairRequest } from "../../../../types";
import {
  faultTypeLabel,
  formatFenAmount,
  formatRepairDateTime,
  lowestActivePriceFen,
  ownerRepairStatusView,
  regionLabel,
  severityLabel,
  severityTone,
  sortOwnerQuotes,
  viewLabel,
} from "../../utils/owner-repair";

type RepairFault = RepairRequest["faults"][number];
type FaultView = RepairFault & {
  number: number;
  title: string;
  locationText: string;
  severityText: string;
  severityTone: "minor" | "moderate" | "severe" | "pending";
  descriptionText: string;
};

type Data = {
  id: string;
  request: RepairRequest | null;
  loading: boolean;
  busy: boolean;
  error: string;
  statusTitle: string;
  statusDescription: string;
  statusTone: "waiting" | "quoted" | "paid" | "cancelled";
  statusIconPath: string;
  canCancel: boolean;
  canChooseQuote: boolean;
  activeQuoteCount: number;
  lowestPriceFen: number | null;
  lowestPriceText: string;
  faultViews: FaultView[];
  photoCount: number;
  allPhotoUrls: string[];
  createdAtText: string;
  updatedAtText: string;
  paidShopName: string;
  paidPriceFen: number;
  paidPriceText: string;
};

Page<Data>({
  data: {
    id: "",
    request: null,
    loading: true,
    busy: false,
    error: "",
    statusTitle: "等待修理店报价",
    statusDescription: "需求正在接单大厅等待修理店报价。",
    statusTone: "waiting",
    statusIconPath: "/assets/icons/clock.png",
    canCancel: false,
    canChooseQuote: false,
    activeQuoteCount: 0,
    lowestPriceFen: null,
    lowestPriceText: "0",
    faultViews: [],
    photoCount: 0,
    allPhotoUrls: [],
    createdAtText: "待更新",
    updatedAtText: "待更新",
    paidShopName: "",
    paidPriceFen: 0,
    paidPriceText: "0",
  },

  onLoad(query) {
    this.setData({ id: query.id || "", loading: Boolean(query.id) });
  },

  onShow() {
    if (this.data.id && !this.data.busy) void this.load();
    else if (!this.data.id) this.setData({ loading: false, error: "缺少维修询价编号，请从维修需求列表进入" });
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh());
  },

  applyRequest(request: RepairRequest) {
    const sortedQuotes = sortOwnerQuotes(request.quotes || []);
    const activeQuotes = sortedQuotes.filter((quote) => quote.status === "active");
    const status = ownerRepairStatusView(request.status, activeQuotes.length);
    const faultViews: FaultView[] = request.faults.map((fault, index) => ({
      ...fault,
      number: index + 1,
      title: request.sourceType === "precheck" ? `${regionLabel(fault.regionCode)} · 维修` : `${regionLabel(fault.regionCode)} · ${faultTypeLabel(fault.faultType)}`,
      locationText: request.sourceType === "precheck" ? "年检预检原始照片" : `${viewLabel(fault.viewId)}定位`,
      severityText: severityLabel(fault.severity),
      severityTone: fault.severity === "unassessed" ? "pending" : severityTone(fault.severity),
      descriptionText: fault.description || "检测报告未填写补充描述",
    }));
    const allPhotoUrls = request.media.map((media) => media.url).filter(Boolean);
    const selectedQuote = request.quotes.find((quote) => quote.id === request.selectedQuoteId);
    const lowestPriceFen = lowestActivePriceFen(activeQuotes);
    const paidPriceFen = request.order?.totalPriceFen || selectedQuote?.totalPriceFen || 0;
    this.setData({
      request,
      statusTitle: status.title,
      statusDescription: status.description,
      statusTone: status.tone,
      statusIconPath: status.iconPath,
      canCancel: status.canCancel,
      canChooseQuote: status.canChooseQuote,
      activeQuoteCount: activeQuotes.length,
      lowestPriceFen,
      lowestPriceText: formatFenAmount(lowestPriceFen),
      faultViews,
      photoCount: allPhotoUrls.length,
      allPhotoUrls,
      createdAtText: formatRepairDateTime(request.createdAt),
      updatedAtText: formatRepairDateTime(request.updatedAt),
      paidShopName: request.order?.shop.name || selectedQuote?.shop.name || "",
      paidPriceFen,
      paidPriceText: formatFenAmount(paidPriceFen),
    });
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try {
      this.applyRequest(await api.repairRequest(this.data.id));
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "读取维修需求失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  openQuotes() {
    if (!this.data.request || !this.data.canChooseQuote) return;
    wx.navigateTo({ url: `/packages/repair/pages/owner-quotes/owner-quotes?id=${encodeURIComponent(this.data.request.id)}` });
  },

  openReceipt() {
    if (!this.data.request || this.data.request.status !== "paid") return;
    wx.navigateTo({ url: `/packages/repair/pages/owner-receipt/owner-receipt?id=${encodeURIComponent(this.data.request.id)}` });
  },

  openReport() {
    if (this.data.request?.sourceType === "precheck") { wx.navigateTo({ url: `/packages/annual/pages/precheck-actions/precheck-actions?id=${encodeURIComponent(this.data.request.sourceBookingId || "")}` }); return; }
    const bookingId = this.data.request?.report.bookingId;
    if (!bookingId) return;
    wx.navigateTo({ url: `/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(bookingId)}` });
  },

  previewPhoto(event) {
    const current = String(event.currentTarget.dataset.url || "");
    if (!current || !this.data.allPhotoUrls.length) return;
    wx.previewImage({ current, urls: this.data.allPhotoUrls });
  },

  async recoverPrivatePhoto(mediaId: string, sourceUrl: string) {
    const request = this.data.request;
    if (!request || !mediaId || !sourceUrl) return;
    try {
      const url = await localizeOwnerMedia(sourceUrl, { forceRefresh: true });
      const updatePhoto = (photo: RepairFault["photos"][number]) => photo.id === mediaId
        ? { ...photo, url, sourceUrl, loadState: "ready" as const }
        : photo;
      this.applyRequest({
        ...request,
        media: request.media.map(updatePhoto),
        faults: request.faults.map((fault) => ({ ...fault, photos: fault.photos.map(updatePhoto) })),
      });
    } catch {
      wx.showToast({ title: "照片重新读取失败，请稍后重试", icon: "none" });
    }
  },

  handlePhotoTap(event) {
    const current = String(event.currentTarget.dataset.url || "");
    if (current) {
      this.previewPhoto(event);
      return;
    }
    void this.recoverPrivatePhoto(
      String(event.currentTarget.dataset.mediaId || ""),
      String(event.currentTarget.dataset.sourceUrl || ""),
    );
  },

  handlePrivatePhotoError(event) {
    void this.recoverPrivatePhoto(
      String(event.currentTarget.dataset.mediaId || ""),
      String(event.currentTarget.dataset.sourceUrl || ""),
    );
  },

  cancelRequest() {
    const request = this.data.request;
    if (!request || !this.data.canCancel || this.data.busy) return;
    wx.showModal({
      title: "取消维修询价",
      content: "取消后将停止接收新报价，当前报价不能再选择或支付。历史需求会保留为询价记录。",
      confirmText: "确认取消",
      confirmColor: "#C94C46",
      success: async ({ confirm }) => {
        if (!confirm) return;
        this.setData({ busy: true, error: "" });
        try {
          this.applyRequest(await api.cancelRepairRequest(request.id));
          wx.showToast({ title: "维修询价已取消", icon: "success" });
        } catch (error) {
          this.setData({ error: error instanceof Error ? error.message : "取消询价失败，请重试" });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },

  retry() { void this.load(); },
  goHome() { wx.switchTab({ url: "/pages/home/home" }); },
});
