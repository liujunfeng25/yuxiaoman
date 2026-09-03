import type { AppDatabase } from "./database.js";

export const USED_CAR_SEED_MARKER = "used-car-seed-v6";
const USED_CAR_ASSET_VERSION = "real-model-v1";

export const USED_CAR_BRAND_IDS = {
  li: "brand-li",
  byd: "brand-byd",
  tesla: "brand-tesla",
  bmw: "brand-bmw",
  mercedes: "brand-mercedes",
  audi: "brand-audi",
  toyota: "brand-toyota",
  honda: "brand-honda",
  volkswagen: "brand-volkswagen",
  nio: "brand-nio",
  xpeng: "brand-xpeng",
  zeekr: "brand-zeekr",
  aito: "brand-aito",
  hongqi: "brand-hongqi",
  xiaomi: "brand-xiaomi",
} as const;

export const USED_CAR_MODEL_IDS = {
  liL7: "model-li-l7",
} as const;

export type UsedCarSeedOptions = {
  force?: boolean;
  now?: string;
};

type DemoBrand = {
  id: string;
  name: string;
  initial: string;
  isHot: boolean;
};

type DemoModel = {
  id: string;
  brandId: string;
  name: string;
  bodyType: "sedan" | "suv" | "mpv" | "hatchback" | "coupe" | "pickup";
  energyType: "petrol" | "diesel" | "hybrid" | "plug_in_hybrid" | "electric" | "range_extended";
};

type DemoListing = {
  modelId: string;
  title: string;
  modelYear: number;
  registrationDate: string;
  mileageKm: number;
  priceFen: number;
  originalPriceFen: number;
  location: string;
  exteriorColor: string;
  interiorColor: string;
  transmission: "automatic" | "manual" | "cvt" | "dct" | "single_speed" | "e_cvt";
  seats: number;
  highlights: string[];
  status: "draft" | "on_sale" | "reserved" | "sold" | "offline";
};

const DEMO_BRANDS: DemoBrand[] = [
  { id: USED_CAR_BRAND_IDS.li, name: "理想", initial: "L", isHot: true },
  { id: USED_CAR_BRAND_IDS.byd, name: "比亚迪", initial: "B", isHot: true },
  { id: USED_CAR_BRAND_IDS.tesla, name: "特斯拉", initial: "T", isHot: true },
  { id: USED_CAR_BRAND_IDS.bmw, name: "宝马", initial: "B", isHot: true },
  { id: USED_CAR_BRAND_IDS.mercedes, name: "奔驰", initial: "B", isHot: true },
  { id: USED_CAR_BRAND_IDS.audi, name: "奥迪", initial: "A", isHot: false },
  { id: USED_CAR_BRAND_IDS.toyota, name: "丰田", initial: "F", isHot: false },
  { id: USED_CAR_BRAND_IDS.honda, name: "本田", initial: "B", isHot: false },
  { id: USED_CAR_BRAND_IDS.volkswagen, name: "大众", initial: "D", isHot: false },
  { id: USED_CAR_BRAND_IDS.nio, name: "蔚来", initial: "W", isHot: false },
  { id: USED_CAR_BRAND_IDS.xpeng, name: "小鹏", initial: "X", isHot: false },
  { id: USED_CAR_BRAND_IDS.zeekr, name: "极氪", initial: "J", isHot: false },
  { id: USED_CAR_BRAND_IDS.aito, name: "问界", initial: "W", isHot: false },
  { id: USED_CAR_BRAND_IDS.hongqi, name: "红旗", initial: "H", isHot: false },
  { id: USED_CAR_BRAND_IDS.xiaomi, name: "小米汽车", initial: "X", isHot: false },
];

const BRAND_PINYIN_SORT_ORDER = new Map<string, number>([
  [USED_CAR_BRAND_IDS.audi, 100],
  [USED_CAR_BRAND_IDS.bmw, 400],
  [USED_CAR_BRAND_IDS.mercedes, 300],
  [USED_CAR_BRAND_IDS.honda, 200],
  [USED_CAR_BRAND_IDS.byd, 100],
  [USED_CAR_BRAND_IDS.volkswagen, 100],
  [USED_CAR_BRAND_IDS.toyota, 100],
  [USED_CAR_BRAND_IDS.hongqi, 100],
  [USED_CAR_BRAND_IDS.zeekr, 100],
  [USED_CAR_BRAND_IDS.li, 100],
  [USED_CAR_BRAND_IDS.tesla, 100],
  [USED_CAR_BRAND_IDS.nio, 200],
  [USED_CAR_BRAND_IDS.aito, 100],
  [USED_CAR_BRAND_IDS.xiaomi, 200],
  [USED_CAR_BRAND_IDS.xpeng, 100],
]);

