import type { PlateCategoryCode, PlateStyle } from "../utils/plate-categories";
export type AppRole = "consumer" | "operator" | "repair_shop";

export type UserProfile = {
  displayName: string | null;
  avatarUrl: string | null;
  profileComplete: boolean;
};
export type ServiceMode = "self_drive" | "valet";
export type BookingStatus = "pending_payment" | "paid_pending_confirmation" | "pending_precheck" | "precheck_action_required" | "precheck_rejected" | "confirmed" | "driver_arranged" | "picked_up" | "awaiting_arrival" | "checked_in" | "inspecting" | "result_received" | "returning" | "completed" | "on_hold" | "cancelled" | "no_show";
export type ServiceType = "annual_inspection" | "car_wash";
export type MediaKind = "vehicle_front_left" | "vehicle_front_right" | "vehicle_rear_left" | "vehicle_rear_right" | "dashboard_started" | "license_front" | "license_back";
export type DistanceBasis = "driving_route" | "estimated_distance" | "no_origin";
export type DistanceSource = "tencent_matrix" | "estimated" | "not_calculated";

export type InspectionDeclarationAnswer = "yes" | "no" | "unknown";
export type InspectionDeclarationKey = "isVan" | "hasInjuryAccident" | "hasIllegalModificationPenalty" | "convertedFromOperational" | "delayedFirstRegistrationOver4Years";
export type InspectionVehicleClass = "small_micro_passenger" | "other" | "unknown";
export type InspectionUsageNature = "non_operational" | "operational" | "unknown";
export type InspectionAction = "claim_mark" | "onsite_inspection" | "official_verification";
export type InspectionWindowStatus = "not_open" | "open" | "overdue" | "manual_review";
export type InspectionPowertrainType = "gasoline" | "diesel" | "hybrid" | "pure_electric" | "phev" | "erev" | "other" | "unknown";
export type InspectionFactSource = "vehicle_profile" | "plate_inferred" | "temporary_input" | "unknown" | "conflict";
export type InspectionOnsiteCheckCode = "safety_basic" | "safety_chassis_extended" | "emissions_gasoline" | "emissions_diesel" | "new_energy_safety" | "reinspection";
export type InspectionValiditySource = "traffic_12123" | "electronic_driving_license" | "paper_driving_license";
export type InspectionValidity =
  | { mode: "unconfirmed" }
  | {
      mode: "confirmed";
      validThroughMonth: string;
      source: InspectionValiditySource;
    };
export type VehicleInspectionValidity =
  | { mode: "unconfirmed" }
  | {
      mode: "confirmed";
      validThroughMonth: string;
      source: InspectionValiditySource;
      confirmedAt?: string | null;
    };

export type InspectionDeclarations = Record<InspectionDeclarationKey, InspectionDeclarationAnswer>;

export type InspectionCalculationRequest =
  | { source: "vehicle"; vehicleId: string; declarations: InspectionDeclarations }
  | {
      source: "temporary";
      vehicle: {
        registrationMonth: string;
        vehicleClass: InspectionVehicleClass;
        usageNature: InspectionUsageNature;
        seats: number | null;
        powertrainType?: InspectionPowertrainType;
      };
      declarations: InspectionDeclarations;
      inspectionValidity?: InspectionValidity;
    };

export type InspectionEvidence = {
  normalizedFacts: Array<{
    code: string;
    label: string;
    value: string;
    source: InspectionFactSource;
  }>;
  steps: Array<{
    id: "scope" | "cycle" | "due_date" | "window" | "current_status";
    title: string;
    expression: string;
    result: string;
    sourceIds: string[];
  }>;
  assumptions: string[];
  powertrainImpact: {
    powertrainType: InspectionPowertrainType;
    label?: string;
    affectsCycle: false;
    status: "applicable" | "not_applicable_this_cycle" | "needs_verification";
    expectedOnsiteCheckCodes: InspectionOnsiteCheckCode[];
    explanation: string;
    sourceIds: string[];
  };
};

export type InspectionDateEvidence = {
  estimate: { dueDate: string; basis: "policy_estimate" } | null;
  confirmation: {
    validThroughMonth: string;
    validThroughDate: string;
    source: InspectionValiditySource;
    confirmedAt: string | null;
  } | null;
  comparison: "not_provided" | "matched" | "note" | "conflict" | "not_comparable";
  decisionBasis: "policy_estimate" | "matched_confirmation" | "confirmed_priority" | "official_verification";
  explanation: string;
};

export type InspectionCalculation = {
  source: "vehicle" | "temporary";
  action: InspectionAction;
  windowStatus: InspectionWindowStatus;
  estimatedDueDate: string | null;
  applicationWindow: { start: string; end: string } | null;
  cycleYear: number | null;
  canBookInspection: boolean;
  title: string;
  summary: string;
  reasons: Array<{ code: string; label: string; detail: string }>;
  manualReviewReasons: string[];
  evidence: InspectionEvidence;
  dateEvidence: InspectionDateEvidence;
  policy: {
    id: string;
    version: string;
    effectiveFrom: string;
    reviewedAt: string;
    sources: Array<{ id: string; title: string; issuer: string; url: string; topics: string[]; effectiveFrom?: string }>;
  };
  disclaimer: string;
};

export type WashVehicleCategory = "sedan" | "suv" | "mpv";

