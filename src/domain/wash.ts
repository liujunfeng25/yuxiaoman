export const WASH_VEHICLE_CATEGORIES = ["sedan", "suv", "mpv"] as const;

export type WashVehicleCategory = typeof WASH_VEHICLE_CATEGORIES[number];
export type WashVehicleCategoryInput = WashVehicleCategory | "suv_mpv";

export type WashStoreImageDto = {
  id: string;
  url: string;
  mimeType: "image/jpeg";
  sizeBytes: number;
  width: number;
  height: number;
  sortOrder: number;
  isCover: boolean;
  isStored: true;
  dataKind: "demo" | "real";
  createdAt: string;
};

export function normalizeWashVehicleCategory(value: unknown): WashVehicleCategory | null {
  if (value === "sedan" || value === "suv" || value === "mpv") return value;
  if (value === "suv_mpv") return "suv";
  return null;
}

function washVehicleText(value: {
  vehicleType?: unknown;
  modelName?: unknown;
  brandName?: unknown;
}): string {
  return [value.vehicleType, value.modelName, value.brandName]
    .filter((item) => item != null)
    .map(String)
    .join(" ")
    .toUpperCase();
}

export function inferWashVehicleCategory(value: {
  persisted?: unknown;
  vehicleType?: unknown;
  modelName?: unknown;
  brandName?: unknown;
  seats?: unknown;
}): WashVehicleCategory {
  if (value.persisted === "sedan" || value.persisted === "suv" || value.persisted === "mpv") {
    return value.persisted;
  }
  const text = washVehicleText(value);
  if (/\bMPV\b|商务|多用途|面包/u.test(text)) return "mpv";
  if (/\bSUV\b/u.test(text) || Number(value.seats) >= 7 || value.persisted === "suv_mpv") return "suv";
  return "sedan";
}
