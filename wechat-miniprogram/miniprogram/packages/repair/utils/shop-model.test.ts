import assert from "node:assert/strict";
import test from "node:test";
import {
  fenToYuanInput,
  filterShopRequests,
  formatShopTimestamp,
  maskPlateForShop,
  normalizeRepairShopHall,
  normalizeRepairShopDeal,
  validateShopQuote,
  yuanInputToFen,
  type RepairShopRequestListItem,
} from "./shop-model";

test("维修门店只能消费脱敏车牌，不依赖本地门店选择器", () => {
  assert.equal(maskPlateForShop("津A12345"), "津A·***45");
  assert.equal(maskPlateForShop("津A·***45"), "津A·***45");
  assert.equal(maskPlateForShop(""), "车牌已脱敏");
});

test("报价金额以字符串精确转换元和分并限制两位小数", () => {
  assert.deepEqual(yuanInputToFen("1680"), { valid: true, fen: 168000, error: "" });
  assert.deepEqual(yuanInputToFen("1980.5"), { valid: true, fen: 198050, error: "" });
  assert.equal(fenToYuanInput(235000), "2350");
  assert.equal(fenToYuanInput(235050), "2350.50");
  assert.equal(yuanInputToFen("12.345").valid, false);
  assert.equal(yuanInputToFen("0").valid, false);
  assert.equal(yuanInputToFen("100000").valid, false);
  assert.equal(formatShopTimestamp("2026-08-24T06:20:00.000Z"), "2026-08-24 14:20");
});

test("报价校验要求有效总价和一句不超过六十字的说明", () => {
  assert.deepEqual(validateShopQuote("1680", "  钣金修复 + 喷漆，质保 1 年  "), {
    totalFen: 168000,
    note: "钣金修复 + 喷漆，质保 1 年",
    priceError: "",
    noteError: "",
  });
  assert.match(validateShopQuote("", "").priceError, /请输入报价/);
  assert.match(validateShopQuote("1680", "").noteError, /一句报价说明/);
});

test("接单大厅按待报价、已报价、已成交过滤且不改变原列表", () => {
  const request = (id: string, status: RepairShopRequestListItem["status"]): RepairShopRequestListItem => ({
    id,
    plateMasked: "津A·***06",
    vehicleLabel: "吉利银河 E8",
    submittedAt: "2026-08-24 14:00",
    status,
    faultCount: 4,
  });
  const requests = [request("1", "pending_quote"), request("2", "quoted"), request("3", "won"), request("4", "not_selected")];
  assert.deepEqual(filterShopRequests(requests, "pending").map((item) => item.id), ["1"]);
  assert.deepEqual(filterShopRequests(requests, "quoted").map((item) => item.id), ["2"]);
  assert.deepEqual(filterShopRequests(requests, "won").map((item) => item.id), ["3"]);
  assert.equal(filterShopRequests(requests, "all").length, 4);
  assert.equal(requests.length, 4);
});

test("接单大厅从服务端 raw items 推导门店状态、车损数量和统计", () => {
  const hall = normalizeRepairShopHall({ items: [
    {
      id: "pending",
      requestNo: "R1",
      status: "open",
      vehicle: { plateNumberMasked: "津A·***06", displayName: "吉利银河 E8" },
      faultCount: 4,
      primaryFault: { regionCode: "left_front_door", faultType: "scratch", severity: "minor" },
      createdAt: "2026-08-24T14:20:00.000Z",
      ownQuote: null,
    },
    {
      id: "quoted",
      status: "open",
      vehicle: { plateNumberMasked: "津B·***08", vehicleType: "小型轿车" },
      faultCount: 2,
      ownQuote: { id: "q2", status: "active", totalPriceFen: 198000, note: "标准工艺", revision: 1 },
    },
    {
      id: "won",
      status: "paid",
      vehicle: { plateNumberMasked: "津C·***09", vehicleType: "小型轿车" },
      faultCount: 1,
      ownQuote: { id: "q3", status: "selected", totalPriceFen: 235000, note: "进口漆料", revision: 1 },
    },
  ] });
  assert.deepEqual(hall.stats, { pending: 1, quoted: 1, won: 1 });
  assert.deepEqual(hall.requests.map((item) => item.status), ["pending_quote", "quoted", "won"]);
  assert.equal(hall.requests[0].faultCount, 4);
  assert.match(hall.requests[0].primaryFaultLabel || "", /左前门/);
});

test("只有本店中选且需求已付款时，成交 normalize 才保留联系人", () => {
  const quote = { id: "q1", status: "active", totalPriceFen: 168000, note: "钣金喷漆", revision: 1 };
  const open = normalizeRepairShopDeal({
    id: "r1",
    status: "open",
    vehicle: { plateNumberMasked: "津A·***06", displayName: "吉利银河 E8" },
    ownQuote: quote,
    ownerContact: { name: "不应暴露", phone: "13800000000" },
  });
  assert.equal(open.eligible, false);
  assert.equal(open.contact, null);

  const paid = normalizeRepairShopDeal({
    id: "r1",
    status: "paid",
    vehicle: { plateNumberMasked: "津A·***06", displayName: "吉利银河 E8" },
    ownQuote: { ...quote, status: "selected" },
    ownerContact: { name: "演示车主", phone: "13800006666" },
  });
  assert.equal(paid.eligible, true);
  assert.deepEqual(paid.contact, { name: "演示车主", phone: "13800006666" });
});
