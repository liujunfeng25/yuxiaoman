import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import { operatorFinanceApi, type ProviderStatement, type ProviderStatementDetail } from "../../services/finance-api";

type StatementView = ProviderStatement & { grossText: string; commissionText: string; netText: string; payableText: string; statusText: string };
type DetailView = Omit<ProviderStatementDetail, "items"> & { items: Array<ProviderStatementDetail["items"][number] & { componentText: string; grossText: string; commissionText: string; netText: string }>; grossText: string; commissionText: string; payableText: string };
type Data = { loading: boolean; error: string; enabled: boolean; pendingText: string; payableText: string; paidText: string; statements: StatementView[]; detail: DetailView | null; downloading: boolean };

const componentLabels: Record<string, string> = { inspection_fee: "年检费用", wash_fee: "洗车费用", repair_fee: "维修费用", valet_cost: "代驾费用" };
const statusLabels: Record<string, string> = { pending_payment: "待付款", paid: "已付款", carried_forward: "余额结转", void: "已作废" };
const amount = (fen: number) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;

function statementView(item: ProviderStatement): StatementView {
  return { ...item, grossText: amount(item.grossAmountFen), commissionText: amount(item.commissionAmountFen), netText: amount(item.itemNetAmountFen), payableText: amount(item.payableAmountFen), statusText: statusLabels[item.status] || item.status };
}
function detailView(item: ProviderStatementDetail): DetailView {
  return { ...item, grossText: amount(item.grossAmountFen), commissionText: amount(item.commissionAmountFen), payableText: amount(item.payableAmountFen), items: item.items.map((row) => ({ ...row, componentText: row.entryKind === "reversal" ? `${componentLabels[row.componentType] || row.componentType} · 退款冲正` : componentLabels[row.componentType] || row.componentType, grossText: amount(row.grossAmountFen), commissionText: amount(row.commissionAmountFen), netText: amount(row.netAmountFen) })) };
}

Page<Data>({
  data: { loading: true, error: "", enabled: false, pendingText: "¥0.00", payableText: "¥0.00", paidText: "¥0.00", statements: [], detail: null, downloading: false },
  onLoad() { if (ensureOperatorPageAccess("/packages/operator/pages/finance/finance")) void this.load(); },
  onPullDownRefresh() { void this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const [overview, result] = await Promise.all([operatorFinanceApi.overview(), operatorFinanceApi.statements()]);
      this.setData({ enabled: overview.enabled, pendingText: amount(overview.pendingAccrualFen), payableText: amount(overview.pendingPayoutFen), paidText: amount(overview.paidPayoutFen), statements: result.items.map(statementView) });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "账单读取失败" }); }
    finally { this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  async openDetail(event) {
    try { this.setData({ detail: detailView(await operatorFinanceApi.statement(String(event.currentTarget.dataset.id))) }); }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "明细读取失败", icon: "none" }); }
  },
  closeDetail() { this.setData({ detail: null }); },
  noop() {},
  async download(event) {
    if (this.data.downloading) return;
    this.setData({ downloading: true });
    try {
      const path = await operatorFinanceApi.download(String(event.currentTarget.dataset.id));
      wx.openDocument({ filePath: path, fileType: "xlsx", showMenu: true, fail: (error) => wx.showToast({ title: error.errMsg || "文件打开失败", icon: "none" }) });
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "账单下载失败", icon: "none" }); }
    finally { this.setData({ downloading: false }); }
  },
  retry() { void this.load(); },
});
