import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  CaretRight,
  CheckCircle,
  Clock,
  Copy,
  DeviceMobile,
  Eye,
  FileImage,
  GearSix,
  Handshake,
  Phone,
  ShieldCheck,
  X,
  XCircle,
} from "@phosphor-icons/react";

type InsuranceMode = "demo" | "real";
type LeadStatus = "new" | "handed_off" | "closed" | "withdrawn";
type LeadFilter = "all" | "new" | "handed_off" | "closed";
type ClosureResult = "completed_referral" | "customer_declined" | "unable_to_contact" | "invalid_lead";

type Vehicle = {
  id: string | null;
  plateNumber: string;
  modelName: string;
};

type InsuranceLead = {
  id: string;
  leadCode: string;
  status: LeadStatus | string;
  source: unknown;
  vehicle: Vehicle;
  contactNameMasked: string;
  maskedPhone: string;
  renewalWindow: string;
  contactWindow: string;
  partnerName?: string | null;
  submittedAt: string;
  handedOffAt?: string | null;
  closedAt?: string | null;
};

type DisclosureSnapshot = {
  version?: string;
  partnerName?: string;
  dataScope?: string[];
  purpose?: string;
  retention?: string;
  consentText?: string;
  acceptedAt?: string | null;
};

type InsuranceLeadDetail = InsuranceLead & {
  contact?: { name?: string; phone?: string };
  disclosure?: DisclosureSnapshot;
  media?: {
    available?: boolean;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
    deleteAfter?: string;
  };
  events?: Array<Record<string, unknown>>;
};

type Partner = {
  id: string;
  name: string;
  recipientName?: string;
  active?: boolean;
  isDefault?: boolean;
};

type Disclosure = {
  acceptsRealData?: boolean;
  version?: string;
  partner?: { id?: string; name?: string; recipientName?: string };
  partnerName?: string;
  dataScope?: string[];
  purpose?: string;
  retention?: string;
  consentText?: string;
  contactEtaText?: string;
};

type DisclosureResponse = Disclosure & {
  mode?: InsuranceMode;
  activePartnerId?: string;
  partners?: Partner[];
  disclosure?: Disclosure;
};

type DisclosureState = {
  mode: InsuranceMode;
  activePartnerId: string;
  partners: Partner[];
  disclosure: Disclosure;
};

type DisclosureDraft = {
  partnerId: string;
  recipientName: string;
  dataScope: string;
  purpose: string;
  retention: string;
  consentText: string;
  contactEtaText: string;
};

type InsuranceApiError = Error & { status?: number; code?: string };

const filterOptions: Array<{ value: LeadFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "new", label: "新线索" },
  { value: "handed_off", label: "已转交" },
  { value: "closed", label: "已关闭" },
];

const disclosureImpactItems = [
  { number: 1, label: "接收合作方", location: "信息使用说明 · 信息接收方中的机构名称" },
  { number: 2, label: "资料接收主体", location: "信息使用说明 · 信息接收方中的具体团队" },
  { number: 3, label: "授权资料范围", location: "信息使用说明 · 本次使用的信息" },
  { number: 4, label: "使用目的", location: "信息使用说明 · 使用目的" },
  { number: 5, label: "保存期限", location: "信息使用说明 · 保存期限" },
  { number: 6, label: "预计联系时效", location: "页面顶部提示与提交凭证" },
  { number: 7, label: "用户授权文案", location: "信息使用说明 · 同意按钮上方" },
  { number: 8, label: "披露版本", location: "信息使用说明标题下方，并参与提交校验" },
] as const;

const statusLabels: Record<string, string> = {
  new: "新线索",
  handed_off: "已转交",
  closed: "已关闭",
  withdrawn: "已撤回",
};

const closureOptions: Array<{ value: ClosureResult; label: string }> = [
  { value: "completed_referral", label: "已完成服务转介" },
  { value: "customer_declined", label: "客户暂不需要" },
  { value: "unable_to_contact", label: "多次联系未果" },
  { value: "invalid_lead", label: "无效线索" },
];

const renewalWindowLabels: Record<string, string> = {
  within_30_days: "30 天内",
  one_to_three_months: "1–3 个月",
  over_three_months: "3 个月以上",
};

const contactWindowLabels: Record<string, string> = {
  morning: "上午 9:00–12:00",
  afternoon: "下午 12:00–18:00",
  evening: "晚上 18:00–21:00",
  anytime: "任意时间",
};

const eventActionLabels: Record<string, string> = {
  lead_created: "用户提交续保对接需求",
  duplicate_receipt_issued: "重复提交，已返回原线索回执",
  lead_withdrawn: "用户撤回授权",
  withdraw_receipt_read: "用户查看撤回结果",
  sensitive_detail_read: "保险运营查看敏感详情",
  sensitive_media_read: "保险运营查看行驶证（已留痕）",
  lead_handed_off: "线索已转交合作方",
  lead_closed: "线索已关闭",
  media_retention_deleted: "行驶证影像已按期删除",
  pii_retention_purged: "个人信息已按期清除",
};

