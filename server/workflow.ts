import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import {
  assertCapability,
  BackofficeError,
  auditBackofficeEvent,
  requireBackoffice,
  requireRepairShopBearer,
  resolveInspectionStationBearer,
  type BackofficeSession,
} from "./backoffice.js";
import type { AppDatabase } from "./database.js";
import {
  DEFAULT_WORKFLOW_NODES,
  WORKFLOW_DOMAINS,
  WORKFLOW_NODE_CODES,
  WORKFLOW_TEMPLATE_VARIABLES,
  workflowTemplateDomain,
  type WorkflowDomain,
  type WorkflowNodeCode,
} from "./workflow-db.js";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

export type WorkflowProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

export class WorkflowDomainError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "WorkflowDomainError";
  }
}

export type WorkflowRouteOptions = {
  now?: () => Date;
  allowBackofficeTestFallback?: boolean;
  problem?: WorkflowProblemFactory;
};

export type WorkflowPolicyBinding = {
  id: string;
  domain: WorkflowDomain;
  entityType: string;
  entityId: string;
  policySetId: string;
  policyVersion: number;
  enabledAt: string;
};

export type EnableWorkflowInput = {
  domain: WorkflowDomain;
  entityType: string;
  entityId: string;
  ownerUserId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  createdAt?: Date | string;
};

export type WorkflowTaskTimingOverrides = {
  firstReminderAt?: Date | string | null;
  dueAt?: Date | string | null;
  escalateAt?: Date | string | null;
};

export type WorkflowTaskOpenInput = WorkflowTaskTimingOverrides & {
  nodeCode: WorkflowNodeCode | string;
  anchorAt?: Date | string;
  reminderScheduleAt?: Array<Date | string>;
  maxReminders?: number;
  recipientUserId?: string | null;
  recipientPhone?: string | null;
  recipientWechatOpenId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  assigneeRole?: string | null;
  metadata?: Json;
  sensitiveVariables?: { verificationCode?: string };
};

export type CreateWorkflowTaskInput = WorkflowTaskOpenInput & {
  domain: WorkflowDomain;
  entityType: string;
  entityId: string;
};

export type ApplyWorkflowTransitionInput = {
  domain: WorkflowDomain;
  entityType: string;
  entityId: string;
  closeTaskIds?: string[];
  closeNodeCodes?: string[];
  closeReason?: string;
  open?: WorkflowTaskOpenInput[];
  forceCreateNodeCodes?: string[];
  actorType?: "system" | "owner" | "station" | "operator" | "driver" | "repair_shop" | "platform" | "external_system";
  actorId?: string | null;
};

export type WorkflowTemplateVariables = Partial<Record<typeof WORKFLOW_TEMPLATE_VARIABLES[number], string | number>>;

export type WorkflowNotificationQueueResult = {
  inboxQueued: boolean;
  outboxQueued: boolean;
  /**
   * The assigned service role can already see this task in its authenticated
   * task centre. This is supervision visibility, not a delivered message.
   */
  taskCenterVisible: boolean;
  queued: boolean;
};

type ExternalRecipient = {
  encrypted: string;
  masked: string | null;
  hash: string | null;
};

export type WorkflowValidationIssue = {
  severity: "error" | "warning";
  code: string;
  nodeCode?: string;
  field?: string;
  message: string;
};

type BusinessHours = {
  weekdays: number[];
  start: string;
  end: string;
  holidays: string[];
};

const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  weekdays: [1, 2, 3, 4, 5, 6],
  start: "08:00",
  end: "18:00",
  holidays: [],
};
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const ACTION_CODES = new Set([
  "annual.order.detail",
  "annual.report.detail",
  "repair.request.detail",
  "repair.quotes",
  "operator.booking.detail",
  "operator.precheck.detail",
  "repair.shop.request.detail",
  "driver.task.detail",
  "workflow.task.detail",
]);
const EXTERNAL_CHANNELS = new Set(["sms", "wechat"]);
const TASK_CENTER_ROLES = new Set(["station", "repair_shop", "driver", "platform"]);
const GLOBAL_TEMPLATE_VARIABLES = new Set<string>(WORKFLOW_TEMPLATE_VARIABLES);
const WECHAT_FIELD_PATTERN = /^(?:thing|number|letter|symbol|character_string|time|date|amount|phone_number|car_number|name|phrase|enum)\d+$/u;
const TEMPLATE_URL_PATTERN = /(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|app)\b)/iu;
const FULL_MOBILE_PATTERN = /(^|\D)1[3-9]\d{9}(?!\d)/u;
const DETAILED_ADDRESS_PATTERN = /[\u4e00-\u9fff]{2,}(?:省|市|区|县|镇|乡|街道)[\u4e00-\u9fffA-Za-z0-9-]{2,}(?:路|街|道|巷|村|号|栋|室)/u;
const PHONE_PATTERN = /^1[3-9]\d{9}$/u;
const RETRY_MINUTES = [1, 5, 15, 30, 60] as const;

function domainError(statusCode: number, code: string, message: string, fields?: Record<string, string>): never {
  throw new WorkflowDomainError(statusCode, code, message, fields);
}

function asIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) domainError(400, "WORKFLOW_TIME_INVALID", "时间格式无效");
  return parsed.toISOString();
}

function jsonObject(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return jsonArray(value).filter((item): item is string => typeof item === "string");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function normalizeBusinessHours(value: unknown): BusinessHours {
  const parsed = jsonObject(value);
  const weekdays = Array.isArray(parsed.weekdays)
    ? parsed.weekdays.filter((item): item is number => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 6)
    : DEFAULT_BUSINESS_HOURS.weekdays;
  const start = typeof parsed.start === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(parsed.start)
    ? parsed.start
    : DEFAULT_BUSINESS_HOURS.start;
  const end = typeof parsed.end === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(parsed.end)
    ? parsed.end
    : DEFAULT_BUSINESS_HOURS.end;
  const holidays = Array.isArray(parsed.holidays)
    ? parsed.holidays.filter((item): item is string => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(item))
    : [];
  return { weekdays: weekdays.length > 0 ? [...new Set(weekdays)] : DEFAULT_BUSINESS_HOURS.weekdays, start, end, holidays };
}

function shanghaiParts(value: Date): { date: string; weekday: number; minuteOfDay: number } {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function dutyScheduleActive(value: unknown, now: Date): boolean {
  const schedule = jsonObject(value);
  const startText = typeof schedule.start === "string" ? schedule.start : null;
  const endText = typeof schedule.end === "string" ? schedule.end : null;
  if (!startText || !endText
    || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(startText)
    || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(endText)) return true;
  const parts = shanghaiParts(now);
  const start = clockMinutes(startText);
  const end = clockMinutes(endText);
  const configuredDays = Array.isArray(schedule.weekdays)
    ? schedule.weekdays.filter((day): day is number => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    : [];
  if (start === end) return configuredDays.length === 0 || configuredDays.includes(parts.weekday);
  const overnight = start > end;
  const inWindow = overnight
    ? parts.minuteOfDay >= start || parts.minuteOfDay < end
    : parts.minuteOfDay >= start && (end === 23 * 60 + 59 ? parts.minuteOfDay <= end : parts.minuteOfDay < end);
  if (!inWindow || configuredDays.length === 0) return inWindow;
  const effectiveWeekday = overnight && parts.minuteOfDay < end ? (parts.weekday + 6) % 7 : parts.weekday;
  return configuredDays.includes(effectiveWeekday);
}

function isBusinessMinute(value: Date, schedule: BusinessHours): boolean {
  const parts = shanghaiParts(value);
  return schedule.weekdays.includes(parts.weekday)
    && !schedule.holidays.includes(parts.date)
    && parts.minuteOfDay >= clockMinutes(schedule.start)
    && parts.minuteOfDay < clockMinutes(schedule.end);
}

/** Adds configured minutes while preserving a frozen Asia/Shanghai business calendar. */
export function addWorkflowMinutes(
  anchor: Date,
  minutes: number | null,
  timerMode: "business" | "natural",
  businessHours: unknown = DEFAULT_BUSINESS_HOURS,
): Date | null {
  if (minutes == null) return null;
  if (!Number.isInteger(minutes) || minutes < 0) domainError(400, "WORKFLOW_DURATION_INVALID", "提醒时长必须是非负整数分钟");
  if (minutes === 0 || timerMode === "natural") return new Date(anchor.getTime() + minutes * 60_000);
  const schedule = normalizeBusinessHours(businessHours);
  let cursor = new Date(anchor.getTime());
  let remaining = minutes;
  // A policy is capped by API validation; the guard prevents corrupted rows from causing an unbounded loop.
  const maximumIterations = 370 * 24 * 60;
  let iterations = 0;
  while (remaining > 0 && iterations < maximumIterations) {
    cursor = new Date(cursor.getTime() + 60_000);
    if (isBusinessMinute(cursor, schedule)) remaining -= 1;
    iterations += 1;
  }
  if (remaining > 0) domainError(500, "WORKFLOW_BUSINESS_CALENDAR_INVALID", "营业时间配置无法计算任务时限");
  return cursor;
}

export function workflowExternalAvailableAt(
  now: Date,
  quietHours: unknown,
  options: { ownerNonUrgent: boolean },
): Date {
  if (!options.ownerNonUrgent) return now;
  const quiet = jsonObject(quietHours);
  if (typeof quiet.start !== "string" || typeof quiet.end !== "string"
    || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(quiet.start)
    || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(quiet.end)) return now;
  const start = clockMinutes(quiet.start);
  const end = clockMinutes(quiet.end);
  if (start === end) return now;
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const crossesMidnight = start > end;
  const inQuiet = crossesMidnight ? minute >= start || minute < end : minute >= start && minute < end;
  if (!inQuiet) return now;
  const target = new Date(local.getTime());
  if (crossesMidnight && minute >= start) target.setUTCDate(target.getUTCDate() + 1);
  target.setUTCHours(Math.floor(end / 60), end % 60, 0, 0);
  return new Date(target.getTime() - SHANGHAI_OFFSET_MS);
}

function dataKey(): Buffer | null {
  const configured = process.env.WORKFLOW_NOTIFICATION_DATA_KEY?.trim();
  if (configured) {
    try {
      const decoded = Buffer.from(configured, "base64");
      if (decoded.length === 32) return decoded;
    } catch {
      return null;
    }
    return null;
  }
  if (process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production") return null;
  return createHash("sha256").update("yuxiaoman-workflow-development-data-key-v1").digest();
}

function workflowHmac(value: string): string {
  const key = dataKey();
  if (!key) domainError(503, "WORKFLOW_DATA_KEY_MISSING", "通知隐私数据密钥尚未配置");
  return createHmac("sha256", key).update(value).digest("hex");
}

function encryptWorkflowValue(value: string): string {
  const key = dataKey();
  if (!key) domainError(503, "WORKFLOW_DATA_KEY_MISSING", "通知隐私数据密钥尚未配置");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptWorkflowValue(value: string): string {
  const key = dataKey();
  if (!key) domainError(503, "WORKFLOW_DATA_KEY_MISSING", "通知隐私数据密钥尚未配置");
  const [version, ivText, tagText, encryptedText] = value.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) domainError(500, "WORKFLOW_CIPHERTEXT_INVALID", "通知隐私数据无法解密");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    domainError(500, "WORKFLOW_CIPHERTEXT_INVALID", "通知隐私数据无法解密");
  }
}

function maskedPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : "***";
}

function maskedOpenId(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export function workflowIntegrationStatus() {
  const username = process.env.SMSBAO_USERNAME?.trim() ?? "";
  const smsConfigured = process.env.SMSBAO_ENABLED === "true"
    && Boolean(username)
    && Boolean(process.env.SMSBAO_API_KEY?.trim())
    && Boolean(process.env.SMSBAO_SIGNATURE?.trim());
  const wechatConfigured = Boolean(
    (process.env.WECHAT_MINIPROGRAM_APP_ID ?? process.env.WECHAT_APP_ID)?.trim()
    && (process.env.WECHAT_MINIPROGRAM_APP_SECRET ?? process.env.WECHAT_APP_SECRET)?.trim(),
  );
  return {
    dataProtection: { configured: dataKey() !== null },
    smsBao: {
      enabled: process.env.SMSBAO_ENABLED === "true",
      configured: smsConfigured,
      accountMasked: username ? `${username.slice(0, 2)}***${username.slice(-2)}` : null,
      signatureConfigured: Boolean(process.env.SMSBAO_SIGNATURE?.trim()),
      apiKeyConfigured: Boolean(process.env.SMSBAO_API_KEY?.trim()),
      deliverySemantics: "accepted_not_delivered" as const,
    },
    wechat: {
      configured: wechatConfigured,
      templatesRequireApproval: true,
    },
  };
}

export function templatePlaceholders(body: string): string[] {
  return [...body.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu)].map((match) => match[1]);
}

export function renderWorkflowTemplate(body: string, variables: WorkflowTemplateVariables): string {
  return body.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu, (_source, name: string) => {
    if (!GLOBAL_TEMPLATE_VARIABLES.has(name)) domainError(400, "WORKFLOW_TEMPLATE_VARIABLE_FORBIDDEN", `模板变量 ${name} 不在白名单中`);
    const value = variables[name as keyof WorkflowTemplateVariables];
    return value == null ? "—" : String(value);
  });
}

export function estimateSmsSegments(body: string): number {
  if (body.length <= 70) return 1;
  return Math.ceil(body.length / 67);
}

type WechatTemplateConfiguration = {
  providerTemplateId?: unknown;
  providerSnapshot?: unknown;
  allowedVariables?: unknown;
};

function wechatTemplateConfigurationIssues(template: WechatTemplateConfiguration): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  if (typeof template.providerTemplateId !== "string" || !template.providerTemplateId.trim()) {
    issues.push({ severity: "error", code: "WECHAT_TEMPLATE_ID_REQUIRED", field: "providerTemplateId", message: "微信渠道必须绑定已审批的微信模板 ID" });
  }
  const providerSnapshot = jsonObject(template.providerSnapshot);
  const mappings = Array.isArray(providerSnapshot.fieldMappings) ? providerSnapshot.fieldMappings : [];
  const allowed = new Set(stringArray(template.allowedVariables));
  if (mappings.length === 0) {
    issues.push({ severity: "error", code: "WECHAT_FIELD_MAPPING_REQUIRED", field: "providerSnapshot.fieldMappings", message: "微信模板必须配置至少一个审批字段映射" });
    return issues;
  }
  const fields = new Set<string>();
  for (const rawMapping of mappings) {
    const mapping = jsonObject(rawMapping);
    const field = typeof mapping.field === "string" ? mapping.field.trim() : "";
    const variable = typeof mapping.variable === "string" ? mapping.variable.trim() : "";
    if (!WECHAT_FIELD_PATTERN.test(field)) {
      issues.push({ severity: "error", code: "WECHAT_FIELD_INVALID", field: "providerSnapshot.fieldMappings", message: `微信字段 ${field || "（空）"} 格式无效` });
    } else if (fields.has(field)) {
      issues.push({ severity: "error", code: "WECHAT_FIELD_DUPLICATE", field: "providerSnapshot.fieldMappings", message: `微信字段 ${field} 不能重复映射` });
    }
    fields.add(field);
    if (!allowed.has(variable) || !GLOBAL_TEMPLATE_VARIABLES.has(variable)) {
      issues.push({ severity: "error", code: "WECHAT_FIELD_VARIABLE_INVALID", field: "providerSnapshot.fieldMappings", message: `微信字段 ${field || "（空）"} 必须映射到该模板已声明的白名单变量` });
    }
  }
  return issues;
}

export function workflowExternalTemplateUsable(channel: string, template: Json): boolean {
  const integration = workflowIntegrationStatus();
  if (channel === "sms") {
    return template.filingStatus === "approved" && integration.smsBao.configured;
  }
  if (channel === "wechat") {
    return integration.wechat.configured
      && wechatTemplateConfigurationIssues({
        providerTemplateId: template.providerTemplateId,
        providerSnapshot: template.providerSnapshot,
        allowedVariables: template.allowedVariables,
      }).length === 0;
  }
  return false;
}

function sanitizedTemplateVariables(metadata: Json | undefined): WorkflowTemplateVariables {
  const result: WorkflowTemplateVariables = {};
  if (!metadata) return result;
  for (const key of WORKFLOW_TEMPLATE_VARIABLES) {
    if (key === "verificationCode") continue;
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  return result;
}

const WORKFLOW_INTERNAL_METADATA_KEYS = ["sourceTaskId", "failureReason", "escalationLevel"] as const;

/**
 * Task metadata contains the public template-variable snapshot plus a very
 * small allowlist used by the workflow engine itself. Notification rendering
 * still calls sanitizedTemplateVariables, so these internal correlation
 * fields can never become template variables accidentally.
 */
function sanitizedTaskMetadata(metadata: Json | undefined): Json {
  const result: Json = { ...sanitizedTemplateVariables(metadata) };
  if (!metadata) return result;
  for (const key of WORKFLOW_INTERNAL_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) result[key] = value.trim().slice(0, 300);
  }
  return result;
}

function policyBindingDto(row: Row): WorkflowPolicyBinding {
  return {
    id: String(row.id),
    domain: String(row.domain) as WorkflowDomain,
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    policySetId: String(row.policy_set_id),
    policyVersion: Number(row.policy_version),
    enabledAt: String(row.enabled_at),
  };
}

export async function enableWorkflowForEntity(
  database: AppDatabase,
  input: EnableWorkflowInput,
): Promise<WorkflowPolicyBinding | null> {
  if (!WORKFLOW_DOMAINS.includes(input.domain)) domainError(400, "WORKFLOW_DOMAIN_INVALID", "督办业务领域无效");
  let existing = await database.prepare<Row>(`
    SELECT * FROM workflow_entity_bindings
    WHERE domain = ? AND entity_type = ? AND entity_id = ?
  `).get(input.domain, input.entityType, input.entityId);
  if (existing) return policyBindingDto(existing);
  const policy = await database.prepare<Row>(`
    SELECT id, version FROM workflow_policy_sets
    WHERE domain = ? AND state = 'published' AND is_current = 1
    LIMIT 1
  `).get(input.domain);
  if (!policy) return null;
  const now = asIso(input.createdAt ?? new Date());
  const id = randomUUID();
  await database.prepare(`
    INSERT INTO workflow_entity_bindings (
      id, domain, entity_type, entity_id, owner_user_id, subject_type, subject_id,
      policy_set_id, policy_version, enabled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (domain, entity_type, entity_id) DO NOTHING
  `).run(
    id,
    input.domain,
    input.entityType,
    input.entityId,
    input.ownerUserId ?? null,
    input.subjectType ?? null,
    input.subjectId ?? null,
    String(policy.id),
    Number(policy.version),
    now,
  );
  const row = await database.prepare<Row>(`
    SELECT * FROM workflow_entity_bindings
    WHERE domain = ? AND entity_type = ? AND entity_id = ?
  `).get(input.domain, input.entityType, input.entityId);
  return row ? policyBindingDto(row) : null;
}

