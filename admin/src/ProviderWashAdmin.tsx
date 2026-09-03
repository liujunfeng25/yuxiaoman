import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarCheck,
  CaretLeft,
  CaretRight,
  CheckCircle,
  CircleNotch,
  CurrencyCny,
  FloppyDisk,
  ImageSquare,
  Key,
  ListChecks,
  MagnifyingGlass,
  MapPin,
  Plus,
  Receipt,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Storefront,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, money, upload } from "./adminApi";
import { AuthenticatedEvidenceImage } from "./AuthenticatedEvidenceImage";
import { ProviderLocationMap } from "./ProviderLocationMap";

type ListPayload<T> = T[] | { items: T[]; total?: number };
function listOf<T>(payload: ListPayload<T>): T[] { return Array.isArray(payload) ? payload : payload.items; }

type ProviderOrder = {
  id: string;
  orderNumber: string;
  status: string;
  settlementStatus?: string;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  paidFen?: number;
  serviceFeeFen?: number;
  totalFeeFen?: number;
  serviceMode: "self_drive" | "valet";
  storeName?: string;
  store?: { id?: string; name?: string };
  packageName?: string;
  package?: { id?: string; name?: string };
  vehicleType?: "sedan" | "suv" | "mpv" | "suv_mpv";
  vehiclePlate?: string;
  plateNumber?: string;
  redeemedAt?: string | null;
  updatedAt?: string;
};

const orderStatusLabels: Record<string, string> = {
  pending_payment: "待支付", awaiting_redemption: "待核销", paid: "待核销", booked: "待到店", redeemed: "已核销", completed: "已完成",
  cancelled: "已取消", refunded: "已退款", expired: "已过期",
};
const vehicleLabels: Record<string, string> = { sedan: "小轿车", suv: "SUV", mpv: "MPV", suv_mpv: "SUV / MPV" };
function orderAmount(order: ProviderOrder) { return order.paidFen ?? order.totalFeeFen ?? order.serviceFeeFen ?? 0; }
function orderCanRedeem(order: ProviderOrder) { return ["awaiting_redemption", "paid", "booked"].includes(order.status) && !order.redeemedAt; }

function clearWashOrderQuery() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("order")) return;
  url.searchParams.delete("order");
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

