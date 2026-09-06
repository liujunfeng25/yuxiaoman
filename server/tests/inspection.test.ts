import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import {
  calculateInspection,
  expectedOnsiteChecksForPowertrain,
  INSPECTION_POLICY,
  normalizeInspectionPowertrainType,
  type InspectionCalculationInput,
  type InspectionDeclarations,
  type InspectionPowertrainInput,
} from "../../src/domain/inspection.js";
import { buildApp } from "../app.js";
import {
  INSPECTION_PRICE_PLAN_IDS,
  migrateDatabase,
  type Database,
} from "../db.js";
import { createTestDatabase } from "./test-database.js";

process.env.YUXIAOMAN_DEMO_DATE = "2026-08-11";

type Json = Record<string, any>;

const allNoDeclarations: InspectionDeclarations = {
  isVan: "no",
  hasInjuryAccident: "no",
  hasIllegalModificationPenalty: "no",
  convertedFromOperational: "no",
  delayedFirstRegistrationOver4Years: "no",
};

function standardInput(values: Partial<InspectionCalculationInput> = {}): InspectionCalculationInput {
  return {
    source: "temporary",
    asOfDate: "2026-08-16",
    vehicle: {
      registrationMonth: "2026-08",
      vehicleClass: "small_micro_passenger",
      usageNature: "non_operational",
      seats: 5,
    },
    declarations: { ...allNoDeclarations },
    ...values,
  };
}

