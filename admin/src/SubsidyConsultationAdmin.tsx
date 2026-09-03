import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaretRight,
  CheckCircle,
  CurrencyCny,
  Eye,
  EyeSlash,
  FileImage,
  FloppyDisk,
  GearSix,
  Plus,
  Receipt,
  ShieldCheck,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, apiBlob, money } from "./adminApi";

type ConsultationStatus = "new" | "handled" | "withdrawn" | "expired";
type HandleResult = "consultation_completed" | "customer_declined" | "unable_to_contact" | "invalid_submission" | "compliance_rejected";

type FeeTier = {
  id?: string;
  label: string;
  minValueFen: number;
  maxValueFen: number;
  feeFen: number;
  totalTransferCostFen?: number;
  sortOrder: number;
};

type AdministrativeFees = {
  plateFeeFen: number;
  mailingFeeFen: number;
  productionFeeFen: number;
};

type FeePlan = {
  id?: string;
  version?: string | number;
  active: boolean;
  administrativeFees: AdministrativeFees;
  administrativeFeeFen: number;
  tiers: FeeTier[];
  updatedAt?: string | null;
  publishedAt?: string | null;
};

type FeePlanState = {
  draft: FeePlan;
  published: FeePlan | null;
};

type Material = {
  id: string;
  kind: string;
  available?: boolean;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  deleteAfter?: string | null;
};

type Consultation = {
  id: string;
  consultationCode: string;
  status: ConsultationStatus | string;
  submittedAt: string;
  handledAt?: string | null;
  withdrawnAt?: string | null;
  expiresAt?: string | null;
  contactNameMasked?: string;
  contactPhoneMasked?: string;
  contact?: { name?: string; phone?: string };
  vehicle?: { id?: string; plateNumber?: string; modelName?: string; vehicleType?: string };
  declaredValueFen: number;
  consultationFeeFen: number;
  administrativeFees: AdministrativeFees;
  administrativeFeeFen: number;
  totalTransferCostFen: number;
  tierLabel?: string;
  feePlanVersion?: string | number;
  materials?: Material[];
  result?: string | null;
  internalNote?: string | null;
  events?: Array<Record<string, unknown>>;
};

type UnknownRecord = Record<string, unknown>;

const VALUE_UNIT_FEN = 1_000_000;
const MAX_VALUE_FEN = 50 * VALUE_UNIT_FEN;
const CONSULTATION_PAGE_SIZE = 20;
const defaultAdministrativeFees: AdministrativeFees = {
  plateFeeFen: 12_000,
  mailingFeeFen: 2_000,
  productionFeeFen: 1_000,
};

const materialOrder = [
  "id_card_front",
  "id_card_back",
  "driving_license_front",
  "driving_license_back",
  "vehicle_front_left",
  "vehicle_front_right",
  "vehicle_rear_left",
  "vehicle_rear_right",
  "dashboard_started",
] as const;

const materialLabels: Record<string, string> = {
  id_card_front: "身份证正面",
  id_card_back: "身份证反面",
  driving_license_front: "行驶证主页",
  driving_license_back: "行驶证副页",
  vehicle_front_left: "车辆左前",
  vehicle_front_right: "车辆右前",
  vehicle_rear_left: "车辆左后",
  vehicle_rear_right: "车辆右后",
  dashboard_started: "启动后仪表盘",
};

const statusLabels: Record<string, string> = {
  new: "新提交",
  handled: "已处理",
  withdrawn: "已撤回",
  expired: "已过期",
};

const resultOptions: Array<{ value: HandleResult; label: string }> = [
  { value: "consultation_completed", label: "已完成咨询" },
  { value: "customer_declined", label: "车主暂不需要" },
  { value: "unable_to_contact", label: "无法联系车主" },
  { value: "invalid_submission", label: "提交资料无效" },
  { value: "compliance_rejected", label: "不符合合规用途" },
];

const emptyPlan: FeePlan = {
  active: true,
  administrativeFees: defaultAdministrativeFees,
  administrativeFeeFen: 15_000,
  tiers: [],
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}

function normalizeTier(value: unknown, index: number): FeeTier {
  const row = asRecord(value);
  return {
    id: textValue(row.id) || undefined,
    label: textValue(row.label, `档位 ${index + 1}`),
    minValueFen: numberValue(row.minValueFen),
    maxValueFen: numberValue(row.maxValueFen),
    feeFen: numberValue(row.feeFen),
    totalTransferCostFen: row.totalTransferCostFen == null ? undefined : numberValue(row.totalTransferCostFen),
    sortOrder: numberValue(row.sortOrder, index),
  };
}

