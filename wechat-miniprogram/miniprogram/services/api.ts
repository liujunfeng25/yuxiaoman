import { apiBaseUrl, apiOrigin, assertApiConfigured } from "../config/env";
import { withOwnerAuthorization } from "./session";
import { withOperatorAuthorization } from "./operator-session";
import { localizeOperatorMedia } from "./operator-media";
import { localizeOwnerMedia } from "./owner-media";
import { normalizeSubsidyDemoContact } from "../utils/subsidy-consultation-config";
import type {
  Booking,
  BookingMedia,
  BookingQuote,
  BookingStatus,
  CheckupConclusion,
  CheckupFailureDetails,
  CheckupMedia,
  CheckupMediaKind,
  CarRentalBrand,
  CarRentalCatalog,
  CarRentalModel,
  CarRentalOffer,
  CarRentalOfferPage,
  CarRentalOrder,
  CarRentalQuote,
  CarRentalSearch,
  CarRentalStore,
  DrivingSchoolApplicationMode,
  DrivingSchoolDetail,
  DrivingSchoolImage,
  DrivingSchoolInquiryDisclosure,
  DrivingSchoolInquiryInput,
  DrivingSchoolInquiryReceipt,
  DrivingSchoolLicenseClassOption,
  DrivingSchoolListItem,
  DrivingSchoolListPage,
  DrivingSchoolListQuery,
  DrivingSchoolMeta,
  DrivingSchoolMetaOption,
  DrivingSchoolOffer,
  DrivingSchoolTrainingClass,
  InsuranceDisclosure,
  InsuranceLeadInput,
  InsuranceLeadReceipt,
  InspectionCalculation,
  InspectionCalculationRequest,
  InspectionDateEvidence,
  PickupAddress,
  RepairRequest,
  RepairRequestFault,
  RepairRequestMedia,
  RepairRequestQuote,
  RepairRequestSummary,
  ServiceMode,
  Slot,
  Station,
  SubsidyAdministrativeFees,
  SubsidyConsultationConfig,
  SubsidyConsultationCreateInput,
  SubsidyConsultationReceipt,
  SubsidyFeeTier,
  SubsidyMaterial,
  SubsidyMaterialKind,
  SubsidyQuote,
  UsedCarBrand,
  UsedCarCatalog,
  UsedCarImage,
  UsedCarListing,
  UsedCarListingPage,
  UsedCarListingQuery,
  UsedCarModel,
  ValetEvidenceMedia,
  ValetEvidenceMediaKind,
  Vehicle,
  VehicleCheckupReport,
  VehicleCheckupReportInput,
  VehicleCheckupReportListData,
  VehicleCheckupReportListPage,
  VehicleCheckupReportListQuery,
  VehicleCheckupReportProgress,
  VehicleCheckupReportStationSummary,
  VehicleCheckupReportSummary,
  VehicleCheckupReportVehicleSummary,
  VehicleCatalog,
  VehicleInput,
  UserProfile,
  WashVehicleCategory,
  WashOrder,
  WashPackage,
  WashQuote,
  WashSlot,
  WashStore,
  Workbench,
} from "../types";

type Envelope<T> = { data: T; meta?: Record<string, unknown>; error?: { code?: string; message?: string; fields?: Record<string, string> } };

type ApiError = Error & { code?: string; statusCode?: number; fields?: Record<string, string> };

function apiError(payload: Envelope<unknown> | undefined, statusCode: number, fallback: string): ApiError {
  const error = new Error(payload?.error?.message || fallback) as ApiError;
  error.code = payload?.error?.code;
  error.statusCode = statusCode;
  error.fields = payload?.error?.fields;
  return error;
}

function requestEnvelope<T>(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}): Promise<Envelope<T>> {
  assertApiConfigured();
  const hasBody = data !== undefined;
  return withOwnerAuthorization(
    hasBody ? { "content-type": "application/json", ...headers } : headers,
    (authorizedHeaders) => new Promise((resolve, reject) => {
      const header: Record<string, string> = { ...authorizedHeaders };
      if (!hasBody) {
        delete header["content-type"];
        delete header["Content-Type"];
      }
      wx.request<Envelope<T>>({
        url: `${apiBaseUrl}${path}`,
        method,
        ...(hasBody ? { data } : {}),
        header,
        timeout: 10000,
        success: (result) => {
          if (result.statusCode >= 200 && result.statusCode < 300) {
            resolve(result.data);
            return;
          }
          reject(apiError(result.data, result.statusCode, "服务暂时不可用"));
        },
        fail: (error) => reject(new Error(error.errMsg || "无法连接本地服务")),
      });
    }),
  );
}

function request<T>(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  return requestEnvelope<T>(path, method, data, headers).then((payload) => payload.data);
}

function operatorRequestEnvelope<T>(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}): Promise<Envelope<T>> {
  assertApiConfigured();
  const hasBody = data !== undefined;
  return withOperatorAuthorization(
    hasBody ? { "content-type": "application/json", ...headers } : headers,
    (authorizedHeaders) => new Promise((resolve, reject) => {
      // Avoid WeChat adding empty JSON bodies on DELETE/GET with application/json.
      const header: Record<string, string> = { ...authorizedHeaders };
      if (!hasBody) {
        delete header["content-type"];
        delete header["Content-Type"];
      }
      wx.request<Envelope<T>>({
        url: `${apiBaseUrl}${path}`,
        method,
        ...(hasBody ? { data } : {}),
        header,
        timeout: 10000,
        success: (result) => {
          if (result.statusCode >= 200 && result.statusCode < 300) {
            resolve(result.data);
            return;
          }
          reject(apiError(result.data, result.statusCode, result.statusCode === 401 ? "检测站会话已失效，请重新登录" : "检测站服务暂时不可用"));
        },
        fail: (error) => reject(new Error(error.errMsg || "无法连接检测站服务")),
      });
    }),
  );
}

function operatorRequest<T>(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  return operatorRequestEnvelope<T>(path, method, data, headers).then((payload) => payload.data);
}

function normalizeBooking(raw: Booking): Booking {
  const canonical = raw.fulfillmentStatus;
  const status = canonical && canonical !== "legacy" ? canonical as BookingStatus : raw.status;
  return { ...raw, status, vehicleCheckupReport: raw.vehicleCheckupReport ? normalizeCheckupReport(raw.vehicleCheckupReport) : null };
}

export function normalizeBookingQuote(raw: BookingQuote): BookingQuote {
  const inspectionFeeFen = Number(raw.inspectionFeeFen || 0);
  const valetFeeFen = Number(raw.valetFeeFen || 0);
  const serviceFeeFen = Number(raw.serviceFeeFen ?? inspectionFeeFen + valetFeeFen);
  const breakdown = raw.breakdown || {
    inspectionFeeFen,
    valetBaseFeeFen: valetFeeFen,
    valetDistanceFeeFen: 0,
    valetFeeFen,
    totalFeeFen: serviceFeeFen,
  };
  return {
    ...raw,
    quoteSnapshotId: String(raw.quoteSnapshotId || ""),
    inspectionFeeFen,
    valetFeeFen,
    serviceFeeFen,
    extraKm: Number(raw.extraKm ?? 0),
    oneWayDistanceKm: raw.oneWayDistanceKm ?? raw.distanceKm ?? null,
    roundTripDistanceKm: raw.roundTripDistanceKm ?? null,
    billableDistanceKm: raw.billableDistanceKm ?? null,
    rule: raw.rule
      ? {
          baseFeeFen: Number(raw.rule.baseFeeFen || 0),
          includedKm: Number(raw.rule.includedKm || 0),
          perKmFen: Number(raw.rule.perKmFen || 0),
          maxRadiusKm: raw.rule.maxRadiusKm == null ? null : Number(raw.rule.maxRadiusKm),
        }
      : undefined,
    breakdown: {
      inspectionFeeFen: Number(breakdown.inspectionFeeFen ?? inspectionFeeFen),
      valetBaseFeeFen: Number(breakdown.valetBaseFeeFen ?? valetFeeFen),
      valetDistanceFeeFen: Number(breakdown.valetDistanceFeeFen ?? 0),
      valetFeeFen: Number(breakdown.valetFeeFen ?? valetFeeFen),
      totalFeeFen: Number(breakdown.totalFeeFen ?? serviceFeeFen),
    },
  };
}

export function washStoreImageUrl(path: string): string {
  return mediaUrl(path);
}

export function normalizeWashStore(raw: WashStore): WashStore {
  const images = (raw.images || []).map((image) => ({ ...image, url: washStoreImageUrl(image.url) }));
  const coverImageUrl = raw.coverImageUrl
    ? washStoreImageUrl(raw.coverImageUrl)
    : images.find((image) => image.isCover)?.url || images[0]?.url || null;
  return { ...raw, images, imageCount: raw.imageCount ?? images.length, coverImageUrl };
}

function normalizeCheckupMedia(raw: CheckupMedia): CheckupMedia {
  return { ...raw, url: mediaUrl(raw.url) };
}

async function localizedOperatorCheckupMedia(raw: CheckupMedia): Promise<CheckupMedia> {
  return { ...raw, url: await localizeOperatorMedia(raw.url).catch(() => "") };
}

async function localizedOperatorCheckupReport(report: VehicleCheckupReport): Promise<VehicleCheckupReport> {
  const fixed = report.sitePhotos || {};
  const annualInspection = report.annualInspection || {};
  return {
    ...report,
    media: await Promise.all((report.media || []).map(localizedOperatorCheckupMedia)),
    sitePhotos: {
      ...fixed,
      frontLeft: fixed.frontLeft ? await localizedOperatorCheckupMedia(fixed.frontLeft) : null,
      frontRight: fixed.frontRight ? await localizedOperatorCheckupMedia(fixed.frontRight) : null,
      rearLeft: fixed.rearLeft ? await localizedOperatorCheckupMedia(fixed.rearLeft) : null,
      rearRight: fixed.rearRight ? await localizedOperatorCheckupMedia(fixed.rearRight) : null,
      dashboardStarted: fixed.dashboardStarted ? await localizedOperatorCheckupMedia(fixed.dashboardStarted) : null,
    },
    annualInspection: {
      ...annualInspection,
      markPhoto: annualInspection.markPhoto ? await localizedOperatorCheckupMedia(annualInspection.markPhoto) : null,
    },
    faults: await Promise.all((report.faults || []).map(async (fault) => ({
      ...fault,
      photos: await Promise.all((fault.photos || []).map(localizedOperatorCheckupMedia)),
    }))),
  };
}

async function localizedOperatorBooking(raw: Booking): Promise<Booking> {
  return {
    ...raw,
    media: await Promise.all((raw.media || []).map(async (item) => ({
      ...item,
      url: await localizeOperatorMedia(item.url).catch(() => ""),
    }))),
    evidencePackages: await Promise.all((raw.evidencePackages || []).map(async (evidence) => ({
      ...evidence,
      photos: await Promise.all((evidence.photos || []).map(async (photo) => ({
        ...photo,
        url: await localizeOperatorMedia(photo.url).catch(() => ""),
      }))),
    }))),
    vehicleCheckupReport: raw.vehicleCheckupReport ? await localizedOperatorCheckupReport(raw.vehicleCheckupReport) : null,
  };
}

function normalizeRepairMedia(raw: RepairRequestMedia): RepairRequestMedia {
  const sourceUrl = mediaUrl(raw.sourceUrl || raw.url);
  return { ...raw, sourceUrl, url: sourceUrl };
}

function normalizeRepairFault(raw: RepairRequestFault): RepairRequestFault {
  return { ...raw, photos: (raw.photos || []).map(normalizeRepairMedia) };
}

function normalizeRepairQuote(raw: RepairRequestQuote): RepairRequestQuote {
  return {
    ...raw,
    totalPriceFen: Number(raw.totalPriceFen || 0),
    revision: Number(raw.revision || 1),
    shop: {
      ...raw.shop,
      distanceKm: Number(raw.shop?.distanceKm || 0),
      rating: Number(raw.shop?.rating || 0),
      isDemo: raw.shop?.isDemo !== false,
    },
  };
}

function normalizeRepairRequest(raw: RepairRequest): RepairRequest {
  return {
    ...raw,
    faults: (raw.faults || []).map(normalizeRepairFault),
    media: (raw.media || []).map(normalizeRepairMedia),
    quotes: (raw.quotes || []).map(normalizeRepairQuote),
    order: raw.order ? {
      ...raw.order,
      totalPriceFen: Number(raw.order.totalPriceFen || 0),
      shop: {
        ...raw.order.shop,
        distanceKm: Number(raw.order.shop?.distanceKm || 0),
        rating: Number(raw.order.shop?.rating || 0),
        isDemo: raw.order.shop?.isDemo !== false,
      },
      payment: {
        ...raw.order.payment,
        amountFen: Number(raw.order.payment?.amountFen || raw.order.totalPriceFen || 0),
      },
    } : null,
  };
}

export async function localizeOwnerRepairRequestPrivateMedia(
  raw: RepairRequest,
  localize: OwnerPrivateMediaLocalizer = localizeOwnerMedia,
): Promise<RepairRequest> {
  const repairRequest = normalizeRepairRequest(raw);
  return {
    ...repairRequest,
    media: await Promise.all((repairRequest.media || []).map((item) => localizedOwnerPrivateMedia(item, localize))),
    faults: await Promise.all((repairRequest.faults || []).map(async (fault) => ({
      ...fault,
      photos: await Promise.all((fault.photos || []).map((photo) => localizedOwnerPrivateMedia(photo, localize))),
    }))),
  };
}

function normalizeRepairRequestSummary(raw: RepairRequestSummary): RepairRequestSummary {
  return {
    ...raw,
    quoteCount: Number(raw.quoteCount || 0),
    lowestPriceFen: raw.lowestPriceFen == null ? null : Number(raw.lowestPriceFen),
  };
}

