#!/usr/bin/env node

/**
 * Local-only, non-destructive annual-inspection closure QA.
 *
 * Targets the already-running isolated QA server. It never resets or deletes
 * schema data. A checkpoint file makes the run resumable after the first
 * successfully-created booking.
 *
 * Scenario identities and source-photo filenames are intentionally loaded from
 * a gitignored local manifest. Never place real plate numbers, vehicle IDs,
 * download identifiers, or personal filesystem paths in this tracked script.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../..");
const PRIVATE_RUNTIME_ROOT = resolve(PROJECT_ROOT, ".runtime");
const BASE_URL = (process.env.QA_API_BASE_URL ?? "http://127.0.0.1:8792").replace(/\/$/u, "");
const ARTIFACT_DIR = resolve(
  process.env.QA_ARTIFACT_DIR
    ?? join(PRIVATE_RUNTIME_ROOT, "private-audit", "full-inspection-closure-20260826"),
);
const CONFIG_PATH = resolve(
  process.env.QA_SCENARIO_CONFIG_PATH ?? join(ARTIFACT_DIR, "scenario-config.local.json"),
);
function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
assert.ok(
  !isInside(PROJECT_ROOT, ARTIFACT_DIR) || isInside(PRIVATE_RUNTIME_ROOT, ARTIFACT_DIR),
  "QA_ARTIFACT_DIR may not point into the project outside .runtime",
);
assert.ok(
  !isInside(PROJECT_ROOT, CONFIG_PATH) || isInside(PRIVATE_RUNTIME_ROOT, CONFIG_PATH),
  "QA_SCENARIO_CONFIG_PATH may not point into the project outside .runtime",
);
mkdirSync(ARTIFACT_DIR, { recursive: true });
assert.ok(
  existsSync(CONFIG_PATH),
  `Private QA manifest not found: ${CONFIG_PATH}. Copy scenario-config.example.json there, replace every placeholder, and keep the local file under .runtime.`,
);
const qaConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const configuredPhotoDirectory = process.env.QA_PHOTO_DIR ?? qaConfig.photoDirectory;
assert.ok(configuredPhotoDirectory, "QA_PHOTO_DIR or manifest.photoDirectory is required");
const PHOTO_DIR = resolve(configuredPhotoDirectory);
const STATE_PATH = join(ARTIFACT_DIR, "service-closure-state.json");
const RESULT_PATH = join(ARTIFACT_DIR, "service-closure-result.json");
const RUN_KEY = "full-inspection-closure-20260826-v1";
const STATION_ID = "station-hexi-1";
const ADMIN_ORIGIN = process.env.QA_ADMIN_ORIGIN ?? "http://127.0.0.1:5174";

const ADMIN_LOGIN = process.env.QA_ADMIN_LOGIN ?? "qa-fullclosure-admin";
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD;
const OPERATOR_LOGIN = process.env.QA_OPERATOR_LOGIN ?? "qa-fullclosure-station";
const OPERATOR_PASSWORD = process.env.QA_OPERATOR_PASSWORD;

const SITE_KINDS = ["front_left", "front_right", "rear_left", "rear_right", "dashboard_started"];
const SCENARIOS = qaConfig.scenarios;
assert.ok(SCENARIOS?.selfFailed && SCENARIOS?.valetPassed, "Manifest must define selfFailed and valetPassed scenarios");
for (const scenario of Object.values(SCENARIOS)) {
  assert.ok(scenario.plateNumber && !String(scenario.plateNumber).includes("<"), "Replace every plateNumber placeholder");
  assert.ok(scenario.photos && SITE_KINDS.every((kind) => scenario.photos[kind]), "Each scenario needs five site photos");
  assert.ok(scenario.photos.license_front && scenario.photos.license_back, "Each scenario needs two license photos");
}

class QaApiError extends Error {
  constructor(method, path, status, payload) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(payload)}`);
    this.name = "QaApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.payload = payload;
    this.code = payload?.error?.code ?? null;
  }
}

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { runKey: RUN_KEY, scenarios: {}, startedAt: new Date().toISOString() };

// Authentication material is intentionally memory-only. Remove credentials
// written by an interrupted older version of this local script.
delete state.adminCookie;
delete state.operatorToken;
for (const scenarioState of Object.values(state.scenarios ?? {})) delete scenarioState.driverToken;

let adminCookie = "";
let operatorToken = "";

if (state.runKey !== RUN_KEY) {
  throw new Error(`Checkpoint belongs to a different run: ${state.runKey}`);
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function log(step, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`[qa] ${step}${suffix}`);
}

function plateNormalized(value) {
  return String(value ?? "").replace(/[·\s-]/gu, "").toUpperCase();
}

async function request(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  let body = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  const accepted = options.accept ?? [200, 201];
  if (!accepted.includes(response.status)) {
    throw new QaApiError(method, path, response.status, payload);
  }
  return { status: response.status, data: payload?.data, meta: payload?.meta, headers: response.headers };
}

function adminHeaders() {
  assert.ok(adminCookie, "Admin cookie is missing");
  return { cookie: adminCookie, origin: ADMIN_ORIGIN };
}

function operatorHeaders() {
  assert.ok(operatorToken, "Operator token is missing");
  return { authorization: `Bearer ${operatorToken}` };
}

function driverHeaders(driverToken) {
  assert.ok(driverToken, "Driver token is missing");
  return { authorization: `Bearer ${driverToken}` };
}

async function login() {
  assert.ok(ADMIN_PASSWORD, "QA_ADMIN_PASSWORD is required");
  assert.ok(OPERATOR_PASSWORD, "QA_OPERATOR_PASSWORD is required");
  const health = await request("/api/health");
  assert.equal(health.data.status, "ok");

  const adminResponse = await fetch(`${BASE_URL}/api/backoffice/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
    body: JSON.stringify({ loginName: ADMIN_LOGIN, password: ADMIN_PASSWORD }),
  });
  const adminPayload = await adminResponse.json();
  if (!adminResponse.ok) {
    throw new QaApiError("POST", "/api/backoffice/sessions", adminResponse.status, adminPayload);
  }
  const setCookie = adminResponse.headers.getSetCookie?.()[0] ?? adminResponse.headers.get("set-cookie") ?? "";
  assert.ok(setCookie, "Backoffice login did not return a cookie");
  adminCookie = setCookie.split(";", 1)[0];

  const operator = await request("/api/operator/sessions", {
    method: "POST",
    json: { loginName: OPERATOR_LOGIN, password: OPERATOR_PASSWORD },
  });
  assert.equal(operator.data.account.role, "inspection_station_admin");
  operatorToken = operator.data.token;
  saveState();
  log("authenticated", `admin=${ADMIN_LOGIN} operator=${OPERATOR_LOGIN}`);
}

function photoPath(fileName) {
  assert.equal(isAbsolute(fileName), false, "Photo manifest entries must be filenames relative to photoDirectory");
  const path = resolve(PHOTO_DIR, fileName);
  const relativePath = relative(PHOTO_DIR, path);
  assert.ok(relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath), "Photo path escaped photoDirectory");
  assert.ok(existsSync(path), `Photo file not found: ${fileName}`);
  return path;
}

function validatePhotoInputs() {
  const used = new Set(Object.values(SCENARIOS).flatMap((scenario) => Object.values(scenario.photos)));
  for (const fileName of used) {
    const path = photoPath(fileName);
    assert.ok(readFileSync(path).length > 0, `Empty photo: ${path}`);
  }
  log("photo inputs validated", `${used.size} unique source files`);
}

async function uploadMultipart(path, kind, fileName, headers = {}, idempotencyKey = null) {
  const filePath = photoPath(fileName);
  const form = new FormData();
  if (kind) form.append("kind", kind);
  form.append("file", new Blob([readFileSync(filePath)], { type: "image/jpeg" }), `${kind ?? "photo"}.jpg`);
  const requestHeaders = { ...headers };
  if (idempotencyKey) requestHeaders["idempotency-key"] = idempotencyKey;
  return request(path, { method: "POST", headers: requestHeaders, body: form, accept: [200, 201] });
}

async function ownerBooking(id) {
  return (await request(`/api/bookings/${encodeURIComponent(id)}`)).data;
}

async function operatorBooking(id) {
  return (await request(`/api/operator/bookings/${encodeURIComponent(id)}`, {
    headers: operatorHeaders(),
  })).data;
}

async function adminBooking(id) {
  return (await request(`/api/admin/bookings/${encodeURIComponent(id)}`, {
    headers: adminHeaders(),
  })).data;
}

async function ensureVehicle(scenario) {
  const expectedPlate = plateNormalized(scenario.plateNumber);
  const vehicles = (await request("/api/vehicles")).data;
  let vehicle = vehicles.find((item) => plateNormalized(item.plateNumber) === expectedPlate);
  if (!vehicle && scenario.createVehicle) {
    vehicle = (await request("/api/vehicles", {
      method: "POST",
      json: {
        ...scenario.createVehicle,
        plateNumber: scenario.plateNumber,
        registrationDate: scenario.registrationDate ?? scenario.createVehicle.registrationDate,
      },
    })).data;
    log("vehicle created", `${scenario.key} ${vehicle.id}`);
  }
  assert.ok(vehicle, `Configured vehicle for ${scenario.key} not found`);
  assert.equal(plateNormalized(vehicle.plateNumber), expectedPlate);
  if (scenario.expectedVehicleId) assert.equal(vehicle.id, scenario.expectedVehicleId);
  if (scenario.registrationDate) assert.equal(vehicle.registrationDate, scenario.registrationDate);
  return vehicle;
}

async function resolveValetPickup(scenario) {
  const pickupQuery = scenario.pickup?.query ?? "演示取车点";
  const suggestions = await request(`/api/locations/suggestions?query=${encodeURIComponent(pickupQuery)}`);
  const selected = suggestions.data.find((item) => item.source === "tencent") ?? suggestions.data[0];
  assert.ok(selected, "No pickup address suggestion returned");
  assert.ok(selected.locationProof, "Pickup address has no server-issued location proof");
  return { ...selected, detail: scenario.pickup?.detail ?? "演示测试车位", note: RUN_KEY };
}

function slotStart(slot) {
  return Date.parse(`${slot.date}T${slot.startTime}:00+08:00`);
}

async function chooseSlot(index) {
  const slots = (await request(`/api/stations/${STATION_ID}/slots`)).data
    .filter((item) => item.remaining > 0 && slotStart(item) > Date.now() + 30 * 60 * 1000);
  assert.ok(slots.length > index, "Not enough future station slots for both scenarios");
  return slots[index];
}

async function findExistingBooking(scenario, scenarioState) {
  if (scenarioState.bookingId) {
    try {
      const existing = await ownerBooking(scenarioState.bookingId);
      assert.equal(existing.notes, scenario.marker);
      return existing;
    } catch (error) {
      if (!(error instanceof QaApiError) || error.status !== 404) throw error;
    }
  }
  const list = (await request("/api/bookings")).data;
  return list.find((item) => item.notes === scenario.marker) ?? null;
}

async function uploadBookingMedia(scenario) {
  const mapping = scenario.photos;
  const kinds = scenario.serviceMode === "self_drive"
    ? [
        ["vehicle_front_left", mapping.front_left],
        ["vehicle_front_right", mapping.front_right],
        ["vehicle_rear_left", mapping.rear_left],
        ["vehicle_rear_right", mapping.rear_right],
        ["dashboard_started", mapping.dashboard_started],
        ["license_front", mapping.license_front],
        ["license_back", mapping.license_back],
      ]
    : [
        ["license_front", mapping.license_front],
        ["license_back", mapping.license_back],
      ];
  return Promise.all(kinds.map(async ([kind, msgId]) => (await uploadMultipart("/api/media", kind, msgId)).data));
}

async function ensureBooking(scenario, vehicle, slotIndex) {
  const scenarioState = state.scenarios[scenario.key] ??= {};
  let booking = await findExistingBooking(scenario, scenarioState);
  if (booking) {
    scenarioState.bookingId = booking.id;
    saveState();
    log("booking resumed", `${scenario.key} ${booking.id} ${booking.fulfillmentStatus}`);
    return booking;
  }

  const pickupAddress = scenario.serviceMode === "valet" ? await resolveValetPickup(scenario) : undefined;
  const quotePayload = {
    vehicleId: vehicle.id,
    stationId: STATION_ID,
    serviceMode: scenario.serviceMode,
    ...(pickupAddress ? { pickupAddress, tripType: "round_trip_same_address" } : {}),
  };
  const quote = (await request("/api/bookings/quote", { method: "POST", json: quotePayload })).data;
  assert.ok(quote.serviceFeeFen > 0, "Quote amount must be non-zero");
  if (scenario.serviceMode === "valet") {
    assert.equal(quote.distanceSource, "tencent_matrix");
    assert.ok(quote.valetFeeFen > 0);
  }
  const slot = await chooseSlot(slotIndex);
  const media = await uploadBookingMedia(scenario);
  booking = (await request("/api/bookings", {
    method: "POST",
    json: {
      vehicleId: vehicle.id,
      stationId: STATION_ID,
      slotId: slot.id,
      contactName: scenario.contact?.name ?? "演示联系人",
      contactPhone: scenario.contact?.phone ?? "13800000000",
      serviceMode: scenario.serviceMode,
      tripType: "round_trip_same_address",
      ...(pickupAddress ? { pickupAddress } : {}),
      quoteSnapshotId: quote.quoteSnapshotId,
      mediaIds: media.map((item) => item.id),
      notes: scenario.marker,
    },
  })).data;
  assert.equal(booking.serviceFeeFen, quote.serviceFeeFen);
  assert.equal(booking.quoteSnapshotId, quote.quoteSnapshotId);
  assert.equal(booking.media.length, scenario.serviceMode === "self_drive" ? 7 : 2);
  scenarioState.bookingId = booking.id;
  scenarioState.quote = quote;
  scenarioState.slot = slot;
  saveState();
  log("booking created", `${scenario.key} ${booking.bookingNumber} ¥${(quote.serviceFeeFen / 100).toFixed(2)}`);
  return booking;
}

async function ensurePaid(scenario, booking) {
  if (booking.paymentStatus === "paid") return booking;
  assert.equal(booking.fulfillmentStatus, "pending_payment");
  if (Date.parse(booking.quoteExpiresAt) < Date.now() + 60_000) {
    const requoted = await request(`/api/bookings/${booking.id}/requote`, {
      method: "POST",
      json: { expectedQuoteSnapshotId: booking.quoteSnapshotId },
    });
    booking = requoted.data.booking;
    state.scenarios[scenario.key].quote = requoted.data.quote;
    saveState();
  }
  const paymentKey = `${RUN_KEY}-${scenario.key}-mock-payment`;
  const paid = await request(`/api/bookings/${booking.id}/payments`, {
    method: "POST",
    json: { provider: "mock", idempotencyKey: paymentKey, quoteSnapshotId: booking.quoteSnapshotId },
  });
  assert.equal(paid.data.payment.status, "confirmed");
  assert.equal(paid.data.payment.amountFen, paid.data.booking.serviceFeeFen);
  assert.equal(paid.data.booking.paidFen, paid.data.booking.serviceFeeFen);
  assert.equal(paid.data.booking.amountDueFen, 0);
  assert.equal(paid.data.booking.fulfillmentStatus, "confirmed");
  state.scenarios[scenario.key].payment = paid.data.payment;
  saveState();
  log("mock payment confirmed", `${scenario.key} ¥${(paid.data.payment.amountFen / 100).toFixed(2)}`);
  return paid.data.booking;
}

async function postOperator(bookingId, action, json = undefined) {
  return (await request(`/api/operator/bookings/${bookingId}/${action}`, {
    method: "POST",
    headers: operatorHeaders(),
    ...(json === undefined ? {} : { json }),
  })).data;
}

async function prepareReport(scenario, bookingId) {
  let report = (await request(`/api/operator/bookings/${bookingId}/checkup-report`, {
    headers: operatorHeaders(),
  })).data;
  if (report?.status === "published") return report;

  const failureDetails = scenario.conclusion === "failed"
    ? {
        itemCategories: ["instrumented_test"],
        reason: "制动性能检测项目未达到规定限值。此结论来自正式年检项目，不由车身外观记录推导。",
        reinspectionAdvice: "检修制动系统并完成制动性能复测后，按检测站通知申请复检。",
      }
    : null;
  const hasIndependentBodyFault = Boolean(scenario.hasIndependentBodyFault);
  const draft = await request(`/api/operator/bookings/${bookingId}/checkup-report`, {
    method: "PUT",
    headers: operatorHeaders(),
    json: {
      ...(report?.rowVersion ? { rowVersion: report.rowVersion } : {}),
      observationMode: hasIndependentBodyFault ? "faults_recorded" : "no_visible_faults",
      diagramVersion: "sedan-3view-v1",
      annualInspection: {
        conclusion: scenario.conclusion,
        ...(failureDetails ? { failureDetails } : {}),
      },
      summary: {
        conclusionLabel: scenario.conclusion === "passed" ? "年检通过" : "年检未通过",
        qaMarker: scenario.marker,
        bodyConditionIndependent: true,
      },
      faults: hasIndependentBodyFault
        ? [{
            clientKey: `${RUN_KEY}-right-rear-quarter-scratch`,
            viewId: "right",
            regionCode: "right_rear_quarter",
            faultType: "scratch",
            severity: "minor",
            description: "右后翼子板轻微划痕；仅为车况留档，不影响本次年检合格结论。",
          }]
        : [],
    },
  });
  report = draft.data;

  for (const kind of SITE_KINDS) {
    await uploadMultipart(
      `/api/operator/bookings/${bookingId}/checkup-report/media`,
      kind,
      scenario.photos[kind],
      operatorHeaders(),
    );
  }
  if (scenario.conclusion === "passed") {
    await uploadMultipart(
      `/api/operator/bookings/${bookingId}/checkup-report/media`,
      "annual_inspection_mark",
      scenario.photos.annual_inspection_mark,
      operatorHeaders(),
    );
  }
  if (hasIndependentBodyFault) {
    const fault = report.faults.find((item) => item.clientKey === `${RUN_KEY}-right-rear-quarter-scratch`);
    assert.ok(fault, "Independent body fault was not persisted");
    await uploadMultipart(
      `/api/operator/bookings/${bookingId}/checkup-report/faults/${fault.id}/photos`,
      null,
      scenario.photos.rear_right,
      operatorHeaders(),
      `${RUN_KEY}-valet-body-fault-photo`,
    );
  }
  return (await request(`/api/operator/bookings/${bookingId}/checkup-report`, {
    headers: operatorHeaders(),
  })).data;
}

async function publishReport(scenario, bookingId) {
  const prepared = await prepareReport(scenario, bookingId);
  assert.equal(prepared.annualInspection.conclusion, scenario.conclusion);
  assert.notEqual(prepared.annualInspection.conclusion, "conditional");
  if (scenario.conclusion === "failed") {
    assert.equal(prepared.faults.length, 0, "Annual failure must not fabricate a body fault");
    assert.equal(prepared.annualInspection.failureDetailsStatus, "complete");
  } else {
    assert.equal(prepared.faults.length, 1, "Passed report should retain the independent body fault");
    assert.equal(prepared.faults[0].photos.length, 1);
  }
  const published = await request(`/api/operator/bookings/${bookingId}/inspection-result`, {
    method: "POST",
    headers: { ...operatorHeaders(), "idempotency-key": `${RUN_KEY}-${scenario.key}-publish` },
    json: {},
  });
  assert.equal(published.data.fulfillmentStatus, "result_received");
  assert.equal(published.data.inspectionResult.conclusion, scenario.conclusion);
  assert.notEqual(published.data.inspectionResult.conclusion, "conditional");
  log("inspection result published", `${scenario.key} ${scenario.conclusion}`);
  return published.data;
}

async function runSelfDrive(scenario, booking) {
  for (let guard = 0; guard < 10; guard += 1) {
    booking = await operatorBooking(booking.id);
    switch (booking.fulfillmentStatus) {
      case "confirmed":
        await postOperator(booking.id, "accept");
        break;
      case "awaiting_arrival":
        await postOperator(booking.id, "check-in", {
          plateMatched: true,
          materialsReady: true,
          exteriorRecorded: true,
          vehicleConditionConfirmed: true,
          notes: scenario.marker,
        });
        break;
      case "checked_in":
        await postOperator(booking.id, "handoff");
        break;
      case "inspecting":
        await publishReport(scenario, booking.id);
        break;
      case "result_received":
        await postOperator(booking.id, "complete");
        break;
      case "completed":
        return booking;
      default:
        throw new Error(`Unexpected self-drive status ${booking.fulfillmentStatus}`);
    }
  }
  throw new Error("Self-drive workflow guard exhausted");
}

async function ensureDriverSession(scenario, booking) {
  const scenarioState = state.scenarios[scenario.key];
  if (booking.fulfillmentStatus === "confirmed") {
    const assigned = await request(`/api/admin/bookings/${booking.id}/driver-assignment`, {
      method: "POST",
      headers: adminHeaders(),
      json: {
        receptionistName: scenario.driver?.name ?? "演示司机",
        receptionistPhone: scenario.driver?.phone ?? "13900000000",
      },
    });
    scenarioState.verificationCode = assigned.data.verificationCode
      ?? assigned.data.assignment?.verificationCode;
    saveState();
    log("driver assigned", scenario.key);
  }
  const exchangePayload = scenarioState.verificationCode
    ? { verificationCode: scenarioState.verificationCode }
    : scenarioState.taskCode
      ? { taskCode: scenarioState.taskCode }
      : null;
  assert.ok(exchangePayload, "Existing valet assignment has no checkpointed local credential");
  const exchanged = await request("/api/driver/task-sessions/exchange", {
    method: "POST",
    json: exchangePayload,
  });
  saveState();
  return exchanged.data.token;
}

async function completeEvidenceStage(scenario, bookingId, stage, driverToken) {
  const booking = await ownerBooking(bookingId);
  const pack = booking.evidencePackages.find((item) => item.stage === stage);
  assert.ok(pack, `Missing evidence package ${stage}`);
  if (pack.status === "completed") return;

  const operatorStage = stage === "station_arrival";
  const prefix = operatorStage ? "/api/operator/bookings" : "/api/driver/tasks";
  const headers = operatorStage ? operatorHeaders() : driverHeaders(driverToken);
  for (const kind of SITE_KINDS) {
    await uploadMultipart(
      `${prefix}/${bookingId}/evidence/${stage}/media`,
      kind,
      scenario.photos[kind],
      headers,
    );
  }
  const completion = await request(`${prefix}/${bookingId}/evidence/${stage}/complete`, {
    method: "POST",
    headers,
    json: {
      idempotencyKey: `${RUN_KEY}-${scenario.key}-${stage}-complete`,
      ...(operatorStage
        ? {
            verification: {
              plateMatched: true,
              materialsReady: true,
              exteriorRecorded: true,
              vehicleConditionConfirmed: true,
              notes: scenario.marker,
            },
          }
        : {}),
    },
  });
  log("evidence completed", `${scenario.key} ${stage} -> ${completion.data.status ?? completion.data.fulfillmentStatus}`);
}

async function runValet(scenario, booking) {
  if (booking.fulfillmentStatus === "completed") return booking;
  const driverToken = await ensureDriverSession(scenario, booking);
  for (let guard = 0; guard < 14; guard += 1) {
    booking = await ownerBooking(booking.id);
    switch (booking.fulfillmentStatus) {
      case "driver_arranged":
        await completeEvidenceStage(scenario, booking.id, "owner_pickup", driverToken);
        break;
      case "picked_up":
        await completeEvidenceStage(scenario, booking.id, "station_arrival", driverToken);
        break;
      case "checked_in":
        await postOperator(booking.id, "handoff");
        break;
      case "inspecting":
        await publishReport(scenario, booking.id);
        break;
      case "result_received":
        await request(`/api/driver/tasks/${booking.id}/start-return`, {
          method: "POST",
          headers: driverHeaders(driverToken),
          json: { idempotencyKey: `${RUN_KEY}-${scenario.key}-start-return` },
        });
        break;
      case "returning":
        await completeEvidenceStage(scenario, booking.id, "owner_return", driverToken);
        break;
      case "completed":
        return booking;
      default:
        throw new Error(`Unexpected valet status ${booking.fulfillmentStatus}`);
    }
  }
  throw new Error("Valet workflow guard exhausted");
}

function assertEventStatuses(actual, expected) {
  const statuses = actual.map((item) => item.status);
  let cursor = -1;
  for (const status of expected) {
    cursor = statuses.indexOf(status, cursor + 1);
    assert.ok(cursor >= 0, `Timeline is missing ordered status ${status}: ${statuses.join(" -> ")}`);
  }
}

async function verifyConsistency(scenario, bookingId) {
  const [owner, operator, admin, ownerReport, operatorReport, adminReport] = await Promise.all([
    ownerBooking(bookingId),
    operatorBooking(bookingId),
    adminBooking(bookingId),
    request(`/api/bookings/${bookingId}/checkup-report`).then((result) => result.data),
    request(`/api/operator/bookings/${bookingId}/checkup-report`, { headers: operatorHeaders() }).then((result) => result.data),
    request(`/api/admin/bookings/${bookingId}/checkup-report`, { headers: adminHeaders() }).then((result) => result.data),
  ]);

  for (const view of [owner, operator, admin]) {
    assert.equal(view.fulfillmentStatus, "completed");
    assert.equal(view.paymentStatus, "paid");
    assert.equal(view.serviceFeeFen, owner.serviceFeeFen);
    assert.equal(view.chargedFen, owner.chargedFen);
    assert.equal(view.paidFen, owner.paidFen);
    assert.equal(view.amountDueFen, 0);
    assert.equal(view.inspectionResult.conclusion, scenario.conclusion);
    assert.notEqual(view.inspectionResult.conclusion, "conditional");
  }
  assert.ok(owner.serviceFeeFen > 0);
  assert.equal(owner.chargedFen, owner.serviceFeeFen);
  assert.equal(owner.paidFen, owner.serviceFeeFen);

  for (const report of [ownerReport, operatorReport, adminReport]) {
    assert.equal(report.status, "published");
    assert.equal(report.annualInspection.conclusion, scenario.conclusion);
    assert.notEqual(report.annualInspection.conclusion, "conditional");
  }
  assert.equal(ownerReport.reportNo, operatorReport.reportNo);
  assert.equal(ownerReport.reportNo, adminReport.reportNo);
  assert.equal(ownerReport.faults.length, scenario.hasIndependentBodyFault ? 1 : 0);
  if (scenario.conclusion === "failed") {
    assert.equal(ownerReport.annualInspection.failureDetailsStatus, "complete");
    assert.deepEqual(ownerReport.annualInspection.failureDetails.itemCategories, ["instrumented_test"]);
    assert.equal(ownerReport.annualInspection.markStatus, "not_issued");
  } else {
    assert.equal(ownerReport.annualInspection.markStatus, "issued");
    assert.equal(ownerReport.faults[0].photos.length, 1);
  }

  if (scenario.serviceMode === "self_drive") {
    assert.equal(owner.media.length, 7);
    assertEventStatuses(owner.events, [
      "pending_payment", "confirmed", "awaiting_arrival", "checked_in", "inspecting", "result_received", "completed",
    ]);
  } else {
    assert.equal(owner.media.length, 2);
    assert.equal(owner.evidencePolicyVersion, "valet-handoff-v1");
    assert.deepEqual(owner.evidencePackages.map((item) => item.stage), [
      "owner_pickup", "station_arrival", "inspection_complete", "owner_return",
    ]);
    for (const pack of owner.evidencePackages) {
      assert.equal(pack.status, "completed");
      assert.equal(pack.photos.length, 5);
    }
    assertEventStatuses(owner.events, [
      "pending_payment", "confirmed", "driver_arranged", "picked_up", "checked_in", "inspecting",
      "result_received", "returning", "completed",
    ]);
  }

  return {
    bookingId,
    bookingNumber: owner.bookingNumber,
    plateNumber: owner.vehicle.plateNumber,
    frozenVehicleRegistrationDate: owner.vehicle.registrationDate,
    serviceMode: owner.serviceMode,
    serviceFeeFen: owner.serviceFeeFen,
    paidFen: owner.paidFen,
    fulfillmentStatus: owner.fulfillmentStatus,
    conclusion: owner.inspectionResult.conclusion,
    reportNo: ownerReport.reportNo,
    bodyFaultCount: ownerReport.faults.length,
    reportMediaKinds: ownerReport.media.map((item) => item.kind),
    evidence: owner.evidencePackages?.map((item) => ({
      stage: item.stage,
      status: item.status,
      photoCount: item.photos.length,
      sourceType: item.sourceType,
    })) ?? [],
    timeline: owner.events.map((item) => ({ status: item.status, actorType: item.actorType, createdAt: item.createdAt })),
    ownerAdminOperatorConsistent: true,
  };
}

async function runScenario(scenario, slotIndex) {
  const vehicle = await ensureVehicle(scenario);
  let booking = await ensureBooking(scenario, vehicle, slotIndex);
  booking = await ensurePaid(scenario, booking);
  if (scenario.serviceMode === "self_drive") await runSelfDrive(scenario, booking);
  else await runValet(scenario, booking);
  const result = await verifyConsistency(scenario, booking.id);
  state.scenarios[scenario.key].verified = true;
  state.scenarios[scenario.key].result = result;
  // The one-task scene is only needed to recover an interrupted in-progress
  // driver run. Remove it once the scenario has closed successfully.
  delete state.scenarios[scenario.key].taskCode;
  delete state.scenarios[scenario.key].verificationCode;
  saveState();
  log("scenario verified", `${scenario.key} ${result.bookingNumber}`);
  return result;
}

async function main() {
  validatePhotoInputs();
  await login();
  const results = [];
  results.push(await runScenario(SCENARIOS.selfFailed, 0));
  results.push(await runScenario(SCENARIOS.valetPassed, 1));

  const reportCenter = await request("/api/vehicle-checkup-reports?limit=20");
  for (const result of results) {
    assert.ok(
      reportCenter.data.items.some((item) => item.reportNo === result.reportNo),
      `Owner report center does not contain ${result.reportNo}`,
    );
  }
  const correctedSedan = await ensureVehicle(SCENARIOS.valetPassed);
  assert.equal(plateNormalized(correctedSedan.plateNumber), plateNormalized(SCENARIOS.valetPassed.plateNumber));
  assert.equal(correctedSedan.registrationDate, SCENARIOS.valetPassed.registrationDate);
  const valetResult = results.find((item) => item.serviceMode === "valet");
  assert.equal(
    valetResult.frozenVehicleRegistrationDate,
    SCENARIOS.valetPassed.registrationDate,
    "Completed booking must retain the registration date read from the supplied license",
  );
  const output = {
    runKey: RUN_KEY,
    apiBaseUrl: BASE_URL,
    completedAt: new Date().toISOString(),
    result: "passed",
    assertions: {
      nonZeroRealTestAmounts: true,
      mockPaymentsMatchFrozenQuotes: true,
      conclusionsAreOnlyPassedOrFailed: true,
      bodyConditionIndependentFromAnnualConclusion: true,
      ownerOperatorAdminConsistent: true,
      valetFourEvidencePackagesComplete: true,
      reportCenterContainsBothReports: true,
      currentVehicleProfileMatchesLicense: true,
    },
    dataCorrection: {
      vehicleId: correctedSedan.id,
      plateNumber: correctedSedan.plateNumber,
      currentProfileRegistrationDate: correctedSedan.registrationDate,
      completedBookingFrozenRegistrationDate: valetResult.frozenVehicleRegistrationDate,
      note: "本机私有素材已复核：车辆档案与已完成订单冻结快照一致；合格标留证不作为行驶证副页。",
    },
    scenarios: results,
  };
  writeFileSync(RESULT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  const failure = {
    runKey: RUN_KEY,
    apiBaseUrl: BASE_URL,
    failedAt: new Date().toISOString(),
    result: "failed",
    error: {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      status: error?.status ?? null,
      code: error?.code ?? null,
      method: error?.method ?? null,
      path: error?.path ?? null,
      payload: error?.payload ?? null,
      stack: error?.stack ?? null,
    },
    checkpoint: state,
  };
  writeFileSync(RESULT_PATH, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
