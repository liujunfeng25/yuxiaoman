export type InspectionDeclarationAnswer = "yes" | "no" | "unknown";

export type InspectionVehicleClass = "small_micro_passenger" | "other" | "unknown";

export type InspectionUsageNature = "non_operational" | "operational" | "unknown";

export type InspectionCalculationSource = "vehicle" | "temporary";

export type InspectionAction = "claim_mark" | "onsite_inspection" | "official_verification";

export type InspectionWindowStatus = "not_open" | "open" | "overdue" | "manual_review";

export type InspectionPowertrainType =
  | "gasoline"
  | "diesel"
  | "hybrid"
  | "pure_electric"
  | "phev"
  | "erev"
  | "other"
  | "unknown";

/** `hev` is accepted at the boundary and normalized to the canonical `hybrid`. */
export type InspectionPowertrainInput = InspectionPowertrainType | "hev";

export type InspectionFactSource =
  | "vehicle_profile"
  | "plate_inferred"
  | "temporary_input"
  | "unknown"
  | "conflict";

export type InspectionOnsiteCheckCode =
  | "safety_basic"
  | "safety_chassis_extended"
  | "emissions_gasoline"
  | "emissions_diesel"
  | "new_energy_safety"
  | "reinspection";

export type InspectionValiditySource =
  | "traffic_12123"
  | "electronic_driving_license"
  | "paper_driving_license";

export type InspectionValidityInput =
  | { mode: "unconfirmed" }
  | {
      mode: "confirmed";
      validThroughMonth: string;
      source: InspectionValiditySource;
      confirmedAt?: string | null;
    };

export type InspectionDeclarations = {
  isVan: InspectionDeclarationAnswer;
  hasInjuryAccident: InspectionDeclarationAnswer;
  hasIllegalModificationPenalty: InspectionDeclarationAnswer;
  convertedFromOperational: InspectionDeclarationAnswer;
  delayedFirstRegistrationOver4Years: InspectionDeclarationAnswer;
};

export type InspectionVehicleFacts = {
  registrationMonth: string;
  vehicleClass: InspectionVehicleClass;
  usageNature: InspectionUsageNature;
  seats: number | null;
  /** Existing clients may omit this; omitted/invalid values safely become `unknown`. */
  powertrainType?: InspectionPowertrainInput | null;
  powertrainSource?: InspectionFactSource;
  /**
   * A vehicle profile may already contain a trusted van classification. The
   * public temporary-calculation payload does not need to provide this field.
   */
  knownIsVan?: boolean | null;
};

export type InspectionCalculationInput = {
  source: InspectionCalculationSource;
  asOfDate: string;
  vehicle: InspectionVehicleFacts;
  declarations: InspectionDeclarations;
  inspectionValidity?: InspectionValidityInput | null;
};

export type InspectionReason = {
  code: string;
  label: string;
  detail: string;
};

export type InspectionPolicySource = {
  id: string;
  title: string;
  issuer: string;
  url: string;
  topics: string[];
  effectiveFrom?: string;
};

export type InspectionPolicy = {
  id: string;
  version: string;
  effectiveFrom: string;
  reviewedAt: string;
  sources: InspectionPolicySource[];
};

export type InspectionApplicationWindow = {
  start: string;
  end: string;
};

export type InspectionEvidenceFact = {
  code: string;
  label: string;
  value: string;
  source: InspectionFactSource;
};

export type InspectionEvidenceStep = {
  id: "scope" | "cycle" | "due_date" | "window" | "current_status";
  title: string;
  expression: string;
  result: string;
  sourceIds: string[];
};

export type InspectionPowertrainImpact = {
  powertrainType: InspectionPowertrainType;
  affectsCycle: false;
  status: "applicable" | "not_applicable_this_cycle" | "needs_verification";
  expectedOnsiteCheckCodes: InspectionOnsiteCheckCode[];
  explanation: string;
  sourceIds: string[];
};

export type InspectionEvidence = {
  normalizedFacts: InspectionEvidenceFact[];
  steps: InspectionEvidenceStep[];
  assumptions: string[];
  powertrainImpact: InspectionPowertrainImpact;
};

export type InspectionDateConfirmation = {
  validThroughMonth: string;
  validThroughDate: string;
  source: InspectionValiditySource;
  confirmedAt: string | null;
};

export type InspectionDateEvidence = {
  estimate: { dueDate: string; basis: "policy_estimate" } | null;
  confirmation: InspectionDateConfirmation | null;
  comparison: "not_provided" | "matched" | "note" | "conflict" | "not_comparable";
  decisionBasis: "policy_estimate" | "matched_confirmation" | "confirmed_priority" | "official_verification";
  explanation: string;
};

export type InspectionCalculationResult = {
  source: InspectionCalculationSource;
  action: InspectionAction;
  windowStatus: InspectionWindowStatus;
  estimatedDueDate: string | null;
  applicationWindow: InspectionApplicationWindow | null;
  cycleYear: number | null;
  canBookInspection: boolean;
  title: string;
  summary: string;
  reasons: InspectionReason[];
  manualReviewReasons: string[];
  evidence: InspectionEvidence;
  dateEvidence: InspectionDateEvidence;
  policy: InspectionPolicy;
  disclaimer: string;
};

