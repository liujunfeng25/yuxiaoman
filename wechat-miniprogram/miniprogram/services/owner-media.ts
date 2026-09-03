import { apiOrigin, assertApiConfigured } from "../config/env";
import { withOwnerAuthorization } from "./session";

type OwnerMediaError = Error & { statusCode?: number };

export type OwnerMediaDownloadResult = {
  statusCode: number;
  tempFilePath: string;
};

export type OwnerMediaRuntime = {
  authorize<T>(operation: (headers: Record<string, string>) => Promise<T>): Promise<T>;
  download(url: string, headers: Record<string, string>): Promise<OwnerMediaDownloadResult>;
  persist?(tempFilePath: string): Promise<string>;
  exists?(filePath: string): Promise<boolean>;
};

export type OwnerMediaLocalizer = {
  localize(path: string, options?: { forceRefresh?: boolean }): Promise<string>;
  invalidate(path?: string): void;
};

function ownerMediaError(message: string, statusCode?: number): OwnerMediaError {
  const error = new Error(message) as OwnerMediaError;
  error.statusCode = statusCode;
  return error;
}

export function ownerMediaSourceUrl(path: string): string {
  const value = String(path || "").trim();
  if (!value) return "";
  const legacyLoopback = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/.*)?$/iu);
  if (legacyLoopback) return `${apiOrigin}${legacyLoopback[1] || ""}`;
  if (/^(https?:|wxfile:|data:|blob:|file:)/iu.test(value)) return value;
  if (value.startsWith("/assets/") || value.startsWith("/packages/") || value.startsWith("../") || value.startsWith("./")) {
    return value;
  }
  assertApiConfigured();
  return `${apiOrigin}${value.startsWith("/") ? value : `/${value}`}`;
}

function requiresAuthenticatedDownload(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

/**
 * Downloads owner-private media with the application Bearer token before it is
 * handed to an `<image>`. Successful and in-flight downloads share an
 * in-memory cache; failed downloads are deliberately evicted so a later user
 * retry performs a real authenticated request. A protected remote URL is never
 * returned as a visual fallback.
 */
export function createOwnerMediaLocalizer(runtime: OwnerMediaRuntime): OwnerMediaLocalizer {
  const downloads = new Map<string, Promise<string>>();

  function invalidate(path?: string): void {
    if (path === undefined) {
      downloads.clear();
      return;
    }
    downloads.delete(ownerMediaSourceUrl(path));
  }

  async function localize(path: string, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const sourceUrl = ownerMediaSourceUrl(path);
    if (!sourceUrl) throw ownerMediaError("留证照片地址无效");
    if (!requiresAuthenticatedDownload(sourceUrl)) return sourceUrl;
    if (options.forceRefresh) downloads.delete(sourceUrl);

    const cached = downloads.get(sourceUrl);
    if (cached) {
      try {
        const cachedPath = await cached;
        if (!runtime.exists || await runtime.exists(cachedPath)) return cachedPath;
      } catch {
        // A rejected or already-evicted entry is downloaded again below.
      }
      if (downloads.get(sourceUrl) === cached) downloads.delete(sourceUrl);
      return localize(sourceUrl);
    }

    const pending = runtime.authorize(async (headers) => {
      const result = await runtime.download(sourceUrl, headers);
      if (result.statusCode < 200 || result.statusCode >= 300 || !result.tempFilePath) {
        throw ownerMediaError("留证照片安全读取失败", result.statusCode);
      }
      if (!runtime.persist) return result.tempFilePath;
      // saveFile can fail when the user-data quota is exhausted. The freshly
      // downloaded temp file is still usable; exists() will evict it once the
      // WeChat runtime reclaims it.
      return runtime.persist(result.tempFilePath).catch(() => result.tempFilePath);
    });
    downloads.set(sourceUrl, pending);
    pending.catch(() => {
      if (downloads.get(sourceUrl) === pending) downloads.delete(sourceUrl);
    });
    return pending;
  }

  return { localize, invalidate };
}

const ownerMediaLocalizer = createOwnerMediaLocalizer({
  authorize: (operation) => withOwnerAuthorization({}, operation),
  download: (url, headers) => new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      header: headers,
      timeout: 20000,
      success: (result) => resolve({ statusCode: result.statusCode, tempFilePath: result.tempFilePath }),
      fail: (error) => reject(ownerMediaError(error.errMsg || "留证照片安全读取失败")),
    });
  }),
  persist: (tempFilePath) => new Promise((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: (result) => resolve(result.savedFilePath),
      fail: (error) => reject(ownerMediaError(error.errMsg || "留证照片本地保存失败")),
    });
  }),
  exists: (filePath) => new Promise((resolve) => {
    wx.getFileSystemManager().access({ path: filePath, success: () => resolve(true), fail: () => resolve(false) });
  }),
});

export const localizeOwnerMedia = ownerMediaLocalizer.localize;
export const invalidateOwnerMedia = ownerMediaLocalizer.invalidate;
