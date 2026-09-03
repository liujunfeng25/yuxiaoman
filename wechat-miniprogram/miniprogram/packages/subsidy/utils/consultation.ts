import type {
  SubsidyAdministrativeFees,
  SubsidyFeePlan,
  SubsidyFeeTier,
  SubsidyMaterial,
  SubsidyMaterialDefinition,
  SubsidyMaterialKind,
} from "../../../types";

export const MAX_DECLARED_VALUE_FEN = 50000000;

export const defaultMaterialDefinitions: SubsidyMaterialDefinition[] = [
  { kind: "id_card_front", label: "身份证人像面", group: "identity" },
  { kind: "id_card_back", label: "身份证国徽面", group: "identity" },
  { kind: "driving_license_front", label: "行驶证主页", group: "driving_license" },
  { kind: "driving_license_back", label: "行驶证副页", group: "driving_license" },
  { kind: "vehicle_front_left", label: "车辆左前", group: "vehicle_reference" },
  { kind: "vehicle_front_right", label: "车辆右前", group: "vehicle_reference" },
  { kind: "vehicle_rear_left", label: "车辆左后", group: "vehicle_reference" },
  { kind: "vehicle_rear_right", label: "车辆右后", group: "vehicle_reference" },
  { kind: "dashboard_started", label: "启动后仪表盘", group: "vehicle_reference" },
];

export type SubsidyUploadItem = SubsidyMaterialDefinition & {
  localPath: string;
  fileSize: number;
  material: SubsidyMaterial | null;
  uploading: boolean;
  error: string;
};

export type SubsidyTierDisplay = SubsidyFeeTier & {
  rangeText: string;
  consultationFeeText: string;
  plateFeeText: string;
  mailingFeeText: string;
  productionFeeText: string;
  administrativeFeeText: string;
  totalTransferCostText: string;
  selected: boolean;
};

export type SubsidyFeeBreakdownText = {
  consultationFeeText: string;
  plateFeeText: string;
  mailingFeeText: string;
  productionFeeText: string;
  administrativeFeeText: string;
  totalTransferCostText: string;
};

type SubsidyFeeBreakdownSource = {
  consultationFeeFen: number;
  administrativeFees: SubsidyAdministrativeFees;
  administrativeFeeFen: number;
  totalTransferCostFen: number;
};

export function subsidyMaterialInputMode(acceptsRealData: boolean, configuredMode: string): "server_generated_demo" | "multipart" {
  return acceptsRealData && configuredMode === "multipart" ? "multipart" : "server_generated_demo";
}

function wanNumber(valueFen: number): string {
  const value = valueFen / 1000000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}

export function formatDeclaredValue(valueFen: number): string {
  return `${wanNumber(valueFen)}万元`;
}

export function formatConsultationFee(valueFen: number): string {
  const yuan = valueFen / 100;
  return `¥${Number.isInteger(yuan) ? yuan.toFixed(0) : yuan.toFixed(2)}`;
}

export function formatSubsidyFeeBreakdown(source: SubsidyFeeBreakdownSource): SubsidyFeeBreakdownText {
  return {
    consultationFeeText: formatConsultationFee(source.consultationFeeFen),
    plateFeeText: formatConsultationFee(source.administrativeFees.plateFeeFen),
    mailingFeeText: formatConsultationFee(source.administrativeFees.mailingFeeFen),
    productionFeeText: formatConsultationFee(source.administrativeFees.productionFeeFen),
    administrativeFeeText: formatConsultationFee(source.administrativeFeeFen),
    totalTransferCostText: formatConsultationFee(source.totalTransferCostFen),
  };
}

export function tierRangeText(tier: Pick<SubsidyFeeTier, "minValueFen" | "maxValueFen">): string {
  return `${wanNumber(tier.minValueFen)}–${wanNumber(tier.maxValueFen)}万元`;
}

export function findSubsidyTier(tiers: SubsidyFeeTier[], declaredValueFen: number): SubsidyFeeTier | null {
  return tiers.find((tier) => declaredValueFen > tier.minValueFen && declaredValueFen <= tier.maxValueFen) || null;
}

export function decorateSubsidyTiers(
  plan: Pick<SubsidyFeePlan, "tiers" | "administrativeFees" | "administrativeFeeFen">,
  declaredValueFen: number | null,
): SubsidyTierDisplay[] {
  const selectedId = declaredValueFen === null ? "" : findSubsidyTier(plan.tiers, declaredValueFen)?.id || "";
  return [...plan.tiers]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.maxValueFen - right.maxValueFen)
    .map((tier) => {
      const breakdown = formatSubsidyFeeBreakdown({
        consultationFeeFen: tier.feeFen,
        administrativeFees: plan.administrativeFees,
        administrativeFeeFen: plan.administrativeFeeFen,
        totalTransferCostFen: tier.totalTransferCostFen,
      });
      return {
        ...tier,
        ...breakdown,
        rangeText: tierRangeText(tier),
        selected: Boolean(selectedId && tier.id === selectedId),
      };
    });
}

export function parseDeclaredValueWan(value: string, maxValueFen = MAX_DECLARED_VALUE_FEN): number | null {
  const normalized = value.trim();
  if (!/^\d{1,3}(?:\.\d)?$/u.test(normalized)) return null;
  const [wholePart, decimalPart = ""] = normalized.split(".");
  const valueFen = Number(wholePart) * 1000000 + Number(decimalPart || 0) * 100000;
  if (!Number.isSafeInteger(valueFen) || valueFen <= 0 || valueFen > Math.min(maxValueFen, MAX_DECLARED_VALUE_FEN)) return null;
  return valueFen;
}

export function reconcileSubsidyUploads(
  serverDefinitions: SubsidyMaterialDefinition[] = [],
  current: SubsidyUploadItem[] = [],
): SubsidyUploadItem[] {
  const configured = new Map(serverDefinitions.map((item) => [item.kind, item]));
  const currentByKind = new Map(current.map((item) => [item.kind, item]));
  return defaultMaterialDefinitions.map((fallback) => {
    const configuredDefinition = configured.get(fallback.kind);
    const definition = { ...fallback, ...(configuredDefinition ? { label: configuredDefinition.label } : {}) };
    const existing = currentByKind.get(fallback.kind);
    return existing
      ? { ...existing, ...definition, kind: fallback.kind }
      : { ...fallback, ...definition, kind: fallback.kind, localPath: "", fileSize: 0, material: null, uploading: false, error: "" };
  });
}

export function updateSubsidyUpload(
  uploads: SubsidyUploadItem[],
  kind: SubsidyMaterialKind,
  patch: Partial<Pick<SubsidyUploadItem, "localPath" | "fileSize" | "material" | "uploading" | "error">>,
): SubsidyUploadItem[] {
  return uploads.map((item) => item.kind === kind ? { ...item, ...patch } : item);
}

export function allSubsidyMaterialsReady(uploads: SubsidyUploadItem[]): boolean {
  return uploads.length === defaultMaterialDefinitions.length
    && uploads.every((item) => Boolean(item.material?.id) && !item.uploading);
}

export function completedSubsidyMaterialCount(uploads: SubsidyUploadItem[]): number {
  return uploads.filter((item) => Boolean(item.material?.id)).length;
}