export function ProviderWashOrdersPage({ canRedeem, onError }: { canRedeem: boolean; onError: (message: string) => void }) {
  const [orders, setOrders] = useState<ProviderOrder[]>([]);
  const [selected, setSelected] = useState<ProviderOrder | null>(null);
  const deepLinkOpenedRef = useRef("");
  const [filters, setFilters] = useState({ orderNumber: "", date: "", serviceMode: "", status: "" });
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 25;
  const [loading, setLoading] = useState(true);
  const [quickCode, setQuickCode] = useState("");
  const [quickNote, setQuickNote] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [success, setSuccess] = useState("");

  const closeSelected = () => {
    setSelected(null);
    deepLinkOpenedRef.current = "";
    clearWashOrderQuery();
  };

  const load = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    query.set("page", String(page));
    query.set("pageSize", String(pageSize));
    try {
      const payload = await api<ListPayload<ProviderOrder>>(`/admin/wash/orders?${query}`);
      const next = listOf(payload);
      setOrders(next);
      setTotal(Array.isArray(payload) ? next.length : payload.total ?? next.length);
      const requested = new URLSearchParams(window.location.search).get("order");
      if (requested && deepLinkOpenedRef.current !== requested) {
        const match = next.find((item) => item.id === requested);
        if (match) {
          deepLinkOpenedRef.current = requested;
          setSelected(match);
        }
      }
    } catch (reason) { onError((reason as Error).message); }
    finally { setLoading(false); }
  }, [filters.date, filters.orderNumber, filters.serviceMode, filters.status, onError, page]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 160); return () => window.clearTimeout(timer); }, [load]);

  const openOrder = async (order: ProviderOrder) => {
    setSelected(order);
    try { setSelected(await api<ProviderOrder>(`/admin/wash/orders/${order.id}`)); }
    catch (reason) { onError((reason as Error).message); }
  };
  const redeemCode = async (verificationCode: string, orderId?: string, note?: string) => {
    if (!canRedeem) return onError("当前账号没有核销权限");
    if (!/^\d{6}$/.test(verificationCode)) return onError("请输入车主出示的六位核销码");
    setRedeeming(true);
    try {
      await api("/admin/wash/orders/redeem", { method: "POST", body: JSON.stringify({ code: verificationCode, verificationCode, orderId, source: "other", note: note?.trim() || undefined }) });
      setQuickCode(""); setQuickNote(""); closeSelected(); setSuccess("订单已核销，核销码不会在后台中回显");
      await load(); window.setTimeout(() => setSuccess(""), 2400);
    } catch (reason) { onError((reason as Error).message); }
    finally { setRedeeming(false); }
  };
  const metrics = useMemo(() => ({
    total,
    awaiting: orders.filter(orderCanRedeem).length,
    redeemed: orders.filter((item) => Boolean(item.redeemedAt) || ["redeemed", "completed"].includes(item.status)).length,
    amount: orders.reduce((sum, order) => sum + orderAmount(order), 0),
  }), [orders, total]);

  const updateFilter = (key: keyof typeof filters, value: string) => {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return <>
    <section className="provider-redeem-bar">
      <div><span><Key weight="duotone" /></span><div><small>MANUAL REDEMPTION</small><h2>快速核销</h2><p>请当面核对车主出示的六位码；系统不会提前显示或返回核销码。</p></div></div>
      <label><span>六位核销码</span><input aria-label="服务商六位核销码" inputMode="numeric" maxLength={6} value={quickCode} onChange={(event) => setQuickCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" /></label>
      <label><span>核销备注（可选）</span><input aria-label="服务商核销备注" maxLength={200} value={quickNote} onChange={(event) => setQuickNote(event.target.value)} placeholder="例如：车辆已到店" /></label>
      <button disabled={!canRedeem || redeeming || quickCode.length !== 6} onClick={() => void redeemCode(quickCode, undefined, quickNote)}>{redeeming ? <CircleNotch className="backoffice-spinner" /> : <CheckCircle />}确认核销</button>
    </section>
    {success ? <div className="wash-success provider-page-success"><CheckCircle weight="fill" />{success}</div> : null}
    <section className="metric-strip provider-order-metrics"><div><span><Receipt /></span><small>筛选订单</small><strong>{metrics.total}<em> 笔</em></strong></div><div><span><Key /></span><small>待核销</small><strong>{metrics.awaiting}<em> 笔</em></strong></div><div><span><CheckCircle /></span><small>已核销</small><strong>{metrics.redeemed}<em> 笔</em></strong></div><div><span><CurrencyCny /></span><small>服务金额</small><strong>¥{money(metrics.amount)}</strong></div></section>
    <section className="content-card provider-order-card"><div className="filters provider-order-filters"><span><SlidersHorizontal />筛选</span><input aria-label="服务商洗车订单号" value={filters.orderNumber} onChange={(event) => updateFilter("orderNumber", event.target.value)} placeholder="订单号" /><input aria-label="服务商洗车预约日期" type="date" value={filters.date} onChange={(event) => updateFilter("date", event.target.value)} /><select aria-label="服务商洗车服务方式" value={filters.serviceMode} onChange={(event) => updateFilter("serviceMode", event.target.value)}><option value="">全部服务方式</option><option value="self_drive">自驾到店</option><option value="valet">往返代驾</option></select><select aria-label="服务商洗车订单状态" value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}><option value="">全部订单状态</option>{Object.entries(orderStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button onClick={() => { setPage(1); setFilters({ orderNumber: "", date: "", serviceMode: "", status: "" }); }}>清空</button></div>
      <div className="table-wrap"><table><thead><tr><th>订单与时段</th><th>车辆</th><th>套餐</th><th>服务方式</th><th>金额</th><th>状态</th><th /></tr></thead><tbody>{orders.map((order) => <tr key={order.id} onClick={() => void openOrder(order)}><td><strong>{order.orderNumber}</strong><small>{order.appointmentDate} {order.startTime}–{order.endTime}</small></td><td><strong>{order.vehiclePlate || order.plateNumber || "待登记"}</strong><small>{vehicleLabels[order.vehicleType || ""] || order.vehicleType || "车型待确认"}</small></td><td><strong>{order.packageName || order.package?.name || "洗车服务"}</strong></td><td><span className={`mode-pill ${order.serviceMode}`}>{order.serviceMode === "valet" ? "往返代驾" : "自驾到店"}</span></td><td><strong>¥{money(orderAmount(order))}</strong></td><td><span className={`status-pill wash-status-${order.status}`}>{orderStatusLabels[order.status] || order.status}</span></td><td><CaretRight /></td></tr>)}</tbody></table>{loading ? <div className="table-loading">正在读取本店订单…</div> : !orders.length ? <div className="empty-table">没有符合条件的本店订单</div> : null}</div>
      <footer className="backoffice-pagination"><span>共 <strong>{total}</strong> 笔本店订单</span><div><button disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><CaretLeft />上一页</button><span>第 {page} 页</span><button disabled={page * pageSize >= total || loading} onClick={() => setPage((value) => value + 1)}>下一页<CaretRight /></button></div></footer>
    </section>
    {selected ? <ProviderOrderDrawer order={selected} canRedeem={canRedeem} saving={redeeming} close={closeSelected} redeem={(code, note) => redeemCode(code, selected.id, note)} /> : null}
  </>;
}

function ProviderOrderDrawer({ order, canRedeem, saving, close, redeem }: { order: ProviderOrder; canRedeem: boolean; saving: boolean; close: () => void; redeem: (code: string, note: string) => Promise<void> | void }) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  return <div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && close()}><aside className="detail-drawer provider-order-drawer" aria-label="服务商洗车订单详情"><header><div><small>STORE ORDER</small><h2>{order.vehiclePlate || order.plateNumber || "待登记车辆"}</h2><p>{order.orderNumber}</p></div><button aria-label="关闭服务商洗车订单详情" onClick={close}><X /></button></header><div className="drawer-scroll">
    <section className="drawer-status"><span className={`status-pill wash-status-${order.status}`}>{orderStatusLabels[order.status] || order.status}</span><strong>{order.appointmentDate} · {order.startTime}–{order.endTime}</strong><small>{order.serviceMode === "valet" ? "往返代驾" : "自驾到店"} · 当前登录门店</small></section>
    <section className="detail-section"><h3>服务信息</h3><dl><div><dt>车辆</dt><dd>{order.vehiclePlate || order.plateNumber || "—"} · {vehicleLabels[order.vehicleType || ""] || order.vehicleType || "车型待确认"}</dd></div><div><dt>套餐</dt><dd>{order.packageName || order.package?.name || "洗车服务"}</dd></div><div><dt>服务方式</dt><dd>{order.serviceMode === "valet" ? "上门代驾取送（往返）" : "车主自驾到店"}</dd></div><div><dt>订单金额</dt><dd>¥{money(orderAmount(order))}</dd></div><div><dt>订单状态</dt><dd>{orderStatusLabels[order.status] || order.status}</dd></div></dl></section>
    {orderCanRedeem(order) && canRedeem ? <section className="detail-section provider-drawer-redeem"><h3>人工核销 <em>需当面输入</em></h3><p><ShieldCheck />为保护履约凭证，页面不会显示核销码。请输入车主主动出示的六位码。</p><label><span>六位核销码</span><input aria-label="订单详情六位核销码" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" /></label><label><span>备注（可选）</span><textarea aria-label="订单详情核销备注" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} /></label><button disabled={saving || code.length !== 6} onClick={() => void redeem(code, note)}><CheckCircle />{saving ? "核销中…" : "确认核销"}</button></section> : null}
    <section className="provider-data-boundary"><ShieldCheck weight="duotone" /><span><strong>最小必要信息</strong><small>本页不提供车主姓名、手机号、代驾地址、核销码或平台内部备注。</small></span></section>
  </div></aside></div>;
}

type ProviderStoreImage = { id: string; url: string; width: number; height: number; sizeBytes: number; sortOrder: number; isCover: boolean };
type WeeklySchedule = Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", Array<{ start: string; end: string }>>;
const emptyWeeklySchedule: WeeklySchedule = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
const weekDays: Array<[keyof WeeklySchedule, string]> = [["mon", "周一"], ["tue", "周二"], ["wed", "周三"], ["thu", "周四"], ["fri", "周五"], ["sat", "周六"], ["sun", "周日"]];
type ProviderStore = {
  id: string; name: string; legalName?: string | null; district: string; address: string; phone: string | null; openHours: string; latitude: number; longitude: number;
  description?: string; tags?: string[]; facilities?: string[]; businessHoursNotice?: string | null; notice?: string | null; advanceBookingDays?: number;
  weeklySchedule: WeeklySchedule;
  images?: ProviderStoreImage[]; coverImageUrl?: string | null; imageCount?: number; isActive?: boolean; isOpen?: boolean;
};
type LocationSuggestion = { poiId: string; title: string; address: string; district: string; latitude: number; longitude: number; source?: string; locationProof?: string };
function splitItems(value: string) { return value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean); }
function orderedImages(images: ProviderStoreImage[] = []) { return [...images].sort((a, b) => a.sortOrder - b.sortOrder); }
function validLocation(store: ProviderStore) { return Boolean(store.address && store.district && Number.isFinite(store.latitude) && Number.isFinite(store.longitude) && Math.abs(store.latitude) <= 90 && Math.abs(store.longitude) <= 180 && (store.latitude !== 0 || store.longitude !== 0)); }

