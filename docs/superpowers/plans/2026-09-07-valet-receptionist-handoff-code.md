# 年检代驾接待人 + 抢码 + 换人发新码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把年检代驾安排从「后台填司机」改成「后台填接待人 + 群内抢取车码 + 手填手机/微信入客户中心标代驾 + 送达站后代驾端二次确认换人发新码」。

**Architecture:** 继续以 `server/valet-handoff.ts` 与表 `valet_driver_assignments` 为中心。接待人落在 assignment 上；取车码沿用现有 `verification_code_*` 列（绑 pickup 后清空）；换班码新增 `handoff_verification_code_*` 列。执行人拆成 `pickup_*` / `return_*`（userId + 手填手机）；`bound_user_id` 表示**当前可操作**司机。客户中心标签集扩展「代驾」。小程序代驾登录拆成「验码 → 填手机 → 进单」；任务页在 `checked_in` 及之后、尚未绑定 return 时提供「换人」（二次确认）。

**Tech Stack:** Fastify + Postgres（现有 `AppDatabase` 迁移）、Zod、微信小程序代驾分包、admin React（`DriverAssignmentPanel`）、`server/tests/api.test.ts`。

**Spec:** `docs/superpowers/specs/2026-09-07-valet-receptionist-handoff-code-design.md`

---

## 文件地图

| 文件 | 职责 |
| --- | --- |
| `server/db.ts`（或 valet 迁移段） | assignment 新列、客户标签 CHECK 扩展 |
| `server/customer-center.ts` | `CUSTOMER_TAGS` 增加「代驾」；认领时 upsert 标签 |
| `server/valet-handoff.ts` | 安排/兑换/换人 API、序列化、权限 |
| `server/tests/api.test.ts` | 抢码、手机号、换人、展示断言 |
| `admin/src/App.tsx` | 接待人表单文案与字段 |
| `wechat-miniprogram/.../driver/pages/login/*` | 验码后强制手填手机 |
| `wechat-miniprogram/.../driver/pages/task/*` | 接待人电话、换人二次确认与换班码展示 |
| `wechat-miniprogram/.../driver/services/driver-api.ts` | 新 API 客户端 |
| 车主/检测站订单详情相关页面与 booking detail 序列化 | 取车/送车联系方式展示 |

**状态钉死：** 「送达检测站」= `bookings.fulfillment_status` ∈ `checked_in` | `inspecting` | `result_received`（`station_arrival` 留证完成后进入 `checked_in`）。仅此时允许 `POST .../handoff-code`。

**换人吊销时机：** 生成换班码时**不**吊销取车司机会话（需能看码并复制）；**return 绑定成功时**吊销原会话并使原司机不可再操作。

---

### Task 1: 数据库迁移 — assignment 扩展 + 客户标签「代驾」

**Files:**
- Modify: `server/db.ts`（valet / customer 迁移所在段落）
- Modify: `server/customer-center.ts`（`CUSTOMER_TAGS`、CREATE/CHECK）

- [ ] **Step 1: 写迁移 SQL（在现有 migrate 函数中追加）**

```sql
ALTER TABLE valet_driver_assignments
  ADD COLUMN IF NOT EXISTS receptionist_name TEXT,
  ADD COLUMN IF NOT EXISTS receptionist_phone TEXT,
  ADD COLUMN IF NOT EXISTS pickup_driver_phone TEXT,
  ADD COLUMN IF NOT EXISTS pickup_bound_user_id TEXT,
  ADD COLUMN IF NOT EXISTS pickup_bound_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_driver_phone TEXT,
  ADD COLUMN IF NOT EXISTS return_bound_user_id TEXT,
  ADD COLUMN IF NOT EXISTS return_bound_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handoff_verification_code_hmac TEXT,
  ADD COLUMN IF NOT EXISTS handoff_verification_code_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS handoff_verification_code_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handoff_verification_code_created_at TIMESTAMPTZ;

-- 历史行：原 driver_name/phone 视为接待人快照（运营曾填的是司机，仅兼容展示）
UPDATE valet_driver_assignments
SET receptionist_name = COALESCE(receptionist_name, driver_name),
    receptionist_phone = COALESCE(receptionist_phone, driver_phone)
WHERE receptionist_name IS NULL;

-- 客户标签：重建 CHECK 前先扩展枚举用法（按仓库既有 migrate 风格改 customer_admin_tags）
-- 目标 tag 集合：重点客户、待跟进、复购客户、资料待补、代驾
```

在 `customer-center.ts`：

