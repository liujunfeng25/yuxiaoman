import { api } from "../../../../services/api";
import { getCarRentalDraft, patchCarRentalDraft } from "../../../../services/storage";
import type { CarRentalFulfillmentMode, CarRentalOffer, CarRentalSearch, CarRentalStore, PickupAddress } from "../../../../types";
import { leaveRentalHome } from "../../utils/navigation";
import { addCalendarDays, dateInputValue, energyLabel, fen, rentalDays, shanghaiIso, timeInputValue, validateRentalSearch } from "../../utils/rental";

type StoreView = CarRentalStore & { pickerLabel: string };
type HotOfferView = CarRentalOffer & {
  dailyPrice: string;
  totalPrice: string;
  energyLabel: string;
  meta: string;
  imageLoadFailed: boolean;
};
type Data = {
  fulfillmentMode: CarRentalFulfillmentMode;
  stores: StoreView[];
  storeIndex: number;
  selectedStore: StoreView | null;
  pickupDate: string;
  pickupTime: string;
  pickupDateLabel: string;
  returnDate: string;
  returnTime: string;
  returnDateLabel: string;
  minDate: string;
  maxDate: string;
  billableDays: number;
  deliveryAddress: PickupAddress | null;
  addressQuery: string;
  suggestions: PickupAddress[];
  searchingAddress: boolean;
  loading: boolean;
  submitting: boolean;
  error: string;
  hotOffers: HotOfferView[];
  hotLoading: boolean;
  hotError: string;
};

function freshDates(): { pickup: Date; returning: Date } {
  const now = new Date();
  let pickup = addCalendarDays(now, 1);
  pickup = new Date(pickup.getFullYear(), pickup.getMonth(), pickup.getDate(), 10, 0, 0, 0);
  const returning = addCalendarDays(pickup, 2);
  return { pickup, returning };
}

