import type {
  DrivingSchoolApplicationMode,
  DrivingSchoolLicenseClassGroup,
  DrivingSchoolLicenseClassOption,
  DrivingSchoolMeta,
  DrivingSchoolTrainingClass,
} from "../../types";

export const DRIVING_SCHOOL_COVERS = {
  car: "/packages/driving-school/assets/c-class.jpg",
  large: "/packages/driving-school/assets/large-vehicle.jpg",
  motorcycle: "/packages/driving-school/assets/motorcycle.jpg",
} as const;

const BOTH: DrivingSchoolApplicationMode[] = ["initial", "upgrade"];
const UPGRADE: DrivingSchoolApplicationMode[] = ["upgrade"];

function license(code: string, name: string, group: string, supportedApplicationModes = BOTH, conditions: string[] = []): DrivingSchoolLicenseClassOption {
  return {
    code,
    name,
    group,
    vehicleScope: name,
    initialAllowed: supportedApplicationModes.includes("initial"),
    upgradeAllowed: supportedApplicationModes.includes("upgrade"),
    supportedApplicationModes,
    conditions,
  };
}

export const FALLBACK_DRIVING_SCHOOL_META: DrivingSchoolMeta = {
  licenseClassGroups: [
    {
      id: "ab",
      label: "A / B 大中型车辆",
      items: [
        license("A1", "大型客车", "ab", UPGRADE, ["仅支持增驾，需满足相应驾龄与记分周期条件"]),
        license("A2", "重型牵引挂车", "ab", UPGRADE, ["仅支持增驾，需满足相应驾龄与记分周期条件"]),
        license("A3", "城市公交车", "ab"),
        license("B1", "中型客车", "ab", UPGRADE, ["仅支持增驾，需满足相应驾龄与记分周期条件"]),
        license("B2", "大型货车", "ab"),
      ],
    },
    {
      id: "c",
      label: "C 小型及低速车辆",
      items: [
        license("C1", "小型汽车", "c"),
        license("C2", "小型自动挡汽车", "c"),
        license("C3", "低速载货汽车", "c"),
        license("C4", "三轮汽车", "c"),
        license("C5", "残疾人专用小型自动挡载客汽车", "c"),
        license("C6", "轻型牵引挂车", "c", UPGRADE, ["仅可增驾；取得 C1 或 C2 驾驶资格满一年，且最近一个记分周期内没有记满 12 分记录"]),
      ],
    },
    {
      id: "def",
      label: "D / E / F 摩托车",
      items: [
        license("D", "普通三轮摩托车", "def"),
        license("E", "普通二轮摩托车", "def"),
        license("F", "轻便摩托车", "def"),
      ],
    },
    {
      id: "mnp",
      label: "M / N / P 专用车辆",
      items: [
        license("M", "轮式专用机械车", "mnp"),
        license("N", "无轨电车", "mnp"),
        license("P", "有轨电车", "mnp"),
      ],
    },
  ],
  applicationModes: [
    { value: "initial", label: "初次申领", description: "首次申领机动车驾驶证" },
    { value: "upgrade", label: "增驾", description: "已有驾驶证，申请增加准驾车型" },
  ],
  districts: [],
  regulatoryTypes: [
    { value: "filing", label: "已备案", description: "可展示备案来源和最近核验时间" },
    { value: "legacy_license", label: "存量许可", description: "沿用既有许可记录，需关注有效期" },
  ],
  priceTypes: [
    { value: "fixed", label: "固定价" },
    { value: "starting_from", label: "起步价" },
    { value: "range", label: "价格区间" },
    { value: "inquiry", label: "咨询报价" },
  ],
  capabilityLevels: [
    { value: "level_1", label: "车型覆盖 1 级", description: "按已维护的准驾车型数量分级，不代表教学质量" },
    { value: "level_2", label: "车型覆盖 2 级", description: "按已维护的准驾车型数量分级，不代表教学质量" },
    { value: "level_3", label: "车型覆盖 3 级", description: "按已维护的准驾车型数量分级，不代表教学质量" },
  ],
  sortOptions: [
    { value: "recommended", label: "综合推荐" },
    { value: "price_asc", label: "价格从低到高" },
    { value: "updated", label: "报价最近更新" },
  ],
  trainingCapabilityNotice: "培训能力等级仅按已维护的准驾车型数量分级，不代表教学质量、通过率或推荐排名。",
};

export function classesForMode(meta: DrivingSchoolMeta, mode: DrivingSchoolApplicationMode): DrivingSchoolLicenseClassGroup[] {
  return meta.licenseClassGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.supportedApplicationModes.length || item.supportedApplicationModes.includes(mode)),
    }))
    .filter((group) => group.items.length > 0);
}

