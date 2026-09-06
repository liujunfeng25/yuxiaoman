import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import {
  Buildings,
  CaretRight,
  CheckCircle,
  Eye,
  Image,
  MagnifyingGlass,
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
  type DrivingSchoolInquiry,
  type DrivingSchoolInquiryDetail,
  type DrivingSchoolInquiryStatus,
  type DrivingSchoolRegulatoryStatus,
  type DrivingSchoolTrainingClass,
} from "./adminApi";
import { DrivingSchoolWorkbench, type DrivingSchoolWorkspaceSection } from "./DrivingSchoolWorkbench";
import { operatorErrorMessage } from "./operatorError";

type DrivingSchoolTab = "schools" | "inquiries";
type SchoolDraft = DrivingSchool;

const tabs: Array<[DrivingSchoolTab, string, typeof Buildings]> = [
  ["schools", "驾校列表", Buildings],
  ["inquiries", "咨询线索", ShieldCheck],
];

const workspaceSections: DrivingSchoolWorkspaceSection[] = ["base", "training", "offers", "media", "preview"];

function readWorkspaceLocation() {
  const query = new URLSearchParams(window.location.search);
  const rawSection = query.get("section") || "base";
  return {
    schoolId: query.get("schoolId") || "",
    section: (workspaceSections.includes(rawSection as DrivingSchoolWorkspaceSection) ? rawSection : "base") as DrivingSchoolWorkspaceSection,
  };
}

function writeWorkspaceLocation(schoolId: string, section: DrivingSchoolWorkspaceSection, replace = false) {
  const url = new URL(window.location.href);
  if (schoolId) {
    url.searchParams.set("schoolId", schoolId);
    url.searchParams.set("section", section);
  } else {
    url.searchParams.delete("schoolId");
    url.searchParams.delete("section");
  }
  window.history[replace ? "replaceState" : "pushState"]({}, "", `${url.pathname}${url.search}${url.hash}`);
}

const licenseClasses = [
  ["A1", "大型客车", false, true], ["A2", "重型牵引挂车", false, true], ["A3", "城市公交车", true, true],
  ["B1", "中型客车", false, true], ["B2", "大型货车", true, true], ["C1", "小型汽车", true, true],
  ["C2", "小型自动挡汽车", true, true], ["C3", "低速载货汽车", true, true], ["C4", "三轮汽车", true, true],
  ["C5", "残疾人专用小型自动挡载客汽车", true, true], ["C6", "轻型牵引挂车", false, true],
  ["D", "普通三轮摩托车", true, true], ["E", "普通二轮摩托车", true, true], ["F", "轻便摩托车", true, true],
  ["M", "轮式专用机械车", true, true], ["N", "无轨电车", true, true], ["P", "有轨电车", true, true],
] as const;

const inquiryStatusLabels: Record<DrivingSchoolInquiryStatus, string> = {
  new: "新线索",
  contacting: "联系中",
  resolved: "已解决",
  closed: "已关闭",
  withdrawn: "已撤回",
};

const inquiryContactWindowLabels: Record<string, string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
  anytime: "任意时间",
};

function inquiryContactWindowLabel(value?: string | null) {
  if (!value) return "未指定";
  if (/[\u3400-\u9fff]/u.test(value)) return value;
  return inquiryContactWindowLabels[value] || "联系时段待核对";
}

const regulatoryStatusLabels: Record<DrivingSchoolRegulatoryStatus, string> = {
  pending: "待核验",
  verified: "已核验",
  rejected: "核验未通过",
  expired: "已过期",
  demo: "演示资料",
};

const blankLocation: AdminLocationSuggestion = {
  poiId: "",
  title: "",
  address: "",
  district: "",
  latitude: 0,
  longitude: 0,
  source: "demo",
};

function emptySchool(): SchoolDraft {
  return {
    id: "",
    name: "",
    legalName: "",
    description: "",
    dataKind: "demo",
    isDemo: true,
    district: "",
    address: "",
    location: { ...blankLocation },
    publicPhone: "",
    internalContact: { name: "", phone: "" },
    trainingClasses: [],
    tags: ["演示数据"],
    facilities: [],
    openHours: "08:00-18:00",
    regulatory: {
      type: "filing",
      number: "演示备案-001",
      authority: "演示主管机关",
      sourceUrl: "",
      sourceLabel: "演示备案资料（非真实核验）",
      validFrom: "",
      validUntil: "",
      verifiedAt: "",
      status: "demo",
      capabilityLevel: "level_1",
    },
    isActive: true,
    isPublished: false,
    inquiryAvailable: true,
    sortPriority: 0,
  };
}

function cloneSchool(school: DrivingSchool): SchoolDraft {
  return JSON.parse(JSON.stringify({
    ...emptySchool(),
    ...school,
    location: { ...blankLocation, ...school.location },
    internalContact: school.internalContact || { name: "", phone: "" },
    regulatory: { ...emptySchool().regulatory, ...school.regulatory },
    trainingClasses: school.trainingClasses || [],
    tags: school.tags || [],
    facilities: school.facilities || [],
  })) as SchoolDraft;
}

function schoolPublished(school: DrivingSchool) {
  return Boolean(school.isPublished || school.publishedAt || school.publicationStatus === "published");
}

function classLabel(code: string) {
  const found = licenseClasses.find(([item]) => item === code);
  return found ? `${found[0]} · ${found[1]}` : code;
}

function splitItems(value: string) {
  return value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean);
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待核对";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date).replaceAll("/", "-");
}

function levelLabel(level: DrivingSchool["regulatory"]["capabilityLevel"]) {
  const normalized = String(level || "").replace("level_", "");
  return normalized && ["1", "2", "3"].includes(normalized) ? `${normalized} 级` : "未配置";
}

