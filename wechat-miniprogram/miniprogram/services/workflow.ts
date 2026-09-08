import { apiBaseUrl, assertApiConfigured } from "../config/env";
import type {
  WorkflowNotification,
  WorkflowNotificationPage,
  WorkflowNotificationSummary,
} from "../types/workflow";
import {
  normalizeWorkflowNotification,
  normalizeWorkflowNotificationPage,
  normalizeWorkflowNotificationSummary,
} from "../utils/workflow";
import { withOwnerAuthorization } from "./session";

type Envelope<T> = {
  data?: T;
  meta?: Record<string, unknown>;
  error?: { code?: string; message?: string; fields?: Record<string, string> };
};

type WorkflowApiError = Error & {
  code?: string;
  statusCode?: number;
  fields?: Record<string, string>;
};

export type WorkflowAuthRunner = <T>(
  headers: Record<string, string>,
  operation: (authorizedHeaders: Record<string, string>) => Promise<T>,
) => Promise<T>;

export type WechatSubscriptionResult = "accept" | "reject" | "ban" | "filter";

export type OwnerWechatSubscriptionRequestResult = {
  requestedTemplateIds: string[];
  acceptedCount: number;
};

function apiError(payload: unknown, statusCode: number, fallback: string): WorkflowApiError {
  const envelope = payload && typeof payload === "object" ? payload as Envelope<unknown> : undefined;
  const error = new Error(envelope?.error?.message || fallback) as WorkflowApiError;
  error.code = envelope?.error?.code;
  error.statusCode = statusCode;
  error.fields = envelope?.error?.fields;
  return error;
}

export function workflowAuthorizedRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  data: unknown,
  authorize: WorkflowAuthRunner,
  unavailableMessage: string,
): Promise<T> {
  assertApiConfigured();
  const hasBody = data !== undefined;
  return authorize(
    hasBody ? { "content-type": "application/json" } : {},
    (authorizedHeaders) => new Promise((resolve, reject) => {
      wx.request<Envelope<T> | T>({
        url: `${apiBaseUrl}${path}`,
        method,
        ...(hasBody ? { data } : {}),
        header: authorizedHeaders,
        timeout: 10000,
        success: (result) => {
          if (result.statusCode >= 200 && result.statusCode < 300) {
            const payload = result.data;
            if (payload && typeof payload === "object" && "data" in payload) {
              resolve((payload as Envelope<T>).data as T);
            } else {
              resolve(payload as T);
            }
            return;
          }
          reject(apiError(result.data, result.statusCode, unavailableMessage));
        },
        fail: (error) => reject(new Error(error.errMsg || unavailableMessage)),
      });
    }),
  );
}

function ownerRequest<T>(path: string, method: "GET" | "POST" = "GET", data?: unknown): Promise<T> {
  return workflowAuthorizedRequest(path, method, data, withOwnerAuthorization, "消息服务暂时不可用");
}

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export const ownerWorkflowApi = {
  async notifications(params: { cursor?: string; limit?: number; unreadOnly?: boolean } = {}): Promise<WorkflowNotificationPage> {
    const query = queryString({ cursor: params.cursor, limit: params.limit || 20, unreadOnly: params.unreadOnly });
    const [pagePayload, summaryPayload] = await Promise.all([
      ownerRequest<unknown>(`/workflow/notifications?${query}`),
      ownerRequest<unknown>("/workflow/notifications/summary"),
    ]);
    return {
      ...normalizeWorkflowNotificationPage(pagePayload),
      ...normalizeWorkflowNotificationSummary(summaryPayload),
    };
  },

  async summary(): Promise<WorkflowNotificationSummary> {
    return normalizeWorkflowNotificationSummary(await ownerRequest<unknown>("/workflow/notifications/summary"));
  },

  async markRead(id: string): Promise<WorkflowNotification | null> {
    const payload = await ownerRequest<unknown>(`/workflow/notifications/${encodeURIComponent(id)}/read`, "POST", {});
    if (!payload || typeof payload !== "object") return null;
    const source = payload as { notification?: unknown };
    const notification = normalizeWorkflowNotification(source.notification || payload);
    return notification.id ? notification : null;
  },

  async markAllRead(): Promise<WorkflowNotificationSummary> {
    await ownerRequest<unknown>("/workflow/notifications/read-all", "POST", {});
    return this.summary();
  },

  async wechatSubscriptionTemplateIds(purpose: "message_center" | "post_payment" = "message_center"): Promise<string[]> {
    const query = purpose === "message_center" ? "" : `?purpose=${encodeURIComponent(purpose)}`;
    const payload = await ownerRequest<unknown>(`/workflow/wechat-subscription-templates${query}`);
    if (!payload || typeof payload !== "object") return [];
    const templateIds = (payload as { templateIds?: unknown }).templateIds;
    if (!Array.isArray(templateIds)) return [];
    return [...new Set(templateIds
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean))];
  },

  async recordWechatSubscriptionResults(
    results: Record<string, WechatSubscriptionResult>,
    _source: string,
  ): Promise<void> {
    const stateMap = {
      accept: "accepted",
      reject: "rejected",
      ban: "banned",
      filter: "unknown",
    } as const;
    await Promise.all(Object.entries(results).map(([templateId, result]) => ownerRequest<void>(
      "/workflow/wechat-subscriptions",
      "POST",
      { templateId, state: stateMap[result] },
    )));
  },
};

