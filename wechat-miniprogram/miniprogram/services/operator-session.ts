import { apiBaseUrl, assertApiConfigured } from "../config/env";

declare function getCurrentPages(): Array<{ route?: string; options?: Record<string, string> }>;

const OPERATOR_SESSION_STORAGE_KEY = `yuxiaoman.operatorSession:${apiBaseUrl || "unconfigured"}`;
const SESSION_EXPIRY_SKEW_MS = 60000;
const OPERATOR_TOKEN_PREFIX = "yxm_bo_";
let loginRedirectInFlight = false;

export type OperatorAccount = {
  id: string;
  loginName: string;
  displayName: string;
  role: "inspection_station_admin";
};

export type OperatorSubject = {
  type: "inspection_station";
  id: string;
  name: string;
};

export type StoredOperatorSession = {
  token: string;
  expiresAt: string;
  account: OperatorAccount;
  subject: OperatorSubject | null;
  capabilities: string[];
};

type OperatorSessionError = Error & { code?: string; statusCode?: number };
type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

export type OperatorSessionRuntime = {
  now(): number;
  read(): unknown;
  write(session: StoredOperatorSession): void;
  clear(): void;
};

function operatorError(message: string, statusCode?: number, code?: string): OperatorSessionError {
  const error = new Error(message) as OperatorSessionError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeOperatorSession(value: unknown, now = Date.now()): StoredOperatorSession | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as { data?: unknown };
  const source = outer.data && typeof outer.data === "object" ? outer.data as Record<string, unknown> : value as Record<string, unknown>;
  const token = stringValue(source.token);
  const expiresAt = stringValue(source.expiresAt);
  const expiry = Date.parse(expiresAt);
  const accountSource = source.account && typeof source.account === "object" ? source.account as Record<string, unknown> : null;
  const subjectSource = source.subject && typeof source.subject === "object" ? source.subject as Record<string, unknown> : null;
  const accountRole = stringValue(accountSource?.role);
  if (!token.startsWith(OPERATOR_TOKEN_PREFIX) || !Number.isFinite(expiry) || expiry <= now + SESSION_EXPIRY_SKEW_MS) return null;
  if (!accountSource || accountRole !== "inspection_station_admin") return null;
  const account: OperatorAccount = {
    id: stringValue(accountSource.id),
    loginName: stringValue(accountSource.loginName),
    displayName: stringValue(accountSource.displayName) || stringValue(accountSource.loginName),
    role: accountRole as OperatorAccount["role"],
  };
  if (!account.id || !account.loginName) return null;
  let subject: OperatorSubject | null = null;
  if (subjectSource) {
    if (stringValue(subjectSource.type) !== "inspection_station") return null;
    subject = {
      type: "inspection_station",
      id: stringValue(subjectSource.id),
      name: stringValue(subjectSource.name) || stringValue(subjectSource.id),
    };
    if (!subject.id) return null;
  }
  if (!subject) return null;
  return {
    token,
    expiresAt,
    account,
    subject,
    capabilities: Array.isArray(source.capabilities) ? source.capabilities.map(stringValue).filter(Boolean) : [],
  };
}

