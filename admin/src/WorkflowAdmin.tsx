import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alarm,
  ArrowClockwise,
  Bell,
  BellRinging,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  Copy,
  Eye,
  FloppyDisk,
  Gear,
  ListChecks,
  LockKey,
  MagnifyingGlass,
  PaperPlaneTilt,
  Phone,
  Plus,
  ShieldCheck,
  Siren,
  Trash,
  UserCircle,
  Users,
  Warning,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api } from "./adminApi";
import "./workflow.css";

export type WorkflowAdminSection = "tasks" | "settings" | "templates" | "recipients" | "releases";

type WorkflowDomain = "annual_inspection" | "repair_quote";
type WorkflowTaskStatus = "open" | "pending" | "reminded" | "overdue" | "escalated" | "closed" | "completed" | "cancelled";
type WorkflowUrgency = "normal" | "due_soon" | "overdue" | "escalated";
type WorkflowChannel = "in_app" | "wechat" | "sms";
type ClockBasis = "business" | "natural";
type PolicyFlow = "annual_self_drive" | "annual_valet" | "repair_quote";

type WorkflowSummary = {
  pending: number;
  dueSoon: number;
  overdue: number;
  escalated: number;
  deliveryFailed: number;
  updatedAt?: string | null;
};

type WorkflowTask = {
  id: string;
  domain: WorkflowDomain | string;
  nodeCode: string;
  title: string;
  businessCode: string;
  subjectName: string;
  responsibleRole: string;
  responsibleLabel: string;
  status: WorkflowTaskStatus | string;
  urgency: WorkflowUrgency;
  createdAt: string;
  firstReminderAt?: string | null;
  deadlineAt?: string | null;
  escalationAt?: string | null;
  completedAt?: string | null;
  nextActionLabel?: string | null;
  policyVersion?: string | null;
  lastReminderAt?: string | null;
  nextManualReminderAt?: string | null;
  reminderCount?: number;
  deliveryState?: string | null;
  taskCenterVisible?: boolean;
  inAppSupervisionMode?: "task_center" | "owner_inbox" | "none";
  actionCode?: string | null;
  events?: Array<{ id?: string; type: string; label?: string; createdAt: string; detail?: string }>;
};

type TemplateOption = {
  id?: string;
  code: string;
  name: string;
  channel: WorkflowChannel;
  publishedVersion?: number | null;
  status?: string;
  title?: string;
  preview?: string;
};

type PolicyNode = {
  id?: string;
  flow: PolicyFlow;
  workflowVariant?: "all" | "self_drive" | "valet" | "repair";
  nodeCode: string;
  name: string;
  description?: string;
  enabled: boolean;
  clockBasis: ClockBasis;
  firstReminderMinutes: number | null;
  deadlineMinutes: number | null;
  escalationMinutes: number | null;
  maxReminders: number;
  reminderIntervalMinutes: number | null;
  channels: WorkflowChannel[];
  fallbackOrder: WorkflowChannel[];
  templateBindings: Partial<Record<WorkflowChannel, string>>;
  escalationLevel: string;
  quietHours?: { start: string; end: string } | null;
  triggerStatus: string;
  nextStatus: string;
  responsibleRole: string;
  responsibleScope: string;
  closeAction: string;
  taskKind: "blocking" | "soft" | "information";
  protectedRules?: string[];
};

type WorkflowPolicy = {
  id?: string;
  code: string;
  domain: WorkflowDomain;
  name: string;
  businessHours: { weekdays: number[]; start: string; end: string; holidays?: string[] };
  version?: number | null;
  status: "draft" | "published" | string;
  revision: number;
  updatedAt?: string | null;
  updatedBy?: string | null;
  publishedAt?: string | null;
  publishedBy?: string | null;
  nodes: PolicyNode[];
};

type PolicyValidation = {
  valid: boolean;
  errors: Array<{ nodeCode?: string; field?: string; message: string }>;
  warnings: Array<{ nodeCode?: string; field?: string; message: string }>;
};

type PolicyPreview = {
  policyVersion?: number | null;
  generatedAt?: string;
  rows: Array<{
    nodeCode: string;
    nodeName: string;
    firstReminderText: string;
    deadlineText: string;
    escalationText: string;
    channelsText: string;
    templateText: string;
  }>;
};

type NotificationTemplate = {
  id?: string;
  code: string;
  selectionKey: string;
  name: string;
  nodeCodes: string[];
  channel: WorkflowChannel;
  status: string;
  currentVersion?: number | null;
  draftRevision?: number | null;
  title: string;
  body: string;
  buttonText?: string;
  actionCode?: string;
  allowedVariables: string[];
  selectedVariables: string[];
  exampleData: Record<string, string>;
  renderedTitle?: string;
  renderedBody?: string;
  characterCount?: number;
  estimatedSegments?: number;
  providerTemplateIdMasked?: string;
  providerTemplateId?: string | null;
  providerSnapshot?: Record<string, unknown>;
  providerStatus?: string;
  wechatTemplateIdMasked?: string;
  wechatContentSnapshot?: string;
  fieldMappings?: Array<{ field: string; variable: string }>;
  usedBy?: Array<{ policyCode: string; policyVersion: number; nodeCode: string }>;
  history?: Array<{ version: number; publishedAt: string; publishedBy: string; status: string }>;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

type NotificationRecipient = {
  id: string;
  kind: "station" | "repair_shop" | "platform_duty" | string;
  recipientType?: "service_subject" | "platform_duty" | string;
  subjectType?: "inspection_station" | "repair_shop" | null;
  subjectId?: string | null;
  subjectName: string;
  contactName: string;
  mobileMasked?: string | null;
  mobile?: string | null;
  enabled: boolean;
  dutyStart?: string | null;
  dutyEnd?: string | null;
  updatedAt?: string | null;
  warnings?: string[];
};

type IntegrationStatus = {
  smsbao: { configured: boolean; enabled: boolean; accountMasked?: string | null; signatureMasked?: string | null; usableTemplates?: number; note?: string };
  wechat: { configured: boolean; enabled: boolean; approvedTemplates?: number; note?: string };
};

type WorkflowRelease = {
  id: string;
  kind: "policy" | "template" | string;
  code: string;
  name: string;
  version: number;
  domain?: string | null;
  status: string;
  publishedAt: string;
  publishedBy: string;
  changeSummary?: string | null;
  validationWarnings?: number;
  rollbackSourceVersion?: number | null;
};

type WorkflowAdminProps = {
  section: WorkflowAdminSection;
  onNavigate?: (path: string) => void;
  onError: (message: string) => void;
  canManage?: boolean;
  canRemind?: boolean;
  viewerRole?: string;
};

const workflowPaths: Record<WorkflowAdminSection, string> = {
  tasks: "/workflow",
  settings: "/workflow/settings",
  templates: "/workflow/templates",
  recipients: "/workflow/recipients",
  releases: "/workflow/releases",
};

const sectionLabels: Record<WorkflowAdminSection, string> = {
  tasks: "履约督办",
  settings: "督办策略",
  templates: "通知模板",
  recipients: "通知联系人",
  releases: "发布记录",
};

const sectionIcons = {
  tasks: Siren,
  settings: Gear,
  templates: Bell,
  recipients: Users,
  releases: ListChecks,
} satisfies Record<WorkflowAdminSection, typeof Siren>;

const channelLabels: Record<WorkflowChannel, string> = { in_app: "站内", wechat: "微信", sms: "短信" };
const urgencyLabels: Record<WorkflowUrgency, string> = { normal: "处理中", due_soon: "即将超时", overdue: "已超时", escalated: "已升级" };
const statusLabels: Record<string, string> = {
  open: "待处理",
  pending: "待处理",
  reminded: "已提醒",
  overdue: "已超时",
  escalated: "已升级",
  completed: "已完成",
  cancelled: "已关闭",
  closed: "已关闭",
};
const roleLabels: Record<string, string> = {
  owner: "车主",
  station: "检测站",
  // 兼容旧接口返回的主体类型；筛选项统一使用工作流角色 station。
  inspection_station: "检测站",
  driver: "代驾司机",
  repair_shop: "维修店",
  platform: "平台值班组",
};
const roleFilterOptions = [
  { value: "owner", label: "车主" },
  { value: "station", label: "检测站" },
  { value: "driver", label: "代驾司机" },
  { value: "repair_shop", label: "维修店" },
  { value: "platform", label: "平台值班组" },
] as const;
const domainLabels: Record<string, string> = { annual_inspection: "年检", repair_quote: "维修报价" };
const flowLabels: Record<PolicyFlow, string> = { annual_self_drive: "自驾年检", annual_valet: "代驾年检", repair_quote: "维修报价" };
const nodeLabels: Record<string, string> = {
  "annual.pending_payment": "等待车主支付",
  "annual.precheck.pending": "预约资料待预检",
  "annual.precheck.action_required": "车主处理预检问题",
  "annual.arrival.owner": "车主按时到站",
  "annual.driver.assign": "平台安排代驾司机",
  "annual.driver.claim": "司机领取代驾任务",
  "annual.pickup.driver": "司机完成取车留证",
  "annual.pickup.owner": "代驾上门取车提醒",
  "annual.station.arrival": "检测站接车交接",
  "annual.inspection.report": "检测并发布报告",
  "annual.return.driver": "报告发布后开始送回",
  "annual.return.delivery": "车辆送达留证",
  "annual.service.completed": "服务完成通知",
  "repair.request.opportunity": "维修店新报价机会",
  "repair.quote.first": "维修需求等待首份报价",
  "repair.quote.owner_action": "车主查看首份报价",
  "repair.order.selected": "中选维修店通知",
  "workflow.exception": "平台异常处理",
};
const workflowStateLabels: Record<string, string> = {
  pending_payment: "待支付",
  pending_precheck: "待资料预检",
  precheck_action_required: "待车主补充资料",
  awaiting_arrival: "待到站",
  confirmed: "预约已确认",
  driver_arranged: "司机已安排",
  picked_up: "车辆已取走",
  checked_in: "车辆已到站",
  inspecting: "检测中",
  result_received: "检测结果已回传",
  returning: "车辆送回中",
  completed: "已完成",
  open: "进行中",
  open_no_quotes: "等待首份报价",
  open_with_quotes: "已有报价待选择",
  paid: "已支付",
  cancelled: "已取消",
  exception: "履约异常",
};
const subjectScopeLabels: Record<string, string> = {
  "booking.owner": "本订单车主",
  "booking.station": "本订单检测站",
  "booking.assigned_driver": "本订单已安排司机",
  "platform.duty_group": "平台当班值班组",
  "one.active_repair_shop": "一家可接单维修店",
  "all.active_repair_shops": "全部可接单维修店",
  "repair.owner": "本维修需求车主",
  "repair.selected_shop": "车主选中的维修店",
};
const closeActionLabels: Record<string, string> = {
  "booking.mock_payment_confirmed": "车主完成支付",
  "booking.precheck.approved_or_action_required": "检测站完成预检并给出结果",
  "booking.precheck.resubmitted_or_owner_cancelled": "车主重新提交资料或取消订单",
  "booking.station_checked_in": "检测站确认车辆到站",
  "booking.driver_assigned": "平台完成司机安排",
  "driver.task_redeemed": "司机领取任务",
  "driver.pickup_evidence_completed": "司机完成取车留证",
  "station.arrival_evidence_completed": "检测站完成接车留证",
  "inspection.started": "检测站开始检测",
  "inspection.report_published": "检测站发布检测报告",
  "notification.acknowledged": "通知成功生成",
  "driver.return_started": "司机开始送回车辆",
  "driver.delivery_evidence_completed": "司机完成送回留证",
  "repair.first_quote_submitted_or_request_closed": "维修店提交首份报价或需求关闭",
  "repair.first_quote_submitted": "任一维修店提交首份报价",
  "repair.quote_selected_or_request_cancelled": "车主选定报价或取消需求",
  "workflow.exception_resolved": "平台记录异常处理结果",
};
const protectedRuleLabels: Record<string, string> = {
  prohibitedAutomation: "禁止提醒系统代替支付、预检、报告发布、退款或选店",
  pay: "不得自动替车主支付",
  approve_precheck: "不得自动通过资料预检",
  publish_report: "不得自动发布检测报告",
  refund: "不得自动发起退款",
  select_repair_shop: "不得自动替车主选择维修店",
};
const providerStatusLabels: Record<string, string> = {
  approved: "已通过报备",
  pending: "审核中",
  rejected: "已驳回",
  unreported: "未报备",
  unconfigured: "未配置",
  not_required: "无需报备",
  draft: "草稿",
  published: "已发布",
  active: "生效中",
  disabled: "已停用",
};
const releaseStatusLabels: Record<string, string> = {
  published: "已发布",
  publish: "已发布",
  restored: "已恢复为新版本",
  rollback: "已恢复为新版本",
  created: "已创建",
  updated: "已更新",
};
const deliveryStateLabels: Record<string, string> = {
  pending: "等待投递",
  queued: "已进入发送队列",
  processing: "发送中",
  accepted: "供应商已受理",
  accepted_not_delivered: "供应商已受理，尚未确认送达",
  delivered: "已送达",
  failed: "发送失败",
  dead_letter: "多次发送失败，已转平台处理",
  skipped: "无需发送",
};
const eventTypeLabels: Record<string, string> = {
  created: "任务已创建",
  reminded: "已发起提醒",
  task_center_reminder: "任务中心站内督办已生效",
  notification_skipped: "未发送额外通知",
  overdue: "任务已超时",
  escalated: "已升级平台处理",
  closed: "任务已关闭",
  completed: "任务已完成",
  resolved: "异常已处理",
  delivery_queued: "通知已进入发送队列",
  delivery_failed: "通知发送失败",
};
const actionLabels: Record<string, string> = {
  none: "不跳转",
  "annual.order.detail": "打开年检订单详情",
  "annual.report.detail": "打开车辆检测报告",
  "repair.request.detail": "打开维修需求详情",
  "repair.quotes": "打开维修报价列表",
  "operator.booking.detail": "打开检测站预约详情",
  "operator.precheck.detail": "打开资料预检详情",
  "repair.shop.request.detail": "打开维修店报价详情",
  "driver.task.detail": "打开司机任务详情",
  "workflow.task.detail": "打开平台督办任务",
};
const variableLabels: Record<string, string> = {
  maskedPlate: "脱敏车牌",
  appointmentTime: "预约时间",
  stationName: "检测站名称",
  pendingCount: "待办数量",
  overdueCount: "超时数量",
  reportConclusion: "报告结论",
  remainingTime: "剩余时间",
  maskedBusinessCode: "脱敏业务编号",
  verificationCode: "司机验证码",
};
const actionOptions = [
  "annual.order.detail",
  "annual.report.detail",
  "repair.request.detail",
  "repair.quotes",
  "operator.booking.detail",
  "operator.precheck.detail",
  "repair.shop.request.detail",
  "driver.task.detail",
  "workflow.task.detail",
];

function versionLabel(value?: number | null) {
  return value == null ? "未发布" : `第${value}版`;
}

function actorLabel(value?: string | null) {
  if (!value) return "平台管理员";
  if (/system[-_ ]?seed|platform[-_ ]?admin|^admin$/iu.test(value)) return "平台管理员";
  if (/[\u3400-\u9fff]/u.test(value)) return value.replace(/[A-Za-z][A-Za-z0-9_.:/-]*/gu, "");
  return "平台管理员";
}

function technicalStatusLabel(value?: string | null) {
  if (!value) return "未设置";
  return providerStatusLabels[value] || releaseStatusLabels[value] || statusLabels[value] || "系统状态";
}

function workflowStateLabel(value?: string | null) {
  if (!value) return "由合法业务动作决定";
  return value.split("|").map((item) => workflowStateLabels[item] || "其他业务状态").join(" 或 ");
}

function safeOperationalMessage(value: string, fallback = "系统配置需要检查") {
  let text = value;
  const replacements: Record<string, string> = {
    firstReminderMinutes: "首次提醒时间",
    deadlineMinutes: "截止时间",
    escalationMinutes: "升级时间",
    reminderIntervalMinutes: "重复提醒间隔",
    enabledChannels: "通知渠道",
    templateBindings: "模板绑定",
    in_app: "站内通知",
    wechat: "微信通知",
    sms: "短信通知",
  };
  Object.entries(replacements).forEach(([source, target]) => { text = text.replaceAll(source, target); });
  return /[A-Za-z]/u.test(text) ? fallback : text;
}

function templateTextForOperator(value: string) {
  return value.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu, (_match, variable: string) => `{{${variableLabels[variable] || "业务数据"}}}`);
}

