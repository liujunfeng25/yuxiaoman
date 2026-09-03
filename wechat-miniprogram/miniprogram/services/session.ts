import { apiBaseUrl, assertApiConfigured, isReleaseBuild } from "../config/env";

// Namespace the credential by API audience so a development token is never
// sent to a later production origin (or vice versa) after an environment swap.
const OWNER_SESSION_STORAGE_KEY = `yuxiaoman.ownerSession:${apiBaseUrl || "unconfigured"}`;
const SESSION_EXPIRY_SKEW_MS = 60000;
const DEVELOPMENT_AUTH_RETRY_MS = 30000;

export type StoredOwnerSession = {
  token: string;
  expiresAt: string;
};

type SessionExchangePayload = {
  token?: unknown;
  expiresAt?: unknown;
  data?: unknown;
};

type SessionAwareError = Error & {
  code?: string;
  statusCode?: number;
};

export type OwnerSessionRuntime = {
  now(): number;
  strictAuthentication(): boolean;
  readStoredSession(): unknown;
  writeStoredSession(session: StoredOwnerSession): void;
  clearStoredSession(): void;
  login(): Promise<string>;
  exchange(code: string): Promise<unknown>;
};

export type OwnerSessionManager = {
  ensureSession(options?: { forceRefresh?: boolean }): Promise<string | null>;
  invalidateSession(): void;
  withAuthorization<T>(
    headers: Record<string, string>,
    operation: (authorizedHeaders: Record<string, string>) => Promise<T>,
  ): Promise<T>;
};

function sessionError(message: string, statusCode?: number, code?: string): SessionAwareError {
  const error = new Error(message) as SessionAwareError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizedSession(value: unknown, now: number): StoredOwnerSession | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as SessionExchangePayload;
  const candidate = outer.data && typeof outer.data === "object"
    ? outer.data as SessionExchangePayload
    : outer;
  const token = typeof candidate.token === "string" ? candidate.token.trim() : "";
  const expiresAt = typeof candidate.expiresAt === "string" ? candidate.expiresAt : "";
  const expiryTime = Date.parse(expiresAt);
  if (!token || !Number.isFinite(expiryTime) || expiryTime <= now + SESSION_EXPIRY_SKEW_MS) return null;
  return { token, expiresAt };
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as SessionAwareError).statusCode === 401);
}

function authorizedHeaders(headers: Record<string, string>, token: string | null): Record<string, string> {
  const sanitized: Record<string, string> = {};
  Object.entries(headers).forEach(([name, value]) => {
    if (name.toLowerCase() !== "authorization") sanitized[name] = value;
  });
  if (!token) return sanitized;
  return { ...sanitized, Authorization: `Bearer ${token}` };
}

/**
 * Dependency-injected factory used by the runtime singleton and focused unit
 * tests. Only the opaque application token and its expiry are persisted.
 */
