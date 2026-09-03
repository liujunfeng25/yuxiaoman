import type { AppRole, BookingDraft, CarRentalDraft, DrivingSchoolInquiryReceipt, InsuranceLeadReceipt, RecentContact, SubsidyConsultationReceipt, WashDraft } from "../types";

const keys = {
  role: "yuxiaoman.role",
  draft: "yuxiaoman.bookingDraft",
  washDraft: "yuxiaoman.washDraft",
  recentContact: "yuxiaoman.recentContact",
  insuranceReceipt: "yuxiaoman.insuranceReceipt",
  subsidyConsultationReceipt: "yuxiaoman.subsidyConsultationReceipt",
  carRentalDraft: "yuxiaoman.carRentalDraft",
  drivingSchoolReceipt: "yuxiaoman.drivingSchoolReceipt",
  operatorFilter: "yuxiaoman.operatorFilter",
} as const;

export function getStoredRole(): AppRole {
  const role = wx.getStorageSync<AppRole>(keys.role);
  return role === "operator" || role === "repair_shop" ? role : "consumer";
}

export function storeRole(role: AppRole): void {
  wx.setStorageSync(keys.role, role);
}

export function getBookingDraft(): BookingDraft | null {
  return wx.getStorageSync<BookingDraft | null>(keys.draft) || null;
}

export function saveBookingDraft(draft: BookingDraft): void {
  wx.setStorageSync(keys.draft, draft);
}

export function patchBookingDraft(patch: Partial<BookingDraft>): BookingDraft {
  const next = { serviceMode: "self_drive" as const, ...(getBookingDraft() || {}), ...patch };
  saveBookingDraft(next);
  return next;
}

export function clearBookingDraft(): void {
  wx.removeStorageSync(keys.draft);
}

export function getWashDraft(): WashDraft | null {
  return wx.getStorageSync<WashDraft | null>(keys.washDraft) || null;
}

export function patchWashDraft(patch: Partial<WashDraft>): WashDraft {
  const next = { ...(getWashDraft() || {}), ...patch };
  wx.setStorageSync(keys.washDraft, next);
  return next;
}

export function clearWashDraft(): void {
  wx.removeStorageSync(keys.washDraft);
}

export function getCarRentalDraft(): CarRentalDraft | null {
  return wx.getStorageSync<CarRentalDraft | null>(keys.carRentalDraft) || null;
}

export function saveCarRentalDraft(draft: CarRentalDraft): void {
  wx.setStorageSync(keys.carRentalDraft, draft);
}

export function patchCarRentalDraft(patch: Partial<CarRentalDraft>): CarRentalDraft {
  const current = getCarRentalDraft();
  const now = new Date();
  const pickup = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  pickup.setHours(10, 0, 0, 0);
  const returnAt = new Date(pickup.getTime() + 2 * 24 * 60 * 60 * 1000);
  const fallback: CarRentalDraft = {
    fulfillmentMode: "store_pickup",
    pickupAt: pickup.toISOString(),
    returnAt: returnAt.toISOString(),
  };
  const next = { ...fallback, ...(current || {}), ...patch };
  saveCarRentalDraft(next);
  return next;
}

export function clearCarRentalDraft(): void {
  wx.removeStorageSync(keys.carRentalDraft);
}

export function getRecentContact(): RecentContact {
  const stored = wx.getStorageSync<RecentContact | null>(keys.recentContact);
  return stored && stored.name && stored.phone ? stored : { name: "林先生", phone: "13800001234" };
}

export function storeRecentContact(contact: RecentContact): void {
  wx.setStorageSync(keys.recentContact, contact);
}

export function getInsuranceReceipt(): InsuranceLeadReceipt | null {
  return wx.getStorageSync<InsuranceLeadReceipt | null>(keys.insuranceReceipt) || null;
}

export function storeInsuranceReceipt(receipt: InsuranceLeadReceipt): void {
  wx.setStorageSync(keys.insuranceReceipt, receipt);
}

export function getDrivingSchoolReceipt(): DrivingSchoolInquiryReceipt | null {
  return wx.getStorageSync<DrivingSchoolInquiryReceipt | null>(keys.drivingSchoolReceipt) || null;
}

export function storeDrivingSchoolReceipt(receipt: DrivingSchoolInquiryReceipt): void {
  wx.setStorageSync(keys.drivingSchoolReceipt, receipt);
}

export function getSubsidyConsultationReceipt(): SubsidyConsultationReceipt | null {
  return wx.getStorageSync<SubsidyConsultationReceipt | null>(keys.subsidyConsultationReceipt) || null;
}

export function storeSubsidyConsultationReceipt(receipt: SubsidyConsultationReceipt): void {
  wx.setStorageSync(keys.subsidyConsultationReceipt, receipt);
}

export function getOperatorFilter(): string {
  return wx.getStorageSync<string>(keys.operatorFilter) || "all";
}

export function storeOperatorFilter(filter: string): void {
  wx.setStorageSync(keys.operatorFilter, filter);
}
