import { apiBaseUrl, assertApiConfigured } from "../../../config/env";
import { withOperatorAuthorization } from "../../../services/operator-session";

export type ProviderFinanceOverview = { enabled: boolean; cutoverAt: string | null; pendingAccrualFen: number; pendingAccrualCount: number; pendingPayoutFen: number; pendingStatementCount: number; paidPayoutFen: number };
export type ProviderStatement = { id: string; statementNumber: string; statementDate: string; grossAmountFen: number; commissionAmountFen: number; itemNetAmountFen: number; payableAmountFen: number; closingBalanceFen: number; itemCount: number; status: string; paidAt: string | null };
export type ProviderStatementDetail = ProviderStatement & { items: Array<{ id: string; orderNumber: string; componentType: string; entryKind: string; grossAmountFen: number; commissionAmountFen: number; netAmountFen: number; eligibleAt: string }> };

type Envelope<T> = { data?: T; error?: { message?: string } };
const requestError = (message: string, statusCode?: number) => Object.assign(new Error(message), { statusCode });

function get<T>(path: string): Promise<T> {
  assertApiConfigured();
  return withOperatorAuthorization({}, (headers) => new Promise((resolve, reject) => {
    wx.request<Envelope<T>>({
      url: `${apiBaseUrl}${path}`, method: "GET", header: headers, timeout: 10000,
      success: (result) => result.statusCode >= 200 && result.statusCode < 300 && result.data.data !== undefined
        ? resolve(result.data.data) : reject(requestError(result.data.error?.message || "账单读取失败", result.statusCode)),
      fail: (error) => reject(new Error(error.errMsg || "账单读取失败")),
    });
  }));
}

export const operatorFinanceApi = {
  overview: () => get<ProviderFinanceOverview>("/operator/finance/overview"),
  statements: () => get<{ items: ProviderStatement[] }>("/operator/finance/statements?pageSize=100"),
  statement: (id: string) => get<ProviderStatementDetail>(`/operator/finance/statements/${encodeURIComponent(id)}`),
  download(id: string): Promise<string> {
    assertApiConfigured();
    return withOperatorAuthorization({}, (headers) => new Promise((resolve, reject) => {
      wx.downloadFile({
        url: `${apiBaseUrl}/operator/finance/statements/${encodeURIComponent(id)}/export`, header: headers,
        success: (result) => result.statusCode === 200 && result.tempFilePath ? resolve(result.tempFilePath) : reject(requestError("账单下载失败", result.statusCode)),
        fail: (error) => reject(new Error(error.errMsg || "账单下载失败")),
      });
    }));
  },
};
