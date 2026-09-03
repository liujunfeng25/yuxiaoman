export type OwnerQuoteStatus = "active" | "withdrawn" | "selected" | "lost";

export type OwnerQuoteLike = {
  id: string;
  status: OwnerQuoteStatus;
  totalPriceFen: number;
  createdAt?: string;
};

export type OwnerRepairRequestStatus = "open" | "paid" | "cancelled";

export type OwnerRepairStatusView = {
  title: string;
  description: string;
  tone: "waiting" | "quoted" | "paid" | "cancelled";
  iconPath: string;
  canCancel: boolean;
  canChooseQuote: boolean;
};

const QUOTE_STATUS_RANK: Record<OwnerQuoteStatus, number> = {
  active: 0,
  selected: 0,
  lost: 1,
  withdrawn: 2,
};

const REGION_LABELS: Record<string, string> = {
  front_bumper: "前保险杠",
  front_face: "前脸与灯组",
  hood: "发动机舱盖",
  windshield: "前挡风玻璃",
  roof: "车顶",
  rear_glass: "后挡风玻璃",
  trunk: "后备厢盖",
  trunk_tailgate: "后备厢盖与尾门",
  rear_bumper: "后保险杠",
  left_mirror: "左后视镜",
  left_front_fender: "左前翼子板",
  left_front_door: "左前车门",
  left_rear_door: "左后车门",
  left_rear_fender: "左后翼子板",
  left_rear_quarter: "左后翼子板",
  left_sill: "左侧裙",
  right_mirror: "右后视镜",
  right_front_fender: "右前翼子板",
  right_front_door: "右前车门",
  right_rear_door: "右后车门",
  right_rear_fender: "右后翼子板",
  right_rear_quarter: "右后翼子板",
  right_sill: "右侧裙",
  front_left: "左前部",
  front_right: "右前部",
  rear_left: "左后部",
  rear_right: "右后部",
};

const FAULT_TYPE_LABELS: Record<string, string> = {
  scratch: "划痕",
  dent: "凹陷",
  paint_damage: "漆面损伤",
  crack: "开裂",
  broken: "破损",
  rust: "锈蚀",
  other: "其他问题",
};

const SEVERITY_LABELS: Record<string, string> = {
  minor: "轻微",
  moderate: "明显",
  severe: "严重",
};

const VIEW_LABELS: Record<string, string> = {
  top: "俯视",
  left: "左侧",
  right: "右侧",
};

export function sortOwnerQuotes<T extends OwnerQuoteLike>(quotes: readonly T[]): T[] {
  return quotes
    .map((quote, index) => ({ quote, index }))
    .sort((left, right) => {
      const statusDifference = QUOTE_STATUS_RANK[left.quote.status] - QUOTE_STATUS_RANK[right.quote.status];
      if (statusDifference) return statusDifference;
      const priceDifference = left.quote.totalPriceFen - right.quote.totalPriceFen;
      if (priceDifference) return priceDifference;
      return left.index - right.index;
    })
    .map(({ quote }) => quote);
}

export function defaultOwnerQuoteId<T extends OwnerQuoteLike>(quotes: readonly T[], preferredId = ""): string {
  const preferred = quotes.find((quote) => quote.id === preferredId && (quote.status === "active" || quote.status === "selected"));
  if (preferred) return preferred.id;
  const sorted = sortOwnerQuotes(quotes);
  // An active quote is never selected on the owner's behalf. Only a quote
  // already frozen as selected by the server may be restored automatically.
  return sorted.find((quote) => quote.status === "selected")?.id || "";
}

export function defaultFaultSelection<T extends { id: string }>(faults: readonly T[]): string[] {
  return faults.map((fault) => fault.id);
}

export function lowestActivePriceFen<T extends OwnerQuoteLike>(quotes: readonly T[]): number | null {
  const activePrices = quotes.filter((quote) => quote.status === "active").map((quote) => quote.totalPriceFen);
  return activePrices.length ? Math.min(...activePrices) : null;
}

export function ownerRepairStatusView(status: OwnerRepairRequestStatus, quoteCount: number): OwnerRepairStatusView {
  if (status === "paid") {
    return {
      title: "已支付 · 已成交",
      description: "所选修理店、报价总额和报价说明已冻结，请按成交回执与门店线下确认维修安排。",
      tone: "paid",
      iconPath: "/assets/icons/check-circle.png",
      canCancel: false,
      canChooseQuote: false,
    };
  }
  if (status === "cancelled") {
    return {
      title: "维修询价已取消",
      description: "该需求已停止接收新报价，历史资料仅作为本次询价记录保留。",
      tone: "cancelled",
      iconPath: "/assets/icons/warning-circle.png",
      canCancel: false,
      canChooseQuote: false,
    };
  }
  if (quoteCount > 0) {
    return {
      title: `已收到 ${quoteCount} 份报价`,
      description: "报价已按全款总价从低到高呈现，请同时核对维修说明、门店距离和质保承诺。",
      tone: "quoted",
      iconPath: "/assets/icons/receipt.png",
      canCancel: true,
      canChooseQuote: true,
    };
  }
  return {
    title: "等待修理店报价",
    description: "需求已发布到接单大厅，修理店查看车损资料后即可提交全款总价。",
    tone: "waiting",
    iconPath: "/assets/icons/clock.png",
    canCancel: true,
    canChooseQuote: false,
  };
}

export function regionLabel(code: string): string {
  return REGION_LABELS[code] || code || "车身部位";
}

export function faultTypeLabel(type: string): string {
  return FAULT_TYPE_LABELS[type] || type || "车身问题";
}

export function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity] || severity || "待确认";
}

export function severityTone(severity: string): "minor" | "moderate" | "severe" {
  if (severity === "severe") return "severe";
  if (severity === "moderate") return "moderate";
  return "minor";
}

export function viewLabel(viewId: string): string {
  return VIEW_LABELS[viewId] || "车身视图";
}

export function formatRepairDateTime(value: string | null | undefined): string {
  if (!value) return "待更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace("T", " ").slice(0, 16);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatFenAmount(fen: number | null | undefined): string {
  const value = Number(fen || 0) / 100;
  const [integer, decimal] = value.toFixed(2).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimal === "00" ? grouped : `${grouped}.${decimal.replace(/0$/, "")}`;
}

export function quoteStatusLabel(status: OwnerQuoteStatus): string {
  if (status === "selected") return "已成交";
  if (status === "withdrawn") return "已撤回";
  if (status === "lost") return "未选中";
  return "报价有效";
}