function normalizeAdministrativeFees(value: unknown, fallback = defaultAdministrativeFees): AdministrativeFees {
  const fees = asRecord(value);
  return {
    plateFeeFen: numberValue(fees.plateFeeFen, fallback.plateFeeFen),
    mailingFeeFen: numberValue(fees.mailingFeeFen, fallback.mailingFeeFen),
    productionFeeFen: numberValue(fees.productionFeeFen, fallback.productionFeeFen),
  };
}

function administrativeFeeTotal(fees: AdministrativeFees): number {
  return fees.plateFeeFen + fees.mailingFeeFen + fees.productionFeeFen;
}

function normalizePlan(value: unknown): FeePlan {
  const plan = asRecord(value);
  const tiers = Array.isArray(plan.tiers) ? plan.tiers.map(normalizeTier).sort((a, b) => a.sortOrder - b.sortOrder) : [];
  const administrativeFees = normalizeAdministrativeFees(plan.administrativeFees);
  return {
    id: textValue(plan.id) || undefined,
    version: typeof plan.version === "string" || typeof plan.version === "number" ? plan.version : undefined,
    active: plan.active !== false,
    administrativeFees,
    administrativeFeeFen: numberValue(plan.administrativeFeeFen, administrativeFeeTotal(administrativeFees)),
    tiers,
    updatedAt: textValue(plan.updatedAt) || null,
    publishedAt: textValue(plan.publishedAt) || null,
  };
}

function normalizePlanState(value: unknown): FeePlanState {
  const source = asRecord(value);
  const draft = normalizePlan(source.draft ?? source.plan ?? value);
  const publishedValue = source.published ?? source.activePlan ?? null;
  return { draft, published: publishedValue ? normalizePlan(publishedValue) : null };
}

function normalizeMaterial(value: unknown): Material {
  const material = asRecord(value);
  return {
    id: textValue(material.id),
    kind: textValue(material.kind),
    available: material.available !== false,
    filename: textValue(material.filename) || undefined,
    mimeType: textValue(material.mimeType) || undefined,
    sizeBytes: numberValue(material.sizeBytes),
    deleteAfter: textValue(material.deleteAfter) || null,
  };
}

function normalizeConsultation(value: unknown): Consultation {
  const row = asRecord(value);
  const quote = asRecord(row.quote ?? row.quoteSnapshot);
  const matchedTier = asRecord(row.matchedTier ?? quote.matchedTier);
  const contact = asRecord(row.contact);
  const vehicle = asRecord(row.vehicle);
  const materials = Array.isArray(row.materials) ? row.materials.map(normalizeMaterial) : [];
  const administrativeFees = normalizeAdministrativeFees(row.administrativeFees ?? quote.administrativeFees, {
    plateFeeFen: 0,
    mailingFeeFen: 0,
    productionFeeFen: 0,
  });
  const consultationFeeFen = numberValue(row.consultationFeeFen ?? quote.consultationFeeFen ?? quote.feeFen);
  const administrativeFeeFen = numberValue(
    row.administrativeFeeFen ?? quote.administrativeFeeFen,
    administrativeFeeTotal(administrativeFees),
  );
  return {
    id: textValue(row.id),
    consultationCode: textValue(row.consultationCode ?? row.code ?? row.serviceCode, textValue(row.id)),
    status: textValue(row.status, "new"),
    submittedAt: textValue(row.submittedAt ?? row.createdAt),
    handledAt: textValue(row.handledAt) || null,
    withdrawnAt: textValue(row.withdrawnAt) || null,
    expiresAt: textValue(row.expiresAt ?? row.expiredAt) || null,
    contactNameMasked: textValue(row.contactNameMasked ?? row.maskedContactName),
    contactPhoneMasked: textValue(row.contactPhoneMasked ?? row.maskedPhone),
    contact: Object.keys(contact).length ? { name: textValue(contact.name), phone: textValue(contact.phone) } : undefined,
    vehicle: Object.keys(vehicle).length || row.vehiclePlateMasked || row.vehicleModelName ? {
      id: textValue(vehicle.id),
      plateNumber: textValue(vehicle.plateNumber ?? row.vehiclePlateMasked),
      modelName: textValue(vehicle.modelName ?? row.vehicleModelName),
      vehicleType: textValue(vehicle.vehicleType),
    } : undefined,
    declaredValueFen: numberValue(row.declaredValueFen ?? quote.declaredValueFen),
    consultationFeeFen,
    administrativeFees,
    administrativeFeeFen,
    totalTransferCostFen: numberValue(
      row.totalTransferCostFen ?? quote.totalTransferCostFen,
      consultationFeeFen + administrativeFeeFen,
    ),
    tierLabel: textValue(row.tierLabel ?? quote.tierLabel ?? matchedTier.label),
    feePlanVersion: row.feePlanVersion as string | number | undefined ?? row.planVersion as string | number | undefined ?? quote.planVersion as string | number | undefined,
    materials,
    result: textValue(row.result ?? row.handleResult) || null,
    internalNote: textValue(row.internalNote ?? row.note) || null,
    events: Array.isArray(row.events) ? row.events as Array<Record<string, unknown>> : [],
  };
}

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

