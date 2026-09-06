import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowCounterClockwise,
  ArrowUp,
  Buildings,
  CalendarCheck,
  CaretRight,
  CheckCircle,
  CircleNotch,
  CurrencyCny,
  FloppyDisk,
  Gauge,
  ListChecks,
  MagnifyingGlass,
  MapPin,
  ImageSquare,
  Plus,
  Receipt,
  Star,
  SteeringWheel,
  SlidersHorizontal,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, money, upload } from "./adminApi";
import { operatorErrorMessage } from "./operatorError";

type VehicleType = "sedan" | "suv" | "mpv";
type OrderVehicleType = VehicleType | "suv_mpv";
type WashOrderStatus = "pending_payment" | "awaiting_redemption" | "redeemed" | "cancelled" | "refunded" | "expired" | "paid" | "booked" | "completed";
type SettlementStatus = "pending" | "unsettled" | "settled" | "adjusted" | "not_applicable" | "void";
type RedeemSource = "wechat" | "phone" | "other";
type WashServiceMode = "self_drive" | "valet";

type WashPickupAddress = {
  poiId: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  detail?: string;
  note?: string;
};

type LocationSuggestion = {
  poiId: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  source?: "tencent" | "demo";
  locationProof?: string;
};

type LocationSearchState = "idle" | "loading" | "ready" | "empty" | "error";

type WashValetRule = {
  scope: "global" | "store";
  storeId?: string | null;
  baseFeeFen: number;
  includedKm: number;
  perKmFen: number;
  maxRadiusKm: number | null;
  updatedAt?: string;
  version?: string;
};

type WashValetRuleResponse = Partial<WashValetRule> & {
  inherited?: boolean;
  rule?: WashValetRule;
};

function normalizeWashValetRule(payload: WashValetRuleResponse): { rule: WashValetRule; inherited: boolean } {
  const value = payload.rule ?? payload;
  return {
    inherited: payload.inherited ?? value.scope !== "store",
    rule: {
      scope: value.scope === "store" ? "store" : "global",
      storeId: value.storeId ?? null,
      baseFeeFen: Number(value.baseFeeFen ?? 0),
      includedKm: Number(value.includedKm ?? 0),
      perKmFen: Number(value.perKmFen ?? 0),
      maxRadiusKm: value.maxRadiusKm == null ? null : Number(value.maxRadiusKm),
      updatedAt: value.updatedAt,
      version: value.version,
    },
  };
}

type ListPayload<T> = T[] | { items: T[]; total?: number };

export type WashStoreImage = {
  id: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sortOrder: number;
  isCover: boolean;
  isStored: boolean;
  dataKind: "demo";
  createdAt: string;
};

export type WashStore = {
  id: string;
  name: string;
  district: string;
  address: string;
  phone: string | null;
  openHours: string;
  latitude: number;
  longitude: number;
  coverImageUrl: string | null;
  imageCount: number;
  images: WashStoreImage[];
  description: string;
  tags: string[];
  facilities: string[];
  weeklySchedule: Record<string, Array<{ start: string; end: string }>>;
  businessHoursNotice: string | null;
  advanceBookingDays: number;
  rating: number;
  reviewCount: number;
  dataKind: "demo";
  sortPriority: number;
  internalContact: { name: string; phone: string } | null;
  isActive: boolean;
  isOpen: boolean;
  notice: string | null;
  updatedAt?: string;
};

export type WashPackage = {
  id: string;
  code: string;
  name: string;
  description: string;
  includedItems: string[];
  durationMinutes: number;
  sortOrder: number;
  isActive: boolean;
  updatedAt?: string;
};

type WashOffer = {
  id?: string;
  storeId: string;
  packageId: string;
  vehicleType: VehicleType;
  salePriceFen: number;
  estimatedSettlementFen: number;
  isActive: boolean;
};

type WashSlot = {
  id: string;
  storeId: string;
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
  bookedCount: number;
  remaining?: number;
  isClosed: boolean;
};

type WashOrder = {
  id: string;
  orderNumber: string;
  verificationCode: string;
  status: WashOrderStatus;
  settlementStatus: SettlementStatus;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  contactName?: string;
  contactPhone?: string;
  paidFen: number;
  serviceFeeFen?: number;
  totalFeeFen?: number;
  washFeeFen?: number;
  valetFeeFen?: number;
  serviceMode: WashServiceMode;
  tripType?: "round_trip_same_address" | null;
  pickupAddress?: WashPickupAddress | null;
  oneWayDistanceKm?: number | null;
  roundTripDistanceKm?: number | null;
  billableDistanceKm?: number | null;
  driveMinutes?: number | null;
  distanceSource?: string | null;
  distanceBasis?: string | null;
  valetRule?: WashValetRule | null;
  breakdown?: {
    washFeeFen: number;
    valetBaseFeeFen: number;
    valetDistanceFeeFen: number;
    valetFeeFen: number;
    totalFeeFen: number;
  } | null;
  storeId?: string;
  storeName?: string;
  store?: Pick<WashStore, "id" | "name">;
  packageId?: string;
  packageName?: string;
  package?: Pick<WashPackage, "id" | "name">;
  vehicleType: OrderVehicleType;
  vehiclePlate: string;
  operationNote?: string | null;
  cancellationReason?: string | null;
  refundReason?: string | null;
  redeemedAt?: string | null;
  redeemSource?: RedeemSource | null;
  redeemNote?: string | null;
  actualSettlementFen?: number | null;
  settlementNote?: string | null;
  settlementCorrectionReason?: string | null;
  estimatedSettlementFen?: number | null;
  updatedAt?: string;
};

type PackageAliases = WashPackage & { shortDescription?: string; serviceItems?: string[] };
type OfferAliases = {
  id?: string;
  storeId: string;
  packageId: string;
  vehicleType?: OrderVehicleType;
  vehicleCategory?: OrderVehicleType;
  salePriceFen: number;
  estimatedSettlementFen: number;
  isActive?: boolean;
  isAvailable?: boolean;
};
type SlotAliases = WashSlot & { reservedCount?: number; isOpen?: boolean };
type OrderAliases = WashOrder & {
  redemptionCode?: string;
  redeemCode?: string;
  paidAmountFen?: number;
  plateNumber?: string;
  vehicleCategory?: OrderVehicleType;
  internalNote?: string | null;
  settlement?: { status?: SettlementStatus | "void"; amountFen?: number | null; reason?: string | null; note?: string | null } | null;
  events?: Array<{ status?: string; metadata?: { source?: RedeemSource; note?: string | null }; createdAt?: string }>;
};

const orderStatusLabels: Record<string, string> = {
  pending_payment: "待支付",
  awaiting_redemption: "待人工核销",
  paid: "已支付",
  booked: "待到店",
  redeemed: "已核销",
  completed: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
  expired: "已过期",
};

const settlementStatusLabels: Record<string, string> = {
  pending: "待结算",
  unsettled: "未登记",
  settled: "已结算",
  adjusted: "已修正",
  not_applicable: "无需结算",
  void: "已作废",
};

const orderFilterStatuses: WashOrderStatus[] = ["pending_payment", "awaiting_redemption", "redeemed", "cancelled", "refunded", "expired"];
const settlementFilterStatuses: SettlementStatus[] = ["unsettled", "settled", "void"];

const vehicleTypes: VehicleType[] = ["sedan", "suv", "mpv"];

const vehicleTypeLabels: Record<OrderVehicleType, string> = {
  sedan: "小轿车",
  suv: "SUV",
  mpv: "MPV",
  suv_mpv: "SUV / MPV（历史）",
};

const redeemSourceLabels: Record<RedeemSource, string> = {
  wechat: "微信",
  phone: "电话",
  other: "其他",
};

function listOf<T>(payload: ListPayload<T>): T[] {
  return Array.isArray(payload) ? payload : payload.items;
}

function hasTrustedStoreCoordinates(store: Pick<WashStore, "address" | "district" | "latitude" | "longitude">) {
  return Boolean(store.address?.trim())
    && Boolean(store.district?.trim())
    && Number.isFinite(store.latitude)
    && Number.isFinite(store.longitude)
    && store.latitude >= -90
    && store.latitude <= 90
    && store.longitude >= -180
    && store.longitude <= 180
    && !(store.latitude === 0 && store.longitude === 0);
}

function normalizeStore(store: WashStore): WashStore {
  const images = [...(store.images ?? [])].sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
  return {
    ...store,
    district: store.district || "",
    address: store.address || "",
    phone: store.phone || null,
    openHours: store.openHours || "",
    latitude: typeof store.latitude === "number" && Number.isFinite(store.latitude) ? store.latitude : Number.NaN,
    longitude: typeof store.longitude === "number" && Number.isFinite(store.longitude) ? store.longitude : Number.NaN,
    coverImageUrl: store.coverImageUrl ?? images.find((image) => image.isCover)?.url ?? images[0]?.url ?? null,
    imageCount: store.imageCount ?? images.length,
    images,
    description: store.description ?? "",
    tags: store.tags ?? [],
    facilities: store.facilities ?? [],
    weeklySchedule: store.weeklySchedule ?? {
      mon: [{ start: "08:00", end: "18:00" }], tue: [{ start: "08:00", end: "18:00" }], wed: [{ start: "08:00", end: "18:00" }],
      thu: [{ start: "08:00", end: "18:00" }], fri: [{ start: "08:00", end: "18:00" }], sat: [{ start: "08:00", end: "18:00" }], sun: [{ start: "08:00", end: "18:00" }],
    },
    businessHoursNotice: store.businessHoursNotice ?? store.notice ?? null,
    advanceBookingDays: store.advanceBookingDays ?? 14,
    rating: store.rating ?? 0,
    reviewCount: store.reviewCount ?? 0,
    dataKind: "demo",
    sortPriority: store.sortPriority ?? 0,
    internalContact: store.internalContact ?? null,
    isActive: Boolean(store.isActive),
    isOpen: store.isOpen ?? store.isActive,
    notice: store.notice ?? store.businessHoursNotice ?? null,
  };
}

