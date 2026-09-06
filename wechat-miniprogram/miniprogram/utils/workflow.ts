import type {
  WorkflowActionCode,
  WorkflowActionParams,
  WorkflowNotification,
  WorkflowNotificationCategory,
  WorkflowNotificationPage,
  WorkflowNotificationSummary,
  WorkflowNotificationUrgency,
  WorkflowTask,
  WorkflowTaskPage,
  WorkflowTaskSummary,
  WorkflowTaskUrgency,
} from "../types/workflow";

type UnknownRecord = Record<string, unknown>;

export type WorkflowViewer = "owner" | "operator" | "repair_shop" | "driver";

export type WorkflowNotificationView = WorkflowNotification & {
  categoryLabel: string;
  urgencyLabel: string;
  timeLabel: string;
  dueLabel: string;
  actionLabel: string;
  actionable: boolean;
  className: string;
  iconPath: string;
  ariaLabel: string;
};

export type WorkflowTaskView = WorkflowTask & {
  urgencyLabel: string;
  dueLabel: string;
  actionLabel: string;
  actionable: boolean;
  className: string;
  ariaLabel: string;
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringValue(...values: unknown[]): string {
  const match = values.find((value) => typeof value === "string" && value.trim());
  return typeof match === "string" ? match.trim() : "";
}

function optionalString(...values: unknown[]): string | null {
  return stringValue(...values) || null;
}

function nonNegativeInteger(...values: unknown[]): number {
  const match = values.map(Number).find((value) => Number.isFinite(value));
  return Math.max(0, Math.floor(match ?? 0));
}

function category(value: unknown): WorkflowNotificationCategory {
  const normalized = stringValue(value).toLowerCase();
  if (["repair", "repair_quote", "maintenance"].includes(normalized) || normalized.startsWith("repair.")) return "repair_quote";
  if (["platform", "system", "exception"].includes(normalized) || normalized.startsWith("workflow.")) return "platform";
  return "annual_inspection";
}

function urgency(value: unknown, dueAt: string | null, now: number): WorkflowNotificationUrgency {
  const normalized = stringValue(value).toLowerCase();
  if (["overdue", "critical", "expired", "escalated"].includes(normalized)) return "overdue";
  if (["attention", "warning", "due_soon", "urgent"].includes(normalized)) return "attention";
  if (dueAt && Number.isFinite(Date.parse(dueAt)) && Date.parse(dueAt) <= now) return "overdue";
  return "normal";
}

function actionParams(value: unknown, source: UnknownRecord): WorkflowActionParams {
  const params = record(value);
  return {
    bookingId: stringValue(params.bookingId, params.booking_id, source.bookingId, source.booking_id) || undefined,
    reportId: stringValue(params.reportId, params.report_id, source.reportId, source.report_id) || undefined,
    repairRequestId: stringValue(params.repairRequestId, params.repair_request_id, source.repairRequestId, source.repair_request_id) || undefined,
    requestId: stringValue(params.requestId, params.request_id, source.requestId, source.request_id) || undefined,
    taskId: stringValue(params.taskId, params.task_id, source.taskId, source.task_id) || undefined,
    resourceId: stringValue(
      params.resourceId,
      params.resource_id,
      params.entityId,
      params.entity_id,
      params.businessId,
      params.business_id,
      source.resourceId,
      source.resource_id,
      source.entityId,
      source.entity_id,
      source.businessId,
      source.business_id,
    ) || undefined,
  };
}

function normalizedActionCode(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/[\s_-]+/gu, ".")
    .replace(/\.+/gu, ".")
    .replace(/^\.|\.$/gu, "");
}