function formatValue(fen = 0): string {
  const wan = fen / VALUE_UNIT_FEN;
  return `${Number.isInteger(wan) ? wan.toFixed(0) : wan.toFixed(1)} 万元`;
}

function formatBytes(value = 0): string {
  if (!value) return "—";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function planPayload(plan: FeePlan) {
  return {
    active: plan.active,
    administrativeFees: {
      plateFeeFen: Math.round(plan.administrativeFees.plateFeeFen),
      mailingFeeFen: Math.round(plan.administrativeFees.mailingFeeFen),
      productionFeeFen: Math.round(plan.administrativeFees.productionFeeFen),
    },
    tiers: plan.tiers.map((tier, index) => ({
      ...(tier.id ? { id: tier.id } : {}),
      label: tier.label.trim(),
      minValueFen: Math.round(tier.minValueFen),
      maxValueFen: Math.round(tier.maxValueFen),
      feeFen: Math.round(tier.feeFen),
      sortOrder: index,
    })),
  };
}

export function SubsidyConsultationAdminPage({ onError }: { onError: (message: string) => void }) {
  const [section, setSection] = useState<"consultations" | "pricing">("consultations");
  const [planState, setPlanState] = useState<FeePlanState>({ draft: emptyPlan, published: null });
  const [draft, setDraft] = useState<FeePlan>(emptyPlan);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [filter, setFilter] = useState("all");
  const [pagination, setPagination] = useState({ page: 1, pageSize: CONSULTATION_PAGE_SIZE, total: 0 });
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Consultation | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"save" | "publish" | "">("");
  const [notice, setNotice] = useState("");
  const listRequestGeneration = useRef(0);
  const listRequestController = useRef<AbortController | null>(null);
  const detailRequestGeneration = useRef(0);
  const detailRequestController = useRef<AbortController | null>(null);
  const deepLinkOpenedRef = useRef("");

  const loadPlan = () => api<unknown>("/admin/subsidy-consultation/fee-plan").then((value) => {
    const normalized = normalizePlanState(value);
    setPlanState(normalized);
    setDraft(normalized.draft);
  }).catch((reason: Error) => onError(reason.message));

  const loadConsultations = (requestedPage = pagination.page) => {
    const generation = ++listRequestGeneration.current;
    listRequestController.current?.abort();
    const controller = new AbortController();
    listRequestController.current = controller;
    setLoading(true);
    setPagination((current) => ({ ...current, page: requestedPage }));
    const query = new URLSearchParams({ page: String(requestedPage), pageSize: String(CONSULTATION_PAGE_SIZE) });
    if (filter !== "all") query.set("status", filter);
    void api<unknown>(`/admin/subsidy-consultations?${query.toString()}`, { signal: controller.signal }).then((value) => {
      if (generation !== listRequestGeneration.current || controller.signal.aborted) return;
      const source = asRecord(value);
      const rows = Array.isArray(value) ? value : Array.isArray(source.items) ? source.items : Array.isArray(source.consultations) ? source.consultations : [];
      setConsultations(rows.map(normalizeConsultation));
      setPagination({
        page: Math.max(1, Math.trunc(numberValue(source.page, requestedPage))),
        pageSize: Math.max(1, Math.trunc(numberValue(source.pageSize, CONSULTATION_PAGE_SIZE))),
        total: Math.max(0, Math.trunc(numberValue(source.total, rows.length))),
      });
    }).catch((reason: Error) => {
      if (generation === listRequestGeneration.current && !isAbortError(reason)) onError(reason.message);
    }).finally(() => {
      if (generation !== listRequestGeneration.current) return;
      if (listRequestController.current === controller) listRequestController.current = null;
      setLoading(false);
    });
  };

  useEffect(() => { void loadPlan(); }, []);
  useEffect(() => { loadConsultations(1); }, [filter]);
  useEffect(() => () => {
    listRequestGeneration.current += 1;
    listRequestController.current?.abort();
    detailRequestGeneration.current += 1;
    detailRequestController.current?.abort();
  }, []);

  const openDetail = (id: string) => {
    const generation = ++detailRequestGeneration.current;
    detailRequestController.current?.abort();
    const controller = new AbortController();
    detailRequestController.current = controller;
    setSelectedId(id);
    setDetail(null);
    setDetailError("");
    void api<unknown>(`/admin/subsidy-consultations/${encodeURIComponent(id)}`, { signal: controller.signal }).then((value) => {
      if (generation !== detailRequestGeneration.current || controller.signal.aborted) return;
      setDetail(normalizeConsultation(value));
    }).catch((reason: Error) => {
      if (generation !== detailRequestGeneration.current || isAbortError(reason)) return;
      setDetailError(reason.message);
      onError(reason.message);
    }).finally(() => {
      if (generation === detailRequestGeneration.current && detailRequestController.current === controller) {
        detailRequestController.current = null;
      }
    });
  };

  useEffect(() => {
    const consultationId = new URLSearchParams(window.location.search).get("consultation") || "";
    if (!consultationId || deepLinkOpenedRef.current === consultationId) return;
    deepLinkOpenedRef.current = consultationId;
    setSection("consultations");
    openDetail(consultationId);
  }, []);

  const closeDetail = () => {
    detailRequestGeneration.current += 1;
    detailRequestController.current?.abort();
    detailRequestController.current = null;
    setSelectedId("");
    setDetail(null);
    setDetailError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("consultation");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  };

  const pageCount = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));

  const metrics = useMemo(() => ({
    total: pagination.total,
    fresh: consultations.filter((item) => item.status === "new").length,
    handled: consultations.filter((item) => item.status === "handled").length,
    averageTotal: consultations.length ? Math.round(consultations.reduce((sum, item) => sum + item.totalTransferCostFen, 0) / consultations.length) : 0,
  }), [consultations, pagination.total]);

  const draftAdministrativeFeeFen = administrativeFeeTotal(draft.administrativeFees);

  const updateAdministrativeFee = (field: keyof AdministrativeFees, valueFen: number) => setDraft((current) => {
    const administrativeFees = { ...current.administrativeFees, [field]: valueFen };
    return { ...current, administrativeFees, administrativeFeeFen: administrativeFeeTotal(administrativeFees) };
  });

  const updateTier = (index: number, patch: Partial<FeeTier>) => setDraft((current) => ({
    ...current,
    tiers: current.tiers.map((tier, tierIndex) => tierIndex === index ? { ...tier, ...patch } : tier),
  }));

  const addTier = () => setDraft((current) => {
    const rangeEndIndex = current.tiers.reduce((selected, tier, index, tiers) => (
      selected < 0 || tier.maxValueFen > tiers[selected].maxValueFen ? index : selected
    ), -1);
    const rangeEndTier = rangeEndIndex >= 0 ? current.tiers[rangeEndIndex] : undefined;
    if (rangeEndTier && rangeEndTier.maxValueFen >= MAX_VALUE_FEN) {
      const step = 100_000;
      const midpoint = Math.floor((rangeEndTier.minValueFen + (rangeEndTier.maxValueFen - rangeEndTier.minValueFen) / 2) / step) * step;
      if (midpoint > rangeEndTier.minValueFen && midpoint < rangeEndTier.maxValueFen) {
        const tiers = current.tiers.map((tier, index) => index === rangeEndIndex
          ? { ...tier, maxValueFen: midpoint }
          : tier);
        return {
          ...current,
          tiers: [...tiers, {
            label: `估值 ${midpoint / VALUE_UNIT_FEN}–${rangeEndTier.maxValueFen / VALUE_UNIT_FEN} 万`,
            minValueFen: midpoint,
            maxValueFen: rangeEndTier.maxValueFen,
            feeFen: Math.max(0, rangeEndTier.feeFen + 10000),
            sortOrder: current.tiers.length,
          }],
        };
      }
      return current;
    }
    const minValueFen = rangeEndTier?.maxValueFen ?? 0;
    const maxValueFen = Math.min(MAX_VALUE_FEN, minValueFen + 10 * VALUE_UNIT_FEN);
    return {
      ...current,
      tiers: [...current.tiers, {
        label: `估值 ${minValueFen / VALUE_UNIT_FEN}–${maxValueFen / VALUE_UNIT_FEN} 万`,
        minValueFen,
        maxValueFen,
        feeFen: Math.max(0, (rangeEndTier?.feeFen ?? 5000) + 10000),
        sortOrder: current.tiers.length,
      }],
    };
  });

  const removeTier = (index: number) => setDraft((current) => ({
    ...current,
    tiers: current.tiers.filter((_, tierIndex) => tierIndex !== index).map((tier, tierIndex) => ({ ...tier, sortOrder: tierIndex })),
  }));

  const moveTier = (index: number, direction: -1 | 1) => setDraft((current) => {
    const target = index + direction;
    if (target < 0 || target >= current.tiers.length) return current;
    const tiers = [...current.tiers];
    [tiers[index], tiers[target]] = [tiers[target], tiers[index]];
    return { ...current, tiers: tiers.map((tier, tierIndex) => ({ ...tier, sortOrder: tierIndex })) };
  });

  const saveDraft = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving("save");
    setNotice("");
    try {
      const value = await api<unknown>("/admin/subsidy-consultation/fee-plan/draft", {
        method: "PUT",
        body: JSON.stringify(planPayload(draft)),
      });
      const normalized = normalizePlanState(value);
      const savedDraft = normalized.draft.tiers.length ? normalized.draft : normalizePlan(value);
      setDraft(savedDraft);
      setPlanState((current) => ({ ...current, draft: savedDraft }));
      setNotice("草稿已保存，尚未影响小程序报价");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "保存价格草稿失败");
    } finally {
      setSaving("");
    }
  };

  const publish = async () => {
    setSaving("publish");
    setNotice("");
    try {
      const saved = await api<unknown>("/admin/subsidy-consultation/fee-plan/draft", {
        method: "PUT",
        body: JSON.stringify(planPayload(draft)),
      });
      const savedState = normalizePlanState(saved);
      const savedDraft = savedState.draft.tiers.length ? savedState.draft : normalizePlan(saved);
      setDraft(savedDraft);
      setPlanState((current) => ({ ...current, draft: savedDraft }));
      const value = await api<unknown>("/admin/subsidy-consultation/fee-plan/publish", { method: "POST" });
      const normalized = normalizePlanState(value);
      setPlanState(normalized);
      setDraft(normalized.draft);
      setNotice(`价格已发布${normalized.published?.version != null ? ` · 版本 ${normalized.published.version}` : ""}`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "发布价格失败");
    } finally {
      setSaving("");
    }
  };

  return <div className="subsidy-admin-page">
    <div className="subsidy-admin-tabs" role="tablist" aria-label="补贴咨询后台模块">
      <button type="button" role="tab" aria-selected={section === "consultations"} className={section === "consultations" ? "active" : ""} onClick={() => setSection("consultations")}><Receipt />咨询申请</button>
      <button type="button" role="tab" aria-selected={section === "pricing"} className={section === "pricing" ? "active" : ""} onClick={() => setSection("pricing")}><CurrencyCny />咨询价格维护</button>
    </div>

    {section === "consultations" ? <>
      <section className="metric-strip">
        <div><span><Receipt /></span><small>筛选总数</small><strong>{metrics.total}<em> 条</em></strong></div>
        <div><span><WarningCircle /></span><small>本页新提交</small><strong>{metrics.fresh}<em> 条</em></strong></div>
        <div><span><CheckCircle /></span><small>本页已处理</small><strong>{metrics.handled}<em> 条</em></strong></div>
        <div><span><CurrencyCny /></span><small>平均过户费用（参考）</small><strong>¥{money(metrics.averageTotal)}</strong></div>
      </section>
      <section className="content-card subsidy-consultation-card">
        <div className="filters">
          <span><ShieldCheck />敏感列表默认脱敏</span>
          <select aria-label="咨询状态筛选" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">全部状态</option><option value="new">新提交</option><option value="handled">已处理</option><option value="withdrawn">已撤回</option><option value="expired">已过期</option>
          </select>
          <button type="button" onClick={() => loadConsultations(pagination.page)}>刷新列表</button>
        </div>
        <div className="table-wrap">
          <table><thead><tr><th>提交时间 / 编号</th><th>车辆</th><th>联系人（脱敏）</th><th>自报估值</th><th>过户费用合计（参考）</th><th>状态</th><th /></tr></thead>
            <tbody>{consultations.map((item) => <tr key={item.id} onClick={() => openDetail(item.id)}>
              <td><strong>{formatDateTime(item.submittedAt)}</strong><small>{item.consultationCode}</small></td>
              <td><strong>{item.vehicle?.plateNumber || "待核对"}</strong><small>{item.vehicle?.modelName || item.vehicle?.vehicleType || "车型待核对"}</small></td>
              <td><strong>{item.contactNameMasked || "已脱敏"}</strong><small>{item.contactPhoneMasked || "—"}</small></td>
              <td><strong>{formatValue(item.declaredValueFen)}</strong><small>车主自报 · 非平台估值</small></td>
              <td><strong>¥{money(item.totalTransferCostFen)}</strong><small>咨询 ¥{money(item.consultationFeeFen)} + 行政性收费 ¥{money(item.administrativeFeeFen)}</small></td>
              <td><span className={`status-pill subsidy-status-${item.status}`}>{statusLabels[item.status] || item.status}</span></td>
              <td><CaretRight /></td>
            </tr>)}</tbody>
          </table>
          {!consultations.length && !loading ? <div className="empty-table">当前筛选下暂无补贴咨询</div> : null}
          {loading ? <div className="table-loading">正在同步咨询申请…</div> : null}
        </div>
        <footer className="subsidy-table-pagination" aria-label="补贴咨询分页">
          <span>共 <strong>{pagination.total}</strong> 条 · 第 {pagination.page}/{pageCount} 页</span>
          <div>
            <button type="button" aria-label="上一页咨询" disabled={loading || pagination.page <= 1} onClick={() => loadConsultations(pagination.page - 1)}>上一页</button>
            <button type="button" aria-label="下一页咨询" disabled={loading || pagination.page >= pageCount} onClick={() => loadConsultations(pagination.page + 1)}>下一页</button>
          </div>
        </footer>
      </section>
    </> : <form className="content-card subsidy-pricing-card" onSubmit={saveDraft}>
      <header className="subsidy-pricing-head">
        <div><small>CONSULTATION FEE PLAN</small><h2>咨询价格维护</h2><p>新增、删除或修改估值档位；只有“发布生效”才会影响新的小程序报价。</p></div>
        <label className="switch"><input type="checkbox" aria-label="启用补贴咨询报价" checked={draft.active} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.checked }))} /><span /><strong>{draft.active ? "报价方案启用" : "报价方案停用"}</strong></label>
      </header>
      <div className="subsidy-version-row"><span><ShieldCheck />当前生效版本 <strong>{planState.published?.version ?? "尚未发布"}</strong></span><span>发布时间 {formatDateTime(planState.published?.publishedAt)}</span></div>
      <section className="subsidy-administrative-editor" aria-label="行政性收费维护">
        <header><div><strong>行政性收费（参考）</strong><small>随价格方案一并保存、发布并冻结到新咨询；实际以办理机构收取及所选服务为准。</small></div><span>行政性收费小计 <strong>¥{money(draftAdministrativeFeeFen)}</strong></span></header>
        <div>
          <label><span>牌照费（元）</span><input aria-label="牌照费" type="number" min="0" step="1" value={draft.administrativeFees.plateFeeFen / 100} onChange={(event) => updateAdministrativeFee("plateFeeFen", Math.round(Number(event.target.value) * 100))} /></label>
          <label><span>邮寄费（元）</span><input aria-label="邮寄费" type="number" min="0" step="1" value={draft.administrativeFees.mailingFeeFen / 100} onChange={(event) => updateAdministrativeFee("mailingFeeFen", Math.round(Number(event.target.value) * 100))} /></label>
          <label><span>制作工本费（元）</span><input aria-label="制作工本费" type="number" min="0" step="1" value={draft.administrativeFees.productionFeeFen / 100} onChange={(event) => updateAdministrativeFee("productionFeeFen", Math.round(Number(event.target.value) * 100))} /></label>
        </div>
      </section>
      <div className="subsidy-tier-editor">
        <div className="subsidy-tier-head"><span>顺序</span><span>档位名称</span><span>下限（万元）</span><span>上限（万元）</span><span>咨询价（元）</span><span>操作</span></div>
        {draft.tiers.map((tier, index) => <div className="subsidy-tier-row" key={tier.id || `draft-${index}`}>
          <span className="subsidy-tier-order">{index + 1}</span>
          <input aria-label={`档位 ${index + 1} 名称`} value={tier.label} onChange={(event) => updateTier(index, { label: event.target.value })} />
          <input aria-label={`档位 ${index + 1} 下限`} type="number" min="0" max="50" step="0.1" value={tier.minValueFen / VALUE_UNIT_FEN} onChange={(event) => updateTier(index, { minValueFen: Math.round(Number(event.target.value) * VALUE_UNIT_FEN) })} />
          <input aria-label={`档位 ${index + 1} 上限`} type="number" min="0" max="50" step="0.1" value={tier.maxValueFen / VALUE_UNIT_FEN} onChange={(event) => updateTier(index, { maxValueFen: Math.round(Number(event.target.value) * VALUE_UNIT_FEN) })} />
          <input aria-label={`档位 ${index + 1} 咨询价`} type="number" min="0" step="1" value={tier.feeFen / 100} onChange={(event) => updateTier(index, { feeFen: Math.round(Number(event.target.value) * 100) })} />
          <span className="subsidy-tier-actions"><button type="button" aria-label={`上移档位 ${index + 1}`} disabled={index === 0} onClick={() => moveTier(index, -1)}><ArrowUp /></button><button type="button" aria-label={`下移档位 ${index + 1}`} disabled={index === draft.tiers.length - 1} onClick={() => moveTier(index, 1)}><ArrowDown /></button><button type="button" aria-label={`删除档位 ${index + 1}`} onClick={() => removeTier(index)}><Trash /></button></span>
        </div>)}
        {!draft.tiers.length ? <div className="subsidy-tier-empty">还没有估值档位，请先新增一档。</div> : null}
        <button type="button" className="subsidy-add-tier" onClick={addTier}><Plus />新增估值档位</button>
      </div>
      <section className="subsidy-client-preview">
        <header><GearSix /><div><strong>小程序阶梯预览</strong><small>以下内容来自当前草稿，发布后才会对新报价生效</small></div></header>
        <div>{draft.tiers.map((tier, index) => <article key={`${tier.id || "preview"}-${index}`}><small>{tier.label}</small><strong>¥{money(tier.feeFen + draftAdministrativeFeeFen)}</strong><em>过户费用合计（参考）</em><span>咨询服务费 ¥{money(tier.feeFen)} + 行政性收费 ¥{money(draftAdministrativeFeeFen)}</span><span>{formatValue(tier.minValueFen)}以上 · {formatValue(tier.maxValueFen)}以内</span></article>)}</div>
        <p><ShieldCheck />以上均为参考，以办理机构实际收取及所选服务为准；本模块不收款、不代办理、不承诺结果。</p>
      </section>
      <footer className="subsidy-pricing-footer"><span>{notice || "历史咨询单保留提交时价格快照，后台调价不会改写历史。"}</span><button type="submit" disabled={saving !== ""}><FloppyDisk />{saving === "save" ? "保存中…" : "保存草稿"}</button><button type="button" className="primary" disabled={saving !== ""} onClick={() => void publish()}><CheckCircle />{saving === "publish" ? "发布中…" : "发布生效"}</button></footer>
    </form>}

    {selectedId ? <ConsultationDrawer key={selectedId} consultationId={selectedId} detail={detail} detailError={detailError} close={closeDetail} onUpdated={(updated) => {
      setDetail(updated);
      setConsultations((items) => items.map((item) => item.id === updated.id ? {
        ...item,
        status: updated.status,
        handledAt: updated.handledAt,
        result: updated.result,
        internalNote: updated.internalNote,
      } : item));
    }} onError={onError} /> : null}
  </div>;
}

