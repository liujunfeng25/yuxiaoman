import { api } from "../../../../services/api";
import { ensureOperatorPageAccess } from "../../../../services/operator-session";
import type { Booking, BookingEvent, BookingMedia, ValetEvidenceMedia, ValetEvidenceMediaKind, ValetEvidencePackage } from "../../../../types";
import { formatShanghaiDateTime } from "../../../../utils/format";

type MediaView = BookingMedia & { label: string };
type BookingView = Booking & {
  media: MediaView[];
  events: BookingEvent[];
  plateNumber: string;
  vehicleTypeLabel: string;
  vehicleUsageLabel: string;
  contactPhoneMasked: string;
  appointmentDateLabel: string;
  verificationTimeLabel: string;
  serviceModeLabel: string;
  navigationLabel: string;
  inspectionResultLabel: string;
};
type ProcessStep = { key: string; label: string; stateLabel: string; state: "done" | "active" | "pending"; iconPath: string };
type VerificationRow = { key: string; label: string; copy: string; passed: boolean; iconPath: string };
type ArrivalEvidenceSlot = { kind: ValetEvidenceMediaKind; label: string; hint: string; photo: ValetEvidenceMedia | null };
type ArrivalEvidenceView = Omit<ValetEvidencePackage, "photos"> & { slots: ArrivalEvidenceSlot[]; uploadedCount: number; completed: boolean };
type Data = {
  id: string;
  booking: BookingView | null;
  processSteps: ProcessStep[];
  verificationRows: VerificationRow[];
  mediaUrls: string[];
  loading: boolean;
  acting: boolean;
  actingAction: string;
  arrivalEvidence: ArrivalEvidenceView | null;
  arrivalUploadingKind: string;
  arrivalCompleting: boolean;
  accessReady: boolean;
  loadError: string;
};

const arrivalSlotDefinitions: Array<Pick<ArrivalEvidenceSlot, "kind" | "label" | "hint">> = [
  { kind: "front_left", label: "左前", hint: "车头与左侧车身" },
  { kind: "front_right", label: "右前", hint: "车头与右侧车身" },
  { kind: "rear_left", label: "左后", hint: "车尾与左侧车身" },
  { kind: "rear_right", label: "右后", hint: "车尾与右侧车身" },
  { kind: "dashboard_started", label: "启动后仪表盘", hint: "车辆启动后的完整仪表" },
];