const ACTION_ALIASES: Record<string, WorkflowActionCode> = {
  none: "none",
  "annual.order": "annual.order.detail",
  "annual.order.detail": "annual.order.detail",
  "open.annual.order": "annual.order.detail",
  "annual.booking.detail": "annual.order.detail",
  "annual.report": "annual.report.detail",
  "annual.report.detail": "annual.report.detail",
  "open.annual.report": "annual.report.detail",
  "repair.request": "repair.request.detail",
  "repair.request.detail": "repair.request.detail",
  "open.repair.request": "repair.request.detail",
  "repair.quotes": "repair.quotes",
  "open.repair.quotes": "repair.quotes",
  "operator.booking": "operator.booking.detail",
  "operator.booking.detail": "operator.booking.detail",
  "operator.precheck": "operator.precheck.detail",
  "operator.precheck.detail": "operator.precheck.detail",
  "repair.shop.request": "repair.shop.request.detail",
  "repair.shop.request.detail": "repair.shop.request.detail",
  "driver.task": "driver.task.detail",
  "driver.task.detail": "driver.task.detail",
};

export function canonicalWorkflowActionCode(value: unknown): WorkflowActionCode | string {
  const normalized = normalizedActionCode(value);
  return ACTION_ALIASES[normalized] || normalized || "none";
}

function actionId(params: WorkflowActionParams, keys: Array<keyof WorkflowActionParams>): string {
  for (const key of keys) {
    const value = String(params[key] || "").trim();
    if (value) return value;
  }
  return "";
}

/**
 * Resolve only application-owned routes. `url`, `path` and similar fields from
 * a server response are deliberately ignored.
 */
export function resolveWorkflowActionTarget(
  actionCode: unknown,
  params: WorkflowActionParams,
  viewer: WorkflowViewer = "owner",
): string | null {
  const code = canonicalWorkflowActionCode(actionCode);
  const allowedByViewer: Record<WorkflowViewer, WorkflowActionCode[]> = {
    owner: ["annual.order.detail", "annual.report.detail", "repair.request.detail", "repair.quotes"],
    operator: ["operator.booking.detail", "operator.precheck.detail"],
    repair_shop: ["repair.shop.request.detail"],
    driver: ["driver.task.detail"],
  };
  if (!allowedByViewer[viewer].includes(code as WorkflowActionCode)) return null;

  if (code === "annual.order.detail") {
    const id = actionId(params, ["bookingId", "resourceId"]);
    return id ? `/packages/annual/pages/order-detail/order-detail?id=${encodeURIComponent(id)}` : null;
  }
  if (code === "annual.report.detail") {
    const id = actionId(params, ["bookingId", "resourceId"]);
    return id ? `/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(id)}` : null;
  }
  if (code === "repair.request.detail") {
    const id = actionId(params, ["repairRequestId", "requestId", "resourceId"]);
    return id ? `/packages/repair/pages/owner-request-detail/owner-request-detail?id=${encodeURIComponent(id)}` : null;
  }
  if (code === "repair.quotes") {
    const id = actionId(params, ["repairRequestId", "requestId", "resourceId"]);
    return id ? `/packages/repair/pages/owner-quotes/owner-quotes?id=${encodeURIComponent(id)}` : null;
  }
  if (code === "operator.booking.detail") {
    const id = actionId(params, ["bookingId", "resourceId"]);
    return id ? `/packages/operator/pages/operator-detail/operator-detail?id=${encodeURIComponent(id)}` : null;
  }
  if (code === "operator.precheck.detail") {
    const id = actionId(params, ["bookingId", "resourceId"]);
    return id ? `/packages/operator/pages/precheck-detail/precheck-detail?id=${encodeURIComponent(id)}` : null;
  }
  if (code === "repair.shop.request.detail") {
    const id = actionId(params, ["repairRequestId", "requestId", "resourceId"]);
    return id ? `/packages/repair/pages/shop-request-detail/shop-request-detail?id=${encodeURIComponent(id)}` : null;
  }
  if (code === "driver.task.detail") {
    const id = actionId(params, ["bookingId", "taskId", "resourceId"]);
    return id ? `/packages/driver/pages/task/task?bookingId=${encodeURIComponent(id)}` : null;
  }
  return null;
}

