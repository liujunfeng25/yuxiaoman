import { api } from "../../../../services/api";
import type {
  DrivingSchoolApplicationMode,
  DrivingSchoolDetail,
  DrivingSchoolImage,
  DrivingSchoolOffer,
  DrivingSchoolTrainingClass,
} from "../../../../types";
import {
  applicationModeLabel,
  errorKind,
  localDrivingSchoolCover,
  offerPriceText,
  resolveDrivingSchoolCover,
  shortDate,
} from "../../utils";

type TrainingClassView = DrivingSchoolTrainingClass & {
  modeText: string;
  capabilityText: string;
  conditionsText: string;
};

type OfferView = DrivingSchoolOffer & {
  priceText: string;
  priceTypeText: string;
  modeText: string;
};

type GalleryImageView = DrivingSchoolImage & { captionText: string };

type DetailView = DrivingSchoolDetail & {
  coverFallback: string;
  dataLabel: string;
  regulatoryTypeText: string;
  regulatoryStatusText: string;
  regulatoryValidityText: string;
  regulatoryCapabilityText: string;
  verifiedText: string;
  trainingClassViews: TrainingClassView[];
  offerViews: OfferView[];
  hasPhone: boolean;
  hasMap: boolean;
  locationTitle: string;
  locationAddress: string;
};

type Data = {
  id: string;
  school: DetailView | null;
  gallery: GalleryImageView[];
  currentGalleryIndex: number;
  currentGalleryCaption: string;
  loading: boolean;
  error: string;
  stateKind: "offline" | "not_found" | "error" | "";
  preferredLicenseClassCode: string;
  preferredApplicationMode: DrivingSchoolApplicationMode;
};

const priceTypeLabels: Record<string, string> = {
  fixed: "固定价",
  starting_from: "起步价",
  range: "价格区间",
  inquiry: "价格需咨询",
};

function classView(item: DrivingSchoolTrainingClass): TrainingClassView {
  return {
    ...item,
    modeText: item.supportedModes.map(applicationModeLabel).join(" / ") || "申领方式待维护",
    capabilityText: String(item.trainingCapabilityNote || "").trim(),
    conditionsText: item.conditions.length ? item.conditions.join("；") : "是否符合申领条件，以公安交管部门审核为准",
  };
}

function offerView(item: DrivingSchoolOffer): OfferView {
  return {
    ...item,
    priceText: offerPriceText(item.minPriceFen, item.maxPriceFen),
    priceTypeText: priceTypeLabels[item.priceType] || "价格说明",
    modeText: item.applicationModes.map(applicationModeLabel).join(" / ") || "适用方式待确认",
  };
}

function regulatoryCapabilityText(value: DrivingSchoolDetail["regulatory"]["capabilityLevel"]): string {
  const normalized = String(value || "").toLowerCase();
  return ({
    "1": "一级普通机动车驾驶员培训",
    level_1: "一级普通机动车驾驶员培训",
    "2": "二级普通机动车驾驶员培训",
    level_2: "二级普通机动车驾驶员培训",
    "3": "三级普通机动车驾驶员培训",
    level_3: "三级普通机动车驾驶员培训",
  } as Record<string, string>)[normalized] || (normalized ? String(value) : "");
}

