# 号牌车型与后台报价

2026-09-04 产品要求：普通/新能源各五类，加黄牌挂车，共 11 项。

| 稳定代码 | 编辑页/后台名称 | 报价车辆类别 |
| --- | --- | --- |
| blue_small_passenger | 蓝牌小型普通客车 | passenger_car |
| new_energy_small_passenger | 新能源小型普通客车 | passenger_car |
| blue_small_truck | 蓝牌小型货车 | small_truck |
| new_energy_small_truck | 新能源小型货车 | small_truck |
| yellow_large_bus | 黄牌大型普通客车 | large_bus |
| new_energy_large_bus | 新能源大型普通客车 | large_bus |
| yellow_large_tractor | 黄牌大型牵引车 | large_tractor |
| new_energy_large_tractor | 新能源大型牵引车 | large_tractor |
| yellow_trailer | 黄牌挂车 | trailer |
| yellow_large_truck | 黄牌大型货车 | large_truck |
| new_energy_large_truck | 新能源大型货车 | large_truck |

唯一类别定义在 `wechat-miniprogram/miniprogram/utils/plate-categories.ts`；API、后台和小程序共用。服务端运行包须包含这个模块。

## 录入与兼容

- 车辆 `plateCategory` 单独保存；`vehicleClassCode` 由已选类别确定。号码不决定动力，D/F 可以出现在任意序号位置。
- 保留省份/机关选择和专用键盘；序号允许 A–Z、数字，7 位挂车号码末尾支持“挂”。发牌机关仍排除 I/O，保留基本长度和省份校验。支持独立选择 7/8 位；切换类别不会丢掉完整号码；减少位数须先删去多余字符。
- 车型文字、座位数、使用性质和全部动力选项可编辑。挂车支持 0 座，其他类别为 1–99 座。切换普通/新能源同类时保留自填车型和座位数。
- 旧车辆可按车型文字、原类别与号码长度兼容显示；不会按 D/F 回填动力。没有可靠类别的旧车辆，编辑时要求重新选择。历史新能源档案未填动力时显示待确认。
- 旧版调用未提交 `plateCategory` 时保留原报价范围守卫；新版明确选择类别后，按各站点价格方案实际条件匹配。其他类别的检验周期仍须核验，不能套用小微型客车的周期测算。

## 报价配置

- 后台“检验价格方案”增加 11 类复选项；方案可覆盖同价的多个类别，也可拆成各类别、各动力、各座位区间的独立方案。
- 原 5 个乘用车方案、站点金额不改。首次迁移新增其他 9 类的可编辑方案，未启用任何站点支持、未编造价格。后台核对条件/检验项目后，在“站点配置 → 支持车型与年检价格”勾选并填价。
- 匹配条件为号牌类别、动力、座位、使用性质、车辆类别与是否排除面包车；必须唯一命中启用且价格大于 0 的站点方案，否则不报价。
- 类别、车辆事实及方案适用类别进入冻结快照；类别变更使旧报价 `QUOTE_STALE`。已下单快照不随后台方案修改而重写。新增类别采用一次性迁移标记，重启不会覆盖后台修改或恢复停用方案。

## 验证

- API：11 类逐项保存/读取/价格匹配；未配置不报价；类别变更旧报价失效；零座边界；重复迁移保留配置；规则重叠停止报价；D/F 不覆盖用户动力。
- 小程序：`npm run test:vehicle-catalog` 覆盖车型库与 11 类新增/编辑回显、独立动力、挂车输入和减少位数保护。
- 原生模拟器：`npm run qa:plate-categories`，读取 11 类，触发 picker change 事件并点击实际键盘，验证大型新能源任意序号、独立动力、黄牌挂车/0 座，不提交车辆。
- 后台：`node scripts/run-postgres-playwright.mjs admin plate-categories.spec.ts`，使用隔离 PostgreSQL schema，实际新建方案、保存站点价格并调用车主报价。
