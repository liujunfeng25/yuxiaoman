import type { BookingStatus, DistanceBasis, Station, WashOrderStatus } from "../types";

export function money(fen = 0): string { return (fen / 100).toFixed(2).replace(/\.00$/, ""); }

export function driveDuration(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) return `${rounded} 分钟`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder === 0 ? `${hours} 小时` : `${hours} 小时 ${remainder} 分钟`;
}

export function stationDistance(station: Pick<Station, "distanceKm" | "driveMinutes" | "distanceBasis">): string {
  if (station.distanceKm === null || station.driveMinutes === null) return "确定起点后计算";
  return `${station.distanceBasis === "estimated_distance" ? "预计 " : ""}${station.distanceKm} km · 约 ${driveDuration(station.driveMinutes)}`;
}

export function distanceLabel(distanceKm: number | null, driveMinutes: number | null, basis: DistanceBasis): string {
  if (distanceKm === null) return "确定取车地址后计算";
  return `${basis === "estimated_distance" ? "预计 " : ""}${distanceKm} km${driveMinutes === null ? "" : ` · 约 ${driveDuration(driveMinutes)}`}`;
}

export function statusLabel(status: BookingStatus): string {
  return ({ pending_payment: "待支付", paid_pending_confirmation: "历史待确认", pending_precheck: "待检测站预审", precheck_rejected: "预审未通过", confirmed: "预约已确认", driver_arranged: "司机已安排", picked_up: "司机已取车，前往检测站", awaiting_arrival: "等待到站", checked_in: "车辆已到检测站", inspecting: "检测中", result_received: "检测结果已回传", returning: "车辆送回中", completed: "服务已完成", on_hold: "异常挂起", cancelled: "已取消", no_show: "已爽约" })[status];
}

export function washStatusLabel(status: WashOrderStatus): string {
  return ({
    pending_payment: "待支付",
    awaiting_redemption: "待核销",
    redeemed: "已核销",
    cancelled: "已取消",
    refunded: "已退款",
    expired: "已过期",
  })[status];
}

export function today(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function twoDigits(value: number): string { return String(value).padStart(2, "0"); }

/** Format an absolute service timestamp with the fixed China Standard Time offset. */
export function formatShanghaiDateTime(
  value: string | number | Date | null | undefined,
  fallback = "时间待记录",
): string {
  if (value === null || value === undefined || value === "") return fallback;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shanghai.getUTCFullYear()}-${twoDigits(shanghai.getUTCMonth() + 1)}-${twoDigits(shanghai.getUTCDate())} ${twoDigits(shanghai.getUTCHours())}:${twoDigits(shanghai.getUTCMinutes())}:${twoDigits(shanghai.getUTCSeconds())}`;
}