export function createOperatorSessionStore(runtime: OperatorSessionRuntime) {
  function clear(): void { runtime.clear(); }

  function read(): StoredOperatorSession | null {
    const normalized = normalizeOperatorSession(runtime.read(), runtime.now());
    if (!normalized) clear();
    return normalized;
  }

  function store(value: unknown): StoredOperatorSession {
    const normalized = normalizeOperatorSession(value, runtime.now());
    if (!normalized) throw operatorError("检测站登录服务返回的会话无效", 502, "OPERATOR_SESSION_INVALID");
    runtime.write(normalized);
    return normalized;
  }

  function headers(base: Record<string, string> = {}): Record<string, string> {
    const sanitized: Record<string, string> = {};
    Object.entries(base).forEach(([name, value]) => {
      if (name.toLowerCase() !== "authorization") sanitized[name] = value;
    });
    const session = read();
    if (session) return { ...sanitized, Authorization: `Bearer ${session.token}` };
    throw operatorError("请先登录检测站账号", 401, "OPERATOR_SESSION_REQUIRED");
  }

  async function withAuthorization<T>(
    base: Record<string, string>,
    operation: (authorizedHeaders: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    let authorized: Record<string, string>;
    try { authorized = headers(base); } catch (error) { return Promise.reject(error); }
    try {
      return await operation(authorized);
    } catch (error) {
      if (error && typeof error === "object" && (error as OperatorSessionError).statusCode === 401) clear();
      throw error;
    }
  }

  return { clear, read, store, headers, withAuthorization };
}

const store = createOperatorSessionStore({
  now: () => Date.now(),
  read: () => wx.getStorageSync<unknown>(OPERATOR_SESSION_STORAGE_KEY),
  write: (session) => wx.setStorageSync(OPERATOR_SESSION_STORAGE_KEY, session),
  clear: () => wx.removeStorageSync(OPERATOR_SESSION_STORAGE_KEY),
});

function sessionRequest<T>(path: string, method: "GET" | "POST" | "DELETE", data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  assertApiConfigured();
  return new Promise((resolve, reject) => {
    wx.request<Envelope<T>>({
      url: `${apiBaseUrl}${path}`,
      method,
      data,
      header: { "content-type": "application/json", ...headers },
      timeout: 10000,
      success: (result) => {
        if (result.statusCode >= 200 && result.statusCode < 300 && result.data?.data !== undefined) {
          resolve(result.data.data);
          return;
        }
        reject(operatorError(result.data?.error?.message || "检测站登录服务暂时不可用", result.statusCode, result.data?.error?.code));
      },
      fail: (error) => reject(operatorError(error.errMsg || "无法连接检测站登录服务")),
    });
  });
}

export function readOperatorSession(): StoredOperatorSession | null { return store.read(); }
export function clearOperatorSession(): void { store.clear(); }
export function operatorAuthorizationHeaders(headers: Record<string, string> = {}): Record<string, string> { return store.headers(headers); }
export function operatorLoginRequired(): boolean { return !store.read(); }

export async function loginOperator(loginName: string, password: string): Promise<StoredOperatorSession> {
  const payload = await sessionRequest<unknown>("/operator/sessions", "POST", { loginName: loginName.trim(), password });
  const session = store.store(payload);
  loginRedirectInFlight = false;
  return session;
}

export async function refreshOperatorSession(): Promise<StoredOperatorSession> {
  let headers: Record<string, string>;
  try { headers = store.headers(); } catch (error) { return Promise.reject(error); }
  try {
    const payload = await sessionRequest<unknown>("/operator/session", "GET", undefined, headers);
    const current = store.read();
    return store.store({ ...(payload && typeof payload === "object" ? payload : {}), token: current?.token, expiresAt: current?.expiresAt });
  } catch (error) {
    if (error && typeof error === "object" && (error as OperatorSessionError).statusCode === 401) store.clear();
    throw error;
  }
}

export async function logoutOperator(): Promise<void> {
  let headers: Record<string, string> = {};
  try { headers = store.headers(); } catch { store.clear(); return; }
  try { await sessionRequest<unknown>("/operator/session", "DELETE", undefined, headers); } finally { store.clear(); }
}

export async function withOperatorAuthorization<T>(
  headers: Record<string, string>,
  operation: (authorizedHeaders: Record<string, string>) => Promise<T>,
): Promise<T> {
  try {
    return await store.withAuthorization(headers, operation);
  } catch (error) {
    if (error && typeof error === "object" && (error as OperatorSessionError).statusCode === 401) redirectOperatorLogin();
    throw error;
  }
}

export function ensureOperatorPageAccess(returnUrl: string): boolean {
  if (!operatorLoginRequired()) return true;
  redirectOperatorLogin(returnUrl);
  return false;
}

function currentOperatorPageUrl(): string {
  if (typeof getCurrentPages !== "function") return "/packages/operator/pages/operator/operator";
  const pages = getCurrentPages();
  const current = pages[pages.length - 1] as unknown as { route?: string; options?: Record<string, string> } | undefined;
  const route = String(current?.route || "");
  if (!route || route.includes("/operator-login/")) return "/packages/operator/pages/operator/operator";
  const query = Object.entries(current?.options || {})
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `/${route}${query ? `?${query}` : ""}`;
}

export function redirectOperatorLogin(returnUrl = currentOperatorPageUrl()): void {
  if (loginRedirectInFlight || typeof wx === "undefined") return;
  loginRedirectInFlight = true;
  try {
    wx.redirectTo({ url: `/packages/operator/pages/operator-login/operator-login?redirect=${encodeURIComponent(returnUrl)}` });
  } catch (error) {
    loginRedirectInFlight = false;
    throw error;
  }
}

export function markOperatorLoginPageReady(): void { loginRedirectInFlight = false; }
