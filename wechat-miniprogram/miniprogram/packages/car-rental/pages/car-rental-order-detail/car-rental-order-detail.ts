import { api } from "../../../../services/api";
import type { CarRentalOrder } from "../../../../types";
import { backOrRentalHome } from "../../utils/navigation";
import { dateTimeLabel, energyLabel, fen, rentalStatus } from "../../utils/rental";

type OrderView = CarRentalOrder & {
  statusLabel: string;
  statusTone: string;
  statusDescription: string;
  pickupLabel: string;
  returnLabel: string;
  energyLabel: string;
  totalLabel: string;
  rentalFeeLabel: string;
  basicProtectionLabel: string;
  prepLabel: string;
  optionalLabel: string;
  deliveryLabel: string;
  vehicleDepositLabel: string;
  violationDepositLabel: string;
  canPay: boolean;
  canCancel: boolean;
  progressIndex: number;
  locationTitle: string;
  locationAddress: string;
};
type Data = { id: string; order: OrderView | null; loading: boolean; acting: boolean; error: string };

function orderView(order: CarRentalOrder): OrderView {
  const status = rentalStatus(order.status);
  const progress = ["confirmed", "ready_for_pickup", "in_use", "return_pending", "completed"];
  const progressIndex = Math.max(0, progress.indexOf(order.status));
  return {
    ...order,
    statusLabel: status.label, statusTone: status.tone, statusDescription: status.description,
    pickupLabel: dateTimeLabel(order.pickupAt), returnLabel: dateTimeLabel(order.returnAt), energyLabel: energyLabel(order.model.energyType),
    totalLabel: fen(order.quote.breakdown.prepaidTotalFen), rentalFeeLabel: fen(order.quote.breakdown.vehicleRentFen),
    basicProtectionLabel: fen(order.quote.breakdown.basicProtectionFen), prepLabel: fen(order.quote.breakdown.preparationFeeFen),
    optionalLabel: fen(order.quote.breakdown.optionalProtectionFen), deliveryLabel: fen(order.quote.breakdown.deliveryFeeFen),
    vehicleDepositLabel: fen(order.quote.deposits.vehicleDepositFen), violationDepositLabel: fen(order.quote.deposits.violationDepositFen),
    canPay: order.status === "pending_payment", canCancel: order.status === "pending_payment" || order.status === "confirmed" || order.status === "ready_for_pickup",
    progressIndex,
    locationTitle: order.fulfillmentMode === "home_delivery" ? order.deliveryAddress?.title || "同址送取" : order.store.name,
    locationAddress: order.fulfillmentMode === "home_delivery" ? order.deliveryAddress?.address || "" : order.store.address,
  };
}

Page<Data>({
  data: { id: "", order: null, loading: true, acting: false, error: "" },
  onLoad(query) {
    const id = decodeURIComponent(String(query.id || ""));
    this.setData({ id });
    if (String(query.created || "") === "1") wx.showToast({ title: "订单已创建", icon: "success" });
    void this.load();
  },
  onPullDownRefresh() { void this.load(true); },
  async load(fromPullDown = false) {
    if (!this.data.id) {
      this.setData({ loading: false, error: "缺少租车订单编号" });
      if (fromPullDown) wx.stopPullDownRefresh();
      return;
    }
    this.setData({ loading: true, error: "" });
    try {
      const order = await api.carRentalOrder(this.data.id);
      this.setData({ order: orderView(order) });
      if (order.orderNumber) wx.setNavigationBarTitle({ title: `订单 ${order.orderNumber}` });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "租车订单暂时无法读取" });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },
  pay() {
    const order = this.data.order;
    if (!order?.canPay || this.data.acting) return;
    wx.showModal({
      title: "确认模拟支付",
      content: `本次仅模拟支付 ¥${order.totalLabel}，不会调用微信支付，也不会发生真实资金扣款。`,
      confirmText: "模拟支付",
      confirmColor: "#1768d4",
      success: (result) => { if (result.confirm) void this.confirmPay(); },
    });
  },
  async confirmPay() {
    const order = this.data.order;
    if (!order) return;
    this.setData({ acting: true });
    try {
      const updated = await api.payCarRentalOrder(order.id, `wx-rental-pay-${order.id}-${Date.now()}`);
      this.setData({ order: orderView(updated) });
      wx.showModal({ title: "模拟支付成功", content: "订单已确认。当前为本地演示支付，没有调用微信支付，也没有真实资金流转。", confirmText: "查看订单", success: () => undefined });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "模拟支付失败", icon: "none", duration: 3000 });
      void this.load();
    } finally {
      this.setData({ acting: false });
    }
  },
  cancel() {
    const order = this.data.order;
    if (!order?.canCancel || this.data.acting) return;
    wx.showModal({
      title: "取消租车订单",
      content: "取消后将释放这款车型的租赁容量。演示订单不会产生真实退款。",
      confirmText: "确认取消",
      confirmColor: "#d64b4b",
      success: (result) => { if (result.confirm) void this.confirmCancel(); },
    });
  },
  async confirmCancel() {
    const order = this.data.order;
    if (!order) return;
    this.setData({ acting: true });
    try {
      const updated = await api.cancelCarRentalOrder(order.id);
      this.setData({ order: orderView(updated) });
      wx.showToast({ title: "订单已取消", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "取消失败", icon: "none" });
      void this.load();
    } finally {
      this.setData({ acting: false });
    }
  },
  modelImageError() {
    if (this.data.order?.model.imageUrl !== "/assets/brand/hero-car-generic.png") {
      this.setData({ "order.model.imageUrl": "/assets/brand/hero-car-generic.png" } as unknown as Partial<Data>);
    }
  },
  retry() { void this.load(); },
  backToRent() { backOrRentalHome(); },
  goRent() { wx.reLaunch({ url: "/packages/car-rental/pages/car-rental-home/car-rental-home" }); },
});
