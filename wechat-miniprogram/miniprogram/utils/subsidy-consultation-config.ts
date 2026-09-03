import type { SubsidyDemoContact } from "../types";

export function normalizeSubsidyDemoContact(mode: unknown, rawValue: unknown): SubsidyDemoContact | null {
  if (mode === "real" || !rawValue || typeof rawValue !== "object") return null;
  const raw = rawValue as { name?: unknown; phone?: unknown };
  const name = String(raw.name || "").trim();
  const phone = String(raw.phone || "").trim();
  if (!name || name.length > 30 || !/^1[3-9]\d{9}$/u.test(phone)) return null;
  return { name, phone };
}
