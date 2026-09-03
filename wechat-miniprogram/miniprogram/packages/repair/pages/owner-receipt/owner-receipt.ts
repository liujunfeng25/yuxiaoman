import { api } from "../../../../services/api";
import type { RepairRequest } from "../../../../types";
import { formatFenAmount, formatRepairDateTime } from "../../utils/owner-repair";

type Data = {
  id: string;
  request: RepairRequest | null;
  loading: boolean;
  error: string;
  ready: boolean;
  shopName: string;
  quoteNote: string;
  amountFen: number;
  amountText: string;
  paidAtText: string;
  contactName: string;
  contactPhone: string;
  addressText: string;
  openHoursText: string;
};

Page<Data>({
  data: {
    id: "",
    request: null,
    loading: true,
    error: "",
    ready: false,
    shopName: "",
    quoteNote: "门店未填写补充维修说明",
    amountFen: 0,
    amountText: "0",
    paidAtText: "待确认",
    contactName: "门店服务人员",
    contactPhone: "",
    addressText: "门店地址待确认",
    openHoursText: "营业时间请电话确认",
  },

  onLoad(query) {
    this.setData({ id: query.id || "", loading: Boolean(query.id) });
  },

  onShow() {
    if (this.data.id) void this.load();
    else this.setData({ loading: false, error: "缺少维修询价编号，请从维修需求进入" });
  },

  applyRequest(request: RepairRequest) {
    const order = request.order;
    const selectedQuote = request.quotes.find((quote) => quote.id === request.selectedQuoteId);
    const ready = request.status === "paid" && Boolean(order);
    const amountFen = order?.totalPriceFen || selectedQuote?.totalPriceFen || 0;
    this.setData({
      request,
      ready,
      shopName: order?.shop.name || selectedQuote?.shop.name || "修理店信息待确认",
      quoteNote: selectedQuote?.note || "门店未填写补充维修说明",
      amountFen,
      amountText: formatFenAmount(amountFen),
      paidAtText: formatRepairDateTime(order?.paidAt || request.paidAt),
      contactName: order?.shop.contactName || "门店服务人员",
      contactPhone: order?.shop.contactPhone || "",
      addressText: order?.shop.address || "门店地址待确认",
      openHoursText: order?.shop.openHours || "营业时间请电话确认",
    });
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try {
      this.applyRequest(await api.repairRequest(this.data.id));
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "读取成交回执失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  callShop() {
    if (!this.data.contactPhone) {
      wx.showToast({ title: "门店暂未提供联系电话", icon: "none" });
      return;
    }
    wx.makePhoneCall({ phoneNumber: this.data.contactPhone });
  },

  copyOrderNumber() {
    const orderNo = this.data.request?.order?.orderNo;
    if (!orderNo) return;
    wx.setClipboardData({ data: orderNo, success: () => wx.showToast({ title: "成交单号已复制", icon: "success" }) });
  },

  viewRequest() {
    if (!this.data.request) return;
    wx.redirectTo({ url: `/packages/repair/pages/owner-request-detail/owner-request-detail?id=${encodeURIComponent(this.data.request.id)}` });
  },

  retry() { void this.load(); },
  goHome() { wx.switchTab({ url: "/pages/home/home" }); },
});
