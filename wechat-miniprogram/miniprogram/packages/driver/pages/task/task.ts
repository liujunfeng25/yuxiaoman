import {
  DRIVER_PHOTO_SLOTS,
  DRIVER_STAGE_LABELS,
  canStartReturn,
  driverTaskTerminal,
  driverWritableStage,
  evidenceForStage,
  type DriverEvidencePackage,
  type DriverEvidencePhoto,
  type DriverEvidencePhotoKind,
  type DriverEvidenceStage,
  type DriverTask,
} from "../../model";
import { driverApi, isDriverSessionAccessError } from "../../services/driver-api";
import { clearDriverTaskSession, readDriverTaskSession } from "../../services/driver-session";
import { formatShanghaiDateTime } from "../../../../utils/format";
import { driverWorkflowApi } from "../../services/workflow-api";
import { workflowDueLabel } from "../../../../utils/workflow";
import type { WorkflowTaskSummary } from "../../../../types/workflow";

type PhotoSlotView = {
  kind: DriverEvidencePhotoKind;
  label: string;
  hint: string;
  media: DriverEvidencePhoto | null;
  uploading: boolean;
  stateLabel: string;
};

type EvidencePackageView = DriverEvidencePackage & {
  number: string;
  label: string;
  statusLabel: string;
  statusTone: string;
  photoCountText: string;
  capturedTimeLabel: string;
};

type TaskView = DriverTask & {
  statusLabel: string;
  statusTone: string;
  scheduleLabel: string;
  ownerPhoneDisplay: string;
  receptionistDisplay: string;
  receptionistPhone: string;
  currentTitle: string;
  currentHint: string;
  currentStep: number;
  terminal: boolean;
};

type ViewerItem = { url: string; label: string };

const HANDOFF_ELIGIBLE_STATUSES = new Set(["checked_in", "inspecting", "result_received"]);

type Data = {
  initialized: boolean;
  loading: boolean;
  refreshing: boolean;
  exchanging: boolean;
  acting: boolean;
  error: string;
  bookingId: string;
  task: TaskView | null;
  evidenceViews: EvidencePackageView[];
  activeStage: DriverEvidenceStage | "";
  activeStageLabel: string;
  photoSlots: PhotoSlotView[];
  photoCompleteCount: number;
  canCompleteEvidence: boolean;
  showStartReturn: boolean;
  canStartReturn: boolean;
  showHandoff: boolean;
  handoffVerificationCode: string;
  handoffActing: boolean;
  viewerOpen: boolean;
  viewerItems: ViewerItem[];
  viewerIndex: number;
  viewerUrl: string;
  viewerLabel: string;
  viewerCounter: string;
  viewerHasPrevious: boolean;
  viewerHasNext: boolean;
  workflowSummary: WorkflowTaskSummary;
  workflowNextDueLabel: string;
  workflowLoading: boolean;
};

const STATUS_LABELS: Record<string, string> = {
  confirmed: "待安排司机",
  driver_arranged: "待上门取车",
  picked_up: "已取车，前往检测站",
  checked_in: "车辆已到检测站",
  inspecting: "车辆检测中",
  result_received: "检测结果已回传",
  returning: "车辆送回中",
  completed: "车辆已送达",
  on_hold: "任务已暂缓",
  cancelled: "任务已取消",
  no_show: "任务已终止",
};