async function fixture(): Promise<{
  app: FastifyInstance;
  database: Database;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase("inspection");
  const uploadDir = mkdtempSync(join(tmpdir(), "yuxiaoman-inspection-"));
  const app = await buildApp({ database, uploadDir });
  await app.ready();
  return {
    app,
    database,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

test("年检规则固定回归：新车站视角指向第6年上线，当前申领无需来站", () => {
  const result = calculateInspection(standardInput());
  assert.equal(result.source, "temporary");
  assert.equal(result.action, "claim_mark");
  assert.equal(result.windowStatus, "not_open");
  assert.equal(result.cycleYear, 6);
  assert.equal(result.estimatedDueDate, "2032-08-31");
  assert.deepEqual(result.applicationWindow, { start: "2032-06-01", end: "2032-08-31" });
  assert.equal(result.canBookInspection, false);
  assert.match(result.title, /无需来站/);
  assert.match(result.disclaimer, /不是政务实时查询/);
});

test("规则结果返回可追溯的五步证据且每个来源标识都存在", () => {
  const result = calculateInspection(standardInput({
    asOfDate: "2026-08-17",
    vehicle: {
      registrationMonth: "2020-08",
      vehicleClass: "small_micro_passenger",
      usageNature: "non_operational",
      seats: 5,
      powertrainType: "gasoline",
    },
  }));

  assert.deepEqual(result.evidence.steps.map((step) => step.id), [
    "scope",
    "cycle",
    "due_date",
    "window",
    "current_status",
  ]);
  assert.match(result.evidence.steps[0].expression, /5座.*非营运.*非面包车.*5项特殊情况均为否/);
  assert.equal(result.evidence.steps[1].expression, "2020-08 + 第6年 = 2026-08；第6年 ∈ 上线节点 {6年、10年}");
  assert.equal(result.evidence.steps[2].expression, "2026年8月最后一天 = 2026-08-31");
  assert.equal(result.evidence.steps[3].expression, "到期月前2个自然月起 = 2026-06-01 至 2026-08-31");
  assert.match(result.evidence.steps[4].expression, /今天2026-08-17位于/);
  assert.equal(result.evidence.steps[4].result, "可以预约上线检验");
  assert.match(result.evidence.assumptions[0], /历史应检均已按期办理/);

  const knownSourceIds = new Set(INSPECTION_POLICY.sources.map((source) => source.id));
  const referencedSourceIds = [
    ...result.evidence.steps.flatMap((step) => step.sourceIds),
    ...result.evidence.powertrainImpact.sourceIds,
  ];
  assert.ok(referencedSourceIds.length > 0);
  for (const sourceId of referencedSourceIds) {
    assert.ok(knownSourceIds.has(sourceId), sourceId);
  }
  for (const source of INSPECTION_POLICY.sources) {
    assert.ok(source.id.length > 0);
    assert.ok(source.topics.length > 0, source.id);
    assert.match(source.url, /^https:\/\//, source.id);
  }
});

test("所有动力类型使用相同周期，只改变预计上线项目", () => {
  const cases: Array<{
    input: InspectionPowertrainInput | undefined;
    canonical: string;
    checks: string[];
  }> = [
    { input: "gasoline", canonical: "gasoline", checks: ["safety_basic", "emissions_gasoline"] },
    { input: "diesel", canonical: "diesel", checks: ["safety_basic", "emissions_diesel"] },
    { input: "hybrid", canonical: "hybrid", checks: ["safety_basic", "emissions_gasoline"] },
    { input: "hev", canonical: "hybrid", checks: ["safety_basic", "emissions_gasoline"] },
    { input: "pure_electric", canonical: "pure_electric", checks: ["safety_basic", "new_energy_safety"] },
    { input: "phev", canonical: "phev", checks: ["safety_basic", "emissions_gasoline", "new_energy_safety"] },
    { input: "erev", canonical: "erev", checks: ["safety_basic", "emissions_gasoline", "new_energy_safety"] },
    { input: "other", canonical: "other", checks: [] },
    { input: undefined, canonical: "unknown", checks: [] },
  ];

  const baseline = calculateInspection(standardInput({
    asOfDate: "2026-06-01",
    vehicle: {
      registrationMonth: "2020-08",
      vehicleClass: "small_micro_passenger",
      usageNature: "non_operational",
      seats: 5,
      powertrainType: "gasoline",
    },
  }));

  for (const item of cases) {
    const result = calculateInspection(standardInput({
      asOfDate: "2026-06-01",
      vehicle: {
        registrationMonth: "2020-08",
        vehicleClass: "small_micro_passenger",
        usageNature: "non_operational",
        seats: 5,
        powertrainType: item.input,
      },
    }));
    assert.equal(result.action, baseline.action, item.canonical);
    assert.equal(result.cycleYear, baseline.cycleYear, item.canonical);
    assert.equal(result.estimatedDueDate, baseline.estimatedDueDate, item.canonical);
    assert.deepEqual(result.applicationWindow, baseline.applicationWindow, item.canonical);
    assert.equal(result.evidence.powertrainImpact.powertrainType, item.canonical);
    assert.equal(result.evidence.powertrainImpact.affectsCycle, false);
    assert.deepEqual(result.evidence.powertrainImpact.expectedOnsiteCheckCodes, item.checks, item.canonical);
  }

  assert.equal(normalizeInspectionPowertrainType("hev"), "hybrid");
  assert.equal(normalizeInspectionPowertrainType("unexpected"), "unknown");
  assert.deepEqual(
    expectedOnsiteChecksForPowertrain("hybrid", ["safety_basic", "emissions_gasoline", "emissions_diesel", "new_energy_safety"]),
    ["safety_basic", "emissions_gasoline"],
  );
});

test("申领标志轮次说明动力类型不增加本轮项目", () => {
  const result = calculateInspection(standardInput({
    vehicle: {
      registrationMonth: "2026-08",
      vehicleClass: "small_micro_passenger",
      usageNature: "non_operational",
      seats: 5,
      powertrainType: "pure_electric",
    },
  }));
  assert.equal(result.evidence.powertrainImpact.status, "not_applicable_this_cycle");
  assert.match(result.evidence.powertrainImpact.explanation, /本轮无需上线/);
});

test("动力档案来源未知或与号牌冲突时周期可算但检项待核验", () => {
  for (const powertrainSource of ["unknown", "conflict"] as const) {
    const result = calculateInspection(standardInput({
      asOfDate: "2026-08-17",
      vehicle: {
        registrationMonth: "2020-08",
        vehicleClass: "small_micro_passenger",
        usageNature: "non_operational",
        seats: 5,
        powertrainType: powertrainSource === "conflict" ? "pure_electric" : "gasoline",
        powertrainSource,
      },
    }));
    assert.equal(result.cycleYear, 6, powertrainSource);
    assert.equal(result.windowStatus, "open", powertrainSource);
    assert.equal(result.evidence.powertrainImpact.status, "needs_verification", powertrainSource);
    assert.deepEqual(result.evidence.powertrainImpact.expectedOnsiteCheckCodes, [], powertrainSource);
    assert.match(result.evidence.powertrainImpact.explanation, /具体上线项目需由检测站确认/);
    assert.equal(
      result.evidence.normalizedFacts.find((fact) => fact.code === "powertrain_type")?.source,
      powertrainSource,
    );
  }
});

test("用户确认有效期优先：一致可预约，月份差异仅软提示不挡预约", () => {
  const values = {
    registrationMonth: "2020-08",
    vehicleClass: "small_micro_passenger",
    usageNature: "non_operational",
    seats: 5,
    powertrainType: "hybrid",
  } as const;
  const matched = calculateInspection(standardInput({
    asOfDate: "2026-08-17",
    vehicle: values,
    inspectionValidity: {
      mode: "confirmed",
      validThroughMonth: "2026-08",
      source: "traffic_12123",
      confirmedAt: "2026-08-17",
    },
  }));
  assert.equal(matched.dateEvidence.comparison, "matched");
  assert.equal(matched.dateEvidence.confirmation?.validThroughDate, "2026-08-31");
  assert.equal(matched.dateEvidence.decisionBasis, "matched_confirmation");
  assert.equal(matched.canBookInspection, true);

  const softNote = calculateInspection(standardInput({
    asOfDate: "2026-08-17",
    vehicle: values,
    inspectionValidity: {
      mode: "confirmed",
      validThroughMonth: "2026-09",
      source: "electronic_driving_license",
    },
  }));
  assert.equal(softNote.dateEvidence.comparison, "note");
  assert.equal(softNote.dateEvidence.decisionBasis, "confirmed_priority");
  assert.equal(softNote.action, "onsite_inspection");
  assert.equal(softNote.windowStatus, "open");
  assert.equal(softNote.canBookInspection, true);
  assert.equal(softNote.estimatedDueDate, "2026-09-30");
  assert.equal(softNote.cycleYear, 6);
  assert.equal(softNote.manualReviewReasons.length, 0);

  assert.throws(
    () => calculateInspection(standardInput({
      vehicle: values,
      inspectionValidity: {
        mode: "confirmed",
        validThroughMonth: "2026-13",
        source: "paper_driving_license",
      },
    })),
    /validThroughMonth must use YYYY-MM/,
  );
});

test("年轻车申领窗口过期不误报上线逾期；确认2030后按确认日倒计时", () => {
  const vehicle = {
    registrationMonth: "2024-05",
    vehicleClass: "small_micro_passenger" as const,
    usageNature: "non_operational" as const,
    seats: 5,
    powertrainType: "pure_electric" as const,
  };
  const unconfirmed = calculateInspection(standardInput({
    asOfDate: "2026-09-01",
    vehicle,
  }));
  assert.equal(unconfirmed.estimatedDueDate, "2030-05-31");
  assert.equal(unconfirmed.action, "claim_mark");
  assert.equal(unconfirmed.canBookInspection, false);
  assert.match(unconfirmed.title, /申领窗口已过|无需来站/);
  assert.doesNotMatch(unconfirmed.title, /预计已逾期/);

  const confirmed = calculateInspection(standardInput({
    asOfDate: "2026-09-01",
    vehicle,
    inspectionValidity: {
      mode: "confirmed",
      validThroughMonth: "2030-05",
      source: "traffic_12123",
      confirmedAt: "2026-09-01",
    },
  }));
  assert.equal(confirmed.dateEvidence.comparison, "matched");
  assert.equal(confirmed.estimatedDueDate, "2030-05-31");
  assert.equal(confirmed.windowStatus, "not_open");
  assert.equal(confirmed.canBookInspection, false);
  assert.match(confirmed.title, /无需来站/);
});

test("年检规则表覆盖申领与上线节点，并识别漏检后的检测站预约", () => {
  const cases = [
    { registrationMonth: "2024-08", cycleYear: 6, action: "claim_mark", windowStatus: "not_open", canBook: false },
    { registrationMonth: "2022-08", cycleYear: 6, action: "claim_mark", windowStatus: "not_open", canBook: false },
    { registrationMonth: "2020-08", cycleYear: 6, action: "onsite_inspection", windowStatus: "open", canBook: true },
    { registrationMonth: "2018-08", cycleYear: 6, action: "onsite_inspection", windowStatus: "overdue", canBook: true },
    { registrationMonth: "2016-08", cycleYear: 6, action: "onsite_inspection", windowStatus: "overdue", canBook: true },
    { registrationMonth: "2015-08", cycleYear: 10, action: "onsite_inspection", windowStatus: "overdue", canBook: true },
  ] as const;

  for (const item of cases) {
    const result = calculateInspection(standardInput({
      asOfDate: "2026-06-01",
      vehicle: {
        registrationMonth: item.registrationMonth,
        vehicleClass: "small_micro_passenger",
        usageNature: "non_operational",
        seats: 5,
      },
    }));
    assert.equal(result.cycleYear, item.cycleYear, item.registrationMonth);
    assert.equal(result.action, item.action, item.registrationMonth);
    assert.equal(result.windowStatus, item.windowStatus, item.registrationMonth);
    assert.equal(result.canBookInspection, item.canBook, item.registrationMonth);
  }
});

test("办理窗口使用自然月并覆盖首日、末日和逾期次日", () => {
  const values = { registrationMonth: "2020-08", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5 } as const;
  const before = calculateInspection(standardInput({ asOfDate: "2026-05-31", vehicle: values }));
  const firstDay = calculateInspection(standardInput({ asOfDate: "2026-06-01", vehicle: values }));
  const lastDay = calculateInspection(standardInput({ asOfDate: "2026-08-31", vehicle: values }));
  const overdue = calculateInspection(standardInput({ asOfDate: "2026-09-01", vehicle: values }));

  assert.equal(before.windowStatus, "not_open");
  assert.equal(firstDay.windowStatus, "open");
  assert.equal(lastDay.windowStatus, "open");
  assert.equal(overdue.windowStatus, "overdue");
  assert.equal(overdue.action, "onsite_inspection");
  assert.equal(overdue.canBookInspection, true);
  assert.match(overdue.title, /仍可预约检测站/);
});

test("第6年漏检后，在第8年申领窗口前后仍可预约检测站", () => {
  const vehicle = {
    registrationMonth: "2020-08",
    vehicleClass: "small_micro_passenger" as const,
    usageNature: "non_operational" as const,
    seats: 5,
  };

  for (const asOfDate of ["2027-06-01", "2028-02-01", "2028-07-01", "2030-08-31"]) {
    const result = calculateInspection(standardInput({ asOfDate, vehicle }));
    assert.equal(result.action, "onsite_inspection", asOfDate);
    assert.equal(result.canBookInspection, true, asOfDate);
    assert.ok(result.reasons.some((item) => item.code === "outstanding_onsite_obligation"), asOfDate);
    assert.match(result.title, /仍可预约检测站/, asOfDate);
  }

  const beforeYearSix = calculateInspection(standardInput({ asOfDate: "2026-05-31", vehicle }));
  assert.equal(beforeYearSix.action, "onsite_inspection");
  assert.equal(beforeYearSix.canBookInspection, false);
  assert.equal(beforeYearSix.windowStatus, "not_open");
});

test("自然月计算覆盖跨年、闰年二月和月末", () => {
  const january = calculateInspection(standardInput({
    asOfDate: "2025-11-01",
    vehicle: { registrationMonth: "2020-01", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5 },
  }));
  assert.deepEqual(january.applicationWindow, { start: "2025-11-01", end: "2026-01-31" });

  const leapFebruary = calculateInspection(standardInput({
    asOfDate: "2024-02-01",
    vehicle: { registrationMonth: "2018-02", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5 },
  }));
  assert.equal(leapFebruary.estimatedDueDate, "2024-02-29");

  const april = calculateInspection(standardInput({
    asOfDate: "2026-04-01",
    vehicle: { registrationMonth: "2020-04", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5 },
  }));
  assert.equal(april.estimatedDueDate, "2026-04-30");
});

test("非标准车辆事实均安全降级为人工核验", () => {
  const cases: Array<{ label: string; vehicle: InspectionCalculationInput["vehicle"] }> = [
    { label: "其他车型", vehicle: { registrationMonth: "2020-08", vehicleClass: "other", usageNature: "non_operational", seats: 5 } },
    { label: "车型未知", vehicle: { registrationMonth: "2020-08", vehicleClass: "unknown", usageNature: "non_operational", seats: 5 } },
    { label: "营运", vehicle: { registrationMonth: "2020-08", vehicleClass: "small_micro_passenger", usageNature: "operational", seats: 5 } },
    { label: "用途未知", vehicle: { registrationMonth: "2020-08", vehicleClass: "small_micro_passenger", usageNature: "unknown", seats: 5 } },
    { label: "10座", vehicle: { registrationMonth: "2020-08", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 10 } },
    { label: "座位未知", vehicle: { registrationMonth: "2020-08", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: null } },
    { label: "档案标记面包车", vehicle: { registrationMonth: "2020-08", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5, knownIsVan: true } },
  ];

  for (const item of cases) {
    const result = calculateInspection(standardInput({ vehicle: item.vehicle }));
    assert.equal(result.action, "official_verification", item.label);
    assert.equal(result.windowStatus, "manual_review", item.label);
    assert.equal(result.estimatedDueDate, null, item.label);
    assert.ok(result.manualReviewReasons.length > 0, item.label);
    assert.deepEqual(result.evidence.steps.map((step) => step.id), ["scope"], item.label);
    assert.equal(result.dateEvidence.estimate, null, item.label);
  }
});

test("每项特殊情况回答“是”或“不清楚”均安全降级", () => {
  for (const key of Object.keys(allNoDeclarations) as Array<keyof InspectionDeclarations>) {
    for (const answer of ["yes", "unknown"] as const) {
      const declarations = { ...allNoDeclarations, [key]: answer };
      const result = calculateInspection(standardInput({ declarations }));
      assert.equal(result.action, "official_verification", `${key}:${answer}`);
      assert.equal(result.windowStatus, "manual_review", `${key}:${answer}`);
      assert.equal(result.cycleYear, null, `${key}:${answer}`);
      assert.ok(result.manualReviewReasons.length > 0, `${key}:${answer}`);
    }
  }
});

test("规则函数拒绝无效或未来注册月份", () => {
  assert.throws(
    () => calculateInspection(standardInput({ vehicle: { registrationMonth: "2026-13", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5 } })),
    /YYYY-MM/,
  );
  assert.throws(
    () => calculateInspection(standardInput({ vehicle: { registrationMonth: "2026-09", vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5 } })),
    /future/,
  );
});

test("POST /api/inspection/calculations 返回统一契约且临时测算不落库", async () => {
  const { app, database, close } = await fixture();
  try {
    const beforeCount = Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM vehicles").get())?.count);
    const response = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: {
        source: "temporary",
        vehicle: {
          registrationMonth: "2026-08",
          vehicleClass: "small_micro_passenger",
          usageNature: "non_operational",
          seats: 5,
        },
        declarations: allNoDeclarations,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<Json>().data;
    assert.equal(result.action, "claim_mark");
    assert.equal(result.windowStatus, "not_open");
    assert.equal(result.estimatedDueDate, "2032-08-31");
    assert.deepEqual(result.applicationWindow, { start: "2032-06-01", end: "2032-08-31" });
    assert.ok(result.policy.sources.length >= 8);
    assert.equal(typeof result.policy.sources[0].id, "string");
    assert.equal(typeof result.policy.sources[0].title, "string");
    assert.match(result.policy.sources[0].url, /^https:\/\//);
    assert.ok(Array.isArray(result.reasons));

    const conflictResponse = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: {
        source: "temporary",
        vehicle: {
          registrationMonth: "2020-08",
          vehicleClass: "small_micro_passenger",
          usageNature: "non_operational",
          seats: 5,
          powertrainType: "hev",
        },
        inspectionValidity: {
          mode: "confirmed",
          validThroughMonth: "2026-09",
          source: "paper_driving_license",
        },
        declarations: allNoDeclarations,
      },
    });
    assert.equal(conflictResponse.statusCode, 200, conflictResponse.body);
    const conflict = conflictResponse.json<Json>().data;
    assert.equal(conflict.evidence.powertrainImpact.powertrainType, "hybrid");
    assert.equal(conflict.dateEvidence.comparison, "note");
    assert.equal(conflict.dateEvidence.decisionBasis, "confirmed_priority");
    assert.equal(conflict.canBookInspection, true);
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM vehicles").get())?.count), beforeCount);
  } finally {
    await close();
  }
});

test("车辆模式与相同事实的临时模式结果一致", async () => {
  const { app, database, close } = await fixture();
  try {
    const vehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];
    const beforeCount = Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM vehicles").get())?.count);
    const vehicleResponse = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: { source: "vehicle", vehicleId: vehicle.id, declarations: allNoDeclarations },
    });
    const temporaryResponse = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: {
        source: "temporary",
        vehicle: {
          registrationMonth: vehicle.registrationDate.slice(0, 7),
          vehicleClass: "small_micro_passenger",
          usageNature: "non_operational",
          seats: vehicle.seats,
        },
        declarations: allNoDeclarations,
      },
    });
    assert.equal(vehicleResponse.statusCode, 200, vehicleResponse.body);
    assert.equal(temporaryResponse.statusCode, 200, temporaryResponse.body);
    const fromVehicle = vehicleResponse.json<Json>().data;
    const temporary = temporaryResponse.json<Json>().data;
    for (const key of ["action", "windowStatus", "estimatedDueDate", "applicationWindow", "cycleYear", "canBookInspection", "title", "summary", "reasons"]) {
      assert.deepEqual(fromVehicle[key], temporary[key], key);
    }
    assert.equal(fromVehicle.source, "vehicle");
    assert.equal(temporary.source, "temporary");
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM vehicles").get())?.count), beforeCount);
  } finally {
    await close();
  }
});

