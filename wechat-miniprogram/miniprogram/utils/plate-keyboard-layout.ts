import type { PlateStyle } from "./plate-categories";

export const PLATE_PROVINCES = "京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼".split("");
export const PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ".split("");
export const PLATE_DIGITS = "0123456789".split("");
export const PLATE_SPECIALS = ["挂", "学", "警", "港", "澳", "领", "使"];

export function plateSlotCount(kind: PlateStyle): 7 | 8 {
  return kind === "green_small" || kind === "green_large" ? 8 : 7;
}

export function normalizePlateChars(value: string): string {
  return value.normalize("NFKC").replace(/[\s·•・.\-]/gu, "").replace(/[a-z]/g, (char) => char.toUpperCase());
}

export function formatPlateNumber(chars: string): string {
  const normalized = normalizePlateChars(chars);
  if (normalized.length <= 2) return normalized;
  return `${normalized.slice(0, 2)}·${normalized.slice(2)}`;
}

export function keyboardKeysForFocus(focusIndex: number): string[] {
  if (focusIndex <= 0) return [...PLATE_PROVINCES];
  if (focusIndex === 1) return [...PLATE_LETTERS];
  return [...PLATE_DIGITS, ...PLATE_LETTERS, ...PLATE_SPECIALS];
}

export function charsToSlots(value: string, slotCount: number): string[] {
  const chars = normalizePlateChars(value).slice(0, slotCount).split("");
  while (chars.length < slotCount) chars.push("");
  return chars;
}

export function slotsToValue(slots: string[]): string {
  return formatPlateNumber(slots.join(""));
}

export function isPlateSlotsComplete(value: string, slotCount: number): boolean {
  return normalizePlateChars(value).length === slotCount;
}