function templateTextForStorage(value: string) {
  const reverse = Object.fromEntries(Object.entries(variableLabels).map(([key, label]) => [label, key]));
  return value.replace(/\{\{\s*([^{}]+)\s*\}\}/gu, (match, label: string) => reverse[label.trim()] ? `{{${reverse[label.trim()]}}}` : match);
}

function variableLabel(value: string) {
  return variableLabels[value] || "业务数据";
}

function providerSnapshotSummary(snapshot?: Record<string, unknown>) {
  if (!snapshot || !Object.keys(snapshot).length) return "微信后台模板尚未同步";
  const candidates = [snapshot.content, snapshot.templateContent, snapshot.title, snapshot.description];
  const visible = candidates.find((item) => typeof item === "string" && /[\u3400-\u9fff]/u.test(item));
  return typeof visible === "string" ? safeOperationalMessage(visible, "审批模板内容已同步") : "审批模板内容已同步";
}

const emptySummary: WorkflowSummary = { pending: 0, dueSoon: 0, overdue: 0, escalated: 0, deliveryFailed: 0 };
const emptyValidation: PolicyValidation = { valid: false, errors: [], warnings: [] };
const emptyIntegrationStatus: IntegrationStatus = {
  smsbao: { configured: false, enabled: false },
  wechat: { configured: false, enabled: false },
};

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待核对";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

function durationText(target?: string | null, now = Date.now()) {
  if (!target) return "未设置";
  const delta = new Date(target).getTime() - now;
  if (!Number.isFinite(delta)) return "时间异常";
  const absoluteMinutes = Math.max(0, Math.ceil(Math.abs(delta) / 60_000));
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  const value = hours ? `${hours}小时${minutes ? `${minutes}分` : ""}` : `${minutes}分钟`;
  return delta < 0 ? `已超时 ${value}` : `剩余 ${value}`;
}

function minuteText(value: number | null, basis?: ClockBasis) {
  if (value == null) return "不设置";
  if (value < 60) return `${value}${basis === "business" ? "个营业" : ""}分钟`;
  const hours = value / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}${basis === "business" ? "个营业" : ""}小时`;
}

function clonePolicy(policy: WorkflowPolicy): WorkflowPolicy {
  return JSON.parse(JSON.stringify(policy)) as WorkflowPolicy;
}

function safeItems<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) return (value as { items: T[] }).items;
  if (value && typeof value === "object" && Array.isArray((value as { tasks?: unknown }).tasks)) return (value as { tasks: T[] }).tasks;
  return [];
}

type UnknownRecord = Record<string, unknown>;

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value: unknown): number | null {
  return value == null || value === "" ? null : numberValue(value);
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function workflowFlow(variant: string, domain: string): PolicyFlow {
  if (domain === "repair_quote" || variant === "repair") return "repair_quote";
  return variant === "valet" ? "annual_valet" : "annual_self_drive";
}

function normalizePolicyNode(value: unknown, domain: WorkflowDomain): PolicyNode {
  const row = recordValue(value);
  const immutable = recordValue(row.immutable);
  const nodeCode = stringValue(row.nodeCode);
  const variant = stringValue(row.workflowVariant ?? row.workflow_variant, domain === "repair_quote" ? "repair" : "all") as PolicyNode["workflowVariant"];
  const quietHoursValue = recordValue(row.quietHours);
  const protectedRules = recordValue(immutable.rules);
  return {
    id: stringValue(row.id) || undefined,
    flow: workflowFlow(variant || "all", domain),
    workflowVariant: variant,
    nodeCode,
    name: stringValue(row.name, nodeLabels[nodeCode] || "业务节点"),
    description: stringValue(row.description),
    enabled: row.isEnabled == null ? row.enabled !== false : Boolean(row.isEnabled),
    clockBasis: stringValue(row.timerMode ?? row.clockBasis, "natural") as ClockBasis,
    firstReminderMinutes: nullableNumber(row.firstReminderMinutes),
    deadlineMinutes: nullableNumber(row.deadlineMinutes),
    escalationMinutes: nullableNumber(row.escalationMinutes),
    maxReminders: numberValue(row.maxReminders),
    reminderIntervalMinutes: nullableNumber(row.reminderIntervalMinutes),
    channels: stringValues(row.enabledChannels ?? row.channels) as WorkflowChannel[],
    fallbackOrder: stringValues(row.fallbackOrder) as WorkflowChannel[],
    templateBindings: recordValue(row.templateBindings) as Partial<Record<WorkflowChannel, string>>,
    escalationLevel: stringValue(row.escalationLevel, "none"),
    quietHours: Object.keys(quietHoursValue).length ? { start: stringValue(quietHoursValue.start, "22:00"), end: stringValue(quietHoursValue.end, "08:00") } : null,
    triggerStatus: stringValue(immutable.triggerState ?? row.triggerStatus),
    nextStatus: stringValue(immutable.nextState ?? row.nextStatus),
    responsibleRole: stringValue(immutable.assigneeRole ?? row.responsibleRole),
    responsibleScope: stringValue(immutable.subjectScope ?? row.responsibleScope),
    closeAction: stringValue(immutable.closureAction ?? row.closeAction),
    taskKind: stringValue(immutable.taskKind ?? row.taskKind, "soft") as PolicyNode["taskKind"],
    protectedRules: Array.isArray(immutable.rules)
      ? stringValues(immutable.rules)
      : Object.entries(protectedRules).filter(([, enabled]) => Boolean(enabled)).map(([key]) => key),
  };
}

function normalizePolicy(value: unknown, fallbackDomain: WorkflowDomain): WorkflowPolicy | null {
  if (!value) return null;
  const row = recordValue(value);
  const domain = stringValue(row.domain, fallbackDomain) as WorkflowDomain;
  const businessHours = recordValue(row.businessHours);
  return {
    id: stringValue(row.id) || undefined,
    code: stringValue(row.stableCode ?? row.code, domain === "annual_inspection" ? "annual-workflow" : "repair-workflow"),
    domain,
    name: stringValue(row.name, domainLabels[domain] || domain),
    businessHours: {
      weekdays: Array.isArray(businessHours.weekdays) ? businessHours.weekdays.map((item) => numberValue(item)).filter((item) => item >= 0 && item <= 6) : [1, 2, 3, 4, 5, 6],
      start: stringValue(businessHours.start, "08:00"),
      end: stringValue(businessHours.end, "18:00"),
      holidays: stringValues(businessHours.holidays),
    },
    version: row.version == null ? null : numberValue(row.version),
    status: stringValue(row.state ?? row.status, "draft"),
    revision: numberValue(row.revision),
    updatedAt: stringValue(row.updatedAt) || null,
    updatedBy: stringValue(row.updatedBy ?? row.createdBy) || null,
    publishedAt: stringValue(row.publishedAt) || null,
    publishedBy: stringValue(row.publishedBy) || null,
    nodes: safeItems<unknown>(row.nodes).map((node) => normalizePolicyNode(node, domain)),
  };
}

function policyNodePayload(node: PolicyNode) {
  return {
    nodeCode: node.nodeCode,
    isEnabled: node.enabled,
    timerMode: node.clockBasis,
    firstReminderMinutes: node.firstReminderMinutes,
    deadlineMinutes: node.deadlineMinutes,
    escalationMinutes: node.escalationMinutes,
    maxReminders: node.maxReminders,
    reminderIntervalMinutes: node.reminderIntervalMinutes,
    enabledChannels: node.channels,
    fallbackOrder: node.fallbackOrder.filter((channel) => channel !== "in_app"),
    templateBindings: node.templateBindings,
    escalationLevel: node.escalationLevel,
    quietHours: node.quietHours ?? {},
  };
}

function normalizeWorkflowTask(value: unknown): WorkflowTask {
  const row = recordValue(value);
  const metadata = recordValue(row.metadata);
  const subject = recordValue(row.subject);
  const policy = recordValue(row.policy);
  const assigneeRole = stringValue(row.assigneeRole ?? row.responsibleRole);
  const nodeCode = stringValue(row.nodeCode);
  const entityId = stringValue(row.entityId);
  return {
    id: stringValue(row.id),
    domain: stringValue(row.domain),
    nodeCode,
    title: safeOperationalMessage(stringValue(metadata.title ?? metadata.nodeName ?? row.title, nodeLabels[nodeCode] || "业务节点待处理"), nodeLabels[nodeCode] || "业务节点待处理"),
    businessCode: stringValue(metadata.maskedBusinessCode ?? metadata.businessCode ?? row.businessCode, entityId ? `…${entityId.slice(-8)}` : "业务编号待补全"),
    subjectName: stringValue(
      metadata.subjectName ?? metadata.stationName ?? row.subjectName,
      assigneeRole === "platform" ? "平台值班组（联系人未配置）" : "责任主体待补全",
    ),
    responsibleRole: assigneeRole,
    responsibleLabel: safeOperationalMessage(stringValue(metadata.responsibleLabel ?? row.responsibleLabel, roleLabels[assigneeRole] || "责任方"), roleLabels[assigneeRole] || "责任方"),
    status: stringValue(row.status, "open"),
    urgency: stringValue(row.urgency, "normal") as WorkflowUrgency,
    createdAt: stringValue(row.createdAt),
    firstReminderAt: stringValue(row.firstReminderAt) || null,
    deadlineAt: stringValue(row.dueAt ?? row.deadlineAt) || null,
    escalationAt: stringValue(row.escalateAt ?? row.escalationAt) || null,
    completedAt: stringValue(row.closedAt ?? row.completedAt) || null,
    nextActionLabel: stringValue(metadata.nextActionLabel ?? metadata.closureLabel ?? row.nextActionLabel) || null,
    policyVersion: policy.version == null ? (stringValue(row.policyVersion) ? "已冻结" : null) : versionLabel(numberValue(policy.version)),
    lastReminderAt: stringValue(row.lastRemindedAt ?? row.lastReminderAt) || null,
    nextManualReminderAt: stringValue(row.nextManualReminderAt) || null,
    reminderCount: numberValue(row.reminderCount),
    deliveryState: stringValue(metadata.deliveryState ?? row.deliveryState) || null,
    taskCenterVisible: row.taskCenterVisible === true,
    inAppSupervisionMode: (["task_center", "owner_inbox", "none"] as const).includes(
      stringValue(row.inAppSupervisionMode) as "task_center" | "owner_inbox" | "none",
    ) ? stringValue(row.inAppSupervisionMode) as "task_center" | "owner_inbox" | "none" : "none",
    actionCode: stringValue(metadata.actionCode ?? row.actionCode) || null,
    events: Array.isArray(row.events) ? row.events as WorkflowTask["events"] : undefined,
  };
}

function maskedProviderId(value: unknown) {
  const text = stringValue(value);
  if (!text) return "";
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function normalizeTemplateRows(value: unknown): NotificationTemplate[] {
  const rows = safeItems<unknown>(value).map(recordValue);
  const groups = new Map<string, UnknownRecord[]>();
  rows.forEach((row) => {
    const stableCode = stringValue(row.stableCode ?? row.code);
    const channel = stringValue(row.channel, "in_app");
    const key = `${stableCode}:${channel}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  return [...groups.entries()].map(([selectionKey, group]) => {
    const draft = group.find((row) => stringValue(row.state ?? row.status) === "draft");
    const current = group.find((row) => Boolean(row.isCurrent)) ?? group.find((row) => stringValue(row.state ?? row.status) === "published");
    const row = draft ?? current ?? group[0];
    const stableCode = stringValue(row.stableCode ?? row.code);
    const channel = stringValue(row.channel, "in_app") as WorkflowChannel;
    const example = recordValue(row.exampleData);
    const providerSnapshot = recordValue(row.providerSnapshot);
    const fieldMappingsValue = providerSnapshot.fieldMappings;
    const allowedVariables = stringValues(row.allowedVariables);
    return {
      id: stringValue(current?.id ?? row.id),
      code: stableCode,
      selectionKey,
      name: stringValue(row.name, stableCode),
      nodeCodes: stringValues(row.nodeCodes).length ? stringValues(row.nodeCodes) : [stringValue(row.nodeCode)].filter(Boolean),
      channel,
      status: stringValue(row.state ?? row.status, "published"),
      currentVersion: current?.version == null ? null : numberValue(current.version),
      draftRevision: draft ? numberValue(draft.revision) : 0,
      title: stringValue(row.title),
      body: stringValue(row.body),
      buttonText: stringValue(row.buttonText),
      actionCode: stringValue(row.actionCode, "none"),
      allowedVariables,
      selectedVariables: allowedVariables,
      exampleData: Object.fromEntries(Object.entries(example).map(([key, item]) => [key, stringValue(item)])),
      renderedTitle: stringValue(row.renderedTitle),
      renderedBody: stringValue(row.renderedPreview ?? row.renderedBody),
      characterCount: numberValue(row.characterCount, stringValue(row.body).length),
      estimatedSegments: row.smsSegments == null ? undefined : numberValue(row.smsSegments),
      providerTemplateIdMasked: channel === "sms" ? maskedProviderId(row.providerTemplateId) : undefined,
      providerTemplateId: stringValue(row.providerTemplateId) || null,
      providerSnapshot,
      providerStatus: stringValue(row.filingStatus ?? row.providerStatus),
      wechatTemplateIdMasked: channel === "wechat" ? maskedProviderId(row.providerTemplateId) : undefined,
      wechatContentSnapshot: channel === "wechat" && Object.keys(providerSnapshot).length ? JSON.stringify(providerSnapshot, null, 2) : undefined,
      fieldMappings: Array.isArray(fieldMappingsValue) ? fieldMappingsValue as Array<{ field: string; variable: string }> : [],
      updatedAt: stringValue(row.updatedAt) || null,
      updatedBy: stringValue(row.updatedBy ?? row.createdBy) || null,
      history: group.filter((item) => stringValue(item.state) === "published" && item.version != null).map((item) => ({ version: numberValue(item.version), publishedAt: stringValue(item.publishedAt), publishedBy: stringValue(item.publishedBy), status: stringValue(item.state) })).sort((left, right) => right.version - left.version),
    };
  }).sort((left, right) => left.code.localeCompare(right.code, "zh-CN") || left.channel.localeCompare(right.channel));
}

