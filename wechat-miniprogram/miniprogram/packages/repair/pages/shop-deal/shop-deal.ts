import { repairOperatorApi } from "../../services/operator-api";
import {
  ensureRepairOperatorPageAccess,
  isDemoRepairOperatorSubject,
  readRepairOperatorSession,
} from "../../services/operator-session";
import {
  formatFenAmount,
  normalizeRepairShopDeal,
  type RepairShopDealView,
} from "../../utils/shop-model";
declare function getCurrentPages(): unknown[];

type Data = {
  id: string;
  shopName: string;
  isDemoShop: boolean;
  deal: RepairShopDealView | null;
  quoteAmountLabel: string;
  loading: boolean;
  locked: boolean;
  error: string;
};

Page<Data>({
  data: {
    id: "",
    shopName: "维修门店",
    isDemoShop: false,
    deal: null,
    quoteAmountLabel: "",
    loading: true,
    locked: false,
    error: "",
  },

  onLoad(query) {
    const id = query.id || "";
    const returnUrl = `/packages/repair/pages/shop-deal/shop-deal${id ? `?id=${encodeURIComponent(id)}` : ""}`;
    if (!ensureRepairOperatorPageAccess(returnUrl)) return;
    const session = readRepairOperatorSession();
    this.setData({
      id,
      shopName: session?.subject.name || "维修门店",
      isDemoShop: isDemoRepairOperatorSubject(session?.subject),
    });
  },

  onShow() {
    if (!ensureRepairOperatorPageAccess(`/packages/repair/pages/shop-deal/shop-deal?id=${encodeURIComponent(this.data.id)}`)) return;
    if (this.data.id) void this.load();
    else this.setData({ loading: false, locked: true, error: "缺少维修需求编号" });
  },

  async load() {
    this.setData({ loading: true, locked: false, error: "" });
    try {
      const deal = normalizeRepairShopDeal(await repairOperatorApi.repairShopDeal(this.data.id));
      if (!deal.eligible) {
        this.setData({ deal, locked: true, quoteAmountLabel: deal.quote ? formatFenAmount(deal.quote.totalFen) : "" });
        return;
      }
      this.setData({ deal, quoteAmountLabel: formatFenAmount(deal.quote?.totalFen) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取成交信息失败";
      this.setData({ locked: true, error: message });
    } finally {
      this.setData({ loading: false });
    }
  },

  copyContact() {
    const contact = this.data.deal?.contact;
    if (!this.data.deal?.eligible || !contact) return;
    wx.setClipboardData({ data: `${contact.name} ${contact.phone}` });
  },

  backHall() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: "/packages/repair/pages/shop-hall/shop-hall" });
  },

  retry() { void this.load(); },
});
