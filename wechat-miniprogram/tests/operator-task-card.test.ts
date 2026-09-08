import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatorTaskCard } from "../miniprogram/utils/operator-task-card";
import type { Booking } from "../miniprogram/types";

function booking(partial: Partial<Booking> & Pick<Booking, "status">): Booking {
  return {
    id: "b1",
    serviceMode: "self_drive",
    fulfillmentStatus: "active",
    ...partial,
  } as Booking;
}

test("到站核验：awaiting_arrival", () => {
  const card = buildOperatorTaskCard(booking({ status: "awaiting_arrival" }));
  assert.equal(card.stepIndex, 2);
  assert.equal(card.stepTotal, 5);
  assert.equal(card.title, "到站核验");
  assert.equal(card.primaryLabel, "确认到车 · 核验通过");
  assert.equal(card.primaryHint, "不等于开始检测，仅标记到站完成");
  assert.match(card.nextLabel, /交接检测/);
});

test("交接检测：checked_in", () => {
  const card = buildOperatorTaskCard(booking({ status: "checked_in" }));
  assert.equal(card.stepIndex, 3);
  assert.equal(card.title, "交接检测");
  assert.equal(card.primaryLabel, "确认交接 · 开始检测");
  assert.equal(card.primaryHint, "之后请在设备侧检测，再回小程序填报告");
});

test("结果回传：inspecting（不得与 checked_in 共用步骤号）", () => {
  const card = buildOperatorTaskCard(booking({ status: "inspecting" }));
  assert.equal(card.stepIndex, 4);
  assert.equal(card.title, "结果回传");
  assert.equal(card.primaryLabel, "填写体检报告并回传");
  assert.equal(card.primaryHint, "未完成报告前，订单会停在「检测中」");
});

test("预约确认自驾：confirmed", () => {
  const card = buildOperatorTaskCard(booking({ status: "confirmed", serviceMode: "self_drive" }));
  assert.equal(card.stepIndex, 1);
  assert.equal(card.primaryLabel, "接单并等待到站");
});

test("预约确认代驾：confirmed 无主按钮", () => {
  const card = buildOperatorTaskCard(booking({ status: "confirmed", serviceMode: "valet" }));
  assert.equal(card.stepIndex, 1);
  assert.equal(card.primaryLabel, "");
  assert.match(card.primaryHint, /司机/);
});

test("on_hold 显示异常挂起且可恢复", () => {
  const card = buildOperatorTaskCard(booking({ status: "on_hold" }));
  assert.equal(card.title, "异常挂起");
  assert.equal(card.primaryLabel, "异常已处理，恢复核验");
});

test("completed 无主按钮", () => {
  const card = buildOperatorTaskCard(booking({ status: "completed" }));
  assert.equal(card.stepIndex, 5);
  assert.equal(card.primaryLabel, "");
  assert.match(card.nextLabel, /已结束/);
});
