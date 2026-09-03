import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Buildings,
  CalendarCheck,
  Camera,
  Car,
  CheckCircle,
  CurrencyCny,
  FloppyDisk,
  Gauge,
  Image,
  MapPin,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Receipt,
  ShieldCheck,
  Star,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, money, upload } from "./adminApi";

type RentalTab = "catalog" | "stores" | "fleet" | "rates" | "orders";
type EnergyType = "gasoline" | "diesel" | "hybrid" | "plug_in_hybrid" | "range_extended" | "pure_electric";
type BodyType = "sedan" | "suv" | "mpv" | "hatchback" | "coupe" | "pickup";
type Transmission = "automatic" | "manual" | "cvt" | "dct" | "single_speed" | "e_cvt";
type VehicleStatus = "draft" | "active" | "maintenance" | "offline" | "retired";
type OrderStatus = "pending_payment" | "confirmed" | "ready_for_pickup" | "in_use" | "return_pending" | "completed" | "cancelled" | "expired";

type RentalImage = { id: string; url: string; sortOrder: number; isCover: boolean; mimeType?: string };
type Brand = { id: string; name: string; logoUrl: string | null; initial: string; isHot: boolean; sortOrder: number; isActive: boolean; modelCount?: number; activeVehicleCount?: number };
type Model = {
  id: string;
  brandId: string;
  brandName?: string;
  name: string;
  coverImageUrl: string | null;
  bodyType: BodyType;
  energyType: EnergyType;
  transmission: Transmission;
  seats: number;
  luggage: number;
  sortOrder: number;
  isActive: boolean;
  images?: RentalImage[];
  activeVehicleCount?: number;
};
type Store = {
  id: string;
  name: string;
  district: string;
  address: string;
  latitude: number;
  longitude: number;
  openHours: string;
  phone: string;
  isActive: boolean;
  sortOrder: number;
  deliveryBaseFeeFen: number;
  deliveryIncludedKm: number;
  deliveryPerKmFen: number;
  deliveryMaxRadiusKm: number;
  deliveryRule?: { baseFeeFen: number; includedKm: number; perKmFen: number; maxRadiusKm: number | null };
  activeVehicleCount?: number;
};
type Vehicle = {
  id: string;
  stockNo: string;
  modelId: string;
  modelName?: string;
  storeId: string;
  storeName?: string;
  plateMasked: string;
  plateNumber?: string | null;
  color: string;
  modelYear: number;
  status: VehicleStatus;
  mileageKm: number;
};
type RatePlan = {
  id: string;
  modelId: string;
  modelName?: string;
  storeId: string | null;
  storeName?: string | null;
  weekdayRateFen: number;
  weekendRateFen: number;
  basicProtectionDailyFen: number;
  prepFeeFen: number;
  optionalProtectionDailyFen: number;
  vehicleDepositFen: number;
  violationDepositFen: number;
  includedMileageKmPerDay: number;
  overagePerKmFen: number;
  fuelPolicy: string;
  cancellationPolicy: string;
  isActive: boolean;
};
type RateOverride = { id: string; ratePlanId: string; date: string; dailyRateFen: number; isAvailable: boolean; note: string };
type FeeBreakdown = {
  rentalFeeFen?: number;
  basicProtectionFeeFen?: number;
  optionalProtectionFeeFen?: number;
  vehicleRentFen?: number;
  basicProtectionFen?: number;
  prepFeeFen?: number;
  optionalProtectionFen?: number;
  deliveryFeeFen?: number;
  adjustmentFen?: number;
  payableFen?: number;
  totalFen?: number;
  totalFeeFen?: number;
};
type RentalOrder = {
  id: string;
  orderNo?: string;
  orderNumber?: string;
  status: OrderStatus;
  driverName: string;
  driverPhoneMasked: string;
  serviceMode: "store_pickup" | "home_delivery";
  store?: { id: string; name: string } | null;
  storeId?: string;
  model?: { id: string; name: string } | null;
  modelId?: string;
  pickupAt: string;
  returnAt: string;
  billableDays: number;
  feeBreakdown: FeeBreakdown;
  deposits?: { vehicleDepositFen: number; violationDepositFen: number };
  assignedVehicle?: { id: string; stockNo: string; plateMasked?: string } | null;
  internalNote?: string | null;
  adjustments?: Array<{ id: string; amountFen: number; note: string; createdAt?: string }>;
  events?: Array<{ id: string; type?: string; status?: string; toStatus?: string; note?: string; createdAt: string }>;
  createdAt?: string;
};

type BrandDraft = Omit<Brand, "id"> & { id?: string; logoFile?: File | null };
type ModelDraft = Omit<Model, "id" | "brandName"> & { id?: string };
type StoreDraft = Omit<Store, "id"> & { id?: string };
type VehicleDraft = Omit<Vehicle, "id" | "modelName" | "storeName"> & { id?: string };
type RateDraft = Omit<RatePlan, "id" | "modelName" | "storeName"> & { id?: string };

const tabs: Array<[RentalTab, string, typeof Car]> = [
  ["catalog", "品牌车型", Car],
  ["stores", "租赁门店", Buildings],
  ["fleet", "车队车辆", Gauge],
  ["rates", "租赁价格", CurrencyCny],
  ["orders", "租车订单", Receipt],
];
const energyLabels: Record<EnergyType, string> = { gasoline: "汽油", diesel: "柴油", hybrid: "油电混合", plug_in_hybrid: "插电混动", range_extended: "增程", pure_electric: "纯电" };
const bodyLabels: Record<BodyType, string> = { sedan: "轿车", suv: "SUV", mpv: "MPV", hatchback: "两厢车", coupe: "跑车", pickup: "皮卡" };
const transmissionLabels: Record<Transmission, string> = { automatic: "自动挡", manual: "手动挡", cvt: "CVT", dct: "双离合", single_speed: "电动车单速", e_cvt: "E-CVT" };
const vehicleStatusLabels: Record<VehicleStatus, string> = { draft: "草稿", active: "可运营", maintenance: "维修中", offline: "已下线", retired: "已退役" };
const orderStatusLabels: Record<OrderStatus, string> = { pending_payment: "待模拟支付", confirmed: "已确认", ready_for_pickup: "待取车", in_use: "租用中", return_pending: "待还车", completed: "已完成", cancelled: "已取消", expired: "已过期" };
const orderTransitions: Partial<Record<OrderStatus, OrderStatus[]>> = {
  confirmed: ["ready_for_pickup", "cancelled"],
  ready_for_pickup: ["in_use", "cancelled"],
  in_use: ["return_pending"],
  return_pending: ["completed"],
};

const asItems = <T,>(value: T[] | { items: T[] } | undefined): T[] => !value ? [] : Array.isArray(value) ? value : value.items;
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败，请稍后重试";
const numberValue = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0;
const fenValue = (value: string) => Math.round(numberValue(value) * 100);
const today = () => new Date().toISOString().slice(0, 10);

function emptyBrand(): BrandDraft {
  return { name: "", logoUrl: null, initial: "A", isHot: false, sortOrder: 0, isActive: true, modelCount: 0, activeVehicleCount: 0, logoFile: null };
}
function emptyModel(brandId = ""): ModelDraft {
  return { brandId, name: "", coverImageUrl: null, bodyType: "sedan", energyType: "gasoline", transmission: "automatic", seats: 5, luggage: 2, sortOrder: 0, isActive: true, images: [], activeVehicleCount: 0 };
}
function emptyStore(): StoreDraft {
  return { name: "", district: "天津市", address: "", latitude: 39.0851, longitude: 117.1994, openHours: "08:00-20:00", phone: "", isActive: true, sortOrder: 0, deliveryBaseFeeFen: 2900, deliveryIncludedKm: 3, deliveryPerKmFen: 600, deliveryMaxRadiusKm: 20, activeVehicleCount: 0 };
}
function emptyVehicle(modelId = "", storeId = ""): VehicleDraft {
  return { stockNo: "", modelId, storeId, plateMasked: "", plateNumber: "", color: "白色", modelYear: new Date().getFullYear(), status: "draft", mileageKm: 0 };
}
function emptyRate(modelId = ""): RateDraft {
  return { modelId, storeId: null, weekdayRateFen: 15800, weekendRateFen: 18200, basicProtectionDailyFen: 6000, prepFeeFen: 3500, optionalProtectionDailyFen: 6000, vehicleDepositFen: 300000, violationDepositFen: 200000, includedMileageKmPerDay: 300, overagePerKmFen: 100, fuelPolicy: "同油量或同电量归还；不足部分按门店租后规则记录", cancellationPolicy: "取车前24小时可免费取消；24小时内取消以订单页规则为准", isActive: true };
}