export type Vehicle = {
  id: string;
  plateCategory?: PlateCategoryCode | null;
  plateCategoryLabel?: string;
  plateKind?: PlateStyle | null;
  vehicleClassCode?: string;
  washVehicleCategory?: WashVehicleCategory | "suv_mpv" | null;
  washVehicleCategoryLegacy?: boolean;
  plateNumber: string;
  energyCategory?: "none" | "pure_electric" | "non_pure_electric" | null;
  vehicleType: string;
  usageNature: string;
  seats: number;
  registrationDate: string;
  inspectionDueDate: string;
  inspectionDueDateSource?: "legacy_unverified" | "internal_placeholder" | InspectionValiditySource;
  inspectionDueDateConfirmedAt?: string | null;
  powertrainType?: InspectionPowertrainType;
  inspectionValidity?: VehicleInspectionValidity;
  facts?: {
    powertrainType: InspectionPowertrainType;
    powertrainSource: InspectionFactSource;
    factsConsistencyFailures?: string[];
  };
  isDefault: boolean;
  brand?: { id: string; name: string } | null;
  model?: { id: string; name: string } | null;
  exteriorColor?: string | null;
  visual?: { imageUrl: string; kind: "presentation_cutout" | "unavailable"; label: string } | null;
};

export type VehicleInput = {
  plateCategory?: PlateCategoryCode;
  plateNumber: string;
  vehicleType: string;
  usageNature: string;
  seats: number;
  registrationDate: string;
  inspectionDueDate?: string;
  inspectionValidity?: InspectionValidity;
  powertrainType?: InspectionPowertrainType;
  vehicleClassCode?: string;
  isVan?: boolean;
  isDefault?: boolean;
  washVehicleCategory?: WashVehicleCategory;
  brandId?: string | null;
  modelId?: string | null;
  exteriorColor?: string | null;
};

export type VehicleCatalogModel = {
  id: string;
  brandId: string;
  name: string;
  imageUrl: string;
  imageKind: "presentation_cutout" | "unavailable";
  vehicleClassCodes: string[];
};

export type VehicleCatalogBrand = {
  id: string;
  name: string;
  logoUrl: string;
  searchKeywords?: string[];
  models: VehicleCatalogModel[];
};

export type VehicleCatalog = {
  brands: VehicleCatalogBrand[];
  disclosure: {
    kind: "model_reference";
    label: string;
    message: string;
  };
};

export type InsuranceRenewalWindow = "within_30_days" | "one_to_three_months" | "over_three_months";
export type InsuranceContactWindow = "morning" | "afternoon" | "evening" | "anytime";

export type InsuranceDisclosure = {
  mode: "demo" | "real";
  version: string;
  title: string;
  summary: string;
  items: string[];
  acceptsRealData: boolean;
  partner: {
    id: string;
    name: string;
    recipientName: string;
  };
  dataScope: string[];
  purpose: string;
  retention: string;
  consentText: string;
  contactEtaText: string;
};

export type InsuranceLeadInput = {
  vehicleId: string;
  renewalWindow: InsuranceRenewalWindow;
  contactName: string;
  contactPhone: string;
  contactWindow: InsuranceContactWindow;
  consentAccepted: true;
  disclosureVersion: string;
};

export type InsuranceLeadReceipt = {
  leadCode: string;
  submittedAt: string;
  vehicle: {
    id?: string;
    plateNumber: string;
    modelName: string;
    exteriorColor?: string | null;
  };
  maskedPhone: string;
  contactEtaText: string;
  withdrawToken: string;
  duplicate: boolean;
  status?: string;
};

export type SubsidyMaterialKind =
  | "id_card_front"
  | "id_card_back"
  | "driving_license_front"
  | "driving_license_back"
  | "vehicle_front_left"
  | "vehicle_front_right"
  | "vehicle_rear_left"
  | "vehicle_rear_right"
  | "dashboard_started";

export type SubsidyAdministrativeFees = {
  plateFeeFen: number;
  mailingFeeFen: number;
  productionFeeFen: number;
};

export type SubsidyFeeTier = {
  id: string;
  label: string;
  minValueFen: number;
  maxValueFen: number;
  feeFen: number;
  totalTransferCostFen: number;
  sortOrder: number;
};

export type SubsidyFeePlan = {
  version: string;
  active: boolean;
  administrativeFees: SubsidyAdministrativeFees;
  administrativeFeeFen: number;
  tiers: SubsidyFeeTier[];
};

export type SubsidyMaterialDefinition = {
  kind: SubsidyMaterialKind;
  label: string;
  group: string;
};

export type SubsidyDemoContact = {
  name: string;
  phone: string;
};

export type SubsidyConsultationConfig = {
  mode: "demo" | "real";
  acceptsRealData: boolean;
  materialUploadMode: "server_generated_demo" | "multipart";
  materialUploadEndpoint: string | null;
  demoMaterialEndpoint: string | null;
  demoContact: SubsidyDemoContact | null;
  maxDeclaredValueFen: number;
  quoteValiditySeconds: number;
  disclosure: {
    version: string;
    title: string;
    summaryText: string;
    dataScope: string[];
    purpose: string;
    retention: string;
    retentionText: string;
    consentText: string;
    legalPurposeText: string;
    contactEtaText: string;
    officialSourceUrl: string;
    modeNotice: string;
  };
  feePlan: SubsidyFeePlan;
  materialKinds: SubsidyMaterialDefinition[];
  serviceBoundary: {
    declaredValueLabel: string;
    feeLabel: string;
    officialSubsidyAmountProvided: false;
    isAppraisal: false;
    notice: string;
  };
};

export type SubsidyQuote = {
  id: string;
  vehicleId: string;
  declaredValueFen: number;
  declaredValueSource: "owner_self_reported";
  isAppraisal: false;
  matchedTier: SubsidyFeeTier;
  consultationFeeFen: number;
  administrativeFees: SubsidyAdministrativeFees;
  administrativeFeeFen: number;
  totalTransferCostFen: number;
  planVersion: string;
  createdAt: string;
  expiresAt: string;
  disclaimer: string;
};

export type SubsidyMaterial = {
  id: string;
  kind: SubsidyMaterialKind;
  mimeType: string;
  sizeBytes: number;
  status: "staged";
  expiresAt: string;
};

