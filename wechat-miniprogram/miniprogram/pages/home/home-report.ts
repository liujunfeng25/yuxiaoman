import type { VehicleCheckupReportListPage } from "../../types";
import { statusLabel } from "../../utils/format";

export type ReportEntry = {
  tone: "empty" | "active" | "ready" | "unavailable";
  badge: string;
  title: string;
  detail: string;
};

export const EMPTY_REPORT_ENTRY: ReportEntry = {
  tone: "empty",
  badge: "暂无报告",
  title: "检测报告",
  detail: "检测站回传结果后，报告会在这里按车辆归档",
};

function conclusionLabel(
  value: VehicleCheckupReportListPage["items"][number]["conclusion"],
  status?: VehicleCheckupReportListPage["items"][number]["conclusionStatus"],
): string {
  if (value === "passed") return "通过";
  if (value === "failed") return "未通过";
  if (status === "legacy_requires_reentry") return "结果未确认";
  return "结果未确认";
}

export function homeReportEntry(page: VehicleCheckupReportListPage | null, ready: boolean): ReportEntry {
  if (!ready) {
    return {
      tone: "unavailable",
      badge: "同步失败",
      title: "检测报告",
      detail: "订单状态暂未同步，点击进入报告中心可重新加载",
    };
  }

  const missingReports = (page?.progress || [])
    .filter((item) => item.progressType === "result_pending_report" && !item.reportReady)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (missingReports.length) {
    const latest = missingReports[0];
    return {
      tone: "unavailable",
      badge: "报告尚未形成",
      title: "检测报告",
      detail: missingReports.length > 1
        ? `${missingReports.length} 笔检测结果已回传，但结构化报告尚未形成`
        : `${latest.vehicle.plateNumber || "年检订单"} · 结果已回传，报告材料待补齐`,
    };
  }

  if (page?.items.length) {
    const latest = page.items[0];
    const activeCount = page.progress.filter((item) => item.progressType === "booking_in_progress").length;
    return {
      tone: latest.conclusionStatus === "legacy_requires_reentry" || !latest.conclusion ? "unavailable" : "ready",
      badge: `报告已生成 · ${conclusionLabel(latest.conclusion, latest.conclusionStatus)}`,
      title: "检测报告",
      detail: latest.conclusionStatus === "legacy_requires_reentry"
        ? "历史报告使用了已停用的旧结论，需由检测站重新录入通过或未通过"
        : activeCount
        ? `已有报告可查看，另有 ${activeCount} 个年检服务进行中`
        : "报告已按车辆归档，可查看结论、车况与现场照片",
    };
  }

  if (page?.progress.length) {
    const active = page.progress
      .filter((item) => item.progressType === "booking_in_progress")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = active[0] || [...page.progress].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return {
      tone: "active",
      badge: "报告待生成",
      title: "检测报告",
      detail: active.length > 1
        ? `当前有 ${active.length} 个年检服务进行中，报告随进度更新`
        : `${latest.vehicle.plateNumber || "年检订单"} · ${statusLabel(latest.fulfillmentStatus)}，检测站回传后生成报告`,
    };
  }

  return EMPTY_REPORT_ENTRY;
}