```ts
const CUSTOMER_TAGS = ["重点客户", "待跟进", "复购客户", "资料待补", "代驾"] as const;
```

同步修改 `tag IN (...)` 的建表/迁移与排序 `CASE` 分支（「代驾」排在资料待补之后即可）。

- [ ] **Step 2: 启动一次本地 API / 跑迁移相关测试，确认库可起来**

Run: `cd /Users/Admin/Documents/yuxiaoman && npm test -- --test-name-pattern="代驾六位验证码" 2>&1 | tail -40`  
（或项目惯用的 `npm run test:api` 片段；以能加载 migrate 为准）

Expected: 迁移无异常；旧测试可能仍按 `driverName` 失败——下一 Task 再改接口。

- [ ] **Step 3: Commit**

```bash
git add server/db.ts server/customer-center.ts
git commit -m "$(cat <<'EOF'
feat(valet): add receptionist/pickup/return/handoff columns and 代驾 tag

EOF
)"
```

---

### Task 2: 后台安排 API 改为接待人字段

**Files:**
- Modify: `server/valet-handoff.ts`（`assignmentSchema`、`POST /api/admin/bookings/:id/driver-assignment`、admin 序列化）
- Modify: `admin/src/App.tsx`（`DriverAssignmentPanel`）
- Modify: `server/tests/api.test.ts`（安排请求体）

- [ ] **Step 1: 先改测试请求体与断言（失败）**

将安排接口 body 从：

```ts
{ driverName: "王大海", driverPhone: "13900139000" }
```

改为：

```ts
{ receptionistName: "站务小刘", receptionistPhone: "13800138000" }
```

断言 admin detail：

```ts
assert.equal(detail.driverAssignment.receptionistName, "站务小刘");
assert.equal(detail.driverAssignment.receptionistPhone, "13800138000");
assert.equal(detail.driverAssignment.verificationCodeStatus, "active");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/Admin/Documents/yuxiaoman && npx tsx --test --test-name-pattern="新版代驾任务" server/tests/api.test.ts 2>&1 | tail -30`  
Expected: FAIL（schema / 字段）

- [ ] **Step 3: 实现 schema 与写入**

```ts
const assignmentSchema = z.object({
  receptionistName: z.string().trim().min(2).max(40),
  receptionistPhone: z.string().trim().regex(/^1\d{10}$/u, "请输入有效的 11 位手机号"),
});
```

INSERT/UPDATE 写入 `receptionist_name` / `receptionist_phone`；**不再**把接待人写入「当前司机执行人」。`driver_name`/`driver_phone` 可暂存接待人副本以兼容旧读路径，或逐步停用——本任务以新列为准，序列化优先读 `receptionist_*`。

生成取车码逻辑保持：`generateDriverVerificationCode` → `verification_code_*`；重置时清空 `bound_user_id` / pickup/return 执行人与 handoff 码（重新安排取车）。

- [ ] **Step 4: 管理端表单**

`DriverAssignmentPanel`：label 改为「接待人员姓名/电话」；state `receptionistName`/`receptionistPhone`；提交 JSON 用新字段；文案「一单一司机」改为「取车任务验证码（发群抢单）」。

- [ ] **Step 5: 跑相关测试并 Commit**

```bash
git add server/valet-handoff.ts admin/src/App.tsx server/tests/api.test.ts
git commit -m "$(cat <<'EOF'
feat(valet): admin assigns station receptionist instead of driver

EOF
)"
```

---

### Task 3: 兑换接口 — 取车码/换班码 + 手填手机 + 客户中心打标

**Files:**
- Modify: `server/valet-handoff.ts`（`taskExchangeSchema`、`POST /api/driver/task-sessions/exchange`）
- Modify: `server/customer-center.ts`（导出 `ensureCustomerTag(userId, "代驾")` 或等价内部函数）
- Modify: `server/tests/api.test.ts`

- [ ] **Step 1: 扩展兑换 schema**

```ts
const taskExchangeSchema = z.object({
  verificationCode: z.string().trim().regex(/^\d{6}$/u).optional(),
  taskCode: z.string().trim().min(20).max(240).optional(),
  driverPhone: z.string().trim().regex(/^1\d{10}$/u, "请输入有效的 11 位手机号").optional(),
}).superRefine((value, context) => {
  if (Boolean(value.taskCode) === Boolean(value.verificationCode)) {
    context.addIssue({ code: "custom", path: ["verificationCode"], message: "请提交一种代驾任务凭证" });
  }
});
```

规则：