export type SubsidyConsultationStatus = "new" | "handled" | "withdrawn" | "expired";

export type SubsidyConsultationReceipt = {
  id: string;
  consultationCode: string;
  status: SubsidyConsultationStatus;
  vehicle: {
    id?: string;
    plateNumber: string;
    modelName: string;
  };
  declaredValueFen: number;
  matchedTier: SubsidyFeeTier;
  consultationFeeFen: number;
  administrativeFees: SubsidyAdministrativeFees;
  administrativeFeeFen: number;
  totalTransferCostFen: number;
  planVersion: string;
  contactNameMasked: string;
  maskedPhone: string;
  submittedAt: string;
  contactEtaText: string;
  materialKinds: SubsidyMaterialKind[];
  canWithdraw: boolean;
  duplicate: boolean;
  serviceBoundaryNotice: string;
};

export type SubsidyConsultationCreateInput = {
  quoteId: string;
  materialIds: string[];
  contactName: string;
  contactPhone: string;
  disclosureVersion: string;
  consentAccepted: true;
  legalPurposeAccepted: true;
};

export type RouteInfo = {
  distanceKm: number | null;
  driveMinutes: number | null;
  distanceBasis: DistanceBasis;
  distanceSource: DistanceSource;
};

export type Station = RouteInfo & {
  id: string;
  name: string;
  district: string;
  address: string;
  rating: number;
  reviewCount: number;
  tags: string[];
  serviceFeeFen: number;
  openHours: string;
  phone: string | null;
  latitude: number;
  longitude: number;
  isActive: boolean;
};

export type Slot = { id: string; stationId: string; date: string; startTime: string; endTime: string; capacity: number; remaining: number };

export type PickupAddress = {
  poiId: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  source: "tencent" | "wechat" | "demo";
  locationProof?: string;
  detail?: string;
  note?: string;
};

export type BookingQuote = RouteInfo & {
  quoteSnapshotId: string;
  serviceMode: ServiceMode;
  vehiclePriceCategory: "fuel_small" | "new_energy_small" | "seven_seat";
  inspectionFeeFen: number;
  valetFeeFen: number;
  serviceFeeFen: number;
  serviceable: boolean;
  reason?: "origin_required";
  oneWayDistanceKm?: number | null;
  roundTripDistanceKm?: number | null;
  billableDistanceKm?: number | null;
  extraKm?: number;
  rule?: { baseFeeFen: number; includedKm: number; perKmFen: number; maxRadiusKm: number | null };
  breakdown?: {
    inspectionFeeFen: number;
    valetBaseFeeFen: number;
    valetDistanceFeeFen: number;
    valetFeeFen: number;
    totalFeeFen: number;
  };
};

export type BookingMedia = {
  id: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  url: string;
  sourceUrl?: string;
  loadState?: "loading" | "ready" | "failed";
  createdAt: string;
};
export type ValetEvidenceStage = "owner_pickup" | "station_arrival" | "inspection_complete" | "owner_return";
export type ValetEvidenceMediaKind = "front_left" | "front_right" | "rear_left" | "rear_right" | "dashboard_started";
export type ValetEvidenceMedia = {
  id: string;
  kind: ValetEvidenceMediaKind;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  url: string;
  createdAt: string;
};
export type ValetEvidencePackage = {
  id: string | null;
  stage: ValetEvidenceStage;
  label: string;
  status: "pending" | "completed";
  capturedAt: string | null;
  capturedByLabel: string | null;
  photos: ValetEvidenceMedia[];
};
export type ValetDriverAssignment = {
  id: string;
  driverName: string;
  driverPhone: string;
  status: "assigned" | "bound" | "in_progress" | "completed";
  assignedAt: string;
  boundAt: string | null;
  completedAt: string | null;
};
export type CheckupViewId = "top" | "left" | "right";
export type CheckupMediaKind = "front_left" | "front_right" | "rear_left" | "rear_right" | "dashboard_started" | "safety_inspection_report" | "emissions_inspection_report" | "annual_inspection_mark" | "fault_closeup";
export type CheckupFaultType = "scratch" | "dent" | "paint_damage" | "crack" | "broken" | "rust" | "warning_light" | "malfunction" | "abnormal_noise" | "leakage" | "wear" | "other";
export type CheckupFaultSeverity = "minor" | "moderate" | "severe";
export type CheckupObservationMode = "no_visible_faults" | "faults_recorded";
export type CheckupConclusion = "passed" | "failed";
export type CheckupConclusionStatus = "available" | "pending" | "legacy_requires_reentry";
export type CheckupFailureDetailsStatus = "complete" | "not_applicable" | "pending" | "legacy_missing_details";
export type CheckupFailureCategory = "vehicle_uniqueness" | "vehicle_characteristics" | "vehicle_appearance" | "safety_devices" | "chassis_dynamic" | "vehicle_underbody" | "instrumented_test" | "emissions" | "other_official_item";
export type CheckupFailureDetails = { itemCategories: CheckupFailureCategory[]; reason: string; reinspectionAdvice: string };

export type CheckupMedia = {
  id: string;
  bookingId?: string;
  reportId?: string | null;
  faultId?: string | null;
  kind: CheckupMediaKind;
  sequence?: number;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  url: string;
  sourceUrl?: string;
  loadState?: "loading" | "ready" | "failed";
  status?: "staged" | "bound";
  createdAt?: string;
  boundAt?: string | null;
  expiresAt?: string | null;
};

export type VehicleFault = {
  id: string;
  clientKey?: string;
  viewId: CheckupViewId;
  regionCode: string;
  faultType: CheckupFaultType;
  severity: CheckupFaultSeverity;
  description?: string | null;
  photos?: CheckupMedia[];
};

