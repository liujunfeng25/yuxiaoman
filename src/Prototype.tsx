import {
  ArrowClockwise,
  ArrowsLeftRight,
  CalendarBlank,
  CalendarCheck,
  Camera,
  Car,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  ClipboardText,
  Clock,
  DotsThree,
  Drop,
  FileText,
  Funnel,
  Gauge,
  Headset,
  House,
  IdentificationCard,
  Images,
  Info,
  Lightning,
  ListChecks,
  MagnifyingGlass,
  MapPin,
  MapTrifold,
  NavigationArrow,
  NotePencil,
  Phone,
  Plus,
  Receipt,
  SealCheck,
  ShieldCheck,
  Sparkle,
  Star,
  SteeringWheel,
  Storefront,
  Sun,
  Moon,
  Trash,
  UserCircle,
  Warning,
  Wrench,
  X,
  Copy,
} from "@phosphor-icons/react";
import {
  createContext,
  Fragment,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BottomSheet,
  Carousel,
  FlowStack,
  KeyboardInput,
  KeyboardTextarea,
  MobileScroll,
  type FlowScreen,
  useFlow,
  useKeyboard,
} from "./mobile";
import {
  AGENCY_LETTERS,
  PROVINCE_ABBREVIATIONS,
  formatPlate,
  normalizePlate,
  parsePlate,
  type EnergyCategory,
  type PlateKind,
} from "./domain/plate";
import {
  calculateInspection,
  inspectionApplicationWindow,
  type InspectionCalculationInput,
  type InspectionCalculationResult,
} from "./domain/inspection";

type BookingStatus =
  | "pending_payment"
  | "paid_pending_confirmation"
  | "confirmed"
  | "driver_arranged"
  | "picked_up"
  | "awaiting_arrival"
  | "checked_in"
  | "inspecting"
  | "result_received"
  | "returning"
  | "completed"
  | "on_hold"
  | "cancelled"
  | "no_show";
type BookingFulfillmentStatus = BookingStatus | "legacy";

type AppRole = "consumer" | "operator";
type ConsumerTab = "home" | "orders" | "profile";
type InspectionStage = "booking" | "arrival" | "materials" | "result";
type ServiceMode = "self_drive" | "valet";
type VehiclePriceCategory = string;
type PowertrainType = "gasoline" | "diesel" | "hybrid" | "pure_electric" | "phev" | "erev" | "other";
type InspectionValiditySource = "traffic_12123" | "electronic_driving_license" | "paper_driving_license";
type InspectionValidity =
  | { mode: "unconfirmed" }
  | {
      mode: "confirmed";
      validThroughMonth: string;
      source: InspectionValiditySource;
      confirmedAt?: string | null;
    };
type UsedCarEnergyType = "petrol" | "diesel" | "hybrid" | "plug_in_hybrid" | "electric" | "range_extended";
type UsedCarBodyType = "sedan" | "suv" | "mpv" | "hatchback" | "coupe" | "pickup";
type UsedCarSort = "recommended" | "newest" | "price_asc" | "price_desc" | "mileage_asc";

type UsedCarModel = {
  id: string;
  brandId: string;
  name: string;
  bodyType: UsedCarBodyType;
  energyType: UsedCarEnergyType;
  listingCount: number;
  sortOrder?: number;
  isActive?: boolean;
};

type UsedCarBrand = {
  id: string;
  name: string;
  initial: string;
  logoUrl: string | null;
  isHot: boolean;
  listingCount: number;
  models: UsedCarModel[];
};

type UsedCarCatalog = {
  groups: Array<{ initial: string; brands: UsedCarBrand[] }>;
  hotBrands: UsedCarBrand[];
  dataKind?: "synthetic_demo" | "company_inventory";
};

type UsedCarImage = {
  id: string;
  url: string;
  sortOrder: number;
  isCover: boolean;
};

type UsedCarListing = {
  id: string;
  stockNo: string;
  title: string;
  trimName: string;
  brandId: string;
  brandName: string;
  modelId: string;
  modelName: string;
  modelYear: number;
  registrationDate: string;
  mileageKm: number;
  priceFen: number;
  guidePriceFen: number | null;
  location: string;
  exteriorColor: string;
  transferCount: number;
  energyType: UsedCarEnergyType;
  highlights: string[];
  conditionSummary: string;
  defectsDisclosure: string[];
  status: "draft" | "on_sale" | "reserved" | "sold" | "offline";
  featured: boolean;
  coverImageUrl: string | null;
  images: UsedCarImage[];
  publishedAt: string | null;
  dataKind: "synthetic_demo" | "company_inventory" | "operated";
};

type UsedCarListingPage = { items: UsedCarListing[]; total: number; page: number; pageSize: number };

const USED_CAR_ASSET_VERSION = "real-model-v1";

const USED_CAR_BRAND_SEED = [
  ["brand-audi", "奥迪", "A", false],
  ["brand-bmw", "宝马", "B", true],
  ["brand-mercedes", "奔驰", "B", true],
  ["brand-byd", "比亚迪", "B", true],
  ["brand-honda", "本田", "B", false],
  ["brand-volkswagen", "大众", "D", false],
  ["brand-toyota", "丰田", "F", false],
  ["brand-hongqi", "红旗", "H", false],
  ["brand-zeekr", "极氪", "J", false],
  ["brand-li", "理想", "L", true],
  ["brand-tesla", "特斯拉", "T", true],
  ["brand-aito", "问界", "W", false],
  ["brand-nio", "蔚来", "W", false],
  ["brand-xpeng", "小鹏", "X", false],
  ["brand-xiaomi", "小米汽车", "X", false],
] as const;

const USED_CAR_PINYIN_ORDER = [
  "brand-audi",
  "brand-bmw", "brand-mercedes", "brand-honda", "brand-byd",
  "brand-volkswagen", "brand-toyota", "brand-hongqi", "brand-zeekr",
  "brand-li", "brand-tesla", "brand-nio", "brand-aito", "brand-xiaomi", "brand-xpeng",
];
const USED_CAR_HOT_ORDER = ["brand-li", "brand-byd", "brand-tesla", "brand-bmw", "brand-mercedes"];

const USED_CAR_MODEL_SEED: Array<[string, string, string, UsedCarBodyType, UsedCarEnergyType]> = [
  ["model-audi-a4l", "brand-audi", "A4L", "sedan", "petrol"],
  ["model-audi-a6l", "brand-audi", "A6L", "sedan", "petrol"],
  ["model-audi-q5l", "brand-audi", "Q5L", "suv", "petrol"],
  ["model-bmw-3-series", "brand-bmw", "3系", "sedan", "petrol"],
  ["model-bmw-5-series", "brand-bmw", "5系", "sedan", "petrol"],
  ["model-bmw-x3", "brand-bmw", "X3", "suv", "petrol"],
  ["model-mercedes-c-class", "brand-mercedes", "C级", "sedan", "petrol"],
  ["model-mercedes-e-class", "brand-mercedes", "E级", "sedan", "petrol"],
  ["model-mercedes-glc", "brand-mercedes", "GLC", "suv", "petrol"],
  ["model-byd-qin-plus", "brand-byd", "秦PLUS DM-i", "sedan", "plug_in_hybrid"],
  ["model-byd-song-plus", "brand-byd", "宋PLUS DM-i", "suv", "plug_in_hybrid"],
  ["model-byd-han", "brand-byd", "汉DM-i", "sedan", "plug_in_hybrid"],
  ["model-byd-tang", "brand-byd", "唐DM-i", "suv", "plug_in_hybrid"],
  ["model-byd-seal", "brand-byd", "海豹06 DM-i", "sedan", "plug_in_hybrid"],
  ["model-honda-accord", "brand-honda", "雅阁", "sedan", "petrol"],
  ["model-honda-crv", "brand-honda", "CR-V", "suv", "hybrid"],
  ["model-honda-odyssey", "brand-honda", "奥德赛", "mpv", "hybrid"],
  ["model-volkswagen-magotan", "brand-volkswagen", "迈腾", "sedan", "petrol"],
  ["model-volkswagen-tiguan-l", "brand-volkswagen", "途观L", "suv", "petrol"],
  ["model-volkswagen-id4x", "brand-volkswagen", "ID.4 X", "suv", "electric"],
  ["model-toyota-camry", "brand-toyota", "凯美瑞", "sedan", "hybrid"],
  ["model-toyota-rav4", "brand-toyota", "RAV4荣放", "suv", "hybrid"],
  ["model-toyota-highlander", "brand-toyota", "汉兰达", "suv", "hybrid"],
  ["model-hongqi-h5", "brand-hongqi", "H5", "sedan", "petrol"],
  ["model-hongqi-hs5", "brand-hongqi", "HS5", "suv", "petrol"],
  ["model-zeekr-001", "brand-zeekr", "001", "hatchback", "electric"],
  ["model-zeekr-007", "brand-zeekr", "007", "sedan", "electric"],
  ["model-zeekr-7x", "brand-zeekr", "7X", "suv", "electric"],
  ["model-li-l6", "brand-li", "L6", "suv", "range_extended"],
  ["model-li-l7", "brand-li", "L7", "suv", "range_extended"],
  ["model-li-l8", "brand-li", "L8", "suv", "range_extended"],
  ["model-li-l9", "brand-li", "L9", "suv", "range_extended"],
  ["model-tesla-model-3", "brand-tesla", "Model 3", "sedan", "electric"],
  ["model-tesla-model-y", "brand-tesla", "Model Y", "suv", "electric"],
  ["model-aito-m5", "brand-aito", "M5", "suv", "range_extended"],
  ["model-aito-m7", "brand-aito", "M7", "suv", "range_extended"],
  ["model-aito-m9", "brand-aito", "M9", "suv", "range_extended"],
  ["model-nio-et5", "brand-nio", "ET5", "sedan", "electric"],
  ["model-nio-et5t", "brand-nio", "ET5T", "hatchback", "electric"],
  ["model-nio-es6", "brand-nio", "ES6", "suv", "electric"],
  ["model-xpeng-mona-m03", "brand-xpeng", "MONA M03", "sedan", "electric"],
  ["model-xpeng-p7i", "brand-xpeng", "P7i", "sedan", "electric"],
  ["model-xpeng-g6", "brand-xpeng", "G6", "suv", "electric"],
  ["model-xpeng-g9", "brand-xpeng", "G9", "suv", "electric"],
  ["model-xiaomi-su7", "brand-xiaomi", "SU7", "sedan", "electric"],
  ["model-xiaomi-yu7", "brand-xiaomi", "YU7", "suv", "electric"],
];

const USED_CAR_FALLBACK_LISTING_INPUT = [
  ["model-li-l7", "2024款 理想L7 Ultra 四驱旗舰版", 2024, "2024-05-18", 16800, 28680000, 37980000, "银灰色"],
  ["model-li-l7", "2024款 理想L7 Pro 智能焕新版", 2024, "2024-09-06", 9200, 27380000, 34980000, "黑色"],
  ["model-li-l7", "2023款 理想L7 Max 四驱版", 2023, "2023-08-22", 31600, 25480000, 37980000, "绿色"],
  ["model-li-l7", "2023款 理想L7 Air 四驱版", 2023, "2023-11-15", 24800, 23980000, 31980000, "白色"],
  ["model-li-l8", "2023款 理想L8 Pro 六座版", 2023, "2023-06-20", 38200, 26880000, 35980000, "蓝色"],
  ["model-byd-han", "2023款 比亚迪汉DM-i 冠军版", 2023, "2023-10-11", 22600, 16880000, 24980000, "红色"],
  ["model-byd-song-plus", "2023款 宋PLUS DM-i 旗舰型", 2023, "2023-04-03", 40500, 11880000, 16980000, "白色"],
  ["model-tesla-model-3", "2022款 特斯拉Model 3 后轮驱动版", 2022, "2022-12-09", 46200, 13980000, 26590000, "白色"],
  ["model-tesla-model-y", "2023款 特斯拉Model Y 长续航版", 2023, "2023-07-17", 29100, 20980000, 31390000, "黑色"],
  ["model-bmw-3-series", "2022款 宝马325Li M运动套装", 2022, "2022-06-26", 51800, 21880000, 34690000, "蓝色"],
  ["model-bmw-x3", "2021款 宝马X3 xDrive28i", 2021, "2021-09-08", 59600, 24980000, 42580000, "黑色"],
  ["model-mercedes-c-class", "2022款 奔驰C260L 运动版", 2022, "2022-10-16", 33700, 23880000, 35120000, "白色"],
] as const;

const FALLBACK_USED_CAR_LISTINGS: UsedCarListing[] = USED_CAR_FALLBACK_LISTING_INPUT.map((item, index) => {
  const [modelId, title, modelYear, registrationDate, mileageKm, priceFen, guidePriceFen, exteriorColor] = item;
  const modelSeed = USED_CAR_MODEL_SEED.find((model) => model[0] === modelId)!;
  const brandSeed = USED_CAR_BRAND_SEED.find((brand) => brand[0] === modelSeed[1])!;
  const sequence = String(index + 1).padStart(3, "0");
  const coverImageUrl = `/assets/used-cars/listings/used-car-listing-${sequence}/01.webp?v=${USED_CAR_ASSET_VERSION}`;
  return {
    id: `used-car-listing-${sequence}`,
    stockNo: `YXM-UC-${sequence}`,
    title,
    trimName: title.replace(/^\d{4}款\s*/, ""),
    brandId: brandSeed[0],
    brandName: brandSeed[1],
    modelId,
    modelName: modelSeed[2],
    modelYear,
    registrationDate,
    mileageKm,
    priceFen,
    guidePriceFen,
    location: index % 3 === 0 ? "天津·河西区" : index % 3 === 1 ? "天津·南开区" : "天津·滨海新区",
    exteriorColor,
    transferCount: index % 4 === 0 ? 0 : 1,
    energyType: modelSeed[4],
    highlights: index < 4 ? ["一车一档", "支持复检", "维保记录齐全"] : ["车况透明", "本地车源"],
    conditionSummary: "已完成基础外观、内饰与功能项核验；实际车况以到店复检和书面披露为准。",
    defectsDisclosure: index % 3 === 0 ? ["右后轮毂轻微划痕", "前保险杠局部补漆"] : ["正常使用痕迹"],
    status: "on_sale",
    featured: index < 6,
    coverImageUrl,
    images: [1, 2].map((imageIndex) => ({ id: `used-car-image-${sequence}-${imageIndex}`, url: `/assets/used-cars/listings/used-car-listing-${sequence}/${String(imageIndex).padStart(2, "0")}.webp?v=${USED_CAR_ASSET_VERSION}`, sortOrder: imageIndex, isCover: imageIndex === 1 })),
    publishedAt: `2026-08-${String(16 - Math.min(index, 15)).padStart(2, "0")}T10:00:00+08:00`,
    dataKind: "synthetic_demo",
  };
});

function buildFallbackUsedCarCatalog(): UsedCarCatalog {
  const brands: UsedCarBrand[] = USED_CAR_BRAND_SEED.map(([id, name, initial, isHot]) => {
    const models = USED_CAR_MODEL_SEED.filter((model) => model[1] === id).map(([modelId, brandId, modelName, bodyType, energyType], index) => ({
      id: modelId,
      brandId,
      name: modelName,
      bodyType,
      energyType,
      listingCount: FALLBACK_USED_CAR_LISTINGS.filter((listing) => listing.modelId === modelId).length,
      sortOrder: 100 - index,
      isActive: true,
    }));
    return {
      id,
      name,
      initial,
      logoUrl: `/assets/used-cars/logos/${id}.webp`,
      isHot,
      listingCount: models.reduce((total, model) => total + model.listingCount, 0),
      models,
    };
  });
  const initials = [...new Set(brands.map((brand) => brand.initial))].sort();
  return {
    groups: initials.map((initial) => ({
      initial,
      brands: brands
        .filter((brand) => brand.initial === initial)
        .sort((left, right) => USED_CAR_PINYIN_ORDER.indexOf(left.id) - USED_CAR_PINYIN_ORDER.indexOf(right.id)),
    })),
    hotBrands: brands
      .filter((brand) => brand.isHot)
      .sort((left, right) => USED_CAR_HOT_ORDER.indexOf(left.id) - USED_CAR_HOT_ORDER.indexOf(right.id)),
    dataKind: "synthetic_demo",
  };
}

const FALLBACK_USED_CAR_CATALOG = buildFallbackUsedCarCatalog();

type RentalFulfillmentMode = "store_pickup" | "home_delivery";
type RentalEnergyType = "gasoline" | "diesel" | "hybrid" | "plug_in_hybrid" | "range_extended" | "pure_electric";
type RentalVehicleCategory = "economy" | "comfort" | "suv" | "new_energy" | "mpv" | "premium";
type RentalSort = "recommended" | "daily_price_asc" | "total_price_asc";
type RentalOrderStatus = "pending_payment" | "confirmed" | "ready_for_pickup" | "in_use" | "return_pending" | "completed" | "cancelled" | "expired";

type RentalBrand = {
  id: string;
  name: string;
  initial: string;
  logoUrl: string | null;
  isHot: boolean;
  availableModelCount: number;
};

type RentalModel = {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  category: RentalVehicleCategory;
  bodyType: UsedCarBodyType;
  energyType: RentalEnergyType;
  seats: number;
  transmission: string;
  luggage: number;
  rangeKm: number | null;
  imageUrls: string[];
  availableCount: number;
};

type RentalCatalog = {
  groups: Array<{ initial: string; brands: RentalBrand[] }>;
  hotBrands: RentalBrand[];
  models: RentalModel[];
  dataKind: "synthetic_demo";
};

type RentalStore = {
  id: string;
  cityName: string;
  name: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  businessHours: string;
  phone: string;
  deliveryBaseFeeFen: number;
  deliveryIncludedKm: number;
  deliveryPerKmFen: number;
  deliveryMaxRadiusKm: number;
  isDemo: boolean;
};

type RentalAddress = {
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  poiId?: string;
  locationProof?: string;
  source?: "tencent" | "wechat" | "demo";
};

type RentalSearchInput = {
  fulfillmentMode: RentalFulfillmentMode;
  storeId?: string;
  deliveryAddress?: RentalAddress;
  pickupAt: string;
  returnAt: string;
  brandId?: string;
  category?: RentalVehicleCategory | "";
  energyType?: RentalEnergyType | "";
  sort?: RentalSort;
  page?: number;
  pageSize?: number;
};

type RentalOffer = {
  id: string;
  model: RentalModel;
  store: RentalStore;
  fulfillmentMode: RentalFulfillmentMode;
  billableDays: number;
  averageDailyRateFen: number;
  rentalFeeFen: number;
  baseProtectionFeeFen: number;
  prepFeeFen: number;
  deliveryFeeFen: number;
  estimatedTotalFen: number;
  vehicleDepositFen: number;
  violationDepositFen: number;
  availabilityCount: number;
  mileagePolicy: string;
  energyReturnPolicy: string;
  route?: { oneWayDistanceKm: number; driveMinutes: number; source: "tencent_matrix" | "demo_route" } | null;
  dataKind: "synthetic_demo";
};

type RentalOfferPage = {
  items: RentalOffer[];
  total: number;
  page: number;
  pageSize: number;
  search: RentalSearchInput;
};

type RentalQuote = RentalOffer & {
  quoteId: string;
  expiresAt: string;
  pickupAt: string;
  returnAt: string;
  optionalProtectionSelected: boolean;
  optionalProtectionFeeFen: number;
  payableFen: number;
  policyVersion: string;
};

type RentalOrderEvent = { id: string; type: string; title: string; description: string; createdAt: string };

type RentalOrder = {
  id: string;
  orderNumber: string;
  status: RentalOrderStatus;
  quoteId: string;
  model: RentalModel;
  store: RentalStore;
  fulfillmentMode: RentalFulfillmentMode;
  deliveryAddress: RentalAddress | null;
  pickupAt: string;
  returnAt: string;
  billableDays: number;
  driverName: string;
  driverPhone: string;
  validLicenseConfirmed: boolean;
  rentalFeeFen: number;
  baseProtectionFeeFen: number;
  prepFeeFen: number;
  optionalProtectionFeeFen: number;
  deliveryFeeFen: number;
  payableFen: number;
  vehicleDepositFen: number;
  violationDepositFen: number;
  holdExpiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: RentalOrderEvent[];
  dataKind: "synthetic_demo";
};

const RENTAL_ENERGY_LABEL: Record<RentalEnergyType, string> = {
  gasoline: "汽油",
  diesel: "柴油",
  hybrid: "油电混动",
  plug_in_hybrid: "插电混动",
  range_extended: "增程式",
  pure_electric: "纯电动",
};

const RENTAL_CATEGORY_LABEL: Record<RentalVehicleCategory, string> = {
  economy: "经济型",
  comfort: "舒适型",
  suv: "SUV",
  new_energy: "新能源",
  mpv: "MPV",
  premium: "豪华型",
};

const RENTAL_RATE_SEED: Record<string, number> = {
  "model-byd-qin-plus": 15_800,
  "model-xpeng-mona-m03": 15_800,
  "model-honda-accord": 21_800,
  "model-volkswagen-magotan": 21_800,
  "model-toyota-camry": 22_800,
  "model-byd-song-plus": 23_800,
  "model-volkswagen-id4x": 23_800,
  "model-honda-crv": 25_800,
  "model-toyota-rav4": 26_800,
  "model-byd-han": 28_800,
  "model-tesla-model-3": 29_800,
  "model-xpeng-g6": 29_800,
  "model-byd-tang": 32_800,
  "model-nio-et5": 32_800,
  "model-bmw-3-series": 36_800,
  "model-tesla-model-y": 36_800,
  "model-li-l6": 39_800,
  "model-nio-es6": 42_800,
  "model-audi-a4l": 42_800,
  "model-aito-m7": 46_800,
  "model-bmw-x3": 48_800,
  "model-li-l7": 49_800,
  "model-honda-odyssey": 49_800,
  "model-toyota-highlander": 52_800,
  "model-mercedes-glc": 52_800,
  "model-li-l8": 59_800,
  "model-li-l9": 69_800,
  "model-aito-m9": 69_800,
};

function rentalEnergyFromUsedCar(value: UsedCarEnergyType): RentalEnergyType {
  return ({ petrol: "gasoline", diesel: "diesel", hybrid: "hybrid", plug_in_hybrid: "plug_in_hybrid", range_extended: "range_extended", electric: "pure_electric" } satisfies Record<UsedCarEnergyType, RentalEnergyType>)[value];
}

function rentalCategoryForModel(modelId: string, bodyType: UsedCarBodyType, energyType: RentalEnergyType): RentalVehicleCategory {
  if (bodyType === "mpv") return "mpv";
  if (["model-audi-a4l", "model-bmw-3-series", "model-bmw-x3", "model-mercedes-glc", "model-li-l8", "model-li-l9", "model-aito-m9"].includes(modelId)) return "premium";
  if (["pure_electric", "plug_in_hybrid", "range_extended"].includes(energyType)) return "new_energy";
  if (bodyType === "suv") return "suv";
  return (RENTAL_RATE_SEED[modelId] || 21_800) <= 18_800 ? "economy" : "comfort";
}

function rentalLocalIso(daysFromToday: number, hour = 10) {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString();
}

function defaultRentalSearch(stores: RentalStore[]): RentalSearchInput {
  return {
    fulfillmentMode: "store_pickup",
    storeId: stores[0]?.id || "rental-store-airport",
    pickupAt: rentalLocalIso(1),
    returnAt: rentalLocalIso(4),
    sort: "recommended",
    page: 1,
    pageSize: 30,
  };
}

const FALLBACK_RENTAL_STORES: RentalStore[] = [
  { id: "rental-store-airport", cityName: "天津", name: "天津滨海机场店", address: "东丽区机场大道与西二道交口", district: "东丽区", latitude: 39.1254, longitude: 117.3461, businessHours: "08:00–22:00", phone: "022-8888 2601", deliveryBaseFeeFen: 2900, deliveryIncludedKm: 3, deliveryPerKmFen: 600, deliveryMaxRadiusKm: 20, isDemo: true },
  { id: "rental-store-west", cityName: "天津", name: "天津西站店", address: "红桥区西站前街 1 号", district: "红桥区", latitude: 39.1487, longitude: 117.1635, businessHours: "08:00–21:00", phone: "022-8888 2602", deliveryBaseFeeFen: 2900, deliveryIncludedKm: 3, deliveryPerKmFen: 600, deliveryMaxRadiusKm: 20, isDemo: true },
  { id: "rental-store-culture", cityName: "天津", name: "天津文化中心店", address: "河西区平江道 58 号", district: "河西区", latitude: 39.0837, longitude: 117.2197, businessHours: "08:30–20:30", phone: "022-8888 2603", deliveryBaseFeeFen: 2900, deliveryIncludedKm: 3, deliveryPerKmFen: 600, deliveryMaxRadiusKm: 20, isDemo: true },
];

const FALLBACK_RENTAL_ADDRESSES: RentalAddress[] = [
  { title: "天津文化中心", address: "河西区平江道 58 号", district: "河西区", latitude: 39.0837, longitude: 117.2197, poiId: "demo-rental-culture", source: "demo" },
  { title: "天津奥体中心", address: "南开区凌宾路奥体中心", district: "南开区", latitude: 39.0726, longitude: 117.1759, poiId: "demo-rental-olympic", source: "demo" },
  { title: "滨海万达广场", address: "滨海新区洞庭路 4572 号", district: "滨海新区", latitude: 39.0287, longitude: 117.7046, poiId: "demo-rental-binhai", source: "demo" },
];

function buildFallbackRentalCatalog(): RentalCatalog {
  const usedBrands = FALLBACK_USED_CAR_CATALOG.groups.flatMap((group) => group.brands);
  const models = USED_CAR_MODEL_SEED.map(([id, brandId, name, bodyType, usedEnergy]) => {
    const brand = usedBrands.find((item) => item.id === brandId)!;
    const energyType = rentalEnergyFromUsedCar(usedEnergy);
    return {
      id,
      brandId,
      brandName: brand.name,
      name,
      category: rentalCategoryForModel(id, bodyType, energyType),
      bodyType,
      energyType,
      seats: bodyType === "mpv" ? 7 : id.includes("li-l8") || id.includes("li-l9") ? 6 : 5,
      transmission: "自动挡",
      luggage: bodyType === "suv" || bodyType === "mpv" ? 3 : 2,
      rangeKm: energyType === "pure_electric" ? 550 : null,
      imageUrls: [`/assets/used-cars/models/${id}.webp?v=${USED_CAR_ASSET_VERSION}`],
      availableCount: RENTAL_RATE_SEED[id] ? 1 + (id === "model-li-l7" ? 3 : id === "model-tesla-model-y" ? 1 : 0) : 0,
    } satisfies RentalModel;
  });
  const brands = usedBrands.map((brand) => ({
    id: brand.id,
    name: brand.name,
    initial: brand.initial,
    logoUrl: brand.logoUrl,
    isHot: brand.isHot,
    availableModelCount: models.filter((model) => model.brandId === brand.id && model.availableCount > 0).length,
  } satisfies RentalBrand));
  return {
    groups: [...new Set(brands.map((brand) => brand.initial))].sort().map((initial) => ({ initial, brands: brands.filter((brand) => brand.initial === initial) })),
    hotBrands: brands.filter((brand) => brand.isHot),
    models,
    dataKind: "synthetic_demo",
  };
}

const FALLBACK_RENTAL_CATALOG = buildFallbackRentalCatalog();
type PricingEligibility = "supported" | "manual_review";
type PaymentStatus = "unpaid" | "paid" | "partially_refunded" | "refunded";
type MediaKind = "vehicle_front_left" | "vehicle_front_right" | "vehicle_rear_left" | "vehicle_rear_right" | "dashboard_started" | "license_front" | "license_back";

type PickupAddress = {
  poiId: string;
  title: string;
  address: string;
  district: string;
  latitude: number;
  longitude: number;
  source: "tencent" | "wechat" | "demo";
  /** Short-lived server proof binding the POI text and coordinates used for valet pricing. */
  locationProof?: string;
  detail?: string;
  note?: string;
};

type BookingMedia = {
  id: string;
  bookingId?: string | null;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  url: string;
  createdAt: string;
};

type BookingQuote = {
  serviceMode: ServiceMode;
  vehiclePriceCategory: VehiclePriceCategory;
  inspectionFeeFen: number;
  valetFeeFen: number;
  serviceFeeFen: number;
  distanceKm: number | null;
  driveMinutes?: number | null;
  distanceBasis?: "driving_route" | "estimated_distance" | "no_origin";
  serviceable: boolean;
  distanceSource: "tencent_matrix" | "estimated" | "not_calculated" | "manual_review";
  reason?: "origin_required" | "manual_review" | "real_route_required" | "out_of_range";
  pricingEligibility?: PricingEligibility;
  tripType?: "round_trip_same_address" | "legacy_one_way";
  oneWayDistanceKm?: number | null;
  roundTripDistanceKm?: number | null;
  billableDistanceKm?: number | null;
  extraKm?: number;
  quoteSnapshotId?: string;
  expiresAt?: string;
  inspectionItems?: string[];
  matchedPricePlan?: {
    id: string;
    code?: string;
    name: string;
    description?: string;
  } | null;
  vehicleFacts?: VehicleFacts;
  rule?: {
    baseFeeFen: number;
    includedKm: number;
    perKmFen: number;
    maxRadiusKm: number | null;
    scope?: "global" | "station";
    stationId?: string;
    updatedAt?: string;
    version?: string;
  };
  breakdown?: {
    inspectionFeeFen: number;
    valetBaseFeeFen: number;
    valetDistanceFeeFen: number;
    valetFeeFen: number;
    totalFeeFen: number;
  };
};

type VehicleFacts = {
  powertrainType: PowertrainType;
  seats: number;
  usageNature: string;
  vehicleClassCode?: string;
  isVan: boolean;
};

type Vehicle = {
  id: string;
  plateNumber: string;
  vehicleType: string;
  usageNature: string;
  seats: number;
  registrationDate: string;
  inspectionDueDate: string;
  inspectionValidity?: InspectionValidity;
  inspectionDueDateSource?: InspectionValiditySource | "legacy_unverified" | "internal_placeholder" | null;
  inspectionDueDateConfirmedAt?: string | null;
  isDefault: boolean;
  facts?: VehicleFacts;
  powertrainType?: PowertrainType;
  isVan?: boolean;
  pricingEligibility?: PricingEligibility;
  matchedPricePlan?: { planId?: string; label?: string; priceFen?: number } | null;
  inspectionItems?: string[];
  manualReviewReason?: string | null;
  verificationStatus?: "verified" | "pending" | "manual_review" | "rejected";
  verificationNote?: string | null;
  washVehicleCategory?: "sedan" | "suv" | "mpv" | "suv_mpv" | null;
  washVehicleCategoryLegacy?: boolean;
};

type InsuranceRenewalWindow = "within_30_days" | "one_to_three_months" | "over_three_months";
type InsuranceContactWindow = "morning" | "afternoon" | "evening" | "anytime";

type InsuranceDisclosure = {
  mode: "demo" | "real";
  version: string;
  title: string;
  summary: string;
  items: string[];
  acceptsRealData: boolean;
  partner: { id: string; name: string; recipientName: string };
  dataScope: string[];
  purpose: string;
  retention: string;
  consentText: string;
  contactEtaText: string;
};

type InsuranceLeadReceipt = {
  leadCode: string;
  submittedAt: string;
  vehicle: {
    id?: string;
    plateNumber: string;
    modelName: string;
  };
  maskedPhone: string;
  contactEtaText: string;
  withdrawToken: string;
  duplicate: boolean;
  status?: "submitted" | "withdrawn" | string;
};

type InsuranceLeadFieldErrors = Partial<Record<
  "vehicleId" | "contactName" | "contactPhone" | "licensePhoto" | "consentAccepted" | "disclosure",
  string
>>;

type MaterialItem = {
  id: string;
  name: string;
  description: string;
  required: boolean;
};

type InspectionStatus = {
  vehicleId: string;
  dueDays: number;
  eligibility: "eligible" | "manual_review" | "not_due";
  title: string;
  recommendation: string;
  materials: MaterialItem[];
  ruleSource: string;
  ruleUpdatedAt: string;
};

type InspectionDeclarations = InspectionCalculationInput["declarations"];
type InspectionDeclarationValue = InspectionDeclarations[keyof InspectionDeclarations];
type InspectionVehicleInput = InspectionCalculationInput["vehicle"];
type InspectionApiRequest =
  | {
      source: "vehicle";
      vehicleId: string;
      declarations: InspectionDeclarations;
    }
  | {
      source: "temporary";
      vehicle: Pick<InspectionVehicleInput, "registrationMonth" | "vehicleClass" | "usageNature" | "seats"> & { powertrainType: PowertrainType };
      inspectionValidity?: InspectionValidity;
      declarations: InspectionDeclarations;
    };

type InspectionEvidenceFact = {
  code: string;
  label: string;
  value: string;
  source?: "vehicle_profile" | "plate_inferred" | "temporary_input" | "derived" | "unknown" | "conflict";
  state?: "included" | "excluded" | "unknown";
};

type InspectionEvidenceStep = {
  id?: "scope" | "cycle" | "due_date" | "window" | "current_status";
  code?: "scope" | "cycle" | "due_date" | "window" | "current_status";
  title: string;
  expression: string;
  result?: string;
  conclusion?: string;
  sourceIds: string[];
};

type InspectionPowertrainImpact = {
  powertrainType: PowertrainType | "unknown";
  label?: string;
  affectsCycle: false;
  status: "applicable" | "not_applicable_this_cycle" | "needs_verification";
  expectedOnsiteCheckCodes?: string[];
  onsiteItems?: Array<{ code: string; label: string; applicability: "yes" | "no" | "possible"; note?: string }>;
  explanation: string;
  sourceIds: string[];
};

type InspectionEvidence = {
  normalizedFacts: InspectionEvidenceFact[];
  facts?: InspectionEvidenceFact[];
  steps: InspectionEvidenceStep[];
  assumptions: string[];
  powertrainImpact: InspectionPowertrainImpact;
  energy?: InspectionPowertrainImpact;
};

type InspectionDateEvidence = {
  status: "estimated_only" | "matched" | "conflict" | "confirmed_only" | "unavailable";
  estimatedDueDate: string | null;
  confirmedDueDate: string | null;
  confirmedSource: InspectionValiditySource | null;
  confirmedAt?: string | null;
  explanation?: string;
};

type WebInspectionCalculationResult = InspectionCalculationResult & {
  evidence?: InspectionEvidence;
  dateEvidence?: InspectionDateEvidence | Record<string, unknown>;
};

type Station = {
  id: string;
  name: string;
  district: string;
  address: string;
  distanceKm: number | null;
  driveMinutes: number | null;
  distanceBasis: "driving_route" | "estimated_distance" | "no_origin";
  distanceSource: "tencent_matrix" | "estimated" | "not_calculated";
  rating: number;
  reviewCount: number;
  tags: string[];
  serviceFeeFen: number;
  legalName?: string;
  dataKind?: "demo" | "real";
  isDirectOperated?: boolean;
  isPinned?: boolean;
  sortPriority?: number;
  mapPoiId?: string;
  latitude?: number;
  longitude?: number;
  openHours?: string;
  phone?: string | null;
  weeklySchedule?: Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", Array<{ start: string; end: string }>>>;
  businessHoursNotice?: string;
  internalContact?: { name?: string; phone?: string } | null;
  pricePlans?: Array<{ planId: string; isSupported: boolean; priceFen: number }>;
};

type Slot = {
  id: string;
  stationId: string;
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
  remaining: number;
};

type BookingEvent = {
  id: string;
  status: BookingStatus;
  title: string;
  description: string;
  createdAt: string;
  actorType?: "owner" | "operator" | "external_system" | "system";
  metadata?: Record<string, unknown>;
};

type BookingVerification = {
  plateMatched: boolean;
  materialsReady: boolean;
  exteriorRecorded: boolean;
  vehicleConditionConfirmed: boolean;
  notes?: string;
  verifiedAt?: string;
};

type InspectionResult = {
  externalResultId: string;
  conclusion: "passed" | "conditional" | "failed";
  summary: string | Record<string, unknown>;
  source: string;
  receivedAt: string;
};

type Booking = {
  id: string;
  vehicleId: string;
  stationId: string;
  slotId: string;
  contactName: string;
  contactPhone: string;
  serviceFeeFen: number;
  inspectionFeeFen?: number;
  valetFeeFen?: number;
  serviceMode?: ServiceMode;
  vehiclePriceCategory?: VehiclePriceCategory;
  quoteDistanceKm?: number | null;
  quoteDriveMinutes?: number | null;
  quoteDistanceSource?: BookingQuote["distanceSource"];
  quoteSnapshotId?: string | null;
  tripType?: "round_trip_same_address" | "legacy_one_way";
  pricingEligibility?: PricingEligibility;
  priceBreakdown?: BookingQuote["breakdown"];
  paymentStatus?: PaymentStatus;
  fulfillmentStatus?: BookingFulfillmentStatus;
  chargedFen?: number;
  pendingAdjustmentFen?: number;
  paidFen?: number;
  refundedFen?: number;
  amountDueFen?: number;
  internalDriverNote?: string | null;
  ledgerEntries?: Array<{
    id?: string;
    type?: string;
    kind?: string;
    label?: string;
    description?: string;
    amountFen: number;
    direction?: "debit" | "credit";
    confirmationStatus?: "confirmed" | "pending_owner_confirmation" | "voided";
    confirmationIdempotencyKey?: string | null;
    confirmedAt?: string | null;
    status?: string;
    createdAt?: string;
  }>;
  payments?: Array<{
    id?: string;
    provider?: string;
    status?: string;
    amountFen?: number;
    paidAt?: string | null;
    createdAt?: string;
  }>;
  pickupAddress?: PickupAddress | null;
  media?: BookingMedia[];
  notes?: string | null;
  status: BookingStatus;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  createdAt: string;
  updatedAt: string;
  station?: Station;
  vehicle?: Vehicle;
  events?: BookingEvent[];
  verification?: BookingVerification | null;
  inspectionResult?: InspectionResult | null;
  appointmentNumber?: string;
};

type WashVehicleCategory = "sedan" | "suv" | "mpv";
type WashOrderStatus = "pending_payment" | "awaiting_redemption" | "redeemed" | "cancelled" | "refunded" | "expired";
type WashSettlementStatus = "unsettled" | "settled" | "void";

type WashStore = {
  id: string;
  serviceType?: "car_wash";
  name: string;
  district: string;
  address: string;
  latitude?: number | null;
  longitude?: number | null;
  phone?: string | null;
  openHours?: string;
  businessHoursNotice?: string;
  tags?: string[];
  rating?: number;
  reviewCount?: number;
  dataKind?: "demo";
  isActive?: boolean;
  isOpen?: boolean;
  sortPriority?: number;
  startingPriceFen?: number;
  distanceKm?: number | null;
};

type WashPackage = {
  id: string;
  code?: string;
  name: string;
  subtitle?: string;
  description?: string;
  serviceItems: string[];
  durationMinutes: number;
};

type WashOffer = {
  storeId: string;
  packageId: string;
  package: WashPackage;
  vehicleCategory: WashVehicleCategory;
  salePriceFen: number;
  listPriceFen: number;
  estimatedSettlementFen?: number | null;
  isAvailable: boolean;
};

type WashSlot = {
  id: string;
  storeId: string;
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
  isOpen: boolean;
  reservedCount: number;
  remaining: number;
};

type WashQuote = {
  quoteSnapshotId: string;
  expiresAt: string;
  serviceType: "car_wash";
  vehicleCategory: WashVehicleCategory;
  salePriceFen: number;
  listPriceFen: number;
  serviceFeeFen: number;
  serviceMode: ServiceMode;
  tripType?: "round_trip_same_address";
  serviceable: boolean;
  washFeeFen: number;
  valetFeeFen: number;
  totalFeeFen: number;
  pickupAddress?: PickupAddress | null;
  oneWayDistanceKm?: number | null;
  roundTripDistanceKm?: number | null;
  billableDistanceKm?: number | null;
  driveMinutes?: number | null;
  extraKm?: number;
  distanceSource?: "tencent_matrix" | "estimated" | "not_calculated";
  distanceBasis?: "driving_route" | "estimated_distance" | "no_origin";
  reason?: "origin_required" | "real_route_required" | "out_of_range" | "rule_missing";
  valetRule?: {
    scope: "global" | "store";
    storeId?: string | null;
    baseFeeFen: number;
    includedKm: number;
    perKmFen: number;
    maxRadiusKm: number | null;
    updatedAt?: string;
    version?: string;
  } | null;
  breakdown?: {
    washFeeFen: number;
    valetBaseFeeFen: number;
    valetDistanceFeeFen: number;
    valetFeeFen: number;
    totalFeeFen: number;
  };
  vehicleId: string;
  storeId: string;
  packageId: string;
  slotId: string;
  vehicle?: Vehicle;
  store?: WashStore;
  package?: WashPackage;
  slot?: WashSlot;
};

type WashOrderEvent = {
  id: string;
  eventType: string;
  title?: string;
  description?: string;
  actorName?: string | null;
  createdAt: string;
};

type WashOrder = {
  id: string;
  serviceType: "car_wash";
  orderNumber: string;
  vehicleId: string;
  storeId: string;
  packageId: string;
  slotId: string;
  contactName: string;
  contactPhone: string;
  serviceFeeFen: number;
  vehicleCategory?: WashVehicleCategory;
  serviceMode: ServiceMode;
  tripType?: "round_trip_same_address";
  washFeeFen: number;
  valetFeeFen: number;
  totalFeeFen: number;
  pickupAddress?: PickupAddress | null;
  oneWayDistanceKm?: number | null;
  roundTripDistanceKm?: number | null;
  billableDistanceKm?: number | null;
  driveMinutes?: number | null;
  extraKm?: number;
  distanceSource?: "tencent_matrix" | "estimated" | "not_calculated";
  distanceBasis?: "driving_route" | "estimated_distance" | "no_origin";
  valetRule?: WashQuote["valetRule"];
  breakdown?: WashQuote["breakdown"];
  paidFen?: number;
  status: WashOrderStatus;
  settlementStatus?: WashSettlementStatus;
  redemptionCode?: string | null;
  holdExpiresAt?: string | null;
  redeemedAt?: string | null;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  vehicle?: Vehicle;
  store?: WashStore;
  package?: WashPackage;
  slot?: WashSlot;
  events?: WashOrderEvent[];
};

type OperatorStation = Station & {
  businessHours?: string;
  phone?: string;
  supportedVehicleTypes?: string[];
};

type SlotPressure = {
  slotId: string;
  label: string;
  level: "low" | "medium" | "high";
  booked: number;
  capacity: number;
};

type OperatorWorkbench = {
  date: string;
  station: OperatorStation;
  summary: {
    todayBookings: number;
    totalCapacity: number;
    remainingCapacity: number;
    awaitingArrival: number;
    checkedIn: number;
    inspecting: number;
    completed: number;
  };
  pressures: SlotPressure[];
  bookings: Booking[];
};

type OperatorAction = "accept" | "check-in" | "hold" | "resolve-hold" | "handoff" | "complete";

type VehicleInput = Pick<Vehicle, "plateNumber" | "vehicleType" | "usageNature" | "seats" | "registrationDate" | "inspectionDueDate"> & {
  powertrainType: PowertrainType;
  isVan: boolean;
  vehicleClassCode?: string;
  isDefault?: boolean;
  facts?: VehicleFacts;
  inspectionValidity?: InspectionValidity;
  washVehicleCategory: WashVehicleCategory;
};

type PlateProfile = {
  plateKind: PlateKind;
  plateLabel: string;
  energyCategory: EnergyCategory;
  energyLabel: string;
};

const POWERTRAIN_LABELS: Record<PowertrainType, string> = {
  gasoline: "汽油",
  diesel: "柴油",
  hybrid: "油电混合（非插电）",
  pure_electric: "纯电",
  phev: "插混",
  erev: "增程",
  other: "其他能源",
};

const INSPECTION_VALIDITY_SOURCE_LABELS: Record<InspectionValiditySource, string> = {
  traffic_12123: "交管12123",
  electronic_driving_license: "电子行驶证",
  paper_driving_license: "纸质行驶证",
};

const INSPECTION_ITEM_LABELS: Record<string, string> = {
  safety_basic: "基础安全技术检验",
  safety_chassis_extended: "底盘附加项目",
  emissions_gasoline: "汽油排放检验",
  emissions_diesel: "柴油排放检验",
  new_energy_safety: "新能源运行安全服务",
  reinspection: "复检",
};

function inferredPowertrain(vehicle: Pick<Vehicle, "plateNumber" | "vehicleType">): PowertrainType {
  const parsed = parsePlate(vehicle.plateNumber);
  if (parsed.valid && parsed.energyCategory === "pure_electric") return "pure_electric";
  if (parsed.valid && parsed.energyCategory === "non_pure_electric") return "phev";
  return vehicle.vehicleType.includes("柴油") ? "diesel" : "gasoline";
}

function vehiclePowertrain(vehicle: Pick<Vehicle, "plateNumber" | "vehicleType" | "powertrainType" | "facts">): PowertrainType {
  return vehicle.facts?.powertrainType || vehicle.powertrainType || inferredPowertrain(vehicle);
}

function vehicleSeats(vehicle: Pick<Vehicle, "seats" | "facts">) {
  return Number(vehicle.facts?.seats ?? vehicle.seats);
}

function vehicleUsageNature(vehicle: Pick<Vehicle, "usageNature" | "facts">) {
  return vehicle.facts?.usageNature || vehicle.usageNature;
}

function vehicleIsVan(vehicle: Pick<Vehicle, "isVan" | "facts">) {
  return Boolean(vehicle.facts?.isVan ?? vehicle.isVan);
}

function vehicleManualReviewReason(vehicle: Vehicle) {
  if (vehicle.pricingEligibility === "manual_review" || vehicle.verificationStatus === "manual_review") {
    return vehicle.manualReviewReason || vehicle.verificationNote || "车辆分类或计价方案需要工作人员核验";
  }
  return "";
}

function getPlateProfile(vehicle: Pick<Vehicle, "plateNumber" | "vehicleType" | "powertrainType" | "facts">): PlateProfile {
  const parsed = parsePlate(vehicle.plateNumber);
  const powertrain = vehiclePowertrain(vehicle);
  if (parsed.valid) {
    return {
      plateKind: parsed.plateKind,
      plateLabel: parsed.plateKind === "blue" ? "普通蓝牌" : parsed.plateKind === "green_large" ? "新能源大型" : "新能源小型",
      energyCategory: parsed.energyCategory,
      energyLabel: POWERTRAIN_LABELS[powertrain],
    };
  }
  const inferredGreen = vehicle.vehicleType.includes("新能源");
  return {
    plateKind: inferredGreen ? "green_small" : "blue",
    plateLabel: inferredGreen ? "新能源绿牌" : "普通蓝牌",
    energyCategory: inferredGreen ? "pure_electric" : "none",
    energyLabel: POWERTRAIN_LABELS[powertrain],
  };
}

function VehiclePlateBadges({ vehicle, compact = false }: { vehicle: Pick<Vehicle, "plateNumber" | "vehicleType" | "powertrainType" | "facts">; compact?: boolean }) {
  const profile = getPlateProfile(vehicle);
  return (
    <span className={`plate-badges ${compact ? "compact" : ""}`}>
      <i className={profile.plateKind === "blue" ? "blue" : "green"}>{profile.plateLabel}</i>
      <i className="energy">{profile.energyLabel}</i>
    </span>
  );
}

function VehicleReviewNotice({ vehicle }: { vehicle: Vehicle }) {
  const reason = vehicleManualReviewReason(vehicle);
  if (!reason) return null;
  return <p className="vehicle-review-notice"><Warning size={15} /><span><strong>暂不支持在线报价</strong><small>{reason}</small></span></p>;
}

const PROVINCE_OPTIONS = [
  "津",
  "京",
  "冀",
  ...PROVINCE_ABBREVIATIONS.filter((item) => !["津", "京", "冀"].includes(item)),
] as const;
const SERIAL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SERIAL_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

function plateLength(kind: PlateKind) {
  return kind === "blue" ? 7 : 8;
}

function fixedEnergyIndex(kind: PlateKind) {
  return kind === "green_small" ? 2 : kind === "green_large" ? 7 : -1;
}

function energyMark(category: EnergyCategory) {
  return category === "non_pure_electric" ? "F" : "D";
}

function buildPlateCells(kind: PlateKind, category: EnergyCategory, source: string[] = []) {
  const next = Array.from({ length: plateLength(kind) }, (_, index) => source[index] || "");
  if (!next[0]) next[0] = "津";
  if (!next[1]) next[1] = "A";
  const lockedIndex = fixedEnergyIndex(kind);
  if (lockedIndex >= 0) next[lockedIndex] = energyMark(category);
  return next;
}

function initialPlateEditor(value: string | undefined, vehicleType: string | undefined) {
  const parsed = parsePlate(value || "");
  const kind: PlateKind = parsed.valid ? parsed.plateKind : vehicleType?.includes("新能源") ? "green_small" : "blue";
  const category: EnergyCategory = parsed.valid ? parsed.energyCategory : kind === "blue" ? "none" : "pure_electric";
  return {
    kind,
    category,
    cells: buildPlateCells(kind, category, normalizePlate(value || "津A").split("")),
  };
}

function nextEditablePlateIndex(kind: PlateKind, fromIndex: number, direction: 1 | -1 = 1) {
  const lockedIndex = fixedEnergyIndex(kind);
  let index = fromIndex + direction;
  while (index >= 2 && index < plateLength(kind)) {
    if (index !== lockedIndex) return index;
    index += direction;
  }
  return -1;
}

function serialKeyAllowed(kind: PlateKind, index: number, key: string) {
  if (index < 2 || index === fixedEnergyIndex(kind)) return false;
  if (kind === "green_large") return /^\d$/.test(key);
  if (kind === "green_small" && index >= 4) return /^\d$/.test(key);
  return /^[A-HJ-NP-Z0-9]$/.test(key);
}

function normalizePowertrain(value: unknown, vehicle: Pick<Vehicle, "plateNumber" | "vehicleType">): PowertrainType {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "battery_electric") return "pure_electric";
  if (normalized === "hev") return "hybrid";
  if (normalized === "plug_in_hybrid" || normalized === "plugin_hybrid") return "phev";
  if (normalized === "range_extended" || normalized === "range_extender") return "erev";
  if (["gasoline", "diesel", "hybrid", "pure_electric", "phev", "erev", "other"].includes(normalized)) return normalized as PowertrainType;
  return inferredPowertrain(vehicle);
}

function normalizeInspectionValidity(raw: Vehicle): InspectionValidity {
  if (raw.inspectionValidity?.mode === "confirmed") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw.inspectionValidity.validThroughMonth) || !(raw.inspectionValidity.source in INSPECTION_VALIDITY_SOURCE_LABELS)) {
      return { mode: "unconfirmed" };
    }
    return {
      mode: "confirmed",
      validThroughMonth: raw.inspectionValidity.validThroughMonth,
      source: raw.inspectionValidity.source,
      confirmedAt: raw.inspectionValidity.confirmedAt || raw.inspectionDueDateConfirmedAt || null,
    };
  }
  if (raw.inspectionValidity?.mode === "unconfirmed") return { mode: "unconfirmed" };
  if (raw.inspectionDueDateSource && raw.inspectionDueDateSource in INSPECTION_VALIDITY_SOURCE_LABELS && raw.inspectionDueDateConfirmedAt && /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(raw.inspectionDueDate)) {
    return {
      mode: "confirmed",
      validThroughMonth: raw.inspectionDueDate.slice(0, 7),
      source: raw.inspectionDueDateSource as InspectionValiditySource,
      confirmedAt: raw.inspectionDueDateConfirmedAt,
    };
  }
  return { mode: "unconfirmed" };
}

function normalizeWashVehicleCategory(value: unknown, vehicle?: Pick<Vehicle, "vehicleType" | "seats">): WashVehicleCategory {
  if (value === "sedan" || value === "suv" || value === "mpv") return value;
  // Historical `suv_mpv` rows are intentionally read as SUV. A subsequent
  // vehicle save always writes one canonical category and never writes the legacy value.
  if (value === "suv_mpv") return "suv";
  const descriptor = String(vehicle?.vehicleType || "").toLowerCase();
  if (/mpv|商务/.test(descriptor)) return "mpv";
  if (/suv|越野/.test(descriptor)) return "suv";
  return "sedan";
}

function washVehicleCategoryLabel(category: WashVehicleCategory) {
  return ({ sedan: "小轿车", suv: "SUV", mpv: "MPV" } satisfies Record<WashVehicleCategory, string>)[category];
}

function normalizeVehicle(raw: Vehicle): Vehicle {
  const facts = raw.facts;
  const powertrainType = normalizePowertrain(facts?.powertrainType ?? raw.powertrainType, raw);
  const seats = Number(facts?.seats ?? raw.seats ?? 5);
  const usageNature = String(facts?.usageNature ?? raw.usageNature ?? "非营运");
  const isVan = Boolean(facts?.isVan ?? raw.isVan ?? false);
  const rawWashCategory = raw.washVehicleCategory;
  const washVehicleCategory = normalizeWashVehicleCategory(rawWashCategory, { vehicleType: raw.vehicleType, seats });
  return {
    ...raw,
    seats,
    usageNature,
    powertrainType,
    isVan,
    washVehicleCategory,
    // The compatibility badge describes the value received from the API, not
    // stale client state carried through an optimistic/offline object merge.
    // Once a user explicitly saves a canonical category the badge must clear.
    washVehicleCategoryLegacy: rawWashCategory === "suv_mpv",
    inspectionValidity: normalizeInspectionValidity(raw),
    facts: {
      powertrainType,
      seats,
      usageNature,
      vehicleClassCode: facts?.vehicleClassCode,
      isVan,
    },
  };
}

function normalizeStation(raw: Station): Station {
  const isPinned = Boolean(raw.isPinned);
  return {
    ...raw,
    dataKind: raw.dataKind || (raw.name.includes("演示") || raw.address.includes("演示") ? "demo" : "real"),
    isDirectOperated: Boolean(raw.isDirectOperated),
    isPinned,
    sortPriority: Number(raw.sortPriority ?? 0),
  };
}

function normalizeBooking(raw: Booking): Booking {
  const candidateStatus = raw.fulfillmentStatus;
  const validStatuses: BookingStatus[] = ["pending_payment", "paid_pending_confirmation", "confirmed", "driver_arranged", "picked_up", "awaiting_arrival", "checked_in", "inspecting", "result_received", "returning", "completed", "on_hold", "cancelled", "no_show"];
  const fulfillmentStatus: BookingFulfillmentStatus = candidateStatus === "legacy"
    ? "legacy"
    : candidateStatus && validStatuses.includes(candidateStatus as BookingStatus) ? candidateStatus as BookingStatus : raw.status;
  const legacy = raw as Booking & { bookingNumber?: string };
  return {
    ...raw,
    fulfillmentStatus,
    paymentStatus: raw.paymentStatus || (raw.status === "pending_payment" ? "unpaid" : undefined),
    appointmentNumber: raw.appointmentNumber || legacy.bookingNumber,
    ledgerEntries: raw.ledgerEntries?.map((entry) => ({
      ...entry,
      type: entry.type || entry.kind,
      direction: entry.direction || (entry.amountFen < 0 ? "credit" : "debit"),
    })),
    vehicle: raw.vehicle ? normalizeVehicle(raw.vehicle) : raw.vehicle,
    station: raw.station ? normalizeStation(raw.station) : raw.station,
  };
}

function stationIsPinned(station: Station) {
  return Boolean(station.isPinned);
}

function stationIsDemo(station: Station) {
  return station.dataKind === "demo" || station.name.includes("演示") || station.address.includes("演示");
}

function bookingFlowStatus(booking: Booking): BookingStatus {
  if (booking.paymentStatus === "paid" && booking.status === "pending_payment") return "paid_pending_confirmation";
  return booking.fulfillmentStatus && booking.fulfillmentStatus !== "legacy" ? booking.fulfillmentStatus : booking.status;
}

function bookingUsesLegacyValet(booking: Booking) {
  return booking.serviceMode === "valet" && (booking.tripType === "legacy_one_way" || booking.fulfillmentStatus === "legacy");
}

type Store = {
  appRole: AppRole;
  setAppRole: (role: AppRole) => void;
  vehicles: Vehicle[];
  stations: Station[];
  bookings: Booking[];
  activeVehicle: Vehicle | null;
  activeVehicleId: string | null;
  setActiveVehicleId: (id: string) => void;
  selectedStationId: string | null;
  setSelectedStationId: (id: string) => void;
  selectedSlot: Slot | null;
  setSelectedSlot: (slot: Slot | null) => void;
  materialsChecked: Record<string, boolean>;
  toggleMaterial: (id: string) => void;
  apiOnline: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  createVehicle: (input: VehicleInput) => Promise<Vehicle>;
  updateVehicle: (id: string, input: Partial<VehicleInput>) => Promise<Vehicle>;
  deleteVehicle: (id: string) => Promise<void>;
  fetchInspection: (vehicleId: string) => Promise<InspectionStatus>;
  fetchSlots: (stationId: string, date?: string) => Promise<Slot[]>;
  quoteBooking: (input: { vehicleId: string; stationId: string; serviceMode: ServiceMode; pickupAddress?: PickupAddress }) => Promise<BookingQuote>;
  fetchLocationSuggestions: (query: string) => Promise<{ data: PickupAddress[]; source: "tencent" | "demo"; notice: string }>;
  uploadMedia: (kind: MediaKind, file: File) => Promise<BookingMedia>;
  deleteMedia: (id: string) => Promise<void>;
  createBooking: (input: {
    vehicleId: string;
    stationId: string;
    slotId: string;
    contactName: string;
    contactPhone: string;
    serviceMode: ServiceMode;
    pickupAddress?: PickupAddress;
    mediaIds: string[];
    quote: Pick<BookingQuote, "inspectionFeeFen" | "valetFeeFen" | "serviceFeeFen">;
    quoteSnapshotId?: string;
    tripType?: "round_trip_same_address";
    notes?: string;
  }) => Promise<Booking>;
  fetchBooking: (id: string) => Promise<Booking>;
  payBooking: (id: string, idempotencyKey: string) => Promise<Booking>;
  confirmLedgerEntry: (bookingId: string, entryId: string, idempotencyKey: string) => Promise<Booking>;
  cancelBooking: (id: string) => Promise<void>;
  rescheduleBooking: (id: string, slotId: string) => Promise<void>;
  advanceBooking: (id: string) => Promise<Booking>;
  operatorStationId: string;
  operatorDate: string;
  setOperatorStationId: (id: string) => void;
  setOperatorDate: (date: string) => void;
  fetchOperatorWorkbench: (stationId?: string, date?: string) => Promise<OperatorWorkbench>;
  fetchOperatorBooking: (id: string) => Promise<Booking>;
  runOperatorAction: (id: string, action: OperatorAction, payload?: Record<string, unknown>) => Promise<Booking>;
  simulateInspectionResult: (id: string) => Promise<Booking>;
  updateSlotCapacity: (id: string, capacity: number) => Promise<Slot>;
  resetDemo: () => Promise<void>;
  showToast: (message: string) => void;
};

const API_BASE = String(import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const DAY_IN_MS = 86_400_000;

function todayIsoInShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function slotHasStarted(slot: Pick<Slot, "date" | "startTime">, now = new Date()) {
  const today = todayIsoInShanghai(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.date)) return true;
  if (slot.date !== today) return slot.date < today;
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SHANGHAI_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => timeParts.find((item) => item.type === type)?.value || "00";
  const startMatch = /^(\d{1,2}):(\d{2})/.exec(slot.startTime);
  if (!startMatch) return true;
  const startHour = Number(startMatch[1]);
  const startMinute = Number(startMatch[2]);
  if (startHour > 23 || startMinute > 59) return true;
  const startMinutes = startHour * 60 + startMinute;
  const currentMinutes = Number(part("hour")) * 60 + Number(part("minute"));
  return startMinutes <= currentMinutes;
}

function useSlotClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let minuteInterval: number | undefined;
    const refresh = () => setNow(new Date());
    const minuteTimeout = window.setTimeout(() => {
      refresh();
      minuteInterval = window.setInterval(refresh, 60_000);
    }, 60_000 - (Date.now() % 60_000));
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(minuteTimeout);
      if (minuteInterval !== undefined) window.clearInterval(minuteInterval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return now;
}

function isoDateAtUtc(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDaysIso(date: string, amount: number) {
  return new Date(isoDateAtUtc(date) + amount * DAY_IN_MS).toISOString().slice(0, 10);
}

function daysUntilIso(date: string, today = todayIsoInShanghai()) {
  return Math.round((isoDateAtUtc(date) - isoDateAtUtc(today)) / DAY_IN_MS);
}

function formatChineseWeekday(date: string) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(isoDateAtUtc(date)).getUTCDay()];
}

const DEMO_TODAY = todayIsoInShanghai();
const DEMO_INSPECTION_DUE_DATE = addDaysIso(DEMO_TODAY, 18);

const fallbackVehicles: Vehicle[] = [
  {
    id: "veh-demo-1",
    plateNumber: "津A·MVP26",
    vehicleType: "小型轿车",
    usageNature: "非营运",
    seats: 5,
    registrationDate: "2020-08-28",
    inspectionDueDate: DEMO_INSPECTION_DUE_DATE,
    isDefault: true,
    powertrainType: "gasoline",
    isVan: false,
    washVehicleCategory: "sedan",
    facts: { powertrainType: "gasoline", seats: 5, usageNature: "非营运", vehicleClassCode: "passenger_car", isVan: false },
    pricingEligibility: "supported",
  },
];

const fallbackStations: Station[] = [
  {
    id: "station-huayang-1",
    name: "华洋机动车检测站",
    legalName: "天津市华洋机动车检测有限公司",
    district: "滨海新区",
    address: "天津自贸试验区（天津港保税区）海滨大道3680号",
    distanceKm: null,
    driveMinutes: null,
    distanceBasis: "no_origin",
    distanceSource: "not_calculated",
    rating: 0,
    reviewCount: 0,
    tags: ["自营服务", "周日可检", "真实地址"],
    serviceFeeFen: 26000,
    dataKind: "real",
    isDirectOperated: true,
    isPinned: true,
    sortPriority: 100,
    mapPoiId: "10292096120912059203",
    latitude: 39.010471,
    longitude: 117.729669,
    openHours: "周一至周五、周日 08:00–17:00",
    businessHoursNotice: "节假日及当天营业时间请电话确认",
    phone: "022-25781772",
  },
  {
    id: "station-hexi-1",
    name: "河西安心机动车检测服务站",
    district: "河西区",
    address: "解放南路与黑牛城道交口（演示地址）",
    distanceKm: null,
    driveMinutes: null,
    distanceBasis: "no_origin",
    distanceSource: "not_calculated",
    rating: 4.9,
    reviewCount: 2689,
    tags: ["停车充足", "周末可检", "透明收费"],
    serviceFeeFen: 26000,
    dataKind: "demo",
    isDirectOperated: false,
    isPinned: false,
    sortPriority: 0,
  },
  {
    id: "station-nankai-1",
    name: "南开便捷机动车检测服务站",
    district: "南开区",
    address: "华苑产业园附近（演示地址）",
    distanceKm: null,
    driveMinutes: null,
    distanceBasis: "no_origin",
    distanceSource: "not_calculated",
    rating: 4.8,
    reviewCount: 1832,
    tags: ["快速通道", "休息区", "可开发票"],
    serviceFeeFen: 24000,
    dataKind: "demo",
    isDirectOperated: false,
    isPinned: false,
    sortPriority: 0,
  },
  {
    id: "station-hedong-1",
    name: "河东顺行机动车检测服务站",
    district: "河东区",
    address: "卫国道沿线（演示地址）",
    distanceKm: null,
    driveMinutes: null,
    distanceBasis: "no_origin",
    distanceSource: "not_calculated",
    rating: 4.7,
    reviewCount: 1266,
    tags: ["工作日夜场", "代办咨询", "电子报告"],
    serviceFeeFen: 22000,
    dataKind: "demo",
    isDirectOperated: false,
    isPinned: false,
    sortPriority: 0,
  },
];

const fallbackMaterials: MaterialItem[] = [
  { id: "license", name: "机动车行驶证", description: "正副页完整、信息清晰", required: true },
  { id: "insurance", name: "有效期内交强险", description: "支持电子保单演示确认", required: true },
  { id: "identity", name: "车主身份证明", description: "代办人需同时携带本人证件", required: true },
];

const fallbackInspection = (vehicleId: string, inspectionDueDate = DEMO_INSPECTION_DUE_DATE): InspectionStatus => {
  const dueDays = daysUntilIso(inspectionDueDate, DEMO_TODAY);
  const applicationWindow = inspectionApplicationWindow(inspectionDueDate.slice(0, 7));
  const eligibility: InspectionStatus["eligibility"] = DEMO_TODAY < applicationWindow.start
    ? "not_due"
    : DEMO_TODAY <= applicationWindow.end
      ? "eligible"
      : "manual_review";
  return {
    vehicleId,
    dueDays,
    eligibility,
    title: eligibility === "not_due" ? "办理窗口尚未开始" : eligibility === "eligible" ? "已进入预计办理窗口" : "预计已逾期，请先官方核验",
    recommendation: eligibility === "not_due"
      ? `预计办理窗口为 ${applicationWindow.start} 至 ${applicationWindow.end}。`
      : eligibility === "eligible"
        ? `当前处于到期月及前两自然月的预计办理窗口，请先查询本轮办理方式。`
        : `预计办理窗口已于 ${applicationWindow.end} 结束，请先通过交管12123核验真实状态。`,
    materials: fallbackMaterials,
    ruleSource: "天津交管公开规则（演示摘要，以官方最新信息为准）",
    ruleUpdatedAt: DEMO_TODAY,
  };
};

const fallbackSlots = (stationId: string): Slot[] => {
  const today = todayIsoInShanghai();
  return [
    ["slot-1", addDaysIso(today, 1), "09:00", "10:00", 4],
    ["slot-2", addDaysIso(today, 1), "10:30", "11:30", 2],
    ["slot-3", addDaysIso(today, 1), "14:00", "15:00", 5],
    ["slot-4", addDaysIso(today, 2), "09:30", "10:30", 3],
    ["slot-5", addDaysIso(today, 2), "15:30", "16:30", 1],
  ].map(([id, date, startTime, endTime, remaining]) => ({
    id: `${stationId}-${id}`,
    stationId,
    date: String(date),
    startTime: String(startTime),
    endTime: String(endTime),
    capacity: 6,
    remaining: Number(remaining),
  }));
};

function washVehicleCategoryFor(vehicle: Vehicle | null | undefined): WashVehicleCategory {
  if (!vehicle) return "sedan";
  return normalizeWashVehicleCategory(vehicle.washVehicleCategory, vehicle);
}

const fallbackWashStores: WashStore[] = [
  {
    id: "wash-store-haihe-demo",
    serviceType: "car_wash",
    name: "沐光精洗中心（演示）",
    district: "河西区",
    address: "天津市河西区友谊路演示服务点",
    phone: "022-88886601",
    openHours: "08:30–20:30",
    businessHoursNotice: "演示门店，到店前可电话确认",
    tags: ["手工精洗", "室内等候", "免费停车"],
    rating: 4.9,
    reviewCount: 286,
    dataKind: "demo",
    isActive: true,
    isOpen: true,
    sortPriority: 100,
    startingPriceFen: 3800,
    distanceKm: 2.4,
  },
  {
    id: "wash-store-aoche-demo",
    serviceType: "car_wash",
    name: "云净汽车生活馆（演示）",
    district: "南开区",
    address: "天津市南开区宾水西道演示服务点",
    phone: "022-88886602",
    openHours: "09:00–21:00",
    tags: ["标准流程", "晚间可约"],
    rating: 4.8,
    reviewCount: 194,
    dataKind: "demo",
    isActive: true,
    isOpen: true,
    sortPriority: 80,
    startingPriceFen: 3800,
    distanceKm: 4.7,
  },
  {
    id: "wash-store-jingang-demo",
    serviceType: "car_wash",
    name: "澄澈车研社（演示）",
    district: "河东区",
    address: "天津市河东区卫国道演示服务点",
    phone: "022-88886603",
    openHours: "08:00–19:30",
    tags: ["快速洗车", "周末营业"],
    rating: 4.7,
    reviewCount: 128,
    dataKind: "demo",
    isActive: true,
    isOpen: true,
    sortPriority: 60,
    startingPriceFen: 3800,
    distanceKm: 6.1,
  },
];

const fallbackWashPackages: WashPackage[] = [
  {
    id: "wash-package-standard",
    code: "standard",
    name: "标准洗",
    subtitle: "日常快速焕新",
    description: "车身泡沫清洗、轮毂冲洗、玻璃清洁、全车擦干",
    serviceItems: ["车身清洗", "轮毂清洁", "玻璃清洁", "全车擦干"],
    durationMinutes: 35,
  },
  {
    id: "wash-package-detailing",
    code: "premium",
    name: "精致洗",
    subtitle: "内外深度清洁",
    description: "标准洗全部项目，加内饰吸尘、脚垫清洁和细节养护",
    serviceItems: ["标准洗全部项目", "内饰吸尘", "脚垫清洁", "细节养护"],
    durationMinutes: 60,
  },
];

function fallbackWashOffers(storeId: string, category: WashVehicleCategory): WashOffer[] {
  // Offline mode still behaves like an offer catalogue: each category owns an
  // explicit price row. UI components never derive one category from another.
  const pricesByCategory: Record<WashVehicleCategory, readonly [number, number]> = {
    sedan: [3800, 8800],
    suv: [4800, 10800],
    mpv: [5800, 12800],
  };
  const prices = pricesByCategory[category];
  return fallbackWashPackages.map((washPackage, index) => ({
    storeId,
    packageId: washPackage.id,
    package: washPackage,
    vehicleCategory: category,
    salePriceFen: prices[index],
    listPriceFen: prices[index] + (index === 0 ? 1000 : 2000),
    estimatedSettlementFen: Math.round(prices[index] * 0.72),
    isAvailable: true,
  }));
}

function fallbackWashSlots(storeId: string, date?: string): WashSlot[] {
  const dates = Array.from({ length: 5 }, (_, index) => addDaysIso(todayIsoInShanghai(), index));
  const windows = [["09:00", "10:00"], ["10:30", "11:30"], ["14:00", "15:00"], ["16:00", "17:00"]] as const;
  return dates.flatMap((slotDate, dateIndex) => windows.map(([startTime, endTime], windowIndex) => ({
    id: `${storeId}-${slotDate}-${startTime.replace(":", "")}`,
    storeId,
    date: slotDate,
    startTime,
    endTime,
    capacity: 4,
    isOpen: true,
    reservedCount: (dateIndex + windowIndex) % 3,
    remaining: 4 - ((dateIndex + windowIndex) % 3),
  }))).filter((slot) => !date || slot.date === date);
}

const fallbackOperatorVehicles: Vehicle[] = [
  { id: "operator-veh-a", plateNumber: "津B·T1001", vehicleType: "小型轿车", usageNature: "非营运", seats: 5, registrationDate: "2020-08-28", inspectionDueDate: DEMO_INSPECTION_DUE_DATE, isDefault: false },
  { id: "operator-veh-b", plateNumber: "津C·M2036", vehicleType: "小型SUV", usageNature: "非营运", seats: 5, registrationDate: "2021-03-12", inspectionDueDate: addDaysIso(DEMO_TODAY, 90), isDefault: false },
  { id: "operator-veh-c", plateNumber: "津D·D35520", vehicleType: "新能源小型汽车", usageNature: "非营运", seats: 5, registrationDate: "2019-11-08", inspectionDueDate: addDaysIso(DEMO_TODAY, 35), isDefault: false },
  { id: "operator-veh-d", plateNumber: "津E·Q8168", vehicleType: "小型轿车", usageNature: "非营运", seats: 5, registrationDate: "2022-05-19", inspectionDueDate: addDaysIso(DEMO_TODAY, 70), isDefault: false },
  { id: "operator-veh-e", plateNumber: "津F·F66218", vehicleType: "新能源小型汽车", usageNature: "非营运", seats: 5, registrationDate: "2018-06-21", inspectionDueDate: addDaysIso(DEMO_TODAY, -3), isDefault: false },
  { id: "operator-veh-f", plateNumber: "津G·V5208", vehicleType: "小型SUV", usageNature: "非营运", seats: 5, registrationDate: "2023-09-06", inspectionDueDate: addDaysIso(DEMO_TODAY, 120), isDefault: false },
];

const fallbackOperatorBookings: Booking[] = [
  ["operator-booking-a", "operator-veh-a", "张先生", "138****5678", "08:30", "09:00", "awaiting_arrival"],
  ["operator-booking-b", "operator-veh-b", "李女士", "139****2468", "10:00", "10:30", "checked_in"],
  ["operator-booking-c", "operator-veh-c", "王先生", "136****8910", "10:30", "11:00", "inspecting"],
  ["operator-booking-d", "operator-veh-d", "赵女士", "137****1122", "09:00", "09:30", "completed"],
  ["operator-booking-e", "operator-veh-e", "刘先生", "130****3344", "11:30", "12:00", "on_hold"],
  ["operator-booking-f", "operator-veh-f", "周先生", "188****7788", "14:00", "15:00", "result_received"],
].map(([id, vehicleId, contactName, contactPhone, startTime, endTime, status], index) => ({
  id,
  vehicleId,
  stationId: fallbackStations[0].id,
  slotId: `operator-slot-${index + 1}`,
  contactName,
  contactPhone,
  serviceFeeFen: 26000,
  status: status as BookingStatus,
  appointmentDate: DEMO_TODAY,
  startTime,
  endTime,
  createdAt: `${DEMO_TODAY}T08:0${index}:00+08:00`,
  updatedAt: `${DEMO_TODAY}T10:15:00+08:00`,
  station: fallbackStations[0],
  vehicle: fallbackOperatorVehicles.find((item) => item.id === vehicleId),
  appointmentNumber: `YXM${DEMO_TODAY.replaceAll("-", "").slice(2)}${String(index + 1).padStart(3, "0")}`,
  verification: ["checked_in", "inspecting", "completed"].includes(String(status))
    ? { plateMatched: true, materialsReady: true, exteriorRecorded: true, vehicleConditionConfirmed: true, verifiedAt: `${DEMO_TODAY}T10:28:00+08:00` }
    : null,
  inspectionResult: status === "completed"
    ? { externalResultId: "EXT-DEMO-26081101", conclusion: "passed", summary: "安全技术检验演示结果：合格", source: "external_system", receivedAt: `${DEMO_TODAY}T09:02:00+08:00` }
    : null,
}));

function fallbackWorkbench(bookings: Booking[]): OperatorWorkbench {
  const station: OperatorStation = {
    ...fallbackStations[0],
    businessHours: fallbackStations[0].openHours || "周一至周五、周日 08:00–17:00",
    phone: fallbackStations[0].phone || "022-25781772",
    supportedVehicleTypes: ["小型轿车", "小型SUV", "新能源小型车"],
  };
  return {
    date: DEMO_TODAY,
    station,
    summary: {
      todayBookings: bookings.length,
      totalCapacity: 16,
      remainingCapacity: 4,
      awaitingArrival: bookings.filter((item) => ["confirmed", "awaiting_arrival"].includes(item.status)).length,
      checkedIn: bookings.filter((item) => ["checked_in", "on_hold"].includes(item.status)).length,
      inspecting: bookings.filter((item) => ["inspecting", "result_received"].includes(item.status)).length,
      completed: bookings.filter((item) => item.status === "completed").length,
    },
    pressures: [
      { slotId: "operator-slot-pressure", label: "11:00–12:00", level: "high", booked: 4, capacity: 4 },
      { slotId: "operator-slot-afternoon", label: "14:00–15:00", level: "medium", booked: 2, capacity: 4 },
    ],
    bookings,
  };
}

function vehicleRequestPayload(input: VehicleInput) {
  const vehicleClassCode = input.vehicleClassCode || input.facts?.vehicleClassCode || (input.isVan ? "van" : input.vehicleType.includes("大型") ? "large_passenger" : "passenger_car");
  const facts: VehicleFacts = {
    powertrainType: input.powertrainType,
    seats: input.seats,
    usageNature: input.usageNature,
    vehicleClassCode,
    isVan: input.isVan,
  };
  const { inspectionDueDate, ...requestInput } = input;
  const inspectionValidity = input.inspectionValidity ?? { mode: "unconfirmed" as const };
  return {
    ...requestInput,
    washVehicleCategory: normalizeWashVehicleCategory(input.washVehicleCategory, input),
    ...(inspectionValidity.mode === "confirmed" ? { inspectionDueDate } : {}),
    inspectionValidity,
    powertrainType: input.powertrainType,
    vehicleClassCode,
    isVan: input.isVan,
    facts,
  };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = String(init?.method || "GET").toUpperCase();
  const body = init?.body ?? (["POST", "PATCH", "PUT"].includes(method) ? "{}" : undefined);
  const headers = new Headers(init?.headers);
  if (body !== undefined && !(body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    body,
    headers,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "服务暂时不可用") as Error & { code?: string; fields?: unknown; status?: number };
    // Route failures use REAL_ROUTE_REQUIRED as the public error while exposing
    // Tencent's actionable cause in fields.mapErrorCode. Prefer that cause so
    // quota exhaustion can be explained precisely without ever showing a fallback quote.
    error.code = payload?.error?.fields?.mapErrorCode || payload?.error?.code;
    error.fields = payload?.error?.fields;
    error.status = response.status;
    throw error;
  }
  return payload.data as T;
}

function usedCarAssetUrl(value: string | null | undefined) {
  if (!value) return `/assets/used-cars/listings/used-car-listing-001/01.webp?v=${USED_CAR_ASSET_VERSION}`;
  if (/^https?:\/\//.test(value)) return value;
  if (value.startsWith("/api/") && /^https?:\/\//.test(API_BASE)) {
    return `${API_BASE.replace(/\/api$/, "")}${value}`;
  }
  return value;
}

async function loadUsedCarCatalog(): Promise<UsedCarCatalog> {
  try {
    return await apiRequest<UsedCarCatalog>("/used-cars/catalog");
  } catch {
    return FALLBACK_USED_CAR_CATALOG;
  }
}

type UsedCarQuery = {
  brandId?: string;
  modelId?: string;
  priceMinFen?: number;
  priceMaxFen?: number;
  maxMileageKm?: number;
  maxAgeYears?: number;
  energyType?: UsedCarEnergyType | "";
  sort?: UsedCarSort;
  page?: number;
  pageSize?: number;
};

async function loadUsedCarListings(query: UsedCarQuery): Promise<UsedCarListingPage> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  try {
    return await apiRequest<UsedCarListingPage>(`/used-cars/listings?${params.toString()}`);
  } catch {
    let items = [...FALLBACK_USED_CAR_LISTINGS];
    if (query.brandId) items = items.filter((item) => item.brandId === query.brandId);
    if (query.modelId) items = items.filter((item) => item.modelId === query.modelId);
    if (query.priceMinFen !== undefined) items = items.filter((item) => item.priceFen >= query.priceMinFen!);
    if (query.priceMaxFen !== undefined) items = items.filter((item) => item.priceFen <= query.priceMaxFen!);
    if (query.maxMileageKm !== undefined) items = items.filter((item) => item.mileageKm <= query.maxMileageKm!);
    if (query.maxAgeYears !== undefined) items = items.filter((item) => 2026 - item.modelYear <= query.maxAgeYears!);
    if (query.energyType) items = items.filter((item) => item.energyType === query.energyType);
    if (query.sort === "newest") items.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    if (query.sort === "price_asc") items.sort((a, b) => a.priceFen - b.priceFen);
    if (query.sort === "price_desc") items.sort((a, b) => b.priceFen - a.priceFen);
    if (query.sort === "mileage_asc") items.sort((a, b) => a.mileageKm - b.mileageKm);
    if (!query.sort || query.sort === "recommended") items.sort((a, b) => Number(b.featured) - Number(a.featured) || b.priceFen - a.priceFen);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 24;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }
}

async function loadUsedCarListing(id: string): Promise<UsedCarListing> {
  try {
    return await apiRequest<UsedCarListing>(`/used-cars/listings/${encodeURIComponent(id)}`);
  } catch (reason) {
    const fallback = FALLBACK_USED_CAR_LISTINGS.find((item) => item.id === id);
    if (fallback) return fallback;
    throw reason;
  }
}

function usedCarPriceWan(fen: number) {
  return `${(fen / 1_000_000).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}万`;
}

function usedCarMileage(km: number) {
  return `${(km / 10_000).toFixed(1).replace(/\.0$/, "")}万公里`;
}

const USED_CAR_ENERGY_LABEL: Record<UsedCarEnergyType, string> = {
  petrol: "汽油",
  diesel: "柴油",
  hybrid: "油电混合",
  plug_in_hybrid: "插电混动",
  electric: "纯电",
  range_extended: "增程",
};

const USED_CAR_BODY_LABEL: Record<UsedCarBodyType, string> = {
  sedan: "轿车",
  suv: "SUV",
  mpv: "MPV",
  hatchback: "掀背车",
  coupe: "跑车",
  pickup: "皮卡",
};

function canUseInspectionLocalFallback(reason: unknown) {
  if (reason instanceof TypeError) return true;
  if (!(reason instanceof Error)) return false;
  const apiError = reason as Error & { code?: string; status?: number };
  return apiError.code === "ROUTE_NOT_FOUND" || apiError.status === 404 || (apiError.status ?? 0) >= 500;
}

function normalizeWashStore(raw: Record<string, any>): WashStore {
  return {
    ...raw,
    id: String(raw.id),
    serviceType: "car_wash",
    name: String(raw.name || "洗车服务门店（演示）"),
    district: String(raw.district || "天津市"),
    address: String(raw.address || "演示地址"),
    phone: raw.phone ? String(raw.phone) : null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    rating: Number(raw.rating ?? 0),
    reviewCount: Number(raw.reviewCount ?? 0),
    isActive: raw.isActive !== false,
    isOpen: raw.isOpen !== false,
    sortPriority: Number(raw.sortPriority ?? 0),
    startingPriceFen: Number(raw.startingPriceFen ?? 0),
    distanceKm: raw.distanceKm == null ? null : Number(raw.distanceKm),
    latitude: raw.latitude == null ? null : Number(raw.latitude),
    longitude: raw.longitude == null ? null : Number(raw.longitude),
  };
}

function normalizeWashPackage(raw: Record<string, any>): WashPackage {
  return {
    ...raw,
    id: String(raw.id || raw.packageId || raw.code),
    name: String(raw.name || "洗车套餐"),
    serviceItems: (Array.isArray(raw.serviceItems) ? raw.serviceItems : Array.isArray(raw.includedItems) ? raw.includedItems : []).map(String),
    durationMinutes: Number(raw.durationMinutes ?? 40),
  };
}

function normalizeWashOffer(raw: Record<string, any>, fallbackCategory: WashVehicleCategory = "sedan"): WashOffer {
  const washPackage = normalizeWashPackage(raw.package || raw);
  return {
    storeId: String(raw.storeId),
    packageId: String(raw.packageId || washPackage.id),
    package: washPackage,
    vehicleCategory: normalizeWashVehicleCategory(raw.vehicleCategory ?? fallbackCategory),
    salePriceFen: Number(raw.salePriceFen ?? raw.priceFen ?? raw.serviceFeeFen ?? 0),
    listPriceFen: Number(raw.listPriceFen ?? raw.salePriceFen ?? raw.priceFen ?? 0),
    estimatedSettlementFen: raw.estimatedSettlementFen == null ? null : Number(raw.estimatedSettlementFen),
    isAvailable: raw.isAvailable !== false && raw.isActive !== false,
  };
}

function normalizeWashSlot(raw: Record<string, any>): WashSlot {
  return {
    id: String(raw.id),
    storeId: String(raw.storeId),
    date: String(raw.date),
    startTime: String(raw.startTime),
    endTime: String(raw.endTime),
    capacity: Number(raw.capacity ?? 0),
    isOpen: raw.isOpen !== false,
    reservedCount: Number(raw.reservedCount ?? Math.max(0, Number(raw.capacity ?? 0) - Number(raw.remaining ?? 0))),
    remaining: Number(raw.remaining ?? 0),
  };
}

function normalizeWashQuote(raw: Record<string, any>, input: {
  vehicleId: string;
  storeId: string;
  packageId: string;
  slotId: string;
  vehicleCategory: WashVehicleCategory;
  serviceMode?: ServiceMode;
  pickupAddress?: PickupAddress;
}, vehicles: Vehicle[], stores: WashStore[]): WashQuote {
  const storeRaw = raw.store || raw.storeSnapshot;
  const packageRaw = raw.package || raw.packageSnapshot;
  const slotRaw = raw.slot || raw.slotSnapshot;
  const washFeeFen = Number(raw.washFeeFen ?? raw.salePriceFen ?? raw.breakdown?.washFeeFen ?? raw.serviceFeeFen ?? 0);
  const valetFeeFen = Number(raw.valetFeeFen ?? raw.breakdown?.valetFeeFen ?? 0);
  const totalFeeFen = Number(raw.totalFeeFen ?? raw.breakdown?.totalFeeFen ?? raw.serviceFeeFen ?? washFeeFen + valetFeeFen);
  const serviceMode: ServiceMode = raw.serviceMode === "valet" || input.serviceMode === "valet" ? "valet" : "self_drive";
  const pickupAddress = raw.pickupAddress || raw.pickupAddressSnapshot || input.pickupAddress || null;
  const valetRuleRaw = raw.valetRule || raw.rule;
  const breakdownRaw = raw.breakdown;
  return {
    ...raw,
    quoteSnapshotId: String(raw.quoteSnapshotId),
    expiresAt: String(raw.expiresAt),
    serviceType: "car_wash",
    vehicleCategory: normalizeWashVehicleCategory(raw.vehicleCategory ?? input.vehicleCategory),
    salePriceFen: Number(raw.salePriceFen ?? washFeeFen),
    listPriceFen: Number(raw.listPriceFen ?? raw.salePriceFen ?? washFeeFen),
    serviceFeeFen: totalFeeFen,
    serviceMode,
    tripType: serviceMode === "valet" ? "round_trip_same_address" : undefined,
    serviceable: raw.serviceable !== false,
    washFeeFen,
    valetFeeFen,
    totalFeeFen,
    pickupAddress: pickupAddress ? { ...pickupAddress, latitude: Number(pickupAddress.latitude), longitude: Number(pickupAddress.longitude) } : null,
    oneWayDistanceKm: raw.oneWayDistanceKm == null ? null : Number(raw.oneWayDistanceKm),
    roundTripDistanceKm: raw.roundTripDistanceKm == null ? null : Number(raw.roundTripDistanceKm),
    billableDistanceKm: raw.billableDistanceKm == null ? null : Number(raw.billableDistanceKm),
    driveMinutes: raw.driveMinutes == null ? null : Number(raw.driveMinutes),
    extraKm: raw.extraKm == null ? undefined : Number(raw.extraKm),
    distanceSource: raw.distanceSource || (serviceMode === "self_drive" ? "not_calculated" : undefined),
    distanceBasis: raw.distanceBasis || (serviceMode === "self_drive" ? "no_origin" : undefined),
    valetRule: valetRuleRaw ? {
      ...valetRuleRaw,
      scope: valetRuleRaw.scope === "store" ? "store" : "global",
      storeId: valetRuleRaw.storeId == null ? null : String(valetRuleRaw.storeId),
      baseFeeFen: Number(valetRuleRaw.baseFeeFen ?? 0),
      includedKm: Number(valetRuleRaw.includedKm ?? 0),
      perKmFen: Number(valetRuleRaw.perKmFen ?? 0),
      maxRadiusKm: valetRuleRaw.maxRadiusKm == null ? null : Number(valetRuleRaw.maxRadiusKm),
    } : null,
    breakdown: breakdownRaw ? {
      washFeeFen: Number(breakdownRaw.washFeeFen ?? washFeeFen),
      valetBaseFeeFen: Number(breakdownRaw.valetBaseFeeFen ?? 0),
      valetDistanceFeeFen: Number(breakdownRaw.valetDistanceFeeFen ?? 0),
      valetFeeFen: Number(breakdownRaw.valetFeeFen ?? valetFeeFen),
      totalFeeFen: Number(breakdownRaw.totalFeeFen ?? totalFeeFen),
    } : { washFeeFen, valetBaseFeeFen: 0, valetDistanceFeeFen: 0, valetFeeFen, totalFeeFen },
    vehicleId: String(raw.vehicleId || input.vehicleId),
    storeId: String(raw.storeId || storeRaw?.id || input.storeId),
    packageId: String(raw.packageId || packageRaw?.id || input.packageId),
    slotId: String(raw.slotId || slotRaw?.id || input.slotId),
    vehicle: raw.vehicle ? normalizeVehicle(raw.vehicle as Vehicle) : vehicles.find((vehicle) => vehicle.id === input.vehicleId),
    store: storeRaw ? normalizeWashStore(storeRaw) : stores.find((store) => store.id === input.storeId),
    package: packageRaw ? normalizeWashPackage(packageRaw) : fallbackWashPackages.find((item) => item.id === input.packageId),
    slot: slotRaw ? normalizeWashSlot(slotRaw) : fallbackWashSlots(input.storeId).find((item) => item.id === input.slotId),
  };
}

function normalizeWashOrder(raw: Record<string, any>): WashOrder {
  const storeRaw = raw.store || raw.storeSnapshot;
  const packageRaw = raw.package || raw.packageSnapshot;
  const slotRaw = raw.slot || raw.slotSnapshot;
  const vehicleRaw = raw.vehicle || raw.vehicleSnapshot;
  const status = ["pending_payment", "awaiting_redemption", "redeemed", "cancelled", "refunded", "expired"].includes(String(raw.status))
    ? raw.status as WashOrderStatus
    : "pending_payment";
  return {
    ...raw,
    id: String(raw.id),
    serviceType: "car_wash",
    orderNumber: String(raw.orderNumber || raw.appointmentNumber || raw.id || ""),
    vehicleId: String(raw.vehicleId || vehicleRaw?.id || ""),
    storeId: String(raw.storeId || storeRaw?.id || ""),
    packageId: String(raw.packageId || packageRaw?.id || ""),
    slotId: String(raw.slotId || slotRaw?.id || ""),
    contactName: String(raw.contactName || ""),
    contactPhone: String(raw.contactPhone || ""),
    serviceFeeFen: Number(raw.totalFeeFen ?? raw.breakdown?.totalFeeFen ?? raw.serviceFeeFen ?? raw.salePriceFen ?? raw.paidFen ?? 0),
    vehicleCategory: normalizeWashVehicleCategory(raw.vehicleCategory ?? vehicleRaw?.washVehicleCategory, vehicleRaw),
    serviceMode: raw.serviceMode === "valet" ? "valet" : "self_drive",
    tripType: raw.serviceMode === "valet" ? "round_trip_same_address" : undefined,
    washFeeFen: Number(raw.washFeeFen ?? raw.breakdown?.washFeeFen ?? raw.salePriceFen ?? raw.serviceFeeFen ?? 0),
    valetFeeFen: Number(raw.valetFeeFen ?? raw.breakdown?.valetFeeFen ?? 0),
    totalFeeFen: Number(raw.totalFeeFen ?? raw.breakdown?.totalFeeFen ?? raw.serviceFeeFen ?? raw.salePriceFen ?? raw.paidFen ?? 0),
    pickupAddress: raw.pickupAddress || raw.pickupAddressSnapshot || null,
    oneWayDistanceKm: raw.oneWayDistanceKm == null ? null : Number(raw.oneWayDistanceKm),
    roundTripDistanceKm: raw.roundTripDistanceKm == null ? null : Number(raw.roundTripDistanceKm),
    billableDistanceKm: raw.billableDistanceKm == null ? null : Number(raw.billableDistanceKm),
    driveMinutes: raw.driveMinutes == null ? null : Number(raw.driveMinutes),
    extraKm: raw.extraKm == null ? undefined : Number(raw.extraKm),
    distanceSource: raw.distanceSource,
    distanceBasis: raw.distanceBasis,
    valetRule: raw.valetRule || raw.rule || null,
    breakdown: raw.breakdown ? {
      washFeeFen: Number(raw.breakdown.washFeeFen ?? raw.washFeeFen ?? raw.salePriceFen ?? 0),
      valetBaseFeeFen: Number(raw.breakdown.valetBaseFeeFen ?? 0),
      valetDistanceFeeFen: Number(raw.breakdown.valetDistanceFeeFen ?? 0),
      valetFeeFen: Number(raw.breakdown.valetFeeFen ?? raw.valetFeeFen ?? 0),
      totalFeeFen: Number(raw.breakdown.totalFeeFen ?? raw.totalFeeFen ?? raw.serviceFeeFen ?? 0),
    } : undefined,
    paidFen: raw.paidFen == null ? undefined : Number(raw.paidFen),
    status,
    settlementStatus: (["unsettled", "settled", "void"].includes(String(raw.settlementStatus)) ? raw.settlementStatus : status === "cancelled" || status === "refunded" || status === "expired" ? "void" : "unsettled") as WashSettlementStatus,
    redemptionCode: raw.redemptionCode == null ? raw.verificationCode == null ? null : String(raw.verificationCode) : String(raw.redemptionCode),
    holdExpiresAt: raw.holdExpiresAt ? String(raw.holdExpiresAt) : null,
    redeemedAt: raw.redeemedAt ? String(raw.redeemedAt) : null,
    appointmentDate: String(raw.appointmentDate || slotRaw?.date || raw.date || ""),
    startTime: String(raw.startTime || slotRaw?.startTime || ""),
    endTime: String(raw.endTime || slotRaw?.endTime || ""),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    vehicle: vehicleRaw ? normalizeVehicle(vehicleRaw as Vehicle) : undefined,
    store: storeRaw ? normalizeWashStore(storeRaw as Record<string, any>) : undefined,
    package: packageRaw ? normalizeWashPackage(packageRaw as Record<string, any>) : undefined,
    slot: slotRaw ? normalizeWashSlot(slotRaw as Record<string, any>) : undefined,
    events: Array.isArray(raw.events) ? raw.events.map((event: Record<string, any>, index: number) => ({
      id: String(event.id || `${raw.id}-event-${index}`),
      eventType: String(event.eventType || event.type || event.status || "updated"),
      title: event.title ? String(event.title) : undefined,
      description: event.description ? String(event.description) : undefined,
      actorName: event.actorName ? String(event.actorName) : null,
      createdAt: String(event.createdAt || raw.updatedAt || new Date().toISOString()),
    })) : [],
  };
}

const MvpContext = createContext<Store | null>(null);

function useMvp() {
  const value = useContext(MvpContext);
  if (!value) throw new Error("useMvp must be used inside MvpProvider");
  return value;
}

function MvpProvider({ children }: { children: ReactNode }) {
  const keyboard = useKeyboard();
  const [appRole, setAppRoleState] = useState<AppRole>("consumer");
  const [vehicles, setVehicles] = useState<Vehicle[]>(fallbackVehicles);
  const [stations, setStations] = useState<Station[]>(fallbackStations);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [operatorBookings, setOperatorBookings] = useState<Booking[]>(fallbackOperatorBookings);
  const [activeVehicleId, setActiveVehicleId] = useState<string | null>(fallbackVehicles[0].id);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [materialsChecked, setMaterialsChecked] = useState<Record<string, boolean>>({});
  const [operatorStationId, setOperatorStationId] = useState(fallbackStations[0].id);
  const [operatorDate, setOperatorDate] = useState(DEMO_TODAY);
  const [apiOnline, setApiOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };

  const refresh = async () => {
    try {
      const [nextVehicles, nextStations, nextBookings] = await Promise.all([
        apiRequest<Vehicle[]>("/vehicles"),
        apiRequest<Station[]>("/stations"),
        apiRequest<Booking[]>("/bookings"),
      ]);
      const normalizedVehicles = nextVehicles.map(normalizeVehicle);
      setVehicles(normalizedVehicles);
      setStations(nextStations.map(normalizeStation));
      setBookings(nextBookings.map(normalizeBooking));
      setActiveVehicleId((current) =>
        normalizedVehicles.some((item) => item.id === current)
          ? current
          : normalizedVehicles.find((item) => item.isDefault)?.id || normalizedVehicles[0]?.id || null,
      );
      setApiOnline(true);
    } catch {
      setApiOnline(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const activeVehicle = vehicles.find((item) => item.id === activeVehicleId) || vehicles[0] || null;

  const createVehicle = async (input: VehicleInput) => {
    if (apiOnline) {
      const created = normalizeVehicle(await apiRequest<Vehicle>("/vehicles", { method: "POST", body: JSON.stringify(vehicleRequestPayload(input)) }));
      await refresh();
      setActiveVehicleId(created.id);
      return created;
    }
    const created: Vehicle = normalizeVehicle({ ...vehicleRequestPayload(input), inspectionDueDate: input.inspectionDueDate, id: `veh-${Date.now()}`, isDefault: vehicles.length === 0 || Boolean(input.isDefault), pricingEligibility: input.powertrainType === "other" || input.vehicleType.includes("人工确认") ? "manual_review" : "supported" });
    setVehicles((current) => [...current.map((item) => ({ ...item, isDefault: created.isDefault ? false : item.isDefault })), created]);
    setActiveVehicleId(created.id);
    return created;
  };

  const updateVehicle = async (id: string, input: Partial<VehicleInput>) => {
    if (apiOnline) {
      const current = vehicles.find((item) => item.id === id);
      const merged = current ? {
        plateNumber: input.plateNumber ?? current.plateNumber,
        vehicleType: input.vehicleType ?? current.vehicleType,
        usageNature: input.usageNature ?? vehicleUsageNature(current),
        seats: input.seats ?? vehicleSeats(current),
        registrationDate: input.registrationDate ?? current.registrationDate,
        inspectionDueDate: input.inspectionDueDate ?? current.inspectionDueDate,
        inspectionValidity: input.inspectionValidity ?? current.inspectionValidity ?? { mode: "unconfirmed" },
        powertrainType: input.powertrainType ?? vehiclePowertrain(current),
        isVan: input.isVan ?? vehicleIsVan(current),
        isDefault: input.isDefault ?? current.isDefault,
        facts: input.facts ?? current.facts,
        washVehicleCategory: input.washVehicleCategory ?? washVehicleCategoryFor(current),
      } satisfies VehicleInput : input;
      const updated = normalizeVehicle(await apiRequest<Vehicle>(`/vehicles/${id}`, { method: "PATCH", body: JSON.stringify("plateNumber" in merged ? vehicleRequestPayload(merged as VehicleInput) : merged) }));
      await refresh();
      return updated;
    }
    let updated = vehicles.find((item) => item.id === id)!;
    setVehicles((current) =>
      current.map((item) => {
        if (item.id !== id) return input.isDefault ? { ...item, isDefault: false } : item;
        updated = normalizeVehicle({ ...item, ...input, facts: input.facts ? { ...item.facts, ...input.facts } as VehicleFacts : item.facts });
        return updated;
      }),
    );
    return updated;
  };

  const deleteVehicle = async (id: string) => {
    if (apiOnline) await apiRequest(`/vehicles/${id}`, { method: "DELETE" });
    setVehicles((current) => current.filter((item) => item.id !== id));
    if (activeVehicleId === id) setActiveVehicleId(vehicles.find((item) => item.id !== id)?.id || null);
    if (apiOnline) await refresh();
  };

  const fetchInspection = async (vehicleId: string) => {
    if (apiOnline) return apiRequest<InspectionStatus>(`/inspection/status/${vehicleId}`);
    return fallbackInspection(vehicleId, vehicles.find((item) => item.id === vehicleId)?.inspectionDueDate);
  };

  const fetchSlots = async (stationId: string, date?: string) => {
    if (apiOnline) {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      return apiRequest<Slot[]>(`/stations/${stationId}/slots${query}`);
    }
    return fallbackSlots(stationId).filter((item) => !date || item.date === date);
  };

  const quoteBooking = async (input: { vehicleId: string; stationId: string; serviceMode: ServiceMode; pickupAddress?: PickupAddress }) => {
    if (apiOnline) return apiRequest<BookingQuote>("/bookings/quote", { method: "POST", body: JSON.stringify(input) });
    const vehicle = vehicles.find((item) => item.id === input.vehicleId)!;
    const station = stations.find((item) => item.id === input.stationId)!;
    const powertrain = vehiclePowertrain(vehicle);
    const isNewEnergy = ["pure_electric", "phev", "erev"].includes(powertrain);
    const sevenSeat = vehicleSeats(vehicle) >= 7;
    const category: VehiclePriceCategory = `${isNewEnergy ? "new_energy" : "fuel"}_${sevenSeat ? "seven_seat" : "small"}`;
    const inspectionFeeFen = Math.max(0, station.serviceFeeFen + (sevenSeat ? 4000 : 0) + (isNewEnergy ? -2000 : 0));
    // The browser reference must not revive the retired fixed-distance demo.
    // Native mini-program clients provide a real location or pickup address.
    const hasPickupOrigin = input.serviceMode === "valet" && Boolean(input.pickupAddress);
    const valetFeeFen = 0;
    return {
      serviceMode: input.serviceMode,
      vehiclePriceCategory: category,
      inspectionFeeFen,
      valetFeeFen,
      serviceFeeFen: inspectionFeeFen + valetFeeFen,
      distanceKm: null,
      driveMinutes: null,
      distanceBasis: "no_origin" as const,
      serviceable: input.serviceMode === "self_drive",
      distanceSource: "not_calculated" as const,
      pricingEligibility: vehicle.pricingEligibility || "supported",
      tripType: input.serviceMode === "valet" ? "round_trip_same_address" as const : undefined,
      oneWayDistanceKm: null,
      roundTripDistanceKm: null,
      billableDistanceKm: null,
      extraKm: 0,
      rule: { baseFeeFen: 5900, includedKm: 5, perKmFen: 800, maxRadiusKm: 20, scope: "global" as const },
      breakdown: { inspectionFeeFen, valetBaseFeeFen: 0, valetDistanceFeeFen: 0, valetFeeFen, totalFeeFen: inspectionFeeFen + valetFeeFen },
      ...(!hasPickupOrigin && input.serviceMode === "valet" ? { reason: "origin_required" as const } : {}),
    };
  };

  const fetchLocationSuggestions = async (query: string) => {
    if (!apiOnline) {
      return { data: [{ poiId: "demo-local-1", title: "天津文化中心地下停车场", address: "河西区平江道 58 号", district: "河西区", latitude: 39.0837, longitude: 117.2197, source: "demo" as const }], source: "demo" as const, notice: "当前为天津合成演示地址" };
    }
    const response = await fetch(`${API_BASE}/locations/suggestions?query=${encodeURIComponent(query)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "地址联想失败");
    return { data: payload.data as PickupAddress[], source: payload.meta?.source === "tencent" ? "tencent" as const : "demo" as const, notice: String(payload.meta?.notice || "") };
  };

  const uploadMedia = async (kind: MediaKind, file: File) => {
    if (!apiOnline) {
      return { id: `demo-media-${kind}-${Date.now()}`, kind, mimeType: file.type, sizeBytes: file.size, width: 0, height: 0, url: URL.createObjectURL(file), createdAt: new Date().toISOString() };
    }
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file);
    return apiRequest<BookingMedia>("/media", { method: "POST", body: form });
  };

  const deleteMedia = async (id: string) => {
    if (apiOnline) await apiRequest(`/media/${id}`, { method: "DELETE" });
  };

  const createBooking = async (input: {
    vehicleId: string;
    stationId: string;
    slotId: string;
    contactName: string;
    contactPhone: string;
    serviceMode: ServiceMode;
    pickupAddress?: PickupAddress;
    mediaIds: string[];
    quote: Pick<BookingQuote, "inspectionFeeFen" | "valetFeeFen" | "serviceFeeFen">;
    quoteSnapshotId?: string;
    tripType?: "round_trip_same_address";
    notes?: string;
  }) => {
    const slot = selectedSlot?.id === input.slotId ? selectedSlot : null;
    if (!slot || slotHasStarted(slot)) throw new Error("所选时段已过，请重新选择");
    if (apiOnline) {
      const created = normalizeBooking(await apiRequest<Booking>("/bookings", { method: "POST", body: JSON.stringify(input) }));
      await refresh();
      return created;
    }
    const station = stations.find((item) => item.id === input.stationId)!;
    const created: Booking = {
      ...input,
      id: `booking-${Date.now()}`,
      serviceFeeFen: input.quote.serviceFeeFen,
      inspectionFeeFen: input.quote.inspectionFeeFen,
      valetFeeFen: input.quote.valetFeeFen,
      status: "pending_payment",
      fulfillmentStatus: "pending_payment",
      paymentStatus: "unpaid",
      tripType: input.serviceMode === "valet" ? "round_trip_same_address" : undefined,
      quoteSnapshotId: input.quoteSnapshotId || null,
      priceBreakdown: {
        inspectionFeeFen: input.quote.inspectionFeeFen,
        valetBaseFeeFen: input.quote.valetFeeFen,
        valetDistanceFeeFen: 0,
        valetFeeFen: input.quote.valetFeeFen,
        totalFeeFen: input.quote.serviceFeeFen,
      },
      appointmentDate: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      station,
      vehicle: vehicles.find((item) => item.id === input.vehicleId),
      events: [],
    };
    setBookings((current) => [created, ...current]);
    setOperatorBookings((current) => [created, ...current]);
    return created;
  };

  const fetchBooking = async (id: string) => {
    if (apiOnline) return normalizeBooking(await apiRequest<Booking>(`/bookings/${id}`));
    const booking = bookings.find((item) => item.id === id);
    if (!booking) throw new Error("未找到预约");
    return booking;
  };

  const payBooking = async (id: string, idempotencyKey: string) => {
    if (apiOnline) {
      const result = await apiRequest<Booking | { booking?: Booking }>(`/bookings/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({ provider: "mock", idempotencyKey }),
      });
      const returned = "booking" in result && result.booking ? result.booking : result as Booking;
      const updated = returned?.id ? normalizeBooking(returned) : await fetchBooking(id);
      setBookings((current) => current.map((item) => (item.id === id ? updated : item)));
      return updated;
    }
    let updated = bookings.find((item) => item.id === id);
    if (!updated) throw new Error("未找到待支付订单");
    const now = new Date().toISOString();
    updated = {
      ...updated,
      status: "confirmed",
      fulfillmentStatus: "confirmed",
      paymentStatus: "paid",
      updatedAt: now,
      payments: [...(updated.payments || []), { id: `mock-payment-${idempotencyKey}`, provider: "mock", status: "paid", amountFen: updated.serviceFeeFen, paidAt: now, createdAt: now }],
    };
    setBookings((current) => current.map((item) => (item.id === id ? updated! : item)));
    setOperatorBookings((current) => current.map((item) => (item.id === id ? updated! : item)));
    return updated;
  };

  const confirmLedgerEntry = async (bookingId: string, entryId: string, idempotencyKey: string) => {
    if (apiOnline) {
      const result = await apiRequest<{ booking: Booking }>(`/bookings/${bookingId}/ledger/${entryId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey }),
      });
      const updated = normalizeBooking(result.booking);
      setBookings((current) => current.map((item) => (item.id === bookingId ? updated : item)));
      return updated;
    }
    const current = bookings.find((item) => item.id === bookingId);
    if (!current) throw new Error("未找到订单");
    const confirmedAmount = (current.ledgerEntries || []).find((entry) => entry.id === entryId)?.amountFen || 0;
    const updated: Booking = {
      ...current,
      pendingAdjustmentFen: Math.max(0, (current.pendingAdjustmentFen || 0) - confirmedAmount),
      chargedFen: (current.chargedFen ?? current.serviceFeeFen) + confirmedAmount,
      amountDueFen: (current.amountDueFen || 0) + confirmedAmount,
      paymentStatus: "unpaid",
      ledgerEntries: current.ledgerEntries?.map((entry) => entry.id === entryId ? {
        ...entry,
        confirmationStatus: "confirmed",
        confirmationIdempotencyKey: idempotencyKey,
        confirmedAt: new Date().toISOString(),
      } : entry),
    };
    setBookings((items) => items.map((item) => (item.id === bookingId ? updated : item)));
    return updated;
  };

  const cancelBooking = async (id: string) => {
    if (apiOnline) await apiRequest(`/bookings/${id}/cancel`, { method: "POST" });
    setBookings((current) => current.map((item) => (item.id === id ? { ...item, status: "cancelled" } : item)));
    if (apiOnline) await refresh();
  };

  const rescheduleBooking = async (id: string, slotId: string) => {
    if (apiOnline) await apiRequest(`/bookings/${id}/reschedule`, { method: "POST", body: JSON.stringify({ slotId }) });
    if (apiOnline) await refresh();
  };

  const advanceBooking = async (id: string) => {
    if (apiOnline) {
      const advanced = await apiRequest<Booking>(`/demo/bookings/${id}/advance`, { method: "POST" });
      await refresh();
      return advanced;
    }
    const order: BookingStatus[] = ["confirmed", "awaiting_arrival", "checked_in", "inspecting", "result_received", "completed"];
    let updated = bookings.find((item) => item.id === id)!;
    setBookings((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        const next = order[Math.min(order.indexOf(item.status) + 1, order.length - 1)];
        updated = { ...item, status: next };
        return updated;
      }),
    );
    return updated;
  };

  const fetchOperatorWorkbench = async (stationId = operatorStationId, date = operatorDate) => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>(`/operator/workbench?stationId=${encodeURIComponent(stationId)}&date=${encodeURIComponent(date)}`);
      const next: OperatorWorkbench = {
        date: String(raw.businessDate || raw.date || DEMO_TODAY),
        station: { ...fallbackWorkbench(operatorBookings).station, ...(raw.station || {}) },
        summary: {
          todayBookings: Number(raw.summary?.todayBookings ?? raw.bookings?.length ?? 0),
          totalCapacity: Number(raw.summary?.totalCapacity ?? 0),
          remainingCapacity: Number(raw.summary?.remainingCapacity ?? 0),
          awaitingArrival: Number(raw.summary?.awaitingArrival ?? 0),
          checkedIn: Number(raw.summary?.checkedIn ?? 0),
          inspecting: Number(raw.summary?.inspecting ?? 0),
          completed: Number(raw.summary?.completed ?? 0),
        },
        pressures: Array.isArray(raw.pressure) ? raw.pressure : Array.isArray(raw.pressures) ? raw.pressures : [],
        bookings: Array.isArray(raw.bookings) ? raw.bookings.map((item: Booking) => normalizeBooking(item)) : [],
      };
      setOperatorBookings(next.bookings);
      return next;
    }
    return fallbackWorkbench(operatorBookings);
  };

  const fetchOperatorBooking = async (id: string) => {
    if (apiOnline) return normalizeBooking(await apiRequest<Booking>(`/operator/bookings/${id}`));
    const booking = operatorBookings.find((item) => item.id === id);
    if (!booking) throw new Error("未找到履约任务");
    return booking;
  };

  const runOperatorAction = async (id: string, action: OperatorAction, payload: Record<string, unknown> = {}) => {
    if (apiOnline) {
      const apiPayload = action === "check-in" && payload.verification
        ? payload.verification as Record<string, unknown>
        : payload;
      const updated = normalizeBooking(await apiRequest<Booking>(`/operator/bookings/${id}/${action}`, { method: "POST", body: JSON.stringify(apiPayload) }));
      setOperatorBookings((current) => current.map((item) => (item.id === id ? updated : item)));
      return updated;
    }
    const nextStatus: Record<OperatorAction, BookingStatus> = {
      accept: "awaiting_arrival",
      "check-in": "checked_in",
      hold: "on_hold",
      "resolve-hold": "checked_in",
      handoff: "inspecting",
      complete: "completed",
    };
    let updated = operatorBookings.find((item) => item.id === id);
    if (!updated) throw new Error("未找到履约任务");
    updated = {
      ...updated,
      status: nextStatus[action],
      updatedAt: new Date().toISOString(),
      verification: action === "check-in"
        ? Object.assign(
            { plateMatched: true, materialsReady: true, exteriorRecorded: true, vehicleConditionConfirmed: true, verifiedAt: new Date().toISOString() },
            (payload.verification || payload) as Partial<BookingVerification>,
          )
        : updated.verification,
    };
    setOperatorBookings((current) => current.map((item) => (item.id === id ? updated! : item)));
    setBookings((current) => current.map((item) => (item.id === id ? updated! : item)));
    return updated;
  };

  const simulateInspectionResult = async (id: string) => {
    if (apiOnline) {
      const updated = normalizeBooking(await apiRequest<Booking>(`/demo/operator/bookings/${id}/simulate-result`, { method: "POST" }));
      setOperatorBookings((current) => current.map((item) => (item.id === id ? updated : item)));
      return updated;
    }
    let updated = operatorBookings.find((item) => item.id === id);
    if (!updated) throw new Error("未找到履约任务");
    updated = {
      ...updated,
      status: "result_received",
      updatedAt: new Date().toISOString(),
      inspectionResult: {
        externalResultId: `EXT-DEMO-${Date.now().toString().slice(-8)}`,
        conclusion: "passed",
        summary: "安全技术检验演示结果：合格",
        source: "external_system",
        receivedAt: new Date().toISOString(),
      },
    };
    setOperatorBookings((current) => current.map((item) => (item.id === id ? updated! : item)));
    setBookings((current) => current.map((item) => (item.id === id ? updated! : item)));
    return updated;
  };

  const updateSlotCapacity = async (id: string, capacity: number) => {
    if (apiOnline) return apiRequest<Slot>(`/operator/station-slots/${id}`, { method: "PATCH", body: JSON.stringify({ capacity }) });
    const pressure = fallbackWorkbench(operatorBookings).pressures.find((item) => item.slotId === id);
    const booked = pressure?.booked || 0;
    if (capacity < booked) throw new Error(`容量不能低于已预约数量 ${booked}`);
    return { id, stationId: fallbackStations[0].id, date: DEMO_TODAY, startTime: "11:00", endTime: "12:00", capacity, remaining: capacity - booked };
  };

  const resetDemo = async () => {
    if (apiOnline) await apiRequest("/demo/reset", { method: "POST" });
    setVehicles(fallbackVehicles);
    setStations(fallbackStations);
    setBookings([]);
    setOperatorBookings(fallbackOperatorBookings);
    setActiveVehicleId(fallbackVehicles[0].id);
    setSelectedStationId(null);
    setSelectedSlot(null);
    setMaterialsChecked({});
    setOperatorStationId(fallbackStations[0].id);
    setOperatorDate(DEMO_TODAY);
    if (apiOnline) await refresh();
    showToast("演示数据已恢复");
  };

  const value: Store = {
    appRole,
    setAppRole: (role) => {
      keyboard.hide();
      if (role === "operator") {
        const recent = bookings[0];
        if (recent) {
          setOperatorStationId(recent.stationId);
          setOperatorDate(recent.appointmentDate);
        }
      }
      setAppRoleState(role);
      if (role === "consumer" && apiOnline) void refresh();
    },
    vehicles,
    stations,
    bookings,
    activeVehicle,
    activeVehicleId,
    setActiveVehicleId,
    selectedStationId,
    setSelectedStationId,
    selectedSlot,
    setSelectedSlot,
    materialsChecked,
    toggleMaterial: (id) => setMaterialsChecked((current) => ({ ...current, [id]: !current[id] })),
    apiOnline,
    loading,
    refresh,
    createVehicle,
    updateVehicle,
    deleteVehicle,
    fetchInspection,
    fetchSlots,
    quoteBooking,
    fetchLocationSuggestions,
    uploadMedia,
    deleteMedia,
    createBooking,
    fetchBooking,
    payBooking,
    confirmLedgerEntry,
    cancelBooking,
    rescheduleBooking,
    advanceBooking,
    operatorStationId,
    operatorDate,
    setOperatorStationId,
    setOperatorDate,
    fetchOperatorWorkbench,
    fetchOperatorBooking,
    runOperatorAction,
    simulateInspectionResult,
    updateSlotCapacity,
    resetDemo,
    showToast,
  };

  return (
    <MvpContext.Provider value={value}>
      {children}
      {toast ? <div className="app-toast">{toast}</div> : null}
    </MvpContext.Provider>
  );
}

type WashStoreContext = {
  washStores: WashStore[];
  washOrders: WashOrder[];
  washLoading: boolean;
  refreshWash: () => Promise<void>;
  fetchWashOffers: (storeId: string, vehicleCategory: WashVehicleCategory) => Promise<WashOffer[]>;
  fetchWashSlots: (storeId: string, date: string, packageId?: string) => Promise<WashSlot[]>;
  quoteWash: (input: { vehicleId: string; storeId: string; packageId: string; slotId: string; vehicleCategory: WashVehicleCategory; serviceMode?: ServiceMode; pickupAddress?: PickupAddress; tripType?: "round_trip_same_address" }) => Promise<WashQuote>;
  createWashOrder: (input: { quote: WashQuote; contactName: string; contactPhone: string; notes?: string }) => Promise<WashOrder>;
  fetchWashOrder: (id: string) => Promise<WashOrder>;
  payWashOrder: (id: string) => Promise<WashOrder>;
  cancelWashOrder: (id: string, reason?: string) => Promise<WashOrder>;
  rescheduleWashOrder: (id: string, slotId: string) => Promise<WashOrder>;
};

const WashContext = createContext<WashStoreContext | null>(null);

function useWash() {
  const value = useContext(WashContext);
  if (!value) throw new Error("useWash must be used inside WashProvider");
  return value;
}

function washIdempotencyKey(prefix: string) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createFallbackRedemptionCode(orders: WashOrder[]) {
  const used = new Set(orders.filter((order) => order.status === "awaiting_redemption" && order.redemptionCode).map((order) => order.redemptionCode));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const buffer = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(buffer);
    const source = buffer[0] || Math.floor(Math.random() * 1_000_000);
    const candidate = String(source % 1_000_000).padStart(6, "0");
    if (!used.has(candidate)) return candidate;
  }
  return String((Date.now() + orders.length) % 1_000_000).padStart(6, "0");
}

function WashProvider({ children }: { children: ReactNode }) {
  const { apiOnline, vehicles } = useMvp();
  const [washStores, setWashStores] = useState<WashStore[]>(fallbackWashStores);
  const [washOrders, setWashOrders] = useState<WashOrder[]>([]);
  const [washLoading, setWashLoading] = useState(true);

  const refreshWash = async () => {
    if (!apiOnline) {
      setWashLoading(false);
      return;
    }
    const [storesResult, ordersResult] = await Promise.allSettled([
      apiRequest<Record<string, any>[]>("/wash/stores"),
      apiRequest<Record<string, any>[]>("/wash/orders"),
    ]);
    if (storesResult.status === "fulfilled" && storesResult.value.length) {
      setWashStores(storesResult.value.map(normalizeWashStore));
    }
    if (ordersResult.status === "fulfilled") {
      setWashOrders(ordersResult.value.map(normalizeWashOrder));
    }
    setWashLoading(false);
  };

  useEffect(() => {
    void refreshWash();
  }, [apiOnline]);

  const fetchWashOffers = async (storeId: string, vehicleCategory: WashVehicleCategory) => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>[]>(`/wash/stores/${storeId}/offers?vehicleCategory=${vehicleCategory}`);
      return raw.map((item) => normalizeWashOffer(item, vehicleCategory));
    }
    return fallbackWashOffers(storeId, vehicleCategory);
  };

  const fetchWashSlots = async (storeId: string, date: string, packageId?: string) => {
    if (apiOnline) {
      const query = new URLSearchParams({ date });
      if (packageId) query.set("packageId", packageId);
      const raw = await apiRequest<Record<string, any>[]>(`/wash/stores/${storeId}/slots?${query.toString()}`);
      return raw.map(normalizeWashSlot);
    }
    return fallbackWashSlots(storeId, date);
  };

  const quoteWash = async (input: { vehicleId: string; storeId: string; packageId: string; slotId: string; vehicleCategory: WashVehicleCategory; serviceMode?: ServiceMode; pickupAddress?: PickupAddress; tripType?: "round_trip_same_address" }): Promise<WashQuote> => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>("/wash/quotes", { method: "POST", body: JSON.stringify(input) });
      return normalizeWashQuote(raw, input, vehicles, washStores);
    }
    const offer = fallbackWashOffers(input.storeId, input.vehicleCategory).find((item) => item.packageId === input.packageId);
    const slot = fallbackWashSlots(input.storeId).find((item) => item.id === input.slotId);
    if (!offer || !slot || !slot.isOpen || slot.remaining <= 0 || slotHasStarted(slot)) throw new Error("该时段已不可预约，请选择其他时间");
    const serviceMode = input.serviceMode === "valet" ? "valet" : "self_drive";
    const washFeeFen = offer.salePriceFen;
    return {
      quoteSnapshotId: `wash-quote-${Date.now()}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      serviceType: "car_wash",
      salePriceFen: offer.salePriceFen,
      listPriceFen: offer.listPriceFen,
      serviceFeeFen: washFeeFen,
      serviceMode,
      tripType: serviceMode === "valet" ? "round_trip_same_address" : undefined,
      serviceable: serviceMode === "self_drive",
      washFeeFen,
      valetFeeFen: 0,
      totalFeeFen: washFeeFen,
      pickupAddress: input.pickupAddress || null,
      oneWayDistanceKm: null,
      roundTripDistanceKm: null,
      billableDistanceKm: null,
      driveMinutes: null,
      extraKm: 0,
      distanceSource: serviceMode === "valet" ? "estimated" : "not_calculated",
      distanceBasis: serviceMode === "valet" ? "estimated_distance" : "no_origin",
      reason: serviceMode === "valet" ? "real_route_required" : undefined,
      valetRule: { scope: "global", baseFeeFen: 5900, includedKm: 5, perKmFen: 800, maxRadiusKm: 20 },
      breakdown: { washFeeFen, valetBaseFeeFen: 0, valetDistanceFeeFen: 0, valetFeeFen: 0, totalFeeFen: washFeeFen },
      ...input,
      vehicle: vehicles.find((vehicle) => vehicle.id === input.vehicleId),
      store: washStores.find((store) => store.id === input.storeId),
      package: offer.package,
      slot,
    };
  };

  const createWashOrder = async ({ quote, contactName, contactPhone, notes }: { quote: WashQuote; contactName: string; contactPhone: string; notes?: string }) => {
    if (quote.slot && slotHasStarted(quote.slot)) throw new Error("所选时段已过，请重新选择");
    const idempotencyKey = washIdempotencyKey("wash-order");
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>("/wash/orders", {
        method: "POST",
        body: JSON.stringify({ quoteSnapshotId: quote.quoteSnapshotId, idempotencyKey, contactName, contactPhone, notes }),
      });
      const created = normalizeWashOrder(raw.order || raw);
      setWashOrders((current) => [created, ...current.filter((order) => order.id !== created.id)]);
      return created;
    }
    const now = new Date();
    const created = normalizeWashOrder({
      id: `wash-order-${Date.now()}`,
      serviceType: "car_wash",
      orderNumber: `XC${DEMO_TODAY.replaceAll("-", "")}${String(Date.now()).slice(-5)}`,
      vehicleId: quote.vehicleId,
      storeId: quote.storeId,
      packageId: quote.packageId,
      slotId: quote.slotId,
      contactName,
      contactPhone,
      serviceFeeFen: quote.totalFeeFen,
      serviceMode: quote.serviceMode,
      tripType: quote.tripType,
      washFeeFen: quote.washFeeFen,
      valetFeeFen: quote.valetFeeFen,
      totalFeeFen: quote.totalFeeFen,
      pickupAddress: quote.pickupAddress || null,
      oneWayDistanceKm: quote.oneWayDistanceKm,
      roundTripDistanceKm: quote.roundTripDistanceKm,
      billableDistanceKm: quote.billableDistanceKm,
      driveMinutes: quote.driveMinutes,
      extraKm: quote.extraKm,
      distanceSource: quote.distanceSource,
      distanceBasis: quote.distanceBasis,
      valetRule: quote.valetRule,
      breakdown: quote.breakdown,
      status: "pending_payment",
      settlementStatus: "unsettled",
      holdExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      appointmentDate: quote.slot?.date,
      startTime: quote.slot?.startTime,
      endTime: quote.slot?.endTime,
      notes,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      vehicle: quote.vehicle,
      store: quote.store,
      package: quote.package,
      slot: quote.slot,
      events: [{ id: `event-${Date.now()}`, eventType: "created", title: "预约已创建", description: "时段已保留 15 分钟，等待模拟支付", createdAt: now.toISOString() }],
    });
    setWashOrders((current) => [created, ...current]);
    return created;
  };

  const fetchWashOrder = async (id: string) => {
    if (apiOnline) return normalizeWashOrder(await apiRequest<Record<string, any>>(`/wash/orders/${id}`));
    const order = washOrders.find((item) => item.id === id);
    if (!order) throw new Error("未找到洗车订单");
    if (order.status === "pending_payment" && order.holdExpiresAt && Date.parse(order.holdExpiresAt) <= Date.now()) {
      const expired = { ...order, status: "expired" as const, settlementStatus: "void" as const, redemptionCode: null, updatedAt: new Date().toISOString() };
      setWashOrders((current) => current.map((item) => item.id === id ? expired : item));
      return expired;
    }
    return order;
  };

  const payWashOrder = async (id: string) => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>(`/wash/orders/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({ provider: "mock", idempotencyKey: washIdempotencyKey(`wash-payment-${id}`) }),
      });
      const updated = normalizeWashOrder(raw.order || raw);
      setWashOrders((current) => current.map((item) => item.id === id ? updated : item));
      return updated;
    }
    const current = await fetchWashOrder(id);
    if (current.status === "awaiting_redemption") return current;
    if (current.status !== "pending_payment") throw new Error("当前订单状态不能支付");
    const now = new Date().toISOString();
    const updated: WashOrder = {
      ...current,
      status: "awaiting_redemption",
      paidFen: current.serviceFeeFen,
      redemptionCode: createFallbackRedemptionCode(washOrders),
      updatedAt: now,
      events: [...(current.events || []), { id: `event-${Date.now()}`, eventType: "paid", title: "模拟支付成功", description: current.serviceMode === "valet" ? "六位取送核销码已生成，等待平台线下联系车辆交接" : "六位核销码已生成，可到店出示", createdAt: now }],
    };
    setWashOrders((orders) => orders.map((order) => order.id === id ? updated : order));
    return updated;
  };

  const cancelWashOrder = async (id: string, reason = "车主取消预约") => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>(`/wash/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
      const updated = normalizeWashOrder(raw.order || raw);
      setWashOrders((current) => current.map((item) => item.id === id ? updated : item));
      return updated;
    }
    const current = await fetchWashOrder(id);
    if (!["pending_payment", "awaiting_redemption"].includes(current.status)) throw new Error("当前订单不能取消");
    const updated: WashOrder = {
      ...current,
      status: current.status === "awaiting_redemption" ? "refunded" : "cancelled",
      settlementStatus: "void",
      redemptionCode: null,
      updatedAt: new Date().toISOString(),
    };
    setWashOrders((orders) => orders.map((order) => order.id === id ? updated : order));
    return updated;
  };

  const rescheduleWashOrder = async (id: string, slotId: string) => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>(`/wash/orders/${id}/reschedule`, { method: "POST", body: JSON.stringify({ slotId }) });
      const updated = normalizeWashOrder(raw.order || raw);
      setWashOrders((current) => current.map((item) => item.id === id ? updated : item));
      return updated;
    }
    const current = await fetchWashOrder(id);
    if (!["pending_payment", "awaiting_redemption"].includes(current.status)) throw new Error("当前订单不能改期");
    const slot = fallbackWashSlots(current.storeId).find((item) => item.id === slotId);
    if (!slot || !slot.isOpen || slot.remaining <= 0 || slotHasStarted(slot)) throw new Error("该时段不可预约");
    const updated: WashOrder = { ...current, slotId, slot, appointmentDate: slot.date, startTime: slot.startTime, endTime: slot.endTime, updatedAt: new Date().toISOString() };
    setWashOrders((orders) => orders.map((order) => order.id === id ? updated : order));
    return updated;
  };

  const value: WashStoreContext = {
    washStores,
    washOrders,
    washLoading,
    refreshWash,
    fetchWashOffers,
    fetchWashSlots,
    quoteWash,
    createWashOrder,
    fetchWashOrder,
    payWashOrder,
    cancelWashOrder,
    rescheduleWashOrder,
  };

  return <WashContext.Provider value={value}>{children}</WashContext.Provider>;
}

type RentalContextValue = {
  catalog: RentalCatalog;
  stores: RentalStore[];
  orders: RentalOrder[];
  loading: boolean;
  refreshRental: () => Promise<void>;
  searchOffers: (input: RentalSearchInput) => Promise<RentalOfferPage>;
  fetchModel: (id: string) => Promise<RentalModel>;
  createQuote: (input: RentalSearchInput & { modelId: string; optionalProtectionSelected: boolean }) => Promise<RentalQuote>;
  createOrder: (input: { quote: RentalQuote; driverName: string; driverPhone: string; validLicenseConfirmed: boolean }) => Promise<RentalOrder>;
  fetchOrder: (id: string) => Promise<RentalOrder>;
  payOrder: (id: string) => Promise<RentalOrder>;
  cancelOrder: (id: string) => Promise<RentalOrder>;
};

const RentalContext = createContext<RentalContextValue | null>(null);

function useRental() {
  const value = useContext(RentalContext);
  if (!value) throw new Error("useRental must be used inside RentalProvider");
  return value;
}

function rentalBillableDays(pickupAt: string, returnAt: string) {
  return Math.max(1, Math.ceil((Date.parse(returnAt) - Date.parse(pickupAt)) / 86_400_000));
}

function rentalModelImage(modelId: string) {
  return `/assets/used-cars/models/${modelId}.webp?v=${USED_CAR_ASSET_VERSION}`;
}

function normalizeRentalModel(raw: Record<string, any>): RentalModel {
  const id = String(raw.id || raw.modelId);
  const usedSeed = USED_CAR_MODEL_SEED.find((item) => item[0] === id);
  const brandId = String(raw.brandId || usedSeed?.[1] || "");
  const fallbackBrand = FALLBACK_RENTAL_CATALOG.groups.flatMap((group) => group.brands).find((brand) => brand.id === brandId);
  const rawEnergy = String(raw.energyType || usedSeed?.[4] || "gasoline");
  const energyType: RentalEnergyType = ({ petrol: "gasoline", electric: "pure_electric", phev: "plug_in_hybrid", erev: "range_extended" } as Record<string, RentalEnergyType>)[rawEnergy] || rawEnergy as RentalEnergyType;
  const bodyType = String(raw.bodyType || usedSeed?.[3] || "sedan") as UsedCarBodyType;
  const images = Array.isArray(raw.imageUrls) ? raw.imageUrls : Array.isArray(raw.images) ? raw.images.map((image: any) => typeof image === "string" ? image : image.url) : raw.coverImageUrl ? [raw.coverImageUrl] : [];
  return {
    id,
    brandId,
    brandName: String(raw.brandName || raw.brand?.name || fallbackBrand?.name || "演示品牌"),
    name: String(raw.name || raw.modelName || usedSeed?.[2] || "演示车型"),
    category: (raw.category || raw.rentalCategory || rentalCategoryForModel(id, bodyType, energyType)) as RentalVehicleCategory,
    bodyType,
    energyType,
    seats: Number(raw.seats ?? 5),
    transmission: String(raw.transmission || "自动挡"),
    luggage: Number(raw.luggage ?? raw.luggageCount ?? 2),
    rangeKm: raw.rangeKm == null ? null : Number(raw.rangeKm),
    imageUrls: images.length ? images.map(String) : [rentalModelImage(id)],
    availableCount: Number(raw.availableCount ?? raw.availabilityCount ?? 0),
  };
}

function normalizeRentalBrand(raw: Record<string, any>): RentalBrand {
  return {
    id: String(raw.id),
    name: String(raw.name),
    initial: String(raw.initial || raw.pinyinInitial || "#").toUpperCase(),
    logoUrl: raw.logoUrl == null ? null : String(raw.logoUrl),
    isHot: Boolean(raw.isHot),
    availableModelCount: Number(raw.availableModelCount ?? raw.modelCount ?? raw.availableCount ?? 0),
  };
}

function normalizeRentalCatalog(raw: Record<string, any>): RentalCatalog {
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  const groupedBrands = rawGroups.flatMap((group: any) => Array.isArray(group.brands) ? group.brands : []);
  const rawBrands = groupedBrands.length ? groupedBrands : Array.isArray(raw.brands) ? raw.brands : [];
  const nestedModels = rawBrands.flatMap((brand: any) => Array.isArray(brand.models) ? brand.models.map((model: any) => ({ ...model, brandId: model.brandId || brand.id, brandName: model.brandName || brand.name })) : []);
  const rawModels = Array.isArray(raw.models) && raw.models.length ? raw.models : nestedModels;
  const brands = rawBrands.map(normalizeRentalBrand);
  const models = rawModels.map(normalizeRentalModel);
  const initials = [...new Set(brands.map((brand) => brand.initial))].sort();
  return {
    groups: initials.map((initial) => ({ initial, brands: brands.filter((brand) => brand.initial === initial) })),
    hotBrands: (Array.isArray(raw.hotBrands) ? raw.hotBrands.map(normalizeRentalBrand) : brands.filter((brand) => brand.isHot)),
    models,
    dataKind: "synthetic_demo",
  };
}

function normalizeRentalStore(raw: Record<string, any>): RentalStore {
  const delivery = raw.deliveryPricing || raw.deliveryRule || {};
  return {
    id: String(raw.id),
    cityName: String(raw.cityName || raw.city || "天津"),
    name: String(raw.name),
    address: String(raw.address || ""),
    district: String(raw.district || ""),
    latitude: Number(raw.latitude ?? 0),
    longitude: Number(raw.longitude ?? 0),
    businessHours: String(raw.businessHours || raw.openHours || "08:00–20:00"),
    phone: String(raw.phone || ""),
    deliveryBaseFeeFen: Number(raw.deliveryBaseFeeFen ?? delivery.baseFeeFen ?? 2900),
    deliveryIncludedKm: Number(raw.deliveryIncludedKm ?? delivery.includedKm ?? 3),
    deliveryPerKmFen: Number(raw.deliveryPerKmFen ?? delivery.perKmFen ?? 600),
    deliveryMaxRadiusKm: Number(raw.deliveryMaxRadiusKm ?? delivery.maxRadiusKm ?? 20),
    isDemo: raw.isDemo !== false && raw.isSynthetic !== false,
  };
}

function normalizeRentalOffer(raw: Record<string, any>, stores: RentalStore[]): RentalOffer {
  const model = normalizeRentalModel(raw.model || raw);
  const storeRaw = raw.store || raw.fulfillmentStore;
  const store = storeRaw ? normalizeRentalStore(storeRaw) : stores.find((item) => item.id === String(raw.storeId)) || stores[0] || FALLBACK_RENTAL_STORES[0];
  const breakdown = raw.breakdown || raw.priceBreakdown || {};
  const rentalFeeFen = Number(raw.rentalFeeFen ?? breakdown.rentalFeeFen ?? breakdown.vehicleRentalFen ?? 0);
  const mandatoryFeeFen = Number(raw.mandatoryFeeFen ?? 0);
  const prepFeeFen = Number(raw.prepFeeFen ?? breakdown.prepFeeFen ?? breakdown.serviceFeeFen ?? (mandatoryFeeFen ? Math.min(3500, mandatoryFeeFen) : 0));
  const baseProtectionFeeFen = Number(raw.baseProtectionFeeFen ?? breakdown.baseProtectionFeeFen ?? breakdown.basicProtectionFeeFen ?? Math.max(0, mandatoryFeeFen - prepFeeFen));
  const deliveryFeeFen = Number(raw.deliveryFeeFen ?? breakdown.deliveryFeeFen ?? 0);
  const estimatedTotalFen = Number(raw.estimatedTotalFen ?? raw.totalFeeFen ?? raw.payableFen ?? breakdown.totalFeeFen ?? breakdown.payableFen ?? rentalFeeFen + baseProtectionFeeFen + prepFeeFen + deliveryFeeFen);
  const rawAvailability = typeof raw.availability === "number" ? raw.availability : raw.availability?.count ?? raw.availability?.availableCount;
  return {
    id: String(raw.id || raw.offerId || `${store.id}-${model.id}`),
    model,
    store,
    fulfillmentMode: raw.fulfillmentMode === "home_delivery" || raw.serviceMode === "home_delivery" ? "home_delivery" : "store_pickup",
    billableDays: Number(raw.billableDays ?? 1),
    averageDailyRateFen: Number(raw.averageDailyRateFen ?? raw.dailyRateFen ?? Math.round(rentalFeeFen / Math.max(1, Number(raw.billableDays ?? 1)))),
    rentalFeeFen,
    baseProtectionFeeFen,
    prepFeeFen,
    deliveryFeeFen,
    estimatedTotalFen,
    vehicleDepositFen: Number(raw.vehicleDepositFen ?? raw.depositFen ?? breakdown.vehicleDepositFen ?? 500_000),
    violationDepositFen: Number(raw.violationDepositFen ?? breakdown.violationDepositFen ?? 200_000),
    availabilityCount: Number(rawAvailability ?? raw.availabilityCount ?? raw.availableCount ?? model.availableCount),
    mileagePolicy: String(raw.mileagePolicy || "不限里程"),
    energyReturnPolicy: String(raw.energyReturnPolicy || (model.energyType === "pure_electric" ? "同电量还车" : "同油位还车")),
    route: raw.route ? { oneWayDistanceKm: Number(raw.route.oneWayDistanceKm ?? raw.route.distanceKm ?? 0), driveMinutes: Number(raw.route.driveMinutes ?? 0), source: raw.route.source === "tencent_matrix" || raw.route.distanceSource === "tencent_matrix" ? "tencent_matrix" : "demo_route" } : null,
    dataKind: "synthetic_demo",
  };
}

function normalizeRentalQuote(raw: Record<string, any>, stores: RentalStore[]): RentalQuote {
  const breakdown = raw.feeBreakdown || raw.breakdown || raw.priceBreakdown || {};
  const deposits = raw.deposits || {};
  const offer = normalizeRentalOffer({ ...raw, ...breakdown, vehicleDepositFen: deposits.vehicleDepositFen, violationDepositFen: deposits.violationDepositFen }, stores);
  const optionalProtectionFeeFen = Number(raw.optionalProtectionFeeFen ?? breakdown.optionalProtectionFeeFen ?? 0);
  return {
    ...offer,
    quoteId: String(raw.quoteId || raw.quoteSnapshotId || raw.id),
    expiresAt: String(raw.expiresAt),
    pickupAt: String(raw.pickupAt || raw.search?.pickupAt || ""),
    returnAt: String(raw.returnAt || raw.search?.returnAt || ""),
    optionalProtectionSelected: Boolean(raw.optionalProtectionSelected ?? optionalProtectionFeeFen > 0),
    optionalProtectionFeeFen,
    payableFen: Number(raw.payableFen ?? raw.estimatedTotalFen ?? breakdown.totalFeeFen ?? breakdown.payableFen ?? offer.estimatedTotalFen + optionalProtectionFeeFen),
    policyVersion: String(raw.policyVersion || "rental-policy-demo-v1"),
  };
}

function normalizeRentalOrder(raw: Record<string, any>, stores: RentalStore[]): RentalOrder {
  const quoteRaw = raw.quote || raw.quoteSnapshot || raw;
  const breakdown = raw.feeBreakdown || quoteRaw.feeBreakdown || raw.breakdown || {};
  const deposits = raw.deposits || quoteRaw.deposits || {};
  const offer = normalizeRentalOffer({ ...quoteRaw, ...breakdown, model: raw.model || quoteRaw.model, store: raw.store || quoteRaw.store, vehicleDepositFen: deposits.vehicleDepositFen, violationDepositFen: deposits.violationDepositFen }, stores);
  const status = (["pending_payment", "confirmed", "ready_for_pickup", "in_use", "return_pending", "completed", "cancelled", "expired"].includes(String(raw.status)) ? raw.status : "pending_payment") as RentalOrderStatus;
  return {
    id: String(raw.id),
    orderNumber: String(raw.orderNumber || raw.id),
    status,
    quoteId: String(raw.quoteId || raw.quoteSnapshotId || quoteRaw.quoteId || ""),
    model: offer.model,
    store: offer.store,
    fulfillmentMode: raw.fulfillmentMode === "home_delivery" || raw.serviceMode === "home_delivery" ? "home_delivery" : "store_pickup",
    deliveryAddress: raw.deliveryAddress || raw.deliveryAddressSnapshot || null,
    pickupAt: String(raw.pickupAt || quoteRaw.pickupAt || ""),
    returnAt: String(raw.returnAt || quoteRaw.returnAt || ""),
    billableDays: Number(raw.billableDays ?? offer.billableDays),
    driverName: String(raw.driverName || ""),
    driverPhone: String(raw.driverPhone || raw.driverPhoneMasked || ""),
    validLicenseConfirmed: raw.validLicenseConfirmed !== false && raw.licenseConfirmed !== false,
    rentalFeeFen: Number(raw.rentalFeeFen ?? offer.rentalFeeFen),
    baseProtectionFeeFen: Number(raw.baseProtectionFeeFen ?? offer.baseProtectionFeeFen),
    prepFeeFen: Number(raw.prepFeeFen ?? offer.prepFeeFen),
    optionalProtectionFeeFen: Number(raw.optionalProtectionFeeFen ?? breakdown.optionalProtectionFeeFen ?? 0),
    deliveryFeeFen: Number(raw.deliveryFeeFen ?? offer.deliveryFeeFen),
    payableFen: Number(raw.payableFen ?? raw.totalFeeFen ?? breakdown.totalFeeFen ?? offer.estimatedTotalFen),
    vehicleDepositFen: Number(raw.vehicleDepositFen ?? offer.vehicleDepositFen),
    violationDepositFen: Number(raw.violationDepositFen ?? offer.violationDepositFen),
    holdExpiresAt: raw.holdExpiresAt ? String(raw.holdExpiresAt) : null,
    paidAt: raw.paidAt ? String(raw.paidAt) : null,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    events: Array.isArray(raw.events) ? raw.events.map((event: any, index: number) => ({ id: String(event.id || `${raw.id}-event-${index}`), type: String(event.type || event.eventType || "updated"), title: String(event.title || "订单已更新"), description: String(event.description || ""), createdAt: String(event.createdAt || raw.updatedAt || new Date().toISOString()) })) : [],
    dataKind: "synthetic_demo",
  };
}

function fallbackRentalOffers(input: RentalSearchInput): RentalOfferPage {
  const billableDays = rentalBillableDays(input.pickupAt, input.returnAt);
  const baseStore = FALLBACK_RENTAL_STORES.find((store) => store.id === input.storeId) || FALLBACK_RENTAL_STORES[0];
  const store = input.fulfillmentMode === "home_delivery" ? FALLBACK_RENTAL_STORES[2] : baseStore;
  const pickupDate = new Date(input.pickupAt);
  let models = FALLBACK_RENTAL_CATALOG.models.filter((model) => model.availableCount > 0 && RENTAL_RATE_SEED[model.id]);
  if (input.brandId) models = models.filter((model) => model.brandId === input.brandId);
  if (input.category) models = models.filter((model) => model.category === input.category);
  if (input.energyType) models = models.filter((model) => model.energyType === input.energyType);
  const items = models.map((model, index) => {
    let rentalFeeFen = 0;
    for (let day = 0; day < billableDays; day += 1) {
      const date = new Date(pickupDate);
      date.setDate(date.getDate() + day);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      rentalFeeFen += Math.round(RENTAL_RATE_SEED[model.id] * (weekend ? 1.15 : 1));
    }
    const baseProtectionFeeFen = 6000 * billableDays;
    const prepFeeFen = 3500;
    const oneWayDistanceKm = input.fulfillmentMode === "home_delivery" ? 4.8 + (index % 3) * 0.6 : 0;
    const deliveryFeeFen = input.fulfillmentMode === "home_delivery" ? store.deliveryBaseFeeFen + Math.ceil(Math.max(0, oneWayDistanceKm - store.deliveryIncludedKm)) * store.deliveryPerKmFen : 0;
    const rate = RENTAL_RATE_SEED[model.id];
    const vehicleDepositFen = rate >= 55_000 ? 800_000 : rate >= 30_000 ? 500_000 : 300_000;
    return {
      id: `${store.id}-${model.id}`,
      model,
      store,
      fulfillmentMode: input.fulfillmentMode,
      billableDays,
      averageDailyRateFen: Math.round(rentalFeeFen / billableDays),
      rentalFeeFen,
      baseProtectionFeeFen,
      prepFeeFen,
      deliveryFeeFen,
      estimatedTotalFen: rentalFeeFen + baseProtectionFeeFen + prepFeeFen + deliveryFeeFen,
      vehicleDepositFen,
      violationDepositFen: 200_000,
      availabilityCount: model.availableCount,
      mileagePolicy: model.category === "premium" ? "含300公里/日" : "不限里程",
      energyReturnPolicy: model.energyType === "pure_electric" ? "同电量还车" : "同油位还车",
      route: input.fulfillmentMode === "home_delivery" ? { oneWayDistanceKm, driveMinutes: Math.round(12 + oneWayDistanceKm * 2), source: "demo_route" as const } : null,
      dataKind: "synthetic_demo" as const,
    };
  });
  const sorted = [...items].sort((left, right) => input.sort === "daily_price_asc" ? left.averageDailyRateFen - right.averageDailyRateFen : input.sort === "total_price_asc" ? left.estimatedTotalFen - right.estimatedTotalFen : (right.model.availableCount - left.model.availableCount) || left.averageDailyRateFen - right.averageDailyRateFen);
  return { items: sorted, total: sorted.length, page: 1, pageSize: input.pageSize || 30, search: input };
}

function RentalProvider({ children }: { children: ReactNode }) {
  const { apiOnline } = useMvp();
  const [catalog, setCatalog] = useState<RentalCatalog>(FALLBACK_RENTAL_CATALOG);
  const [stores, setStores] = useState<RentalStore[]>(FALLBACK_RENTAL_STORES);
  const [orders, setOrders] = useState<RentalOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshRental = async () => {
    if (!apiOnline) {
      setLoading(false);
      return;
    }
    const [catalogResult, storesResult, ordersResult] = await Promise.allSettled([
      apiRequest<Record<string, any>>("/car-rental/catalog"),
      apiRequest<Record<string, any>[]>("/car-rental/stores"),
      apiRequest<Record<string, any>[]>("/car-rental/orders"),
    ]);
    if (catalogResult.status === "fulfilled") setCatalog(normalizeRentalCatalog(catalogResult.value));
    if (storesResult.status === "fulfilled" && storesResult.value.length) setStores(storesResult.value.map(normalizeRentalStore));
    if (ordersResult.status === "fulfilled") setOrders(ordersResult.value.map((order) => normalizeRentalOrder(order, stores)));
    setLoading(false);
  };

  useEffect(() => { void refreshRental(); }, [apiOnline]);

  const searchOffers = async (input: RentalSearchInput) => {
    if (!apiOnline) return fallbackRentalOffers(input);
    const apiSort = input.sort === "daily_price_asc" ? "price_asc" : input.sort === "total_price_asc" ? "price_asc" : "recommended";
    const raw = await apiRequest<Record<string, any>>("/car-rental/offers/search", { method: "POST", body: JSON.stringify({ ...input, serviceMode: input.fulfillmentMode, fulfillmentMode: undefined, category: undefined, sort: apiSort }) });
    const rawItems = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    let items = rawItems.map((item: Record<string, any>) => normalizeRentalOffer({ ...item, store: item.store || raw.store, billableDays: item.billableDays ?? raw.billableDays, serviceMode: item.serviceMode || raw.search?.serviceMode || input.fulfillmentMode, route: item.route || raw.route }, stores));
    if (input.category) items = items.filter((item) => item.model.category === input.category);
    if (input.sort === "total_price_asc") items.sort((left, right) => left.estimatedTotalFen - right.estimatedTotalFen);
    return { items, total: items.length, page: Number(raw.page ?? 1), pageSize: Number(raw.pageSize ?? input.pageSize ?? 30), search: { ...input, ...(raw.search || {}), fulfillmentMode: raw.search?.serviceMode || input.fulfillmentMode } as RentalSearchInput };
  };

  const fetchModel = async (id: string) => {
    if (!apiOnline) {
      const model = catalog.models.find((item) => item.id === id) || FALLBACK_RENTAL_CATALOG.models.find((item) => item.id === id);
      if (!model) throw new Error("未找到租赁车型");
      return model;
    }
    return normalizeRentalModel(await apiRequest<Record<string, any>>(`/car-rental/models/${encodeURIComponent(id)}`));
  };

  const createQuote = async (input: RentalSearchInput & { modelId: string; optionalProtectionSelected: boolean }) => {
    if (apiOnline) return normalizeRentalQuote(await apiRequest<Record<string, any>>("/car-rental/quotes", { method: "POST", body: JSON.stringify({ ...input, serviceMode: input.fulfillmentMode, fulfillmentMode: undefined, category: undefined, sort: undefined, addOptionalProtection: input.optionalProtectionSelected, optionalProtectionSelected: undefined }) }), stores);
    const offer = fallbackRentalOffers(input).items.find((item) => item.model.id === input.modelId);
    if (!offer) throw new Error("该车型在所选租期暂无可租车辆");
    const optionalProtectionFeeFen = input.optionalProtectionSelected ? offer.billableDays * 6000 : 0;
    return { ...offer, quoteId: `rental-quote-${Date.now()}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), pickupAt: input.pickupAt, returnAt: input.returnAt, optionalProtectionSelected: input.optionalProtectionSelected, optionalProtectionFeeFen, payableFen: offer.estimatedTotalFen + optionalProtectionFeeFen, policyVersion: "rental-policy-demo-v1" };
  };

  const createOrder = async ({ quote, driverName, driverPhone, validLicenseConfirmed }: { quote: RentalQuote; driverName: string; driverPhone: string; validLicenseConfirmed: boolean }) => {
    const idempotencyKey = washIdempotencyKey("rental-order");
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>("/car-rental/orders", { method: "POST", body: JSON.stringify({ quoteId: quote.quoteId, idempotencyKey, driverName, driverPhone, licenseConfirmed: validLicenseConfirmed }) });
      const created = normalizeRentalOrder(raw.order || raw, stores);
      setOrders((current) => [created, ...current.filter((order) => order.id !== created.id)]);
      return created;
    }
    if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error("报价已过期，请重新确认车型");
    const now = new Date();
    const created: RentalOrder = {
      id: `rental-order-${Date.now()}`,
      orderNumber: `ZC${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(Date.now()).slice(-5)}`,
      status: "pending_payment",
      quoteId: quote.quoteId,
      model: quote.model,
      store: quote.store,
      fulfillmentMode: quote.fulfillmentMode,
      deliveryAddress: quote.fulfillmentMode === "home_delivery" ? null : null,
      pickupAt: quote.pickupAt,
      returnAt: quote.returnAt,
      billableDays: quote.billableDays,
      driverName,
      driverPhone,
      validLicenseConfirmed,
      rentalFeeFen: quote.rentalFeeFen,
      baseProtectionFeeFen: quote.baseProtectionFeeFen,
      prepFeeFen: quote.prepFeeFen,
      optionalProtectionFeeFen: quote.optionalProtectionFeeFen,
      deliveryFeeFen: quote.deliveryFeeFen,
      payableFen: quote.payableFen,
      vehicleDepositFen: quote.vehicleDepositFen,
      violationDepositFen: quote.violationDepositFen,
      holdExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      paidAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      events: [{ id: `rental-event-${Date.now()}`, type: "created", title: "租车订单已创建", description: "车型容量已保留15分钟，等待模拟支付", createdAt: now.toISOString() }],
      dataKind: "synthetic_demo",
    };
    setOrders((current) => [created, ...current]);
    return created;
  };

  const fetchOrder = async (id: string) => {
    if (apiOnline) return normalizeRentalOrder(await apiRequest<Record<string, any>>(`/car-rental/orders/${id}`), stores);
    const order = orders.find((item) => item.id === id);
    if (!order) throw new Error("未找到租车订单");
    if (order.status === "pending_payment" && order.holdExpiresAt && Date.parse(order.holdExpiresAt) <= Date.now()) {
      const expired = { ...order, status: "expired" as const, updatedAt: new Date().toISOString() };
      setOrders((current) => current.map((item) => item.id === id ? expired : item));
      return expired;
    }
    return order;
  };

  const payOrder = async (id: string) => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>(`/car-rental/orders/${id}/mock-pay`, { method: "POST", body: JSON.stringify({ idempotencyKey: washIdempotencyKey(`rental-payment-${id}`) }) });
      const updated = normalizeRentalOrder(raw.order || raw, stores);
      setOrders((current) => current.map((item) => item.id === id ? updated : item));
      return updated;
    }
    const current = await fetchOrder(id);
    if (current.status === "confirmed") return current;
    if (current.status !== "pending_payment") throw new Error("当前订单不能支付");
    const now = new Date().toISOString();
    const updated = { ...current, status: "confirmed" as const, paidAt: now, updatedAt: now, events: [...current.events, { id: `rental-event-${Date.now()}`, type: "mock_paid", title: "模拟支付成功", description: "订单已确认，未发生真实扣款", createdAt: now }] };
    setOrders((orders) => orders.map((order) => order.id === id ? updated : order));
    return updated;
  };

  const cancelOrder = async (id: string) => {
    if (apiOnline) {
      const raw = await apiRequest<Record<string, any>>(`/car-rental/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason: "用户取消租车订单" }) });
      const updated = normalizeRentalOrder(raw.order || raw, stores);
      setOrders((current) => current.map((item) => item.id === id ? updated : item));
      return updated;
    }
    const current = await fetchOrder(id);
    if (!["pending_payment", "confirmed"].includes(current.status)) throw new Error("当前订单不能取消");
    const now = new Date().toISOString();
    const updated = { ...current, status: "cancelled" as const, updatedAt: now, events: [...current.events, { id: `rental-event-${Date.now()}`, type: "cancelled", title: "订单已取消", description: "车型容量已释放", createdAt: now }] };
    setOrders((orders) => orders.map((order) => order.id === id ? updated : order));
    return updated;
  };

  return <RentalContext.Provider value={{ catalog, stores, orders, loading, refreshRental, searchOffers, fetchModel, createQuote, createOrder, fetchOrder, payOrder, cancelOrder }}>{children}</RentalContext.Provider>;
}

type InsuranceLeadContextValue = {
  disclosure: InsuranceDisclosure | null;
  disclosureLoading: boolean;
  disclosureError: string;
  vehicleId: string;
  selectedVehicle: Vehicle | null;
  renewalWindow: InsuranceRenewalWindow;
  contactName: string;
  contactPhone: string;
  contactWindow: InsuranceContactWindow;
  licensePhoto: File | null;
  consentAccepted: boolean;
  fieldErrors: InsuranceLeadFieldErrors;
  submitError: string;
  submitting: boolean;
  receipt: InsuranceLeadReceipt | null;
  withdrawing: boolean;
  withdrawn: boolean;
  start: () => void;
  loadDisclosure: (force?: boolean) => Promise<void>;
  chooseVehicle: (id: string) => void;
  setRenewalWindow: (value: InsuranceRenewalWindow) => void;
  setContactName: (value: string) => void;
  setContactPhone: (value: string) => void;
  setContactWindow: (value: InsuranceContactWindow) => void;
  setLicensePhoto: (value: File | null) => void;
  setConsentAccepted: (value: boolean) => void;
  setFieldError: (field: keyof InsuranceLeadFieldErrors, message: string) => void;
  clearFieldError: (field: keyof InsuranceLeadFieldErrors) => void;
  submit: () => Promise<InsuranceLeadReceipt | null>;
  withdraw: () => Promise<boolean>;
};

const InsuranceLeadContext = createContext<InsuranceLeadContextValue | null>(null);

function useInsuranceLead() {
  const value = useContext(InsuranceLeadContext);
  if (!value) throw new Error("useInsuranceLead must be used inside InsuranceLeadProvider");
  return value;
}

function normalizeInsuranceDisclosure(payload: Record<string, any>): InsuranceDisclosure {
  const raw = (payload.disclosure || payload) as Record<string, any>;
  const sourceItems = raw.dataScope || raw.items || raw.bullets || raw.dataUses || raw.sections || [];
  const items = Array.isArray(sourceItems)
    ? sourceItems.map((item) => typeof item === "string" ? item : String(item?.description || item?.content || item?.title || "")).filter(Boolean)
    : [];
  const version = String(raw.version || raw.disclosureVersion || "");
  if (!version) throw new Error("信息使用说明缺少版本号，请稍后重试");
  return {
    mode: raw.mode === "real" ? "real" : "demo",
    version,
    title: String(raw.title || "信息使用说明"),
    summary: String(raw.consentText || raw.summary || raw.description || "仅将本次需求所需信息用于车险续保服务对接。"),
    items: items.length ? items : [
      "车辆与联系方式仅用于识别本次需求并安排服务人员联系。",
      "驭小满仅提供需求登记与服务对接，不提供保险报价或承保。",
      "您可以凭提交凭证随时撤回尚未完成对接的需求。",
    ],
    acceptsRealData: raw.acceptsRealData === true,
    partner: {
      id: String(raw.partner?.id || "platform-service-team"),
      name: String(raw.partner?.name || "驭小满服务团队"),
      recipientName: String(raw.partner?.recipientName || raw.partner?.name || "驭小满服务团队"),
    },
    dataScope: items,
    purpose: String(raw.purpose || "识别车辆续保需求并安排服务对接"),
    retention: String(raw.retention || "按信息使用说明约定保存并清理"),
    consentText: String(raw.consentText || "我同意按本说明使用本次提交的信息"),
    contactEtaText: String(raw.contactEtaText || "1个工作日内"),
  };
}

function normalizeInsuranceReceipt(payload: Record<string, any>, fallbackVehicle: Vehicle | null): InsuranceLeadReceipt {
  const raw = (payload.receipt || payload) as Record<string, any>;
  const vehicle = (raw.vehicle || {}) as Record<string, any>;
  return {
    leadCode: String(raw.leadCode || ""),
    submittedAt: String(raw.submittedAt || new Date().toISOString()),
    vehicle: {
      id: vehicle.id ? String(vehicle.id) : fallbackVehicle?.id,
      plateNumber: String(vehicle.plateNumber || fallbackVehicle?.plateNumber || "演示车辆"),
      modelName: String(vehicle.modelName || fallbackVehicle?.vehicleType || "车辆信息待确认"),
    },
    maskedPhone: String(raw.maskedPhone || "已保护"),
    contactEtaText: String(raw.contactEtaText || "1个工作日内"),
    withdrawToken: String(raw.withdrawToken || ""),
    duplicate: Boolean(raw.duplicate),
    status: raw.status ? String(raw.status) : "submitted",
  };
}

function InsuranceLeadProvider({ children }: { children: ReactNode }) {
  const keyboard = useKeyboard();
  const { vehicles, activeVehicle, setActiveVehicleId, showToast } = useMvp();
  const [disclosure, setDisclosure] = useState<InsuranceDisclosure | null>(null);
  const [disclosureLoading, setDisclosureLoading] = useState(false);
  const [disclosureError, setDisclosureError] = useState("");
  const [vehicleId, setVehicleId] = useState(activeVehicle?.id || vehicles[0]?.id || "");
  const [renewalWindow, setRenewalWindowState] = useState<InsuranceRenewalWindow>("within_30_days");
  const [contactName, setContactNameState] = useState("");
  const [contactPhone, setContactPhoneState] = useState("");
  const [contactWindow, setContactWindowState] = useState<InsuranceContactWindow>("morning");
  const [licensePhoto, setLicensePhotoState] = useState<File | null>(null);
  const [consentAccepted, setConsentAcceptedState] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<InsuranceLeadFieldErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<InsuranceLeadReceipt | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const submissionRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const submittingRef = useRef(false);
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === vehicleId) || null;

  useEffect(() => {
    if (selectedVehicle || !vehicles.length) return;
    setVehicleId((activeVehicle || vehicles.find((vehicle) => vehicle.isDefault) || vehicles[0]).id);
  }, [activeVehicle, selectedVehicle, vehicles]);

  const clearFieldError = (field: keyof InsuranceLeadFieldErrors) => {
    setFieldErrors((current) => current[field] ? { ...current, [field]: undefined } : current);
    setSubmitError("");
  };

  const setFieldError = (field: keyof InsuranceLeadFieldErrors, message: string) => {
    setFieldErrors((current) => ({ ...current, [field]: message }));
  };

  const loadDisclosure = async (force = false) => {
    if ((disclosure && !force) || disclosureLoading) return;
    setDisclosureLoading(true);
    setDisclosureError("");
    try {
      const payload = await apiRequest<Record<string, any>>("/insurance/disclosure");
      setDisclosure(normalizeInsuranceDisclosure(payload));
      clearFieldError("disclosure");
    } catch (error) {
      const message = error instanceof Error ? error.message : "信息使用说明加载失败，请重试";
      setDisclosure(null);
      setDisclosureError(message);
      setFieldError("disclosure", message);
    } finally {
      setDisclosureLoading(false);
    }
  };

  const start = () => {
    keyboard.hide();
    setVehicleId(activeVehicle?.id || vehicles[0]?.id || "");
    setRenewalWindowState("within_30_days");
    setContactNameState("");
    setContactPhoneState("");
    setContactWindowState("morning");
    setLicensePhotoState(null);
    setConsentAcceptedState(false);
    setFieldErrors({});
    setSubmitError("");
    setReceipt(null);
    setWithdrawn(false);
    submissionRef.current = null;
    void loadDisclosure();
  };

  const chooseVehicle = (id: string) => {
    setVehicleId(id);
    setActiveVehicleId(id);
    clearFieldError("vehicleId");
  };

  const submit = async () => {
    keyboard.hide();
    if (submittingRef.current) return null;
    const errors: InsuranceLeadFieldErrors = {};
    if (!selectedVehicle) errors.vehicleId = "请选择需要续保对接的车辆";
    if (!contactName.trim() || contactName.trim().length > 30) errors.contactName = "请填写1–30个字符的联系人姓名";
    if (!/^1[3-9]\d{9}$/.test(contactPhone)) errors.contactPhone = "请输入正确的11位手机号";
    if (!licensePhoto) errors.licensePhoto = "请上传1张行驶证主页";
    else if (!["image/jpeg", "image/png", "image/webp"].includes(licensePhoto.type)) errors.licensePhoto = "仅支持JPG、PNG或WebP图片";
    else if (licensePhoto.size > 5 * 1024 * 1024) errors.licensePhoto = "图片大小不能超过5MB";
    if (!consentAccepted) errors.consentAccepted = "请先阅读并同意信息使用说明";
    if (!disclosure) errors.disclosure = disclosureLoading ? "信息使用说明正在加载，请稍候" : disclosureError || "请先加载信息使用说明";
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      showToast("请完善续保需求信息");
      return null;
    }

    const fingerprint = JSON.stringify({
      vehicleId,
      renewalWindow,
      contactName: contactName.trim(),
      contactPhone,
      contactWindow,
      disclosureVersion: disclosure!.version,
      file: [licensePhoto!.name, licensePhoto!.size, licensePhoto!.type, licensePhoto!.lastModified],
    });
    if (submissionRef.current?.fingerprint !== fingerprint) {
      submissionRef.current = { fingerprint, key: washIdempotencyKey("insurance-lead") };
    }

    const form = new FormData();
    form.append("vehicleId", vehicleId);
    form.append("renewalWindow", renewalWindow);
    form.append("contactName", contactName.trim());
    form.append("contactPhone", contactPhone);
    form.append("contactWindow", contactWindow);
    form.append("consentAccepted", "true");
    form.append("disclosureVersion", disclosure!.version);
    form.append("licensePhoto", licensePhoto!);
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = await apiRequest<Record<string, any>>("/insurance/leads", {
        method: "POST",
        headers: { "Idempotency-Key": submissionRef.current!.key },
        body: form,
      });
      const nextReceipt = normalizeInsuranceReceipt(payload, selectedVehicle);
      if (!nextReceipt.leadCode) throw new Error("提交成功但未返回服务凭证，请稍后查询");
      setReceipt(nextReceipt);
      setWithdrawn(nextReceipt.status === "withdrawn");
      return nextReceipt;
    } catch (error) {
      const requestError = error as Error & { code?: string };
      let message = requestError.message || "续保需求提交失败，请稍后重试";
      if (requestError.code === "DISCLOSURE_VERSION_MISMATCH") {
        message = "信息使用说明已更新，请重新阅读并授权后提交";
        setConsentAcceptedState(false);
        void loadDisclosure(true);
      } else if (["REAL_DATA_NOT_ACCEPTED", "DEMO_DATA_ONLY"].includes(requestError.code || "")) {
        message = "演示环境仅支持合成演示号码13800138000或13900000000";
        setFieldError("contactPhone", message);
      } else if (requestError.code === "IDEMPOTENCY_KEY_CONFLICT") {
        message = "提交内容已变化，请确认信息后重新提交";
        submissionRef.current = null;
      }
      setSubmitError(message);
      showToast(message);
      return null;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const withdraw = async () => {
    if (!receipt?.withdrawToken || withdrawing || withdrawn) return false;
    setWithdrawing(true);
    setSubmitError("");
    try {
      const response = await fetch(`${API_BASE}/insurance/leads/${encodeURIComponent(receipt.withdrawToken)}/withdraw`, { method: "POST" });
      const envelope = await response.json().catch(() => null);
      if (!response.ok) throw new Error(envelope?.error?.message || "撤回失败，请稍后重试");
      const payload = envelope?.data as Record<string, any>;
      const nextReceipt = normalizeInsuranceReceipt(payload, selectedVehicle);
      setReceipt((current) => nextReceipt.leadCode ? nextReceipt : current ? { ...current, status: "withdrawn" } : current);
      setWithdrawn(true);
      showToast("续保对接需求已撤回");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "撤回失败，请稍后重试";
      setSubmitError(message);
      showToast(message);
      return false;
    } finally {
      setWithdrawing(false);
    }
  };

  const value: InsuranceLeadContextValue = {
    disclosure,
    disclosureLoading,
    disclosureError,
    vehicleId,
    selectedVehicle,
    renewalWindow,
    contactName,
    contactPhone,
    contactWindow,
    licensePhoto,
    consentAccepted,
    fieldErrors,
    submitError,
    submitting,
    receipt,
    withdrawing,
    withdrawn,
    start,
    loadDisclosure,
    chooseVehicle,
    setRenewalWindow: (value) => { setRenewalWindowState(value); setSubmitError(""); },
    setContactName: (value) => { setContactNameState(value); clearFieldError("contactName"); },
    setContactPhone: (value) => { setContactPhoneState(value); clearFieldError("contactPhone"); },
    setContactWindow: (value) => { setContactWindowState(value); setSubmitError(""); },
    setLicensePhoto: (value) => { setLicensePhotoState(value); clearFieldError("licensePhoto"); },
    setConsentAccepted: (value) => { setConsentAcceptedState(value); clearFieldError("consentAccepted"); },
    setFieldError,
    clearFieldError,
    submit,
    withdraw,
  };

  return <InsuranceLeadContext.Provider value={value}>{children}</InsuranceLeadContext.Provider>;
}

function navScreen(id: string, title: string, content: ReactNode): FlowScreen {
  return {
    id,
    headerHeight: 56,
    header: () => <NavHeader title={title} />,
    render: () => content,
  };
}

const consumerRootScreen = (tab: ConsumerTab = "home"): FlowScreen => ({
  id: `consumer-${tab}`,
  footerHeight: 82,
  footer: () => <ConsumerBottomNav active={tab} />,
  render: () => tab === "home" ? <HomeScreen /> : tab === "orders" ? <OrdersScreen /> : <ProfileScreen />,
});
const homeScreen = (): FlowScreen => consumerRootScreen("home");
const vehiclesScreen = (): FlowScreen => navScreen("vehicles", "我的车辆", <VehiclesScreen />);
const vehicleFormScreen = (vehicle?: Vehicle): FlowScreen =>
  navScreen(vehicle ? `vehicle-edit-${vehicle.id}` : "vehicle-add", vehicle ? "编辑车辆" : "添加车辆", <VehicleFormScreen vehicle={vehicle} />);
const materialsScreen = (): FlowScreen => navScreen("materials", "年检材料", <MaterialsScreen />);
const inspectionScreen = (): FlowScreen => navScreen("inspection", "年检查询", <InspectionScreen />);
const stationsScreen = (): FlowScreen => navScreen("stations", "选择检测站", <StationsScreen />);
const stationDetailScreen = (stationId: string): FlowScreen => navScreen(`station-${stationId}`, "站点与时段", <StationDetailScreen stationId={stationId} />);
const bookingConfirmScreen = (): FlowScreen => navScreen("booking-confirm", "确认预约", <BookingConfirmScreen />);
const bookingPaymentScreen = (bookingId: string): FlowScreen => navScreen(`booking-payment-${bookingId}`, "订单支付", <BookingPaymentScreen bookingId={bookingId} />);
const washBookingScreen = (repeatOrder?: WashOrder): FlowScreen => navScreen("wash-booking", "洗车服务", <WashBookingScreen repeatOrder={repeatOrder} />);
const washPaymentScreen = (orderId: string): FlowScreen => navScreen(`wash-payment-${orderId}`, "模拟支付", <WashPaymentScreen orderId={orderId} />);
const washOrderDetailScreen = (orderId: string): FlowScreen => navScreen(`wash-order-${orderId}`, "洗车订单", <WashOrderDetailScreen orderId={orderId} />);
const insuranceLeadScreen = (): FlowScreen => ({
  id: "insurance-lead",
  headerHeight: 56,
  header: () => <NavHeader title="车险续保对接" />,
  footerHeight: 128,
  footer: () => <InsuranceLeadFooter />,
  render: () => <InsuranceLeadScreen />,
});
const insuranceReceiptScreen = (): FlowScreen => navScreen("insurance-receipt", "续保对接凭证", <InsuranceLeadReceiptScreen />);
const usedCarBrandScreen = (selectedBrandId?: string): FlowScreen => navScreen(
  `used-car-brand-${selectedBrandId ?? "all"}`,
  "选择品牌",
  <UsedCarBrandScreen selectedBrandId={selectedBrandId} />,
);
const usedCarModelScreen = (brandId: string): FlowScreen => navScreen(`used-car-model-${brandId}`, "选择车型", <UsedCarModelScreen brandId={brandId} />);
const usedCarMarketScreen = (brandId = "brand-li", modelId = "model-li-l7"): FlowScreen => navScreen(`used-car-market-${brandId}-${modelId}`, "二手车市场", <UsedCarMarketScreen brandId={brandId} modelId={modelId} />);
const usedCarDetailScreen = (listingId: string): FlowScreen => navScreen(`used-car-detail-${listingId}`, "车辆详情", <UsedCarDetailScreen listingId={listingId} />);
const rentalHomeScreen = (): FlowScreen => ({
  id: "car-rental-home",
  headerHeight: 62,
  header: () => <RentalHeader />,
  render: () => <RentalHomeScreen />,
});
const rentalOffersScreen = (search: RentalSearchInput): FlowScreen => navScreen(`car-rental-offers-${search.fulfillmentMode}-${search.pickupAt}`, "选择车型", <RentalOffersScreen search={search} />);
const rentalModelDetailScreen = (modelId: string, search: RentalSearchInput): FlowScreen => navScreen(`car-rental-model-${modelId}`, "车型详情", <RentalModelDetailScreen modelId={modelId} search={search} />);
const rentalConfirmScreen = (quote: RentalQuote, search: RentalSearchInput): FlowScreen => navScreen(`car-rental-confirm-${quote.quoteId}`, "确认租车方案", <RentalConfirmScreen quote={quote} search={search} />);
const rentalPaymentScreen = (orderId: string): FlowScreen => navScreen(`car-rental-payment-${orderId}`, "模拟支付", <RentalPaymentScreen orderId={orderId} />);
const rentalOrderDetailScreen = (orderId: string): FlowScreen => navScreen(`car-rental-order-${orderId}`, "租车订单", <RentalOrderDetailScreen orderId={orderId} />);
const ordersScreen = (): FlowScreen => consumerRootScreen("orders");
const orderDetailScreen = (bookingId: string): FlowScreen => navScreen(`order-${bookingId}`, "订单进度", <OrderDetailScreen bookingId={bookingId} />);
const inspectionStageScreen = (stage: InspectionStage): FlowScreen => navScreen(`inspection-stage-${stage}`, ({ booking: "在线预约", arrival: "到站验车", materials: "提交资料", result: "结果与申领" } satisfies Record<InspectionStage, string>)[stage], <InspectionStageScreen stage={stage} />);
const serviceScreen = (title: string, description: string): FlowScreen => navScreen(`service-${title}`, title, <ServiceInfoScreen title={title} description={description} />);
const demoToolsScreen = (): FlowScreen => navScreen("demo-tools", "演示控制台", <DemoToolsScreen />);
type OperatorTab = "workbench" | "orders" | "station";
const operatorRootScreen = (tab: OperatorTab = "workbench"): FlowScreen => ({
  id: `operator-${tab}`,
  footerHeight: 76,
  footer: () => <OperatorBottomNavV2 active={tab} />,
  render: () => tab === "workbench" ? <OperatorWorkbenchScreenV2 /> : tab === "orders" ? <OperatorOrdersScreenV2 /> : <OperatorStationScreenV2 />,
});
const operatorBookingScreen = (bookingId: string): FlowScreen => ({
  id: `operator-booking-${bookingId}`,
  headerHeight: 56,
  header: () => <OperatorDetailHeader />,
  render: () => <OperatorBookingDetailScreenV2 bookingId={bookingId} />,
});

function NavHeader({ title }: { title: string }) {
  const flow = useFlow();
  return (
    <div className="nav-header">
      <button className="icon-button" aria-label="返回" onClick={flow.pop}><CaretLeft size={24} weight="bold" /></button>
      <strong>{title}</strong>
      <span className="nav-header-spacer" />
    </div>
  );
}

function RentalHeader() {
  const flow = useFlow();
  return (
    <div className="nav-header rental-nav-header">
      <button className="icon-button" aria-label="返回" onClick={flow.pop}><CaretLeft size={24} weight="bold" /></button>
      <strong>汽车租赁</strong>
      <button className="rental-contact-button" aria-label="联系租车客服" onClick={() => flow.push(serviceScreen("租车客服", "24小时演示客服入口，可咨询门店、车型、取还规则与订单问题。"))}><Headset size={20} weight="duotone" /><span>客服</span></button>
    </div>
  );
}

function ConsumerBottomNav({ active }: { active: ConsumerTab }) {
  const flow = useFlow();
  const items: Array<[ConsumerTab, string, ReactNode]> = [
    ["home", "首页", <House size={24} weight={active === "home" ? "fill" : "regular"} />],
    ["orders", "订单", <Receipt size={24} weight={active === "orders" ? "fill" : "regular"} />],
    ["profile", "我的", <UserCircle size={25} weight={active === "profile" ? "fill" : "regular"} />],
  ];
  return (
    <nav className="owner-bottom-nav" aria-label="车主端导航" data-testid="owner-bottom-nav">
      {items.map(([tab, label, icon]) => (
        <button
          key={tab}
          type="button"
          className={active === tab ? "active" : ""}
          aria-current={active === tab ? "page" : undefined}
          data-testid={`owner-nav-${tab}`}
          onClick={() => active !== tab && flow.replace(consumerRootScreen(tab))}
        >
          {icon}<span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function OperatorDetailHeader() {
  const flow = useFlow();
  return (
    <div className="nav-header operator-detail-header">
      <button className="icon-button" aria-label="返回" onClick={flow.pop}><CaretLeft size={24} weight="bold" /></button>
      <strong>履约任务</strong>
      <button className="icon-button" aria-label="任务更多操作"><DotsThree size={22} weight="bold" /></button>
    </div>
  );
}

function OperatorBottomNav({ active }: { active: OperatorTab }) {
  const flow = useFlow();
  const items: Array<[OperatorTab, typeof ClipboardText, string]> = [
    ["workbench", ClipboardText, "工作台"],
    ["orders", ListChecks, "任务"],
    ["station", MapTrifold, "站点"],
  ];
  return (
    <nav className="operator-bottom-nav" aria-label="检测站端主导航">
      {items.map(([tab, Icon, label]) => (
        <button
          key={tab}
          className={active === tab ? "active" : ""}
          aria-current={active === tab ? "page" : undefined}
          onClick={() => active !== tab && flow.replace(operatorRootScreen(tab))}
        >
          <Icon size={22} weight={active === tab ? "fill" : "regular"} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function OperatorPageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <header className="operator-page-header">
      <div><small>{eyebrow}</small><h1>{title}</h1></div>
      {action}
    </header>
  );
}

function OperatorTaskCard({ booking }: { booking: Booking }) {
  const flow = useFlow();
  const urgent = booking.status === "on_hold";
  return (
    <button className={`operator-task-card${urgent ? " urgent" : ""}`} onClick={() => flow.push(operatorBookingScreen(booking.id))}>
      <div className="operator-task-time"><strong>{booking.startTime}</strong><small>{booking.endTime}</small></div>
      <div className="operator-task-main">
        <span><strong>{booking.vehicle?.plateNumber || "待核验车辆"}</strong><i className={`operator-status status-${booking.status}`}>{bookingStatusLabel(booking.status)}</i></span>
        <small>{booking.contactName} · {booking.contactPhone}</small>
        <em>{booking.appointmentNumber || "预约编号生成中"}</em>
      </div>
      <CaretRight size={18} />
    </button>
  );
}

function OperatorWorkbenchScreen() {
  const { fetchOperatorWorkbench, setAppRole } = useMvp();
  const [workbench, setWorkbench] = useState<OperatorWorkbench | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetchOperatorWorkbench().then(setWorkbench).catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <MobileScroll className="app-scroll operator-scroll">
      <main className="operator-page">
        <OperatorPageHeader
          eyebrow={workbench?.station.name || "检测站履约中心"}
          title="今日工作台"
          action={<button className="operator-role-chip" onClick={() => setAppRole("consumer")}><ArrowsLeftRight size={16} />车主端</button>}
        />
        {error ? <div className="operator-error" role="alert"><Warning size={18} />{error}</div> : null}
        {!workbench ? (
          <div className="operator-loading"><CircleNotch className="spin" size={25} />正在同步今日任务</div>
        ) : (
          <>
            <section className="operator-summary-card">
              <div className="operator-summary-lead"><small>{formatDateLabel(workbench.date)}</small><strong>{workbench.summary.todayBookings}</strong><span>今日预约</span></div>
              <div className="operator-summary-grid">
                <span><strong>{workbench.summary.awaitingArrival}</strong><small>待到站</small></span>
                <span><strong>{workbench.summary.checkedIn}</strong><small>已核验</small></span>
                <span><strong>{workbench.summary.inspecting}</strong><small>检测中</small></span>
                <span><strong>{workbench.summary.completed}</strong><small>已完成</small></span>
              </div>
            </section>

            <section className="operator-section">
              <header><div><small>RESOURCE PRESSURE</small><h2>时段负载</h2></div><span>{workbench.summary.remainingCapacity} 个余量</span></header>
              <div className="operator-pressure-list">
                {workbench.pressures.map((pressure) => (
                  <div key={pressure.slotId}>
                    <span><strong>{pressure.label}</strong><small>{pressure.booked}/{pressure.capacity} 已预约</small></span>
                    <i className={pressure.level}><b style={{ width: `${Math.min(100, pressure.capacity ? pressure.booked / pressure.capacity * 100 : 0)}%` }} /></i>
                    <em>{pressure.level === "high" ? "高峰" : pressure.level === "medium" ? "适中" : "宽松"}</em>
                  </div>
                ))}
              </div>
            </section>

            <section className="operator-section operator-queue">
              <header><div><small>LIVE QUEUE</small><h2>履约队列</h2></div><span>{workbench.bookings.length} 个任务</span></header>
              <div>{workbench.bookings.map((booking) => <OperatorTaskCard key={booking.id} booking={booking} />)}</div>
            </section>
          </>
        )}
      </main>
    </MobileScroll>
  );
}

function OperatorOrdersScreen() {
  const { fetchOperatorWorkbench } = useMvp();
  const [workbench, setWorkbench] = useState<OperatorWorkbench | null>(null);
  const [filter, setFilter] = useState<"all" | "waiting" | "processing" | "done">("all");

  useEffect(() => { void fetchOperatorWorkbench().then(setWorkbench); }, []);
  const visible = (workbench?.bookings || []).filter((booking) => {
    if (filter === "all") return true;
    if (filter === "waiting") return ["confirmed", "awaiting_arrival"].includes(booking.status);
    if (filter === "processing") return ["checked_in", "on_hold", "inspecting", "result_received"].includes(booking.status);
    return ["completed", "cancelled", "no_show"].includes(booking.status);
  });
  return (
    <MobileScroll className="app-scroll operator-scroll">
      <main className="operator-page">
        <OperatorPageHeader eyebrow="TASK MANAGEMENT" title="履约任务" />
        <div className="operator-filter-row" role="tablist" aria-label="任务筛选">
          {([['all', '全部'], ['waiting', '待接待'], ['processing', '处理中'], ['done', '已归档']] as const).map(([value, label]) => (
            <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <section className="operator-section operator-queue standalone">
          <header><div><small>{formatDateLabel(workbench?.date || DEMO_TODAY)}</small><h2>{visible.length} 个任务</h2></div></header>
          {workbench ? visible.map((booking) => <OperatorTaskCard key={booking.id} booking={booking} />) : <div className="operator-loading"><CircleNotch className="spin" size={24} />正在读取任务</div>}
          {workbench && !visible.length ? <div className="operator-empty"><CheckCircle size={34} weight="duotone" /><strong>当前没有此类任务</strong><small>切换筛选查看其他履约状态</small></div> : null}
        </section>
      </main>
    </MobileScroll>
  );
}

function OperatorStationScreen() {
  const { fetchOperatorWorkbench, setAppRole } = useMvp();
  const [workbench, setWorkbench] = useState<OperatorWorkbench | null>(null);
  useEffect(() => { void fetchOperatorWorkbench().then(setWorkbench); }, []);
  const station = workbench?.station;
  return (
    <MobileScroll className="app-scroll operator-scroll">
      <main className="operator-page">
        <OperatorPageHeader eyebrow="STATION PROFILE" title="站点配置" />
        {station ? (
          <>
            <section className="operator-station-card">
              <span><MapPin size={26} weight="duotone" /></span>
              <div><small>当前服务站</small><h2>{station.name}</h2><p>{station.address}</p></div>
              <SealCheck size={22} weight="fill" />
            </section>
            <section className="operator-info-list">
              <div><Clock size={20} /><span><small>营业时间</small><strong>{station.openHours || station.businessHours || "未配置"}</strong></span></div>
              <div><Phone size={20} /><span><small>站点电话</small><strong>{station.phone || "未配置"}</strong></span></div>
              <div><Car size={20} /><span><small>支持车型</small><strong>{station.supportedVehicleTypes?.join(" · ") || "小型客车 · 新能源小型车"}</strong></span></div>
            </section>
            <section className="operator-section">
              <header><div><small>CAPACITY POLICY</small><h2>号源规则</h2></div><span>{workbench?.summary.totalCapacity || 0} 个容量</span></header>
              <p className="operator-policy-copy">当日号源进入履约锁定，仅展示负载；未来日期可经 API 调整容量，且不能低于已预约数量。</p>
            </section>
            <button className="operator-outline-button" onClick={() => setAppRole("consumer")}><ArrowsLeftRight size={18} />切换回车主端演示</button>
          </>
        ) : <div className="operator-loading"><CircleNotch className="spin" size={24} />正在读取站点信息</div>}
      </main>
    </MobileScroll>
  );
}

function OperatorBookingDetailScreen({ bookingId }: { bookingId: string }) {
  const { fetchOperatorBooking, runOperatorAction, simulateInspectionResult, showToast } = useMvp();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verification, setVerification] = useState<BookingVerification>({ plateMatched: true, materialsReady: true, exteriorRecorded: true, vehicleConditionConfirmed: true });

  useEffect(() => {
    void fetchOperatorBooking(bookingId).then((next) => {
      setBooking(next);
      if (next.verification) setVerification(next.verification);
    }).catch((reason: Error) => setError(reason.message));
  }, [bookingId]);

  const allVerified = verification.plateMatched && verification.materialsReady && verification.exteriorRecorded && verification.vehicleConditionConfirmed;
  const actionForStatus = (status: BookingStatus): [OperatorAction, string] | null => ({
    confirmed: ["accept", "接单并保留接待资源"],
    awaiting_arrival: ["check-in", "确认到站并完成核验"],
    checked_in: ["handoff", "交接检测线"],
    on_hold: ["resolve-hold", "异常已处理，恢复任务"],
    result_received: ["complete", "确认结果并完成服务"],
  } as Partial<Record<BookingStatus, [OperatorAction, string]>>)[status] || null;

  const perform = async (action: OperatorAction) => {
    if (!booking || busy) return;
    setBusy(true); setError("");
    try {
      const payload = action === "check-in" ? { verification } : action === "hold" ? { reasonCode: "manual_review", note: "演示：现场信息需要进一步复核" } : {};
      const next = await runOperatorAction(booking.id, action, payload);
      setBooking(next);
      showToast("任务状态已更新");
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  const simulateResult = async () => {
    if (!booking || busy) return;
    setBusy(true); setError("");
    try { const next = await simulateInspectionResult(booking.id); setBooking(next); showToast("模拟检测结果已回传"); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  if (!booking) return <MobileScroll className="app-scroll operator-scroll"><div className="operator-loading detail"><CircleNotch className="spin" size={25} />{error || "正在读取履约任务"}</div></MobileScroll>;
  const primaryAction = actionForStatus(booking.status);
  const canHold = ["awaiting_arrival", "checked_in", "inspecting"].includes(booking.status);
  return (
    <MobileScroll className="app-scroll operator-scroll">
      <main className="operator-detail-page">
        <section className={`operator-detail-hero status-${booking.status}`}>
          <small>{booking.appointmentNumber || "履约任务"}</small>
          <h1>{booking.vehicle?.plateNumber || "待核验车辆"}</h1>
          <div><span>{bookingStatusLabel(booking.status)}</span><em>{booking.appointmentDate} {booking.startTime}–{booking.endTime}</em></div>
        </section>
        {error ? <div className="operator-error" role="alert"><Warning size={18} />{error}</div> : null}
        <section className="operator-info-list task-info">
          <div><IdentificationCard size={20} /><span><small>车主联系人</small><strong>{booking.contactName} · {booking.contactPhone}</strong></span></div>
          <div><Car size={20} /><span><small>车辆档案</small><strong>{booking.vehicle?.vehicleType || "小型客车"} · {booking.vehicle?.usageNature || "非营运"}</strong></span></div>
          <div><MapPin size={20} /><span><small>履约站点</small><strong>{booking.station?.name || "海河机动车检测服务中心"}</strong></span></div>
        </section>

        {booking.status === "awaiting_arrival" ? (
          <section className="operator-verification-card">
            <header><div><small>ARRIVAL CHECK</small><h2>到站核验</h2></div><span>{Object.values(verification).filter((value) => value === true).length}/4</span></header>
            {([['plateMatched', '车牌与预约一致'], ['materialsReady', '年检材料齐全'], ['exteriorRecorded', '车辆外观已留档'], ['vehicleConditionConfirmed', '车辆状态已确认']] as const).map(([key, label]) => (
              <button key={key} role="checkbox" aria-checked={verification[key]} onClick={() => setVerification((current) => ({ ...current, [key]: !current[key] }))}>
                <span className={verification[key] ? "checked" : ""}>{verification[key] ? <Check size={15} weight="bold" /> : null}</span><strong>{label}</strong>
              </button>
            ))}
          </section>
        ) : null}

        {booking.inspectionResult ? (
          <section className="operator-result-card"><SealCheck size={30} weight="duotone" /><div><small>外部检测结果已回传</small><strong>{booking.inspectionResult.conclusion === "passed" ? "检验合格" : "结果待复核"}</strong><p>{typeof booking.inspectionResult.summary === "string" ? booking.inspectionResult.summary : "12 项检测完成，结果已进入服务闭环。"}</p></div></section>
        ) : null}

        <section className="operator-timeline">
          <header><small>AUDIT TRAIL</small><h2>履约记录</h2></header>
          {(booking.events?.length ? booking.events : [{ id: "current", status: booking.status, title: bookingStatusLabel(booking.status), description: "当前演示任务状态", createdAt: booking.updatedAt }]).map((event) => (
            <div key={event.id}><span /><p><strong>{event.title}</strong><small>{event.description}</small><em>{formatDateTime(event.createdAt)}</em></p></div>
          ))}
        </section>

        <div className="operator-action-dock">
          {booking.status === "inspecting" ? <button className="primary-button" disabled={busy} onClick={() => void simulateResult()}>{busy ? <CircleNotch className="spin" /> : <SealCheck size={19} />}模拟检测结果回传</button> : null}
          {primaryAction ? <button className="primary-button" disabled={busy || (primaryAction[0] === "check-in" && !allVerified)} onClick={() => void perform(primaryAction[0])}>{busy ? <CircleNotch className="spin" /> : <CheckCircle size={19} />}{primaryAction[1]}</button> : null}
          {canHold ? <button className="operator-hold-button" disabled={busy} onClick={() => void perform("hold")}><Warning size={17} />挂起异常</button> : null}
          {booking.status === "completed" ? <div className="operator-complete-note"><CheckCircle size={20} weight="fill" />本次履约已完整闭环</div> : null}
        </div>
      </main>
    </MobileScroll>
  );
}

function latestInspectionBooking(bookings: Booking[]) {
  const sorted = bookings.slice().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return sorted.find((booking) => !["completed", "cancelled", "no_show"].includes(bookingFlowStatus(booking)))
    || sorted.find((booking) => Boolean(booking.inspectionResult) || bookingFlowStatus(booking) === "completed")
    || sorted[0]
    || null;
}

function inspectionStageProgressIndex(booking: Booking | null) {
  if (!booking) return 0;
  const status = bookingFlowStatus(booking);
  if (["cancelled", "no_show"].includes(status)) return 0;
  if (status === "completed") return 4;
  if (["result_received", "returning"].includes(status)) return 3;
  if (["checked_in", "inspecting", "on_hold"].includes(status)) return 2;
  if (["confirmed", "driver_arranged", "picked_up", "awaiting_arrival"].includes(status)) return 1;
  return 0;
}

function HomeScreen() {
  const flow = useFlow();
  const { activeVehicle, bookings, loading } = useMvp();
  const insuranceLead = useInsuranceLead();
  const latestBooking = latestInspectionBooking(bookings);
  const stageProgress = inspectionStageProgressIndex(latestBooking);
  const inspectionStages: Array<[InspectionStage, typeof CalendarCheck, string, string]> = [
    ["booking", CalendarCheck, "在线预约", "选择时间网点"],
    ["arrival", Car, "到站验车", "查看到站指引"],
    ["materials", FileText, "提交资料", "预约时上传"],
    ["result", ShieldCheck, "领取合格标", "结果与申领"],
  ];
  const ownerServices: Array<[typeof Drop, string, string, string, () => void]> = [
    [Drop, "洗车", "自驾到店 · 快速洁净", "wash-entry-service", () => flow.push(washBookingScreen())],
    [CalendarCheck, "查询年检", "规则测算 · 办理建议", "inspection-entry-service", () => flow.push(inspectionScreen())],
    [ShieldCheck, "保险服务", "续保需求 · 专人对接", "insurance-entry-service", () => { insuranceLead.start(); flow.push(insuranceLeadScreen()); }],
    [Wrench, "维修保养", "专业门店 · 透明可靠", "maintenance-entry-service", () => flow.push(serviceScreen("维修保养", "专业门店提供透明、可靠的维修保养服务说明与咨询。"))],
    [ArrowsLeftRight, "汽车租赁", "指定车型 · 透明计价", "car-rental-entry-service", () => flow.push(rentalHomeScreen())],
    [Car, "车辆报废", "正规流程 · 便捷省心", "scrap-entry-service", () => flow.push(serviceScreen("车辆报废", "正规报废流程、办理条件与材料清单说明。"))],
  ];

  return (
    <MobileScroll className="app-scroll home-scroll">
      <main className="home-page" data-testid="home-page">
        <header className="mini-header">
          <strong className="brand-wordmark"><ShieldCheck size={28} weight="duotone" />驭小满</strong>
          <button className="location-control" aria-label="当前城市天津"><span>天津</span><MapPin size={21} weight="bold" /></button>
        </header>

        {loading ? (
          <section className="hero hero-loading"><CircleNotch className="spin" size={28} /><span>正在读取车辆状态</span></section>
        ) : activeVehicle ? (
          <VehicleHero vehicle={activeVehicle} onVehicle={() => flow.push(vehiclesScreen())} onQuery={() => flow.push(inspectionScreen())} onBook={() => flow.push(stationsScreen())} />
        ) : (
          <EmptyVehicleHero onAdd={() => flow.push(vehicleFormScreen())} />
        )}

        <section className="home-section process-card">
          <div className="section-heading"><h2>年检服务流程</h2></div>
          <div className="process-row">
            {inspectionStages.map(([stage, Icon, title, copy], index) => (
              <button key={stage} className={`process-step ${index < stageProgress ? "complete" : index === stageProgress ? "current" : ""}`} data-testid={`inspection-stage-entry-${stage}`} onClick={() => flow.push(inspectionStageScreen(stage))}>
                <span className="step-number">{index + 1}</span>
                <span className="step-icon"><Icon size={27} weight="duotone" /></span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="home-section services-card">
          <div className="section-heading"><h2>车主服务</h2></div>
          <div className="services-grid">
            {ownerServices.map(([Icon, title, copy, testId, action]) => (
              <button key={title} data-testid={testId} onClick={action}>
                <span className="service-icon"><Icon size={29} weight="duotone" /></span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </button>
            ))}
          </div>
        </section>
      </main>
    </MobileScroll>
  );
}

function formatRentalMoment(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value.slice(0, 10), time: value.slice(11, 16) };
  return {
    date: `${date.getMonth() + 1}月${date.getDate()}日`,
    time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

function rentalDateOption(base: string, dayOffset: number) {
  const date = new Date(base);
  date.setDate(date.getDate() + dayOffset);
  return date.toISOString();
}

function RentalHomeScreen() {
  const flow = useFlow();
  const { stores, catalog, orders, loading } = useRental();
  const [mode, setMode] = useState<RentalFulfillmentMode>("store_pickup");
  const [storeId, setStoreId] = useState(stores[0]?.id || FALLBACK_RENTAL_STORES[0].id);
  const [address, setAddress] = useState<RentalAddress>(FALLBACK_RENTAL_ADDRESSES[0]);
  const [pickupAt, setPickupAt] = useState(() => rentalLocalIso(1));
  const [returnAt, setReturnAt] = useState(() => rentalLocalIso(4));
  const [sheet, setSheet] = useState<"store" | "address" | "pickup" | "return" | null>(null);
  const selectedStore = stores.find((store) => store.id === storeId) || stores[0] || FALLBACK_RENTAL_STORES[0];
  const pickupMoment = formatRentalMoment(pickupAt);
  const returnMoment = formatRentalMoment(returnAt);
  const billableDays = rentalBillableDays(pickupAt, returnAt);
  const validDuration = Date.parse(returnAt) > Date.parse(pickupAt) && billableDays <= 30;
  const hotModels = ["model-li-l7", "model-volkswagen-magotan"].map((id) => catalog.models.find((model) => model.id === id) || FALLBACK_RENTAL_CATALOG.models.find((model) => model.id === id)!).filter(Boolean);
  const openMode = (next: RentalFulfillmentMode) => {
    setMode(next);
    if (next === "home_delivery" && !address) setAddress(FALLBACK_RENTAL_ADDRESSES[0]);
  };
  const submitSearch = () => {
    if (!validDuration) return;
    const input: RentalSearchInput = {
      fulfillmentMode: mode,
      storeId: mode === "store_pickup" ? selectedStore.id : undefined,
      deliveryAddress: mode === "home_delivery" ? address : undefined,
      pickupAt,
      returnAt,
      sort: "recommended",
      page: 1,
      pageSize: 30,
    };
    flow.push(rentalOffersScreen(input));
  };
  const pickupOptions = [1, 2, 3, 5].map((day) => rentalLocalIso(day));
  const returnOptions = [1, 2, 3, 5, 7].map((day) => rentalDateOption(pickupAt, day));

  return (
    <>
      <MobileScroll className="app-scroll rental-scroll">
        <main className="rental-home-page" data-testid="car-rental-home">
          <section className="rental-search-card">
            <div className="rental-mode-switch" role="tablist" aria-label="取还方式">
              <button role="tab" aria-selected={mode === "store_pickup"} className={mode === "store_pickup" ? "active" : ""} onClick={() => openMode("store_pickup")}><Storefront size={21} weight="duotone" />门店取还</button>
              <button role="tab" aria-selected={mode === "home_delivery"} className={mode === "home_delivery" ? "active" : ""} onClick={() => openMode("home_delivery")}><NavigationArrow size={21} weight="duotone" />送车上门</button>
            </div>
            <button className="rental-place-row" data-testid="rental-place-picker" onClick={() => setSheet(mode === "store_pickup" ? "store" : "address")}>
              <MapPin size={25} weight="fill" />
              <span>
                <strong>{mode === "store_pickup" ? selectedStore.name : address.title}</strong>
                <small>{mode === "store_pickup" ? `同店取还 · ${selectedStore.businessHours}` : `同址送取 · ${address.district}`}</small>
              </span>
              <CaretRight size={21} />
            </button>
            <div className="rental-time-row">
              <button onClick={() => setSheet("pickup")} data-testid="rental-pickup-time"><small>取车时间</small><strong>{pickupMoment.date}</strong><em>{pickupMoment.time}</em></button>
              <span><i /><b>{billableDays}天</b><i /></span>
              <button onClick={() => setSheet("return")} data-testid="rental-return-time"><small>还车时间</small><strong>{returnMoment.date}</strong><em>{returnMoment.time}</em></button>
            </div>
            {!validDuration ? <p className="rental-inline-error"><Warning size={15} />租期需为1–30天，且还车时间必须晚于取车时间</p> : null}
            <button className="rental-search-submit" disabled={!validDuration} onClick={submitSearch} data-testid="rental-search-submit">立即选车</button>
          </section>

          <section className="rental-trust-strip" aria-label="租车服务保障">
            <span><ShieldCheck size={21} weight="duotone" />指定车型保障</span>
            <i />
            <span><Receipt size={21} weight="duotone" />费用透明</span>
            <i />
            <button onClick={() => flow.push(serviceScreen("租车客服", "24小时演示客服入口，可咨询门店、车型、取还规则与订单问题。"))}><Headset size={21} weight="duotone" />24小时客服</button>
          </section>

          <section className="rental-home-heading">
            <div><h2>热门车型</h2><p>公司自营车队 · 指定车型</p></div>
            <button onClick={submitSearch}>全部车型 <CaretRight size={17} /></button>
          </section>
          <section className="rental-hot-grid" aria-label="热门租赁车型">
            {hotModels.map((model) => {
              const rate = RENTAL_RATE_SEED[model.id] || 21_800;
              return (
                <button key={model.id} onClick={submitSearch} data-testid={`rental-hot-${model.id}`}>
                  <img src={model.imageUrls[0] || rentalModelImage(model.id)} alt={`${model.brandName}${model.name}真实车型参考图`} draggable={false} />
                  <span><strong>{model.brandName}{model.name}</strong><em>{RENTAL_CATEGORY_LABEL[model.category]}</em></span>
                  <small>{RENTAL_ENERGY_LABEL[model.energyType]} <i /> {model.seats}座 <i /> {model.transmission}</small>
                  <b><small>日均 ¥</small>{formatMoney(rate)}<small>起</small></b>
                  <p>{billableDays}天车辆租金 ¥{formatMoney(rate * billableDays)}起</p>
                </button>
              );
            })}
          </section>
          <button className="rental-orders-link" onClick={() => orders.length ? flow.replace(ordersScreen()) : flow.push(serviceScreen("我的租车订单", "完成租车预订后，可在底部“订单”中查看模拟支付和履约进度。"))}><Receipt size={22} weight="duotone" /><span><strong>我的租车订单</strong><small>{orders.length ? `${orders.length}个订单 · 查看履约进度` : "下单后可查看模拟支付与履约进度"}</small></span><CaretRight size={19} /></button>
          <p className="rental-demo-note"><Info size={15} />车型、价格、押金、门店与订单均为合成演示数据，不发生真实资金冻结。</p>
          {loading ? <p className="rental-syncing"><CircleNotch className="spin" size={15} />正在同步租赁目录</p> : null}
        </main>
      </MobileScroll>

      <BottomSheet open={sheet !== null} onOpenChange={(open) => { if (!open) setSheet(null); }} title={sheet === "store" ? "选择取还门店" : sheet === "address" ? "选择同址送取地址" : sheet === "pickup" ? "选择取车时间" : "选择还车时间"} description={sheet === "address" ? "送车与取回使用同一地址，费用按真实路线计算" : sheet === "store" ? "当前版本仅支持同店还车" : "短租按每24小时计一天，不足一天向上取整"}>
        {sheet === "store" ? <div className="rental-sheet-list">{stores.map((store) => <button key={store.id} className={store.id === selectedStore.id ? "active" : ""} onClick={() => { setStoreId(store.id); setSheet(null); }}><MapPin size={20} weight="duotone" /><span><strong>{store.name}</strong><small>{store.address} · {store.businessHours}</small></span>{store.id === selectedStore.id ? <Check size={19} weight="bold" /> : null}</button>)}</div> : null}
        {sheet === "address" ? <div className="rental-sheet-list">{FALLBACK_RENTAL_ADDRESSES.map((item) => <button key={item.poiId} className={item.poiId === address.poiId ? "active" : ""} onClick={() => { setAddress(item); setSheet(null); }}><NavigationArrow size={20} weight="duotone" /><span><strong>{item.title}</strong><small>{item.address}</small></span>{item.poiId === address.poiId ? <Check size={19} weight="bold" /> : null}</button>)}</div> : null}
        {sheet === "pickup" ? <div className="rental-time-options">{pickupOptions.map((value) => { const moment = formatRentalMoment(value); return <button key={value} className={value === pickupAt ? "active" : ""} onClick={() => { setPickupAt(value); if (Date.parse(returnAt) <= Date.parse(value)) setReturnAt(rentalDateOption(value, 3)); setSheet(null); }}><CalendarBlank size={20} /><span><strong>{moment.date}</strong><small>{moment.time} 取车</small></span>{value === pickupAt ? <Check size={18} /> : null}</button>; })}</div> : null}
        {sheet === "return" ? <div className="rental-time-options">{returnOptions.map((value) => { const moment = formatRentalMoment(value); return <button key={value} className={value === returnAt ? "active" : ""} onClick={() => { setReturnAt(value); setSheet(null); }}><CalendarCheck size={20} /><span><strong>{moment.date}</strong><small>{moment.time} 还车 · {rentalBillableDays(pickupAt, value)}天</small></span>{value === returnAt ? <Check size={18} /> : null}</button>; })}</div> : null}
      </BottomSheet>
    </>
  );
}

function RentalOffersScreen({ search }: { search: RentalSearchInput }) {
  const flow = useFlow();
  const { catalog, searchOffers } = useRental();
  const [page, setPage] = useState<RentalOfferPage>({ items: [], total: 0, page: 1, pageSize: 30, search });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<RentalSort>(search.sort || "recommended");
  const [category, setCategory] = useState<RentalVehicleCategory | "">(search.category || "");
  const [energyType, setEnergyType] = useState<RentalEnergyType | "">(search.energyType || "");
  const [brandId, setBrandId] = useState(search.brandId || "");
  const [sheet, setSheet] = useState<"brand" | "filter" | "sort" | null>(null);
  const runSearch = () => {
    setLoading(true);
    setError("");
    void searchOffers({ ...search, sort, category, energyType, brandId: brandId || undefined }).then(setPage).catch((caught) => setError(caught instanceof Error ? caught.message : "暂时无法读取可租车型")).finally(() => setLoading(false));
  };
  useEffect(runSearch, [sort, category, energyType, brandId, search.pickupAt, search.returnAt, search.storeId, search.fulfillmentMode]);
  const pickup = formatRentalMoment(search.pickupAt);
  const returned = formatRentalMoment(search.returnAt);
  const selectedBrand = catalog.groups.flatMap((group) => group.brands).find((brand) => brand.id === brandId);
  const sortLabels: Record<RentalSort, string> = { recommended: "综合推荐", daily_price_asc: "日均最低", total_price_asc: "总价最低" };

  return (
    <>
      <MobileScroll className="app-scroll rental-scroll">
        <main className="rental-offers-page" data-testid="car-rental-offers">
          <button className="rental-search-summary" onClick={flow.pop}>
            <MapPin size={20} weight="fill" />
            <span><strong>{search.fulfillmentMode === "store_pickup" ? page.items[0]?.store.name || "天津租赁门店" : search.deliveryAddress?.title || "同址送取"}</strong><small>{pickup.date} {pickup.time} — {returned.date} {returned.time} · {rentalBillableDays(search.pickupAt, search.returnAt)}天</small></span>
            <em>修改</em><CaretRight size={17} />
          </button>
          <Carousel ariaLabel="车型分类" className="rental-category-carousel" contentClassName="rental-category-track">
            {([ ["", "全部"], ["economy", "经济型"], ["comfort", "舒适型"], ["suv", "SUV"], ["new_energy", "新能源"], ["mpv", "MPV"], ["premium", "豪华型"] ] as Array<[RentalVehicleCategory | "", string]>).map(([value, label]) => <button key={label} className={category === value ? "active" : ""} onClick={() => setCategory(value)}>{label}</button>)}
          </Carousel>
          <section className="rental-offer-toolbar">
            <button className={brandId ? "active" : ""} onClick={() => setSheet("brand")}>{selectedBrand?.name || "品牌"}<CaretDown size={14} /></button>
            <button className={sort !== "recommended" ? "active" : ""} onClick={() => setSheet("sort")}>{sortLabels[sort]}<CaretDown size={14} /></button>
            <button className={energyType ? "active" : ""} onClick={() => setSheet("filter")}>筛选<Funnel size={16} /></button>
          </section>
          {loading ? <div className="rental-result-state"><CircleNotch className="spin" size={30} /><h2>正在核对所选租期的车型容量</h2><p>租金、必缴费和门店库存均由服务端计算</p></div> : error ? <div className="rental-result-state error"><Warning size={38} weight="duotone" /><h2>暂时无法获取租赁报价</h2><p>{error}</p><button onClick={runSearch}>重新加载</button></div> : page.items.length === 0 ? <div className="rental-result-state"><Car size={42} weight="duotone" /><h2>所选条件下暂无可租车型</h2><p>可调整品牌、能源或返回修改取还时间。</p><button onClick={() => { setBrandId(""); setEnergyType(""); setCategory(""); }}>清空筛选</button></div> : <>
            <div className="rental-result-heading"><span><strong>{page.total}</strong>款指定车型可租</span><small>预计总价已含必缴费</small></div>
            <section className="rental-offer-grid" aria-label="可租车型列表">
              {page.items.map((offer) => <button key={offer.id} className="rental-offer-card" data-testid={`rental-offer-${offer.model.id}`} onClick={() => flow.push(rentalModelDetailScreen(offer.model.id, search))}>
                <span className="rental-offer-image"><img src={offer.model.imageUrls[0] || rentalModelImage(offer.model.id)} alt={`${offer.model.brandName}${offer.model.name}真实车型参考图`} draggable={false} /><em><ShieldCheck size={12} weight="fill" />指定车型</em></span>
                <strong>{offer.model.brandName}{offer.model.name}</strong>
                <small>{offer.model.seats}座 · {RENTAL_ENERGY_LABEL[offer.model.energyType]} · {offer.model.transmission}</small>
                <div><span>日均 <b>¥{formatMoney(offer.averageDailyRateFen)}</b>起</span><CaretRight size={17} /></div>
                <p>{offer.billableDays}天预计 ¥{formatMoney(offer.estimatedTotalFen)}<small>已含必缴费</small></p>
              </button>)}
            </section>
          </>}
          <p className="rental-demo-note"><Info size={15} />车型图为对应车型参考图；价格、可租容量、门店与订单为合成演示数据。</p>
        </main>
      </MobileScroll>
      <BottomSheet open={sheet !== null} onOpenChange={(open) => { if (!open) setSheet(null); }} title={sheet === "brand" ? "选择品牌" : sheet === "sort" ? "车型排序" : "筛选车型"} description={sheet === "brand" ? "按拼音首字母排列，数量为所选租期的可租车型数" : undefined}>
        {sheet === "brand" ? <div className="rental-brand-sheet"><button className={!brandId ? "active" : ""} onClick={() => { setBrandId(""); setSheet(null); }}><span className="rental-brand-all"><Car size={22} weight="duotone" /></span><strong>全部品牌</strong>{!brandId ? <Check size={18} /> : null}</button>{catalog.groups.map((group) => <section key={group.initial}><h3>{group.initial}</h3>{group.brands.map((brand) => <button key={brand.id} className={brandId === brand.id ? "active" : ""} onClick={() => { setBrandId(brand.id); setSheet(null); }}><img src={usedCarAssetUrl(brand.logoUrl)} alt={`${brand.name}车标`} /><span><strong>{brand.name}</strong><small>{brand.availableModelCount}款可租</small></span>{brandId === brand.id ? <Check size={18} /> : null}</button>)}</section>)}</div> : null}
        {sheet === "sort" ? <div className="rental-sheet-list">{(Object.entries(sortLabels) as Array<[RentalSort, string]>).map(([value, label]) => <button key={value} className={sort === value ? "active" : ""} onClick={() => { setSort(value); setSheet(null); }}><Receipt size={20} weight="duotone" /><span><strong>{label}</strong><small>{value === "recommended" ? "兼顾价格、车型与容量" : value === "daily_price_asc" ? "按车辆租金日均价排序" : "按已含必缴费的预计总价排序"}</small></span>{sort === value ? <Check size={18} /> : null}</button>)}</div> : null}
        {sheet === "filter" ? <div className="rental-filter-sheet"><FilterChoice title="能源类型" options={[["", "不限"], ["gasoline", "汽油"], ["hybrid", "油电混动"], ["plug_in_hybrid", "插电混动"], ["range_extended", "增程式"], ["pure_electric", "纯电动"]]} value={energyType} onChange={(value) => setEnergyType(value as RentalEnergyType | "")} /><button className="rental-filter-confirm" onClick={() => setSheet(null)}>查看可租车型</button></div> : null}
      </BottomSheet>
    </>
  );
}

function RentalModelDetailScreen({ modelId, search }: { modelId: string; search: RentalSearchInput }) {
  const flow = useFlow();
  const { fetchModel, createQuote } = useRental();
  const [model, setModel] = useState<RentalModel | null>(null);
  const [quote, setQuote] = useState<RentalQuote | null>(null);
  const [optionalProtection, setOptionalProtection] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([fetchModel(modelId), createQuote({ ...search, modelId, optionalProtectionSelected: optionalProtection })]).then(([nextModel, nextQuote]) => { if (active) { setModel(nextModel); setQuote(nextQuote); } }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "无法生成租赁报价"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [modelId, optionalProtection]);
  if (loading) return <MobileScroll className="app-scroll rental-scroll"><div className="rental-result-state"><CircleNotch className="spin" size={30} /><h2>正在生成透明报价</h2></div></MobileScroll>;
  if (error || !model || !quote) return <MobileScroll className="app-scroll rental-scroll"><div className="rental-result-state error"><Warning size={40} weight="duotone" /><h2>该车型暂时无法预订</h2><p>{error || "报价已失效，请返回重新选择"}</p><button onClick={flow.pop}>返回车型列表</button></div></MobileScroll>;
  const pickup = formatRentalMoment(quote.pickupAt);
  const returned = formatRentalMoment(quote.returnAt);
  return (
    <MobileScroll className="app-scroll rental-scroll">
      <main className="rental-detail-page" data-testid="car-rental-detail">
        <section className="rental-detail-gallery"><Carousel ariaLabel="车型图集" className="rental-detail-carousel" contentClassName="rental-detail-track">{model.imageUrls.map((url, index) => <figure key={`${url}-${index}`}><img src={url} alt={`${model.brandName}${model.name}第${index + 1}张车型参考图`} draggable={false} /><figcaption>{index + 1}/{model.imageUrls.length}</figcaption></figure>)}</Carousel><span>真实车型参考图</span></section>
        <section className="rental-detail-intro"><div><h1>{model.brandName}{model.name}</h1><em><ShieldCheck size={14} weight="fill" />指定车型</em></div><p>{RENTAL_CATEGORY_LABEL[model.category]} · {model.seats}座 · {model.transmission} · {RENTAL_ENERGY_LABEL[model.energyType]}</p><strong><small>日均 ¥</small>{formatMoney(quote.averageDailyRateFen)}<small>起</small></strong></section>
        <section className="rental-trip-card"><MapPin size={21} weight="fill" /><span><strong>{quote.store.name} · {quote.fulfillmentMode === "store_pickup" ? "同店取还" : "同址送取"}</strong><small>{pickup.date} {pickup.time} — {returned.date} {returned.time} · {quote.billableDays}天</small></span></section>
        <section className="rental-spec-grid"><div><Car size={21} weight="duotone" /><small>车型级别</small><strong>{RENTAL_CATEGORY_LABEL[model.category]}</strong></div><div><UserCircle size={21} weight="duotone" /><small>乘坐人数</small><strong>{model.seats}座</strong></div><div><SteeringWheel size={21} weight="duotone" /><small>变速箱</small><strong>{model.transmission}</strong></div><div><Lightning size={21} weight="duotone" /><small>能源</small><strong>{RENTAL_ENERGY_LABEL[model.energyType]}</strong></div></section>
        <section className="rental-protection-card"><header><span><small>保障服务</small><h2>选择保障方案</h2></span><ShieldCheck size={24} weight="duotone" /></header><button className={!optionalProtection ? "active" : ""} onClick={() => setOptionalProtection(false)}><span><strong>基础保障</strong><small>必选 · 已计入应付金额</small></span><b>¥60/天</b>{!optionalProtection ? <CheckCircle size={20} weight="fill" /> : null}</button><button className={optionalProtection ? "active" : ""} onClick={() => setOptionalProtection(true)}><span><strong>安心保障</strong><small>演示附加保障服务</small></span><b>+¥60/天</b>{optionalProtection ? <CheckCircle size={20} weight="fill" /> : null}</button></section>
        <RentalFeeBreakdown quote={quote} />
        <section className="rental-policy-card"><h2>用车规则</h2><div><span><Gauge size={19} />{quote.mileagePolicy}</span><span><Drop size={19} />{quote.energyReturnPolicy}</span><span><Clock size={19} />30分钟宽限</span></div><p>取车需核验本人有效驾驶证；超过宽限时间后的费用由运营人员按演示规则登记。</p></section>
        <button className="rental-primary-action" onClick={() => flow.push(rentalConfirmScreen(quote, search))} data-testid="rental-detail-book">确认方案 · ¥{formatMoney(quote.payableFen)}</button>
        <p className="rental-demo-note"><Info size={15} />车型参考图不代表最终交付颜色；车辆、租金、押金、保障与订单均为合成演示数据。</p>
      </main>
    </MobileScroll>
  );
}

function RentalFeeBreakdown({ quote }: { quote: RentalQuote }) {
  return <section className="rental-fee-card" data-testid="rental-fee-breakdown"><header><span><small>费用透明</small><h2>费用明细</h2></span><Receipt size={24} weight="duotone" /></header><div><span>车辆租金</span><strong>¥{formatMoney(quote.rentalFeeFen)}</strong></div><div><span>基础保障（¥60 × {quote.billableDays}天）</span><strong>¥{formatMoney(quote.baseProtectionFeeFen)}</strong></div><div><span>整备服务费</span><strong>¥{formatMoney(quote.prepFeeFen)}</strong></div>{quote.optionalProtectionFeeFen ? <div><span>安心保障</span><strong>¥{formatMoney(quote.optionalProtectionFeeFen)}</strong></div> : null}{quote.deliveryFeeFen ? <div><span>同址送取费</span><strong>¥{formatMoney(quote.deliveryFeeFen)}</strong></div> : null}<footer><span>预计应付<small>已含全部必缴费用</small></span><strong>¥{formatMoney(quote.payableFen)}</strong></footer><aside><span>取车时模拟预授权</span><div><p><small>车辆押金</small><strong>¥{formatMoney(quote.vehicleDepositFen)}</strong></p><p><small>违章押金</small><strong>¥{formatMoney(quote.violationDepositFen)}</strong></p></div><em>押金不计入应付金额，不发生真实资金冻结</em></aside></section>;
}

function RentalConfirmScreen({ quote, search }: { quote: RentalQuote; search: RentalSearchInput }) {
  const flow = useFlow();
  const { createOrder } = useRental();
  const { showToast } = useMvp();
  const [driverName, setDriverName] = useState("张先生");
  const [driverPhone, setDriverPhone] = useState("13800138000");
  const [licenseConfirmed, setLicenseConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const valid = driverName.trim().length > 1 && /^1\d{10}$/.test(driverPhone) && licenseConfirmed;
  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const order = await createOrder({ quote, driverName: driverName.trim(), driverPhone, validLicenseConfirmed: licenseConfirmed });
      flow.push(rentalPaymentScreen(order.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "租车订单创建失败");
    } finally {
      setSubmitting(false);
    }
  };
  const pickup = formatRentalMoment(quote.pickupAt);
  const returned = formatRentalMoment(quote.returnAt);
  return <MobileScroll className="app-scroll rental-scroll"><main className="rental-confirm-page" data-testid="car-rental-confirm"><section className="rental-confirm-model"><img src={quote.model.imageUrls[0]} alt={`${quote.model.brandName}${quote.model.name}车型参考图`} /><span><small>指定车型</small><h1>{quote.model.brandName}{quote.model.name}</h1><p>{quote.model.seats}座 · {RENTAL_ENERGY_LABEL[quote.model.energyType]} · {quote.model.transmission}</p></span></section><section className="rental-confirm-trip"><div><MapPin size={20} /><span><small>{quote.fulfillmentMode === "store_pickup" ? "取还门店" : "同址送取"}</small><strong>{quote.fulfillmentMode === "store_pickup" ? quote.store.name : search.deliveryAddress?.title || quote.store.name}</strong></span></div><div><CalendarBlank size={20} /><span><small>租期</small><strong>{pickup.date} {pickup.time} — {returned.date} {returned.time}</strong><em>共{quote.billableDays}天</em></span></div></section><section className="rental-driver-card"><header><IdentificationCard size={23} weight="duotone" /><span><small>承租人信息</small><h2>驾驶员</h2></span></header><Field label="驾驶员姓名"><KeyboardInput value={driverName} placeholder="请输入姓名" onChange={(event) => setDriverName(event.target.value.slice(0, 30))} /></Field><Field label="联系电话"><KeyboardInput inputMode="numeric" value={driverPhone} placeholder="请输入11位手机号" onChange={(event) => setDriverPhone(event.target.value.replace(/\D/g, "").slice(0, 11))} /></Field><button type="button" role="checkbox" aria-checked={licenseConfirmed} className={`rental-license-check ${licenseConfirmed ? "checked" : ""}`} onClick={() => setLicenseConfirmed((value) => !value)}><span>{licenseConfirmed ? <Check size={16} weight="bold" /> : null}</span><p><strong>本人已年满18周岁并持有效驾驶证</strong><small>演示版不采集身份证或驾驶证照片，取车时由门店线下核验。</small></p></button></section><RentalFeeBreakdown quote={quote} /><button className="rental-primary-action" disabled={!valid || submitting} onClick={() => void submit()} data-testid="rental-submit-order">{submitting ? <CircleNotch className="spin" size={20} /> : <Receipt size={20} />}提交订单 · ¥{formatMoney(quote.payableFen)}</button><p className="rental-demo-note"><Info size={15} />提交后进入本地模拟支付，不调用真实支付SDK、不扣款。</p></main></MobileScroll>;
}

function RentalPaymentScreen({ orderId }: { orderId: string }) {
  const flow = useFlow();
  const { fetchOrder, payOrder } = useRental();
  const [order, setOrder] = useState<RentalOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => void fetchOrder(orderId).then(setOrder).catch((caught) => setError(caught instanceof Error ? caught.message : "订单读取失败"));
  useEffect(load, [orderId]);
  const pay = async () => {
    if (!order || busy) return;
    setBusy(true);
    try {
      const updated = await payOrder(order.id);
      setOrder(updated);
      flow.replace(rentalOrderDetailScreen(updated.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模拟支付失败");
    } finally { setBusy(false); }
  };
  if (!order) return <MobileScroll className="app-scroll rental-scroll"><div className="rental-result-state">{error ? <><Warning size={38} /><h2>{error}</h2></> : <><CircleNotch className="spin" size={30} /><h2>正在读取待支付订单</h2></>}</div></MobileScroll>;
  return <MobileScroll className="app-scroll rental-scroll"><main className="rental-payment-page" data-testid="car-rental-payment"><section className="rental-payment-hero"><ShieldCheck size={46} weight="duotone" /><small>本地模拟支付</small><h1>¥{formatMoney(order.payableFen)}</h1><p>不会跳转支付SDK，不会产生真实扣款或资金冻结。</p></section><section className="rental-payment-summary"><div><span>订单号</span><strong>{order.orderNumber}</strong></div><div><span>指定车型</span><strong>{order.model.brandName}{order.model.name}</strong></div><div><span>租期</span><strong>{order.billableDays}天</strong></div><div><span>押金</span><strong>取车时模拟预授权，不计入应付</strong></div></section>{order.status === "expired" ? <section className="rental-payment-expired"><Warning size={22} /><span><strong>订单已过期</strong><small>15分钟车型容量保留期已结束，请重新搜索。</small></span></section> : null}{error ? <p className="rental-inline-error"><Warning size={15} />{error}</p> : null}<button className="rental-primary-action" disabled={busy || order.status !== "pending_payment"} onClick={() => void pay()} data-testid="rental-mock-pay">{busy ? <CircleNotch className="spin" size={20} /> : <ShieldCheck size={20} />}确认模拟支付 ¥{formatMoney(order.payableFen)}</button>{order.status === "pending_payment" ? <p className="rental-payment-countdown">订单容量保留15分钟 · 支付成功后状态自动变为“已确认”</p> : null}</main></MobileScroll>;
}

const RENTAL_STATUS_LABEL: Record<RentalOrderStatus, string> = { pending_payment: "待支付", confirmed: "已确认", ready_for_pickup: "待取车", in_use: "用车中", return_pending: "待验车", completed: "已完成", cancelled: "已取消", expired: "已过期" };

function RentalOrderDetailScreen({ orderId }: { orderId: string }) {
  const flow = useFlow();
  const { fetchOrder, cancelOrder } = useRental();
  const [order, setOrder] = useState<RentalOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const load = () => void fetchOrder(orderId).then(setOrder).catch(() => setOrder(null));
  useEffect(load, [orderId]);
  if (!order) return <MobileScroll className="app-scroll rental-scroll"><div className="rental-result-state"><CircleNotch className="spin" size={30} /><h2>正在读取租车订单</h2></div></MobileScroll>;
  const steps: Array<[RentalOrderStatus, string]> = [["confirmed", "订单确认"], ["ready_for_pickup", "准备取车"], ["in_use", "车辆使用中"], ["return_pending", "归还验车"], ["completed", "订单完成"]];
  const currentIndex = steps.findIndex(([status]) => status === order.status);
  const cancel = async () => { setBusy(true); try { setOrder(await cancelOrder(order.id)); setCancelOpen(false); } finally { setBusy(false); } };
  return <><MobileScroll className="app-scroll rental-scroll"><main className="rental-order-page" data-testid="car-rental-order-detail"><section className={`rental-order-status status-${order.status}`}><small>当前状态</small><h1>{RENTAL_STATUS_LABEL[order.status]}</h1><p>{order.status === "pending_payment" ? "车型容量正在保留，请在15分钟内完成模拟支付。" : order.status === "confirmed" ? "订单已确认，运营人员将在取车前分配具体车辆。" : order.status === "cancelled" ? "订单已取消，车型容量已释放。" : "履约状态由运营后台推进并实时展示。"}</p></section><section className="rental-order-model"><img src={order.model.imageUrls[0]} alt={`${order.model.brandName}${order.model.name}车型参考图`} /><span><small>指定车型</small><h2>{order.model.brandName}{order.model.name}</h2><p>{order.store.name} · {order.fulfillmentMode === "store_pickup" ? "同店取还" : "同址送取"}</p></span></section>{!["pending_payment", "cancelled", "expired"].includes(order.status) ? <section className="rental-order-timeline">{steps.map(([status, label], index) => { const reached = order.status === "completed" || currentIndex >= index; return <div key={status} className={reached ? "reached" : ""}><span>{reached ? <Check size={14} weight="bold" /> : index + 1}</span><p><strong>{label}</strong><small>{index === currentIndex ? "当前进度" : reached ? "已完成" : "等待推进"}</small></p>{index < steps.length - 1 ? <i /> : null}</div>; })}</section> : null}<section className="rental-order-info"><div><CalendarBlank size={19} /><span><small>取还时间</small><strong>{formatDateTime(order.pickupAt)} — {formatDateTime(order.returnAt)}</strong></span></div><div><IdentificationCard size={19} /><span><small>驾驶员</small><strong>{order.driverName} · {order.driverPhone.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2")}</strong></span></div><div><Receipt size={19} /><span><small>订单金额</small><strong>¥{formatMoney(order.payableFen)} · 押金不计入</strong></span></div></section>{order.events.length ? <section className="rental-order-events"><h2>订单记录</h2>{order.events.slice().reverse().map((event) => <div key={event.id}><span /><p><strong>{event.title}</strong><small>{event.description}</small><em>{formatDateTime(event.createdAt)}</em></p></div>)}</section> : null}<button className="rental-orders-link" onClick={() => flow.replace(ordersScreen())}><Receipt size={21} /><span><strong>查看全部订单</strong><small>年检、洗车与租车记录统一查看</small></span><CaretRight size={18} /></button>{["pending_payment", "confirmed"].includes(order.status) ? <button className="rental-cancel-action" onClick={() => setCancelOpen(true)}>取消租车订单</button> : null}<p className="rental-demo-note"><Info size={15} />本页订单、车辆、金额和履约状态均为合成演示数据。</p></main></MobileScroll><BottomSheet open={cancelOpen} onOpenChange={setCancelOpen} title="取消租车订单" description="取消后将释放车型容量；模拟支付订单只记录退款状态，不发生真实资金变动。"><div className="sheet-actions"><button className="secondary-button" onClick={() => setCancelOpen(false)}>保留订单</button><button className="danger-button" disabled={busy} onClick={() => void cancel()}>确认取消</button></div></BottomSheet></>;
}

function UsedCarBrandScreen({ selectedBrandId }: { selectedBrandId?: string }) {
  const flow = useFlow();
  const [catalog, setCatalog] = useState<UsedCarCatalog>(FALLBACK_USED_CAR_CATALOG);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void loadUsedCarCatalog().then((next) => {
      if (active) setCatalog(next);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const normalizedSearch = search.trim().toLowerCase();
  const groups = catalog.groups.map((group) => ({
    ...group,
    brands: group.brands.filter((brand) => !normalizedSearch || brand.name.toLowerCase().includes(normalizedSearch) || brand.initial.toLowerCase() === normalizedSearch),
  })).filter((group) => group.brands.length > 0);
  const initials = catalog.groups.map((group) => group.initial);

  const chooseBrand = (brand: UsedCarBrand) => flow.push(usedCarModelScreen(brand.id));

  return (
    <MobileScroll className="app-scroll used-car-scroll">
      <main className="used-car-brand-page" data-testid="used-car-brand-page">
        <label className="used-car-search">
          <MagnifyingGlass size={22} />
          <KeyboardInput aria-label="搜索品牌" value={search} placeholder="搜索品牌" onChange={(event) => setSearch(event.target.value.slice(0, 24))} />
        </label>

        {!normalizedSearch ? (
          <section className="used-car-hot-section">
            <h2>热门品牌</h2>
            <div className="used-car-hot-grid">
              {catalog.hotBrands.slice(0, 5).map((brand) => (
                <button key={brand.id} onClick={() => chooseBrand(brand)} data-testid={`used-car-hot-${brand.id}`}>
                  <img src={usedCarAssetUrl(brand.logoUrl)} alt={`${brand.name}车标`} draggable={false} />
                  <span>{brand.name}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {loading ? <div className="used-car-loading"><CircleNotch className="spin" size={26} />正在读取品牌目录</div> : null}
        {!loading && groups.length === 0 ? (
          <EmptyState icon={<MagnifyingGlass size={34} />} title="没有找到这个品牌" copy="试试输入品牌中文名或首字母" action="清空搜索" onAction={() => setSearch("")} />
        ) : (
          <div className="used-car-brand-groups">
            {groups.map((group) => (
              <section key={group.initial} data-used-car-initial={group.initial}>
                <h3>{group.initial}</h3>
                {group.brands.map((brand) => (
                  <button
                    className={`used-car-brand-row ${brand.id === selectedBrandId ? "active" : ""}`}
                    key={brand.id}
                    onClick={() => chooseBrand(brand)}
                    data-testid={`used-car-brand-${brand.id}`}
                    aria-current={brand.id === selectedBrandId ? "true" : undefined}
                  >
                    <img src={usedCarAssetUrl(brand.logoUrl)} alt={`${brand.name}车标`} draggable={false} />
                    <strong>{brand.name}</strong>
                    <span>{brand.listingCount}辆</span>
                    <CaretRight size={18} />
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}

        {!normalizedSearch ? (
          <nav className="used-car-index" aria-label="品牌首字母索引">
            {initials.map((initial) => (
              <button key={initial} onClick={() => document.querySelector(`[data-used-car-initial="${initial}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{initial}</button>
            ))}
          </nav>
        ) : null}
        <p className="used-car-picker-footnote">选择品牌后继续选择车型 · 图片为可追溯的真实车型参考图</p>
      </main>
    </MobileScroll>
  );
}

function UsedCarModelScreen({ brandId }: { brandId: string }) {
  const flow = useFlow();
  const [catalog, setCatalog] = useState<UsedCarCatalog>(FALLBACK_USED_CAR_CATALOG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void loadUsedCarCatalog().then((next) => {
      if (active) setCatalog(next);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const brand = catalog.groups.flatMap((group) => group.brands).find((item) => item.id === brandId)
    ?? FALLBACK_USED_CAR_CATALOG.groups.flatMap((group) => group.brands).find((item) => item.id === brandId);

  if (!brand) return <MobileScroll className="app-scroll"><EmptyState icon={<Car size={36} />} title="品牌暂不可用" copy="品牌可能已停用，请返回重新选择" action="重新选品牌" onAction={() => flow.replace(usedCarBrandScreen())} /></MobileScroll>;

  return (
    <MobileScroll className="app-scroll used-car-scroll">
      <main className="used-car-model-page" data-testid="used-car-model-page">
        <section className="used-car-model-brand">
          <img src={usedCarAssetUrl(brand.logoUrl)} alt={`${brand.name}车标`} draggable={false} />
          <div><small>已选品牌</small><h1>{brand.name}</h1><p>{brand.models.length} 个车型 · {brand.listingCount} 辆在售</p></div>
          <button onClick={() => flow.replace(usedCarBrandScreen(brand.id))}>更换</button>
        </section>
        <div className="used-car-section-title"><div><h2>选择车型</h2><p>零库存车型仍可查看，后续上新会自动展示</p></div></div>
        {loading ? <div className="used-car-loading"><CircleNotch className="spin" size={26} />正在读取车型</div> : null}
        <section className="used-car-model-grid">
          {brand.models.map((model) => (
            <button key={model.id} onClick={() => flow.push(usedCarMarketScreen(brand.id, model.id))} data-testid={`used-car-model-${model.id}`}>
              <span className="used-car-model-icon"><Car size={27} weight="duotone" /></span>
              <strong>{model.name}</strong>
              <small>{USED_CAR_BODY_LABEL[model.bodyType]} · {USED_CAR_ENERGY_LABEL[model.energyType]}</small>
              <em className={model.listingCount === 0 ? "empty" : ""}>{model.listingCount === 0 ? "暂无在售" : `${model.listingCount}辆在售`}</em>
            </button>
          ))}
        </section>
        <p className="used-car-data-note"><Info size={16} />车型图片为真实车型参考图；在售库存数量与车辆档案仍为演示数据。</p>
      </main>
    </MobileScroll>
  );
}

function UsedCarMarketScreen({ brandId, modelId }: { brandId: string; modelId: string }) {
  const flow = useFlow();
  const [catalog, setCatalog] = useState<UsedCarCatalog>(FALLBACK_USED_CAR_CATALOG);
  const [page, setPage] = useState<UsedCarListingPage>({ items: [], total: 0, page: 1, pageSize: 24 });
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<UsedCarSort>("recommended");
  const [sheet, setSheet] = useState<"sort" | "filter" | null>(null);
  const [pricePreset, setPricePreset] = useState<"all" | "under15" | "15to25" | "over25">("all");
  const [maxAgeYears, setMaxAgeYears] = useState<number | undefined>();
  const [maxMileageKm, setMaxMileageKm] = useState<number | undefined>();
  const [energyType, setEnergyType] = useState<UsedCarEnergyType | "">("");

  useEffect(() => {
    let active = true;
    void loadUsedCarCatalog().then((next) => { if (active) setCatalog(next); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const priceMinFen = pricePreset === "15to25" ? 15_000_000 : pricePreset === "over25" ? 25_000_000 : undefined;
    const priceMaxFen = pricePreset === "under15" ? 15_000_000 : pricePreset === "15to25" ? 25_000_000 : undefined;
    void loadUsedCarListings({ brandId, modelId, sort, priceMinFen, priceMaxFen, maxAgeYears, maxMileageKm, energyType, pageSize: 24 }).then((next) => {
      if (active) setPage(next);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [brandId, modelId, sort, pricePreset, maxAgeYears, maxMileageKm, energyType]);

  const brands = catalog.groups.flatMap((group) => group.brands);
  const brand = brands.find((item) => item.id === brandId) ?? FALLBACK_USED_CAR_CATALOG.groups.flatMap((group) => group.brands).find((item) => item.id === brandId)!;
  const model = brand.models.find((item) => item.id === modelId) ?? USED_CAR_MODEL_SEED.filter((item) => item[1] === brandId).map(([id, ownerId, name, bodyType, modelEnergy]) => ({ id, brandId: ownerId, name, bodyType, energyType: modelEnergy, listingCount: 0 })).find((item) => item.id === modelId)!;
  const activeFilterCount = Number(pricePreset !== "all") + Number(maxAgeYears !== undefined) + Number(maxMileageKm !== undefined) + Number(Boolean(energyType));
  const sortLabels: Record<UsedCarSort, string> = { recommended: "推荐", newest: "新近上架", price_asc: "价格最低", price_desc: "价格最高", mileage_asc: "里程最少" };

  const resetFilters = () => {
    setPricePreset("all");
    setMaxAgeYears(undefined);
    setMaxMileageKm(undefined);
    setEnergyType("");
  };

  return (
    <>
      <MobileScroll className="app-scroll used-car-scroll">
        <main className="used-car-market-page" data-testid="used-car-market-page">
          <section className="used-car-selector-card">
            <button onClick={() => flow.push(usedCarBrandScreen(brand.id))}><span>品牌</span><strong>{brand.name}</strong><CaretDown size={17} /></button>
            <button onClick={() => flow.push(usedCarModelScreen(brand.id))}><span>车型</span><strong>{model.name}</strong><CaretDown size={17} /></button>
          </section>
          <section className="used-car-market-toolbar">
            <span>{loading ? "正在读取车源" : `${page.total}辆在售`}</span>
            <button className={sort !== "recommended" ? "active" : ""} onClick={() => setSheet("sort")}>{sortLabels[sort]} <CaretDown size={15} /></button>
            <button className={activeFilterCount > 0 ? "active" : ""} onClick={() => setSheet("filter")}>筛选{activeFilterCount ? ` ${activeFilterCount}` : ""} <Funnel size={17} /></button>
          </section>

          {loading ? (
            <div className="used-car-listing-loading"><CircleNotch className="spin" size={30} /><p>正在匹配具体车源</p></div>
          ) : page.items.length === 0 ? (
            <section className="used-car-empty-market">
              <Car size={44} weight="duotone" />
              <h2>这个车型暂时没有在售车源</h2>
              <p>车型会继续保留，后台上新后这里会自动出现具体车辆。</p>
              {activeFilterCount ? <button onClick={resetFilters}>清空筛选</button> : <button onClick={() => flow.push(usedCarModelScreen(brand.id))}>查看其他车型</button>}
            </section>
          ) : (
            <section className="used-car-listing-grid" aria-label="二手车车源列表">
              {page.items.map((listing) => (
                <button className="used-car-listing-card" key={listing.id} onClick={() => flow.push(usedCarDetailScreen(listing.id))} data-testid={`used-car-listing-${listing.id}`}>
                  <span className="used-car-listing-image">
                    <img src={usedCarAssetUrl(listing.coverImageUrl)} alt={`${listing.title}真实车型参考图`} draggable={false} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = `/assets/used-cars/models/${listing.modelId}.webp?v=${USED_CAR_ASSET_VERSION}`; }} />
                    {listing.featured ? <em><Sparkle size={12} weight="fill" />精选</em> : null}
                    <small><Images size={13} />{Math.max(listing.images?.length ?? 0, 1)}</small>
                  </span>
                  <strong>{listing.title}</strong>
                  <span className="used-car-listing-meta">{usedCarMileage(listing.mileageKm)} · {listing.location.replace("天津·", "")}</span>
                  <span className="used-car-listing-tag">{listing.transferCount === 0 ? "准新车" : "一车一档"}</span>
                  <b>{usedCarPriceWan(listing.priceFen)}</b>
                </button>
              ))}
            </section>
          )}

          <button className="used-car-support-card" onClick={() => flow.push(serviceScreen("专属客服", "工作日 08:30–17:30 提供二手车浏览、车辆信息和门店到访说明。"))}>
            <Headset size={32} weight="duotone" />
            <span><strong>有问题？专属客服为您解答</strong><small>工作日 08:30–17:30</small></span>
            <em>联系客服 <CaretRight size={16} /></em>
          </button>
          <p className="used-car-market-disclosure">图片为对应真实车型的参考图，不代表当前库存实车；车辆档案、价格、里程与车况为合成演示数据。</p>
        </main>
      </MobileScroll>

      <BottomSheet open={sheet !== null} onOpenChange={(open) => { if (!open) setSheet(null); }} title={sheet === "sort" ? "车源排序" : "筛选车源"} description={sheet === "sort" ? "选择更适合你的浏览顺序" : "筛选条件会实时作用于具体库存车"}>
        {sheet === "sort" ? (
          <div className="used-car-sheet-options">
            {(["recommended", "newest", "price_asc", "price_desc", "mileage_asc"] as UsedCarSort[]).map((option) => (
              <button className={sort === option ? "active" : ""} key={option} onClick={() => { setSort(option); setSheet(null); }}><span>{sortLabels[option]}</span>{sort === option ? <Check size={19} weight="bold" /> : null}</button>
            ))}
          </div>
        ) : (
          <div className="used-car-filter-sheet">
            <FilterChoice title="价格" options={[['all', '不限'], ['under15', '15万以下'], ['15to25', '15–25万'], ['over25', '25万以上']]} value={pricePreset} onChange={(value) => setPricePreset(value as typeof pricePreset)} />
            <FilterChoice title="车龄" options={[['all', '不限'], ['1', '1年内'], ['3', '3年内'], ['5', '5年内']]} value={maxAgeYears === undefined ? 'all' : String(maxAgeYears)} onChange={(value) => setMaxAgeYears(value === 'all' ? undefined : Number(value))} />
            <FilterChoice title="里程" options={[['all', '不限'], ['20000', '2万公里内'], ['50000', '5万公里内'], ['80000', '8万公里内']]} value={maxMileageKm === undefined ? 'all' : String(maxMileageKm)} onChange={(value) => setMaxMileageKm(value === 'all' ? undefined : Number(value))} />
            <FilterChoice title="能源" options={[['', '不限'], ['petrol', '汽油'], ['plug_in_hybrid', '插混'], ['range_extended', '增程'], ['electric', '纯电']]} value={energyType} onChange={(value) => setEnergyType(value as UsedCarEnergyType | "")} />
            <div className="used-car-filter-actions"><button onClick={resetFilters}>重置</button><button onClick={() => setSheet(null)}>查看车源</button></div>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

function FilterChoice({ title, options, value, onChange }: { title: string; options: Array<[string, string]>; value: string; onChange: (value: string) => void }) {
  return <section className="used-car-filter-group"><h3>{title}</h3><div>{options.map(([key, label]) => <button key={key} className={value === key ? "active" : ""} onClick={() => onChange(key)}>{label}</button>)}</div></section>;
}

function UsedCarDetailScreen({ listingId }: { listingId: string }) {
  const flow = useFlow();
  const [listing, setListing] = useState<UsedCarListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void loadUsedCarListing(listingId).then((next) => {
      if (active) setListing(next);
    }).catch(() => {
      if (active) setUnavailable(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [listingId]);

  if (loading) return <MobileScroll className="app-scroll used-car-scroll"><div className="used-car-detail-state"><CircleNotch className="spin" size={31} /><h2>正在读取车辆详情</h2></div></MobileScroll>;
  if (unavailable || !listing || listing.status !== "on_sale") return (
    <MobileScroll className="app-scroll used-car-scroll">
      <main className="used-car-detail-state unavailable" data-testid="used-car-unavailable"><Car size={50} weight="duotone" /><h1>车源已不可用</h1><p>这辆车可能已售出或下架，请返回查看其他在售车辆。</p><button onClick={flow.pop}>返回车源列表</button></main>
    </MobileScroll>
  );

  const images = listing.images?.length ? listing.images : [{ id: `${listing.id}-cover`, url: listing.coverImageUrl || "", sortOrder: 1, isCover: true }];
  const archiveRows = [
    ["首次上牌", listing.registrationDate],
    ["表显里程", usedCarMileage(listing.mileageKm)],
    ["车身颜色", listing.exteriorColor],
    ["车辆所在地", listing.location],
    ["过户次数", `${listing.transferCount}次`],
    ["能源类型", USED_CAR_ENERGY_LABEL[listing.energyType]],
  ];

  return (
    <MobileScroll className="app-scroll used-car-scroll">
      <main className="used-car-detail-page" data-testid="used-car-detail-page">
        <section className="used-car-gallery">
          <Carousel ariaLabel="车辆图集" className="used-car-gallery-carousel" contentClassName="used-car-gallery-track">
            {images.map((image, index) => <figure key={image.id}><img src={usedCarAssetUrl(image.url)} alt={`${listing.title}第${index + 1}张真实车型参考图`} draggable={false} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = `/assets/used-cars/models/${listing.modelId}.webp?v=${USED_CAR_ASSET_VERSION}`; }} /><figcaption>{index + 1}/{images.length}</figcaption></figure>)}
          </Carousel>
          <span>真实车型参考图</span>
        </section>

        <section className="used-car-detail-intro">
          <p><em>一口价</em><strong>{usedCarPriceWan(listing.priceFen)}</strong>{listing.guidePriceFen ? <small>参考新车指导价 {usedCarPriceWan(listing.guidePriceFen)}</small> : null}</p>
          <h1>{listing.title}</h1>
          <div>{listing.highlights.map((highlight) => <span key={highlight}>{highlight}</span>)}</div>
          <small>库存编号 {listing.stockNo}</small>
        </section>

        <section className="used-car-detail-section">
          <header><h2>车辆档案</h2><span>一车一档</span></header>
          <div className="used-car-archive-grid">{archiveRows.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
        </section>

        <section className="used-car-detail-section condition">
          <header><h2>车况说明</h2><ShieldCheck size={21} weight="duotone" /></header>
          <p>{listing.conditionSummary}</p>
        </section>

        <section className="used-car-detail-section defects">
          <header><h2>瑕疵披露</h2><span>{listing.defectsDisclosure.length}项</span></header>
          {listing.defectsDisclosure.map((defect) => <p key={defect}><Warning size={15} weight="duotone" />{defect}</p>)}
        </section>

        <button className="used-car-support-card" onClick={() => flow.push(serviceScreen("专属客服", "工作日 08:30–17:30 提供二手车车辆信息和门店到访说明。"))}>
          <Headset size={32} weight="duotone" />
          <span><strong>需要了解这辆车？</strong><small>统一客服入口 · 工作日 08:30–17:30</small></span>
          <em>联系客服 <CaretRight size={16} /></em>
        </button>
        <p className="used-car-detail-disclosure"><Info size={16} />图片展示对应的真实车型，但不代表这辆库存实车；价格、里程、车况与库存档案为合成演示数据。</p>
      </main>
    </MobileScroll>
  );
}

function VehicleHero({ vehicle, onVehicle, onQuery, onBook }: { vehicle: Vehicle; onVehicle: () => void; onQuery: () => void; onBook: () => void }) {
  const dateDisplay = vehicleDateDisplay(vehicle);
  const displayDate = dateDisplay.date || vehicle.inspectionDueDate;
  const dueDays = displayDate ? daysUntilIso(displayDate) : 0;
  const overdue = dueDays < 0;
  const dateConflict = dateDisplay.status === "conflict";
  const estimateOnly = dateDisplay.status === "estimated" || dateDisplay.status === "unverified";
  return (
    <section className="hero" data-testid="vehicle-hero">
      <div className="hero-visual">
        <img className="hero-image" src="/assets/brand/hero-car-tianjin.png" alt="天津城市天际线与白色轿车演示图" draggable={false} />
        <button className="vehicle-summary" onClick={onVehicle} aria-label={`管理车辆 ${vehicle.plateNumber}`}>
          <strong>{vehicle.plateNumber}</strong>
          <span>{vehicle.vehicleType} · {POWERTRAIN_LABELS[vehiclePowertrain(vehicle)]}</span>
        </button>
        <div className={`due-copy ${dateConflict ? "conflict" : overdue ? "overdue" : ""}`} data-testid="hero-date-evidence"><span>{dateConflict ? "日期待核验" : dateDisplay.label}</span>{dateConflict ? <strong className="due-conflict">待核验</strong> : <strong>{Math.abs(dueDays)}<em>天</em></strong>}<small>{displayDate || "暂无可展示日期"} · {dateDisplay.detail}</small></div>
      </div>
      <div className="hero-actions">
        <button className="primary-button hero-primary" data-testid="inspection-entry-booking" onClick={dateConflict || estimateOnly ? onQuery : onBook}><CalendarCheck size={23} weight="duotone" />{dateConflict ? "先核验再预约" : estimateOnly ? "先查询再预约" : "立即预约"}</button>
        <button className="secondary-button hero-secondary" data-testid="inspection-entry-hero" onClick={onQuery}><FileText size={21} weight="duotone" /><span data-testid="inspection-entry-query">查询是否需上线</span><CaretRight size={18} /></button>
      </div>
    </section>
  );
}

function EmptyVehicleHero({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="hero empty-hero">
      <img className="hero-image" src="/assets/brand/hero-car-tianjin.png" alt="天津城市天际线与白色轿车演示图" draggable={false} />
      <div className="hero-trust"><ShieldCheck size={17} /> 添加车辆后即可生成专属年检计划</div>
      <div className="empty-hero-copy"><span className="empty-icon"><Car size={34} weight="duotone" /></span><h1>先添加您的爱车</h1><p>一次录入，自动管理年检节点、材料与预约。</p></div>
      <button className="primary-button hero-primary empty-add" onClick={onAdd}><Plus size={23} weight="bold" />添加车辆</button>
    </section>
  );
}

function VehicleDateBadge({ vehicle }: { vehicle: Vehicle }) {
  const display = vehicleDateDisplay(vehicle);
  return <span className={`vehicle-date-badge ${display.status}`} data-testid={`vehicle-date-evidence-${vehicle.id}`}><Clock size={13} />{display.label}{display.date ? ` · ${display.date}` : ""}</span>;
}

function VehiclesScreen() {
  const flow = useFlow();
  const { vehicles, activeVehicleId, setActiveVehicleId, deleteVehicle, bookings, showToast } = useMvp();
  const [deleteTarget, setDeleteTarget] = useState<Vehicle | null>(null);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (bookings.some((item) => item.vehicleId === deleteTarget.id && !["completed", "cancelled"].includes(item.status))) {
      showToast("该车辆有进行中订单，暂不能删除");
      setDeleteTarget(null);
      return;
    }
    try {
      await deleteVehicle(deleteTarget.id);
      showToast("车辆已移除");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "移除失败");
    }
    setDeleteTarget(null);
  };

  return (
    <MobileScroll className="app-scroll">
      <main className="sub-page vehicle-page">
        <div className="page-lead"><span>共 {vehicles.length} 辆车</span><button onClick={() => flow.push(vehicleFormScreen())}><Plus size={18} />新增车辆</button></div>
        {vehicles.length ? vehicles.map((vehicle) => (
          <article className={`vehicle-card ${vehicle.id === activeVehicleId ? "selected" : ""}`} key={vehicle.id}>
            <button className="vehicle-card-main" onClick={() => { setActiveVehicleId(vehicle.id); showToast("已切换当前车辆"); }}>
              <span className="vehicle-avatar"><Car size={30} weight="duotone" /></span>
              <span><small>{vehicle.isDefault ? "默认车辆" : "家庭车辆"}</small><strong>{vehicle.plateNumber}</strong><VehiclePlateBadges vehicle={vehicle} compact /><em>{vehicle.vehicleType} · {vehicleSeats(vehicle)} 座{vehicleIsVan(vehicle) ? " · 面包车" : ""} · {washVehicleCategoryLabel(washVehicleCategoryFor(vehicle))}洗车价类</em><VehicleDateBadge vehicle={vehicle} /></span>
              {vehicle.id === activeVehicleId ? <CheckCircle size={23} weight="fill" /> : <CaretRight size={20} />}
            </button>
            <VehicleReviewNotice vehicle={vehicle} />
            <div className="vehicle-card-actions">
              <button onClick={() => flow.push(vehicleFormScreen(vehicle))}><NotePencil size={17} />编辑</button>
              <button data-testid={`vehicle-validity-edit-${vehicle.id}`} onClick={() => flow.push(vehicleFormScreen(vehicle))}><ShieldCheck size={17} />核验有效期</button>
              <button className="danger-text" onClick={() => setDeleteTarget(vehicle)}><Trash size={17} />移除</button>
            </div>
          </article>
        )) : <EmptyState icon={<Car size={36} />} title="还没有车辆" copy="添加车辆后即可查看年检状态" action="添加车辆" onAction={() => flow.push(vehicleFormScreen())} />}
        <p className="demo-disclosure">车牌及车辆信息均为合成演示数据</p>
      </main>
      <BottomSheet open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)} title="移除车辆" description="车辆档案会从当前演示账号中移除。">
        <div className="sheet-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>暂不移除</button><button className="danger-button" onClick={confirmDelete}>确认移除</button></div>
      </BottomSheet>
    </MobileScroll>
  );
}

function VehicleFormScreen({ vehicle }: { vehicle?: Vehicle }) {
  const flow = useFlow();
  const keyboard = useKeyboard();
  const { createVehicle, updateVehicle, showToast } = useMvp();
  const initialPlate = initialPlateEditor(vehicle?.plateNumber, vehicle?.vehicleType);
  const [plateEditor, setPlateEditor] = useState(initialPlate);
  const [activePlateIndex, setActivePlateIndex] = useState(() => nextEditablePlateIndex(initialPlate.kind, 1));
  const [plateSheet, setPlateSheet] = useState<"province" | "agency" | "serial" | null>(null);
  const [form, setForm] = useState<VehicleInput>({
    plateNumber: formatPlate(initialPlate.cells.join("")),
    vehicleType: vehicle?.vehicleType || "小型轿车",
    usageNature: vehicle?.usageNature || "非营运",
    seats: vehicle?.seats || 5,
    registrationDate: vehicle?.registrationDate || "2020-08-28",
    inspectionDueDate: vehicle?.inspectionDueDate || DEMO_INSPECTION_DUE_DATE,
    powertrainType: vehicle ? vehiclePowertrain(vehicle) : initialPlate.category === "pure_electric" ? "pure_electric" : initialPlate.category === "non_pure_electric" ? "phev" : "gasoline",
    isVan: vehicle ? vehicleIsVan(vehicle) : false,
    facts: vehicle?.facts,
    inspectionValidity: vehicle?.inspectionValidity || { mode: "unconfirmed" },
    isDefault: vehicle?.isDefault || false,
    washVehicleCategory: vehicle ? washVehicleCategoryFor(vehicle) : "sedan",
  });
  const [washCategoryTouched, setWashCategoryTouched] = useState(Boolean(vehicle));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [validitySourceSelected, setValiditySourceSelected] = useState(vehicle?.inspectionValidity?.mode === "confirmed");

  const setField = <Key extends keyof VehicleInput>(key: Key, value: VehicleInput[Key]) => setForm((current) => ({ ...current, [key]: value }));
  const setVehicleType = (vehicleType: string) => {
    setForm((current) => ({
      ...current,
      vehicleType,
      ...(!washCategoryTouched ? { washVehicleCategory: normalizeWashVehicleCategory(undefined, { vehicleType, seats: current.seats }) } : {}),
    }));
  };
  const setWashCategory = (washVehicleCategory: WashVehicleCategory) => {
    setWashCategoryTouched(true);
    setField("washVehicleCategory", washVehicleCategory);
  };
  const confirmedValidity = form.inspectionValidity?.mode === "confirmed" ? form.inspectionValidity : null;
  const setValidityConfirmed = (confirmed: boolean) => {
    setValiditySourceSelected(false);
    setForm((current) => ({
      ...current,
      inspectionValidity: confirmed
        ? { mode: "confirmed", validThroughMonth: "", source: "traffic_12123" }
        : { mode: "unconfirmed" },
    }));
  };
  const setValidityMonth = (validThroughMonth: string) => {
    if (!validThroughMonth) setValiditySourceSelected(false);
    setForm((current) => ({
      ...current,
      inspectionDueDate: lastDateOfMonth(validThroughMonth) || current.inspectionDueDate,
      inspectionValidity: {
        mode: "confirmed",
        validThroughMonth,
        source: current.inspectionValidity?.mode === "confirmed" ? current.inspectionValidity.source : "traffic_12123",
      },
    }));
  };

  const commitPlate = (next: typeof plateEditor) => {
    setPlateEditor(next);
    setForm((current) => ({ ...current, plateNumber: formatPlate(next.cells.join("")) }));
    setErrors((current) => {
      if (!current.plateNumber) return current;
      const { plateNumber: _plateNumber, ...rest } = current;
      return rest;
    });
  };

  const switchPlateKind = (kind: PlateKind) => {
    if (kind === plateEditor.kind) return;
    const category: EnergyCategory = kind === "blue" ? "none" : plateEditor.category === "non_pure_electric" ? "non_pure_electric" : "pure_electric";
    const next = { kind, category, cells: buildPlateCells(kind, category, plateEditor.cells.slice(0, 2)) };
    commitPlate(next);
    setActivePlateIndex(nextEditablePlateIndex(kind, 1));
    if (kind === "green_small") setVehicleType("新能源小型汽车");
    else if (kind === "green_large") setVehicleType("新能源大型汽车");
    else if (form.vehicleType.includes("新能源")) setVehicleType("小型轿车");
    if (kind === "blue" && ["pure_electric", "phev", "erev"].includes(form.powertrainType)) setField("powertrainType", "gasoline");
    if (kind !== "blue" && !["pure_electric", "phev", "erev"].includes(form.powertrainType)) setField("powertrainType", category === "pure_electric" ? "pure_electric" : "phev");
    showToast("已保留省份与发牌机关，请补全新号牌序号");
  };

  const switchEnergy = (category: Exclude<EnergyCategory, "none">) => {
    const next = { ...plateEditor, category, cells: buildPlateCells(plateEditor.kind, category, plateEditor.cells) };
    commitPlate(next);
    if (category === "pure_electric") setField("powertrainType", "pure_electric");
    else if (!(["phev", "erev"] as PowertrainType[]).includes(form.powertrainType)) setField("powertrainType", "phev");
  };

  const setPowertrain = (powertrainType: PowertrainType) => {
    if (plateEditor.kind !== "blue" && ["pure_electric", "phev", "erev"].includes(powertrainType)) {
      const category: Exclude<EnergyCategory, "none"> = powertrainType === "pure_electric" ? "pure_electric" : "non_pure_electric";
      commitPlate({ ...plateEditor, category, cells: buildPlateCells(plateEditor.kind, category, plateEditor.cells) });
    }
    setField("powertrainType", powertrainType);
  };

  const setPlateCell = (index: number, value: string) => {
    const cells = [...plateEditor.cells];
    cells[index] = value;
    commitPlate({ ...plateEditor, cells });
  };

  const openPlateCell = (index: number) => {
    keyboard.hide();
    if (index === 0) return setPlateSheet("province");
    if (index === 1) return setPlateSheet("agency");
    if (index === fixedEnergyIndex(plateEditor.kind)) {
      showToast("D / F 由能源类型自动确定");
      return;
    }
    setActivePlateIndex(index);
    setPlateSheet("serial");
  };

  const inputSerialKey = (key: string) => {
    if (!serialKeyAllowed(plateEditor.kind, activePlateIndex, key)) return;
    setPlateCell(activePlateIndex, key);
    const nextIndex = nextEditablePlateIndex(plateEditor.kind, activePlateIndex);
    if (nextIndex >= 0) setActivePlateIndex(nextIndex);
  };

  const backspacePlate = () => {
    let target = activePlateIndex;
    if (!plateEditor.cells[target]) target = nextEditablePlateIndex(plateEditor.kind, target, -1);
    if (target < 2) return;
    setPlateCell(target, "");
    setActivePlateIndex(target);
  };

  const clearPlateSerial = () => {
    const cells = buildPlateCells(plateEditor.kind, plateEditor.category, plateEditor.cells.slice(0, 2));
    commitPlate({ ...plateEditor, cells });
    setActivePlateIndex(nextEditablePlateIndex(plateEditor.kind, 1));
  };

  const applyPlateCandidate = (candidate: string, source: string) => {
    const parsed = parsePlate(candidate);
    if (!parsed.valid) {
      setErrors((current) => ({ ...current, plateNumber: "未识别到完整有效的中国大陆车牌" }));
      showToast(`${source}失败，请使用分格键盘补充`);
      return false;
    }
    const next = {
      kind: parsed.plateKind,
      category: parsed.energyCategory,
      cells: buildPlateCells(parsed.plateKind, parsed.energyCategory, parsed.normalized.split("")),
    };
    commitPlate(next);
    setActivePlateIndex(nextEditablePlateIndex(parsed.plateKind, 1));
    if (parsed.plateKind === "green_small") setVehicleType("新能源小型汽车");
    if (parsed.plateKind === "green_large") setVehicleType("新能源大型汽车");
    showToast(`${source}成功：${parsed.formatted}`);
    return true;
  };

  const pastePlate = async () => {
    keyboard.hide();
    try {
      if (!navigator.clipboard?.readText) throw new Error("clipboard_unavailable");
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error("clipboard_empty");
      applyPlateCandidate(text, "粘贴识别");
    } catch {
      showToast("未能读取剪贴板，请用下方车牌键盘录入");
    }
  };

  const currentPlate = formatPlate(plateEditor.cells.join(""));
  const plateResult = parsePlate(currentPlate);
  const plateStatus = plateResult.valid
    ? `${plateResult.formatted} · ${plateResult.plateKind === "blue" ? "普通蓝牌" : plateResult.plateKind === "green_small" ? "新能源小型" : "新能源大型"}`
    : plateResult.normalized.length < 2
      ? "请先选择省份与发牌机关"
      : plateResult.normalized.length >= plateLength(plateEditor.kind)
        ? "车牌结构不符合当前号牌规则"
        : `还需补全 ${plateLength(plateEditor.kind) - plateResult.normalized.length} 位车牌序号`;
  const persistedReviewReason = vehicle ? vehicleManualReviewReason(vehicle) : "";
  const formNeedsReview = form.powertrainType === "other" || form.vehicleType.includes("人工确认");

  useEffect(() => {
    if (plateSheet !== "serial") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pastePlate();
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        backspacePlate();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPlateSheet(null);
        return;
      }
      if (event.key === "Enter" && plateResult.valid) {
        event.preventDefault();
        setPlateSheet(null);
        return;
      }
      const key = event.key.toUpperCase();
      if (/^[A-Z0-9]$/.test(key) && serialKeyAllowed(plateEditor.kind, activePlateIndex, key)) {
        event.preventDefault();
        inputSerialKey(key);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePlateIndex, plateEditor, plateResult.valid, plateSheet]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    keyboard.hide();
    const nextErrors: Record<string, string> = {};
    if (!plateResult.valid) nextErrors.plateNumber = "请补全并检查车牌号码";
    if (form.registrationDate > DEMO_TODAY) nextErrors.registrationDate = "注册日期不能晚于今天";
    if (confirmedValidity && !/^\d{4}-(0[1-9]|1[0-2])$/.test(confirmedValidity.validThroughMonth)) nextErrors.inspectionDueDate = "请选择有效的检验有效期月份";
    if (confirmedValidity && /^\d{4}-(0[1-9]|1[0-2])$/.test(confirmedValidity.validThroughMonth) && lastDateOfMonth(confirmedValidity.validThroughMonth) < form.registrationDate) nextErrors.inspectionDueDate = "检验有效期不能早于注册日期";
    if (confirmedValidity && !validitySourceSelected) nextErrors.inspectionValiditySource = "请选择您实际看到日期的位置";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSaving(true);
    try {
      const payload: VehicleInput = {
        ...form,
        inspectionDueDate: confirmedValidity ? lastDateOfMonth(confirmedValidity.validThroughMonth) : form.inspectionDueDate,
        plateNumber: plateResult.valid ? plateResult.formatted : form.plateNumber,
        vehicleClassCode: form.isVan ? "van" : form.vehicleType.includes("大型") ? "large_passenger" : form.vehicleType.includes("人工确认") ? "manual_review" : "passenger_car",
        facts: {
          powertrainType: form.powertrainType,
          seats: form.seats,
          usageNature: form.usageNature,
          vehicleClassCode: form.isVan ? "van" : form.vehicleType.includes("大型") ? "large_passenger" : form.vehicleType.includes("人工确认") ? "manual_review" : "passenger_car",
          isVan: form.isVan,
        },
      };
      if (vehicle) await updateVehicle(vehicle.id, payload);
      else await createVehicle(payload);
      showToast(vehicle ? "车辆信息已更新" : "车辆添加成功");
      flow.pop();
    } catch (error) {
      const fieldErrors = (error as Error & { fields?: Record<string, string> }).fields;
      if (fieldErrors) setErrors((current) => ({ ...current, ...fieldErrors }));
      showToast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <MobileScroll className="app-scroll">
      <form className="sub-page form-page" onSubmit={submit}>
        <section className="plate-type-card" aria-label="号牌类型">
          <span className="form-section-label">号牌类型</span>
          <div className="plate-type-switch">
            <button type="button" data-testid="plate-type-blue" aria-pressed={plateEditor.kind === "blue"} className={plateEditor.kind === "blue" ? "active blue" : ""} onClick={() => switchPlateKind("blue")}><span className="plate-type-swatch blue" />普通蓝牌<small>7 位</small></button>
            <button type="button" data-testid="plate-type-green" aria-pressed={plateEditor.kind !== "blue"} className={plateEditor.kind !== "blue" ? "active green" : ""} onClick={() => { if (plateEditor.kind === "blue") switchPlateKind("green_small"); }}><span className="plate-type-swatch green" />新能源绿牌<small>8 位</small></button>
          </div>
          {plateEditor.kind !== "blue" ? <div className="green-plate-options">
            <div><span>车辆规格</span><span className="micro-segmented"><button type="button" data-testid="vehicle-size-small" aria-pressed={plateEditor.kind === "green_small"} className={plateEditor.kind === "green_small" ? "active" : ""} onClick={() => switchPlateKind("green_small")}>小型</button><button type="button" data-testid="vehicle-size-large" aria-pressed={plateEditor.kind === "green_large"} className={plateEditor.kind === "green_large" ? "active" : ""} onClick={() => switchPlateKind("green_large")}>大型</button></span></div>
            <div><span>能源类型</span><span className="micro-segmented"><button type="button" data-testid="vehicle-kind-D" aria-pressed={plateEditor.category === "pure_electric"} className={plateEditor.category === "pure_electric" ? "active" : ""} onClick={() => switchEnergy("pure_electric")}><b>D</b> 纯电动</button><button type="button" data-testid="vehicle-kind-F" aria-pressed={plateEditor.category === "non_pure_electric"} className={plateEditor.category === "non_pure_electric" ? "active" : ""} onClick={() => switchEnergy("non_pure_electric")}><b>F</b> 非纯电</button></span></div>
          </div> : null}
        </section>

        <section className={`plate-editor-card ${plateEditor.kind === "blue" ? "blue" : "green"} ${errors.plateNumber ? "has-error" : ""}`}>
          <div className="plate-editor-heading"><span><strong>车牌号码</strong><small>点击任意格定位输入</small></span><button type="button" onClick={() => void pastePlate()}><ClipboardText size={16} />粘贴识别</button></div>
          <div className="plate-cells" aria-label={`${plateEditor.kind === "blue" ? "普通蓝牌" : "新能源绿牌"}车牌输入`}>
            {plateEditor.cells.map((char, index) => <span className="plate-cell-wrap" key={index}>
              <button
                type="button"
                data-testid={`plate-input-${index}`}
                data-value={char}
                data-fixed={index === fixedEnergyIndex(plateEditor.kind) ? "true" : "false"}
                aria-label={`车牌第 ${index + 1} 位${char ? `：${char}` : "，未填写"}`}
                aria-pressed={plateSheet === "serial" && activePlateIndex === index}
                className={`${char ? "filled" : ""} ${plateSheet === "serial" && activePlateIndex === index ? "active" : ""} ${index === fixedEnergyIndex(plateEditor.kind) ? "fixed" : ""}`}
                onClick={() => openPlateCell(index)}
              >{char || <i />}</button>
              {index === 1 ? <em>·</em> : null}
            </span>)}
          </div>
          <button type="button" data-testid="plate-province-trigger" className="plate-province-trigger" onClick={() => { keyboard.hide(); setPlateSheet("province"); }}>切换省份</button>
          <div aria-live="polite" className={`plate-live-status ${plateResult.valid ? "valid" : "pending"}`}><span>{plateResult.valid ? <CheckCircle size={16} weight="fill" /> : <CircleNotch size={16} />}</span><strong>{plateStatus}</strong></div>
          {errors.plateNumber ? <p className="plate-error" role="alert">{errors.plateNumber}</p> : null}
        </section>

        <div className="plate-quick-actions">
          <button type="button" onClick={() => applyPlateCandidate("津AD12345", "模拟行驶证识别")}><Camera size={20} weight="duotone" /><span><strong>识别行驶证</strong><small>填入合成示例</small></span></button>
          <button type="button" onClick={() => void pastePlate()}><ClipboardText size={20} weight="duotone" /><span><strong>粘贴车牌</strong><small>自动清洗格式</small></span></button>
        </div>

        <Field label="车辆类型"><select value={form.vehicleType} onChange={(e) => setVehicleType(e.target.value)}><option>小型轿车</option><option>小型普通客车</option><option>小型SUV</option><option>MPV / 多用途乘用车</option><option>新能源小型汽车</option><option>新能源大型汽车</option><option value="其他车型（人工确认）">其他车型（暂不支持在线报价）</option></select></Field>
        <section className="wash-category-field" aria-labelledby="wash-category-title">
          <header><span><strong id="wash-category-title">洗车车型价类</strong><small>门店按此档位返回对应套餐价格</small></span><b>{washVehicleCategoryLabel(form.washVehicleCategory)}</b></header>
          <div role="radiogroup" aria-label="选择洗车车型价类">
            {(["sedan", "suv", "mpv"] as WashVehicleCategory[]).map((item) => <button type="button" role="radio" aria-checked={form.washVehicleCategory === item} data-testid={`vehicle-wash-category-${item}`} className={form.washVehicleCategory === item ? "active" : ""} key={item} onClick={() => setWashCategory(item)}><span><Car size={20} weight="duotone" /></span><strong>{washVehicleCategoryLabel(item)}</strong></button>)}
          </div>
          {vehicle?.washVehicleCategoryLegacy ? <p className="wash-category-legacy" role="status"><Warning size={15} />历史 SUV/MPV 合并档已按 SUV 兼容。请确认后保存为新版独立档位。</p> : <p className="wash-category-help"><Info size={14} />7 座不会自动判定为 MPV，请按车辆实际类型选择。</p>}
        </section>
        <Field label="能源类型"><select data-testid="vehicle-powertrain" value={form.powertrainType} onChange={(e) => setPowertrain(e.target.value as PowertrainType)}>{(Object.entries(POWERTRAIN_LABELS) as Array<[PowertrainType, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small className="form-help">能源类型独立保存，不会被 7 座或面包车属性覆盖；绿牌 D / F 会与此项联动。</small></Field>
        <Field label="使用性质"><div className="segmented">{["非营运", "营运"].map((item) => <button type="button" className={form.usageNature === item ? "active" : ""} onClick={() => setField("usageNature", item)} key={item}>{item}</button>)}</div></Field>
        <Field label="核定座位"><select data-testid="vehicle-seats" value={form.seats} onChange={(e) => setField("seats", Number(e.target.value))}>{[2, 4, 5, 6, 7, 8, 9].map((item) => <option key={item} value={item}>{item} 座</option>)}</select></Field>
        <label className="switch-row"><span><strong>面包车 / 厢式客车</strong><small>独立车辆属性，用于匹配检查项目与价格方案</small></span><input data-testid="vehicle-is-van" type="checkbox" checked={form.isVan} onChange={(e) => setField("isVan", e.target.checked)} /></label>
        {persistedReviewReason || formNeedsReview ? <section className="vehicle-review-card" role="status"><Warning size={20} /><span><strong>保存后暂不支持在线报价</strong><small>{persistedReviewReason || "当前能源或车型没有可自动匹配的价格方案，请保存后联系平台客服核对。"}</small></span></section> : null}
        <Field label="注册日期" error={errors.registrationDate}><KeyboardInput type="date" value={form.registrationDate} onChange={(e) => setField("registrationDate", e.target.value)} /></Field>
        <section className={`vehicle-validity-card ${confirmedValidity ? "confirmed" : ""}`} data-testid="vehicle-validity-card">
          <header><ShieldCheck size={21} weight="duotone" /><span><strong>补充检验有效期</strong><small>可选，仅记录您从交管12123或行驶证看到的信息</small></span><input type="checkbox" aria-label="我已看到检验有效期" checked={Boolean(confirmedValidity)} onChange={(event) => setValidityConfirmed(event.target.checked)} /></header>
          {confirmedValidity ? <div className="vehicle-validity-fields">
            <Field label="12123/行驶证显示的检验有效期至（月份）" error={errors.inspectionDueDate}><KeyboardInput type="month" value={confirmedValidity.validThroughMonth} onChange={(event) => setValidityMonth(event.target.value)} /></Field>
            <Field label="日期来源" error={errors.inspectionValiditySource}><select data-testid="vehicle-validity-source" disabled={!/^\d{4}-(0[1-9]|1[0-2])$/.test(confirmedValidity.validThroughMonth)} value={validitySourceSelected ? confirmedValidity.source : ""} onChange={(event) => { setValiditySourceSelected(true); setField("inspectionValidity", { ...confirmedValidity, source: event.target.value as InspectionValiditySource }); }}><option value="" disabled>请选择日期来源</option>{(Object.entries(INSPECTION_VALIDITY_SOURCE_LABELS) as Array<[InspectionValiditySource, string]>).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
            <p><Info size={15} />保存后只会标注“用户根据所选来源确认”，不会声称已同步或验证官方记录。</p>
          </div> : <p className="vehicle-validity-unconfirmed"><Info size={15} />未补充时，首页只展示“按公开规则估算”，不会把档案占位日期称为官方到期日。</p>}
        </section>
        <label className="switch-row"><span><strong>设为默认车辆</strong><small>首页优先展示这辆车</small></span><input type="checkbox" checked={Boolean(form.isDefault)} onChange={(e) => setField("isDefault", e.target.checked)} /></label>
        <button className="primary-button form-submit" disabled={saving || !plateResult.valid}>{saving ? <CircleNotch className="spin" size={20} /> : <Check size={20} weight="bold" />}{saving ? "正在保存" : plateResult.valid ? "确认保存" : "请先补全车牌"}</button>
        <p className="demo-disclosure">本页面仅保存合成演示数据，不上传真实证件</p>
      </form>
      <BottomSheet
        open={Boolean(plateSheet)}
        onOpenChange={(open) => !open && setPlateSheet(null)}
        title={plateSheet === "province" ? "选择省份" : plateSheet === "agency" ? "选择发牌机关" : "输入车牌序号"}
        description={plateSheet === "province" ? "津、京、冀已置顶，可点选全国 31 个省级简称" : plateSheet === "agency" ? "I、O 不用于发牌机关代码" : "支持实体键盘输入；I、O 不可用，D / F 由能源类型锁定"}
        snap={plateSheet === "province" ? 0.68 : plateSheet === "agency" ? 0.58 : 0.62}
      >
        {plateSheet === "province" ? <div className="province-keyboard">{PROVINCE_OPTIONS.map((province, index) => <button type="button" key={province} className={index < 3 ? "priority" : ""} aria-label={`选择省份 ${province}`} onClick={() => { setPlateCell(0, province); setActivePlateIndex(1); setPlateSheet("agency"); }}>{province}<small>{index === 0 ? "天津" : index === 1 ? "北京" : index === 2 ? "河北" : ""}</small></button>)}</div> : null}
        {plateSheet === "agency" ? <div className="agency-keyboard">{AGENCY_LETTERS.map((letter) => <button type="button" key={letter} aria-label={`选择发牌机关 ${letter}`} onClick={() => { setPlateCell(1, letter); setActivePlateIndex(nextEditablePlateIndex(plateEditor.kind, 1)); setPlateSheet("serial"); }}>{letter}</button>)}</div> : null}
        {plateSheet === "serial" ? <div className="serial-keyboard">
          <div className="serial-numbers">{SERIAL_NUMBERS.map((key) => <button type="button" key={key} aria-label={`输入 ${key}`} disabled={!serialKeyAllowed(plateEditor.kind, activePlateIndex, key)} onClick={() => inputSerialKey(key)}>{key}</button>)}</div>
          <div className="serial-letters">{SERIAL_LETTERS.map((key) => <button type="button" key={key} aria-label={`输入 ${key}`} disabled={!serialKeyAllowed(plateEditor.kind, activePlateIndex, key)} onClick={() => inputSerialKey(key)}>{key}</button>)}</div>
          <div className="serial-controls"><button type="button" aria-label="清空" onClick={clearPlateSerial}>清空</button><button type="button" aria-label="退格" onClick={backspacePlate}>退格</button><button type="button" aria-label="完成" className="done" disabled={!plateResult.valid} onClick={() => setPlateSheet(null)}>完成</button></div>
        </div> : null}
      </BottomSheet>
    </MobileScroll>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return <label className={`form-field ${error ? "has-error" : ""}`}><span>{label}</span>{children}{error ? <em>{error}</em> : null}</label>;
}

const INSPECTION_DECLARATION_ITEMS: Array<{ key: keyof InspectionDeclarations; shortLabel: string; label: string; help: string }> = [
  { key: "isVan", shortLabel: "面包车属性", label: "是否属于面包车", help: "面包车不适用本页自动测算范围" },
  { key: "hasInjuryAccident", shortLabel: "人员伤亡事故", label: "是否发生过造成人员伤亡的交通事故", help: "以交管部门事故记录为准" },
  { key: "hasIllegalModificationPenalty", shortLabel: "非法改装处罚", label: "是否因非法改装被依法处罚", help: "仅指已有依法处罚记录" },
  { key: "convertedFromOperational", shortLabel: "营运转非营运", label: "是否曾由营运转为非营运", help: "营转非车辆需核验登记历史" },
  { key: "delayedFirstRegistrationOver4Years", shortLabel: "出厂超4年后注册", label: "是否自出厂超过 4 年才首次注册", help: "可在机动车登记资料中核对" },
];

const INSPECTION_DECLARATION_OPTIONS: Array<{ value: InspectionDeclarationValue; label: string }> = [
  { value: "no", label: "否" },
  { value: "yes", label: "是" },
  { value: "unknown", label: "不清楚" },
];

function inspectionDeclarationsFor(vehicle?: Vehicle | null): InspectionDeclarations {
  return {
    isVan: vehicle ? (vehicleIsVan(vehicle) ? "yes" : "no") : "no",
    hasInjuryAccident: "no",
    hasIllegalModificationPenalty: "no",
    convertedFromOperational: "no",
    delayedFirstRegistrationOver4Years: "no",
  };
}

function unknownInspectionDeclarations(): InspectionDeclarations {
  return {
    isVan: "unknown",
    hasInjuryAccident: "unknown",
    hasIllegalModificationPenalty: "unknown",
    convertedFromOperational: "unknown",
    delayedFirstRegistrationOver4Years: "unknown",
  };
}

function isInspectionDemoVehicle(vehicle?: Vehicle | null) {
  return Boolean(vehicle && (/MVP/i.test(vehicle.plateNumber) || /demo/i.test(vehicle.id)));
}

function inspectionVehicleFromProfile(vehicle: Vehicle): InspectionVehicleInput {
  const classCode = vehicle.facts?.vehicleClassCode;
  const isSmallPassenger = ["passenger_car", "small_micro_passenger", "van"].includes(String(classCode || ""))
    || /小型|轿车|SUV|新能源小型/.test(vehicle.vehicleType);
  const usage = vehicleUsageNature(vehicle);
  return {
    registrationMonth: vehicle.registrationDate.slice(0, 7),
    vehicleClass: isSmallPassenger ? "small_micro_passenger" : classCode === "manual_review" ? "unknown" : "other",
    usageNature: usage === "非营运" ? "non_operational" : usage === "营运" ? "operational" : "unknown",
    seats: vehicleSeats(vehicle),
    knownIsVan: vehicleIsVan(vehicle),
    powertrainType: vehiclePowertrain(vehicle),
  };
}

type TemporaryInspectionVehicle = Pick<InspectionVehicleInput, "registrationMonth" | "vehicleClass" | "usageNature" | "seats"> & {
  powertrainType: PowertrainType;
};

const POWERTRAIN_INSPECTION_GUIDE: Record<PowertrainType, { summary: string; items: string[]; sourceIds: string[] }> = {
  gasoline: {
    summary: "年检周期与其他动力类型相同；需要上线时，预计包含基础安全、适用的汽油排放及 OBD 项目。",
    items: ["基础安全技术检验", "适用的汽油排放与 OBD 项目"],
    sourceIds: ["joint_reform_2022", "gb_18285_2018"],
  },
  diesel: {
    summary: "年检周期与其他动力类型相同；需要上线时，预计包含基础安全、适用的柴油排放及 OBD 项目。",
    items: ["基础安全技术检验", "适用的柴油排放与 OBD 项目"],
    sourceIds: ["joint_reform_2022"],
  },
  hybrid: {
    summary: "油电混合（HEV、非插电）仍有发动机，年检周期不变；需要上线时仍有适用的汽油排放项目。",
    items: ["基础安全技术检验", "适用的汽油排放与 OBD 项目"],
    sourceIds: ["joint_reform_2022", "gb_18285_2018"],
  },
  phev: {
    summary: "插混的年检周期不变；需要上线时，预计涉及发动机排放项目及新能源运行安全项目。",
    items: ["基础安全技术检验", "适用的汽油排放与 OBD 项目", "新能源运行安全项目（以检测站执行为准）"],
    sourceIds: ["joint_reform_2022", "gb_18285_2018", "gbt_44500_2024"],
  },
  erev: {
    summary: "增程车的年检周期不变；需要上线时，预计涉及发动机排放项目及新能源运行安全项目。",
    items: ["基础安全技术检验", "适用的汽油排放与 OBD 项目", "新能源运行安全项目（以检测站执行为准）"],
    sourceIds: ["joint_reform_2022", "gb_18285_2018", "gbt_44500_2024"],
  },
  pure_electric: {
    summary: "纯电车免尾气排放检验，但不等于免年检；周期不变，需要上线时关注基础安全及新能源运行安全项目。",
    items: ["基础安全技术检验", "不做尾气排放检验", "新能源运行安全项目（以检测站执行为准）"],
    sourceIds: ["joint_reform_2022", "pure_electric_emissions_exemption", "gbt_44500_2024"],
  },
  other: {
    summary: "动力类型不会改变本页使用的周期规则，但具体上线项目暂不能自动判断，请向检测站核验。",
    items: ["基础安全技术检验", "其他项目需检测站核验"],
    sourceIds: ["joint_reform_2022"],
  },
};

function lastDateOfMonth(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return "";
  const [year, numericMonth] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, numericMonth, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function vehicleConfirmedValidity(vehicle?: Vehicle | null): Extract<InspectionValidity, { mode: "confirmed" }> | null {
  const validity = vehicle?.inspectionValidity;
  return validity?.mode === "confirmed" ? validity : null;
}

function calculationForVehicleDisplay(vehicle: Vehicle): WebInspectionCalculationResult | null {
  try {
    return calculateInspection({
      source: "vehicle",
      asOfDate: DEMO_TODAY,
      vehicle: inspectionVehicleFromProfile(vehicle),
      declarations: inspectionDeclarationsFor(vehicle),
      inspectionValidity: vehicle.inspectionValidity || { mode: "unconfirmed" },
    }) as WebInspectionCalculationResult;
  } catch {
    return null;
  }
}

function normalizeDateEvidence(
  result: WebInspectionCalculationResult,
  vehicle?: Vehicle | null,
  temporaryValidity?: Extract<InspectionValidity, { mode: "confirmed" }> | null,
): InspectionDateEvidence {
  const raw = result.dateEvidence as Record<string, unknown> | undefined;
  const rawEstimate = raw?.estimate as Record<string, unknown> | undefined;
  const rawConfirmation = raw?.confirmation as Record<string, unknown> | undefined;
  const rawStatus = String(raw?.status || raw?.comparison || "");
  const rawConfirmed = String(rawConfirmation?.validThroughDate || raw?.confirmedDueDate || raw?.officialDueDate || raw?.validThroughDate || "") || null;
  const rawSource = String(rawConfirmation?.source || raw?.confirmedSource || raw?.source || "") as InspectionValiditySource;
  const confirmed = raw ? null : temporaryValidity || vehicleConfirmedValidity(vehicle);
  const confirmedDueDate = rawConfirmed || (confirmed ? lastDateOfMonth(confirmed.validThroughMonth) : null);
  const confirmedSource = rawSource in INSPECTION_VALIDITY_SOURCE_LABELS ? rawSource : confirmed?.source || null;
  const estimatedDueDate = String(rawEstimate?.dueDate || raw?.estimatedDueDate || result.estimatedDueDate || "") || null;
  const inferredStatus: InspectionDateEvidence["status"] = confirmedDueDate && estimatedDueDate
    ? confirmedDueDate.slice(0, 7) === estimatedDueDate.slice(0, 7) ? "matched" : "conflict"
    : confirmedDueDate ? "confirmed_only" : estimatedDueDate ? "estimated_only" : "unavailable";
  const status: InspectionDateEvidence["status"] = ["estimated_only", "matched", "conflict", "confirmed_only", "unavailable"].includes(rawStatus)
    ? rawStatus as InspectionDateEvidence["status"]
    : rawStatus === "match" ? "matched" : rawStatus === "mismatch" ? "conflict" : rawStatus === "not_provided" ? estimatedDueDate ? "estimated_only" : "unavailable" : rawStatus === "not_comparable" ? confirmedDueDate ? "confirmed_only" : "unavailable" : inferredStatus;
  return {
    status,
    estimatedDueDate,
    confirmedDueDate,
    confirmedSource,
    confirmedAt: String(rawConfirmation?.confirmedAt || raw?.confirmedAt || confirmed?.confirmedAt || "") || null,
    explanation: String(raw?.explanation || "") || undefined,
  };
}

function vehicleDateDisplay(vehicle: Vehicle) {
  const estimate = calculationForVehicleDisplay(vehicle);
  const dateEvidence = normalizeDateEvidence(estimate || ({ estimatedDueDate: null } as WebInspectionCalculationResult), vehicle);
  if (dateEvidence.status === "conflict") {
    return { status: "conflict" as const, date: dateEvidence.confirmedDueDate, label: "日期待核验", detail: "用户确认日期与规则估算不一致" };
  }
  if (dateEvidence.confirmedDueDate && dateEvidence.confirmedSource) {
    return {
      status: "confirmed" as const,
      date: dateEvidence.confirmedDueDate,
      label: "用户确认有效期止",
      detail: `根据${INSPECTION_VALIDITY_SOURCE_LABELS[dateEvidence.confirmedSource]}填写`,
    };
  }
  if (dateEvidence.estimatedDueDate) {
    return { status: "estimated" as const, date: dateEvidence.estimatedDueDate, label: "规则估算有效期止", detail: "未连接交管实时记录" };
  }
  return { status: "unverified" as const, date: vehicle.inspectionDueDate || null, label: "档案日期待核验", detail: "来源尚未确认" };
}

function fallbackInspectionEvidence(
  result: WebInspectionCalculationResult,
  vehicle: TemporaryInspectionVehicle & { knownIsVan?: boolean | null },
  declarations: InspectionDeclarations,
  powertrainType: PowertrainType,
): InspectionEvidence {
  const dueMonth = result.estimatedDueDate?.slice(0, 7) || "待核验";
  const registration = vehicle.registrationMonth;
  const cycleYear = result.cycleYear;
  const actionLabel = result.action === "claim_mark" ? "申领检验标志节点" : "上线检验节点";
  const usageLabel = vehicle.usageNature === "non_operational" ? "非营运" : vehicle.usageNature === "operational" ? "营运" : "使用性质未知";
  const classLabel = vehicle.vehicleClass === "small_micro_passenger" ? "小微型载客汽车" : vehicle.vehicleClass === "other" ? "其他车型" : "车型未知";
  const exceptionAllNo = Object.values(declarations).every((answer) => answer === "no");
  const scopeExpression = `${vehicle.seats ?? "座位未知"}座 ∩ ${usageLabel} ∩ ${classLabel} ∩ ${declarations.isVan === "no" && !vehicle.knownIsVan ? "非面包车" : "面包车属性待核验"} ∩ ${exceptionAllNo ? "5项特殊情况均为否" : "存在待核验特殊情况"}`;
  const windowResult = result.applicationWindow ? `${result.applicationWindow.start} 至 ${result.applicationWindow.end}` : "待核验";
  const currentResult = result.windowStatus === "open" ? result.canBookInspection ? "位于窗口内，可预约上线检验" : "位于窗口内，可申领检验标志" : result.windowStatus === "not_open" ? "办理窗口尚未开始" : result.windowStatus === "overdue" ? "规则估算已超过办理期限，先官方核验" : "需交管或人工核验";
  const guide = POWERTRAIN_INSPECTION_GUIDE[powertrainType];
  return {
    normalizedFacts: [
      { code: "registration_month", label: "注册月份", value: registration, source: result.source === "vehicle" ? "vehicle_profile" : "temporary_input" },
      { code: "seats", label: "核定座位", value: vehicle.seats ? `${vehicle.seats}座` : "不清楚", source: result.source === "vehicle" ? "vehicle_profile" : "temporary_input" },
      { code: "usage_nature", label: "使用性质", value: usageLabel, source: result.source === "vehicle" ? "vehicle_profile" : "temporary_input" },
      { code: "powertrain", label: "动力类型", value: POWERTRAIN_LABELS[powertrainType], source: result.source === "vehicle" ? "vehicle_profile" : "temporary_input" },
    ],
    steps: result.windowStatus === "manual_review" ? [] : [
      { id: "scope", title: "适用范围", expression: scopeExpression, result: "符合本页自动测算边界", sourceIds: ["joint_reform_2022"] },
      { id: "cycle", title: "周期节点", expression: cycleYear ? `${registration} + 第${cycleYear}年 = ${dueMonth}` : "登记历史待核验", result: cycleYear ? `第${cycleYear}年属于${actionLabel}` : "无法自动判断", sourceIds: ["joint_reform_2022"] },
      { id: "due_date", title: "有效期估算", expression: result.estimatedDueDate ? `${dueMonth.replace("-", "年")}月最后一天` : "无法安全推算", result: result.estimatedDueDate || "待核验", sourceIds: ["joint_reform_2022"] },
      { id: "window", title: "办理窗口", expression: result.applicationWindow ? `到期月前2个自然月起` : "无法安全推算", result: windowResult, sourceIds: ["natural_month_window_guidance"] },
      { id: "current_status", title: "当前结论", expression: `今天 ${DEMO_TODAY} 与办理窗口比较`, result: currentResult, sourceIds: ["natural_month_window_guidance"] },
    ],
    assumptions: ["规则估算基于当前填写事实，并假设历史应检均已按期办理；车辆真实检验记录以交管12123为准。"],
    powertrainImpact: {
      powertrainType,
      label: POWERTRAIN_LABELS[powertrainType],
      affectsCycle: false,
      status: result.action === "claim_mark" ? "not_applicable_this_cycle" : powertrainType === "other" ? "needs_verification" : "applicable",
      expectedOnsiteCheckCodes: guide.items,
      explanation: guide.summary,
      sourceIds: guide.sourceIds,
    },
  };
}

function InspectionDeclarationRow({ item, value, onChange }: { item: (typeof INSPECTION_DECLARATION_ITEMS)[number]; value: InspectionDeclarationValue; onChange: (value: InspectionDeclarationValue) => void }) {
  return (
    <div className="inspection-declaration-row" role="group" aria-label={item.label}>
      <span><strong>{item.label}</strong><small>{item.help}</small></span>
      <div className="inspection-tristate">
        {INSPECTION_DECLARATION_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={value === option.value ? "active" : ""}
            aria-pressed={value === option.value}
            data-testid={`inspection-declaration-${item.key}-${option.value}`}
            onClick={() => onChange(option.value)}
          >{option.label}</button>
        ))}
      </div>
    </div>
  );
}

function inspectionPolicySourceId(source: { title: string; url: string }, index: number) {
  const explicitId = (source as { id?: string }).id;
  if (explicitId) return explicitId;
  if (source.title.includes("自然月") || source.title.includes("提前三个月")) return "natural-month-window";
  if (source.title.includes("纯电")) return "pure-electric-emissions";
  if (source.title.includes("44500")) return "gbt-44500-2024";
  if (source.title.includes("18285")) return "gb-18285-2018";
  return index === 0 ? "inspection-reform-2022" : `policy-source-${index + 1}`;
}

function InspectionEvidenceCard({ result, evidence }: { result: WebInspectionCalculationResult; evidence: InspectionEvidence }) {
  const sourceEntries = result.policy.sources.map((source, index) => ({ source, id: inspectionPolicySourceId(source, index) }));
  const sourceFor = (sourceIds: string[]) => sourceEntries.find((entry) => sourceIds.includes(entry.id)) || sourceEntries[0];
  const comparison = String((result.dateEvidence as Record<string, unknown> | undefined)?.comparison || "");
  if (result.windowStatus === "manual_review" && comparison !== "conflict") {
    const reasonDetails = new Set(result.reasons.map((reason) => reason.detail));
    const reasons = [...result.reasons.map((reason) => ({ key: reason.code, title: reason.label, detail: reason.detail })), ...result.manualReviewReasons.filter((reason) => !reasonDetails.has(reason)).map((reason) => ({ key: reason, title: "需要进一步核验", detail: reason }))];
    return <section className="inspection-reason-card manual-review-evidence" data-testid="inspection-manual-review">
      <header><Warning size={20} weight="duotone" /><div><h2>为什么无法自动测算</h2><small>以下事实会改变适用规则，因此不编造日期或公式</small></div></header>
      {reasons.map((reason) => <div className="inspection-reason manual" key={reason.key}><Warning size={17} weight="fill" /><span><strong>{reason.title}</strong><small>{reason.detail}</small></span></div>)}
    </section>;
  }
  const facts = evidence.normalizedFacts?.length ? evidence.normalizedFacts : evidence.facts || [];
  return <section className="inspection-evidence-card" data-testid="inspection-evidence">
    <header><ListChecks size={20} weight="duotone" /><div><h2>本次测算过程</h2><small>车辆事实 → 公式 → 结果 → 政策来源</small></div><em>5 步</em></header>
    {facts.length ? <div className="inspection-fact-chips" aria-label="本次测算采用的车辆事实">{facts.map((fact) => <span className={fact.source === "conflict" || fact.source === "unknown" ? "uncertain" : ""} key={fact.code}>{fact.value}</span>)}</div> : null}
    <ol className="inspection-evidence-steps">
      {evidence.steps.map((step, index) => {
        const sourceEntry = sourceFor(step.sourceIds);
        return <li key={step.id || step.code || `${step.title}-${index}`} data-testid={`inspection-evidence-step-${step.id || step.code || index + 1}`}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div><h3>{step.title}</h3><code>{step.expression}</code><p><CheckCircle size={15} weight="fill" />{step.result || step.conclusion}</p>{sourceEntry ? <a href={sourceEntry.source.url} target="_blank" rel="noreferrer"><ShieldCheck size={13} />依据：{sourceEntry.source.title}<CaretRight size={12} /></a> : null}</div>
        </li>;
      })}
    </ol>
    {evidence.assumptions.map((assumption) => <p className="inspection-evidence-assumption" key={assumption}><Info size={15} />{assumption}</p>)}
  </section>;
}

function PowertrainImpactCard({ result, impact }: { result: WebInspectionCalculationResult; impact: InspectionPowertrainImpact }) {
  const selectedPowertrain = impact.powertrainType === "unknown" ? "other" : impact.powertrainType;
  const selectedGuide = POWERTRAIN_INSPECTION_GUIDE[selectedPowertrain];
  const selectedLabel = impact.powertrainType === "unknown" ? "动力类型不清楚" : POWERTRAIN_LABELS[selectedPowertrain];
  const noOnsiteThisCycle = impact.status === "not_applicable_this_cycle" || (result.action === "claim_mark" && result.windowStatus !== "overdue");
  const itemCodes = impact.expectedOnsiteCheckCodes || impact.onsiteItems?.filter((item) => item.applicability !== "no").map((item) => item.code) || [];
  const itemLabels = itemCodes.length ? itemCodes.map((code) => INSPECTION_ITEM_LABELS[code] || code) : selectedGuide.items;
  return <section className="inspection-powertrain-card" data-testid="inspection-powertrain-impact">
    <header><Lightning size={20} weight="duotone" /><div><h2>动力类型影响什么</h2><small>影响上线项目，不改变上面的年检周期</small></div></header>
    <div className="inspection-powertrain-selected"><span>{selectedLabel}</span><strong>周期不变，只影响上线项目</strong><p>{impact.explanation || selectedGuide.summary}</p></div>
    {noOnsiteThisCycle ? <p className="inspection-powertrain-not-applicable"><CheckCircle size={17} weight="fill" />本轮只需申领检验标志、无需上线，因此动力类型不会增加本轮检验项目。</p> : <div className="inspection-powertrain-items"><small>预计上线项目</small>{itemLabels.map((item) => <span key={item}><Check size={14} weight="bold" />{item}</span>)}<em>预计项目，具体以检测站实际执行口径为准。</em></div>}
    <details className="inspection-powertrain-comparison" data-testid="inspection-powertrain-comparison">
      <summary>查看全部动力类型对照<CaretDown size={15} /></summary>
      <div>{(Object.entries(POWERTRAIN_INSPECTION_GUIDE) as Array<[PowertrainType, (typeof POWERTRAIN_INSPECTION_GUIDE)[PowertrainType]]>).map(([type, guide]) => <article className={type === selectedPowertrain ? "selected" : ""} key={type}><strong>{POWERTRAIN_LABELS[type]}{type === selectedPowertrain ? <em>当前车辆</em> : null}</strong><p>{guide.summary}</p></article>)}</div>
    </details>
  </section>;
}

function InspectionDateEvidenceCard({
  dateEvidence,
  mode,
  comparisonOpen,
  temporaryValidityDraft,
  temporaryValiditySourceSelected,
  comparing,
  onToggleComparison,
  onTemporaryValidityDraftChange,
  onTemporaryValiditySourceChange,
  onCompareValidity,
  onUseEstimateOnly,
  onEditVehicle,
}: {
  dateEvidence: InspectionDateEvidence;
  mode: "vehicle" | "temporary";
  comparisonOpen: boolean;
  temporaryValidityDraft: Extract<InspectionValidity, { mode: "confirmed" }>;
  temporaryValiditySourceSelected: boolean;
  comparing: boolean;
  onToggleComparison: () => void;
  onTemporaryValidityDraftChange: (validity: Extract<InspectionValidity, { mode: "confirmed" }>) => void;
  onTemporaryValiditySourceChange: (source: InspectionValiditySource) => void;
  onCompareValidity: () => void;
  onUseEstimateOnly: () => void;
  onEditVehicle: () => void;
}) {
  const statusLabel = dateEvidence.status === "matched" ? "日期一致" : dateEvidence.status === "conflict" ? "日期冲突，先核验" : dateEvidence.status === "confirmed_only" ? "仅有用户确认日期" : dateEvidence.status === "estimated_only" ? "仅规则估算" : "日期信息待核验";
  const hasValidDraftMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(temporaryValidityDraft.validThroughMonth);
  return <section className={`inspection-date-evidence ${dateEvidence.status}`} data-testid="inspection-date-evidence">
    <header><CalendarBlank size={20} weight="duotone" /><div><h2>规则估算与真实记录</h2><small>本系统不连接交管实时数据</small></div><em>{statusLabel}</em></header>
    <div className="inspection-date-rows">
      <p><span>规则估算有效期止</span><strong>{dateEvidence.estimatedDueDate || "无法自动估算"}</strong><small>依据公开政策及当前填写事实</small></p>
      {dateEvidence.confirmedDueDate ? <p><span>用户确认有效期止</span><strong>{dateEvidence.confirmedDueDate}</strong><small>{dateEvidence.confirmedSource ? `用户根据${INSPECTION_VALIDITY_SOURCE_LABELS[dateEvidence.confirmedSource]}填写` : "用户填写，来源待补充"}{dateEvidence.confirmedAt ? ` · ${dateEvidence.confirmedAt.slice(0, 10)}确认` : ""}</small></p> : null}
    </div>
    {dateEvidence.status === "conflict" ? <p className="inspection-date-conflict"><Warning size={17} weight="fill" />两个月份不一致，可能与登记或历史办理情况有关。已关闭普通预约，请先通过交管12123核验。</p> : null}
    {dateEvidence.status === "matched" ? <p className="inspection-date-match"><CheckCircle size={17} weight="fill" />用户确认月份与规则估算一致；仍以交管12123当前显示为准。</p> : null}
    {mode === "temporary" ? <>
      <button type="button" className="inspection-validity-trigger" data-testid="inspection-validity-compare" onClick={onToggleComparison}><ShieldCheck size={17} />{dateEvidence.confirmedDueDate ? "修改或取消日期对照" : "核对12123或行驶证上的有效期（可选）"}<CaretDown size={15} /></button>
      {comparisonOpen ? <div className="inspection-validity-quick" data-testid="inspection-validity-quick-form">
        <p className="inspection-validity-intro">请填写您实际在交管12123或行驶证上看到的月份。系统不会自动同步，也不会把规则估算日期代入这里。</p>
        <Field label="12123/行驶证显示的检验有效期至（月份）"><KeyboardInput type="month" value={temporaryValidityDraft.validThroughMonth} onChange={(event) => onTemporaryValidityDraftChange({ ...temporaryValidityDraft, validThroughMonth: event.target.value })} /></Field>
        <Field label="日期来源"><select data-testid="inspection-validity-source" disabled={!hasValidDraftMonth} value={temporaryValiditySourceSelected ? temporaryValidityDraft.source : ""} onChange={(event) => onTemporaryValiditySourceChange(event.target.value as InspectionValiditySource)}><option value="" disabled>请选择日期来源</option>{(Object.entries(INSPECTION_VALIDITY_SOURCE_LABELS) as Array<[InspectionValiditySource, string]>).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
        <div className="inspection-validity-actions">
          <button type="button" data-testid="inspection-validity-submit" disabled={!hasValidDraftMonth || !temporaryValiditySourceSelected || comparing} onClick={onCompareValidity}>{comparing ? "正在对照…" : "与测算日期对照"}</button>
          <button type="button" data-testid="inspection-validity-use-estimate" disabled={comparing} onClick={onUseEstimateOnly}>没有查到，继续使用规则估算</button>
        </div>
        <p><Info size={14} />只有点击“与测算日期对照”后，本页才会使用您填写的日期；临时测算不会保存。</p>
      </div> : null}
    </> : null}
    {!dateEvidence.confirmedDueDate && mode === "vehicle" ? <button type="button" className="inspection-validity-trigger" data-testid="inspection-validity-edit-vehicle" onClick={onEditVehicle}><ShieldCheck size={17} />补充交管12123显示的有效期<CaretRight size={15} /></button> : null}
  </section>;
}

function InspectionScreen() {
  const flow = useFlow();
  const keyboard = useKeyboard();
  const { vehicles, activeVehicle, apiOnline } = useMvp();
  const [mode, setMode] = useState<"vehicle" | "temporary">(activeVehicle ? "vehicle" : "temporary");
  const [selectedVehicleId, setSelectedVehicleId] = useState(activeVehicle?.id || vehicles[0]?.id || "");
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedVehicleId) || null;
  const [temporaryVehicle, setTemporaryVehicle] = useState<TemporaryInspectionVehicle>({
    registrationMonth: "2026-08",
    vehicleClass: "small_micro_passenger",
    usageNature: "non_operational",
    seats: 5,
    powertrainType: "gasoline",
  });
  const [declarations, setDeclarations] = useState<InspectionDeclarations>(() => inspectionDeclarationsFor(activeVehicle));
  const [specialCaseMode, setSpecialCaseMode] = useState<"all_no" | "detail" | "">(() => isInspectionDemoVehicle(activeVehicle || vehicles[0]) ? "all_no" : "");
  const [result, setResult] = useState<WebInspectionCalculationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [temporaryValidityOpen, setTemporaryValidityOpen] = useState(false);
  const [temporaryValidity, setTemporaryValidity] = useState<Extract<InspectionValidity, { mode: "confirmed" }> | null>(null);
  const [temporaryValidityDraft, setTemporaryValidityDraft] = useState<Extract<InspectionValidity, { mode: "confirmed" }>>({ mode: "confirmed", validThroughMonth: "", source: "traffic_12123" });
  const [temporaryValiditySourceSelected, setTemporaryValiditySourceSelected] = useState(false);
  const latestCalculation = useRef(0);

  useEffect(() => {
    if (mode !== "vehicle" || selectedVehicle || !vehicles.length) return;
    const nextVehicle = vehicles.find((vehicle) => vehicle.isDefault) || vehicles[0];
    setSelectedVehicleId(nextVehicle.id);
    setDeclarations(inspectionDeclarationsFor(nextVehicle));
    setSpecialCaseMode(isInspectionDemoVehicle(nextVehicle) ? "all_no" : "");
  }, [mode, selectedVehicle, vehicles]);

  useEffect(() => {
    if (!result) return;
    const frame = window.requestAnimationFrame(() => {
      const resultHero = document.querySelector('[data-testid="inspection-result"]');
      const scroll = resultHero?.closest<HTMLElement>('[data-testid="mobile-scroll"]');
      if (scroll) scroll.scrollTop = 0;
      // A focused native select can make WebKit scroll the clipped PhoneFrame
      // itself while the form is replaced by the result. Keep the protected
      // runtime untouched and restore this flow's device viewport here.
      const deviceScreen = resultHero?.closest<HTMLElement>('[data-testid="device-screen"]');
      if (deviceScreen) deviceScreen.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  const invalidateResult = () => {
    latestCalculation.current += 1;
    setResult(null);
    setError("");
    setSubmitting(false);
    setTemporaryValidityOpen(false);
    setTemporaryValidity(null);
    setTemporaryValidityDraft({ mode: "confirmed", validThroughMonth: "", source: "traffic_12123" });
    setTemporaryValiditySourceSelected(false);
  };

  const chooseMode = (nextMode: "vehicle" | "temporary") => {
    keyboard.hide();
    invalidateResult();
    setMode(nextMode);
    const nextVehicle = selectedVehicle || activeVehicle;
    const nextSpecialCaseMode = nextMode === "vehicle" && isInspectionDemoVehicle(nextVehicle) ? "all_no" : "";
    setSpecialCaseMode(nextSpecialCaseMode);
    setDeclarations(nextSpecialCaseMode === "all_no" ? inspectionDeclarationsFor(nextVehicle) : unknownInspectionDeclarations());
  };

  const chooseVehicle = (vehicleId: string) => {
    invalidateResult();
    const nextVehicle = vehicles.find((vehicle) => vehicle.id === vehicleId);
    setSelectedVehicleId(vehicleId);
    const nextSpecialCaseMode = isInspectionDemoVehicle(nextVehicle) ? "all_no" : "";
    setSpecialCaseMode(nextSpecialCaseMode);
    setDeclarations(nextSpecialCaseMode === "all_no" ? inspectionDeclarationsFor(nextVehicle) : unknownInspectionDeclarations());
  };

  const chooseSpecialCaseMode = (nextMode: "all_no" | "detail") => {
    invalidateResult();
    setSpecialCaseMode(nextMode);
    setDeclarations(nextMode === "all_no" ? inspectionDeclarationsFor(selectedVehicle) : unknownInspectionDeclarations());
  };

  const setTemporaryField = <Key extends keyof typeof temporaryVehicle>(key: Key, value: (typeof temporaryVehicle)[Key]) => {
    invalidateResult();
    setTemporaryVehicle((current) => ({ ...current, [key]: value }));
  };

  const runCalculation = async (temporaryValidityOverride: InspectionValidity = temporaryValidity || { mode: "unconfirmed" }) => {
    const requestId = latestCalculation.current + 1;
    latestCalculation.current = requestId;
    setSubmitting(true);
    try {
      const request: InspectionApiRequest = mode === "vehicle"
        ? { source: "vehicle", vehicleId: selectedVehicle!.id, declarations }
        : { source: "temporary", vehicle: temporaryVehicle, inspectionValidity: temporaryValidityOverride, declarations };
      const localCalculationInput = {
        source: mode,
        asOfDate: DEMO_TODAY,
        vehicle: mode === "vehicle" ? inspectionVehicleFromProfile(selectedVehicle!) : temporaryVehicle,
        declarations,
        inspectionValidity: mode === "vehicle" ? selectedVehicle?.inspectionValidity || { mode: "unconfirmed" as const } : temporaryValidityOverride,
      } as const;
      let calculation: WebInspectionCalculationResult;
      if (!apiOnline) {
        calculation = calculateInspection(localCalculationInput) as WebInspectionCalculationResult;
      } else {
        try {
          calculation = await apiRequest<WebInspectionCalculationResult>("/inspection/calculations", { method: "POST", body: JSON.stringify(request) });
        } catch (reason) {
          if (!canUseInspectionLocalFallback(reason)) throw reason;
          calculation = calculateInspection(localCalculationInput) as WebInspectionCalculationResult;
        }
      }
      if (latestCalculation.current === requestId) {
        setResult(calculation);
        if (mode === "temporary") {
          setTemporaryValidity(temporaryValidityOverride.mode === "confirmed" ? temporaryValidityOverride : null);
        }
      }
    } catch (reason) {
      if (latestCalculation.current !== requestId) return;
      const message = reason instanceof Error && reason.message.includes("注册")
        ? reason.message
        : "年检测算暂时没有完成，请稍后重试；也可通过交管12123核验。";
      setError(message);
    } finally {
      if (latestCalculation.current === requestId) setSubmitting(false);
    }
  };

  const submitCalculation = async (event: FormEvent) => {
    event.preventDefault();
    keyboard.hide();
    setError("");
    if (mode === "vehicle" && !selectedVehicle) {
      setError("请先选择一辆已建档车辆，或改用临时测算。");
      return;
    }
    if (!specialCaseMode) {
      setError("请确认车辆是否存在特殊情况后再查看测算结果。");
      return;
    }
    if (mode === "temporary" && (!/^\d{4}-\d{2}$/.test(temporaryVehicle.registrationMonth) || temporaryVehicle.registrationMonth > DEMO_TODAY.slice(0, 7))) {
      setError("请选择有效且不晚于本月的车辆注册月份。");
      return;
    }
    await runCalculation();
  };

  const renderResultActions = (calculation: WebInspectionCalculationResult, dateEvidence: InspectionDateEvidence) => {
    if (dateEvidence.status === "conflict") {
      return <div className="inspection-result-actions"><button className="primary-button" data-testid="inspection-cta-official-check" onClick={() => flow.push(serviceScreen("官方状态核验", "用户确认日期与规则估算不一致，请通过交管12123核验真实检验有效期和车辆登记记录。"))}><ShieldCheck size={20} weight="duotone" />通过交管12123核验</button><button className="secondary-button" data-testid="inspection-cta-support" onClick={() => flow.push(serviceScreen("年检专属客服", "人工协助对照登记日期、历史办理与用户确认的有效期，不代替交管部门作出认定。"))}><Headset size={20} weight="duotone" />联系专属客服</button></div>;
    }
    if (calculation.windowStatus === "not_open") {
      return mode === "temporary"
        ? <div className="inspection-result-actions"><button className="primary-button" data-testid="inspection-cta-save-vehicle" onClick={() => flow.push(vehicleFormScreen())}><Plus size={20} weight="bold" />建档并接收办理提醒</button><button className="secondary-button" data-testid="inspection-cta-official-check" onClick={() => flow.push(serviceScreen(calculation.action === "claim_mark" ? "交管12123申领指引" : "核验检验有效期", calculation.action === "claim_mark" ? "本轮预计无需上线检验，请在办理窗口内通过交管12123申领检验标志，并以官方显示的检验有效期为准。" : "当前办理窗口尚未开始，可先在交管12123核验真实检验有效期。"))}><ShieldCheck size={20} weight="duotone" />查看官方办理指引</button></div>
        : <button className="primary-button" data-testid="inspection-cta-official-check" onClick={() => flow.push(serviceScreen("核验检验有效期", "当前办理窗口尚未开始，可先在交管12123核验真实检验有效期，并在窗口开启后预约。"))}><ShieldCheck size={20} weight="duotone" />核验官方检验有效期</button>;
    }
    if (calculation.action === "claim_mark") {
      return <button className="primary-button" data-testid="inspection-cta-official-guide" onClick={() => flow.push(serviceScreen("交管12123申领指引", "本轮无需上线检验，请在预计到期日前三个月内通过交管12123申领检验标志，并以官方显示的检验有效期为准。"))}><ShieldCheck size={20} weight="duotone" />查看交管12123申领指引</button>;
    }
    if (calculation.action === "onsite_inspection" && calculation.windowStatus === "open" && calculation.canBookInspection) {
      return <button className="primary-button" data-testid="inspection-cta-book" onClick={() => flow.push(stationsScreen())}><CalendarCheck size={20} weight="duotone" />选择检测站并预约</button>;
    }
    return (
      <div className="inspection-result-actions">
        <button className="primary-button" data-testid="inspection-cta-official-check" onClick={() => flow.push(serviceScreen("官方状态核验", "请通过交管12123核验真实检验有效期和车辆登记记录；本页不会用规则测算替代政务查询。"))}><ShieldCheck size={20} weight="duotone" />通过交管12123核验</button>
        <button className="secondary-button" data-testid="inspection-cta-support" onClick={() => flow.push(serviceScreen("年检专属客服", "人工协助梳理车型、使用性质与登记历史，不代替交管部门作出认定。"))}><Headset size={20} weight="duotone" />联系专属客服</button>
      </div>
    );
  };

  if (result) {
    const inputVehicle = mode === "vehicle" && selectedVehicle
      ? { ...inspectionVehicleFromProfile(selectedVehicle), powertrainType: vehiclePowertrain(selectedVehicle) }
      : temporaryVehicle;
    const powertrainType = mode === "vehicle" && selectedVehicle ? vehiclePowertrain(selectedVehicle) : temporaryVehicle.powertrainType;
    const evidence = result.evidence || fallbackInspectionEvidence(result, inputVehicle, declarations, powertrainType);
    const impact = evidence.powertrainImpact || evidence.energy || fallbackInspectionEvidence(result, inputVehicle, declarations, powertrainType).powertrainImpact;
    const dateEvidence = normalizeDateEvidence(result, mode === "vehicle" ? selectedVehicle : null, temporaryValidity);
    const tone = dateEvidence.status === "conflict" ? "manual" : result.windowStatus === "overdue" ? "overdue" : result.windowStatus === "manual_review" ? "manual" : result.windowStatus === "open" ? "ready" : "waiting";
    const sourceLabel = mode === "vehicle" && selectedVehicle ? selectedVehicle.plateNumber : "临时测算";
    const windowLabel = dateEvidence.status === "conflict" ? "日期冲突，预约已关闭" : result.windowStatus === "open" ? "当前可办理" : result.windowStatus === "not_open" ? "办理窗口未开始" : result.windowStatus === "overdue" ? "预计已逾期" : "需要官方核验";
    return (
      <MobileScroll key="inspection-result" className="app-scroll">
        <main className="sub-page inspection-page inspection-result-page" data-testid="inspection-page">
          <section className={`inspection-result-hero ${tone}`} data-testid="inspection-result">
            <span>{tone === "manual" || tone === "overdue" ? <Warning size={30} weight="duotone" /> : <SealCheck size={30} weight="duotone" />}</span>
            <small>{sourceLabel} · 政策规则测算</small>
            <h1>{dateEvidence.status === "conflict" ? "日期待核验" : result.title}</h1>
            <p>{dateEvidence.status === "conflict" ? "用户确认的有效期月份与公开规则估算不一致，请先核验登记或历史办理情况。" : result.summary}</p>
            <em data-testid="inspection-result-window">{windowLabel}</em>
          </section>

          <section className="inspection-result-metrics">
            <div><CalendarBlank size={20} weight="duotone" /><span><small>规则估算有效期止</small><strong data-testid="inspection-result-due">{result.estimatedDueDate || "需核验"}</strong></span></div>
            <div><Clock size={20} weight="duotone" /><span><small>预计办理窗口</small><strong>{result.applicationWindow ? `${result.applicationWindow.start} 至 ${result.applicationWindow.end}` : "需核验"}</strong></span></div>
            <div><Car size={20} weight="duotone" /><span><small>本轮节点</small><strong>{result.cycleYear ?`注册后第 ${result.cycleYear} 年` : "登记历史待核验"}</strong></span></div>
          </section>

          <section className="inspection-result-conversion" data-testid="inspection-result-conversion">
            <strong>{result.action === "onsite_inspection" && result.windowStatus === "open" && result.canBookInspection ? "测算完成，下一步直接预约" : "测算完成，按建议继续办理"}</strong>
            <small>选择后即可衔接检测站、到站时间与资料准备</small>
            {renderResultActions(result, dateEvidence)}
          </section>

          <InspectionDateEvidenceCard
            dateEvidence={dateEvidence}
            mode={mode}
            comparisonOpen={temporaryValidityOpen}
            temporaryValidityDraft={temporaryValidityDraft}
            temporaryValiditySourceSelected={temporaryValiditySourceSelected}
            comparing={submitting}
            onToggleComparison={() => { keyboard.hide(); setTemporaryValidityOpen((open) => !open); }}
            onTemporaryValidityDraftChange={(validity) => {
              setTemporaryValidityDraft(validity);
              if (!validity.validThroughMonth) setTemporaryValiditySourceSelected(false);
            }}
            onTemporaryValiditySourceChange={(source) => {
              setTemporaryValiditySourceSelected(true);
              setTemporaryValidityDraft((validity) => ({ ...validity, source }));
            }}
            onCompareValidity={() => {
              if (!temporaryValiditySourceSelected || !/^\d{4}-(0[1-9]|1[0-2])$/.test(temporaryValidityDraft.validThroughMonth)) return;
              keyboard.hide();
              void runCalculation(temporaryValidityDraft);
            }}
            onUseEstimateOnly={() => {
              keyboard.hide();
              setTemporaryValidityDraft({ mode: "confirmed", validThroughMonth: "", source: "traffic_12123" });
              setTemporaryValiditySourceSelected(false);
              setTemporaryValidityOpen(false);
              if (temporaryValidity) void runCalculation({ mode: "unconfirmed" });
            }}
            onEditVehicle={() => selectedVehicle && flow.push(vehicleFormScreen(selectedVehicle))}
          />

          <InspectionEvidenceCard result={result} evidence={evidence} />
          <PowertrainImpactCard result={result} impact={impact} />

          <details className="inspection-policy-card">
            <summary><ShieldCheck size={20} weight="duotone" /><span><strong>规则来源（均为官方）</strong><small>政策版本 {result.policy.version} · 复核于 {result.policy.reviewedAt}</small></span><CaretDown size={15} /></summary>
            <div><p>{result.disclaimer}</p><nav aria-label="年检政策来源">{result.policy.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}<CaretRight size={12} /></a>)}</nav></div>
          </details>

          <button className="inspection-edit-query" data-testid="inspection-edit-query" onClick={() => { invalidateResult(); setResult(null); }}><NotePencil size={17} />修改信息重新测算</button>
        </main>
      </MobileScroll>
    );
  }

  return (
    <MobileScroll key="inspection-form" className="app-scroll">
      <main className="sub-page inspection-page" data-testid="inspection-page">
        <section className="inspection-progress" aria-label="第2步，共2步">
          <span className="done"><Check size={13} weight="bold" /></span><i></i><span className="active">2</span><strong>第2步，共2步</strong>
        </section>

        <div className="inspection-mode-tabs" role="tablist" aria-label="年检查询方式">
          <button role="tab" aria-selected={mode === "vehicle"} className={mode === "vehicle" ? "active" : ""} data-testid="inspection-mode-vehicle" onClick={() => chooseMode("vehicle")}><Car size={18} weight="duotone" /><span><strong>我的车辆</strong><small>从车辆档案带入</small></span></button>
          <button role="tab" aria-selected={mode === "temporary"} className={mode === "temporary" ? "active" : ""} data-testid="inspection-mode-temporary" onClick={() => chooseMode("temporary")}><ClipboardText size={18} weight="duotone" /><span><strong>临时测算</strong><small>无需车牌，不保存</small></span></button>
        </div>

        <form className="inspection-query-form" onSubmit={submitCalculation}>
          <section className="inspection-form-section inspection-vehicle-stage" data-testid="inspection-basic-info">
            {mode === "vehicle" ? (
              vehicles.length && selectedVehicle ? <>
                <div className="inspection-vehicle-hero">
                  <img src="/assets/brand/hero-car-tianjin.png" alt="天津城市与白色轿车" />
                  <div className="inspection-vehicle-hero-shade"></div>
                  <div className="inspection-vehicle-hero-copy"><span><strong>{selectedVehicle.plateNumber}</strong>{isInspectionDemoVehicle(selectedVehicle) ? <em>演示车辆</em> : null}</span><small>{selectedVehicle.vehicleType} · {vehicleUsageNature(selectedVehicle)} · {vehicleSeats(selectedVehicle)}座</small></div>
                </div>
                <label className="inspection-vehicle-switch"><span>当前测算车辆</span><select aria-label="查询车辆" data-testid="inspection-vehicle-select" value={selectedVehicleId} onChange={(event) => chooseVehicle(event.target.value)}>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.plateNumber} · {vehicle.vehicleType}</option>)}</select><CaretDown size={16} /></label>
              </> : <div className="inspection-no-vehicle"><Car size={28} weight="duotone" /><span><strong>还没有车辆档案</strong><small>可以先临时测算，或补全车牌和注册信息后保存。</small></span><button type="button" onClick={() => flow.push(vehicleFormScreen())}>添加车辆</button></div>
            ) : (
              <div className="inspection-temporary-fields">
                <Field label="车辆注册月份"><KeyboardInput type="month" max={DEMO_TODAY.slice(0, 7)} value={temporaryVehicle.registrationMonth} data-testid="inspection-registration-month" onChange={(event) => setTemporaryField("registrationMonth", event.target.value)} /></Field>
                <Field label="车辆类型"><select aria-label="车辆类型" data-testid="inspection-vehicle-class" value={temporaryVehicle.vehicleClass} onChange={(event) => setTemporaryField("vehicleClass", event.target.value as InspectionVehicleInput["vehicleClass"])}><option value="small_micro_passenger">小微型载客汽车</option><option value="other">其他车型</option><option value="unknown">不清楚</option></select></Field>
                <Field label="使用性质"><div className="segmented inspection-usage-segment"><button type="button" data-testid="inspection-usage-non-operational" className={temporaryVehicle.usageNature === "non_operational" ? "active" : ""} onClick={() => setTemporaryField("usageNature", "non_operational")}>非营运</button><button type="button" data-testid="inspection-usage-operational" className={temporaryVehicle.usageNature === "operational" ? "active" : ""} onClick={() => setTemporaryField("usageNature", "operational")}>营运</button><button type="button" data-testid="inspection-usage-unknown" className={temporaryVehicle.usageNature === "unknown" ? "active" : ""} onClick={() => setTemporaryField("usageNature", "unknown")}>不清楚</button></div></Field>
                <Field label="核定座位"><select aria-label="核定座位" data-testid="inspection-seats" value={temporaryVehicle.seats ?? ""} onChange={(event) => setTemporaryField("seats", event.target.value ? Number(event.target.value) : null)}><option value="">不清楚</option>{[2, 4, 5, 6, 7, 8, 9, 10].map((seats) => <option key={seats} value={seats}>{seats} 座</option>)}</select></Field>
                <Field label="动力类型"><select aria-label="动力类型" data-testid="inspection-powertrain" value={temporaryVehicle.powertrainType} onChange={(event) => setTemporaryField("powertrainType", event.target.value as PowertrainType)}>{(Object.entries(POWERTRAIN_LABELS) as Array<[PowertrainType, string]>).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small className="form-help">动力类型不改变年检周期，只影响需要上线时的预计检验项目。</small></Field>
              </div>
            )}
          </section>

          <section className="inspection-form-section inspection-declarations inspection-special-card" data-testid="inspection-special-cases">
            <header><div><h2>这辆车是否存在以下任一特殊情况？</h2><small>这会影响是否可以直接按公开规则测算</small></div></header>
            <ol className="inspection-special-summary">
              {INSPECTION_DECLARATION_ITEMS.map((item, index) => <li key={item.key}><span>{index + 1}</span><strong>{item.shortLabel}</strong><small>{item.help}</small></li>)}
            </ol>
            <div className="inspection-special-actions">
              <button type="button" className={specialCaseMode === "all_no" ? "selected" : ""} aria-pressed={specialCaseMode === "all_no"} data-testid="inspection-special-all-no" onClick={() => chooseSpecialCaseMode("all_no")}><CheckCircle size={20} weight={specialCaseMode === "all_no" ? "fill" : "regular"} /><span><strong>均不符合</strong><small>常见情况，直接查看测算结果</small></span></button>
              <button type="button" className={specialCaseMode === "detail" ? "selected" : ""} aria-pressed={specialCaseMode === "detail"} data-testid="inspection-special-detail" onClick={() => chooseSpecialCaseMode("detail")}><Warning size={20} weight="duotone" /><span><strong>有一项符合或不确定</strong><small>逐项确认，我们告诉你在哪里核对</small></span><CaretRight size={16} /></button>
            </div>
            {specialCaseMode === "detail" ? <div className="inspection-special-details">{INSPECTION_DECLARATION_ITEMS.map((item) => <InspectionDeclarationRow key={item.key} item={item} value={declarations[item.key]} onChange={(value) => { invalidateResult(); setDeclarations((current) => ({ ...current, [item.key]: value })); }} />)}</div> : null}
          </section>

          {error ? <p className="inspection-form-error" role="alert">{error}</p> : null}
          <div className="inspection-submit-dock"><button className="primary-button inspection-calculate" type="submit" data-testid="inspection-calculate" disabled={submitting || (mode === "vehicle" && !selectedVehicle)}>{submitting ? <CircleNotch className="spin" size={20} /> : <CalendarCheck size={20} weight="duotone" />}{submitting ? "正在测算" : "查看测算结果"}</button><p><ShieldCheck size={13} weight="duotone" />若需上线，可直接选择检测站和时间</p></div>
        </form>
      </main>
    </MobileScroll>
  );
}

function InspectionStageScreen({ stage }: { stage: InspectionStage }) {
  const flow = useFlow();
  const { bookings, activeVehicle, fetchBooking } = useMvp();
  const summaryBooking = latestInspectionBooking(bookings);
  const [refreshedBooking, setRefreshedBooking] = useState<Booking | null>(null);
  useEffect(() => {
    let active = true;
    setRefreshedBooking(null);
    if (!summaryBooking) return () => { active = false; };
    void fetchBooking(summaryBooking.id).then((next) => {
      if (active) setRefreshedBooking(next);
    }).catch(() => {
      if (active) setRefreshedBooking(null);
    });
    return () => { active = false; };
  }, [summaryBooking?.id, summaryBooking?.updatedAt]);
  const booking = refreshedBooking?.id === summaryBooking?.id ? refreshedBooking : summaryBooking;
  const status = booking ? bookingFlowStatus(booking) : null;
  const terminal = status ? ["cancelled", "no_show"].includes(status) : false;
  const media = booking?.media || [];
  const licenseMediaCount = media.filter((item) => item.kind === "license_front" || item.kind === "license_back").length;
  const stages: Array<[InspectionStage, typeof CalendarCheck, string]> = [
    ["booking", CalendarCheck, "预约"],
    ["arrival", Car, "到站"],
    ["materials", FileText, "资料"],
    ["result", ShieldCheck, "结果"],
  ];
  const meta = ({
    booking: { index: "01", eyebrow: "ONLINE BOOKING", title: "选好站点与时间，再确认预约", copy: "先完成年检规则测算，再按距离、价格和可约时段选择检测站。", icon: CalendarCheck },
    arrival: { index: "02", eyebrow: "ARRIVAL GUIDE", title: "到站前，把时间和材料再核对一遍", copy: "已预约用户可在这里查看站点、预约时间和到站提示。", icon: Car },
    materials: { index: "03", eyebrow: "DOCUMENTS", title: "预约时上传，原件到站携带", copy: "线上照片用于预约资料核对，现场办理仍以实际证件和站点要求为准。", icon: FileText },
    result: { index: "04", eyebrow: "RESULT & MARK", title: "查看检测结果与官方申领指引", copy: "结果回传后可查看检测结论；检验标志以交管12123官方状态为准。", icon: ShieldCheck },
  } satisfies Record<InspectionStage, { index: string; eyebrow: string; title: string; copy: string; icon: typeof CalendarCheck }>)[stage];
  const StageIcon = meta.icon;

  const openBooking = () => {
    if (!booking || terminal || status === "completed") return flow.push(stationsScreen());
    if (booking.paymentStatus === "unpaid" || status === "pending_payment") return flow.push(bookingPaymentScreen(booking.id));
    flow.push(orderDetailScreen(booking.id));
  };
  const bookingPrimaryLabel = !booking || terminal || status === "completed" ? "选择检测站与时间" : status === "pending_payment" ? "继续完成模拟支付" : "查看本次预约进度";
  const resultAvailable = Boolean(booking?.inspectionResult);
  const resultConclusion = booking?.inspectionResult?.conclusion || (resultAvailable ? "passed" : null);
  const stationMapUrl = booking?.station?.latitude != null && booking.station.longitude != null
    ? `https://apis.map.qq.com/uri/v1/marker?marker=coord:${booking.station.latitude},${booking.station.longitude};title:${encodeURIComponent(booking.station.name)}`
    : null;

  return (
    <MobileScroll className="app-scroll inspection-stage-scroll">
      <main className="sub-page inspection-stage-page" data-testid="inspection-stage-page" data-stage={stage}>
        <section className="inspection-stage-hero">
          <span className="inspection-stage-index">{meta.index}</span>
          <div className="inspection-stage-hero-icon"><StageIcon size={31} weight="duotone" /></div>
          <small>{meta.eyebrow}</small>
          <h1>{meta.title}</h1>
          <p>{meta.copy}</p>
        </section>

        <nav className="inspection-stage-switcher" aria-label="年检服务阶段">
          {stages.map(([value, Icon, label]) => <button key={value} type="button" className={value === stage ? "active" : ""} aria-current={value === stage ? "step" : undefined} onClick={() => value !== stage && flow.replace(inspectionStageScreen(value))}><Icon size={18} weight={value === stage ? "fill" : "duotone"} /><span>{label}</span></button>)}
        </nav>

        {booking ? (
          <section className="inspection-stage-booking" data-testid="inspection-stage-booking-context">
            <header><span><small>最近年检预约</small><strong>{booking.vehicle?.plateNumber || activeVehicle?.plateNumber || "服务车辆"}</strong></span><em className={`status-${status}`}>{status ? bookingStatusLabel(status) : "待确认"}</em></header>
            <div><MapPin size={18} weight="duotone" /><span><small>检测站</small><strong>{booking.station?.name || "站点待确认"}</strong></span></div>
            <div><Clock size={18} weight="duotone" /><span><small>预约时间</small><strong>{booking.appointmentDate} {booking.startTime}–{booking.endTime}</strong></span></div>
          </section>
        ) : (
          <section className="inspection-stage-empty"><Car size={28} weight="duotone" /><span><strong>还没有年检预约</strong><small>{stage === "result" ? "完成检测后，可在这里查看结果与申领指引" : "完成规则测算并预约后，这里会展示对应的服务信息"}</small></span></section>
        )}

        {stage === "booking" ? <>
          <section className="inspection-stage-guide"><h2>预约前只需三步</h2><div><b>1</b><span><strong>确认本轮办理方式</strong><small>先查询是否需要上线检验，避免选错服务。</small></span></div><div><b>2</b><span><strong>选择检测站和时段</strong><small>按区域、距离、价格和剩余号源选择。</small></span></div><div><b>3</b><span><strong>核对信息并提交</strong><small>确认车辆、联系人、资料与透明报价。</small></span></div></section>
          {!booking || terminal || status === "completed" ? <button className="inspection-stage-link" onClick={() => flow.push(inspectionScreen())}><MagnifyingGlass size={18} />先查询是否需上线<CaretRight size={16} /></button> : null}
          <button className="primary-button inspection-stage-primary" data-testid="inspection-stage-primary" onClick={openBooking}><CalendarCheck size={20} weight="duotone" />{bookingPrimaryLabel}</button>
        </> : null}

        {stage === "arrival" ? <>
          <section className="inspection-stage-guide arrival"><h2>到站提示</h2><div><CheckCircle size={19} weight="duotone" /><span><strong>提前 10 分钟到达</strong><small>预留停车、资料核对和车辆交接时间。</small></span></div><div><CheckCircle size={19} weight="duotone" /><span><strong>携带证件原件</strong><small>行驶证、身份证明及站点要求的其他材料。</small></span></div><div><CheckCircle size={19} weight="duotone" /><span><strong>保持车辆可检测</strong><small>提前处理违章，确认交强险状态和车辆基本状况。</small></span></div></section>
          {booking?.serviceMode === "valet" && !terminal ? <p className="inspection-stage-note"><SteeringWheel size={18} /><span><strong>{status ? bookingStatusLabel(status) : "取送待确认"}</strong><small>{booking.pickupAddress ? `取车地址：${booking.pickupAddress.title} · ${booking.pickupAddress.address}` : "无需自行到站，请留意平台线下取车与交接联系。"}</small></span></p> : booking && !terminal ? <div className="inspection-stage-contact-actions">{booking.station?.phone ? <a href={`tel:${booking.station.phone}`}><Phone size={18} />联系检测站</a> : null}{stationMapUrl ? <a href={stationMapUrl} target="_blank" rel="noreferrer"><NavigationArrow size={18} weight="fill" />打开站点导航</a> : null}</div> : null}
          <button className="primary-button inspection-stage-primary" data-testid="inspection-stage-primary" onClick={openBooking}>{booking && !terminal ? <Receipt size={20} /> : <CalendarCheck size={20} />}{booking && !terminal ? "查看预约凭证与进度" : "先预约检测服务"}</button>
        </> : null}

        {stage === "materials" ? <>
          <section className="inspection-stage-guide materials"><header><h2>资料准备</h2>{booking ? <span>{booking.verification?.materialsReady ? "已核验" : `${licenseMediaCount}/2 已提交`}</span> : null}</header>
            <div><FileText size={19} weight="duotone" /><span><strong>行驶证正反面</strong><small>预约时上传清晰照片，到站携带原件。</small></span><em className={booking?.verification?.materialsReady ? "verified" : licenseMediaCount === 2 ? "submitted" : "pending"}>{booking?.verification?.materialsReady ? "已核验" : licenseMediaCount === 2 ? "已提交" : licenseMediaCount ? `已传 ${licenseMediaCount}/2` : "待提交"}</em></div>
            <div><ShieldCheck size={19} weight="duotone" /><span><strong>交强险凭证</strong><small>确认在有效期内，现场状态以官方记录为准。</small></span><em className={booking?.verification?.materialsReady ? "verified" : "pending"}>{booking?.verification?.materialsReady ? "已核验" : "待核验"}</em></div>
            <div><Receipt size={19} weight="duotone" /><span><strong>车船税凭证</strong><small>按车辆实际缴纳情况准备电子或纸质凭证。</small></span><em className={booking?.verification?.materialsReady ? "verified" : "pending"}>{booking?.verification?.materialsReady ? "已核验" : "待核验"}</em></div>
            <div><Warning size={19} weight="duotone" /><span><strong>三角警示牌</strong><small>随车携带，到站后按工作人员提示检查。</small></span><em className="carry">随车携带</em></div>
          </section>
          {booking && (licenseMediaCount > 0 || booking.verification?.materialsReady) ? <p className="inspection-stage-note success"><CheckCircle size={18} weight="fill" />{booking.verification?.materialsReady ? "站点已完成本次预约材料核验。" : `本次预约已提交 ${licenseMediaCount} 张行驶证照片，等待站点核验。`}</p> : null}
          <button className="primary-button inspection-stage-primary" data-testid="inspection-stage-primary" onClick={openBooking}>{booking && !terminal && status !== "completed" ? <Receipt size={20} /> : <CalendarCheck size={20} />} {booking && !terminal && status !== "completed" ? "查看本次预约资料" : "去预约并上传资料"}</button>
          <button className="inspection-stage-link" onClick={() => flow.push(materialsScreen())}><ClipboardText size={18} />查看办理材料说明<CaretRight size={16} /></button>
        </> : null}

        {stage === "result" ? <>
          <section className={`inspection-stage-result ${resultAvailable ? "available" : "waiting"}`}>
            {resultAvailable ? <SealCheck size={31} weight="duotone" /> : <Clock size={30} weight="duotone" />}
            <span><small>{resultAvailable ? "检测结果已回传" : booking && !terminal ? "等待检测结果" : "暂无检测结果"}</small><strong>{resultAvailable ? resultConclusion === "failed" ? "本次检验需复检" : resultConclusion === "conditional" ? "结果需要进一步确认" : "本次检验结论：合格" : booking && !terminal && status ? `当前：${bookingStatusLabel(status)}` : "完成检测后在这里查看"}</strong><p>{resultAvailable && typeof booking?.inspectionResult?.summary === "string" ? booking.inspectionResult.summary : "检测站完成作业并回传结果后，页面会同步展示办理结论。"}</p></span>
          </section>
          <p className="inspection-result-boundary"><ShieldCheck size={19} weight="duotone" />本页不生成或替代官方电子检验标志，请以交管12123显示为准。</p>
          <button className="primary-button inspection-stage-primary" data-testid="inspection-stage-primary" onClick={() => resultAvailable && booking ? flow.push(orderDetailScreen(booking.id)) : booking && !terminal ? flow.push(orderDetailScreen(booking.id)) : flow.push(inspectionScreen())}>{resultAvailable ? <SealCheck size={20} /> : <MagnifyingGlass size={20} />}{resultAvailable ? "查看完整检测结果" : booking && !terminal ? "查看履约进度" : "先查询年检方式"}</button>
          {resultConclusion === "passed" ? <button className="inspection-stage-link" onClick={() => flow.push(serviceScreen("交管12123申领指引", "检测合格后，请通过交管12123查看官方检验有效期及电子检验标志；本服务不代替官方政务办理。"))}><ShieldCheck size={18} />查看官方申领指引<CaretRight size={16} /></button> : resultConclusion === "failed" ? <button className="inspection-stage-link warning" onClick={() => flow.push(serviceScreen("复检办理建议", "请根据检测结果处理不合格项目，并联系原检测站确认复检时限、材料和办理方式。"))}><Warning size={18} />查看复检办理建议<CaretRight size={16} /></button> : resultConclusion === "conditional" ? <button className="inspection-stage-link warning" onClick={() => flow.push(serviceScreen("结果处理建议", "当前结果需要进一步确认，请联系检测站核对具体项目和下一步办理要求。"))}><Warning size={18} />查看进一步处理建议<CaretRight size={16} /></button> : null}
        </> : null}
      </main>
    </MobileScroll>
  );
}

function MaterialsScreen() {
  const flow = useFlow();
  const { activeVehicle, fetchInspection, materialsChecked, toggleMaterial } = useMvp();
  const [status, setStatus] = useState<InspectionStatus | null>(null);
  useEffect(() => { if (activeVehicle) void fetchInspection(activeVehicle.id).then(setStatus); }, [activeVehicle?.id]);
  const materials = status?.materials || fallbackMaterials;
  const complete = materials.every((item) => materialsChecked[item.id]);
  return (
    <MobileScroll className="app-scroll">
      <main className="sub-page materials-page">
        <div className="materials-progress"><span>{materials.filter((item) => materialsChecked[item.id]).length}/{materials.length}</span><div><strong>{complete ? "材料已准备齐全" : "办理前请确认材料"}</strong><small>点击每一项进行演示确认</small></div></div>
        <section className="materials-list">
          {materials.map((item) => <button key={item.id} className={materialsChecked[item.id] ? "checked" : ""} onClick={() => toggleMaterial(item.id)}><span className="check-box">{materialsChecked[item.id] ? <Check size={18} weight="bold" /> : null}</span><span><strong>{item.name}</strong><small>{item.description}</small></span>{item.required ? <em>必备</em> : null}</button>)}
        </section>
        <section className="tip-card"><Camera size={22} weight="duotone" /><span><strong>支持电子材料演示</strong><small>真实产品可接入 OCR 与电子保单，本 MVP 不上传真实证件。</small></span></section>
        <button className="primary-button" onClick={() => flow.push(stationsScreen())}>{complete ? "材料齐全，去预约" : "稍后准备，先选站点"}</button>
      </main>
    </MobileScroll>
  );
}

function StationsScreen() {
  const flow = useFlow();
  const { stations } = useMvp();
  const [district, setDistrict] = useState("全部");
  const districts = ["全部", ...Array.from(new Set(stations.map((item) => item.district)))];
  const filtered = district === "全部" ? stations : stations.filter((item) => item.district === district);
  const realRouteStations = filtered.filter((station) => station.distanceSource === "tencent_matrix" && Number.isFinite(station.distanceKm));
  const closestStationId = realRouteStations.reduce<Station | null>((closest, station) => !closest || Number(station.distanceKm) < Number(closest.distanceKm) ? station : closest, null)?.id;
  const visible = [...filtered].sort((left, right) => {
    const pinned = Number(stationIsPinned(right)) - Number(stationIsPinned(left));
    if (pinned) return pinned;
    const priority = Number(right.sortPriority || 0) - Number(left.sortPriority || 0);
    if (priority) return priority;
    if (left.distanceSource === "tencent_matrix" && right.distanceSource === "tencent_matrix") return Number(left.distanceKm) - Number(right.distanceKm);
    return left.name.localeCompare(right.name, "zh-CN");
  });
  return (
    <MobileScroll className="app-scroll">
      <main className="sub-page stations-page">
        <div className="filter-rail">{districts.map((item) => <button key={item} className={district === item ? "active" : ""} onClick={() => setDistrict(item)}>{item}</button>)}</div>
        <div className="manual-location"><MapTrifold size={20} weight="duotone" /><span>定位权限关闭也可手动选区</span></div>
        {visible.map((station) => <button className={`station-card ${station.isDirectOperated ? "direct-operated" : ""}`} key={station.id} onClick={() => flow.push(stationDetailScreen(station.id))}>
          <img src="/assets/stations/inspection-station.png" alt={stationIsDemo(station) ? "机动车检测服务站演示图" : `${station.name}站点示意图`} draggable={false} />
          <span className="station-copy"><span className="station-flags">{station.isDirectOperated && stationIsPinned(station) ? <i className="owned">自营站 · 置顶推荐</i> : null}{stationIsDemo(station) ? <i className="demo">演示站</i> : null}{closestStationId === station.id ? <i className="nearest">腾讯真实路线最近</i> : null}</span><small>{station.district}</small><strong>{station.name}</strong><em><MapPin size={14} /> {formatStationDistance(station)}</em><span className="tag-row">{station.tags.slice(0, 3).map((tag) => <i key={tag}>{tag}</i>)}</span>{station.reviewCount > 0 ? <b><Star size={14} weight="fill" /> {station.rating} <u>{station.reviewCount} 条演示评价</u></b> : <b className="verified-address"><SealCheck size={14} weight="fill" /> 名称与地址已核验</b>}</span>
          <span className="station-price"><small>年检参考价</small><strong>¥{formatMoney(station.serviceFeeFen)}</strong><CaretRight size={18} /></span>
        </button>)}
        <p className="demo-disclosure">华洋站名称、地址与腾讯坐标已核验；检测价、评分及其他演示站数据仍为 MVP 演示口径。仅腾讯驾车矩阵结果可标记“最近”。</p>
      </main>
    </MobileScroll>
  );
}

function StationDetailScreen({ stationId }: { stationId: string }) {
  const flow = useFlow();
  const { stations, setSelectedStationId, selectedSlot, setSelectedSlot, fetchSlots } = useMvp();
  const station = stations.find((item) => item.id === stationId) || stations[0];
  const [slots, setSlots] = useState<Slot[]>([]);
  const slotNow = useSlotClock();
  useEffect(() => { if (station) void fetchSlots(station.id).then(setSlots); }, [station?.id]);
  if (!station) return null;
  const dates = Array.from(new Set(slots.map((item) => item.date)));
  const selectedStationSlot = selectedSlot?.stationId === station.id
    ? slots.find((slot) => slot.id === selectedSlot.id && slot.remaining > 0 && !slotHasStarted(slot, slotNow)) || null
    : null;
  return (
    <MobileScroll className="app-scroll">
      <main className="sub-page station-detail-page">
        <img className="station-hero-image" src="/assets/stations/inspection-station.png" alt="机动车检测服务站演示图" draggable={false} />
        <section className="station-title"><div className="station-flags">{station.isDirectOperated && stationIsPinned(station) ? <i className="owned">自营站 · 置顶推荐</i> : null}{stationIsDemo(station) ? <i className="demo">演示站</i> : null}</div><small>{station.district}{station.legalName ? ` · ${station.legalName}` : ""}</small><h1>{station.name}</h1><p>{station.address}</p><div className="tag-row">{station.tags.map((tag) => <i key={tag}>{tag}</i>)}</div></section>
        <section className="station-operating-info"><div><Clock size={18} /><span><small>营业时间</small><strong>{station.openHours}</strong></span></div>{station.phone ? <a href={`tel:${station.phone}`}><Phone size={18} /><span><small>咨询电话</small><strong>{station.phone}</strong></span></a> : null}<p>{station.businessHoursNotice || "营业时间及节假日安排请电话确认"}</p><em>{stationIsDemo(station) ? "本站名称、地址、价格、评分与号源均为演示数据" : "主体、名称、地址与坐标已核验；当前价格、评分和号源为 MVP 配置"}</em></section>
        <section className="transparent-price"><span><ShieldCheck size={23} weight="duotone" /><strong>年检服务参考价</strong></span><em>¥<b>{formatMoney(station.serviceFeeFen)}</b></em><small>当前为本站基础参考价；精确价格根据所选车辆在确认预约页计算，不含车辆维修项目</small></section>
        <section className="slot-section"><div className="section-heading"><h2>选择到站时段</h2><span>约 60 分钟</span></div>{dates.map((date) => <div className="slot-day" key={date}><strong>{formatDateLabel(date)}</strong><div className="slot-grid">{slots.filter((item) => item.date === date).map((slot) => { const started = slotHasStarted(slot, slotNow); return <button key={slot.id} data-testid={`inspection-slot-${slot.startTime}`} disabled={slot.remaining <= 0 || started} className={selectedStationSlot?.id === slot.id ? "active" : ""} onClick={() => setSelectedSlot(slot)}><strong>{slot.startTime}</strong><small>{started ? "已过时段" : slot.remaining <= 0 ? "已约满" : slot.remaining === 1 ? "仅剩 1 位" : `余 ${slot.remaining} 位`}</small></button>; })}</div></div>)}</section>
        <button className="primary-button" disabled={!selectedStationSlot} onClick={() => { if (!selectedStationSlot) return; setSelectedStationId(station.id); flow.push(bookingConfirmScreen()); }}>{selectedStationSlot ? "确认时段，下一步" : "请选择预约时段"}</button>
      </main>
    </MobileScroll>
  );
}

const bookingMediaSlots: Array<{ kind: MediaKind; label: string; short: string; vehicle: boolean }> = [
  { kind: "vehicle_front_left", label: "车辆左前", short: "左前", vehicle: true },
  { kind: "vehicle_front_right", label: "车辆右前", short: "右前", vehicle: true },
  { kind: "vehicle_rear_left", label: "车辆左后", short: "左后", vehicle: true },
  { kind: "vehicle_rear_right", label: "车辆右后", short: "右后", vehicle: true },
  { kind: "dashboard_started", label: "启动后仪表盘", short: "仪表盘", vehicle: true },
  { kind: "license_front", label: "行驶证正面", short: "行驶证正面", vehicle: false },
  { kind: "license_back", label: "行驶证反面", short: "行驶证反面", vehicle: false },
];

function BookingConfirmScreen() {
  const flow = useFlow();
  const keyboard = useKeyboard();
  const {
    activeVehicle, vehicles, setActiveVehicleId, stations, selectedStationId, selectedSlot,
    createBooking, quoteBooking, fetchLocationSuggestions, uploadMedia, deleteMedia, showToast,
  } = useMvp();
  const station = stations.find((item) => item.id === selectedStationId);
  const [contactName, setContactName] = useState("林先生");
  const [contactPhone, setContactPhone] = useState("13800001234");
  const [serviceMode, setServiceMode] = useState<ServiceMode>("self_drive");
  const [addressQuery, setAddressQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PickupAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<PickupAddress | null>(null);
  const [addressNotice, setAddressNotice] = useState("");
  const [pickupDetail, setPickupDetail] = useState("");
  const [pickupNote, setPickupNote] = useState("");
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [quoteError, setQuoteError] = useState<{ code?: string; message: string } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [media, setMedia] = useState<Partial<Record<MediaKind, BookingMedia>>>({});
  const [uploading, setUploading] = useState<MediaKind | null>(null);
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const slotNow = useSlotClock();

  useEffect(() => {
    if (serviceMode !== "valet" || addressQuery.trim().length < 2 || addressQuery === selectedAddress?.title) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchLocationSuggestions(addressQuery.trim())
        .then((result) => { setSuggestions(result.data); setAddressNotice(result.notice); })
        .catch(() => { setSuggestions([]); setAddressNotice("地址联想暂不可用，请稍后重试"); });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [addressQuery, serviceMode, selectedAddress?.title]);

  useEffect(() => {
    if (!activeVehicle || !station || (serviceMode === "valet" && !selectedAddress)) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    setQuoteLoading(true);
    setQuoteError(null);
    void quoteBooking({ vehicleId: activeVehicle.id, stationId: station.id, serviceMode, pickupAddress: selectedAddress || undefined })
      .then(setQuote)
      .catch((error) => {
        setQuote(null);
        const requestError = error as Error & { code?: string };
        setQuoteError({ code: requestError.code, message: requestError.message || "报价加载失败" });
      })
      .finally(() => setQuoteLoading(false));
  }, [activeVehicle?.id, station?.id, serviceMode, selectedAddress?.poiId]);

  if (!activeVehicle || !station || !selectedSlot) return <MobileScroll className="app-scroll"><EmptyState icon={<CalendarBlank size={36} />} title="预约信息不完整" copy="请重新选择车辆、站点和时段" action="返回选择" onAction={flow.pop} /></MobileScroll>;
  const selectedSlotExpired = slotHasStarted(selectedSlot, slotNow);
  const validityConflict = quoteError?.code === "INSPECTION_VALIDITY_CONFLICT";
  const manualReview = vehicleManualReviewReason(activeVehicle) || (quote?.pricingEligibility === "manual_review" ? "当前车辆事实无法唯一匹配受控价格方案" : "");
  const valetUnavailable = serviceMode === "valet" && !manualReview && !validityConflict ? valetUnavailableReason(activeVehicle, quote, quoteError, selectedAddress, quoteLoading) : "";
  const pricingDetail = quote ? quotePricingDetail(quote) : null;
  const hasRealValetQuote = serviceMode !== "valet" || (quote?.distanceSource === "tencent_matrix" && quote.serviceable && !valetUnavailable);
  const displayedTotalFen = !validityConflict && !manualReview && hasRealValetQuote ? (quote?.serviceFeeFen ?? station.serviceFeeFen) : null;

  const handleUpload = async (kind: MediaKind, file?: File) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return showToast("单张原图不能超过 10MB");
    setUploading(kind);
    try {
      const previous = media[kind];
      if (previous) await deleteMedia(previous.id);
      const uploaded = await uploadMedia(kind, file);
      setMedia((current) => ({ ...current, [kind]: uploaded }));
      showToast("照片已处理并保存");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "照片上传失败");
    } finally {
      setUploading(null);
    }
  };

  const removeMedia = async (kind: MediaKind) => {
    const current = media[kind];
    if (!current) return;
    try { await deleteMedia(current.id); } catch { /* Keep removal reversible in offline demo mode. */ }
    setMedia((items) => { const next = { ...items }; delete next[kind]; return next; });
  };

  const submit = async () => {
    keyboard.hide();
    if (slotHasStarted(selectedSlot)) return showToast("所选时段已过，请重新选择");
    if (contactName.trim().length < 2) return showToast("请填写联系人姓名");
    if (!/^1\d{10}$/.test(contactPhone)) return showToast("请输入正确的演示手机号");
    if (serviceMode === "valet" && !selectedAddress) return showToast("请从联想结果中选择精确取车地址");
    if (validityConflict) return showToast("用户确认日期与规则估算不一致，请先完成有效期核验");
    if (manualReview) return showToast("该车型暂不支持在线报价，请联系客服");
    if (valetUnavailable) return showToast(valetUnavailable);
    const requiredKinds: MediaKind[] = bookingMediaSlots.map((item) => item.kind);
    const missing = requiredKinds.filter((kind) => !media[kind]);
    if (missing.length) return showToast(`请补充${bookingMediaSlots.find((item) => item.kind === missing[0])?.label}`);
    if (!quote) return showToast("报价仍在计算，请稍候");
    if (serviceMode === "valet" && !quote.serviceable) return showToast("取车地址超出当前上门取送范围");
    setSubmitting(true);
    try {
      const pickupAddress = selectedAddress ? { ...selectedAddress, detail: pickupDetail, note: pickupNote } : undefined;
      const booking = await createBooking({
        vehicleId: activeVehicle.id,
        stationId: station.id,
        slotId: selectedSlot.id,
        contactName: contactName.trim(),
        contactPhone,
        serviceMode,
        pickupAddress,
        mediaIds: Object.values(media).map((item) => item!.id),
        quote: { inspectionFeeFen: quote.inspectionFeeFen, valetFeeFen: quote.valetFeeFen, serviceFeeFen: quote.serviceFeeFen },
        quoteSnapshotId: quote.quoteSnapshotId,
        tripType: serviceMode === "valet" ? "round_trip_same_address" : undefined,
      });
      flow.replace(bookingPaymentScreen(booking.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "预约提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MobileScroll className="app-scroll booking-form-scroll">
      <main className="sub-page confirm-page booking-form-page" data-testid="booking-form">
        <section className="booking-section booking-summary-section">
          <header><small>预约资料</small><h1>确认车辆、站点与时段</h1></header>
          <button onClick={() => setVehicleOpen(true)}><Car size={21} weight="duotone" /><span><small>预约车辆</small><strong>{activeVehicle.plateNumber} · {activeVehicle.seats} 座</strong></span><em>修改</em><CaretRight size={16} /></button>
          <button onClick={flow.pop}><MapPin size={21} weight="duotone" /><span><small>检测站</small><strong>{station.name}</strong></span><em>修改</em><CaretRight size={16} /></button>
          <button onClick={flow.pop}><CalendarCheck size={21} weight="duotone" /><span><small>预约时间</small><strong>{selectedSlot.date} {selectedSlot.startTime}–{selectedSlot.endTime}</strong></span><em>修改</em><CaretRight size={16} /></button>
          {selectedSlotExpired ? <p className="quote-warning" role="alert"><Warning size={16} />所选时段已过，请返回重新选择</p> : null}
        </section>

        <section className="booking-section">
          <div className="booking-section-title"><span><SteeringWheel size={21} /></span><div><h2>预约方式</h2><small>选择车辆如何到达检测站</small></div></div>
          <div className="service-mode-grid">
            <button className={serviceMode === "self_drive" ? "active" : ""} onClick={() => { setServiceMode("self_drive"); setSelectedAddress(null); }}><Car size={24} /><strong>自驾到店</strong><small>按预约时间自行到站</small>{serviceMode === "self_drive" ? <CheckCircle size={18} weight="fill" /> : null}</button>
            <button className={serviceMode === "valet" ? "active" : ""} onClick={() => setServiceMode("valet")}><SteeringWheel size={24} /><strong>上门取送车（往返）</strong><small>原地址取车，检测后送回原地址</small>{serviceMode === "valet" ? <CheckCircle size={18} weight="fill" /> : null}</button>
          </div>
        </section>

        {serviceMode === "valet" ? <section className="booking-section address-section">
          <div className="booking-section-title"><span><MapTrifold size={21} /></span><div><h2>取送车原地址</h2><small>司机从这里取车，检测结束后送回同一地址</small></div><i>必填</i></div>
          <Field label="小区 / 商场 / 写字楼"><KeyboardInput value={addressQuery} placeholder="例如：天津文化中心" onChange={(event) => { setAddressQuery(event.target.value); if (event.target.value !== selectedAddress?.title) setSelectedAddress(null); }} /></Field>
          {suggestions.length ? <div className="address-suggestions">{suggestions.map((item) => <button key={item.poiId} onClick={() => { setSelectedAddress(item); setAddressQuery(item.title); setSuggestions([]); }}><MapPin size={19} /><span><strong>{item.title}</strong><small>{item.address}</small></span><em>{item.district}</em></button>)}</div> : null}
          {addressNotice ? <p className={`address-source ${selectedAddress?.source === "tencent" ? "live" : "demo"}`}><ShieldCheck size={14} />{addressNotice}</p> : null}
          {selectedAddress ? <div className="selected-address"><CheckCircle size={20} weight="fill" /><span><strong>已选择：{selectedAddress.title}</strong><small>{selectedAddress.address}</small><em>{selectedAddress.latitude.toFixed(5)}, {selectedAddress.longitude.toFixed(5)}</em></span></div> : null}
          <Field label="楼栋 / 门牌（选填）"><KeyboardInput value={pickupDetail} placeholder="例如：3 号楼 2 单元" onChange={(event) => setPickupDetail(event.target.value)} /></Field>
          <Field label="取送车备注（选填）"><KeyboardTextarea value={pickupNote} placeholder="例如：地库 B2-156、从北门进入、到达后电话联系" onChange={(event) => setPickupNote(event.target.value.slice(0, 300))} /></Field>
        </section> : null}

        <section className="booking-section media-section">
          <div className="booking-section-title"><span><Camera size={21} /></span><div><h2>车辆与证件照片</h2><small>支持拍照或相册，自动旋转、去除定位信息并压缩</small></div></div>
          <h3>车辆状态 <em>四角与启动后仪表盘均必填</em></h3>
          <div className="media-grid">{bookingMediaSlots.filter((item) => item.vehicle).map((slot) => <MediaUploadSlot key={slot.kind} slot={slot} media={media[slot.kind]} busy={uploading === slot.kind} required onUpload={(file) => void handleUpload(slot.kind, file)} onRemove={() => void removeMedia(slot.kind)} />)}</div>
          <h3>行驶证 <em>两面均必填</em></h3>
          <div className="media-grid license">{bookingMediaSlots.filter((item) => !item.vehicle).map((slot) => <MediaUploadSlot key={slot.kind} slot={slot} media={media[slot.kind]} busy={uploading === slot.kind} required onUpload={(file) => void handleUpload(slot.kind, file)} onRemove={() => void removeMedia(slot.kind)} />)}</div>
          <p className="media-privacy"><ShieldCheck size={15} />单张原图上限 10MB；演示文件存储在本机，订单结束 30 天后清理。</p>
        </section>

        <section className="booking-section contact-card"><div className="booking-section-title"><span><Phone size={21} /></span><div><h2>联系人信息</h2><small>用于站点或取送车司机联系</small></div></div><Field label="联系人"><KeyboardInput value={contactName} onChange={(e) => setContactName(e.target.value.slice(0, 30))} /></Field><Field label="联系电话"><KeyboardInput inputMode="numeric" value={contactPhone} onChange={(e) => setContactPhone(e.target.value.replace(/\D/g, "").slice(0, 11))} /></Field></section>

        <section className="booking-section fee-card booking-fee-card">
          <div><span>年检服务费 <small>{vehiclePricingLabel(activeVehicle)}；能源与座位分别匹配</small></span><strong>{quoteLoading ? "计算中" : validityConflict ? "—" : `¥${formatMoney(quote?.inspectionFeeFen ?? station.serviceFeeFen)}`}</strong></div>
          <div><span>上门取送车（往返） <small>{serviceMode === "valet" ? formatQuoteDistance(quote) : "自驾到店不收取"}</small></span><strong>{serviceMode === "self_drive" ? "¥0" : hasRealValetQuote ? `¥${formatMoney(quote?.valetFeeFen ?? 0)}` : "—"}</strong></div>
          {serviceMode === "valet" && pricingDetail && quote?.distanceSource === "tencent_matrix" ? <section className="valet-pricing-detail" aria-label="上门取送车计价明细">
            <p className="route-proof"><MapTrifold size={17} /><span><strong>腾讯驾车单程 {pricingDetail.oneWayDistanceKm.toFixed(1)} km</strong><small>{quote.driveMinutes == null ? "实时道路距离" : `预计 ${quote.driveMinutes} 分钟`} · 仅单程距离用于计价</small></span></p>
            <div className="pricing-rule-grid"><span><small>起步价</small><strong>¥{formatMoney(pricingDetail.baseFeeFen)}</strong></span><span><small>含距</small><strong>{pricingDetail.includedKm} km</strong></span><span><small>超程整数里程</small><strong>{pricingDetail.extraKm} km</strong></span><span><small>每公里</small><strong>¥{formatMoney(pricingDetail.perKmFen)}</strong></span></div>
            <p className="pricing-formula">完整算式：¥{formatMoney(pricingDetail.baseFeeFen)} + {pricingDetail.extraKm} km × ¥{formatMoney(pricingDetail.perKmFen)}/km = <strong>¥{formatMoney(pricingDetail.valetFeeFen)}</strong></p>
            <p className="return-included"><CheckCircle size={16} weight="fill" /><span><strong>送回原地址，返程不另收费</strong><small>费用为一次完整的取车—送检—原址送回服务；不是只把车送到检测站。</small></span></p>
          </section> : null}
          {quote?.matchedPricePlan || quote?.inspectionItems?.length ? <section className="inspection-quote-detail" aria-label="检验价格方案与项目"><p><ShieldCheck size={16} /><span><strong>{quote.matchedPricePlan?.name || "受控检验价格方案"}</strong><small>{quote.rule?.scope === "station" ? "本站独立价格与取送规则" : "本站价格 · 取送规则继承全局默认"}</small></span></p>{quote.inspectionItems?.length ? <div>{quote.inspectionItems.map((item) => <span key={item}>{INSPECTION_ITEM_LABELS[item] || item}</span>)}</div> : null}{quote.expiresAt ? <small>报价有效至 {formatDateTime(quote.expiresAt)}；提交后保存不可变价格快照</small> : null}</section> : null}
          {manualReview ? <p className="quote-warning" role="alert"><Warning size={16} />该车型暂不支持在线报价，请联系客服</p> : null}
          {valetUnavailable ? <p className="quote-warning" role="alert"><Warning size={16} />{valetUnavailable}</p> : null}
          {validityConflict ? <section className="quote-validity-conflict" data-testid="quote-validity-conflict" role="alert"><Warning size={20} weight="fill" /><div><strong>有效期信息不一致，暂不能预约</strong><p>{quoteError?.message || "用户确认日期与规则估算不一致，请先通过交管12123核验真实检验有效期。"}</p><nav><button type="button" data-testid="quote-conflict-back-query" onClick={() => flow.push(inspectionScreen())}>回年检查询</button><button type="button" data-testid="quote-conflict-official" onClick={() => flow.push(serviceScreen("官方状态核验", "请通过交管12123核验真实检验有效期和车辆登记记录；核验一致后再返回预约。"))}>通过交管12123核验</button></nav></div></section> : null}
          <footer><span>应付合计<small>{validityConflict ? "完成有效期核验后重新获取报价" : displayedTotalFen == null ? "取得腾讯真实路线后才能计价" : "演示价格，不发生真实支付"}</small></span><strong>{displayedTotalFen == null ? "—" : `¥${formatMoney(displayedTotalFen)}`}</strong></footer>
        </section>

        <section className="booking-doc-tip"><ClipboardText size={24} weight="duotone" /><div><h2>年检所需资料</h2><p>行驶证（原件）、身份证（原件）</p><strong>请确认您的爱车违章均已处理，爱车交强险处于生效状态。</strong></div></section>
        <label className="agreement-row"><input type="checkbox" defaultChecked /><span>我已阅读并同意演示预约说明，知悉本页面不会发生真实支付。</span></label>
        <div className="booking-submit-bar"><span><small>合计</small><strong>{displayedTotalFen == null ? "—" : `¥${formatMoney(displayedTotalFen)}`}</strong></span><button data-testid="booking-submit" disabled={selectedSlotExpired || validityConflict || submitting || quoteLoading || uploading !== null || (!manualReview && !valetUnavailable && displayedTotalFen == null)} onClick={() => manualReview ? flow.push(serviceScreen("年检专属客服", "该车型暂不支持在线报价，客服可协助核对车型、使用性质与适用服务。")) : valetUnavailable ? setServiceMode("self_drive") : void submit()}>{submitting ? <CircleNotch className="spin" size={19} /> : manualReview ? <Headset size={20} weight="duotone" /> : <CalendarCheck size={20} weight="duotone" />}{submitting ? "提交中" : selectedSlotExpired ? "时段已过，请重选" : validityConflict ? "请先核验有效期" : manualReview ? "联系客服" : valetUnavailable ? "改选自驾到站" : "提交预约"}</button></div>
      </main>
      <BottomSheet open={vehicleOpen} onOpenChange={setVehicleOpen} title="选择预约车辆" description="能源、座位数和面包车属性会分别匹配价格方案。"><div className="booking-vehicle-sheet">{vehicles.map((vehicle) => <button className={vehicle.id === activeVehicle.id ? "active" : ""} key={vehicle.id} onClick={() => { setActiveVehicleId(vehicle.id); setVehicleOpen(false); }}><span><strong>{vehicle.plateNumber}</strong><small>{POWERTRAIN_LABELS[vehiclePowertrain(vehicle)]} · {vehicleSeats(vehicle)} 座{vehicleIsVan(vehicle) ? " · 面包车" : ""}{vehicleManualReviewReason(vehicle) ? " · 暂不支持在线报价" : ""}</small></span>{vehicle.id === activeVehicle.id ? <CheckCircle size={20} weight="fill" /> : <CaretRight size={18} />}</button>)}</div></BottomSheet>
    </MobileScroll>
  );
}

function MediaUploadSlot({ slot, media, busy, required, onUpload, onRemove }: { slot: { kind: MediaKind; label: string; short: string }; media?: BookingMedia; busy: boolean; required: boolean; onUpload: (file?: File) => void; onRemove: () => void }) {
  return <div className={`media-upload-slot ${media ? "complete" : ""}`} data-testid={`media-${slot.kind}`}>
    {media ? <><img src={media.url} alt={`${slot.label}预览`} /><button className="media-remove" aria-label={`删除${slot.label}`} onClick={onRemove}><Trash size={15} /></button><label className="media-retake">重拍<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" onChange={(event) => onUpload(event.target.files?.[0])} /></label></> : <label><span>{busy ? <CircleNotch className="spin" size={24} /> : <Camera size={25} weight="duotone" />}</span><strong>{slot.short}</strong><small>{required ? "必填" : "选填"}</small><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" disabled={busy} onChange={(event) => onUpload(event.target.files?.[0])} /></label>}
  </div>;
}

function BookingPaymentScreen({ bookingId }: { bookingId: string }) {
  const flow = useFlow();
  const { fetchBooking, payBooking, showToast } = useMvp();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [idempotencyKey] = useState(() => globalThis.crypto?.randomUUID?.() || `mock-${bookingId}-${Date.now()}`);
  useEffect(() => { void fetchBooking(bookingId).then(setBooking).catch((reason: Error) => setError(reason.message)); }, [bookingId]);
  const pay = async () => {
    if (!booking || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await payBooking(booking.id, idempotencyKey);
      setBooking(updated);
      showToast("模拟支付成功，预约已自动确认");
      flow.replace(orderDetailScreen(updated.id));
    } catch (reason) {
      const requestError = reason as Error & { code?: string };
      const message = requestError?.code === "TENCENT_QUOTA_EXCEEDED"
        ? "今日腾讯路线额度已用完，暂不能使用上门取送；可改选自驾到站"
        : requestError?.code === "QUOTE_EXPIRED"
          ? "报价已过期，请取消当前待支付订单后重新预约，以获取最新价格"
        : reason instanceof Error ? reason.message : "模拟支付失败，请重试";
      setError(message);
    } finally {
      setBusy(false);
    }
  };
  if (!booking) return <MobileScroll className="app-scroll"><main className="payment-page payment-loading"><CircleNotch className="spin" size={30} /><p>{error || "正在读取待支付订单"}</p></main></MobileScroll>;
  const totalFeeFen = booking.priceBreakdown?.totalFeeFen ?? booking.serviceFeeFen;
  const amountDueFen = booking.amountDueFen ?? totalFeeFen;
  const legacyValet = bookingUsesLegacyValet(booking);
  const paid = booking.paymentStatus === "paid" || booking.status === "paid_pending_confirmation";
  return (
    <MobileScroll className="app-scroll">
      <main className="payment-page" data-testid="mock-payment-page">
        <section className="payment-hero"><span><Receipt size={34} weight="duotone" /></span><small>{paid ? "模拟支付已完成" : booking.paidFen ? "订单待补款" : "订单待支付"}</small><h1>{paid ? "已支付，预约已确认" : `¥${formatMoney(amountDueFen)}`}</h1><p>{paid ? "支付结果已记录，预约已自动进入线下履约队列。" : "确认后调用本地 mock 支付接口，仅验证订单流程。"}</p></section>
        <section className="payment-safety"><ShieldCheck size={22} weight="fill" /><span><strong>模拟支付不会扣款</strong><small>不会唤起微信、支付宝或银行卡，也不会产生真实资金交易。</small></span></section>
        <section className="payment-order-card"><div><span>预约号</span><strong>{booking.appointmentNumber || booking.id.toUpperCase().slice(-12)}</strong></div><div><span>检测站</span><strong>{booking.station?.name || "机动车检测站"}</strong></div><div><span>预约时间</span><strong>{booking.appointmentDate} {booking.startTime}–{booking.endTime}</strong></div><div><span>年检服务费</span><strong>¥{formatMoney(booking.priceBreakdown?.inspectionFeeFen ?? booking.inspectionFeeFen ?? totalFeeFen)}</strong></div><div><span>{legacyValet ? "历史单程服务费" : "上门取送车（往返）"}</span><strong>¥{formatMoney(booking.priceBreakdown?.valetFeeFen ?? booking.valetFeeFen ?? 0)}</strong></div><div><span>订单累计应收</span><strong>¥{formatMoney(booking.chargedFen ?? totalFeeFen)}</strong></div>{booking.paidFen ? <div><span>已模拟支付</span><strong>¥{formatMoney(booking.paidFen)}</strong></div> : null}<footer><span>本次待付</span><strong>¥{formatMoney(amountDueFen)}</strong></footer></section>
        {error ? <p className="payment-error" role="alert"><Warning size={17} />{error}</p> : null}
        <button className="primary-button payment-submit" disabled={busy} onClick={() => paid ? flow.replace(orderDetailScreen(booking.id)) : void pay()}>{busy ? <CircleNotch className="spin" size={20} /> : paid ? <CheckCircle size={20} weight="fill" /> : <Receipt size={20} />}{busy ? "正在模拟支付" : paid ? "查看履约进度" : `确认模拟支付 ¥${formatMoney(amountDueFen)}`}</button>
        <button className="text-button" onClick={() => flow.replace(orderDetailScreen(booking.id))}>{paid ? "查看订单" : "稍后支付，先查看订单"}</button>
      </main>
    </MobileScroll>
  );
}

function WashBookingScreen({ repeatOrder }: { repeatOrder?: WashOrder }) {
  const flow = useFlow();
  const { activeVehicle, vehicles, setActiveVehicleId, bookings, fetchLocationSuggestions, showToast } = useMvp();
  const { washStores, washOrders, washLoading, fetchWashOffers, fetchWashSlots, quoteWash, createWashOrder } = useWash();
  const category = washVehicleCategoryFor(activeVehicle);
  const recentContact = washOrders.find((order) => order.contactPhone)?.contactName
    ? washOrders.find((order) => order.contactPhone)
    : bookings.find((booking) => booking.contactPhone);
  const initialStoreId = repeatOrder?.storeId || washStores[0]?.id || fallbackWashStores[0].id;
  const [storeId, setStoreId] = useState(initialStoreId);
  const [offers, setOffers] = useState<WashOffer[]>([]);
  const [packageId, setPackageId] = useState(repeatOrder?.packageId || "wash-package-standard");
  const [selectedDate, setSelectedDate] = useState(DEMO_TODAY);
  const [slots, setSlots] = useState<WashSlot[]>([]);
  const [slotId, setSlotId] = useState("");
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactName, setContactName] = useState(recentContact?.contactName || "张先生");
  const [contactPhone, setContactPhone] = useState(recentContact?.contactPhone?.replace(/\*/g, "") || "13800138000");
  const [loadingOffers, setLoadingOffers] = useState(false);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [serviceMode, setServiceMode] = useState<ServiceMode>(repeatOrder?.serviceMode === "valet" ? "valet" : "self_drive");
  const [addressQuery, setAddressQuery] = useState(repeatOrder?.pickupAddress?.title || "");
  const [suggestions, setSuggestions] = useState<PickupAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<PickupAddress | null>(repeatOrder?.pickupAddress || null);
  const [addressNotice, setAddressNotice] = useState(repeatOrder?.pickupAddress ? "已带入上次预约的取车地址，可重新搜索修改" : "");
  const [pickupDetail, setPickupDetail] = useState(repeatOrder?.pickupAddress?.detail || "");
  const [pickupNote, setPickupNote] = useState(repeatOrder?.pickupAddress?.note || "");
  const [valetQuote, setValetQuote] = useState<WashQuote | null>(null);
  const [valetQuoteError, setValetQuoteError] = useState<{ code?: string; message: string; fields?: Record<string, unknown> } | null>(null);
  const [valetQuoteLoading, setValetQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const slotNow = useSlotClock();
  const selectedStore = washStores.find((store) => store.id === storeId) || fallbackWashStores.find((store) => store.id === storeId) || fallbackWashStores[0];
  const selectedOffer = offers.find((offer) => offer.packageId === packageId) || offers[0];
  const selectedSlotCandidate = slots.find((slot) => slot.id === slotId);
  const selectedSlotExpired = Boolean(selectedSlotCandidate && slotHasStarted(selectedSlotCandidate, slotNow));
  const selectedSlot = selectedSlotCandidate?.isOpen && selectedSlotCandidate.remaining > 0 && !selectedSlotExpired ? selectedSlotCandidate : undefined;
  const slotToday = todayIsoInShanghai(slotNow);
  const dateOptions = useMemo(() => Array.from({ length: 5 }, (_, index) => addDaysIso(slotToday, index)), [slotToday]);

  useEffect(() => {
    if (washStores.length && !washStores.some((store) => store.id === storeId)) setStoreId(washStores[0].id);
  }, [washStores, storeId]);

  useEffect(() => {
    if (selectedDate < slotToday) setSelectedDate(slotToday);
    if (selectedSlotExpired) setSlotId("");
  }, [selectedDate, selectedSlotExpired, slotToday]);

  useEffect(() => {
    let cancelled = false;
    setOffers([]);
    setSlots([]);
    setSlotId("");
    setLoadingOffers(true);
    void fetchWashOffers(storeId, category).then((next) => {
      if (cancelled) return;
      const available = next.filter((offer) => offer.isAvailable);
      setOffers(available);
      setPackageId((current) => available.some((offer) => offer.packageId === current) ? current : available[0]?.packageId || "");
    }).catch((error) => showToast(error instanceof Error ? error.message : "套餐加载失败")).finally(() => !cancelled && setLoadingOffers(false));
    return () => { cancelled = true; };
  }, [storeId, category]);

  useEffect(() => {
    if (!packageId) return;
    let cancelled = false;
    setLoadingSlots(true);
    void fetchWashSlots(storeId, selectedDate, packageId).then((next) => {
      if (cancelled) return;
      const requestNow = new Date();
      const isBookable = (slot: WashSlot) => slot.isOpen && slot.remaining > 0 && !slotHasStarted(slot, requestNow);
      setSlots(next);
      setSlotId((current) => next.some((slot) => slot.id === current && isBookable(slot)) ? current : next.find(isBookable)?.id || "");
      if (!next.some(isBookable) && selectedDate === todayIsoInShanghai(requestNow)) setSelectedDate(addDaysIso(selectedDate, 1));
    }).catch((error) => showToast(error instanceof Error ? error.message : "时段加载失败")).finally(() => !cancelled && setLoadingSlots(false));
    return () => { cancelled = true; };
  }, [storeId, selectedDate, packageId, category]);

  useEffect(() => {
    if (serviceMode !== "valet" || addressQuery.trim().length < 2 || addressQuery === selectedAddress?.title) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchLocationSuggestions(addressQuery.trim())
        .then((result) => { setSuggestions(result.data); setAddressNotice(result.notice); })
        .catch(() => { setSuggestions([]); setAddressNotice("地址联想暂不可用，请稍后重试"); });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [addressQuery, serviceMode, selectedAddress?.title]);

  useEffect(() => {
    if (serviceMode !== "valet" || !activeVehicle || !selectedOffer || !selectedSlot || !selectedAddress) {
      setValetQuote(null);
      setValetQuoteError(null);
      setValetQuoteLoading(false);
      return;
    }
    let cancelled = false;
    setValetQuote(null);
    setValetQuoteError(null);
    setValetQuoteLoading(true);
    void quoteWash({
      vehicleId: activeVehicle.id,
      storeId,
      packageId: selectedOffer.packageId,
      slotId: selectedSlot.id,
      vehicleCategory: category,
      serviceMode: "valet",
      tripType: "round_trip_same_address",
      pickupAddress: selectedAddress,
    }).then((next) => {
      if (!cancelled) setValetQuote(next);
    }).catch((error) => {
      if (cancelled) return;
      const requestError = error as Error & { code?: string; fields?: Record<string, unknown> };
      setValetQuoteError({ code: requestError.code, fields: requestError.fields, message: requestError.message || "代驾路线报价失败" });
    }).finally(() => { if (!cancelled) setValetQuoteLoading(false); });
    return () => { cancelled = true; };
  }, [activeVehicle?.id, storeId, selectedOffer?.packageId, selectedSlot?.id, category, serviceMode, selectedAddress?.poiId, selectedAddress?.latitude, selectedAddress?.longitude]);

  const valetUnavailable = serviceMode === "valet"
    ? washValetUnavailableReason(valetQuote, valetQuoteError, selectedAddress, valetQuoteLoading)
    : "";
  const hasValetQuote = serviceMode === "valet"
    && Boolean(valetQuote?.serviceable)
    && valetQuote?.distanceSource === "tencent_matrix"
    && !valetUnavailable;
  const displayedTotalFen = serviceMode === "self_drive"
    ? selectedOffer?.salePriceFen ?? null
    : hasValetQuote ? valetQuote?.totalFeeFen ?? null : null;

  const submitWithContact = async (name: string, phone: string) => {
    if (!activeVehicle) {
      showToast("请先添加服务车辆");
      flow.push(vehicleFormScreen());
      return;
    }
    if (!selectedOffer || !selectedSlot || slotHasStarted(selectedSlot)) {
      showToast(selectedSlotExpired ? "所选时段已过，请重新选择" : "请选择可预约套餐和时段");
      return;
    }
    if (serviceMode === "valet" && !selectedAddress) {
      setAddressOpen(true);
      return;
    }
    if (serviceMode === "valet" && valetUnavailable) {
      showToast(valetUnavailable);
      return;
    }
    if (serviceMode === "valet" && !hasValetQuote) {
      showToast(valetQuoteLoading ? "正在计算真实驾车路线，请稍候" : "取得真实路线报价后才能预约代驾");
      return;
    }
    if (!name.trim() || !/^1\d{10}$/.test(phone)) {
      setContactOpen(true);
      return;
    }
    setSubmitting(true);
    try {
      const pickupAddress = selectedAddress ? { ...selectedAddress, detail: pickupDetail.trim() || undefined, note: pickupNote.trim() || undefined } : undefined;
      const quote = await quoteWash({
        vehicleId: activeVehicle.id,
        storeId,
        packageId: selectedOffer.packageId,
        slotId: selectedSlot.id,
        vehicleCategory: category,
        serviceMode,
        ...(serviceMode === "valet" ? { tripType: "round_trip_same_address" as const, pickupAddress } : {}),
      });
      if (serviceMode === "valet" && (!quote.serviceable || quote.distanceSource !== "tencent_matrix")) {
        throw new Error("未取得真实驾车路线，代驾暂不能在线预约");
      }
      const order = await createWashOrder({ quote, contactName: name.trim(), contactPhone: phone });
      setContactOpen(false);
      flow.replace(washPaymentScreen(order.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "预约失败，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MobileScroll className="app-scroll wash-scroll">
      <main className="wash-booking-page" data-testid="wash-booking-page">
        <button className="wash-vehicle-row" data-testid="wash-vehicle-selector" onClick={() => setVehicleOpen(true)}>
          <span className="wash-row-icon"><Car size={22} weight="duotone" /></span>
          <span><small>服务车辆</small><strong>{activeVehicle?.plateNumber || "请选择车辆"}</strong><em>{activeVehicle ? `${washVehicleCategoryLabel(category)}价类` : "选择后匹配套餐价格"}</em></span>
          <CaretRight size={18} />
        </button>
        {activeVehicle?.washVehicleCategoryLegacy ? <p className="wash-booking-category-warning" role="status"><Warning size={14} />历史 SUV/MPV 合并档已按 SUV 兼容，可到车辆管理确认独立价类。</p> : null}

        <section className="wash-booking-intro">
          <div><h1>今天，把车洗干净</h1><p>{serviceMode === "valet" ? "上门取送 · 往返已含 · 真实路线计价" : "自驾到店 · 透明价格 · 快速洁净"}</p></div>
        </section>

        <section className="wash-section wash-service-mode-section">
          <header><span><small /><h2>选择服务方式</h2></span><em>{serviceMode === "valet" ? "往返取送" : "到店服务"}</em></header>
          <div className="wash-service-mode" role="tablist" aria-label="洗车服务方式">
            <button role="tab" aria-selected={serviceMode === "self_drive"} data-testid="wash-mode-self-drive" className={serviceMode === "self_drive" ? "active" : ""} onClick={() => { setServiceMode("self_drive"); setValetQuote(null); setValetQuoteError(null); }}><Car size={20} weight="duotone" /><span><strong>自驾到店</strong><small>按服务时段到店</small></span>{serviceMode === "self_drive" ? <CheckCircle size={16} weight="fill" /> : null}</button>
            <button role="tab" aria-selected={serviceMode === "valet"} data-testid="wash-mode-valet" className={serviceMode === "valet" ? "active" : ""} onClick={() => { setServiceMode("valet"); setValetQuoteError(null); setAddressOpen(!selectedAddress); }}><SteeringWheel size={20} weight="duotone" /><span><strong>代驾取送</strong><small>原址往返已包含</small></span>{serviceMode === "valet" ? <CheckCircle size={16} weight="fill" /> : null}</button>
          </div>
          {serviceMode === "valet" ? <div className="wash-valet-compact" data-testid="wash-valet-panel">
            <button className="wash-pickup-row" data-testid="wash-pickup-selector" onClick={() => setAddressOpen(true)}><span><MapPin size={20} weight="duotone" /></span><div><small>取送车地址</small><strong>{selectedAddress?.title || "搜索并选择取车地址"}</strong><em>{selectedAddress ? `${selectedAddress.address}${pickupDetail ? ` · ${pickupDetail}` : ""}` : "按真实驾车路线计算单程距离与代驾费"}</em></div><b>{selectedAddress ? "修改" : "选择"}</b><CaretRight size={15} /></button>
            {valetQuoteLoading ? <p className="wash-route-state loading"><CircleNotch className="spin" size={15} />正在计算到店真实驾车路线</p> : null}
            {hasValetQuote && valetQuote ? <div className="wash-route-quote" data-testid="wash-valet-quote"><MapTrifold size={20} weight="duotone" /><span><strong>单程 {Number(valetQuote.oneWayDistanceKm || 0).toFixed(1)} km{valetQuote.driveMinutes == null ? "" : ` · 约 ${valetQuote.driveMinutes} 分钟`}</strong><small>返程已包含 · {valetQuote.valetRule?.maxRadiusKm == null ? "服务半径不限" : `服务半径 ${valetQuote.valetRule.maxRadiusKm} km`}</small></span><b>+¥{formatMoney(valetQuote.valetFeeFen)}</b></div> : null}
            {!valetQuoteLoading && selectedAddress && valetUnavailable ? <p className="wash-route-state error" role="alert" data-testid="wash-valet-unavailable"><Warning size={15} />{valetUnavailable}<button onClick={() => setAddressOpen(true)}>修改地址</button></p> : null}
            {!selectedAddress ? <p className="wash-route-state"><Info size={15} />选择精确地址后展示服务半径、单程距离与代驾费</p> : null}
          </div> : null}
        </section>

        <section className="wash-section wash-package-section">
          <header><span><small /><h2>选择洗车套餐</h2></span>{loadingOffers ? <CircleNotch className="spin" size={18} /> : <em>{washVehicleCategoryLabel(category)}价格</em>}</header>
          <div className="wash-package-grid">
            {offers.map((offer, index) => {
              const selected = offer.packageId === selectedOffer?.packageId;
              return <button className={selected ? "active" : ""} key={offer.packageId} data-testid={`wash-package-${offer.package.code || index}`} onClick={() => setPackageId(offer.packageId)}>
                {index === 1 ? <i>推荐</i> : null}
                <span>{index === 0 ? <Drop size={25} weight="duotone" /> : <Sparkle size={25} weight="duotone" />}</span>
                <div><strong>{offer.package.name}</strong><small>{offer.package.subtitle || (index === 0 ? "日常快速焕新" : "内外深度清洁")}</small></div>
                <p><b>¥{formatMoney(offer.salePriceFen)}</b>{offer.listPriceFen > offer.salePriceFen ? <del>¥{formatMoney(offer.listPriceFen)}</del> : null}</p>
                <em>{offer.package.durationMinutes} 分钟 · {offer.package.serviceItems.slice(0, 2).join(" + ")}</em>
                <span className="wash-package-check">{selected ? <Check size={13} weight="bold" /> : null}</span>
              </button>;
            })}
          </div>
        </section>

        <section className="wash-section wash-store-section">
          <header><span><small /><h2>推荐服务门店</h2></span><button onClick={() => setStoreOpen(true)}>更换门店 <CaretRight size={14} /></button></header>
          <button className="wash-store-card" data-testid="wash-store-selector" onClick={() => setStoreOpen(true)}>
            <span className="wash-store-pin"><Storefront size={23} weight="duotone" /></span>
            <span><small><b>推荐</b>{selectedStore.distanceKm == null ? "天津演示门店" : `距你约 ${selectedStore.distanceKm} km`}</small><strong>{selectedStore.name}</strong><em>{selectedStore.district} · {selectedStore.openHours || "营业时间请电话确认"}</em></span>
            <CaretRight size={18} />
          </button>
        </section>

        <section className="wash-section wash-time-section">
          <header><span><small /><h2>选择洗车服务时段</h2></span><em>{loadingSlots ? "正在更新" : serviceMode === "valet" ? "取车时间线下确认" : "到店即可服务"}</em></header>
          <div className="wash-date-strip" aria-label="选择日期">
            {dateOptions.map((date, index) => <button className={date === selectedDate ? "active" : ""} key={date} onClick={() => setSelectedDate(date)}><small>{index === 0 ? "今天" : index === 1 ? "明天" : formatChineseWeekday(date)}</small><strong>{formatDateLabel(date).replace("月 ", "/").replace(" 日", "")}</strong></button>)}
          </div>
          <div className="wash-slot-strip" aria-label="选择时段">
            {slots.length ? slots.map((slot) => { const started = slotHasStarted(slot, slotNow); return <button className={slot.id === selectedSlot?.id ? "active" : ""} disabled={started || !slot.isOpen || slot.remaining <= 0} key={slot.id} data-testid={`wash-slot-${slot.startTime}`} onClick={() => setSlotId(slot.id)}><strong>{slot.startTime}</strong><small>{started ? "已过时段" : slot.remaining <= 0 ? "已约满" : slot.remaining <= 1 ? "仅剩 1 位" : `${slot.startTime}–${slot.endTime}`}</small></button>; }) : <p>当日暂无可约时段，请切换日期</p>}
          </div>
        </section>

        <footer className="wash-booking-footer">
          <span><small>合计</small><strong><i>¥</i>{displayedTotalFen == null ? "--" : formatMoney(displayedTotalFen)}</strong><em>{serviceMode === "valet" && valetQuote ? `洗车 ¥${formatMoney(valetQuote.washFeeFen)} + 代驾 ¥${formatMoney(valetQuote.valetFeeFen)}` : "自驾到店，无隐藏费用"}</em></span>
          <button disabled={submitting || washLoading || !selectedSlot || (serviceMode === "valet" && !hasValetQuote)} data-testid="wash-confirm-booking" onClick={() => void submitWithContact(contactName, contactPhone)}>{submitting ? <CircleNotch className="spin" size={19} /> : null}{submitting ? "正在锁定" : selectedSlotExpired ? "时段已过，请重选" : !selectedSlot ? "请选择可约时段" : serviceMode === "valet" && !selectedAddress ? "先选取车地址" : serviceMode === "valet" && valetQuoteLoading ? "正在计算路线" : serviceMode === "valet" && !hasValetQuote ? "代驾暂不可约" : "确认预约"}</button>
        </footer>
      </main>

      <BottomSheet open={vehicleOpen} onOpenChange={setVehicleOpen} title="选择服务车辆" description="车型价类会影响套餐价格。">
        <div className="wash-sheet-list">{vehicles.map((vehicle) => <button data-testid={`wash-vehicle-option-${vehicle.id}`} className={vehicle.id === activeVehicle?.id ? "active" : ""} key={vehicle.id} onClick={() => { setActiveVehicleId(vehicle.id); setVehicleOpen(false); }}><span><strong>{vehicle.plateNumber}</strong><small>{washVehicleCategoryLabel(washVehicleCategoryFor(vehicle))}价类{vehicle.washVehicleCategoryLegacy ? " · 历史档按 SUV 兼容" : ""}</small></span>{vehicle.id === activeVehicle?.id ? <CheckCircle size={20} weight="fill" /> : <CaretRight size={18} />}</button>)}<button onClick={() => flow.push(vehicleFormScreen())}><span><strong>添加车辆</strong><small>完善车辆档案后匹配对应档位价格</small></span><Plus size={20} /></button></div>
      </BottomSheet>

      <BottomSheet open={storeOpen} onOpenChange={setStoreOpen} title="选择洗车门店" description="以下均为天津合成演示门店，不代表真实合作关系。">
        <div className="wash-sheet-list wash-store-sheet">{washStores.map((store) => <button className={store.id === storeId ? "active" : ""} key={store.id} onClick={() => { setStoreId(store.id); setStoreOpen(false); }}><span><strong>{store.name}</strong><small>{store.district} · {store.address}</small><em>{store.openHours || "营业时间请电话确认"}{store.distanceKm == null ? "" : ` · ${store.distanceKm} km`}</em></span>{store.id === storeId ? <CheckCircle size={20} weight="fill" /> : <CaretRight size={18} />}</button>)}</div>
      </BottomSheet>

      <BottomSheet open={addressOpen} onOpenChange={setAddressOpen} title="选择取送车地址" description="搜索精确地点；司机取车并在洗车完成后送回同一地址。">
        <div className="wash-address-sheet">
          <Field label="小区 / 商场 / 写字楼"><KeyboardInput value={addressQuery} placeholder="例如：天津文化中心" onChange={(event) => { setAddressQuery(event.target.value); if (event.target.value !== selectedAddress?.title) { setSelectedAddress(null); setValetQuote(null); setValetQuoteError(null); } }} /></Field>
          {suggestions.length ? <div className="address-suggestions wash-address-suggestions">{suggestions.map((item) => <button key={item.poiId} onClick={() => { setSelectedAddress(item); setAddressQuery(item.title); setPickupDetail(""); setPickupNote(""); setValetQuote(null); setValetQuoteError(null); setSuggestions([]); }}><MapPin size={19} /><span><strong>{item.title}</strong><small>{item.address}</small></span><em>{item.district}</em></button>)}</div> : null}
          {addressNotice ? <p className={`address-source ${selectedAddress?.source === "tencent" ? "live" : "demo"}`}><ShieldCheck size={14} />{addressNotice}</p> : null}
          {selectedAddress ? <><div className="selected-address"><CheckCircle size={20} weight="fill" /><span><strong>已选择：{selectedAddress.title}</strong><small>{selectedAddress.address}</small><em>{selectedAddress.latitude.toFixed(5)}, {selectedAddress.longitude.toFixed(5)}</em></span></div><Field label="楼栋 / 门牌（选填）"><KeyboardInput value={pickupDetail} placeholder="例如：3 号楼 2 单元" onChange={(event) => setPickupDetail(event.target.value.slice(0, 100))} /></Field><Field label="取送车备注（选填）"><KeyboardTextarea value={pickupNote} placeholder="例如：地库 B2-156，到达后电话联系" onChange={(event) => setPickupNote(event.target.value.slice(0, 300))} /></Field></> : <p className="wash-address-hint"><MapTrifold size={18} />请从联想结果中选择带坐标的精确地址，系统才能计算真实驾车路线。</p>}
          <button className="primary-button" disabled={!selectedAddress} data-testid="wash-pickup-confirm" onClick={() => setAddressOpen(false)}>确认取送车地址</button>
        </div>
      </BottomSheet>

      <BottomSheet open={contactOpen} onOpenChange={setContactOpen} title="补充联系人" description="门店可能在预约有变动时联系你。">
        <div className="wash-contact-form"><Field label="联系人"><KeyboardInput value={contactName} placeholder="请输入姓名" onChange={(event) => setContactName(event.target.value.slice(0, 30))} /></Field><Field label="联系电话"><KeyboardInput inputMode="numeric" value={contactPhone} placeholder="请输入 11 位手机号" onChange={(event) => setContactPhone(event.target.value.replace(/\D/g, "").slice(0, 11))} /></Field><button className="primary-button" disabled={!contactName.trim() || !/^1\d{10}$/.test(contactPhone) || submitting} onClick={() => void submitWithContact(contactName, contactPhone)}>保存并继续预约</button></div>
      </BottomSheet>
    </MobileScroll>
  );
}

function WashRedemptionCode({ order, onCopy }: { order: WashOrder; onCopy: () => void }) {
  const code = order.redemptionCode || "------";
  const formatted = /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return (
    <section className="wash-code-card" data-testid="wash-redemption-code">
      <span className="wash-code-orbit"><SealCheck size={27} weight="duotone" /></span>
      <small>{order.serviceMode === "valet" ? "取送核销码" : "到店核销码"}</small>
      <strong>{formatted}</strong>
      <button onClick={onCopy}><Copy size={16} />复制核销码</button>
      <p>{order.serviceMode === "valet" ? "车辆交接时向平台司机出示，运营线下完成门店核销；仅限使用一次。" : "到店后向店主出示此码，仅限本订单使用一次。"}</p>
    </section>
  );
}

function WashOrderSummary({ order }: { order: WashOrder }) {
  return (
    <section className="wash-order-summary">
      <div><Storefront size={20} weight="duotone" /><span><small>服务门店</small><strong>{order.store?.name || "洗车演示门店"}</strong><em>{order.store?.address || "天津市演示地址"}</em></span></div>
      <div><Sparkle size={20} weight="duotone" /><span><small>洗车套餐</small><strong>{order.package?.name || "洗车套餐"}</strong><em>{order.vehicle?.plateNumber || "服务车辆"} · {washVehicleCategoryLabel(order.vehicleCategory || washVehicleCategoryFor(order.vehicle))}价类 · 洗车费 ¥{formatMoney(order.washFeeFen)}</em></span></div>
      <div><CalendarBlank size={20} weight="duotone" /><span><small>洗车服务时段</small><strong>{order.appointmentDate} {order.startTime}–{order.endTime}</strong><em>{order.serviceMode === "valet" ? "具体取车时间由平台线下联系确认" : "请按预约时段到店"}</em></span></div>
      <div><SteeringWheel size={20} weight="duotone" /><span><small>服务方式</small><strong>{order.serviceMode === "valet" ? "代驾取送（往返）" : "自驾到店"}</strong><em>{order.serviceMode === "valet" ? `${order.pickupAddress?.title || "取送地址以订单为准"}${order.pickupAddress?.detail ? ` · ${order.pickupAddress.detail}` : ""}` : "车辆由车主自行送达门店"}</em></span></div>
      {order.serviceMode === "valet" ? <div className="wash-summary-route"><MapTrifold size={20} weight="duotone" /><span><small>取送路线</small><strong>单程 {Number(order.oneWayDistanceKm || 0).toFixed(1)} km{order.driveMinutes == null ? "" : ` · 约 ${order.driveMinutes} 分钟`}</strong><em>洗车完成后送回原地址，返程已包含</em></span></div> : null}
    </section>
  );
}

function WashPaymentScreen({ orderId }: { orderId: string }) {
  const flow = useFlow();
  const { showToast } = useMvp();
  const { fetchWashOrder, payWashOrder } = useWash();
  const [order, setOrder] = useState<WashOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void fetchWashOrder(orderId).then(setOrder).catch((nextError) => setError(nextError instanceof Error ? nextError.message : "订单读取失败")); }, [orderId]);
  const copyCode = () => {
    if (!order?.redemptionCode) return;
    void navigator.clipboard?.writeText(order.redemptionCode);
    showToast("核销码已复制");
  };
  const pay = async () => {
    setBusy(true);
    setError("");
    try {
      const updated = await payWashOrder(orderId);
      setOrder(updated);
      showToast("模拟支付成功，核销码已生成");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "支付失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  if (!order) return <MobileScroll className="app-scroll"><main className="wash-state-loading"><CircleNotch className="spin" size={30} /><p>{error || "正在读取洗车订单"}</p></main></MobileScroll>;
  if (order.status === "awaiting_redemption") return (
    <MobileScroll className="app-scroll wash-scroll">
      <main className="wash-success-page" data-testid="wash-payment-success">
        <header className="wash-success-heading"><span><CheckCircle size={34} weight="fill" /></span><small>模拟支付成功</small><h1>预约已生效</h1><p>{order.serviceMode === "valet" ? "取送核销码已生成，等待平台线下联系车辆交接。" : "核销码已生成，到店后直接向店主出示。"}</p></header>
        <WashRedemptionCode order={order} onCopy={copyCode} />
        <WashOrderSummary order={order} />
        <div className="wash-quick-actions"><button onClick={() => order.store?.phone ? window.location.href = `tel:${order.store.phone}` : showToast("门店电话暂未配置")}><Phone size={19} />联系门店</button>{order.serviceMode === "valet" ? <button onClick={() => showToast(order.pickupAddress ? `${order.pickupAddress.title} · ${order.pickupAddress.address}` : "取送地址以订单记录为准")}><MapPin size={19} />取车地址</button> : <button onClick={() => showToast("已为你准备门店导航信息")}><NavigationArrow size={19} />导航到店</button>}</div>
        <button className="primary-button" onClick={() => flow.replace(washOrderDetailScreen(order.id))}>查看洗车订单</button>
        <button className="text-button" onClick={() => flow.replace(homeScreen())}>返回首页</button>
      </main>
    </MobileScroll>
  );
  if (order.status !== "pending_payment") return <WashOrderDetailScreen orderId={order.id} />;
  return (
    <MobileScroll className="app-scroll wash-scroll">
      <main className="wash-payment-page" data-testid="wash-mock-payment-page">
        <section className="wash-payment-amount"><span><Receipt size={30} weight="duotone" /></span><small>本次模拟支付</small><h1>¥{formatMoney(washOrderTotalFen(order))}</h1><p>{order.serviceMode === "valet" ? `洗车 ¥${formatMoney(order.washFeeFen)} + 代驾往返 ¥${formatMoney(order.valetFeeFen)}` : "确认后不会产生真实扣款"}</p></section>
        <section className="payment-safety"><ShieldCheck size={22} weight="fill" /><span><strong>仅用于演示预约闭环</strong><small>不会唤起微信支付、银行卡或任何真实资金渠道。</small></span></section>
        <WashOrderSummary order={order} />
        <section className="wash-payment-code-note"><Drop size={20} weight="duotone" /><span><strong>支付后立即获得六位{order.serviceMode === "valet" ? "取送" : "到店"}核销码</strong><small>{order.serviceMode === "valet" ? "车辆交接时向平台司机出示；运营在线下完成门店核销。" : "核销码绑定本订单和门店，取消或退款后会立即失效。"}</small></span></section>
        {error ? <p className="payment-error" role="alert"><Warning size={17} />{error}</p> : null}
        <button className="primary-button wash-payment-submit" disabled={busy} onClick={() => void pay()}>{busy ? <CircleNotch className="spin" size={20} /> : <Receipt size={20} />}{busy ? "正在模拟支付" : `确认模拟支付 ¥${formatMoney(washOrderTotalFen(order))}`}</button>
        <button className="text-button" onClick={() => flow.replace(washOrderDetailScreen(order.id))}>稍后支付，先查看订单</button>
      </main>
    </MobileScroll>
  );
}

function WashOrderDetailScreen({ orderId }: { orderId: string }) {
  const flow = useFlow();
  const { setActiveVehicleId, showToast } = useMvp();
  const { fetchWashOrder, fetchWashSlots, cancelWashOrder, rescheduleWashOrder } = useWash();
  const [order, setOrder] = useState<WashOrder | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleSlots, setRescheduleSlots] = useState<WashSlot[]>([]);
  const [newSlotId, setNewSlotId] = useState("");
  const [busy, setBusy] = useState(false);
  const slotNow = useSlotClock();
  const load = () => void fetchWashOrder(orderId).then(setOrder).catch(() => setOrder(null));
  useEffect(load, [orderId]);
  useEffect(() => {
    const selected = rescheduleSlots.find((slot) => slot.id === newSlotId);
    if (selected && (!selected.isOpen || selected.remaining <= 0 || slotHasStarted(selected, slotNow))) setNewSlotId("");
  }, [newSlotId, rescheduleSlots, slotNow]);
  if (!order) return <MobileScroll className="app-scroll"><main className="wash-state-loading"><CircleNotch className="spin" size={30} /><p>正在读取洗车订单</p></main></MobileScroll>;
  const canChange = ["pending_payment", "awaiting_redemption"].includes(order.status);
  const selectedRescheduleSlot = rescheduleSlots.find((slot) => slot.id === newSlotId && slot.isOpen && slot.remaining > 0 && !slotHasStarted(slot, slotNow));
  const copyCode = () => { if (order.redemptionCode) { void navigator.clipboard?.writeText(order.redemptionCode); showToast("核销码已复制"); } };
  const openReschedule = async () => {
    setBusy(true);
    try {
      const requestNow = new Date();
      const dates = Array.from({ length: 4 }, (_, index) => addDaysIso(todayIsoInShanghai(requestNow), index));
      const groups = await Promise.all(dates.map((date) => fetchWashSlots(order.storeId, date, order.packageId)));
      const available = groups.flat().filter((slot) => slot.id !== order.slotId && slot.isOpen && slot.remaining > 0 && !slotHasStarted(slot, requestNow));
      setRescheduleSlots(available);
      setNewSlotId(available[0]?.id || "");
      setRescheduleOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "可约时段读取失败");
    } finally { setBusy(false); }
  };
  const runReschedule = async () => {
    const nextSlot = rescheduleSlots.find((slot) => slot.id === newSlotId);
    if (!nextSlot || !nextSlot.isOpen || nextSlot.remaining <= 0 || slotHasStarted(nextSlot)) {
      setNewSlotId("");
      showToast("所选时段已过或不可预约，请重新选择");
      return;
    }
    setBusy(true);
    try { const updated = await rescheduleWashOrder(order.id, newSlotId); setOrder(updated); setRescheduleOpen(false); showToast("预约时间已更新"); }
    catch (error) { showToast(error instanceof Error ? error.message : "改期失败"); }
    finally { setBusy(false); }
  };
  const runCancel = async () => {
    setBusy(true);
    try { const updated = await cancelWashOrder(order.id); setOrder(updated); setCancelOpen(false); showToast(updated.status === "refunded" ? "订单已取消并完成模拟退款" : "预约已取消"); }
    catch (error) { showToast(error instanceof Error ? error.message : "取消失败"); }
    finally { setBusy(false); }
  };
  return (
    <MobileScroll className="app-scroll wash-scroll">
      <main className="wash-order-detail-page" data-testid="wash-order-detail">
        <section className={`wash-order-status status-${order.status}`}><span>{order.status === "redeemed" ? <CheckCircle size={29} weight="fill" /> : order.status === "awaiting_redemption" ? order.serviceMode === "valet" ? <SteeringWheel size={29} weight="duotone" /> : <Drop size={29} weight="fill" /> : <Receipt size={29} weight="duotone" />}</span><div><small>洗车订单 · {order.orderNumber} · {order.serviceMode === "valet" ? "代驾取送" : "自驾到店"}</small><h1>{washStatusLabel(order.status)}</h1><p>{washStatusDescription(order.status, order.serviceMode)}</p></div></section>
        {order.status === "awaiting_redemption" && order.redemptionCode ? <WashRedemptionCode order={order} onCopy={copyCode} /> : null}
        {order.status === "redeemed" ? <section className="wash-redeemed-card"><SealCheck size={33} weight="duotone" /><span><small>服务已完成</small><strong>核销码已由运营人员确认</strong><p>{order.redeemedAt ? formatDateTime(order.redeemedAt) : "核销时间以后台记录为准"}</p></span></section> : null}
        {["cancelled", "refunded", "expired"].includes(order.status) ? <section className="wash-invalid-code-note"><Warning size={20} /><span><strong>该订单的核销码已失效</strong><small>门店无法再使用此订单完成核销。</small></span></section> : null}
        <WashOrderSummary order={order} />
        <section className="wash-detail-meta"><div><span>洗车服务费</span><strong>¥{formatMoney(order.washFeeFen)}</strong></div>{order.serviceMode === "valet" ? <div><span>代驾取送费（往返）</span><strong>¥{formatMoney(order.valetFeeFen)}</strong></div> : null}<div><span>{order.paidFen ? "模拟实付" : "订单合计"}</span><strong>¥{formatMoney(washOrderTotalFen(order))}</strong></div><div><span>联系人</span><strong>{order.contactName} · {order.contactPhone}</strong></div><div><span>结算状态</span><strong>{washSettlementLabel(order.settlementStatus)}</strong></div></section>
        <div className="wash-quick-actions"><button onClick={() => order.store?.phone ? window.location.href = `tel:${order.store.phone}` : showToast("门店电话暂未配置")}><Phone size={19} />联系门店</button>{order.serviceMode === "valet" ? <button onClick={() => showToast(order.pickupAddress ? `${order.pickupAddress.title} · ${order.pickupAddress.address}` : "取送地址以订单记录为准")}><MapPin size={19} />取车地址</button> : <button onClick={() => showToast("已为你准备门店导航信息")}><NavigationArrow size={19} />导航到店</button>}</div>
        {order.status === "pending_payment" ? <button className="primary-button" onClick={() => flow.push(washPaymentScreen(order.id))}><Receipt size={20} />继续模拟支付</button> : null}
        {canChange ? <div className="wash-order-actions"><button disabled={busy} onClick={() => void openReschedule()}><CalendarBlank size={18} />改期</button><button className="danger-text" disabled={busy} onClick={() => setCancelOpen(true)}><X size={18} />取消预约</button></div> : null}
        {["redeemed", "cancelled", "refunded", "expired"].includes(order.status) ? <button className="primary-button" onClick={() => { setActiveVehicleId(order.vehicleId); flow.push(washBookingScreen(order)); }}><ArrowClockwise size={19} />再次预约</button> : null}
        {order.events?.length ? <section className="wash-event-log"><header><small>ORDER LOG</small><h2>订单记录</h2></header>{order.events.slice().reverse().map((event) => <div key={event.id}><span /><p><strong>{event.title || washEventLabel(event.eventType)}</strong><small>{event.description || "订单状态已更新"}</small><em>{formatDateTime(event.createdAt)}</em></p></div>)}</section> : null}
        <p className="wash-manual-note">{order.serviceMode === "valet" ? "本版本不建设司机端；平台在线下协调取送车，" : "本版本"}由运营人员根据门店微信或电话报码人工核销，分账在线下登记。</p>
      </main>
      <BottomSheet open={cancelOpen} onOpenChange={setCancelOpen} title="取消洗车预约" description={order.status === "awaiting_redemption" ? "取消后会完成模拟退款，六位核销码立即失效。" : "取消后释放当前时段，不产生费用。"}><div className="sheet-actions"><button className="secondary-button" onClick={() => setCancelOpen(false)}>保留预约</button><button className="danger-button" disabled={busy} onClick={() => void runCancel()}>确认取消</button></div></BottomSheet>
      <BottomSheet open={rescheduleOpen} onOpenChange={setRescheduleOpen} title="选择新的洗车服务时段" description={order.serviceMode === "valet" ? "仅调整服务时段；取送地址和已锁定代驾费不变，具体取车时间由平台线下确认。" : "仅调整同门店、同套餐的到店时段。"}><div className="wash-reschedule-list">{rescheduleSlots.length ? rescheduleSlots.map((slot) => { const started = slotHasStarted(slot, slotNow); return <button className={slot.id === selectedRescheduleSlot?.id ? "active" : ""} disabled={started || !slot.isOpen || slot.remaining <= 0} key={slot.id} onClick={() => setNewSlotId(slot.id)}><span><strong>{formatDateLabel(slot.date)} · {formatChineseWeekday(slot.date)}</strong><small>{started ? "已过时段" : `${slot.startTime}–${slot.endTime} · 剩余 ${slot.remaining} 位`}</small></span>{slot.id === selectedRescheduleSlot?.id ? <CheckCircle size={20} weight="fill" /> : null}</button>; }) : <p>暂无其他可约时段</p>}<button className="primary-button" disabled={!selectedRescheduleSlot || busy} onClick={() => void runReschedule()}>确认改期</button></div></BottomSheet>
    </MobileScroll>
  );
}

function OrdersScreen() {
  const flow = useFlow();
  const { bookings } = useMvp();
  const { washOrders } = useWash();
  const { orders: rentalOrders } = useRental();
  const [filter, setFilter] = useState<"all" | "annual_inspection" | "car_wash" | "car_rental">("all");
  const allOrders = [
    ...bookings.map((booking) => ({ serviceType: "annual_inspection" as const, createdAt: booking.createdAt, booking })),
    ...washOrders.map((washOrder) => ({ serviceType: "car_wash" as const, createdAt: washOrder.createdAt, washOrder })),
    ...rentalOrders.map((rentalOrder) => ({ serviceType: "car_rental" as const, createdAt: rentalOrder.createdAt, rentalOrder })),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const visibleOrders = filter === "all" ? allOrders : allOrders.filter((item) => item.serviceType === filter);
  return (
    <MobileScroll className="app-scroll owner-root-scroll"><main className="owner-root-page orders-page" data-testid="consumer-orders-page">
      <header className="owner-root-header"><small>OWNER SERVICE</small><h1>订单</h1><p>年检、洗车与汽车租赁记录统一查看</p></header>
      <div className="owner-order-filters" role="tablist" aria-label="订单类型">
        {([ ["all", "全部", allOrders.length], ["annual_inspection", "年检", bookings.length], ["car_wash", "洗车", washOrders.length], ["car_rental", "租车", rentalOrders.length] ] as const).map(([value, label, count]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}
      </div>
      <section className="owner-order-list">
      {visibleOrders.length ? visibleOrders.map((item) => item.serviceType === "car_rental" ? (
        <button className="order-card rental-order-card" key={item.rentalOrder.id} data-testid={`rental-order-card-${item.rentalOrder.id}`} onClick={() => flow.push(item.rentalOrder.status === "pending_payment" ? rentalPaymentScreen(item.rentalOrder.id) : rentalOrderDetailScreen(item.rentalOrder.id))}>
          <header><span>{RENTAL_STATUS_LABEL[item.rentalOrder.status]}</span><em>{formatDateTime(item.rentalOrder.createdAt)}</em></header>
          <strong>{item.rentalOrder.model.brandName}{item.rentalOrder.model.name} · 汽车租赁</strong>
          <small>{item.rentalOrder.store.name} · {item.rentalOrder.fulfillmentMode === "store_pickup" ? "同店取还" : "同址送取"}</small>
          <footer><span>{formatDateTime(item.rentalOrder.pickupAt)} · {item.rentalOrder.billableDays}天</span><b>¥{formatMoney(item.rentalOrder.payableFen)}</b><CaretRight size={18} /></footer>
        </button>
      ) : item.serviceType === "car_wash" ? (
        <button className="order-card wash-order-card" key={item.washOrder.id} data-testid={`wash-order-card-${item.washOrder.id}`} onClick={() => flow.push(item.washOrder.status === "pending_payment" ? washPaymentScreen(item.washOrder.id) : washOrderDetailScreen(item.washOrder.id))}>
          <header><span>{washStatusLabel(item.washOrder.status)}</span><em>{formatDateTime(item.washOrder.createdAt)}</em></header>
          <strong>{item.washOrder.vehicle?.plateNumber || "服务车辆"} · {item.washOrder.serviceMode === "valet" ? "代驾洗车" : "到店洗车"}</strong>
          <small>{item.washOrder.store?.name || "天津洗车演示门店"} · {item.washOrder.package?.name || "洗车套餐"}{item.washOrder.serviceMode === "valet" ? " · 往返取送" : ""}</small>
          <footer><span>{item.washOrder.appointmentDate} {item.washOrder.startTime}</span><b>¥{formatMoney(washOrderTotalFen(item.washOrder))}</b><CaretRight size={18} /></footer>
        </button>
      ) : (
        <button className="order-card" key={item.booking.id} data-testid={`inspection-order-card-${item.booking.id}`} onClick={() => flow.push(item.booking.paymentStatus === "unpaid" || item.booking.status === "pending_payment" ? bookingPaymentScreen(item.booking.id) : orderDetailScreen(item.booking.id))}>
          <header><span>{bookingStatusLabel(bookingFlowStatus(item.booking))}</span><em>{formatDateTime(item.booking.createdAt)}</em></header>
          <strong>{item.booking.vehicle?.plateNumber || "演示车辆"} · 年检预约</strong>{item.booking.vehicle ? <VehiclePlateBadges vehicle={item.booking.vehicle} compact /> : null}
          <small>{item.booking.station?.name || "天津机动车检测服务站"}</small>
          <footer><span>{item.booking.appointmentDate} {item.booking.startTime}</span><b>¥{formatMoney(item.booking.priceBreakdown?.totalFeeFen ?? item.booking.serviceFeeFen)}</b><CaretRight size={18} /></footer>
        </button>
      )) : <EmptyState icon={<Receipt size={36} />} title={filter === "all" ? "暂无订单" : `暂无${filter === "car_wash" ? "洗车" : filter === "car_rental" ? "租车" : "年检"}订单`} copy="预约年检、洗车或汽车租赁后，可在这里查看进度" action={filter === "all" ? "返回首页" : "查看全部订单"} onAction={() => filter === "all" ? flow.replace(homeScreen()) : setFilter("all")} />}
      </section>
    </main></MobileScroll>
  );
}

function ProfileScreen() {
  const flow = useFlow();
  const { activeVehicle, vehicles } = useMvp();
  const profileItems: Array<[ReactNode, string, string, () => void, string?]> = [
    [<Car size={21} weight="duotone" />, "车辆管理", `${vehicles.length} 辆车辆档案`, () => flow.push(vehiclesScreen()), "profile-vehicles"],
    [<Headset size={21} weight="duotone" />, "专属客服", "年检、洗车、租车与订单问题", () => flow.push(serviceScreen("专属客服", "工作日 08:30–17:30 提供年检材料、站点、洗车、汽车租赁和订单咨询。")), "profile-support"],
    [<ShieldCheck size={21} weight="duotone" />, "隐私与数据", "查看本机演示数据说明", () => flow.push(serviceScreen("隐私与数据", "本 MVP 使用合成演示数据；真实产品应按最小必要原则处理车辆、联系人和订单信息。")), "profile-privacy"],
    [<Info size={21} weight="duotone" />, "关于驭小满", "车主服务演示版", () => flow.push(serviceScreen("关于驭小满", "围绕年检、洗车、汽车租赁与车辆生命周期服务打造清晰、可信、好用的车主服务体验。")), "profile-about"],
  ];
  return (
    <MobileScroll className="app-scroll owner-root-scroll">
      <main className="owner-root-page profile-page" data-testid="consumer-profile-page">
        <header className="owner-root-header profile-header"><small>MY GARAGE</small><h1>我的</h1><p>车辆档案与服务设置</p></header>
        {activeVehicle ? <button className="profile-vehicle-card" data-testid="profile-default-vehicle" onClick={() => flow.push(vehiclesScreen())}><span className="profile-car-icon"><Car size={27} weight="duotone" /></span><span><small>默认车辆</small><strong>{activeVehicle.plateNumber}</strong><em>{activeVehicle.vehicleType} · {POWERTRAIN_LABELS[vehiclePowertrain(activeVehicle)]}</em></span><CaretRight size={19} /></button> : <button className="profile-vehicle-card empty" onClick={() => flow.push(vehicleFormScreen())}><span className="profile-car-icon"><Plus size={25} /></span><span><small>车辆档案</small><strong>添加您的爱车</strong><em>用于年检测算、预约和车型匹配</em></span><CaretRight size={19} /></button>}
        <section className="profile-menu" aria-label="我的服务">
          {profileItems.map(([icon, title, copy, action, testId]) => <button key={title} data-testid={testId} onClick={action}><span>{icon}</span><div><strong>{title}</strong><small>{copy}</small></div><CaretRight size={18} /></button>)}
        </section>
        {import.meta.env.DEV ? <section className="profile-developer"><header><span><small>DEVELOPMENT</small><strong>开发态工具</strong></span><em>仅本地演示可见</em></header><button data-testid="profile-demo-tools" onClick={() => flow.push(demoToolsScreen())}><DotsThree size={21} weight="bold" /><span><strong>演示控制台</strong><small>切换检测站身份与查看 API 状态</small></span><CaretRight size={18} /></button></section> : null}
        <p className="profile-version"><ShieldCheck size={15} weight="duotone" />驭小满车主服务 · MVP 演示版</p>
      </main>
    </MobileScroll>
  );
}

function OrderDetailScreen({ bookingId }: { bookingId: string }) {
  const flow = useFlow();
  const { fetchBooking, confirmLedgerEntry, cancelBooking, fetchSlots, rescheduleBooking, showToast } = useMvp();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => void fetchBooking(bookingId).then(setBooking).catch(() => setBooking(null));
  useEffect(load, [bookingId]);
  if (!booking) return <MobileScroll className="app-scroll"><main className="sub-page centered"><CircleNotch className="spin" size={30} /><p>正在读取订单进度</p></main></MobileScroll>;
  const status = bookingFlowStatus(booking);
  const legacyValet = bookingUsesLegacyValet(booking);
  const steps = bookingTimelineSteps(booking);
  const timelineStatus = status === "on_hold" ? "checked_in" : status === "no_show" ? "awaiting_arrival" : status;
  const currentIndex = steps.findIndex(([status]) => status === timelineStatus);
  const runReschedule = async () => { setBusy(true); try { const slots = await fetchSlots(booking.stationId); const requestNow = new Date(); const next = slots.find((item) => item.id !== booking.slotId && item.remaining > 0 && !slotHasStarted(item, requestNow)); if (!next) throw new Error("暂无其他可约时段"); await rescheduleBooking(booking.id, next.id); showToast(`已改期至 ${next.date} ${next.startTime}`); load(); } catch (error) { showToast(error instanceof Error ? error.message : "改期失败"); } finally { setBusy(false); } };
  const runCancel = async () => { await cancelBooking(booking.id); setCancelOpen(false); showToast("预约已取消，退款或扣费已按账目记录"); load(); };
  const confirmSurcharge = async (entry: NonNullable<Booking["ledgerEntries"]>[number]) => {
    if (!entry.id || busy) return;
    setBusy(true);
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() || `confirm-${booking.id}-${entry.id}-${Date.now()}`;
      const updated = await confirmLedgerEntry(booking.id, entry.id, idempotencyKey);
      setBooking(updated);
      showToast("附加费用已确认，可核对金额后模拟补款");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "确认附加费用失败");
    } finally {
      setBusy(false);
    }
  };
  const totalFeeFen = booking.priceBreakdown?.totalFeeFen ?? booking.serviceFeeFen;
  const adjustedEntries = (booking.ledgerEntries || []).filter((entry) => !["booking_charge", "legacy_booking_charge"].includes(entry.type || entry.kind || ""));
  const chargedFen = booking.chargedFen ?? totalFeeFen;
  const pendingAdjustmentFen = booking.pendingAdjustmentFen ?? adjustedEntries.filter((entry) => entry.confirmationStatus === "pending_owner_confirmation").reduce((sum, entry) => sum + entry.amountFen, 0);
  const paidFen = booking.paidFen ?? 0;
  const refundedFen = booking.refundedFen ?? 0;
  const amountDueFen = booking.amountDueFen ?? Math.max(0, chargedFen - paidFen);
  const isUnpaid = booking.paymentStatus === "unpaid" || status === "pending_payment";
  const canReschedule = ["pending_payment", "paid_pending_confirmation", "confirmed"].includes(status);
  const canCancel = ["pending_payment", "paid_pending_confirmation", "confirmed", "driver_arranged"].includes(status);
  return (
    <MobileScroll className="app-scroll">
      <main className="sub-page order-detail-page" data-testid="consumer-order-detail">
        <section className={`order-status-hero status-${status}`}><small>当前状态</small><h1>{bookingStatusLabel(status)}</h1><p>{bookingStatusDescription(status, booking.serviceMode)}</p></section>
        {status === "on_hold" ? <section className="consumer-hold-alert"><Warning size={20} /><span><strong>订单正在人工处理中</strong><small>不会继续推进取送车或检测，工作人员确认后将更新状态。</small></span></section> : null}
        <section className="timeline-card fulfillment-timeline" aria-label="完整履约进度">{steps.map(([stepStatus, title, copy], index) => { const reached = status === "completed" || (status !== "cancelled" && currentIndex >= 0 && index <= currentIndex); const current = index === currentIndex; return <div className={`${reached ? "reached" : ""} ${current ? "current" : ""}`} key={stepStatus}><span>{reached ? <Check size={15} weight="bold" /> : index + 1}</span><p><strong>{title}</strong><small>{copy}</small>{current ? <em>当前进度</em> : null}</p>{index < steps.length - 1 ? <i /> : null}</div>; })}</section>
        <section className="summary-card compact"><div><Car size={20} /><span><small>车辆</small><strong>{booking.vehicle?.plateNumber || "津A·MVP26"}</strong>{booking.vehicle ? <VehiclePlateBadges vehicle={booking.vehicle} compact /> : null}</span></div><div><MapPin size={20} /><span><small>站点</small><strong>{booking.station?.name || "河西安心机动车检测服务站"}</strong></span></div><div><Clock size={20} /><span><small>预约时间</small><strong>{booking.appointmentDate} {booking.startTime}–{booking.endTime}</strong></span></div></section>
        {booking.serviceMode === "valet" ? <section className="round-trip-contract"><SteeringWheel size={23} weight="duotone" /><span><small>{legacyValet ? "历史取送订单" : "上门取送车（往返）"}</small><strong>{legacyValet ? "历史单程计价口径" : "原地址取车 · 检测后送回原地址"}</strong><p>{booking.pickupAddress ? `${booking.pickupAddress.title}${booking.pickupAddress.detail ? ` · ${booking.pickupAddress.detail}` : ""}` : "取送地址以预约记录为准"}</p><em>{legacyValet ? "该旧订单不追溯套用新的往返规则" : "返程已包含在取送车费用内，不另收费"}</em></span></section> : null}
        <section className="order-ledger-card" data-testid="consumer-fee-ledger">
          <header><span><small>费用账目</small><h2>订单金额与支付</h2></span><b className={booking.paymentStatus === "paid" ? "paid" : "unpaid"}>{paymentStatusLabel(booking.paymentStatus)}</b></header>
          <div><span>年检服务费</span><strong>¥{formatMoney(booking.priceBreakdown?.inspectionFeeFen ?? booking.inspectionFeeFen ?? totalFeeFen)}</strong></div>
          {booking.serviceMode === "valet" && booking.priceBreakdown && !legacyValet ? <>
            <div><span>取送车起步价</span><strong>¥{formatMoney(booking.priceBreakdown.valetBaseFeeFen)}</strong></div>
            <div><span>超程距离费</span><strong>¥{formatMoney(booking.priceBreakdown.valetDistanceFeeFen)}</strong></div>
            <div><span>取送车费（往返）</span><strong>¥{formatMoney(booking.priceBreakdown.valetFeeFen)}</strong></div>
          </> : booking.serviceMode === "valet" ? <div><span>{legacyValet ? "历史单程服务费" : "取送车费（往返）"}</span><strong>¥{formatMoney(booking.valetFeeFen ?? 0)}</strong></div> : null}
          {adjustedEntries.map((entry, index) => <div className={`ledger-entry ${entry.confirmationStatus === "pending_owner_confirmation" ? "pending-confirmation" : ""}`} key={entry.id || `${entry.type}-${index}`}><span>{entry.label || entry.description || ledgerEntryLabel(entry.type)}{entry.confirmationStatus === "pending_owner_confirmation" ? <small>后台提出 · 尚未计入应付</small> : null}</span><strong className={entry.direction === "credit" ? "credit" : ""}>{entry.direction === "credit" ? "−" : "+"}¥{formatMoney(Math.abs(entry.amountFen))}</strong>{entry.confirmationStatus === "pending_owner_confirmation" ? <button disabled={busy} onClick={() => void confirmSurcharge(entry)}>确认费用</button> : null}</div>)}
          {pendingAdjustmentFen > 0 ? <p className="pending-adjustment-note"><Warning size={15} />待确认附加费合计 ¥{formatMoney(pendingAdjustmentFen)}；确认前不会进入应付或补款。</p> : null}
          {paidFen ? <div><span>已模拟支付</span><strong>¥{formatMoney(paidFen)}</strong></div> : null}
          {refundedFen ? <div><span>已退款账目</span><strong className="credit">−¥{formatMoney(refundedFen)}</strong></div> : null}
          <footer><span>累计应收<small>{amountDueFen > 0 ? `仍待支付 ¥${formatMoney(amountDueFen)}` : booking.paymentStatus === "paid" ? "模拟支付已记录，不会真实扣款" : "支付状态以后台记录为准"}</small></span><strong>¥{formatMoney(chargedFen)}</strong></footer>
        </section>
        {booking.events?.length ? <section className="consumer-event-log"><header><small>后台履约记录</small><h2>状态更新时间</h2></header>{booking.events.slice().reverse().map((event) => <div key={event.id}><span /><p><strong>{event.title}</strong><small>{event.description}</small><em>{formatDateTime(event.createdAt)}</em></p></div>)}</section> : null}
        {booking.inspectionResult || ["result_received", "returning", "completed"].includes(status) ? <section className="consumer-result-card" data-testid="consumer-result-summary"><SealCheck size={28} weight="duotone" /><span><small>检测结果摘要</small><strong>{booking.inspectionResult?.conclusion === "failed" ? "本次检验需复检" : "本次检验结论：合格"}</strong><p>{typeof booking.inspectionResult?.summary === "string" ? booking.inspectionResult.summary : "结果已由检测站外部系统回传，详细报告为合成演示数据。"}</p></span></section> : null}
        {status === "completed" ? <RatingPanel /> : null}
        {isUnpaid ? <div className="order-actions"><button className="primary-button" onClick={() => flow.push(bookingPaymentScreen(booking.id))}><Receipt size={20} />去模拟支付</button>{canCancel ? <button className="danger-text" onClick={() => setCancelOpen(true)}><X size={18} />取消待支付订单</button> : null}<p><ShieldCheck size={15} />模拟支付不会扣款</p></div> : null}
        {!isUnpaid && (canReschedule || canCancel) ? <div className="order-actions"><div>{canReschedule ? <button disabled={busy} onClick={runReschedule}><CalendarBlank size={18} />快速改期</button> : null}{canCancel ? <button className="danger-text" onClick={() => setCancelOpen(true)}><X size={18} />取消预约</button> : null}</div></div> : null}
        {status === "picked_up" ? <p className="consumer-hold-alert"><Warning size={18} /><span><strong>车辆已取走，不能在车主端直接取消</strong><small>如需终止服务，请联系平台安排车辆安全送回。</small></span></p> : null}
        <p className="demo-disclosure">司机由运营后台线下联系并登记；车主端只展示真实后台状态，不提供手动推进。</p>
      </main>
      <BottomSheet open={cancelOpen} onOpenChange={setCancelOpen} title="取消预约" description={status === "driver_arranged" ? "司机已安排但尚未取车，取消可收取该站取送起步价，余款按账目退回；当前时段会释放。" : "司机尚未安排，取消后全额退款并释放当前时段。"}><div className="sheet-actions"><button className="secondary-button" onClick={() => setCancelOpen(false)}>保留预约</button><button className="danger-button" onClick={runCancel}>确认取消</button></div></BottomSheet>
    </MobileScroll>
  );
}

function RatingPanel() {
  const [rating, setRating] = useState(0);
  return <section className="rating-panel"><strong>{rating ? "感谢您的评价" : "本次服务体验如何？"}</strong><div>{[1, 2, 3, 4, 5].map((item) => <button key={item} onClick={() => setRating(item)} aria-label={`${item} 星`}><Star size={27} weight={item <= rating ? "fill" : "regular"} /></button>)}</div><small>{rating ? `已提交 ${rating} 星演示评价` : "您的反馈帮助我们完善服务"}</small></section>;
}

function InsuranceLeadScreen() {
  const flow = useFlow();
  const keyboard = useKeyboard();
  const { vehicles } = useMvp();
  const insurance = useInsuranceLead();
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const renewalOptions: Array<[InsuranceRenewalWindow, string]> = [
    ["within_30_days", "30天内"],
    ["one_to_three_months", "1–3个月"],
    ["over_three_months", "3个月以上"],
  ];
  const contactOptions: Array<[InsuranceContactWindow, string, string, ReactNode]> = [
    ["morning", "上午", "9:00–12:00", <Sun size={19} weight="duotone" />],
    ["afternoon", "下午", "12:00–18:00", <Clock size={19} weight="duotone" />],
    ["evening", "晚上", "18:00–21:00", <Moon size={19} weight="duotone" />],
    ["anytime", "任意时间", "均可联系", <Clock size={19} weight="duotone" />],
  ];

  useEffect(() => {
    void insurance.loadDisclosure();
  }, []);

  useEffect(() => {
    if (insurance.selectedVehicle || !vehicles.length) return;
    insurance.chooseVehicle((vehicles.find((vehicle) => vehicle.isDefault) || vehicles[0]).id);
  }, [insurance.selectedVehicle, vehicles]);

  useEffect(() => {
    const focused = keyboard.focusedElement;
    if (!keyboard.visible || !focused?.matches(".insurance-linear-fields input")) return;

    const revealFocusedField = (behavior: ScrollBehavior) => {
      const scroll = focused.closest(".mobile-scroll");
      const field = focused.closest(".insurance-linear-fields > label");
      if (!(scroll instanceof HTMLElement) || !(field instanceof HTMLElement)) return;

      const scrollRect = scroll.getBoundingClientRect();
      const fieldRect = field.getBoundingClientRect();
      const footer = scroll.closest(".flow-stack")?.querySelector<HTMLElement>(".flow-fixed-footer");
      const visibleTop = scrollRect.top + 16;
      const visibleBottom = Math.min(scrollRect.bottom, footer?.getBoundingClientRect().top ?? scrollRect.bottom) - 18;
      let nextScrollTop = scroll.scrollTop;

      if (fieldRect.bottom > visibleBottom) nextScrollTop += fieldRect.bottom - visibleBottom;
      else if (fieldRect.top < visibleTop) nextScrollTop -= visibleTop - fieldRect.top;
      else return;

      scroll.scrollTo({ top: Math.max(0, nextScrollTop), behavior });
    };

    const frame = window.requestAnimationFrame(() => revealFocusedField("auto"));
    const settleTimer = window.setTimeout(() => revealFocusedField("smooth"), 300);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [keyboard.focusedElement, keyboard.visible]);

  const handlePhoto = (file: File | null, reset: () => void) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      insurance.setLicensePhoto(null);
      insurance.setFieldError("licensePhoto", "仅支持JPG、PNG或WebP图片");
      reset();
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      insurance.setLicensePhoto(null);
      insurance.setFieldError("licensePhoto", "图片大小不能超过5MB");
      reset();
      return;
    }
    insurance.setLicensePhoto(file);
  };

  return (
    <>
      <MobileScroll className="app-scroll insurance-lead-scroll">
        <main className="insurance-lead-page" data-testid="insurance-lead-page">
          <section className="insurance-trust-banner"><ShieldCheck size={20} weight="duotone" /><span>提交需求，{insurance.disclosure?.contactEtaText || "专业服务人员将在1个工作日内联系"}</span></section>

          <button className="insurance-vehicle-card" data-testid="insurance-vehicle-card" onClick={() => vehicles.length ? setVehicleOpen(true) : flow.push(vehicleFormScreen())}>
            <span><Car size={29} weight="duotone" /></span>
            <span>{insurance.selectedVehicle ? <><strong>{insurance.selectedVehicle.plateNumber}</strong><small>{insurance.selectedVehicle.vehicleType} · {vehicleUsageNature(insurance.selectedVehicle)}</small></> : <><strong>添加车辆后继续</strong><small>用于识别本次续保需求</small></>}</span>
            <CaretRight size={22} />
          </button>
          {insurance.fieldErrors.vehicleId ? <p className="insurance-field-error" role="alert">{insurance.fieldErrors.vehicleId}</p> : null}

          <section className="insurance-form-section insurance-renewal-section">
            <h2>预计续保时间</h2>
            <div className="insurance-renewal-options">
              {renewalOptions.map(([value, label]) => <button type="button" key={value} data-testid={`insurance-renewal-${value}`} className={insurance.renewalWindow === value ? "active" : ""} aria-pressed={insurance.renewalWindow === value} onClick={() => insurance.setRenewalWindow(value)}><CalendarBlank size={19} weight="duotone" />{label}</button>)}
            </div>
            <p className="insurance-speed-note"><Clock size={17} />60秒即可完成登记，越早提交，越早安排对接</p>
          </section>

          <section className="insurance-linear-fields">
            <label className={insurance.fieldErrors.contactName ? "has-error" : ""}>
              <span>联系人</span>
              <div><IdentificationCard size={22} weight="duotone" /><KeyboardInput aria-label="保险联系人" value={insurance.contactName} placeholder="请输入联系人姓名" onChange={(event) => insurance.setContactName(event.target.value.slice(0, 30))} /></div>
              {insurance.fieldErrors.contactName ? <em role="alert">{insurance.fieldErrors.contactName}</em> : null}
            </label>
            <label className={insurance.fieldErrors.contactPhone ? "has-error" : ""}>
              <span>联系电话</span>
              <div><Phone size={22} weight="duotone" /><KeyboardInput aria-label="保险联系电话" inputMode="numeric" value={insurance.contactPhone} placeholder="请输入11位手机号码" onChange={(event) => insurance.setContactPhone(event.target.value.replace(/\D/g, "").slice(0, 11))} /></div>
              {insurance.fieldErrors.contactPhone ? <em role="alert">{insurance.fieldErrors.contactPhone}</em> : null}
            </label>
          </section>

          <section className="insurance-form-section insurance-contact-section">
            <h2>方便联系时段</h2>
            <div className="insurance-contact-options">
              {contactOptions.map(([value, label, copy, icon]) => <button type="button" key={value} data-testid={`insurance-contact-${value}`} className={insurance.contactWindow === value ? "active" : ""} aria-pressed={insurance.contactWindow === value} onClick={() => insurance.setContactWindow(value)}>{icon}<span><strong>{label}</strong><small>{copy}</small></span></button>)}
            </div>
          </section>

          <section className="insurance-form-section insurance-license-section">
            <h2>行驶证主页</h2>
            <label className={`insurance-upload-card ${insurance.licensePhoto ? "complete" : ""} ${insurance.fieldErrors.licensePhoto ? "has-error" : ""}`}>
              <span><FileText size={27} weight="duotone" /></span>
              <span><strong>{insurance.licensePhoto ? insurance.licensePhoto.name : "上传1张清晰主页"}</strong><small>{insurance.licensePhoto ? `${(insurance.licensePhoto.size / 1024 / 1024).toFixed(2)}MB · 点击可重新选择` : "支持JPG/PNG/WebP格式，大小不超过5MB"}</small></span>
              {insurance.licensePhoto ? <CheckCircle size={22} weight="fill" /> : <CaretRight size={22} />}
              <input data-testid="insurance-license-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => handlePhoto(event.target.files?.[0] || null, () => { event.currentTarget.value = ""; })} />
            </label>
            {insurance.fieldErrors.licensePhoto ? <p className="insurance-field-error" role="alert">{insurance.fieldErrors.licensePhoto}</p> : null}
            {insurance.disclosure && !insurance.disclosure.acceptsRealData ? <p className="insurance-demo-warning"><Warning size={15} />演示环境请勿上传真实资料，仅使用合成演示图片</p> : null}
          </section>

          <section className="insurance-consent-section">
            <div>
              <label><input data-testid="insurance-consent" type="checkbox" checked={insurance.consentAccepted} onChange={(event) => insurance.setConsentAccepted(event.target.checked)} /><span>我已阅读并同意</span></label>
              <button type="button" data-testid="insurance-disclosure-trigger" onClick={() => setDisclosureOpen(true)}>信息使用说明</button>
              {insurance.disclosureLoading ? <CircleNotch className="spin" size={14} /> : null}
            </div>
            {insurance.fieldErrors.consentAccepted ? <p className="insurance-field-error" role="alert">{insurance.fieldErrors.consentAccepted}</p> : null}
            {insurance.disclosureError ? <button type="button" className="insurance-disclosure-error" onClick={() => void insurance.loadDisclosure(true)}><Warning size={14} />{insurance.disclosureError} · 点击重试</button> : null}
          </section>

          {insurance.submitError ? <p className="insurance-submit-error" role="alert"><Warning size={16} />{insurance.submitError}</p> : null}
        </main>
      </MobileScroll>

      <BottomSheet open={vehicleOpen} onOpenChange={setVehicleOpen} title="选择续保车辆" description="提交前只补充本次对接所需的最少信息。">
        <div className="insurance-vehicle-sheet">
          {vehicles.length ? vehicles.map((vehicle) => <button type="button" className={vehicle.id === insurance.vehicleId ? "active" : ""} key={vehicle.id} onClick={() => { insurance.chooseVehicle(vehicle.id); setVehicleOpen(false); }}><span><strong>{vehicle.plateNumber}</strong><small>{vehicle.vehicleType} · {vehicleUsageNature(vehicle)}</small></span>{vehicle.id === insurance.vehicleId ? <CheckCircle size={21} weight="fill" /> : <CaretRight size={19} />}</button>) : <button type="button" className="primary-button" onClick={() => { setVehicleOpen(false); flow.push(vehicleFormScreen()); }}><Plus size={18} />添加车辆</button>}
        </div>
      </BottomSheet>

      <BottomSheet open={disclosureOpen} onOpenChange={setDisclosureOpen} title={insurance.disclosure?.title || "信息使用说明"} description={insurance.disclosure ? `版本 ${insurance.disclosure.version}` : "请先加载最新说明"}>
        <div className="insurance-disclosure-sheet" data-testid="insurance-disclosure-sheet">
          {insurance.disclosure ? <>
            {!insurance.disclosure.acceptsRealData ? <p className="demo"><Warning size={17} /><span><strong>当前为演示环境</strong><small>仅提交合成演示资料，不会转交真实保险机构。</small></span></p> : null}
            <dl>
              <div><dt>信息接收方</dt><dd>{insurance.disclosure.partner.name}{insurance.disclosure.partner.recipientName !== insurance.disclosure.partner.name ? ` · ${insurance.disclosure.partner.recipientName}` : ""}</dd></div>
              <div><dt>使用目的</dt><dd>{insurance.disclosure.purpose}</dd></div>
              <div><dt>保存期限</dt><dd>{insurance.disclosure.retention}</dd></div>
            </dl>
            <section><strong>本次使用的信息</strong><ul>{insurance.disclosure.dataScope.map((item) => <li key={item}>{item}</li>)}</ul></section>
            <p className="consent-copy">{insurance.disclosure.consentText}</p>
            <button type="button" className="primary-button" onClick={() => { insurance.setConsentAccepted(true); setDisclosureOpen(false); }}>同意并继续</button>
          </> : <div className="insurance-disclosure-loading"><CircleNotch className="spin" size={24} /><p>{insurance.disclosureError || "正在加载最新说明"}</p><button type="button" className="secondary-button" onClick={() => void insurance.loadDisclosure(true)}>重新加载</button></div>}
        </div>
      </BottomSheet>
    </>
  );
}

function InsuranceLeadFooter() {
  const flow = useFlow();
  const insurance = useInsuranceLead();
  const submit = async () => {
    const receipt = await insurance.submit();
    if (receipt) flow.replace(insuranceReceiptScreen());
  };
  return <div className="insurance-lead-footer"><button type="button" data-testid="insurance-submit" disabled={insurance.submitting} onClick={() => void submit()}>{insurance.submitting ? <CircleNotch className="spin" size={21} /> : <NavigationArrow size={23} weight="duotone" />}{insurance.submitting ? "正在提交" : "提交续保需求"}</button><p><ShieldCheck size={14} />驭小满仅提供需求登记与服务对接，不提供报价或承保</p></div>;
}

function InsuranceLeadReceiptScreen() {
  const flow = useFlow();
  const { showToast } = useMvp();
  const insurance = useInsuranceLead();
  const [copied, setCopied] = useState(false);
  const receipt = insurance.receipt;
  const copyCode = async () => {
    if (!receipt?.leadCode) return;
    try {
      await navigator.clipboard.writeText(receipt.leadCode);
      setCopied(true);
      showToast("凭证编号已复制");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      showToast(`凭证编号：${receipt.leadCode}`);
    }
  };
  if (!receipt) return <MobileScroll className="app-scroll"><EmptyState icon={<ShieldCheck size={36} />} title="暂未找到提交凭证" copy="请返回首页重新登记续保需求" action="返回首页" onAction={() => flow.replace(homeScreen())} /></MobileScroll>;
  return (
    <MobileScroll className="app-scroll insurance-receipt-scroll">
      <main className="insurance-receipt-page" data-testid="insurance-receipt-page">
        <section className={`insurance-receipt-hero ${insurance.withdrawn ? "withdrawn" : ""}`}><span>{insurance.withdrawn ? <X size={28} /> : <CheckCircle size={31} weight="fill" />}</span><small>{insurance.withdrawn ? "需求已撤回" : receipt.duplicate ? "已返回原提交凭证" : "需求提交成功"}</small><h1>{insurance.withdrawn ? "本次对接已停止" : "已为您登记续保需求"}</h1><p>{insurance.withdrawn ? "平台已停止后续对接；若资料已完成转交，将按授权说明继续处理清理请求。" : `${receipt.contactEtaText || "专业服务人员将在1个工作日内联系"}，请留意来电。`}</p></section>
        {receipt.duplicate && !insurance.withdrawn ? <p className="insurance-duplicate-note"><ShieldCheck size={16} />相同车辆与手机号的近期需求已存在，本次返回同一凭证，不会重复派单。</p> : null}
        <section className="insurance-receipt-card">
          <header><span><small>对接凭证</small><strong data-testid="insurance-lead-code">{receipt.leadCode}</strong></span><button type="button" data-testid="insurance-copy-code" onClick={() => void copyCode()}><Copy size={17} />{copied ? "已复制" : "复制编号"}</button></header>
          <div><span>提交时间</span><strong>{formatLocalDateTime(receipt.submittedAt)}</strong></div>
          <div><span>续保车辆</span><strong>{receipt.vehicle.plateNumber} · {receipt.vehicle.modelName}</strong></div>
          <div><span>联系电话</span><strong>{receipt.maskedPhone}</strong></div>
          <div><span>预计联系</span><strong>{receipt.contactEtaText || "1个工作日内"}</strong></div>
        </section>
        <section className="insurance-receipt-notice"><ShieldCheck size={20} weight="duotone" /><span><strong>平台服务边界</strong><small>本凭证仅证明需求已由驭小满登记并安排对接，不代表保险报价、核保结果或承保承诺。</small></span></section>
        {insurance.submitError ? <p className="insurance-submit-error" role="alert"><Warning size={16} />{insurance.submitError}</p> : null}
        <div className="insurance-receipt-actions">
          {insurance.withdrawn ? <button type="button" className="secondary-button" onClick={() => flow.replace(homeScreen())}>返回首页</button> : <button type="button" className="insurance-withdraw-button" data-testid="insurance-withdraw" disabled={insurance.withdrawing || !receipt.withdrawToken} onClick={() => void insurance.withdraw()}>{insurance.withdrawing ? <CircleNotch className="spin" size={17} /> : <X size={17} />}{insurance.withdrawing ? "正在撤回" : "撤回本次需求"}</button>}
        </div>
      </main>
    </MobileScroll>
  );
}

function ServiceInfoScreen({ title, description }: { title: string; description: string }) {
  const { showToast } = useMvp();
  return <MobileScroll className="app-scroll"><main className="sub-page service-info-page"><span className="service-illustration"><ShieldCheck size={48} weight="duotone" /></span><small>车主生命周期服务</small><h1>{title}</h1><p>{description}</p><section className="info-card"><div className="info-row"><span>当前能力</span><strong>说明与咨询演示</strong></div><div className="info-row"><span>后续扩展</span><strong>共用车辆档案与订单能力</strong></div><div className="info-row"><span>数据说明</span><strong>全部为合成数据</strong></div></section><button className="primary-button" onClick={() => showToast("已提交演示咨询") }><Headset size={21} />咨询专属客服</button></main></MobileScroll>;
}

function DemoToolsScreen() {
  const flow = useFlow();
  const { apiOnline, vehicles, bookings, setAppRole } = useMvp();
  return <MobileScroll className="app-scroll"><main className="sub-page demo-tools-page"><section className="role-switch-card"><span><IdentificationCard size={24} weight="duotone" /></span><div><small>当前演示身份</small><strong>车主端</strong><p>切换后进入检测站工作台，真实产品将由账号权限决定身份。</p></div><button data-testid="role-switch-operator" onClick={() => setAppRole("operator")}>切换检测站端<ArrowsLeftRight size={16} /></button></section><section className="api-status"><span className={apiOnline ? "online" : "fallback"} /><div><strong>{apiOnline ? "真实本地 API 已连接" : "前端安全演示模式"}</strong><small>{apiOnline ? "Fastify + PostgreSQL" : "启动完整服务后自动切换真实接口"}</small></div></section><section className="metric-grid"><div><strong>{vehicles.length}</strong><small>车辆档案</small></div><div><strong>{bookings.length}</strong><small>预约订单</small></div><div><strong>{bookings.filter((item) => item.status === "completed").length}</strong><small>成功履约</small></div></section><button className="list-action" onClick={() => flow.push(vehiclesScreen())}><span><Car size={22} /></span><strong>管理演示车辆</strong><CaretRight size={18} /></button><button className="list-action" onClick={() => flow.push(ordersScreen())}><span><Receipt size={22} /></span><strong>查看全部订单</strong><CaretRight size={18} /></button><section className="data-protection-note"><ShieldCheck size={20} weight="duotone" /><div><strong>持久化数据保护已开启</strong><small>当前环境不提供数据库重置入口，现有车辆、订单和号源会被保留。</small></div></section><p className="demo-disclosure">此页面仅用于切换 Web 演示身份；不会操作微信开发者工具。</p></main></MobileScroll>;
}

function OperatorBottomNavV2({ active }: { active: OperatorTab }) {
  const flow = useFlow();
  const items: Array<[OperatorTab, string, ReactNode]> = [
    ["workbench", "工作台", <Car size={24} weight={active === "workbench" ? "fill" : "regular"} />],
    ["orders", "订单", <Receipt size={24} weight={active === "orders" ? "fill" : "regular"} />],
    ["station", "站点", <MapTrifold size={24} weight={active === "station" ? "fill" : "regular"} />],
  ];
  return (
    <nav className="operator-bottom-nav" aria-label="检测站端导航">
      {items.map(([tab, label, icon]) => (
        <button
          className={active === tab ? "active" : ""}
          data-testid={`operator-nav-${tab}`}
          aria-current={active === tab ? "page" : undefined}
          key={tab}
          onClick={() => flow.replace(operatorRootScreen(tab))}
        >
          {icon}<span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function OperatorPageHeaderV2({ stationName, subtitle = "站点负责人" }: { stationName: string; subtitle?: string }) {
  const { setAppRole } = useMvp();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header className="operator-page-header">
      <span className="operator-station-name" aria-label="当前检测站">
        <strong>{stationName.replace("（演示）", "")}</strong><CaretDown size={16} weight="bold" />
      </span>
      <button className="operator-role-pill" data-testid="demo-menu-trigger" onClick={() => setMenuOpen(true)}>
        <IdentificationCard size={19} /><span>{subtitle}</span><ArrowsLeftRight size={14} />
      </button>
      <BottomSheet open={menuOpen} onOpenChange={setMenuOpen} title="切换演示身份" description="当前为固定演示检测站身份。"><div className="sheet-actions"><button className="primary-button" data-testid="role-switch-consumer" onClick={() => setAppRole("consumer")}><ArrowsLeftRight size={17} />切换至车主端</button><button className="secondary-button" onClick={() => setMenuOpen(false)}>继续使用检测站端</button></div></BottomSheet>
    </header>
  );
}

const operatorFilters: Array<[string, string]> = [
  ["all", "全部"],
  ["awaiting-arrival", "待到站"],
  ["checked-in", "已到站"],
  ["inspecting", "检测中"],
  ["completed", "已完成"],
];

function bookingMatchesOperatorFilter(booking: Booking, filter: string) {
  const status = bookingFlowStatus(booking);
  if (filter === "all") return true;
  if (filter === "awaiting-arrival") return ["paid_pending_confirmation", "confirmed", "driver_arranged", "picked_up", "awaiting_arrival", "no_show"].includes(status);
  if (filter === "checked-in") return ["checked_in", "on_hold"].includes(status);
  if (filter === "inspecting") return ["inspecting", "result_received", "returning"].includes(status);
  return status === "completed";
}

function OperatorTaskList({ bookings, onReload, showQuickAction = true }: { bookings: Booking[]; onReload: () => void; showQuickAction?: boolean }) {
  const flow = useFlow();
  const { runOperatorAction, showToast } = useMvp();
  const runQuick = async (booking: Booking) => {
    const action: OperatorAction = bookingFlowStatus(booking) === "confirmed" ? "accept" : "check-in";
    try {
      await runOperatorAction(booking.id, action, action === "check-in" ? {
        plateMatched: true,
        materialsReady: true,
        exteriorRecorded: true,
        vehicleConditionConfirmed: true,
      } : {});
      showToast(action === "accept" ? "已确认承接预约" : "车辆已确认到站");
      onReload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "操作失败");
    }
  };
  if (!bookings.length) return <div className="operator-list-empty"><ClipboardText size={34} /><strong>当前筛选暂无任务</strong><small>切换筛选或刷新任务列表</small></div>;
  return (
    <section className="operator-task-list" data-testid="operator-task-list">
      {bookings.map((booking, index) => {
        const status = bookingFlowStatus(booking);
        const quick = showQuickAction && index === 0 && ["confirmed", "awaiting_arrival"].includes(status);
        return (
          <button
            className={`operator-task-row ${quick ? "next" : ""}`}
            data-testid="operator-task-card"
            data-task-id={booking.id}
            id={`operator-task-${booking.id}`}
            key={booking.id}
            onClick={() => flow.push(operatorBookingScreen(booking.id))}
          >
            <span className="operator-task-time"><strong>{booking.startTime}–{booking.endTime}</strong><small>{formatOperatorDate(booking.appointmentDate)}</small></span>
            <span className="operator-task-main"><strong>{formatPlate(booking.vehicle?.plateNumber || "津A·MVP26")}</strong><small>{booking.vehicle?.vehicleType || "小型轿车"} · {booking.vehicle?.usageNature || "非营运"}</small><em>{booking.contactName}　{booking.contactPhone}</em></span>
            <span className={`operator-status status-${status}`}><b>{operatorStatusShort(status)}</b><small>{booking.vehicle?.plateNumber === "津B·T1001" ? "预计晚到 15 分钟" : operatorStatusHint(status)}</small></span>
            {quick ? <span className="operator-task-quick" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); void runQuick(booking); }}>{status === "confirmed" ? "确认接单" : "确认到站"}</span> : <CaretRight className="operator-task-caret" size={18} />}
          </button>
        );
      })}
      <p className="operator-list-note">温馨提示：任务时间为预约时段，请合理安排叫号与检测流程。</p>
    </section>
  );
}

function OperatorScopeBar({ stations, stationId, date, onStation, onDate }: { stations: Station[]; stationId: string; date: string; onStation: (id: string) => void; onDate: (date: string) => void }) {
  return <section className="operator-scope-bar" aria-label="检测任务范围">
    <label><MapPin size={16} /><select aria-label="选择检测站" value={stationId} onChange={(event) => onStation(event.target.value)}>{stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select><CaretDown size={14} /></label>
    <label><CalendarBlank size={16} /><input aria-label="选择预约日期" type="date" value={date} onChange={(event) => onDate(event.target.value)} /></label>
  </section>;
}

function OperatorWorkbenchScreenV2() {
  const flow = useFlow();
  const { fetchOperatorWorkbench, apiOnline, showToast, stations, operatorStationId, operatorDate, setOperatorStationId, setOperatorDate } = useMvp();
  const [workbench, setWorkbench] = useState<OperatorWorkbench | null>(null);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    void fetchOperatorWorkbench(operatorStationId, operatorDate).then(setWorkbench).catch((error) => showToast(error instanceof Error ? error.message : "工作台加载失败")).finally(() => setLoading(false));
  };
  useEffect(load, [operatorStationId, operatorDate]);
  if (!workbench) return <MobileScroll className="app-scroll"><main className="operator-loading"><CircleNotch className="spin" size={30} /><p>{loading ? "正在加载检测站工作台" : "暂时无法读取工作台"}</p><button onClick={load}>重新加载</button></main></MobileScroll>;
  const pressure = workbench.pressures.find((item) => item.level === "high") || workbench.pressures[0];
  const filtered = workbench.bookings.filter((item) => bookingMatchesOperatorFilter(item, filter)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  return (
    <MobileScroll className="app-scroll operator-scroll">
      <main className="operator-page operator-workbench-page" data-testid="operator-workbench">
        <OperatorPageHeaderV2 stationName={workbench.station.name} />
        <OperatorScopeBar stations={stations} stationId={operatorStationId} date={operatorDate} onStation={setOperatorStationId} onDate={setOperatorDate} />
        <section className="operator-overview-card">
          <div className="operator-overview-metrics">
            <div><CalendarCheck size={23} /><span><small>今日已预约</small><strong>{workbench.summary.todayBookings}<em> / {workbench.summary.totalCapacity}</em></strong></span></div>
            <div><Car size={23} /><span><small>待到站</small><strong>{workbench.summary.awaitingArrival}</strong></span></div>
            <div><Clock size={23} /><span><small>检测中</small><strong>{workbench.summary.inspecting}</strong></span></div>
          </div>
          <button className="operator-pressure-row" onClick={() => flow.replace(operatorRootScreen("station"))} aria-label="调整号源">
            <Clock size={19} /><span>{pressure?.label || "11:00–12:00"} 时段压力：<b>{pressure?.level === "high" ? "较高" : pressure?.level === "medium" ? "适中" : "宽松"}</b></span><strong>调整号源</strong><CaretRight size={16} />
          </button>
        </section>
        <section className="operator-task-heading"><div><h1>今日履约任务</h1><small>{apiOnline ? "实时本地服务数据" : "合成演示数据"}<ShieldCheck size={13} /></small></div><button onClick={load} disabled={loading}><ArrowClockwise className={loading ? "spin" : ""} size={18} />刷新</button></section>
        <div className="operator-filter-row" role="tablist" aria-label="履约任务筛选">
          {operatorFilters.map(([value, label]) => <button role="tab" aria-selected={filter === value} data-testid={`operator-filter-${value}`} className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <OperatorTaskList bookings={filtered} onReload={load} />
      </main>
    </MobileScroll>
  );
}

function OperatorOrdersScreenV2() {
  const { fetchOperatorWorkbench, showToast, stations, operatorStationId, operatorDate, setOperatorStationId, setOperatorDate } = useMvp();
  const [workbench, setWorkbench] = useState<OperatorWorkbench | null>(null);
  const [filter, setFilter] = useState("all");
  const load = () => void fetchOperatorWorkbench(operatorStationId, operatorDate).then(setWorkbench).catch((error) => showToast(error instanceof Error ? error.message : "订单加载失败"));
  useEffect(load, [operatorStationId, operatorDate]);
  const tasks = (workbench?.bookings || []).filter((item) => bookingMatchesOperatorFilter(item, filter)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  return (
    <MobileScroll className="app-scroll operator-scroll"><main className="operator-page operator-orders-page" data-testid="operator-order-list">
      <OperatorPageHeaderV2 stationName={workbench?.station.name || "海河机动车检测服务中心"} subtitle="站点订单" />
      <OperatorScopeBar stations={stations} stationId={operatorStationId} date={operatorDate} onStation={setOperatorStationId} onDate={setOperatorDate} />
      <section className="operator-orders-title"><span><small>履约订单</small><h1>今日任务全链路</h1></span><b>{workbench?.bookings.length || 0} 笔</b></section>
      <div className="operator-filter-row compact" role="tablist" aria-label="订单筛选">{operatorFilters.map(([value, label]) => <button role="tab" aria-selected={filter === value} data-testid={`operator-orders-filter-${value}`} className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <OperatorTaskList bookings={tasks} onReload={load} showQuickAction={false} />
    </main></MobileScroll>
  );
}

function OperatorStationScreenV2() {
  const { fetchOperatorWorkbench, fetchSlots, updateSlotCapacity, showToast, stations, operatorStationId, operatorDate, setOperatorStationId, setOperatorDate } = useMvp();
  const [workbench, setWorkbench] = useState<OperatorWorkbench | null>(null);
  const [futureSlots, setFutureSlots] = useState<Slot[]>([]);
  const [capacityDate, setCapacityDate] = useState("");
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [capacityError, setCapacityError] = useState("");
  useEffect(() => {
    void fetchOperatorWorkbench(operatorStationId, operatorDate).then(async (next) => {
      setWorkbench(next);
      const futureDate = next.date > DEMO_TODAY ? next.date : addDaysIso(next.date, 1);
      const slots = await fetchSlots(next.station.id, futureDate);
      setCapacityDate(futureDate);
      setFutureSlots(slots);
      setDrafts(Object.fromEntries(slots.map((item) => [item.id, item.capacity])));
    }).catch((error) => showToast(error instanceof Error ? error.message : "号源加载失败"));
  }, [operatorStationId, operatorDate]);
  const adjust = (slotId: string, delta: number) => setDrafts((current) => ({ ...current, [slotId]: Math.max(0, (current[slotId] || 0) + delta) }));
  const save = async (pressure: SlotPressure) => {
    setCapacityError("");
    try {
      const updated = await updateSlotCapacity(pressure.slotId, drafts[pressure.slotId] ?? pressure.capacity);
      setFutureSlots((current) => current.map((item) => item.id === updated.id ? updated : item));
      showToast("号源容量已更新");
    }
    catch (error) { const message = error instanceof Error ? error.message : "容量调整失败"; setDrafts((current) => ({ ...current, [pressure.slotId]: pressure.capacity })); setCapacityError(message); showToast(message); }
  };
  const station = workbench?.station || fallbackWorkbench(fallbackOperatorBookings).station;
  const pressures: SlotPressure[] = futureSlots.length ? futureSlots.map((slot) => {
    const booked = Math.max(0, slot.capacity - slot.remaining);
    const ratio = slot.capacity ? booked / slot.capacity : 0;
    return { slotId: slot.id, label: `${slot.date.slice(5)} · ${slot.startTime}-${slot.endTime}`, booked, capacity: slot.capacity, level: ratio >= 0.8 ? "high" : ratio >= 0.5 ? "medium" : "low" };
  }) : fallbackWorkbench(fallbackOperatorBookings).pressures;
  return (
    <MobileScroll className="app-scroll operator-scroll"><main className="operator-page operator-station-page" data-testid="operator-station">
      <OperatorPageHeaderV2 stationName={station.name} subtitle="站点设置" />
      <OperatorScopeBar stations={stations} stationId={operatorStationId} date={operatorDate} onStation={setOperatorStationId} onDate={setOperatorDate} />
      <section className="operator-station-hero"><span><MapTrifold size={32} weight="duotone" /></span><div><small>{station.dataKind === "real" ? station.isDirectOperated ? "自营检测站 · 地址已核验" : "真实检测站 · 地址已核验" : "固定演示站点"}</small><h1>{station.name}</h1><p>{station.address}</p></div></section>
      <section className="operator-station-info"><div><Clock size={19} /><span><small>营业时间</small><strong>{station.openHours || station.businessHours || "未配置"}</strong></span></div><div><Phone size={19} /><span><small>联系电话</small><strong>{station.phone || "未配置"}</strong></span></div><div><Car size={19} /><span><small>服务车型</small><strong>{(station.supportedVehicleTypes || ["小型轿车", "小型SUV", "新能源小型车"]).join("、")}</strong></span></div></section>
      <section className="operator-capacity-section" data-testid="operator-slot-capacity"><header><span><small>号源管理 · {capacityDate || "未来日期"}</small><h2>未来时段容量</h2></span><b>不得低于已预约量</b></header>{pressures.map((pressure) => <article className="operator-slot-card" data-testid="operator-slot-card" key={pressure.slotId}><div><strong>{pressure.label}</strong><small>已约 {pressure.booked} · 容量 {drafts[pressure.slotId] ?? pressure.capacity}</small></div><span className="capacity-stepper"><button aria-label="减少容量" data-testid="operator-slot-decrease" onClick={() => adjust(pressure.slotId, -1)}>−</button><b>{drafts[pressure.slotId] ?? pressure.capacity}</b><button aria-label="增加容量" onClick={() => adjust(pressure.slotId, 1)}>＋</button></span><button className="capacity-save" data-testid="operator-slot-save" onClick={() => void save(pressure)}>保存</button></article>)}{capacityError ? <p className="operator-capacity-error" data-testid="operator-capacity-error" role="alert">{capacityError}</p> : null}</section>
      <p className="operator-station-disclosure"><ShieldCheck size={16} />{station.dataKind === "real" ? `${station.isDirectOperated ? "华洋自营站" : "该站"}名称、地址与公开联系方式已核验；号源、任务和服务价格仍为 MVP 配置数据。` : "站点、号源、联系方式与服务数据均为合成演示数据。"}</p>
    </main></MobileScroll>
  );
}

function OperatorBookingDetailScreenV2({ bookingId }: { bookingId: string }) {
  const { fetchOperatorBooking, runOperatorAction, simulateInspectionResult, showToast } = useMvp();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const [boundaryOpen, setBoundaryOpen] = useState(false);
  const [checks, setChecks] = useState<BookingVerification>({ plateMatched: false, materialsReady: false, exteriorRecorded: false, vehicleConditionConfirmed: false });
  const load = () => void fetchOperatorBooking(bookingId).then((next) => {
    setBooking(next);
    setChecks(next.verification || { plateMatched: false, materialsReady: false, exteriorRecorded: false, vehicleConditionConfirmed: false });
  }).catch((error) => showToast(error instanceof Error ? error.message : "任务加载失败"));
  useEffect(load, [bookingId]);
  if (!booking) return <MobileScroll className="app-scroll"><main className="operator-loading"><CircleNotch className="spin" size={30} /><p>正在读取履约任务</p></main></MobileScroll>;
  const status = bookingFlowStatus(booking);
  const legacyValet = bookingUsesLegacyValet(booking);
  const stepStatus: BookingStatus = status === "on_hold" ? "checked_in" : ["pending_payment", "paid_pending_confirmation", "driver_arranged", "picked_up"].includes(status) ? "confirmed" : status === "returning" ? "result_received" : status;
  const steps: Array<[BookingStatus, string, ReactNode]> = [
    ["confirmed", "预约确认", <CalendarCheck size={22} />],
    ["checked_in", "到站核验", <IdentificationCard size={22} />],
    ["inspecting", "交接检测", <Car size={22} />],
    ["result_received", "结果回传", <ArrowClockwise size={22} />],
    ["completed", "服务完成", <ShieldCheck size={22} />],
  ];
  const statusOrder: BookingStatus[] = ["confirmed", "awaiting_arrival", "checked_in", "inspecting", "result_received", "completed"];
  const currentIndex = stepStatus === "awaiting_arrival" ? 0 : Math.max(0, statusOrder.indexOf(stepStatus) - 1);
  const act = async (action: OperatorAction) => {
    setBusy(true);
    try {
      const verificationPayload = {
        plateMatched: checks.plateMatched,
        materialsReady: checks.materialsReady,
        exteriorRecorded: checks.exteriorRecorded,
        vehicleConditionConfirmed: checks.vehicleConditionConfirmed,
        ...(typeof checks.notes === "string" && checks.notes ? { notes: checks.notes } : {}),
      };
      const payload = action === "check-in" || action === "resolve-hold" ? verificationPayload : action === "hold" ? { reasonCode: "vehicle_mismatch", note: "实车信息与预约档案不一致" } : {};
      const updated = await runOperatorAction(booking.id, action, payload);
      setBooking(updated);
      showToast(operatorActionSuccess(action));
    } catch (error) { showToast(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const simulate = async () => {
    setBusy(true);
    try { const updated = await simulateInspectionResult(booking.id); setBooking(updated); showToast("外部检测结果已模拟回传"); }
    catch (error) { showToast(error instanceof Error ? error.message : "结果回传失败"); }
    finally { setBusy(false); }
  };
  const verificationRows: Array<[keyof Pick<BookingVerification, "plateMatched" | "materialsReady" | "exteriorRecorded" | "vehicleConditionConfirmed">, string, string, ReactNode]> = [
    ["plateMatched", "车牌核对", `实车车牌与预约信息一致：${formatPlate(booking.vehicle?.plateNumber || "津A·MVP26")}`, <IdentificationCard size={19} />],
    ["materialsReady", "资料准备", "身份证、行驶证、交强险已准备齐全", <ClipboardText size={19} />],
    ["exteriorRecorded", "车辆照片与仪表", "核对车辆四角、启动后仪表盘及 VIN", <Camera size={19} />],
    ["vehicleConditionConfirmed", "车辆状态", "无明显改装、破损及异常情况", <Car size={19} />],
  ];
  const photos = [["front", "车头"], ["rear", "车尾"], ["left", "左侧"], ["right", "右侧"]];
  const vehicleMedia = (booking.media || []).filter((item) => bookingMediaSlots.some((slot) => slot.vehicle && slot.kind === item.kind));
  const licenseMedia = (booking.media || []).filter((item) => item.kind.startsWith("license_"));
  return (
    <MobileScroll className="app-scroll operator-detail-scroll"><main className="operator-detail-page" data-testid="operator-detail">
      <p className="operator-synthetic-label">合成数据 <ShieldCheck size={14} /></p>
      <section className="operator-booking-hero"><header><h1>{formatPlate(booking.vehicle?.plateNumber || "津A·MVP26")}</h1><span className={`operator-detail-status status-${status}`}>{bookingStatusLabel(status)}</span></header><p>预约单号　<strong>{booking.appointmentNumber || booking.id.toUpperCase().slice(-14)}</strong></p><div><span><Clock size={23} /><small><strong>{booking.startTime}–{booking.endTime}</strong>{formatOperatorDate(booking.appointmentDate)}</small></span><span><IdentificationCard size={23} /><small><strong>{booking.contactName}</strong>{booking.contactPhone}</small></span><span><Car size={23} /><small><strong>{booking.vehicle?.vehicleType || "小型轿车"}</strong>{booking.vehicle?.usageNature || "非营运"}</small></span></div></section>
      <section className="operator-pickup-card"><header><span><SteeringWheel size={21} /></span><div><small>预约方式</small><strong>{booking.serviceMode === "valet" ? legacyValet ? "历史单程取送" : "上门取送车（往返）" : "自驾到店"}</strong></div><em>¥{formatMoney(booking.serviceFeeFen)}</em></header>{booking.pickupAddress ? <><div className="operator-pickup-address"><MapPin size={20} /><span><strong>{booking.pickupAddress.title}{booking.pickupAddress.detail ? ` · ${booking.pickupAddress.detail}` : ""}</strong><small>{booking.pickupAddress.address}</small></span></div>{booking.pickupAddress.note ? <p><NotePencil size={16} />{booking.pickupAddress.note}</p> : null}<a href={`https://apis.map.qq.com/uri/v1/marker?marker=coord:${booking.pickupAddress.latitude},${booking.pickupAddress.longitude};title:${encodeURIComponent(booking.pickupAddress.title)}`} target="_blank" rel="noreferrer"><MapTrifold size={17} />打开路线导航</a></> : <p><Car size={16} />车主按预约时段自驾到站</p>}<footer><span>检测费 ¥{formatMoney(booking.inspectionFeeFen ?? booking.serviceFeeFen)}</span><span>{legacyValet ? "历史单程服务费" : "取送车费（往返）"} ¥{formatMoney(booking.valetFeeFen ?? 0)}</span></footer>{booking.serviceMode === "valet" ? <p><CheckCircle size={16} />{legacyValet ? "历史订单不追溯套用新的往返规则" : "检测后送回原取车地址，返程不另收费"}</p> : null}</section>
      {licenseMedia.length ? <section className="operator-uploaded-docs"><header><h2>预约上传资料</h2><small>行驶证正反面</small></header><div>{licenseMedia.map((item) => <figure key={item.id}><img src={item.url} alt={item.kind === "license_front" ? "行驶证正面" : "行驶证反面"} /><figcaption>{item.kind === "license_front" ? "行驶证正面" : "行驶证反面"}</figcaption></figure>)}</div></section> : null}
      {status === "on_hold" ? <section className="operator-hold-alert"><Warning size={20} /><span><strong>异常处理中：任务已挂起</strong><small>车辆信息不一致，请完成现场复核后恢复任务。</small></span></section> : null}
      <section className="operator-process-card"><header><h2>服务流程</h2><span>当前：{operatorStepCurrent(status)}</span></header><div className="operator-process-steps">{steps.map(([step, label, icon], index) => <div className={index <= currentIndex ? "reached" : index === currentIndex + 1 ? "next" : ""} key={step}><b>{index + 1}</b><span>{icon}</span><strong>{label}</strong><small>{index < currentIndex ? "已完成" : index === currentIndex ? "进行中" : "待进行"}</small></div>)}</div></section>
      <section className="operator-verification-card">
        <header><h2>到站核验清单</h2><span>核验时间 {booking.verification?.verifiedAt ? formatDateTime(booking.verification.verifiedAt).slice(-5) : "待确认"}</span></header>
        {verificationRows.map(([key, label, copy, icon]) => (
          <Fragment key={key}>
            <button role="checkbox" aria-checked={checks[key]} className={checks[key] ? "checked" : ""} data-testid={`verification-${key === "plateMatched" ? "plate" : key === "materialsReady" ? "materials" : key === "exteriorRecorded" ? "exterior" : "condition"}`} onClick={() => setChecks((current) => ({ ...current, [key]: !current[key] }))}><i>{checks[key] ? <Check size={13} weight="bold" /> : icon}</i><span><strong>{label}</strong><small>{copy}</small></span><em>{checks[key] ? "已通过" : "待核验"}</em></button>
            {key === "exteriorRecorded" ? <div className="operator-photo-grid">{vehicleMedia.length ? vehicleMedia.map((item) => { const label = bookingMediaSlots.find((slot) => slot.kind === item.kind)?.label || "车辆照片"; return <figure key={item.id}><img draggable="false" src={item.url} alt={`车主上传${label}`} /><figcaption>{label}</figcaption></figure>; }) : photos.map(([file, photoLabel]) => <figure key={file}><img draggable="false" src={`/assets/inspection/vehicle-${file}.png`} alt={`合成演示车辆${photoLabel}查验照片`} /><figcaption>{photoLabel}（合成演示）</figcaption></figure>)}</div> : null}
          </Fragment>
        ))}
      </section>
      {booking.inspectionResult ? <section className="operator-result-card"><span><SealCheck size={28} weight="duotone" /></span><div><small>外部结果已回传</small><strong>{booking.inspectionResult.conclusion === "passed" ? "本次检验结论：合格" : "请查看结果摘要"}</strong><p>{typeof booking.inspectionResult.summary === "string" ? booking.inspectionResult.summary : "检测结果摘要已通过接口回传"}</p></div></section> : null}
      <div className="operator-detail-actions">
        {status === "confirmed" ? <button className="primary-button" data-testid="operator-action-accept" disabled={busy} onClick={() => void act("accept")}>确认承接预约</button> : null}
        {status === "awaiting_arrival" ? <button className="primary-button" data-testid="operator-action-check-in" disabled={busy || !Object.values(checks).slice(0, 4).every(Boolean)} onClick={() => void act("check-in")}>确认车辆到站</button> : null}
        {status === "checked_in" ? <button className="primary-button" data-testid="operator-action-handoff" disabled={busy} onClick={() => void act("handoff")}>确认交接检测</button> : null}
        {status === "inspecting" ? <button className="primary-button" data-testid="operator-action-simulate-result" disabled={busy} onClick={() => void simulate()}><ArrowClockwise size={19} />模拟结果回传</button> : null}
        {status === "result_received" && booking.serviceMode !== "valet" ? <button className="primary-button" data-testid="operator-action-complete" disabled={busy} onClick={() => void act("complete")}>确认服务完成</button> : null}
        {status === "on_hold" ? <button className="primary-button" data-testid="operator-action-resolve-hold" disabled={busy} onClick={() => void act("resolve-hold")}>异常已处理，恢复核验</button> : null}
        {["awaiting_arrival", "checked_in"].includes(status) ? <button className="operator-hold-button" data-testid="operator-action-hold" disabled={busy} onClick={() => void act("hold")}><Warning size={18} />车辆信息不一致</button> : null}
      </div>
      <button className="operator-boundary-card" onClick={() => setBoundaryOpen(true)}><ShieldCheck size={23} /><span><strong>系统边界说明</strong><small>检测设备软件属于外部系统<br />结果回传方式：接口 / 人工上传</small></span><em>了解更多</em><CaretRight size={16} /></button>
      <BottomSheet open={boundaryOpen} onOpenChange={setBoundaryOpen} title="检测系统边界" description="小程序负责服务履约，不控制检测设备。"><div className="operator-boundary-sheet"><p><strong>本 MVP 处理：</strong>预约、到站核验、业务交接、结果回传与车主通知。</p><p><strong>外部系统处理：</strong>制动、灯光、尾气等设备采集与监管上报。</p><button className="primary-button" onClick={() => setBoundaryOpen(false)}>我知道了</button></div></BottomSheet>
    </main></MobileScroll>
  );
}

function EmptyState({ icon, title, copy, action, onAction }: { icon: ReactNode; title: string; copy: string; action: string; onAction: () => void }) {
  return <div className="empty-state"><span>{icon}</span><h2>{title}</h2><p>{copy}</p><button className="primary-button" onClick={onAction}>{action}</button></div>;
}

function vehiclePricingLabel(vehicle: Vehicle) {
  const vanLabel = vehicleIsVan(vehicle) ? " · 面包车" : "";
  return `${POWERTRAIN_LABELS[vehiclePowertrain(vehicle)]} · ${vehicleSeats(vehicle)} 座${vanLabel}`;
}

function quotePricingDetail(quote: BookingQuote) {
  const oneWayDistanceKm = Number(quote.oneWayDistanceKm ?? quote.distanceKm ?? 0);
  const baseFeeFen = Number(quote.breakdown?.valetBaseFeeFen ?? quote.rule?.baseFeeFen ?? 0);
  const includedKm = Number(quote.rule?.includedKm ?? 0);
  const extraKm = Math.max(0, Math.ceil(Number(quote.extraKm ?? oneWayDistanceKm - includedKm)));
  const perKmFen = Number(quote.rule?.perKmFen ?? 0);
  const valetFeeFen = Number(quote.breakdown?.valetFeeFen ?? quote.valetFeeFen ?? 0);
  return { oneWayDistanceKm, baseFeeFen, includedKm, extraKm, perKmFen, valetFeeFen };
}

function valetUnavailableReason(
  vehicle: Vehicle,
  quote: BookingQuote | null,
  quoteError: { code?: string; message: string } | null,
  address: PickupAddress | null,
  loading: boolean,
) {
  const manualReview = vehicleManualReviewReason(vehicle);
  if (vehicle.pricingEligibility === "manual_review" || manualReview) {
    return `该车辆需人工核验${manualReview ? `：${manualReview}` : ""}，暂不能使用上门取送；可改选自驾到站`;
  }
  if (!address || loading) return "";
  if (quoteError?.code === "TENCENT_QUOTA_EXCEEDED") {
    return "今日腾讯路线额度已用完，暂不能使用上门取送；可改选自驾到站";
  }
  if (quoteError?.code === "REAL_ROUTE_REQUIRED") {
    return "未取得腾讯真实驾车路线，暂不能使用上门取送；可改选自驾到站";
  }
  if (quoteError) {
    return `${quoteError.message || "真实路线计算失败"}；暂不能使用上门取送，可改选自驾到站`;
  }
  if (!quote) return "正在获取腾讯真实驾车路线";
  if (quote.pricingEligibility === "manual_review" || quote.reason === "manual_review" || quote.distanceSource === "manual_review") {
    return "该车辆的价格方案需人工核验，暂不能使用上门取送；可改选自驾到站";
  }
  if (quote.distanceSource !== "tencent_matrix") {
    return "未取得腾讯真实驾车路线，暂不展示或使用估算价；可改选自驾到站";
  }
  if (!quote.serviceable || quote.reason === "out_of_range") {
    return "取车地址超出当前上门取送范围；可改选自驾到站";
  }
  return "";
}

function bookingTimelineSteps(booking: Booking): Array<[BookingStatus, string, string]> {
  const common: Array<[BookingStatus, string, string]> = [
    ["pending_payment", "待支付", "预约已创建，等待模拟支付"],
    ["paid_pending_confirmation", "历史支付待确认", "兼容历史订单的恢复状态"],
    ["confirmed", "预约已确认", "支付成功后自动进入履约队列"],
  ];
  if (booking.serviceMode !== "valet") {
    return [
      ...common,
      ["awaiting_arrival", "等待到站", "请按预约时段自驾到站"],
      ["checked_in", "已到站核验", "站点核对车辆与材料"],
      ["inspecting", "检测中", "车辆已交接检测"],
      ["result_received", "结果已回传", "检测结果已进入订单"],
      ["completed", "服务完成", "本次服务已完成"],
    ];
  }
  return [
    ...common,
    ["driver_arranged", "已安排司机", "平台已在线下安排取送车司机"],
    ["picked_up", "司机已取车", "司机已完成车辆与资料交接"],
    ["awaiting_arrival", "前往检测站", "车辆正在送往检测站"],
    ["checked_in", "已到站核验", "站点核对车辆与材料"],
    ["inspecting", "检测中", "车辆已交接检测"],
    ["result_received", "结果已回传", "检测结果已进入订单"],
    ["returning", "返程送车", "司机正在将车辆送回原取车地址"],
    ["completed", "服务完成", "车辆已送回原地址，本次往返服务完成"],
  ];
}

function bookingStatusDescription(status: BookingStatus, serviceMode?: ServiceMode) {
  const labels: Record<BookingStatus, string> = {
    pending_payment: "预约已创建，完成模拟支付后将自动确认并进入履约队列。",
    paid_pending_confirmation: "历史订单待自动恢复；正常支付流程不再进入该状态。",
    confirmed: serviceMode === "valet" ? "预约已确认，平台将在线下安排取送车司机。" : "预约已确认，请按预约时段自驾到站。",
    driver_arranged: "平台已在线下安排司机，请留意联系信息。",
    picked_up: "司机已取到车辆，正在前往检测站。",
    awaiting_arrival: serviceMode === "valet" ? "车辆正由司机送往检测站。" : "请按预约时段自驾到站。",
    checked_in: "车辆已到站，工作人员正在核验车辆与材料。",
    inspecting: "车辆已进入检测流程。",
    result_received: serviceMode === "valet" ? "检测结果已回传，等待返程送车。" : "检测结果已回传，请查看结果。",
    returning: "司机正在把车辆送回原取车地址，返程不另收费。",
    completed: "本次服务已完成。",
    on_hold: "订单存在需线下处理的异常，请等待平台联系。",
    cancelled: "订单已取消。",
    no_show: "车辆未按预约时段到站。",
  };
  return labels[status];
}

function washStatusLabel(status: WashOrderStatus) {
  return ({
    pending_payment: "待支付",
    awaiting_redemption: "待核销",
    redeemed: "已核销",
    cancelled: "已取消",
    refunded: "已退款",
    expired: "已过期",
  } satisfies Record<WashOrderStatus, string>)[status];
}

function washStatusDescription(status: WashOrderStatus, serviceMode: ServiceMode = "self_drive") {
  return ({
    pending_payment: "请在 15 分钟内完成模拟支付，超时将释放时段。",
    awaiting_redemption: serviceMode === "valet" ? "预约已生效，等待车辆交接与运营线下核销。" : "预约已生效，到店后向店主出示六位核销码。",
    redeemed: "服务已经人工核销完成，核销码不可再次使用。",
    cancelled: "待支付预约已取消，当前时段已释放。",
    refunded: "预约已取消并完成模拟退款，核销码已失效。",
    expired: "支付占位已超时，当前时段已释放。",
  } satisfies Record<WashOrderStatus, string>)[status];
}

function washOrderTotalFen(order: Pick<WashOrder, "totalFeeFen" | "serviceFeeFen">) {
  return Number(order.totalFeeFen ?? order.serviceFeeFen ?? 0);
}

function washValetUnavailableReason(
  quote: WashQuote | null,
  quoteError: { code?: string; message: string; fields?: Record<string, unknown> } | null,
  address: PickupAddress | null,
  loading: boolean,
) {
  if (!address || loading) return "";
  if (quoteError?.code === "WASH_VALET_OUT_OF_RANGE") {
    const distance = Number(quoteError.fields?.oneWayDistanceKm);
    const radius = Number(quoteError.fields?.maxRadiusKm);
    const boundary = Number.isFinite(distance) && Number.isFinite(radius) ? `（单程 ${distance} km，服务半径 ${radius} km）` : "";
    return `取车地址超出该门店代驾服务半径${boundary}，可修改地址或改选自驾到店`;
  }
  if (quoteError?.code === "WASH_VALET_RULE_MISSING") return "该门店暂未配置代驾价格，可更换门店或改选自驾到店";
  if (quoteError?.code === "WASH_REAL_ROUTE_REQUIRED" || quoteError?.code === "TENCENT_QUOTA_EXCEEDED") return "未取得真实驾车路线，代驾暂不能报价；可稍后重试或改选自驾到店";
  if (quoteError) return `${quoteError.message || "代驾路线报价失败"}；可修改地址或改选自驾到店`;
  if (!quote) return "正在获取真实驾车路线";
  if (quote.distanceSource !== "tencent_matrix" || quote.distanceBasis !== "driving_route") return "当前未取得真实驾车路线，代驾暂不能报价";
  if (!quote.serviceable || quote.reason === "out_of_range") return "取车地址超出该门店代驾服务半径，可修改地址或改选自驾到店";
  return "";
}

function washSettlementLabel(status?: WashSettlementStatus) {
  if (!status) return "未结算";
  return ({ unsettled: "未结算", settled: "已线下结算", void: "无需结算" } satisfies Record<WashSettlementStatus, string>)[status];
}

function washEventLabel(type: string) {
  return ({ created: "预约已创建", paid: "模拟支付成功", rescheduled: "预约已改期", cancelled: "预约已取消", refunded: "模拟退款完成", redeemed: "人工核销完成", settlement_updated: "线下结算已更新" } as Record<string, string>)[type] || "订单已更新";
}

function paymentStatusLabel(status?: PaymentStatus) {
  if (!status) return "未记录";
  return ({ unpaid: "待支付", paid: "已支付", partially_refunded: "部分退款", refunded: "已退款" } satisfies Record<PaymentStatus, string>)[status];
}

function ledgerEntryLabel(type?: string) {
  return ({ inspection_fee: "年检服务费", valet_base_fee: "取送车起步价", valet_distance_fee: "取送车超程费", valet_fee: "上门取送车费（往返）", discount: "优惠", refund: "退款", adjustment: "费用调整", surcharge: "附加费用" } as Record<string, string>)[type || ""] || "订单费用";
}

function bookingStatusLabel(status: BookingStatus) {
  const labels: Record<BookingStatus, string> = {
    pending_payment: "待支付",
    paid_pending_confirmation: "已支付待确认",
    confirmed: "预约已确认",
    driver_arranged: "已安排司机",
    picked_up: "司机已取车",
    awaiting_arrival: "等待到站",
    checked_in: "已到站核验",
    inspecting: "检测中",
    result_received: "结果已回传",
    returning: "返程送车中",
    completed: "已完成",
    on_hold: "异常挂起",
    cancelled: "已取消",
    no_show: "未到站",
  };
  return labels[status];
}

function operatorStatusShort(status: BookingStatus) {
  const labels: Record<BookingStatus, string> = {
    pending_payment: "待支付",
    paid_pending_confirmation: "待平台确认",
    confirmed: "待确认",
    driver_arranged: "已派司机",
    picked_up: "已取车",
    awaiting_arrival: "待到站",
    checked_in: "已到站",
    inspecting: "检测中",
    result_received: "结果已回传",
    returning: "返程中",
    completed: "已完成",
    on_hold: "资料异常",
    cancelled: "已取消",
    no_show: "未到站",
  };
  return labels[status];
}

function operatorStatusHint(status: BookingStatus) {
  const labels: Record<BookingStatus, string> = {
    pending_payment: "等待车主支付",
    paid_pending_confirmation: "等待平台确认",
    confirmed: "等待接单",
    driver_arranged: "司机已安排",
    picked_up: "车辆在途",
    awaiting_arrival: "下一任务",
    checked_in: "待叫号",
    inspecting: "外检环节",
    result_received: "待完成",
    returning: "返程送车",
    completed: "结果已回传",
    on_hold: "需处理",
    cancelled: "时段已释放",
    no_show: "预计晚到",
  };
  return labels[status];
}

function operatorStepCurrent(status: BookingStatus) {
  if (["pending_payment", "paid_pending_confirmation", "confirmed"].includes(status)) return "预约确认";
  if (["driver_arranged", "picked_up"].includes(status)) return "上门取车";
  if (status === "awaiting_arrival") return "前往检测站";
  if (["checked_in", "on_hold"].includes(status)) return "到站核验";
  if (status === "inspecting") return "交接检测";
  if (status === "result_received") return "结果回传";
  if (status === "returning") return "返程送车";
  return status === "completed" ? "服务完成" : bookingStatusLabel(status);
}

function operatorActionSuccess(action: OperatorAction) {
  return { accept: "预约已确认", "check-in": "到站核验已完成", hold: "任务已挂起，请处理异常", "resolve-hold": "异常已解决，任务已恢复", handoff: "车辆已交接外部检测系统", complete: "本次服务已完成" }[action];
}

function formatOperatorDate(date: string) {
  const [, month, day] = date.split("-");
  return `${month}-${day}（${formatChineseWeekday(date)}）`;
}

function formatStationDistance(station: Pick<Station, "distanceKm" | "driveMinutes" | "distanceBasis" | "distanceSource">) {
  if (station.distanceKm === null || station.driveMinutes === null) return "确定起点后计算";
  const prefix = station.distanceSource === "tencent_matrix" ? "腾讯实算 " : station.distanceBasis === "estimated_distance" ? "预计（非路线） " : "";
  return `${prefix}${station.distanceKm} km · 驾车约 ${station.driveMinutes} 分钟`;
}

function formatQuoteDistance(quote: BookingQuote | null) {
  if (!quote || quote.distanceKm === null) return "确定取车地址后计算";
  if (quote.distanceSource !== "tencent_matrix") return "未取得腾讯真实路线，暂不计价";
  const distance = quote.oneWayDistanceKm ?? quote.distanceKm;
  const duration = quote.driveMinutes === null || quote.driveMinutes === undefined ? "" : ` · 约 ${quote.driveMinutes} 分钟`;
  return `腾讯单程 ${distance} km${duration}`;
}

function formatMoney(fen: number) { return (fen / 100).toFixed(2).replace(/\.00$/, ""); }
function formatDateLabel(date: string) { const [, month, day] = date.split("-"); return `${Number(month)} 月 ${Number(day)} 日`; }
function formatDateTime(value: string) { return value ? value.replace("T", " ").slice(0, 16) : ""; }
function formatLocalDateTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDateTime(value);
  const twoDigits = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function RoleAwareFlowStack() {
  const { appRole } = useMvp();
  const previewScreen = new URLSearchParams(window.location.search).get("screen");
  const initial = appRole === "operator" ? operatorRootScreen() : previewScreen === "wash" ? washBookingScreen() : previewScreen === "insurance" ? insuranceLeadScreen() : previewScreen === "car-rental" ? rentalHomeScreen() : homeScreen();
  return <FlowStack key={`${appRole}-${previewScreen || "home"}`} initial={initial} />;
}

export default function Prototype() {
  return <MvpProvider><WashProvider><RentalProvider><InsuranceLeadProvider><RoleAwareFlowStack /></InsuranceLeadProvider></RentalProvider></WashProvider></MvpProvider>;
}
