import { apiOrigin, assertApiConfigured } from "../config/env";
import { clearOperatorSession, withOperatorAuthorization } from "./operator-session";

type OperatorMediaError = Error & { statusCode?: number };

function mediaError(message: string, statusCode?: number): OperatorMediaError {
  const error = new Error(message) as OperatorMediaError;
  error.statusCode = statusCode;
  return error;
}

export function operatorMediaSourceUrl(path: string): string {
  const value = String(path || "").trim();
  if (!value) return "";
  const legacyLoopback = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/.*)?$/iu);
  if (legacyLoopback) return `${apiOrigin}${legacyLoopback[1] || ""}`;
  if (/^(https?:|wxfile:|data:|blob:|file:)/iu.test(value)) return value;
  if (value.startsWith("/assets/") || value.startsWith("/packages/") || value.startsWith("../") || value.startsWith("./")) return value;
  assertApiConfigured();
  return `${apiOrigin}${value.startsWith("/") ? value : `/${value}`}`;
}

export type OperatorMediaRuntime = {
  authorize<T>(operation: (headers: Record<string, string>) => Promise<T>): Promise<T>;
  download(url: string, headers: Record<string, string>): Promise<{ statusCode: number; tempFilePath: string }>;
  persist?(tempFilePath: string): Promise<string>;
  exists?(filePath: string): Promise<boolean>;
};

export function createOperatorMediaLocalizer(runtime: OperatorMediaRuntime) {
  const downloads = new Map<string, Promise<string>>();

  function invalidate(path?: string): void {
    if (path === undefined) { downloads.clear(); return; }
    downloads.delete(operatorMediaSourceUrl(path));
  }

  async function localize(path: string, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const source = operatorMediaSourceUrl(path);
    if (!source) throw mediaError("检测站照片地址无效");
    if (!/^https?:\/\//iu.test(source)) return source;
    if (options.forceRefresh) downloads.delete(source);
    const existing = downloads.get(source);
    if (existing) {
      try {
        const cachedPath = await existing;
        if (!runtime.exists || await runtime.exists(cachedPath)) return cachedPath;
      } catch {
        // Retry below using the station credential.
      }
      if (downloads.get(source) === existing) downloads.delete(source);
      return localize(source);
    }
    const pending = runtime.authorize(async (headers) => {
      const result = await runtime.download(source, headers);
      if (result.statusCode === 401) clearOperatorSession();
      if (result.statusCode < 200 || result.statusCode >= 300 || !result.tempFilePath) {
        throw mediaError("检测站照片安全读取失败", result.statusCode);
      }
      if (!runtime.persist) return result.tempFilePath;
      return runtime.persist(result.tempFilePath).catch(() => result.tempFilePath);
    });
    downloads.set(source, pending);
    pending.catch(() => { if (downloads.get(source) === pending) downloads.delete(source); });
    return pending;
  }

  return { localize, invalidate };
}

const localizer = createOperatorMediaLocalizer({
  authorize: (operation) => withOperatorAuthorization({}, operation),
  download: (url, headers) => new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      header: headers,
      timeout: 20000,
      success: (result) => resolve({ statusCode: result.statusCode, tempFilePath: result.tempFilePath }),
      fail: (error) => reject(mediaError(error.errMsg || "检测站照片安全读取失败")),
    });
  }),
  persist: (tempFilePath) => new Promise((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: (result) => resolve(result.savedFilePath),
      fail: (error) => reject(mediaError(error.errMsg || "检测站照片本地保存失败")),
    });
  }),
  exists: (filePath) => new Promise((resolve) => {
    wx.getFileSystemManager().access({ path: filePath, success: () => resolve(true), fail: () => resolve(false) });
  }),
});

export const localizeOperatorMedia = localizer.localize;
export const invalidateOperatorMedia = localizer.invalidate;
