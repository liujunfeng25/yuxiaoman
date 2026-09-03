export type RepairShopFilter = "all" | "pending" | "quoted" | "won";
export type RepairShopRequestStatus = "pending_quote" | "quoted" | "won" | "not_selected" | "closed";
export type RepairShopQuoteStatus = "active" | "withdrawn";

export type RepairShopQuoteDto = {
  id: string;
  totalFen: number;
  note: string;
  status: RepairShopQuoteStatus;
  updatedAt: string;
  revision?: number;
};

export type RepairFaultDto = {
  id: string;
  regionLabel: string;
  typeLabel: string;
  severityLabel: string;
  description?: string | null;
  photoUrls: string[];
};

export type RepairShopRequestDto = {
  id: string;
  requestNo?: string;
  plateMasked: string;
  vehicleLabel: string;
  submittedAt: string;
  status: RepairShopRequestStatus;
  faults: RepairFaultDto[];
  myQuote?: RepairShopQuoteDto | null;
  activeQuoteCount?: number;
  demoNotice?: string;
  serviceBoundary?: string;
};

export type RepairShopRequestListItem = Omit<RepairShopRequestDto, "faults"> & {
  faultCount: number;
  primaryFaultLabel?: string;
};

export type RepairShopHallDto = {
  shop?: { id: string; name: string };
  stats: { pending: number; quoted: number; won: number };
  requests: RepairShopRequestListItem[];
};

