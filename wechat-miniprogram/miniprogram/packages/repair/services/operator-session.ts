import { apiBaseUrl, assertApiConfigured } from "../../../config/env";

declare function getCurrentPages(): Array<{ route?: string; options?: Record<string, string> }>;

const REPAIR_OPERATOR_SESSION_STORAGE_KEY = `yuxiaoman.repairOperatorSession:${apiBaseUrl || "unconfigured"}`;
const SESSION_EXPIRY_SKEW_MS = 60000;
const BACKOFFICE_TOKEN_PREFIX = "yxm_bo_";
const DEMO_REPAIR_SHOP_IDS = new Set([
  "shop-jincheng-bodypaint",
  "shop-haihe-auto",
  "shop-landun-repair",
]);
let loginRedirectInFlight = false;

export type RepairOperatorAccount = {
  id: string;
  loginName: string;
  displayName: string;
  role: "repair_shop_admin";
};

export type RepairOperatorSubject = {
  type: "repair_shop";
  id: string;
  name: string;
};

export type StoredRepairOperatorSession = {
  token: string;
  expiresAt: string;
  account: RepairOperatorAccount;
  subject: RepairOperatorSubject;
  capabilities: string[];
};

type RepairOperatorSessionError = Error & { code?: string; statusCode?: number };
type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

export type RepairOperatorSessionRuntime = {
  now(): number;
  read(): unknown;
  write(session: StoredRepairOperatorSession): void;
  clear(): void;
};

function sessionError(message: string, statusCode?: number, code?: string): RepairOperatorSessionError {
  const error = new Error(message) as RepairOperatorSessionError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isDemoRepairOperatorSubject(subject: RepairOperatorSubject | null | undefined): boolean {
  return Boolean(subject && DEMO_REPAIR_SHOP_IDS.has(subject.id));
}

export function normalizeRepairOperatorSession(value: unknown, now = Date.now()): StoredRepairOperatorSession | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as { data?: unknown };
  const source = outer.data && typeof outer.data === "object"
    ? outer.data as Record<string, unknown>
    : value as Record<string, unknown>;
  const token = stringValue(source.token);
  const expiresAt = stringValue(source.expiresAt);
  const expiry = Date.parse(expiresAt);
  const accountSource = source.account && typeof source.account === "object"
    ? source.account as Record<string, unknown>
    : null;
  const subjectSource = source.subject && typeof source.subject === "object"
    ? source.subject as Record<string, unknown>
    : null;
  if (!token.startsWith(BACKOFFICE_TOKEN_PREFIX) || !Number.isFinite(expiry) || expiry <= now + SESSION_EXPIRY_SKEW_MS) return null;
  if (!accountSource || stringValue(accountSource.role) !== "repair_shop_admin") return null;
  if (!subjectSource || stringValue(subjectSource.type) !== "repair_shop") return null;

  const account: RepairOperatorAccount = {
    id: stringValue(accountSource.id),
    loginName: stringValue(accountSource.loginName),
    displayName: stringValue(accountSource.displayName) || stringValue(accountSource.loginName),
    role: "repair_shop_admin",
  };
  const subject: RepairOperatorSubject = {
    type: "repair_shop",
    id: stringValue(subjectSource.id),
    name: stringValue(subjectSource.name) || stringValue(subjectSource.id),
  };
  if (!account.id || !account.loginName || !subject.id) return null;
  return {
    token,
    expiresAt,
    account,
    subject,
    capabilities: Array.isArray(source.capabilities) ? source.capabilities.map(stringValue).filter(Boolean) : [],
  };
}

