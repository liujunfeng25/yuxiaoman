import { api } from "../../../../services/api";
import { getCarRentalDraft, patchCarRentalDraft } from "../../../../services/storage";
import type { CarRentalBrand, CarRentalCatalog, CarRentalEnergyType, CarRentalOffer, CarRentalSearch, CarRentalSort } from "../../../../types";
import { backOrRentalHome } from "../../utils/navigation";
import { dateTimeLabel, energyLabel, fen, validateRentalSearch } from "../../utils/rental";

type OfferView = CarRentalOffer & {
  dailyPrice: string;
  totalPrice: string;
  energyLabel: string;
  meta: string;
};
type BrandGroup = { initial: string; brands: CarRentalBrand[] };
type Data = {
  search: CarRentalSearch | null;
  offers: OfferView[];
  catalog: CarRentalCatalog | null;
  groups: BrandGroup[];
  hotBrands: CarRentalBrand[];
  alphabet: string[];
  brandKeyword: string;
  scrollIntoView: string;
  showBrandPanel: boolean;
  selectedBrandName: string;
  selectedEnergy: string;
  sort: CarRentalSort;
  sortLabel: string;
  pickupLabel: string;
  returnLabel: string;
  locationLabel: string;
  billableDays: number;
  total: number;
  loading: boolean;
  error: string;
};

function offerView(item: CarRentalOffer): OfferView {
  return {
    ...item,
    dailyPrice: fen(item.dailyRateFen),
    totalPrice: fen(item.estimatedTotalFen),
    energyLabel: energyLabel(item.model.energyType),
    meta: `${item.model.seats}座 · ${item.model.transmission || "自动"}`,
  };
}

function filteredCatalog(catalog: CarRentalCatalog, keyword: string): Pick<Data, "groups" | "hotBrands" | "alphabet"> {
  const normalized = keyword.trim().toLocaleLowerCase();
  const groups = catalog.groups.map((group) => ({
    ...group,
    brands: normalized ? group.brands.filter((brand) => brand.name.toLocaleLowerCase().includes(normalized)) : group.brands,
  })).filter((group) => group.brands.length);
  return {
    groups,
    hotBrands: normalized ? catalog.hotBrands.filter((brand) => brand.name.toLocaleLowerCase().includes(normalized)) : catalog.hotBrands,
    alphabet: normalized ? [] : groups.map((group) => group.initial),
  };
}

function sortCopy(sort: CarRentalSort): string {
  return ({ recommended: "综合推荐", price_asc: "价格从低到高", price_desc: "价格从高到低" } as Record<CarRentalSort, string>)[sort];
}

