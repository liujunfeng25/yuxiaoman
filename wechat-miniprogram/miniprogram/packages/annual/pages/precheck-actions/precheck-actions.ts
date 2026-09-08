import { api, uploadMedia } from "../../../../services/api";
import { clearWashDraft, patchWashDraft } from "../../../../services/storage";
import type { Booking, BookingMedia, MediaKind, Slot } from "../../../../types";
import { money } from "../../../../utils/format";

const photos: Array<{ kind: MediaKind; label: string }> = [
  { kind: "license_front", label: "行驶证正页" }, { kind: "license_back", label: "行驶证副页" },
  { kind: "vehicle_front_left", label: "车辆左前" }, { kind: "vehicle_front_right", label: "车辆右前" },
  { kind: "vehicle_rear_left", label: "车辆左后" }, { kind: "vehicle_rear_right", label: "车辆右后" },
  { kind: "dashboard_started", label: "启动后仪表盘" },
];
type Photo = typeof photos[number] & { url: string; needsUpdate: boolean; updated: boolean };
type Issue = { code: string; label: string; action: string; effect: string; selected: boolean };
const ownerEffects: Record<string, string> = {
  license_unclear: "补拍清晰完整的行驶证照片，再提交检测站审核。",
  vehicle_photos_incomplete: "补拍标注的车辆照片，确保画面清晰、内容完整。",
  vehicle_information_mismatch: "核对车牌、车辆和照片。需要更换车辆或计价信息时，请退款后重新预约。",
  booking_information_mismatch: "核对车型、动力和用途。需要更改计价条件时，请退款后重新预约。",
  materials_cannot_be_verified: "按检测站说明补充资料，再次提交审核。",
  body_dirty: "清洁后补拍照片。可以选择附近洗车店，也可以自行清洁。",
  body_damage: "可以向多家维修店获取报价并选择门店，也可以自行处理，之后补拍复核。",
  dashboard_warning: "进入维修报价，由门店检查处理。需到店确认的项目和费用会在报价中说明。",
  other: "按检测站的具体说明处理问题，补充资料后再次审核。",
};
const serviceStatus: Record<string, string> = { open: "等待报价 / 选择门店", paid: "已选店并模拟支付", cancelled: "已取消", pending_payment: "待支付", awaiting_redemption: "待洗车核销", redeemed: "已核销", refunded: "已退款", expired: "已过期" };