function ConsultationDrawer({ consultationId, detail, detailError, close, onUpdated, onError }: { consultationId: string; detail: Consultation | null; detailError: string; close: () => void; onUpdated: (value: Consultation) => void; onError: (message: string) => void }) {
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const mediaUrlsRef = useRef<Record<string, string>>({});
  const [mediaLoading, setMediaLoading] = useState("");
  const [result, setResult] = useState<HandleResult | "">("");
  const [note, setNote] = useState("");
  const [handling, setHandling] = useState(false);

  useEffect(() => {
    mediaUrlsRef.current = mediaUrls;
  }, [mediaUrls]);
  useEffect(() => () => {
    Object.values(mediaUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const toggleMaterial = async (material: Material) => {
    const current = mediaUrls[material.id];
    if (current) {
      URL.revokeObjectURL(current);
      setMediaUrls((urls) => { const next = { ...urls }; delete next[material.id]; return next; });
      return;
    }
    setMediaLoading(material.id);
    try {
      const blob = await apiBlob(`/admin/subsidy-consultations/${consultationId}/materials/${material.id}`);
      const url = URL.createObjectURL(blob);
      setMediaUrls((urls) => ({ ...urls, [material.id]: url }));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "资料读取失败");
    } finally {
      setMediaLoading("");
    }
  };

  const handle = async () => {
    if (!detail || detail.status !== "new" || !result) return;
    setHandling(true);
    try {
      const value = await api<unknown>(`/admin/subsidy-consultations/${detail.id}/handle`, { method: "POST", body: JSON.stringify({ result, note: note.trim() || undefined }) });
      const partial = normalizeConsultation(value);
      onUpdated({
        ...detail,
        ...partial,
        declaredValueFen: detail.declaredValueFen,
        consultationFeeFen: detail.consultationFeeFen,
        administrativeFees: detail.administrativeFees,
        administrativeFeeFen: detail.administrativeFeeFen,
        totalTransferCostFen: detail.totalTransferCostFen,
        vehicle: partial.vehicle ?? detail.vehicle,
        contact: detail.contact,
        contactNameMasked: partial.contactNameMasked || detail.contactNameMasked,
        contactPhoneMasked: partial.contactPhoneMasked || detail.contactPhoneMasked,
        tierLabel: partial.tierLabel || detail.tierLabel,
        materials: detail.materials,
        events: detail.events,
      });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "处理咨询失败");
    } finally {
      setHandling(false);
    }
  };

  const materialByKind = new Map((detail?.materials || []).map((material) => [material.kind, material]));

  return <div className="drawer-layer subsidy-drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <aside className="detail-drawer subsidy-detail-drawer" aria-label="补贴咨询详情">
      <header><div><small>SENSITIVE CONSULTATION · AUDITED READ</small><h2>{detail?.consultationCode || "咨询详情"}</h2><p>{detail ? `${formatDateTime(detail.submittedAt)} · ${statusLabels[detail.status] || detail.status}` : "正在读取敏感资料"}</p></div><button type="button" aria-label="关闭咨询详情" onClick={close}><X /></button></header>
      <div className="drawer-scroll">
        {!detail ? <div className={`subsidy-detail-loading ${detailError ? "error" : ""}`}>{detailError ? <WarningCircle /> : <ShieldCheck />}<strong>{detailError ? "敏感详情读取失败" : "正在读取咨询详情"}</strong><small>{detailError || "敏感详情读取由服务端留痕"}</small>{detailError ? <button type="button" onClick={close}>关闭后重试</button> : null}</div> : <>
          <div className="subsidy-sensitive-notice"><Eye /><div><strong>敏感资料按需查看并留痕</strong><p>姓名、手机号及每一项影像只用于本次合法咨询，禁止另行下载、传播或用于申报。</p></div></div>
          <section className="drawer-status"><span className={`status-pill subsidy-status-${detail.status}`}>{statusLabels[detail.status] || detail.status}</span><strong>{detail.vehicle?.plateNumber || "车辆待核对"}</strong><small>车主自报估值 {formatValue(detail.declaredValueFen)} · 过户费用合计（参考）¥{money(detail.totalTransferCostFen)}</small></section>
          <section className="detail-section"><h3>咨询人与价格快照 <em>历史不可改写</em></h3><dl>
            <div><dt>姓名</dt><dd>{detail.contact?.name || detail.contactNameMasked || "—"}</dd></div><div><dt>手机号</dt><dd>{detail.contact?.phone || detail.contactPhoneMasked || "—"}</dd></div><div><dt>车辆</dt><dd>{detail.vehicle?.modelName || detail.vehicle?.vehicleType || "—"}</dd></div><div><dt>命中档位</dt><dd>{detail.tierLabel || "—"}</dd></div><div><dt>价格版本</dt><dd>{detail.feePlanVersion ?? "—"}</dd></div><div><dt>咨询服务费</dt><dd>¥{money(detail.consultationFeeFen)}</dd></div><div><dt>牌照费</dt><dd>¥{money(detail.administrativeFees.plateFeeFen)}</dd></div><div><dt>邮寄费</dt><dd>¥{money(detail.administrativeFees.mailingFeeFen)}</dd></div><div><dt>制作工本费</dt><dd>¥{money(detail.administrativeFees.productionFeeFen)}</dd></div><div><dt>行政性收费小计</dt><dd>¥{money(detail.administrativeFeeFen)}</dd></div><div className="total"><dt>过户费用合计（参考）</dt><dd>¥{money(detail.totalTransferCostFen)}</dd></div>
          </dl><p className="subsidy-fee-boundary">费用快照仅供参考，以办理机构实际收取及所选服务为准；本模块不收款、不代办理。</p></section>
          <section className="detail-section subsidy-material-section"><h3>九项咨询资料 <em>点击小眼睛后读取</em></h3><div className="subsidy-material-grid">{materialOrder.map((kind) => {
            const material = materialByKind.get(kind);
            const url = material ? mediaUrls[material.id] : "";
            return <article key={kind} className={material ? "available" : "missing"}>
              <header><FileImage /><span><strong>{materialLabels[kind]}</strong><small>{material ? `${formatBytes(material.sizeBytes)} · ${material.mimeType || "图片"}` : "未提交"}</small></span></header>
              {url ? <img src={url} alt={materialLabels[kind]} draggable={false} onContextMenu={(event) => event.preventDefault()} /> : <div className="subsidy-material-placeholder"><ShieldCheck /><span>原图默认隐藏</span></div>}
              <button type="button" disabled={!material || mediaLoading === material.id || detail.status === "withdrawn" || detail.status === "expired"} onClick={() => material && void toggleMaterial(material)}>{url ? <EyeSlash /> : <Eye />}{mediaLoading === material?.id ? "读取中…" : url ? "隐藏资料" : "查看资料"}</button>
            </article>;
          })}</div><p className="subsidy-material-boundary">车辆四角与启动后仪表盘仅作咨询参考，不是官方申报材料、估值证明或资格核验结果。</p></section>
          <section className="detail-section subsidy-handle-panel"><h3>咨询处理 <em>简单两状态</em></h3>{detail.status === "new" ? <><label><span>处理结果</span><select aria-label="咨询处理结果" value={result} onChange={(event) => setResult(event.target.value as HandleResult | "")}><option value="">请选择固定结果</option>{resultOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label><span>内部备注（最多300字）</span><textarea aria-label="咨询内部备注" maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} placeholder="仅记录必要处理信息，不要重复粘贴证件内容" /></label><button type="button" disabled={!result || handling} onClick={() => void handle()}><CheckCircle />{handling ? "提交中…" : "标记为已处理"}</button></> : <div className="subsidy-handle-complete"><CheckCircle /><span><strong>{detail.result ? resultOptions.find((item) => item.value === detail.result)?.label || detail.result : statusLabels[detail.status]}</strong><small>{detail.internalNote || formatDateTime(detail.handledAt || detail.withdrawnAt)}</small></span></div>}</section>
        </>}
      </div>
    </aside>
  </div>;
}
