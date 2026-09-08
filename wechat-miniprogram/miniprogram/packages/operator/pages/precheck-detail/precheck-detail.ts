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

const licenseKinds: MediaKind[] = ["license_front", "license_back"];
const bodyKinds: MediaKind[] = ["vehicle_front_left", "vehicle_front_right", "vehicle_rear_left", "vehicle_rear_right"];
const vehicleReviewKinds: MediaKind[] = [...bodyKinds, "dashboard_started"];
const allKinds: MediaKind[] = photoDefinitions.map((item) => item.kind);

const reasonPhotoConfig: Record<string, { kinds: MediaKind[]; hint: string; required: boolean }> = {
  license_unclear: { kinds: licenseKinds, hint: "请标注模糊或缺页的行驶证照片（可多选）", required: true },
  vehicle_photos_incomplete: { kinds: vehicleReviewKinds, hint: "请标注不完整或不清晰的车辆/仪表盘照片", required: true },
  vehicle_information_mismatch: { kinds: [...licenseKinds, ...bodyKinds], hint: "建议标注用于核对车辆身份的照片（可选）", required: false },
  booking_information_mismatch: { kinds: [...licenseKinds, ...bodyKinds], hint: "建议标注与预约信息不符的照片（可选）", required: false },
  materials_cannot_be_verified: { kinds: allKinds, hint: "可标注无法核对的资料照片（可选）", required: false },
  body_dirty: { kinds: bodyKinds, hint: "请标注脏污对应的车身照片", required: true },
  body_damage: { kinds: bodyKinds, hint: "请标注车损对应的车身照片", required: true },
  dashboard_warning: { kinds: ["dashboard_started"], hint: "请标注启动后仪表盘照片", required: true },
  other: { kinds: allKinds, hint: "可标注相关问题照片（可选）", required: false },
};

const reasonDefinitions = [
  { code: "license_unclear", label: "行驶证模糊或缺页" },
  { code: "vehicle_photos_incomplete", label: "车辆照片不完整或不清晰" },
  { code: "vehicle_information_mismatch", label: "车牌或车辆信息不一致" },
  { code: "booking_information_mismatch", label: "预约车型、动力或用途不一致" },
  { code: "materials_cannot_be_verified", label: "现有资料无法完成核对" },
  { code: "body_dirty", label: "车身脏污，需清洁后核对" },
  { code: "body_damage", label: "车损需要处理或核对" },
  { code: "dashboard_warning", label: "仪表盘故障灯，需维修核对" },
  { code: "other", label: "其他" },
];

type PhotoOption = { kind: MediaKind; label: string; selected: boolean; shared: boolean };
type ReasonView = {
  code: string;
  label: string;
  selected: boolean;
  effect: string;
  action: string;
  photoHint: string;
  photoRequired: boolean;
  photoOptions: PhotoOption[];
};
type PhotoView = BookingMedia & { label: string; selected: boolean };
type ReasonPhotoMap = Record<string, string[]>;

function photoLabel(kind: string): string {
  return photoDefinitions.find((item) => item.kind === kind)?.label || kind;
}

function unionPhotoKinds(map: ReasonPhotoMap): string[] {
  const kinds = new Set<string>();
  for (const list of Object.values(map)) {
    for (const kind of list) kinds.add(kind);
  }
  return [...kinds];
}

function buildReasons(
  guidance: Array<{ code: string; label: string; effect: string; action: string }>,
  selectedCodes: Set<string>,
  reasonPhotoMap: ReasonPhotoMap,
): ReasonView[] {
  const ownedBy = new Map<string, string[]>();
  for (const [code, kinds] of Object.entries(reasonPhotoMap)) {
    for (const kind of kinds) {
      const list = ownedBy.get(kind) || [];
      list.push(code);
      ownedBy.set(kind, list);
    }
  }
  return guidance.map((item) => {
    const config = reasonPhotoConfig[item.code] || { kinds: allKinds, hint: "可标注相关问题照片（可选）", required: false };
    const selectedKinds = new Set(reasonPhotoMap[item.code] || []);
    return {
      ...item,
      selected: selectedCodes.has(item.code),
      photoHint: config.hint,
      photoRequired: config.required,
      photoOptions: config.kinds.map((kind) => {
        const owners = ownedBy.get(kind) || [];
        return {
          kind,
          label: photoLabel(kind),
          selected: selectedKinds.has(kind),
          shared: owners.some((code) => code !== item.code),
        };
      }),
    };
  });
}

