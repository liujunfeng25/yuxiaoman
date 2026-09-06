export type ImaginStudioVehicleMapping = {
  make: string;
  modelFamily: string;
  modelRange?: string;
  modelVariant?: string;
  modelYear?: string;
};

/**
 * Add a row only after the provider result has been visually checked against
 * the exact catalog series. An API success alone is insufficient because the
 * provider can deliberately return a nearby substitute while a model is built.
 */
export const APPROVED_IMAGIN_STUDIO_VEHICLE_MAPPINGS: Readonly<Record<string, ImaginStudioVehicleMapping>> = Object.freeze({});

export function imaginStudioPresentationUrl(
  customerKey: string,
  mapping: ImaginStudioVehicleMapping,
): string {
  const url = new URL("https://cdn.imagin.studio/getImage");
  url.searchParams.set("customer", customerKey.trim());
  url.searchParams.set("make", mapping.make);
  url.searchParams.set("modelFamily", mapping.modelFamily);
  if (mapping.modelRange) url.searchParams.set("modelRange", mapping.modelRange);
  if (mapping.modelVariant) url.searchParams.set("modelVariant", mapping.modelVariant);
  if (mapping.modelYear) url.searchParams.set("modelYear", mapping.modelYear);
  url.searchParams.set("paintDescription", "white");
  url.searchParams.set("angle", "28");
  url.searchParams.set("zoomType", "relative");
  url.searchParams.set("width", "800");
  url.searchParams.set("fileType", "webp");
  url.searchParams.set("billingTag", "owner-vehicle-catalog");
  return url.toString();
}

export function approvedImaginStudioPresentationUrls(
  customerKey = process.env.IMAGIN_STUDIO_CUSTOMER_KEY?.trim() ?? "",
): Record<string, string> {
  if (!customerKey) return {};
  return Object.fromEntries(Object.entries(APPROVED_IMAGIN_STUDIO_VEHICLE_MAPPINGS).map(([modelId, mapping]) => [
    modelId,
    imaginStudioPresentationUrl(customerKey, mapping),
  ]));
}