function realPublishErrors(school: DrivingSchool) {
  if (school.dataKind !== "real") return [];
  const errors: string[] = [];
  const todayParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const todayPart = (type: Intl.DateTimeFormatPartTypes) => todayParts.find((item) => item.type === type)?.value || "";
  const today = `${todayPart("year")}-${todayPart("month")}-${todayPart("day")}`;
  if (!school.legalName?.trim()) errors.push("真实主体名称");
  if (!school.publicPhone?.trim()) errors.push("公开联系电话");
  if (!school.location?.poiId || !school.address || !school.district || school.location.source === "demo") errors.push("已签名的真实位置候选");
  if (school.regulatory.status !== "verified") errors.push("已核验的监管状态");
  if (!school.regulatory.number || !school.regulatory.authority) errors.push("备案/存量许可编号与机关");
  if (!school.regulatory.sourceLabel || !school.regulatory.sourceUrl) errors.push("备案来源名称与链接");
  if (!school.regulatory.verifiedAt || new Date(school.regulatory.verifiedAt).getTime() > Date.now()) errors.push("不晚于当前时间的核验日期");
  if (school.regulatory.validFrom && school.regulatory.validFrom > today) errors.push("已生效的资质起始日");
  if (!school.regulatory.validUntil || school.regulatory.validUntil < today) errors.push("当前有效的资质期限");
  if (!school.trainingClasses?.some((item) => item.status === "active")) errors.push("至少一个有效培训车型");
  if (!school.coverImage?.url && !school.images?.some((item) => item.isCover)) errors.push("公开封面图");
  const activeClasses = new Map((school.trainingClasses || []).filter((item) => item.status === "active").map((item) => [item.licenseClassCode, item.applicationModes || item.supportedModes]));
  if (!school.offers?.some((item) => item.status === "active" && item.applicationModes.every((mode) => activeClasses.get(item.licenseClassCode)?.includes(mode)))) errors.push("与培训能力一致的启用报价");
  if (!school.inquiryAvailable) errors.push("启用的咨询接收配置");
  return errors;
}