1. 用 `verificationCode` 匹配 **取车码 hmac** 或 **换班码 hmac**（分列查询）。
2. **取车码路径：** assignment 尚无 `pickup_bound_user_id`；校验未过期；要求 `driverPhone`；绑定 `pickup_bound_user_id`/`pickup_driver_phone`/`pickup_bound_at`，`bound_user_id`=当前用户；清空取车 `verification_code_*`；签发 session。
3. **换班码路径：** 存在有效 handoff 码且无 `return_bound_user_id`；要求 `driverPhone`；写入 return_*；`bound_user_id`=新人；**revoke 该 assignment 下旧 sessions**；清空 handoff 码列。
4. 两种路径成功后：确保用户在客户中心存在，并 `INSERT` 标签「代驾」（忽略冲突）。
5. 缺 `driverPhone`：返回 `400 DRIVER_PHONE_REQUIRED`（文案：请填写代驾手机号）。
6. 他人再输已消费取车码：保持现有 invalid / 限流行为。

- [ ] **Step 2: 测试**

新增/改写用例要点：

```ts
// 取车：先 exchange 无 phone → 400
// 再带 phone → 200，且 customer_admin_tags 含「代驾」
// 第二人同取车码 → 失败
// 送达站后 handoff，第二人带 handoffCode+phone → 200，原 session 401
```

- [ ] **Step 3: Commit**

```bash
git add server/valet-handoff.ts server/customer-center.ts server/tests/api.test.ts
git commit -m "$(cat <<'EOF'
feat(valet): claim codes require phone and tag drivers in customer center

EOF
)"
```

---

### Task 4: 代驾端「换人」API（生成换班码）

**Files:**
- Modify: `server/valet-handoff.ts`
- Modify: `server/tests/api.test.ts`

- [ ] **Step 1: 新增路由**

`POST /api/driver/tasks/:bookingId/handoff-code`

鉴权：当前 driver session 且 `bound_user_id === pickup_bound_user_id`（仍是取车司机）。  
前置：`fulfillment_status` ∈ `checked_in|inspecting|result_received`；尚无 `return_bound_user_id`。  
行为：生成 6 位码写入 `handoff_verification_code_*`（若已有未使用换班码则**作废旧码并重新生成**，符合 spec）；响应明文仅此接口返回：

```ts
{ data: { handoffVerificationCode: "123456", expiresAt: "..." } }
```

管理端 detail **默认不返回**换班码明文（与「仅代驾端展示」一致）；必要时可另开只读应急，本期不做。

- [ ] **Step 2: 测试**

```ts
// picked_up 未到站 → 409
// checked_in + pickup session → 200，码为 6 位
// 再 POST → 新码，旧码 exchange 失败
```

- [ ] **Step 3: Commit**

```bash
git add server/valet-handoff.ts server/tests/api.test.ts
git commit -m "$(cat <<'EOF'
feat(valet): allow pickup driver to mint handoff code after station arrival

EOF
)"
```

---

### Task 5: Booking / 任务详情序列化 — 各端联系人

**Files:**
- Modify: `server/valet-handoff.ts`（`serializeDriverAssignment` / task payload）
- Modify: 车主订单详情消费处（如 annual order-detail）与检测站端对应字段（若已读 `driverAssignment`）
- Test: `server/tests/api.test.ts` owner/admin/operator assertions

- [ ] **Step 1: 统一对外结构**

```ts
driverAssignment: {
  receptionistName, receptionistPhone, // full for driver/admin; mask phone for owner if needed by现有隐私规则
  pickupDriverPhone,  // owner/operator: masked；driver self: full
  returnDriverPhone,  // 绑定后才有
  verificationCodeStatus, // 取车码状态
  handoffCodePending: boolean, // 有未绑换班码（不给明文）
  // 兼容：逐步去掉把接待人当成 driverName 的误导字段，或 driverName 改为接待人并在 UI 改文案
}
```

代驾 task summary 增加 `receptionistName`/`receptionistPhone`（全量电话，便于拨打）。

- [ ] **Step 2: 小程序/站端文案**

- 车主/检测站：展示「取车代驾联系方式」「送车司机联系方式」（有则显示）。
- 代驾任务页：展示「检测站接待：姓名 · 电话」。

- [ ] **Step 3: Commit**

```bash
git add server/valet-handoff.ts server/tests/api.test.ts wechat-miniprogram/miniprogram/packages/**/order-detail/* 
git commit -m "$(cat <<'EOF'
feat(valet): expose receptionist and pickup/return driver contacts by audience

EOF
)"
```

---

### Task 6: 小程序代驾登录 — 验码后手填手机

