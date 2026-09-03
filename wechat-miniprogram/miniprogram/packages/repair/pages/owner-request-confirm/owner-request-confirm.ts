import { api } from "../../../../services/api";
import { localizeOwnerMedia } from "../../../../services/owner-media";
import type { Booking, CheckupMedia, VehicleCheckupReport, VehicleFault } from "../../../../types";
import {
  defaultFaultSelection,
  faultTypeLabel,
  regionLabel,
  severityLabel,
  severityTone,
  viewLabel,
} from "../../utils/owner-repair";

type FaultView = VehicleFault & {
  number: number;
  title: string;
  locationText: string;
  severityText: string;
  severityTone: "minor" | "moderate" | "severe";
  descriptionText: string;
  photos: CheckupMedia[];
  selected: true;
};

type Data = {
  bookingId: string;
  reportId: string;
  booking: Booking | null;
  report: VehicleCheckupReport | null;
  loading: boolean;
  publishing: boolean;
  error: string;
  consented: boolean;
  consentError: boolean;
  plateText: string;
  vehicleText: string;
  reportNoText: string;
  faultViews: FaultView[];
  selectedFaultIds: string[];
  photoCount: number;
  allPhotoUrls: string[];
};

function vehicleDisplayName(booking: Booking): string {
  const vehicle = booking.vehicle;
  if (!vehicle) return "已登记车辆";
  const model = [vehicle.brand?.name, vehicle.model?.name].filter(Boolean).join(" ");
  return model || vehicle.vehicleType || "已登记车辆";
}

function faultPhotos(report: VehicleCheckupReport, fault: VehicleFault): CheckupMedia[] {
  const direct = fault.photos || [];
  if (direct.length) return direct;
  return (report.media || []).filter((media) => media.kind === "fault_closeup" && media.faultId === fault.id);
}

Page<Data>({
  data: {
    bookingId: "",
    reportId: "",
    booking: null,
    report: null,
    loading: true,
    publishing: false,
    error: "",
    consented: false,
    consentError: false,
    plateText: "车辆信息未提供",
    vehicleText: "已登记车辆",
    reportNoText: "平台检测报告",
    faultViews: [],
    selectedFaultIds: [],
    photoCount: 0,
    allPhotoUrls: [],
  },

  onLoad(query) {
    this.setData({
      bookingId: query.bookingId || query.id || "",
      reportId: query.reportId || "",
    });
  },

  onShow() {
    if (!this.data.booking && !this.data.publishing) void this.load();
  },

  async resolveBookingId(): Promise<string> {
    if (this.data.bookingId) return this.data.bookingId;
    if (!this.data.reportId) return "";
    const page = await api.vehicleCheckupReports({ limit: 50 });
    return page.items.find((item) => item.reportId === this.data.reportId)?.bookingId || "";
  },

  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const bookingId = await this.resolveBookingId();
      if (!bookingId) throw new Error("缺少检测报告信息，请从车辆体检报告进入");
      const booking = await api.booking(bookingId);
      const report = booking.vehicleCheckupReport;
      if (!report || report.status !== "published" || !report.id) throw new Error("检测报告尚未正式发布，暂不能发起维修询价");
      if (this.data.reportId && report.id !== this.data.reportId) throw new Error("检测报告与当前订单不匹配，请返回报告后重试");
      if (!report.faults?.length) throw new Error("该检测报告未记录可用于维修询价的车损");

      const faultViews = report.faults.map((fault, index) => {
        const photos = faultPhotos(report, fault);
        return {
          ...fault,
          number: index + 1,
          title: `${regionLabel(fault.regionCode)} · ${faultTypeLabel(fault.faultType)}`,
          locationText: `${viewLabel(fault.viewId)}定位`,
          severityText: severityLabel(fault.severity),
          severityTone: severityTone(fault.severity),
          descriptionText: fault.description || "检测站未填写补充描述",
          photos,
          selected: true as const,
        };
      });
      const allPhotoUrls = faultViews.flatMap((fault) => fault.photos.map((photo) => photo.url)).filter(Boolean);
      this.setData({
        bookingId,
        reportId: report.id,
        booking,
        report,
        plateText: booking.vehicle?.plateNumber || "车辆信息未提供",
        vehicleText: vehicleDisplayName(booking),
        reportNoText: report.reportNo || "平台检测报告",
        faultViews,
        selectedFaultIds: defaultFaultSelection(report.faults),
        photoCount: allPhotoUrls.length,
        allPhotoUrls,
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "读取维修询价资料失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onConsentChange(event) {
    const values = Array.isArray(event.detail?.value) ? event.detail.value : [];
    const consented = values.includes("share-report-damage");
    this.setData({ consented, consentError: !consented && this.data.consentError });
  },

  previewPhoto(event) {
    const current = String(event.currentTarget.dataset.url || "");
    if (!current || !this.data.allPhotoUrls.length) return;
    wx.previewImage({ current, urls: this.data.allPhotoUrls });
  },

  async recoverPrivatePhoto(mediaId: string, sourceUrl: string) {
    if (!mediaId || !sourceUrl) return;
    try {
      const url = await localizeOwnerMedia(sourceUrl, { forceRefresh: true });
      const faultViews = this.data.faultViews.map((fault) => ({
        ...fault,
        photos: fault.photos.map((photo) => photo.id === mediaId
          ? { ...photo, url, sourceUrl, loadState: "ready" as const }
          : photo),
      }));
      this.setData({
        faultViews,
        allPhotoUrls: faultViews.flatMap((fault) => fault.photos.map((photo) => photo.url)).filter(Boolean),
      });
    } catch {
      wx.showToast({ title: "照片重新读取失败，请稍后重试", icon: "none" });
    }
  },

  handlePhotoTap(event) {
    const current = String(event.currentTarget.dataset.url || "");
    if (current) {
      this.previewPhoto(event);
      return;
    }
    void this.recoverPrivatePhoto(
      String(event.currentTarget.dataset.mediaId || ""),
      String(event.currentTarget.dataset.sourceUrl || ""),
    );
  },

  handlePrivatePhotoError(event) {
    void this.recoverPrivatePhoto(
      String(event.currentTarget.dataset.mediaId || ""),
      String(event.currentTarget.dataset.sourceUrl || ""),
    );
  },

  async publishRequest() {
    if (this.data.publishing) return;
    if (!this.data.consented) {
      this.setData({ consentError: true });
      wx.showToast({ title: "请先勾选资料共享授权", icon: "none" });
      return;
    }
    if (!this.data.reportId || this.data.selectedFaultIds.length !== this.data.faultViews.length) {
      wx.showToast({ title: "询价资料尚未准备完整", icon: "none" });
      return;
    }
    this.setData({ publishing: true, error: "" });
    try {
      const request = await api.createRepairRequest(this.data.reportId);
      wx.showToast({ title: "维修询价已发布", icon: "success" });
      wx.redirectTo({ url: `/packages/repair/pages/owner-request-detail/owner-request-detail?id=${encodeURIComponent(request.id)}` });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "维修询价发布失败，请重试" });
    } finally {
      this.setData({ publishing: false });
    }
  },

  retry() { void this.load(); },
  goBack() { wx.navigateBack(); },
});
