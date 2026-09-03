import { api } from "../../../../services/api";
import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import type { Booking } from "../../../../types";
import { formatShanghaiDateTime } from "../../../../utils/format";

type PrecheckItem = Booking & {
  plateNumber: string;
  serviceModeLabel: string;
  appointmentLabel: string;
  submittedLabel: string;
  photoCount: number;
  slaLabel: string;
  slaTone: string;
};

function view(item: Booking): PrecheckItem {
  const precheck = item.precheck!;
  return {
    ...item,
    plateNumber: item.vehicle?.plateNumber || "车牌待核验",
    serviceModeLabel: item.serviceMode === "valet" ? "代驾往返取送" : "车主自驾到站",
    appointmentLabel: `${item.appointmentDate} ${item.startTime}–${item.endTime}`,
    submittedLabel: formatShanghaiDateTime(precheck.submittedAt),
    photoCount: item.media?.length || 0,
    slaLabel: precheck.overdue ? "已超时" : precheck.reminderDue ? "请尽快处理" : "处理中",
    slaTone: precheck.overdue ? "overdue" : precheck.reminderDue ? "reminder" : "normal",
  };
}

Page({
  data: { items: [] as PrecheckItem[], loading: true, loadError: "" },
  onLoad() { ensureOperatorPageAccess("/packages/operator/pages/precheck-list/precheck-list"); },
  onShow() { void this.load(); },
  onPullDownRefresh() { void this.load(); },
  async load() {
    this.setData({ loading: true, loadError: "" });
    try {
      const result = await api.operatorPrechecks();
      this.setData({ items: result.items.map(view) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "待预审订单读取失败";
      this.setData({ loadError: message });
    } finally {
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },
  open(event) {
    wx.navigateTo({ url: `/packages/operator/pages/precheck-detail/precheck-detail?id=${event.currentTarget.dataset.id as string}` });
  },
  retry() { if (!this.data.loading) void this.load(); },
});