export function ProviderWashStorePage({ subjectId, onError }: { subjectId: string; onError: (message: string) => void }) {
  const [store, setStore] = useState<ProviderStore | null>(null);
  const [draft, setDraft] = useState<ProviderStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [facilitiesText, setFacilitiesText] = useState("");
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSuggestions, setLocationSuggestions] = useState<LocationSuggestion[]>([]);
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");
  const [selectedLocation, setSelectedLocation] = useState<LocationSuggestion | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapFeedback, setMapFeedback] = useState("");
  const [mapError, setMapError] = useState("");
  const mapRequestSequence = useRef(0);
  const mapRequestController = useRef<AbortController | null>(null);
  const [imageBusy, setImageBusy] = useState("");
  const [imageFeedback, setImageFeedback] = useState<{ tone: "working" | "success" | "error"; message: string } | null>(null);

  const apply = (next: ProviderStore) => {
    const normalized = { ...next, images: orderedImages(next.images), tags: next.tags ?? [], facilities: next.facilities ?? [], advanceBookingDays: next.advanceBookingDays ?? 7, weeklySchedule: next.weeklySchedule ?? emptyWeeklySchedule };
    setStore(normalized); setDraft(normalized); setTagsText(normalized.tags.join("，")); setFacilitiesText(normalized.facilities.join("，"));
  };
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api<ListPayload<ProviderStore>>("/admin/wash/stores");
      const items = listOf(payload);
      const next = items.find((item) => item.id === subjectId);
      if (!next) throw new Error("当前账号未绑定可用洗车门店");
      apply(next);
    } catch (reason) { onError((reason as Error).message); }
    finally { setLoading(false); }
  }, [onError, subjectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const query = locationQuery.trim();
    if (query.length < 2) { setLocationSuggestions([]); setLocationBusy(false); setLocationMessage(""); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLocationBusy(true); setLocationMessage("");
      try {
        const payload = await api<ListPayload<LocationSuggestion>>(`/locations/suggestions?${new URLSearchParams({ query, kind: "wash_store" })}`, { signal: controller.signal });
        const items = listOf(payload);
        setLocationSuggestions(items);
        setLocationMessage(items.length ? "" : "没有找到匹配位置，可换关键词或使用地图扎针");
      }
      catch (reason) {
        if ((reason as Error).name !== "AbortError") {
          setLocationSuggestions([]);
          setLocationMessage(`${(reason as Error).message}；当前可信位置未改变`);
        }
      }
      finally { setLocationBusy(false); }
    }, 320);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [locationQuery]);
  const update = <K extends keyof ProviderStore>(key: K, value: ProviderStore[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const updateSchedule = (day: keyof WeeklySchedule, enabled: boolean) => setDraft((current) => current ? { ...current, weeklySchedule: { ...current.weeklySchedule, [day]: enabled ? (current.weeklySchedule[day].length ? current.weeklySchedule[day] : [{ start: "08:00", end: "18:00" }]) : [] } } : current);
  const updateScheduleTime = (day: keyof WeeklySchedule, field: "start" | "end", value: string) => setDraft((current) => {
    if (!current) return current;
    const periods = current.weeklySchedule[day];
    const first = periods[0] ?? { start: "08:00", end: "18:00" };
    return { ...current, weeklySchedule: { ...current.weeklySchedule, [day]: [{ ...first, [field]: value }, ...periods.slice(1)] } };
  });
  const selectLocation = useCallback((location: LocationSuggestion) => {
    setSelectedLocation(location);
    setDraft((current) => current ? { ...current, district: location.district, address: location.address, latitude: location.latitude, longitude: location.longitude } : current);
    setLocationQuery(""); setLocationSuggestions([]); setLocationMessage("");
  }, []);
  const resolveMapPin = useCallback(async (latitude: number, longitude: number) => {
    const requestSequence = ++mapRequestSequence.current;
    mapRequestController.current?.abort();
    const controller = new AbortController();
    mapRequestController.current = controller;
    setMapBusy(true); setMapError(""); setMapFeedback("");
    try {
      const location = await api<LocationSuggestion>("/locations/resolve", {
        method: "POST",
        body: JSON.stringify({ latitude, longitude }),
        signal: controller.signal,
      });
      if (requestSequence !== mapRequestSequence.current) return;
      selectLocation(location);
      setMapFeedback(`已定位到 ${location.title || location.address}，保存门店资料后生效`);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError" && requestSequence === mapRequestSequence.current) {
        setMapError(`${(reason as Error).message}；当前可信位置未改变`);
      }
    } finally {
      if (requestSequence === mapRequestSequence.current) {
        mapRequestController.current = null;
        setMapBusy(false);
      }
    }
  }, [selectLocation]);
  useEffect(() => {
    if (mapOpen) return;
    mapRequestSequence.current += 1;
    mapRequestController.current?.abort();
    mapRequestController.current = null;
    setMapBusy(false);
  }, [mapOpen]);
  useEffect(() => () => {
    mapRequestSequence.current += 1;
    mapRequestController.current?.abort();
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!draft || !store) return;
    if (mapRequestController.current || mapBusy) return onError("正在核验地图落点，请稍候再保存");
    if (!validLocation(draft)) return onError("请先通过地址联想或地图扎针选择可信门店位置");
    setSaving(true);
    try {
      const payload = {
        name: draft.name, legalName: draft.legalName || null, phone: draft.phone || null, openHours: draft.openHours,
        description: draft.description || "", tags: splitItems(tagsText).slice(0, 12), facilities: splitItems(facilitiesText).slice(0, 12),
        businessHoursNotice: draft.businessHoursNotice || draft.notice || null, notice: draft.businessHoursNotice || draft.notice || null, weeklySchedule: draft.weeklySchedule,
        advanceBookingDays: draft.advanceBookingDays ?? 7, isActive: Boolean(draft.isActive && draft.isOpen), isOpen: Boolean(draft.isOpen),
        ...(selectedLocation ? { location: selectedLocation } : {}),
      };
      const next = await api<ProviderStore>(`/admin/wash/stores/${store.id}`, { method: "PUT", body: JSON.stringify(payload) });
      apply(next); setSelectedLocation(null); setSaved("门店资料已保存并立即生效"); window.setTimeout(() => setSaved(""), 2200);
    } catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };
  const uploadImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (!draft || !files.length) return;
    const currentImages = orderedImages(draft.images);
    const availableCount = Math.max(0, 20 - currentImages.length);
    const showImageError = (message: string) => { setImageFeedback({ tone: "error", message }); onError(message); };
    if (files.length > availableCount) return showImageError(`当前还可上传 ${availableCount} 张门店图片`);
    const invalid = files.find((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024);
    if (invalid) return showImageError("仅支持 JPEG、PNG、WebP，且单张不能超过 10MB");
    const storeId = draft.id;
    setImageBusy("upload");
    setImageFeedback({ tone: "working", message: files.length > 1 ? `正在上传 0/${files.length} 张图片` : `正在上传 ${files[0].name}` });
    try {
      let images = currentImages;
      for (const [index, file] of files.entries()) {
        const form = new FormData();
        if (!images.length && index === 0) form.append("isCover", "true");
        form.append("sortOrder", String(Math.max(-1, ...images.map((image) => image.sortOrder)) + 1));
        form.append("file", file, file.name);
        const image = await upload<ProviderStoreImage>(`/admin/wash/stores/${storeId}/images`, form);
        images = orderedImages([...images.filter((item) => item.id !== image.id), image]);
        setDraft((current) => current?.id === storeId ? { ...current, images, imageCount: images.length, coverImageUrl: images.find((item) => item.isCover)?.url ?? images[0]?.url ?? null } : current);
        setImageFeedback({ tone: "working", message: files.length > 1 ? `正在上传 ${index + 1}/${files.length} 张图片` : "图片已上传，正在刷新预览" });
      }
      const message = files.length > 1 ? `已上传 ${files.length} 张门店图片` : "门店图片已上传";
      setSaved(message); setImageFeedback({ tone: "success", message }); window.setTimeout(() => setSaved(""), 2200);
    } catch (reason) { showImageError((reason as Error).message); }
    finally { setImageBusy(""); }
  };
  const saveImageOrder = async (images: ProviderStoreImage[], message: string) => {
    if (!draft) return; setImageBusy("order");
    try {
      const result = await api<{ images: ProviderStoreImage[] }>(`/admin/wash/stores/${draft.id}/images`, { method: "PUT", body: JSON.stringify({ images: images.map((image, sortOrder) => ({ id: image.id, sortOrder, isCover: image.isCover })) }) });
      setDraft({ ...draft, images: orderedImages(result.images), imageCount: result.images.length, coverImageUrl: result.images.find((item) => item.isCover)?.url ?? null }); setSaved(message);
    } catch (reason) { onError((reason as Error).message); }
    finally { setImageBusy(""); }
  };
  const moveImage = (id: string, direction: -1 | 1) => { if (!draft) return; const next = orderedImages(draft.images); const index = next.findIndex((item) => item.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; void saveImageOrder(next, "图片顺序已更新"); };
  const coverImage = (id: string) => { if (!draft) return; void saveImageOrder(orderedImages(draft.images).map((image) => ({ ...image, isCover: image.id === id })), "门店封面已更新"); };
  const removeImage = async (image: ProviderStoreImage) => { if (!draft || !window.confirm("确认删除这张门店图片？")) return; setImageBusy("delete"); try { const result = await api<{ images: ProviderStoreImage[] }>(`/admin/wash/stores/${draft.id}/images/${image.id}`, { method: "DELETE" }); setDraft({ ...draft, images: orderedImages(result.images), imageCount: result.images.length, coverImageUrl: result.images.find((item) => item.isCover)?.url ?? null }); setSaved("门店图片已删除"); } catch (reason) { onError((reason as Error).message); } finally { setImageBusy(""); } };

  if (loading || !draft) return <div className="content-card empty-table">正在读取本店资料…</div>;
  return <form className="content-card provider-store-editor" onSubmit={save}><header><div><small>MY WASH STORE</small><h2>{draft.name}</h2><p>资料保存后直接生效；平台排序、演示评分和账号绑定不在本页开放。</p></div><label className="switch"><input type="checkbox" checked={Boolean(draft.isActive && draft.isOpen)} onChange={(event) => { update("isActive", event.target.checked); update("isOpen", event.target.checked); }} /><span />{draft.isActive && draft.isOpen ? "开放预约" : "暂停预约"}</label></header>
    <section className="provider-store-section"><div className="provider-section-title"><span><Storefront weight="duotone" /></span><div><small>STORE IDENTITY</small><h3>门店主体与营业资料</h3></div></div><div className="form-grid"><label><span>门店名称</span><input aria-label="服务商洗车门店名称" required value={draft.name} onChange={(event) => update("name", event.target.value)} /></label><label><span>法定主体</span><input aria-label="服务商洗车门店法定主体" value={draft.legalName || ""} onChange={(event) => update("legalName", event.target.value || null)} /></label><label><span>联系电话</span><input aria-label="服务商洗车门店联系电话" value={draft.phone || ""} onChange={(event) => update("phone", event.target.value || null)} /></label><label><span>营业时间摘要</span><input aria-label="服务商洗车门店营业时间" required value={draft.openHours} onChange={(event) => update("openHours", event.target.value)} /></label><label><span>提前预约天数</span><input aria-label="服务商洗车门店提前预约天数" type="number" min="1" max="60" value={draft.advanceBookingDays ?? 7} onChange={(event) => update("advanceBookingDays", Number(event.target.value))} /></label><label className="wide"><span>门店介绍</span><textarea aria-label="服务商洗车门店介绍" maxLength={1000} value={draft.description || ""} onChange={(event) => update("description", event.target.value)} /></label><label><span>服务标签</span><input aria-label="服务商洗车门店标签" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="精细洗护，夜间营业" /></label><label><span>门店设施</span><input aria-label="服务商洗车门店设施" value={facilitiesText} onChange={(event) => setFacilitiesText(event.target.value)} placeholder="休息区，卫生间" /></label><label className="wide"><span>到店与营业提示</span><textarea aria-label="服务商洗车门店营业提示" maxLength={300} value={draft.businessHoursNotice || draft.notice || ""} onChange={(event) => update("businessHoursNotice", event.target.value || null)} /></label></div><div className="provider-weekly-schedule"><header><div><small>WEEKLY SCHEDULE</small><h4>每周营业安排</h4></div><span>完整计划随门店资料保存</span></header>{weekDays.map(([day, label]) => { const periods = draft.weeklySchedule[day]; const first = periods[0]; return <label key={day} className={first ? "active" : ""}><input aria-label={`${label}营业`} type="checkbox" checked={Boolean(first)} onChange={(event) => updateSchedule(day, event.target.checked)} /><strong>{label}</strong>{first ? <span><input aria-label={`服务商${label}开始时间`} type="time" value={first.start} onChange={(event) => updateScheduleTime(day, "start", event.target.value)} /><i>至</i><input aria-label={`服务商${label}结束时间`} type="time" value={first.end} onChange={(event) => updateScheduleTime(day, "end", event.target.value)} /></span> : <em>休息</em>}{periods.length > 1 ? <small>另有 {periods.length - 1} 个时段原样保留</small> : null}</label>; })}</div></section>
    <section className="provider-store-section">
      <div className="provider-section-title provider-location-title">
        <span><MapPin weight="duotone" /></span>
        <div><small>TRUSTED LOCATION</small><h3>门店地址与定位</h3></div>
        <div className="provider-location-actions"><small>支持联想地址与地图扎针</small><button type="button" aria-expanded={mapOpen} onClick={() => setMapOpen((value) => !value)}><MapPin weight="fill" />{mapOpen ? "收起地图" : "地图扎针"}</button></div>
      </div>
      <div className="provider-location-search"><MagnifyingGlass /><input aria-label="服务商搜索洗车门店位置" value={locationQuery} onChange={(event) => setLocationQuery(event.target.value)} placeholder="输入至少两个字，搜索并选择腾讯地图联想地址" />{locationBusy ? <CircleNotch className="backoffice-spinner" /> : locationQuery ? <button type="button" aria-label="清除服务商门店地址搜索" onClick={() => { setLocationQuery(""); setLocationSuggestions([]); setLocationMessage(""); }}><X /></button> : null}</div>
      {locationSuggestions.length ? <div className="wash-location-suggestions" role="listbox">{locationSuggestions.map((location) => <button key={location.poiId} type="button" role="option" onClick={() => { selectLocation(location); setMapError(""); setMapFeedback(`已选择 ${location.title || location.address}，保存门店资料后生效`); }}><MapPin /><span><strong>{location.title}</strong><small>{location.address}</small></span><em>{location.district}{location.source === "demo" ? " · 演示" : ""}</em></button>)}</div> : null}
      {locationMessage ? <p className="provider-location-message" role="status"><WarningCircle />{locationMessage}</p> : null}
      {mapOpen ? <ProviderLocationMap latitude={draft.latitude} longitude={draft.longitude} busy={mapBusy} feedback={mapFeedback} error={mapError} onPick={resolveMapPin} /> : null}
      <div className={`provider-location-current ${selectedLocation ? "pending" : ""}`}><MapPin weight="fill" /><span><small>{selectedLocation ? "待保存的新位置" : "当前可信位置"}</small><strong>{draft.address}</strong><em>{draft.district} · {draft.latitude.toFixed(6)}, {draft.longitude.toFixed(6)}{selectedLocation?.source === "demo" ? " · 演示位置" : ""}</em></span></div>
    </section>
    <section className="provider-store-section"><div className="provider-section-title"><span><ImageSquare weight="duotone" /></span><div><small>STORE GALLERY</small><h3>门店封面与相册</h3></div><div className="provider-image-actions"><span>{draft.images?.length || 0}/20 张</span><input id="provider-store-image-upload" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={Boolean(imageBusy) || (draft.images?.length || 0) >= 20} aria-label="服务商上传洗车门店图片" onChange={(event) => void uploadImages(event)} /><label htmlFor="provider-store-image-upload" role="button" tabIndex={Boolean(imageBusy) || (draft.images?.length || 0) >= 20 ? -1 : 0} aria-disabled={Boolean(imageBusy) || (draft.images?.length || 0) >= 20} className="provider-image-upload-trigger" onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !imageBusy && (draft.images?.length || 0) < 20) { event.preventDefault(); document.getElementById("provider-store-image-upload")?.click(); } }}><UploadSimple />{imageBusy === "upload" ? "上传中…" : "上传图片"}</label></div></div>{imageFeedback ? <div className={`provider-image-feedback ${imageFeedback.tone}`} role={imageFeedback.tone === "error" ? "alert" : "status"}>{imageFeedback.tone === "working" ? <CircleNotch className="backoffice-spinner" /> : imageFeedback.tone === "success" ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}<span>{imageFeedback.message}</span></div> : null}{draft.images?.length ? <div className="wash-store-image-grid">{orderedImages(draft.images).map((image, index, images) => <article key={image.id} className={image.isCover ? "cover" : ""}><div className="wash-store-image-preview"><AuthenticatedEvidenceImage url={image.url} alt={`${draft.name}门店图片 ${index + 1}`} />{image.isCover ? <span><Star weight="fill" />封面</span> : null}</div><div className="wash-store-image-meta"><strong>{index + 1}. {image.width} × {image.height}</strong><small>{Math.max(1, Math.round(image.sizeBytes / 1024))} KB</small></div><div className="wash-store-image-controls"><button type="button" aria-label={`服务商门店图片 ${index + 1} 上移`} disabled={Boolean(imageBusy) || index === 0} onClick={() => moveImage(image.id, -1)}><ArrowUp /></button><button type="button" aria-label={`服务商门店图片 ${index + 1} 下移`} disabled={Boolean(imageBusy) || index === images.length - 1} onClick={() => moveImage(image.id, 1)}><ArrowDown /></button><button type="button" className="cover-action" disabled={Boolean(imageBusy) || image.isCover} onClick={() => coverImage(image.id)}>{image.isCover ? "当前封面" : "设为封面"}</button><button type="button" className="delete-action" disabled={Boolean(imageBusy)} onClick={() => void removeImage(image)}><Trash /></button></div></article>)}</div> : <div className="wash-store-media-empty"><ImageSquare /><span><strong>还没有门店图片</strong><small>建议上传门头、洗车工位与等候环境的真实横向图片。</small></span><label htmlFor="provider-store-image-upload" role="button" tabIndex={imageBusy ? -1 : 0} aria-disabled={Boolean(imageBusy)} className="provider-image-empty-trigger"><UploadSimple />选择图片</label></div>}</section>
    <footer className="provider-store-footer">{saved ? <span><CheckCircle weight="fill" />{saved}</span> : <span><ShieldCheck />只会更新当前登录门店</span>}<button disabled={saving || Boolean(imageBusy) || mapBusy}><FloppyDisk />{saving ? "保存中…" : mapBusy ? "位置核验中…" : "保存门店资料"}</button></footer>
  </form>;
}

