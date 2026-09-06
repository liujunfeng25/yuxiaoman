export type PlateKind = "blue" | "yellow" | "green_small" | "green_large";

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

export type EditablePlateValue = {
  /** Stable separator-free value used for equality and uniqueness checks. */
  normalized: string;
  /** Safe owner-entered value used for display; standard plates are formatted consistently. */
  formatted: string;
};

const provinceSet: ReadonlySet<string> = new Set(PROVINCE_ABBREVIATIONS);
const agencySet: ReadonlySet<string> = new Set(AGENCY_LETTERS);
const ORDINARY_SERIAL_PATTERN = /^[A-Z0-9]{4}[A-Z0-9挂]$/;
const NEW_ENERGY_SERIAL_PATTERN = /^[A-Z0-9]{6}$/;
const REMOVABLE_SEPARATORS_PATTERN = /[\s·•・.\-]/gu;
const EDITABLE_PLATE_PATTERN = /^[\p{L}\p{N}\s·•・.\-]+$/u;
export const MAX_EDITABLE_PLATE_INPUT_LENGTH = 32;

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

  if (normalized.length === 7 && ORDINARY_SERIAL_PATTERN.test(serial)) {
    return {
      ...base,
      plateKind: serial.endsWith("挂") ? "yellow" : "blue",
      energyCategory: "none",
    };
  }

  // Number syntax cannot determine vehicle size or powertrain. Explicit profile
  // categories supply the plate style; energyCategory stays neutral for legacy callers.
  if (normalized.length === 8 && NEW_ENERGY_SERIAL_PATTERN.test(serial)) {
    return {
      ...base,
      plateKind: "green_small",
      energyCategory: "none",
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

/**
 * Normalizes an owner-editable plate without treating one regional syntax as a
 * complete registry of real Chinese plates. This deliberately permits special
 * suffixes such as 学、警、港、澳、挂 and does not inspect D/F for powertrain.
 *
 * The fixed-shape parser above remains useful for extracting province/agency
 * metadata from common civilian plates. Vehicle-profile writes should use this
 * function instead and persist the explicit plate category independently.
 */
export function editablePlateValue(value: string): EditablePlateValue | null {
  const prepared = value.normalize("NFKC").trim().toUpperCase();
  if (!prepared || prepared.length > MAX_EDITABLE_PLATE_INPUT_LENGTH || !EDITABLE_PLATE_PATTERN.test(prepared)) {
    return null;
  }
  const normalized = normalizePlate(prepared);
  if (!normalized) return null;
  const parsed = parsePlate(prepared);
  return {
    normalized,
    formatted: parsed.valid ? parsed.formatted : prepared.replace(/\s+/gu, ""),
  };
}

export function validateEditablePlate(value: string): boolean {
  return editablePlateValue(value) !== null;
}
