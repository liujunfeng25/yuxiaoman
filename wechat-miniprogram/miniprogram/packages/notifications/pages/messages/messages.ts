import {
  applyOwnerWorkflowUnreadBadge,
  ownerWorkflowApi,
  requestOwnerWorkflowSubscriptions,
} from "../../../../services/workflow";
import type { WorkflowNotificationSummary } from "../../../../types/workflow";
import {
  resolveWorkflowActionTarget,
  workflowNotificationView,
  type WorkflowNotificationView,
} from "../../../../utils/workflow";

type MessageFilter = "all" | "unread";

type Data = {
  filter: MessageFilter;
  items: WorkflowNotificationView[];
  summary: WorkflowNotificationSummary;
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  markingAll: boolean;
  activeMessageId: string;
  error: string;
  inlineError: string;
  loadMoreError: string;
  nextCursor: string;
  hasMore: boolean;
  isEmpty: boolean;
  wechatTemplateIds: string[];
  wechatTemplateOffset: number;
  wechatSubscriptionAvailable: boolean;
  wechatSubscribing: boolean;
  wechatSubscriptionStatus: string;
};

function uniqueMessages(items: WorkflowNotificationView[]): WorkflowNotificationView[] {
  const unique = new Map<string, WorkflowNotificationView>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

Page<Data>({
  requestSequence: 0,

  data: {
    filter: "all",
    items: [],
    summary: { unreadCount: 0, attentionCount: 0, overdueCount: 0 },
    loading: true,
    loadingMore: false,
    loaded: false,
    markingAll: false,
    activeMessageId: "",
    error: "",
    inlineError: "",
    loadMoreError: "",
    nextCursor: "",
    hasMore: false,
    isEmpty: false,
    wechatTemplateIds: [],
    wechatTemplateOffset: 0,
    wechatSubscriptionAvailable: false,
    wechatSubscribing: false,
    wechatSubscriptionStatus: "",
  },

  onLoad(query) {
    this.setData({ filter: query.filter === "unread" ? "unread" : "all" });
    void this.loadMessages(true);
    void this.loadWechatSubscriptionTemplates();
  },

  onPullDownRefresh() {
    void this.loadMessages(true, true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) void this.loadMessages(false);
  },

  onUnload() {
    this.requestSequence += 1;
  },

  async loadWechatSubscriptionTemplates() {
    try {
      const wechatTemplateIds = await ownerWorkflowApi.wechatSubscriptionTemplateIds();
      this.setData({
        wechatTemplateIds,
        wechatTemplateOffset: 0,
        wechatSubscriptionAvailable: wechatTemplateIds.length > 0,
      });
    } catch {
      // Subscription reminders are supplementary. Hide the control when the
      // server has no currently usable owner template or is unavailable.
      this.setData({
        wechatTemplateIds: [],
        wechatTemplateOffset: 0,
        wechatSubscriptionAvailable: false,
      });
    }
  },

  enableWechatReminders() {
    if (!this.data.wechatSubscriptionAvailable || this.data.wechatSubscribing) return;
    const templateIds = this.data.wechatTemplateIds;
    const offset = this.data.wechatTemplateOffset % templateIds.length;
    const orderedIds = [...templateIds.slice(offset), ...templateIds.slice(0, offset)];
    // Start the platform request synchronously from this bindtap handler. Do
    // not add a network request or await before this call.
    const request = requestOwnerWorkflowSubscriptions(orderedIds, "message_center");
    this.setData({ wechatSubscribing: true, wechatSubscriptionStatus: "" });
    void request.then((result) => {
      const nextOffset = (offset + result.requestedTemplateIds.length) % templateIds.length;
      const status = result.acceptedCount > 0
        ? `已开启 ${result.acceptedCount} 类微信提醒`
        : "本次未开启微信提醒，可稍后重试";
      this.setData({ wechatTemplateOffset: nextOffset, wechatSubscriptionStatus: status });
      wx.showToast({ title: status, icon: result.acceptedCount > 0 ? "success" : "none" });
    }).catch((error) => {
      const status = error instanceof Error ? error.message : "微信提醒授权未完成";
      this.setData({ wechatSubscriptionStatus: status });
      wx.showToast({ title: status, icon: "none" });
    }).finally(() => {
      this.setData({ wechatSubscribing: false });
    });
  },

  async loadMessages(reset = true, fromPullDown = false) {
    const sequence = ++this.requestSequence;
    const previous = reset ? [] : this.data.items;
    const hasContent = this.data.items.length > 0;
    this.setData(reset
      ? { loading: true, loaded: hasContent, error: "", inlineError: "", loadMoreError: "", isEmpty: false }
      : { loadingMore: true, loadMoreError: "" });
    try {
      const page = await ownerWorkflowApi.notifications({
        cursor: reset ? undefined : this.data.nextCursor || undefined,
        limit: 20,
        unreadOnly: this.data.filter === "unread",
      });
      if (sequence !== this.requestSequence) return;
      const incoming = page.items.map((item) => workflowNotificationView(item));
      const items = uniqueMessages(reset ? incoming : [...previous, ...incoming]);
      const summary = {
        unreadCount: page.unreadCount,
        attentionCount: page.attentionCount,
        overdueCount: page.overdueCount,
      };
      this.setData({
        items,
        summary,
        nextCursor: page.nextCursor || "",
        hasMore: Boolean(page.nextCursor),
        loaded: true,
        isEmpty: items.length === 0,
      });
      applyOwnerWorkflowUnreadBadge(summary.unreadCount);
    } catch (error) {
      if (sequence !== this.requestSequence) return;
      const message = error instanceof Error ? error.message : "消息暂时无法读取";
      if (!hasContent && reset) this.setData({ error: message, loaded: true });
      else if (reset) this.setData({ inlineError: message });
      else this.setData({ loadMoreError: message });
    } finally {
      if (sequence === this.requestSequence) this.setData({ loading: false, loadingMore: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  selectFilter(event) {
    if (this.data.loading || this.data.loadingMore) return;
    const filter = event.currentTarget.dataset.filter === "unread" ? "unread" : "all";
    if (filter === this.data.filter) return;
    this.requestSequence += 1;
    this.setData({
      filter,
      items: [],
      nextCursor: "",
      hasMore: false,
      isEmpty: false,
      error: "",
      inlineError: "",
      loadMoreError: "",
      loaded: false,
    });
    void this.loadMessages(true);
  },

  openMessage(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const item = this.data.items.find((candidate) => candidate.id === id);
    if (!item || this.data.activeMessageId) return;
    const target = resolveWorkflowActionTarget(item.actionCode, item.actionParams, "owner");
    if (item.readState === "unread") {
      const unreadCount = Math.max(0, this.data.summary.unreadCount - 1);
      const items = this.data.filter === "unread"
        ? this.data.items.filter((candidate) => candidate.id !== id)
        : this.data.items.map((candidate) => candidate.id === id
          ? workflowNotificationView({ ...candidate, readState: "read", readAt: new Date().toISOString() })
          : candidate);
      this.setData({
        activeMessageId: id,
        items,
        summary: { ...this.data.summary, unreadCount },
        isEmpty: items.length === 0,
      });
      applyOwnerWorkflowUnreadBadge(unreadCount);
      void ownerWorkflowApi.markRead(id).catch(() => {
        // Reading the business detail is more important than the supplementary
        // read receipt. A later refresh reconciles the authoritative state.
      }).finally(() => {
        this.setData({ activeMessageId: "" });
      });
    }
    if (target) {
      wx.navigateTo({ url: target });
      return;
    }
    wx.showToast({ title: "这是一条状态通知，无需额外操作", icon: "none" });
  },

  async markAllRead() {
    if (!this.data.summary.unreadCount || this.data.markingAll) return;
    this.setData({ markingAll: true });
    try {
      const summary = await ownerWorkflowApi.markAllRead();
      const items = this.data.filter === "unread"
        ? []
        : this.data.items.map((item) => workflowNotificationView({ ...item, readState: "read", readAt: item.readAt || new Date().toISOString() }));
      this.setData({
        items,
        summary: { ...summary, unreadCount: 0 },
        isEmpty: items.length === 0,
        nextCursor: this.data.filter === "unread" ? "" : this.data.nextCursor,
        hasMore: this.data.filter === "unread" ? false : this.data.hasMore,
      });
      applyOwnerWorkflowUnreadBadge(0);
      wx.showToast({ title: "已全部标为已读", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "操作失败，请重试", icon: "none" });
    } finally {
      this.setData({ markingAll: false });
    }
  },

  retry() {
    if (!this.data.loading && !this.data.loadingMore) void this.loadMessages(true);
  },

  loadMore() {
    if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) void this.loadMessages(false);
  },
});
