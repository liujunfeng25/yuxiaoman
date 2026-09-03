import { api } from "../../services/api";
import { ensureSession } from "../../services/session";
import {
  canUseGetUserProfile,
  isPlaceholderWechatProfile,
  requestWechatProfile,
} from "../../services/owner-wechat-profile";
import type { Booking, BookingStatus, ServiceMode, Vehicle } from "../../types";
import { EMPTY_REPORT_ENTRY, homeReportEntry } from "./home-report";
import type { ReportEntry } from "./home-report";

type InspectionHero = {
  vehicleId: string;
  plate: string;
  vehicleCopy: string;
  vehicleDetail: string;
  vehicleImage: string;
  dueDate: string;
  countdownLabel: string;
  countdownValue: string;
  countdownUnit: string;
  dueLabel: string;
  dueDetail: string;
  conflict: boolean;
  canBookInspection: boolean;
  actionLabel: string;
  tone: "normal" | "urgent" | "overdue" | "review";
};

type Data = {
  vehicle: Vehicle | null;
  hero: InspectionHero | null;
  activeBooking: Booking | null;
  reportEntry: ReportEntry;
  bookingStateReady: boolean;
  serviceFocus: boolean;
  loading: boolean;
  loadError: string;
  entryTarget: "" | ServiceMode | "report";
  showProfileGate: boolean;
  profileGateLoading: boolean;
  profileGateMode: "" | "wechat" | "native";
  profileNickname: string;
  profileAvatarPreview: string;
  profileAvatarTempPath: string;
};

const TERMINAL_BOOKING_STATUSES = new Set<BookingStatus>(["completed", "cancelled", "no_show"]);

function latestActiveBooking(bookings: Booking[], vehicleId: string): Booking | null {
  return bookings
    .filter((item) => item.vehicleId === vehicleId && !TERMINAL_BOOKING_STATUSES.has(item.status))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] || null;
}

function dayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function dueTimestamp(value: string): number | null {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

type InspectionStatus = Awaited<ReturnType<typeof api.inspection>>;

function validitySourceLabel(value: string): string {
  if (value === "traffic_12123") return "交管12123";
  if (value === "electronic_driving_license") return "电子行驶证";
  if (value === "paper_driving_license") return "纸质行驶证";
  return "所选凭证";
}

function confirmationDetail(validity: Extract<NonNullable<Vehicle["inspectionValidity"]>, { mode: "confirmed" }>): string {
  const confirmedOn = validity.confirmedAt ? validity.confirmedAt.slice(0, 10) : "";
  return confirmedOn
    ? `用户于${confirmedOn}根据${validitySourceLabel(validity.source)}确认`
    : `用户根据${validitySourceLabel(validity.source)}确认`;
}

function inspectionHero(vehicle: Vehicle, status: InspectionStatus | null): InspectionHero {
  const validity = vehicle.inspectionValidity;
  const vehicleCopy = vehicle.brand && vehicle.model ? `${vehicle.brand.name} ${vehicle.model.name}` : vehicle.vehicleType;
  const vehicleDetail = `${vehicle.vehicleType} · ${vehicle.seats} 座`;
  const vehicleImage = vehicle.visual?.imageUrl || "/assets/brand/hero-car-generic.png";
  const identity = { vehicleId: vehicle.id, vehicleCopy, vehicleDetail, vehicleImage };
  const confirmed = validity?.mode === "confirmed";
  const comparison = status?.dateEvidence?.comparison;
  const hardConflict = comparison === "conflict";
  const softNote = comparison === "note";
  if (hardConflict && validity?.mode === "confirmed") {
    return {
      ...identity,
      plate: vehicle.plateNumber,
      dueDate: validity.validThroughMonth,
      dueLabel: "您确认的有效期",
      dueDetail: `规则估算 ${status?.dateEvidence?.estimate?.dueDate || "待核验"}`,
      countdownLabel: "日期待核验",
      countdownValue: "!",
      countdownUnit: "",
      conflict: true,
      canBookInspection: false,
      actionLabel: "先核验再预约",
      tone: "review",
    };
  }
  if (!confirmed) {
    const estimatedDueDate = status?.dateEvidence?.estimate?.dueDate || "";
    const estimatedDueAt = estimatedDueDate ? dueTimestamp(estimatedDueDate) : null;
    const estimatedDays = estimatedDueAt === null ? null : Math.ceil((estimatedDueAt - dayStart(new Date())) / 86400000);
    const canBookInspection = status?.canBook === true;
    if (estimatedDueDate) {
      const overdue = estimatedDays !== null && estimatedDays < 0;
      return {
        ...identity,
        plate: vehicle.plateNumber,
        dueDate: estimatedDueDate,
        dueLabel: "预计首次上线约",
        dueDetail: overdue
          ? (canBookInspection ? "办理窗口已过 · 仍可预约上线" : "上线窗口可能已过 · 请先在12123核对")
          : "当前通常无需来站 · 以交管12123为准",
        countdownLabel: overdue ? "预计上线窗口已过" : "距预计上线还有",
        countdownValue: estimatedDays === null ? "--" : String(Math.abs(estimatedDays)),
        countdownUnit: estimatedDays === null ? "" : "天",
        conflict: false,
        canBookInspection,
        actionLabel: canBookInspection ? "选择验车方式" : "查看是否需上线",
        tone: overdue ? "overdue" : estimatedDays !== null && estimatedDays <= 90 ? "urgent" : "normal",
      };
    }
    return {
      ...identity,
      plate: vehicle.plateNumber,
      dueDate: "暂无法估算",
      dueLabel: "车辆资料",
      dueDetail: "请补充登记信息或进入年检查询核对",
      countdownLabel: "暂无法自动估算",
      countdownValue: "--",
      countdownUnit: "",
      conflict: false,
      canBookInspection: false,
      actionLabel: "查看是否需上线",
      tone: "normal",
    };
  }
  const confirmedDueDate = status?.dateEvidence?.confirmation?.validThroughDate || vehicle.inspectionDueDate;
  const canBookInspection = status?.canBook === true;
  const dueAt = dueTimestamp(confirmedDueDate);
  const days = dueAt === null ? null : Math.ceil((dueAt - dayStart(new Date())) / 86400000);
  const claimTip = softNote
    ? "交管可能另有申领节点，以12123为准"
    : "";
  if (days !== null && days < 0) {
    return {
      ...identity,
      plate: vehicle.plateNumber,
      dueDate: confirmedDueDate,
      countdownLabel: "有效期已过",
      countdownValue: String(Math.abs(days)),
      countdownUnit: "天",
      dueLabel: "您确认的有效期止",
      dueDetail: claimTip || confirmationDetail(validity),
      conflict: false,
      canBookInspection: false,
      actionLabel: "先核验再预约",
      tone: "overdue",
    };
  }
  return {
    ...identity,
    plate: vehicle.plateNumber,
    dueDate: confirmedDueDate,
    countdownLabel: days === null ? "检验有效期止" : "距检验有效期止还有",
    countdownValue: days === null ? "--" : String(days),
    countdownUnit: days === null ? "" : "天",
    dueLabel: "您确认的有效期止",
    dueDetail: claimTip || confirmationDetail(validity),
    conflict: false,
    canBookInspection,
    actionLabel: canBookInspection ? "选择验车方式" : "查看是否需上线",
    tone: days !== null && days <= 90 ? "urgent" : "normal",
  };
}

Page<Data>({
  data: {
    vehicle: null,
    hero: null,
    activeBooking: null,
    reportEntry: EMPTY_REPORT_ENTRY,
    bookingStateReady: false,
    serviceFocus: false,
    loading: true,
    loadError: "",
    entryTarget: "",
    showProfileGate: false,
    profileGateLoading: false,
    profileGateMode: "",
    profileNickname: "",
    profileAvatarPreview: "",
    profileAvatarTempPath: "",
  },
  onShow() {
    this.setData({ entryTarget: "" });
    void this.bootstrap();
  },
  async bootstrap() {
    await ensureSession().catch(() => null);
    void this.load();
    void this.prepareProfileGate();
  },
  async prepareProfileGate() {
    try {
      const profile = await api.profile();
      if (profile.profileComplete) return;
      this.setData({
        showProfileGate: true,
        profileGateMode: canUseGetUserProfile() ? "wechat" : "native",
      });
    } catch {
      // Profile sync is best-effort; the home page remains usable.
    }
  },
  async authorizeWechatProfile() {
    if (this.data.profileGateLoading) return;
    this.setData({ profileGateLoading: true });
    try {
      if (this.data.profileGateMode === "native") {
        await this.submitNativeProfile();
        return;
      }
      const wechat = await requestWechatProfile();
      if (isPlaceholderWechatProfile(wechat)) {
        this.setData({ profileGateMode: "native" });
        wx.showToast({ title: "请使用微信头像能力完成授权", icon: "none" });
        return;
      }
      await api.syncWechatProfile(wechat);
      this.setData({ showProfileGate: false, profileGateMode: "" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "授权失败", icon: "none" });
    } finally {
      this.setData({ profileGateLoading: false });
    }
  },
  onGateChooseAvatar(event: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    const tempPath = String(event.detail?.avatarUrl || "").trim();
    if (!tempPath) return;
    this.setData({ profileAvatarPreview: tempPath, profileAvatarTempPath: tempPath });
  },
  onGateNicknameInput(event: WechatMiniprogram.Input) {
    this.setData({ profileNickname: String(event.detail.value || "") });
  },
  async submitNativeProfile() {
    const displayName = this.data.profileNickname.trim();
    const tempPath = this.data.profileAvatarTempPath.trim();
    if (!displayName || !tempPath) {
      wx.showToast({ title: "请授权头像和昵称后继续", icon: "none" });
      return;
    }
    if (this.data.profileGateLoading) return;
    this.setData({ profileGateLoading: true });
    try {
      await api.updateProfile(displayName);
      await api.uploadProfileAvatar(tempPath);
      this.setData({ showProfileGate: false, profileGateMode: "" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "授权失败", icon: "none" });
    } finally {
      this.setData({ profileGateLoading: false });
    }
  },
  async load() {
    this.setData({ loading: true, loadError: "" });
    try {
      const vehicles = await api.vehicles();
      const vehicle = vehicles.find((item) => item.isDefault) || vehicles[0] || null;
      const [bookingState, reportState, status] = await Promise.all([
        api.bookings().then((items) => ({ items, ready: true })).catch(() => ({ items: [] as Booking[], ready: false })),
        api.vehicleCheckupReports({ limit: 1 }).then((page) => ({ page, ready: true })).catch(() => ({ page: null, ready: false })),
        vehicle ? api.inspection(vehicle.id).catch(() => null) : Promise.resolve(null),
      ]);
      this.setData({
        vehicle,
        hero: vehicle ? inspectionHero(vehicle, status) : null,
        activeBooking: vehicle && bookingState.ready ? latestActiveBooking(bookingState.items, vehicle.id) : null,
        reportEntry: homeReportEntry(reportState.page, reportState.ready),
        bookingStateReady: bookingState.ready,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取车辆失败";
      this.setData({ loadError: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  retryLoad() { void this.load(); },
  navigateEntry(url: string, target: ServiceMode | "report") {
    if (this.data.entryTarget) return;
    this.setData({ entryTarget: target });
    wx.navigateTo({ url });
    setTimeout(() => {
      if (this.data.entryTarget === target) this.setData({ entryTarget: "" });
    }, 1500);
  },
  go(event) {
    const url = String(event.currentTarget.dataset.url || "");
    if (!url) return;
    if (["/pages/home/home", "/pages/orders/orders", "/pages/profile/profile"].includes(url)) wx.switchTab({ url });
    else wx.navigateTo({ url });
  },
  book() {
    if (!this.data.vehicle) {
      wx.navigateTo({ url: "/packages/vehicle/pages/vehicle-form/vehicle-form" });
      return;
    }
    if (!this.data.hero?.canBookInspection) {
      wx.navigateTo({ url: "/packages/annual/pages/eligibility/eligibility" });
      return;
    }
    this.setData({ serviceFocus: false }, () => {
      this.setData({ serviceFocus: true });
      (wx as unknown as { pageScrollTo(options: { selector: string; duration: number }): void }).pageScrollTo({
        selector: "#annual-inspection-service",
        duration: 320,
      });
    });
  },
  beginInspection(event) {
    if (this.data.entryTarget) return;
    const mode: ServiceMode = event.currentTarget.dataset.mode === "valet" ? "valet" : "self_drive";
    const vehicle = this.data.vehicle;
    if (!vehicle) {
      this.navigateEntry(`/packages/vehicle/pages/vehicle-form/vehicle-form?next=inspection_booking&serviceMode=${mode}&returnTo=inspection_booking`, mode);
      return;
    }
    if (!this.data.bookingStateReady) {
      wx.showToast({ title: "订单状态未同步，请稍后重试", icon: "none" });
      void this.load();
      return;
    }
    if (this.data.activeBooking) {
      this.navigateEntry(`/packages/annual/pages/order-detail/order-detail?id=${encodeURIComponent(this.data.activeBooking.id)}`, mode);
      return;
    }
    const vehicleId = encodeURIComponent(vehicle.id);
    if (!this.data.hero?.canBookInspection) {
      this.navigateEntry(`/packages/annual/pages/eligibility/eligibility?vehicleId=${vehicleId}&serviceMode=${mode}&returnTo=inspection_booking`, mode);
      return;
    }
    this.navigateEntry(`/packages/annual/pages/stations/stations?serviceMode=${mode}&vehicleId=${vehicleId}&entry=home`, mode);
  },
  openReportCenter() {
    this.navigateEntry("/packages/inspection/pages/checkup-reports/checkup-reports", "report");
  },
  editCurrentVehicle() {
    if (!this.data.vehicle) return;
    wx.navigateTo({ url: `/packages/vehicle/pages/vehicle-form/vehicle-form?id=${encodeURIComponent(this.data.vehicle.id)}` });
  },
  vehicleImageError() {
    if (this.data.hero?.vehicleImage !== "/assets/brand/hero-car-generic.png") {
      this.setData({ "hero.vehicleImage": "/assets/brand/hero-car-generic.png" } as unknown as Partial<Data>);
    }
  },
  showService(event) {
    const service = String(event.currentTarget.dataset.service || "车主服务");
    wx.showModal({
      title: service,
      content: `${service}当前提供统一客服说明演示，正式服务开放后会复用车辆档案，无需重复填写。`,
      confirmText: "我知道了",
      success: () => undefined,
    });
  },
});
