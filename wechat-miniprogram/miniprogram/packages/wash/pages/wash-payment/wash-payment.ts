import { api } from "../../../../services/api";
import type { WashOrder } from "../../../../types";
import { money } from "../../../../utils/format";

type Data = {
  id: string;
  order: WashOrder | null;
  loading: boolean;
  missingOrder: boolean;
  paying: boolean;
  error: string;
  money: typeof money;
};

Page<Data>({
  data: { id: "", order: null, loading: true, missingOrder: false, paying: false, error: "", money },

  onLoad(query) {
    const id = query.id || "";
    this.setData({ id, loading: Boolean(id), missingOrder: !id });
  },
  onShow() {
    if (this.data.id) void this.load();
    else this.setData({ loading: false, missingOrder: true });
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try { this.setData({ order: await api.washOrder(this.data.id) }); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : "读取订单失败" }); }
    finally { this.setData({ loading: false }); }
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