async function insuranceApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  const payload = await response.json().catch(() => null) as { data?: T; error?: { message?: string; code?: string }; message?: string } | null;
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `请求失败（${response.status}）`) as InsuranceApiError;
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return (payload && "data" in payload ? payload.data : payload) as T;
}

async function insuranceMedia(path: string): Promise<Blob> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string }; message?: string } | null;
    const error = new Error(payload?.error?.message || payload?.message || `影像读取失败（${response.status}）`) as InsuranceApiError;
    error.status = response.status;
    throw error;
  }
  return response.blob();
}

function formatDateTime(value?: string | null) {
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

function formatBytes(value?: number) {
  if (!value || value < 1) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function safeText(value: unknown, fallback = "—") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return fallback;
}

function sourceText(source: unknown) {
  if (typeof source === "string") {
    const labels: Record<string, string> = {
      "web-owner-services": "车主服务 · 保险入口",
      mini_program: "车主服务 · 小程序",
      owner_services: "车主服务",
      insurance: "车险服务入口",
    };
    return labels[source] || source;
  }
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    const parts = [record.channel, record.page, record.campaign, record.scene].map((item) => safeText(item, "")).filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  return "车主服务 · 保险入口";
}

function renewalWindowText(value?: string) {
  return value ? renewalWindowLabels[value] || value : "—";
}

function contactWindowText(value?: string) {
  return value ? contactWindowLabels[value] || value : "—";
}

function maskPhone(value?: string) {
  if (!value) return "—";
  if (value.includes("*")) return value;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  if (value.length > 6) return `${value.slice(0, 3)}****${value.slice(-2)}`;
  return "***";
}

function normalizeDisclosure(raw: DisclosureResponse, fallbackMode: InsuranceMode): DisclosureState {
  const disclosure = raw.disclosure || raw;
  let partners = Array.isArray(raw.partners) ? raw.partners.filter((partner) => partner?.id && partner?.name) : [];
  if (!partners.length && disclosure.partner?.id && disclosure.partner?.name) {
    partners = [{ id: disclosure.partner.id, name: disclosure.partner.name, recipientName: disclosure.partner.recipientName, active: true, isDefault: true }];
  }
  const activePartnerId = raw.activePartnerId
    || disclosure.partner?.id
    || partners.find((partner) => partner.active)?.id
    || partners.find((partner) => partner.isDefault)?.id
    || partners[0]?.id
    || "";
  return { mode: raw.mode || fallbackMode, activePartnerId, partners, disclosure };
}

function disclosureDraft(state: DisclosureState): DisclosureDraft {
  const partner = state.partners.find((item) => item.id === state.activePartnerId) || state.partners[0];
  return {
    partnerId: partner?.id || "",
    recipientName: partner?.recipientName || "",
    dataScope: state.disclosure.dataScope?.join("，") || "",
    purpose: state.disclosure.purpose || "",
    retention: state.disclosure.retention || "",
    consentText: state.disclosure.consentText || "",
    contactEtaText: state.disclosure.contactEtaText || "",
  };
}

function splitDataScope(value: string) {
  return value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean);
}

function disclosureDraftSignature(draft: DisclosureDraft) {
  return JSON.stringify({
    partnerId: draft.partnerId,
    recipientName: draft.recipientName.trim(),
    dataScope: splitDataScope(draft.dataScope),
    purpose: draft.purpose.trim(),
    retention: draft.retention.trim(),
    consentText: draft.consentText.trim(),
    contactEtaText: draft.contactEtaText.trim(),
  });
}

function ImpactNumber({ number }: { number: number }) {
  return <b className="insurance-impact-pin" data-impact-number={number} aria-label={`配置项 ${number}`}>{number}</b>;
}

function eventText(event: Record<string, unknown>) {
  const explicitLabel = safeText(event.label || event.title, "");
  if (explicitLabel) return explicitLabel;
  const action = safeText(event.action || event.type, "");
  return eventActionLabels[action] || "线索状态更新";
}

function eventTime(event: Record<string, unknown>) {
  const value = event.at || event.createdAt || event.timestamp;
  return typeof value === "string" ? formatDateTime(value) : "—";
}

function eventActor(event: Record<string, unknown>) {
  const operator = safeText(event.operator, "");
  if (operator) return operator;
  const actor = safeText(event.actorType, "");
  return ({ owner: "用户", admin: "保险运营", system: "系统" } as Record<string, string>)[actor] || "";
}

