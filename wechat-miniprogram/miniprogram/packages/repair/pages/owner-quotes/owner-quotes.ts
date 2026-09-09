import { api } from "../../../../services/api";
import type { RepairRequest, RepairRequestQuote } from "../../../../types";
import {
  defaultOwnerQuoteId,
  formatFenAmount,
  formatRepairDateTime,
  lowestActivePriceFen,
  quoteStatusLabel,
  sortOwnerQuotes,
} from "../../utils/owner-repair";

type QuoteView = RepairRequestQuote & {
  shopName: string;
  distanceText: string;
  ratingText: string;
  quotedAtText: string;
  priceText: string;
  statusText: string;
  selected: boolean;
  selectable: boolean;
  isLowest: boolean;
};

type Data = {
  id: string;
  request: RepairRequest | null;
  loading: boolean;
  paying: boolean;
  error: string;
  quoteViews: QuoteView[];
  activeQuoteCount: number;
  lowestPriceFen: number | null;
  selectedQuoteId: string;
  selectedPriceFen: number;
  selectedPriceText: string;
  plateText: string;
  faultCount: number;
};

function demoShopName(quote: RepairRequestQuote): string {
  const name = quote.shop.name;
  return quote.shop.isDemo && !name.includes("演示") ? `${name}（演示）` : name;
}

Page<Data>({
  data: {
    id: "",
    request: null,
    loading: true,
    paying: false,
    error: "",
    quoteViews: [],
    activeQuoteCount: 0,
    lowestPriceFen: null,
    selectedQuoteId: "",
    selectedPriceFen: 0,
    selectedPriceText: "0",
    plateText: "车辆信息未提供",
    faultCount: 0,
  },

  onLoad(query) {
    this.setData({ id: query.id || "", loading: Boolean(query.id) });
  },

  onShow() {
    if (this.data.id && !this.data.paying) void this.load();
    else if (!this.data.id) this.setData({ loading: false, error: "缺少维修询价编号，请从维修需求进入" });
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh());
  },

  applyRequest(request: RepairRequest) {
    const sorted = sortOwnerQuotes(request.quotes || []);
    const preferredId = request.selectedQuoteId || this.data.selectedQuoteId;
    const selectedQuoteId = defaultOwnerQuoteId(sorted, preferredId);
    const lowestPriceFen = lowestActivePriceFen(sorted);
    const quoteViews = sorted.map((quote) => ({
      ...quote,
      shopName: demoShopName(quote),
      distanceText: quote.shop.distanceKm === null || quote.shop.distanceKm === undefined ? "距离待确认" : `${quote.shop.distanceKm.toFixed(1)}km`,
      ratingText: quote.shop.rating === null || quote.shop.rating === undefined ? "暂无评分" : `${quote.shop.rating.toFixed(1)}分`,
      quotedAtText: formatRepairDateTime(quote.updatedAt || quote.createdAt),
      priceText: formatFenAmount(quote.totalPriceFen),
      statusText: quoteStatusLabel(quote.status),
      selected: quote.id === selectedQuoteId,
      selectable: (request.status === "open" && quote.status === "active")
        || (request.status === "pending_payment" && quote.id === request.selectedQuoteId),
      isLowest: quote.status === "active" && lowestPriceFen !== null && quote.totalPriceFen === lowestPriceFen,
    }));
    const selected = quoteViews.find((quote) => quote.id === selectedQuoteId);
    this.setData({
      request,
      quoteViews,
      activeQuoteCount: sorted.filter((quote) => quote.status === "active").length,
      lowestPriceFen,
      selectedQuoteId,
      selectedPriceFen: selected?.totalPriceFen || 0,
      selectedPriceText: formatFenAmount(selected?.totalPriceFen || 0),
      plateText: request.vehicle.plateNumber,
      faultCount: request.faults.length,
    });
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try {
      this.applyRequest(await api.repairRequest(this.data.id));
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "读取维修报价失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  selectQuote(event) {
    const id = String(event.detail?.value || "");
    const selected = this.data.quoteViews.find((quote) => quote.id === id && quote.selectable);
    if (!selected) return;
    this.setData({
      selectedQuoteId: id,
      selectedPriceFen: selected.totalPriceFen,
      selectedPriceText: formatFenAmount(selected.totalPriceFen),
      quoteViews: this.data.quoteViews.map((quote) => ({ ...quote, selected: quote.id === id })),
    });
  },

  viewRequest() {
    if (!this.data.request) return;
    wx.navigateTo({ url: `/packages/repair/pages/owner-request-detail/owner-request-detail?id=${encodeURIComponent(this.data.request.id)}` });
  },

  deferSelection() {
    if (!this.data.request) return;
    wx.redirectTo({ url: `/packages/repair/pages/owner-request-detail/owner-request-detail?id=${encodeURIComponent(this.data.request.id)}` });
  },

  viewReceipt() {
    if (!this.data.request) return;
    wx.redirectTo({ url: `/packages/repair/pages/owner-receipt/owner-receipt?id=${encodeURIComponent(this.data.request.id)}` });
  },

  async paySelectedQuote() {
    const request = this.data.request;
    if (!request || this.data.paying) return;
    if (request.status === "paid") {
      this.viewReceipt();
      return;
    }
    if (request.status !== "open" && request.status !== "pending_payment") {
      wx.showToast({ title: "该维修询价当前不能支付", icon: "none" });
      return;
    }
    const quote = this.data.quoteViews.find((item) => item.id === this.data.selectedQuoteId && item.selectable);
    if (!quote) {
      wx.showToast({ title: "请选择一份有效报价", icon: "none" });
      return;
    }

    this.setData({ paying: true, error: "" });
    try {
      const idempotencyKey = this.paymentRequestId === request.id && this.paymentQuoteId === quote.id && this.paymentKey
        ? this.paymentKey
        : `repair-pay-${request.id}-${quote.id}-${Date.now()}`;
      this.paymentRequestId = request.id;
      this.paymentQuoteId = quote.id;
      this.paymentKey = idempotencyKey;
      const paid = await api.payRepairRequest(request.id, quote.id, idempotencyKey);
      this.applyRequest(paid);
      wx.showToast({ title: "支付成功", icon: "success" });
      wx.redirectTo({ url: `/packages/repair/pages/owner-receipt/owner-receipt?id=${encodeURIComponent(paid.id)}` });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "支付失败，请重试" });
    } finally {
      this.setData({ paying: false });
    }
  },

  retry() { void this.load(); },
  goHome() { wx.switchTab({ url: "/pages/home/home" }); },
});