function templateOption(template: NotificationTemplate): TemplateOption & { id?: string } {
  return {
    id: template.id,
    code: template.code,
    name: template.name,
    channel: template.channel,
    publishedVersion: template.currentVersion,
    status: template.providerStatus || template.status,
    title: template.title,
    preview: template.renderedBody || template.body,
  };
}

function normalizeRecipient(value: unknown): NotificationRecipient {
  const row = recordValue(value);
  const subject = recordValue(row.subject);
  const recipientType = stringValue(row.recipientType, "service_subject");
  const subjectType = stringValue(subject.type ?? row.subjectType) as NotificationRecipient["subjectType"];
  const duty = recordValue(row.dutySchedule);
  return {
    id: stringValue(row.id),
    kind: recipientType === "platform_duty" ? "platform_duty" : subjectType === "repair_shop" ? "repair_shop" : "station",
    recipientType,
    subjectType,
    subjectId: stringValue(subject.id ?? row.subjectId) || null,
    subjectName: stringValue(row.subjectName, recipientType === "platform_duty" ? "平台值班组" : stringValue(subject.id, "服务主体")),
    contactName: stringValue(row.contactName),
    mobileMasked: stringValue(row.phoneMasked ?? row.mobileMasked) || null,
    mobile: stringValue(row.mobile) || null,
    enabled: row.isEnabled == null ? row.enabled !== false : Boolean(row.isEnabled),
    dutyStart: stringValue(duty.start ?? row.dutyStart) || null,
    dutyEnd: stringValue(duty.end ?? row.dutyEnd) || null,
    updatedAt: stringValue(row.updatedAt) || null,
    warnings: stringValues(row.warnings),
  };
}

function mergeServiceRecipients(recipients: NotificationRecipient[], stationsValue: unknown, shopsValue: unknown): NotificationRecipient[] {
  const stationRows = safeItems<unknown>(stationsValue).map(recordValue).filter((row) => row.isActive !== false);
  const shopRows = safeItems<unknown>(shopsValue).map(recordValue).filter((row) => row.isActive !== false);
  const names = new Map<string, string>();
  stationRows.forEach((row) => names.set(`inspection_station:${stringValue(row.id)}`, stringValue(row.name, stringValue(row.id))));
  shopRows.forEach((row) => names.set(`repair_shop:${stringValue(row.id)}`, stringValue(row.name, stringValue(row.id))));
  const merged = recipients.map((recipient) => ({ ...recipient, subjectName: recipient.kind === "platform_duty" ? recipient.contactName || "平台值班组" : names.get(`${recipient.subjectType}:${recipient.subjectId}`) || recipient.subjectName }));
  for (const [key, name] of names.entries()) {
    const [subjectType, ...idParts] = key.split(":");
    const subjectId = idParts.join(":");
    if (merged.some((recipient) => recipient.subjectType === subjectType && recipient.subjectId === subjectId)) continue;
    merged.push({
      id: `new-service-${subjectType}-${subjectId}`,
      kind: subjectType === "repair_shop" ? "repair_shop" : "station",
      recipientType: "service_subject",
      subjectType: subjectType as NotificationRecipient["subjectType"],
      subjectId,
      subjectName: name,
      contactName: "",
      mobile: "",
      mobileMasked: null,
      enabled: false,
    });
  }
  return merged;
}

function normalizeIntegration(value: unknown): IntegrationStatus {
  const row = recordValue(value);
  const sms = recordValue(row.smsBao ?? row.smsbao ?? row.sms);
  const wechat = recordValue(row.wechat);
  return {
    smsbao: {
      configured: Boolean(sms.configured),
      enabled: Boolean(sms.enabled),
      accountMasked: stringValue(sms.accountMasked ?? sms.usernameMasked) || null,
      signatureMasked: stringValue(sms.signatureMasked) || null,
      usableTemplates: numberValue(sms.usableTemplates ?? sms.approvedTemplates),
      note: stringValue(sms.note),
    },
    wechat: {
      configured: Boolean(wechat.configured),
      enabled: wechat.enabled == null ? Boolean(wechat.configured) : Boolean(wechat.enabled),
      approvedTemplates: numberValue(wechat.approvedTemplates),
      note: stringValue(wechat.note),
    },
  };
}

function normalizeRelease(value: unknown): WorkflowRelease {
  const row = recordValue(value);
  const summary = recordValue(row.summary);
  const resourceType = stringValue(row.resourceType ?? row.kind);
  const warnings = Array.isArray(summary.warnings) ? summary.warnings.length : numberValue(row.validationWarnings);
  return {
    id: stringValue(row.id),
    kind: resourceType === "workflow_policy" || resourceType === "policy" ? "policy" : "template",
    code: stringValue(summary.stableCode ?? row.code, stringValue(row.resourceId)),
    name: stringValue(row.name, resourceType === "workflow_policy" ? "督办策略" : "通知模板"),
    version: numberValue(row.version),
    domain: stringValue(row.domain) || null,
    status: stringValue(row.action ?? row.status, "published"),
    publishedAt: stringValue(row.occurredAt ?? row.publishedAt),
    publishedBy: stringValue(row.actorId ?? row.publishedBy),
    changeSummary: stringValue(summary.changeSummary ?? row.changeSummary) || null,
    validationWarnings: warnings,
    rollbackSourceVersion: summary.sourceVersion == null ? null : numberValue(summary.sourceVersion),
  };
}

function errorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "操作失败，请稍后重试";
  return safeOperationalMessage(message, "操作失败，请检查配置后重试");
}

async function workflowRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return api<T>(`/admin/workflow${path}`, init);
}

function LoadingState({ label = "正在同步配置…" }: { label?: string }) {
  return <div className="workflow-state-card loading" role="status"><ArrowClockwise /><strong>{label}</strong></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="workflow-state-card"><Bell /><strong>{title}</strong><p>{detail}</p></div>;
}

function WorkflowSubnav({ section, onSelect, sections = Object.keys(sectionLabels) as WorkflowAdminSection[] }: { section: WorkflowAdminSection; onSelect: (value: WorkflowAdminSection) => void; sections?: WorkflowAdminSection[] }) {
  return <nav className="workflow-subnav" aria-label="履约督办配置导航">
    {sections.map((value) => {
      const Icon = sectionIcons[value];
      return <button type="button" key={value} className={section === value ? "active" : ""} aria-current={section === value ? "page" : undefined} onClick={() => onSelect(value)}><Icon /><span>{sectionLabels[value]}</span></button>;
    })}
  </nav>;
}

export function WorkflowAdminPage({ section, onNavigate, onError, canManage = true, canRemind = true, viewerRole }: WorkflowAdminProps) {
  const selectSection = (next: WorkflowAdminSection) => {
    const path = workflowPaths[next];
    if (onNavigate) onNavigate(path);
    else window.location.assign(path);
  };
  const visibleSections: WorkflowAdminSection[] = viewerRole === "platform_admin" || !viewerRole ? ["tasks", "settings", "templates", "recipients", "releases"] : ["tasks", "settings"];
  return <div className="workflow-admin-page">
    <WorkflowSubnav section={section} onSelect={selectSection} sections={visibleSections} />
    {section === "tasks" ? <WorkflowOverview onError={onError} canRemind={canRemind} canResolve={canManage} /> : null}
    {section === "settings" ? <WorkflowPolicySettings onError={onError} canManage={canManage} viewerRole={viewerRole} /> : null}
    {section === "templates" ? <WorkflowTemplateCenter onError={onError} canManage={canManage} /> : null}
    {section === "recipients" ? <WorkflowRecipientCenter onError={onError} canManage={canManage} /> : null}
    {section === "releases" ? <WorkflowReleaseHistory onError={onError} canManage={canManage} onOpenSection={selectSection} /> : null}
  </div>;
}

