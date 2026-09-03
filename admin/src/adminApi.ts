export type AdminApiError = Error & { status?: number; code?: string };

export type AdminListPayload<T> = { items: T[]; total: number; page?: number; pageSize?: number };
export type DrivingSchoolDataKind = "demo" | "real";
export type DrivingSchoolApplicationMode = "initial" | "upgrade";
export type DrivingSchoolPriceType = "fixed" | "starting_from" | "range" | "inquiry";
export type DrivingSchoolInquiryStatus = "new" | "contacting" | "resolved" | "closed" | "withdrawn";
export type DrivingSchoolRegulatoryType = "filing" | "legacy_license";
export type DrivingSchoolRegulatoryStatus = "pending" | "verified" | "rejected" | "expired" | "demo";

export type AdminLocationSuggestion = {
  poiId: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  source: "tencent" | "wechat" | "demo";
  locationProof?: string;
};

export type DrivingSchoolRegulatory = {
  type: DrivingSchoolRegulatoryType;
  number: string;
  authority: string;
  sourceUrl?: string | null;
  sourceLabel: string;
  validFrom?: string | null;
  validUntil?: string | null;
  verifiedAt?: string | null;
  status: DrivingSchoolRegulatoryStatus;
  capabilityLevel?: 1 | 2 | 3 | "level_1" | "level_2" | "level_3" | null;
};

export type DrivingSchoolImage = {
  id: string;
  url: string;
  caption: string;
  altText?: string;
  isCover: boolean;
  sortOrder: number;
  updatedAt?: string;
};

export type DrivingSchoolTrainingClass = {
  licenseClassCode: string;
  name?: string;
  vehicleScope?: string;
  supportedModes: DrivingSchoolApplicationMode[];
  applicationModes?: DrivingSchoolApplicationMode[];
  /** @deprecated Legacy compatibility only. The admin no longer edits or displays this field. */
  trainingCapabilityLevel?: string | null;
  trainingCapabilityNote?: string | null;
  catalogConditions?: string[];
  schoolConditions?: string[];
  conditions: string[];
  status: "active" | "inactive";
  updatedAt?: string;
};

export type DrivingSchoolPreviewChecklistItem = {
  key: string;
  label: string;
  status: "pass" | "fail" | "warning";
  section: "base" | "training" | "offers" | "media" | "preview" | string;
  message: string;
};

export type DrivingSchoolOfferMapping = {
  offerId: string;
  listMinimumCandidate: boolean;
  detailVisible: boolean;
  inquirySelectable: boolean;
  reasons: string[];
};

export type DrivingSchoolPublicPreview = {
  savedAt: string;
  revision: string;
  summary: DrivingSchool;
  detail: DrivingSchool;
  visibility: {
    listVisible: boolean;
    detailVisible: boolean;
    inquiryAvailable: boolean;
    reasons: string[];
  };
  checklist: DrivingSchoolPreviewChecklistItem[];
  offerMappings: DrivingSchoolOfferMapping[];
  testPaths: { list: string; detail: string; inquiry: string };
};

export type DrivingSchoolOffer = {
  id: string;
  schoolId?: string;
  schoolName?: string;
  licenseClassCode: string;
  name: string;
  priceType: DrivingSchoolPriceType;
  minPriceFen: number | null;
  maxPriceFen: number | null;
  applicationModes: DrivingSchoolApplicationMode[];
  unit: string;
  includedItems: string[];
  excludedItems: string[];
  description?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  status: "active" | "inactive";
  isExpired?: boolean;
  sortOrder?: number;
  updatedAt?: string;
};

export type DrivingSchoolInquiryRecipient = {
  recipientName: "驭小满驾校服务团队";
  dataScope: string[];
  purpose: string;
  retention: string;
  consentText: string;
  contactEtaText: string;
  version?: string;
  active: boolean;
  synthetic: boolean;
};

export type DrivingSchool = {
  id: string;
  name: string;
  legalName?: string | null;
  description?: string;
  dataKind: DrivingSchoolDataKind;
  isDemo?: boolean;
  district: string;
  address: string;
  location: AdminLocationSuggestion;
  publicPhone?: string | null;
  internalContact?: { name?: string | null; phone?: string | null } | null;
  coverImage?: DrivingSchoolImage | null;
  trainingClasses: DrivingSchoolTrainingClass[];
  startingPriceFen?: number | null;
  tags: string[];
  facilities?: string[];
  openHours: string;
  regulatory: DrivingSchoolRegulatory;
  isActive?: boolean;
  isPublished?: boolean;
  publicationStatus?: string;
  publishedAt?: string | null;
  updatedAt?: string;
  offerUpdatedAt?: string | null;
  images?: DrivingSchoolImage[];
  offers?: DrivingSchoolOffer[];
  inquiryAvailable?: boolean;
  inquiryRecipient?: DrivingSchoolInquiryRecipient | null;
  sortPriority?: number;
};

