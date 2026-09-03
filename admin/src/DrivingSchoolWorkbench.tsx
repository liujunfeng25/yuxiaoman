import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Buildings,
  CheckCircle,
  ClipboardText,
  Copy,
  DeviceMobile,
  Eye,
  FloppyDisk,
  Image,
  MapPin,
  PencilSimple,
  Plus,
  ShieldCheck,
  Student,
  Trash,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import {
  drivingSchoolAdminApi,
  money,
  type AdminLocationSuggestion,
  type DrivingSchool,
  type DrivingSchoolApplicationMode,
  type DrivingSchoolImage,
  type DrivingSchoolOffer,
  type DrivingSchoolOfferMapping,
  type DrivingSchoolPriceType,
  type DrivingSchoolPublicPreview,
  type DrivingSchoolRegulatoryStatus,
  type DrivingSchoolTrainingClass,
} from "./adminApi";

export type DrivingSchoolWorkspaceSection = "base" | "training" | "offers" | "media" | "preview";

type Props = {
  school: DrivingSchool;
  section: DrivingSchoolWorkspaceSection;
  setSection: (section: DrivingSchoolWorkspaceSection) => void;
  close: () => void;
  reloadDirectory: () => Promise<void>;
  onError: (message: string) => void;
};

type OfferDraft = Omit<DrivingSchoolOffer, "id"> & { id: string };

const sections: Array<[DrivingSchoolWorkspaceSection, string, typeof Buildings, string]> = [
  ["base", "基础资料", Buildings, "列表卡片、详情概览、电话与导航"],
  ["training", "备案与车型", Student, "资质说明、筛选车型与申领方式"],
  ["offers", "服务报价", ClipboardText, "列表最低价、详情报价与咨询意向"],
  ["media", "图库与营业", Image, "列表封面、详情轮播与营业时间"],
  ["preview", "预览与发布", DeviceMobile, "已保存版本与公开检查"],
];

const licenseClasses = [
  ["A1", "大型客车", false, true], ["A2", "重型牵引挂车", false, true], ["A3", "城市公交车", true, true],
  ["B1", "中型客车", false, true], ["B2", "大型货车", true, true], ["C1", "小型汽车", true, true],
  ["C2", "小型自动挡汽车", true, true], ["C3", "低速载货汽车", true, true], ["C4", "三轮汽车", true, true],
  ["C5", "残疾人专用小型自动挡载客汽车", true, true], ["C6", "轻型牵引挂车", false, true],
  ["D", "普通三轮摩托车", true, true], ["E", "普通二轮摩托车", true, true], ["F", "轻便摩托车", true, true],
  ["M", "轮式专用机械车", true, true], ["N", "无轨电车", true, true], ["P", "有轨电车", true, true],
] as const;

const regulatoryStatusLabels: Record<DrivingSchoolRegulatoryStatus, string> = {
  pending: "待核验",
  verified: "已核验",
  rejected: "核验未通过",
  expired: "已过期",
  demo: "演示资料",
};

const priceTypeLabels: Record<DrivingSchoolPriceType, string> = {
  fixed: "固定价",
  starting_from: "起价",
  range: "区间价",
  inquiry: "价格需咨询",
};

function cloneSchool(school: DrivingSchool): DrivingSchool {
  return JSON.parse(JSON.stringify(school)) as DrivingSchool;
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date).replaceAll("/", "-");
}

function splitItems(value: string) {
  return value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean);
}

function schoolPublished(school: DrivingSchool) {
  return Boolean(school.isPublished || school.publishedAt || school.publicationStatus === "published");
}

function classLabel(code: string) {
  const item = licenseClasses.find(([value]) => value === code);
  return item ? `${item[0]} · ${item[1]}` : code;
}

function levelLabel(level: DrivingSchool["regulatory"]["capabilityLevel"]) {
  const normalized = String(level || "").replace("level_", "");
  return ["1", "2", "3"].includes(normalized) ? `${normalized} 级` : "未配置";
}

function modeText(modes: DrivingSchoolApplicationMode[]) {
  return modes.map((mode) => mode === "initial" ? "初次申领" : "增驾").join(" / ");
}

function priceText(offer: DrivingSchoolOffer) {
  if (offer.priceType === "inquiry") return "价格需咨询";
  if (offer.priceType === "range") return `¥${money(offer.minPriceFen || 0)}–${money(offer.maxPriceFen || 0)}`;
  if (offer.priceType === "starting_from") return `¥${money(offer.minPriceFen || 0)} 起`;
  return `¥${money(offer.minPriceFen || 0)}`;
}

function profileFingerprint(school: DrivingSchool) {
  return JSON.stringify({
    name: school.name,
    legalName: school.legalName || "",
    description: school.description || "",
    dataKind: school.dataKind,
    location: school.location,
    publicPhone: school.publicPhone || "",
    internalContact: school.internalContact || null,
    tags: school.tags || [],
    facilities: school.facilities || [],
    openHours: school.openHours || "",
    regulatory: school.regulatory,
    isActive: Boolean(school.isActive),
    inquiryAvailable: Boolean(school.inquiryAvailable),
    sortPriority: Number(school.sortPriority || 0),
  });
}

function offerMappingFallback(offer: DrivingSchoolOffer, school: DrivingSchool): DrivingSchoolOfferMapping {
  const capability = school.trainingClasses?.find((item) => item.licenseClassCode === offer.licenseClassCode && item.status === "active");
  const modes = capability?.applicationModes?.length ? capability.applicationModes : capability?.supportedModes || [];
  const aligned = Boolean(capability && offer.applicationModes.every((mode) => modes.includes(mode)));
  const active = offer.status === "active";
  const reasons = !active ? ["报价已停用"] : !aligned ? ["与当前车型或申领方式不匹配"] : [];
  return {
    offerId: offer.id,
    listMinimumCandidate: active && aligned && offer.priceType !== "inquiry",
    detailVisible: active && aligned,
    inquirySelectable: active && aligned,
    reasons,
  };
}

function emptyOffer(licenseClassCode: string, modes: DrivingSchoolApplicationMode[]): OfferDraft {
  return {
    id: "",
    licenseClassCode,
    name: `${licenseClassCode} 基础培训服务`,
    priceType: "fixed",
    minPriceFen: 0,
    maxPriceFen: 0,
    applicationModes: modes.length ? [modes[0]] : ["initial"],
    unit: "人/期",
    includedItems: [],
    excludedItems: [],
    description: "",
    validFrom: null,
    validUntil: null,
    status: "active",
    sortOrder: 0,
  };
}

function confirmDiscard(message = "当前有未保存修改，确认放弃并离开吗？") {
  return window.confirm(message);
}