export const INSPECTION_POLICY: InspectionPolicy = {
  id: "cn-small-micro-passenger-inspection-2022",
  version: "2022-10-01.v2",
  effectiveFrom: "2022-10-01",
  reviewedAt: "2026-08-16",
  sources: [
    {
      id: "joint_reform_2022",
      title: "四部门：关于深化机动车检验制度改革优化车检服务工作的意见",
      issuer: "公安部、市场监管总局、生态环境部、交通运输部",
      url: "https://www.mee.gov.cn/xxgk2018/xxgk/xxgk10/202209/t20220920_994430.html",
      topics: ["automatic_scope", "inspection_cycle", "exception_conditions", "emissions_cycle"],
      effectiveFrom: "2022-10-01",
    },
    {
      id: "shenzhen_cycle_guidance",
      title: "深圳公安交警：机动车检验周期说明",
      issuer: "深圳市公安局交通警察局",
      url: "https://szjj.sz.gov.cn/gkmlpt/content/12/12681/mpost_12681296.html",
      topics: ["inspection_cycle", "current_guidance"],
    },
    {
      id: "tianjin_accident_guidance",
      title: "天津公安：发生伤亡事故车辆不适用免检说明",
      issuer: "天津市公安局",
      url: "https://ga.tj.gov.cn/jmhd/wdk/bswd/202410/t20241016_6754419.html",
      topics: ["exception_conditions", "injury_accident"],
    },
    {
      id: "natural_month_window_guidance",
      title: "北京市房山区：机动车可提前三个月办理检验说明",
      issuer: "北京市房山区人民政府",
      url: "https://www.bjfsh.gov.cn/zsk/bswd/202305/t20230524_40062216.shtml?type=computer",
      topics: ["application_window", "natural_month"],
    },
    {
      id: "pure_electric_emissions_exemption",
      title: "生态环境部：纯电动车免于尾气排放检验说明",
      issuer: "中华人民共和国生态环境部",
      url: "https://www.mee.gov.cn/gkml/sthjbgw/qt/201608/t20160811_362209.htm",
      topics: ["pure_electric", "emissions_exemption", "inspection_cycle"],
    },
    {
      id: "gb_18285_2018",
      title: "GB 18285—2018 汽油车污染物排放限值及测量方法",
      issuer: "中华人民共和国生态环境部",
      url: "https://www.mee.gov.cn/ywgz/fgbz/bz/bzwb/dqhjbh/dqydywrwpfbz/201811/W020220119602775423286.pdf",
      topics: ["gasoline_emissions", "hybrid", "obd"],
      effectiveFrom: "2019-05-01",
    },
    {
      id: "gbt_44500_2024",
      title: "GB/T 44500—2024 新能源汽车运行安全性能检验规程",
      issuer: "国家市场监督管理总局、国家标准化管理委员会",
      url: "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=60BFB6458BCB28653791362BBAFC3FB8",
      topics: ["new_energy_safety", "pure_electric", "phev", "erev", "recommended_standard"],
      effectiveFrom: "2025-03-01",
    },
    {
      id: "mee_obd_guidance_2025",
      title: "生态环境部：机动车排放检验OBD相关问题答复",
      issuer: "中华人民共和国生态环境部",
      url: "https://www.mee.gov.cn/hdjl/cjwt/202509/t20250915_1130198.shtml",
      topics: ["onsite_items", "emissions", "obd"],
    },
  ],
};

export const INSPECTION_DISCLAIMER =
  "本结果依据公开规则进行政策测算，不是政务实时查询，也不代表车辆历史检验已办状态；真实“检验有效期止”及办理要求请以交管12123、行驶证和交管部门为准。";

export const INSPECTION_SCOPE_SUMMARY =
  "当前自动测算适用于9座及以下非营运小微型载客汽车（面包车除外）。其他车辆的检验周期还受使用性质、车型及登记历史影响，请通过交管12123或专属客服核验。";

export const INSPECTION_EVIDENCE_ASSUMPTIONS = [
  "规则估算基于当前填写事实，并假设历史应检均已按期办理；车辆真实检验记录以交管12123为准。",
  "动力类型不改变本规则适用车辆的检验周期，只影响需要上线时的预计检验项目。",
];

const isoDatePattern = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const yearMonthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const conditionalInspectionItems = new Set<string>([
  "emissions_gasoline",
  "emissions_diesel",
  "new_energy_safety",
]);
const defaultInspectionItems: InspectionOnsiteCheckCode[] = [
  "safety_basic",
  "emissions_gasoline",
  "emissions_diesel",
  "new_energy_safety",
];

function parseYearMonth(value: string, fieldName = "registrationMonth"): { year: number; month: number } {
  if (!yearMonthPattern.test(value)) {
    throw new RangeError(`${fieldName} must use YYYY-MM`);
  }
  const [year, month] = value.split("-").map(Number);
  return { year, month };
}

