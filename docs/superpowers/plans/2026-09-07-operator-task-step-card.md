# 检测站本步任务卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在检测站「检测任务」详情页用「本步任务卡」替换五格流程条，并为主按钮提供动作文案与防误点说明，让管理员一眼知道当前步骤与按钮意义。

**Architecture:** 抽出纯函数 `buildOperatorTaskCard(booking)`（可单测）按 `status` / `serviceMode` / `fulfillmentStatus` 生成卡片字段；`operator-detail` 用其替换 `processSteps` 渲染；主按钮文案与 `primaryHint` 来自同一映射，不改 `data-action` API。

**Tech Stack:** 微信小程序原生 WXML/WXSS/TS、`tsx --test` 表驱动单测、既有 `Booking` 类型。

**Spec:** `docs/superpowers/specs/2026-09-07-operator-task-step-card-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `wechat-miniprogram/miniprogram/utils/operator-task-card.ts` | `OperatorTaskCard` 类型 + `buildOperatorTaskCard(booking)` 映射 |
| `wechat-miniprogram/tests/operator-task-card.test.ts` | 表驱动单测（关键三步 + confirmed/on_hold/completed 等） |
| `wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.ts` | 接入卡片；去掉对页面五格 `processSteps` 的依赖 |
| `wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.wxml` | 任务卡 UI；主按钮文案/灰字；删除 `process-steps` |
| `wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.wxss` | 任务卡与 `primary-hint` 样式；清理无用五格样式 |
| `wechat-miniprogram/tests/booking-upload-state.test.ts` | 更新对 `currentStepIndex` / 流程 UI 的源码断言，改为断言任务卡 |

---

### Task 1: `buildOperatorTaskCard` 纯函数 + 失败测试

**Files:**
- Create: `wechat-miniprogram/miniprogram/utils/operator-task-card.ts`
- Create: `wechat-miniprogram/tests/operator-task-card.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd wechat-miniprogram && npm run typecheck 2>/dev/null; node ../node_modules/tsx/dist/cli.mjs --test tests/operator-task-card.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `operator-task-card.ts`**