function decodeValue(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function taskCodeFromQuery(query: Record<string, string>): string {
  if (query.taskCode) return decodeValue(query.taskCode).trim();
  const scene = decodeValue(query.scene || "").trim();
  if (!scene) return "";
  const match = /(?:^|&)taskCode=([^&]+)/.exec(scene);
  return decodeValue(match?.[1] || scene).trim();
}

function localTime(value: string | null): string {
  return formatShanghaiDateTime(value, "尚未完成留证");
}

function scheduleLabel(task: DriverTask): string {
  return [task.appointmentDate, task.startTime && task.endTime ? `${task.startTime}–${task.endTime}` : task.startTime]
    .filter(Boolean).join(" · ") || "预约时间待同步";
}

function taskStatus(task: DriverTask): string {
  return task.fulfillmentStatus || task.status;
}

function currentCopy(task: DriverTask): { title: string; hint: string; step: number } {
  const status = taskStatus(task);
  if (status === "driver_arranged") return { title: "到达取车点，拍摄车辆现状", hint: "完成 5 张现场照片后，系统自动记录已取车。无需等待车主线上确认。", step: 1 };
  if (status === "picked_up") return { title: "已完成取车留证", hint: "请将车辆送至预约检测站，到站后由检测站完成入站留证。", step: 2 };
  if (status === "checked_in") return { title: "车辆已安全到站", hint: "检测站已完成到站核验，当前等待检测任务推进。", step: 2 };
  if (status === "inspecting") return { title: "车辆正在检测", hint: "检测站正在形成体检报告和检测完成留证，请耐心等待。", step: 3 };
  if (status === "result_received") return { title: "检测完成，准备返程", hint: "确认检测完成留证已生成后，点击开始送回车辆。", step: 3 };
  if (status === "returning") return { title: "车辆已送达，拍摄最终状态", hint: "完成 5 张送回留证后，订单将自动完成，不要求车主线上确认。", step: 4 };
  if (status === "completed") return { title: "本次取送任务已完成", hint: "四个关键节点的留证已同步给车主和运营后台。", step: 4 };
  if (status === "on_hold") return { title: "任务暂缓推进", hint: "请联系运营人员处理当前任务状态，已经上传的照片会继续保留。", step: 1 };
  if (["cancelled", "no_show"].includes(status)) return { title: "任务已经终止", hint: "该任务不能继续操作，历史留证仍按订单规则保存。", step: 1 };
  return { title: "等待运营安排", hint: "任务安排完成后即可进行现场取车留证。", step: 1 };
}

function taskView(task: DriverTask): TaskView {
  const status = taskStatus(task);
  const copy = currentCopy(task);
  const receptionistName = task.driverAssignment?.receptionistName || "";
  const receptionistPhone = task.driverAssignment?.receptionistPhone || "";
  return {
    ...task,
    events: task.events.map((event) => ({ ...event, createdAt: formatShanghaiDateTime(event.createdAt) })),
    statusLabel: STATUS_LABELS[status] || status || "状态待同步",
    statusTone: ["completed"].includes(status) ? "success" : ["cancelled", "no_show", "on_hold"].includes(status) ? "warning" : "active",
    scheduleLabel: scheduleLabel(task),
    ownerPhoneDisplay: task.owner.contactPhone || task.owner.contactPhoneMasked || "联系电话待同步",
    receptionistDisplay: receptionistName && receptionistPhone
      ? `${receptionistName} · ${receptionistPhone}`
      : receptionistName || receptionistPhone || "接待人待同步",
    receptionistPhone,
    currentTitle: copy.title,
    currentHint: copy.hint,
    currentStep: copy.step,
    terminal: driverTaskTerminal(task),
  };
}

function evidenceViews(task: DriverTask): EvidencePackageView[] {
  return task.evidencePackages.map((item, index) => ({
    ...item,
    number: String(index + 1).padStart(2, "0"),
    label: DRIVER_STAGE_LABELS[item.stage],
    statusLabel: item.status === "completed" ? "留证已完成" : item.photos.length ? "留证拍摄中" : "等待留证",
    statusTone: item.status === "completed" ? "complete" : item.photos.length ? "progress" : "pending",
    photoCountText: `${item.photos.length}/5 张`,
    capturedTimeLabel: localTime(item.capturedAt),
  }));
}

function photoSlotViews(task: DriverTask, stage: DriverEvidenceStage | "", uploadingKinds: string[] = []): PhotoSlotView[] {
  const evidence = stage ? evidenceForStage(task, stage) : null;
  return DRIVER_PHOTO_SLOTS.map((slot) => {
    const media = evidence?.photos.find((photo) => photo.kind === slot.kind) || null;
    const uploading = uploadingKinds.includes(slot.kind);
    return {
      ...slot,
      media,
      uploading,
      stateLabel: uploading ? "上传中" : media ? "已保存" : "待拍摄",
    };
  });
}

function idempotencyStorageKey(action: string, bookingId: string): string {
  return `yuxiaoman.driverTaskAction:${bookingId}:${action}`;
}

function requestKey(action: string, bookingId: string): string {
  const storageKey = idempotencyStorageKey(action, bookingId);
  const existing = String(wx.getStorageSync<unknown>(storageKey) || "").trim();
  if (existing) return existing;
  const created = `driver-${action}-${bookingId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  wx.setStorageSync(storageKey, created);
  return created;
}

function clearRequestKey(action: string, bookingId: string): void {
  wx.removeStorageSync(idempotencyStorageKey(action, bookingId));
}

function clearCompletedRequestKeys(task: DriverTask): void {
  if (evidenceForStage(task, "owner_pickup").status === "completed") {
    clearRequestKey("complete-owner_pickup", task.bookingId);
  }
  if (evidenceForStage(task, "owner_return").status === "completed") {
    clearRequestKey("complete-owner_return", task.bookingId);
  }
  if (["returning", "completed"].includes(taskStatus(task))) {
    clearRequestKey("start-return", task.bookingId);
  }
}

function returnDriverBound(task: DriverTask): boolean {
  return Boolean(task.driverAssignment?.returnDriverPhone);
}

function isPickupDriver(task: DriverTask): boolean {
  // 送车司机绑定前，当前会话仍是取车代驾（绑定后原会话会被吊销）。
  return Boolean(task.driverAssignment) && !returnDriverBound(task);
}

function canShowHandoff(task: DriverTask): boolean {
  if (driverTaskTerminal(task) || !isPickupDriver(task) || returnDriverBound(task)) return false;
  return HANDOFF_ELIGIBLE_STATUSES.has(taskStatus(task));
}

Page<Data>({
  data: {
    initialized: false,
    loading: true,
    refreshing: false,
    exchanging: false,
    acting: false,
    error: "",
    bookingId: "",
    task: null,
    evidenceViews: [],
    activeStage: "",
    activeStageLabel: "",
    photoSlots: [],
    photoCompleteCount: 0,
    canCompleteEvidence: false,
    showStartReturn: false,
    canStartReturn: false,
    showHandoff: false,
    handoffVerificationCode: "",
    handoffActing: false,
    viewerOpen: false,
    viewerItems: [],
    viewerIndex: 0,
    viewerUrl: "",
    viewerLabel: "",
    viewerCounter: "0 / 0",
    viewerHasPrevious: false,
    viewerHasNext: false,
    workflowSummary: { openCount: 0, dueSoonCount: 0, overdueCount: 0, nextDueAt: null },
    workflowNextDueLabel: "",
    workflowLoading: false,
  },

  async onLoad(query) {
    await this.initialize(query);
  },

  onShow() {
    if (this.data.initialized && this.data.bookingId && !this.data.loading && !this.data.acting) {
      void this.loadTask(false);
      void this.loadWorkflowSummary();
    }
  },

  async onPullDownRefresh() {
    this.setData({ refreshing: true });
    await Promise.all([this.loadTask(false), this.loadWorkflowSummary()]);
    this.setData({ refreshing: false });
    wx.stopPullDownRefresh();
  },

  async initialize(query: Record<string, string>) {
    const taskCode = taskCodeFromQuery(query);
    this.setData({ loading: true, exchanging: Boolean(taskCode), error: "" });
    try {
      const session = taskCode ? await driverApi.exchange(taskCode) : readDriverTaskSession();
      const queryBookingId = String(query.bookingId || "").trim();
      if (!session) {
        this.setData({ initialized: true, loading: false, exchanging: false });
        wx.redirectTo({ url: "/packages/driver/pages/login/login?reason=session" });
        return;
      }
      if (queryBookingId && queryBookingId !== session.bookingId) throw new Error("任务入口与预约信息不一致");
      this.setData({ bookingId: session.bookingId, initialized: true, exchanging: false });
      await Promise.all([this.loadTask(false), this.loadWorkflowSummary()]);
    } catch (error) {
      this.setData({
        initialized: true,
        loading: false,
        exchanging: false,
        error: error instanceof Error ? error.message : "无法打开代驾任务",
      });
    }
  },

  async loadTask(showLoading = true) {
    if (!this.data.bookingId) return;
    if (showLoading || !this.data.task) this.setData({ loading: true });
    try {
      const task = await driverApi.task(this.data.bookingId);
      this.applyTask(task);
    } catch (error) {
      if (isDriverSessionAccessError(error)) {
        clearDriverTaskSession();
        wx.redirectTo({ url: "/packages/driver/pages/login/login?reason=session" });
        return;
      }
      this.setData({ error: error instanceof Error ? error.message : "读取代驾任务失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadWorkflowSummary() {
    if (!this.data.bookingId) return;
    this.setData({ workflowLoading: true });
    try {
      const summary = await driverWorkflowApi.summary(this.data.bookingId);
      const urgency = summary.overdueCount > 0 ? "overdue" : summary.dueSoonCount > 0 ? "attention" : "normal";
      this.setData({ workflowSummary: summary, workflowNextDueLabel: workflowDueLabel(summary.nextDueAt, urgency) });
    } catch {
      // 时限摘要失败不影响司机继续拍照和推进当前任务。
    } finally {
      this.setData({ workflowLoading: false });
    }
  },

  openWorkflowTasks() {
    if (!this.data.bookingId || this.data.workflowLoading) return;
    void this.loadWorkflowSummary();
  },

  retryTask() {
    if (this.data.bookingId && !this.data.loading && !this.data.acting) void this.loadTask(true);
  },

  enterCodeLogin() {
    clearDriverTaskSession();
    wx.redirectTo({ url: "/packages/driver/pages/login/login" });
  },

  applyTask(task: DriverTask, uploadingKinds: string[] = []) {
    clearCompletedRequestKeys(task);
    const activeStage = driverWritableStage(task) || "";
    const slots = photoSlotViews(task, activeStage, uploadingKinds);
    const photoCompleteCount = slots.filter((slot) => Boolean(slot.media)).length;
    const status = taskStatus(task);
    const showHandoff = canShowHandoff(task);
    this.setData({
      task: taskView(task),
      evidenceViews: evidenceViews(task),
      activeStage,
      activeStageLabel: activeStage ? DRIVER_STAGE_LABELS[activeStage] : "",
      photoSlots: slots,
      photoCompleteCount,
      canCompleteEvidence: Boolean(activeStage) && photoCompleteCount === DRIVER_PHOTO_SLOTS.length && !uploadingKinds.length,
      showStartReturn: status === "result_received",
      canStartReturn: canStartReturn(task),
      showHandoff,
      handoffVerificationCode: showHandoff ? this.data.handoffVerificationCode : "",
      error: "",
    });
  },

  choosePhoto(event) {
    const kind = String(event.currentTarget.dataset.kind || "") as DriverEvidencePhotoKind;
    const stage = this.data.activeStage;
    if (!kind || !stage || this.data.acting) return;
    const slot = this.data.photoSlots.find((item) => item.kind === kind);
    if (slot?.uploading) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      success: ({ tempFiles }) => {
        const filePath = tempFiles[0]?.tempFilePath;
        if (filePath) void this.uploadPhoto(stage, kind, filePath);
      },
    });
  },

  async uploadPhoto(stage: DriverEvidenceStage, kind: DriverEvidencePhotoKind, filePath: string) {
    const task = this.data.task;
    if (!task) return;
    const uploadingKinds = this.data.photoSlots.filter((slot) => slot.uploading).map((slot) => slot.kind);
    if (uploadingKinds.includes(kind)) return;
    this.setData({
      photoSlots: this.data.photoSlots.map((slot) => slot.kind === kind ? { ...slot, uploading: true, stateLabel: "上传中" } : slot),
      canCompleteEvidence: false,
    });
    try {
      await driverApi.uploadEvidencePhoto(task.bookingId, stage, kind, filePath);
      const updated = await driverApi.task(task.bookingId);
      this.applyTask(updated);
      wx.showToast({ title: "现场照片已保存", icon: "success" });
    } catch (error) {
      this.setData({
        photoSlots: this.data.photoSlots.map((slot) => slot.kind === kind ? { ...slot, uploading: false, stateLabel: slot.media ? "已保存" : "上传失败，请重试" } : slot),
      });
      wx.showToast({ title: error instanceof Error ? error.message : "照片上传失败", icon: "none" });
    }
  },

  deletePhoto(event) {
    const mediaId = String(event.currentTarget.dataset.id || "");
    const stage = this.data.activeStage;
    if (!mediaId || !stage || this.data.acting) return;
    wx.showModal({
      title: "删除这张留证照片？",
      content: "只删除当前位置的照片，其他已上传照片不会受到影响。",
      confirmText: "删除",
      confirmColor: "#d84646",
      success: ({ confirm }) => { if (confirm) void this.performDeletePhoto(stage, mediaId); },
    });
  },

  async performDeletePhoto(stage: DriverEvidenceStage, mediaId: string) {
    const task = this.data.task;
    if (!task) return;
    this.setData({ acting: true });
    try {
      await driverApi.deleteEvidencePhoto(task.bookingId, stage, mediaId);
      const updated = await driverApi.task(task.bookingId);
      this.applyTask(updated);
      wx.showToast({ title: "照片已删除", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "删除失败", icon: "none" });
    } finally {
      this.setData({ acting: false });
    }
  },

  completeEvidence() {
    const task = this.data.task;
    const stage = this.data.activeStage;
    if (!task || !stage || !this.data.canCompleteEvidence || this.data.acting) return;
    void this.performCompleteEvidence(stage);
  },

  async performCompleteEvidence(stage: DriverEvidenceStage) {
    const task = this.data.task;
    if (!task) return;
    const action = `complete-${stage}`;
    const idempotencyKey = requestKey(action, task.bookingId);
    this.setData({ acting: true });
    try {
      const updated = await driverApi.completeEvidence(task.bookingId, stage, idempotencyKey);
      clearRequestKey(action, task.bookingId);
      this.applyTask(updated);
      wx.showToast({ title: stage === "owner_return" ? "车辆送回已留证" : "取车留证已完成", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "留证提交失败", icon: "none" });
    } finally {
      this.setData({ acting: false });
    }
  },

  async startReturn() {
    const task = this.data.task;
    if (!task || !this.data.canStartReturn || this.data.acting) return;
    const action = "start-return";
    const idempotencyKey = requestKey(action, task.bookingId);
    this.setData({ acting: true });
    try {
      const updated = await driverApi.startReturn(task.bookingId, idempotencyKey);
      clearRequestKey(action, task.bookingId);
      this.applyTask(updated);
      wx.showToast({ title: "已开始送回车辆", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "暂时无法开始返程", icon: "none" });
    } finally {
      this.setData({ acting: false });
    }
  },

  requestHandoff() {
    const task = this.data.task;
    if (!task || !this.data.showHandoff || this.data.acting || this.data.handoffActing) return;
    wx.showModal({
      title: "确认换人？",
      content: "将生成新的送车验证码。接班司机输入新码后，你将无法再操作本单。",
      confirmText: "确认换人",
      cancelText: "取消",
      success: ({ confirm }) => {
        if (!confirm) return;
        void this.performCreateHandoffCode();
      },
    });
  },

  async performCreateHandoffCode() {
    const task = this.data.task;
    if (!task || !this.data.showHandoff || this.data.acting || this.data.handoffActing) return;
    this.setData({ handoffActing: true });
    try {
      const { handoffVerificationCode } = await driverApi.createHandoffCode(task.bookingId);
      this.setData({ handoffVerificationCode });
      wx.showToast({ title: "换班码已生成", icon: "success" });
    } catch (error) {
      if (isDriverSessionAccessError(error)) {
        clearDriverTaskSession();
        wx.redirectTo({ url: "/packages/driver/pages/login/login?reason=session" });
        return;
      }
      wx.showToast({ title: error instanceof Error ? error.message : "换班码生成失败", icon: "none" });
    } finally {
      this.setData({ handoffActing: false });
    }
  },

  copyHandoffCode() {
    const code = this.data.handoffVerificationCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: "换班码已复制", icon: "success" }),
    });
  },

  navigate(event) {
    const targetName = String(event.currentTarget.dataset.target || "");
    const target = targetName === "pickup" ? this.data.task?.pickupAddress : this.data.task?.station;
    if (!target || !target.latitude || !target.longitude) {
      wx.showToast({ title: "当前地点缺少可导航坐标", icon: "none" });
      return;
    }
    wx.openLocation({
      latitude: target.latitude,
      longitude: target.longitude,
      name: (target as { name?: string }).name || target.title,
      address: target.address,
      scale: 16,
    });
  },

  callOwner() {
    const phone = this.data.task?.owner.contactPhone || "";
    if (!phone) {
      wx.showToast({ title: "当前任务未提供可拨打电话", icon: "none" });
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone });
  },

  callReceptionist() {
    const phone = this.data.task?.receptionistPhone || "";
    if (!phone) {
      wx.showToast({ title: "当前任务未提供接待人电话", icon: "none" });
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone });
  },

  previewEvidence(event) {
    const stage = String(event.currentTarget.dataset.stage || "") as DriverEvidenceStage;
    const current = String(event.currentTarget.dataset.url || "");
    const evidence = this.data.task?.evidencePackages.find((item) => item.stage === stage);
    if (!evidence) return;
    const items = evidence.photos.filter((photo) => photo.url).map((photo) => ({
      url: photo.url,
      label: `${DRIVER_STAGE_LABELS[stage]} · ${DRIVER_PHOTO_SLOTS.find((slot) => slot.kind === photo.kind)?.label || "现场照片"}`,
    }));
    this.openViewer(items, current);
  },

  previewActivePhoto(event) {
    const current = String(event.currentTarget.dataset.url || "");
    const stage = this.data.activeStage;
    if (!stage) return;
    const items = this.data.photoSlots.filter((slot) => slot.media?.url).map((slot) => ({ url: slot.media!.url, label: `${DRIVER_STAGE_LABELS[stage]} · ${slot.label}` }));
    this.openViewer(items, current);
  },

  openViewer(items: ViewerItem[], current: string) {
    if (!items.length) return;
    const index = Math.max(0, items.findIndex((item) => item.url === current));
    this.applyViewerIndex(items, index);
  },

  applyViewerIndex(items: ViewerItem[], index: number) {
    if (!items.length) return;
    const safeIndex = Math.max(0, Math.min(items.length - 1, index));
    this.setData({
      viewerOpen: true,
      viewerItems: items,
      viewerIndex: safeIndex,
      viewerUrl: items[safeIndex].url,
      viewerLabel: items[safeIndex].label,
      viewerCounter: `${safeIndex + 1} / ${items.length}`,
      viewerHasPrevious: safeIndex > 0,
      viewerHasNext: safeIndex < items.length - 1,
    });
  },

  previousViewerImage() {
    if (this.data.viewerHasPrevious) this.applyViewerIndex(this.data.viewerItems, this.data.viewerIndex - 1);
  },

  nextViewerImage() {
    if (this.data.viewerHasNext) this.applyViewerIndex(this.data.viewerItems, this.data.viewerIndex + 1);
  },

  closeViewer() { this.setData({ viewerOpen: false }); },
  blockViewerTouch() { return; },
});