export type RepairShopRawQuote = {
  id: string;
  status: string;
  totalPriceFen: number;
  note: string;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type RepairShopRawVehicle = {
  plateNumberMasked?: string;
  vehicleType?: string;
  brandName?: string;
  modelName?: string;
  displayName?: string;
};

export type RepairShopRawFault = {
  id: string;
  sequence?: number;
  viewId?: string;
  regionCode?: string;
  faultType?: string;
  severity?: string;
  description?: string | null;
  photos?: Array<{ url: string }>;
};

export type RepairShopRawRequest = {
  id: string;
  requestNo?: string;
  status: string;
  createdAt?: string;
  submittedAt?: string;
  demoNotice?: string;
  serviceBoundary?: string;
  vehicle?: RepairShopRawVehicle;
  report?: { faultCount?: number; faults?: RepairShopRawFault[] } | null;
  faults?: RepairShopRawFault[];
  media?: Array<{ url: string }>;
  ownerContact?: { name: string; phone: string } | null;
  activeQuoteCount?: number;
  faultCount?: number;
  primaryFault?: { regionCode?: string; faultType?: string; severity?: string } | null;
  shopStatus?: string;
  ownQuote?: RepairShopRawQuote | RepairShopQuoteDto | null;
};

export type RepairShopHallApiResult = RepairShopHallDto | { items: RepairShopRawRequest[] };
export type RepairShopRequestApiResult = RepairShopRequestDto | RepairShopRawRequest;

export type RepairShopDealDto = {
  request: RepairShopRequestApiResult;
  quote: RepairShopQuoteDto | RepairShopRawQuote;
  paymentStatus: "paid";
  contact: { name: string; phone: string };
  boundary?: string;
};
export type RepairShopDealApiResult = RepairShopDealDto | RepairShopRawRequest;
export type RepairShopDealView = {
  eligible: boolean;
  request: RepairShopRequestDto;
  quote: RepairShopQuoteDto | null;
  contact: { name: string; phone: string } | null;
  boundary: string;
};

export type RepairShopQuoteInput = {
  totalFen: number;
  note: string;
  idempotencyKey: string;
};

export type RepairShopApi = {
  repairShopHall(): Promise<RepairShopHallApiResult>;
  repairShopRequest(requestId: string): Promise<RepairShopRequestApiResult>;
  submitRepairShopQuote(requestId: string, input: RepairShopQuoteInput): Promise<RepairShopRequestApiResult>;
  withdrawRepairShopQuote(requestId: string): Promise<RepairShopRequestApiResult>;
  repairShopDeal(requestId: string): Promise<RepairShopDealApiResult>;
};

export type RepairShopRequestView = RepairShopRequestListItem & {
  statusLabel: string;
  statusHint: string;
  actionLabel: string;
  quoteAmountLabel: string;
  faultSummary: string;
};

const FILTER_STATUSES: Record<Exclude<RepairShopFilter, "all">, RepairShopRequestStatus[]> = {
  pending: ["pending_quote"],
  quoted: ["quoted"],
  won: ["won"],
};

const REGION_LABELS: Record<string, string> = {
  front_bumper: "前保险杠",
  front_face: "前脸与灯组",
  hood: "发动机舱盖",
  windshield: "前挡风玻璃",
  roof: "车顶",
  rear_glass: "后挡风玻璃",
  trunk_tailgate: "后备厢盖与尾门",
  rear_bumper: "后保险杠",
  left_mirror: "左后视镜",
  left_front_fender: "左前翼子板",
  left_front_door: "左前门",
  left_rear_door: "左后门",
  left_rear_quarter: "左后翼子板",
  left_sill: "左侧裙",
  right_mirror: "右后视镜",
  right_front_fender: "右前翼子板",
  right_front_door: "右前门",
  right_rear_door: "右后门",
  right_rear_quarter: "右后翼子板",
  right_sill: "右侧裙",
};

const FAULT_TYPE_LABELS: Record<string, string> = {
  scratch: "剐蹭 / 划痕",
  dent: "凹陷",
  paint_damage: "掉漆",
  crack: "裂纹",
  broken: "破损",
  rust: "锈蚀",
  other: "其他车况问题",
};

const SEVERITY_LABELS: Record<string, string> = {
  minor: "轻微",
  moderate: "一般",
  severe: "明显",
};

export function maskPlateForShop(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "车牌已脱敏";
  if (normalized.includes("*")) return normalized;
  const compact = normalized.replace(/[·\s-]/g, "");
  const characters = Array.from(compact);
  if (characters.length < 4) return `${characters[0] || "车"}***`;
  return `${characters.slice(0, 2).join("")}·***${characters.slice(-2).join("")}`;
}

export function fenToYuanInput(fen: number | null | undefined): string {
  if (!Number.isFinite(fen) || Number(fen) < 0) return "";
  const normalized = Math.trunc(Number(fen));
  const yuan = Math.floor(normalized / 100);
  const cents = normalized % 100;
  if (!cents) return String(yuan);
  return `${yuan}.${String(cents).padStart(2, "0")}`;
}

export function formatFenAmount(fen: number | null | undefined): string {
  const input = fenToYuanInput(fen);
  if (!input) return "--";
  const [yuan, cents] = input.split(".");
  const grouped = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents ? `${grouped}.${cents}` : grouped;
}

export type YuanAmountResult = { valid: boolean; fen: number | null; error: string };

export function yuanInputToFen(value: string): YuanAmountResult {
  const normalized = String(value || "").trim();
  if (!normalized) return { valid: false, fen: null, error: "请输入报价总额" };
  const match = /^(0|[1-9]\d{0,4})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return { valid: false, fen: null, error: "请输入 1–99999.99 元，最多两位小数" };
  const cents = (match[2] || "").padEnd(2, "0");
  const fen = Number(match[1]) * 100 + Number(cents || 0);
  if (fen < 100 || fen > 9999999) return { valid: false, fen: null, error: "报价总额需在 1–99999.99 元之间" };
  return { valid: true, fen, error: "" };
}

export function normalizeQuoteNote(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function validateShopQuote(totalInput: string, noteInput: string): { totalFen: number | null; note: string; priceError: string; noteError: string } {
  const amount = yuanInputToFen(totalInput);
  const note = normalizeQuoteNote(noteInput);
  return {
    totalFen: amount.fen,
    note,
    priceError: amount.error,
    noteError: !note ? "请填写一句报价说明" : note.length > 60 ? "报价说明最多 60 个字" : "",
  };
}

export function filterShopRequests<T extends Pick<RepairShopRequestListItem, "status">>(requests: T[], filter: RepairShopFilter): T[] {
  if (filter === "all") return [...requests];
  const statuses = FILTER_STATUSES[filter];
  return requests.filter((request) => statuses.includes(request.status));
}

export function shopStatusLabel(status: RepairShopRequestStatus): string {
  const labels: Record<RepairShopRequestStatus, string> = {
    pending_quote: "待报价",
    quoted: "已报价",
    won: "已成交",
    not_selected: "未选中",
    closed: "已结束",
  };
  return labels[status] || "查看需求";
}

export function shopStatusHint(status: RepairShopRequestStatus): string {
  if (status === "pending_quote") return "等待本店报价";
  if (status === "quoted") return "等待车主选择";
  if (status === "won") return "车主已付款";
  if (status === "not_selected") return "车主已选择其他门店";
  return "本次需求已关闭";
}

export function shopRequestActionLabel(status: RepairShopRequestStatus): string {
  if (status === "pending_quote") return "立即报价";
  if (status === "quoted") return "查看 / 修改";
  if (status === "won") return "查看成交";
  return "查看详情";
}

export function shopRequestView(item: RepairShopRequestListItem): RepairShopRequestView {
  const faultCount = Math.max(0, Number(item.faultCount || 0));
  return {
    ...item,
    plateMasked: maskPlateForShop(item.plateMasked),
    faultCount,
    statusLabel: shopStatusLabel(item.status),
    statusHint: shopStatusHint(item.status),
    actionLabel: shopRequestActionLabel(item.status),
    quoteAmountLabel: item.myQuote?.status === "active" ? formatFenAmount(item.myQuote.totalFen) : "",
    faultSummary: item.primaryFaultLabel || `${faultCount} 处车身问题`,
  };
}

export function formatShopTimestamp(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "提交时间待确认";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return normalized.replace("T", " ").slice(0, 16);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

export function normalizeRepairQuote(value: RepairShopQuoteDto | RepairShopRawQuote | null | undefined): RepairShopQuoteDto | null {
  if (!value) return null;
  const raw = value as RepairShopRawQuote & Partial<RepairShopQuoteDto>;
  const totalFen = Number(raw.totalFen ?? raw.totalPriceFen ?? 0);
  return {
    id: String(raw.id || ""),
    totalFen: Number.isFinite(totalFen) ? Math.max(0, Math.trunc(totalFen)) : 0,
    note: String(raw.note || ""),
    status: raw.status === "withdrawn" ? "withdrawn" : "active",
    updatedAt: formatShopTimestamp(raw.updatedAt || raw.createdAt),
    revision: raw.revision,
  };
}

export function deriveShopRequestStatus(rawStatus: string, rawQuote?: RepairShopQuoteDto | RepairShopRawQuote | null, hasContact = false): RepairShopRequestStatus {
  if (["pending_quote", "quoted", "won", "not_selected", "closed"].includes(rawStatus)) return rawStatus as RepairShopRequestStatus;
  const quoteStatus = String(rawQuote?.status || "").toLowerCase();
  if (["selected", "accepted", "won"].includes(quoteStatus) || (rawStatus === "paid" && hasContact)) return "won";
  if (["not_selected", "rejected", "lost"].includes(quoteStatus)) return "not_selected";
  if (rawStatus === "paid") return "not_selected";
  if (["closed", "cancelled", "expired"].includes(rawStatus)) return "closed";
  if (rawQuote && quoteStatus !== "withdrawn") return "quoted";
  return "pending_quote";
}

function rawFaultView(fault: RepairShopRawFault, index: number): RepairFaultDto {
  return {
    id: fault.id || `fault-${index + 1}`,
    regionLabel: REGION_LABELS[fault.regionCode || ""] || "车身位置",
    typeLabel: FAULT_TYPE_LABELS[fault.faultType || ""] || "车况问题",
    severityLabel: SEVERITY_LABELS[fault.severity || ""] || "程度待确认",
    description: fault.description || null,
    photoUrls: (fault.photos || []).map((photo) => photo.url).filter(Boolean),
  };
}

function vehicleLabel(vehicle: RepairShopRawVehicle | undefined): string {
  if (!vehicle) return "车型信息待确认";
  const brandModel = [vehicle.brandName, vehicle.modelName].filter(Boolean).join(" ");
  return vehicle.displayName || brandModel || vehicle.vehicleType || "车型信息待确认";
}

export function normalizeRepairRequest(item: RepairShopRequestApiResult): RepairShopRequestDto {
  const raw = item as RepairShopRawRequest & Partial<RepairShopRequestDto>;
  const rawQuote = raw.ownQuote ?? raw.myQuote;
  const rawFaults = Array.isArray(raw.faults)
    ? raw.faults
    : Array.isArray(raw.report?.faults) ? raw.report!.faults! : [];
  const faults = rawFaults.map((fault, index) => {
    if ("regionLabel" in fault && "typeLabel" in fault && "severityLabel" in fault) {
      const canonical = fault as unknown as RepairFaultDto;
      return { ...canonical, photoUrls: [...(canonical.photoUrls || [])] };
    }
    return rawFaultView(fault, index);
  });
  const quote = normalizeRepairQuote(rawQuote);
  const plate = raw.plateMasked || raw.vehicle?.plateNumberMasked;
  return {
    id: String(raw.id || ""),
    requestNo: raw.requestNo,
    plateMasked: maskPlateForShop(plate),
    vehicleLabel: raw.vehicleLabel || vehicleLabel(raw.vehicle),
    submittedAt: formatShopTimestamp(raw.submittedAt || raw.createdAt),
    status: deriveShopRequestStatus(String(raw.status || "open"), rawQuote, Boolean(raw.ownerContact)),
    faults,
    myQuote: quote,
    activeQuoteCount: raw.activeQuoteCount,
    demoNotice: raw.demoNotice,
    serviceBoundary: raw.serviceBoundary,
  };
}

export function normalizeRepairRequestListItem(item: RepairShopRequestApiResult): RepairShopRequestListItem {
  const raw = item as RepairShopRawRequest;
  const request = normalizeRepairRequest(item);
  const reportFaults = raw.report?.faults || [];
  const faultCount = request.faults.length || Number(raw.faultCount || raw.report?.faultCount || reportFaults.length || 0);
  const firstFault = request.faults[0]
    || (reportFaults[0] ? rawFaultView(reportFaults[0], 0) : null)
    || (raw.primaryFault ? rawFaultView({ id: "primary", ...raw.primaryFault }, 0) : null);
  return {
    ...request,
    faultCount,
    primaryFaultLabel: firstFault ? `${firstFault.regionLabel}等 ${faultCount} 处车身问题` : `${faultCount} 处车身问题`,
  };
}

export function deriveShopStats(requests: RepairShopRequestListItem[]): RepairShopHallDto["stats"] {
  return requests.reduce((stats, request) => {
    if (request.status === "pending_quote") stats.pending += 1;
    else if (request.status === "quoted") stats.quoted += 1;
    else if (request.status === "won") stats.won += 1;
    return stats;
  }, { pending: 0, quoted: 0, won: 0 });
}

export function normalizeRepairShopHall(value: RepairShopHallApiResult): RepairShopHallDto {
  const raw = value as RepairShopHallDto & { items?: RepairShopRawRequest[] };
  const source: RepairShopRequestApiResult[] = Array.isArray(raw.requests) ? raw.requests : raw.items || [];
  const requests = source.map(normalizeRepairRequestListItem);
  return {
    shop: raw.shop,
    stats: deriveShopStats(requests),
    requests,
  };
}

export function normalizeRepairShopDeal(value: RepairShopDealApiResult): RepairShopDealView {
  const wrapped = value as RepairShopDealDto;
  const isWrapped = Boolean(wrapped.request && wrapped.paymentStatus);
  const rawRequest = isWrapped ? wrapped.request : value as RepairShopRawRequest;
  const request = normalizeRepairRequest(rawRequest);
  const raw = rawRequest as RepairShopRawRequest;
  const quote = normalizeRepairQuote(isWrapped ? wrapped.quote : raw.ownQuote);
  const contact = isWrapped ? wrapped.contact : raw.ownerContact || null;
  const eligible = (isWrapped ? wrapped.paymentStatus === "paid" : raw.status === "paid")
    && request.status === "won"
    && Boolean(quote && contact?.name && contact.phone);
  return {
    eligible,
    request,
    quote,
    contact: eligible ? contact : null,
    boundary: (isWrapped ? wrapped.boundary : raw.serviceBoundary)
      || "平台完成需求撮合与本地模拟支付后，双方线下确认维修范围、进店时间、材料、增项与验收；平台不跟踪维修履约。",
  };
}
