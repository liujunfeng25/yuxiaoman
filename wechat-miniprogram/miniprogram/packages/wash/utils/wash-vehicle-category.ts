import type { Vehicle, WashVehicleCategory } from "../../../types";

/**
 * Canonical wash pricing category. Historical combined rows are read as SUV,
 * while seat count alone never decides SUV vs MPV (a 7-seat SUV stays SUV).
 */
export function washVehicleCategory(vehicle: Vehicle | null | undefined): WashVehicleCategory {
  if (!vehicle) return "sedan";
  if (vehicle.washVehicleCategory === "sedan" || vehicle.washVehicleCategory === "suv" || vehicle.washVehicleCategory === "mpv") return vehicle.washVehicleCategory;
  if (vehicle.washVehicleCategory === "suv_mpv") return "suv";
  if (/MPV|商务/i.test(vehicle.vehicleType)) return "mpv";
  if (/SUV|越野/i.test(vehicle.vehicleType)) return "suv";
  return "sedan";
}

export function washVehicleCategoryLabel(vehicle: Vehicle | null | undefined): string {
  const category = washVehicleCategory(vehicle);
  return category === "mpv" ? "MPV" : category === "suv" ? "SUV" : "小轿车";
}
