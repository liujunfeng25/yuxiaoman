import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;

export const WORKFLOW_DOMAINS = ["annual_inspection", "repair_quote"] as const;
export type WorkflowDomain = typeof WORKFLOW_DOMAINS[number];

export const WORKFLOW_NODE_CODES = [
  "annual.pending_payment",
  "annual.precheck.pending",
  "annual.precheck.action_required",
  "annual.arrival.owner",
  "annual.driver.assign",
  "annual.driver.claim",
  "annual.pickup.driver",
  "annual.pickup.owner",
  "annual.station.arrival",
  "annual.inspection.start",
  "annual.inspection.report",
  "annual.report.ready",
  "annual.return.driver",
  "annual.return.delivery",
  "annual.service.completed",
  "repair.request.opportunity",
  "repair.quote.first",
  "repair.quote.owner_action",
  "repair.order.selected",
  "workflow.exception",
] as const;
export type WorkflowNodeCode = typeof WORKFLOW_NODE_CODES[number];

export const WORKFLOW_TEMPLATE_CODES = [
  "annual.payment.pending.owner",
  "annual.precheck.pending.station",
  "annual.precheck.action_required.owner",
  "annual.arrival.reminder.owner",
  "annual.driver.assignment.platform",
  "annual.driver.assigned",
  "annual.pickup.evidence.driver",
  "annual.pickup.reminder.owner",
  "annual.station.arrival",
  "annual.inspection.start.station",
  "annual.inspection.overdue",
  "annual.report.ready.owner",
  "annual.return.required.driver",
  "annual.return.delivery.driver",
  "annual.service.completed.owner",
  "repair.request.new.shop",
  "repair.quote.first.owner",
  "repair.order.selected.shop",
  "workflow.exception.platform",
] as const;
export type WorkflowTemplateCode = typeof WORKFLOW_TEMPLATE_CODES[number];

export const WORKFLOW_TEMPLATE_VARIABLES = [
  "maskedPlate",
  "appointmentTime",
  "stationName",
  "pendingCount",
  "overdueCount",
  "reportConclusion",
  "remainingTime",
  "maskedBusinessCode",
  "verificationCode",
  "serviceAmount",
  "serviceItem",
  "warmTip",
  "taskSummary",
  "reviewStatus",
  "reviewResult",
  "eventTime",
] as const;

/** Official WeChat subscribe-message bindings for the first six annual notify scenarios. */
export const OFFICIAL_WECHAT_TEMPLATE_BINDINGS: Readonly<Record<string, {
  providerTemplateId: string;
  fieldMappings: ReadonlyArray<{ field: string; variable: typeof WORKFLOW_TEMPLATE_VARIABLES[number] }>;
  contentSnapshot: string;
}>> = {
  "annual.precheck.pending.station": {
    providerTemplateId: "d4feXT5LI5m4soPpWT-nhH9zc9W8N3BHkWudyY9AxEQ",
    contentSnapshot: "工作任务待办通知",
    fieldMappings: [
      { field: "thing2", variable: "taskSummary" },
      { field: "time3", variable: "eventTime" },
      { field: "character_string10", variable: "maskedBusinessCode" },
      { field: "thing11", variable: "remainingTime" },
    ],
  },
  "annual.payment.pending.owner": {
    providerTemplateId: "eU9ADFE2KA8gMPFgcV8rePfr__d2dB-pDO3QfsbaeD4",
    contentSnapshot: "待付款提醒",
    fieldMappings: [
      { field: "character_string3", variable: "maskedBusinessCode" },
      { field: "thing5", variable: "maskedPlate" },
      { field: "amount10", variable: "serviceAmount" },
      { field: "thing4", variable: "warmTip" },
    ],
  },
  "annual.precheck.action_required.owner": {
    providerTemplateId: "5cIV444lkpQ4CEyakK6Y4OGJJAQZc6CHbsMPvAKuag84",
    contentSnapshot: "素材审核通知",
    fieldMappings: [
      { field: "phrase4", variable: "reviewStatus" },
      { field: "phrase1", variable: "reviewResult" },
      { field: "character_string3", variable: "maskedBusinessCode" },
      { field: "thing2", variable: "warmTip" },
      { field: "time5", variable: "eventTime" },
    ],
  },
  "annual.arrival.reminder.owner": {
    providerTemplateId: "uMToVS4KO3GzecV8e3K6YBlmJJtjRPL31iPIfklHtfU",
    contentSnapshot: "预约提醒",
    fieldMappings: [
      { field: "thing21", variable: "stationName" },
      { field: "time3", variable: "appointmentTime" },
      { field: "thing8", variable: "maskedPlate" },
      { field: "character_string32", variable: "maskedBusinessCode" },
      { field: "thing4", variable: "warmTip" },
    ],
  },
  "annual.report.ready.owner": {
    providerTemplateId: "JZ1PWcyFls-lt7VMnt9FEhcti0lnffMkRcDjx_B2pcc",
    contentSnapshot: "检测报告完成通知",
    fieldMappings: [
      { field: "phrase4", variable: "reportConclusion" },
      { field: "character_string2", variable: "maskedBusinessCode" },
      { field: "thing5", variable: "maskedPlate" },
      { field: "time8", variable: "eventTime" },
    ],
  },
  "annual.service.completed.owner": {
    providerTemplateId: "Wjt3IX-qQJumXwXZd0CMDzSCCTx2UErI_bfApVmYn2c",
    contentSnapshot: "服务完成通知",
    fieldMappings: [
      { field: "character_string1", variable: "maskedBusinessCode" },
      { field: "thing5", variable: "serviceItem" },
      { field: "time3", variable: "eventTime" },
      { field: "thing4", variable: "warmTip" },
    ],
  },
};

const WECHAT_CHANNEL_ENABLED_NODE_CODES = new Set<WorkflowNodeCode>([
  "annual.precheck.pending",
  "annual.pending_payment",
  "annual.precheck.action_required",
  "annual.arrival.owner",
  "annual.report.ready",
  "annual.service.completed",
]);

export type SeedWorkflowOptions = { now?: Date; actor?: string };

type DefaultTemplate = {
  code: WorkflowTemplateCode;
  name: string;
  nodeCode: WorkflowNodeCode;
  title: string;
  body: string;
  actionCode: string;
  allowedVariables: string[];
};

