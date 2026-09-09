import { apiBaseUrl } from "../../../config/env";
import type { DriverTaskSession } from "../model";

const DRIVER_SESSION_STORAGE_KEY = `yuxiaoman.driverTaskSession:${apiBaseUrl || "unconfigured"}`;
const EXPIRY_SKEW_MS = 30000;

function validSession(value: unknown): DriverTaskSession | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<DriverTaskSession>;
  const token = typeof source.token === "string" ? source.token.trim() : "";
  const expiresAt = typeof source.expiresAt === "string" ? source.expiresAt : "";
  const taskId = typeof source.taskId === "string" ? source.taskId.trim() : "";
  const bookingId = typeof source.bookingId === "string" ? source.bookingId.trim() : "";
  const serviceType = source.serviceType === "car_wash" ? "car_wash" as const : "annual_inspection" as const;
  const expiry = Date.parse(expiresAt);
  if (!token || !taskId || !bookingId || !Number.isFinite(expiry) || expiry <= Date.now() + EXPIRY_SKEW_MS) return null;
  return { token, expiresAt, taskId, bookingId, serviceType };
}

export function readDriverTaskSession(): DriverTaskSession | null {
  const session = validSession(wx.getStorageSync<unknown>(DRIVER_SESSION_STORAGE_KEY));
  if (!session) wx.removeStorageSync(DRIVER_SESSION_STORAGE_KEY);
  return session;
}

export function storeDriverTaskSession(session: DriverTaskSession): void {
  const normalized = validSession(session);
  if (!normalized) throw new Error("代驾任务会话无效");
  wx.setStorageSync(DRIVER_SESSION_STORAGE_KEY, normalized);
}

export function clearDriverTaskSession(): void {
  wx.removeStorageSync(DRIVER_SESSION_STORAGE_KEY);
}

export function driverAuthorizationHeaders(): Record<string, string> {
  const session = readDriverTaskSession();
  if (!session) throw new Error("代驾任务凭证已失效，请重新打开任务入口");
  return { Authorization: `Bearer ${session.token}` };
}
