import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Car,
  CaretRight,
  CheckCircle,
  CircleNotch,
  ClockCounterClockwise,
  Eye,
  FileText,
  IdentificationBadge,
  LinkSimple,
  MagnifyingGlass,
  NotePencil,
  ShieldCheck,
  Tag,
  UserCircle,
  Users,
  X,
} from "@phosphor-icons/react";
import { money } from "./adminApi";
import { operatorErrorMessage } from "./operatorError";
import {
  customerAdminApi,
  customerAdminTags as fixedCustomerTags,
  type CustomerActivity,
  type CustomerBusinessRecord,
  type CustomerDataKind,
  type CustomerDetail,
  type CustomerIdentity,
  type CustomerListItem,
  type CustomerListResponse,
  type CustomerMaterial,
  type CustomerNote,
  type CustomerSummary,
  type CustomerVehicle,
  type RevealedIdentity,
} from "./customerAdminApi";

type DetailTab = "overview" | "vehicles" | "records" | "materials" | "access";
type Navigate = (path: string) => void;

const emptySummary: CustomerSummary = { real: 0, demo: 0, unknown: 0, wechatBound: 0, withBusinessRecords: 0 };

const domainLabels: Record<string, string> = {
  annual_inspection: "年检服务",
  inspection: "年检服务",
  car_wash: "洗车服务",
  wash: "洗车服务",
  car_rental: "汽车租赁",
  rental: "汽车租赁",
  repair: "维修报价",
  insurance: "车险服务",
  driving_school: "驾校咨询",
  subsidy_consultation: "补贴咨询",
  subsidy: "补贴咨询",
  vehicle_checkup: "车辆体检资料",
};

const statusLabels: Record<string, string> = {
  active: "正常",
  disabled: "已停用",
  inactive: "未启用",
  suspended: "已暂停",
  pending_payment: "待支付",
  paid_pending_confirmation: "历史待确认（自动恢复）",
  pending_precheck: "待检测站预审",
  precheck_rejected: "预审未通过",
  refund_pending: "退款处理中",
  refund_failed: "退款失败",
  confirmed: "已确认",
  driver_arranged: "司机已安排",
  picked_up: "已取车",
  awaiting_arrival: "等待到站",
  checked_in: "车辆已到站",
  inspecting: "检测中",
  result_received: "结果已回传",
  returning: "送回中",
  completed: "已完成",
  on_hold: "异常挂起",
  cancelled: "已取消",
  no_show: "未到站",
  refunded: "已退款",
  new: "待处理",
  contacting: "跟进中",
  resolved: "已解决",
  closed: "已关闭",
  withdrawn: "已撤回",
  available: "可查看",
  active_material: "有效",
  retained: "留存中",
  expired: "已过期",
  deleted: "已清理",
  withdrawn_material: "已撤回",
  paid: "已支付",
};
const materialStateLabels: Record<string, string> = { active: "有效", retained: "留存中", withdrawn: "已撤回", expired: "已过期", deleted: "已清理" };
const customerVehicleTypeLabels: Record<string, string> = {
  sedan: "轿车",
  suv: "SUV",
  mpv: "MPV",
  suv_mpv: "SUV / MPV",
  hatchback: "两厢车",
  coupe: "跑车",
  pickup: "皮卡",
  van: "面包车",
};

function customerVehicleTypeLabel(value?: string | null) {
  return value ? customerVehicleTypeLabels[value.toLowerCase()] || "车辆类型待核对" : "车辆类型未填写";
}

