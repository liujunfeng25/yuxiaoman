export type VehicleCatalogModel = {
  id: string;
  brandId: string;
  name: string;
  imageUrl: string;
};

export type VehicleCatalogBrand = {
  id: string;
  name: string;
  logoUrl: string;
  models: VehicleCatalogModel[];
};

const assetRoot = "/assets/used-cars";

export const VEHICLE_CATALOG: VehicleCatalogBrand[] = [
  {
    id: "brand-mercedes",
    name: "奔驰",
    logoUrl: `${assetRoot}/logos/brand-mercedes.webp`,
    models: [
      { id: "vehicle-mercedes-s", brandId: "brand-mercedes", name: "S级", imageUrl: `${assetRoot}/owner-models/vehicle-mercedes-s.webp` },
      { id: "vehicle-mercedes-e", brandId: "brand-mercedes", name: "E级", imageUrl: `${assetRoot}/owner-models/vehicle-mercedes-e.webp` },
      { id: "vehicle-mercedes-glc", brandId: "brand-mercedes", name: "GLC", imageUrl: `${assetRoot}/owner-models/vehicle-mercedes-glc.webp` },
    ],
  },
  {
    id: "brand-bmw",
    name: "宝马",
    logoUrl: `${assetRoot}/logos/brand-bmw.webp`,
    models: [
      { id: "vehicle-bmw-3", brandId: "brand-bmw", name: "3系", imageUrl: `${assetRoot}/owner-models/vehicle-bmw-3.webp` },
      { id: "vehicle-bmw-5", brandId: "brand-bmw", name: "5系", imageUrl: `${assetRoot}/owner-models/vehicle-bmw-5.webp` },
      { id: "vehicle-bmw-x3", brandId: "brand-bmw", name: "X3", imageUrl: `${assetRoot}/owner-models/vehicle-bmw-x3.webp` },
    ],
  },
  {
    id: "brand-audi",
    name: "奥迪",
    logoUrl: `${assetRoot}/logos/brand-audi.webp`,
    models: [
      { id: "vehicle-audi-a4l", brandId: "brand-audi", name: "A4L", imageUrl: `${assetRoot}/owner-models/vehicle-audi-a4l.webp` },
      { id: "vehicle-audi-a6l", brandId: "brand-audi", name: "A6L", imageUrl: `${assetRoot}/owner-models/vehicle-audi-a6l.webp` },
      { id: "vehicle-audi-q5l", brandId: "brand-audi", name: "Q5L", imageUrl: `${assetRoot}/owner-models/vehicle-audi-q5l.webp` },
    ],
  },
  {
    id: "brand-tesla",
    name: "特斯拉",
    logoUrl: `${assetRoot}/logos/brand-tesla.webp`,
    models: [
      { id: "vehicle-tesla-model-y", brandId: "brand-tesla", name: "Model Y", imageUrl: `${assetRoot}/owner-models/vehicle-tesla-model-y.webp` },
    ],
  },
  {
    id: "brand-byd",
    name: "比亚迪",
    logoUrl: `${assetRoot}/logos/brand-byd.webp`,
    models: [
      { id: "vehicle-byd-han", brandId: "brand-byd", name: "汉", imageUrl: `${assetRoot}/owner-models/vehicle-byd-han.webp` },
    ],
  },
  {
    id: "brand-li",
    name: "理想",
    logoUrl: `${assetRoot}/logos/brand-li.webp`,
    models: [
      { id: "vehicle-li-l7", brandId: "brand-li", name: "L7", imageUrl: `${assetRoot}/owner-models/vehicle-li-l7.webp` },
    ],
  },
];

const brandsById = new Map(VEHICLE_CATALOG.map((brand) => [brand.id, brand] as const));
const modelsById = new Map(
  VEHICLE_CATALOG.flatMap((brand) => brand.models.map((model) => [model.id, model] as const)),
);

export function vehicleCatalogBrand(id: string | null | undefined): VehicleCatalogBrand | null {
  return id ? brandsById.get(id) ?? null : null;
}

export function vehicleCatalogModel(id: string | null | undefined): VehicleCatalogModel | null {
  return id ? modelsById.get(id) ?? null : null;
}

export function resolveVehicleCatalogSelection(brandId: string, modelId: string): {
  brand: VehicleCatalogBrand;
  model: VehicleCatalogModel;
} | null {
  const brand = vehicleCatalogBrand(brandId);
  const model = vehicleCatalogModel(modelId);
  if (!brand || !model || model.brandId !== brand.id) return null;
  return { brand, model };
}

export function vehicleCatalogDto() {
  return {
    brands: VEHICLE_CATALOG,
    disclosure: {
      kind: "synthetic_demo" as const,
      label: "车型示意图",
      message: "车辆图片为统一风格的合成演示素材，仅用于车辆识别与界面展示，不代表具体年款配置。",
    },
  };
}
