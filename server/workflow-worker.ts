import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import {
  WORKFLOW_RETRY_MINUTES,
  addWorkflowMinutes,
  applyWorkflowTransition,
  decryptWorkflowValue,
  queueWorkflowTaskNotification,
  renderWorkflowTemplate,
  workflowExternalTemplateUsable,
  workflowWechatAuthorizationAvailable,
  workflowIntegrationStatus,
  type WorkflowTemplateVariables,
} from "./workflow.js";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

class WorkflowFallbackBatchUnavailable extends Error {}

export type WorkflowDeliveryResult = {
  outcome: "accepted" | "temporary_failure" | "permanent_failure";
  providerCode?: string;
  providerMessageId?: string;
  message?: string;
};

export type WorkflowDeliveryMessage = {
  id: string;
  channel: "sms" | "wechat";
  recipient: string;
  title: string;
  body: string;
  providerTemplateId?: string | null;
  providerSnapshot?: Json;
  actionCode: string;
  actionParams: Json;
  variables?: WorkflowTemplateVariables;
};

export type WorkflowDeliverySender = (message: WorkflowDeliveryMessage) => Promise<WorkflowDeliveryResult>;

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

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message.slice(0, 300) : "通知供应商请求失败";
}

function smsPermanentCode(code: string): boolean {
  return ["30", "40", "41", "43", "50", "51"].includes(code);
}

/**
 * SMSBao documents code=0 as submission accepted. It is deliberately never
 * translated to delivered; final delivery needs the provider status report.
 * Secrets are used only in the outgoing HTTPS request and are never returned.
 */
export async function sendSmsBaoMessage(input: { phone: string; body: string }): Promise<WorkflowDeliveryResult> {
  const status = workflowIntegrationStatus().smsBao;
  const username = process.env.SMSBAO_USERNAME?.trim();
  const apiKey = process.env.SMSBAO_API_KEY?.trim();
  const signature = process.env.SMSBAO_SIGNATURE?.trim();
  if (!status.enabled || !status.configured || !username || !apiKey || !signature) {
    return { outcome: "permanent_failure", providerCode: "SMSBAO_NOT_CONFIGURED", message: "短信宝尚未完成安全配置" };
  }
  const body = input.body.startsWith(`【${signature}】`) ? input.body : `【${signature}】${input.body.replace(/^【[^】]+】/u, "")}`;
  const url = new URL("https://api.smsbao.com/sms");
  url.searchParams.set("u", username);
  url.searchParams.set("p", apiKey);
  url.searchParams.set("m", input.phone);
  url.searchParams.set("c", body);
  url.searchParams.set("f", "json");
  const productId = process.env.SMSBAO_PRODUCT_ID?.trim();
  if (productId) url.searchParams.set("g", productId);
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return {
        outcome: response.status >= 500 ? "temporary_failure" : "permanent_failure",
        providerCode: `HTTP_${response.status}`,
        message: "短信宝接口返回异常",
      };
    }
    const payload = await response.json() as { code?: unknown; msg?: unknown; data?: { taskId?: unknown } | null };
    const code = String(payload.code ?? "UNKNOWN");
    if (code === "0") {
      return {
        outcome: "accepted",
        providerCode: code,
        providerMessageId: payload.data?.taskId == null ? undefined : String(payload.data.taskId),
        message: "短信宝已受理",
      };
    }
    return {
      outcome: smsPermanentCode(code) ? "permanent_failure" : "temporary_failure",
      providerCode: code,
      message: typeof payload.msg === "string" ? payload.msg.slice(0, 160) : "短信宝拒绝请求",
    };
  } catch (error) {
    return { outcome: "temporary_failure", providerCode: "NETWORK_ERROR", message: errorMessage(error) };
  }
}

let wechatAccessTokenCache: { appId: string; token: string; expiresAt: number } | null = null;

async function wechatAccessToken(): Promise<string | null> {
  const appId = (process.env.WECHAT_MINIPROGRAM_APP_ID ?? process.env.WECHAT_APP_ID)?.trim() ?? "";
  const appSecret = (process.env.WECHAT_MINIPROGRAM_APP_SECRET ?? process.env.WECHAT_APP_SECRET)?.trim() ?? "";
  if (!appId || !appSecret) return null;
  if (wechatAccessTokenCache?.appId === appId && wechatAccessTokenCache.expiresAt > Date.now() + 60_000) {
    return wechatAccessTokenCache.token;
  }
  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", appId);
  url.searchParams.set("secret", appSecret);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string" || !payload.access_token) return null;
  const expiresIn = Math.max(300, Number(payload.expires_in ?? 7200));
  wechatAccessTokenCache = { appId, token: payload.access_token, expiresAt: Date.now() + expiresIn * 1_000 };
  return payload.access_token;
}

function wechatPage(actionCode: string, params: Json): string | undefined {
  const id = String(params.bookingId ?? params.repairRequestId ?? params.resourceId ?? "").trim();
  if (!id) return undefined;
  const encoded = encodeURIComponent(id);
  const routes: Record<string, string> = {
    "annual.order.detail": `packages/annual/pages/order-detail/order-detail?id=${encoded}`,
    "annual.report.detail": `packages/inspection/pages/checkup-report/checkup-report?id=${encoded}`,
    "repair.request.detail": `packages/repair/pages/owner-request-detail/owner-request-detail?id=${encoded}`,
    "repair.quotes": `packages/repair/pages/owner-quotes/owner-quotes?id=${encoded}`,
    "driver.task.detail": `packages/driver/pages/task/task?bookingId=${encoded}`,
  };
  return routes[actionCode];
}