export function createRepairOperatorSessionStore(runtime: RepairOperatorSessionRuntime) {
  function clear(): void { runtime.clear(); }

  function read(): StoredRepairOperatorSession | null {
    const normalized = normalizeRepairOperatorSession(runtime.read(), runtime.now());
    if (!normalized) clear();
    return normalized;
  }

  function store(value: unknown): StoredRepairOperatorSession {
    const normalized = normalizeRepairOperatorSession(value, runtime.now());
    if (!normalized) throw sessionError("维修门店登录服务返回的会话无效", 502, "REPAIR_OPERATOR_SESSION_INVALID");
    runtime.write(normalized);
    return normalized;
  }

  function headers(base: Record<string, string> = {}): Record<string, string> {
    const sanitized: Record<string, string> = {};
    Object.entries(base).forEach(([name, value]) => {
      if (name.toLowerCase() !== "authorization") sanitized[name] = value;
    });
    const session = read();
    if (!session) throw sessionError("请先登录维修门店账号", 401, "REPAIR_OPERATOR_SESSION_REQUIRED");
    return { ...sanitized, Authorization: `Bearer ${session.token}` };
  }

  async function withAuthorization<T>(
    base: Record<string, string>,
    operation: (authorizedHeaders: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    let authorizedHeaders: Record<string, string>;
    try { authorizedHeaders = headers(base); } catch (error) { return Promise.reject(error); }
    try {
      return await operation(authorizedHeaders);
    } catch (error) {
      if (isRepairOperatorSessionAccessError(error)) clear();
      throw error;
    }
  }

  return { clear, read, store, headers, withAuthorization };
}

const store = createRepairOperatorSessionStore({
  now: () => Date.now(),
  read: () => wx.getStorageSync<unknown>(REPAIR_OPERATOR_SESSION_STORAGE_KEY),
  write: (session) => wx.setStorageSync(REPAIR_OPERATOR_SESSION_STORAGE_KEY, session),
  clear: () => wx.removeStorageSync(REPAIR_OPERATOR_SESSION_STORAGE_KEY),
});

function sessionRequest<T>(
  path: string,
  method: "GET" | "POST" | "DELETE",
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  assertApiConfigured();
  return new Promise((resolve, reject) => {
    wx.request<Envelope<T>>({
      url: `${apiBaseUrl}${path}`,
      method,
      data,
      header: { "content-type": "application/json", ...headers },
      timeout: 10000,
      success: (result) => {
        if (result.statusCode >= 200 && result.statusCode < 300 && (result.statusCode === 204 || result.data?.data !== undefined)) {
          resolve(result.data?.data as T);
          return;
        }
        reject(sessionError(
          result.data?.error?.message || "维修门店登录服务暂时不可用",
          result.statusCode,
          result.data?.error?.code,
        ));
      },
      fail: (error) => reject(sessionError(error.errMsg || "无法连接维修门店登录服务")),
    });
  });
}

export function readRepairOperatorSession(): StoredRepairOperatorSession | null { return store.read(); }
export function clearRepairOperatorSession(): void { store.clear(); }
export function repairOperatorAuthorizationHeaders(headers: Record<string, string> = {}): Record<string, string> { return store.headers(headers); }
export function repairOperatorLoginRequired(): boolean { return !store.read(); }

export function isRepairOperatorSessionAccessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as RepairOperatorSessionError).statusCode === 401);
}

export async function loginRepairOperator(loginName: string, password: string): Promise<StoredRepairOperatorSession> {
  const payload = await sessionRequest<unknown>("/repair-operator/sessions", "POST", { loginName: loginName.trim(), password });
  const session = store.store(payload);
  loginRedirectInFlight = false;
  return session;
}

export async function refreshRepairOperatorSession(): Promise<StoredRepairOperatorSession> {
  let headers: Record<string, string>;
  try { headers = store.headers(); } catch (error) { return Promise.reject(error); }
  try {
    const payload = await sessionRequest<unknown>("/repair-operator/session", "GET", undefined, headers);
    const current = store.read();
    return store.store({
      ...(payload && typeof payload === "object" ? payload : {}),
      token: current?.token,
      expiresAt: current?.expiresAt,
    });
  } catch (error) {
    if (isRepairOperatorSessionAccessError(error)) store.clear();
    throw error;
  }
}

export async function logoutRepairOperator(): Promise<void> {
  let headers: Record<string, string> = {};
  try { headers = store.headers(); } catch { store.clear(); return; }
  try { await sessionRequest<unknown>("/repair-operator/session", "DELETE", undefined, headers); }
  finally { store.clear(); }
}

export async function withRepairOperatorAuthorization<T>(
  headers: Record<string, string>,
  operation: (authorizedHeaders: Record<string, string>) => Promise<T>,
): Promise<T> {
  try {
    return await store.withAuthorization(headers, operation);
  } catch (error) {
    if (isRepairOperatorSessionAccessError(error)) redirectRepairOperatorLogin();
    throw error;
  }
}

export function ensureRepairOperatorPageAccess(returnUrl: string): boolean {
  if (!repairOperatorLoginRequired()) return true;
  redirectRepairOperatorLogin(returnUrl);
  return false;
}

function currentRepairOperatorPageUrl(): string {
  if (typeof getCurrentPages !== "function") return "/packages/repair/pages/shop-hall/shop-hall";
  const pages = getCurrentPages();
  const current = pages[pages.length - 1];
  const route = String(current?.route || "");
  if (!route || route.includes("/shop-login/")) return "/packages/repair/pages/shop-hall/shop-hall";
  const query = Object.entries(current?.options || {})
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `/${route}${query ? `?${query}` : ""}`;
}

export function redirectRepairOperatorLogin(returnUrl = currentRepairOperatorPageUrl()): void {
  if (loginRedirectInFlight || typeof wx === "undefined") return;
  loginRedirectInFlight = true;
  try {
    wx.redirectTo({ url: `/packages/repair/pages/shop-login/shop-login?redirect=${encodeURIComponent(returnUrl)}` });
  } catch (error) {
    loginRedirectInFlight = false;
    throw error;
  }
}

export function markRepairOperatorLoginPageReady(): void { loginRedirectInFlight = false; }
