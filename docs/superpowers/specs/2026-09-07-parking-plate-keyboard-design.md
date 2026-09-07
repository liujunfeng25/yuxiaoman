# 添加车辆 · 停车场式车牌输入

**日期：** 2026-09-07  
**状态：** 已实现  
**范围：** 微信小程序 `vehicle-form` 车牌号码输入

## 背景

当前「添加车辆」页用自由文本框填写车牌（`plate-free-input`）。产品要求改为类似停车场的分段格子 + 自定义键盘，并尊重现有 **11 类号牌类型** 的不同位数与牌面样式。

## 已确认决策

1. **跟号牌类型走**：先选 11 类之一，再展示对应格子数与配色键盘。  
2. **换类型直接清空**已填车牌，按新类型重填。  
3. **黄牌挂车**末位「挂」由用户自行输入，不固定、不默认锁定。  
4. **实现方式**：独立组件 `plate-keyboard`，由 `vehicle-form` 接入。

## 号牌类型 → 输入规格

沿用 `miniprogram/utils/plate-categories.ts` 中的 `PLATE_CATEGORIES` / `plateKind`。

| plateKind | 位数 | 视觉 | 覆盖的号牌类型 code |
|-----------|------|------|---------------------|
| `blue` | 7 | 蓝底白字 | `blue_small_passenger`, `blue_small_truck` |
| `green_small` | 8 | 新能源小型绿牌 | `new_energy_small_passenger`, `new_energy_small_truck` |
| `yellow` | 7 | 黄底黑字 | `yellow_large_bus`, `yellow_large_tractor`, `yellow_trailer`, `yellow_large_truck` |
| `green_large` | 8 | 新能源大型绿牌 | `new_energy_large_bus`, `new_energy_large_tractor`, `new_energy_large_truck` |

未确认号牌类型前：不展示可用键盘（或展示不可用占位），提示先选择号牌类型。

## 交互

1. 用户选择号牌类型 → 组件按上表切换 `slotCount` 与 `plateKind` 样式。  
2. 点击格子区域弹出底部自定义键盘：  
   - 第一位：省/直辖市简称键盘  
   - 后续位：字母 + 数字键盘（含删除）  
   - 「挂」等汉字：在字母数字层提供常用汉字键（至少含「挂」），满足挂车自由输入。  
3. 切换号牌类型：立即清空格子与 `plateNumber`，收起或重置键盘焦点到第一位。  
4. 格子填满（达到当前类型位数）即可视为车牌可保存；未满时沿用现有「未完成」提示文案风格。  
5. 编辑已有车辆：进入页时按已有 `plateNumber` 拆进格子；若与当前类型位数不符，按字符顺序填入可容纳部分，其余丢弃并提示（实现时可简化为：长度超过则截断到 `slotCount`）。

## 组件边界

### `plate-keyboard`（新）

**职责：** 展示格子、管理焦点位、弹出/收起键盘、输出规范化车牌字符串。

**输入（properties）：**

- `plateKind`: `blue` \| `yellow` \| `green_small` \| `green_large`
- `slotCount`: `7` \| `8`
- `value`: 当前车牌字符串（可含 `·` 等分隔，组件内规范化）
- `disabled`: 未选号牌类型时为 true

**输出（events）：**

- `change`: `{ value: string }` — 展示用车牌（建议格间用 `·` 连接省后第一段，与现有示例 `津A·12345` 一致）
- `complete`: 位数已满时额外触发（可选，便于表单更新 `plateComplete`）

**不负责：** 号牌类型选择、品牌车型、提交 API。

### `vehicle-form`（改）

- 移除 `plate-free-input` 自由输入框。  
- 在「车牌号码」区块嵌入 `plate-keyboard`。  
- `plateCategory` / `plateCategoryConfirmed` 变化时：清空车牌并更新传给组件的 `plateKind` / `slotCount`。  
- 保存逻辑继续使用现有 `isPlateInputSafe` 与「请输入车牌号」校验；位数校验与当前 `slotCount` 对齐（满格才算完整）。

## 数据与校验

- 对外仍保存单个 `plateNumber` 字符串，不新增服务端字段。  
- 安全字符规则保持现有实现，不因键盘化放宽或收紧到「仅标准民用车牌正则」（挂车、特殊号牌仍允许用户输入键盘提供的字符）。  
- **不做**新能源第 3 位强制 D/F（本次明确不增加该限制，避免与「自由输入挂」策略冲突；若运营后续要求可另开需求）。

## 测试

- 更新/替换 `booking-upload-state` 等断言自由输入框的用例：改为断言存在车牌格子/键盘组件，且 11 类映射到正确位数。  
- 组件单测或页面级测试：换类型清空；7/8 位完整与未完整；挂车可输入「挂」。

## 非目标

- 不改后台运营端车牌录入。  
- 不改公网体验版/正式版 API 地址选择逻辑。  
- 不在本次引入「识别行驶证自动填车牌」。

## 验收

1. 添加车辆页车牌区为分段格子 + 自定义键盘，不再是大块自由 `input`。  
2. 切换 11 类号牌类型时，格子数与配色正确，且已填内容被清空。  
3. 黄牌挂车可在末位输入「挂」并成功保存。  
4. 保存后首页/车辆列表展示的车牌与输入一致。