/** Normalize values to WeChat subscribe-message field type rules before send. */
export function formatWechatSubscribeFieldValue(field: string, raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (field.startsWith("character_string")) {
    // Strip masks first. Many category keywords (报告编号/主单号) only accept digits
    // even though the generic character_string type also allows letters.
    const cleaned = value.replace(/[^0-9A-Za-z\-_.]/g, "");
    const digits = cleaned.replace(/\D/g, "");
    if (digits.length >= 4) return digits.slice(-32);
    const alnum = cleaned.replace(/[^0-9A-Za-z]/g, "").slice(0, 32);
    return alnum || null;
  }
  if (field.startsWith("phrase")) {
    const cleaned = value.replace(/[^\u4e00-\u9fff]/g, "").slice(0, 5);
    return cleaned || null;
  }
  if (field.startsWith("thing")) return value.slice(0, 20);
  if (field.startsWith("time") || field.startsWith("date")) {
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(value);
    if (iso) {
      const clock = iso[4] ? ` ${iso[4]}:${iso[5]}${iso[6] ? `:${iso[6]}` : ""}` : "";
      return `${iso[1]}年${iso[2]}月${iso[3]}日${clock}`;
    }
    return value.slice(0, 32);
  }
  if (field.startsWith("amount")) {
    const compact = value.replace(/\s/g, "");
    if (/^￥?\d+(\.\d+)?元?$/u.test(compact)) {
      const number = compact.replace(/[￥元]/g, "");
      return `￥${number}`.slice(0, 16);
    }
    return compact.slice(0, 16);
  }
  return value.slice(0, 32);
}

export async function sendWechatSubscriptionMessage(input: WorkflowDeliveryMessage): Promise<WorkflowDeliveryResult> {
  if (!workflowIntegrationStatus().wechat.configured || !input.providerTemplateId) {
    return { outcome: "permanent_failure", providerCode: "WECHAT_NOT_CONFIGURED", message: "微信订阅消息尚未配置" };
  }
  const mappings = Array.isArray(input.providerSnapshot?.fieldMappings)
    ? input.providerSnapshot.fieldMappings as Array<{ field?: unknown; variable?: unknown }>
    : [];
  const data: Record<string, { value: string }> = {};
  for (const mapping of mappings) {
    if (typeof mapping.field !== "string" || !/^[A-Za-z]+\d+$/u.test(mapping.field)
      || typeof mapping.variable !== "string") continue;
    const raw = input.variables?.[mapping.variable as keyof WorkflowTemplateVariables];
    const formatted = formatWechatSubscribeFieldValue(mapping.field, raw);
    if (!formatted) continue;
    data[mapping.field] = { value: formatted };
  }
  if (Object.keys(data).length === 0) {
    return { outcome: "permanent_failure", providerCode: "WECHAT_FIELD_MAPPING_INVALID", message: "微信模板字段映射不可用" };
  }
  try {
    const token = await wechatAccessToken();
    if (!token) return { outcome: "temporary_failure", providerCode: "WECHAT_TOKEN_UNAVAILABLE", message: "微信访问令牌获取失败" };
    const url = new URL("https://api.weixin.qq.com/cgi-bin/message/subscribe/send");
    url.searchParams.set("access_token", token);
    const configuredState = process.env.WECHAT_MINIPROGRAM_STATE?.trim();
    const miniprogramState = ["developer", "trial", "formal"].includes(configuredState ?? "")
      ? configuredState
      : (process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production" ? "formal" : "developer");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: input.recipient,
        template_id: input.providerTemplateId,
        page: wechatPage(input.actionCode, input.actionParams),
        miniprogram_state: miniprogramState,
        lang: "zh_CN",
        data,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { outcome: response.status >= 500 ? "temporary_failure" : "permanent_failure", providerCode: `HTTP_${response.status}`, message: "微信订阅消息接口返回异常" };
    }
    const payload = await response.json() as { errcode?: unknown; errmsg?: unknown; msgid?: unknown };
    const code = String(payload.errcode ?? "UNKNOWN");
    if (code === "0") {
      return {
        outcome: "accepted",
        providerCode: code,
        providerMessageId: payload.msgid == null ? undefined : String(payload.msgid),
        message: "微信已受理",
      };
    }
    const permanent = ["40003", "40037", "41030", "43101", "47003"].includes(code);
    return {
      outcome: permanent ? "permanent_failure" : "temporary_failure",
      providerCode: code,
      message: typeof payload.errmsg === "string" ? payload.errmsg.slice(0, 160) : "微信订阅消息发送失败",
    };
  } catch (error) {
    return { outcome: "temporary_failure", providerCode: "WECHAT_NETWORK_ERROR", message: errorMessage(error) };
  }
}

export const defaultWorkflowDeliverySender: WorkflowDeliverySender = async (message) => {
  if (message.channel === "sms") return sendSmsBaoMessage({ phone: message.recipient, body: message.body });
  return sendWechatSubscriptionMessage(message);
};

