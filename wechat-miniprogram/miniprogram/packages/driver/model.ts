import { mediaUrl } from "../../services/api";

export type DriverEvidenceStage = "owner_pickup" | "station_arrival" | "inspection_complete" | "owner_return";
export type DriverEvidencePhotoKind = "front_left" | "front_right" | "rear_left" | "rear_right" | "dashboard_started";
export type DriverEvidencePackageStatus = "pending" | "in_progress" | "completed";

export type DriverTaskSession = {
  token: string;
  expiresAt: string;
  taskId: string;
  bookingId: string;
};

export type DriverEvidencePhoto = {
  id: string;
  stage: DriverEvidenceStage;
  kind: DriverEvidencePhotoKind;
  url: string;
  createdAt: string;
};

export type DriverEvidencePackage = {
  stage: DriverEvidenceStage;
  status: DriverEvidencePackageStatus;
  capturedAt: string | null;
  capturedByLabel: string;
  photos: DriverEvidencePhoto[];
};

export type DriverTaskEvent = {
  id: string;
  status: string;
  title: string;
  description: string;
  createdAt: string;
};

export type DriverTaskAddress = {
  title: string;
  address: string;
  detail: string;
  note: string;
  latitude: number;
  longitude: number;
};

export type DriverTask = {
  taskId: string;
  bookingId: string;
  bookingNumber: string;
  status: string;
  fulfillmentStatus: string;
  appointmentDate: string;
  startTime: string;
  endTime: string;
  driverAssignment: {
    id: string;
    receptionistName: string;
    receptionistPhone: string;
    driverName: string;
    driverPhoneMasked: string;
    pickupDriverPhone: string;
    returnDriverPhone: string;
    status: string;
    handoffCodePending: boolean;
  } | null;
  vehicle: {
    plateNumber: string;
    displayName: string;
    vehicleType: string;
  };
  owner: {
    contactName: string;
    contactPhone: string;
    contactPhoneMasked: string;
  };
  pickupAddress: DriverTaskAddress | null;
  station: (DriverTaskAddress & { id: string; name: string; phone: string }) | null;
  evidencePackages: DriverEvidencePackage[];
  events: DriverTaskEvent[];
};

export type DriverPhotoSlot = {
  kind: DriverEvidencePhotoKind;
  label: string;
  hint: string;
};

export const DRIVER_PHOTO_SLOTS: DriverPhotoSlot[] = [
  { kind: "front_left", label: "车辆左前", hint: "车头、左侧车身完整入镜" },
  { kind: "front_right", label: "车辆右前", hint: "车头、右侧车身完整入镜" },
  { kind: "rear_left", label: "车辆左后", hint: "车尾、左侧车身完整入镜" },
  { kind: "rear_right", label: "车辆右后", hint: "车尾、右侧车身完整入镜" },
  { kind: "dashboard_started", label: "启动后仪表盘", hint: "车辆启动后拍清里程与仪表状态" },
];

export const DRIVER_STAGE_LABELS: Record<DriverEvidenceStage, string> = {
  owner_pickup: "司机取车留证",
  station_arrival: "检测站到车留证",
  inspection_complete: "检测完成留证",
  owner_return: "送回车辆留证",
};

export const DRIVER_STAGE_ACTORS: Record<DriverEvidenceStage, string> = {
  owner_pickup: "代驾司机",
  station_arrival: "检测站",
  inspection_complete: "检测站",
  owner_return: "代驾司机",
};

const STAGES: DriverEvidenceStage[] = ["owner_pickup", "station_arrival", "inspection_complete", "owner_return"];
const PHOTO_KINDS: DriverEvidencePhotoKind[] = ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"];

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]): string {
  const match = values.find((value) => typeof value === "string" && value.trim());
  return typeof match === "string" ? match.trim() : "";
}

function numberValue(...values: unknown[]): number {
  const match = values.map(Number).find((value) => Number.isFinite(value));
  return match ?? 0;
}

function stageValue(value: unknown): DriverEvidenceStage | null {
  return STAGES.includes(value as DriverEvidenceStage) ? value as DriverEvidenceStage : null;
}

