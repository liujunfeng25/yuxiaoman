import type {
  CheckupFaultSeverity,
  CheckupFaultType,
  CheckupConclusion,
  CheckupConclusionStatus,
  VehicleCheckupReport,
  VehicleFault,
} from "../../../types";

export function annualConclusionNarrative(value: CheckupConclusion | null | undefined, status?: CheckupConclusionStatus): string {
  if (value === "passed") return "检测站回传的本次年检结论为通过。平台只展示订单回传结果；检验有效期和电子检验标志状态请以交管官方记录为准。";
  if (status === "legacy_requires_reentry") return "这是一条使用旧版结论生成的历史报告。旧结论已停用，本次正式年检结果尚未确认；请由检测站重新录入“通过”或“未通过”。当前记录不能视为未通过，也不能作为通过凭证。";
  if (value === "failed") return "检测站回传的本次年检结论为未通过。请联系检测站确认未通过项目、整改要求与复检安排。";
  return "检测站尚未回传本次年检结论。";
}

export function vehicleConditionTitle(report: VehicleCheckupReport): string {
  if (report.observationMode === "no_visible_faults" && !report.faults.length) return "本次记录未发现明显异常";
  if (report.faults.length) return `本次记录发现 ${report.faults.length} 项车辆问题`;
  return "车辆状态尚未完成确认";
}

export function vehicleConditionNarrative(report: VehicleCheckupReport): string {
  if (report.observationMode === "no_visible_faults" && !report.faults.length) {
    return "检测站在本次现场照片与可见范围内未记录明显车身异常。该记录不覆盖底盘、内部结构或需要设备、拆检才能发现的问题，也不替代年检结论。";
  }
  if (report.faults.length) {
    return `检测站在本次现场可见及功能检查范围内记录了 ${report.faults.length} 项车辆问题，具体部位、程度与说明见下方明细。车辆体检记录用于留存交接车况，不会自动判定年检未通过。`;
  }
  return "检测站尚未完成车辆可见状态确认；当前页面不补造无异常结论。";
}

export function faultAdvice(fault: VehicleFault): string {
  const severityLead: Record<CheckupFaultSeverity, string> = {
    minor: "建议留存照片并观察变化。",
    moderate: "建议近期安排专业复核。",
    severe: "建议尽快安排专业检查；如影响驾驶视野、照明、部件固定或车门开闭，请先处理后用车。",
  };
  const typeAdvice: Record<CheckupFaultType, string> = {
    scratch: "可核对划痕范围及是否露出底漆，需要时评估补漆与防锈处理。",
    dent: "可检查凹陷是否影响相邻部件开闭、密封或固定，需要时评估钣金修复。",
    paint_damage: "可留意金属基材是否外露，需要时评估补漆与防锈处理。",
    crack: "可检查裂纹是否扩展以及是否影响玻璃、灯具或覆盖件功能，必要时尽快维修。",
    broken: "可确认破损件的固定、照明或密封功能，存在松脱或功能影响时应先处理。",
    rust: "可检查锈蚀范围与深度，建议由维修机构评估除锈及后续防护。",
    warning_light: "建议记录具体灯号或报码，并由维修机构读取故障信息后确定维修项目。",
    malfunction: "建议记录触发条件和具体表现，由维修机构结合实车检查功能异常原因。",
    abnormal_noise: "建议记录异响或抖动出现的工况，避免在异常加剧时继续行驶。",
    leakage: "建议确认渗漏位置和液体类型；如持续滴漏或影响制动、转向，应尽快处理。",
    wear: "建议核对磨损范围和剩余使用状态，由维修机构判断保养或更换时机。",
    other: "请结合现场描述复核该位置状态；无法判断时可由维修机构进一步检查。",
  };
  return `${severityLead[fault.severity]}${typeAdvice[fault.faultType]}`;
}