export type DrivingSchoolMutation = Omit<DrivingSchool,
  "id" | "district" | "address" | "location" | "isDemo" | "coverImage" | "trainingClasses" |
  "startingPriceFen" | "publishedAt" | "updatedAt" | "offerUpdatedAt" | "images" | "offers" |
  "publicationStatus" | "isPublished" | "inquiryAvailable" | "inquiryRecipient"
> & {
  location?: AdminLocationSuggestion;
  weeklySchedule?: Record<string, unknown>;
  inquiryRecipient?: Omit<DrivingSchoolInquiryRecipient, "version">;
};

export type DrivingSchoolInquiry = {
  id: string;
  inquiryCode: string;
  school: { id: string; name: string };
  licenseClassCode: string;
  offerId?: string | null;
  offerName?: string | null;
  applicationMode: DrivingSchoolApplicationMode;
  status: DrivingSchoolInquiryStatus;
  contactNameMasked: string;
  maskedPhone: string;
  contactWindow?: string;
  internalNote?: string | null;
  source?: string;
  isSynthetic?: boolean;
  submittedAt: string;
  updatedAt?: string;
  contactingAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  withdrawnAt?: string | null;
};

export type DrivingSchoolInquiryDetail = DrivingSchoolInquiry & {
  contact?: { name?: string | null; phone?: string | null; message?: string | null } | null;
  disclosure?: Record<string, unknown> | null;
  events?: Array<Record<string, unknown>>;
};

export async function apiEnvelope<T, M = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ data: T; meta?: M }> {
  const headers = new Headers(init?.headers);
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (init?.body && !isFormData && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const errorCode = payload?.error?.code as string | undefined;
    const credentialsWereRejected = errorCode === "BACKOFFICE_INVALID_CREDENTIALS"
      || path === "/backoffice/sessions"
      || path === "/backoffice/password"
      || path === "/backoffice/activations";
    if (response.status === 401 && !credentialsWereRejected && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("yuxiaoman:backoffice-unauthorized", { detail: { path } }));
    }
    const error = new Error(payload?.error?.message || payload?.message || "操作失败，请稍后重试") as AdminApiError;
    error.status = response.status;
    error.code = errorCode;
    throw error;
  }
  return { data: payload?.data as T, meta: payload?.meta as M | undefined };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiEnvelope<T>(path, init)).data;
}

function authenticatedMediaUrl(path: string): string {
  if (typeof window === "undefined") throw new Error("后台图片只能在浏览器中读取");
  const url = new URL(path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("后台图片地址无效");
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Read protected media with the same HttpOnly backoffice session as JSON API calls.
 * Callers must render the returned Blob through an object URL; never fall back to the
 * protected endpoint as a naked <img src>, because that bypasses this authenticated path.
 */
export async function apiBlob(path: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(authenticatedMediaUrl(path), {
    ...init,
    credentials: "include",
    headers: new Headers(init?.headers),
  });
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => null);
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("yuxiaoman:backoffice-unauthorized", { detail: { path } }));
    }
    const error = new Error(payload?.error?.message || payload?.message || "图片读取失败，请稍后重试") as AdminApiError;
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("图片响应格式无效");
  return blob;
}

export function upload<T>(path: string, formData: FormData, init?: Omit<RequestInit, "body">): Promise<T> {
  return api<T>(path, {
    ...init,
    method: init?.method ?? "POST",
    body: formData,
  });
}