function photoKindValue(value: unknown): DriverEvidencePhotoKind | null {
  return PHOTO_KINDS.includes(value as DriverEvidencePhotoKind) ? value as DriverEvidencePhotoKind : null;
}

function normalizeAddress(value: unknown): DriverTaskAddress | null {
  const source = objectValue(value);
  if (!Object.keys(source).length) return null;
  return {
    title: stringValue(source.title, source.name),
    address: stringValue(source.address),
    detail: stringValue(source.detail),
    note: stringValue(source.note),
    latitude: numberValue(source.latitude),
    longitude: numberValue(source.longitude),
  };
}

function normalizePhoto(value: unknown, fallbackStage: DriverEvidenceStage): DriverEvidencePhoto | null {
  const source = objectValue(value);
  const kind = photoKindValue(source.kind);
  if (!kind) return null;
  const stage = stageValue(source.stage) || fallbackStage;
  return {
    id: stringValue(source.id),
    stage,
    kind,
    url: mediaUrl(stringValue(source.url)),
    createdAt: stringValue(source.createdAt, source.created_at),
  };
}

function normalizePackage(value: unknown): DriverEvidencePackage | null {
  const source = objectValue(value);
  const stage = stageValue(source.stage);
  if (!stage) return null;
  const photos = Array.isArray(source.photos)
    ? source.photos.map((photo) => normalizePhoto(photo, stage)).filter((photo): photo is DriverEvidencePhoto => Boolean(photo))
    : [];
  const rawStatus = stringValue(source.status);
  // Five uploaded photos only mean the package is ready to submit. The server
  // remains authoritative for completion because the atomic completion action
  // also advances the booking state and writes the business event.
  const status: DriverEvidencePackageStatus = rawStatus === "completed"
    ? "completed"
    : photos.length ? "in_progress" : "pending";
  return {
    stage,
    status,
    capturedAt: stringValue(source.capturedAt, source.completedAt) || null,
    capturedByLabel: stringValue(source.capturedByLabel, source.actorLabel) || DRIVER_STAGE_ACTORS[stage],
    photos,
  };
}

export function normalizeDriverSession(value: unknown): DriverTaskSession | null {
  const source = objectValue(value);
  const token = stringValue(source.token);
  const expiresAt = stringValue(source.expiresAt);
  const booking = objectValue(source.booking);
  const assignment = objectValue(source.driverAssignment);
  const bookingId = stringValue(source.bookingId, booking.id);
  const taskId = stringValue(source.taskId, assignment.id, bookingId);
  if (!token || !expiresAt || !bookingId || !taskId || !Number.isFinite(Date.parse(expiresAt))) return null;
  return { token, expiresAt, taskId, bookingId };
}