export function normalizeWorkflowNotification(value: unknown, now = Date.now()): WorkflowNotification {
  const source = record(value);
  const dueAt = optionalString(source.dueAt, source.due_at);
  const readAt = optionalString(source.readAt, source.read_at);
  const rawReadState = stringValue(source.readState, source.read_state, source.status).toLowerCase();
  return {
    id: stringValue(source.id, source.notificationId, source.notification_id),
    templateCode: stringValue(source.templateCode, source.template_code),
    category: category(source.category || source.businessType || source.business_type || source.actionCode || source.action_code),
    urgency: urgency(source.urgency || source.level || source.priority, dueAt, now),
    readState: readAt || rawReadState === "read" ? "read" : "unread",
    title: stringValue(source.title) || "履约进度已更新",
    body: stringValue(source.body, source.content, source.message),
    actionCode: canonicalWorkflowActionCode(source.actionCode || source.action_code),
    actionParams: actionParams(source.actionParams || source.action_params, source),
    businessNoMasked: stringValue(source.businessNoMasked, source.business_no_masked, source.businessNo, source.business_no),
    dueAt,
    createdAt: stringValue(source.createdAt, source.created_at, source.sentAt, source.sent_at),
    readAt,
  };
}

function payloadRecord(value: unknown): UnknownRecord {
  const outer = record(value);
  return Object.keys(record(outer.data)).length ? record(outer.data) : outer;
}

export function normalizeWorkflowNotificationSummary(value: unknown): WorkflowNotificationSummary {
  const source = payloadRecord(value);
  const summary = Object.keys(record(source.summary)).length ? record(source.summary) : source;
  return {
    unreadCount: nonNegativeInteger(summary.unreadCount, summary.unread_count),
    attentionCount: nonNegativeInteger(summary.attentionCount, summary.attention_count, summary.dueSoonCount, summary.due_soon_count),
    overdueCount: nonNegativeInteger(summary.overdueCount, summary.overdue_count),
  };
}

