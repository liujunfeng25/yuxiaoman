'use strict';

/**
 * Native WeChat DevTools QA for the annual-inspection precheck return loop.
 *
 * Every business mutation is initiated by a rendered mini-program control:
 * booking, mock payment, station rejection, repair-request publication,
 * owner resubmission and station approval. The only wx mocks replace the host
 * operating-system media picker and make the self-drive location deterministic.
 * Native confirmation dialogs are confirmed through the automator's native UI.
 *
 * This runner intentionally has no resume mode. It must create a new isolated
 * self-drive booking so slot release, task close/reopen and media replacement
 * can be proved without relying on prior business state.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const automator = require('miniprogram-automator');

const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(repoRoot, '.runtime', 'annual-demo-media');
const manifestPath = path.resolve(process.env.WECHAT_QA_ANNUAL_MANIFEST || path.join(runtimeRoot, 'manifest.local.json'));
const preparedRoot = path.resolve(process.env.WECHAT_QA_ANNUAL_PREPARED_DIR || path.join(runtimeRoot, 'prepared'));
const artifactRoot = path.resolve(process.env.WECHAT_QA_PRECHECK_ARTIFACTS || path.join(runtimeRoot, 'artifacts', 'native-precheck-rejection-e2e'));
const runStamp = new Date().toISOString().replace(/[:.]/gu, '-');
const artifactsDir = path.join(artifactRoot, runStamp);
const endpoint = String(process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421').trim();
const fixtureOrigin = String(process.env.WECHAT_QA_FIXTURE_ORIGIN || 'http://127.0.0.1:9008').replace(/\/+$/u, '');
const stationId = String(process.env.WECHAT_QA_PRECHECK_STATION_ID || process.env.WECHAT_QA_OPERATOR_STATION_ID || 'station-huayang-1').trim();
const stationName = String(process.env.WECHAT_QA_PRECHECK_STATION_NAME || '华洋机动车检测站').trim();
const operatorLogin = String(process.env.WECHAT_QA_OPERATOR_LOGIN || '').trim();
const operatorPassword = String(process.env.WECHAT_QA_OPERATOR_PASSWORD || '');
const contactName = String(process.env.WECHAT_QA_CONTACT_NAME || '测试车主').trim();
const contactPhone = String(process.env.WECHAT_QA_CONTACT_PHONE || '13800001234').trim();
const rejectionNote = String(process.env.WECHAT_QA_PRECHECK_REJECTION_NOTE || '右后车身脏污并有明显损伤，启动后仪表盘故障灯亮，请处理后补拍对应照片。').trim();
const resolutionNote = String(process.env.WECHAT_QA_PRECHECK_RESOLUTION_NOTE || '车身已清洁并处理右后损伤，仪表盘故障灯已检查，现补拍照片申请复核。').trim();
const defaultTimeoutMs = positiveInteger(process.env.WECHAT_QA_TIMEOUT_MS, 45_000, 'WECHAT_QA_TIMEOUT_MS');
const uploadTimeoutMs = positiveInteger(process.env.WECHAT_QA_UPLOAD_TIMEOUT_MS, 60_000, 'WECHAT_QA_UPLOAD_TIMEOUT_MS');
const screenshotsOptional = process.env.WECHAT_QA_SCREENSHOTS_OPTIONAL === '1';

const HOME_ROUTE = 'pages/home/home';
const VEHICLES_ROUTE = 'packages/vehicle/pages/vehicles/vehicles';
const STATIONS_ROUTE = 'packages/annual/pages/stations/stations';
const SLOTS_ROUTE = 'packages/annual/pages/slots/slots';
const BOOKING_ROUTE = 'packages/annual/pages/booking/booking';
const ORDER_DETAIL_ROUTE = 'packages/annual/pages/order-detail/order-detail';
const PRECHECK_ACTIONS_ROUTE = 'packages/annual/pages/precheck-actions/precheck-actions';
const WASH_STORES_ROUTE = 'packages/wash/pages/wash-stores/wash-stores';
const OWNER_REPAIR_ROUTE = 'packages/repair/pages/owner-request-detail/owner-request-detail';
const OPERATOR_LOGIN_ROUTE = 'packages/operator/pages/operator-login/operator-login';
const OPERATOR_TASKS_ROUTE = 'packages/operator/pages/workflow-tasks/workflow-tasks';
const OPERATOR_PRECHECK_ROUTE = 'packages/operator/pages/precheck-detail/precheck-detail';

const PENDING_PRECHECK_NODE = 'annual.precheck.pending';
const mediaKinds = Object.freeze([
  'vehicle_front_left',
  'vehicle_front_right',
  'vehicle_rear_left',
  'vehicle_rear_right',
  'dashboard_started',
  'license_front',
  'license_back',
]);
const assetByKind = Object.freeze({
  vehicle_front_left: 'frontLeft.jpg',
  vehicle_front_right: 'frontRight.jpg',
  vehicle_rear_left: 'rearLeft.jpg',
  vehicle_rear_right: 'rearRight.jpg',
  dashboard_started: 'dashboardStarted.jpg',
  license_front: 'licenseFront.jpg',
  license_back: 'licenseBack.jpg',
});
const rejectionReasonCodes = Object.freeze(['body_dirty', 'body_damage', 'dashboard_warning']);
const issuePhotoKinds = Object.freeze(['vehicle_rear_right', 'dashboard_started']);

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePlate(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z\u4e00-\u9fff]/gu, '');
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing.`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error && error.message ? error.message : error}`);
  }
}

function redact(value) {
  let text = String(value || '');
  for (const secret of [operatorPassword, operatorLogin].filter((item) => item.length >= 3)) {
    text = text.split(secret).join('[redacted]');
  }
  return text;
}

function validateConfiguration(manifest) {
  const missing = [];
  if (!operatorLogin) missing.push('WECHAT_QA_OPERATOR_LOGIN');
  if (!operatorPassword) missing.push('WECHAT_QA_OPERATOR_PASSWORD');
  if (!stationId) missing.push('WECHAT_QA_PRECHECK_STATION_ID');
  if (missing.length) {
    throw new Error(`Set isolated inspection-station credentials through environment variables before running: ${missing.join(', ')}.`);
  }
  if (!manifest?.selfDrive?.plateNumber) throw new Error('The annual media manifest does not contain the self-drive vehicle.');
  if (contactName.length < 2 || !/^1\d{10}$/u.test(contactPhone)) throw new Error('The synthetic owner contact is invalid.');
  if (rejectionNote.length < 5 || resolutionNote.length < 5) throw new Error('Precheck rejection and resolution notes must contain at least five characters.');
  for (const kind of mediaKinds) resolveAsset(kind);
}

function resolveAsset(kind) {
  const filename = assetByKind[kind];
  if (!filename) throw new Error(`No local fixture filename is configured for ${kind}.`);
  const filePath = path.join(preparedRoot, 'self-drive', filename);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size <= 0) {
    throw new Error(`The real self-drive fixture for ${kind} is missing or empty.`);
  }
  if (/TEST-ONLY/iu.test(path.basename(filePath))) {
    throw new Error(`The ${kind} fixture is synthetic; this QA requires the existing real seven-photo set.`);
  }
  return filePath;
}

function fixtureUrl(hostFile) {
  const relative = path.relative(preparedRoot, hostFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Prepared media resolved outside the configured fixture directory.');
  }
  return `${fixtureOrigin}/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

async function waitUntil(operation, label, options = {}) {
  const timeoutMs = options.timeoutMs || defaultTimeoutMs;
  const intervalMs = options.intervalMs || 250;
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const detail = lastError && lastError.message ? ` Last error: ${redact(lastError.message)}` : '';
  throw new Error(`${label} timed out after ${timeoutMs} ms.${detail}`);
}

async function currentPage(miniProgram, expectedPath, label = expectedPath) {
  return waitUntil(async () => {
    const page = await miniProgram.currentPage();
    return page && page.path === expectedPath ? page : null;
  }, `Waiting for ${label}`);
}

async function waitForPageData(page, selector, predicate, label, timeoutMs = defaultTimeoutMs) {
  const match = await waitUntil(async () => {
    const value = await page.data(selector);
    return predicate(value) ? { value } : null;
  }, label, { timeoutMs });
  return match.value;
}

async function waitForElement(page, selector, label, timeoutMs = defaultTimeoutMs) {
  return waitUntil(() => page.$(selector), `Waiting for ${label}`, { timeoutMs });
}

async function elementByAttribute(page, selector, attribute, expected, label) {
  const elements = await page.$$(selector);
  for (const element of elements) {
    if (String(await element.attribute(attribute)) === String(expected)) return element;
  }
  throw new Error(`${label} was not rendered (${attribute}=${expected}).`);
}

async function relaunchPage(miniProgram, route, query = '', label = route) {
  await miniProgram.callWxMethod('reLaunch', { url: `/${route}${query ? `?${query}` : ''}` });
  await delay(1_200);
  return currentPage(miniProgram, route, label);
}

async function capture(miniProgram, step) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, `${step}.png`);
  await miniProgram.callWxMethod('hideToast').catch(() => undefined);
  await delay(250);
  try {
    await miniProgram.screenshot({ path: filePath });
  } catch (error) {
    if (!screenshotsOptional) throw error;
    console.warn(`Screenshot ${step} skipped: ${redact(error && error.message ? error.message : error)}`);
    return null;
  }
  console.log(`Screenshot ${step}`);
  return filePath;
}

async function mockChooseMediaDownload(miniProgram, hostFile) {
  const url = fixtureUrl(hostFile);
  const size = fs.statSync(hostFile).size;
  const functionDeclaration = `function(options){return new Promise((resolve,reject)=>wx.downloadFile({url:${JSON.stringify(url)},success:(result)=>resolve({tempFiles:[{tempFilePath:result.tempFilePath,size:${size},fileType:'image'}],type:'image',errMsg:'chooseMedia:ok'}),fail:reject}))}`;
  await miniProgram.mockWxMethod('chooseMedia', functionDeclaration);
}

async function useTianjinQaLocation(miniProgram) {
  const functionDeclaration = "function(){return Promise.resolve({latitude:39.084158,longitude:117.200983,speed:0,accuracy:10,altitude:0,verticalAccuracy:10,horizontalAccuracy:10,errMsg:'getLocation:ok'})}";
  await miniProgram.mockWxMethod('getLocation', functionDeclaration);
}

function assertExactKinds(items, expectedKinds, label) {
  const actual = Array.isArray(items) ? items.map((item) => String(item && item.kind)).sort() : [];
  const expected = [...expectedKinds].sort();
  if (actual.length !== expected.length || actual.some((kind, index) => kind !== expected[index])) {
    throw new Error(`${label} contains [${actual.join(', ')}], expected exactly [${expected.join(', ')}].`);
  }
}

function assertEventCount(booking, title, status, actorType, expectedCount = 1) {
  const matches = Array.isArray(booking?.events)
    ? booking.events.filter((event) => event && event.title === title && event.status === status && event.actorType === actorType)
    : [];
  if (matches.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} ${title} event(s) at ${status}/${actorType}, got ${matches.length}.`);
  }
}

function mediaIdByKind(booking) {
  return new Map((booking?.media || []).map((item) => [String(item.kind), String(item.id)]));
}

async function waitForStableStationCards(miniProgram, stations, expectedCount) {
  await waitForPageData(stations, 'loading', (value) => value === false, 'Waiting for inspection stations');
  await waitUntil(async () => {
    const cards = await stations.$$('.station-card');
    if (cards.length !== expectedCount) return null;
    const sizes = await Promise.all(cards.map((card) => card.size()));
    return sizes.every((size) => Number(size?.width) > 0 && Number(size?.height) > 0) ? cards : null;
  }, 'Waiting for stable inspection-station cards');
  await currentPage(miniProgram, STATIONS_ROUTE, 'stable inspection-station picker');
}

async function openOwnerHome(miniProgram) {
  const home = await relaunchPage(miniProgram, HOME_ROUTE, '', 'owner home');
  await waitForPageData(home, 'loading', (value) => value === false, 'Waiting for owner home');
  const loadError = await home.data('loadError');
  if (loadError && !(await home.data('hero'))) throw new Error(`Owner home failed: ${loadError}`);
  return home;
}

async function ensureSelfDriveVehicle(miniProgram, manifest) {
  const expectedPlate = normalizePlate(manifest.selfDrive.plateNumber);
  let home = await openOwnerHome(miniProgram);
  const currentVehicle = await home.data('vehicle');
  if (normalizePlate(currentVehicle?.plateNumber) === expectedPlate) return home;

  const garageEntry = await waitForElement(home, '.hero-plate', 'vehicle garage entry');
  await garageEntry.tap();
  const garage = await currentPage(miniProgram, VEHICLES_ROUTE, 'vehicle garage');
  await waitForPageData(garage, 'loading', (value) => value === false, 'Waiting for vehicle garage');
  const vehicles = await garage.data('vehicles');
  const index = Array.isArray(vehicles)
    ? vehicles.findIndex((vehicle) => normalizePlate(vehicle?.plateNumber) === expectedPlate)
    : -1;
  if (index < 0) throw new Error('The real self-drive fixture vehicle is not available to the current owner.');
  if (!vehicles[index].isDefault) {
    const cards = await waitUntil(async () => {
      const rendered = await garage.$$('.vehicle');
      return rendered.length >= vehicles.length ? rendered : null;
    }, 'Waiting for vehicle cards');
    const makeDefault = await cards[index].$('.default-action');
    if (!makeDefault) throw new Error('The self-drive fixture vehicle cannot be selected.');
    await makeDefault.tap();
    home = await currentPage(miniProgram, HOME_ROUTE, 'owner home after vehicle selection');
    await waitForPageData(home, 'loading', (value) => value === false, 'Waiting for selected owner vehicle');
  }
  await waitForPageData(home, 'vehicle', (vehicle) => normalizePlate(vehicle?.plateNumber) === expectedPlate, 'Waiting for the fixture vehicle to become current');
  return home;
}

async function enterNewSelfDriveBooking(miniProgram, manifest) {
  const home = await ensureSelfDriveVehicle(miniProgram, manifest);
  if (await home.data('activeBooking')) {
    throw new Error('The fixture vehicle already has an active annual-inspection order. This runner requires a freshly isolated booking and never resumes existing business state.');
  }
  const hero = await home.data('hero');
  if (!hero?.canBookInspection) throw new Error('The self-drive fixture vehicle is not eligible for a new annual-inspection booking.');
  await capture(miniProgram, '01-owner-self-drive-entry');

  await useTianjinQaLocation(miniProgram);
  const entry = await waitForElement(home, '.self-drive-job', 'self-drive annual-inspection entry');
  await entry.tap();
  const stations = await currentPage(miniProgram, STATIONS_ROUTE, 'inspection-station picker');
  await waitForPageData(stations, 'loading', (value) => value === false, 'Waiting for station picker');
  await miniProgram.restoreWxMethod('getLocation').catch(() => undefined);
  if ((await stations.data('mode')) !== 'self_drive') throw new Error('The station picker did not preserve self-drive mode.');
  const stationItems = await stations.data('stations');
  const stationIndex = Array.isArray(stationItems) ? stationItems.findIndex((item) => item?.id === stationId) : -1;
  if (stationIndex < 0) throw new Error('The configured Huayang inspection station is not rendered for this owner and vehicle.');
  const station = stationItems[stationIndex];
  if (stationName && !String(station?.name || '').includes(stationName)) {
    throw new Error('The configured inspection-station ID does not resolve to the expected Huayang station.');
  }
  await waitForStableStationCards(miniProgram, stations, stationItems.length);
  await capture(miniProgram, '02-huayang-station-selected');
  const stationCards = await stations.$$('.station-card');
  await stationCards[stationIndex].tap();

  const slotsPage = await currentPage(miniProgram, SLOTS_ROUTE, 'inspection slot picker');
  await waitForPageData(slotsPage, 'loading', (value) => value === false, 'Waiting for inspection slots');
  const slots = await slotsPage.data('slots');
  const available = Array.isArray(slots) ? slots.filter((slot) => Number(slot?.remaining) > 0) : [];
  if (available.length < 2) {
    throw new Error('The isolated Huayang fixture needs at least two available future slots to prove release and selection of a different slot.');
  }
  const originalSlot = available[0];
  const originalIndex = slots.findIndex((slot) => slot?.id === originalSlot.id);
  const slotCards = await slotsPage.$$('.slot-card');
  if (!slotCards[originalIndex]) throw new Error('The first Huayang slot card is not rendered.');
  await slotCards[originalIndex].tap();

  const booking = await currentPage(miniProgram, BOOKING_ROUTE, 'booking confirmation');
  await waitForPageData(booking, 'loading', (value) => value === false, 'Waiting for booking confirmation');
  await waitForPageData(booking, 'quoting', (value) => value === false, 'Waiting for booking quote');
  const loadError = await booking.data('loadError');
  if (loadError) throw new Error(`Booking confirmation failed: ${loadError}`);
  const quote = await booking.data('quote');
  if (!quote?.quoteSnapshotId || quote.serviceable !== true || Number(quote.serviceFeeFen) <= 0 || Number(quote.valetFeeFen) !== 0) {
    throw new Error('The Huayang self-drive quote is not a payable non-valet quote.');
  }
  await (await waitForElement(booking, 'input[data-field="contactName"]', 'booking contact name')).input(contactName);
  await (await waitForElement(booking, 'input[data-field="contactPhone"]', 'booking contact phone')).input(contactPhone);
  const note = await booking.$('textarea[data-field="note"]');
  if (note) await note.input('预检退回闭环演示 · 自驾验车');
  return { booking, originalSlot };
}

async function uploadInitialSevenPhotos(miniProgram, booking) {
  const uploads = await booking.data('uploads');
  assertExactKinds(uploads, mediaKinds, 'Booking upload controls');
  try {
    for (const kind of mediaKinds) {
      await mockChooseMediaDownload(miniProgram, resolveAsset(kind));
      const current = await booking.data('uploads');
      const index = current.findIndex((item) => item?.kind === kind);
      const buttons = await booking.$$('.upload-card');
      if (index < 0 || !buttons[index]) throw new Error(`The rendered upload control for ${kind} is missing.`);
      await buttons[index].tap();
      await waitUntil(async () => {
        const next = await booking.data('uploads');
        const item = next.find((candidate) => candidate?.kind === kind);
        return item?.media && !item.uploading ? next : null;
      }, `Waiting for initial ${kind} upload`, { timeoutMs: uploadTimeoutMs });
      const cumulative = await booking.data('uploads');
      const completed = cumulative.filter((item) => item?.media && !item.uploading);
      if (completed.length !== mediaKinds.indexOf(kind) + 1) throw new Error(`Initial upload accumulation regressed at ${kind}.`);
      if (Number(await booking.data('mediaUploadingCount')) !== 0) throw new Error(`The upload counter did not settle after ${kind}.`);
    }
  } finally {
    await miniProgram.restoreWxMethod('chooseMedia').catch(() => undefined);
  }
  await waitUntil(async () => (await booking.$$('.upload-card.complete')).length === 7, 'Waiting for seven completed upload cards');
  await capture(miniProgram, '03-booking-seven-real-photos');
}

async function createAndPayBooking(miniProgram, booking, originalSlot) {
  const submit = await waitForElement(booking, '.submit-bar > button', 'booking submit button');
  if ([true, 'true'].includes(await submit.attribute('disabled'))) throw new Error('Booking submit is disabled after all seven uploads.');
  await submit.tap();
  const detail = await currentPage(miniProgram, ORDER_DETAIL_ROUTE, 'new order detail');
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for the new order');
  let created = await waitForPageData(detail, 'booking', Boolean, 'Waiting for created booking');
  if (created.serviceMode !== 'self_drive' || created.status !== 'pending_payment' || created.paymentStatus !== 'unpaid') {
    throw new Error(`New self-drive booking entered ${created.status}/${created.paymentStatus}.`);
  }
  if (created.stationId !== stationId || !String(created.station?.name || '').includes(stationName)) throw new Error('The new booking is not scoped to Huayang.');
  if (created.slotId !== originalSlot.id) throw new Error('The new booking did not preserve the rendered original slot selection.');
  assertExactKinds(created.media, mediaKinds, 'New booking media');
  if (!created.quoteSnapshotId || Number(created.serviceFeeFen) <= 0) throw new Error('The new order is missing its frozen non-zero quote.');
  if (await detail.data('quoteExpired')) {
    const priorSnapshotId = created.quoteSnapshotId;
    const requote = await waitForElement(detail, '.quote-expired-actions button', 'expired new-order requote button');
    await requote.tap();
    await waitForPageData(detail, 'requoting', (value) => value === false, 'Waiting for new-order requote');
    created = await waitForPageData(
      detail,
      'booking',
      (value) => value?.quoteSnapshotId && value.quoteSnapshotId !== priorSnapshotId && Number(value.serviceFeeFen) > 0,
      'Waiting for refreshed new-order quote snapshot',
    );
    await waitForPageData(detail, 'quoteExpired', (value) => value === false, 'Waiting for refreshed quote validity');
    assertExactKinds(created.media, mediaKinds, 'Requoted new booking media');
  }
  const feeFen = Number(created.serviceFeeFen);

  const pay = await waitForElement(detail, '.pay-button', 'mock payment button');
  await pay.tap();
  const paid = await waitForPageData(
    detail,
    'booking',
    (value) => value?.status === 'pending_precheck' && value?.paymentStatus === 'paid' && value?.precheck?.status === 'pending',
    'Waiting for paid pending precheck',
  );
  if (Number(paid.paidFen) !== feeFen || Number(paid.refundedFen || 0) !== 0 || paid.precheckSlotReleased) {
    throw new Error('The initial mock payment ledger or slot reservation is inconsistent.');
  }
  if (Number(paid.precheck.version) !== 1) throw new Error(`A fresh paid booking should start at precheck version 1, got ${paid.precheck.version}.`);
  assertExactKinds(paid.media, mediaKinds, 'Paid booking media');
  assertEventCount(paid, '支付已确认', 'pending_precheck', 'owner');
  await capture(miniProgram, '04-owner-paid-pending-precheck');
  return { bookingId: paid.id, feeFen, initialMediaIds: mediaIdByKind(paid) };
}

let operatorAuthenticated = false;

async function loginOperatorForTasks(miniProgram) {
  const redirect = `/${OPERATOR_TASKS_ROUTE}`;
  await miniProgram.callWxMethod('reLaunch', {
    url: `/${OPERATOR_LOGIN_ROUTE}?redirect=${encodeURIComponent(redirect)}`,
  });
  await delay(1_000);
  const login = await currentPage(miniProgram, OPERATOR_LOGIN_ROUTE, 'inspection-station login');
  await waitForPageData(login, 'checking', (value) => value === false, 'Waiting for station session check');
  if (await login.data('signedInName')) {
    const changeAccount = await waitForElement(login, '.secondary', 'switch inspection-station account');
    await changeAccount.tap();
    await waitForPageData(login, 'signedInName', (value) => value === '', 'Waiting for prior station sign-out');
  }
  const fields = await login.$$('input');
  if (fields.length < 2) throw new Error('The inspection-station login form is incomplete.');
  await fields[0].input(operatorLogin);
  await fields[1].input(operatorPassword);
  await (await waitForElement(login, '.primary', 'inspection-station login button')).tap();
  const tasks = await currentPage(miniProgram, OPERATOR_TASKS_ROUTE, 'inspection-station workflow tasks after login');
  operatorAuthenticated = true;
  return tasks;
}

async function openOperatorTasks(miniProgram) {
  if (!operatorAuthenticated) return loginOperatorForTasks(miniProgram);
  await miniProgram.callWxMethod('reLaunch', { url: `/${OPERATOR_TASKS_ROUTE}` });
  await delay(1_000);
  const page = await miniProgram.currentPage();
  if (page?.path === OPERATOR_LOGIN_ROUTE) {
    operatorAuthenticated = false;
    return loginOperatorForTasks(miniProgram);
  }
  return currentPage(miniProgram, OPERATOR_TASKS_ROUTE, 'inspection-station workflow tasks');
}

async function settledTaskItems(tasksPage) {
  await waitForPageData(tasksPage, 'loading', (value) => value === false, 'Waiting for workflow task loading');
  await waitForPageData(tasksPage, 'loaded', (value) => value === true, 'Waiting for workflow task content');
  const error = await tasksPage.data('error');
  if (error) throw new Error(`Inspection-station workflow tasks failed: ${error}`);
  return waitForPageData(tasksPage, 'items', Array.isArray, 'Waiting for workflow task items');
}

function workflowBusinessId(item) {
  return String(item?.businessId || item?.actionParams?.bookingId || item?.actionParams?.resourceId || '');
}

function matchingPendingTasks(items, bookingId) {
  return (Array.isArray(items) ? items : []).filter((item) => (
    item?.nodeCode === PENDING_PRECHECK_NODE
    && workflowBusinessId(item) === bookingId
    && item.status === 'open'
  ));
}

async function assertPendingTaskAbsent(miniProgram, bookingId, screenshotStep) {
  const tasksPage = await openOperatorTasks(miniProgram);
  const items = await settledTaskItems(tasksPage);
  const matches = matchingPendingTasks(items, bookingId);
  if (matches.length !== 0) throw new Error(`The closed precheck task is still rendered ${matches.length} time(s).`);
  if (screenshotStep) await capture(miniProgram, screenshotStep);
  return tasksPage;
}

async function openUniquePendingTask(miniProgram, bookingId, screenshotStep) {
  const tasksPage = await openOperatorTasks(miniProgram);
  const items = await settledTaskItems(tasksPage);
  const matches = matchingPendingTasks(items, bookingId);
  if (matches.length !== 1) throw new Error(`Expected exactly one rendered pending-precheck task, got ${matches.length}.`);
  const task = matches[0];
  if (screenshotStep) await capture(miniProgram, screenshotStep);
  const card = await elementByAttribute(tasksPage, '.workflow-task', 'data-id', task.id, 'pending-precheck workflow task card');
  await card.tap();
  const precheck = await currentPage(miniProgram, OPERATOR_PRECHECK_ROUTE, 'station precheck opened from task card');
  await waitForPageData(precheck, 'loading', (value) => value === false, 'Waiting for station precheck detail');
  const loadError = await precheck.data('loadError');
  if (loadError) throw new Error(`Station precheck detail failed: ${loadError}`);
  return { task, precheck };
}

async function confirmNativeModal(miniProgram, label) {
  await delay(650);
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await miniProgram.native().confirmModal();
      return;
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }
  throw new Error(`${label} could not be confirmed through the native automator: ${redact(lastError?.message || lastError)}`);
}

async function rejectFromStation(miniProgram, precheck, bookingId, feeFen) {
  const pending = await waitForPageData(
    precheck,
    'booking',
    (value) => value?.id === bookingId && value?.status === 'pending_precheck' && value?.paymentStatus === 'paid' && value?.precheck?.status === 'pending',
    'Waiting for Huayang pending precheck booking',
  );
  if (pending.stationId !== stationId || !String(pending.station?.name || '').includes(stationName)) throw new Error('The station task is not a Huayang booking.');
  if (Number(pending.paidFen) !== feeFen || Number(pending.refundedFen || 0) !== 0) throw new Error('The paid amount changed before station review.');
  assertExactKinds(pending.media, mediaKinds, 'First station precheck media');
  const photos = await precheck.data('photos');
  assertExactKinds(photos, mediaKinds, 'First station precheck rendered photos');
  if (photos.some((item) => !item.url)) throw new Error('The first station review does not render all seven photo URLs.');
  const guidance = await precheck.data('reasons');
  const expectedActions = { body_dirty: 'wash', body_damage: 'repair', dashboard_warning: 'repair' };
  for (const [code, action] of Object.entries(expectedActions)) {
    if (!guidance.some((item) => item?.code === code && item?.action === action)) {
      throw new Error(`Station precheck guidance does not route ${code} to ${action}.`);
    }
  }

  await (await waitForElement(precheck, '.action-bar .reject', 'station reject action')).tap();
  await waitForPageData(precheck, 'showReject', (value) => value === true, 'Waiting for rejection sheet');
  for (const code of rejectionReasonCodes) {
    const button = await elementByAttribute(precheck, '.reason-grid button', 'data-code', code, `rejection reason ${code}`);
    await button.tap();
  }
  await waitForPageData(
    precheck,
    'reasons',
    (items) => rejectionReasonCodes.every((code) => items.some((item) => item?.code === code && item?.selected)),
    'Waiting for all rejection reasons to be selected',
  );
  for (const kind of issuePhotoKinds) {
    const button = await elementByAttribute(precheck, '.photo-tags button', 'data-kind', kind, `issue photo ${kind}`);
    await button.tap();
  }
  await waitForPageData(
    precheck,
    'selectedPhotoKinds',
    (items) => Array.isArray(items) && items.length === issuePhotoKinds.length && issuePhotoKinds.every((kind) => items.includes(kind)),
    'Waiting for body and dashboard issue photos',
  );
  await (await waitForElement(precheck, '.reject-sheet textarea', 'station rejection note')).input(rejectionNote);
  await waitForPageData(precheck, 'reasonText', (value) => value === rejectionNote, 'Waiting for station rejection note');
  await capture(miniProgram, '06-station-return-body-dashboard-selection');

  await (await waitForElement(precheck, '.confirm-reject', 'send precheck problem list')).tap();
  await confirmNativeModal(miniProgram, 'Station rejection confirmation');
  await waitUntil(async () => {
    const current = await miniProgram.currentPage();
    if (current?.path === OPERATOR_TASKS_ROUTE) return current;
    if (current?.path !== OPERATOR_PRECHECK_ROUTE) return null;
    const booking = await current.data('booking');
    return booking?.status === 'precheck_action_required' ? current : null;
  }, 'Waiting for station rejection to finish');
  return pending;
}

async function openOwnerOrder(miniProgram, bookingId, label) {
  const detail = await relaunchPage(miniProgram, ORDER_DETAIL_ROUTE, `id=${encodeURIComponent(bookingId)}`, label);
  await waitForPageData(detail, 'loading', (value) => value === false, `Waiting for ${label}`);
  const loadError = await detail.data('loadError');
  if (loadError) throw new Error(`${label} failed: ${loadError}`);
  return detail;
}

async function openOwnerActionsAfterRejection(miniProgram, bookingId, feeFen, initialTaskId, originalSlot) {
  const detail = await openOwnerOrder(miniProgram, bookingId, 'owner returned precheck order');
  const rejected = await waitForPageData(
    detail,
    'booking',
    (value) => value?.status === 'precheck_action_required' && value?.paymentStatus === 'paid' && value?.precheck?.status === 'rejected',
    'Waiting for owner precheck problem list',
  );
  if (!rejected.precheckSlotReleased) throw new Error('The owner order does not mark the original slot as released.');
  if (rejected.slotId !== originalSlot.id) throw new Error('The rejected record unexpectedly rewrote the original slot before owner resubmission.');
  if (Number(rejected.paidFen) !== feeFen || Number(rejected.serviceFeeFen) !== feeFen || Number(rejected.refundedFen || 0) !== 0) {
    throw new Error('Station rejection did not retain the original paid amount.');
  }
  if (!rejectionReasonCodes.every((code) => rejected.precheck.reasonCodes.includes(code))) throw new Error('The owner order lost one or more station rejection reasons.');
  if (Number(rejected.precheck.version) !== 2) throw new Error(`The first rejection should create precheck version 2, got ${rejected.precheck.version}.`);
  assertExactKinds(rejected.precheck.issuePhotoKinds.map((kind) => ({ kind })), issuePhotoKinds, 'Owner issue-photo markers');
  assertExactKinds(rejected.media, mediaKinds, 'Rejected owner booking media');
  assertEventCount(rejected, '预检发现问题，等待车主处理', 'precheck_action_required', 'operator');
  if (rejected.precheck.supervision?.taskId !== initialTaskId || rejected.precheck.supervision?.status === 'open') {
    throw new Error('The first pending-precheck supervision task did not close after rejection.');
  }
  await capture(miniProgram, '07-owner-problem-list-payment-retained');

  const actionsEntry = await waitForElement(detail, '.precheck-owner-card .pay-button', 'owner precheck actions entry');
  await actionsEntry.tap();
  const actions = await currentPage(miniProgram, PRECHECK_ACTIONS_ROUTE, 'owner precheck actions');
  await waitForPageData(actions, 'loading', (value) => value === false, 'Waiting for owner precheck actions');
  const error = await actions.data('error');
  if (error) throw new Error(`Owner precheck actions failed: ${error}`);
  await waitForPageData(actions, 'canAct', (value) => value === true, 'Waiting for actionable owner precheck page');
  const actionBooking = await actions.data('booking');
  if (actionBooking?.id !== bookingId || actionBooking.stationId !== stationId || !actionBooking.precheckSlotReleased) {
    throw new Error('The owner action page is not bound to the rejected Huayang booking.');
  }
  if (!(await actions.data('hasWash')) || !(await actions.data('hasRepair'))) {
    throw new Error('The returned issue list does not expose both wash and multi-shop repair entries.');
  }
  const issues = await actions.data('issues');
  const expectedActions = { body_dirty: 'wash', body_damage: 'repair', dashboard_warning: 'repair' };
  for (const [code, action] of Object.entries(expectedActions)) {
    if (!issues.some((item) => item?.code === code && item?.action === action)) throw new Error(`Owner guidance lost ${code} -> ${action}.`);
  }
  const photos = await actions.data('photos');
  assertExactKinds(photos, mediaKinds, 'Owner action photos');
  const marked = photos.filter((item) => item.needsUpdate).map((item) => item.kind).sort();
  if (marked.join('|') !== [...issuePhotoKinds].sort().join('|')) throw new Error('Owner action page did not mark exactly the two station-selected photos.');
  assertExactKinds(await actions.data('repairPhotos'), issuePhotoKinds, 'Repair sharing photos');
  const slots = await waitForPageData(actions, 'slots', (items) => Array.isArray(items) && items.length > 0, 'Waiting for Huayang replacement slots');
  const released = slots.find((slot) => slot?.id === originalSlot.id);
  if (!released || Number(released.remaining) !== Number(originalSlot.remaining)) {
    throw new Error('The original Huayang slot did not return to its pre-booking remaining capacity after rejection.');
  }
  if (!slots.some((slot) => slot?.id !== originalSlot.id && Number(slot?.remaining) > 0)) {
    throw new Error('No different Huayang slot is available for owner resubmission.');
  }
  await capture(miniProgram, '08-owner-wash-and-multi-repair-actions');
  return { actions, rejected };
}

async function verifyWashEntry(miniProgram, actions, bookingId) {
  const entry = await waitForElement(actions, '.service-card button', 'nearby wash entry');
  await entry.tap();
  const wash = await currentPage(miniProgram, WASH_STORES_ROUTE, 'wash store picker from precheck');
  await waitForPageData(wash, 'loading', (value) => value === false, 'Waiting for wash store entry');
  const error = await wash.data('error');
  if (error) throw new Error(`Precheck wash-store entry failed: ${error}`);
  const stores = await wash.data('stores');
  if (!Array.isArray(stores) || stores.length === 0 || (await wash.data('serviceMode')) !== 'self_drive') {
    throw new Error('The precheck wash entry did not reach a rendered self-drive store comparison.');
  }
  const vehicle = await wash.data('vehicle');
  const actionBooking = await actions.data('booking');
  if (!vehicle || vehicle.id !== actionBooking.vehicleId || actionBooking.id !== bookingId) {
    throw new Error('The wash entry lost the rejected booking vehicle context.');
  }
  await capture(miniProgram, '09-owner-nearby-wash-entry');
  await miniProgram.native().navigateLeft();
  await delay(500);
  if ((await miniProgram.currentPage())?.path === WASH_STORES_ROUTE) {
    // Recent DevTools builds may acknowledge Tool.native without dispatching
    // the simulator back action. Fall back to the equivalent host navigation;
    // no business mutation is bypassed here.
    await miniProgram.callWxMethod('navigateBack');
  }
  const returned = await currentPage(miniProgram, PRECHECK_ACTIONS_ROUTE, 'owner actions after native wash back');
  await waitForPageData(returned, 'loading', (value) => value === false, 'Waiting for owner actions after wash entry');
  await waitForPageData(returned, 'canAct', (value) => value === true, 'Waiting for actionable page after wash entry');
  return returned;
}

async function verifyRepairEntry(miniProgram, actions, bookingId) {
  const consent = await waitForElement(actions, '.repair-card .consent', 'repair photo-sharing consent');
  await consent.tap();
  await waitForPageData(actions, 'consented', (value) => value === true, 'Waiting for repair photo-sharing consent');
  const entry = await waitForElement(actions, '.repair-card .primary', 'multi-shop repair quote entry');
  await entry.tap();
  const detail = await currentPage(miniProgram, OWNER_REPAIR_ROUTE, 'precheck multi-shop repair request');
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for precheck repair request');
  const error = await detail.data('error');
  if (error && !(await detail.data('request'))) throw new Error(`Precheck repair entry failed: ${error}`);
  const request = await waitForPageData(detail, 'request', Boolean, 'Waiting for precheck repair request data');
  if (request.sourceType !== 'precheck' || request.sourceBookingId !== bookingId || request.status !== 'open') {
    throw new Error('The repair entry did not create an open request linked to the precheck booking.');
  }
  const sourceCodes = request.faults.map((fault) => String(fault.sourceFaultId)).sort();
  if (sourceCodes.join('|') !== ['body_damage', 'dashboard_warning'].sort().join('|')) {
    throw new Error(`The repair request contains unexpected precheck faults: ${sourceCodes.join(', ')}.`);
  }
  if (!Array.isArray(request.media) || request.media.length !== 2 || Number(await detail.data('photoCount')) !== 2) {
    throw new Error('The repair request did not preserve exactly the body and dashboard evidence photos.');
  }
  await waitForElement(detail, '.waiting-card', 'multi-shop waiting state');
  await capture(miniProgram, '10-owner-multi-shop-repair-entry');

  const backToPrecheck = await waitForElement(detail, '.request-card button', 'return to annual precheck actions');
  await backToPrecheck.tap();
  const returned = await currentPage(miniProgram, PRECHECK_ACTIONS_ROUTE, 'owner actions from linked repair request');
  await waitForPageData(returned, 'loading', (value) => value === false, 'Waiting for owner actions after repair entry');
  await waitForPageData(returned, 'canAct', (value) => value === true, 'Waiting for actionable page after repair entry');
  await waitForPageData(
    returned,
    'services',
    (items) => Array.isArray(items) && items.some((item) => item?.id === request.id && item?.type === 'repair' && item?.status === 'open'),
    'Waiting for linked repair service on precheck actions',
  );
  return { actions: returned, repairRequestId: request.id };
}

async function replacePhotosAndResubmit(miniProgram, actions, rejected, originalSlot, initialMediaIds, feeFen) {
  const slots = await waitForPageData(actions, 'slots', (items) => Array.isArray(items) && items.length > 0, 'Waiting for replacement slots before resubmission');
  const nextSlotIndex = slots.findIndex((slot) => slot?.id !== originalSlot.id && Number(slot?.remaining) > 0);
  if (nextSlotIndex < 0) throw new Error('A different Huayang slot is no longer available.');
  const nextSlot = slots[nextSlotIndex];

  try {
    for (const kind of issuePhotoKinds) {
      await mockChooseMediaDownload(miniProgram, resolveAsset(kind));
      const button = await elementByAttribute(actions, '.photo-grid button', 'data-kind', kind, `replacement upload ${kind}`);
      await button.tap();
      const replacements = await waitForPageData(
        actions,
        'replacements',
        (items) => Array.isArray(items) && items.some((item) => item?.kind === kind && item?.id),
        `Waiting for replacement ${kind}`,
        uploadTimeoutMs,
      );
      const replacement = replacements.find((item) => item.kind === kind);
      if (String(replacement.id) === initialMediaIds.get(kind)) throw new Error(`${kind} did not receive a new media record.`);
      await waitForPageData(actions, 'uploadingKind', (value) => value === '', `Waiting for ${kind} replacement upload to settle`, uploadTimeoutMs);
    }
  } finally {
    await miniProgram.restoreWxMethod('chooseMedia').catch(() => undefined);
  }
  const replacements = await actions.data('replacements');
  assertExactKinds(replacements, issuePhotoKinds, 'Owner replacement media');
  const replacementIds = new Map(replacements.map((item) => [String(item.kind), String(item.id)]));

  await (await waitForElement(actions, 'textarea', 'owner resolution note')).input(resolutionNote);
  await waitForPageData(actions, 'resolutionNote', (value) => value === resolutionNote, 'Waiting for owner resolution note');
  const picker = await waitForElement(actions, 'picker', 'Huayang replacement-slot picker');
  // DevTools automator cannot address the operating-system picker wheel. A
  // component change event is the supported rendered-control interaction; the
  // eventual resubmission remains an actual footer-button tap.
  await picker.trigger('change', { value: String(nextSlotIndex) });
  await waitForPageData(actions, 'slotIndex', (value) => Number(value) === nextSlotIndex, 'Waiting for different Huayang slot selection');
  await capture(miniProgram, '11-owner-two-replacements-note-new-slot');

  const submit = await waitForElement(actions, '.footer .primary', 'submit precheck re-review');
  if ([true, 'true'].includes(await submit.attribute('disabled'))) throw new Error('Owner re-review submit is disabled after completing the checklist.');
  await submit.tap();
  const order = await currentPage(miniProgram, ORDER_DETAIL_ROUTE, 'owner order after precheck resubmission');
  await waitForPageData(order, 'loading', (value) => value === false, 'Waiting for resubmitted owner order');
  const booking = await waitForPageData(
    order,
    'booking',
    (value) => value?.status === 'pending_precheck' && value?.paymentStatus === 'paid' && value?.precheck?.status === 'pending',
    'Waiting for pending precheck after owner resubmission',
  );
  if (booking.slotId !== nextSlot.id || booking.precheckSlotReleased) throw new Error('Resubmission did not reserve the newly selected Huayang slot.');
  if (Number(booking.paidFen) !== feeFen || Number(booking.serviceFeeFen) !== feeFen || Number(booking.refundedFen || 0) !== 0) {
    throw new Error('Resubmission changed the retained payment ledger.');
  }
  if (booking.precheck.resolutionNote !== resolutionNote || Number(booking.precheck.version) !== 3 || Number(booking.precheck.version) !== Number(rejected.precheck.version) + 1) {
    throw new Error('The owner resolution note or precheck version was not persisted by resubmission.');
  }
  assertExactKinds(booking.media, mediaKinds, 'Resubmitted current booking media');
  const currentIds = mediaIdByKind(booking);
  for (const kind of mediaKinds) {
    if (issuePhotoKinds.includes(kind)) {
      if (currentIds.get(kind) !== replacementIds.get(kind) || currentIds.get(kind) === initialMediaIds.get(kind)) {
        throw new Error(`The current ${kind} photo was not replaced by the owner upload.`);
      }
    } else if (currentIds.get(kind) !== initialMediaIds.get(kind)) {
      throw new Error(`Unmarked current photo ${kind} changed during partial replacement.`);
    }
  }
  assertEventCount(booking, '车主已提交预检复核', 'pending_precheck', 'owner');
  await capture(miniProgram, '12-owner-resubmitted-paid-pending-precheck');
  return { booking, nextSlot, replacementIds };
}

async function approveResubmission(miniProgram, precheck, bookingId, feeFen, resolution, replacementIds) {
  const booking = await waitForPageData(
    precheck,
    'booking',
    (value) => value?.id === bookingId && value?.status === 'pending_precheck' && value?.paymentStatus === 'paid' && value?.precheck?.status === 'pending',
    'Waiting for resubmitted Huayang precheck',
  );
  if (booking.precheck.resolutionNote !== resolution || Number(booking.paidFen) !== feeFen) {
    throw new Error('The second station review lost the owner resolution or retained payment.');
  }
  if (Number(booking.precheck.version) !== 3) throw new Error(`The second station review should read precheck version 3, got ${booking.precheck.version}.`);
  assertExactKinds(booking.media, mediaKinds, 'Second station current media');
  const ids = mediaIdByKind(booking);
  for (const [kind, id] of replacementIds) {
    if (ids.get(kind) !== id) throw new Error(`The second station review is not using the replacement ${kind} photo.`);
  }
  const photos = await precheck.data('photos');
  assertExactKinds(photos, mediaKinds, 'Second station rendered photos');
  if (photos.some((item) => !item.url)) throw new Error('The second station review does not render all seven photo URLs.');
  await waitForElement(precheck, '.resolution-card', 'owner resolution card on station re-review');
  await capture(miniProgram, '14-station-second-review-seven-photos');

  const approve = await waitForElement(precheck, '.action-bar .approve', 'station approve-and-accept action');
  if ([true, 'true'].includes(await approve.attribute('disabled'))) throw new Error('Station approval is disabled with seven complete photos.');
  await approve.tap();
  await confirmNativeModal(miniProgram, 'Station approval confirmation');
  await waitUntil(async () => {
    const current = await miniProgram.currentPage();
    if (current?.path === OPERATOR_TASKS_ROUTE) return current;
    if (current?.path !== OPERATOR_PRECHECK_ROUTE) return null;
    const value = await current.data('booking');
    return value?.status === 'awaiting_arrival' && value?.precheck?.status === 'approved' ? current : null;
  }, 'Waiting for station approval to finish');
}

async function verifyFinalOwnerState(miniProgram, bookingId, feeFen, nextSlot, initialTaskId, reopenedTaskId, repairRequestId, replacementIds) {
  const detail = await openOwnerOrder(miniProgram, bookingId, 'final owner annual order');
  const booking = await waitForPageData(
    detail,
    'booking',
    (value) => value?.status === 'awaiting_arrival' && value?.paymentStatus === 'paid' && value?.precheck?.status === 'approved',
    'Waiting for final self-drive awaiting-arrival state',
  );
  if (booking.slotId !== nextSlot.id || booking.precheckSlotReleased) throw new Error('Final order did not retain the new reserved Huayang slot.');
  if (Number(booking.precheck.version) !== 4) throw new Error(`Final approval should persist precheck version 4, got ${booking.precheck.version}.`);
  if (Number(booking.paidFen) !== feeFen || Number(booking.serviceFeeFen) !== feeFen || Number(booking.refundedFen || 0) !== 0) {
    throw new Error('Final approval did not retain the original payment.');
  }
  assertExactKinds(booking.media, mediaKinds, 'Final owner booking media');
  const currentIds = mediaIdByKind(booking);
  for (const [kind, id] of replacementIds) {
    if (currentIds.get(kind) !== id) throw new Error(`Final order lost replacement photo ${kind}.`);
  }
  if (booking.precheck.supervision?.taskId !== reopenedTaskId || booking.precheck.supervision?.status === 'open') {
    throw new Error('The reopened pending-precheck supervision task did not close after final approval.');
  }
  if (initialTaskId === reopenedTaskId) throw new Error('The second review reused the closed first-round task instead of reopening a new task.');
  const linkedRepair = (booking.precheckServices || []).find((item) => item?.type === 'repair' && item?.id === repairRequestId);
  if (!linkedRepair || linkedRepair.status !== 'open') throw new Error('The independent multi-shop repair request is no longer linked after annual precheck approval.');
  assertEventCount(booking, '支付已确认', 'pending_precheck', 'owner');
  assertEventCount(booking, '预检发现问题，等待车主处理', 'precheck_action_required', 'operator');
  assertEventCount(booking, '车主已发起维修报价', 'precheck_action_required', 'owner');
  assertEventCount(booking, '车主已提交预检复核', 'pending_precheck', 'owner');
  assertEventCount(booking, '检测站预审通过', 'awaiting_arrival', 'operator');
  if (booking.events.some((event) => event?.title === '等待车辆到站')) {
    throw new Error('Self-drive approval contains a duplicate legacy station-accept event.');
  }
  await capture(miniProgram, '15-owner-awaiting-arrival-payment-retained');
  return booking;
}

async function connectToDevtools() {
  if (automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return automator.launcher.connectTool({ wsEndpoint: endpoint });
  }
  return automator.connect({ wsEndpoint: endpoint });
}

function writeSummary(payload) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const summaryPath = path.join(artifactsDir, 'run-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return summaryPath;
}

async function run() {
  const manifest = readJson(manifestPath, 'Local annual-inspection media manifest');
  validateConfiguration(manifest);
  let miniProgram;
  let phase = 'connect';
  const startedAt = new Date().toISOString();
  const issues = [];
  try {
    miniProgram = await connectToDevtools();
    EventEmitter.prototype.on.call(miniProgram, 'console', (message) => {
      const type = String(message?.type || '').toLowerCase();
      if (!['error', 'assert'].includes(type)) return;
      const detail = redact(Array.isArray(message?.args) ? message.args.map(String).join(' ') : '');
      issues.push({ source: 'console', type, detail });
      console.error(`[mini-program console:${type}] ${detail}`);
    });
    EventEmitter.prototype.on.call(miniProgram, 'exception', (exception) => {
      const detail = redact(exception?.stack || exception?.message || exception || 'Unknown mini-program exception');
      issues.push({ source: 'exception', type: 'exception', detail });
      console.error(`[mini-program exception] ${detail}`);
    });
    await waitUntil(() => miniProgram.currentPage(), 'Waiting for WeChat simulator runtime');
    await waitUntil(() => miniProgram.send('App.enableLog'), 'Enabling mini-program console capture');

    phase = 'owner-booking';
    const { booking, originalSlot } = await enterNewSelfDriveBooking(miniProgram, manifest);
    await uploadInitialSevenPhotos(miniProgram, booking);
    const created = await createAndPayBooking(miniProgram, booking, originalSlot);

    phase = 'station-first-review';
    const first = await openUniquePendingTask(miniProgram, created.bookingId, '05-station-first-pending-task');
    const firstTaskId = first.task.id;
    const firstBooking = await first.precheck.data('booking');
    if (firstBooking?.precheck?.supervision?.taskId !== firstTaskId) throw new Error('The first rendered workflow card and precheck supervision record disagree.');
    await rejectFromStation(miniProgram, first.precheck, created.bookingId, created.feeFen);
    await assertPendingTaskAbsent(miniProgram, created.bookingId, '06b-station-first-task-closed');

    phase = 'owner-problem-actions';
    const owner = await openOwnerActionsAfterRejection(miniProgram, created.bookingId, created.feeFen, firstTaskId, originalSlot);
    let actions = await verifyWashEntry(miniProgram, owner.actions, created.bookingId);
    const repair = await verifyRepairEntry(miniProgram, actions, created.bookingId);
    actions = repair.actions;
    const resubmitted = await replacePhotosAndResubmit(
      miniProgram,
      actions,
      owner.rejected,
      originalSlot,
      created.initialMediaIds,
      created.feeFen,
    );

    phase = 'station-second-review';
    const second = await openUniquePendingTask(miniProgram, created.bookingId, '13-station-single-reopened-task');
    const secondTaskId = second.task.id;
    if (secondTaskId === firstTaskId) throw new Error('The closed first-round task was reused rather than reopened as a new review task.');
    if (resubmitted.booking.precheck?.supervision?.taskId !== secondTaskId || resubmitted.booking.precheck?.supervision?.status !== 'open') {
      throw new Error('The resubmitted booking does not expose the unique reopened supervision task.');
    }
    await approveResubmission(
      miniProgram,
      second.precheck,
      created.bookingId,
      created.feeFen,
      resolutionNote,
      resubmitted.replacementIds,
    );
    await assertPendingTaskAbsent(miniProgram, created.bookingId, '14b-station-reopened-task-closed');

    phase = 'owner-final';
    const finalBooking = await verifyFinalOwnerState(
      miniProgram,
      created.bookingId,
      created.feeFen,
      resubmitted.nextSlot,
      firstTaskId,
      secondTaskId,
      repair.repairRequestId,
      resubmitted.replacementIds,
    );
    if (issues.length) throw new Error(`Native run captured ${issues.length} console error/assert or exception event(s).`);

    const summaryPath = writeSummary({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'passed',
      scope: 'native-precheck-return-resubmit-approve',
      bookingId: created.bookingId,
      serviceMode: 'self_drive',
      stationId,
      originalSlotId: originalSlot.id,
      replacementSlotId: resubmitted.nextSlot.id,
      paymentRetained: Number(finalBooking.paidFen) === created.feeFen && Number(finalBooking.refundedFen || 0) === 0,
      requiredPhotoCount: mediaKinds.length,
      replacementPhotoKinds: [...issuePhotoKinds],
      washEntryVerified: true,
      multiShopRepairEntryVerified: true,
      linkedRepairRequestId: repair.repairRequestId,
      initialPendingTaskId: firstTaskId,
      reopenedPendingTaskId: secondTaskId,
      pendingTaskReopenedWithoutDuplicate: firstTaskId !== secondTaskId,
      finalPendingTaskClosed: true,
      finalStatus: finalBooking.status,
      finalPrecheckVersion: finalBooking.precheck.version,
      duplicateLegacyAcceptEvent: false,
      consoleIssueCount: issues.length,
    });
    console.log('Native precheck rejection/resubmission QA passed.');
    console.log(`Sanitized summary: ${summaryPath}`);
  } catch (error) {
    const message = redact(error && error.message ? error.message : error);
    if (miniProgram) await capture(miniProgram, `FAILED-${phase}`).catch(() => undefined);
    const summaryPath = writeSummary({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'failed',
      scope: 'native-precheck-return-resubmit-approve',
      phase,
      error: message,
      consoleIssueCount: issues.length,
    });
    console.error(`Native precheck rejection/resubmission QA failed at ${phase}: ${message}`);
    console.error(`Sanitized summary: ${summaryPath}`);
    process.exitCode = 1;
  } finally {
    if (miniProgram) {
      await miniProgram.restoreWxMethod('chooseMedia').catch(() => undefined);
      await miniProgram.restoreWxMethod('getLocation').catch(() => undefined);
      miniProgram.disconnect();
    }
  }
}

void run();