export type VehicleCheckupReport = {
  id?: string;
  bookingId?: string;
  reportNo?: string;
  schemaVersion?: string;
  diagramVersion: "sedan-3view-v1";
  status?: "draft" | "published";
  rowVersion?: number;
  observationMode: CheckupObservationMode | null;
  summary?: Record<string, unknown> | null;
  annualInspection: {
    conclusion: CheckupConclusion | null;
    conclusionStatus?: CheckupConclusionStatus;
    failureDetails?: CheckupFailureDetails | null;
    failureDetailsStatus?: CheckupFailureDetailsStatus;
    summary?: Record<string, unknown> | null;
    markStatus?: "issued" | "not_issued";
    markPhoto?: CheckupMedia | null;
  };
  legalMaterials?: {
    safetyInspectionReport?: CheckupMedia | null;
    emissionsInspectionReport?: CheckupMedia | null;
    annualInspectionMark?: CheckupMedia | null;
    status?: "available" | "pending" | "legacy_missing";
  };
  sitePhotos?: {
    frontLeft?: CheckupMedia | null;
    frontRight?: CheckupMedia | null;
    rearLeft?: CheckupMedia | null;
    rearRight?: CheckupMedia | null;
    dashboardStarted?: CheckupMedia | null;
  };
  faults: VehicleFault[];
  media: CheckupMedia[];
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string | null;
  retainUntil?: string | null;
};

export type VehicleCheckupReportInput = {
  rowVersion?: number;
  observationMode: CheckupObservationMode | null;
  diagramVersion: "sedan-3view-v1";
  summary?: Record<string, unknown>;
  annualInspection: { conclusion: CheckupConclusion | null; summary?: Record<string, unknown>; failureDetails?: CheckupFailureDetails | null };
  faults: Array<Omit<VehicleFault, "id" | "photos"> & { id?: string }>;
};

export type VehicleCheckupReportVehicleSummary = {
  id: string;
  plateNumber: string;
  vehicleType: string;
  brandName: string | null;
  modelName: string | null;
  displayName: string;
};

export type VehicleCheckupReportStationSummary = {
  id: string;
  name: string;
  district: string;
  address: string;
};

export type VehicleCheckupReportSummary = {
  bookingId: string;
  bookingNumber: string;
  bookingStatus: BookingStatus;
  fulfillmentStatus: BookingStatus;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  reportId: string;
  reportNo: string;
  reportStatus: "published";
  schemaVersion: string;
  publishedAt: string;
  retainUntil: string | null;
  vehicle: VehicleCheckupReportVehicleSummary;
  station: VehicleCheckupReportStationSummary;
  serviceMode: ServiceMode;
  conclusion: CheckupConclusion | null;
  conclusionStatus?: CheckupConclusionStatus;
  observationMode: CheckupObservationMode | null;
  faultCount: number;
  sitePhotoCount: number;
  faultPhotoCount: number;
  photoCount: number;
  markStatus: "issued" | "not_issued" | null;
  hasAnnualMark: boolean;
  hasSafetyInspectionReport?: boolean;
  hasEmissionsInspectionReport?: boolean;
  legalMaterialsStatus?: "available" | "legacy_missing";
};

export type VehicleCheckupReportProgress = {
  bookingId: string;
  bookingNumber: string;
  bookingStatus: BookingStatus;
  fulfillmentStatus: BookingStatus;
  paymentStatus: "unpaid" | "paid" | "refunded";
  appointmentDate: string;
  startTime: string;
  endTime: string;
  vehicle: VehicleCheckupReportVehicleSummary;
  station: VehicleCheckupReportStationSummary;
  serviceMode: ServiceMode;
  progressType: "booking_in_progress" | "result_pending_report";
  conclusion: CheckupConclusion | null;
  conclusionStatus?: CheckupConclusionStatus;
  resultReceivedAt: string | null;
  reportReady: boolean;
  updatedAt: string;
};

export type VehicleCheckupReportListData = {
  progress: VehicleCheckupReportProgress[];
  items: VehicleCheckupReportSummary[];
};

export type VehicleCheckupReportListPage = VehicleCheckupReportListData & {
  limit: number;
  nextCursor: string | null;
};

export type VehicleCheckupReportListQuery = {
  vehicleId?: string;
  limit?: number;
  cursor?: string;
};

export type RepairRequestStatus = "open" | "paid" | "cancelled";
export type RepairQuoteStatus = "active" | "withdrawn" | "selected" | "lost";

export type RepairVehicleSnapshot = {
  id: string;
  plateNumber: string;
  vehicleType: string;
  exteriorColor?: string | null;
  brandName: string | null;
  modelName: string | null;
  displayName: string;
};

export type RepairReportSnapshot = {
  id: string;
  bookingId: string;
  reportNo: string;
  schemaVersion: string;
  publishedAt: string;
  annualConclusion: CheckupConclusion | null;
  annualConclusionStatus?: CheckupConclusionStatus;
  observationMode: CheckupObservationMode | null;
  summary: Record<string, unknown>;
};

export type RepairRequestMedia = {
  id: string;
  sourceMediaId: string;
  kind: "fault_closeup" | string;
  faultId: string | null;
  sequence: number | null;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  url: string;
  sourceUrl?: string;
  loadState?: "loading" | "ready" | "failed";
};

export type RepairRequestFault = {
  id: string;
  sourceFaultId?: string;
  sequence: number;
  viewId: CheckupViewId;
  regionCode: string;
  faultType: CheckupFaultType;
  severity: CheckupFaultSeverity | "unassessed";
  description: string | null;
  photos: RepairRequestMedia[];
};

export type RepairShopSummary = {
  id: string;
  name: string;
  district: string;
  distanceKm: number;
  rating: number;
  isDemo: boolean;
};

export type RepairShopContact = RepairShopSummary & {
  address: string;
  contactName: string;
  contactPhone: string;
  openHours: string;
};