function normalizeModel(model: Model): Model {
  const rawImages = (model as unknown as { images?: Array<RentalImage | string | { id: string; imageUrl: string; sortOrder: number; isCover: boolean }> }).images || [];
  const images = rawImages.map((image, index) => typeof image === "string"
    ? { id: `${model.id}-image-${index}`, url: image, sortOrder: index, isCover: index === 0 }
    : { ...image, url: "url" in image ? image.url : image.imageUrl });
  return { ...model, images };
}

function normalizeStore(store: Store): Store {
  const rule = store.deliveryRule;
  return {
    ...store,
    phone: store.phone || "",
    deliveryBaseFeeFen: store.deliveryBaseFeeFen ?? rule?.baseFeeFen ?? 2900,
    deliveryIncludedKm: store.deliveryIncludedKm ?? rule?.includedKm ?? 3,
    deliveryPerKmFen: store.deliveryPerKmFen ?? rule?.perKmFen ?? 600,
    deliveryMaxRadiusKm: store.deliveryMaxRadiusKm ?? rule?.maxRadiusKm ?? 20,
  };
}

function orderAdjustmentFen(order: RentalOrder): number {
  return (order.adjustments || []).reduce((sum, item) => sum + item.amountFen, 0);
}

function orderTotalFen(order: RentalOrder): number {
  return Number(order.feeBreakdown?.payableFen ?? order.feeBreakdown?.totalFeeFen ?? order.feeBreakdown?.totalFen ?? 0) + orderAdjustmentFen(order);
}

function BrandLogo({ brand }: { brand: Pick<Brand, "name" | "initial" | "logoUrl"> }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [brand.logoUrl]);
  return <span className="used-car-brand-logo" aria-hidden="true">{brand.logoUrl && !failed ? <img src={brand.logoUrl} alt="" onError={() => setFailed(true)} /> : <strong>{brand.initial || brand.name.slice(0, 1)}</strong>}</span>;
}

function Drawer({ label, title, description, close, wide = false, children }: { label: string; title: string; description: string; close: () => void; wide?: boolean; children: ReactNode }) {
  return <div className="drawer-layer"><button className="drawer-backdrop" aria-label={`关闭${label}`} onClick={close} /><aside className={`detail-drawer used-car-drawer rental-drawer ${wide ? "wide-drawer used-car-listing-drawer" : ""}`} aria-label={label}>
    <header><div><small>CAR RENTAL OPERATIONS</small><h2>{title}</h2><p>{description}</p></div><button aria-label={`关闭${label}`} onClick={close}><X /></button></header>{children}
  </aside></div>;
}