function normalizeCheckupReport(raw: VehicleCheckupReport): VehicleCheckupReport {
  const media = (raw.media || []).map(normalizeCheckupMedia);
  const byKind = (kind: CheckupMediaKind) => media.find((item) => item.kind === kind) || null;
  const sourcePhotos = raw.sitePhotos || {};
  const sitePhotos = {
    frontLeft: sourcePhotos.frontLeft ? normalizeCheckupMedia(sourcePhotos.frontLeft) : byKind("front_left"),
    frontRight: sourcePhotos.frontRight ? normalizeCheckupMedia(sourcePhotos.frontRight) : byKind("front_right"),
    rearLeft: sourcePhotos.rearLeft ? normalizeCheckupMedia(sourcePhotos.rearLeft) : byKind("rear_left"),
    rearRight: sourcePhotos.rearRight ? normalizeCheckupMedia(sourcePhotos.rearRight) : byKind("rear_right"),
    dashboardStarted: sourcePhotos.dashboardStarted ? normalizeCheckupMedia(sourcePhotos.dashboardStarted) : byKind("dashboard_started"),
  };
  const annualInspection = raw.annualInspection || { conclusion: null };
  const sourceLegalMaterials = raw.legalMaterials || {};
  const annualInspectionMark = sourceLegalMaterials.annualInspectionMark
    ? normalizeCheckupMedia(sourceLegalMaterials.annualInspectionMark)
    : byKind("annual_inspection_mark");
  const legalMaterials = {
    safetyInspectionReport: sourceLegalMaterials.safetyInspectionReport
      ? normalizeCheckupMedia(sourceLegalMaterials.safetyInspectionReport)
      : byKind("safety_inspection_report"),
    emissionsInspectionReport: sourceLegalMaterials.emissionsInspectionReport
      ? normalizeCheckupMedia(sourceLegalMaterials.emissionsInspectionReport)
      : byKind("emissions_inspection_report"),
    annualInspectionMark,
    status: sourceLegalMaterials.status || (annualInspection.conclusion === "failed" || (annualInspection.conclusion === "passed" && annualInspectionMark)
      ? "available"
      : raw.status === "published" ? "legacy_missing" : "pending"),
  } as VehicleCheckupReport["legalMaterials"];
  return {
    ...raw,
    diagramVersion: "sedan-3view-v1",
    observationMode: raw.observationMode || null,
    annualInspection: {
      ...annualInspection,
      markPhoto: annualInspection.markPhoto ? normalizeCheckupMedia(annualInspection.markPhoto) : byKind("annual_inspection_mark"),
    },
    legalMaterials,
    faults: (raw.faults || []).map((fault) => ({
      ...fault,
      photos: (fault.photos || []).map(normalizeCheckupMedia).sort((left, right) => (left.sequence || 0) - (right.sequence || 0)),
    })),
    media,
    sitePhotos,
  };
}

export type OwnerPrivateMediaLocalizer = (path: string, options?: { forceRefresh?: boolean }) => Promise<string>;

async function localizedOwnerPrivateMedia<T extends { url: string; sourceUrl?: string; loadState?: "loading" | "ready" | "failed" }>(
  raw: T,
  localize: OwnerPrivateMediaLocalizer,
): Promise<T> {
  const sourceUrl = raw.sourceUrl || raw.url;
  try {
    return { ...raw, sourceUrl, url: await localize(sourceUrl), loadState: "ready" };
  } catch {
    // Keep the protected source only as non-rendered retry metadata. Never hand
    // a naked private URL to <image> after an authenticated download failure.
    return { ...raw, sourceUrl, url: "", loadState: "failed" };
  }
}

export async function localizeOwnerCheckupReportMedia(
  report: VehicleCheckupReport,
  localize: OwnerPrivateMediaLocalizer = localizeOwnerMedia,
): Promise<VehicleCheckupReport> {
  const fixed = report.sitePhotos;
  const legal = report.legalMaterials;
  return {
    ...report,
    media: await Promise.all((report.media || []).map((item) => localizedOwnerPrivateMedia(item, localize))),
    sitePhotos: fixed ? {
      ...fixed,
      frontLeft: fixed.frontLeft ? await localizedOwnerPrivateMedia(fixed.frontLeft, localize) : null,
      frontRight: fixed.frontRight ? await localizedOwnerPrivateMedia(fixed.frontRight, localize) : null,
      rearLeft: fixed.rearLeft ? await localizedOwnerPrivateMedia(fixed.rearLeft, localize) : null,
      rearRight: fixed.rearRight ? await localizedOwnerPrivateMedia(fixed.rearRight, localize) : null,
      dashboardStarted: fixed.dashboardStarted ? await localizedOwnerPrivateMedia(fixed.dashboardStarted, localize) : null,
    } : fixed,
    legalMaterials: legal ? {
      ...legal,
      safetyInspectionReport: legal.safetyInspectionReport ? await localizedOwnerPrivateMedia(legal.safetyInspectionReport, localize) : null,
      emissionsInspectionReport: legal.emissionsInspectionReport ? await localizedOwnerPrivateMedia(legal.emissionsInspectionReport, localize) : null,
      annualInspectionMark: legal.annualInspectionMark ? await localizedOwnerPrivateMedia(legal.annualInspectionMark, localize) : null,
    } : legal,
    annualInspection: {
      ...report.annualInspection,
      markPhoto: report.annualInspection?.markPhoto
        ? await localizedOwnerPrivateMedia(report.annualInspection.markPhoto, localize)
        : null,
    },
    faults: await Promise.all((report.faults || []).map(async (fault) => ({
      ...fault,
      photos: await Promise.all((fault.photos || []).map((photo) => localizedOwnerPrivateMedia(photo, localize))),
    }))),
  };
}

export async function localizeOwnerBookingPrivateMedia(
  booking: Booking,
  localize: OwnerPrivateMediaLocalizer = localizeOwnerMedia,
): Promise<Booking> {
  return {
    ...booking,
    media: await Promise.all((booking.media || []).map((item) => localizedOwnerPrivateMedia(item, localize))),
    vehicleCheckupReport: booking.vehicleCheckupReport
      ? await localizeOwnerCheckupReportMedia(booking.vehicleCheckupReport, localize)
      : null,
  };
}

function reportListVehicle(raw: VehicleCheckupReportVehicleSummary): VehicleCheckupReportVehicleSummary {
  return {
    id: String(raw?.id || ""),
    plateNumber: String(raw?.plateNumber || "待补充车牌"),
    vehicleType: String(raw?.vehicleType || ""),
    brandName: raw?.brandName ? String(raw.brandName) : null,
    modelName: raw?.modelName ? String(raw.modelName) : null,
    displayName: String(raw?.displayName || [raw?.brandName, raw?.modelName].filter(Boolean).join(" ") || raw?.vehicleType || "车辆档案"),
  };
}

function reportListStation(raw: VehicleCheckupReportStationSummary): VehicleCheckupReportStationSummary {
  return {
    id: String(raw?.id || ""),
    name: String(raw?.name || "机动车检测站"),
    district: String(raw?.district || ""),
    address: String(raw?.address || ""),
  };
}

function count(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeReportSummary(raw: VehicleCheckupReportSummary): VehicleCheckupReportSummary {
  return {
    ...raw,
    bookingId: String(raw.bookingId || ""),
    bookingNumber: String(raw.bookingNumber || ""),
    reportId: String(raw.reportId || ""),
    reportNo: String(raw.reportNo || ""),
    schemaVersion: String(raw.schemaVersion || "vehicle-checkup-v1"),
    publishedAt: String(raw.publishedAt || ""),
    retainUntil: raw.retainUntil ? String(raw.retainUntil) : null,
    vehicle: reportListVehicle(raw.vehicle),
    station: reportListStation(raw.station),
    faultCount: count(raw.faultCount),
    sitePhotoCount: count(raw.sitePhotoCount),
    faultPhotoCount: count(raw.faultPhotoCount),
    photoCount: count(raw.photoCount),
    hasAnnualMark: raw.hasAnnualMark === true,
    hasSafetyInspectionReport: raw.hasSafetyInspectionReport === true,
    hasEmissionsInspectionReport: raw.hasEmissionsInspectionReport === true,
    legalMaterialsStatus: raw.legalMaterialsStatus
      || (raw.conclusion === "failed" || (raw.conclusion === "passed" && raw.hasAnnualMark === true) ? "available" : "legacy_missing"),
  };
}

function normalizeReportProgress(raw: VehicleCheckupReportProgress): VehicleCheckupReportProgress {
  return {
    ...raw,
    bookingId: String(raw.bookingId || ""),
    bookingNumber: String(raw.bookingNumber || ""),
    vehicle: reportListVehicle(raw.vehicle),
    station: reportListStation(raw.station),
    resultReceivedAt: raw.resultReceivedAt ? String(raw.resultReceivedAt) : null,
    reportReady: raw.reportReady === true,
    updatedAt: String(raw.updatedAt || ""),
  };
}

export function normalizeVehicleCheckupReportList(
  raw: VehicleCheckupReportListData,
  meta: Record<string, unknown> = {},
): VehicleCheckupReportListPage {
  const items = (raw?.items || []).map(normalizeReportSummary).sort((left, right) => {
    const byPublishedAt = right.publishedAt.localeCompare(left.publishedAt);
    return byPublishedAt || right.reportId.localeCompare(left.reportId);
  });
  return {
    progress: (raw?.progress || []).map(normalizeReportProgress),
    items,
    limit: Math.max(1, count(meta.limit) || 20),
    nextCursor: typeof meta.nextCursor === "string" && meta.nextCursor ? meta.nextCursor : null,
  };
}

function normalizeWorkbench(raw: Workbench): Workbench {
  return { ...raw, bookings: (raw.bookings || []).map(normalizeBooking) };
}

type WashPackageDetails = Omit<Partial<WashPackage>, "vehicleCategory"> & {
  shortDescription?: string;
  serviceItems?: string[];
  includedItems?: string[];
  vehicleCategory?: WashVehicleCategory | "suv_mpv";
};

type WashPackagePayload = Omit<Partial<WashPackage>, "vehicleCategory"> & {
  offer?: WashPackagePayload;
  package?: WashPackageDetails;
  salePriceFen?: number;
  listPriceFen?: number;
  estimatedSettlementFen?: number;
  isAvailable?: boolean;
  vehicleCategory?: WashVehicleCategory | "suv_mpv";
};

type WashOrderSource = Omit<Partial<WashOrder>, "package" | "offer" | "status" | "serviceType" | "vehicleCategory"> & {
  status?: string;
  serviceType?: string;
  package?: WashPackagePayload;
  offer?: WashPackagePayload;
  slot?: Partial<WashSlot>;
  priceFen?: number;
  vehicleCategory?: WashVehicleCategory | "suv_mpv";
};

type WashOrderPayload = WashOrderSource & {
  order?: WashOrderSource;
  payment?: { redemptionCode?: string; verificationCode?: string };
};

function normalizeWashStatus(status?: string): WashOrder["status"] {
  if (status === "pending_payment" || status === "awaiting_redemption" || status === "redeemed" || status === "cancelled" || status === "refunded" || status === "expired") return status;
  if (status === "awaiting_verification" || status === "pending_verification") return "awaiting_redemption";
  if (status === "verified" || status === "completed") return "redeemed";
  return status ? "expired" : "pending_payment";
}

function normalizeWashVehicleCategory(value: unknown, vehicle?: { vehicleType?: string }): WashVehicleCategory {
  if (value === "sedan" || value === "suv" || value === "mpv") return value;
  if (value === "suv_mpv") return "suv";
  const descriptor = String(vehicle?.vehicleType || "");
  if (/MPV|商务/i.test(descriptor)) return "mpv";
  if (/SUV|越野/i.test(descriptor)) return "suv";
  return "sedan";
}

function normalizeWashPackage(raw: WashPackagePayload, fallbackStoreId = "", fallbackCategory?: WashVehicleCategory): WashPackage {
  const offer = raw.offer || raw;
  const details = offer.package || offer;
  const id = String(offer.packageId || details.packageId || details.id || offer.id || "");
  const serviceItems = details.serviceItems || details.includedItems || offer.serviceItems || offer.includedItems || [];
  return {
    ...details,
    id,
    packageId: id,
    storeId: String(offer.storeId || raw.storeId || fallbackStoreId),
    name: String(details.name || offer.name || "洗车套餐"),
    summary: String(details.summary || details.shortDescription || details.description || serviceItems.join(" + ")),
    serviceItems,
    includedItems: serviceItems,
    priceFen: Number(offer.salePriceFen ?? offer.priceFen ?? details.priceFen ?? 0),
    listPriceFen: offer.listPriceFen ?? details.listPriceFen,
    estimatedSettlementFen: offer.estimatedSettlementFen ?? details.estimatedSettlementFen,
    vehicleCategory: normalizeWashVehicleCategory(offer.vehicleCategory || details.vehicleCategory || fallbackCategory),
    durationMinutes: details.durationMinutes ?? offer.durationMinutes,
    isActive: offer.isAvailable ?? offer.isActive ?? details.isActive,
  };
}

function normalizeWashOrder(raw: WashOrderPayload): WashOrder {
  const source = raw.order || raw;
  const packagePayload = source.package || source.offer;
  const normalizedPackage = packagePayload ? normalizeWashPackage(packagePayload, String(source.storeId || "")) : undefined;
  const washFeeFen = Number(source.washFeeFen ?? source.serviceFeeFen ?? source.priceFen ?? normalizedPackage?.priceFen ?? 0);
  const valetFeeFen = Number(source.valetFeeFen ?? 0);
  const totalFeeFen = Number(source.totalFeeFen ?? washFeeFen + valetFeeFen);
  return {
    ...source,
    id: String(source.id || ""),
    serviceType: "car_wash",
    vehicleId: String(source.vehicleId || ""),
    storeId: String(source.storeId || source.store?.id || ""),
    packageId: String(source.packageId || normalizedPackage?.id || ""),
    slotId: String(source.slotId || source.slot?.id || ""),
    status: normalizeWashStatus(source.status),
    contactName: String(source.contactName || ""),
    contactPhone: String(source.contactPhone || ""),
    serviceMode: source.serviceMode === "valet" ? "valet" : "self_drive",
    tripType: source.serviceMode === "valet" ? "round_trip_same_address" : null,
    washFeeFen,
    valetFeeFen,
    serviceFeeFen: Number(source.serviceFeeFen ?? washFeeFen),
    vehicleCategory: normalizeWashVehicleCategory(source.vehicleCategory ?? source.vehicle?.washVehicleCategory, source.vehicle),
    totalFeeFen,
    pickupAddress: source.pickupAddress || null,
    oneWayDistanceKm: source.oneWayDistanceKm ?? null,
    roundTripDistanceKm: source.roundTripDistanceKm ?? null,
    billableDistanceKm: source.billableDistanceKm ?? null,
    driveMinutes: source.driveMinutes ?? null,
    extraKm: Number(source.extraKm ?? 0),
    distanceSource: source.distanceSource,
    distanceBasis: source.distanceBasis,
    valetRule: source.valetRule,
    breakdown: source.breakdown,
    appointmentDate: String(source.appointmentDate || source.slot?.date || ""),
    startTime: String(source.startTime || source.slot?.startTime || ""),
    endTime: source.endTime || source.slot?.endTime,
    redemptionCode: source.redemptionCode || source.verificationCode || raw.redemptionCode || raw.verificationCode || raw.payment?.redemptionCode || raw.payment?.verificationCode || null,
    package: normalizedPackage,
    offer: normalizedPackage,
    createdAt: String(source.createdAt || ""),
  };
}

function listFrom<T>(payload: T[] | { items?: T[]; stores?: T[]; offers?: T[]; packages?: T[]; slots?: T[]; orders?: T[] }): T[] {
  if (Array.isArray(payload)) return payload;
  return payload.items || payload.stores || payload.offers || payload.packages || payload.slots || payload.orders || [];
}

function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function normalizeUsedCarModel(raw: Partial<UsedCarModel>): UsedCarModel {
  return {
    id: String(raw.id || ""),
    name: String(raw.name || "未命名车系"),
    bodyType: String(raw.bodyType || ""),
    energyType: String(raw.energyType || "other"),
    listingCount: Number(raw.listingCount || 0),
  };
}

function normalizeUsedCarBrand(raw: Partial<UsedCarBrand>): UsedCarBrand {
  return {
    id: String(raw.id || ""),
    name: String(raw.name || "未命名品牌"),
    initial: String(raw.initial || "#").toUpperCase(),
    logoUrl: usedCarImageUrl(String(raw.logoUrl || "")),
    isHot: Boolean(raw.isHot),
    listingCount: Number(raw.listingCount || 0),
    models: Array.isArray(raw.models) ? raw.models.map(normalizeUsedCarModel) : [],
  };
}

type UsedCarImagePayload = Partial<UsedCarImage> | string;
type UsedCarListingPayload = Partial<Omit<UsedCarListing, "images" | "brand" | "model">> & {
  images?: UsedCarImagePayload[];
  brand?: Partial<UsedCarBrand>;
  model?: Partial<UsedCarModel>;
  coverImageUrl?: string | null;
};

function normalizeUsedCarImage(raw: UsedCarImagePayload, index: number): UsedCarImage {
  if (typeof raw === "string") return { id: `image-${index}`, url: usedCarImageUrl(raw), sortOrder: index, isCover: index === 0 };
  return {
    id: String(raw.id || `image-${index}`),
    url: usedCarImageUrl(String(raw.url || "")),
    sortOrder: Number(raw.sortOrder ?? index),
    isCover: Boolean(raw.isCover ?? index === 0),
    alt: raw.alt ? String(raw.alt) : undefined,
  };
}

function normalizeUsedCarListing(raw: UsedCarListingPayload): UsedCarListing {
  const images = (Array.isArray(raw.images) ? raw.images : []).map(normalizeUsedCarImage).sort((left, right) => left.sortOrder - right.sortOrder);
  const coverUrl = images.find((image) => image.isCover)?.url || images[0]?.url || usedCarImageUrl(String(raw.coverImageUrl || ""));
  return {
    id: String(raw.id || ""),
    stockNo: String(raw.stockNo || ""),
    title: String(raw.title || "未命名二手车"),
    brand: normalizeUsedCarBrand(raw.brand || {}),
    model: normalizeUsedCarModel(raw.model || {}),
    modelYear: Number(raw.modelYear || 0),
    registrationDate: String(raw.registrationDate || ""),
    mileageKm: Number(raw.mileageKm || 0),
    priceFen: Number(raw.priceFen || 0),
    originalPriceFen: raw.originalPriceFen == null ? null : Number(raw.originalPriceFen),
    location: String(raw.location || ""),
    exteriorColor: String(raw.exteriorColor || ""),
    interiorColor: String(raw.interiorColor || ""),
    energyType: String(raw.energyType || raw.model?.energyType || "other"),
    transmission: String(raw.transmission || ""),
    seats: Number(raw.seats || 0),
    highlights: Array.isArray(raw.highlights) ? raw.highlights.map(String) : [],
    description: String(raw.description || ""),
    status: String(raw.status || "on_sale"),
    dataKind: String(raw.dataKind || ""),
    isSynthetic: Boolean(raw.isSynthetic),
    publishedAt: String(raw.publishedAt || ""),
    images,
    coverUrl,
  };
}

function normalizeUsedCarCatalog(raw: Partial<UsedCarCatalog>): UsedCarCatalog {
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).map((group) => ({
    initial: String(group.initial || "#").toUpperCase(),
    brands: (Array.isArray(group.brands) ? group.brands : []).map(normalizeUsedCarBrand),
  }));
  return { groups, hotBrands: (Array.isArray(raw.hotBrands) ? raw.hotBrands : []).map(normalizeUsedCarBrand) };
}

