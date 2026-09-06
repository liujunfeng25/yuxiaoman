'use strict';

/**
 * Native WeChat DevTools annual-inspection end-to-end QA.
 *
 * The script deliberately drives rendered mini-program elements. Deterministic
 * local QA fixtures enter through a mocked wx.chooseMedia without automating
 * the host OS file picker; native confirmation dialogs are still clicked by
 * the automator. Upload, quote, booking creation, precheck and mock payment use
 * the running local API.
 *
 * Privacy boundary: vehicle identifiers are read only from the ignored local
 * manifest. Screenshots and the sanitized run summary are written below the
 * ignored .runtime directory by default.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const automator = require('miniprogram-automator');
const { chromium } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(repoRoot, '.runtime', 'annual-demo-media');
const manifestPath = path.resolve(process.env.WECHAT_QA_ANNUAL_MANIFEST || path.join(runtimeRoot, 'manifest.local.json'));
const preparedRootFromEnvironment = String(process.env.WECHAT_QA_ANNUAL_PREPARED_DIR || '').trim();
let preparedRoot = path.resolve(preparedRootFromEnvironment || path.join(runtimeRoot, 'prepared'));
const artifactsDir = path.resolve(process.env.WECHAT_QA_ANNUAL_ARTIFACTS || path.join(runtimeRoot, 'artifacts', 'native-annual-booking-e2e'));
const endpoint = process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421';
const fixtureOrigin = String(process.env.WECHAT_QA_FIXTURE_ORIGIN || 'http://127.0.0.1:9008').replace(/\/+$/, '');
const scenarioChoice = String(process.env.WECHAT_QA_ANNUAL_SCENARIO || 'all').trim().toLowerCase();
const allowSyntheticDocument = process.env.WECHAT_QA_ALLOW_SYNTHETIC_DOCUMENT === '1';
const pickupQuery = String(process.env.WECHAT_QA_PICKUP_QUERY || '天津文化中心').trim();
const contactName = String(process.env.WECHAT_QA_CONTACT_NAME || '测试车主').trim();
const contactPhone = String(process.env.WECHAT_QA_CONTACT_PHONE || '13800001234').trim();
const fullClosure = process.env.WECHAT_QA_BOOKING_ONLY !== '1';
const resumeActive = process.env.WECHAT_QA_RESUME_ACTIVE === '1';
const allowLegacyActiveResume = process.env.WECHAT_QA_ALLOW_LEGACY_ACTIVE_RESUME === '1';
const screenshotsOptional = process.env.WECHAT_QA_SCREENSHOTS_OPTIONAL === '1';
const verifyCompletedOnly = process.env.WECHAT_QA_VERIFY_COMPLETED_ONLY === '1';
const adminOrigin = String(process.env.WECHAT_QA_ADMIN_ORIGIN || 'http://127.0.0.1:5174').replace(/\/+$/, '');
let adminLogin = String(process.env.WECHAT_QA_ADMIN_LOGIN || '').trim();
let adminPassword = String(process.env.WECHAT_QA_ADMIN_PASSWORD || '');
let operatorLogin = String(process.env.WECHAT_QA_OPERATOR_LOGIN || '').trim();
let operatorPassword = String(process.env.WECHAT_QA_OPERATOR_PASSWORD || '');
let operatorStationId = String(process.env.WECHAT_QA_OPERATOR_STATION_ID || '').trim();
const driverName = String(process.env.WECHAT_QA_DRIVER_NAME || '本地测试司机').trim();
const driverPhone = String(process.env.WECHAT_QA_DRIVER_PHONE || '13900000001').trim();
const defaultTimeoutMs = parsePositiveInteger(process.env.WECHAT_QA_TIMEOUT_MS, 45_000, 'WECHAT_QA_TIMEOUT_MS');
const uploadTimeoutMs = parsePositiveInteger(process.env.WECHAT_QA_UPLOAD_TIMEOUT_MS, 60_000, 'WECHAT_QA_UPLOAD_TIMEOUT_MS');

const HOME_ROUTE = 'pages/home/home';
const VEHICLES_ROUTE = 'packages/vehicle/pages/vehicles/vehicles';
const STATIONS_ROUTE = 'packages/annual/pages/stations/stations';
const SLOTS_ROUTE = 'packages/annual/pages/slots/slots';
const BOOKING_ROUTE = 'packages/annual/pages/booking/booking';
const ORDER_DETAIL_ROUTE = 'packages/annual/pages/order-detail/order-detail';
const OPERATOR_LOGIN_ROUTE = 'packages/operator/pages/operator-login/operator-login';
const OPERATOR_PRECHECK_ROUTE = 'packages/operator/pages/precheck-detail/precheck-detail';
const OPERATOR_DETAIL_ROUTE = 'packages/operator/pages/operator-detail/operator-detail';
const CHECKUP_EDITOR_ROUTE = 'packages/inspection/pages/checkup-editor/checkup-editor';
const CHECKUP_REPORT_ROUTE = 'packages/inspection/pages/checkup-report/checkup-report';
const DRIVER_LOGIN_ROUTE = 'packages/driver/pages/login/login';
const DRIVER_TASK_ROUTE = 'packages/driver/pages/task/task';

const bookingAssetByKind = Object.freeze({
  vehicle_front_left: 'frontLeft.jpg',
  vehicle_front_right: 'frontRight.jpg',
  vehicle_rear_left: 'rearLeft.jpg',
  vehicle_rear_right: 'rearRight.jpg',
  dashboard_started: 'dashboardStarted.jpg',
  license_front: 'licenseFront.jpg',
  license_back: 'licenseBack.jpg',
});

const siteAssetByKind = Object.freeze({
  front_left: 'frontLeft.jpg',
  front_right: 'frontRight.jpg',
  rear_left: 'rearLeft.jpg',
  rear_right: 'rearRight.jpg',
  dashboard_started: 'dashboardStarted.jpg',
});

const siteKinds = Object.freeze(Object.keys(siteAssetByKind));

const scenarioDefinitions = Object.freeze({
  'self-drive': {
    manifestKey: 'selfDrive',
    assetDirectory: 'self-drive',
    serviceMode: 'self_drive',
    noteLabel: '自驾验车',
    homeSelector: '.self-drive-job',
    expectedMediaKinds: [
      'vehicle_front_left',
      'vehicle_front_right',
      'vehicle_rear_left',
      'vehicle_rear_right',
      'dashboard_started',
      'license_front',
      'license_back',
    ],
  },
  valet: {
    manifestKey: 'valet',
    assetDirectory: 'valet',
    serviceMode: 'valet',
    noteLabel: '代驾验车',
    homeSelector: '.valet-job',
    expectedMediaKinds: [
      'vehicle_front_left',
      'vehicle_front_right',
      'vehicle_rear_left',
      'vehicle_rear_right',
      'dashboard_started',
      'license_front',
      'license_back',
    ],
  },
});

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function selectedScenarios() {
  if (scenarioChoice === 'all') return ['self-drive', 'valet'];
  if (scenarioDefinitions[scenarioChoice]) return [scenarioChoice];
  throw new Error('WECHAT_QA_ANNUAL_SCENARIO must be all, self-drive, or valet.');
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing. Run the local annual-inspection fixture loader first.`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error && error.message ? error.message : error}`);
  }
}

function normalizePlate(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z\u4e00-\u9fff]/gu, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function browserLaunchOptions() {
  const explicit = String(process.env.WECHAT_QA_BROWSER_EXECUTABLE || '').trim();
  const candidates = [
    explicit,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

async function waitUntil(operation, label, options = {}) {
  const timeoutMs = options.timeoutMs || defaultTimeoutMs;
  const intervalMs = options.intervalMs || 250;
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const detail = lastError && lastError.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`${label} timed out after ${timeoutMs} ms.${detail}`);
}

async function currentPage(miniProgram, expectedPath, label = expectedPath) {
  return waitUntil(async () => {
    const page = await miniProgram.currentPage();
    return page && page.path === expectedPath ? page : null;
  }, `Waiting for ${label}`);
}

async function waitForPageData(page, selector, predicate, label, timeoutMs = defaultTimeoutMs) {
  const matched = await waitUntil(async () => {
    const value = await page.data(selector);
    return predicate(value) ? { value } : null;
  }, label, { timeoutMs });
  return matched.value;
}

async function waitForElement(page, selector, label, timeoutMs = defaultTimeoutMs) {
  return waitUntil(() => page.$(selector), `Waiting for ${label}`, { timeoutMs });
}

async function waitForStationPickerSettled(miniProgram, stations, expectedCount) {
  await currentPage(miniProgram, STATIONS_ROUTE, 'settled inspection station picker');
  await waitForPageData(stations, 'loading', (value) => value === false, 'Waiting for settled inspection stations');
  await waitUntil(async () => {
    const cards = await stations.$$('.station-card');
    if (cards.length !== expectedCount) return null;
    const sizes = await Promise.all(cards.map((card) => card.size()));
    return sizes.every((size) => Number(size && size.width) > 0 && Number(size && size.height) > 0) ? cards : null;
  }, 'Waiting for all inspection station cards to finish rendering');
  // The simulator can briefly retain the outgoing frame after the data and
  // node counts have settled. Keep the page visible for one paint window,
  // then re-check the route and loading flag before taking evidence.
  await delay(900);
  await currentPage(miniProgram, STATIONS_ROUTE, 'stable inspection station picker');
  await waitForPageData(stations, 'loading', (value) => value === false, 'Rechecking stable inspection stations');
}

async function capture(miniProgram, scenarioName, step) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, `${scenarioName}-${step}.png`);
  // Evidence screenshots should show the settled page rather than a transient
  // upload/success toast that can obscure the content being reviewed.
  await miniProgram.callWxMethod('hideToast').catch(() => undefined);
  await delay(120);
  try {
    await miniProgram.screenshot({ path: filePath });
  } catch (error) {
    if (!screenshotsOptional) throw error;
    const message = error && error.message ? error.message : String(error);
    console.warn(`[${scenarioName}] screenshot ${step} skipped: ${message}`);
    return null;
  }
  console.log(`[${scenarioName}] screenshot ${step}`);
  return filePath;
}

async function frameBookingUploadEvidence(miniProgram, booking, scenarioName, expectedUploadedCount) {
  const definition = scenarioDefinitions[scenarioName];
  const uploads = await booking.data('uploads');
  const uploadedCount = Array.isArray(uploads) ? uploads.filter((item) => item && item.media).length : 0;
  if (uploadedCount !== expectedUploadedCount) {
    throw new Error(`${scenarioName} upload evidence expected ${expectedUploadedCount} completed slots, got ${uploadedCount}.`);
  }

  const mediaSection = await waitForElement(booking, '.media-section', `${scenarioName} booking upload evidence section`);
  const requiredCount = await mediaSection.$('.required-count');
  const requiredCountText = requiredCount ? String(await requiredCount.text()).trim() : '';
  if (!requiredCountText.includes(String(definition.expectedMediaKinds.length))) {
    throw new Error(`${scenarioName} upload evidence does not render the required media count.`);
  }

  await waitUntil(async () => {
    const completedCards = await booking.$$('.upload-card.complete');
    return completedCards.length === expectedUploadedCount ? completedCards : null;
  }, `Waiting for ${scenarioName} completed upload cards to render`);

  await miniProgram.pageScrollTo(0);
  await delay(120);
  const offset = await mediaSection.offset();
  const sectionTop = Number(offset && offset.top);
  if (!Number.isFinite(sectionTop)) throw new Error(`${scenarioName} booking upload evidence section has no measurable position.`);
  await miniProgram.pageScrollTo(Math.max(0, sectionTop - 16));
  await delay(450);
}

function scenarioManifest(manifest, scenarioName) {
  const definition = scenarioDefinitions[scenarioName];
  const item = manifest && manifest[definition.manifestKey];
  if (!item || !item.plateNumber) {
    throw new Error(`The local manifest does not contain the ${scenarioName} vehicle fixture.`);
  }
  return item;
}

function resolveAsset(scenarioName, kind) {
  const definition = scenarioDefinitions[scenarioName];
  const filename = bookingAssetByKind[kind];
  if (!filename) throw new Error(`No fixture filename is configured for media kind ${kind}.`);
  const realFile = path.join(preparedRoot, definition.assetDirectory, filename);
  if (fs.existsSync(realFile)) return realFile;
  const extension = path.extname(filename);
  const placeholder = path.join(preparedRoot, definition.assetDirectory, `${path.basename(filename, extension)}.TEST-ONLY${extension}`);
  if (fs.existsSync(placeholder)) {
    if (!allowSyntheticDocument) {
      throw new Error(`The ${scenarioName} ${kind} fixture is a visibly labelled test placeholder. Set WECHAT_QA_ALLOW_SYNTHETIC_DOCUMENT=1 only for an isolated local demo run.`);
    }
    return placeholder;
  }
  throw new Error(`The prepared ${scenarioName} ${kind} fixture is missing. Run the local annual-inspection fixture loader first.`);
}

function resolveSiteAsset(scenarioName, kind) {
  const definition = scenarioDefinitions[scenarioName];
  const filename = siteAssetByKind[kind];
  if (!filename) throw new Error(`No fixture filename is configured for site media kind ${kind}.`);
  const filePath = path.join(preparedRoot, definition.assetDirectory, filename);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) {
    throw new Error(`The prepared ${scenarioName} ${kind} fixture is missing or empty.`);
  }
  return filePath;
}

function resolveInspectionMark(scenarioName) {
  const definition = scenarioDefinitions[scenarioName];
  const realFile = path.join(preparedRoot, definition.assetDirectory, 'annualInspectionMark.jpg');
  if (fs.existsSync(realFile) && fs.statSync(realFile).size > 0) return realFile;
  const placeholder = path.join(preparedRoot, definition.assetDirectory, 'annualInspectionMark.TEST-ONLY.jpg');
  if (fs.existsSync(placeholder) && fs.statSync(placeholder).size > 0) {
    if (!allowSyntheticDocument) {
      throw new Error(`The ${scenarioName} annual-inspection mark is a visibly labelled test placeholder. Set WECHAT_QA_ALLOW_SYNTHETIC_DOCUMENT=1 only for an isolated local demo run.`);
    }
    return placeholder;
  }
  throw new Error(`The prepared ${scenarioName} annual-inspection mark fixture is missing.`);
}

function resolveSafetyInspectionReport(scenarioName) {
  const definition = scenarioDefinitions[scenarioName];
  const realFile = path.join(preparedRoot, definition.assetDirectory, 'safetyInspectionReport.jpg');
  if (fs.existsSync(realFile) && fs.statSync(realFile).size > 0) return realFile;
  const placeholder = path.join(preparedRoot, definition.assetDirectory, 'safetyInspectionReport.TEST-ONLY.jpg');
  if (fs.existsSync(placeholder) && fs.statSync(placeholder).size > 0) {
    if (!allowSyntheticDocument) {
      throw new Error(`The ${scenarioName} safety-inspection report is a visibly labelled test placeholder. Set WECHAT_QA_ALLOW_SYNTHETIC_DOCUMENT=1 only for an isolated local demo run.`);
    }
    return placeholder;
  }
  throw new Error(`The prepared ${scenarioName} safety-inspection report fixture is missing.`);
}

function fixtureUrl(hostFile) {
  const relative = path.relative(preparedRoot, hostFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Prepared fixture resolved outside the local annual-inspection media directory.');
  }
  const encoded = relative.split(path.sep).map(encodeURIComponent).join('/');
  return `${fixtureOrigin}/${encoded}`;
}

async function mockChooseMediaDownload(miniProgram, url, size) {
  // miniprogram-automator recognizes function-declaration strings only when
  // they begin with `function` or `() =>`; a parameterized arrow string would
  // otherwise be installed as a literal result value and never call success.
  const functionDeclaration = `function(options){return new Promise((resolve,reject)=>wx.downloadFile({url:${JSON.stringify(url)},success:(result)=>resolve({tempFiles:[{tempFilePath:result.tempFilePath,size:${size},fileType:'image'}],type:'image',errMsg:'chooseMedia:ok'}),fail:reject}))}`;
  await miniProgram.mockWxMethod('chooseMedia', functionDeclaration);
}

async function elementByAttribute(page, selector, attribute, expected, label) {
  const elements = await page.$$(selector);
  for (const element of elements) {
    if (String(await element.attribute(attribute)) === String(expected)) return element;
  }
  throw new Error(`${label} was not rendered (${attribute}=${expected}).`);
}

async function relaunchPage(miniProgram, route, query = '', label = route) {
  const suffix = query ? `?${query}` : '';
  await miniProgram.callWxMethod('reLaunch', { url: `/${route}${suffix}` });
  await delay(1_200);
  return currentPage(miniProgram, route, label);
}

async function useFixtureForNextChooseMedia(miniProgram, filePath) {
  await mockChooseMediaDownload(miniProgram, fixtureUrl(filePath), fs.statSync(filePath).size);
}

async function useAlbumForNextActionSheet(miniProgram) {
  const functionDeclaration = "function(){return Promise.resolve({tapIndex:1,errMsg:'showActionSheet:ok'})}";
  await miniProgram.mockWxMethod('showActionSheet', functionDeclaration);
}

async function useTianjinQaLocation(miniProgram) {
  // DevTools can retain a simulator location from an unrelated project. Keep
  // this UI run deterministic while still exercising the rendered self-drive
  // location -> station-ranking flow and the running API.
  const functionDeclaration = "function(){return Promise.resolve({latitude:39.084158,longitude:117.200983,speed:0,accuracy:10,altitude:0,verticalAccuracy:10,horizontalAccuracy:10,errMsg:'getLocation:ok'})}";
  await miniProgram.mockWxMethod('getLocation', functionDeclaration);
}

function validateLocalFixtures(manifest, scenarios) {
  for (const scenarioName of scenarios) {
    scenarioManifest(manifest, scenarioName);
    for (const kind of scenarioDefinitions[scenarioName].expectedMediaKinds) {
      const asset = resolveAsset(scenarioName, kind);
      const stat = fs.statSync(asset);
      if (!stat.isFile() || stat.size <= 0) throw new Error(`The prepared ${scenarioName} ${kind} fixture is empty.`);
    }
    if (fullClosure) {
      for (const kind of siteKinds) resolveSiteAsset(scenarioName, kind);
      resolveInspectionMark(scenarioName);
      resolveSafetyInspectionReport(scenarioName);
    }
  }
}

async function reLaunchHome(miniProgram) {
  await miniProgram.callWxMethod('reLaunch', { url: '/pages/home/home' });
  // If the simulator was already on Home, getCurrentPage can briefly return
  // the destroyed pre-reLaunch page instance. Allow the new page to mount.
  await delay(2_000);
  const page = await currentPage(miniProgram, HOME_ROUTE, 'owner home');
  await waitForPageData(page, 'loading', (value) => value === false, 'Waiting for owner home data');
  const loadError = await page.data('loadError');
  if (loadError && !(await page.data('hero'))) throw new Error(`Owner home failed to load: ${loadError}`);
  return page;
}

async function ensureScenarioVehicle(miniProgram, scenarioName, manifest) {
  const expectedPlate = normalizePlate(scenarioManifest(manifest, scenarioName).plateNumber);
  let home = await reLaunchHome(miniProgram);
  const currentVehicle = await home.data('vehicle');
  if (normalizePlate(currentVehicle && currentVehicle.plateNumber) === expectedPlate) return home;

  const garageEntry = await waitForElement(home, '.hero-plate', 'vehicle garage entry');
  await garageEntry.tap();
  const garage = await currentPage(miniProgram, VEHICLES_ROUTE, 'vehicle garage');
  await waitForPageData(garage, 'loading', (value) => value === false, 'Waiting for vehicle garage data');
  const vehicles = await garage.data('vehicles');
  const vehicleIndex = Array.isArray(vehicles)
    ? vehicles.findIndex((vehicle) => normalizePlate(vehicle && vehicle.plateNumber) === expectedPlate)
    : -1;
  if (vehicleIndex < 0) throw new Error(`The ${scenarioName} fixture vehicle is not available to the signed-in owner.`);
  if (vehicles[vehicleIndex].isDefault) return reLaunchHome(miniProgram);

  const cards = await waitUntil(async () => {
    const rendered = await garage.$$('.vehicle');
    return rendered.length >= vehicles.length ? rendered : null;
  }, 'Waiting for vehicle garage cards to finish rendering');
  const targetCard = cards[vehicleIndex];
  if (!targetCard) throw new Error(`The ${scenarioName} fixture vehicle card was not rendered.`);
  const makeDefault = await targetCard.$('.default-action');
  if (!makeDefault) throw new Error(`The ${scenarioName} fixture vehicle cannot be selected as the current vehicle.`);
  await makeDefault.tap();

  home = await currentPage(miniProgram, HOME_ROUTE, 'owner home after selecting vehicle');
  await waitForPageData(home, 'loading', (value) => value === false, 'Waiting for selected vehicle on owner home');
  await waitForPageData(
    home,
    'vehicle',
    (vehicle) => normalizePlate(vehicle && vehicle.plateNumber) === expectedPlate,
    `Waiting for the ${scenarioName} fixture vehicle to become current`,
  );
  return home;
}

async function enterBookingFlow(miniProgram, scenarioName, manifest) {
  const definition = scenarioDefinitions[scenarioName];
  const home = await ensureScenarioVehicle(miniProgram, scenarioName, manifest);
  const activeBooking = await home.data('activeBooking');
  if (activeBooking) {
    throw new Error(`The ${scenarioName} fixture vehicle already has an active annual-inspection order. Reload the isolated fixture schema before rerunning this scenario.`);
  }
  const hero = await home.data('hero');
  if (!hero || hero.canBookInspection !== true) {
    throw new Error(`The ${scenarioName} fixture vehicle is not currently eligible for direct booking. Resolve its annual-inspection date evidence before running the happy path.`);
  }

  await capture(miniProgram, scenarioName, '01-home-entry');
  const entry = await waitForElement(home, definition.homeSelector, `${scenarioName} home entry`);
  if (definition.serviceMode === 'self_drive') await useTianjinQaLocation(miniProgram);
  await entry.tap();
  const stations = await currentPage(miniProgram, STATIONS_ROUTE, 'inspection station picker');
  await waitForPageData(stations, 'loading', (value) => value === false, 'Waiting for inspection stations');
  if (definition.serviceMode === 'self_drive') await miniProgram.restoreWxMethod('getLocation').catch(() => undefined);
  if ((await stations.data('mode')) !== definition.serviceMode) throw new Error(`Station picker opened with the wrong service mode for ${scenarioName}.`);

  if (definition.serviceMode === 'valet') {
    if (pickupQuery.length < 2) throw new Error('WECHAT_QA_PICKUP_QUERY must contain at least two characters.');
    const searchInput = await waitForElement(stations, '.pickup-search-input', 'valet pickup search input');
    await searchInput.input('');
    await waitForPageData(stations, 'searchQuery', (value) => value === '', 'Waiting for an empty valet pickup search field');
    await searchInput.input(pickupQuery);
    await waitForPageData(stations, 'searching', (value) => value === false, 'Waiting for pickup suggestions');
    const suggestions = await stations.data('suggestions');
    if (!Array.isArray(suggestions) || suggestions.length === 0 || !suggestions[0].locationProof) {
      const searchError = await stations.data('searchError');
      throw new Error(`Valet pickup search did not return a signed address${searchError ? `: ${searchError}` : '.'}`);
    }
    const suggestion = await waitForElement(stations, '.suggestion-row', 'signed valet pickup suggestion');
    await suggestion.tap();
    await waitForPageData(stations, 'loading', (value) => value === false, 'Waiting for route-ranked stations');
    await waitForPageData(stations, 'hasOrigin', (value) => value === true, 'Waiting for valet pickup origin');
  }

  const stationItems = await stations.data('stations');
  if (!Array.isArray(stationItems) || stationItems.length === 0) throw new Error(`No inspection station is available for ${scenarioName}.`);
  const stationIndex = stationItems.findIndex((station) => station && station.id === operatorStationId);
  if (stationIndex < 0) {
    throw new Error(`The inspection-station picker does not render the scoped QA station ${operatorStationId || '(missing station scope)'}.`);
  }
  await waitForStationPickerSettled(miniProgram, stations, stationItems.length);
  await capture(miniProgram, scenarioName, '02-station-picker');
  const stationCards = await stations.$$('.station-card');
  if (!stationCards[stationIndex]) throw new Error(`The scoped ${scenarioName} inspection-station card was not rendered.`);
  await stationCards[stationIndex].tap();

  const slots = await currentPage(miniProgram, SLOTS_ROUTE, 'inspection slot picker');
  await waitForPageData(slots, 'loading', (value) => value === false, 'Waiting for inspection slots');
  const slotItems = await slots.data('slots');
  const availableIndex = Array.isArray(slotItems) ? slotItems.findIndex((slot) => Number(slot && slot.remaining) > 0) : -1;
  if (availableIndex < 0) throw new Error(`No available inspection slot is rendered for ${scenarioName}.`);
  const slotCards = await slots.$$('.slot-card');
  if (!slotCards[availableIndex]) throw new Error(`The available ${scenarioName} slot card was not rendered.`);
  await slotCards[availableIndex].tap();

  const booking = await currentPage(miniProgram, BOOKING_ROUTE, 'booking confirmation');
  await waitForPageData(booking, 'loading', (value) => value === false, 'Waiting for booking confirmation data');
  await waitForPageData(booking, 'quoting', (value) => value === false, 'Waiting for booking quote');
  const loadError = await booking.data('loadError');
  if (loadError) throw new Error(`Booking confirmation failed to load: ${loadError}`);
  const quote = await booking.data('quote');
  if (!quote || !quote.quoteSnapshotId || quote.serviceable !== true || Number(quote.serviceFeeFen) <= 0) {
    const quoteError = await booking.data('quoteError');
    throw new Error(`The ${scenarioName} server quote is not payable${quoteError ? `: ${quoteError}` : '.'}`);
  }
  if (definition.serviceMode === 'self_drive' && Number(quote.valetFeeFen) !== 0) throw new Error('Self-drive quote unexpectedly contains a valet fee.');
  if (definition.serviceMode === 'valet' && Number(quote.valetFeeFen) <= 0) throw new Error('Valet quote does not contain a non-zero route fee.');

  const nameInput = await waitForElement(booking, 'input[data-field="contactName"]', 'booking contact name');
  const phoneInput = await waitForElement(booking, 'input[data-field="contactPhone"]', 'booking contact phone');
  await nameInput.input(contactName);
  await phoneInput.input(contactPhone);
  const noteInput = await booking.$('textarea[data-field="note"]');
  if (noteInput) await noteInput.input(`全流程演示 · ${definition.noteLabel}`);
  await capture(miniProgram, scenarioName, '03-booking-before-upload');
  return booking;
}

async function uploadBookingMedia(miniProgram, booking, scenarioName) {
  const definition = scenarioDefinitions[scenarioName];
  const uploadedKinds = [];
  try {
    const renderedUploads = await booking.data('uploads');
    const renderedKinds = Array.isArray(renderedUploads) ? renderedUploads.map((item) => item.kind) : [];
    if (renderedKinds.length !== definition.expectedMediaKinds.length || definition.expectedMediaKinds.some((kind) => !renderedKinds.includes(kind))) {
      throw new Error(`${scenarioName} rendered ${renderedKinds.length} upload slots; expected ${definition.expectedMediaKinds.length}.`);
    }

    for (const kind of definition.expectedMediaKinds) {
      const asset = resolveAsset(scenarioName, kind);
      const size = fs.statSync(asset).size;
      await mockChooseMediaDownload(miniProgram, fixtureUrl(asset), size);

      const currentUploads = await booking.data('uploads');
      const index = currentUploads.findIndex((item) => item.kind === kind);
      const buttons = await booking.$$('.upload-card');
      if (index < 0 || !buttons[index]) throw new Error(`The ${scenarioName} ${kind} upload button is missing.`);
      await buttons[index].tap();

      await waitUntil(async () => {
        const uploads = await booking.data('uploads');
        const item = uploads.find((candidate) => candidate.kind === kind);
        return item && item.media && !item.uploading ? uploads : null;
      }, `Waiting for ${scenarioName} ${kind} upload`, { timeoutMs: uploadTimeoutMs });
      uploadedKinds.push(kind);

      const cumulativeUploads = await booking.data('uploads');
      for (const previousKind of uploadedKinds) {
        const previous = cumulativeUploads.find((item) => item.kind === previousKind);
        if (!previous || !previous.media) {
          throw new Error(`Cumulative upload regression: ${previousKind} disappeared after uploading ${kind}.`);
        }
      }
      const mediaUploadingCount = await booking.data('mediaUploadingCount');
      if (Number(mediaUploadingCount) !== 0) throw new Error(`Upload counter did not settle after ${kind}.`);

      if (uploadedKinds.length === Math.min(2, definition.expectedMediaKinds.length)) {
        await frameBookingUploadEvidence(miniProgram, booking, scenarioName, uploadedKinds.length);
        await capture(miniProgram, scenarioName, '04-two-uploads-retained');
      }
    }
  } finally {
    await miniProgram.restoreWxMethod('chooseMedia').catch(() => undefined);
  }

  await frameBookingUploadEvidence(miniProgram, booking, scenarioName, uploadedKinds.length);
  await capture(miniProgram, scenarioName, '05-all-uploads-retained');
  return uploadedKinds.length;
}

function pendingPrecheckPaymentEvent(booking) {
  return Array.isArray(booking && booking.events)
    ? booking.events.find((event) => event && event.status === 'pending_precheck' && event.title === '支付已确认' && event.actorType === 'owner')
    : null;
}

function assertPaidPendingPrecheck(booking, scenarioName) {
  if (!booking || booking.status !== 'pending_precheck' || booking.paymentStatus !== 'paid') {
    throw new Error(`The paid ${scenarioName} order did not enter pending_precheck.`);
  }
  if (!pendingPrecheckPaymentEvent(booking)) {
    throw new Error(`The ${scenarioName} order timeline does not contain the paid-to-pending_precheck transition.`);
  }
}

async function submitAndPay(miniProgram, booking, scenarioName, expectedMediaCount) {
  const submit = await waitForElement(booking, '.submit-bar > button', 'submit booking button');
  const disabled = await submit.attribute('disabled');
  if (disabled === true || disabled === 'true') throw new Error(`The ${scenarioName} submit button is disabled after all required uploads completed.`);
  await submit.tap();

  const detail = await currentPage(miniProgram, ORDER_DETAIL_ROUTE, 'new annual-inspection order detail');
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for new order detail');
  const bookingRecord = await waitForPageData(detail, 'booking', Boolean, 'Waiting for the created order');
  if (bookingRecord.serviceMode !== scenarioDefinitions[scenarioName].serviceMode) throw new Error(`The created ${scenarioName} order has the wrong service mode.`);
  if (bookingRecord.status !== 'pending_payment' || bookingRecord.paymentStatus !== 'unpaid') throw new Error(`The new ${scenarioName} order did not enter pending mock payment.`);
  if (!bookingRecord.quoteSnapshotId || Number(bookingRecord.serviceFeeFen) <= 0) throw new Error(`The new ${scenarioName} order is missing a non-zero frozen quote.`);
  if (!Array.isArray(bookingRecord.media) || bookingRecord.media.length !== expectedMediaCount) {
    throw new Error(`The new ${scenarioName} order saved ${Array.isArray(bookingRecord.media) ? bookingRecord.media.length : 0} booking images; expected ${expectedMediaCount}.`);
  }
  await capture(miniProgram, scenarioName, '06-order-pending-payment');

  const payButton = await waitForElement(detail, '.pay-button', 'mock payment button');
  await payButton.tap();
  const paidBooking = await waitForPageData(
    detail,
    'booking',
    (value) => value && value.status === 'pending_precheck' && value.paymentStatus === 'paid',
    `Waiting for ${scenarioName} mock payment to enter pending precheck`,
  );
  assertPaidPendingPrecheck(paidBooking, scenarioName);
  if (Number(paidBooking.paidFen) !== Number(paidBooking.serviceFeeFen) || Number(paidBooking.paidFen) <= 0) {
    throw new Error(`The ${scenarioName} mock payment ledger does not match the frozen non-zero amount.`);
  }
  await assertPaidOrderHidesRequote(detail, scenarioName);
  await capture(miniProgram, scenarioName, '07-order-paid-pending-precheck');

  return {
    scenario: scenarioName,
    bookingId: paidBooking.id,
    bookingNumber: paidBooking.bookingNumber,
    serviceMode: paidBooking.serviceMode,
    status: paidBooking.status,
    paymentStatus: paidBooking.paymentStatus,
    amountFen: Number(paidBooking.serviceFeeFen),
    paidFen: Number(paidBooking.paidFen),
    bookingPhotoCount: paidBooking.media.length,
    quoteSnapshotPresent: Boolean(paidBooking.quoteSnapshotId),
    pendingPrecheckEventPresent: true,
  };
}

async function assertPaidOrderHidesRequote(detail, scenarioName) {
  if (await detail.data('paymentPending')) {
    throw new Error(`The paid ${scenarioName} order still reports paymentPending=true.`);
  }
  if (await detail.data('quoteExpired')) {
    throw new Error(`The paid ${scenarioName} order still reports quoteExpired=true.`);
  }
  if (await detail.$('.quote-expired-actions')) {
    throw new Error(`The paid ${scenarioName} order still renders the expired-quote action area.`);
  }
}

async function resumeActiveBookingAndPay(miniProgram, scenarioName, manifest) {
  const definition = scenarioDefinitions[scenarioName];
  const expectedMediaCount = definition.expectedMediaKinds.length;
  const home = await ensureScenarioVehicle(miniProgram, scenarioName, manifest);
  const activeBooking = await home.data('activeBooking');
  if (!activeBooking) return null;
  if (!resumeActive) {
    throw new Error(`The ${scenarioName} fixture vehicle already has an active annual-inspection order. Set WECHAT_QA_RESUME_ACTIVE=1 to resume it through the rendered order page, or reload the isolated fixture schema.`);
  }
  if (activeBooking.serviceMode !== definition.serviceMode) {
    throw new Error(`The active ${scenarioName} fixture order has service mode ${activeBooking.serviceMode}; expected ${definition.serviceMode}.`);
  }

  const detail = await relaunchPage(
    miniProgram,
    ORDER_DETAIL_ROUTE,
    `id=${encodeURIComponent(activeBooking.id)}`,
    `resumable ${scenarioName} order detail`,
  );
  await waitForPageData(detail, 'loading', (value) => value === false, `Waiting for resumable ${scenarioName} order detail`);
  const loadError = await detail.data('loadError');
  if (loadError) throw new Error(`The resumable ${scenarioName} order detail failed to load: ${loadError}`);
  let bookingRecord = await waitForPageData(detail, 'booking', Boolean, `Waiting for resumable ${scenarioName} order`);
  if (!bookingRecord.quoteSnapshotId || Number(bookingRecord.serviceFeeFen) <= 0) {
    throw new Error(`The resumable ${scenarioName} order is missing its non-zero frozen quote.`);
  }
  if (!Array.isArray(bookingRecord.media) || bookingRecord.media.length !== expectedMediaCount) {
    throw new Error(`The resumable ${scenarioName} order contains ${Array.isArray(bookingRecord.media) ? bookingRecord.media.length : 0} booking images; expected ${expectedMediaCount}.`);
  }

  if (bookingRecord.status === 'pending_payment' && bookingRecord.paymentStatus === 'unpaid') {
    await capture(miniProgram, scenarioName, '06-order-pending-payment-resumed');
    if (await detail.data('quoteExpired')) {
      const previousQuoteSnapshotId = bookingRecord.quoteSnapshotId;
      const requoteButton = await waitForElement(detail, '.quote-expired-actions button', 'expired-order requote button');
      await requoteButton.tap();
      await waitForPageData(detail, 'requoting', (value) => value === false, `Waiting for resumed ${scenarioName} requote`);
      bookingRecord = await waitForPageData(
        detail,
        'booking',
        (value) => value && value.quoteSnapshotId && value.quoteSnapshotId !== previousQuoteSnapshotId,
        `Waiting for resumed ${scenarioName} quote snapshot refresh`,
      );
      await waitForPageData(detail, 'quoteExpired', (value) => value === false, `Waiting for resumed ${scenarioName} quote validity`);
      console.log(`[${scenarioName}] refreshed the expired quote through the rendered order page`);
    }
    const payButton = await waitForElement(detail, '.pay-button', 'resumed mock payment button');
    await payButton.tap();
    bookingRecord = await waitForPageData(
      detail,
      'booking',
      (value) => value && value.status === 'pending_precheck' && value.paymentStatus === 'paid',
      `Waiting for resumed ${scenarioName} mock payment to enter pending precheck`,
    );
  } else {
    const resumablePaidStatuses = definition.serviceMode === 'self_drive'
      ? ['pending_precheck', 'awaiting_arrival', 'checked_in', 'inspecting', 'result_received']
      : ['pending_precheck', 'confirmed'];
    if (bookingRecord.paymentStatus !== 'paid' || !resumablePaidStatuses.includes(bookingRecord.status)) {
      throw new Error(`The active ${scenarioName} order cannot be safely resumed at status ${bookingRecord.status}/${bookingRecord.paymentStatus}.`);
    }
  }

  if (Number(bookingRecord.paidFen) !== Number(bookingRecord.serviceFeeFen) || Number(bookingRecord.paidFen) <= 0) {
    throw new Error(`The resumed ${scenarioName} mock payment ledger does not match the frozen non-zero amount.`);
  }
  const hasPendingPrecheckPaymentEvent = Boolean(pendingPrecheckPaymentEvent(bookingRecord));
  if (!hasPendingPrecheckPaymentEvent && !allowLegacyActiveResume) {
    throw new Error(`The resumed ${scenarioName} order timeline does not contain the paid-to-pending_precheck transition.`);
  }
  if (bookingRecord.status === 'pending_precheck') {
    assertPaidPendingPrecheck(bookingRecord, scenarioName);
  } else if ((!bookingRecord.precheck || bookingRecord.precheck.status !== 'approved') && !allowLegacyActiveResume) {
    throw new Error(`The resumed ${scenarioName} order advanced past precheck without an approved precheck record.`);
  }
  await assertPaidOrderHidesRequote(detail, scenarioName);
  const resumedPaymentStep = bookingRecord.status === 'pending_precheck'
    ? '07-order-paid-pending-precheck-resumed'
    : `07-order-paid-${bookingRecord.status}-resumed`;
  await capture(miniProgram, scenarioName, resumedPaymentStep);
  console.log(`[${scenarioName}] resumed the existing order at ${bookingRecord.status} through its rendered detail`);
  return {
    scenario: scenarioName,
    bookingId: bookingRecord.id,
    bookingNumber: bookingRecord.bookingNumber,
    serviceMode: bookingRecord.serviceMode,
    status: bookingRecord.status,
    paymentStatus: bookingRecord.paymentStatus,
    amountFen: Number(bookingRecord.serviceFeeFen),
    paidFen: Number(bookingRecord.paidFen),
    bookingPhotoCount: bookingRecord.media.length,
    quoteSnapshotPresent: Boolean(bookingRecord.quoteSnapshotId),
    pendingPrecheckEventPresent: hasPendingPrecheckPaymentEvent,
    legacyPrecheckBypass: !hasPendingPrecheckPaymentEvent || !bookingRecord.precheck,
    resumedFromActiveOrder: true,
  };
}

function assertClosureCredentials() {
  const missing = [];
  if (!adminLogin) missing.push('WECHAT_QA_ADMIN_LOGIN');
  if (!adminPassword) missing.push('WECHAT_QA_ADMIN_PASSWORD');
  if (!operatorLogin) missing.push('WECHAT_QA_OPERATOR_LOGIN');
  if (!operatorPassword) missing.push('WECHAT_QA_OPERATOR_PASSWORD');
  if (!operatorStationId) missing.push('WECHAT_QA_OPERATOR_STATION_ID');
  if (missing.length) {
    throw new Error(`Full closure needs isolated local QA credentials in environment variables: ${missing.join(', ')}. Use WECHAT_QA_BOOKING_ONLY=1 to run only owner booking and payment.`);
  }
  if (driverName.length < 2 || !/^1\d{10}$/u.test(driverPhone)) {
    throw new Error('WECHAT_QA_DRIVER_NAME and WECHAT_QA_DRIVER_PHONE must form a valid synthetic driver assignment.');
  }
}

function hydratePreparedRootFromIgnoredResult() {
  if (preparedRootFromEnvironment) return;
  const resultPath = path.join(runtimeRoot, 'result.local.json');
  if (!fs.existsSync(resultPath)) return;
  const result = readJson(resultPath, 'Local annual-inspection result');
  const uploadRoot = String(result?.runtime?.uploadRoot || '').trim();
  if (!uploadRoot) return;
  const candidate = path.resolve(path.dirname(uploadRoot), 'prepared');
  const relative = path.relative(runtimeRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(candidate)) {
    throw new Error('The ignored result file points to an invalid prepared-media directory.');
  }
  preparedRoot = candidate;
}

function hydrateClosureCredentialsFromIgnoredResult() {
  if (adminLogin && adminPassword && operatorLogin && operatorPassword) return;
  const resultPath = path.join(runtimeRoot, 'result.local.json');
  if (!fs.existsSync(resultPath)) return;
  const result = readJson(resultPath, 'Local annual-inspection result');
  const credentials = result && result.credentials;
  adminLogin ||= String(credentials?.platformAdmin?.loginName || '').trim();
  adminPassword ||= String(credentials?.platformAdmin?.password || '');
  operatorLogin ||= String(credentials?.stationAdmin?.loginName || '').trim();
  operatorPassword ||= String(credentials?.stationAdmin?.password || '');
  operatorStationId ||= String(credentials?.stationAdmin?.stationId || '').trim();
}

async function openAdminBookingDrawer(page, bookingId) {
  const bookingUrl = `${adminOrigin}/bookings?booking=${encodeURIComponent(bookingId)}`;
  await page.goto(bookingUrl, { waitUntil: 'domcontentloaded' });
  const loginField = page.getByLabel('后台登录名');
  const drawer = page.getByLabel('预约与账务详情');
  await page.locator('[aria-label="后台登录名"], [aria-label="预约与账务详情"]').first().waitFor({
    state: 'visible',
    timeout: defaultTimeoutMs,
  });
  if (await loginField.isVisible()) {
    await loginField.fill(adminLogin);
    await page.getByLabel('后台登录密码').fill(adminPassword);
    await page.getByRole('button', { name: '安全登录' }).click();
    await page.waitForURL((url) => url.pathname !== '/login', { timeout: defaultTimeoutMs });
    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded' });
  }
  await drawer.waitFor({ state: 'visible', timeout: defaultTimeoutMs });
  return drawer;
}

async function assignDriverInAdmin(bookingId, scenarioName) {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const drawer = await openAdminBookingDrawer(page, bookingId);
    const assignment = drawer.getByLabel('代驾司机安排');
    await assignment.waitFor({ state: 'visible', timeout: defaultTimeoutMs });
    await assignment.getByLabel('司机姓名').fill(driverName);
    await assignment.getByLabel('司机手机号').fill(driverPhone);
    await assignment.getByRole('button', { name: /安排司机并生成验证码|重新生成验证码/u }).click();
    const codePanel = assignment.getByLabel('司机任务验证码', { exact: true });
    await codePanel.waitFor({ state: 'visible', timeout: defaultTimeoutMs });
    const codeText = await codePanel.textContent();
    const verificationCode = String(codeText || '').replace(/\D/gu, '').slice(0, 6);
    if (!/^\d{6}$/u.test(verificationCode)) throw new Error('The admin UI did not render a six-digit driver verification code.');
    // The one-time task code is intentionally never persisted in QA screenshots.
    // The runner only keeps it in memory long enough to bind the driver task.
    return verificationCode;
  } finally {
    await browser.close();
  }
}

let operatorAuthenticated = false;

async function loginOperatorForPage(miniProgram, bookingId, route, label) {
  const redirect = `/${route}?id=${encodeURIComponent(bookingId)}`;
  await miniProgram.callWxMethod('reLaunch', {
    url: `/packages/operator/pages/operator-login/operator-login?redirect=${encodeURIComponent(redirect)}`,
  });
  await delay(1_000);
  const login = await currentPage(miniProgram, OPERATOR_LOGIN_ROUTE, 'inspection-station login');
  await waitForPageData(login, 'checking', (value) => value === false, 'Waiting for inspection-station session check');
  if (await login.data('signedInName')) {
    const change = await waitForElement(login, '.secondary', 'switch inspection-station account');
    await change.tap();
    await waitForPageData(login, 'signedInName', (value) => value === '', 'Waiting for inspection-station sign-out');
  }
  const inputs = await login.$$('input');
  if (inputs.length < 2) throw new Error('Inspection-station login fields were not rendered.');
  await inputs[0].input(operatorLogin);
  await inputs[1].input(operatorPassword);
  const submit = await waitForElement(login, '.primary', 'inspection-station login button');
  await submit.tap();
  const target = await currentPage(miniProgram, route, `${label} after login`);
  await waitForPageData(target, 'loading', (value) => value === false, `Waiting for ${label} after login`);
  const loadError = await target.data('loadError');
  if (loadError) throw new Error(`${label} failed after login: ${loadError}`);
  operatorAuthenticated = true;
  return target;
}

async function openOperatorPage(miniProgram, bookingId, route, label) {
  if (!operatorAuthenticated) return loginOperatorForPage(miniProgram, bookingId, route, label);
  await miniProgram.callWxMethod('reLaunch', {
    url: `/${route}?id=${encodeURIComponent(bookingId)}`,
  });
  await delay(1_000);
  const page = await miniProgram.currentPage();
  if (page && page.path === OPERATOR_LOGIN_ROUTE) {
    operatorAuthenticated = false;
    return loginOperatorForPage(miniProgram, bookingId, route, label);
  }
  const target = await currentPage(miniProgram, route, label);
  await waitForPageData(target, 'loading', (value) => value === false, `Waiting for ${label}`);
  const loadError = await target.data('loadError');
  if (loadError) throw new Error(`${label} failed: ${loadError}`);
  return target;
}

async function openOperatorPrecheck(miniProgram, bookingId) {
  return openOperatorPage(miniProgram, bookingId, OPERATOR_PRECHECK_ROUTE, 'inspection-station precheck detail');
}

async function openOperatorDetail(miniProgram, bookingId) {
  return openOperatorPage(miniProgram, bookingId, OPERATOR_DETAIL_ROUTE, 'inspection-station order detail');
}

function approvedPrecheckStatus(scenarioName) {
  return scenarioName === 'self-drive' ? 'awaiting_arrival' : 'confirmed';
}

function assertApprovedPrecheck(booking, scenarioName) {
  const expectedStatus = approvedPrecheckStatus(scenarioName);
  if (!booking || booking.paymentStatus !== 'paid') {
    throw new Error(`The ${scenarioName} precheck approval did not retain the paid order.`);
  }
  if (!booking.precheck || booking.precheck.status !== 'approved') {
    throw new Error(`The ${scenarioName} order does not contain an approved station precheck.`);
  }
  const approvalEvent = Array.isArray(booking.events)
    ? booking.events.find((event) => event && event.status === expectedStatus && event.title === '检测站预审通过' && event.actorType === 'operator')
    : null;
  if (!approvalEvent) {
    throw new Error(`The ${scenarioName} order timeline does not contain the operator precheck approval -> ${expectedStatus} transition.`);
  }
  if (scenarioName === 'self-drive' && booking.events.some((event) => event && event.title === '等待车辆到站')) {
    throw new Error('The self-drive order contains a duplicate station accept event after precheck approval.');
  }
}

async function approveOrVerifyOperatorPrecheck(miniProgram, bookingResult, scenarioName) {
  const expectedStatus = approvedPrecheckStatus(scenarioName);
  const alreadyApprovedStatuses = scenarioName === 'self-drive'
    ? ['awaiting_arrival', 'checked_in', 'inspecting', 'result_received']
    : ['confirmed'];
  const needsApproval = bookingResult.status === 'pending_precheck';
  if (!needsApproval && !alreadyApprovedStatuses.includes(bookingResult.status)) {
    throw new Error(`The ${scenarioName} closure cannot enter precheck from status ${bookingResult.status}.`);
  }

  if (needsApproval) {
    const precheck = await openOperatorPrecheck(miniProgram, bookingResult.bookingId);
    const expectedMediaCount = scenarioDefinitions[scenarioName].expectedMediaKinds.length;
    const pending = await waitForPageData(
      precheck,
      'booking',
      (value) => value && value.status === 'pending_precheck' && value.paymentStatus === 'paid' && value.precheck?.status === 'pending',
      `Waiting for ${scenarioName} pending station precheck`,
    );
    if (!Array.isArray(pending.media) || pending.media.length !== expectedMediaCount) {
      throw new Error(`The ${scenarioName} station precheck exposes ${Array.isArray(pending.media) ? pending.media.length : 0}/${expectedMediaCount} booking photos.`);
    }
    const renderedPhotos = await precheck.data('photos');
    if (!Array.isArray(renderedPhotos) || renderedPhotos.length !== expectedMediaCount || renderedPhotos.some((photo) => !photo || !photo.url)) {
      throw new Error(`The ${scenarioName} station precheck did not render ${expectedMediaCount}/${expectedMediaCount} reviewable booking photos.`);
    }
    await capture(miniProgram, scenarioName, '08-station-precheck-pending');
    const approve = await waitForElement(precheck, '.action-bar .approve', `${scenarioName} precheck approval button`);
    const approveDisabled = await approve.attribute('disabled');
    if (approveDisabled === true || approveDisabled === 'true') {
      throw new Error(`The ${scenarioName} precheck approval button is disabled with all required photos present.`);
    }
    await approve.tap();
    // 微信开发者工具在页面较重时，原生确认框可能晚于按钮点击数百毫秒出现。
    // 预检详情是通过 reLaunch/redirectTo 打开的根页面，审批成功后的
    // navigateBack 没有可返回页面，因此不能用“路径离开详情页”判断成功。
    // 后续订单详情中的状态、预检版本和业务事件才是唯一成功判据。
    await delay(750);
    await miniProgram.native().confirmModal();
    await delay(1_000);
  }

  const detail = await openOperatorDetail(miniProgram, bookingResult.bookingId);
  const currentExpectedStatus = needsApproval ? expectedStatus : bookingResult.status;
  const approved = await waitForPageData(
    detail,
    'booking',
    (value) => value && value.status === currentExpectedStatus && value.precheck?.status === 'approved',
    `Waiting for ${scenarioName} approved precheck at ${currentExpectedStatus}`,
  );
  assertApprovedPrecheck(approved, scenarioName);
  const resumeSuffix = needsApproval ? '' : '-resumed';
  await capture(miniProgram, scenarioName, `09-station-precheck-approved-${approved.status}${resumeSuffix}`);
  return approved;
}

async function tapOperatorAction(detail, action, expectedStatus, scenarioName) {
  const button = await waitForElement(detail, `[data-action="${action}"]`, `${scenarioName} station ${action} action`);
  await button.tap();
  return waitForPageData(
    detail,
    'booking',
    (value) => value && value.status === expectedStatus,
    `Waiting for ${scenarioName} station action ${action} -> ${expectedStatus}`,
  );
}

async function continueSelfDriveClosure(miniProgram, bookingId, scenarioName) {
  let detail = await openOperatorDetail(miniProgram, bookingId);
  let booking = await waitForPageData(detail, 'booking', Boolean, 'Waiting for resumable self-drive station booking');
  if (booking.status === 'confirmed') {
    throw new Error('Self-drive precheck approval must enter awaiting_arrival without a second station accept action.');
  }
  if (booking.status === 'awaiting_arrival') booking = await tapOperatorAction(detail, 'check-in', 'checked_in', scenarioName);
  if (booking.status === 'checked_in') {
    booking = await tapOperatorAction(detail, 'handoff', 'inspecting', scenarioName);
    await capture(miniProgram, scenarioName, '10-station-inspecting');
  }
  if (booking.status === 'inspecting') {
    const published = await publishInspectionCheckup(miniProgram, detail, bookingId, scenarioName);
    detail = published.detail;
    booking = published.published;
  }
  if (booking.status === 'result_received') {
    booking = await finishSelfDriveAtStation(miniProgram, detail, scenarioName);
  } else if (booking.status === 'completed') {
    await capture(miniProgram, scenarioName, '15-station-service-completed-atomically');
  }
  if (booking.status !== 'completed') {
    throw new Error(`Self-drive closure cannot resume from station status ${booking.status}.`);
  }
}

async function uploadStationArrivalEvidence(miniProgram, bookingId, scenarioName) {
  const detail = await openOperatorDetail(miniProgram, bookingId);
  const initial = await waitForPageData(detail, 'booking', Boolean, 'Waiting for valet station-arrival booking');
  if (initial.status !== 'picked_up') throw new Error(`Valet station arrival expected picked_up, got ${initial.status}.`);
  const retained = [];
  try {
    for (const kind of siteKinds) {
      await useFixtureForNextChooseMedia(miniProgram, resolveSiteAsset(scenarioName, kind));
      const button = await elementByAttribute(detail, '.arrival-evidence-card button[data-kind]', 'data-kind', kind, `${scenarioName} station-arrival ${kind}`);
      await button.tap();
      const evidence = await waitForPageData(
        detail,
        'arrivalEvidence',
        (value) => value && value.slots.some((slot) => slot.kind === kind && slot.photo) && !value.completed,
        `Waiting for ${scenarioName} station-arrival ${kind} upload`,
        uploadTimeoutMs,
      );
      retained.push(kind);
      for (const previous of retained) {
        if (!evidence.slots.some((slot) => slot.kind === previous && slot.photo)) {
          throw new Error(`Station-arrival cumulative upload regression: ${previous} disappeared after ${kind}.`);
        }
      }
    }
  } finally {
    await miniProgram.restoreWxMethod('chooseMedia').catch(() => undefined);
  }
  const submit = await waitForElement(detail, '.arrival-evidence-submit', 'submit station-arrival evidence');
  await submit.tap();
  const checkedIn = await waitForPageData(
    detail,
    'booking',
    (value) => value && value.status === 'checked_in',
    'Waiting for valet station-arrival evidence to advance to checked_in',
  );
  const evidence = (checkedIn.evidencePackages || []).find((item) => item.stage === 'station_arrival');
  if (!evidence || evidence.status !== 'completed' || evidence.photos.length !== 5) {
    throw new Error('Valet station-arrival evidence did not atomically save a completed 5-photo package.');
  }
  await tapOperatorAction(detail, 'handoff', 'inspecting', scenarioName);
  await capture(miniProgram, scenarioName, '12-station-arrival-and-inspecting');
  return detail;
}

async function publishInspectionCheckup(miniProgram, operatorDetail, bookingId, scenarioName) {
  const expectedConclusion = scenarioName === 'self-drive' ? 'failed' : 'passed';
  const editorButton = await waitForElement(operatorDetail, '.primary-action', 'open vehicle checkup editor');
  await editorButton.tap();
  const editor = await currentPage(miniProgram, CHECKUP_EDITOR_ROUTE, 'vehicle checkup editor');
  await waitForPageData(editor, 'loading', (value) => value === false, 'Waiting for vehicle checkup editor');
  const loadError = await editor.data('loadError');
  if (loadError) throw new Error(`Vehicle checkup editor failed: ${loadError}`);

  const retained = [];
  try {
    for (const kind of siteKinds) {
      await useFixtureForNextChooseMedia(miniProgram, resolveSiteAsset(scenarioName, kind));
      const button = await elementByAttribute(editor, '.photo-empty', 'data-kind', kind, `${scenarioName} checkup ${kind}`);
      await button.tap();
      const slots = await waitForPageData(
        editor,
        'photoSlots',
        (value) => Array.isArray(value) && value.some((slot) => slot.kind === kind && slot.media) && Number(value.filter((slot) => slot.uploading).length) === 0,
        `Waiting for ${scenarioName} checkup ${kind} upload`,
        uploadTimeoutMs,
      );
      retained.push(kind);
      for (const previous of retained) {
        if (!slots.some((slot) => slot.kind === previous && slot.media)) {
          throw new Error(`Checkup cumulative upload regression: ${previous} disappeared after ${kind}.`);
        }
      }
    }

    if (scenarioName === 'valet') {
      const faultsRecorded = await elementByAttribute(editor, '.observation-options button', 'data-value', 'faults_recorded', 'faults-recorded observation');
      await faultsRecorded.tap();
      await waitForPageData(editor, 'observationMode', (value) => value === 'faults_recorded', 'Waiting for faults-recorded observation');

      const rightView = await elementByAttribute(editor, '.view-tabs button', 'data-id', 'right', 'right-side diagnostic view');
      await rightView.tap();
      await waitForPageData(editor, 'activeView', (value) => value === 'right', 'Waiting for right-side diagnostic view');

      const region = await elementByAttribute(editor, '.region-hotspot', 'data-code', 'right_rear_quarter', 'right-rear-quarter diagnostic region');
      await region.tap();
      await waitForPageData(editor, 'faultEditorOpen', (value) => value === true, 'Waiting for vehicle-fault editor');

      const scratch = await elementByAttribute(editor, '.fault-types button', 'data-value', 'scratch', 'scratch fault type');
      const minor = await elementByAttribute(editor, '.severity-types button', 'data-value', 'minor', 'minor fault severity');
      await scratch.tap();
      await minor.tap();
      const faultDescription = await waitForElement(editor, '.fault-description textarea', 'vehicle-fault description');
      await faultDescription.input('右后翼子板可见轻微剐蹭，约 8cm，未见结构性变形；年检结论与该车身记录相互独立。');
      await capture(miniProgram, scenarioName, '13a-fault-editor-layout');

      await useFixtureForNextChooseMedia(miniProgram, resolveSiteAsset(scenarioName, 'rear_right'));
      await useAlbumForNextActionSheet(miniProgram);
      try {
        const createActions = await editor.$$('.new-fault-actions button');
        if (createActions.length < 2) throw new Error('The save-and-photo vehicle-fault action was not rendered.');
        await createActions[1].tap();
        await waitForPageData(
          editor,
          'faults',
          (value) => Array.isArray(value)
            && value.length === 1
            && value[0].regionCode === 'right_rear_quarter'
            && Array.isArray(value[0].photos)
            && value[0].photos.length >= 1,
          'Waiting for the right-rear-quarter fault and close-up photo',
          uploadTimeoutMs,
        );
        await waitForPageData(editor, 'faultPhotoBusyCount', (value) => Number(value) === 0, 'Waiting for the vehicle-fault photo upload to settle', uploadTimeoutMs);
      } finally {
        await miniProgram.restoreWxMethod('showActionSheet').catch(() => undefined);
      }
      const closeFaultEditor = await waitForElement(editor, '.sheet-head button', 'close vehicle-fault editor');
      await closeFaultEditor.tap();
      await waitForPageData(editor, 'faultEditorOpen', (value) => value === false, 'Waiting for vehicle-fault editor to close');
      await capture(miniProgram, scenarioName, '13a-fault-recorded-with-photo');
    } else {
      const noFault = await elementByAttribute(editor, '.observation-options button', 'data-value', 'no_visible_faults', 'no-visible-faults observation');
      await noFault.tap();
    }
    const conclusion = await elementByAttribute(
      editor,
      '.conclusion-options button',
      'data-value',
      expectedConclusion,
      `${expectedConclusion} annual-inspection conclusion`,
    );
    await conclusion.tap();
    await waitForPageData(editor, 'conclusion', (value) => value === expectedConclusion, `Waiting for ${expectedConclusion} conclusion`);

    if (expectedConclusion === 'failed') {
      const instrumentedTest = await elementByAttribute(
        editor,
        '.failure-category-options button',
        'data-value',
        'instrumented_test',
        'instrumented-test failure category',
      );
      await instrumentedTest.tap();
      await waitForPageData(
        editor,
        'failureCategories',
        (value) => Array.isArray(value) && value.includes('instrumented_test'),
        'Waiting for instrumented-test failure category',
      );
      const failureFields = await editor.$$('.failure-text-field textarea');
      if (failureFields.length < 2) throw new Error('Failed-result reason and retest-advice fields were not rendered.');
      await failureFields[0].input('制动力测试结果未达到检测线合格阈值，以本次机动车安全技术检验报告记录为准。');
      await failureFields[1].input('检查并维修制动系统，确认工作状态后携本次检验报告预约原项目复检。');
    }

    const safetyReport = resolveSafetyInspectionReport(scenarioName);
    await useFixtureForNextChooseMedia(miniProgram, safetyReport);
    const safetyReportButton = await elementByAttribute(editor, '.mark-empty', 'data-kind', 'safety_inspection_report', 'safety-inspection report upload');
    await safetyReportButton.tap();
    await waitForPageData(editor, 'safetyReportMedia', Boolean, 'Waiting for safety-inspection report upload', uploadTimeoutMs);

    if (expectedConclusion === 'passed') {
      const mark = resolveInspectionMark(scenarioName);
      await useFixtureForNextChooseMedia(miniProgram, mark);
      const markButton = await elementByAttribute(editor, '.mark-empty', 'data-kind', 'annual_inspection_mark', 'annual-inspection mark upload');
      await markButton.tap();
      await waitForPageData(editor, 'markMedia', Boolean, 'Waiting for annual-inspection mark upload', uploadTimeoutMs);
    } else if (await editor.data('markMedia')) {
      throw new Error('Failed annual-inspection result unexpectedly retained an inspection mark.');
    }
  } finally {
    await miniProgram.restoreWxMethod('chooseMedia').catch(() => undefined);
  }

  const summary = await waitForElement(editor, '.summary-field textarea', 'checkup result summary');
  await summary.input(expectedConclusion === 'passed'
    ? '现场检查与年检项目已完成，本次结论通过；车况记录与年检结论相互独立。'
    : '现场检查与年检项目已完成，本次仪器设备检验未通过，请按检验报告整改后复检。');
  await capture(miniProgram, scenarioName, '13-checkup-ready-to-publish');
  const submit = await waitForElement(editor, '.submit-button', 'preview and publish checkup');
  await submit.tap();
  await waitForPageData(editor, 'previewOpen', (value) => value === true, 'Waiting for checkup publish preview');
  const previewActions = await editor.$$('.preview-actions button');
  if (previewActions.length < 2) throw new Error('Checkup publish confirmation was not rendered.');
  await previewActions[1].tap();

  const detail = await currentPage(miniProgram, OPERATOR_DETAIL_ROUTE, 'station detail after report publication');
  const published = await waitForPageData(
    detail,
    'booking',
    (value) => {
      if (!value || value.id !== bookingId || !['result_received', 'completed'].includes(value.status) || value.vehicleCheckupReport?.status !== 'published') return false;
      if (expectedConclusion !== 'failed') return true;
      const failure = value.vehicleCheckupReport.annualInspection?.failureDetails;
      return Boolean(failure?.itemCategories?.includes('instrumented_test') && failure.reason && failure.reinspectionAdvice);
    },
    `Waiting for ${scenarioName} checkup report publication`,
    uploadTimeoutMs,
  );
  const fixedPhotos = (published.vehicleCheckupReport.media || []).filter((item) => siteKinds.includes(item.kind));
  if (fixedPhotos.length !== 5) throw new Error(`Published ${scenarioName} report contains ${fixedPhotos.length}/5 fixed site photos.`);
  if (published.vehicleCheckupReport.annualInspection?.conclusion !== expectedConclusion) {
    throw new Error(`Published ${scenarioName} report conclusion is not ${expectedConclusion}.`);
  }
  if (expectedConclusion === 'passed' && !published.vehicleCheckupReport.annualInspection?.markPhoto) {
    throw new Error(`Published ${scenarioName} passed report is missing the independent inspection-mark photo.`);
  }
  if (expectedConclusion === 'failed' && published.vehicleCheckupReport.annualInspection?.markPhoto) {
    throw new Error(`Published ${scenarioName} failed report unexpectedly exposes an inspection mark.`);
  }
  if (expectedConclusion === 'failed') {
    const failure = published.vehicleCheckupReport.annualInspection?.failureDetails;
    if (!failure || !failure.itemCategories?.includes('instrumented_test') || !failure.reason || !failure.reinspectionAdvice) {
      throw new Error(`Published ${scenarioName} failed report is missing structured failure details.`);
    }
  }
  if (expectedConclusion === 'passed' && published.vehicleCheckupReport.legalMaterials?.status !== 'available') {
    throw new Error(`Published ${scenarioName} report does not mark required legal materials as complete.`);
  }
  await capture(miniProgram, scenarioName, '14-report-published');
  return { detail, published };
}

async function enterDriverTaskWithCode(miniProgram, verificationCode, bookingId) {
  const login = await relaunchPage(miniProgram, DRIVER_LOGIN_ROUTE, '', 'driver verification-code login');
  await waitForPageData(login, 'checkingSession', (value) => value === false, 'Waiting for cached driver task check');
  if (await login.data('cachedTask')) {
    const switchTask = await waitForElement(login, '.secondary-action', 'switch driver task');
    await switchTask.tap();
    await waitForPageData(login, 'cachedTask', (value) => value === null, 'Waiting for driver task switch');
  }
  const codeInput = await waitForElement(login, '.code-native', 'driver verification code');
  await codeInput.input(verificationCode);
  await waitForPageData(login, 'codeReady', (value) => value === true, 'Waiting for six-digit driver code');
  const submit = await waitForElement(login, '.primary-action', 'enter driver task');
  await submit.tap();
  const taskPage = await currentPage(miniProgram, DRIVER_TASK_ROUTE, 'driver task');
  await waitForPageData(taskPage, 'loading', (value) => value === false, 'Waiting for driver task');
  const error = await taskPage.data('error');
  const task = await taskPage.data('task');
  if (error || !task || task.bookingId !== bookingId) {
    throw new Error(`Driver task exchange failed${error ? `: ${error}` : '.'}`);
  }
  return taskPage;
}

async function uploadDriverStage(miniProgram, taskPage, scenarioName, stage, expectedStatus, screenshotStep) {
  await waitForPageData(taskPage, 'activeStage', (value) => value === stage, `Waiting for driver ${stage} stage`);
  const retained = [];
  try {
    for (const kind of siteKinds) {
      await useFixtureForNextChooseMedia(miniProgram, resolveSiteAsset(scenarioName, kind));
      const button = await elementByAttribute(taskPage, '.photo-empty', 'data-kind', kind, `${scenarioName} driver ${stage} ${kind}`);
      await button.tap();
      const slots = await waitForPageData(
        taskPage,
        'photoSlots',
        (value) => Array.isArray(value) && value.some((slot) => slot.kind === kind && slot.media && !slot.uploading),
        `Waiting for ${scenarioName} driver ${stage} ${kind} upload`,
        uploadTimeoutMs,
      );
      retained.push(kind);
      for (const previous of retained) {
        if (!slots.some((slot) => slot.kind === previous && slot.media)) {
          throw new Error(`Driver ${stage} cumulative upload regression: ${previous} disappeared after ${kind}.`);
        }
      }
    }
  } finally {
    await miniProgram.restoreWxMethod('chooseMedia').catch(() => undefined);
  }
  await waitForPageData(taskPage, 'canCompleteEvidence', (value) => value === true, `Waiting for complete ${stage} evidence action`);
  await capture(miniProgram, scenarioName, `${screenshotStep}-five-photos-ready`);
  const complete = await waitForElement(taskPage, '.capture-card .primary-action', `complete driver ${stage} evidence`);
  await complete.tap();
  const task = await waitForPageData(
    taskPage,
    'task',
    (value) => value && (value.fulfillmentStatus || value.status) === expectedStatus,
    `Waiting for driver ${stage} -> ${expectedStatus}`,
  );
  const evidence = (task.evidencePackages || []).find((item) => item.stage === stage);
  if (!evidence || evidence.status !== 'completed' || evidence.photos.length !== 5) {
    throw new Error(`Driver ${stage} did not atomically save a completed 5-photo evidence package.`);
  }
  await capture(miniProgram, scenarioName, `${screenshotStep}-submitted`);
  return task;
}

async function runDriverPickup(miniProgram, verificationCode, bookingId, scenarioName) {
  const taskPage = await enterDriverTaskWithCode(miniProgram, verificationCode, bookingId);
  const task = await taskPage.data('task');
  if ((task.fulfillmentStatus || task.status) !== 'driver_arranged') {
    throw new Error(`Driver pickup expected driver_arranged, got ${task.fulfillmentStatus || task.status}.`);
  }
  return uploadDriverStage(miniProgram, taskPage, scenarioName, 'owner_pickup', 'picked_up', '10-driver-pickup');
}

async function runDriverReturn(miniProgram, bookingId, scenarioName) {
  const taskPage = await relaunchPage(
    miniProgram,
    DRIVER_TASK_ROUTE,
    `bookingId=${encodeURIComponent(bookingId)}`,
    'driver task for return',
  );
  await waitForPageData(taskPage, 'loading', (value) => value === false, 'Waiting for driver return task');
  const resultReady = await waitForPageData(
    taskPage,
    'task',
    (value) => value && (value.fulfillmentStatus || value.status) === 'result_received',
    'Waiting for published report in driver task',
  );
  const inspectionEvidence = (resultReady.evidencePackages || []).find((item) => item.stage === 'inspection_complete');
  if (!inspectionEvidence || inspectionEvidence.status !== 'completed' || inspectionEvidence.photos.length !== 5) {
    throw new Error('Published report did not produce a completed 5-photo inspection_complete evidence package.');
  }
  await waitForPageData(taskPage, 'canStartReturn', (value) => value === true, 'Waiting for driver start-return permission');
  const startReturn = await waitForElement(taskPage, '.return-action-card button', 'start vehicle return');
  await startReturn.tap();
  await waitForPageData(taskPage, 'activeStage', (value) => value === 'owner_return', 'Waiting for owner-return evidence stage');
  return uploadDriverStage(miniProgram, taskPage, scenarioName, 'owner_return', 'completed', '15-driver-return');
}

async function finishSelfDriveAtStation(miniProgram, detail, scenarioName) {
  const completed = await tapOperatorAction(detail, 'complete', 'completed', scenarioName);
  await capture(miniProgram, scenarioName, '15-station-service-completed');
  return completed;
}

async function verifyOwnerOrderAndReport(miniProgram, bookingId, scenarioName) {
  const expectedConclusion = scenarioName === 'self-drive' ? 'failed' : 'passed';
  const detail = await relaunchPage(
    miniProgram,
    ORDER_DETAIL_ROUTE,
    `id=${encodeURIComponent(bookingId)}`,
    'owner completed annual-inspection order',
  );
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for owner completed order');
  const booking = await waitForPageData(
    detail,
    'booking',
    (value) => value && value.id === bookingId && value.status === 'completed' && value.vehicleCheckupReport?.status === 'published',
    `Waiting for ${scenarioName} owner report and completed status`,
    uploadTimeoutMs,
  );
  if (booking.inspectionResult?.conclusion !== expectedConclusion) {
    throw new Error(`Owner ${scenarioName} order does not show the expected ${expectedConclusion} inspection conclusion.`);
  }
  if (booking.vehicleCheckupReport?.annualInspection?.conclusion !== expectedConclusion) {
    throw new Error(`Owner ${scenarioName} report does not show the expected ${expectedConclusion} conclusion.`);
  }

  let evidenceSummary = [];
  if (scenarioName === 'valet') {
    const expectedStages = ['owner_pickup', 'station_arrival', 'inspection_complete', 'owner_return'];
    evidenceSummary = expectedStages.map((stage) => {
      const evidence = (booking.evidencePackages || []).find((item) => item.stage === stage);
      if (!evidence || evidence.status !== 'completed' || evidence.photos.length !== 5) {
        throw new Error(`Owner valet order has incomplete ${stage} evidence.`);
      }
      return { stage, photoCount: evidence.photos.length, status: evidence.status };
    });
    await waitForPageData(
      detail,
      'evidenceStages',
      (value) => Array.isArray(value) && value.length === 4 && value.every((stage) => stage.status === 'completed' && stage.photos.length === 5 && stage.photos.every((photo) => photo.loadState === 'ready')),
      'Waiting for owner-authenticated valet evidence thumbnails',
      uploadTimeoutMs,
    );
    const evidencePhoto = await waitForElement(detail, '.evidence-photo-button', 'owner evidence photo');
    await evidencePhoto.tap();
    await waitForPageData(detail, 'viewerOpen', (value) => value === true, 'Waiting for in-page owner evidence viewer');
    await capture(miniProgram, scenarioName, '16-owner-evidence-modal');
    const closeViewer = await detail.$('.evidence-image-viewer-head button');
    if (closeViewer) await closeViewer.tap();
  } else {
    await capture(miniProgram, scenarioName, '16-owner-order-completed');
  }

  const reportEntry = await waitForElement(detail, '.checkup-report-entry', 'owner vehicle checkup report entry');
  await reportEntry.tap();
  const reportPage = await currentPage(miniProgram, CHECKUP_REPORT_ROUTE, 'owner vehicle checkup report');
  await waitForPageData(reportPage, 'loading', (value) => value === false, 'Waiting for owner vehicle checkup report');
  const report = await waitForPageData(
    reportPage,
    'report',
    (value) => {
      if (!value || value.status !== 'published' || value.annualInspection?.conclusion !== expectedConclusion) return false;
      if (expectedConclusion !== 'failed') return true;
      const failure = value.annualInspection?.failureDetails;
      return Boolean(failure?.itemCategories?.includes('instrumented_test') && failure.reason && failure.reinspectionAdvice);
    },
    `Waiting for ${scenarioName} published owner report`,
  );
  const sitePhotos = (report.media || []).filter((item) => siteKinds.includes(item.kind));
  if (sitePhotos.length !== 5) throw new Error(`Owner ${scenarioName} report exposes ${sitePhotos.length}/5 site photos.`);
  if (expectedConclusion === 'passed' && !report.annualInspection?.markPhoto) {
    throw new Error(`Owner ${scenarioName} passed report does not expose the inspection-mark material.`);
  }
  if (expectedConclusion === 'failed' && report.annualInspection?.markPhoto) {
    throw new Error(`Owner ${scenarioName} failed report unexpectedly exposes an inspection mark.`);
  }
  if (expectedConclusion === 'failed') {
    const failure = report.annualInspection?.failureDetails;
    if (!failure || !failure.itemCategories?.includes('instrumented_test') || !failure.reason || !failure.reinspectionAdvice) {
      throw new Error(`Owner ${scenarioName} failed report does not expose the structured reason and retest advice.`);
    }
  }
  if (expectedConclusion === 'passed' && report.legalMaterials?.status !== 'available') {
    throw new Error(`Owner ${scenarioName} report does not expose a complete required-material status.`);
  }
  const reportPhoto = await waitForElement(reportPage, '.report-photo', 'owner report photo');
  await reportPhoto.tap();
  await waitForPageData(reportPage, 'viewerOpen', (value) => value === true, 'Waiting for in-page report image viewer');
  await capture(miniProgram, scenarioName, '17-owner-report-modal');

  return {
    finalStatus: booking.status,
    conclusion: report.annualInspection.conclusion,
    reportStatus: report.status,
    reportPhotoCount: (report.media || []).length,
    fixedSitePhotoCount: sitePhotos.length,
    safetyInspectionReportPresent: Boolean(report.legalMaterials?.safetyInspectionReport),
    inspectionMarkPresent: Boolean(report.annualInspection?.markPhoto),
    evidence: evidenceSummary,
    ownerEvidenceModalVerified: scenarioName === 'valet',
    ownerReportModalVerified: true,
  };
}

async function verifyFinalOrderInAdmin(bookingId, scenarioName) {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const drawer = await openAdminBookingDrawer(page, bookingId);
    await drawer.getByText(/^(已完成|服务已完成)$/u).first().waitFor({ state: 'visible', timeout: defaultTimeoutMs });
    await drawer.getByText('车辆体检报告', { exact: true }).first().waitFor({ state: 'visible', timeout: defaultTimeoutMs });
    let screenshotTarget = drawer;
    if (scenarioName === 'valet') {
      const evidence = drawer.getByLabel('代驾履约留证');
      await evidence.getByText('4 / 4 阶段完整', { exact: true }).waitFor({ state: 'visible', timeout: defaultTimeoutMs });
      for (const stage of ['owner_pickup', 'station_arrival', 'inspection_complete', 'owner_return']) {
        await evidence.locator(`[data-evidence-stage="${stage}"]`).getByText('5 / 5', { exact: true }).waitFor({ state: 'visible', timeout: defaultTimeoutMs });
      }
      // Capture only the evidence module. A full drawer screenshot includes
      // contact details, pickup address and driver data that are irrelevant to
      // the proof and should not enter the final operation manual.
      screenshotTarget = evidence;
    }
    fs.mkdirSync(artifactsDir, { recursive: true });
    await screenshotTarget.screenshot({ path: path.join(artifactsDir, `${scenarioName}-18-admin-final-detail.png`) });
    return { finalDetailVisible: true, reportVisible: true, evidenceComplete: scenarioName === 'valet' };
  } finally {
    await browser.close();
  }
}

async function latestCompletedBookingId(miniProgram, scenarioName, manifest) {
  const expectedPlate = normalizePlate(scenarioManifest(manifest, scenarioName).plateNumber);
  const orders = await relaunchPage(miniProgram, 'pages/orders/orders', '', 'owner order list');
  await waitForPageData(orders, 'loading', (value) => value === false, 'Waiting for owner order list');
  const items = await orders.data('orders');
  const matched = Array.isArray(items)
    ? items.find((item) => item && item.status === '服务已完成' && normalizePlate(item.name).includes(expectedPlate))
    : null;
  if (!matched?.id) throw new Error(`No completed owner order was found for the ${scenarioName} local fixture vehicle.`);
  return matched.id;
}

async function verifyLatestCompletedScenario(miniProgram, scenarioName, manifest) {
  const bookingId = await latestCompletedBookingId(miniProgram, scenarioName, manifest);
  const owner = await verifyOwnerOrderAndReport(miniProgram, bookingId, scenarioName);
  const admin = await verifyFinalOrderInAdmin(bookingId, scenarioName);
  console.log(`[${scenarioName}] latest completed owner/report/admin views passed`);
  return { scenario: scenarioName, completedBookingVerified: true, closure: { owner, admin } };
}

async function runFullClosure(miniProgram, bookingResult, scenarioName) {
  const approvedPrecheck = bookingResult.legacyPrecheckBypass
    ? { status: bookingResult.status }
    : await approveOrVerifyOperatorPrecheck(miniProgram, bookingResult, scenarioName);
  if (scenarioName === 'self-drive') {
    await continueSelfDriveClosure(miniProgram, bookingResult.bookingId, scenarioName);
  } else {
    if (approvedPrecheck.status !== 'confirmed') {
      throw new Error(`Valet precheck approval expected confirmed before driver assignment, got ${approvedPrecheck.status}.`);
    }
    const verificationCode = await assignDriverInAdmin(bookingResult.bookingId, scenarioName);
    await runDriverPickup(miniProgram, verificationCode, bookingResult.bookingId, scenarioName);
    const stationDetail = await uploadStationArrivalEvidence(miniProgram, bookingResult.bookingId, scenarioName);
    await publishInspectionCheckup(miniProgram, stationDetail, bookingResult.bookingId, scenarioName);
    await runDriverReturn(miniProgram, bookingResult.bookingId, scenarioName);
  }
  const owner = await verifyOwnerOrderAndReport(miniProgram, bookingResult.bookingId, scenarioName);
  const admin = await verifyFinalOrderInAdmin(bookingResult.bookingId, scenarioName);
  return {
    ...bookingResult,
    postPrecheckStatus: approvedPrecheck.status,
    precheckApprovedEventPresent: !bookingResult.legacyPrecheckBypass,
    closure: { owner, admin },
  };
}

async function runScenario(miniProgram, scenarioName, manifest) {
  console.log(`[${scenarioName}] starting native click-through`);
  let bookingResult = await resumeActiveBookingAndPay(miniProgram, scenarioName, manifest);
  if (!bookingResult) {
    const booking = await enterBookingFlow(miniProgram, scenarioName, manifest);
    const uploadedCount = await uploadBookingMedia(miniProgram, booking, scenarioName);
    bookingResult = await submitAndPay(miniProgram, booking, scenarioName, uploadedCount);
  }
  if (!fullClosure) {
    console.log(`[${scenarioName}] booking passed: ${bookingResult.bookingPhotoCount} uploads, non-zero mock payment, pending precheck state`);
    return bookingResult;
  }
  const result = await runFullClosure(miniProgram, bookingResult, scenarioName);
  console.log(`[${scenarioName}] full closure passed: booking, payment, station/driver evidence, report, owner and admin views`);
  return result;
}

async function connectToDevtools() {
  if (automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return automator.launcher.connectTool({ wsEndpoint: endpoint });
  }
  return automator.connect({ wsEndpoint: endpoint });
}

async function writeRunSummary(payload) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const summaryPath = path.join(artifactsDir, 'run-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return summaryPath;
}

async function run() {
  const scenarios = selectedScenarios();
  const manifest = readJson(manifestPath, 'Local annual-inspection manifest');
  hydratePreparedRootFromIgnoredResult();
  validateLocalFixtures(manifest, scenarios);
  if (fullClosure) {
    hydrateClosureCredentialsFromIgnoredResult();
    assertClosureCredentials();
  }

  let miniProgram;
  let activeScenario = 'startup';
  const issues = [];
  const results = [];
  const startedAt = new Date().toISOString();

  try {
    miniProgram = await connectToDevtools();
    EventEmitter.prototype.on.call(miniProgram, 'console', (message) => {
      const type = String((message && message.type) || '').toLowerCase();
      if (type !== 'error' && type !== 'assert') return;
      const detail = Array.isArray(message.args) ? message.args.map((item) => String(item)).join(' ') : '';
      issues.push({ source: 'console', type, detail });
      console.error(`[mini-program console:${type}] ${detail}`);
    });
    EventEmitter.prototype.on.call(miniProgram, 'exception', (exception) => {
      const detail = String((exception && (exception.stack || exception.message)) || exception || 'Unknown mini-program exception');
      issues.push({ source: 'exception', type: 'exception', detail });
      console.error(`[mini-program exception] ${detail}`);
    });
    await waitUntil(() => miniProgram.currentPage(), 'Waiting for the WeChat simulator runtime');
    await waitUntil(() => miniProgram.send('App.enableLog'), 'Enabling mini-program console capture');

    for (const scenarioName of scenarios) {
      activeScenario = scenarioName;
      results.push(verifyCompletedOnly
        ? await verifyLatestCompletedScenario(miniProgram, scenarioName, manifest)
        : await runScenario(miniProgram, scenarioName, manifest));
    }
    if (issues.length > 0) throw new Error(`Native run captured ${issues.length} console error/assert or exception event(s).`);

    const summaryPath = await writeRunSummary({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'passed',
      scope: verifyCompletedOnly ? 'completed-owner-and-admin-verification' : fullClosure ? 'full-native-closure' : 'owner-booking-and-payment',
      scenarios: results,
      consoleIssueCount: issues.length,
    });
    console.log(`Native annual-inspection booking QA passed (${results.length} scenario(s)).`);
    console.log(`Sanitized summary: ${summaryPath}`);
  } catch (error) {
    if (miniProgram) {
      await capture(miniProgram, activeScenario, 'FAILED').catch(() => undefined);
    }
    const message = error && error.message ? error.message : String(error);
    await writeRunSummary({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'failed',
      failedScenario: activeScenario,
      completedScenarios: results,
      error: message,
      recovery: [
        'Keep WeChat DevTools open with the mini-program compiled.',
        'Confirm the automator socket and local API ports match the environment variables.',
        'Reload the isolated annual-inspection fixture schema before rerunning a scenario that already created an active order.',
        'If the local manifest intentionally uses a labelled document placeholder, opt in only with WECHAT_QA_ALLOW_SYNTHETIC_DOCUMENT=1.',
        'For full closure, provide isolated local platform-admin and inspection-station credentials through WECHAT_QA_ADMIN_* and WECHAT_QA_OPERATOR_* environment variables.',
      ],
    }).catch(() => undefined);
    throw error;
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
