import type { WashPackage, WashStore, WashStoreImage } from "../../../types";

export const WASH_STORE_FALLBACK_COVER = "/packages/wash/assets/wash-stores/demo-car-wash-cover.jpg";

export function washStoreFallbackCover(_index: number): string {
  return WASH_STORE_FALLBACK_COVER;
}

export type WashStoreCard = WashStore & {
  coverSrc: string;
  gallerySources: string[];
  usesFallbackCover: boolean;
  currentVehiclePriceFen: number | null;
  startingPackageId: string;
  startingPackageName: string;
  hasCurrentVehicleOffer: boolean;
  priceError: string;
  priceLoading: boolean;
  distanceText: string;
  distanceSourceLabel: string;
  openStateLabel: string;
  visibleTags: string[];
  visibleFacilities: string[];
  facilitiesText: string;
  hasLocation: boolean;
  detailsExpanded: boolean;
  detailLoading: boolean;
  detailLoaded: boolean;
  earliestLabel: string;
  earliestLoading: boolean;
};

function orderedImages(images: WashStoreImage[] = []): WashStoreImage[] {
  return [...images]
    .filter((image) => Boolean(image.url))
    .sort((left, right) => {
      if (Boolean(left.isCover) !== Boolean(right.isCover)) return left.isCover ? -1 : 1;
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    });
}

export function washStoreDistance(store: Pick<WashStore, "distanceKm" | "distanceSource">): {
  text: string;
  sourceLabel: string;
} {
  if (store.distanceKm === null || store.distanceKm === undefined) {
    return { text: "定位后显示距离", sourceLabel: "尚未计算" };
  }
  const distance = Number(store.distanceKm.toFixed(1));
  if (store.distanceSource === "tencent_matrix") return { text: `${distance} km`, sourceLabel: "驾车路线" };
  return { text: `约 ${distance} km`, sourceLabel: "位置估算" };
}

export function buildWashStoreCard(
  store: WashStore,
  packages: WashPackage[],
  fallbackCover: string = WASH_STORE_FALLBACK_COVER,
): WashStoreCard {
  const images = orderedImages(store.images);
  const coverSrc = store.coverImageUrl || images[0]?.url || fallbackCover;
  const gallerySources = Array.from(new Set([
    ...(store.coverImageUrl ? [store.coverImageUrl] : []),
    ...images.map((image) => image.url),
  ])).filter(Boolean);
  const activePackages = packages
    .filter((item) => item.isActive !== false && Number.isFinite(item.priceFen))
    .sort((left, right) => left.priceFen - right.priceFen || left.name.localeCompare(right.name));
  const startingPackage = activePackages[0] || null;
  const distance = washStoreDistance(store);
  const visibleFacilities = (store.facilities || []).filter(Boolean).slice(0, 4);
  return {
    ...store,
    images,
    coverSrc,
    gallerySources,
    usesFallbackCover: coverSrc === fallbackCover,
    currentVehiclePriceFen: startingPackage?.priceFen ?? null,
    startingPackageId: startingPackage?.id || "",
    startingPackageName: startingPackage?.name || "",
    hasCurrentVehicleOffer: Boolean(startingPackage),
    priceError: "",
    priceLoading: false,
    distanceText: distance.text,
    distanceSourceLabel: distance.sourceLabel,
    openStateLabel: store.isOpen === false ? "暂停预约" : "可预约",
    visibleTags: (store.tags || []).filter(Boolean).slice(0, 3),
    visibleFacilities,
    facilitiesText: visibleFacilities.length ? visibleFacilities.join(" · ") : "暂未填写设施信息",
    hasLocation: store.latitude !== null && store.latitude !== undefined && store.longitude !== null && store.longitude !== undefined,
    detailsExpanded: false,
    detailLoading: false,
    detailLoaded: false,
    earliestLabel: startingPackage ? "正在查询最近可约" : "当前车型暂无套餐",
    earliestLoading: Boolean(startingPackage),
  };
}

export function washAvailabilityDates(baseDate: string, count = 5): string[] {
  const [year, month, day] = baseDate.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => new Date(Date.UTC(year, month - 1, day + index)).toISOString().slice(0, 10));
}

export function washEarliestSlotLabel(baseDate: string, date: string, startTime: string, packageName: string): string {
  const dates = washAvailabilityDates(baseDate, 2);
  const dayLabel = date === dates[0] ? "今天" : date === dates[1] ? "明天" : `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  return `${packageName ? `${packageName} · ` : ""}${dayLabel} ${startTime}`;
}