Page<Data>({
  data: {
    search: null, offers: [], catalog: null, groups: [], hotBrands: [], alphabet: [],
    brandKeyword: "", scrollIntoView: "", showBrandPanel: false, selectedBrandName: "全部品牌",
    selectedEnergy: "", sort: "recommended", sortLabel: "综合推荐",
    pickupLabel: "", returnLabel: "", locationLabel: "", billableDays: 0, total: 0,
    loading: true, error: "",
  },

  onLoad() { void this.load(true); },
  onPullDownRefresh() { void this.load(false, true); },

  async load(loadCatalog = false, fromPullDown = false) {
    const draft = getCarRentalDraft();
    if (!draft) {
      this.setData({ loading: false, error: "租车行程已失效，请返回重新选择" });
      if (fromPullDown) wx.stopPullDownRefresh();
      return;
    }
    const search: CarRentalSearch = {
      fulfillmentMode: draft.fulfillmentMode,
      storeId: draft.storeId,
      deliveryAddress: draft.deliveryAddress,
      pickupAt: draft.pickupAt,
      returnAt: draft.returnAt,
      brandId: draft.brandId,
      energyType: draft.energyType,
      sort: draft.sort || "recommended",
    };
    const validationError = validateRentalSearch(search);
    if (validationError) {
      this.setData({ loading: false, error: validationError });
      if (fromPullDown) wx.stopPullDownRefresh();
      return;
    }
    this.setData({ loading: true, error: "", search, sort: search.sort || "recommended", sortLabel: sortCopy(search.sort || "recommended"), selectedEnergy: search.energyType || "" });
    try {
      const [catalog, page] = await Promise.all([
        loadCatalog || !this.data.catalog ? api.carRentalCatalog() : Promise.resolve(this.data.catalog),
        api.carRentalOffers(search),
      ]);
      if (!catalog) throw new Error("品牌目录暂时不可用");
      const allBrands = catalog.groups.flatMap((group) => group.brands);
      const selectedBrand = allBrands.find((brand) => brand.id === search.brandId);
      const filtered = filteredCatalog(catalog, this.data.brandKeyword);
      this.setData({
        catalog,
        ...filtered,
        offers: page.items.map(offerView),
        selectedBrandName: selectedBrand?.name || "全部品牌",
        pickupLabel: dateTimeLabel(search.pickupAt),
        returnLabel: dateTimeLabel(search.returnAt),
        locationLabel: page.selectedStore?.name || (search.fulfillmentMode === "home_delivery" ? search.deliveryAddress?.title || "送车地址" : "同店取还"),
        billableDays: page.rentalDays,
        total: page.total,
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "可租车型暂时无法读取", offers: [] });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  editSearch() { backOrRentalHome(); },
  toggleBrandPanel() { this.setData({ showBrandPanel: !this.data.showBrandPanel, brandKeyword: "", ...(this.data.catalog ? filteredCatalog(this.data.catalog, "") : {}) }); },
  closeBrandPanel() { this.setData({ showBrandPanel: false }); },
  brandInput(event) {
    const brandKeyword = String(event.detail.value || "");
    const catalog = this.data.catalog;
    this.setData({ brandKeyword, ...(catalog ? filteredCatalog(catalog, brandKeyword) : {}) });
  },
  clearBrandSearch() {
    const catalog = this.data.catalog;
    this.setData({ brandKeyword: "", ...(catalog ? filteredCatalog(catalog, "") : {}) });
  },
  scrollBrand(event) {
    const initial = String(event.currentTarget.dataset.initial || "");
    if (initial) this.setData({ scrollIntoView: `rental-brand-${initial}` });
  },
  chooseBrand(event) {
    const brandId = String(event.currentTarget.dataset.id || "");
    patchCarRentalDraft({ brandId: brandId || undefined, selectedOffer: undefined, selectedModelId: undefined, quote: undefined });
    this.setData({ showBrandPanel: false, brandKeyword: "", selectedBrandName: String(event.currentTarget.dataset.name || "全部品牌") });
    void this.load(false);
  },
  chooseEnergy(event) {
    const energy = String(event.currentTarget.dataset.energy || "") as CarRentalEnergyType | "";
    patchCarRentalDraft({ energyType: energy || undefined, selectedOffer: undefined, selectedModelId: undefined, quote: undefined });
    this.setData({ selectedEnergy: energy });
    void this.load(false);
  },
  chooseSort() {
    const values: CarRentalSort[] = ["recommended", "price_asc", "price_desc"];
    wx.showActionSheet({
      itemList: values.map(sortCopy),
      success: (result) => {
        const sort = values[result.tapIndex] || "recommended";
        patchCarRentalDraft({ sort, selectedOffer: undefined, selectedModelId: undefined, quote: undefined });
        this.setData({ sort, sortLabel: sortCopy(sort) });
        void this.load(false);
      },
    });
  },
  clearFilters() {
    patchCarRentalDraft({ brandId: undefined, energyType: undefined, sort: "recommended", selectedOffer: undefined, selectedModelId: undefined, quote: undefined });
    this.setData({ selectedBrandName: "全部品牌", selectedEnergy: "", sort: "recommended", sortLabel: "综合推荐" });
    void this.load(false);
  },
  openDetail(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const selectedOffer = this.data.offers.find((offer) => offer.model.id === id || offer.id === id);
    if (!selectedOffer) return;
    patchCarRentalDraft({ selectedOffer, selectedModelId: selectedOffer.model.id, quote: undefined });
    wx.navigateTo({ url: `/packages/car-rental/pages/car-rental-detail/car-rental-detail?id=${encodeURIComponent(selectedOffer.model.id)}` });
  },
  imageError(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    this.setData({ [`offers[${index}].model.imageUrl`]: "/assets/brand/hero-car-generic.png" } as unknown as Partial<Data>);
  },
  retry() { void this.load(!this.data.catalog); },
});