function Drawer({ label, title, description, close, children, wide = false }: { label: string; title: string; description: string; close: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="drawer-layer driving-school-drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <aside className={`detail-drawer driving-school-drawer${wide ? " wide" : ""}`} aria-label={label}>
      <header><div><small>驾校运营</small><h2>{title}</h2><p>{description}</p></div><button type="button" aria-label={`关闭${label}`} onClick={close}><X /></button></header>
      <div className="drawer-scroll">{children}</div>
    </aside>
  </div>;
}

export function DrivingSchoolAdminPage({ onError: reportError }: { onError: (message: string) => void }) {
  const onError = useMemo(() => (reason: unknown) => reportError(operatorErrorMessage(reason, "驾校业务操作失败，请稍后重试")), [reportError]);
  const initialInquiryId = new URLSearchParams(window.location.search).get("inquiry") || "";
  const [tab, setTab] = useState<DrivingSchoolTab>(() => initialInquiryId ? "inquiries" : "schools");
  const [schools, setSchools] = useState<DrivingSchool[]>([]);
  const [schoolLoading, setSchoolLoading] = useState(false);
  const [schoolDraft, setSchoolDraft] = useState<SchoolDraft | null>(null);
  const initialWorkspace = useRef(readWorkspaceLocation());
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace.current.schoolId);
  const [workspaceSection, setWorkspaceSectionState] = useState<DrivingSchoolWorkspaceSection>(initialWorkspace.current.section);
  const [workspaceSchool, setWorkspaceSchool] = useState<DrivingSchool | null>(null);
  const schoolListRequest = useRef(0);
  const schoolDetailRequest = useRef(0);

  const loadSchools = async (filters: { keyword?: string; dataKind?: string; status?: string } = {}) => {
    const requestId = ++schoolListRequest.current;
    setSchoolLoading(true);
    try {
      const pageSize = 100;
      const result = await drivingSchoolAdminApi.listSchools({ q: filters.keyword, dataKind: filters.dataKind, status: filters.status, page: 1, pageSize });
      const items = [...result.items];
      const pageCount = Math.ceil(result.total / pageSize);
      for (let page = 2; page <= pageCount; page += 1) {
        if (requestId !== schoolListRequest.current) return;
        const next = await drivingSchoolAdminApi.listSchools({ q: filters.keyword, dataKind: filters.dataKind, status: filters.status, page, pageSize });
        items.push(...next.items);
      }
      if (requestId !== schoolListRequest.current) return;
      setSchools(items);
      setWorkspaceSchool((current) => {
        const targetId = current?.id || workspaceId;
        return targetId ? items.find((item) => item.id === targetId) || current : null;
      });
    } catch (reason) {
      if (requestId === schoolListRequest.current) onError((reason as Error).message);
    } finally {
      if (requestId === schoolListRequest.current) setSchoolLoading(false);
    }
  };

  useEffect(() => { void loadSchools(); }, []);

  useEffect(() => {
    const onPopState = () => {
      const next = readWorkspaceLocation();
      setWorkspaceId(next.schoolId);
      setWorkspaceSectionState(next.section);
      setWorkspaceSchool(next.schoolId ? schools.find((item) => item.id === next.schoolId) || null : null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [schools]);

  const openWorkspace = (school: DrivingSchool, section: DrivingSchoolWorkspaceSection) => {
    setWorkspaceSchool(school);
    setWorkspaceId(school.id);
    setWorkspaceSectionState(section);
    writeWorkspaceLocation(school.id, section);
  };

  const setWorkspaceSection = (section: DrivingSchoolWorkspaceSection) => {
    setWorkspaceSectionState(section);
    if (workspaceId) writeWorkspaceLocation(workspaceId, section);
  };

  const closeWorkspace = () => {
    setWorkspaceSchool(null);
    setWorkspaceId("");
    setWorkspaceSectionState("base");
    writeWorkspaceLocation("", "base");
  };

  const refreshSchool = async (id?: string) => {
    await loadSchools();
    if (id) {
      try {
        const detail = await drivingSchoolAdminApi.getSchool(id);
        setSchoolDraft(cloneSchool(detail));
      } catch (reason) {
        onError((reason as Error).message);
      }
    }
  };

  const metrics = useMemo(() => ({
    total: schools.length,
    published: schools.filter(schoolPublished).length,
    real: schools.filter((item) => item.dataKind === "real").length,
    classes: new Set(schools.flatMap((item) => item.trainingClasses?.filter((entry) => entry.status === "active").map((entry) => entry.licenseClassCode) || [])).size,
  }), [schools]);

  if (workspaceId && workspaceSchool) return <DrivingSchoolWorkbench school={workspaceSchool} section={workspaceSection} setSection={setWorkspaceSection} close={closeWorkspace} reloadDirectory={() => loadSchools()} onError={onError} />;

  return <div className="driving-school-admin">
    <section className="driving-school-hero">
      <div><span className="driving-school-trust"><ShieldCheck />经营信息与公开报价分层维护</span><h2>驾校服务运营台</h2><p>备案信息、车型能力、报价与咨询线索各自留源；“一级/二级/三级”仅表示培训车型数量，不代表教学质量。</p></div>
      <div className="driving-school-metrics" aria-label="驾校服务概览">
        <span><small>驾校</small><strong>{metrics.total}</strong></span><span><small>已发布</small><strong>{metrics.published}</strong></span><span><small>真实记录</small><strong>{metrics.real}</strong></span><span><small>车型覆盖</small><strong>{metrics.classes}</strong></span>
      </div>
    </section>

    <div className="driving-school-tabs" role="tablist" aria-label="驾校服务维护分类">
      {tabs.map(([value, label, Icon]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}><Icon />{label}</button>)}
    </div>

    {tab === "schools" ? <SchoolsTab schools={schools} loading={schoolLoading} reload={loadSchools} configure={openWorkspace} create={() => { schoolDetailRequest.current += 1; setSchoolDraft(emptySchool()); }} onError={onError} /> : null}
    {tab === "inquiries" ? <InquiriesTab schools={schools} initialInquiryId={initialInquiryId} onError={onError} /> : null}
    {schoolDraft ? <SchoolEditor draft={schoolDraft} setDraft={setSchoolDraft} close={() => { schoolDetailRequest.current += 1; setSchoolDraft(null); }} refresh={refreshSchool} onError={onError} /> : null}
  </div>;
}

function SchoolsTab({ schools, loading, reload, configure, create, onError }: { schools: DrivingSchool[]; loading: boolean; reload: (filters?: { keyword?: string; dataKind?: string; status?: string }) => Promise<void>; configure: (school: DrivingSchool, section: DrivingSchoolWorkspaceSection) => void; create: () => void; onError: (message: string) => void }) {
  const [filters, setFilters] = useState({ keyword: "", dataKind: "", status: "" });
  const publish = async (school: DrivingSchool) => {
    const errors = realPublishErrors(school);
    if (!schoolPublished(school) && errors.length) return onError(`真实驾校发布前请补全：${errors.join("、")}`);
    try {
      if (schoolPublished(school)) await drivingSchoolAdminApi.unpublishSchool(school.id);
      else await drivingSchoolAdminApi.publishSchool(school.id);
      await reload(filters);
    } catch (reason) { onError((reason as Error).message); }
  };
  const remove = async (school: DrivingSchool) => {
    if (!window.confirm(`确认删除“${school.name}”？已被咨询引用的记录应由服务端拒绝删除。`)) return;
    try { await drivingSchoolAdminApi.deleteSchool(school.id); await reload(filters); } catch (reason) { onError((reason as Error).message); }
  };
  return <section className="content-card driving-school-table-card">
    <header className="driving-school-section-head"><div><small>驾校目录</small><h3>驾校主体与培训能力</h3><p>列表只展示公开电话；内部联系人仅在编辑抽屉可见。</p></div><button type="button" onClick={create}><Plus />新增驾校</button></header>
    <form className="driving-school-filters" onSubmit={(event) => { event.preventDefault(); void reload(filters); }}>
      <span><MagnifyingGlass />筛选</span><input aria-label="搜索驾校" placeholder="驾校名称 / 主体 / 区域" value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} />
      <select aria-label="按数据类型筛选驾校" value={filters.dataKind} onChange={(event) => setFilters({ ...filters, dataKind: event.target.value })}><option value="">全部数据</option><option value="demo">演示</option><option value="real">真实</option></select>
      <select aria-label="按发布状态筛选驾校" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option><option value="published">已发布</option><option value="draft">未发布</option></select>
      <button type="submit">应用筛选</button><button type="button" className="secondary" onClick={() => { const empty = { keyword: "", dataKind: "", status: "" }; setFilters(empty); void reload(empty); }}>清空</button>
    </form>
    <div className="table-wrap"><table><thead><tr><th>驾校主体</th><th>位置 / 营业</th><th>培训车型</th><th>公开报价</th><th>备案信息</th><th>发布</th><th>操作</th></tr></thead><tbody>{schools.map((school) => { const activeOffers = (school.offers || []).filter((offer) => offer.status === "active"); const inquiryOnly = activeOffers.length > 0 && activeOffers.every((offer) => offer.priceType === "inquiry"); return <tr key={school.id}>
      <td><strong>{school.name}</strong><small>{school.dataKind === "demo" ? "演示资料" : school.legalName || "真实主体待补充"}</small></td>
      <td><strong>{school.district} · {school.address}</strong><small>{school.openHours || "营业时间待补充"}</small></td>
      <td><div className="driving-school-class-pills">{school.trainingClasses?.filter((item) => item.status === "active").slice(0, 5).map((item) => <span key={item.licenseClassCode}>{item.licenseClassCode}</span>)}</div><small>{school.trainingClasses?.filter((item) => item.status === "active").length || 0} 类车型</small></td>
      <td className="driving-school-directory-price"><strong>{school.startingPriceFen != null ? `¥${money(school.startingPriceFen)} 起` : inquiryOnly ? "价格需咨询" : "尚无公开报价"}</strong><small>{activeOffers.length ? `${activeOffers.length} 项启用报价` : "进入该校维护报价"} · {formatDateTime(school.offerUpdatedAt)}</small></td>
      <td><span className={`status-pill driving-school-reg-${school.regulatory.status}`}>{regulatoryStatusLabels[school.regulatory.status]}</span><small>{levelLabel(school.regulatory.capabilityLevel)} · 非质量评级</small></td>
      <td><span className={`status-pill ${schoolPublished(school) ? "driving-school-published" : "driving-school-draft"}`}>{schoolPublished(school) ? "已发布" : "未发布"}</span><small>{formatDateTime(school.updatedAt)}</small></td>
      <td><span className="driving-school-row-actions driving-school-directory-actions"><button type="button" className="primary" aria-label={`配置与预览 ${school.name}`} onClick={() => configure(school, "base")}>配置与预览</button><button type="button" aria-label={`管理报价 ${school.name}`} onClick={() => configure(school, "offers")}>管理报价</button><details><summary aria-label={`更多操作 ${school.name}`}>更多</summary><div><button type="button" aria-label={`${schoolPublished(school) ? "下线" : "发布"}驾校 ${school.name}`} onClick={() => void publish(school)}>{schoolPublished(school) ? "下线" : "发布"}</button><button type="button" className="danger" aria-label={`删除驾校 ${school.name}`} onClick={() => void remove(school)}>删除驾校</button></div></details></span></td>
    </tr>; })}</tbody></table>{!schools.length && !loading ? <div className="empty-table">当前筛选下暂无驾校</div> : null}{loading ? <div className="table-loading">正在同步驾校资料…</div> : null}</div>
  </section>;
}

function SchoolEditor({ draft, setDraft, close, refresh, onError }: { draft: SchoolDraft; setDraft: Dispatch<SetStateAction<SchoolDraft | null>>; close: () => void; refresh: (id?: string) => Promise<void>; onError: (message: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [locationQuery, setLocationQuery] = useState("");
  const [suggestions, setSuggestions] = useState<AdminLocationSuggestion[]>([]);
  const [locationState, setLocationState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");

  useEffect(() => {
    const query = locationQuery.trim();
    if (query.length < 2) { setSuggestions([]); setLocationState("idle"); return; }
    const controller = new AbortController();
    setLocationState("loading");
    const timer = window.setTimeout(() => {
      void drivingSchoolAdminApi.locationSuggestions(query, { signal: controller.signal }).then((result) => {
        setSuggestions(result.items);
        setLocationState(result.items.length ? "ready" : "empty");
      }).catch((reason) => {
        if ((reason as Error).name !== "AbortError") { setLocationState("error"); onError((reason as Error).message); }
      });
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [locationQuery]);

  const updateKind = (dataKind: "demo" | "real") => setDraft({
    ...draft,
    dataKind,
    isDemo: dataKind === "demo",
    regulatory: {
      ...draft.regulatory,
      status: dataKind === "demo" ? "demo" : draft.regulatory.status === "demo" ? "pending" : draft.regulatory.status,
    },
  });

  const selectLocation = (location: AdminLocationSuggestion) => {
    setDraft({ ...draft, location: { ...location }, district: location.district, address: location.address });
    setLocationQuery("");
    setSuggestions([]);
    setLocationState("idle");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) return onError("请填写驾校展示名称");
    if (!draft.id && !draft.location.locationProof) return onError("新建驾校必须从已签名的位置候选中选择地址");
    setSaving(true);
    setSaved("");
    const internalName = draft.internalContact?.name?.trim() || "";
    const internalPhone = draft.internalContact?.phone?.trim() || "";
    if ((internalName && !internalPhone) || (!internalName && internalPhone)) {
      setSaving(false);
      return onError("内部联系人与内部电话需同时填写；不需要时请同时留空");
    }
    const verifiedDate = draft.regulatory.verifiedAt?.slice(0, 10) || "";
    const payload = {
      name: draft.name.trim(),
      legalName: draft.legalName?.trim() || null,
      description: draft.description?.trim() || "",
      dataKind: draft.dataKind,
      ...(draft.location.locationProof ? { location: draft.location } : {}),
      publicPhone: draft.publicPhone?.trim() || null,
      internalContact: internalName && internalPhone ? { name: internalName, phone: internalPhone } : null,
      tags: draft.tags,
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
      inquiryRecipient: {
        recipientName: "驭小满驾校服务团队" as const,
        dataScope: ["联系人姓名", "手机号", "咨询车型", "期望联系时间"],
        purpose: "仅由驭小满平台内部了解意向并跟进，不向驾校或其他第三方转交",
        retention: "线索完结或关闭后 180 天内清理联系方式",
        consentText: "我同意上述信息仅由驭小满平台内部为本次驾校服务咨询处理，且不向驾校或其他第三方转交",
        contactEtaText: "预计 1 个工作日内由驭小满驾校服务团队联系",
        active: Boolean(draft.inquiryAvailable),
        synthetic: draft.dataKind === "demo",
      },
    };
    try {
      const savedSchool = draft.id
        ? await drivingSchoolAdminApi.updateSchool(draft.id, payload)
        : await drivingSchoolAdminApi.createSchool(payload);
      setDraft(cloneSchool(savedSchool));
      setSaved("资料已保存");
      await refresh(savedSchool.id);
    } catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };

  const publish = async () => {
    const errors = realPublishErrors(draft);
    if (!schoolPublished(draft) && errors.length) return onError(`真实驾校发布前请补全：${errors.join("、")}`);
    setSaving(true);
    try {
      const next = schoolPublished(draft) ? await drivingSchoolAdminApi.unpublishSchool(draft.id) : await drivingSchoolAdminApi.publishSchool(draft.id);
      setDraft(cloneSchool(next));
      await refresh(next.id);
    } catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };

  return <Drawer label={draft.id ? "编辑驾校资料" : "新增驾校资料"} title={draft.name || "新增驾校"} description="监管资料与校方商业信息分层维护" close={close} wide>
    <form className="driving-school-editor" onSubmit={save}>
      <section className="detail-section"><h3>主体与联系 <em>{draft.dataKind === "demo" ? "演示记录" : "真实记录"}</em></h3>
        <div className="driving-school-form-grid">
          <label><span>展示名称</span><input aria-label="驾校展示名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label><span>真实主体名称</span><input aria-label="驾校主体名称" value={draft.legalName || ""} onChange={(event) => setDraft({ ...draft, legalName: event.target.value })} /></label>
          <label><span>数据类型</span><select aria-label="驾校数据类型" value={draft.dataKind} onChange={(event) => updateKind(event.target.value as "demo" | "real")}><option value="demo">演示资料</option><option value="real">真实资料</option></select></label>
          <label><span>公开联系电话</span><input aria-label="驾校公开联系电话" value={draft.publicPhone || ""} onChange={(event) => setDraft({ ...draft, publicPhone: event.target.value })} /></label>
          <label><span>内部联系人</span><input aria-label="驾校内部联系人" value={draft.internalContact?.name || ""} onChange={(event) => setDraft({ ...draft, internalContact: { ...draft.internalContact, name: event.target.value } })} /></label>
          <label><span>内部电话</span><input aria-label="驾校内部电话" value={draft.internalContact?.phone || ""} onChange={(event) => setDraft({ ...draft, internalContact: { ...draft.internalContact, phone: event.target.value } })} /></label>
          <label><span>营业时间</span><input aria-label="驾校营业时间" value={draft.openHours} onChange={(event) => setDraft({ ...draft, openHours: event.target.value })} /></label>
          <label><span>后台排序</span><input aria-label="驾校后台排序" type="number" value={draft.sortPriority || 0} onChange={(event) => setDraft({ ...draft, sortPriority: Number(event.target.value) })} /></label>
          <label className="wide"><span>公开简介</span><textarea aria-label="驾校公开简介" value={draft.description || ""} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <label className="wide"><span>标签（逗号分隔）</span><input aria-label="驾校标签" value={draft.tags.join("，")} onChange={(event) => setDraft({ ...draft, tags: splitItems(event.target.value) })} /></label>
          <label className="wide"><span>设施（逗号或换行分隔）</span><textarea aria-label="驾校设施" value={(draft.facilities || []).join("\n")} onChange={(event) => setDraft({ ...draft, facilities: splitItems(event.target.value) })} /></label>
          <label className="driving-school-check"><input aria-label="驾校记录启用" type="checkbox" checked={Boolean(draft.isActive)} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /><span><strong>记录启用</strong><small>停用后不参与公开目录</small></span></label>
          <label className="driving-school-check"><input aria-label="驾校允许咨询" type="checkbox" checked={Boolean(draft.inquiryAvailable)} onChange={(event) => setDraft({ ...draft, inquiryAvailable: event.target.checked })} /><span><strong>允许咨询</strong><small>仅由平台内部跟进，不向驾校转交个人资料</small></span></label>
        </div>
      </section>

      <section className="detail-section driving-school-location"><h3>签名位置候选 <em>地址不可自由录入</em></h3>
        <div className="driving-school-location-search"><MagnifyingGlass /><input aria-label="搜索驾校位置" type="search" placeholder="输入驾校或道路名称，选择服务端候选" value={locationQuery} onChange={(event) => setLocationQuery(event.target.value)} />{locationState === "loading" ? <span>查询中…</span> : null}</div>
        {suggestions.length ? <div className="driving-school-location-options" role="listbox" aria-label="驾校位置候选">{suggestions.map((location) => <button key={location.poiId} type="button" role="option" aria-selected={draft.location.poiId === location.poiId} onClick={() => selectLocation(location)}><MapPin /><span><strong>{location.title}</strong><small>{location.address}</small></span><em>{location.district}{location.source === "demo" ? " · 演示" : ""}</em></button>)}</div> : null}
        {locationState === "empty" ? <p className="driving-school-location-state">没有匹配的位置候选，请换一个关键词。</p> : null}
        {draft.location.poiId ? <div className="driving-school-location-selected"><MapPin weight="fill" /><span><small>{draft.location.locationProof ? "本次已选择签名候选" : "服务端已保存位置"}</small><strong>{draft.location.title || draft.name}</strong><p>{draft.district} · {draft.address}</p></span></div> : <div className="driving-school-location-empty"><MapPin /><span><strong>尚未选择位置</strong><small>新建记录必须选择包含位置凭证的候选</small></span></div>}
      </section>

      <section className="detail-section"><h3>备案 / 存量许可 <em>交通运输主管部门来源</em></h3>
        <div className="driving-school-level-note"><WarningCircle /><span><strong>{levelLabel(draft.regulatory.capabilityLevel)}普通机动车驾驶员培训</strong><small>等级按可培训车型数量划分：一级 ≥3 类、二级 2 类、三级 1 类；不是质量、星级或排名。</small></span></div>
        <div className="driving-school-form-grid">
          <label><span>监管凭据类型</span><select aria-label="驾校监管凭据类型" value={draft.regulatory.type} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, type: event.target.value as "filing" | "legacy_license" } })}><option value="filing">经营备案</option><option value="legacy_license">存量许可证</option></select></label>
          <label><span>核验状态</span><select aria-label="驾校监管核验状态" value={draft.regulatory.status} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, status: event.target.value as DrivingSchoolRegulatoryStatus } })}>{Object.entries(regulatoryStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>备案 / 许可编号</span><input aria-label="驾校监管编号" value={draft.regulatory.number} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, number: event.target.value } })} /></label>
          <label><span>备案 / 许可机关</span><input aria-label="驾校监管机关" value={draft.regulatory.authority} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, authority: event.target.value } })} /></label>
          <label><span>来源名称</span><input aria-label="驾校监管来源名称" value={draft.regulatory.sourceLabel} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, sourceLabel: event.target.value } })} /></label>
          <label><span>来源链接</span><input aria-label="驾校监管来源链接" type="url" value={draft.regulatory.sourceUrl || ""} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, sourceUrl: event.target.value } })} /></label>
          <label><span>有效起始日</span><input aria-label="驾校监管有效起始日" type="date" value={draft.regulatory.validFrom || ""} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, validFrom: event.target.value } })} /></label>
          <label><span>有效截止日</span><input aria-label="驾校监管有效截止日" type="date" value={draft.regulatory.validUntil || ""} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, validUntil: event.target.value } })} /></label>
          <label><span>核验日期</span><input aria-label="驾校监管核验日期" type="date" value={(draft.regulatory.verifiedAt || "").slice(0, 10)} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, verifiedAt: event.target.value } })} /></label>
          <label><span>培训能力等级</span><select aria-label="驾校培训能力等级" value={String(draft.regulatory.capabilityLevel || "level_1")} onChange={(event) => setDraft({ ...draft, regulatory: { ...draft.regulatory, capabilityLevel: event.target.value as "level_1" | "level_2" | "level_3" } })}><option value="level_1">一级（≥3 类车型）</option><option value="level_2">二级（2 类车型）</option><option value="level_3">三级（1 类车型）</option></select></label>
        </div>
      </section>

      {draft.id ? <><TrainingClassManager schoolId={draft.id} onChanged={(trainingClasses) => setDraft((current) => current ? { ...current, trainingClasses } : current)} onError={onError} /><ImageManager schoolId={draft.id} onChanged={(images) => setDraft((current) => current ? { ...current, images, coverImage: images.find((item) => item.isCover) || images[0] || null } : current)} onError={onError} /></> : <div className="driving-school-save-first"><Student /><span><strong>先保存主体资料</strong><small>生成学校记录后即可维护车型能力与图库。</small></span></div>}

      <footer className="driving-school-editor-footer"><span>{saved ? <><CheckCircle />{saved}</> : draft.dataKind === "real" ? "真实记录发布前执行必填核验" : "演示资料必须持续显示演示标识"}</span>{draft.id ? <button type="button" className="secondary" onClick={() => void publish()} disabled={saving}>{schoolPublished(draft) ? "下线" : "发布"}</button> : null}<button type="submit" disabled={saving}>{saving ? "保存中…" : "保存驾校资料"}</button></footer>
    </form>
  </Drawer>;
}