type RentalPayload = Record<string, any>;

export function rentalImageUrl(path: unknown): string {
  const value = String(path || "").trim();
  if (!value) return "/assets/brand/hero-car-tianjin.jpg";
  return mediaUrl(value);
}

function rentalBodyType(value: unknown): string {
  const raw = String(value || "").toLowerCase();
  if (raw === "sedan") return "轿车";
  if (raw === "suv") return "SUV";
  if (raw === "mpv") return "MPV";
  if (raw === "hatchback") return "两厢车";
  return String(value || "轿车");
}

function rentalTransmission(value: unknown): string {
  const raw = String(value || "").toLowerCase();
  if (raw === "automatic") return "自动挡";
  if (raw === "manual") return "手动挡";
  if (raw === "single_speed") return "单速变速箱";
  if (raw === "cvt") return "CVT无级变速";
  if (raw === "dct") return "双离合";
  if (raw === "e_cvt") return "E-CVT";
  return String(value || "自动挡");
}

function rentalFuelPolicy(value: unknown): string {
  const raw = String(value || "");
  if (raw === "same_level_return") return "同油位归还；差额按订单规则结算";
  if (raw === "same_soc_return") return "同电量归还；差额按订单规则结算";
  if (raw === "full_to_full") return "满油取还";
  return raw || "同油位或同电量归还";
}

function canonicalRentalEnergy(value: unknown): CarRentalModel["energyType"] {
  const raw = String(value || "other").toLowerCase();
  if (raw === "petrol" || raw === "fuel") return "gasoline";
  if (raw === "electric" || raw === "ev") return "pure_electric";
  if (raw === "phev") return "plug_in_hybrid";
  if (raw === "erev") return "range_extended";
  if (["gasoline", "diesel", "hybrid", "plug_in_hybrid", "range_extended", "pure_electric"].includes(raw)) {
    return raw as CarRentalModel["energyType"];
  }
  return "other";
}

function normalizeRentalImage(raw: unknown, index: number): CarRentalModel["images"][number] {
  if (typeof raw === "string") {
    return { id: `rental-image-${index}`, url: rentalImageUrl(raw), sortOrder: index, isCover: index === 0 };
  }
  const item = (raw || {}) as RentalPayload;
  return {
    id: String(item.id || `rental-image-${index}`),
    url: rentalImageUrl(item.url || item.imageUrl),
    sortOrder: Number(item.sortOrder ?? index),
    isCover: Boolean(item.isCover ?? index === 0),
    alt: item.alt ? String(item.alt) : undefined,
  };
}

function normalizeRentalModel(rawValue: unknown, brandValue?: unknown): CarRentalModel {
  const raw = (rawValue || {}) as RentalPayload;
  const brand = (brandValue || raw.brand || {}) as RentalPayload;
  const pricing = (raw.pricing || raw.ratePlan || {}) as RentalPayload;
  const policy = (raw.policy || raw.policies || {}) as RentalPayload;
  const rawImages = Array.isArray(raw.images) ? raw.images : [];
  const images = rawImages.map(normalizeRentalImage).sort((left, right) => left.sortOrder - right.sortOrder);
  const imageUrl = rentalImageUrl(raw.imageUrl || raw.coverUrl || raw.coverImageUrl || images.find((item) => item.isCover)?.url || images[0]?.url);
  if (!images.length && imageUrl) images.push({ id: `${String(raw.id || "model")}-cover`, url: imageUrl, sortOrder: 0, isCover: true });
  return {
    id: String(raw.id || raw.modelId || ""),
    brandId: String(raw.brandId || brand.id || ""),
    brandName: String(raw.brandName || brand.name || ""),
    brandLogoUrl: raw.brandLogoUrl || brand.logoUrl ? rentalImageUrl(raw.brandLogoUrl || brand.logoUrl) : "",
    name: String(raw.name || raw.modelName || "租赁车型"),
    bodyType: rentalBodyType(raw.bodyType),
    energyType: canonicalRentalEnergy(raw.energyType || raw.powertrainType),
    seats: Number(raw.seats || 5),
    transmission: rentalTransmission(raw.transmission),
    luggage: Number(raw.luggage ?? raw.luggageCount ?? 2),
    imageUrl,
    images,
    availableCount: Number(raw.availableCount ?? raw.rentableCount ?? raw.vehicleCount ?? raw.availability?.availableCount ?? 0),
    minDailyRateFen: Number(raw.minDailyRateFen ?? raw.dailyRateFen ?? pricing.dailyRateFen ?? pricing.weekdayRateFen ?? 0),
    vehicleDepositFen: Number(raw.vehicleDepositFen ?? pricing.vehicleDepositFen ?? 300000),
    mileagePolicy: String(raw.mileagePolicy || policy.mileagePolicy || (policy.includedMileageKmPerDay == null ? "基础租金含不限里程" : `每日含 ${Number(policy.includedMileageKmPerDay)}km，超出按 ¥${(Number(policy.overagePerKmFen || 0) / 100).toFixed(2)}/km`)),
    energyPolicy: String(raw.energyPolicy || policy.energyPolicy || rentalFuelPolicy(policy.fuelPolicy)),
    cancellationPolicy: String(raw.cancellationPolicy || policy.cancellationPolicy || "取车前按页面规则可取消"),
    highlights: Array.isArray(raw.highlights) ? raw.highlights.map(String) : ["指定车型保障"],
  };
}

function normalizeRentalBrand(rawValue: unknown): CarRentalBrand {
  const raw = (rawValue || {}) as RentalPayload;
  const brandCore = {
    id: String(raw.id || raw.brandId || ""),
    name: String(raw.name || raw.brandName || "未命名品牌"),
    initial: String(raw.initial || raw.pinyinInitial || "#").toUpperCase(),
    logoUrl: raw.logoUrl ? rentalImageUrl(raw.logoUrl) : "",
    isHot: Boolean(raw.isHot),
    availableCount: Number(raw.availableCount ?? raw.rentableCount ?? raw.vehicleCount ?? raw.listingCount ?? 0),
  };
  return {
    ...brandCore,
    models: (Array.isArray(raw.models) ? raw.models : []).map((model) => normalizeRentalModel(model, brandCore)),
  };
}

function normalizeRentalCatalog(rawValue: unknown): CarRentalCatalog {
  const raw = (rawValue || {}) as RentalPayload;
  const sourceGroups = Array.isArray(raw.groups) ? raw.groups : [];
  let groups = sourceGroups.map((groupValue: unknown) => {
    const group = (groupValue || {}) as RentalPayload;
    return {
      initial: String(group.initial || "#").toUpperCase(),
      brands: (Array.isArray(group.brands) ? group.brands : []).map(normalizeRentalBrand),
    };
  }).filter((group: { initial: string; brands: CarRentalBrand[] }) => group.brands.length > 0);
  if (!groups.length && Array.isArray(raw.brands)) {
    const grouped = new Map<string, CarRentalBrand[]>();
    raw.brands.map(normalizeRentalBrand).forEach((brand: CarRentalBrand) => {
      const list = grouped.get(brand.initial) || [];
      list.push(brand);
      grouped.set(brand.initial, list);
    });
    groups = Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([initial, brands]) => ({ initial, brands }));
  }
  const allBrands = groups.flatMap((group) => group.brands);
  const hotBrands = (Array.isArray(raw.hotBrands) ? raw.hotBrands.map(normalizeRentalBrand) : allBrands.filter((brand) => brand.isHot)).slice(0, 10);
  return {
    groups,
    hotBrands,
    disclosure: {
      kind: "synthetic_demo",
      label: String(raw.disclosure?.label || "合成演示数据"),
      message: String(raw.disclosure?.message || "车型、库存、价格与订单均为合成演示数据"),
    },
  };
}

function normalizeRentalStore(rawValue: unknown): CarRentalStore {
  const raw = (rawValue || {}) as RentalPayload;
  const rule = (raw.deliveryRule || raw.deliveryPricing || {}) as RentalPayload;
  return {
    id: String(raw.id || raw.storeId || ""),
    name: String(raw.name || "租赁门店"),
    district: String(raw.district || ""),
    address: String(raw.address || ""),
    openHours: String(raw.openHours || "08:00-20:00"),
    phone: raw.phone == null ? null : String(raw.phone),
    latitude: Number(raw.latitude || 0),
    longitude: Number(raw.longitude || 0),
    isActive: raw.isActive !== false,
    deliveryEnabled: raw.deliveryEnabled !== false,
    deliveryRule: Object.keys(rule).length ? {
      baseFeeFen: Number(rule.baseFeeFen ?? 2900),
      includedKm: Number(rule.includedKm ?? 3),
      perKmFen: Number(rule.perKmFen ?? 600),
      maxRadiusKm: Number(rule.maxRadiusKm ?? 20),
    } : null,
  };
}

function normalizeRentalOffer(rawValue: unknown): CarRentalOffer {
  const raw = (rawValue || {}) as RentalPayload;
  const pricing = (raw.pricing || raw.price || raw.breakdown || {}) as RentalPayload;
  const model = normalizeRentalModel(raw.model || raw, raw.brand);
  const vehicleRentFen = Number(raw.vehicleRentFen ?? raw.rentalFeeFen ?? pricing.vehicleRentFen ?? pricing.rentalFeeFen ?? 0);
  const mandatoryFeeFen = Number(raw.mandatoryFeeFen ?? pricing.mandatoryFeeFen ?? 0);
  const basicProtectionFen = Number(raw.basicProtectionFen ?? pricing.basicProtectionFen ?? mandatoryFeeFen);
  const preparationFeeFen = Number(raw.preparationFeeFen ?? pricing.preparationFeeFen ?? 0);
  const deliveryFeeFen = Number(raw.deliveryFeeFen ?? pricing.deliveryFeeFen ?? 0);
  const estimatedTotalFen = Number(raw.estimatedTotalFen ?? raw.prepaidTotalFen ?? raw.totalFeeFen ?? pricing.estimatedTotalFen ?? pricing.prepaidTotalFen ?? pricing.totalFeeFen ?? vehicleRentFen + basicProtectionFen + preparationFeeFen + deliveryFeeFen);
  return {
    id: String(raw.id || raw.offerId || model.id),
    storeId: String(raw.storeId || raw.store?.id || ""),
    storeName: String(raw.storeName || raw.store?.name || ""),
    model,
    availableCount: Number(raw.availableCount ?? raw.availability?.availableCount ?? raw.availability ?? model.availableCount),
    rentalDays: Number(raw.rentalDays || raw.billableDays || pricing.rentalDays || 1),
    dailyRateFen: Number(raw.averageDailyRateFen ?? raw.dailyRateFen ?? pricing.dailyRateFen ?? model.minDailyRateFen),
    vehicleRentFen,
    basicProtectionFen,
    preparationFeeFen,
    deliveryFeeFen,
    estimatedTotalFen,
    priceLabel: String(raw.priceLabel || "已含必缴费"),
    exactModelGuaranteed: raw.exactModelGuaranteed !== false,
  };
}