export function normalizeWorkflowNotificationPage(value: unknown, now = Date.now()): WorkflowNotificationPage {
  const source = payloadRecord(value);
  const rawItems = Array.isArray(source.items)
    ? source.items
    : Array.isArray(source.notifications) ? source.notifications : [];
  const items = rawItems
    .map((item) => normalizeWorkflowNotification(item, now))
    .filter((item) => item.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return {
    ...normalizeWorkflowNotificationSummary(source),
    items,
    nextCursor: optionalString(source.nextCursor, source.next_cursor, record(source.page).nextCursor, record(source.meta).nextCursor),
  };
}

const WORKFLOW_NODE_LABELS: Record<string, string> = {
  "annual.pending_payment": "等待车主支付",
  "annual.precheck.pending": "预约资料待预检",
  "annual.precheck.action_required": "预检资料待处理",
  "annual.arrival.owner": "车主待按时到站",
  "annual.driver.assign": "待安排代驾司机",
  "annual.driver.claim": "代驾任务待领取",
  "annual.pickup.driver": "司机待完成取车留证",
  "annual.pickup.owner": "代驾待上门取车",
  "annual.station.arrival": "车辆到站待交接",
  "annual.inspection.start": "车辆待开始检测",
  "annual.inspection.report": "检测报告待发布",
  "annual.report.ready": "检测报告已生成",
  "annual.return.driver": "车辆待开始送回",
  "annual.return.delivery": "车辆待完成送达",
  "annual.service.completed": "年检服务已完成",
  "repair.request.opportunity": "新的维修报价机会",
  "repair.quote.first": "首份维修报价待提交",
  "repair.quote.owner_action": "维修报价待车主查看",
  "repair.order.selected": "维修门店已中选",
  "workflow.exception": "履约异常待处理",
};

function workflowNodeLabel(nodeCode: string): string {
  return WORKFLOW_NODE_LABELS[nodeCode] || "履约待办";
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

export function workflowDateTimeLabel(value: string | null): string {
  if (!value) return "时间待同步";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.replace("T", " ").slice(0, 16);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function workflowDueLabel(dueAt: string | null, urgencyValue: WorkflowTaskUrgency, now = Date.now()): string {
  if (!dueAt) return urgencyValue === "overdue" ? "已超时" : "未设置截止时间";
  const dueTime = Date.parse(dueAt);
  if (!Number.isFinite(dueTime)) return "截止时间待同步";
  const deltaMs = dueTime - now;
  if (deltaMs <= 0) {
    const elapsedMs = Math.abs(deltaMs);
    if (elapsedMs < 60 * 60 * 1000) return `已超时 ${Math.max(1, Math.ceil(elapsedMs / 60000))} 分钟`;
    return `已超时 ${Math.max(1, Math.floor(elapsedMs / (60 * 60 * 1000)))} 小时`;
  }
  if (deltaMs < 60 * 60 * 1000) return `还剩 ${Math.max(1, Math.ceil(deltaMs / 60000))} 分钟`;
  if (deltaMs < 24 * 60 * 60 * 1000) return `还剩 ${Math.ceil(deltaMs / (60 * 60 * 1000))} 小时`;
  return `${workflowDateTimeLabel(dueAt)} 截止`;
}

const CATEGORY_LABELS: Record<WorkflowNotificationCategory, string> = {
  annual_inspection: "年检服务",
  repair_quote: "维修报价",
  platform: "平台消息",
};

const URGENCY_LABELS: Record<WorkflowNotificationUrgency, string> = {
  normal: "进度通知",
  attention: "请及时处理",
  overdue: "已超时",
};

function actionLabel(code: unknown, actionable: boolean): string {
  if (!actionable) return "查看消息";
  const canonical = canonicalWorkflowActionCode(code);
  if (canonical === "annual.report.detail") return "查看检测报告";
  if (canonical === "repair.quotes") return "查看维修报价";
  if (canonical === "repair.request.detail" || canonical === "repair.shop.request.detail") return "查看维修需求";
  if (canonical === "operator.precheck.detail") return "处理预约预检";
  if (canonical === "driver.task.detail") return "处理代驾任务";
  return "查看业务详情";
}

export function workflowNotificationView(
  item: WorkflowNotification,
  now = Date.now(),
  viewer: WorkflowViewer = "owner",
): WorkflowNotificationView {
  const actionable = Boolean(resolveWorkflowActionTarget(item.actionCode, item.actionParams, viewer));
  const categoryLabel = CATEGORY_LABELS[item.category];
  const urgencyLabel = URGENCY_LABELS[item.urgency];
  const timeLabel = workflowDateTimeLabel(item.createdAt);
  const dueLabel = item.dueAt ? workflowDueLabel(item.dueAt, item.urgency, now) : "";
  const iconPath = item.category === "repair_quote"
    ? "/assets/icons/wrench.png"
    : item.urgency === "overdue" ? "/assets/icons/warning-circle.png" : "/assets/icons/clock.png";
  return {
    ...item,
    categoryLabel,
    urgencyLabel,
    timeLabel,
    dueLabel,
    actionLabel: actionLabel(item.actionCode, actionable),
    actionable,
    className: `message-card tone-${item.urgency} ${item.readState === "unread" ? "is-unread" : "is-read"}`,
    iconPath,
    ariaLabel: `${item.readState === "unread" ? "未读，" : ""}${categoryLabel}，${item.title}，${urgencyLabel}${dueLabel ? `，${dueLabel}` : ""}${actionable ? "，点击查看详情" : ""}`,
  };
}

export function normalizeWorkflowTask(value: unknown, now = Date.now()): WorkflowTask {
  const source = record(value);
  const metadata = record(source.metadata || source.metadata_json);
  const dueAt = optionalString(source.dueAt, source.due_at);
  const rawUrgency = urgency(source.urgency || source.level || source.state, dueAt, now);
  const businessType = category(source.businessType || source.business_type || source.domain);
  const rawStatus = stringValue(source.status).toLowerCase();
  return {
    id: stringValue(source.id, source.taskId, source.task_id),
    nodeCode: stringValue(source.nodeCode, source.node_code),
    title: stringValue(source.title, metadata.title, metadata.taskTitle, metadata.task_title) || workflowNodeLabel(stringValue(source.nodeCode, source.node_code)),
    description: stringValue(source.description, source.body, metadata.description, metadata.message),
    urgency: rawUrgency,
    status: rawStatus === "completed" || rawStatus === "closed" ? "completed" : rawStatus === "cancelled" ? "cancelled" : "open",
    businessType,
    businessId: stringValue(source.businessId, source.business_id, source.resourceId, source.resource_id, source.entityId, source.entity_id),
    businessNoMasked: stringValue(
      source.businessNoMasked,
      source.business_no_masked,
      source.businessNo,
      source.business_no,
      metadata.maskedBusinessCode,
      metadata.masked_business_code,
    ),
    actionCode: canonicalWorkflowActionCode(source.actionCode || source.action_code),
    actionParams: actionParams(source.actionParams || source.action_params, source),
    firstReminderAt: optionalString(source.firstReminderAt, source.first_reminder_at),
    dueAt,
    escalationAt: optionalString(source.escalationAt, source.escalation_at, source.escalateAt, source.escalate_at),
    createdAt: stringValue(source.createdAt, source.created_at),
  };
}

export function normalizeWorkflowTaskSummary(value: unknown): WorkflowTaskSummary {
  const source = payloadRecord(value);
  const summary = Object.keys(record(source.summary)).length ? record(source.summary) : source;
  return {
    openCount: nonNegativeInteger(summary.openCount, summary.open_count, summary.pendingCount, summary.pending_count, summary.pending),
    dueSoonCount: nonNegativeInteger(summary.dueSoonCount, summary.due_soon_count, summary.attentionCount, summary.attention_count, summary.dueSoon, summary.due_soon),
    // participantWorkflowTaskSummary 已将 escalated 合并进 overdue；不要在客户端重复相加。
    overdueCount: nonNegativeInteger(summary.overdueCount, summary.overdue_count, summary.overdue),
    nextDueAt: optionalString(summary.nextDueAt, summary.next_due_at),
  };
}

export function normalizeWorkflowTaskPage(value: unknown, now = Date.now()): WorkflowTaskPage {
  const source = payloadRecord(value);
  const rawItems = Array.isArray(source.items) ? source.items : Array.isArray(source.tasks) ? source.tasks : [];
  const items = rawItems
    .map((item) => normalizeWorkflowTask(item, now))
    .filter((item) => item.id)
    .sort((left, right) => {
      const rank = { overdue: 0, attention: 1, normal: 2 } as const;
      return rank[left.urgency] - rank[right.urgency]
        || String(left.dueAt || "9999").localeCompare(String(right.dueAt || "9999"))
        || left.id.localeCompare(right.id);
    });
  const summary = normalizeWorkflowTaskSummary(source);
  return {
    ...summary,
    nextDueAt: summary.nextDueAt || items.find((item) => item.status === "open" && item.dueAt)?.dueAt || null,
    items,
    nextCursor: optionalString(source.nextCursor, source.next_cursor, record(source.meta).nextCursor),
  };
}

export function workflowTaskView(
  item: WorkflowTask,
  viewer: WorkflowViewer,
  now = Date.now(),
): WorkflowTaskView {
  const actionable = Boolean(resolveWorkflowActionTarget(item.actionCode, item.actionParams, viewer));
  const dueLabel = workflowDueLabel(item.dueAt, item.urgency, now);
  const urgencyLabel = item.urgency === "overdue" ? "已超时" : item.urgency === "attention" ? "即将超时" : "待处理";
  return {
    ...item,
    urgencyLabel,
    dueLabel,
    actionLabel: actionLabel(item.actionCode, actionable),
    actionable,
    className: `workflow-task tone-${item.urgency}`,
    ariaLabel: `${urgencyLabel}，${item.title}，${dueLabel}${actionable ? "，点击处理" : ""}`,
  };
}
