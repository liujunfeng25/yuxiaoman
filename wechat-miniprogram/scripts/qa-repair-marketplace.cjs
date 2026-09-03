'use strict';

/**
 * Native WeChat DevTools repair marketplace end-to-end QA.
 *
 * Every business mutation in this script is caused by tapping or typing on a
 * rendered mini-program page: owner consent/publish, three shop logins and
 * quotes, owner quote selection/mock payment, and the winning shop deal view.
 * It never seeds a repair request, quote, selection, payment, or status through
 * HTTP/SQL. The ignored local fixture result is read only for the already
 * completed annual-inspection booking id and test-only shop credentials.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const automator = require('miniprogram-automator');

const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeRoot = path.join(repoRoot, '.runtime', 'annual-demo-media');
const endpoint = String(process.env.WECHAT_AUTOMATOR_WS || 'ws://127.0.0.1:9421').trim();
const fixtureResultPath = path.resolve(process.env.WECHAT_QA_FIXTURE_RESULT || path.join(runtimeRoot, 'result.local.json'));
const annualSummaryPath = path.resolve(
  process.env.WECHAT_QA_ANNUAL_SUMMARY
    || path.join(runtimeRoot, 'artifacts', 'native-annual-final-20260829', 'run-summary.json'),
);
const artifactsDir = path.resolve(
  process.env.WECHAT_QA_REPAIR_ARTIFACTS
    || path.join(runtimeRoot, 'artifacts', 'native-repair-marketplace-e2e'),
);
const explicitBookingId = String(process.env.WECHAT_QA_REPAIR_BOOKING_ID || '').trim();
const timeoutMs = positiveInteger(process.env.WECHAT_QA_TIMEOUT_MS, 45_000, 'WECHAT_QA_TIMEOUT_MS');

const REPORT_ROUTE = 'packages/inspection/pages/checkup-report/checkup-report';
const OWNER_CONFIRM_ROUTE = 'packages/repair/pages/owner-request-confirm/owner-request-confirm';
const OWNER_DETAIL_ROUTE = 'packages/repair/pages/owner-request-detail/owner-request-detail';
const OWNER_QUOTES_ROUTE = 'packages/repair/pages/owner-quotes/owner-quotes';
const OWNER_RECEIPT_ROUTE = 'packages/repair/pages/owner-receipt/owner-receipt';
const SHOP_LOGIN_ROUTE = 'packages/repair/pages/shop-login/shop-login';
const SHOP_HALL_ROUTE = 'packages/repair/pages/shop-hall/shop-hall';
const SHOP_DETAIL_ROUTE = 'packages/repair/pages/shop-request-detail/shop-request-detail';
const SHOP_QUOTE_ROUTE = 'packages/repair/pages/shop-quote/shop-quote';
const SHOP_DEAL_ROUTE = 'packages/repair/pages/shop-deal/shop-deal';

const quoteInputs = Object.freeze([
  { totalYuan: '1680', note: '右后翼子板钣金修复并喷漆，含一年质保' },
  { totalYuan: '1980', note: '翼子板整形、底漆与面漆修复，含标准质保' },
  { totalYuan: '2350', note: '精细钣喷修复与色差校正，含一年质保' },
]);

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function quoteYuanInputToFen(value, label) {
  const normalized = String(value || '').trim();
  const match = /^(0|[1-9]\d{0,4})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error(`${label} is not a valid yuan input.`);
  const cents = (match[2] || '').padEnd(2, '0');
  const totalFen = Number(match[1]) * 100 + Number(cents || 0);
  if (totalFen < 100 || totalFen > 9_999_999) throw new Error(`${label} is outside the supported quote range.`);
  return totalFen;
}

function quoteFenToRenderedYuan(totalFen) {
  const normalized = Math.max(0, Math.trunc(Number(totalFen) || 0));
  const yuan = Math.floor(normalized / 100);
  const cents = normalized % 100;
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cents ? `${grouped}.${String(cents).padStart(2, '0')}` : grouped;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error && error.message ? error.message : error}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(operation, label, options = {}) {
  const limit = options.timeoutMs || timeoutMs;
  const interval = options.intervalMs || 250;
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < limit) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  const detail = lastError && lastError.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`${label} timed out after ${limit} ms.${detail}`);
}

async function currentPage(miniProgram, expectedPath, label = expectedPath) {
  return waitUntil(async () => {
    const page = await miniProgram.currentPage();
    return page && page.path === expectedPath ? page : null;
  }, `Waiting for ${label}`);
}

async function waitForPageData(page, selector, predicate, label) {
  const result = await waitUntil(async () => {
    const value = await page.data(selector);
    return predicate(value) ? { value } : null;
  }, label);
  return result.value;
}

async function waitForElement(page, selector, label) {
  return waitUntil(() => page.$(selector), `Waiting for ${label}`);
}

async function elementByAttribute(page, selector, attribute, expected, label) {
  return waitUntil(async () => {
    const elements = await page.$$(selector);
    for (const element of elements) {
      if (String(await element.attribute(attribute)) === String(expected)) return element;
    }
    return null;
  }, `Waiting for ${label}`);
}

async function relaunchPage(miniProgram, route, query = '', label = route) {
  const suffix = query ? `?${query}` : '';
  await miniProgram.callWxMethod('reLaunch', { url: `/${route}${suffix}` });
  await delay(1_000);
  return currentPage(miniProgram, route, label);
}

const screenshots = [];
const summarySecrets = new Set();

function registerScreenshot(filePath) {
  const resolved = path.resolve(filePath);
  if (!screenshots.includes(resolved)) screenshots.push(resolved);
}

function registerExistingScreenshot(step) {
  const filePath = path.join(artifactsDir, `${step}.png`);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1_024) {
    throw new Error(`Expected resumable screenshot is missing or invalid: ${filePath}`);
  }
  registerScreenshot(filePath);
  console.log(`[repair-ui] reused screenshot ${step}`);
  return filePath;
}

async function capture(miniProgram, step) {
  const current = await miniProgram.currentPage().catch(() => null);
  if (!current || current.path === SHOP_LOGIN_ROUTE) {
    console.log(`[repair-ui] screenshot ${step} skipped on credential page`);
    return null;
  }
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, `${step}.png`);
  // Let the newly mounted page paint and remove transient feedback so the
  // evidence reflects the named business state instead of the previous frame.
  await miniProgram.callWxMethod('hideToast').catch(() => undefined);
  await delay(350);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await miniProgram.screenshot({ path: filePath });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(700 * attempt);
    }
  }
  if (lastError) throw lastError;
  registerScreenshot(filePath);
  console.log(`[repair-ui] screenshot ${step}`);
  return filePath;
}

function removeLegacyCredentialScreenshots() {
  if (!fs.existsSync(artifactsDir)) return;
  const staleFailureEvidence = path.join(artifactsDir, 'FAILED.png');
  if (fs.existsSync(staleFailureEvidence)) fs.unlinkSync(staleFailureEvidence);
  const legacyMarker = ['login', 'filled'].join('-');
  for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(`${legacyMarker}.png`)) continue;
    fs.unlinkSync(path.join(artifactsDir, entry.name));
  }
}

function protectSummarySecret(value) {
  const text = String(value || '');
  if (text) summarySecrets.add(text);
}

function sanitizeSummaryValue(value, key = '') {
  if (/password|loginName|credential/iu.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeSummaryValue(item)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [childKey, sanitizeSummaryValue(childValue, childKey)])
        .filter(([, childValue]) => childValue !== undefined),
    );
  }
  if (typeof value !== 'string') return value;
  let sanitized = value;
  for (const secret of summarySecrets) sanitized = sanitized.split(secret).join('[REDACTED]');
  return sanitized;
}

function resolveBookingId(summary) {
  if (explicitBookingId) return explicitBookingId;
  const scenarios = Array.isArray(summary && summary.scenarios) ? summary.scenarios : [];
  const valet = scenarios.find((item) => item && item.scenario === 'valet');
  if (!valet || !valet.bookingId) {
    throw new Error('The annual native run summary does not contain a valet booking. Run the annual click-through first or set WECHAT_QA_REPAIR_BOOKING_ID.');
  }
  if (valet.closure && valet.closure.owner && valet.closure.owner.reportStatus !== 'published') {
    throw new Error('The valet annual-inspection report is not published.');
  }
  return String(valet.bookingId);
}

function resolveRepairCredentials(result) {
  const admins = result && result.credentials && Array.isArray(result.credentials.repairAdmins)
    ? result.credentials.repairAdmins
    : [];
  if (admins.length !== quoteInputs.length) {
    throw new Error('Three repair-shop demo credentials are required. Re-run the local annual fixture loader so result.local.json contains credentials.repairAdmins.');
  }
  const credentials = admins.map((credential, index) => ({
    loginName: String(credential.loginName || ''),
    password: String(credential.password || ''),
    repairShopId: String(credential.repairShopId || ''),
    ...quoteInputs[index],
  }));
  for (const credential of credentials) {
    if (!credential.loginName || !credential.password || !credential.repairShopId) {
      throw new Error('A repair-shop fixture credential is incomplete.');
    }
    protectSummarySecret(credential.loginName);
    protectSummarySecret(credential.password);
  }
  return credentials;
}

async function connectToDevtools() {
  if (automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return automator.launcher.connectTool({ wsEndpoint: endpoint });
  }
  return automator.connect({ wsEndpoint: endpoint });
}

async function openOwnerReport(miniProgram, bookingId) {
  const reportPage = await relaunchPage(
    miniProgram,
    REPORT_ROUTE,
    `id=${encodeURIComponent(bookingId)}`,
    'owner vehicle checkup report',
  );
  await waitForPageData(reportPage, 'loading', (value) => value === false, 'Waiting for owner report data');
  const report = await waitForPageData(
    reportPage,
    'report',
    (value) => value && value.status === 'published' && Array.isArray(value.faults) && value.faults.length > 0,
    'Waiting for a published report with recorded faults',
  );
  const missingPhoto = report.faults.find((fault) => !Array.isArray(fault.photos) || fault.photos.length < 1);
  if (missingPhoto) throw new Error(`Recorded fault ${missingPhoto.id || 'unknown'} has no close-up photo.`);
  const existingRequest = await reportPage.data('repairRequest');
  await waitForPageData(reportPage, 'repairAvailable', (value) => value === true, 'Waiting for repair CTA');
  await capture(miniProgram, '01-owner-report-repair-entry');
  const entry = await waitForElement(reportPage, '.repair-quote-entry', 'repair quote entry');
  await entry.tap();
  if (!existingRequest) {
    return {
      mode: 'new',
      page: await currentPage(miniProgram, OWNER_CONFIRM_ROUTE, 'repair request confirmation'),
      request: null,
    };
  }
  if (existingRequest.status !== 'open') {
    throw new Error(`The existing repair request cannot resume quoting from status ${existingRequest.status}.`);
  }

  // A retry after the owner has already published must retain the two immutable
  // consent-stage frames captured for this same request in the partial run.
  registerExistingScreenshot('02-owner-confirm-imported-faults');
  registerExistingScreenshot('03-owner-consent-ready');

  let detail;
  if (Number(existingRequest.quoteCount) > 0) {
    const quotesPage = await currentPage(miniProgram, OWNER_QUOTES_ROUTE, 'existing owner quote comparison');
    await waitForPageData(quotesPage, 'loading', (value) => value === false, 'Waiting for existing owner quote comparison');
    const quotedRequest = await waitForPageData(
      quotesPage,
      'request',
      (value) => value && value.id === existingRequest.id && value.status === 'open',
      'Waiting for the existing quoted repair request',
    );
    if (quotedRequest.id !== existingRequest.id) throw new Error('The quote comparison did not preserve the existing repair request.');
    const viewRequest = await waitForElement(quotesPage, '.request-summary', 'view existing repair request');
    await viewRequest.tap();
    detail = await currentPage(miniProgram, OWNER_DETAIL_ROUTE, 'existing repair request detail');
  } else {
    detail = await currentPage(miniProgram, OWNER_DETAIL_ROUTE, 'existing repair request detail');
  }
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for existing repair request detail');
  const request = await waitForPageData(
    detail,
    'request',
    (value) => value && value.id === existingRequest.id && value.status === 'open',
    'Waiting for resumable existing repair request',
  );
  await capture(miniProgram, '04-owner-request-waiting-quotes');
  return { mode: 'resume', page: detail, request };
}

async function publishOwnerRequest(miniProgram, reportPage) {
  await waitForPageData(reportPage, 'loading', (value) => value === false, 'Waiting for repair request confirmation data');
  const faults = await waitForPageData(reportPage, 'faultViews', (value) => Array.isArray(value) && value.length > 0, 'Waiting for imported report faults');
  if (faults.some((fault) => !Array.isArray(fault.photos) || fault.photos.length < 1)) {
    throw new Error('The owner confirmation page did not preserve all fault close-up photos.');
  }
  await capture(miniProgram, '02-owner-confirm-imported-faults');
  const consent = await waitForElement(reportPage, '.consent-card label', 'owner repair consent');
  await consent.tap();
  await waitForPageData(reportPage, 'consented', (value) => value === true, 'Waiting for owner consent');
  await capture(miniProgram, '03-owner-consent-ready');
  const publish = await waitForElement(reportPage, '.publish-bar button', 'publish repair request button');
  await publish.tap();
  const detail = await currentPage(miniProgram, OWNER_DETAIL_ROUTE, 'published repair request');
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for published repair request');
  const request = await waitForPageData(detail, 'request', (value) => value && value.status === 'open', 'Waiting for open repair request');
  if (!request.id || !request.report || !request.report.reportNo) throw new Error('Published repair request is missing its frozen report snapshot.');
  const activeQuoteCount = Number(await detail.data('activeQuoteCount'));
  if (activeQuoteCount === 0) {
    await capture(miniProgram, '04-owner-request-waiting-quotes');
  } else {
    // createRepairRequest is idempotent for one report. A retry after an
    // interrupted three-shop run returns the same open request; retain its
    // original waiting frame and continue through the rendered detail page.
    registerExistingScreenshot('04-owner-request-waiting-quotes');
    console.log(`[repair-ui] resumed idempotent owner request with ${activeQuoteCount} active quote(s)`);
  }
  return request;
}

async function loginShop(miniProgram, credential, screenshotPrefix) {
  const login = await relaunchPage(miniProgram, SHOP_LOGIN_ROUTE, '', 'repair shop login');
  await waitForPageData(login, 'checking', (value) => value === false, 'Waiting for repair shop session check');
  if (await login.data('signedInName')) {
    const change = await waitForElement(login, '.secondary', 'change repair shop account');
    await change.tap();
    await waitForPageData(login, 'signedInName', (value) => value === '', 'Waiting for repair shop sign-out');
  }
  const inputs = await waitUntil(async () => {
    const items = await login.$$('input');
    return items.length >= 2 ? items : null;
  }, 'Waiting for repair shop credentials');
  await inputs[0].input(credential.loginName);
  await inputs[1].input(credential.password);
  const submit = await waitForElement(login, '.primary', 'repair shop login button');
  await submit.tap();
  const hall = await currentPage(miniProgram, SHOP_HALL_ROUTE, 'repair shop hall');
  await waitForPageData(hall, 'loading', (value) => value === false, 'Waiting for repair shop hall');
  const subject = await hall.data('shopName');
  if (!subject) throw new Error(`Repair shop ${credential.repairShopId} did not receive a bound subject.`);
  await capture(miniProgram, `${screenshotPrefix}-login-success`);
  return hall;
}

async function logoutShop(miniProgram) {
  const hall = await relaunchPage(miniProgram, SHOP_HALL_ROUTE, '', 'repair shop hall for logout');
  await waitForPageData(hall, 'loading', (value) => value === false, 'Waiting for repair shop hall before logout');
  const logout = await waitForElement(hall, '.logout-entry', 'repair shop logout button');
  await logout.tap();
  const login = await currentPage(miniProgram, SHOP_LOGIN_ROUTE, 'repair shop login after logout');
  await waitForPageData(login, 'checking', (value) => value === false, 'Waiting for repair shop logout');
  await waitForPageData(login, 'signedInName', (value) => value === '', 'Waiting for cleared repair shop identity');
}

async function submitShopQuote(miniProgram, credential, requestId, index) {
  const prefix = String(5 + index * 4).padStart(2, '0');
  const hall = await loginShop(miniProgram, credential, `${prefix}-shop-${index + 1}`);
  const requestCard = await elementByAttribute(hall, '.request-card', 'data-id', requestId, `shop ${index + 1} request card`);
  await capture(miniProgram, `${String(6 + index * 4).padStart(2, '0')}-shop-${index + 1}-hall`);
  await requestCard.tap();
  const detail = await currentPage(miniProgram, SHOP_DETAIL_ROUTE, `shop ${index + 1} request detail`);
  await waitForPageData(detail, 'loading', (value) => value === false, `Waiting for shop ${index + 1} request detail`);
  const request = await waitForPageData(detail, 'request', (value) => value && value.id === requestId, `Waiting for shop ${index + 1} scoped request`);
  if (!Array.isArray(request.faults) || request.faults.length < 1 || request.faults.some((fault) => fault.photoUrls.length < 1)) {
    throw new Error(`Shop ${index + 1} did not receive the fault and its close-up photo.`);
  }
  await capture(miniProgram, `${String(7 + index * 4).padStart(2, '0')}-shop-${index + 1}-fault-detail`);
  const expectedTotalFen = quoteYuanInputToFen(credential.totalYuan, `Shop ${index + 1} configured page form amount`);
  const activeQuote = request.myQuote && request.myQuote.status === 'active' ? request.myQuote : null;
  if (activeQuote) {
    await waitForElement(detail, '.quote-price', `shop ${index + 1} rendered active quote amount`);
    const renderedAmount = await waitForPageData(
      detail,
      'quoteAmountLabel',
      (value) => String(value) === quoteFenToRenderedYuan(expectedTotalFen),
      `Waiting for shop ${index + 1} rendered active quote amount`,
    );
    if (Number(activeQuote.totalFen) !== expectedTotalFen) {
      throw new Error(`Shop ${index + 1} existing active quote amount does not match its configured page form amount.`);
    }
    registerExistingScreenshot(`${String(8 + index * 4).padStart(2, '0')}-shop-${index + 1}-quote-form`);
    await capture(miniProgram, `${String(9 + index * 4).padStart(2, '0')}-shop-${index + 1}-quote-submitted`);
    await logoutShop(miniProgram);
    return {
      quoteId: activeQuote.id,
      shopId: credential.repairShopId,
      totalFen: expectedTotalFen,
      totalYuan: credential.totalYuan,
      renderedTotalYuan: renderedAmount,
      note: activeQuote.note,
      resumed: true,
    };
  }
  const quoteEntry = await waitForElement(detail, '.detail-footer button', `shop ${index + 1} quote action`);
  await quoteEntry.tap();
  const quotePage = await currentPage(miniProgram, SHOP_QUOTE_ROUTE, `shop ${index + 1} quote form`);
  await waitForPageData(quotePage, 'loading', (value) => value === false, `Waiting for shop ${index + 1} quote form`);
  const price = await waitForElement(quotePage, '.price-field input', `shop ${index + 1} total price`);
  const note = await waitForElement(quotePage, '.note-field input', `shop ${index + 1} quote note`);
  await price.input(credential.totalYuan);
  await note.input(credential.note);
  await waitForPageData(quotePage, 'priceError', (value) => value === '', `Waiting for shop ${index + 1} price validation`);
  await waitForPageData(quotePage, 'noteError', (value) => value === '', `Waiting for shop ${index + 1} note validation`);
  const submittedTotalYuan = await waitForPageData(
    quotePage,
    'totalInput',
    (value) => String(value) === credential.totalYuan,
    `Waiting for shop ${index + 1} page form amount`,
  );
  const submittedTotalFen = quoteYuanInputToFen(submittedTotalYuan, `Shop ${index + 1} page form amount`);
  await capture(miniProgram, `${String(8 + index * 4).padStart(2, '0')}-shop-${index + 1}-quote-form`);
  const submit = await waitForElement(quotePage, '.submit-button', `shop ${index + 1} submit quote`);
  await submit.tap();
  const returnedDetail = await currentPage(miniProgram, SHOP_DETAIL_ROUTE, `shop ${index + 1} detail after quote`);
  const updated = await waitForPageData(
    returnedDetail,
    'request',
    (value) => value && value.myQuote && value.myQuote.status === 'active',
    `Waiting for shop ${index + 1} active quote`,
  );
  if (Number(updated.myQuote.totalFen) !== submittedTotalFen) {
    throw new Error(`Shop ${index + 1} persisted quote amount does not match its page form input.`);
  }
  await capture(miniProgram, `${String(9 + index * 4).padStart(2, '0')}-shop-${index + 1}-quote-submitted`);
  await logoutShop(miniProgram);
  return {
    quoteId: updated.myQuote.id,
    shopId: credential.repairShopId,
    totalFen: submittedTotalFen,
    totalYuan: submittedTotalYuan,
    note: updated.myQuote.note,
  };
}

async function ownerSelectAndPay(miniProgram, requestId) {
  const detail = await relaunchPage(miniProgram, OWNER_DETAIL_ROUTE, `id=${encodeURIComponent(requestId)}`, 'owner repair request with quotes');
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for owner repair request refresh');
  await waitForPageData(detail, 'activeQuoteCount', (value) => Number(value) === 3, 'Waiting for all three shop quotes');
  await capture(miniProgram, '17-owner-request-three-quotes');
  const openQuotes = await waitForElement(detail, '.action-bar .primary', 'owner view quotes button');
  await openQuotes.tap();
  const quotesPage = await currentPage(miniProgram, OWNER_QUOTES_ROUTE, 'owner quote comparison');
  await waitForPageData(quotesPage, 'loading', (value) => value === false, 'Waiting for owner quote comparison');
  const quoteViews = await waitForPageData(
    quotesPage,
    'quoteViews',
    (value) => Array.isArray(value) && value.length === 3 && value.every((quote) => quote.status === 'active'),
    'Waiting for three active owner quotes',
  );
  if ((await quotesPage.data('selectedQuoteId')) !== '' || quoteViews.some((quote) => quote.selected)) {
    throw new Error('The owner quote page selected a shop before the owner explicitly chose one.');
  }
  const initialPay = await waitForElement(quotesPage, '.payment-bar .pay', 'disabled owner mock payment button');
  await initialPay.tap();
  await delay(250);
  const pageAfterUnselectedPayAttempt = await miniProgram.currentPage();
  if (!pageAfterUnselectedPayAttempt || pageAfterUnselectedPayAttempt.path !== OWNER_QUOTES_ROUTE
    || (await quotesPage.data('selectedQuoteId')) !== ''
    || (await quotesPage.data('request'))?.status !== 'open'
    || (await quotesPage.data('paying')) !== false) {
    throw new Error('An unselected owner quote unexpectedly progressed mock payment.');
  }
  await capture(miniProgram, '18-owner-quotes-price-sorted');

  const explicitChoice = quoteViews[1];
  const cards = await waitUntil(async () => {
    const items = await quotesPage.$$('.quote-card');
    return items.length === 3 ? items : null;
  }, 'Waiting for three rendered quote cards');
  await cards[1].tap();
  await waitForPageData(quotesPage, 'selectedQuoteId', (value) => value === explicitChoice.id, 'Waiting for explicit owner quote selection');
  await capture(miniProgram, '19-owner-explicit-quote-selection');
  const pay = await waitForElement(quotesPage, '.payment-bar .pay', 'owner mock payment button');
  await pay.tap();
  const receipt = await currentPage(miniProgram, OWNER_RECEIPT_ROUTE, 'owner repair receipt');
  await waitForPageData(receipt, 'loading', (value) => value === false, 'Waiting for owner repair receipt');
  const paidRequest = await waitForPageData(
    receipt,
    'request',
    (value) => value && value.status === 'paid' && value.order && value.order.status === 'paid',
    'Waiting for paid repair request and frozen order',
  );
  await waitForPageData(receipt, 'ready', (value) => value === true, 'Waiting for complete repair receipt');
  if (paidRequest.selectedQuoteId !== explicitChoice.id) throw new Error('Payment did not freeze the explicitly selected quote.');
  await capture(miniProgram, '20-owner-paid-receipt');
  return {
    selectedQuoteId: explicitChoice.id,
    selectedShopId: explicitChoice.shop.id,
    selectedPriceFen: explicitChoice.totalPriceFen,
    orderNo: paidRequest.order.orderNo,
  };
}

async function verifyWinningShop(miniProgram, credential, requestId) {
  const hall = await loginShop(miniProgram, credential, '21-winning-shop');
  const card = await elementByAttribute(hall, '.request-card', 'data-id', requestId, 'winning shop request card');
  await capture(miniProgram, '22-winning-shop-hall');
  await card.tap();
  const detail = await currentPage(miniProgram, SHOP_DETAIL_ROUTE, 'winning shop request detail');
  await waitForPageData(detail, 'loading', (value) => value === false, 'Waiting for winning shop request detail');
  await waitForPageData(detail, 'request', (value) => value && value.status === 'won', 'Waiting for winning shop status');
  await capture(miniProgram, '23-winning-shop-selected');
  const dealEntry = await waitForElement(detail, '.detail-footer button', 'winning shop deal entry');
  await dealEntry.tap();
  const deal = await currentPage(miniProgram, SHOP_DEAL_ROUTE, 'winning repair shop deal');
  await waitForPageData(deal, 'loading', (value) => value === false, 'Waiting for winning shop deal');
  const dealData = await waitForPageData(deal, 'deal', (value) => value && value.eligible === true, 'Waiting for winning shop contact permission');
  if (!dealData.contact || !dealData.contact.name || !dealData.contact.phone) throw new Error('Winning shop did not receive the authorized synthetic contact.');
  await capture(miniProgram, '24-winning-shop-deal');
  await logoutShop(miniProgram);
}

async function verifyLosingShop(miniProgram, credential, requestId, losingShopIndex) {
  const ordinal = losingShopIndex + 1;
  const firstStep = 25 + losingShopIndex * 2;
  await loginShop(
    miniProgram,
    credential,
    `${String(firstStep).padStart(2, '0')}-losing-shop-${ordinal}`,
  );
  const deal = await relaunchPage(miniProgram, SHOP_DEAL_ROUTE, `id=${encodeURIComponent(requestId)}`, 'losing repair shop deal gate');
  await waitForPageData(deal, 'loading', (value) => value === false, 'Waiting for losing shop deal gate');
  await waitForPageData(deal, 'locked', (value) => value === true, 'Waiting for losing shop contact lock');
  await waitForElement(deal, '.locked-card', `losing shop ${ordinal} rendered contact lock`);
  const dealData = await deal.data('deal');
  if (dealData && dealData.contact) throw new Error('Losing shop unexpectedly received contact data.');
  if (await deal.$('.contact-card')) throw new Error(`Losing shop ${ordinal} unexpectedly rendered the owner contact card.`);
  const screenshotStep = `${String(firstStep + 1).padStart(2, '0')}-losing-shop-${ordinal}-contact-locked`;
  await capture(miniProgram, screenshotStep);
  await logoutShop(miniProgram);
  return {
    shopId: credential.repairShopId,
    locked: true,
    contactVisible: false,
    screenshot: `${screenshotStep}.png`,
  };
}

async function verifyOwnerPaidState(miniProgram, requestId) {
  const receipt = await relaunchPage(miniProgram, OWNER_RECEIPT_ROUTE, `id=${encodeURIComponent(requestId)}`, 'final owner repair receipt');
  await waitForPageData(receipt, 'loading', (value) => value === false, 'Waiting for final owner receipt');
  await waitForPageData(receipt, 'ready', (value) => value === true, 'Waiting for final paid receipt');
  await capture(miniProgram, '29-final-owner-receipt');
}

async function writeSummary(payload) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const summaryPath = path.join(artifactsDir, 'run-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(sanitizeSummaryValue(payload), null, 2)}\n`, 'utf8');
  return summaryPath;
}

async function run() {
  removeLegacyCredentialScreenshots();
  const fixtureResult = readJson(fixtureResultPath, 'Local fixture result');
  const annualSummary = explicitBookingId ? {} : readJson(annualSummaryPath, 'Annual native run summary');
  const bookingId = resolveBookingId(annualSummary);
  const credentials = resolveRepairCredentials(fixtureResult);
  const startedAt = new Date().toISOString();
  const issues = [];
  const quotes = [];
  const losingShopPrivacyChecks = [];
  let requestId = '';
  let paid = null;
  let miniProgram;

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

    const ownerRepairEntry = await openOwnerReport(miniProgram, bookingId);
    const request = ownerRepairEntry.mode === 'resume'
      ? ownerRepairEntry.request
      : await publishOwnerRequest(miniProgram, ownerRepairEntry.page);
    requestId = request.id;

    for (let index = 0; index < credentials.length; index += 1) {
      quotes.push(await submitShopQuote(miniProgram, credentials[index], requestId, index));
    }

    paid = await ownerSelectAndPay(miniProgram, requestId);
    const winningCredential = credentials.find((credential) => credential.repairShopId === paid.selectedShopId);
    const losingCredentials = credentials.filter((credential) => credential.repairShopId !== paid.selectedShopId);
    if (!winningCredential || losingCredentials.length !== 2) throw new Error('Unable to resolve the winning shop and both losing shops from the paid snapshot.');
    await verifyWinningShop(miniProgram, winningCredential, requestId);
    for (const [losingShopIndex, losingCredential] of losingCredentials.entries()) {
      losingShopPrivacyChecks.push(
        await verifyLosingShop(miniProgram, losingCredential, requestId, losingShopIndex),
      );
    }
    await verifyOwnerPaidState(miniProgram, requestId);

    if (issues.length) throw new Error(`Native repair QA captured ${issues.length} console error/assert or exception event(s).`);
    const summaryPath = await writeSummary({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'passed',
      scope: 'ui-only-repair-marketplace-transaction',
      annualBookingId: bookingId,
      requestId,
      quotes,
      selectedQuoteId: paid.selectedQuoteId,
      selectedShopId: paid.selectedShopId,
      selectedPriceFen: paid.selectedPriceFen,
      orderNo: paid.orderNo,
      losingShopPrivacyChecks,
      screenshotCount: screenshots.length,
      screenshots: screenshots.map((filePath) => path.relative(repoRoot, filePath)),
      consoleIssueCount: issues.length,
      boundary: 'The platform flow ends after quote selection and mock payment; physical repair fulfillment remains offline.',
    });
    console.log(`Native repair marketplace QA passed with ${quotes.length} UI-submitted quotes.`);
    console.log(`Sanitized summary: ${summaryPath}`);
  } catch (error) {
    if (miniProgram) await capture(miniProgram, 'FAILED').catch(() => undefined);
    await writeSummary({
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'failed',
      annualBookingId: bookingId,
      requestId,
      completedQuoteCount: quotes.length,
      paid,
      screenshotCount: screenshots.length,
      consoleIssueCount: issues.length,
      error: error && error.message ? error.message : String(error),
    });
    throw error;
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