function normalizeRentalQuote(rawValue: unknown, fallback?: { model?: CarRentalModel; store?: CarRentalStore; search?: CarRentalSearch; includeOptionalProtection?: boolean }): CarRentalQuote {
  const raw = (rawValue || {}) as RentalPayload;
  const source = (raw.quote || raw) as RentalPayload;
  const breakdownRaw = (source.breakdown || source.feeBreakdown || source.pricing || {}) as RentalPayload;
  const depositsRaw = (source.deposits || {}) as RentalPayload;
  const model = normalizeRentalModel(source.model || fallback?.model || {}, source.brand);
  const store = normalizeRentalStore(source.store || fallback?.store || { id: source.storeId || fallback?.search?.storeId });
  const vehicleRentFen = Number(breakdownRaw.vehicleRentFen ?? breakdownRaw.rentalFeeFen ?? source.vehicleRentFen ?? source.rentalFeeFen ?? 0);
  const basicProtectionFen = Number(breakdownRaw.basicProtectionFen ?? breakdownRaw.basicProtectionFeeFen ?? source.basicProtectionFen ?? 0);
  const preparationFeeFen = Number(breakdownRaw.preparationFeeFen ?? breakdownRaw.prepFeeFen ?? source.preparationFeeFen ?? 0);
  const optionalProtectionFen = Number(breakdownRaw.optionalProtectionFen ?? breakdownRaw.optionalProtectionFeeFen ?? source.optionalProtectionFen ?? 0);
  const deliveryFeeFen = Number(breakdownRaw.deliveryFeeFen ?? source.deliveryFeeFen ?? 0);
  const prepaidTotalFen = Number(breakdownRaw.prepaidTotalFen ?? breakdownRaw.totalFeeFen ?? source.prepaidTotalFen ?? source.totalFeeFen ?? vehicleRentFen + basicProtectionFen + preparationFeeFen + optionalProtectionFen + deliveryFeeFen);
  return {
    id: String(source.id || source.quoteSnapshotId || ""),
    quoteSnapshotId: String(source.quoteSnapshotId || source.id || ""),
    expiresAt: String(source.expiresAt || ""),
    fulfillmentMode: source.serviceMode === "home_delivery" || source.fulfillmentMode === "home_delivery" || fallback?.search?.fulfillmentMode === "home_delivery" ? "home_delivery" : "store_pickup",
    store,
    model,
    deliveryAddress: source.deliveryAddress || source.pickupAddress || fallback?.search?.deliveryAddress || null,
    pickupAt: String(source.pickupAt || fallback?.search?.pickupAt || ""),
    returnAt: String(source.returnAt || fallback?.search?.returnAt || ""),
    rentalDays: Number(source.rentalDays || source.billableDays || 1),
    includeOptionalProtection: Boolean(source.addOptionalProtection ?? source.includeOptionalProtection ?? fallback?.includeOptionalProtection),
    breakdown: { vehicleRentFen, basicProtectionFen, preparationFeeFen, optionalProtectionFen, deliveryFeeFen, prepaidTotalFen },
    deposits: {
      vehicleDepositFen: Number(depositsRaw.vehicleDepositFen ?? source.vehicleDepositFen ?? model.vehicleDepositFen),
      violationDepositFen: Number(depositsRaw.violationDepositFen ?? source.violationDepositFen ?? 200000),
      includedInPrepaid: false,
    },
    route: source.route ? {
      distanceKm: Number(source.route.distanceKm ?? source.route.oneWayDistanceKm ?? 0),
      driveMinutes: source.route.driveMinutes == null ? null : Number(source.route.driveMinutes),
      source: source.route.source === "tencent" || source.route.distanceSource === "tencent_matrix" ? "tencent" : "other",
    } : null,
    disclosure: String(source.disclosure || "本页为合成演示报价，不发生真实扣款或押金冻结"),
  };
}

function normalizeRentalOrder(rawValue: unknown): CarRentalOrder {
  const raw = (rawValue || {}) as RentalPayload;
  const source = (raw.order || raw) as RentalPayload;
  const quote = normalizeRentalQuote(source.quote || source.quoteSnapshot || source, {
    model: normalizeRentalModel(source.model || {}, source.brand),
    store: normalizeRentalStore(source.store || { id: source.storeId }),
    search: {
      fulfillmentMode: source.serviceMode === "home_delivery" || source.fulfillmentMode === "home_delivery" ? "home_delivery" : "store_pickup",
      storeId: String(source.storeId || source.store?.id || ""),
      deliveryAddress: source.deliveryAddress || null,
      pickupAt: String(source.pickupAt || ""),
      returnAt: String(source.returnAt || ""),
    },
  });
  const status = String(source.status || "pending_payment") as CarRentalOrder["status"];
  return {
    id: String(source.id || ""),
    orderNumber: String(source.orderNumber || source.orderNo || ""),
    status,
    paymentStatus: source.paymentStatus === "paid" || status !== "pending_payment" && !["cancelled", "expired"].includes(status) ? "paid" : source.paymentStatus === "refunded" ? "refunded" : "unpaid",
    fulfillmentMode: source.serviceMode === "home_delivery" || source.fulfillmentMode === "home_delivery" ? "home_delivery" : "store_pickup",
    store: normalizeRentalStore(source.store || quote.store),
    model: normalizeRentalModel(source.model || quote.model, source.brand),
    deliveryAddress: source.deliveryAddress || quote.deliveryAddress || null,
    pickupAt: String(source.pickupAt || quote.pickupAt),
    returnAt: String(source.returnAt || quote.returnAt),
    rentalDays: Number(source.rentalDays || source.billableDays || quote.rentalDays),
    contactName: String(source.contactName || source.driverName || ""),
    contactPhoneMasked: String(source.contactPhoneMasked || source.driverPhoneMasked || source.maskedPhone || source.contactPhone || ""),
    quote,
    assignedVehicle: source.assignedVehicle || null,
    createdAt: String(source.createdAt || ""),
    updatedAt: String(source.updatedAt || source.createdAt || ""),
    events: Array.isArray(source.events) ? source.events : [],
  };
}

function rentalSearchPayload(search: CarRentalSearch): Record<string, unknown> {
  return {
    serviceMode: search.fulfillmentMode,
    storeId: search.fulfillmentMode === "store_pickup" ? search.storeId : undefined,
    pickupAt: search.pickupAt,
    returnAt: search.returnAt,
    deliveryAddress: search.fulfillmentMode === "home_delivery" ? search.deliveryAddress : undefined,
    brandId: search.brandId,
    energyType: search.energyType,
    sort: search.sort,
  };
}

function normalizeInsuranceDisclosure(raw: Partial<InsuranceDisclosure>): InsuranceDisclosure {
  const dataScope = Array.isArray(raw.dataScope) ? raw.dataScope.map(String).filter(Boolean) : [];
  const version = String(raw.version || "");
  if (!version) throw new Error("信息使用说明缺少版本号，请稍后重试");
  const partner = raw.partner || { id: "", name: "", recipientName: "" };
  const items = dataScope.length ? dataScope : [
    "车辆与联系方式仅用于识别本次需求并安排服务人员联系。",
    "驭小满仅提供需求登记与服务对接，不提供保险报价或承保。",
    "您可以凭提交凭证撤回尚未完成对接的需求。",
  ];
  return {
    mode: raw.mode === "real" ? "real" : "demo",
    version,
    title: String(raw.title || "信息使用说明"),
    summary: String(raw.summary || raw.consentText || "仅将本次需求所需信息用于车险续保服务对接。"),
    items,
    acceptsRealData: raw.acceptsRealData === true,
    partner: {
      id: String(partner.id || "platform-service-team"),
      name: String(partner.name || "驭小满服务团队"),
      recipientName: String(partner.recipientName || partner.name || "驭小满服务团队"),
    },
    dataScope: items,
    purpose: String(raw.purpose || "识别车辆续保需求并安排服务对接"),
    retention: String(raw.retention || "按信息使用说明约定保存并清理"),
    consentText: String(raw.consentText || "我同意按本说明使用本次提交的信息"),
    contactEtaText: String(raw.contactEtaText || "1个工作日内"),
  };
}

function normalizeVehicle(raw: Vehicle): Vehicle {
  const rawWashCategory = raw.washVehicleCategory;
  return {
    ...raw,
    washVehicleCategory: normalizeWashVehicleCategory(rawWashCategory, raw),
    washVehicleCategoryLegacy: rawWashCategory === "suv_mpv",
    brand: raw.brand ? { id: String(raw.brand.id), name: String(raw.brand.name) } : null,
    model: raw.model ? { id: String(raw.model.id), name: String(raw.model.name) } : null,
    visual: raw.visual
      ? { ...raw.visual, imageUrl: mediaUrl(raw.visual.imageUrl) }
      : null,
  };
}

const localOwnerVehicleBrandIds = new Set([
  "brand-mercedes", "brand-bmw", "brand-audi", "brand-tesla", "brand-byd", "brand-li",
]);

function normalizeVehicleCatalog(raw: VehicleCatalog): VehicleCatalog {
  return {
    disclosure: raw.disclosure,
    brands: (raw.brands || []).map((brand) => ({
      ...brand,
      logoUrl: localOwnerVehicleBrandIds.has(brand.id) ? `/assets/vehicles/logos/${brand.id}.png` : "",
      models: (brand.models || []).map((model) => ({
        ...model,
        imageUrl: mediaUrl(model.imageUrl),
      })),
    })),
  };
}

type InsuranceReceiptPayload = { receipt?: Partial<InsuranceLeadReceipt> } | Partial<InsuranceLeadReceipt>;

function normalizeInsuranceReceipt(payload: InsuranceReceiptPayload): InsuranceLeadReceipt {
  const raw = "receipt" in payload && payload.receipt ? payload.receipt : payload as Partial<InsuranceLeadReceipt>;
  const vehicle = raw.vehicle || { plateNumber: "", modelName: "" };
  return {
    leadCode: String(raw.leadCode || ""),
    submittedAt: String(raw.submittedAt || new Date().toISOString()),
    vehicle: {
      ...(vehicle.id ? { id: String(vehicle.id) } : {}),
      plateNumber: String(vehicle.plateNumber || "已选车辆"),
      modelName: String(vehicle.modelName || "车辆信息待确认"),
    },
    maskedPhone: String(raw.maskedPhone || "已保护"),
    contactEtaText: String(raw.contactEtaText || "1个工作日内"),
    withdrawToken: String(raw.withdrawToken || ""),
    duplicate: Boolean(raw.duplicate),
    status: raw.status ? String(raw.status) : "submitted",
  };
}

type SubsidyPayload = Record<string, any>;

function subsidyMoneyFen(rawValue: unknown, fieldLabel: string): number {
  if (typeof rawValue !== "number" || !Number.isSafeInteger(rawValue) || rawValue < 0) {
    throw new Error(`补贴咨询${fieldLabel}无效，请重新获取后台价格`);
  }
  return rawValue;
}

function normalizeSubsidyAdministrativeFees(rawValue: unknown): SubsidyAdministrativeFees {
  const raw = (rawValue || {}) as SubsidyPayload;
  return {
    plateFeeFen: subsidyMoneyFen(raw.plateFeeFen, "牌照费"),
    mailingFeeFen: subsidyMoneyFen(raw.mailingFeeFen, "邮寄费"),
    productionFeeFen: subsidyMoneyFen(raw.productionFeeFen, "制作工本费"),
  };
}

function validateSubsidyBreakdown(
  consultationFeeFen: number,
  administrativeFees: SubsidyAdministrativeFees,
  administrativeFeeFen: number,
  totalTransferCostFen: number,
): void {
  const administrativeItemsTotal = administrativeFees.plateFeeFen
    + administrativeFees.mailingFeeFen
    + administrativeFees.productionFeeFen;
  if (administrativeFeeFen !== administrativeItemsTotal || totalTransferCostFen !== consultationFeeFen + administrativeFeeFen) {
    throw new Error("补贴咨询费用明细不一致，请重新获取后台价格");
  }
}

function normalizeSubsidyTier(rawValue: unknown, index = 0, expectedAdministrativeFeeFen?: number): SubsidyFeeTier {
  const raw = (rawValue || {}) as SubsidyPayload;
  const feeFen = subsidyMoneyFen(raw.feeFen, "咨询服务费");
  const totalTransferCostFen = subsidyMoneyFen(raw.totalTransferCostFen, "过户费用参考合计");
  if (expectedAdministrativeFeeFen !== undefined && totalTransferCostFen !== feeFen + expectedAdministrativeFeeFen) {
    throw new Error("补贴咨询档位费用明细不一致，请重新获取后台价格");
  }
  return {
    id: String(raw.id || `tier-${index + 1}`),
    label: String(raw.label || "车辆估值档位"),
    minValueFen: Number(raw.minValueFen || 0),
    maxValueFen: Number(raw.maxValueFen || 0),
    feeFen,
    totalTransferCostFen,
    sortOrder: Number(raw.sortOrder ?? index),
  };
}

