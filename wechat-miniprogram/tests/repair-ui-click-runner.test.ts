import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(currentDirectory, "../scripts/qa-repair-marketplace.cjs");
const source = readFileSync(runnerPath, "utf8");

test("维修原生 QA 不通过接口预置或推进维修业务状态", () => {
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\/demo\/reset|\/repair\/requests['"`]|\/repair-operator\/requests/u);
  assert.doesNotMatch(source, /seedRepair|seedQuote|setStorageSync/u);
});

test("维修原生 QA 覆盖车主发布、三店报价、显式选店支付与成交权限", () => {
  for (const requiredSelector of [
    ".repair-quote-entry",
    ".consent-card label",
    ".publish-bar button",
    ".request-card",
    ".price-field input",
    ".note-field input",
    ".submit-button",
    ".quote-card",
    ".payment-bar .pay",
    ".detail-footer button",
  ]) {
    assert.match(source, new RegExp(requiredSelector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(source, /credentials\.length/u);
  assert.match(source, /value\.length === 3/u);
  assert.match(source, /explicit owner quote selection/u);
  assert.match(source, /winning shop contact permission/u);
  assert.match(source, /losing shop contact lock/u);
});

test("维修成交后逐店验证两家落选门店均无法看到联系人并独立截图", () => {
  assert.match(source, /const losingCredentials = credentials\.filter\(/u);
  assert.match(source, /losingCredentials\.length !== 2/u);
  assert.match(source, /for \(const \[losingShopIndex, losingCredential\] of losingCredentials\.entries\(\)\)/u);
  assert.match(source, /verifyLosingShop\(miniProgram, losingCredential, requestId, losingShopIndex\)/u);
  assert.match(source, /waitForElement\(deal, '\.locked-card'/u);
  assert.match(source, /deal\.\$\('\.contact-card'\)/u);
  assert.match(source, /losing-shop-\$\{ordinal\}-contact-locked/u);
  assert.match(source, /contactVisible: false/u);
  assert.match(source, /losingShopPrivacyChecks,/u);
});

test("维修报价摘要记录页面表单对应的 totalFen 与 totalYuan", () => {
  assert.match(source, /await price\.input\(credential\.totalYuan\)/u);
  assert.match(source, /waitForPageData\([\s\S]*'totalInput'[\s\S]*String\(value\) === credential\.totalYuan/u);
  assert.match(source, /quoteYuanInputToFen\(submittedTotalYuan/u);
  assert.match(source, /Number\(updated\.myQuote\.totalFen\) !== submittedTotalFen/u);
  assert.match(source, /totalFen: submittedTotalFen,[\s\S]*totalYuan: submittedTotalYuan/u);
  assert.doesNotMatch(source, /totalPriceFen: updated\.myQuote\.totalPriceFen/u);
});

test("维修原生 QA 可从报告页已有询价按真实入口点击续跑", () => {
  assert.doesNotMatch(source, /existingRequest\) throw new Error\('This report already has a repair request/u);
  assert.match(source, /await entry\.tap\(\)/u);
  assert.match(source, /if \(!existingRequest\)[\s\S]*mode: 'new'/u);
  assert.match(source, /existingRequest\.status !== 'open'/u);
  assert.match(source, /Number\(existingRequest\.quoteCount\) > 0/u);
  assert.match(source, /currentPage\(miniProgram, OWNER_QUOTES_ROUTE, 'existing owner quote comparison'\)/u);
  assert.match(source, /waitForElement\(quotesPage, '\.request-summary', 'view existing repair request'\)/u);
  assert.match(source, /await viewRequest\.tap\(\)[\s\S]*currentPage\(miniProgram, OWNER_DETAIL_ROUTE/u);
  assert.match(source, /mode: 'resume',[\s\S]*request/u);
  assert.match(source, /ownerRepairEntry\.mode === 'resume'[\s\S]*ownerRepairEntry\.request/u);
});

test("维修门店已有 active 报价时从渲染详情校验金额并复用", () => {
  assert.match(source, /request\.myQuote && request\.myQuote\.status === 'active'/u);
  assert.match(source, /waitForElement\(detail, '\.quote-price'/u);
  assert.match(source, /'quoteAmountLabel'[\s\S]*quoteFenToRenderedYuan\(expectedTotalFen\)/u);
  assert.match(source, /Number\(activeQuote\.totalFen\) !== expectedTotalFen/u);
  assert.match(source, /quoteId: activeQuote\.id,[\s\S]*totalFen: expectedTotalFen,[\s\S]*resumed: true/u);
  assert.match(source, /const quoteEntry = await waitForElement/u);
});

test("维修原生 QA 只在登录成功后截图且摘要会剔除凭证", () => {
  assert.doesNotMatch(source, /login-filled/u);
  assert.match(source, /current\.path === SHOP_LOGIN_ROUTE/u);
  assert.match(source, /removeLegacyCredentialScreenshots\(\)/u);
  assert.match(source, /\['login', 'filled'\]\.join\('-'\)/u);
  assert.match(source, /currentPage\(miniProgram, SHOP_HALL_ROUTE[\s\S]*capture\(miniProgram, `\$\{screenshotPrefix\}-login-success`\)/u);
  assert.doesNotMatch(
    source,
    /inputs\[1\]\.input\(credential\.password\)[\s\S]{0,300}capture\(/u,
  );
  assert.match(source, /sanitizeSummaryValue\(payload\)/u);
  assert.match(source, /\/password\|loginName\|credential\/iu/u);
  assert.match(source, /protectSummarySecret\(credential\.password\)/u);
});

test("维修原生 QA 截图前等待页面落稳并关闭瞬时提示", () => {
  assert.match(source, /callWxMethod\('hideToast'\)/u);
  assert.match(source, /await delay\(350\)/u);
  assert.match(source, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/u);
  assert.match(source, /if \(attempt < 3\) await delay\(700 \* attempt\)/u);
});

test("维修报价成交后使用明确已选标识而不是灰色禁用单选框", () => {
  const template = readFileSync(resolve(currentDirectory, "../miniprogram/packages/repair/pages/owner-quotes/owner-quotes.wxml"), "utf8");
  const style = readFileSync(resolve(currentDirectory, "../miniprogram/packages/repair/pages/owner-quotes/owner-quotes.wxss"), "utf8");
  assert.match(template, /request\.status === 'paid'[\s\S]*class="quote-final-state \{\{item\.selected \? 'selected' : ''\}\}"/u);
  assert.match(template, /item\.selected \? '已选' : '未选'/u);
  assert.match(template, /<radio wx:else/u);
  assert.match(style, /\.quote-final-state\.selected\s*\{[^}]*color:\s*#1768cf/iu);
});