export function DrivingSchoolWorkbench({ school, section, setSection, close, reloadDirectory, onError }: Props) {
  const [savedSchool, setSavedSchool] = useState(() => cloneSchool(school));
  const [draft, setDraft] = useState(() => cloneSchool(school));
  const [preview, setPreview] = useState<DrivingSchoolPublicPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const detailRequest = useRef(0);
  const previewRequest = useRef(0);
  const dirty = useMemo(() => profileFingerprint(draft) !== profileFingerprint(savedSchool), [draft, savedSchool]);

  const loadPreview = async (signal?: AbortSignal) => {
    const requestId = ++previewRequest.current;
    setPreviewLoading(true);
    try {
      const result = await drivingSchoolAdminApi.getSchoolPreview(school.id, { signal, cache: "no-store" });
      if (requestId === previewRequest.current) setPreview(result);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError" && requestId === previewRequest.current) onError((reason as Error).message);
    } finally {
      if (requestId === previewRequest.current) setPreviewLoading(false);
    }
  };

  const loadSchool = async (signal?: AbortSignal, includePreview = true) => {
    const requestId = ++detailRequest.current;
    setLoading(true);
    try {
      const next = await drivingSchoolAdminApi.getSchool(school.id, { signal, cache: "no-store" });
      if (requestId !== detailRequest.current) return;
      setSavedSchool(cloneSchool(next));
      setDraft(cloneSchool(next));
      if (includePreview) await loadPreview(signal);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError" && requestId === detailRequest.current) onError((reason as Error).message);
    } finally {
      if (requestId === detailRequest.current) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setSavedSchool(cloneSchool(school));
    setDraft(cloneSchool(school));
    setPreview(null);
    void loadSchool(controller.signal);
    return () => {
      detailRequest.current += 1;
      previewRequest.current += 1;
      controller.abort();
    };
  }, [school.id]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const exit = () => {
    if (dirty && !confirmDiscard()) return;
    close();
  };

  const saveProfile = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.name.trim()) return onError("请填写驾校展示名称");
    const internalName = draft.internalContact?.name?.trim() || "";
    const internalPhone = draft.internalContact?.phone?.trim() || "";
    if ((internalName && !internalPhone) || (!internalName && internalPhone)) return onError("内部联系人与内部电话需同时填写；不需要时请同时留空");
    const verifiedDate = draft.regulatory.verifiedAt?.slice(0, 10) || "";
    const recipientStateChanged = Boolean(draft.inquiryAvailable) !== Boolean(savedSchool.inquiryAvailable) || draft.dataKind !== savedSchool.dataKind;
    const savedRecipient = savedSchool.inquiryRecipient;
    const inquiryRecipient = recipientStateChanged ? {
      recipientName: "驭小满驾校服务团队" as const,
      dataScope: savedRecipient?.dataScope || ["联系人姓名", "手机号", "咨询车型", "期望联系时间"],
      purpose: savedRecipient?.purpose || "仅由驭小满平台内部了解意向并跟进，不向驾校或其他第三方转交",
      retention: savedRecipient?.retention || "线索完结或关闭后 180 天内清理联系方式",
      consentText: savedRecipient?.consentText || "我同意上述信息仅由驭小满平台内部为本次驾校服务咨询处理，且不向驾校或其他第三方转交",
      contactEtaText: savedRecipient?.contactEtaText || "预计 1 个工作日内由驭小满驾校服务团队联系",
      active: Boolean(draft.inquiryAvailable),
      synthetic: draft.dataKind === "demo",
    } : undefined;
    const payload = {
      name: draft.name.trim(),
      legalName: draft.legalName?.trim() || null,
      description: draft.description?.trim() || "",
      dataKind: draft.dataKind,
      ...(draft.location.locationProof ? { location: draft.location } : {}),
      publicPhone: draft.publicPhone?.trim() || null,
      internalContact: internalName && internalPhone ? { name: internalName, phone: internalPhone } : null,
      tags: draft.tags || [],
      facilities: draft.facilities || [],
      openHours: draft.openHours.trim(),
      regulatory: {
        ...draft.regulatory,
        sourceUrl: draft.regulatory.sourceUrl?.trim() || null,
        validFrom: draft.regulatory.validFrom || null,
        validUntil: draft.regulatory.validUntil || null,
        verifiedAt: verifiedDate ? `${verifiedDate}T00:00:00.000Z` : null,
      },
      isActive: Boolean(draft.isActive),
      sortPriority: Number(draft.sortPriority || 0),
      ...(inquiryRecipient ? { inquiryRecipient } : {}),
    };
    setSaving(true);
    setSavedMessage("");
    try {
      await drivingSchoolAdminApi.updateSchool(draft.id, payload);
      await loadSchool(undefined, true);
      await reloadDirectory();
      setSavedMessage("资料已保存，预览已刷新");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const relationChanged = async () => {
    await loadSchool(undefined, true);
    await reloadDirectory();
    setSavedMessage("已保存，预览已刷新");
  };

  const changeSection = (next: DrivingSchoolWorkspaceSection) => {
    setSavedMessage("");
    setSection(next);
    if (next === "preview") void loadPreview();
  };

  return <section className="driving-school-workbench" aria-label={`驾校配置工作台 ${savedSchool.name}`}>
    <header className="driving-school-workbench-head">
      <button type="button" className="driving-school-back" onClick={exit}><ArrowLeft />返回驾校列表</button>
      <div className="driving-school-workbench-title">
        <div><span className={`status-pill ${savedSchool.dataKind === "demo" ? "driving-school-reg-demo" : "driving-school-reg-verified"}`}>{savedSchool.dataKind === "demo" ? "演示资料" : "真实资料"}</span><span className={`status-pill ${schoolPublished(savedSchool) ? "driving-school-published" : "driving-school-draft"}`}>{schoolPublished(savedSchool) ? "已发布" : "未发布"}</span></div>
        <h2>{savedSchool.name}</h2>
        <p>单校配置工作台 · 小程序内容一处维护、保存后统一预览</p>
      </div>
      <div className="driving-school-workbench-save">
        <small>服务端保存时间</small><strong>{formatDateTime(preview?.savedAt || savedSchool.updatedAt)}</strong>
        <button type="button" onClick={() => void saveProfile()} disabled={!dirty || saving}><FloppyDisk />{saving ? "保存中…" : dirty ? "保存资料" : "已保存"}</button>
      </div>
    </header>

    {dirty ? <div className="driving-school-dirty-banner"><WarningCircle weight="fill" /><span><strong>当前有未保存修改</strong><small>小程序预览仍显示上次保存版本；保存后才会刷新。</small></span></div> : savedMessage ? <div className="driving-school-saved-banner"><CheckCircle weight="fill" />{savedMessage}</div> : null}

    <div className="driving-school-workbench-map" aria-label="后台配置与小程序显示对应关系">
      {sections.map(([value, label, Icon, target]) => <button key={value} type="button" className={section === value ? "active" : ""} aria-current={section === value ? "step" : undefined} onClick={() => changeSection(value)}><Icon /><span><strong>{label}</strong><small>{target}</small></span></button>)}
    </div>

    <div className="driving-school-workbench-body" aria-busy={loading}>
      {loading ? <div className="table-loading">正在读取该校已保存资料…</div> : null}
      {!loading && section === "base" ? <BaseProfile draft={draft} setDraft={setDraft} onError={onError} /> : null}
      {!loading && section === "training" ? <TrainingProfile draft={draft} setDraft={setDraft} onChanged={relationChanged} onError={onError} /> : null}
      {!loading && section === "offers" ? <OffersManager school={savedSchool} preview={preview} onChanged={relationChanged} onError={onError} /> : null}
      {!loading && section === "media" ? <MediaProfile draft={draft} setDraft={setDraft} onChanged={relationChanged} onError={onError} /> : null}
      {!loading && section === "preview" ? <PreviewAndPublish school={savedSchool} preview={preview} loading={previewLoading} dirty={dirty} setSection={changeSection} refresh={relationChanged} onError={onError} /> : null}
    </div>
  </section>;
}

function BaseProfile({ draft, setDraft, onError }: { draft: DrivingSchool; setDraft: (school: DrivingSchool) => void; onError: (message: string) => void }) {
  const [locationQuery, setLocationQuery] = useState("");
  const [suggestions, setSuggestions] = useState<AdminLocationSuggestion[]>([]);
  const [locationState, setLocationState] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const requestRef = useRef(0);

  useEffect(() => {
    const query = locationQuery.trim();
    const requestId = ++requestRef.current;
    if (query.length < 2) { setSuggestions([]); setLocationState("idle"); return; }
    const controller = new AbortController();
    setLocationState("loading");
    const timer = window.setTimeout(() => {
      void drivingSchoolAdminApi.locationSuggestions(query, { signal: controller.signal }).then((result) => {
        if (requestId !== requestRef.current) return;
        setSuggestions(result.items);
        setLocationState(result.items.length ? "idle" : "empty");
      }).catch((reason) => {
        if ((reason as Error).name !== "AbortError" && requestId === requestRef.current) { setLocationState("error"); onError((reason as Error).message); }
      });
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [locationQuery]);

  const updateKind = (dataKind: "demo" | "real") => setDraft({
    ...draft,
    dataKind,
    isDemo: dataKind === "demo",
    regulatory: { ...draft.regulatory, status: dataKind === "demo" ? "demo" : draft.regulatory.status === "demo" ? "pending" : draft.regulatory.status },
  });

  return <div className="driving-school-workbench-editor">
    <SectionHeading eyebrow="MINI-PROGRAM: LIST + DETAIL" title="基础资料" description="下列公开字段会直接进入小程序列表卡片、详情概览、电话和导航。" />
    <div className="driving-school-form-grid driving-school-readable-form">
      <label><span>展示名称 · 列表 / 详情</span><input aria-label="驾校展示名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label><span>真实主体名称 · 详情资质</span><input aria-label="驾校主体名称" value={draft.legalName || ""} onChange={(event) => setDraft({ ...draft, legalName: event.target.value })} /></label>
      <label><span>数据类型 · 列表 / 详情标识</span><select aria-label="驾校数据类型" value={draft.dataKind} onChange={(event) => updateKind(event.target.value as "demo" | "real")}><option value="demo">演示资料</option><option value="real">真实资料</option></select></label>
      <label><span>公开联系电话 · 详情拨号</span><input aria-label="驾校公开联系电话" value={draft.publicPhone || ""} onChange={(event) => setDraft({ ...draft, publicPhone: event.target.value })} /></label>
      <label><span>内部联系人 · 仅后台</span><input aria-label="驾校内部联系人" value={draft.internalContact?.name || ""} onChange={(event) => setDraft({ ...draft, internalContact: { ...draft.internalContact, name: event.target.value } })} /></label>
      <label><span>内部电话 · 仅后台</span><input aria-label="驾校内部电话" value={draft.internalContact?.phone || ""} onChange={(event) => setDraft({ ...draft, internalContact: { ...draft.internalContact, phone: event.target.value } })} /></label>
      <label className="wide"><span>公开简介 · 详情概览</span><textarea aria-label="驾校公开简介" value={draft.description || ""} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      <label><span>后台排序 · 不直接展示</span><input aria-label="驾校后台排序" type="number" value={draft.sortPriority || 0} onChange={(event) => setDraft({ ...draft, sortPriority: Number(event.target.value) })} /></label>
      <label className="driving-school-check"><input aria-label="驾校记录启用" type="checkbox" checked={Boolean(draft.isActive)} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /><span><strong>记录启用</strong><small>停用后不进入小程序公开目录</small></span></label>
      <label className="driving-school-check"><input aria-label="驾校允许咨询" type="checkbox" checked={Boolean(draft.inquiryAvailable)} onChange={(event) => setDraft({ ...draft, inquiryAvailable: event.target.checked })} /><span><strong>允许平台咨询</strong><small>线索只由驭小满团队跟进</small></span></label>
    </div>
    <section className="driving-school-workbench-subsection">
      <h3>可信位置 <em>小程序地址与导航</em></h3>
      <div className="driving-school-location-search"><MapPin /><input aria-label="搜索驾校位置" type="search" placeholder="搜索后从服务端签名候选中选择" value={locationQuery} onChange={(event) => setLocationQuery(event.target.value)} />{locationState === "loading" ? <span>查询中…</span> : null}</div>
      {suggestions.length ? <div className="driving-school-location-options" role="listbox" aria-label="驾校位置候选">{suggestions.map((location) => <button key={location.poiId} type="button" role="option" aria-selected={draft.location.poiId === location.poiId} onClick={() => { setDraft({ ...draft, location: { ...location }, district: location.district, address: location.address }); setLocationQuery(""); setSuggestions([]); }}><MapPin /><span><strong>{location.title}</strong><small>{location.address}</small></span><em>{location.district}</em></button>)}</div> : null}
      {locationState === "empty" ? <p className="driving-school-manager-empty">没有匹配的位置候选，请更换关键词。</p> : null}
      <div className="driving-school-location-selected"><MapPin weight="fill" /><span><small>小程序当前保存位置</small><strong>{draft.location.title || draft.name}</strong><p>{draft.district} · {draft.address}</p></span></div>
    </section>
  </div>;
}

function TrainingProfile({ draft, setDraft, onChanged, onError }: { draft: DrivingSchool; setDraft: (school: DrivingSchool) => void; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  return <div className="driving-school-workbench-editor">
    <SectionHeading eyebrow="MINI-PROGRAM: FILTER + QUALIFICATION" title="备案与车型" description="机构级备案等级只表示可培训车型数量，不是教学质量评级。" />
    <div className="driving-school-level-note"><ShieldCheck /><span><strong>备案培训能力等级：{levelLabel(draft.regulatory.capabilityLevel)}（非质量评级）</strong><small>一级至少 3 类、二级 2 类、三级 1 类有效培训车型；发布时由服务端统一校验。</small></span></div>
    <div className="driving-school-form-grid driving-school-readable-form">
      <label><span>监管凭据类型 · 详情资质</span><select aria-label="驾校监管凭据类型" value={draft.regulatory.type} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, type: event.target.value as "filing" | "legacy_license" } })}><option value="filing">经营备案</option><option value="legacy_license">存量许可证</option></select></label>
      <label><span>核验状态 · 详情资质</span><select aria-label="驾校监管核验状态" value={draft.regulatory.status} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, status: event.target.value as DrivingSchoolRegulatoryStatus } })}>{Object.entries(regulatoryStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>备案 / 许可编号</span><input aria-label="驾校监管编号" value={draft.regulatory.number} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, number: event.target.value } })} /></label>
      <label><span>备案 / 许可机关</span><input aria-label="驾校监管机关" value={draft.regulatory.authority} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, authority: event.target.value } })} /></label>
      <label><span>来源名称</span><input aria-label="驾校监管来源名称" value={draft.regulatory.sourceLabel} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, sourceLabel: event.target.value } })} /></label>
      <label><span>来源链接</span><input aria-label="驾校监管来源链接" type="url" value={draft.regulatory.sourceUrl || ""} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, sourceUrl: event.target.value } })} /></label>
      <label><span>有效起始日</span><input aria-label="驾校监管有效起始日" type="date" value={draft.regulatory.validFrom || ""} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, validFrom: event.target.value } })} /></label>
      <label><span>有效截止日</span><input aria-label="驾校监管有效截止日" type="date" value={draft.regulatory.validUntil || ""} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, validUntil: event.target.value } })} /></label>
      <label><span>核验日期</span><input aria-label="驾校监管核验日期" type="date" value={(draft.regulatory.verifiedAt || "").slice(0, 10)} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, verifiedAt: event.target.value } })} /></label>
      <label><span>备案培训能力等级（非质量评级）</span><select aria-label="驾校培训能力等级" value={String(draft.regulatory.capabilityLevel || "level_1")} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, capabilityLevel: event.target.value as "level_1" | "level_2" | "level_3" } })}><option value="level_1">一级（至少 3 类车型）</option><option value="level_2">二级（2 类车型）</option><option value="level_3">三级（1 类车型）</option></select></label>
    </div>
    <TrainingClassManager schoolId={draft.id} onChanged={onChanged} onError={onError} />
  </div>;
}