export function money(fen = 0) {
  return (fen / 100).toFixed(2);
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

async function normalizedList<T>(path: string, init?: RequestInit): Promise<AdminListPayload<T>> {
  type WrappedList = Partial<AdminListPayload<T>> & { pagination?: { page?: number; pageSize?: number; total?: number } };
  const response = await api<T[] | WrappedList>(path, init);
  if (Array.isArray(response)) return { items: response, total: response.length };
  const items = Array.isArray(response?.items) ? response.items : [];
  const pagination = response?.pagination;
  return {
    items,
    total: typeof pagination?.total === "number" ? pagination.total : typeof response?.total === "number" ? response.total : items.length,
    page: pagination?.page ?? response?.page,
    pageSize: pagination?.pageSize ?? response?.pageSize,
  };
}

export const drivingSchoolAdminApi = {
  listSchools(filters: { q?: string; dataKind?: string; status?: string; page?: number; pageSize?: number } = {}, init?: RequestInit) {
    return normalizedList<DrivingSchool>(`/admin/driving-schools${queryString(filters)}`, init);
  },
  getSchool(id: string, init?: RequestInit) {
    return api<DrivingSchool>(`/admin/driving-schools/${encodeURIComponent(id)}`, init);
  },
  getSchoolPreview(id: string, init?: RequestInit) {
    return api<DrivingSchoolPublicPreview>(`/admin/driving-schools/${encodeURIComponent(id)}/preview`, init);
  },
  createSchool(input: DrivingSchoolMutation) {
    return api<DrivingSchool>("/admin/driving-schools", { method: "POST", body: JSON.stringify(input) });
  },
  updateSchool(id: string, input: Partial<DrivingSchoolMutation>) {
    return api<DrivingSchool>(`/admin/driving-schools/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteSchool(id: string) {
    return api<{ deleted: boolean }>(`/admin/driving-schools/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  publishSchool(id: string) {
    return api<DrivingSchool>(`/admin/driving-schools/${encodeURIComponent(id)}/publish`, { method: "POST" });
  },
  unpublishSchool(id: string) {
    return api<DrivingSchool>(`/admin/driving-schools/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
  },
  listImages(schoolId: string, init?: RequestInit) {
    return normalizedList<DrivingSchoolImage>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/images`, init);
  },
  createImage(schoolId: string, input: Omit<DrivingSchoolImage, "id" | "updatedAt" | "altText">) {
    return api<DrivingSchoolImage>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/images`, { method: "POST", body: JSON.stringify(input) });
  },
  updateImage(schoolId: string, imageId: string, input: Partial<Omit<DrivingSchoolImage, "id" | "updatedAt" | "altText">>) {
    return api<DrivingSchoolImage>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/images/${encodeURIComponent(imageId)}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteImage(schoolId: string, imageId: string) {
    return api<{ deleted: boolean }>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
  },
  listTrainingClasses(schoolId: string, init?: RequestInit) {
    return normalizedList<DrivingSchoolTrainingClass>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/training-classes`, init);
  },
  createTrainingClass(schoolId: string, input: { licenseClassCode: string; applicationModes: DrivingSchoolApplicationMode[]; trainingCapabilityNote?: string | null; schoolConditions?: string[]; conditions?: string[]; status: "active" | "inactive" }) {
    return api<DrivingSchoolTrainingClass>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/training-classes`, { method: "POST", body: JSON.stringify(input) });
  },
  updateTrainingClass(schoolId: string, code: string, input: Partial<{ applicationModes: DrivingSchoolApplicationMode[]; trainingCapabilityNote: string | null; schoolConditions: string[]; conditions: string[]; status: "active" | "inactive" }>) {
    return api<DrivingSchoolTrainingClass>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/training-classes/${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteTrainingClass(schoolId: string, code: string) {
    return api<{ deleted: boolean }>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/training-classes/${encodeURIComponent(code)}`, { method: "DELETE" });
  },
  listOffers(schoolId: string, init?: RequestInit) {
    return normalizedList<DrivingSchoolOffer>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/offers`, init);
  },
  createOffer(schoolId: string, input: Omit<DrivingSchoolOffer, "id" | "schoolId" | "schoolName" | "updatedAt" | "isExpired">) {
    return api<DrivingSchoolOffer>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/offers`, { method: "POST", body: JSON.stringify(input) });
  },
  updateOffer(schoolId: string, offerId: string, input: Partial<Omit<DrivingSchoolOffer, "id" | "schoolId" | "schoolName" | "updatedAt" | "isExpired">>) {
    return api<DrivingSchoolOffer>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/offers/${encodeURIComponent(offerId)}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  deleteOffer(schoolId: string, offerId: string) {
    return api<{ deleted: boolean }>(`/admin/driving-schools/${encodeURIComponent(schoolId)}/offers/${encodeURIComponent(offerId)}`, { method: "DELETE" });
  },
  listInquiries(filters: { page?: number; pageSize?: number; status?: string; schoolId?: string; licenseClassCode?: string; dateFrom?: string; dateTo?: string }, init?: RequestInit) {
    return normalizedList<DrivingSchoolInquiry>(`/admin/driving-school-inquiries${queryString(filters)}`, init);
  },
  getInquiry(id: string, init?: RequestInit) {
    return api<DrivingSchoolInquiryDetail>(`/admin/driving-school-inquiries/${encodeURIComponent(id)}`, init);
  },
  updateInquiry(id: string, input: { status?: Exclude<DrivingSchoolInquiryStatus, "withdrawn">; internalNote?: string | null }) {
    return api<DrivingSchoolInquiry>(`/admin/driving-school-inquiries/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  locationSuggestions(query: string, init?: RequestInit) {
    return normalizedList<AdminLocationSuggestion>(`/locations/suggestions${queryString({ query })}`, init);
  },
};
