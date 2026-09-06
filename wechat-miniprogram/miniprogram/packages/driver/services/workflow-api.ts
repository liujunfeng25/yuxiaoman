import { workflowAuthorizedRequest, type WorkflowAuthRunner } from "../../../services/workflow";
import type { WorkflowTaskPage, WorkflowTaskSummary } from "../../../types/workflow";
import { normalizeWorkflowTaskPage, normalizeWorkflowTaskSummary } from "../../../utils/workflow";
import { driverAuthorizationHeaders } from "./driver-session";

function get<T>(path: string): Promise<T> {
  let sessionHeaders: Record<string, string>;
  try {
    sessionHeaders = driverAuthorizationHeaders();
  } catch (error) {
    return Promise.reject(error);
  }
  const authorize: WorkflowAuthRunner = async (headers, operation) => operation({ ...headers, ...sessionHeaders });
  return workflowAuthorizedRequest(path, "GET", undefined, authorize, "代驾任务时限暂时无法读取");
}

export const driverWorkflowApi = {
  async summary(bookingId: string): Promise<WorkflowTaskSummary> {
    return normalizeWorkflowTaskSummary(await get<unknown>(`/driver/tasks/${encodeURIComponent(bookingId)}/workflow/summary`));
  },
  async tasks(bookingId: string): Promise<WorkflowTaskPage> {
    return normalizeWorkflowTaskPage(await get<unknown>(`/driver/tasks/${encodeURIComponent(bookingId)}/workflow`));
  },
};