async function scheduleDueTaskNotifications(database: AppDatabase, now: Date, limit: number): Promise<number> {
  return database.transaction(async (transaction) => {
    const tasks = await transaction.prepare<Row>(`
      SELECT * FROM workflow_tasks t
      WHERE t.status = 'open' AND (
        (t.next_reminder_at IS NOT NULL AND t.next_reminder_at <= ? AND t.reminder_count < t.max_reminders)
        OR (t.due_at IS NOT NULL AND t.due_at <= ? AND NOT EXISTS (
          SELECT 1 FROM workflow_task_events e WHERE e.task_id = t.id AND e.event_type = 'overdue'
        ))
        OR (t.escalate_at IS NOT NULL AND t.escalate_at <= ? AND t.escalated_at IS NULL)
      )
      ORDER BY COALESCE(t.escalate_at, t.due_at, t.next_reminder_at), t.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ?
    `).all(now.toISOString(), now.toISOString(), now.toISOString(), limit);
    for (const task of tasks) {
      const taskId = String(task.id);
      const node = jsonObject(task.policy_node_snapshot_json);
      const currentCount = Number(task.reminder_count);
      let nextCount = currentCount;
      let nextReminderAt = task.next_reminder_at == null ? null : String(task.next_reminder_at);
      let reminderProcessed = false;
      let reminderQueued = false;
      let supervisionRecordedThisPass = false;
      const escalationDue = task.escalated_at == null && task.escalate_at != null
        && new Date(String(task.escalate_at)).getTime() <= now.getTime();
      const overdueExists = await transaction.prepare<Row>(`
        SELECT 1 FROM workflow_task_events WHERE task_id = ? AND event_type = 'overdue' LIMIT 1
      `).get(taskId);
      const overdueDue = !overdueExists && task.due_at != null
        && new Date(String(task.due_at)).getTime() <= now.getTime();
      const reminderDue = task.next_reminder_at != null
        && new Date(String(task.next_reminder_at)).getTime() <= now.getTime()
        && currentCount < Number(task.max_reminders);

      let escalatedAt = task.escalated_at == null ? null : String(task.escalated_at);
      if (escalationDue) {
        // Escalation is the single highest-priority notification for a worker
        // pass. In particular, deadline === escalation must not emit both an
        // overdue and an escalation message.
        const notification = await queueWorkflowTaskNotification(
          transaction, task, "escalation", Math.max(1, currentCount + 1), now,
        );
        supervisionRecordedThisPass = notification.queued || notification.taskCenterVisible;
        nextReminderAt = null;
        escalatedAt = now.toISOString();
        if (overdueDue) {
          await transaction.prepare(`
            INSERT INTO workflow_task_events (
              id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
            ) VALUES (?, ?, 'overdue', 'system', NULL, 'open', 'open', ?, ?)
          `).run(randomUUID(), taskId, safeJson({ notificationSuppressedBy: "escalation" }), now.toISOString());
        }
        await transaction.prepare(`
          INSERT INTO workflow_task_events (
            id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
          ) VALUES (?, ?, 'escalated', 'system', NULL, 'open', 'open', ?, ?)
        `).run(randomUUID(), taskId, safeJson({
          notificationQueued: notification.queued,
          taskCenterVisible: notification.taskCenterVisible,
          inboxQueued: notification.inboxQueued,
          outboxQueued: notification.outboxQueued,
        }), now.toISOString());
        const escalationLevel = String(node.escalationLevel ?? "platform_duty");
        if (escalationLevel !== "none" && String(task.node_code) !== "workflow.exception") {
          await applyWorkflowTransition(transaction, {
            domain: String(task.domain) as "annual_inspection" | "repair_quote",
            entityType: String(task.entity_type),
            entityId: String(task.entity_id),
            open: [{
              nodeCode: "workflow.exception",
              subjectType: "platform_duty",
              subjectId: null,
              assigneeRole: "platform",
              metadata: {
                pendingCount: 1,
                overdueCount: 1,
                escalationLevel,
                sourceTaskId: taskId,
                maskedBusinessCode: String(jsonObject(task.metadata_json).maskedBusinessCode ?? "—"),
              },
              firstReminderAt: now,
            }],
            actorType: "system",
          }, { now });
        }
      } else if (overdueDue) {
        const notification = await queueWorkflowTaskNotification(
          transaction, task, "overdue", Math.max(1, currentCount + 1), now,
        );
        supervisionRecordedThisPass = notification.queued || notification.taskCenterVisible;
        nextReminderAt = null;
        await transaction.prepare(`
          INSERT INTO workflow_task_events (
            id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
          ) VALUES (?, ?, 'overdue', 'system', NULL, 'open', 'open', ?, ?)
        `).run(randomUUID(), taskId, safeJson({
          notificationQueued: notification.queued,
          taskCenterVisible: notification.taskCenterVisible,
          inboxQueued: notification.inboxQueued,
          outboxQueued: notification.outboxQueued,
        }), now.toISOString());
      } else if (reminderDue) {
        reminderProcessed = true;
        const occurrence = currentCount + 1;
        const notification = await queueWorkflowTaskNotification(transaction, task, "reminder", occurrence, now);
        reminderQueued = notification.queued;
        const supervisionRecorded = notification.queued || notification.taskCenterVisible;
        supervisionRecordedThisPass = supervisionRecorded;
        if (supervisionRecorded) {
          nextCount = occurrence;
          const interval = task.reminder_interval_minutes == null ? null : Number(task.reminder_interval_minutes);
          const scheduled = stringArray(task.reminder_schedule_json)
            .find((value) => new Date(value).getTime() > now.getTime());
          const next = !scheduled && nextCount < Number(task.max_reminders)
            ? addWorkflowMinutes(now, interval, String(node.timerMode) === "business" ? "business" : "natural", node.businessHours)
            : null;
          nextReminderAt = scheduled ?? next?.toISOString() ?? null;
        } else {
          // No recipient/channel is not a send. Stop polling this timestamp; a
          // later business action or manual reissue may create a fresh task.
          nextReminderAt = null;
        }
        await transaction.prepare(`
          INSERT INTO workflow_task_events (
            id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
          ) VALUES (?, ?, ?, 'system', NULL, 'open', 'open', ?, ?)
        `).run(
          randomUUID(), taskId,
          notification.queued
            ? "reminder_queued"
            : notification.taskCenterVisible ? "task_center_reminder" : "notification_skipped",
          safeJson({
            occurrence,
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
      const informationCompleted = String(task.task_kind) === "information"
        && reminderProcessed
        && reminderQueued
        && nextReminderAt == null;
      const informationCloseReason = "notification_queued";
      await transaction.prepare(`
        UPDATE workflow_tasks SET reminder_count = ?, next_reminder_at = ?,
          last_reminded_at = CASE WHEN ? THEN ? ELSE last_reminded_at END,
          escalated_at = ?, status = CASE WHEN ? THEN 'completed' ELSE status END,
          closed_at = CASE WHEN ? THEN ? ELSE closed_at END,
          closed_reason = CASE WHEN ? THEN ? ELSE closed_reason END,
          updated_at = ?
        WHERE id = ?
      `).run(
        nextCount, informationCompleted ? null : nextReminderAt, supervisionRecordedThisPass, now.toISOString(), escalatedAt,
        informationCompleted, informationCompleted, now.toISOString(), informationCompleted, informationCloseReason,
        now.toISOString(), taskId,
      );
      if (informationCompleted) {
        await transaction.prepare(`
          INSERT INTO workflow_task_events (
            id, task_id, event_type, actor_type, actor_id, from_status, to_status, metadata_json, occurred_at
          ) VALUES (?, ?, 'closed', 'system', NULL, 'open', 'completed', ?, ?)
        `).run(randomUUID(), taskId, safeJson({ reason: informationCloseReason }), now.toISOString());
      }
    }
    return tasks.length;
  });
}

type WorkflowOutboxBatch = { primary: Row; rows: Row[] };

async function claimOutbox(database: AppDatabase, now: Date, workerId: string): Promise<WorkflowOutboxBatch | null> {
  return database.transaction(async (transaction) => {
    // Read the candidate before taking row locks. Aggregated candidates first
    // take a transaction advisory lock, preventing two workers from splitting
    // the same 30-minute bucket into duplicate provider requests.
    const candidate = await transaction.prepare<Row>(`
      SELECT * FROM notification_outbox
      WHERE status IN ('pending', 'retry')
        AND available_at <= ?
        AND (leased_until IS NULL OR leased_until <= ?)
      ORDER BY available_at, created_at
      LIMIT 1
    `).get(now.toISOString(), now.toISOString());
    if (!candidate) return null;
    let rows: Row[];
    if (candidate.aggregate_key != null) {
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")
        .get(String(candidate.aggregate_key));
      rows = await transaction.prepare<Row>(`
        SELECT * FROM notification_outbox
        WHERE aggregate_key = ? AND status IN ('pending', 'retry')
          AND available_at <= ? AND (leased_until IS NULL OR leased_until <= ?)
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
      `).all(String(candidate.aggregate_key), now.toISOString(), now.toISOString());
    } else {
      rows = await transaction.prepare<Row>(`
        SELECT * FROM notification_outbox
        WHERE id = ? AND status IN ('pending', 'retry')
          AND available_at <= ? AND (leased_until IS NULL OR leased_until <= ?)
        FOR UPDATE SKIP LOCKED
      `).all(String(candidate.id), now.toISOString(), now.toISOString());
    }
    if (rows.length === 0) return null;
    const leasedUntil = new Date(now.getTime() + 60_000).toISOString();
    const claimed = await transaction.prepare(`
      UPDATE notification_outbox SET status = 'processing', lease_owner = ?, leased_until = ?, updated_at = ?
      WHERE id = ANY(?::text[]) AND status IN ('pending', 'retry')
        AND available_at <= ? AND (leased_until IS NULL OR leased_until <= ?)
    `).run(workerId, leasedUntil, now.toISOString(), rows.map((row) => String(row.id)), now.toISOString(), now.toISOString());
    if (claimed.changes !== rows.length) return null;
    const claimedRows = rows.map((row) => ({ ...row, status: "processing", lease_owner: workerId, leased_until: leasedUntil }));
    return { primary: claimedRows[0], rows: claimedRows };
  });
}

async function createDeliveryFailureException(database: AppDatabase, outbox: Row, now: Date, reason: string): Promise<void> {
  if (!outbox.task_id) return;
  const task = await database.prepare<Row>("SELECT * FROM workflow_tasks WHERE id = ?").get(String(outbox.task_id));
  const taskCanEscalate = task && (
    String(task.status) === "open"
    || (String(task.task_kind) === "information"
      && String(task.status) === "completed"
      && String(task.closed_reason) === "notification_queued")
  );
  if (!taskCanEscalate || String(task.node_code) === "workflow.exception") return;
  await applyWorkflowTransition(database, {
    domain: String(task.domain) as "annual_inspection" | "repair_quote",
    entityType: String(task.entity_type),
    entityId: String(task.entity_id),
    open: [{
      nodeCode: "workflow.exception",
      subjectType: "platform_duty",
      subjectId: null,
      assigneeRole: "platform",
      metadata: {
        pendingCount: 1,
        overdueCount: 1,
        failureReason: reason,
        sourceTaskId: String(task.id),
        maskedBusinessCode: String(jsonObject(task.metadata_json).maskedBusinessCode ?? "—"),
      },
      firstReminderAt: now,
    }],
  }, { now });
}

async function quarantineExpiredProcessing(database: AppDatabase, now: Date, limit: number): Promise<number> {
  return database.transaction(async (transaction) => {
    const rows = await transaction.prepare<Row>(`
      SELECT * FROM notification_outbox
      WHERE status = 'processing' AND leased_until IS NOT NULL AND leased_until <= ?
      ORDER BY leased_until, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ?
    `).all(now.toISOString(), limit);
    let quarantined = 0;
    for (const row of rows) {
      const attempt = Number(row.attempt_count) + 1;
      const changed = await transaction.prepare(`
        UPDATE notification_outbox SET status = 'dead_letter', provider_state = 'unknown',
          last_error_code = 'DELIVERY_OUTCOME_UNKNOWN',
          last_error_message = '外发进程租约过期，供应商是否受理未知，已停止自动重发',
          sensitive_payload_encrypted = NULL,
          sensitive_cleared_at = CASE WHEN sensitive_payload_encrypted IS NOT NULL THEN ? ELSE sensitive_cleared_at END,
          leased_until = NULL, lease_owner = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing'
          AND lease_owner IS NOT DISTINCT FROM ? AND leased_until <= ?
      `).run(
        now.toISOString(), now.toISOString(), String(row.id), row.lease_owner == null ? null : String(row.lease_owner), now.toISOString(),
      );
      if (changed.changes !== 1) continue;
      quarantined += 1;
      await transaction.prepare(`
        INSERT INTO notification_delivery_attempts (
          id, outbox_id, channel, attempt_number, outcome, provider_code,
          provider_message_id, error_class, recipient_address_hash, started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'unknown', 'DELIVERY_OUTCOME_UNKNOWN', NULL, 'unknown', ?, ?, ?)
        ON CONFLICT (outbox_id, attempt_number) DO UPDATE SET
          outcome = 'unknown', provider_code = 'DELIVERY_OUTCOME_UNKNOWN',
          error_class = 'unknown', completed_at = excluded.completed_at
      `).run(
        randomUUID(), String(row.id), String(row.channel), attempt,
        row.recipient_address_hash == null ? null : String(row.recipient_address_hash),
        String(row.updated_at ?? now.toISOString()), now.toISOString(),
      );
      await createDeliveryFailureException(transaction, row, now, "delivery_outcome_unknown");
    }
    return quarantined;
  });
}

type DeliveryAttemptStart = {
  owned: boolean;
  precomputedResult?: WorkflowDeliveryResult;
  wechatAuthorizationId?: string;
  wechatUseReserved?: boolean;
};

async function startDeliveryAttempt(
  database: AppDatabase,
  batch: WorkflowOutboxBatch,
  workerId: string,
  attempt: number,
  now: Date,
): Promise<DeliveryAttemptStart> {
  return database.transaction(async (transaction) => {
    const outbox = batch.primary;
    const current = await transaction.prepare<Row>(`
      SELECT id FROM notification_outbox
      WHERE id = ANY(?::text[]) AND status = 'processing' AND lease_owner = ?
      FOR UPDATE
    `).all(batch.rows.map((row) => String(row.id)), workerId);
    if (current.length !== batch.rows.length) {
      return { owned: false };
    }
    let precomputedResult: WorkflowDeliveryResult | undefined;
    let wechatAuthorizationId: string | undefined;
    let wechatUseReserved = false;
    if (String(outbox.channel) === "sms" && outbox.recipient_address_hash) {
      const recipientHash = String(outbox.recipient_address_hash);
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(recipientHash);
      const row = await transaction.prepare<Row>(`
        SELECT COUNT(*) AS count FROM notification_delivery_attempts
        WHERE channel = 'sms' AND recipient_address_hash = ?
          AND outcome IN ('accepted', 'processing') AND started_at >= ?
      `).get(recipientHash, new Date(now.getTime() - 24 * 60 * 60_000).toISOString());
      if (Number(row?.count ?? 0) >= 4) {
        precomputedResult = {
          outcome: "permanent_failure",
          providerCode: "RECIPIENT_DAILY_LIMIT",
          message: "同一手机号 24 小时最多 4 条短信",
        };
      }
    }
    if (!precomputedResult && String(outbox.channel) === "wechat" && outbox.task_id) {
      const task = await transaction.prepare<Row>("SELECT recipient_user_id, template_bindings_snapshot_json FROM workflow_tasks WHERE id = ?")
        .get(String(outbox.task_id));
      const frozenTemplate = jsonObject(jsonObject(task?.template_bindings_snapshot_json).wechat);
      const appId = (process.env.WECHAT_MINIPROGRAM_APP_ID ?? process.env.WECHAT_APP_ID)?.trim() ?? "";
      const authorization = task?.recipient_user_id && appId && typeof frozenTemplate.providerTemplateId === "string"
        ? await transaction.prepare<Row>(`
            SELECT * FROM wechat_subscription_authorizations
            WHERE user_id = ? AND template_id = ? AND authorization_state = 'accepted'
              AND remaining_uses > 0 AND provider_app_id = ?
            ORDER BY updated_at DESC
            FOR UPDATE SKIP LOCKED LIMIT 1
          `).get(String(task.recipient_user_id), String(frozenTemplate.providerTemplateId), appId)
        : undefined;
      if (!authorization) {
        precomputedResult = {
          outcome: "permanent_failure",
          providerCode: "WECHAT_AUTHORIZATION_REQUIRED",
          message: "用户未授权该微信订阅消息或授权次数已用尽",
        };
      } else {
        wechatAuthorizationId = String(authorization.id);
        const reserved = await transaction.prepare(`
          UPDATE wechat_subscription_authorizations
          SET remaining_uses = remaining_uses - 1, updated_at = ?
          WHERE id = ? AND remaining_uses > 0
        `).run(now.toISOString(), wechatAuthorizationId);
        if (reserved.changes !== 1) {
          precomputedResult = {
            outcome: "permanent_failure",
            providerCode: "WECHAT_AUTHORIZATION_REQUIRED",
            message: "微信订阅授权次数已用尽",
          };
        } else {
          wechatUseReserved = true;
        }
      }
    }
    const initial = precomputedResult ?? { outcome: "processing" as const };
    await transaction.prepare(`
      INSERT INTO notification_delivery_attempts (
        id, outbox_id, channel, attempt_number, outcome, provider_code,
        provider_message_id, error_class, recipient_address_hash, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT (outbox_id, attempt_number) DO NOTHING
    `).run(
      randomUUID(), String(outbox.id), String(outbox.channel), attempt, initial.outcome,
      precomputedResult?.providerCode ?? null,
      precomputedResult ? precomputedResult.outcome : null,
      outbox.recipient_address_hash == null ? null : String(outbox.recipient_address_hash),
      now.toISOString(), now.toISOString(),
    );
    return { owned: true, precomputedResult, wechatAuthorizationId, wechatUseReserved };
  });
}

async function resolvedMessage(database: AppDatabase, batch: WorkflowOutboxBatch, now: Date): Promise<WorkflowDeliveryMessage> {
  const outbox = batch.primary;
  if (!outbox.recipient_address_encrypted) throw new Error("Notification recipient is unavailable");
  const recipient = decryptWorkflowValue(String(outbox.recipient_address_encrypted));
  const task = outbox.task_id == null ? null : await database.prepare<Row>(`
    SELECT metadata_json, template_bindings_snapshot_json FROM workflow_tasks WHERE id = ?
  `).get(String(outbox.task_id));
  const frozenTemplate = jsonObject(jsonObject(task?.template_bindings_snapshot_json)[String(outbox.channel)]);
  let body = String(outbox.rendered_body);
  let title = String(outbox.rendered_title ?? "");
  let messageVariables: WorkflowTemplateVariables = {};
  if (outbox.sensitive_payload_encrypted) {
    const sensitive = jsonObject(decryptWorkflowValue(String(outbox.sensitive_payload_encrypted)));
    const variables = { ...jsonObject(task?.metadata_json), ...sensitive } as WorkflowTemplateVariables;
    messageVariables = variables;
    if (typeof frozenTemplate.body === "string") body = renderWorkflowTemplate(frozenTemplate.body, variables);
    if (typeof frozenTemplate.title === "string") title = renderWorkflowTemplate(frozenTemplate.title, variables);
  } else if (batch.rows.length > 1) {
    const taskIds = batch.rows.flatMap((row) => row.task_id == null ? [] : [String(row.task_id)]);
    const tasks = taskIds.length
      ? await database.prepare<Row>(`SELECT * FROM workflow_tasks WHERE id = ANY(?::text[])`).all(taskIds)
      : [];
    const firstVariables = jsonObject(tasks[0]?.metadata_json);
    const variables: WorkflowTemplateVariables = {
      ...firstVariables,
      pendingCount: batch.rows.length,
      overdueCount: tasks.filter((task) => task.due_at != null && new Date(String(task.due_at)).getTime() <= now.getTime()).length,
      maskedPlate: `${batch.rows.length}辆车`,
      maskedBusinessCode: `${batch.rows.length}笔业务`,
      remainingTime: "请尽快处理",
    };
    messageVariables = variables;
    if (typeof frozenTemplate.body === "string") {
      title = renderWorkflowTemplate(String(frozenTemplate.title ?? ""), variables);
      body = renderWorkflowTemplate(frozenTemplate.body, variables);
    }
  } else if (outbox.task_id) {
    messageVariables = jsonObject(task?.metadata_json) as WorkflowTemplateVariables;
  }
  return {
    id: String(outbox.id),
    channel: String(outbox.channel) as "sms" | "wechat",
    recipient,
    title,
    body,
    providerTemplateId: frozenTemplate.providerTemplateId == null ? null : String(frozenTemplate.providerTemplateId),
    providerSnapshot: jsonObject(frozenTemplate.providerSnapshot),
    actionCode: String(outbox.action_code),
    actionParams: jsonObject(outbox.action_params_json),
    variables: messageVariables,
  };
}

async function switchToFallback(database: AppDatabase, outbox: Row, now: Date, workerId: string): Promise<boolean> {
  const channels = stringArray(outbox.fallback_channels_json);
  if (!outbox.task_id) return false;
  const task = await database.prepare<Row>("SELECT * FROM workflow_tasks WHERE id = ?").get(String(outbox.task_id));
  if (!task) return false;
  const snapshot = jsonObject(task.template_bindings_snapshot_json);
  let nextChannel: string | undefined;
  for (const channel of channels) {
    const hasAddress = channel === "sms"
      ? task.recipient_phone_encrypted != null
      : task.recipient_wechat_openid_encrypted != null;
    const template = jsonObject(snapshot[channel]);
    if (!["sms", "wechat"].includes(channel) || !hasAddress || !workflowExternalTemplateUsable(channel, template)) continue;
    if (channel === "wechat" && !await workflowWechatAuthorizationAvailable(database, task, template)) continue;
    nextChannel = channel;
    break;
  }
  if (!nextChannel) return false;
  const template = jsonObject(snapshot[nextChannel]);
  const encryptedAddress = nextChannel === "sms" ? task.recipient_phone_encrypted : task.recipient_wechat_openid_encrypted;
  const maskedAddress = nextChannel === "sms" ? task.recipient_phone_masked : task.recipient_wechat_openid_masked;
  const addressHash = nextChannel === "sms" ? task.recipient_phone_hash : task.recipient_wechat_openid_hash;
  if (!template.id || !encryptedAddress) return false;
  const variables = jsonObject(task.metadata_json) as WorkflowTemplateVariables;
  const body = renderWorkflowTemplate(String(template.body ?? ""), variables);
  const title = renderWorkflowTemplate(String(template.title ?? ""), variables);
  const aggregateKey = ["station", "repair_shop", "platform"].includes(String(task.assignee_role))
    ? [String(task.subject_type ?? task.assignee_role),
      String(task.subject_type) === "platform_duty" ? "current" : String(task.subject_id ?? "current"),
      addressHash == null ? "unknown" : String(addressHash), nextChannel, String(template.id),
      String(template.version), String(Math.floor(now.getTime() / (30 * 60_000)))].join(":")
    : null;
  const changed = await database.prepare(`
    UPDATE notification_outbox SET
      channel = ?, status = 'pending', template_id = ?, template_code = ?, template_version = ?,
      rendered_title = ?, rendered_body = ?, recipient_address_encrypted = ?,
      recipient_address_masked = ?, recipient_address_hash = ?, fallback_channels_json = ?,
      fallback_index = fallback_index + 1, aggregate_key = ?, available_at = ?, leased_until = NULL, lease_owner = NULL,
      last_error_code = NULL, last_error_message = NULL, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_owner = ?
  `).run(
    nextChannel, String(template.id), String(template.code), Number(template.version), title, body,
    String(encryptedAddress), maskedAddress == null ? null : String(maskedAddress),
    addressHash == null ? null : String(addressHash), safeJson(channels.slice(channels.indexOf(nextChannel) + 1)),
    aggregateKey, now.toISOString(), now.toISOString(), String(outbox.id), workerId,
  );
  return changed.changes === 1;
}

async function deadLetter(
  database: AppDatabase,
  batch: WorkflowOutboxBatch,
  result: WorkflowDeliveryResult,
  now: Date,
  workerId: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const ids = batch.rows.map((row) => String(row.id));
    const changed = await transaction.prepare(`
      UPDATE notification_outbox SET status = 'dead_letter', leased_until = NULL, lease_owner = NULL,
        last_error_code = ?, last_error_message = ?, sensitive_payload_encrypted = NULL,
        sensitive_cleared_at = ?, updated_at = ? WHERE id = ANY(?::text[])
        AND status = 'processing' AND lease_owner = ?
    `).run(
      result.providerCode ?? "DELIVERY_FAILED", result.message ?? "通知最终发送失败",
      now.toISOString(), now.toISOString(), ids, workerId,
    );
    if (changed.changes !== batch.rows.length) return;
    for (const row of batch.rows) {
      await createDeliveryFailureException(transaction, row, now, result.providerCode ?? "delivery_failed");
    }
  });
}

async function deliverClaimedOutbox(
  database: AppDatabase,
  batch: WorkflowOutboxBatch,
  sender: WorkflowDeliverySender,
  now: Date,
  workerId: string,
): Promise<void> {
  const outbox = batch.primary;
  const outboxId = String(outbox.id);
  const attempt = Number(outbox.attempt_count) + 1;
  const attemptStart = await startDeliveryAttempt(database, batch, workerId, attempt, now);
  if (!attemptStart.owned) return;
  let result = attemptStart.precomputedResult;
  if (!result) {
    try {
      result = await sender(await resolvedMessage(database, batch, now));
    } catch (error) {
      result = { outcome: "temporary_failure", providerCode: "SENDER_ERROR", message: errorMessage(error) };
    }
  }
  const ownsResult = await database.transaction(async (transaction) => {
    const ids = batch.rows.map((row) => String(row.id));
    const current = await transaction.prepare<Row>(`
      SELECT id FROM notification_outbox
      WHERE id = ANY(?::text[]) AND status = 'processing' AND lease_owner = ?
      FOR UPDATE
    `).all(ids, workerId);
    if (current.length !== batch.rows.length) {
      return false;
    }
    await transaction.prepare(`
      UPDATE notification_delivery_attempts SET outcome = ?, provider_code = ?,
        provider_message_id = ?, error_class = ?, completed_at = ?
      WHERE outbox_id = ? AND attempt_number = ?
    `).run(
      result.outcome, result.providerCode ?? null, result.providerMessageId ?? null,
      result.outcome === "accepted" ? null : result.outcome, now.toISOString(), outboxId, attempt,
    );
    // A subscription use is consumed before the network call. Ambiguous
    // network failures are deliberately not refunded: retrying with the same
    // grant can duplicate a message that WeChat may already have accepted.
    // Content-validation rejects (47003) never accept the message, so refund.
    if (attemptStart.wechatUseReserved && attemptStart.wechatAuthorizationId) {
      if (result.providerCode === "43101") {
        await transaction.prepare(`
          UPDATE wechat_subscription_authorizations
          SET authorization_state = 'rejected', remaining_uses = 0, updated_at = ? WHERE id = ?
        `).run(now.toISOString(), attemptStart.wechatAuthorizationId);
      } else if (result.providerCode === "47003") {
        await transaction.prepare(`
          UPDATE wechat_subscription_authorizations
          SET remaining_uses = remaining_uses + 1, updated_at = ? WHERE id = ?
        `).run(now.toISOString(), attemptStart.wechatAuthorizationId);
      }
    }
    if (result.outcome === "accepted") {
      const changed = await transaction.prepare(`
        UPDATE notification_outbox SET status = 'accepted', attempt_count = ?,
          provider_message_id = ?, provider_state = 'accepted', accepted_at = ?,
          sensitive_payload_encrypted = NULL, sensitive_cleared_at = ?,
          leased_until = NULL, lease_owner = NULL, last_error_code = NULL,
          last_error_message = NULL, updated_at = ?
        WHERE id = ANY(?::text[]) AND status = 'processing' AND lease_owner = ?
      `).run(
        attempt, result.providerMessageId ?? null, now.toISOString(), now.toISOString(),
        now.toISOString(), ids, workerId,
      );
      return changed.changes === batch.rows.length;
    }
    const changed = await transaction.prepare(`
      UPDATE notification_outbox SET attempt_count = ?, last_error_code = ?,
        last_error_message = ?, updated_at = ?
      WHERE id = ANY(?::text[]) AND status = 'processing' AND lease_owner = ?
    `).run(attempt, result.providerCode ?? null, result.message ?? null, now.toISOString(), ids, workerId);
    return changed.changes === batch.rows.length;
  });
  if (!ownsResult || result.outcome === "accepted") return;
  const latestRows = await database.prepare<Row>("SELECT * FROM notification_outbox WHERE id = ANY(?::text[])")
    .all(batch.rows.map((row) => String(row.id)));
  const fallbackAll = async (): Promise<boolean> => {
    try {
      await database.transaction(async (transaction) => {
        for (const row of latestRows) {
          if (!await switchToFallback(transaction, row, now, workerId)) {
            throw new WorkflowFallbackBatchUnavailable();
          }
        }
      });
      return true;
    } catch (error) {
      if (error instanceof WorkflowFallbackBatchUnavailable) return false;
      throw error;
    }
  };
  // WeChat grants are one-shot. On any failed send, prefer the configured SMS
  // fallback immediately instead of spending time retrying an already-consumed
  // subscription grant. The whole aggregate switches in one transaction.
  if ((result.outcome === "permanent_failure" || String(outbox.channel) === "wechat")
    && await fallbackAll()) {
    return;
  }
  if (result.outcome === "permanent_failure") {
    await deadLetter(database, batch, result, now, workerId);
    return;
  }
  if (result.outcome === "temporary_failure" && attempt <= WORKFLOW_RETRY_MINUTES.length) {
    const delay = WORKFLOW_RETRY_MINUTES[attempt - 1] * 60_000;
    const retried = await database.prepare(`
      UPDATE notification_outbox SET status = 'retry', available_at = ?, leased_until = NULL,
        lease_owner = NULL, updated_at = ?
      WHERE id = ANY(?::text[]) AND status = 'processing' AND lease_owner = ?
    `).run(new Date(now.getTime() + delay).toISOString(), now.toISOString(), batch.rows.map((row) => String(row.id)), workerId);
    if (retried.changes === batch.rows.length) return;
  }
  if (await fallbackAll()) return;
  await deadLetter(database, batch, result, now, workerId);
}

export type WorkflowWorkerRunResult = { scheduledTasks: number; deliveredOutbox: number; quarantinedOutbox: number };

export async function runWorkflowWorkerOnce(
  database: AppDatabase,
  options: { now?: Date; sender?: WorkflowDeliverySender; workerId?: string; taskLimit?: number; outboxLimit?: number } = {},
): Promise<WorkflowWorkerRunResult> {
  const currentTime = () => options.now ?? new Date();
  const sender = options.sender ?? defaultWorkflowDeliverySender;
  const workerId = options.workerId ?? `workflow-worker-${process.pid}-${randomUUID()}`;
  const scheduledTasks = await scheduleDueTaskNotifications(database, currentTime(), options.taskLimit ?? 100);
  const quarantinedOutbox = await quarantineExpiredProcessing(database, currentTime(), options.outboxLimit ?? 100);
  let deliveredOutbox = 0;
  const outboxLimit = options.outboxLimit ?? 100;
  while (deliveredOutbox < outboxLimit) {
    const claimedAt = currentTime();
    const batch = await claimOutbox(database, claimedAt, workerId);
    if (!batch) break;
    await deliverClaimedOutbox(database, batch, sender, currentTime(), workerId);
    deliveredOutbox += 1;
  }
  return { scheduledTasks, deliveredOutbox, quarantinedOutbox };
}

export async function runWorkflowWorkerLoop(
  database: AppDatabase,
  options: {
    sender?: WorkflowDeliverySender;
    workerId?: string;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const pollIntervalMs = Math.max(500, options.pollIntervalMs ?? 5_000);
  while (!options.signal?.aborted) {
    try {
      await runWorkflowWorkerOnce(database, { sender: options.sender, workerId: options.workerId });
    } catch (error) {
      options.onError?.(error);
    }
    if (options.signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
