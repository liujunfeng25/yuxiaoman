import { api } from "../../../../services/api";
import { operatorWorkflowApi } from "../../services/workflow-api";
import { ensureOperatorPageAccess, readOperatorSession } from "../../../../services/operator-session";
import { getOperatorFilter, storeOperatorFilter } from "../../../../services/storage";
import type { Booking, Station, Workbench } from "../../../../types";
import { today } from "../../../../utils/format";
import { workflowDueLabel } from "../../../../utils/workflow";
import type { WorkflowTaskSummary } from "../../../../types/workflow";

type BookingView = Booking & {
  plateNumber: string;
  timeLabel: string;
  dateLabel: string;
  contactLabel: string;
  vehicleTypeLabel: string;
  statusHint: string;
};

type PressureView = Workbench["pressure"][number] & { levelLabel: string };

type Data = {
  workbench: Workbench | null;
  stations: Station[];
  stationIndex: number;
  stationName: string;
  date: string;
  filter: string;
  filters: string[];
  visibleBookings: BookingView[];
  primaryPressure: PressureView | null;
  loading: boolean;
  loadError: string;
  accessReady: boolean;
  stationLocked: boolean;
  workflowSummary: WorkflowTaskSummary;
  workflowNextDueLabel: string;
  workflowLoading: boolean;
};

const filters = ["all", "confirmed", "awaiting_arrival", "checked_in", "inspecting", "result_received", "on_hold", "completed"];

function maskPhone(phone: string): string {
  if (!phone) return "联系方式待补充";
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function dateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[2]}-${match[3]}` : date;
}

function statusHint(status: Booking["status"]): string {
  if (["confirmed", "driver_arranged", "picked_up", "awaiting_arrival"].includes(status)) return "下一任务";
  if (status === "checked_in") return "待叫号";
  if (status === "inspecting") return "外检环节";
  if (status === "result_received") return "结果已回传";
  if (status === "returning") return "车辆送回中";
  if (status === "completed") return "服务已完成";
  if (status === "on_hold") return "异常处理中";
  if (status === "no_show") return "未到站";
  return "查看详情";
}

function bookingView(item: Booking): BookingView {
  return {
    ...item,
    plateNumber: item.vehicle?.plateNumber || "车牌待确认",
    timeLabel: `${item.startTime}–${item.endTime}`,
    dateLabel: dateLabel(item.appointmentDate),
    contactLabel: `${item.contactName}　${maskPhone(item.contactPhone)}`,
    vehicleTypeLabel: `${item.vehicle?.vehicleType || "车辆类型待确认"} · ${item.vehicle?.usageNature || "使用性质待确认"}`,
    statusHint: statusHint(item.status),
  };
}

function filteredBookings(bookings: Booking[], filter: string): BookingView[] {
  const source = filter === "all" ? bookings : bookings.filter((item) => item.status === filter);
  return [...source].sort((left, right) => left.startTime.localeCompare(right.startTime)).map(bookingView);
}

function pressureView(workbench: Workbench): PressureView | null {
  const pressure = workbench.pressure.find((item) => item.level === "high") || workbench.pressure[0];
  if (!pressure) return null;
  return {
    ...pressure,
    levelLabel: pressure.level === "high" ? "较高" : pressure.level === "medium" ? "适中" : "宽松",
  };
}

Page<Data>({
  data: {
    workbench: null,
    stations: [],
    stationIndex: 0,
    stationName: "检测站工作台",
    date: today(),
    filter: getOperatorFilter(),
    filters,
    visibleBookings: [],
    primaryPressure: null,
    loading: true,
    loadError: "",
    accessReady: false,
    stationLocked: false,
    workflowSummary: { openCount: 0, dueSoonCount: 0, overdueCount: 0, nextDueAt: null },
    workflowNextDueLabel: "",
    workflowLoading: false,
  },
  onLoad() {
    const accessReady = ensureOperatorPageAccess("/packages/operator/pages/operator/operator");
    this.setData({ accessReady, stationLocked: Boolean(readOperatorSession()?.subject) });
  },
  onShow() { if (this.data.accessReady) { void this.load(); void this.loadWorkflowSummary(); } },
  onPullDownRefresh() {
    if (this.data.accessReady) { void this.load(); void this.loadWorkflowSummary(); }
    else wx.stopPullDownRefresh();
  },
  async loadWorkflowSummary() {
    this.setData({ workflowLoading: true });
    try {
      const summary = await operatorWorkflowApi.summary();
      const urgency = summary.overdueCount > 0 ? "overdue" : summary.dueSoonCount > 0 ? "attention" : "normal";
      this.setData({ workflowSummary: summary, workflowNextDueLabel: workflowDueLabel(summary.nextDueAt, urgency) });
    } catch {
      // 督办摘要是辅助信息，不阻塞检测站原有履约工作台。
    } finally {
      this.setData({ workflowLoading: false });
    }
  },
  openWorkflowTasks() {
    wx.navigateTo({ url: "/packages/operator/pages/workflow-tasks/workflow-tasks" });
  },
  async load() {
    this.setData({ loading: true, loadError: "" });
    try {
      const session = readOperatorSession();
      const stationLocked = Boolean(session?.subject);
      let stations = stationLocked ? [] : this.data.stations.length ? this.data.stations : await api.stations({});
      const requestedIndex = Math.max(0, Math.min(this.data.stationIndex, stations.length - 1));
      const requestedStationId = stationLocked ? undefined : this.data.stations.length ? stations[requestedIndex]?.id : undefined;
      const workbench = await api.operatorWorkbench(requestedStationId, this.data.date);
      if (!stations.some((item) => item.id === workbench.station.id)) stations = [workbench.station, ...stations];
      const stationIndex = Math.max(0, stations.findIndex((item) => item.id === workbench.station.id));
      this.setData({
        stations,
        stationIndex,
        stationName: workbench.station.name.replace("（演示）", ""),
        workbench,
        primaryPressure: pressureView(workbench),
        visibleBookings: filteredBookings(workbench.bookings, this.data.filter),
        stationLocked,
        loadError: "",
      });
    } catch (error) {
      if (!ensureOperatorPageAccess("/packages/operator/pages/operator/operator")) return;
      const message = error instanceof Error ? error.message : "读取工作台失败";
      this.setData({ loadError: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },
  retryLoad() {
    if (!this.data.loading && this.data.accessReady) void this.load();
  },
  stationChange(event) {
    if (this.data.stationLocked) return;
    this.setData({ stationIndex: Number(event.detail.value) });
    void this.load();
  },
  dateChange(event) {
    this.setData({ date: event.detail.value });
    void this.load();
  },
  filter(event) {
    const filter = event.currentTarget.dataset.filter as string;
    storeOperatorFilter(filter);
    this.setData({ filter, visibleBookings: filteredBookings(this.data.workbench?.bookings || [], filter) });
  },
  open(event) {
    wx.navigateTo({ url: `/packages/operator/pages/operator-detail/operator-detail?id=${event.currentTarget.dataset.id as string}` });
  },
  stationSettings() {
    const station = this.data.stations[this.data.stationIndex];
    if (station) wx.navigateTo({ url: `/packages/operator/pages/operator-station/operator-station?id=${station.id}` });
  },
  openPrechecks() {
    wx.navigateTo({ url: "/packages/operator/pages/precheck-list/precheck-list" });
  },
  backHome() { wx.switchTab({ url: "/pages/home/home" }); },
});
