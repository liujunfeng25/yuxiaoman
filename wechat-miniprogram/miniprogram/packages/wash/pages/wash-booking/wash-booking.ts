import { api } from "../../../../services/api";
import { clearWashDraft, getRecentContact, getWashDraft, patchWashDraft, storeRecentContact } from "../../../../services/storage";
import type { PickupAddress, ServiceMode, Vehicle, WashPackage, WashQuote, WashSlot, WashStore } from "../../../../types";
import { today } from "../../../../utils/format";
import { washVehicleCategory, washVehicleCategoryLabel } from "../../utils/wash-vehicle-category";
import { isWashCatalogSelectionCurrent, nextWashCatalogSelection, type WashCatalogSelection } from "../../utils/wash-catalog-selection";
import { washStoreFallbackCover } from "../../utils/wash-store-picker";

type DateOption = { date: string; label: string; caption: string };

type Data = {
  vehicles: Vehicle[];
  vehicleIndex: number;
  selectedVehicle: Vehicle | null;
  selectedVehicleCategoryLabel: string;
  stores: WashStore[];
  storeIndex: number;
  selectedStore: WashStore | null;
  selectedStoreCoverUrl: string;
  packages: WashPackage[];
  selectedPackageId: string;
  selectedPackage: WashPackage | null;
  dateOptions: DateOption[];
  selectedDate: string;
  slots: WashSlot[];
  selectedSlotId: string;
  selectedSlot: WashSlot | null;
  serviceMode: ServiceMode;
  pickupAddress: PickupAddress | null;
  addressQuery: string;
  suggestions: PickupAddress[];
  addressLoading: boolean;
  mapResolving: boolean;
  quote: WashQuote | null;
  quoteLoading: boolean;
  quoteError: string;
  quoteErrorCode: string;
  quoteBlocked: boolean;
  contactName: string;
  contactPhone: string;
  notes: string;
  loading: boolean;
  submitting: boolean;
  error: string;
};