function MediaProfile({ draft, setDraft, onChanged, onError }: { draft: DrivingSchool; setDraft: (school: DrivingSchool) => void; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  return <div className="driving-school-workbench-editor">
    <SectionHeading eyebrow="MINI-PROGRAM: COVER + GALLERY" title="图库与营业" description="营业时间直接展示；每张图片说明会随详情轮播同步显示。" />
    <div className="driving-school-form-grid driving-school-readable-form">
      <label className="wide"><span>营业时间（小程序直接展示）</span><input aria-label="驾校营业时间" value={draft.openHours} onChange={(event) => setDraft({ ...draft, openHours: event.target.value })} placeholder="例如：周一至周日 08:00–18:00" /></label>
      <label className="wide"><span>特色标签 · 列表 / 详情</span><input aria-label="驾校标签" value={(draft.tags || []).join("，")} onChange={(event) => setDraft({ ...draft, tags: splitItems(event.target.value) })} /></label>
      <label className="wide"><span>服务设施 · 详情</span><textarea aria-label="驾校设施" value={(draft.facilities || []).join("\n")} onChange={(event) => setDraft({ ...draft, facilities: splitItems(event.target.value) })} /></label>
    </div>
    <ImageManager schoolId={draft.id} onChanged={onChanged} onError={onError} />
  </div>;
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="driving-school-workbench-section-head"><div><small>{eyebrow}</small><h3>{title}</h3><p>{description}</p></div><span><Eye />保存后进入小程序预览</span></header>;
}

function TrainingClassManager({ schoolId, onChanged, onError }: { schoolId: string; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [items, setItems] = useState<DrivingSchoolTrainingClass[]>([]);
  const [editingCode, setEditingCode] = useState("");
  const [code, setCode] = useState("C1");
  const [modes, setModes] = useState<DrivingSchoolApplicationMode[]>(["initial"]);
  const [note, setNote] = useState("");
  const [schoolConditions, setSchoolConditions] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);

  const load = async (signal?: AbortSignal) => {
    const requestId = ++requestRef.current;
    try {
      const result = await drivingSchoolAdminApi.listTrainingClasses(schoolId, { signal });
      if (requestId === requestRef.current) { setItems(result.items); return result.items; }
    } catch (reason) {
      if ((reason as Error).name !== "AbortError" && requestId === requestRef.current) onError((reason as Error).message);
    }
  };
  useEffect(() => { const controller = new AbortController(); setItems([]); void load(controller.signal); return () => { requestRef.current += 1; controller.abort(); }; }, [schoolId]);
  const catalog = licenseClasses.find(([value]) => value === code);
  const reset = () => { setEditingCode(""); setCode("C1"); setModes(["initial"]); setNote(""); setSchoolConditions(""); setStatus("active"); };
  const edit = (item: DrivingSchoolTrainingClass) => {
    setEditingCode(item.licenseClassCode);
    setCode(item.licenseClassCode);
    setModes(item.applicationModes?.length ? item.applicationModes : item.supportedModes);
    setNote(item.trainingCapabilityNote || (item.trainingCapabilityLevel && !/^level_[123]$/.test(item.trainingCapabilityLevel) ? item.trainingCapabilityLevel : ""));
    setSchoolConditions((item.schoolConditions || item.conditions || []).join("\n"));
    setStatus(item.status);
  };
  const toggleMode = (mode: DrivingSchoolApplicationMode, allowed: boolean) => {
    if (!allowed) return;
    setModes((current) => current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode]);
  };
  const save = async () => {
    if (!modes.length) return onError("请至少选择一种申领方式");
    setSaving(true);
    const input = { applicationModes: modes, trainingCapabilityNote: note.trim() || null, schoolConditions: splitItems(schoolConditions), conditions: splitItems(schoolConditions), status };
    try {
      if (editingCode) await drivingSchoolAdminApi.updateTrainingClass(schoolId, editingCode, input);
      else await drivingSchoolAdminApi.createTrainingClass(schoolId, { licenseClassCode: code, ...input });
      reset();
      await load();
      await onChanged();
    } catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };
  const remove = async (item: DrivingSchoolTrainingClass) => {
    if (!window.confirm(`确认删除 ${item.licenseClassCode} 培训能力？相关启用报价可能同时阻塞发布。`)) return;
    try { await drivingSchoolAdminApi.deleteTrainingClass(schoolId, item.licenseClassCode); await load(); await onChanged(); }
    catch (reason) { onError((reason as Error).message); }
  };

  return <section className="driving-school-workbench-subsection driving-school-manager">
    <h3>可培训准驾车型 <em>决定筛选项和报价可选范围</em></h3>
    <div className="driving-school-training-form">
      <label><span>准驾车型</span><select aria-label="培训准驾车型" value={code} disabled={Boolean(editingCode)} onChange={(event) => { const next = event.target.value; const nextCatalog = licenseClasses.find(([value]) => value === next); setCode(next); setModes(nextCatalog?.[2] ? ["initial"] : ["upgrade"]); }}>{licenseClasses.map(([value, name]) => <option key={value} value={value} disabled={!editingCode && items.some((item) => item.licenseClassCode === value)}>{value} · {name}</option>)}</select></label>
      <fieldset><legend>申领方式</legend><label><input type="checkbox" checked={modes.includes("initial")} disabled={!catalog?.[2]} onChange={() => toggleMode("initial", Boolean(catalog?.[2]))} />初次申领</label><label><input type="checkbox" checked={modes.includes("upgrade")} disabled={!catalog?.[3]} onChange={() => toggleMode("upgrade", Boolean(catalog?.[3]))} />增驾</label></fieldset>
      <label><span>车型培训备注 · 详情</span><input aria-label="车型培训备注" value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：提供独立训练场" /></label>
      <label><span>学校补充条件 · 详情</span><input aria-label="学校补充培训条件" value={schoolConditions} onChange={(event) => setSchoolConditions(event.target.value)} placeholder="官方条件只读，补充条件以逗号分隔" /></label>
      <label><span>状态</span><select aria-label="培训能力状态" value={status} onChange={(event) => setStatus(event.target.value as "active" | "inactive")}><option value="active">启用</option><option value="inactive">停用</option></select></label>
      <span className="driving-school-inline-actions">{editingCode ? <button type="button" className="secondary" onClick={reset}>取消</button> : null}<button type="button" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : editingCode ? "更新车型" : "添加车型"}</button></span>
    </div>
    <div className="driving-school-training-list">{items.map((item) => {
      const itemModes = item.applicationModes?.length ? item.applicationModes : item.supportedModes;
      const catalogConditions = item.catalogConditions || [];
      const customConditions = item.schoolConditions || item.conditions || [];
      return <article key={item.licenseClassCode}>
        <span className="driving-school-code">{item.licenseClassCode}</span>
        <div><strong>{item.name || classLabel(item.licenseClassCode)}</strong><small>{modeText(itemModes)} · {item.status === "active" ? "启用" : "停用"}</small>{item.trainingCapabilityNote ? <p>车型培训备注：{item.trainingCapabilityNote}</p> : null}<p>官方条件：{catalogConditions.length ? catalogConditions.join("；") : "以准驾车型目录为准"}</p><p>学校补充：{customConditions.length ? customConditions.join("；") : "无"}</p></div>
        <button type="button" aria-label={`编辑车型 ${item.licenseClassCode}`} onClick={() => edit(item)}>编辑车型</button><button type="button" className="danger" aria-label={`删除车型 ${item.licenseClassCode}`} onClick={() => void remove(item)}><Trash />删除</button>
      </article>;
    })}{!items.length ? <p className="driving-school-manager-empty">尚未配置培训车型，小程序无法按车型筛选。</p> : null}</div>
  </section>;
}