export function normalizeSubsidyConfig(rawValue: unknown): SubsidyConsultationConfig {
  const raw = (rawValue || {}) as SubsidyPayload;
  const disclosure = (raw.disclosure || {}) as SubsidyPayload;
  const feePlan = (raw.feePlan || {}) as SubsidyPayload;
  const serviceBoundary = (raw.serviceBoundary || {}) as SubsidyPayload;
  const version = String(disclosure.version || "");
  const planVersion = String(feePlan.version || "");
  if (!version || !planVersion) throw new Error("补贴咨询配置暂不可用，请稍后重试");
  const fallbackScope = [
    "联系人姓名和手机号",
    "身份证正反面、行驶证主页与副页",
    "五张车辆咨询参考照片",
  ];
  const dataScope = Array.isArray(disclosure.dataScope) && disclosure.dataScope.length
    ? disclosure.dataScope.map(String)
    : fallbackScope;
  const summaryText = String(disclosure.summaryText || disclosure.purpose || "本服务仅提供合法补贴政策与材料准备咨询");
  const retentionText = String(disclosure.retentionText || disclosure.retention || "按信息使用说明约定保存并清理");
  const administrativeFees = normalizeSubsidyAdministrativeFees(feePlan.administrativeFees);
  const administrativeFeeFen = subsidyMoneyFen(feePlan.administrativeFeeFen, "行政收费参考小计");
  validateSubsidyBreakdown(0, administrativeFees, administrativeFeeFen, administrativeFeeFen);
  return {
    mode: raw.mode === "real" ? "real" : "demo",
    acceptsRealData: raw.acceptsRealData === true,
    materialUploadMode: raw.materialUploadMode === "multipart" && raw.acceptsRealData === true ? "multipart" : "server_generated_demo",
    materialUploadEndpoint: raw.materialUploadEndpoint ? String(raw.materialUploadEndpoint) : null,
    demoMaterialEndpoint: raw.demoMaterialEndpoint ? String(raw.demoMaterialEndpoint) : null,
    demoContact: normalizeSubsidyDemoContact(raw.mode, raw.demoContact),
    maxDeclaredValueFen: Math.min(50000000, Number(raw.maxDeclaredValueFen || 50000000)),
    quoteValiditySeconds: Number(raw.quoteValiditySeconds || 600),
    disclosure: {
      version,
      title: String(disclosure.title || "敏感信息使用说明"),
      summaryText,
      dataScope,
      purpose: String(disclosure.purpose || summaryText),
      retention: String(disclosure.retention || retentionText),
      retentionText,
      consentText: String(disclosure.consentText || "我已阅读并同意信息使用说明"),
      legalPurposeText: String(disclosure.legalPurposeText || "我确认资料真实、来源合法，仅用于本人车辆的合法政策与材料咨询。"),
      contactEtaText: String(disclosure.contactEtaText || "1个工作日内联系"),
      officialSourceUrl: String(disclosure.officialSourceUrl || ""),
      modeNotice: String(disclosure.modeNotice || (raw.mode === "real" ? "资料将按已披露目的加密处理。" : "当前为演示模式，请勿上传真实个人证件或车辆资料。")),
    },
    feePlan: {
      version: planVersion,
      active: feePlan.active !== false,
      administrativeFees,
      administrativeFeeFen,
      tiers: (Array.isArray(feePlan.tiers) ? feePlan.tiers : [])
        .map((tier: unknown, index: number) => normalizeSubsidyTier(tier, index, administrativeFeeFen))
        .sort((left, right) => left.sortOrder - right.sortOrder || left.maxValueFen - right.maxValueFen),
    },
    materialKinds: (Array.isArray(raw.materialKinds) ? raw.materialKinds : []).map((itemValue: unknown) => {
      const item = (itemValue || {}) as SubsidyPayload;
      return {
        kind: String(item.kind || "") as SubsidyMaterialKind,
        label: String(item.label || "咨询资料"),
        group: String(item.group || "vehicle_reference"),
      };
    }).filter((item) => Boolean(item.kind)),
    serviceBoundary: {
      declaredValueLabel: String(serviceBoundary.declaredValueLabel || "车主自报车辆估值"),
      feeLabel: String(serviceBoundary.feeLabel || "咨询服务费"),
      officialSubsidyAmountProvided: false,
      isAppraisal: false,
      notice: String(serviceBoundary.notice || "本服务不代开发票、不代为申报，也不承诺补贴结果。车辆照片仅作咨询参考。"),
    },
  };
}

export function normalizeSubsidyQuote(payloadValue: unknown): SubsidyQuote {
  const payload = (payloadValue || {}) as SubsidyPayload;
  const raw = (payload.quote || payload) as SubsidyPayload;
  const consultationFeeFen = subsidyMoneyFen(raw.consultationFeeFen, "咨询服务费");
  const administrativeFees = normalizeSubsidyAdministrativeFees(raw.administrativeFees);
  const administrativeFeeFen = subsidyMoneyFen(raw.administrativeFeeFen, "行政收费参考小计");
  const totalTransferCostFen = subsidyMoneyFen(raw.totalTransferCostFen, "过户费用参考合计");
  const matchedTier = normalizeSubsidyTier(raw.matchedTier, 0, administrativeFeeFen);
  validateSubsidyBreakdown(consultationFeeFen, administrativeFees, administrativeFeeFen, totalTransferCostFen);
  if (matchedTier.feeFen !== consultationFeeFen || matchedTier.totalTransferCostFen !== totalTransferCostFen) {
    throw new Error("补贴咨询报价与命中档位不一致，请重新获取后台价格");
  }
  return {
    id: String(raw.id || raw.quoteId || ""),
    vehicleId: String(raw.vehicleId || ""),
    declaredValueFen: Number(raw.declaredValueFen || 0),
    declaredValueSource: "owner_self_reported",
    isAppraisal: false,
    matchedTier,
    consultationFeeFen,
    administrativeFees,
    administrativeFeeFen,
    totalTransferCostFen,
    planVersion: String(raw.planVersion || ""),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    expiresAt: String(raw.expiresAt || ""),
    disclaimer: String(raw.disclaimer || "车辆估值由车主自行填写，仅用于匹配咨询服务费，不属于专业评估或官方补贴金额。"),
  };
}

function normalizeSubsidyMaterial(payloadValue: unknown): SubsidyMaterial {
  const payload = (payloadValue || {}) as SubsidyPayload;
  const raw = (payload.material || payload) as SubsidyPayload;
  return {
    id: String(raw.id || ""),
    kind: String(raw.kind || "") as SubsidyMaterialKind,
    mimeType: String(raw.mimeType || "image/jpeg"),
    sizeBytes: Number(raw.sizeBytes || 0),
    status: "staged",
    expiresAt: String(raw.expiresAt || ""),
  };
}

function normalizeSubsidyStatus(value: unknown): SubsidyConsultationReceipt["status"] {
  return value === "handled" || value === "withdrawn" || value === "expired" ? value : "new";
}

export function normalizeSubsidyReceipt(payloadValue: unknown): SubsidyConsultationReceipt {
  const payload = (payloadValue || {}) as SubsidyPayload;
  const raw = (payload.receipt || payload.consultation || payload) as SubsidyPayload;
  const vehicle = (raw.vehicle || {}) as SubsidyPayload;
  const materialKinds = Array.isArray(raw.materialKinds) ? raw.materialKinds : [];
  const consultationFeeFen = subsidyMoneyFen(raw.consultationFeeFen, "咨询服务费");
  const administrativeFees = normalizeSubsidyAdministrativeFees(raw.administrativeFees);
  const administrativeFeeFen = subsidyMoneyFen(raw.administrativeFeeFen, "行政收费参考小计");
  const totalTransferCostFen = subsidyMoneyFen(raw.totalTransferCostFen, "过户费用参考合计");
  const matchedTier = normalizeSubsidyTier(raw.matchedTier, 0, administrativeFeeFen);
  validateSubsidyBreakdown(consultationFeeFen, administrativeFees, administrativeFeeFen, totalTransferCostFen);
  if (matchedTier.feeFen !== consultationFeeFen || matchedTier.totalTransferCostFen !== totalTransferCostFen) {
    throw new Error("补贴咨询凭证与冻结价格不一致，请重新读取");
  }
  return {
    id: String(raw.id || raw.consultationId || ""),
    consultationCode: String(raw.consultationCode || raw.code || ""),
    status: normalizeSubsidyStatus(raw.status),
    vehicle: {
      ...(vehicle.id ? { id: String(vehicle.id) } : {}),
      plateNumber: String(vehicle.plateNumber || vehicle.plateMasked || "已选车辆"),
      modelName: String(vehicle.modelName || vehicle.model || "车辆信息待确认"),
    },
    declaredValueFen: Number(raw.declaredValueFen || 0),
    matchedTier,
    consultationFeeFen,
    administrativeFees,
    administrativeFeeFen,
    totalTransferCostFen,
    planVersion: String(raw.planVersion || ""),
    contactNameMasked: String(raw.contactNameMasked || "已保护"),
    maskedPhone: String(raw.maskedPhone || raw.contactPhoneMasked || "已保护"),
    submittedAt: String(raw.submittedAt || raw.createdAt || new Date().toISOString()),
    contactEtaText: String(raw.contactEtaText || "1个工作日内联系"),
    materialKinds: materialKinds.map((item: unknown) => String(typeof item === "string" ? item : (item as SubsidyPayload)?.kind || "") as SubsidyMaterialKind).filter(Boolean),
    canWithdraw: raw.canWithdraw !== false && normalizeSubsidyStatus(raw.status) === "new",
    duplicate: Boolean(raw.duplicate),
    serviceBoundaryNotice: String(raw.serviceBoundaryNotice || "本服务不代开发票、不代为申报，也不承诺补贴结果。"),
  };
}

type DrivingSchoolPayload = Record<string, any>;

function drivingSchoolStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function uniqueDrivingSchoolStrings(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map((item) => item.trim()).filter(Boolean))];
}

function drivingSchoolModes(value: unknown, fallback: DrivingSchoolApplicationMode[] = []): DrivingSchoolApplicationMode[] {
  const modes = drivingSchoolStringArray(value).filter((item): item is DrivingSchoolApplicationMode => item === "initial" || item === "upgrade");
  return modes.length ? modes : fallback;
}

function drivingSchoolOption(value: unknown, labels: Record<string, string>): DrivingSchoolMetaOption {
  if (typeof value === "string") return { value, label: labels[value] || value };
  const raw = (value || {}) as DrivingSchoolPayload;
  const optionValue = String(raw.value || raw.code || raw.id || "");
  return {
    value: optionValue,
    label: String(raw.label || raw.name || labels[optionValue] || optionValue),
    ...(raw.description ? { description: String(raw.description) } : {}),
  };
}

function drivingSchoolOptions(value: unknown, labels: Record<string, string>): DrivingSchoolMetaOption[] {
  return (Array.isArray(value) ? value : []).map((item) => drivingSchoolOption(item, labels)).filter((item) => item.value);
}

function drivingSchoolGroup(code: string): { id: string; label: string } {
  if (/^[AB]/u.test(code)) return { id: "ab", label: "A / B 大中型车辆" };
  if (/^C/u.test(code)) return { id: "c", label: "C 小型及低速车辆" };
  if (/^[DEF]$/u.test(code)) return { id: "def", label: "D / E / F 摩托车" };
  return { id: "mnp", label: "M / N / P 专用车辆" };
}

function normalizeDrivingSchoolMeta(payloadValue: unknown): DrivingSchoolMeta {
  const raw = (payloadValue || {}) as DrivingSchoolPayload;
  const groupedRows = Array.isArray(raw.licenseClassGroups)
    ? raw.licenseClassGroups.flatMap((groupValue: unknown) => {
      const group = (groupValue || {}) as DrivingSchoolPayload;
      return (Array.isArray(group.items) ? group.items : []).map((item: unknown) => ({ ...(item as DrivingSchoolPayload), group: group.id || group.group }));
    })
    : [];
  const licenseRows = (Array.isArray(raw.licenseClasses) ? raw.licenseClasses : groupedRows) as DrivingSchoolPayload[];
  const licenseClasses: DrivingSchoolLicenseClassOption[] = licenseRows.map((item) => {
    const code = String(item.code || item.licenseClassCode || "").toUpperCase();
    const initialAllowed = item.initialAllowed === true || drivingSchoolModes(item.applicationModes || item.supportedApplicationModes).includes("initial");
    const upgradeAllowed = item.upgradeAllowed === true || drivingSchoolModes(item.applicationModes || item.supportedApplicationModes).includes("upgrade");
    const supportedApplicationModes: DrivingSchoolApplicationMode[] = [
      ...(initialAllowed ? ["initial" as const] : []),
      ...(upgradeAllowed ? ["upgrade" as const] : []),
    ];
    const group = drivingSchoolGroup(code);
    return {
      code,
      name: String(item.name || code),
      group: String(item.group || group.id),
      vehicleScope: String(item.vehicleScope || item.name || ""),
      initialAllowed,
      upgradeAllowed,
      supportedApplicationModes,
      conditions: drivingSchoolStringArray(item.conditions),
    };
  }).filter((item) => item.code);
  const groups = [
    { id: "ab", label: "A / B 大中型车辆" },
    { id: "c", label: "C 小型及低速车辆" },
    { id: "def", label: "D / E / F 摩托车" },
    { id: "mnp", label: "M / N / P 专用车辆" },
  ].map((group) => ({ ...group, items: licenseClasses.filter((item) => item.group === group.id) })).filter((group) => group.items.length);
  const applicationLabels = { initial: "初次申领", upgrade: "增驾" };
  const regulatoryLabels = { filing: "已备案", legacy_license: "存量许可" };
  const priceLabels = { fixed: "固定价", starting_from: "起步价", range: "价格区间", inquiry: "价格需咨询" };
  const capabilityLabels = { level_1: "一级培训能力 · 可培训≥3类车型", level_2: "二级培训能力 · 可培训2类车型", level_3: "三级培训能力 · 可培训1类车型" };
  const sortLabels = { recommended: "综合推荐", price_asc: "价格从低到高", updated: "报价最近更新" };
  return {
    licenseClassGroups: groups,
    applicationModes: drivingSchoolOptions(raw.applicationModes || ["initial", "upgrade"], applicationLabels),
    districts: drivingSchoolOptions(raw.districts, {}),
    regulatoryTypes: drivingSchoolOptions(raw.regulatoryTypes, regulatoryLabels),
    priceTypes: drivingSchoolOptions(raw.priceTypes, priceLabels),
    capabilityLevels: drivingSchoolOptions(raw.capabilityLevels || raw.trainingCapabilityLevels, capabilityLabels),
    sortOptions: drivingSchoolOptions(raw.sortOptions || ["recommended", "price_asc", "updated"], sortLabels),
    trainingCapabilityNotice: String(raw.trainingCapabilityNotice || "培训能力等级仅按已维护的准驾车型数量分级，不代表教学质量、通过率或推荐排名。"),
  };
}

function drivingSchoolImageUrl(value: unknown): string {
  const raw = typeof value === "string" ? value : String(((value || {}) as DrivingSchoolPayload).url || "");
  if (!raw) return "";
  return mediaUrl(raw);
}

export function normalizeDrivingSchoolImage(value: unknown, index = 0): DrivingSchoolImage | null {
  const raw = (typeof value === "string" ? { url: value } : (value || {})) as DrivingSchoolPayload;
  const url = drivingSchoolImageUrl(raw);
  if (!url) return null;
  const caption = String(raw.caption || "").trim();
  const altText = String(raw.altText || "").trim();
  return {
    id: String(raw.id || `driving-school-image-${index}`),
    url,
    caption,
    altText,
    isCover: raw.isCover === true,
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : index,
  };
}

