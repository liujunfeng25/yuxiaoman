import { api } from "../../../../services/api";
import type {
  DrivingSchoolApplicationMode,
  DrivingSchoolLicenseClassGroup,
  DrivingSchoolListItem,
  DrivingSchoolMeta,
  DrivingSchoolMetaOption,
  DrivingSchoolSort,
} from "../../../../types";
import {
  FALLBACK_DRIVING_SCHOOL_META,
  classesForMode,
  errorKind,
  licenseClassName,
  localDrivingSchoolCover,
  normalizeDrivingSchoolListEntryOptions,
  offerPriceText,
  quickClasses,
  resolveDrivingSchoolCover,
  shortDate,
} from "../../utils";

type SchoolView = DrivingSchoolListItem & {
  coverFallback: string;
  classText: string;
  dataLabel: string;
  priceText: string;
  regulatoryLabel: string;
  verifiedText: string;
  updatedText: string;
};

type Data = {
  meta: DrivingSchoolMeta;
  items: SchoolView[];
  quickClassItems: Array<{ code: string; name: string }>;
  classGroups: DrivingSchoolLicenseClassGroup[];
  districtOptions: DrivingSchoolMetaOption[];
  regulatoryOptions: DrivingSchoolMetaOption[];
  priceTypeOptions: DrivingSchoolMetaOption[];
  queryText: string;
  q: string;
  applicationMode: DrivingSchoolApplicationMode;
  licenseClassCode: string;
  district: string;
  districtIndex: number;
  districtLabel: string;
  regulatoryType: string;
  regulatoryIndex: number;
  regulatoryLabel: string;
  priceType: string;
  priceTypeLabel: string;
  sort: DrivingSchoolSort;
  sortLabel: string;
  showClassPanel: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  stateKind: "offline" | "not_found" | "error" | "";
  page: number;
  total: number;
  totalPages: number;
};

const sortValues: DrivingSchoolSort[] = ["recommended", "price_asc", "updated"];
const sortLabels = ["综合推荐", "价格从低到高", "报价最近更新"];

function withAll(options: DrivingSchoolMetaOption[], label: string): DrivingSchoolMetaOption[] {
  return [{ value: "", label }, ...options.filter((item) => item.value)];
}

function mergedMeta(raw?: DrivingSchoolMeta | null): DrivingSchoolMeta {
  if (!raw) return FALLBACK_DRIVING_SCHOOL_META;
  return {
    licenseClassGroups: raw.licenseClassGroups.length ? raw.licenseClassGroups : FALLBACK_DRIVING_SCHOOL_META.licenseClassGroups,
    applicationModes: raw.applicationModes.length ? raw.applicationModes : FALLBACK_DRIVING_SCHOOL_META.applicationModes,
    districts: raw.districts || [],
    regulatoryTypes: raw.regulatoryTypes.length ? raw.regulatoryTypes : FALLBACK_DRIVING_SCHOOL_META.regulatoryTypes,
    priceTypes: raw.priceTypes.length ? raw.priceTypes : FALLBACK_DRIVING_SCHOOL_META.priceTypes,
    capabilityLevels: raw.capabilityLevels.length ? raw.capabilityLevels : FALLBACK_DRIVING_SCHOOL_META.capabilityLevels,
    sortOptions: raw.sortOptions.length ? raw.sortOptions : FALLBACK_DRIVING_SCHOOL_META.sortOptions,
    trainingCapabilityNotice: raw.trainingCapabilityNotice || FALLBACK_DRIVING_SCHOOL_META.trainingCapabilityNotice,
  };
}

function regulatoryLabel(item: DrivingSchoolListItem): string {
  if (item.isDemo || item.dataKind === "demo" || item.dataKind === "synthetic_demo") return "演示监管信息";
  if (item.regulatory.type === "legacy_license") return "存量许可";
  if (item.regulatory.type === "filing") return "备案可查";
  return item.regulatory.sourceLabel || "资质待核验";
}

function schoolView(item: DrivingSchoolListItem): SchoolView {
  const classes = item.trainingClasses.map((entry) => entry.licenseClassCode);
  return {
    ...item,
    coverImage: resolveDrivingSchoolCover(item),
    coverFallback: localDrivingSchoolCover(item.trainingClasses, item.id),
    classText: classes.length ? classes.slice(0, 8).join(" · ") : "准驾车型待维护",
    dataLabel: item.isDemo || item.dataKind === "demo" || item.dataKind === "synthetic_demo" ? "演示数据" : "真实机构",
    priceText: offerPriceText(item.startingPriceFen, item.startingPriceFen),
    regulatoryLabel: regulatoryLabel(item),
    verifiedText: item.regulatory.verifiedAt ? `核验于 ${shortDate(item.regulatory.verifiedAt)}` : "核验时间待补充",
    updatedText: item.offerUpdatedAt ? `报价更新 ${shortDate(item.offerUpdatedAt)}` : "报价更新时间待补充",
  };
}

