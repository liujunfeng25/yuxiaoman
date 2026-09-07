import { api } from "../../../../services/api";
import { getWashDraft, patchWashDraft } from "../../../../services/storage";
import type { ServiceMode, Vehicle, WashStore } from "../../../../types";
import { today } from "../../../../utils/format";
import {
  buildWashStoreCard,
  washStoreFallbackCover,
  washAvailabilityDates,
  washEarliestSlotLabel,
  type WashStoreCard,
} from "../../utils/wash-store-picker";
import { washVehicleCategory, washVehicleCategoryLabel } from "../../utils/wash-vehicle-category";

type Origin = { latitude: number; longitude: number };

type Data = {
  vehicle: Vehicle | null;
  vehicleCategoryLabel: string;
  serviceMode: ServiceMode;
  selectedStoreId: string;
  stores: WashStoreCard[];
  originLat: number | null;
  originLng: number | null;
  originTitle: string;
  originDescription: string;
  loading: boolean;
  locating: boolean;
  error: string;
};

function getLocation(): Promise<Origin> {
  return new Promise((resolve, reject) => wx.getLocation({ type: "gcj02", success: resolve, fail: reject }));
}

Page<Data>({
  data: {
    vehicle: null,
    vehicleCategoryLabel: "小轿车",
    serviceMode: "self_drive",
    selectedStoreId: "",
    stores: [],
    originLat: null,
    originLng: null,
    originTitle: "自驾起点",
    originDescription: "尚未定位，门店先按后台推荐顺序展示",
    loading: true,
    locating: false,
    error: "",
  },

  onLoad(query) {
    this.fromPrecheck = query.fromPrecheck === "1";
    void this.bootstrap();
  },
  onPullDownRefresh() { void this.load(true); },
  onUnload() { this.loadSequence = Number(this.loadSequence || 0) + 1; },

  async bootstrap() {
    const draft = getWashDraft() || {};
    const serviceMode: ServiceMode = draft.serviceMode === "valet" ? "valet" : "self_drive";
    const origin = this.currentOrigin(serviceMode);
    // 自驾进入页时自动定位，与检测站列表一致；失败仍展示推荐顺序门店。
    if (serviceMode === "self_drive" && !origin && !this.initialLocationAttempted) {
      this.initialLocationAttempted = true;
      await this.locate();
      if (this.data.originLat === null) await this.load();
      return;
    }
    await this.load();
  },

  currentOrigin(serviceMode: ServiceMode, explicitOrigin?: Origin): Origin | null {
    const draft = getWashDraft() || {};
    if (serviceMode === "valet" && draft.pickupAddress) {
      return { latitude: draft.pickupAddress.latitude, longitude: draft.pickupAddress.longitude };
    }
    if (explicitOrigin) return explicitOrigin;
    if (draft.selfDriveOrigin?.type === "self_drive") {
      return { latitude: draft.selfDriveOrigin.latitude, longitude: draft.selfDriveOrigin.longitude };
    }
    if (this.data.originLat !== null && this.data.originLng !== null) {
      return { latitude: this.data.originLat, longitude: this.data.originLng };
    }
    return null;
  },

  originCopy(serviceMode: ServiceMode, origin: Origin | null): { title: string; description: string } {
    const draft = getWashDraft() || {};
    if (serviceMode === "valet") {
      return draft.pickupAddress
        ? { title: "代驾取车点", description: `${draft.pickupAddress.title} · ${draft.pickupAddress.address}` }
        : { title: "代驾取车点", description: "请先在预约页选择取车地址，再计算门店距离" };
    }
    return origin
      ? { title: "自驾起点", description: "已使用当前位置进行门店距离估算" }
      : { title: "自驾起点", description: "尚未定位，门店先按后台推荐顺序展示" };
  },

  async load(fromPullDown = false, explicitOrigin?: Origin) {
    const sequence = Number(this.loadSequence || 0) + 1;
    this.loadSequence = sequence;
    const draft = getWashDraft() || {};
    const serviceMode: ServiceMode = draft.serviceMode === "valet" ? "valet" : "self_drive";
    const origin = this.currentOrigin(serviceMode, explicitOrigin);
    const originCopy = this.originCopy(serviceMode, origin);
    this.setData({
      serviceMode,
      selectedStoreId: draft.storeId || "",
      originLat: origin?.latitude ?? null,
      originLng: origin?.longitude ?? null,
      originTitle: originCopy.title,
      originDescription: originCopy.description,
      loading: true,
      error: "",
    });
    try {
      const [vehicles, stores] = await Promise.all([
        api.vehicles(),
        api.washStores(origin ? { originLat: origin.latitude, originLng: origin.longitude } : {}),
      ]);
      if (this.loadSequence !== sequence) return;
      const vehicle = vehicles.find((item) => item.id === draft.vehicleId) || vehicles.find((item) => item.isDefault) || vehicles[0] || null;
      if (!vehicle) throw new Error("请先添加车辆，再选择洗车门店");
      const activeStores = stores.filter((item) => item.isActive !== false);
      const category = washVehicleCategory(vehicle);
      const packageResults = await Promise.all(activeStores.map(async (store) => {
        try {
          const packages = (await api.washPackages(store.id, category)).filter((item) => item.isActive !== false);
          return { store, packages, priceError: "" };
        } catch {
          return { store, packages: [], priceError: "价格读取失败" };
        }
      }));
      if (this.loadSequence !== sequence) return;
      const cards = packageResults.map(({ store, packages, priceError }, index) => {
        const card = buildWashStoreCard(store, packages, washStoreFallbackCover(index));
        return {
          ...card,
          priceError,
          earliestLabel: priceError ? "价格恢复后再查询" : card.earliestLabel,
          earliestLoading: priceError ? false : card.earliestLoading,
        };
      });
      this.setData({ vehicle, vehicleCategoryLabel: washVehicleCategoryLabel(vehicle), stores: cards, loading: false });
      void Promise.all(cards.map((card) => this.loadEarliestAvailability(sequence, card)));
    } catch (error) {
      if (this.loadSequence === sequence) {
        this.setData({ loading: false, error: error instanceof Error ? error.message : "洗车门店暂时无法读取" });
      }
    } finally {
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  async loadEarliestAvailability(sequence: number, card: WashStoreCard) {
    if (!card.startingPackageId) return;
    const baseDate = today();
    const dates = washAvailabilityDates(baseDate, 5);
    let successfulRequest = false;
    for (const date of dates) {
      try {
        const slots = await api.washSlots(card.id, date, card.startingPackageId);
        successfulRequest = true;
        if (this.loadSequence !== sequence) return;
        const first = slots
          .filter((item) => item.remaining > 0)
          .sort((left, right) => left.startTime.localeCompare(right.startTime))[0];
        if (first) {
          this.updateStoreCard(card.id, {
            earliestLabel: washEarliestSlotLabel(baseDate, date, first.startTime, card.startingPackageName),
            earliestLoading: false,
          });
          return;
        }
      } catch {
        // Continue across the short visible booking window. A single failed
        // date must not make the store look unavailable.
      }
    }
    if (this.loadSequence !== sequence) return;
    this.updateStoreCard(card.id, {
      earliestLabel: successfulRequest ? "未来 5 天暂未放出可约时段" : "可约时间请进入预约页查看",
      earliestLoading: false,
    });
  },

  async retryStorePrice(event) {
    const storeId = String(event.currentTarget.dataset.id || "");
    const card = this.data.stores.find((item) => item.id === storeId);
    const vehicle = this.data.vehicle;
    if (!card || !vehicle || card.priceLoading) return;
    const sequence = this.loadSequence;
    this.updateStoreCard(storeId, { priceLoading: true, priceError: "", earliestLoading: false, earliestLabel: "等待价格后查询" });
    try {
      const packages = (await api.washPackages(storeId, washVehicleCategory(vehicle))).filter((item) => item.isActive !== false);
      if (this.loadSequence !== sequence) return;
      const pricing = buildWashStoreCard(card, packages, card.coverSrc);
      const patch = {
        currentVehiclePriceFen: pricing.currentVehiclePriceFen,
        startingPackageId: pricing.startingPackageId,
        startingPackageName: pricing.startingPackageName,
        hasCurrentVehicleOffer: pricing.hasCurrentVehicleOffer,
        earliestLabel: pricing.earliestLabel,
        earliestLoading: pricing.earliestLoading,
        priceError: "",
        priceLoading: false,
      };
      this.updateStoreCard(storeId, patch);
      if (pricing.hasCurrentVehicleOffer) void this.loadEarliestAvailability(sequence, { ...card, ...patch });
    } catch {
      if (this.loadSequence === sequence) {
        this.updateStoreCard(storeId, { priceLoading: false, priceError: "价格读取失败", earliestLoading: false, earliestLabel: "价格恢复后再查询" });
      }
    }
  },

  updateStoreCard(storeId: string, patch: Partial<WashStoreCard>) {
    this.setData({
      stores: this.data.stores.map((item) => item.id === storeId ? { ...item, ...patch } : item),
    });
  },

  async locate() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    try {
      const origin = await getLocation();
      patchWashDraft({ selfDriveOrigin: { ...origin, type: "self_drive" } });
      await this.load(false, origin);
    } catch {
      wx.showToast({ title: "未获取定位，可继续按门店信息选择", icon: "none" });
    } finally {
      this.setData({ locating: false });
    }
  },

  async toggleDetails(event) {
    const storeId = String(event.currentTarget.dataset.id || "");
    const card = this.data.stores.find((item) => item.id === storeId);
    if (!card) return;
    const detailsExpanded = !card.detailsExpanded;
    this.updateStoreCard(storeId, { detailsExpanded });
    if (!detailsExpanded || card.detailLoaded || card.detailLoading) return;
    this.updateStoreCard(storeId, { detailLoading: true });
    const sequence = this.loadSequence;
    const origin = this.data.originLat !== null && this.data.originLng !== null
      ? { originLat: this.data.originLat, originLng: this.data.originLng }
      : {};
    try {
      const detail = await api.washStore(storeId, origin);
      if (this.loadSequence !== sequence) return;
      const latest = this.data.stores.find((item) => item.id === storeId);
      if (!latest) return;
      const hydrated = buildWashStoreCard({
        ...latest,
        ...detail,
        distanceKm: detail.distanceKm ?? latest.distanceKm,
        distanceSource: detail.distanceSource ?? latest.distanceSource,
        distanceBasis: detail.distanceBasis ?? latest.distanceBasis,
      } as WashStore, [], latest.coverSrc);
      this.updateStoreCard(storeId, {
        ...hydrated,
        currentVehiclePriceFen: latest.currentVehiclePriceFen,
        startingPackageId: latest.startingPackageId,
        startingPackageName: latest.startingPackageName,
        hasCurrentVehicleOffer: latest.hasCurrentVehicleOffer,
        priceError: latest.priceError,
        priceLoading: latest.priceLoading,
        earliestLabel: latest.earliestLabel,
        earliestLoading: latest.earliestLoading,
        detailsExpanded: latest.detailsExpanded,
        detailLoading: false,
        detailLoaded: true,
      });
    } catch {
      // The list response already contains every public detail. Keep that
      // useful fallback if a detail refresh is temporarily unavailable.
      if (this.loadSequence === sequence) this.updateStoreCard(storeId, { detailLoading: false, detailLoaded: true });
    }
  },

  selectStore(event) {
    const storeId = String(event.currentTarget.dataset.id || "");
    const store = this.data.stores.find((item) => item.id === storeId);
    if (!store || store.priceError || store.priceLoading || !store.hasCurrentVehicleOffer) return;
    patchWashDraft({ storeId, packageId: undefined, slotId: undefined });
    if (this.fromPrecheck) wx.redirectTo({ url: "/packages/wash/pages/wash-booking/wash-booking" });
    else wx.navigateBack();
  },

  previewImage(event) {
    const storeId = String(event.currentTarget.dataset.id || "");
    const current = String(event.currentTarget.dataset.url || "");
    const store = this.data.stores.find((item) => item.id === storeId);
    if (!store) return;
    const urls = store.gallerySources.length ? store.gallerySources : [store.coverSrc];
    wx.previewImage({ current: current || urls[0], urls });
  },

  coverError(event) {
    const storeId = String(event.currentTarget.dataset.id || "");
    const index = this.data.stores.findIndex((item) => item.id === storeId);
    const store = this.data.stores[index];
    if (!store || store.usesFallbackCover) return;
    const fallback = washStoreFallbackCover(index);
    this.updateStoreCard(storeId, {
      coverSrc: fallback,
      gallerySources: Array.from(new Set(store.gallerySources.map((url) => url === store.coverSrc ? fallback : url))),
      usesFallbackCover: true,
    });
  },

  galleryError(event) {
    const storeId = String(event.currentTarget.dataset.id || "");
    const failedUrl = String(event.currentTarget.dataset.url || "");
    const index = this.data.stores.findIndex((item) => item.id === storeId);
    const store = this.data.stores[index];
    if (!store || !failedUrl) return;
    const fallback = washStoreFallbackCover(index);
    this.updateStoreCard(storeId, {
      gallerySources: Array.from(new Set(store.gallerySources.map((url) => url === failedUrl ? fallback : url))),
      ...(store.coverSrc === failedUrl ? { coverSrc: fallback, usesFallbackCover: true } : {}),
    });
  },

  callStore(event) {
    const store = this.data.stores.find((item) => item.id === String(event.currentTarget.dataset.id || ""));
    if (store?.phone) wx.makePhoneCall({ phoneNumber: store.phone });
  },

  openStoreLocation(event) {
    const store = this.data.stores.find((item) => item.id === String(event.currentTarget.dataset.id || ""));
    if (!store || store.latitude === null || store.latitude === undefined || store.longitude === null || store.longitude === undefined) return;
    wx.openLocation({ latitude: store.latitude, longitude: store.longitude, name: store.name, address: store.address, scale: 16 });
  },

  retry() { void this.load(); },
});