type WashSlot = { id: string; storeId: string; date: string; startTime: string; endTime: string; capacity: number; bookedCount?: number; reservedCount?: number; remaining?: number; isClosed?: boolean; isOpen?: boolean };
function normalizedSlot(slot: WashSlot): WashSlot { return { ...slot, bookedCount: slot.bookedCount ?? slot.reservedCount ?? 0, isClosed: slot.isClosed ?? slot.isOpen === false }; }
function businessDate(offset = 0) { const value = new Date(Date.now() + offset * 86_400_000); return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(value); }

export function ProviderWashSlotsPage({ subjectId, onError }: { subjectId: string; onError: (message: string) => void }) {
  const [dateFrom, setDateFrom] = useState(businessDate()); const [dateTo, setDateTo] = useState(businessDate(13));
  const [slots, setSlots] = useState<WashSlot[]>([]); const [loading, setLoading] = useState(true); const [saved, setSaved] = useState("");
  const [batch, setBatch] = useState({ startTime: "08:00", endTime: "18:00", intervalMinutes: 60, capacity: 4 });
  const load = useCallback(async () => { setLoading(true); try { const query = new URLSearchParams({ storeId: subjectId, dateFrom, dateTo }); const payload = await api<ListPayload<WashSlot>>(`/admin/wash/slots?${query}`); setSlots(listOf(payload).map(normalizedSlot)); } catch (reason) { onError((reason as Error).message); } finally { setLoading(false); } }, [dateFrom, dateTo, onError, subjectId]);
  useEffect(() => { void load(); }, [load]);
  const generate = async () => { if (dateFrom > dateTo) return onError("结束日期不能早于开始日期"); if (batch.startTime >= batch.endTime) return onError("结束时间必须晚于开始时间"); try { await api("/admin/wash/slots/batch", { method: "POST", body: JSON.stringify({ storeId: subjectId, dateFrom, dateTo, startTime: batch.startTime, endTime: batch.endTime, slotMinutes: batch.intervalMinutes, intervalMinutes: batch.intervalMinutes, capacity: batch.capacity }) }); setSaved("预约时段已批量生成"); await load(); } catch (reason) { onError((reason as Error).message); } };
  const saveSlot = async (slot: WashSlot) => { const booked = slot.bookedCount ?? 0; if (slot.capacity < booked) return onError("时段容量不能小于已预约数量"); try { const result = await api<WashSlot>(`/admin/wash/slots/${slot.id}`, { method: "PATCH", body: JSON.stringify({ capacity: slot.capacity, isOpen: !slot.isClosed }) }); setSlots((items) => items.map((item) => item.id === slot.id ? normalizedSlot(result) : item)); setSaved("时段设置已保存"); } catch (reason) { onError((reason as Error).message); } };
  const openCount = slots.filter((slot) => !slot.isClosed).length; const remaining = slots.reduce((sum, slot) => sum + (slot.isClosed ? 0 : slot.remaining ?? Math.max(0, slot.capacity - (slot.bookedCount ?? 0))), 0);
  return <><section className="provider-slot-summary"><div><span><CalendarCheck /></span><small>当前日期范围</small><strong>{dateFrom} 至 {dateTo}</strong></div><div><small>开放时段</small><strong>{openCount}<em> 个</em></strong></div><div><small>剩余号源</small><strong>{remaining}<em> 个</em></strong></div></section><section className="content-card provider-slot-card"><header><div><small>APPOINTMENT CAPACITY</small><h2>预约时段与容量</h2><p>容量不能低于已预约数量；已开始的时段仍由服务端拒绝修改。</p></div><div className="date-range"><label><span>开始日期</span><input aria-label="服务商洗车时段开始日期" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label><span>结束日期</span><input aria-label="服务商洗车时段结束日期" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div></header><div className="wash-slot-batch"><label><span>每日开始</span><input aria-label="服务商批量时段每日开始" type="time" value={batch.startTime} onChange={(event) => setBatch({ ...batch, startTime: event.target.value })} /></label><label><span>每日结束</span><input aria-label="服务商批量时段每日结束" type="time" value={batch.endTime} onChange={(event) => setBatch({ ...batch, endTime: event.target.value })} /></label><label><span>每段分钟</span><input aria-label="服务商批量时段分钟" type="number" min="15" step="15" value={batch.intervalMinutes} onChange={(event) => setBatch({ ...batch, intervalMinutes: Number(event.target.value) })} /></label><label><span>每段容量</span><input aria-label="服务商批量时段容量" type="number" min="1" max="99" value={batch.capacity} onChange={(event) => setBatch({ ...batch, capacity: Number(event.target.value) })} /></label><button onClick={() => void generate()}><Plus />批量生成</button></div>{saved ? <div className="wash-success provider-page-success"><CheckCircle weight="fill" />{saved}</div> : null}{loading ? <div className="empty-table">正在读取本店预约时段…</div> : slots.length ? <div className="wash-slot-list provider-slot-list">{slots.map((slot) => { const booked = slot.bookedCount ?? 0; return <article key={slot.id} className={slot.isClosed ? "closed" : ""}><span><strong>{slot.date}</strong><small>{slot.startTime}–{slot.endTime}</small></span><span><strong>已约 {booked}</strong><small>剩余 {slot.isClosed ? 0 : slot.remaining ?? Math.max(0, slot.capacity - booked)}</small></span><label><small>容量</small><input aria-label={`服务商${slot.date} ${slot.startTime}容量`} type="number" min={booked} max="99" value={slot.capacity} onChange={(event) => setSlots((items) => items.map((item) => item.id === slot.id ? { ...item, capacity: Number(event.target.value) } : item))} /></label><label className="slot-close-check"><input aria-label={`服务商${slot.date} ${slot.startTime}关闭时段`} type="checkbox" checked={Boolean(slot.isClosed)} onChange={(event) => setSlots((items) => items.map((item) => item.id === slot.id ? { ...item, isClosed: event.target.checked } : item))} /><span>{slot.isClosed ? "已关闭" : "开放"}</span></label><button onClick={() => void saveSlot(slot)}><FloppyDisk />保存</button></article>; })}</div> : <div className="empty-table">当前日期范围内没有时段，可使用上方规则批量生成。</div>}</section></>;
}