export function CarRentalAdminPage({ onError }: { onError: (message: string) => void }) {
  const [tab, setTab] = useState<RentalTab>(() => new URLSearchParams(window.location.search).get("tab") === "orders" ? "orders" : "catalog");
  const [brands, setBrands] = useState<Brand[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [rates, setRates] = useState<RatePlan[]>([]);
  const [overrides, setOverrides] = useState<RateOverride[]>([]);
  const [orders, setOrders] = useState<RentalOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [brandDraft, setBrandDraft] = useState<BrandDraft | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  const [storeDraft, setStoreDraft] = useState<StoreDraft | null>(null);
  const [vehicleDraft, setVehicleDraft] = useState<VehicleDraft | null>(null);
  const [rateDraft, setRateDraft] = useState<RateDraft | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<RentalOrder | null>(null);
  const deepLinkOpenedRef = useRef("");

  const loadCatalog = async () => {
    const [brandData, modelData] = await Promise.all([api<Brand[]>("/admin/car-rental/brands"), api<Model[]>("/admin/car-rental/models?includeInactive=true")]);
    setBrands(asItems(brandData)); setModels(asItems(modelData).map((model) => normalizeModel(model)));
  };
  const loadStores = async () => setStores(asItems(await api<Store[]>("/admin/car-rental/stores?includeInactive=true")).map(normalizeStore));
  const loadVehicles = async () => setVehicles(asItems(await api<Vehicle[]>("/admin/car-rental/vehicles?includeRetired=true")));
  const loadRates = async () => {
    const [rateData, overrideData] = await Promise.all([api<RatePlan[]>("/admin/car-rental/rate-plans?includeInactive=true"), api<RateOverride[]>("/admin/car-rental/rate-overrides")]);
    setRates(asItems(rateData)); setOverrides(asItems(overrideData));
  };
  const loadOrders = async () => setOrders(asItems(await api<RentalOrder[] | { items: RentalOrder[] }>("/admin/car-rental/orders?page=1&pageSize=100")));
  const run = async (task: () => Promise<void>) => { setLoading(true); try { await task(); } catch (error) { onError(errorText(error)); } finally { setLoading(false); } };
  useEffect(() => { void run(loadCatalog); }, []);
  useEffect(() => {
    if (tab === "stores" && !stores.length) void run(loadStores);
    if (tab === "fleet") void run(async () => { await Promise.all([loadStores(), loadVehicles(), models.length ? Promise.resolve() : loadCatalog()]); });
    if (tab === "rates") void run(async () => { await Promise.all([loadStores(), loadRates(), models.length ? Promise.resolve() : loadCatalog()]); });
    if (tab === "orders") void run(async () => { await Promise.all([loadOrders(), loadVehicles(), models.length ? Promise.resolve() : loadCatalog()]); });
  }, [tab]);
  useEffect(() => {
    const orderId = new URLSearchParams(window.location.search).get("order") || "";
    if (!orderId || deepLinkOpenedRef.current === orderId) return;
    deepLinkOpenedRef.current = orderId;
    setTab("orders");
    void api<RentalOrder>(`/admin/car-rental/orders/${encodeURIComponent(orderId)}`).then(setSelectedOrder).catch((error) => onError(errorText(error)));
  }, [onError]);

  const metrics = useMemo(() => ({ brands: brands.filter((item) => item.isActive).length, models: models.filter((item) => item.isActive).length, vehicles: vehicles.filter((item) => item.status === "active").length, activeOrders: orders.filter((item) => !["completed", "cancelled", "expired"].includes(item.status)).length }), [brands, models, vehicles, orders]);

  const saveBrand = async (draft: BrandDraft) => {
    if (!draft.name.trim() || !/^[A-Z#]$/.test(draft.initial.trim().toUpperCase())) return onError("请填写品牌名称和单个大写首字母");
    await run(async () => {
      const saved = await api<Brand>(draft.id ? `/admin/car-rental/brands/${draft.id}` : "/admin/car-rental/brands", { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ name: draft.name.trim(), logoUrl: draft.logoUrl || undefined, initial: draft.initial.trim().toUpperCase(), isHot: draft.isHot, sortOrder: Number(draft.sortOrder), isActive: draft.isActive }) });
      if (draft.logoFile) { const form = new FormData(); form.append("file", draft.logoFile); await upload(`/admin/car-rental/brands/${saved.id}/logo`, form); }
      await loadCatalog(); setBrandDraft(null);
    });
  };
  const saveModel = async (draft: ModelDraft) => {
    if (!draft.brandId || !draft.name.trim()) return onError("请选择品牌并填写车型名称");
    await run(async () => {
      await api(draft.id ? `/admin/car-rental/models/${draft.id}` : "/admin/car-rental/models", { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ brandId: draft.brandId, name: draft.name.trim(), coverImageUrl: draft.coverImageUrl, bodyType: draft.bodyType, energyType: draft.energyType, transmission: draft.transmission, seats: Number(draft.seats), luggage: Number(draft.luggage), sortOrder: Number(draft.sortOrder), isActive: draft.isActive }) });
      await loadCatalog(); setModelDraft(null);
    });
  };
  const saveStore = async (draft: StoreDraft) => {
    if (!draft.name.trim() || !draft.address.trim()) return onError("请填写门店名称和地址");
    await run(async () => {
      await api(draft.id ? `/admin/car-rental/stores/${draft.id}` : "/admin/car-rental/stores", { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ ...draft, id: undefined, activeVehicleCount: undefined, name: draft.name.trim(), address: draft.address.trim(), latitude: Number(draft.latitude), longitude: Number(draft.longitude), sortOrder: Number(draft.sortOrder), deliveryBaseFeeFen: Number(draft.deliveryBaseFeeFen), deliveryIncludedKm: Number(draft.deliveryIncludedKm), deliveryPerKmFen: Number(draft.deliveryPerKmFen), deliveryMaxRadiusKm: Number(draft.deliveryMaxRadiusKm) }) });
      await loadStores(); setStoreDraft(null);
    });
  };
  const saveVehicle = async (draft: VehicleDraft) => {
    if (!draft.stockNo.trim() || !draft.modelId || !draft.storeId) return onError("请填写库存编号，并选择车型和门店");
    await run(async () => {
      await api(draft.id ? `/admin/car-rental/vehicles/${draft.id}` : "/admin/car-rental/vehicles", { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ stockNo: draft.stockNo, modelId: draft.modelId, storeId: draft.storeId, plateNumber: draft.plateNumber?.trim() || undefined, color: draft.color, modelYear: Number(draft.modelYear), mileageKm: Number(draft.mileageKm), status: draft.status }) });
      await loadVehicles(); setVehicleDraft(null);
    });
  };
  const saveRate = async (draft: RateDraft) => {
    if (!draft.modelId) return onError("请选择计价车型");
    await run(async () => {
      await api(draft.id ? `/admin/car-rental/rate-plans/${draft.id}` : "/admin/car-rental/rate-plans", { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ ...draft, id: undefined }) });
      await loadRates(); setRateDraft(null);
    });
  };

  return <div className="used-car-admin rental-admin">
    <section className="used-car-overview rental-overview">
      <div><small>SELF-OPERATED CAR RENTAL</small><h2>平台自营汽车租赁中心</h2><p>所有车辆、价格、押金与订单均为合成演示数据 · 模拟支付不产生真实资金流</p></div>
      <div className="used-car-metrics" aria-label="汽车租赁运营概览"><span><strong>{metrics.brands}</strong><small>启用品牌</small></span><span><strong>{metrics.models}</strong><small>启用车型</small></span><span><strong>{metrics.vehicles}</strong><small>可运营车辆</small></span><span><strong>{metrics.activeOrders}</strong><small>履约中订单</small></span></div>
    </section>
    <div className="used-car-tabs rental-tabs" role="tablist" aria-label="汽车租赁维护分类">{tabs.map(([value, label, Icon]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}><Icon />{label}</button>)}</div>
    {loading ? <div className="rental-loading"><span className="spinner" />正在同步租赁数据…</div> : null}
    {tab === "catalog" ? <CatalogTab brands={brands} models={models} setBrandDraft={setBrandDraft} setModelDraft={(draft) => { if (!draft.id) return setModelDraft(draft); void run(async () => { const detail = await api<Model>(`/admin/car-rental/models/${draft.id}`); setModelDraft(normalizeModel(detail)); }); }} onToggleBrand={(item) => void saveBrand({ ...item, isActive: !item.isActive })} onToggleModel={(item) => void saveModel({ ...item, isActive: !item.isActive })} /> : null}
    {tab === "stores" ? <StoresTab stores={stores} edit={setStoreDraft} /> : null}
    {tab === "fleet" ? <FleetTab vehicles={vehicles} models={models} stores={stores} edit={setVehicleDraft} retire={(vehicle) => void run(async () => { await api(`/admin/car-rental/vehicles/${vehicle.id}/retire`, { method: "POST", body: JSON.stringify({ note: "运营后台人工退役" }) }); await loadVehicles(); })} /> : null}
    {tab === "rates" ? <RatesTab rates={rates} overrides={overrides} models={models} stores={stores} edit={setRateDraft} reload={() => run(loadRates)} onError={onError} /> : null}
    {tab === "orders" ? <OrdersTab orders={orders} models={models} open={(order) => void run(async () => { const detail = await api<RentalOrder>(`/admin/car-rental/orders/${order.id}`); setSelectedOrder(detail); })} /> : null}
    {brandDraft ? <BrandEditor draft={brandDraft} setDraft={setBrandDraft} close={() => setBrandDraft(null)} save={saveBrand} /> : null}
    {modelDraft ? <ModelEditor draft={modelDraft} setDraft={setModelDraft} brands={brands} close={() => setModelDraft(null)} save={saveModel} reload={loadCatalog} onError={onError} /> : null}
    {storeDraft ? <StoreEditor draft={storeDraft} setDraft={setStoreDraft} close={() => setStoreDraft(null)} save={saveStore} /> : null}
    {vehicleDraft ? <VehicleEditor draft={vehicleDraft} setDraft={setVehicleDraft} models={models} stores={stores} close={() => setVehicleDraft(null)} save={saveVehicle} /> : null}
    {rateDraft ? <RateEditor draft={rateDraft} setDraft={setRateDraft} models={models} stores={stores} close={() => setRateDraft(null)} save={saveRate} /> : null}
    {selectedOrder ? <OrderDrawer order={selectedOrder} vehicles={vehicles} close={() => { setSelectedOrder(null); const url = new URL(window.location.href); url.searchParams.delete("order"); window.history.replaceState({}, "", `${url.pathname}${url.search}`); }} refresh={() => run(async () => { const detail = await api<RentalOrder>(`/admin/car-rental/orders/${selectedOrder.id}`); setSelectedOrder(detail); await loadOrders(); })} onError={onError} /> : null}
  </div>;
}

function CatalogTab({ brands, models, setBrandDraft, setModelDraft, onToggleBrand, onToggleModel }: { brands: Brand[]; models: Model[]; setBrandDraft: (value: BrandDraft) => void; setModelDraft: (value: ModelDraft) => void; onToggleBrand: (value: Brand) => void; onToggleModel: (value: Model) => void }) {
  return <section className="used-car-catalog-grid"><article className="content-card used-car-entity-card"><header><div><small>BRAND CATALOG</small><h3>租赁品牌</h3><p>车标、首字母、热门与前台启停</p></div><button onClick={() => setBrandDraft(emptyBrand())}><Plus />新增品牌</button></header><div className="table-wrap"><table><thead><tr><th>品牌</th><th>车型 / 车队</th><th>状态</th><th>操作</th></tr></thead><tbody>{brands.map((brand) => <tr key={brand.id}><td><span className="used-car-name-cell"><BrandLogo brand={brand} /><span><strong>{brand.name}</strong><small>{brand.initial} · 排序 {brand.sortOrder}</small></span></span></td><td><strong>{brand.modelCount ?? models.filter((item) => item.brandId === brand.id).length} 款</strong><small>{brand.activeVehicleCount ?? 0} 辆可运营</small></td><td><span className={`status-pill ${brand.isActive ? "used-car-active" : "used-car-inactive"}`}>{brand.isActive ? "已启用" : "已停用"}</span>{brand.isHot ? <small className="used-car-hot"><Star weight="fill" />热门</small> : null}</td><td><span className="used-car-row-actions"><button aria-label={`编辑品牌 ${brand.name}`} onClick={() => setBrandDraft({ ...brand, logoFile: null })}><PencilSimple /></button><button aria-label={`${brand.isActive ? "停用" : "启用"}品牌 ${brand.name}`} onClick={() => onToggleBrand(brand)}>{brand.isActive ? "停用" : "启用"}</button></span></td></tr>)}</tbody></table></div></article>
    <article className="content-card used-car-entity-card"><header><div><small>GUARANTEED MODEL</small><h3>指定租赁车型</h3><p>消费者选择车型，具体车辆由运营分配</p></div><button disabled={!brands.some((item) => item.isActive)} onClick={() => setModelDraft(emptyModel(brands.find((item) => item.isActive)?.id))}><Plus />新增车型</button></header><div className="table-wrap"><table><thead><tr><th>品牌 / 车型</th><th>规格</th><th>车队</th><th>状态</th><th>操作</th></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td><span className="used-car-listing-cell"><span className="used-car-cover">{model.coverImageUrl ? <img src={model.coverImageUrl} alt="" /> : <Car />}</span><span><strong>{model.brandName || brands.find((item) => item.id === model.brandId)?.name} · {model.name}</strong><small>排序 {model.sortOrder}</small></span></span></td><td><strong>{bodyLabels[model.bodyType]} · {model.seats}座</strong><small>{energyLabels[model.energyType]} · {transmissionLabels[model.transmission]}</small></td><td><strong>{model.activeVehicleCount ?? 0} 辆</strong><small>实时可运营</small></td><td><span className={`status-pill ${model.isActive ? "used-car-active" : "used-car-inactive"}`}>{model.isActive ? "已启用" : "已停用"}</span></td><td><span className="used-car-row-actions"><button aria-label={`编辑车型 ${model.name}`} onClick={() => setModelDraft({ ...model })}><PencilSimple /></button><button aria-label={`${model.isActive ? "停用" : "启用"}车型 ${model.name}`} onClick={() => onToggleModel(model)}>{model.isActive ? "停用" : "启用"}</button></span></td></tr>)}</tbody></table></div></article></section>;
}

