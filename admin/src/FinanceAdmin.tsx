import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Bank,
  CheckCircle,
  DownloadSimple,
  FileXls,
  Funnel,
  Gear,
  Money,
  Printer,
  Receipt,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { api, money, upload } from "./adminApi";

type Overview = {
  enabled: boolean;
  cutoverAt: string | null;
  pendingAccrualFen: number;
  pendingAccrualCount: number;
  pendingPayoutFen: number;
  pendingStatementCount: number;
  todayCollectedFen: number | null;
  todayRefundedFen: number | null;
  paidPayoutFen: number;
  platformCommissionFen: number | null;
  valetMarginFen: number | null;
};

type Transaction = {
  id: string;
  businessType: string;
  orderNumber: string;
  kind: string;
  provider: string;
  listedAmountFen: number;
  channelAmountFen: number;
  transactionId: string | null;
  status: string;
  isReal: boolean;
  occurredAt: string;
  fulfillmentStatus: string | null;
  settlementStatus: string;
};

type Statement = {
  id: string;
  statementNumber: string;
  statementDate: string;
  counterpartyType: string;
  counterpartyName: string;
  grossAmountFen: number;
  commissionAmountFen: number;
  itemNetAmountFen: number;
  payableAmountFen: number;
  closingBalanceFen: number;
  itemCount: number;
  status: string;
  paidAt: string | null;
};

type StatementDetail = Statement & {
  openingBalanceFen: number;
  items: Array<{
    id: string;
    orderNumber: string;
    componentType: string;
    entryKind: string;
    grossAmountFen: number;
    commissionAmountFen: number;
    netAmountFen: number;
    eligibleAt: string;
  }>;
  payout: null | {
    amountFen: number;
    paymentMethod: string;
    bankReference?: string;
    note?: string | null;
    paidAt: string;
    postedByName?: string;
    hasEvidence?: boolean;
  };
};

type Rule = {
  id: string;
  businessType: string;
  calculationMode: string;
  rateBps: number | null;
  fixedFen: number | null;
  baseFeeFen: number | null;
  includedKm: number | null;
  perKmFen: number | null;
  effectiveFrom: string;
  version: number;
  status: string;
};

type FinanceSettings = {
  enabled: boolean;
  cutoverAt: string | null;
  valetCompany: null | { id: string; code: string; name: string; contactName: string | null; contactPhone: string | null };
};

type CounterpartyOption = {
  type: string;
  id: string;
  name: string;
};

type TransactionDetail = {
  payment: Transaction;
  order: null | {
    id: string;
    status: string;
    fulfillmentStatus: string;
    paymentStatus: string;
    inspectionFeeFen: number;
    valetFeeFen: number;
    washFeeFen: number;
    repairFeeFen: number;
    totalFen: number;
  };
  accruals: Array<{
    id: string;
    componentType: string;
    entryKind: string;
    counterpartyName: string;
    grossAmountFen: number;
    commissionAmountFen: number;
    netAmountFen: number;
    statementNumber: string | null;
    ruleSnapshot: Record<string, unknown>;
  }>;
  timeline: Array<{
    status: string;
    title: string;
    description: string;
    createdAt: string;
  }>;
  valetExecution: null | {
    driverName: string;
    driverPhone: string | null;
    dispatcherName: string | null;
    status: string;
  };
};

const businessLabels: Record<string, string> = {
  annual_inspection: "年检",
  car_wash: "洗车",
  repair: "维修",
  valet: "代驾",
};
const counterpartyTypeLabels: Record<string, string> = {
  inspection_station: "检测站",
  wash_store: "洗车门店",
  repair_shop: "维修门店",
  valet_company: "代驾公司",
};
const componentLabels: Record<string, string> = {
  inspection_fee: "年检费用",
  wash_fee: "洗车费用",
  repair_fee: "维修费用",
  valet_cost: "代驾费用",
};
const statusLabels: Record<string, string> = {
  pending_payment: "待付款",
  paid: "已付款",
  carried_forward: "余额结转",
  void: "已作废",
  statemented: "已出账",
  pending: "待出账",
  partial: "部分出账",
  not_eligible: "未达条件",
};

const paymentStatusLabels: Record<string, string> = {
  confirmed: "已确认",
  pending: "待确认",
  failed: "失败",
  anomaly: "金额异常",
};

function dateTime(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : "—";
}

function financeDate(value: string | null | undefined) {
  if (!value) return "—";
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/u);
  if (match) return match[0];
  return new Date(value).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