function TrainingClassManager({ schoolId, onChanged, onError }: { schoolId: string; onChanged: (items: DrivingSchoolTrainingClass[]) => void; onError: (message: string) => void }) {
  const [items, setItems] = useState<DrivingSchoolTrainingClass[]>([]);
  const [editingCode, setEditingCode] = useState("");
  const [code, setCode] = useState("C1");
  const [modes, setModes] = useState<DrivingSchoolApplicationMode[]>(["initial"]);
  const [capabilityNote, setCapabilityNote] = useState("");
  const [conditions, setConditions] = useState("");
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

  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    void load(controller.signal);
    return () => { requestRef.current += 1; controller.abort(); };
  }, [schoolId]);

  const catalog = licenseClasses.find(([item]) => item === code);
  const reset = () => { setEditingCode(""); setCode("C1"); setModes(["initial"]); setCapabilityNote(""); setConditions(""); setStatus("active"); };
  const edit = (item: DrivingSchoolTrainingClass) => {
    setEditingCode(item.licenseClassCode);
    setCode(item.licenseClassCode);
    setModes(item.applicationModes?.length ? item.applicationModes : item.supportedModes);
    setCapabilityNote(item.trainingCapabilityNote || (item.trainingCapabilityLevel && !/^level_[123]$/.test(item.trainingCapabilityLevel) ? item.trainingCapabilityLevel : ""));
    setConditions((item.schoolConditions || item.conditions || []).join("\n"));
    setStatus(item.status);
  };
  const toggleMode = (mode: DrivingSchoolApplicationMode, allowed: boolean) => {
    if (!allowed) return;
    setModes((current) => current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode]);
  };
  const save = async () => {
    if (!modes.length) return onError("请至少选择一种报名方式");
    setSaving(true);
    const input = { applicationModes: modes, trainingCapabilityNote: capabilityNote.trim() || null, schoolConditions: splitItems(conditions), conditions: splitItems(conditions), status };
    try {
      if (editingCode) await drivingSchoolAdminApi.updateTrainingClass(schoolId, editingCode, input);
      else await drivingSchoolAdminApi.createTrainingClass(schoolId, { licenseClassCode: code, ...input });
      reset();
      const next = await load();
      if (next) onChanged(next);
    } catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };
  const remove = async (item: DrivingSchoolTrainingClass) => {
    if (!window.confirm(`确认删除 ${item.licenseClassCode} 培训能力？`)) return;
    try { await drivingSchoolAdminApi.deleteTrainingClass(schoolId, item.licenseClassCode); const next = await load(); if (next) onChanged(next); }
    catch (reason) { onError((reason as Error).message); }
  };

  return <section className="detail-section driving-school-manager"><h3>车型能力 <em>按准驾车型维护</em></h3>
    <div className="driving-school-inline-form">
      <label><span>准驾车型</span><select aria-label="培训准驾车型" value={code} disabled={Boolean(editingCode)} onChange={(event) => { const next = event.target.value; const nextCatalog = licenseClasses.find(([item]) => item === next); setCode(next); setModes(nextCatalog?.[2] ? ["initial"] : ["upgrade"]); }}>{licenseClasses.map(([value, name]) => <option key={value} value={value} disabled={!editingCode && items.some((item) => item.licenseClassCode === value)}>{value} · {name}</option>)}</select></label>
      <fieldset><legend>报名方式</legend><label><input type="checkbox" checked={modes.includes("initial")} disabled={!catalog?.[2]} onChange={() => toggleMode("initial", Boolean(catalog?.[2]))} />初次申领</label><label><input type="checkbox" checked={modes.includes("upgrade")} disabled={!catalog?.[3]} onChange={() => toggleMode("upgrade", Boolean(catalog?.[3]))} />增驾</label></fieldset>
      <label><span>车型培训备注</span><input aria-label="车型培训备注" value={capabilityNote} onChange={(event) => setCapabilityNote(event.target.value)} placeholder="如：独立训练场" /></label>
      <label><span>学校补充条件（逗号分隔）</span><input aria-label="学校补充培训条件" value={conditions} onChange={(event) => setConditions(event.target.value)} /></label>
      <label><span>状态</span><select aria-label="培训能力状态" value={status} onChange={(event) => setStatus(event.target.value as "active" | "inactive")}><option value="active">启用</option><option value="inactive">停用</option></select></label>
      <span className="driving-school-inline-actions">{editingCode ? <button type="button" className="secondary" onClick={reset}>取消</button> : null}<button type="button" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : editingCode ? "更新车型" : "添加车型"}</button></span>
    </div>
    <div className="driving-school-manager-list">{items.map((item) => {
      const itemModes = item.applicationModes?.length ? item.applicationModes : item.supportedModes;
      return <article key={item.licenseClassCode}><span className="driving-school-code">{item.licenseClassCode}</span><div><strong>{item.name || classLabel(item.licenseClassCode)}</strong><small>{itemModes.map((mode) => mode === "initial" ? "初次申领" : "增驾").join(" / ")} · {item.status === "active" ? "启用" : "停用"}</small></div><button type="button" aria-label={`编辑车型 ${item.licenseClassCode}`} onClick={() => edit(item)}><PencilSimple /></button><button type="button" className="danger" aria-label={`删除车型 ${item.licenseClassCode}`} onClick={() => void remove(item)}><Trash /></button></article>;
    })}{!items.length ? <p className="driving-school-manager-empty">尚未配置培训车型</p> : null}</div>
  </section>;
}