function StoresTab({ stores, edit }: { stores: Store[]; edit: (draft: StoreDraft) => void }) {
  return <section className="content-card rental-table-card"><header className="rental-section-header"><div><small>RENTAL STORES</small><h3>租赁门店与送取规则</h3><p>同店取还；送车与取回必须使用同一地址</p></div><button onClick={() => edit(emptyStore())}><Plus />新增门店</button></header><div className="table-wrap"><table><thead><tr><th>门店</th><th>营业</th><th>车队</th><th>送取定价</th><th>服务半径</th><th>状态</th><th>操作</th></tr></thead><tbody>{stores.map((store) => <tr key={store.id}><td><strong>{store.name}</strong><small><MapPin />{store.district} · {store.address}</small></td><td><strong>{store.openHours}</strong><small>{store.phone || "未配置电话"}</small></td><td><strong>{store.activeVehicleCount ?? 0} 辆</strong><small>当前可运营</small></td><td><strong>¥{money(store.deliveryBaseFeeFen)} 起</strong><small>含 {store.deliveryIncludedKm}km · 超出 ¥{money(store.deliveryPerKmFen)}/km</small></td><td><strong>{store.deliveryMaxRadiusKm}km</strong><small>需真实驾车路线</small></td><td><span className={`status-pill ${store.isActive ? "used-car-active" : "used-car-inactive"}`}>{store.isActive ? "营业中" : "已停用"}</span></td><td><button className="used-car-edit-button" aria-label={`编辑门店 ${store.name}`} onClick={() => edit({ ...store })}><PencilSimple />编辑</button></td></tr>)}</tbody></table></div></section>;
}