async function taskTemplateSnapshot(database: AppDatabase, bindings: Json): Promise<Json> {
  const result: Json = {};
  for (const channel of ["in_app", "wechat", "sms"] as const) {
    const templateId = bindings[channel];
    if (typeof templateId !== "string" || !templateId) continue;
    const row = await database.prepare<Row>(`
      SELECT current.id, current.stable_code, current.channel, current.version, current.state,
        current.title, current.body, current.button_text, current.action_code,
        current.allowed_variables_json, current.provider_template_id,
        current.provider_snapshot_json, current.filing_status
      FROM notification_templates bound
      INNER JOIN notification_templates current
        ON current.stable_code = bound.stable_code
       AND current.channel = bound.channel
       AND current.state = 'published'
       AND current.is_current = 1
      WHERE bound.id = ? AND bound.state = 'published'
    `).get(templateId);
    if (!row) continue;
    result[channel] = {
      id: String(row.id),
      code: String(row.stable_code),
      channel: String(row.channel),
      version: Number(row.version),
      title: String(row.title ?? ""),
      body: String(row.body),
      buttonText: row.button_text == null ? null : String(row.button_text),
      actionCode: String(row.action_code),
      allowedVariables: stringArray(row.allowed_variables_json),
      providerTemplateId: row.provider_template_id == null ? null : String(row.provider_template_id),
      providerSnapshot: jsonObject(row.provider_snapshot_json),
      filingStatus: String(row.filing_status),
    };
  }
  return result;
}