function authorizationVersionLabel(value?: string | null) {
  if (!value) return "未记录";
  if (/[\u3400-\u9fff]/u.test(value)) return value;
  const versionNumber = value.match(/(?:^|[-_])v(?:ersion)?[-_]?(\d+)(?:$|[-_])/i)?.[1] ?? value.match(/\d+/)?.[0];
  return versionNumber ? `第 ${versionNumber} 版` : "已记录";
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberOf(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOf(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function nullableText(value: unknown) {
  const text = textOf(value).trim();
  return text || null;
}

function stringsOf(value: unknown) {
  return listOf(value).filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function normalizeDataKind(value: unknown): CustomerDataKind {
  return value === "real" || value === "demo" ? value : "unknown";
}

function normalizeCustomer(value: unknown): CustomerListItem {
  const item = objectOf(value);
  const identity = objectOf(item.identity);
  const customerNumber = textOf(item.customerNumber ?? item.customer_number, "—");
  return {
    id: textOf(item.id ?? item.userId ?? item.user_id),
    customerNumber,
    displayName: textOf(item.displayName ?? item.nickname ?? item.nickName ?? item.name, customerNumber === "—" ? "未设置昵称" : customerNumber),
    avatarUrl: nullableText(item.avatarUrl ?? item.avatar_url),
    status: textOf(item.status, "active"),
    dataKind: normalizeDataKind(item.dataKind ?? item.data_kind),
    identity: {
      bound: boolOf(identity.bound ?? item.wechatBound ?? item.identityBound),
      provider: nullableText(identity.provider),
      maskedSubject: nullableText(identity.maskedSubject ?? identity.maskedProviderSubject ?? item.maskedProviderSubject),
    },
    tags: stringsOf(item.tags),
    vehicleCount: numberOf(item.vehicleCount ?? item.vehicle_count),
    recordCount: numberOf(item.recordCount ?? item.record_count),
    pendingCount: numberOf(item.pendingCount ?? item.pending_count),
    lastActiveAt: nullableText(item.lastActiveAt ?? item.last_active_at),
    createdAt: nullableText(item.createdAt ?? item.created_at),
  };
}

function normalizeSummary(value: unknown): CustomerSummary {
  const summary = objectOf(value);
  return {
    real: numberOf(summary.real ?? summary.realCustomers),
    demo: numberOf(summary.demo ?? summary.demoCustomers),
    unknown: numberOf(summary.unknown ?? summary.unknownCustomers),
    wechatBound: numberOf(summary.wechatBound ?? summary.wechat_bound ?? summary.bound),
    withBusinessRecords: numberOf(summary.withBusinessRecords ?? summary.with_business_records ?? summary.business),
  };
}

function normalizeCustomerList(value: unknown): CustomerListResponse {
  if (Array.isArray(value)) return { items: value.map(normalizeCustomer), summary: emptySummary, nextCursor: null };
  const payload = objectOf(value);
  const items = listOf(payload.items ?? payload.customers).map(normalizeCustomer).filter((item) => Boolean(item.id));
  return { items, summary: normalizeSummary(payload.summary ?? payload.metrics), nextCursor: nullableText(payload.nextCursor ?? payload.next_cursor) };
}

function normalizeIdentity(value: unknown): CustomerIdentity {
  const item = objectOf(value);
  return {
    id: textOf(item.id),
    provider: textOf(item.provider, "wechat"),
    providerAppId: nullableText(item.providerAppId ?? item.provider_app_id),
    maskedProviderSubject: nullableText(item.maskedProviderSubject ?? item.masked_provider_subject ?? item.maskedSubject),
    maskedUnionSubject: nullableText(item.maskedUnionSubject ?? item.masked_union_subject),
    boundAt: nullableText(item.boundAt ?? item.bound_at ?? item.createdAt),
  };
}

function normalizeNote(value: unknown): CustomerNote {
  const item = objectOf(value);
  const author = objectOf(item.author);
  return {
    id: textOf(item.id),
    content: textOf(item.content ?? item.note),
    author: { id: nullableText(author.id) ?? undefined, displayName: nullableText(author.displayName ?? author.name) ?? undefined },
    createdAt: nullableText(item.createdAt ?? item.created_at),
  };
}

function normalizeVehicle(value: unknown): CustomerVehicle {
  const item = objectOf(value);
  const brand = objectOf(item.brand);
  const model = objectOf(item.model);
  return {
    id: textOf(item.id),
    plateNumber: textOf(item.plateNumber ?? item.plate_number, "未填写车牌"),
    brandName: nullableText(item.brandName ?? item.brand_name ?? brand.name),
    modelName: nullableText(item.modelName ?? item.model_name ?? model.name),
    vehicleType: nullableText(item.vehicleType ?? item.vehicle_type),
    seats: typeof (item.seats ?? item.seatCount) === "number" ? Number(item.seats ?? item.seatCount) : null,
    isDefault: boolOf(item.isDefault ?? item.is_default),
    isDeleted: boolOf(item.isDeleted ?? item.is_deleted ?? item.deleted),
    inspectionValidUntil: nullableText(item.inspectionValidUntil ?? item.inspection_valid_until),
    nextInspectionDate: nullableText(item.nextInspectionDate ?? item.next_inspection_date),
    lastServiceAt: nullableText(item.lastServiceAt ?? item.last_service_at ?? objectOf(item.recentService).occurredAt),
    updatedAt: nullableText(item.updatedAt ?? item.updated_at),
  };
}

function normalizeRecord(value: unknown): CustomerBusinessRecord {
  const item = objectOf(value);
  return {
    domain: textOf(item.domain ?? item.serviceType, "unknown"),
    recordType: textOf(item.recordType ?? item.record_type ?? item.type, "record"),
    sourceId: textOf(item.sourceId ?? item.source_id ?? item.id),
    businessCode: textOf(item.businessCode ?? item.business_code ?? item.orderNumber ?? item.code, "—"),
    vehicleId: nullableText(item.vehicleId ?? item.vehicle_id),
    status: textOf(item.status, "unknown"),
    amountFen: typeof (item.amountFen ?? item.amount_fen) === "number" ? Number(item.amountFen ?? item.amount_fen) : null,
    occurredAt: nullableText(item.occurredAt ?? item.occurred_at ?? item.createdAt),
    detailPath: nullableText(item.detailPath ?? item.detail_path),
    title: nullableText(item.title ?? item.name),
  };
}

function normalizeActivity(value: unknown): CustomerActivity {
  const item = objectOf(value);
  return {
    id: textOf(item.id),
    type: nullableText(item.type ?? item.action),
    label: textOf(item.label ?? item.title ?? item.action, "系统记录"),
    description: nullableText(item.description),
    occurredAt: nullableText(item.occurredAt ?? item.occurred_at ?? item.createdAt),
    actorName: nullableText(item.actorName ?? item.actor_name),
    domain: nullableText(item.domain),
    resourceId: nullableText(item.resourceId ?? item.resource_id),
    outcome: nullableText(item.outcome ?? item.result),
  };
}

function normalizeCustomerDetail(value: unknown): CustomerDetail {
  const payload = objectOf(value);
  const customer = normalizeCustomer(payload.customer ?? payload.user ?? payload);
  const statsRaw = objectOf(payload.stats);
  const tags = stringsOf(payload.tags).length ? stringsOf(payload.tags) : customer.tags;
  const vehicles = listOf(payload.vehicles).map(normalizeVehicle);
  const recentRecords = listOf(payload.recentRecords ?? payload.records).map(normalizeRecord);
  return {
    customer: { ...customer, tags, updatedAt: nullableText(objectOf(payload.customer ?? payload.user).updatedAt) },
    identities: listOf(payload.identities).map(normalizeIdentity).filter((item) => Boolean(item.id)),
    tags,
    notes: listOf(payload.notes).map(normalizeNote),
    stats: {
      vehicles: numberOf(statsRaw.vehicles, vehicles.length || customer.vehicleCount),
      records: numberOf(statsRaw.records, customer.recordCount),
      pending: numberOf(statsRaw.pending, customer.pendingCount),
    },
    vehicles,
    recentRecords,
    recentActivity: listOf(payload.recentActivity ?? payload.activities ?? payload.auditEvents).map(normalizeActivity),
  };
}

function normalizeMaterial(value: unknown): CustomerMaterial {
  const item = objectOf(value);
  const authorization = objectOf(item.authorization);
  return {
    id: textOf(item.id),
    domain: textOf(item.domain, "unknown"),
    businessId: nullableText(item.businessId ?? item.business_id),
    businessCode: nullableText(item.businessCode ?? item.business_code),
    kind: textOf(item.kind ?? item.materialType, "material"),
    label: nullableText(item.label ?? item.name),
    state: textOf(item.state ?? item.status, "unknown"),
    mimeType: nullableText(item.mimeType ?? item.mime_type),
    sizeBytes: typeof (item.sizeBytes ?? item.size_bytes) === "number" ? Number(item.sizeBytes ?? item.size_bytes) : null,
    createdAt: nullableText(item.createdAt ?? item.created_at),
    expiresAt: nullableText(item.expiresAt ?? item.expires_at),
    deleteAfter: nullableText(item.deleteAfter ?? item.delete_after ?? item.retainUntil),
    available: boolOf(item.available, !["deleted", "expired", "withdrawn", "cleaned"].includes(textOf(item.state ?? item.status))),
    purpose: nullableText(item.purpose ?? authorization.purpose),
    authorizationVersion: nullableText(item.authorizationVersion ?? item.authorization_version ?? item.consentVersion ?? authorization.version),
    consentVersion: nullableText(item.consentVersion ?? item.consent_version),
    retention: nullableText(item.retention ?? item.retentionPolicy ?? item.retention_policy ?? authorization.retention),
  };
}

function normalizeCursorList<T>(value: unknown, normalize: (item: unknown) => T): { items: T[]; nextCursor: string | null } {
  if (Array.isArray(value)) return { items: value.map(normalize), nextCursor: null };
  const payload = objectOf(value);
  return { items: listOf(payload.items ?? payload.records ?? payload.materials).map(normalize), nextCursor: nullableText(payload.nextCursor ?? payload.next_cursor) };
}

function localDate(value: string | null | undefined, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待核对";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date).replaceAll("/", "-");
}

function bytes(value: number | null | undefined) {
  if (value == null) return "大小未记录";
  if (value < 1024) return `${value} 字节`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} 千字节`;
  return `${(value / 1024 / 1024).toFixed(1)} 兆字节`;
}

function labelForDomain(value: string) { return domainLabels[value] || "其他业务"; }
function labelForStatus(value: string) { return statusLabels[value] || "状态待核对"; }
function labelForMaterialState(value: string) { return materialStateLabels[value] || "状态待核对"; }
function labelForRecordType(value: string) {
  const labels: Record<string, string> = { order: "订单", booking: "预约", inquiry: "咨询", lead: "线索", consultation: "咨询", quote_request: "报价需求", quote: "报价", report: "报告", service: "服务" };
  return labels[value] || "业务记录";
}
function labelForMaterialType(value: string | null | undefined) {
  if (!value) return "文件类型未记录";
  if (value.startsWith("image/")) return "图片";
  if (value === "application/pdf") return "文档";
  if (value.startsWith("video/")) return "视频";
  return "其他文件";
}

function Avatar({ customer }: { customer: CustomerListItem }) {
  const initial = customer.displayName.trim().slice(0, 1) || "客";
  return <span className={`customer-avatar ${customer.dataKind}`}>{customer.avatarUrl ? <img src={customer.avatarUrl} alt="" /> : initial}</span>;
}

function DataKindPill({ value }: { value: CustomerDataKind }) {
  return <span className={`customer-kind-pill ${value}`}>{value === "real" ? "真实客户" : value === "demo" ? "演示客户" : "待识别"}</span>;
}

function CustomerEmpty({ title, description }: { title: string; description: string }) {
  return <div className="customer-empty"><span><FileText weight="duotone" /></span><strong>{title}</strong><p>{description}</p></div>;
}

export function CustomersPage({ onNavigate, onError }: { onNavigate: Navigate; onError: (message: string) => void }) {
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [summary, setSummary] = useState<CustomerSummary>(emptySummary);
  const [filters, setFilters] = useState({ q: "", status: "", dataKind: "", serviceType: "", activeWithinDays: "", tag: "" });
  const [debouncedQ, setDebouncedQ] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageNumber, setPageNumber] = useState(1);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(filters.q.trim()), 260);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const resetCursor = useCallback(() => {
    setCursor(null);
    setCursorHistory([]);
    setPageNumber(1);
  }, []);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const payload = normalizeCustomerList(await customerAdminApi.list({
        q: debouncedQ,
        status: filters.status,
        dataKind: filters.dataKind,
        serviceType: filters.serviceType,
        activeWithinDays: filters.activeWithinDays as "" | "7" | "30" | "90",
        tag: filters.tag,
        cursor,
        limit: 20,
      }));
      if (generation !== requestGeneration.current) return;
      setCustomers(payload.items);
      setSummary(payload.summary);
      setNextCursor(payload.nextCursor ?? null);
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      onError(operatorErrorMessage(reason, "客户列表读取失败，请稍后重试"));
      setCustomers([]);
      setNextCursor(null);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [cursor, debouncedQ, filters.activeWithinDays, filters.dataKind, filters.serviceType, filters.status, filters.tag, onError]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { resetCursor(); }, [debouncedQ, filters.status, filters.dataKind, filters.serviceType, filters.activeWithinDays, filters.tag, resetCursor]);

  const updateFilter = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const clearFilters = () => {
    setFilters({ q: "", status: "", dataKind: "", serviceType: "", activeWithinDays: "", tag: "" });
    setDebouncedQ("");
    resetCursor();
  };
  const hasFilters = Boolean(filters.q || filters.status || filters.dataKind || filters.serviceType || filters.activeWithinDays || filters.tag);
  const nextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(nextCursor);
    setPageNumber((page) => page + 1);
  };
  const previousPage = () => {
    if (!cursorHistory.length) return;
    const previous = cursorHistory[cursorHistory.length - 1] ?? null;
    setCursorHistory((history) => history.slice(0, -1));
    setCursor(previous);
    setPageNumber((page) => Math.max(1, page - 1));
  };

  return <div className="customer-center customer-list-page" aria-label="客户中心">
    <section className="customer-metrics" aria-label="客户指标">
      <article><span><Users weight="duotone" /></span><div><small>真实客户</small><strong>{summary.real}<em> 人</em></strong><p>微信真实身份与业务客户</p></div></article>
      <article><span><UserCircle weight="duotone" /></span><div><small>演示客户</small><strong>{summary.demo}<em> 人</em></strong><p>与真实客户数据完全隔离</p></div></article>
      <article><span><IdentificationBadge weight="duotone" /></span><div><small>已绑定微信身份</small><strong>{summary.wechatBound}<em> 人</em></strong><p>默认仅显示脱敏标识</p></div></article>
      <article><span><ClockCounterClockwise weight="duotone" /></span><div><small>有业务记录</small><strong>{summary.withBusinessRecords}<em> 人</em></strong><p>车辆、订单或服务记录</p></div></article>
    </section>

    <section className="content-card customer-list-card">
      <header className="customer-card-heading"><div><small>客户全景档案</small><h2>客户档案</h2><p>以客户主键聚合各业务数据，不复制订单、车辆或资料。</p></div><span><ShieldCheck weight="duotone" />默认脱敏 · 服务端鉴权</span></header>
      <div className="customer-filters" aria-label="客户筛选">
        <label className="customer-search"><MagnifyingGlass /><input aria-label="搜索客户" value={filters.q} onChange={(event) => updateFilter("q", event.target.value)} placeholder="客户编号、昵称、车牌、订单或服务编号" /></label>
        <select aria-label="客户数据类型" value={filters.dataKind} onChange={(event) => updateFilter("dataKind", event.target.value)}><option value="">全部身份</option><option value="real">真实客户</option><option value="demo">演示客户</option><option value="unknown">待识别</option></select>
        <select aria-label="客户账号状态" value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}><option value="">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option></select>
        <select aria-label="客户业务类型" value={filters.serviceType} onChange={(event) => updateFilter("serviceType", event.target.value)}><option value="">全部业务</option>{Object.entries(domainLabels).filter(([key]) => ["annual_inspection", "car_wash", "car_rental", "repair", "insurance", "driving_school", "subsidy_consultation"].includes(key)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="客户最近活跃" value={filters.activeWithinDays} onChange={(event) => updateFilter("activeWithinDays", event.target.value)}><option value="">全部活跃时间</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select>
        <select aria-label="客户内部标签" value={filters.tag} onChange={(event) => updateFilter("tag", event.target.value)}><option value="">全部标签</option>{fixedCustomerTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select>
        <button type="button" className="customer-clear-filter" disabled={!hasFilters} onClick={clearFilters}>清空</button>
      </div>
      <div className="table-wrap customer-table-wrap"><table><thead><tr><th>客户</th><th>身份</th><th>内部标签</th><th>车辆 / 业务</th><th>当前待办</th><th>最近活动</th><th>账号状态</th><th /></tr></thead><tbody>{customers.map((customer) => <tr key={customer.id}>
        <td><div className="customer-table-person"><Avatar customer={customer} /><span><strong>{customer.displayName}</strong><small>{customer.customerNumber}</small></span></div></td>
        <td><DataKindPill value={customer.dataKind} /><small className="identity-state">{customer.identity.bound ? <>微信已绑定 · {customer.identity.maskedSubject || "已脱敏"}</> : "未绑定微信身份"}</small></td>
        <td><div className="customer-inline-tags">{customer.tags.length ? customer.tags.map((tag) => <span key={tag}>{tag}</span>) : <small>暂无内部标签</small>}</div></td>
        <td><strong>{customer.vehicleCount} 辆车 · {customer.recordCount} 条记录</strong><small>跨业务聚合，不修改源数据</small></td>
        <td><strong className={customer.pendingCount ? "customer-pending" : ""}>{customer.pendingCount} 项</strong><small>{customer.pendingCount ? "需要运营关注" : "暂无待处理"}</small></td>
        <td><strong>{localDate(customer.lastActiveAt)}</strong><small>{customer.lastActiveAt ? "最近一次业务或后台活动" : "尚无活动时间"}</small></td>
        <td><span className={`customer-account-state ${customer.status}`}>{labelForStatus(customer.status)}</span></td>
        <td><button className="customer-open-detail" aria-label={`查看客户 ${customer.displayName}`} onClick={() => onNavigate(`/customers/${encodeURIComponent(customer.id)}`)}>查看<CaretRight /></button></td>
      </tr>)}</tbody></table>
        {loading ? <div className="table-loading">正在读取客户档案…</div> : null}
        {!loading && !customers.length ? <CustomerEmpty title={hasFilters ? "没有符合条件的客户" : "暂时没有客户档案"} description={hasFilters ? "可以调整搜索词或筛选条件；系统不会用演示数据填充空结果。" : "小程序产生真实身份或业务记录后，客户会出现在这里。"} /> : null}
      </div>
      <footer className="customer-cursor-pagination"><span>第 {pageNumber} 页 · 每页最多 20 人</span><div><button disabled={!cursorHistory.length || loading} onClick={previousPage}><ArrowLeft />上一页</button><button disabled={!nextCursor || loading} onClick={nextPage}>下一页<ArrowRight /></button></div></footer>
    </section>
  </div>;
}

function IdentityRevealDialog({ identity, close }: { identity: RevealedIdentity; close: () => void }) {
  return <div className="customer-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="customer-sensitive-dialog" role="dialog" aria-modal="true" aria-label="完整微信身份标识">
    <header><div><small>敏感身份信息</small><h2>完整微信身份标识</h2></div><button aria-label="关闭完整身份标识" onClick={close}><X /></button></header>
    <div className="customer-sensitive-warning"><ShieldCheck weight="fill" /><p><strong>本次查看已记录到操作日志</strong><span>请仅在处理身份归属问题时使用，不要复制到工单备注或其他非受控位置。</span></p></div>
    <dl><div><dt>身份来源</dt><dd>{identity.provider === "wechat" ? "微信小程序" : "其他身份来源"}</dd></div><div><dt>微信应用编号</dt><dd><code>{identity.providerAppId || "—"}</code></dd></div><div><dt>微信用户标识</dt><dd><code>{identity.providerSubject || "—"}</code></dd></div><div><dt>微信跨应用标识</dt><dd><code>{identity.unionSubject || "未返回 / 未绑定"}</code></dd></div></dl>
    <footer><button onClick={close}>关闭敏感信息</button></footer>
  </section></div>;
}

function CustomerOverview({ detail, onNavigate, onReveal, onToggleTag, savingTags, noteText, setNoteText, addNote, savingNote }: {
  detail: CustomerDetail;
  onNavigate: Navigate;
  onReveal: (identity: CustomerIdentity) => void;
  onToggleTag: (tag: string) => void;
  savingTags: boolean;
  noteText: string;
  setNoteText: (value: string) => void;
  addNote: (event: FormEvent) => void;
  savingNote: boolean;
}) {
  const { customer } = detail;
  return <div className="customer-overview-grid">
    <div className="customer-overview-main">
      <section className="customer-detail-section customer-identity-section"><header><div><small>身份绑定</small><h3>身份绑定</h3></div><span><ShieldCheck />默认脱敏</span></header>
        {detail.identities.length ? <div className="customer-identities">{detail.identities.map((identity) => <article key={identity.id}><span><IdentificationBadge weight="duotone" /></span><div><strong>{identity.provider === "wechat" ? "微信小程序身份" : "其他身份来源"}</strong><small>微信用户标识 · {identity.maskedProviderSubject || "已脱敏"}</small><small>微信跨应用标识 · {identity.maskedUnionSubject || "未绑定 / 不可用"}</small><em>绑定于 {localDate(identity.boundAt)}</em></div><button onClick={() => onReveal(identity)}><Eye />查看完整标识</button></article>)}</div> : <CustomerEmpty title="尚未绑定微信身份" description="该客户可能是演示身份或历史业务数据；系统不会自动推断微信用户标识。" />}
      </section>

      <section className="customer-detail-section"><header><div><small>最近业务</small><h3>最近业务记录</h3></div><span>仅展示源业务摘要</span></header>
        {detail.recentRecords.length ? <div className="customer-recent-records">{detail.recentRecords.slice(0, 6).map((record) => <article key={`${record.domain}-${record.sourceId}`}><i /><span><strong>{record.title || labelForDomain(record.domain)}</strong><small>{record.businessCode} · {labelForStatus(record.status)}</small></span><time>{localDate(record.occurredAt)}</time>{record.detailPath ? <button onClick={() => onNavigate(record.detailPath!)} aria-label={`打开业务记录 ${record.businessCode}`}><CaretRight /></button> : null}</article>)}</div> : <CustomerEmpty title="暂无业务记录" description="该客户当前没有订单、咨询或服务记录，系统不会生成示例记录。" />}
      </section>
    </div>

    <aside className="customer-overview-aside">
      <section className="customer-detail-section customer-tags-panel"><header><div><small>内部标签</small><h3>内部标签</h3></div><Tag weight="duotone" /></header><p>仅后台运营可见，不改变客户账号或业务状态。</p><div>{fixedCustomerTags.map((tag) => { const selected = detail.tags.includes(tag); return <button key={tag} aria-pressed={selected} disabled={savingTags} className={selected ? "selected" : ""} onClick={() => onToggleTag(tag)}>{selected ? <CheckCircle weight="fill" /> : <span />}{tag}</button>; })}</div></section>
      <section className="customer-detail-section customer-notes-panel"><header><div><small>只追加备注</small><h3>内部备注</h3></div><NotePencil weight="duotone" /></header><form onSubmit={addNote}><textarea aria-label="新增客户内部备注" maxLength={1000} value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="记录需要交接的运营事实，不填写密码、微信用户标识等敏感信息。" /><div><small>{noteText.length} / 1000 · 保存后不可编辑或删除</small><button disabled={savingNote || !noteText.trim()}>{savingNote ? <CircleNotch className="customer-spinner" /> : <NotePencil />}追加备注</button></div></form>
        {detail.notes.length ? <ol>{detail.notes.map((note) => <li key={note.id}><p>{note.content}</p><span>{note.author?.displayName || "平台管理员"} · {localDate(note.createdAt)}</span></li>)}</ol> : <p className="customer-no-notes">暂无内部备注</p>}
      </section>
    </aside>
  </div>;
}

function CustomerVehicles({ vehicles }: { vehicles: CustomerVehicle[] }) {
  return <section className="content-card customer-tab-card"><header className="customer-card-heading"><div><small>客户车辆</small><h2>客户车辆</h2><p>包含有效及已删除档案；年检信息来自车辆源记录。</p></div><span><Car weight="duotone" />{vehicles.length} 辆</span></header>
    {vehicles.length ? <div className="table-wrap"><table><thead><tr><th>车辆</th><th>档案属性</th><th>年检信息</th><th>最近服务</th><th>档案状态</th></tr></thead><tbody>{vehicles.map((vehicle) => <tr key={vehicle.id}><td><strong>{vehicle.plateNumber}{vehicle.isDefault ? <em className="customer-default-vehicle">当前车辆</em> : null}</strong><small>{[vehicle.brandName, vehicle.modelName].filter(Boolean).join(" ") || "未选择品牌车型"}</small></td><td><strong>{customerVehicleTypeLabel(vehicle.vehicleType)}</strong><small>{vehicle.seats ? `${vehicle.seats} 座` : "座位数未填写"}</small></td><td><strong>{vehicle.inspectionValidUntil ? `有效期至 ${localDate(vehicle.inspectionValidUntil, false)}` : "有效期未核对"}</strong><small>{vehicle.nextInspectionDate ? `预计下次：${localDate(vehicle.nextInspectionDate, false)}` : "暂无下次年检日期"}</small></td><td><strong>{localDate(vehicle.lastServiceAt || vehicle.updatedAt)}</strong></td><td><span className={`customer-account-state ${vehicle.isDeleted ? "disabled" : "active"}`}>{vehicle.isDeleted ? "已删除档案" : "有效档案"}</span></td></tr>)}</tbody></table></div> : <CustomerEmpty title="该客户暂无车辆" description="车辆由小程序端客户维护；客户中心不会自动创建或补全车辆档案。" />}
  </section>;
}

function CustomerRecords({ customerId, onNavigate, onError }: { customerId: string; onNavigate: Navigate; onError: (message: string) => void }) {
  const [domain, setDomain] = useState("");
  const [records, setRecords] = useState<CustomerBusinessRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const payload = normalizeCursorList(await customerAdminApi.records(customerId, { domain, cursor, limit: 20 }), normalizeRecord);
      if (generation !== requestGeneration.current) return;
      setRecords(payload.items);
      setNextCursor(payload.nextCursor);
    } catch (reason) { if (generation === requestGeneration.current) { onError(operatorErrorMessage(reason, "客户业务记录读取失败，请稍后重试")); setRecords([]); setNextCursor(null); } }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }, [cursor, customerId, domain, onError]);
  useEffect(() => { void load(); }, [load]);
  const changeDomain = (value: string) => { setDomain(value); setCursor(null); setHistory([]); };
  return <section className="content-card customer-tab-card"><header className="customer-card-heading"><div><small>跨业务时间线</small><h2>业务记录</h2><p>统一时间线只聚合源业务摘要，订单状态和金额仍由对应业务维护。</p></div><select aria-label="业务记录类型" value={domain} onChange={(event) => changeDomain(event.target.value)}><option value="">全部业务</option>{Object.entries(domainLabels).filter(([key]) => ["annual_inspection", "car_wash", "car_rental", "repair", "insurance", "driving_school", "subsidy_consultation"].includes(key)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></header>
    {records.length ? <div className="customer-timeline" aria-label="客户业务时间线">{records.map((record) => <article key={`${record.domain}-${record.sourceId}`}><time>{localDate(record.occurredAt)}</time><span className="customer-timeline-dot" /><div><header><span>{labelForDomain(record.domain)}</span><em className={`customer-record-status ${record.status}`}>{labelForStatus(record.status)}</em></header><h3>{record.title || record.businessCode}</h3><p>{record.businessCode} · {labelForRecordType(record.recordType)}{record.vehicleId ? " · 已关联车辆" : ""}</p></div><strong>{record.amountFen == null ? "金额未记录" : `¥${money(record.amountFen)}`}</strong>{record.detailPath ? <button onClick={() => onNavigate(record.detailPath!)}><LinkSimple />打开业务详情</button> : <span className="customer-no-deep-link">暂无独立后台详情</span>}</article>)}</div> : !loading ? <CustomerEmpty title="当前没有业务记录" description={domain ? `该客户暂无${labelForDomain(domain)}记录。` : "该客户在各业务域中都没有可聚合的记录。"} /> : null}
    {loading ? <div className="customer-inline-loading"><CircleNotch className="customer-spinner" />正在读取业务记录…</div> : null}
    <footer className="customer-cursor-pagination"><span>每页最多 20 条</span><div><button disabled={!history.length || loading} onClick={() => { const previous = history.at(-1) ?? null; setHistory((items) => items.slice(0, -1)); setCursor(previous); }}><ArrowLeft />上一页</button><button disabled={!nextCursor || loading} onClick={() => { setHistory((items) => [...items, cursor]); setCursor(nextCursor); }}>下一页<ArrowRight /></button></div></footer>
  </section>;
}

function CustomerMaterials({ customerId, onError }: { customerId: string; onError: (message: string) => void }) {
  const [filters, setFilters] = useState({ domain: "", state: "" });
  const [materials, setMaterials] = useState<CustomerMaterial[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const payload = normalizeCursorList(await customerAdminApi.materials(customerId, { domain: filters.domain, state: filters.state, cursor, limit: 20 }), normalizeMaterial);
      if (generation !== requestGeneration.current) return;
      setMaterials(payload.items);
      setNextCursor(payload.nextCursor);
    } catch (reason) { if (generation === requestGeneration.current) { onError(operatorErrorMessage(reason, "客户资料索引读取失败，请稍后重试")); setMaterials([]); setNextCursor(null); } }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }, [cursor, customerId, filters.domain, filters.state, onError]);
  useEffect(() => { void load(); }, [load]);
  const updateFilter = (key: keyof typeof filters, value: string) => { setFilters((current) => ({ ...current, [key]: value })); setCursor(null); setHistory([]); };
  const materialGroups = materials.reduce<Array<{ key: string; domain: string; businessLabel: string; items: CustomerMaterial[] }>>((groups, material) => {
    const businessLabel = material.businessCode || "未关联业务编号";
    const key = `${material.domain}:${material.businessId || businessLabel}`;
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.items.push(material);
    else groups.push({ key, domain: material.domain, businessLabel, items: [material] });
    return groups;
  }, []);
  return <section className="content-card customer-tab-card customer-material-card"><header className="customer-card-heading"><div><small>隐私资料索引</small><h2>资料与授权</h2><p>列表仅包含元数据。内容需逐项查看，不提供批量下载或全量导出。</p></div><div className="customer-material-filters"><select aria-label="资料业务类型" value={filters.domain} onChange={(event) => updateFilter("domain", event.target.value)}><option value="">全部业务</option>{Object.entries(domainLabels).filter(([key]) => ["annual_inspection", "insurance", "driving_school", "subsidy_consultation", "vehicle_checkup", "repair"].includes(key)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="资料状态" value={filters.state} onChange={(event) => updateFilter("state", event.target.value)}><option value="">全部状态</option><option value="active">有效</option><option value="retained">留存中</option><option value="withdrawn">已撤回</option><option value="expired">已过期</option><option value="deleted">已清理</option></select></div></header>
    {materialGroups.length ? <div className="customer-material-groups">{materialGroups.map((group) => <section className="customer-material-group" key={group.key} aria-label={`${labelForDomain(group.domain)} ${group.businessLabel} 资料`}><header><div><span>{labelForDomain(group.domain)}</span><strong>{group.businessLabel}</strong></div><em>{group.items.length} 项资料</em></header><div className="customer-material-list">{group.items.map((material) => { const contentUrl = customerAdminApi.materialContentUrl(customerId, material.domain, material.id); return <article key={`${material.domain}-${material.id}`}><span className="customer-file-icon"><FileText weight="duotone" /></span><div className="customer-material-main"><header><strong>{material.label || "其他资料"}</strong><em className={`customer-material-state ${material.available ? "available" : "unavailable"}`}>{labelForMaterialState(material.state)}</em></header><p>{labelForMaterialType(material.mimeType)} · {bytes(material.sizeBytes)}</p><dl><div><dt>采集用途</dt><dd>{material.purpose || "用途说明未记录"}</dd></div><div><dt>授权版本</dt><dd>{authorizationVersionLabel(material.authorizationVersion || material.consentVersion)}</dd></div><div><dt>留存规则</dt><dd>{material.retention || (material.deleteAfter ? `计划清理：${localDate(material.deleteAfter)}` : "按源业务留存规则")}</dd></div><div><dt>创建 / 到期</dt><dd>{localDate(material.createdAt)} / {localDate(material.expiresAt)}</dd></div></dl></div>{material.available ? <a href={contentUrl} target="_blank" rel="noopener noreferrer" aria-label={`逐项查看资料 ${material.label || "其他资料"}`}><Eye />逐项查看</a> : <button disabled title="该资料已撤回、过期或清理"><ShieldCheck />不可查看</button>}</article>; })}</div></section>)}</div> : !loading ? <CustomerEmpty title="没有可展示的资料元数据" description={filters.domain || filters.state ? "当前筛选条件下没有资料；已清理内容不会由客户中心恢复。" : "该客户尚未上传业务资料，系统不会生成示例文件。"} /> : null}
    {loading ? <div className="customer-inline-loading"><CircleNotch className="customer-spinner" />正在读取资料索引…</div> : null}
    <footer className="customer-cursor-pagination"><span><ShieldCheck />文件内容响应禁止缓存，读取由服务端审计</span><div><button disabled={!history.length || loading} onClick={() => { const previous = history.at(-1) ?? null; setHistory((items) => items.slice(0, -1)); setCursor(previous); }}><ArrowLeft />上一页</button><button disabled={!nextCursor || loading} onClick={() => { setHistory((items) => [...items, cursor]); setCursor(nextCursor); }}>下一页<ArrowRight /></button></div></footer>
  </section>;
}

function CustomerAccessLog({ activities }: { activities: CustomerActivity[] }) {
  return <section className="content-card customer-tab-card"><header className="customer-card-heading"><div><small>资料操作记录</small><h2>操作记录</h2><p>敏感身份查看、资料读取、标签和备注变更由服务端记录。</p></div><span><ShieldCheck weight="duotone" />不可修改</span></header>
    {activities.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>操作人员</th><th>资源</th><th>结果</th></tr></thead><tbody>{activities.map((activity) => <tr key={activity.id}><td><strong>{localDate(activity.occurredAt)}</strong></td><td><strong>{activity.label}</strong><small>{activity.description || "系统操作"}</small></td><td><strong>{activity.actorName || "系统"}</strong></td><td><strong>{activity.domain ? labelForDomain(activity.domain) : "客户档案"}</strong><small>{activity.resourceId ? "关联业务已记录" : "—"}</small></td><td><span className={`customer-audit-outcome ${activity.outcome || "success"}`}>{activity.outcome === "denied" ? "已拒绝" : activity.outcome === "failure" ? "失败" : "成功"}</span></td></tr>)}</tbody></table></div> : <CustomerEmpty title="暂无操作记录" description="尚未发生敏感标识查看、资料读取、标签或备注变更。" />}
  </section>;
}

export function CustomerDetailPage({ customerId, onNavigate, onError }: { customerId: string; onNavigate: Navigate; onError: (message: string) => void }) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [revealedIdentity, setRevealedIdentity] = useState<RevealedIdentity | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setDetail(normalizeCustomerDetail(await customerAdminApi.get(customerId))); }
    catch (reason) { onError(operatorErrorMessage(reason, "客户详情读取失败，请稍后重试")); setDetail(null); }
    finally { setLoading(false); }
  }, [customerId, onError]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setRevealedIdentity(null); }, [tab, customerId]);
  useEffect(() => {
    if (!revealedIdentity) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRevealedIdentity(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [revealedIdentity]);

  const toggleTag = async (tag: string) => {
    if (!detail || savingTags) return;
    const tags = detail.tags.includes(tag) ? detail.tags.filter((item) => item !== tag) : [...detail.tags, tag];
    setSavingTags(true);
    try {
      const response = objectOf(await customerAdminApi.replaceTags(customerId, tags));
      const next = stringsOf(response.tags).length || tags.length === 0 ? stringsOf(response.tags) : tags;
      setDetail((current) => current ? { ...current, tags: next, customer: { ...current.customer, tags: next } } : current);
    } catch (reason) { onError(operatorErrorMessage(reason, "客户标签保存失败，请稍后重试")); }
    finally { setSavingTags(false); }
  };

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    const content = noteText.trim();
    if (!detail || !content || savingNote) return;
    setSavingNote(true);
    try {
      const response = objectOf(await customerAdminApi.addNote(customerId, content));
      const note = normalizeNote(response.note ?? response);
      setDetail((current) => current ? { ...current, notes: [note, ...current.notes] } : current);
      setNoteText("");
    } catch (reason) { onError(operatorErrorMessage(reason, "客户备注保存失败，请稍后重试")); }
    finally { setSavingNote(false); }
  };

  const reveal = async (identity: CustomerIdentity) => {
    try {
      const response = objectOf(await customerAdminApi.revealIdentity(customerId, identity.id));
      const raw = objectOf(response.identity ?? response);
      setRevealedIdentity({
        id: textOf(raw.id, identity.id),
        provider: textOf(raw.provider, identity.provider),
        providerAppId: nullableText(raw.providerAppId ?? raw.provider_app_id),
        providerSubject: nullableText(raw.providerSubject ?? raw.provider_subject ?? raw.openId ?? raw.openid),
        unionSubject: nullableText(raw.unionSubject ?? raw.union_subject ?? raw.unionId ?? raw.unionid),
      });
      setDetail((current) => current ? { ...current, recentActivity: [{ id: `identity-reveal-${Date.now()}`, type: "customer.identity.reveal", label: "查看完整微信身份标识", description: "敏感身份标识已显式查看", occurredAt: new Date().toISOString(), actorName: "当前管理员", domain: "customer", resourceId: identity.id, outcome: "success" }, ...current.recentActivity] } : current);
    } catch (reason) { onError(operatorErrorMessage(reason, "客户身份信息读取失败，请稍后重试")); }
  };

  const tabs: Array<[DetailTab, string, number | null]> = useMemo(() => [
    ["overview", "概览", null],
    ["vehicles", "车辆", detail?.vehicles.length ?? 0],
    ["records", "业务记录", detail?.stats.records ?? 0],
    ["materials", "资料与授权", null],
    ["access", "操作记录", detail?.recentActivity.length ?? 0],
  ], [detail]);

  if (loading) return <div className="customer-center"><div className="customer-page-loading"><CircleNotch className="customer-spinner" /><strong>正在建立客户 360 视图…</strong><p>车辆、订单和资料仍从各自业务源读取。</p></div></div>;
  if (!detail) return <div className="customer-center"><CustomerEmpty title="无法读取客户档案" description="该客户不存在、已超出当前账号权限，或后台服务暂不可用。" /><button className="customer-back-button standalone" onClick={() => onNavigate("/customers")}><ArrowLeft />返回客户列表</button></div>;
  const customer = detail.customer;

  return <div className="customer-center customer-detail-page" aria-label="客户详情">
    <button className="customer-back-button" onClick={() => onNavigate("/customers")}><ArrowLeft />返回客户列表</button>
    <section className="customer-profile-hero">
      <div className="customer-profile-identity"><Avatar customer={customer} /><div><span><DataKindPill value={customer.dataKind} /><em className={`customer-account-state ${customer.status}`}>{labelForStatus(customer.status)}</em></span><h2>{customer.displayName}</h2><p>{customer.customerNumber} · 创建于 {localDate(customer.createdAt)}</p></div></div>
      <div className="customer-profile-stats"><article><small>车辆档案</small><strong>{detail.stats.vehicles}<em> 辆</em></strong></article><article><small>业务记录</small><strong>{detail.stats.records}<em> 条</em></strong></article><article><small>当前待办</small><strong className={detail.stats.pending ? "customer-pending" : ""}>{detail.stats.pending}<em> 项</em></strong></article></div>
      <div className="customer-profile-trust"><ShieldCheck weight="duotone" /><span><strong>客户主数据只读</strong><small>标签与备注不修改业务源数据</small></span></div>
    </section>
    <nav className="customer-detail-tabs" aria-label="客户详情栏目">{tabs.map(([value, label, count]) => <button key={value} className={tab === value ? "active" : ""} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{label}{count == null ? null : <span>{count}</span>}</button>)}</nav>
    {tab === "overview" ? <CustomerOverview detail={detail} onNavigate={onNavigate} onReveal={(identity) => void reveal(identity)} onToggleTag={(tag) => void toggleTag(tag)} savingTags={savingTags} noteText={noteText} setNoteText={setNoteText} addNote={addNote} savingNote={savingNote} /> : null}
    {tab === "vehicles" ? <CustomerVehicles vehicles={detail.vehicles} /> : null}
    {tab === "records" ? <CustomerRecords customerId={customerId} onNavigate={onNavigate} onError={onError} /> : null}
    {tab === "materials" ? <CustomerMaterials customerId={customerId} onError={onError} /> : null}
    {tab === "access" ? <CustomerAccessLog activities={detail.recentActivity} /> : null}
    {revealedIdentity ? <IdentityRevealDialog identity={revealedIdentity} close={() => setRevealedIdentity(null)} /> : null}
  </div>;
}
