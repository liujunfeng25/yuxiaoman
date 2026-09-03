import { api } from "../../../../services/api";
import { getCarRentalDraft, getRecentContact, patchCarRentalDraft, storeRecentContact } from "../../../../services/storage";
import type { CarRentalQuote } from "../../../../types";
import { backOrRentalHome } from "../../utils/navigation";
import { dateTimeLabel, energyLabel, fen } from "../../utils/rental";

type QuoteView = CarRentalQuote & {
  pickupLabel: string;
  returnLabel: string;
  rentalFeeLabel: string;
  basicProtectionLabel: string;
  preparationLabel: string;
  optionalProtectionLabel: string;
  deliveryLabel: string;
  totalLabel: string;
  vehicleDepositLabel: string;
  violationDepositLabel: string;
  routeLabel: string;
  energyLabel: string;
  locationTitle: string;
  locationAddress: string;
};
type Data = {
  quote: QuoteView | null;
  includeOptionalProtection: boolean;
  driverName: string;
  driverPhone: string;
  licenseConfirmed: boolean;
  loading: boolean;
  submitting: boolean;
  error: string;
};

function quoteView(quote: CarRentalQuote): QuoteView {
  return {
    ...quote,
    pickupLabel: dateTimeLabel(quote.pickupAt), returnLabel: dateTimeLabel(quote.returnAt),
    rentalFeeLabel: fen(quote.breakdown.vehicleRentFen),
    basicProtectionLabel: fen(quote.breakdown.basicProtectionFen),
    preparationLabel: fen(quote.breakdown.preparationFeeFen),
    optionalProtectionLabel: fen(quote.breakdown.optionalProtectionFen),
    deliveryLabel: fen(quote.breakdown.deliveryFeeFen),
    totalLabel: fen(quote.breakdown.prepaidTotalFen),
    vehicleDepositLabel: fen(quote.deposits.vehicleDepositFen),
    violationDepositLabel: fen(quote.deposits.violationDepositFen),
    routeLabel: quote.route ? `${quote.route.distanceKm.toFixed(1)}km${quote.route.source === "tencent" ? " · 腾讯驾车路线" : ""}` : "",
    energyLabel: energyLabel(quote.model.energyType),
    locationTitle: quote.fulfillmentMode === "home_delivery" ? quote.deliveryAddress?.title || "同址送取" : quote.store.name,
    locationAddress: quote.fulfillmentMode === "home_delivery" ? quote.deliveryAddress?.address || "" : quote.store.address,
  };
}

function quoteError(error: unknown): string {
  const code = String((error as { code?: string })?.code || "");
  if (/ROUTE|DISTANCE/.test(code)) return "暂时无法取得可信驾车路线，为避免错误收取送取费，本次不能生成送车报价。请稍后重试或改选门店取还。";
  if (/OUT_OF_RANGE/.test(code)) return "该地址超出门店 20km 送车范围，请更换地址或选择门店取还。";
  if (/PROOF/.test(code)) return "地址校验已失效，请返回重新搜索并选择送取车地址。";
  if (/NO_CAPACITY|UNAVAILABLE/.test(code)) return "这款车型刚刚被订完，请返回选择其他车型。";
  return error instanceof Error ? error.message : "暂时无法确认租车价格";
}

Page<Data>({
  data: { quote: null, includeOptionalProtection: false, driverName: "", driverPhone: "", licenseConfirmed: false, loading: true, submitting: false, error: "" },
  onLoad() {
    const contact = getRecentContact();
    this.setData({ driverName: contact.name, driverPhone: contact.phone });
    void this.loadQuote();
  },
  onPullDownRefresh() { void this.loadQuote(true); },
  async loadQuote(fromPullDown = false) {
    const draft = getCarRentalDraft();
    if (!draft?.selectedModelId) {
      this.setData({ loading: false, error: "车型选择已失效，请返回重新选择" });
      if (fromPullDown) wx.stopPullDownRefresh();
      return;
    }
    this.setData({ loading: true, error: "", quote: null });
    try {
      const quote = await api.carRentalQuote(draft, draft.selectedModelId, this.data.includeOptionalProtection);
      if (!quote.quoteSnapshotId) throw new Error("报价缺少快照编号，请稍后重试");
      const view = quoteView(quote);
      this.setData({ quote: view });
      patchCarRentalDraft({ quote });
    } catch (error) {
      this.setData({ error: quoteError(error) });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },
  toggleProtection(event) {
    const values = (event.detail.value || []) as string[];
    this.setData({ includeOptionalProtection: values.includes("optional") });
    void this.loadQuote();
  },
  inputDriverName(event) { this.setData({ driverName: String(event.detail.value || "") }); },
  inputDriverPhone(event) { this.setData({ driverPhone: String(event.detail.value || "") }); },
  toggleLicense(event) {
    const values = (event.detail.value || []) as string[];
    this.setData({ licenseConfirmed: values.includes("confirmed") });
  },
  async submit() {
    const quote = this.data.quote;
    const driverName = this.data.driverName.trim();
    const driverPhone = this.data.driverPhone.trim();
    if (!quote) { wx.showToast({ title: "请先取得有效报价", icon: "none" }); return; }
    if (driverName.length < 2) { wx.showToast({ title: "请填写驾驶员姓名", icon: "none" }); return; }
    if (!/^1\d{10}$/.test(driverPhone)) { wx.showToast({ title: "请填写 11 位手机号", icon: "none" }); return; }
    if (!this.data.licenseConfirmed) { wx.showToast({ title: "请确认驾驶员持有效驾驶证", icon: "none" }); return; }
    this.setData({ submitting: true });
    try {
      const idempotencyKey = `wx-rental-${quote.quoteSnapshotId}-${Date.now()}`;
      const order = await api.createCarRentalOrder({ quoteId: quote.quoteSnapshotId, driverName, driverPhone, licenseConfirmed: true, idempotencyKey });
      if (!order.id) throw new Error("订单创建成功但未返回订单编号");
      storeRecentContact({ name: driverName, phone: driverPhone });
      wx.redirectTo({ url: `/packages/car-rental/pages/car-rental-order-detail/car-rental-order-detail?id=${encodeURIComponent(order.id)}&created=1` });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "订单提交失败", icon: "none", duration: 3000 });
      if (/QUOTE|EXPIRED|CAPACITY/.test(String((error as { code?: string })?.code || ""))) void this.loadQuote();
    } finally {
      this.setData({ submitting: false });
    }
  },
  modelImageError() {
    if (this.data.quote?.model.imageUrl !== "/assets/brand/hero-car-generic.png") {
      this.setData({ "quote.model.imageUrl": "/assets/brand/hero-car-generic.png" } as unknown as Partial<Data>);
    }
  },
  retry() { void this.loadQuote(); },
  changeTrip() { backOrRentalHome(3); },
});