test("计算接口统一校验错误并将合法非标准车辆返回 manual_review", async () => {
  const { app, close } = await fixture();
  try {
    for (const registrationMonth of ["2026-13", "2027-01"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/inspection/calculations",
        payload: {
          source: "temporary",
          vehicle: { registrationMonth, vehicleClass: "small_micro_passenger", usageNature: "non_operational", seats: 5 },
          declarations: allNoDeclarations,
        },
      });
      assert.equal(response.statusCode, 400, registrationMonth);
      assert.equal(response.json<Json>().error.code, "VALIDATION_ERROR", registrationMonth);
    }

    const manual = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: {
        source: "temporary",
        vehicle: { registrationMonth: "2020-08", vehicleClass: "other", usageNature: "operational", seats: 12 },
        declarations: allNoDeclarations,
      },
    });
    assert.equal(manual.statusCode, 200, manual.body);
    assert.equal(manual.json<Json>().data.windowStatus, "manual_review");
    assert.equal(manual.json<Json>().data.action, "official_verification");
  } finally {
    await close();
  }
});

test("旧状态接口保留字段但未确认日期不能开放预约或倒计时", async () => {
  const { app, database, close } = await fixture();
  try {
    const vehicle = (await app.inject({ method: "GET", url: "/api/vehicles" })).json<Json>().data[0];

    await database.prepare("UPDATE vehicles SET inspection_due_date = ? WHERE id = ?").run("2026-11-01", vehicle.id);
    const unverified = (await app.inject({ method: "GET", url: `/api/inspection/status/${vehicle.id}` })).json<Json>().data;
    assert.equal(unverified.inspectionDueDate, "2026-11-01");
    assert.equal(unverified.inspectionValidity.mode, "unconfirmed");
    assert.equal(unverified.eligibility, "manual_review");
    assert.equal(unverified.applicationWindow, null);
    assert.equal(unverified.dueDays, null);
    assert.equal(unverified.canBook, false);

    await database.prepare("UPDATE vehicles SET registration_date = ? WHERE id = ?").run("2020-08-01", vehicle.id);
    const previousDemoDate = process.env.YUXIAOMAN_DEMO_DATE;
    process.env.YUXIAOMAN_DEMO_DATE = "2026-09-01";
    try {
      const overdueUnverified = (await app.inject({ method: "GET", url: `/api/inspection/status/${vehicle.id}` })).json<Json>().data;
      assert.equal(overdueUnverified.inspectionValidity.mode, "unconfirmed");
      assert.equal(overdueUnverified.eligibility, "eligible");
      assert.equal(overdueUnverified.canBook, true);
      assert.match(overdueUnverified.title, /仍可预约上线检验|规则估算有效期/);
    } finally {
      if (previousDemoDate === undefined) delete process.env.YUXIAOMAN_DEMO_DATE;
      else process.env.YUXIAOMAN_DEMO_DATE = previousDemoDate;
    }
    assert.match(unverified.dateEvidence.estimate?.dueDate || "", /^\d{4}-\d{2}-\d{2}$/);

    await database.prepare(`
      UPDATE vehicles
      SET inspection_due_date = ?, inspection_due_date_source = ?, inspection_due_date_confirmed_at = ?
      WHERE id = ?
    `).run("2026-08-31", "traffic_12123", "2026-08-11T00:00:00.000Z", vehicle.id);
    const inWindow = (await app.inject({ method: "GET", url: `/api/inspection/status/${vehicle.id}` })).json<Json>().data;
    assert.equal(inWindow.eligibility, "eligible");
    assert.equal(inWindow.canBook, true);
    assert.ok(inWindow.materials.length >= 4);
    assert.equal(typeof inWindow.dueDays, "number");
    assert.deepEqual(inWindow.applicationWindow, { start: "2026-06-01", end: "2026-08-31" });
    assert.equal(inWindow.dateEvidence.comparison, "matched");

    await database.prepare("UPDATE vehicles SET inspection_due_date = ? WHERE id = ?").run("2026-09-30", vehicle.id);
    const softNote = (await app.inject({ method: "GET", url: `/api/inspection/status/${vehicle.id}` })).json<Json>().data;
    assert.equal(softNote.dateEvidence.comparison, "note");
    assert.equal(softNote.dateEvidence.decisionBasis, "confirmed_priority");
    // 确认优先：按确认月末窗口判断，不再因与规则估算月不一致硬拦。
    assert.equal(softNote.canBook, softNote.eligibility === "eligible");
    assert.notEqual(softNote.eligibility, "manual_review");
  } finally {
    await close();
  }
});

