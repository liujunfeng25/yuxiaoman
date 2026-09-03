import { api } from "./adminApi";

export const customerAdminTags = ["重点客户", "待跟进", "复购客户", "资料待补"] as const;

export type CustomerDataKind = "real" | "demo" | "unknown";
export type CustomerSummary = { real: number; demo: number; unknown: number; wechatBound: number; withBusinessRecords: number };
export type CustomerIdentitySummary = { bound: boolean; provider?: string | null; maskedSubject?: string | null };

export type CustomerListItem = {
  id: string;
  customerNumber: string;
  displayName: string;
  avatarUrl?: string | null;
  status: string;
  dataKind: CustomerDataKind;
  identity: CustomerIdentitySummary;
  tags: string[];
  vehicleCount: number;
  recordCount: number;
  pendingCount: number;
  lastActiveAt?: string | null;
  createdAt?: string | null;
};

export type CustomerListResponse = { items: CustomerListItem[]; summary: CustomerSummary; nextCursor?: string | null };
export type CustomerIdentity = { id: string; provider: string; providerAppId?: string | null; maskedProviderSubject?: string | null; maskedUnionSubject?: string | null; boundAt?: string | null };
export type RevealedIdentity = { id: string; provider: string; providerAppId?: string | null; providerSubject?: string | null; unionSubject?: string | null };
export type CustomerNote = { id: string; content: string; author?: { id?: string; displayName?: string } | null; createdAt?: string | null };
export type CustomerVehicle = {
  id: string;
  plateNumber: string;
  brandName?: string | null;
  modelName?: string | null;
  vehicleType?: string | null;
  seats?: number | null;
  isDefault?: boolean;
  isDeleted?: boolean;
  inspectionValidUntil?: string | null;
  nextInspectionDate?: string | null;
  lastServiceAt?: string | null;
  updatedAt?: string | null;
};
export type CustomerBusinessRecord = { domain: string; recordType: string; sourceId: string; businessCode: string; vehicleId?: string | null; status: string; amountFen?: number | null; occurredAt?: string | null; detailPath?: string | null; title?: string | null };
export type CustomerMaterial = {
  id: string;
  domain: string;
  businessId?: string | null;
  businessCode?: string | null;
  kind: string;
  label?: string | null;
  state: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  deleteAfter?: string | null;
  available: boolean;
  contentPath?: string | null;
  purpose?: string | null;
  authorizationVersion?: string | null;
  consentVersion?: string | null;
  retention?: string | null;
};
export type CustomerActivity = { id: string; type?: string | null; label: string; description?: string | null; occurredAt?: string | null; actorName?: string | null; domain?: string | null; resourceId?: string | null; outcome?: string | null };
export type CustomerDetail = {
  customer: CustomerListItem & { updatedAt?: string | null };
  identities: CustomerIdentity[];
  tags: string[];
  notes: CustomerNote[];
  stats: { vehicles: number; records: number; pending: number };
  vehicles: CustomerVehicle[];
  recentRecords: CustomerBusinessRecord[];
  recentActivity: CustomerActivity[];
};
export type CursorPage<T> = { items: T[]; nextCursor?: string | null };

export type CustomerListFilters = {
  q?: string;
  status?: string;
  dataKind?: string;
  serviceType?: string;
  activeWithinDays?: "7" | "30" | "90" | "";
  tag?: string;
  cursor?: string | null;
  limit?: number;
};

function queryString(values: Record<string, string | number | null | undefined>) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  });
  return query.toString();
}

function customerPath(customerId: string) {
  return `/admin/customers/${encodeURIComponent(customerId)}`;
}

export const customerAdminApi = {
  list(filters: CustomerListFilters = {}) {
    return api<CustomerListResponse>(`/admin/customers?${queryString({ ...filters, limit: filters.limit ?? 20 })}`);
  },
  get(customerId: string) {
    return api<CustomerDetail>(customerPath(customerId));
  },
  records(customerId: string, filters: { domain?: string; cursor?: string | null; limit?: number } = {}) {
    return api<CursorPage<CustomerBusinessRecord>>(`${customerPath(customerId)}/records?${queryString({ ...filters, limit: filters.limit ?? 20 })}`);
  },
  materials(customerId: string, filters: { domain?: string; state?: string; cursor?: string | null; limit?: number } = {}) {
    return api<CursorPage<CustomerMaterial>>(`${customerPath(customerId)}/materials?${queryString({ ...filters, limit: filters.limit ?? 20 })}`);
  },
  addNote(customerId: string, content: string) {
    return api<{ note: CustomerNote }>(`${customerPath(customerId)}/notes`, { method: "POST", body: JSON.stringify({ content }) });
  },
  replaceTags(customerId: string, tags: string[]) {
    return api<{ tags: string[] }>(`${customerPath(customerId)}/tags`, { method: "PUT", body: JSON.stringify({ tags }) });
  },
  revealIdentity(customerId: string, identityId: string) {
    return api<{ identity: RevealedIdentity }>(`${customerPath(customerId)}/identities/${encodeURIComponent(identityId)}/reveal`, { method: "POST" });
  },
  materialContentUrl(customerId: string, domain: string, materialId: string) {
    return `/api${customerPath(customerId)}/materials/${encodeURIComponent(domain)}/${encodeURIComponent(materialId)}/content`;
  },
};
