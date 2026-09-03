import { api } from "../../../../services/api";
import { patchWashDraft } from "../../../../services/storage";
import type { WashOrder, WashSlot } from "../../../../types";
import { money, today, washStatusLabel } from "../../../../utils/format";

type Data = {
  id: string;
  order: WashOrder | null;
  loading: boolean;
  missingOrder: boolean;
  busy: boolean;
  error: string;
  statusText: string;
  statusDescription: string;
  displayCode: string;
  showCode: boolean;
  canPay: boolean;
  canCancel: boolean;
  canReschedule: boolean;
  isTerminal: boolean;
  money: typeof money;
};

function addDays(date: string, amount: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function statusDescription(order: WashOrder): string {
  if (order.status === "pending_payment") return order.serviceMode === "valet" ? "请完成模拟支付，支付后即可获得六位取送核销码。" : "请完成模拟支付，支付后即可获得六位核销码。";
  if (order.status === "awaiting_redemption") return order.serviceMode === "valet" ? "预约已生效，等待车辆交接与运营线下完成门店核销。" : "预约已生效，到店后向门店出示核销码。";
  if (order.status === "redeemed") return "门店已核销，本次洗车服务已完成。";
  if (order.status === "cancelled") return "订单已取消，不再占用原预约时段。";
  if (order.status === "refunded") return "订单已退款，具体到账时间以支付渠道为准。";
  return "订单已过期，可以重新选择套餐和时间。";
}

function displayCode(order: WashOrder): string {
  const code = String(order.redemptionCode || order.verificationCode || "").replace(/\s/g, "");
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

Page<Data>({
  data: {
    id: "",
    order: null,
    loading: true,
    missingOrder: false,
    busy: false,
    error: "",
    statusText: "",
    statusDescription: "",
    displayCode: "",
    showCode: false,
    canPay: false,
    canCancel: false,
    canReschedule: false,
    isTerminal: false,
    money,
  },

  onLoad(query) {
    const id = query.id || "";
    this.setData({ id, loading: Boolean(id), missingOrder: !id });
  },
  onShow() {
    if (this.data.id) void this.load();
    else this.setData({ loading: false, missingOrder: true });
  },

  applyOrder(order: WashOrder) {
    const code = displayCode(order);
    const terminal = ["redeemed", "cancelled", "refunded", "expired"].includes(order.status);
    this.setData({
      order,
      statusText: washStatusLabel(order.status),
      statusDescription: statusDescription(order),
      displayCode: code,
      showCode: Boolean(code) && order.status !== "pending_payment" && !["cancelled", "refunded", "expired"].includes(order.status),
      canPay: order.status === "pending_payment",
      canCancel: ["pending_payment", "awaiting_redemption"].includes(order.status),
      canReschedule: ["pending_payment", "awaiting_redemption"].includes(order.status),
      isTerminal: terminal,
    });
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try { this.applyOrder(await api.washOrder(this.data.id)); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : "读取洗车订单失败" }); }
    finally { this.setData({ loading: false }); }
  },

  copyCode() {
    const order = this.data.order;
    const code = String(order?.redemptionCode || order?.verificationCode || "").replace(/\s/g, "");
    if (!code) return;
    wx.setClipboardData({ data: code, success: () => wx.showToast({ title: order?.serviceMode === "valet" ? "取送码已复制" : "核销码已复制", icon: "success" }) });
  },

  callStore() {
    const phone = this.data.order?.store?.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone });
    else wx.showToast({ title: "门店暂未提供联系电话", icon: "none" });
  },

  navigateStore() {
    const store = this.data.order?.store;
    if (store && Number.isFinite(store.latitude) && Number.isFinite(store.longitude)) {
      wx.openLocation({ latitude: Number(store.latitude), longitude: Number(store.longitude), name: store.name, address: store.address, scale: 16 });
    } else wx.showToast({ title: "门店导航信息暂不可用", icon: "none" });
  },

  pay() {
    const order = this.data.order;
    if (order) wx.navigateTo({ url: `/packages/wash/pages/wash-payment/wash-payment?id=${encodeURIComponent(order.id)}` });
  },

  cancel() {
    const order = this.data.order;
    if (!order || this.data.busy) return;
    wx.showModal({
      title: "取消洗车预约",
      content: "取消后将释放当前预约时段。已支付订单的退款状态以订单记录为准。",
      confirmText: "确认取消",
      confirmColor: "#df4b62",
      success: async ({ confirm }) => {
        if (!confirm) return;
        this.setData({ busy: true });
        try { this.applyOrder(await api.cancelWashOrder(order.id)); wx.showToast({ title: "预约已取消", icon: "success" }); }
        catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "暂时无法取消", icon: "none" }); }
        finally { this.setData({ busy: false }); }
      },
    });
  },

  async reschedule() {
    const order = this.data.order;
    if (!order || this.data.busy) return;
    this.setData({ busy: true });
    try {
      const dates = Array.from({ length: 5 }, (_, index) => addDays(today(), index));
      const groups = await Promise.all(dates.map((date) => api.washSlots(order.storeId, date, order.packageId).catch(() => [] as WashSlot[])));
      const available = groups.flat().filter((slot) => slot.remaining > 0 && slot.id !== order.slotId).slice(0, 6);
      if (!available.length) throw new Error("未来五天暂无其他可约时段");
      wx.showActionSheet({
        itemList: available.map((slot) => `${slot.date} ${slot.startTime}${slot.endTime ? `–${slot.endTime}` : ""}`),
        success: async ({ tapIndex }) => {
          const slot = available[tapIndex];
          if (!slot) return;
          this.setData({ busy: true });
          try { this.applyOrder(await api.rescheduleWashOrder(order.id, slot.id)); wx.showToast({ title: "改期成功", icon: "success" }); }
          catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "改期失败", icon: "none" }); }
          finally { this.setData({ busy: false }); }
        },
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "读取可约时间失败", icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },

  bookAgain() {
    const order = this.data.order;
    if (!order) return;
    patchWashDraft({ serviceMode: order.serviceMode, pickupAddress: order.pickupAddress || undefined, vehicleId: order.vehicleId, storeId: order.storeId, packageId: order.packageId, date: order.appointmentDate });
    wx.navigateTo({ url: "/packages/wash/pages/wash-booking/wash-booking" });
  },

  goOrders() { wx.switchTab({ url: "/pages/orders/orders" }); },
  goHome() { wx.switchTab({ url: "/pages/home/home" }); },
  retry() { void this.load(); },
});
