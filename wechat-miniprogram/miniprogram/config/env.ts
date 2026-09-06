/**
 * No AppSecret, map key, or integration secret belongs in this file. The
 * development origin works only in the WeChat developer-tools simulator with
 * the service-port setting enabled, as documented in this package README.
 *
 * Mac/Windows 自动真机调试 runs inside desktop WeChat on the same machine, so
 * it must use loopback HTTP (127.0.0.1). Physical phones use DEVICE_LAN_HOST on
 * the same Wi-Fi (not phone hotspot). If LAN is isolated, temporarily point
 * DEVELOPMENT_API_BASE_DEVICE at an HTTPS tunnel instead.
 *
 * Trial (体验版) and release both use PRODUCTION_API_BASE so phone tests hit the
 * same HTTPS API as production. Only the developer-tools / develop build keeps
 * the local LAN endpoints.
 */
const DEVICE_LAN_HOST = "192.168.1.16";
// 开发者工具连接本机 API；真机局域网调试使用这台电脑的 WLAN 地址。
const DEVELOPMENT_API_BASE_LOCAL = "http://127.0.0.1:8792/api";
const DEVELOPMENT_API_BASE_DEVICE = `http://${DEVICE_LAN_HOST}:8792/api`;
const PRODUCTION_API_BASE = "https://app.yuxiaomancs.com/api";

export function isReleaseBuild(): boolean {
  // Node-based unit tests do not provide the WeChat runtime at all. This branch
  // is removed from the real mini-program environment, where `wx` is defined.
  if (typeof wx === "undefined") return false;
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion === "release";
  } catch {
    // Authentication must fail closed when the runtime cannot prove this is a
    // development/trial build. Treating an unknown environment as development
    // could select the LAN API and permit the explicit demo fallback path.
    return true;
  }
}

/** Trial and release share the public HTTPS API. */
function usesProductionApiBase(): boolean {
  if (typeof wx === "undefined") return false;
  try {
    const version = wx.getAccountInfoSync().miniProgram.envVersion;
    return version === "release" || version === "trial";
  } catch {
    return true;
  }
}

/** Simulator + desktop WeChat auto-debug share the API machine. */
function usesLocalhostApi(): boolean {
  try {
    const platform = wx.getSystemInfoSync().platform;
    return platform === "devtools" || platform === "mac" || platform === "windows";
  } catch {
    return true;
  }
}

export const apiBaseUrl = usesProductionApiBase()
  ? PRODUCTION_API_BASE
  : usesLocalhostApi()
    ? DEVELOPMENT_API_BASE_LOCAL
    : DEVELOPMENT_API_BASE_DEVICE;
export const apiOrigin = apiBaseUrl.replace(/\/api$/, "");

export function assertApiConfigured(): void {
  if (!apiBaseUrl) throw new Error("尚未配置生产 API 地址");
}