function buildHandoffSummary(lead: InsuranceLeadDetail) {
  return [
    `【驭小满车险续保对接线索】${lead.leadCode}`,
    `车辆：${lead.vehicle?.plateNumber || "待核验"} · ${lead.vehicle?.modelName || "车型待补充"}`,
    `联系人：${lead.contact?.name || "—"} ${lead.contact?.phone || "—"}`,
    `续保窗口：${renewalWindowText(lead.renewalWindow)}`,
    `方便联系：${contactWindowText(lead.contactWindow)}`,
    `来源：${sourceText(lead.source)}`,
    `用户授权：${lead.disclosure?.acceptedAt ? `已于 ${formatDateTime(lead.disclosure.acceptedAt)} 授权` : "未见有效授权"}`,
    `授权版本：${lead.disclosure?.version || "—"}`,
  ].join("\n");
}

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function InsuranceLeadsPage({ onError }: { onError: (message: string) => void }) {
  const [mode, setMode] = useState<InsuranceMode>("demo");
  const [filter, setFilter] = useState<LeadFilter>("all");
  const [leads, setLeads] = useState<InsuranceLead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [disclosure, setDisclosure] = useState<DisclosureState | null>(null);
  const [draft, setDraft] = useState<DisclosureDraft | null>(null);
  const [savingDisclosure, setSavingDisclosure] = useState(false);
  const [configSaved, setConfigSaved] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InsuranceLeadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const deepLinkOpenedRef = useRef("");

  const reportError = (reason: unknown) => {
    const error = reason as InsuranceApiError;
    onError(error.message || "车险线索服务暂不可用");
  };

  const loadLeads = () => {
    setLoading(true);
    const query = new URLSearchParams({ page: "1", pageSize: "50" });
    if (filter !== "all") query.set("status", filter);
    void insuranceApi<{ items?: InsuranceLead[]; total?: number; mode?: InsuranceMode }>(`/admin/insurance/leads?${query}`)
      .then((result) => {
        const items = Array.isArray(result?.items) ? result.items : [];
        setLeads(items);
        setTotal(typeof result?.total === "number" ? result.total : items.length);
        if (result?.mode) setMode(result.mode);
      })
      .catch(reportError)
      .finally(() => setLoading(false));
  };

  useEffect(loadLeads, [filter]);

  useEffect(() => {
    void insuranceApi<DisclosureResponse>("/admin/insurance/partners/disclosure")
      .then((result) => {
        const normalized = normalizeDisclosure(result, mode);
        setDisclosure(normalized);
        setDraft(disclosureDraft(normalized));
        setMode(normalized.mode);
      })
      .catch(reportError);
  }, []);

  const metrics = useMemo(() => ({
    shown: leads.length,
    newCount: leads.filter((lead) => lead.status === "new").length,
    handedOff: leads.filter((lead) => lead.status === "handed_off").length,
    withdrawn: leads.filter((lead) => lead.status === "withdrawn").length,
  }), [leads]);

  const selectedDisclosurePartner = disclosure && draft
    ? disclosure.partners.find((partner) => partner.id === draft.partnerId)
    : undefined;
  const previewPartnerName = selectedDisclosurePartner?.name.trim() || "待选择接收合作方";
  const previewRecipientName = draft?.recipientName.trim() || "待填写资料接收主体";
  const previewPurpose = draft?.purpose.trim() || "待填写使用目的";
  const previewRetention = draft?.retention.trim() || "待填写保存期限";
  const previewConsentText = draft?.consentText.trim() || "待填写用户授权文案";
  const previewContactEta = draft?.contactEtaText.trim() || "待填写预计联系时效";
  const previewDataScope = draft ? splitDataScope(draft.dataScope) : [];
  const savedDraft = disclosure ? disclosureDraft(disclosure) : null;
  const previewIsDirty = Boolean(draft && savedDraft && disclosureDraftSignature(draft) !== disclosureDraftSignature(savedDraft));

  const openDetail = (lead: InsuranceLead) => {
    setSelectedId(lead.id);
    setDetail(null);
    setDetailLoading(true);
    void insuranceApi<InsuranceLeadDetail>(`/admin/insurance/leads/${lead.id}`)
      .then(setDetail)
      .catch((reason) => {
        reportError(reason);
        setSelectedId(null);
      })
      .finally(() => setDetailLoading(false));
  };

  useEffect(() => {
    const leadId = new URLSearchParams(window.location.search).get("lead") || "";
    if (!leadId || deepLinkOpenedRef.current === leadId) return;
    deepLinkOpenedRef.current = leadId;
    setSelectedId(leadId);
    setDetail(null);
    setDetailLoading(true);
    void insuranceApi<InsuranceLeadDetail>(`/admin/insurance/leads/${encodeURIComponent(leadId)}`)
      .then(setDetail)
      .catch((reason) => { reportError(reason); setSelectedId(null); })
      .finally(() => setDetailLoading(false));
  }, []);

  const saveDisclosure = async (event: FormEvent) => {
    event.preventDefault();
    if (!disclosure || !draft) return;
    const partner = disclosure.partners.find((item) => item.id === draft.partnerId);
    if (!partner) {
      onError("请从服务端已配置的合作方中选择接收方");
      return;
    }
    setSavingDisclosure(true);
    setConfigSaved("");
    try {
      const result = await insuranceApi<DisclosureResponse>("/admin/insurance/partners/disclosure", {
        method: "PUT",
        body: JSON.stringify({
          id: partner.id,
          name: partner.name,
          recipientName: draft.recipientName.trim(),
          dataScope: splitDataScope(draft.dataScope),
          purpose: draft.purpose.trim(),
          retention: draft.retention.trim(),
          consentText: draft.consentText.trim(),
          contactEtaText: draft.contactEtaText.trim(),
          active: Boolean(partner.active),
          isDefault: Boolean(partner.isDefault),
        }),
      });
      const normalized = normalizeDisclosure(result, mode);
      setDisclosure(normalized);
      setDraft(disclosureDraft(normalized));
      setMode(normalized.mode);
      setConfigSaved("披露配置已保存");
      window.setTimeout(() => setConfigSaved(""), 2200);
    } catch (reason) {
      reportError(reason);
    } finally {
      setSavingDisclosure(false);
    }
  };

  const updateLead = (updated: InsuranceLeadDetail) => {
    setDetail(updated);
    setLeads((current) => current.map((lead) => lead.id === updated.id ? { ...lead, ...updated } : lead));
  };

  return <div className="insurance-workbench">
    <section className="insurance-workbench-head">
      <div>
        <span className={`insurance-mode-pill ${mode}`}><i />{mode === "real" ? "真实数据模式" : "演示模式"}</span>
        <h2>从用户授权到合作方转交，全程可追溯</h2>
        <p>{mode === "real" ? "当前可处理真实客户线索，请严格按授权范围使用资料。" : "当前为演示环境，不得录入或转交真实客户资料。"}</p>
      </div>
    </section>

    <section className="insurance-metrics" aria-label="线索概览">
      <article><span><FileImage /></span><div><small>当前筛选</small><strong>{total}<em> 条</em></strong><p>本页展示 {metrics.shown} 条线索</p></div></article>
      <article><span><Clock /></span><div><small>待响应</small><strong>{metrics.newCount}<em> 条</em></strong><p>优先按联系时段处理</p></div></article>
      <article><span><Handshake /></span><div><small>已转交</small><strong>{metrics.handedOff}<em> 条</em></strong><p>合作方与时间已固化</p></div></article>
      <article><span><ShieldCheck /></span><div><small>用户撤回</small><strong>{metrics.withdrawn}<em> 条</em></strong><p>灰态显示并停止处理</p></div></article>
    </section>

    {disclosure ? <details className="insurance-disclosure-config">
      <summary>
        <span><GearSix /><span><strong>合作方与授权披露配置</strong><small>仅使用服务端已登记合作方，不在前端虚构接收主体</small></span></span>
        <span className={`insurance-mode-pill ${disclosure.mode}`}>{disclosure.mode === "real" ? "真实配置" : "演示配置"}</span>
      </summary>
      {draft ? <form onSubmit={saveDisclosure}>
        <div className="insurance-config-grid">
          <label data-impact-number="1"><span className="insurance-config-field-title"><b aria-hidden="true">1</b>接收合作方</span><select aria-label="接收合作方" value={draft.partnerId} onChange={(event) => {
            const partner = disclosure.partners.find((item) => item.id === event.target.value);
            setDraft((current) => current ? { ...current, partnerId: event.target.value, recipientName: partner?.recipientName || current.recipientName } : current);
          }} disabled={!disclosure.partners.length}><option value="">{disclosure.partners.length ? "请选择已登记合作方" : "尚未登记合作方"}</option>{disclosure.partners.map((partner) => <option value={partner.id} key={partner.id}>{partner.name}{partner.active ? " · 启用中" : ""}</option>)}</select></label>
          <label data-impact-number="2"><span className="insurance-config-field-title"><b aria-hidden="true">2</b>资料接收主体</span><input aria-label="资料接收主体" value={draft.recipientName} onChange={(event) => setDraft({ ...draft, recipientName: event.target.value })} /></label>
          <label className="wide" data-impact-number="3"><span className="insurance-config-field-title"><b aria-hidden="true">3</b>授权资料范围</span><input aria-label="授权资料范围" value={draft.dataScope} onChange={(event) => setDraft({ ...draft, dataScope: event.target.value })} /><small className="insurance-config-field-help">多项内容请使用逗号分隔</small></label>
          <label className="wide" data-impact-number="4"><span className="insurance-config-field-title"><b aria-hidden="true">4</b>使用目的</span><input aria-label="使用目的" value={draft.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} /></label>
          <label data-impact-number="5"><span className="insurance-config-field-title"><b aria-hidden="true">5</b>保存期限</span><input aria-label="保存期限" value={draft.retention} onChange={(event) => setDraft({ ...draft, retention: event.target.value })} /></label>
          <label data-impact-number="6"><span className="insurance-config-field-title"><b aria-hidden="true">6</b>预计联系时效</span><input aria-label="预计联系时效" value={draft.contactEtaText} onChange={(event) => setDraft({ ...draft, contactEtaText: event.target.value })} /></label>
          <label className="wide" data-impact-number="7"><span className="insurance-config-field-title"><b aria-hidden="true">7</b>用户授权文案</span><textarea aria-label="用户授权文案" value={draft.consentText} onChange={(event) => setDraft({ ...draft, consentText: event.target.value })} /></label>
        </div>
        <details className="insurance-client-impact">
          <summary>
            <span><DeviceMobile /><span><strong>客户端实时预览</strong><small>上方修改会立即映射到下方同号位置，保存后才会对新页面生效</small></span></span>
            <span className={`insurance-impact-summary-meta${previewIsDirty ? " dirty" : ""}`}><small>{previewIsDirty ? "草稿未保存 · " : "当前已保存 · "}8 项映射</small><CaretRight /></span>
          </summary>
          <div className="insurance-impact-body">
            <div className="insurance-impact-gallery" aria-label="客户端实时预览">
              <article className="insurance-impact-card insurance-live-preview-card" data-preview-state="disclosure-basic" aria-label="授权基础信息实时预览">
                <header>
                  <b>01</b>
                  <span><strong>授权基础信息</strong><small>合作方、接收主体、用途、期限与版本</small></span>
                </header>
                <div className="insurance-live-client">
                  <div className="insurance-live-page-context"><span>预计续保时间</span><i>30 天内</i><i>1–3 个月</i><i>3 个月以上</i></div>
                  <section className="insurance-live-sheet">
                    <span className="insurance-live-handle" aria-hidden="true" />
                    <header><span><strong>信息使用说明</strong><small>{previewIsDirty ? "草稿预览 · 保存后生成新版本" : `版本 ${disclosure.disclosure.version || "待配置"}`}</small></span></header>
                    {disclosure.mode === "demo" ? <p className="insurance-live-warning">当前为演示环境，仅提交合成演示资料。</p> : null}
                    <dl className="insurance-live-facts">
                      <div><dt><span><ImpactNumber number={1} /><ImpactNumber number={2} /></span>信息接收方</dt><dd data-preview-field="partner-recipient"><span data-preview-field="partner-name">{previewPartnerName}</span>{previewRecipientName !== previewPartnerName ? <> · <span data-preview-field="recipient-name">{previewRecipientName}</span></> : null}</dd></div>
                      <div><dt><ImpactNumber number={4} />使用目的</dt><dd data-preview-field="purpose">{previewPurpose}</dd></div>
                      <div><dt><ImpactNumber number={5} />保存期限</dt><dd data-preview-field="retention">{previewRetention}</dd></div>
                    </dl>
                    <p className="insurance-live-version-note" data-preview-field="version"><ImpactNumber number={8} />{previewIsDirty ? <><strong>保存后生成新版本</strong><small>当前版本 {disclosure.disclosure.version || "待配置"}</small></> : <><strong>{disclosure.disclosure.version || "待配置"}</strong><small>当前生效版本</small></>}</p>
                  </section>
                </div>
                <footer>保存后的客户端效果 · 内容来自上方当前草稿</footer>
              </article>

              <article className="insurance-impact-card insurance-live-preview-card" data-preview-state="disclosure-consent" aria-label="资料授权确认实时预览">
                <header>
                  <b>02</b>
                  <span><strong>资料授权确认</strong><small>资料范围、授权文案与同意操作</small></span>
                </header>
                <div className="insurance-live-client">
                  <div className="insurance-live-page-context"><span>联系人</span><i>姓名</i><i>手机号</i></div>
                  <section className="insurance-live-sheet insurance-live-consent-sheet">
                    <span className="insurance-live-handle" aria-hidden="true" />
                    <header><span><strong>信息使用说明</strong><small>请阅读后明确同意</small></span></header>
                    <div className="insurance-live-scope" data-preview-field="data-scope">
                      <h5><ImpactNumber number={3} />本次使用的信息</h5>
                      {previewDataScope.length ? <ul>{previewDataScope.map((item) => <li key={item}><CheckCircle />{item}</li>)}</ul> : <p className="insurance-live-empty">待填写授权资料范围</p>}
                    </div>
                    <p className="insurance-live-consent" data-preview-field="consent-text"><ImpactNumber number={7} /><span>{previewConsentText}</span></p>
                    <button type="button" tabIndex={-1}>同意并继续</button>
                  </section>
                </div>
                <footer>保存后的客户端效果 · 资料范围按逗号自动拆分</footer>
              </article>

              <article className="insurance-impact-card insurance-live-preview-card" data-preview-state="receipt" aria-label="提交成功凭证实时预览">
                <header>
                  <b>03</b>
                  <span><strong>提交成功凭证</strong><small>预计联系时效同步进入服务凭证</small></span>
                </header>
                <div className="insurance-live-client insurance-live-receipt">
                  <p className="insurance-live-eta-banner">提交需求，{previewContactEta}</p>
                  <section className="insurance-live-receipt-hero"><CheckCircle /><small>续保对接申请</small><strong>已为您登记续保需求</strong><p>{previewContactEta}，请留意来电。</p></section>
                  <dl>
                    <div><dt>服务编号 / 车辆 / 手机号</dt><dd>由用户提交后生成</dd></div>
                    <div data-preview-field="contact-eta"><dt><ImpactNumber number={6} />预计联系</dt><dd>{previewContactEta}</dd></div>
                  </dl>
                </div>
                <footer>新提交凭证预览 · 历史凭证不会被当前配置改写</footer>
              </article>
            </div>
            <ol className="insurance-impact-legend">
              {disclosureImpactItems.map((item) => <li key={item.number}>
                <b>{item.number}</b>
                <span><strong>{item.label}</strong><small>{item.location}</small></span>
              </li>)}
            </ol>
          </div>
          <p className="insurance-impact-note"><ShieldCheck />预览直接读取上方草稿，但只有点击“保存披露配置”后才会下发。保存会由服务端生成新版本；已打开页面若版本不一致，将被要求重新阅读并授权。</p>
        </details>
        <footer><div className="insurance-config-footer-meta"><span className="insurance-config-version" data-impact-number="8"><b aria-hidden="true">8</b><strong>披露版本</strong><em>{disclosure.disclosure.version || "待配置"}</em></span>{configSaved ? <span className="insurance-config-save-state"><CheckCircle />{configSaved}</span> : null}</div><button type="submit" disabled={savingDisclosure || !draft.partnerId}>{savingDisclosure ? "保存中…" : "保存披露配置"}</button></footer>
      </form> : null}
    </details> : null}

    <section className="content-card insurance-leads-card">
      <div className="insurance-list-head">
        <div><small>INSURANCE LEAD PIPELINE</small><h3>车险续保对接线索</h3><p>列表仅展示脱敏联系人；点击详情会触发敏感读取审计。</p></div>
        <div className="insurance-filter-tabs" role="group" aria-label="线索状态筛选">{filterOptions.map((option) => <button type="button" key={option.value} className={filter === option.value ? "active" : ""} onClick={() => setFilter(option.value)}>{option.label}</button>)}</div>
      </div>
      <div className="table-wrap insurance-leads-table">
        <table>
          <thead><tr><th>提交时间 / 编号</th><th>车辆</th><th>联系人（脱敏）</th><th>续保与联系时段</th><th>合作方</th><th>状态</th><th /></tr></thead>
          <tbody>{leads.map((lead) => <tr key={lead.id} className={lead.status === "withdrawn" ? "insurance-row-withdrawn" : ""} onClick={() => openDetail(lead)}>
            <td><strong>{formatDateTime(lead.submittedAt)}</strong><small>{lead.leadCode || lead.id}</small></td>
            <td><strong>{lead.vehicle?.plateNumber || "待核验"}</strong><small>{lead.vehicle?.modelName || "车型待补充"}</small></td>
            <td><strong>{lead.contactNameMasked || "匿名车主"}</strong><small>{maskPhone(lead.maskedPhone)}</small></td>
            <td><strong>{renewalWindowText(lead.renewalWindow)}</strong><small>{contactWindowText(lead.contactWindow)}</small></td>
            <td><strong>{lead.partnerName || "尚未转交"}</strong><small>{lead.handedOffAt ? formatDateTime(lead.handedOffAt) : sourceText(lead.source)}</small></td>
            <td><span className={`status-pill insurance-status-${lead.status}`}>{statusLabels[lead.status] || lead.status}</span>{lead.status === "withdrawn" ? <small>用户已撤回，停止处理</small> : null}</td>
            <td><CaretRight /></td>
          </tr>)}</tbody>
        </table>
        {!leads.length && !loading ? <div className="empty-table">当前筛选下暂无车险线索</div> : null}
        {loading ? <div className="table-loading">正在同步车险线索…</div> : null}
      </div>
    </section>

    {selectedId ? <InsuranceLeadDrawer
      leadId={selectedId}
      detail={detail}
      loading={detailLoading}
      disclosure={disclosure}
      close={() => { setSelectedId(null); setDetail(null); const url = new URL(window.location.href); url.searchParams.delete("lead"); window.history.replaceState({}, "", `${url.pathname}${url.search}`); }}
      onUpdated={updateLead}
      onError={reportError}
    /> : null}
  </div>;
}

