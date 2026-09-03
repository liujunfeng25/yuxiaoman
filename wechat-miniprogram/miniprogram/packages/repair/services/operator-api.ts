import { apiBaseUrl, assertApiConfigured } from "../../../config/env";
import type {
  RepairShopApi,
  RepairShopRawRequest,
  RepairShopRequestApiResult,
  RepairShopQuoteInput,
} from "../utils/shop-model";
import { withRepairOperatorAuthorization } from "./operator-session";

type Envelope<T> = { data?: T; error?: { code?: string; message?: string; fields?: Record<string, string> } };
type RepairOperatorApiError = Error & { code?: string; statusCode?: number; fields?: Record<string, string> };

function apiError(payload: Envelope<unknown> | undefined, statusCode: number, fallback: string): RepairOperatorApiError {
  const error = new Error(payload?.error?.message || fallback) as RepairOperatorApiError;
  error.code = payload?.error?.code;
  error.statusCode = statusCode;
  error.fields = payload?.error?.fields;
  return error;
}

function operatorRequest<T>(
  path: string,
  method: "GET" | "PUT" | "DELETE" = "GET",
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  assertApiConfigured();
  return withRepairOperatorAuthorization(
    { "content-type": "application/json", ...headers },
    (authorizedHeaders) => new Promise((resolve, reject) => {
      wx.request<Envelope<T>>({
        url: `${apiBaseUrl}${path}`,
        method,
        data,
        header: authorizedHeaders,
        timeout: 10000,
        success: (result) => {
          if (result.statusCode >= 200 && result.statusCode < 300 && result.data?.data !== undefined) {
            resolve(result.data.data);
            return;
          }
          reject(apiError(
            result.data,
            result.statusCode,
            result.statusCode === 401 ? "维修门店会话已失效，请重新登录" : "维修门店服务暂时不可用",
          ));
        },
        fail: (error) => reject(new Error(error.errMsg || "无法连接维修门店服务")),
      });
    }),
  );
}

export const repairOperatorApi: RepairShopApi = {
  repairShopHall: async () => ({ items: await operatorRequest<RepairShopRawRequest[]>("/repair-operator/requests") }),
  repairShopRequest: (requestId: string) => operatorRequest<RepairShopRequestApiResult>(
    `/repair-operator/requests/${encodeURIComponent(requestId)}`,
  ),
  submitRepairShopQuote: (requestId: string, input: RepairShopQuoteInput) => operatorRequest<RepairShopRequestApiResult>(
    `/repair-operator/requests/${encodeURIComponent(requestId)}/quote`,
    "PUT",
    { totalPriceFen: input.totalFen, note: input.note },
    { "Idempotency-Key": input.idempotencyKey },
  ),
  withdrawRepairShopQuote: (requestId: string) => operatorRequest<RepairShopRequestApiResult>(
    `/repair-operator/requests/${encodeURIComponent(requestId)}/quote`,
    "DELETE",
  ),
  repairShopDeal: (requestId: string) => operatorRequest<RepairShopRequestApiResult>(
    `/repair-operator/requests/${encodeURIComponent(requestId)}`,
  ),
};