const DEMO_MODELS: DemoModel[] = [
  { id: "model-audi-a4l", brandId: USED_CAR_BRAND_IDS.audi, name: "A4L", bodyType: "sedan", energyType: "petrol" },
  { id: "model-audi-a6l", brandId: USED_CAR_BRAND_IDS.audi, name: "A6L", bodyType: "sedan", energyType: "petrol" },
  { id: "model-audi-q5l", brandId: USED_CAR_BRAND_IDS.audi, name: "Q5L", bodyType: "suv", energyType: "petrol" },

  { id: "model-bmw-3-series", brandId: USED_CAR_BRAND_IDS.bmw, name: "3系", bodyType: "sedan", energyType: "petrol" },
  { id: "model-bmw-5-series", brandId: USED_CAR_BRAND_IDS.bmw, name: "5系", bodyType: "sedan", energyType: "petrol" },
  { id: "model-bmw-x3", brandId: USED_CAR_BRAND_IDS.bmw, name: "X3", bodyType: "suv", energyType: "petrol" },

  { id: "model-mercedes-c-class", brandId: USED_CAR_BRAND_IDS.mercedes, name: "C级", bodyType: "sedan", energyType: "petrol" },
  { id: "model-mercedes-e-class", brandId: USED_CAR_BRAND_IDS.mercedes, name: "E级", bodyType: "sedan", energyType: "petrol" },
  { id: "model-mercedes-glc", brandId: USED_CAR_BRAND_IDS.mercedes, name: "GLC", bodyType: "suv", energyType: "petrol" },

  { id: "model-byd-qin-plus", brandId: USED_CAR_BRAND_IDS.byd, name: "秦PLUS DM-i", bodyType: "sedan", energyType: "plug_in_hybrid" },
  { id: "model-byd-han", brandId: USED_CAR_BRAND_IDS.byd, name: "汉DM-i", bodyType: "sedan", energyType: "plug_in_hybrid" },
  { id: "model-byd-song-plus", brandId: USED_CAR_BRAND_IDS.byd, name: "宋PLUS DM-i", bodyType: "suv", energyType: "plug_in_hybrid" },
  { id: "model-byd-tang", brandId: USED_CAR_BRAND_IDS.byd, name: "唐DM-i", bodyType: "suv", energyType: "plug_in_hybrid" },
  { id: "model-byd-seal", brandId: USED_CAR_BRAND_IDS.byd, name: "海豹06 DM-i", bodyType: "sedan", energyType: "plug_in_hybrid" },

  { id: "model-honda-accord", brandId: USED_CAR_BRAND_IDS.honda, name: "雅阁", bodyType: "sedan", energyType: "petrol" },
  { id: "model-honda-crv", brandId: USED_CAR_BRAND_IDS.honda, name: "CR-V", bodyType: "suv", energyType: "hybrid" },
  { id: "model-honda-odyssey", brandId: USED_CAR_BRAND_IDS.honda, name: "奥德赛", bodyType: "mpv", energyType: "hybrid" },

  { id: "model-volkswagen-magotan", brandId: USED_CAR_BRAND_IDS.volkswagen, name: "迈腾", bodyType: "sedan", energyType: "petrol" },
  { id: "model-volkswagen-tiguan-l", brandId: USED_CAR_BRAND_IDS.volkswagen, name: "途观L", bodyType: "suv", energyType: "petrol" },
  { id: "model-volkswagen-id4x", brandId: USED_CAR_BRAND_IDS.volkswagen, name: "ID.4 X", bodyType: "suv", energyType: "electric" },

  { id: "model-toyota-camry", brandId: USED_CAR_BRAND_IDS.toyota, name: "凯美瑞", bodyType: "sedan", energyType: "hybrid" },
  { id: "model-toyota-rav4", brandId: USED_CAR_BRAND_IDS.toyota, name: "RAV4荣放", bodyType: "suv", energyType: "hybrid" },
  { id: "model-toyota-highlander", brandId: USED_CAR_BRAND_IDS.toyota, name: "汉兰达", bodyType: "suv", energyType: "hybrid" },

  { id: "model-hongqi-h5", brandId: USED_CAR_BRAND_IDS.hongqi, name: "H5", bodyType: "sedan", energyType: "petrol" },
  { id: "model-hongqi-hs5", brandId: USED_CAR_BRAND_IDS.hongqi, name: "HS5", bodyType: "suv", energyType: "petrol" },

  { id: "model-zeekr-001", brandId: USED_CAR_BRAND_IDS.zeekr, name: "001", bodyType: "hatchback", energyType: "electric" },
  { id: "model-zeekr-007", brandId: USED_CAR_BRAND_IDS.zeekr, name: "007", bodyType: "sedan", energyType: "electric" },
  { id: "model-zeekr-7x", brandId: USED_CAR_BRAND_IDS.zeekr, name: "7X", bodyType: "suv", energyType: "electric" },

  { id: "model-li-l6", brandId: USED_CAR_BRAND_IDS.li, name: "L6", bodyType: "suv", energyType: "range_extended" },
  { id: USED_CAR_MODEL_IDS.liL7, brandId: USED_CAR_BRAND_IDS.li, name: "L7", bodyType: "suv", energyType: "range_extended" },
  { id: "model-li-l8", brandId: USED_CAR_BRAND_IDS.li, name: "L8", bodyType: "suv", energyType: "range_extended" },
  { id: "model-li-l9", brandId: USED_CAR_BRAND_IDS.li, name: "L9", bodyType: "suv", energyType: "range_extended" },

  { id: "model-tesla-model-3", brandId: USED_CAR_BRAND_IDS.tesla, name: "Model 3", bodyType: "sedan", energyType: "electric" },
  { id: "model-tesla-model-y", brandId: USED_CAR_BRAND_IDS.tesla, name: "Model Y", bodyType: "suv", energyType: "electric" },

  { id: "model-aito-m5", brandId: USED_CAR_BRAND_IDS.aito, name: "M5", bodyType: "suv", energyType: "range_extended" },
  { id: "model-aito-m7", brandId: USED_CAR_BRAND_IDS.aito, name: "M7", bodyType: "suv", energyType: "range_extended" },
  { id: "model-aito-m9", brandId: USED_CAR_BRAND_IDS.aito, name: "M9", bodyType: "suv", energyType: "range_extended" },

  { id: "model-nio-et5", brandId: USED_CAR_BRAND_IDS.nio, name: "ET5", bodyType: "sedan", energyType: "electric" },
  { id: "model-nio-et5t", brandId: USED_CAR_BRAND_IDS.nio, name: "ET5T", bodyType: "hatchback", energyType: "electric" },
  { id: "model-nio-es6", brandId: USED_CAR_BRAND_IDS.nio, name: "ES6", bodyType: "suv", energyType: "electric" },

  { id: "model-xpeng-mona-m03", brandId: USED_CAR_BRAND_IDS.xpeng, name: "MONA M03", bodyType: "sedan", energyType: "electric" },
  { id: "model-xpeng-p7i", brandId: USED_CAR_BRAND_IDS.xpeng, name: "P7i", bodyType: "sedan", energyType: "electric" },
  { id: "model-xpeng-g6", brandId: USED_CAR_BRAND_IDS.xpeng, name: "G6", bodyType: "suv", energyType: "electric" },
  { id: "model-xpeng-g9", brandId: USED_CAR_BRAND_IDS.xpeng, name: "G9", bodyType: "suv", energyType: "electric" },

  { id: "model-xiaomi-su7", brandId: USED_CAR_BRAND_IDS.xiaomi, name: "SU7", bodyType: "sedan", energyType: "electric" },
  { id: "model-xiaomi-yu7", brandId: USED_CAR_BRAND_IDS.xiaomi, name: "YU7", bodyType: "suv", energyType: "electric" },
];

