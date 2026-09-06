export type WorkflowNotificationCategory = "annual_inspection" | "repair_quote" | "platform";
export type WorkflowNotificationUrgency = "normal" | "attention" | "overdue";
export type WorkflowNotificationReadState = "unread" | "read";

/**
 * Stable action codes are resolved by the mini-program itself. The service is
 * never allowed to provide an arbitrary page path or URL.
 */
export type WorkflowActionCode =
  | "none"
  | "annual.order.detail"
  | "annual.report.detail"
  | "repair.request.detail"
  | "repair.quotes"
  | "operator.booking.detail"
  | "operator.precheck.detail"
  | "repair.shop.request.detail"
  | "driver.task.detail";

export type WorkflowActionParams = {
  bookingId?: string;
  reportId?: string;
  repairRequestId?: string;
  requestId?: string;
  taskId?: string;
  resourceId?: string;
};

export type WorkflowNotification = {
  id: string;
  templateCode: string;
  category: WorkflowNotificationCategory;
  urgency: WorkflowNotificationUrgency;
  readState: WorkflowNotificationReadState;
  title: string;
  body: string;
  actionCode: WorkflowActionCode | string;
  actionParams: WorkflowActionParams;
  businessNoMasked: string;
  dueAt: string | null;
  createdAt: string;
  readAt: string | null;
};

export type WorkflowNotificationSummary = {
  unreadCount: number;
  attentionCount: number;
  overdueCount: number;
};

export type WorkflowNotificationPage = WorkflowNotificationSummary & {
  items: WorkflowNotification[];
  nextCursor: string | null;
};

export type WorkflowTaskUrgency = "normal" | "attention" | "overdue";

export type WorkflowTask = {
  id: string;
  nodeCode: string;
  title: string;
  description: string;
  urgency: WorkflowTaskUrgency;
  status: "open" | "completed" | "cancelled";
  businessType: "annual_inspection" | "repair_quote" | "platform";
  businessId: string;
  businessNoMasked: string;
  actionCode: WorkflowActionCode | string;
  actionParams: WorkflowActionParams;
  firstReminderAt: string | null;
  dueAt: string | null;
  escalationAt: string | null;
  createdAt: string;
};

export type WorkflowTaskSummary = {
  openCount: number;
  dueSoonCount: number;
  overdueCount: number;
  nextDueAt: string | null;
};

export type WorkflowTaskPage = WorkflowTaskSummary & {
  items: WorkflowTask[];
  nextCursor: string | null;
};