export type RepairRequestQuote = {
  id: string;
  status: RepairQuoteStatus;
  totalPriceFen: number;
  note: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  shop: RepairShopSummary;
};

export type RepairOrder = {
  id: string;
  orderNo: string;
  status: "paid";
  totalPriceFen: number;
  paidAt: string;
  shop: RepairShopContact;
  payment: {
    provider: "mock";
    status: "confirmed";
    amountFen: number;
    confirmedAt: string;
  };
};

export type RepairRequest = {
  sourceType?: "report" | "precheck";
  sourceBookingId?: string;
  id: string;
  requestNo: string;
  status: RepairRequestStatus;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  paidAt: string | null;
  demoNotice: string;
  serviceBoundary: string;
  vehicle: RepairVehicleSnapshot;
  report: RepairReportSnapshot;
  faults: RepairRequestFault[];
  media: RepairRequestMedia[];
  quotes: RepairRequestQuote[];
  selectedQuoteId: string | null;
  order: RepairOrder | null;
};

export type RepairRequestSummary = {
  id: string;
  requestNo: string;
  status: RepairRequestStatus;
  vehicle: RepairVehicleSnapshot;
  report: RepairReportSnapshot;
  quoteCount: number;
  lowestPriceFen: number | null;
  selectedQuoteId: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  demoNotice: string;
};

export type DemoRepairShop = RepairShopContact & {
  basePriceFen: number;
  defaultQuoteNote: string;
  role: "synthetic_demo_repair_shop";
  active: boolean;
  demoNotice: string;
};

export type BookingEvent = { id: string; status: BookingStatus; title: string; description: string; actorType: string; createdAt: string };
export type Verification = { plateMatched: boolean; materialsReady: boolean; exteriorRecorded: boolean; vehicleConditionConfirmed: boolean; notes: string | null; verifiedAt: string | null };
export type InspectionResult = { externalResultId: string; conclusion: CheckupConclusion | null; conclusionStatus?: CheckupConclusionStatus; failureDetails?: CheckupFailureDetails | null; failureDetailsStatus?: CheckupFailureDetailsStatus; summary: Record<string, unknown>; source: string; receivedAt: string };
export type BookingPrecheck = {
  guidance?: Array<{ code: string; label: string; action: "materials" | "wash" | "repair"; effect: string }>;
  history?: Array<{ version: number; reasonText: string; reviewerName: string; reviewedAt: string }>;
  resolutionNote?: string | null;
  id: string;
  bookingId: string;
  stationId: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  reviewedAt: string | null;
  reviewerName: string | null;
  reasonCodes: string[];
  reasonText: string | null;
  issuePhotoKinds: MediaKind[];
  refundStatus: "not_requested" | "refund_pending" | "refunded" | "refund_failed";
  refundAmountFen: number;
  refundError: string | null;
  refundRequestedAt: string | null;
  refundCompletedAt: string | null;
  version: number;
  reminderDue: boolean;
  overdue: boolean;
  supervision: null | {
    taskId: string;
    status: string;
    policyVersion: number;
    firstReminderAt: string | null;
    dueAt: string | null;
    escalateAt: string | null;
    lastRemindedAt: string | null;
    reminderCount: number;
    escalatedAt: string | null;
    inAppCreatedAt: string | null;
    externalDeliveryStatus: string | null;
    externalAcceptedAt: string | null;
    externalLastErrorCode: string | null;
  };
};

export type Booking = {
  precheckSlotReleased?: boolean;
  precheckServices?: Array<{ id: string; type: "repair" | "wash"; label: string; status: string }>;
  id: string;
  bookingNumber: string;
  vehicleId: string;
  stationId: string;
  slotId: string;
  contactName: string;
  contactPhone: string;
  serviceFeeFen: number;
  inspectionFeeFen: number;
  valetFeeFen: number;
  chargedFen?: number;
  paidFen?: number;
  refundedFen?: number;
  amountDueFen?: number;
  serviceMode: ServiceMode;
  vehiclePriceCategory: string;
  quoteDistanceKm: number | null;
  quoteSource: string;
  quoteSnapshotId?: string | null;
  quoteExpiresAt?: string | null;
  tripType?: "round_trip_same_address" | "legacy_one_way" | null;
  serviceScope?: "round_trip_same_address" | null;
  isLegacyOneWayValet?: boolean;
  oneWayDistanceKm?: number | null;
  roundTripDistanceKm?: number | null;
  billableDistanceKm?: number | null;
  extraKm?: number | null;
  priceBreakdown?: {
    inspectionFeeFen: number;
    valetBaseFeeFen: number;
    valetDistanceFeeFen: number;
    valetFeeFen: number;
    totalFeeFen: number;
  };
  valetRule?: {
    scope?: string;
    stationId?: string | null;
    baseFeeFen: number;
    includedKm: number;
    perKmFen: number;
    maxRadiusKm?: number | null;
    updatedAt?: string | null;
    version?: string | null;
  } | null;
  status: BookingStatus;
  fulfillmentStatus?: BookingStatus | "legacy";
  paymentStatus?: "unpaid" | "paid" | "partially_refunded" | "refunded";
  appointmentDate: string;
  startTime: string;
  endTime: string;
  notes: string | null;
  pickupAddress: PickupAddress | null;
  createdAt: string;
  updatedAt: string;
  station?: Station;
  vehicle?: Vehicle;
  media?: BookingMedia[];
  events?: BookingEvent[];
  verification?: Verification | null;
  inspectionResult?: InspectionResult | null;
  vehicleCheckupReport?: VehicleCheckupReport | null;
  evidencePolicyVersion?: "legacy" | "not_applicable" | "valet-handoff-v1";
  evidencePackages?: ValetEvidencePackage[];
  driverAssignment?: ValetDriverAssignment | null;
  precheck?: BookingPrecheck | null;
  refundStatus?: BookingPrecheck["refundStatus"];
};

