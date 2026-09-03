import { apiOrigin, assertApiConfigured } from "../../../config/env";
import {
  clearRepairOperatorSession,
  withRepairOperatorAuthorization,
} from "./operator-session";

type RepairOperatorMediaError = Error & { statusCode?: number };

function mediaError(message: string, statusCode?: number): RepairOperatorMediaError {
  const error = new Error(message) as RepairOperatorMediaError;
  error.statusCode = statusCode;
  return error;
}

export function repairOperatorMediaSourceUrl(path: string): string {
  const value = String(path || "").trim();
  if (!value) return "";
  const legacyLoopback = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/.*)?$/iu);
  if (legacyLoopback) return `${apiOrigin}${legacyLoopback[1] || ""}`;
  if (/^(https?:|wxfile:|data:|blob:|file:)/iu.test(value)) return value;
  if (value.startsWith("/assets/") || value.startsWith("/packages/") || value.startsWith("../") || value.startsWith("./")) return value;
  assertApiConfigured();
  return `${apiOrigin}${value.startsWith("/") ? value : `/${value}`}`;
}

export type RepairOperatorMediaRuntime = {
  authorize<T>(operation: (headers: Record<string, string>) => Promise<T>): Promise<T>;
  download(url: string, headers: Record<string, string>): Promise<{ statusCode: number; tempFilePath: string }>;
  persist?(tempFilePath: string): Promise<string>;
  exists?(filePath: string): Promise<boolean>;
};

export function createRepairOperatorMediaLocalizer(runtime: RepairOperatorMediaRuntime) {
  const downloads = new Map<string, Promise<string>>();

  function invalidate(path?: string): void {
    if (path === undefined) { downloads.clear(); return; }
    downloads.delete(repairOperatorMediaSourceUrl(path));
  }

  async function localize(path: string, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const source = repairOperatorMediaSourceUrl(path);
    if (!source) throw mediaError("维修资料地址无效");
    if (!/^https?:\/\//iu.test(source)) return source;
    if (options.forceRefresh) downloads.delete(source);
    const existing = downloads.get(source);
    if (existing) {
      try {
        const cachedPath = await existing;
        if (!runtime.exists || await runtime.exists(cachedPath)) return cachedPath;
      } catch {
        // Retry below using the repair-shop credential.
      }
      if (downloads.get(source) === existing) downloads.delete(source);
      return localize(source);
    }
    const pending = runtime.authorize(async (headers) => {
      const result = await runtime.download(source, headers);
      if (result.statusCode === 401) clearRepairOperatorSession();
      if (result.statusCode < 200 || result.statusCode >= 300 || !result.tempFilePath) {
        throw mediaError("维修资料安全读取失败", result.statusCode);
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

const localizer = createRepairOperatorMediaLocalizer({
  authorize: (operation) => withRepairOperatorAuthorization({}, operation),
  download: (url, headers) => new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      header: headers,
      timeout: 20000,
      success: (result) => resolve({ statusCode: result.statusCode, tempFilePath: result.tempFilePath }),
      fail: (error) => reject(mediaError(error.errMsg || "维修资料安全读取失败")),
    });
  }),
  persist: (tempFilePath) => new Promise((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: (result) => resolve(result.savedFilePath),
      fail: (error) => reject(mediaError(error.errMsg || "维修资料本地保存失败")),
    });
  }),
  exists: (filePath) => new Promise((resolve) => {
    wx.getFileSystemManager().access({ path: filePath, success: () => resolve(true), fail: () => resolve(false) });
  }),
});

export const localizeRepairOperatorMedia = localizer.localize;
export const invalidateRepairOperatorMedia = localizer.invalidate;