export function normalizeDrivingSchoolTrainingClass(value: unknown): DrivingSchoolTrainingClass {
  const raw = (value || {}) as DrivingSchoolPayload;
  const catalogConditions = drivingSchoolStringArray(raw.catalogConditions);
  const schoolConditions = drivingSchoolStringArray(raw.schoolConditions);
  const derivedConditions = drivingSchoolStringArray(raw.conditions);
  return {
    licenseClassCode: String(raw.licenseClassCode || raw.code || "").toUpperCase(),
    name: String(raw.name || raw.licenseClassCode || raw.code || "准驾车型"),
    ...(raw.vehicleScope ? { vehicleScope: String(raw.vehicleScope) } : {}),
    supportedModes: drivingSchoolModes(raw.supportedModes || raw.applicationModes),
    trainingCapabilityLevel: raw.trainingCapabilityLevel ? String(raw.trainingCapabilityLevel) : null,
    trainingCapabilityNote: raw.trainingCapabilityNote ? String(raw.trainingCapabilityNote) : null,
    catalogConditions,
    schoolConditions,
    conditions: uniqueDrivingSchoolStrings(catalogConditions, schoolConditions, derivedConditions),
    status: raw.status === "inactive" || raw.isActive === false ? "inactive" : "active",
  };
}

function normalizeDrivingSchoolRegulatory(value: unknown) {
  const raw = (value || {}) as DrivingSchoolPayload;
  return {
    type: String(raw.type || ""),
    number: raw.number ? String(raw.number) : null,
    authority: raw.authority ? String(raw.authority) : null,
    sourceUrl: raw.sourceUrl ? String(raw.sourceUrl) : null,
    sourceLabel: raw.sourceLabel ? String(raw.sourceLabel) : null,
    validFrom: raw.validFrom ? String(raw.validFrom) : null,
    validUntil: raw.validUntil ? String(raw.validUntil) : null,
    verifiedAt: raw.verifiedAt ? String(raw.verifiedAt) : null,
    status: raw.status ? String(raw.status) : null,
    capabilityLevel: raw.capabilityLevel ? String(raw.capabilityLevel) : null,
  };
}

function normalizeDrivingSchoolLocation(value: unknown) {
  const raw = (value || {}) as DrivingSchoolPayload;
  if (!Object.keys(raw).length) return null;
  return {
    ...(raw.poiId ? { poiId: String(raw.poiId) } : {}),
    title: String(raw.title || ""),
    address: String(raw.address || ""),
    district: String(raw.district || ""),
    latitude: Number(raw.latitude || 0),
    longitude: Number(raw.longitude || 0),
    source: String(raw.source || ""),
  };
}

