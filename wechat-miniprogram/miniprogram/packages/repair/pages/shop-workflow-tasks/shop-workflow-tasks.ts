import type { WorkflowTaskSummary } from "../../../../types/workflow";
import { resolveWorkflowActionTarget, workflowTaskView, type WorkflowTaskView } from "../../../../utils/workflow";
import { ensureRepairOperatorPageAccess } from "../../services/operator-session";
import { repairWorkflowApi } from "../../services/workflow-api";

type Data = {
  items: WorkflowTaskView[];
  summary: WorkflowTaskSummary;
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  error: string;
  loadMoreError: string;
  nextCursor: string;
  hasMore: boolean;
  isEmpty: boolean;
  accessReady: boolean;
};

function mergeTasks(items: WorkflowTaskView[]): WorkflowTaskView[] {
  const unique = new Map<string, WorkflowTaskView>();
  for (const item of items) unique.set(item.id, item);
  const rank = { overdue: 0, attention: 1, normal: 2 } as const;
  return [...unique.values()].sort((left, right) => rank[left.urgency] - rank[right.urgency]
    || String(left.dueAt || "9999").localeCompare(String(right.dueAt || "9999")));
}

Page<Data>({
  requestSequence: 0,
  data: {
    items: [],
    summary: { openCount: 0, dueSoonCount: 0, overdueCount: 0, nextDueAt: null },
    loading: true,
    loadingMore: false,
    loaded: false,
    error: "",
    loadMoreError: "",
    nextCursor: "",
    hasMore: false,
    isEmpty: false,
    accessReady: false,
  },
  onLoad() {
    const accessReady = ensureRepairOperatorPageAccess("/packages/repair/pages/shop-workflow-tasks/shop-workflow-tasks");
    this.setData({ accessReady });
    if (accessReady) void this.loadTasks(true);
  },
  onPullDownRefresh() {
    if (this.data.accessReady) void this.loadTasks(true, true); else wx.stopPullDownRefresh();
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) void this.loadTasks(false);
  },
  onUnload() { this.requestSequence += 1; },
  async loadTasks(reset = true, fromPullDown = false) {
    const sequence = ++this.requestSequence;
    const previous = reset ? [] : this.data.items;
    const hasContent = this.data.items.length > 0;
    this.setData(reset ? { loading: true, loaded: hasContent, error: "", loadMoreError: "", isEmpty: false } : { loadingMore: true, loadMoreError: "" });
    try {
      const page = await repairWorkflowApi.tasks({ cursor: reset ? undefined : this.data.nextCursor || undefined, limit: 100 });
      if (sequence !== this.requestSequence) return;
      const incoming = page.items.map((item) => workflowTaskView(item, "repair_shop"));
      const items = mergeTasks(reset ? incoming : [...previous, ...incoming]);
      this.setData({
        items,
        summary: { openCount: page.openCount, dueSoonCount: page.dueSoonCount, overdueCount: page.overdueCount, nextDueAt: page.nextDueAt },
        loaded: true,
        nextCursor: page.nextCursor || "",
        hasMore: Boolean(page.nextCursor),
        isEmpty: items.length === 0,
      });
    } catch (error) {
      if (sequence !== this.requestSequence) return;
      const message = error instanceof Error ? error.message : "维修报价待办暂时无法读取";
      if (!hasContent && reset) this.setData({ error: message, loaded: true }); else this.setData({ loadMoreError: message });
    } finally {
      if (sequence === this.requestSequence) this.setData({ loading: false, loadingMore: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },
  openTask(event) {
    const item = this.data.items.find((candidate) => candidate.id === String(event.currentTarget.dataset.id || ""));
    if (!item) return;
    const target = resolveWorkflowActionTarget(item.actionCode, item.actionParams, "repair_shop");
    if (target) wx.navigateTo({ url: target }); else wx.showToast({ title: "该待办无需页面操作", icon: "none" });
  },
  retry() { if (!this.data.loading && !this.data.loadingMore) void this.loadTasks(true); },
  loadMore() { if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) void this.loadTasks(false); },
});
