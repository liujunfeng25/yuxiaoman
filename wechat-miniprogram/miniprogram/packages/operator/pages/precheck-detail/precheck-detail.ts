import { api } from "../../../../services/api";
import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import type { Booking, BookingMedia, MediaKind } from "../../../../types";
import { formatShanghaiDateTime, money } from "../../../../utils/format";

const photoDefinitions: Array<{ kind: MediaKind; label: string }> = [
  { kind: "license_front", label: "行驶证正页" }, { kind: "license_back", label: "行驶证副页" },
  { kind: "vehicle_front_left", label: "车辆左前" }, { kind: "vehicle_front_right", label: "车辆右前" },
  { kind: "vehicle_rear_left", label: "车辆左后" }, { kind: "vehicle_rear_right", label: "车辆右后" },
  { kind: "dashboard_started", label: "启动后仪表盘" },
];
const reasonDefinitions = [
  { code: "license_unclear", label: "行驶证模糊或缺页" },
  { code: "vehicle_photos_incomplete", label: "车辆照片不完整或不清晰" },
  { code: "vehicle_information_mismatch", label: "车牌或车辆信息不一致" },
  { code: "booking_information_mismatch", label: "预约车型、动力或用途不一致" },
  { code: "materials_cannot_be_verified", label: "现有资料无法完成核对" },
  { code: "other", label: "其他" },
];
type PhotoView = BookingMedia & { label: string; selected: boolean };

Page({
  data: {
    id: "", booking: null as Booking | null, photos: [] as PhotoView[], loading: true, loadError: "", deciding: false,
    submittedLabel: "", serviceModeLabel: "", appointmentLabel: "", paymentLabel: "", showReject: false,
    reasons: reasonDefinitions.map((item) => ({ ...item, selected: false })), reasonText: "", selectedPhotoKinds: [] as string[],
    approveIdempotencyKey: "", rejectIdempotencyKey: "",
  },
  onLoad(query) {
    const id = String(query.id || "");
    this.setData({
      id,
      approveIdempotencyKey: `approve-${id}-${Date.now()}`,
      rejectIdempotencyKey: `reject-${id}-${Date.now()}`,
    });
    if (ensureOperatorPageAccess(`/packages/operator/pages/precheck-detail/precheck-detail?id=${encodeURIComponent(id)}`)) void this.load();
  },
  async load() {
    if (!this.data.id) return;
    this.setData({ loading: true, loadError: "" });
    try {
      const booking = await api.operatorPrecheck(this.data.id);
      const byKind = new Map((booking.media || []).map((item) => [item.kind, item]));
      const selected = new Set(this.data.selectedPhotoKinds);
      const photos = photoDefinitions.map((definition) => ({
        ...(byKind.get(definition.kind) || { id: definition.kind, kind: definition.kind, url: "", mimeType: "", sizeBytes: 0, width: 0, height: 0, createdAt: "" }),
        label: definition.label,
        selected: selected.has(definition.kind),
      }));
      this.setData({
        booking, photos, submittedLabel: formatShanghaiDateTime(booking.precheck?.submittedAt),
        serviceModeLabel: booking.serviceMode === "valet" ? "代驾往返取送" : "车主自驾到站",
        appointmentLabel: `${booking.appointmentDate} ${booking.startTime}–${booking.endTime}`,
        paymentLabel: `¥${money(booking.paidFen || booking.serviceFeeFen)}`, loadError: "",
      });
    } catch (error) { this.setData({ loadError: error instanceof Error ? error.message : "预审资料读取失败" }); }
    finally { this.setData({ loading: false }); }
  },
  preview(event) {
    const url = String(event.currentTarget.dataset.url || "");
    const urls = this.data.photos.map((item) => item.url).filter(Boolean);
    if (url) wx.previewImage({ current: url, urls });
  },
  async approve() {
    const booking = this.data.booking;
    if (!booking?.precheck || this.data.deciding) return;
    if (this.data.photos.some((item) => !item.url)) { wx.showToast({ title: "7 张资料齐全后才能通过", icon: "none" }); return; }
    wx.showModal({ title: "确认预审通过", content: booking.serviceMode === "valet" ? "通过后订单将进入代驾司机安排阶段。" : "通过即代表检测站接单，订单将进入等待到站。", confirmText: "确认通过", success: async ({ confirm }) => {
      if (!confirm) return;
      this.setData({ deciding: true });
      try {
        await api.approveOperatorPrecheck(booking.id, { idempotencyKey: this.data.approveIdempotencyKey, expectedVersion: booking.precheck!.version });
        wx.showToast({ title: "预审已通过", icon: "success" });
        setTimeout(() => wx.navigateBack(), 500);
      } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "预审提交失败", icon: "none" }); await this.load(); }
      finally { this.setData({ deciding: false }); }
    } });
  },
  openReject() { this.setData({ showReject: true }); }, closeReject() { if (!this.data.deciding) this.setData({ showReject: false }); },
  toggleReason(event) {
    const code = String(event.currentTarget.dataset.code);
    this.setData({ reasons: this.data.reasons.map((item) => item.code === code ? { ...item, selected: !item.selected } : item) });
  },
  togglePhoto(event) {
    const kind = String(event.currentTarget.dataset.kind);
    const selected = new Set(this.data.selectedPhotoKinds);
    selected.has(kind) ? selected.delete(kind) : selected.add(kind);
    const selectedPhotoKinds = [...selected];
    this.setData({ selectedPhotoKinds, photos: this.data.photos.map((item) => ({ ...item, selected: selected.has(item.kind) })) });
  },
  reasonInput(event) { this.setData({ reasonText: String(event.detail.value || "") }); },
  submitReject() {
    const booking = this.data.booking;
    const reasonCodes = this.data.reasons.filter((item) => item.selected).map((item) => item.code);
    const reasonText = this.data.reasonText.trim();
    if (!booking?.precheck || this.data.deciding) return;
    if (!reasonCodes.length) { wx.showToast({ title: "请选择不通过原因", icon: "none" }); return; }
    if (reasonText.length < 5) { wx.showToast({ title: "请填写至少 5 个字的具体说明", icon: "none" }); return; }
    wx.showModal({ title: "确认不通过并退款", content: `确认后将释放号源，并发起全额模拟退款 ${this.data.paymentLabel}。该决定不能由检测站撤销。`, confirmText: "确认退款", confirmColor: "#d44848", success: async ({ confirm }) => {
      if (!confirm) return;
      this.setData({ deciding: true });
      try {
        await api.rejectOperatorPrecheck(booking.id, { idempotencyKey: this.data.rejectIdempotencyKey, expectedVersion: booking.precheck!.version, reasonCodes, reasonText, issuePhotoKinds: this.data.selectedPhotoKinds });
        wx.showToast({ title: "已驳回并退款", icon: "success" });
        setTimeout(() => wx.navigateBack(), 600);
      } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "驳回提交失败", icon: "none" }); await this.load(); }
      finally { this.setData({ deciding: false }); }
    } });
  },
  noop() {},
});