test("车辆有效期来源可确认、清除，旧平铺日期保持未核验", async () => {
  const { app, database, close } = await fixture();
  try {
    const confirmedResponse = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: {
        plateNumber: "津B·T8801",
        registrationDate: "2020-08-01",
        powertrainType: "hev",
        inspectionValidity: {
          mode: "confirmed",
          validThroughMonth: "2026-08",
          source: "traffic_12123",
        },
      },
    });
    assert.equal(confirmedResponse.statusCode, 201, confirmedResponse.body);
    const confirmed = confirmedResponse.json<Json>().data;
    assert.equal(confirmed.powertrainType, "hybrid");
    assert.equal(confirmed.inspectionDueDate, "2026-08-31");
    assert.equal(confirmed.inspectionDueDateSource, "traffic_12123");
    assert.deepEqual(
      { ...confirmed.inspectionValidity, confirmedAt: undefined },
      { mode: "confirmed", validThroughMonth: "2026-08", source: "traffic_12123", confirmedAt: undefined },
    );
    assert.equal(typeof confirmed.inspectionValidity.confirmedAt, "string");

    const originalConfirmedAt = "2026-08-01T09:30:00.000Z";
    await database.prepare("UPDATE vehicles SET inspection_due_date_confirmed_at = ? WHERE id = ?")
      .run(originalConfirmedAt, confirmed.id);
    const unrelatedPatch = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${confirmed.id}`,
      payload: {
        seats: 5,
        inspectionValidity: {
          mode: "confirmed",
          validThroughMonth: "2026-08",
          source: "traffic_12123",
        },
      },
    });
    assert.equal(unrelatedPatch.statusCode, 200, unrelatedPatch.body);
    assert.equal(unrelatedPatch.json<Json>().data.inspectionValidity.confirmedAt, originalConfirmedAt);

    const calculated = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: { source: "vehicle", vehicleId: confirmed.id, declarations: allNoDeclarations },
    });
    assert.equal(calculated.statusCode, 200, calculated.body);
    assert.equal(calculated.json<Json>().data.dateEvidence.comparison, "matched");
    assert.equal(calculated.json<Json>().data.canBookInspection, true);
    const validQuote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: confirmed.id, stationId: "station-hexi-1", serviceMode: "self_drive" },
    });
    assert.equal(validQuote.statusCode, 200, validQuote.body);

    const softNotePatch = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${confirmed.id}`,
      payload: {
        inspectionValidity: {
          mode: "confirmed",
          validThroughMonth: "2026-09",
          source: "electronic_driving_license",
        },
      },
    });
    assert.equal(softNotePatch.statusCode, 200, softNotePatch.body);
    const softNoteCalc = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: { source: "vehicle", vehicleId: confirmed.id, declarations: allNoDeclarations },
    });
    assert.equal(softNoteCalc.statusCode, 200, softNoteCalc.body);
    assert.equal(softNoteCalc.json<Json>().data.dateEvidence.comparison, "note");
    assert.equal(softNoteCalc.json<Json>().data.canBookInspection, true);
    const softNoteQuote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: confirmed.id, stationId: "station-hexi-1", serviceMode: "self_drive" },
    });
    assert.equal(softNoteQuote.statusCode, 200, softNoteQuote.body);

    const hardConflictPatch = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${confirmed.id}`,
      payload: {
        inspectionValidity: {
          mode: "confirmed",
          validThroughMonth: "2020-09",
          source: "paper_driving_license",
        },
      },
    });
    assert.equal(hardConflictPatch.statusCode, 200, hardConflictPatch.body);
    const blockedQuote = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: confirmed.id, stationId: "station-hexi-1", serviceMode: "self_drive" },
    });
    assert.equal(blockedQuote.statusCode, 409, blockedQuote.body);
    assert.equal(blockedQuote.json<Json>().error.code, "INSPECTION_VALIDITY_EXPIRED");
    const slots = (await app.inject({ method: "GET", url: "/api/stations/station-hexi-1/slots" })).json<Json>().data;
    const blockedBooking = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: {
        vehicleId: confirmed.id,
        stationId: "station-hexi-1",
        slotId: slots[0].id,
        contactName: "核验用户",
        contactPhone: "13800138000",
        serviceMode: "self_drive",
        quoteSnapshotId: validQuote.json<Json>().data.quoteSnapshotId,
        mediaIds: [],
      },
    });
    assert.equal(blockedBooking.statusCode, 409, blockedBooking.body);
    assert.equal(blockedBooking.json<Json>().error.code, "INSPECTION_VALIDITY_EXPIRED");

    const clearedResponse = await app.inject({
      method: "PATCH",
      url: `/api/vehicles/${confirmed.id}`,
      payload: { inspectionValidity: { mode: "unconfirmed" } },
    });
    assert.equal(clearedResponse.statusCode, 200, clearedResponse.body);
    const cleared = clearedResponse.json<Json>().data;
    assert.equal(cleared.inspectionValidity.mode, "unconfirmed");
    assert.equal(cleared.inspectionDueDateSource, "internal_placeholder");
    assert.equal(cleared.inspectionDueDateConfirmedAt, null);

    const legacyResponse = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: {
        plateNumber: "津B·T8802",
        registrationDate: "2020-08-01",
        inspectionDueDate: "2026-08-31",
      },
    });
    assert.equal(legacyResponse.statusCode, 201, legacyResponse.body);
    const legacy = legacyResponse.json<Json>().data;
    assert.equal(legacy.inspectionDueDateSource, "legacy_unverified");
    assert.equal(legacy.inspectionValidity.mode, "unconfirmed");
    assert.equal(
      String((await database.prepare<Json>("SELECT inspection_due_date_source FROM vehicles WHERE id = ?").get(legacy.id))?.inspection_due_date_source),
      "legacy_unverified",
    );
  } finally {
    await close();
  }
});

test("HEV 兼容输入命中燃油方案且内燃机项目与新能源项目不混淆", async () => {
  const { app, close } = await fixture();
  try {
    const stations = (await app.inject({ method: "GET", url: "/api/stations" })).json<Json>().data;
    const station = stations.find((item: Json) => item.id === "station-hexi-1");
    const vehicleResponse = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: {
        plateNumber: "津B·H8803",
        registrationDate: "2020-08-01",
        powertrainType: "hev",
      },
    });
    assert.equal(vehicleResponse.statusCode, 201, vehicleResponse.body);
    const vehicle = vehicleResponse.json<Json>().data;
    assert.equal(vehicle.powertrainType, "hybrid");

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/api/bookings/quote",
      payload: { vehicleId: vehicle.id, stationId: station.id, serviceMode: "self_drive" },
    });
    assert.equal(quoteResponse.statusCode, 200, quoteResponse.body);
    const quote = quoteResponse.json<Json>().data;
    assert.equal(quote.pricingEligibility, "supported");
    assert.equal(quote.matchedPricePlan.id, INSPECTION_PRICE_PLAN_IDS.smallIce);
    assert.deepEqual(quote.inspectionItems, ["safety_basic", "emissions_gasoline"]);
  } finally {
    await close();
  }
});

test("绿色 F 号牌在缺少动力档案时不猜测 PHEV 或 EREV", async () => {
  const { app, close } = await fixture();
  try {
    const vehicleResponse = await app.inject({
      method: "POST",
      url: "/api/vehicles",
      payload: {
        plateNumber: "津A·F88004",
        registrationDate: "2020-08-01",
      },
    });
    assert.equal(vehicleResponse.statusCode, 201, vehicleResponse.body);
    const vehicle = vehicleResponse.json<Json>().data;
    assert.equal(vehicle.energyCategory, "none");
    assert.equal(vehicle.facts.powertrainType, "unknown");
    assert.equal(vehicle.facts.powertrainSource, "unknown");
    assert.deepEqual(vehicle.facts.factsConsistencyFailures, []);

    const calculationResponse = await app.inject({
      method: "POST",
      url: "/api/inspection/calculations",
      payload: { source: "vehicle", vehicleId: vehicle.id, declarations: allNoDeclarations },
    });
    assert.equal(calculationResponse.statusCode, 200, calculationResponse.body);
    const calculation = calculationResponse.json<Json>().data;
    assert.equal(calculation.cycleYear, 6);
    assert.equal(calculation.evidence.powertrainImpact.powertrainType, "unknown");
    assert.equal(calculation.evidence.powertrainImpact.status, "needs_verification");
    assert.deepEqual(calculation.evidence.powertrainImpact.expectedOnsiteCheckCodes, []);
    assert.match(calculation.evidence.powertrainImpact.explanation, /具体上线项目需由检测站确认/);
  } finally {
    await close();
  }
});

test("PostgreSQL fresh seed 包含 hybrid 且重复 schema migration 不覆盖运营配置", async () => {
  const database = await createTestDatabase("inspection_migration");
  try {
    const seededSmall = await database.prepare<Json>(
      "SELECT * FROM inspection_price_plans WHERE id = ?",
    ).get(INSPECTION_PRICE_PLAN_IDS.smallIce);
    const seededPassenger = await database.prepare<Json>(
      "SELECT * FROM inspection_price_plans WHERE id = ?",
    ).get(INSPECTION_PRICE_PLAN_IDS.passengerCombustion);
    assert.ok(seededSmall);
    assert.ok(seededPassenger);
    assert.ok(JSON.parse(String(seededSmall.powertrain_types_json)).includes("hybrid"));
    assert.ok(JSON.parse(String(seededPassenger.powertrain_types_json)).includes("hybrid"));

    await database.prepare(`
      UPDATE inspection_price_plans
      SET name = ?, description = ?, powertrain_types_json = ?
      WHERE id = ?
    `).run("自定义燃油方案", "站点自定义说明", JSON.stringify(["diesel"]), INSPECTION_PRICE_PLAN_IDS.smallIce);
    await database.prepare(`
      UPDATE inspection_price_plans SET powertrain_types_json = ? WHERE id = ?
    `).run(JSON.stringify(["gasoline", "phev"]), INSPECTION_PRICE_PLAN_IDS.passengerCombustion);

    await migrateDatabase(database);
    await migrateDatabase(database);

    const small = await database.prepare<Json>("SELECT * FROM inspection_price_plans WHERE id = ?").get(INSPECTION_PRICE_PLAN_IDS.smallIce);
    assert.ok(small);
    assert.equal(small.name, "自定义燃油方案");
    assert.equal(small.description, "站点自定义说明");
    assert.deepEqual(JSON.parse(String(small.powertrain_types_json)), ["diesel"]);
    const passenger = await database.prepare<Json>("SELECT * FROM inspection_price_plans WHERE id = ?").get(INSPECTION_PRICE_PLAN_IDS.passengerCombustion);
    assert.ok(passenger);
    assert.deepEqual(JSON.parse(String(passenger.powertrain_types_json)), ["gasoline", "phev"]);
  } finally {
    await database.close();
  }
});