function usableDate(value: string | undefined, fallback: Date): Date {
  const parsed = value ? new Date(value) : fallback;
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function displayDate(value: string): string {
  const parts = value.split("-");
  if (parts.length !== 3) return value;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

function hotOfferView(item: CarRentalOffer): HotOfferView {
  return {
    ...item,
    dailyPrice: fen(item.dailyRateFen),
    totalPrice: fen(item.estimatedTotalFen),
    energyLabel: energyLabel(item.model.energyType),
    meta: `${item.model.seats}座 · ${item.model.transmission || "自动挡"}`,
    imageLoadFailed: false,
  };
}

function pickHotOffers(items: CarRentalOffer[]): HotOfferView[] {
  const remaining = [...items];
  const picked: CarRentalOffer[] = [];
  const priorities = ["理想l7", "迈腾", "model3", "秦plusdm-i"];
  priorities.forEach((target) => {
    const index = remaining.findIndex((item) => `${item.model.brandName}${item.model.name}`.replace(/\s+/g, "").toLocaleLowerCase().includes(target));
    if (index >= 0 && picked.length < 2) picked.push(...remaining.splice(index, 1));
  });
  while (picked.length < 2 && remaining.length) picked.push(remaining.shift() as CarRentalOffer);
  return picked.map(hotOfferView);
}

Page<Data>({
  data: {
    fulfillmentMode: "store_pickup",
    stores: [], storeIndex: 0, selectedStore: null,
    pickupDate: "", pickupTime: "10:00", pickupDateLabel: "--",
    returnDate: "", returnTime: "10:00", returnDateLabel: "--",
    minDate: "", maxDate: "", billableDays: 2,
    deliveryAddress: null, addressQuery: "", suggestions: [], searchingAddress: false,
    loading: true, submitting: false, error: "",
    hotOffers: [], hotLoading: false, hotError: "",
  },

  onLoad() { void this.load(); },
  onPullDownRefresh() { void this.load(true); },

  async load(fromPullDown = false) {
    const fresh = freshDates();
    const draft = getCarRentalDraft();
    let pickup = usableDate(draft?.pickupAt, fresh.pickup);
    let returning = usableDate(draft?.returnAt, fresh.returning);
    if (pickup.getTime() < Date.now() + 2 * 60 * 60 * 1000 || returning <= pickup) {
      pickup = fresh.pickup;
      returning = fresh.returning;
    }
    this.setData({
      loading: true,
      error: "",
      fulfillmentMode: draft?.fulfillmentMode === "home_delivery" ? "home_delivery" : "store_pickup",
      pickupDate: dateInputValue(pickup), pickupTime: timeInputValue(pickup),
      pickupDateLabel: displayDate(dateInputValue(pickup)),
      returnDate: dateInputValue(returning), returnTime: timeInputValue(returning),
      returnDateLabel: displayDate(dateInputValue(returning)),
      minDate: dateInputValue(new Date()), maxDate: dateInputValue(addCalendarDays(new Date(), 31)),
      billableDays: rentalDays(pickup.toISOString(), returning.toISOString()) || 1,
      deliveryAddress: draft?.deliveryAddress || null,
      addressQuery: draft?.deliveryAddress?.title || "",
      suggestions: [],
    });
    try {
      const stores = (await api.carRentalStores()).map((store) => ({ ...store, pickerLabel: `${store.name} · ${store.district}` }));
      const storeIndex = Math.max(0, stores.findIndex((store) => store.id === draft?.storeId));
      const selectedStore = stores[storeIndex] || null;
      this.setData({ stores, storeIndex, selectedStore });
      if (!selectedStore) throw new Error("当前暂无可用租赁门店");
      patchCarRentalDraft({
        fulfillmentMode: this.data.fulfillmentMode,
        storeId: selectedStore.id,
        pickupAt: shanghaiIso(this.data.pickupDate, this.data.pickupTime),
        returnAt: shanghaiIso(this.data.returnDate, this.data.returnTime),
        deliveryAddress: this.data.deliveryAddress || undefined,
      });
      if (this.data.fulfillmentMode === "store_pickup") await this.loadHotOffers();
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "租赁门店暂时无法读取" });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  setMode(event) {
    const mode = String(event.currentTarget.dataset.mode || "store_pickup") as CarRentalFulfillmentMode;
    this.setData({ fulfillmentMode: mode, suggestions: [], hotOffers: mode === "store_pickup" ? this.data.hotOffers : [], hotError: "" });
    patchCarRentalDraft({ fulfillmentMode: mode });
    if (mode === "store_pickup") void this.loadHotOffers();
  },

  changeStore(event) {
    const storeIndex = Number(event.detail.value || 0);
    const selectedStore = this.data.stores[storeIndex] || null;
    this.setData({ storeIndex, selectedStore });
    if (selectedStore) {
      patchCarRentalDraft({ storeId: selectedStore.id, selectedOffer: undefined, selectedModelId: undefined, quote: undefined });
      void this.loadHotOffers();
    }
  },

  changeDate(event) {
    const field = String(event.currentTarget.dataset.field || "");
    const value = String(event.detail.value || "");
    if (!field || !value) return;
    this.setData({ [field]: value } as unknown as Partial<Data>, () => this.refreshDays());
  },

  refreshDays() {
    const pickupAt = shanghaiIso(this.data.pickupDate, this.data.pickupTime);
    const returnAt = shanghaiIso(this.data.returnDate, this.data.returnTime);
    this.setData({
      billableDays: rentalDays(pickupAt, returnAt) || 0,
      pickupDateLabel: displayDate(this.data.pickupDate),
      returnDateLabel: displayDate(this.data.returnDate),
    });
    patchCarRentalDraft({ pickupAt, returnAt, selectedOffer: undefined, selectedModelId: undefined, quote: undefined });
    if (this.data.fulfillmentMode === "store_pickup") void this.loadHotOffers();
  },

  async loadHotOffers() {
    const selectedStore = this.data.selectedStore;
    if (this.data.fulfillmentMode !== "store_pickup" || !selectedStore) {
      this.setData({ hotOffers: [], hotLoading: false, hotError: "" });
      return;
    }
    const search: CarRentalSearch = {
      fulfillmentMode: "store_pickup",
      storeId: selectedStore.id,
      pickupAt: shanghaiIso(this.data.pickupDate, this.data.pickupTime),
      returnAt: shanghaiIso(this.data.returnDate, this.data.returnTime),
      sort: "recommended",
    };
    if (validateRentalSearch(search)) {
      this.setData({ hotOffers: [], hotLoading: false, hotError: "" });
      return;
    }
    const requestStoreId = selectedStore.id;
    const requestPickupAt = search.pickupAt;
    const requestReturnAt = search.returnAt;
    this.setData({ hotLoading: true, hotError: "" });
    try {
      const page = await api.carRentalOffers(search);
      const isCurrent = this.data.fulfillmentMode === "store_pickup"
        && this.data.selectedStore?.id === requestStoreId
        && shanghaiIso(this.data.pickupDate, this.data.pickupTime) === requestPickupAt
        && shanghaiIso(this.data.returnDate, this.data.returnTime) === requestReturnAt;
      if (isCurrent) this.setData({ hotOffers: pickHotOffers(page.items), hotError: page.items.length ? "" : "当前租期暂无可租车型" });
    } catch (error) {
      if (this.data.fulfillmentMode === "store_pickup") {
        this.setData({ hotOffers: [], hotError: error instanceof Error ? error.message : "热门车型暂时无法读取" });
      }
    } finally {
      if (this.data.fulfillmentMode === "store_pickup") this.setData({ hotLoading: false });
    }
  },

  addressInput(event) {
    const addressQuery = String(event.detail.value || "");
    this.setData({ addressQuery, deliveryAddress: null, suggestions: [] });
    patchCarRentalDraft({ deliveryAddress: undefined });
  },

  async searchAddress() {
    const query = this.data.addressQuery.trim();
    if (query.length < 2) {
      wx.showToast({ title: "请输入至少 2 个字搜索地址", icon: "none" });
      return;
    }
    this.setData({ searchingAddress: true, suggestions: [] });
    try {
      const suggestions = await api.suggestions(query);
      this.setData({ suggestions });
      if (!suggestions.length) wx.showToast({ title: "没有找到可验证地址", icon: "none" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "地址搜索失败", icon: "none" });
    } finally {
      this.setData({ searchingAddress: false });
    }
  },

  chooseAddress(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const deliveryAddress = this.data.suggestions.find((item) => item.poiId === id) || null;
    if (!deliveryAddress) return;
    this.setData({ deliveryAddress, addressQuery: deliveryAddress.title, suggestions: [] });
    patchCarRentalDraft({ deliveryAddress });
  },

  submit() {
    const selectedStore = this.data.selectedStore;
    const search = {
      fulfillmentMode: this.data.fulfillmentMode,
      storeId: this.data.fulfillmentMode === "store_pickup" ? selectedStore?.id : undefined,
      deliveryAddress: this.data.fulfillmentMode === "home_delivery" ? this.data.deliveryAddress || undefined : undefined,
      pickupAt: shanghaiIso(this.data.pickupDate, this.data.pickupTime),
      returnAt: shanghaiIso(this.data.returnDate, this.data.returnTime),
      sort: "recommended" as const,
    };
    const error = validateRentalSearch(search);
    if (error) {
      wx.showToast({ title: error, icon: "none" });
      return;
    }
    patchCarRentalDraft({ ...search, selectedOffer: undefined, selectedModelId: undefined, quote: undefined });
    wx.navigateTo({ url: "/packages/car-rental/pages/car-rental-offers/car-rental-offers" });
  },

  openHotDetail(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const selectedOffer = this.data.hotOffers.find((offer) => offer.id === id || offer.model.id === id);
    const selectedStore = this.data.selectedStore;
    if (!selectedOffer || !selectedStore) return;
    patchCarRentalDraft({
      fulfillmentMode: "store_pickup",
      storeId: selectedStore.id,
      pickupAt: shanghaiIso(this.data.pickupDate, this.data.pickupTime),
      returnAt: shanghaiIso(this.data.returnDate, this.data.returnTime),
      sort: "recommended",
      selectedOffer,
      selectedModelId: selectedOffer.model.id,
      quote: undefined,
    });
    wx.navigateTo({ url: `/packages/car-rental/pages/car-rental-detail/car-rental-detail?id=${encodeURIComponent(selectedOffer.model.id)}` });
  },

  hotImageError(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    this.setData({ [`hotOffers[${index}].imageLoadFailed`]: true } as unknown as Partial<Data>);
  },

  goBack() { leaveRentalHome(); },
  openOrders() { wx.navigateTo({ url: "/packages/car-rental/pages/car-rental-orders/car-rental-orders" }); },
  retryHot() { void this.loadHotOffers(); },
  retry() { void this.load(); },
});