export const DEFAULT_WORKFLOW_TEMPLATES: readonly DefaultTemplate[] = [
  { code: "annual.payment.pending.owner", name: "车主年检待支付提醒", nodeCode: "annual.pending_payment", title: "待完成年检订单支付", body: "{{maskedPlate}} 的年检订单尚未支付，请进入订单完成支付；支付成功后将自动进入资料预检。", actionCode: "annual.order.detail", allowedVariables: ["maskedPlate", "maskedBusinessCode", "serviceAmount", "warmTip"] },
  { code: "annual.precheck.pending.station", name: "检测站预检待办", nodeCode: "annual.precheck.pending", title: "有预约资料待预检", body: "当前有 {{pendingCount}} 笔预约资料待预检，请在 {{remainingTime}} 内处理。", actionCode: "operator.precheck.detail", allowedVariables: ["pendingCount", "remainingTime", "maskedBusinessCode", "taskSummary", "eventTime"] },
  { code: "annual.precheck.action_required.owner", name: "车主预检处理提醒", nodeCode: "annual.precheck.action_required", title: "年检资料需要处理", body: "{{maskedPlate}} 的预检需要补充资料或处理问题，请进入订单查看。", actionCode: "annual.order.detail", allowedVariables: ["maskedPlate", "maskedBusinessCode", "reviewStatus", "reviewResult", "warmTip", "eventTime"] },
  { code: "annual.arrival.reminder.owner", name: "车主到站提醒", nodeCode: "annual.arrival.owner", title: "请按预约时间到站", body: "{{maskedPlate}} 已预约 {{appointmentTime}} 到 {{stationName}} 验车。", actionCode: "annual.order.detail", allowedVariables: ["maskedPlate", "appointmentTime", "stationName", "maskedBusinessCode", "warmTip"] },
  { code: "annual.driver.assignment.platform", name: "平台安排代驾司机待办", nodeCode: "annual.driver.assign", title: "代驾订单待安排司机", body: "当前有 {{pendingCount}} 笔代驾验车订单等待安排司机，请在 {{remainingTime}} 内处理。", actionCode: "workflow.task.detail", allowedVariables: ["pendingCount", "remainingTime", "maskedBusinessCode"] },
  { code: "annual.driver.assigned", name: "代驾司机任务", nodeCode: "annual.driver.claim", title: "您有新的代驾验车任务", body: "任务 {{maskedBusinessCode}} 已安排，验证码 {{verificationCode}}，请及时进入代驾端领取。", actionCode: "driver.task.detail", allowedVariables: ["maskedPlate", "appointmentTime", "stationName", "remainingTime", "maskedBusinessCode", "verificationCode"] },
  { code: "annual.pickup.evidence.driver", name: "司机取车留证待办", nodeCode: "annual.pickup.driver", title: "请完成取车留证", body: "{{maskedPlate}} 的代驾任务已领取，请在 {{remainingTime}} 内完成四角和启动后仪表盘共 5 张取车照片并提交。", actionCode: "driver.task.detail", allowedVariables: ["maskedPlate", "remainingTime", "maskedBusinessCode"] },
  { code: "annual.pickup.reminder.owner", name: "车主代驾取车提醒", nodeCode: "annual.pickup.owner", title: "代驾司机将上门取车", body: "{{maskedPlate}} 的代驾验车任务已安排，请按预约时间准备车辆和必要证件；司机将在现场完成取车留证。", actionCode: "annual.order.detail", allowedVariables: ["maskedPlate", "appointmentTime", "maskedBusinessCode"] },
  { code: "annual.station.arrival", name: "代驾车辆到站", nodeCode: "annual.station.arrival", title: "代驾车辆待交接", body: "当前有 {{pendingCount}} 辆代驾车辆待完成到站交接留证，请及时处理。", actionCode: "operator.booking.detail", allowedVariables: ["pendingCount", "stationName", "remainingTime", "maskedBusinessCode"] },
  { code: "annual.inspection.start.station", name: "检测站开始检测待办", nodeCode: "annual.inspection.start", title: "到站车辆待开始检测", body: "当前有 {{pendingCount}} 辆到站车辆待开始检测，请在 {{remainingTime}} 内处理。", actionCode: "operator.booking.detail", allowedVariables: ["pendingCount", "stationName", "remainingTime", "maskedBusinessCode"] },
  { code: "annual.inspection.overdue", name: "检测与报告发布提醒", nodeCode: "annual.inspection.report", title: "检测报告待发布", body: "当前有 {{pendingCount}} 笔检测报告待发布，请及时完成检测并发布结果；逾期任务将升级处理。", actionCode: "operator.booking.detail", allowedVariables: ["pendingCount", "stationName", "maskedBusinessCode"] },
  { code: "annual.report.ready.owner", name: "年检报告已生成", nodeCode: "annual.report.ready", title: "车辆检测报告已生成", body: "{{maskedPlate}} 年检结论：{{reportConclusion}}。点击查看完整报告。", actionCode: "annual.report.detail", allowedVariables: ["maskedPlate", "reportConclusion", "maskedBusinessCode", "eventTime"] },
  { code: "annual.return.required.driver", name: "司机返程待办", nodeCode: "annual.return.driver", title: "车辆待送回", body: "{{maskedPlate}} 报告已发布，请在 {{remainingTime}} 内开始返程。", actionCode: "driver.task.detail", allowedVariables: ["maskedPlate", "remainingTime", "maskedBusinessCode"] },
  { code: "annual.return.delivery.driver", name: "司机送回留证待办", nodeCode: "annual.return.delivery", title: "请完成车辆送回留证", body: "{{maskedPlate}} 已在返程中，请送达后提交四角和启动后仪表盘共 5 张送回照片。", actionCode: "driver.task.detail", allowedVariables: ["maskedPlate", "maskedBusinessCode"] },
  { code: "annual.service.completed.owner", name: "年检服务完成", nodeCode: "annual.service.completed", title: "本次年检服务已完成", body: "{{maskedPlate}} 的年检服务已完成，可查看节点留证和检测报告。", actionCode: "annual.order.detail", allowedVariables: ["maskedPlate", "reportConclusion", "maskedBusinessCode", "serviceItem", "eventTime", "warmTip"] },
  { code: "repair.request.new.shop", name: "维修店新报价机会", nodeCode: "repair.quote.first", title: "有新的维修报价需求", body: "当前有 {{pendingCount}} 笔维修需求正在等待首份报价，请及时查看。", actionCode: "repair.shop.request.detail", allowedVariables: ["pendingCount", "remainingTime", "maskedBusinessCode"] },
  { code: "repair.quote.first.owner", name: "车主收到首份报价", nodeCode: "repair.quote.owner_action", title: "已收到首份维修报价", body: "{{maskedPlate}} 已收到首份维修报价，请进入需求详情比较和选择。", actionCode: "repair.request.detail", allowedVariables: ["maskedPlate", "maskedBusinessCode"] },
  { code: "repair.order.selected.shop", name: "维修店中选通知", nodeCode: "repair.order.selected", title: "维修报价已被车主选中", body: "当前有 {{pendingCount}} 笔维修需求已完成选店，请查看授权后的订单信息。", actionCode: "repair.shop.request.detail", allowedVariables: ["pendingCount", "maskedBusinessCode"] },
  { code: "workflow.exception.platform", name: "平台履约异常", nodeCode: "workflow.exception", title: "履约异常需要处理", body: "当前有 {{pendingCount}} 项履约异常，其中 {{overdueCount}} 项已超时，请平台值班人员处理。", actionCode: "workflow.task.detail", allowedVariables: ["pendingCount", "overdueCount", "maskedBusinessCode"] },
] as const;

type DefaultNode = {
  code: WorkflowNodeCode;
  name: string;
  domain: WorkflowDomain;
  variant: "all" | "self_drive" | "valet" | "repair";
  triggerState: string;
  nextState: string | null;
  assigneeRole: "owner" | "station" | "driver" | "repair_shop" | "platform";
  subjectScope: string;
  closureAction: string;
  taskKind: "blocking" | "soft" | "information";
  timerMode: "business" | "natural";
  firstReminderMinutes: number | null;
  deadlineMinutes: number | null;
  escalationMinutes: number | null;
  maxReminders: number;
  reminderIntervalMinutes: number | null;
  templateCode: WorkflowTemplateCode;
};

export const DEFAULT_WORKFLOW_NODES: readonly DefaultNode[] = [
  { code: "annual.pending_payment", name: "等待车主支付", domain: "annual_inspection", variant: "all", triggerState: "pending_payment", nextState: "pending_precheck", assigneeRole: "owner", subjectScope: "booking.owner", closureAction: "booking.mock_payment_confirmed", taskKind: "soft", timerMode: "natural", firstReminderMinutes: 15, deadlineMinutes: null, escalationMinutes: null, maxReminders: 1, reminderIntervalMinutes: null, templateCode: "annual.payment.pending.owner" },
  { code: "annual.precheck.pending", name: "检测站预约资料预检", domain: "annual_inspection", variant: "all", triggerState: "pending_precheck", nextState: "awaiting_arrival|confirmed", assigneeRole: "station", subjectScope: "booking.station", closureAction: "booking.precheck.approved_or_action_required", taskKind: "blocking", timerMode: "business", firstReminderMinutes: 30, deadlineMinutes: 120, escalationMinutes: 120, maxReminders: 3, reminderIntervalMinutes: 30, templateCode: "annual.precheck.pending.station" },
  { code: "annual.precheck.action_required", name: "车主处理预检问题", domain: "annual_inspection", variant: "all", triggerState: "precheck_action_required", nextState: "pending_precheck", assigneeRole: "owner", subjectScope: "booking.owner", closureAction: "booking.precheck.resubmitted_or_owner_cancelled", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: 1440, escalationMinutes: 4320, maxReminders: 3, reminderIntervalMinutes: 1440, templateCode: "annual.precheck.action_required.owner" },
  { code: "annual.arrival.owner", name: "自驾按时到站", domain: "annual_inspection", variant: "self_drive", triggerState: "awaiting_arrival", nextState: "checked_in", assigneeRole: "owner", subjectScope: "booking.owner", closureAction: "booking.station_checked_in", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: 15, escalationMinutes: 30, maxReminders: 3, reminderIntervalMinutes: null, templateCode: "annual.arrival.reminder.owner" },
  { code: "annual.driver.assign", name: "平台安排司机", domain: "annual_inspection", variant: "valet", triggerState: "confirmed", nextState: "driver_arranged", assigneeRole: "platform", subjectScope: "platform.duty_group", closureAction: "booking.driver_assigned", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 15, deadlineMinutes: 30, escalationMinutes: 30, maxReminders: 2, reminderIntervalMinutes: 15, templateCode: "annual.driver.assignment.platform" },
  { code: "annual.driver.claim", name: "司机领取任务", domain: "annual_inspection", variant: "valet", triggerState: "driver_arranged", nextState: "picked_up", assigneeRole: "driver", subjectScope: "booking.assigned_driver", closureAction: "driver.task_redeemed", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 15, deadlineMinutes: 60, escalationMinutes: 60, maxReminders: 3, reminderIntervalMinutes: 15, templateCode: "annual.driver.assigned" },
  { code: "annual.pickup.driver", name: "司机完成取车留证", domain: "annual_inspection", variant: "valet", triggerState: "driver_arranged", nextState: "picked_up", assigneeRole: "driver", subjectScope: "booking.assigned_driver", closureAction: "driver.pickup_evidence_completed", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 15, deadlineMinutes: 60, escalationMinutes: 60, maxReminders: 3, reminderIntervalMinutes: 15, templateCode: "annual.pickup.evidence.driver" },
  { code: "annual.pickup.owner", name: "代驾上门取车提醒", domain: "annual_inspection", variant: "valet", triggerState: "driver_arranged", nextState: "picked_up", assigneeRole: "owner", subjectScope: "booking.owner", closureAction: "driver.pickup_evidence_completed", taskKind: "information", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: null, escalationMinutes: null, maxReminders: 1, reminderIntervalMinutes: null, templateCode: "annual.pickup.reminder.owner" },
  { code: "annual.station.arrival", name: "检测站接车交接", domain: "annual_inspection", variant: "valet", triggerState: "picked_up", nextState: "checked_in", assigneeRole: "station", subjectScope: "booking.station", closureAction: "station.arrival_evidence_completed", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 10, deadlineMinutes: 30, escalationMinutes: 30, maxReminders: 3, reminderIntervalMinutes: 10, templateCode: "annual.station.arrival" },
  { code: "annual.inspection.start", name: "检测站开始检测", domain: "annual_inspection", variant: "all", triggerState: "checked_in", nextState: "inspecting", assigneeRole: "station", subjectScope: "booking.station", closureAction: "inspection.started", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 10, deadlineMinutes: 30, escalationMinutes: 30, maxReminders: 3, reminderIntervalMinutes: 10, templateCode: "annual.inspection.start.station" },
  { code: "annual.inspection.report", name: "检测并发布报告", domain: "annual_inspection", variant: "all", triggerState: "inspecting", nextState: "completed|result_received", assigneeRole: "station", subjectScope: "booking.station", closureAction: "inspection.report_published", taskKind: "blocking", timerMode: "business", firstReminderMinutes: 60, deadlineMinutes: 120, escalationMinutes: 180, maxReminders: 4, reminderIntervalMinutes: 30, templateCode: "annual.inspection.overdue" },
  { code: "annual.report.ready", name: "报告已生成通知", domain: "annual_inspection", variant: "all", triggerState: "result_received|completed", nextState: null, assigneeRole: "owner", subjectScope: "booking.owner", closureAction: "notification.acknowledged", taskKind: "information", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: null, escalationMinutes: null, maxReminders: 1, reminderIntervalMinutes: null, templateCode: "annual.report.ready.owner" },
  { code: "annual.return.driver", name: "报告发布后开始送回", domain: "annual_inspection", variant: "valet", triggerState: "result_received", nextState: "returning", assigneeRole: "driver", subjectScope: "booking.assigned_driver", closureAction: "driver.return_started", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 10, deadlineMinutes: 30, escalationMinutes: 30, maxReminders: 2, reminderIntervalMinutes: 10, templateCode: "annual.return.required.driver" },
  { code: "annual.return.delivery", name: "车辆送达留证", domain: "annual_inspection", variant: "valet", triggerState: "returning", nextState: "completed", assigneeRole: "driver", subjectScope: "booking.assigned_driver", closureAction: "driver.delivery_evidence_completed", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: 30, escalationMinutes: 30, maxReminders: 3, reminderIntervalMinutes: 15, templateCode: "annual.return.delivery.driver" },
  { code: "annual.service.completed", name: "服务完成通知", domain: "annual_inspection", variant: "all", triggerState: "completed", nextState: null, assigneeRole: "owner", subjectScope: "booking.owner", closureAction: "notification.acknowledged", taskKind: "information", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: null, escalationMinutes: null, maxReminders: 1, reminderIntervalMinutes: null, templateCode: "annual.service.completed.owner" },
  { code: "repair.request.opportunity", name: "维修店新报价机会", domain: "repair_quote", variant: "repair", triggerState: "open", nextState: "open", assigneeRole: "repair_shop", subjectScope: "one.active_repair_shop", closureAction: "repair.first_quote_submitted_or_request_closed", taskKind: "information", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: null, escalationMinutes: null, maxReminders: 1, reminderIntervalMinutes: null, templateCode: "repair.request.new.shop" },
  { code: "repair.quote.first", name: "维修需求等待首份报价", domain: "repair_quote", variant: "repair", triggerState: "open_no_quotes", nextState: "open_with_quotes", assigneeRole: "repair_shop", subjectScope: "all.active_repair_shops", closureAction: "repair.first_quote_submitted", taskKind: "blocking", timerMode: "business", firstReminderMinutes: 30, deadlineMinutes: 120, escalationMinutes: 120, maxReminders: 3, reminderIntervalMinutes: 30, templateCode: "repair.request.new.shop" },
  { code: "repair.quote.owner_action", name: "车主查看首份报价", domain: "repair_quote", variant: "repair", triggerState: "open_with_quotes", nextState: "paid|cancelled", assigneeRole: "owner", subjectScope: "repair.owner", closureAction: "repair.quote_selected_or_request_cancelled", taskKind: "soft", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: 1440, escalationMinutes: null, maxReminders: 2, reminderIntervalMinutes: 1440, templateCode: "repair.quote.first.owner" },
  { code: "repair.order.selected", name: "中选维修店通知", domain: "repair_quote", variant: "repair", triggerState: "paid", nextState: null, assigneeRole: "repair_shop", subjectScope: "repair.selected_shop", closureAction: "notification.acknowledged", taskKind: "information", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: null, escalationMinutes: null, maxReminders: 1, reminderIntervalMinutes: null, templateCode: "repair.order.selected.shop" },
  { code: "workflow.exception", name: "平台异常处理", domain: "annual_inspection", variant: "all", triggerState: "exception", nextState: null, assigneeRole: "platform", subjectScope: "platform.duty_group", closureAction: "workflow.exception_resolved", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: 30, escalationMinutes: 60, maxReminders: 4, reminderIntervalMinutes: 15, templateCode: "workflow.exception.platform" },
  { code: "workflow.exception", name: "平台异常处理", domain: "repair_quote", variant: "repair", triggerState: "exception", nextState: null, assigneeRole: "platform", subjectScope: "platform.duty_group", closureAction: "workflow.exception_resolved", taskKind: "blocking", timerMode: "natural", firstReminderMinutes: 0, deadlineMinutes: 30, escalationMinutes: 60, maxReminders: 4, reminderIntervalMinutes: 15, templateCode: "workflow.exception.platform" },
] as const;

