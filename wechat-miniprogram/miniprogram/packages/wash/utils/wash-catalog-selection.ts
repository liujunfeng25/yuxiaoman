export type WashCatalogSelection = {
  sequence: number;
  storeId: string;
  vehicleId: string;
};

export function nextWashCatalogSelection(
  current: WashCatalogSelection | null | undefined,
  storeId: string,
  vehicleId: string,
): WashCatalogSelection {
  return { sequence: Number(current?.sequence || 0) + 1, storeId, vehicleId };
}

export function isWashCatalogSelectionCurrent(
  current: WashCatalogSelection | null | undefined,
  candidate: WashCatalogSelection | null | undefined,
): boolean {
  return Boolean(current && candidate
    && current.sequence === candidate.sequence
    && current.storeId === candidate.storeId
    && current.vehicleId === candidate.vehicleId);
}