function nullableFen(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeDrivingSchoolItem(value: unknown): DrivingSchoolListItem {
  const raw = (value || {}) as DrivingSchoolPayload;
  const trainingClasses = (Array.isArray(raw.trainingClasses) ? raw.trainingClasses : [])
    .map(normalizeDrivingSchoolTrainingClass)
    .filter((item) => item.licenseClassCode && item.status === "active");
  return {
    id: String(raw.id || ""),
    name: String(raw.name || "驾校信息待维护"),
    legalName: String(raw.legalName || raw.name || ""),
    dataKind: String(raw.dataKind || (raw.isDemo ? "demo" : "real")),
    isDemo: raw.isDemo === true || raw.dataKind === "demo" || raw.dataKind === "synthetic_demo",
    district: String(raw.district || raw.location?.district || ""),
    address: String(raw.address || raw.location?.address || ""),
    location: normalizeDrivingSchoolLocation(raw.location),
    publicPhone: raw.publicPhone ? String(raw.publicPhone) : null,
    coverImage: drivingSchoolImageUrl(raw.coverImage),
    trainingClasses,
    startingPriceFen: nullableFen(raw.startingPriceFen),
    tags: drivingSchoolStringArray(raw.tags),
    openHours: String(raw.openHours || "").trim(),
    regulatory: normalizeDrivingSchoolRegulatory(raw.regulatory),
    publishedAt: raw.publishedAt ? String(raw.publishedAt) : null,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
    offerUpdatedAt: raw.offerUpdatedAt ? String(raw.offerUpdatedAt) : null,
  };
}

export function normalizeDrivingSchoolOffer(value: unknown): DrivingSchoolOffer {
  const raw = (value || {}) as DrivingSchoolPayload;
  return {
    id: String(raw.id || ""),
    licenseClassCode: String(raw.licenseClassCode || "").toUpperCase(),
    name: String(raw.name || "服务项目"),
    priceType: String(raw.priceType || "inquiry"),
    minPriceFen: nullableFen(raw.minPriceFen),
    maxPriceFen: nullableFen(raw.maxPriceFen),
    description: raw.description ? String(raw.description) : null,
    status: raw.status === "inactive" || raw.isActive === false ? "inactive" : "active",
    applicationModes: drivingSchoolModes(raw.applicationModes),
    unit: raw.unit ? String(raw.unit) : null,
    includedItems: drivingSchoolStringArray(raw.includedItems),
    excludedItems: drivingSchoolStringArray(raw.excludedItems),
  };
}

function normalizeDrivingSchoolImages(raw: DrivingSchoolPayload): DrivingSchoolImage[] {
  const cover = normalizeDrivingSchoolImage(raw.coverImage, -1);
  const values = [
    ...(cover ? [{ ...cover, isCover: true, sortOrder: Math.min(-1, cover.sortOrder) }] : []),
    ...(Array.isArray(raw.images) ? raw.images.map((item: unknown, index: number) => normalizeDrivingSchoolImage(item, index)).filter((item): item is DrivingSchoolImage => Boolean(item)) : []),
  ];
  const byUrl = new Map<string, DrivingSchoolImage>();
  values.forEach((image) => {
    const existing = byUrl.get(image.url);
    if (!existing) { byUrl.set(image.url, image); return; }
    byUrl.set(image.url, {
      ...existing,
      id: existing.id.startsWith("driving-school-image-") ? image.id : existing.id,
      caption: existing.caption || image.caption,
      altText: existing.altText || image.altText,
      isCover: existing.isCover || image.isCover,
      sortOrder: Math.min(existing.sortOrder, image.sortOrder),
    });
  });
  return [...byUrl.values()].sort((left, right) => Number(right.isCover) - Number(left.isCover) || left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

export function normalizeDrivingSchoolDetail(value: unknown): DrivingSchoolDetail {
  const raw = (value || {}) as DrivingSchoolPayload;
  const base = normalizeDrivingSchoolItem(raw);
  return {
    ...base,
    description: raw.description ? String(raw.description) : null,
    images: normalizeDrivingSchoolImages(raw),
    offers: (Array.isArray(raw.offers) ? raw.offers : []).map(normalizeDrivingSchoolOffer),
    facilities: drivingSchoolStringArray(raw.facilities),
    inquiryAvailable: raw.inquiryAvailable !== false,
  };
}

function normalizeDrivingSchoolList(value: unknown, query: DrivingSchoolListQuery): DrivingSchoolListPage {
  const raw = (value || {}) as DrivingSchoolPayload;
  const items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeDrivingSchoolItem);
  const pagination = (raw.pagination || {}) as DrivingSchoolPayload;
  const page = Number(pagination.page || query.page || 1);
  const pageSize = Number(pagination.pageSize || query.pageSize || items.length || 12);
  const total = Number(pagination.total ?? items.length);
  return { items, pagination: { page, pageSize, total, totalPages: Number(pagination.totalPages || Math.max(1, Math.ceil(total / pageSize))) } };
}

function normalizeDrivingSchoolDisclosure(value: unknown): DrivingSchoolInquiryDisclosure {
  const raw = (value || {}) as DrivingSchoolPayload;
  const school = (raw.school || {}) as DrivingSchoolPayload;
  const recipient = (raw.recipient || {}) as DrivingSchoolPayload;
  const version = String(raw.version || "");
  if (!version) throw new Error("驾校咨询信息使用说明缺少版本号，请稍后重试");
  return {
    mode: String(raw.mode || "demo"),
    acceptsRealData: raw.acceptsRealData === true,
    version,
    school: { id: String(school.id || ""), name: String(school.name || "已选驾校") },
    recipient: { name: String(recipient.name || "驭小满驾校服务团队") },
    dataScope: drivingSchoolStringArray(raw.dataScope),
    purpose: String(raw.purpose || "用于驭小满驾校服务团队内部确认本次咨询需求。"),
    retention: String(raw.retention || "按信息使用说明约定期限保存。"),
    consentText: String(raw.consentText || "我同意由驭小满驾校服务团队处理本次咨询资料，资料不向驾校转交。"),
    contactEtaText: String(raw.contactEtaText || "预计 1 个工作日内联系"),
  };
}

function normalizeDrivingSchoolReceipt(value: unknown): DrivingSchoolInquiryReceipt {
  const payload = (value || {}) as DrivingSchoolPayload;
  const raw = (payload.receipt || payload) as DrivingSchoolPayload;
  const school = (raw.school || {}) as DrivingSchoolPayload;
  return {
    inquiryCode: String(raw.inquiryCode || ""),
    school: { id: String(school.id || ""), name: String(school.name || "已选驾校") },
    licenseClassCode: String(raw.licenseClassCode || "").toUpperCase(),
    applicationMode: raw.applicationMode === "upgrade" ? "upgrade" : "initial",
    maskedPhone: String(raw.maskedPhone || "已保护"),
    contactNameMasked: String(raw.contactNameMasked || "已保护"),
    contactEtaText: String(raw.contactEtaText || "预计 1 个工作日内联系"),
    withdrawToken: String(raw.withdrawToken || ""),
    duplicate: raw.duplicate === true,
    status: String(raw.status || "new"),
    submittedAt: String(raw.submittedAt || new Date().toISOString()),
  };
}

function normalizeUserProfile(raw: unknown): UserProfile {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const avatarUrl = typeof value.avatarUrl === "string" ? value.avatarUrl.trim() : "";
  return {
    displayName: displayName || null,
    avatarUrl: avatarUrl || null,
    profileComplete: value.profileComplete === true || Boolean(displayName && avatarUrl),
  };
}

export const api = {
  health: () => request<{ status: string }>("/health"),
  vehicleCatalog: async () => normalizeVehicleCatalog(await request<VehicleCatalog>("/vehicle-catalog")),
  vehicles: async () => (await request<Vehicle[]>("/vehicles")).map(normalizeVehicle),
  createVehicle: async (data: VehicleInput) => normalizeVehicle(await request<Vehicle>("/vehicles", "POST", { ...data, washVehicleCategory: normalizeWashVehicleCategory(data.washVehicleCategory, data) })),
  updateVehicle: async (id: string, data: Partial<VehicleInput>) => normalizeVehicle(await request<Vehicle>(`/vehicles/${id}`, "PATCH", { ...data, ...(data.washVehicleCategory ? { washVehicleCategory: normalizeWashVehicleCategory(data.washVehicleCategory, data) } : {}) })),
  deleteVehicle: (id: string) => request<void>(`/vehicles/${id}`, "DELETE"),
  inspection: (vehicleId: string) => request<{
    dueDays: number | null;
    eligibility: string;
    title: string;
    recommendation: string;
    canBook: boolean;
    applicationWindow?: { start: string; end: string } | null;
    dateEvidence?: InspectionDateEvidence;
    materials: Array<{ id: string; name: string; description: string; required: boolean; ready?: boolean }>;
    ruleSource: string;
    ruleUpdatedAt: string;
  }>(`/inspection/status/${vehicleId}`),
  calculateInspection: (data: InspectionCalculationRequest) => request<InspectionCalculation>("/inspection/calculations", "POST", data),
  stations: (params: Record<string, string | number | undefined>) => {
    const query = Object.entries(params).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
    return request<Station[]>(`/stations${query ? `?${query}` : ""}`);
  },
  slots: (stationId: string) => request<Slot[]>(`/stations/${stationId}/slots`),
  suggestions: (query: string) => request<PickupAddress[]>(`/locations/suggestions?query=${encodeURIComponent(query)}`),
  resolveLocation: (data: { latitude: number; longitude: number; name?: string; address?: string }) => request<PickupAddress>("/locations/resolve", "POST", data),
  quote: async (data: { vehicleId: string; stationId: string; serviceMode: ServiceMode; pickupAddress?: PickupAddress; originLat?: number; originLng?: number; originType?: string }) => normalizeBookingQuote(await request<BookingQuote>("/bookings/quote", "POST", data)),
  bookings: async () => (await request<Booking[]>("/bookings")).map(normalizeBooking),
  booking: async (id: string) => localizeOwnerBookingPrivateMedia(normalizeBooking(await request<Booking>(`/bookings/${id}`))),
  vehicleCheckupReports: async (params: VehicleCheckupReportListQuery = {}) => {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    const payload = await requestEnvelope<VehicleCheckupReportListData>(`/vehicle-checkup-reports${query ? `?${query}` : ""}`);
    return normalizeVehicleCheckupReportList(payload.data, payload.meta);
  },
  createRepairRequest: async (reportId: string) => localizeOwnerRepairRequestPrivateMedia(await request<RepairRequest>("/repair/requests", "POST", { reportId })),
  repairRequests: async () => (await request<RepairRequestSummary[]>("/repair/requests")).map(normalizeRepairRequestSummary),
  repairRequest: async (id: string) => localizeOwnerRepairRequestPrivateMedia(await request<RepairRequest>(`/repair/requests/${encodeURIComponent(id)}`)),
  cancelRepairRequest: async (id: string) => localizeOwnerRepairRequestPrivateMedia(await request<RepairRequest>(`/repair/requests/${encodeURIComponent(id)}/cancel`, "POST", {})),
  payRepairRequest: async (id: string, quoteId: string, idempotencyKey: string) => localizeOwnerRepairRequestPrivateMedia(await request<RepairRequest>(`/repair/requests/${encodeURIComponent(id)}/mock-pay`, "POST", { quoteId, idempotencyKey })),
  createBooking: async (data: Record<string, unknown>) => localizeOwnerBookingPrivateMedia(
    normalizeBooking(await request<Booking>("/bookings", "POST", data)),
  ),
  paymentProvider: async () => request<{
    provider: "wechat" | "mock";
    wechatConfigured: boolean;
    mockAllowed: boolean;
  }>("/payments/provider"),
  payBooking: async (id: string, idempotencyKey: string, quoteSnapshotId?: string | null) => {
    const providerInfo = await api.paymentProvider().catch(() => ({
      provider: "mock" as const,
      wechatConfigured: false,
      mockAllowed: false,
    }));
    if (!providerInfo.wechatConfigured) {
      if (!providerInfo.mockAllowed) {
        throw new Error("微信支付未配置，当前环境不允许模拟支付");
      }
    }
    const provider = providerInfo.wechatConfigured ? "wechat" : "mock";
    const payload = await request<{
      booking: Booking;
      payment: { id: string; provider: string; amountFen: number; status: string };
      wechatPay?: {
        timeStamp: string;
        nonceStr: string;
        package: string;
        signType: "RSA";
        paySign: string;
      };
    }>(`/bookings/${id}/payments`, "POST", {
      provider,
      idempotencyKey,
      ...(quoteSnapshotId ? { quoteSnapshotId } : {}),
    });
    if (payload.wechatPay) {
      await new Promise<void>((resolve, reject) => {
        wx.requestPayment({
          ...payload.wechatPay!,
          success: () => resolve(),
          fail: (error) => reject(new Error(error.errMsg || "微信支付未完成")),
        });
      });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const booking = normalizeBooking(await request<Booking>(`/bookings/${encodeURIComponent(id)}`));
        if (booking.paymentStatus === "paid" || Number(booking.amountDueFen ?? 0) <= 0) {
          return localizeOwnerBookingPrivateMedia(booking);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const waiting = normalizeBooking(await request<Booking>(`/bookings/${encodeURIComponent(id)}`));
      return localizeOwnerBookingPrivateMedia(waiting);
    }
    return localizeOwnerBookingPrivateMedia(normalizeBooking(payload.booking));
  },
  requoteBooking: async (id: string, expectedQuoteSnapshotId: string) => {
    const payload = await request<{ booking: Booking; quote: BookingQuote & { expiresAt?: string } }>(
      `/bookings/${encodeURIComponent(id)}/requote`,
      "POST",
      { expectedQuoteSnapshotId },
    );
    return {
      ...payload,
      booking: await localizeOwnerBookingPrivateMedia(normalizeBooking(payload.booking)),
      quote: normalizeBookingQuote(payload.quote),
    };
  },
  cancelBooking: async (id: string) => localizeOwnerBookingPrivateMedia(
    normalizeBooking(await request<Booking>(`/bookings/${id}/cancel`, "POST")),
  ),
  washStores: async (params: { originLat?: number; originLng?: number } = {}) => {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    return listFrom(await request<WashStore[] | { stores?: WashStore[] }>(`/wash/stores${query ? `?${query}` : ""}`)).map(normalizeWashStore);
  },
  washStore: async (storeId: string, params: { originLat?: number; originLng?: number } = {}) => {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    return normalizeWashStore(await request<WashStore>(`/wash/stores/${encodeURIComponent(storeId)}${query ? `?${query}` : ""}`));
  },
  washPackages: async (storeId: string, vehicleCategory: WashVehicleCategory) => {
    const payload = await request<WashPackagePayload[] | { offers?: WashPackagePayload[]; packages?: WashPackagePayload[] }>(`/wash/stores/${encodeURIComponent(storeId)}/offers?vehicleCategory=${encodeURIComponent(vehicleCategory)}`);
    return listFrom(payload).map((item) => normalizeWashPackage(item, storeId, vehicleCategory));
  },
  washSlots: async (storeId: string, date: string, packageId: string) => listFrom(await request<WashSlot[] | { slots?: WashSlot[] }>(`/wash/stores/${encodeURIComponent(storeId)}/slots?date=${encodeURIComponent(date)}&packageId=${encodeURIComponent(packageId)}`)),
  washQuote: async (data: { vehicleId: string; storeId: string; packageId: string; slotId: string; vehicleCategory?: WashVehicleCategory; serviceMode: ServiceMode; tripType: "round_trip_same_address"; pickupAddress?: PickupAddress }) => {
    const result = await request<Partial<WashQuote> & { id?: string; priceFen?: number; package?: WashPackagePayload; offer?: WashPackagePayload }>("/wash/quotes", "POST", data);
    const packagePayload = result.package || result.offer;
    const normalizedPackage = packagePayload ? normalizeWashPackage(packagePayload, data.storeId) : undefined;
    const washFeeFen = Number(result.washFeeFen ?? result.serviceFeeFen ?? result.priceFen ?? normalizedPackage?.priceFen ?? 0);
    const valetFeeFen = Number(result.valetFeeFen ?? 0);
    const totalFeeFen = Number(result.totalFeeFen ?? washFeeFen + valetFeeFen);
    return {
      ...result,
      serviceType: "car_wash",
      vehicleId: String(result.vehicleId || data.vehicleId),
      storeId: String(result.storeId || data.storeId),
      packageId: String(result.packageId || normalizedPackage?.id || data.packageId),
      slotId: String(result.slotId || data.slotId),
      vehicleCategory: normalizeWashVehicleCategory(result.vehicleCategory ?? data.vehicleCategory),
      packageName: result.packageName || normalizedPackage?.name,
      serviceMode: result.serviceMode === "valet" ? "valet" : data.serviceMode,
      tripType: result.serviceMode === "valet" || data.serviceMode === "valet" ? "round_trip_same_address" : null,
      serviceable: result.serviceable !== false,
      washFeeFen,
      valetFeeFen,
      serviceFeeFen: Number(result.serviceFeeFen ?? washFeeFen),
      totalFeeFen,
      pickupAddress: result.pickupAddress || data.pickupAddress || null,
      oneWayDistanceKm: result.oneWayDistanceKm ?? null,
      roundTripDistanceKm: result.roundTripDistanceKm ?? null,
      billableDistanceKm: result.billableDistanceKm ?? null,
      driveMinutes: result.driveMinutes ?? null,
      extraKm: Number(result.extraKm ?? 0),
      distanceSource: result.distanceSource || "not_calculated",
      distanceBasis: result.distanceBasis || "no_origin",
      valetRule: result.valetRule || null,
      breakdown: result.breakdown || {
        washFeeFen,
        valetBaseFeeFen: valetFeeFen,
        valetDistanceFeeFen: 0,
        valetFeeFen,
        totalFeeFen,
      },
      quoteSnapshotId: String(result.quoteSnapshotId || result.id || ""),
    } as WashQuote;
  },
  washOrders: async () => listFrom(await request<WashOrderPayload[] | { orders?: WashOrderPayload[] }>("/wash/orders")).map(normalizeWashOrder),
  washOrder: async (id: string) => normalizeWashOrder(await request<WashOrderPayload>(`/wash/orders/${encodeURIComponent(id)}`)),
  createWashOrder: async (data: { precheckBookingId?: string; quoteSnapshotId: string; idempotencyKey: string; contactName: string; contactPhone: string; notes?: string }) => normalizeWashOrder(await request<WashOrderPayload>("/wash/orders", "POST", data)),
  payWashOrder: async (id: string, idempotencyKey: string) => {
    const providerInfo = await api.paymentProvider().catch(() => ({
      provider: "mock" as const,
      wechatConfigured: false,
      mockAllowed: false,
    }));
    if (!providerInfo.wechatConfigured) {
      if (!providerInfo.mockAllowed) {
        throw new Error("微信支付未配置，当前环境不允许模拟支付");
      }
    }
    const provider = providerInfo.wechatConfigured ? "wechat" : "mock";
    const payload = await requestEnvelope<{
      order: WashOrderPayload;
      payment: { id: string; provider: string; amountFen: number; status: string };
      redemptionCode?: string | null;
      wechatPay?: {
        timeStamp: string;
        nonceStr: string;
        package: string;
        signType: "RSA";
        paySign: string;
      };
    }>(`/wash/orders/${encodeURIComponent(id)}/payments`, "POST", { provider, idempotencyKey });
    const data = payload.data;
    if (data.wechatPay) {
      await new Promise<void>((resolve, reject) => {
        wx.requestPayment({
          ...data.wechatPay!,
          success: () => resolve(),
          fail: (error) => reject(new Error(error.errMsg || "微信支付未完成")),
        });
      });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const order = normalizeWashOrder(await request<WashOrderPayload>(`/wash/orders/${encodeURIComponent(id)}`));
        if (order.status !== "pending_payment" && order.paymentStatus === "paid") return order;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return normalizeWashOrder(await request<WashOrderPayload>(`/wash/orders/${encodeURIComponent(id)}`));
    }
    return normalizeWashOrder(data.order);
  },
  cancelWashOrder: async (id: string) => normalizeWashOrder(await request<WashOrderPayload>(`/wash/orders/${encodeURIComponent(id)}/cancel`, "POST")),
  rescheduleWashOrder: async (id: string, slotId: string) => normalizeWashOrder(await request<WashOrderPayload>(`/wash/orders/${encodeURIComponent(id)}/reschedule`, "POST", { slotId })),
  insuranceDisclosure: async () => normalizeInsuranceDisclosure(await request<Partial<InsuranceDisclosure>>("/insurance/disclosure")),
  createInsuranceLead: (data: InsuranceLeadInput, licensePhotoPath: string, idempotencyKey: string) => uploadInsuranceLead(data, licensePhotoPath, idempotencyKey),
  withdrawInsuranceLead: async (withdrawToken: string) => normalizeInsuranceReceipt(await request<InsuranceReceiptPayload>(`/insurance/leads/${encodeURIComponent(withdrawToken)}/withdraw`, "POST")),
  subsidyConsultationConfig: async () => normalizeSubsidyConfig(await request<SubsidyPayload>("/subsidy-consultation/config")),
  subsidyConsultationQuote: async (data: { vehicleId: string; declaredValueFen: number }) => normalizeSubsidyQuote(await request<SubsidyPayload>("/subsidy-consultation/quotes", "POST", data)),
  uploadSubsidyConsultationMaterial: (kind: SubsidyMaterialKind, filePath: string) => uploadSubsidyMaterial(kind, filePath),
  createDemoSubsidyConsultationMaterial: async (kind: SubsidyMaterialKind) => normalizeSubsidyMaterial(await request<SubsidyPayload>("/subsidy-consultation/demo-materials", "POST", { kind })),
  deleteSubsidyConsultationMaterial: (id: string) => request<void>(`/subsidy-consultation/materials/${encodeURIComponent(id)}`, "DELETE"),
  createSubsidyConsultation: async (data: SubsidyConsultationCreateInput, idempotencyKey: string) => normalizeSubsidyReceipt(await request<SubsidyPayload>("/subsidy-consultations", "POST", data, { "Idempotency-Key": idempotencyKey })),
  subsidyConsultation: async (id: string) => normalizeSubsidyReceipt(await request<SubsidyPayload>(`/subsidy-consultations/${encodeURIComponent(id)}`)),
  withdrawSubsidyConsultation: async (id: string) => normalizeSubsidyReceipt(await request<SubsidyPayload>(`/subsidy-consultations/${encodeURIComponent(id)}/withdraw`, "POST")),
  drivingSchoolMeta: async () => normalizeDrivingSchoolMeta(await request<DrivingSchoolPayload>("/driving-schools/meta")),
  drivingSchools: async (params: DrivingSchoolListQuery = {}) => {
    const query = queryString(params);
    return normalizeDrivingSchoolList(await request<DrivingSchoolPayload>(`/driving-schools${query ? `?${query}` : ""}`), params);
  },
  drivingSchool: async (id: string) => normalizeDrivingSchoolDetail(await request<DrivingSchoolPayload>(`/driving-schools/${encodeURIComponent(id)}`)),
  drivingSchoolInquiryDisclosure: async (schoolId: string) => normalizeDrivingSchoolDisclosure(await request<DrivingSchoolPayload>(`/driving-school-inquiries/disclosure?schoolId=${encodeURIComponent(schoolId)}`)),
  createDrivingSchoolInquiry: async (data: DrivingSchoolInquiryInput, idempotencyKey: string) => normalizeDrivingSchoolReceipt(await request<DrivingSchoolPayload>("/driving-school-inquiries", "POST", data, { "Idempotency-Key": idempotencyKey })),
  withdrawDrivingSchoolInquiry: async (withdrawToken: string) => normalizeDrivingSchoolReceipt(await request<DrivingSchoolPayload>(`/driving-school-inquiries/${encodeURIComponent(withdrawToken)}/withdraw`, "POST")),
  carRentalCatalog: async () => normalizeRentalCatalog(await request<RentalPayload>("/car-rental/catalog")),
  carRentalStores: async () => {
    const payload = await request<RentalPayload[] | { stores?: RentalPayload[]; items?: RentalPayload[] }>("/car-rental/stores");
    return listFrom(payload).map(normalizeRentalStore).filter((store) => store.isActive);
  },
  carRentalOffers: async (search: CarRentalSearch) => {
    const payload = await request<RentalPayload>("/car-rental/offers/search", "POST", rentalSearchPayload(search));
    const store = payload.store ? normalizeRentalStore(payload.store) : null;
    const items = (Array.isArray(payload.items) ? payload.items : []).map((item) => {
      const normalized = normalizeRentalOffer(item);
      return {
        ...normalized,
        storeId: normalized.storeId || store?.id || "",
        storeName: normalized.storeName || store?.name || "",
        rentalDays: Number(payload.billableDays || normalized.rentalDays),
      };
    });
    return {
      items,
      total: Number(payload.total ?? items.length),
      rentalDays: Number(payload.billableDays || items[0]?.rentalDays || 1),
      selectedStore: store,
    } as CarRentalOfferPage;
  },
  carRentalModel: async (id: string, search: CarRentalSearch) => {
    const query = queryString({ storeId: search.storeId, pickupAt: search.pickupAt, returnAt: search.returnAt });
    return normalizeRentalModel(await request<RentalPayload>(`/car-rental/models/${encodeURIComponent(id)}${query ? `?${query}` : ""}`));
  },
  carRentalQuote: async (search: CarRentalSearch, modelId: string, addOptionalProtection: boolean) => {
    const payload = await request<RentalPayload>("/car-rental/quotes", "POST", {
      ...rentalSearchPayload(search),
      modelId,
      addOptionalProtection,
    });
    return normalizeRentalQuote(payload, { search, includeOptionalProtection: addOptionalProtection });
  },
  carRentalOrders: async () => {
    const payload = await request<RentalPayload[] | { orders?: RentalPayload[]; items?: RentalPayload[] }>("/car-rental/orders");
    return listFrom(payload).map(normalizeRentalOrder);
  },
  carRentalOrder: async (id: string) => normalizeRentalOrder(await request<RentalPayload>(`/car-rental/orders/${encodeURIComponent(id)}`)),
  createCarRentalOrder: async (data: { quoteId: string; driverName: string; driverPhone: string; licenseConfirmed: true; idempotencyKey: string }) => normalizeRentalOrder(await request<RentalPayload>("/car-rental/orders", "POST", data)),
  payCarRentalOrder: async (id: string, idempotencyKey: string) => normalizeRentalOrder(await request<RentalPayload>(`/car-rental/orders/${encodeURIComponent(id)}/mock-pay`, "POST", { idempotencyKey })),
  cancelCarRentalOrder: async (id: string, reason = "用户主动取消") => normalizeRentalOrder(await request<RentalPayload>(`/car-rental/orders/${encodeURIComponent(id)}/cancel`, "POST", { reason })),
  usedCarCatalog: async () => normalizeUsedCarCatalog(await request<UsedCarCatalog>("/used-cars/catalog")),
  usedCarListings: async (params: UsedCarListingQuery = {}) => {
    const query = queryString(params);
    const payload = await request<{ items?: UsedCarListingPayload[]; total?: number; page?: number; pageSize?: number }>(`/used-cars/listings${query ? `?${query}` : ""}`);
    const items = Array.isArray(payload.items) ? payload.items.map(normalizeUsedCarListing) : [];
    return { items, total: Number(payload.total ?? items.length), page: Number(payload.page ?? params.page ?? 1), pageSize: Number(payload.pageSize ?? params.pageSize ?? items.length) } as UsedCarListingPage;
  },
  usedCarListing: async (id: string) => normalizeUsedCarListing(await request<UsedCarListingPayload>(`/used-cars/listings/${encodeURIComponent(id)}`)),
  operatorWorkbench: async (stationId?: string, date?: string) => normalizeWorkbench(await operatorRequest<Workbench>(`/operator/workbench?stationId=${encodeURIComponent(stationId || "")}&date=${encodeURIComponent(date || "")}`)),
  operatorBooking: async (id: string) => localizedOperatorBooking(normalizeBooking(await operatorRequest<Booking>(`/operator/bookings/${id}`))),
  operatorPrechecks: async (status: "pending" | "rejected" | "all" = "pending") => {
    const result = await operatorRequest<{ items: Booking[] }>(`/operator/prechecks?status=${status}`);
    return { items: await Promise.all((result.items || []).map((item) => localizedOperatorBooking(normalizeBooking(item)))) };
  },
  operatorPrecheck: async (id: string) => localizedOperatorBooking(normalizeBooking(await operatorRequest<Booking>(`/operator/prechecks/${encodeURIComponent(id)}`))),
  resubmitPrecheck: async (id: string, data: { expectedVersion: number; idempotencyKey: string; slotId: string; mediaIds: string[]; resolutionNote: string }) => localizeOwnerBookingPrivateMedia(normalizeBooking(await request<Booking>(`/bookings/${encodeURIComponent(id)}/precheck/resubmit`, "POST", data))),
  createPrecheckRepairRequest: async (data: { bookingId: string; expectedVersion: number; reasonCodes: string[]; consented: true }) => localizeOwnerRepairRequestPrivateMedia(await request<RepairRequest>("/repair/precheck-requests", "POST", data)),
  approveOperatorPrecheck: async (id: string, input: { idempotencyKey: string; expectedVersion: number }) => localizedOperatorBooking(normalizeBooking(await operatorRequest<Booking>(`/operator/prechecks/${encodeURIComponent(id)}/approve`, "POST", input))),
  rejectOperatorPrecheck: async (id: string, input: { idempotencyKey: string; expectedVersion: number; reasonCodes: string[]; reasonText: string; issuePhotoKinds: string[] }) => localizedOperatorBooking(normalizeBooking(await operatorRequest<Booking>(`/operator/prechecks/${encodeURIComponent(id)}/reject`, "POST", input))),
  operatorCheckupReport: async (id: string) => {
    const report = await operatorRequest<VehicleCheckupReport | null>(`/operator/bookings/${id}/checkup-report`);
    return report ? localizedOperatorCheckupReport(normalizeCheckupReport(report)) : null;
  },
  saveOperatorCheckupReport: async (id: string, data: VehicleCheckupReportInput) => localizedOperatorCheckupReport(normalizeCheckupReport(await operatorRequest<VehicleCheckupReport>(`/operator/bookings/${id}/checkup-report`, "PUT", data))),
  uploadOperatorCheckupMedia: (id: string, kind: CheckupMediaKind, filePath: string) => uploadCheckupMedia(id, kind, filePath),
  deleteOperatorCheckupMedia: (id: string, mediaId: string) => operatorRequest<void>(`/operator/bookings/${id}/checkup-report/media/${encodeURIComponent(mediaId)}`, "DELETE"),
  uploadOperatorFaultPhoto: (bookingId: string, faultId: string, filePath: string, options: { replacePhotoId?: string; idempotencyKey: string }) => uploadFaultPhoto(bookingId, faultId, filePath, options),
  deleteOperatorFaultPhoto: (bookingId: string, faultId: string, mediaId: string) => operatorRequest<void>(`/operator/bookings/${encodeURIComponent(bookingId)}/checkup-report/faults/${encodeURIComponent(faultId)}/photos/${encodeURIComponent(mediaId)}`, "DELETE"),
  submitOperatorInspectionResult: async (id: string, data: { conclusion: CheckupConclusion; failureDetails?: CheckupFailureDetails | null; summary?: Record<string, unknown>; externalResultId?: string }) => localizedOperatorBooking(normalizeBooking(await operatorRequest<Booking>(`/operator/bookings/${id}/inspection-result`, "POST", data))),
  operatorAction: async (id: string, action: string, data: Record<string, unknown> = {}) => localizedOperatorBooking(normalizeBooking(await operatorRequest<Booking>(`/operator/bookings/${id}/${action}`, "POST", data))),
  operatorStationEvidenceUpload: (bookingId: string, kind: ValetEvidenceMediaKind, filePath: string) => uploadOperatorStationEvidence(bookingId, kind, filePath),
  operatorStationEvidenceDelete: (bookingId: string, mediaId: string) => operatorRequest<void>(`/operator/bookings/${encodeURIComponent(bookingId)}/evidence/station_arrival/media/${encodeURIComponent(mediaId)}`, "DELETE"),
  operatorStationEvidenceComplete: async (
    bookingId: string,
    idempotencyKey: string,
    verification: { plateMatched: boolean; materialsReady: boolean; exteriorRecorded: boolean; vehicleConditionConfirmed: boolean; notes?: string },
  ) => localizedOperatorBooking(normalizeBooking(await operatorRequest<Booking>(
    `/operator/bookings/${encodeURIComponent(bookingId)}/evidence/station_arrival/complete`,
    "POST",
    { idempotencyKey, verification },
  ))),
  updateCapacity: (slotId: string, capacity: number) => operatorRequest<Slot>(`/operator/station-slots/${slotId}`, "PATCH", { capacity }),
  simulateResult: async (id: string) => normalizeBooking(await request<Booking>(`/demo/operator/bookings/${id}/simulate-result`, "POST")),
  resetDemo: () => request<{ resetAt: string }>("/demo/reset", "POST"),
  profile: async () => normalizeUserProfile(await request<UserProfile>("/auth/profile")),
  syncWechatProfile: async (input: { nickName: string; avatarUrl: string }) => normalizeUserProfile(await request<UserProfile>("/auth/profile/sync", "POST", {
    nickName: input.nickName,
    avatarUrl: input.avatarUrl,
  })),
  updateProfile: async (displayName: string) => normalizeUserProfile(await request<UserProfile>("/auth/profile", "PUT", { displayName })),
  uploadProfileAvatar: async (filePath: string) => {
    const payload = await uploadEnvelope<UserProfile>({
      path: "/auth/profile/avatar",
      filePath,
      name: "file",
      fallbackMessage: "头像上传失败",
    });
    return normalizeUserProfile(payload.data);
  },
};

type UploadEnvelopeOptions = {
  path: string;
  filePath: string;
  name: string;
  headers?: Record<string, string>;
  formData?: Record<string, string>;
  fallbackMessage: string;
};

function uploadEnvelope<T>(options: UploadEnvelopeOptions): Promise<Envelope<T>> {
  assertApiConfigured();
  return withOwnerAuthorization(options.headers || {}, (authorizedHeaders) => new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${apiBaseUrl}${options.path}`,
      filePath: options.filePath,
      name: options.name,
      header: authorizedHeaders,
      formData: options.formData,
      timeout: 30000,
      success: (result) => {
        let payload: Envelope<T> | undefined;
        try { payload = JSON.parse(result.data) as Envelope<T>; } catch { /* handled below */ }
        if (result.statusCode >= 200 && result.statusCode < 300 && payload?.data !== undefined) {
          resolve(payload);
          return;
        }
        reject(apiError(payload, result.statusCode, options.fallbackMessage));
      },
      fail: (error) => reject(new Error(error.errMsg || options.fallbackMessage)),
    });
  }));
}

function uploadOperatorEnvelope<T>(options: UploadEnvelopeOptions): Promise<Envelope<T>> {
  assertApiConfigured();
  return withOperatorAuthorization(options.headers || {}, (authorizedHeaders) => new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${apiBaseUrl}${options.path}`,
      filePath: options.filePath,
      name: options.name,
      header: authorizedHeaders,
      formData: options.formData,
      timeout: 30000,
      success: (result) => {
        let payload: Envelope<T> | undefined;
        try { payload = JSON.parse(result.data) as Envelope<T>; } catch { /* handled below */ }
        if (result.statusCode >= 200 && result.statusCode < 300 && payload?.data !== undefined) {
          resolve(payload);
          return;
        }
        reject(apiError(payload, result.statusCode, result.statusCode === 401 ? "检测站会话已失效，请重新登录" : options.fallbackMessage));
      },
      fail: (error) => reject(new Error(error.errMsg || options.fallbackMessage)),
    });
  }));
}

