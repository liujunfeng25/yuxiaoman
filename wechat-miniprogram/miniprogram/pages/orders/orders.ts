import { api } from "../../services/api";
import { refreshOwnerWorkflowUnreadBadge } from "../../services/workflow";
import type { Booking, RepairRequestSummary, WashOrder } from "../../types";
import { statusLabel, washStatusLabel } from "../../utils/format";

type ServiceOrder = { id: string; serviceLabel: string; status: string; number: string; name: string; storeName: string; appointment: string; priceFen: number; showPrice: boolean; priceText: string; createdAt: string; detailUrl: string };
type Data = { orders: ServiceOrder[]; loading: boolean; unreadCount: number };

function inspectionOrder(item: Booking): ServiceOrder {
  const currentStatus = statusLabel(item.status);
  const status = item.precheck?.status === "approved" ? `预审已通过 · ${currentStatus}` : currentStatus;
  return { id: item.id, serviceLabel: "年检", status, number: item.bookingNumber, name: `${item.vehicle?.plateNumber || "已选车辆"} · 年检预约`, storeName: item.station?.name || "机动车检测站", appointment: `${item.appointmentDate} ${item.startTime}`, priceFen: item.serviceFeeFen, showPrice: true, priceText: "", createdAt: item.createdAt, detailUrl: `/packages/annual/pages/order-detail/order-detail?id=${item.id}` };
}

function washOrder(item: WashOrder): ServiceOrder {
  const rawCategory = item.vehicleCategory || item.vehicle?.washVehicleCategory;
  const categoryLabel = rawCategory === "mpv" ? "MPV" : rawCategory === "suv" || rawCategory === "suv_mpv" ? "SUV" : "小轿车";
  return { id: item.id, serviceLabel: "洗车", status: washStatusLabel(item.status), number: item.orderNumber || item.id, name: `${item.vehicle?.plateNumber || "已选车辆"} · ${item.package?.name || item.offer?.name || "洗车服务"} · ${categoryLabel}价类 · ${item.serviceMode === "valet" ? "代驾取送" : "自驾到店"}`, storeName: item.store?.name || "洗车门店", appointment: `${item.appointmentDate} ${item.startTime}`, priceFen: item.totalFeeFen || item.serviceFeeFen, showPrice: true, priceText: "", createdAt: item.createdAt, detailUrl: `/packages/wash/pages/wash-order-detail/wash-order-detail?id=${item.id}` };
}

function compactTime(value: string): string {
  return value ? value.replace("T", " ").replace(/\.\d{3}Z$/, "").replace(/Z$/, "").slice(0, 16) : "时间待同步";
}

function repairOrder(item: RepairRequestSummary): ServiceOrder {
  const status = item.status === "paid" ? "已支付 · 已成交" : item.status === "cancelled" ? "已取消" : item.quoteCount > 0 ? `已收到 ${item.quoteCount} 份报价` : "等待报价";
  const detailPage = item.status === "paid" ? "owner-receipt" : item.status === "open" && item.quoteCount > 0 ? "owner-quotes" : "owner-request-detail";
  return {
    id: item.id,
    serviceLabel: "维修",
    status,
    number: item.requestNo,
    name: `${item.vehicle.plateNumber || "已选车辆"} · 维修询价`,
    storeName: item.status === "paid" ? "已冻结所选门店与报价快照" : item.quoteCount > 0 ? "演示门店报价可比较" : "需求已进入接单大厅",
    appointment: `发起于 ${compactTime(item.createdAt)}`,
    priceFen: item.lowestPriceFen || 0,
    showPrice: item.lowestPriceFen !== null,
    priceText: item.status === "cancelled" ? "已取消" : "等待报价",
    createdAt: item.createdAt,
    detailUrl: `/packages/repair/pages/${detailPage}/${detailPage}?id=${encodeURIComponent(item.id)}`,
  };
}

Page<Data>({
  data: { orders: [], loading: true, unreadCount: 0 },
  onShow() { void this.load(); void this.loadWorkflowSummary(); },
  async loadWorkflowSummary() {
    const summary = await refreshOwnerWorkflowUnreadBadge();
    if (summary) this.setData({ unreadCount: summary.unreadCount });
  },
  openMessages() { wx.navigateTo({ url: "/packages/notifications/pages/messages/messages" }); },
  async load() {
    this.setData({ loading: true });
    try {
      const [bookings, washOrders, repairRequests] = await Promise.all([
        api.bookings(),
        api.washOrders().catch(() => [] as WashOrder[]),
        api.repairRequests().catch(() => [] as RepairRequestSummary[]),
      ]);
      const orders = [...bookings.map(inspectionOrder), ...washOrders.map(washOrder), ...repairRequests.map(repairOrder)].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      this.setData({ orders });
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "读取订单失败", icon: "none" }); }
    finally { this.setData({ loading: false }); }
  },
  open(event) { wx.navigateTo({ url: String(event.currentTarget.dataset.url || "") }); },
  book() { wx.navigateTo({ url: "/packages/annual/pages/service-mode/service-mode" }); },
  wash() { wx.navigateTo({ url: "/packages/wash/pages/wash-booking/wash-booking" }); },
});
