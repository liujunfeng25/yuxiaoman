# 预检问题处理：Product Design 验收

日期：2026-09-04。目标为既有原生微信小程序及共享后台，不涉及历史 React 原型。

## 结果与视觉依据

final result: passed

本次原生页面视觉及所列交互检查通过。没有遗留的 P0/P1/P2 视觉问题。测试套件另有一条已存在的租车首页文案断言失败，详见下文；这里的 passed 仅指本次设计验收。

视觉依据：

- `E:/yuxiaoman/Yuxiaoman-MVP-macOS/references/operator-booking-detail-visual-reference.png`
- `E:/yuxiaoman/Yuxiaoman-MVP-macOS/references/selected-owner-home-v2.png`
- 既有原生预检、年检订单、维修需求、洗车页面的蓝白卡片、图标及控件样式。

这是对现有流程的扩展。首页参考用于颜色、文字层级、卡片和图标风格；不是把首页内容复制成问题处理页。检测站预检保留既有蓝色摘要卡和七图核对布局，新增问题后果表。系统原生导航、状态栏与参考图的差异不作为页面设计偏差。

## 截图与比较

全部实现截图由已获用户授权的微信开发者工具 `wechatide` CLI 从实际小程序截取，目录为 `E:/yuxiaoman/Yuxiaoman-MVP-macOS/.runtime/precheck-design-qa/`。

模拟器：iPhone 12/13 (Pro)，CSS 屏幕 390 × 844，页面窗口 390 × 762；运行时 pixelRatio 为 3，fontSizeScaleFactor 为 1.33。CLI 截图实际为 519 × 1123，比较时统一缩放为 390 × 844；参考图 852 × 1846 缩放为 390 × 845。未将 CLI 输出像素误认为设备物理像素。保留原图，未修饰页面内容。

| 比较证据文件 | 检查状态及结论 |
| --- | --- |
| station-reference-comparison.png | 同一输入并排呈现检测站参考和待预检实现；卡片、蓝色主操作、照片网格及底部安全区清楚可读。 |
| station-guide-reference-comparison.png | 参考与重新提交后的检测站后果表；资料、脏污、车损/故障灯、退款四类后果和处理说明均完整。 |
| station-button-fix-comparison.png | 修复前后的弹层。底部按钮由 184 CSS px 默认宽度改为容器全宽并垂直居中，关闭按钮靠右；不同滚动位置不用于判断内容布局差异。 |
| owner-reference-comparison.png | 车主首页风格参考与新问题处理页；保留蓝白样式，压缩站内操作语言，突出已付款与后续选择。 |
| owner-photos-fix-comparison.png | 维修共享区修复前后；第二张仪表盘照片现在可见，选项有圆角，按钮宽度正确。 |
| photo-focus-comparison.png | 同一输入中的共享照片局部比较，确认两张不同照片及下方未默认勾选的授权。 |
| repair-fix-comparison.png | 维修需求修复前后；预检来源不再显示虚假的“俯视定位”，采用“维修 / 待门店核对”，底部两个按钮不重叠。 |
| wash-fix-comparison.png | 洗车门店修复前后；查看详情与选择门店按钮分别约束在各自网格内；已选店样式为实际交互后的预期状态。 |

其他实现截图：`owner-resubmit-ready.png`、`owner-resubmit-footer.png`、`wash-linked-booking.png`、`station-guide-resubmitted.png`。完整像素元数据记录在各 comparison 同名 JSON 中；生成脚本为 `compare.mjs`。

## 五项视觉检查

| 项目 | 结果 |
| --- | --- |
| 字体与层级 | 使用原生系统字体与现有字号层级；标题、解释、状态、金额区分清楚。长中文可换行，修复按钮文字贴顶。 |
| 间距与布局 | 保留原生页面留白和卡片间距；问题弹层正文独立滚动，提交按钮固定；车主页面照片双列、复核/退款按钮和底部安全区完整。 |
| 颜色 | 主操作沿用 #1768cf，背景 #f4f8fc，白色卡片；待处理使用克制的暖色，未确认维修严重程度使用中性色。 |
| 图片与图标 | 沿用项目真实栅格图标；使用同一演示车辆既有照片。照片不拉伸，共享预览仅含左前和仪表盘两张，行驶证只在车主/检测站授权区域。 |
| 文案 | 故障灯直接归入维修；脏污洗车不竞价；检测站发送清单保留款项，退款由车主主动申请；处理后仍须站点复核，未冒充正式年检结论。 |

