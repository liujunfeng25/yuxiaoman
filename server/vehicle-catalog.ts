import { VEHICLE_BRAND_SEEDS, type CatalogVehicleClassCode } from "./vehicle-catalog-data.js";
import { OWNER_VEHICLE_PRESENTATION_IMAGE_URLS } from "./vehicle-catalog-images.js";

export type VehicleCatalogModel = {
  id: string;
  brandId: string;
  name: string;
  imageUrl: string;
  imageKind: "presentation_cutout" | "unavailable";
  vehicleClassCodes: CatalogVehicleClassCode[];
};

export type VehicleCatalogBrand = {
  id: string;
  name: string;
  logoUrl: string;
  searchKeywords?: string[];
  models: VehicleCatalogModel[];
};

const assetRoot = "/assets/used-cars";
const LEGACY_BRAND_LOGOS = new Set(["mercedes", "bmw", "audi", "tesla", "byd", "li"]);

// Persisted ids remain stable; images are independently bound to verified series photos.
export const VEHICLE_CATALOG: VehicleCatalogBrand[] = VEHICLE_BRAND_SEEDS.map((seed) => {
  const brandId = `brand-${seed.id}`;
  return {
    id: brandId,
    name: seed.name,
    logoUrl: LEGACY_BRAND_LOGOS.has(seed.id) ? `${assetRoot}/logos/${brandId}.webp` : "",
    searchKeywords: [seed.id, ...seed.keywords],
    models: seed.models.split("|").map((entry) => {
      const separator = entry.indexOf(":");
      const slug = entry.slice(0, separator);
      const name = entry.slice(separator + 1).trim();
      if (separator < 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(seed.id)
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !name) {
        throw new Error(`Invalid owner vehicle catalog entry: ${seed.id}/${entry}`);
      }
      const id = `vehicle-${seed.id}-${slug}`;
      const imageUrl = OWNER_VEHICLE_PRESENTATION_IMAGE_URLS[id as keyof typeof OWNER_VEHICLE_PRESENTATION_IMAGE_URLS] || "";
      const vehicleClassCodes = seed.modelVehicleClassCodes?.[slug]
        ?? seed.vehicleClassCodes
        ?? ["passenger_car"];
      return { id, brandId, name, imageUrl, imageKind: imageUrl ? "presentation_cutout" : "unavailable", vehicleClassCodes };
    }),
  };
});

const brandsById = new Map(VEHICLE_CATALOG.map((brand) => [brand.id, brand] as const));
const modelsById = new Map(
  VEHICLE_CATALOG.flatMap((brand) => brand.models.map((model) => [model.id, model] as const)),
);
if (brandsById.size !== VEHICLE_CATALOG.length
  || modelsById.size !== VEHICLE_CATALOG.reduce((count, brand) => count + brand.models.length, 0)) {
  throw new Error("Duplicate owner vehicle catalog IDs");
}
for (const imageModelId of Object.keys(OWNER_VEHICLE_PRESENTATION_IMAGE_URLS)) {
  if (!modelsById.has(imageModelId)) throw new Error(`Owner vehicle image maps unknown catalog id: ${imageModelId}`);
}

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
      kind: "model_reference" as const,
      label: "车型展示图",
      message: "选择器只展示已完成统一角度素材的对应车系；图片用于车型识别与首页展示，不代表具体年款、配置、颜色或车主实车。",
    },
  };
}
