# 驭小满 · 汽车后市场综合服务 MVP

一个为面试演示打造的高保真全栈 MVP：C 端帮助车主完成“建档—判断—预约—跟踪—看结果”，B 端帮助检测站完成“看队列—核验到站—交接检测—接收结果—完成服务”。两端共享同一笔预约和同一条事件时间轴，形成可解释、可恢复、可重复演示的服务闭环。

> **项目边界**：这是一个全新、独立的汽车后市场综合服务 MVP，与任何医疗项目或医疗业务完全无关。华洋机动车检测站的主体、地址、坐标、电话和营业日来自公开名录，腾讯 Key 可用于真实地址联想与驾车矩阵；其余站点、评分、号源、车辆、预约、租赁门店、车队、价格、押金、订单和检测结果均为**合成演示数据**。项目不连接真实检测设备、监管平台、交管账号、车联网或真实支付通道，也不声称具备真实机动车检验能力。

## 一眼看懂这个 MVP

| 维度 | 交付内容 |
| --- | --- |
| C 端车主 | 多轴车辆档案、年检资格、站点时段、自驾/往返取送预约、腾讯路线报价、模拟支付、履约时间轴与结果 |
| C 端车险 | 60 秒续保需求登记、明确接收方披露、单张行驶证主页、授权确认、服务凭证与撤回 |
| C 端洗车 | 车辆价类、自驾/往返代驾、腾讯路线计价、演示门店、套餐与号源、模拟支付、六位核销码与订单管理 |
| C 端租车 | 同店取还/同址送取、门店与时间搜索、46 个指定车型、实时可租容量、透明报价、模拟支付和租车订单 |
| B 端检测站 | 日期/站点工作台、单车履约详情、取车资料、到站核验、异常挂起、检测交接、结果回传与号源容量 |
| 运营后台 | 年检交易与履约；车险脱敏线索；洗车供给与核销；租赁品牌车型、门店、车队、价格和订单维护 |
| 双端交集 | 同一预约、同一状态机、可审计事件、结果摘要和异常恢复 |
| 技术栈 | React 19 + TypeScript + Vite，Fastify + Zod，Node.js 24 + `node-postgres`，PostgreSQL |
| 交付形态 | iPhone / Pixel 10 移动 Web 原型 + 原生微信小程序 + 统一桌面后台；车主域使用独立 Bearer 会话，桌面后台使用实名账号与 HttpOnly 会话，并按平台管理员或单店洗车管理员返回导航、能力和主体范围 |

### 原生小程序包体策略

- 主包只注册“首页 / 订单 / 我的”三个 Tab 根页面，并保留跨业务共享的服务、类型、工具与首屏必需资源；首屏仍为 `pages/home/home`。
- 年检、洗车、车险、租车、车辆档案和运营工作台使用普通业务分包，既能按需下载，也能复用主包共享代码；已有体检报告、补贴咨询和驾校分包保持独立域边界。
- 业务私有工具和图片必须跟随所属分包，主包不得导入分包代码。`npm run check:main-package` 会校验全部 JSON 与页面文件，并以主包 1.5 MiB 为项目预算、单包 2 MiB 和总包 20 MiB 为微信平台硬上限阻断回归。

核心产品判断不是“给原来的 C 端再加一个后台”，而是把同一笔服务分别呈现为两个角色真正需要完成的工作：

- 车主关心确定性：什么时候办、带什么、去哪儿、现在到哪一步。
- 检测站关心可执行性：下一辆是谁、是否到站、资料是否一致、何时交接、结果是否已回传。
- 工业检测软件关心设备与检验过程，本 MVP **不承担也不伪造**这部分能力。

## 产品问题与双边价值

年检是低频但高焦虑的服务。C 端的不确定性与 B 端的现场协同问题互相放大：车主信息不完整会拖慢到站核验，站端状态不透明又让车主反复询问。

| 角色 | 原始问题 | MVP 的应对 |
| --- | --- | --- |
| 车主 | 不清楚资格、材料、时段和进度 | 先判断再预约；用材料清单与状态时间轴提供下一步 |
| 检测站前台 | 任务散落在电话、纸单和不同系统 | 以今日队列、时段压力和明确主操作组织工作 |
| 检测站操作员 | 交接边界、异常和结果来源难追溯 | 到站核验、挂起/恢复、操作者事件和外部结果编号留痕 |
| 业务负责人 | 只能看到下单量，无法判断服务质量 | 同时观察到站率、准时开检率、回传延迟、利用率和爽约率 |

## 系统边界：服务平台不是检测线软件

聊天需求中提到的“线上检测设备的检测软件”属于另一个技术域。这里采用清晰的三层边界：

```mermaid
flowchart LR
    C["C 端车主\n档案 / 预约 / 进度 / 结果"] <-->|"业务订单与事件"| B["B 端检测站服务台\n队列 / 核验 / 交接 / 完成"]
    B -->|"预约与车辆上下文"| L["外部检测线软件\n设备采集 / 检验过程"]
    L -->|"签名结果回传"| B
    L -.->|"真实生产环境才存在"| R["监管或机构系统"]
```