```ts
import type { Booking } from "../types";

export type OperatorTaskCard = {
  stepIndex: number;
  stepTotal: 5;
  title: string;
  instruction: string;
  nextLabel: string;
  primaryLabel: string;
  primaryHint: string;
};

const TOTAL = 5 as const;

export function buildOperatorTaskCard(booking: Booking): OperatorTaskCard {
  const status = booking.status;
  const mode = booking.serviceMode;

  if (status === "on_hold") {
    return {
      stepIndex: 2,
      stepTotal: TOTAL,
      title: "异常挂起",
      instruction: "车辆信息不一致，现场复核完成后再恢复。",
      nextLabel: "恢复后回到挂起前步骤",
      primaryLabel: "异常已处理，恢复核验",
      primaryHint: "恢复后请继续完成当前步骤主操作",
    };
  }

  if (status === "confirmed") {
    if (mode === "valet") {
      return {
        stepIndex: 1,
        stepTotal: TOTAL,
        title: "预约确认",
        instruction: "支付已确认，等待后台安排司机。",
        nextLabel: "完成后进入：到站核验",
        primaryLabel: "",
        primaryHint: "等待司机任务下发后再继续",
      };
    }
    return {
      stepIndex: 1,
      stepTotal: TOTAL,
      title: "预约确认",
      instruction: "确认接单，等待车辆按预约到站。",
      nextLabel: "完成后进入：到站核验",
      primaryLabel: "接单并等待到站",
      primaryHint: "接单后订单进入待到站，不会自动完成核验",
    };
  }

  if (
    status === "awaiting_arrival" ||
    status === "picked_up" ||
    status === "driver_arranged"
  ) {
    return {
      stepIndex: 2,
      stepTotal: TOTAL,
      title: "到站核验",
      instruction: "核对实车车牌与预约资料，确认车辆已到站。",
      nextLabel: "完成后进入：交接检测",
      primaryLabel:
        status === "awaiting_arrival" ||
        (status === "picked_up" && booking.evidencePolicyVersion !== "valet-handoff-v1")
          ? "确认到车 · 核验通过"
          : "",
      primaryHint:
        status === "awaiting_arrival" ||
        (status === "picked_up" && booking.evidencePolicyVersion !== "valet-handoff-v1")
          ? "不等于开始检测，仅标记到站完成"
          : "请完成接车留证或等待车辆到站后再核验",
    };
  }

  if (status === "checked_in") {
    return {
      stepIndex: 3,
      stepTotal: TOTAL,
      title: "交接检测",
      instruction: "确认车辆可进入检测线，交给检测流程处理。",
      nextLabel: "完成后进入：结果回传",
      primaryLabel: "确认交接 · 开始检测",
      primaryHint: "之后请在设备侧检测，再回小程序填报告",
    };
  }

  if (status === "inspecting") {
    return {
      stepIndex: 4,
      stepTotal: TOTAL,
      title: "结果回传",
      instruction: "补齐现场照片与年检结论，生成体检报告并同步车主。",
      nextLabel: "完成后进入：服务完成",
      primaryLabel: "填写体检报告并回传",
      primaryHint: "未完成报告前，订单会停在「检测中」",
    };
  }

  if (status === "result_received") {
    const legacy = booking.fulfillmentStatus === "legacy";
    return {
      stepIndex: 4,
      stepTotal: TOTAL,
      title: "结果回传",
      instruction: legacy ? "历史遗留单需手工收尾。" : "检测结果已回传，等待服务收尾。",
      nextLabel: "完成后进入：服务完成",
      primaryLabel: legacy ? "完成历史遗留服务" : "",
      primaryHint: legacy ? "确认后订单将标记为已完成" : "请确认结果区信息",
    };
  }

  if (status === "returning") {
    return {
      stepIndex: 5,
      stepTotal: TOTAL,
      title: "服务完成",
      instruction: "车辆送回中，最终送达与留证由本单司机完成。",
      nextLabel: "本单收尾中",
      primaryLabel: "",
      primaryHint: "",
    };
  }

  if (status === "completed") {
    return {
      stepIndex: 5,
      stepTotal: TOTAL,
      title: "服务完成",
      instruction: "结果已同步给车主。",
      nextLabel: "本单已结束",
      primaryLabel: "",
      primaryHint: "",
    };
  }

  // 预检等待车主等站端暂无主操作态
  return {
    stepIndex: 1,
    stepTotal: TOTAL,
    title: "等待处理",
    instruction: "当前无站内可执行主操作，请查看时间线或刷新后再试。",
    nextLabel: "完成后进入：下一可操作步骤",
    primaryLabel: "",
    primaryHint: "",
  };
}
```

若 `Booking` 导入路径与仓库不一致，以 `miniprogram/types` 实际导出为准（`grep -r "export type Booking"`）。

- [ ] **Step 4: 跑测确认通过**

Run: `cd wechat-miniprogram && node ../node_modules/tsx/dist/cli.mjs --test tests/operator-task-card.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求提交时执行；否则跳过）

```bash
git add wechat-miniprogram/miniprogram/utils/operator-task-card.ts wechat-miniprogram/tests/operator-task-card.test.ts
git commit -m "$(cat <<'EOF'
feat: add operator task card mapping helper

EOF
)"
```

---

### Task 2: 接入 `operator-detail.ts`

**Files:**
- Modify: `wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.ts`

- [ ] **Step 1: 引入卡片并写入 `viewState` / `data`**

删除（或停用）页面内仅服务于五格 UI 的 `processSteps` / `ProcessStep` 渲染路径；保留或迁移动作逻辑。

核心改动示意：

```ts
import { buildOperatorTaskCard, type OperatorTaskCard } from "../../../../utils/operator-task-card";

type Data = {
  // ...
  taskCard: OperatorTaskCard | null;
  // 删除 processSteps: ProcessStep[]
};

