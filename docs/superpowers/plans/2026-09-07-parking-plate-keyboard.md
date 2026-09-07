# 停车场式车牌键盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在微信小程序「添加/编辑车辆」页用分段格子 + 自定义键盘替换自由文本车牌输入，并按 11 类号牌类型切换 7/8 位与配色。

**Architecture:** 纯函数布局工具 `plate-keyboard-layout.ts` 负责位数、字符规范化、键盘键位；独立组件 `plate-keyboard` 管格子/焦点/底部键盘；`vehicle-form` 只传 `plateKind`/`slotCount`/`value`/`disabled` 并监听 `change`。换类型时表单清空 `plateNumber`。

**Tech Stack:** 微信小程序原生组件、现有 `plate-categories.ts`、Node `tsx --test` 源码/行为断言。

---

## File map

| File | Responsibility |
|------|----------------|
| `wechat-miniprogram/miniprogram/utils/plate-keyboard-layout.ts` | `plateSlotCount`、规范化、格式化、按焦点返回键位 |
| `wechat-miniprogram/miniprogram/components/plate-keyboard/*` | 格子 UI + 底部键盘 + `change`/`complete` 事件 |
| `wechat-miniprogram/miniprogram/packages/vehicle/pages/vehicle-form/*` | 接入组件；换类型清空；满格才 `plateComplete` |
| `wechat-miniprogram/tests/plate-keyboard-layout.test.ts` | 布局纯函数单测 |
| `wechat-miniprogram/tests/plate-categories.test.ts` | 改用键盘事件；断言换类型清空 |
| `wechat-miniprogram/tests/booking-upload-state.test.ts` | 断言格子/键盘组件，不再断言自由 input |

---

### Task 1: 布局纯函数 + 单测

**Files:**
- Create: `wechat-miniprogram/miniprogram/utils/plate-keyboard-layout.ts`
- Create: `wechat-miniprogram/tests/plate-keyboard-layout.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPlateNumber,
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
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd wechat-miniprogram && node ../node_modules/tsx/dist/cli.mjs --test tests/plate-keyboard-layout.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 layout**

```ts
import type { PlateStyle } from "./plate-categories";

export const PLATE_PROVINCES = "京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼".split("");
export const PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ".split("");
export const PLATE_DIGITS = "0123456789".split("");
export const PLATE_SPECIALS = ["挂", "学", "警", "港", "澳", "领", "使"];

export function plateSlotCount(kind: PlateStyle): 7 | 8 {
  return kind === "green_small" || kind === "green_large" ? 8 : 7;
}

export function normalizePlateChars(value: string): string {
  return value.normalize("NFKC").replace(/[\s·•・.\-]/gu, "").replace(/[a-z]/g, (c) => c.toUpperCase());
}

export function formatPlateNumber(chars: string): string {
  const normalized = normalizePlateChars(chars);
  if (normalized.length <= 2) return normalized;
  return `${normalized.slice(0, 2)}·${normalized.slice(2)}`;
}

export function keyboardKeysForFocus(focusIndex: number): string[] {
  if (focusIndex <= 0) return [...PLATE_PROVINCES];
  if (focusIndex === 1) return [...PLATE_LETTERS];
  return [...PLATE_DIGITS, ...PLATE_LETTERS, ...PLATE_SPECIALS];
}

export function charsToSlots(value: string, slotCount: number): string[] {
  const chars = normalizePlateChars(value).slice(0, slotCount).split("");
  while (chars.length < slotCount) chars.push("");
  return chars;
}

