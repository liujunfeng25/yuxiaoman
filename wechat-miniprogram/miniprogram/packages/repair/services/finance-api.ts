import { apiBaseUrl, assertApiConfigured } from "../../../config/env";
import { withRepairOperatorAuthorization } from "./operator-session";
type ProviderFinanceOverview = { enabled: boolean; cutoverAt: string | null; pendingAccrualFen: number; pendingAccrualCount: number; pendingPayoutFen: number; pendingStatementCount: number; paidPayoutFen: number };
type ProviderStatement = { id: string; statementNumber: string; statementDate: string; grossAmountFen: number; commissionAmountFen: number; itemNetAmountFen: number; payableAmountFen: number; closingBalanceFen: number; itemCount: number; status: string; paidAt: string | null };
type ProviderStatementDetail = ProviderStatement & { items: Array<{ id: string; orderNumber: string; componentType: string; entryKind: string; grossAmountFen: number; commissionAmountFen: number; netAmountFen: number; eligibleAt: string }> };

type Envelope<T> = { data?: T; error?: { message?: string } };
const requestError = (message: string, statusCode?: number) => Object.assign(new Error(message), { statusCode });
function get<T>(path: string): Promise<T> {
  assertApiConfigured();
  return withRepairOperatorAuthorization({}, (headers) => new Promise((resolve, reject) => {
    wx.request<Envelope<T>>({ url: `${apiBaseUrl}${path}`, method: "GET", header: headers, timeout: 10000,
      success: (result) => result.statusCode >= 200 && result.statusCode < 300 && result.data.data !== undefined ? resolve(result.data.data) : reject(requestError(result.data.error?.message || "账单读取失败", result.statusCode)),
      fail: (error) => reject(new Error(error.errMsg || "账单读取失败")),
    });
  }));
}

export const repairFinanceApi = {
  overview: () => get<ProviderFinanceOverview>("/repair-operator/finance/overview"),
  statements: () => get<{ items: ProviderStatement[] }>("/repair-operator/finance/statements?pageSize=100"),
  statement: (id: string) => get<ProviderStatementDetail>(`/repair-operator/finance/statements/${encodeURIComponent(id)}`),
  download(id: string): Promise<string> {
    assertApiConfigured();
    return withRepairOperatorAuthorization({}, (headers) => new Promise((resolve, reject) => {
      wx.downloadFile({ url: `${apiBaseUrl}/repair-operator/finance/statements/${encodeURIComponent(id)}/export`, header: headers,
        success: (result) => result.statusCode === 200 && result.tempFilePath ? resolve(result.tempFilePath) : reject(requestError("账单下载失败", result.statusCode)),
        fail: (error) => reject(new Error(error.errMsg || "账单下载失败")),
      });
    }));
  },
};
