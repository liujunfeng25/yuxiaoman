import type { BookingMedia, MediaKind, ServiceMode } from "../../../../types";

export type UploadItem = {
  kind: MediaKind;
  label: string;
  media?: BookingMedia;
  previewUrl?: string;
  uploading?: boolean;
};

const selfDriveBookingUploads: ReadonlyArray<Pick<UploadItem, "kind" | "label">> = [
  { kind: "vehicle_front_left", label: "车辆左前" },
  { kind: "vehicle_front_right", label: "车辆右前" },
  { kind: "vehicle_rear_left", label: "车辆左后" },
  { kind: "vehicle_rear_right", label: "车辆右后" },
  { kind: "dashboard_started", label: "启动后仪表盘" },
  { kind: "license_front", label: "行驶证主页" },
  { kind: "license_back", label: "行驶证副页" },
];

export function requiredUploadItems(_serviceMode: ServiceMode, current: UploadItem[] = []): UploadItem[] {
  const currentByKind = new Map(current.map((item) => [item.kind, item]));
  const bookingUploads = selfDriveBookingUploads;

  return bookingUploads.map((definition) => {
    const existing = currentByKind.get(definition.kind);
    return existing
      ? { ...definition, media: existing.media, previewUrl: existing.previewUrl, uploading: existing.uploading }
      : { ...definition };
  });
}

export function updateUploadItem(
  uploads: UploadItem[],
  kind: MediaKind,
  patch: Partial<Pick<UploadItem, "media" | "previewUrl" | "uploading">>,
): UploadItem[] {
  return uploads.map((item) => item.kind === kind ? { ...item, ...patch } : item);
}