function detailView(item: DrivingSchoolDetail): DetailView {
  const latitude = Number(item.location?.latitude);
  const longitude = Number(item.location?.longitude);
  const isLegacy = item.regulatory.type === "legacy_license";
  const coverImage = item.coverImage || item.images.find((image) => image.isCover)?.url || item.images[0]?.url || "";
  const regulatoryStatusText = ({ active: "当前有效", valid: "当前有效", verified: "已核验", demo: "演示记录", rejected: "核验未通过", expired: "已过有效期", pending: "待核验" } as Record<string, string>)[String(item.regulatory.status || "")] || "状态待补充";
  return {
    ...item,
    coverImage: resolveDrivingSchoolCover({ ...item, coverImage }),
    coverFallback: localDrivingSchoolCover(item.trainingClasses, item.id),
    dataLabel: item.isDemo || item.dataKind === "demo" || item.dataKind === "synthetic_demo" ? "演示数据" : "真实机构",
    regulatoryTypeText: isLegacy ? "存量许可" : item.regulatory.type === "filing" ? "备案信息" : "资质信息",
    regulatoryStatusText,
    regulatoryValidityText: `${item.regulatory.validFrom ? shortDate(item.regulatory.validFrom) : "起始日待补充"} 至 ${item.regulatory.validUntil ? shortDate(item.regulatory.validUntil) : "有效期待补充"}`,
    regulatoryCapabilityText: regulatoryCapabilityText(item.regulatory.capabilityLevel),
    verifiedText: item.regulatory.verifiedAt ? shortDate(item.regulatory.verifiedAt) : "待核验",
    trainingClassViews: item.trainingClasses.map(classView),
    offerViews: item.offers.filter((offer) => offer.status === "active").map(offerView),
    hasPhone: Boolean(String(item.publicPhone || "").trim()),
    hasMap: Boolean(item.location && Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0)),
    locationTitle: item.location?.title || item.name,
    locationAddress: item.location?.address || item.address || "地址待维护",
  };
}

function galleryFor(school: DetailView): GalleryImageView[] {
  const coverMetadata = school.images.find((image) => image.isCover)
    || school.images.find((image) => image.url === school.coverImage);
  const cover: DrivingSchoolImage = {
    id: coverMetadata?.id || `${school.id}-cover`,
    url: school.coverImage || school.coverFallback,
    caption: coverMetadata?.caption || "",
    altText: coverMetadata?.altText || `${school.name}环境图片`,
    isCover: true,
    sortOrder: coverMetadata?.sortOrder ?? -1,
  };
  const images = [
    cover,
    ...school.images.filter((image) => !image.isCover && image.url !== cover.url),
  ];
  const unique = new Map<string, DrivingSchoolImage>();
  images.forEach((image) => {
    if (!image.url || unique.has(image.url)) return;
    unique.set(image.url, image);
  });
  const normalized = [...unique.values()];
  if (!normalized.length) normalized.push({ ...cover, url: school.coverFallback });
  return normalized.map((image) => ({
    ...image,
    captionText: image.caption || image.altText || "驾校环境图片",
  }));
}