Page({
  data: {
    id: "", booking: null as Booking | null, issues: [] as Issue[], photos: [] as Photo[],
    replacements: [] as BookingMedia[], slots: [] as Slot[], slotLabels: [] as string[], slotIndex: -1,
    loading: true, busy: false, uploadingKind: "", error: "", resolutionNote: "", consented: false,
    hasWash: false, hasRepair: false, repairPhotos: [] as Photo[], amount: "0.00", canAct: false,
    stateTitle: "", stateNote: "", moneyLabel: "年检已付款保留",
    services: [] as Array<{ id: string; type: string; label: string; statusText: string }>,
  },
  onLoad(query) { this.setData({ id: String(query.id || "") }); },
  onShow() { if (this.data.id && !this.data.uploadingKind && !this.data.busy) void this.load(); },
  async load() {
    this.setData({ loading: !this.data.booking, error: "" });
    try {
      const booking = await api.booking(this.data.id);
      if (!booking.precheck) throw new Error("该订单没有预检问题记录");
      const issues = (booking.precheck.guidance || []).filter((item) => booking.precheck!.reasonCodes.includes(item.code))
        .map((item) => ({ ...item, effect: ownerEffects[item.code] || item.effect, selected: this.data.issues.find((old) => old.code === item.code)?.selected ?? true }));
      const canAct = booking.status === "precheck_action_required" && booking.paymentStatus === "paid";
      this.setData({ booking, issues, canAct,
        stateTitle: canAct ? "把问题处理好，再继续年检" : booking.status === "cancelled" ? "本次年检订单已取消" : booking.status === "pending_precheck" ? "处理资料已提交，等待复核" : "查看本次问题处理记录",
        stateNote: canAct ? "原时段已释放；处理后选择本站时段重新审核。退款由你主动申请。" : booking.status === "cancelled" ? "年检退款以订单记录为准，关联洗车和维修服务独立处理。" : "当前订单进度以检测站审核和履约记录为准。",
        moneyLabel: booking.status === "cancelled" ? "年检未退金额" : "年检已付款保留",
        hasWash: issues.some((item) => item.action === "wash"), hasRepair: issues.some((item) => item.action === "repair"),
        amount: money(Math.max(0, (booking.paidFen || 0) - (booking.refundedFen || 0))),
        services: (booking.precheckServices || []).map((item) => ({ ...item, statusText: serviceStatus[item.status] || item.status })),
      });
      this.refreshPhotos();
      if (canAct) {
        const slots = (await api.slots(booking.stationId)).filter((item) => item.remaining > 0 && Date.parse(`${item.date}T${item.startTime}:00+08:00`) > Date.now());
        const selectedId = this.data.slots[this.data.slotIndex]?.id;
        this.setData({ slots, slotLabels: slots.map((item) => `${item.date} ${item.startTime}–${item.endTime}`), slotIndex: slots.findIndex((item) => item.id === selectedId) });
      }
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "处理清单读取失败" }); }
    finally { this.setData({ loading: false }); }
  },
  refreshPhotos() {
    const booking = this.data.booking;
    if (!booking) return;
    const photoViews = photos.map((item) => {
      const replacement = this.data.replacements.find((media) => media.kind === item.kind);
      const original = booking.media?.find((media) => media.kind === item.kind);
      return { ...item, url: replacement?.url || original?.url || "", updated: Boolean(replacement), needsUpdate: Boolean(booking.precheck?.issuePhotoKinds.includes(item.kind)) };
    });
    const selected = this.data.issues.filter((item) => item.selected && item.action === "repair").map((item) => item.code);
    const repairPhotos = photoViews.filter((item) => booking.precheck?.issuePhotoKinds.includes(item.kind)
      && (item.kind === "dashboard_started" ? selected.includes("dashboard_warning") : item.kind.startsWith("vehicle_") && selected.includes("body_damage")))
      .map((item) => ({ ...item, url: booking.media?.find((media) => media.kind === item.kind)?.url || "" }));
    this.setData({ photos: photoViews, repairPhotos });
  },
  toggleRepairIssue(event) {
    const code = String(event.currentTarget.dataset.code || "");
    this.setData({ consented: false, issues: this.data.issues.map((item) => item.code === code ? { ...item, selected: !item.selected } : item) });
    this.refreshPhotos();
  },
  consentChanged(event) { this.setData({ consented: Array.isArray(event.detail.value) && event.detail.value.includes("share") }); },
  noteInput(event) { this.setData({ resolutionNote: String(event.detail.value || "") }); },
  slotChanged(event) { this.setData({ slotIndex: Number(event.detail.value) }); },
  async upload(event) {
    const kind = String(event.currentTarget.dataset.kind || "") as MediaKind;
    if (!this.data.canAct || this.data.uploadingKind || this.data.busy || !photos.some((item) => item.kind === kind)) return;
    this.setData({ uploadingKind: kind });
    try {
      const result = await new Promise<{ tempFiles: Array<{ tempFilePath: string }> }>((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["camera", "album"], success: resolve, fail: reject }));
      const media = await uploadMedia(kind, result.tempFiles[0].tempFilePath);
      this.setData({ replacements: [...this.data.replacements.filter((item) => item.kind !== kind), { ...media, url: result.tempFiles[0].tempFilePath }] });
      this.refreshPhotos();
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg || "照片上传失败，请重试");
      if (!message.includes("cancel")) wx.showToast({ title: message, icon: "none" });
    } finally { this.setData({ uploadingKind: "" }); }
  },
  preview(event) {
    const url = String(event.currentTarget.dataset.url || "");
    if (url) wx.previewImage({ current: url, urls: [url] });
  },
  openWash() {
    const booking = this.data.booking;
    if (!booking || !this.data.canAct) return;
    clearWashDraft();
    patchWashDraft({ vehicleId: booking.vehicleId, precheckBookingId: booking.id, serviceMode: "self_drive" });
    wx.navigateTo({ url: "/packages/wash/pages/wash-stores/wash-stores?fromPrecheck=1" });
  },
  async openRepair() {
    const booking = this.data.booking;
    if (!booking?.precheck || !this.data.canAct || this.data.busy) return;
    const existing = booking.precheckServices?.find((item) => item.type === "repair" && ["open", "paid"].includes(item.status));
    if (existing) { this.openService({ currentTarget: { dataset: { id: existing.id, type: "repair" } } }); return; }
    const reasonCodes = this.data.issues.filter((item) => item.action === "repair" && item.selected).map((item) => item.code);
    if (!reasonCodes.length || !this.data.consented) { wx.showToast({ title: "请选择维修问题并勾选照片共享授权", icon: "none" }); return; }
    this.setData({ busy: true, error: "" });
    try {
      const request = await api.createPrecheckRepairRequest({ bookingId: booking.id, expectedVersion: booking.precheck.version, reasonCodes, consented: true });
      wx.navigateTo({ url: `/packages/repair/pages/owner-request-detail/owner-request-detail?id=${encodeURIComponent(request.id)}` });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "维修报价发布失败" }); }
    finally { this.setData({ busy: false }); }
  },
  openService(event) {
    const id = encodeURIComponent(String(event.currentTarget.dataset.id || ""));
    const path = event.currentTarget.dataset.type === "repair" ? "/packages/repair/pages/owner-request-detail/owner-request-detail" : "/packages/wash/pages/wash-order-detail/wash-order-detail";
    wx.navigateTo({ url: `${path}?id=${id}` });
  },
  async submit() {
    const booking = this.data.booking;
    const slot = this.data.slots[this.data.slotIndex];
    if (!booking?.precheck || this.data.busy || this.data.uploadingKind || !this.data.canAct) return;
    if (!slot) { wx.showToast({ title: "请选择本站新的预约时段", icon: "none" }); return; }
    if (this.data.resolutionNote.trim().length < 5) { wx.showToast({ title: "请填写至少 5 个字的处理说明", icon: "none" }); return; }
    if (!this.data.replacements.length || this.data.photos.some((item) => item.needsUpdate && !item.updated)) { wx.showToast({ title: "请补拍标注的问题照片", icon: "none" }); return; }
    this.setData({ busy: true, error: "" });
    try {
      await api.resubmitPrecheck(booking.id, { expectedVersion: booking.precheck.version, idempotencyKey: `precheck-resubmit-${booking.id}-${booking.precheck.version}`,
        slotId: slot.id, mediaIds: this.data.replacements.map((item) => item.id), resolutionNote: this.data.resolutionNote.trim() });
      wx.redirectTo({ url: `/packages/annual/pages/order-detail/order-detail?id=${encodeURIComponent(booking.id)}` });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "重新提交失败，请重试" }); }
    finally { this.setData({ busy: false }); }
  },
  refund() {
    const booking = this.data.booking;
    if (!booking || !this.data.canAct || this.data.busy || this.data.uploadingKind) return;
    wx.showModal({ title: "申请退款并结束年检订单", content: `本次年检订单将全额退款 ¥${this.data.amount}（微信支付原路退回）。单独下单的洗车、维修服务不受影响，须到对应订单处理。`, confirmText: "确认退款", confirmColor: "#bf4941", success: async ({ confirm }) => {
      if (!confirm || this.data.busy) return;
      this.setData({ busy: true });
      try { await api.cancelBooking(booking.id); wx.redirectTo({ url: `/packages/annual/pages/order-detail/order-detail?id=${encodeURIComponent(booking.id)}` }); }
      catch (error) { this.setData({ error: error instanceof Error ? error.message : "退款申请失败，请重试" }); }
      finally { this.setData({ busy: false }); }
    } });
  },
  backToOrder() { wx.redirectTo({ url: `/packages/annual/pages/order-detail/order-detail?id=${encodeURIComponent(this.data.id)}` }); },
});