function taskRowDto(row: Row) {
  const metadata = jsonObject(row.metadata_json);
  const templateSnapshot = jsonObject(row.template_bindings_snapshot_json);
  const inAppTemplate = jsonObject(templateSnapshot.in_app);
  const nodeSnapshot = jsonObject(row.policy_node_snapshot_json);
  const enabledChannels = stringArray(nodeSnapshot.enabledChannels);
  const taskCenterVisible = enabledChannels.includes("in_app")
    && TASK_CENTER_ROLES.has(String(row.assignee_role));
  const now = Date.now();
  const dueAt = row.due_at == null ? null : String(row.due_at);
  const escalateAt = row.escalate_at == null ? null : String(row.escalate_at);
  const dueMs = dueAt ? new Date(dueAt).getTime() : null;
  const firstReminderMs = row.first_reminder_at == null ? null : new Date(String(row.first_reminder_at)).getTime();
  const escalated = row.escalated_at != null || (escalateAt != null && new Date(escalateAt).getTime() <= now);
  const overdue = dueMs != null && dueMs <= now;
  const dueSoon = !overdue && dueMs != null
    && (dueMs - now <= 30 * 60_000 || (firstReminderMs != null && firstReminderMs <= now));
  return {
    id: String(row.id),
    domain: String(row.domain),
    nodeCode: String(row.node_code),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    assigneeRole: String(row.assignee_role),
    subject: row.subject_type == null ? null : { type: String(row.subject_type), id: String(row.subject_id) },
    subjectName: row.subject_name == null ? null : String(row.subject_name),
    status: String(row.status),
    taskKind: String(row.task_kind),
    policy: { id: String(row.policy_set_id), version: Number(row.policy_version) },
    anchorAt: String(row.anchor_at),
    firstReminderAt: row.first_reminder_at == null ? null : String(row.first_reminder_at),
    nextReminderAt: row.next_reminder_at == null ? null : String(row.next_reminder_at),
    dueAt,
    escalateAt,
    reminderCount: Number(row.reminder_count),
    maxReminders: Number(row.max_reminders),
    reminderScheduleAt: stringArray(row.reminder_schedule_json),
    lastRemindedAt: row.last_reminded_at == null ? null : String(row.last_reminded_at),
    escalatedAt: row.escalated_at == null ? null : String(row.escalated_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    closeReason: row.closed_reason == null ? null : String(row.closed_reason),
    urgency: escalated ? "escalated" : overdue ? "overdue" : dueSoon ? "due_soon" : "normal",
    remainingSeconds: dueMs == null ? null : Math.max(0, Math.floor((dueMs - now) / 1_000)),
    metadata,
    taskCenterVisible,
    inAppSupervisionMode: taskCenterVisible
      ? "task_center"
      : enabledChannels.includes("in_app") && row.recipient_user_id != null && inAppTemplate.id
        ? "owner_inbox"
        : "none",
    actionCode: typeof inAppTemplate.actionCode === "string" ? inAppTemplate.actionCode : "workflow.task.detail",
    actionParams: workflowActionParams(String(row.entity_type), String(row.entity_id), String(row.id)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function workflowActionParams(entityType: string, entityId: string, taskId: string): Json {
  return {
    entityType,
    entityId,
    resourceId: entityId,
    taskId,
    ...(entityType === "booking" ? { bookingId: entityId } : {}),
    ...(entityType === "repair_request" ? { repairRequestId: entityId } : {}),
  };
}

function timingValue(
  override: Date | string | null | undefined,
  anchor: Date,
  minutes: number | null,
  mode: "business" | "natural",
  businessHours: unknown,
): string | null {
  if (override !== undefined) return override == null ? null : asIso(override);
  return addWorkflowMinutes(anchor, minutes, mode, businessHours)?.toISOString() ?? null;
}

function workflowDurationLabel(minutes: number, mode: "business" | "natural"): string {
  const safeMinutes = Math.max(0, Math.floor(minutes));
  if (safeMinutes > 0 && safeMinutes % (24 * 60) === 0) {
    return mode === "business"
      ? `${safeMinutes / (24 * 60)} 个营业日`
      : `${safeMinutes / (24 * 60)} 天`;
  }
  if (safeMinutes > 0 && safeMinutes % 60 === 0) {
    return mode === "business"
      ? `${safeMinutes / 60} 个营业小时`
      : `${safeMinutes / 60} 小时`;
  }
  return mode === "business"
    ? `${safeMinutes} 个营业分钟`
    : `${safeMinutes} 分钟`;
}

function workflowWechatAppId(): string {
  return (process.env.WECHAT_MINIPROGRAM_APP_ID ?? process.env.WECHAT_APP_ID)?.trim() ?? "";
}

/** Owner-facing WeChat once-subscribe prompts keyed by product moment. */
export const OWNER_WECHAT_SUBSCRIPTION_PURPOSES = {
  message_center: null,
  // After pay: precheck outcome, report ready, and inspection-started notice (max 3 tmplIds).
  // annual.arrival.owner is the "检测已开始" slot for both self-drive and valet (fires on inspecting).
  post_payment: [
    "annual.precheck.action_required",
    "annual.report.ready",
    "annual.arrival.owner",
  ],
} as const;

export type OwnerWechatSubscriptionPurpose = keyof typeof OWNER_WECHAT_SUBSCRIPTION_PURPOSES;

export async function ownerWechatSubscriptionTemplates(
  database: AppDatabase,
  purpose: OwnerWechatSubscriptionPurpose = "message_center",
): Promise<Array<{ nodeCode: string; providerTemplateId: string }>> {
  if (!workflowIntegrationStatus().wechat.configured || !workflowWechatAppId()) return [];
    const preferredNodeCodes = OWNER_WECHAT_SUBSCRIPTION_PURPOSES[purpose];
  const nodes = await database.prepare<Row>(`
    SELECT node.node_code, node.enabled_channels_json, node.template_bindings_json
    FROM workflow_policy_nodes node
    INNER JOIN workflow_policy_sets policy ON policy.id = node.policy_set_id
    WHERE policy.state = 'published' AND policy.is_current = 1
      AND node.is_enabled = 1 AND node.assignee_role = 'owner'
    ORDER BY policy.domain, node.sort_order, node.node_code
  `).all();
  const entries: Array<{ nodeCode: string; providerTemplateId: string }> = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const nodeCode = String(node.node_code);
    if (preferredNodeCodes && !(preferredNodeCodes as readonly string[]).includes(nodeCode)) continue;
    if (!stringArray(node.enabled_channels_json).includes("wechat")) continue;
    const boundTemplateId = jsonObject(node.template_bindings_json).wechat;
    if (typeof boundTemplateId !== "string" || !boundTemplateId) continue;
    const template = await database.prepare<Row>(`
      SELECT current.stable_code, current.provider_template_id, current.provider_snapshot_json,
        current.allowed_variables_json
      FROM notification_templates bound
      INNER JOIN notification_templates current
        ON current.stable_code = bound.stable_code
       AND current.channel = bound.channel
       AND current.state = 'published'
       AND current.is_current = 1
      WHERE bound.id = ? AND bound.state = 'published' AND bound.channel = 'wechat'
      LIMIT 1
    `).get(boundTemplateId);
    if (!template) continue;
    const matchesOwnerNode = DEFAULT_WORKFLOW_NODES.some((definition) => (
      definition.code === nodeCode
      && definition.assigneeRole === "owner"
      && definition.templateCode === String(template.stable_code)
    ));
    const providerTemplateId = String(template.provider_template_id ?? "").trim();
    const configured = wechatTemplateConfigurationIssues({
      providerTemplateId,
      providerSnapshot: template.provider_snapshot_json,
      allowedVariables: template.allowed_variables_json,
    }).length === 0;
    if (!matchesOwnerNode || !configured || seen.has(providerTemplateId)) continue;
    seen.add(providerTemplateId);
    entries.push({ nodeCode, providerTemplateId });
  }
  if (!preferredNodeCodes) return entries;
  const byNode = new Map(entries.map((item) => [item.nodeCode, item]));
  return preferredNodeCodes
    .map((nodeCode) => byNode.get(nodeCode))
    .filter((item): item is { nodeCode: string; providerTemplateId: string } => Boolean(item));
}

export async function ownerWechatSubscriptionTemplateIds(
  database: AppDatabase,
  purpose: OwnerWechatSubscriptionPurpose = "message_center",
): Promise<string[]> {
  return (await ownerWechatSubscriptionTemplates(database, purpose)).map((item) => item.providerTemplateId);
}

export async function workflowWechatAuthorizationAvailable(
  database: AppDatabase,
  task: Row,
  template: Json,
): Promise<boolean> {
  const appId = workflowWechatAppId();
  if (!appId || task.recipient_user_id == null || typeof template.providerTemplateId !== "string") return false;
  const row = await database.prepare<Row>(`
    SELECT id FROM wechat_subscription_authorizations
    WHERE user_id = ? AND template_id = ? AND authorization_state = 'accepted'
      AND remaining_uses > 0
      AND provider_app_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(
    String(task.recipient_user_id), String(template.providerTemplateId), appId,
  );
  return Boolean(row);
}

async function externalRecipients(
  database: AppDatabase,
  task: Row,
  channel: string,
  at: Date,
): Promise<ExternalRecipient[]> {
  if (channel === "sms" && String(task.assignee_role) === "platform"
    && String(task.subject_type) === "platform_duty") {
    const rows = await database.prepare<Row>(`
      SELECT phone_encrypted, phone_masked, phone_hash, duty_schedule_json
      FROM workflow_notification_recipients
      WHERE recipient_type = 'platform_duty' AND is_enabled = 1
      ORDER BY created_at, id
    `).all();
    return rows
      .filter((row) => dutyScheduleActive(row.duty_schedule_json, at))
      .map((row) => ({
        encrypted: String(row.phone_encrypted),
        masked: row.phone_masked == null ? null : String(row.phone_masked),
        hash: row.phone_hash == null ? null : String(row.phone_hash),
      }));
  }
  const encrypted = channel === "sms" ? task.recipient_phone_encrypted : task.recipient_wechat_openid_encrypted;
  if (encrypted == null) return [];
  return [{
    encrypted: String(encrypted),
    masked: (channel === "sms" ? task.recipient_phone_masked : task.recipient_wechat_openid_masked) == null
      ? null
      : String(channel === "sms" ? task.recipient_phone_masked : task.recipient_wechat_openid_masked),
    hash: (channel === "sms" ? task.recipient_phone_hash : task.recipient_wechat_openid_hash) == null
      ? null
      : String(channel === "sms" ? task.recipient_phone_hash : task.recipient_wechat_openid_hash),
  }];
}

function aggregateWindow(task: Row, template: Json, channel: string, recipientHash: string | null, at: Date) {
  if (!["station", "repair_shop", "platform"].includes(String(task.assignee_role))) {
    return { key: null, availableAt: at };
  }
  const windowMs = 30 * 60_000;
  const bucket = Math.floor(at.getTime() / windowMs);
  // Exception tasks use their source task id as subject_id for independent
  // lifecycle/identity. All of them still belong to the same platform duty
  // group and must aggregate together for notification rate control.
  const aggregateSubjectId = String(task.subject_type) === "platform_duty"
    ? "current"
    : String(task.subject_id ?? "current");
  return {
    key: [
      String(task.subject_type ?? task.assignee_role), aggregateSubjectId,
      recipientHash ?? "unknown", channel, String(template.id), String(template.version), String(bucket),
    ].join(":"),
    availableAt: new Date((bucket + 1) * windowMs),
  };
}

export async function queueWorkflowTaskNotification(
  database: AppDatabase,
  task: Row,
  reason: "created" | "reminder" | "overdue" | "escalation" | "manual",
  occurrence: number,
  now: Date,
  sensitiveVariables?: { verificationCode?: string },
): Promise<WorkflowNotificationQueueResult> {
  const snapshot = jsonObject(task.template_bindings_snapshot_json);
  const nodeSnapshot = jsonObject(task.policy_node_snapshot_json);
  const enabledChannels = Array.isArray(nodeSnapshot.enabledChannels)
    ? nodeSnapshot.enabledChannels.filter((value): value is string => typeof value === "string")
    : ["in_app"];
  const fallbackChannels = Array.isArray(nodeSnapshot.fallbackOrder)
    ? nodeSnapshot.fallbackOrder.filter((value): value is string => typeof value === "string")
    : [];
  const variables = sanitizedTemplateVariables(jsonObject(task.metadata_json));
  const safeVariables = { ...variables, ...(sensitiveVariables?.verificationCode ? { verificationCode: "******" } : {}) };
  const taskId = String(task.id);
  const baseDedupe = `${taskId}:${reason}:${occurrence}`;
  const inApp = jsonObject(snapshot.in_app);
  const taskCenterVisible = enabledChannels.includes("in_app")
    && TASK_CENTER_ROLES.has(String(task.assignee_role));
  let inboxQueued = false;
  if (enabledChannels.includes("in_app") && task.recipient_user_id != null && inApp.id) {
    const title = renderWorkflowTemplate(String(inApp.title ?? ""), safeVariables);
    const body = renderWorkflowTemplate(String(inApp.body ?? ""), safeVariables);
    const result = await database.prepare(`
      INSERT INTO notification_inbox (
        id, task_id, recipient_user_id, template_id, title, body,
        action_code, action_params_json, dedupe_key, read_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT (dedupe_key) DO NOTHING
    `).run(
      randomUUID(), taskId, String(task.recipient_user_id), String(inApp.id), title, body,
      String(inApp.actionCode ?? "workflow.task.detail"),
      safeJson(workflowActionParams(String(task.entity_type), String(task.entity_id), taskId)),
      `${baseDedupe}:in_app`, now.toISOString(),
    );
    inboxQueued = result.changes === 1;
  }

  // fallbackOrder defines priority only among explicitly enabled external
  // channels. Merely having an in-app message must not accidentally trigger an
  // SMS. An unavailable/unauthorised WeChat route is skipped immediately so an
  // enabled SMS fallback can take over.
  const enabledExternal = enabledChannels.filter((channel) => EXTERNAL_CHANNELS.has(channel));
  const externalCandidates = [
    ...fallbackChannels.filter((channel) => enabledExternal.includes(channel)),
    ...enabledExternal.filter((channel) => !fallbackChannels.includes(channel)),
  ];
  let externalChannel: string | undefined;
  let recipients: ExternalRecipient[] = [];
  for (const candidate of [...new Set(externalCandidates)]) {
    const template = jsonObject(snapshot[candidate]);
    if (!workflowExternalTemplateUsable(candidate, template)) continue;
    if (candidate === "wechat" && !await workflowWechatAuthorizationAvailable(database, task, template)) continue;
    const candidateRecipients = await externalRecipients(database, task, candidate, now);
    if (candidateRecipients.length === 0) continue;
    externalChannel = candidate;
    recipients = candidateRecipients;
    break;
  }
  if (!externalChannel) return { inboxQueued, outboxQueued: false, taskCenterVisible, queued: inboxQueued };
  const external = jsonObject(snapshot[externalChannel]);
  if (!external.id || external.version == null) {
    return { inboxQueued, outboxQueued: false, taskCenterVisible, queued: inboxQueued };
  }
  const sensitivePayload = sensitiveVariables?.verificationCode
    ? encryptWorkflowValue(JSON.stringify({ verificationCode: sensitiveVariables.verificationCode }))
    : null;
  const title = renderWorkflowTemplate(String(external.title ?? ""), safeVariables);
  const body = renderWorkflowTemplate(String(external.body ?? ""), safeVariables);
  const remainingFallback = externalCandidates.slice(externalCandidates.indexOf(externalChannel) + 1);
  const quietAvailableAt = workflowExternalAvailableAt(now, nodeSnapshot.quietHours, {
    ownerNonUrgent: String(task.assignee_role) === "owner" && (reason === "created" || reason === "reminder"),
  });
  let outboxQueued = false;
  for (const recipient of recipients) {
    const aggregation = sensitiveVariables?.verificationCode
      ? { key: null, availableAt: now }
      : aggregateWindow(task, external, externalChannel, recipient.hash, now);
    const availableAt = new Date(Math.max(quietAvailableAt.getTime(), aggregation.availableAt.getTime()));
    const recipientSuffix = recipient.hash ? `:${recipient.hash}` : "";
    const dedupeKey = `${baseDedupe}:${externalChannel}${recipientSuffix}`;
    const result = await database.prepare(`
      INSERT INTO notification_outbox (
        id, task_id, channel, status, template_id, template_code, template_version,
        rendered_title, rendered_body, action_code, action_params_json,
        recipient_address_encrypted, recipient_address_masked, recipient_address_hash,
        sensitive_payload_encrypted, fallback_channels_json, fallback_index,
        dedupe_key, aggregate_key, attempt_count, available_at, leased_until, lease_owner,
        provider_message_id, provider_state, last_error_code, last_error_message,
        accepted_at, delivered_at, sensitive_cleared_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT (dedupe_key) DO NOTHING
    `).run(
      randomUUID(), taskId, externalChannel, String(external.id), String(external.code), Number(external.version),
      title, body, String(external.actionCode ?? "workflow.task.detail"),
      safeJson(workflowActionParams(String(task.entity_type), String(task.entity_id), taskId)),
      recipient.encrypted, recipient.masked, recipient.hash,
      sensitivePayload, safeJson(remainingFallback), dedupeKey, aggregation.key,
      availableAt.toISOString(), now.toISOString(), now.toISOString(),
    );
    if (result.changes === 1) outboxQueued = true;
    else if (await database.prepare<Row>("SELECT id FROM notification_outbox WHERE dedupe_key = ?").get(dedupeKey)) outboxQueued = true;
  }
  return { inboxQueued, outboxQueued, taskCenterVisible, queued: inboxQueued || outboxQueued };
}

export async function createWorkflowTask(
  database: AppDatabase,
  input: CreateWorkflowTaskInput,
  options: { now?: Date; actorType?: string; actorId?: string | null; forceCreate?: boolean } = {},
): Promise<ReturnType<typeof taskRowDto> | null> {
  const binding = await database.prepare<Row>(`
    SELECT * FROM workflow_entity_bindings
    WHERE domain = ? AND entity_type = ? AND entity_id = ?
  `).get(input.domain, input.entityType, input.entityId);
  // No binding is the deliberate historical-record behavior: no task and no notification.
  if (!binding) return null;
  const policy = await database.prepare<Row>(`
    SELECT id, version FROM workflow_policy_sets
    WHERE domain = ? AND state = 'published' AND is_current = 1
    LIMIT 1
  `).get(input.domain);
  if (!policy) return null;
  const node = await database.prepare<Row>(`
    SELECT n.*, p.business_hours_json
    FROM workflow_policy_nodes n
    INNER JOIN workflow_policy_sets p ON p.id = n.policy_set_id
    WHERE n.policy_set_id = ? AND n.node_code = ?
  `).get(String(policy.id), input.nodeCode);
  if (!node || Number(node.is_enabled) !== 1) return null;
  const subjectType = input.subjectType === undefined ? binding.subject_type : input.subjectType;
  let subjectId = input.subjectId === undefined ? binding.subject_id : input.subjectId;
  const sourceTaskId = input.nodeCode === "workflow.exception"
    && typeof input.metadata?.sourceTaskId === "string"
    && input.metadata.sourceTaskId.trim()
    ? input.metadata.sourceTaskId.trim()
    : null;
  // Each escalated/dead-letter source owns an independent platform exception.
  // Using the source id as the platform-duty subject keeps the existing unique
  // task identity effective without exposing it to notification templates.
  if (subjectType === "platform_duty" && subjectId == null && sourceTaskId) subjectId = sourceTaskId;
  let existing = options.forceCreate ? undefined : await database.prepare<Row>(`
    SELECT * FROM workflow_tasks
    WHERE binding_id = ? AND node_code = ?
      AND COALESCE(subject_type, '') = COALESCE(?, '')
      AND COALESCE(subject_id, '') = COALESCE(?, '')
      AND COALESCE(recipient_user_id, '') = COALESCE(?, '')
      AND status = 'open'
    LIMIT 1
  `).get(
    String(binding.id), input.nodeCode,
    subjectType == null ? null : String(subjectType),
    subjectId == null ? null : String(subjectId),
    input.recipientUserId ?? null,
  );
  if (!options.forceCreate && !existing && String(node.task_kind) === "information") {
    existing = await database.prepare<Row>(`
      SELECT * FROM workflow_tasks
      WHERE binding_id = ? AND node_code = ?
        AND COALESCE(subject_type, '') = COALESCE(?, '')
        AND COALESCE(subject_id, '') = COALESCE(?, '')
        AND COALESCE(recipient_user_id, '') = COALESCE(?, '')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(
      String(binding.id), input.nodeCode,
      subjectType == null ? null : String(subjectType),
      subjectId == null ? null : String(subjectId),
      input.recipientUserId ?? null,
    );
  }
  if (existing) return taskRowDto(existing);
  const now = options.now ?? new Date();
  const anchor = new Date(asIso(input.anchorAt ?? now));
  const timerMode = String(node.timer_mode) as "business" | "natural";
  const firstReminderAt = timingValue(input.firstReminderAt, anchor, node.first_reminder_minutes == null ? null : Number(node.first_reminder_minutes), timerMode, node.business_hours_json);
  const reminderSchedule = (input.reminderScheduleAt ?? []).map(asIso).sort();
  const scheduledFirstReminderAt = reminderSchedule[0] ?? firstReminderAt;
  const maxReminders = input.maxReminders === undefined
    ? Number(node.max_reminders)
    : Math.max(1, Math.min(100, Math.floor(input.maxReminders)));
  const dueAt = timingValue(input.dueAt, anchor, node.deadline_minutes == null ? null : Number(node.deadline_minutes), timerMode, node.business_hours_json);
  const escalateAt = timingValue(input.escalateAt, anchor, node.escalation_minutes == null ? null : Number(node.escalation_minutes), timerMode, node.business_hours_json);
  const templateBindings = jsonObject(node.template_bindings_json);
  const templates = await taskTemplateSnapshot(database, templateBindings);
  let phone = input.recipientPhone?.trim() || null;
  if (!phone) {
    const recipient = String(input.assigneeRole?.trim() || node.assignee_role) === "platform"
      ? (await database.prepare<Row>(`
          SELECT phone_encrypted, duty_schedule_json FROM workflow_notification_recipients
          WHERE recipient_type = 'platform_duty' AND is_enabled = 1
          ORDER BY created_at
        `).all()).find((candidate) => dutyScheduleActive(candidate.duty_schedule_json, now))
      : subjectType && subjectId
        ? await database.prepare<Row>(`
            SELECT phone_encrypted FROM workflow_notification_recipients
            WHERE recipient_type = 'service_subject' AND subject_type = ? AND subject_id = ? AND is_enabled = 1
            ORDER BY created_at LIMIT 1
          `).get(String(subjectType), String(subjectId))
        : undefined;
    if (recipient?.phone_encrypted) phone = decryptWorkflowValue(String(recipient.phone_encrypted));
  }
  if (phone && !PHONE_PATTERN.test(phone)) domainError(400, "WORKFLOW_RECIPIENT_PHONE_INVALID", "通知手机号格式无效");
  const openId = input.recipientWechatOpenId?.trim() || null;
  const policyNodeSnapshot = {
    nodeCode: String(node.node_code),
    nodeName: String(node.node_name),
    workflowVariant: String(node.workflow_variant),
    triggerState: String(node.trigger_state),
    nextState: node.next_state == null ? null : String(node.next_state),
    assigneeRole: String(node.assignee_role),
    subjectScope: String(node.subject_scope),
    closureAction: String(node.closure_action),
    taskKind: String(node.task_kind),
    timerMode,
    firstReminderMinutes: node.first_reminder_minutes == null ? null : Number(node.first_reminder_minutes),
    deadlineMinutes: node.deadline_minutes == null ? null : Number(node.deadline_minutes),
    escalationMinutes: node.escalation_minutes == null ? null : Number(node.escalation_minutes),
    enabledChannels: stringArray(node.enabled_channels_json),
    fallbackOrder: stringArray(node.fallback_order_json),
    escalationLevel: String(node.escalation_level),
    quietHours: jsonObject(node.quiet_hours_json),
    businessHours: jsonObject(node.business_hours_json),
    immutableRules: jsonObject(node.immutable_rules_json),
  };
  const id = randomUUID();
  const rawMetadata: Json = { ...(input.metadata ?? {}) };
  if ((rawMetadata.remainingTime == null || rawMetadata.remainingTime === "策略规定时间")
    && node.deadline_minutes != null) {
    rawMetadata.remainingTime = workflowDurationLabel(Number(node.deadline_minutes), timerMode);
  }
  const metadata = sanitizedTaskMetadata(rawMetadata);
  await database.prepare(`
    INSERT INTO workflow_tasks (
      id, binding_id, domain, node_code, entity_type, entity_id, owner_user_id,
      subject_type, subject_id, assignee_role, recipient_user_id,
      recipient_phone_encrypted, recipient_phone_masked, recipient_phone_hash,
      recipient_wechat_openid_encrypted, recipient_wechat_openid_masked, recipient_wechat_openid_hash,
      status, task_kind, policy_set_id, policy_version, policy_node_snapshot_json,
      template_bindings_snapshot_json, anchor_at, first_reminder_at, next_reminder_at,
      due_at, escalate_at, reminder_count, max_reminders, reminder_interval_minutes,
      reminder_schedule_json,
      last_reminded_at, escalated_at, closed_at, closed_reason, metadata_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
  `).run(
    id, String(binding.id), input.domain, input.nodeCode, input.entityType, input.entityId,
    binding.owner_user_id == null ? null : String(binding.owner_user_id),
    subjectType == null ? null : String(subjectType), subjectId == null ? null : String(subjectId),
    input.assigneeRole?.trim() || String(node.assignee_role), input.recipientUserId ?? null,
    phone ? encryptWorkflowValue(phone) : null, phone ? maskedPhone(phone) : null, phone ? workflowHmac(phone) : null,
    openId ? encryptWorkflowValue(openId) : null, openId ? maskedOpenId(openId) : null, openId ? workflowHmac(openId) : null,
    String(node.task_kind), String(policy.id), Number(policy.version),
    safeJson(policyNodeSnapshot), safeJson(templates), anchor.toISOString(), scheduledFirstReminderAt, scheduledFirstReminderAt,
    dueAt, escalateAt, maxReminders, node.reminder_interval_minutes == null ? null : Number(node.reminder_interval_minutes),
    safeJson(reminderSchedule),
    safeJson(metadata), now.toISOString(), now.toISOString(),
  );
  await database.prepare(`
    INSERT INTO workflow_task_events (
      id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
    ) VALUES (?, ?, 'created', ?, ?, NULL, 'open', '{}', ?)
  `).run(randomUUID(), id, options.actorType ?? "system", options.actorId ?? null, now.toISOString());
  let created = await database.prepare<Row>("SELECT * FROM workflow_tasks WHERE id = ?").get(id);
  if (!created) throw new Error("Created workflow task could not be read back");
  let initialDeliveryAttempted = false;
  let initialNotificationQueued = false;
  if (input.sensitiveVariables?.verificationCode
    && (scheduledFirstReminderAt == null || new Date(scheduledFirstReminderAt).getTime() > now.getTime())) {
    const notification = await queueWorkflowTaskNotification(database, created, "created", 0, now, input.sensitiveVariables);
    await database.prepare(`
      INSERT INTO workflow_task_events (
        id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
      ) VALUES (?, ?, ?, 'system', NULL, 'open', 'open', ?, ?)
    `).run(
      randomUUID(), id,
      notification.queued
        ? "assignment_notification_queued"
        : notification.taskCenterVisible ? "task_center_reminder" : "notification_skipped",
      safeJson({
        occurrence: 0,
        taskCenterVisible: notification.taskCenterVisible,
        inboxQueued: notification.inboxQueued,
        outboxQueued: notification.outboxQueued,
        ...(!notification.queued && !notification.taskCenterVisible
          ? { reason: "no_available_delivery_route" }
          : {}),
      }),
      now.toISOString(),
    );
  }
  if (scheduledFirstReminderAt != null && new Date(scheduledFirstReminderAt).getTime() <= now.getTime()) {
    initialDeliveryAttempted = true;
    const notification = await queueWorkflowTaskNotification(database, created, "created", 1, now, input.sensitiveVariables);
    initialNotificationQueued = notification.queued;
    const supervisionRecorded = notification.queued || notification.taskCenterVisible;
    const nextScheduledReminder = reminderSchedule.find((value) => new Date(value).getTime() > now.getTime()) ?? null;
    await database.prepare(`
      UPDATE workflow_tasks
      SET reminder_count = ?, last_reminded_at = ?, next_reminder_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      supervisionRecorded ? 1 : 0,
      supervisionRecorded ? now.toISOString() : null,
      supervisionRecorded ? nextScheduledReminder : null,
      now.toISOString(),
      id,
    );
    if (!notification.queued) {
      await database.prepare(`
        INSERT INTO workflow_task_events (
          id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
        ) VALUES (?, ?, ?, 'system', NULL, 'open', 'open', ?, ?)
      `).run(
        randomUUID(), id,
        notification.taskCenterVisible ? "task_center_reminder" : "notification_skipped",
        safeJson({
          occurrence: 1,
          taskCenterVisible: notification.taskCenterVisible,
          inboxQueued: notification.inboxQueued,
          outboxQueued: notification.outboxQueued,
          ...(!notification.taskCenterVisible ? { reason: "no_available_delivery_route" } : {}),
        }),
        now.toISOString(),
      );
    }
    created = await database.prepare<Row>("SELECT * FROM workflow_tasks WHERE id = ?").get(id) ?? created;
  }
  if (String(node.task_kind) === "information" && initialDeliveryAttempted
    && initialNotificationQueued && created.next_reminder_at == null) {
    const closeReason = "notification_queued";
    await database.prepare(`
      UPDATE workflow_tasks
      SET status = 'completed', next_reminder_at = NULL, closed_at = ?,
        closed_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(now.toISOString(), closeReason, now.toISOString(), id);
    await database.prepare(`
      INSERT INTO workflow_task_events (
        id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
      ) VALUES (?, ?, 'closed', 'system', NULL, 'open', 'completed', ?, ?)
    `).run(randomUUID(), id, safeJson({ reason: closeReason }), now.toISOString());
    created = await database.prepare<Row>("SELECT * FROM workflow_tasks WHERE id = ?").get(id) ?? created;
  }
  return taskRowDto(created);
}

export async function closeWorkflowTasks(
  database: AppDatabase,
  input: {
    domain: WorkflowDomain;
    entityType: string;
    entityId: string;
    taskIds?: string[];
    nodeCodes?: string[];
    reason: string;
    actorType?: string;
    actorId?: string | null;
  },
  options: { now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const rows = input.taskIds?.length
    ? await database.prepare<Row>(`
        SELECT id FROM workflow_tasks
        WHERE domain = ? AND entity_type = ? AND entity_id = ? AND status = 'open'
          AND id = ANY(?::text[])
        FOR UPDATE
      `).all(input.domain, input.entityType, input.entityId, input.taskIds)
    : input.nodeCodes?.length
    ? await database.prepare<Row>(`
        SELECT id FROM workflow_tasks
        WHERE domain = ? AND entity_type = ? AND entity_id = ? AND status = 'open'
          AND node_code = ANY(?::text[])
        FOR UPDATE
      `).all(input.domain, input.entityType, input.entityId, input.nodeCodes)
    : await database.prepare<Row>(`
        SELECT id FROM workflow_tasks
        WHERE domain = ? AND entity_type = ? AND entity_id = ? AND status = 'open'
        FOR UPDATE
      `).all(input.domain, input.entityType, input.entityId);
  for (const row of rows) {
    const taskId = String(row.id);
    await database.prepare(`
      UPDATE workflow_tasks SET status = 'completed', closed_at = ?, closed_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(now.toISOString(), input.reason, now.toISOString(), taskId);
    await database.prepare(`
      UPDATE notification_outbox SET status = 'cancelled',
        sensitive_payload_encrypted = NULL,
        sensitive_cleared_at = CASE
          WHEN sensitive_payload_encrypted IS NOT NULL THEN COALESCE(sensitive_cleared_at, ?)
          ELSE sensitive_cleared_at
        END,
        leased_until = NULL, lease_owner = NULL, updated_at = ?
      WHERE task_id = ? AND status IN ('pending', 'retry', 'processing')
    `).run(now.toISOString(), now.toISOString(), taskId);
    await database.prepare(`
      INSERT INTO workflow_task_events (
        id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
      ) VALUES (?, ?, 'closed', ?, ?, 'open', 'completed', ?, ?)
    `).run(randomUUID(), taskId, input.actorType ?? "system", input.actorId ?? null, safeJson({ reason: input.reason }), now.toISOString());
  }
  // Information tasks complete once their notification is durably queued, but
  // a quiet-hours or retry outbox may still be pending. A later business state
  // change must cancel that stale delivery even though the source task is no
  // longer open (for example, do not notify a shop about an opportunity after
  // another shop has already submitted the first quote).
  if (input.taskIds?.length) {
    await database.prepare(`
      UPDATE notification_outbox SET status = 'cancelled',
        sensitive_payload_encrypted = NULL,
        sensitive_cleared_at = CASE
          WHEN sensitive_payload_encrypted IS NOT NULL THEN COALESCE(sensitive_cleared_at, ?)
          ELSE sensitive_cleared_at
        END,
        leased_until = NULL, lease_owner = NULL, updated_at = ?
      WHERE status IN ('pending', 'retry', 'processing') AND task_id IN (
        SELECT id FROM workflow_tasks
        WHERE domain = ? AND entity_type = ? AND entity_id = ?
          AND id = ANY(?::text[])
      )
    `).run(now.toISOString(), now.toISOString(), input.domain, input.entityType, input.entityId, input.taskIds);
  } else if (input.nodeCodes?.length) {
    await database.prepare(`
      UPDATE notification_outbox SET status = 'cancelled',
        sensitive_payload_encrypted = NULL,
        sensitive_cleared_at = CASE
          WHEN sensitive_payload_encrypted IS NOT NULL THEN COALESCE(sensitive_cleared_at, ?)
          ELSE sensitive_cleared_at
        END,
        leased_until = NULL, lease_owner = NULL, updated_at = ?
      WHERE status IN ('pending', 'retry', 'processing') AND task_id IN (
        SELECT id FROM workflow_tasks
        WHERE domain = ? AND entity_type = ? AND entity_id = ?
          AND node_code = ANY(?::text[])
          AND task_kind = 'information' AND status = 'completed'
          AND closed_reason = 'notification_queued'
      )
    `).run(now.toISOString(), now.toISOString(), input.domain, input.entityType, input.entityId, input.nodeCodes);
  } else {
    await database.prepare(`
      UPDATE notification_outbox SET status = 'cancelled',
        sensitive_payload_encrypted = NULL,
        sensitive_cleared_at = CASE
          WHEN sensitive_payload_encrypted IS NOT NULL THEN COALESCE(sensitive_cleared_at, ?)
          ELSE sensitive_cleared_at
        END,
        leased_until = NULL, lease_owner = NULL, updated_at = ?
      WHERE status IN ('pending', 'retry', 'processing') AND task_id IN (
        SELECT id FROM workflow_tasks
        WHERE domain = ? AND entity_type = ? AND entity_id = ?
          AND task_kind = 'information' AND status = 'completed'
          AND closed_reason = 'notification_queued'
      )
    `).run(now.toISOString(), now.toISOString(), input.domain, input.entityType, input.entityId);
  }
  return rows.length;
}

/**
 * Call this inside the same transaction as the canonical business state update.
 * Existing tasks close before successors open; notifications/outbox are persisted in that transaction.
 */
export async function applyWorkflowTransition(
  database: AppDatabase,
  input: ApplyWorkflowTransitionInput,
  options: { now?: Date } = {},
): Promise<{ closed: number; opened: Array<ReturnType<typeof taskRowDto>> }> {
  const now = options.now ?? new Date();
  const closed = input.closeTaskIds?.length || input.closeNodeCodes?.length
    ? await closeWorkflowTasks(database, {
        domain: input.domain,
        entityType: input.entityType,
        entityId: input.entityId,
        taskIds: input.closeTaskIds,
        nodeCodes: input.closeNodeCodes,
        reason: input.closeReason ?? "business_transition",
        actorType: input.actorType,
        actorId: input.actorId,
      }, { now })
    : 0;
  const opened: Array<ReturnType<typeof taskRowDto>> = [];
  const forceCreateNodeCodes = new Set(input.forceCreateNodeCodes ?? []);
  for (const task of input.open ?? []) {
    const created = await createWorkflowTask(database, {
      ...task,
      domain: input.domain,
      entityType: input.entityType,
      entityId: input.entityId,
    }, {
      now,
      actorType: input.actorType,
      actorId: input.actorId,
      forceCreate: forceCreateNodeCodes.has(task.nodeCode),
    });
    if (created) opened.push(created);
  }
  return { closed, opened };
}

function policyNodeDto(row: Row) {
  return {
    id: String(row.id),
    nodeCode: String(row.node_code),
    name: String(row.node_name),
    workflowVariant: String(row.workflow_variant),
    isEnabled: Number(row.is_enabled) === 1,
    immutable: {
      triggerState: String(row.trigger_state),
      nextState: row.next_state == null ? null : String(row.next_state),
      assigneeRole: String(row.assignee_role),
      subjectScope: String(row.subject_scope),
      closureAction: String(row.closure_action),
      taskKind: String(row.task_kind),
      rules: jsonObject(row.immutable_rules_json),
    },
    timerMode: String(row.timer_mode),
    firstReminderMinutes: row.first_reminder_minutes == null ? null : Number(row.first_reminder_minutes),
    deadlineMinutes: row.deadline_minutes == null ? null : Number(row.deadline_minutes),
    escalationMinutes: row.escalation_minutes == null ? null : Number(row.escalation_minutes),
    maxReminders: Number(row.max_reminders),
    reminderIntervalMinutes: row.reminder_interval_minutes == null ? null : Number(row.reminder_interval_minutes),
    enabledChannels: stringArray(row.enabled_channels_json),
    fallbackOrder: stringArray(row.fallback_order_json),
    templateBindings: jsonObject(row.template_bindings_json),
    escalationLevel: String(row.escalation_level),
    quietHours: jsonObject(row.quiet_hours_json),
    sortOrder: Number(row.sort_order),
  };
}

async function policyDto(database: AppDatabase, row: Row | undefined) {
  if (!row) return null;
  const nodes = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_nodes WHERE policy_set_id = ? ORDER BY sort_order, node_code
  `).all(String(row.id));
  return {
    id: String(row.id),
    domain: String(row.domain),
    stableCode: String(row.stable_code),
    name: String(row.name),
    state: String(row.state),
    version: row.version == null ? null : Number(row.version),
    revision: Number(row.revision),
    isCurrent: Number(row.is_current) === 1,
    timezone: String(row.timezone),
    businessHours: jsonObject(row.business_hours_json),
    sourcePolicySetId: row.source_policy_set_id == null ? null : String(row.source_policy_set_id),
    createdBy: String(row.created_by),
    publishedBy: row.published_by == null ? null : String(row.published_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    publishedAt: row.published_at == null ? null : String(row.published_at),
    nodes: nodes.map(policyNodeDto),
  };
}

export async function getWorkflowPolicies(database: AppDatabase, domain: WorkflowDomain) {
  const [current, draft] = await Promise.all([
    database.prepare<Row>(`
      SELECT * FROM workflow_policy_sets
      WHERE domain = ? AND state = 'published' AND is_current = 1 LIMIT 1
    `).get(domain),
    database.prepare<Row>(`
      SELECT * FROM workflow_policy_sets WHERE domain = ? AND state = 'draft' LIMIT 1
    `).get(domain),
  ]);
  return { current: await policyDto(database, current), draft: await policyDto(database, draft) };
}

async function copyPolicyToDraft(
  database: AppDatabase,
  domain: WorkflowDomain,
  sourceId: string,
  actor: string,
  now: Date,
): Promise<Row> {
  const existing = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_sets WHERE domain = ? AND state = 'draft' FOR UPDATE
  `).get(domain);
  if (existing) return existing;
  const source = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_sets WHERE id = ? AND domain = ? AND state = 'published'
  `).get(sourceId, domain);
  if (!source) domainError(404, "WORKFLOW_POLICY_NOT_FOUND", "未找到可复制的策略版本");
  const id = randomUUID();
  await database.prepare(`
    INSERT INTO workflow_policy_sets (
      id, domain, stable_code, name, state, version, revision, is_current,
      timezone, business_hours_json, source_policy_set_id,
      created_by, published_by, created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, 'draft', NULL, 1, 0, ?, ?, ?, ?, NULL, ?, ?, NULL)
  `).run(
    id, domain, String(source.stable_code), String(source.name), String(source.timezone),
    String(source.business_hours_json), sourceId, actor, now.toISOString(), now.toISOString(),
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
    SELECT md5(? || ':' || node_code), ?, node_code, node_name, workflow_variant, is_enabled,
      trigger_state, next_state, assignee_role, subject_scope, closure_action,
      task_kind, timer_mode, first_reminder_minutes, deadline_minutes,
      escalation_minutes, max_reminders, reminder_interval_minutes,
      enabled_channels_json, fallback_order_json, template_bindings_json,
      escalation_level, quiet_hours_json, immutable_rules_json, sort_order
    FROM workflow_policy_nodes WHERE policy_set_id = ?
  `).run(id, id, sourceId);
  const draft = await database.prepare<Row>("SELECT * FROM workflow_policy_sets WHERE id = ?").get(id);
  if (!draft) throw new Error("Created workflow policy draft could not be read back");
  return draft;
}

const mutableNodeSchema = z.object({
  nodeCode: z.string().trim().min(1).max(120),
  isEnabled: z.boolean(),
  timerMode: z.enum(["business", "natural"]),
  firstReminderMinutes: z.number().int().min(0).max(525_600).nullable(),
  deadlineMinutes: z.number().int().min(0).max(525_600).nullable(),
  escalationMinutes: z.number().int().min(0).max(525_600).nullable(),
  maxReminders: z.number().int().min(0).max(100),
  reminderIntervalMinutes: z.number().int().min(1).max(525_600).nullable(),
  enabledChannels: z.array(z.enum(["in_app", "wechat", "sms"])).max(3),
  fallbackOrder: z.array(z.enum(["wechat", "sms"])).max(2),
  templateBindings: z.record(z.string(), z.string().trim().min(1).max(200)),
  escalationLevel: z.enum(["none", "platform_duty", "platform_urgent"]),
  quietHours: z.record(z.string(), z.unknown()).optional(),
});

const policyDraftSchema = z.object({
  domain: z.enum(WORKFLOW_DOMAINS),
  expectedRevision: z.number().int().min(0),
  name: z.string().trim().min(2).max(100),
  businessHours: z.object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)).max(366).optional(),
  }),
  nodes: z.array(mutableNodeSchema).min(1).max(100),
});

export type WorkflowPolicyDraftInput = z.infer<typeof policyDraftSchema>;

export async function saveWorkflowPolicyDraft(
  database: AppDatabase,
  raw: unknown,
  options: { actor: string; now?: Date },
) {
  const parsed = policyDraftSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join(".") || "body", issue.message]));
    domainError(400, "WORKFLOW_POLICY_INVALID", "督办策略草稿内容有误", fields);
  }
  const input = parsed.data;
  const now = options.now ?? new Date();
  return database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`workflow-policy-draft:${input.domain}`);
    let draft = await transaction.prepare<Row>(`
      SELECT * FROM workflow_policy_sets WHERE domain = ? AND state = 'draft' FOR UPDATE
    `).get(input.domain);
    if (!draft) {
      if (input.expectedRevision !== 0) domainError(409, "WORKFLOW_POLICY_REVISION_CONFLICT", "策略草稿已变化，请刷新后重试");
      const current = await transaction.prepare<Row>(`
        SELECT id FROM workflow_policy_sets WHERE domain = ? AND state = 'published' AND is_current = 1
      `).get(input.domain);
      if (!current) domainError(409, "WORKFLOW_POLICY_CURRENT_MISSING", "当前没有可复制的已发布策略");
      draft = await copyPolicyToDraft(transaction, input.domain, String(current.id), options.actor, now);
    } else if (Number(draft.revision) !== input.expectedRevision) {
      domainError(409, "WORKFLOW_POLICY_REVISION_CONFLICT", "策略草稿已被其他页面修改，请刷新后重试");
    }
    const existingNodes = await transaction.prepare<Row>(`
      SELECT node_code FROM workflow_policy_nodes WHERE policy_set_id = ?
    `).all(String(draft.id));
    const expectedCodes = new Set(existingNodes.map((row) => String(row.node_code)));
    if (input.nodes.length !== expectedCodes.size || input.nodes.some((node) => !expectedCodes.has(node.nodeCode))) {
      domainError(400, "WORKFLOW_POLICY_IMMUTABLE_NODE_CHANGED", "不可新增、删除或替换业务状态节点");
    }
    for (const node of input.nodes) {
      await transaction.prepare(`
        UPDATE workflow_policy_nodes SET
          is_enabled = ?, timer_mode = ?, first_reminder_minutes = ?, deadline_minutes = ?,
          escalation_minutes = ?, max_reminders = ?, reminder_interval_minutes = ?,
          enabled_channels_json = ?, fallback_order_json = ?, template_bindings_json = ?,
          escalation_level = ?, quiet_hours_json = ?
        WHERE policy_set_id = ? AND node_code = ?
      `).run(
        node.isEnabled ? 1 : 0, node.timerMode, node.firstReminderMinutes, node.deadlineMinutes,
        node.escalationMinutes, node.maxReminders, node.reminderIntervalMinutes,
        safeJson([...new Set(node.enabledChannels)]), safeJson([...new Set(node.fallbackOrder)]),
        safeJson(node.templateBindings), node.escalationLevel, safeJson(node.quietHours ?? {}),
        String(draft.id), node.nodeCode,
      );
    }
    const result = await transaction.prepare(`
      UPDATE workflow_policy_sets
      SET name = ?, business_hours_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND state = 'draft' AND revision = ?
    `).run(input.name, safeJson(input.businessHours), now.toISOString(), String(draft.id), Number(draft.revision));
    if (result.changes !== 1) domainError(409, "WORKFLOW_POLICY_REVISION_CONFLICT", "策略草稿已被其他页面修改，请刷新后重试");
    const saved = await transaction.prepare<Row>("SELECT * FROM workflow_policy_sets WHERE id = ?").get(String(draft.id));
    return policyDto(transaction, saved);
  });
}

export async function validateWorkflowPolicy(database: AppDatabase, policySetId: string): Promise<{
  valid: boolean;
  issues: WorkflowValidationIssue[];
}> {
  const policy = await database.prepare<Row>("SELECT * FROM workflow_policy_sets WHERE id = ?").get(policySetId);
  if (!policy) domainError(404, "WORKFLOW_POLICY_NOT_FOUND", "未找到督办策略");
  const rows = await database.prepare<Row>(`
    SELECT * FROM workflow_policy_nodes WHERE policy_set_id = ? ORDER BY sort_order
  `).all(policySetId);
  const issues: WorkflowValidationIssue[] = [];
  const businessHours = normalizeBusinessHours(policy.business_hours_json);
  if (clockMinutes(businessHours.end) <= clockMinutes(businessHours.start)) {
    issues.push({ severity: "error", code: "BUSINESS_HOURS_INVALID", field: "businessHours", message: "营业结束时间必须晚于开始时间" });
  }
  for (const row of rows) {
    const code = String(row.node_code);
    if (Number(row.is_enabled) !== 1) continue;
    const first = row.first_reminder_minutes == null ? null : Number(row.first_reminder_minutes);
    const due = row.deadline_minutes == null ? null : Number(row.deadline_minutes);
    const escalation = row.escalation_minutes == null ? null : Number(row.escalation_minutes);
    if (first != null && due != null && first >= due) {
      issues.push({ severity: "error", code: "REMINDER_NOT_BEFORE_DEADLINE", nodeCode: code, field: "firstReminderMinutes", message: "首次提醒必须早于截止时间" });
    }
    if (due != null && escalation != null && due > escalation) {
      issues.push({ severity: "error", code: "DEADLINE_AFTER_ESCALATION", nodeCode: code, field: "deadlineMinutes", message: "截止时间不能晚于升级时间" });
    }
    const channels = stringArray(row.enabled_channels_json);
    const fallbackOrder = stringArray(row.fallback_order_json);
    if (String(row.task_kind) === "blocking" && !channels.includes("in_app")) {
      issues.push({ severity: "error", code: "BLOCKING_IN_APP_REQUIRED", nodeCode: code, field: "enabledChannels", message: "阻塞节点至少保留站内待办" });
    }
    for (const channel of fallbackOrder) {
      if (!channels.includes(channel)) {
        issues.push({ severity: "error", code: "FALLBACK_CHANNEL_NOT_ENABLED", nodeCode: code, field: "fallbackOrder", message: `${channel} 兜底渠道必须先启用` });
      }
    }
    const bindings = jsonObject(row.template_bindings_json);
    for (const channel of [...new Set([...channels, ...fallbackOrder])]) {
      const id = bindings[channel];
      if (typeof id !== "string" || !id) {
        issues.push({ severity: "error", code: "TEMPLATE_BINDING_REQUIRED", nodeCode: code, field: `templateBindings.${channel}`, message: `${channel} 渠道必须绑定模板` });
        continue;
      }
      const template = await database.prepare<Row>(`
        SELECT current.stable_code, current.channel, current.state, current.is_current,
          current.node_code, current.filing_status, current.provider_template_id,
          current.provider_snapshot_json, current.allowed_variables_json
        FROM notification_templates bound
        INNER JOIN notification_templates current
          ON current.stable_code = bound.stable_code
         AND current.channel = bound.channel
         AND current.state = 'published'
         AND current.is_current = 1
        WHERE bound.id = ? AND bound.state = 'published'
      `).get(id);
      const appliesToNode = template && DEFAULT_WORKFLOW_NODES.some((definition) => (
        definition.code === code && definition.templateCode === String(template.stable_code)
      ));
      if (!template || String(template.channel) !== channel || String(template.state) !== "published"
        || Number(template.is_current) !== 1 || !appliesToNode) {
        issues.push({ severity: "error", code: "PUBLISHED_TEMPLATE_REQUIRED", nodeCode: code, field: `templateBindings.${channel}`, message: `${channel} 渠道必须绑定已发布模板` });
      } else if (channel === "sms" && String(template.filing_status) !== "approved") {
        issues.push({ severity: "error", code: "SMS_TEMPLATE_NOT_APPROVED", nodeCode: code, field: `templateBindings.${channel}`, message: "短信模板报备通过后才能用于真实发送" });
      } else if (channel === "wechat") {
        const wechatIssues = wechatTemplateConfigurationIssues({
          providerTemplateId: template.provider_template_id,
          providerSnapshot: template.provider_snapshot_json,
          allowedVariables: template.allowed_variables_json,
        });
        for (const issue of wechatIssues) {
          issues.push({ ...issue, nodeCode: code, field: `templateBindings.${channel}.${issue.field ?? "providerSnapshot"}` });
        }
      }
    }
  }
  const missingRecipient = await database.prepare<Row>(`
    SELECT 1 FROM workflow_notification_recipients WHERE is_enabled = 1 LIMIT 1
  `).get();
  if (!missingRecipient) {
    issues.push({ severity: "warning", code: "SMS_RECIPIENTS_MISSING", message: "尚未配置服务商或平台值班短信联系人；不阻止发布，但短信兜底将不可用" });
  }
  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

export async function publishWorkflowPolicy(
  database: AppDatabase,
  input: { domain: WorkflowDomain; expectedRevision: number },
  options: { actor: string; now?: Date; request?: FastifyRequest },
) {
  const now = options.now ?? new Date();
  return database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`workflow-policy-publish:${input.domain}`);
    const draft = await transaction.prepare<Row>(`
      SELECT * FROM workflow_policy_sets WHERE domain = ? AND state = 'draft' FOR UPDATE
    `).get(input.domain);
    if (!draft) domainError(404, "WORKFLOW_POLICY_DRAFT_NOT_FOUND", "没有可发布的策略草稿");
    if (Number(draft.revision) !== input.expectedRevision) domainError(409, "WORKFLOW_POLICY_REVISION_CONFLICT", "策略草稿已变化，请刷新后重试");
    const validation = await validateWorkflowPolicy(transaction, String(draft.id));
    if (!validation.valid) domainError(409, "WORKFLOW_POLICY_VALIDATION_FAILED", "策略校验未通过，请修正后再发布", Object.fromEntries(validation.issues.filter((issue) => issue.severity === "error").map((issue, index) => [`issue.${index}`, issue.message])));
    const maxVersion = await transaction.prepare<Row>(`
      SELECT COALESCE(MAX(version), 0) AS version FROM workflow_policy_sets
      WHERE domain = ? AND state = 'published'
    `).get(input.domain);
    const version = Number(maxVersion?.version ?? 0) + 1;
    await transaction.prepare(`
      UPDATE workflow_policy_sets SET is_current = 0, updated_at = ?
      WHERE domain = ? AND is_current = 1
    `).run(now.toISOString(), input.domain);
    const result = await transaction.prepare(`
      UPDATE workflow_policy_sets
      SET state = 'published', version = ?, is_current = 1, published_by = ?,
        published_at = ?, updated_at = ?
      WHERE id = ? AND state = 'draft' AND revision = ?
    `).run(version, options.actor, now.toISOString(), now.toISOString(), String(draft.id), input.expectedRevision);
    if (result.changes !== 1) domainError(409, "WORKFLOW_POLICY_REVISION_CONFLICT", "策略发布发生并发冲突，请刷新后重试");
    await transaction.prepare(`
      INSERT INTO workflow_release_events (
        id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
      ) VALUES (?, 'workflow_policy', ?, ?, ?, ?, 'published', ?, ?)
    `).run(randomUUID(), String(draft.id), input.domain, version, options.actor, safeJson({ warnings: validation.issues.filter((issue) => issue.severity === "warning") }), now.toISOString());
    await auditBackofficeEvent(transaction, {
      request: options.request,
      action: "workflow.policy.publish",
      outcome: "success",
      resource: { type: "workflow_policy", id: String(draft.id) },
      after: { domain: input.domain, version },
      occurredAt: now.toISOString(),
    });
    const published = await transaction.prepare<Row>("SELECT * FROM workflow_policy_sets WHERE id = ?").get(String(draft.id));
    return { policy: await policyDto(transaction, published), warnings: validation.issues.filter((issue) => issue.severity === "warning") };
  });
}

export async function restoreWorkflowPolicyAsDraft(
  database: AppDatabase,
  policySetId: string,
  options: { actor: string; now?: Date },
) {
  const source = await database.prepare<Row>(`
    SELECT domain FROM workflow_policy_sets WHERE id = ? AND state = 'published'
  `).get(policySetId);
  if (!source) domainError(404, "WORKFLOW_POLICY_NOT_FOUND", "未找到已发布策略版本");
  const now = options.now ?? new Date();
  const draft = await database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`workflow-policy-draft:${String(source.domain)}`);
    const existing = await transaction.prepare<Row>(`
      SELECT id FROM workflow_policy_sets WHERE domain = ? AND state = 'draft'
    `).get(String(source.domain));
    if (existing) domainError(409, "WORKFLOW_POLICY_DRAFT_EXISTS", "已有未发布草稿，请先处理该草稿");
    return copyPolicyToDraft(transaction, String(source.domain) as WorkflowDomain, policySetId, options.actor, now);
  });
  return policyDto(database, draft);
}

function templateDto(row: Row) {
  const exampleData = jsonObject(row.example_data_json);
  const preview = renderWorkflowTemplate(String(row.body), exampleData as WorkflowTemplateVariables);
  return {
    id: String(row.id),
    stableCode: String(row.stable_code),
    name: String(row.name),
    nodeCode: String(row.node_code),
    channel: String(row.channel),
    version: row.version == null ? null : Number(row.version),
    state: String(row.state),
    revision: Number(row.revision),
    isCurrent: Number(row.is_current) === 1,
    title: String(row.title ?? ""),
    body: String(row.body),
    buttonText: row.button_text == null ? null : String(row.button_text),
    actionCode: String(row.action_code),
    allowedVariables: stringArray(row.allowed_variables_json),
    exampleData,
    renderedPreview: preview,
    smsSegments: String(row.channel) === "sms" ? estimateSmsSegments(preview) : null,
    providerTemplateId: row.provider_template_id == null ? null : String(row.provider_template_id),
    providerSnapshot: jsonObject(row.provider_snapshot_json),
    filingStatus: String(row.filing_status),
    createdBy: String(row.created_by),
    publishedBy: row.published_by == null ? null : String(row.published_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    publishedAt: row.published_at == null ? null : String(row.published_at),
  };
}

const templateDraftSchema = z.object({
  stableCode: z.string().trim().min(3).max(120),
  channel: z.enum(["in_app", "sms", "wechat"]),
  expectedRevision: z.number().int().min(0),
  name: z.string().trim().min(2).max(100),
  title: z.string().max(100),
  body: z.string().trim().min(1).max(1000),
  buttonText: z.string().trim().max(20).nullable().optional(),
  actionCode: z.string().trim().min(1).max(80),
  allowedVariables: z.array(z.string().trim().min(1).max(80)).max(20),
  exampleData: z.record(z.string(), z.union([z.string(), z.number()])),
  providerTemplateId: z.string().trim().max(160).nullable().optional(),
  providerSnapshot: z.record(z.string(), z.unknown()).optional(),
  filingStatus: z.enum(["not_required", "unreported", "pending", "approved", "rejected", "unconfigured"]),
});

function validateTemplateInput(input: z.infer<typeof templateDraftSchema>): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const visibleContent = [input.title, input.body, input.buttonText ?? ""].join("\n");
  if (TEMPLATE_URL_PATTERN.test(visibleContent)) {
    issues.push({ severity: "error", code: "TEMPLATE_URL_FORBIDDEN", field: "body", message: "通知模板不能保存任意网址，请使用服务端白名单跳转动作" });
  }
  if (input.channel === "sms" && FULL_MOBILE_PATTERN.test(visibleContent)) {
    issues.push({ severity: "error", code: "SMS_FULL_MOBILE_FORBIDDEN", field: "body", message: "短信模板不能包含完整手机号" });
  }
  if (input.channel === "sms" && DETAILED_ADDRESS_PATTERN.test(visibleContent)) {
    issues.push({ severity: "error", code: "SMS_DETAILED_ADDRESS_FORBIDDEN", field: "body", message: "短信模板不能包含完整取送地址" });
  }
  if (!ACTION_CODES.has(input.actionCode)) {
    issues.push({ severity: "error", code: "ACTION_CODE_FORBIDDEN", field: "actionCode", message: "跳转动作不在服务端白名单中" });
  }
  const allowed = new Set(input.allowedVariables);
  for (const variable of input.allowedVariables) {
    if (!GLOBAL_TEMPLATE_VARIABLES.has(variable)) {
      issues.push({ severity: "error", code: "VARIABLE_FORBIDDEN", field: "allowedVariables", message: `变量 ${variable} 不在白名单中` });
    }
    if (variable === "verificationCode" && input.stableCode !== "annual.driver.assigned") {
      issues.push({ severity: "error", code: "VERIFICATION_CODE_SCOPE_FORBIDDEN", field: "allowedVariables", message: "验证码只能用于指定的司机派单模板" });
    }
  }
  for (const placeholder of [...templatePlaceholders(input.title), ...templatePlaceholders(input.body)]) {
    if (!allowed.has(placeholder)) {
      issues.push({ severity: "error", code: "VARIABLE_NOT_DECLARED", field: "body", message: `模板使用了未声明变量 ${placeholder}` });
    }
  }
  if (input.channel === "sms" && input.title.trim()) {
    issues.push({ severity: "warning", code: "SMS_TITLE_IGNORED", field: "title", message: "短信渠道不发送标题" });
  }
  if (input.channel === "wechat") {
    issues.push(...wechatTemplateConfigurationIssues({
      providerTemplateId: input.providerTemplateId,
      providerSnapshot: input.providerSnapshot,
      allowedVariables: input.allowedVariables,
    }));
  }
  if (input.channel === "sms" && input.filingStatus !== "approved") {
    issues.push({ severity: "warning", code: "SMS_FILING_PENDING", field: "filingStatus", message: "短信模板未报备通过，不能用于真实发送" });
  }
  return issues;
}

export async function listWorkflowTemplates(database: AppDatabase, query: { stableCode?: string; channel?: string } = {}) {
  const predicates: string[] = [];
  const parameters: string[] = [];
  if (query.stableCode) {
    predicates.push("stable_code = ?");
    parameters.push(query.stableCode);
  }
  if (query.channel) {
    predicates.push("channel = ?");
    parameters.push(query.channel);
  }
  const rows = await database.prepare<Row>(`
    SELECT * FROM notification_templates
    ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
    ORDER BY stable_code, channel, CASE state WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, version DESC NULLS LAST
  `).all(...parameters);
  return rows.map(templateDto);
}

async function createTemplateDraftFromCurrent(
  database: AppDatabase,
  stableCode: string,
  channel: "in_app" | "sms" | "wechat",
  actor: string,
  now: Date,
): Promise<Row> {
  const current = await database.prepare<Row>(`
    SELECT * FROM notification_templates
    WHERE stable_code = ? AND channel = ? AND state = 'published' AND is_current = 1
  `).get(stableCode, channel);
  if (!current) domainError(404, "WORKFLOW_TEMPLATE_NOT_FOUND", "未找到可复制的已发布模板");
  const id = randomUUID();
  await database.prepare(`
    INSERT INTO notification_templates (
      id, stable_code, name, node_code, channel, version, state, revision, is_current,
      title, body, button_text, action_code, allowed_variables_json, example_data_json,
      provider_template_id, provider_snapshot_json, filing_status,
      created_by, published_by, created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'draft', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
  `).run(
    id, stableCode, String(current.name), String(current.node_code), channel,
    String(current.title ?? ""), String(current.body), current.button_text == null ? null : String(current.button_text),
    String(current.action_code), String(current.allowed_variables_json), String(current.example_data_json),
    current.provider_template_id == null ? null : String(current.provider_template_id), String(current.provider_snapshot_json), String(current.filing_status),
    actor, now.toISOString(), now.toISOString(),
  );
  const row = await database.prepare<Row>("SELECT * FROM notification_templates WHERE id = ?").get(id);
  if (!row) throw new Error("Created workflow template draft could not be read back");
  return row;
}

export async function saveWorkflowTemplateDraft(
  database: AppDatabase,
  raw: unknown,
  options: { actor: string; now?: Date },
) {
  const parsed = templateDraftSchema.safeParse(raw);
  if (!parsed.success) {
    domainError(400, "WORKFLOW_TEMPLATE_INVALID", "通知模板内容有误", Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join(".") || "body", issue.message])));
  }
  const input = parsed.data;
  if (input.channel === "wechat") {
    // The approved wording belongs to WeChat. Operations may bind the approved ID,
    // field snapshot and example mapping, but cannot author arbitrary WeChat copy.
    const current = await database.prepare<Row>(`
      SELECT title, body FROM notification_templates
      WHERE stable_code = ? AND channel = 'wechat' AND state = 'published' AND is_current = 1
    `).get(input.stableCode);
    if (current && (input.title !== String(current.title ?? "") || input.body !== String(current.body))) {
      domainError(400, "WECHAT_TEMPLATE_COPY_IMMUTABLE", "微信审批模板正文不能在后台自由修改");
    }
  }
  const issues = validateTemplateInput(input);
  if (issues.some((issue) => issue.severity === "error")) {
    domainError(400, "WORKFLOW_TEMPLATE_VALIDATION_FAILED", "通知模板校验未通过", Object.fromEntries(issues.filter((issue) => issue.severity === "error").map((issue, index) => [`issue.${index}`, issue.message])));
  }
  const now = options.now ?? new Date();
  return database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`workflow-template-draft:${input.stableCode}:${input.channel}`);
    let draft = await transaction.prepare<Row>(`
      SELECT * FROM notification_templates
      WHERE stable_code = ? AND channel = ? AND state = 'draft' FOR UPDATE
    `).get(input.stableCode, input.channel);
    if (!draft) {
      if (input.expectedRevision !== 0) domainError(409, "WORKFLOW_TEMPLATE_REVISION_CONFLICT", "模板草稿已变化，请刷新后重试");
      draft = await createTemplateDraftFromCurrent(transaction, input.stableCode, input.channel, options.actor, now);
    } else if (Number(draft.revision) !== input.expectedRevision) {
      domainError(409, "WORKFLOW_TEMPLATE_REVISION_CONFLICT", "模板草稿已被其他页面修改，请刷新后重试");
    }
    const result = await transaction.prepare(`
      UPDATE notification_templates SET
        name = ?, title = ?, body = ?, button_text = ?, action_code = ?,
        allowed_variables_json = ?, example_data_json = ?, provider_template_id = ?,
        provider_snapshot_json = ?, filing_status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND state = 'draft' AND revision = ?
    `).run(
      input.name, input.title, input.body, input.buttonText ?? null, input.actionCode,
      safeJson([...new Set(input.allowedVariables)]), safeJson(input.exampleData),
      input.providerTemplateId ?? null, safeJson(input.providerSnapshot ?? {}), input.filingStatus,
      now.toISOString(), String(draft.id), Number(draft.revision),
    );
    if (result.changes !== 1) domainError(409, "WORKFLOW_TEMPLATE_REVISION_CONFLICT", "模板草稿已被其他页面修改，请刷新后重试");
    const saved = await transaction.prepare<Row>("SELECT * FROM notification_templates WHERE id = ?").get(String(draft.id));
    if (!saved) throw new Error("Saved workflow template could not be read back");
    return { template: templateDto(saved), issues };
  });
}

export async function publishWorkflowTemplate(
  database: AppDatabase,
  input: { stableCode: string; channel: "in_app" | "sms" | "wechat"; expectedRevision: number },
  options: { actor: string; now?: Date; request?: FastifyRequest },
) {
  const now = options.now ?? new Date();
  return database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`workflow-template-publish:${input.stableCode}:${input.channel}`);
    const draft = await transaction.prepare<Row>(`
      SELECT * FROM notification_templates
      WHERE stable_code = ? AND channel = ? AND state = 'draft' FOR UPDATE
    `).get(input.stableCode, input.channel);
    if (!draft) domainError(404, "WORKFLOW_TEMPLATE_DRAFT_NOT_FOUND", "没有可发布的模板草稿");
    if (Number(draft.revision) !== input.expectedRevision) domainError(409, "WORKFLOW_TEMPLATE_REVISION_CONFLICT", "模板草稿已变化，请刷新后重试");
    const draftDto = templateDto(draft);
    const candidate = templateDraftSchema.parse({
      ...draftDto,
      expectedRevision: input.expectedRevision,
      providerSnapshot: draftDto.providerSnapshot,
    });
    const issues = validateTemplateInput(candidate);
    if (issues.some((issue) => issue.severity === "error")) {
      domainError(409, "WORKFLOW_TEMPLATE_VALIDATION_FAILED", "模板校验未通过，请修正后再发布");
    }
    const maxVersion = await transaction.prepare<Row>(`
      SELECT COALESCE(MAX(version), 0) AS version FROM notification_templates
      WHERE stable_code = ? AND channel = ? AND state = 'published'
    `).get(input.stableCode, input.channel);
    const version = Number(maxVersion?.version ?? 0) + 1;
    await transaction.prepare(`
      UPDATE notification_templates SET is_current = 0, updated_at = ?
      WHERE stable_code = ? AND channel = ? AND is_current = 1
    `).run(now.toISOString(), input.stableCode, input.channel);
    const result = await transaction.prepare(`
      UPDATE notification_templates SET
        state = 'published', version = ?, is_current = 1, published_by = ?,
        published_at = ?, updated_at = ?
      WHERE id = ? AND state = 'draft' AND revision = ?
    `).run(version, options.actor, now.toISOString(), now.toISOString(), String(draft.id), input.expectedRevision);
    if (result.changes !== 1) domainError(409, "WORKFLOW_TEMPLATE_REVISION_CONFLICT", "模板发布发生并发冲突，请刷新后重试");
    await transaction.prepare(`
      INSERT INTO workflow_release_events (
        id, resource_type, resource_id, domain, version, actor_id, action, summary_json, occurred_at
      ) VALUES (?, 'notification_template', ?, ?, ?, ?, 'published', ?, ?)
    `).run(
      randomUUID(),
      String(draft.id),
      workflowTemplateDomain(input.stableCode),
      version,
      options.actor,
      safeJson({
        stableCode: input.stableCode,
        channel: input.channel,
        resourceName: String(draft.name),
        warnings: issues.filter((issue) => issue.severity === "warning"),
      }),
      now.toISOString(),
    );
    await auditBackofficeEvent(transaction, {
      request: options.request,
      action: "workflow.template.publish",
      outcome: "success",
      resource: { type: "notification_template", id: String(draft.id) },
      after: { stableCode: input.stableCode, channel: input.channel, version },
      occurredAt: now.toISOString(),
    });
    const published = await transaction.prepare<Row>("SELECT * FROM notification_templates WHERE id = ?").get(String(draft.id));
    if (!published) throw new Error("Published workflow template could not be read back");
    return { template: templateDto(published), issues };
  });
}

export async function restoreWorkflowTemplateAsDraft(
  database: AppDatabase,
  templateId: string,
  options: { actor: string; now?: Date },
) {
  const source = await database.prepare<Row>(`
    SELECT * FROM notification_templates WHERE id = ? AND state = 'published'
  `).get(templateId);
  if (!source) domainError(404, "WORKFLOW_TEMPLATE_NOT_FOUND", "未找到已发布模板版本");
  const now = options.now ?? new Date();
  return database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`workflow-template-draft:${String(source.stable_code)}:${String(source.channel)}`);
    const existing = await transaction.prepare<Row>(`
      SELECT id FROM notification_templates
      WHERE stable_code = ? AND channel = ? AND state = 'draft'
    `).get(String(source.stable_code), String(source.channel));
    if (existing) domainError(409, "WORKFLOW_TEMPLATE_DRAFT_EXISTS", "已有未发布模板草稿，请先处理该草稿");
    const id = randomUUID();
    await transaction.prepare(`
      INSERT INTO notification_templates (
        id, stable_code, name, node_code, channel, version, state, revision, is_current,
        title, body, button_text, action_code, allowed_variables_json, example_data_json,
        provider_template_id, provider_snapshot_json, filing_status,
        created_by, published_by, created_at, updated_at, published_at
      ) SELECT ?, stable_code, name, node_code, channel, NULL, 'draft', 1, 0,
        title, body, button_text, action_code, allowed_variables_json, example_data_json,
        provider_template_id, provider_snapshot_json, filing_status,
        ?, NULL, ?, ?, NULL
      FROM notification_templates WHERE id = ?
    `).run(id, options.actor, now.toISOString(), now.toISOString(), templateId);
    const draft = await transaction.prepare<Row>("SELECT * FROM notification_templates WHERE id = ?").get(id);
    if (!draft) throw new Error("Restored workflow template draft could not be read back");
    return templateDto(draft);
  });
}

const recipientInputSchema = z.object({
  id: z.string().uuid().optional(),
  recipientType: z.enum(["service_subject", "platform_duty"]),
  subjectType: z.enum(["inspection_station", "repair_shop"]).nullable().optional(),
  subjectId: z.string().trim().min(1).max(120).nullable().optional(),
  contactName: z.string().trim().min(2).max(60),
  phone: z.string().trim().regex(PHONE_PATTERN).optional(),
  isEnabled: z.boolean().default(true),
  dutySchedule: z.record(z.string(), z.unknown()).optional(),
}).superRefine((value, context) => {
  if (!value.id && !value.phone) {
    context.addIssue({ code: "custom", path: ["phone"], message: "新建联系人必须填写手机号" });
  }
  if (value.recipientType === "service_subject" && (!value.subjectType || !value.subjectId)) {
    context.addIssue({ code: "custom", path: ["subjectId"], message: "服务商联系人必须绑定检测站或维修店" });
  }
  if (value.recipientType === "platform_duty" && (value.subjectType || value.subjectId)) {
    context.addIssue({ code: "custom", path: ["subjectId"], message: "平台值班联系人不能绑定服务商" });
  }
});

function recipientDto(row: Row) {
  return {
    id: String(row.id),
    recipientType: String(row.recipient_type),
    subject: row.subject_type == null ? null : {
      type: String(row.subject_type), id: String(row.subject_id),
      name: row.subject_name == null ? null : String(row.subject_name),
    },
    subjectName: row.subject_name == null ? null : String(row.subject_name),
    contactName: String(row.contact_name),
    phoneMasked: String(row.phone_masked),
    isEnabled: Number(row.is_enabled) === 1,
    dutySchedule: jsonObject(row.duty_schedule_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    notice: "业务待办与超时提醒将发送至此手机号。",
  };
}

export async function saveWorkflowRecipient(
  database: AppDatabase,
  raw: unknown,
  options: { actor: string; now?: Date },
) {
  const parsed = recipientInputSchema.safeParse(raw);
  if (!parsed.success) domainError(400, "WORKFLOW_RECIPIENT_INVALID", "通知联系人内容有误", Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join(".") || "body", issue.message])));
  const input = parsed.data;
  const now = options.now ?? new Date();
  const id = input.id ?? randomUUID();
  if (input.id) {
    const existing = await database.prepare<Row>("SELECT * FROM workflow_notification_recipients WHERE id = ?").get(id);
    if (!existing) domainError(404, "WORKFLOW_RECIPIENT_NOT_FOUND", "未找到通知联系人");
    const phone = input.phone ?? decryptWorkflowValue(String(existing.phone_encrypted));
    await database.prepare(`
      UPDATE workflow_notification_recipients SET
        recipient_type = ?, subject_type = ?, subject_id = ?, contact_name = ?,
        phone_encrypted = ?, phone_masked = ?, phone_hash = ?, is_enabled = ?,
        duty_schedule_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.recipientType, input.subjectType ?? null, input.subjectId ?? null, input.contactName,
      encryptWorkflowValue(phone), maskedPhone(phone), workflowHmac(phone), input.isEnabled ? 1 : 0,
      safeJson(input.dutySchedule ?? {}), now.toISOString(), id,
    );
  } else {
    const phone = input.phone!;
    await database.prepare(`
      INSERT INTO workflow_notification_recipients (
        id, recipient_type, subject_type, subject_id, contact_name,
        phone_encrypted, phone_masked, phone_hash, is_enabled, duty_schedule_json,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.recipientType, input.subjectType ?? null, input.subjectId ?? null, input.contactName,
      encryptWorkflowValue(phone), maskedPhone(phone), workflowHmac(phone), input.isEnabled ? 1 : 0,
      safeJson(input.dutySchedule ?? {}), options.actor, now.toISOString(), now.toISOString(),
    );
  }
  const row = await database.prepare<Row>("SELECT * FROM workflow_notification_recipients WHERE id = ?").get(id);
  if (!row) throw new Error("Saved workflow recipient could not be read back");
  return recipientDto(row);
}

type WorkflowRecipientDto = ReturnType<typeof recipientDto>;

async function readWorkflowRecipientForAudit(
  database: AppDatabase,
  id: string,
  options: { lock?: boolean } = {},
): Promise<WorkflowRecipientDto | null> {
  const row = await database.prepare<Row>(`
    SELECT r.*,
      CASE
        WHEN r.subject_type = 'inspection_station' THEN (SELECT s.name FROM stations s WHERE s.id = r.subject_id)
        WHEN r.subject_type = 'repair_shop' THEN (SELECT s.name FROM repair_shops s WHERE s.id = r.subject_id)
        ELSE NULL
      END AS subject_name
    FROM workflow_notification_recipients r
    WHERE r.id = ?
    ${options.lock ? "FOR UPDATE" : ""}
  `).get(id);
  return row ? recipientDto(row) : null;
}

export async function listWorkflowRecipients(database: AppDatabase) {
  const rows = await database.prepare<Row>(`
    SELECT r.*,
      CASE
        WHEN r.subject_type = 'inspection_station' THEN (SELECT s.name FROM stations s WHERE s.id = r.subject_id)
        WHEN r.subject_type = 'repair_shop' THEN (SELECT s.name FROM repair_shops s WHERE s.id = r.subject_id)
        ELSE NULL
      END AS subject_name
    FROM workflow_notification_recipients r
    ORDER BY recipient_type, subject_type NULLS FIRST, subject_id NULLS FIRST, created_at
  `).all();
  const [stationMissing, repairMissing] = await Promise.all([
    database.prepare<Row>(`
      SELECT COUNT(*) AS count FROM stations s
      WHERE COALESCE(s.is_active, 1) = 1 AND NOT EXISTS (
        SELECT 1 FROM workflow_notification_recipients r
        WHERE r.recipient_type = 'service_subject' AND r.subject_type = 'inspection_station'
          AND r.subject_id = s.id AND r.is_enabled = 1
      )
    `).get(),
    database.prepare<Row>(`
      SELECT COUNT(*) AS count FROM repair_shops s
      WHERE s.is_active = 1 AND NOT EXISTS (
        SELECT 1 FROM workflow_notification_recipients r
        WHERE r.recipient_type = 'service_subject' AND r.subject_type = 'repair_shop'
          AND r.subject_id = s.id AND r.is_enabled = 1
      )
    `).get(),
  ]);
  return {
    items: rows.map(recipientDto),
    warning: {
      missingStationContacts: Number(stationMissing?.count ?? 0),
      missingRepairShopContacts: Number(repairMissing?.count ?? 0),
      hasDutyRecipient: rows.some((row) => String(row.recipient_type) === "platform_duty" && Number(row.is_enabled) === 1),
      blocksBusiness: false,
    },
  };
}

function encodeCursor(row: Row): string {
  return Buffer.from(`${String(row.created_at)}|${String(row.id)}`, "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const [createdAt, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    if (!createdAt || !id || !Number.isFinite(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function inboxDto(row: Row) {
  const dueAt = row.task_due_at == null ? null : String(row.task_due_at);
  const now = Date.now();
  const taskStatus = row.task_status == null ? null : String(row.task_status);
  const firstReminderAt = row.task_first_reminder_at == null ? null : String(row.task_first_reminder_at);
  const urgency = taskStatus === "open" && row.task_escalated_at != null
    ? "escalated"
    : taskStatus === "open" && dueAt && new Date(dueAt).getTime() <= now
      ? "overdue"
      : taskStatus === "open" && dueAt
        && (new Date(dueAt).getTime() - now <= 30 * 60_000
          || (firstReminderAt != null && new Date(firstReminderAt).getTime() <= now))
        ? "due_soon" : "normal";
  const actionCode = String(row.action_code);
  return {
    id: String(row.id),
    taskId: row.task_id == null ? null : String(row.task_id),
    title: String(row.title),
    body: String(row.body),
    actionCode,
    actionParams: jsonObject(row.action_params_json),
    templateCode: row.template_code == null ? null : String(row.template_code),
    category: actionCode.startsWith("repair.") ? "repair" : actionCode.startsWith("annual.") ? "annual_inspection" : "workflow",
    urgency,
    dueAt,
    isRead: row.read_at != null,
    readAt: row.read_at == null ? null : String(row.read_at),
    createdAt: String(row.created_at),
  };
}

export async function ownerWorkflowNotifications(
  database: AppDatabase,
  userId: string,
  query: { cursor?: string; limit?: number; unreadOnly?: boolean },
) {
  const limit = Math.max(1, Math.min(50, query.limit ?? 20));
  const cursor = decodeCursor(query.cursor);
  if (query.cursor && !cursor) domainError(400, "WORKFLOW_NOTIFICATION_CURSOR_INVALID", "消息分页游标无效");
  const cursorFilter = cursor ? "AND (n.created_at, n.id) < (?, ?)" : "";
  const rows = await database.prepare<Row>(`
    SELECT n.*, t.stable_code AS template_code,
      wt.due_at AS task_due_at, wt.first_reminder_at AS task_first_reminder_at,
      wt.escalated_at AS task_escalated_at, wt.status AS task_status
    FROM notification_inbox n
    LEFT JOIN notification_templates t ON t.id = n.template_id
    LEFT JOIN workflow_tasks wt ON wt.id = n.task_id
    WHERE n.recipient_user_id = ?
      AND (? = 0 OR n.read_at IS NULL)
      ${cursorFilter}
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ?
  `).all(
    userId, query.unreadOnly ? 1 : 0,
    ...(cursor ? [cursor.createdAt, cursor.id] : []),
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    notifications: page.map(inboxDto),
    items: page.map(inboxDto),
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page.at(-1)!) : null,
  };
}

export async function ownerWorkflowNotificationSummary(database: AppDatabase, userId: string) {
  const row = await database.prepare<Row>(`
    SELECT COUNT(*) FILTER (WHERE read_at IS NULL) AS unread_count,
      COUNT(*) AS total_count,
      MAX(created_at) FILTER (WHERE read_at IS NULL) AS latest_unread_at
    FROM notification_inbox WHERE recipient_user_id = ?
  `).get(userId);
  const taskRow = await database.prepare<Row>(`
    SELECT
      COUNT(*) FILTER (
        WHERE due_at IS NOT NULL AND due_at > ? AND due_at <= ?
      ) AS attention_count,
      COUNT(*) FILTER (
        WHERE due_at IS NOT NULL AND due_at <= ? AND escalated_at IS NULL
      ) AS overdue_count,
      COUNT(*) FILTER (
        WHERE escalated_at IS NOT NULL
      ) AS escalated_count
    FROM workflow_tasks
    WHERE owner_user_id = ? AND assignee_role = 'owner' AND status = 'open'
  `).get(
    new Date().toISOString(),
    new Date(Date.now() + 30 * 60_000).toISOString(),
    new Date().toISOString(),
    userId,
  );
  return {
    unreadCount: Number(row?.unread_count ?? 0),
    totalCount: Number(row?.total_count ?? 0),
    latestUnreadAt: row?.latest_unread_at == null ? null : String(row.latest_unread_at),
    attentionCount: Number(taskRow?.attention_count ?? 0),
    overdueCount: Number(taskRow?.overdue_count ?? 0) + Number(taskRow?.escalated_count ?? 0),
  };
}

async function scopedWorkflowTasks(
  database: AppDatabase,
  scope: { subjectType?: string; subjectId?: string; ownerUserId?: string; entityId?: string; assigneeRole?: string },
  query: {
    taskId?: string;
    status?: "open" | "closed" | "completed" | "cancelled" | "expired";
    domain?: WorkflowDomain;
    assigneeRole?: "owner" | "station" | "driver" | "repair_shop" | "platform";
    urgency?: "normal" | "due_soon" | "overdue" | "escalated";
    limit?: number;
  } = {},
) {
  const limit = Math.max(1, Math.min(200, query.limit ?? 100));
  const current = new Date();
  const currentIso = current.toISOString();
  const soonIso = new Date(current.getTime() + 30 * 60_000).toISOString();
  const clauses: string[] = [];
  const values: Array<string | number> = [currentIso, currentIso, currentIso, soonIso, currentIso];
  const addClause = (clause: string, ...parameters: Array<string | number>) => {
    clauses.push(clause);
    values.push(...parameters);
  };
  if (scope.subjectType) addClause("subject_type = ?", scope.subjectType);
  if (scope.subjectId) addClause("subject_id = ?", scope.subjectId);
  if (scope.ownerUserId) addClause("owner_user_id = ?", scope.ownerUserId);
  if (scope.entityId) addClause("entity_id = ?", scope.entityId);
  if (scope.assigneeRole) addClause("assignee_role = ?", scope.assigneeRole);
  if (query.taskId) addClause("id = ?", query.taskId);
  if (query.domain) addClause("domain = ?", query.domain);
  if (query.assigneeRole) addClause("assignee_role = ?", query.assigneeRole);
  if (query.status === "closed") addClause("status IN ('completed', 'cancelled', 'expired')");
  else if (query.status) addClause("status = ?", query.status);
  if (query.urgency) addClause("computed_urgency = ?", query.urgency);
  values.push(limit);
  const rows = await database.prepare<Row>(`
    SELECT * FROM (
      SELECT workflow_tasks.*,
        CASE
          WHEN subject_type = 'inspection_station' THEN (
            SELECT stations.name FROM stations WHERE stations.id = workflow_tasks.subject_id
          )
          WHEN subject_type = 'repair_shop' THEN (
            SELECT repair_shops.name FROM repair_shops WHERE repair_shops.id = workflow_tasks.subject_id
          )
          WHEN subject_type = 'platform_duty' THEN (
            CASE WHEN EXISTS (
              SELECT 1 FROM workflow_notification_recipients recipients
              WHERE recipients.recipient_type = 'platform_duty' AND recipients.is_enabled = 1
            ) THEN '平台值班组' ELSE '平台值班组（联系人未配置）' END
          )
          ELSE NULL
        END AS subject_name,
        CASE
          WHEN escalated_at IS NOT NULL OR (escalate_at IS NOT NULL AND escalate_at <= ?) THEN 'escalated'
          WHEN due_at IS NOT NULL AND due_at <= ? THEN 'overdue'
          WHEN due_at IS NOT NULL AND due_at > ?
            AND (due_at <= ? OR (first_reminder_at IS NOT NULL AND first_reminder_at <= ?)) THEN 'due_soon'
          ELSE 'normal'
        END AS computed_urgency
      FROM workflow_tasks
    ) scoped_tasks
    ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY
      CASE computed_urgency WHEN 'escalated' THEN 0 WHEN 'overdue' THEN 1
        WHEN 'due_soon' THEN 2 ELSE 3 END,
      CASE WHEN status = 'open' THEN 0 ELSE 1 END,
      due_at NULLS LAST, created_at DESC
    LIMIT ?
  `).all(...values);
  return rows.map(taskRowDto);
}

const WORKFLOW_TASK_EVENT_LABELS: Record<string, string> = {
  created: "任务已创建",
  reminder_queued: "提醒已进入队列",
  assignment_notification_queued: "派单通知已进入队列",
  manual_reminder: "平台已人工提醒",
  task_center_reminder: "任务中心站内督办已生效",
  notification_skipped: "本次通知未发送",
  overdue: "任务已超时",
  escalated: "任务已升级",
  closed: "任务已关闭",
};

function workflowTaskEventDto(row: Row) {
  const metadata = jsonObject(row.metadata_json);
  let detail: string | null = null;
  if (metadata.taskCenterVisible === true) {
    detail = metadata.inboxQueued === true || metadata.outboxQueued === true || metadata.notificationQueued === true
      ? "任务中心站内督办已生效，额外通知已进入发送队列"
      : "任务中心站内督办已生效，未配置额外推送渠道";
  } else if (metadata.reason === "no_available_delivery_route") {
    detail = "没有可用的通知接收人或投递渠道";
  } else if (typeof metadata.reason === "string") detail = metadata.reason;
  else if (typeof metadata.notificationSuppressedBy === "string") {
    detail = `通知已由 ${metadata.notificationSuppressedBy} 节点合并处理`;
  } else if (typeof metadata.occurrence === "number") {
    detail = `第 ${metadata.occurrence} 次提醒`;
  } else if (typeof metadata.notificationQueued === "boolean") {
    detail = metadata.notificationQueued ? "通知已进入发送队列" : "没有可用的通知渠道";
  }
  return {
    id: String(row.id),
    type: String(row.event_type),
    label: WORKFLOW_TASK_EVENT_LABELS[String(row.event_type)] ?? String(row.event_type),
    actorType: String(row.actor_type),
    fromStatus: row.from_status == null ? null : String(row.from_status),
    toStatus: row.to_status == null ? null : String(row.to_status),
    createdAt: String(row.occurred_at),
    detail,
    supervision: {
      taskCenterVisible: metadata.taskCenterVisible === true,
      inboxQueued: metadata.inboxQueued === true,
      outboxQueued: metadata.outboxQueued === true,
    },
  };
}

function workflowDeliveryState(counts: Record<string, number>): string {
  if ((counts.deadLetter ?? 0) > 0) return "投递异常";
  if ((counts.failed ?? 0) > 0) return "投递失败";
  if ((counts.retry ?? 0) > 0) return "等待重试";
  if ((counts.processing ?? 0) > 0) return "投递中";
  if ((counts.pending ?? 0) > 0) return "已进入发送队列";
  if ((counts.delivered ?? 0) > 0) return "已送达";
  if ((counts.accepted ?? 0) > 0) return "服务商已受理（非最终送达）";
  if ((counts.cancelled ?? 0) > 0) return "投递已取消";
  return "尚未投递";
}

async function scopedWorkflowTaskDetail(
  database: AppDatabase,
  scope: { subjectType?: string; subjectId?: string; ownerUserId?: string; entityId?: string; assigneeRole?: string },
  taskId: string,
) {
  const [task] = await scopedWorkflowTasks(database, scope, { taskId, limit: 1 });
  if (!task) return null;
  const [events, outboxRows, attemptRow] = await Promise.all([
    database.prepare<Row>(`
      SELECT id, event_type, actor_type, from_status, to_status, metadata_json, occurred_at
      FROM workflow_task_events WHERE task_id = ?
      ORDER BY occurred_at DESC, id DESC
    `).all(taskId),
    database.prepare<Row>(`
      SELECT id, channel, status, template_code, template_version,
        recipient_address_masked, attempt_count, available_at, provider_state,
        last_error_code, accepted_at, delivered_at, created_at, updated_at
      FROM notification_outbox WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(taskId),
    database.prepare<Row>(`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE outcome = 'accepted') AS accepted,
        COUNT(*) FILTER (WHERE outcome = 'delivered') AS delivered,
        COUNT(*) FILTER (WHERE outcome IN ('failed', 'permanent_failure', 'temporary_failure')) AS failed,
        MAX(completed_at) AS last_attempt_at
      FROM notification_delivery_attempts
      WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE task_id = ?)
    `).get(taskId),
  ]);
  const statusCounts = Object.fromEntries([
    "pending", "processing", "retry", "accepted", "delivered", "failed", "dead_letter", "cancelled",
  ].map((status) => [status, outboxRows.filter((row) => String(row.status) === status).length]));
  const deliveryState = workflowDeliveryState(statusCounts);
  const outbox = outboxRows.map((row) => ({
    id: String(row.id),
    channel: String(row.channel),
    status: String(row.status),
    templateCode: String(row.template_code),
    templateVersion: Number(row.template_version),
    recipientAddressMasked: row.recipient_address_masked == null ? null : String(row.recipient_address_masked),
    attemptCount: Number(row.attempt_count),
    availableAt: String(row.available_at),
    providerState: row.provider_state == null ? null : String(row.provider_state),
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
    acceptedAt: row.accepted_at == null ? null : String(row.accepted_at),
    deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
  const deliverySummary = {
    state: deliveryState,
    total: outboxRows.length,
    byStatus: statusCounts,
    attempts: {
      total: Number(attemptRow?.total ?? 0),
      accepted: Number(attemptRow?.accepted ?? 0),
      delivered: Number(attemptRow?.delivered ?? 0),
      failed: Number(attemptRow?.failed ?? 0),
      lastAttemptAt: attemptRow?.last_attempt_at == null ? null : String(attemptRow.last_attempt_at),
    },
  };
  const eventDtos = events.map(workflowTaskEventDto);
  return {
    task: { ...task, events: eventDtos, deliveryState, deliverySummary, outbox },
    events: eventDtos,
    outbox,
    deliverySummary,
  };
}

async function scopedWorkflowTaskSummary(
  database: AppDatabase,
  scope: { subjectType?: string; subjectId?: string; ownerUserId?: string; entityId?: string; assigneeRole?: string },
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const soonIso = new Date(now.getTime() + 30 * 60_000).toISOString();
  const row = await database.prepare<Row>(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'open') AS pending,
      COUNT(*) FILTER (WHERE status = 'open' AND due_at IS NOT NULL AND due_at > ?
        AND (due_at <= ? OR (first_reminder_at IS NOT NULL AND first_reminder_at <= ?))) AS due_soon,
      COUNT(*) FILTER (WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?
        AND escalated_at IS NULL AND (escalate_at IS NULL OR escalate_at > ?)) AS overdue,
      COUNT(*) FILTER (WHERE status = 'open'
        AND (escalated_at IS NOT NULL OR (escalate_at IS NOT NULL AND escalate_at <= ?))) AS escalated,
      COUNT(*) FILTER (WHERE status = 'open' AND task_kind = 'blocking') AS blocking,
      MIN(due_at) FILTER (WHERE status = 'open' AND due_at IS NOT NULL) AS next_due_at
    FROM workflow_tasks
    WHERE (?::text IS NULL OR subject_type = ?::text)
      AND (?::text IS NULL OR subject_id = ?::text)
      AND (?::text IS NULL OR owner_user_id = ?::text)
      AND (?::text IS NULL OR entity_id = ?::text)
      AND (?::text IS NULL OR assignee_role = ?::text)
  `).get(
    nowIso, soonIso, nowIso, nowIso, nowIso, nowIso,
    scope.subjectType ?? null, scope.subjectType ?? null,
    scope.subjectId ?? null, scope.subjectId ?? null,
    scope.ownerUserId ?? null, scope.ownerUserId ?? null,
    scope.entityId ?? null, scope.entityId ?? null,
    scope.assigneeRole ?? null, scope.assigneeRole ?? null,
  );
  return {
    pending: Number(row?.pending ?? 0),
    dueSoon: Number(row?.due_soon ?? 0),
    overdue: Number(row?.overdue ?? 0),
    escalated: Number(row?.escalated ?? 0),
    blocking: Number(row?.blocking ?? 0),
    nextDueAt: row?.next_due_at == null ? null : String(row.next_due_at),
  };
}

/**
 * Service workbenches only expose three urgency buckets: pending, due soon and
 * overdue. An escalated task is still open and overdue for the station, repair
 * shop or driver that owns the business action, so fold the platform escalation
 * bucket into their overdue counter. The platform admin summary deliberately
 * keeps both buckets separate for escalation monitoring.
 */
async function participantWorkflowTaskSummary(
  database: AppDatabase,
  scope: { subjectType?: string; subjectId?: string; ownerUserId?: string; entityId?: string; assigneeRole?: string },
) {
  const summary = await scopedWorkflowTaskSummary(database, scope);
  return {
    ...summary,
    overdue: summary.overdue + summary.escalated,
  };
}

async function platformPrincipal(
  request: FastifyRequest,
  database: AppDatabase,
  allowTestFallback: boolean,
): Promise<BackofficeSession> {
  const principal = await requireBackoffice(request, database, { allowTestFallback });
  if (principal.account.role !== "platform_admin") {
    throw new BackofficeError(403, "WORKFLOW_SETTINGS_FORBIDDEN", "仅平台管理员可以配置和发布督办规则");
  }
  return principal;
}

async function workflowReader(
  request: FastifyRequest,
  database: AppDatabase,
  allowTestFallback: boolean,
): Promise<BackofficeSession> {
  return assertCapability(
    await requireBackoffice(request, database, { allowTestFallback }),
    "workflow.tasks.read",
  );
}

function assertWorkflowPolicyDomainAccess(principal: BackofficeSession, domain: WorkflowDomain): void {
  if (principal.account.role === "platform_admin") return;
  if (principal.account.role === "inspection_station_admin" && domain === "annual_inspection") return;
  if (principal.account.role === "repair_shop_admin" && domain === "repair_quote") return;
  throw new BackofficeError(403, "WORKFLOW_POLICY_SCOPE_FORBIDDEN", "不能查看其他业务主体的督办规则");
}

function workflowProblem(error: unknown, problem?: WorkflowProblemFactory): never {
  if (error instanceof WorkflowDomainError && problem) throw problem(error.statusCode, error.code, error.message, error.fields);
  throw error;
}

function parseLimit(value: unknown, fallback = 20): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.floor(parsed))) : fallback;
}

function driverTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requireDriverBooking(request: FastifyRequest, database: AppDatabase, bookingId: string, problem?: WorkflowProblemFactory): Promise<void> {
  const token = request.headers.authorization?.match(/^Bearer\s+([^\s]+)$/iu)?.[1];
  if (!token || !token.startsWith("yxm_drv_")) {
    throw (problem?.(401, "DRIVER_AUTHENTICATION_REQUIRED", "需要有效的代驾任务会话") ?? new BackofficeError(401, "DRIVER_AUTHENTICATION_REQUIRED", "需要有效的代驾任务会话"));
  }
  const row = await database.prepare<Row>(`
    SELECT s.id FROM valet_driver_sessions s
    INNER JOIN valet_driver_assignments a ON a.id = s.assignment_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      AND a.booking_id = ? AND a.status NOT IN ('completed', 'cancelled')
    LIMIT 1
  `).get(driverTokenHash(token), new Date().toISOString(), bookingId);
  if (!row) throw (problem?.(404, "DRIVER_TASK_NOT_FOUND", "未找到可访问的代驾任务") ?? new BackofficeError(404, "DRIVER_TASK_NOT_FOUND", "未找到可访问的代驾任务"));
}

export function registerWorkflowRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: WorkflowRouteOptions = {},
): void {
  const now = options.now ?? (() => new Date());
  const allowTestFallback = options.allowBackofficeTestFallback ?? process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK === "true";

  const ownerList = async (request: FastifyRequest) => {
    const userId = await requireCurrentUser(request, database);
    const query = (request.query ?? {}) as Record<string, unknown>;
    return { data: await ownerWorkflowNotifications(database, userId, {
      cursor: typeof query.cursor === "string" ? query.cursor : undefined,
      limit: parseLimit(query.limit, 20),
      unreadOnly: query.unreadOnly === true || query.unreadOnly === "true" || query.unread_only === "true",
    }) };
  };
  const ownerSummary = async (request: FastifyRequest) => {
    const userId = await requireCurrentUser(request, database);
    return { data: await ownerWorkflowNotificationSummary(database, userId) };
  };
  const readAll = async (request: FastifyRequest, reply: { code: (status: number) => { send: (body?: unknown) => unknown } }) => {
    const userId = await requireCurrentUser(request, database);
    await database.prepare(`
      UPDATE notification_inbox SET read_at = COALESCE(read_at, ?)
      WHERE recipient_user_id = ? AND read_at IS NULL
    `).run(now().toISOString(), userId);
    return reply.code(204).send();
  };
  const readOne = async (request: FastifyRequest, reply: { code: (status: number) => { send: (body?: unknown) => unknown } }) => {
    const userId = await requireCurrentUser(request, database);
    const id = String((request.params as { id?: unknown }).id ?? "");
    const result = await database.prepare(`
      UPDATE notification_inbox SET read_at = COALESCE(read_at, ?)
      WHERE id = ? AND recipient_user_id = ?
    `).run(now().toISOString(), id, userId);
    if (result.changes !== 1) throw (options.problem?.(404, "WORKFLOW_NOTIFICATION_NOT_FOUND", "未找到该消息") ?? new BackofficeError(404, "WORKFLOW_NOTIFICATION_NOT_FOUND", "未找到该消息"));
    return reply.code(204).send();
  };

  app.get("/api/workflow/notifications", ownerList);
  app.get("/api/workflow/notifications/summary", ownerSummary);
  app.post("/api/workflow/notifications/read-all", readAll);
  app.post("/api/workflow/notifications/:id/read", readOne);
  // Compatibility aliases for clients created before the /workflow namespace was introduced.
  app.get("/api/notifications", ownerList);
  app.get("/api/notifications/unread-count", ownerSummary);
  app.post("/api/notifications/read-all", readAll);
  app.post("/api/notifications/:id/read", readOne);

  app.get("/api/workflow/wechat-subscription-templates", async (request) => {
    await requireCurrentUser(request, database);
    const purposeRaw = typeof (request.query as { purpose?: unknown })?.purpose === "string"
      ? String((request.query as { purpose?: string }).purpose).trim()
      : "message_center";
    const purpose = (purposeRaw in OWNER_WECHAT_SUBSCRIPTION_PURPOSES
      ? purposeRaw
      : "message_center") as OwnerWechatSubscriptionPurpose;
    const templates = await ownerWechatSubscriptionTemplates(database, purpose);
    return {
      data: {
        purpose,
        templateIds: templates.map((item) => item.providerTemplateId),
        templates,
      },
    };
  });

  app.post("/api/workflow/wechat-subscriptions", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const parsed = z.object({
      templateId: z.string().trim().min(1).max(180),
      state: z.enum(["accepted", "rejected", "banned", "unknown"]),
    }).strict().safeParse(request.body);
    if (!parsed.success) throw (options.problem?.(400, "WECHAT_SUBSCRIPTION_INVALID", "微信订阅授权结果无效") ?? new BackofficeError(400, "WECHAT_SUBSCRIPTION_INVALID", "微信订阅授权结果无效"));
    const providerAppId = workflowWechatAppId();
    if (!providerAppId || !workflowIntegrationStatus().wechat.configured) {
      throw (options.problem?.(503, "WECHAT_SUBSCRIPTION_NOT_CONFIGURED", "微信订阅消息尚未配置") ?? new BackofficeError(503, "WECHAT_SUBSCRIPTION_NOT_CONFIGURED", "微信订阅消息尚未配置"));
    }
    const availableTemplateIds = await ownerWechatSubscriptionTemplateIds(database);
    if (!availableTemplateIds.includes(parsed.data.templateId)) {
      throw (options.problem?.(400, "WECHAT_SUBSCRIPTION_TEMPLATE_UNAVAILABLE", "该微信订阅模板当前不可用") ?? new BackofficeError(400, "WECHAT_SUBSCRIPTION_TEMPLATE_UNAVAILABLE", "该微信订阅模板当前不可用"));
    }
    const id = randomUUID();
    const remainingUses = parsed.data.state === "accepted" ? 1 : 0;
    await database.prepare(`
      INSERT INTO wechat_subscription_authorizations (
        id, user_id, template_id, authorization_state, remaining_uses, provider_app_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, template_id, provider_app_id) DO UPDATE SET
        authorization_state = excluded.authorization_state,
        remaining_uses = excluded.remaining_uses,
        updated_at = excluded.updated_at
    `).run(
      id, userId, parsed.data.templateId, parsed.data.state,
      remainingUses, providerAppId, now().toISOString(),
    );
    return { data: { recorded: true } };
  });

  const operatorTasks = async (request: FastifyRequest) => {
    const principal = await resolveInspectionStationBearer(request, database);
    if (!principal?.subject || principal.subject.type !== "inspection_station") {
      throw (options.problem?.(401, "OPERATOR_AUTHENTICATION_REQUIRED", "需要有效的检测站账号会话") ?? new BackofficeError(401, "OPERATOR_AUTHENTICATION_REQUIRED", "需要有效的检测站账号会话"));
    }
    const scope = { subjectType: "inspection_station", subjectId: principal.subject.id };
    const [tasks, summary] = await Promise.all([
      scopedWorkflowTasks(database, scope, { status: "open", limit: parseLimit((request.query as Json | undefined)?.limit, 100) }),
      participantWorkflowTaskSummary(database, scope),
    ]);
    return { data: { tasks, summary } };
  };
  app.get("/api/operator/workflow/tasks", operatorTasks);
  app.get("/api/operator/workflow/tasks/summary", async (request) => {
    const result = await operatorTasks(request);
    return { data: result.data.summary };
  });

  const repairTasks = async (request: FastifyRequest) => {
    const principal = await requireRepairShopBearer(request, database);
    if (!principal.subject || principal.subject.type !== "repair_shop") {
      throw new BackofficeError(403, "REPAIR_OPERATOR_ACCOUNT_REQUIRED", "仅维修门店管理员可以访问维修待办");
    }
    const scope = { subjectType: "repair_shop", subjectId: principal.subject.id };
    const [tasks, summary] = await Promise.all([
      scopedWorkflowTasks(database, scope, { status: "open", limit: parseLimit((request.query as Json | undefined)?.limit, 100) }),
      participantWorkflowTaskSummary(database, scope),
    ]);
    return { data: { tasks, summary } };
  };
  app.get("/api/repair-operator/workflow/tasks", repairTasks);
  app.get("/api/repair-operator/workflow/tasks/summary", async (request) => {
    const result = await repairTasks(request);
    return { data: result.data.summary };
  });

  const driverTasks = async (request: FastifyRequest) => {
    const bookingId = String((request.params as { id?: unknown }).id ?? "");
    await requireDriverBooking(request, database, bookingId, options.problem);
    const scope = { entityId: bookingId, assigneeRole: "driver" };
    const [tasks, summary] = await Promise.all([
      scopedWorkflowTasks(database, scope, { status: "open", limit: 100 }),
      participantWorkflowTaskSummary(database, scope),
    ]);
    return { data: { tasks, summary } };
  };
  app.get("/api/driver/tasks/:id/workflow", driverTasks);
  app.get("/api/driver/tasks/:id/workflow/summary", async (request) => {
    const result = await driverTasks(request);
    return { data: result.data.summary };
  });

  app.get("/api/admin/workflow/summary", async (request) => {
    const principal = await workflowReader(request, database, allowTestFallback);
    if (principal.account.role !== "platform_admin" && !principal.subject) {
      throw new BackofficeError(403, "WORKFLOW_TASK_SCOPE_REQUIRED", "当前账号未绑定可查看的服务主体");
    }
    const scope = principal.account.role === "platform_admin"
      ? {}
      : { subjectType: principal.subject?.type, subjectId: principal.subject?.id };
    const summary = await scopedWorkflowTaskSummary(database, scope);
    const outbox = principal.account.role === "platform_admin"
      ? await database.prepare<Row>(`
          SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'retry', 'processing')) AS queued,
            COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter,
            COUNT(*) FILTER (WHERE status = 'accepted') AS accepted
          FROM notification_outbox
        `).get()
      : undefined;
    return { data: { ...summary, outbox: {
      queued: outbox ? Number(outbox.queued ?? 0) : null,
      deadLetter: outbox ? Number(outbox.dead_letter ?? 0) : null,
      accepted: outbox ? Number(outbox.accepted ?? 0) : null,
    } } };
  });

  app.get("/api/admin/workflow/tasks", async (request) => {
    const principal = await workflowReader(request, database, allowTestFallback);
    if (principal.account.role !== "platform_admin" && !principal.subject) {
      throw new BackofficeError(403, "WORKFLOW_TASK_SCOPE_REQUIRED", "当前账号未绑定可查看的服务主体");
    }
    const query = (request.query ?? {}) as Json;
    const filters = z.object({
      status: z.enum(["open", "closed", "completed", "cancelled", "expired"]).optional(),
      domain: z.enum(WORKFLOW_DOMAINS).optional(),
      role: z.enum(["owner", "station", "driver", "repair_shop", "platform"]).optional(),
      urgency: z.enum(["normal", "due_soon", "overdue", "escalated"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).safeParse(query);
    if (!filters.success) {
      throw (options.problem?.(400, "WORKFLOW_TASK_FILTER_INVALID", "督办任务筛选条件无效")
        ?? new BackofficeError(400, "WORKFLOW_TASK_FILTER_INVALID", "督办任务筛选条件无效"));
    }
    const scope = principal.account.role === "platform_admin"
      ? {}
      : { subjectType: principal.subject?.type, subjectId: principal.subject?.id };
    const [tasks, summary] = await Promise.all([
      scopedWorkflowTasks(database, scope, {
        status: filters.data.status,
        domain: filters.data.domain,
        assigneeRole: filters.data.role,
        urgency: filters.data.urgency,
        limit: filters.data.limit ?? 100,
      }),
      scopedWorkflowTaskSummary(database, scope),
    ]);
    return { data: { tasks, summary } };
  });

  app.get("/api/admin/workflow/tasks/:id", async (request) => {
    const principal = await workflowReader(request, database, allowTestFallback);
    if (principal.account.role !== "platform_admin" && !principal.subject) {
      throw new BackofficeError(403, "WORKFLOW_TASK_SCOPE_REQUIRED", "当前账号未绑定可查看的服务主体");
    }
    const taskId = String((request.params as { id?: unknown }).id ?? "").trim();
    if (!taskId) {
      throw (options.problem?.(404, "WORKFLOW_TASK_NOT_FOUND", "未找到该督办任务")
        ?? new BackofficeError(404, "WORKFLOW_TASK_NOT_FOUND", "未找到该督办任务"));
    }
    const scope = principal.account.role === "platform_admin"
      ? {}
      : { subjectType: principal.subject?.type, subjectId: principal.subject?.id };
    const detail = await scopedWorkflowTaskDetail(database, scope, taskId);
    if (!detail) {
      throw (options.problem?.(404, "WORKFLOW_TASK_NOT_FOUND", "未找到该督办任务")
        ?? new BackofficeError(404, "WORKFLOW_TASK_NOT_FOUND", "未找到该督办任务"));
    }
    return { data: detail };
  });

  app.post("/api/admin/workflow/tasks/:id/remind", async (request) => {
    const principal = assertCapability(
      await requireBackoffice(request, database, { allowTestFallback }),
      "workflow.tasks.remind",
    );
    const taskId = String((request.params as { id?: unknown }).id ?? "");
    try {
      return await database.transaction(async (transaction) => {
        const task = await transaction.prepare<Row>("SELECT * FROM workflow_tasks WHERE id = ? FOR UPDATE").get(taskId);
        if (!task || String(task.status) !== "open") domainError(404, "WORKFLOW_TASK_NOT_FOUND", "未找到可提醒的待办");
        if (principal.account.role !== "platform_admin"
          && (principal.subject?.type !== String(task.subject_type) || principal.subject?.id !== String(task.subject_id))) {
          domainError(404, "WORKFLOW_TASK_NOT_FOUND", "未找到可提醒的待办");
        }
        if (task.last_reminded_at && now().getTime() - new Date(String(task.last_reminded_at)).getTime() < 10 * 60_000) {
          domainError(429, "WORKFLOW_MANUAL_REMIND_COOLDOWN", "同一任务 10 分钟内只能人工提醒一次");
        }
        const occurrence = Number(task.reminder_count) + 1;
        const notification = await queueWorkflowTaskNotification(transaction, task, "manual", occurrence, now());
        if (!notification.queued) {
          if (notification.taskCenterVisible) {
            domainError(
              409,
              "WORKFLOW_EXTRA_NOTIFICATION_UNAVAILABLE",
              "任务已在督办列表中。要让责任方收到额外提醒，请先在「通知联系人」配置短信，或确保接收人已授权微信订阅消息",
            );
          }
          domainError(409, "WORKFLOW_NOTIFICATION_UNAVAILABLE", "当前任务没有可用的通知接收人或投递渠道");
        }
        const remindedAt = now().toISOString();
        await transaction.prepare(`
          UPDATE workflow_tasks SET reminder_count = reminder_count + 1, last_reminded_at = ?, updated_at = ? WHERE id = ?
        `).run(remindedAt, remindedAt, taskId);
        await transaction.prepare(`
          INSERT INTO workflow_task_events (
            id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
          ) VALUES (?, ?, 'manual_reminder', 'platform', ?, 'open', 'open', ?, ?)
        `).run(
          randomUUID(),
          taskId,
          principal.account.id,
          JSON.stringify({
            inboxQueued: notification.inboxQueued,
            outboxQueued: notification.outboxQueued,
          }),
          remindedAt,
        );
        await auditBackofficeEvent(transaction, {
          request,
          action: "workflow.task.remind",
          outcome: "success",
          resource: { type: "workflow_task", id: taskId },
          occurredAt: remindedAt,
        });
        const cooldownSeconds = 600;
        return {
          data: {
            reminded: true,
            cooldownSeconds,
            nextManualReminderAt: new Date(now().getTime() + cooldownSeconds * 1_000).toISOString(),
            delivery: {
              inboxQueued: notification.inboxQueued,
              outboxQueued: notification.outboxQueued,
            },
            message: notification.outboxQueued
              ? "人工提醒已进入短信/微信发送队列"
              : notification.inboxQueued
                ? "人工提醒已写入站内消息"
                : "人工提醒已受理",
          },
        };
      });
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });

  app.post("/api/admin/workflow/tasks/:id/resolve", async (request) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    const taskId = String((request.params as { id?: unknown }).id ?? "");
    const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
    if (!parsed.success) throw new BackofficeError(400, "WORKFLOW_RESOLUTION_REASON_REQUIRED", "请填写异常处理结果");
    try {
      return await database.transaction(async (transaction) => {
        const task = await transaction.prepare<Row>("SELECT * FROM workflow_tasks WHERE id = ? FOR UPDATE").get(taskId);
        if (!task || String(task.node_code) !== "workflow.exception" || String(task.status) !== "open") {
          domainError(404, "WORKFLOW_EXCEPTION_NOT_FOUND", "未找到可关闭的平台异常待办");
        }
        await closeWorkflowTasks(transaction, {
          domain: String(task.domain) as WorkflowDomain,
          entityType: String(task.entity_type),
          entityId: String(task.entity_id),
          taskIds: [taskId],
          reason: `workflow.exception_resolved: ${parsed.data.reason}`,
          actorType: "platform",
          actorId: principal.account.id,
        }, { now: now() });
        await auditBackofficeEvent(transaction, {
          request,
          action: "workflow.exception.resolve",
          outcome: "success",
          resource: { type: "workflow_task", id: taskId },
          metadata: { reason: parsed.data.reason },
          occurredAt: now().toISOString(),
        });
        const detail = await scopedWorkflowTaskDetail(transaction, {}, taskId);
        return { data: detail };
      });
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });

  app.get("/api/admin/workflow/policies/current", async (request) => {
    const principal = await workflowReader(request, database, allowTestFallback);
    const domain = ((request.query as Json | undefined)?.domain ?? "annual_inspection") as WorkflowDomain;
    if (!WORKFLOW_DOMAINS.includes(domain)) throw new BackofficeError(400, "WORKFLOW_DOMAIN_INVALID", "督办业务领域无效");
    assertWorkflowPolicyDomainAccess(principal, domain);
    return { data: (await getWorkflowPolicies(database, domain)).current };
  });
  app.get("/api/admin/workflow/policies/draft", async (request) => {
    await platformPrincipal(request, database, allowTestFallback);
    const domain = ((request.query as Json | undefined)?.domain ?? "annual_inspection") as WorkflowDomain;
    if (!WORKFLOW_DOMAINS.includes(domain)) throw new BackofficeError(400, "WORKFLOW_DOMAIN_INVALID", "督办业务领域无效");
    return { data: (await getWorkflowPolicies(database, domain)).draft };
  });
  app.put("/api/admin/workflow/policies/draft", async (request) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    try {
      return { data: await saveWorkflowPolicyDraft(database, request.body, { actor: principal.account.id, now: now() }) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });
  const draftValidation = async (request: FastifyRequest) => {
    await platformPrincipal(request, database, allowTestFallback);
    const domain = (((request.body as Json | undefined)?.domain ?? (request.query as Json | undefined)?.domain) ?? "annual_inspection") as WorkflowDomain;
    const draft = await database.prepare<Row>("SELECT id FROM workflow_policy_sets WHERE domain = ? AND state = 'draft'").get(domain);
    if (!draft) throw new BackofficeError(404, "WORKFLOW_POLICY_DRAFT_NOT_FOUND", "没有可校验的策略草稿");
    try {
      return { data: await validateWorkflowPolicy(database, String(draft.id)) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  };
  app.post("/api/admin/workflow/policies/draft/validate", draftValidation);
  app.post("/api/admin/workflow/policies/draft/preview", async (request) => {
    const validation = await draftValidation(request);
    const domain = (((request.body as Json | undefined)?.domain ?? "annual_inspection")) as WorkflowDomain;
    const draft = (await getWorkflowPolicies(database, domain)).draft;
    const anchor = now();
    return { data: { ...(validation as Json).data as Json, policy: draft, sample: draft ? (draft.nodes as Array<Json>).map((node) => ({
      nodeCode: node.nodeCode,
      firstReminderAt: addWorkflowMinutes(anchor, node.firstReminderMinutes as number | null, node.timerMode as "business" | "natural", draft.businessHours)?.toISOString() ?? null,
      dueAt: addWorkflowMinutes(anchor, node.deadlineMinutes as number | null, node.timerMode as "business" | "natural", draft.businessHours)?.toISOString() ?? null,
      escalateAt: addWorkflowMinutes(anchor, node.escalationMinutes as number | null, node.timerMode as "business" | "natural", draft.businessHours)?.toISOString() ?? null,
    })) : [] } };
  });
  app.post("/api/admin/workflow/policies/draft/publish", async (request) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    const body = (request.body ?? {}) as Json;
    const domain = (body.domain ?? "annual_inspection") as WorkflowDomain;
    try {
      return { data: await publishWorkflowPolicy(database, { domain, expectedRevision: Number(body.expectedRevision) }, { actor: principal.account.id, now: now(), request }) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });

  app.get("/api/admin/workflow/templates", async (request) => {
    await platformPrincipal(request, database, allowTestFallback);
    const query = (request.query ?? {}) as Json;
    return { data: { items: await listWorkflowTemplates(database, {
      stableCode: typeof query.stableCode === "string" ? query.stableCode : undefined,
      channel: typeof query.channel === "string" ? query.channel : undefined,
    }) } };
  });
  app.put("/api/admin/workflow/templates/:code/draft", async (request) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    const code = String((request.params as { code?: unknown }).code ?? "");
    try {
      return { data: await saveWorkflowTemplateDraft(database, { ...(request.body as Json), stableCode: code }, { actor: principal.account.id, now: now() }) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });
  app.post("/api/admin/workflow/templates/:code/preview", async (request) => {
    await platformPrincipal(request, database, allowTestFallback);
    const code = String((request.params as { code?: unknown }).code ?? "");
    const body = (request.body ?? {}) as Json;
    const channel = String(body.channel ?? "in_app");
    const row = await database.prepare<Row>(`
      SELECT * FROM notification_templates WHERE stable_code = ? AND channel = ?
      ORDER BY CASE state WHEN 'draft' THEN 0 ELSE 1 END, CASE WHEN is_current = 1 THEN 0 ELSE 1 END, version DESC NULLS LAST
      LIMIT 1
    `).get(code, channel);
    if (!row) throw new BackofficeError(404, "WORKFLOW_TEMPLATE_NOT_FOUND", "未找到通知模板");
    const dto = templateDto(row);
    const exampleOverride = body.exampleData && typeof body.exampleData === "object" && !Array.isArray(body.exampleData)
      ? body.exampleData as WorkflowTemplateVariables
      : null;
    const exampleData = exampleOverride
      ? { ...dto.exampleData, ...exampleOverride }
      : dto.exampleData as WorkflowTemplateVariables;
    const renderedBody = renderWorkflowTemplate(String(row.body), exampleData);
    const renderedTitle = renderWorkflowTemplate(String(row.title ?? ""), exampleData);
    const providerSnapshot = jsonObject(row.provider_snapshot_json);
    const mappings = Array.isArray(providerSnapshot.fieldMappings) ? providerSnapshot.fieldMappings : [];
    const wechatFieldPreview = channel === "wechat"
      ? mappings.flatMap((raw) => {
        const mapping = jsonObject(raw);
        const field = typeof mapping.field === "string" ? mapping.field.trim() : "";
        const variable = typeof mapping.variable === "string" ? mapping.variable.trim() : "";
        if (!field || !variable) return [];
        const value = exampleData[variable as keyof WorkflowTemplateVariables];
        return [{ field, variable, value: value == null ? "—" : String(value) }];
      })
      : [];
    return {
      data: {
        ...dto,
        exampleData,
        renderedTitle,
        renderedPreview: renderedBody,
        renderedBody,
        characterCount: renderedBody.length,
        smsSegments: channel === "sms" ? estimateSmsSegments(renderedBody) : null,
        wechatFieldPreview,
      },
    };
  });
  app.post("/api/admin/workflow/templates/:code/publish", async (request) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    const code = String((request.params as { code?: unknown }).code ?? "");
    const body = (request.body ?? {}) as Json;
    try {
      return { data: await publishWorkflowTemplate(database, {
        stableCode: code,
        channel: String(body.channel ?? "in_app") as "in_app" | "sms" | "wechat",
        expectedRevision: Number(body.expectedRevision),
      }, { actor: principal.account.id, now: now(), request }) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });

  app.get("/api/admin/workflow/recipients", async (request) => {
    await platformPrincipal(request, database, allowTestFallback);
    return { data: await listWorkflowRecipients(database) };
  });

  const persistWorkflowRecipient = async (request: FastifyRequest, raw: unknown) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    return database.transaction(async (transaction) => {
      const candidateId = raw && typeof raw === "object" && !Array.isArray(raw)
        && typeof (raw as Json).id === "string"
        ? String((raw as Json).id)
        : null;
      const before = candidateId
        ? await readWorkflowRecipientForAudit(transaction, candidateId, { lock: true })
        : null;
      const saved = await saveWorkflowRecipient(transaction, raw, {
        actor: principal.account.id,
        now: now(),
      });
      await auditBackofficeEvent(transaction, {
        request,
        action: before ? "workflow.recipient.update" : "workflow.recipient.create",
        outcome: "success",
        resource: { type: "workflow_notification_recipient", id: saved.id },
        before: before ?? undefined,
        // recipientDto never contains the encrypted value or the phone hash and
        // exposes only the masked phone representation. Never pass a raw row or
        // the request body into audit storage.
        after: saved,
        occurredAt: now().toISOString(),
      });
      return saved;
    });
  };

  app.put("/api/admin/workflow/recipients", async (request) => {
    try {
      return { data: await persistWorkflowRecipient(request, request.body) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });
  app.post("/api/admin/workflow/recipients", async (request) => {
    try {
      return { data: await persistWorkflowRecipient(request, request.body) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });
  app.put("/api/admin/workflow/recipients/:id", async (request) => {
    const id = String((request.params as { id?: unknown }).id ?? "");
    try {
      return { data: await persistWorkflowRecipient(request, { ...(request.body as Json), id }) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });
  app.delete("/api/admin/workflow/recipients/:id", async (request, reply) => {
    await platformPrincipal(request, database, allowTestFallback);
    const id = String((request.params as { id?: unknown }).id ?? "");
    await database.transaction(async (transaction) => {
      const before = await readWorkflowRecipientForAudit(transaction, id, { lock: true });
      if (!before) throw new BackofficeError(404, "WORKFLOW_RECIPIENT_NOT_FOUND", "未找到通知联系人");
      const occurredAt = now().toISOString();
      const result = await transaction.prepare(`
        UPDATE workflow_notification_recipients
        SET is_enabled = 0, updated_at = ?
        WHERE id = ?
      `).run(occurredAt, id);
      if (result.changes !== 1) throw new BackofficeError(404, "WORKFLOW_RECIPIENT_NOT_FOUND", "未找到通知联系人");
      const after = await readWorkflowRecipientForAudit(transaction, id);
      await auditBackofficeEvent(transaction, {
        request,
        action: "workflow.recipient.disable",
        outcome: "success",
        resource: { type: "workflow_notification_recipient", id },
        before,
        after: after ?? undefined,
        occurredAt,
      });
    });
    return reply.code(204).send();
  });

  app.get("/api/admin/workflow/integrations/status", async (request) => {
    await platformPrincipal(request, database, allowTestFallback);
    return { data: workflowIntegrationStatus() };
  });

  app.post("/api/admin/workflow/test-sms", async (request) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    const parsed = z.object({
      templateId: z.string().trim().min(1).max(200),
      recipientId: z.string().uuid(),
      variables: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    }).safeParse(request.body);
    if (!parsed.success) throw new BackofficeError(400, "WORKFLOW_TEST_SMS_INVALID", "测试短信参数无效");
    const current = now();
    const id = randomUUID();
    await database.transaction(async (transaction) => {
      // The actor-scoped transaction lock serializes the rolling-window check
      // and quota reservation. Concurrent requests therefore cannot both pass
      // the one-per-minute or five-per-day limits.
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`workflow-test-sms:${principal.account.id}`);
      const recipient = await transaction.prepare<Row>(`
        SELECT * FROM workflow_notification_recipients
        WHERE id = ? AND is_enabled = 1
        FOR SHARE
      `).get(parsed.data.recipientId);
      if (!recipient) throw new BackofficeError(404, "WORKFLOW_RECIPIENT_NOT_FOUND", "未找到可用的测试短信联系人");
      const limits = await transaction.prepare<Row>(`
        SELECT COUNT(*) FILTER (WHERE sent_at >= ?) AS minute_count,
          COUNT(*) FILTER (WHERE sent_at >= ?) AS day_count
        FROM workflow_test_sms_limits WHERE actor_id = ?
      `).get(
        new Date(current.getTime() - 60_000).toISOString(),
        new Date(current.getTime() - 86_400_000).toISOString(),
        principal.account.id,
      );
      if (Number(limits?.minute_count ?? 0) >= 1 || Number(limits?.day_count ?? 0) >= 5) {
        throw new BackofficeError(429, "WORKFLOW_TEST_SMS_RATE_LIMITED", "测试短信每分钟最多一次、每天最多五次");
      }
      const template = await transaction.prepare<Row>(`
        SELECT * FROM notification_templates
        WHERE id = ? AND channel = 'sms' AND state = 'published' AND filing_status = 'approved'
        FOR SHARE
      `).get(parsed.data.templateId);
      if (!template) throw new BackofficeError(409, "WORKFLOW_TEST_SMS_TEMPLATE_UNAVAILABLE", "请选择已发布且报备通过的短信模板");
      const variables = sanitizedTemplateVariables(parsed.data.variables);
      const body = renderWorkflowTemplate(String(template.body), variables);
      const recipientHash = String(recipient.phone_hash);
      await transaction.prepare(`
        INSERT INTO workflow_test_sms_limits (id, actor_id, recipient_hash, sent_at) VALUES (?, ?, ?, ?)
      `).run(randomUUID(), principal.account.id, recipientHash, current.toISOString());
      await transaction.prepare(`
        INSERT INTO notification_outbox (
          id, task_id, channel, status, template_id, template_code, template_version,
          rendered_title, rendered_body, action_code, action_params_json,
          recipient_address_encrypted, recipient_address_masked, recipient_address_hash,
          sensitive_payload_encrypted, fallback_channels_json, fallback_index,
          dedupe_key, aggregate_key, attempt_count, available_at, leased_until, lease_owner,
          provider_message_id, provider_state, last_error_code, last_error_message,
          accepted_at, delivered_at, sensitive_cleared_at, created_at, updated_at
        ) VALUES (?, NULL, 'sms', 'pending', ?, ?, ?, '', ?, ?, '{}', ?, ?, ?, NULL, '[]', 0, ?, NULL, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        id, String(template.id), String(template.stable_code), Number(template.version), body,
        String(template.action_code), String(recipient.phone_encrypted), String(recipient.phone_masked), recipientHash,
        `test-sms:${principal.account.id}:${id}`, current.toISOString(), current.toISOString(), current.toISOString(),
      );
      const recipientAudit = recipientDto(recipient);
      await auditBackofficeEvent(transaction, {
        request,
        action: "workflow.test_sms.queue",
        outcome: "success",
        resource: { type: "notification_outbox", id },
        // Do not audit rendered content, variables, raw rows, hashes or
        // encrypted addresses. The public DTO contains a masked phone only.
        after: {
          template: {
            id: String(template.id),
            stableCode: String(template.stable_code),
            version: Number(template.version),
          },
          recipient: recipientAudit,
          deliverySemantics: "accepted_not_delivered",
        },
        occurredAt: current.toISOString(),
      });
    });
    return { data: { queued: true, outboxId: id, deliverySemantics: "accepted_not_delivered" } };
  });

  app.get("/api/admin/workflow/releases", async (request) => {
    await platformPrincipal(request, database, allowTestFallback);
    const rows = await database.prepare<Row>(`
      SELECT releases.*,
        COALESCE(policies.name, templates.name) AS resource_name,
        COALESCE(policies.stable_code, templates.stable_code) AS resource_code,
        templates.channel AS resource_channel,
        COALESCE(
          releases.domain,
          CASE
            WHEN templates.stable_code LIKE 'annual.%' THEN 'annual_inspection'
            WHEN templates.stable_code LIKE 'repair.%' THEN 'repair_quote'
            ELSE NULL
          END
        ) AS resolved_domain
      FROM workflow_release_events releases
      LEFT JOIN workflow_policy_sets policies
        ON releases.resource_type = 'workflow_policy' AND policies.id = releases.resource_id
      LEFT JOIN notification_templates templates
        ON releases.resource_type = 'notification_template' AND templates.id = releases.resource_id
      ORDER BY releases.occurred_at DESC, releases.id
      LIMIT ?
    `).all(parseLimit((request.query as Json | undefined)?.limit, 100));
    return { data: { items: rows.map((row) => ({
      id: String(row.id), resourceType: String(row.resource_type), resourceId: String(row.resource_id),
      code: row.resource_code == null ? null : String(row.resource_code),
      name: row.resource_name == null ? "已归档发布内容" : String(row.resource_name),
      channel: row.resource_channel == null ? null : String(row.resource_channel),
      domain: row.resolved_domain == null ? null : String(row.resolved_domain), version: row.version == null ? null : Number(row.version),
      actorId: String(row.actor_id), action: String(row.action), summary: jsonObject(row.summary_json), occurredAt: String(row.occurred_at),
    })) } };
  });
  app.post("/api/admin/workflow/releases/:id/copy-to-draft", async (request) => {
    const principal = await platformPrincipal(request, database, allowTestFallback);
    const releaseId = String((request.params as { id?: unknown }).id ?? "");
    const release = await database.prepare<Row>("SELECT * FROM workflow_release_events WHERE id = ?").get(releaseId);
    if (!release) throw new BackofficeError(404, "WORKFLOW_RELEASE_NOT_FOUND", "未找到发布记录");
    try {
      if (String(release.resource_type) === "workflow_policy") {
        return { data: await restoreWorkflowPolicyAsDraft(database, String(release.resource_id), { actor: principal.account.id, now: now() }) };
      }
      return { data: await restoreWorkflowTemplateAsDraft(database, String(release.resource_id), { actor: principal.account.id, now: now() }) };
    } catch (error) {
      workflowProblem(error, options.problem);
    }
  });
}

export const WORKFLOW_RETRY_MINUTES = RETRY_MINUTES;