export function requestOwnerWorkflowSubscriptions(
  templateIds: string[],
  source = "message_center",
): Promise<OwnerWechatSubscriptionRequestResult> {
  const requestedTemplateIds = [...new Set(templateIds.map((item) => item.trim()).filter(Boolean))].slice(0, 3);
  if (requestedTemplateIds.length === 0) return Promise.resolve({ requestedTemplateIds: [], acceptedCount: 0 });
  return new Promise((resolve, reject) => {
    // This must remain the first async platform call after the bindtap handler so
    // WeChat recognizes it as a subscription request initiated by the user.
    wx.requestSubscribeMessage({
      tmplIds: requestedTemplateIds,
      success: (platformResult) => {
        const results: Record<string, WechatSubscriptionResult> = {};
        for (const templateId of requestedTemplateIds) {
          const value = platformResult[templateId];
          results[templateId] = value === "accept" || value === "reject" || value === "ban" || value === "filter"
            ? value
            : "filter";
        }
        ownerWorkflowApi.recordWechatSubscriptionResults(results, source)
          .then(() => resolve({
            requestedTemplateIds,
            acceptedCount: Object.values(results).filter((value) => value === "accept").length,
          }))
          .catch(reject);
      },
      fail: (error) => {
        const raw = error.errMsg || "微信提醒授权未完成";
        if (/No template data return|template id exist|20001/i.test(raw)) {
          reject(new Error("微信提醒模板配置异常，请稍后再试或联系客服"));
          return;
        }
        if (/main switch|20004/i.test(raw)) {
          reject(new Error("请先在微信设置中打开接收订阅消息"));
          return;
        }
        reject(new Error(raw));
      },
    });
  });
}

type TabBadgeRuntime = {
  setTabBarBadge(options: { index: number; text: string; fail?(): void }): void;
  removeTabBarBadge(options: { index: number; fail?(): void }): void;
};

export function applyOwnerWorkflowUnreadBadge(unreadCount: number): void {
  const runtime = wx as unknown as TabBadgeRuntime;
  const count = Math.max(0, Math.floor(Number(unreadCount) || 0));
  if (count > 0) {
    runtime.setTabBarBadge({ index: 1, text: count > 99 ? "99+" : String(count), fail: () => undefined });
  } else {
    runtime.removeTabBarBadge({ index: 1, fail: () => undefined });
  }
}

export async function refreshOwnerWorkflowUnreadBadge(): Promise<WorkflowNotificationSummary | null> {
  try {
    const summary = await ownerWorkflowApi.summary();
    applyOwnerWorkflowUnreadBadge(summary.unreadCount);
    return summary;
  } catch {
    // A badge refresh is supplementary and must never block the owner flow.
    return null;
  }
}
