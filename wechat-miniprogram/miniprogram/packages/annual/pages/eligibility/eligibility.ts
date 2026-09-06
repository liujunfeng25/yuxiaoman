import { api } from "../../../../services/api";
import type {
  InspectionCalculation,
  InspectionCalculationRequest,
  InspectionDeclarationAnswer,
  InspectionDeclarationKey,
  InspectionDeclarations,
  InspectionPowertrainType,
  InspectionUsageNature,
  InspectionValiditySource,
  InspectionVehicleClass,
  ServiceMode,
  Vehicle,
} from "../../../../types";

type QueryMode = "vehicle" | "temporary";
type SpecialCaseMode = "all_no" | "detail" | "";
type ResultTone = "success" | "info" | "warning" | "review";
type DeclarationQuestion = {
  key: InspectionDeclarationKey;
  shortLabel: string;
  label: string;
  help: string;
  value: InspectionDeclarationAnswer;
};
type EvidenceStepView = NonNullable<InspectionCalculation["evidence"]>["steps"][number] & { sourceText: string };
type DateEvidenceView = {
  tone: "estimate" | "matched" | "note" | "conflict" | "review";
  label: string;
  primary: string;
  secondary: string;
  source: string;
} | null;
type ChoiceOption<T extends string> = { value: T; label: string };

type Data = {
  mode: QueryMode;
  requestedVehicleId: string;
  requestedServiceMode: ServiceMode | null;
  returnTo: "" | "inspection_booking";
  vehicles: Vehicle[];
  selectedId: string;
  selectedVehicle: Vehicle | null;
  selectedVehicleImage: string;
  selectedVehicleName: string;
  selectedVehicleDetail: string;
  loadingVehicles: boolean;
  calculating: boolean;
  questions: DeclarationQuestion[];
  specialCaseMode: SpecialCaseMode;
  selectedVehicleIsDemo: boolean;
  registrationMonth: string;
  maxRegistrationMonth: string;
  vehicleClass: InspectionVehicleClass;
  usageNature: InspectionUsageNature;
  seatOptions: string[];
  seatIndex: number;
  powertrainOptions: Array<ChoiceOption<InspectionPowertrainType>>;
  powertrainIndex: number;
  validitySources: Array<ChoiceOption<InspectionValiditySource>>;
  validitySourceIndex: number;
  validitySourceSelected: boolean;
  validThroughMonth: string;
  showDateCompare: boolean;
  showEnergyComparison: boolean;
  result: InspectionCalculation | null;
  resultTone: ResultTone;
  cycleYearLabel: string;
  evidenceTitle: string;
  evidenceSteps: EvidenceStepView[];
  impactCheckLabels: string[];
  dateEvidenceView: DateEvidenceView;
  resultBadge: string;
  visitLayer: string;
  basisLayer: string;
  selectedPowertrainLabel: string;
  selectedValidityLabel: string;
  impactPowertrainLabel: string;
  errorMessage: string;
};

const questionDefinitions: Array<Omit<DeclarationQuestion, "value">> = [
  { key: "isVan", shortLabel: "面包车属性", label: "是否属于面包车", help: "以行驶证车辆类型及车身结构为准" },
  { key: "hasInjuryAccident", shortLabel: "人员伤亡事故", label: "是否发生过造成人员伤亡的交通事故", help: "只需判断是否涉及人员受伤或死亡" },
  { key: "hasIllegalModificationPenalty", shortLabel: "非法改装处罚", label: "是否因非法改装被依法处罚", help: "包括改变车身、动力或核定结构等处罚记录" },
  { key: "convertedFromOperational", shortLabel: "营运转非营运", label: "是否曾由营运转为非营运", help: "车辆历史用途会影响检验周期" },
  { key: "delayedFirstRegistrationOver4Years", shortLabel: "出厂超4年后注册", label: "是否出厂超过 4 年才首次注册", help: "可通过车辆合格证与首次登记日期核对" },
];

