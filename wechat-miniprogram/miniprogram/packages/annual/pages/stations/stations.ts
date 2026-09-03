import { api } from "../../../../services/api";
import { clearBookingDraft, getBookingDraft, patchBookingDraft, saveBookingDraft } from "../../../../services/storage";
import type { BookingDraft, PickupAddress, ServiceMode, Station } from "../../../../types";
import { stationDistance } from "../../../../utils/format";
import { stationEntryState } from "./entry-state";

type Data = {
  mode: ServiceMode;
  stations: Station[];
  suggestions: PickupAddress[];
  originText: string;
  hasOrigin: boolean;
  loading: boolean;
  locating: boolean;
  searching: boolean;
  searchQuery: string;
  searchBoxVisible: boolean;
  searchError: string;
  stationError: string;
  canSelectStation: boolean;
  stationDistance: typeof stationDistance;
};

function getLocation(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => wx.getLocation({
    type: "gcj02",
    success: resolve,
    fail: (error) => reject(new Error(String(error?.errMsg || "getLocation:fail"))),
  }));
}

function isLocationPermissionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("auth deny")
    || normalized.includes("authorize")
    || normalized.includes("permission")
    || normalized.includes("requiredprivateinfos");
}

function promptLocationPermission(fallback: string) {
  wx.showModal({
    title: "需要位置权限",
    content: "请在设置中允许使用位置信息，以便获取当前位置或地图选点。",
    confirmText: "去设置",
    cancelText: "稍后",
    success: (result) => {
      if (result.confirm) wx.openSetting({});
      else wx.showToast({ title: fallback, icon: "none" });
    },
  });
}