const DEMO_LISTINGS: DemoListing[] = [
  {
    modelId: USED_CAR_MODEL_IDS.liL7,
    title: "2024款 理想L7 Ultra 四驱旗舰版",
    modelYear: 2024,
    registrationDate: "2024-05-18",
    mileageKm: 16800,
    priceFen: 28680000,
    originalPriceFen: 37980000,
    location: "天津·河西区",
    exteriorColor: "银灰色",
    interiorColor: "橙色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["一手车", "原版原漆", "全程店保"],
    status: "on_sale",
  },
  {
    modelId: USED_CAR_MODEL_IDS.liL7,
    title: "2024款 理想L7 Pro 智能焕新版",
    modelYear: 2024,
    registrationDate: "2024-09-06",
    mileageKm: 9200,
    priceFen: 27380000,
    originalPriceFen: 34980000,
    location: "天津·南开区",
    exteriorColor: "黑色",
    interiorColor: "白色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["低里程", "无重大事故", "支持复检"],
    status: "on_sale",
  },
  {
    modelId: USED_CAR_MODEL_IDS.liL7,
    title: "2023款 理想L7 Max 四驱版",
    modelYear: 2023,
    registrationDate: "2023-08-22",
    mileageKm: 31600,
    priceFen: 25480000,
    originalPriceFen: 37980000,
    location: "天津·滨海新区",
    exteriorColor: "绿色",
    interiorColor: "棕色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["车况透明", "电池检测", "可分期"],
    status: "on_sale",
  },
  {
    modelId: USED_CAR_MODEL_IDS.liL7,
    title: "2023款 理想L7 Air 四驱版",
    modelYear: 2023,
    registrationDate: "2023-11-15",
    mileageKm: 24800,
    priceFen: 23980000,
    originalPriceFen: 31980000,
    location: "天津·河东区",
    exteriorColor: "白色",
    interiorColor: "黑色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["个人一手", "保养记录齐全", "到店可试驾"],
    status: "on_sale",
  },
  {
    modelId: "model-li-l8",
    title: "2023款 理想L8 Pro 六座版",
    modelYear: 2023,
    registrationDate: "2023-06-20",
    mileageKm: 38200,
    priceFen: 26880000,
    originalPriceFen: 35980000,
    location: "天津·西青区",
    exteriorColor: "蓝色",
    interiorColor: "棕色",
    transmission: "single_speed",
    seats: 6,
    highlights: ["六座SUV", "原厂质保", "支持置换"],
    status: "on_sale",
  },
  {
    modelId: "model-byd-han",
    title: "2023款 比亚迪汉DM-i 冠军版",
    modelYear: 2023,
    registrationDate: "2023-10-11",
    mileageKm: 22600,
    priceFen: 16880000,
    originalPriceFen: 24980000,
    location: "天津·和平区",
    exteriorColor: "红色",
    interiorColor: "黑色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["刀片电池", "无火烧水泡", "三电检测"],
    status: "on_sale",
  },
  {
    modelId: "model-byd-song-plus",
    title: "2023款 宋PLUS DM-i 旗舰型",
    modelYear: 2023,
    registrationDate: "2023-04-03",
    mileageKm: 40500,
    priceFen: 11880000,
    originalPriceFen: 16980000,
    location: "天津·北辰区",
    exteriorColor: "白色",
    interiorColor: "黑色",
    transmission: "e_cvt",
    seats: 5,
    highlights: ["混动低油耗", "家用精品", "可查维保"],
    status: "on_sale",
  },
  {
    modelId: "model-tesla-model-3",
    title: "2022款 特斯拉Model 3 后轮驱动版",
    modelYear: 2022,
    registrationDate: "2022-12-09",
    mileageKm: 46200,
    priceFen: 13980000,
    originalPriceFen: 26590000,
    location: "天津·南开区",
    exteriorColor: "白色",
    interiorColor: "黑色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["个人车源", "三电正常", "支持第三方检测"],
    status: "on_sale",
  },
  {
    modelId: "model-tesla-model-y",
    title: "2023款 特斯拉Model Y 长续航版",
    modelYear: 2023,
    registrationDate: "2023-07-17",
    mileageKm: 29100,
    priceFen: 20980000,
    originalPriceFen: 31390000,
    location: "天津·河西区",
    exteriorColor: "黑色",
    interiorColor: "白色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["长续航", "车况优秀", "随车充电设备"],
    status: "on_sale",
  },
  {
    modelId: "model-bmw-3-series",
    title: "2022款 宝马325Li M运动套装",
    modelYear: 2022,
    registrationDate: "2022-06-26",
    mileageKm: 51800,
    priceFen: 21880000,
    originalPriceFen: 34690000,
    location: "天津·红桥区",
    exteriorColor: "蓝色",
    interiorColor: "黑色",
    transmission: "automatic",
    seats: 5,
    highlights: ["长轴运动版", "4S店保养", "无结构损伤"],
    status: "on_sale",
  },
  {
    modelId: "model-bmw-x3",
    title: "2021款 宝马X3 xDrive28i 豪华套装",
    modelYear: 2021,
    registrationDate: "2021-09-08",
    mileageKm: 59600,
    priceFen: 24980000,
    originalPriceFen: 42580000,
    location: "天津·东丽区",
    exteriorColor: "黑色",
    interiorColor: "棕色",
    transmission: "automatic",
    seats: 5,
    highlights: ["四驱", "全景天窗", "精品车况"],
    status: "on_sale",
  },
  {
    modelId: "model-mercedes-c-class",
    title: "2022款 奔驰C260L 运动版",
    modelYear: 2022,
    registrationDate: "2022-10-16",
    mileageKm: 33700,
    priceFen: 23880000,
    originalPriceFen: 35120000,
    location: "天津·河西区",
    exteriorColor: "白色",
    interiorColor: "红色",
    transmission: "automatic",
    seats: 5,
    highlights: ["内饰成色佳", "可查记录", "支持贷款"],
    status: "on_sale",
  },
  {
    modelId: "model-mercedes-glc",
    title: "2021款 奔驰GLC 260 L 4MATIC",
    modelYear: 2021,
    registrationDate: "2021-11-29",
    mileageKm: 62800,
    priceFen: 26880000,
    originalPriceFen: 39780000,
    location: "天津·津南区",
    exteriorColor: "黑色",
    interiorColor: "黑色",
    transmission: "automatic",
    seats: 5,
    highlights: ["四驱", "空间宽敞", "无重大事故"],
    status: "on_sale",
  },
  {
    modelId: "model-audi-a4l",
    title: "2022款 奥迪A4L 40 TFSI 时尚动感型",
    modelYear: 2022,
    registrationDate: "2022-05-12",
    mileageKm: 44700,
    priceFen: 19880000,
    originalPriceFen: 32180000,
    location: "天津·河北区",
    exteriorColor: "灰色",
    interiorColor: "黑色",
    transmission: "dct",
    seats: 5,
    highlights: ["动感外观", "维保齐全", "价格透明"],
    status: "on_sale",
  },
  {
    modelId: "model-audi-q5l",
    title: "2021款 奥迪Q5L 40T 豪华动感型",
    modelYear: 2021,
    registrationDate: "2021-07-23",
    mileageKm: 68900,
    priceFen: 25880000,
    originalPriceFen: 44520000,
    location: "天津·滨海新区",
    exteriorColor: "白色",
    interiorColor: "黑色",
    transmission: "dct",
    seats: 5,
    highlights: ["豪华配置", "四驱", "可置换"],
    status: "on_sale",
  },
  {
    modelId: "model-toyota-camry",
    title: "2022款 凯美瑞 双擎豪华版",
    modelYear: 2022,
    registrationDate: "2022-08-05",
    mileageKm: 53400,
    priceFen: 15880000,
    originalPriceFen: 23980000,
    location: "天津·武清区",
    exteriorColor: "银色",
    interiorColor: "黑色",
    transmission: "e_cvt",
    seats: 5,
    highlights: ["双擎省油", "保值家用", "车况稳定"],
    status: "on_sale",
  },
  {
    modelId: "model-toyota-rav4",
    title: "2021款 RAV4荣放 双擎精英四驱版",
    modelYear: 2021,
    registrationDate: "2021-04-19",
    mileageKm: 71100,
    priceFen: 14980000,
    originalPriceFen: 24380000,
    location: "天津·宝坻区",
    exteriorColor: "白色",
    interiorColor: "黑色",
    transmission: "e_cvt",
    seats: 5,
    highlights: ["四驱双擎", "通过复检", "底盘整洁"],
    status: "on_sale",
  },
  {
    modelId: "model-honda-accord",
    title: "2022款 本田雅阁 260TURBO 豪华版",
    modelYear: 2022,
    registrationDate: "2022-09-13",
    mileageKm: 39200,
    priceFen: 14580000,
    originalPriceFen: 20280000,
    location: "天津·河东区",
    exteriorColor: "黑色",
    interiorColor: "黑色",
    transmission: "cvt",
    seats: 5,
    highlights: ["低里程", "经典家用", "支持试驾"],
    status: "on_sale",
  },
  {
    modelId: "model-honda-crv",
    title: "2021款 本田CR-V 锐·混动净速版",
    modelYear: 2021,
    registrationDate: "2021-06-14",
    mileageKm: 64500,
    priceFen: 14280000,
    originalPriceFen: 22180000,
    location: "天津·北辰区",
    exteriorColor: "灰色",
    interiorColor: "黑色",
    transmission: "e_cvt",
    seats: 5,
    highlights: ["油电混动", "空间实用", "全程可追溯"],
    status: "on_sale",
  },
  {
    modelId: "model-volkswagen-magotan",
    title: "2022款 大众迈腾 330TSI 豪华版",
    modelYear: 2022,
    registrationDate: "2022-07-30",
    mileageKm: 48600,
    priceFen: 15380000,
    originalPriceFen: 22890000,
    location: "天津·和平区",
    exteriorColor: "黑色",
    interiorColor: "棕色",
    transmission: "dct",
    seats: 5,
    highlights: ["商务家用", "星空前脸", "保养记录齐"],
    status: "on_sale",
  },
  {
    modelId: "model-volkswagen-tiguan-l",
    title: "2021款 大众途观L 330TSI 两驱智享版",
    modelYear: 2021,
    registrationDate: "2021-12-12",
    mileageKm: 57400,
    priceFen: 15880000,
    originalPriceFen: 23580000,
    location: "天津·西青区",
    exteriorColor: "白色",
    interiorColor: "黑色",
    transmission: "dct",
    seats: 5,
    highlights: ["空间充裕", "车况良好", "支持分期"],
    status: "on_sale",
  },
  {
    modelId: "model-nio-es6",
    title: "2023款 蔚来ES6 75kWh",
    modelYear: 2023,
    registrationDate: "2023-09-21",
    mileageKm: 19800,
    priceFen: 23880000,
    originalPriceFen: 33800000,
    location: "天津·河西区",
    exteriorColor: "蓝色",
    interiorColor: "米色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["支持换电", "低里程", "智能座舱"],
    status: "on_sale",
  },
  {
    modelId: "model-xpeng-g6",
    title: "2023款 小鹏G6 755超长续航版",
    modelYear: 2023,
    registrationDate: "2023-12-02",
    mileageKm: 14300,
    priceFen: 17680000,
    originalPriceFen: 23490000,
    location: "天津·南开区",
    exteriorColor: "银色",
    interiorColor: "白色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["800V平台", "超长续航", "智能驾驶"],
    status: "on_sale",
  },
  {
    modelId: "model-zeekr-001",
    title: "2022款 极氪001 超长续航双电机YOU版",
    modelYear: 2022,
    registrationDate: "2022-11-25",
    mileageKm: 36800,
    priceFen: 20880000,
    originalPriceFen: 36800000,
    location: "天津·滨海新区",
    exteriorColor: "灰色",
    interiorColor: "蓝白色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["双电机", "空气悬架", "猎装空间"],
    status: "on_sale",
  },
  {
    modelId: "model-aito-m7",
    title: "2024款 问界M7 Ultra 五座后驱版",
    modelYear: 2024,
    registrationDate: "2024-10-08",
    mileageKm: 6800,
    priceFen: 25880000,
    originalPriceFen: 28980000,
    location: "天津·津南区",
    exteriorColor: "黑色",
    interiorColor: "棕色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["待完成入库检测", "低里程", "增程SUV"],
    status: "draft",
  },
  {
    modelId: "model-honda-odyssey",
    title: "2022款 本田奥德赛 锐·耀享版",
    modelYear: 2022,
    registrationDate: "2022-03-18",
    mileageKm: 82500,
    priceFen: 21980000,
    originalPriceFen: 33990000,
    location: "天津·东丽区",
    exteriorColor: "香槟金",
    interiorColor: "棕色",
    transmission: "e_cvt",
    seats: 7,
    highlights: ["七座MPV", "油电混动", "待补充图集"],
    status: "draft",
  },
  {
    modelId: "model-byd-tang",
    title: "2022款 比亚迪唐DM-i 尊荣型",
    modelYear: 2022,
    registrationDate: "2022-08-28",
    mileageKm: 49800,
    priceFen: 14880000,
    originalPriceFen: 22980000,
    location: "天津·北辰区",
    exteriorColor: "灰色",
    interiorColor: "黑色",
    transmission: "e_cvt",
    seats: 7,
    highlights: ["已锁定", "七座混动", "定金保留中"],
    status: "reserved",
  },
  {
    modelId: "model-mercedes-e-class",
    title: "2020款 奔驰E300L 豪华型",
    modelYear: 2020,
    registrationDate: "2020-10-10",
    mileageKm: 89300,
    priceFen: 24880000,
    originalPriceFen: 49890000,
    location: "天津·河西区",
    exteriorColor: "黑色",
    interiorColor: "棕色",
    transmission: "automatic",
    seats: 5,
    highlights: ["已成交", "全景天窗", "柏林之声"],
    status: "sold",
  },
  {
    modelId: "model-tesla-model-y",
    title: "2022款 特斯拉Model Y 后轮驱动版",
    modelYear: 2022,
    registrationDate: "2022-05-06",
    mileageKm: 65100,
    priceFen: 16880000,
    originalPriceFen: 30180000,
    location: "天津·南开区",
    exteriorColor: "白色",
    interiorColor: "黑色",
    transmission: "single_speed",
    seats: 5,
    highlights: ["已成交", "三电正常", "个人一手"],
    status: "sold",
  },
  {
    modelId: "model-audi-a6l",
    title: "2021款 奥迪A6L 45 TFSI quattro",
    modelYear: 2021,
    registrationDate: "2021-05-27",
    mileageKm: 76200,
    priceFen: 26880000,
    originalPriceFen: 46880000,
    location: "天津·滨海新区",
    exteriorColor: "黑色",
    interiorColor: "黑色",
    transmission: "dct",
    seats: 5,
    highlights: ["暂时下架", "四驱", "待复检"],
    status: "offline",
  },
];