export function createOwnerSessionManager(runtime: OwnerSessionRuntime): OwnerSessionManager {
  let sessionPromise: Promise<string | null> | null = null;
  let developmentFallbackUntil = 0;
  let ownerCredentialObserved = false;

  function invalidateSession(): void {
    runtime.clearStoredSession();
  }

  async function createSession(): Promise<string | null> {
    try {
      const code = (await runtime.login()).trim();
      if (!code) throw sessionError("微信登录未返回有效凭证", 401, "WECHAT_LOGIN_CODE_MISSING");
      const session = normalizedSession(await runtime.exchange(code), runtime.now());
      if (!session) throw sessionError("登录服务返回的会话无效", 502, "OWNER_SESSION_INVALID");
      developmentFallbackUntil = 0;
      ownerCredentialObserved = true;
      runtime.writeStoredSession(session);
      return session.token;
    } catch (error) {
      invalidateSession();
      if (runtime.strictAuthentication() || ownerCredentialObserved) {
        if (error instanceof Error) throw error;
        throw sessionError("微信登录暂时不可用", 503, "OWNER_SESSION_UNAVAILABLE");
      }
      // Development/demo access remains a server decision. Returning null only
      // omits Authorization; a server without its explicit fallback still 401s.
      developmentFallbackUntil = runtime.now() + DEVELOPMENT_AUTH_RETRY_MS;
      return null;
    }
  }

  function ensureSession(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    if (options.forceRefresh) invalidateSession();
    if (!options.forceRefresh) {
      const storedValue = runtime.readStoredSession();
      if (storedValue && typeof storedValue === "object"
        && typeof (storedValue as { token?: unknown }).token === "string"
        && Boolean((storedValue as { token: string }).token.trim())) {
        ownerCredentialObserved = true;
      }
      const stored = normalizedSession(storedValue, runtime.now());
      if (stored) return Promise.resolve(stored.token);
      invalidateSession();
      if (!runtime.strictAuthentication() && developmentFallbackUntil > runtime.now()) {
        return Promise.resolve(null);
      }
    }
    if (sessionPromise) return sessionPromise;
    sessionPromise = createSession().finally(() => {
      sessionPromise = null;
    });
    return sessionPromise;
  }

  async function withAuthorization<T>(
    headers: Record<string, string>,
    operation: (requestHeaders: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const firstToken = await ensureSession();
    try {
      return await operation(authorizedHeaders(headers, firstToken));
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
    }

    const current = normalizedSession(runtime.readStoredSession(), runtime.now());
    const refreshedToken = current && current.token !== firstToken
      ? current.token
      : await ensureSession({ forceRefresh: true });
    if (firstToken && !refreshedToken) {
      // Never replay a request that was originally authenticated as a real
      // owner without credentials. In development, an anonymous replay could
      // otherwise be accepted by the explicit demo fallback as demo-user.
      throw sessionError("用户会话已失效，重新登录失败", 401, "OWNER_SESSION_REFRESH_FAILED");
    }
    return operation(authorizedHeaders(headers, refreshedToken));
  }

  return { ensureSession, invalidateSession, withAuthorization };
}

function loginWithWechat(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 10000,
      success: (result) => result.code ? resolve(result.code) : reject(sessionError("微信登录未返回有效凭证")),
      fail: (error) => reject(sessionError(error.errMsg || "无法获取微信登录凭证")),
    });
  });
}

function exchangeWechatCode(code: string): Promise<unknown> {
  assertApiConfigured();
  return new Promise((resolve, reject) => {
    wx.request<unknown>({
      url: `${apiBaseUrl}/auth/wechat/session`,
      method: "POST",
      data: { code },
      header: { "content-type": "application/json" },
      timeout: 10000,
      success: (result) => {
        if (result.statusCode >= 200 && result.statusCode < 300) {
          resolve(result.data);
          return;
        }
        const payload = result.data && typeof result.data === "object"
          ? result.data as { code?: string; message?: string; error?: { code?: string; message?: string } }
          : undefined;
        reject(sessionError(
          payload?.error?.message || payload?.message || "微信登录暂时不可用",
          result.statusCode,
          payload?.error?.code || payload?.code,
        ));
      },
      fail: (error) => reject(sessionError(error.errMsg || "无法连接登录服务")),
    });
  });
}

const ownerSessionManager = createOwnerSessionManager({
  now: () => Date.now(),
  strictAuthentication: () => isReleaseBuild(),
  readStoredSession: () => wx.getStorageSync<unknown>(OWNER_SESSION_STORAGE_KEY),
  writeStoredSession: (session) => wx.setStorageSync(OWNER_SESSION_STORAGE_KEY, session),
  clearStoredSession: () => wx.removeStorageSync(OWNER_SESSION_STORAGE_KEY),
  login: loginWithWechat,
  exchange: exchangeWechatCode,
});

export const ensureSession = ownerSessionManager.ensureSession;
export const invalidateSession = ownerSessionManager.invalidateSession;
export const withOwnerAuthorization = ownerSessionManager.withAuthorization;
