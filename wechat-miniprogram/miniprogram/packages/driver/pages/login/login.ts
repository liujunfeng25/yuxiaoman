import {
  driverVerificationCodeGroups,
  driverVerificationCodeReady,
  normalizeDriverVerificationCode,
} from "../../login-model";
import type { DriverTask } from "../../model";
import { driverApi, isDriverSessionAccessError } from "../../services/driver-api";
import { clearDriverTaskSession, readDriverTaskSession } from "../../services/driver-session";

type CachedTaskView = {
  bookingId: string;
  plateNumber: string;
  displayName: string;
  bookingNumber: string;
  statusLabel: string;
};

type Data = {
  checkingSession: boolean;
  cachedTask: CachedTaskView | null;
  sessionError: string;
  notice: string;
  verificationCode: string;
  codeLeftDisplay: string;
  codeRightDisplay: string;
  codeFocused: boolean;
  codeReady: boolean;
  submitting: boolean;
  error: string;
};

const STATUS_LABELS: Record<string, string> = {
  driver_arranged: "待上门取车",
  picked_up: "已取车，前往检测站",
  checked_in: "车辆已到检测站",
  inspecting: "车辆检测中",
  result_received: "检测结果已回传",
  returning: "车辆送回中",
  completed: "服务已完成",
  on_hold: "任务已暂缓",
  cancelled: "任务已取消",
  no_show: "任务已终止",
};

function taskView(task: DriverTask): CachedTaskView {
  const status = task.fulfillmentStatus || task.status;
  return {
    bookingId: task.bookingId,
    plateNumber: task.vehicle.plateNumber,
    displayName: task.vehicle.displayName,
    bookingNumber: task.bookingNumber || "预约编号待同步",
    statusLabel: STATUS_LABELS[status] || status || "状态待同步",
  };
}

Page<Data>({
  data: {
    checkingSession: true,
    cachedTask: null,
    sessionError: "",
    notice: "",
    verificationCode: "",
    codeLeftDisplay: "· · ·",
    codeRightDisplay: "· · ·",
    codeFocused: false,
    codeReady: false,
    submitting: false,
    error: "",
  },

  onLoad(query) {
    const notice = query.reason === "session"
      ? "上一个任务凭证已失效，请输入后台新生成的验证码。"
      : "";
    this.setData({ notice });
    void this.checkCachedTask();
  },

  async checkCachedTask() {
    const session = readDriverTaskSession();
    if (!session) {
      this.setData({ checkingSession: false, cachedTask: null, sessionError: "" });
      return;
    }
    this.setData({ checkingSession: true, sessionError: "" });
    try {
      const task = await driverApi.taskSummary(session.bookingId);
      this.setData({ cachedTask: taskView(task), checkingSession: false });
    } catch (error) {
      if (isDriverSessionAccessError(error)) {
        clearDriverTaskSession();
        this.setData({
          cachedTask: null,
          checkingSession: false,
          notice: "上一个任务凭证已失效，请输入后台新生成的验证码。",
          sessionError: "",
        });
        return;
      }
      this.setData({
        cachedTask: null,
        checkingSession: false,
        sessionError: error instanceof Error ? error.message : "暂时无法核验上次任务",
      });
    }
  },

  inputCode(event) {
    const verificationCode = normalizeDriverVerificationCode(event.detail.value);
    const [codeLeftDisplay, codeRightDisplay] = driverVerificationCodeGroups(verificationCode);
    this.setData({
      verificationCode,
      codeLeftDisplay,
      codeRightDisplay,
      codeReady: driverVerificationCodeReady(verificationCode),
      error: "",
    });
    return verificationCode;
  },

  focusCode() { this.setData({ codeFocused: true }); },
  blurCode() { this.setData({ codeFocused: false }); },

  async submit() {
    if (this.data.submitting) return;
    if (!driverVerificationCodeReady(this.data.verificationCode)) {
      this.setData({ error: "请输入后台生成的 6 位数字验证码" });
      return;
    }
    this.setData({ submitting: true, error: "", sessionError: "" });
    try {
      const session = await driverApi.exchangeVerificationCode(this.data.verificationCode);
      wx.redirectTo({ url: `/packages/driver/pages/task/task?bookingId=${encodeURIComponent(session.bookingId)}` });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "验证码校验失败，请稍后重试" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  continueTask() {
    const bookingId = this.data.cachedTask?.bookingId;
    if (!bookingId) return;
    wx.redirectTo({ url: `/packages/driver/pages/task/task?bookingId=${encodeURIComponent(bookingId)}` });
  },

  switchTask() {
    clearDriverTaskSession();
    const [codeLeftDisplay, codeRightDisplay] = driverVerificationCodeGroups("");
    this.setData({
      cachedTask: null,
      sessionError: "",
      notice: "请输入后台为新订单生成的验证码。",
      verificationCode: "",
      codeLeftDisplay,
      codeRightDisplay,
      codeReady: false,
      error: "",
    });
  },

  retrySession() { void this.checkCachedTask(); },

  backStaff() {
    wx.redirectTo({ url: "/packages/operator/pages/staff-entry/staff-entry" });
  },
});
