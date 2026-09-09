import { storeRole } from "../../../../services/storage";
import { repairWorkflowApi } from "../../services/workflow-api";
import type { AppRole } from "../../../../types";
import type { WorkflowTaskSummary } from "../../../../types/workflow";
import { workflowDueLabel } from "../../../../utils/workflow";
import { repairOperatorApi } from "../../services/operator-api";
import {
  ensureRepairOperatorPageAccess,
  isDemoRepairOperatorSubject,
  logoutRepairOperator,
  readRepairOperatorSession,
} from "../../services/operator-session";
import {
  filterShopRequests,
  normalizeRepairShopHall,
  shopRequestView,
  type RepairShopFilter,
  type RepairShopHallDto,
  type RepairShopRequestView,
} from "../../utils/shop-model";

const filterOptions: Array<{ key: RepairShopFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待报价" },
  { key: "quoted", label: "已报价" },
  { key: "won", label: "已成交" },
];

type Data = {
  shopName: string;
  accountName: string;
  isDemoShop: boolean;
  stats: RepairShopHallDto["stats"];
  allRequests: RepairShopRequestView[];
  visibleRequests: RepairShopRequestView[];
  filterOptions: typeof filterOptions;
  filter: RepairShopFilter;
  loading: boolean;
  loggingOut: boolean;
  error: string;
  workflowSummary: WorkflowTaskSummary;
  workflowNextDueLabel: string;
  workflowLoading: boolean;
};

Page<Data>({
  data: {
    shopName: "维修门店",
    accountName: "",
    isDemoShop: false,
    stats: { pending: 0, quoted: 0, won: 0 },
    allRequests: [],
    visibleRequests: [],
    filterOptions,
    filter: "all",
    loading: true,
    loggingOut: false,
    error: "",
    workflowSummary: { openCount: 0, dueSoonCount: 0, overdueCount: 0, nextDueAt: null },
    workflowNextDueLabel: "",
    workflowLoading: false,
  },

  onLoad() {
    if (!ensureRepairOperatorPageAccess("/packages/repair/pages/shop-hall/shop-hall")) return;
    const session = readRepairOperatorSession();
    if (!session) return;
    storeRole("repair_shop");
    getApp<{ role: AppRole }>().globalData.role = "repair_shop";
    this.setData({
      shopName: session.subject.name,
      accountName: session.account.displayName,
      isDemoShop: isDemoRepairOperatorSubject(session.subject),
    });
  },

  onShow() {
    if (!ensureRepairOperatorPageAccess("/packages/repair/pages/shop-hall/shop-hall")) return;
    void this.load();
    void this.loadWorkflowSummary();
  },

  onPullDownRefresh() { void this.load(); void this.loadWorkflowSummary(); },

  async loadWorkflowSummary() {
    this.setData({ workflowLoading: true });
    try {
      const summary = await repairWorkflowApi.summary();
      const urgency = summary.overdueCount > 0 ? "overdue" : summary.dueSoonCount > 0 ? "attention" : "normal";
      this.setData({ workflowSummary: summary, workflowNextDueLabel: workflowDueLabel(summary.nextDueAt, urgency) });
    } catch {
      // 督办摘要失败不影响门店继续报价。
    } finally {
      this.setData({ workflowLoading: false });
    }
  },

  openWorkflowTasks() {
    wx.navigateTo({ url: "/packages/repair/pages/shop-workflow-tasks/shop-workflow-tasks" });
  },
  openFinance() {
    wx.navigateTo({ url: "/packages/repair/pages/shop-finance/shop-finance" });
  },

  async load() {
    const sequence = (this.loadSequence || 0) + 1;
    this.loadSequence = sequence;
    this.setData({ loading: true, error: "" });
    try {
      const hall = normalizeRepairShopHall(await repairOperatorApi.repairShopHall());
      if (sequence !== this.loadSequence) return;
      const allRequests = hall.requests.map(shopRequestView);
      this.setData({
        stats: hall.stats,
        allRequests,
        visibleRequests: filterShopRequests(allRequests, this.data.filter),
      });
    } catch (error) {
      if (sequence !== this.loadSequence) return;
      this.setData({ error: error instanceof Error ? error.message : "读取接单大厅失败" });
    } finally {
      if (sequence === this.loadSequence) this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },

  chooseFilter(event) {
    const filter = event.currentTarget.dataset.filter as RepairShopFilter;
    this.setData({ filter, visibleRequests: filterShopRequests(this.data.allRequests, filter) });
  },

  openRequest(event) {
    const requestId = event.currentTarget.dataset.id as string;
    wx.navigateTo({
      url: `/packages/repair/pages/shop-request-detail/shop-request-detail?id=${encodeURIComponent(requestId)}`,
    });
  },

  quickAction(event) {
    const requestId = event.currentTarget.dataset.id as string;
    const status = event.currentTarget.dataset.status as RepairShopRequestView["status"];
    const page = status === "won" ? "shop-deal" : status === "pending_quote" || status === "quoted" ? "shop-quote" : "shop-request-detail";
    wx.navigateTo({
      url: `/packages/repair/pages/${page}/${page}?id=${encodeURIComponent(requestId)}`,
    });
  },

  async logout() {
    if (this.data.loggingOut) return;
    this.setData({ loggingOut: true });
    await logoutRepairOperator().catch(() => undefined);
    storeRole("consumer");
    getApp<{ role: AppRole }>().globalData.role = "consumer";
    wx.redirectTo({ url: "/packages/repair/pages/shop-login/shop-login" });
  },

  retry() { void this.load(); },
});
