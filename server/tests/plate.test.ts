import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AGENCY_LETTERS,
  PROVINCE_ABBREVIATIONS,
  formatPlate,
  normalizePlate,
  parsePlate,
  validatePlate,
} from "../../src/domain/plate.js";

describe("plate domain", () => {
  test("包含 31 个不重复省级简称和排除 I/O 的发牌机关代码", () => {
    assert.equal(PROVINCE_ABBREVIATIONS.length, 31);
    assert.equal(new Set(PROVINCE_ABBREVIATIONS).size, 31);
    assert.deepEqual(
      [...PROVINCE_ABBREVIATIONS].sort(),
      [..."京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼"].sort(),
    );
    assert.equal(AGENCY_LETTERS.length, 24);
    assert.equal(AGENCY_LETTERS.includes("I" as never), false);
    assert.equal(AGENCY_LETTERS.includes("O" as never), false);
  });

  test("规范化大小写、全角字符、空白和常见分隔符", () => {
    assert.equal(normalizePlate("  津 ａ · ｍｖｐ２６  "), "津AMVP26");
    assert.equal(normalizePlate("津a-MVP26"), "津AMVP26");
    assert.equal(formatPlate("津aMVP26"), "津A·MVP26");
  });

  test("解析蓝牌 5 位序号", () => {
    const parsed = parsePlate("津A·MVP26");
    assert.deepEqual(parsed, {
      valid: true,
      normalized: "津AMVP26",
      formatted: "津A·MVP26",
      plateKind: "blue",
      province: "津",
      agencyCode: "A",
      serial: "MVP26",
      energyCategory: "none",
    });
    assert.equal(validatePlate("津A·MVP26"), true);
  });

  test("解析小型新能源 D/F 首位号牌", () => {
    assert.deepEqual(parsePlate("津A·D12345"), {
      valid: true,
      normalized: "津AD12345",
      formatted: "津A·D12345",
      plateKind: "green_small",
      province: "津",
      agencyCode: "A",
      serial: "D12345",
      energyCategory: "pure_electric",
    });

    const hybrid = parsePlate("粤B·FA1234");
    assert.equal(hybrid.valid, true);
    if (hybrid.valid) {
      assert.equal(hybrid.plateKind, "green_small");
      assert.equal(hybrid.energyCategory, "non_pure_electric");
    }
  });

  test("解析各地实际 8 位绿牌序号（不要求 D/F 首位）", () => {
    const tianjin = parsePlate("津AB93080");
    assert.deepEqual(tianjin, {
      valid: true,
      normalized: "津AB93080",
      formatted: "津A·B93080",
      plateKind: "green_small",
      province: "津",
      agencyCode: "A",
      serial: "B93080",
      energyCategory: "none",
    });

    assert.equal(validatePlate("津AB93080"), true);
    assert.equal(validatePlate("津A·B93080"), true);
    assert.equal(validatePlate("津BD12345"), true);
    assert.equal(validatePlate("津ADB1234"), true);
  });

  test("解析大型新能源 5 位数字加 D/F 号牌", () => {
    const electric = parsePlate("沪A·12345D");
    assert.equal(electric.valid, true);
    if (electric.valid) {
      assert.equal(electric.plateKind, "green_large");
      assert.equal(electric.energyCategory, "pure_electric");
      assert.equal(electric.serial, "12345D");
    }

    const hybrid = parsePlate("京A54321F");
    assert.equal(hybrid.valid, true);
    if (hybrid.valid) assert.equal(hybrid.energyCategory, "non_pure_electric");
  });

  test("所有省简称均可解析", () => {
    for (const province of PROVINCE_ABBREVIATIONS) {
      assert.equal(validatePlate(`${province}A12345`), true, province);
    }
  });

  test("拒绝无效省份、I/O 和错误长度", () => {
    const cases = [
      ["ABC", "invalid_length"],
      ["港A12345", "invalid_province"],
      ["津I12345", "invalid_agency_code"],
      ["津O12345", "invalid_agency_code"],
      ["津AI2345", "invalid_serial"],
      ["津AO2345", "invalid_serial"],
      ["津A1234", "invalid_length"],
      ["津ADI1234", "invalid_serial"],
      ["津A12345I", "invalid_serial"],
    ] as const;

    for (const [value, reason] of cases) {
      const parsed = parsePlate(value);
      assert.equal(parsed.valid, false, value);
      if (!parsed.valid) assert.equal(parsed.reason, reason, value);
      assert.equal(validatePlate(value), false, value);
    }
  });
});