/**
 * Notification templates are shared across policy versions, but most still
 * belong to one business domain. A null domain is intentional for templates
 * such as the platform exception notice that are used by multiple domains.
 */
export function workflowTemplateDomain(stableCode: string): WorkflowDomain | null {
  const domains = new Set(
    DEFAULT_WORKFLOW_NODES
      .filter((node) => node.templateCode === stableCode)
      .map((node) => node.domain),
  );
  return domains.size === 1 ? [...domains][0] : null;
}

export async function migrateWorkflowDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS workflow_policy_sets (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL CHECK (domain IN ('annual_inspection', 'repair_quote')),
      stable_code TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'retired')),
      version INTEGER,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      business_hours_json TEXT NOT NULL DEFAULT '{}',
      source_policy_set_id TEXT REFERENCES workflow_policy_sets(id),
      created_by TEXT NOT NULL,
      published_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      CHECK ((state = 'published' AND version IS NOT NULL AND published_at IS NOT NULL) OR state <> 'published')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_policy_sets_published_version_uq
      ON workflow_policy_sets(domain, version) WHERE state = 'published';
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_policy_sets_current_uq
      ON workflow_policy_sets(domain) WHERE is_current = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_policy_sets_draft_uq
      ON workflow_policy_sets(domain) WHERE state = 'draft';

    CREATE TABLE IF NOT EXISTS workflow_policy_nodes (
      id TEXT PRIMARY KEY,
      policy_set_id TEXT NOT NULL REFERENCES workflow_policy_sets(id) ON DELETE CASCADE,
      node_code TEXT NOT NULL,
      node_name TEXT NOT NULL,
      workflow_variant TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      trigger_state TEXT NOT NULL,
      next_state TEXT,
      assignee_role TEXT NOT NULL,
      subject_scope TEXT NOT NULL,
      closure_action TEXT NOT NULL,
      task_kind TEXT NOT NULL CHECK (task_kind IN ('blocking', 'soft', 'information')),
      timer_mode TEXT NOT NULL CHECK (timer_mode IN ('business', 'natural')),
      first_reminder_minutes INTEGER CHECK (first_reminder_minutes IS NULL OR first_reminder_minutes >= 0),
      deadline_minutes INTEGER CHECK (deadline_minutes IS NULL OR deadline_minutes >= 0),
      escalation_minutes INTEGER CHECK (escalation_minutes IS NULL OR escalation_minutes >= 0),
      max_reminders INTEGER NOT NULL DEFAULT 1 CHECK (max_reminders BETWEEN 0 AND 100),
      reminder_interval_minutes INTEGER CHECK (reminder_interval_minutes IS NULL OR reminder_interval_minutes > 0),
      enabled_channels_json TEXT NOT NULL DEFAULT '["in_app"]',
      fallback_order_json TEXT NOT NULL DEFAULT '[]',
      template_bindings_json TEXT NOT NULL DEFAULT '{}',
      escalation_level TEXT NOT NULL DEFAULT 'platform_duty',
      quiet_hours_json TEXT NOT NULL DEFAULT '{}',
      immutable_rules_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(policy_set_id, node_code)
    );

    CREATE TABLE IF NOT EXISTS notification_templates (
      id TEXT PRIMARY KEY,
      stable_code TEXT NOT NULL,
      name TEXT NOT NULL,
      node_code TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('in_app', 'sms', 'wechat')),
      version INTEGER,
      state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'retired')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      button_text TEXT,
      action_code TEXT NOT NULL,
      allowed_variables_json TEXT NOT NULL DEFAULT '[]',
      example_data_json TEXT NOT NULL DEFAULT '{}',
      provider_template_id TEXT,
      provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
      filing_status TEXT NOT NULL DEFAULT 'not_required',
      created_by TEXT NOT NULL,
      published_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      CHECK ((state = 'published' AND version IS NOT NULL AND published_at IS NOT NULL) OR state <> 'published')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_version_uq
      ON notification_templates(stable_code, channel, version) WHERE state = 'published';
    CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_current_uq
      ON notification_templates(stable_code, channel) WHERE is_current = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_draft_uq
      ON notification_templates(stable_code, channel) WHERE state = 'draft';

    CREATE TABLE IF NOT EXISTS workflow_entity_bindings (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL CHECK (domain IN ('annual_inspection', 'repair_quote')),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      owner_user_id TEXT,
      subject_type TEXT,
      subject_id TEXT,
      policy_set_id TEXT NOT NULL REFERENCES workflow_policy_sets(id),
      policy_version INTEGER NOT NULL,
      enabled_at TEXT NOT NULL,
      UNIQUE(domain, entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_tasks (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES workflow_entity_bindings(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      node_code TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      owner_user_id TEXT,
      subject_type TEXT,
      subject_id TEXT,
      assignee_role TEXT NOT NULL,
      recipient_user_id TEXT,
      recipient_phone_encrypted TEXT,
      recipient_phone_masked TEXT,
      recipient_phone_hash TEXT,
      recipient_wechat_openid_encrypted TEXT,
      recipient_wechat_openid_masked TEXT,
      recipient_wechat_openid_hash TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled', 'expired')),
      task_kind TEXT NOT NULL CHECK (task_kind IN ('blocking', 'soft', 'information')),
      policy_set_id TEXT NOT NULL REFERENCES workflow_policy_sets(id),
      policy_version INTEGER NOT NULL,
      policy_node_snapshot_json TEXT NOT NULL,
      template_bindings_snapshot_json TEXT NOT NULL DEFAULT '{}',
      anchor_at TEXT NOT NULL,
      first_reminder_at TEXT,
      next_reminder_at TEXT,
      due_at TEXT,
      escalate_at TEXT,
      reminder_count INTEGER NOT NULL DEFAULT 0,
      max_reminders INTEGER NOT NULL DEFAULT 0,
      reminder_interval_minutes INTEGER,
      reminder_schedule_json TEXT NOT NULL DEFAULT '[]',
      last_reminded_at TEXT,
      escalated_at TEXT,
      closed_at TEXT,
      closed_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    DROP INDEX IF EXISTS workflow_tasks_active_node_uq;
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_tasks_active_node_uq
      ON workflow_tasks(
        binding_id,
        node_code,
        COALESCE(subject_type, ''),
        COALESCE(subject_id, ''),
        COALESCE(recipient_user_id, '')
      ) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS workflow_tasks_due_idx
      ON workflow_tasks(status, next_reminder_at, due_at, escalate_at);
    CREATE INDEX IF NOT EXISTS workflow_tasks_subject_idx
      ON workflow_tasks(subject_type, subject_id, status, due_at);
    CREATE INDEX IF NOT EXISTS workflow_tasks_owner_idx
      ON workflow_tasks(owner_user_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      from_status TEXT,
      to_status TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_task_events_task_idx ON workflow_task_events(task_id, occurred_at);

    CREATE TABLE IF NOT EXISTS notification_inbox (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES workflow_tasks(id) ON DELETE SET NULL,
      recipient_user_id TEXT NOT NULL,
      template_id TEXT REFERENCES notification_templates(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      action_code TEXT NOT NULL,
      action_params_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT NOT NULL UNIQUE,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notification_inbox_user_idx
      ON notification_inbox(recipient_user_id, read_at, created_at DESC);

    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES workflow_tasks(id) ON DELETE SET NULL,
      channel TEXT NOT NULL CHECK (channel IN ('sms', 'wechat')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'retry', 'accepted', 'delivered', 'failed', 'dead_letter', 'cancelled')),
      template_id TEXT NOT NULL REFERENCES notification_templates(id),
      template_code TEXT NOT NULL,
      template_version INTEGER NOT NULL,
      rendered_title TEXT NOT NULL DEFAULT '',
      rendered_body TEXT NOT NULL,
      action_code TEXT NOT NULL,
      action_params_json TEXT NOT NULL DEFAULT '{}',
      recipient_address_encrypted TEXT,
      recipient_address_masked TEXT,
      recipient_address_hash TEXT,
      sensitive_payload_encrypted TEXT,
      fallback_channels_json TEXT NOT NULL DEFAULT '[]',
      fallback_index INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT NOT NULL UNIQUE,
      aggregate_key TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      leased_until TEXT,
      lease_owner TEXT,
      provider_message_id TEXT,
      provider_state TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      accepted_at TEXT,
      delivered_at TEXT,
      sensitive_cleared_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notification_outbox_poll_idx
      ON notification_outbox(status, available_at, leased_until);
    -- Aggregation membership is implemented separately from outbox idempotency.
    -- Drop the early lossy uniqueness experiment on upgraded local databases.
    DROP INDEX IF EXISTS notification_outbox_active_aggregate_uq;

    CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
      id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      provider_code TEXT,
      provider_message_id TEXT,
      error_class TEXT,
      recipient_address_hash TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      UNIQUE(outbox_id, attempt_number)
    );
    CREATE INDEX IF NOT EXISTS notification_delivery_attempts_rate_idx
      ON notification_delivery_attempts(channel, recipient_address_hash, started_at);

    CREATE TABLE IF NOT EXISTS wechat_subscription_authorizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      authorization_state TEXT NOT NULL CHECK (authorization_state IN ('accepted', 'rejected', 'banned', 'unknown')),
      remaining_uses INTEGER,
      provider_app_id TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, template_id, provider_app_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_notification_recipients (
      id TEXT PRIMARY KEY,
      recipient_type TEXT NOT NULL CHECK (recipient_type IN ('service_subject', 'platform_duty')),
      subject_type TEXT,
      subject_id TEXT,
      contact_name TEXT NOT NULL,
      phone_encrypted TEXT NOT NULL,
      phone_masked TEXT NOT NULL,
      phone_hash TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
      duty_schedule_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(recipient_type, subject_type, subject_id, phone_hash)
    );
    CREATE INDEX IF NOT EXISTS workflow_notification_recipients_subject_idx
      ON workflow_notification_recipients(recipient_type, subject_type, subject_id, is_enabled);

    CREATE TABLE IF NOT EXISTS workflow_release_events (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      domain TEXT,
      version INTEGER,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_test_sms_limits (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      recipient_hash TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_test_sms_limits_actor_idx
      ON workflow_test_sms_limits(actor_id, sent_at);
  `);
  await database.execute(`
    ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS recipient_phone_encrypted TEXT;
    ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS recipient_phone_masked TEXT;
    ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS recipient_phone_hash TEXT;
    ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS recipient_wechat_openid_encrypted TEXT;
    ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS recipient_wechat_openid_masked TEXT;
    ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS recipient_wechat_openid_hash TEXT;
    ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS reminder_schedule_json TEXT NOT NULL DEFAULT '[]';
  `);
}

const EXAMPLE_DATA: Record<string, string | number> = {
  maskedPlate: "津A·8***8",
  appointmentTime: "9月6日 10:00–11:00",
  stationName: "华洋机动车检测站",
  pendingCount: 3,
  overdueCount: 1,
  reportConclusion: "通过",
  remainingTime: "30分钟",
  maskedBusinessCode: "YXM-***-8A21",
  verificationCode: "******",
  serviceAmount: "260.00",
  serviceItem: "机动车年检",
  warmTip: "请打开小程序查看详情",
  taskSummary: "预约资料待预检",
  reviewStatus: "待处理",
  reviewResult: "需补充",
  eventTime: "2026-09-07 10:00:00",
};

async function ensureBootstrapReleaseEvent(
  database: AppDatabase,
  input: {
    resourceType: "workflow_policy" | "notification_template";
    resourceId: string;
    domain: WorkflowDomain | null;
    version: number;
    actor: string;
    occurredAt: string;
    summary: Record<string, unknown>;
  },
): Promise<void> {
  const id = `workflow-release-bootstrap-${input.resourceType}-${input.resourceId}-v${input.version}`;
  await database.prepare(`
    INSERT INTO workflow_release_events (
      id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 'published', ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_release_events
      WHERE resource_type = ? AND resource_id = ? AND version = ? AND action = 'published'
    )
    ON CONFLICT (id) DO NOTHING
  `).run(
    id,
    input.resourceType,
    input.resourceId,
    input.domain,
    input.version,
    input.actor,
    JSON.stringify(input.summary),
    input.occurredAt,
    input.resourceType,
    input.resourceId,
    input.version,
  );
}

async function seedTemplateChannel(
  database: AppDatabase,
  template: DefaultTemplate,
  channel: "in_app" | "sms" | "wechat",
  now: string,
  actor: string,
): Promise<string> {
  const id = `workflow-template-${template.code.replaceAll(".", "-")}-${channel}-v1`;
  const body = channel === "sms" ? `【驭小满】${template.body}` : template.body;
  const wechatBinding = channel === "wechat" ? OFFICIAL_WECHAT_TEMPLATE_BINDINGS[template.code] : undefined;
  const filingStatus = channel === "in_app"
    ? "not_required"
    : channel === "sms"
      ? "unreported"
      : wechatBinding
        ? "configured"
        : "unconfigured";
  const providerSnapshot = wechatBinding
    ? {
      fieldMappings: [...wechatBinding.fieldMappings],
      contentSnapshot: wechatBinding.contentSnapshot,
    }
    : {};
  await database.prepare(`
    INSERT INTO notification_templates (
      id, stable_code, name, node_code, channel, version, state, revision, is_current,
      title, body, button_text, action_code, allowed_variables_json, example_data_json,
      provider_template_id, provider_snapshot_json, filing_status,
      created_by, published_by, created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'published', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `).run(
    id,
    template.code,
    template.name,
    template.nodeCode,
    channel,
    channel === "sms" ? "" : template.title,
    body,
    channel === "in_app" ? "查看详情" : null,
    template.actionCode,
    JSON.stringify(template.allowedVariables),
    JSON.stringify(EXAMPLE_DATA),
    wechatBinding?.providerTemplateId ?? null,
    JSON.stringify(providerSnapshot),
    filingStatus,
    actor,
    actor,
    now,
    now,
    now,
  );
  const published = await database.prepare<Row>(`
    SELECT name, stable_code, channel, version, published_by, published_at, created_by, created_at
    FROM notification_templates WHERE id = ? AND state = 'published'
  `).get(id);
  if (published) {
    await ensureBootstrapReleaseEvent(database, {
      resourceType: "notification_template",
      resourceId: id,
      domain: workflowTemplateDomain(String(published.stable_code)),
      version: Number(published.version),
      actor: String(published.published_by ?? published.created_by ?? actor),
      occurredAt: String(published.published_at ?? published.created_at ?? now),
      summary: {
        stableCode: String(published.stable_code),
        channel: String(published.channel),
        resourceName: String(published.name),
        changeSummary: "系统初始化默认通知模板",
      },
    });
  }
  return id;
}

async function insertDefaultPolicyNode(
  database: AppDatabase,
  policyId: string,
  node: DefaultNode,
  sortOrder: number,
): Promise<void> {
  const inAppTemplateId = `workflow-template-${node.templateCode.replaceAll(".", "-")}-in_app-v1`;
  const smsTemplateId = `workflow-template-${node.templateCode.replaceAll(".", "-")}-sms-v1`;
  const wechatTemplateId = `workflow-template-${node.templateCode.replaceAll(".", "-")}-wechat-v1`;
  await database.prepare(`
    INSERT INTO workflow_policy_nodes (
      id, policy_set_id, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
      escalation_minutes, max_reminders, reminder_interval_minutes,
      enabled_channels_json, fallback_order_json, template_bindings_json,
      escalation_level, quiet_hours_json, immutable_rules_json, sort_order
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'platform_duty', ?, ?, ?)
    ON CONFLICT (policy_set_id, node_code) DO NOTHING
  `).run(
    `${policyId}:${node.code}`,
    policyId,
    node.code,
    node.name,
    node.variant,
    node.triggerState,
    node.nextState,
    node.assigneeRole,
    node.subjectScope,
    node.closureAction,
    node.taskKind,
    node.timerMode,
    node.firstReminderMinutes,
    node.deadlineMinutes,
    node.escalationMinutes,
    node.maxReminders,
    node.reminderIntervalMinutes,
    JSON.stringify(WECHAT_CHANNEL_ENABLED_NODE_CODES.has(node.code) ? ["in_app", "wechat"] : ["in_app"]),
    JSON.stringify([]),
    JSON.stringify({ in_app: inAppTemplateId, sms: smsTemplateId, wechat: wechatTemplateId }),
    JSON.stringify({ start: "22:00", end: "08:00", appliesTo: "owner_non_urgent" }),
    JSON.stringify({
      triggerState: node.triggerState,
      nextState: node.nextState,
      assigneeRole: node.assigneeRole,
      subjectScope: node.subjectScope,
      closureAction: node.closureAction,
      taskKind: node.taskKind,
      prohibitedAutomation: ["pay", "approve_precheck", "publish_report", "refund", "select_repair_shop"],
    }),
    sortOrder,
  );
}

async function migrateLegacyWorkflowPolicyDefaults(
  database: AppDatabase,
  domain: WorkflowDomain,
  now: string,
): Promise<void> {
  const legacyId = domain === "annual_inspection" ? "annual-workflow-v1" : "repair-workflow-v1";
  const current = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_sets
    WHERE id = ? AND domain = ? AND state = 'published' AND is_current = 1
      AND version = 1 AND created_by = 'system-seed'
    FOR UPDATE
  `).get(legacyId, domain);
  if (!current) return;
  const needsUpgrade = await database.prepare<Row>(`
    SELECT 1 FROM workflow_policy_nodes
    WHERE policy_set_id = ? AND (
      (enabled_channels_json = '["in_app"]' AND fallback_order_json = '["wechat","sms"]')
      OR (? = 'annual_inspection' AND node_code = 'annual.pickup.owner'
        AND first_reminder_minutes IS NULL AND deadline_minutes IS NULL AND escalation_minutes IS NULL)
      OR (? = 'annual_inspection' AND node_code = 'annual.arrival.owner'
        AND first_reminder_minutes IS NULL AND deadline_minutes IS NULL AND escalation_minutes IS NULL)
      OR (? = 'annual_inspection' AND node_code = 'annual.return.delivery'
        AND first_reminder_minutes IS NULL AND deadline_minutes IS NULL AND escalation_minutes IS NULL)
    ) LIMIT 1
  `).get(legacyId, domain, domain, domain);
  if (!needsUpgrade) return;
  const nextId = domain === "annual_inspection"
    ? "annual-workflow-v2-secure-defaults"
    : "repair-workflow-v2-secure-defaults";
  await database.prepare("UPDATE workflow_policy_sets SET is_current = 0 WHERE id = ?").run(legacyId);
  await database.prepare(`
    INSERT INTO workflow_policy_sets (
      id, domain, stable_code, name, state, version, revision, is_current,
      timezone, business_hours_json, source_policy_set_id, created_by,
      published_by, created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, 'published', 2, 1, 1, ?, ?, ?,
      'system-migration', 'system-migration', ?, ?, ?)
  `).run(
    nextId, domain, String(current.stable_code), `${String(current.name)}（安全默认升级）`,
    String(current.timezone), String(current.business_hours_json), legacyId, now, now, now,
  );
  await database.prepare(`
    INSERT INTO workflow_policy_nodes (
      id, policy_set_id, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
      escalation_minutes, max_reminders, reminder_interval_minutes,
      enabled_channels_json, fallback_order_json, template_bindings_json,
      escalation_level, quiet_hours_json, immutable_rules_json, sort_order
    )
    SELECT ? || ':' || node_code, ?, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode,
      CASE
        WHEN node_code IN ('annual.pickup.owner','annual.arrival.owner','annual.return.delivery')
          AND first_reminder_minutes IS NULL THEN 0
        ELSE first_reminder_minutes END,
      CASE WHEN node_code = 'annual.arrival.owner' AND deadline_minutes IS NULL THEN 15
        WHEN node_code = 'annual.return.delivery' AND deadline_minutes IS NULL THEN 30
        ELSE deadline_minutes END,
      CASE WHEN node_code = 'annual.arrival.owner' AND escalation_minutes IS NULL THEN 30
        WHEN node_code = 'annual.return.delivery' AND escalation_minutes IS NULL THEN 30
        ELSE escalation_minutes END,
      CASE WHEN node_code = 'annual.pickup.owner' THEN 1 ELSE max_reminders END,
      reminder_interval_minutes, enabled_channels_json,
      CASE WHEN enabled_channels_json = '["in_app"]'
        AND fallback_order_json = '["wechat","sms"]' THEN '[]' ELSE fallback_order_json END,
      template_bindings_json, escalation_level, quiet_hours_json,
      immutable_rules_json, sort_order
    FROM workflow_policy_nodes WHERE policy_set_id = ?
  `).run(nextId, nextId, legacyId);
  await database.prepare(`
    INSERT INTO workflow_release_events (
      id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
    ) VALUES (?, 'workflow_policy', ?, ?, 2, 'system-migration', 'published', ?, ?)
  `).run(
    randomUUID(), nextId, domain,
    JSON.stringify({ sourceVersion: 1, changeSummary: "安全关闭未启用外部兜底，并恢复可配置预约节点计时" }), now,
  );
}

async function migrateLegacyReportReadyTemplates(
  database: AppDatabase,
  now: string,
): Promise<void> {
  const rows = await database.prepare<Row>(`
    SELECT * FROM notification_templates
    WHERE stable_code = 'annual.report.ready.owner'
      AND state = 'published' AND is_current = 1
      AND node_code <> 'annual.report.ready'
    ORDER BY channel
    FOR UPDATE
  `).all();
  for (const current of rows) {
    const channel = String(current.channel);
    const maxVersion = await database.prepare<Row>(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM notification_templates
      WHERE stable_code = 'annual.report.ready.owner' AND channel = ? AND state = 'published'
    `).get(channel);
    const version = Number(maxVersion?.version ?? 0) + 1;
    const id = `workflow-template-annual-report-ready-owner-${channel}-v${version}`;
    await database.prepare(`
      UPDATE notification_templates SET is_current = 0, updated_at = ?
      WHERE id = ? AND is_current = 1
    `).run(now, String(current.id));
    await database.prepare(`
      INSERT INTO notification_templates (
        id, stable_code, name, node_code, channel, version, state, revision, is_current,
        title, body, button_text, action_code, allowed_variables_json, example_data_json,
        provider_template_id, provider_snapshot_json, filing_status,
        created_by, published_by, created_at, updated_at, published_at
      ) VALUES (?, 'annual.report.ready.owner', ?, 'annual.report.ready', ?, ?, 'published', 1, 1,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system-migration', 'system-migration', ?, ?, ?)
    `).run(
      id, String(current.name), channel, version,
      String(current.title ?? ""), String(current.body),
      current.button_text == null ? null : String(current.button_text), String(current.action_code),
      String(current.allowed_variables_json), String(current.example_data_json),
      current.provider_template_id == null ? null : String(current.provider_template_id),
      String(current.provider_snapshot_json), String(current.filing_status), now, now, now,
    );
    await database.prepare(`
      INSERT INTO workflow_release_events (
        id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
      ) VALUES (?, 'notification_template', ?, 'annual_inspection', ?, 'system-migration', 'published', ?, ?)
    `).run(
      randomUUID(), id, version,
      JSON.stringify({ sourceTemplateId: String(current.id), changeSummary: "以新版本修正报告通知适用节点，历史模板内容保持不变" }), now,
    );
  }
}

async function migrateLegacyPrecheckTemplateActions(
  database: AppDatabase,
  now: string,
): Promise<void> {
  const rows = await database.prepare<Row>(`
    SELECT * FROM notification_templates
    WHERE stable_code = 'annual.precheck.pending.station'
      AND state = 'published' AND is_current = 1
      AND action_code = 'operator.booking.detail'
      AND created_by IN ('system-seed', 'system-migration')
    ORDER BY channel
    FOR UPDATE
  `).all();
  for (const current of rows) {
    const channel = String(current.channel);
    const maxVersion = await database.prepare<Row>(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM notification_templates
      WHERE stable_code = 'annual.precheck.pending.station' AND channel = ? AND state = 'published'
    `).get(channel);
    const version = Number(maxVersion?.version ?? 0) + 1;
    const id = `workflow-template-annual-precheck-pending-station-${channel}-v${version}`;
    await database.prepare(`
      UPDATE notification_templates SET is_current = 0, updated_at = ?
      WHERE id = ? AND is_current = 1
    `).run(now, String(current.id));
    await database.prepare(`
      INSERT INTO notification_templates (
        id, stable_code, name, node_code, channel, version, state, revision, is_current,
        title, body, button_text, action_code, allowed_variables_json, example_data_json,
        provider_template_id, provider_snapshot_json, filing_status,
        created_by, published_by, created_at, updated_at, published_at
      ) VALUES (?, 'annual.precheck.pending.station', ?, 'annual.precheck.pending', ?, ?, 'published', 1, 1,
        ?, ?, ?, 'operator.precheck.detail', ?, ?, ?, ?, ?,
        'system-migration', 'system-migration', ?, ?, ?)
    `).run(
      id, String(current.name), channel, version,
      String(current.title ?? ""), String(current.body),
      current.button_text == null ? null : String(current.button_text),
      String(current.allowed_variables_json), String(current.example_data_json),
      current.provider_template_id == null ? null : String(current.provider_template_id),
      String(current.provider_snapshot_json), String(current.filing_status), now, now, now,
    );
    await database.prepare(`
      INSERT INTO workflow_release_events (
        id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
      ) VALUES (?, 'notification_template', ?, 'annual_inspection', ?, 'system-migration', 'published', ?, ?)
    `).run(
      randomUUID(), id, version,
      JSON.stringify({ sourceTemplateId: String(current.id), changeSummary: "以新版本修正预检待办跳转至可操作的资料预检详情" }), now,
    );
  }
}

/**
 * The first report-reminder copy called every outstanding report "overdue",
 * even though the first reminder is deliberately sent one hour before the
 * two-hour deadline. Publish corrected template versions so existing task
 * snapshots remain unchanged while newly-created tasks use truthful copy.
 */
async function migrateLegacyInspectionReportTemplateCopy(
  database: AppDatabase,
  now: string,
): Promise<void> {
  const replacement = DEFAULT_WORKFLOW_TEMPLATES.find((template) => template.code === "annual.inspection.overdue");
  if (!replacement) throw new Error("Default inspection report reminder template is missing");
  const rows = await database.prepare<Row>(`
    SELECT * FROM notification_templates
    WHERE stable_code = 'annual.inspection.overdue'
      AND state = 'published' AND is_current = 1
      AND created_by IN ('system-seed', 'system-migration')
      AND (name = '检测与报告超时' OR body LIKE '%{{overdueCount}}%已超时%')
    ORDER BY channel
    FOR UPDATE
  `).all();
  for (const current of rows) {
    const channel = String(current.channel) as "in_app" | "sms" | "wechat";
    const maxVersion = await database.prepare<Row>(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM notification_templates
      WHERE stable_code = 'annual.inspection.overdue' AND channel = ? AND state = 'published'
    `).get(channel);
    const version = Number(maxVersion?.version ?? 0) + 1;
    const id = `workflow-template-annual-inspection-overdue-${channel}-v${version}`;
    const body = channel === "sms" ? `【驭小满】${replacement.body}` : replacement.body;
    const filingStatus = channel === "in_app" ? "not_required" : channel === "sms" ? "unreported" : "unconfigured";
    await database.prepare(`
      UPDATE notification_templates SET is_current = 0, updated_at = ?
      WHERE id = ? AND is_current = 1
    `).run(now, String(current.id));
    await database.prepare(`
      INSERT INTO notification_templates (
        id, stable_code, name, node_code, channel, version, state, revision, is_current,
        title, body, button_text, action_code, allowed_variables_json, example_data_json,
        provider_template_id, provider_snapshot_json, filing_status,
        created_by, published_by, created_at, updated_at, published_at
      ) VALUES (?, 'annual.inspection.overdue', ?, 'annual.inspection.report', ?, ?, 'published', 1, 1,
        ?, ?, ?, ?, ?, ?, NULL, '{}', ?,
        'system-migration', 'system-migration', ?, ?, ?)
    `).run(
      id,
      replacement.name,
      channel,
      version,
      channel === "sms" ? "" : replacement.title,
      body,
      channel === "in_app" ? "查看详情" : null,
      replacement.actionCode,
      JSON.stringify(replacement.allowedVariables),
      JSON.stringify(EXAMPLE_DATA),
      filingStatus,
      now,
      now,
      now,
    );
    await database.prepare(`
      INSERT INTO workflow_release_events (
        id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
      ) VALUES (?, 'notification_template', ?, 'annual_inspection', ?, 'system-migration', 'published', ?, ?)
    `).run(
      randomUUID(),
      id,
      version,
      JSON.stringify({
        sourceTemplateId: String(current.id),
        resourceName: replacement.name,
        changeSummary: "修正首次提醒尚未逾期却显示已超时的文案；历史任务保留原模板快照",
      }),
      now,
    );
  }
}

const ANNUAL_TEMPLATE_SEMANTIC_BINDINGS = {
  "annual.pending_payment": "annual.payment.pending.owner",
  "annual.driver.assign": "annual.driver.assignment.platform",
  "annual.pickup.owner": "annual.pickup.reminder.owner",
  "annual.return.delivery": "annual.return.delivery.driver",
} as const satisfies Partial<Record<WorkflowNodeCode, WorkflowTemplateCode>>;

function defaultTemplateBindings(templateCode: WorkflowTemplateCode): Record<string, string> {
  const prefix = `workflow-template-${templateCode.replaceAll(".", "-")}`;
  return {
    in_app: `${prefix}-in_app-v1`,
    sms: `${prefix}-sms-v1`,
    wechat: `${prefix}-wechat-v1`,
  };
}

/**
 * Four early default nodes reused templates for different business actions.
 * Clone the current system policy and change only template bindings. Timers,
 * roles, states and closure actions are copied byte-for-byte; existing entity
 * bindings and task snapshots remain on their original published versions.
 */
async function migrateAnnualTemplateSemanticBindings(
  database: AppDatabase,
  now: string,
): Promise<void> {
  await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .get("workflow-policy-migration:annual.template-semantics");
  const current = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_sets
    WHERE domain = 'annual_inspection' AND state = 'published' AND is_current = 1
      AND created_by IN ('system-seed', 'system-migration')
    FOR UPDATE
  `).get();
  if (!current) return;

  const nodes = await database.prepare<Row>(`
    SELECT node_code, template_bindings_json
    FROM workflow_policy_nodes
    WHERE policy_set_id = ? AND node_code = ANY(?::text[])
  `).all(String(current.id), Object.keys(ANNUAL_TEMPLATE_SEMANTIC_BINDINGS));
  const needsUpgrade: Array<[WorkflowNodeCode, WorkflowTemplateCode]> = [];
  for (const row of nodes) {
    const nodeCode = String(row.node_code) as WorkflowNodeCode;
    const expectedCode = ANNUAL_TEMPLATE_SEMANTIC_BINDINGS[nodeCode as keyof typeof ANNUAL_TEMPLATE_SEMANTIC_BINDINGS];
    if (!expectedCode) continue;
    const inAppId = (() => {
      try {
        const parsed = JSON.parse(String(row.template_bindings_json)) as Record<string, unknown>;
        return typeof parsed.in_app === "string" ? parsed.in_app : "";
      } catch {
        return "";
      }
    })();
    const bound = inAppId
      ? await database.prepare<Row>("SELECT stable_code FROM notification_templates WHERE id = ?").get(inAppId)
      : undefined;
    if (String(bound?.stable_code ?? "") !== expectedCode) needsUpgrade.push([nodeCode, expectedCode]);
  }
  if (needsUpgrade.length === 0) return;

  const maxVersion = await database.prepare<Row>(`
    SELECT COALESCE(MAX(version), 0) AS version FROM workflow_policy_sets
    WHERE domain = 'annual_inspection' AND state = 'published'
  `).get();
  const version = Number(maxVersion?.version ?? 0) + 1;
  const nextId = `annual-workflow-v${version}-notification-semantics`;
  await database.prepare(`
    UPDATE workflow_policy_sets SET is_current = 0, updated_at = ?
    WHERE id = ? AND is_current = 1
  `).run(now, String(current.id));
  await database.prepare(`
    INSERT INTO workflow_policy_sets (
      id, domain, stable_code, name, state, version, revision, is_current,
      timezone, business_hours_json, source_policy_set_id, created_by,
      published_by, created_at, updated_at, published_at
    ) VALUES (?, 'annual_inspection', ?, ?, 'published', ?, 1, 1, ?, ?, ?,
      'system-migration', 'system-migration', ?, ?, ?)
  `).run(
    nextId,
    String(current.stable_code),
    `${String(current.name).replace(/（通知匹配升级）$/u, "")}（通知匹配升级）`,
    version,
    String(current.timezone),
    String(current.business_hours_json),
    String(current.id),
    now,
    now,
    now,
  );
  await database.prepare(`
    INSERT INTO workflow_policy_nodes (
      id, policy_set_id, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
      escalation_minutes, max_reminders, reminder_interval_minutes,
      enabled_channels_json, fallback_order_json, template_bindings_json,
      escalation_level, quiet_hours_json, immutable_rules_json, sort_order
    )
    SELECT ? || ':' || node_code, ?, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
      escalation_minutes, max_reminders, reminder_interval_minutes,
      enabled_channels_json, fallback_order_json, template_bindings_json,
      escalation_level, quiet_hours_json, immutable_rules_json, sort_order
    FROM workflow_policy_nodes WHERE policy_set_id = ?
  `).run(nextId, nextId, String(current.id));
  for (const [nodeCode, templateCode] of needsUpgrade) {
    await database.prepare(`
      UPDATE workflow_policy_nodes SET template_bindings_json = ?
      WHERE policy_set_id = ? AND node_code = ?
    `).run(JSON.stringify(defaultTemplateBindings(templateCode)), nextId, nodeCode);
  }
  await database.prepare(`
    INSERT INTO workflow_release_events (
      id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
    ) VALUES (?, 'workflow_policy', ?, 'annual_inspection', ?, 'system-migration', 'published', ?, ?)
  `).run(
    randomUUID(),
    nextId,
    version,
    JSON.stringify({
      sourcePolicySetId: String(current.id),
      sourceVersion: Number(current.version),
      resourceName: `${String(current.name).replace(/（通知匹配升级）$/u, "")}（通知匹配升级）`,
      correctedNodes: needsUpgrade.map(([nodeCode]) => nodeCode),
      changeSummary: "为支付、派车、上门取车和送回留证分别绑定与动作一致的通知模板；业务状态机及计时配置保持不变",
    }),
    now,
  );
}

async function migrateOfficialWechatProviderBindings(
  database: AppDatabase,
  now: string,
): Promise<void> {
  for (const template of DEFAULT_WORKFLOW_TEMPLATES) {
    const binding = OFFICIAL_WECHAT_TEMPLATE_BINDINGS[template.code];
    if (!binding) continue;
    const current = await database.prepare<Row>(`
      SELECT * FROM notification_templates
      WHERE stable_code = ? AND channel = 'wechat' AND state = 'published' AND is_current = 1
      FOR UPDATE
    `).get(template.code);
    if (!current) continue;
    const providerSnapshot = {
      fieldMappings: [...binding.fieldMappings],
      contentSnapshot: binding.contentSnapshot,
    };
    const alreadyConfigured = String(current.provider_template_id ?? "") === binding.providerTemplateId
      && String(current.filing_status) === "configured"
      && String(current.allowed_variables_json) === JSON.stringify(template.allowedVariables)
      && String(current.provider_snapshot_json) === JSON.stringify(providerSnapshot);
    if (alreadyConfigured) continue;

    const maxVersion = await database.prepare<Row>(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM notification_templates
      WHERE stable_code = ? AND channel = 'wechat' AND state = 'published'
    `).get(template.code);
    const version = Number(maxVersion?.version ?? 0) + 1;
    const id = `workflow-template-${template.code.replaceAll(".", "-")}-wechat-v${version}`;
    await database.prepare(`
      UPDATE notification_templates SET is_current = 0, updated_at = ?
      WHERE id = ? AND is_current = 1
    `).run(now, String(current.id));
    await database.prepare(`
      INSERT INTO notification_templates (
        id, stable_code, name, node_code, channel, version, state, revision, is_current,
        title, body, button_text, action_code, allowed_variables_json, example_data_json,
        provider_template_id, provider_snapshot_json, filing_status,
        created_by, published_by, created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, 'wechat', ?, 'published', 1, 1,
        ?, ?, ?, ?, ?, ?, ?, ?, 'configured',
        'system-migration', 'system-migration', ?, ?, ?)
    `).run(
      id,
      template.code,
      String(current.name),
      String(current.node_code),
      version,
      String(current.title ?? ""),
      String(current.body),
      current.button_text == null ? null : String(current.button_text),
      String(current.action_code),
      JSON.stringify(template.allowedVariables),
      JSON.stringify(EXAMPLE_DATA),
      binding.providerTemplateId,
      JSON.stringify(providerSnapshot),
      now,
      now,
      now,
    );
    await database.prepare(`
      INSERT INTO workflow_release_events (
        id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
      ) VALUES (?, 'notification_template', ?, ?, ?, 'system-migration', 'published', ?, ?)
    `).run(
      randomUUID(),
      id,
      workflowTemplateDomain(template.code),
      version,
      JSON.stringify({
        sourceTemplateId: String(current.id),
        providerTemplateId: binding.providerTemplateId,
        changeSummary: `绑定微信订阅消息模板「${binding.contentSnapshot}」及字段映射`,
      }),
      now,
    );
  }
}

async function migrateOfficialWechatNotifyChannels(
  database: AppDatabase,
  now: string,
): Promise<void> {
  await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .get("workflow-policy-migration:annual.official-wechat-channels");
  const current = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_sets
    WHERE domain = 'annual_inspection' AND state = 'published' AND is_current = 1
    FOR UPDATE
  `).get();
  if (!current) return;

  const nodes = await database.prepare<Row>(`
    SELECT node_code, enabled_channels_json
    FROM workflow_policy_nodes
    WHERE policy_set_id = ? AND node_code = ANY(?::text[])
  `).all(String(current.id), [...WECHAT_CHANNEL_ENABLED_NODE_CODES]);
  const needsUpgrade = nodes.filter((row) => {
    try {
      const channels = JSON.parse(String(row.enabled_channels_json)) as unknown;
      return !Array.isArray(channels) || !channels.includes("wechat");
    } catch {
      return true;
    }
  });
  if (needsUpgrade.length === 0) return;

  const maxVersion = await database.prepare<Row>(`
    SELECT COALESCE(MAX(version), 0) AS version FROM workflow_policy_sets
    WHERE domain = 'annual_inspection' AND state = 'published'
  `).get();
  const version = Number(maxVersion?.version ?? 0) + 1;
  const nextId = `annual-workflow-v${version}-wechat-notify`;
  await database.prepare(`
    UPDATE workflow_policy_sets SET is_current = 0, updated_at = ?
    WHERE id = ? AND is_current = 1
  `).run(now, String(current.id));
  await database.prepare(`
    INSERT INTO workflow_policy_sets (
      id, domain, stable_code, name, state, version, revision, is_current,
      timezone, business_hours_json, source_policy_set_id, created_by,
      published_by, created_at, updated_at, published_at
    ) VALUES (?, 'annual_inspection', ?, ?, 'published', ?, 1, 1, ?, ?, ?,
      'system-migration', 'system-migration', ?, ?, ?)
  `).run(
    nextId,
    String(current.stable_code),
    `${String(current.name).replace(/（微信订阅启用）$/u, "")}（微信订阅启用）`,
    version,
    String(current.timezone),
    String(current.business_hours_json),
    String(current.id),
    now,
    now,
    now,
  );
  await database.prepare(`
    INSERT INTO workflow_policy_nodes (
      id, policy_set_id, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
      escalation_minutes, max_reminders, reminder_interval_minutes,
      enabled_channels_json, fallback_order_json, template_bindings_json,
      escalation_level, quiet_hours_json, immutable_rules_json, sort_order
    )
    SELECT ? || ':' || node_code, ?, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
      escalation_minutes, max_reminders, reminder_interval_minutes,
      enabled_channels_json, fallback_order_json, template_bindings_json,
      escalation_level, quiet_hours_json, immutable_rules_json, sort_order
    FROM workflow_policy_nodes WHERE policy_set_id = ?
  `).run(nextId, nextId, String(current.id));

  for (const nodeCode of WECHAT_CHANNEL_ENABLED_NODE_CODES) {
    const row = await database.prepare<Row>(`
      SELECT enabled_channels_json FROM workflow_policy_nodes
      WHERE policy_set_id = ? AND node_code = ?
    `).get(nextId, nodeCode);
    if (!row) continue;
    let channels: string[] = [];
    try {
      const parsed = JSON.parse(String(row.enabled_channels_json)) as unknown;
      channels = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      channels = ["in_app"];
    }
    if (!channels.includes("in_app")) channels.unshift("in_app");
    if (!channels.includes("wechat")) channels.push("wechat");
    await database.prepare(`
      UPDATE workflow_policy_nodes SET enabled_channels_json = ?
      WHERE policy_set_id = ? AND node_code = ?
    `).run(JSON.stringify(channels), nextId, nodeCode);
  }

  await database.prepare(`
    INSERT INTO workflow_release_events (
      id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
    ) VALUES (?, 'workflow_policy', ?, 'annual_inspection', ?, 'system-migration', 'published', ?, ?)
  `).run(
    randomUUID(),
    nextId,
    version,
    JSON.stringify({
      sourcePolicySetId: String(current.id),
      sourceVersion: Number(current.version),
      enabledNodes: [...WECHAT_CHANNEL_ENABLED_NODE_CODES],
      changeSummary: "为首批年检通知节点启用微信订阅消息渠道；站内待办保持不变",
    }),
    now,
  );
}

/**
 * The pickup task was added after the first published annual policy shipped.
 * Published policies are immutable, so an upgraded database receives a cloned
 * successor version rather than an in-place node insert. Existing entity
 * bindings keep pointing at the version they froze when the order was created.
 */
async function migrateAnnualDriverPickupPolicy(
  database: AppDatabase,
  now: string,
): Promise<void> {
  const pickupNode = DEFAULT_WORKFLOW_NODES.find((node) => node.code === "annual.pickup.driver");
  if (!pickupNode) throw new Error("Default driver pickup workflow node is missing");
  await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .get("workflow-policy-migration:annual.pickup.driver");

  const current = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_sets
    WHERE domain = 'annual_inspection' AND state = 'published' AND is_current = 1
    FOR UPDATE
  `).get();
  if (current) {
    const currentNode = await database.prepare<Row>(`
      SELECT 1 FROM workflow_policy_nodes
      WHERE policy_set_id = ? AND node_code = 'annual.pickup.driver'
    `).get(String(current.id));
    const pickupTemplate = await database.prepare<Row>(`
      SELECT published_at FROM notification_templates
      WHERE stable_code = 'annual.pickup.evidence.driver'
        AND channel = 'in_app' AND state = 'published' AND is_current = 1
    `).get();
    // During development, one hot-reload build briefly used the generic seed
    // loop and could append this node directly to an older system v1. Detect
    // that exact intermediate state by its later template publication time,
    // restore v1, and still publish an immutable successor.
    const directlySeededIntoLegacyV1 = Boolean(
      currentNode
      && String(current.id) === "annual-workflow-v1"
      && Number(current.version) === 1
      && String(current.created_by) === "system-seed"
      && pickupTemplate?.published_at
      && String(pickupTemplate.published_at) > String(current.published_at ?? current.created_at),
    );
    if (!currentNode || directlySeededIntoLegacyV1) {
      const maxVersion = await database.prepare<Row>(`
        SELECT COALESCE(MAX(version), 0) AS version FROM workflow_policy_sets
        WHERE domain = 'annual_inspection' AND state = 'published'
      `).get();
      const version = Number(maxVersion?.version ?? 0) + 1;
      const nextId = `annual-workflow-v${version}-driver-pickup`;
      await database.prepare(`
        UPDATE workflow_policy_sets SET is_current = 0, updated_at = ?
        WHERE id = ? AND is_current = 1
      `).run(now, String(current.id));
      await database.prepare(`
        INSERT INTO workflow_policy_sets (
          id, domain, stable_code, name, state, version, revision, is_current,
          timezone, business_hours_json, source_policy_set_id, created_by,
          published_by, created_at, updated_at, published_at
        ) VALUES (?, 'annual_inspection', ?, ?, 'published', ?, 1, 1, ?, ?, ?,
          'system-migration', 'system-migration', ?, ?, ?)
      `).run(
        nextId,
        String(current.stable_code),
        String(current.name),
        version,
        String(current.timezone),
        String(current.business_hours_json),
        String(current.id),
        now,
        now,
        now,
      );
      await database.prepare(`
        INSERT INTO workflow_policy_nodes (
          id, policy_set_id, node_code, node_name, workflow_variant, is_enabled,
          trigger_state, next_state, assignee_role, subject_scope, closure_action,
          task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
          escalation_minutes, max_reminders, reminder_interval_minutes,
          enabled_channels_json, fallback_order_json, template_bindings_json,
          escalation_level, quiet_hours_json, immutable_rules_json, sort_order
        )
        SELECT ? || ':' || node_code, ?, node_code, node_name, workflow_variant, is_enabled,
          trigger_state, next_state, assignee_role, subject_scope, closure_action,
          task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
          escalation_minutes, max_reminders, reminder_interval_minutes,
          enabled_channels_json, fallback_order_json, template_bindings_json,
          escalation_level, quiet_hours_json, immutable_rules_json, sort_order
        FROM workflow_policy_nodes WHERE policy_set_id = ? AND node_code <> 'annual.pickup.driver'
      `).run(nextId, nextId, String(current.id));
      const claimOrder = await database.prepare<Row>(`
        SELECT sort_order FROM workflow_policy_nodes
        WHERE policy_set_id = ? AND node_code = 'annual.driver.claim'
      `).get(nextId);
      await insertDefaultPolicyNode(
        database,
        nextId,
        pickupNode,
        Number(claimOrder?.sort_order ?? 60) + 5,
      );
      if (directlySeededIntoLegacyV1) {
        await database.prepare(`
          DELETE FROM workflow_policy_nodes
          WHERE policy_set_id = ? AND node_code = 'annual.pickup.driver'
        `).run(String(current.id));
      }
      await database.prepare(`
        INSERT INTO workflow_release_events (
          id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
        ) VALUES (?, 'workflow_policy', ?, 'annual_inspection', ?, 'system-migration', 'published', ?, ?)
      `).run(
        randomUUID(),
        nextId,
        version,
        JSON.stringify({
          sourcePolicySetId: String(current.id),
          sourceVersion: Number(current.version),
          restoredLegacyVersion: directlySeededIntoLegacyV1,
          changeSummary: "新增司机领取任务后的取车留证督办节点；历史订单继续使用冻结版本",
        }),
        now,
      );
    }
  }

  // A draft is mutable, but adding the new immutable business node changes its
  // revision so an already-open editor must refresh before it can save.
  const draft = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_sets
    WHERE domain = 'annual_inspection' AND state = 'draft'
    FOR UPDATE
  `).get();
  if (draft) {
    const draftNode = await database.prepare<Row>(`
      SELECT 1 FROM workflow_policy_nodes
      WHERE policy_set_id = ? AND node_code = 'annual.pickup.driver'
    `).get(String(draft.id));
    if (!draftNode) {
      const claimOrder = await database.prepare<Row>(`
        SELECT sort_order FROM workflow_policy_nodes
        WHERE policy_set_id = ? AND node_code = 'annual.driver.claim'
      `).get(String(draft.id));
      await insertDefaultPolicyNode(
        database,
        String(draft.id),
        pickupNode,
        Number(claimOrder?.sort_order ?? 60) + 5,
      );
      await database.prepare(`
        UPDATE workflow_policy_sets SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND state = 'draft'
      `).run(now, String(draft.id));
    }
  }
}

export async function seedDefaultWorkflowConfiguration(
  database: AppDatabase,
  options: SeedWorkflowOptions = {},
): Promise<void> {
  const now = (options.now ?? new Date()).toISOString();
  const actor = options.actor?.trim() || "system-seed";
  await database.transaction(async (transaction) => {
    for (const template of DEFAULT_WORKFLOW_TEMPLATES) {
      await seedTemplateChannel(transaction, template, "in_app", now, actor);
      await seedTemplateChannel(transaction, template, "sms", now, actor);
      await seedTemplateChannel(transaction, template, "wechat", now, actor);
    }
    // Published templates are immutable. Legacy routing metadata is corrected
    // by publishing a successor version instead of editing v1 in place.
    await migrateLegacyReportReadyTemplates(transaction, now);
    await migrateLegacyPrecheckTemplateActions(transaction, now);
    await migrateLegacyInspectionReportTemplateCopy(transaction, now);
    await migrateOfficialWechatProviderBindings(transaction, now);

    for (const domain of WORKFLOW_DOMAINS) {
      const policyId = domain === "annual_inspection" ? "annual-workflow-v1" : "repair-workflow-v1";
      const policyName = domain === "annual_inspection" ? "年检履约督办默认策略" : "维修报价督办默认策略";
      const policyAlreadyExisted = Boolean(await transaction.prepare<Row>(`
        SELECT 1 FROM workflow_policy_sets WHERE id = ?
      `).get(policyId));
      await transaction.prepare(`
        INSERT INTO workflow_policy_sets (
          id, domain, stable_code, name, state, version, revision, is_current,
          timezone, business_hours_json, source_policy_set_id,
          created_by, published_by, created_at, updated_at, published_at
        ) VALUES (?, ?, ?, ?, 'published', 1, 1, 1, 'Asia/Shanghai', ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING
      `).run(
        policyId,
        domain,
        domain === "annual_inspection" ? "annual-workflow" : "repair-workflow",
        policyName,
        JSON.stringify({ weekdays: [1, 2, 3, 4, 5, 6], start: "08:00", end: "18:00", holidays: [] }),
        actor,
        actor,
        now,
        now,
        now,
      );

      const nodes = DEFAULT_WORKFLOW_NODES.filter((node) => node.domain === domain);
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        // The new pickup node must not be inserted into a historical published
        // v1 in place. The migration below clones the current policy instead.
        if (policyAlreadyExisted && node.code === "annual.pickup.driver") continue;
        await insertDefaultPolicyNode(transaction, policyId, node, (index + 1) * 10);
      }
      const publishedPolicy = await transaction.prepare<Row>(`
        SELECT name, stable_code, version, published_by, published_at, created_by, created_at
        FROM workflow_policy_sets WHERE id = ? AND state = 'published'
      `).get(policyId);
      if (publishedPolicy) {
        await ensureBootstrapReleaseEvent(transaction, {
          resourceType: "workflow_policy",
          resourceId: policyId,
          domain,
          version: Number(publishedPolicy.version),
          actor: String(publishedPolicy.published_by ?? publishedPolicy.created_by ?? actor),
          occurredAt: String(publishedPolicy.published_at ?? publishedPolicy.created_at ?? now),
          summary: {
            stableCode: String(publishedPolicy.stable_code),
            resourceName: String(publishedPolicy.name),
            changeSummary: "系统初始化默认督办策略",
          },
        });
      }
    }
    for (const domain of WORKFLOW_DOMAINS) {
      await migrateLegacyWorkflowPolicyDefaults(transaction, domain, now);
    }
    await migrateAnnualDriverPickupPolicy(transaction, now);
    await migrateAnnualTemplateSemanticBindings(transaction, now);
    await migrateOfficialWechatNotifyChannels(transaction, now);
  });
}

export async function workflowSeedSummary(database: AppDatabase): Promise<{ policies: number; nodes: number; templates: number }> {
  const row = await database.prepare<Row>(`
    SELECT
      (SELECT COUNT(*) FROM workflow_policy_sets WHERE state = 'published') AS policies,
      (SELECT COUNT(*) FROM workflow_policy_nodes) AS nodes,
      (SELECT COUNT(*) FROM notification_templates WHERE state = 'published') AS templates
  `).get();
  return {
    policies: Number(row?.policies ?? 0),
    nodes: Number(row?.nodes ?? 0),
    templates: Number(row?.templates ?? 0),
  };
}

export async function clearWorkflowData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM workflow_test_sms_limits;
    DELETE FROM notification_delivery_attempts;
    DELETE FROM notification_outbox;
    DELETE FROM notification_inbox;
    DELETE FROM workflow_task_events;
    DELETE FROM workflow_tasks;
    DELETE FROM workflow_entity_bindings;
    DELETE FROM workflow_release_events;
    DELETE FROM workflow_notification_recipients;
    DELETE FROM wechat_subscription_authorizations;
    DELETE FROM workflow_policy_nodes;
    DELETE FROM workflow_policy_sets;
    DELETE FROM notification_templates;
  `);
}

/** Clears demo/runtime delivery state without deleting administrator configuration or release audit. */
export async function clearWorkflowRuntimeData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM workflow_test_sms_limits;
    DELETE FROM notification_delivery_attempts;
    DELETE FROM notification_outbox;
    DELETE FROM notification_inbox;
    DELETE FROM workflow_task_events;
    DELETE FROM workflow_tasks;
    DELETE FROM workflow_entity_bindings;
    DELETE FROM wechat_subscription_authorizations;
  `);
}

export function newWorkflowId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