function ImageManager({ schoolId, onChanged, onError }: { schoolId: string; onChanged: (items: DrivingSchoolImage[]) => void; onError: (message: string) => void }) {
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
    try { await drivingSchoolAdminApi.createImage(schoolId, { url: url.trim(), caption: caption.trim(), isCover, sortOrder: items.length }); setUrl(""); setCaption(""); setIsCover(false); const next = await load(); if (next) onChanged(next); }
    catch (reason) { onError((reason as Error).message); }
  };
  const makeCover = async (item: DrivingSchoolImage) => {
    try { await drivingSchoolAdminApi.updateImage(schoolId, item.id, { isCover: true }); const next = await load(); if (next) onChanged(next); }
    catch (reason) { onError((reason as Error).message); }
  };
  const remove = async (item: DrivingSchoolImage) => {
    if (!window.confirm("确认删除这张图片？")) return;
    try { await drivingSchoolAdminApi.deleteImage(schoolId, item.id); const next = await load(); if (next) onChanged(next); }
    catch (reason) { onError((reason as Error).message); }
  };
  return <section className="detail-section driving-school-manager"><h3>学校图库 <em>封面用于公开列表</em></h3>
    <div className="driving-school-inline-form image-form"><label className="wide"><span>图片地址</span><input aria-label="驾校图片地址" type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></label><label><span>图片说明</span><input aria-label="驾校图片说明" value={caption} onChange={(event) => setCaption(event.target.value)} /></label><label className="driving-school-mini-check"><input aria-label="设为驾校封面" type="checkbox" checked={isCover} onChange={(event) => setIsCover(event.target.checked)} />设为封面</label><button type="button" onClick={() => void add()}><Image />添加图片</button></div>
    <div className="driving-school-image-grid">{items.map((item) => <article key={item.id}><img src={item.url} alt={item.caption || "驾校图片"} /><div><strong>{item.caption || "未填写说明"}</strong><small>{item.isCover ? "当前封面" : `排序 ${item.sortOrder}`}</small></div><span>{!item.isCover ? <button type="button" onClick={() => void makeCover(item)}>设为封面</button> : null}<button type="button" className="danger" aria-label={`删除图片 ${item.caption || "未命名图片"}`} onClick={() => void remove(item)}><Trash /></button></span></article>)}{!items.length ? <p className="driving-school-manager-empty">尚未上传图库图片</p> : null}</div>
  </section>;
}