export function slotsToValue(slots: string[]): string {
  return formatPlateNumber(slots.join(""));
}
```

- [ ] **Step 4: 再跑测，期望 PASS**

- [ ] **Step 5: Commit**（仅当用户要求提交时执行）

---

### Task 2: `plate-keyboard` 组件

**Files:**
- Create: `wechat-miniprogram/miniprogram/components/plate-keyboard/plate-keyboard.json`
- Create: `wechat-miniprogram/miniprogram/components/plate-keyboard/plate-keyboard.ts`
- Create: `wechat-miniprogram/miniprogram/components/plate-keyboard/plate-keyboard.wxml`
- Create: `wechat-miniprogram/miniprogram/components/plate-keyboard/plate-keyboard.wxss`

- [ ] **Step 1: json**

```json
{ "component": true }
```

- [ ] **Step 2: 组件逻辑要点**

Properties: `plateKind` (String), `slotCount` (Number, 7), `value` (String), `disabled` (Boolean)。  
Data: `slots`, `focusIndex`, `keyboardOpen`, `keys`, `showDotAfter` (=1，第 2 格后画 `·`)。  
Observers: `value,slotCount` → 重算 slots；`disabled` true 时关键盘。  
Methods:
- `openKeyboard` / `tapCell`：未 disabled 时开键盘，设 focus
- `tapKey`：写入当前格，焦点右移；满格 trigger `change` + `complete`
- `tapDelete`：清空当前格或回退
- `closeKeyboard`
- 每次改 slots 用 `slotsToValue` 触发 `change`：`{ value, complete: boolean }`

- [ ] **Step 3: wxml** — `plate-cells` 格子行 + `wx:if` 底部 `plate-keyboard-sheet`（省/字母数字键 + 删除 + 完成）

- [ ] **Step 4: wxss** — blue/yellow/green 配色；键盘固定底部；禁用态半透明

---

### Task 3: 接入 `vehicle-form`

**Files:**
- Modify: `vehicle-form.json` — `usingComponents.plate-keyboard`
- Modify: `vehicle-form.wxml` — 替换 `plate-free-input`
- Modify: `vehicle-form.ts` — `slotCount`、换类型清空、`onPlateKeyboardChange`
- Modify: `vehicle-form.wxss` — 去掉 free-input 样式（或保留无害）

- [ ] **Step 1: json**

```json
{
  "navigationBarTitleText": "添加车辆",
  "usingComponents": {
    "plate-keyboard": "/components/plate-keyboard/plate-keyboard"
  }
}
```

- [ ] **Step 2: wxml 车牌区**

```xml
<view class="surface plate-card {{mode === 'yellow' ? 'yellow' : mode === 'blue' ? 'blue' : 'green'}}">
  <view class="plate-heading">
    <view>
      <text>车牌号码</text>
      <text>{{plateCategoryConfirmed ? (mode === 'green_small' || mode === 'green_large' ? '新能源 8 位，点格输入' : '7 位，点格输入') : '请先选择号牌类型'}}</text>
    </view>
  </view>
  <plate-keyboard
    plateKind="{{mode}}"
    slotCount="{{slotCount}}"
    value="{{plateNumber}}"
    disabled="{{!plateCategoryConfirmed}}"
    bind:change="onPlateKeyboardChange"
  />
  <view class="plate-status {{plateComplete ? 'complete' : ''}}">
    ...
    <text>{{plateComplete ? '车牌号码可保存' : (plateCategoryConfirmed ? '请将格子填满' : '请先选择号牌类型')}}</text>
  </view>
</view>
```

- [ ] **Step 3: ts**

- data 增加 `slotCount: 7`
- `categoryChange`：`plateNumber: ""`, `plateComplete: false`, `slotCount: plateSlotCount(mode)`
- 新建/编辑 `onLoad` 设置 `slotCount`
- 编辑加载：`plateComplete` = `normalizePlateChars(plate).length === slotCount && isPlateInputSafe(...)`
- 替换 `plateNumberInput` 为：

```ts
onPlateKeyboardChange(event) {
  const plateNumber = String(event.detail.value || "");
  const complete = Boolean(event.detail.complete);
  this.setData({
    plateNumber,
    plateComplete: complete && isPlateInputSafe(plateNumber),
  });
}
```

- 保留 `plateNumberInput` 薄封装调用同一逻辑，或测试改为调 `onPlateKeyboardChange`（推荐后者）

- [ ] **Step 4: submit** 增加：若未 `plateComplete` 则 toast「请将车牌填完整」

---

### Task 4: 更新现有测试

**Files:**
- Modify: `wechat-miniprogram/tests/booking-upload-state.test.ts`（约 718–727）
- Modify: `wechat-miniprogram/tests/plate-categories.test.ts`
- Optionally add layout test to `package.json` `test:vehicle-catalog` script

- [ ] **Step 1: booking 断言改为**

```ts
assert.match(vehicleMarkup, /plate-keyboard/);
assert.match(vehicleMarkup, /plate-cells|slotCount|bind:change="onPlateKeyboardChange"/);
assert.doesNotMatch(vehicleMarkup, /plate-free-input|按实际号牌自由填写/);
```

- [ ] **Step 2: plate-categories 测试**

- 用满格号牌：蓝/黄 7 字、绿 8 字（如 `津A12345` / `津AD12345`）
- `onPlateKeyboardChange({ detail: { value, complete: true } })`
- **换类型必须清空**：`categoryChange` 后 `plateNumber === ""` 且 `plateComplete === false`
- 不安全字符仍可通过直接 setData + submit 测 toast（或 change 带不安全值）

- [ ] **Step 3: 跑测**

```bash
cd wechat-miniprogram
node ../node_modules/tsx/dist/cli.mjs --test tests/plate-keyboard-layout.test.ts tests/plate-categories.test.ts tests/booking-upload-state.test.ts
npm run typecheck
```

Expected: 全部 PASS

---

## Spec coverage checklist

| Spec | Task |
|------|------|
| 11 类 → 7/8 位 + 配色 | 1 + 3 |
| 换类型清空 | 3 |
| 挂自由输入 | 1 keys + 2 键盘 |
| 独立组件 | 2 |
| 编辑拆格/截断 | 2 charsToSlots |
| 更新 booking/plate 测试 | 4 |
| 不做 D/F 强制 | 不写限制 |

## Execution

推荐本会话 **Inline Execution**（功能边界清晰、文件集中）。