- 小程序服务端处理预约、容量、到站、业务交接、异常、结果接收和用户可见摘要。
- 外部检测线软件处理制动台、尾气仪等设备与真实检验流程；本仓库没有设备协议、遥测、校准和控制代码。
- 结果通过带签名、幂等键的接口回传；“模拟结果回传”只由服务端生成合成结果，密钥不会暴露在浏览器。
- 这种分层参考 [HJ 1238—2021](https://www.mee.gov.cn/ywgz/fgbz/bz/bzwb/other/hjbhgc/202201/t20220119_967599.shtml) 的数据采集传输框架与软件功能边界，也避免把现行强制性 [GB 38900—2020](https://std.samr.gov.cn/gb/search/gbDetailed?id=A6C17F3F874B903DE05397BE0A0A40C3) 所规定的真实检验要求包装成手机功能。[市场监管总局 2025 年相关指导](https://www.samr.gov.cn/xw/sj/art/2025/art_cb21a36c60754c5d8dd40b97434e1966.html) 还强调检测设备、检测软件、视频监控、人员能力以及数据可追溯、防篡改；因此本 MVP 把事件留痕、签名回传和职责分离作为产品边界，而不是用伪造遥测制造“已接设备”的印象。

## 完整用户旅程

```mermaid
sequenceDiagram
    actor Owner as 车主 C 端
    participant API as 驭小满服务端
    actor Driver as 代驾执行端
    actor Operator as 检测站 B 端
    participant Line as 外部检测线软件

    Owner->>API: 添加车辆并查询年检状态
    Owner->>API: 确认材料、站点与时段
    Owner->>API: 提交预约 pending_payment
    Owner->>API: 支付成功并自动确认 confirmed
    alt 自驾到站
        Operator->>API: 接单并等待车辆 awaiting_arrival
    else 上门取送
        Operator->>API: 安排司机并生成 6 位任务验证码 driver_arranged
        Driver->>API: 取车现场提交 5 张留证 picked_up
    end
    Operator->>API: 到站 5 张留证与四项核验 checked_in
    alt 信息不一致
        Operator->>API: 挂起 on_hold
        Operator->>API: 修正并恢复 checked_in
    end
    Operator->>API: 交接检测 inspecting
    API->>Line: 提供预约和车辆上下文
    Line->>API: HMAC 签名结果与体检报告 result_received
    alt 上门取送
        Driver->>API: 开始返程 returning
        Driver->>API: 送回现场提交 5 张留证 completed
    else 自驾到站
        Operator->>API: 交付结果 completed
    end
    Owner->>API: 查看结果、四阶段留证和下次提醒
```

## C 端体验

- 首页以 `references/selected-owner-home-v2.png` 为唯一视觉基准，延续雾白、钴蓝、浅冰蓝与提醒橙，按“车辆与年检主任务 → 四阶段服务流程 → 3 × 2 车主服务”组织信息。
- C 端一级导航固定为“首页 / 订单 / 我的”；只在三个一级页展示，预约、支付、订单详情及各业务子页面不显示底栏。
- “立即预约”直接进入站点/服务方式预约；“查询是否需上线”进入规则测算与办理建议，两者不再汇入同一个查询页。
- 年检四阶段图标分别进入预约、到站、资料和结果页面，并读取默认车辆与最新年检订单。无订单时显示准备说明与正确下一步；结果页只展示后端已回传结果和交管 12123 办理指引，不生成电子合格标，也不暗示已接入交管系统。
- 车牌不是普通文本框：提供 31 个省级简称、独立字符格、专用键盘、自动跳格、连续退格和实体键盘支持。
- 普通蓝牌固定 7 字符；新能源绿牌固定 8 字符。小型新能源的 `D/F` 位于序号首位，大型新能源的 `D/F` 位于末位。
- 车辆、用途、注册日期共同参与演示资格判断；不会仅凭号牌颜色推测年检日期。
- 主链路覆盖资格、材料、站点、时段、确认、成功、订单、结果、提醒和评价。
- 车辆列表、首页、资格页和订单页同步展示蓝/绿牌与能源标签；有进行中订单时禁止删除车辆。

### 完整预约资料页

- 最终确认页支持切换自驾到站与“上门取送车（往返）”，后者固定为原地址取车、送检并在检测完成后送回原地址。
- 取送地址输入 2 个字符后进行 300ms 防抖联想，只允许选择天津范围的结构化 POI；另设楼栋/门牌和取车备注，保存经纬度供路线报价及导航使用。
- 取送费仅按取车点到站的腾讯单程驾车距离计算，返程已包含且不重复收费：`起步价 + ceil(max(0, 单程距离 − 包含里程)) × 超程单价`。
- 腾讯 Key 缺失、无权限、超时或额度不足时，系统禁止生成取送报价和提交取送订单；估算距离只可作展示参考，绝不冒充真实报价。自驾到站仍可继续。
- 自驾和代驾预约均要求上传 7 张资料：车辆左前、右前、左后、右后、启动后仪表盘，以及行驶证主页和副页。代驾司机在实际取车现场仍会另拍四角和启动后仪表盘，形成独立的第一组履约留证。服务端纠正旋转、移除 EXIF，并压缩为最长边不超过 2048px 的随机命名 JPEG。
- 年检代驾采用现有微信小程序内的隐藏司机任务分包，不新增第二个小程序。司机从“我的 → 工作人员入口 → 代驾端”进入固定页面，输入后台为单笔订单生成的 6 位验证码领取任务；验证码首次领取 24 小时有效，成功后绑定当前微信身份，任务完成前可由同一身份再次输入续领会话。司机取车 5 张、检测站到站 5 张、车辆体检报告固定 5 张及司机送回 5 张按阶段展示给车主与平台后台。现场照片齐全后由服务端原子推进对应履约节点，不增加客户确认、异议、轨迹、聊天、排班或结算功能。
- 检验费由每站受控价格方案匹配车辆事实；订单保存车型、项目、腾讯路线、计价规则和逐项金额快照，后续后台调价不会改写历史订单。

## 基础运营后台

独立 `admin/` React 应用采用桌面左侧导航和宽表格布局，不改动移动端运行框架。任何业务数据加载前都先解析统一后台会话：平台管理员保留完整运营导航和全量主体；受邀洗车店管理员只得到自己门店的洗车工作台；受邀检测站管理员固定绑定一个检测站，只能通过检测站端读取本站队列、预约、报告、留证与号源。检测站和洗车门店仍只能从带短期签名的地图候选创建或重新定位。服务端对列表、总数、详情、报告、媒体、留证和写入同时强制主体范围，前端隐藏菜单或传入主体 ID 都不构成授权。所有支付仍明确标识为模拟，不代表真实支付系统。

### 后台身份、主体与永久审计

后台身份与车主身份完全分离。迁移后的首个平台管理员由无默认密码的 `npm run backoffice:create-admin` 脚本显式创建；后续洗车门店与检测站账号都由平台生成一次性邀请链接，激活链接 24 小时有效。改密、停用、权限版本变化或管理员交接都会撤销应失效的旧会话。首期服务主体严格执行“一主体一名有效管理员”，不提供跨店/跨站切换、自定义角色或多人共管。检测站管理员在原生小程序中登录后取得可撤销的站点 Bearer，会话不能访问其他检测站；车主 Bearer 不能调用检测站接口。

洗车店管理员可以直接维护本店经营资料、可信地址、相册、未来号源、销售价和可售状态，价格只影响后续新报价，历史报价与订单快照不变。服务商订单响应只包含履约所需的车牌、车型、套餐、时段、方式、金额和状态，不返回车主姓名、手机号、代驾地址或核销码；核销必须由门店手工输入车主出示的六位码。取消、退款、结算修正、公共套餐和全局规则仍由平台处理。

“操作记录”只收录账号安全、越权尝试和会影响业务结果的关键变更；列表、详情、搜索、筛选、分页、统计、工作台读取、未保存表单、同值保存、普通错误和内部备注不会产生全平台记录。一次有效业务命令只写一条中文语义记录，组合修改的实际差异在详情抽屉中集中展示；服务商只能读取本人、本店记录。动作分类和中文名称由服务端目录固定，页面及接口不展示动作码、路由、请求 ID 或原始 JSON。

上述记录均使用服务端会话解析出的真实操作者，并与关键业务写入在同一 PostgreSQL 事务中提交。记录不可修改或删除，不提供清理或导出接口；密码、令牌、手机号、完整车牌、取送地址、核销码、内部备注和文件存储信息不会进入运营操作记录。客户中心对敏感资料读取的合规轨迹仍保留在客户档案自身的受控时间线中，不混入全平台操作记录。

## 车险续保线索闭环：车主端 + 运营后台

车险模块定位为“续保需求登记与专业人员对接”，不是保险咨询或交易平台。车主从首页“车主服务 → 保险服务”进入独立页面，确认具体接收方与数据用途后，用约 60 秒选择车辆和续保时间、填写联系人与联系时段、上传一张行驶证主页并主动勾选授权。提交成功只返回不可修改的服务编号、提交时间、车辆、脱敏手机号和预计联系时间；车主可复制编号或用仅返回一次的撤回凭证撤回需求，客户端不展示顾问电话、报价或跟进时间线。

运营后台新增“车险线索”，以脱敏列表承接 `new → handed_off → closed` 状态；`withdrawn` 为独立终态。该模块不设独立密码，但只对已登录的平台管理员开放；洗车店管理员在读取列表、详情或媒体前即被拒绝。查看完整详情和私有图片仍写入审计事件，转交时固化合作方、接收人、授权披露版本与时间，关闭仅允许发生在已转交线索上。

> **明确边界**：本版本不提供保险产品咨询、比价、试算、方案、投保、承保、支付、自动通知、合作方门户或分账。保险线索使用独立数据表，不复用年检预约的站点、时段和支付状态。默认演示模式只接受固定合成手机号 `13800138000` / `13900000000`；未完整配置 HTTPS 公开基址、数据密钥、手机号 HMAC 密钥和明确接收方时，服务端会拒绝接收真实资料。

隐私处理采用应用层 AES-256-GCM 加密联系人、手机号 HMAC 去重、随机私有文件名、真实文件格式嗅探、移除 EXIF 与压缩。照片在转交 30 天后或未转交 60 天后清理；关闭/撤回线索的原始联系信息保留 180 天，归因和审计事件保留一年。同一幂等键可安全重放；同一手机号与车辆 7 天内重复提交返回原服务凭证。

## 洗车服务闭环：车主端 + 运营后台

洗车是车主服务模块中的独立交易闭环，不复用年检站端履约状态机，也不改变年检作为主链路的产品边界。它只有两个产品表面：车主端负责选择与预约，现有运营后台负责供给维护、人工核销和线下对账登记。

> **明确边界**：本版本不建设独立商家 App，而是在现有桌面后台中提供受邀、单主体的洗车店管理员角色。门店可处理自己的订单核销、资料、号源和售价，但不能取消、退款、修改结算、维护公共套餐或查看其他主体。模拟支付、模拟退款和结算登记都不代表真实资金流；系统不执行清分、佣金计算、自动分账、银行转账或支付机构结算。

```mermaid
sequenceDiagram
    actor Owner as 车主
    participant API as 驭小满服务端
    actor Ops as 运营后台
    participant Store as 洗车店（线下）

    Owner->>API: 选择车辆价类、自驾/代驾、门店、套餐与号源
    alt 往返代驾
        Owner->>API: 选择结构化取送地址
        API-->>Owner: 腾讯单程驾车距离 + 往返代驾费
    end
    API-->>Owner: 冻结 10 分钟报价
    Owner->>API: 幂等创建订单并占位 15 分钟
    Owner->>API: 本地 mock 支付
    API-->>Owner: 支付成功后生成唯一六位核销码
    alt 自驾到店
        Owner->>Store: 到店出示六位码
    else 往返代驾
        Owner->>Ops: 车辆交接时出示六位码
        Ops->>Store: 线下安排取车、送洗与送回
    end
    Store-->>Ops: 线下确认服务
    Ops->>API: 人工核销并记录来源、操作人、备注
    Ops->>API: 登记线下实际结算金额与对账备注
```

消费者只需要完成“选车—选方式—选店—选套餐—选服务时段—支付—报码”的短链路：

- 车辆价类分为 `sedan`、`suv`、`mpv` 三档，保存在可空字段 `vehicles.wash_vehicle_category`；后台按门店 × 套餐分别维护三档价格，消费者端始终按所选车辆档案读取对应报价。历史 `suv_mpv` 只用于迁移兼容，不再产生新的合并档数据；报价同时冻结车辆、门店、套餐、时段和预计结算价。
- 服务方式为 `self_drive` 或 `valet`。代驾固定为同一地址往返取送，只按取车点到洗车门店的腾讯真实单程驾车距离计价，返程已包含且不重复收费：`起步价 + ceil(max(0, 单程距离 − 包含里程)) × 超程单价`。
- 地址联想会为 POI 文案与坐标签发短期 `locationProof`；洗车报价必须校验该凭证（非生产合成地址另受显式演示开关约束），避免客户端把展示地址与近店坐标拼接后压低费用。车型价类始终从车主所属车辆读取，客户端字段只能一致性校验，不能覆盖价格档。
- 运营新增洗车门店时同样不手填经纬度：输入门店、道路或商场名称并从地址联想中选择，系统自动回填所属区、标准地址和只读坐标。新建未选点不能保存；编辑旧门店默认保留原定位，只有重新选择可信候选才会更新。服务端校验候选的短期 `locationProof`，并从候选派生入库位置，忽略根级伪造的地址或坐标。
- 洗车门店默认继承年检共用的全局往返取送规则，也可通过 `wash_store_valet_pricing_overrides` 整套覆盖；无真实腾讯路线、超出服务半径或缺少规则时必须阻止代驾报价并允许改选自驾，不能回退估算距离收费。
- 预约时段仍表示门店的洗车服务窗口，不是承诺的司机上门时间；具体取车时间由运营人员线下确认。本版本不新增司机端、司机状态或实时位置跟踪。
- 报价有效期 10 分钟；创建待支付订单后容量占位 15 分钟。到期订单自动变为 `expired` 并释放号源。
- 只有模拟支付确认成功后才生成六位数字核销码。自驾车主到店出示，代驾车主在车辆交接时向平台司机出示，由运营线下完成门店核销；取消或退款后核销码立即失效。同一订单重复核销保持幂等。平台管理员输入错误或失效码时返回受控 `409`；洗车店管理员对他店码、未知码或失效码统一得到 `404`，且连续失败会触发按账号、固定门店和来源 IP 执行的 `429` 限流。
- 号源容量、同车时段冲突、报价使用、下单、支付、改期、取消/退款、核销和结算均由服务端事务与幂等约束保护，不依赖前端乐观状态。
- `wash-seed-v1` 提供三家名称明确带“演示”的合成门店；标准洗车/精致洗护初始定价为小轿车 3800/8800 分、SUV 4800/10800 分、MPV 5800/12800 分。三类车辆使用独立价格记录，可由运营分别修改；这些数据不代表真实合作门店或实时价格。

### 洗车订单状态机

```mermaid
stateDiagram-v2
    [*] --> pending_payment: 创建订单并占位 15 分钟
    pending_payment --> awaiting_redemption: mock 支付成功并生成六位码
    pending_payment --> cancelled: 车主或运营取消
    pending_payment --> expired: 支付占位到期
    awaiting_redemption --> redeemed: 运营人工核销
    awaiting_redemption --> refunded: 车主取消或运营退款
    redeemed --> refunded: 未结算前受控退款
```

| 状态 | 含义 | 允许动作 |
| --- | --- | --- |
| `pending_payment` | 已占位、尚未支付、无核销码 | 支付、改期、取消、等待过期 |
| `awaiting_redemption` | 模拟支付成功、六位码有效 | 改期、人工核销、取消并模拟退款 |
| `redeemed` | 运营已核销，线下服务已确认 | 登记结算；未结算时可由运营受控退款 |
| `cancelled` | 未支付订单已取消 | 终态，号源释放 |
| `refunded` | 已支付订单已模拟退款 | 终态，核销码失效、结算作废 |
| `expired` | 15 分钟支付占位已到期 | 终态，号源释放 |

结算状态独立于订单状态：`unsettled` 表示尚未登记线下对账，`settled` 表示运营已登记实际金额与备注，`void` 表示订单取消、退款或过期后结算记录作废。只有 `redeemed` 订单能进入 `settled`；修正已结算记录必须填写原因并写入事件审计。

## 汽车租赁：微信小程序 + 运营后台

汽车租赁是原生微信小程序中的公司自营短租闭环，按“地点与时间 → 指定车型 → 服务端透明报价 → 创建订单 → 模拟支付 → 取还履约”组织。租赁产品只交付微信小程序、Fastify/PostgreSQL API 与运营后台，不把 React/Vite 面试 MVP 作为租赁入口或验收对象；运营后台维护品牌车型、天津演示门店、车队车辆、价格计划和租车订单。

- 搜索首页提供“同店取还”和“同址送取”两种方式。门店模式只选一个取还门店；送取模式只选一个结构化地址，由服务端选择可履约门店并冻结在报价中，不支持异店或异地还车。
- 租期至少 1 天、最多 30 天、至少提前 2 小时，固定按上海时区每 24 小时向上取整。顾客选择指定车型，实际车牌、颜色和车队车辆由后台分配。
- 车型列表使用双列真实车型参考图，展示座位、能源、变速箱、实时可租数量、日均租金和已含必缴费的预计总价；品牌筛选保留真实车标、热门品牌、搜索、拼音首字母分组和 A–Z 索引。
- 服务端统一计价：每日租金合计 + ¥60/天基础保障 + ¥35/单整备费 + 可选 ¥60/天安心保障 + 送取费。车辆押金按车型为 ¥3,000/¥5,000/¥8,000，违章押金统一 ¥2,000；两者仅作模拟预授权，单列且不计入应付金额。
- 周末日租默认上浮 15%，指定日期覆盖价优先。送取费为 ¥29 含单程 3km，超出后每开始 1km 加 ¥6，服务半径 20km；没有可信驾车路线时禁止生成送取报价，绝不用直线距离冒充。
- 报价有效 15 分钟，待支付订单同期占用门店 × 车型容量。订单状态固定为 `pending_payment → confirmed → ready_for_pickup → in_use → return_pending → completed`，旁路为 `cancelled/expired`；客户端只提交 `quoteId` 和驾驶员确认，金额由服务端快照决定。
- 运营后台“汽车租赁”提供“品牌车型 / 租赁门店 / 车队车辆 / 租赁价格 / 租车订单”五个页签，支持门店营业信息、车型参数图片、车辆维修/下线/退役、工作日/周末/日期价格、规则押金、车辆分配、履约推进、差额、内部备注和事件审计。
- 独立 `car_rental_*` 数据域保留 15 个品牌、46 个精确车型与可追溯实拍参考图，预置天津 3 个演示门店和 36 辆合成车队车辆；旧 `used_car_*` 表仅保留只读历史数据，不会自动转为租赁车辆。

> **明确边界**：这是合成演示租赁闭环。车型图片只保证参考车型一致，不对应交付车辆或 VIN；门店、车队、价格、押金、路线、政策和订单均不代表实时经营数据。本版本不接真实支付、信用免押、保险投保、证件 OCR、车联网、自助开锁或违章查询。

## B 端体验

### 检测站工作台

- 今日预约量、剩余容量、待到站和检测中数量。
- 时段压力提示和号源调整入口；容量不能低于已预约数量。
- “全部 / 待到站 / 已到站 / 检测中 / 已完成”筛选。
- 按时间排序的任务卡，下一任务提供清晰主操作。
- 晚到、资料异常和结果待回传使用可解释的异常标签，不用颜色代替文字。

### 单车履约详情

- 车牌、车型、预约人、时间、预约编号和来源。
- `预约确认 → 到站核验 → 交接检测 → 结果回传 → 服务完成` 五步进度。
- 车牌、材料、外观和车辆状态四项核验，配四张同一合成车辆的查验图。
- “车辆信息不一致”可挂起，记录原因，并在问题解决后恢复到原业务节点。
- 明示“检测设备软件属于外部系统，结果通过接口或人工上传回传”。

### 其他站端页面

- 订单页可筛选并回看今日与历史任务。
- 站点页展示营业时间、地址、联系电话、服务车型与合成数据声明。
- 右上角演示菜单可切换“车主端 / 检测站端”，但切换本身不签发或提升权限；没有有效站点会话时先进入检测站账号登录页。检测站端使用与车主隔离、固定绑定一个站点且可撤销的 Bearer；匿名后台 fallback 只存在于显式自动化测试环境。

## 预约状态机

```mermaid
stateDiagram-v2
    [*] --> pending_payment: 车主提交预约
    pending_payment --> confirmed: 支付成功自动确认
    confirmed --> driver_arranged: 后台安排司机并签发 6 位验证码（取送单）
    driver_arranged --> picked_up: 司机提交取车 5 张留证
    confirmed --> awaiting_arrival: 等待车主到站（自驾单）
    picked_up --> checked_in: 检测站提交到站 5 张留证与核验
    awaiting_arrival --> checked_in: 到站核验完成
    checked_in --> inspecting: 交接检测线
    inspecting --> result_received: 外部结果回传
    result_received --> returning: 司机从代驾任务页开始返程（取送单）
    returning --> completed: 司机提交送回 5 张留证
    result_received --> completed: 自驾单完成
    awaiting_arrival --> on_hold: 到站前资料或晚到异常
    checked_in --> on_hold: 信息或材料异常
    inspecting --> on_hold: 检测交接异常
    on_hold --> awaiting_arrival: 到站前异常已解决
    on_hold --> checked_in: 核验异常已解决
    on_hold --> inspecting: 检测异常已解决
    pending_payment --> cancelled: 取消
    confirmed --> cancelled: 未开始履约前取消/退款
    driver_arranged --> cancelled: 未取车取消
    awaiting_arrival --> cancelled: 取消
    awaiting_arrival --> no_show: 逾期未到站
```

| 状态 | 谁触发 | 用户可见含义 | 允许的下一步 |
| --- | --- | --- | --- |
| `pending_payment` | 车主 | 预约已创建，等待模拟支付 | 支付、取消 |
| `paid_pending_confirmation` | 历史兼容 | 旧版本已支付待确认，启动迁移会自动恢复 | 自动恢复为已确认、取消/退款 |
| `confirmed` | 支付接口 | 支付成功，订单已自动确认 | 安排司机或由检测站接单、取消、挂起 |
| `driver_arranged` | 后台 | 司机已安排，任务入口已签发 | 司机完成取车留证、取消、异常挂起 |
| `picked_up` | 代驾司机 | 已完成取车 5 张留证，车辆前往检测站 | 检测站接车留证、异常挂起 |
| `awaiting_arrival` | 检测站 | 站点已确认，等待车辆 | 到站、异常挂起、爽约、取消、改期 |
| `checked_in` | 检测站 | 车辆已到站并完成核验 | 交接检测、异常挂起 |
| `on_hold` | 检测站 | 当前业务阶段存在待处理异常 | 提交至少一项复核结果或处理说明后，恢复到挂起前阶段 |
| `inspecting` | 检测站 | 已交由外部检测线 | 接收结果、异常挂起 |
| `result_received` | 外部系统/检测站 | 检测结果与体检报告已发布；取送单等待司机返程 | 司机开始返程；自驾单完成交付 |
| `returning` | 代驾司机 | 车辆送回中 | 司机完成送回留证 |
| `completed` | 检测站或代驾司机 | 自驾结果已交付，或取送车辆已留证送达 | 查看结果、留证和提醒 |
| `cancelled` / `no_show` | 车主/检测站 | 终止态 | 无 |

非法迁移、重复操作和越权访问返回统一错误 envelope，不通过前端“乐观跳过”掩盖服务端规则。

## 异常与恢复策略

| 异常 | 检测与反馈 | 恢复策略 |
| --- | --- | --- |
| 车牌或车辆信息不一致 | 到站核验项失败，订单进入 `on_hold`，事件记录原因 | 更正档案或人工确认后 `resolve-hold` 回到 `checked_in` |
| 材料缺失 | 显示缺失项和处理建议 | 补齐材料后重新核验，不重新建单 |
| 晚到 / 爽约 | 工作台显示晚到；超过演示阈值可标记 `no_show` | 未结束前可由站端继续接待；终止后重新预约 |
| 时段容量冲突 | 服务端比较新容量与 `booked_count` | 低于已预约数返回 `409`，保留原容量 |
| 结果重复回传 | 以 `Idempotency-Key` 与外部结果编号判重 | 同键同载荷返回首次结果；冲突载荷拒绝并留痕 |
| 回传签名失败 | 服务端验证 HMAC 与时间窗 | 返回 `401`，不写入结果、不推进状态 |
| API 暂时不可用 | UI 明确提示未连接 | 恢复后重新读取服务端状态；不把离线状态伪装成生产成功 |
| 腾讯路线不可用 | 返回 `REAL_ROUTE_REQUIRED` 及细分错误码 | 禁止取送报价、下单和支付；允许切换自驾到站，不回退估算计价 |

## 技术架构

```mermaid
flowchart TB
    subgraph Clients["客户端"]
        CUI["移动 Web C 端"]
        BUI["B 端工作台与履约详情"]
        Mini["原生微信小程序"]
        Admin["桌面运营后台"]
    end

    subgraph Service["Fastify 服务层"]
        Rest["REST API + Zod"]
        Auth["Bearer 会话解析 / 资源归属"]
        Machine["预约状态机"]
        Verify["核验与异常服务"]
        Inbound["结果回传签名、幂等与模拟器"]
        Rest --> Auth
        Rest --> Machine
        Rest --> Verify
        Rest --> Inbound
    end

    subgraph Data["PostgreSQL（本地或托管）"]
        Identity["users / user_identities / user_sessions"]
        Tables["车辆 / 站点 / 时段 / 预约 / 洗车 / 车险 / 汽车租赁 / 审计"]
        Seeds["可重置的跨用户合成种子"]
        Identity --> Tables
        Seeds --> Tables
    end

    CUI -->|"JSON /api + Bearer"| Rest
    Mini -->|"JSON /api；未来 code 换会话"| Rest
    BUI -->|"JSON /api"| Rest
    Admin -->|"JSON /api"| Rest
    Auth --> Identity
    Machine --> Tables
    Verify --> Tables
    Inbound --> Tables
    External["外部检测线软件（仓库外）"] -->|"HMAC 结果"| Inbound
```

实现要点：

- 前后端共享车牌解析规则，数据库以无分隔符规范值建立唯一约束。
- PostgreSQL 是唯一应用数据库；连接池和所有跨多次写入的状态流转由服务端事务承接，事务回调始终使用同一数据库连接。
- 金额以分存储，时间以 ISO 字符串存储，界面按 `Asia/Shanghai` 展示。
- `booking_events` 记录 `actorType`、时间与结构化元数据，保留业务审计语义。
- 演示重置生成固定站点下多个合成车主的今日任务；C 端只能读取当前服务端会话所映射内部用户的车辆与订单。
- 前端绝不持有外部结果签名密钥；“模拟结果”调用服务端模拟器。

### 身份与无感登录边界

“没有可见登录页”不等于“匿名访问”。当前车主域以 `users` 作为内部主体，以 `user_identities` 映射外部身份，以 `user_sessions` 保存可撤销会话；客户端携带 `Authorization: Bearer <token>`，服务端只保存 token 哈希，并由 `requireCurrentUser` 得到可信 `user_id` 后再查询车辆、报价和订单。客户端请求体或查询参数中的 `user_id`、`openid`、`unionid` 一律不能作为资源归属依据。

移动 Web 本地开发可以显式设置 `YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK=true`，让无 Bearer 请求无感映射到 `demo-user`；该 fallback 在生产环境始终失效。若需要显式取得本地开发 token，还必须在非生产环境开启 `YUXIAOMAN_ENABLE_DEVELOPMENT_AUTH=true` 后调用开发会话接口。正式 Web 应由受信任身份提供方完成认证，再由服务端签发同一种应用 Bearer 会话。

原生微信小程序已接入正式无感身份链路：小程序调用 `wx.login()` 获得一次性 `code` → 只把 `code` 交给驭小满服务端 → 服务端使用 `WECHAT_MINIPROGRAM_APP_ID` 与仅服务端保存的 `WECHAT_MINIPROGRAM_APP_SECRET` 调用微信 `code2Session` → 按 `provider + provider_app_id + provider_subject` 幂等查找或创建真实内部客户 → 只向小程序签发驭小满自己的 Bearer。`provider_app_id` 参与唯一键；服务端验证后的唯一 `unionid` 只用于安全跨 AppID 关联，冲突时拒绝自动合并。接口永不返回 `openid`、`unionid`、`session_key` 或 AppSecret。两项微信环境变量缺失时 `/api/auth/wechat/session` 返回 `503`；生产环境始终禁用 demo fallback。

## 数据模型

```mermaid
erDiagram
    USERS ||--o{ USER_IDENTITIES : "绑定外部身份"
    USERS ||--o{ USER_SESSIONS : "签发应用会话"
    USERS ||--o{ VEHICLES : "拥有车辆"
    USERS ||--o{ BOOKINGS : "创建预约"
    VEHICLES ||--o{ BOOKINGS : "被预约"
    VEHICLES ||--o| REMINDER_PREFERENCES : "配置提醒"
    STATIONS ||--o{ STATION_SLOTS : "提供号源"
    STATIONS ||--o{ BOOKINGS : "承接服务"
    STATION_SLOTS ||--o{ BOOKINGS : "占用"
    BOOKINGS ||--o{ BOOKING_EVENTS : "记录状态与操作者"
    BOOKINGS ||--o| BOOKING_VERIFICATIONS : "记录到站核验"
    BOOKINGS ||--o| INSPECTION_RESULTS : "接收外部结果"

    USERS {
        text id PK
        text display_name
        text avatar_url
        text status
        text created_at
        text updated_at
    }

    USER_IDENTITIES {
        text id PK
        text user_id FK
        text provider
        text provider_app_id
        text provider_subject
        text union_subject
    }

    USER_SESSIONS {
        text id PK
        text user_id FK
        text token_hash UK
        text expires_at
        text revoked_at
        text last_seen_at
    }

    VEHICLES {
        text id PK
        text user_id
        text plate_number
        text plate_normalized UK
        text vehicle_type
        text usage_nature
        integer seats
        text registration_date
        text inspection_due_date
        integer is_default
        text deleted_at
    }

    STATIONS {
        text id PK
        text name
        text district
        text address
        text open_hours
        integer service_fee_fen
    }

    STATION_SLOTS {
        text id PK
        text station_id FK
        text date
        text start_time
        text end_time
        integer capacity
        integer booked_count
    }

    BOOKINGS {
        text id PK
        text booking_number UK
        text user_id
        text vehicle_id FK
        text station_id FK
        text slot_id FK
        text status
        text appointment_date
        text start_time
        text end_time
    }

    BOOKING_EVENTS {
        text id PK
        text booking_id FK
        text status
        text actor_type
        text title
        text description
        text metadata_json
        text created_at
    }

    BOOKING_VERIFICATIONS {
        text booking_id PK,FK
        integer plate_matched
        integer materials_ready
        integer exterior_recorded
        integer condition_confirmed
        text notes
        text verified_at
    }

    INSPECTION_RESULTS {
        text id PK
        text booking_id FK
        text external_result_id UK
        text conclusion
        text summary_json
        text source
        text received_at
        text idempotency_key UK
        text request_hash
    }
```

### 洗车独立数据表

洗车采用同一 PostgreSQL 实例内的独立领域表和外键，不把门店、套餐或订单混入年检的 `stations`、`station_slots` 与 `bookings`。`migrateWashDatabase` 以可重复执行的增量迁移扩展既有年检 schema；演示种子标记为 `wash-seed-v1`。

```mermaid
erDiagram
    VEHICLES ||--o{ WASH_QUOTE_SNAPSHOTS : "生成报价"
    VEHICLES ||--o{ WASH_ORDERS : "预约洗车"
    WASH_STORES ||--o{ WASH_STORE_OFFERS : "配置价格"
    WASH_STORES ||--o| WASH_STORE_VALET_PRICING_OVERRIDES : "覆盖代驾规则"
    WASH_PACKAGES ||--o{ WASH_STORE_OFFERS : "按车型售卖"
    WASH_STORES ||--o{ WASH_STORE_IMAGES : "维护有序相册"
    WASH_STORES ||--o{ WASH_SLOTS : "提供号源"
    WASH_SLOTS ||--o{ WASH_QUOTE_SNAPSHOTS : "冻结时段"
    WASH_QUOTE_SNAPSHOTS ||--o| WASH_ORDERS : "幂等下单"
    WASH_ORDERS ||--o{ WASH_ORDER_EVENTS : "审计状态"
    WASH_ORDERS ||--o{ WASH_ORDER_PAYMENTS : "记录模拟收退"
    WASH_ORDERS ||--|| WASH_ORDER_SETTLEMENTS : "登记线下结算"
```

| 表/字段 | 责任边界 |
| --- | --- |
| `vehicles.wash_vehicle_category` | 可空洗车价类：`sedan` / `suv` / `mpv`；历史 `suv_mpv` 在迁移时按可验证车型信息拆分，不改变年检车辆事实 |
| `wash_stores` | 演示门店资料、营业时间、坐标、启停与排序 |
| `wash_store_images` | 门店最多 20 张服务端处理图片、展示顺序与唯一封面；不保存客户端文件名或公开存储路径 |
| `wash_packages` | 标准洗车、精致洗护等套餐内容、时长与启停 |
| `wash_store_offers` | 门店 × 套餐 × 车型价类的售价、划线价、预计结算价与可售状态 |
| `wash_slots` | 门店日期、开始/结束时间、容量和开放状态 |
| `wash_store_valet_pricing_overrides` | 洗车门店可选整套覆盖全局往返代驾规则；删除后恢复继承 |
| `wash_quote_snapshots` | 10 分钟不可变报价，冻结车辆/门店/套餐/时段、服务方式、取送地址、真实路线和费用规则版本 |
| `wash_orders` | 15 分钟待支付占位、六态订单、六位核销码、服务方式、取送地址、路线与全量价格快照 |
| `wash_order_events` | 车主、运营或系统事件；人工核销记录来源、操作人和备注 |
| `wash_order_payments` | 本地 `mock` charge/refund 与幂等键，不代表真实资金流水 |
| `wash_order_settlements` | `unsettled/settled/void` 线下对账登记、实际金额、备注与修正原因 |

## API 契约

业务接口成功响应：`{ "data": ... }`；错误响应：`{ "error": { "code", "message", "fields?" } }`。身份会话接口是基础设施例外：创建/查询会话直接返回会话对象，退出成功返回 `204`。

### C 端与公共接口

| 方法 | 路径 | 主要行为 |
| --- | --- | --- |
| `POST` | `/api/auth/wechat/session` | 以一次性微信 `code` 换取应用 Bearer；成功仅返回 `token` 与 `expiresAt` |
| `POST` | `/api/auth/development/session` | 仅非生产且显式开启时签发本地开发 Bearer 会话 |
| `GET/DELETE` | `/api/auth/session` | 查询当前会话或撤销 Bearer 会话 |
| `GET` | `/api/health` | 服务健康检查 |
| `GET/POST` | `/api/vehicles` | 获取或创建当前服务端会话所属车主的车辆 |
| `GET/PATCH/DELETE` | `/api/vehicles/:id` | 获取、编辑或软删除车辆；进行中订单阻止删除 |
| `GET` | `/api/inspection/status/:vehicleId` | 返回演示资格、材料、办理窗口与规则来源 |
| `GET` | `/api/stations` | 华洋优先置顶；其余站点按真实路线距离或明确标注的演示距离展示 |
| `GET` | `/api/stations/:id/slots` | 获取站点日期、容量和剩余号源 |
| `POST` | `/api/bookings/quote` | 受控车型匹配与不可变报价快照；取送必须是腾讯真实驾车矩阵 |
| `GET/POST` | `/api/bookings` | 获取当前会话车主订单或创建预约；客户端不能指定可信 `user_id` |
| `GET` | `/api/bookings/:id` | 当前车主读取订单、核验、结果和事件时间轴 |
| `POST` | `/api/bookings/:id/payments` | 幂等记录本地 `mock` 支付，不发生真实扣款 |
| `POST` | `/api/bookings/:id/cancel` | 在允许状态取消并释放号源 |
| `POST` | `/api/bookings/:id/reschedule` | 原子切换旧/新时段 |
| `POST` | `/api/demo/reset` | 恢复跨角色合成演示数据 |

### 洗车消费者接口

| 方法 | 路径 | 主要行为 |
| --- | --- | --- |
| `GET` | `/api/wash/stores?originLat&originLng` | 获取启用门店的完整车主安全详情、封面与有序相册；可返回明确标注为估算的距离，不返回内部联系人 |
| `GET` | `/api/wash/stores/:id` | 获取单个启用门店的完整详情、营业信息、设施、标签、封面与有序相册 |
| `GET` | `/api/wash/store-images/:id` | 读取服务端校验、旋转、缩放并重编码后的门店 JPEG 图片 |
| `GET` | `/api/wash/stores/:id/offers?vehicleCategory=sedan\|suv\|mpv` | 获取门店套餐、服务内容、售价与预计结算价；兼容 `vehicleType` 查询别名 |
| `GET` | `/api/wash/stores/:id/slots?date&packageId` | 获取容量、已占用数和剩余量；读取时同步释放已过期待支付占位 |
| `POST` | `/api/wash/quotes` | 以 `{ vehicleId, storeId, packageId, slotId, vehicleCategory?, serviceMode, tripType?, pickupAddress? }` 创建 10 分钟冻结报价；代驾只接受真实腾讯驾车路线 |
| `GET/POST` | `/api/wash/orders` | 查询当前车主订单，或以 `{ quoteSnapshotId, idempotencyKey, contactName, contactPhone, notes? }` 幂等下单 |
| `GET` | `/api/wash/orders/:id` | 当前车主读取订单、模拟收退记录、结算和事件时间轴 |
| `POST` | `/api/wash/orders/:id/payments` | 以 `{ provider: "mock", idempotencyKey }` 确认模拟支付；成功后才返回六位 `redemptionCode` |
| `POST` | `/api/wash/orders/:id/cancel` | 取消待支付订单，或对已支付待核销订单执行模拟退款；核销码同步失效 |
| `POST` | `/api/wash/orders/:id/reschedule` | 以 `{ slotId }` 原子改期并重新检查容量与同车时间冲突 |

洗车订单按使用方返回显式白名单 DTO。车主与平台管理员可读取自身业务所需的取送地址、费用拆分、支付/结算与核销信息；洗车店管理员只得到本店订单的车牌、车型、套餐、时段、服务方式、金额和状态，不返回姓名、手机号、代驾地址、核销码或平台备注。年检预约继续返回 `serviceType: "annual_inspection"`，既有字段保持兼容。

### B 端检测站接口

| 方法 | 路径 | 主要行为 |
| --- | --- | --- |
| `POST` | `/api/operator/sessions` | 检测站实名账号登录并签发仅供原生小程序使用的可撤销站点 Bearer |
| `GET/DELETE` | `/api/operator/session` | 校验当前检测站会话，或撤销当前站点 Bearer |
| `GET` | `/api/operator/workbench` | 返回当前会话绑定检测站的摘要、时段压力和今日任务；平台 Cookie 可显式指定站点 |
| `GET` | `/api/operator/bookings/:id` | 获取本站单车履约详情；跨站访问拒绝 |
| `POST` | `/api/operator/bookings/:id/accept` | `confirmed → awaiting_arrival` |
| `POST/DELETE` | `/api/operator/bookings/:id/evidence/station_arrival/media[/:mediaId]` | 新版代驾单按固定位置上传、重拍或删除检测站接车留证 |
| `POST` | `/api/operator/bookings/:id/evidence/station_arrival/complete` | 5 张到站留证与四项核验同事务封存，并自动进入 `checked_in` |
| `POST` | `/api/operator/bookings/:id/check-in` | 自驾及历史订单保存四项核验并进入 `checked_in`；新版代驾必须走留证接口 |
| `POST` | `/api/operator/bookings/:id/hold` | 核验异常进入 `on_hold`，记录结构化原因 |
| `POST` | `/api/operator/bookings/:id/resolve-hold` | 提交复核结果或处理说明，恢复到挂起前状态 |
| `POST` | `/api/operator/bookings/:id/handoff` | `checked_in → inspecting`，交接外部检测线 |
| `POST` | `/api/operator/bookings/:id/complete` | 自驾或历史订单 `result_received → completed`；新版代驾只能由已绑定司机送回完成 |
| `PATCH` | `/api/operator/station-slots/:id` | 调整未来容量；不得低于已预约数 |
| `POST` | `/api/demo/operator/bookings/:id/simulate-result` | 服务端生成并回传合成结果 |

### 运营后台接口

所有 `/api/admin/*` 与 `/api/operator/*` 都先验证独立后台身份；未登录返回 `401`，模块能力不足返回 `403`，跨主体资源返回 `404`。桌面后台使用 HttpOnly Cookie，生产写请求要求来自 `BACKOFFICE_ALLOWED_ORIGINS` 中的 HTTPS Origin；原生检测站端只接受专用站点 Bearer，因不携带 Cookie 而不使用浏览器 CSRF Origin 校验，但仍执行同一能力和站点范围检查。

| 方法 | 路径 | 主要行为 |
| --- | --- | --- |
| `POST/GET/DELETE` | `/api/backoffice/sessions`、`/api/backoffice/session` | 实名登录、读取固定会话 DTO、退出并撤销当前会话 |
| `POST` | `/api/backoffice/activations` | 消费 24 小时一次性激活或重置链接，设置至少 12 位密码 |
| `PUT` | `/api/backoffice/password` | 校验当前密码、改密并撤销账号的全部旧会话，再颁发新会话 |
| `GET/POST` | `/api/admin/backoffice/accounts`、`/api/admin/backoffice/accounts/invitations` | 平台查询账号或创建一次性邀请 |
| `POST` | `/api/admin/backoffice/accounts/:id/disable` | 停用账号、撤销绑定/邀请/会话 |
| `POST` | `/api/admin/backoffice/accounts/:id/password-reset` | 生成仅展示一次的密码重置链接并立即撤销旧会话 |
| `POST` | `/api/admin/backoffice/accounts/:id/replacements` | 邀请新管理员；新账号激活事务中原子切换旧管理员 |
| `GET` | `/api/admin/audit-events?page&pageSize` | 平台读取全量永久日志；服务商自动限定为本人、本店 |

| 方法 | 路径 | 主要行为 |
| --- | --- | --- |
| `GET/POST/PUT` | `/api/admin/stations[/:id]` | 站点资料、自营/置顶/排序、营业时间、联系方式和站点价格 |
| `GET/POST/PUT/DELETE` | `/api/admin/inspection-price-plans[/:id]` | 维护受控车型匹配条件与检验项目；删除为停用 |
| `GET/PUT` | `/api/admin/valet-rules` | 全局往返取送默认规则 |
| `GET/PUT/DELETE` | `/api/admin/stations/:id/valet-rule` | 单站整套覆盖、查询或恢复继承 |
| `GET/PATCH` | `/api/admin/bookings[/:id]` | 交易查询、履约推进、司机备注、附加费和退款账目 |
| `POST/DELETE` | `/api/admin/bookings/:id/driver-assignment` | 安排/更换司机并生成 6 位验证码；创建回包及后台单笔详情可查看明文至任务完成，新单不再生成旧 `taskCode/scene`；取车前可撤销，后台不能替司机推进留证节点 |

### 代驾执行端接口

代驾执行端仍属于同一微信小程序，但使用与车主、后台隔离的任务级 Bearer。司机可从固定入口输入后台生成的 6 位数字码：未绑定时 24 小时有效，首次成功后绑定当前微信身份；该身份可在任务完成前重复输入原码换取新会话，其他身份、过期、撤销和未知码统一返回不可枚举的 `404`。连续失败按微信用户与来源 IP 双桶限流。

数字码仅以 HMAC 与 AES-256-GCM 密文落库，后台订单列表、车主端、检测站端和司机任务 DTO 均不暴露明文；只有安排司机回包和后台单笔详情在任务完成前解密显示。旧版可直接用于微信小程序码 `scene` 的短期不透明任务码及内部页面路径继续兼容。正式 URL Link、小程序码图片仍由部署方使用生产 AppID/Secret 调用微信官方接口生成，不在仓库中保存平台密钥。

| 方法 | 路径 | 主要行为 |
| --- | --- | --- |
| `POST` | `/api/driver/task-sessions/exchange` | 用 `{ verificationCode }` 绑定/续领单订单 Driver Bearer；兼容旧 `{ taskCode }` 深链兑换 |
| `GET` | `/api/driver/tasks/:id` | 只返回当前绑定任务的车辆、联系人、取送地址、站点、进度和四阶段留证 |
| `POST/DELETE` | `/api/driver/tasks/:id/evidence/:stage/media[/:mediaId]` | 司机仅可编辑 `owner_pickup` 或 `owner_return` 的固定 5 个现场相机槽位 |
| `POST` | `/api/driver/tasks/:id/evidence/:stage/complete` | 5 张齐全后幂等封存，并原子推进为 `picked_up` 或 `completed` |
| `POST` | `/api/driver/tasks/:id/start-return` | 仅在报告及检测完成留证发布后幂等推进 `result_received → returning` |

### 洗车运营后台接口

| 方法 | 路径 | 主要行为 |
| --- | --- | --- |
| `GET/POST` | `/api/admin/wash/stores` | 查询或新增洗车门店；新增必须提交带 `locationProof` 的地址候选，服务端派生地址和坐标 |
| `PUT/DELETE` | `/api/admin/wash/stores/:id` | 更新门店时缺省保留原定位，提交可信 `location` 才换址；无订单历史时硬删除，有历史时安全归档，活动订单阻止删除 |
| `POST/PUT` | `/api/admin/wash/stores/:id/images` | 上传 JPEG/PNG/WebP（单张最大 10MB）并服务端重编码，或批量调整图片顺序与唯一封面 |
| `DELETE` | `/api/admin/wash/stores/:id/images/:imageId` | 删除门店图片；删除封面时自动选择下一张，删除最后一张后清空封面 |
| `GET/PUT/DELETE` | `/api/admin/wash/stores/:id/valet-rule` | 查询继承后的往返代驾规则、创建门店整套覆盖或恢复继承全局规则 |
| `GET/POST` | `/api/admin/wash/packages` | 查询或新增洗车套餐 |
| `GET/PUT/DELETE` | `/api/admin/wash/packages/:id` | 查询、更新或停用套餐，并同步停止相关可售报价 |
| `GET/PUT` | `/api/admin/wash/stores/:id/offers` | 查询或整表替换门店的车型套餐价格矩阵，持久化 `estimatedSettlementFen` |
| `GET/POST` | `/api/admin/wash/slots` | 按门店/日期查询号源或创建单个号源；查询传入 `page/pageSize` 时返回带主体内总数的分页结果 |
| `POST` | `/api/admin/wash/slots/batch` | 按日期范围、星期、营业时段、粒度和容量批量生成号源 |
| `PATCH/PUT/DELETE` | `/api/admin/wash/slots/:id` | 调整容量/开放状态或删除无订单历史号源；不得破坏现有占位 |
| `GET` | `/api/admin/wash/orders` | 按日期、门店、订单/结算状态或订单号筛选；平台可按六位码筛选，`page/pageSize` 返回带主体内总数的分页结果 |
| `GET/PATCH` | `/api/admin/wash/orders/:id` | 查询详情；受控取消、退款或更新内部备注 |
| `POST` | `/api/admin/wash/orders/redeem` | 以 `{ code, source, note? }` 人工核销；同单重复请求幂等，服务商失败尝试按账号、固定门店和来源 IP 限流 |
| `GET` | `/api/admin/wash/settlements` | 按门店、状态和日期查询对账结果；服务商只读本店，`page/pageSize` 返回带主体内总数的分页结果 |
| `PUT` | `/api/admin/wash/orders/:id/settlement` | 登记实际 `amountFen`、`note`；修正已结算记录需 `correctionReason` |

门店基础资料接口不接受客户端直接写入 `coverImageUrl`：新门店初始无封面，编辑旧门店保留原封面，只有相册上传/排序/设封面/删除接口可以改变受控封面。停用门店不会继续通过公开图片直链分发相册，但运营后台仍可查看并维护；服务启动与演示重置会在受控目录内回收无数据库引用的 UUID JPEG 孤儿文件。

统一桌面后台是洗车运营与服务商协作的唯一维护入口。平台管理员使用完整洗车订单、门店、套餐、代驾规则和结算能力；洗车店管理员登录后只看到固定主体卡和本店能力。平台订单抽屉可以展示不可变取送地址、腾讯单程距离和费用拆分，服务商响应和界面则移除车主联系方式、取送地址、核销码及平台内部字段。所有核销和结算操作都以服务端解析的实名账号写入永久审计事件。

### 外部结果回传

`POST /api/integrations/inspection-results`

```http
Idempotency-Key: result-demo-0001
X-Yuxiaoman-Timestamp: 1786406400
X-Yuxiaoman-Signature: sha256=<hmac-sha256-hex>
Content-Type: application/json
```

```json
{
  "bookingId": "booking-demo-001",
  "externalResultId": "EXT-20260811-001",
  "conclusion": "passed",
  "summary": {
    "overall": "合格",
    "items": ["外观检查", "安全技术检验", "排放检验"]
  },
  "source": "demo-inspection-line"
}
```

契约规则：

1. 签名原文为 ``timestamp.${stableSortedJson(body)}``：请求体递归按键名稳定排序后再序列化，避免 JSON 键顺序导致同一语义产生不同签名。服务端以演示密钥计算 HMAC-SHA256 并做常量时间比较；生产环境必须由密钥管理系统替代本地演示密钥。
2. 时间戳必须处于允许时间窗，降低重放风险。
3. `Idempotency-Key` 必填。相同键和相同载荷返回首次写入结果；相同键不同载荷返回 `409`。
4. 只有 `inspecting` 预约可接收首次结果，成功后原子写入 `inspection_results`、追加 `booking_events` 并推进到 `result_received`。
5. 浏览器端只调用模拟器接口，不接触签名密钥。

## 视觉系统与固定基准

| 基准 | 文件 | 用途 |
| --- | --- | --- |
| C 端首页 | `references/selected-owner-home-v2.png` | 蓝白通透品牌、年检双主动作、四阶段入口、3 × 2 服务与三 Tab |
| C 端洗车 | `references/selected-wash-booking-ui.png` | 单屏快订、套餐价格、演示门店、到店时段与固定总价 CTA |
| C 端车险 | `references/insurance-lead-selected.png` | 蓝白高级感、低密度续保留资与固定安全区 CTA |
| C 端租车 | `references/car-rental-search-selected.png` | 搜索先行、两种取还方式、时间地点摘要、透明计价与指定车型卡 |
| B 端工作台 | `references/operator-workbench-visual-reference.png` | 经营摘要、筛选与任务列表 |
| B 端详情 | `references/operator-booking-detail-visual-reference.png` | 单车履约、核验、图片和操作层级 |

核心 Token：雾白背景、深墨文字、品牌钴蓝、浅冰蓝、提醒橙、成功绿和错误红；卡片与 Bottom Sheet 使用 14–24px 圆角和轻量阴影。字体使用 `Noto Sans SC` / 系统无衬线，图标使用 Phosphor 线性图标。所有状态、文字和按钮由真实组件渲染，不把截图文字作为界面内容。

## 测试与验收

| 检查 | 覆盖范围 |
| --- | --- |
| 车牌领域单测 | 31 省级简称、蓝/小绿/大绿结构、`D/F` 位置、`I/O` 禁用、规范化与错误结构 |
| API 测试 | 在真实 PostgreSQL 隔离 schema 中运行年检、身份、洗车、车险与汽车租赁回归；覆盖事务、归属隔离、模式闸门、幂等、容量锁定、报价计费、状态流转、审计和自动清理 |
| 自动化规格 | 年检双端履约、洗车预约与后台；车险表单与后台闭环；微信租车的模式/日期/枚举/API 契约；租赁后台的图片、CRUD、调价、派车与履约动作 |
| 视觉 QA | 租车固定在 390×844，通用设备同时覆盖 393×852 与 427×952；同状态比较基准并检查层级、密度、溢出、安全区、键盘、上传和固定 CTA |
| 交付门槛 | 运行时完整性、类型检查、API 测试、生产构建、Sites 兼容与控制台零错误 |

### PostgreSQL 本地、托管与测试配置

PostgreSQL 是当前唯一受支持的应用数据库。开发者可以使用本机 PostgreSQL，也可以使用提供标准连接串的托管 PostgreSQL；两种方式都必须先创建运行库和独立测试库，再把连接信息放进 `.env`。托管环境应按供应商要求启用 TLS、使用最小权限账号并通过部署平台注入密钥，不要把生产凭据提交到仓库。

```dotenv
DATABASE_URL=postgresql://app_user:change-me@127.0.0.1:5432/yuxiaoman
TEST_DATABASE_URL=postgresql://test_user:change-me@127.0.0.1:5432/yuxiaoman_test
YUXIAOMAN_DB_SCHEMA=public
PGPOOL_MAX=10
PG_STATEMENT_TIMEOUT_MS=10000
TRUST_PROXY=false

# 只供本地 Web 无感演示；生产环境即使误配也不会启用。
YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK=true
```

`DATABASE_URL` 供 API 启动与迁移使用；非生产环境会继续生成合成演示种子，`NODE_ENV=production` 或 `YUXIAOMAN_ENV=production` 时默认只建表、不写入测试车辆、订单或库存。`TEST_DATABASE_URL` 必须指向非生产数据库，且测试账号需要创建和删除 schema 的权限；测试启动时还会拒绝与 `DATABASE_URL` 指向同一 host、port 和 database 的配置。API 测试会在这个真实 PostgreSQL 数据库内为每个 fixture 创建随机隔离 schema，结束后删除，不使用内存数据库或 SQL 模拟器。运行开发服务或测试前必须确保对应 PostgreSQL 可连接；应用不会回退到本地文件数据库。

`TRUST_PROXY` 默认关闭。只有 API 位于明确受控的反向代理之后时，才填写 `loopback`、具体代理 IP 或逗号分隔的可信 CIDR；服务端拒绝 `true`、主机名和 `0.0.0.0/0`/`::/0`，防止客户端伪造转发地址绕过验证码限流。

```bash
npm install
npm run dev:full
# 另开一个终端启动桌面运营后台
npm run admin:dev
# 首次部署：密码只通过临时环境变量注入，不生成默认密码
BACKOFFICE_ADMIN_PASSWORD='<至少 12 位临时密码>' npm run backoffice:create-admin -- --login platform.admin --display-name '平台管理员'

npm run check:runtime
npm run typecheck
npm run api:test
npm run test:runtime
npm run admin:test
npm run build:all
npm run test:sites
```

### 洗车运行与验收入口

- 本地运行：执行 `npm run dev:full`，在移动 Web 的首页进入“车主服务 → 洗车预约”；另开终端执行 `npm run admin:dev`。桌面后台必须使用显式创建或邀请的实名账号登录；测试环境的合成平台身份仅能通过专用测试开关启用，生产环境始终忽略。生产环境的取车地点防篡改凭证使用独立的 `WASH_LOCATION_PROOF_SECRET`。
- 自动验收：执行 `npm run api:test`。洗车用例与全部年检回归在同一套测试中运行；交付时不得只跑洗车定向用例。
- 运营界面验收：执行 `npm run admin:test`，再检查门店地址搜索选点与只读坐标、套餐服务项、车型价格矩阵、预计结算价、批量号源、订单筛选、人工核销和结算登记。
- 全量交付门槛仍为 `npm run check:runtime`、`npm run typecheck`、`npm run api:test`、`npm run test:runtime`、`npm run admin:test`、`npm run build:all` 与 `npm run test:sites`，洗车功能不能降低既有年检门槛。

建议手工验收顺序：

1. 确认消费者端只展示三家名称带“演示”的门店；小轿车、SUV、MPV 分别读取独立价格记录。演示初始价为小轿车 3800/8800 分、SUV 4800/10800 分、MPV 5800/12800 分，并验证后台继续调价后两个客户端不会串价。
2. 分别选择自驾和代驾：代驾地址必须来自带服务端凭证的联想/地图解析结果，并展示腾讯真实单程距离、往返已含、洗车费/代驾费/总价；路线失败、凭证篡改、超半径或缺规则时均应阻止下单。
3. 创建报价与待支付订单，确认报价有效 10 分钟、订单占位 15 分钟，且支付前 `redemptionCode` 为空。
4. 完成明确标注的模拟支付，确认出现唯一六位数字码；平台使用错误码核销返回受控无效响应，服务商对他店码、无效码和失效码统一表现为不存在，连续失败会触发 `429` 限流。
5. 进入运营后台，输入六位码并记录来源、操作人和备注；重复核销同一订单不产生第二次状态推进。
6. 仅对 `redeemed` 订单登记实际结算金额与备注；再次修改时不填修正原因应被拒绝。
7. 分别验证待支付过期、容量约满、改期、未支付取消和已支付退款；取消/退款后原码必须无法核销。

### 车险运行与验收入口

- 车主端从首页“保险服务”进入，或在本地直接打开 `/?screen=insurance`；运营后台从左侧导航进入“车险线索”。
- 演示模式使用合成资料，手机号只能填写 `13800138000` 或 `13900000000`；车险线索没有模块独立密码，但必须先以平台管理员登录统一后台。
- 公开接口为 `GET /api/insurance/disclosure`、`POST /api/insurance/leads`（`multipart/form-data` 且要求 `Idempotency-Key`）和 `POST /api/insurance/leads/:withdrawToken/withdraw`；后台接口统一位于 `/api/admin/insurance/*`，不再提供车险专用 session 接口。
- 真实内测前必须在 `.env` 同时配置 `INSURANCE_REAL_MODE=true`、HTTPS 的 `INSURANCE_PUBLIC_BASE_URL`、数据/HMAC 密钥和明确合作方披露字段；缺少任一配置会 fail closed，不会静默降级后接收真实资料。
- 手工验收顺序为：披露 → 留资与图片 → 授权 → 凭证/撤回；再进入后台车险线索 → 脱敏列表 → 审计详情/图片 → 复制摘要 → 确认转交 → 关闭。

当前隔离 Web 运行地址：移动 Web `http://127.0.0.1:18601`，运营后台 `http://127.0.0.1:18602`，API `http://127.0.0.1:18600/api`；这三个 Web 演示服务都只绑定 `127.0.0.1`。原生小程序真机联调使用另一套专用入口 `npm run api:mini`（或地图桩入口 `npm run api:mini:qa-map`），固定监听 `0.0.0.0:8792`；手机请求地址应填写开发机局域网 IP，而不是 `0.0.0.0`。普通 `npm run api:dev` 仍遵循 `.env` 的 `HOST`，不替代真机联调入口。

复制 `.env.example` 为 `.env` 后，先配置可连接的 `DATABASE_URL` 与独立 `TEST_DATABASE_URL`，再按需要设置 `TENCENT_MAP_KEY`。没有可用 Key 时仍可完整演示自驾预约，但上门往返取送会被阻止；任何估算路线都不能生成真实报价。`YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK=true` 只应用于非生产 Web 演示；关闭它后，车主接口必须携带有效 Bearer 会话。`PAYMENT_PROVIDER=mock` 仅供本地开发，生产环境默认拒绝模拟支付，除非显式设置 `ALLOW_MOCK_PAYMENT=true`。写入型演示履约接口仅在 `ALLOW_DEMO_WORKFLOW=true` 时开放，数据重置还必须单独设置 `ALLOW_DEMO_RESET=true`。检验项目金额是套餐总价的内部审计分摊，不代表项目可单独收费。图片默认保存在 `data/uploads`，仅适合本地演示；数据库数据由 PostgreSQL 持久化，不写入该目录。

自动化中的业务日期固定为 `2026-08-11`，保证今日队列和截图断言稳定；正常运行时按 `Asia/Shanghai` 动态生成业务日期。

## 指标体系

MVP 未接真实埋点 SDK，以下定义用于说明上线后的决策框架。

| 指标 | 定义 | 业务用途 |
| --- | --- | --- |
| 车辆档案完成率 | 成功保存车辆的用户数 ÷ 开始添加车辆的用户数 | 判断领域输入是否降低建档摩擦 |
| 预约提交率 | 成功创建预约数 ÷ 到达订单确认页会话数 | 衡量 C 端主漏斗 |
| 到站率 | `checked_in` 及后续订单数 ÷ `awaiting_arrival` 订单数 | 判断预约质量与提醒价值 |
| 准时开检率 | 预约开始后阈值内进入 `inspecting` 的订单数 ÷ 已到站订单数 | 判断站端衔接效率 |
| 平均履约时长 | `completed_at - checked_in_at` 的平均值 | 识别现场流程瓶颈 |
| 结果回传延迟 | `result_received_at - inspecting_at` 的 P50 / P90 | 评估外部系统交接质量 |
| 时段利用率 | 已预约数量 ÷ 可用容量 | 平衡服务供给与等待体验 |
| 爽约率 | `no_show` 订单数 ÷ 已确认订单数 | 优化提醒、取消和候补策略 |

护栏指标：取消率、异常挂起率、签名失败率、重复回传冲突率、车牌校验失败率和 API 错误率。不要只追求预约量而牺牲到站与履约质量。

## 5 分钟面试演示脚本

| 时间 | 演示动作 | 讲述重点 |
| --- | --- | --- |
| `0:00–0:35` | 打开 C 端首页，展示车辆、办理窗口与主动作 | 低频事项先给确定性，不让用户自己拼规则 |
| `0:35–1:05` | 打开车辆管理，对比蓝牌 7 格、小/大型绿牌 8 格和 `D/F` 位置 | 将复杂规则抽成共享领域模块，让非法状态难以产生 |
| `1:05–1:40` | 资格、材料、站点、时段、确认并提交预约 | C 端先消除信息不确定，再完成交易式动作 |
| `1:40–2:05` | 从演示菜单切换检测站端，查看摘要、时段压力和任务筛选 | 同一订单在 B 端被重构为现场可执行队列 |
| `2:05–3:05` | 打开单车详情，接单、四项到站核验；演示一次信息不一致挂起与恢复 | 状态机不是动画，而是防错、审计和异常恢复协议 |
| `3:05–3:40` | 交接检测，说明外部系统边界并点击“模拟结果回传” | 不伪造设备能力；用签名、幂等和服务端模拟器表达真实集成思路 |
| `3:40–4:15` | 站端确认完成，切回 C 端查看结果、时间轴、评价与提醒 | 双端共享事实，让履约从黑盒变成可感知服务 |
| `4:15–4:40` | 修改未来时段容量并触发“低于已预约数”冲突 | 展示服务端约束、错误 envelope 与 UI 字段级反馈 |
| `4:40–5:00` | 打开 README 架构、ERD、指标，执行演示重置 | 总结产品边界、技术取舍、可测试性和可重复演示能力 |

一句话收尾：**我没有把“线上检测设备”包装成一个炫技页面，而是先拆清服务平台与工业软件边界，再把两者真正需要的业务交接做成可运行、可审计、可恢复的闭环。**

## 取舍、假设与后续接口

### 已实现或演示

- 一个可由非生产 fallback 映射的演示车主、内部用户会话底座和三个明确标注的演示站；华洋的公开主体资料为真实数据，但价格、评分和号源仍是 MVP 配置。
- 大陆民用普通蓝牌、小型/大型新能源绿牌；明确不支持黄牌、黑牌、警牌、军牌、使领馆、挂车和港澳特殊号牌。
- 华洋自营站固定置顶；三个合成站点、跨用户今日任务、核验照片和结果可重复演示。
- API 不可用时的前端演示回退，用于静态展示，不代表生产离线写入。
- 三家明确标注“演示”的洗车门店、两档套餐、车型价格矩阵、容量号源、冻结报价、模拟支付后六位码、运营人工核销和线下结算登记。

### 明确不做

- 微信支付、OCR、消息订阅、交管 12123 和政务账号；微信 `wx.login(code) → code2Session → 应用 Bearer` 已接入，但不代表这些外部能力已接入。
- 真实检测设备、上位机、检测线控制、实时遥测、设备校准、监管上报和正式检验报告。
- 对车牌真实签发状态或法规时效性的权威验证。
- 跨全部服务类型的通用多租户、自定义 RBAC、细粒度风控、真实财务结算和客服后台；已实现的平台管理员/单店洗车管理员实名认证、固定能力和服务端主体隔离不在此列。
- 独立洗车商家 App、多门店账号、多人共管、自定义角色、自动清分分账、佣金、钱包、提现、发票、银行转账或支付机构结算；首期只提供统一后台中的单店管理员角色。
- 租车真实支付、征信免押、保险承保、证件 OCR、车联网、自助开锁、违章查询、异店/异地还车与生产库存接入。

### 生产化下一步

- 在现有微信身份与应用会话链路之上接入正式 Web 身份提供方，并补齐车主、站点、员工三级授权与站点租户隔离。
- 与合作方确认设备/机构软件协议、字段字典、版本策略、证书轮换、重试和死信处理。
- 结果回传增加 mTLS、密钥托管、完整性监测、告警和人工补偿队列；后台操作记录仍保持应用内不提供导出接口的边界。
- 引入真实埋点与漏斗看板，在小范围站点灰度验证到站率和回传延迟。
- 为正式部署补充后台账号激活链接的安全交付渠道、密钥托管、备份恢复与告警，以及对象存储/CDN、微信合法域名、正式库存接入和图片版权审查；继续把其他 Web 服务流逐步对齐原生微信端。

## 仓库结构

```text
yuxiaoman-mvp/
├─ src/                         # C/B 端 React 移动界面与共享领域组件
├─ admin/                       # 独立桌面运营后台
├─ server/                      # Fastify API、PostgreSQL 访问层、身份会话、状态机、签名与测试
├─ wechat-miniprogram/          # 原生微信小程序消费者端
├─ public/assets/used-cars/     # 租赁复用的本地车标、真实车型参考图与可追溯来源清单
├─ public/assets/inspection/    # 四张合成车辆查验图
├─ data/                        # 本地上传文件；数据库持久化不在此目录
├─ tests/                       # Playwright 与 Sites 兼容规格
├─ references/                  # 固定视觉 QA 基准（含汽车租赁搜索先行稿）
├─ AGENTS.md                    # 持久产品与运行时约束
└─ README.md                    # 产品、设计、技术、契约与面试脚本
```

---

这个项目要证明的不是“会做两个页面”，而是能把模糊需求拆成角色、边界、状态机、异常恢复、外部契约和可测指标，并把这些判断完整落到产品、UI、API、数据和测试中。