function ImageManager({ schoolId, onChanged, onError }: { schoolId: string; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [items, setItems] = useState<DrivingSchoolImage[]>([]);
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [isCover, setIsCover] = useState(false);
  const requestRef = useRef(0);
  const load = async (signal?: AbortSignal) => {
    const requestId = ++requestRef.current;
    try { const result = await drivingSchoolAdminApi.listImages(schoolId, { signal }); if (requestId === requestRef.current) { setItems(result.items); return result.items; } }
    catch (reason) { if ((reason as Error).name !== "AbortError" && requestId === requestRef.current) onError((reason as Error).message); }
  };
  useEffect(() => { const controller = new AbortController(); setItems([]); void load(controller.signal); return () => { requestRef.current += 1; controller.abort(); }; }, [schoolId]);
  const add = async () => {
    if (!url.trim()) return onError("请填写图片地址");
    if (!caption.trim()) return onError("请填写图片说明，说明会在小程序轮播中展示");
    try { await drivingSchoolAdminApi.createImage(schoolId, { url: url.trim(), caption: caption.trim(), isCover, sortOrder: items.length }); setUrl(""); setCaption(""); setIsCover(false); await load(); await onChanged(); }
    catch (reason) { onError((reason as Error).message); }
  };
  const makeCover = async (item: DrivingSchoolImage) => {
    try { await drivingSchoolAdminApi.updateImage(schoolId, item.id, { isCover: true }); await load(); await onChanged(); }
    catch (reason) { onError((reason as Error).message); }
  };
  const remove = async (item: DrivingSchoolImage) => {
    if (!window.confirm("确认删除这张图片？")) return;
    try { await drivingSchoolAdminApi.deleteImage(schoolId, item.id); await load(); await onChanged(); }
    catch (reason) { onError((reason as Error).message); }
  };
  return <section className="driving-school-workbench-subsection driving-school-manager">
    <h3>学校图库 <em>封面进入列表，其余图片与说明进入详情轮播</em></h3>
    <div className="driving-school-image-form"><label><span>图片 URL</span><input aria-label="驾校图片地址" type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></label><label><span>图片说明（小程序轮播展示）</span><input aria-label="驾校图片说明" value={caption} onChange={(event) => setCaption(event.target.value)} /></label><label className="driving-school-mini-check"><input aria-label="设为驾校封面" type="checkbox" checked={isCover} onChange={(event) => setIsCover(event.target.checked)} />设为列表封面</label><button type="button" onClick={() => void add()}><Image />添加图片</button></div>
    <div className="driving-school-image-grid">{items.map((item) => <article key={item.id}><img src={item.url} alt={item.altText || item.caption || "驾校图片"} /><div><strong>{item.caption || "未填写说明"}</strong><small>{item.isCover ? "当前列表封面" : `详情轮播 · 排序 ${item.sortOrder}`}</small></div><span>{!item.isCover ? <button type="button" onClick={() => void makeCover(item)}>设为封面</button> : null}<button type="button" className="danger" aria-label={`删除图片 ${item.caption || item.id}`} onClick={() => void remove(item)}><Trash />删除</button></span></article>)}{!items.length ? <p className="driving-school-manager-empty">尚未上传图片，发布检查会提示缺少列表封面。</p> : null}</div>
  </section>;
}

function OffersManager({ school, preview, onChanged, onError }: { school: DrivingSchool; preview: DrivingSchoolPublicPreview | null; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [offers, setOffers] = useState<DrivingSchoolOffer[]>([]);
  const [draft, setDraft] = useState<OfferDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const load = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestRef.current;
    setLoading(true);
    try { const result = await drivingSchoolAdminApi.listOffers(school.id, { signal: controller.signal }); if (requestId === requestRef.current) setOffers(result.items); }
    catch (reason) { if ((reason as Error).name !== "AbortError" && requestId === requestRef.current) onError((reason as Error).message); }
    finally { if (requestId === requestRef.current) setLoading(false); }
  };
  useEffect(() => { setOffers([]); void load(); return () => { requestRef.current += 1; controllerRef.current?.abort(); }; }, [school.id]);
  const classes = useMemo(() => {
    const byCode = new Map<string, DrivingSchoolTrainingClass>();
    (school.trainingClasses || []).forEach((item) => byCode.set(item.licenseClassCode, item));
    offers.forEach((offer) => { if (!byCode.has(offer.licenseClassCode)) byCode.set(offer.licenseClassCode, { licenseClassCode: offer.licenseClassCode, supportedModes: [], applicationModes: [], conditions: [], status: "inactive" }); });
    return [...byCode.values()];
  }, [school.trainingClasses, offers]);
  const mapping = (offer: DrivingSchoolOffer) => preview?.offerMappings?.find((item) => item.offerId === offer.id) || offerMappingFallback(offer, school);
  const remove = async (offer: DrivingSchoolOffer) => {
    if (!window.confirm(`确认删除报价“${offer.name}”？`)) return;
    try { await drivingSchoolAdminApi.deleteOffer(school.id, offer.id); await load(); await onChanged(); }
    catch (reason) { onError((reason as Error).message); }
  };

  return <div className="driving-school-workbench-editor">
    <SectionHeading eyebrow="MINI-PROGRAM: PRICE + INQUIRY" title="服务报价" description="报价按该校车型维护，不需要重新选择驾校；启用状态决定是否公开。" />
    <div className="driving-school-offer-guide"><span><strong>列表</strong>匹配车型的数值报价参与最低价</span><Caret /><span><strong>详情</strong>展示启用且匹配的全部报价</span><Caret /><span><strong>咨询</strong>同一批报价可作为意向项目</span></div>
    {loading ? <div className="table-loading">正在读取该校报价…</div> : null}
    <div className="driving-school-offer-groups">{classes.map((trainingClass) => {
      const modes = trainingClass.applicationModes?.length ? trainingClass.applicationModes : trainingClass.supportedModes || [];
      const classOffers = offers.filter((offer) => offer.licenseClassCode === trainingClass.licenseClassCode);
      return <section key={trainingClass.licenseClassCode} className="driving-school-offer-group">
        <header><span className="driving-school-code">{trainingClass.licenseClassCode}</span><div><h3>{classLabel(trainingClass.licenseClassCode)}</h3><p>{trainingClass.status === "active" ? modeText(modes) || "未配置申领方式" : "车型已停用，报价不会公开"}</p></div><button type="button" disabled={trainingClass.status !== "active" || !modes.length} onClick={() => setDraft(emptyOffer(trainingClass.licenseClassCode, modes))}><Plus />新增 {trainingClass.licenseClassCode} 报价</button></header>
        <div className="driving-school-offer-list">{classOffers.map((offer) => {
          const destinations = mapping(offer);
          return <article key={offer.id}>
            <div className="driving-school-offer-main"><strong>{offer.name}</strong><small>{priceTypeLabels[offer.priceType]} · {modeText(offer.applicationModes)} · {offer.status === "active" ? "启用" : "停用"}</small></div>
            <div className="driving-school-offer-price"><strong>{priceText(offer)}</strong><small>{offer.unit}</small></div>
            <div className="driving-school-offer-destinations">
              {destinations.listMinimumCandidate ? <span className="yes">列表最低价候选</span> : null}
              {destinations.detailVisible ? <span className="yes">详情展示</span> : null}
              {destinations.inquirySelectable ? <span className="yes">咨询可选</span> : null}
              {destinations.reasons?.map((reason) => <span className="no" key={reason}>{reason}</span>)}
            </div>
            <div className="driving-school-offer-actions"><button type="button" aria-label={`编辑报价 ${offer.name}`} onClick={() => setDraft({ ...offer })}>编辑报价</button><button type="button" className="danger" aria-label={`删除报价 ${offer.name}`} onClick={() => void remove(offer)}><Trash />删除</button></div>
          </article>;
        })}{!classOffers.length ? <p className="driving-school-manager-empty">此车型还没有报价，小程序详情将只显示培训能力。</p> : null}</div>
      </section>;
    })}{!classes.length && !loading ? <div className="driving-school-save-first"><Student /><span><strong>先配置培训车型</strong><small>报价必须放在该校有效车型下，避免运营选错学校或车型。</small></span></div> : null}</div>
    {draft ? <OfferEditor school={school} draft={draft} close={() => setDraft(null)} saved={async () => { setDraft(null); await load(); await onChanged(); }} onError={onError} /> : null}
  </div>;
}

function Caret() {
  return <span className="driving-school-flow-arrow">→</span>;
}

function OfferEditor({ school, draft, close, saved, onError }: { school: DrivingSchool; draft: OfferDraft; close: () => void; saved: () => Promise<void>; onError: (message: string) => void }) {
  const [form, setForm] = useState(draft);
  const [minYuan, setMinYuan] = useState(draft.minPriceFen == null ? "" : (draft.minPriceFen / 100).toFixed(2));
  const [maxYuan, setMaxYuan] = useState(draft.maxPriceFen == null ? "" : (draft.maxPriceFen / 100).toFixed(2));
  const [saving, setSaving] = useState(false);
  const initial = useRef(JSON.stringify({ draft, minYuan: draft.minPriceFen == null ? "" : (draft.minPriceFen / 100).toFixed(2), maxYuan: draft.maxPriceFen == null ? "" : (draft.maxPriceFen / 100).toFixed(2) }));
  const dirty = initial.current !== JSON.stringify({ draft: form, minYuan, maxYuan });
  const trainingClass = school.trainingClasses?.find((item) => item.licenseClassCode === form.licenseClassCode);
  const supportedModes = trainingClass?.applicationModes?.length ? trainingClass.applicationModes : trainingClass?.supportedModes || [];
  const closeSafely = () => { if (!dirty || confirmDiscard("报价有未保存修改，确认关闭吗？")) close(); };
  const toggleMode = (mode: DrivingSchoolApplicationMode) => {
    if (!supportedModes.includes(mode)) return;
    setForm((current) => ({ ...current, applicationModes: current.applicationModes.includes(mode) ? current.applicationModes.filter((item) => item !== mode) : [...current.applicationModes, mode] }));
  };
  const toFen = (value: string) => value.trim() === "" ? null : Math.round(Number(value) * 100);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return onError("请填写服务项目名称");
    if (!form.applicationModes.length) return onError("请至少选择一种申领方式");
    if (!form.applicationModes.every((mode) => supportedModes.includes(mode))) return onError("启用报价必须与该校当前车型申领方式一致");
    const min = toFen(minYuan);
    const max = toFen(maxYuan);
    if ((min != null && (!Number.isFinite(min) || min < 0)) || (max != null && (!Number.isFinite(max) || max < 0))) return onError("请填写有效的非负金额");
    let minPriceFen = min;
    let maxPriceFen = max;
    if (form.priceType === "fixed") { if (min == null) return onError("固定价必须填写金额"); maxPriceFen = min; }
    if (form.priceType === "starting_from") { if (min == null) return onError("起价必须填写金额"); maxPriceFen = null; }
    if (form.priceType === "range" && (min == null || max == null || max < min)) return onError("区间价需填写有效的最低价和最高价");
    if (form.priceType === "inquiry") { minPriceFen = null; maxPriceFen = null; }
    const { id: _id, schoolId: _schoolId, schoolName: _schoolName, updatedAt: _updatedAt, isExpired: _isExpired, ...editable } = form;
    const input = { ...editable, name: form.name.trim(), minPriceFen, maxPriceFen, unit: form.unit.trim(), description: form.description?.trim() || "", validFrom: form.validFrom || null, validUntil: form.validUntil || null };
    setSaving(true);
    try { if (form.id) await drivingSchoolAdminApi.updateOffer(school.id, form.id, input); else await drivingSchoolAdminApi.createOffer(school.id, input); await saved(); }
    catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };

  return <div className="drawer-layer driving-school-drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && closeSafely()}>
    <aside className="detail-drawer driving-school-drawer driving-school-offer-drawer" aria-label={form.id ? "编辑服务报价" : "新增服务报价"}>
      <header><div><small>该校服务报价</small><h2>{form.name || "新增服务报价"}</h2><p>所属驾校：{school.name} · 车型：{classLabel(form.licenseClassCode)}</p></div><button type="button" aria-label="关闭服务报价" onClick={closeSafely}><X /></button></header>
      <div className="drawer-scroll"><form className="driving-school-editor" onSubmit={submit}>
        <section className="detail-section"><h3>报价定义 <em>后台按元输入</em></h3><div className="driving-school-field-destination"><span>列表最低价</span><span>详情报价</span><span>咨询意向</span><small>保存后由服务端判断每个展示位置是否可用</small></div><div className="driving-school-form-grid driving-school-readable-form">
          <label className="wide"><span>服务项目名称 · 详情 / 咨询</span><input aria-label="报价项目名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>准驾车型 · 已由当前分组确定</span><input aria-label="报价准驾车型" value={classLabel(form.licenseClassCode)} readOnly /></label>
          <label><span>价格类型 · 列表 / 详情</span><select aria-label="报价价格类型" value={form.priceType} onChange={(event) => setForm({ ...form, priceType: event.target.value as DrivingSchoolPriceType })}>{Object.entries(priceTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <fieldset className="wide"><legend>申领方式 · 详情 / 咨询</legend><label><input type="checkbox" checked={form.applicationModes.includes("initial")} disabled={!supportedModes.includes("initial")} onChange={() => toggleMode("initial")} />初次申领</label><label><input type="checkbox" checked={form.applicationModes.includes("upgrade")} disabled={!supportedModes.includes("upgrade")} onChange={() => toggleMode("upgrade")} />增驾</label></fieldset>
          {form.priceType !== "inquiry" ? <label><span>{form.priceType === "range" ? "最低价（元）· 列表 / 详情" : "报价（元）· 列表 / 详情"}</span><input aria-label="报价最低金额元" inputMode="decimal" value={minYuan} onChange={(event) => setMinYuan(event.target.value)} /></label> : null}
          {form.priceType === "range" ? <label><span>最高价（元）· 详情</span><input aria-label="报价最高金额元" inputMode="decimal" value={maxYuan} onChange={(event) => setMaxYuan(event.target.value)} /></label> : null}
          <label><span>计价单位 · 详情</span><input aria-label="报价单位" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} /></label>
          <label><span>公开状态</span><select aria-label="报价状态" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as "active" | "inactive" })}><option value="active">启用 · 允许公开</option><option value="inactive">停用 · 不公开</option></select></label>
          <label className="wide"><span>包含项目 · 详情</span><textarea aria-label="报价包含项目" value={form.includedItems.join("\n")} onChange={(event) => setForm({ ...form, includedItems: splitItems(event.target.value) })} /></label>
          <label className="wide"><span>不包含项目 · 详情</span><textarea aria-label="报价排除项目" value={form.excludedItems.join("\n")} onChange={(event) => setForm({ ...form, excludedItems: splitItems(event.target.value) })} /></label>
          <label className="wide"><span>服务说明 · 详情</span><textarea aria-label="报价服务说明" value={form.description || ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        </div></section>
        <footer className="driving-school-editor-footer"><span>{dirty ? "有未保存修改" : "报价只通过启用 / 停用控制公开，不设置有效期"}</span><button type="submit" disabled={saving}>{saving ? "保存中…" : "保存报价"}</button></footer>
      </form></div>
    </aside>
  </div>;
}