Page<Data>({
  data: {
    id: "", school: null, gallery: [], currentGalleryIndex: 0, currentGalleryCaption: "",
    loading: true, error: "", stateKind: "",
    preferredLicenseClassCode: "", preferredApplicationMode: "initial",
  },

  onLoad(query) {
    const id = String(query.id || "");
    const requestedMode = String(query.applicationMode || "initial");
    this.setData({
      id,
      preferredLicenseClassCode: String(query.licenseClassCode || ""),
      preferredApplicationMode: requestedMode === "upgrade" ? "upgrade" : "initial",
    });
    if (!id) {
      this.setData({ loading: false, error: "缺少驾校编号", stateKind: "not_found" });
      return;
    }
    void this.load();
  },
  onPullDownRefresh() { void this.load(true); },

  async load(fromPullDown = false) {
    this.setData({ loading: true, error: "", stateKind: "" });
    try {
      const raw = await api.drivingSchool(this.data.id);
      const school = detailView(raw);
      const gallery = galleryFor(school);
      this.setData({
        school,
        gallery,
        currentGalleryIndex: 0,
        currentGalleryCaption: gallery[0]?.captionText || "",
      });
      wx.setNavigationBarTitle({ title: school.name || "驾校详情" });
    } catch (error) {
      this.setData({
        school: null,
        error: error instanceof Error ? error.message : "驾校详情暂时无法读取",
        stateKind: errorKind(error),
      });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  retry() { void this.load(); },
  backToList() { wx.navigateBack({ delta: 1 }); },
  imageError(event) {
    if (!this.data.school) return;
    const fallback = this.data.school.coverFallback;
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.gallery[index] || this.data.gallery[index].url === fallback) return;
    const gallery = this.data.gallery.map((image, imageIndex) => imageIndex === index ? { ...image, url: fallback } : image);
    this.setData({ gallery, ...(index === 0 ? { "school.coverImage": fallback } : {}) } as unknown as Partial<Data>);
  },
  previewImage(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    const current = this.data.gallery[index]?.url || this.data.gallery[0]?.url || "";
    const urls = this.data.gallery.map((image) => image.url).filter(Boolean);
    if (!current || !urls.length) return;
    wx.previewImage({ current, urls });
  },
  galleryChange(event) {
    const index = Number(event.detail.current || 0);
    this.setData({
      currentGalleryIndex: index,
      currentGalleryCaption: this.data.gallery[index]?.captionText || "",
    });
  },
  callSchool() {
    const phone = String(this.data.school?.publicPhone || "").trim();
    if (!phone) { wx.showToast({ title: "该驾校暂未公开电话", icon: "none" }); return; }
    wx.makePhoneCall({ phoneNumber: phone, fail: () => wx.showToast({ title: "暂时无法拨打，请稍后重试", icon: "none" }) });
  },
  navigateSchool() {
    const school = this.data.school;
    if (!school?.hasMap || !school.location) { wx.showToast({ title: "该校区暂无可用地图坐标", icon: "none" }); return; }
    const locationOptions = {
      latitude: Number(school.location.latitude), longitude: Number(school.location.longitude),
      name: school.location.title || school.name, address: school.location.address || school.address, scale: 16,
      fail: () => wx.showModal({
        title: "暂时无法打开地图",
        content: school.locationAddress || "该校区地址暂不可用",
        confirmText: "复制地址",
        success: ({ confirm }) => {
          if (confirm && school.locationAddress) wx.setClipboardData({ data: school.locationAddress });
        },
      }),
    } as Parameters<typeof wx.openLocation>[0] & { fail: () => void };
    wx.openLocation(locationOptions);
  },
  copySource() {
    const sourceUrl = String(this.data.school?.regulatory.sourceUrl || "");
    if (!sourceUrl) { wx.showToast({ title: "暂无可复制的公开来源链接", icon: "none" }); return; }
    wx.setClipboardData({ data: sourceUrl });
  },
  submitInquiry() {
    const school = this.data.school;
    if (!school?.inquiryAvailable) { wx.showToast({ title: "该驾校暂未开放咨询登记", icon: "none" }); return; }
    const preferred = school.trainingClasses.find((item) => item.licenseClassCode === this.data.preferredLicenseClassCode && item.supportedModes.includes(this.data.preferredApplicationMode));
    const fallback = school.trainingClasses.find((item) => item.supportedModes.includes(this.data.preferredApplicationMode)) || school.trainingClasses[0];
    const code = preferred?.licenseClassCode || fallback?.licenseClassCode || "";
    const mode = preferred?.supportedModes.includes(this.data.preferredApplicationMode) || fallback?.supportedModes.includes(this.data.preferredApplicationMode)
      ? this.data.preferredApplicationMode
      : fallback?.supportedModes[0] || "initial";
    wx.navigateTo({ url: `/packages/driving-school/pages/inquiry/inquiry?schoolId=${encodeURIComponent(school.id)}&licenseClassCode=${encodeURIComponent(code)}&applicationMode=${encodeURIComponent(mode)}` });
  },
  chooseOffer(event) {
    const school = this.data.school;
    const offerId = String(event.currentTarget.dataset.offerId || "");
    const offer = school?.offers.find((item) => item.id === offerId && item.status === "active");
    if (!school || !offer || !school.inquiryAvailable) return;
    const mode = offer.applicationModes.includes(this.data.preferredApplicationMode) ? this.data.preferredApplicationMode : offer.applicationModes[0] || "initial";
    wx.navigateTo({ url: `/packages/driving-school/pages/inquiry/inquiry?schoolId=${encodeURIComponent(school.id)}&licenseClassCode=${encodeURIComponent(offer.licenseClassCode)}&applicationMode=${encodeURIComponent(mode)}&offerId=${encodeURIComponent(offer.id)}` });
  },
});