const seatOptions = ["不清楚", ...Array.from({ length: 18 }, (_, index) => `${index + 2} 座`), "20 座以上"];
const powertrainOptions: Array<ChoiceOption<InspectionPowertrainType>> = [
  { value: "unknown", label: "不清楚" },
  { value: "gasoline", label: "汽油" },
  { value: "diesel", label: "柴油" },
  { value: "hybrid", label: "油电混合（非插电）" },
  { value: "pure_electric", label: "纯电" },
  { value: "phev", label: "插电混动" },
  { value: "erev", label: "增程" },
  { value: "other", label: "其他能源" },
];
const validitySources: Array<ChoiceOption<InspectionValiditySource>> = [
  { value: "traffic_12123", label: "交管12123" },
  { value: "electronic_driving_license", label: "电子行驶证" },
  { value: "paper_driving_license", label: "纸质行驶证" },
];
const inspectionItemLabels: Record<string, string> = {
  safety_basic: "基础安全技术检验",
  safety_chassis_extended: "底盘安全扩展项目",
  emissions_gasoline: "汽油排放及适用的 OBD 项目",
  emissions_diesel: "柴油排放及适用的 OBD 项目",
  new_energy_safety: "新能源运行安全项目",
  reinspection: "复检项目",
};
const sourceLabels: Record<InspectionValiditySource, string> = {
  traffic_12123: "交管12123",
  electronic_driving_license: "电子行驶证",
  paper_driving_license: "纸质行驶证",
};
const powertrainLabels: Record<InspectionPowertrainType, string> = {
  gasoline: "汽油",
  diesel: "柴油",
  hybrid: "油电混合（非插电）",
  pure_electric: "纯电",
  phev: "插电混动",
  erev: "增程",
  other: "其他能源",
  unknown: "不清楚",
};

