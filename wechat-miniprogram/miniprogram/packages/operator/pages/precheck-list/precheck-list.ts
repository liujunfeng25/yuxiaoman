import { api } from "../../../../services/api";
import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import type { Booking, MediaKind } from "../../../../types";
import { formatShanghaiDateTime } from "../../../../utils/format";
import { workflowDueLabel } from "../../../../utils/workflow";

const selfDrivePhotoKinds: ReadonlySet<MediaKind> = new Set([
  "license_front", "license_back", "vehicle_front_left", "vehicle_front_right",
  "vehicle_rear_left", "vehicle_rear_right", "dashboard_started",
]);

type SupervisionLine = { label: string; value: string };

type PrecheckItem = Booking & {
  plateNumber: string;
  serviceModeLabel: string;
  appointmentDateLabel: string;
  appointmentTimeLabel: string;
  appointmentReleased: boolean;
  submittedLabel: string;
  photoCount: number;
  requiredPhotoCount: number;
  photoProgressPercent: number;
  slaLabel: string;
  slaTone: string;
  supervisionTitle: string;
  supervisionLines: SupervisionLine[];
};

function shortDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const full = formatShanghaiDateTime(value);
  // 2026-09-08 08:29:05 -> 09-08 08:29
  const match = full.match(/^\d{4}-(\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?$/u);
  return match ? `${match[1]} ${match[2]}` : full;
}

function supervisionView(precheck: NonNullable<Booking["precheck"]>): Pick<PrecheckItem, "supervisionTitle" | "supervisionLines"> {
  const supervision = precheck.supervision;
  if (!supervision) {
    return { supervisionTitle: "未启用督办", supervisionLines: [] };
  }
  if (supervision.status !== "open") {
    return {
      supervisionTitle: `第 ${supervision.policyVersion} 版 · 已关闭`,
      supervisionLines: [],
    };
  }
  const lines: SupervisionLine[] = [];
  if (supervision.dueAt) lines.push({ label: "处理截止", value: shortDateTime(supervision.dueAt) });
  if (supervision.firstReminderAt) lines.push({ label: "首次提醒", value: shortDateTime(supervision.firstReminderAt) });
  if (supervision.escalateAt) lines.push({ label: "升级时间", value: shortDateTime(supervision.escalateAt) });
  lines.push({
    label: "提醒状态",
    value: supervision.reminderCount > 0
      ? `已提醒 ${supervision.reminderCount} 次${supervision.lastRemindedAt ? ` · ${shortDateTime(supervision.lastRemindedAt)}` : ""}`
      : "尚未提醒",
  });
  return {
    supervisionTitle: `第 ${supervision.policyVersion} 版规则`,
    supervisionLines: lines,
  };
}

function view(item: Booking): PrecheckItem {
  const precheck = item.precheck!;
  const supervision = precheck.supervision;
  const requiredPhotoKinds = selfDrivePhotoKinds;
  const requiredPhotoCount = requiredPhotoKinds.size;
  const photoCount = new Set((item.media || []).filter((media) => requiredPhotoKinds.has(media.kind)).map((media) => media.kind)).size;
  const supervisionLabel = !supervision
    ? "未启用督办"
    : supervision.status !== "open"
      ? "督办已关闭"
      : precheck.overdue
        ? workflowDueLabel(supervision.dueAt, "overdue")
        : precheck.reminderDue
          ? `已提醒 ${supervision.reminderCount} 次`
          : supervision.dueAt
            ? workflowDueLabel(supervision.dueAt, "normal")
            : "处理中";
  const released = Boolean(item.precheckSlotReleased);
  return {
    ...item,
    plateNumber: item.vehicle?.plateNumber || "车牌待核验",
    serviceModeLabel: item.serviceMode === "valet" ? "代驾往返取送" : "车主自驾到站",
    appointmentDateLabel: released ? "原时段已释放" : item.appointmentDate,
    appointmentTimeLabel: released ? "待车主重新选择" : `${item.startTime}–${item.endTime}`,
    appointmentReleased: released,
    submittedLabel: formatShanghaiDateTime(precheck.submittedAt),
    photoCount,
    requiredPhotoCount,
    photoProgressPercent: Math.round(photoCount / requiredPhotoCount * 100),
    slaLabel: item.status === "precheck_action_required" ? "待车主处理" : item.status === "cancelled" ? "已取消" : precheck.status === "approved" ? "已通过" : supervisionLabel,
    slaTone: precheck.overdue ? "overdue" : precheck.reminderDue ? "reminder" : "normal",
    ...supervisionView(precheck),
  };
}

Page({
  data: { items: [] as PrecheckItem[], loading: true, loadError: "", filter: "pending" as "pending" | "rejected" | "all" },
  onLoad() { ensureOperatorPageAccess("/packages/operator/pages/precheck-list/precheck-list"); },
  onShow() { void this.load(); },
  onPullDownRefresh() { void this.load(); },
  async load() {
    const sequence = Number(this.loadSequence || 0) + 1;
    this.loadSequence = sequence;
    const filter = this.data.filter;
    this.setData({ loading: true, loadError: "" });
    try {
      const result = filter === "pending" ? await api.operatorPrechecks() : await api.operatorPrechecks(filter);
      if (sequence !== this.loadSequence) return;
      this.setData({ items: result.items.filter((item) => filter !== "rejected" || item.status === "precheck_action_required").map(view) });
    } catch (error) {
      if (sequence !== this.loadSequence) return;
      const message = error instanceof Error ? error.message : "待预审订单读取失败";
      this.setData({ loadError: message });
    } finally {
      if (sequence === this.loadSequence) {
        this.setData({ loading: false });
        wx.stopPullDownRefresh();
      }
    }
  },
  changeFilter(event) { this.setData({ filter: event.currentTarget.dataset.status }); void this.load(); },
  open(event) {
    wx.navigateTo({ url: `/packages/operator/pages/precheck-detail/precheck-detail?id=${event.currentTarget.dataset.id as string}` });
  },
  retry() { if (!this.data.loading) void this.load(); },
});