Page({
  data: {
    id: "", booking: null as Booking | null, photos: [] as PhotoView[], loading: true, loadError: "", deciding: false,
    submittedLabel: "", serviceModeLabel: "", appointmentLabel: "", paymentLabel: "", showReject: false,
    requiredPhotoCount: 0, photoCount: 0, requiredPhotoDescription: "", vehiclePhotosRequired: true,
    reasons: [] as ReasonView[], reasonText: "", selectedPhotoKinds: [] as string[], selectedPhotoSummary: "",
    reasonPhotoMap: {} as ReasonPhotoMap,
    approveIdempotencyKey: "", rejectIdempotencyKey: "", rejectConfirming: false,
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
  syncRejectSelection(reasonPhotoMap: ReasonPhotoMap, reasonsSelected?: Set<string>) {
    const guidance = (this.data.booking?.precheck?.guidance
      || reasonDefinitions.map((item) => ({ ...item, action: "materials", effect: "补充资料后重新审核" })))
      .map((item) => ({ code: item.code, label: item.label, effect: item.effect, action: item.action }));
    const selectedCodes = reasonsSelected
      || new Set(this.data.reasons.filter((item) => item.selected).map((item) => item.code));
    const selectedPhotoKinds = unionPhotoKinds(reasonPhotoMap);
    const selected = new Set(selectedPhotoKinds);
    this.setData({
      reasonPhotoMap,
      selectedPhotoKinds,
      selectedPhotoSummary: selectedPhotoKinds.length
        ? selectedPhotoKinds.map((kind) => photoLabel(kind)).join("、")
        : "尚未标注问题照片",
      reasons: buildReasons(guidance, selectedCodes, reasonPhotoMap),
      photos: this.data.photos.map((item) => ({ ...item, selected: selected.has(item.kind) })),
    });
  },
  async load() {
    if (!this.data.id) return;
    this.setData({ loading: true, loadError: "" });
    try {
      const booking = await api.operatorPrecheck(this.data.id);
      const byKind = new Map((booking.media || []).map((item) => [item.kind, item]));
      const selectedCodes = new Set(this.data.reasons.filter((item) => item.selected).map((item) => item.code));
      const reasonPhotoMap: ReasonPhotoMap = { ...this.data.reasonPhotoMap };
      for (const code of Object.keys(reasonPhotoMap)) {
        if (!selectedCodes.has(code)) delete reasonPhotoMap[code];
      }
      const selectedPhotoKinds = unionPhotoKinds(reasonPhotoMap);
      const selected = new Set(selectedPhotoKinds);
      const photos = photoDefinitions.map((definition) => ({
        ...(byKind.get(definition.kind) || { id: definition.kind, kind: definition.kind, url: "", mimeType: "", sizeBytes: 0, width: 0, height: 0, createdAt: "" }),
        label: definition.label,
        selected: selected.has(definition.kind),
      }));
      const guidance = (booking.precheck?.guidance || reasonDefinitions.map((item) => ({ ...item, action: "materials" as const, effect: "补充资料后重新审核" })))
        .map((item) => ({ code: item.code, label: item.label, effect: item.effect, action: item.action }));
      this.setData({
        booking,
        photos,
        reasonPhotoMap,
        selectedPhotoKinds,
        selectedPhotoSummary: selectedPhotoKinds.length
          ? selectedPhotoKinds.map((kind) => photoLabel(kind)).join("、")
          : "尚未标注问题照片",
        reasons: buildReasons(guidance, selectedCodes, reasonPhotoMap),
        submittedLabel: formatShanghaiDateTime(booking.precheck?.submittedAt),
        serviceModeLabel: booking.serviceMode === "valet" ? "代驾往返取送" : "车主自驾到站",
        appointmentLabel: `${booking.appointmentDate} ${booking.startTime}–${booking.endTime}`,
        paymentLabel: `¥${money(booking.paidFen || booking.serviceFeeFen)}`,
        requiredPhotoCount: photos.length,
        photoCount: photos.filter((item) => Boolean(item.url)).length,
        requiredPhotoDescription: "车身四角、启动后仪表盘和行驶证两页",
        vehiclePhotosRequired: true,
        loadError: "",
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
    if (this.data.photos.some((item) => !item.url)) { wx.showToast({ title: `${this.data.requiredPhotoCount} 张资料齐全后才能通过`, icon: "none" }); return; }
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
  openReject() { this.setData({ showReject: true, rejectConfirming: false }); },
  closeReject() { if (!this.data.deciding) this.setData({ showReject: false, rejectConfirming: false }); },
  backToRejectForm() { if (!this.data.deciding) this.setData({ rejectConfirming: false }); },
  toggleReason(event) {
    const code = String(event.currentTarget.dataset.code);
    const selectedCodes = new Set(this.data.reasons.filter((item) => item.selected).map((item) => item.code));
    const reasonPhotoMap: ReasonPhotoMap = { ...this.data.reasonPhotoMap };
    if (selectedCodes.has(code)) {
      selectedCodes.delete(code);
      delete reasonPhotoMap[code];
    } else {
      selectedCodes.add(code);
      if (!reasonPhotoMap[code]) reasonPhotoMap[code] = [];
    }
    this.syncRejectSelection(reasonPhotoMap, selectedCodes);
  },
  togglePhoto(event) {
    const code = String(event.currentTarget.dataset.code || "");
    const kind = String(event.currentTarget.dataset.kind || "");
    if (!code || !kind) return;
    const reasonPhotoMap: ReasonPhotoMap = { ...this.data.reasonPhotoMap };
    const current = new Set(reasonPhotoMap[code] || []);
    if (current.has(kind)) current.delete(kind);
    else current.add(kind);
    reasonPhotoMap[code] = [...current];
    this.syncRejectSelection(reasonPhotoMap);
  },
  rejectIssuePhotoError(reasonCodes: string[], issuePhotoKinds: string[]) {
    if (reasonCodes.includes("dashboard_warning") && !issuePhotoKinds.includes("dashboard_started")) {
      return "故障灯问题请标注启动后仪表盘照片";
    }
    if (reasonCodes.some((code) => code === "body_dirty" || code === "body_damage")
      && !issuePhotoKinds.some((kind) => kind.startsWith("vehicle_"))) {
      return "脏污或车损问题请标注对应车身照片";
    }
    if (reasonCodes.includes("license_unclear")
      && !issuePhotoKinds.some((kind) => kind === "license_front" || kind === "license_back")) {
      return "行驶证模糊或缺页请标注对应的行驶证照片";
    }
    if (reasonCodes.includes("vehicle_photos_incomplete")
      && !issuePhotoKinds.some((kind) => kind.startsWith("vehicle_") || kind === "dashboard_started")) {
      return "车辆照片不完整或不清晰请标注对应车辆照片";
    }
    return "";
  },
  reasonInput(event) { this.setData({ reasonText: String(event.detail.value || "") }); },
  submitReject() {
    const booking = this.data.booking;
    const reasonCodes = this.data.reasons.filter((item) => item.selected).map((item) => item.code);
    const reasonText = this.data.reasonText.trim();
    if (this.data.deciding) {
      wx.showToast({ title: "正在提交，请稍候", icon: "none" });
      return;
    }
    if (!booking?.precheck) {
      wx.showToast({ title: "预审资料未加载完成，请关闭后重试", icon: "none" });
      return;
    }
    if (!reasonCodes.length) {
      wx.showToast({ title: "请选择不通过原因", icon: "none" });
      return;
    }
    if (reasonText.length < 5) {
      wx.showToast({ title: "请填写至少 5 个字的具体说明", icon: "none" });
      return;
    }
    const photoError = this.rejectIssuePhotoError(reasonCodes, this.data.selectedPhotoKinds);
    if (photoError) {
      wx.showToast({ title: photoError, icon: "none" });
      return;
    }
    if (!this.data.rejectConfirming) {
      this.setData({ rejectConfirming: true });
      return;
    }
    void this.confirmReject();
  },
  async confirmReject() {
    const booking = this.data.booking;
    if (!booking?.precheck || this.data.deciding) return;
    const reasonCodes = this.data.reasons.filter((item) => item.selected).map((item) => item.code);
    const reasonText = this.data.reasonText.trim();
    this.setData({ deciding: true });
    try {
      await api.rejectOperatorPrecheck(booking.id, {
        idempotencyKey: this.data.rejectIdempotencyKey,
        expectedVersion: booking.precheck.version,
        reasonCodes,
        reasonText,
        issuePhotoKinds: this.data.selectedPhotoKinds,
      });
      this.setData({ showReject: false, rejectConfirming: false });
      wx.showToast({ title: "已发送处理清单", icon: "success" });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "处理清单提交失败", icon: "none" });
      this.setData({ rejectConfirming: false });
      await this.load();
    } finally {
      this.setData({ deciding: false });
    }
  },
  noop() {},
});