Page<Data>({
  data: {
    mode: "self_drive", stations: [], suggestions: [], originText: "尚未确定起点", hasOrigin: false,
    loading: false, locating: false, searching: false, searchQuery: "", searchBoxVisible: true, searchError: "", stationError: "", canSelectStation: true, stationDistance,
  },
  searchSequence: 0,
  initialLocationAttempted: false,
  onLoad(query) {
    const entry = stationEntryState(query, getBookingDraft());
    if (entry.replace) {
      clearBookingDraft();
      saveBookingDraft(entry.draft);
    }
    this.setData({ mode: entry.mode, canSelectStation: entry.mode === "self_drive" });
  },
  onShow() {
    const draft = this.currentDraft();
    if (!draft.origin && !this.initialLocationAttempted) {
      this.initialLocationAttempted = true;
      void this.locateCurrentOrigin();
      return;
    }
    void this.loadStations();
  },
  currentDraft(): BookingDraft { return getBookingDraft() || { serviceMode: this.data.mode }; },
  async loadStations() {
    const draft = this.currentDraft(); const origin = draft.origin;
    const canSelectStation = this.data.mode === "self_drive" || Boolean(draft.pickupAddress?.locationProof);
    this.setData({
      loading: true,
      stationError: "",
      hasOrigin: canSelectStation && Boolean(origin),
      canSelectStation,
      originText: draft.pickupAddress ? `${draft.pickupAddress.title} · ${draft.pickupAddress.address}` : origin ? "已使用当前位置计算路线" : "尚未确定起点",
    });
    try {
      const stations = await api.stations({ originLat: origin?.latitude, originLng: origin?.longitude, originType: origin?.type });
      this.setData({ stations, stationError: "" });
    } catch (error) {
      const stationError = error instanceof Error ? error.message : "读取检测站失败，请稍后重试";
      this.setData({ stations: [], stationError });
      wx.showToast({ title: "检测站读取失败", icon: "none" });
    }
    finally { this.setData({ loading: false }); }
  },
  retryStations() { if (!this.data.loading) void this.loadStations(); },
  locate() { void this.locateCurrentOrigin(); },
  async locateCurrentOrigin() {
    this.setData({ locating: true });
    try {
      const location = await getLocation();
      if (this.data.mode === "valet") {
        const pickupAddress = await api.resolveLocation(location);
        if (!pickupAddress.locationProof) throw new Error("地址校验凭证缺失，请重新选择");
        patchBookingDraft({ serviceMode: "valet", pickupAddress, origin: { latitude: pickupAddress.latitude, longitude: pickupAddress.longitude, type: "valet" }, station: undefined, slot: undefined });
      } else {
        patchBookingDraft({ serviceMode: "self_drive", origin: { ...location, type: "self_drive" }, pickupAddress: undefined, station: undefined, slot: undefined });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (isLocationPermissionError(message)) {
        promptLocationPermission(this.data.mode === "valet" ? "未确认取车地址，请搜索或地图选点" : "未获取定位，可稍后重试");
      } else {
        wx.showToast({ title: this.data.mode === "valet" ? "未确认取车地址，请搜索或地图选点" : "未获取定位，可稍后重试", icon: "none" });
      }
    } finally {
      this.setData({ locating: false });
      await this.loadStations();
    }
  },
  search(event) {
    const detail = event && event.detail;
    const raw = detail && typeof detail === "object" ? detail.value : detail;
    if (raw == null) return;
    const searchQuery = String(raw);
    if (searchQuery === "undefined") return;
    this.setData({ searchQuery, searchError: "" });
    void this.fetchSuggestions(searchQuery);
  },
  async fetchSuggestions(rawQuery: string) {
    const query = String(rawQuery || "").trim();
    const sequence = Number(this.searchSequence || 0) + 1;
    this.searchSequence = sequence;
    if (query.length < 2) {
      if (this.searchSequence === sequence) this.setData({ suggestions: [], searching: false });
      return;
    }
    this.setData({ searching: true });
    try {
      const suggestions = await api.suggestions(query);
      if (this.searchSequence === sequence) this.setData({ suggestions, searchError: "" });
    } catch {
      if (this.searchSequence === sequence) this.setData({ suggestions: [], searchError: "地点搜索失败，请稍后重试或使用地图选点。" });
    } finally {
      if (this.searchSequence === sequence) this.setData({ searching: false });
    }
  },
  resetSearchBox() {
    this.setData({ searchBoxVisible: false, searchQuery: "", suggestions: [], searchError: "", searching: false });
    setTimeout(() => this.setData({ searchBoxVisible: true }), 0);
  },
  async selectSuggestion(event) {
    const index = Number(event.currentTarget.dataset.index); const pickupAddress = this.data.suggestions[index]; if (!pickupAddress) return;
    this.searchSequence = Number(this.searchSequence || 0) + 1;
    patchBookingDraft({ serviceMode: "valet", pickupAddress, origin: { latitude: pickupAddress.latitude, longitude: pickupAddress.longitude, type: "valet" }, station: undefined, slot: undefined });
    this.resetSearchBox();
    await this.loadStations();
  },
  chooseOnMap() {
    wx.chooseLocation({
      success: async (location) => {
        this.setData({ locating: true });
        try {
          const pickupAddress = await api.resolveLocation({
            latitude: location.latitude,
            longitude: location.longitude,
            name: location.name || undefined,
            address: location.address || undefined,
          });
          if (!pickupAddress.locationProof) throw new Error("地址校验凭证缺失，请重新选择");
          patchBookingDraft({
            serviceMode: "valet",
            pickupAddress,
            origin: { latitude: pickupAddress.latitude, longitude: pickupAddress.longitude, type: "valet" },
            station: undefined,
            slot: undefined,
          });
          await this.loadStations();
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "地图地址校验失败，请重试", icon: "none" });
        } finally {
          this.setData({ locating: false });
        }
      },
      fail: (error) => {
        const message = String(error?.errMsg || "");
        if (message.includes("cancel")) return;
        if (isLocationPermissionError(message) || message.includes("privacy")) {
          promptLocationPermission("地图选点需先开通位置权限和隐私声明");
          return;
        }
        // 常见：隐私协议未声明「收集你选择的位置信息」、接口未开通、模拟器不支持
        const short = message.includes("privacy agreement")
          ? "后台未声明地图选点隐私"
          : message.includes("requiredPrivateInfos")
            ? "请重新编译小程序后再试"
            : message.includes("auth deny")
              ? "请允许使用位置信息"
              : "地图选点不可用，请用上方搜索";
        wx.showToast({ title: short, icon: "none", duration: 3000 });
      },
    });
  },
  selectStation(event) {
    const draft = this.currentDraft();
    if (this.data.mode === "valet" && !draft.pickupAddress?.locationProof) {
      wx.showToast({ title: "请先获取或选择取车地址", icon: "none" });
      return;
    }
    const station = this.data.stations.find((item) => item.id === event.currentTarget.dataset.id);
    if (!station) return;
    patchBookingDraft({ station, slot: undefined });
    wx.navigateTo({ url: `/packages/annual/pages/slots/slots?stationId=${station.id}` });
  },
});