function PreviewAndPublish({ school, preview, loading, dirty, setSection, refresh, onError }: { school: DrivingSchool; preview: DrivingSchoolPublicPreview | null; loading: boolean; dirty: boolean; setSection: (section: DrivingSchoolWorkspaceSection) => void; refresh: () => Promise<void>; onError: (message: string) => void }) {
  const [publishing, setPublishing] = useState(false);
  const hasBlocker = !preview || preview.checklist?.some((item) => item.status === "fail");
  const publish = async () => {
    if (dirty || hasBlocker) return;
    setPublishing(true);
    try { if (schoolPublished(school)) await drivingSchoolAdminApi.unpublishSchool(school.id); else await drivingSchoolAdminApi.publishSchool(school.id); await refresh(); }
    catch (reason) { onError((reason as Error).message); }
    finally { setPublishing(false); }
  };
  const copyPath = async (value: string) => {
    try { await navigator.clipboard.writeText(value); }
    catch { onError(`测试路径：${value}`); }
  };
  if (loading && !preview) return <div className="table-loading">正在生成已保存版本预览…</div>;
  if (!preview) return <div className="driving-school-preview-empty"><WarningCircle /><strong>暂时无法读取预览</strong><button type="button" onClick={() => void refresh()}>重新读取</button></div>;
  const summary = preview.summary;
  const detail = preview.detail;
  const detailOffers = detail.offers || [];
  const cover = summary.coverImage?.url || summary.images?.find((item) => item.isCover)?.url || "";
  return <div className="driving-school-preview-page">
    <header className="driving-school-preview-head"><div><span><Eye />已保存版本预览</span><h3>版本 {preview.revision}</h3><p>保存时间 {formatDateTime(preview.savedAt)}。{dirty ? "当前修改尚未进入预览。" : "后台预览与公共接口使用同一份 DTO。"}</p></div><button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "刷新中…" : "刷新已保存预览"}</button></header>
    {dirty ? <div className="driving-school-dirty-banner"><WarningCircle weight="fill" /><span><strong>当前有未保存修改，预览仍显示上次保存版本</strong><small>请先保存资料，再执行发布检查。</small></span></div> : null}
    <div className="driving-school-preview-grid">
      <article className="driving-school-phone-preview" aria-label="小程序列表卡片预览"><header><DeviceMobile /><span><strong>小程序列表卡片</strong><small>公开列表 DTO</small></span></header>{cover ? <img src={cover} alt={summary.coverImage?.caption || summary.name} /> : <div className="driving-school-phone-placeholder"><Image />暂无封面</div>}<div className="driving-school-phone-content"><span className="driving-school-demo-badge">{summary.dataKind === "demo" ? "演示数据" : "资料已核验"}</span><h4>{summary.name}</h4><p><MapPin />{summary.district} · {summary.address}</p><div className="driving-school-phone-classes">{summary.trainingClasses?.filter((item) => item.status === "active").map((item) => <span key={item.licenseClassCode}>{item.licenseClassCode}</span>)}</div><div className="driving-school-phone-price"><strong>{summary.startingPriceFen != null ? `¥${money(summary.startingPriceFen)} 起` : "价格需咨询"}</strong><small>{summary.offerUpdatedAt ? `更新 ${formatDateTime(summary.offerUpdatedAt)}` : "暂无报价更新时间"}</small></div></div></article>
      <article className="driving-school-phone-preview detail" aria-label="小程序详情报价预览"><header><DeviceMobile /><span><strong>小程序详情与报价</strong><small>公开详情 DTO</small></span></header><div className="driving-school-phone-content"><span className="driving-school-demo-badge">{detail.dataKind === "demo" ? "演示数据" : regulatoryStatusLabels[detail.regulatory.status]}</span><h4>{detail.name}</h4><p>{detail.description || "暂无公开简介"}</p><dl><div><dt>备案信息</dt><dd>{detail.regulatory.number || "待补充"} · {levelLabel(detail.regulatory.capabilityLevel)}（非质量评级）</dd></div><div><dt>营业时间</dt><dd>{detail.openHours || "待补充"}</dd></div><div><dt>公开电话</dt><dd>{detail.publicPhone || "待补充"}</dd></div></dl><h5>服务报价</h5><div className="driving-school-phone-offers">{detailOffers.map((offer) => <div key={offer.id}><span><strong>{offer.name}</strong><small>{offer.licenseClassCode} · {modeText(offer.applicationModes)}</small></span><b>{priceText(offer)}</b></div>)}{!detailOffers.length ? <p>暂无公开报价</p> : null}</div>{detail.images?.length ? <div className="driving-school-phone-caption">图库说明：{detail.images[0].caption || "暂无说明"}</div> : null}</div></article>
      <article className="driving-school-publish-checklist" aria-label="发布检查表"><header><ShieldCheck /><span><strong>发布检查表</strong><small>与服务端发布校验同源</small></span></header><div className="driving-school-visibility"><span className={preview.visibility.listVisible ? "yes" : "no"}>{preview.visibility.listVisible ? <CheckCircle /> : <XCircle />}列表可见</span><span className={preview.visibility.detailVisible ? "yes" : "no"}>{preview.visibility.detailVisible ? <CheckCircle /> : <XCircle />}详情可访问</span><span className={preview.visibility.inquiryAvailable ? "yes" : "no"}>{preview.visibility.inquiryAvailable ? <CheckCircle /> : <XCircle />}咨询可提交</span></div><div className="driving-school-checklist-items">{preview.checklist.map((item) => <div key={item.key} className={item.status}><span>{item.status === "pass" ? <CheckCircle weight="fill" /> : item.status === "warning" ? <WarningCircle weight="fill" /> : <XCircle weight="fill" />}</span><div><strong>{item.label}</strong><small>{item.message}</small></div>{item.status !== "pass" && item.section !== "preview" ? <button type="button" onClick={() => setSection(item.section as DrivingSchoolWorkspaceSection)}>去完善</button> : null}</div>)}</div>{preview.visibility.reasons?.length ? <div className="driving-school-visibility-reasons">{preview.visibility.reasons.map((reason) => <p key={reason}>{reason}</p>)}</div> : null}<button type="button" className="driving-school-publish-button" disabled={dirty || hasBlocker || publishing} onClick={() => void publish()}>{publishing ? "处理中…" : schoolPublished(school) ? "下线已保存版本" : "发布已保存版本"}</button>{dirty ? <small className="driving-school-publish-hint">请先保存当前修改</small> : hasBlocker ? <small className="driving-school-publish-hint">完成全部阻塞项后可发布</small> : null}</article>
    </div>
    <section className="driving-school-test-paths"><header><h3>小程序测试路径</h3><p>复制路径即可让测试人员直达相同学校和页面。</p></header>{Object.entries(preview.testPaths).map(([key, value]) => <button type="button" key={key} onClick={() => void copyPath(value)}><span><strong>{key === "list" ? "列表" : key === "detail" ? "详情" : "咨询"}</strong><small>{value}</small></span><Copy />复制</button>)}</section>
  </div>;
}