function assertDemoDataInvariants(): void {
  if (DEMO_BRANDS.length !== 15) {
    throw new Error(`Used-car demo seed must contain 15 brands; got ${DEMO_BRANDS.length}`);
  }
  if (DEMO_MODELS.length !== 46) {
    throw new Error(`Used-car demo seed must contain 46 models; got ${DEMO_MODELS.length}`);
  }
  if (DEMO_LISTINGS.length !== 30) {
    throw new Error(`Used-car demo seed must contain 30 listings; got ${DEMO_LISTINGS.length}`);
  }

  const expectedStatuses: Record<DemoListing["status"], number> = {
    on_sale: 24,
    draft: 2,
    reserved: 1,
    sold: 2,
    offline: 1,
  };
  const actualStatuses = DEMO_LISTINGS.reduce<Record<DemoListing["status"], number>>(
    (counts, listing) => {
      counts[listing.status] += 1;
      return counts;
    },
    { on_sale: 0, draft: 0, reserved: 0, sold: 0, offline: 0 },
  );
  for (const status of Object.keys(expectedStatuses) as DemoListing["status"][]) {
    if (actualStatuses[status] !== expectedStatuses[status]) {
      throw new Error(
        `Used-car demo seed status ${status} must contain ${expectedStatuses[status]} listings; got ${actualStatuses[status]}`,
      );
    }
  }

  const liL7Count = DEMO_LISTINGS.filter((listing) => listing.modelId === USED_CAR_MODEL_IDS.liL7).length;
  if (liL7Count < 4) {
    throw new Error(`Used-car demo seed must contain at least 4 Li L7 listings; got ${liL7Count}`);
  }
}