function parseIsoDate(value: string): { year: number; month: number; day: number } {
  if (!isoDatePattern.test(value)) throw new RangeError("asOfDate must use YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new RangeError("asOfDate must be a real calendar date");
  }
  return { year, month, day };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMonth(year: number, month: number): string {
  return `${year}-${pad(month)}`;
}

function formatChineseMonth(yearMonth: string): string {
  const { year, month } = parseYearMonth(yearMonth, "yearMonth");
  return `${year}年${month}月`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthEndDate(yearMonth: string, fieldName = "validThroughMonth"): string {
  const parsed = parseYearMonth(yearMonth, fieldName);
  return `${yearMonth}-${pad(lastDayOfMonth(parsed.year, parsed.month))}`;
}

function subtractMonths(year: number, month: number, amount: number): { year: number; month: number } {
  const zeroBased = year * 12 + month - 1 - amount;
  return {
    year: Math.floor(zeroBased / 12),
    month: ((zeroBased % 12) + 12) % 12 + 1,
  };
}

/** Returns the official natural-month window: the due month and the two preceding calendar months. */
export function inspectionApplicationWindow(dueMonth: string): InspectionApplicationWindow {
  const due = parseYearMonth(dueMonth, "dueMonth");
  const start = subtractMonths(due.year, due.month, 2);
  return {
    start: `${formatMonth(start.year, start.month)}-01`,
    end: monthEndDate(dueMonth, "dueMonth"),
  };
}

export function normalizeInspectionPowertrainType(
  value: string | null | undefined,
): InspectionPowertrainType {
  if (value === "hev") return "hybrid";
  if (
    value === "gasoline"
    || value === "diesel"
    || value === "hybrid"
    || value === "pure_electric"
    || value === "phev"
    || value === "erev"
    || value === "other"
    || value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

export function expectedOnsiteChecksForPowertrain(
  powertrainType: InspectionPowertrainInput | string | null | undefined,
): InspectionOnsiteCheckCode[];
export function expectedOnsiteChecksForPowertrain<T extends string>(
  powertrainType: InspectionPowertrainInput | string | null | undefined,
  availableItems: readonly T[],
): T[];
export function expectedOnsiteChecksForPowertrain(
  powertrainType: InspectionPowertrainInput | string | null | undefined,
  availableItems: readonly string[] = defaultInspectionItems,
): string[] {
  const normalized = normalizeInspectionPowertrainType(powertrainType);
  const enabledConditionalItems = new Set<string>();
  if (normalized === "gasoline" || normalized === "hybrid" || normalized === "phev" || normalized === "erev") {
    enabledConditionalItems.add("emissions_gasoline");
  }
  if (normalized === "diesel") enabledConditionalItems.add("emissions_diesel");
  if (normalized === "pure_electric" || normalized === "phev" || normalized === "erev") {
    enabledConditionalItems.add("new_energy_safety");
  }
  return availableItems.filter(
    (item) => !conditionalInspectionItems.has(item) || enabledConditionalItems.has(item),
  );
}

function nextCycleYear(elapsedCalendarYears: number): number {
  if (elapsedCalendarYears <= 2) return 2;
  if (elapsedCalendarYears <= 4) return 4;
  if (elapsedCalendarYears <= 6) return 6;
  if (elapsedCalendarYears <= 8) return 8;
  if (elapsedCalendarYears <= 10) return 10;
  return elapsedCalendarYears;
}

/** 检测站视角：仅第 6、10 年及 10 年后每年需要上线。 */
function nextOnsiteCycleYear(elapsedCalendarYears: number): number {
  if (elapsedCalendarYears <= 6) return 6;
  if (elapsedCalendarYears <= 10) return 10;
  return elapsedCalendarYears;
}

function isClaimMarkCycleYear(cycleYear: number): boolean {
  return cycleYear === 2 || cycleYear === 4 || cycleYear === 8;
}

type OutstandingOnsiteObligation = {
  missedCycleYear: number;
  missedDueDate: string;
  missedWindow: InspectionApplicationWindow;
  graceEnds: string;
};

function listOnsiteCycleYears(elapsedCalendarYears: number): number[] {
  const years = [6, 10];
  if (elapsedCalendarYears > 10) {
    for (let year = 11; year <= elapsedCalendarYears; year += 1) years.push(year);
  }
  return years;
}

function nextOnsiteCycleYearAfter(cycleYear: number): number {
  if (cycleYear < 6) return 6;
  if (cycleYear < 10) return 10;
  return cycleYear + 1;
}

/** 检测站视角：某上线节点窗口已结束，且仍在下一上线节点窗口结束前，视为仍可来站办理。 */
function outstandingOnsiteObligation(
  registration: { year: number; month: number },
  asOfDate: string,
  elapsedCalendarYears: number,
): OutstandingOnsiteObligation | null {
  if (elapsedCalendarYears < 6) return null;

  const onsiteYears = listOnsiteCycleYears(Math.max(elapsedCalendarYears, 10));
  for (let index = onsiteYears.length - 1; index >= 0; index -= 1) {
    const cycleYear = onsiteYears[index];
    const dueMonth = formatMonth(registration.year + cycleYear, registration.month);
    const missedWindow = inspectionApplicationWindow(dueMonth);
    if (asOfDate <= missedWindow.end) continue;

    const nextCycleYear = nextOnsiteCycleYearAfter(cycleYear);
    const nextDueMonth = formatMonth(registration.year + nextCycleYear, registration.month);
    const nextWindow = inspectionApplicationWindow(nextDueMonth);
    if (asOfDate <= nextWindow.end) {
      return {
        missedCycleYear: cycleYear,
        missedDueDate: missedWindow.end,
        missedWindow,
        graceEnds: nextWindow.end,
      };
    }
  }
  return null;
}

function windowStatusFor(asOfDate: string, applicationWindow: InspectionApplicationWindow): Exclude<InspectionWindowStatus, "manual_review"> {
  if (asOfDate < applicationWindow.start) return "not_open";
  if (asOfDate <= applicationWindow.end) return "open";
  return "overdue";
}

function declarationDetail(
  answer: InspectionDeclarationAnswer,
  yesDetail: string,
  unknownDetail: string,
): string | null {
  if (answer === "yes") return yesDetail;
  if (answer === "unknown") return unknownDetail;
  return null;
}

function defaultFactSource(input: InspectionCalculationInput): InspectionFactSource {
  return input.source === "vehicle" ? "vehicle_profile" : "temporary_input";
}

function powertrainLabel(powertrainType: InspectionPowertrainType): string {
  return {
    gasoline: "汽油车",
    diesel: "柴油车",
    hybrid: "油电混合（非插电）",
    pure_electric: "纯电动车",
    phev: "插电式混合动力车",
    erev: "增程式电动车",
    other: "其他动力类型",
    unknown: "动力类型不清楚",
  }[powertrainType];
}

function normalizedFacts(input: InspectionCalculationInput): InspectionEvidenceFact[] {
  const source = defaultFactSource(input);
  const powertrainType = normalizeInspectionPowertrainType(input.vehicle.powertrainType);
  const powertrainSource = input.vehicle.powertrainSource
    ?? (input.vehicle.powertrainType ? source : "unknown");
  return [
    { code: "registration_month", label: "注册月份", value: input.vehicle.registrationMonth, source },
    {
      code: "vehicle_class",
      label: "车辆类型",
      value: input.vehicle.vehicleClass === "small_micro_passenger"
        ? "小微型载客汽车"
        : input.vehicle.vehicleClass === "other" ? "其他车型" : "不清楚",
      source,
    },
    {
      code: "usage_nature",
      label: "使用性质",
      value: input.vehicle.usageNature === "non_operational"
        ? "非营运"
        : input.vehicle.usageNature === "operational" ? "营运" : "不清楚",
      source,
    },
    {
      code: "seats",
      label: "核定载人数",
      value: input.vehicle.seats === null ? "不清楚" : `${input.vehicle.seats}座`,
      source,
    },
    {
      code: "van_status",
      label: "面包车",
      value: input.vehicle.knownIsVan === true || input.declarations.isVan === "yes"
        ? "是"
        : input.declarations.isVan === "unknown" ? "不清楚" : "否",
      source: input.vehicle.knownIsVan !== undefined && input.vehicle.knownIsVan !== null
        ? "vehicle_profile"
        : source,
    },
    {
      code: "special_conditions",
      label: "其他特殊情况",
      value: Object.values(input.declarations).every((answer) => answer === "no")
        ? "5项均为否"
        : "存在是或不清楚",
      source,
    },
    {
      code: "powertrain_type",
      label: "动力类型",
      value: powertrainSource === "unknown" && powertrainType !== "unknown"
        ? `${powertrainLabel(powertrainType)}（待确认）`
        : powertrainLabel(powertrainType),
      source: powertrainSource,
    },
  ];
}

function buildDateConfirmation(input: InspectionCalculationInput): InspectionDateConfirmation | null {
  if (!input.inspectionValidity || input.inspectionValidity.mode === "unconfirmed") return null;
  return {
    validThroughMonth: input.inspectionValidity.validThroughMonth,
    validThroughDate: monthEndDate(input.inspectionValidity.validThroughMonth),
    source: input.inspectionValidity.source,
    confirmedAt: input.inspectionValidity.confirmedAt ?? null,
  };
}

function dateSourceLabel(source: InspectionValiditySource): string {
  return {
    traffic_12123: "交管12123",
    electronic_driving_license: "电子行驶证",
    paper_driving_license: "纸质行驶证",
  }[source];
}

function buildDateEvidence(
  estimatedDueDate: string | null,
  confirmation: InspectionDateConfirmation | null,
  requiresOfficialVerification: boolean,
  options: { softDifference?: boolean; claimMarkDueDate?: string | null } = {},
): InspectionDateEvidence {
  if (!estimatedDueDate) {
    return {
      estimate: null,
      confirmation,
      comparison: confirmation ? "not_comparable" : "not_provided",
      decisionBasis: "official_verification",
      explanation: confirmation
        ? `已记录用户根据${dateSourceLabel(confirmation.source)}确认的有效期，但适用周期无法自动判断，请人工核验。`
        : "适用范围尚待核验，当前不能生成规则估算日期。",
    };
  }
  if (!confirmation) {
    return {
      estimate: { dueDate: estimatedDueDate, basis: "policy_estimate" },
      confirmation: null,
      comparison: "not_provided",
      decisionBasis: requiresOfficialVerification ? "official_verification" : "policy_estimate",
      explanation: requiresOfficialVerification
        ? "当前仅有公开规则估算，且结果需要先通过交管12123或交管部门核验。"
        : "当前按公开规则估算的是上线节点；预约或办理前请核对交管12123显示的真实检验有效期。",
    };
  }
  const matched = estimatedDueDate.slice(0, 7) === confirmation.validThroughMonth;
  if (matched) {
    return {
      estimate: { dueDate: estimatedDueDate, basis: "policy_estimate" },
      confirmation,
      comparison: "matched",
      decisionBasis: requiresOfficialVerification ? "official_verification" : "matched_confirmation",
      explanation: requiresOfficialVerification
        ? `规则估算月份与用户根据${dateSourceLabel(confirmation.source)}确认的有效期月份一致，但当前状态仍需先完成官方核验。`
        : `规则估算月份与用户根据${dateSourceLabel(confirmation.source)}确认的有效期月份一致。`,
    };
  }
  if (options.softDifference) {
    const claimHint = options.claimMarkDueDate
      ? `交管另有申领节点（约 ${options.claimMarkDueDate}），`
      : "";
    return {
      estimate: { dueDate: estimatedDueDate, basis: "policy_estimate" },
      confirmation,
      comparison: "note",
      decisionBasis: "confirmed_priority",
      explanation: `${claimHint}本站以上线检测为准，已优先采用用户根据${dateSourceLabel(confirmation.source)}确认的有效期 ${confirmation.validThroughDate}。`,
    };
  }
  return {
    estimate: { dueDate: estimatedDueDate, basis: "policy_estimate" },
    confirmation,
    comparison: "conflict",
    decisionBasis: "official_verification",
    explanation: `规则估算月份与用户根据${dateSourceLabel(confirmation.source)}确认的月份不一致，可能受登记或历史办理情况影响，请先核验。`,
  };
}

function buildPowertrainImpact(
  input: InspectionCalculationInput,
  scheduledAction: Exclude<InspectionAction, "official_verification"> | null,
): InspectionPowertrainImpact {
  const powertrainType = normalizeInspectionPowertrainType(input.vehicle.powertrainType);
  const evidenceUncertain = powertrainType === "other"
    || powertrainType === "unknown"
    || input.vehicle.powertrainSource === "unknown"
    || input.vehicle.powertrainSource === "conflict";
  const sourceIds = powertrainType === "pure_electric"
    ? ["pure_electric_emissions_exemption", "gbt_44500_2024"]
    : powertrainType === "phev" || powertrainType === "erev"
      ? ["gb_18285_2018", "gbt_44500_2024", "mee_obd_guidance_2025"]
      : powertrainType === "gasoline" || powertrainType === "hybrid"
        ? ["gb_18285_2018", "mee_obd_guidance_2025"]
        : powertrainType === "diesel"
          ? ["mee_obd_guidance_2025"]
          : ["joint_reform_2022"];

  let explanation: string;
  if (scheduledAction === "claim_mark") {
    explanation = `你的车是${powertrainLabel(powertrainType)}。动力类型不改变检验周期；本轮无需上线，因此不会增加本轮检验项目。`;
  } else if (powertrainType === "gasoline") {
    explanation = "动力类型不改变检验周期；需要上线时，预计包含安全技术检验，以及适用的汽油排放和OBD检查。";
  } else if (powertrainType === "diesel") {
    explanation = "动力类型不改变检验周期；需要上线时，预计包含安全技术检验，以及适用的柴油排放和OBD检查。";
  } else if (powertrainType === "hybrid") {
    explanation = "油电混合（非插电）仍有发动机。动力类型不改变检验周期；需要上线时仍预计包含适用的汽油排放和OBD检查。";
  } else if (powertrainType === "pure_electric") {
    explanation = "纯电动车免尾气排放检验不等于免年检。周期不变；需要上线时预计包含基础安全及新能源运行安全项目，具体以检测站实际执行口径为准。";
  } else if (powertrainType === "phev" || powertrainType === "erev") {
    explanation = "动力类型不改变检验周期；需要上线时预计涉及发动机排放、OBD及新能源运行安全项目，具体以检测站实际执行口径为准。";
  } else {
    explanation = "动力类型不改变已测算的检验周期；当前动力类型未能准确识别，具体上线项目需由检测站确认。";
  }
  if (scheduledAction !== "claim_mark" && input.vehicle.powertrainSource === "conflict") {
    explanation = "车辆档案与号牌推断的动力类型不一致。动力类型不改变检验周期；预计项目仅供参考，具体上线项目需由检测站确认。";
  } else if (
    scheduledAction !== "claim_mark"
    && input.vehicle.powertrainSource === "unknown"
    && powertrainType !== "unknown"
  ) {
    explanation = `车辆档案未明确动力类型，当前暂按${powertrainLabel(powertrainType)}估计。检验周期不受影响，具体上线项目需由检测站确认。`;
  }

  return {
    powertrainType,
    affectsCycle: false,
    status: scheduledAction === "claim_mark"
      ? "not_applicable_this_cycle"
      : scheduledAction === null
        || evidenceUncertain
        ? "needs_verification"
        : "applicable",
    expectedOnsiteCheckCodes: scheduledAction === null || scheduledAction === "claim_mark" || evidenceUncertain
      ? []
      : expectedOnsiteChecksForPowertrain(powertrainType),
    explanation,
    sourceIds,
  };
}

function buildManualEvidence(
  input: InspectionCalculationInput,
  reasons: InspectionReason[],
): InspectionEvidence {
  return {
    normalizedFacts: normalizedFacts(input),
    steps: [{
      id: "scope",
      title: "适用范围核验",
      expression: "车型 ∩ 座位 ∩ 使用性质 ∩ 面包车属性 ∩ 特殊情况",
      result: `存在${reasons.length}项需要核验：${reasons.map((reason) => reason.label).join("、")}`,
      sourceIds: ["joint_reform_2022", "shenzhen_cycle_guidance", "tianjin_accident_guidance"],
    }],
    assumptions: [...INSPECTION_EVIDENCE_ASSUMPTIONS],
    powertrainImpact: buildPowertrainImpact(input, null),
  };
}

function cycleExpression(registrationMonth: string, cycleYear: number, dueMonth: string): string {
  if (cycleYear === 2 || cycleYear === 4 || cycleYear === 8) {
    return `${registrationMonth} + 第${cycleYear}年 = ${dueMonth}；第${cycleYear}年 ∈ 申领标志节点 {2年、4年、8年}`;
  }
  if (cycleYear > 10) {
    return `${registrationMonth} + 第${cycleYear}年 = ${dueMonth}；超过10年后每年上线检验`;
  }
  return `${registrationMonth} + 第${cycleYear}年 = ${dueMonth}；第${cycleYear}年 ∈ 上线节点 {6年、10年}`;
}

function currentStatusEvidence(
  asOfDate: string,
  scheduledAction: Exclude<InspectionAction, "official_verification">,
  windowStatus: Exclude<InspectionWindowStatus, "manual_review">,
  applicationWindow: InspectionApplicationWindow,
  dateConflict: boolean,
): Pick<InspectionEvidenceStep, "expression" | "result"> {
  if (dateConflict) {
    return {
      expression: "规则估算有效期月份 ≠ 用户确认有效期月份",
      result: "两类日期不一致 → 需要交管或人工核验",
    };
  }
  if (windowStatus === "not_open") {
    return {
      expression: `今天${asOfDate}早于窗口首日${applicationWindow.start}`,
      result: scheduledAction === "claim_mark"
        ? "办理窗口尚未开始，本轮无需上线"
        : "办理窗口尚未开始，暂不可预约",
    };
  }
  if (windowStatus === "overdue") {
    return {
      expression: `今天${asOfDate}晚于窗口末日${applicationWindow.end}`,
      result: scheduledAction === "claim_mark"
        ? "申领窗口已过 → 通常无需来站，请先查12123"
        : "办理窗口已过 → 仍可预约上线检验",
    };
  }
  return {
    expression: `今天${asOfDate}位于${applicationWindow.start}至${applicationWindow.end}内`,
    result: scheduledAction === "claim_mark"
      ? "可通过交管12123申领检验标志，无需上线"
      : "可以预约上线检验",
  };
}

function buildCalculatedEvidence(
  input: InspectionCalculationInput,
  cycleYear: number,
  dueMonth: string,
  estimatedDueDate: string,
  applicationWindow: InspectionApplicationWindow,
  scheduledAction: Exclude<InspectionAction, "official_verification">,
  windowStatus: Exclude<InspectionWindowStatus, "manual_review">,
  dateConflict: boolean,
): InspectionEvidence {
  const statusEvidence = currentStatusEvidence(
    input.asOfDate,
    scheduledAction,
    windowStatus,
    applicationWindow,
    dateConflict,
  );
  return {
    normalizedFacts: normalizedFacts(input),
    steps: [
      {
        id: "scope",
        title: "适用范围",
        expression: `${input.vehicle.seats}座 ∩ 非营运 ∩ 小微型载客汽车 ∩ 非面包车 ∩ 5项特殊情况均为否`,
        result: "符合自动测算范围",
        sourceIds: ["joint_reform_2022", "shenzhen_cycle_guidance", "tianjin_accident_guidance"],
      },
      {
        id: "cycle",
        title: "周期节点",
        expression: cycleExpression(input.vehicle.registrationMonth, cycleYear, dueMonth),
        result: scheduledAction === "claim_mark" ? "本轮申领检验标志，无需上线" : "本轮需要上线检验",
        sourceIds: ["joint_reform_2022", "shenzhen_cycle_guidance"],
      },
      {
        id: "due_date",
        title: "有效期估算",
        expression: `${formatChineseMonth(dueMonth)}最后一天 = ${estimatedDueDate}`,
        result: `规则估算有效期止为${estimatedDueDate}`,
        sourceIds: ["natural_month_window_guidance"],
      },
      {
        id: "window",
        title: "办理窗口",
        expression: `到期月前2个自然月起 = ${applicationWindow.start} 至 ${applicationWindow.end}`,
        result: `预计可办理区间为${applicationWindow.start}至${applicationWindow.end}`,
        sourceIds: ["natural_month_window_guidance"],
      },
      {
        id: "current_status",
        title: "当前结论",
        expression: statusEvidence.expression,
        result: statusEvidence.result,
        sourceIds: ["natural_month_window_guidance"],
      },
    ],
    assumptions: [...INSPECTION_EVIDENCE_ASSUMPTIONS],
    powertrainImpact: buildPowertrainImpact(input, scheduledAction),
  };
}

function manualReviewResult(
  input: InspectionCalculationInput,
  reasons: InspectionReason[],
  confirmation: InspectionDateConfirmation | null,
): InspectionCalculationResult {
  return {
    source: input.source,
    action: "official_verification",
    windowStatus: "manual_review",
    estimatedDueDate: null,
    applicationWindow: null,
    cycleYear: null,
    canBookInspection: false,
    title: "需要交管或人工核验",
    summary: INSPECTION_SCOPE_SUMMARY,
    reasons,
    manualReviewReasons: reasons.map((reason) => reason.detail),
    evidence: buildManualEvidence(input, reasons),
    dateEvidence: buildDateEvidence(null, confirmation, true),
    policy: INSPECTION_POLICY,
    disclaimer: INSPECTION_DISCLAIMER,
  };
}

/**
 * Calculates a policy estimate without reading clocks, databases, or external
 * services. `asOfDate` must be the caller's Shanghai business date.
 */
export function calculateInspection(input: InspectionCalculationInput): InspectionCalculationResult {
  const registration = parseYearMonth(input.vehicle.registrationMonth);
  const asOf = parseIsoDate(input.asOfDate);
  const confirmation = buildDateConfirmation(input);
  if (input.vehicle.registrationMonth > input.asOfDate.slice(0, 7)) {
    throw new RangeError("registrationMonth cannot be in the future");
  }
  if (input.vehicle.seats !== null && (!Number.isInteger(input.vehicle.seats) || input.vehicle.seats < 1)) {
    throw new RangeError("seats must be a positive integer or null");
  }

  const manualReasons: InspectionReason[] = [];
  const addManualReason = (code: string, label: string, detail: string) => {
    manualReasons.push({ code, label, detail });
  };

  if (input.vehicle.vehicleClass === "other") {
    addManualReason("vehicle_class_out_of_scope", "车型超出自动测算范围", "车辆并非9座及以下小微型载客汽车，需核验适用的检验周期。");
  } else if (input.vehicle.vehicleClass === "unknown") {
    addManualReason("vehicle_class_unknown", "车型尚未确认", "车辆类型尚未确认，无法安全套用小微型载客汽车检验周期。");
  }

  if (input.vehicle.usageNature === "operational") {
    addManualReason("operational_vehicle", "营运车辆需单独核验", "营运车辆不在本次自动测算范围，请以交管部门登记信息为准。");
  } else if (input.vehicle.usageNature === "unknown") {
    addManualReason("usage_nature_unknown", "使用性质尚未确认", "车辆使用性质尚未确认，无法判断是否适用非营运车辆周期。");
  }

  if (input.vehicle.seats === null) {
    addManualReason("seats_unknown", "核定载人数尚未确认", "请先核实行驶证上的核定载人数。");
  } else if (input.vehicle.seats > 9) {
    addManualReason("seats_out_of_scope", "核定载人数超出范围", "10座及以上车辆不在本次自动测算范围。");
  }

  if (input.vehicle.knownIsVan === true) {
    addManualReason("vehicle_profile_is_van", "车辆档案标记为面包车", "面包车不适用本次自动测算规则，请通过交管12123或人工核验。");
  }

  const declarationRules: Array<{
    key: keyof InspectionDeclarations;
    label: string;
    yesCode: string;
    unknownCode: string;
    yesDetail: string;
    unknownDetail: string;
  }> = [
    {
      key: "isVan",
      label: "面包车属性影响免检",
      yesCode: "declared_is_van",
      unknownCode: "van_status_unknown",
      yesDetail: "申报车辆属于面包车，不适用本次自动测算规则。",
      unknownDetail: "是否属于面包车尚未确认，请先核实行驶证车型或咨询交管部门。",
    },
    {
      key: "hasInjuryAccident",
      label: "伤亡事故记录影响免检",
      yesCode: "injury_accident",
      unknownCode: "injury_accident_unknown",
      yesDetail: "车辆曾发生造成人员伤亡的交通事故，免检规则可能不适用。",
      unknownDetail: "是否发生过造成人员伤亡的交通事故尚未确认。",
    },
    {
      key: "hasIllegalModificationPenalty",
      label: "非法改装处罚记录影响免检",
      yesCode: "illegal_modification_penalty",
      unknownCode: "illegal_modification_penalty_unknown",
      yesDetail: "车辆曾因非法改装被依法处罚，免检规则可能不适用。",
      unknownDetail: "是否存在非法改装处罚记录尚未确认。",
    },
    {
      key: "convertedFromOperational",
      label: "营转非历史需核验",
      yesCode: "converted_from_operational",
      unknownCode: "converted_from_operational_unknown",
      yesDetail: "车辆曾由营运转为非营运，检验周期需按登记历史核验。",
      unknownDetail: "车辆是否曾由营运转为非营运尚未确认。",
    },
    {
      key: "delayedFirstRegistrationOver4Years",
      label: "延迟注册历史需核验",
      yesCode: "delayed_first_registration",
      unknownCode: "delayed_first_registration_unknown",
      yesDetail: "车辆自出厂超过4年才首次注册，检验周期需由交管部门核验。",
      unknownDetail: "车辆是否自出厂超过4年才首次注册尚未确认。",
    },
  ];

  for (const rule of declarationRules) {
    const answer = input.declarations[rule.key];
    const detail = declarationDetail(answer, rule.yesDetail, rule.unknownDetail);
    if (detail) addManualReason(answer === "yes" ? rule.yesCode : rule.unknownCode, rule.label, detail);
  }

  if (manualReasons.length > 0) return manualReviewResult(input, manualReasons, confirmation);

  const elapsedCalendarYears = asOf.year - registration.year;
  const trafficCycleYear = nextCycleYear(elapsedCalendarYears);
  const trafficDueMonth = formatMonth(registration.year + trafficCycleYear, registration.month);
  const trafficWindow = inspectionApplicationWindow(trafficDueMonth);
  const trafficDueDate = trafficWindow.end;
  const trafficScheduledAction: Exclude<InspectionAction, "official_verification"> =
    isClaimMarkCycleYear(trafficCycleYear) ? "claim_mark" : "onsite_inspection";
  const trafficWindowStatus = windowStatusFor(input.asOfDate, trafficWindow);

  const onsiteCycleYear = nextOnsiteCycleYear(elapsedCalendarYears);
  const onsiteDueMonth = formatMonth(registration.year + onsiteCycleYear, registration.month);
  const onsiteWindow = inspectionApplicationWindow(onsiteDueMonth);
  const onsiteDueDate = onsiteWindow.end;

  const confirmationExpired = Boolean(confirmation && confirmation.validThroughDate < input.asOfDate);
  const confirmationBeforeRegistration = Boolean(
    confirmation && confirmation.validThroughMonth < input.vehicle.registrationMonth,
  );
  const hardConflict = confirmationBeforeRegistration;

  // 检测站决策日：有用户确认则用确认月末；否则用下一上线节点。
  const stationDueDate = confirmation && !hardConflict ? confirmation.validThroughDate : onsiteDueDate;
  const stationDueMonth = stationDueDate.slice(0, 7);
  const stationWindow = inspectionApplicationWindow(stationDueMonth);
  const stationWindowStatus = windowStatusFor(input.asOfDate, stationWindow);

  const softDifference = Boolean(
    confirmation
    && !hardConflict
    && onsiteDueDate.slice(0, 7) !== confirmation.validThroughMonth,
  );

  const dateEvidence = buildDateEvidence(
    onsiteDueDate,
    confirmation,
    confirmationExpired || hardConflict,
    {
      softDifference,
      claimMarkDueDate: trafficScheduledAction === "claim_mark" ? trafficDueDate : null,
    },
  );

  const cycleYear = confirmation && !hardConflict ? onsiteCycleYear : trafficCycleYear;
  const scheduledAction: Exclude<InspectionAction, "official_verification"> =
    confirmation && !hardConflict
      ? "onsite_inspection"
      : trafficScheduledAction;
  let applicationWindow = confirmation && !hardConflict ? stationWindow : (
    trafficScheduledAction === "onsite_inspection" ? onsiteWindow : trafficWindow
  );
  let estimatedDueDate = confirmation && !hardConflict ? stationDueDate : (
    trafficScheduledAction === "onsite_inspection" ? onsiteDueDate : (
      // 未确认且当前交管节点是申领：站视角仍展示下一上线日，避免首页误报申领逾期。
      trafficScheduledAction === "claim_mark" ? onsiteDueDate : trafficDueDate
    )
  );

  let calculatedWindowStatus: Exclude<InspectionWindowStatus, "manual_review"> =
    confirmation && !hardConflict ? stationWindowStatus : (
      trafficScheduledAction === "claim_mark"
        ? (stationWindowStatus === "open" ? "open" : stationWindowStatus === "overdue" ? "overdue" : "not_open")
        : trafficWindowStatus
    );
  // 未确认 + 申领年：站视角窗口用上线节点，不把申领过期当成上线逾期。
  if (!confirmation && trafficScheduledAction === "claim_mark") {
    calculatedWindowStatus = stationWindowStatus;
  }

  const outstanding = outstandingOnsiteObligation(registration, input.asOfDate, elapsedCalendarYears);

  let calculatedAction: InspectionAction = scheduledAction;
  if (hardConflict || confirmationExpired) {
    calculatedAction = "official_verification";
  } else if (!confirmation && trafficScheduledAction === "claim_mark" && !outstanding) {
    calculatedAction = "claim_mark";
  }

  if (outstanding && !hardConflict && !confirmationExpired) {
    calculatedAction = "onsite_inspection";
    calculatedWindowStatus = "overdue";
    if (!confirmation) {
      estimatedDueDate = outstanding.missedDueDate;
      applicationWindow = outstanding.missedWindow;
    }
  }

  const hasHardBlock = hardConflict || (dateEvidence.comparison === "conflict");

  const cycleDetail = scheduledAction === "claim_mark" || (!confirmation && trafficScheduledAction === "claim_mark")
    ? `注册后第${trafficCycleYear}年预计申领检验标志，无需上线检验；检测站下一上线节点约为第${onsiteCycleYear}年（${onsiteDueDate}）。`
    : onsiteCycleYear > 10
      ? `注册超过10年后，本轮为第${onsiteCycleYear}年，预计需要每年上线检验。`
      : `注册后第${onsiteCycleYear}年预计需要上线检验。`;
  const reasons: InspectionReason[] = [
    {
      code: "supported_vehicle_scope",
      label: "符合自动测算范围",
      detail: "车辆为9座及以下非营运小微型载客汽车，且已排除面包车及已申报的特殊情况。",
    },
    { code: `cycle_year_${onsiteCycleYear}`, label: "命中检验周期规则", detail: cycleDetail },
  ];

  let title: string;
  let summary: string;
  if (hardConflict && confirmation) {
    title = "有效期信息不一致，请先核验";
    summary = `用户确认的有效期早于登记月份，请核对交管12123或行驶证后重试。`;
    reasons.push({
      code: "inspection_validity_conflict",
      label: "有效期信息不一致",
      detail: summary,
    });
  } else if (confirmationExpired && confirmation) {
    title = "确认的检验有效期已过";
    summary = `您根据${dateSourceLabel(confirmation.source)}确认的有效期止为${confirmation.validThroughDate}，现已超过该日期；请先通过交管12123核验真实状态后再决定是否预约上线。`;
    reasons.push({
      code: "confirmed_validity_expired",
      label: "确认有效期已过",
      detail: summary,
    });
  } else if (outstanding) {
    title = `第${outstanding.missedCycleYear}年上线窗口已过，仍可预约检测站`;
    summary = `预计第${outstanding.missedCycleYear}年办理窗口已于${outstanding.missedWindow.end}结束；错过窗口期仍可前来检测站办理上线检验。`;
    reasons.push({
      code: "outstanding_onsite_obligation",
      label: "仍有上线检验待办理",
      detail: `在下一上线节点（第${nextOnsiteCycleYearAfter(outstanding.missedCycleYear)}年）办理窗口结束前，检测站均可受理预约。`,
    });
  } else if (!confirmation && trafficScheduledAction === "claim_mark") {
    if (trafficWindowStatus === "not_open") {
      title = "当前无需来站上线";
      summary = `预计第${trafficCycleYear}年申领检验标志窗口将于${trafficWindow.start}开启；检测站首次上线约在${onsiteDueDate}。`;
    } else if (trafficWindowStatus === "open") {
      title = "申领检验标志，无需上线";
      summary = `预计可在${trafficDueDate}前通过交管12123申领检验标志，无需前往检测站。首次上线约在${onsiteDueDate}。`;
    } else {
      title = `第${trafficCycleYear}年申领窗口已过，通常无需来站`;
      summary = `交管申领窗口已于${trafficDueDate}结束，这通常不需要上线检测。请先在交管12123查看真实有效期；检测站首次上线约在${onsiteDueDate}。`;
    }
    reasons.push({
      code: trafficWindowStatus === "overdue" ? "claim_mark_window_passed" : "claim_mark_not_onsite",
      label: trafficWindowStatus === "overdue" ? "申领窗口已过" : "本轮无需上线",
      detail: `交管节点第${trafficCycleYear}年为申领标志；检测站上线节点为第${onsiteCycleYear}年。`,
    });
  } else if (calculatedWindowStatus === "not_open") {
    title = "当前无需来站上线";
    summary = confirmation
      ? `按您确认的有效期止 ${stationDueDate}，上线办理窗口将于${stationWindow.start}开启。`
      : `预计本轮需要上线检验，办理窗口将于${applicationWindow.start}开启。`;
    reasons.push({
      code: "application_window_not_open",
      label: "尚未进入上线办理窗口",
      detail: `预计上线办理窗口为${applicationWindow.start}至${applicationWindow.end}。`,
    });
  } else if (calculatedWindowStatus === "open") {
    title = "需要上线检验";
    summary = confirmation
      ? `已进入上线办理窗口（至${stationDueDate}），可预约检测站办理。`
      : `预计已进入上线检验办理窗口，请在${applicationWindow.end}前核验真实有效期并预约办理。`;
    reasons.push({
      code: "application_window_open",
      label: "已进入上线办理窗口",
      detail: `预计办理窗口为${applicationWindow.start}至${applicationWindow.end}。`,
    });
  } else {
    title = "办理窗口已过，仍可预约上线检验";
    summary = `预计办理窗口已于${applicationWindow.end}结束；错过窗口期仍可前来检测站办理上线检验。`;
    reasons.push({
      code: "application_window_overdue",
      label: "办理窗口已过 · 仍可预约",
      detail: `预计办理窗口已于${applicationWindow.end}结束，检测站仍可受理上线检验预约。`,
    });
  }

  if (softDifference && confirmation && !hardConflict && !confirmationExpired) {
    reasons.push({
      code: "inspection_validity_note",
      label: "确认日期优先",
      detail: dateEvidence.explanation,
    });
  } else if (
    confirmation
    && !hardConflict
    && !confirmationExpired
    && trafficScheduledAction === "claim_mark"
    && trafficDueDate.slice(0, 7) !== confirmation.validThroughMonth
  ) {
    reasons.push({
      code: "claim_mark_node_note",
      label: "交管另有申领节点",
      detail: `交管可能另有申领节点（约 ${trafficDueDate}），以12123为准；本站按您确认的有效期安排上线。`,
    });
  }

  const canBookInspection = !hasHardBlock
    && !confirmationExpired
    && calculatedAction === "onsite_inspection"
    && (outstanding != null || calculatedWindowStatus === "open" || calculatedWindowStatus === "overdue");

  const evidenceScheduledAction: Exclude<InspectionAction, "official_verification"> =
    outstanding || (confirmation && !hardConflict)
      ? "onsite_inspection"
      : trafficScheduledAction === "claim_mark"
        ? "claim_mark"
        : "onsite_inspection";
  const evidenceApplicationWindow = outstanding && !confirmation
    ? outstanding.missedWindow
    : confirmation && !hardConflict
      ? stationWindow
      : onsiteWindow;

  return {
    source: input.source,
    action: hasHardBlock ? "official_verification" : calculatedAction,
    windowStatus: hasHardBlock ? "manual_review" : (
      // 申领年未确认：对站展示 not_open/open/overdue 基于上线窗口；overdue 仅当上线窗过了
      calculatedWindowStatus
    ),
    estimatedDueDate,
    applicationWindow: outstanding && !confirmation
      ? outstanding.missedWindow
      : confirmation && !hardConflict
        ? stationWindow
        : trafficScheduledAction === "claim_mark"
          ? onsiteWindow
          : applicationWindow,
    cycleYear: outstanding?.missedCycleYear ?? onsiteCycleYear,
    canBookInspection,
    title,
    summary,
    reasons,
    manualReviewReasons: hasHardBlock || confirmationExpired
      ? [reasons.at(-1)?.detail ?? dateEvidence.explanation]
      : [],
    evidence: buildCalculatedEvidence(
      input,
      outstanding?.missedCycleYear ?? onsiteCycleYear,
      outstanding ? formatMonth(registration.year + outstanding.missedCycleYear, registration.month) : onsiteDueMonth,
      outstanding?.missedDueDate ?? onsiteDueDate,
      evidenceApplicationWindow,
      evidenceScheduledAction,
      calculatedWindowStatus,
      hasHardBlock,
    ),
    dateEvidence,
    policy: INSPECTION_POLICY,
    disclaimer: INSPECTION_DISCLAIMER,
  };
}
