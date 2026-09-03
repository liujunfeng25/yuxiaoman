import { api } from "../../../../services/api";
import type { VehicleCheckupReportListPage } from "../../../../types";
import {
  progressCard,
  reportCard,
  vehicleFilters,
  vehicleSource,
} from "./checkup-reports.model";
import type {
  ProgressCardView,
  ReportCardView,
  VehicleFilterSource,
  VehicleFilterView,
} from "./checkup-reports.model";

type Data = {
  activeVehicleId: string;
  vehicleFilters: VehicleFilterView[];
  progressCards: ProgressCardView[];
  reportCards: ReportCardView[];
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  fatalError: string;
  inlineError: string;
  loadMoreError: string;
  nextCursor: string;
  hasMore: boolean;
  isEmpty: boolean;
};

function uniqueReports(items: ReportCardView[]): ReportCardView[] {
  const result = new Map<string, ReportCardView>();
  for (const item of items) result.set(item.reportId, item);
  return [...result.values()].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || right.reportId.localeCompare(left.reportId));
}

Page<Data>({
  requestSequence: 0,
  vehicleSources: [] as VehicleFilterSource[],

  data: {
    activeVehicleId: "",
    vehicleFilters: vehicleFilters([], ""),
    progressCards: [],
    reportCards: [],
    loading: true,
    loadingMore: false,
    loaded: false,
    fatalError: "",
    inlineError: "",
    loadMoreError: "",
    nextCursor: "",
    hasMore: false,
    isEmpty: false,
  },

  onLoad() {
    void this.loadVehicles();
    void this.loadReports(true);
  },

  onPullDownRefresh() {
    void this.loadReports(true, true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) void this.loadReports(false);
  },

  onUnload() {
    this.requestSequence += 1;
  },

  async loadVehicles() {
    try {
      const vehicles = await api.vehicles();
      this.rememberVehicles(vehicles.map(vehicleSource));
    } catch {
      // 报告与履约快照中仍含车辆信息，筛选会使用列表返回的稳定快照。
    }
  },

  rememberVehicles(sources: VehicleFilterSource[]) {
    const map = new Map<string, VehicleFilterSource>((this.vehicleSources as VehicleFilterSource[]).map((item) => [item.id, item]));
    for (const source of sources) if (source.id) map.set(source.id, source);
    this.vehicleSources = [...map.values()];
    this.setData({ vehicleFilters: vehicleFilters(this.vehicleSources, this.data.activeVehicleId) });
  },

  rememberPageVehicles(page: VehicleCheckupReportListPage) {
    this.rememberVehicles([
      ...page.progress.map((item) => vehicleSource(item.vehicle)),
      ...page.items.map((item) => vehicleSource(item.vehicle)),
    ]);
  },

  async loadReports(reset = true, fromPullDown = false) {
    const requestSequence = ++this.requestSequence;
    const previousReports = reset ? [] : this.data.reportCards;
    const hasExistingContent = this.data.progressCards.length > 0 || this.data.reportCards.length > 0;
    this.setData(reset
      ? { loading: true, loaded: hasExistingContent, isEmpty: false, fatalError: "", inlineError: "", loadMoreError: "" }
      : { loadingMore: true, loadMoreError: "" });
    try {
      const page = await api.vehicleCheckupReports({
        vehicleId: this.data.activeVehicleId || undefined,
        limit: 10,
        cursor: reset ? undefined : this.data.nextCursor || undefined,
      });
      if (requestSequence !== this.requestSequence) return;
      this.rememberPageVehicles(page);
      const nextReports = page.items.map(reportCard);
      const reportCards = uniqueReports(reset ? nextReports : [...previousReports, ...nextReports]);
      const progressCards = page.progress.map(progressCard);
      this.setData({
        progressCards,
        reportCards,
        nextCursor: page.nextCursor || "",
        hasMore: Boolean(page.nextCursor),
        loaded: true,
        isEmpty: progressCards.length === 0 && reportCards.length === 0,
      });
    } catch (error) {
      if (requestSequence !== this.requestSequence) return;
      const message = error instanceof Error ? error.message : "检测报告暂时无法读取";
      if (reset && !hasExistingContent) this.setData({ fatalError: message, loaded: true, isEmpty: false });
      else if (reset) this.setData({ inlineError: message });
      else this.setData({ loadMoreError: message });
    } finally {
      if (requestSequence === this.requestSequence) this.setData({ loading: false, loadingMore: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  selectVehicle(event) {
    if (this.data.loading || this.data.loadingMore) return;
    const vehicleId = String(event.currentTarget.dataset.id || "");
    if (vehicleId === this.data.activeVehicleId) return;
    this.requestSequence += 1;
    this.setData({
      activeVehicleId: vehicleId,
      vehicleFilters: vehicleFilters(this.vehicleSources, vehicleId),
      progressCards: [],
      reportCards: [],
      nextCursor: "",
      hasMore: false,
      isEmpty: false,
      fatalError: "",
      inlineError: "",
      loadMoreError: "",
      loaded: false,
    });
    void this.loadReports(true);
  },

  openReport(event) {
    const bookingId = String(event.currentTarget.dataset.id || "");
    if (bookingId) wx.navigateTo({ url: `/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(bookingId)}` });
  },

  openOrder(event) {
    const bookingId = String(event.currentTarget.dataset.id || "");
    if (bookingId) wx.navigateTo({ url: `/packages/annual/pages/order-detail/order-detail?id=${encodeURIComponent(bookingId)}` });
  },

  retry() {
    if (this.data.loading || this.data.loadingMore) return;
    void this.loadReports(true);
  },

  retryLoadMore() {
    if (this.data.loading || this.data.loadingMore) return;
    void this.loadReports(false);
  },
});
