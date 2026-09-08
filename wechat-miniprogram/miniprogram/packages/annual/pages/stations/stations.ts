import { api } from "../../../../services/api";
import { clearBookingDraft, getBookingDraft, patchBookingDraft, saveBookingDraft } from "../../../../services/storage";
import type { BookingDraft, PickupAddress, ServiceMode, Station } from "../../../../types";
import { stationDistance } from "../../../../utils/format";
import { stationEntryState } from "./entry-state";

type StationCard = Station & {
  displayFeeFen: number;
  feeFromVehicle: boolean;
};

type Data = {
  mode: ServiceMode;
  stations: StationCard[];
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
  quotingFees: boolean;
  feeHint: string;
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

/** Matches server stationOriginQuerySchema Tianjin demo bounds. */
function isWithinServiceArea(latitude: number, longitude: number): boolean {
  return latitude >= 38.4 && latitude <= 40.3 && longitude >= 116.6 && longitude <= 118.2;
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

function toStationCard(station: Station, displayFeeFen = station.serviceFeeFen, feeFromVehicle = false): StationCard {
  return { ...station, displayFeeFen, feeFromVehicle };
}

function toStation(card: StationCard): Station {
  const { displayFeeFen: _displayFeeFen, feeFromVehicle: _feeFromVehicle, ...station } = card;
  return station;
}

Page<Data>({
  data: {
    mode: "self_drive", stations: [], suggestions: [], originText: "尚未确定起点", hasOrigin: false,
    loading: false, locating: false, searching: false, searchQuery: "", searchBoxVisible: true, searchError: "", stationError: "", canSelectStation: true,
    quotingFees: false,
    feeHint: "参考价为站点挂牌价；选定站点后会按车辆重新核算",
    stationDistance,
  },
  searchSequence: 0,
  feeSequence: 0,
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
    const draft = this.currentDraft();
    let origin = draft.origin;
    // 开发者工具默认常是北京坐标（如 116.39），会触发服务端 INVALID_ORIGIN。
    if (origin && !isWithinServiceArea(origin.latitude, origin.longitude)) {
      patchBookingDraft({ origin: undefined });
      origin = undefined;
      wx.showToast({ title: "当前位置不在天津服务范围", icon: "none" });
    }
    const canSelectStation = this.data.mode === "self_drive" || Boolean(draft.pickupAddress?.locationProof);
    this.setData({
      loading: true,
      stationError: "",
      hasOrigin: canSelectStation && Boolean(origin),
      canSelectStation,
      originText: draft.pickupAddress ? `${draft.pickupAddress.title} · ${draft.pickupAddress.address}` : origin ? "已使用当前位置计算路线" : "尚未确定起点",
      feeHint: draft.vehicleId
        ? "正在按当前车辆核算各站年检参考价…"
        : "参考价为站点挂牌价；选定站点后会按车辆重新核算",
    });
    try {
      const stations = (await api.stations({ originLat: origin?.latitude, originLng: origin?.longitude, originType: origin?.type }))
        .map((item) => toStationCard(item));
      this.setData({ stations, stationError: "" });
      void this.loadVehicleFees(stations, draft);
    } catch (error) {
      const stationError = error instanceof Error ? error.message : "读取检测站失败，请稍后重试";
      this.setData({ stations: [], stationError });
      wx.showToast({ title: "检测站读取失败", icon: "none" });
    }
    finally { this.setData({ loading: false }); }
  },
  async loadVehicleFees(stations: StationCard[], draft: BookingDraft) {
    const vehicleId = draft.vehicleId || "";
    if (!vehicleId || !stations.length) {
      this.setData({
        quotingFees: false,
        feeHint: vehicleId
          ? "暂无可报价检测站"
          : "参考价为站点挂牌价；选定站点后会按车辆重新核算",
      });
      return;
    }
    const sequence = Number(this.feeSequence || 0) + 1;
    this.feeSequence = sequence;
    this.setData({ quotingFees: true, feeHint: "正在按当前车辆核算各站年检参考价…" });
    const quoted = await Promise.all(stations.map(async (station) => {
      try {
        const quote = await api.quote({
          vehicleId,
          stationId: station.id,
          serviceMode: draft.serviceMode || this.data.mode,
          pickupAddress: draft.pickupAddress,
          originLat: draft.origin?.latitude,
          originLng: draft.origin?.longitude,
          originType: draft.origin?.type,
        });
        return toStationCard(station, quote.inspectionFeeFen, true);
      } catch {
        return toStationCard(station, station.serviceFeeFen, false);
      }
    }));
    if (this.feeSequence !== sequence) return;
    const fromVehicle = quoted.some((item) => item.feeFromVehicle);
    this.setData({
      stations: quoted,
      quotingFees: false,
      feeHint: fromVehicle
        ? "已按当前车辆核算年检参考价；代驾等费用在确认预约页显示"
        : "车辆报价暂不可用，以下为站点挂牌参考价",
    });
  },
  retryStations() { if (!this.data.loading && !this.data.quotingFees) void this.loadStations(); },
  locate() { void this.locateCurrentOrigin(); },
  async locateCurrentOrigin() {
    this.setData({ locating: true });
    try {
      const location = await getLocation();
      if (!isWithinServiceArea(location.latitude, location.longitude)) {
        throw new Error("当前位置不在天津服务范围，请在开发者工具把模拟定位改到天津后再试");
      }
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
        wx.showToast({
          title: message || (this.data.mode === "valet" ? "未确认取车地址，请搜索或地图选点" : "未获取定位，可稍后重试"),
          icon: "none",
        });
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
    const card = this.data.stations.find((item) => item.id === event.currentTarget.dataset.id);
    if (!card) return;
    patchBookingDraft({ station: toStation(card), slot: undefined });
    wx.navigateTo({ url: `/packages/annual/pages/slots/slots?stationId=${card.id}` });
  },
});
