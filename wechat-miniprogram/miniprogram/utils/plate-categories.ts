/** Shared by the mini-program, API and operations admin. Never infer powertrain from plate letters. */
export const PLATE_CATEGORY_CODES = [
  "blue_small_passenger", "new_energy_small_passenger",
  "blue_small_truck", "new_energy_small_truck",
  "yellow_large_bus", "new_energy_large_bus",
  "yellow_large_tractor", "new_energy_large_tractor",
  "yellow_trailer", "yellow_large_truck", "new_energy_large_truck",
] as const;

export type PlateCategoryCode = typeof PLATE_CATEGORY_CODES[number];
export type PlateStyle = "blue" | "yellow" | "green_small" | "green_large";
export type PlateCategory = {
  code: PlateCategoryCode; label: string; vehicleType: string;
  vehicleClassCode: string; plateKind: PlateStyle; defaultSeats: number;
};

export const PLATE_CATEGORIES: PlateCategory[] = [
  { code: "blue_small_passenger", label: "蓝牌小型普通客车", vehicleType: "小型普通客车", vehicleClassCode: "passenger_car", plateKind: "blue", defaultSeats: 5 },
  { code: "new_energy_small_passenger", label: "新能源小型普通客车", vehicleType: "小型普通客车", vehicleClassCode: "passenger_car", plateKind: "green_small", defaultSeats: 5 },
  { code: "blue_small_truck", label: "蓝牌小型货车", vehicleType: "小型货车", vehicleClassCode: "small_truck", plateKind: "blue", defaultSeats: 2 },
  { code: "new_energy_small_truck", label: "新能源小型货车", vehicleType: "小型货车", vehicleClassCode: "small_truck", plateKind: "green_small", defaultSeats: 2 },
  { code: "yellow_large_bus", label: "黄牌大型普通客车", vehicleType: "大型普通客车", vehicleClassCode: "large_bus", plateKind: "yellow", defaultSeats: 20 },
  { code: "new_energy_large_bus", label: "新能源大型普通客车", vehicleType: "大型普通客车", vehicleClassCode: "large_bus", plateKind: "green_large", defaultSeats: 20 },
  { code: "yellow_large_tractor", label: "黄牌大型牵引车", vehicleType: "大型牵引车", vehicleClassCode: "large_tractor", plateKind: "yellow", defaultSeats: 2 },
  { code: "new_energy_large_tractor", label: "新能源大型牵引车", vehicleType: "大型牵引车", vehicleClassCode: "large_tractor", plateKind: "green_large", defaultSeats: 2 },
  { code: "yellow_trailer", label: "黄牌挂车", vehicleType: "挂车", vehicleClassCode: "trailer", plateKind: "yellow", defaultSeats: 0 },
  { code: "yellow_large_truck", label: "黄牌大型货车", vehicleType: "大型货车", vehicleClassCode: "large_truck", plateKind: "yellow", defaultSeats: 2 },
  { code: "new_energy_large_truck", label: "新能源大型货车", vehicleType: "大型货车", vehicleClassCode: "large_truck", plateKind: "green_large", defaultSeats: 2 },
];

export function plateCategory(code: unknown): PlateCategory | undefined {
  return PLATE_CATEGORIES.find((item) => item.code === code);
}

/** Compatibility only for profiles predating explicit categories; never uses D/F. */
export function legacyPlateCategory(vehicleType: string, plateNumber: string, classCode?: string | null): PlateCategory | undefined {
  const normalized = plateNumber.replace(/[\s·•・.\-]/g, "");
  const energy = normalized.length === 8;
  let vehicleClassCode = classCode;
  if (/挂车/.test(vehicleType) || normalized.endsWith("挂")) vehicleClassCode = "trailer";
  else if (/牵引/.test(vehicleType)) vehicleClassCode = "large_tractor";
  else if (/大.*客车/.test(vehicleType)) vehicleClassCode = "large_bus";
  else if (/货车|货运|卡车/.test(vehicleType)) vehicleClassCode = /大|重|中型/.test(vehicleType) ? "large_truck" : "small_truck";
  else if (/中型客车|摩托|专项/.test(vehicleType)) return undefined;
  else if (!vehicleClassCode || vehicleClassCode === "small_micro_passenger") vehicleClassCode = "passenger_car";
  return PLATE_CATEGORIES.find((item) => item.vehicleClassCode === vehicleClassCode
    && (vehicleClassCode === "trailer" || item.code.startsWith("new_energy_") === energy));
}