**Files:**
- Modify: `wechat-miniprogram/miniprogram/packages/driver/pages/login/login.ts`
- Modify: `wechat-miniprogram/miniprogram/packages/driver/pages/login/login.wxml`
- Modify: `wechat-miniprogram/miniprogram/packages/driver/services/driver-api.ts`
- Test: 若有 driver login 源码断言测试则更新；否则依赖 api 测试 + 手工

- [ ] **Step 1: UI 流程**

1. 输入 6 位码。
2. 「下一步」仅本地校验码格式，进入手机号步骤（或同页展开）。
3. 输入 11 位手机 + 「确认手机号」再调 `exchangeVerificationCode({ verificationCode, driverPhone })`。
4. 错误展示服务端文案。

- [ ] **Step 2: API client**

```ts
exchangeVerificationCode(verificationCode: string, driverPhone: string)
```

- [ ] **Step 3: Commit**

```bash
git add wechat-miniprogram/miniprogram/packages/driver/pages/login/* wechat-miniprogram/miniprogram/packages/driver/services/driver-api.ts
git commit -m "$(cat <<'EOF'
feat(driver): require manual phone before entering valet task

EOF
)"
```

---

### Task 7: 小程序任务页 — 换人二次确认 + 展示换班码

**Files:**
- Modify: `wechat-miniprogram/miniprogram/packages/driver/pages/task/task.ts`
- Modify: `wechat-miniprogram/miniprogram/packages/driver/pages/task/task.wxml`
- Modify: `wechat-miniprogram/miniprogram/packages/driver/services/driver-api.ts`
- Modify: 对应 wxss（若有）

- [ ] **Step 1: 显示条件**

`showHandoff = !task.terminal && isPickupDriver && ["checked_in","inspecting","result_received"].includes(status) && !returnBound`

- [ ] **Step 2: 点击「换人」**

```ts
wx.showModal({
  title: "确认换人？",
  content: "将生成新的送车验证码。接班司机输入新码后，你将无法再操作本单。",
  confirmText: "确认换人",
  cancelText: "取消",
  success: async (res) => {
    if (!res.confirm) return;
    const { handoffVerificationCode } = await driverApi.createHandoffCode(bookingId);
    // setData 展示码 + 复制按钮
  },
});
```

取消则不请求 API。展示区支持 `wx.setClipboardData`。

- [ ] **Step 3: Commit**

```bash
git add wechat-miniprogram/miniprogram/packages/driver/pages/task/* wechat-miniprogram/miniprogram/packages/driver/services/driver-api.ts
git commit -m "$(cat <<'EOF'
feat(driver): confirm before minting handoff code and show it on task page

EOF
)"
```

---

### Task 8: 回归与收尾

**Files:** 测试与文案扫尾

- [ ] **Step 1: 跑代驾相关 API 测试**

Run:

```bash
cd /Users/Admin/Documents/yuxiaoman
npx tsx --test --test-name-pattern="代驾|司机任务|验证码" server/tests/api.test.ts
```

Expected: PASS（含：抢码一人、手机必填、标签代驾、到站前不可换人、换人二次确认在客户端、换班绑定吊销旧会话、同人送车不换人仍可 `start-return`）。

- [ ] **Step 2: 手工验收清单（开发者工具）**

1. 后台填接待人生成取车码。  
2. 代驾 A 输码 + 手机进单；B 同码失败。  
3. 客户中心可见 A 且标签含代驾。  
4. 完成到站留证后出现「换人」；取消确认不生成。  
5. 确认后得新码；B 输新码 + 手机进单；A 会话失效。  
6. 车主/站端见取车与送车电话；代驾端见接待电话。

- [ ] **Step 3: Commit 测试/文案扫尾（若有）**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(valet): cover receptionist handoff claim flow regressions

EOF
)"
```

---

## Spec 覆盖自检

| Spec 项 | Task |
| --- | --- |
| 后台接待人 + 取车码 | 2 |
| 代驾端接待电话 | 5、7 |
| 微信入客户中心标代驾 | 1、3 |
| 手填手机再进单 | 3、6 |
| 取车一码一人 | 3（既有消费逻辑保留） |
| 同人送车不换人 | 4 不强制；8 回归 start-return |
| 到站后换人发新码 | 4、7 |
| 换人二次确认 | 7 |
| 换班码仅代驾端明文 | 4、5、7 |
| 换人绑定后吊销原司机 | 3 |
| 取/送联系方式展示 | 5 |

## 占位符扫描

无 TBD；换班码过期时长复用取车码 `verificationCodeFirstClaimTtlMs`（在 `valet-handoff.ts` 已有常量）。