function addDays(date: string, amount: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function dateOptions(): DateOption[] {
  const base = today();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return Array.from({ length: 5 }, (_, index) => {
    const date = addDays(base, index);
    const [, month, day] = date.split("-").map(Number);
    return {
      date,
      label: index === 0 ? "今天" : index === 1 ? "明天" : weekdays[new Date(`${date}T00:00:00+08:00`).getDay()],
      caption: `${month}月${day}日`,
    };
  });
}

function packageSummary(item: WashPackage): string {
  if (item.summary) return item.summary;
  if (item.serviceItems?.length) return item.serviceItems.join(" + ");
  return item.name.includes("精") ? "外观精细清洗 + 轮毂清洁 + 内饰深度清洁" : "外观泡沫清洗 + 轮毂清洁 + 车内吸尘";
}

function quoteErrorState(error: unknown): { message: string; code: string; blocked: boolean } {
  const code = String((error as { code?: string })?.code || "");
  if (code === "WASH_VALET_OUT_OF_RANGE") return { code, blocked: true, message: "该取车地址超出当前门店代驾服务范围，请更换地址或选择自驾到店" };
  if (code === "WASH_REAL_ROUTE_REQUIRED") return { code, blocked: true, message: "暂时无法取得真实驾车路线，为避免错误计费，请稍后重试或选择自驾到店" };
  if (code === "WASH_VALET_RULE_MISSING") return { code, blocked: true, message: "当前门店尚未配置代驾计价规则，请更换门店或选择自驾到店" };
  if (code === "WASH_PICKUP_PROOF_REQUIRED" || code === "WASH_PICKUP_PROOF_INVALID") return { code, blocked: true, message: "取车地址校验已失效，请重新搜索并选择取车地址" };
  if (code === "WASH_DEMO_PICKUP_NOT_ALLOWED") return { code, blocked: true, message: "当前环境不支持演示地址，请重新搜索真实取车地址" };
  return { code, blocked: false, message: error instanceof Error ? error.message : "暂时无法确认价格" };
}

const MAP_MATCH_MAX_DISTANCE_KM = 1.5;

function coordinateDistanceKm(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const earthRadiusKm = 6371;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizePickupAddress(value: PickupAddress | null | undefined): PickupAddress | null {
  if (!value) return null;
  return {
    ...value,
    detail: value.detail || "",
    note: value.note || "",
  };
}

function nearestVerifiedSuggestion(
  location: { latitude: number; longitude: number },
  suggestions: PickupAddress[],
): PickupAddress | null {
  const ranked = suggestions
    .filter((item) => Boolean(item.locationProof) && Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
    .map((item) => ({ item, distanceKm: coordinateDistanceKm(location, item) }))
    .sort((left, right) => left.distanceKm - right.distanceKm);
  return ranked[0] && ranked[0].distanceKm <= MAP_MATCH_MAX_DISTANCE_KM ? ranked[0].item : null;
}

Page<Data>({
  data: {
    vehicles: [], vehicleIndex: 0, selectedVehicle: null, selectedVehicleCategoryLabel: "小轿车",
    stores: [], storeIndex: 0, selectedStore: null, selectedStoreCoverUrl: washStoreFallbackCover(0),
    packages: [], selectedPackageId: "", selectedPackage: null,
    dateOptions: dateOptions(), selectedDate: today(), slots: [], selectedSlotId: "", selectedSlot: null,
    serviceMode: "self_drive", pickupAddress: null, addressQuery: "", suggestions: [], addressLoading: false, mapResolving: false,
    quote: null, quoteLoading: false, quoteError: "", quoteErrorCode: "", quoteBlocked: false,
    contactName: "", contactPhone: "", notes: "", loading: true, submitting: false, error: "",
  },

  onLoad() {
    const contact = getRecentContact();
    this.setData({ contactName: contact.name, contactPhone: contact.phone });
  },

  onShow() {
    if (this.skipNextShowAfterMap) {
      this.skipNextShowAfterMap = false;
      return;
    }
    void this.load();
  },

  async load() {
    const sequence = Number(this.pageLoadSequence || 0) + 1;
    this.pageLoadSequence = sequence;
    const draft = getWashDraft() || {};
    const serviceMode = draft.serviceMode === "valet" ? "valet" : "self_drive";
    const pickupAddress = normalizePickupAddress(draft.pickupAddress);
    this.setData({ loading: true, error: "", quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false, serviceMode, pickupAddress, addressQuery: "" });
    try {
      const [vehicles, stores] = await Promise.all([api.vehicles(), api.washStores()]);
      if (this.pageLoadSequence !== sequence) return;
      const activeStores = stores.filter((item) => item.isActive !== false);
      const vehicleIndex = Math.max(0, vehicles.findIndex((item) => item.id === draft.vehicleId));
      const selectedVehicle = vehicles[vehicleIndex] || null;
      const storeIndex = Math.max(0, activeStores.findIndex((item) => item.id === draft.storeId));
      const selectedStore = activeStores[storeIndex] || null;
      const dates = dateOptions();
      const selectedDate = dates.some((item) => item.date === draft.date) ? String(draft.date) : dates[0].date;
      this.setData({ vehicles, vehicleIndex, selectedVehicle, selectedVehicleCategoryLabel: washVehicleCategoryLabel(selectedVehicle), stores: activeStores, storeIndex, selectedStore, selectedStoreCoverUrl: selectedStore?.coverImageUrl || washStoreFallbackCover(storeIndex), dateOptions: dates, selectedDate });
      if (!selectedVehicle) throw new Error("请先添加车辆，再预约洗车");
      if (!selectedStore) throw new Error("附近暂无可预约洗车门店");
      patchWashDraft({ serviceMode, pickupAddress: pickupAddress || undefined, vehicleId: selectedVehicle.id, storeId: selectedStore.id, date: selectedDate });
      await this.loadPackages(selectedStore, selectedVehicle, draft.packageId, draft.slotId);
    } catch (error) {
      if (this.pageLoadSequence === sequence) this.setData({ error: error instanceof Error ? error.message : "洗车服务暂时不可用" });
    } finally {
      if (this.pageLoadSequence === sequence) this.setData({ loading: false });
    }
  },

  async loadPackages(store: WashStore, vehicle: Vehicle, preferredPackageId?: string, preferredSlotId?: string) {
    const category = washVehicleCategory(vehicle);
    const catalogSelection = nextWashCatalogSelection(this.catalogSelection as WashCatalogSelection | undefined, store.id, vehicle.id);
    this.catalogSelection = catalogSelection;
    this.quoteSequence = Number(this.quoteSequence || 0) + 1;
    this.setData({ packages: [], selectedPackage: null, selectedPackageId: "", slots: [], selectedSlot: null, selectedSlotId: "", quote: null, quoteError: "" });
    let packages: WashPackage[];
    try {
      packages = (await api.washPackages(store.id, category))
        .filter((item) => item.isActive !== false)
        .map((item) => ({ ...item, summary: packageSummary(item) }));
    } catch (error) {
      // A superseded vehicle/store request must not surface an obsolete error
      // over the latest catalog either.
      if (!isWashCatalogSelectionCurrent(this.catalogSelection as WashCatalogSelection | undefined, catalogSelection)) return;
      throw error;
    }
    if (!isWashCatalogSelectionCurrent(this.catalogSelection as WashCatalogSelection | undefined, catalogSelection)) return;
    const selectedPackage = packages.find((item) => item.id === preferredPackageId || item.packageId === preferredPackageId) || packages[0] || null;
    this.setData({ packages, selectedPackage, selectedPackageId: selectedPackage?.id || "", slots: [], selectedSlot: null, selectedSlotId: "", quote: null });
    if (!selectedPackage) {
      this.setData({ quoteError: "当前车型暂无可用洗车套餐" });
      return;
    }
    patchWashDraft({ packageId: selectedPackage.id, slotId: undefined });
    await this.loadSlots(this.data.selectedDate, preferredSlotId, catalogSelection, selectedPackage);
  },

  async loadSlots(date: string, preferredSlotId?: string, expectedCatalog?: WashCatalogSelection, expectedPackage?: WashPackage) {
    const catalogSelection = expectedCatalog || this.catalogSelection as WashCatalogSelection | undefined;
    const selectedPackage = expectedPackage || this.data.selectedPackage;
    if (!catalogSelection || !selectedPackage || !isWashCatalogSelectionCurrent(this.catalogSelection as WashCatalogSelection | undefined, catalogSelection)) return;
    // Package/date changed: invalidate any quote that is still resolving for
    // the previous slot before clearing the visible quote and loading slots.
    this.quoteSequence = Number(this.quoteSequence || 0) + 1;
    const slotRequest = {
      sequence: Number(this.slotRequest?.sequence || 0) + 1,
      catalogSequence: catalogSelection.sequence,
      storeId: catalogSelection.storeId,
      vehicleId: catalogSelection.vehicleId,
      packageId: selectedPackage.id,
      date,
    };
    this.slotRequest = slotRequest;
    this.setData({ selectedDate: date, slots: [], selectedSlot: null, selectedSlotId: "", quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false, quoteLoading: true });
    patchWashDraft({ date, slotId: undefined });
    try {
      const slots = await api.washSlots(catalogSelection.storeId, date, selectedPackage.id);
      if (this.slotRequest !== slotRequest || !isWashCatalogSelectionCurrent(this.catalogSelection as WashCatalogSelection | undefined, catalogSelection)) return;
      const selectedSlot = slots.find((item) => item.id === preferredSlotId && item.remaining > 0) || slots.find((item) => item.remaining > 0) || null;
      this.setData({ slots, selectedSlot, selectedSlotId: selectedSlot?.id || "" });
      patchWashDraft({ slotId: selectedSlot?.id });
      if (selectedSlot) await this.refreshQuote(selectedSlot);
      else this.setData({ quoteLoading: false, quoteError: "当天暂无可约时段，请选择其他日期" });
    } catch (error) {
      if (this.slotRequest !== slotRequest || !isWashCatalogSelectionCurrent(this.catalogSelection as WashCatalogSelection | undefined, catalogSelection)) return;
      this.setData({ quoteLoading: false, quoteError: error instanceof Error ? error.message : "读取可约时间失败" });
    }
  },

  async refreshQuote(slot?: WashSlot | null) {
    const targetSlot = slot || this.data.selectedSlot;
    const vehicle = this.data.selectedVehicle;
    const store = this.data.selectedStore;
    const selectedPackage = this.data.selectedPackage;
    if (!vehicle || !store || !selectedPackage || !targetSlot) {
      this.setData({ quote: null, quoteLoading: false });
      return;
    }
    if (this.data.serviceMode === "valet" && !this.data.pickupAddress) {
      this.setData({ quote: null, quoteLoading: false, quoteError: "", quoteErrorCode: "", quoteBlocked: false });
      return;
    }
    if (this.data.serviceMode === "valet" && !this.data.pickupAddress?.locationProof) {
      this.setData({ quote: null, quoteLoading: false, quoteError: "取车地址校验已失效，请重新搜索并选择取车地址", quoteErrorCode: "WASH_PICKUP_PROOF_REQUIRED", quoteBlocked: true });
      return;
    }
    const sequence = Number(this.quoteSequence || 0) + 1;
    this.quoteSequence = sequence;
    this.setData({ quoteLoading: true, quoteError: "", quoteErrorCode: "", quoteBlocked: false, quote: null });
    try {
      const quote = await api.washQuote({
        vehicleId: vehicle.id, storeId: store.id, packageId: selectedPackage.id, slotId: targetSlot.id,
        vehicleCategory: washVehicleCategory(vehicle), serviceMode: this.data.serviceMode,
        tripType: "round_trip_same_address",
        pickupAddress: this.data.serviceMode === "valet" ? this.data.pickupAddress || undefined : undefined,
      });
      if (this.quoteSequence !== sequence) return;
      this.setData({ quote, quoteLoading: false });
    } catch (error) {
      if (this.quoteSequence !== sequence) return;
      const state = quoteErrorState(error);
      this.setData({ quote: null, quoteLoading: false, quoteError: state.message, quoteErrorCode: state.code, quoteBlocked: state.blocked });
    }
  },

  async chooseMode(event) {
    const serviceMode: ServiceMode = event.currentTarget.dataset.mode === "valet" ? "valet" : "self_drive";
    if (serviceMode === this.data.serviceMode) return;
    this.quoteSequence = Number(this.quoteSequence || 0) + 1;
    this.setData({ serviceMode, quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false, suggestions: [], addressQuery: "" });
    patchWashDraft({ serviceMode });
    await this.refreshQuote();
  },

  onAddressInput(event: { detail: { value?: string } }) {
    const addressQuery = String(event.detail.value ?? "");
    this.setData({ addressQuery });
    void this.fetchAddressSuggestions(addressQuery);
  },

  async fetchAddressSuggestions(rawQuery: string) {
    const addressQuery = rawQuery.trim();
    const sequence = Number(this.addressSequence || 0) + 1;
    this.addressSequence = sequence;
    if (addressQuery.length < 2) {
      this.setData({ suggestions: [], addressLoading: false });
      return;
    }
    this.setData({ addressLoading: true });
    try {
      const suggestions = await api.suggestions(addressQuery);
      if (this.addressSequence === sequence) this.setData({ suggestions, addressLoading: false });
    } catch {
      if (this.addressSequence === sequence) this.setData({ suggestions: [], addressLoading: false });
    }
  },

  async selectAddress(event) {
    const index = Number(event.currentTarget.dataset.index);
    const pickupAddress = normalizePickupAddress(this.data.suggestions[index]);
    if (!pickupAddress) return;
    if (!pickupAddress.locationProof) {
      wx.showModal({ title: "地址尚未校验", content: "该地址缺少服务端校验凭证，请重新搜索后选择。", confirmText: "我知道了", success: () => undefined });
      return;
    }
    this.setData({ pickupAddress, suggestions: [], addressQuery: "", quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false });
    patchWashDraft({ serviceMode: "valet", pickupAddress });
    await this.refreshQuote();
  },

  chooseAddressOnMap() {
    this.skipNextShowAfterMap = true;
    wx.chooseLocation({ success: async (location) => {
      const query = String(location.name || location.address || "").trim();
      if (query.length < 2) {
        wx.showModal({ title: "无法校验地图选点", content: "该选点缺少可搜索的名称或地址，请使用地址搜索选择取车点。", confirmText: "使用搜索", success: () => undefined });
        return;
      }
      this.setData({ mapResolving: true, quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false });
      try {
        const suggestions = await api.suggestions(query);
        const pickupAddress = normalizePickupAddress(nearestVerifiedSuggestion(location, suggestions));
        if (!pickupAddress) {
          wx.showModal({ title: "未找到可校验地址", content: "地图选点附近没有匹配到服务端校验地址，请使用搜索选择取车点。", confirmText: "使用搜索", success: () => undefined });
          return;
        }
        this.setData({ pickupAddress, suggestions: [], addressQuery: "", quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false });
        patchWashDraft({ serviceMode: "valet", pickupAddress });
        await this.refreshQuote();
      } catch {
        wx.showModal({ title: "地址校验失败", content: "暂时无法校验地图选点，请使用地址搜索选择取车点。", confirmText: "使用搜索", success: () => undefined });
      } finally {
        this.setData({ mapResolving: false });
      }
    }, fail: () => { this.skipNextShowAfterMap = false; } });
  },

  pickupInput(event) {
    const field = event.currentTarget.dataset.field as "detail" | "note";
    const pickupAddress = this.data.pickupAddress;
    if (!pickupAddress) return;
    const next = { ...pickupAddress, [field]: String(event.detail.value || "") };
    this.setData({ pickupAddress: next, quote: null });
    patchWashDraft({ pickupAddress: next });
  },

  pickupBlur() { void this.refreshQuote(); },

  async changeVehicle(event) {
    const vehicleIndex = Number(event.detail.value);
    const selectedVehicle = this.data.vehicles[vehicleIndex] || null;
    const store = this.data.selectedStore;
    if (!selectedVehicle || !store) return;
    this.quoteSequence = Number(this.quoteSequence || 0) + 1;
    this.setData({ vehicleIndex, selectedVehicle, selectedVehicleCategoryLabel: washVehicleCategoryLabel(selectedVehicle), packages: [], selectedPackage: null, selectedPackageId: "", slots: [], selectedSlot: null, selectedSlotId: "", quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false });
    patchWashDraft({ vehicleId: selectedVehicle.id, packageId: undefined, slotId: undefined });
    try { await this.loadPackages(store, selectedVehicle); }
    catch (error) { this.setData({ quoteError: error instanceof Error ? error.message : "读取套餐失败" }); }
  },

  chooseStore() { wx.navigateTo({ url: "/packages/wash/pages/wash-stores/wash-stores" }); },
  selectedStoreCoverError() { this.setData({ selectedStoreCoverUrl: washStoreFallbackCover(this.data.storeIndex) }); },

  async choosePackage(event) {
    const packageId = String(event.currentTarget.dataset.id || "");
    const selectedPackage = this.data.packages.find((item) => item.id === packageId) || null;
    if (!selectedPackage || selectedPackage.id === this.data.selectedPackageId) return;
    this.setData({ selectedPackage, selectedPackageId: selectedPackage.id, quote: null, quoteError: "", quoteErrorCode: "", quoteBlocked: false });
    patchWashDraft({ packageId: selectedPackage.id, slotId: undefined });
    await this.loadSlots(this.data.selectedDate, undefined, this.catalogSelection as WashCatalogSelection | undefined, selectedPackage);
  },

  async chooseDate(event) {
    const date = String(event.currentTarget.dataset.date || "");
    if (!date || date === this.data.selectedDate) return;
    await this.loadSlots(date, undefined, this.catalogSelection as WashCatalogSelection | undefined, this.data.selectedPackage || undefined);
  },

  async chooseSlot(event) {
    const slotId = String(event.currentTarget.dataset.id || "");
    const selectedSlot = this.data.slots.find((item) => item.id === slotId && item.remaining > 0) || null;
    if (!selectedSlot || selectedSlot.id === this.data.selectedSlotId) return;
    this.setData({ selectedSlot, selectedSlotId: selectedSlot.id, quote: null });
    patchWashDraft({ slotId: selectedSlot.id });
    await this.refreshQuote(selectedSlot);
  },

  input(event) {
    const field = event.currentTarget.dataset.field as "contactName" | "contactPhone" | "notes";
    this.setData({ [field]: String(event.detail.value || "") } as Partial<Data>);
  },

  retryQuote() { void this.refreshQuote(); },
  retry() { void this.load(); },
  addVehicle() { wx.navigateTo({ url: "/packages/vehicle/pages/vehicle-form/vehicle-form" }); },

  async submit() {
    const quote = this.data.quote;
    const slot = this.data.selectedSlot;
    const contactName = this.data.contactName.trim();
    const contactPhone = this.data.contactPhone.trim();
    if (this.data.serviceMode === "valet" && !this.data.pickupAddress) return wx.showToast({ title: "请先选择取车地址", icon: "none" });
    if (!quote || !quote.quoteSnapshotId || !slot) return wx.showToast({ title: "请先确认套餐、门店与服务时间", icon: "none" });
    if (contactName.length < 2) return wx.showToast({ title: "请填写预约人姓名", icon: "none" });
    if (!/^1[3-9]\d{9}$/.test(contactPhone)) return wx.showToast({ title: "请输入正确手机号", icon: "none" });
    if (this.data.submitting) return;
    const idempotencyKey = this.submitQuoteSnapshotId === quote.quoteSnapshotId && this.submitKey
      ? this.submitKey : `wash-order-${quote.quoteSnapshotId}-${Date.now()}`;
    this.submitKey = idempotencyKey;
    this.submitQuoteSnapshotId = quote.quoteSnapshotId;
    this.setData({ submitting: true });
    try {
      storeRecentContact({ name: contactName, phone: contactPhone });
      const order = await api.createWashOrder({
        quoteSnapshotId: quote.quoteSnapshotId, idempotencyKey, contactName, contactPhone,
        notes: this.data.notes.trim() || undefined,
      });
      clearWashDraft();
      wx.navigateTo({ url: `/packages/wash/pages/wash-payment/wash-payment?id=${encodeURIComponent(order.id)}` });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "预约提交失败", icon: "none" });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
