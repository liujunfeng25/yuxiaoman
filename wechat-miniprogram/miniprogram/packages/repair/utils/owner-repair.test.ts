import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  defaultFaultSelection,
  defaultOwnerQuoteId,
  ownerRepairStatusView,
  regionLabel,
  sortOwnerQuotes,
} from "./owner-repair";

const quotes = [
  { id: "withdrawn", status: "withdrawn" as const, totalPriceFen: 90000 },
  { id: "high", status: "active" as const, totalPriceFen: 235000 },
  { id: "low", status: "active" as const, totalPriceFen: 168000 },
  { id: "mid", status: "active" as const, totalPriceFen: 198000 },
];

test("报价按有效状态和全款总价升序排列，且不改写输入", () => {
  const originalIds = quotes.map((quote) => quote.id);
  assert.deepEqual(sortOwnerQuotes(quotes).map((quote) => quote.id), ["low", "mid", "high", "withdrawn"]);
  assert.deepEqual(quotes.map((quote) => quote.id), originalIds);
});

test("有效报价默认不代替车主选择，并保留用户已明确选择或成交的报价", () => {
  assert.equal(defaultOwnerQuoteId(quotes), "");
  assert.equal(defaultOwnerQuoteId(quotes, "mid"), "mid");
  assert.equal(defaultOwnerQuoteId(quotes, "withdrawn"), "");
  assert.equal(defaultOwnerQuoteId([{ id: "won", status: "selected", totalPriceFen: 198000 }]), "won");
});

test("发布确认固定选择报告中的全部车损", () => {
  assert.deepEqual(defaultFaultSelection([{ id: "fault-1" }, { id: "fault-2" }]), ["fault-1", "fault-2"]);
});

test("车主维修页面将检测报告的标准部位编码转换为中文", () => {
  assert.equal(regionLabel("left_rear_quarter"), "左后翼子板");
  assert.equal(regionLabel("right_rear_quarter"), "右后翼子板");
  assert.equal(regionLabel("trunk_tailgate"), "后备厢盖与尾门");
  assert.equal(regionLabel("right_sill"), "右侧裙");
});

test("维修报价与未中选门店的并排操作按钮不会按内容撑出网格", () => {
  const quoteStyle = readFileSync(resolve(process.cwd(), "miniprogram/packages/repair/pages/owner-quotes/owner-quotes.wxss"), "utf8");
  const dealStyle = readFileSync(resolve(process.cwd(), "miniprogram/packages/repair/pages/shop-deal/shop-deal.wxss"), "utf8");
  assert.match(quoteStyle, /\.payment-bar button,[^{]+\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*margin:\s*0;/u);
  assert.match(dealStyle, /\.locked-actions button\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*margin:\s*0;/u);
});

test("询价状态文案覆盖等待、已报价、已支付和已取消", () => {
  assert.equal(ownerRepairStatusView("open", 0).title, "等待修理店报价");
  assert.equal(ownerRepairStatusView("open", 3).title, "已收到 3 份报价");
  assert.equal(ownerRepairStatusView("paid", 3).title, "已支付 · 已成交");
  assert.equal(ownerRepairStatusView("cancelled", 1).title, "维修询价已取消");
  assert.equal(ownerRepairStatusView("paid", 3).canCancel, false);
});