async function uploadCheckupMedia(bookingId: string, kind: CheckupMediaKind, filePath: string): Promise<CheckupMedia> {
  const payload = await uploadOperatorEnvelope<CheckupMedia>({
    path: `/operator/bookings/${encodeURIComponent(bookingId)}/checkup-report/media`,
    filePath,
    name: "file",
    formData: { kind },
    fallbackMessage: "现场照片上传失败",
  });
  return localizedOperatorCheckupMedia(normalizeCheckupMedia(payload.data));
}

async function uploadOperatorStationEvidence(
  bookingId: string,
  kind: ValetEvidenceMediaKind,
  filePath: string,
): Promise<ValetEvidenceMedia> {
  const payload = await uploadOperatorEnvelope<ValetEvidenceMedia>({
    path: `/operator/bookings/${encodeURIComponent(bookingId)}/evidence/station_arrival/media`,
    filePath,
    name: "file",
    formData: { kind },
    fallbackMessage: "到站留证照片上传失败",
  });
  return { ...payload.data, url: await localizeOperatorMedia(payload.data.url).catch(() => "") };
}

async function uploadFaultPhoto(
  bookingId: string,
  faultId: string,
  filePath: string,
  options: { replacePhotoId?: string; idempotencyKey: string },
): Promise<CheckupMedia> {
  const replaceQuery = options.replacePhotoId ? `?replacePhotoId=${encodeURIComponent(options.replacePhotoId)}` : "";
  const payload = await uploadOperatorEnvelope<CheckupMedia>({
    path: `/operator/bookings/${encodeURIComponent(bookingId)}/checkup-report/faults/${encodeURIComponent(faultId)}/photos${replaceQuery}`,
    filePath,
    name: "file",
    headers: { "Idempotency-Key": options.idempotencyKey },
    fallbackMessage: "故障特写上传失败",
  });
  return localizedOperatorCheckupMedia(normalizeCheckupMedia(payload.data));
}

async function uploadInsuranceLead(
  data: InsuranceLeadInput,
  licensePhotoPath: string,
  idempotencyKey: string,
): Promise<InsuranceLeadReceipt> {
  const payload = await uploadEnvelope<InsuranceReceiptPayload>({
    path: "/insurance/leads",
    filePath: licensePhotoPath,
    name: "licensePhoto",
    headers: { "Idempotency-Key": idempotencyKey },
    formData: {
      vehicleId: data.vehicleId,
      renewalWindow: data.renewalWindow,
      contactName: data.contactName,
      contactPhone: data.contactPhone,
      contactWindow: data.contactWindow,
      consentAccepted: "true",
      disclosureVersion: data.disclosureVersion,
    },
    fallbackMessage: "续保需求提交失败，请稍后重试",
  });
  const receipt = normalizeInsuranceReceipt(payload.data);
  if (!receipt.leadCode) throw new Error("提交成功但未返回服务凭证，请稍后查询");
  return receipt;
}

async function uploadSubsidyMaterial(kind: SubsidyMaterialKind, filePath: string): Promise<SubsidyMaterial> {
  const payload = await uploadEnvelope<SubsidyPayload>({
    path: "/subsidy-consultation/materials",
    filePath,
    name: "file",
    formData: { kind },
    fallbackMessage: "资料上传失败，请稍后重试",
  });
  const material = normalizeSubsidyMaterial(payload.data);
  if (!material.id) throw new Error("资料上传成功但未返回资料编号，请重新上传");
  return material;
}

export async function uploadMedia(kind: string, filePath: string): Promise<BookingMedia> {
  const payload = await uploadEnvelope<BookingMedia>({
    path: "/media",
    filePath,
    name: "file",
    formData: { kind },
    fallbackMessage: "图片上传失败",
  });
  return payload.data;
}

export function profileAvatarUrl(path: string): string {
  return mediaUrl(path);
}

export function mediaUrl(path: string): string {
  const value = String(path || "").trim();
  if (!value) return "";
  // These namespaces are served by the API, despite sharing the `/assets`
  // prefix used by bundled mini-program resources. Resolve them before the
  // local-resource branch; otherwise every failed catalog image collapses to
  // the same page fallback on a real device.
  if (/^\/assets\/(?:used-cars|driving-schools)\//iu.test(value)) {
    // Base library 3.8+ blocks HTTP <image> even in DevTools; catalog assets
    // are mirrored on the public HTTPS host, so prefer that in the simulator.
    if (apiOrigin.startsWith("http://")) {
      try {
        if (typeof wx !== "undefined" && wx.getSystemInfoSync().platform === "devtools") {
          return `https://app.yuxiaomancs.com${value}`;
        }
      } catch {
        // Fall through to the LAN API origin.
      }
    }
    return `${apiOrigin}${value}`;
  }
  if (/^(wxfile:|data:|blob:|file:)/iu.test(value)
    || value.startsWith("/assets/")
    || value.startsWith("/packages/")
    || value.startsWith("../")
    || value.startsWith("./")) return value;
  const legacyLoopback = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/.*)?$/iu);
  if (legacyLoopback) return `${apiOrigin}${legacyLoopback[1] || ""}`;
  // DevTools no longer renders LAN HTTP images; rewrite catalog asset hosts.
  if (value.startsWith("http://")) {
    try {
      if (typeof wx !== "undefined" && wx.getSystemInfoSync().platform === "devtools") {
        const lanAsset = value.match(/^https?:\/\/[^/]+(\/assets\/(?:used-cars|driving-schools)\/.*)$/iu);
        if (lanAsset) return `https://app.yuxiaomancs.com${lanAsset[1]}`;
      }
    } catch {
      // Keep the original URL.
    }
  }
  if (/^https?:\/\//iu.test(value)) return value;
  return `${apiOrigin}${value.startsWith("/") ? value : `/${value}`}`;
}

export function usedCarImageUrl(path: string): string {
  if (!path) return "/assets/brand/hero-car-tianjin.jpg";
  return mediaUrl(path);
}