function InsuranceLeadDrawer({
  leadId,
  detail,
  loading,
  disclosure,
  close,
  onUpdated,
  onError,
}: {
  leadId: string;
  detail: InsuranceLeadDetail | null;
  loading: boolean;
  disclosure: DisclosureState | null;
  close: () => void;
  onUpdated: (lead: InsuranceLeadDetail) => void;
  onError: (reason: unknown) => void;
}) {
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaLoading, setMediaLoading] = useState(false);
  const [copyState, setCopyState] = useState("");
  const [partnerId, setPartnerId] = useState(disclosure?.activePartnerId || "");
  const [closureResult, setClosureResult] = useState<ClosureResult | "">("");
  const [actionBusy, setActionBusy] = useState<"handoff" | "close" | "">("");

  useEffect(() => {
    setPartnerId(disclosure?.activePartnerId || "");
  }, [disclosure?.activePartnerId]);

  useEffect(() => () => {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  }, [mediaUrl]);

  const loadMedia = async () => {
    setMediaLoading(true);
    try {
      const blob = await insuranceMedia(`/admin/insurance/leads/${leadId}/media`);
      const nextUrl = URL.createObjectURL(blob);
      setMediaUrl(nextUrl);
    } catch (reason) {
      onError(reason);
    } finally {
      setMediaLoading(false);
    }
  };

  const copySummary = async () => {
    if (!detail?.disclosure?.acceptedAt) {
      onError(new Error("缺少有效授权快照，不能复制转交摘要"));
      return;
    }
    try {
      await writeClipboard(buildHandoffSummary(detail));
      setCopyState("转交摘要已复制");
      window.setTimeout(() => setCopyState(""), 2200);
    } catch (reason) {
      onError(reason);
    }
  };

  const handoff = async () => {
    if (!detail || detail.status !== "new") return;
    if (!detail.disclosure?.acceptedAt) {
      onError(new Error("缺少有效授权快照，不能转交线索"));
      return;
    }
    if (!partnerId || !disclosure?.partners.some((partner) => partner.id === partnerId)) {
      onError(new Error("请选择服务端已登记的合作方"));
      return;
    }
    setActionBusy("handoff");
    try {
      const updated = await insuranceApi<InsuranceLeadDetail>(`/admin/insurance/leads/${detail.id}/handoff`, {
        method: "POST",
        body: JSON.stringify({ partnerId }),
      });
      onUpdated(updated);
    } catch (reason) {
      onError(reason);
    } finally {
      setActionBusy("");
    }
  };

  const closeLead = async () => {
    if (!detail || detail.status !== "handed_off" || !closureResult) return;
    setActionBusy("close");
    try {
      const updated = await insuranceApi<InsuranceLeadDetail>(`/admin/insurance/leads/${detail.id}/close`, {
        method: "POST",
        body: JSON.stringify({ result: closureResult }),
      });
      onUpdated(updated);
    } catch (reason) {
      onError(reason);
    } finally {
      setActionBusy("");
    }
  };

  return <div className="drawer-layer insurance-drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <aside className="detail-drawer wide-drawer insurance-detail-drawer" aria-label="车险线索详情">
      <header>
        <div><small>SENSITIVE LEAD · AUDITED READ</small><h2>{detail?.leadCode || "线索详情"}</h2><p>{detail ? `${sourceText(detail.source)} · ${formatDateTime(detail.submittedAt)}` : "正在加载授权资料"}</p></div>
        <button type="button" aria-label="关闭线索详情" onClick={close}><X /></button>
      </header>
      <div className="drawer-scroll">
        {loading || !detail ? <div className="insurance-detail-loading"><ShieldCheck /><strong>正在读取线索详情</strong><small>本次敏感字段读取将由服务端记录审计日志</small></div> : <>
          <div className="insurance-sensitive-notice"><Eye /><div><strong>敏感信息读取已留痕</strong><p>姓名、手机号与行驶证读取均会记录审计事件。仅可用于本次续保对接与授权转交。</p></div></div>

          <section className="drawer-status insurance-detail-status">
            <span className={`status-pill insurance-status-${detail.status}`}>{statusLabels[detail.status] || detail.status}</span>
            <strong>{detail.vehicle?.plateNumber || "车辆待核验"}</strong>
            <small>{detail.status === "withdrawn" ? "用户已撤回授权，请停止联系、复制和转交。" : `${detail.vehicle?.modelName || "车型待补充"} · ${renewalWindowText(detail.renewalWindow)}`}</small>
          </section>

          <section className="detail-section">
            <h3>客户与车辆 <em>授权后可见</em></h3>
            <dl>
              <div><dt>联系人</dt><dd>{detail.contact?.name || "—"}</dd></div>
              <div><dt>联系电话</dt><dd className="insurance-phone"><Phone />{detail.contact?.phone || "—"}</dd></div>
              <div><dt>车牌号码</dt><dd>{detail.vehicle?.plateNumber || "—"}</dd></div>
              <div><dt>车辆型号</dt><dd>{detail.vehicle?.modelName || "—"}</dd></div>
              <div><dt>续保窗口</dt><dd>{renewalWindowText(detail.renewalWindow)}</dd></div>
              <div><dt>方便联系时段</dt><dd>{contactWindowText(detail.contactWindow)}</dd></div>
              <div><dt>线索来源</dt><dd>{sourceText(detail.source)}</dd></div>
            </dl>
          </section>

          <section className="detail-section insurance-consent-section">
            <h3>用户授权快照 <em>{detail.disclosure?.version || "版本待核验"}</em></h3>
            <div className={`insurance-consent-state ${detail.disclosure?.acceptedAt ? "accepted" : "missing"}`}>
              {detail.disclosure?.acceptedAt ? <CheckCircle /> : <XCircle />}
              <span><strong>{detail.disclosure?.acceptedAt ? "已取得本次转交授权" : "未见有效授权"}</strong><small>{detail.disclosure?.acceptedAt ? formatDateTime(detail.disclosure.acceptedAt) : "不得复制或转交"}</small></span>
            </div>
            <dl>
              <div><dt>资料接收方</dt><dd>{detail.disclosure?.partnerName || "—"}</dd></div>
              <div><dt>资料范围</dt><dd>{detail.disclosure?.dataScope?.join("、") || "—"}</dd></div>
              <div><dt>使用目的</dt><dd>{detail.disclosure?.purpose || "—"}</dd></div>
              <div><dt>保存期限</dt><dd>{detail.disclosure?.retention || "—"}</dd></div>
            </dl>
            {detail.disclosure?.consentText ? <blockquote>{detail.disclosure.consentText}</blockquote> : null}
          </section>

          <section className="detail-section insurance-media-section">
            <h3>行驶证影像 <em>{detail.media?.filename || "未上传"}</em></h3>
            {detail.media?.available ? <>
              <div className="insurance-media-meta"><span><FileImage /><strong>{detail.media.filename || "行驶证影像"}</strong><small>{detail.media.mimeType || "图片"} · {formatBytes(detail.media.sizeBytes)}</small></span><span><small>自动删除时间</small><strong>{formatDateTime(detail.media.deleteAfter)}</strong></span></div>
              {mediaUrl ? <figure className="insurance-media-preview"><img src={mediaUrl} alt="线索行驶证影像" /><figcaption>本次读取已留痕；影像仅用于续保对接，禁止另行留存或传播。</figcaption></figure> : <button type="button" className="insurance-media-button" onClick={loadMedia} disabled={mediaLoading}><Eye />{mediaLoading ? "读取中…" : "查看行驶证"}</button>}
            </> : <p className="insurance-empty-copy">用户未上传行驶证影像。</p>}
          </section>

          {detail.events?.length ? <section className="detail-section insurance-events">
            <h3>处理轨迹 <em>服务端记录</em></h3>
            <ol>{detail.events.map((event, index) => <li key={`${eventTime(event)}-${index}`}><i /><div><strong>{eventText(event)}</strong><small>{eventTime(event)}{eventActor(event) ? ` · ${eventActor(event)}` : ""}</small></div></li>)}</ol>
          </section> : null}

          <section className="detail-section insurance-action-panel">
            <h3>线索操作 <em>不提供自由文本备注</em></h3>
            {detail.status === "withdrawn" ? <div className="insurance-action-lock"><XCircle /><span><strong>用户已撤回授权</strong><small>复制、转交与继续联系均已停止。</small></span></div> : <>
              <div className="insurance-copy-row"><button type="button" onClick={copySummary} disabled={!detail.disclosure?.acceptedAt}><Copy />复制转交摘要</button><span>{copyState || "摘要包含授权状态与服务边界"}</span></div>
              {detail.status === "new" ? <div className="insurance-action-row">
                <label><span>转交合作方</span><select aria-label="转交合作方" value={partnerId} onChange={(event) => setPartnerId(event.target.value)}><option value="">请选择已登记合作方</option>{disclosure?.partners.map((partner) => <option key={partner.id} value={partner.id} disabled={!partner.active}>{partner.name}{partner.active ? "" : " · 未启用"}</option>)}</select></label>
                <button type="button" className="primary" onClick={handoff} disabled={!partnerId || actionBusy !== ""}>{actionBusy === "handoff" ? "正在转交…" : "确认已转交"}</button>
              </div> : null}
              {detail.status === "handed_off" ? <div className="insurance-action-row close">
                <label><span>关闭结果</span><select aria-label="关闭结果" value={closureResult} onChange={(event) => setClosureResult(event.target.value as ClosureResult | "")}><option value="">请选择固定结果</option>{closureOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <button type="button" onClick={closeLead} disabled={!closureResult || actionBusy !== ""}>{actionBusy === "close" ? "正在关闭…" : "关闭线索"}</button>
              </div> : null}
              {detail.status === "handed_off" ? <div className="insurance-handoff-proof"><Handshake /><span><strong>已转交至 {detail.partnerName || "已登记合作方"}</strong><small>{formatDateTime(detail.handedOffAt)} · 接收方与时间已固化</small></span></div> : null}
              {detail.status === "closed" ? <div className="insurance-action-lock completed"><CheckCircle /><span><strong>线索已关闭</strong><small>{formatDateTime(detail.closedAt)} · 处理结果已固化</small></span></div> : null}
            </>}
          </section>
        </>}
      </div>
    </aside>
  </div>;
}