export function normalizeDriverTask(value: unknown): DriverTask {
  const source = objectValue(value);
  const booking = Object.keys(objectValue(source.booking)).length ? objectValue(source.booking) : source;
  const assignmentSource = objectValue(source.driverAssignment || booking.driverAssignment);
  const vehicleSource = objectValue(source.vehicle || booking.vehicle);
  const brandSource = objectValue(vehicleSource.brand);
  const modelSource = objectValue(vehicleSource.model);
  const ownerSource = objectValue(source.owner || booking.owner);
  const pickupAddress = normalizeAddress(source.pickupAddress || booking.pickupAddress);
  const stationSource = objectValue(source.station || booking.station);
  const stationAddress = normalizeAddress(stationSource);
  const rawPackages = Array.isArray(source.evidencePackages)
    ? source.evidencePackages
    : Array.isArray(booking.evidencePackages) ? booking.evidencePackages : [];
  const normalizedPackages = rawPackages.map(normalizePackage).filter((item): item is DriverEvidencePackage => Boolean(item));
  const packages = STAGES.map((stage) => normalizedPackages.find((item) => item.stage === stage) || ({
    stage,
    status: "pending" as const,
    capturedAt: null,
    capturedByLabel: DRIVER_STAGE_ACTORS[stage],
    photos: [],
  }));
  const rawEvents = Array.isArray(source.events) ? source.events : Array.isArray(booking.events) ? booking.events : [];
  const bookingId = stringValue(source.bookingId, booking.id);
  const status = stringValue(source.status, booking.status);
  const fulfillmentStatus = stringValue(source.fulfillmentStatus, booking.fulfillmentStatus, status);
  const vehicleDisplayName = [
    stringValue(brandSource.name, vehicleSource.brandName),
    stringValue(modelSource.name, vehicleSource.modelName),
  ].filter(Boolean).join(" ") || stringValue(vehicleSource.vehicleType) || "预约车辆";
  return {
    taskId: stringValue(source.taskId, assignmentSource.id, bookingId),
    bookingId,
    bookingNumber: stringValue(source.bookingNumber, booking.bookingNumber),
    status,
    fulfillmentStatus,
    appointmentDate: stringValue(source.appointmentDate, booking.appointmentDate),
    startTime: stringValue(source.startTime, booking.startTime),
    endTime: stringValue(source.endTime, booking.endTime),
    driverAssignment: Object.keys(assignmentSource).length ? {
      id: stringValue(assignmentSource.id),
      receptionistName: stringValue(
        assignmentSource.receptionistName,
        assignmentSource.driverName,
        assignmentSource.name,
      ),
      receptionistPhone: stringValue(
        assignmentSource.receptionistPhone,
        assignmentSource.driverPhone,
        assignmentSource.phone,
      ),
      driverName: stringValue(assignmentSource.driverName, assignmentSource.receptionistName, assignmentSource.name),
      driverPhoneMasked: stringValue(
        assignmentSource.driverPhoneMasked,
        assignmentSource.phoneMasked,
        assignmentSource.driverPhone,
        assignmentSource.receptionistPhone,
      ),
      pickupDriverPhone: stringValue(assignmentSource.pickupDriverPhone),
      returnDriverPhone: stringValue(assignmentSource.returnDriverPhone),
      status: stringValue(assignmentSource.status),
      handoffCodePending: Boolean(assignmentSource.handoffCodePending),
    } : null,
    vehicle: {
      plateNumber: stringValue(vehicleSource.plateNumber, source.plateNumber) || "车牌待同步",
      displayName: vehicleDisplayName,
      vehicleType: stringValue(vehicleSource.vehicleType),
    },
    owner: {
      contactName: stringValue(ownerSource.contactName, booking.contactName),
      contactPhone: stringValue(ownerSource.contactPhone, booking.contactPhone),
      contactPhoneMasked: stringValue(ownerSource.contactPhoneMasked, booking.contactPhoneMasked),
    },
    pickupAddress,
    station: stationAddress ? {
      ...stationAddress,
      id: stringValue(stationSource.id),
      name: stringValue(stationSource.name, stationSource.title),
      phone: stringValue(stationSource.phone),
    } : null,
    evidencePackages: packages,
    events: rawEvents.map((event, index) => {
      const item = objectValue(event);
      return {
        id: stringValue(item.id) || `event-${index}`,
        status: stringValue(item.status),
        title: stringValue(item.title) || "履约状态已更新",
        description: stringValue(item.description),
        createdAt: stringValue(item.createdAt, item.created_at),
      };
    }),
  };
}

export function evidenceForStage(task: DriverTask | null, stage: DriverEvidenceStage): DriverEvidencePackage {
  return task?.evidencePackages.find((item) => item.stage === stage) || {
    stage,
    status: "pending",
    capturedAt: null,
    capturedByLabel: DRIVER_STAGE_ACTORS[stage],
    photos: [],
  };
}

export function driverWritableStage(task: DriverTask | null): DriverEvidenceStage | null {
  if (!task) return null;
  const status = task.fulfillmentStatus || task.status;
  if (status === "driver_arranged" && evidenceForStage(task, "owner_pickup").status !== "completed") return "owner_pickup";
  if (status === "returning" && evidenceForStage(task, "owner_return").status !== "completed") return "owner_return";
  return null;
}

export function canStartReturn(task: DriverTask | null): boolean {
  if (!task) return false;
  const status = task.fulfillmentStatus || task.status;
  return status === "result_received" && evidenceForStage(task, "inspection_complete").status === "completed";
}

export function driverTaskTerminal(task: DriverTask | null): boolean {
  const status = task?.fulfillmentStatus || task?.status || "";
  return ["completed", "cancelled", "no_show"].includes(status);
}