function normalizePackage(item: PackageAliases): WashPackage {
  return {
    ...item,
    description: item.description ?? item.shortDescription ?? "",
    includedItems: item.includedItems ?? item.serviceItems ?? [],
  };
}

function normalizedOffer(item: OfferAliases, vehicleType: VehicleType, preserveId = true): WashOffer {
  return {
    ...(preserveId && item.id ? { id: item.id } : {}),
    storeId: item.storeId,
    packageId: item.packageId,
    vehicleType,
    salePriceFen: Number(item.salePriceFen ?? 0),
    estimatedSettlementFen: Number(item.estimatedSettlementFen ?? 0),
    isActive: item.isActive ?? item.isAvailable ?? false,
  };
}

function normalizeOffers(items: OfferAliases[]): WashOffer[] {
  const matrix = new Map<string, WashOffer>();
  for (const item of items) {
    const rawType = item.vehicleType ?? item.vehicleCategory ?? "sedan";
    if (rawType === "suv_mpv") {
      // Legacy combined rows seed both new inputs, but the two entries deliberately
      // receive independent keys and no shared database id before the next save.
      for (const vehicleType of ["suv", "mpv"] as const) {
        const key = `${item.packageId}:${vehicleType}`;
        if (!matrix.has(key)) matrix.set(key, normalizedOffer(item, vehicleType, false));
      }
      continue;
    }
    matrix.set(`${item.packageId}:${rawType}`, normalizedOffer(item, rawType));
  }
  return [...matrix.values()];
}

function normalizeSlot(item: SlotAliases): WashSlot {
  const bookedCount = item.bookedCount ?? item.reservedCount ?? Math.max(0, item.capacity - (item.remaining ?? item.capacity));
  return {
    ...item,
    bookedCount,
    isClosed: item.isClosed ?? !(item.isOpen ?? true),
  };
}

function normalizeOrder(item: OrderAliases): WashOrder {
  const settlementStatus = item.settlementStatus ?? (item.settlement?.status === "void" ? "not_applicable" : item.settlement?.status) ?? "unsettled";
  const redeemEvent = item.events
    ? [...item.events].reverse().find((event) => event.status === "redeemed" && Boolean(event.metadata?.source))
    : undefined;
  return {
    ...item,
    serviceMode: item.serviceMode ?? "self_drive",
    verificationCode: item.verificationCode ?? item.redemptionCode ?? item.redeemCode ?? "",
    paidFen: item.paidFen ?? item.paidAmountFen ?? 0,
    vehiclePlate: item.vehiclePlate ?? item.plateNumber ?? "",
    vehicleType: item.vehicleType ?? item.vehicleCategory ?? "sedan",
    operationNote: item.operationNote ?? item.internalNote ?? null,
    settlementStatus,
    actualSettlementFen: item.actualSettlementFen ?? item.settlement?.amountFen ?? null,
    estimatedSettlementFen: item.estimatedSettlementFen ?? (settlementStatus === "unsettled" ? item.settlement?.amountFen ?? null : null),
    settlementNote: item.settlementNote ?? item.settlement?.note ?? null,
    settlementCorrectionReason: item.settlementCorrectionReason ?? item.settlement?.reason ?? null,
    redeemSource: item.redeemSource ?? redeemEvent?.metadata?.source ?? null,
    redeemNote: item.redeemNote ?? redeemEvent?.metadata?.note ?? null,
  };
}

function splitItems(value: string) {
  return value
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function orderedStoreImages(images: WashStoreImage[]) {
  return [...images].sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
}

function storeImageSize(sizeBytes: number) {
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} 千字节`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} 兆字节`;
}

function tomorrow() {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function plusDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function washDateTime(value?: string | null) {
  if (!value) return "时间未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待核对" : date.toLocaleString("zh-CN", { hour12: false });
}

function washStoreName(order: WashOrder) {
  return order.store?.name || order.storeName || "未绑定门店";
}

function washPackageName(order: WashOrder) {
  return order.package?.name || order.packageName || "未绑定套餐";
}

function sixDigitCode(order: WashOrder) {
  const source = String(order.verificationCode ?? "").replace(/\D/g, "");
  return source ? source.padStart(6, "0").slice(-6) : "——";
}

function emptyStore(): WashStore {
  return {
    id: "",
    name: "",
    district: "",
    address: "",
    phone: null,
    openHours: "08:00-18:00",
    latitude: 0,
    longitude: 0,
    coverImageUrl: null,
    imageCount: 0,
    images: [],
    description: "",
    tags: [],
    facilities: [],
    weeklySchedule: {
      mon: [{ start: "08:00", end: "18:00" }], tue: [{ start: "08:00", end: "18:00" }], wed: [{ start: "08:00", end: "18:00" }],
      thu: [{ start: "08:00", end: "18:00" }], fri: [{ start: "08:00", end: "18:00" }], sat: [{ start: "08:00", end: "18:00" }], sun: [{ start: "08:00", end: "18:00" }],
    },
    businessHoursNotice: null,
    advanceBookingDays: 14,
    rating: 0,
    reviewCount: 0,
    dataKind: "demo",
    sortPriority: 0,
    internalContact: null,
    isActive: false,
    isOpen: false,
    notice: null,
  };
}

function emptyPackage(): WashPackage {
  return {
    id: "",
    code: "",
    name: "",
    description: "",
    includedItems: [],
    durationMinutes: 30,
    sortOrder: 0,
    isActive: true,
  };
}

function orderCanRedeem(order: WashOrder) {
  return ["awaiting_redemption", "paid", "booked"].includes(order.status) && !order.redeemedAt;
}

function orderWasRedeemed(order: WashOrder) {
  return Boolean(order.redeemedAt) || ["redeemed", "completed"].includes(order.status);
}

export function WashOrdersPage({ onError: reportError }: { onError: (message: string) => void }) {
  const onError = useCallback((reason: unknown) => reportError(operatorErrorMessage(reason, "洗车订单操作失败，请稍后重试")), [reportError]);
  const [stores, setStores] = useState<WashStore[]>([]);
  const [orders, setOrders] = useState<WashOrder[]>([]);
  const [selected, setSelected] = useState<WashOrder | null>(null);
  const deepLinkOpenedRef = useRef("");
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    verificationCode: "",
    orderNumber: "",
    storeId: "",
    date: "",
    serviceMode: "",
    status: "",
    settlementStatus: "",
  });

  const loadOrders = async () => {
    setLoading(true);
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    try {
      const payload = await api<ListPayload<WashOrder>>(`/admin/wash/orders?${query.toString()}`);
      const next = listOf(payload).map((item) => normalizeOrder(item as OrderAliases));
      setOrders(next);
      setSelected((current) => current ? next.find((item) => item.id === current.id) ?? current : null);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void api<ListPayload<WashStore>>("/admin/wash/stores")
      .then((payload) => setStores(listOf(payload).map(normalizeStore)))
      .catch((error) => onError(error.message));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOrders(), 180);
    return () => window.clearTimeout(timer);
  }, [filters.verificationCode, filters.orderNumber, filters.storeId, filters.date, filters.serviceMode, filters.status, filters.settlementStatus]);

  const metrics = useMemo(() => ({
    total: orders.length,
    awaiting: orders.filter((item) => ["awaiting_redemption", "paid", "booked"].includes(item.status)).length,
    redeemed: orders.filter(orderWasRedeemed).length,
    unsettled: orders.filter((item) => ["pending", "unsettled"].includes(item.settlementStatus)).length,
  }), [orders]);

  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const updateSelected = (order: WashOrder) => {
    setSelected(order);
    setOrders((current) => current.map((item) => item.id === order.id ? order : item));
  };

  const openOrder = (order: WashOrder) => {
    setSelected(order);
    void api<WashOrder>(`/admin/wash/orders/${order.id}`)
      .then((detail) => setSelected(normalizeOrder(detail as OrderAliases)))
      .catch((error) => onError(error.message));
  };

  useEffect(() => {
    const orderId = new URLSearchParams(window.location.search).get("order") || "";
    if (!orderId || deepLinkOpenedRef.current === orderId) return;
    deepLinkOpenedRef.current = orderId;
    void api<WashOrder>(`/admin/wash/orders/${encodeURIComponent(orderId)}`)
      .then((detail) => setSelected(normalizeOrder(detail as OrderAliases)))
      .catch((error) => onError(error.message));
  }, [onError]);

  return <>
    <section className="metric-strip wash-metrics">
      <div><span><Receipt /></span><small>筛选结果</small><strong>{metrics.total}<em> 笔</em></strong></div>
      <div><span><CalendarCheck /></span><small>待人工核销</small><strong>{metrics.awaiting}<em> 笔</em></strong></div>
      <div><span><CheckCircle /></span><small>已核销</small><strong>{metrics.redeemed}<em> 笔</em></strong></div>
      <div><span><CurrencyCny /></span><small>待登记结算</small><strong>{metrics.unsettled}<em> 笔</em></strong></div>
    </section>
    <section className="content-card wash-order-card">
      <div className="filters wash-order-filters">
        <span><SlidersHorizontal />筛选</span>
        <input aria-label="核销验证码" inputMode="numeric" maxLength={6} placeholder="六位验证码" value={filters.verificationCode} onChange={(event) => setFilter("verificationCode", event.target.value.replace(/\D/g, "").slice(0, 6))} />
        <input aria-label="洗车订单号" placeholder="订单号" value={filters.orderNumber} onChange={(event) => setFilter("orderNumber", event.target.value)} />
        <select aria-label="洗车门店筛选" value={filters.storeId} onChange={(event) => setFilter("storeId", event.target.value)}><option value="">全部门店</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select>
        <input aria-label="洗车预约日期" type="date" value={filters.date} onChange={(event) => setFilter("date", event.target.value)} />
        <select aria-label="洗车服务方式" value={filters.serviceMode} onChange={(event) => setFilter("serviceMode", event.target.value)}><option value="">全部服务方式</option><option value="self_drive">自驾到店</option><option value="valet">往返代驾</option></select>
        <select aria-label="洗车订单状态" value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部订单状态</option>{orderFilterStatuses.map((value) => <option key={value} value={value}>{orderStatusLabels[value]}</option>)}</select>
        <select aria-label="洗车结算状态" value={filters.settlementStatus} onChange={(event) => setFilter("settlementStatus", event.target.value)}><option value="">全部结算状态</option>{settlementFilterStatuses.map((value) => <option key={value} value={value}>{settlementStatusLabels[value]}</option>)}</select>
        <button onClick={() => setFilters({ verificationCode: "", orderNumber: "", storeId: "", date: "", serviceMode: "", status: "", settlementStatus: "" })}>清空</button>
      </div>
      <div className="table-wrap wash-order-table"><table><thead><tr><th>订单号</th><th>六位核销码</th><th>车辆</th><th>服务方式</th><th>门店</th><th>套餐</th><th>实付</th><th>订单状态</th><th>结算状态</th><th /></tr></thead><tbody>{orders.map((order) => <tr key={order.id} onClick={() => openOrder(order)}>
        <td><strong>{order.orderNumber}</strong><small>{order.appointmentDate} {order.startTime}–{order.endTime}</small></td>
        <td><strong className="verification-code">{sixDigitCode(order)}</strong><small>完整展示</small></td>
        <td><strong>{order.vehiclePlate || "待登记"}</strong><small>{vehicleTypeLabels[order.vehicleType]}</small></td>
        <td><span className={`mode-pill ${order.serviceMode}`}>{order.serviceMode === "valet" ? "往返代驾" : "自驾到店"}</span>{order.serviceMode === "valet" && order.oneWayDistanceKm != null ? <small>单程 {order.oneWayDistanceKm} 公里</small> : null}</td>
        <td><strong>{washStoreName(order)}</strong></td>
        <td><strong>{washPackageName(order)}</strong></td>
        <td><strong>¥{money(order.paidFen)}</strong></td>
        <td><span className={`status-pill wash-status-${order.status}`}>{orderStatusLabels[order.status] || "状态待核对"}</span></td>
        <td><span className={`settlement-pill settlement-${order.settlementStatus}`}>{settlementStatusLabels[order.settlementStatus] || "状态待核对"}</span></td>
        <td><CaretRight /></td>
      </tr>)}</tbody></table>{loading ? <div className="table-loading">正在读取洗车订单…</div> : !orders.length ? <div className="empty-table">没有符合条件的洗车订单</div> : null}</div>
    </section>
    {selected ? <WashOrderDrawer key={selected.id} order={selected} close={() => { setSelected(null); const url = new URL(window.location.href); url.searchParams.delete("order"); window.history.replaceState({}, "", `${url.pathname}${url.search}`); }} onUpdated={updateSelected} refresh={loadOrders} onError={onError} /> : null}
  </>;
}