async function downloadStatement(base: string, statement: Statement) {
  const response = await fetch(
    `/api${base}/statements/${encodeURIComponent(statement.id)}/export`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error("账单导出失败，请稍后重试");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${statement.statementNumber}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderStatementPrintBlock(detail: StatementDetail) {
  const typeLabel =
    counterpartyTypeLabels[detail.counterpartyType] ?? detail.counterpartyType;
  const rows = detail.items
    .map(
      (item) => `<tr>
      <td>${escapeHtml(item.orderNumber)}<br/><small>${escapeHtml(
        item.entryKind === "reversal"
          ? "退款冲正"
          : (componentLabels[item.componentType] ?? item.componentType),
      )}</small></td>
      <td>¥${money(item.grossAmountFen)}</td>
      <td>¥${money(item.commissionAmountFen)}</td>
      <td>¥${money(item.netAmountFen)}</td>
    </tr>`,
    )
    .join("");
  return `<section class="statement-block">
  <h2>日结算单 ${escapeHtml(detail.statementNumber)}</h2>
  <div class="meta">
    ${escapeHtml(detail.counterpartyName)}（${escapeHtml(typeLabel)}） ·
    账单日期 ${escapeHtml(financeDate(detail.statementDate))} ·
    状态 ${escapeHtml(statusLabels[detail.status] ?? detail.status)}
  </div>
  <div class="summary">
    <div><small>服务金额</small><strong>¥${money(detail.grossAmountFen)}</strong></div>
    <div><small>平台佣金</small><strong>¥${money(detail.commissionAmountFen)}</strong></div>
    <div><small>本期应付</small><strong>¥${money(detail.payableAmountFen)}</strong></div>
  </div>
  <table>
    <thead><tr><th>订单 / 费用</th><th>服务金额</th><th>佣金</th><th>净额</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4">暂无明细</td></tr>`}</tbody>
  </table>
</section>`;
}

function printStatementBatch(details: StatementDetail[]) {
  if (!details.length) throw new Error("当前没有可打印的日账单");
  const summaryRows = details
    .map(
      (detail) => `<tr>
      <td>${escapeHtml(financeDate(detail.statementDate))}<br/><small>${escapeHtml(detail.statementNumber)}</small></td>
      <td>${escapeHtml(detail.counterpartyName)}<br/><small>${escapeHtml(
        counterpartyTypeLabels[detail.counterpartyType] ?? detail.counterpartyType,
      )}</small></td>
      <td>¥${money(detail.grossAmountFen)}</td>
      <td>¥${money(detail.commissionAmountFen)}</td>
      <td>¥${money(detail.payableAmountFen)}</td>
      <td>${escapeHtml(statusLabels[detail.status] ?? detail.status)}</td>
    </tr>`,
    )
    .join("");
  const totalPayable = details.reduce((sum, item) => sum + item.payableAmountFen, 0);
  const blocks = details.map(renderStatementPrintBlock).join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>日账单批量打印（${details.length} 条）</title>
  <style>
    body { font-family: "PingFang SC", "Noto Sans SC", sans-serif; color: #18344d; margin: 28px; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    h2 { margin: 0 0 6px; font-size: 18px; }
    .meta { color: #5f7386; font-size: 13px; margin-bottom: 14px; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; }
    .summary div { border: 1px solid #d7e2ec; border-radius: 8px; padding: 10px 12px; }
    .summary small { display: block; color: #718697; font-size: 12px; margin-bottom: 4px; }
    .summary strong { font-size: 18px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th, td { border-bottom: 1px solid #e4ebf1; padding: 10px 8px; text-align: left; font-size: 13px; vertical-align: top; }
    th { color: #607687; font-size: 12px; }
    small { color: #7a8d9d; }
    .cover { margin-bottom: 28px; }
    .statement-block { page-break-before: always; padding-top: 4px; }
    .footer { margin-top: 18px; color: #7a8d9d; font-size: 12px; }
    @media print {
      body { margin: 10mm; }
      .statement-block { page-break-before: always; }
    }
  </style>
</head>
<body>
  <section class="cover">
    <h1>日账单汇总（当前列表 ${details.length} 条）</h1>
    <div class="meta">应付合计 ¥${money(totalPayable)} · 打印时间 ${escapeHtml(dateTime(new Date().toISOString()))}</div>
    <table>
      <thead>
        <tr>
          <th>账单日期 / 编号</th>
          <th>合作方</th>
          <th>服务金额</th>
          <th>平台佣金</th>
          <th>付款金额</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>${summaryRows}</tbody>
    </table>
  </section>
  ${blocks}
  <script>window.onload = () => { window.print(); };</script>
</body>
</html>`;
  const popup = window.open("", "_blank", "noopener,noreferrer,width=960,height=720");
  if (!popup) throw new Error("浏览器拦截了打印窗口，请允许弹窗后重试");
  popup.document.open();
  popup.document.write(html);
  popup.document.close();
}

export function FinanceAdminPage({
  mode = "platform",
  onError,
}: {
  mode?: "platform" | "wash";
  onError: (error: unknown) => void;
}) {
  const base = mode === "platform" ? "/admin/finance" : "/admin/wash/finance";
  const [section, setSection] = useState<
    "transactions" | "statements" | "rules"
  >(mode === "platform" ? "transactions" : "statements");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [counterparties, setCounterparties] = useState<CounterpartyOption[]>(
    [],
  );
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStatement, setSelectedStatement] =
    useState<StatementDetail | null>(null);
  const [selectedTransaction, setSelectedTransaction] =
    useState<TransactionDetail | null>(null);
  const [filters, setFilters] = useState({
    businessType: "",
    status: "",
    fulfillmentStatus: "",
    settlementStatus: "",
    orderNumber: "",
    transactionId: "",
    counterpartyName: "",
    plate: "",
    dateFrom: "",
    dateTo: "",
  });
  const [statementFilters, setStatementFilters] = useState({
    counterpartyKey: "",
    counterpartyName: "",
    status: "",
    dateFrom: "",
    dateTo: "",
  });
  const [closeDate, setCloseDate] = useState(() =>
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  );
  const [printing, setPrinting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const statementQuery = new URLSearchParams({ pageSize: "100" });
      if (statementFilters.status)
        statementQuery.set("status", statementFilters.status);
      if (statementFilters.dateFrom)
        statementQuery.set("dateFrom", statementFilters.dateFrom);
      if (statementFilters.dateTo)
        statementQuery.set("dateTo", statementFilters.dateTo);
      if (statementFilters.counterpartyName.trim()) {
        statementQuery.set(
          "counterpartyName",
          statementFilters.counterpartyName.trim(),
        );
      }
      if (statementFilters.counterpartyKey) {
        const [type, id] = statementFilters.counterpartyKey.split("::");
        if (type && id) {
          statementQuery.set("counterpartyType", type);
          statementQuery.set("counterpartyId", id);
        }
      }

      const [overviewValue, statementValue] = await Promise.all([
        api<Overview>(`${base}/overview`),
        api<{ items: Statement[] }>(
          `${base}/statements?${statementQuery.toString()}`,
        ),
      ]);
      setOverview(overviewValue);
      setStatements(statementValue.items);
      if (mode === "platform") {
        const query = new URLSearchParams(
          Object.entries(filters)
            .filter(([, value]) => value)
            .map(([key, value]) => [key, value]),
        );
        const [transactionValue, ruleValue, counterpartyValue] =
          await Promise.all([
            api<{ items: Transaction[] }>(
              `${base}/transactions?${query.toString()}`,
            ),
            api<Rule[]>(`${base}/rules`),
            api<CounterpartyOption[]>(`${base}/counterparties`),
          ]);
        setTransactions(transactionValue.items);
        setRules(ruleValue);
        setCounterparties(counterpartyValue);
      }
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [base, filters, mode, onError, statementFilters]);

  useEffect(() => {
    void load();
  }, [load]);

  const cards = useMemo(
    () =>
      mode === "platform"
        ? ([
            ["今日实收", overview?.todayCollectedFen ?? 0, Money],
            ["今日退款", overview?.todayRefundedFen ?? 0, Receipt],
            ["待结算", overview?.pendingAccrualFen ?? 0, Wallet],
            ["待付款", overview?.pendingPayoutFen ?? 0, Bank],
            ["累计已付款", overview?.paidPayoutFen ?? 0, CheckCircle],
            ["平台佣金", overview?.platformCommissionFen ?? 0, Money],
            ["代驾毛利", overview?.valetMarginFen ?? 0, Wallet],
          ] as const)
        : ([
            ["待进入账单", overview?.pendingAccrualFen ?? 0, Wallet],
            ["待付款", overview?.pendingPayoutFen ?? 0, Bank],
            ["累计已付款", overview?.paidPayoutFen ?? 0, CheckCircle],
          ] as const),
    [mode, overview],
  );

  async function openStatement(statement: Statement) {
    try {
      setSelectedStatement(
        await api<StatementDetail>(
          `${base}/statements/${encodeURIComponent(statement.id)}`,
        ),
      );
    } catch (error) {
      onError(error);
    }
  }

  async function printCurrentStatements() {
    if (!statements.length) {
      onError(new Error("当前没有可打印的日账单，请先筛选或生成账单"));
      return;
    }
    setPrinting(true);
    try {
      const details = await Promise.all(
        statements.map((item) =>
          api<StatementDetail>(
            `${base}/statements/${encodeURIComponent(item.id)}`,
          ),
        ),
      );
      printStatementBatch(details);
    } catch (error) {
      onError(error);
    } finally {
      setPrinting(false);
    }
  }

  async function openTransaction(item: Transaction) {
    try {
      setSelectedTransaction(
        await api<TransactionDetail>(
          `${base}/transactions/${encodeURIComponent(item.id)}`,
        ),
      );
    } catch (error) {
      onError(error);
    }
  }

  async function postPayout(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedStatement) return;
    const data = new FormData(event.currentTarget);
    try {
      let detail = await api<StatementDetail>(
        `${base}/statements/${selectedStatement.id}/payout`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: `finance-payout-${selectedStatement.id}`,
            paymentMethod: data.get("paymentMethod"),
            bankReference: data.get("bankReference"),
            paidAt: new Date(String(data.get("paidAt"))).toISOString(),
            note: data.get("note") || null,
          }),
        },
      );
      const evidence = data.get("evidence");
      if (evidence instanceof File && evidence.size > 0) {
        const form = new FormData();
        form.append("file", evidence);
        await upload(
          `${base}/statements/${selectedStatement.id}/payout/evidence`,
          form,
        );
        detail = await api<StatementDetail>(
          `${base}/statements/${selectedStatement.id}`,
        );
      }
      setSelectedStatement(detail);
      await load();
    } catch (error) {
      onError(error);
    }
  }

  async function runClose() {
    try {
      await api(`${base}/daily-close`, {
        method: "POST",
        body: JSON.stringify({ statementDate: closeDate }),
      });
      await load();
    } catch (error) {
      onError(error);
    }
  }

  async function runSync() {
    try {
      await api("/admin/finance/sync", { method: "POST", body: "{}" });
      await load();
    } catch (error) {
      onError(error);
    }
  }

  async function refundRepair() {
    if (
      !selectedTransaction?.order ||
      !window.confirm(
        "确认对该维修订单发起全额原路退款？退款成功后会按原结算快照抵消或冲正。",
      )
    )
      return;
    try {
      await api(
        `/admin/finance/repair-orders/${selectedTransaction.order.id}/refund`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: `repair-refund-${selectedTransaction.order.id}`,
            reason: "平台财务全额退款",
          }),
        },
      );
      setSelectedTransaction(null);
      await load();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="finance-page">
      <section className="finance-intro">
        <div>
          <small>UNIFIED FINANCE</small>
          <h2>
            {mode === "platform"
              ? "订单、收款与合作方结算同账核对"
              : "本店账单明细"}
          </h2>
          <p>
            {overview?.enabled
              ? `统一财务已启用 · 仅统计 ${dateTime(overview.cutoverAt)} 后新订单`
              : "统一财务尚未启用，规则发布并完成切换后开始统计新订单"}
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading}>
          <ArrowClockwise className={loading ? "spin" : ""} />
          刷新
        </button>
      </section>

      <section className="finance-metrics">
        {cards.map(([label, value, Icon]) => (
          <article key={label}>
            <span>
              <Icon />
            </span>
            <small>{label}</small>
            <strong>¥{money(value)}</strong>
          </article>
        ))}
      </section>

      <div className="finance-tabs">
        {mode === "platform" ? (
          <button
            className={section === "transactions" ? "active" : ""}
            onClick={() => setSection("transactions")}
          >
            <Receipt />
            订单流水
          </button>
        ) : null}
        <button
          className={section === "statements" ? "active" : ""}
          onClick={() => setSection("statements")}
        >
          <FileXls />
          日账单
        </button>
        {mode === "platform" ? (
          <button
            className={section === "rules" ? "active" : ""}
            onClick={() => setSection("rules")}
          >
            <Gear />
            结算规则
          </button>
        ) : null}
      </div>

      {section === "transactions" ? (
        <section className="finance-card">
          <div className="finance-filter">
            <Funnel />
            <select
              value={filters.businessType}
              onChange={(event) =>
                setFilters({ ...filters, businessType: event.target.value })
              }
            >
              <option value="">全部业务</option>
              <option value="annual_inspection">年检</option>
              <option value="car_wash">洗车</option>
              <option value="repair">维修</option>
            </select>
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters({ ...filters, status: event.target.value })
              }
            >
              <option value="">全部支付状态</option>
              <option value="confirmed">已确认</option>
              <option value="pending">待确认</option>
              <option value="abnormal">异常 / 失败</option>
            </select>
            <select
              aria-label="履约状态"
              value={filters.fulfillmentStatus}
              onChange={(event) =>
                setFilters({ ...filters, fulfillmentStatus: event.target.value })
              }
            >
              <option value="">全部履约状态</option>
              <option value="pending_payment">待支付</option>
              <option value="pending_precheck">待预检</option>
              <option value="awaiting_arrival">待到店</option>
              <option value="awaiting_assignment">待安排代驾</option>
              <option value="driver_arranged">已派单</option>
              <option value="picked_up">已取车</option>
              <option value="checked_in">已到站</option>
              <option value="inspecting">服务中</option>
              <option value="store_service_completed">门店服务完成</option>
              <option value="returning">返程中</option>
              <option value="completed">已完成</option>
              <option value="paid">已支付</option>
              <option value="refunded">已退款</option>
              <option value="cancelled">已取消</option>
            </select>
            <select
              value={filters.settlementStatus}
              onChange={(event) =>
                setFilters({ ...filters, settlementStatus: event.target.value })
              }
            >
              <option value="">全部结算状态</option>
              <option value="pending">待出账</option>
              <option value="partial">部分出账</option>
              <option value="statemented">已出账</option>
            </select>
            <input
              placeholder="订单号"
              value={filters.orderNumber}
              onChange={(event) =>
                setFilters({ ...filters, orderNumber: event.target.value })
              }
            />
            <input
              placeholder="微信交易号"
              value={filters.transactionId}
              onChange={(event) =>
                setFilters({ ...filters, transactionId: event.target.value })
              }
            />
            <input
              placeholder="合作方"
              value={filters.counterpartyName}
              onChange={(event) => setFilters({ ...filters, counterpartyName: event.target.value })}
            />
            <input
              placeholder="车牌"
              value={filters.plate}
              onChange={(event) => setFilters({ ...filters, plate: event.target.value })}
            />
            <input
              aria-label="开始日期"
              title="开始日期"
              type="date"
              value={filters.dateFrom}
              onChange={(event) => setFilters({ ...filters, dateFrom: event.target.value })}
            />
            <input
              aria-label="结束日期"
              title="结束日期"
              type="date"
              value={filters.dateTo}
              onChange={(event) => setFilters({ ...filters, dateTo: event.target.value })}
            />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>订单 / 时间</th>
                  <th>业务</th>
                  <th>收款拆分</th>
                  <th>支付</th>
                  <th>履约</th>
                  <th>结算</th>
                  <th>真实性</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((item) => (
                  <tr key={item.id} onClick={() => void openTransaction(item)}>
                    <td>
                      <strong>{item.orderNumber}</strong>
                      <small>{dateTime(item.occurredAt)}</small>
                    </td>
                    <td>
                      {businessLabels[item.businessType] ?? item.businessType}
                    </td>
                    <td>
                      <strong>标价 ¥{money(item.listedAmountFen)}</strong>
                      <small>渠道实付 ¥{money(item.channelAmountFen)}</small>
                    </td>
                    <td>
                      {item.kind === "refund" ? "退款" : "收款"} · {paymentStatusLabels[item.status] ?? item.status}
                    </td>
                    <td>{item.fulfillmentStatus ?? "—"}</td>
                    <td>
                      <span
                        className={`finance-status ${item.settlementStatus}`}
                      >
                        {statusLabels[item.settlementStatus] ??
                          item.settlementStatus}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`finance-real ${item.isReal ? "real" : "demo"}`}
                      >
                        {item.isReal ? "真实微信" : "异常 / 演示"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!transactions.length && !loading ? (
              <div className="empty-table">暂无符合条件的流水</div>
            ) : null}
          </div>
        </section>
      ) : null}

      {section === "statements" ? (
        <section className="finance-card">
          <div className="finance-card-title">
            <div>
              <small>DAILY STATEMENTS</small>
              <h3>按自然日汇总应付给合作方的结算单</h3>
            </div>
            {mode === "platform" ? (
              <div className="finance-close">
                <div className="finance-close-actions">
                  <label className="finance-close-date">
                    <span>结算日期</span>
                    <input
                      type="date"
                      value={closeDate}
                      onChange={(event) => setCloseDate(event.target.value)}
                      aria-label="生成结算单的日期"
                    />
                  </label>
                  <button type="button" title="从订单系统拉取最新支付与待结算费用；可重复点击，不会重复记账" onClick={() => void runSync()}>
                    刷新账单数据
                  </button>
                  <button type="button" title="把选定日期该付给各服务商的费用汇总成结算单；已生成过的不会重复开单" onClick={() => void runClose()}>
                    生成结算单
                  </button>
                </div>
                <p className="finance-close-hint">
                  平时不用点：系统每天凌晨 2 点自动生成前一天的结算单。发现数据滞后先点「刷新账单数据」；仍缺结算单再选日期点「生成结算单」。重复点击不会产生重复账单。
                </p>
              </div>
            ) : (
              <span>系统每天凌晨 2 点自动生成结算单 · 封账后退款计入后续结算抵扣</span>
            )}
          </div>
          {mode === "platform" ? (
            <div className="finance-filter">
              <Funnel />
              <select
                value={statementFilters.counterpartyKey}
                onChange={(event) =>
                  setStatementFilters({
                    ...statementFilters,
                    counterpartyKey: event.target.value,
                  })
                }
                aria-label="按主体筛选"
              >
                <option value="">全部主体</option>
                {counterparties.map((item) => (
                  <option
                    key={`${item.type}::${item.id}`}
                    value={`${item.type}::${item.id}`}
                  >
                    {item.name}
                    {counterpartyTypeLabels[item.type]
                      ? ` · ${counterpartyTypeLabels[item.type]}`
                      : ""}
                  </option>
                ))}
              </select>
              <input
                value={statementFilters.counterpartyName}
                onChange={(event) =>
                  setStatementFilters({
                    ...statementFilters,
                    counterpartyName: event.target.value,
                  })
                }
                placeholder="主体名称关键词"
                aria-label="主体名称关键词"
              />
              <select
                value={statementFilters.status}
                onChange={(event) =>
                  setStatementFilters({
                    ...statementFilters,
                    status: event.target.value,
                  })
                }
                aria-label="账单状态"
              >
                <option value="">全部状态</option>
                <option value="pending_payment">待付款</option>
                <option value="paid">已付款</option>
                <option value="carried_forward">余额结转</option>
                <option value="void">已作废</option>
              </select>
              <input
                type="date"
                value={statementFilters.dateFrom}
                onChange={(event) =>
                  setStatementFilters({
                    ...statementFilters,
                    dateFrom: event.target.value,
                  })
                }
                aria-label="账单起始日期"
              />
              <input
                type="date"
                value={statementFilters.dateTo}
                onChange={(event) =>
                  setStatementFilters({
                    ...statementFilters,
                    dateTo: event.target.value,
                  })
                }
                aria-label="账单截止日期"
              />
              <button
                type="button"
                className="finance-filter-reset"
                onClick={() =>
                  setStatementFilters({
                    counterpartyKey: "",
                    counterpartyName: "",
                    status: "",
                    dateFrom: "",
                    dateTo: "",
                  })
                }
              >
                清除筛选
              </button>
              <button
                type="button"
                className="finance-print-all"
                disabled={printing || !statements.length}
                title="打印当前筛选结果中的全部日账单"
                onClick={() => void printCurrentStatements()}
              >
                <Printer />
                {printing
                  ? "准备打印…"
                  : `一键打印（${statements.length}）`}
              </button>
            </div>
          ) : (
            <div className="finance-filter">
              <button
                type="button"
                className="finance-print-all"
                disabled={printing || !statements.length}
                title="打印当前页全部日账单"
                onClick={() => void printCurrentStatements()}
              >
                <Printer />
                {printing
                  ? "准备打印…"
                  : `一键打印（${statements.length}）`}
              </button>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账单日期 / 编号</th>
                  {mode === "platform" ? <th>合作方</th> : null}
                  <th>服务金额</th>
                  <th>平台佣金</th>
                  <th>净应收 / 应付</th>
                  <th>付款金额</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {statements.map((item) => (
                  <tr key={item.id} onClick={() => void openStatement(item)}>
                    <td>
                      <strong>{financeDate(item.statementDate)}</strong>
                      <small>{item.statementNumber}</small>
                    </td>
                    {mode === "platform" ? (
                      <td>
                        <strong>{item.counterpartyName}</strong>
                        <small>
                          {counterpartyTypeLabels[item.counterpartyType] ??
                            item.counterpartyType}
                        </small>
                      </td>
                    ) : null}
                    <td>¥{money(item.grossAmountFen)}</td>
                    <td>¥{money(item.commissionAmountFen)}</td>
                    <td className={item.itemNetAmountFen < 0 ? "negative" : ""}>
                      ¥{money(item.itemNetAmountFen)}
                    </td>
                    <td>¥{money(item.payableAmountFen)}</td>
                    <td>
                      <span className={`finance-status ${item.status}`}>
                        {statusLabels[item.status] ?? item.status}
                      </span>
                    </td>
                    <td>
                      <button
                        className="table-action"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void downloadStatement(base, item).catch(onError);
                        }}
                      >
                        <DownloadSimple />
                        XLSX
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!statements.length && !loading ? (
              <div className="empty-table">当前没有符合条件的日账单</div>
            ) : null}
          </div>
          <div className="history-note">
            原洗车“单笔对账记录”继续保留在历史模块，不计入统一财务汇总。
          </div>
        </section>
      ) : null}

      {section === "rules" ? (
        <RulesPanel rules={rules} reload={load} onError={onError} />
      ) : null}

      {selectedStatement ? (
        <div
          className="finance-drawer-layer"
          onMouseDown={() => setSelectedStatement(null)}
        >
          <aside
            className="finance-drawer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>日账单明细</small>
                <h2>{selectedStatement.statementNumber}</h2>
                <p>
                  {selectedStatement.counterpartyName} ·{" "}
                  {financeDate(selectedStatement.statementDate)}
                </p>
              </div>
              <div className="finance-drawer-header-actions">
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setSelectedStatement(null)}
                >
                  <X />
                </button>
              </div>
            </header>
            <div className="finance-drawer-body">
              <div className="statement-summary">
                <div>
                  <small>服务金额</small>
                  <strong>¥{money(selectedStatement.grossAmountFen)}</strong>
                </div>
                <div>
                  <small>平台佣金</small>
                  <strong>
                    ¥{money(selectedStatement.commissionAmountFen)}
                  </strong>
                </div>
                <div>
                  <small>本期应付</small>
                  <strong>¥{money(selectedStatement.payableAmountFen)}</strong>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>订单 / 费用</th>
                    <th>服务金额</th>
                    <th>佣金</th>
                    <th>净额</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedStatement.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.orderNumber}</strong>
                        <small>
                          {item.entryKind === "reversal"
                            ? "退款冲正"
                            : componentLabels[item.componentType]}
                        </small>
                      </td>
                      <td>¥{money(item.grossAmountFen)}</td>
                      <td>¥{money(item.commissionAmountFen)}</td>
                      <td className={item.netAmountFen < 0 ? "negative" : ""}>
                        ¥{money(item.netAmountFen)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mode === "platform" &&
              selectedStatement.status === "pending_payment" ? (
                <form className="payout-form" onSubmit={postPayout}>
                  <h3>登记线下全额付款</h3>
                  <p>
                    整张账单只能登记一次，金额固定为 ¥
                    {money(selectedStatement.payableAmountFen)}。
                  </p>
                  <label>
                    付款方式
                    <select name="paymentMethod">
                      <option value="bank_transfer">银行转账</option>
                      <option value="other">其他线下方式</option>
                    </select>
                  </label>
                  <label>
                    银行流水号
                    <input name="bankReference" required minLength={2} />
                  </label>
                  <label>
                    付款时间
                    <input
                      name="paidAt"
                      type="datetime-local"
                      required
                      defaultValue={new Date().toISOString().slice(0, 16)}
                    />
                  </label>
                  <label>
                    备注
                    <textarea name="note" rows={3} />
                  </label>
                  <label>
                    私有付款凭证（可选）
                    <input name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" />
                  </label>
                  <button type="submit">
                    <Bank />
                    确认登记全额付款
                  </button>
                </form>
              ) : null}
              {selectedStatement.payout ? (
                <div className="payout-record">
                  <CheckCircle />
                  <div>
                    <strong>
                      已登记付款 ¥{money(selectedStatement.payout.amountFen)}
                    </strong>
                    <p>
                      {selectedStatement.payout.bankReference} ·{" "}
                      {selectedStatement.payout.postedByName} ·{" "}
                      {dateTime(selectedStatement.payout.paidAt)}
                    </p>
                    {mode === "platform" && selectedStatement.payout.hasEvidence ? (
                      <a href={`/api${base}/statements/${selectedStatement.id}/payout/evidence`} target="_blank" rel="noreferrer">查看私有付款凭证</a>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      {selectedTransaction ? (
        <div
          className="finance-drawer-layer"
          onMouseDown={() => setSelectedTransaction(null)}
        >
          <aside
            className="finance-drawer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>订单流水与结算拆分</small>
                <h2>{selectedTransaction.payment.orderNumber}</h2>
                <p>
                  {businessLabels[selectedTransaction.payment.businessType] ??
                    selectedTransaction.payment.businessType}{" "}
                  · {dateTime(selectedTransaction.payment.occurredAt)}
                </p>
              </div>
              <button onClick={() => setSelectedTransaction(null)}>
                <X />
              </button>
            </header>
            <div className="finance-drawer-body">
              <div className="transaction-money">
                <span>
                  订单标价
                  <strong>
                    ¥{money(selectedTransaction.payment.listedAmountFen)}
                  </strong>
                </span>
                <span>
                  渠道实付
                  <strong>
                    ¥{money(selectedTransaction.payment.channelAmountFen)}
                  </strong>
                </span>
              </div>
              {!selectedTransaction.payment.isReal ||
              selectedTransaction.payment.listedAmountFen !==
                selectedTransaction.payment.channelAmountFen ? (
                <div className="finance-warning">
                  该流水为模拟、测试缩放或金额不一致记录，不进入正式结算。
                </div>
              ) : null}
              {selectedTransaction.valetExecution ? (
                <div className="finance-driver">
                  <strong>执行司机：{selectedTransaction.valetExecution.driverName}</strong>
                  <span>{selectedTransaction.valetExecution.driverPhone || "手机号待认领"} · {selectedTransaction.valetExecution.status}</span>
                </div>
              ) : null}
              {selectedTransaction.payment.businessType === "repair" &&
              selectedTransaction.payment.kind === "charge" &&
              selectedTransaction.payment.isReal &&
              selectedTransaction.order?.status === "paid" ? (
                <button className="finance-refund" onClick={() => void refundRepair()}>维修订单全额退款</button>
              ) : null}
              <h3>费用与应付拆分</h3>
              {selectedTransaction.accruals.length ? (
                selectedTransaction.accruals.map((item) => (
                  <article className="accrual-row" key={item.id}>
                    <div>
                      <strong>
                        {componentLabels[item.componentType] ??
                          item.componentType}
                      </strong>
                      <small>
                        {item.counterpartyName} ·{" "}
                        {item.entryKind === "reversal" ? "退款冲正" : "应计"}
                      </small>
                    </div>
                    <span>
                      服务 ¥{money(item.grossAmountFen)} − 佣金 ¥
                      {money(item.commissionAmountFen)} ={" "}
                      <b>¥{money(item.netAmountFen)}</b>
                    </span>
                    <small>
                      {item.statementNumber
                        ? `已进入 ${item.statementNumber}`
                        : "待进入日账单"}
                    </small>
                  </article>
                ))
              ) : (
                <div className="finance-empty-note">
                  尚未达到结算条件，或不是可结算的真实支付。
                </div>
              )}
              <h3>订单状态时间线</h3>
              {selectedTransaction.timeline.map((item, index) => (
                <div
                  className="finance-timeline"
                  key={`${item.createdAt}-${index}`}
                >
                  <i />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                    <small>{dateTime(item.createdAt)}</small>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function RulesPanel({
  rules,
  reload,
  onError,
}: {
  rules: Rule[];
  reload: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [businessType, setBusinessType] = useState("annual_inspection");
  const [mode, setMode] = useState("percentage");
  const [settings, setSettings] = useState<FinanceSettings | null>(null);
  const [previewText, setPreviewText] = useState("");
  const refreshSettings = useCallback(async () => {
    try { setSettings(await api<FinanceSettings>("/admin/finance/settings")); } catch (error) { onError(error); }
  }, [onError]);
  useEffect(() => { void refreshSettings(); }, [refreshSettings]);
  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const effectiveFrom = String(data.get("effectiveFrom"));
    const payload =
      businessType === "valet"
        ? {
            businessType,
            calculationMode: "distance",
            baseFeeFen: Math.round(Number(data.get("baseFee")) * 100),
            includedKm: Number(data.get("includedKm")),
            perKmFen: Math.round(Number(data.get("perKm")) * 100),
            effectiveFrom,
          }
        : mode === "fixed"
          ? {
              businessType,
              calculationMode: "fixed",
              fixedFen: Math.round(Number(data.get("fixed")) * 100),
              effectiveFrom,
            }
          : {
              businessType,
              calculationMode: "percentage",
              rateBps: Math.round(Number(data.get("rate")) * 100),
              effectiveFrom,
            };
    try {
      await api("/admin/finance/rules", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await reload();
    } catch (error) {
      onError(error);
    }
  }
  async function publish(id: string) {
    try {
      await api(`/admin/finance/rules/${id}/publish`, { method: "POST" });
      await reload();
    } catch (error) {
      onError(error);
    }
  }
  async function preview(rule: Rule) {
    try {
      const result = await api<{ amountFen?: number; distanceKm?: number; commissionFen?: number; receivableFen?: number; payableFen?: number }>(`/admin/finance/rules/${rule.id}/preview`, { method: "POST", body: JSON.stringify(rule.businessType === "valet" ? { distanceKm: 8 } : { amountFen: 10_000 }) });
      setPreviewText(rule.businessType === "valet" ? `预览：单程 8km，代驾公司应付 ¥${money(result.payableFen || 0)}` : `预览：服务金额 ¥100.00，佣金 ¥${money(result.commissionFen || 0)}，服务商应收 ¥${money(result.receivableFen || 0)}`);
    } catch (error) { onError(error); }
  }
  async function saveCompany(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api("/admin/finance/valet-company", { method: "PUT", body: JSON.stringify({ code: data.get("code"), name: data.get("name"), contactName: data.get("contactName") || null, contactPhone: data.get("contactPhone") || null }) });
      await refreshSettings();
    } catch (error) { onError(error); }
  }
  async function enableFinance() {
    if (!window.confirm("启用后只处理切换时间之后创建的新订单，历史订单不会回填。确认启用？")) return;
    try { await api("/admin/finance/enable", { method: "POST" }); await Promise.all([refreshSettings(), reload()]); } catch (error) { onError(error); }
  }
  return (
    <>
    <section className="finance-card finance-partner-card">
      <header className="finance-partner-header">
        <div>
          <small>PARTNER</small>
          <h3>合作代驾公司</h3>
          <p>代驾费结算会付给这里配置的公司。修改后点「保存」即可，不影响已出结算单。</p>
        </div>
        <div className={`finance-enable-badge ${settings?.enabled ? "is-on" : "is-off"}`}>
          {settings?.enabled
            ? `财务已启用 · 自 ${dateTime(settings.cutoverAt)} 起的新订单`
            : "财务尚未启用"}
        </div>
      </header>
      <form key={settings?.valetCompany?.id || "new-company"} className="finance-partner-form" onSubmit={saveCompany}>
        <label>公司编码<input name="code" required defaultValue={settings?.valetCompany?.code || ""} placeholder="如 YXM-VALET-01" /></label>
        <label>公司名称<input name="name" required defaultValue={settings?.valetCompany?.name || ""} placeholder="合作代驾公司全称" /></label>
        <label>调度联系人<input name="contactName" defaultValue={settings?.valetCompany?.contactName || ""} /></label>
        <label>联系电话<input name="contactPhone" defaultValue={settings?.valetCompany?.contactPhone || ""} /></label>
        <button type="submit">保存代驾公司</button>
      </form>
      {!settings?.enabled ? (
        <div className="finance-enable-row">
          <p>启用前请确认：年检 / 洗车 / 维修 / 代驾四套结算规则均已发布，且上方代驾公司已保存。</p>
          <button type="button" className="finance-enable" onClick={() => void enableFinance()}>启用统一财务</button>
        </div>
      ) : null}
    </section>
    <section className="rules-layout">
      <form className="finance-card rule-create" onSubmit={createRule}>
        <small>NEW IMMUTABLE VERSION</small>
        <h3>创建规则草稿</h3>
        <label>
          业务
          <select
            value={businessType}
            onChange={(event) => {
              setBusinessType(event.target.value);
              setMode(
                event.target.value === "valet" ? "distance" : "percentage",
              );
            }}
          >
            <option value="annual_inspection">年检佣金</option>
            <option value="car_wash">洗车佣金</option>
            <option value="repair">维修佣金</option>
            <option value="valet">代驾公司成本</option>
          </select>
        </label>
        {businessType === "valet" ? (
          <>
            <label>
              起步价（元）
              <input
                name="baseFee"
                type="number"
                min="0"
                step="0.01"
                required
              />
            </label>
            <label>
              包含公里数
              <input
                name="includedKm"
                type="number"
                min="0"
                step="0.1"
                required
              />
            </label>
            <label>
              超出每公里（元）
              <input name="perKm" type="number" min="0" step="0.01" required />
            </label>
          </>
        ) : (
          <>
            <label>
              计费方式
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="percentage">比例佣金</option>
                <option value="fixed">固定佣金</option>
              </select>
            </label>
            {mode === "percentage" ? (
              <label>
                佣金比例（%）
                <input
                  name="rate"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  required
                />
              </label>
            ) : (
              <label>
                固定佣金（元/单）
                <input
                  name="fixed"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                />
              </label>
            )}
          </>
        )}
        <label>
          生效日期
          <input
            name="effectiveFrom"
            type="date"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
        </label>
        <button type="submit">
          <Gear />
          保存草稿
        </button>
      </form>
      <section className="finance-card rule-list">
        <div className="finance-card-title">
          <div>
            <small>VERSION HISTORY</small>
            <h3>规则版本</h3>
          </div>
          <span>发布后不可编辑，订单按进入结算时的规则冻结快照</span>
        </div>
        {previewText ? <div className="finance-rule-preview">{previewText}</div> : null}
        {rules.map((rule) => (
          <article key={rule.id}>
            <div>
              <strong>
                {businessLabels[rule.businessType]} · v{rule.version}
              </strong>
              <small>
                {rule.calculationMode === "percentage"
                  ? `${Number(rule.rateBps) / 100}%`
                  : rule.calculationMode === "fixed"
                    ? `¥${money(Number(rule.fixedFen))}/单`
                    : `起步 ¥${money(Number(rule.baseFeeFen))}，含 ${rule.includedKm}km，超出 ¥${money(Number(rule.perKmFen))}/km`}{" "}
                · {rule.effectiveFrom} 生效
              </small>
            </div>
            <span className={`finance-status ${rule.status}`}>
              {rule.status === "active"
                ? "生效中"
                : rule.status === "draft"
                  ? "草稿"
                  : "历史版本"}
            </span>
            {rule.status === "draft" ? (
              <><button onClick={() => void preview(rule)}>预览</button><button onClick={() => void publish(rule.id)}>发布</button></>
            ) : null}
          </article>
        ))}
      </section>
    </section>
    </>
  );
}
