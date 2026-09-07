import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPlateNumber,
  isPlateSlotsComplete,
  keyboardKeysForFocus,
  normalizePlateChars,
  plateSlotCount,
} from "../miniprogram/utils/plate-keyboard-layout";

test("blue/yellow 7 位，新能源 8 位", () => {
  assert.equal(plateSlotCount("blue"), 7);
  assert.equal(plateSlotCount("yellow"), 7);
  assert.equal(plateSlotCount("green_small"), 8);
  assert.equal(plateSlotCount("green_large"), 8);
});

test("规范化去掉分隔符并大写字母", () => {
  assert.equal(normalizePlateChars("津a·12345"), "津A12345");
});

test("格式化为省后加点号", () => {
  assert.equal(formatPlateNumber("津A12345"), "津A·12345");
  assert.equal(formatPlateNumber("津"), "津");
});

test("焦点 0 为省份，焦点 1 为字母，后续含数字与挂", () => {
  const provinces = keyboardKeysForFocus(0);
  assert.ok(provinces.includes("津"));
  assert.ok(!provinces.includes("1"));
  const letters = keyboardKeysForFocus(1);
  assert.ok(letters.includes("A"));
  assert.ok(!letters.includes("1"));
  const rest = keyboardKeysForFocus(2);
  assert.ok(rest.includes("1") && rest.includes("A") && rest.includes("挂"));
});

test("满格判定按规范化长度", () => {
  assert.equal(isPlateSlotsComplete("津A·12345", 7), true);
  assert.equal(isPlateSlotsComplete("津A·1234", 7), false);
  assert.equal(isPlateSlotsComplete("津AD12345", 8), true);
});
