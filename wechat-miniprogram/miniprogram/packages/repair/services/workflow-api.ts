import { workflowAuthorizedRequest } from "../../../services/workflow";
import type { WorkflowTaskPage, WorkflowTaskSummary } from "../../../types/workflow";
import { normalizeWorkflowTaskPage, normalizeWorkflowTaskSummary } from "../../../utils/workflow";
import { withRepairOperatorAuthorization } from "./operator-session";

function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function get<T>(path: string): Promise<T> {
  return workflowAuthorizedRequest(path, "GET", undefined, withRepairOperatorAuthorization, "维修门店待办暂时无法读取");
}

export const repairWorkflowApi = {
  async summary(): Promise<WorkflowTaskSummary> {
    return normalizeWorkflowTaskSummary(await get<unknown>("/repair-operator/workflow/tasks/summary"));
  },
  async tasks(params: { cursor?: string; limit?: number; urgency?: string } = {}): Promise<WorkflowTaskPage> {
    const query = queryString({ cursor: params.cursor, limit: params.limit || 20, urgency: params.urgency });
    return normalizeWorkflowTaskPage(await get<unknown>(`/repair-operator/workflow/tasks${query ? `?${query}` : ""}`));
  },
};