type VehicleType = "sedan" | "suv" | "mpv";
type WashPackage = { id: string; code: string; name: string; description?: string; shortDescription?: string; includedItems?: string[]; serviceItems?: string[]; durationMinutes: number; isActive: boolean };
type WashOffer = { id?: string; storeId: string; packageId: string; vehicleType?: VehicleType; vehicleCategory?: VehicleType; salePriceFen: number; isActive?: boolean; isAvailable?: boolean };
const vehicleTypes: VehicleType[] = ["sedan", "suv", "mpv"];

export function ProviderWashCatalogPage({ subjectId, onError }: { subjectId: string; onError: (message: string) => void }) {
  const [packages, setPackages] = useState<WashPackage[]>([]); const [offers, setOffers] = useState<WashOffer[]>([]); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState("");
  const load = useCallback(async () => { setLoading(true); try { const [packagePayload, offerPayload] = await Promise.all([api<ListPayload<WashPackage>>("/admin/wash/packages"), api<ListPayload<WashOffer>>(`/admin/wash/stores/${subjectId}/offers`)]); setPackages(listOf(packagePayload)); setOffers(listOf(offerPayload).map((offer) => ({ ...offer, vehicleType: offer.vehicleType || offer.vehicleCategory, isActive: offer.isActive ?? offer.isAvailable ?? false }))); } catch (reason) { onError((reason as Error).message); } finally { setLoading(false); } }, [onError, subjectId]);
  useEffect(() => { void load(); }, [load]);
  const findOffer = (packageId: string, vehicleType: VehicleType) => offers.find((offer) => offer.packageId === packageId && (offer.vehicleType || offer.vehicleCategory) === vehicleType);
  const getOffer = (packageId: string, vehicleType: VehicleType): WashOffer => findOffer(packageId, vehicleType) || { storeId: subjectId, packageId, vehicleType, salePriceFen: 0, isActive: false };
  const updateOffer = (packageId: string, vehicleType: VehicleType, patch: Partial<WashOffer>) => setOffers((items) => { const index = items.findIndex((offer) => offer.packageId === packageId && (offer.vehicleType || offer.vehicleCategory) === vehicleType); if (index < 0) return items; const next = { ...items[index], ...patch }; return items.map((item, itemIndex) => itemIndex === index ? next : item); });
  const save = async () => { const matrix = offers.map((offer) => { const vehicleType = (offer.vehicleType || offer.vehicleCategory)!; return { packageId: offer.packageId, vehicleType, vehicleCategory: vehicleType, salePriceFen: offer.salePriceFen, isActive: Boolean(offer.isActive), isAvailable: Boolean(offer.isActive) }; }); setSaving(true); try { const payload = await api<ListPayload<WashOffer>>(`/admin/wash/stores/${subjectId}/offers`, { method: "PUT", body: JSON.stringify({ offers: matrix }) }); setOffers(listOf(payload).map((offer) => ({ ...offer, vehicleType: offer.vehicleType || offer.vehicleCategory, isActive: offer.isActive ?? offer.isAvailable }))); setSaved("本店套餐价格已保存；历史订单价格保持不变"); window.setTimeout(() => setSaved(""), 2400); } catch (reason) { onError((reason as Error).message); } finally { setSaving(false); } };
  return <><section className="provider-catalog-intro"><div><span><ListChecks weight="duotone" /></span><div><small>SHARED PACKAGE CATALOG</small><h2>公共套餐只读，本店价格可维护</h2><p>套餐名称、内容与时长由平台统一维护；你可以决定本店是否售卖及销售价格。</p></div></div><ShieldCheck weight="duotone" /></section><section className="provider-package-cards">{packages.map((item) => <article key={item.id}><header><span><ListChecks /></span><em>{item.isActive ? "平台启用" : "平台停用"}</em></header><h3>{item.name}</h3><p>{item.description || item.shortDescription || "平台公共洗车套餐"}</p><div>{(item.includedItems || item.serviceItems || []).slice(0, 5).map((entry) => <span key={entry}><CheckCircle />{entry}</span>)}</div><small>约 {item.durationMinutes} 分钟 · {item.code}</small></article>)}</section><section className="content-card provider-price-card"><header><div><small>MY STORE PRICING</small><h2>本店套餐价格</h2><p>价格保存后立即影响新报价，已有报价和历史订单继续使用冻结快照。</p></div><span><Storefront />当前登录门店</span></header>{loading ? <div className="empty-table">正在读取本店价格…</div> : <div className="table-wrap"><table><thead><tr><th>套餐</th>{vehicleTypes.map((type) => <th key={type}>{vehicleLabels[type]}销售设置</th>)}</tr></thead><tbody>{packages.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>公共套餐内容只读</small></td>{vehicleTypes.map((vehicleType) => { const existing = findOffer(item.id, vehicleType); const offer = getOffer(item.id, vehicleType); return <td key={vehicleType}><div className={`provider-offer-cell ${offer.isActive ? "active" : ""} ${existing ? "" : "unavailable"}`}><label><input aria-label={`服务商${item.name}${vehicleLabels[vehicleType]}启用价格`} type="checkbox" disabled={!existing} checked={Boolean(existing && offer.isActive)} onChange={(event) => updateOffer(item.id, vehicleType, { isActive: event.target.checked })} /><span>{!existing ? "平台未配置" : offer.isActive ? "本店售卖" : "本店关闭"}</span></label><div><i>¥</i><input aria-label={`服务商${item.name}${vehicleLabels[vehicleType]}销售价`} type="number" min="0" step="0.01" disabled={!existing || !offer.isActive} value={existing ? money(offer.salePriceFen) : ""} placeholder="未配置" onChange={(event) => updateOffer(item.id, vehicleType, { salePriceFen: Math.round(Number(event.target.value) * 100) })} /></div></div></td>; })}</tr>)}</tbody></table></div>}<footer>{saved ? <span><CheckCircle weight="fill" />{saved}</span> : <span><WarningCircle />预计结算价由平台维护，不在本页显示或修改</span>}<button disabled={saving || loading || !offers.length} onClick={() => void save()}><FloppyDisk />{saving ? "保存中…" : "保存本店价格"}</button></footer></section></>;
}
