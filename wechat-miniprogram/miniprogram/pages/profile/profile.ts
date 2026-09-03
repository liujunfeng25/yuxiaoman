import { api } from "../../services/api";
import { operatorLoginRequired } from "../../services/operator-session";
import { getStoredRole, storeRole } from "../../services/storage";
import type { AppRole, RepairRequestSummary, Vehicle, WashOrder } from "../../types";

type Data = {
  role: AppRole;
  loading: boolean;
  vehicle: Vehicle | null;
  vehicleCount: number;
  inspectionCount: number;
  washCount: number;
  repairCount: number;
};

Page<Data>({
  data: { role: getStoredRole(), loading: true, vehicle: null, vehicleCount: 0, inspectionCount: 0, washCount: 0, repairCount: 0 },
  onShow() { void this.load(); },
  async load() {
    this.setData({ loading: true, role: getStoredRole() });
    try {
      const [vehicles, bookings, washOrders, repairRequests] = await Promise.all([
        api.vehicles(),
        api.bookings(),
        api.washOrders().catch(() => [] as WashOrder[]),
        api.repairRequests().catch(() => [] as RepairRequestSummary[]),
      ]);
      this.setData({
        vehicle: vehicles.find((item) => item.isDefault) || vehicles[0] || null,
        vehicleCount: vehicles.length,
        inspectionCount: bookings.length,
        washCount: washOrders.length,
        repairCount: repairRequests.length,
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "读取数据失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  go(event) {
    const url = String(event.currentTarget.dataset.url || "");
    if (url === "/pages/orders/orders") wx.switchTab({ url });
    else if (url) wx.navigateTo({ url });
  },
  enterStaff() {
    wx.navigateTo({ url: "/packages/operator/pages/staff-entry/staff-entry" });
  },
  enterOperator() {
    const loginRequired = operatorLoginRequired();
    if (!loginRequired) {
      storeRole("operator");
      getApp<{ role: AppRole }>().globalData.role = "operator";
      this.setData({ role: "operator" });
    }
    wx.navigateTo({ url: loginRequired ? "/packages/operator/pages/operator-login/operator-login" : "/packages/operator/pages/operator/operator" });
  },
  useConsumerRole() {
    storeRole("consumer");
    getApp<{ role: AppRole }>().globalData.role = "consumer";
    this.setData({ role: "consumer" });
    wx.showToast({ title: "已切换车主演示", icon: "success" });
  },
  resetDemo() {
    wx.showModal({
      title: "重置演示数据",
      content: "将清空预约并恢复演示车辆、站点和检测任务。",
      confirmText: "确认重置",
      confirmColor: "#d84646",
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          await api.resetDemo();
          wx.showToast({ title: "已重置", icon: "success" });
          void this.load();
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "重置失败", icon: "none" });
        }
      },
    });
  },
});