Page<Data>({
  requestSequence: 0,

  data: {
    meta: FALLBACK_DRIVING_SCHOOL_META,
    items: [],
    quickClassItems: quickClasses(FALLBACK_DRIVING_SCHOOL_META, "initial"),
    classGroups: classesForMode(FALLBACK_DRIVING_SCHOOL_META, "initial"),
    districtOptions: [{ value: "", label: "全部行政区" }],
    regulatoryOptions: withAll(FALLBACK_DRIVING_SCHOOL_META.regulatoryTypes, "全部备案类型"),
    priceTypeOptions: withAll(FALLBACK_DRIVING_SCHOOL_META.priceTypes, "全部价格类型"),
    queryText: "", q: "", applicationMode: "initial", licenseClassCode: "",
    district: "", districtIndex: 0, districtLabel: "行政区",
    regulatoryType: "", regulatoryIndex: 0, regulatoryLabel: "备案类型",
    priceType: "", priceTypeLabel: "价格类型",
    sort: "recommended", sortLabel: "综合推荐", showClassPanel: false,
    loading: true, loadingMore: false, error: "", stateKind: "",
    page: 1, total: 0, totalPages: 1,
  },

  onLoad(options) {
    const entry = normalizeDrivingSchoolListEntryOptions(FALLBACK_DRIVING_SCHOOL_META, options);
    this.setData({
      queryText: entry.q,
      q: entry.q,
      applicationMode: entry.applicationMode,
      licenseClassCode: entry.licenseClassCode,
    });
    void this.bootstrap(options.licenseClassCode == null ? undefined : String(options.licenseClassCode));
  },
  onPullDownRefresh() { void this.load(true, true); },
  onReachBottom() {
    if (!this.data.loading && !this.data.loadingMore && this.data.page < this.data.totalPages) void this.load(false);
  },

  async bootstrap(requestedLicenseClassCode?: string) {
    let meta = FALLBACK_DRIVING_SCHOOL_META;
    try {
      meta = mergedMeta(await api.drivingSchoolMeta());
    } catch {
      // 车型分组使用内置交通管理口径，列表仍独立尝试加载。
    }
    const entry = normalizeDrivingSchoolListEntryOptions(meta, {
      q: this.data.q,
      applicationMode: this.data.applicationMode,
      licenseClassCode: requestedLicenseClassCode === undefined ? this.data.licenseClassCode : requestedLicenseClassCode,
    });
    const districtOptions = withAll(meta.districts, "全部行政区");
    await new Promise<void>((resolve) => this.setData({
      meta,
      queryText: entry.q,
      q: entry.q,
      applicationMode: entry.applicationMode,
      licenseClassCode: entry.licenseClassCode,
      quickClassItems: quickClasses(meta, entry.applicationMode),
      classGroups: classesForMode(meta, entry.applicationMode),
      districtOptions,
      regulatoryOptions: withAll(meta.regulatoryTypes, "全部备案类型"),
      priceTypeOptions: withAll(meta.priceTypes, "全部价格类型"),
    }, resolve));
    await this.load(true);
  },

  async load(reset = true, fromPullDown = false) {
    const requestSequence = ++this.requestSequence;
    const page = reset ? 1 : this.data.page + 1;
    const query = {
      page,
      pageSize: 12,
      q: this.data.q || undefined,
      trainingMode: this.data.applicationMode,
      licenseClassCode: this.data.licenseClassCode || undefined,
      district: this.data.district || undefined,
      regulatoryType: this.data.regulatoryType || undefined,
      priceType: this.data.priceType || undefined,
      sort: this.data.sort,
    };
    const previousItems = reset ? [] : this.data.items;
    this.setData(reset
      ? { loading: true, error: "", stateKind: "" }
      : { loadingMore: true, error: "", stateKind: "" });
    try {
      const result = await api.drivingSchools(query);
      if (requestSequence !== this.requestSequence) return;
      const nextItems = result.items.map(schoolView);
      this.setData({
        items: reset ? nextItems : [...previousItems, ...nextItems],
        page: result.pagination.page,
        total: result.pagination.total,
        totalPages: result.pagination.totalPages || 1,
      });
    } catch (error) {
      if (requestSequence !== this.requestSequence) return;
      this.setData({
        error: error instanceof Error ? error.message : "驾校列表暂时无法读取",
        stateKind: errorKind(error),
        ...(reset ? { items: [], total: 0 } : {}),
      });
    } finally {
      if (requestSequence === this.requestSequence) this.setData({ loading: false, loadingMore: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  applyFilters(patch: Partial<Data>) {
    this.setData(patch, () => {
      void this.load(true);
    });
  },

  queryInput(event) { this.setData({ queryText: String(event.detail.value || "") }); },
  submitSearch() { this.applyFilters({ q: this.data.queryText.trim() }); },
  clearSearch() { this.applyFilters({ queryText: "", q: "" }); },

  chooseMode(event) {
    const applicationMode = String(event.currentTarget.dataset.mode || "initial") as DrivingSchoolApplicationMode;
    if (applicationMode === this.data.applicationMode) return;
    const groups = classesForMode(this.data.meta, applicationMode);
    const remainsAvailable = groups.some((group) => group.items.some((item) => item.code === this.data.licenseClassCode));
    this.applyFilters({
      applicationMode,
      licenseClassCode: remainsAvailable ? this.data.licenseClassCode : "",
      quickClassItems: quickClasses(this.data.meta, applicationMode),
      classGroups: groups,
    });
  },

  chooseQuickClass(event) {
    const code = String(event.currentTarget.dataset.code || "");
    this.applyFilters({ licenseClassCode: code === this.data.licenseClassCode ? "" : code });
  },
  openClassPanel() { this.setData({ showClassPanel: true }); },
  closeClassPanel() { this.setData({ showClassPanel: false }); },
  chooseClass(event) {
    const code = String(event.currentTarget.dataset.code || "");
    this.applyFilters({ licenseClassCode: code, showClassPanel: false });
  },

  districtChange(event) {
    const districtIndex = Number(event.detail.value || 0);
    const option = this.data.districtOptions[districtIndex] || this.data.districtOptions[0];
    this.applyFilters({ districtIndex, district: option.value, districtLabel: option.value ? option.label : "行政区" });
  },
  regulatoryChange(event) {
    const regulatoryIndex = Number(event.detail.value || 0);
    const option = this.data.regulatoryOptions[regulatoryIndex] || this.data.regulatoryOptions[0];
    this.applyFilters({ regulatoryIndex, regulatoryType: option.value, regulatoryLabel: option.value ? option.label : "备案类型" });
  },
  choosePriceType() {
    wx.showActionSheet({
      itemList: this.data.priceTypeOptions.map((item) => item.label),
      success: ({ tapIndex }) => {
        const option = this.data.priceTypeOptions[tapIndex] || this.data.priceTypeOptions[0];
        this.applyFilters({ priceType: option.value, priceTypeLabel: option.value ? option.label : "价格类型" });
      },
    });
  },
  chooseSort() {
    wx.showActionSheet({
      itemList: sortLabels,
      success: ({ tapIndex }) => {
        const sort = sortValues[tapIndex] || "recommended";
        this.applyFilters({ sort, sortLabel: sortLabels[tapIndex] || sortLabels[0] });
      },
    });
  },
  clearFilters() {
    this.applyFilters({
      queryText: "", q: "", applicationMode: "initial", licenseClassCode: "",
      district: "", districtIndex: 0, districtLabel: "行政区",
      regulatoryType: "", regulatoryIndex: 0, regulatoryLabel: "备案类型",
      priceType: "", priceTypeLabel: "价格类型",
      sort: "recommended", sortLabel: "综合推荐",
      quickClassItems: quickClasses(this.data.meta, "initial"),
      classGroups: classesForMode(this.data.meta, "initial"),
    });
  },
  retry() { void this.bootstrap(); },
  openDetail(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (id) wx.navigateTo({ url: `/packages/driving-school/pages/detail/detail?id=${encodeURIComponent(id)}&licenseClassCode=${encodeURIComponent(this.data.licenseClassCode)}&applicationMode=${encodeURIComponent(this.data.applicationMode)}` });
  },
  imageError(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    const item = this.data.items[index];
    if (item) this.setData({ [`items[${index}].coverImage`]: item.coverFallback } as unknown as Partial<Data>);
  },
  noop() {},
  selectedClassName() { return licenseClassName(this.data.meta, this.data.licenseClassCode); },
});