function vehiclePresentation(vehicle: Vehicle | null) {
  return {
    selectedVehicleImage: vehicle?.visual?.imageUrl || "",
    selectedVehicleName: vehicle?.brand && vehicle.model ? `${vehicle.brand.name} ${vehicle.model.name}` : vehicle?.vehicleType || "车辆档案",
    selectedVehicleDetail: vehicle ? `${vehicle.vehicleType} · ${vehicle.usageNature} · ${vehicle.seats}座${vehicle.exteriorColor ? ` · ${vehicle.exteriorColor}` : ""}` : "",
  };
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function validitySourceLabel(source: string): string {
  return sourceLabels[source as InspectionValiditySource] || "所选凭证";
}

function confirmationCopy(confirmation: NonNullable<InspectionCalculation["dateEvidence"]["confirmation"]>): string {
  const confirmedOn = confirmation.confirmedAt ? confirmation.confirmedAt.slice(0, 10) : "";
  return confirmedOn
    ? `用户于${confirmedOn}根据${validitySourceLabel(confirmation.source)}确认`
    : `用户根据${validitySourceLabel(confirmation.source)}确认`;
}

function vehiclePowertrainLabel(vehicle: Vehicle | null): string {
  if (!vehicle?.powertrainType) return "动力待补充";
  const label = powertrainLabels[vehicle.powertrainType] || "动力待核验";
  const source = vehicle.facts?.powertrainSource;
  if (source === "conflict") return "动力信息冲突 · 待核验";
  if (vehicle.powertrainType === "unknown") {
    return vehicle.energyCategory === "non_pure_electric" ? "非纯电新能源（具体动力待确认）" : "动力待确认";
  }
  if (source === "unknown") return `${label}（待确认）`;
  if (source === "plate_inferred" && vehicle.energyCategory === "non_pure_electric") return "非纯电新能源（具体动力待确认）";
  if (source === "plate_inferred") return `${label}（车牌识别）`;
  return label;
}

function vehicleValidityLabel(vehicle: Vehicle | null): string {
  const validity = vehicle?.inspectionValidity;
  if (!validity || validity.mode !== "confirmed") return "尚未由用户核对";
  const confirmedOn = validity.confirmedAt ? validity.confirmedAt.slice(0, 10) : "";
  return confirmedOn
    ? `用户于${confirmedOn}根据${validitySourceLabel(validity.source)}确认 · ${validity.validThroughMonth}`
    : `用户根据${validitySourceLabel(validity.source)}确认 · ${validity.validThroughMonth}`;
}

function vehicleFingerprint(vehicle: Vehicle | null): string {
  if (!vehicle) return "";
  const validity = vehicle.inspectionValidity;
  return [
    vehicle.id,
    vehicle.registrationDate,
    vehicle.vehicleType,
    vehicle.usageNature,
    vehicle.seats,
    vehicle.powertrainType || "",
    vehicle.facts?.powertrainSource || "",
    validity?.mode || "",
    validity?.mode === "confirmed" ? validity.validThroughMonth : "",
    validity?.mode === "confirmed" ? validity.source : "",
  ].join("|");
}

function makeQuestions(answer: InspectionDeclarationAnswer = "unknown"): DeclarationQuestion[] {
  return questionDefinitions.map((item) => ({ ...item, value: answer }));
}

function isDemoVehicle(vehicle: Vehicle | null): boolean {
  return Boolean(vehicle && (/MVP/i.test(vehicle.plateNumber) || /demo/i.test(vehicle.id)));
}

function declarationsFrom(questions: DeclarationQuestion[]): InspectionDeclarations {
  return questions.reduce((result, item) => {
    result[item.key] = item.value;
    return result;
  }, {} as InspectionDeclarations);
}

function toneFor(result: InspectionCalculation): ResultTone {
  if (result.windowStatus === "overdue") return "warning";
  if (result.windowStatus === "manual_review" || result.action === "official_verification") return "review";
  if (result.windowStatus === "open") return "success";
  return "info";
}

function resultBadge(result: InspectionCalculation): string {
  if (result.reasons.some((item) => item.code === "outstanding_onsite_obligation")) {
    return "仍有上线待办理 · 可预约";
  }
  if (result.action === "claim_mark") {
    if (result.reasons.some((item) => item.code === "claim_mark_window_passed")) return "申领窗口已过";
    if (result.windowStatus === "open" || result.reasons.some((item) => item.code === "claim_mark_not_onsite")) {
      return result.title.includes("申领检验标志") ? "可申领检验标志 · 无需来站" : "当前无需来站";
    }
    return "当前无需来站";
  }
  if (result.windowStatus === "overdue") {
    return result.action === "onsite_inspection" && result.canBookInspection
      ? "办理窗口已过 · 仍可预约"
      : "办理窗口已过";
  }
  if (result.windowStatus === "manual_review" || result.action === "official_verification") return "需要官方核验";
  if (result.windowStatus === "not_open") return "距上线窗口还早 · 无需来站";
  if (result.action === "onsite_inspection" && result.canBookInspection) return "需要上线 · 可预约";
  if (result.action === "onsite_inspection") return "需要上线检验";
  return "按建议继续办理";
}

function resultView(result: InspectionCalculation) {
  const sourceById = new Map(result.policy.sources.map((source) => [source.id, source.title]));
  const evidenceSteps = (result.evidence?.steps || []).map((step) => ({
    ...step,
    sourceText: step.sourceIds.map((id) => sourceById.get(id)).filter(Boolean).join(" · ") || "公开政策规则",
  }));
  const impactCheckLabels = (result.evidence?.powertrainImpact.expectedOnsiteCheckCodes || [])
    .map((code) => inspectionItemLabels[code] || code);
  const dateEvidence = result.dateEvidence;
  let dateEvidenceView: DateEvidenceView = null;
  if (dateEvidence) {
    if (dateEvidence.comparison === "conflict") {
      dateEvidenceView = {
        tone: "conflict",
        label: "日期待核验",
        primary: `用户确认 ${dateEvidence.confirmation!.validThroughDate}`,
        secondary: `规则估算 ${dateEvidence.estimate?.dueDate || "无法自动测算"}`,
        source: `${confirmationCopy(dateEvidence.confirmation!)}。${dateEvidence.explanation}`,
      };
    } else if (dateEvidence.comparison === "note") {
      dateEvidenceView = {
        tone: "note",
        label: "确认日期优先 · 软提示",
        primary: `本站按确认有效期 ${dateEvidence.confirmation!.validThroughDate}`,
        secondary: `规则上线估算 ${dateEvidence.estimate?.dueDate || "无法自动测算"}`,
        source: dateEvidence.explanation,
      };
    } else if (dateEvidence.comparison === "matched") {
      dateEvidenceView = {
        tone: "matched",
        label: "确认日期与上线估算一致",
        primary: dateEvidence.confirmation!.validThroughDate,
        secondary: confirmationCopy(dateEvidence.confirmation!),
        source: dateEvidence.explanation,
      };
    } else if (dateEvidence.estimate) {
      dateEvidenceView = {
        tone: "estimate",
        label: "预计上线节点（规则估算）",
        primary: dateEvidence.estimate.dueDate,
        secondary: "尚未核对交管12123真实记录 · 当前通常按是否需来站判断",
        source: dateEvidence.explanation,
      };
    } else if (dateEvidence.confirmation) {
      dateEvidenceView = {
        tone: "review",
        label: "已记录确认日期，办理方式仍需核验",
        primary: dateEvidence.confirmation.validThroughDate,
        secondary: confirmationCopy(dateEvidence.confirmation),
        source: dateEvidence.explanation,
      };
    }
  }
  const visitLayer = result.action === "onsite_inspection" && (result.windowStatus === "open" || result.windowStatus === "overdue")
    ? "需要来站上线"
    : result.action === "official_verification" || result.windowStatus === "manual_review"
      ? "请先官方核验"
      : "当前无需来站";
  const basisLayer = dateEvidence?.confirmation
    ? `依据：您确认的有效期止 ${dateEvidence.confirmation.validThroughDate}`
    : dateEvidence?.estimate
      ? `依据：预计上线约 ${dateEvidence.estimate.dueDate}`
      : "依据：暂无法自动估算";
  return {
    evidenceSteps,
    impactCheckLabels,
    dateEvidenceView,
    resultBadge: resultBadge(result),
    visitLayer,
    basisLayer,
    impactPowertrainLabel: result.evidence.powertrainImpact.powertrainType === "unknown"
      ? "动力待确认"
      : powertrainLabels[result.evidence.powertrainImpact.powertrainType] || "动力待核验",
    evidenceTitle: result.windowStatus === "manual_review" && evidenceSteps.length <= 1 ? "为什么无法自动测算" : "本次测算过程",
  };
}

let requestSequence = 0;

Page<Data>({
  data: {
    mode: "vehicle",
    requestedVehicleId: "",
    requestedServiceMode: null,
    returnTo: "",
    vehicles: [],
    selectedId: "",
    selectedVehicle: null,
    selectedVehicleImage: "/assets/brand/hero-car-generic.png",
    selectedVehicleName: "车辆档案",
    selectedVehicleDetail: "",
    loadingVehicles: true,
    calculating: false,
    questions: makeQuestions(),
    specialCaseMode: "",
    selectedVehicleIsDemo: false,
    registrationMonth: "",
    maxRegistrationMonth: currentMonth(),
    vehicleClass: "small_micro_passenger",
    usageNature: "non_operational",
    seatOptions,
    seatIndex: 4,
    powertrainOptions,
    powertrainIndex: 0,
    validitySources,
    validitySourceIndex: 0,
    validitySourceSelected: false,
    validThroughMonth: "",
    showDateCompare: false,
    showEnergyComparison: false,
    result: null,
    resultTone: "info",
    cycleYearLabel: "",
    evidenceTitle: "本次测算过程",
    evidenceSteps: [],
    impactCheckLabels: [],
    dateEvidenceView: null,
    resultBadge: "",
    visitLayer: "",
    basisLayer: "",
    selectedPowertrainLabel: "动力待补充",
    selectedValidityLabel: "尚未由用户核对",
    impactPowertrainLabel: "动力待核验",
    errorMessage: "",
  },
  onLoad(query) {
    const requestedServiceMode: ServiceMode | null = query.serviceMode === "valet"
      ? "valet"
      : query.serviceMode === "self_drive"
        ? "self_drive"
        : null;
    this.setData({
      requestedVehicleId: String(query.vehicleId || ""),
      requestedServiceMode,
      returnTo: query.returnTo === "inspection_booking" ? "inspection_booking" : "",
      ...(query.mode === "temporary" ? { mode: "temporary" as const, specialCaseMode: "" as const, questions: makeQuestions() } : {}),
    });
  },
  onShow() { void this.loadVehicles(); },
  onUnload() { requestSequence += 1; },
  async loadVehicles() {
    this.setData({ loadingVehicles: true });
    try {
      const vehicles = await api.vehicles();
      const preferredId = this.data.selectedId || this.data.requestedVehicleId;
      const selectedId = preferredId && vehicles.some((item) => item.id === preferredId)
        ? preferredId
        : (vehicles.find((item) => item.isDefault) || vehicles[0])?.id || "";
      const selectedVehicle = vehicles.find((item) => item.id === selectedId) || null;
      const selectionChanged = selectedId !== this.data.selectedId
        || vehicleFingerprint(selectedVehicle) !== vehicleFingerprint(this.data.selectedVehicle);
      const selectedVehicleIsDemo = isDemoVehicle(selectedVehicle);
      if (selectionChanged) requestSequence += 1;
      this.setData({
        vehicles,
        selectedId,
        selectedVehicle,
        ...vehiclePresentation(selectedVehicle),
        selectedVehicleIsDemo,
        specialCaseMode: selectionChanged ? (selectedVehicleIsDemo ? "all_no" : "") : this.data.specialCaseMode,
        questions: selectionChanged ? (selectedVehicleIsDemo ? makeQuestions("no") : makeQuestions()) : this.data.questions,
        selectedPowertrainLabel: vehiclePowertrainLabel(selectedVehicle),
        selectedValidityLabel: vehicleValidityLabel(selectedVehicle),
        result: selectionChanged && this.data.mode === "vehicle" ? null : this.data.result,
        errorMessage: "",
      });
    } catch (error) {
      this.setData({ errorMessage: error instanceof Error ? error.message : "读取车辆失败" });
    } finally {
      this.setData({ loadingVehicles: false });
    }
  },
  switchMode(event) {
    const mode = event.currentTarget.dataset.mode as QueryMode;
    if (mode === this.data.mode) return;
    requestSequence += 1;
    const selectedVehicleIsDemo = mode === "vehicle" && isDemoVehicle(this.data.selectedVehicle);
    this.setData({
      mode,
      selectedVehicleIsDemo,
      specialCaseMode: selectedVehicleIsDemo ? "all_no" : "",
      questions: selectedVehicleIsDemo ? makeQuestions("no") : makeQuestions(),
      result: null,
      errorMessage: "",
      calculating: false,
    });
  },
  chooseVehicle(event) {
    const selectedId = event.currentTarget.dataset.id as string;
    const selectedVehicle = this.data.vehicles.find((item) => item.id === selectedId) || null;
    requestSequence += 1;
    const selectedVehicleIsDemo = isDemoVehicle(selectedVehicle);
    this.setData({
      selectedId,
      selectedVehicle,
      ...vehiclePresentation(selectedVehicle),
      selectedVehicleIsDemo,
      specialCaseMode: selectedVehicleIsDemo ? "all_no" : "",
      questions: selectedVehicleIsDemo ? makeQuestions("no") : makeQuestions(),
      selectedPowertrainLabel: vehiclePowertrainLabel(selectedVehicle),
      selectedValidityLabel: vehicleValidityLabel(selectedVehicle),
      result: null,
      errorMessage: "",
      calculating: false,
    });
  },
  editSelectedVehicle() {
    if (!this.data.selectedVehicle) return;
    wx.navigateTo({ url: `/packages/vehicle/pages/vehicle-form/vehicle-form?id=${encodeURIComponent(this.data.selectedVehicle.id)}` });
  },
  selectedVehicleImageError() {
    if (this.data.selectedVehicleImage) {
      this.setData({ selectedVehicleImage: "" });
    }
  },
  registrationChange(event) {
    requestSequence += 1;
    this.setData({ registrationMonth: String(event.detail.value), result: null, errorMessage: "", calculating: false });
  },
  chooseVehicleClass(event) {
    requestSequence += 1;
    this.setData({ vehicleClass: event.currentTarget.dataset.value as InspectionVehicleClass, result: null, errorMessage: "", calculating: false });
  },
  chooseUsageNature(event) {
    requestSequence += 1;
    this.setData({ usageNature: event.currentTarget.dataset.value as InspectionUsageNature, result: null, errorMessage: "", calculating: false });
  },
  seatChange(event) {
    requestSequence += 1;
    this.setData({ seatIndex: Number(event.detail.value), result: null, errorMessage: "", calculating: false });
  },
  powertrainChange(event) {
    requestSequence += 1;
    this.setData({ powertrainIndex: Number(event.detail.value), result: null, errorMessage: "", calculating: false });
  },
  validityMonthChange(event) {
    this.setData({ validThroughMonth: String(event.detail.value) });
  },
  validitySourceChange(event) {
    if (!this.data.validThroughMonth) return;
    this.setData({ validitySourceIndex: Number(event.detail.value), validitySourceSelected: true });
  },
  toggleDateCompare() {
    this.setData({ showDateCompare: !this.data.showDateCompare });
  },
  toggleEnergyComparison() {
    this.setData({ showEnergyComparison: !this.data.showEnergyComparison });
  },
  chooseAnswer(event) {
    const key = event.currentTarget.dataset.key as InspectionDeclarationKey;
    const value = event.currentTarget.dataset.value as InspectionDeclarationAnswer;
    requestSequence += 1;
    this.setData({
      questions: this.data.questions.map((item) => item.key === key ? { ...item, value } : item),
      result: null,
      errorMessage: "",
      calculating: false,
    });
  },
  chooseSpecialCaseMode(event) {
    const specialCaseMode = event.currentTarget.dataset.mode as Exclude<SpecialCaseMode, "">;
    requestSequence += 1;
    this.setData({
      specialCaseMode,
      questions: specialCaseMode === "all_no" ? makeQuestions("no") : makeQuestions(),
      result: null,
      errorMessage: "",
      calculating: false,
    });
  },
  setAllNo() {
    requestSequence += 1;
    this.setData({ specialCaseMode: "all_no", questions: makeQuestions("no"), result: null, errorMessage: "", calculating: false });
  },
  async calculate() {
    await this.runCalculation(null);
  },
  async runCalculation(confirmedValidity: Extract<InspectionCalculationRequest, { source: "temporary" }>["inspectionValidity"] | null) {
    if (!this.data.specialCaseMode) {
      wx.showToast({ title: "请先确认特殊情况", icon: "none" });
      return;
    }
    let payload: InspectionCalculationRequest;
    const declarations = declarationsFrom(this.data.questions);
    if (this.data.mode === "vehicle") {
      if (!this.data.selectedId) {
        wx.showToast({ title: "请先选择或添加车辆", icon: "none" });
        return;
      }
      payload = { source: "vehicle", vehicleId: this.data.selectedId, declarations };
    } else {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(this.data.registrationMonth)) {
        wx.showToast({ title: "请选择车辆注册年月", icon: "none" });
        return;
      }
      if (this.data.registrationMonth > this.data.maxRegistrationMonth) {
        wx.showToast({ title: "注册年月不能晚于当前月份", icon: "none" });
        return;
      }
      const seats = this.data.seatIndex === 0 ? null : this.data.seatIndex === this.data.seatOptions.length - 1 ? 21 : this.data.seatIndex + 1;
      payload = {
        source: "temporary",
        vehicle: {
          registrationMonth: this.data.registrationMonth,
          vehicleClass: this.data.vehicleClass,
          usageNature: this.data.usageNature,
          seats,
          powertrainType: this.data.powertrainOptions[this.data.powertrainIndex].value,
        },
        declarations,
        inspectionValidity: confirmedValidity || { mode: "unconfirmed" },
      };
    }

    const sequence = ++requestSequence;
    this.setData({ calculating: true, result: null, errorMessage: "" });
    try {
      const result = await api.calculateInspection(payload);
      if (sequence !== requestSequence) return;
      this.setData({
        result,
        resultTone: toneFor(result),
        cycleYearLabel: result.cycleYear ? `车辆第 ${result.cycleYear} 年` : "需核验",
        ...resultView(result),
      }, () => (wx as unknown as { pageScrollTo(options: { scrollTop: number; duration: number }): void }).pageScrollTo({ scrollTop: 0, duration: 0 }));
    } catch (error) {
      if (sequence !== requestSequence) return;
      this.setData({ errorMessage: error instanceof Error ? error.message : "年检测算失败，请稍后重试" });
    } finally {
      if (sequence === requestSequence) this.setData({ calculating: false });
    }
  },
  editCalculation() {
    requestSequence += 1;
    this.setData({ result: null, errorMessage: "", calculating: false, showDateCompare: false, showEnergyComparison: false });
  },
  compareDate() {
    if (!this.data.validThroughMonth) {
      wx.showToast({ title: "请选择检验有效期月份", icon: "none" });
      return;
    }
    if (!this.data.validitySourceSelected) {
      wx.showToast({ title: "请选择看到日期的位置", icon: "none" });
      return;
    }
    void this.runCalculation({
      mode: "confirmed",
      validThroughMonth: this.data.validThroughMonth,
      source: this.data.validitySources[this.data.validitySourceIndex].value,
    });
  },
  continueUsingEstimate() {
    this.setData({
      validThroughMonth: "",
      validitySourceIndex: 0,
      validitySourceSelected: false,
      showDateCompare: false,
    });
    void this.runCalculation(null);
  },
  addVehicle(event) {
    const params: string[] = [];
    let continueToBooking = this.data.returnTo === "inspection_booking";
    if (this.data.mode === "temporary") {
      if (this.data.registrationMonth) params.push(`registrationMonth=${encodeURIComponent(this.data.registrationMonth)}`);
      if (this.data.seatIndex > 0) params.push(`seats=${encodeURIComponent(String(this.data.seatIndex === this.data.seatOptions.length - 1 ? 20 : this.data.seatIndex + 1))}`);
      const powertrainType = this.data.powertrainOptions[this.data.powertrainIndex]?.value;
      if (powertrainType && powertrainType !== "unknown") params.push(`powertrainType=${encodeURIComponent(powertrainType)}`);
      const confirmation = this.data.result?.dateEvidence.confirmation;
      if (confirmation) {
        params.push(`validThroughMonth=${encodeURIComponent(confirmation.validThroughMonth)}`);
        params.push(`validitySource=${encodeURIComponent(confirmation.source)}`);
      }
      continueToBooking = continueToBooking || (event?.currentTarget?.dataset?.next === "booking"
        && this.data.result?.canBookInspection === true
        && (this.data.result.dateEvidence.comparison === "matched"
          || this.data.result.dateEvidence.comparison === "note"));
    }
    if (continueToBooking) params.push("next=inspection_booking");
    if (this.data.requestedServiceMode) params.push(`serviceMode=${this.data.requestedServiceMode}`);
    if (this.data.returnTo) params.push(`returnTo=${this.data.returnTo}`);
    const query = params.length ? `?${params.join("&")}` : "";
    wx.navigateTo({ url: `/packages/vehicle/pages/vehicle-form/vehicle-form${query}` });
  },
  book() {
    const result = this.data.result;
    if (!result || this.data.mode !== "vehicle" || result.action !== "onsite_inspection" || !result.canBookInspection) {
      wx.showToast({ title: "当前结果暂不支持直接预约", icon: "none" });
      return;
    }
    const vehicleId = encodeURIComponent(this.data.selectedId);
    if (this.data.returnTo === "inspection_booking" && this.data.requestedServiceMode) {
      wx.navigateTo({ url: `/packages/annual/pages/stations/stations?serviceMode=${this.data.requestedServiceMode}&vehicleId=${vehicleId}&returnTo=inspection_booking` });
      return;
    }
    wx.navigateTo({ url: `/packages/annual/pages/service-mode/service-mode?vehicleId=${vehicleId}` });
  },
  officialGuide() {
    const result = this.data.result;
    const content = result?.action === "claim_mark"
      ? "请打开“交管12123”App，在机动车业务中选择免检车申领检验标志。最终有效期以官方记录为准。"
      : "请先在“交管12123”App 查看检验有效期止及车辆状态；如与测算不一致，请联系交管部门或专属客服核验后再办理。";
    wx.showModal({ title: "官方核验指引", content, confirmText: "我知道了", success: () => undefined });
  },
  copyPolicySource(event) {
    const url = String(event.currentTarget.dataset.url || "");
    if (!url) return;
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: "政策链接已复制", icon: "success" }) });
  },
});
