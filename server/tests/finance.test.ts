import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "../app.js";
import { migrateDatabase } from "../db.js";
import { calculateCommissionFen, calculateValetCostFen, msUntilNextShanghaiDailyClose, previousShanghaiDate, runFinanceDailyClose } from "../finance.js";
import type { Database } from "../db.js";
import { createTestDatabase } from "./test-database.js";

test("统一结算按分四舍五入、固定佣金封顶并按单程距离进位代驾成本", () => {
  assert.equal(calculateCommissionFen(10_005, { calculation_mode: "percentage", rate_bps: 333 }), 333);
  assert.equal(calculateCommissionFen(500, { calculation_mode: "fixed", fixed_fen: 800 }), 500);
  assert.equal(calculateCommissionFen(0, { calculation_mode: "fixed", fixed_fen: 100 }), 0);
  assert.equal(calculateValetCostFen(5, { base_fee_fen: 1_500, included_km: 5, per_km_fen: 300 }), 1_500);
  assert.equal(calculateValetCostFen(5.01, { base_fee_fen: 1_500, included_km: 5, per_km_fen: 300 }), 1_800);
  assert.equal(calculateValetCostFen(7.2, { base_fee_fen: 1_500, included_km: 5, per_km_fen: 300 }), 2_400);
  assert.throws(() => calculateValetCostFen(-1, { base_fee_fen: 1_500, included_km: 5, per_km_fen: 300 }), /VALID_DISTANCE_REQUIRED/u);
});

test("日结闹钟按上海时区计算到下一个 02:00", () => {
  assert.equal(previousShanghaiDate(new Date("2026-09-09T03:00:00+08:00")), "2026-09-08");
  // 01:30 → 今天 02:00
  assert.equal(
    msUntilNextShanghaiDailyClose(new Date("2026-09-09T01:30:00+08:00"), 2),
    Date.parse("2026-09-09T02:00:00+08:00") - Date.parse("2026-09-09T01:30:00+08:00"),
  );
  // 02:00:01 → 明天 02:00
  assert.equal(
    msUntilNextShanghaiDailyClose(new Date("2026-09-09T02:00:01+08:00"), 2),
    Date.parse("2026-09-10T02:00:00+08:00") - Date.parse("2026-09-09T02:00:01+08:00"),
  );
  // 正好 02:00:00 → 立刻可跑
  assert.equal(msUntilNextShanghaiDailyClose(new Date("2026-09-09T02:00:00+08:00"), 2), 0);
});

async function insertRule(database: Database): Promise<string> {
  const id = randomUUID();
  await database.prepare(`
    INSERT INTO finance_rule_versions (
      id, business_type, rule_kind, calculation_mode, rate_bps, fixed_fen,
      base_fee_fen, included_km, per_km_fen, effective_from, version, status,
      created_by_account_id, published_by_account_id, created_at, published_at
    ) VALUES (?, 'repair', 'commission', 'percentage', 1000, NULL, NULL, NULL, NULL,
      '2026-01-01', 1, 'active', NULL, NULL, now(), now())
  `).run(id);
  return id;
}