function FleetTab({ vehicles, models, stores, edit, retire }: { vehicles: Vehicle[]; models: Model[]; stores: Store[]; edit: (draft: VehicleDraft) => void; retire: (vehicle: Vehicle) => void }) {
  const [keyword, setKeyword] = useState(""); const [status, setStatus] = useState(""); const [storeId, setStoreId] = useState("");
  const shown = vehicles.filter((vehicle) => (!keyword || `${vehicle.stockNo}${vehicle.modelName}${vehicle.plateMasked}`.toLowerCase().includes(keyword.toLowerCase())) && (!status || vehicle.status === status) && (!storeId || vehicle.storeId === storeId));
  return <section className="content-card rental-table-card"><header className="rental-section-header"><div><small>FLEET INVENTORY</small><h3>车队车辆</h3><p>消费者只看到指定车型，不展示库存编号或车牌</p></div><button disabled={!models.length || !stores.length} onClick={() => edit(emptyVehicle(models.find((item) => item.isActive)?.id, stores.find((item) => item.isActive)?.id))}><Plus />新增车辆</button></header><div className="used-car-filters rental-filters"><span><MagnifyingGlass />筛选</span><input aria-label="搜索车队车辆" placeholder="库存编号 / 车型 / 车牌" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><select aria-label="按门店筛选车辆" value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="">全部门店</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select><select aria-label="按状态筛选车辆" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(vehicleStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><button className="secondary" onClick={() => { setKeyword(""); setStoreId(""); setStatus(""); }}>清空</button></div><div className="table-wrap"><table><thead><tr><th>车辆</th><th>车型</th><th>所属门店</th><th>年款 / 里程</th><th>状态</th><th>操作</th></tr></thead><tbody>{shown.map((vehicle) => <tr key={vehicle.id}><td><strong>{vehicle.stockNo}</strong><small>{vehicle.plateMasked} · {vehicle.color}</small></td><td><strong>{vehicle.modelName || models.find((item) => item.id === vehicle.modelId)?.name}</strong><small>指定车型保障库存</small></td><td><strong>{vehicle.storeName || stores.find((item) => item.id === vehicle.storeId)?.name}</strong><small>仅支持同店取还</small></td><td><strong>{vehicle.modelYear} 年</strong><small>{vehicle.mileageKm.toLocaleString()} km</small></td><td><span className={`status-pill rental-vehicle-${vehicle.status}`}>{vehicleStatusLabels[vehicle.status]}</span></td><td><span className="used-car-row-actions"><button aria-label={`编辑车辆 ${vehicle.stockNo}`} onClick={() => edit({ ...vehicle })}><PencilSimple /></button>{vehicle.status !== "retired" ? <button className="danger-text" aria-label={`退役车辆 ${vehicle.stockNo}`} onClick={() => retire(vehicle)}>退役</button> : null}</span></td></tr>)}</tbody></table>{!shown.length ? <div className="empty-table">没有符合条件的车队车辆</div> : null}</div></section>;
}

function RatesTab({ rates, overrides, models, stores, edit, reload, onError }: { rates: RatePlan[]; overrides: RateOverride[]; models: Model[]; stores: Store[]; edit: (draft: RateDraft) => void; reload: () => void; onError: (message: string) => void }) {
  const [overrideDraft, setOverrideDraft] = useState<{ id?: string; ratePlanId: string; date: string; dailyRateYuan: string; isAvailable: boolean; note: string } | null>(null);
  const saveOverride = async (event: FormEvent) => { event.preventDefault(); if (!overrideDraft) return; try { await api(overrideDraft.id ? `/admin/car-rental/rate-overrides/${overrideDraft.id}` : "/admin/car-rental/rate-overrides", { method: overrideDraft.id ? "PUT" : "POST", body: JSON.stringify({ ratePlanId: overrideDraft.ratePlanId, date: overrideDraft.date, dailyRateFen: fenValue(overrideDraft.dailyRateYuan), isAvailable: overrideDraft.isAvailable, note: overrideDraft.note.trim() }) }); setOverrideDraft(null); reload(); } catch (error) { onError(errorText(error)); } };
  const removeOverride = async (item: RateOverride) => { try { await api(`/admin/car-rental/rate-overrides/${item.id}`, { method: "DELETE" }); reload(); } catch (error) { onError(errorText(error)); } };
  return <><section className="content-card rental-table-card"><header className="rental-section-header"><div><small>RATE & POLICY</small><h3>租赁价格与押金政策</h3><p>金额按分持久化；押金为模拟预授权，不计入应付金额</p></div><button onClick={() => edit(emptyRate(models.find((item) => item.isActive)?.id))}><Plus />新增价格</button></header><div className="table-wrap"><table><thead><tr><th>车型 / 范围</th><th>工作日 / 周末</th><th>必缴费用</th><th>押金</th><th>里程规则</th><th>3 天价格预览</th><th>状态</th><th>操作</th></tr></thead><tbody>{rates.map((rate) => { const preview = rate.weekdayRateFen * 2 + rate.weekendRateFen + rate.basicProtectionDailyFen * 3 + rate.prepFeeFen; return <tr key={rate.id}><td><strong>{rate.modelName || models.find((item) => item.id === rate.modelId)?.name}</strong><small>{rate.storeId ? rate.storeName || stores.find((item) => item.id === rate.storeId)?.name : "全部门店默认价"}</small></td><td><strong>¥{money(rate.weekdayRateFen)} / ¥{money(rate.weekendRateFen)}</strong><small>日期覆盖价优先</small></td><td><strong>保障 ¥{money(rate.basicProtectionDailyFen)}/天</strong><small>整备 ¥{money(rate.prepFeeFen)}/单</small></td><td><strong>¥{money(rate.vehicleDepositFen)}</strong><small>违章 ¥{money(rate.violationDepositFen)}</small></td><td><strong>{rate.includedMileageKmPerDay}km/天</strong><small>超出 ¥{money(rate.overagePerKmFen)}/km</small></td><td><strong className="rental-price">¥{money(preview)}</strong><small>2 工作日 + 1 周末</small></td><td><span className={`status-pill ${rate.isActive ? "used-car-active" : "used-car-inactive"}`}>{rate.isActive ? "生效" : "停用"}</span></td><td><span className="used-car-row-actions"><button aria-label={`编辑价格 ${rate.modelName || rate.id}`} onClick={() => edit({ ...rate })}><PencilSimple /></button><button aria-label={`新增日期价格 ${rate.modelName || rate.id}`} onClick={() => setOverrideDraft({ ratePlanId: rate.id, date: today(), dailyRateYuan: money(rate.weekendRateFen), isAvailable: true, note: "" })}><CalendarCheck />日期价</button></span></td></tr>; })}</tbody></table></div></section>
    <section className="content-card rental-override-card"><header className="rental-section-header compact"><div><small>DATE OVERRIDE</small><h3>指定日期覆盖</h3><p>可设置日期价格或停售；优先于工作日和周末价格</p></div></header><div className="rental-override-list">{overrides.map((item) => <div key={item.id}><span><strong>{item.date}</strong><small>{rates.find((rate) => rate.id === item.ratePlanId)?.modelName || item.ratePlanId}</small></span><span><strong>{item.isAvailable ? `¥${money(item.dailyRateFen)}` : "停售"}</strong><small>{item.note || "无备注"}</small></span><span className="used-car-row-actions"><button aria-label={`编辑日期价格 ${item.date}`} onClick={() => setOverrideDraft({ id: item.id, ratePlanId: item.ratePlanId, date: item.date, dailyRateYuan: money(item.dailyRateFen), isAvailable: item.isAvailable, note: item.note })}><PencilSimple /></button><button aria-label={`删除日期价格 ${item.date}`} onClick={() => void removeOverride(item)}><Trash /></button></span></div>)}{!overrides.length ? <div className="rental-empty-inline">暂无日期覆盖，当前全部使用常规价格</div> : null}</div></section>
    {overrideDraft ? <Drawer label="日期价格编辑" title={overrideDraft.id ? "编辑日期价格" : "新增日期价格"} description="覆盖价优先；关闭可租即为当日停售" close={() => setOverrideDraft(null)}><form className="drawer-scroll used-car-editor" onSubmit={saveOverride}><section className="detail-section used-car-form-grid"><label><span>计价方案</span><select aria-label="日期价格方案" value={overrideDraft.ratePlanId} onChange={(event) => setOverrideDraft({ ...overrideDraft, ratePlanId: event.target.value })}>{rates.map((rate) => <option value={rate.id} key={rate.id}>{rate.modelName || rate.id}</option>)}</select></label><label><span>日期</span><input aria-label="覆盖日期" type="date" value={overrideDraft.date} onChange={(event) => setOverrideDraft({ ...overrideDraft, date: event.target.value })} /></label><label><span>日租价（元）</span><input aria-label="覆盖日租价" inputMode="decimal" value={overrideDraft.dailyRateYuan} onChange={(event) => setOverrideDraft({ ...overrideDraft, dailyRateYuan: event.target.value })} /></label><label className="used-car-check"><input aria-label="覆盖日期可租" type="checkbox" checked={overrideDraft.isAvailable} onChange={(event) => setOverrideDraft({ ...overrideDraft, isAvailable: event.target.checked })} /><span><strong>当日可租</strong><small>关闭后该方案当日停售</small></span></label><label className="wide"><span>备注</span><textarea aria-label="日期价格备注" value={overrideDraft.note} onChange={(event) => setOverrideDraft({ ...overrideDraft, note: event.target.value })} /></label></section><footer className="used-car-editor-footer"><span><WarningCircle />保存后新报价立即生效</span><button className="primary"><FloppyDisk />保存日期价格</button></footer></form></Drawer> : null}</>;
}

function OrdersTab({ orders, models, open }: { orders: RentalOrder[]; models: Model[]; open: (order: RentalOrder) => void }) {
  const [keyword, setKeyword] = useState(""); const [status, setStatus] = useState(""); const [mode, setMode] = useState("");
  const shown = orders.filter((order) => (!keyword || `${order.orderNo || order.orderNumber}${order.driverName}${order.driverPhoneMasked}`.toLowerCase().includes(keyword.toLowerCase())) && (!status || order.status === status) && (!mode || order.serviceMode === mode));
  return <section className="content-card rental-table-card"><header className="rental-section-header"><div><small>RENTAL ORDERS</small><h3>租车订单与履约</h3><p>模拟支付 · 运营线下交车 · 全程事件审计</p></div></header><div className="used-car-filters rental-filters"><span><MagnifyingGlass />筛选</span><input aria-label="搜索租车订单" placeholder="订单号 / 驾驶员 / 手机号" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><select aria-label="按租车订单状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(orderStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select aria-label="按取还方式筛选" value={mode} onChange={(event) => setMode(event.target.value)}><option value="">全部方式</option><option value="store_pickup">同店取还</option><option value="home_delivery">同址送取</option></select><button className="secondary" onClick={() => { setKeyword(""); setStatus(""); setMode(""); }}>清空</button></div><div className="table-wrap"><table><thead><tr><th>订单 / 驾驶员</th><th>车型 / 门店</th><th>租期</th><th>方式</th><th>费用</th><th>分配车辆</th><th>状态</th><th>操作</th></tr></thead><tbody>{shown.map((order) => <tr key={order.id} onClick={() => open(order)}><td><strong>{order.orderNo || order.orderNumber || order.id}</strong><small>{order.driverName} · {order.driverPhoneMasked}</small></td><td><strong>{order.model?.name || models.find((item) => item.id === order.modelId)?.name}</strong><small>{order.store?.name || "待分配履约门店"}</small></td><td><strong>{order.billableDays} 天</strong><small>{new Date(order.pickupAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 起</small></td><td><span className="mode-pill">{order.serviceMode === "home_delivery" ? "同址送取" : "同店取还"}</span></td><td><strong>¥{money(orderTotalFen(order))}</strong><small>押金独立模拟预授权</small></td><td><strong>{order.assignedVehicle?.stockNo || order.assignedVehicle?.plateMasked || "待分配"}</strong><small>{order.assignedVehicle?.plateMasked || "消费者端不展示"}</small></td><td><span className={`status-pill rental-order-${order.status}`}>{orderStatusLabels[order.status] || order.status}</span></td><td><button className="used-car-edit-button" aria-label={`管理租车订单 ${order.orderNo || order.orderNumber || order.id}`}><PencilSimple />管理</button></td></tr>)}</tbody></table>{!shown.length ? <div className="empty-table">没有符合条件的租车订单</div> : null}</div></section>;
}

function BrandEditor({ draft, setDraft, close, save }: { draft: BrandDraft; setDraft: (value: BrandDraft) => void; close: () => void; save: (draft: BrandDraft) => Promise<void> }) {
  return <Drawer label={draft.id ? "编辑租赁品牌" : "新增租赁品牌"} title={draft.id ? "编辑租赁品牌" : "新增租赁品牌"} description="品牌变化后消费者端会清空已选车型" close={close}><form className="drawer-scroll used-car-editor" onSubmit={(event) => { event.preventDefault(); void save(draft); }}><section className="used-car-logo-editor"><BrandLogo brand={draft} /><span><strong>{draft.logoFile?.name || draft.name || "未选择车标"}</strong><small>JPEG / PNG / WebP，消费者端本地化展示</small></span><label><UploadSimple />选择车标<input aria-label="租赁品牌 Logo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setDraft({ ...draft, logoFile: event.target.files?.[0] || null })} /></label></section><section className="detail-section used-car-form-grid"><label><span>品牌名称</span><input aria-label="租赁品牌名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>拼音首字母</span><input aria-label="租赁品牌首字母" maxLength={1} value={draft.initial} onChange={(event) => setDraft({ ...draft, initial: event.target.value.toUpperCase() })} /></label><label><span>后台排序</span><input aria-label="租赁品牌排序" type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: numberValue(event.target.value) })} /></label><label className="used-car-check"><input aria-label="租赁热门品牌" type="checkbox" checked={draft.isHot} onChange={(event) => setDraft({ ...draft, isHot: event.target.checked })} /><span><strong>热门品牌</strong><small>展示在品牌筛选快捷区</small></span></label><label className="used-car-check wide"><input aria-label="租赁品牌启用" type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /><span><strong>品牌启用</strong><small>停用后不出现在新搜索中</small></span></label></section><footer className="used-car-editor-footer"><span><ShieldCheck />被车型引用时仅允许停用</span><button className="primary"><FloppyDisk />保存品牌</button></footer></form></Drawer>;
}

