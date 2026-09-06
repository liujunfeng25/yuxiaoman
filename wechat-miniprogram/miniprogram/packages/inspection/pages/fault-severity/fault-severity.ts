import type { CheckupFaultSeverity } from "../../../../types";
import { checkupRegionDefinition, regionLabel } from "../../utils/checkup-report";

type SeverityOption = {
  value: CheckupFaultSeverity;
  label: string;
  summary: string;
  guidance: string;
  selected: boolean;
};

type Data = {
  regionCode: string;
  regionName: string;
  selectedSeverity: CheckupFaultSeverity | null;
  severityOptions: SeverityOption[];
};

const SEVERITY_OPTIONS: ReadonlyArray<Omit<SeverityOption, "selected">> = [
  {
    value: "minor",
    label: "轻微",
    summary: "局部、浅表，暂未发现功能影响",
    guidance: "例如细小划痕、轻微掉漆或不明显的小凹点。",
  },
  {
    value: "moderate",
    label: "一般",
    summary: "损伤清晰，需要安排检查或维修",
    guidance: "例如明显凹陷、较长划痕、局部开裂或部件功能异常。",
  },
  {
    value: "severe",
    label: "明显",
    summary: "范围较大，可能影响安全或正常使用",
    guidance: "例如部件破损松脱、视野或照明受影响，以及需要优先处理的损伤。",
  },
];

function options(selected: CheckupFaultSeverity | null): SeverityOption[] {
  return SEVERITY_OPTIONS.map((item) => ({ ...item, selected: item.value === selected }));
}

Page<Data>({
  data: {
    regionCode: "",
    regionName: "车身位置",
    selectedSeverity: null,
    severityOptions: options(null),
  },
  onLoad(query) {
    const regionCode = String(query.regionCode || "");
    if (!checkupRegionDefinition(regionCode)) {
      wx.showToast({ title: "故障位置无效，请重新选择", icon: "none" });
      setTimeout(() => wx.navigateBack(), 500);
      return;
    }
    this.setData({ regionCode, regionName: regionLabel(regionCode) });
  },
  selectSeverity(event) {
    const severity = String(event.currentTarget.dataset.value || "") as CheckupFaultSeverity;
    if (!SEVERITY_OPTIONS.some((item) => item.value === severity)) return;
    this.setData({ selectedSeverity: severity, severityOptions: options(severity) });
  },
  cancel() { wx.navigateBack(); },
  continueToDetails() {
    if (!this.data.selectedSeverity || !this.data.regionCode) {
      wx.showToast({ title: "请先选择故障程度", icon: "none" });
      return;
    }
    this.getOpenerEventChannel().emit("faultSeveritySelected", {
      regionCode: this.data.regionCode,
      severity: this.data.selectedSeverity,
    });
    wx.navigateBack();
  },
});
