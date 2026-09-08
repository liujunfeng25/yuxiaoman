import { PLATE_CATEGORIES } from "../../wechat-miniprogram/miniprogram/utils/plate-categories.js";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import type inject from "light-my-request";
import sharp from "sharp";
import { createDevelopmentSession } from "../auth.js";
import { createInitialPlatformAdmin } from "../backoffice.js";
import { migrateCustomerCenterDatabase } from "../customer-center.js";
import { buildApp, parseTrustProxy } from "../app.js";
import { DEMO_STATION_ID, HUAYANG_STATION_ID, migrateDatabase, seedDemoData, type Database } from "../db.js";
import { migrateVehicleCheckupDatabase } from "../vehicle-checkup-db.js";
import { createWashLocationProof, validWashLocationProof } from "../wash.js";
import { migrateWashDatabase, WASH_MPV_PRICE_SEED_V2_MARKER, WASH_SEED_MARKER } from "../wash-db.js";
import { runWorkflowWorkerOnce } from "../workflow-worker.js";
import { createTestDatabase } from "./test-database.js";

process.env.YUXIAOMAN_DEMO_DATE = "2026-08-11";
process.env.ALLOW_DEMO_RESET = "true";
process.env.ALLOW_DEMO_WORKFLOW = "true";

const beforeFirstInspectionSlot = () => new Date("2026-08-10T16:00:00.000Z");
const fixedShanghaiNow = () => new Date("2026-08-11T02:00:00.000Z");
const fixedWashShanghaiNoon = () => new Date("2026-08-11T04:00:00.000Z");

type Json = Record<string, any>;

type AdminWashInjectOptions = inject.InjectOptions & { url: string };

test("可信代理只接受显式 loopback、IP 或非全网 CIDR，默认关闭", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy("false"), false);
  assert.deepEqual(parseTrustProxy("loopback, 10.8.0.0/16, 192.0.2.10"), [
    "loopback",
    "10.8.0.0/16",
    "192.0.2.10",
  ]);
  assert.throws(() => parseTrustProxy("true"), /TRUST_PROXY/u);
  assert.throws(() => parseTrustProxy("0.0.0.0\/0"), /all-address/u);
  assert.throws(() => parseTrustProxy("proxy.internal"), /TRUST_PROXY/u);
});

async function washAdminInject(app: FastifyInstance, options: AdminWashInjectOptions): Promise<inject.Response> {
  return await app.inject(options);
}

async function uploadWashStoreImage(
  app: FastifyInstance,
  storeId: string,
  image: Buffer,
  mimeType: string,
  fields: { isCover?: boolean; sortOrder?: number } = {},
) {
  const boundary = `----wash-store-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  if (fields.isCover !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="isCover"\r\n\r\n${fields.isCover}\r\n`,
    ));
  }
  if (fields.sortOrder !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sortOrder"\r\n\r\n${fields.sortOrder}\r\n`,
    ));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="store-image"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const body = Buffer.concat(chunks);
  return app.inject({
    method: "POST",
    url: `/api/admin/wash/stores/${storeId}/images`,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    payload: body,
  });
}

async function fixture(slotNow: () => Date = beforeFirstInspectionSlot): Promise<{
  app: FastifyInstance;
  database: Database;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase("api");
  const privateRoot = mkdtempSync(join(tmpdir(), "yuxiaoman-uploads-"));
  const uploadDir = join(privateRoot, "uploads");
  const app = await buildApp({
    database,
    uploadDir,
    insuranceUploadDir: join(privateRoot, "insurance"),
    subsidyConsultationUploadDir: join(privateRoot, "subsidy"),
    slotNow,
  });
  await app.ready();
  return {
    app,
    database,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(privateRoot, { recursive: true, force: true });
    },
  };
}

const testPng = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#2878d1" } }).png().toBuffer();
const alternateTestPng = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#d14f28" } }).png().toBuffer();

async function uploadMedia(app: FastifyInstance, kind: string) {
  const boundary = `----yuxiaoman-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original-name.png"\r\nContent-Type: image/png\r\n\r\n`),
    testPng,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: "POST",
    url: "/api/media",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

async function requestCheckupMedia(app: FastifyInstance, bookingId: string, kind: string) {
  const boundary = `----yuxiaoman-checkup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="checkup.png"\r\nContent-Type: image/png\r\n\r\n`),
    testPng,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: `/api/operator/bookings/${bookingId}/checkup-report/media`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) },
    payload: body,
  });
}

async function uploadCheckupMedia(app: FastifyInstance, bookingId: string, kind: string) {
  const response = await requestCheckupMedia(app, bookingId, kind);
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

async function requestValetEvidenceMedia(
  app: FastifyInstance,
  url: string,
  kind: string,
  options: { token?: string; image?: Buffer } = {},
) {
  const boundary = `----yuxiaoman-valet-evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const image = options.image ?? testPng;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.png"\r\nContent-Type: image/png\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    payload: body,
  });
}

async function requestFaultPhoto(
  app: FastifyInstance,
  bookingId: string,
  faultId: string,
  options: { image?: Buffer; idempotencyKey?: string; replacePhotoId?: string } = {},
) {
  const boundary = `----yuxiaoman-fault-photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const image = options.image ?? testPng;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fault.png"\r\nContent-Type: image/png\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const query = options.replacePhotoId
    ? `?replacePhotoId=${encodeURIComponent(options.replacePhotoId)}`
    : "";
  return app.inject({
    method: "POST",
    url: `/api/operator/bookings/${bookingId}/checkup-report/faults/${faultId}/photos${query}`,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    payload: body,
  });
}

async function uploadFaultPhoto(
  app: FastifyInstance,
  bookingId: string,
  faultId: string,
  options: { image?: Buffer; idempotencyKey?: string; replacePhotoId?: string } = {},
) {
  const response = await requestFaultPhoto(app, bookingId, faultId, options);
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

async function prepareCheckupReport(
  app: FastifyInstance,
  bookingId: string,
  options: { conclusion?: "passed" | "failed"; includeMark?: boolean } = {},
) {
  const conclusion = options.conclusion ?? "passed";
  const draft = await app.inject({
    method: "PUT",
    url: `/api/operator/bookings/${bookingId}/checkup-report`,
    payload: {
      observationMode: "no_visible_faults",
      diagramVersion: "sedan-3view-v1",
      annualInspection: { conclusion },
      summary: { conclusionLabel: conclusion === "passed" ? "检验合格" : "需进一步处理" },
      faults: [],
    },
  });
  assert.equal(draft.statusCode, 200, draft.body);
  for (const kind of ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"]) {
    await uploadCheckupMedia(app, bookingId, kind);
  }
  await uploadCheckupMedia(app, bookingId, "safety_inspection_report");
  if (options.includeMark ?? conclusion === "passed") {
    await uploadCheckupMedia(app, bookingId, "annual_inspection_mark");
  }
  return (await app.inject({
    method: "GET",
    url: `/api/operator/bookings/${bookingId}/checkup-report`,
  })).json<Json>().data;
}

async function seedContext(app: FastifyInstance) {
  const vehicles = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data;
  const stations = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data;
  const station = stations.find((item: Json) => item.id === DEMO_STATION_ID);
  const slots = (
    await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots` })
  ).json<Json>().data;
  return { vehicle: vehicles[0], station, slots };
}

async function createVehicle(app: FastifyInstance, plateNumber: string, powertrainType?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/vehicles",
    payload: {
      plateNumber,
      vehicleType: "小型轿车",
      usageNature: "非营运",
      seats: 5,
      registrationDate: "2020-01-01",
      inspectionDueDate: "2027-01-01",
      ...(powertrainType ? { powertrainType } : {}),
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

const annualBookingMediaKinds = [
  "vehicle_front_left",
  "vehicle_front_right",
  "vehicle_rear_left",
  "vehicle_rear_right",
  "dashboard_started",
  "license_front",
  "license_back",
] as const;

async function uploadAnnualBookingMedia(
  app: FastifyInstance,
  _serviceMode: "self_drive" | "valet" = "self_drive",
): Promise<Json[]> {
  return Promise.all(annualBookingMediaKinds.map((kind) => uploadMedia(app, kind)));
}

async function createBooking(
  app: FastifyInstance,
  values: { vehicleId: string; stationId: string; slotId: string },
) {
  const quoted = await app.inject({
    method: "POST",
    url: "/api/bookings/quote",
    payload: {
      vehicleId: values.vehicleId,
      stationId: values.stationId,
      serviceMode: "self_drive",
    },
  });
  assert.equal(quoted.statusCode, 200, quoted.body);
  const media = await uploadAnnualBookingMedia(app);
  return app.inject({
    method: "POST",
    url: "/api/bookings",
    payload: {
      ...values,
      contactName: "张女士",
      contactPhone: "13800138000",
      serviceMode: "self_drive",
      quoteSnapshotId: quoted.json<Json>().data.quoteSnapshotId,
      mediaIds: media.map((item) => item.id),
    },
  });
}

async function approvePrecheck(app: FastifyInstance, bookingId: string) {
  const detail = await app.inject({ method: "GET", url: `/api/operator/prechecks/${bookingId}` });
  assert.equal(detail.statusCode, 200, detail.body);
  const version = detail.json<Json>().data.precheck.version;
  const response = await app.inject({
    method: "POST",
    url: `/api/operator/prechecks/${bookingId}/approve`,
    payload: { idempotencyKey: `approve-test-${bookingId}`, expectedVersion: version },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Json>().data;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function integrationHeaders(payload: unknown, idempotencyKey: string) {
  const timestamp = new Date().toISOString();
  const digest = createHmac("sha256", "yuxiaoman-demo-integration-secret")
    .update(`${timestamp}.${stableJson(payload)}`)
    .digest("hex");
  return {
    "idempotency-key": idempotencyKey,
    "x-yuxiaoman-timestamp": timestamp,
    "x-yuxiaoman-signature": `sha256=${digest}`,
  };
}

test("health、演示车辆和检测站使用统一 data envelope", async () => {
  const { app, close } = await fixture();
  try {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json<Json>().data.status, "ok");
    assert.equal(health.json<Json>().data.map.provider, "tencent");

    const stationList = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data;
    assert.equal(stationList.length, 4);
    assert.equal(stationList[0].id, HUAYANG_STATION_ID);
    assert.equal(stationList[0].dataKind, "real");
    assert.equal(stationList[0].isDirectOperated, true);

    const { vehicle, station, slots } = await seedContext(app);
    assert.match(vehicle.plateNumber, /^津A/);
    assert.equal(vehicle.plateKind, "blue");
    assert.equal(vehicle.plateProvince, "津");
    assert.equal(vehicle.plateAgencyCode, "A");
    assert.equal(vehicle.energyCategory, "none");
    assert.equal(typeof vehicle.isDefault, "boolean");
    assert.equal(station.district, "河西区");
    assert.equal(station.serviceFeeFen, 26000);
    assert.ok(slots.length >= 4);
    assert.ok(slots[0].remaining > 0);

    const workbench = await app.inject({ method: "GET", url: "/api/operator/workbench" });
    assert.equal(workbench.json<Json>().data.businessDate, "2026-08-11");
  } finally {
    await close();
  }
});

test("年检号源过滤上海当天已开始窗口且创建预约与改期均拒绝过期窗口", async () => {
  const { app, database, close } = await fixture(fixedShanghaiNow);
  try {
    const currentDayResponse = await app.inject({
      method: "GET",
      url: `/api/stations/${DEMO_STATION_ID}/slots?date=2026-08-11`,
    });
    assert.equal(currentDayResponse.statusCode, 200, currentDayResponse.body);
    const currentDaySlots = currentDayResponse.json<Json>().data;
    assert.deepEqual(currentDaySlots.map((slot: Json) => slot.startTime), ["13:30", "15:00"]);

    const futureDayResponse = await app.inject({
      method: "GET",
      url: `/api/stations/${DEMO_STATION_ID}/slots?date=2026-08-12`,
    });
    assert.equal(futureDayResponse.statusCode, 200, futureDayResponse.body);
    const futureDaySlots = futureDayResponse.json<Json>().data;
    assert.deepEqual(futureDaySlots.map((slot: Json) => slot.startTime), ["08:30", "10:00", "13:30", "15:00"]);

    const vehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];
    const startedSlot = await database.prepare<Json>(`
      SELECT * FROM station_slots
      WHERE station_id = ? AND date = ? AND start_time = ?
    `).get(DEMO_STATION_ID, "2026-08-11", "10:00");
    assert.ok(startedSlot);

    const rejectedCreate = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: DEMO_STATION_ID,
      slotId: startedSlot.id,
    });
    assert.equal(rejectedCreate.statusCode, 409, rejectedCreate.body);
    assert.equal(rejectedCreate.json<Json>().error.code, "SLOT_EXPIRED");

    const futureCreate = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: DEMO_STATION_ID,
      slotId: futureDaySlots[0].id,
    });
    assert.equal(futureCreate.statusCode, 201, futureCreate.body);
    const booking = futureCreate.json<Json>().data;

    const rejectedReschedule = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/reschedule`,
      payload: { slotId: startedSlot.id },
    });
    assert.equal(rejectedReschedule.statusCode, 409, rejectedReschedule.body);
    assert.equal(rejectedReschedule.json<Json>().error.code, "SLOT_EXPIRED");
  } finally {
    await close();
  }
});

test("车辆接口校验车牌、注册日期、重复车辆并支持更新", async () => {
  const { app, close } = await fixture();
  try {
    const invalidPlate = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: { plateNumber: "津A#2345", registrationDate: "2020-01-01" },
    });
    assert.equal(invalidPlate.statusCode, 400);
    assert.equal(invalidPlate.json<Json>().error.code, "VALIDATION_ERROR");
    assert.ok(invalidPlate.json<Json>().error.fields.plateNumber);

    const futureDate = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: { plateNumber: "津B·T0001", registrationDate: "2999-01-01" },
    });
    assert.equal(futureDate.statusCode, 400);
    assert.equal(futureDate.json<Json>().error.code, "FUTURE_REGISTRATION_DATE");

    const vehicle = await createVehicle(app, "津B·T0001");
    assert.equal(vehicle.plateNumber, "津B·T0001");
    assert.equal(vehicle.plateKind, "blue");
    assert.equal(vehicle.plateProvince, "津");
    assert.equal(vehicle.plateAgencyCode, "B");
    assert.equal(vehicle.energyCategory, "none");

    const derivedDueDate = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: { plateNumber: "津C·T0002", registrationDate: "2020-01-12" },
    });
    assert.equal(derivedDueDate.statusCode, 201, derivedDueDate.body);
    assert.equal(derivedDueDate.json<Json>().data.inspectionDueDate, "2027-01-12");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: { plateNumber: "津BT0001", registrationDate: "2020-01-01" },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json<Json>().error.code, "PLATE_ALREADY_EXISTS");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${vehicle.id}`,
      payload: { seats: 7, isDefault: true },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json<Json>().data.seats, 7);
    assert.equal(updated.json<Json>().data.isDefault, true);
  } finally {
    await close();
  }
});

test("车辆品牌车型目录支持关联校验、名称快照、清除与旧车辆兼容", async () => {
  const { app, close } = await fixture();
  try {
    const catalogResponse = await app.inject({ method: "GET", url: "/api/vehicle-catalog" });
    assert.equal(catalogResponse.statusCode, 200, catalogResponse.body);
    const catalog = catalogResponse.json<Json>().data;
    assert.ok(catalog.brands.length >= 130);
    assert.ok(catalog.brands.reduce((count: number, brand: Json) => count + brand.models.length, 0) >= 1500);
    assert.equal(catalog.brands[0].name, "奔驰");
    assert.equal(catalog.brands[0].models[0].name, "S级");
    assert.equal(catalog.disclosure.kind, "model_reference");
    const subaru = catalog.brands.find((brand: Json) => brand.id === "brand-subaru");
    assert.equal(subaru.models.length, 9);
    assert.deepEqual(subaru.models.filter((model: Json) => model.imageUrl).map((model: Json) => model.name), ["森林人", "傲虎", "XV", "旭豹", "力狮", "翼豹", "BRZ", "驰鹏", "WRX"]);
    const trailerCatalog = catalog.brands.find((brand: Json) => brand.id === "brand-trailer-body");
    assert.equal(trailerCatalog.models.length, 7);
    assert.deepEqual(trailerCatalog.models.filter((model: Json) => model.imageUrl).map((model: Json) => model.name), [
      "平板半挂车", "栏板半挂车", "车辆运输半挂车", "侧帘半挂车", "集装箱运输半挂车", "罐式半挂车", "厢式半挂车",
    ]);
    assert.ok(trailerCatalog.models.every((model: Json) => model.vehicleClassCodes.includes("trailer")));

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: {
        plateNumber: "津B·T8801",
        vehicleType: "小型轿车",
        usageNature: "非营运",
        seats: 5,
        registrationDate: "2020-01-01",
        brandId: "brand-mercedes",
        modelId: "vehicle-mercedes-s",
      },
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = createdResponse.json<Json>().data;
    assert.deepEqual(created.brand, { id: "brand-mercedes", name: "奔驰" });
    assert.deepEqual(created.model, { id: "vehicle-mercedes-s", name: "S级" });
    assert.match(created.visual.imageUrl, /owner-models\/vehicle-mercedes-s\.webp$/);
    assert.equal(created.visual.kind, "presentation_cutout");

    const identityOnlyUpdate = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${created.id}`,
      payload: { brandId: "brand-bmw", modelId: "vehicle-bmw-5" },
    });
    assert.equal(identityOnlyUpdate.statusCode, 200, identityOnlyUpdate.body);
    const updated = identityOnlyUpdate.json<Json>().data;
    assert.deepEqual(updated.brand, { id: "brand-bmw", name: "宝马" });
    assert.deepEqual(updated.model, { id: "vehicle-bmw-5", name: "5系" });
    assert.equal(updated.vehicleType, created.vehicleType);
    assert.equal(updated.seats, created.seats);
    assert.equal(updated.powertrainType, created.powertrainType);
    assert.equal(updated.registrationDate, created.registrationDate);

    const expandedSelection = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${created.id}`,
      payload: { brandId: "brand-volkswagen", modelId: "vehicle-volkswagen-lavida" },
    });
    assert.equal(expandedSelection.statusCode, 200, expandedSelection.body);
    const expanded = expandedSelection.json<Json>().data;
    assert.deepEqual(expanded.brand, { id: "brand-volkswagen", name: "大众" });
    assert.deepEqual(expanded.model, { id: "vehicle-volkswagen-lavida", name: "朗逸" });
    const expandedCatalogModel = catalog.brands.find((brand: Json) => brand.id === "brand-volkswagen")
      .models.find((model: Json) => model.id === "vehicle-volkswagen-lavida");
    assert.equal(expanded.visual.imageUrl, expandedCatalogModel.imageUrl);
    assert.equal(expanded.visual.kind, expandedCatalogModel.imageKind);
    if (expanded.visual.imageUrl) assert.match(expanded.visual.imageUrl, /^\/assets\/used-cars\//);
    assert.equal(expanded.seats, created.seats);
    assert.equal(expanded.powertrainType, created.powertrainType);
    const reloaded = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data
      .find((vehicle: Json) => vehicle.id === created.id);
    assert.deepEqual(reloaded.model, expanded.model);
    const newBrandVehicle = await app.inject({
      method: "POST", url: "/api/vehicles",
      payload: { plateNumber: "津B·T8803", vehicleType: "小型轿车", usageNature: "非营运", seats: 5,
        registrationDate: "2025-01-01", brandId: "brand-xiaomi", modelId: "vehicle-xiaomi-su7" },
    });
    assert.equal(newBrandVehicle.statusCode, 201, newBrandVehicle.body);
    assert.deepEqual(newBrandVehicle.json<Json>().data.model, { id: "vehicle-xiaomi-su7", name: "SU7" });
    assert.match(newBrandVehicle.json<Json>().data.visual.imageUrl, /owner-presentation-v2\/vehicle-xiaomi-su7\.webp$/);
    assert.equal(newBrandVehicle.json<Json>().data.visual.kind, "presentation_cutout");

    const mismatch = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${created.id}`,
      payload: { brandId: "brand-audi", modelId: "vehicle-bmw-5" },
    });
    assert.equal(mismatch.statusCode, 400, mismatch.body);
    assert.equal(mismatch.json<Json>().error.code, "VEHICLE_CATALOG_SELECTION_INVALID");

    const oneSided = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${created.id}`,
      payload: { brandId: "brand-audi" },
    });
    assert.equal(oneSided.statusCode, 400, oneSided.body);
    assert.equal(oneSided.json<Json>().error.code, "VEHICLE_CATALOG_PAIR_REQUIRED");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${created.id}`,
      payload: { brandId: null, modelId: null },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json<Json>().data.brand, null);
    assert.equal(cleared.json<Json>().data.model, null);
    assert.equal(cleared.json<Json>().data.visual, null);

    const legacyVehicle = await createVehicle(app, "津B·T8802");
    assert.equal(legacyVehicle.brand, null);
    assert.equal(legacyVehicle.model, null);
    assert.equal(legacyVehicle.visual, null);

    const coloredPassengerResponse = await app.inject({
      method: "POST", url: "/api/vehicles",
      payload: {
        plateNumber: "津B·T8804", plateCategory: "blue_small_passenger", vehicleType: "小型普通客车",
        usageNature: "非营运", seats: 5, registrationDate: "2023-01-01", exteriorColor: "蓝色",
        brandId: "brand-subaru", modelId: "vehicle-subaru-forester",
      },
    });
    assert.equal(coloredPassengerResponse.statusCode, 201, coloredPassengerResponse.body);
    const coloredPassenger = coloredPassengerResponse.json<Json>().data;
    assert.equal(coloredPassenger.exteriorColor, "蓝色");

    const convertedToTruck = await app.inject({
      method: "PATCH", url: `/api/vehicles/${coloredPassenger.id}`,
      payload: {
        plateCategory: "blue_small_truck", vehicleType: "轻型栏板货车", usageNature: "货运", seats: 2,
        brandId: "brand-jac-shuailing", modelId: "vehicle-jac-shuailing-n55",
      },
    });
    assert.equal(convertedToTruck.statusCode, 200, convertedToTruck.body);
    assert.equal(convertedToTruck.json<Json>().data.exteriorColor, null);
    assert.equal(convertedToTruck.json<Json>().data.model.name, "帅铃N55");
    assert.match(convertedToTruck.json<Json>().data.visual.imageUrl, /vehicle-jac-shuailing-n55\.webp$/);

    const wrongVehicleClass = await app.inject({
      method: "PATCH", url: `/api/vehicles/${coloredPassenger.id}`,
      payload: { plateCategory: "blue_small_passenger" },
    });
    assert.equal(wrongVehicleClass.statusCode, 400, wrongVehicleClass.body);
    assert.equal(wrongVehicleClass.json<Json>().error.code, "VEHICLE_CATALOG_CLASS_MISMATCH");
  } finally {
    await close();
  }
});

test("11 类号牌独立保存并匹配各自站点报价，变更类别使旧报价失效", async () => {
  const { app, database, close } = await fixture();
  try {
    const { station, slots } = await seedContext(app);
    const definitions = (await app.inject({ method: "GET", url: "/api/admin/inspection-price-plans" })).json<Json>().data as Json[];
    assert.equal(PLATE_CATEGORIES.length, 11);
    assert.equal(new Set(definitions.flatMap((plan) => plan.plateCategories)).size, 11);
    const unconfirmed = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津CQA999", plateCategory: "new_energy_small_passenger", registrationDate: "2020-01-01",
    } });
    assert.equal(unconfirmed.statusCode, 201, unconfirmed.body);
    assert.equal(unconfirmed.json<Json>().data.powertrainType, "unknown");
    const vehicles: Json[] = [];
    const offers: Json[] = [];
    for (const [index, category] of PLATE_CATEGORIES.entries()) {
      const serial = category.code === "yellow_trailer" ? "9301挂" : category.code.startsWith("new_energy_") ? `B${93000 + index}` : `Q${9300 + index}`;
      const response = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
        plateNumber: `津C${serial}`, plateCategory: category.code,
        vehicleType: category.vehicleType, seats: category.defaultSeats,
        usageNature: category.vehicleClassCode === "passenger_car" ? "非营运" : "货运",
        powertrainType: category.code === "yellow_trailer" ? "unknown" : "gasoline",
        // A client-authored class cannot override the selected category.
        vehicleClassCode: "passenger_car", registrationDate: "2020-01-01",
      } });
      assert.equal(response.statusCode, 201, response.body);
      const vehicle = response.json<Json>().data;
      vehicles.push(vehicle);
      assert.equal(vehicle.plateCategory, category.code);
      assert.equal(vehicle.plateKind, category.plateKind);
      assert.equal(vehicle.vehicleClassCode, category.vehicleClassCode);
      assert.equal(vehicle.facts.powertrainSource, "vehicle_profile");
      assert.equal(vehicle.powertrainType, category.code === "yellow_trailer" ? "unknown" : "gasoline");
      const reread = (await app.inject({ method: "GET", url: `/api/vehicles/${vehicle.id}` })).json<Json>().data;
      assert.equal(reread.plateCategory, category.code);
      const status = await app.inject({ method: "GET", url: `/api/inspection/status/${vehicle.id}` });
      assert.equal(status.statusCode, 200, status.body);
      if (category.vehicleClassCode !== "passenger_car") {
        const before = (await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
          vehicleId: vehicle.id, stationId: station.id, serviceMode: "self_drive",
        } })).json<Json>().data;
        assert.equal(before.serviceable, false, category.label);
        assert.equal(before.inspectionFeeFen, 0);
      }
      let plan = definitions.find((item) => item.id === `plan-${category.code}`);
      if (!plan) {
        const createdPlan = await app.inject({ method: "POST", url: "/api/admin/inspection-price-plans", payload: {
          code: `test-${category.code}`, name: category.label,
          plateCategories: [category.code], powertrainTypes: ["gasoline"],
          minSeats: 1, maxSeats: 9, usageNatures: ["非营运"], vehicleClassCodes: ["passenger_car"],
          inspectionItems: ["safety_basic", "emissions_gasoline"],
        } });
        assert.equal(createdPlan.statusCode, 201, createdPlan.body);
        plan = createdPlan.json<Json>().data;
      }
      offers.push({ planId: plan!.id, isSupported: true, priceFen: 21000 + index * 1700 });
    }
    const configured = await app.inject({ method: "PUT", url: `/api/admin/stations/${station.id}/price-plans`, payload: { pricePlans: offers } });
    assert.equal(configured.statusCode, 200, configured.body);
    const quotes: Json[] = [];
    for (const [index, vehicle] of vehicles.entries()) {
      const response = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
        vehicleId: vehicle.id, stationId: station.id, serviceMode: "self_drive",
      } });
      assert.equal(response.statusCode, 200, response.body);
      const quote = response.json<Json>().data;
      quotes.push(quote);
      assert.equal(quote.pricingEligibility, "supported", `${vehicle.plateCategory}: ${response.body}`);
      assert.equal(quote.inspectionFeeFen, offers[index].priceFen);
      assert.equal(quote.matchedPricePlan.id, offers[index].planId);
      assert.deepEqual(quote.matchedPricePlan.plateCategories, [vehicle.plateCategory]);
      assert.equal(quote.vehicleSnapshot.plateCategory, vehicle.plateCategory);
    }
    const changed = await app.inject({ method: "PATCH", url: `/api/vehicles/${vehicles[0].id}`, payload: { plateCategory: PLATE_CATEGORIES[1].code } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json<Json>().data.plateNumber, vehicles[0].plateNumber);
    const media = await uploadAnnualBookingMedia(app);
    const stale = await app.inject({ method: "POST", url: "/api/bookings", payload: {
      vehicleId: vehicles[0].id, stationId: station.id, slotId: slots[0].id,
      serviceMode: "self_drive", contactName: "类别测试", contactPhone: "13800138000",
      quoteSnapshotId: quotes[0].quoteSnapshotId, mediaIds: media.map((item) => item.id),
    } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json<Json>().error.code, "QUOTE_STALE");
    const unrelatedEdit = await app.inject({ method: "PATCH", url: `/api/vehicles/${vehicles[8].id}`, payload: { isDefault: true } });
    assert.equal(unrelatedEdit.statusCode, 200, unrelatedEdit.body);
    assert.equal(unrelatedEdit.json<Json>().data.plateCategory, "yellow_trailer");
    assert.equal(unrelatedEdit.json<Json>().data.seats, 0);
    const invalidSeats = await app.inject({ method: "PATCH", url: `/api/vehicles/${vehicles[8].id}`, payload: { plateCategory: "blue_small_passenger" } });
    assert.equal(invalidSeats.statusCode, 400, invalidSeats.body);
    const plan = definitions.find((item) => item.id === offers[2].planId)!;
    const edited = await app.inject({ method: "PUT", url: `/api/admin/inspection-price-plans/${plan.id}`, payload: {
      ...plan, plateCategories: ["new_energy_small_truck"],
    } });
    assert.equal(edited.statusCode, 200, edited.body);
    const noMatch = (await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicles[2].id, stationId: station.id, serviceMode: "self_drive",
    } })).json<Json>().data;
    assert.equal(noMatch.pricingEligibility, "manual_review");
    const ambiguous = (await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicles[3].id, stationId: station.id, serviceMode: "self_drive",
    } })).json<Json>().data;
    assert.equal(ambiguous.pricingReason, "ambiguous_price_plan");
    await database.prepare("UPDATE inspection_price_plans SET name = ? WHERE id = ?")
      .run("蓝牌（新能源）小型货车", "plan-new_energy_small_truck");
    await migrateDatabase(database);
    await seedDemoData(database);
    const renamedGeneratedPlan = (await app.inject({ method: "GET", url: "/api/admin/inspection-price-plans" })).json<Json>().data
      .find((item: Json) => item.id === "plan-new_energy_small_truck");
    assert.equal(renamedGeneratedPlan.name, "新能源小型货车");
    const preserved = (await app.inject({ method: "GET", url: "/api/admin/inspection-price-plans" })).json<Json>().data.find((item: Json) => item.id === plan.id);
    assert.deepEqual(preserved.plateCategories, ["new_energy_small_truck"]);
  } finally { await close(); }
});

test("车辆 API 规范化号牌，大小类别和动力以主动填写为准", async () => {
  const { app, close } = await fixture();
  try {
    const small = await createVehicle(app, "粤ｂ－ｄ１２３４５");
    assert.equal(small.plateNumber, "粤B·D12345");
    assert.equal(small.plateKind, "green_small");
    assert.equal(small.plateProvince, "粤");
    assert.equal(small.plateAgencyCode, "B");
    assert.equal(small.energyCategory, "none");

    const large = await createVehicle(app, "沪A12345F");
    assert.equal(large.plateNumber, "沪A·12345F");
    assert.equal(large.plateKind, "green_small");
    assert.equal(large.plateProvince, "沪");
    assert.equal(large.plateAgencyCode, "A");
    assert.equal(large.energyCategory, "none");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: { plateNumber: "粤B·D12345", registrationDate: "2020-01-01" },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json<Json>().error.code, "PLATE_ALREADY_EXISTS");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${large.id}`,
      payload: { plateNumber: "京C54321D", plateCategory: "new_energy_large_truck", powertrainType: "pure_electric" },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json<Json>().data.plateNumber, "京C·54321D");
    assert.equal(updated.json<Json>().data.plateKind, "green_large");
    assert.equal(updated.json<Json>().data.energyCategory, "pure_electric");

    const regional = await createVehicle(app, "津AB93080");
    assert.equal(regional.plateNumber, "津A·B93080");
    assert.equal(regional.plateKind, "green_small");
    assert.equal(regional.energyCategory, "none");
  } finally {
    await close();
  }
});

test("车辆 API 允许不同长度和特殊号牌，自由编辑时仅拦截空值与不安全字符", async () => {
  const { app, close } = await fixture();
  try {
    for (const plateNumber of ["港A12345", "津I12345", "津A1234", "粤Z1234港", "冀A警123456789"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/vehicles",
        payload: { plateNumber, registrationDate: "2020-01-01" },
      });
      assert.equal(response.statusCode, 201, `${plateNumber}: ${response.body}`);
      assert.equal(response.json<Json>().data.plateNumber, plateNumber);
    }

    const { vehicle } = await seedContext(app);
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${vehicle.id}`,
      payload: { plateNumber: "津 A · DF 12 学" },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json<Json>().data.plateNumber, "津A·DF12学");

    for (const plateNumber of ["", "津A#2345", "<script>", "津".repeat(33)]) {
      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/vehicles/${vehicle.id}`,
        payload: { plateNumber },
      });
      assert.equal(invalid.statusCode, 400, plateNumber);
      assert.equal(invalid.json<Json>().error.code, "VALIDATION_ERROR", plateNumber);
      assert.ok(invalid.json<Json>().error.fields.plateNumber, plateNumber);
    }
  } finally {
    await close();
  }
});

test("未确认的旧年检日期不显示倒计时或开放预约", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle } = await seedContext(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/inspection/status/${vehicle.id}`,
    });
    assert.equal(response.statusCode, 200);
    const status = response.json<Json>().data;
    assert.equal(status.dueDays, null);
    assert.equal(status.eligibility, "manual_review");
    assert.equal(status.canBook, false);
    assert.equal(status.inspectionValidity.mode, "unconfirmed");
    assert.match(status.dateEvidence.estimate?.dueDate || "", /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(status.materials.length >= 4);
    assert.match(status.ruleSource, /演示/);
    assert.match(status.ruleUpdatedAt, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await close();
  }
});

test("车型矩阵、代驾里程规则与地址联想返回可解释报价", async () => {
  const { app, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    const routeMeters = [100, 10_000, 10_100, 20_000, 30_000];
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/distance/v1/matrix")) {
        const distance = routeMeters.shift() ?? 100;
        return new Response(JSON.stringify({ status: 0, result: { rows: [{ elements: [{ distance, duration: 600 }] }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { vehicle, station } = await seedContext(app);
    const newEnergy = await createVehicle(app, "津A·D12345", "pure_electric");
    const sevenSeatResponse = await app.inject({
      method: "POST", url: "/api/vehicles", payload: {
        plateNumber: "津B·T7001", vehicleType: "7 座乘用车", usageNature: "非营运", seats: 7,
        registrationDate: "2020-01-01", inspectionDueDate: "2027-01-01",
      },
    });
    assert.equal(sevenSeatResponse.statusCode, 201, sevenSeatResponse.body);
    const quote = async (vehicleId: string, serviceMode = "self_drive", pickupAddress?: Json) => (
      await app.inject({ method: "POST", url: "/api/bookings/quote", payload: { vehicleId, stationId: station.id, serviceMode, pickupAddress } })
    ).json<Json>().data;
    assert.equal((await quote(vehicle.id)).inspectionFeeFen, 26000);
    assert.equal((await quote(newEnergy.id)).inspectionFeeFen, 24000);
    assert.equal((await quote(sevenSeatResponse.json<Json>().data.id)).inspectionFeeFen, 30000);

    const pickup = { poiId: "demo-near", title: "站点门口", address: "天津市河西区演示地址", district: "河西区", latitude: station.latitude, longitude: station.longitude, source: "demo" };
    const valet = await quote(vehicle.id, "valet", pickup);
    assert.equal(valet.valetFeeFen, 10900);
    assert.equal(valet.serviceable, true);
    assert.equal(valet.rule.includedKm, 10);
    assert.equal(valet.tripType, "round_trip_same_address");
    assert.ok(valet.quoteSnapshotId);

    const pickupAtDistance = (directKm: number) => ({
      ...pickup,
      poiId: `demo-${directKm}`,
      latitude: station.latitude + directKm / 111.195,
    });
    const atTenKm = await quote(vehicle.id, "valet", pickupAtDistance(10));
    assert.equal(atTenKm.distanceKm, 10);
    assert.equal(atTenKm.valetFeeFen, 10900);
    const overTenKm = await quote(vehicle.id, "valet", pickupAtDistance(10.1));
    assert.equal(overTenKm.distanceKm, 10.1);
    assert.equal(overTenKm.valetFeeFen, 11700);
    const atTwentyKm = await quote(vehicle.id, "valet", pickupAtDistance(20));
    assert.equal(atTwentyKm.distanceKm, 20);
    assert.equal(atTwentyKm.valetFeeFen, 18900);
    assert.equal(atTwentyKm.serviceable, true);

    const farAway = { ...pickup, poiId: "demo-far", latitude: station.latitude + 0.3 };
    const outside = await quote(vehicle.id, "valet", farAway);
    assert.equal(outside.serviceable, true);

    const suggestions = await app.inject({ method: "GET", url: "/api/locations/suggestions?query=文化中心" });
    assert.equal(suggestions.statusCode, 200, suggestions.body);
    assert.equal(suggestions.json<Json>().meta.source, "demo");
    assert.ok(suggestions.json<Json>().data.length <= 6);
    assert.ok(suggestions.json<Json>().data[0].latitude);
    assert.match(suggestions.json<Json>().data[0].locationProof, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("坐标解析在生产环境只签名腾讯逆地址结果并对上游故障关闭入口", async () => {
  const { app, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalEnvironment = process.env.YUXIAOMAN_ENV;
  const originalProofSecret = process.env.WASH_LOCATION_PROOF_SECRET;
  const originalFetch = globalThis.fetch;
  try {
    process.env.YUXIAOMAN_ENV = "production";
    process.env.TENCENT_MAP_KEY = "location-resolve-production-key";
    process.env.WASH_LOCATION_PROOF_SECRET = "location-resolve-production-secret-2026-test";
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        status: 0,
        result: {
          address: "天津市河西区乐园道9号",
          formatted_addresses: { recommend: "天津万象城", rough: "天津市河西区乐园道" },
          address_component: { province: "天津市", city: "天津市", district: "河西区" },
          ad_info: { adcode: "120103", name: "河西区" },
          pois: [{ id: "tencent-official-poi-1", title: "天津万象城", address: "乐园道9号" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const official = await app.inject({
      method: "POST",
      url: "/api/locations/resolve",
      payload: {
        latitude: 39.0896,
        longitude: 117.2138,
        name: "客户端伪造名称",
        address: "客户端伪造地址",
      },
    });
    assert.equal(official.statusCode, 200, official.body);
    assert.match(requestedUrl, /\/ws\/geocoder\/v1\//);
    assert.match(requestedUrl, /location=39\.0896%2C117\.2138/);
    const officialLocation = official.json<Json>().data;
    assert.equal(officialLocation.source, "tencent");
    assert.equal(officialLocation.poiId, "tencent-official-poi-1");
    assert.equal(officialLocation.title, "天津万象城");
    assert.equal(officialLocation.address, "天津市河西区乐园道9号");
    assert.equal(officialLocation.district, "河西区");
    assert.equal(officialLocation.latitude, 39.0896);
    assert.equal(officialLocation.longitude, 117.2138);
    assert.equal(validWashLocationProof(officialLocation), true);
    assert.doesNotMatch(official.body, /客户端伪造/);

    delete process.env.TENCENT_MAP_KEY;
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/locations/resolve",
      payload: { latitude: 39.0896, longitude: 117.2138, name: "不应被签名" },
    });
    assert.equal(missingKey.statusCode, 503, missingKey.body);
    assert.equal(missingKey.json<Json>().error.code, "LOCATION_RESOLUTION_UNAVAILABLE");
    assert.equal(missingKey.json<Json>().error.fields.mapErrorCode, "TENCENT_KEY_MISSING");

    process.env.TENCENT_MAP_KEY = "location-resolve-production-key";
    globalThis.fetch = (async () => {
      const timeout = new Error("Tencent reverse geocoder timed out");
      timeout.name = "TimeoutError";
      throw timeout;
    }) as typeof fetch;
    const timedOut = await app.inject({
      method: "POST",
      url: "/api/locations/resolve",
      payload: { latitude: 39.0896, longitude: 117.2138, address: "不应被签名" },
    });
    assert.equal(timedOut.statusCode, 503, timedOut.body);
    assert.equal(timedOut.json<Json>().error.fields.mapErrorCode, "TENCENT_TIMEOUT");

    globalThis.fetch = (async () => new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const malformed = await app.inject({
      method: "POST",
      url: "/api/locations/resolve",
      payload: { latitude: 39.0896, longitude: 117.2138 },
    });
    assert.equal(malformed.statusCode, 503, malformed.body);
    assert.equal(malformed.json<Json>().error.fields.mapErrorCode, "TENCENT_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    if (originalEnvironment === undefined) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = originalEnvironment;
    if (originalProofSecret === undefined) delete process.env.WASH_LOCATION_PROOF_SECRET;
    else process.env.WASH_LOCATION_PROOF_SECRET = originalProofSecret;
    await close();
  }
});

test("坐标解析在非生产环境返回明确标记且可验证的演示地址", async () => {
  const { app, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalEnvironment = process.env.YUXIAOMAN_ENV;
  try {
    delete process.env.TENCENT_MAP_KEY;
    process.env.YUXIAOMAN_ENV = "development";
    const resolved = await app.inject({
      method: "POST",
      url: "/api/locations/resolve",
      payload: {
        latitude: 39.1059,
        longitude: 117.2445,
        name: "第六大道第博雅园",
        address: "天津市河东区昆仑路第六大道博雅园",
      },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    const location = resolved.json<Json>().data;
    assert.equal(location.source, "demo");
    assert.equal(location.title, "第六大道第博雅园");
    assert.equal(location.address, "天津市河东区昆仑路第六大道博雅园");
    assert.equal(location.district, "河东区");
    assert.equal(validWashLocationProof(location), true);
    assert.equal(resolved.json<Json>().meta.source, "demo");
    assert.equal(resolved.json<Json>().meta.mapErrorCode, "TENCENT_KEY_MISSING");

    const outsideBounds = await app.inject({
      method: "POST",
      url: "/api/locations/resolve",
      payload: { latitude: 40.31, longitude: 117.2445 },
    });
    assert.equal(outsideBounds.statusCode, 400, outsideBounds.body);
    assert.equal(outsideBounds.json<Json>().error.code, "VALIDATION_ERROR");
  } finally {
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    if (originalEnvironment === undefined) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = originalEnvironment;
    await close();
  }
});

test("年检代驾地址沿用签名凭证并在生产环境缺失密钥时关闭入口", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalEnvironment = process.env.YUXIAOMAN_ENV;
  const originalProofSecret = process.env.WASH_LOCATION_PROOF_SECRET;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "annual-location-proof-test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 1_200, duration: 360 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { vehicle, station } = await seedContext(app);
    const pickupAddress = {
      poiId: "annual-proof-poi",
      title: "天津文化中心停车场",
      address: "天津市河西区平江道 58 号",
      district: "河西区",
      latitude: station.latitude,
      longitude: station.longitude,
      source: "tencent" as const,
    };
    const signedPickup = {
      ...pickupAddress,
      locationProof: createWashLocationProof(pickupAddress),
    };
    const valid = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress: signedPickup },
    });
    assert.equal(valid.statusCode, 200, valid.body);

    const tampered = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        serviceMode: "valet",
        pickupAddress: { ...signedPickup, address: `${signedPickup.address}（已篡改）` },
      },
    });
    assert.equal(tampered.statusCode, 409, tampered.body);
    assert.equal(tampered.json<Json>().error.code, "PICKUP_ADDRESS_PROOF_INVALID");

    const tamperedCreate = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: "unused-because-proof-fails-first",
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "valet",
        pickupAddress: { ...signedPickup, title: `${signedPickup.title}（已篡改）` },
        quoteSnapshotId: valid.json<Json>().data.quoteSnapshotId,
        mediaIds: [],
      },
    });
    assert.equal(tamperedCreate.statusCode, 409, tamperedCreate.body);
    assert.equal(tamperedCreate.json<Json>().error.code, "PICKUP_ADDRESS_PROOF_INVALID");

    const ownerSession = await createDevelopmentSession(database, { userId: "demo-user" });
    // This case targets production address-proof validation, not the separate
    // production guard that rejects demo identities. Reclassify only this
    // isolated fixture after issuing its test token so the request reaches the
    // intended proof boundary.
    await database.query("UPDATE users SET data_kind = 'real' WHERE id = 'demo-user'");
    process.env.YUXIAOMAN_ENV = "production";
    delete process.env.WASH_LOCATION_PROOF_SECRET;
    const unsignedProduction = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress },
    });
    assert.equal(unsignedProduction.statusCode, 409, unsignedProduction.body);
    assert.equal(unsignedProduction.json<Json>().error.code, "PICKUP_ADDRESS_PROOF_REQUIRED");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    if (originalEnvironment === undefined) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = originalEnvironment;
    if (originalProofSecret === undefined) delete process.env.WASH_LOCATION_PROOF_SECRET;
    else process.env.WASH_LOCATION_PROOF_SECRET = originalProofSecret;
    await close();
  }
});

test("站点路线以起点驱动排序，预计距离与预约报价使用同一计算口径", async () => {
  const { app, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.TENCENT_MAP_KEY;
    const { vehicle, station } = await seedContext(app);
    const noOrigin = await app.inject({ method: "GET", url: "/api/stations" });
    assert.equal(noOrigin.statusCode, 200, noOrigin.body);
    assert.equal(noOrigin.json<Json>().data[0].distanceKm, null);
    assert.equal(noOrigin.json<Json>().data[0].driveMinutes, null);
    assert.equal(noOrigin.json<Json>().data[0].distanceBasis, "no_origin");
    assert.equal(noOrigin.json<Json>().meta.distanceNotice, "确定起点后计算");

    const sixthAvenue = {
      poiId: "demo-sixth-avenue",
      title: "第六大道第博雅园",
      address: "河东区昆仑路第六大道博雅园（演示坐标）",
      district: "河东区",
      latitude: 39.1059,
      longitude: 117.2445,
      source: "demo",
    };
    const stationsResponse = await app.inject({
      method: "GET",
      url: `/api/stations?originLat=${sixthAvenue.latitude}&originLng=${sixthAvenue.longitude}&originType=valet`,
    });
    assert.equal(stationsResponse.statusCode, 200, stationsResponse.body);
    const stations = stationsResponse.json<Json>().data;
    assert.ok(stations.every((item: Json) => item.distanceBasis === "estimated_distance"));
    assert.ok(stations.every((item: Json) => item.distanceSource === "estimated"));
    assert.equal(stations[0].id, HUAYANG_STATION_ID);
    assert.deepEqual(
      stations.slice(1).map((item: Json) => item.distanceKm),
      [...stations.slice(1).map((item: Json) => item.distanceKm)].sort((left, right) => left - right),
    );

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress: sixthAvenue },
    });
    assert.equal(quoteResponse.statusCode, 503, quoteResponse.body);
    assert.equal(quoteResponse.json<Json>().error.code, "REAL_ROUTE_REQUIRED");
    assert.equal(quoteResponse.json<Json>().error.fields.mapErrorCode, "TENCENT_KEY_MISSING");

    const noPickupQuote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet" },
    });
    assert.equal(noPickupQuote.statusCode, 200, noPickupQuote.body);
    assert.equal(noPickupQuote.json<Json>().data.distanceKm, null);
    assert.equal(noPickupQuote.json<Json>().data.valetFeeFen, 0);
    assert.equal(noPickupQuote.json<Json>().data.reason, "origin_required");

    const invalidOrigin = await app.inject({ method: "GET", url: "/api/stations?originLat=39.1&originType=self_drive" });
    assert.equal(invalidOrigin.statusCode, 400);
    assert.equal(invalidOrigin.json<Json>().error.code, "INVALID_ORIGIN");

    process.env.TENCENT_MAP_KEY = "test-key";
    let matrixCalls = 0;
    globalThis.fetch = (async () => {
      matrixCalls += 1;
      throw new Error("Tencent route service unavailable");
    }) as typeof fetch;
    const failedTencent = await app.inject({
      method: "GET",
      url: `/api/stations?originLat=${station.latitude}&originLng=${station.longitude}&originType=current_location`,
    });
    assert.equal(failedTencent.statusCode, 200, failedTencent.body);
    assert.equal(matrixCalls, 1);
    assert.equal(failedTencent.json<Json>().data[0].distanceBasis, "estimated_distance");
    assert.equal(failedTencent.json<Json>().data[0].distanceSource, "estimated");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("腾讯矩阵成功时一次计算所有站点并按真实路线排序", async () => {
  const { app, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        status: 0,
        result: {
          rows: [{
            elements: [
              { distance: 8_800, duration: 1_620 },
              { distance: 2_100, duration: 420 },
              { distance: 5_600, duration: 1_020 },
              { distance: 4_000, duration: 780 },
            ],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const response = await app.inject({
      method: "GET",
      url: "/api/stations?originLat=39.09&originLng=117.20&originType=self_drive",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(requestedUrl, /\/distance\/v1\/matrix/);
    const stations = response.json<Json>().data;
    assert.deepEqual(stations.map((item: Json) => item.distanceKm), [8.8, 2.1, 4, 5.6]);
    assert.deepEqual(stations.map((item: Json) => item.driveMinutes), [27, 7, 13, 17]);
    assert.equal(stations[0].id, HUAYANG_STATION_ID);
    assert.ok(stations.every((item: Json) => item.distanceBasis === "driving_route"));
    assert.ok(stations.every((item: Json) => item.distanceSource === "tencent_matrix"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("代驾预约要求四角、启动后仪表盘和两张行驶证，预检问题可关联洗车维修", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  let restartedApp: FastifyInstance | undefined;
  let restartedUploadDir: string | undefined;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 100, duration: 60 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { vehicle, station, slots } = await seedContext(app);
    const pickupAddress = { poiId: "demo-pickup", title: "天津文化中心地下停车场", address: "河西区平江道 58 号", district: "河西区", latitude: station.latitude, longitude: station.longitude, source: "demo" };
    const completeMedia = await uploadAnnualBookingMedia(app);
    const licenseFront = completeMedia.find((item) => item.kind === "license_front")!;
    const licenseBack = completeMedia.find((item) => item.kind === "license_back")!;
    assert.equal(licenseFront.mimeType, "image/jpeg");
    assert.ok(licenseFront.width <= 2048 && licenseFront.height <= 2048);
    const quoted = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress,
    } });
    assert.equal(quoted.statusCode, 200, quoted.body);

    const missingLicensePage = await app.inject({ method: "POST", url: "/api/bookings", payload: {
      vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id, contactName: "张女士", contactPhone: "13800138000",
      serviceMode: "valet", pickupAddress, quoteSnapshotId: quoted.json<Json>().data.quoteSnapshotId,
      mediaIds: [licenseFront.id],
    } });
    assert.equal(missingLicensePage.statusCode, 400);
    assert.equal(missingLicensePage.json<Json>().error.code, "BOOKING_MEDIA_REQUIRED");
    assert.match(missingLicensePage.json<Json>().error.fields.mediaIds, /license_back/);
    const mismatchedPickup = await app.inject({ method: "POST", url: "/api/bookings", payload: {
      vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id, contactName: "张女士", contactPhone: "13800138000",
      serviceMode: "valet", pickupAddress: { ...pickupAddress, latitude: pickupAddress.latitude + 0.001 },
      quoteSnapshotId: quoted.json<Json>().data.quoteSnapshotId,
      mediaIds: completeMedia.map((item) => item.id),
    } });
    assert.equal(mismatchedPickup.statusCode, 409, mismatchedPickup.body);
    assert.equal(mismatchedPickup.json<Json>().error.code, "QUOTE_PICKUP_MISMATCH");
    const created = await app.inject({ method: "POST", url: "/api/bookings", payload: {
      vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id, contactName: "张女士", contactPhone: "13800138000",
      serviceMode: "valet", pickupAddress: { ...pickupAddress, detail: "B2-156", note: "从北门进入" },
      quoteSnapshotId: quoted.json<Json>().data.quoteSnapshotId,
      mediaIds: completeMedia.map((item) => item.id),
    } });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    assert.equal(booking.media.length, 7);
    assert.equal(booking.pickupAddress.detail, "B2-156");
    assert.equal(booking.valetFeeFen, 10900);
    assert.equal(booking.tripType, "round_trip_same_address");
    assert.ok(booking.quoteSnapshotId);
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM booking_media WHERE booking_id = ?").get(booking.id))?.count), 7);

    restartedUploadDir = mkdtempSync(join(tmpdir(), "yuxiaoman-restarted-uploads-"));
    restartedApp = await buildApp({ database, uploadDir: restartedUploadDir });
    await restartedApp.ready();
    const restartedHealth = (await restartedApp.inject({ method: "GET", url: "/api/health" })).json<Json>().data;
    assert.equal(restartedHealth.map.status, "configured");
    const paidAfterRestart = await restartedApp.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "pay-after-restart-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(paidAfterRestart.statusCode, 201, paidAfterRestart.body);
    await database.prepare("UPDATE bookings SET quote_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", booking.id);
    const expiredPayment = await restartedApp.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "pay-after-expiry-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(expiredPayment.statusCode, 409, expiredPayment.body);
    assert.equal(expiredPayment.json<Json>().error.code, "QUOTE_EXPIRED");

    const precheckDetail = await app.inject({ method: "GET", url: `/api/operator/prechecks/${booking.id}` });
    assert.equal(precheckDetail.statusCode, 200, precheckDetail.body);
    assert.deepEqual(precheckDetail.json<Json>().data.precheck.guidance.map((item: Json) => item.code), [
      "license_unclear", "vehicle_photos_incomplete", "vehicle_information_mismatch",
      "booking_information_mismatch", "materials_cannot_be_verified", "body_dirty",
      "body_damage", "dashboard_warning", "other",
    ]);
    const precheckVersion = precheckDetail.json<Json>().data.precheck.version;
    const rejected = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/reject`, payload: {
      expectedVersion: precheckVersion,
      idempotencyKey: "valet-precheck-license-reject",
      reasonCodes: ["license_unclear"],
      reasonText: "行驶证副页反光，需要车主重新拍摄",
      issuePhotoKinds: ["license_back"],
    } });
    assert.equal(rejected.statusCode, 200, rejected.body);

    const replacementLicenseBack = await uploadMedia(app, "license_back");
    const resubmitted = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, payload: {
      expectedVersion: rejected.json<Json>().data.precheck.version,
      idempotencyKey: "valet-precheck-valid-media",
      slotId: slots[0].id,
      mediaIds: [replacementLicenseBack.id],
      resolutionNote: "已重新拍摄清晰的行驶证副页",
    } });
    assert.equal(resubmitted.statusCode, 200, resubmitted.body);
    assert.equal(resubmitted.json<Json>().data.media.length, 7);
    const approved = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/approve`, payload: {
      expectedVersion: resubmitted.json<Json>().data.precheck.version,
      idempotencyKey: "valet-precheck-approved",
    } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json<Json>().data.fulfillmentStatus, "confirmed");
    assert.match(
      approved.json<Json>().data.events.find((item: Json) => item.title === "检测站预审通过").description,
      /核对 7 张预约资料/,
    );

    const pending = await uploadMedia(app, "license_front");
    const deleted = await app.inject({ method: "DELETE", url: `/api/media/${pending.id}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal((await app.inject({ method: "GET", url: `/api/media/${pending.id}` })).statusCode, 404);
  } finally {
    if (restartedApp) await restartedApp.close();
    if (restartedUploadDir) rmSync(restartedUploadDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("自驾预约同样要求四角、启动后仪表盘和两张行驶证", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const quoted = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "self_drive" },
    });
    assert.equal(quoted.statusCode, 200, quoted.body);
    const withoutDashboard = await Promise.all(
      annualBookingMediaKinds
        .filter((kind) => kind !== "dashboard_started")
        .map((kind) => uploadMedia(app, kind)),
    );
    const basePayload = {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
      contactName: "张女士",
      contactPhone: "13800138000",
      serviceMode: "self_drive",
      quoteSnapshotId: quoted.json<Json>().data.quoteSnapshotId,
    };
    const missing = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: { ...basePayload, mediaIds: withoutDashboard.map((item) => item.id) },
    });
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(missing.json<Json>().error.code, "BOOKING_MEDIA_REQUIRED");
    assert.match(missing.json<Json>().error.fields.mediaIds, /dashboard_started/);

    const dashboard = await uploadMedia(app, "dashboard_started");
    const created = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: { ...basePayload, mediaIds: [...withoutDashboard.map((item) => item.id), dashboard.id] },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json<Json>().data.media.length, 7);
  } finally {
    await close();
  }
});

test("支付后进入跨日期预审队列，七图缺失时禁止检测站通过", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "precheck-queue-payment-0001",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    assert.equal(paid.json<Json>().data.booking.precheck.status, "pending");
    assert.equal(paid.json<Json>().data.booking.precheck.refundStatus, "not_requested");

    const queue = await app.inject({
      method: "GET",
      url: `/api/operator/prechecks?stationId=${station.id}`,
    });
    assert.equal(queue.statusCode, 200, queue.body);
    assert.equal(queue.json<Json>().data.items.filter((item: Json) => item.id === booking.id).length, 1);
    assert.equal(queue.json<Json>().data.items.find((item: Json) => item.id === booking.id).media.length, 7);
    await database.prepare("UPDATE booking_prechecks SET submitted_at = ? WHERE booking_id = ?")
      .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), booking.id);
    const beforeWorkerQueue = await app.inject({
      method: "GET",
      url: `/api/operator/prechecks?stationId=${station.id}`,
    });
    const beforeWorkerItem = beforeWorkerQueue.json<Json>().data.items.find((item: Json) => item.id === booking.id);
    assert.equal(beforeWorkerItem.precheck.reminderDue, false);
    const workflowTask = await database.prepare<Record<string, unknown>>(`
      SELECT id, due_at FROM workflow_tasks
      WHERE entity_type = 'booking' AND entity_id = ?
        AND node_code = 'annual.precheck.pending' AND status = 'open'
    `).get(booking.id);
    assert.ok(workflowTask);
    assert.ok(workflowTask?.due_at);
    const workerNow = new Date();
    const alreadyDue = new Date(workerNow.getTime() - 1_000).toISOString();
    await database.prepare(`
      UPDATE workflow_tasks
      SET next_reminder_at = ?, due_at = ?, escalate_at = ?
      WHERE id = ?
    `).run(alreadyDue, alreadyDue, alreadyDue, String(workflowTask.id));
    await runWorkflowWorkerOnce(database, {
      now: workerNow,
      sender: async () => ({ outcome: "accepted" }),
    });
    const overdueQueue = await app.inject({
      method: "GET",
      url: `/api/operator/prechecks?stationId=${station.id}`,
    });
    const overdueItem = overdueQueue.json<Json>().data.items.find((item: Json) => item.id === booking.id);
    // Merely aging submitted_at no longer pretends a station message was sent;
    // reminder state comes from the workflow worker touching the persisted task.
    assert.equal(overdueItem.precheck.reminderDue, true);
    assert.equal(overdueItem.precheck.overdue, true);
    assert.ok(overdueItem.precheck.supervision.lastRemindedAt);
    assert.ok(overdueItem.precheck.supervision.escalatedAt);

    await database.prepare("DELETE FROM booking_media WHERE booking_id = ? AND kind = 'dashboard_started'").run(booking.id);
    const detail = await app.inject({ method: "GET", url: `/api/operator/prechecks/${booking.id}` });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/operator/prechecks/${booking.id}/approve`,
      payload: {
        idempotencyKey: "precheck-missing-photo-0001",
        expectedVersion: detail.json<Json>().data.precheck.version,
      },
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json<Json>().error.code, "PRECHECK_MEDIA_INCOMPLETE");
  } finally {
    await close();
  }
});

test("预检退回保留款项并释放号源，只有车主申请才全额模拟退款", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const initialRemaining = slots[0].remaining;
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "precheck-reject-payment-0001",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    const expectedVersion = paid.json<Json>().data.booking.precheck.version;

    const invalid = await app.inject({
      method: "POST",
      url: `/api/operator/prechecks/${booking.id}/reject`,
      payload: {
        idempotencyKey: "precheck-reject-invalid-0001",
        expectedVersion,
        reasonCodes: [],
        reasonText: "短",
        issuePhotoKinds: [],
      },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);

    const missingLicensePhoto = await app.inject({
      method: "POST",
      url: `/api/operator/prechecks/${booking.id}/reject`,
      payload: {
        idempotencyKey: "precheck-reject-missing-license-photo-0001",
        expectedVersion,
        reasonCodes: ["license_unclear"],
        reasonText: "行驶证副页反光严重，关键信息无法核验",
        issuePhotoKinds: [],
      },
    });
    assert.equal(missingLicensePhoto.statusCode, 400, missingLicensePhoto.body);
    assert.equal(missingLicensePhoto.json<Json>().error.code, "PRECHECK_ISSUE_PHOTO_REQUIRED");
    assert.match(missingLicensePhoto.json<Json>().error.message, /行驶证/);

    const rejectionPayload = {
      idempotencyKey: "precheck-reject-valid-0001",
      expectedVersion,
      reasonCodes: ["license_unclear"],
      reasonText: "行驶证副页反光严重，关键信息无法核验",
      issuePhotoKinds: ["license_back"],
    };
    const rejected = await app.inject({
      method: "POST",
      url: `/api/operator/prechecks/${booking.id}/reject`,
      payload: rejectionPayload,
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    const rejectedBooking = rejected.json<Json>().data;
    assert.equal(rejectedBooking.fulfillmentStatus, "precheck_action_required");
    assert.equal(rejectedBooking.paymentStatus, "paid");
    assert.equal(rejectedBooking.precheck.status, "rejected");
    assert.equal(rejectedBooking.precheck.refundStatus, "not_requested");
    assert.equal(rejectedBooking.precheck.refundAmountFen, 0);
    assert.equal(rejectedBooking.refundedFen, 0);
    assert.equal(rejectedBooking.chargedFen, booking.serviceFeeFen);
    assert.deepEqual(rejectedBooking.precheck.issuePhotoKinds, ["license_back"]);

    const repeated = await app.inject({
      method: "POST",
      url: `/api/operator/prechecks/${booking.id}/reject`,
      payload: rejectionPayload,
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    const blockedStationRefund = await app.inject({ method: "PATCH", url: `/api/admin/bookings/${booking.id}`, payload: { refund: { amountFen: booking.serviceFeeFen, reason: "检测站尝试退款", idempotencyKey: "station-forbidden-refund" } } });
    assert.equal(blockedStationRefund.statusCode, 403, blockedStationRefund.body);
    const ownerRefund = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/cancel` });
    assert.equal(ownerRefund.statusCode, 200, ownerRefund.body);
    assert.equal(ownerRefund.json<Json>().data.refundedFen, booking.serviceFeeFen);
    const again = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/cancel` });
    assert.equal(again.statusCode, 200, again.body);
    const refundCount = Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM booking_ledger_entries
      WHERE booking_id = ? AND kind = 'refund'
    `).get(booking.id))?.count);
    assert.equal(refundCount, 1);
    await database.prepare(`
      UPDATE booking_prechecks SET refund_status = 'refund_failed', refund_error = '模拟通道异常'
      WHERE booking_id = ?
    `).run(booking.id);
    const failedRefundFilter = await app.inject({ method: "GET", url: "/api/admin/bookings?status=refund_failed" });
    assert.equal(failedRefundFilter.statusCode, 200, failedRefundFilter.body);
    assert.ok(failedRefundFilter.json<Json>().data.some((item: Json) => item.id === booking.id));
    const retriedRefund = await app.inject({
      method: "POST",
      url: `/api/admin/bookings/${booking.id}/precheck-refund/retry`,
    });
    assert.equal(retriedRefund.statusCode, 200, retriedRefund.body);
    assert.equal(retriedRefund.json<Json>().data.precheck.refundStatus, "refunded");
    assert.equal(retriedRefund.json<Json>().data.precheck.refundError, null);
    const slot = (await app.inject({
      method: "GET",
      url: `/api/stations/${station.id}/slots?date=${slots[0].date}`,
    })).json<Json>().data.find((item: Json) => item.id === slots[0].id);
    assert.equal(slot.remaining, initialRemaining);

    const conflictingApprove = await app.inject({
      method: "POST",
      url: `/api/operator/prechecks/${booking.id}/approve`,
      payload: { idempotencyKey: "precheck-conflict-approve-0001", expectedVersion },
    });
    assert.equal(conflictingApprove.statusCode, 409, conflictingApprove.body);
    assert.equal(conflictingApprove.json<Json>().error.code, "PRECHECK_ALREADY_DECIDED");
  } finally {
    await close();
  }
});

test("预检待处理可补拍复核，时段和款项不重复占用，原照片保留", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id });
    const booking = created.json<Json>().data;
    const oldPhoto = booking.media.find((item: Json) => item.kind === "license_back");
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: { provider: "mock", idempotencyKey: "resubmit-paid-001", quoteSnapshotId: booking.quoteSnapshotId } });
    const returned = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/reject`, payload: {
      expectedVersion: paid.json<Json>().data.booking.precheck.version, idempotencyKey: "resubmit-reject-001", reasonCodes: ["license_unclear"], reasonText: "行驶证副页反光，请补拍清晰照片", issuePhotoKinds: ["license_back"],
    } });
    assert.equal(returned.statusCode, 200, returned.body);
    const version = returned.json<Json>().data.precheck.version;
    const replacement = await uploadMedia(app, "license_back");
    const body = { expectedVersion: version, idempotencyKey: "resubmit-owner-001", slotId: slots[0].id, mediaIds: [replacement.id], resolutionNote: "已重新拍摄清晰的行驶证副页" };
    const missing = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, payload: { ...body, mediaIds: [] } });
    assert.equal(missing.statusCode, 400, missing.body);
    await database.prepare("UPDATE station_slots SET booked_count = capacity WHERE id = ?").run(slots[0].id);
    const full = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, payload: body });
    assert.equal(full.statusCode, 409, full.body);
    assert.equal(full.json<Json>().error.code, "SLOT_FULL");
    assert.equal((await database.prepare<Json>("SELECT booking_id FROM booking_media WHERE id = ?").get(replacement.id))?.booking_id, null);
    await database.prepare("UPDATE station_slots SET booked_count = capacity - ? WHERE id = ?").run(slots[0].remaining, slots[0].id);
    const owner = await createDevelopmentSession(database, { userId: "precheck-other-owner" });
    const foreign = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, headers: { authorization: `Bearer ${owner.token}` }, payload: body });
    assert.equal(foreign.statusCode, 404, foreign.body);
    const submitted = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, payload: body });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const next = submitted.json<Json>().data;
    assert.equal(next.fulfillmentStatus, "pending_precheck");
    assert.equal(next.media.length, 7);
    assert.equal(next.paidFen, booking.serviceFeeFen);
    assert.equal(next.refundedFen, 0);
    assert.equal(next.serviceFeeFen, booking.serviceFeeFen);
    assert.equal(next.precheckSlotReleased, false);
    assert.ok(next.media.some((item: Json) => item.id === replacement.id));
    assert.equal((await database.prepare<Json>("SELECT is_current FROM booking_media WHERE id = ?").get(oldPhoto.id))?.is_current, 0);
    assert.equal((await app.inject({ method: "GET", url: `/api/media/${oldPhoto.id}` })).statusCode, 200);
    const adminDetail = await app.inject({ method: "GET", url: `/api/admin/bookings/${booking.id}` });
    assert.equal(adminDetail.statusCode, 200, adminDetail.body);
    const archived = adminDetail.json<Json>().data.precheck.history
      .flatMap((entry: Json) => entry.issueMedia || [])
      .find((item: Json) => item.id === oldPhoto.id);
    assert.ok(archived, "后台应能看到车主更新前的问题照片留档");
    assert.equal(archived.kind, "license_back");
    assert.match(String(archived.url), new RegExp(`/api/admin/bookings/${booking.id}/media/${oldPhoto.id}`));
    assert.equal(archived.isCurrent, false);
    assert.ok(
      (adminDetail.json<Json>().data.precheck.priorIssueMedia || []).some((item: Json) => item.id === oldPhoto.id),
      "priorIssueMedia 应汇总更新前问题照片",
    );
    const ownerDetail = await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` });
    assert.equal(ownerDetail.statusCode, 200, ownerDetail.body);
    assert.equal(
      (ownerDetail.json<Json>().data.precheck.history || []).some((entry: Json) => Array.isArray(entry.issueMedia)),
      false,
      "车主端不应附带后台问题照片留档字段",
    );
    const repeated = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, payload: body });
    assert.equal(repeated.statusCode, 200, repeated.body);
    const changedRetry = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, payload: { ...body, resolutionNote: "不同内容不能复用同一个幂等键" } });
    assert.equal(changedRetry.statusCode, 409, changedRetry.body);
    const stale = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/approve`, payload: { expectedVersion: version, idempotencyKey: "stale-review-001" } });
    assert.equal(stale.statusCode, 409, stale.body);
    const approved = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/approve`, payload: { expectedVersion: next.precheck.version, idempotencyKey: "resubmit-approved-001" } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json<Json>().data.fulfillmentStatus, "awaiting_arrival");
    const slot = await database.prepare<Json>("SELECT capacity, booked_count FROM station_slots WHERE id = ?").get(slots[0].id);
    assert.equal(Number(slot!.capacity) - Number(slot!.booked_count), slots[0].remaining - 1);
  } finally { await close(); }
});

test("预检维修快照兼容重复初始化与客户中心，排除错链并在补拍取消清理后保留", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id });
    const booking = created.json<Json>().data;
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: { provider: "mock", idempotencyKey: "precheck-repair-pay", quoteSnapshotId: booking.quoteSnapshotId } });
    const decision = { expectedVersion: paid.json<Json>().data.booking.precheck.version, idempotencyKey: "precheck-repair-reject", reasonCodes: ["body_damage", "dashboard_warning", "license_unclear"], reasonText: "车身与仪表盘需维修核对，副页反光需补拍", issuePhotoKinds: ["vehicle_front_left", "dashboard_started", "license_back"] };
    const noPhoto = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/reject`, payload: { ...decision, issuePhotoKinds: ["license_back"] } });
    assert.equal(noPhoto.statusCode, 400, noPhoto.body);
    const returned = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/reject`, payload: decision });
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(returned.json<Json>().data.precheck.guidance.find((item: Json) => item.code === "dashboard_warning").action, "repair");
    const body = { bookingId: booking.id, expectedVersion: returned.json<Json>().data.precheck.version, reasonCodes: ["body_damage", "dashboard_warning"], consented: true };
    const noConsent = await app.inject({ method: "POST", url: "/api/repair/precheck-requests", payload: { ...body, consented: false } });
    assert.equal(noConsent.statusCode, 400, noConsent.body);
    const published = await app.inject({ method: "POST", url: "/api/repair/precheck-requests", payload: body });
    assert.equal(published.statusCode, 201, published.body);
    const repair = published.json<Json>().data;
    assert.equal(repair.sourceType, "precheck");
    assert.equal(repair.sourceBookingId, booking.id);
    assert.equal(repair.report.annualConclusion, null);
    assert.equal(repair.faults.length, 2);
    assert.equal(repair.media.length, 2);
    // Startup must accept precheck requests without fabricating a report/fault source.
    await migrateDatabase(database);
    await migrateDatabase(database);
    const password = "customer precheck regression password";
    await createInitialPlatformAdmin(database, { loginName: "platform.precheck", displayName: "客户资料测试管理员", password });
    const login = await app.inject({ method: "POST", url: "/api/backoffice/sessions", payload: { loginName: "platform.precheck", password } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0] };
    const listRepairMaterials = () => app.inject({ method: "GET", url: "/api/admin/customers/demo-user/materials?domain=repair", headers });
    const listed = await listRepairMaterials();
    assert.equal(listed.statusCode, 200, listed.body);
    const materials = listed.json<Json>().data.items.filter((item: Json) => item.businessId === repair.id);
    assert.equal(materials.length, 2);
    const copiedBytes = new Map<string, Buffer>();
    for (const material of materials) {
      assert.equal(material.available, true);
      assert.equal(material.purpose, "预检维修报价授权快照");
      assert.equal(JSON.stringify(material).includes("precheck-"), false);
      const content = await app.inject({ method: "GET", url: material.contentPath, headers });
      assert.equal(content.statusCode, 200, content.body);
      assert.equal(content.headers["cache-control"], "private, no-store");
      copiedBytes.set(material.id, content.rawPayload);
    }
    const audit = await database.prepare<Json>(`SELECT COUNT(*)::integer AS count FROM backoffice_audit_events
      WHERE action = 'customer.material.read' AND resource_id IN (SELECT id FROM repair_request_media WHERE request_id = ?)`)
      .get(repair.id);
    assert.equal(audit?.count, 2);
    const mediaRow = (await database.prepare<Json>("SELECT * FROM repair_request_media WHERE request_id = ? ORDER BY id LIMIT 1").get(repair.id))!;
    const invalidPath = `/api/admin/customers/demo-user/materials/repair/${mediaRow.id}/content`;
    const expectInvalidSource = async () => {
      await assert.rejects(migrateCustomerCenterDatabase(database), /inconsistent repair media source/u);
      const hidden = await listRepairMaterials();
      assert.equal(hidden.statusCode, 200, hidden.body);
      assert.equal(hidden.json<Json>().data.items.some((item: Json) => item.id === mediaRow.id), false);
      assert.equal((await app.inject({ method: "GET", url: invalidPath, headers })).statusCode, 404);
    };
    // Even a valid booking-media ID cannot authorize licenses or another owner's photos.
    await database.prepare("UPDATE repair_request_media SET precheck_media_id = ? WHERE id = ?")
      .run(booking.media.find((item: Json) => item.kind === "license_front").id, mediaRow.id);
    await expectInvalidSource();
    await database.prepare(`INSERT INTO booking_media (id, user_id, booking_id, kind, storage_key,
      mime_type, size_bytes, width, height, created_at, bound_at, expires_at)
      SELECT 'foreign-precheck-photo', 'operator-user-1', 'booking-op-1', kind, 'foreign-precheck-photo.jpg',
        mime_type, size_bytes, width, height, created_at, bound_at, expires_at FROM booking_media WHERE id = ?`)
      .run(mediaRow.precheck_media_id);
    await database.prepare("UPDATE repair_request_media SET precheck_media_id = 'foreign-precheck-photo' WHERE id = ?").run(mediaRow.id);
    await expectInvalidSource();
    await database.prepare("UPDATE repair_request_media SET precheck_media_id = ? WHERE id = ?").run(mediaRow.precheck_media_id, mediaRow.id);
    await database.prepare("UPDATE repair_requests SET source_precheck_version = 999 WHERE id = ?").run(repair.id);
    await assert.rejects(migrateCustomerCenterDatabase(database), /inconsistent repair source ownership chain/u);
    assert.equal((await app.inject({ method: "GET", url: invalidPath, headers })).statusCode, 404);
    await database.prepare("UPDATE repair_requests SET source_precheck_version = ? WHERE id = ?").run(body.expectedVersion, repair.id);
    await migrateDatabase(database);
    const licenseIds = booking.media.filter((item: Json) => item.kind.startsWith("license_")).map((item: Json) => item.id);
    assert.ok(repair.media.every((item: Json) => !licenseIds.includes(item.sourceMediaId)));
    const duplicated = await app.inject({ method: "POST", url: "/api/repair/precheck-requests", payload: body });
    assert.equal(duplicated.statusCode, 200, duplicated.body);
    assert.equal(duplicated.json<Json>().data.id, repair.id);
    const other = await createDevelopmentSession(database, { userId: "other-repair-owner" });
    const foreign = await app.inject({ method: "GET", url: repair.media[0].url, headers: { authorization: `Bearer ${other.token}` } });
    assert.equal(foreign.statusCode, 404, foreign.body);
    const foreignCustomer = await app.inject({ method: "GET", url: `/api/admin/customers/other-repair-owner/materials/repair/${mediaRow.id}/content`, headers });
    assert.equal(foreignCustomer.statusCode, 404, foreignCustomer.body);
    const linked = (await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` })).json<Json>().data;
    assert.equal(linked.precheckServices[0].id, repair.id);
    const replacements = [];
    for (const kind of ["vehicle_front_left", "dashboard_started", "license_back"]) replacements.push(await uploadMedia(app, kind));
    const resubmitted = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/precheck/resubmit`, payload: {
      expectedVersion: body.expectedVersion, idempotencyKey: "repair-customer-resubmit", slotId: slots[0].id,
      mediaIds: replacements.map((item) => item.id), resolutionNote: "已处理并重新拍摄，请检测站复核",
    } });
    assert.equal(resubmitted.statusCode, 200, resubmitted.body);
    await migrateDatabase(database);
    await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/cancel` });
    assert.equal((await app.inject({ method: "GET", url: repair.media[0].url })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/repair/requests/${repair.id}` })).json<Json>().data.status, "open");
    // Source retention cleanup sets the provenance FK to NULL; the authorized copy is independent.
    await database.prepare("DELETE FROM booking_media WHERE booking_id = ?").run(booking.id);
    await migrateDatabase(database);
    const retained = await listRepairMaterials();
    assert.equal(retained.statusCode, 200, retained.body);
    assert.equal(retained.json<Json>().data.items.filter((item: Json) => item.businessId === repair.id && item.available).length, 2);
    for (const material of materials) {
      const content = await app.inject({ method: "GET", url: material.contentPath, headers });
      assert.equal(content.statusCode, 200, content.body);
      assert.deepEqual(content.rawPayload, copiedBytes.get(material.id));
    }
    const sources = await database.prepare<Json>("SELECT precheck_media_id FROM repair_request_media WHERE request_id = ?").all(repair.id);
    assert.ok(sources.every((item) => item.precheck_media_id === null));
  } finally { await close(); }
});

test("预检脏污衔接独立洗车订单并保留年检复核，禁止跨车关联", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const booking = (await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id })).json<Json>().data;
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: { provider: "mock", idempotencyKey: "precheck-wash-pay", quoteSnapshotId: booking.quoteSnapshotId } });
    const rejected = await app.inject({ method: "POST", url: `/api/operator/prechecks/${booking.id}/reject`, payload: { expectedVersion: paid.json<Json>().data.booking.precheck.version, idempotencyKey: "precheck-wash-reject", reasonCodes: ["body_dirty"], reasonText: "车身脏污无法核对，请清洁后重新拍摄", issuePhotoKinds: ["vehicle_front_left"] } });
    assert.equal(rejected.statusCode, 200, rejected.body);
    const store = (await app.inject({ method: "GET", url: "/api/wash/stores" })).json<Json>().data[0];
    const offer = (await app.inject({ method: "GET", url: `/api/wash/stores/${store.id}/offers?vehicleCategory=sedan` })).json<Json>().data[0];
    const slot = (await app.inject({ method: "GET", url: `/api/wash/stores/${store.id}/slots?date=2026-08-12&packageId=${offer.packageId}` })).json<Json>().data[0];
    const quote = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: { vehicleId: vehicle.id, storeId: store.id, packageId: offer.packageId, slotId: slot.id } });
    assert.equal(quote.statusCode, 201, quote.body);
    const order = await app.inject({ method: "POST", url: "/api/wash/orders", payload: { quoteSnapshotId: quote.json<Json>().data.id, idempotencyKey: "precheck-wash-create", contactName: "测试车主", contactPhone: "13800138000", precheckBookingId: booking.id } });
    assert.equal(order.statusCode, 201, order.body);
    const wrongOriginRetry = await app.inject({ method: "POST", url: "/api/wash/orders", payload: { quoteSnapshotId: quote.json<Json>().data.id, idempotencyKey: "precheck-wash-create", contactName: "测试车主", contactPhone: "13800138000" } });
    assert.equal(wrongOriginRetry.statusCode, 409, wrongOriginRetry.body);
    const otherVehicle = await createVehicle(app, "津A56789");
    const otherQuote = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: { vehicleId: otherVehicle.id, storeId: store.id, packageId: offer.packageId, slotId: slot.id } });
    assert.equal(otherQuote.statusCode, 201, otherQuote.body);
    const wrongVehicle = await app.inject({ method: "POST", url: "/api/wash/orders", payload: { quoteSnapshotId: otherQuote.json<Json>().data.id, idempotencyKey: "precheck-wash-other-car", contactName: "测试车主", contactPhone: "13800138000", precheckBookingId: booking.id } });
    assert.equal(wrongVehicle.statusCode, 409, wrongVehicle.body);
    assert.equal(wrongVehicle.json<Json>().error.code, "PRECHECK_WASH_NOT_APPLICABLE");
    const linked = (await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` })).json<Json>().data;
    assert.equal(linked.fulfillmentStatus, "precheck_action_required");
    assert.equal(linked.refundedFen, 0);
    assert.equal(linked.precheckServices.find((item: Json) => item.type === "wash").id, order.json<Json>().data.id);
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM repair_requests WHERE source_booking_id = ?").get(booking.id))!.count), 0);
    const failedConsent = await app.inject({ method: "POST", url: "/api/repair/precheck-requests", payload: { bookingId: booking.id, expectedVersion: linked.precheck.version, reasonCodes: ["body_damage"], consented: true } });
    assert.equal(failedConsent.statusCode, 400, failedConsent.body);
    await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/cancel` });
    const independent = (await app.inject({ method: "GET", url: `/api/wash/orders/${order.json<Json>().data.id}` })).json<Json>().data;
    assert.equal(independent.status, "pending_payment");
  } finally { await close(); }
});

test("车主取消与检测站预审决策并发时只形成一个终态和一笔退款", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const initialRemaining = slots[0].remaining;
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    const booking = created.json<Json>().data;
    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "precheck-cancel-race-payment-0001",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    const version = paid.json<Json>().data.booking.precheck.version;
    const [cancelled, rejected] = await Promise.all([
      app.inject({ method: "POST", url: `/api/bookings/${booking.id}/cancel` }),
      app.inject({
        method: "POST",
        url: `/api/operator/prechecks/${booking.id}/reject`,
        payload: {
          idempotencyKey: "precheck-cancel-race-reject-0001",
          expectedVersion: version,
          reasonCodes: ["materials_cannot_be_verified"],
          reasonText: "预约资料无法完成一致性核验，请重新预约",
          issuePhotoKinds: [],
        },
      }),
    ]);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.ok([200, 409].includes(rejected.statusCode), rejected.body);
    const finalBooking = (await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` })).json<Json>().data;
    assert.equal(finalBooking.fulfillmentStatus, "cancelled");
    assert.equal(finalBooking.paymentStatus, "refunded");
    const refundCount = Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM booking_ledger_entries WHERE booking_id = ? AND kind = 'refund'
    `).get(booking.id))?.count);
    assert.equal(refundCount, 1);
    const slot = (await app.inject({
      method: "GET",
      url: `/api/stations/${station.id}/slots?date=${slots[0].date}`,
    })).json<Json>().data.find((item: Json) => item.id === slots[0].id);
    assert.equal(slot.remaining, initialRemaining);
  } finally {
    await close();
  }
});

test("新版代驾任务以四组五图留证原子推进，并向车主和后台聚合可见", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 7_800, duration: 1_200 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const { vehicle, station, slots } = await seedContext(app);
    await database.prepare("UPDATE vehicles SET exterior_color = ? WHERE id = ?")
      .run("午夜蓝", vehicle.id);
    const pickupAddress = {
      poiId: "valet-handoff-pickup",
      title: "天津文化中心地下停车场",
      address: "天津市河西区平江道 58 号",
      district: "河西区",
      latitude: 39.0837,
      longitude: 117.2197,
      source: "tencent",
    };
    const quote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    const bookingMedia = await uploadAnnualBookingMedia(app, "valet");
    const created = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: slots[0].id,
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "valet",
        pickupAddress,
        quoteSnapshotId: quote.json<Json>().data.quoteSnapshotId,
        mediaIds: bookingMedia.map((item) => item.id),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookingId = booking.id;
    assert.equal(booking.vehicleSnapshot.exteriorColor, "午夜蓝");
    await database.prepare("UPDATE vehicles SET exterior_color = ? WHERE id = ?")
      .run("后改红", vehicle.id);
    assert.equal(created.json<Json>().data.evidencePolicyVersion, "valet-handoff-v1");
    assert.equal(created.json<Json>().data.media.length, 7);
    assert.deepEqual(
      created.json<Json>().data.evidencePackages.map((item: Json) => item.stage),
      ["owner_pickup", "station_arrival", "inspection_complete", "owner_return"],
    );
    assert.ok(created.json<Json>().data.evidencePackages.every((item: Json) => item.status === "pending"));

    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "valet-handoff-payment-0001",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    const approvedPrecheck = await approvePrecheck(app, bookingId);
    assert.equal(approvedPrecheck.fulfillmentStatus, "confirmed");

    const bypassDriverAssignment = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "driver_arranged" },
    });
    assert.equal(bypassDriverAssignment.statusCode, 409, bypassDriverAssignment.body);
    assert.equal(bypassDriverAssignment.json<Json>().error.code, "ADMIN_WORKFLOW_ADVANCE_FORBIDDEN");

    const firstAssignment = await app.inject({
      method: "POST",
      url: `/api/admin/bookings/${bookingId}/driver-assignment`,
      payload: { receptionistName: "站务小刘", receptionistPhone: "13800138000" },
    });
    assert.equal(firstAssignment.statusCode, 201, firstAssignment.body);
    assert.equal(firstAssignment.json<Json>().data.taskCode, null);
    assert.equal(firstAssignment.json<Json>().data.scene, null);
    assert.equal(firstAssignment.json<Json>().data.entryPath, null);
    const revokedTaskCode = "vt_historical_revoked_driver_task";
    const revokedVerificationCode = firstAssignment.json<Json>().data.assignment.verificationCode;
    assert.match(revokedVerificationCode, /^\d{6}$/u);
    assert.equal(firstAssignment.json<Json>().data.verificationCode, revokedVerificationCode);
    assert.equal(firstAssignment.json<Json>().data.assignment.receptionistName, "站务小刘");
    assert.equal(firstAssignment.json<Json>().data.assignment.receptionistPhone, "13800138000");
    assert.equal(firstAssignment.json<Json>().data.assignment.verificationCodeStatus, "active");
    assert.equal(firstAssignment.json<Json>().data.driverEntryPath, "/packages/driver/pages/login/login");
    await database.prepare(`
      UPDATE valet_driver_assignments SET task_code_hash = ?, task_code_expires_at = ?
      WHERE booking_id = ?
    `).run(createHash("sha256").update(revokedTaskCode).digest("hex"), "2099-01-01T00:00:00.000Z", bookingId);
    const storedDriverCode = await database.prepare<Json>(`
      SELECT verification_code_hmac, verification_code_ciphertext, verification_code_expires_at
      FROM valet_driver_assignments WHERE booking_id = ?
    `).get(bookingId);
    assert.ok(storedDriverCode?.verification_code_hmac);
    assert.ok(storedDriverCode?.verification_code_ciphertext);
    assert.notEqual(storedDriverCode?.verification_code_hmac, revokedVerificationCode);
    assert.equal(String(storedDriverCode?.verification_code_ciphertext).includes(revokedVerificationCode), false);
    const adminListBeforeBinding = await app.inject({ method: "GET", url: "/api/admin/bookings" });
    const listedAssignment = adminListBeforeBinding.json<Json>().data
      .find((item: Json) => item.id === bookingId).driverAssignment;
    assert.equal("verificationCode" in listedAssignment, false, "后台列表不能批量暴露验证码明文");
    const adminDetailBeforeBinding = await app.inject({ method: "GET", url: `/api/admin/bookings/${bookingId}` });
    assert.equal(adminDetailBeforeBinding.json<Json>().data.driverAssignment.verificationCode, revokedVerificationCode);
    await database.prepare(`
      UPDATE valet_driver_assignments SET verification_code_expires_at = ? WHERE booking_id = ?
    `).run("2000-01-01T00:00:00.000Z", bookingId);
    const ownerSession = await createDevelopmentSession(database, { userId: "demo-user" });
    const expiredUnboundCode = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { verificationCode: revokedVerificationCode },
    });
    assert.equal(expiredUnboundCode.statusCode, 404, expiredUnboundCode.body);
    const expiredAdminDetail = await app.inject({ method: "GET", url: `/api/admin/bookings/${bookingId}` });
    assert.equal(expiredAdminDetail.json<Json>().data.driverAssignment.verificationCode, revokedVerificationCode);
    assert.equal(expiredAdminDetail.json<Json>().data.driverAssignment.verificationCodeStatus, "expired");
    const revoked = await app.inject({ method: "DELETE", url: `/api/admin/bookings/${bookingId}/driver-assignment` });
    assert.equal(revoked.statusCode, 200, revoked.body);
    const revokedExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { taskCode: revokedTaskCode },
    });
    assert.equal(revokedExchange.statusCode, 404, revokedExchange.body);
    const revokedVerificationExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { verificationCode: revokedVerificationCode },
    });
    assert.equal(revokedVerificationExchange.statusCode, 404, revokedVerificationExchange.body);

    const assignment = await app.inject({
      method: "POST",
      url: `/api/admin/bookings/${bookingId}/driver-assignment`,
      payload: { receptionistName: "站务小刘", receptionistPhone: "13800138000" },
    });
    assert.equal(assignment.statusCode, 201, assignment.body);
    assert.equal(assignment.json<Json>().data.taskCode, null);
    assert.equal(assignment.json<Json>().data.assignment.receptionistName, "站务小刘");
    assert.equal(assignment.json<Json>().data.assignment.receptionistPhone, "13800138000");
    const taskCode = "vt_historical_bound_driver_task";
    const verificationCode = assignment.json<Json>().data.assignment.verificationCode;
    assert.match(verificationCode, /^\d{6}$/u);
    await database.prepare(`
      UPDATE valet_driver_assignments SET task_code_hash = ?, task_code_expires_at = ?
      WHERE booking_id = ?
    `).run(createHash("sha256").update(taskCode).digest("hex"), "2099-01-01T00:00:00.000Z", bookingId);
    const missingPhone = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { verificationCode },
    });
    assert.equal(missingPhone.statusCode, 400, missingPhone.body);
    assert.equal(missingPhone.json<Json>().error.code, "DRIVER_PHONE_REQUIRED");
    const exchanged = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { verificationCode, driverPhone: "13900139001" },
    });
    assert.equal(exchanged.statusCode, 201, exchanged.body);
    const driverToken = exchanged.json<Json>().data.token;
    assert.match(driverToken, /^yxm_drv_/u);
    const driverTag = await database.prepare<Json>(`
      SELECT tag FROM customer_admin_tags WHERE user_id = ? AND tag = ?
    `).get("demo-user", "代驾");
    assert.equal(driverTag?.tag, "代驾");
    const pickupBinding = await database.prepare<Json>(`
      SELECT pickup_bound_user_id, pickup_driver_phone, pickup_bound_at
      FROM valet_driver_assignments WHERE booking_id = ?
    `).get(bookingId);
    assert.equal(pickupBinding?.pickup_bound_user_id, "demo-user");
    assert.equal(pickupBinding?.pickup_driver_phone, "13900139001");
    assert.ok(pickupBinding?.pickup_bound_at);
    const workflowAfterExchange = await database.prepare<Json>(`
      SELECT
        COUNT(*) FILTER (WHERE node_code = 'annual.driver.claim' AND status = 'open') AS open_claims,
        COUNT(*) FILTER (WHERE node_code = 'annual.pickup.driver' AND status = 'open') AS open_pickups,
        COUNT(*) FILTER (WHERE node_code = 'annual.pickup.driver') AS pickup_count
      FROM workflow_tasks WHERE entity_id = ?
    `).get(bookingId);
    assert.equal(Number(workflowAfterExchange?.open_claims), 0);
    assert.equal(Number(workflowAfterExchange?.open_pickups), 1);
    assert.equal(Number(workflowAfterExchange?.pickup_count), 1);
    const pickupWorkflowTask = await database.prepare<Json>(`
      SELECT subject_type, subject_id, recipient_user_id, due_at, template_bindings_snapshot_json
      FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'annual.pickup.driver' AND status = 'open'
    `).get(bookingId);
    assert.equal(pickupWorkflowTask?.subject_type, "driver_assignment");
    assert.equal(pickupWorkflowTask?.subject_id, exchanged.json<Json>().data.taskId);
    assert.equal(pickupWorkflowTask?.recipient_user_id, "demo-user");
    assert.ok(pickupWorkflowTask?.due_at);
    assert.match(String(pickupWorkflowTask?.template_bindings_snapshot_json), /annual\.pickup\.evidence\.driver/u);
    assert.doesNotMatch(String(pickupWorkflowTask?.template_bindings_snapshot_json), /verificationCode/u);
    const driverWorkflowSummary = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}/workflow/summary`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(driverWorkflowSummary.statusCode, 200, driverWorkflowSummary.body);
    assert.equal(driverWorkflowSummary.json<Json>().data.pending, 1);
    assert.ok(driverWorkflowSummary.json<Json>().data.nextDueAt);
    const ownerCannotReadDriverWorkflow = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}/workflow/summary`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.notEqual(ownerCannotReadDriverWorkflow.statusCode, 200, ownerCannotReadDriverWorkflow.body);
    const consumedCredential = await database.prepare<Json>(`
      SELECT status, bound_user_id, task_code_hash, task_code_expires_at,
        verification_code_hmac, verification_code_ciphertext, verification_code_expires_at
      FROM valet_driver_assignments WHERE booking_id = ?
    `).get(bookingId);
    assert.equal(consumedCredential?.status, "bound");
    assert.equal(consumedCredential?.bound_user_id, "demo-user");
    assert.equal(consumedCredential?.task_code_hash, null);
    assert.equal(consumedCredential?.task_code_expires_at, null);
    assert.equal(consumedCredential?.verification_code_hmac, null);
    assert.equal(consumedCredential?.verification_code_ciphertext, null);
    assert.equal(consumedCredential?.verification_code_expires_at, null);

    const repeatedVerificationExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { verificationCode },
    });
    assert.equal(repeatedVerificationExchange.statusCode, 404, repeatedVerificationExchange.body);
    assert.equal(repeatedVerificationExchange.json<Json>().error.code, "DRIVER_TASK_CODE_INVALID");
    const repeatedLegacyTaskCodeExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { taskCode },
    });
    assert.equal(repeatedLegacyTaskCodeExchange.statusCode, 404, repeatedLegacyTaskCodeExchange.body);
    assert.equal(repeatedLegacyTaskCodeExchange.json<Json>().error.code, "DRIVER_TASK_CODE_INVALID");
    const boundAdminDetail = await app.inject({ method: "GET", url: `/api/admin/bookings/${bookingId}` });
    assert.equal(boundAdminDetail.json<Json>().data.driverAssignment.verificationCode, null);
    assert.equal(boundAdminDetail.json<Json>().data.driverAssignment.verificationCodeStatus, "unavailable");
    assert.equal(boundAdminDetail.json<Json>().data.driverAssignment.pickupDriverPhone, "13900139001");
    assert.equal(boundAdminDetail.json<Json>().data.driverAssignment.returnDriverPhone, null);
    assert.equal(boundAdminDetail.json<Json>().data.driverAssignment.handoffCodePending, false);
    const boundOwnerDetail = await app.inject({
      method: "GET",
      url: `/api/bookings/${bookingId}`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.equal(boundOwnerDetail.statusCode, 200, boundOwnerDetail.body);
    assert.equal(boundOwnerDetail.json<Json>().data.driverAssignment.pickupDriverPhone, "139****9001");
    assert.equal(boundOwnerDetail.json<Json>().data.driverAssignment.returnDriverPhone, null);
    assert.equal(boundOwnerDetail.json<Json>().data.driverAssignment.verificationCodeStatus, "unavailable");
    assert.equal(boundOwnerDetail.json<Json>().data.driverAssignment.handoffCodePending, false);
    assert.equal("verificationCode" in boundOwnerDetail.json<Json>().data.driverAssignment, false);
    const boundDriverTask = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(boundDriverTask.statusCode, 200, boundDriverTask.body);
    assert.equal(boundDriverTask.json<Json>().data.driverAssignment.receptionistName, "站务小刘");
    assert.equal(boundDriverTask.json<Json>().data.driverAssignment.receptionistPhone, "13800138000");
    assert.equal(boundDriverTask.json<Json>().data.driverAssignment.pickupDriverPhone, "13900139001");
    const otherOwner = await createDevelopmentSession(database, { userId: "valet-forwarded-link-owner" });
    const forwarded = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${otherOwner.token}` },
      payload: { verificationCode },
    });
    assert.equal(forwarded.statusCode, 404, forwarded.body);
    const issuedSessionStillWorks = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(issuedSessionStillWorks.statusCode, 200, issuedSessionStillWorks.body);
    assert.equal(issuedSessionStillWorks.json<Json>().data.vehicle.exteriorColor, "午夜蓝");

    const bypassPickup = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "picked_up" },
    });
    assert.equal(bypassPickup.statusCode, 409, bypassPickup.body);
    assert.equal(bypassPickup.json<Json>().error.code, "ADMIN_WORKFLOW_ADVANCE_FORBIDDEN");

    const pickupMediaUrl = `/api/driver/tasks/${bookingId}/evidence/owner_pickup/media`;
    const firstPickupPhoto = await requestValetEvidenceMedia(app, pickupMediaUrl, "front_left", { token: driverToken });
    assert.equal(firstPickupPhoto.statusCode, 201, firstPickupPhoto.body);
    const originalPickupMediaId = firstPickupPhoto.json<Json>().data.id;
    const incompletePickup = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_pickup/complete`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "pickup-complete-0001" },
    });
    assert.equal(incompletePickup.statusCode, 409, incompletePickup.body);
    assert.equal(incompletePickup.json<Json>().error.code, "VALET_EVIDENCE_INCOMPLETE");

    const pendingOwnerView = await app.inject({
      method: "GET",
      url: `/api/bookings/${bookingId}`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.equal(pendingOwnerView.statusCode, 200, pendingOwnerView.body);
    assert.deepEqual(
      pendingOwnerView.json<Json>().data.evidencePackages.find((item: Json) => item.stage === "owner_pickup").photos,
      [],
    );

    const replacement = await requestValetEvidenceMedia(app, pickupMediaUrl, "front_left", {
      token: driverToken,
      image: alternateTestPng,
    });
    assert.equal(replacement.statusCode, 201, replacement.body);
    assert.notEqual(replacement.json<Json>().data.id, originalPickupMediaId);
    const replacedGone = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_pickup/media/${originalPickupMediaId}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(replacedGone.statusCode, 404, replacedGone.body);
    for (const kind of ["front_right", "rear_left", "rear_right", "dashboard_started"]) {
      const uploaded = await requestValetEvidenceMedia(app, pickupMediaUrl, kind, { token: driverToken });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
    }
    const pickupComplete = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_pickup/complete`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "pickup-complete-0001" },
    });
    assert.equal(pickupComplete.statusCode, 200, pickupComplete.body);
    assert.equal(pickupComplete.json<Json>().data.status, "picked_up");
    const workflowAfterPickup = await database.prepare<Json>(`
      SELECT
        COUNT(*) FILTER (WHERE node_code = 'annual.pickup.driver' AND status = 'open') AS open_pickups,
        COUNT(*) FILTER (WHERE node_code = 'annual.station.arrival' AND status = 'open') AS open_arrivals,
        COUNT(*) FILTER (WHERE node_code = 'annual.station.arrival') AS arrival_count
      FROM workflow_tasks WHERE entity_id = ?
    `).get(bookingId);
    assert.equal(Number(workflowAfterPickup?.open_pickups), 0);
    assert.equal(Number(workflowAfterPickup?.open_arrivals), 1);
    assert.equal(Number(workflowAfterPickup?.arrival_count), 1);
    const lateValetCancellation = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "cancelled" },
    });
    assert.equal(lateValetCancellation.statusCode, 409, lateValetCancellation.body);
    assert.equal(lateValetCancellation.json<Json>().error.code, "BOOKING_IN_PROGRESS");
    assert.equal(
      String((await database.prepare<Json>("SELECT status FROM valet_driver_assignments WHERE booking_id = ?")
        .get(bookingId))?.status),
      "in_progress",
    );
    const reopenedInProgress = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { taskCode },
    });
    assert.equal(reopenedInProgress.statusCode, 404, reopenedInProgress.body);
    assert.equal(reopenedInProgress.json<Json>().error.code, "DRIVER_TASK_CODE_INVALID");
    assert.equal(
      String((await database.prepare<Json>("SELECT status FROM valet_driver_assignments WHERE booking_id = ?")
        .get(bookingId))?.status),
      "in_progress",
      "重复兑换不能把执行中的司机任务倒退为 bound",
    );
    const pickupRetry = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_pickup/complete`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "pickup-complete-0001" },
    });
    assert.equal(pickupRetry.statusCode, 200, pickupRetry.body);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM workflow_tasks
      WHERE entity_id = ? AND node_code = 'annual.station.arrival'
    `).get(bookingId))?.count), 1, "重复提交不能重复创建到站督办任务");
    const pickupConflict = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_pickup/complete`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "pickup-complete-other" },
    });
    assert.equal(pickupConflict.statusCode, 409, pickupConflict.body);

    const legacyCheckIn = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/check-in`,
      payload: { plateMatched: true, materialsReady: true, exteriorRecorded: true, vehicleConditionConfirmed: true },
    });
    assert.equal(legacyCheckIn.statusCode, 409, legacyCheckIn.body);
    assert.equal(legacyCheckIn.json<Json>().error.code, "VALET_STATION_ARRIVAL_EVIDENCE_REQUIRED");
    const bypassArrival = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "checked_in" },
    });
    assert.equal(bypassArrival.statusCode, 409, bypassArrival.body);
    assert.equal(bypassArrival.json<Json>().error.code, "ADMIN_WORKFLOW_ADVANCE_FORBIDDEN");
    const heldBeforeArrival = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "on_hold" },
    });
    assert.equal(heldBeforeArrival.statusCode, 200, heldBeforeArrival.body);
    const holdEvent = [...heldBeforeArrival.json<Json>().data.events]
      .reverse()
      .find((event: Json) => event.status === "on_hold");
    assert.deepEqual(
      {
        previousStatus: holdEvent.metadata.previousStatus,
        previousFulfillmentStatus: holdEvent.metadata.previousFulfillmentStatus,
        serviceMode: holdEvent.metadata.serviceMode,
      },
      { previousStatus: "awaiting_arrival", previousFulfillmentStatus: "picked_up", serviceMode: "valet" },
    );
    const bypassArrivalViaHold = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "inspecting" },
    });
    assert.equal(bypassArrivalViaHold.statusCode, 409, bypassArrivalViaHold.body);
    assert.equal(bypassArrivalViaHold.json<Json>().error.code, "BOOKING_HOLD_RESTORE_MISMATCH");
    const resumedPickup = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "picked_up" },
    });
    assert.equal(resumedPickup.statusCode, 200, resumedPickup.body);
    assert.equal(resumedPickup.json<Json>().data.status, "awaiting_arrival");
    assert.equal(resumedPickup.json<Json>().data.fulfillmentStatus, "picked_up");

    const arrivalMediaUrl = `/api/operator/bookings/${bookingId}/evidence/station_arrival/media`;
    for (const kind of ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"]) {
      const uploaded = await requestValetEvidenceMedia(app, arrivalMediaUrl, kind);
      assert.equal(uploaded.statusCode, 201, uploaded.body);
    }
    const arrivalComplete = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/evidence/station_arrival/complete`,
      payload: {
        idempotencyKey: "arrival-complete-0001",
        verification: {
          plateMatched: true,
          materialsReady: true,
          exteriorRecorded: true,
          vehicleConditionConfirmed: true,
        },
      },
    });
    assert.equal(arrivalComplete.statusCode, 200, arrivalComplete.body);
    assert.equal(arrivalComplete.json<Json>().data.fulfillmentStatus, "checked_in");
    const handoff = await app.inject({ method: "POST", url: `/api/operator/bookings/${bookingId}/handoff` });
    assert.equal(handoff.statusCode, 200, handoff.body);
    assert.equal(handoff.json<Json>().data.fulfillmentStatus, "inspecting");

    await prepareCheckupReport(app, bookingId);
    const result = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      headers: { "idempotency-key": "valet-result-publish-0001" },
      payload: { conclusion: "passed", summary: { conclusionLabel: "检验合格" } },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json<Json>().data.fulfillmentStatus, "result_received");
    const inspectionPackage = result.json<Json>().data.evidencePackages.find(
      (item: Json) => item.stage === "inspection_complete",
    );
    assert.equal(inspectionPackage.status, "completed");
    assert.equal(inspectionPackage.photos.length, 5);
    const storedInspectionEvidence = await database.prepare<Json>(`
      SELECT p.source_type, p.source_report_id, COUNT(m.id) AS copied_media_count
      FROM valet_evidence_packages p
      LEFT JOIN valet_evidence_media m ON m.package_id = p.id
      WHERE p.booking_id = ? AND p.stage = 'inspection_complete'
      GROUP BY p.id
    `).get(bookingId);
    assert.equal(storedInspectionEvidence?.source_type, "checkup_report");
    assert.ok(storedInspectionEvidence?.source_report_id);
    assert.equal(Number(storedInspectionEvidence?.copied_media_count), 0);

    const operatorCannotComplete = await app.inject({ method: "POST", url: `/api/operator/bookings/${bookingId}/complete` });
    assert.equal(operatorCannotComplete.statusCode, 409, operatorCannotComplete.body);
    assert.equal(operatorCannotComplete.json<Json>().error.code, "VALET_DRIVER_RETURN_REQUIRED");
    const bypassReturn = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "returning" },
    });
    assert.equal(bypassReturn.statusCode, 409, bypassReturn.body);
    assert.equal(bypassReturn.json<Json>().error.code, "ADMIN_WORKFLOW_ADVANCE_FORBIDDEN");

    const startReturn = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/start-return`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "start-return-0001" },
    });
    assert.equal(startReturn.statusCode, 200, startReturn.body);
    assert.equal(startReturn.json<Json>().data.status, "returning");
    const returnRetry = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/start-return`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "start-return-0001" },
    });
    assert.equal(returnRetry.statusCode, 200, returnRetry.body);

    const bypassCompletion = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "completed" },
    });
    assert.equal(bypassCompletion.statusCode, 409, bypassCompletion.body);
    assert.equal(bypassCompletion.json<Json>().error.code, "ADMIN_WORKFLOW_ADVANCE_FORBIDDEN");
    const operatorReturnUpload = await requestValetEvidenceMedia(
      app,
      `/api/operator/bookings/${bookingId}/evidence/owner_return/media`,
      "front_left",
    );
    assert.equal(operatorReturnUpload.statusCode, 404, operatorReturnUpload.body);

    const ownerReturnMediaUrl = `/api/driver/tasks/${bookingId}/evidence/owner_return/media`;
    for (const kind of ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"]) {
      const uploaded = await requestValetEvidenceMedia(app, ownerReturnMediaUrl, kind, { token: driverToken });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
    }
    const pendingSurchargeResponse = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: {
        adjustment: {
          amountFen: 900,
          reason: "返程停车附加费",
          idempotencyKey: "valet-return-surcharge-0001",
        },
      },
    });
    assert.equal(pendingSurchargeResponse.statusCode, 200, pendingSurchargeResponse.body);
    const pendingSurcharge = pendingSurchargeResponse.json<Json>().data.ledgerEntries
      .find((entry: Json) => entry.idempotencyKey === "valet-return-surcharge-0001");

    const pendingFinancialReturn = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_return/complete`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "owner-return-complete-0001" },
    });
    assert.equal(pendingFinancialReturn.statusCode, 409, pendingFinancialReturn.body);
    assert.equal(pendingFinancialReturn.json<Json>().error.code, "PENDING_SURCHARGE_CONFIRMATION");
    assert.equal(
      (await app.inject({
        method: "GET",
        url: `/api/driver/tasks/${bookingId}`,
        headers: { authorization: `Bearer ${driverToken}` },
      })).json<Json>().data.evidencePackages.find((item: Json) => item.stage === "owner_return").status,
      "pending",
    );

    const confirmedSurcharge = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/ledger/${pendingSurcharge.id}/confirm`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { idempotencyKey: "valet-return-surcharge-confirm-0001" },
    });
    assert.equal(confirmedSurcharge.statusCode, 200, confirmedSurcharge.body);
    assert.equal(confirmedSurcharge.json<Json>().data.booking.amountDueFen, 900);

    const unpaidFinancialReturn = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_return/complete`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "owner-return-complete-0001" },
    });
    assert.equal(unpaidFinancialReturn.statusCode, 409, unpaidFinancialReturn.body);
    assert.equal(unpaidFinancialReturn.json<Json>().error.code, "OUTSTANDING_PAYMENT");

    const supplementalPayment = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/payments`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { provider: "mock", idempotencyKey: "valet-return-surcharge-payment-0001" },
    });
    assert.equal(supplementalPayment.statusCode, 201, supplementalPayment.body);
    assert.equal(supplementalPayment.json<Json>().data.payment.amountFen, 900);

    const returned = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_return/complete`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { idempotencyKey: "owner-return-complete-0001" },
    });
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(returned.json<Json>().data.status, "completed");
    assert.equal(
      String((await database.prepare<Json>("SELECT status FROM valet_driver_assignments WHERE booking_id = ?")
        .get(bookingId))?.status),
      "completed",
    );
    const reopenedCompleted = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { taskCode },
    });
    assert.equal(reopenedCompleted.statusCode, 404, reopenedCompleted.body);
    const completedVerificationCode = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { verificationCode },
    });
    assert.equal(completedVerificationCode.statusCode, 404, completedVerificationCode.body);
    const completedCodeRow = await database.prepare<Json>(`
      SELECT task_code_hash, task_code_expires_at, task_code_consumed_at,
        verification_code_hmac, verification_code_ciphertext, verification_code_expires_at
      FROM valet_driver_assignments WHERE booking_id = ?
    `).get(bookingId);
    assert.equal(completedCodeRow?.task_code_hash, null);
    assert.equal(completedCodeRow?.task_code_expires_at, null);
    assert.equal(completedCodeRow?.task_code_consumed_at, null);
    assert.equal(completedCodeRow?.verification_code_hmac, null);
    assert.equal(completedCodeRow?.verification_code_ciphertext, null);
    assert.equal(completedCodeRow?.verification_code_expires_at, null);
    const completedSessionCount = await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM valet_driver_sessions
      WHERE assignment_id = (SELECT id FROM valet_driver_assignments WHERE booking_id = ?)
        AND revoked_at IS NULL
    `).get(bookingId);
    assert.equal(Number(completedSessionCount?.count), 0);
    assert.equal(
      String((await database.prepare<Json>("SELECT status FROM valet_driver_assignments WHERE booking_id = ?")
        .get(bookingId))?.status),
      "completed",
      "已完成任务不能再通过历史深链续领会话",
    );
    const completedCachedSession = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(completedCachedSession.statusCode, 404, completedCachedSession.body);

    const ownerDetail = await app.inject({
      method: "GET",
      url: `/api/bookings/${bookingId}`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.equal(ownerDetail.statusCode, 200, ownerDetail.body);
    const ownerData = ownerDetail.json<Json>().data;
    assert.equal(ownerData.driverAssignment.receptionistName, "站师傅");
    assert.equal(ownerData.driverAssignment.receptionistPhone, "138****8000");
    assert.equal("verificationCode" in ownerData.driverAssignment, false);
    assert.ok(ownerData.evidencePackages.every((item: Json) => item.status === "completed" && item.photos.length === 5));
    assert.ok(ownerData.events.some((event: Json) => event.actorType === "driver"));
    const pickupPackage = ownerData.evidencePackages.find((item: Json) => item.stage === "owner_pickup");
    assert.equal(pickupPackage.capturedByLabel, "站师傅");
    const ownerMedia = await app.inject({
      method: "GET",
      url: pickupPackage.photos[0].url,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.equal(ownerMedia.statusCode, 200, ownerMedia.body);
    assert.equal(ownerMedia.headers["cache-control"], "private, max-age=3600");

    const adminDetail = await app.inject({ method: "GET", url: `/api/admin/bookings/${bookingId}` });
    assert.equal(adminDetail.statusCode, 200, adminDetail.body);
    assert.equal(adminDetail.json<Json>().data.driverAssignment.receptionistName, "站务小刘");
    assert.equal(adminDetail.json<Json>().data.driverAssignment.receptionistPhone, "13800138000");
    assert.equal(adminDetail.json<Json>().data.driverAssignment.verificationCode, null);
    assert.equal(adminDetail.json<Json>().data.driverAssignment.verificationCodeStatus, "completed");
    assert.ok(adminDetail.json<Json>().data.evidencePackages.every((item: Json) => item.photos.length === 5));
    const crossTask = await app.inject({
      method: "GET",
      url: "/api/driver/tasks/not-this-booking",
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(crossTask.statusCode, 404, crossTask.body);

    await database.prepare(`
      UPDATE bookings SET status = 'no_show', fulfillment_status = 'no_show' WHERE id = ?
    `).run(bookingId);
    const noShowExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { taskCode },
    });
    assert.equal(noShowExchange.statusCode, 404, noShowExchange.body);
    const noShowSessionRead = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(noShowSessionRead.statusCode, 404, noShowSessionRead.body);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("新版代驾预约取消会原子撤销任务码与已签发司机会话", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 7_800, duration: 1_200 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { vehicle, station, slots } = await seedContext(app);
    const pickupAddress = {
      poiId: "valet-session-cancel-pickup",
      title: "天津文化中心地下停车场",
      address: "天津市河西区平江道 58 号",
      district: "河西区",
      latitude: 39.0837,
      longitude: 117.2197,
      source: "tencent",
    };
    const quote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    const bookingMedia = await uploadAnnualBookingMedia(app, "valet");
    const created = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: slots[0].id,
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "valet",
        pickupAddress,
        quoteSnapshotId: quote.json<Json>().data.quoteSnapshotId,
        mediaIds: bookingMedia.map((item) => item.id),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookingId = booking.id;
    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "valet-session-cancel-payment",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    const approved = await approvePrecheck(app, bookingId);
    assert.equal(approved.fulfillmentStatus, "confirmed");
    const assignment = await app.inject({
      method: "POST",
      url: `/api/admin/bookings/${bookingId}/driver-assignment`,
      payload: { receptionistName: "站务小刘", receptionistPhone: "13800138000" },
    });
    assert.equal(assignment.statusCode, 201, assignment.body);
    assert.equal(assignment.json<Json>().data.taskCode, null);
    const taskCode = "vt_historical_cancelled_task";
    const verificationCode = assignment.json<Json>().data.assignment.verificationCode;
    await database.prepare(`
      UPDATE valet_driver_assignments SET task_code_hash = ?, task_code_expires_at = ?
      WHERE booking_id = ?
    `).run(createHash("sha256").update(taskCode).digest("hex"), "2099-01-01T00:00:00.000Z", bookingId);
    const ownerSession = await createDevelopmentSession(database, { userId: "demo-user" });
    const exchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { taskCode, driverPhone: "13900139002" },
    });
    assert.equal(exchange.statusCode, 201, exchange.body);
    const driverToken = exchange.json<Json>().data.token;

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/cancel`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json<Json>().data.fulfillmentStatus, "cancelled");

    const assignmentRow = await database.prepare<Json>(`
      SELECT status, task_code_hash, task_code_expires_at, verification_code_hmac,
        verification_code_ciphertext, verification_code_expires_at
      FROM valet_driver_assignments WHERE booking_id = ?
    `).get(bookingId);
    assert.equal(assignmentRow?.status, "cancelled");
    assert.equal(assignmentRow?.task_code_hash, null);
    assert.equal(assignmentRow?.task_code_expires_at, null);
    assert.equal(assignmentRow?.verification_code_hmac, null);
    assert.equal(assignmentRow?.verification_code_ciphertext, null);
    assert.equal(assignmentRow?.verification_code_expires_at, null);
    const sessionRow = await database.prepare<Json>(`
      SELECT revoked_at FROM valet_driver_sessions WHERE assignment_id = (
        SELECT id FROM valet_driver_assignments WHERE booking_id = ?
      ) ORDER BY created_at DESC LIMIT 1
    `).get(bookingId);
    assert.ok(sessionRow?.revoked_at);

    const cancelledExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { taskCode },
    });
    assert.equal(cancelledExchange.statusCode, 404, cancelledExchange.body);
    const cancelledVerificationExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${ownerSession.token}` },
      payload: { verificationCode },
    });
    assert.equal(cancelledVerificationExchange.statusCode, 404, cancelledVerificationExchange.body);
    const cancelledSessionRead = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });
    assert.equal(cancelledSessionRead.statusCode, 404, cancelledSessionRead.body);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("代驾换班码兑换会绑定送车司机、打标并吊销旧会话", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 7_800, duration: 1_200 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const { vehicle, station, slots } = await seedContext(app);
    const pickupAddress = {
      poiId: "valet-handoff-exchange-pickup",
      title: "天津文化中心地下停车场",
      address: "天津市河西区平江道 58 号",
      district: "河西区",
      latitude: 39.0837,
      longitude: 117.2197,
      source: "tencent",
    };
    const quote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    const bookingMedia = await uploadAnnualBookingMedia(app, "valet");
    const created = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: slots[0].id,
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "valet",
        pickupAddress,
        quoteSnapshotId: quote.json<Json>().data.quoteSnapshotId,
        mediaIds: bookingMedia.map((item) => item.id),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookingId = booking.id;
    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "valet-handoff-exchange-payment",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    const approved = await approvePrecheck(app, bookingId);
    assert.equal(approved.fulfillmentStatus, "confirmed");
    const assignment = await app.inject({
      method: "POST",
      url: `/api/admin/bookings/${bookingId}/driver-assignment`,
      payload: { receptionistName: "站务小刘", receptionistPhone: "13800138000" },
    });
    assert.equal(assignment.statusCode, 201, assignment.body);
    const verificationCode = assignment.json<Json>().data.assignment.verificationCode;
    const pickupDriver = await createDevelopmentSession(database, { userId: "valet-pickup-driver" });
    const pickupExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${pickupDriver.token}` },
      payload: { verificationCode, driverPhone: "13900139111" },
    });
    assert.equal(pickupExchange.statusCode, 201, pickupExchange.body);
    const pickupToken = pickupExchange.json<Json>().data.token;

    const handoffCode = "654321";
    const handoffHmac = createHmac("sha256", "yuxiaoman-valet-driver-code-demo-hmac-key-v1")
      .update(`verification-code:v1:${handoffCode}`)
      .digest("hex");
    await database.prepare(`
      UPDATE valet_driver_assignments SET
        handoff_verification_code_hmac = ?,
        handoff_verification_code_ciphertext = ?,
        handoff_verification_code_expires_at = ?,
        handoff_verification_code_created_at = ?
      WHERE booking_id = ?
    `).run(handoffHmac, "test-ciphertext", "2099-01-01T00:00:00.000Z", new Date().toISOString(), bookingId);

    const returnDriver = await createDevelopmentSession(database, { userId: "valet-return-driver" });
    const missingPhone = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${returnDriver.token}` },
      payload: { verificationCode: handoffCode },
    });
    assert.equal(missingPhone.statusCode, 400, missingPhone.body);
    assert.equal(missingPhone.json<Json>().error.code, "DRIVER_PHONE_REQUIRED");

    const handoffExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${returnDriver.token}` },
      payload: { verificationCode: handoffCode, driverPhone: "13900139222" },
    });
    assert.equal(handoffExchange.statusCode, 201, handoffExchange.body);
    const returnToken = handoffExchange.json<Json>().data.token;

    const returnBinding = await database.prepare<Json>(`
      SELECT bound_user_id, return_bound_user_id, return_driver_phone,
        handoff_verification_code_hmac, pickup_bound_user_id
      FROM valet_driver_assignments WHERE booking_id = ?
    `).get(bookingId);
    assert.equal(returnBinding?.pickup_bound_user_id, "valet-pickup-driver");
    assert.equal(returnBinding?.return_bound_user_id, "valet-return-driver");
    assert.equal(returnBinding?.return_driver_phone, "13900139222");
    assert.equal(returnBinding?.bound_user_id, "valet-return-driver");
    assert.equal(returnBinding?.handoff_verification_code_hmac, null);

    const returnTag = await database.prepare<Json>(`
      SELECT tag FROM customer_admin_tags WHERE user_id = ? AND tag = ?
    `).get("valet-return-driver", "代驾");
    assert.equal(returnTag?.tag, "代驾");

    const oldSessionRead = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}`,
      headers: { authorization: `Bearer ${pickupToken}` },
    });
    assert.equal(oldSessionRead.statusCode, 404, oldSessionRead.body);
    const newSessionRead = await app.inject({
      method: "GET",
      url: `/api/driver/tasks/${bookingId}`,
      headers: { authorization: `Bearer ${returnToken}` },
    });
    assert.equal(newSessionRead.statusCode, 200, newSessionRead.body);
    assert.equal(newSessionRead.json<Json>().data.driverAssignment.returnDriverPhone, "13900139222");
    assert.equal(newSessionRead.json<Json>().data.driverAssignment.handoffCodePending, false);

    const ownerSession = await createDevelopmentSession(database, { userId: "demo-user" });
    const ownerDetail = await app.inject({
      method: "GET",
      url: `/api/bookings/${bookingId}`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.equal(ownerDetail.statusCode, 200, ownerDetail.body);
    assert.equal(ownerDetail.json<Json>().data.driverAssignment.pickupDriverPhone, "139****9111");
    assert.equal(ownerDetail.json<Json>().data.driverAssignment.returnDriverPhone, "139****9222");
    assert.equal(ownerDetail.json<Json>().data.driverAssignment.handoffCodePending, false);

    const operatorDetail = await app.inject({ method: "GET", url: `/api/operator/bookings/${bookingId}` });
    assert.equal(operatorDetail.statusCode, 200, operatorDetail.body);
    assert.equal(operatorDetail.json<Json>().data.driverAssignment.pickupDriverPhone, "13900139111");
    assert.equal(operatorDetail.json<Json>().data.driverAssignment.returnDriverPhone, "13900139222");
    assert.equal(operatorDetail.json<Json>().data.driverAssignment.receptionistPhone, "13800138000");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("取车代驾送达站后可生成换班码，重发会使旧码失效", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 7_800, duration: 1_200 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const { vehicle, station, slots } = await seedContext(app);
    const pickupAddress = {
      poiId: "valet-handoff-mint-pickup",
      title: "天津文化中心地下停车场",
      address: "天津市河西区平江道 58 号",
      district: "河西区",
      latitude: 39.0837,
      longitude: 117.2197,
      source: "tencent",
    };
    const quote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    const bookingMedia = await uploadAnnualBookingMedia(app, "valet");
    const created = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: slots[0].id,
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "valet",
        pickupAddress,
        quoteSnapshotId: quote.json<Json>().data.quoteSnapshotId,
        mediaIds: bookingMedia.map((item) => item.id),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookingId = booking.id;
    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "valet-handoff-mint-payment",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    const approved = await approvePrecheck(app, bookingId);
    assert.equal(approved.fulfillmentStatus, "confirmed");
    const assignment = await app.inject({
      method: "POST",
      url: `/api/admin/bookings/${bookingId}/driver-assignment`,
      payload: { receptionistName: "站务小刘", receptionistPhone: "13800138000" },
    });
    assert.equal(assignment.statusCode, 201, assignment.body);
    const verificationCode = assignment.json<Json>().data.assignment.verificationCode;
    const pickupDriver = await createDevelopmentSession(database, { userId: "valet-handoff-mint-driver" });
    const pickupExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${pickupDriver.token}` },
      payload: { verificationCode, driverPhone: "13900139111" },
    });
    assert.equal(pickupExchange.statusCode, 201, pickupExchange.body);
    const pickupToken = pickupExchange.json<Json>().data.token;

    const beforeArrival = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/handoff-code`,
      headers: { authorization: `Bearer ${pickupToken}` },
    });
    assert.equal(beforeArrival.statusCode, 409, beforeArrival.body);
    assert.equal(beforeArrival.json<Json>().error.code, "HANDOFF_CODE_NOT_ALLOWED");

    const pickupMediaUrl = `/api/driver/tasks/${bookingId}/evidence/owner_pickup/media`;
    for (const kind of ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"]) {
      const uploaded = await requestValetEvidenceMedia(app, pickupMediaUrl, kind, { token: pickupToken });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
    }
    const pickupComplete = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/evidence/owner_pickup/complete`,
      headers: { authorization: `Bearer ${pickupToken}` },
      payload: { idempotencyKey: "handoff-mint-pickup-complete" },
    });
    assert.equal(pickupComplete.statusCode, 200, pickupComplete.body);
    assert.equal(pickupComplete.json<Json>().data.status, "picked_up");

    const whilePickedUp = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/handoff-code`,
      headers: { authorization: `Bearer ${pickupToken}` },
    });
    assert.equal(whilePickedUp.statusCode, 409, whilePickedUp.body);
    assert.equal(whilePickedUp.json<Json>().error.code, "HANDOFF_CODE_NOT_ALLOWED");

    const arrivalMediaUrl = `/api/operator/bookings/${bookingId}/evidence/station_arrival/media`;
    for (const kind of ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"]) {
      const uploaded = await requestValetEvidenceMedia(app, arrivalMediaUrl, kind);
      assert.equal(uploaded.statusCode, 201, uploaded.body);
    }
    const arrivalComplete = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/evidence/station_arrival/complete`,
      payload: {
        idempotencyKey: "handoff-mint-arrival-complete",
        verification: {
          plateMatched: true,
          materialsReady: true,
          exteriorRecorded: true,
          vehicleConditionConfirmed: true,
        },
      },
    });
    assert.equal(arrivalComplete.statusCode, 200, arrivalComplete.body);
    assert.equal(arrivalComplete.json<Json>().data.fulfillmentStatus, "checked_in");

    const firstMint = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/handoff-code`,
      headers: { authorization: `Bearer ${pickupToken}` },
    });
    assert.equal(firstMint.statusCode, 200, firstMint.body);
    const firstCode = firstMint.json<Json>().data.handoffVerificationCode;
    const firstExpiresAt = firstMint.json<Json>().data.expiresAt;
    assert.match(String(firstCode), /^\d{6}$/u);
    assert.ok(firstExpiresAt);
    assert.deepEqual(Object.keys(firstMint.json<Json>().data).sort(), [
      "expiresAt",
      "handoffVerificationCode",
    ]);

    const adminDetail = await app.inject({ method: "GET", url: `/api/admin/bookings/${bookingId}` });
    assert.equal(adminDetail.statusCode, 200, adminDetail.body);
    assert.equal("handoffVerificationCode" in adminDetail.json<Json>().data.driverAssignment, false);
    assert.equal(adminDetail.json<Json>().data.driverAssignment.handoffCodePending, true);
    assert.equal(adminDetail.json<Json>().data.driverAssignment.pickupDriverPhone, "13900139111");

    const ownerSession = await createDevelopmentSession(database, { userId: "demo-user" });
    const ownerDetail = await app.inject({
      method: "GET",
      url: `/api/bookings/${bookingId}`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    assert.equal(ownerDetail.statusCode, 200, ownerDetail.body);
    assert.equal(ownerDetail.json<Json>().data.driverAssignment.handoffCodePending, true);
    assert.equal("handoffVerificationCode" in ownerDetail.json<Json>().data.driverAssignment, false);
    assert.equal(ownerDetail.json<Json>().data.driverAssignment.pickupDriverPhone, "139****9111");

    const secondMint = await app.inject({
      method: "POST",
      url: `/api/driver/tasks/${bookingId}/handoff-code`,
      headers: { authorization: `Bearer ${pickupToken}` },
    });
    assert.equal(secondMint.statusCode, 200, secondMint.body);
    const secondCode = secondMint.json<Json>().data.handoffVerificationCode;
    assert.match(String(secondCode), /^\d{6}$/u);
    assert.notEqual(secondCode, firstCode);

    const returnDriver = await createDevelopmentSession(database, { userId: "valet-handoff-mint-return" });
    const oldCodeExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${returnDriver.token}` },
      payload: { verificationCode: firstCode, driverPhone: "13900139222" },
    });
    assert.equal(oldCodeExchange.statusCode, 404, oldCodeExchange.body);
    assert.equal(oldCodeExchange.json<Json>().error.code, "DRIVER_TASK_CODE_INVALID");

    const newCodeExchange = await app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${returnDriver.token}` },
      payload: { verificationCode: secondCode, driverPhone: "13900139222" },
    });
    assert.equal(newCodeExchange.statusCode, 201, newCodeExchange.body);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("代驾六位验证码失败尝试分别按微信用户和来源 IP 限流", async () => {
  const userFixture = await fixture();
  try {
    const session = await createDevelopmentSession(userFixture.database, { userId: "driver-code-user-limit" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await userFixture.app.inject({
        method: "POST",
        url: "/api/driver/task-sessions/exchange",
        headers: { authorization: `Bearer ${session.token}` },
        payload: { verificationCode: String(700_000 + attempt) },
      });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json<Json>().error.code, "DRIVER_TASK_CODE_INVALID");
    }
    const limited = await userFixture.app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${session.token}` },
      payload: { verificationCode: "700005" },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json<Json>().error.code, "DRIVER_TASK_CODE_RATE_LIMITED");
    const attempts = await userFixture.database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM valet_driver_code_attempts WHERE succeeded = FALSE
    `).get();
    assert.equal(Number(attempts?.count), 5);
  } finally {
    await userFixture.close();
  }

  const ipFixture = await fixture();
  try {
    for (let user = 0; user < 5; user += 1) {
      const session = await createDevelopmentSession(ipFixture.database, { userId: `driver-code-ip-${user}` });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await ipFixture.app.inject({
          method: "POST",
          url: "/api/driver/task-sessions/exchange",
          headers: { authorization: `Bearer ${session.token}` },
          payload: { verificationCode: String(710_000 + user * 10 + attempt) },
        });
        assert.equal(response.statusCode, 404, response.body);
      }
    }
    const nextUser = await createDevelopmentSession(ipFixture.database, { userId: "driver-code-ip-limited" });
    const limited = await ipFixture.app.inject({
      method: "POST",
      url: "/api/driver/task-sessions/exchange",
      headers: { authorization: `Bearer ${nextUser.token}` },
      payload: { verificationCode: "719999" },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json<Json>().error.code, "DRIVER_TASK_CODE_RATE_LIMITED");
  } finally {
    await ipFixture.close();
  }
});

test("创建年检预约必须携带服务端报价快照", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: slots[0].id,
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "self_drive",
        mediaIds: [],
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json<Json>().error.code, "VALIDATION_ERROR");
    assert.ok(response.json<Json>().error.fields.quoteSnapshotId);
  } finally {
    await close();
  }
});

test("年检报价快照绑定车辆并在过期或客户端篡改金额时拒绝创建订单", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const quoted = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "self_drive" },
    });
    assert.equal(quoted.statusCode, 200, quoted.body);
    const quote = quoted.json<Json>().data;
    assert.equal(quote.inspectionFeeFen, 26000);
    assert.equal(quote.valetFeeFen, 0);
    assert.equal(quote.serviceFeeFen, 26000);
    assert.ok(quote.quoteSnapshotId);
    const media = await uploadAnnualBookingMedia(app);
    const payload = {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
      contactName: "张女士",
      contactPhone: "13800138000",
      serviceMode: "self_drive",
      quoteSnapshotId: quote.quoteSnapshotId,
      mediaIds: media.map((item) => item.id),
    };

    const otherVehicle = await createVehicle(app, "津C·T7098");
    const wrongVehicle = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: { ...payload, vehicleId: otherVehicle.id },
    });
    assert.equal(wrongVehicle.statusCode, 404, wrongVehicle.body);
    assert.equal(wrongVehicle.json<Json>().error.code, "QUOTE_SNAPSHOT_NOT_FOUND");

    await database.prepare("UPDATE quote_snapshots SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", quote.quoteSnapshotId);
    const expired = await app.inject({ method: "POST", url: "/api/bookings", payload });
    assert.equal(expired.statusCode, 409, expired.body);
    assert.equal(expired.json<Json>().error.code, "QUOTE_EXPIRED");

    await database.prepare("UPDATE quote_snapshots SET expires_at = ? WHERE id = ?")
      .run("2099-01-01T00:00:00.000Z", quote.quoteSnapshotId);
    const tampered = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        ...payload,
        quote: {
          inspectionFeeFen: quote.inspectionFeeFen,
          valetFeeFen: quote.valetFeeFen,
          serviceFeeFen: quote.serviceFeeFen + 1,
        },
      },
    });
    assert.equal(tampered.statusCode, 409, tampered.body);
    assert.equal(tampered.json<Json>().error.code, "QUOTE_CHANGED");

    const slot = await database.prepare<Json>("SELECT booked_count FROM station_slots WHERE id = ?").get(slots[0].id);
    assert.equal(Number(slot?.booked_count), Number(slots[0].bookedCount ?? 0));
    assert.equal(Number((await database.prepare<Json>(
      "SELECT COUNT(*) AS count FROM booking_media WHERE booking_id IS NOT NULL AND id = ANY(?)",
    ).get(media.map((item) => item.id)))?.count), 0);
  } finally {
    await close();
  }
});

test("年检在线报价拒绝启用零元价格且对历史异常配置保持不可下单", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const zeroLegacyPrice = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { stationId: station.id, category: "fuel_small", priceFen: 0 },
    });
    assert.equal(zeroLegacyPrice.statusCode, 400, zeroLegacyPrice.body);
    assert.equal(zeroLegacyPrice.json<Json>().error.code, "VALIDATION_ERROR");

    const stationsResponse = await app.inject({ method: "GET", url: "/api/admin/stations" });
    assert.equal(stationsResponse.statusCode, 200, stationsResponse.body);
    const configuredStation = stationsResponse.json<Json>().data.find((item: Json) => item.id === station.id);
    assert.ok(configuredStation);
    const supportedPlan = configuredStation.pricePlans.find((item: Json) => item.isSupported);
    assert.ok(supportedPlan);
    const zeroSupportedPlan = await app.inject({
      method: "PUT",
      url: `/api/admin/stations/${station.id}/price-plans`,
      payload: {
        pricePlans: configuredStation.pricePlans.map((item: Json) => (
          item.planId === supportedPlan.planId ? { ...item, priceFen: 0 } : item
        )),
      },
    });
    assert.equal(zeroSupportedPlan.statusCode, 400, zeroSupportedPlan.body);
    assert.equal(zeroSupportedPlan.json<Json>().error.code, "VALIDATION_ERROR");

    await database.prepare(`
      UPDATE station_inspection_price_plans SET price_fen = 0
      WHERE station_id = ? AND plan_id = ?
    `).run(station.id, supportedPlan.planId);
    const guardedQuote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "self_drive" },
    });
    assert.equal(guardedQuote.statusCode, 200, guardedQuote.body);
    const data = guardedQuote.json<Json>().data;
    assert.equal(data.serviceable, false);
    assert.equal(data.pricingEligibility, "manual_review");
    assert.equal(data.pricingReason, "invalid_price_plan_amount");
    assert.ok(data.hardGuardFailures.includes("non_positive_price"));
    const media = await uploadAnnualBookingMedia(app);
    const blockedBooking = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: slots[0].id,
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "self_drive",
        quoteSnapshotId: data.quoteSnapshotId,
        mediaIds: media.map((item) => item.id),
      },
    });
    assert.equal(blockedBooking.statusCode, 409, blockedBooking.body);
    assert.equal(blockedBooking.json<Json>().error.code, "PRICE_REVIEW_REQUIRED");
  } finally {
    await close();
  }
});

test("后台调价影响新报价但不改写已提交订单价格快照", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const update = await app.inject({ method: "PUT", url: "/api/admin/pricing", payload: { stationId: station.id, category: "fuel_small", priceFen: 28800 } });
    assert.equal(update.statusCode, 200, update.body);
    const freshQuote = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "self_drive" } });
    assert.equal(freshQuote.json<Json>().data.inspectionFeeFen, 28800);
    const created = await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookingId = booking.id;
    await app.inject({ method: "PUT", url: "/api/admin/pricing", payload: { stationId: station.id, category: "fuel_small", priceFen: 32000 } });
    const existing = await app.inject({ method: "GET", url: `/api/bookings/${bookingId}` });
    assert.equal(existing.json<Json>().data.serviceFeeFen, 28800);
    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "frozen-price-payment-0001",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.payment.amountFen, 28800);
    assert.equal(paid.json<Json>().data.booking.chargedFen, 28800);
    assert.equal(paid.json<Json>().data.booking.paidFen, 28800);
    assert.equal(paid.json<Json>().data.booking.amountDueFen, 0);
    const chargeRows = await database.prepare<Json>(`
      SELECT amount_fen FROM booking_ledger_entries
      WHERE booking_id = ? AND kind = 'booking_charge'
    `).all(bookingId);
    assert.deepEqual(chargeRows.map((row) => Number(row.amount_fen)), [28800]);
    const admin = await app.inject({ method: "GET", url: `/api/admin/bookings?stationId=${station.id}&serviceMode=self_drive` });
    assert.ok(admin.json<Json>().data.some((item: Json) => item.id === bookingId));
  } finally {
    await close();
  }
});

test("创建预约、详情时间轴和演示状态推进形成完整状态机", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);
    let booking = created.json<Json>().data;
    assert.equal(booking.status, "confirmed");
    assert.equal(booking.fulfillmentStatus, "pending_payment");
    assert.equal(booking.serviceFeeFen, station.serviceFeeFen);
    assert.equal(booking.events[0].status, "pending_payment");
    assert.equal(booking.events[0].title, "预约已创建");
    assert.equal(booking.vehicle.plateKind, "blue");
    assert.equal(booking.vehicle.plateProvince, "津");
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "demo-advance-payment-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    await approvePrecheck(app, booking.id);

    booking = (await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` })).json<Json>().data;
    assert.equal(booking.fulfillmentStatus, "awaiting_arrival");
    for (const expected of ["checked_in", "inspecting", "completed"]) {
      const advanced = await app.inject({
        method: "POST",
        url: `/api/demo/bookings/${booking.id}/advance`,
      });
      assert.equal(advanced.statusCode, 200, advanced.body);
      booking = advanced.json<Json>().data;
      assert.equal(booking.status, expected);
      assert.equal(booking.fulfillmentStatus, expected);
      if (expected === "inspecting") await prepareCheckupReport(app, booking.id);
    }
    assert.ok(booking.events.length >= 7);
    assert.ok(booking.events.some((event: Json) => event.status === "result_received"));
    assert.ok(booking.events.some((event: Json) => event.title === "自驾年检服务已自动完成"));
    assert.equal(booking.inspectionResult.conclusion, "passed");
    assert.equal(booking.verification.vehicleConditionConfirmed, true);

    const cannotAdvance = await app.inject({
      method: "POST",
      url: `/api/demo/bookings/${booking.id}/advance`,
    });
    assert.equal(cannotAdvance.statusCode, 409);
    assert.equal(cannotAdvance.json<Json>().error.code, "BOOKING_CANNOT_ADVANCE");
  } finally {
    await close();
  }
});

test("进行中预约阻止删除车辆，取消后释放时段并允许删除", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const initialRemaining = slots[0].remaining;
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "cancel-full-payment-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(paid.statusCode, 201, paid.body);
    const pendingSurchargeResponse = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${booking.id}`,
      payload: {
        adjustment: { amountFen: 600, reason: "取消前待确认费用", idempotencyKey: "cancel-pending-surcharge-0001" },
      },
    });
    assert.equal(pendingSurchargeResponse.statusCode, 200, pendingSurchargeResponse.body);
    const pendingSurcharge = pendingSurchargeResponse.json<Json>().data.ledgerEntries
      .find((entry: Json) => entry.idempotencyKey === "cancel-pending-surcharge-0001");

    const blockedDelete = await app.inject({
      method: "DELETE",
      url: `/api/vehicles/${vehicle.id}`,
    });
    assert.equal(blockedDelete.statusCode, 409);
    assert.equal(blockedDelete.json<Json>().error.code, "VEHICLE_HAS_ACTIVE_BOOKING");

    const afterBooking = (
      await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots?date=${slots[0].date}` })
    ).json<Json>().data.find((slot: Json) => slot.id === slots[0].id);
    assert.equal(afterBooking.remaining, initialRemaining - 1);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/cancel`,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json<Json>().data.status, "cancelled");
    assert.equal(cancelled.json<Json>().data.fulfillmentStatus, "cancelled");
    assert.equal(cancelled.json<Json>().data.paymentStatus, "refunded");
    assert.equal(cancelled.json<Json>().data.precheck.status, "pending");
    assert.equal(cancelled.json<Json>().data.precheck.refundStatus, "refunded");
    assert.equal(cancelled.json<Json>().data.precheck.refundAmountFen, booking.serviceFeeFen);
    assert.equal(cancelled.json<Json>().data.chargedFen, 0);
    assert.equal(cancelled.json<Json>().data.amountDueFen, 0);
    assert.ok(cancelled.json<Json>().data.ledgerEntries.some((entry: Json) => entry.kind === "refund" && entry.amountFen === -booking.serviceFeeFen));
    assert.ok(cancelled.json<Json>().data.ledgerEntries.some((entry: Json) =>
      entry.kind === "cancellation_adjustment"
      && entry.amountFen === -booking.serviceFeeFen
      && entry.idempotencyKey === "automatic-cancellation-adjustment"));
    assert.equal(
      cancelled.json<Json>().data.ledgerEntries.find((entry: Json) => entry.id === pendingSurcharge.id).confirmationStatus,
      "voided",
    );
    const confirmVoided = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/ledger/${pendingSurcharge.id}/confirm`,
      payload: { idempotencyKey: "cancel-confirm-voided-0001" },
    });
    assert.equal(confirmVoided.statusCode, 409, confirmVoided.body);
    assert.equal(confirmVoided.json<Json>().error.code, "LEDGER_CONFIRMATION_NOT_ALLOWED");
    const terminalSurcharge = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${booking.id}`,
      payload: {
        adjustment: { amountFen: 100, reason: "终态订单费用", idempotencyKey: "cancel-terminal-surcharge-0001" },
      },
    });
    assert.equal(terminalSurcharge.statusCode, 409, terminalSurcharge.body);
    assert.equal(terminalSurcharge.json<Json>().error.code, "SURCHARGE_NOT_ALLOWED");
    const paymentAfterCancel = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "cancel-full-payment-0002", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(paymentAfterCancel.statusCode, 409, paymentAfterCancel.body);
    assert.equal(paymentAfterCancel.json<Json>().error.code, "PAYMENT_NOT_ALLOWED");

    const afterCancel = (
      await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots?date=${slots[0].date}` })
    ).json<Json>().data.find((slot: Json) => slot.id === slots[0].id);
    assert.equal(afterCancel.remaining, initialRemaining);

    const deleted = await app.inject({ method: "DELETE", url: `/api/vehicles/${vehicle.id}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json<Json>().data.deleted, true);
  } finally {
    await close();
  }
});

test("未支付预约取消后冲销全部应收且不保留待付款金额", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    assert.equal(booking.amountDueFen, booking.serviceFeeFen);

    const cancelled = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/cancel` });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const data = cancelled.json<Json>().data;
    assert.equal(data.fulfillmentStatus, "cancelled");
    assert.equal(data.chargedFen, 0);
    assert.equal(data.amountDueFen, 0);
    assert.equal(data.refundedFen, 0);
    assert.ok(data.ledgerEntries.some((entry: Json) =>
      entry.kind === "cancellation_adjustment"
      && entry.amountFen === -booking.serviceFeeFen));
  } finally {
    await close();
  }
});

test("改期原子释放旧时段并占用新时段", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const [oldSlot, newSlot] = slots;
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: oldSlot.id,
    });
    const booking = created.json<Json>().data;

    const changed = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/reschedule`,
      payload: { slotId: newSlot.id },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json<Json>().data.slotId, newSlot.id);
    assert.equal(changed.json<Json>().data.appointmentDate, newSlot.date);

    const rows = (
      await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots?date=${oldSlot.date}` })
    ).json<Json>().data;
    assert.equal(rows.find((slot: Json) => slot.id === oldSlot.id).remaining, oldSlot.remaining);
    assert.equal(rows.find((slot: Json) => slot.id === newSlot.id).remaining, newSlot.remaining - 1);

    const otherStation = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data
      .find((item: Json) => item.id !== station.id && item.id !== HUAYANG_STATION_ID);
    const otherSlot = (await app.inject({ method: "GET", url: `/api/stations/${otherStation.id}/slots?date=${newSlot.date}` }))
      .json<Json>().data[0];
    const missingCrossStationQuote = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/reschedule`, payload: {
      slotId: otherSlot.id,
    } });
    assert.equal(missingCrossStationQuote.statusCode, 409, missingCrossStationQuote.body);
    assert.equal(missingCrossStationQuote.json<Json>().error.code, "RESCHEDULE_QUOTE_REQUIRED");
    const freshQuote = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicle.id, stationId: otherStation.id, serviceMode: "self_drive",
    } });
    assert.equal(freshQuote.statusCode, 200, freshQuote.body);
    const crossed = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/reschedule`, payload: {
      slotId: otherSlot.id, quoteSnapshotId: freshQuote.json<Json>().data.quoteSnapshotId,
    } });
    assert.equal(crossed.statusCode, 200, crossed.body);
    assert.equal(crossed.json<Json>().data.stationId, otherStation.id);
    assert.equal(crossed.json<Json>().data.serviceFeeFen, freshQuote.json<Json>().data.serviceFeeFen);
    assert.equal(crossed.json<Json>().data.quoteSnapshotId, freshQuote.json<Json>().data.quoteSnapshotId);
  } finally {
    await close();
  }
});

test("代驾取消按阶段退款，后台取消幂等释放号源且取车后禁止车主取消", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 11_700, duration: 1_200 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { vehicle, station, slots } = await seedContext(app);
    const pickupAddress = {
      poiId: "cancel-valet-pickup", title: "天津站", address: "天津市河北区新纬路 1 号",
      district: "河北区", latitude: 39.135671, longitude: 117.20965, source: "tencent",
    };
    const createValet = async (vehicleId: string, slotId: string, suffix: string) => {
      const quote = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
        vehicleId, stationId: station.id, serviceMode: "valet", pickupAddress,
      } });
      assert.equal(quote.statusCode, 200, quote.body);
      const media = await uploadAnnualBookingMedia(app, "valet");
      const booking = await app.inject({ method: "POST", url: "/api/bookings", payload: {
        vehicleId, stationId: station.id, slotId, contactName: "张女士", contactPhone: "13800138000",
        serviceMode: "valet", pickupAddress, quoteSnapshotId: quote.json<Json>().data.quoteSnapshotId,
        mediaIds: media.map((item) => item.id),
      } });
      assert.equal(booking.statusCode, 201, booking.body);
      const data = booking.json<Json>().data;
      const paid = await app.inject({ method: "POST", url: `/api/bookings/${data.id}/payments`, payload: {
        provider: "mock", idempotencyKey: `valet-cancel-pay-${suffix}`, quoteSnapshotId: data.quoteSnapshotId,
      } });
      assert.equal(paid.statusCode, 201, paid.body);
      assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
      const approved = await approvePrecheck(app, data.id);
      assert.equal(approved.fulfillmentStatus, "confirmed");
      // This test exercises historical cancellation compatibility. New-policy
      // valet transitions are covered by the evidence-gated driver flow test.
      await database.prepare("UPDATE bookings SET evidence_policy_version = 'legacy' WHERE id = ?").run(data.id);
      await database.prepare(`
        UPDATE bookings SET status = 'confirmed', fulfillment_status = 'driver_arranged'
        WHERE id = ?
      `).run(data.id);
      return data;
    };

    const firstSlotInitial = slots[0].remaining;
    const arranged = await createValet(vehicle.id, slots[0].id, "0001");
    const genericAdvanceDenied = await app.inject({
      method: "POST",
      url: `/api/demo/bookings/${arranged.id}/advance`,
    });
    assert.equal(genericAdvanceDenied.statusCode, 409, genericAdvanceDenied.body);
    assert.equal(genericAdvanceDenied.json<Json>().error.code, "VALET_DEMO_ADVANCE_UNSUPPORTED");
    const cancelled = await app.inject({ method: "PATCH", url: `/api/admin/bookings/${arranged.id}`, payload: {
      fulfillmentStatus: "cancelled",
    } });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const cancelledData = cancelled.json<Json>().data;
    assert.equal(cancelledData.fulfillmentStatus, "cancelled");
    assert.equal(cancelledData.paymentStatus, "partially_refunded");
    assert.equal(cancelledData.chargedFen, arranged.priceBreakdown.valetBaseFeeFen);
    assert.equal(cancelledData.amountDueFen, 0);
    assert.ok(cancelledData.ledgerEntries.some((entry: Json) =>
      entry.kind === "cancellation_adjustment"
      && entry.amountFen === -(arranged.serviceFeeFen - arranged.priceBreakdown.valetBaseFeeFen)));
    const automaticRefunds = cancelledData.ledgerEntries.filter((entry: Json) => entry.idempotencyKey === "automatic-cancellation-refund");
    assert.equal(automaticRefunds.length, 1);
    assert.equal(automaticRefunds[0].amountFen, -(arranged.serviceFeeFen - arranged.priceBreakdown.valetBaseFeeFen));
    const repeatedCancel = await app.inject({ method: "PATCH", url: `/api/admin/bookings/${arranged.id}`, payload: {
      fulfillmentStatus: "cancelled",
    } });
    assert.equal(repeatedCancel.statusCode, 200, repeatedCancel.body);
    assert.equal(repeatedCancel.json<Json>().data.ledgerEntries.filter((entry: Json) => entry.idempotencyKey === "automatic-cancellation-refund").length, 1);
    const firstSlotAfter = (await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots?date=${slots[0].date}` }))
      .json<Json>().data.find((item: Json) => item.id === slots[0].id);
    assert.equal(firstSlotAfter.remaining, firstSlotInitial);

    const secondVehicle = await createVehicle(app, "津B·T7003");
    const pickedUp = await createValet(secondVehicle.id, slots[1].id, "0002");
    await database.prepare(`
      UPDATE bookings SET status = 'awaiting_arrival', fulfillment_status = 'picked_up'
      WHERE id = ?
    `).run(pickedUp.id);
    const denied = await app.inject({ method: "POST", url: `/api/bookings/${pickedUp.id}/cancel` });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json<Json>().error.code, "BOOKING_IN_PROGRESS");
    const deniedReschedule = await app.inject({ method: "POST", url: `/api/bookings/${pickedUp.id}/reschedule`, payload: {
      slotId: slots[2].id,
    } });
    assert.equal(deniedReschedule.statusCode, 409, deniedReschedule.body);
    assert.equal(deniedReschedule.json<Json>().error.code, "BOOKING_CANNOT_RESCHEDULE");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("检测站爽约操作释放号源且已有预约的号源不能修改日期时间", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const slot = slots[0];
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slot.id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "no-show-payment-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    const approved = await approvePrecheck(app, booking.id);
    assert.equal(approved.fulfillmentStatus, "awaiting_arrival");

    const lockedSchedule = await app.inject({
      method: "PUT",
      url: `/api/admin/station-slots/${slot.id}`,
      payload: {
        date: slot.date,
        startTime: slot.startTime === "08:30" ? "08:31" : "08:29",
        endTime: slot.endTime,
        capacity: slot.capacity,
      },
    });
    assert.equal(lockedSchedule.statusCode, 409, lockedSchedule.body);
    assert.equal(lockedSchedule.json<Json>().error.code, "SLOT_SCHEDULE_LOCKED");

    const before = (await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots?date=${slot.date}` }))
      .json<Json>().data.find((item: Json) => item.id === slot.id).bookedCount;
    const firstNoShow = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${booking.id}/no-show`,
    });
    assert.equal(firstNoShow.statusCode, 200, firstNoShow.body);
    const afterFirst = (await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots?date=${slot.date}` }))
      .json<Json>().data.find((item: Json) => item.id === slot.id).bookedCount;
    assert.equal(afterFirst, before - 1);

    const repeatedNoShow = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${booking.id}/no-show`,
    });
    assert.equal(repeatedNoShow.statusCode, 409, repeatedNoShow.body);
    const afterRepeat = (await app.inject({ method: "GET", url: `/api/stations/${station.id}/slots?date=${slot.date}` }))
      .json<Json>().data.find((item: Json) => item.id === slot.id).bookedCount;
    assert.equal(afterRepeat, afterFirst);
  } finally {
    await close();
  }
});

test("约满时段返回 409 SLOT_FULL", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    database
      .prepare("UPDATE station_slots SET capacity = booked_count + 1 WHERE id = ?")
      .run(slots[0].id);

    const first = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(first.statusCode, 201, first.body);

    const secondVehicle = await createVehicle(app, "津C·T0002");
    const conflict = await createBooking(app, {
      vehicleId: secondVehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json<Json>().error.code, "SLOT_FULL");
  } finally {
    await close();
  }
});

test("演示重置恢复一车四站且清空订单", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);

    const reset = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(reset.json<Json>().data.vehicles, 1);
    assert.equal(reset.json<Json>().data.stations, 4);
    assert.equal(reset.json<Json>().data.operatorTasks, 6);

    const bookings = await app.inject({ method: "GET", url: "/api/bookings" });
    assert.deepEqual(bookings.json<Json>().data, []);
  } finally {
    await close();
  }
});

test("演示重置默认关闭且必须显式开启", async () => {
  const { app, close } = await fixture();
  const original = process.env.ALLOW_DEMO_RESET;
  try {
    delete process.env.ALLOW_DEMO_RESET;
    const denied = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json<Json>().error.code, "DEMO_RESET_DISABLED");
  } finally {
    if (original === undefined) delete process.env.ALLOW_DEMO_RESET;
    else process.env.ALLOW_DEMO_RESET = original;
    await close();
  }
});

test("演示流程写接口默认关闭且必须显式开启", async () => {
  const { app, close } = await fixture();
  const original = process.env.ALLOW_DEMO_WORKFLOW;
  try {
    delete process.env.ALLOW_DEMO_WORKFLOW;
    for (const url of [
      "/api/demo/bookings/not-found/advance",
      "/api/demo/operator/bookings/not-found/simulate-result",
    ]) {
      const denied = await app.inject({ method: "POST", url });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json<Json>().error.code, "DEMO_WORKFLOW_DISABLED");
    }
  } finally {
    if (original === undefined) delete process.env.ALLOW_DEMO_WORKFLOW;
    else process.env.ALLOW_DEMO_WORKFLOW = original;
    await close();
  }
});

test("检测站工作台按站点与日期切换，C 端只能读取自己的订单", async () => {
  const { app, close } = await fixture();
  try {
    const workbench = await app.inject({ method: "GET", url: "/api/operator/workbench" });
    assert.equal(workbench.statusCode, 200, workbench.body);
    const data = workbench.json<Json>().data;
    assert.equal(data.station.id, "station-hexi-1");
    assert.equal(data.summary.todayBookings, 6);
    assert.equal(data.bookings.length, 6);
    assert.ok(data.pressure.length >= 4);
    assert.ok(data.bookings.every((booking: Json) => booking.stationId === "station-hexi-1"));
    assert.ok(data.bookings.every((booking: Json) => booking.serviceFeeFen > 0));
    assert.ok(data.bookings.every((booking: Json) => booking.paymentStatus === "paid"));
    assert.ok(data.bookings.every((booking: Json) => booking.chargedFen === booking.serviceFeeFen));
    assert.ok(data.bookings.every((booking: Json) => booking.paidFen === booking.serviceFeeFen));
    assert.ok(data.bookings.every((booking: Json) => booking.amountDueFen === 0));
    assert.deepEqual(
      data.bookings.map((booking: Json) => booking.serviceFeeFen).sort((left: number, right: number) => left - right),
      [24000, 24000, 26000, 26000, 26000, 30000],
    );

    const consumerCannotRead = await app.inject({ method: "GET", url: "/api/bookings/booking-op-1" });
    assert.equal(consumerCannotRead.statusCode, 404);

    const operatorCanRead = await app.inject({ method: "GET", url: "/api/operator/bookings/booking-op-1" });
    assert.equal(operatorCanRead.statusCode, 200, operatorCanRead.body);
    assert.equal(operatorCanRead.json<Json>().data.vehicle.plateNumber, "津B·T1001");

    const { vehicle } = await seedContext(app);
    const stations = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data;
    const otherStation = stations.find((station: Json) => station.id === "station-nankai-1");
    const otherSlots = (
      await app.inject({ method: "GET", url: `/api/stations/${otherStation.id}/slots` })
    ).json<Json>().data;
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: otherStation.id,
      slotId: otherSlots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const crossStation = await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${created.json<Json>().data.id}`,
    });
    assert.equal(crossStation.statusCode, 200, crossStation.body);
    const unpaidWorkbench = await app.inject({ method: "GET", url: `/api/operator/workbench?stationId=${otherStation.id}&date=${otherSlots[0].date}` });
    assert.equal(unpaidWorkbench.statusCode, 200, unpaidWorkbench.body);
    assert.ok(!unpaidWorkbench.json<Json>().data.bookings.some((booking: Json) => booking.id === created.json<Json>().data.id));
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${created.json<Json>().data.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "workbench-auto-confirm-payment-0001",
      quoteSnapshotId: created.json<Json>().data.quoteSnapshotId,
    } });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    const pendingWorkbench = await app.inject({ method: "GET", url: `/api/operator/workbench?stationId=${otherStation.id}&date=${otherSlots[0].date}` });
    assert.equal(pendingWorkbench.statusCode, 200, pendingWorkbench.body);
    assert.equal(pendingWorkbench.json<Json>().data.summary.pendingPrecheckCount, 1);
    assert.ok(!pendingWorkbench.json<Json>().data.bookings.some((booking: Json) => booking.id === created.json<Json>().data.id));
    await approvePrecheck(app, created.json<Json>().data.id);
    const paidWorkbench = await app.inject({ method: "GET", url: `/api/operator/workbench?stationId=${otherStation.id}&date=${otherSlots[0].date}` });
    assert.equal(paidWorkbench.statusCode, 200, paidWorkbench.body);
    assert.ok(paidWorkbench.json<Json>().data.bookings.some((booking: Json) => booking.id === created.json<Json>().data.id));
  } finally {
    await close();
  }
});

test("跨业务日启动会把固定演示任务滚动到上海时区的新日期", async () => {
  const { app, database, close } = await fixture();
  try {
    process.env.YUXIAOMAN_DEMO_DATE = "2026-08-12";
    await seedDemoData(database);

    const workbench = await app.inject({ method: "GET", url: "/api/operator/workbench" });
    assert.equal(workbench.statusCode, 200, workbench.body);
    const data = workbench.json<Json>().data;
    assert.equal(data.businessDate, "2026-08-12");
    assert.equal(data.bookings.length, 6);
    assert.ok(data.bookings.every((booking: Json) => booking.appointmentDate === "2026-08-12"));
    assert.equal(
      Number((
        await database
          .prepare<{ count: string }>("SELECT COUNT(*) AS count FROM bookings WHERE id LIKE 'booking-op-%' AND appointment_date = '2026-08-11'")
          .get()
      )?.count),
      0,
    );
  } finally {
    process.env.YUXIAOMAN_DEMO_DATE = "2026-08-11";
    await close();
  }
});

test("B 端从接单到结果交付形成六态履约闭环并同步给 C 端", async () => {
  const { app, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookingId = booking.id;

    const unpaidAccept = await app.inject({ method: "POST", url: `/api/operator/bookings/${bookingId}/accept` });
    assert.equal(unpaidAccept.statusCode, 409, unpaidAccept.body);
    assert.equal(unpaidAccept.json<Json>().error.code, "PAYMENT_REQUIRED");
    const paid = await app.inject({ method: "POST", url: `/api/bookings/${bookingId}/payments`, payload: {
      provider: "mock", idempotencyKey: "operator-flow-payment-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.booking.paymentStatus, "paid");
    assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    assert.equal(paid.json<Json>().data.booking.amountDueFen, 0);

    const adminAdvanceDenied = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "awaiting_arrival" },
    });
    assert.equal(adminAdvanceDenied.statusCode, 409, adminAdvanceDenied.body);
    assert.equal(adminAdvanceDenied.json<Json>().error.code, "ADMIN_WORKFLOW_ADVANCE_FORBIDDEN");

    const precheckBlockedAccept = await app.inject({ method: "POST", url: `/api/operator/bookings/${bookingId}/accept` });
    assert.equal(precheckBlockedAccept.statusCode, 409, precheckBlockedAccept.body);
    const approved = await approvePrecheck(app, bookingId);
    assert.equal(approved.fulfillmentStatus, "awaiting_arrival");

    const actions: Array<{ path: string; expected: string; payload?: Json }> = [
      {
        path: "check-in",
        expected: "checked_in",
        payload: {
          plateMatched: true,
          materialsReady: true,
          exteriorRecorded: true,
          vehicleConditionConfirmed: true,
        },
      },
      { path: "handoff", expected: "inspecting" },
    ];
    for (const action of actions) {
      const response = await app.inject({
        method: "POST",
        url: `/api/operator/bookings/${bookingId}/${action.path}`,
        payload: action.payload ?? {},
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<Json>().data.status, action.expected);
      assert.equal(response.json<Json>().data.fulfillmentStatus, action.expected);
    }

    const lateSelfDriveCancellation = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "cancelled" },
    });
    assert.equal(lateSelfDriveCancellation.statusCode, 409, lateSelfDriveCancellation.body);
    assert.equal(lateSelfDriveCancellation.json<Json>().error.code, "BOOKING_IN_PROGRESS");

    await prepareCheckupReport(app, bookingId);

    const pendingSurchargeResponse = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: {
        adjustment: {
          amountFen: 700,
          reason: "检测过程新增服务费",
          idempotencyKey: "self-drive-result-surcharge-0001",
        },
      },
    });
    assert.equal(pendingSurchargeResponse.statusCode, 200, pendingSurchargeResponse.body);
    const pendingSurcharge = pendingSurchargeResponse.json<Json>().data.ledgerEntries
      .find((entry: Json) => entry.idempotencyKey === "self-drive-result-surcharge-0001");

    const blockedPendingResult = await app.inject({
      method: "POST",
      url: `/api/demo/operator/bookings/${bookingId}/simulate-result`,
    });
    assert.equal(blockedPendingResult.statusCode, 409, blockedPendingResult.body);
    assert.equal(blockedPendingResult.json<Json>().error.code, "PENDING_SURCHARGE_CONFIRMATION");
    const stillInspecting = await app.inject({ method: "GET", url: `/api/operator/bookings/${bookingId}` });
    assert.equal(stillInspecting.json<Json>().data.fulfillmentStatus, "inspecting");
    assert.equal(stillInspecting.json<Json>().data.vehicleCheckupReport.status, "draft");

    const confirmedSurcharge = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/ledger/${pendingSurcharge.id}/confirm`,
      payload: { idempotencyKey: "self-drive-result-surcharge-confirm-0001" },
    });
    assert.equal(confirmedSurcharge.statusCode, 200, confirmedSurcharge.body);
    assert.equal(confirmedSurcharge.json<Json>().data.booking.amountDueFen, 700);

    const blockedUnpaidResult = await app.inject({
      method: "POST",
      url: `/api/demo/operator/bookings/${bookingId}/simulate-result`,
    });
    assert.equal(blockedUnpaidResult.statusCode, 409, blockedUnpaidResult.body);
    assert.equal(blockedUnpaidResult.json<Json>().error.code, "OUTSTANDING_PAYMENT");

    const supplementalPayment = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/payments`,
      payload: { provider: "mock", idempotencyKey: "self-drive-result-surcharge-payment-0001" },
    });
    assert.equal(supplementalPayment.statusCode, 201, supplementalPayment.body);
    assert.equal(supplementalPayment.json<Json>().data.payment.amountFen, 700);

    const simulated = await app.inject({
      method: "POST",
      url: `/api/demo/operator/bookings/${bookingId}/simulate-result`,
    });
    assert.equal(simulated.statusCode, 200, simulated.body);
    assert.equal(simulated.json<Json>().data.status, "completed");
    assert.equal(simulated.json<Json>().data.fulfillmentStatus, "completed");
    assert.equal(simulated.json<Json>().data.inspectionResult.conclusion, "passed");
    assert.ok(simulated.json<Json>().data.events.some((event: Json) => event.title === "支付已确认"));
    assert.ok(simulated.json<Json>().data.events.some((event: Json) => event.actorType === "external_system"));
    assert.ok(simulated.json<Json>().data.events.some((event: Json) => event.title === "自驾年检服务已自动完成"));
    const resultEventIndex = simulated.json<Json>().data.events
      .findIndex((event: Json) => event.status === "result_received");
    const completionEventIndex = simulated.json<Json>().data.events
      .findIndex((event: Json) => event.title === "自驾年检服务已自动完成");
    assert.ok(resultEventIndex >= 0 && completionEventIndex > resultEventIndex);
    assert.ok(
      Date.parse(simulated.json<Json>().data.events[completionEventIndex].createdAt)
        > Date.parse(simulated.json<Json>().data.events[resultEventIndex].createdAt),
    );

    const consumerDetail = await app.inject({ method: "GET", url: `/api/bookings/${bookingId}` });
    assert.equal(consumerDetail.statusCode, 200, consumerDetail.body);
    assert.equal(consumerDetail.json<Json>().data.status, "completed");
    assert.equal(consumerDetail.json<Json>().data.verification.plateMatched, true);
    assert.equal(consumerDetail.json<Json>().data.inspectionResult.summary.itemsPassed, 12);
    assert.equal(consumerDetail.json<Json>().data.vehicleCheckupReport.status, "published");
    assert.equal(consumerDetail.json<Json>().data.vehicleCheckupReport.media.length, 7);
    assert.ok(consumerDetail.json<Json>().data.vehicleCheckupReport.legalMaterials.safetyInspectionReport);
    assert.equal(consumerDetail.json<Json>().data.vehicleCheckupReport.annualInspection.markStatus, "issued");

    const duplicateComplete = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/complete`,
    });
    assert.equal(duplicateComplete.statusCode, 409);
    assert.equal(duplicateComplete.json<Json>().error.code, "INVALID_BOOKING_TRANSITION");
  } finally {
    await close();
  }
});

test("车辆体检报告要求五张现场照且仅通过时强制合格凭证，支持多故障并阻止后台绕过结果回传", async () => {
  const { app, database, close } = await fixture();
  try {
    const bookingId = "booking-op-3";
    const empty = await app.inject({ method: "GET", url: `/api/operator/bookings/${bookingId}/checkup-report` });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json<Json>().data, null);

    const bypass = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "result_received" },
    });
    assert.equal(bypass.statusCode, 409, bypass.body);
    assert.equal(bypass.json<Json>().error.code, "INSPECTION_RESULT_SUBMISSION_REQUIRED");

    const draft = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
      payload: {
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        summary: { conclusionLabel: "检验合格", note: "车况问题仅进入报告，不改变年检结论" },
        faults: [
          {
            viewId: "left",
            regionCode: "left_front_wheel",
            faultType: "scratch",
            severity: "severe",
            description: "左前轮毂有长划痕",
          },
          {
            viewId: "top",
            regionCode: "dashboard_obd",
            faultType: "warning_light",
            severity: "moderate",
            description: "发动机故障灯常亮并记录报码",
          },
        ],
      },
    });
    assert.equal(draft.statusCode, 200, draft.body);
    assert.equal(draft.json<Json>().data.status, "draft");
    assert.equal(draft.json<Json>().data.faults.length, 2);
    for (const [index, fault] of draft.json<Json>().data.faults.entries()) {
      await uploadFaultPhoto(app, bookingId, fault.id, {
        idempotencyKey: `checkup-main-fault-${index + 1}`,
      });
    }

    const uploaded = new Map<string, Json>();
    for (const kind of ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"]) {
      uploaded.set(kind, await uploadCheckupMedia(app, bookingId, kind));
    }
    const replacement = await uploadCheckupMedia(app, bookingId, "front_left");
    assert.notEqual(replacement.id, uploaded.get("front_left")!.id);
    const afterReplacement = (await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
    })).json<Json>().data;
    assert.equal(afterReplacement.media.length, 5);
    assert.equal(afterReplacement.sitePhotos.frontLeft.id, replacement.id);

    const missingMarkWithoutOptionalReports = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      payload: {},
    });
    assert.equal(missingMarkWithoutOptionalReports.statusCode, 409, missingMarkWithoutOptionalReports.body);
    assert.equal(missingMarkWithoutOptionalReports.json<Json>().error.code, "ANNUAL_INSPECTION_MARK_REQUIRED");

    await uploadCheckupMedia(app, bookingId, "safety_inspection_report");
    await uploadCheckupMedia(app, bookingId, "emissions_inspection_report");
    const missingMark = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      payload: {},
    });
    assert.equal(missingMark.statusCode, 409, missingMark.body);
    assert.equal(missingMark.json<Json>().error.code, "ANNUAL_INSPECTION_MARK_REQUIRED");

    await uploadCheckupMedia(app, bookingId, "annual_inspection_mark");
    const submitted = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      headers: { "idempotency-key": "manual-checkup-result-0001" },
      payload: {},
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.equal(submitted.json<Json>().data.fulfillmentStatus, "completed");
    assert.equal(submitted.json<Json>().data.inspectionResult.conclusion, "passed");
    assert.equal(submitted.json<Json>().data.vehicleCheckupReport.status, "published");
    assert.equal(submitted.json<Json>().data.vehicleCheckupReport.faults.length, 2);
    const resultAudit = await database.prepare<Json>(`
      SELECT metadata_json, before_json, after_json FROM backoffice_audit_events
      WHERE action = 'booking.inspection_result.submit' AND resource_id = ?
      ORDER BY occurred_at DESC LIMIT 1
    `).get(bookingId);
    assert.ok(resultAudit);
    const resultAuditMetadata = typeof resultAudit.metadata_json === "string"
      ? JSON.parse(resultAudit.metadata_json)
      : resultAudit.metadata_json;
    assert.equal(resultAuditMetadata.presentation.actionLabel, "提交检验结果");
    assert.equal(resultAuditMetadata.presentation.summary.includes("通过"), true);
    assert.equal(JSON.stringify(resultAudit).includes("manual-checkup-result-0001"), false);

    const report = submitted.json<Json>().data.vehicleCheckupReport;
    assert.ok(Date.parse(report.retainUntil) >= Date.parse(report.publishedAt) + 6 * 365 * 24 * 60 * 60 * 1000);
    assert.ok(report.media.every((media: Json) => media.status === "bound" && media.expiresAt === report.retainUntil));
    assert.equal(
      Number((await database.prepare<Json>(
        "SELECT COUNT(*) AS count FROM vehicle_checkup_media WHERE booking_id = ? AND kind <> 'fault_closeup'",
      ).get(bookingId))!.count),
      8,
    );

    const adminDetail = await app.inject({ method: "GET", url: `/api/admin/bookings/${bookingId}` });
    assert.equal(adminDetail.statusCode, 200, adminDetail.body);
    assert.equal(adminDetail.json<Json>().data.vehicleCheckupReport.reportNo, report.reportNo);
    const adminSafetyReport = adminDetail.json<Json>().data.vehicleCheckupReport.legalMaterials.safetyInspectionReport;
    const adminEmissionsReport = adminDetail.json<Json>().data.vehicleCheckupReport.legalMaterials.emissionsInspectionReport;
    assert.match(adminSafetyReport.url, /^\/api\/admin\/bookings\//);
    assert.equal((await app.inject({ method: "GET", url: adminSafetyReport.url })).statusCode, 200);
    assert.match(adminEmissionsReport.url, /^\/api\/admin\/bookings\//);
    assert.equal((await app.inject({ method: "GET", url: adminEmissionsReport.url })).statusCode, 200);
    assert.equal(
      (await app.inject({ method: "GET", url: adminDetail.json<Json>().data.vehicleCheckupReport.media[0].url })).statusCode,
      200,
    );

    const retainedMedia = adminDetail.json<Json>().data.vehicleCheckupReport.media[0];
    await database.prepare("UPDATE vehicle_checkup_media SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", retainedMedia.id);
    const cleanupTrigger = await requestCheckupMedia(app, bookingId, "front_left");
    assert.equal(cleanupTrigger.statusCode, 409, cleanupTrigger.body);
    assert.equal(cleanupTrigger.json<Json>().error.code, "VEHICLE_CHECKUP_REPORT_NOT_EDITABLE");
    const stillBound = await database.prepare<Json>(
      "SELECT status, storage_key FROM vehicle_checkup_media WHERE id = ?",
    ).get(retainedMedia.id);
    assert.equal(stillBound?.status, "bound");
    assert.ok(stillBound?.storage_key);
    assert.equal(
      (await app.inject({ method: "GET", url: retainedMedia.url })).statusCode,
      200,
      "过期清理不得删除已发布并绑定的六年留存媒体",
    );

    const retry = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      headers: { "idempotency-key": "manual-checkup-result-0001" },
      payload: {},
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json<Json>().meta.idempotent, true);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events
      WHERE action = 'booking.inspection_result.submit' AND resource_id = ?
    `).get(bookingId))?.count ?? 0), 1);

    const conflictingRetry = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      headers: { "idempotency-key": "manual-checkup-result-0001" },
      payload: { summary: { conclusionLabel: "不同的结果摘要" } },
    });
    assert.equal(conflictingRetry.statusCode, 409, conflictingRetry.body);
    assert.equal(conflictingRetry.json<Json>().error.code, "IDEMPOTENCY_KEY_CONFLICT");

    const duplicateWithDifferentKey = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      headers: { "idempotency-key": "manual-checkup-result-0002" },
      payload: {},
    });
    assert.equal(duplicateWithDifferentKey.statusCode, 409, duplicateWithDifferentKey.body);
    assert.equal(duplicateWithDifferentKey.json<Json>().error.code, "DUPLICATE_INSPECTION_RESULT");
  } finally {
    await close();
  }
});

test("体检报告完整性覆盖缺照、failed、停用结论、年检标冲突与 rowVersion", async () => {
  const { app, close } = await fixture();
  try {
    const failedBookingId = "booking-op-3";
    const failureDetails = {
      itemCategories: ["instrumented_test"],
      reason: "制动性能检测项目未达到规定限值",
      reinspectionAdvice: "检修制动系统后，在规定期限内申请复检",
    };
    const incompleteFailedDraft = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${failedBookingId}/checkup-report`,
      payload: {
        observationMode: "no_visible_faults",
        annualInspection: { conclusion: "failed" },
        faults: [],
      },
    });
    assert.equal(incompleteFailedDraft.statusCode, 400, incompleteFailedDraft.body);
    assert.ok(incompleteFailedDraft.json<Json>().error.fields["annualInspection.failureDetails"]);

    const failedDraftPayload = {
      observationMode: "no_visible_faults",
      annualInspection: { conclusion: "failed", failureDetails },
      summary: { conclusionLabel: "检验不合格" },
      faults: [],
    };
    const failedDraft = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${failedBookingId}/checkup-report`,
      payload: failedDraftPayload,
    });
    assert.equal(failedDraft.statusCode, 200, failedDraft.body);
    const currentVersion = failedDraft.json<Json>().data.rowVersion;

    const staleDraft = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${failedBookingId}/checkup-report`,
      payload: { ...failedDraftPayload, rowVersion: currentVersion - 1 },
    });
    assert.equal(staleDraft.statusCode, 409, staleDraft.body);
    assert.equal(staleDraft.json<Json>().error.code, "VEHICLE_CHECKUP_REPORT_VERSION_CONFLICT");

    for (const kind of ["front_left", "front_right", "rear_left", "rear_right"]) {
      await uploadCheckupMedia(app, failedBookingId, kind);
    }
    const missingDashboard = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${failedBookingId}/inspection-result`,
      headers: { "idempotency-key": "failed-report-missing-photo-0001" },
      payload: {},
    });
    assert.equal(missingDashboard.statusCode, 409, missingDashboard.body);
    assert.equal(missingDashboard.json<Json>().error.code, "VEHICLE_CHECKUP_PHOTOS_REQUIRED");
    const afterMissingPhoto = await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${failedBookingId}`,
    });
    assert.equal(afterMissingPhoto.json<Json>().data.fulfillmentStatus, "inspecting");
    assert.equal(afterMissingPhoto.json<Json>().data.vehicleCheckupReport.status, "draft");

    await uploadCheckupMedia(app, failedBookingId, "dashboard_started");
    const failedMark = await uploadCheckupMedia(app, failedBookingId, "annual_inspection_mark");
    const failedWithMark = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${failedBookingId}/inspection-result`,
      headers: { "idempotency-key": "failed-report-with-mark-0001" },
      payload: {},
    });
    assert.equal(failedWithMark.statusCode, 409, failedWithMark.body);
    assert.equal(failedWithMark.json<Json>().error.code, "ANNUAL_INSPECTION_MARK_NOT_ALLOWED");
    // WeChat mini program DELETE often sends application/json with an empty body.
    assert.equal((await app.inject({
      method: "DELETE",
      url: `/api/operator/bookings/${failedBookingId}/checkup-report/media/${failedMark.id}`,
      headers: { "content-type": "application/json", "content-length": "0" },
      payload: "",
    })).statusCode, 200);

    const failedSubmitted = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${failedBookingId}/inspection-result`,
      headers: { "idempotency-key": "failed-report-submit-0001" },
      payload: {},
    });
    assert.equal(failedSubmitted.statusCode, 200, failedSubmitted.body);
    assert.equal(failedSubmitted.json<Json>().data.inspectionResult.conclusion, "failed");
    assert.deepEqual(failedSubmitted.json<Json>().data.inspectionResult.failureDetails, failureDetails);
    assert.equal(failedSubmitted.json<Json>().data.inspectionResult.failureDetailsStatus, "complete");
    assert.equal(failedSubmitted.json<Json>().data.fulfillmentStatus, "completed");
    assert.equal(failedSubmitted.json<Json>().data.vehicleCheckupReport.faults.length, 0);
    assert.equal(failedSubmitted.json<Json>().data.vehicleCheckupReport.annualInspection.markStatus, "not_issued");
    assert.equal(failedSubmitted.json<Json>().data.vehicleCheckupReport.legalMaterials.safetyInspectionReport, null);
    assert.equal(failedSubmitted.json<Json>().data.vehicleCheckupReport.legalMaterials.emissionsInspectionReport, null);
    assert.equal(failedSubmitted.json<Json>().data.vehicleCheckupReport.legalMaterials.status, "available");
    assert.deepEqual(
      failedSubmitted.json<Json>().data.vehicleCheckupReport.annualInspection.failureDetails,
      failureDetails,
    );
    assert.ok(failedSubmitted.json<Json>().data.events.some(
      (event: Json) => event.title === "自驾年检服务已自动完成",
    ));

    const conditionalBookingId = "booking-op-5";
    const resolved = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${conditionalBookingId}/resolve-hold`,
      payload: { plateMatched: true, notes: "已完成车辆信息复核" },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal((await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${conditionalBookingId}/handoff`,
    })).statusCode, 200);

    const driftingRegionCode = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${conditionalBookingId}/checkup-report`,
      payload: {
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        faults: [{
          viewId: "right",
          regionCode: "right_rear_fender",
          faultType: "dent",
          severity: "minor",
        }],
      },
    });
    assert.equal(driftingRegionCode.statusCode, 400, driftingRegionCode.body);
    assert.equal(driftingRegionCode.json<Json>().error.code, "VALIDATION_ERROR");
    assert.ok(driftingRegionCode.json<Json>().error.fields["faults.0.regionCode"]);

    const conditionalDraft = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${conditionalBookingId}/checkup-report`,
      payload: {
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "conditional" },
        summary: { conclusionLabel: "有条件通过" },
        faults: [],
      },
    });
    assert.equal(conditionalDraft.statusCode, 400, conditionalDraft.body);
    assert.equal(conditionalDraft.json<Json>().error.code, "VALIDATION_ERROR");
    assert.ok(conditionalDraft.json<Json>().error.fields["annualInspection.conclusion"]);

    const conditionalSubmission = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${conditionalBookingId}/inspection-result`,
      headers: { "idempotency-key": "conditional-report-submit-0001" },
      payload: { conclusion: "conditional" },
    });
    assert.equal(conditionalSubmission.statusCode, 400, conditionalSubmission.body);
    assert.equal(conditionalSubmission.json<Json>().error.code, "VALIDATION_ERROR");

    const unchanged = await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${conditionalBookingId}`,
    });
    assert.equal(unchanged.json<Json>().data.fulfillmentStatus, "inspecting");
    assert.equal(unchanged.json<Json>().data.inspectionResult, null);
  } finally {
    await close();
  }
});

test("车辆体检 v2 稳定保存故障并以每故障 1 至 3 张特写闭环发布", async () => {
  const { app, database, close } = await fixture();
  try {
    const bookingId = "booking-op-3";
    const initial = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
      payload: {
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        summary: { conclusionLabel: "检验合格" },
        faults: [
          {
            clientKey: "local-fault-a",
            viewId: "left",
            regionCode: "left_front_door",
            faultType: "scratch",
            severity: "minor",
            description: "左前门划痕",
          },
          {
            clientKey: "local-fault-b",
            viewId: "right",
            regionCode: "right_rear_quarter",
            faultType: "dent",
            severity: "moderate",
            description: "右后翼子板凹陷",
          },
        ],
      },
    });
    assert.equal(initial.statusCode, 200, initial.body);
    const initialReport = initial.json<Json>().data;
    assert.equal(initialReport.schemaVersion, "vehicle-checkup-v2");
    assert.equal(initialReport.media.length, 0);
    assert.deepEqual(initialReport.faults.map((fault: Json) => fault.clientKey), ["local-fault-a", "local-fault-b"]);
    assert.ok(initialReport.faults.every((fault: Json) => fault.photos.length === 0));
    const firstFault = initialReport.faults[0];
    const secondFault = initialReport.faults[1];
    const clientKeyRetry = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
      payload: {
        rowVersion: initialReport.rowVersion,
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        summary: initialReport.summary,
        faults: initialReport.faults.map((fault: Json) => ({
          clientKey: fault.clientKey,
          viewId: fault.viewId,
          regionCode: fault.regionCode,
          faultType: fault.faultType,
          severity: fault.severity,
          description: fault.description,
        })),
      },
    });
    assert.equal(clientKeyRetry.statusCode, 200, clientKeyRetry.body);
    assert.deepEqual(
      clientKeyRetry.json<Json>().data.faults.map((fault: Json) => fault.id),
      [firstFault.id, secondFault.id],
    );

    const firstPhoto = await uploadFaultPhoto(app, bookingId, firstFault.id, {
      idempotencyKey: "fault-photo-idempotent-1",
    });
    assert.equal(firstPhoto.kind, "fault_closeup");
    assert.equal(firstPhoto.faultId, firstFault.id);
    assert.equal(firstPhoto.sequence, 1);
    assert.equal(Date.parse(firstPhoto.expiresAt) - Date.parse(firstPhoto.createdAt), 24 * 60 * 60 * 1000);
    const idempotentRetry = await requestFaultPhoto(app, bookingId, firstFault.id, {
      idempotencyKey: "fault-photo-idempotent-1",
    });
    assert.equal(idempotentRetry.statusCode, 200, idempotentRetry.body);
    assert.equal(idempotentRetry.json<Json>().data.id, firstPhoto.id);
    assert.equal(idempotentRetry.json<Json>().meta.idempotent, true);
    const conflictingRetry = await requestFaultPhoto(app, bookingId, firstFault.id, {
      image: alternateTestPng,
      idempotencyKey: "fault-photo-idempotent-1",
    });
    assert.equal(conflictingRetry.statusCode, 409, conflictingRetry.body);
    assert.equal(conflictingRetry.json<Json>().error.code, "IDEMPOTENCY_KEY_CONFLICT");

    const secondPhoto = await uploadFaultPhoto(app, bookingId, firstFault.id, {
      image: alternateTestPng,
      idempotencyKey: "fault-photo-append-2",
    });
    const thirdPhoto = await uploadFaultPhoto(app, bookingId, firstFault.id, {
      idempotencyKey: "fault-photo-append-3",
    });
    assert.deepEqual([secondPhoto.sequence, thirdPhoto.sequence], [2, 3]);
    const overLimit = await requestFaultPhoto(app, bookingId, firstFault.id, {
      image: alternateTestPng,
      idempotencyKey: "fault-photo-over-limit",
    });
    assert.equal(overLimit.statusCode, 409, overLimit.body);
    assert.equal(overLimit.json<Json>().error.code, "VEHICLE_CHECKUP_FAULT_PHOTO_LIMIT");

    const failedReplacement = await requestFaultPhoto(app, bookingId, firstFault.id, {
      image: alternateTestPng,
      idempotencyKey: "fault-photo-bad-replacement",
      replacePhotoId: "missing-photo",
    });
    assert.equal(failedReplacement.statusCode, 404, failedReplacement.body);
    let report = (await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
    })).json<Json>().data;
    assert.deepEqual(
      report.faults.find((fault: Json) => fault.id === firstFault.id).photos.map((photo: Json) => photo.id),
      [firstPhoto.id, secondPhoto.id, thirdPhoto.id],
    );

    const replacement = await requestFaultPhoto(app, bookingId, firstFault.id, {
      idempotencyKey: "fault-photo-replacement-ok",
      replacePhotoId: secondPhoto.id,
    });
    assert.equal(replacement.statusCode, 201, replacement.body);
    assert.equal(replacement.json<Json>().data.sequence, 2);
    assert.notEqual(replacement.json<Json>().data.id, secondPhoto.id);
    assert.equal((await app.inject({ method: "GET", url: secondPhoto.url })).statusCode, 404);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/operator/bookings/${bookingId}/checkup-report/faults/${firstFault.id}/photos/${thirdPhoto.id}`,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const deletionAudit = await database.prepare<Json>(`
      SELECT before_json, after_json, metadata_json FROM backoffice_audit_events
      WHERE action = 'booking.checkup_photo.delete' AND resource_id = ?
      ORDER BY occurred_at DESC LIMIT 1
    `).get(thirdPhoto.id);
    assert.ok(deletionAudit);
    assert.equal(JSON.stringify(deletionAudit).includes("storage_key"), false);
    const refilled = await uploadFaultPhoto(app, bookingId, firstFault.id, {
      image: alternateTestPng,
      idempotencyKey: "fault-photo-refill-slot",
    });
    assert.equal(refilled.sequence, 3);

    report = (await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
    })).json<Json>().data;
    const withTemporaryFault = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
      payload: {
        rowVersion: report.rowVersion,
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        summary: report.summary,
        faults: [
          ...report.faults.map((fault: Json) => ({
            id: fault.id,
            clientKey: fault.clientKey,
            viewId: fault.viewId,
            regionCode: fault.regionCode,
            faultType: fault.faultType,
            severity: fault.severity,
            description: fault.description,
          })),
          {
            clientKey: "local-fault-temporary",
            viewId: "top",
            regionCode: "hood",
            faultType: "paint_damage",
            severity: "minor",
            description: "临时记录",
          },
        ],
      },
    });
    assert.equal(withTemporaryFault.statusCode, 200, withTemporaryFault.body);
    const temporaryFault = withTemporaryFault.json<Json>().data.faults.find(
      (fault: Json) => fault.clientKey === "local-fault-temporary",
    );
    const temporaryPhoto = await uploadFaultPhoto(app, bookingId, temporaryFault.id, {
      idempotencyKey: "temporary-fault-photo",
    });
    const beforeRemoval = (await app.inject({
      method: "GET",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
    })).json<Json>().data;
    const reordered = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
      payload: {
        rowVersion: beforeRemoval.rowVersion,
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        summary: beforeRemoval.summary,
        faults: [secondFault, { ...firstFault, description: "左前门划痕，已复核" }],
      },
    });
    assert.equal(reordered.statusCode, 200, reordered.body);
    const reorderedFaults = reordered.json<Json>().data.faults;
    assert.deepEqual(reorderedFaults.map((fault: Json) => fault.id), [secondFault.id, firstFault.id]);
    assert.equal(reorderedFaults[1].photos.length, 3);
    assert.equal((await app.inject({ method: "GET", url: temporaryPhoto.url })).statusCode, 404);
    assert.equal(
      Number((await database.prepare<Json>(
        "SELECT COUNT(*) AS count FROM vehicle_checkup_faults WHERE id = ?",
      ).get(temporaryFault.id))!.count),
      0,
    );

    const tooManyFaults = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
      payload: {
        rowVersion: reordered.json<Json>().data.rowVersion,
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        faults: Array.from({ length: 21 }, (_, index) => ({
          clientKey: `limit-fault-${index}`,
          viewId: "top",
          regionCode: "hood",
          faultType: "scratch",
          severity: "minor",
        })),
      },
    });
    assert.equal(tooManyFaults.statusCode, 400, tooManyFaults.body);
    assert.ok(tooManyFaults.json<Json>().error.fields.faults);

    for (const kind of ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started", "safety_inspection_report", "annual_inspection_mark"]) {
      await uploadCheckupMedia(app, bookingId, kind);
    }
    const missingSecondFaultPhoto = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      headers: { "idempotency-key": "fault-photo-missing-result" },
      payload: {},
    });
    assert.equal(missingSecondFaultPhoto.statusCode, 409, missingSecondFaultPhoto.body);
    assert.equal(missingSecondFaultPhoto.json<Json>().error.code, "VEHICLE_CHECKUP_FAULT_PHOTOS_REQUIRED");
    const stillInspecting = await app.inject({ method: "GET", url: `/api/operator/bookings/${bookingId}` });
    assert.equal(stillInspecting.json<Json>().data.fulfillmentStatus, "inspecting");
    assert.equal(stillInspecting.json<Json>().data.vehicleCheckupReport.status, "draft");

    await database.prepare(`
      UPDATE bookings SET status = 'inspecting', fulfillment_status = 'inspecting'
      WHERE id = 'booking-op-4'
    `).run();
    const crossBookingUpload = await requestFaultPhoto(app, "booking-op-4", firstFault.id, {
      idempotencyKey: "cross-booking-fault-photo",
    });
    assert.equal(crossBookingUpload.statusCode, 404, crossBookingUpload.body);
    await uploadFaultPhoto(app, bookingId, secondFault.id, {
      idempotencyKey: "second-fault-required-photo",
    });

    const submitted = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/inspection-result`,
      headers: { "idempotency-key": "fault-photo-complete-result" },
      payload: {},
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const published = submitted.json<Json>().data.vehicleCheckupReport;
    assert.equal(published.status, "published");
    assert.equal(published.annualInspection.conclusion, "passed");
    assert.equal(published.annualInspection.failureDetails, null);
    assert.equal(published.annualInspection.failureDetailsStatus, "not_applicable");
    assert.equal(published.faults.length, 2);
    assert.equal(published.media.length, 7);
    assert.ok(published.legalMaterials.safetyInspectionReport);
    assert.equal(published.faults[0].photos.length, 1);
    assert.equal(published.faults[1].photos.length, 3);
    assert.ok(published.faults.flatMap((fault: Json) => fault.photos).every(
      (photo: Json) => photo.status === "bound" && photo.expiresAt === published.retainUntil,
    ));
    const immutableDelete = await app.inject({
      method: "DELETE",
      url: `/api/operator/bookings/${bookingId}/checkup-report/faults/${firstFault.id}/photos/${firstPhoto.id}`,
    });
    assert.equal(immutableDelete.statusCode, 409, immutableDelete.body);
    assert.equal(
      Number((await database.prepare<Json>(`
        SELECT COUNT(*) AS count FROM vehicle_checkup_media
        WHERE booking_id = ? AND kind = 'fault_closeup'
      `).get(bookingId))!.count),
      4,
    );
  } finally {
    await close();
  }
});

test("车主报告中心隔离草稿并按发布时间与报告号稳定分页", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const vehicles = [
      vehicle,
      await createVehicle(app, "津H·T8101"),
      await createVehicle(app, "津J·T8102"),
      await createVehicle(app, "津K·T8103"),
      await createVehicle(app, "津L·T8104"),
    ];
    const bookings: Json[] = [];
    for (const [index, currentVehicle] of vehicles.entries()) {
      const created = await createBooking(app, {
        vehicleId: currentVehicle.id,
        stationId: station.id,
        slotId: slots[index].id,
      });
      assert.equal(created.statusCode, 201, created.body);
      bookings.push(created.json<Json>().data);
    }

    const publishedAt = "2026-08-20T10:00:00.000Z";
    const retainUntil = "2032-08-20T10:00:00.000Z";
    const publishedFixtures = [
      {
        reportId: "owner-list-report-z",
        reportNo: "YXM-CHK-OWNER-Z",
        booking: bookings[0],
        conclusion: "passed",
        observationMode: "faults_recorded",
        markStatus: "issued",
      },
      {
        reportId: "owner-list-report-a",
        reportNo: "YXM-CHK-OWNER-A",
        booking: bookings[1],
        conclusion: "conditional",
        observationMode: "no_visible_faults",
        markStatus: "not_issued",
      },
    ];
    for (const item of publishedFixtures) {
      await database.prepare(`
        UPDATE bookings SET
          status = 'completed', fulfillment_status = 'completed', payment_status = 'paid',
          updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(publishedAt, publishedAt, item.booking.id);
      await database.prepare(`
        INSERT INTO vehicle_checkup_reports (
          id, booking_id, report_no, schema_version, status, observation_mode,
          diagram_version, annual_conclusion, annual_mark_status, summary_json,
          vehicle_snapshot_json, station_snapshot_json, row_version,
          created_at, updated_at, published_at, retain_until
        ) VALUES (?, ?, ?, 'vehicle-checkup-v2', 'published', ?,
          'sedan-3view-v1', ?, ?, '{}', '{}', '{}', 2, ?, ?, ?, ?)
      `).run(
        item.reportId,
        item.booking.id,
        item.reportNo,
        item.observationMode,
        item.conclusion,
        item.markStatus,
        publishedAt,
        publishedAt,
        publishedAt,
        retainUntil,
      );
    }

    await database.prepare(`
      INSERT INTO inspection_results (
        id, booking_id, external_result_id, conclusion, summary_json,
        source, received_at, idempotency_key, request_hash
      ) VALUES (
        'owner-list-legacy-conditional-result', ?, 'EXT-LEGACY-CONDITIONAL',
        'conditional', '{"conclusionLabel":"有条件通过"}', 'legacy_import', ?,
        'owner-list-legacy-conditional-key', 'owner-list-legacy-conditional-hash'
      )
    `).run(bookings[1].id, publishedAt);

    await database.prepare(`
      INSERT INTO vehicle_checkup_faults (
        id, report_id, client_key, sequence_no, view_id, region_code,
        fault_type, severity, description, created_at, updated_at
      ) VALUES (
        'owner-list-fault-1', 'owner-list-report-z', 'owner-list-fault-client-1',
        1, 'left', 'left_front_door', 'scratch', 'minor', '左前门轻微划痕', ?, ?
      )
    `).run(publishedAt, publishedAt);

    const insertReportMedia = async (
      reportId: string,
      bookingId: string,
      kind: string,
      sequence: number,
      faultId: string | null = null,
      faultSequence: number | null = null,
    ) => {
      await database.prepare(`
        INSERT INTO vehicle_checkup_media (
          id, booking_id, report_id, kind, fault_id, sequence_no, status,
          storage_key, mime_type, size_bytes, width, height, sha256,
          uploader_actor_type, created_at, bound_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'bound', ?, 'image/jpeg', 128, 12, 8, ?,
          'operator', ?, ?, ?)
      `).run(
        `${reportId}-media-${sequence}`,
        bookingId,
        reportId,
        kind,
        faultId,
        faultSequence,
        `${reportId}-media-${sequence}.jpg`,
        `${reportId}-sha-${sequence}`,
        publishedAt,
        publishedAt,
        retainUntil,
      );
    };
    const siteKinds = ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"];
    for (const [fixtureIndex, item] of publishedFixtures.entries()) {
      for (const [kindIndex, kind] of siteKinds.entries()) {
        await insertReportMedia(item.reportId, item.booking.id, kind, fixtureIndex * 10 + kindIndex + 1);
      }
    }
    await insertReportMedia(
      publishedFixtures[0].reportId,
      publishedFixtures[0].booking.id,
      "fault_closeup",
      6,
      "owner-list-fault-1",
      1,
    );
    await insertReportMedia(
      publishedFixtures[0].reportId,
      publishedFixtures[0].booking.id,
      "fault_closeup",
      7,
      "owner-list-fault-1",
      2,
    );
    await insertReportMedia(
      publishedFixtures[0].reportId,
      publishedFixtures[0].booking.id,
      "annual_inspection_mark",
      8,
    );
    await insertReportMedia(
      publishedFixtures[0].reportId,
      publishedFixtures[0].booking.id,
      "safety_inspection_report",
      9,
    );

    const draftReportId = "owner-list-draft-secret-id";
    await database.prepare(`
      INSERT INTO vehicle_checkup_reports (
        id, booking_id, report_no, schema_version, status, observation_mode,
        diagram_version, annual_conclusion, annual_mark_status, summary_json,
        vehicle_snapshot_json, station_snapshot_json, row_version,
        created_at, updated_at, published_at, retain_until
      ) VALUES (?, ?, 'YXM-CHK-DRAFT-SECRET', 'vehicle-checkup-v2', 'draft',
        'no_visible_faults', 'sedan-3view-v1', NULL, NULL, ?, '{}', '{}', 1,
        ?, ?, NULL, NULL)
    `).run(
      draftReportId,
      bookings[2].id,
      JSON.stringify({ privateDraftNote: "DRAFT-CONTENT-MUST-NOT-LEAK" }),
      "2026-08-20T09:00:00.000Z",
      "2026-08-20T09:00:00.000Z",
    );

    const missingReportAt = "2026-08-20T11:00:00.000Z";
    await database.prepare(`
      UPDATE bookings SET
        status = 'completed', fulfillment_status = 'completed', payment_status = 'paid',
        updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(missingReportAt, missingReportAt, bookings[3].id);
    await database.prepare(`
      INSERT INTO inspection_results (
        id, booking_id, external_result_id, conclusion, summary_json,
        source, received_at, idempotency_key, request_hash
      ) VALUES (
        'owner-list-result-missing-report', ?, 'EXT-OWNER-LIST-MISSING', 'failed',
        '{"conclusionLabel":"不合格"}', 'external_inspection_system', ?,
        'owner-list-result-missing-report-key', 'owner-list-result-missing-report-hash'
      )
    `).run(bookings[3].id, missingReportAt);

    const bypassedResultAt = "2026-08-20T12:00:00.000Z";
    await database.prepare(`
      UPDATE bookings SET
        status = 'completed', fulfillment_status = 'completed', payment_status = 'paid',
        updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(bypassedResultAt, bypassedResultAt, bookings[4].id);

    const firstPageResponse = await app.inject({
      method: "GET",
      url: "/api/vehicle-checkup-reports?limit=1",
    });
    assert.equal(firstPageResponse.statusCode, 200, firstPageResponse.body);
    const firstPage = firstPageResponse.json<Json>();
    assert.equal(firstPage.data.items.length, 1);
    assert.equal(firstPage.data.items[0].reportId, "owner-list-report-z");
    assert.equal(firstPage.data.items[0].faultCount, 1);
    assert.equal(firstPage.data.items[0].sitePhotoCount, 5);
    assert.equal(firstPage.data.items[0].faultPhotoCount, 2);
    assert.equal(firstPage.data.items[0].photoCount, 9);
    assert.equal(firstPage.data.items[0].hasAnnualMark, true);
    assert.equal(firstPage.data.items[0].hasSafetyInspectionReport, true);
    assert.equal(firstPage.data.items[0].legalMaterialsStatus, "available");
    assert.equal(firstPage.data.items[0].markStatus, "issued");
    const ownerPublishedReport = await app.inject({
      method: "GET",
      url: `/api/bookings/${publishedFixtures[0].booking.id}/checkup-report`,
    });
    assert.equal(ownerPublishedReport.statusCode, 200, ownerPublishedReport.body);
    const ownerSafetyReport = ownerPublishedReport.json<Json>().data.legalMaterials.safetyInspectionReport;
    assert.match(ownerSafetyReport.url, /^\/api\/bookings\//);
    assert.match(firstPage.meta.nextCursor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(
      new Set(firstPage.data.progress.map((item: Json) => item.bookingId)),
      new Set([bookings[2].id, bookings[3].id, bookings[4].id]),
    );
    assert.equal(
      firstPage.data.progress.find((item: Json) => item.bookingId === bookings[2].id).progressType,
      "booking_in_progress",
    );
    const resultPending = firstPage.data.progress.find((item: Json) => item.bookingId === bookings[3].id);
    assert.equal(resultPending.progressType, "result_pending_report");
    assert.equal(resultPending.conclusion, "failed");
    assert.equal(resultPending.reportReady, false);
    const legacyFailedDetail = await app.inject({
      method: "GET",
      url: `/api/bookings/${bookings[3].id}`,
    });
    assert.equal(legacyFailedDetail.statusCode, 200, legacyFailedDetail.body);
    assert.equal(
      legacyFailedDetail.json<Json>().data.inspectionResult.failureDetailsStatus,
      "legacy_missing_details",
    );
    assert.equal(legacyFailedDetail.json<Json>().data.inspectionResult.failureDetails, null);
    const bypassedResult = firstPage.data.progress.find((item: Json) => item.bookingId === bookings[4].id);
    assert.equal(bypassedResult.fulfillmentStatus, "completed");
    assert.equal(bypassedResult.progressType, "result_pending_report");
    assert.equal(bypassedResult.conclusion, null);
    assert.equal(bypassedResult.resultReceivedAt, null);
    assert.equal(bypassedResult.reportReady, false);
    assert.doesNotMatch(firstPageResponse.body, /DRAFT-CONTENT-MUST-NOT-LEAK|owner-list-draft-secret-id|YXM-CHK-DRAFT-SECRET/);

    const secondPageResponse = await app.inject({
      method: "GET",
      url: `/api/vehicle-checkup-reports?limit=1&cursor=${encodeURIComponent(firstPage.meta.nextCursor)}`,
    });
    assert.equal(secondPageResponse.statusCode, 200, secondPageResponse.body);
    const secondPage = secondPageResponse.json<Json>();
    assert.deepEqual(secondPage.data.items.map((item: Json) => item.reportId), ["owner-list-report-a"]);
    assert.equal(secondPage.data.items[0].conclusion, null);
    assert.equal(secondPage.data.items[0].conclusionStatus, "legacy_requires_reentry");
    assert.equal(secondPage.data.items[0].hasAnnualMark, false);
    assert.equal(secondPage.data.items[0].hasSafetyInspectionReport, false);
    assert.equal(secondPage.data.items[0].legalMaterialsStatus, "legacy_missing");
    assert.equal(secondPage.meta.nextCursor, null);

    const legacyOwnerDetail = await app.inject({
      method: "GET",
      url: `/api/bookings/${bookings[1].id}`,
    });
    assert.equal(legacyOwnerDetail.statusCode, 200, legacyOwnerDetail.body);
    assert.equal(legacyOwnerDetail.json<Json>().data.inspectionResult.conclusion, null);
    assert.equal(
      legacyOwnerDetail.json<Json>().data.inspectionResult.conclusionStatus,
      "legacy_requires_reentry",
    );
    assert.equal(
      legacyOwnerDetail.json<Json>().data.inspectionResult.summary.conclusionLabel,
      "历史结论待重新确认",
    );
    assert.equal(
      legacyOwnerDetail.json<Json>().data.vehicleCheckupReport.annualInspection.conclusion,
      null,
    );
    assert.equal(
      legacyOwnerDetail.json<Json>().data.vehicleCheckupReport.annualInspection.conclusionStatus,
      "legacy_requires_reentry",
    );
    assert.equal(
      legacyOwnerDetail.json<Json>().data.vehicleCheckupReport.legalMaterials.status,
      "legacy_missing",
    );

    const publishedVehicleOnly = await app.inject({
      method: "GET",
      url: `/api/vehicle-checkup-reports?vehicleId=${encodeURIComponent(vehicles[0].id)}`,
    });
    assert.deepEqual(
      publishedVehicleOnly.json<Json>().data.items.map((item: Json) => item.reportId),
      ["owner-list-report-z"],
    );
    assert.deepEqual(publishedVehicleOnly.json<Json>().data.progress, []);

    const activeVehicleOnly = await app.inject({
      method: "GET",
      url: `/api/vehicle-checkup-reports?vehicleId=${encodeURIComponent(vehicles[2].id)}`,
    });
    assert.deepEqual(activeVehicleOnly.json<Json>().data.items, []);
    assert.deepEqual(
      activeVehicleOnly.json<Json>().data.progress.map((item: Json) => item.bookingId),
      [bookings[2].id],
    );

    const invalidCursor = await app.inject({
      method: "GET",
      url: "/api/vehicle-checkup-reports?cursor=not-a-valid-cursor",
    });
    assert.equal(invalidCursor.statusCode, 400, invalidCursor.body);
    assert.equal(invalidCursor.json<Json>().error.code, "VEHICLE_CHECKUP_REPORT_CURSOR_INVALID");

    const otherOwner = await createDevelopmentSession(database, { userId: "checkup-list-other-owner" });
    const isolated = await app.inject({
      method: "GET",
      url: `/api/vehicle-checkup-reports?vehicleId=${encodeURIComponent(vehicles[0].id)}`,
      headers: { authorization: `Bearer ${otherOwner.token}` },
    });
    assert.equal(isolated.statusCode, 200, isolated.body);
    assert.deepEqual(isolated.json<Json>().data, { progress: [], items: [] });
  } finally {
    await close();
  }
});

test("车辆体检迁移可重复且已发布 v1 报告保持只读兼容", async () => {
  const { app, database, close } = await fixture();
  try {
    const bookingId = "booking-op-3";
    const publishedAt = "2026-08-10T10:00:00.000Z";
    await database.prepare(`
      INSERT INTO vehicle_checkup_reports (
        id, booking_id, report_no, schema_version, status, observation_mode,
        diagram_version, annual_conclusion, annual_mark_status, summary_json,
        vehicle_snapshot_json, station_snapshot_json, row_version,
        created_at, updated_at, published_at, retain_until
      ) VALUES (
        'legacy-checkup-report', ?, 'YXM-CHK-LEGACY', 'vehicle-checkup-v1',
        'published', 'faults_recorded', 'sedan-3view-v1', 'passed', 'issued',
        '{}', '{}', '{}', 2, ?, ?, ?, '2032-08-10T10:00:00.000Z'
      )
    `).run(bookingId, publishedAt, publishedAt, publishedAt);
    await database.prepare(`
      INSERT INTO vehicle_checkup_faults (
        id, report_id, client_key, sequence_no, view_id, region_code,
        fault_type, severity, description, created_at, updated_at
      ) VALUES (
        'legacy-checkup-fault', 'legacy-checkup-report', NULL, 1, 'left',
        'left_front_door', 'scratch', 'minor', '旧版现场文字记录', ?, ?
      )
    `).run(publishedAt, publishedAt);

    await migrateVehicleCheckupDatabase(database);
    await migrateVehicleCheckupDatabase(database);

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/bookings/${bookingId}/checkup-report`,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json<Json>().data.schemaVersion, "vehicle-checkup-v1");
    assert.equal(detail.json<Json>().data.faults[0].id, "legacy-checkup-fault");
    assert.deepEqual(detail.json<Json>().data.faults[0].photos, []);
    assert.equal(detail.json<Json>().data.media.length, 0);

    const editPublished = await app.inject({
      method: "PUT",
      url: `/api/operator/bookings/${bookingId}/checkup-report`,
      payload: {
        rowVersion: 2,
        observationMode: "faults_recorded",
        annualInspection: { conclusion: "passed" },
        faults: [{
          id: "legacy-checkup-fault",
          viewId: "left",
          regionCode: "left_front_door",
          faultType: "scratch",
          severity: "minor",
        }],
      },
    });
    assert.equal(editPublished.statusCode, 409, editPublished.body);
    assert.equal(editPublished.json<Json>().error.code, "VEHICLE_CHECKUP_REPORT_PUBLISHED");
  } finally {
    await close();
  }
});

test("信息不一致可挂起与恢复，核验不完整会阻止检测交接", async () => {
  const { app, database, close } = await fixture();
  try {
    const resolved = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-5/resolve-hold",
      payload: { plateMatched: true },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json<Json>().data.status, "checked_in");
    assert.equal(resolved.json<Json>().data.verification.plateMatched, true);

    const handoff = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-5/handoff",
    });
    assert.equal(handoff.statusCode, 200, handoff.body);
    assert.equal(handoff.json<Json>().data.status, "inspecting");

    const heldAgain = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-5/hold",
      payload: { reasonCode: "other", note: "等待检测线确认车辆可接收" },
    });
    assert.equal(heldAgain.statusCode, 200, heldAgain.body);
    assert.equal(heldAgain.json<Json>().data.status, "on_hold");

    const emptyResolve = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-5/resolve-hold",
      payload: {},
    });
    assert.equal(emptyResolve.statusCode, 400, emptyResolve.body);
    assert.equal(emptyResolve.json<Json>().error.code, "VALIDATION_ERROR");
    assert.ok(emptyResolve.json<Json>().error.fields._root);

    const latestHoldEvent = await database.prepare<Json>(`
      SELECT id, metadata_json FROM booking_events
      WHERE booking_id = 'booking-op-5' AND status = 'on_hold'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get();
    const holdMetadata = typeof latestHoldEvent?.metadata_json === "string"
      ? JSON.parse(latestHoldEvent.metadata_json)
      : latestHoldEvent?.metadata_json;
    assert.deepEqual(
      {
        previousStatus: holdMetadata.previousStatus,
        previousFulfillmentStatus: holdMetadata.previousFulfillmentStatus,
        serviceMode: holdMetadata.serviceMode,
      },
      { previousStatus: "inspecting", previousFulfillmentStatus: "inspecting", serviceMode: "self_drive" },
    );
    await database.prepare("UPDATE booking_events SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...holdMetadata, serviceMode: "valet" }), latestHoldEvent!.id);
    const incompatibleRestore = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-5/resolve-hold",
      payload: { notes: "错误服务方式不应恢复" },
    });
    assert.equal(incompatibleRestore.statusCode, 409, incompatibleRestore.body);
    assert.equal(incompatibleRestore.json<Json>().error.code, "BOOKING_HOLD_CONTEXT_INVALID");
    await database.prepare("UPDATE booking_events SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(holdMetadata), latestHoldEvent!.id);

    const restored = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-5/resolve-hold",
      payload: { notes: "已由站点人员复核，可恢复检测" },
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json<Json>().data.status, "inspecting");

    const incompleteCheckIn = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-1/check-in",
      payload: {
        plateMatched: true,
        materialsReady: false,
        exteriorRecorded: true,
        vehicleConditionConfirmed: true,
      },
    });
    assert.equal(incompleteCheckIn.statusCode, 200, incompleteCheckIn.body);
    const blocked = await app.inject({
      method: "POST",
      url: "/api/operator/bookings/booking-op-1/handoff",
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json<Json>().error.code, "VERIFICATION_INCOMPLETE");
  } finally {
    await close();
  }
});

test("历史自驾人工完成同样受待确认附加费与未支付费用门禁保护", async () => {
  const { app, database, close } = await fixture();
  try {
    const bookingId = "booking-op-6";
    const noteOnly = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: { fulfillmentStatus: "result_received", internalDriverNote: "历史订单仅补充协调备注" },
    });
    assert.equal(noteOnly.statusCode, 200, noteOnly.body);
    assert.equal(noteOnly.json<Json>().data.fulfillmentStatus, "result_received");
    const added = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${bookingId}`,
      payload: {
        adjustment: {
          amountFen: 500,
          reason: "历史单补录材料费",
          idempotencyKey: "legacy-complete-surcharge-0001",
        },
      },
    });
    assert.equal(added.statusCode, 200, added.body);
    const surcharge = added.json<Json>().data.ledgerEntries
      .find((entry: Json) => entry.idempotencyKey === "legacy-complete-surcharge-0001");

    const pending = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/complete`,
    });
    assert.equal(pending.statusCode, 409, pending.body);
    assert.equal(pending.json<Json>().error.code, "PENDING_SURCHARGE_CONFIRMATION");

    const owner = await createDevelopmentSession(database, { userId: "operator-user-6" });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/bookings/${bookingId}/ledger/${surcharge.id}/confirm`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { idempotencyKey: "legacy-complete-surcharge-confirm-0001" },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);

    const outstanding = await app.inject({
      method: "POST",
      url: `/api/operator/bookings/${bookingId}/complete`,
    });
    assert.equal(outstanding.statusCode, 409, outstanding.body);
    assert.equal(outstanding.json<Json>().error.code, "OUTSTANDING_PAYMENT");
  } finally {
    await close();
  }
});

test("未来号源容量不能低于已预约数且可随站点范围调整", async () => {
  const { app, database, close } = await fixture();
  try {
    const workbench = (await app.inject({ method: "GET", url: "/api/operator/workbench" })).json<Json>().data;
    const slots = (
      await app.inject({ method: "GET", url: "/api/stations/station-hexi-1/slots" })
    ).json<Json>().data;
    const futureSlot = slots.find((slot: Json) => slot.date > workbench.businessDate);
    await database.prepare("UPDATE station_slots SET booked_count = 2 WHERE id = ?").run(futureSlot.id);

    const belowBooked = await app.inject({
      method: "PATCH",
      url: `/api/operator/station-slots/${futureSlot.id}`,
      payload: { capacity: 1 },
    });
    assert.equal(belowBooked.statusCode, 409);
    assert.equal(belowBooked.json<Json>().error.code, "CAPACITY_BELOW_BOOKED");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/operator/station-slots/${futureSlot.id}`,
      payload: { capacity: 3 },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json<Json>().data.capacity, 3);
    assert.equal(updated.json<Json>().data.remaining, 1);

    const todayLocked = await app.inject({
      method: "PATCH",
      url: `/api/operator/station-slots/${workbench.pressure[0].slotId}`,
      payload: { capacity: 9 },
    });
    assert.equal(todayLocked.statusCode, 409);
    assert.equal(todayLocked.json<Json>().error.code, "SLOT_CAPACITY_LOCKED");

    const otherSlots = (
      await app.inject({ method: "GET", url: "/api/stations/station-nankai-1/slots" })
    ).json<Json>().data;
    const otherFutureSlot = otherSlots.find((slot: Json) => slot.date > workbench.businessDate);
    const crossStation = await app.inject({
      method: "PATCH",
      url: `/api/operator/station-slots/${otherFutureSlot.id}`,
      payload: { capacity: 9 },
    });
    assert.equal(crossStation.statusCode, 200, crossStation.body);
    assert.equal(crossStation.json<Json>().data.capacity, 9);
  } finally {
    await close();
  }
});

test("外部检测结果回传校验 HMAC、时间窗和幂等键", async () => {
  const { app, close } = await fixture();
  try {
    const payload = {
      bookingId: "booking-op-3",
      externalResultId: "EXT-HMAC-0001",
      conclusion: "passed",
      summary: { conclusionLabel: "检验合格", itemsPassed: 12, itemsTotal: 12 },
      source: "inspection-line-adapter",
      receivedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    };
    const invalid = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers: {
        "idempotency-key": "result-hmac-1",
        "x-yuxiaoman-timestamp": new Date().toISOString(),
        "x-yuxiaoman-signature": "sha256=invalid",
      },
      payload,
    });
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.json<Json>().error.code, "INVALID_INTEGRATION_SIGNATURE");

    const retiredConclusionPayload = { ...payload, conclusion: "conditional" };
    const retiredConclusion = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers: integrationHeaders(retiredConclusionPayload, "result-retired-conclusion"),
      payload: retiredConclusionPayload,
    });
    assert.equal(retiredConclusion.statusCode, 400, retiredConclusion.body);
    assert.equal(retiredConclusion.json<Json>().error.code, "VALIDATION_ERROR");
    assert.ok(retiredConclusion.json<Json>().error.fields.conclusion);

    const failedWithoutDetailsPayload = { ...payload, conclusion: "failed" };
    const failedWithoutDetails = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers: integrationHeaders(failedWithoutDetailsPayload, "result-failed-without-details"),
      payload: failedWithoutDetailsPayload,
    });
    assert.equal(failedWithoutDetails.statusCode, 400, failedWithoutDetails.body);
    assert.ok(failedWithoutDetails.json<Json>().error.fields.failureDetails);

    const previousEnvironment = process.env.YUXIAOMAN_ENV;
    const previousSecret = process.env.YUXIAOMAN_INTEGRATION_SECRET;
    try {
      process.env.YUXIAOMAN_ENV = "production";
      delete process.env.YUXIAOMAN_INTEGRATION_SECRET;
      const missingProductionSecret = await app.inject({
        method: "POST",
        url: "/api/integrations/inspection-results",
        headers: integrationHeaders(payload, "result-production-secret-missing"),
        payload,
      });
      assert.equal(missingProductionSecret.statusCode, 503, missingProductionSecret.body);
      assert.equal(missingProductionSecret.json<Json>().error.code, "INTEGRATION_SECRET_NOT_CONFIGURED");
    } finally {
      if (previousEnvironment === undefined) delete process.env.YUXIAOMAN_ENV;
      else process.env.YUXIAOMAN_ENV = previousEnvironment;
      if (previousSecret === undefined) delete process.env.YUXIAOMAN_INTEGRATION_SECRET;
      else process.env.YUXIAOMAN_INTEGRATION_SECRET = previousSecret;
    }

    await prepareCheckupReport(app, payload.bookingId);

    const staleDevicePayload = {
      ...payload,
      externalResultId: "EXT-HMAC-STALE-DEVICE",
      receivedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const staleDevice = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers: integrationHeaders(staleDevicePayload, "result-device-time-stale"),
      payload: staleDevicePayload,
    });
    assert.equal(staleDevice.statusCode, 400, staleDevice.body);
    assert.equal(staleDevice.json<Json>().error.code, "STALE_INSPECTION_DEVICE_TIME");

    const serverRequestStartedAt = Date.now();
    const headers = integrationHeaders(payload, "result-hmac-1");
    const received = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers,
      payload,
    });
    assert.equal(received.statusCode, 200, received.body);
    assert.equal(received.json<Json>().data.idempotent, false);
    assert.equal(received.json<Json>().data.booking.status, "completed");
    assert.equal(received.json<Json>().data.booking.inspectionResult.receivedAt, payload.receivedAt);
    const publishedReport = received.json<Json>().data.booking.vehicleCheckupReport;
    assert.ok(Date.parse(publishedReport.publishedAt) >= serverRequestStartedAt);
    assert.ok(Date.parse(publishedReport.publishedAt) > Date.parse(payload.receivedAt));
    assert.ok(Date.parse(publishedReport.retainUntil) >= serverRequestStartedAt + 6 * 365 * 24 * 60 * 60 * 1000);

    const retried = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers,
      payload,
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json<Json>().data.idempotent, true);

    const conflictingRetryPayload = {
      ...payload,
      summary: { ...payload.summary, itemsPassed: 11 },
    };
    const conflictingRetry = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers: integrationHeaders(conflictingRetryPayload, "result-hmac-1"),
      payload: conflictingRetryPayload,
    });
    assert.equal(conflictingRetry.statusCode, 409, conflictingRetry.body);
    assert.equal(conflictingRetry.json<Json>().error.code, "IDEMPOTENCY_KEY_CONFLICT");

    const duplicatePayload = { ...payload, externalResultId: "EXT-HMAC-0002" };
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers: integrationHeaders(duplicatePayload, "result-hmac-2"),
      payload: duplicatePayload,
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json<Json>().error.code, "DUPLICATE_INSPECTION_RESULT");

    const stalePayload = { ...payload, bookingId: "booking-op-2" };
    const staleTimestamp = "2020-01-01T00:00:00.000Z";
    const staleDigest = createHmac("sha256", "yuxiaoman-demo-integration-secret")
      .update(`${staleTimestamp}.${stableJson(stalePayload)}`)
      .digest("hex");
    const stale = await app.inject({
      method: "POST",
      url: "/api/integrations/inspection-results",
      headers: {
        "idempotency-key": "result-stale",
        "x-yuxiaoman-timestamp": staleTimestamp,
        "x-yuxiaoman-signature": `sha256=${staleDigest}`,
      },
      payload: stalePayload,
    });
    assert.equal(stale.statusCode, 401);
    assert.equal(stale.json<Json>().error.code, "STALE_INTEGRATION_SIGNATURE");
  } finally {
    await close();
  }
});

test("华洋真实站点置顶并使用站点往返取送覆盖规则", async () => {
  const { app, database, close } = await fixture();
  try {
    const publicStations = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data;
    const huayang = publicStations[0];
    assert.equal(huayang.id, HUAYANG_STATION_ID);
    assert.equal(huayang.legalName, "天津市华洋机动车检测有限公司");
    assert.equal(huayang.address, "天津自贸试验区（天津港保税区）海滨大道3680号");
    assert.equal(huayang.mapPoiId, "10292096120912059203");
    assert.equal(huayang.isPinned, true);
    assert.equal(huayang.weeklySchedule.sat.length, 0);
    assert.equal(huayang.weeklySchedule.sun[0].start, "08:00");
    assert.equal(huayang.internalContact, undefined);
    const adminHuayang = (await app.inject({ method: "GET", url: "/api/admin/stations" })).json<Json>().data[0];
    assert.equal(adminHuayang.internalContact.name, "孙磊");
    assert.equal(adminHuayang.internalContact.phone, "15332115222");
    assert.equal(adminHuayang.isPinned, true);
    const editableStation = {
      name: adminHuayang.name,
      legalName: adminHuayang.legalName,
      district: adminHuayang.district,
      address: adminHuayang.address,
      latitude: adminHuayang.latitude,
      longitude: adminHuayang.longitude,
      openHours: adminHuayang.openHours,
      phone: adminHuayang.phone,
      isActive: adminHuayang.isActive,
      dataKind: adminHuayang.dataKind,
      isDirectOperated: adminHuayang.isDirectOperated,
      mapPoiId: adminHuayang.mapPoiId,
      weeklySchedule: adminHuayang.weeklySchedule,
      businessHoursNotice: adminHuayang.businessHoursNotice,
      internalContact: adminHuayang.internalContact,
    };
    const protectedPin = await app.inject({ method: "PUT", url: `/api/admin/stations/${HUAYANG_STATION_ID}`, payload: {
      ...editableStation, isPinned: false, sortPriority: adminHuayang.sortPriority,
    } });
    assert.equal(protectedPin.statusCode, 409, protectedPin.body);
    assert.equal(protectedPin.json<Json>().error.code, "DIRECT_STATION_PIN_REQUIRED");

    const adminDemo = (await app.inject({ method: "GET", url: "/api/admin/stations" })).json<Json>().data
      .find((item: Json) => item.id === DEMO_STATION_ID);
    const editableDemo = {
      name: adminDemo.name, legalName: adminDemo.legalName, district: adminDemo.district,
      address: adminDemo.address, latitude: adminDemo.latitude, longitude: adminDemo.longitude,
      openHours: adminDemo.openHours, phone: adminDemo.phone, isActive: adminDemo.isActive,
      dataKind: adminDemo.dataKind, isDirectOperated: adminDemo.isDirectOperated,
      mapPoiId: adminDemo.mapPoiId, weeklySchedule: adminDemo.weeklySchedule,
      businessHoursNotice: adminDemo.businessHoursNotice, internalContact: adminDemo.internalContact,
    };
    const reprioritized = await app.inject({ method: "PUT", url: `/api/admin/stations/${DEMO_STATION_ID}`, payload: {
      ...editableDemo, isPinned: false, sortPriority: 25,
    } });
    assert.equal(reprioritized.statusCode, 200, reprioritized.body);
    assert.equal(reprioritized.json<Json>().data.isPinned, false);
    assert.equal(reprioritized.json<Json>().data.sortPriority, 25);
    const pinOnly = await app.inject({ method: "PUT", url: `/api/admin/stations/${DEMO_STATION_ID}`, payload: {
      ...editableDemo, isPinned: true, sortPriority: 25,
    } });
    assert.equal(pinOnly.statusCode, 200, pinOnly.body);
    assert.equal(pinOnly.json<Json>().data.isPinned, true);
    assert.equal(pinOnly.json<Json>().data.sortPriority, 25);
    await seedDemoData(database);
    const afterRestartSeed = (await app.inject({ method: "GET", url: "/api/admin/stations" })).json<Json>().data
      .find((item: Json) => item.id === DEMO_STATION_ID);
    assert.equal(afterRestartSeed.isPinned, true);
    assert.equal(afterRestartSeed.sortPriority, 25);
    const stillHuayangFirst = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data;
    assert.equal(stillHuayangFirst[0].id, HUAYANG_STATION_ID);

    const globalRule = (await app.inject({ method: "GET", url: "/api/admin/valet-rules" })).json<Json>().data;
    assert.equal(globalRule.baseFeeFen, 10900);
    assert.equal(globalRule.includedKm, 10);
    assert.equal(globalRule.perKmFen, 800);
    assert.equal(globalRule.maxRadiusKm, null);
    await migrateDatabase(database);
    const globalRuleAfterRestartMigration = (
      await app.inject({ method: "GET", url: "/api/admin/valet-rules" })
    ).json<Json>().data;
    assert.equal(globalRuleAfterRestartMigration.maxRadiusKm, null);

    const stationRule = (await app.inject({ method: "GET", url: `/api/admin/stations/${HUAYANG_STATION_ID}/valet-rule` })).json<Json>().data;
    assert.equal(stationRule.mode, "override");
    assert.equal(stationRule.resolvedRule.scope, "station");
    assert.equal(stationRule.resolvedRule.baseFeeFen, 9900);

    const override = await app.inject({ method: "PUT", url: `/api/admin/stations/${DEMO_STATION_ID}/valet-rule`, payload: {
      baseFeeFen: 8800, includedKm: 8, perKmFen: 700, maxRadiusKm: null,
    } });
    assert.equal(override.statusCode, 200, override.body);
    assert.equal(override.json<Json>().data.scope, "station");
    const inherited = await app.inject({ method: "DELETE", url: `/api/admin/stations/${DEMO_STATION_ID}/valet-rule` });
    assert.equal(inherited.statusCode, 200, inherited.body);
    assert.equal(inherited.json<Json>().data.resolvedRule.scope, "global");

    await database.prepare("DELETE FROM station_valet_pricing_overrides WHERE station_id = ?").run(HUAYANG_STATION_ID);
    await database.prepare(`
      DELETE FROM station_inspection_price_plans
      WHERE station_id = ? AND plan_id = 'plan-small-ice-1-6'
    `).run(DEMO_STATION_ID);
    const seededSlot = await database.prepare<{ id: string }>(`
      SELECT id FROM station_slots WHERE station_id = ? AND booked_count = 0
      ORDER BY date, start_time LIMIT 1
    `).get(HUAYANG_STATION_ID);
    assert.ok(seededSlot);
    const deletedSeededSlot = await app.inject({
      method: "DELETE",
      url: `/api/admin/station-slots/${seededSlot.id}`,
    });
    assert.equal(deletedSeededSlot.statusCode, 200, deletedSeededSlot.body);
    await seedDemoData(database);
    assert.equal(
      Number((await database.prepare<{ count: string }>("SELECT COUNT(*) AS count FROM station_valet_pricing_overrides WHERE station_id = ?")
        .get(HUAYANG_STATION_ID))?.count),
      0,
    );
    assert.equal(
      Number((await database.prepare<{ count: string }>(`
        SELECT COUNT(*) AS count FROM station_inspection_price_plans
        WHERE station_id = ? AND plan_id = 'plan-small-ice-1-6'
      `).get(DEMO_STATION_ID))?.count),
      0,
    );
    assert.equal(
      Number((await database.prepare<{ count: string }>("SELECT COUNT(*) AS count FROM station_slots WHERE id = ?").get(seededSlot.id))?.count),
      0,
    );
  } finally {
    await close();
  }
});

test("检测站后台位置必须来自可信地址候选且编辑默认保留原定位", async () => {
  const { app, close } = await fixture();
  try {
    const firstSuggestions = await app.inject({
      method: "GET",
      url: "/api/locations/suggestions?query=文化中心",
    });
    assert.equal(firstSuggestions.statusCode, 200, firstSuggestions.body);
    const firstLocation = firstSuggestions.json<Json>().data[0];
    assert.ok(firstLocation);
    assert.match(firstLocation.locationProof, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const stationPayload = {
      name: "可信定位测试检测站（演示）",
      legalName: null,
      openHours: "08:30-17:00",
      phone: "022-0000-2001",
      isActive: true,
      dataKind: "demo",
      isDirectOperated: false,
      isPinned: false,
      sortPriority: -20,
      weeklySchedule: {
        mon: [{ start: "08:30", end: "17:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      },
      businessHoursNotice: null,
      internalContact: null,
    };

    const missingLocation = await app.inject({
      method: "POST",
      url: "/api/admin/stations",
      payload: {
        ...stationPayload,
        name: "缺失定位测试检测站（演示）",
        district: "伪造区",
        address: "伪造地址 1 号",
        latitude: 39.12,
        longitude: 117.2,
        mapPoiId: "forged-poi",
      },
    });
    assert.equal(missingLocation.statusCode, 400, missingLocation.body);
    assert.equal(missingLocation.json<Json>().error.code, "STATION_LOCATION_REQUIRED");

    const tamperedLocation = await app.inject({
      method: "POST",
      url: "/api/admin/stations",
      payload: {
        ...stationPayload,
        name: "篡改定位测试检测站（演示）",
        location: { ...firstLocation, address: `${firstLocation.address}（已篡改）` },
      },
    });
    assert.equal(tamperedLocation.statusCode, 409, tamperedLocation.body);
    assert.equal(tamperedLocation.json<Json>().error.code, "STATION_LOCATION_PROOF_INVALID");

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/admin/stations",
      payload: {
        ...stationPayload,
        location: firstLocation,
        district: "伪造区",
        address: "伪造地址 2 号",
        latitude: 38.5,
        longitude: 116.7,
        mapPoiId: "forged-poi",
      },
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = createdResponse.json<Json>().data;
    assert.equal(created.district, firstLocation.district);
    assert.equal(created.address, firstLocation.address);
    assert.equal(created.latitude, firstLocation.latitude);
    assert.equal(created.longitude, firstLocation.longitude);
    assert.equal(created.mapPoiId, firstLocation.poiId);

    const preservedResponse = await app.inject({
      method: "PUT",
      url: `/api/admin/stations/${created.id}`,
      payload: {
        ...stationPayload,
        name: created.name,
        businessHoursNotice: "只修改非位置字段",
        district: "伪造区",
        address: "伪造地址 3 号",
        latitude: 40.2,
        longitude: 118.1,
        mapPoiId: "forged-poi-2",
      },
    });
    assert.equal(preservedResponse.statusCode, 200, preservedResponse.body);
    const preserved = preservedResponse.json<Json>().data;
    assert.equal(preserved.businessHoursNotice, "只修改非位置字段");
    assert.equal(preserved.district, firstLocation.district);
    assert.equal(preserved.address, firstLocation.address);
    assert.equal(preserved.latitude, firstLocation.latitude);
    assert.equal(preserved.longitude, firstLocation.longitude);
    assert.equal(preserved.mapPoiId, firstLocation.poiId);

    const secondSuggestions = await app.inject({
      method: "GET",
      url: "/api/locations/suggestions?query=天津站",
    });
    assert.equal(secondSuggestions.statusCode, 200, secondSuggestions.body);
    const secondLocation = secondSuggestions.json<Json>().data[0];
    assert.ok(secondLocation);
    assert.notEqual(secondLocation.poiId, firstLocation.poiId);

    const relocatedResponse = await app.inject({
      method: "PUT",
      url: `/api/admin/stations/${created.id}`,
      payload: {
        ...stationPayload,
        name: created.name,
        location: secondLocation,
        district: "另一个伪造区",
        address: "另一个伪造地址",
        latitude: 38.6,
        longitude: 116.8,
        mapPoiId: "forged-poi-3",
      },
    });
    assert.equal(relocatedResponse.statusCode, 200, relocatedResponse.body);
    const relocated = relocatedResponse.json<Json>().data;
    assert.equal(relocated.district, secondLocation.district);
    assert.equal(relocated.address, secondLocation.address);
    assert.equal(relocated.latitude, secondLocation.latitude);
    assert.equal(relocated.longitude, secondLocation.longitude);
    assert.equal(relocated.mapPoiId, secondLocation.poiId);
  } finally {
    await close();
  }
});

test("检测站后台在生产环境拒绝带有效签名的演示位置", async () => {
  const originalEnvironment = process.env.YUXIAOMAN_ENV;
  const originalProofSecret = process.env.WASH_LOCATION_PROOF_SECRET;
  const originalBackofficeOrigins = process.env.BACKOFFICE_ALLOWED_ORIGINS;
  const { app, close } = await fixture();
  try {
    process.env.YUXIAOMAN_ENV = "production";
    process.env.WASH_LOCATION_PROOF_SECRET = "station-location-production-test-secret-2026";
    process.env.BACKOFFICE_ALLOWED_ORIGINS = "https://admin.example.test";
    const demoLocation = {
      poiId: "demo-station-production-forbidden",
      title: "生产环境演示检测站",
      address: "和平区演示地址 2 号",
      district: "和平区",
      latitude: 39.12,
      longitude: 117.2,
      source: "demo" as const,
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/stations",
      headers: { origin: "https://admin.example.test" },
      payload: {
        name: "生产环境演示定位测试检测站",
        location: { ...demoLocation, locationProof: createWashLocationProof(demoLocation) },
        legalName: null,
        openHours: "08:30-17:00",
        phone: null,
        isActive: true,
        dataKind: "demo",
        isDirectOperated: false,
        isPinned: false,
        sortPriority: 0,
        weeklySchedule: {},
        businessHoursNotice: null,
        internalContact: null,
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json<Json>().error.code, "STATION_LOCATION_PROOF_INVALID");
  } finally {
    if (originalEnvironment === undefined) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = originalEnvironment;
    if (originalProofSecret === undefined) delete process.env.WASH_LOCATION_PROOF_SECRET;
    else process.env.WASH_LOCATION_PROOF_SECRET = originalProofSecret;
    if (originalBackofficeOrigins === undefined) delete process.env.BACKOFFICE_ALLOWED_ORIGINS;
    else process.env.BACKOFFICE_ALLOWED_ORIGINS = originalBackofficeOrigins;
    await close();
  }
});

test("华洋 11.7km 腾讯单程路线按整公里向上计为 115 元并形成 375 元总价", async () => {
  const { app, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 11_700, duration: 1_620 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const vehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];
    const quoted = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicle.id,
      stationId: HUAYANG_STATION_ID,
      serviceMode: "valet",
      tripType: "round_trip_same_address",
      pickupAddress: {
        poiId: "10211326219766907812",
        title: "天津站",
        address: "天津市河东区新纬路1号",
        district: "河东区",
        latitude: 39.135671,
        longitude: 117.20965,
        source: "tencent",
      },
    } });
    assert.equal(quoted.statusCode, 200, quoted.body);
    const quote = quoted.json<Json>().data;
    assert.equal(quote.serviceScope, "round_trip_same_address");
    assert.equal(quote.distanceSource, "tencent_matrix");
    assert.equal(quote.oneWayDistanceKm, 11.7);
    assert.equal(quote.driveMinutes, 27);
    assert.equal(quote.rule.baseFeeFen, 9900);
    assert.equal(quote.rule.includedKm, 10);
    assert.equal(quote.rule.perKmFen, 800);
    assert.equal(quote.rule.maxRadiusKm, null);
    assert.equal(quote.extraKm, 2);
    assert.equal(quote.valetFeeFen, 11500);
    assert.equal(quote.inspectionFeeFen, 26000);
    assert.equal(quote.serviceFeeFen, 37500);
  } finally {
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    globalThis.fetch = originalFetch;
    await close();
  }
});

test("多轴价格方案按实际动力筛选检验项目并将未支持车型转人工确认", async () => {
  const { app, close } = await fixture();
  try {
    const stations = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data;
    const huayang = stations.find((item: Json) => item.id === HUAYANG_STATION_ID);
    const pureSeven = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津A·D12345", vehicleType: "7 座纯电乘用车", usageNature: "非营运", seats: 7,
      powertrainType: "pure_electric",
      registrationDate: "2020-01-01", inspectionDueDate: "2027-01-01",
    } });
    assert.equal(pureSeven.statusCode, 201, pureSeven.body);
    assert.equal(pureSeven.json<Json>().data.facts.powertrainType, "pure_electric");
    const pureQuote = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: pureSeven.json<Json>().data.id, stationId: huayang.id, serviceMode: "self_drive",
    } });
    assert.equal(pureQuote.statusCode, 200, pureQuote.body);
    const quote = pureQuote.json<Json>().data;
    assert.equal(quote.pricingEligibility, "supported");
    assert.equal(quote.inspectionFeeFen, 30000);
    assert.equal(quote.vehicleFacts.powertrainType, "pure_electric");
    assert.ok(quote.inspectionItems.includes("new_energy_safety"));
    assert.ok(!quote.inspectionItems.some((item: string) => item.startsWith("emissions_")));

    const demoVehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];
    const gasolineQuote = (await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: demoVehicle.id, stationId: huayang.id, serviceMode: "self_drive",
    } })).json<Json>().data;
    assert.ok(gasolineQuote.inspectionItems.includes("emissions_gasoline"));
    assert.ok(!gasolineQuote.inspectionItems.includes("emissions_diesel"));
    assert.ok(!gasolineQuote.inspectionItems.includes("new_energy_safety"));

    const diesel = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津C·D7002", vehicleType: "小型柴油乘用车", usageNature: "非营运", seats: 5,
      powertrainType: "diesel", registrationDate: "2020-01-01", inspectionDueDate: "2027-01-01",
    } });
    assert.equal(diesel.statusCode, 201, diesel.body);
    const dieselQuote = (await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: diesel.json<Json>().data.id, stationId: huayang.id, serviceMode: "self_drive",
    } })).json<Json>().data;
    assert.ok(dieselQuote.inspectionItems.includes("emissions_diesel"));
    assert.ok(!dieselQuote.inspectionItems.includes("emissions_gasoline"));

    const plugIn = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津D·F70021", vehicleType: "插电式混合动力乘用车", usageNature: "非营运", seats: 5,
      powertrainType: "phev", registrationDate: "2020-01-01", inspectionDueDate: "2027-01-01",
    } });
    assert.equal(plugIn.statusCode, 201, plugIn.body);
    const plugInQuote = (await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: plugIn.json<Json>().data.id, stationId: huayang.id, serviceMode: "self_drive",
    } })).json<Json>().data;
    assert.ok(plugInQuote.inspectionItems.includes("new_energy_safety"));
    assert.ok(plugInQuote.inspectionItems.includes("emissions_gasoline"));
    assert.ok(!plugInQuote.inspectionItems.includes("emissions_diesel"));

    const unsupported = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津B·T7002", vehicleType: "营运客车", usageNature: "营运", seats: 9,
      registrationDate: "2020-01-01", inspectionDueDate: "2027-01-01",
    } });
    assert.equal(unsupported.statusCode, 201, unsupported.body);
    const manualQuote = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: unsupported.json<Json>().data.id, stationId: huayang.id, serviceMode: "self_drive",
    } });
    assert.equal(manualQuote.statusCode, 200, manualQuote.body);
    assert.equal(manualQuote.json<Json>().data.pricingEligibility, "manual_review");
    assert.equal(manualQuote.json<Json>().data.reason, "manual_review");
    assert.equal(manualQuote.json<Json>().data.serviceable, false);
  } finally {
    await close();
  }
});

test("腾讯配额错误阻止代驾报价并反映在健康状态", async () => {
  const { app, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 121, message: "此key每日调用量已达到上限" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const { vehicle, station } = await seedContext(app);
    const response = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicle.id,
      stationId: station.id,
      serviceMode: "valet",
      tripType: "round_trip_same_address",
      pickupAddress: { poiId: "quota", title: "天津站", address: "天津市河北区", district: "河北区", latitude: 39.135671, longitude: 117.20965, source: "tencent" },
    } });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json<Json>().error.code, "REAL_ROUTE_REQUIRED");
    assert.equal(response.json<Json>().error.fields.mapErrorCode, "TENCENT_QUOTA_EXCEEDED");
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json<Json>().data;
    assert.equal(health.map.status, "quota_exceeded");
    assert.equal(health.map.lastErrorCode, "TENCENT_QUOTA_EXCEEDED");
    assert.ok(!JSON.stringify(health).includes("test-key"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("价格方案 CRUD 与站点 pricePlans 契约可独立维护", async () => {
  const { app, database, close } = await fixture();
  try {
    const plans = (await app.inject({ method: "GET", url: "/api/admin/inspection-price-plans" })).json<Json>().data;
    assert.ok(plans.length >= 5);
    const invalidPure = await app.inject({ method: "POST", url: "/api/admin/inspection-price-plans", payload: {
      code: "invalid_pure", name: "错误纯电方案", description: "不得包含尾气",
      powertrainTypes: ["pure_electric"], minSeats: 1, maxSeats: 6,
      usageNatures: ["非营运"], vehicleClassCodes: ["passenger_car"], excludeVans: true,
      inspectionItems: ["safety_basic", "emissions_gasoline"], sortOrder: 99, isActive: true,
    } });
    assert.equal(invalidPure.statusCode, 400, invalidPure.body);

    const createdPlan = await app.inject({ method: "POST", url: "/api/admin/price-plans", payload: {
      code: "other_manual_supported", name: "其他动力试点方案", description: "API 测试方案",
      powertrainTypes: ["other"], minSeats: 1, maxSeats: 6,
      usageNatures: ["非营运"], vehicleClassCodes: ["passenger_car"], excludeVans: true,
      inspectionItems: ["safety_basic"], sortOrder: 90, isActive: true,
    } });
    assert.equal(createdPlan.statusCode, 201, createdPlan.body);
    const plan = createdPlan.json<Json>().data;
    const updatedPlan = await app.inject({ method: "PUT", url: `/api/admin/price-plans/${plan.id}`, payload: {
      ...plan,
      name: "其他动力试点方案（已更新）",
      inspectionItems: ["safety_basic", "safety_chassis_extended"],
    } });
    assert.equal(updatedPlan.statusCode, 200, updatedPlan.body);
    const stationLocationResponse = await app.inject({
      method: "GET",
      url: "/api/locations/suggestions?query=文化中心",
    });
    assert.equal(stationLocationResponse.statusCode, 200, stationLocationResponse.body);
    const stationLocation = stationLocationResponse.json<Json>().data[0];
    const createdStation = await app.inject({ method: "POST", url: "/api/admin/stations", payload: {
      id: "station-api-test", name: "API 测试站", location: stationLocation,
      openHours: "08:00-17:00", phone: null, isActive: true,
      dataKind: "demo", isDirectOperated: false, sortPriority: -10,
      pricePlans: [{ planId: plan.id, isSupported: true, priceFen: 12300 }],
    } });
    assert.equal(createdStation.statusCode, 201, createdStation.body);
    assert.deepEqual(createdStation.json<Json>().data.pricePlans.map((item: Json) => ({ planId: item.planId, isSupported: item.isSupported, priceFen: item.priceFen })), [
      { planId: plan.id, isSupported: true, priceFen: 12300 },
    ]);
    const createdSlot = await app.inject({ method: "POST", url: "/api/admin/stations/station-api-test/slots", payload: {
      date: "2026-08-20", startTime: "09:00", endTime: "10:00", capacity: 3,
    } });
    assert.equal(createdSlot.statusCode, 201, createdSlot.body);
    assert.equal(createdSlot.json<Json>().data.bookedCount, 0);
    const updatedSlot = await app.inject({ method: "PUT", url: `/api/admin/station-slots/${createdSlot.json<Json>().data.id}`, payload: {
      date: "2026-08-20", startTime: "09:30", endTime: "10:30", capacity: 5,
    } });
    assert.equal(updatedSlot.statusCode, 200, updatedSlot.body);
    assert.equal(updatedSlot.json<Json>().data.capacity, 5);
    const deletedSlot = await app.inject({ method: "DELETE", url: `/api/admin/station-slots/${createdSlot.json<Json>().data.id}` });
    assert.equal(deletedSlot.statusCode, 200, deletedSlot.body);
    assert.equal(deletedSlot.json<Json>().data.deleted, true);
    const savedStation = await app.inject({ method: "PUT", url: "/api/admin/stations/station-api-test/price-plans", payload: {
      pricePlans: [{ planId: plan.id, isSupported: false, priceFen: 12500 }],
    } });
    assert.equal(savedStation.statusCode, 200, savedStation.body);
    assert.equal(savedStation.json<Json>().data.pricePlans[0].isSupported, false);
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/inspection-price-plans/${plan.id}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const preserveInactiveLink = await app.inject({ method: "PUT", url: "/api/admin/stations/station-api-test/price-plans", payload: {
      pricePlans: [{ planId: plan.id, isSupported: false, priceFen: 12500 }],
    } });
    assert.equal(preserveInactiveLink.statusCode, 200, preserveInactiveLink.body);
    const semanticActions = (await database.prepare<Json>(`
      SELECT action, metadata_json FROM backoffice_audit_events
      WHERE action LIKE 'inspection.%' ORDER BY occurred_at, id
    `).all()).map((event: Json) => event.action);
    for (const action of [
      "inspection.price_plan.create",
      "inspection.price_plan.update",
      "inspection.station.create",
      "inspection.slot.create",
      "inspection.slot.update",
      "inspection.slot.delete",
      "inspection.station_offers.update",
      "inspection.price_plan.disable",
    ]) {
      assert.ok(semanticActions.includes(action), `缺少语义审计 ${action}`);
    }
    assert.equal(semanticActions.filter((action: string) => action === "inspection.station_offers.update").length, 1);
  } finally {
    await close();
  }
});

test("模拟支付幂等确认并维护附加费、退款、履约状态和内部司机备注", async () => {
  const { app, database, close } = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    assert.equal(booking.paymentStatus, "unpaid");
    assert.equal(booking.fulfillmentStatus, "pending_payment");
    const pendingFilter = await app.inject({ method: "GET", url: "/api/admin/bookings?status=pending_payment" });
    assert.ok(pendingFilter.json<Json>().data.some((item: Json) => item.id === booking.id));
    const missingConfirmedQuote = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: { provider: "mock", idempotencyKey: "pay-without-quote-0001" },
    });
    assert.equal(missingConfirmedQuote.statusCode, 409, missingConfirmedQuote.body);
    assert.equal(missingConfirmedQuote.json<Json>().error.code, "PAYMENT_QUOTE_REQUIRED");
    assert.equal(Number((await database.prepare<Json>(
      "SELECT COUNT(*) AS count FROM booking_payments WHERE booking_id = ?",
    ).get(booking.id))?.count), 0);
    const first = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "pay-api-test-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json<Json>().data.booking.paymentStatus, "paid");
    assert.equal(first.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    const duplicate = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "pay-api-test-0001",
    } });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json<Json>().data.payment.id, first.json<Json>().data.payment.id);
    assert.equal(duplicate.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    assert.equal(duplicate.json<Json>().data.booking.events.filter((event: Json) => event.title === "支付已确认").length, 1);

    await database.prepare("UPDATE bookings SET fulfillment_status = 'paid_pending_confirmation' WHERE id = ?").run(booking.id);
    await migrateDatabase(database);
    const migrated = await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` });
    assert.equal(migrated.statusCode, 200, migrated.body);
    assert.equal(migrated.json<Json>().data.fulfillmentStatus, "confirmed");
    assert.ok(migrated.json<Json>().data.events.some((event: Json) => event.title === "预约已自动确认"));

    const updated = await app.inject({ method: "PATCH", url: `/api/admin/bookings/${booking.id}`, payload: {
      internalDriverNote: "司机到达前 15 分钟联系",
      adjustment: { amountFen: 1000, reason: "夜间服务附加费", idempotencyKey: "ledger-extra-0001" },
      refund: { amountFen: 500, reason: "体验补偿", idempotencyKey: "ledger-refund-0001" },
    } });
    assert.equal(updated.statusCode, 200, updated.body);
    const data = updated.json<Json>().data;
    assert.equal(data.fulfillmentStatus, "confirmed");
    assert.equal(data.internalDriverNote, "司机到达前 15 分钟联系");
    assert.equal(data.paymentStatus, "partially_refunded");
    assert.equal(data.amountDueFen, 0);
    assert.equal(data.pendingAdjustmentFen, 1000);
    const surcharge = data.ledgerEntries.find((entry: Json) => entry.kind === "surcharge" && entry.amountFen === 1000);
    assert.equal(surcharge.confirmationStatus, "pending_owner_confirmation");
    assert.ok(data.ledgerEntries.some((entry: Json) => entry.kind === "refund" && entry.amountFen === -500));
    const confirmedSurcharge = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/ledger/${surcharge.id}/confirm`, payload: {
      idempotencyKey: "confirm-extra-0001",
    } });
    assert.equal(confirmedSurcharge.statusCode, 200, confirmedSurcharge.body);
    assert.equal(confirmedSurcharge.json<Json>().data.booking.amountDueFen, 1000);
    assert.equal(confirmedSurcharge.json<Json>().data.ledgerEntry.confirmationStatus, "confirmed");
    const duplicateConfirmation = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/ledger/${surcharge.id}/confirm`, payload: {
      idempotencyKey: "confirm-extra-0001",
    } });
    assert.equal(duplicateConfirmation.statusCode, 200, duplicateConfirmation.body);
    assert.equal(duplicateConfirmation.json<Json>().data.idempotent, true);
    await database.prepare("UPDATE quote_snapshots SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", booking.quoteSnapshotId);
    await database.prepare("UPDATE bookings SET quote_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", booking.id);
    const supplemental = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "pay-api-test-0002",
    } });
    assert.equal(supplemental.statusCode, 201, supplemental.body);
    assert.equal(supplemental.json<Json>().data.payment.amountFen, 1000);
    assert.equal(supplemental.json<Json>().data.booking.fulfillmentStatus, "confirmed");
    assert.ok(supplemental.json<Json>().data.booking.events.some((event: Json) => event.title === "车主已确认附加费用"));
    assert.ok(supplemental.json<Json>().data.booking.events.some((event: Json) => event.title === "内部司机备注已更新"));

    const invalidatedSurchargeResponse = await app.inject({ method: "PATCH", url: `/api/admin/bookings/${booking.id}`, payload: {
      adjustment: { amountFen: 200, reason: "已失效附加费", idempotencyKey: "ledger-voided-extra-0001" },
    } });
    assert.equal(invalidatedSurchargeResponse.statusCode, 200, invalidatedSurchargeResponse.body);
    const invalidatedSurcharge = invalidatedSurchargeResponse.json<Json>().data.ledgerEntries
      .find((entry: Json) => entry.idempotencyKey === "ledger-voided-extra-0001");
    await database.prepare("UPDATE booking_ledger_entries SET confirmation_status = 'voided' WHERE id = ?")
      .run(invalidatedSurcharge.id);
    const invalidatedConfirmation = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/ledger/${invalidatedSurcharge.id}/confirm`,
      payload: { idempotencyKey: "confirm-voided-extra-0001" },
    });
    assert.equal(invalidatedConfirmation.statusCode, 409, invalidatedConfirmation.body);
    assert.equal(invalidatedConfirmation.json<Json>().error.code, "LEDGER_ENTRY_NOT_PENDING");
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await close();
  }
});

test("同一订单使用不同幂等键并发支付时只确认一笔并按冻结报价入账", async () => {
  const { app, database, close } = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    assert.equal(booking.serviceFeeFen, 26000);

    const [left, right] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/bookings/${booking.id}/payments`,
        payload: {
          provider: "mock",
          idempotencyKey: "concurrent-payment-left-0001",
          quoteSnapshotId: booking.quoteSnapshotId,
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/bookings/${booking.id}/payments`,
        payload: {
          provider: "mock",
          idempotencyKey: "concurrent-payment-right-0001",
          quoteSnapshotId: booking.quoteSnapshotId,
        },
      }),
    ]);
    assert.deepEqual([left.statusCode, right.statusCode].sort((a, b) => a - b), [201, 409]);
    const rejected = left.statusCode === 409 ? left : right;
    assert.equal(rejected.json<Json>().error.code, "PAYMENT_NOT_REQUIRED");

    const payments = await database.prepare<Json>(`
      SELECT amount_fen, status FROM booking_payments WHERE booking_id = ? ORDER BY created_at, id
    `).all(booking.id);
    assert.deepEqual(payments.map((row) => ({ amountFen: Number(row.amount_fen), status: row.status })), [
      { amountFen: booking.serviceFeeFen, status: "confirmed" },
    ]);
    const persisted = (await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` })).json<Json>().data;
    assert.equal(persisted.paidFen, booking.serviceFeeFen);
    assert.equal(persisted.amountDueFen, 0);
    assert.equal(persisted.paymentStatus, "paid");
    assert.equal(persisted.fulfillmentStatus, "pending_precheck");
    assert.equal(persisted.events.filter((event: Json) => event.title === "支付已确认").length, 1);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await close();
  }
});

test("自驾待支付订单报价过期后可原地更新快照和应收且不重复占用号源", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookedBeforeRequote = Number((await database.prepare<Json>(
      "SELECT booked_count FROM station_slots WHERE id = ?",
    ).get(booking.slotId))?.booked_count);
    await database.prepare("UPDATE bookings SET quote_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", booking.id);
    const expired = await app.inject({ method: "POST", url: `/api/bookings/${booking.id}/payments`, payload: {
      provider: "mock", idempotencyKey: "expired-self-drive-0001", quoteSnapshotId: booking.quoteSnapshotId,
    } });
    assert.equal(expired.statusCode, 409, expired.body);
    assert.equal(expired.json<Json>().error.code, "QUOTE_EXPIRED");
    const unchanged = await app.inject({ method: "GET", url: `/api/bookings/${booking.id}` });
    assert.equal(unchanged.statusCode, 200, unchanged.body);
    assert.equal(unchanged.json<Json>().data.paymentStatus, "unpaid");
    assert.equal(unchanged.json<Json>().data.fulfillmentStatus, "pending_payment");
    assert.ok(!unchanged.json<Json>().data.events.some((event: Json) => event.title === "支付已确认"));

    const repriced = await app.inject({
      method: "PUT",
      url: "/api/admin/pricing",
      payload: { stationId: station.id, category: "fuel_small", priceFen: 32100 },
    });
    assert.equal(repriced.statusCode, 200, repriced.body);
    const requoted = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/requote`,
      payload: { expectedQuoteSnapshotId: booking.quoteSnapshotId },
    });
    assert.equal(requoted.statusCode, 200, requoted.body);
    const requotedBooking = requoted.json<Json>().data.booking;
    assert.notEqual(requotedBooking.quoteSnapshotId, booking.quoteSnapshotId);
    assert.equal(requotedBooking.serviceFeeFen, 32100);
    assert.equal(requotedBooking.inspectionFeeFen, 32100);
    assert.equal(requotedBooking.valetFeeFen, 0);
    assert.equal(requotedBooking.chargedFen, 32100);
    assert.equal(requotedBooking.amountDueFen, 32100);
    assert.equal(requotedBooking.paymentStatus, "unpaid");
    assert.equal(requotedBooking.fulfillmentStatus, "pending_payment");
    assert.ok(Date.parse(requotedBooking.quoteExpiresAt) > Date.now());
    assert.ok(requotedBooking.events.some((event: Json) => event.title === "订单报价已更新"));
    const bookingCharges = await database.prepare<Json>(`
      SELECT amount_fen FROM booking_ledger_entries
      WHERE booking_id = ? AND kind = 'booking_charge'
    `).all(booking.id);
    assert.deepEqual(bookingCharges.map((row) => Number(row.amount_fen)), [32100]);
    const bookedAfterRequote = Number((await database.prepare<Json>(
      "SELECT booked_count FROM station_slots WHERE id = ?",
    ).get(booking.slotId))?.booked_count);
    assert.equal(bookedAfterRequote, bookedBeforeRequote);

    const staleRequote = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/requote`,
      payload: { expectedQuoteSnapshotId: booking.quoteSnapshotId },
    });
    assert.equal(staleRequote.statusCode, 409, staleRequote.body);
    assert.equal(staleRequote.json<Json>().error.code, "BOOKING_QUOTE_CHANGED");

    const stalePagePayment = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "stale-page-payment-0001",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(stalePagePayment.statusCode, 409, stalePagePayment.body);
    assert.equal(stalePagePayment.json<Json>().error.code, "BOOKING_QUOTE_CHANGED");
    assert.equal(Number((await database.prepare<Json>(
      "SELECT COUNT(*) AS count FROM booking_payments WHERE booking_id = ?",
    ).get(booking.id))?.count), 0);
    const afterStalePayment = (await app.inject({
      method: "GET",
      url: `/api/bookings/${booking.id}`,
    })).json<Json>().data;
    assert.equal(afterStalePayment.quoteSnapshotId, requotedBooking.quoteSnapshotId);
    assert.equal(afterStalePayment.amountDueFen, 32100);
    assert.ok(!afterStalePayment.events.some((event: Json) => event.title === "支付已确认"));

    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "requote-self-drive-payment-0001",
        quoteSnapshotId: requotedBooking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.payment.amountFen, 32100);
    assert.equal(paid.json<Json>().data.booking.paidFen, 32100);
    assert.equal(paid.json<Json>().data.booking.amountDueFen, 0);
    assert.equal(paid.json<Json>().data.booking.paymentStatus, "paid");
    assert.equal(paid.json<Json>().data.booking.fulfillmentStatus, "pending_precheck");
    assert.equal(
      paid.json<Json>().data.booking.events.find((event: Json) => event.title === "支付已确认")?.metadata?.quoteSnapshotId,
      requotedBooking.quoteSnapshotId,
    );

    const paidRequote = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/requote`,
      payload: { expectedQuoteSnapshotId: requotedBooking.quoteSnapshotId },
    });
    assert.equal(paidRequote.statusCode, 409, paidRequote.body);
    assert.equal(paidRequote.json<Json>().error.code, "BOOKING_REQUOTE_NOT_ALLOWED");
  } finally {
    await close();
  }
});

test("代驾待支付订单使用原取车地址重新计算真实路线后可按新快照支付", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 7_800, duration: 1_200 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { vehicle, station, slots } = await seedContext(app);
    const pickupAddress = {
      poiId: "requote-valet-pickup",
      title: "天津文化中心停车场",
      address: "天津市河西区平江道 58 号",
      district: "河西区",
      latitude: Number(station.latitude),
      longitude: Number(station.longitude),
      source: "demo",
    };
    const quote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "valet", pickupAddress },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    const media = await uploadAnnualBookingMedia(app, "valet");
    const created = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: vehicle.id,
        stationId: station.id,
        slotId: slots[0].id,
        contactName: "张女士",
        contactPhone: "13800138000",
        serviceMode: "valet",
        pickupAddress,
        quoteSnapshotId: quote.json<Json>().data.quoteSnapshotId,
        mediaIds: media.map((item) => item.id),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    const bookedBefore = Number((await database.prepare<Json>(
      "SELECT booked_count FROM station_slots WHERE id = ?",
    ).get(booking.slotId))?.booked_count);
    await database.prepare("UPDATE quote_snapshots SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", booking.quoteSnapshotId);
    await database.prepare("UPDATE bookings SET quote_expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", booking.id);

    const requoted = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/requote`,
      payload: { expectedQuoteSnapshotId: booking.quoteSnapshotId },
    });
    assert.equal(requoted.statusCode, 200, requoted.body);
    const data = requoted.json<Json>().data;
    assert.notEqual(data.booking.quoteSnapshotId, booking.quoteSnapshotId);
    assert.equal(data.booking.quoteSource, "tencent_matrix");
    assert.equal(data.booking.oneWayDistanceKm, 7.8);
    assert.equal(data.booking.serviceFeeFen, data.quote.serviceFeeFen);
    assert.equal(data.booking.chargedFen, data.quote.serviceFeeFen);
    assert.equal(data.booking.amountDueFen, data.quote.serviceFeeFen);
    assert.equal(data.booking.pickupAddress.poiId, pickupAddress.poiId);
    assert.equal(Number((await database.prepare<Json>(
      "SELECT booked_count FROM station_slots WHERE id = ?",
    ).get(booking.slotId))?.booked_count), bookedBefore);

    const paid = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "requote-valet-payment-0001",
        quoteSnapshotId: data.booking.quoteSnapshotId,
      },
    });
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json<Json>().data.payment.amountFen, data.quote.serviceFeeFen);
    assert.equal(paid.json<Json>().data.booking.amountDueFen, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("PostgreSQL 新库建立身份、会话与车主数据归属约束", async () => {
  const { database, close } = await fixture();
  try {
    const tables = await database.prepare<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('users', 'user_identities', 'user_sessions', 'vehicles', 'bookings')
      ORDER BY table_name
    `).all();
    assert.deepEqual(tables.map((row) => row.table_name), [
      "bookings",
      "user_identities",
      "user_sessions",
      "users",
      "vehicles",
    ]);

    const identity = await database.prepare<{
      provider: string;
      provider_app_id: string;
      provider_subject: string;
      user_id: string;
    }>(`
      SELECT provider, provider_app_id, provider_subject, user_id
      FROM user_identities
      WHERE user_id = 'demo-user'
    `).get();
    assert.deepEqual(identity, {
      provider: "development",
      provider_app_id: "yuxiaoman-development",
      provider_subject: "demo-user",
      user_id: "demo-user",
    });

    const ownershipConstraints = await database.prepare<{ table_name: string }>(`
      SELECT DISTINCT tc.table_name
      FROM information_schema.table_constraints tc
      INNER JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
      INNER JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_schema = tc.constraint_schema
       AND ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_schema = current_schema()
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'user_id'
        AND ccu.table_name = 'users'
        AND tc.table_name IN ('vehicles', 'bookings')
      ORDER BY tc.table_name
    `).all();
    assert.deepEqual(ownershipConstraints.map((row) => row.table_name), ["bookings", "vehicles"]);
  } finally {
    await close();
  }
});

test("显式 legacy_one_way 代驾订单不会伪装成往返报价", async () => {
  const { app, database, close } = await fixture();
  try {
    const row = await database.prepare<{ id: string }>("SELECT id FROM bookings ORDER BY created_at LIMIT 1").get();
    assert.ok(row);
    await database.prepare(`
      UPDATE bookings
      SET service_mode = 'valet', trip_type = 'legacy_one_way', quote_snapshot_id = NULL
      WHERE id = ?
    `).run(row.id);

    const migrated = await database.prepare<{ trip_type: string }>("SELECT trip_type FROM bookings WHERE id = ?").get(row.id);
    assert.ok(migrated);
    assert.equal(migrated.trip_type, "legacy_one_way");

    const response = await app.inject({ method: "GET", url: `/api/operator/bookings/${row.id}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<Json>().data.tripType, "legacy_one_way");
    assert.equal(response.json<Json>().data.isLegacyOneWayValet, true);
  } finally {
    await close();
  }
});

test("自动报价硬守卫优先于动态方案，营运十座非乘用面包车始终转人工", async () => {
  const { app, database, close } = await fixture();
  try {
    const { station } = await seedContext(app);
    const vehicleResponse = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津B·T7010",
      vehicleType: "营运面包客车",
      usageNature: "营运",
      seats: 10,
      registrationDate: "2020-01-01",
      inspectionDueDate: "2027-01-01",
      powertrainType: "gasoline",
      vehicleClassCode: "commercial_bus",
      isVan: true,
    } });
    assert.equal(vehicleResponse.statusCode, 201, vehicleResponse.body);

    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO inspection_price_plans (
        id, code, name, description, powertrain_types_json, min_seats, max_seats,
        usage_natures_json, vehicle_class_codes_json, exclude_vans,
        inspection_items_json, sort_order, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, 10, 10, ?, ?, 0, ?, 1, 1, ?, ?)
    `).run(
      "plan-forbidden-vehicle",
      "forbidden_vehicle_auto",
      "禁止自动报价车型测试方案",
      JSON.stringify(["gasoline"]),
      JSON.stringify(["营运"]),
      JSON.stringify(["commercial_bus"]),
      JSON.stringify(["safety_basic"]),
      now,
      now,
    );
    await database.prepare(`
      INSERT INTO station_inspection_price_plans (station_id, plan_id, is_supported, price_fen, updated_at)
      VALUES (?, 'plan-forbidden-vehicle', 1, 18800, ?)
    `).run(station.id, now);

    const quote = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicleResponse.json<Json>().data.id,
      stationId: station.id,
      serviceMode: "self_drive",
    } });
    assert.equal(quote.statusCode, 200, quote.body);
    const data = quote.json<Json>().data;
    assert.equal(data.pricingEligibility, "manual_review");
    assert.equal(data.pricingReason, "outside_auto_pricing_scope");
    assert.deepEqual(data.hardGuardFailures, [
      "usage_nature_not_non_operational",
      "seat_count_out_of_range",
      "van_not_auto_priced",
      "vehicle_class_not_passenger_car",
    ]);
    assert.equal(data.matchedPricePlan, null);
    assert.equal(data.serviceable, false);
  } finally {
    await close();
  }
});

test("D/F 不覆盖车主动力选择，未分类的矛盾车辆仍不误报价", async () => {
  const { app, close } = await fixture();
  try {
    const { station } = await seedContext(app);
    const createContradictoryVehicle = async (payload: Json) => {
      const response = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
        usageNature: "非营运",
        seats: 5,
        registrationDate: "2020-01-01",
        inspectionDueDate: "2027-01-01",
        ...payload,
      } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<Json>().data;
    };
    const quoteVehicle = async (vehicleId: string) => {
      const response = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
        vehicleId,
        stationId: station.id,
        serviceMode: "self_drive",
      } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Json>().data;
    };

    const dPlate = await createContradictoryVehicle({
      plateNumber: "津A·D99881",
      vehicleType: "纯电乘用车",
      powertrainType: "gasoline",
      vehicleClassCode: "passenger_car",
      isVan: false,
    });
    assert.equal(dPlate.facts.powertrainType, "gasoline");
    assert.deepEqual(dPlate.facts.factsConsistencyFailures, []);
    const dQuote = await quoteVehicle(dPlate.id);
    assert.equal(dQuote.pricingEligibility, "supported");
    assert.ok(dQuote.matchedPricePlan.powertrainTypes.includes("gasoline"));

    const fPlate = await createContradictoryVehicle({
      plateNumber: "津A·F99882",
      vehicleType: "插混乘用车",
      powertrainType: "pure_electric",
      vehicleClassCode: "passenger_car",
      isVan: false,
    });
    assert.equal(fPlate.facts.powertrainType, "pure_electric");
    assert.equal(fPlate.facts.powertrainSource, "vehicle_profile");
    assert.deepEqual(fPlate.facts.factsConsistencyFailures, []);
    const fQuote = await quoteVehicle(fPlate.id);
    assert.equal(fQuote.pricingEligibility, "supported");
    assert.ok(fQuote.matchedPricePlan.powertrainTypes.includes("pure_electric"));

    const cargoVan = await createContradictoryVehicle({
      plateNumber: "津B·T7012",
      vehicleType: "面包货车",
      powertrainType: "gasoline",
      vehicleClassCode: "passenger_car",
      isVan: false,
    });
    assert.equal(cargoVan.facts.isVan, true);
    assert.equal(cargoVan.facts.vehicleClassCode, "other");
    assert.ok(cargoVan.facts.factsConsistencyFailures.includes("vehicle_type_van_conflict"));
    assert.ok(cargoVan.facts.factsConsistencyFailures.includes("vehicle_type_class_conflict"));
    const cargoQuote = await quoteVehicle(cargoVan.id);
    assert.equal(cargoQuote.pricingEligibility, "manual_review");
    assert.ok(cargoQuote.hardGuardFailures.includes("vehicle_type_van_conflict"));
    assert.ok(cargoQuote.hardGuardFailures.includes("vehicle_type_class_conflict"));
    assert.ok(cargoQuote.hardGuardFailures.includes("van_not_auto_priced"));
    assert.ok(cargoQuote.hardGuardFailures.includes("vehicle_class_not_passenger_car"));
  } finally {
    await close();
  }
});

test("报价与订单冻结完整实体和逐项金额，车辆事实变化时返回 QUOTE_STALE", async () => {
  const { app, database, close } = await fixture();
  try {
    const { vehicle, station, slots } = await seedContext(app);
    const quoteResponse = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicle.id,
      stationId: station.id,
      serviceMode: "self_drive",
    } });
    assert.equal(quoteResponse.statusCode, 200, quoteResponse.body);
    const quote = quoteResponse.json<Json>().data;
    assert.equal(quote.snapshotVersion, "quote-v1");
    assert.equal(quote.vehicleFactsVersion, "vehicle-facts-v2-explicit-category");
    assert.match(quote.vehicleFactsHash, /^[a-f0-9]{64}$/);
    assert.equal(quote.vehicleSnapshot.id, vehicle.id);
    assert.equal(quote.stationSnapshot.id, station.id);
    assert.equal(quote.stationSnapshot.latitude, station.latitude);
    assert.equal(quote.matchedPricePlan.priceFen, quote.inspectionFeeFen);
    assert.match(quote.matchedPricePlan.version, /^[a-f0-9]{64}$/);
    assert.equal(
      quote.inspectionItemAmounts.reduce((sum: number, item: Json) => sum + item.amountFen, 0),
      quote.inspectionFeeFen,
    );
    assert.equal(quote.inspectionItemPricingMode, "allocated_from_bundle_not_standalone_price");
    assert.ok(quote.inspectionItemAmounts.every((item: Json) => item.pricingBasis === "allocated_from_bundle"));
    assert.ok(quote.inspectionItemAmounts.every((item: Json) => item.isStandaloneCharge === false));
    const frozenItemAmountsRow = await database.prepare<Json>(`
      SELECT inspection_item_amounts_json FROM quote_snapshots WHERE id = ?
    `).get(quote.quoteSnapshotId);
    assert.ok(frozenItemAmountsRow);
    const frozenItemAmounts = JSON.parse(String(frozenItemAmountsRow.inspection_item_amounts_json));
    assert.ok(frozenItemAmounts.every((item: Json) => item.isStandaloneCharge === false));

    const frozenStationName = quote.stationSnapshot.name;
    const frozenStationLatitude = quote.stationSnapshot.latitude;
    const frozenPlanName = quote.matchedPricePlan.name;
    const frozenPlanPrice = quote.matchedPricePlan.priceFen;
    const changedAt = new Date(Date.now() + 1_000).toISOString();
    await database.prepare("UPDATE stations SET name = ?, latitude = ?, updated_at = ? WHERE id = ?")
      .run("后台改名后的检测站", Number(station.latitude) + 0.02, changedAt, station.id);
    await database.prepare("UPDATE inspection_price_plans SET name = ?, updated_at = ? WHERE id = ?")
      .run("后台改名后的价格方案", changedAt, quote.matchedPricePlan.id);
    await database.prepare("UPDATE station_inspection_price_plans SET price_fen = ?, updated_at = ? WHERE station_id = ? AND plan_id = ?")
      .run(frozenPlanPrice + 9900, changedAt, station.id, quote.matchedPricePlan.id);

    const bookingMedia = await uploadAnnualBookingMedia(app);
    const created = await app.inject({ method: "POST", url: "/api/bookings", payload: {
      vehicleId: vehicle.id,
      stationId: station.id,
      slotId: slots[0].id,
      contactName: "张女士",
      contactPhone: "13800138000",
      serviceMode: "self_drive",
      quoteSnapshotId: quote.quoteSnapshotId,
      mediaIds: bookingMedia.map((item) => item.id),
    } });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;
    assert.equal(booking.station.name, frozenStationName);
    assert.equal(booking.station.latitude, frozenStationLatitude);
    assert.equal(booking.pricePlanSnapshot.name, frozenPlanName);
    assert.equal(booking.pricePlanSnapshot.priceFen, frozenPlanPrice);
    assert.equal(booking.serviceFeeFen, quote.serviceFeeFen);
    assert.equal(booking.vehicleFactsHash, quote.vehicleFactsHash);
    assert.equal(
      booking.inspectionItemAmounts.reduce((sum: number, item: Json) => sum + item.amountFen, 0),
      booking.inspectionFeeFen,
    );
    assert.equal(booking.inspectionItemPricingMode, "allocated_from_bundle_not_standalone_price");
    assert.ok(booking.inspectionItemAmounts.every((item: Json) => item.isStandaloneCharge === false));

    const staleVehicle = await createVehicle(app, "津C·T7011");
    const staleQuoteResponse = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: staleVehicle.id,
      stationId: station.id,
      serviceMode: "self_drive",
    } });
    assert.equal(staleQuoteResponse.statusCode, 200, staleQuoteResponse.body);
    const staleQuote = staleQuoteResponse.json<Json>().data;
    const updatedVehicle = await app.inject({ method: "PATCH", url: `/api/vehicles/${staleVehicle.id}`, payload: { seats: 6 } });
    assert.equal(updatedVehicle.statusCode, 200, updatedVehicle.body);
    const staleMedia = await uploadAnnualBookingMedia(app);
    const staleBooking = await app.inject({ method: "POST", url: "/api/bookings", payload: {
      vehicleId: staleVehicle.id,
      stationId: station.id,
      slotId: slots[1].id,
      contactName: "李女士",
      contactPhone: "13900139000",
      serviceMode: "self_drive",
      quoteSnapshotId: staleQuote.quoteSnapshotId,
      mediaIds: staleMedia.map((item) => item.id),
    } });
    assert.equal(staleBooking.statusCode, 409, staleBooking.body);
    assert.equal(staleBooking.json<Json>().error.code, "QUOTE_STALE");
  } finally {
    await close();
  }
});

test("代驾报价快照冻结规则更新时间与版本", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: { rows: [{ elements: [{ distance: 12_300, duration: 1_200 }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { vehicle, station } = await seedContext(app);
    const unverifiedPickup = {
      poiId: "snapshot-rule-pickup",
      title: "天津站",
      address: "天津市河北区新纬路 1 号",
      district: "河北区",
      latitude: 39.135671,
      longitude: 117.20965,
      source: "tencent",
    };
    const response = await app.inject({ method: "POST", url: "/api/bookings/quote", payload: {
      vehicleId: vehicle.id,
      stationId: station.id,
      serviceMode: "valet",
      tripType: "round_trip_same_address",
      pickupAddress: unverifiedPickup,
    } });
    assert.equal(response.statusCode, 200, response.body);
    const quote = response.json<Json>().data;
    assert.match(quote.rule.updatedAt, /^\d{4}-\d{2}-\d{2}/);
    assert.match(quote.rule.version, /^[a-f0-9]{64}$/);
    const snapshot = await database.prepare<Json>(`
      SELECT rule_updated_at, rule_version, rule_snapshot_json
      FROM quote_snapshots WHERE id = ?
    `).get(quote.quoteSnapshotId);
    assert.ok(snapshot);
    assert.equal(snapshot.rule_updated_at, quote.rule.updatedAt);
    assert.equal(snapshot.rule_version, quote.rule.version);
    assert.equal(JSON.parse(snapshot.rule_snapshot_json).version, quote.rule.version);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("洗车目录、冻结报价、支付核销与结算形成可审计闭环", async () => {
  const { app, database, close } = await fixture();
  try {
    const vehicles = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data;
    assert.equal(vehicles[0].washVehicleCategory, "sedan");
    await database.prepare("UPDATE vehicles SET exterior_color = ? WHERE id = ?")
      .run("海湾蓝（个性定制）", vehicles[0].id);

    const storesResponse = await app.inject({ method: "GET", url: "/api/wash/stores" });
    assert.equal(storesResponse.statusCode, 200, storesResponse.body);
    const stores = storesResponse.json<Json>().data;
    assert.equal(stores.length, 3);
    assert.ok(stores.every((store: Json) => store.serviceType === "car_wash" && store.dataKind === "demo"));
    assert.ok(stores.every((store: Json) => store.name.includes("演示")));
    assert.ok(stores.every((store: Json) => !("internalContact" in store)));

    const store = stores[0];
    await database.prepare(`
      UPDATE wash_stores SET internal_contact_name = '内部店长', internal_contact_phone = '13900001111'
      WHERE id = ?
    `).run(store.id);
    const publicStoresAfterInternalUpdate = await app.inject({ method: "GET", url: "/api/wash/stores" });
    assert.equal(publicStoresAfterInternalUpdate.statusCode, 200, publicStoresAfterInternalUpdate.body);
    assert.ok(publicStoresAfterInternalUpdate.json<Json>().data.every((item: Json) => !("internalContact" in item)));
    assert.ok(!publicStoresAfterInternalUpdate.body.includes("13900001111"));
    const adminStoresWithInternalContact = await washAdminInject(app, { method: "GET", url: "/api/admin/wash/stores" });
    assert.equal(adminStoresWithInternalContact.statusCode, 200, adminStoresWithInternalContact.body);
    const adminStore = adminStoresWithInternalContact.json<Json>().data.find((item: Json) => item.id === store.id);
    assert.deepEqual(adminStore.internalContact, { name: "内部店长", phone: "13900001111" });
    const offersResponse = await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/offers?vehicleCategory=sedan`,
    });
    assert.equal(offersResponse.statusCode, 200, offersResponse.body);
    const offers = offersResponse.json<Json>().data;
    assert.deepEqual(offers.map((offer: Json) => offer.salePriceFen).sort((a: number, b: number) => a - b), [3800, 8800]);
    assert.ok(offers.every((offer: Json) => offer.estimatedSettlementFen === offer.salePriceFen));
    const standard = offers.find((offer: Json) => offer.package.name === "标准洗车");

    const slotsResponse = await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-12&packageId=${standard.packageId}`,
    });
    assert.equal(slotsResponse.statusCode, 200, slotsResponse.body);
    const slot = slotsResponse.json<Json>().data[0];
    assert.equal(slot.bookedCount, 0);

    const quoteResponse = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicles[0].id,
      storeId: store.id,
      packageId: standard.packageId,
      slotId: slot.id,
    } });
    assert.equal(quoteResponse.statusCode, 201, quoteResponse.body);
    const quote = quoteResponse.json<Json>().data;
    assert.equal(quote.quoteSnapshotId, quote.id);
    assert.equal(quote.totalFeeFen, 3800);
    assert.equal(quote.vehicle.exteriorColor, "海湾蓝（个性定制）");
    assert.ok(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt) === 10 * 60_000);

    const createPayload = {
      quoteSnapshotId: quote.id,
      idempotencyKey: "wash-create-happy-path-001",
      contactName: "张女士",
      contactPhone: "13800138000",
      notes: "到店前电话联系",
    };
    const createResponse = await app.inject({ method: "POST", url: "/api/wash/orders", payload: createPayload });
    assert.equal(createResponse.statusCode, 201, createResponse.body);
    const pending = createResponse.json<Json>().data;
    assert.equal(pending.status, "pending_payment");
    assert.equal(pending.redemptionCode, null);
    assert.equal(pending.verificationCode, null);
    assert.equal(pending.serviceType, "car_wash");
    assert.equal(pending.vehicle.exteriorColor, "海湾蓝（个性定制）");
    const duplicateCreate = await app.inject({ method: "POST", url: "/api/wash/orders", payload: createPayload });
    assert.equal(duplicateCreate.statusCode, 200, duplicateCreate.body);
    assert.equal(duplicateCreate.json<Json>().data.id, pending.id);

    await database.prepare("UPDATE wash_orders SET fee_breakdown_json = '{}' WHERE id = ?").run(pending.id);
    const legacyBreakdown = await app.inject({ method: "GET", url: `/api/wash/orders/${pending.id}` });
    assert.equal(legacyBreakdown.statusCode, 200, legacyBreakdown.body);
    assert.deepEqual(legacyBreakdown.json<Json>().data.breakdown, {
      washFeeFen: 3800,
      valetBaseFeeFen: 0,
      valetDistanceFeeFen: 0,
      valetFeeFen: 0,
      totalFeeFen: 3800,
    });

    const otherOwner = await createDevelopmentSession(database, { userId: "wash-other-owner" });
    const otherHeaders = { authorization: `Bearer ${otherOwner.token}` };
    const crossOwnerDetail = await app.inject({
      method: "GET",
      url: `/api/wash/orders/${pending.id}`,
      headers: otherHeaders,
    });
    assert.equal(crossOwnerDetail.statusCode, 404, crossOwnerDetail.body);
    const crossOwnerCancel = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${pending.id}/cancel`,
      headers: otherHeaders,
      payload: { reason: "越权取消" },
    });
    assert.equal(crossOwnerCancel.statusCode, 404, crossOwnerCancel.body);
    const otherOwnerOrders = await app.inject({
      method: "GET",
      url: "/api/wash/orders",
      headers: otherHeaders,
    });
    assert.equal(otherOwnerOrders.statusCode, 200, otherOwnerOrders.body);
    assert.deepEqual(otherOwnerOrders.json<Json>().data, []);

    const directAdminAccess = await app.inject({ method: "GET", url: "/api/admin/wash/orders" });
    assert.equal(directAdminAccess.statusCode, 200, directAdminAccess.body);
    const removedSession = await app.inject({
      method: "POST",
      url: "/api/admin/wash/session",
      payload: { password: "wrong-password" },
    });
    assert.equal(removedSession.statusCode, 404, removedSession.body);

    const prematureSettlement = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/orders/${pending.id}/settlement`,
      payload: { amountFen: 3600, note: "提前结算应被拒绝" },
    });
    assert.equal(prematureSettlement.statusCode, 409, prematureSettlement.body);
    assert.equal(prematureSettlement.json<Json>().error.code, "WASH_SETTLEMENT_ORDER_NOT_REDEEMED");

    const paymentPayload = { provider: "mock", idempotencyKey: "wash-pay-happy-path-001" };
    const paymentResponse = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${pending.id}/payments`,
      payload: paymentPayload,
    });
    assert.equal(paymentResponse.statusCode, 201, paymentResponse.body);
    const paid = paymentResponse.json<Json>().data;
    assert.match(paid.redemptionCode, /^\d{6}$/);
    assert.equal(paid.order.status, "awaiting_redemption");
    assert.equal(paid.order.verificationCode, paid.redemptionCode);
    const duplicatePayment = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${pending.id}/payments`,
      payload: paymentPayload,
    });
    assert.equal(duplicatePayment.statusCode, 200, duplicatePayment.body);
    assert.equal(duplicatePayment.json<Json>().data.redemptionCode, paid.redemptionCode);

    const invalidRedeem = await washAdminInject(app, { method: "POST", url: "/api/admin/wash/orders/redeem", payload: {
      code: "999999",
      source: "phone",
      operator: "店员甲",
    } });
    assert.equal(invalidRedeem.statusCode, 409, invalidRedeem.body);

    const redeemPayload = { code: paid.redemptionCode, source: "wechat", operator: "店员甲", note: "车况已确认" };
    const redeemResponse = await washAdminInject(app, { method: "POST", url: "/api/admin/wash/orders/redeem", payload: redeemPayload });
    assert.equal(redeemResponse.statusCode, 200, redeemResponse.body);
    const redeemed = redeemResponse.json<Json>().data;
    assert.equal(redeemed.status, "redeemed");
    const redeemEvent = redeemed.events.find((event: Json) => event.status === "redeemed");
    assert.deepEqual(redeemEvent.metadata, {
      source: "wechat",
      operator: "自动化测试平台管理员",
      note: "车况已确认",
    });
    const repeatedRedeem = await washAdminInject(app, { method: "POST", url: "/api/admin/wash/orders/redeem", payload: redeemPayload });
    assert.equal(repeatedRedeem.statusCode, 200, repeatedRedeem.body);
    assert.equal(repeatedRedeem.json<Json>().data.events.filter((event: Json) => event.status === "redeemed").length, 1);

    const filterByCode = await washAdminInject(app, {
      method: "GET",
      url: `/api/admin/wash/orders?verificationCode=${paid.redemptionCode.slice(-3)}&orderNumber=${redeemed.orderNumber.slice(-4)}`,
    });
    assert.equal(filterByCode.statusCode, 200, filterByCode.body);
    assert.equal(filterByCode.json<Json>().data.length, 1);

    const settlementResponse = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/orders/${pending.id}/settlement`,
      payload: { amountFen: 3500, note: "门店对账确认", operator: "财务甲" },
    });
    assert.equal(settlementResponse.statusCode, 200, settlementResponse.body);
    assert.equal(settlementResponse.json<Json>().data.settlement.status, "settled");
    assert.equal(settlementResponse.json<Json>().data.order.actualSettlementFen, 3500);

    const correctionWithoutReason = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/orders/${pending.id}/settlement`,
      payload: { amountFen: 3400 },
    });
    assert.equal(correctionWithoutReason.statusCode, 400, correctionWithoutReason.body);
    const correction = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/orders/${pending.id}/settlement`,
      payload: { amountFen: 3400, correctionReason: "财务复核差异", note: "已复核" },
    });
    assert.equal(correction.statusCode, 200, correction.body);
    assert.equal(correction.json<Json>().data.settlement.amountFen, 3400);

    const refundAfterSettlement = await washAdminInject(app, { method: "PATCH", url: `/api/admin/wash/orders/${pending.id}`, payload: {
      action: "refund",
      reason: "测试已结算退款限制",
      operator: "客服甲",
    } });
    assert.equal(refundAfterSettlement.statusCode, 409, refundAfterSettlement.body);
    assert.equal(refundAfterSettlement.json<Json>().error.code, "WASH_ORDER_ALREADY_SETTLED");

    const annualOrders = (await app.inject({ method: "GET", url: "/api/admin/bookings" })).json<Json>().data;
    assert.ok(annualOrders.length > 0);
    assert.ok(annualOrders.every((order: Json) => order.serviceType === "annual_inspection"));
  } finally {
    await close();
  }
});

test("洗车轿车、SUV 与 MPV 独立取价且旧客户端类别仅映射为 SUV", async () => {
  const { app, close } = await fixture();
  try {
    const store = (await app.inject({ method: "GET", url: "/api/wash/stores" })).json<Json>().data[0];
    const seededOffersResponse = await washAdminInject(app, {
      method: "GET",
      url: `/api/admin/wash/stores/${store.id}/offers`,
    });
    assert.equal(seededOffersResponse.statusCode, 200, seededOffersResponse.body);
    const seededOffers = seededOffersResponse.json<Json>().data;
    assert.deepEqual([...new Set(seededOffers.map((item: Json) => item.vehicleCategory))].sort(), ["mpv", "sedan", "suv"]);
    assert.ok(seededOffers.every((item: Json) => item.vehicleCategory !== "suv_mpv"));
    assert.deepEqual(
      seededOffers
        .map((item: Json) => [item.package.name, item.vehicleCategory, item.salePriceFen])
        .sort((left: Json[], right: Json[]) => String(left).localeCompare(String(right))),
      [
        ["标准洗车", "mpv", 5800],
        ["标准洗车", "sedan", 3800],
        ["标准洗车", "suv", 4800],
        ["精致洗护", "mpv", 12800],
        ["精致洗护", "sedan", 8800],
        ["精致洗护", "suv", 10800],
      ].sort((left, right) => String(left).localeCompare(String(right))),
    );
    const standardPackageId = seededOffers.find((item: Json) => item.package.name === "标准洗车").packageId;

    const configured = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}/offers`,
      payload: {
        offers: [
          { packageId: standardPackageId, vehicleCategory: "sedan", salePriceFen: 3100, isAvailable: true },
          { packageId: standardPackageId, vehicleCategory: "suv", salePriceFen: 5200, isAvailable: true },
          { packageId: standardPackageId, vehicleCategory: "mpv", salePriceFen: 6900, isAvailable: true },
        ],
      },
    });
    assert.equal(configured.statusCode, 200, configured.body);

    const createCategoryVehicle = async (plateNumber: string, vehicleType: string, seats: number, washVehicleCategory: string) => {
      const response = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
        plateNumber,
        vehicleType,
        usageNature: "非营运",
        seats,
        registrationDate: "2020-01-01",
        inspectionDueDate: "2027-01-01",
        washVehicleCategory,
      } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<Json>().data;
    };
    const sedan = await createCategoryVehicle("津C·A7011", "小型轿车", 5, "sedan");
    const suv = await createCategoryVehicle("津C·S7012", "七座 SUV", 7, "suv");
    const mpv = await createCategoryVehicle("津C·M7013", "黑色 MPV", 7, "mpv");
    const legacyAlias = await createCategoryVehicle("津C·L7014", "五座 SUV", 5, "suv_mpv");
    assert.equal(legacyAlias.washVehicleCategory, "suv");

    const aliasOffers = await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/offers?vehicleCategory=suv_mpv`,
    });
    assert.equal(aliasOffers.statusCode, 200, aliasOffers.body);
    assert.ok(aliasOffers.json<Json>().data.every((item: Json) => item.vehicleCategory === "suv"));

    const slots = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-12&packageId=${standardPackageId}`,
    })).json<Json>().data;
    const quoteFor = async (vehicle: Json, slotId: string) => {
      const response = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
        vehicleId: vehicle.id,
        storeId: store.id,
        packageId: standardPackageId,
        slotId,
      } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<Json>().data;
    };
    const sedanQuote = await quoteFor(sedan, slots[0].id);
    const suvQuote = await quoteFor(suv, slots[1].id);
    const mpvQuote = await quoteFor(mpv, slots[2].id);
    assert.deepEqual(
      [sedanQuote.vehicleCategory, suvQuote.vehicleCategory, mpvQuote.vehicleCategory],
      ["sedan", "suv", "mpv"],
    );
    assert.deepEqual([sedanQuote.salePriceFen, suvQuote.salePriceFen, mpvQuote.salePriceFen], [3100, 5200, 6900]);
    assert.equal(mpvQuote.vehicle.washVehicleCategory, "mpv");

    const forgedMpvAsSuv = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: mpv.id,
      storeId: store.id,
      packageId: standardPackageId,
      slotId: slots[3].id,
      vehicleCategory: "suv",
    } });
    assert.equal(forgedMpvAsSuv.statusCode, 409, forgedMpvAsSuv.body);
    assert.equal(forgedMpvAsSuv.json<Json>().error.code, "WASH_VEHICLE_CATEGORY_MISMATCH");

    const withoutMpv = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}/offers`,
      payload: {
        offers: [
          { packageId: standardPackageId, vehicleCategory: "sedan", salePriceFen: 3100, isAvailable: true },
          { packageId: standardPackageId, vehicleCategory: "suv", salePriceFen: 5200, isAvailable: true },
          { packageId: standardPackageId, vehicleCategory: "mpv", salePriceFen: 6900, isAvailable: false },
        ],
      },
    });
    assert.equal(withoutMpv.statusCode, 200, withoutMpv.body);
    const noFallback = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: mpv.id,
      storeId: store.id,
      packageId: standardPackageId,
      slotId: slots[3].id,
    } });
    assert.equal(noFallback.statusCode, 409, noFallback.body);
    assert.equal(noFallback.json<Json>().error.code, "WASH_OFFER_UNAVAILABLE");

    const categoryChanged = await app.inject({ method: "PATCH", url: `/api/vehicles/${mpv.id}`, payload: {
      washVehicleCategory: "suv",
    } });
    assert.equal(categoryChanged.statusCode, 200, categoryChanged.body);
    const staleOrder = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: mpvQuote.id,
      idempotencyKey: "wash-mpv-category-stale-001",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(staleOrder.statusCode, 409, staleOrder.body);
    assert.equal(staleOrder.json<Json>().error.code, "WASH_QUOTE_STALE");
  } finally {
    await close();
  }
});

test("洗车三档迁移拆分旧报价且不改写历史已支付快照", async () => {
  const { app, database, close } = await fixture();
  try {
    const vehicles = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data;
    const historicalVehicle = vehicles[0];
    const sevenSeatSuvResponse = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津C·Q7015",
      vehicleType: "七座 SUV",
      usageNature: "非营运",
      seats: 7,
      registrationDate: "2020-01-01",
      inspectionDueDate: "2027-01-01",
      washVehicleCategory: "suv",
    } });
    assert.equal(sevenSeatSuvResponse.statusCode, 201, sevenSeatSuvResponse.body);
    const sevenSeatSuv = sevenSeatSuvResponse.json<Json>().data;
    const store = (await app.inject({ method: "GET", url: "/api/wash/stores" })).json<Json>().data[0];
    const standard = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/offers?vehicleCategory=sedan`,
    })).json<Json>().data.find((item: Json) => item.package.name === "标准洗车");
    const slots = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-12&packageId=${standard.packageId}`,
    })).json<Json>().data;
    const slot = slots[0];
    const quoteResponse = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: historicalVehicle.id,
      storeId: store.id,
      packageId: standard.packageId,
      slotId: slot.id,
    } });
    assert.equal(quoteResponse.statusCode, 201, quoteResponse.body);
    const quote = quoteResponse.json<Json>().data;
    const unusedLegacyQuoteResponse = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: historicalVehicle.id,
      storeId: store.id,
      packageId: standard.packageId,
      slotId: slots[2].id,
    } });
    assert.equal(unusedLegacyQuoteResponse.statusCode, 201, unusedLegacyQuoteResponse.body);
    const unusedLegacyQuote = unusedLegacyQuoteResponse.json<Json>().data;
    const orderResponse = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: quote.id,
      idempotencyKey: "wash-legacy-history-order-001",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(orderResponse.statusCode, 201, orderResponse.body);
    const order = orderResponse.json<Json>().data;
    const payment = await app.inject({ method: "POST", url: `/api/wash/orders/${order.id}/payments`, payload: {
      provider: "mock",
      idempotencyKey: "wash-legacy-history-payment-001",
    } });
    assert.equal(payment.statusCode, 201, payment.body);

    await database.execute(`
      ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_wash_vehicle_category_check;
      ALTER TABLE wash_store_offers DROP CONSTRAINT IF EXISTS wash_store_offers_vehicle_category_check;
      ALTER TABLE wash_quote_snapshots DROP CONSTRAINT IF EXISTS wash_quote_snapshots_vehicle_category_check;
      ALTER TABLE wash_orders DROP CONSTRAINT IF EXISTS wash_orders_vehicle_category_check;
    `);
    const historicalSnapshot = JSON.stringify({
      ...JSON.parse(String((await database.prepare<Json>(
        "SELECT vehicle_snapshot_json FROM wash_orders WHERE id = ?",
      ).get(order.id))!.vehicle_snapshot_json)),
      vehicleType: "黑色 MPV",
      washVehicleCategory: "suv_mpv",
    });
    await database.prepare(`
      UPDATE vehicles SET vehicle_type = '黑色 MPV', seats = 7, wash_vehicle_category = 'suv_mpv' WHERE id = ?
    `).run(historicalVehicle.id);
    await database.prepare(`
      UPDATE vehicles SET vehicle_type = '七座 SUV', seats = 7, wash_vehicle_category = 'suv_mpv' WHERE id = ?
    `).run(sevenSeatSuv.id);
    await database.prepare(`
      UPDATE wash_quote_snapshots
      SET vehicle_category = 'suv_mpv', vehicle_snapshot_json = ?
      WHERE id IN (?, ?)
    `).run(historicalSnapshot, quote.id, unusedLegacyQuote.id);
    await database.prepare(`
      UPDATE wash_orders
      SET vehicle_category = 'suv_mpv', vehicle_snapshot_json = ?
      WHERE id = ?
    `).run(historicalSnapshot, order.id);
    await database.prepare(`
      DELETE FROM wash_store_offers
      WHERE store_id = ? AND package_id = ? AND vehicle_category IN ('suv', 'mpv')
    `).run(store.id, standard.packageId);
    await database.prepare(`
      INSERT INTO wash_store_offers (
        store_id, package_id, vehicle_category, sale_price_fen, list_price_fen,
        estimated_settlement_fen, is_available, updated_at
      ) VALUES (?, ?, 'suv_mpv', 5777, 6777, 4777, 1, ?)
    `).run(store.id, standard.packageId, "2026-08-10T00:00:00.000Z");
    await database.prepare(`
      INSERT INTO wash_store_offers (
        store_id, package_id, vehicle_category, sale_price_fen, list_price_fen,
        estimated_settlement_fen, is_available, updated_at
      ) VALUES (?, ?, 'suv', 5888, 6888, 4888, 1, ?)
    `).run(store.id, standard.packageId, "2026-08-10T01:00:00.000Z");

    const rawBefore = await database.prepare<Json>(`
      SELECT q.vehicle_category AS quote_category, q.sale_price_fen,
        q.vehicle_snapshot_json AS quote_vehicle_snapshot,
        o.vehicle_category AS order_category, o.total_fee_fen,
        o.vehicle_snapshot_json AS order_vehicle_snapshot, o.payment_status
      FROM wash_quote_snapshots q JOIN wash_orders o ON o.quote_snapshot_id = q.id
      WHERE q.id = ?
    `).get(quote.id);
    assert.equal(rawBefore?.payment_status, "paid");

    await migrateWashDatabase(database);
    await migrateWashDatabase(database);

    const migratedMpv = await database.prepare<Json>("SELECT wash_vehicle_category FROM vehicles WHERE id = ?").get(historicalVehicle.id);
    const migratedSevenSeatSuv = await database.prepare<Json>("SELECT wash_vehicle_category FROM vehicles WHERE id = ?").get(sevenSeatSuv.id);
    assert.equal(migratedMpv?.wash_vehicle_category, "mpv");
    assert.equal(migratedSevenSeatSuv?.wash_vehicle_category, "suv");
    const splitOffers = await database.prepare<Json>(`
      SELECT vehicle_category, sale_price_fen, list_price_fen, estimated_settlement_fen
      FROM wash_store_offers
      WHERE store_id = ? AND package_id = ? AND vehicle_category IN ('suv', 'mpv', 'suv_mpv')
      ORDER BY vehicle_category
    `).all(store.id, standard.packageId);
    assert.deepEqual(splitOffers, [
      { vehicle_category: "mpv", sale_price_fen: 5777, list_price_fen: 6777, estimated_settlement_fen: 4777 },
      { vehicle_category: "suv", sale_price_fen: 5888, list_price_fen: 6888, estimated_settlement_fen: 4888 },
    ]);
    const rawAfter = await database.prepare<Json>(`
      SELECT q.vehicle_category AS quote_category, q.sale_price_fen,
        q.vehicle_snapshot_json AS quote_vehicle_snapshot,
        o.vehicle_category AS order_category, o.total_fee_fen,
        o.vehicle_snapshot_json AS order_vehicle_snapshot, o.payment_status
      FROM wash_quote_snapshots q JOIN wash_orders o ON o.quote_snapshot_id = q.id
      WHERE q.id = ?
    `).get(quote.id);
    assert.deepEqual(rawAfter, rawBefore);
    const historicalOrder = await app.inject({ method: "GET", url: `/api/wash/orders/${order.id}` });
    assert.equal(historicalOrder.statusCode, 200, historicalOrder.body);
    assert.equal(historicalOrder.json<Json>().data.vehicleCategory, "mpv");
    assert.equal(historicalOrder.json<Json>().data.vehicle.washVehicleCategory, "mpv");
    assert.equal(historicalOrder.json<Json>().data.totalFeeFen, quote.totalFeeFen);
    const orderFromLegacyQuote = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: unusedLegacyQuote.id,
      idempotencyKey: "wash-legacy-quote-new-order-001",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(orderFromLegacyQuote.statusCode, 201, orderFromLegacyQuote.body);
    assert.equal(orderFromLegacyQuote.json<Json>().data.vehicleCategory, "mpv");
    assert.equal(orderFromLegacyQuote.json<Json>().data.totalFeeFen, unusedLegacyQuote.totalFeeFen);
    const rawNewOrder = await database.prepare<Json>(
      "SELECT vehicle_category FROM wash_orders WHERE id = ?",
    ).get(orderFromLegacyQuote.json<Json>().data.id);
    assert.equal(rawNewOrder?.vehicle_category, "mpv");
  } finally {
    await close();
  }
});

test("洗车 MPV 新市场默认价仅升级未被运营维护的旧演示种子", async () => {
  const { app, database, close } = await fixture();
  try {
    const seedMetadata = await database.prepare<Json>(
      "SELECT updated_at FROM app_metadata WHERE key = ?",
    ).get(WASH_SEED_MARKER);
    assert.ok(seedMetadata?.updated_at);
    await database.prepare("DELETE FROM app_metadata WHERE key = ?").run(WASH_MPV_PRICE_SEED_V2_MARKER);

    const stores = (await app.inject({ method: "GET", url: "/api/wash/stores" })).json<Json>().data;
    assert.equal(stores.length, 3);
    const firstOffers = (await washAdminInject(app, {
      method: "GET",
      url: `/api/admin/wash/stores/${stores[0].id}/offers`,
    })).json<Json>().data;
    const standardPackageId = firstOffers.find((item: Json) => item.package.name === "标准洗车").packageId;
    const detailingPackageId = firstOffers.find((item: Json) => item.package.name === "精致洗护").packageId;
    const seedAt = String(seedMetadata.updated_at);

    await database.prepare(`
      UPDATE wash_store_offers
      SET sale_price_fen = 4800, list_price_fen = 5800,
        estimated_settlement_fen = 4800, updated_at = ?
      WHERE store_id = ? AND package_id = ? AND vehicle_category = 'mpv'
    `).run(seedAt, stores[0].id, standardPackageId);
    await database.prepare(`
      UPDATE wash_store_offers
      SET sale_price_fen = 10800, list_price_fen = 12800,
        estimated_settlement_fen = 10800, updated_at = ?
      WHERE store_id = ? AND package_id = ? AND vehicle_category = 'mpv'
    `).run(seedAt, stores[0].id, detailingPackageId);
    await database.prepare(`
      UPDATE wash_store_offers
      SET sale_price_fen = 4800, list_price_fen = 5800,
        estimated_settlement_fen = 4800, updated_at = '2026-08-10T08:00:00.000Z'
      WHERE store_id = ? AND package_id = ? AND vehicle_category = 'mpv'
    `).run(stores[1].id, standardPackageId);
    await database.prepare(`
      UPDATE wash_store_offers
      SET sale_price_fen = 6200, list_price_fen = 7200,
        estimated_settlement_fen = 6100, updated_at = ?
      WHERE store_id = ? AND package_id = ? AND vehicle_category = 'mpv'
    `).run(seedAt, stores[2].id, standardPackageId);

    const mpvVehicleResponse = await app.inject({ method: "POST", url: "/api/vehicles", payload: {
      plateNumber: "津C·P7016",
      vehicleType: "黑色 MPV",
      usageNature: "非营运",
      seats: 7,
      registrationDate: "2020-01-01",
      inspectionDueDate: "2027-01-01",
      washVehicleCategory: "mpv",
    } });
    assert.equal(mpvVehicleResponse.statusCode, 201, mpvVehicleResponse.body);
    const mpvVehicle = mpvVehicleResponse.json<Json>().data;
    const slot = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${stores[0].id}/slots?date=2026-08-12&packageId=${standardPackageId}`,
    })).json<Json>().data[0];
    const quoteResponse = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: mpvVehicle.id,
      storeId: stores[0].id,
      packageId: standardPackageId,
      slotId: slot.id,
    } });
    assert.equal(quoteResponse.statusCode, 201, quoteResponse.body);
    const quote = quoteResponse.json<Json>().data;
    assert.equal(quote.salePriceFen, 4800);
    const orderResponse = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: quote.id,
      idempotencyKey: "wash-mpv-market-price-history-001",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(orderResponse.statusCode, 201, orderResponse.body);
    const order = orderResponse.json<Json>().data;
    const paymentResponse = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${order.id}/payments`,
      payload: { provider: "mock", idempotencyKey: "wash-mpv-market-price-payment-001" },
    });
    assert.equal(paymentResponse.statusCode, 201, paymentResponse.body);
    const historyBefore = await database.prepare<Json>(`
      SELECT q.sale_price_fen, q.total_fee_fen AS quote_total_fee_fen,
        o.total_fee_fen AS order_total_fee_fen, p.amount_fen AS paid_fen,
        s.amount_fen AS settlement_fen
      FROM wash_quote_snapshots q
      JOIN wash_orders o ON o.quote_snapshot_id = q.id
      JOIN wash_order_payments p ON p.order_id = o.id AND p.kind = 'charge'
      JOIN wash_order_settlements s ON s.order_id = o.id
      WHERE q.id = ?
    `).get(quote.id);

    await migrateWashDatabase(database);
    await migrateWashDatabase(database);

    const eligibleOffers = await database.prepare<Json>(`
      SELECT package_id, sale_price_fen, list_price_fen, estimated_settlement_fen
      FROM wash_store_offers
      WHERE store_id = ? AND vehicle_category = 'mpv' AND package_id IN (?, ?)
      ORDER BY package_id
    `).all(stores[0].id, standardPackageId, detailingPackageId);
    const eligibleByPackage = Object.fromEntries(eligibleOffers.map((item: Json) => [item.package_id, item]));
    assert.deepEqual(eligibleByPackage[standardPackageId], {
      package_id: standardPackageId,
      sale_price_fen: 5800,
      list_price_fen: 6800,
      estimated_settlement_fen: 5800,
    });
    assert.deepEqual(eligibleByPackage[detailingPackageId], {
      package_id: detailingPackageId,
      sale_price_fen: 12800,
      list_price_fen: 14800,
      estimated_settlement_fen: 12800,
    });
    const protectedByTimestamp = await database.prepare<Json>(`
      SELECT sale_price_fen, list_price_fen, estimated_settlement_fen
      FROM wash_store_offers
      WHERE store_id = ? AND package_id = ? AND vehicle_category = 'mpv'
    `).get(stores[1].id, standardPackageId);
    assert.deepEqual(protectedByTimestamp, {
      sale_price_fen: 4800,
      list_price_fen: 5800,
      estimated_settlement_fen: 4800,
    });
    const protectedByPrice = await database.prepare<Json>(`
      SELECT sale_price_fen, list_price_fen, estimated_settlement_fen
      FROM wash_store_offers
      WHERE store_id = ? AND package_id = ? AND vehicle_category = 'mpv'
    `).get(stores[2].id, standardPackageId);
    assert.deepEqual(protectedByPrice, {
      sale_price_fen: 6200,
      list_price_fen: 7200,
      estimated_settlement_fen: 6100,
    });
    assert.ok(await database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(WASH_MPV_PRICE_SEED_V2_MARKER));
    const historyAfter = await database.prepare<Json>(`
      SELECT q.sale_price_fen, q.total_fee_fen AS quote_total_fee_fen,
        o.total_fee_fen AS order_total_fee_fen, p.amount_fen AS paid_fen,
        s.amount_fen AS settlement_fen
      FROM wash_quote_snapshots q
      JOIN wash_orders o ON o.quote_snapshot_id = q.id
      JOIN wash_order_payments p ON p.order_id = o.id AND p.kind = 'charge'
      JOIN wash_order_settlements s ON s.order_id = o.id
      WHERE q.id = ?
    `).get(quote.id);
    assert.deepEqual(historyAfter, historyBefore);
    assert.deepEqual(historyAfter, {
      sale_price_fen: 4800,
      quote_total_fee_fen: 4800,
      order_total_fee_fen: 4800,
      paid_fen: 4800,
      settlement_fen: 4800,
    });
  } finally {
    await close();
  }
});

test("洗车运营后台在生产环境拒绝匿名访问", async () => {
  const originalEnvironment = process.env.YUXIAOMAN_ENV;
  process.env.YUXIAOMAN_ENV = "production";
  const { app, close } = await fixture();
  try {
    const directAccess = await app.inject({ method: "GET", url: "/api/admin/wash/orders" });
    assert.equal(directAccess.statusCode, 401, directAccess.body);
    assert.equal(directAccess.json<Json>().error.code, "BACKOFFICE_AUTHENTICATION_REQUIRED");
    const session = await app.inject({ method: "GET", url: "/api/backoffice/session" });
    assert.equal(session.statusCode, 401, session.body);
  } finally {
    await close();
    if (originalEnvironment === undefined) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = originalEnvironment;
  }
});

test("洗车当天已开始时段不再展示且报价、下单和改期均拒绝", async () => {
  const { app, database, close } = await fixture(fixedWashShanghaiNoon);
  try {
    const vehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];
    const store = (await app.inject({ method: "GET", url: "/api/wash/stores" })).json<Json>().data[0];
    const offer = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/offers?vehicleCategory=sedan`,
    })).json<Json>().data.find((item: Json) => item.package.name === "标准洗车");
    const futureSlotsResponse = await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-12&packageId=${offer.packageId}`,
    });
    assert.equal(futureSlotsResponse.statusCode, 200, futureSlotsResponse.body);
    const [slotThatStarts, earlierSlot, laterSlot] = futureSlotsResponse.json<Json>().data;
    assert.ok(slotThatStarts);
    assert.ok(earlierSlot);
    assert.ok(laterSlot);

    const quoteBeforeStart = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicle.id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slotThatStarts.id,
    } });
    assert.equal(quoteBeforeStart.statusCode, 201, quoteBeforeStart.body);

    await database.prepare(`
      DELETE FROM wash_slots WHERE store_id = ? AND date = '2026-08-11' AND start_time = '12:00'
    `).run(store.id);
    await database.prepare(`
      UPDATE wash_slots
      SET date = '2026-08-11', start_time = '12:00', end_time = '13:00', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), slotThatStarts.id);
    await database.prepare(`
      UPDATE wash_slots
      SET date = '2026-08-11', start_time = '11:59', end_time = '12:59', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), earlierSlot.id);
    await database.prepare(`
      UPDATE wash_slots
      SET date = '2026-08-11', start_time = '12:01', end_time = '13:01', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), laterSlot.id);

    const todaySlots = await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-11&packageId=${offer.packageId}`,
    });
    assert.equal(todaySlots.statusCode, 200, todaySlots.body);
    const todaySlotIds = todaySlots.json<Json>().data.map((slot: Json) => slot.id);
    assert.ok(!todaySlotIds.includes(earlierSlot.id));
    assert.ok(!todaySlotIds.includes(slotThatStarts.id));
    assert.ok(todaySlotIds.includes(laterSlot.id));

    const pastQuote = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicle.id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slotThatStarts.id,
    } });
    assert.equal(pastQuote.statusCode, 409, pastQuote.body);
    assert.equal(pastQuote.json<Json>().error.code, "WASH_SLOT_PAST");

    const staleQuoteOrder = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: quoteBeforeStart.json<Json>().data.id,
      idempotencyKey: "wash-started-slot-stale-quote",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(staleQuoteOrder.statusCode, 409, staleQuoteOrder.body);
    assert.equal(staleQuoteOrder.json<Json>().error.code, "WASH_SLOT_PAST");

    const normalFutureQuote = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicle.id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: laterSlot.id,
    } });
    assert.equal(normalFutureQuote.statusCode, 201, normalFutureQuote.body);
    const normalFutureOrder = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: normalFutureQuote.json<Json>().data.id,
      idempotencyKey: "wash-future-slot-remains-bookable",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(normalFutureOrder.statusCode, 201, normalFutureOrder.body);

    const pastReschedule = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${normalFutureOrder.json<Json>().data.id}/reschedule`,
      payload: { slotId: slotThatStarts.id },
    });
    assert.equal(pastReschedule.statusCode, 409, pastReschedule.body);
    assert.equal(pastReschedule.json<Json>().error.code, "WASH_SLOT_PAST");
  } finally {
    await close();
  }
});

test("洗车代驾按腾讯单程路线生成往返取送快照并支持门店规则覆盖", async () => {
  const { app, database, close } = await fixture();
  const originalKey = process.env.TENCENT_MAP_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TENCENT_MAP_KEY = "wash-valet-test-key";
    const vehicles = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data;
    const store = (await app.inject({ method: "GET", url: "/api/wash/stores" })).json<Json>().data[0];
    const offer = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/offers?vehicleCategory=sedan`,
    })).json<Json>().data.find((item: Json) => item.package.name === "标准洗车");
    const slots = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-12&packageId=${offer.packageId}`,
    })).json<Json>().data;
    const unverifiedPickup = {
      poiId: "wash-valet-pickup",
      title: "天津文化中心",
      address: "天津市河西区平江道",
      district: "河西区",
      latitude: 39.0842,
      longitude: 117.2055,
      source: "tencent",
      detail: "北门",
      note: "到达前电话联系",
    };

    const missingPickup = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicles[0].id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slots[0].id,
      serviceMode: "valet",
    } });
    assert.equal(missingPickup.statusCode, 400, missingPickup.body);
    assert.equal(missingPickup.json<Json>().error.fields.pickupAddress, "请选择上门取车及送回地址");

    globalThis.fetch = (async () => {
      throw new Error("Tencent wash route unavailable");
    }) as typeof fetch;
    const unavailable = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicles[0].id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slots[0].id,
      serviceMode: "valet",
      tripType: "round_trip_same_address",
      pickupAddress: unverifiedPickup,
    } });
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(unavailable.json<Json>().error.code, "WASH_REAL_ROUTE_REQUIRED");

    globalThis.fetch = (async (input) => {
      const url = String(input);
      const payload = url.includes("/suggestion/")
        ? {
            status: 0,
            data: [{
              id: unverifiedPickup.poiId,
              title: unverifiedPickup.title,
              address: unverifiedPickup.address,
              district: unverifiedPickup.district,
              location: { lat: unverifiedPickup.latitude, lng: unverifiedPickup.longitude },
            }],
          }
        : { status: 0, result: { rows: [{ elements: [{ distance: 11_700, duration: 1_260 }] }] } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const suggestionsResponse = await app.inject({
      method: "GET",
      url: "/api/locations/suggestions?query=天津文化中心",
    });
    assert.equal(suggestionsResponse.statusCode, 200, suggestionsResponse.body);
    const pickupAddress = {
      ...suggestionsResponse.json<Json>().data[0],
      detail: "北门",
      note: "到达前电话联系",
    };
    assert.match(pickupAddress.locationProof, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const forgedPickup = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicles[0].id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slots[0].id,
      serviceMode: "valet",
      pickupAddress: { ...pickupAddress, latitude: pickupAddress.latitude + 0.2 },
    } });
    assert.equal(forgedPickup.statusCode, 409, forgedPickup.body);
    assert.equal(forgedPickup.json<Json>().error.code, "WASH_PICKUP_PROOF_INVALID");

    const forgedCategory = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicles[0].id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slots[0].id,
      serviceMode: "self_drive",
      vehicleCategory: "suv_mpv",
    } });
    assert.equal(forgedCategory.statusCode, 409, forgedCategory.body);
    assert.equal(forgedCategory.json<Json>().error.code, "WASH_VEHICLE_CATEGORY_MISMATCH");
    const quoteResponse = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicles[0].id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slots[0].id,
      serviceMode: "valet",
      tripType: "round_trip_same_address",
      pickupAddress,
    } });
    assert.equal(quoteResponse.statusCode, 201, quoteResponse.body);
    const quote = quoteResponse.json<Json>().data;
    assert.equal(quote.serviceMode, "valet");
    assert.equal(quote.tripType, "round_trip_same_address");
    assert.equal(quote.serviceable, true);
    assert.equal(quote.distanceSource, "tencent_matrix");
    assert.equal(quote.distanceBasis, "driving_route");
    assert.equal(quote.oneWayDistanceKm, 11.7);
    assert.equal(quote.roundTripDistanceKm, 23.4);
    assert.equal(quote.billableDistanceKm, 11.7);
    assert.equal(quote.driveMinutes, 21);
    assert.equal(quote.washFeeFen, 3800);
    assert.equal(quote.valetRule.scope, "global");
    assert.equal(quote.extraKm, 2);
    assert.equal(quote.valetFeeFen, 12500);
    assert.equal(quote.totalFeeFen, 16300);
    assert.deepEqual(quote.pickupAddress, pickupAddress);
    assert.deepEqual(quote.breakdown, {
      washFeeFen: 3800,
      valetBaseFeeFen: 10900,
      valetDistanceFeeFen: 1600,
      valetFeeFen: 12500,
      totalFeeFen: 16300,
    });
    const snapshot = await database.prepare<Json>(`
      SELECT service_mode, pickup_address_json, wash_fee_fen, valet_fee_fen, total_fee_fen,
        one_way_distance_km, round_trip_distance_km, billable_distance_km,
        distance_source, valet_rule_json, fee_breakdown_json
      FROM wash_quote_snapshots WHERE id = ?
    `).get(quote.id);
    assert.equal(snapshot?.service_mode, "valet");
    assert.equal(JSON.parse(snapshot?.pickup_address_json).poiId, pickupAddress.poiId);
    assert.equal(snapshot?.total_fee_fen, 16300);

    const orderResponse = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: quote.id,
      idempotencyKey: "wash-valet-create-001",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(orderResponse.statusCode, 201, orderResponse.body);
    const order = orderResponse.json<Json>().data;
    assert.equal(order.serviceMode, "valet");
    assert.equal(order.totalFeeFen, 16300);
    assert.equal(order.estimatedSettlementFen, 3800);
    assert.equal(order.pickupAddress.poiId, pickupAddress.poiId);
    const rescheduled = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${order.id}/reschedule`,
      payload: { slotId: slots[1].id },
    });
    assert.equal(rescheduled.statusCode, 200, rescheduled.body);
    assert.equal(rescheduled.json<Json>().data.serviceMode, "valet");
    assert.equal(rescheduled.json<Json>().data.pickupAddress.poiId, pickupAddress.poiId);
    assert.equal(rescheduled.json<Json>().data.totalFeeFen, 16300);
    const payment = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${order.id}/payments`,
      payload: { provider: "mock", idempotencyKey: "wash-valet-payment-001" },
    });
    assert.equal(payment.statusCode, 201, payment.body);
    assert.equal(payment.json<Json>().data.payment.amountFen, 16300);
    assert.equal(payment.json<Json>().data.order.serviceMode, "valet");

    const valetOrders = await washAdminInject(app, {
      method: "GET",
      url: "/api/admin/wash/orders?serviceMode=valet",
    });
    assert.equal(valetOrders.statusCode, 200, valetOrders.body);
    assert.equal(valetOrders.json<Json>().data.length, 1);
    assert.ok(valetOrders.json<Json>().data.every((item: Json) => item.serviceMode === "valet"));
    const selfDriveOrders = await washAdminInject(app, {
      method: "GET",
      url: "/api/admin/wash/orders?serviceMode=self_drive",
    });
    assert.equal(selfDriveOrders.statusCode, 200, selfDriveOrders.body);
    assert.equal(selfDriveOrders.json<Json>().data.length, 0);
    const invalidMode = await washAdminInject(app, {
      method: "GET",
      url: "/api/admin/wash/orders?serviceMode=driver_app",
    });
    assert.equal(invalidMode.statusCode, 400, invalidMode.body);
    assert.equal(invalidMode.json<Json>().error.code, "INVALID_WASH_SERVICE_MODE");

    const inherited = await washAdminInject(app, { method: "GET", url: `/api/admin/wash/stores/${store.id}/valet-rule` });
    assert.equal(inherited.statusCode, 200, inherited.body);
    assert.equal(inherited.json<Json>().data.inherited, true);
    const override = await washAdminInject(app, { method: "PUT", url: `/api/admin/wash/stores/${store.id}/valet-rule`, payload: {
      baseFeeFen: 4900,
      includedKm: 5,
      perKmFen: 600,
      maxRadiusKm: 10,
    } });
    assert.equal(override.statusCode, 200, override.body);
    assert.equal(override.json<Json>().data.scope, "store");
    assert.equal(override.json<Json>().data.inherited, false);
    const outOfRange = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicles[0].id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slots[2].id,
      serviceMode: "valet",
      pickupAddress,
    } });
    assert.equal(outOfRange.statusCode, 409, outOfRange.body);
    assert.equal(outOfRange.json<Json>().error.code, "WASH_VALET_OUT_OF_RANGE");
    const restored = await washAdminInject(app, { method: "DELETE", url: `/api/admin/wash/stores/${store.id}/valet-rule` });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json<Json>().data.inherited, true);
    assert.equal(
      await database.prepare("SELECT 1 FROM wash_store_valet_pricing_overrides WHERE store_id = ?").get(store.id),
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = originalKey;
    await close();
  }
});

test("洗车容量占位、过期释放、改期退款及后台维护保持一致", async () => {
  const { app, database, close } = await fixture();
  try {
    const firstVehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];
    const secondVehicle = await createVehicle(app, "津C·W7011");
    const store = (await app.inject({ method: "GET", url: "/api/wash/stores" })).json<Json>().data[0];
    const offer = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/offers?vehicleCategory=sedan`,
    })).json<Json>().data.find((item: Json) => item.package.name === "标准洗车");
    const slots = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-13&packageId=${offer.packageId}`,
    })).json<Json>().data;
    const slot = slots[0];
    const nextSlot = slots[1];
    const capacityUpdate = await washAdminInject(app, {
      method: "PATCH",
      url: `/api/admin/wash/slots/${slot.id}`,
      payload: { capacity: 1, isOpen: true },
    });
    assert.equal(capacityUpdate.statusCode, 200, capacityUpdate.body);

    const firstQuote = (await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: firstVehicle.id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slot.id,
    } })).json<Json>().data;
    const firstOrderResponse = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: firstQuote.id,
      idempotencyKey: "wash-capacity-order-001",
      contactName: "张女士",
      contactPhone: "13800138000",
    } });
    assert.equal(firstOrderResponse.statusCode, 201, firstOrderResponse.body);
    const firstOrder = firstOrderResponse.json<Json>().data;

    const fullQuote = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: secondVehicle.id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slot.id,
    } });
    assert.equal(fullQuote.statusCode, 409, fullQuote.body);
    assert.equal(fullQuote.json<Json>().error.code, "WASH_SLOT_FULL");

    await database.prepare("UPDATE wash_orders SET hold_expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", firstOrder.id);
    const expiredReschedule = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${firstOrder.id}/reschedule`,
      payload: { slotId: nextSlot.id },
    });
    assert.equal(expiredReschedule.statusCode, 409, expiredReschedule.body);
    const releasedSlots = await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-13`,
    });
    assert.equal(releasedSlots.statusCode, 200, releasedSlots.body);
    assert.equal(releasedSlots.json<Json>().data.find((item: Json) => item.id === slot.id).remaining, 1);
    const expiredOrder = await app.inject({ method: "GET", url: `/api/wash/orders/${firstOrder.id}` });
    assert.equal(expiredOrder.json<Json>().data.status, "expired");
    assert.equal(expiredOrder.json<Json>().data.settlementStatus, "void");

    const secondQuoteResponse = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: secondVehicle.id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slot.id,
    } });
    assert.equal(secondQuoteResponse.statusCode, 201, secondQuoteResponse.body);
    const secondOrderResponse = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: secondQuoteResponse.json<Json>().data.id,
      idempotencyKey: "wash-capacity-order-002",
      contactName: "李女士",
      contactPhone: "13900139000",
    } });
    assert.equal(secondOrderResponse.statusCode, 201, secondOrderResponse.body);
    const secondOrder = secondOrderResponse.json<Json>().data;
    const reschedule = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${secondOrder.id}/reschedule`,
      payload: { slotId: nextSlot.id },
    });
    assert.equal(reschedule.statusCode, 200, reschedule.body);
    assert.equal(reschedule.json<Json>().data.slotId, nextSlot.id);

    const payment = await app.inject({
      method: "POST",
      url: `/api/wash/orders/${secondOrder.id}/payments`,
      payload: { provider: "mock", idempotencyKey: "wash-capacity-payment-002" },
    });
    assert.equal(payment.statusCode, 201, payment.body);
    const redemptionCode = payment.json<Json>().data.redemptionCode;
    const cancellation = await app.inject({ method: "POST", url: `/api/wash/orders/${secondOrder.id}/cancel`, payload: {
      reason: "临时有事",
    } });
    assert.equal(cancellation.statusCode, 200, cancellation.body);
    assert.equal(cancellation.json<Json>().data.status, "refunded");
    assert.equal(cancellation.json<Json>().data.settlementStatus, "void");
    const inactiveCode = await washAdminInject(app, { method: "POST", url: "/api/admin/wash/orders/redeem", payload: {
      code: redemptionCode,
      source: "other",
      operator: "店员乙",
    } });
    assert.equal(inactiveCode.statusCode, 409, inactiveCode.body);

    const packageResponse = await washAdminInject(app, { method: "POST", url: "/api/admin/wash/packages", payload: {
      code: "test_express_wash",
      name: "测试快洗",
      shortDescription: "仅用于自动化测试",
      includedItems: ["预冲", "擦干"],
      durationMinutes: 30,
      sortOrder: 99,
      isActive: true,
    } });
    assert.equal(packageResponse.statusCode, 201, packageResponse.body);
    assert.deepEqual(packageResponse.json<Json>().data.serviceItems, ["预冲", "擦干"]);
    const packageDelete = await washAdminInject(app, {
      method: "DELETE",
      url: `/api/admin/wash/packages/${packageResponse.json<Json>().data.id}`,
    });
    assert.equal(packageDelete.statusCode, 200, packageDelete.body);
    assert.equal(packageDelete.json<Json>().data.isActive, false);

    const storeLocationResponse = await app.inject({
      method: "GET",
      url: "/api/locations/suggestions?query=天津文化中心",
    });
    assert.equal(storeLocationResponse.statusCode, 200, storeLocationResponse.body);
    const storeLocation = storeLocationResponse.json<Json>().data[0];
    assert.match(storeLocation.locationProof, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const storeResponse = await washAdminInject(app, { method: "POST", url: "/api/admin/wash/stores", payload: {
      name: "自动化测试洗车店（演示）",
      location: storeLocation,
      phone: "022-0000-0001",
      description: "合成测试门店",
      tags: ["测试"],
      facilities: [],
      openHours: "09:00-18:00",
      weeklySchedule: {
        mon: [{ start: "09:00", end: "18:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      },
      businessHoursNotice: null,
      advanceBookingDays: 14,
      rating: 0,
      reviewCount: 0,
      dataKind: "demo",
      isActive: true,
      sortPriority: 0,
      internalContact: null,
    } });
    assert.equal(storeResponse.statusCode, 201, storeResponse.body);
    const createdStore = storeResponse.json<Json>().data;
    assert.ok("internalContact" in createdStore);
    const batch = await washAdminInject(app, { method: "POST", url: "/api/admin/wash/slots/batch", payload: {
      storeId: createdStore.id,
      dateFrom: "2026-08-20",
      dateTo: "2026-08-20",
      startTime: "09:00",
      endTime: "11:00",
      slotMinutes: 60,
      capacity: 2,
    } });
    assert.equal(batch.statusCode, 201, batch.body);
    assert.equal(batch.json<Json>().data.createdCount, 2);
    const closeSlot = await washAdminInject(app, {
      method: "PATCH",
      url: `/api/admin/wash/slots/${batch.json<Json>().data.slots[0].id}`,
      payload: { isClosed: true },
    });
    assert.equal(closeSlot.statusCode, 200, closeSlot.body);
    assert.equal(closeSlot.json<Json>().data.isOpen, false);
    const storeDelete = await washAdminInject(app, { method: "DELETE", url: `/api/admin/wash/stores/${createdStore.id}` });
    assert.equal(storeDelete.statusCode, 200, storeDelete.body);
    assert.equal(storeDelete.json<Json>().data.deleted, true);
  } finally {
    await close();
  }
});

test("洗车服务启动时只清理受控目录中的图库孤儿文件", async () => {
  const database = await createTestDatabase("wash_image_gc");
  const uploadDir = mkdtempSync(join(tmpdir(), "yuxiaoman-wash-image-gc-"));
  const imageDir = join(uploadDir, "wash", "stores");
  mkdirSync(imageDir, { recursive: true });
  const orphanPath = join(imageDir, "00000000-0000-4000-8000-000000000001.jpg");
  const unrelatedPath = join(imageDir, "operator-note.txt");
  writeFileSync(orphanPath, testPng);
  writeFileSync(unrelatedPath, "do not delete");
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({ database, uploadDir });
    await app.ready();
    assert.equal(existsSync(orphanPath), false, "无数据库引用的受控 jpg 应在启动时被回收");
    assert.equal(existsSync(unrelatedPath), true, "GC 不应触碰非受控文件名");
  } finally {
    if (app) await app.close();
    await database.close();
    rmSync(uploadDir, { recursive: true, force: true });
  }
});

test("洗车旧库可重复升级门店详情与相册字段且不覆盖已维护内容", async () => {
  const { app, database, close } = await fixture();
  try {
    await database.execute(`
      DROP TABLE IF EXISTS wash_order_settlements CASCADE;
      DROP TABLE IF EXISTS wash_order_payments CASCADE;
      DROP TABLE IF EXISTS wash_order_events CASCADE;
      DROP TABLE IF EXISTS wash_orders CASCADE;
      DROP TABLE IF EXISTS wash_quote_snapshots CASCADE;
      DROP TABLE IF EXISTS wash_slots CASCADE;
      DROP TABLE IF EXISTS wash_store_offers CASCADE;
      DROP TABLE IF EXISTS wash_store_valet_pricing_overrides CASCADE;
      DROP TABLE IF EXISTS wash_store_images CASCADE;
      DROP TABLE IF EXISTS wash_packages CASCADE;
      DROP TABLE IF EXISTS wash_stores CASCADE;

      CREATE TABLE wash_stores (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        district TEXT NOT NULL,
        address TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        phone TEXT,
        open_hours TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        sort_priority INTEGER NOT NULL DEFAULT 0,
        internal_contact_name TEXT,
        internal_contact_phone TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO wash_stores (
        id, name, district, address, latitude, longitude, phone, open_hours,
        is_active, sort_priority, internal_contact_name, internal_contact_phone,
        created_at, updated_at
      ) VALUES (
        'wash-store-legacy-upgrade', '旧版洗车店（演示）', '河西区', '旧版演示地址 1 号',
        39.08, 117.21, '022-0000-1000', '09:00-18:00', 1, 3,
        '内部负责人', '13900001111', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);

    await migrateWashDatabase(database);
    const expectedColumns = [
      "cover_image_url",
      "description",
      "tags_json",
      "facilities_json",
      "weekly_schedule_json",
      "business_hours_notice",
      "advance_booking_days",
      "rating",
      "review_count",
      "data_kind",
    ];
    const columnRows = await database.prepare<Json>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'wash_stores'
    `).all();
    const columns = new Set(columnRows.map((row) => String(row.column_name)));
    for (const column of expectedColumns) assert.ok(columns.has(column), `旧库升级缺少 ${column}`);

    const publicDetail = await app.inject({ method: "GET", url: "/api/wash/stores/wash-store-legacy-upgrade" });
    assert.equal(publicDetail.statusCode, 200, publicDetail.body);
    assert.deepEqual(publicDetail.json<Json>().data.images, []);
    assert.equal(publicDetail.json<Json>().data.imageCount, 0);
    assert.equal(publicDetail.json<Json>().data.description, "");
    assert.deepEqual(publicDetail.json<Json>().data.tags, []);
    assert.deepEqual(publicDetail.json<Json>().data.facilities, []);
    assert.deepEqual(publicDetail.json<Json>().data.weeklySchedule, {});
    assert.equal(publicDetail.json<Json>().data.advanceBookingDays, 14);
    assert.equal(publicDetail.json<Json>().data.dataKind, "demo");
    assert.ok(!("internalContact" in publicDetail.json<Json>().data));

    await database.prepare(`
      UPDATE wash_stores SET description = ?, tags_json = ?, facilities_json = ?,
        weekly_schedule_json = ?, business_hours_notice = ?, advance_booking_days = ?,
        rating = ?, review_count = ?, cover_image_url = ?
      WHERE id = ?
    `).run(
      "运营已经维护的旧库详情（演示）",
      JSON.stringify(["室内工位"]),
      JSON.stringify(["休息区"]),
      JSON.stringify({ mon: [{ start: "09:00", end: "18:00" }] }),
      "节假日请电话确认（演示）",
      21,
      4.6,
      18,
      "/legacy-cover.jpg",
      "wash-store-legacy-upgrade",
    );
    await migrateWashDatabase(database);
    await migrateWashDatabase(database);
    const preserved = await database.prepare<Json>(`
      SELECT * FROM wash_stores WHERE id = 'wash-store-legacy-upgrade'
    `).get();
    assert.equal(preserved?.description, "运营已经维护的旧库详情（演示）");
    assert.equal(preserved?.tags_json, JSON.stringify(["室内工位"]));
    assert.equal(preserved?.facilities_json, JSON.stringify(["休息区"]));
    assert.equal(Number(preserved?.advance_booking_days), 21);
    assert.equal(Number(preserved?.rating), 4.6);
    assert.equal(Number(preserved?.review_count), 18);
    assert.equal(preserved?.cover_image_url, "/legacy-cover.jpg");
    assert.ok(await database.prepare("SELECT 1 FROM wash_store_images LIMIT 1").get() === undefined);

    const adminLegacy = (await washAdminInject(app, { method: "GET", url: "/api/admin/wash/stores" }))
      .json<Json>().data.find((item: Json) => item.id === "wash-store-legacy-upgrade");
    const { coverImageUrl: _legacyCover, ...legacyDetailPayload } = adminLegacy;
    const omittedCoverUpdate = await washAdminInject(app, {
      method: "PUT",
      url: "/api/admin/wash/stores/wash-store-legacy-upgrade",
      payload: { ...legacyDetailPayload, description: "普通资料更新不应清空旧封面（演示）" },
    });
    assert.equal(omittedCoverUpdate.statusCode, 200, omittedCoverUpdate.body);
    assert.equal(omittedCoverUpdate.json<Json>().data.coverImageUrl, "/legacy-cover.jpg");
    const nullCoverUpdate = await washAdminInject(app, {
      method: "PUT",
      url: "/api/admin/wash/stores/wash-store-legacy-upgrade",
      payload: {
        ...legacyDetailPayload,
        description: "空封面字段也应被忽略（演示）",
        coverImageUrl: null,
      },
    });
    assert.equal(nullCoverUpdate.statusCode, 200, nullCoverUpdate.body);
    assert.equal(nullCoverUpdate.json<Json>().data.coverImageUrl, "/legacy-cover.jpg");
    const maliciousCoverUpdate = await washAdminInject(app, {
      method: "PUT",
      url: "/api/admin/wash/stores/wash-store-legacy-upgrade",
      payload: {
        ...legacyDetailPayload,
        description: "恶意封面字段应被忽略（演示）",
        coverImageUrl: "https://attacker.invalid/forged-cover.jpg",
      },
    });
    assert.equal(maliciousCoverUpdate.statusCode, 200, maliciousCoverUpdate.body);
    assert.equal(maliciousCoverUpdate.json<Json>().data.coverImageUrl, "/legacy-cover.jpg");
    const coverAfterDetailUpdates = await database.prepare<Json>(`
      SELECT cover_image_url FROM wash_stores WHERE id = 'wash-store-legacy-upgrade'
    `).get();
    assert.equal(coverAfterDetailUpdates?.cover_image_url, "/legacy-cover.jpg");
  } finally {
    await close();
  }
});

test("洗车门店详情与相册支持安全上传、排序、设封面和删除且公开 DTO 不泄露内部联系人", async () => {
  const { app, database, close } = await fixture();
  try {
    const adminList = await washAdminInject(app, { method: "GET", url: "/api/admin/wash/stores" });
    assert.equal(adminList.statusCode, 200, adminList.body);
    const adminStores = adminList.json<Json>().data;
    const store = adminStores[0];
    const otherStore = adminStores[1];
    assert.deepEqual(store.images, []);
    assert.equal(store.imageCount, 0);

    const vehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];
    const offers = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/offers?vehicleCategory=sedan`,
    })).json<Json>().data;
    const offer = offers.find((item: Json) => item.package.code === "standard_wash");
    const slot = (await app.inject({
      method: "GET",
      url: `/api/wash/stores/${store.id}/slots?date=2026-08-12&packageId=${offer.packageId}`,
    })).json<Json>().data[0];
    const quoteResponse = await app.inject({ method: "POST", url: "/api/wash/quotes", payload: {
      vehicleId: vehicle.id,
      storeId: store.id,
      packageId: offer.packageId,
      slotId: slot.id,
    } });
    assert.equal(quoteResponse.statusCode, 201, quoteResponse.body);
    const quote = quoteResponse.json<Json>().data;
    const orderResponse = await app.inject({ method: "POST", url: "/api/wash/orders", payload: {
      quoteSnapshotId: quote.id,
      idempotencyKey: "wash-store-media-snapshot-001",
      contactName: "演示车主",
      contactPhone: "13800138000",
    } });
    assert.equal(orderResponse.statusCode, 201, orderResponse.body);
    const order = orderResponse.json<Json>().data;

    const edited = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}`,
      payload: {
        ...store,
        description: "室内双工位洗车，预约到店后按时段接车；当前内容为合成演示。",
        tags: ["室内工位", "预约优先", "演示"],
        facilities: ["休息区", "免费饮水", "充电位"],
        businessHoursNotice: "节假日营业时段请以预约页为准（演示）。",
      },
    });
    assert.equal(edited.statusCode, 200, edited.body);

    const largePng = await sharp({
      create: { width: 2600, height: 1800, channels: 3, background: { r: 36, g: 102, b: 177 } },
    }).png().withMetadata({ orientation: 6 }).toBuffer();
    const firstUpload = await uploadWashStoreImage(app, store.id, largePng, "image/png", { sortOrder: 9 });
    assert.equal(firstUpload.statusCode, 201, firstUpload.body);
    const first = firstUpload.json<Json>().data;
    assert.equal(first.isCover, true, "第一张门店图片自动成为封面");
    assert.equal(first.mimeType, "image/jpeg");
    assert.equal(first.dataKind, "demo");
    assert.ok(first.width <= 2048 && first.height <= 2048);
    assert.match(first.url, new RegExp(`^/api/admin/wash/store-images/${first.id}$`, "u"));

    const secondUpload = await uploadWashStoreImage(app, store.id, testPng, "image/png", {
      isCover: true,
      sortOrder: 0,
    });
    assert.equal(secondUpload.statusCode, 201, secondUpload.body);
    const second = secondUpload.json<Json>().data;
    assert.equal(second.isCover, true);
    assert.equal(Number((await database.prepare<Json>(`
      SELECT COUNT(*) AS count FROM wash_store_images WHERE store_id = ? AND is_cover = 1
    `).get(store.id))?.count), 1);

    const managedStore = (await washAdminInject(app, { method: "GET", url: "/api/admin/wash/stores" }))
      .json<Json>().data.find((item: Json) => item.id === store.id);
    const { coverImageUrl: _managedCover, ...managedDetailPayload } = managedStore;
    const managedOmittedCoverUpdate = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}`,
      payload: managedDetailPayload,
    });
    assert.equal(managedOmittedCoverUpdate.statusCode, 200, managedOmittedCoverUpdate.body);
    assert.equal(managedOmittedCoverUpdate.json<Json>().data.coverImageUrl, `/api/admin/wash/store-images/${second.id}`);
    const managedMaliciousCoverUpdate = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}`,
      payload: { ...managedDetailPayload, coverImageUrl: "https://attacker.invalid/forged-cover.jpg" },
    });
    assert.equal(managedMaliciousCoverUpdate.statusCode, 200, managedMaliciousCoverUpdate.body);
    assert.equal(managedMaliciousCoverUpdate.json<Json>().data.coverImageUrl, `/api/admin/wash/store-images/${second.id}`);
    const managedCoverRow = await database.prepare<Json>(`
      SELECT store.cover_image_url,
        (SELECT image.id FROM wash_store_images AS image
          WHERE image.store_id = store.id AND image.is_cover = 1) AS image_cover_id
      FROM wash_stores AS store WHERE store.id = ?
    `).get(store.id);
    assert.equal(managedCoverRow?.cover_image_url, `/api/wash/store-images/${second.id}`);
    assert.equal(managedCoverRow?.image_cover_id, second.id);

    const publicList = await app.inject({ method: "GET", url: "/api/wash/stores" });
    assert.equal(publicList.statusCode, 200, publicList.body);
    const publicStore = publicList.json<Json>().data.find((item: Json) => item.id === store.id);
    assert.equal(publicStore.imageCount, 2);
    assert.equal(publicStore.coverImageUrl, `/api/wash/store-images/${second.id}`);
    assert.equal(publicStore.images[0].id, second.id);
    assert.ok(publicStore.images.every((image: Json) => image.dataKind === "demo"));
    assert.ok(publicStore.name.includes("演示"));
    assert.ok(!("internalContact" in publicStore));
    assert.ok(!publicList.body.includes("13900001111"));

    const publicDetail = await app.inject({ method: "GET", url: `/api/wash/stores/${store.id}` });
    assert.equal(publicDetail.statusCode, 200, publicDetail.body);
    const detail = publicDetail.json<Json>().data;
    assert.match(detail.description, /室内双工位/u);
    assert.deepEqual(detail.tags, ["室内工位", "预约优先", "演示"]);
    assert.deepEqual(detail.facilities, ["休息区", "免费饮水", "充电位"]);
    assert.equal(detail.businessHoursNotice, "节假日营业时段请以预约页为准（演示）。");
    assert.equal(detail.images.length, 2);
    assert.ok(!("internalContact" in detail));

    const immutableSnapshots = await database.prepare<Json>(`
      SELECT q.store_snapshot_json AS quote_store_snapshot_json,
        o.store_snapshot_json AS order_store_snapshot_json
      FROM wash_quote_snapshots q
      JOIN wash_orders o ON o.quote_snapshot_id = q.id
      WHERE q.id = ? AND o.id = ?
    `).get(quote.id, order.id);
    for (const snapshot of [
      JSON.parse(immutableSnapshots!.quote_store_snapshot_json),
      JSON.parse(immutableSnapshots!.order_store_snapshot_json),
    ]) {
      assert.deepEqual(snapshot.images, []);
      assert.equal(snapshot.coverImageUrl, null);
      assert.doesNotMatch(snapshot.description, /室内双工位/u);
    }

    const imageRead = await app.inject({ method: "GET", url: detail.coverImageUrl });
    assert.equal(imageRead.statusCode, 200, imageRead.body);
    assert.equal(imageRead.headers["content-type"], "image/jpeg");
    assert.equal(imageRead.headers["x-content-type-options"], "nosniff");
    assert.match(String(imageRead.headers["cache-control"]), /immutable/u);

    const reordered = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${store.id}/images`,
      payload: {
        images: [
          { id: first.id, sortOrder: 0, isCover: true },
          { id: second.id, sortOrder: 1 },
        ],
      },
    });
    assert.equal(reordered.statusCode, 200, reordered.body);
    assert.equal(reordered.json<Json>().data.images[0].id, first.id);
    assert.equal(reordered.json<Json>().data.images[0].isCover, true);

    const crossStoreDelete = await washAdminInject(app, {
      method: "DELETE",
      url: `/api/admin/wash/stores/${otherStore.id}/images/${first.id}`,
    });
    assert.equal(crossStoreDelete.statusCode, 404, crossStoreDelete.body);
    assert.equal(crossStoreDelete.json<Json>().error.code, "WASH_STORE_IMAGE_NOT_FOUND");

    const removedCover = await washAdminInject(app, {
      method: "DELETE",
      url: `/api/admin/wash/stores/${store.id}/images/${first.id}`,
    });
    assert.equal(removedCover.statusCode, 200, removedCover.body);
    assert.equal(removedCover.json<Json>().data.images.length, 1);
    assert.equal(removedCover.json<Json>().data.images[0].id, second.id);
    assert.equal(removedCover.json<Json>().data.images[0].isCover, true);

    const invalidType = await uploadWashStoreImage(app, store.id, Buffer.from("GIF89a"), "image/gif");
    assert.equal(invalidType.statusCode, 415, invalidType.body);
    assert.equal(invalidType.json<Json>().error.code, "WASH_STORE_IMAGE_TYPE_INVALID");
    const invalidContent = await uploadWashStoreImage(app, store.id, Buffer.from("not-an-image"), "image/png");
    assert.equal(invalidContent.statusCode, 400, invalidContent.body);
    assert.equal(invalidContent.json<Json>().error.code, "WASH_STORE_IMAGE_INVALID");
    const oversized = await uploadWashStoreImage(
      app,
      store.id,
      Buffer.alloc(10 * 1024 * 1024 + 1, 0),
      "image/png",
    );
    assert.equal(oversized.statusCode, 413, oversized.body);
    assert.equal(oversized.json<Json>().error.code, "WASH_STORE_IMAGE_TOO_LARGE");

    const removedLast = await washAdminInject(app, {
      method: "DELETE",
      url: `/api/admin/wash/stores/${store.id}/images/${second.id}`,
    });
    assert.equal(removedLast.statusCode, 200, removedLast.body);
    assert.deepEqual(removedLast.json<Json>().data.images, []);
    const emptyDetail = await app.inject({ method: "GET", url: `/api/wash/stores/${store.id}` });
    assert.equal(emptyDetail.statusCode, 200, emptyDetail.body);
    assert.equal(emptyDetail.json<Json>().data.coverImageUrl, null);
    assert.equal(emptyDetail.json<Json>().data.imageCount, 0);

    const reset = await app.inject({ method: "POST", url: "/api/demo/reset" });
    assert.equal(reset.statusCode, 200, reset.body);
    const resetStore = (await washAdminInject(app, { method: "GET", url: "/api/admin/wash/stores" }))
      .json<Json>().data[0];
    const afterResetUpload = await uploadWashStoreImage(app, resetStore.id, testPng, "image/png");
    assert.equal(afterResetUpload.statusCode, 201, afterResetUpload.body);
    const publicImageBeforeDisable = await app.inject({
      method: "GET",
      url: `/api/wash/store-images/${afterResetUpload.json<Json>().data.id}`,
    });
    assert.equal(publicImageBeforeDisable.statusCode, 200, publicImageBeforeDisable.body);
    assert.equal(publicImageBeforeDisable.headers["cache-control"], "public, max-age=31536000, immutable");
    await database.prepare("UPDATE wash_stores SET is_active = 0 WHERE id = ?").run(resetStore.id);
    const inactivePublicImage = await app.inject({
      method: "GET",
      url: `/api/wash/store-images/${afterResetUpload.json<Json>().data.id}`,
    });
    assert.equal(inactivePublicImage.statusCode, 404, inactivePublicImage.body);
    assert.equal(inactivePublicImage.json<Json>().error.code, "WASH_STORE_IMAGE_NOT_FOUND");
    const inactiveAdminImage = await washAdminInject(app, {
      method: "GET",
      url: `/api/admin/wash/store-images/${afterResetUpload.json<Json>().data.id}`,
    });
    assert.equal(inactiveAdminImage.statusCode, 200, inactiveAdminImage.body);
    assert.equal(inactiveAdminImage.headers["content-type"], "image/jpeg");
    assert.equal(inactiveAdminImage.headers["cache-control"], "private, no-store");
    assert.match(String(inactiveAdminImage.headers.vary), /Cookie/iu);
    await database.prepare("UPDATE wash_stores SET is_active = 1 WHERE id = ?").run(resetStore.id);
    await washAdminInject(app, {
      method: "DELETE",
      url: `/api/admin/wash/stores/${resetStore.id}/images/${afterResetUpload.json<Json>().data.id}`,
    });

    await migrateWashDatabase(database);
    await migrateWashDatabase(database);
    assert.ok(await database.prepare("SELECT 1 FROM wash_store_images LIMIT 1").get() === undefined);
  } finally {
    await close();
  }
});

test("洗车门店位置必须来自可信地址候选且编辑默认保留原定位", async () => {
  const { app, close } = await fixture();
  try {
    const firstSuggestions = await app.inject({
      method: "GET",
      url: "/api/locations/suggestions?query=文化中心",
    });
    assert.equal(firstSuggestions.statusCode, 200, firstSuggestions.body);
    const firstLocation = firstSuggestions.json<Json>().data[0];
    assert.ok(firstLocation);
    assert.match(firstLocation.locationProof, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const storePayload = {
      name: "可信定位测试洗车店（演示）",
      phone: "022-0000-1001",
      description: "验证后台只能采用位置服务候选",
      tags: ["定位测试"],
      facilities: [],
      openHours: "09:00-18:00",
      weeklySchedule: {
        mon: [{ start: "09:00", end: "18:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      },
      businessHoursNotice: null,
      advanceBookingDays: 14,
      rating: 0,
      reviewCount: 0,
      dataKind: "demo",
      isActive: true,
      sortPriority: 0,
      internalContact: null,
    };

    const missingLocation = await washAdminInject(app, {
      method: "POST",
      url: "/api/admin/wash/stores",
      payload: {
        ...storePayload,
        name: "缺失定位测试洗车店（演示）",
        district: "伪造区",
        address: "伪造地址 1 号",
        latitude: 39.12,
        longitude: 117.2,
      },
    });
    assert.equal(missingLocation.statusCode, 400, missingLocation.body);
    assert.equal(missingLocation.json<Json>().error.code, "WASH_STORE_LOCATION_REQUIRED");

    const unsignedLocation = { ...firstLocation };
    delete unsignedLocation.locationProof;
    const missingProof = await washAdminInject(app, {
      method: "POST",
      url: "/api/admin/wash/stores",
      payload: {
        ...storePayload,
        name: "缺失定位凭证测试洗车店（演示）",
        location: unsignedLocation,
      },
    });
    assert.equal(missingProof.statusCode, 409, missingProof.body);
    assert.equal(missingProof.json<Json>().error.code, "WASH_STORE_LOCATION_PROOF_INVALID");

    const tamperedLocation = await washAdminInject(app, {
      method: "POST",
      url: "/api/admin/wash/stores",
      payload: {
        ...storePayload,
        name: "篡改定位测试洗车店（演示）",
        location: { ...firstLocation, longitude: firstLocation.longitude + 0.01 },
      },
    });
    assert.equal(tamperedLocation.statusCode, 409, tamperedLocation.body);
    assert.equal(tamperedLocation.json<Json>().error.code, "WASH_STORE_LOCATION_PROOF_INVALID");

    const createdResponse = await washAdminInject(app, {
      method: "POST",
      url: "/api/admin/wash/stores",
      payload: {
        ...storePayload,
        location: firstLocation,
        district: "伪造区",
        address: "伪造地址 2 号",
        latitude: 38.5,
        longitude: 116.7,
      },
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = createdResponse.json<Json>().data;
    assert.equal(created.district, firstLocation.district);
    assert.equal(created.address, firstLocation.address);
    assert.equal(created.latitude, firstLocation.latitude);
    assert.equal(created.longitude, firstLocation.longitude);

    const preservedResponse = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${created.id}`,
      payload: {
        ...storePayload,
        name: created.name,
        description: "只修改非位置字段",
        district: "伪造区",
        address: "伪造地址 3 号",
        latitude: 40.2,
        longitude: 118.1,
      },
    });
    assert.equal(preservedResponse.statusCode, 200, preservedResponse.body);
    const preserved = preservedResponse.json<Json>().data;
    assert.equal(preserved.description, "只修改非位置字段");
    assert.equal(preserved.district, firstLocation.district);
    assert.equal(preserved.address, firstLocation.address);
    assert.equal(preserved.latitude, firstLocation.latitude);
    assert.equal(preserved.longitude, firstLocation.longitude);

    const secondSuggestions = await app.inject({
      method: "GET",
      url: "/api/locations/suggestions?query=天津站",
    });
    assert.equal(secondSuggestions.statusCode, 200, secondSuggestions.body);
    const secondLocation = secondSuggestions.json<Json>().data[0];
    assert.ok(secondLocation);
    assert.notEqual(secondLocation.poiId, firstLocation.poiId);

    const relocatedResponse = await washAdminInject(app, {
      method: "PUT",
      url: `/api/admin/wash/stores/${created.id}`,
      payload: {
        ...storePayload,
        name: created.name,
        location: secondLocation,
        district: "另一个伪造区",
        address: "另一个伪造地址",
        latitude: 38.6,
        longitude: 116.8,
      },
    });
    assert.equal(relocatedResponse.statusCode, 200, relocatedResponse.body);
    const relocated = relocatedResponse.json<Json>().data;
    assert.equal(relocated.district, secondLocation.district);
    assert.equal(relocated.address, secondLocation.address);
    assert.equal(relocated.latitude, secondLocation.latitude);
    assert.equal(relocated.longitude, secondLocation.longitude);
  } finally {
    await close();
  }
});

test("洗车门店在生产环境拒绝带有效签名的演示位置", async () => {
  const originalEnvironment = process.env.YUXIAOMAN_ENV;
  const originalProofSecret = process.env.WASH_LOCATION_PROOF_SECRET;
  const originalBackofficeOrigins = process.env.BACKOFFICE_ALLOWED_ORIGINS;
  const { app, close } = await fixture();
  try {
    process.env.YUXIAOMAN_ENV = "production";
    process.env.WASH_LOCATION_PROOF_SECRET = "wash-store-location-production-test-secret-2026";
    process.env.BACKOFFICE_ALLOWED_ORIGINS = "https://admin.example.test";
    const demoLocation = {
      poiId: "demo-production-forbidden",
      title: "生产环境演示门店",
      address: "和平区演示地址 1 号",
      district: "和平区",
      latitude: 39.12,
      longitude: 117.2,
      source: "demo" as const,
    };
    const response = await washAdminInject(app, {
      method: "POST",
      url: "/api/admin/wash/stores",
      headers: { origin: "https://admin.example.test" },
      payload: {
        name: "生产环境演示定位测试门店",
        location: { ...demoLocation, locationProof: createWashLocationProof(demoLocation) },
        phone: null,
        description: "不应创建",
        tags: [],
        facilities: [],
        openHours: "09:00-18:00",
        weeklySchedule: {
          mon: [{ start: "09:00", end: "18:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
        },
        businessHoursNotice: null,
        advanceBookingDays: 14,
        rating: 0,
        reviewCount: 0,
        dataKind: "demo",
        isActive: true,
        sortPriority: 0,
        internalContact: null,
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json<Json>().error.code, "WASH_STORE_LOCATION_PROOF_INVALID");
  } finally {
    if (originalEnvironment === undefined) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = originalEnvironment;
    if (originalProofSecret === undefined) delete process.env.WASH_LOCATION_PROOF_SECRET;
    else process.env.WASH_LOCATION_PROOF_SECRET = originalProofSecret;
    if (originalBackofficeOrigins === undefined) delete process.env.BACKOFFICE_ALLOWED_ORIGINS;
    else process.env.BACKOFFICE_ALLOWED_ORIGINS = originalBackofficeOrigins;
    await close();
  }
});

test("检测后台关键写操作只生成语义审计且与业务变更原子提交", async () => {
  const { app, database, close } = await fixture();
  try {
    const countAction = async (action: string) => Number((await database.prepare<Json>(`
      SELECT COUNT(*)::int AS count FROM backoffice_audit_events WHERE action = ?
    `).get(action))?.count ?? 0);

    const originalRule = (await app.inject({ method: "GET", url: "/api/admin/valet-rules" })).json<Json>().data;
    assert.equal(await countAction("inspection.valet_rule.global_update"), 0);
    const changedRule = { ...originalRule, baseFeeFen: originalRule.baseFeeFen + 100 };
    const firstUpdate = await app.inject({ method: "PUT", url: "/api/admin/valet-rules", payload: changedRule });
    assert.equal(firstUpdate.statusCode, 200, firstUpdate.body);
    assert.equal(await countAction("inspection.valet_rule.global_update"), 1);

    const noOpUpdate = await app.inject({ method: "PUT", url: "/api/admin/valet-rules", payload: changedRule });
    assert.equal(noOpUpdate.statusCode, 200, noOpUpdate.body);
    assert.equal(await countAction("inspection.valet_rule.global_update"), 1);
    const semanticEvent = await database.prepare<Json>(`
      SELECT before_json, after_json, metadata_json FROM backoffice_audit_events
      WHERE action = 'inspection.valet_rule.global_update' ORDER BY occurred_at DESC LIMIT 1
    `).get();
    assert.ok(semanticEvent);
    const metadata = typeof semanticEvent.metadata_json === "string"
      ? JSON.parse(semanticEvent.metadata_json)
      : semanticEvent.metadata_json;
    assert.equal(metadata.presentation.actionLabel, "修改全局取送计价规则");
    assert.equal(metadata.presentation.category, "inspection");
    assert.ok(metadata.presentation.changes.some((item: Json) => item.label === "往返起步价"));

    await database.query(`
      CREATE OR REPLACE FUNCTION fail_test_inspection_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'inspection.valet_rule.global_update' THEN
          RAISE EXCEPTION 'forced inspection audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await database.query(`
      CREATE TRIGGER fail_test_inspection_audit
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_inspection_audit()
    `);
    const failedRule = { ...changedRule, baseFeeFen: changedRule.baseFeeFen + 100 };
    const failedUpdate = await app.inject({ method: "PUT", url: "/api/admin/valet-rules", payload: failedRule });
    assert.equal(failedUpdate.statusCode, 500, failedUpdate.body);
    const persistedRule = (await app.inject({ method: "GET", url: "/api/admin/valet-rules" })).json<Json>().data;
    assert.equal(persistedRule.baseFeeFen, changedRule.baseFeeFen);
    assert.equal(await countAction("inspection.valet_rule.global_update"), 1);

    const stations = (await app.inject({ method: "GET", url: "/api/admin/stations" })).json<Json>().data;
    const editableStation = stations.find((item: Json) => item.id === DEMO_STATION_ID) ?? stations[0];
    const stationUpdate = await app.inject({
      method: "PUT",
      url: `/api/admin/stations/${editableStation.id}`,
      payload: { ...editableStation, businessHoursNotice: "节假日营业安排已由运营确认" },
    });
    assert.equal(stationUpdate.statusCode, 200, stationUpdate.body);
    assert.equal(await countAction("inspection.station.update"), 1);
    const stationEvent = await database.prepare<Json>(`
      SELECT before_json, after_json, metadata_json FROM backoffice_audit_events
      WHERE action = 'inspection.station.update' AND resource_id = ?
      ORDER BY occurred_at DESC LIMIT 1
    `).get(editableStation.id);
    assert.ok(stationEvent);
    if (editableStation.internalContact?.phone) {
      assert.equal(JSON.stringify(stationEvent).includes(editableStation.internalContact.phone), false);
    }

    const bookings = (await app.inject({ method: "GET", url: "/api/admin/bookings" })).json<Json>().data;
    const paidBooking = bookings.find((item: Json) => (item.paidFen ?? 0) > (item.refundedFen ?? 0));
    assert.ok(paidBooking);
    const noteOnly = await app.inject({
      method: "PATCH",
      url: `/api/admin/bookings/${paidBooking.id}`,
      payload: { internalDriverNote: "仅用于调度，不应进入操作日志" },
    });
    assert.equal(noteOnly.statusCode, 200, noteOnly.body);
    assert.equal(await countAction("booking.fulfillment.update"), 0);

    const refundPayload = {
      internalDriverNote: "随退款请求提交但不展示内容",
      refund: { amountFen: 1, reason: "运营核对后退款", idempotencyKey: `audit-refund-${paidBooking.id}` },
    };
    const refund = await app.inject({ method: "PATCH", url: `/api/admin/bookings/${paidBooking.id}`, payload: refundPayload });
    assert.equal(refund.statusCode, 200, refund.body);
    assert.equal(await countAction("booking.refund.record"), 1);
    const repeatedRefund = await app.inject({ method: "PATCH", url: `/api/admin/bookings/${paidBooking.id}`, payload: refundPayload });
    assert.equal(repeatedRefund.statusCode, 200, repeatedRefund.body);
    assert.equal(await countAction("booking.refund.record"), 1);
    const refundEvent = await database.prepare<Json>(`
      SELECT before_json, after_json, metadata_json FROM backoffice_audit_events
      WHERE action = 'booking.refund.record' ORDER BY occurred_at DESC LIMIT 1
    `).get();
    const serializedRefund = JSON.stringify(refundEvent);
    const bookingVehicle = await database.prepare<Json>(`
      SELECT v.plate_number FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = ?
    `).get(paidBooking.id);
    assert.ok(bookingVehicle?.plate_number);
    assert.equal(serializedRefund.includes(String(bookingVehicle.plate_number)), false);
    assert.match(serializedRefund, /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z]\*\*\*[A-HJ-NP-Z0-9]/u);
    assert.equal(serializedRefund.includes("audit-refund-"), false);
    assert.equal(serializedRefund.includes("随退款请求提交"), false);
    assert.equal(serializedRefund.includes("运营核对后退款"), false);
  } finally {
    await close();
  }
});

test("支付提供方探测与 mock 支付仍可用；未配置微信时 wechat 返回 503", async () => {
  const { app, close } = await fixture();
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_MOCK_PAYMENT: process.env.ALLOW_MOCK_PAYMENT,
    WECHAT_PAY_MCH_ID: process.env.WECHAT_PAY_MCH_ID,
    WECHAT_PAY_API_V3_KEY: process.env.WECHAT_PAY_API_V3_KEY,
    WECHAT_PAY_CERT_SERIAL: process.env.WECHAT_PAY_CERT_SERIAL,
    WECHAT_PAY_PRIVATE_KEY_PATH: process.env.WECHAT_PAY_PRIVATE_KEY_PATH,
    WECHAT_PAY_NOTIFY_URL: process.env.WECHAT_PAY_NOTIFY_URL,
    WECHAT_PAY_PUBLIC_KEY_PATH: process.env.WECHAT_PAY_PUBLIC_KEY_PATH,
    WECHAT_PAY_PUBLIC_KEY_ID: process.env.WECHAT_PAY_PUBLIC_KEY_ID,
  };
  try {
    process.env.NODE_ENV = "test";
    process.env.ALLOW_MOCK_PAYMENT = "true";
    for (const key of [
      "WECHAT_PAY_MCH_ID",
      "WECHAT_PAY_API_V3_KEY",
      "WECHAT_PAY_CERT_SERIAL",
      "WECHAT_PAY_PRIVATE_KEY_PATH",
      "WECHAT_PAY_NOTIFY_URL",
      "WECHAT_PAY_PUBLIC_KEY_PATH",
      "WECHAT_PAY_PUBLIC_KEY_ID",
    ]) {
      delete process.env[key];
    }
    const { resetWechatPayConfigCache } = await import("../wechat-pay.js");
    resetWechatPayConfigCache();

    const provider = await app.inject({ method: "GET", url: "/api/payments/provider" });
    assert.equal(provider.statusCode, 200, provider.body);
    assert.equal(provider.json<Json>().data.wechatConfigured, false);
    assert.equal(provider.json<Json>().data.provider, "mock");

    const { vehicle, station, slots } = await seedContext(app);
    const created = await createBooking(app, { vehicleId: vehicle.id, stationId: station.id, slotId: slots[0].id });
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json<Json>().data;

    const mockPaid = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/payments`,
      payload: {
        provider: "mock",
        idempotencyKey: "wechat-gate-mock-pay-0001",
        quoteSnapshotId: booking.quoteSnapshotId,
      },
    });
    assert.equal(mockPaid.statusCode, 201, mockPaid.body);
    assert.equal(mockPaid.json<Json>().data.booking.paymentStatus, "paid");
    assert.equal(mockPaid.json<Json>().data.payment.status, "confirmed");
    assert.equal(mockPaid.json<Json>().data.wechatPay, undefined);

    const unpaidVehicle = await createVehicle(app, "测A88888");
    const unpaid = await createBooking(app, {
      vehicleId: unpaidVehicle.id,
      stationId: station.id,
      slotId: slots[1]?.id ?? slots[0].id,
    });
    assert.equal(unpaid.statusCode, 201, unpaid.body);
    const unpaidBooking = unpaid.json<Json>().data;
    const wechatUnavailable = await app.inject({
      method: "POST",
      url: `/api/bookings/${unpaidBooking.id}/payments`,
      payload: {
        provider: "wechat",
        idempotencyKey: "wechat-gate-missing-config-0001",
        quoteSnapshotId: unpaidBooking.quoteSnapshotId,
      },
    });
    assert.equal(wechatUnavailable.statusCode, 503, wechatUnavailable.body);
    assert.equal(wechatUnavailable.json<Json>().error.code, "WECHAT_PAY_NOT_CONFIGURED");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const { resetWechatPayConfigCache } = await import("../wechat-pay.js");
    resetWechatPayConfigCache();
    await close();
  }
});