function viewState(booking: Booking): Pick<Data, "booking" | "taskCard" | "verificationRows" | "mediaUrls" | "arrivalEvidence"> {
  // ...existing booking view mapping...
  return {
    booking: { /* unchanged mapping */ },
    taskCard: buildOperatorTaskCard(booking),
    verificationRows: verificationRows(booking),
    mediaUrls: media.map((item) => item.url),
    arrivalEvidence: arrivalEvidenceView(booking),
  };
}
```

`data` 初始值：`taskCard: null`。所有 `setData(viewState(...))` 路径保持不变。

删除本文件中的 `processSteps()`、`currentStepIndex()`（逻辑已由 util 覆盖）。若其他测试用正则断言旧 `currentStepIndex` 字符串，在 Task 4 一并改。

主按钮仍用现有 `wx:if` + `data-action`；**文案**改为 `{{taskCard.primaryLabel}}`（见 Task 3）。`inspecting` 的 `openCheckupEditor` 按钮同样用 `taskCard.primaryLabel`。

- [ ] **Step 2: typecheck**

Run: `cd wechat-miniprogram && npm run typecheck`  
Expected: PASS

- [ ] **Step 3: Commit**（用户要求时）

```bash
git add wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.ts
git commit -m "$(cat <<'EOF'
feat: wire operator detail to task card helper

EOF
)"
```

---

### Task 3: WXML / WXSS 替换五格为任务卡

**Files:**
- Modify: `wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.wxml`
- Modify: `wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.wxss`

- [ ] **Step 1: 替换流程区块**

将：

```xml
<view class="process-card">
  <view class="card-heading">...</view>
  <view class="process-steps">...</view>
</view>
```

替换为：

```xml
<view wx:if="{{taskCard}}" class="task-card" aria-label="本步任务 {{taskCard.title}}">
  <text class="task-card-eyebrow">本步任务 · {{taskCard.stepIndex}} / {{taskCard.stepTotal}}</text>
  <text class="task-card-title">{{taskCard.title}}</text>
  <text class="task-card-instruction">{{taskCard.instruction}}</text>
  <text class="task-card-next">{{taskCard.nextLabel}}</text>
</view>
```

- [ ] **Step 2: 主按钮文案 + hint**

在 `detail-actions` 内：

1. 各 `primary-action` 按钮内文案改为对应 `{{taskCard.primaryLabel}}`（仅在该按钮 `wx:if` 为真时卡片必有非空 label；`inspecting` 的报告按钮同理）。  
2. 在主按钮区块下方（挂起按钮之上）增加：

```xml
<text wx:if="{{taskCard.primaryHint}}" class="primary-hint">{{taskCard.primaryHint}}</text>
```

为避免多按钮时 hint 重复：hint 放在**当前可见主按钮之后、hold 按钮之前** 一处即可（与现有单一主按钮互斥结构一致）。

`confirmed` 代驾的只读提示可改为：

```xml
<view wx:if="{{booking.status === 'confirmed' && booking.serviceMode === 'valet'}}" class="complete-copy">
  <image src="/assets/icons/clock.png"/>
  <text>{{taskCard.primaryHint}}</text>
</view>
```

`inspecting` 已有 `result-action-note`，保留；`primaryHint` 仍显示在主按钮下作为短边界说明。

- [ ] **Step 3: 样式**

新增（示例，可微调间距）：

```css
.task-card {
  margin-top: 18rpx;
  padding: 28rpx 26rpx 24rpx;
  border-radius: 26rpx;
  color: #fff;
  background: #1768cf;
  box-shadow: 0 12rpx 28rpx rgba(8, 104, 223, .16);
}
.task-card-eyebrow { display: block; opacity: .85; font-size: 20rpx; font-weight: 650; }
.task-card-title { display: block; margin-top: 10rpx; font-size: 36rpx; font-weight: 800; }
.task-card-instruction { display: block; margin-top: 12rpx; font-size: 24rpx; line-height: 1.5; opacity: .95; }
.task-card-next {
  display: block;
  margin-top: 18rpx;
  padding: 14rpx 16rpx;
  border-radius: 14rpx;
  background: rgba(255, 255, 255, .16);
  font-size: 22rpx;
  line-height: 1.4;
}
.primary-hint {
  display: block;
  margin-top: 4rpx;
  color: #66788d;
  font-size: 20rpx;
  line-height: 1.45;
  text-align: center;
}
```

删除或停用不再使用的 `.process-card` / `.process-steps` / `.process-step` / `.step-*` 规则，避免死样式。

- [ ] **Step 4: Commit**（用户要求时）

```bash
git add wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.wxml \
  wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/operator-detail.wxss
