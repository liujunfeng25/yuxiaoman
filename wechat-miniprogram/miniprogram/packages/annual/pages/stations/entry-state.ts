import type { BookingDraft, ServiceMode } from "../../../../types";

export type StationEntryQuery = {
  mode?: string;
  serviceMode?: string;
  vehicleId?: string;
  entry?: string;
  returnTo?: string;
};

export type StationEntryState = {
  mode: ServiceMode;
  draft: BookingDraft;
  replace: boolean;
};

export function stationEntryState(query: StationEntryQuery, current: BookingDraft | null): StationEntryState {
  const requestedMode = query.serviceMode || query.mode;
  const mode: ServiceMode = requestedMode === "valet" ? "valet" : "self_drive";
  const vehicleId = String(query.vehicleId || "");
  const shortcut = query.entry === "home" || query.returnTo === "inspection_booking";
  const incompatibleDraft = Boolean(current && (current.serviceMode !== mode || (vehicleId && current.vehicleId !== vehicleId)));

  if (!shortcut && current && !incompatibleDraft) return { mode, draft: current, replace: false };

  const draft: BookingDraft = { serviceMode: mode };
  const nextVehicleId = vehicleId || (!shortcut ? current?.vehicleId || "" : "");
  if (nextVehicleId) draft.vehicleId = nextVehicleId;
  return { mode, draft, replace: true };
}