function maskPhone(phone: string): string {
  if (!phone) return "联系方式待补充";
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function appointmentDateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[2]}-${match[3]}` : date;
}

function verifiedTime(value: string | null | undefined): string {
  if (!value) return "待确认";
  return formatShanghaiDateTime(value, "待确认").slice(11, 16);
}

function mediaLabel(kind: BookingMedia["kind"]): string {
  const labels: Partial<Record<BookingMedia["kind"], string>> = {
    license_front: "行驶证正面",
    license_back: "行驶证反面",
    vehicle_front_left: "车头左侧",
    vehicle_front_right: "车头右侧",
    vehicle_rear_left: "车尾左侧",
    vehicle_rear_right: "车尾右侧",
    dashboard_started: "启动后仪表盘",
  };
  return labels[kind] || "预约资料";
}

function inspectionResultLabel(booking: Booking): string {
  const conclusion = booking.inspectionResult?.conclusion;
  if (conclusion === "passed") return "本次检验结论：通过";
  if (conclusion === "failed") return "本次检验结论：未通过";
  if (booking.inspectionResult?.conclusionStatus === "legacy_requires_reentry") return "历史结果待重新录入：正式结论尚未确认";
  return "";
}

function currentStepIndex(status: Booking["status"]): number {
  if (["driver_arranged", "picked_up", "awaiting_arrival", "on_hold"].includes(status)) return 1;
  if (["checked_in", "inspecting"].includes(status)) return 2;
  if (["result_received", "returning"].includes(status)) return 3;
  // A completed service has no active step left: every node in the five-step
  // timeline must be rendered as completed to agree with the overall status.
  if (status === "completed") return 5;
  return 0;
}

function processSteps(status: Booking["status"]): ProcessStep[] {
  const activeIndex = currentStepIndex(status);
  const steps = [
    ["confirmed", "预约确认", "/assets/icons/calendar-check.png"],
    ["checked_in", "到站核验", "/assets/icons/user-circle.png"],
    ["inspecting", "交接检测", "/assets/icons/car.png"],
    ["result_received", "结果回传", "/assets/icons/file-arrow-up.png"],
    ["completed", "服务完成", "/assets/icons/shield-check.png"],
  ];
  return steps.map(([key, label, iconPath], index) => ({
    key,
    label,
    iconPath,
    state: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending",
    stateLabel: index < activeIndex ? "已完成" : index === activeIndex ? "进行中" : "待进行",
  }));
}

function verificationRows(booking: Booking): VerificationRow[] {
  const verification = booking.verification;
  return [
    { key: "plate", label: "车牌核对", copy: `实车车牌与预约信息一致：${booking.vehicle?.plateNumber || "待核对"}`, passed: Boolean(verification?.plateMatched), iconPath: "/assets/icons/car-profile.png" },
    { key: "materials", label: "资料准备", copy: "身份证、行驶证、交强险已准备齐全", passed: Boolean(verification?.materialsReady), iconPath: "/assets/icons/file-arrow-up.png" },
    { key: "exterior", label: "车辆外观与识别", copy: "进行四角及 VIN 识别核对", passed: Boolean(verification?.exteriorRecorded), iconPath: "/assets/icons/camera.png" },
    { key: "condition", label: "车辆状态", copy: "无明显改装、破损及异常情况", passed: Boolean(verification?.vehicleConditionConfirmed), iconPath: "/assets/icons/shield-check.png" },
  ];
}

function arrivalEvidenceView(booking: Booking): ArrivalEvidenceView | null {
  if (booking.serviceMode !== "valet" || booking.evidencePolicyVersion !== "valet-handoff-v1") return null;
  const evidence = (booking.evidencePackages || []).find((item) => item.stage === "station_arrival");
  if (!evidence) return null;
  const photos = evidence.photos || [];
  return {
    ...evidence,
    capturedAt: evidence.capturedAt ? formatShanghaiDateTime(evidence.capturedAt) : null,
    slots: arrivalSlotDefinitions.map((definition) => ({ ...definition, photo: photos.find((photo) => photo.kind === definition.kind) || null })),
    uploadedCount: photos.length,
    completed: evidence.status === "completed",
  };
}

function viewState(booking: Booking): Pick<Data, "booking" | "processSteps" | "verificationRows" | "mediaUrls" | "arrivalEvidence"> {
  const media = (booking.media || []).map((item) => ({ ...item, label: mediaLabel(item.kind) }));
  return {
    booking: {
      ...booking,
      media,
      events: (booking.events || []).map((event) => ({ ...event, createdAt: formatShanghaiDateTime(event.createdAt) })),
      plateNumber: booking.vehicle?.plateNumber || "车牌待确认",
      vehicleTypeLabel: booking.vehicle?.vehicleType || "车辆类型待确认",
      vehicleUsageLabel: booking.vehicle?.usageNature || "使用性质待确认",
      contactPhoneMasked: maskPhone(booking.contactPhone),
      appointmentDateLabel: appointmentDateLabel(booking.appointmentDate),
      verificationTimeLabel: verifiedTime(booking.verification?.verifiedAt),
      serviceModeLabel: booking.serviceMode === "valet" ? "上门取送车" : "自驾到站",
      navigationLabel: booking.pickupAddress ? "打开取车点导航" : "打开检测站导航",
      inspectionResultLabel: inspectionResultLabel(booking),
    },
    processSteps: processSteps(booking.status),
    verificationRows: verificationRows(booking),
    mediaUrls: media.map((item) => item.url),
    arrivalEvidence: arrivalEvidenceView(booking),
  };
}

Page<Data>({
  data: {
    id: "", booking: null, processSteps: [], verificationRows: [], mediaUrls: [], loading: true, acting: false, actingAction: "",
    arrivalEvidence: null, arrivalUploadingKind: "", arrivalCompleting: false,
    accessReady: false, loadError: "",
  },
  onLoad(query) {
    const id = query.id || "";
    if (!id) {
      this.setData({ id: "", loading: false, loadError: "请从检测任务列表重新进入。" });
      return;
    }
    const returnUrl = `/packages/operator/pages/operator-detail/operator-detail?id=${encodeURIComponent(id)}`;
    const accessReady = ensureOperatorPageAccess(returnUrl);
    this.setData({ id, accessReady, loading: accessReady });
  },
  onShow() { if (this.data.id && this.data.accessReady) void this.load(); },
  async load() {
    this.setData({ loading: true, loadError: "" });
    try {
      const booking = await api.operatorBooking(this.data.id);
      this.setData({ ...viewState(booking), loadError: "" });
    } catch (error) {
      if (!ensureOperatorPageAccess(`/packages/operator/pages/operator-detail/operator-detail?id=${encodeURIComponent(this.data.id)}`)) return;
      const loadError = error instanceof Error ? error.message : "读取任务失败，请稍后重试";
      this.setData({ booking: null, loadError });
      wx.showToast({ title: "任务读取失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  retry() { if (this.data.id && !this.data.loading) void this.load(); },
  goTasks() { wx.redirectTo({ url: "/packages/operator/pages/operator/operator" }); },
  navigate() {
    const target = this.data.booking?.pickupAddress || this.data.booking?.station;
    if (!target) return;
    wx.openLocation({ latitude: target.latitude, longitude: target.longitude, name: "name" in target ? target.name : target.title, address: target.address, scale: 16 });
  },
  preview(event) {
    const url = event.currentTarget.dataset.url as string;
    wx.previewImage({ current: url, urls: this.data.mediaUrls });
  },
  previewArrivalEvidence(event) {
    const current = String(event.currentTarget.dataset.url || "");
    const urls = (this.data.arrivalEvidence?.slots || []).map((item) => item.photo?.url || "").filter(Boolean);
    if (current && urls.length) wx.previewImage({ current, urls });
  },
  chooseArrivalEvidence(event) {
    const kind = String(event.currentTarget.dataset.kind || "") as ValetEvidenceMediaKind;
    const booking = this.data.booking;
    if (!booking || !kind || this.data.arrivalUploadingKind || this.data.arrivalCompleting || this.data.arrivalEvidence?.completed) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      success: async ({ tempFiles }) => {
        const file = tempFiles[0];
        if (!file) return;
        this.setData({ arrivalUploadingKind: kind });
        try {
          await api.operatorStationEvidenceUpload(booking.id, kind, file.tempFilePath);
          await this.load();
          wx.showToast({ title: "留证已上传", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "上传失败", icon: "none" });
        } finally {
          this.setData({ arrivalUploadingKind: "" });
        }
      },
    });
  },
  async completeArrivalEvidence() {
    const booking = this.data.booking;
    const evidence = this.data.arrivalEvidence;
    if (!booking || !evidence || evidence.completed || evidence.uploadedCount !== 5 || this.data.arrivalCompleting) return;
    const idempotencyKey = this.arrivalCompletionBookingId === booking.id && this.arrivalCompletionKey
      ? this.arrivalCompletionKey
      : `station-arrival-${booking.id}-${Date.now()}`;
    this.arrivalCompletionBookingId = booking.id;
    this.arrivalCompletionKey = idempotencyKey;
    this.setData({ arrivalCompleting: true });
    try {
      const updated = await api.operatorStationEvidenceComplete(booking.id, idempotencyKey, {
        plateMatched: true,
        materialsReady: true,
        exteriorRecorded: true,
        vehicleConditionConfirmed: true,
      });
      this.arrivalCompletionKey = "";
      this.setData(viewState(updated));
      wx.showToast({ title: "到站留证完成", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "提交失败", icon: "none" });
    } finally {
      this.setData({ arrivalCompleting: false });
    }
  },
  openCheckupEditor() {
    if (!this.data.booking) return;
    wx.navigateTo({ url: `/packages/inspection/pages/checkup-editor/checkup-editor?id=${encodeURIComponent(this.data.booking.id)}` });
  },
  openCheckupReport() {
    if (!this.data.booking) return;
    wx.navigateTo({ url: `/packages/inspection/pages/checkup-report/checkup-report?id=${encodeURIComponent(this.data.booking.id)}&mode=operator` });
  },
  async action(event) {
    const action = event.currentTarget.dataset.action as string;
    const booking = this.data.booking;
    if (!booking || this.data.acting) return;
    this.setData({ acting: true, actingAction: action });
    try {
      let updated: Booking;
      if (action === "simulate") updated = await api.simulateResult(booking.id);
      else if (action === "check-in") updated = await api.operatorAction(booking.id, action, { plateMatched: true, materialsReady: true, exteriorRecorded: true, vehicleConditionConfirmed: true });
      else if (action === "hold") updated = await api.operatorAction(booking.id, action, { reasonCode: "other", note: "检测端演示挂起，等待异常处理" });
      else if (action === "resolve-hold") updated = await api.operatorAction(booking.id, action, { notes: "检测端已完成复核" });
      else updated = await api.operatorAction(booking.id, action);
      this.setData(viewState(updated));
      wx.showToast({ title: "状态已更新", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" });
    } finally {
      this.setData({ acting: false, actingAction: "" });
    }
  },
});