function WashOrderDrawer({ order, close, onUpdated, refresh, onError }: { order: WashOrder; close: () => void; onUpdated: (order: WashOrder) => void; refresh: () => Promise<void>; onError: (message: string) => void }) {
  const [source, setSource] = useState<RedeemSource>("wechat");
  const [redeemNote, setRedeemNote] = useState(order.redeemNote || "");
  const [operationNote, setOperationNote] = useState(order.operationNote || "");
  const [actionReason, setActionReason] = useState("");
  const [settlementYuan, setSettlementYuan] = useState(money(order.actualSettlementFen ?? order.estimatedSettlementFen ?? 0));
  const [settlementNote, setSettlementNote] = useState(order.settlementNote || "");
  const [correctionReason, setCorrectionReason] = useState("");
  const [saving, setSaving] = useState("");
  const [saved, setSaved] = useState("");
  const redeemed = orderWasRedeemed(order);
  const hasSettlement = ["settled", "adjusted"].includes(order.settlementStatus);

  const complete = async (request: Promise<WashOrder | { order: WashOrder }>, message: string) => {
    try {
      const result = await request;
      const next = "order" in result ? result.order : result;
      if (next?.id) {
        const detail = await api<WashOrder>(`/admin/wash/orders/${next.id}`).catch(() => next);
        onUpdated(normalizeOrder(detail as OrderAliases));
      }
      else await refresh();
      setSaved(message);
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving("");
    }
  };

  const redeem = () => {
    if (!orderCanRedeem(order)) return onError("只有已支付或待到店订单可以核销");
    setSaving("redeem");
    void complete(api<WashOrder>("/admin/wash/orders/redeem", {
      method: "POST",
      body: JSON.stringify({ code: sixDigitCode(order), verificationCode: sixDigitCode(order), orderId: order.id, source, operator: "admin", note: redeemNote.trim() || undefined }),
    }), "订单已人工核销");
  };

  const patchOrder = (payload: Record<string, unknown>, message: string, savingKey: string) => {
    setSaving(savingKey);
    void complete(api<WashOrder>(`/admin/wash/orders/${order.id}`, { method: "PATCH", body: JSON.stringify(payload) }), message);
  };

  const changeStatus = (status: "cancelled" | "refunded") => {
    if (actionReason.trim().length < 2) return onError("取消或退款必须填写至少两个字的原因");
    patchOrder({ action: status === "cancelled" ? "cancel" : "refund", reason: actionReason.trim(), operator: "admin", internalNote: operationNote.trim() || null }, status === "cancelled" ? "订单已取消" : "订单已登记退款", status);
  };

  const saveSettlement = () => {
    const amountFen = Math.round(Number(settlementYuan) * 100);
    if (!Number.isFinite(amountFen) || amountFen < 0) return onError("请输入有效的实际线下结算金额");
    const amountChanged = hasSettlement && amountFen !== (order.actualSettlementFen ?? 0);
    const noteChanged = hasSettlement && settlementNote.trim() !== (order.settlementNote || "");
    const isCorrection = amountChanged || noteChanged;
    if (isCorrection && correctionReason.trim().length < 2) return onError("修正已登记结算金额或备注必须填写原因");
    setSaving("settlement");
    void complete(api<{ order: WashOrder }>(`/admin/wash/orders/${order.id}/settlement`, {
      method: "PUT",
      body: JSON.stringify({
        status: "settled",
        operator: "admin",
        amountFen,
        note: settlementNote.trim() || null,
        ...(isCorrection ? { correctionReason: correctionReason.trim() } : {}),
      }),
    }), hasSettlement ? "结算记录已修正" : "线下结算已登记");
  };

  return <div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && close()}><aside className="detail-drawer wide-drawer wash-order-drawer">
    <header><div><small>洗车订单与人工履约</small><h2>{order.vehiclePlate || "待登记车辆"}</h2><p>{order.orderNumber}</p></div><button aria-label="关闭洗车订单详情" onClick={close}><X /></button></header>
    <div className="drawer-scroll">
      <section className="drawer-status wash-drawer-status"><span className={`status-pill wash-status-${order.status}`}>{orderStatusLabels[order.status]}</span><strong className="verification-code">核销码 {sixDigitCode(order)}</strong><small>{order.appointmentDate} · {order.startTime}–{order.endTime} · {washStoreName(order)} · {order.serviceMode === "valet" ? "往返代驾" : "自驾到店"}</small></section>
      {saved ? <div className="wash-success"><CheckCircle weight="fill" />{saved}</div> : null}
      <section className="detail-section"><h3>订单概要</h3><dl><div><dt>套餐</dt><dd>{washPackageName(order)}</dd></div><div><dt>车辆</dt><dd>{order.vehiclePlate} · {vehicleTypeLabels[order.vehicleType]}</dd></div><div><dt>服务方式</dt><dd>{order.serviceMode === "valet" ? "上门代驾取送（往返）" : "车主自驾到店"}</dd></div><div><dt>联系人</dt><dd>{order.contactName || "—"}　{order.contactPhone || ""}</dd></div><div><dt>实付金额</dt><dd>¥{money(order.paidFen)}</dd></div><div><dt>预计门店结算</dt><dd>{order.estimatedSettlementFen == null ? "—" : `¥${money(order.estimatedSettlementFen)}`}</dd></div></dl></section>
      {order.serviceMode === "valet" ? <section className="detail-section wash-valet-detail"><h3>代驾取送快照 <em>返程已包含</em></h3><div className="wash-valet-address"><MapPin weight="duotone" /><span><strong>{order.pickupAddress?.title || "取送地址未回传"}</strong><small>{order.pickupAddress ? `${order.pickupAddress.address}${order.pickupAddress.detail ? ` · ${order.pickupAddress.detail}` : ""}` : "请核对原始订单快照"}</small>{order.pickupAddress?.note ? <em>{order.pickupAddress.note}</em> : null}</span></div><dl><div><dt>腾讯单程路线</dt><dd>{order.oneWayDistanceKm == null ? "—" : `${order.oneWayDistanceKm} 公里`}{order.driveMinutes ? ` · 约 ${order.driveMinutes} 分钟` : ""}</dd></div><div><dt>洗车套餐费</dt><dd>¥{money(order.breakdown?.washFeeFen ?? order.washFeeFen ?? 0)}</dd></div><div><dt>取送起步价</dt><dd>¥{money(order.breakdown?.valetBaseFeeFen ?? order.valetRule?.baseFeeFen ?? 0)}</dd></div><div><dt>超程距离费</dt><dd>¥{money(order.breakdown?.valetDistanceFeeFen ?? Math.max(0, (order.valetFeeFen ?? 0) - (order.valetRule?.baseFeeFen ?? 0)))}</dd></div><div><dt>往返代驾费</dt><dd>¥{money(order.breakdown?.valetFeeFen ?? order.valetFeeFen ?? 0)}</dd></div><div><dt>订单总价</dt><dd>¥{money(order.breakdown?.totalFeeFen ?? order.totalFeeFen ?? order.serviceFeeFen ?? order.paidFen)}</dd></div></dl><p><SteeringWheel weight="duotone" />同一地址取车并送回；只按取车点到门店的真实单程驾驶路线计价，返程不重复收费。</p></section> : null}
      <section className="detail-section"><h3>运营备注</h3><div className="wash-action-form"><label><span>仅后台可见</span><textarea aria-label="洗车运营备注" value={operationNote} onChange={(event) => setOperationNote(event.target.value)} placeholder="记录用户沟通、到店异常或处理结论" /></label><button disabled={Boolean(saving)} onClick={() => patchOrder({ internalNote: operationNote.trim() || null, operator: "admin" }, "运营备注已保存", "note")}><FloppyDisk />保存备注</button></div></section>
      {orderCanRedeem(order) ? <section className="detail-section wash-redeem-section"><h3>人工核销 <em>核销后不可重复操作</em></h3><div className="wash-code-panel"><span>{order.serviceMode === "valet" ? "车辆交接验证码" : "车主到店验证码"}</span><strong>{sixDigitCode(order)}</strong></div><div className="wash-action-grid"><label><span>核销来源</span><select aria-label="核销来源" value={source} onChange={(event) => setSource(event.target.value as RedeemSource)}>{Object.entries(redeemSourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="wide"><span>核销备注</span><textarea aria-label="核销备注" value={redeemNote} onChange={(event) => setRedeemNote(event.target.value)} placeholder={order.serviceMode === "valet" ? "请记录车辆交接或门店线下核销情况" : "电话核销或异常场景请说明"} /></label><button disabled={Boolean(saving)} onClick={redeem}><CheckCircle />{saving === "redeem" ? "核销中…" : "确认核销"}</button></div></section> : null}
      {redeemed ? <section className="detail-section"><h3>核销记录</h3><dl><div><dt>核销时间</dt><dd>{order.redeemedAt ? washDateTime(order.redeemedAt) : "已核销"}</dd></div><div><dt>来源</dt><dd>{order.redeemSource ? redeemSourceLabels[order.redeemSource] : "未记录"}</dd></div><div><dt>备注</dt><dd>{order.redeemNote || "—"}</dd></div></dl></section> : null}
      {redeemed ? <section className="detail-section"><h3>{hasSettlement ? "修正线下结算" : "登记线下结算"}<em>{settlementStatusLabels[order.settlementStatus]}</em></h3><div className="wash-settlement-form"><label><span>实际线下结算金额</span><div className="money-input"><i>¥</i><input aria-label="实际线下结算金额" type="number" min="0" step="0.01" value={settlementYuan} onChange={(event) => setSettlementYuan(event.target.value)} /></div></label><label><span>结算备注</span><input aria-label="线下结算备注" value={settlementNote} onChange={(event) => setSettlementNote(event.target.value)} placeholder="对账批次、差异说明等" /></label>{hasSettlement ? <label className="wide"><span>结算修正原因</span><input aria-label="结算修正原因" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder="金额发生变化时必填" /></label> : null}<button disabled={Boolean(saving)} onClick={saveSettlement}><CurrencyCny />{saving === "settlement" ? "保存中…" : hasSettlement ? "保存结算修正" : "登记线下结算"}</button></div></section> : null}
      {!["cancelled", "refunded", "expired"].includes(order.status) ? <section className="detail-section wash-danger-zone"><h3>{order.status === "pending_payment" ? "取消或退款" : "退款处理"}</h3><label><span>处理原因</span><input aria-label="取消退款原因" value={actionReason} onChange={(event) => setActionReason(event.target.value)} placeholder="必填，至少两个字" /></label><div><button title={order.status === "pending_payment" ? "取消待支付订单" : "已支付订单只能登记退款"} disabled={Boolean(saving) || order.status !== "pending_payment"} onClick={() => changeStatus("cancelled")}><X />取消订单</button><button disabled={Boolean(saving) || order.status === "pending_payment"} onClick={() => changeStatus("refunded")}><ArrowCounterClockwise />登记退款</button></div></section> : null}
    </div>
  </aside></div>;
}

export function WashStoresPage({ onError: reportError }: { onError: (message: string) => void }) {
  const onError = useCallback((reason: unknown) => reportError(operatorErrorMessage(reason, "洗车门店操作失败，请稍后重试")), [reportError]);
  const [stores, setStores] = useState<WashStore[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<WashStore>(emptyStore());
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [dateFrom, setDateFrom] = useState(tomorrow());
  const [dateTo, setDateTo] = useState(() => plusDays(tomorrow(), 6));
  const [slots, setSlots] = useState<WashSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [batch, setBatch] = useState({ startTime: "08:00", endTime: "18:00", intervalMinutes: 60, capacity: 3 });
  const [valetRule, setValetRule] = useState<WashValetRule | null>(null);
  const [valetInherited, setValetInherited] = useState(true);
  const [valetLoading, setValetLoading] = useState(false);
  const [valetSaving, setValetSaving] = useState(false);
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSuggestions, setLocationSuggestions] = useState<LocationSuggestion[]>([]);
  const [locationSearchState, setLocationSearchState] = useState<LocationSearchState>("idle");
  const [locationSearchError, setLocationSearchError] = useState("");
  const [locationConfirmed, setLocationConfirmed] = useState(false);
  const [locationTitle, setLocationTitle] = useState("");
  const [selectedLocation, setSelectedLocation] = useState<LocationSuggestion | null>(null);
  const [imageBusy, setImageBusy] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [facilitiesText, setFacilitiesText] = useState("");
  const imageFileRef = useRef<HTMLInputElement>(null);

  const clearLocationSearch = () => {
    setLocationQuery("");
    setLocationSuggestions([]);
    setLocationSearchState("idle");
    setLocationSearchError("");
  };

  const loadStores = async () => {
    setLoading(true);
    try {
      const payload = await api<ListPayload<WashStore>>("/admin/wash/stores");
      const next = listOf(payload).map(normalizeStore);
      setStores(next);
      const selected = next.find((item) => item.id === selectedId) || next[0];
      if (!creating && selected) {
        const hasSavedLocation = hasTrustedStoreCoordinates(selected);
        setSelectedId(selected.id);
        setDraft({ ...selected });
        setLocationConfirmed(hasSavedLocation);
        setLocationTitle(hasSavedLocation ? selected.name : "");
        setSelectedLocation(null);
        setTagsText(selected.tags.join("，"));
        setFacilitiesText(selected.facilities.join("，"));
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadStores(); }, []);

  useEffect(() => {
    if (creating) return;
    const store = stores.find((item) => item.id === selectedId);
    if (store) {
      const hasSavedLocation = hasTrustedStoreCoordinates(store);
      setDraft({ ...store });
      setLocationConfirmed(hasSavedLocation);
      setLocationTitle(hasSavedLocation ? store.name : "");
      setSelectedLocation(null);
      setTagsText(store.tags.join("，"));
      setFacilitiesText(store.facilities.join("，"));
      clearLocationSearch();
    }
  }, [selectedId, stores, creating]);

  useEffect(() => {
    const query = locationQuery.trim();
    if (query.length < 2) {
      setLocationSuggestions([]);
      setLocationSearchState("idle");
      setLocationSearchError("");
      return;
    }

    const controller = new AbortController();
    setLocationSuggestions([]);
    setLocationSearchState("loading");
    setLocationSearchError("");
    const timer = window.setTimeout(async () => {
      try {
        const parameters = new URLSearchParams({ query });
        const payload = await api<ListPayload<LocationSuggestion>>(`/locations/suggestions?${parameters.toString()}`, { signal: controller.signal });
        const next = listOf(payload).filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
        setLocationSuggestions(next);
        setLocationSearchState(next.length ? "ready" : "empty");
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setLocationSuggestions([]);
        setLocationSearchState("error");
        setLocationSearchError(operatorErrorMessage(error, "地址服务暂不可用，请稍后重试"));
      }
    }, 320);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [locationQuery]);

  const loadSlots = async () => {
    if (creating || !selectedId) return setSlots([]);
    setSlotsLoading(true);
    try {
      const query = new URLSearchParams({ storeId: selectedId, dateFrom, dateTo });
      const payload = await api<ListPayload<WashSlot>>(`/admin/wash/slots?${query.toString()}`);
      setSlots(listOf(payload).map((item) => normalizeSlot(item as SlotAliases)));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSlotsLoading(false);
    }
  };

  useEffect(() => { void loadSlots(); }, [selectedId, dateFrom, dateTo, creating]);

  const loadValetRule = async () => {
    if (creating || !selectedId) {
      setValetRule(null);
      return;
    }
    setValetLoading(true);
    try {
      const payload = await api<WashValetRuleResponse>(`/admin/wash/stores/${selectedId}/valet-rule`);
      const next = normalizeWashValetRule(payload);
      setValetRule(next.rule);
      setValetInherited(next.inherited);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setValetLoading(false);
    }
  };

  useEffect(() => { void loadValetRule(); }, [selectedId, creating]);

  const beginCreate = () => {
    setCreating(true);
    setSelectedId("");
    setDraft(emptyStore());
    setSlots([]);
    setLocationConfirmed(false);
    setLocationTitle("");
    setSelectedLocation(null);
    setTagsText("");
    setFacilitiesText("");
    clearLocationSearch();
  };

  const selectLocation = (location: LocationSuggestion) => {
    setDraft((current) => ({
      ...current,
      address: location.address,
      district: location.district,
      latitude: location.latitude,
      longitude: location.longitude,
    }));
    setLocationConfirmed(true);
    setLocationTitle(location.title);
    setSelectedLocation(location);
    clearLocationSearch();
  };

  const applyStoreImages = (storeId: string, images: WashStoreImage[]) => {
    const nextImages = orderedStoreImages(images);
    const coverImageUrl = nextImages.find((image) => image.isCover)?.url ?? nextImages[0]?.url ?? null;
    const updateStore = (store: WashStore): WashStore => ({
      ...store,
      images: nextImages,
      imageCount: nextImages.length,
      coverImageUrl,
    });
    setDraft((current) => current.id === storeId ? updateStore(current) : current);
    setStores((current) => current.map((store) => store.id === storeId ? updateStore(store) : store));
  };

  const uploadStoreImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!draft.id || creating || !files.length) return;
    const availableCount = Math.max(0, 20 - draft.images.length);
    if (files.length > availableCount) return onError(`当前还可上传 ${availableCount} 张门店图片`);
    const invalid = files.find((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024);
    if (invalid) return onError("仅支持常用图片格式，单张不能超过 10 兆字节");

    const storeId = draft.id;
    let nextImages = orderedStoreImages(draft.images);
    setImageBusy("upload");
    try {
      for (const [index, file] of files.entries()) {
        const formData = new FormData();
        if (!nextImages.length && index === 0) formData.append("isCover", "true");
        formData.append("sortOrder", String(Math.max(-1, ...nextImages.map((image) => image.sortOrder)) + 1));
        formData.append("file", file, file.name);
        const created = await upload<WashStoreImage>(`/admin/wash/stores/${storeId}/images`, formData);
        nextImages = orderedStoreImages([...nextImages.filter((image) => image.id !== created.id), created]);
        applyStoreImages(storeId, nextImages);
      }
      setSaved(files.length > 1 ? `已上传 ${files.length} 张门店图片` : "门店图片已上传");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setImageBusy("");
    }
  };

  const saveStoreImageOrder = async (images: WashStoreImage[], message: string, busyKey: string) => {
    if (!draft.id || creating) return;
    const storeId = draft.id;
    setImageBusy(busyKey);
    try {
      const payload = await api<{ images: WashStoreImage[] }>(`/admin/wash/stores/${storeId}/images`, {
        method: "PUT",
        body: JSON.stringify({
          images: images.map((image, sortOrder) => ({ id: image.id, sortOrder, isCover: image.isCover })),
        }),
      });
      applyStoreImages(storeId, payload.images);
      setSaved(message);
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setImageBusy("");
    }
  };

  const setStoreCoverImage = (imageId: string) => {
    const next = orderedStoreImages(draft.images).map((image) => ({ ...image, isCover: image.id === imageId }));
    void saveStoreImageOrder(next, "门店封面已更新", `cover:${imageId}`);
  };

  const moveStoreImage = (imageId: string, direction: -1 | 1) => {
    const next = orderedStoreImages(draft.images);
    const index = next.findIndex((image) => image.id === imageId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void saveStoreImageOrder(next, "门店图片顺序已更新", `move:${imageId}`);
  };

  const removeStoreImage = async (image: WashStoreImage) => {
    if (!draft.id || creating || !window.confirm(`确认删除这张${image.isCover ? "封面" : "门店"}图片？`)) return;
    const storeId = draft.id;
    setImageBusy(`delete:${image.id}`);
    try {
      const payload = await api<{ images: WashStoreImage[] }>(`/admin/wash/stores/${storeId}/images/${image.id}`, { method: "DELETE" });
      applyStoreImages(storeId, payload.images);
      setSaved("门店图片已删除");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setImageBusy("");
    }
  };

  const saveStore = async (event: FormEvent) => {
    event.preventDefault();
    if (!locationConfirmed || !hasTrustedStoreCoordinates(draft) || ((!hasTrustedStoreCoordinates(stores.find((store) => store.id === draft.id) ?? draft) || creating) && !selectedLocation)) {
      return onError("请先搜索并选择门店位置，系统会自动填写地址与坐标");
    }
    setSaving(true);
    try {
      const payload = {
        id: creating ? undefined : draft.id,
        name: draft.name,
        district: draft.district,
        address: draft.address,
        latitude: draft.latitude,
        longitude: draft.longitude,
        phone: draft.phone,
        coverImageUrl: draft.coverImageUrl?.replace("/api/admin/wash/store-images/", "/api/wash/store-images/") ?? null,
        description: draft.description,
        tags: draft.tags,
        facilities: draft.facilities,
        openHours: draft.openHours,
        weeklySchedule: draft.weeklySchedule,
        businessHoursNotice: draft.businessHoursNotice ?? draft.notice,
        advanceBookingDays: draft.advanceBookingDays,
        rating: draft.rating,
        reviewCount: draft.reviewCount,
        dataKind: draft.dataKind,
        isActive: draft.isActive && draft.isOpen,
        isOpen: draft.isOpen,
        notice: draft.businessHoursNotice ?? draft.notice,
        sortPriority: draft.sortPriority,
        internalContact: draft.internalContact,
        ...(selectedLocation ? { location: selectedLocation } : {}),
      };
      const response = await api<WashStore>(creating ? "/admin/wash/stores" : `/admin/wash/stores/${draft.id}`, {
        method: creating ? "POST" : "PUT",
        body: JSON.stringify(payload),
      });
      const next = normalizeStore(response);
      setCreating(false);
      setSelectedId(next.id);
      setDraft(next);
      setTagsText(next.tags.join("，"));
      setFacilitiesText(next.facilities.join("，"));
      setSaved(creating ? "洗车门店已创建" : "洗车门店已保存");
      await loadStores();
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeStore = async () => {
    if (creating || !draft.id) return;
    if (!window.confirm(`确认删除“${draft.name}”？已有订单时服务端应拒绝删除。`)) return;
    try {
      await api(`/admin/wash/stores/${draft.id}`, { method: "DELETE" });
      setSelectedId("");
      setCreating(false);
      await loadStores();
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const generateSlots = async () => {
    if (!selectedId || creating) return;
    if (dateFrom > dateTo) return onError("批量生成的结束日期不能早于开始日期");
    if (batch.startTime >= batch.endTime) return onError("结束时间必须晚于开始时间");
    try {
      await api("/admin/wash/slots/batch", {
        method: "POST",
        body: JSON.stringify({ storeId: selectedId, dateFrom, dateTo, startTime: batch.startTime, endTime: batch.endTime, slotMinutes: batch.intervalMinutes, intervalMinutes: batch.intervalMinutes, capacity: batch.capacity }),
      });
      setSaved("预约时段已批量生成");
      await loadSlots();
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const saveValetRule = async () => {
    if (!selectedId || !valetRule) return;
    if (valetRule.baseFeeFen < 0 || valetRule.includedKm < 0 || valetRule.perKmFen < 0 || (valetRule.maxRadiusKm != null && valetRule.maxRadiusKm <= 0)) {
      return onError("请填写有效的代驾取送计价规则");
    }
    setValetSaving(true);
    try {
      const payload = await api<WashValetRuleResponse>(`/admin/wash/stores/${selectedId}/valet-rule`, {
        method: "PUT",
        body: JSON.stringify({
          baseFeeFen: valetRule.baseFeeFen,
          includedKm: valetRule.includedKm,
          perKmFen: valetRule.perKmFen,
          maxRadiusKm: valetRule.maxRadiusKm,
        }),
      });
      const next = normalizeWashValetRule(payload);
      setValetRule(next.rule);
      setValetInherited(next.inherited);
      setSaved("洗车门店代驾规则已保存");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setValetSaving(false);
    }
  };

  const restoreValetRule = async () => {
    if (!selectedId || valetInherited) return;
    setValetSaving(true);
    try {
      const payload = await api<WashValetRuleResponse>(`/admin/wash/stores/${selectedId}/valet-rule`, { method: "DELETE" });
      const next = normalizeWashValetRule(payload);
      setValetRule(next.rule);
      setValetInherited(next.inherited);
      setSaved("已恢复继承全局代驾规则");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setValetSaving(false);
    }
  };

  const saveSlot = async (slot: WashSlot) => {
    if (slot.capacity < slot.bookedCount) return onError("时段容量不能小于已预约数量");
    try {
      const response = await api<WashSlot>(`/admin/wash/slots/${slot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ capacity: slot.capacity, isOpen: !slot.isClosed }),
      });
      const next = normalizeSlot(response as SlotAliases);
      setSlots((current) => current.map((item) => item.id === slot.id ? next : item));
      setSaved(slot.isClosed ? "时段已关闭" : "时段容量已保存");
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    }
  };

  if (loading && !stores.length && !creating) return <div className="content-card empty-table">正在读取洗车门店…</div>;

  const update = <K extends keyof WashStore>(key: K, value: WashStore[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateAvailability = (value: boolean) => setDraft((current) => ({ ...current, isActive: value, isOpen: value }));

  return <div className="station-layout wash-store-layout"><section className="station-list wash-entity-list"><header><div><small>共 {stores.length} 个门店</small><h2>洗车门店</h2></div><button className="icon-action" onClick={beginCreate}><Plus />新增</button></header>{stores.map((store) => <button key={store.id} className={!creating && store.id === draft.id ? "active" : ""} onClick={() => { setCreating(false); setSelectedId(store.id); }}><span className={`station-icon ${store.coverImageUrl ? "has-image" : ""}`}>{store.coverImageUrl ? <img src={store.coverImageUrl} alt="" /> : <Buildings />}</span><span><strong>{store.name}</strong><small>{store.isActive ? "开放预约" : "暂停预约"} · {store.imageCount} 张图</small></span><CaretRight /></button>)}</section>
    <form className="station-editor wash-store-editor" onSubmit={saveStore}><header><div><small>{creating ? "创建洗车门店" : "洗车门店配置"}</small><h2>{creating ? "新增洗车门店" : draft.name}</h2></div><div className="header-switches"><label className="switch"><input type="checkbox" checked={draft.isActive && draft.isOpen} onChange={(event) => updateAvailability(event.target.checked)} /><span />{draft.isActive && draft.isOpen ? "开放预约" : "暂停预约"}</label></div></header>
      <div className="form-grid">
        <label><span>门店名称</span><input aria-label="洗车门店名称" required value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
        <label><span>客服电话（车主端展示）</span><input aria-label="洗车门店联系电话" value={draft.phone || ""} onChange={(event) => update("phone", event.target.value || null)} placeholder="022-12345678" /></label>
        <section className="wash-store-location" aria-labelledby="wash-store-location-title">
          <header>
            <div><span id="wash-store-location-title">门店位置</span><small>{creating ? "不用查询经纬度，搜索并选择实际门店即可" : "当前位置会保留；需要搬迁时重新搜索并选择"}</small></div>
            {locationConfirmed ? <em><CheckCircle weight="fill" />{creating ? "已完成定位" : "已保存位置"}</em> : <em className="pending"><MapPin />等待选点</em>}
          </header>
          <div className={`wash-location-search ${locationSearchState === "error" ? "has-error" : ""}`}>
            <MagnifyingGlass aria-hidden="true" />
            <input
              aria-label="搜索洗车门店位置"
              autoComplete="off"
              type="search"
              value={locationQuery}
              onChange={(event) => setLocationQuery(event.target.value)}
              placeholder={locationConfirmed ? "输入门店、道路或商场名称重新定位" : "输入门店、道路或商场名称（至少 2 个字）"}
            />
            {locationSearchState === "loading" ? <CircleNotch className="location-spinner" aria-label="正在搜索门店位置" /> : null}
            {locationQuery ? <button type="button" aria-label="清除门店地址搜索" onClick={clearLocationSearch}><X /></button> : null}
          </div>
          <div className="wash-location-feedback" aria-live="polite">
            {locationSearchState === "idle" && locationQuery.trim().length === 1 ? <span>请再输入至少 1 个字</span> : null}
            {locationSearchState === "loading" ? <span>正在从地图服务查找匹配位置…</span> : null}
            {locationSearchState === "empty" ? <span>没有找到匹配位置，请换用道路、商场或完整门店名称</span> : null}
            {locationSearchState === "error" ? <span className="error"><WarningCircle weight="fill" />{locationSearchError}</span> : null}
          </div>
          {locationSuggestions.length ? <div className="wash-location-suggestions" role="listbox" aria-label="门店位置候选">
            {locationSuggestions.map((location) => <button key={location.poiId} type="button" role="option" aria-selected="false" onClick={() => selectLocation(location)}>
              <MapPin weight="duotone" />
              <span><strong>{location.title}</strong><small>{location.address}</small></span>
              <em>{location.district}{location.source === "demo" ? " · 演示" : ""}</em>
            </button>)}
          </div> : null}
          {locationConfirmed && draft.address ? <div className="wash-location-selected">
            <span className="location-pin"><MapPin weight="fill" /></span>
            <div><small>当前用于距离计算与导航的位置</small><strong>{locationTitle || draft.name || "已选择门店位置"}</strong><p>{draft.address}</p></div>
            <span className="location-district">{draft.district}</span>
          </div> : <div className="wash-location-placeholder"><MapPin /><span><strong>{creating ? "尚未选择门店位置" : "已保存位置不可用"}</strong><small>{creating ? "保存前必须从搜索结果中选择，坐标将由系统自动写入" : "旧数据缺少可信地址或合法坐标，请重新搜索并选择门店位置后再保存"}</small></span></div>}
          {locationConfirmed ? <div className="wash-location-coordinates">
            <label><span>所属区（自动识别）</span><input aria-label="洗车门店所属区" readOnly value={draft.district} /></label>
            <label><span>地图地址（自动回填）</span><input aria-label="洗车门店详细地址" readOnly value={draft.address} /></label>
            <label><span>纬度（系统生成）</span><input aria-label="洗车门店纬度" readOnly value={draft.latitude.toFixed(6)} /></label>
            <label><span>经度（系统生成）</span><input aria-label="洗车门店经度" readOnly value={draft.longitude.toFixed(6)} /></label>
          </div> : null}
        </section>
        <label><span>营业时间摘要</span><input aria-label="洗车门店营业时间" required value={draft.openHours} onChange={(event) => update("openHours", event.target.value)} placeholder="周一至周日 08:00-18:00" /></label>
        <label><span>可提前预约天数</span><input aria-label="洗车门店提前预约天数" type="number" min="1" max="60" value={draft.advanceBookingDays} onChange={(event) => update("advanceBookingDays", Number(event.target.value))} /></label>
      </div>
      <section className="wash-store-detail-manager" aria-labelledby="wash-store-detail-title">
        <header><div><small>车主端展示信息</small><h3 id="wash-store-detail-title">车主端展示详情</h3><p>这些内容会出现在洗车门店列表和详情页，建议保持简洁、真实、可核对。</p></div><span>{draft.description && draft.tags.length ? "资料较完整" : "待完善资料"}</span></header>
        <div className="form-grid wash-store-detail-fields">
          <label className="wide"><span>门店介绍</span><textarea aria-label="洗车门店简介" maxLength={1000} value={draft.description} onChange={(event) => update("description", event.target.value)} placeholder="例如：商场地库内的精细化洗护门店，支持预约到店与往返代驾取送。" /><small>{draft.description.length}/1000</small></label>
          <label><span>服务亮点 / 标签</span><input aria-label="洗车门店服务标签" value={tagsText} onChange={(event) => { setTagsText(event.target.value); update("tags", splitItems(event.target.value).slice(0, 12)); }} placeholder="精细洗护，商场停车，夜间营业" /><small>用逗号分隔，最多 12 项</small></label>
          <label><span>门店设施</span><input aria-label="洗车门店设施" value={facilitiesText} onChange={(event) => { setFacilitiesText(event.target.value); update("facilities", splitItems(event.target.value).slice(0, 12)); }} placeholder="休息区，卫生间，充电桩" /><small>只填写车主实际可使用的设施</small></label>
          <label className="wide"><span>到店与营业提示</span><textarea aria-label="洗车门店运营提示" maxLength={300} value={draft.businessHoursNotice || draft.notice || ""} onChange={(event) => { const value = event.target.value || null; setDraft((current) => ({ ...current, businessHoursNotice: value, notice: value })); }} placeholder="例如：由商场东门进入地下二层，节假日营业时间可能调整。" /><small>用于入口、楼层、停车位及临时营业提醒</small></label>
          <div className="wash-store-demo-rating">
            <div><WarningCircle weight="fill" /><span><strong>仅演示数据</strong><small>当前未接入真实评价系统；车主端会明确标注“演示评价”，请勿填写成真实用户口碑。</small></span></div>
            <label><span>演示评分（0–5）</span><input aria-label="洗车门店演示评分" type="number" min="0" max="5" step="0.1" value={draft.rating} onChange={(event) => update("rating", Math.min(5, Math.max(0, Number(event.target.value))))} /></label>
            <label><span>演示评价数</span><input aria-label="洗车门店演示评价数" type="number" min="0" step="1" value={draft.reviewCount} onChange={(event) => update("reviewCount", Math.max(0, Math.trunc(Number(event.target.value))))} /></label>
          </div>
          <label><span>后台排序权重</span><input aria-label="洗车门店排序权重" type="number" value={draft.sortPriority} onChange={(event) => update("sortPriority", Number(event.target.value))} /><small>仅影响门店推荐的运营排序</small></label>
        </div>
      </section>
      <section className="wash-store-media-manager" aria-labelledby="wash-store-media-title">
        <header><div><small>门店相册</small><h3 id="wash-store-media-title">封面与门店相册</h3><p>封面用于门店列表；相册用于展示环境、工位、休息区等真实信息。</p></div><div className="wash-store-media-actions"><span>{creating ? "创建后可上传" : `${draft.images.length}/20 张`}</span><input ref={imageFileRef} aria-label="上传洗车门店图片" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void uploadStoreImages(event)} /><button type="button" disabled={creating || Boolean(imageBusy) || draft.images.length >= 20} onClick={() => imageFileRef.current?.click()}><UploadSimple />{imageBusy === "upload" ? "上传中…" : "上传图片"}</button></div></header>
        {creating ? <div className="wash-store-media-empty compact"><ImageSquare /><span><strong>先保存门店基础资料</strong><small>门店创建成功后即可上传图片，首张会自动成为封面。</small></span></div> : draft.images.length ? <div className="wash-store-image-grid">{orderedStoreImages(draft.images).map((image, index, images) => <article key={image.id} className={image.isCover ? "cover" : ""}>
          <div className="wash-store-image-preview"><img src={image.url} alt={`${draft.name}门店图片 ${index + 1}`} />{image.isCover ? <span><Star weight="fill" />封面</span> : null}</div>
          <div className="wash-store-image-meta"><strong>{index + 1}. {image.width} × {image.height}</strong><small>{storeImageSize(image.sizeBytes)} · 已压缩为通用图片格式</small></div>
          <div className="wash-store-image-controls">
            <button type="button" aria-label={`门店图片 ${index + 1} 上移`} title="上移" disabled={Boolean(imageBusy) || index === 0} onClick={() => moveStoreImage(image.id, -1)}><ArrowUp /></button>
            <button type="button" aria-label={`门店图片 ${index + 1} 下移`} title="下移" disabled={Boolean(imageBusy) || index === images.length - 1} onClick={() => moveStoreImage(image.id, 1)}><ArrowDown /></button>
            <button type="button" className="cover-action" disabled={Boolean(imageBusy) || image.isCover} onClick={() => setStoreCoverImage(image.id)}>{image.isCover ? "当前封面" : "设为封面"}</button>
            <button type="button" className="delete-action" aria-label={`删除门店图片 ${index + 1}`} title="删除图片" disabled={Boolean(imageBusy)} onClick={() => void removeStoreImage(image)}><Trash /></button>
          </div>
        </article>)}</div> : draft.coverImageUrl ? <div className="wash-store-legacy-cover"><img src={draft.coverImageUrl} alt={`${draft.name}历史封面`} /><span><strong>历史封面（只读兼容）</strong><small>上传第一张相册图片后，将由相册统一管理封面与排序。</small></span><button type="button" disabled={Boolean(imageBusy)} onClick={() => imageFileRef.current?.click()}><UploadSimple />迁移到相册</button></div> : <div className="wash-store-media-empty"><ImageSquare /><span><strong>还没有门店图片</strong><small>建议上传 3–6 张横向实拍图，优先展示门头、洗车工位与等候环境。</small></span><button type="button" disabled={Boolean(imageBusy)} onClick={() => imageFileRef.current?.click()}><UploadSimple />选择图片</button></div>}
        <p className="wash-store-media-note"><WarningCircle />支持常用图片格式，单张不超过 10 兆字节；系统会自动校正方向并压缩保存，最多 20 张。</p>
      </section>
      {!creating ? <section className="wash-valet-rule-manager"><header><div><small>代驾往返取送</small><h3>洗车代驾取送计价</h3><p>同一地址取车并送回；只按到门店的腾讯真实单程路线计价。</p></div><span className={valetInherited ? "inherit-pill" : "override-pill"}>{valetInherited ? "继承全局规则" : "门店独立规则"}</span></header>{valetLoading || !valetRule ? <p className="muted">正在读取代驾计价规则…</p> : <><div className="rule-fields wash-valet-rule-fields"><label><span>往返起步价</span><div><i>¥</i><input aria-label="洗车代驾往返起步价" type="number" min="0" step="1" value={money(valetRule.baseFeeFen)} onChange={(event) => setValetRule({ ...valetRule, baseFeeFen: Math.round(Number(event.target.value) * 100) })} /></div><small>已经包含送回，不另收返程费</small></label><label><span>包含单程里程</span><div><input aria-label="洗车代驾包含里程" type="number" min="0" step="0.1" value={valetRule.includedKm} onChange={(event) => setValetRule({ ...valetRule, includedKm: Number(event.target.value) })} /><i>公里</i></div><small>取车点到洗车门店</small></label><label><span>超出单价</span><div><i>¥</i><input aria-label="洗车代驾超程单价" type="number" min="0" step="1" value={money(valetRule.perKmFen)} onChange={(event) => setValetRule({ ...valetRule, perKmFen: Math.round(Number(event.target.value) * 100) })} /></div><small>超出部分按整公里向上取整</small></label><label><span>最大服务距离</span><label className="inline-check"><input aria-label="洗车代驾不限服务距离" type="checkbox" checked={valetRule.maxRadiusKm == null} onChange={(event) => setValetRule({ ...valetRule, maxRadiusKm: event.target.checked ? null : 20 })} />不限制距离</label><div><input aria-label="洗车代驾最大服务距离" disabled={valetRule.maxRadiusKm == null} type="number" min="1" step="1" value={valetRule.maxRadiusKm ?? ""} onChange={(event) => setValetRule({ ...valetRule, maxRadiusKm: Number(event.target.value) })} /><i>公里</i></div><small>仍须腾讯真实驾车路线可用</small></label></div><div className="wash-valet-rule-actions"><code>往返代驾费 = 起步价 ¥{money(valetRule.baseFeeFen)} + 向上取整（单程距离 − 包含里程 {valetRule.includedKm} 公里，最低按 0 计算）× 超出单价 ¥{money(valetRule.perKmFen)}</code><span>{!valetInherited ? <button type="button" className="text-button" disabled={valetSaving} onClick={() => void restoreValetRule()}><ArrowCounterClockwise />恢复继承</button> : null}<button type="button" disabled={valetSaving} onClick={() => void saveValetRule()}><SteeringWheel />{valetSaving ? "保存中…" : valetInherited ? "创建门店覆盖" : "保存计价规则"}</button></span></div></>}</section> : null}
      {!creating ? <section className="wash-slot-manager"><header><div><small>预约容量</small><h3>预约时段与容量</h3></div><div className="date-range"><label><span>开始日期</span><input aria-label="洗车时段开始日期" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label><span>结束日期</span><input aria-label="洗车时段结束日期" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div></header><div className="wash-slot-batch"><label><span>每日开始</span><input aria-label="批量时段每日开始" type="time" value={batch.startTime} onChange={(event) => setBatch((current) => ({ ...current, startTime: event.target.value }))} /></label><label><span>每日结束</span><input aria-label="批量时段每日结束" type="time" value={batch.endTime} onChange={(event) => setBatch((current) => ({ ...current, endTime: event.target.value }))} /></label><label><span>每段分钟</span><input aria-label="批量时段分钟" type="number" min="15" step="15" value={batch.intervalMinutes} onChange={(event) => setBatch((current) => ({ ...current, intervalMinutes: Number(event.target.value) }))} /></label><label><span>每段容量</span><input aria-label="批量时段容量" type="number" min="1" max="99" value={batch.capacity} onChange={(event) => setBatch((current) => ({ ...current, capacity: Number(event.target.value) }))} /></label><button type="button" onClick={() => void generateSlots()}><Plus />批量生成</button></div>
        {slotsLoading ? <p className="muted">正在读取预约时段…</p> : slots.length ? <div className="wash-slot-list">{slots.map((slot) => <article key={slot.id} className={slot.isClosed ? "closed" : ""}><span><strong>{slot.date}</strong><small>{slot.startTime}–{slot.endTime}</small></span><span><strong>已约 {slot.bookedCount}</strong><small>剩余 {slot.isClosed ? 0 : Math.max(0, slot.capacity - slot.bookedCount)}</small></span><label><small>容量</small><input aria-label={`${slot.date} ${slot.startTime}容量`} type="number" min={slot.bookedCount} max="99" value={slot.capacity} onChange={(event) => setSlots((current) => current.map((item) => item.id === slot.id ? { ...item, capacity: Number(event.target.value) } : item))} /></label><label className="slot-close-check"><input aria-label={`${slot.date} ${slot.startTime}关闭时段`} type="checkbox" checked={slot.isClosed} onChange={(event) => setSlots((current) => current.map((item) => item.id === slot.id ? { ...item, isClosed: event.target.checked } : item))} /><span>{slot.isClosed ? "已关闭" : "开放"}</span></label><button type="button" onClick={() => void saveSlot(slot)}><FloppyDisk />保存</button></article>)}</div> : <p className="muted">当前日期范围内没有时段，可按上方规则批量生成。</p>}
      </section> : null}
      <footer>{!creating ? <button type="button" className="danger-button" disabled={Boolean(imageBusy)} onClick={() => void removeStore()}><Trash />删除门店</button> : <span />}{saved ? <span><CheckCircle weight="fill" />{saved}</span> : <span className="muted">暂停预约会隐藏门店入口，但保留配置与历史订单</span>}<button type="submit" disabled={saving || Boolean(imageBusy)}><FloppyDisk />{saving ? "保存中…" : creating ? "创建门店" : "保存门店"}</button></footer>
    </form></div>;
}

export function WashCatalogPage({ onError: reportError }: { onError: (message: string) => void }) {
  const onError = useCallback((reason: unknown) => reportError(operatorErrorMessage(reason, "洗车套餐操作失败，请稍后重试")), [reportError]);
  const [stores, setStores] = useState<WashStore[]>([]);
  const [packages, setPackages] = useState<WashPackage[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<WashPackage>(emptyPackage());
  const [includedText, setIncludedText] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [storeId, setStoreId] = useState("");
  const [offers, setOffers] = useState<WashOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const offersRequestId = useRef(0);
  const currentStoreId = useRef(storeId);
  currentStoreId.current = storeId;

  const loadReference = async () => {
    try {
      const [storePayload, packagePayload] = await Promise.all([
        api<ListPayload<WashStore>>("/admin/wash/stores"),
        api<ListPayload<WashPackage>>("/admin/wash/packages"),
      ]);
      const nextStores = listOf(storePayload);
      const nextPackages = listOf(packagePayload).map((item) => normalizePackage(item as PackageAliases));
      setStores(nextStores);
      setPackages(nextPackages);
      setStoreId((current) => current || nextStores[0]?.id || "");
      if (!creating) {
        const selected = nextPackages.find((item) => item.id === selectedId) || nextPackages[0];
        if (selected) {
          setSelectedId(selected.id);
          setDraft({ ...selected, includedItems: [...selected.includedItems] });
          setIncludedText(selected.includedItems.join("，"));
        }
      }
    } catch (error) {
      onError((error as Error).message);
    }
  };

  useEffect(() => { void loadReference(); }, []);

  useEffect(() => {
    if (creating) return;
    const selected = packages.find((item) => item.id === selectedId);
    if (!selected) return;
    setDraft({ ...selected, includedItems: [...selected.includedItems] });
    setIncludedText(selected.includedItems.join("，"));
  }, [selectedId, packages, creating]);

  useEffect(() => {
    const requestId = ++offersRequestId.current;
    let cancelled = false;
    setOffers([]);
    if (!storeId) {
      setOffersLoading(false);
      return () => { cancelled = true; };
    }

    setOffersLoading(true);
    void (async () => {
      try {
        const payload = await api<ListPayload<OfferAliases>>(`/admin/wash/stores/${storeId}/offers`);
        if (cancelled || requestId !== offersRequestId.current) return;
        setOffers(normalizeOffers(listOf(payload)));
      } catch (error) {
        if (!cancelled && requestId === offersRequestId.current) onError((error as Error).message);
      } finally {
        if (!cancelled && requestId === offersRequestId.current) setOffersLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [storeId, packages.length]);

  const beginCreate = () => {
    setCreating(true);
    setSelectedId("");
    setDraft(emptyPackage());
    setIncludedText("");
  };

  const savePackage = async (event: FormEvent) => {
    event.preventDefault();
    const includedItems = splitItems(includedText);
    if (!includedItems.length) return onError("套餐至少需要一个包含项");
    setSaving(true);
    try {
      const response = await api<WashPackage>(creating ? "/admin/wash/packages" : `/admin/wash/packages/${draft.id}`, {
        method: creating ? "POST" : "PUT",
        body: JSON.stringify({ ...draft, id: creating ? undefined : draft.id, includedItems, shortDescription: draft.description, serviceItems: includedItems }),
      });
      const next = normalizePackage(response as PackageAliases);
      setCreating(false);
      setSelectedId(next.id);
      setDraft(next);
      setIncludedText(next.includedItems.join("，"));
      setSaved(creating ? "洗车套餐已创建" : "洗车套餐已保存");
      await loadReference();
      window.setTimeout(() => setSaved(""), 2200);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removePackage = async () => {
    if (creating || !draft.id) return;
    if (!window.confirm(`确认删除“${draft.name}”？已有订单时服务端应拒绝删除。`)) return;
    try {
      await api(`/admin/wash/packages/${draft.id}`, { method: "DELETE" });
      setSelectedId("");
      setCreating(false);
      await loadReference();
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const getOffer = (packageId: string, vehicleType: VehicleType): WashOffer => offers.find((item) => item.packageId === packageId && item.vehicleType === vehicleType) || {
    storeId,
    packageId,
    vehicleType,
    salePriceFen: 0,
    estimatedSettlementFen: 0,
    isActive: false,
  };

  const updateOffer = (packageId: string, vehicleType: VehicleType, patch: Partial<WashOffer>) => {
    setOffers((current) => {
      const index = current.findIndex((item) => item.packageId === packageId && item.vehicleType === vehicleType);
      const existing = current[index] || { storeId, packageId, vehicleType, salePriceFen: 0, estimatedSettlementFen: 0, isActive: false };
      const next = { ...existing, ...patch };
      if (index < 0) return [...current, next];
      return current.map((item, itemIndex) => itemIndex === index ? next : item);
    });
  };

  const saveOffers = async () => {
    if (!storeId) return onError("请先选择洗车门店");
    const targetStoreId = storeId;
    const targetRequestId = offersRequestId.current;
    const matrix = packages.flatMap((item) => vehicleTypes.map((vehicleType) => {
      const offer = getOffer(item.id, vehicleType);
      return { ...offer, vehicleCategory: vehicleType, isAvailable: offer.isActive };
    }));
    if (matrix.some((item) => item.isActive && item.estimatedSettlementFen > item.salePriceFen)) return onError("启用中的预计结算价不能高于销售价");
    setSaving(true);
    try {
      const payload = await api<ListPayload<OfferAliases>>(`/admin/wash/stores/${targetStoreId}/offers`, { method: "PUT", body: JSON.stringify({ offers: matrix }) });
      if (currentStoreId.current === targetStoreId && offersRequestId.current === targetRequestId) {
        setOffers(normalizeOffers(listOf(payload)));
        setSaved("门店套餐价格矩阵已保存");
        window.setTimeout(() => setSaved(""), 2200);
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return <>
    <div className="station-layout wash-catalog-layout"><section className="station-list wash-entity-list"><header><div><small>共 {packages.length} 个套餐</small><h2>洗车套餐</h2></div><button className="icon-action" onClick={beginCreate}><Plus />新增</button></header>{packages.map((item) => <button key={item.id} className={!creating && item.id === draft.id ? "active" : ""} onClick={() => { setCreating(false); setSelectedId(item.id); }}><span className="station-icon"><ListChecks /></span><span><strong>{item.name}</strong><small>{item.isActive ? "已启用" : "已停用"} · 约 {item.durationMinutes} 分钟</small></span><CaretRight /></button>)}</section>
      <form className="station-editor wash-package-editor" onSubmit={savePackage}><header><div><small>{creating ? "创建洗车套餐" : "洗车套餐"}</small><h2>{creating ? "新增洗车套餐" : draft.name}</h2></div><label className="switch"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /><span />{draft.isActive ? "已启用" : "已停用"}</label></header><div className="form-grid"><label><span>套餐名称</span><input aria-label="洗车套餐名称" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>系统识别码</span><input aria-label="洗车套餐系统识别码" required pattern="[a-z0-9][a-z0-9_-]+" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toLowerCase() })} /><small>用于系统区分套餐，创建后请勿随意修改</small></label><label className="wide"><span>一句话说明</span><input aria-label="洗车套餐说明" required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="车主端用于快速理解套餐差异" /></label><label className="wide"><span>包含项</span><textarea aria-label="洗车套餐包含项" required value={includedText} onChange={(event) => setIncludedText(event.target.value)} placeholder="预冲洗，车身泡沫清洁，轮毂清洁，擦干（逗号或换行分隔）" /></label><label><span>预计时长（分钟）</span><input aria-label="洗车套餐时长" type="number" min="5" max="480" value={draft.durationMinutes} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })} /></label><label><span>排序权重</span><input aria-label="洗车套餐排序" type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) })} /></label></div><footer>{!creating ? <button type="button" className="danger-button" onClick={() => void removePackage()}><Trash />删除套餐</button> : <span />}{saved ? <span><CheckCircle weight="fill" />{saved}</span> : <span className="muted">历史订单保留原套餐与价格快照</span>}<button type="submit" disabled={saving}><FloppyDisk />{saving ? "保存中…" : creating ? "创建套餐" : "保存套餐"}</button></footer></form>
    </div>
    <section className="content-card wash-price-card"><header><div><small>门店、套餐与车型</small><h2>门店套餐价格矩阵</h2><p>分别维护车主销售价格与平台内部预计结算价格。</p></div><label><span>配置门店</span><select aria-label="价格矩阵门店" value={storeId} disabled={saving} onChange={(event) => { currentStoreId.current = event.target.value; setStoreId(event.target.value); }}><option value="">请选择门店</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label></header>
      <aside id="wash-price-visibility-note" className="wash-price-guidance" role="note" aria-label="销售价与预计结算价说明">
        <div className="owner-facing"><span><CurrencyCny weight="duotone" /></span><div><strong>销售价 · 车主可见</strong><p>会展示在小程序，并作为洗车服务报价和车主应付金额的基础；代驾订单另加取送费。</p></div></div>
        <div className="internal-only"><span><Receipt weight="duotone" /></span><div><strong>预计结算价 · 仅平台内部</strong><p>只用于平台与门店的内部对账参考，车主页面不展示，也不会改变车主报价或应付金额。</p></div></div>
      </aside>
      {offersLoading ? <div className="empty-table">正在读取门店价格…</div> : <div className="table-wrap wash-price-table"><table><thead><tr><th>套餐</th>{vehicleTypes.map((vehicleType) => <th key={vehicleType}>{vehicleTypeLabels[vehicleType]}销售价 / 预计结算价</th>)}</tr></thead><tbody>{packages.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.durationMinutes} 分钟 · {item.isActive ? "套餐启用" : "套餐停用"}</small></td>{vehicleTypes.map((vehicleType) => { const offer = getOffer(item.id, vehicleType); return <td key={`${item.id}:${vehicleType}`}><div className={`wash-offer-cell ${offer.isActive ? "active" : ""}`}><label className="offer-switch"><input aria-label={`${item.name}${vehicleTypeLabels[vehicleType]}启用价格`} type="checkbox" checked={offer.isActive} onChange={(event) => updateOffer(item.id, vehicleType, { isActive: event.target.checked })} /><span>{offer.isActive ? "售卖" : "关闭"}</span></label><label><small className="wash-price-field-label owner-facing">销售价 <em>车主可见</em></small><span><i>¥</i><input aria-label={`${item.name}${vehicleTypeLabels[vehicleType]}销售价`} aria-describedby="wash-price-visibility-note" disabled={!offer.isActive} type="number" min="0" step="0.01" value={money(offer.salePriceFen)} onChange={(event) => updateOffer(item.id, vehicleType, { salePriceFen: Math.round(Number(event.target.value) * 100) })} /></span></label><label><small className="wash-price-field-label internal-only">预计结算价 <em>仅内部</em></small><span><i>¥</i><input aria-label={`${item.name}${vehicleTypeLabels[vehicleType]}预计结算价`} aria-describedby="wash-price-visibility-note" disabled={!offer.isActive} type="number" min="0" step="0.01" value={money(offer.estimatedSettlementFen)} onChange={(event) => updateOffer(item.id, vehicleType, { estimatedSettlementFen: Math.round(Number(event.target.value) * 100) })} /></span></label></div></td>; })}</tr>)}</tbody></table></div>}
      <footer>{saved ? <span><CheckCircle weight="fill" />{saved}</span> : <span><WarningCircle />价格调整仅影响新订单，历史订单价格快照不回写</span>}<button disabled={saving || offersLoading || !storeId} onClick={() => void saveOffers()}><FloppyDisk />{saving ? "保存中…" : offersLoading ? "读取价格中…" : "保存价格矩阵"}</button></footer>
    </section>
  </>;
}