async function insertAccrual(database: Database, input: {
  ruleId: string;
  order: string;
  gross: number;
  commission: number;
  net: number;
  date: string;
  kind?: "accrual" | "reversal";
  reversalOf?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await database.prepare(`
    INSERT INTO finance_accruals (
      id, idempotency_key, source_order_type, source_order_id, order_number,
      component_type, entry_kind, reversal_of_id, counterparty_type, counterparty_id,
      counterparty_name, gross_amount_fen, commission_amount_fen, net_amount_fen,
      customer_component_amount_fen, one_way_distance_km, rule_version_id,
      rule_snapshot_json, status, eligible_at, eligible_date, statement_id, created_at
    ) VALUES (?, ?, 'repair', ?, ?, 'repair_fee', ?, ?, 'repair_shop', 'shop-finance-test',
      '测试维修门店', ?, ?, ?, ?, NULL, ?, '{"version":1}'::jsonb,
      'pending_statement', (?::date + time '12:00') AT TIME ZONE 'Asia/Shanghai', ?::date, NULL, now())
  `).run(
    id,
    `test:${input.order}:${input.kind ?? "accrual"}`,
    input.order,
    input.order,
    input.kind ?? "accrual",
    input.reversalOf ?? null,
    input.gross,
    input.commission,
    input.net,
    input.gross,
    input.ruleId,
    input.date,
    input.date,
  );
  return id;
}

test("日结幂等，封账后退款进入下一期负数冲正并连续结转抵扣", async () => {
  const database = await createTestDatabase("finance_close");
  try {
    await migrateDatabase(database);
    const ruleId = await insertRule(database);
    await database.prepare("UPDATE finance_settings SET enabled = TRUE, cutover_at = '2026-09-01T00:00:00+08:00'").run();

    const originalId = await insertAccrual(database, { ruleId, order: "WX-001", gross: 10_000, commission: 1_000, net: 9_000, date: "2026-09-02" });
    assert.equal(await runFinanceDailyClose(database, "2026-09-02", new Date("2026-09-03T03:00:00+08:00")), 1);
    assert.equal(await runFinanceDailyClose(database, "2026-09-02", new Date("2026-09-03T03:01:00+08:00")), 0);
    const first = await database.prepare<Record<string, unknown>>("SELECT * FROM finance_daily_statements WHERE statement_date = '2026-09-02'").get();
    assert.equal(Number(first?.payable_amount_fen), 9_000);
    assert.equal(first?.status, "pending_payment");

    await insertAccrual(database, { ruleId, order: "WX-001-R", gross: -10_000, commission: -1_000, net: -9_000, date: "2026-09-03", kind: "reversal", reversalOf: originalId });
    assert.equal(await runFinanceDailyClose(database, "2026-09-03", new Date("2026-09-04T03:00:00+08:00")), 1);
    const reversal = await database.prepare<Record<string, unknown>>("SELECT * FROM finance_daily_statements WHERE statement_date = '2026-09-03'").get();
    assert.equal(Number(reversal?.payable_amount_fen), 0);
    assert.equal(Number(reversal?.closing_balance_fen), -9_000);
    assert.equal(reversal?.status, "carried_forward");

    await insertAccrual(database, { ruleId, order: "WX-002", gross: 5_000, commission: 500, net: 4_500, date: "2026-09-04" });
    await runFinanceDailyClose(database, "2026-09-04", new Date("2026-09-05T03:00:00+08:00"));
    const carried = await database.prepare<Record<string, unknown>>("SELECT * FROM finance_daily_statements WHERE statement_date = '2026-09-04'").get();
    assert.equal(Number(carried?.opening_balance_fen), -9_000);
    assert.equal(Number(carried?.closing_balance_fen), -4_500);
    assert.equal(Number(carried?.payable_amount_fen), 0);

    await insertAccrual(database, { ruleId, order: "WX-003", gross: 10_000, commission: 1_000, net: 9_000, date: "2026-09-05" });
    await runFinanceDailyClose(database, "2026-09-05", new Date("2026-09-06T03:00:00+08:00"));
    const offset = await database.prepare<Record<string, unknown>>("SELECT * FROM finance_daily_statements WHERE statement_date = '2026-09-05'").get();
    assert.equal(Number(offset?.opening_balance_fen), -4_500);
    assert.equal(Number(offset?.payable_amount_fen), 4_500);
    assert.equal(Number(offset?.closing_balance_fen), 0);
  } finally {
    await database.close();
  }
});

test("作废日账单后同日可重新封账", async () => {
  const database = await createTestDatabase("finance_void_reclose");
  try {
    await migrateDatabase(database);
    const ruleId = await insertRule(database);
    await database.prepare("UPDATE finance_settings SET enabled = TRUE, cutover_at = '2026-09-01T00:00:00+08:00'").run();
    await insertAccrual(database, { ruleId, order: "WX-VOID-1", gross: 10_000, commission: 1_000, net: 9_000, date: "2026-09-02" });
    assert.equal(await runFinanceDailyClose(database, "2026-09-02", new Date("2026-09-03T03:00:00+08:00")), 1);
    const first = await database.prepare<Record<string, unknown>>("SELECT * FROM finance_daily_statements WHERE statement_date = '2026-09-02' AND status <> 'void'").get();
    assert.ok(first?.id);
    await database.prepare("UPDATE finance_accruals SET status = 'pending_statement', statement_id = NULL WHERE statement_id = ?").run(String(first.id));
    await database.prepare("DELETE FROM finance_statement_items WHERE statement_id = ?").run(String(first.id));
    await database.prepare("UPDATE finance_daily_statements SET status = 'void', voided_at = now(), updated_at = now() WHERE id = ?").run(String(first.id));
    await database.prepare(`INSERT INTO finance_counterparty_balances (counterparty_type, counterparty_id, balance_fen, updated_at)
      VALUES ('repair_shop', 'shop-finance-test', 0, now())
      ON CONFLICT (counterparty_type, counterparty_id) DO UPDATE SET balance_fen = 0, updated_at = excluded.updated_at`).run();
    assert.equal(await runFinanceDailyClose(database, "2026-09-02", new Date("2026-09-03T03:05:00+08:00")), 1);
    const rows = await database.prepare<Record<string, unknown>>("SELECT status FROM finance_daily_statements WHERE statement_date = '2026-09-02' ORDER BY status").all();
    assert.deepEqual(rows.map((row) => String(row.status)), ["pending_payment", "void"]);
    const active = await database.prepare<Record<string, unknown>>("SELECT payable_amount_fen FROM finance_daily_statements WHERE statement_date = '2026-09-02' AND status = 'pending_payment'").get();
    assert.equal(Number(active?.payable_amount_fen), 9_000);
  } finally {
    await database.close();
  }
});

test("平台订单流水支持规范化车牌筛选且不会暴露为未授权公共接口", async () => {
  const database = await createTestDatabase("finance_api");
  const root = mkdtempSync(join(tmpdir(), "yuxiaoman-finance-api-"));
  const app = await buildApp({ database, uploadDir: join(root, "uploads") });
  try {
    await app.ready();
    await database.prepare(`INSERT INTO finance_payment_transactions (
      id, source_payment_type, source_payment_id, source_order_type, source_order_id,
      order_number, transaction_kind, provider, listed_amount_fen, channel_amount_fen,
      transaction_id, out_trade_no, status, is_real, occurred_at, created_at
    ) VALUES ('finance-anomaly-test', 'test_payment', 'test-payment-1', 'repair', 'missing-order',
      'YXM-ANOMALY-1', 'charge', 'wechat', 10000, 10, 'wx-test-anomaly', 'out-test-anomaly',
      'anomaly', FALSE, now(), now())`).run();
    const response = await app.inject({ method: "GET", url: "/api/admin/finance/transactions?plate=%E6%B4%A5A%C2%B788888" });
    assert.equal(response.statusCode, 200, response.body);
    const payload = response.json() as { data: { items: unknown[]; total: number } };
    assert.ok(Array.isArray(payload.data.items));
    assert.equal(typeof payload.data.total, "number");
    const anomalyResponse = await app.inject({ method: "GET", url: "/api/admin/finance/transactions?status=abnormal" });
    assert.equal(anomalyResponse.statusCode, 200, anomalyResponse.body);
    const anomalyPayload = anomalyResponse.json() as { data: { items: Array<{ status: string; isReal: boolean }>; total: number } };
    assert.equal(anomalyPayload.data.total, 1);
    assert.deepEqual(anomalyPayload.data.items.map((item) => ({ status: item.status, isReal: item.isReal })), [{ status: "anomaly", isReal: false }]);
    const fulfillmentResponse = await app.inject({ method: "GET", url: "/api/admin/finance/transactions?fulfillmentStatus=completed" });
    assert.equal(fulfillmentResponse.statusCode, 200, fulfillmentResponse.body);
  } finally {
    await app.close();
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
