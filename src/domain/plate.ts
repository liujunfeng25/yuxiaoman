export type PlateKind = "blue" | "green_small" | "green_large";

export type EnergyCategory = "none" | "pure_electric" | "non_pure_electric";

export const PROVINCE_ABBREVIATIONS = [
  "京",
  "津",
  "沪",
  "渝",
  "冀",
  "豫",
  "云",
  "辽",
  "黑",
  "湘",
  "皖",
  "鲁",
  "新",
  "苏",
  "浙",
  "赣",
  "鄂",
  "桂",
  "甘",
  "晋",
  "蒙",
  "陕",
  "吉",
  "闽",
  "贵",
  "粤",
  "青",
  "藏",
  "川",
  "宁",
  "琼",
] as const;

export const AGENCY_LETTERS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "J",
  "K",
  "L",
  "M",
  "N",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
] as const;

export type PlateProvince = (typeof PROVINCE_ABBREVIATIONS)[number];
export type PlateAgencyCode = (typeof AGENCY_LETTERS)[number];

export type PlateInvalidReason =
  | "empty"
  | "invalid_length"
  | "invalid_province"
  | "invalid_agency_code"
  | "invalid_serial";

export type ParsedPlate =
  | {
      valid: true;
      normalized: string;
      formatted: string;
      plateKind: PlateKind;
      province: PlateProvince;
      agencyCode: PlateAgencyCode;
      serial: string;
      energyCategory: EnergyCategory;
    }
  | {
      valid: false;
      normalized: string;
      reason: PlateInvalidReason;
    };

const provinceSet: ReadonlySet<string> = new Set(PROVINCE_ABBREVIATIONS);
const agencySet: ReadonlySet<string> = new Set(AGENCY_LETTERS);
const BLUE_SERIAL_PATTERN = /^[A-HJ-NP-Z0-9]{5}$/;
/** 8 位绿牌序号：6 位字母或数字，仅排除 I/O。 */
const GREEN_SMALL_SERIAL_PATTERN = /^[A-HJ-NP-Z0-9]{6}$/;
const GREEN_LARGE_SERIAL_PATTERN = /^\d{5}[DF]$/;

function energyCategoryFromSerial(serial: string): EnergyCategory {
  if (serial[0] === "D") return "pure_electric";
  if (serial[0] === "F") return "non_pure_electric";
  return "none";
}
const REMOVABLE_SEPARATORS_PATTERN = /[\s·•・.\-]/gu;

/**
 * Produces the stable value used for comparison and persistence.
 * Full-width Latin letters and digits are folded before separators are removed.
 */
export function normalizePlate(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase().replace(REMOVABLE_SEPARATORS_PATTERN, "");
}

export function parsePlate(value: string): ParsedPlate {
  const normalized = normalizePlate(value);
  if (!normalized) return { valid: false, normalized, reason: "empty" };
  if (normalized.length !== 7 && normalized.length !== 8) {
    return { valid: false, normalized, reason: "invalid_length" };
  }

  const province = normalized[0];
  if (!provinceSet.has(province)) {
    return { valid: false, normalized, reason: "invalid_province" };
  }

  const agencyCode = normalized[1];
  if (!agencySet.has(agencyCode)) {
    return { valid: false, normalized, reason: "invalid_agency_code" };
  }

  const serial = normalized.slice(2);
  const base = {
    valid: true as const,
    normalized,
    formatted: `${province}${agencyCode}·${serial}`,
    province: province as PlateProvince,
    agencyCode: agencyCode as PlateAgencyCode,
    serial,
  };

  if (normalized.length === 7 && BLUE_SERIAL_PATTERN.test(serial)) {
    return {
      ...base,
      plateKind: "blue",
      energyCategory: "none",
    };
  }

  if (normalized.length === 8 && GREEN_LARGE_SERIAL_PATTERN.test(serial)) {
    return {
      ...base,
      plateKind: "green_large",
      energyCategory: serial[5] === "D" ? "pure_electric" : "non_pure_electric",
    };
  }

  if (normalized.length === 8 && GREEN_SMALL_SERIAL_PATTERN.test(serial)) {
    return {
      ...base,
      plateKind: "green_small",
      energyCategory: energyCategoryFromSerial(serial),
    };
  }

  return { valid: false, normalized, reason: "invalid_serial" };
}

/** Returns a canonical display value for valid plates and the normalized input otherwise. */
export function formatPlate(value: string): string {
  const parsed = parsePlate(value);
  return parsed.valid ? parsed.formatted : parsed.normalized;
}

export function validatePlate(value: string): boolean {
  return parsePlate(value).valid;
}

