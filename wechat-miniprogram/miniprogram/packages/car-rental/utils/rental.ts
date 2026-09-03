import type { CarRentalEnergyType, CarRentalOrderStatus, CarRentalSearch } from "../../../types";

const DAY_MS = 24 * 60 * 60 * 1000;

export function addCalendarDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), 0, 0);
}

export function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function timeInputValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function shanghaiIso(date: string, time: string): string {
  return `${date}T${time}:00+08:00`;
}

export function rentalDays(pickupAt: string, returnAt: string): number {
  const start = new Date(pickupAt).getTime();
  const end = new Date(returnAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.ceil((end - start) / DAY_MS);
}

export function validateRentalSearch(search: CarRentalSearch, now = new Date()): string {
  const pickup = new Date(search.pickupAt).getTime();
  const returning = new Date(search.returnAt).getTime();
  if (!Number.isFinite(pickup) || !Number.isFinite(returning)) return "请选择有效的取还时间";
  if (pickup < now.getTime() + 2 * 60 * 60 * 1000) return "取车时间需至少提前 2 小时";
  if (returning <= pickup) return "还车时间必须晚于取车时间";
  if (returning - pickup > 30 * DAY_MS) return "当前短租最长支持 30 天";
  if (search.fulfillmentMode === "store_pickup" && !search.storeId) return "请选择同店取还门店";
  if (search.fulfillmentMode === "home_delivery" && !search.deliveryAddress) return "请搜索并选择送取车地址";
  return "";
}

export function fen(value: number): string {
  const amount = Math.max(0, Number(value || 0)) / 100;
  return amount % 1 === 0 ? String(amount) : amount.toFixed(2);
}

export function energyLabel(value: CarRentalEnergyType | string): string {
  return ({
    gasoline: "汽油",
    diesel: "柴油",
    hybrid: "油电混动",
    plug_in_hybrid: "插电混动",
    range_extended: "增程",
    pure_electric: "纯电",
    other: "其他能源",
  } as Record<string, string>)[value] || "其他能源";
}

export function dateTimeLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function rentalStatus(value: CarRentalOrderStatus): { label: string; tone: string; description: string } {
  const map: Record<CarRentalOrderStatus, { label: string; tone: string; description: string }> = {
    pending_payment: { label: "待模拟支付", tone: "warning", description: "请在报价有效期内完成演示支付" },
    confirmed: { label: "预订成功", tone: "success", description: "订单已确认，门店正在准备车辆" },
    ready_for_pickup: { label: "待取车", tone: "success", description: "车辆已准备好，请按约定时间办理取车" },
    in_use: { label: "租用中", tone: "primary", description: "车辆正在租期内，请留意还车时间" },
    return_pending: { label: "还车处理中", tone: "primary", description: "已进入还车核验流程" },
    completed: { label: "已完成", tone: "muted", description: "本次租车服务已完成" },
    cancelled: { label: "已取消", tone: "muted", description: "订单已取消，车辆容量已释放" },
    expired: { label: "已失效", tone: "muted", description: "订单因未及时完成演示支付而失效" },
  };
  return map[value] || map.expired;
}