function ModelEditor({ draft, setDraft, brands, close, save, reload, onError }: { draft: ModelDraft; setDraft: (value: ModelDraft) => void; brands: Brand[]; close: () => void; save: (draft: ModelDraft) => Promise<void>; reload: () => Promise<void>; onError: (message: string) => void }) {
  const [uploading, setUploading] = useState(false); const images = [...(draft.images || [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const refreshDetail = async () => { if (!draft.id) return; const detail = normalizeModel(await api<Model>(`/admin/car-rental/models/${draft.id}`)); setDraft(detail); await reload(); };
  const uploadImages = async (files: FileList | null) => { if (!draft.id || !files?.length) return; setUploading(true); try { for (const file of Array.from(files)) { const form = new FormData(); form.append("file", file); await upload(`/admin/car-rental/models/${draft.id}/images`, form); } await refreshDetail(); } catch (error) { onError(errorText(error)); } finally { setUploading(false); } };
  const persistImages = async (ordered: RentalImage[], coverId?: string) => { if (!draft.id) return; try { await api(`/admin/car-rental/models/${draft.id}/images`, { method: "PUT", body: JSON.stringify({ images: ordered.map((item, index) => ({ id: item.id, sortOrder: index, isCover: coverId ? item.id === coverId : item.isCover })) }) }); await refreshDetail(); } catch (error) { onError(errorText(error)); } };
  const move = (id: string, delta: number) => { const index = images.findIndex((item) => item.id === id); const next = index + delta; if (index < 0 || next < 0 || next >= images.length) return; const ordered = [...images]; [ordered[index], ordered[next]] = [ordered[next], ordered[index]]; void persistImages(ordered); };
  const remove = async (image: RentalImage) => { if (!draft.id) return; try { await api(`/admin/car-rental/models/${draft.id}/images/${image.id}`, { method: "DELETE" }); await refreshDetail(); } catch (error) { onError(errorText(error)); } };
  return <Drawer label={draft.id ? "编辑租赁车型" : "新增租赁车型"} title={draft.id ? "编辑指定车型" : "新增指定车型"} description="交付车型保证一致，车辆颜色以门店实际为准" close={close} wide><form className="drawer-scroll used-car-editor" onSubmit={(event) => { event.preventDefault(); void save(draft); }}><section className="detail-section"><h3>车型规格</h3><div className="used-car-form-grid"><label><span>所属品牌</span><select aria-label="租赁车型所属品牌" value={draft.brandId} onChange={(event) => setDraft({ ...draft, brandId: event.target.value })}>{brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label><label><span>车型名称</span><input aria-label="租赁车型名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>车身类型</span><select aria-label="租赁车型车身类型" value={draft.bodyType} onChange={(event) => setDraft({ ...draft, bodyType: event.target.value as BodyType })}>{Object.entries(bodyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>能源类型</span><select aria-label="租赁车型能源类型" value={draft.energyType} onChange={(event) => setDraft({ ...draft, energyType: event.target.value as EnergyType })}>{Object.entries(energyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>变速箱</span><select aria-label="租赁车型变速箱" value={draft.transmission} onChange={(event) => setDraft({ ...draft, transmission: event.target.value as Transmission })}>{Object.entries(transmissionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>座位数</span><input aria-label="租赁车型座位数" type="number" min="2" max="9" value={draft.seats} onChange={(event) => setDraft({ ...draft, seats: numberValue(event.target.value) })} /></label><label><span>行李数</span><input aria-label="租赁车型行李数" type="number" min="0" max="8" value={draft.luggage} onChange={(event) => setDraft({ ...draft, luggage: numberValue(event.target.value) })} /></label><label><span>后台排序</span><input aria-label="租赁车型排序" type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: numberValue(event.target.value) })} /></label><label className="used-car-check wide"><input aria-label="租赁车型启用" type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /><span><strong>车型启用</strong><small>启用不代表有库存，是否可租仍由门店车队容量计算</small></span></label></div></section><section className="detail-section used-car-image-manager"><h3>车型实拍图</h3>{!draft.id ? <div className="used-car-image-empty"><Camera /><strong>先保存车型，再上传图片</strong><small>图片必须与当前车型真实对应</small></div> : <><label className={`used-car-upload ${uploading ? "busy" : ""}`}><UploadSimple /><span><strong>{uploading ? "图片上传中…" : "上传车型图片"}</strong><small>JPEG / PNG / WebP；首图自动作为封面</small></span><input aria-label="上传租赁车型图片" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => { void uploadImages(event.target.files); event.currentTarget.value = ""; }} /></label>{images.length ? <div className="used-car-image-grid">{images.map((image, index) => <figure key={image.id} className={image.isCover ? "cover" : ""}><img src={image.url} alt={`车型图片 ${index + 1}`} />{image.isCover ? <b><Star weight="fill" />封面</b> : null}<figcaption><span>第 {index + 1} 张</span><span className="used-car-image-actions"><button type="button" aria-label={`前移车型图片 ${index + 1}`} disabled={index === 0} onClick={() => move(image.id, -1)}><ArrowUp /></button><button type="button" aria-label={`后移车型图片 ${index + 1}`} disabled={index === images.length - 1} onClick={() => move(image.id, 1)}><ArrowDown /></button><button type="button" aria-label={`设为封面车型图片 ${index + 1}`} disabled={image.isCover} onClick={() => void persistImages(images, image.id)}><Star /></button><button type="button" aria-label={`删除车型图片 ${index + 1}`} onClick={() => void remove(image)}><Trash /></button></span></figcaption></figure>)}</div> : <div className="used-car-image-empty compact"><Image /><strong>还没有车型图片</strong><small>消费者端将显示明确的图片待维护状态</small></div>}</>}</section><footer className="used-car-editor-footer sticky"><span><CheckCircle />图片按车型维护，不与具体车牌绑定</span><button className="primary"><FloppyDisk />保存车型</button></footer></form></Drawer>;
}

function StoreEditor({ draft, setDraft, close, save }: { draft: StoreDraft; setDraft: (value: StoreDraft) => void; close: () => void; save: (draft: StoreDraft) => Promise<void> }) {
  const set = <K extends keyof StoreDraft>(key: K, value: StoreDraft[K]) => setDraft({ ...draft, [key]: value });
  return <Drawer label={draft.id ? "编辑租赁门店" : "新增租赁门店"} title={draft.id ? "编辑租赁门店" : "新增租赁门店"} description="同店取还；送车与取回使用同一地址" close={close} wide><form className="drawer-scroll used-car-editor" onSubmit={(event) => { event.preventDefault(); void save(draft); }}><section className="detail-section"><h3>门店资料</h3><div className="used-car-form-grid"><label><span>门店名称</span><input aria-label="租赁门店名称" value={draft.name} onChange={(event) => set("name", event.target.value)} /></label><label><span>行政区</span><input aria-label="租赁门店行政区" value={draft.district} onChange={(event) => set("district", event.target.value)} /></label><label className="wide"><span>门店地址</span><input aria-label="租赁门店地址" value={draft.address} onChange={(event) => set("address", event.target.value)} /></label><label><span>纬度</span><input aria-label="租赁门店纬度" type="number" step="0.000001" value={draft.latitude} onChange={(event) => set("latitude", numberValue(event.target.value))} /></label><label><span>经度</span><input aria-label="租赁门店经度" type="number" step="0.000001" value={draft.longitude} onChange={(event) => set("longitude", numberValue(event.target.value))} /></label><label><span>营业时间</span><input aria-label="租赁门店营业时间" value={draft.openHours} onChange={(event) => set("openHours", event.target.value)} /></label><label><span>联系电话</span><input aria-label="租赁门店联系电话" value={draft.phone} onChange={(event) => set("phone", event.target.value)} /></label><label><span>后台排序</span><input aria-label="租赁门店排序" type="number" value={draft.sortOrder} onChange={(event) => set("sortOrder", numberValue(event.target.value))} /></label><label className="used-car-check"><input aria-label="租赁门店启用" type="checkbox" checked={draft.isActive} onChange={(event) => set("isActive", event.target.checked)} /><span><strong>门店营业</strong><small>停用后不能产生新报价</small></span></label></div></section><section className="detail-section"><h3>同址送取定价</h3><div className="used-car-form-grid"><label><span>基础费用（元）</span><input aria-label="送取基础费用" value={money(draft.deliveryBaseFeeFen)} onChange={(event) => set("deliveryBaseFeeFen", fenValue(event.target.value))} /></label><label><span>基础包含单程公里</span><input aria-label="送取包含公里" type="number" value={draft.deliveryIncludedKm} onChange={(event) => set("deliveryIncludedKm", numberValue(event.target.value))} /></label><label><span>超出每公里（元）</span><input aria-label="送取每公里费用" value={money(draft.deliveryPerKmFen)} onChange={(event) => set("deliveryPerKmFen", fenValue(event.target.value))} /></label><label><span>最大服务半径（km）</span><input aria-label="送取最大服务半径" type="number" value={draft.deliveryMaxRadiusKm} onChange={(event) => set("deliveryMaxRadiusKm", numberValue(event.target.value))} /></label></div><div className="rental-policy-note"><MapPin /><span><strong>仅使用可信驾车路线</strong><small>无法取得真实路线、超出半径或规则缺失时，消费者端禁止生成送取报价。</small></span></div></section><footer className="used-car-editor-footer sticky"><span><WarningCircle />调价只影响新报价，不改写历史快照</span><button className="primary"><FloppyDisk />保存门店</button></footer></form></Drawer>;
}

function VehicleEditor({ draft, setDraft, models, stores, close, save }: { draft: VehicleDraft; setDraft: (value: VehicleDraft) => void; models: Model[]; stores: Store[]; close: () => void; save: (draft: VehicleDraft) => Promise<void> }) {
  return <Drawer label={draft.id ? "编辑车队车辆" : "新增车队车辆"} title={draft.id ? `编辑 ${draft.stockNo}` : "新增车队车辆"} description="具体车辆仅供运营分配，不在消费者端展示" close={close}><form className="drawer-scroll used-car-editor" onSubmit={(event) => { event.preventDefault(); void save(draft); }}><section className="detail-section used-car-form-grid"><label><span>库存编号</span><input aria-label="租赁车辆库存编号" value={draft.stockNo} onChange={(event) => setDraft({ ...draft, stockNo: event.target.value })} /></label><label><span>指定车型</span><select aria-label="租赁车辆车型" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}>{models.filter((item) => item.isActive || item.id === draft.modelId).map((model) => <option value={model.id} key={model.id}>{model.brandName} · {model.name}</option>)}</select></label><label><span>所属门店</span><select aria-label="租赁车辆门店" value={draft.storeId} onChange={(event) => setDraft({ ...draft, storeId: event.target.value })}>{stores.filter((item) => item.isActive || item.id === draft.storeId).map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label><label><span>完整车牌（仅后台）</span><input aria-label="租赁车辆完整车牌" value={draft.plateNumber || ""} placeholder={draft.plateMasked ? `当前：${draft.plateMasked}` : "例如：津A12345"} onChange={(event) => setDraft({ ...draft, plateNumber: event.target.value })} /></label><label><span>车辆颜色</span><input aria-label="租赁车辆颜色" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label><label><span>年款</span><input aria-label="租赁车辆年款" type="number" value={draft.modelYear} onChange={(event) => setDraft({ ...draft, modelYear: numberValue(event.target.value) })} /></label><label><span>当前里程（km）</span><input aria-label="租赁车辆里程" type="number" value={draft.mileageKm} onChange={(event) => setDraft({ ...draft, mileageKm: numberValue(event.target.value) })} /></label><label><span>运营状态</span><select aria-label="租赁车辆状态" value={draft.status} disabled={draft.status === "retired"} onChange={(event) => setDraft({ ...draft, status: event.target.value as VehicleStatus })}>{Object.entries(vehicleStatusLabels).filter(([value]) => value !== "retired" || draft.status === "retired").map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></section><div className="rental-policy-note"><ShieldCheck /><span><strong>车辆退役不可逆</strong><small>有历史订单的车辆不硬删除；退役后保留订单、分配和事件记录。</small></span></div><footer className="used-car-editor-footer"><span><CheckCircle />可租数量由时间冲突实时计算</span><button className="primary"><FloppyDisk />保存车辆</button></footer></form></Drawer>;
}

function RateEditor({ draft, setDraft, models, stores, close, save }: { draft: RateDraft; setDraft: (value: RateDraft) => void; models: Model[]; stores: Store[]; close: () => void; save: (draft: RateDraft) => Promise<void> }) {
  const yuan = (key: keyof RateDraft, value: string) => setDraft({ ...draft, [key]: fenValue(value) }); const preview = draft.weekdayRateFen * 2 + draft.weekendRateFen + draft.basicProtectionDailyFen * 3 + draft.prepFeeFen;
  return <Drawer label={draft.id ? "编辑租赁价格" : "新增租赁价格"} title={draft.id ? "编辑租赁价格" : "新增租赁价格"} description="服务端统一计价，客户端不提交可信价格" close={close} wide><form className="drawer-scroll used-car-editor" onSubmit={(event) => { event.preventDefault(); void save(draft); }}><section className="detail-section"><h3>价格范围</h3><div className="used-car-form-grid"><label><span>车型</span><select aria-label="租赁价格车型" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}>{models.filter((item) => item.isActive || item.id === draft.modelId).map((model) => <option value={model.id} key={model.id}>{model.brandName} · {model.name}</option>)}</select></label><label><span>门店范围</span><select aria-label="租赁价格门店" value={draft.storeId || ""} onChange={(event) => setDraft({ ...draft, storeId: event.target.value || null })}><option value="">全部门店默认价</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label><label><span>工作日日租（元）</span><input aria-label="工作日日租价" value={money(draft.weekdayRateFen)} onChange={(event) => yuan("weekdayRateFen", event.target.value)} /></label><label><span>周末日租（元）</span><input aria-label="周末日租价" value={money(draft.weekendRateFen)} onChange={(event) => yuan("weekendRateFen", event.target.value)} /></label><label><span>基础保障（元/天）</span><input aria-label="基础保障日费" value={money(draft.basicProtectionDailyFen)} onChange={(event) => yuan("basicProtectionDailyFen", event.target.value)} /></label><label><span>整备费（元/单）</span><input aria-label="整备费用" value={money(draft.prepFeeFen)} onChange={(event) => yuan("prepFeeFen", event.target.value)} /></label><label><span>安心保障（元/天）</span><input aria-label="安心保障日费" value={money(draft.optionalProtectionDailyFen)} onChange={(event) => yuan("optionalProtectionDailyFen", event.target.value)} /></label><label className="used-car-check"><input aria-label="租赁价格启用" type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /><span><strong>价格生效</strong><small>停用后不可生成新报价</small></span></label></div></section><section className="detail-section"><h3>押金与用车政策</h3><div className="used-car-form-grid"><label><span>车辆押金（元）</span><input aria-label="车辆押金" value={money(draft.vehicleDepositFen)} onChange={(event) => yuan("vehicleDepositFen", event.target.value)} /></label><label><span>违章押金（元）</span><input aria-label="违章押金" value={money(draft.violationDepositFen)} onChange={(event) => yuan("violationDepositFen", event.target.value)} /></label><label><span>每日包含里程（km）</span><input aria-label="每日包含里程" type="number" value={draft.includedMileageKmPerDay} onChange={(event) => setDraft({ ...draft, includedMileageKmPerDay: numberValue(event.target.value) })} /></label><label><span>超里程费（元/km）</span><input aria-label="超里程费用" value={money(draft.overagePerKmFen)} onChange={(event) => yuan("overagePerKmFen", event.target.value)} /></label><label className="wide"><span>油量 / 电量归还政策</span><textarea aria-label="油电归还政策" value={draft.fuelPolicy} onChange={(event) => setDraft({ ...draft, fuelPolicy: event.target.value })} /></label><label className="wide"><span>取消政策</span><textarea aria-label="租车取消政策" value={draft.cancellationPolicy} onChange={(event) => setDraft({ ...draft, cancellationPolicy: event.target.value })} /></label></div></section><section className="rental-price-preview"><span><CurrencyCny /></span><div><small>3 天应付预览（2 工作日 + 1 周末）</small><strong>¥{money(preview)}</strong><p>车辆租金 ¥{money(draft.weekdayRateFen * 2 + draft.weekendRateFen)} + 基础保障 ¥{money(draft.basicProtectionDailyFen * 3)} + 整备费 ¥{money(draft.prepFeeFen)}</p></div><em>押金 ¥{money(draft.vehicleDepositFen + draft.violationDepositFen)} 单独模拟预授权</em></section><footer className="used-car-editor-footer sticky"><span><WarningCircle />调价不改写已生成报价与历史订单</span><button className="primary"><FloppyDisk />保存价格</button></footer></form></Drawer>;
}

function OrderDrawer({ order, vehicles, close, refresh, onError }: { order: RentalOrder; vehicles: Vehicle[]; close: () => void; refresh: () => void; onError: (message: string) => void }) {
  const [vehicleId, setVehicleId] = useState(order.assignedVehicle?.id || ""); const [nextStatus, setNextStatus] = useState<OrderStatus | "">(orderTransitions[order.status]?.[0] || ""); const [internalNote, setInternalNote] = useState(order.internalNote || ""); const [feeYuan, setFeeYuan] = useState(""); const [feeNote, setFeeNote] = useState(""); const [saving, setSaving] = useState(false);
  const eligible = vehicles.filter((vehicle) => vehicle.status === "active" && (!order.modelId || vehicle.modelId === order.modelId || vehicle.modelId === order.model?.id) && (!order.storeId || vehicle.storeId === order.storeId || vehicle.storeId === order.store?.id));
  const act = async (task: () => Promise<unknown>) => { setSaving(true); try { await task(); refresh(); } catch (error) { onError(errorText(error)); } finally { setSaving(false); } };
  const total = orderTotalFen(order);
  return <Drawer label="租车订单详情" title={order.orderNo || order.orderNumber || "租车订单"} description={`${orderStatusLabels[order.status]} · ${order.serviceMode === "home_delivery" ? "同址送取" : "同店取还"}`} close={close} wide><div className="drawer-scroll used-car-editor rental-order-drawer"><section className="rental-order-summary"><span><small>指定车型</small><strong>{order.model?.name || "待同步"}</strong></span><span><small>租期</small><strong>{order.billableDays} 天</strong></span><span><small>应付（模拟）</small><strong>¥{money(total)}</strong></span><span><small>分配车辆</small><strong>{order.assignedVehicle?.stockNo || order.assignedVehicle?.plateMasked || "待分配"}</strong></span></section><section className="detail-section"><h3>驾驶员与租期</h3><dl className="rental-detail-list"><div><dt>驾驶员</dt><dd>{order.driverName} · {order.driverPhoneMasked}</dd></div><div><dt>取车时间</dt><dd>{new Date(order.pickupAt).toLocaleString("zh-CN")}</dd></div><div><dt>还车时间</dt><dd>{new Date(order.returnAt).toLocaleString("zh-CN")}</dd></div><div><dt>履约门店</dt><dd>{order.store?.name || "待同步"}</dd></div></dl></section><section className="detail-section"><h3>费用与押金快照</h3><dl className="rental-detail-list money-list"><div><dt>车辆租金</dt><dd>¥{money(order.feeBreakdown?.rentalFeeFen ?? order.feeBreakdown?.vehicleRentFen)}</dd></div><div><dt>基础保障</dt><dd>¥{money(order.feeBreakdown?.basicProtectionFeeFen ?? order.feeBreakdown?.basicProtectionFen)}</dd></div><div><dt>整备费</dt><dd>¥{money(order.feeBreakdown?.prepFeeFen)}</dd></div><div><dt>安心保障</dt><dd>¥{money(order.feeBreakdown?.optionalProtectionFeeFen ?? order.feeBreakdown?.optionalProtectionFen)}</dd></div><div><dt>送取费</dt><dd>¥{money(order.feeBreakdown?.deliveryFeeFen)}</dd></div><div><dt>附加费</dt><dd>¥{money(orderAdjustmentFen(order))}</dd></div><div className="total"><dt>应付合计</dt><dd>¥{money(total)}</dd></div><div><dt>车辆押金（模拟预授权）</dt><dd>¥{money(order.deposits?.vehicleDepositFen)}</dd></div><div><dt>违章押金（模拟预授权）</dt><dd>¥{money(order.deposits?.violationDepositFen)}</dd></div></dl></section><section className="detail-section"><h3>车辆分配与状态推进</h3><div className="rental-action-row"><select aria-label="订单分配车辆" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}><option value="">请选择同门店同车型车辆</option>{eligible.map((vehicle) => <option value={vehicle.id} key={vehicle.id}>{vehicle.stockNo} · {vehicle.plateMasked}</option>)}</select><button disabled={!vehicleId || saving} onClick={() => void act(() => api(`/admin/car-rental/orders/${order.id}/assign-vehicle`, { method: "POST", body: JSON.stringify({ vehicleId }) }))}>分配车辆</button></div><div className="rental-action-row"><select aria-label="租车订单下一状态" value={nextStatus} onChange={(event) => setNextStatus(event.target.value as OrderStatus)}><option value="">无可用状态动作</option>{(orderTransitions[order.status] || []).map((status) => <option value={status} key={status}>{orderStatusLabels[status]}</option>)}</select><button disabled={!nextStatus || saving} onClick={() => void act(() => api(`/admin/car-rental/orders/${order.id}/transition`, { method: "POST", body: JSON.stringify({ status: nextStatus, note: "运营后台人工推进" }) }))}>推进状态</button></div></section><section className="detail-section"><h3>附加费与内部备注</h3><div className="used-car-form-grid"><label><span>附加费（元，可为负数）</span><input aria-label="租车订单附加费" inputMode="decimal" value={feeYuan} onChange={(event) => setFeeYuan(event.target.value)} /></label><label><span>附加费原因</span><input aria-label="租车订单附加费原因" value={feeNote} onChange={(event) => setFeeNote(event.target.value)} placeholder="超时、油电差额或人工减免" /></label></div><button className="rental-inline-primary" disabled={!feeYuan || !feeNote.trim() || saving} onClick={() => void act(() => api(`/admin/car-rental/orders/${order.id}/adjustments`, { method: "POST", body: JSON.stringify({ amountFen: fenValue(feeYuan), note: feeNote.trim() }) }))}><Plus />登记附加费</button><label className="rental-note-field"><span>内部备注</span><textarea aria-label="租车订单内部备注" value={internalNote} onChange={(event) => setInternalNote(event.target.value)} /></label><button className="rental-inline-primary" disabled={saving} onClick={() => void act(() => api(`/admin/car-rental/orders/${order.id}/internal-note`, { method: "PUT", body: JSON.stringify({ internalNote }) }))}><FloppyDisk />保存内部备注</button></section><section className="detail-section"><h3>订单事件</h3><div className="rental-event-list">{(order.events || []).map((event) => { const eventStatus = event.toStatus || event.status; return <div key={event.id}><i /><span><strong>{eventStatus ? orderStatusLabels[eventStatus as OrderStatus] || eventStatus : event.type || "订单事件"}</strong><small>{event.note || "系统记录"}</small></span><time>{new Date(event.createdAt).toLocaleString("zh-CN")}</time></div>; })}{!order.events?.length ? <div className="rental-empty-inline">暂无事件记录</div> : null}</div></section></div></Drawer>;
}
