export const OFFICIAL_INSPECTION_CONCLUSIONS = ["passed", "failed"] as const;

export type OfficialInspectionConclusion = (typeof OFFICIAL_INSPECTION_CONCLUSIONS)[number];

// High-level item groups follow the inspection sections used by the current
// motor-vehicle safety inspection rules. Exact equipment item codes and
// measured values remain in the station's reason text / source result.
export const OFFICIAL_INSPECTION_FAILURE_CATEGORIES = [
  "vehicle_uniqueness",
  "vehicle_characteristics",
  "vehicle_appearance",
  "safety_devices",
  "chassis_dynamic",
  "vehicle_underbody",
  "instrumented_test",
  "emissions",
  "other_official_item",
] as const;

export type OfficialInspectionFailureCategory =
  (typeof OFFICIAL_INSPECTION_FAILURE_CATEGORIES)[number];

export type OfficialInspectionFailureDetails = {
  itemCategories: OfficialInspectionFailureCategory[];
  reason: string;
  reinspectionAdvice: string;
};

export type OfficialInspectionFailureDetailsStatus =
  | "complete"
  | "not_applicable"
  | "pending"
  | "legacy_missing_details";

export type OfficialInspectionConclusionStatus =
  | "available"
  | "pending"
  | "legacy_requires_reentry";

export function isOfficialInspectionConclusion(
  value: unknown,
): value is OfficialInspectionConclusion {
  return value === "passed" || value === "failed";
}

/**
 * Old databases may contain the retired `conditional` value. It is not a
 * failed result and must never be silently reclassified. Public DTOs expose a
 * null conclusion plus an explicit compatibility status until an authorised
 * operator records one of the two official outcomes.
 */
export function officialInspectionConclusionView(value: unknown): {
  conclusion: OfficialInspectionConclusion | null;
  conclusionStatus: OfficialInspectionConclusionStatus;
} {
  if (isOfficialInspectionConclusion(value)) {
    return { conclusion: value, conclusionStatus: "available" };
  }
  if (value == null || String(value).trim() === "") {
    return { conclusion: null, conclusionStatus: "pending" };
  }
  return { conclusion: null, conclusionStatus: "legacy_requires_reentry" };
}

export function safeInspectionConclusionSummary(
  value: unknown,
  summary: Record<string, unknown>,
): Record<string, unknown> {
  const view = officialInspectionConclusionView(value);
  if (view.conclusionStatus !== "legacy_requires_reentry") return summary;
  return {
    ...summary,
    conclusionLabel: "历史结论待重新确认",
  };
}

function parsedFailureDetails(value: unknown): OfficialInspectionFailureDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const itemCategories = Array.isArray(record.itemCategories)
    ? record.itemCategories.filter((item): item is OfficialInspectionFailureCategory =>
        (OFFICIAL_INSPECTION_FAILURE_CATEGORIES as readonly unknown[]).includes(item))
    : [];
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const reinspectionAdvice = typeof record.reinspectionAdvice === "string"
    ? record.reinspectionAdvice.trim()
    : "";
  if (itemCategories.length < 1 || !reason || !reinspectionAdvice) return null;
  return { itemCategories, reason, reinspectionAdvice };
}

export function officialInspectionFailureDetailsView(
  conclusionValue: unknown,
  detailsValue: unknown,
): {
  failureDetails: OfficialInspectionFailureDetails | null;
  failureDetailsStatus: OfficialInspectionFailureDetailsStatus;
} {
  const conclusionView = officialInspectionConclusionView(conclusionValue);
  if (conclusionView.conclusion === "passed") {
    return { failureDetails: null, failureDetailsStatus: "not_applicable" };
  }
  if (conclusionView.conclusion === "failed") {
    const failureDetails = parsedFailureDetails(detailsValue);
    return failureDetails
      ? { failureDetails, failureDetailsStatus: "complete" }
      : { failureDetails: null, failureDetailsStatus: "legacy_missing_details" };
  }
  return { failureDetails: null, failureDetailsStatus: "pending" };
}
