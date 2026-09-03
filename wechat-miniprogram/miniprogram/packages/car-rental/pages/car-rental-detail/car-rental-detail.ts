import { api } from "../../../../services/api";
import { getCarRentalDraft, patchCarRentalDraft } from "../../../../services/storage";
import type { CarRentalImage, CarRentalModel } from "../../../../types";
import { backOrRentalHome } from "../../utils/navigation";
import { dateTimeLabel, energyLabel, fen } from "../../utils/rental";

type ModelView = CarRentalModel & {
  energyLabel: string;
  depositLabel: string;
  dailyPrice: string;
};
type Data = {
  id: string;
  model: ModelView | null;
  gallery: CarRentalImage[];
  currentImage: number;
  dailyPrice: string;
  estimatedTotal: string;
  rentalDays: number;
  pickupLabel: string;
  returnLabel: string;
  locationLabel: string;
  availableCount: number;
  loading: boolean;
  error: string;
};

Page<Data>({
  data: {
    id: "", model: null, gallery: [], currentImage: 0, dailyPrice: "0", estimatedTotal: "0", rentalDays: 0,
    pickupLabel: "", returnLabel: "", locationLabel: "", availableCount: 0, loading: true, error: "",
  },
  onLoad(query) {
    const id = decodeURIComponent(String(query.id || ""));
    this.setData({ id });
    void this.load();
  },
  onPullDownRefresh() { void this.load(true); },
  async load(fromPullDown = false) {
    const draft = getCarRentalDraft();
    const offer = draft?.selectedOffer;
    if (!draft || !offer || !this.data.id) {
      this.setData({ loading: false, error: "车型选择已失效，请返回重新选择" });
      if (fromPullDown) wx.stopPullDownRefresh();
      return;
    }
    this.setData({ loading: true, error: "" });
    try {
      const detail = await api.carRentalModel(this.data.id, { ...draft, storeId: draft.storeId || offer.storeId }).catch(() => offer.model);
      const model: ModelView = {
        ...offer.model,
        ...detail,
        brandName: detail.brandName || offer.model.brandName,
        brandLogoUrl: detail.brandLogoUrl || offer.model.brandLogoUrl,
        imageUrl: detail.imageUrl || offer.model.imageUrl,
        images: detail.images.length ? detail.images : offer.model.images,
        availableCount: detail.availableCount || offer.availableCount,
        minDailyRateFen: offer.dailyRateFen || detail.minDailyRateFen,
        energyLabel: energyLabel(detail.energyType || offer.model.energyType),
        depositLabel: fen(detail.vehicleDepositFen || offer.model.vehicleDepositFen),
        dailyPrice: fen(offer.dailyRateFen),
      };
      const gallery = model.images.length ? model.images : [{ id: `${model.id}-cover`, url: model.imageUrl, sortOrder: 0, isCover: true, alt: model.name }];
      this.setData({
        model, gallery,
        dailyPrice: fen(offer.dailyRateFen), estimatedTotal: fen(offer.estimatedTotalFen), rentalDays: offer.rentalDays,
        pickupLabel: dateTimeLabel(draft.pickupAt), returnLabel: dateTimeLabel(draft.returnAt),
        locationLabel: draft.fulfillmentMode === "home_delivery" ? draft.deliveryAddress?.title || "同址送取" : offer.storeName || "同店取还",
        availableCount: offer.availableCount,
      });
      wx.setNavigationBarTitle({ title: model.name });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "车型详情暂时无法读取" });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },
  swiperChange(event) { this.setData({ currentImage: Number(event.detail.current || 0) }); },
  previewImage(event) {
    const current = String(event.currentTarget.dataset.url || "");
    const urls = this.data.gallery.map((item) => item.url);
    if (current && urls.length) wx.previewImage({ current, urls });
  },
  imageError(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    this.setData({ [`gallery[${index}].url`]: "/assets/brand/hero-car-generic.png" } as unknown as Partial<Data>);
  },
  brandLogoError() {
    if (this.data.model?.brandLogoUrl) {
      this.setData({ "model.brandLogoUrl": "" } as unknown as Partial<Data>);
    }
  },
  proceed() {
    const draft = getCarRentalDraft();
    if (!draft?.selectedOffer || !this.data.model) return;
    patchCarRentalDraft({ selectedModelId: this.data.model.id, selectedOffer: { ...draft.selectedOffer, model: this.data.model }, quote: undefined });
    wx.navigateTo({ url: "/packages/car-rental/pages/car-rental-confirm/car-rental-confirm" });
  },
  contactService() {
    wx.showModal({ title: "统一客服", content: "当前为汽车租赁演示。正式服务将复用平台统一客服入口，本页面不采集额外留资。", confirmText: "我知道了", success: () => undefined });
  },
  retry() { void this.load(); },
  backToOffers() { backOrRentalHome(); },
});