## 发现、修复与复验

1. P2：微信默认按钮宽度和全局行高使检测站提交按钮变窄、文字贴顶。增加页面内明确宽度、flex 居中与间距。`station-precheck-final.png`、`station-findings-final.png` 复验通过。
2. P1：共享图片为块级元素，第二张照片落在横向容器外。增加 inline-block，使用 `photo-focus-comparison.png` 复验两张照片均可见。
3. P2：车主说明直接沿用“向车主提供”等检测站操作文案，过长且主语不符。补充车主视角短说明，`owner-actions-final.png` 复验通过。
4. P2：预检维修问题沿用报告“俯视定位”与默认绿色轻微样式，语义不准确。按来源显示原始照片与中性“待门店核对”，`repair-detail-final.png` 复验通过。
5. P2：维修详情底部和洗车门店卡片默认按钮超出网格。限定宽度与最小尺寸，`repair-fix-comparison.png`、`wash-fix-comparison.png` 复验通过。

## 已验证交互与数据

使用一笔明确标注“本地预检功能验收”的演示订单 `a813ab7a-0fc3-4dfb-9695-36661d2524e6`，只在本地演示数据库运行。初始预约由本地 API 准备，复用同一演示车辆既有七张照片；这不算完整的预约创建 UI 端到端测试。

随后实际通过原生页面操作：

- 车主模拟支付 ¥260；检测站实名登录并勾选脏污、车损、故障灯及两张问题照片，填写说明并发送。
- 后端确认为 `precheck_action_required`、已付 26000 分、退款 0、原时段已释放。
- 车主从年检订单进入处理页，勾选共享授权并发布两项维修需求，打开真实需求详情；页面仅共享相关车辆照片。
- 打开洗车门店并选择套餐入口，原年检订单 ID 和车辆 ID 正确带入，车辆选择锁定。
- 点击两个补拍按钮并上传，填写处理说明、选择未来本站时段，再点击提交；订单重新进入 `pending_precheck`，版本为 3，已付仍为 26000 分、退款仍为 0。检测站页面能看到处理说明和更新后的照片。

系统弹窗确认与相册选择使用微信 CLI 的 wx API mock 适配；业务请求、上传、状态推进和数据库写入均使用真实本地应用。相册返回的是本地已有演示照片，并非真实维修完成后的照片；测试说明已在订单中明示。测试结束已恢复 showModal 与 chooseMedia。未用 setData 或 SQL 伪造完成状态。

未在本次原生 UI 中重新执行各店报价/选店支付和退款确认；这些流程由 API/既有后台回归覆盖。没有真实微信支付、真实相机或物理手机验收。复核提交的 UI 号源选择通过原生 picker 的 change 事件测试。

最后一次 `get_simulator_console` 对 error 的过滤无匹配。授权初期的 CLI 参数错误和刷新时导航超时属于工具调用，已纠正，未发现对应页面运行错误。

## 自动检查与运行环境

- 后端全套回归 208/208 通过；收尾新增洗车来源校验后，预检/预审专项 6/6 通过。
- 后台浏览器回归 49/49 通过，后台构建通过。
- 原生 TypeScript、包边界、JSON、资源、主包预算通过；主包估算 1.413 MiB，总包约 4.49 MiB。
- 最终原生测试 190 项，189 通过。唯一失败是 `wechat-miniprogram/tests/car-rental-flow.test.ts:51`：断言首页不存在“二手车交易”，但 HEAD 原本已有该补贴咨询入口。该页面未在本次修改。
- `git diff --check`、受保护历史运行时完整性检查通过。
- 日志位于 `.runtime/precheck-api-tests.log`、`precheck-focused-final.log`、`precheck-admin-tests.log`、`precheck-all-native-final.log`、`precheck-package-final.log`。
- 本地 API 已更新并运行于 8792，后台运行于 5174。变更前数据库备份：`.runtime/before-precheck-actions-20260904.dump`。

## 实施清单

- [x] 检测站问题后果说明和恢复式预检状态。
- [x] 车主自主维修/洗车、照片授权及原记录留存。
- [x] 补拍、选时段、再次复核；仅车主发起预检退款。
- [x] 实际原生截图比较、问题修复、复验与回归记录。
- [x] 保留本地演示验收订单并将模拟器停留在检测站复核说明页。

后续范围：物理手机、真实相机与正式支付接入不在本次本地验收范围内；原有租车测试文案矛盾仍需按该模块产品决定单独处理。