function InquiriesTab({ schools, initialInquiryId, onError }: { schools: DrivingSchool[]; initialInquiryId: string; onError: (message: string) => void }) {
  const [items, setItems] = useState<DrivingSchoolInquiry[]>([]);
  const [filters, setFilters] = useState({ status: "", schoolId: "", licenseClassCode: "", dateFrom: "", dateTo: "" });
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<DrivingSchoolInquiryDetail | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState("");
  const listRequest = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const detailRequest = useRef(0);
  const detailController = useRef<AbortController | null>(null);
  const deepLinkOpenedRef = useRef("");

  const load = async (next = filters) => {
    const requestId = ++listRequest.current;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    try {
      const pageSize = 100;
      const result = await drivingSchoolAdminApi.listInquiries({ page: 1, pageSize, status: next.status, schoolId: next.schoolId, licenseClassCode: next.licenseClassCode, dateFrom: next.dateFrom, dateTo: next.dateTo }, { signal: controller.signal });
      const allItems = [...result.items];
      const pageCount = Math.ceil(result.total / pageSize);
      for (let page = 2; page <= pageCount; page += 1) {
        if (requestId !== listRequest.current) return;
        const pageResult = await drivingSchoolAdminApi.listInquiries({ page, pageSize, status: next.status, schoolId: next.schoolId, licenseClassCode: next.licenseClassCode, dateFrom: next.dateFrom, dateTo: next.dateTo }, { signal: controller.signal });
        allItems.push(...pageResult.items);
      }
      if (requestId !== listRequest.current) return;
      setItems(allItems);
    } catch (reason) { if ((reason as Error).name !== "AbortError" && requestId === listRequest.current) onError((reason as Error).message); }
    finally { if (requestId === listRequest.current) setLoading(false); }
  };
  useEffect(() => { void load({ status: "", schoolId: "", licenseClassCode: "", dateFrom: "", dateTo: "" }); return () => { listRequest.current += 1; listController.current?.abort(); detailController.current?.abort(); }; }, []);
  useEffect(() => {
    if (!initialInquiryId || deepLinkOpenedRef.current === initialInquiryId) return;
    deepLinkOpenedRef.current = initialInquiryId;
    setDetailLoadingId(initialInquiryId);
    void drivingSchoolAdminApi.getInquiry(initialInquiryId)
      .then(setDetail)
      .catch((reason) => onError((reason as Error).message))
      .finally(() => setDetailLoadingId(""));
  }, [initialInquiryId, onError]);

  const openSensitive = async (item: DrivingSchoolInquiry) => {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    const requestId = ++detailRequest.current;
    setDetail(null);
    setDetailLoadingId(item.id);
    try {
      const result = await drivingSchoolAdminApi.getInquiry(item.id, { signal: controller.signal });
      if (requestId === detailRequest.current) setDetail(result);
    } catch (reason) { if ((reason as Error).name !== "AbortError" && requestId === detailRequest.current) onError((reason as Error).message); }
    finally { if (requestId === detailRequest.current) setDetailLoadingId(""); }
  };
  const closeDetail = () => { detailController.current?.abort(); detailRequest.current += 1; setDetail(null); setDetailLoadingId(""); const url = new URL(window.location.href); url.searchParams.delete("inquiry"); window.history.replaceState({}, "", `${url.pathname}${url.search}`); };
  const clear = () => { const next = { status: "", schoolId: "", licenseClassCode: "", dateFrom: "", dateTo: "" }; setFilters(next); void load(next); };

  return <section className="content-card driving-school-table-card">
    <header className="driving-school-section-head"><div><small>隐私保护咨询</small><h3>咨询线索</h3><p>列表默认脱敏；敏感详情需显式查看并由服务端记录审计。接收方固定为驭小满驾校服务团队。</p></div></header>
    <form className="driving-school-filters inquiry" onSubmit={(event) => { event.preventDefault(); void load(filters); }}>
      <span><MagnifyingGlass />筛选</span><select aria-label="按咨询状态筛选" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option>{Object.entries(inquiryStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="按驾校筛选咨询" value={filters.schoolId} onChange={(event) => setFilters({ ...filters, schoolId: event.target.value })}><option value="">全部驾校</option>{schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select><select aria-label="按车型筛选咨询" value={filters.licenseClassCode} onChange={(event) => setFilters({ ...filters, licenseClassCode: event.target.value })}><option value="">全部车型</option>{licenseClasses.map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}</select><label><span>从</span><input aria-label="咨询开始日期" type="date" value={filters.dateFrom} onChange={(event) => setFilters({ ...filters, dateFrom: event.target.value })} /></label><label><span>至</span><input aria-label="咨询结束日期" type="date" value={filters.dateTo} onChange={(event) => setFilters({ ...filters, dateTo: event.target.value })} /></label><button type="submit">应用筛选</button><button type="button" className="secondary" onClick={clear}>清空</button>
    </form>
    <div className="driving-school-privacy-note"><ShieldCheck /><span><strong>个人资料不转交、不导出</strong><small>只允许驭小满驾校服务团队在本后台按咨询目的联系与记录结果。</small></span></div>
    <div className="table-wrap"><table><thead><tr><th>咨询编号</th><th>驾校 / 车型</th><th>脱敏联系人</th><th>期望联系</th><th>提交时间</th><th>状态</th><th>查看</th></tr></thead><tbody>{items.map((item) => { const withdrawn = item.status === "withdrawn"; return <tr key={item.id}><td><strong>{item.inquiryCode}</strong><small>{item.isSynthetic ? "演示线索" : "真实线索"}</small></td><td><strong>{item.school.name}</strong><small>{classLabel(item.licenseClassCode)} · {item.applicationMode === "initial" ? "初次申领" : "增驾"}</small></td><td><strong>{item.contactNameMasked || "已清除"}</strong><small>{item.maskedPhone || "已清除"}</small></td><td><strong>{withdrawn ? "已停止联系" : inquiryContactWindowLabel(item.contactWindow)}</strong><small>接收方：驭小满驾校服务团队</small></td><td><strong>{formatDateTime(item.submittedAt)}</strong><small>更新 {formatDateTime(item.updatedAt)}</small></td><td><span className={`status-pill driving-school-inquiry-${item.status}`}>{inquiryStatusLabels[item.status]}</span></td><td><button type="button" className="sensitive-button" aria-label={`${withdrawn ? "查看撤回记录" : "查看敏感详情"} ${item.inquiryCode}`} onClick={() => void openSensitive(item)} disabled={detailLoadingId === item.id}>{withdrawn ? <XCircle /> : <Eye />}{detailLoadingId === item.id ? "读取中…" : withdrawn ? "查看记录" : "显式查看"}</button></td></tr>; })}</tbody></table>{!items.length && !loading ? <div className="empty-table">当前筛选下暂无咨询线索</div> : null}{loading ? <div className="table-loading">正在加载脱敏线索…</div> : null}</div>
    {detail ? <InquiryEditor detail={detail} close={closeDetail} changed={async (updated) => { setItems((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item)); const latest = await drivingSchoolAdminApi.getInquiry(updated.id); setDetail(latest); }} onError={onError} /> : null}
  </section>;
}

function InquiryEditor({ detail, close, changed, onError }: { detail: DrivingSchoolInquiryDetail; close: () => void; changed: (updated: DrivingSchoolInquiry) => Promise<void>; onError: (message: string) => void }) {
  const [status, setStatus] = useState<DrivingSchoolInquiryStatus>(detail.status);
  const [note, setNote] = useState(detail.internalNote || "");
  const [saving, setSaving] = useState(false);
  const locked = detail.status === "withdrawn";
  const allowed: DrivingSchoolInquiryStatus[] = detail.status === "new" ? ["new", "contacting"] : detail.status === "contacting" ? ["contacting", "resolved", "closed"] : [detail.status];
  const save = async () => {
    if (locked) return;
    setSaving(true);
    try { const updated = await drivingSchoolAdminApi.updateInquiry(detail.id, { status: status as Exclude<DrivingSchoolInquiryStatus, "withdrawn">, internalNote: note.trim() || null }); await changed(updated); }
    catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };
  return <Drawer label={locked ? "咨询撤回记录" : "咨询敏感详情"} title={detail.inquiryCode} description={locked ? "仅查看不可恢复的撤回状态与审计记录" : "本次查看已由服务端写入敏感详情审计"} close={close}>
    <div className="driving-school-inquiry-detail"><section className="detail-section"><h3>接收与隐私 <em>只读</em></h3><dl><div><dt>接收方</dt><dd data-testid="fixed-inquiry-recipient">驭小满驾校服务团队</dd></div><div><dt>用途</dt><dd>{locked ? "咨询已撤回，禁止继续联系或跟进" : "仅用于本次驾校服务咨询联系与跟进"}</dd></div><div><dt>边界</dt><dd>不得向驾校或其他第三方转交，不提供导出</dd></div></dl></section>
      {locked ? <section className="detail-section"><h3>联系方式 <em>已停止使用</em></h3><div className="driving-school-locked"><XCircle /><span><strong>联系方式已在撤回时清除</strong><small>后台不能继续读取或恢复姓名、手机号和备注。</small></span></div></section> : <section className="detail-section"><h3>敏感联系方式 <em>显式读取</em></h3><div className="driving-school-sensitive-card"><ShieldCheck weight="fill" /><div><small>联系人</small><strong data-testid="sensitive-contact-name">{detail.contact?.name || "已清除"}</strong><small>联系电话</small><strong data-testid="sensitive-contact-phone">{detail.contact?.phone || "已清除"}</strong>{detail.contact?.message ? <p>{detail.contact.message}</p> : null}</div></div></section>}
      <section className="detail-section"><h3>跟进记录 <em>{locked ? "撤回后锁定" : "平台内部"}</em></h3>{locked ? <div className="driving-school-locked"><XCircle /><span><strong>用户已撤回咨询</strong><small>状态与内部备注均不可继续操作。</small></span></div> : null}<div className="driving-school-form-grid"><label><span>处理状态</span><select aria-label="咨询处理状态" value={status} disabled={locked} onChange={(event) => setStatus(event.target.value as DrivingSchoolInquiryStatus)}>{allowed.map((value) => <option key={value} value={value}>{inquiryStatusLabels[value]}</option>)}</select></label><label className="wide"><span>联系备注</span><textarea aria-label="咨询联系备注" value={note} disabled={locked} onChange={(event) => setNote(event.target.value)} placeholder="记录平台团队联系结果，不填写无关个人信息" /></label></div></section>
      {detail.events?.length ? <section className="detail-section"><h3>审计轨迹</h3><div className="driving-school-events">{detail.events.map((event, index) => <div key={String(event.id || index)}><span>系统操作</span><time>{formatDateTime(String(event.createdAt || ""))}</time></div>)}</div></section> : null}
      <footer className="driving-school-editor-footer"><span>{locked ? "撤回线索已冻结" : "保存仅更新平台内部状态与备注"}</span><button type="button" disabled={locked || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存跟进"}</button></footer>
    </div>
  </Drawer>;
}