git commit -m "$(cat <<'EOF'
feat: show operator step task card on detail page

EOF
)"
```

---

### Task 4: 更新源码断言测试 + 回归

**Files:**
- Modify: `wechat-miniprogram/tests/booking-upload-state.test.ts`
- Optionally add script entry in `wechat-miniprogram/package.json`（非必须：可直接 `tsx --test`）

- [ ] **Step 1: 替换对旧五格 index 的断言**

在「代驾履约留证…」相关 `test` 中，删除或改写这些断言：

```ts
assert.match(operatorSource, /\["driver_arranged", "picked_up", "awaiting_arrival", "on_hold"\]\.includes\(status\)\) return 1;/);
assert.match(operatorSource, /\["checked_in", "inspecting"\]\.includes\(status\)\) return 2;/);
assert.match(operatorSource, /\["result_received", "returning"\]\.includes\(status\)\) return 3;/);
assert.match(operatorSource, /if \(status === "completed"\) return 5;/);
```

改为：

```ts
assert.match(operatorSource, /buildOperatorTaskCard/);
assert.match(operatorTemplate, /task-card/);
assert.match(operatorTemplate, /taskCard\.title/);
assert.match(operatorTemplate, /primary-hint|taskCard\.primaryHint/);
assert.doesNotMatch(operatorTemplate, /process-steps/);
assert.match(operatorSource, /确认到车 · 核验通过|primaryLabel/, "文案由 task card 提供；若文案只在 util，则断言 util 文件");
```

更稳妥：额外 `readFileSync` util 文件并断言关键三步文案：

```ts
const taskCardUtil = readFileSync(new URL("../miniprogram/utils/operator-task-card.ts", import.meta.url), "utf8");
assert.match(taskCardUtil, /确认到车 · 核验通过/);
assert.match(taskCardUtil, /确认交接 · 开始检测/);
assert.match(taskCardUtil, /填写体检报告并回传/);
assert.match(taskCardUtil, /status === "inspecting"/);
```

- [ ] **Step 2: 跑相关测试**

Run:

```bash
cd wechat-miniprogram
node ../node_modules/tsx/dist/cli.mjs --test tests/operator-task-card.test.ts tests/booking-upload-state.test.ts
npm run typecheck
```

Expected: 全部 PASS

- [ ] **Step 3: 手工验收清单（开发者工具）**

1. `awaiting_arrival`：蓝卡「到站核验」，按钮「确认到车 · 核验通过」，灰字不等于开始检测  
2. `checked_in`：蓝卡「交接检测」，按钮「确认交接 · 开始检测」  
3. `inspecting`：蓝卡「结果回传」，按钮进报告  
4. 页面无五格流程条；核验清单/时间线仍在  

- [ ] **Step 4: Commit**（用户要求时）

```bash
git add wechat-miniprogram/tests/booking-upload-state.test.ts wechat-miniprogram/tests/operator-task-card.test.ts \
  wechat-miniprogram/miniprogram/utils/operator-task-card.ts \
  wechat-miniprogram/miniprogram/packages/operator/pages/operator-detail/*
git commit -m "$(cat <<'EOF'
test: assert operator detail uses step task card

EOF
)"
```

---

## Spec coverage (self-review)

| Spec 项 | Task |
|---------|------|
| 本步任务卡替换五格 | Task 3 |
| N/5、title、instruction、nextLabel | Task 1–2 |
| 主按钮文案 + primaryHint | Task 1–3 |
| 关键三步定稿文案 | Task 1 测试 + util |
| 不改 data-action API | Task 2–3（仅文案/UI） |
| 保留核验清单/时间线 | Task 3（未删） |
| 不做吸底栏 C | 未列入 |
| inspecting 与 checked_in 分步 | Task 1 显式测试（修正旧 index 合并问题） |
| booking-upload 旧断言 | Task 4 |

## 注意

- Commit 步骤默认 **跳过**，除非用户明确要求提交。  
- `on_hold` 的 `stepIndex` 采用规格可接受的近似值 `2`（与旧 UI 一致）；不做「挂起前步骤」持久化。  
- 代驾 `picked_up` + `valet-handoff-v1` 时主按钮可能为空（留证流程主导），卡片仍显示「到站核验」。