export async function migrateUsedCarDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS used_car_brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      logo_url TEXT NOT NULL,
      initial TEXT NOT NULL CHECK (length(initial) BETWEEN 1 AND 2),
      is_hot INTEGER NOT NULL DEFAULT 0 CHECK (is_hot IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS used_car_models (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES used_car_brands(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      cover_image_url TEXT,
      body_type TEXT NOT NULL CHECK (
        body_type IN ('sedan', 'suv', 'mpv', 'hatchback', 'coupe', 'pickup')
      ),
      energy_type TEXT NOT NULL CHECK (
        energy_type IN ('petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'range_extended')
      ),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (brand_id, name)
    );

    CREATE TABLE IF NOT EXISTS used_car_listings (
      id TEXT PRIMARY KEY,
      stock_no TEXT NOT NULL UNIQUE,
      model_id TEXT NOT NULL REFERENCES used_car_models(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      trim_name TEXT NOT NULL DEFAULT '',
      model_year INTEGER NOT NULL CHECK (model_year BETWEEN 1990 AND 2100),
      registration_date TEXT NOT NULL CHECK (length(registration_date) = 10),
      mileage_km INTEGER NOT NULL CHECK (mileage_km >= 0),
      price_fen INTEGER NOT NULL CHECK (price_fen > 0),
      original_price_fen INTEGER CHECK (
        original_price_fen IS NULL OR original_price_fen >= price_fen
      ),
      location TEXT NOT NULL,
      exterior_color TEXT NOT NULL,
      interior_color TEXT,
      transfer_count INTEGER NOT NULL DEFAULT 0 CHECK (transfer_count >= 0),
      energy_type TEXT NOT NULL CHECK (
        energy_type IN ('petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'range_extended')
      ),
      transmission TEXT NOT NULL CHECK (
        transmission IN ('automatic', 'manual', 'cvt', 'dct', 'single_speed', 'e_cvt')
      ),
      seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 99),
      highlights_json TEXT NOT NULL DEFAULT '[]',
      condition_summary TEXT NOT NULL DEFAULT '',
      defects_json TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'on_sale', 'reserved', 'sold', 'offline')
      ),
      sort_priority INTEGER NOT NULL DEFAULT 0,
      is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
      data_kind TEXT NOT NULL DEFAULT 'company_inventory' CHECK (
        data_kind IN ('synthetic_demo', 'company_inventory')
      ),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS used_car_listing_images (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES used_car_listings(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      image_url TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS used_car_brands_catalog_index
      ON used_car_brands(is_active, is_hot DESC, sort_order, initial, id);
    CREATE INDEX IF NOT EXISTS used_car_models_brand_catalog_index
      ON used_car_models(brand_id, is_active, sort_order, id);
    CREATE INDEX IF NOT EXISTS used_car_listings_model_status_sort_index
      ON used_car_listings(model_id, status, sort_priority DESC, published_at DESC, id);
    CREATE INDEX IF NOT EXISTS used_car_listings_status_price_index
      ON used_car_listings(status, price_fen, id);
    CREATE INDEX IF NOT EXISTS used_car_listings_status_created_index
      ON used_car_listings(status, created_at DESC, id);
    CREATE INDEX IF NOT EXISTS used_car_listing_images_listing_sort_index
      ON used_car_listing_images(listing_id, sort_order, id);
    CREATE UNIQUE INDEX IF NOT EXISTS used_car_listing_images_one_cover_unique
      ON used_car_listing_images(listing_id)
      WHERE is_cover = 1;
  `);

}

export async function clearUsedCarData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM used_car_listing_images;
    DELETE FROM used_car_listings;
    DELETE FROM used_car_models;
    DELETE FROM used_car_brands;
  `);
}

export async function seedUsedCarDemoData(
  database: AppDatabase,
  options: UsedCarSeedOptions = {},
): Promise<void> {
  const alreadyApplied = Boolean(
    await database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(USED_CAR_SEED_MARKER),
  );
  if (!options.force && alreadyApplied) return;

  assertDemoDataInvariants();

  if (!options.force) {
    await database.execute(`
      DELETE FROM used_car_listing_images WHERE is_synthetic = 1;
      DELETE FROM used_car_listings WHERE is_synthetic = 1;
      DELETE FROM used_car_models
      WHERE is_synthetic = 1
        AND NOT EXISTS (SELECT 1 FROM used_car_listings l WHERE l.model_id = used_car_models.id);
      DELETE FROM used_car_brands
      WHERE is_synthetic = 1
        AND NOT EXISTS (SELECT 1 FROM used_car_models m WHERE m.brand_id = used_car_brands.id);
    `);
  }

  const now = options.now ?? "2026-01-01T00:00:00.000Z";
  const insertBrand = database.prepare(`
    INSERT INTO used_car_brands (
      id, name, logo_url, initial, is_hot, sort_order,
      is_active, is_synthetic, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, logo_url = excluded.logo_url, initial = excluded.initial,
      is_hot = excluded.is_hot, sort_order = excluded.sort_order, is_active = 1,
      is_synthetic = 1, updated_at = excluded.updated_at
  `);
  for (const [index, brand] of DEMO_BRANDS.entries()) {
    await insertBrand.run(
      brand.id,
      brand.name,
      `/assets/used-cars/logos/${brand.id}.webp`,
      brand.initial,
      brand.isHot ? 1 : 0,
      BRAND_PINYIN_SORT_ORDER.get(brand.id) ?? (index + 1) * 10,
      now,
      now,
    );
  }

  const insertModel = database.prepare(`
    INSERT INTO used_car_models (
      id, brand_id, name, cover_image_url, body_type, energy_type,
      sort_order, is_active, is_synthetic, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      brand_id = excluded.brand_id, name = excluded.name, cover_image_url = excluded.cover_image_url,
      body_type = excluded.body_type, energy_type = excluded.energy_type,
      sort_order = excluded.sort_order, is_active = 1, is_synthetic = 1,
      updated_at = excluded.updated_at
  `);
  const brandModelOrder = new Map<string, number>();
  for (const model of DEMO_MODELS) {
    const sortOrder = (brandModelOrder.get(model.brandId) ?? 0) + 10;
    brandModelOrder.set(model.brandId, sortOrder);
    await insertModel.run(
      model.id,
      model.brandId,
      model.name,
      `/assets/used-cars/models/${model.id}.webp?v=${USED_CAR_ASSET_VERSION}`,
      model.bodyType,
      model.energyType,
      sortOrder,
      now,
      now,
    );
  }

  const modelById = new Map(DEMO_MODELS.map((model) => [model.id, model] as const));
  const insertListing = database.prepare(`
    INSERT INTO used_car_listings (
      id, stock_no, model_id, title, trim_name, model_year, registration_date,
      mileage_km, price_fen, original_price_fen, location,
      exterior_color, interior_color, transfer_count, energy_type, transmission, seats,
      highlights_json, condition_summary, defects_json, description, status, sort_priority,
      is_featured, data_kind, is_synthetic,
      published_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, 1, ?, ?, ?
    )
    ON CONFLICT DO NOTHING
  `);
  const insertImage = database.prepare(`
    INSERT INTO used_car_listing_images (
      id, listing_id, storage_key, image_url, mime_type,
      size_bytes, width, height, sort_order, is_cover, is_synthetic, created_at
    ) VALUES (?, ?, ?, ?, 'image/webp', ?, 1440, 1080, ?, ?, 1, ?)
    ON CONFLICT DO NOTHING
  `);

  for (const [index, listing] of DEMO_LISTINGS.entries()) {
    const sequence = String(index + 1).padStart(3, "0");
    const listingId = `used-car-listing-${sequence}`;
    const model = modelById.get(listing.modelId);
    if (!model) throw new Error(`Missing demo model ${listing.modelId}`);
    const publishedAt = listing.status === "draft"
      ? null
      : `2026-06-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`;
    const sortPriority = listing.modelId === USED_CAR_MODEL_IDS.liL7
      ? 100 - index
      : Math.max(0, 50 - index);
    await insertListing.run(
      listingId,
      `YXM-2026-${sequence}`,
      listing.modelId,
      listing.title,
      listing.title,
      listing.modelYear,
      listing.registrationDate,
      listing.mileageKm,
      listing.priceFen,
      listing.originalPriceFen,
      listing.location,
      listing.exteriorColor,
      listing.interiorColor,
      index % 3,
      model.energyType,
      listing.transmission,
      listing.seats,
      JSON.stringify(listing.highlights),
      "平台已完成基础车况采集；详细检测、过户次数与瑕疵以到店复核为准。",
      JSON.stringify([]),
      `平台自营二手车市场合成演示车源。${listing.title}，检测与交易信息以实际到店复核为准；当前记录不对应真实车辆。`,
      listing.status,
      sortPriority,
      listing.modelId === USED_CAR_MODEL_IDS.liL7 || index < 6 ? 1 : 0,
      "synthetic_demo",
      publishedAt,
      now,
      now,
    );

    for (let imageIndex = 1; imageIndex <= 2; imageIndex += 1) {
      const imageSequence = String(imageIndex).padStart(2, "0");
      await insertImage.run(
        `used-car-image-${sequence}-${imageSequence}`,
        listingId,
        `used-cars/demo/${listingId}/${imageSequence}.webp`,
        `/assets/used-cars/listings/${listingId}/${imageSequence}.webp?v=${USED_CAR_ASSET_VERSION}`,
        180000 + index * 3100 + imageIndex * 1700,
        imageIndex - 1,
        imageIndex === 1 ? 1 : 0,
        now,
      );
    }
  }

  await database.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES (?, 'applied', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(USED_CAR_SEED_MARKER, now);
}