export type Workbench = {
  businessDate: string;
  station: Station;
  summary: { todayBookings: number; totalCapacity: number; remainingCapacity: number; awaitingArrival: number; checkedIn: number; inspecting: number; resultReceived: number; completed: number; onHold: number; pendingPrecheckCount: number };
  pressure: Array<{ slotId: string; label: string; startTime: string; endTime: string; level: "low" | "medium" | "high"; booked: number; capacity: number; remaining: number; utilization: number }>;
  bookings: Booking[];
};

export type BookingDraft = {
  serviceMode: ServiceMode;
  vehicleId?: string;
  origin?: { latitude: number; longitude: number; type: "self_drive" | "valet" };
  pickupAddress?: PickupAddress;
  station?: Station;
  slot?: Slot;
};

export type WashOrderStatus =
  | "pending_payment"
  | "awaiting_redemption"
  | "redeemed"
  | "cancelled"
  | "refunded"
  | "expired";

export type WashStoreImage = {
  id: string;
  url: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  sortOrder?: number;
  isCover?: boolean;
  isStored?: boolean;
  dataKind: "demo";
  createdAt?: string;
};

export type WashStore = {
  id: string;
  serviceType?: "car_wash";
  name: string;
  address: string;
  district?: string;
  distanceKm?: number | null;
  distanceSource?: DistanceSource;
  distanceBasis?: DistanceBasis;
  phone?: string | null;
  openHours?: string | null;
  businessHoursNotice?: string | null;
  weeklySchedule?: Record<string, unknown>;
  advanceBookingDays?: number;
  latitude?: number | null;
  longitude?: number | null;
  earliestSlot?: string | null;
  coverImageUrl?: string | null;
  imageCount?: number;
  images?: WashStoreImage[];
  description?: string;
  tags?: string[];
  facilities?: string[];
  rating?: number | null;
  reviewCount?: number;
  startingPriceFen?: number | null;
  dataKind?: "demo";
  isOpen?: boolean;
  isActive?: boolean;
  sortPriority?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type WashPackage = {
  id: string;
  packageId?: string;
  storeId: string;
  name: string;
  shortDescription?: string;
  summary?: string;
  description?: string;
  serviceItems?: string[];
  includedItems?: string[];
  priceFen: number;
  listPriceFen?: number | null;
  estimatedSettlementFen?: number | null;
  vehicleCategory?: WashVehicleCategory;
  durationMinutes?: number | null;
  isActive?: boolean;
};

export type WashSlot = {
  id: string;
  storeId: string;
  date: string;
  startTime: string;
  endTime?: string;
  capacity?: number;
  remaining: number;
};

export type WashQuote = {
  serviceType: "car_wash";
  vehicleId: string;
  storeId: string;
  packageId: string;
  slotId: string;
  vehicleCategory?: WashVehicleCategory;
  packageName?: string;
  serviceMode: ServiceMode;
  tripType: "round_trip_same_address" | null;
  serviceable: boolean;
  washFeeFen: number;
  valetFeeFen: number;
  serviceFeeFen: number;
  totalFeeFen: number;
  pickupAddress: PickupAddress | null;
  oneWayDistanceKm: number | null;
  roundTripDistanceKm: number | null;
  billableDistanceKm: number | null;
  driveMinutes: number | null;
  extraKm: number;
  distanceSource: DistanceSource;
  distanceBasis: DistanceBasis;
  valetRule?: {
    scope: string;
    storeId: string | null;
    baseFeeFen: number;
    includedKm: number;
    perKmFen: number;
    maxRadiusKm: number | null;
    updatedAt: string;
    version: string;
  } | null;
  breakdown: {
    washFeeFen: number;
    valetBaseFeeFen: number;
    valetDistanceFeeFen: number;
    valetFeeFen: number;
    totalFeeFen: number;
  };
  quoteSnapshotId: string;
  expiresAt?: string;
};

export type WashOrder = {
  id: string;
  orderNumber?: string;
  serviceType: "car_wash";
  vehicleId: string;
  storeId: string;
  packageId: string;
  slotId: string;
  vehicleCategory?: WashVehicleCategory;
  status: WashOrderStatus;
  paymentStatus?: "unpaid" | "paid" | "refunded";
  contactName: string;
  contactPhone: string;
  notes?: string | null;
  serviceMode: ServiceMode;
  tripType?: "round_trip_same_address" | null;
  serviceable?: boolean;
  washFeeFen?: number;
  valetFeeFen?: number;
  serviceFeeFen: number;
  totalFeeFen?: number;
  pickupAddress?: PickupAddress | null;
  oneWayDistanceKm?: number | null;
  roundTripDistanceKm?: number | null;
  billableDistanceKm?: number | null;
  driveMinutes?: number | null;
  extraKm?: number;
  distanceSource?: DistanceSource;
  distanceBasis?: DistanceBasis;
  valetRule?: WashQuote["valetRule"];
  breakdown?: WashQuote["breakdown"];
  appointmentDate: string;
  startTime: string;
  endTime?: string;
  redemptionCode?: string | null;
  verificationCode?: string | null;
  createdAt: string;
  updatedAt?: string;
  vehicle?: Vehicle;
  store?: WashStore;
  package?: WashPackage;
  offer?: WashPackage;
};

export type WashDraft = {
  precheckBookingId?: string;
  serviceMode?: ServiceMode;
  pickupAddress?: PickupAddress;
  selfDriveOrigin?: { latitude: number; longitude: number; type: "self_drive" };
  vehicleId?: string;
  storeId?: string;
  packageId?: string;
  slotId?: string;
  date?: string;
};

export type UsedCarEnergyType = "gasoline" | "diesel" | "pure_electric" | "plug_in_hybrid" | "range_extended" | "hybrid" | "other";
export type UsedCarSort = "recommended" | "price_asc" | "price_desc" | "mileage_asc" | "newest";

export type UsedCarModel = {
  id: string;
  name: string;
  bodyType: string;
  energyType: UsedCarEnergyType | string;
  listingCount: number;
};

export type UsedCarBrand = {
  id: string;
  name: string;
  initial: string;
  logoUrl: string;
  isHot: boolean;
  listingCount: number;
  models: UsedCarModel[];
};

export type UsedCarBrandGroup = {
  initial: string;
  brands: UsedCarBrand[];
};

export type UsedCarCatalog = {
  groups: UsedCarBrandGroup[];
  hotBrands: UsedCarBrand[];
};

export type UsedCarImage = {
  id: string;
  url: string;
  sortOrder: number;
  isCover: boolean;
  alt?: string;
};

export type UsedCarListing = {
  id: string;
  stockNo: string;
  title: string;
  brand: UsedCarBrand;
  model: UsedCarModel;
  modelYear: number;
  registrationDate: string;
  mileageKm: number;
  priceFen: number;
  originalPriceFen: number | null;
  location: string;
  exteriorColor: string;
  interiorColor: string;
  energyType: UsedCarEnergyType | string;
  transmission: string;
  seats: number;
  highlights: string[];
  description: string;
  status: string;
  dataKind: string;
  isSynthetic: boolean;
  publishedAt: string;
  images: UsedCarImage[];
  coverUrl: string;
};

export type UsedCarListingQuery = {
  brandId?: string;
  modelId?: string;
  sort?: UsedCarSort;
  priceMinFen?: number;
  priceMaxFen?: number;
  maxMileageKm?: number;
  maxAgeYears?: number;
  energyType?: string;
  page?: number;
  pageSize?: number;
};

export type UsedCarListingPage = {
  items: UsedCarListing[];
  total: number;
  page: number;
  pageSize: number;
};

export type CarRentalFulfillmentMode = "store_pickup" | "home_delivery";
export type CarRentalEnergyType =
  | "gasoline"
  | "diesel"
  | "hybrid"
  | "plug_in_hybrid"
  | "range_extended"
  | "pure_electric"
  | "other";
export type CarRentalSort = "recommended" | "price_asc" | "price_desc";
export type CarRentalOrderStatus =
  | "pending_payment"
  | "confirmed"
  | "ready_for_pickup"
  | "in_use"
  | "return_pending"
  | "completed"
  | "cancelled"
  | "expired";

export type CarRentalImage = {
  id: string;
  url: string;
  sortOrder: number;
  isCover: boolean;
  alt?: string;
};

export type CarRentalModel = {
  id: string;
  brandId: string;
  brandName: string;
  brandLogoUrl: string;
  name: string;
  bodyType: string;
  energyType: CarRentalEnergyType;
  seats: number;
  transmission: string;
  luggage: number;
  imageUrl: string;
  images: CarRentalImage[];
  availableCount: number;
  minDailyRateFen: number;
  vehicleDepositFen: number;
  mileagePolicy: string;
  energyPolicy: string;
  cancellationPolicy: string;
  highlights: string[];
};

export type CarRentalBrand = {
  id: string;
  name: string;
  initial: string;
  logoUrl: string;
  isHot: boolean;
  availableCount: number;
  models: CarRentalModel[];
};

export type CarRentalCatalog = {
  groups: Array<{ initial: string; brands: CarRentalBrand[] }>;
  hotBrands: CarRentalBrand[];
  disclosure: { kind: "synthetic_demo"; label: string; message: string };
};

export type CarRentalStore = {
  id: string;
  name: string;
  district: string;
  address: string;
  openHours: string;
  phone?: string | null;
  latitude: number;
  longitude: number;
  isActive: boolean;
  deliveryEnabled: boolean;
  deliveryRule?: {
    baseFeeFen: number;
    includedKm: number;
    perKmFen: number;
    maxRadiusKm: number;
  } | null;
};

export type CarRentalSearch = {
  fulfillmentMode: CarRentalFulfillmentMode;
  storeId?: string;
  deliveryAddress?: PickupAddress;
  pickupAt: string;
  returnAt: string;
  brandId?: string;
  energyType?: CarRentalEnergyType;
  sort?: CarRentalSort;
};

export type CarRentalOffer = {
  id: string;
  storeId: string;
  storeName: string;
  model: CarRentalModel;
  availableCount: number;
  rentalDays: number;
  dailyRateFen: number;
  vehicleRentFen: number;
  basicProtectionFen: number;
  preparationFeeFen: number;
  deliveryFeeFen: number;
  estimatedTotalFen: number;
  priceLabel: string;
  exactModelGuaranteed: boolean;
};

export type CarRentalOfferPage = {
  items: CarRentalOffer[];
  total: number;
  rentalDays: number;
  selectedStore: CarRentalStore | null;
};

export type CarRentalQuote = {
  id: string;
  quoteSnapshotId: string;
  expiresAt: string;
  fulfillmentMode: CarRentalFulfillmentMode;
  store: CarRentalStore;
  model: CarRentalModel;
  deliveryAddress: PickupAddress | null;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  includeOptionalProtection: boolean;
  breakdown: {
    vehicleRentFen: number;
    basicProtectionFen: number;
    preparationFeeFen: number;
    optionalProtectionFen: number;
    deliveryFeeFen: number;
    prepaidTotalFen: number;
  };
  deposits: {
    vehicleDepositFen: number;
    violationDepositFen: number;
    includedInPrepaid: false;
  };
  route?: {
    distanceKm: number;
    driveMinutes: number | null;
    source: "tencent" | "other";
  } | null;
  disclosure: string;
};

export type CarRentalOrder = {
  id: string;
  orderNumber: string;
  status: CarRentalOrderStatus;
  paymentStatus: "unpaid" | "paid" | "refunded";
  fulfillmentMode: CarRentalFulfillmentMode;
  store: CarRentalStore;
  model: CarRentalModel;
  deliveryAddress: PickupAddress | null;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  contactName: string;
  contactPhoneMasked: string;
  quote: CarRentalQuote;
  assignedVehicle?: { id: string; color?: string; plateMasked?: string; displayCode?: string } | null;
  createdAt: string;
  updatedAt: string;
  events?: Array<{ id: string; status: CarRentalOrderStatus; title: string; description: string; createdAt: string }>;
};

export type CarRentalDraft = CarRentalSearch & {
  selectedOffer?: CarRentalOffer;
  selectedModelId?: string;
  quote?: CarRentalQuote;
};

export type DrivingSchoolApplicationMode = "initial" | "upgrade";
export type DrivingSchoolSort = "recommended" | "price_asc" | "updated";
export type DrivingSchoolContactWindow = "morning" | "afternoon" | "evening" | "anytime";

export type DrivingSchoolLicenseClassOption = {
  code: string;
  name: string;
  group: string;
  vehicleScope: string;
  initialAllowed: boolean;
  upgradeAllowed: boolean;
  supportedApplicationModes: DrivingSchoolApplicationMode[];
  conditions: string[];
};

export type DrivingSchoolLicenseClassGroup = {
  id: string;
  label: string;
  items: DrivingSchoolLicenseClassOption[];
};

export type DrivingSchoolMetaOption = {
  value: string;
  label: string;
  description?: string;
};

export type DrivingSchoolMeta = {
  licenseClassGroups: DrivingSchoolLicenseClassGroup[];
  applicationModes: DrivingSchoolMetaOption[];
  districts: DrivingSchoolMetaOption[];
  regulatoryTypes: DrivingSchoolMetaOption[];
  priceTypes: DrivingSchoolMetaOption[];
  capabilityLevels: DrivingSchoolMetaOption[];
  sortOptions: DrivingSchoolMetaOption[];
  trainingCapabilityNotice: string;
};

export type DrivingSchoolLocation = {
  poiId?: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  source: string;
};

export type DrivingSchoolRegulatory = {
  type: string;
  number?: string | null;
  authority?: string | null;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  verifiedAt?: string | null;
  status?: string | null;
  capabilityLevel?: string | number | null;
};

export type DrivingSchoolImage = {
  id: string;
  url: string;
  caption: string;
  altText: string;
  isCover: boolean;
  sortOrder: number;
};

export type DrivingSchoolTrainingClass = {
  licenseClassCode: string;
  name: string;
  vehicleScope?: string;
  supportedModes: DrivingSchoolApplicationMode[];
  /** @deprecated Compatibility only; owner UI must not render this as a vehicle-level rating. */
  trainingCapabilityLevel?: string | null;
  trainingCapabilityNote: string | null;
  catalogConditions: string[];
  schoolConditions: string[];
  conditions: string[];
  status: "active" | "inactive";
};

export type DrivingSchoolOffer = {
  id: string;
  licenseClassCode: string;
  name: string;
  priceType: string;
  minPriceFen: number | null;
  maxPriceFen: number | null;
  description?: string | null;
  status: "active" | "inactive";
  applicationModes: DrivingSchoolApplicationMode[];
  unit?: string | null;
  includedItems: string[];
  excludedItems: string[];
};

export type DrivingSchoolListItem = {
  id: string;
  name: string;
  legalName: string;
  dataKind: string;
  isDemo: boolean;
  district: string;
  address: string;
  location: DrivingSchoolLocation | null;
  publicPhone?: string | null;
  coverImage: string;
  trainingClasses: DrivingSchoolTrainingClass[];
  startingPriceFen: number | null;
  tags: string[];
  openHours: string;
  regulatory: DrivingSchoolRegulatory;
  publishedAt?: string | null;
  updatedAt?: string | null;
  offerUpdatedAt?: string | null;
};

export type DrivingSchoolDetail = DrivingSchoolListItem & {
  description?: string | null;
  images: DrivingSchoolImage[];
  offers: DrivingSchoolOffer[];
  facilities: string[];
  inquiryAvailable: boolean;
};

export type DrivingSchoolPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type DrivingSchoolListPage = {
  items: DrivingSchoolListItem[];
  pagination: DrivingSchoolPagination;
};

export type DrivingSchoolListQuery = {
  page?: number;
  pageSize?: number;
  district?: string;
  licenseClassCode?: string;
  trainingMode?: DrivingSchoolApplicationMode;
  priceType?: string;
  regulatoryType?: string;
  q?: string;
  sort?: DrivingSchoolSort;
};

export type DrivingSchoolInquiryDisclosure = {
  mode: string;
  acceptsRealData: boolean;
  version: string;
  school: { id: string; name: string };
  recipient: { name: string };
  dataScope: string[];
  purpose: string;
  retention: string;
  consentText: string;
  contactEtaText: string;
};

export type DrivingSchoolInquiryInput = {
  schoolId: string;
  licenseClassCode: string;
  offerId?: string;
  applicationMode: DrivingSchoolApplicationMode;
  contactName: string;
  contactPhone: string;
  contactWindow: DrivingSchoolContactWindow;
  message?: string;
  disclosureVersion: string;
  consentAccepted: true;
};

export type DrivingSchoolInquiryReceipt = {
  inquiryCode: string;
  school: { id: string; name: string };
  licenseClassCode: string;
  applicationMode: DrivingSchoolApplicationMode;
  maskedPhone: string;
  contactNameMasked: string;
  contactEtaText: string;
  withdrawToken: string;
  duplicate: boolean;
  status: string;
  submittedAt: string;
};

export type RecentContact = {
  name: string;
  phone: string;
};

interface IAppOption {
  globalData: { role: AppRole };
}
