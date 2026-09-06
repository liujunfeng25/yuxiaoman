import type { VehicleCatalogBrand } from "../../../types";

export type CatalogBrandOption = Pick<VehicleCatalogBrand, "id" | "name" | "logoUrl">;

/** Ignore spacing, hyphens and letter case: CR-V / crv, Model Y / modely. */
function searchText(value: string): string {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .toLowerCase().replace(/[\s.·_\-/]/g, "");
}

export function searchVehicleCatalog(
  brands: VehicleCatalogBrand[],
  query: string,
  preferredBrandId = "",
  vehicleClassCode = "",
) {
  const term = searchText(query);
  const matches = brands.map((brand) => {
    const brandTerms = [brand.name, brand.id.replace(/^brand-/, ""), ...(brand.searchKeywords || [])];
    const modelsForClass = (vehicleClassCode
      ? brand.models.filter((model) => (model.vehicleClassCodes || ["passenger_car"]).includes(vehicleClassCode))
      : brand.models).filter((model) => Boolean(model.imageUrl));
    const models = term ? modelsForClass.filter((model) =>
      [model.name, ...brandTerms, ...brandTerms.map((name) => `${name}${model.name}`)]
        .some((name) => searchText(name).includes(term)),
    ) : modelsForClass;
    return { brand, models };
  }).filter((entry) => entry.models.length > 0);
  const active = matches.find((entry) => entry.brand.id === preferredBrandId) || matches[0];
  return {
    catalogBrandOptions: matches.map(({ brand }): CatalogBrandOption => ({ id: brand.id, name: brand.name, logoUrl: brand.logoUrl })),
    activeBrandId: active?.brand.id || "",
    activeBrandName: active?.brand.name || "",
    activeModels: active?.models || [],
    catalogMatchCount: matches.reduce((count, entry) => count + entry.models.length, 0),
  };
}
