import { api } from "../../../../services/api";
import type { WashOrder } from "../../../../types";
import { money } from "../../../../utils/format";

type PaymentChannel = "wechat" | "mock";

type Data = {
  id: string;
  order: WashOrder | null;
  loading: boolean;
  missingOrder: boolean;
  paying: boolean;
  error: string;
  money: typeof money;
  paymentChannel: PaymentChannel;
  heroPendingLabel: string;
  heroPaidLabel: string;
  heroPendingHint: string;
  safetyTitle: string;
  safetyCopy: string;
};

function washPaymentCopy(channel: PaymentChannel, serviceMode: "valet" | "self_drive" | string) {
  const valet = serviceMode === "valet";
  if (channel === "wechat") {
    return {
      heroPendingLabel: "本次微信支付",
      heroPaidLabel: "支付已完成",
      heroPendingHint: valet
        ? "上门取送 · 往返已含 · 确认后将调起微信支付"
        : "确认后将调起微信支付",
      safetyTitle: "微信支付",
      safetyCopy: "将调起微信支付完成付款；到账以微信收款与后台回调确认为准。",
    };
  }
  return {
    heroPendingLabel: "本次模拟支付",
    heroPaidLabel: "模拟支付已完成",
    heroPendingHint: valet
      ? "上门取送 · 往返已含 · 确认后不会真实扣款"
      : "确认后不会发生真实扣款",
    safetyTitle: "仅用于演示预约闭环",
    safetyCopy: "不会唤起微信支付、银行卡或任何真实资金渠道。",
  };
}

Page<Data>({
  data: {
    id: "",
    order: null,
    loading: true,
    missingOrder: false,
    paying: false,
    error: "",
    money,
    paymentChannel: "mock",
    ...washPaymentCopy("mock", "self_drive"),
  },

  onLoad(query) {
    const id = query.id || "";
    this.setData({ id, loading: Boolean(id), missingOrder: !id });
    void this.loadPaymentChannel();
  },
  onShow() {
    if (this.data.id) void this.load();
    else this.setData({ loading: false, missingOrder: true });
  },

  async loadPaymentChannel() {
    try {
      const info = await api.paymentProvider();
      const paymentChannel: PaymentChannel = info.wechatConfigured ? "wechat" : "mock";
      const order = this.data.order;
      this.setData({
        paymentChannel,
        ...washPaymentCopy(paymentChannel, order?.serviceMode || "self_drive"),
      });
    } catch {
      // Keep mock copy when provider probe fails.
    }
  },

  applyPaymentCopy(order: WashOrder | null, channel = this.data.paymentChannel) {
    this.setData(washPaymentCopy(channel, order?.serviceMode || "self_drive"));
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const order = await api.washOrder(this.data.id);
      this.setData({ order });
      this.applyPaymentCopy(order);
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "读取订单失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async pay() {
    const order = this.data.order;
    if (!order || this.data.paying) return;
    if (order.status !== "pending_payment") {
      wx.redirectTo({ url: `/packages/wash/pages/wash-order-detail/wash-order-detail?id=${encodeURIComponent(order.id)}` });
      return;
    }
    this.setData({ paying: true, error: "" });
    try {
      const idempotencyKey = this.paymentOrderId === order.id && this.paymentKey
        ? this.paymentKey
        : `wash-pay-${order.id}-${Date.now()}`;
      this.paymentOrderId = order.id;
      this.paymentKey = idempotencyKey;
      const paid = await api.payWashOrder(order.id, idempotencyKey);
      this.setData({ order: paid });
      this.applyPaymentCopy(paid);
      wx.showToast({ title: "支付成功", icon: "success" });
      wx.redirectTo({ url: `/packages/wash/pages/wash-order-detail/wash-order-detail?id=${encodeURIComponent(paid.id)}` });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "支付失败，请重试" });
    } finally {
      this.setData({ paying: false });
    }
  },

  viewOrder() {
    const order = this.data.order;
    if (order) wx.redirectTo({ url: `/packages/wash/pages/wash-order-detail/wash-order-detail?id=${encodeURIComponent(order.id)}` });
  },

  goOrders() { wx.switchTab({ url: "/pages/orders/orders" }); },
  goHome() { wx.switchTab({ url: "/pages/home/home" }); },
  retry() { void this.load(); },
});