export function normalizeDrivingSchoolListEntryOptions(
  meta: DrivingSchoolMeta,
  options: { q?: unknown; licenseClassCode?: unknown; applicationMode?: unknown },
): { q: string; licenseClassCode: string; applicationMode: DrivingSchoolApplicationMode } {
  const q = String(options.q || "").trim().slice(0, 100);
  const applicationMode: DrivingSchoolApplicationMode = String(options.applicationMode || "").trim() === "upgrade" ? "upgrade" : "initial";
  const requestedCode = String(options.licenseClassCode || "").trim().toUpperCase();
  const licenseClassCode = classesForMode(meta, applicationMode)
    .some((group) => group.items.some((item) => item.code === requestedCode))
    ? requestedCode
    : "";
  return { q, licenseClassCode, applicationMode };
}

export function quickClasses(meta: DrivingSchoolMeta, mode: DrivingSchoolApplicationMode): DrivingSchoolLicenseClassOption[] {
  const preferred = mode === "initial"
    ? ["C1", "C2", "C5", "B2", "A3", "D"]
    : ["C1", "C2", "C6", "B2", "A2", "A1"];
  const available = classesForMode(meta, mode).flatMap((group) => group.items);
  const byCode = new Map(available.map((item) => [item.code, item]));
  return preferred.map((code) => byCode.get(code)).filter((item): item is DrivingSchoolLicenseClassOption => Boolean(item));
}

export function licenseClassName(meta: DrivingSchoolMeta, code: string): string {
  return meta.licenseClassGroups.flatMap((group) => group.items).find((item) => item.code === code)?.name || code;
}

export function applicationModeLabel(mode: DrivingSchoolApplicationMode): string {
  return mode === "upgrade" ? "增驾" : "初次申领";
}

export function drivingSchoolCoverKind(classes: Array<Pick<DrivingSchoolTrainingClass, "licenseClassCode">>, hint = ""): keyof typeof DRIVING_SCHOOL_COVERS {
  const normalized = hint.toLowerCase();
  if (/motor|moto|motorcycle|摩托|(^|[-_])(d|e|f)([-_]|$)/.test(normalized)) return "motorcycle";
  if (/large|truck|bus|大型|货车|客车/.test(normalized)) return "large";
  const codes = classes.map((item) => String(item.licenseClassCode || "").toUpperCase());
  if (codes.some((code) => ["D", "E", "F"].includes(code))) return "motorcycle";
  if (codes.some((code) => /^[AB]/.test(code))) return "large";
  return "car";
}

export function localDrivingSchoolCover(classes: Array<Pick<DrivingSchoolTrainingClass, "licenseClassCode">>, hint = ""): string {
  return DRIVING_SCHOOL_COVERS[drivingSchoolCoverKind(classes, hint)];
}

export function resolveDrivingSchoolCover(input: {
  coverImage?: string | null;
  dataKind?: string;
  isDemo?: boolean;
  id?: string;
  trainingClasses?: Array<Pick<DrivingSchoolTrainingClass, "licenseClassCode">>;
}): string {
  const classes = input.trainingClasses || [];
  const hint = `${input.id || ""} ${input.coverImage || ""}`;
  if (input.isDemo || input.dataKind === "demo" || input.dataKind === "synthetic_demo") {
    return localDrivingSchoolCover(classes, hint);
  }
  const raw = String(input.coverImage || "").trim();
  if (!raw) return localDrivingSchoolCover(classes, hint);
  const basename = raw.split(/[\\/]/).pop()?.toLowerCase() || "";
  if (basename === "c-class.webp") return DRIVING_SCHOOL_COVERS.car;
  if (basename === "large-vehicle.webp") return DRIVING_SCHOOL_COVERS.large;
  if (basename === "motorcycle.webp") return DRIVING_SCHOOL_COVERS.motorcycle;
  return raw;
}

export function fenText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  const amount = Math.max(0, Number(value)) / 100;
  return amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2);
}

export function offerPriceText(minPriceFen: number | null, maxPriceFen: number | null): string {
  const min = fenText(minPriceFen);
  const max = fenText(maxPriceFen);
  if (!min && !max) return "价格待维护";
  if (min && max && min !== max) return `¥${min}–${max}`;
  return `¥${min || max}`;
}

export function shortDate(value?: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10) || "--";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dateTimeText(value?: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return `${shortDate(value)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function errorKind(error: unknown): "offline" | "not_found" | "error" {
  const candidate = error as { statusCode?: number; message?: string };
  if (candidate?.statusCode === 404) return "not_found";
  const message = String(candidate?.message || "");
  if (!candidate?.statusCode || /网络|连接|offline|timeout|timed out|request:fail/i.test(message)) return "offline";
  return "error";
}