function WorkflowOverview({ onError, canRemind, canResolve }: { onError: (message: string) => void; canRemind: boolean; canResolve: boolean }) {
  const [summary, setSummary] = useState<WorkflowSummary>(emptySummary);
  const [tasks, setTasks] = useState<WorkflowTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<WorkflowTask | null>(null);
  const [remindingId, setRemindingId] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const [filters, setFilters] = useState({ domain: "", urgency: "", role: "", status: "open", keyword: "" });
  const abortRef = useRef<AbortController | null>(null);
  const load = async (quiet = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    quiet ? setRefreshing(true) : setLoading(true);
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => value && query.set(key, value));
    try {
      const [summaryValue, taskValue] = await Promise.all([
        workflowRequest<WorkflowSummary & { outbox?: { deadLetter?: number } }>(`/summary?${query.toString()}`, { signal: controller.signal }),
        workflowRequest<unknown>(`/tasks?${query.toString()}`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const normalizedTasks = safeItems<unknown>(taskValue).map(normalizeWorkflowTask);
      setSummary({ ...emptySummary, ...summaryValue, deliveryFailed: summaryValue.deliveryFailed ?? summaryValue.outbox?.deadLetter ?? 0 });
      setTasks(normalizedTasks);
      setSelected((current) => {
        if (!current) return null;
        const fresh = normalizedTasks.find((item) => item.id === current.id);
        return fresh ? { ...current, ...fresh, events: current.events, deliveryState: current.deliveryState } : current;
      });
    } catch (reason) {
      if (!(reason instanceof Error && reason.name === "AbortError")) onError(errorMessage(reason));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };
  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [filters.domain, filters.urgency, filters.role, filters.status]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const visibleTasks = useMemo(() => {
    const keyword = filters.keyword.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      if (filters.domain && task.domain !== filters.domain) return false;
      if (filters.urgency && task.urgency !== filters.urgency) return false;
      if (filters.role && task.responsibleRole !== filters.role) return false;
      return !keyword || [task.title, task.businessCode, task.subjectName, task.responsibleLabel].some((value) => value?.toLocaleLowerCase().includes(keyword));
    });
  }, [filters.domain, filters.keyword, filters.role, filters.urgency, tasks]);
  const remind = async (task: WorkflowTask) => {
    if (!canRemind || remindingId) return;
    setRemindingId(task.id);
    try {
      const result = await workflowRequest<{ task?: unknown; nextManualReminderAt?: string; cooldownSeconds?: number }>(`/tasks/${encodeURIComponent(task.id)}/remind`, { method: "POST" });
      const remindedAt = new Date();
      const nextManualReminderAt = result.nextManualReminderAt ?? new Date(remindedAt.getTime() + (result.cooldownSeconds ?? 600) * 1_000).toISOString();
      setTasks((current) => current.map((item) => item.id === task.id ? result.task ? normalizeWorkflowTask(result.task) : { ...item, reminderCount: (item.reminderCount ?? 0) + 1, lastReminderAt: remindedAt.toISOString(), nextManualReminderAt } : item));
      setNotice("人工提醒已进入发送队列；外部渠道失败不会改变业务状态。");
      window.setTimeout(() => setNotice(""), 3500);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setRemindingId("");
    }
  };
  const openTask = async (task: WorkflowTask) => {
    setSelected(task);
    try {
      const result = await workflowRequest<{ task?: unknown }>(`/tasks/${encodeURIComponent(task.id)}`);
      if (result.task) setSelected((current) => current?.id === task.id ? normalizeWorkflowTask(result.task) : current);
    } catch (reason) {
      onError(errorMessage(reason));
    }
  };
  const resolveException = async (task: WorkflowTask, reason: string) => {
    if (!canResolve || task.nodeCode !== "workflow.exception") return;
    try {
      const result = await workflowRequest<{ task?: unknown }>(`/tasks/${encodeURIComponent(task.id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      const next = result.task ? normalizeWorkflowTask(result.task) : { ...task, status: "completed", completedAt: new Date().toISOString() };
      setTasks((current) => current.map((item) => item.id === task.id ? next : item));
      setSelected(next);
      setNotice("平台异常已记录处理结果并关闭；原业务状态未被代替推进。");
    } catch (reasonValue) {
      onError(errorMessage(reasonValue));
    }
  };
  if (loading) return <LoadingState label="正在汇总年检与维修待办…" />;
  return <>
    {notice ? <div className="workflow-inline-notice success" role="status"><CheckCircle />{notice}</div> : null}
    <section className="workflow-metrics" aria-label="督办任务概览">
      <article><span><BellRinging /></span><div><small>待处理</small><strong>{summary.pending}</strong><em>需责任方推进</em></div></article>
      <article className="due"><span><Alarm /></span><div><small>即将超时</small><strong>{summary.dueSoon}</strong><em>优先跟进</em></div></article>
      <article className="overdue"><span><WarningCircle /></span><div><small>已超时</small><strong>{summary.overdue}</strong><em>已触发升级</em></div></article>
      <article className="escalated"><span><Siren /></span><div><small>平台升级</small><strong>{summary.escalated}</strong><em>{summary.deliveryFailed ? `${summary.deliveryFailed} 条投递异常` : "值班组关注"}</em></div></article>
    </section>
    <section className="workflow-panel workflow-task-panel">
      <header className="workflow-panel-header">
        <div><small>履约任务总览</small><h2>履约督办任务</h2><p>任务关闭依赖合法业务动作，提醒失败不会回滚支付、预检、报告或报价。</p></div>
        <button type="button" className="workflow-icon-button" aria-label="刷新督办任务" disabled={refreshing} onClick={() => void load(true)}><ArrowClockwise className={refreshing ? "spin" : ""} /></button>
      </header>
      <div className="workflow-filters" role="search" aria-label="督办任务筛选">
        <label className="workflow-search"><MagnifyingGlass /><input aria-label="搜索业务编号或责任主体" value={filters.keyword} onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))} placeholder="业务编号、节点或责任主体" /></label>
        <select aria-label="业务域筛选" value={filters.domain} onChange={(event) => setFilters((current) => ({ ...current, domain: event.target.value }))}><option value="">全部业务</option><option value="annual_inspection">年检</option><option value="repair_quote">维修报价</option></select>
        <select aria-label="紧急程度筛选" value={filters.urgency} onChange={(event) => setFilters((current) => ({ ...current, urgency: event.target.value }))}><option value="">全部紧急度</option><option value="due_soon">即将超时</option><option value="overdue">已超时</option><option value="escalated">已升级</option><option value="normal">正常</option></select>
        <select aria-label="责任角色筛选" value={filters.role} onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value }))}><option value="">全部责任方</option>{roleFilterOptions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="任务状态筛选" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="open">仅进行中</option><option value="">全部状态</option><option value="closed">已关闭</option></select>
      </div>
      <div className="workflow-task-list" role="list">
        {visibleTasks.map((task) => {
          const cooldown = task.nextManualReminderAt ? new Date(task.nextManualReminderAt).getTime() > now : false;
          const countdown = durationText(task.deadlineAt, now);
          return <article key={task.id} className={`workflow-task-row urgency-${task.urgency}`} role="listitem">
            <button type="button" className="workflow-task-main" onClick={() => void openTask(task)}>
              <span className="workflow-task-signal" aria-hidden="true" />
              <span className="workflow-task-copy"><span><em>{domainLabels[task.domain] ?? "业务督办"}</em><b>{urgencyLabels[task.urgency]}</b></span><strong>{task.title}</strong><small>{task.businessCode} · {task.subjectName || "责任主体待补全"}</small></span>
              <span className="workflow-task-owner"><small>责任方</small><strong>{task.responsibleLabel || roleLabels[task.responsibleRole] || "责任方"}</strong></span>
              <span className="workflow-task-time"><small>截止时间</small><strong>{countdown}</strong><em>{formatDateTime(task.deadlineAt)}</em></span>
              <CaretRight />
            </button>
            <button type="button" className="workflow-remind-button" disabled={!canRemind || Boolean(remindingId) || cooldown || ["closed", "completed", "cancelled"].includes(task.status)} title={cooldown ? `人工提醒冷却中，${durationText(task.nextManualReminderAt, now)}` : "发送一次受限人工提醒"} onClick={() => void remind(task)}><PaperPlaneTilt />{remindingId === task.id ? "排队中…" : cooldown ? "冷却中" : "立即提醒"}</button>
          </article>;
        })}
        {!visibleTasks.length ? <EmptyState title="当前筛选下没有待办" detail="新订单和新维修询价进入受控节点后，任务会显示在这里；历史订单不会补建任务。" /> : null}
      </div>
    </section>
    {selected ? <TaskDrawer task={selected} now={now} canRemind={canRemind} canResolve={canResolve} reminding={remindingId === selected.id} close={() => setSelected(null)} onRemind={() => void remind(selected)} onResolve={(reason) => void resolveException(selected, reason)} /> : null}
  </>;
}

function TaskDrawer({ task, now, canRemind, canResolve, reminding, close, onRemind, onResolve }: { task: WorkflowTask; now: number; canRemind: boolean; canResolve: boolean; reminding: boolean; close: () => void; onRemind: () => void; onResolve: (reason: string) => void }) {
  const cooldown = task.nextManualReminderAt ? new Date(task.nextManualReminderAt).getTime() > now : false;
  const [resolutionReason, setResolutionReason] = useState("");
  const inAppSupervisionText = task.taskCenterVisible
    ? "任务中心已生效"
    : task.inAppSupervisionMode === "owner_inbox" ? "车主消息中心按策略触发" : "未启用";
  const externalDeliveryText = task.taskCenterVisible
    && (!task.deliveryState || task.deliveryState === "尚未投递")
    ? "未配置额外推送渠道（不影响任务中心督办）"
    : task.deliveryState
      ? deliveryStateLabels[task.deliveryState] || safeOperationalMessage(task.deliveryState, "投递状态已更新")
      : "尚未投递";
  return <div className="workflow-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <aside className="workflow-drawer" role="dialog" aria-modal="true" aria-label="督办任务详情">
      <header><div><small>{domainLabels[task.domain] ?? "业务督办"}</small><h2>{task.title}</h2><p>{task.businessCode}</p></div><button type="button" aria-label="关闭任务详情" onClick={close}><X /></button></header>
      <section className={`workflow-task-hero urgency-${task.urgency}`}><span><Siren /></span><div><small>当前紧急程度</small><strong>{urgencyLabels[task.urgency]}</strong><p>{durationText(task.deadlineAt, now)} · {task.responsibleLabel || roleLabels[task.responsibleRole]}</p></div></section>
      <section className="workflow-detail-grid">
        <article><small>任务状态</small><strong>{statusLabels[task.status] ?? "系统状态"}</strong></article>
        <article><small>责任主体</small><strong>{task.subjectName || "待补全"}</strong></article>
        <article><small>首次提醒</small><strong>{formatDateTime(task.firstReminderAt)}</strong></article>
        <article><small>截止时间</small><strong>{formatDateTime(task.deadlineAt)}</strong></article>
        <article><small>升级时间</small><strong>{formatDateTime(task.escalationAt)}</strong></article>
        <article><small>冻结策略</small><strong>{task.policyVersion || "未记录"}</strong></article>
      </section>
      <section className="workflow-drawer-section"><header><h3>业务关闭条件</h3><LockKey /></header><p>{task.nextActionLabel ? safeOperationalMessage(task.nextActionLabel, "责任方完成对应业务操作后自动关闭。") : "仅对应角色完成合法业务动作后自动关闭，后台提醒不会代替业务推进。"}</p></section>
      <section className="workflow-drawer-section"><header><h3>督办与通知状态</h3><Bell /></header><dl><div><dt>站内督办</dt><dd>{inAppSupervisionText}</dd></div><div><dt>已记录督办</dt><dd>{task.reminderCount ?? 0} 次</dd></div><div><dt>最近督办</dt><dd>{formatDateTime(task.lastReminderAt)}</dd></div><div><dt>额外推送</dt><dd>{externalDeliveryText}</dd></div></dl></section>
      <section className="workflow-drawer-section"><header><h3>任务事件</h3><Clock /></header>{task.events?.length ? <ol className="workflow-event-list">{task.events.map((event, index) => <li key={event.id ?? `${event.type}-${index}`}><span /><div><strong>{event.label ? safeOperationalMessage(event.label, eventTypeLabels[event.type] || "任务状态已更新") : eventTypeLabels[event.type] || "任务状态已更新"}</strong><small>{formatDateTime(event.createdAt)}</small>{event.detail ? <p>{safeOperationalMessage(event.detail, "相关处理信息已记录")}</p> : null}</div></li>)}</ol> : <p>尚无可展示的任务事件。</p>}</section>
      {task.nodeCode === "workflow.exception" && task.status === "open" && canResolve ? <section className="workflow-drawer-section"><header><h3>异常处理结果</h3><CheckCircle /></header><textarea aria-label="异常处理结果" rows={3} maxLength={300} value={resolutionReason} onChange={(event) => setResolutionReason(event.target.value)} placeholder="说明已采取的处理措施或核实结果（至少3个字）" /></section> : null}
      <footer><button type="button" className="secondary" onClick={close}>关闭</button>{task.nodeCode === "workflow.exception" && task.status === "open" && canResolve ? <button type="button" className="primary" disabled={resolutionReason.trim().length < 3} onClick={() => onResolve(resolutionReason.trim())}><CheckCircle />记录并关闭异常</button> : <button type="button" className="primary" disabled={!canRemind || reminding || cooldown || ["closed", "completed", "cancelled"].includes(task.status)} onClick={onRemind}><PaperPlaneTilt />{reminding ? "正在排队…" : cooldown ? `冷却中 · ${durationText(task.nextManualReminderAt, now)}` : "人工提醒"}</button>}</footer>
    </aside>
  </div>;
}

function WorkflowPolicySettings({ onError, canManage, viewerRole }: { onError: (message: string) => void; canManage: boolean; viewerRole?: string }) {
  const [drafts, setDrafts] = useState<Record<WorkflowDomain, WorkflowPolicy | null>>({ annual_inspection: null, repair_quote: null });
  const [publishedPolicies, setPublishedPolicies] = useState<Record<WorkflowDomain, WorkflowPolicy | null>>({ annual_inspection: null, repair_quote: null });
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [dirtyDomains, setDirtyDomains] = useState<Record<WorkflowDomain, boolean>>({ annual_inspection: false, repair_quote: false });
  const initialFlow: PolicyFlow = viewerRole === "repair_shop_admin" ? "repair_quote" : "annual_self_drive";
  const visibleFlows: PolicyFlow[] = viewerRole === "inspection_station_admin"
    ? ["annual_self_drive", "annual_valet"]
    : viewerRole === "repair_shop_admin"
      ? ["repair_quote"]
      : ["annual_self_drive", "annual_valet", "repair_quote"];
  const [flow, setFlow] = useState<PolicyFlow>(initialFlow);
  const [selectedCode, setSelectedCode] = useState("");
  const [validation, setValidation] = useState<PolicyValidation | null>(null);
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [notice, setNotice] = useState("");
  const activeDomain: WorkflowDomain = flow === "repair_quote" ? "repair_quote" : "annual_inspection";
  const draft = drafts[activeDomain];
  const published = publishedPolicies[activeDomain];
  const dirty = dirtyDomains[activeDomain];
  const load = async () => {
    setLoading(true);
    try {
      const [annualCurrentValue, annualDraftValue, repairCurrentValue, repairDraftValue, templateValue] = await Promise.all([
        viewerRole === "repair_shop_admin" ? Promise.resolve(null) : workflowRequest<unknown>("/policies/current?domain=annual_inspection"),
        canManage ? workflowRequest<unknown>("/policies/draft?domain=annual_inspection") : Promise.resolve(null),
        viewerRole === "inspection_station_admin" ? Promise.resolve(null) : workflowRequest<unknown>("/policies/current?domain=repair_quote"),
        canManage ? workflowRequest<unknown>("/policies/draft?domain=repair_quote") : Promise.resolve(null),
        canManage ? workflowRequest<unknown>("/templates") : Promise.resolve({ items: [] }),
      ]);
      const annualCurrent = normalizePolicy(annualCurrentValue, "annual_inspection");
      const repairCurrent = normalizePolicy(repairCurrentValue, "repair_quote");
      const savedAnnualDraft = normalizePolicy(annualDraftValue, "annual_inspection");
      const savedRepairDraft = normalizePolicy(repairDraftValue, "repair_quote");
      const annualDraft = savedAnnualDraft ?? (annualCurrent ? { ...clonePolicy(annualCurrent), id: undefined, status: "draft", revision: 0, version: null } : null);
      const repairDraft = savedRepairDraft ?? (repairCurrent ? { ...clonePolicy(repairCurrent), id: undefined, status: "draft", revision: 0, version: null } : null);
      setPublishedPolicies({ annual_inspection: annualCurrent, repair_quote: repairCurrent });
      setDrafts({ annual_inspection: annualDraft, repair_quote: repairDraft });
      setTemplates(normalizeTemplateRows(templateValue).filter((template) => template.currentVersion != null).map(templateOption));
      const initialDraft = initialFlow === "repair_quote" ? repairDraft : annualDraft;
      const firstNode = initialDraft?.nodes.find((node) => initialFlow === "repair_quote" ? node.responsibleRole === "repair_shop" : node.responsibleRole === "station" && (node.workflowVariant === "all" || node.workflowVariant === "self_drive")) ?? initialDraft?.nodes[0];
      if (firstNode) {
        setFlow(initialFlow);
        setSelectedCode(firstNode.nodeCode);
      }
      setDirtyDomains({ annual_inspection: canManage && Boolean(annualCurrent && !savedAnnualDraft), repair_quote: canManage && Boolean(repairCurrent && !savedRepairDraft) });
      setValidation(null);
      setPreview(null);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const nodes = useMemo(() => draft?.nodes.filter((node) => (viewerRole !== "inspection_station_admin" || node.responsibleRole === "station")
    && (viewerRole !== "repair_shop_admin" || node.responsibleRole === "repair_shop")
    && (flow === "repair_quote"
    ? node.workflowVariant === "repair"
    : node.workflowVariant === "all" || node.workflowVariant === (flow === "annual_valet" ? "valet" : "self_drive"))) ?? [], [draft, flow, viewerRole]);
  const selectedNode = draft?.nodes.find((node) => node.nodeCode === selectedCode) ?? nodes[0] ?? null;
  const updateNode = (patch: Partial<PolicyNode>) => {
    if (!draft || !selectedNode || !canManage) return;
    setDrafts((current) => ({ ...current, [activeDomain]: { ...draft, nodes: draft.nodes.map((node) => node.nodeCode === selectedNode.nodeCode ? { ...node, ...patch } : node) } }));
    setDirtyDomains((current) => ({ ...current, [activeDomain]: true }));
    setValidation(null);
    setPreview(null);
  };
  const updatePolicy = (patch: Partial<Pick<WorkflowPolicy, "name" | "businessHours">>) => {
    if (!draft || !canManage) return;
    setDrafts((current) => ({ ...current, [activeDomain]: { ...draft, ...patch } }));
    setDirtyDomains((current) => ({ ...current, [activeDomain]: true }));
    setValidation(null);
    setPreview(null);
  };
  const save = async () => {
    if (!draft || !canManage) return null;
    setBusy("save");
    try {
      const resultValue = await workflowRequest<unknown>("/policies/draft", { method: "PUT", body: JSON.stringify({ domain: activeDomain, expectedRevision: draft.revision, name: draft.name, businessHours: draft.businessHours, nodes: draft.nodes.map(policyNodePayload) }) });
      const result = normalizePolicy(resultValue, activeDomain);
      if (!result) throw new Error("服务端没有返回已保存的策略草稿");
      setDrafts((current) => ({ ...current, [activeDomain]: clonePolicy(result) }));
      setDirtyDomains((current) => ({ ...current, [activeDomain]: false }));
      setNotice("草稿已保存，线上生效策略未改变。");
      return result;
    } catch (reason) {
      onError(errorMessage(reason));
      return null;
    } finally {
      setBusy("");
    }
  };
  const validate = async () => {
    if (!draft) return null;
    setBusy("validate");
    try {
      const result = await workflowRequest<{ valid: boolean; issues?: Array<{ severity: "error" | "warning"; nodeCode?: string; field?: string; message: string }> }>("/policies/draft/validate", { method: "POST", body: JSON.stringify({ domain: activeDomain }) });
      const normalized = { valid: result.valid, errors: (result.issues ?? []).filter((item) => item.severity === "error"), warnings: (result.issues ?? []).filter((item) => item.severity === "warning") };
      setValidation(normalized);
      return normalized;
    } catch (reason) {
      onError(errorMessage(reason));
      return null;
    } finally {
      setBusy("");
    }
  };
  const showPreview = async () => {
    if (!draft) return;
    setBusy("preview");
    try {
      const result = await workflowRequest<{ sample?: Array<{ nodeCode: string; firstReminderAt?: string | null; dueAt?: string | null; escalateAt?: string | null }>; policy?: unknown }>("/policies/draft/preview", { method: "POST", body: JSON.stringify({ domain: activeDomain }) });
      setPreview({ rows: (result.sample ?? []).map((sample) => {
        const node = draft.nodes.find((candidate) => candidate.nodeCode === sample.nodeCode);
        return { nodeCode: sample.nodeCode, nodeName: node?.name || sample.nodeCode, firstReminderText: `首次提醒：${formatDateTime(sample.firstReminderAt)}`, deadlineText: `截止：${formatDateTime(sample.dueAt)}`, escalationText: `升级：${formatDateTime(sample.escalateAt)}`, channelsText: node?.channels.map((item) => channelLabels[item]).join(" → ") || "未启用渠道", templateText: Object.values(node?.templateBindings ?? {}).filter(Boolean).length ? "模板已冻结" : "未绑定模板" };
      }) });
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!draft || !canManage || dirty) return;
    setBusy("publish");
    try {
      const checked = validation ?? await validate();
      if (!checked?.valid) return;
      const result = await workflowRequest<{ policy: unknown; warnings?: unknown[] }>("/policies/draft/publish", { method: "POST", body: JSON.stringify({ domain: activeDomain, expectedRevision: draft.revision }) });
      const nextPublished = normalizePolicy(result.policy, activeDomain);
      if (!nextPublished) throw new Error("服务端没有返回已发布策略");
      setPublishedPolicies((current) => ({ ...current, [activeDomain]: nextPublished }));
      setDrafts((current) => ({ ...current, [activeDomain]: { ...clonePolicy(nextPublished), id: undefined, status: "draft", revision: 0, version: null } }));
      setValidation(null);
      setPreview(null);
      setDirtyDomains((current) => ({ ...current, [activeDomain]: false }));
      setNotice(`策略${nextPublished.version == null ? "新版本" : versionLabel(nextPublished.version)}已发布；仅影响之后创建的节点任务。`);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  if (loading) return <LoadingState />;
  if (!draft) return <EmptyState title="尚未初始化督办策略" detail="请先完成系统默认策略初始化；业务状态机不会由本页面创建或修改。" />;
  return <>
    {notice ? <div className="workflow-inline-notice success" role="status"><CheckCircle />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X /></button></div> : null}
    {!canManage ? <div className="workflow-inline-notice info"><Eye />当前账号仅可查看本主体生效规则，只有平台管理员可以保存和发布。</div> : null}
    <section className="workflow-policy-banner">
      <div><span><ShieldCheck /></span><div><small>当前生效版本</small><strong>{published ? versionLabel(published.version) : "尚未发布"}</strong><p>{published?.publishedAt ? `${formatDateTime(published.publishedAt)} 由 ${actorLabel(published.publishedBy)} 发布` : "草稿不会影响线上任务"}</p></div></div>
      <div><span><FloppyDisk /></span><div><small>{canManage ? "正在编辑" : "只读规则"}</small><strong>{canManage ? `草稿修订 ${draft.revision}${dirty ? " · 有未保存修改" : " · 已保存"}` : `当前生效 ${versionLabel(published?.version)}`}</strong><p>任务创建时冻结策略、时限和模板版本</p></div></div>
      <div className="workflow-policy-actions"><button type="button" className="secondary" disabled={!canManage || !dirty || Boolean(busy)} onClick={() => void save()}><FloppyDisk />{busy === "save" ? "保存中…" : "保存草稿"}</button><button type="button" className="secondary" disabled={!canManage || dirty || Boolean(busy)} onClick={() => void validate()}><Check />校验</button><button type="button" className="secondary" disabled={!canManage || dirty || Boolean(busy)} onClick={() => void showPreview()}><Eye />预览</button><button type="button" className="primary" disabled={!canManage || dirty || Boolean(busy) || validation?.valid !== true} onClick={() => void publish()}><PaperPlaneTilt />{busy === "publish" ? "发布中…" : "发布新版本"}</button></div>
    </section>
    <section className="workflow-policy-layout">
      <aside className="workflow-node-nav">
        <div className="workflow-flow-tabs" role="tablist" aria-label="业务流程">
          {visibleFlows.map((value) => <button type="button" role="tab" aria-selected={flow === value} key={value} className={flow === value ? "active" : ""} onClick={() => { setFlow(value); const nextDomain = value === "repair_quote" ? "repair_quote" : "annual_inspection"; const first = drafts[nextDomain]?.nodes.find((node) => (viewerRole !== "inspection_station_admin" || node.responsibleRole === "station") && (viewerRole !== "repair_shop_admin" || node.responsibleRole === "repair_shop") && (value === "repair_quote" ? node.workflowVariant === "repair" : node.workflowVariant === "all" || node.workflowVariant === (value === "annual_valet" ? "valet" : "self_drive"))); setSelectedCode(first?.nodeCode || ""); setValidation(null); setPreview(null); }}>{flowLabels[value]}</button>)}
        </div>
        <div className="workflow-node-list">{nodes.map((node, index) => <button type="button" key={`${node.flow}:${node.nodeCode}`} className={selectedNode?.nodeCode === node.nodeCode ? "active" : ""} onClick={() => setSelectedCode(node.nodeCode)}><span>{index + 1}</span><div><strong>{safeOperationalMessage(node.name, nodeLabels[node.nodeCode] || "业务节点")}</strong><small>{node.taskKind === "blocking" ? "阻塞待办" : node.taskKind === "soft" ? "软待办" : "信息通知"} · {node.enabled ? "已启用" : "已停用"}</small></div><CaretRight /></button>)}</div>
      </aside>
      {selectedNode ? <PolicyNodeEditor node={selectedNode} policy={draft} templates={templates} disabled={!canManage} update={updateNode} updatePolicy={updatePolicy} /> : <EmptyState title="该路径没有可配置节点" detail="节点目录由服务端固定业务状态机提供，不能在后台新增任意状态。" />}
      <aside className="workflow-policy-side">
        <section><header><CheckCircle /><h3>发布校验</h3></header>{validation ? <><div className={`workflow-validation-result ${validation.valid ? "valid" : "invalid"}`}><strong>{validation.valid ? "校验通过" : "存在阻塞问题"}</strong><span>{validation.errors.length} 个错误 · {validation.warnings.length} 个预警</span></div>{validation.errors.map((item, index) => <p className="error" key={`e-${index}`}><X />{safeOperationalMessage(item.message)}</p>)}{validation.warnings.map((item, index) => <p className="warning" key={`w-${index}`}><Warning />{safeOperationalMessage(item.message, "存在需要关注的配置")}</p>)}</> : <p className="workflow-side-empty">保存草稿后执行校验。首次提醒必须早于截止，阻塞节点必须保留站内待办，外部渠道必须绑定可用模板。</p>}</section>
        <section><header><Eye /><h3>实际调度预览</h3></header>{preview?.rows?.length ? <div className="workflow-preview-list">{preview.rows.filter((row) => !selectedNode || row.nodeCode === selectedNode.nodeCode).map((row) => <article key={row.nodeCode}><strong>{safeOperationalMessage(row.nodeName, "业务节点")}</strong><span>{safeOperationalMessage(row.firstReminderText, "首次提醒时间已计算")}</span><span>{safeOperationalMessage(row.deadlineText, "截止时间已计算")}</span><span>{safeOperationalMessage(row.escalationText, "升级时间已计算")}</span><small>{safeOperationalMessage(row.channelsText, "通知渠道已配置")} · {safeOperationalMessage(row.templateText, "通知模板已绑定")}</small></article>)}</div> : <p className="workflow-side-empty">预览展示服务器按营业时间、自然时间和渠道兜底计算的真实结果。</p>}</section>
      </aside>
    </section>
  </>;
}

function PolicyNodeEditor({ node, policy, templates, disabled, update, updatePolicy }: { node: PolicyNode; policy: WorkflowPolicy; templates: TemplateOption[]; disabled: boolean; update: (patch: Partial<PolicyNode>) => void; updatePolicy: (patch: Partial<Pick<WorkflowPolicy, "name" | "businessHours">>) => void }) {
  const updateNumber = (field: keyof Pick<PolicyNode, "firstReminderMinutes" | "deadlineMinutes" | "escalationMinutes" | "maxReminders" | "reminderIntervalMinutes">, value: string) => update({ [field]: value === "" ? field === "maxReminders" ? 0 : null : Math.max(field === "reminderIntervalMinutes" ? 1 : 0, Number(value)) } as Partial<PolicyNode>);
  const toggleChannel = (channel: WorkflowChannel) => {
    const channels = node.channels.includes(channel) ? node.channels.filter((value) => value !== channel) : [...node.channels, channel];
    const fallbackOrder = node.fallbackOrder.filter((value) => value !== "in_app" && channels.includes(value));
    if (channel !== "in_app" && !fallbackOrder.includes(channel) && channels.includes(channel)) fallbackOrder.push(channel);
    update({ channels, fallbackOrder });
  };
  const channelTemplates = (channel: WorkflowChannel) => templates.filter((template) => template.channel === channel);
  return <div className="workflow-node-editor">
    <header><div><small>业务节点</small><h2>{safeOperationalMessage(node.name, nodeLabels[node.nodeCode] || "业务节点")}</h2><p>{node.description ? safeOperationalMessage(node.description, "配置提醒节奏、渠道和升级规则。") : "配置提醒节奏、渠道和升级规则。业务状态与关闭动作保持只读。"}</p></div><label className="workflow-toggle"><input type="checkbox" checked={node.enabled} disabled={disabled} onChange={(event) => update({ enabled: event.target.checked })} /><span /><b>{node.enabled ? "启用督办" : "停用督办"}</b></label></header>
    <section className="workflow-locked-section"><header><LockKey /><div><strong>核心业务规则（只读）</strong><small>任何策略版本都不能替代业务动作、改变权限或触碰资金与报告完整性。</small></div></header><dl><div><dt>触发状态</dt><dd>{workflowStateLabel(node.triggerStatus)}</dd></div><div><dt>下一状态</dt><dd>{workflowStateLabel(node.nextStatus)}</dd></div><div><dt>责任角色</dt><dd>{roleLabels[node.responsibleRole] || "业务责任方"}</dd></div><div><dt>主体范围</dt><dd>{subjectScopeLabels[node.responsibleScope] || "当前业务责任主体"}</dd></div><div><dt>关闭动作</dt><dd>{closeActionLabels[node.closeAction] || "责任方完成对应业务操作"}</dd></div><div><dt>任务类型</dt><dd>{node.taskKind === "blocking" ? "阻塞待办" : node.taskKind === "soft" ? "软待办" : "信息通知"}</dd></div></dl>{node.protectedRules?.length ? <ul>{node.protectedRules.map((rule) => <li key={rule}><ShieldCheck />{protectedRuleLabels[rule] || "核心业务保护规则已启用"}</li>)}</ul> : null}</section>
    <section className="workflow-editor-section"><header><Clock /><div><strong>策略营业时间</strong><small>仅“营业时间”计时节点使用；自然时间节点连续计时</small></div></header><div className="workflow-field-grid"><label><span>策略名称</span><input value={policy.name} disabled={disabled} maxLength={100} onChange={(event) => updatePolicy({ name: event.target.value })} /></label><label><span>营业开始</span><input type="time" value={policy.businessHours.start} disabled={disabled} onChange={(event) => updatePolicy({ businessHours: { ...policy.businessHours, start: event.target.value } })} /></label><label><span>营业结束</span><input type="time" value={policy.businessHours.end} disabled={disabled} onChange={(event) => updatePolicy({ businessHours: { ...policy.businessHours, end: event.target.value } })} /></label></div><div className="workflow-weekday-grid" role="group" aria-label="营业星期">{[1, 2, 3, 4, 5, 6, 0].map((weekday) => { const selected = policy.businessHours.weekdays.includes(weekday); const label = ["日", "一", "二", "三", "四", "五", "六"][weekday]; return <button type="button" key={weekday} className={selected ? "active" : ""} disabled={disabled} aria-pressed={selected} onClick={() => updatePolicy({ businessHours: { ...policy.businessHours, weekdays: selected ? policy.businessHours.weekdays.filter((value) => value !== weekday) : [...policy.businessHours.weekdays, weekday].sort() } })}>周{label}</button>; })}</div><label className="workflow-holidays"><span>停业日期（逗号分隔）</span><input value={(policy.businessHours.holidays ?? []).join(", ")} disabled={disabled} placeholder="例如 2026-10-01, 2026-10-02" onChange={(event) => updatePolicy({ businessHours: { ...policy.businessHours, holidays: event.target.value.split(/[，,]/u).map((value) => value.trim()).filter(Boolean) } })} /></label></section>
    <section className="workflow-editor-section"><header><Clock /><div><strong>计时与提醒</strong><small>分钟值由服务端结合计时方式生成冻结时间点</small></div></header><div className="workflow-field-grid">
      <label><span>计时方式</span><select value={node.clockBasis} disabled={disabled} onChange={(event) => update({ clockBasis: event.target.value as ClockBasis })}><option value="business">营业时间</option><option value="natural">自然时间</option></select><small>{node.clockBasis === "business" ? "自动跳过非营业时段" : "连续计时，适合司机和预约节点"}</small></label>
      <label><span>首次提醒（分钟）</span><input type="number" min="0" value={node.firstReminderMinutes ?? ""} disabled={disabled} onChange={(event) => updateNumber("firstReminderMinutes", event.target.value)} /><small>{minuteText(node.firstReminderMinutes, node.clockBasis)}</small></label>
      <label><span>截止时间（分钟）</span><input type="number" min="0" value={node.deadlineMinutes ?? ""} disabled={disabled} onChange={(event) => updateNumber("deadlineMinutes", event.target.value)} /><small>{minuteText(node.deadlineMinutes, node.clockBasis)}</small></label>
      <label><span>升级时间（分钟）</span><input type="number" min="0" value={node.escalationMinutes ?? ""} disabled={disabled} onChange={(event) => updateNumber("escalationMinutes", event.target.value)} /><small>{minuteText(node.escalationMinutes, node.clockBasis)}</small></label>
      <label><span>最大提醒次数</span><input type="number" min="0" max="20" value={node.maxReminders} disabled={disabled} onChange={(event) => updateNumber("maxReminders", event.target.value)} /><small>不含人工提醒</small></label>
      <label><span>重复提醒间隔（分钟）</span><input type="number" min="1" value={node.reminderIntervalMinutes ?? ""} disabled={disabled} onChange={(event) => updateNumber("reminderIntervalMinutes", event.target.value)} /><small>{minuteText(node.reminderIntervalMinutes, node.clockBasis)}</small></label>
    </div></section>
    <section className="workflow-editor-section">
      <header><Bell /><div><strong>通知渠道与模板</strong><small>外部渠道启用时必须选择已发布且可用的模板</small></div></header>
      <div className="workflow-channel-grid">{(["in_app", "wechat", "sms"] as WorkflowChannel[]).map((channel) => {
        const options = channelTemplates(channel);
        const binding = node.templateBindings[channel] || "";
        const selectedTemplate = options.find((template) => (template.id || template.code) === binding);
        const bindingInOptions = Boolean(selectedTemplate);
        return <article key={channel} className={node.channels.includes(channel) ? "active" : ""}>
          <label className="workflow-channel-choice"><input type="checkbox" checked={node.channels.includes(channel)} disabled={disabled || (channel === "in_app" && node.taskKind === "blocking")} onChange={() => toggleChannel(channel)} /><span>{node.channels.includes(channel) ? <Check /> : null}</span><div><strong>{channelLabels[channel]}</strong><small>{channel === "in_app" ? "后台/各角色待办" : channel === "wechat" ? "优先使用已授权订阅消息" : "微信不可用或超时后的兜底"}</small></div></label>
          <label className="workflow-template-select"><span>绑定模板</span><select aria-label={`${channelLabels[channel]}通知模板`} value={binding} disabled={disabled || !node.channels.includes(channel)} onChange={(event) => update({ templateBindings: { ...node.templateBindings, [channel]: event.target.value } })}><option value="">请选择已发布模板</option>{binding && !bindingInOptions ? <option value={binding}>当前任务冻结模板</option> : null}{options.map((template) => <option value={template.id || template.code} key={template.id || `${template.code}:${template.channel}`}>{template.name} · {versionLabel(template.publishedVersion)}</option>)}</select></label>
          {node.channels.includes(channel) ? <div className="workflow-binding-preview"><small>实际模板预览</small>{selectedTemplate ? <><strong>{selectedTemplate.title || selectedTemplate.name}</strong><p>{templateTextForOperator(selectedTemplate.preview || "该模板暂无示例正文")}</p><em>{versionLabel(selectedTemplate.publishedVersion)}</em></> : <p>{binding ? "当前冻结模板不在可选目录中，任务仍按冻结版本执行。" : "选择模板后在这里查看真实示例内容。"}</p>}</div> : null}
        </article>;
      })}</div>
      <div className="workflow-fallback-order">
        <span>兜底顺序</span>
        <strong>{node.fallbackOrder.map((channel, index) => `${index + 1}. ${channelLabels[channel]}`).join(" → ") || "未配置"}</strong>
        <div className="workflow-fallback-actions" aria-label="外部渠道兜底顺序">
          <button type="button" disabled={disabled || !node.channels.includes("wechat") || !node.channels.includes("sms")} className={node.fallbackOrder[0] === "wechat" ? "active" : ""} onClick={() => update({ fallbackOrder: ["wechat", "sms"] })}>微信优先</button>
          <button type="button" disabled={disabled || !node.channels.includes("wechat") || !node.channels.includes("sms")} className={node.fallbackOrder[0] === "sms" ? "active" : ""} onClick={() => update({ fallbackOrder: ["sms", "wechat"] })}>短信优先</button>
        </div>
        <small>微信不可用或发送失败时立即进入下一兜底渠道；阻塞任务超时后可继续短信升级。</small>
      </div>
    </section>
    <section className="workflow-editor-section"><header><Siren /><div><strong>升级与静默时段</strong><small>客户非紧急通知可静默；业务方阻塞超时不受客户静默时段影响</small></div></header><div className="workflow-field-grid"><label><span>平台升级等级</span><select value={node.escalationLevel} disabled={disabled} onChange={(event) => update({ escalationLevel: event.target.value })}><option value="none">不升级</option><option value="platform_duty">平台值班关注</option><option value="platform_urgent">平台紧急处理</option></select></label><label><span>静默开始</span><input type="time" value={node.quietHours?.start || "22:00"} disabled={disabled || node.responsibleRole !== "owner"} onChange={(event) => update({ quietHours: { start: event.target.value, end: node.quietHours?.end || "08:00" } })} /></label><label><span>静默结束</span><input type="time" value={node.quietHours?.end || "08:00"} disabled={disabled || node.responsibleRole !== "owner"} onChange={(event) => update({ quietHours: { start: node.quietHours?.start || "22:00", end: event.target.value } })} /></label></div></section>
  </div>;
}

function WorkflowTemplateCenter({ onError, canManage }: { onError: (message: string) => void; canManage: boolean }) {
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [selectedCode, setSelectedCode] = useState("");
  const [draft, setDraft] = useState<NotificationTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [channel, setChannel] = useState<"" | WorkflowChannel>("");
  const [keyword, setKeyword] = useState("");
  const [notice, setNotice] = useState("");
  const load = async (preferredKey?: string) => {
    setLoading(true);
    try {
      const value = await workflowRequest<unknown>("/templates");
      const items = normalizeTemplateRows(value);
      setTemplates(items);
      const key = preferredKey || selectedCode || items[0]?.selectionKey || "";
      setSelectedCode(key);
      const selected = items.find((item) => item.selectionKey === key) ?? null;
      setDraft(selected ? JSON.parse(JSON.stringify(selected)) as NotificationTemplate : null);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const visible = useMemo(() => templates.filter((item) => (!channel || item.channel === channel) && (!keyword.trim() || `${item.name} ${item.code} ${item.nodeCodes.join(" ")}`.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase()))), [channel, keyword, templates]);
  const selectTemplate = (template: NotificationTemplate) => {
    setSelectedCode(template.selectionKey);
    setDraft(JSON.parse(JSON.stringify(template)) as NotificationTemplate);
    setNotice("");
  };
  const save = async () => {
    if (!draft || !canManage) return;
    setBusy("save");
    try {
      await workflowRequest<{ template: unknown; issues?: unknown[] }>(`/templates/${encodeURIComponent(draft.code)}/draft`, { method: "PUT", body: JSON.stringify({ channel: draft.channel, expectedRevision: draft.draftRevision ?? 0, name: draft.name, title: draft.title, body: draft.body, buttonText: draft.buttonText || null, actionCode: draft.actionCode || "none", allowedVariables: draft.selectedVariables, exampleData: draft.exampleData, providerTemplateId: draft.providerTemplateId || null, providerSnapshot: draft.providerSnapshot ?? {}, filingStatus: draft.providerStatus || (draft.channel === "in_app" ? "not_required" : draft.channel === "wechat" ? "unconfigured" : "unreported") }) });
      await load(draft.selectionKey);
      setNotice("模板草稿已保存，已生成的消息和线上版本未改变。");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  const preview = async () => {
    if (!draft) return;
    setBusy("preview");
    try {
      const resultValue = await workflowRequest<unknown>(`/templates/${encodeURIComponent(draft.code)}/preview`, { method: "POST", body: JSON.stringify({ channel: draft.channel }) });
      const result = normalizeTemplateRows([resultValue])[0];
      if (result) setDraft((current) => current ? { ...current, renderedBody: result.renderedBody, estimatedSegments: result.estimatedSegments, characterCount: result.characterCount } : result);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!draft || !canManage) return;
    setBusy("publish");
    try {
      const result = await workflowRequest<{ template: unknown; issues?: unknown[] }>(`/templates/${encodeURIComponent(draft.code)}/publish`, { method: "POST", body: JSON.stringify({ channel: draft.channel, expectedRevision: draft.draftRevision ?? 0 }) });
      const published = normalizeTemplateRows([result.template])[0];
      setNotice(`模板${published?.currentVersion == null ? "新版本" : versionLabel(published.currentVersion)}已发布，仅供之后创建的任务使用。`);
      await load(draft.selectionKey);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  if (loading) return <LoadingState label="正在读取通知模板…" />;
  return <>
    {notice ? <div className="workflow-inline-notice success"><CheckCircle />{notice}</div> : null}
    <section className="workflow-template-layout">
      <aside className="workflow-template-list-panel">
        <header><div><small>按渠道管理发布版本</small><h2>通知模板目录</h2></div><span>{visible.length} 个</span></header>
        <div className="workflow-template-filters"><label><MagnifyingGlass /><input aria-label="搜索模板" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="模板名称或适用节点" /></label><select aria-label="模板渠道筛选" value={channel} onChange={(event) => setChannel(event.target.value as "" | WorkflowChannel)}><option value="">全部渠道</option><option value="in_app">站内</option><option value="wechat">微信</option><option value="sms">短信</option></select></div>
        <div className="workflow-template-cards">{visible.map((template) => <button type="button" key={template.selectionKey} className={selectedCode === template.selectionKey ? "active" : ""} onClick={() => selectTemplate(template)}><span className={`channel-${template.channel}`}>{template.channel === "sms" ? <Phone /> : template.channel === "wechat" ? <BellRinging /> : <Bell />}</span><div><strong>{template.name}</strong><small>{channelLabels[template.channel]} · {versionLabel(template.currentVersion)}</small></div><em className={`template-status status-${template.providerStatus || template.status}`}>{template.channel === "sms" ? technicalStatusLabel(template.providerStatus || "unreported") : technicalStatusLabel(template.status)}</em></button>)}{!visible.length ? <EmptyState title="没有匹配模板" detail="修改筛选条件，或由系统初始化默认模板目录。" /> : null}</div>
      </aside>
      {draft ? <TemplateEditor draft={draft} canManage={canManage} busy={busy} setDraft={setDraft} save={save} preview={preview} publish={publish} /> : <EmptyState title="请选择通知模板" detail="正文与渠道配置通过新版本发布，已经发布的历史版本不会改变。" />}
    </section>
  </>;
}

function TemplateEditor({ draft, canManage, busy, setDraft, save, preview, publish }: { draft: NotificationTemplate; canManage: boolean; busy: string; setDraft: (value: NotificationTemplate) => void; save: () => Promise<void>; preview: () => Promise<void>; publish: () => Promise<void> }) {
  const wechatReadOnly = draft.channel === "wechat";
  const update = (patch: Partial<NotificationTemplate>) => setDraft({ ...draft, ...patch });
  const publishBlocked = draft.channel === "sms" && draft.providerStatus !== "approved" || draft.channel === "wechat" && !draft.wechatTemplateIdMasked;
  return <main className="workflow-template-editor">
    <header><div><span className={`channel-${draft.channel}`}>{draft.channel === "sms" ? <Phone /> : draft.channel === "wechat" ? <BellRinging /> : <Bell />}</span><div><small>{channelLabels[draft.channel]}通知</small><h2>{draft.name}</h2><p>当前发布：{versionLabel(draft.currentVersion)} · 草稿修订：{draft.draftRevision ?? 0}</p></div></div><div className="workflow-template-actions"><button type="button" className="secondary" disabled={!canManage || Boolean(busy)} onClick={() => void save()}><FloppyDisk />{busy === "save" ? "保存中…" : "保存草稿"}</button><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void preview()}><Eye />实际预览</button><button type="button" className="primary" disabled={!canManage || Boolean(busy) || publishBlocked} title={publishBlocked ? "外部模板尚未通过渠道配置，不能发布" : "发布不可变新版本"} onClick={() => void publish()}><PaperPlaneTilt />{busy === "publish" ? "发布中…" : "发布新版本"}</button></div></header>
    {wechatReadOnly ? <div className="workflow-inline-notice info"><LockKey />微信审批模板内容不可在这里自由修改；仅维护模板编号、字段对应关系与示例预览。</div> : null}
    {draft.channel === "sms" && draft.providerStatus !== "approved" ? <div className="workflow-inline-notice warning"><Warning />短信模板报备状态为“{technicalStatusLabel(draft.providerStatus || "unreported")}”，可以保存草稿，但不能用于真实发送。</div> : null}
    <div className="workflow-template-workspace">
      <div className="workflow-template-form">
        {draft.channel !== "in_app" ? <section className="workflow-editor-section"><header>{draft.channel === "wechat" ? <BellRinging /> : <Phone />}<div><strong>{draft.channel === "wechat" ? "微信审批模板绑定" : "短信报备配置"}</strong><small>{draft.channel === "wechat" ? "仅绑定微信后台已审批内容，不在此改写审批文案" : "真实发送前必须完成供应商报备"}</small></div></header><div className="workflow-field-grid single"><label><span>{draft.channel === "wechat" ? "微信模板编号" : "短信宝模板或产品编号（可选）"}</span><input type="password" value={draft.providerTemplateId || ""} disabled={!canManage} autoComplete="new-password" placeholder="请填写供应商提供的模板编号" onChange={(event) => update({ providerTemplateId: event.target.value })} /></label>{draft.channel === "sms" ? <label><span>报备状态</span><select value={draft.providerStatus || "unreported"} disabled={!canManage} onChange={(event) => update({ providerStatus: event.target.value })}><option value="unreported">未报备</option><option value="pending">审核中</option><option value="approved">已通过</option><option value="rejected">已驳回</option></select></label> : <div className="workflow-provider-copy"><span>审批内容同步状态</span><strong>{providerSnapshotSummary(draft.providerSnapshot)}</strong><small>审批文案由微信后台维护，此处仅展示同步结果。</small></div>}</div></section> : null}
        <section className="workflow-editor-section"><header><Bell /><div><strong>模板正文</strong><small>仅可使用下方白名单变量，不允许保存任意网址</small></div></header><div className="workflow-field-grid single"><label><span>标题</span><input value={draft.title} disabled={!canManage || wechatReadOnly} maxLength={60} onChange={(event) => update({ title: event.target.value })} /></label><label><span>正文</span><textarea value={templateTextForOperator(draft.body)} disabled={!canManage || wechatReadOnly} maxLength={600} rows={7} onChange={(event) => update({ body: templateTextForStorage(event.target.value) })} /></label><div className="workflow-inline-fields"><label><span>按钮文字</span><input value={draft.buttonText || ""} disabled={!canManage || wechatReadOnly} maxLength={12} onChange={(event) => update({ buttonText: event.target.value })} /></label><label><span>点击后打开</span><select value={draft.actionCode || "none"} disabled={!canManage} onChange={(event) => update({ actionCode: event.target.value })}>{actionOptions.map((option) => <option value={option} key={option}>{actionLabels[option] || "系统指定页面"}</option>)}</select></label></div></div></section>
        <section className="workflow-editor-section"><header><ShieldCheck /><div><strong>可用业务数据与示例</strong><small>短信不允许故障明细、完整地址、完整手机号等非必要隐私</small></div></header><div className="workflow-variable-list">{draft.allowedVariables.map((variable) => <label key={variable}><input type="checkbox" checked={draft.selectedVariables.includes(variable)} disabled={!canManage || wechatReadOnly} onChange={(event) => update({ selectedVariables: event.target.checked ? [...draft.selectedVariables, variable] : draft.selectedVariables.filter((value) => value !== variable) })} /><code>{`{{${variableLabel(variable)}}}`}</code><input aria-label={`${variableLabel(variable)}示例值`} value={draft.exampleData[variable] || ""} disabled={!canManage} onChange={(event) => update({ exampleData: { ...draft.exampleData, [variable]: event.target.value } })} /></label>)}</div></section>
        {wechatReadOnly ? <section className="workflow-editor-section"><header><BellRinging /><div><strong>微信字段对应关系</strong><small>将微信审批模板的各字段对应到允许使用的业务数据</small></div></header><div className="workflow-provider-snapshot"><dl><div><dt>模板配置</dt><dd>{draft.wechatTemplateIdMasked || draft.providerTemplateId ? "已绑定" : "未配置"}</dd></div><div><dt>内容快照</dt><dd>{providerSnapshotSummary(draft.providerSnapshot)}</dd></div></dl>{draft.fieldMappings?.map((mapping, index) => <label key={`${mapping.field}-${index}`}><span>第 {index + 1} 个模板字段</span><select value={mapping.variable} disabled={!canManage} onChange={(event) => { const fieldMappings = draft.fieldMappings?.map((item, itemIndex) => itemIndex === index ? { ...item, variable: event.target.value } : item) ?? []; update({ fieldMappings, providerSnapshot: { ...(draft.providerSnapshot ?? {}), fieldMappings } }); }}><option value="">不使用</option>{draft.allowedVariables.map((variable) => <option key={variable} value={variable}>{variableLabel(variable)}</option>)}</select></label>)}</div></section> : null}
      </div>
      <aside className="workflow-template-preview">
        <section><header><Eye /><div><strong>最终渲染预览</strong><small>示例数据仅用于预览，不代表真实发送</small></div></header><article className={`workflow-message-preview channel-${draft.channel}`}><header><span>{draft.channel === "sms" ? "短信" : draft.channel === "wechat" ? "微信订阅消息" : "站内消息"}</span><small>刚刚</small></header><h3>{draft.renderedTitle || draft.title || "通知标题"}</h3><p>{templateTextForOperator(draft.renderedBody || draft.body || "填写模板正文并使用示例数据预览。")}</p>{draft.buttonText ? <button type="button" tabIndex={-1}>{draft.buttonText}<CaretRight /></button> : null}</article><dl className="workflow-template-stats"><div><dt>字符数</dt><dd>{draft.characterCount ?? draft.body.length}</dd></div>{draft.channel === "sms" ? <div><dt>预估短信条数</dt><dd>{draft.estimatedSegments ?? 1}</dd></div> : null}<div><dt>点击后打开</dt><dd>{actionLabels[draft.actionCode || "none"] || "系统指定页面"}</dd></div></dl></section>
        <section><header><ShieldCheck /><div><strong>渠道状态</strong><small>密钥和密码不会进入后台页面</small></div></header><dl className="workflow-provider-status"><div><dt>服务商配置</dt><dd>{draft.channel === "sms" ? draft.providerTemplateIdMasked ? "短信模板已绑定" : "未配置模板编号" : draft.channel === "wechat" ? draft.wechatTemplateIdMasked ? "微信模板已绑定" : "未配置模板编号" : "平台内置"}</dd></div><div><dt>可用状态</dt><dd>{draft.channel === "sms" ? technicalStatusLabel(draft.providerStatus || "unreported") : technicalStatusLabel(draft.status)}</dd></div></dl></section>
        <section><header><ListChecks /><div><strong>使用与历史</strong><small>发布版本不可原地修改</small></div></header>{draft.usedBy?.length ? <ul className="workflow-usage-list">{draft.usedBy.map((usage) => <li key={`${usage.policyCode}-${usage.policyVersion}-${usage.nodeCode}`}><strong>{nodeLabels[usage.nodeCode] || "业务通知节点"}</strong><span>生效策略 · {versionLabel(usage.policyVersion)}</span></li>)}</ul> : <p className="workflow-side-empty">当前没有生效策略引用此模板。</p>}{draft.history?.length ? <ol className="workflow-history-mini">{draft.history.slice(0, 5).map((item) => <li key={item.version}><span>{versionLabel(item.version)}</span><div><strong>{technicalStatusLabel(item.status)}</strong><small>{formatDateTime(item.publishedAt)} · {actorLabel(item.publishedBy)}</small></div></li>)}</ol> : null}</section>
      </aside>
    </div>
  </main>;
}

function WorkflowRecipientCenter({ onError, canManage }: { onError: (message: string) => void; canManage: boolean }) {
  const [recipients, setRecipients] = useState<NotificationRecipient[]>([]);
  const [integration, setIntegration] = useState<IntegrationStatus>(emptyIntegrationStatus);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [kind, setKind] = useState<"station" | "repair_shop" | "platform_duty">("station");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [testTemplate, setTestTemplate] = useState("");
  const [testRecipient, setTestRecipient] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setLoading(true);
    try {
      const [recipientValue, integrationValue, templateValue, stationsValue, shopsValue] = await Promise.all([
        workflowRequest<unknown>("/recipients"),
        workflowRequest<unknown>("/integrations/status"),
        workflowRequest<unknown>("/templates?channel=sms"),
        api<unknown>("/admin/stations"),
        api<unknown>("/admin/repair/shops"),
      ]);
      const items = mergeServiceRecipients(safeItems<unknown>(recipientValue).map(normalizeRecipient), stationsValue, shopsValue);
      setRecipients(items);
      setIntegration(normalizeIntegration(integrationValue));
      const options = normalizeTemplateRows(templateValue).filter((item) => item.channel === "sms" && item.currentVersion != null && item.providerStatus === "approved").map(templateOption);
      setTemplates(options);
      setTestTemplate((current) => current || options[0]?.id || options[0]?.code || "");
      setTestRecipient((current) => current || items.find((item) => item.mobileMasked || item.mobile)?.id || "");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const updateRecipient = (id: string, patch: Partial<NotificationRecipient>) => setRecipients((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const saveRecipient = async (recipient: NotificationRecipient) => {
    if (!canManage) return;
    setBusy(recipient.id);
    try {
      const payload = {
        recipientType: recipient.recipientType || (recipient.kind === "platform_duty" ? "platform_duty" : "service_subject"),
        subjectType: recipient.kind === "platform_duty" ? null : recipient.subjectType || (recipient.kind === "repair_shop" ? "repair_shop" : "inspection_station"),
        subjectId: recipient.kind === "platform_duty" ? null : recipient.subjectId,
        contactName: recipient.contactName,
        ...(recipient.mobile ? { phone: recipient.mobile } : {}),
        isEnabled: recipient.enabled,
        dutySchedule: recipient.kind === "platform_duty" ? { start: recipient.dutyStart || "00:00", end: recipient.dutyEnd || "23:59" } : {},
      };
      const isNew = recipient.id.startsWith("new-duty-") || recipient.id.startsWith("new-service-");
      const resultValue = await workflowRequest<unknown>(isNew ? "/recipients" : `/recipients/${encodeURIComponent(recipient.id)}`, { method: isNew ? "POST" : "PUT", body: JSON.stringify(payload) });
      const result = normalizeRecipient(resultValue);
      setRecipients((current) => current.map((item) => item.id === recipient.id ? result : item));
      setNotice("通知联系人已保存；密钥与供应商密码未写入数据库。");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  const addDuty = async () => {
    if (!canManage) return;
    const id = `new-duty-${Date.now()}`;
    setRecipients((current) => [...current, { id, kind: "platform_duty", recipientType: "platform_duty", subjectType: null, subjectName: "平台值班组", contactName: "新值班联系人", mobile: "", mobileMasked: null, enabled: false, dutyStart: "00:00", dutyEnd: "23:59" }]);
    setKind("platform_duty");
  };
  const removeDuty = async (recipient: NotificationRecipient) => {
    if (!canManage || recipient.kind !== "platform_duty") return;
    if (recipient.id.startsWith("new-duty-")) {
      setRecipients((current) => current.filter((item) => item.id !== recipient.id));
      return;
    }
    setBusy(recipient.id);
    try {
      await workflowRequest(`/recipients/${encodeURIComponent(recipient.id)}`, { method: "DELETE" });
      setRecipients((current) => current.filter((item) => item.id !== recipient.id));
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  const sendTest = async () => {
    if (!canManage || !testTemplate || !testRecipient) return;
    setBusy("test-sms");
    try {
      await workflowRequest("/test-sms", { method: "POST", body: JSON.stringify({ templateId: testTemplate, recipientId: testRecipient }) });
      setNotice("测试短信已提交供应商；“已受理”不代表最终送达。测试限频为每分钟一次、每天最多五次。");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  if (loading) return <LoadingState label="正在读取通知联系人…" />;
  const filtered = recipients.filter((item) => item.kind === kind);
  const missingCount = recipients.filter((item) => item.kind !== "platform_duty" && !item.mobileMasked && !item.mobile).length;
  return <>
    {notice ? <div className="workflow-inline-notice success"><CheckCircle />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X /></button></div> : null}
    {missingCount ? <div className="workflow-inline-notice warning strong"><WarningCircle />有 {missingCount} 个服务主体缺少短信接收手机号。业务仍可继续，但短信兜底和超时升级无法送达，请尽快补齐。</div> : null}
    <section className="workflow-integration-grid">
      <article className={integration.smsbao.configured && integration.smsbao.enabled ? "ready" : "warning"}><span><Phone /></span><div><small>短信宝通知接口</small><strong>{integration.smsbao.configured ? integration.smsbao.enabled ? "已配置并启用" : "已配置但未启用" : "未配置"}</strong><p>{integration.smsbao.accountMasked ? "发送账号已配置" : "服务端配置未完成"} · {integration.smsbao.usableTemplates ?? 0} 个可用模板</p></div><em>{integration.smsbao.configured ? "仅显示配置状态" : "需要完成服务端配置"}</em></article>
      <article className={integration.wechat.configured && integration.wechat.enabled ? "ready" : "warning"}><span><BellRinging /></span><div><small>微信订阅消息</small><strong>{integration.wechat.configured ? integration.wechat.enabled ? "已配置并启用" : "已配置但未启用" : "待配置正式能力"}</strong><p>{integration.wechat.approvedTemplates ?? 0} 个审批模板 · 用户授权后才可发送</p></div><em>失败后短信兜底</em></article>
    </section>
    <section className="workflow-recipient-layout">
      <aside className="workflow-recipient-nav"><header><small>按责任主体分类</small><h2>通知联系人</h2></header>{(["station", "repair_shop", "platform_duty"] as const).map((value) => <button type="button" key={value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}><span>{value === "station" ? <ShieldCheck /> : value === "repair_shop" ? <Gear /> : <Siren />}</span><div><strong>{value === "station" ? "检测站联系人" : value === "repair_shop" ? "维修店联系人" : "平台值班组"}</strong><small>{recipients.filter((item) => item.kind === value).length} 人 / 主体</small></div><CaretRight /></button>)}<p><ShieldCheck />服务商联系人独立于车主可见客服电话。业务待办与超时提醒将发送至此手机号。</p></aside>
      <main className="workflow-recipient-main"><header><div><h2>{kind === "station" ? "检测站通知联系人" : kind === "repair_shop" ? "维修店通知联系人" : "平台值班组"}</h2><p>{kind === "platform_duty" ? "可配置多人及值班时段，异常与升级按生效时段路由。" : "缺少手机号不会阻止履约，但督办中心会持续强预警。"}</p></div>{kind === "platform_duty" ? <button type="button" className="primary" disabled={!canManage || Boolean(busy)} onClick={() => void addDuty()}><Plus />新增值班人</button> : null}</header><div className="workflow-recipient-cards">{filtered.map((recipient) => <article key={recipient.id} className={!recipient.mobileMasked && !recipient.mobile ? "missing" : ""}><header><span><UserCircle /></span><div><strong>{recipient.subjectName}</strong><small>{recipient.kind === "platform_duty" ? "平台异常升级" : "业务待办与超时接收人"}</small></div><label className="workflow-toggle compact"><input type="checkbox" checked={recipient.enabled} disabled={!canManage} onChange={(event) => updateRecipient(recipient.id, { enabled: event.target.checked })} /><span /><b>{recipient.enabled ? "启用" : "停用"}</b></label></header><div className="workflow-field-grid"><label><span>联系人</span><input value={recipient.contactName} disabled={!canManage} onChange={(event) => updateRecipient(recipient.id, { contactName: event.target.value })} /></label><label><span>短信接收手机号</span><input inputMode="numeric" autoComplete="off" maxLength={11} value={recipient.mobile ?? ""} disabled={!canManage} placeholder={recipient.mobileMasked ? `${recipient.mobileMasked}（留空表示不换号）` : "请输入11位手机号"} onChange={(event) => updateRecipient(recipient.id, { mobile: event.target.value.replace(/\D/gu, "") })} /></label>{recipient.kind === "platform_duty" ? <><label><span>值班开始</span><input type="time" value={recipient.dutyStart || "00:00"} disabled={!canManage} onChange={(event) => updateRecipient(recipient.id, { dutyStart: event.target.value })} /></label><label><span>值班结束</span><input type="time" value={recipient.dutyEnd || "23:59"} disabled={!canManage} onChange={(event) => updateRecipient(recipient.id, { dutyEnd: event.target.value })} /></label></> : null}</div>{!recipient.mobileMasked && !recipient.mobile ? <p className="workflow-recipient-warning"><WarningCircle />未配置手机号：微信失败或任务超时时无法短信兜底。</p> : <p className="workflow-recipient-note"><ShieldCheck />业务待办与超时提醒将发送至 {recipient.mobile || recipient.mobileMasked}。</p>}<footer>{recipient.kind === "platform_duty" ? <button type="button" className="danger" disabled={!canManage || busy === recipient.id} onClick={() => void removeDuty(recipient)}><Trash />删除</button> : <span /> }<button type="button" className="secondary" disabled={!canManage || Boolean(busy) || recipient.contactName.trim().length < 2 || (!recipient.mobile && !recipient.mobileMasked)} onClick={() => void saveRecipient(recipient)}><FloppyDisk />{busy === recipient.id ? "保存中…" : "保存联系人"}</button></footer></article>)}{!filtered.length ? <EmptyState title="暂无联系人" detail={kind === "platform_duty" ? "新增至少一位平台值班联系人以接收异常升级。" : "主体创建后会在此生成独立通知联系人配置。"} /> : null}</div></main>
      <aside className="workflow-test-sms"><header><PaperPlaneTilt /><div><h3>受限测试短信</h3><small>仅平台管理员 · 全程审计</small></div></header><p>仅选择已报备模板和已配置联系人。不会在页面输入或展示供应商密码、接口密钥。</p><label><span>已报备模板</span><select value={testTemplate} disabled={!canManage || !integration.smsbao.configured} onChange={(event) => setTestTemplate(event.target.value)}><option value="">请选择</option>{templates.map((template) => <option value={template.id || template.code} key={template.id || template.code}>{template.name}</option>)}</select></label><label><span>测试接收人</span><select value={testRecipient} disabled={!canManage || !integration.smsbao.configured} onChange={(event) => setTestRecipient(event.target.value)}><option value="">请选择</option>{recipients.filter((item) => item.enabled && !item.id.startsWith("new-duty-") && (item.mobileMasked || item.mobile)).map((item) => <option value={item.id} key={item.id}>{item.contactName} · {item.mobileMasked || item.mobile}</option>)}</select></label><button type="button" className="primary" disabled={!canManage || busy === "test-sms" || !integration.smsbao.configured || !testTemplate || !testRecipient} onClick={() => void sendTest()}><PaperPlaneTilt />{busy === "test-sms" ? "提交中…" : "发送测试短信"}</button><small>每分钟最多 1 次，每天最多 5 次；供应商成功响应仅表示已受理。</small></aside>
    </section>
  </>;
}

function WorkflowReleaseHistory({ onError, canManage, onOpenSection }: { onError: (message: string) => void; canManage: boolean; onOpenSection: (section: WorkflowAdminSection) => void }) {
  const [items, setItems] = useState<WorkflowRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [kind, setKind] = useState("");
  const [domain, setDomain] = useState("");
  const [selected, setSelected] = useState<WorkflowRelease | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (kind) query.set("kind", kind);
      if (domain) query.set("domain", domain);
      const value = await workflowRequest<unknown>(`/releases?${query.toString()}`);
      setItems(safeItems<unknown>(value).map(normalizeRelease).filter((item) => (!kind || item.kind === kind) && (!domain || item.domain === domain)));
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [kind, domain]);
  const restore = async (release: WorkflowRelease) => {
    if (!canManage) return;
    setBusy(release.id);
    try {
      await workflowRequest(`/releases/${encodeURIComponent(release.id)}/copy-to-draft`, { method: "POST" });
      onOpenSection(release.kind === "policy" ? "settings" : "templates");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  if (loading) return <LoadingState label="正在读取发布与审计记录…" />;
  return <section className="workflow-panel workflow-release-panel">
    <header className="workflow-panel-header"><div><small>历史版本只读留档</small><h2>发布与审计记录</h2><p>历史版本不可修改；恢复策略会复制成新草稿，校验后发布为新的递增版本。</p></div><div className="workflow-release-filters"><select aria-label="发布类型筛选" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option><option value="policy">督办策略</option><option value="template">通知模板</option></select><select aria-label="业务域筛选" value={domain} onChange={(event) => setDomain(event.target.value)}><option value="">全部业务</option><option value="annual_inspection">年检</option><option value="repair_quote">维修报价</option></select></div></header>
    <div className="workflow-release-list">
      <div className="workflow-release-table-head"><span>发布时间 / 发布人</span><span>发布内容</span><span>版本</span><span>变更摘要</span><span>状态</span><span>操作</span></div>
      {items.map((release) => <article key={release.id}>
        <div><strong>{formatDateTime(release.publishedAt)}</strong><small>{actorLabel(release.publishedBy)}</small></div>
        <div><strong>{release.name}</strong><small>{release.kind === "policy" ? "督办策略" : "通知模板"}</small></div>
        <div><strong>{versionLabel(release.version)}</strong>{release.rollbackSourceVersion ? <small>源自{versionLabel(release.rollbackSourceVersion)}</small> : null}</div>
        <div><p>{release.changeSummary || "未填写变更摘要"}</p>{release.validationWarnings ? <small className="warning"><Warning />{release.validationWarnings} 个发布预警</small> : null}</div>
        <div><span className={`release-status status-${release.status}`}>{releaseStatusLabels[release.status] || "已记录"}</span></div>
        <div><button type="button" className="secondary" onClick={() => setSelected(release)}><Eye />详情</button><button type="button" className="secondary" disabled={!canManage || Boolean(busy)} onClick={() => void restore(release)}><Copy />{busy === release.id ? "复制中…" : "复制为草稿"}</button></div>
      </article>)}
      {!items.length ? <EmptyState title="暂无发布记录" detail="策略或模板完成首次发布后，会在这里保留不可变审计记录。" /> : null}
    </div>
    {selected ? <div className="workflow-release-detail" role="dialog" aria-modal="true" aria-label="发布记录详情"><button type="button" aria-label="关闭发布记录详情" onClick={() => setSelected(null)}><X /></button><small>{selected.kind === "policy" ? "督办策略" : "通知模板"}</small><h3>{selected.name} · {versionLabel(selected.version)}</h3><dl><div><dt>内容类型</dt><dd>{selected.kind === "policy" ? "督办策略" : "通知模板"}</dd></div><div><dt>所属业务</dt><dd>{domainLabels[selected.domain || ""] || "通用"}</dd></div><div><dt>发布人</dt><dd>{actorLabel(selected.publishedBy)}</dd></div><div><dt>发布时间</dt><dd>{formatDateTime(selected.publishedAt)}</dd></div><div><dt>校验预警</dt><dd>{selected.validationWarnings ?? 0}</dd></div></dl><p>{selected.changeSummary ? safeOperationalMessage(selected.changeSummary, "本次发布已记录变更内容") : "未填写变更摘要"}</p></div> : null}
  </section>;
}
