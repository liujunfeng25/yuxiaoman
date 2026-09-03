# 汽车租赁微信小程序当前设计 QA（2026-08-23）

## Evidence

- Source visual truth: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\car-rental-search-selected.png` (`853 × 1844`, SHA-256 `8335215A7A5045254686D2474EBE7433AB7703FDE16024AE2610F01BE6FAEA2A`).
- Rendered implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\car-rental-native-qa\rental-native-final-device.png`, captured from the real WeChat DevTools simulator on `/pages/car-rental-home/car-rental-home` in store-pickup mode.
- Normalized implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\car-rental-native-qa\rental-native-final-390x844.png`; full DevTools evidence: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\car-rental-native-qa\rental-native-final-window.png`.
- Same-canvas comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\car-rental-native-qa\rental-reference-vs-native-final.png` (`800 × 844`), with the selected mock on the left and the native mini-program on the right.
- Viewport/state: iPhone simulator, first Tianjin demo store, `2026-08-24 10:00` to `2026-08-26 10:00`, two billable days, live seeded L7 and Qin PLUS DM-i offers.
- Density normalization: the source was resized from `853 × 1844` to `390 × 844`; the focused simulator crop was resized from `527 × 1141` to `390 × 844`. Both preserve the same mobile aspect ratio; no content crop was used in the comparison.
- Functional evidence: mini-program rental tests pass `4/4`; the current full API suite passes `130/130`; the current full admin suite passes `26/26`; all 46 exact-model vehicle-photo mappings pass source/output verification.

## Findings

- No actionable P0, P1, or P2 visual issue remains.
- Fonts and typography: the final native screen restores the selected mock's readable date, store, CTA and price hierarchy. Auxiliary policy text remains secondary without dropping into illegible microcopy.
- Spacing and layout rhythm: the search card is again the first-screen focus, the primary button fills the card, the trust strip separates search from discovery, and two complete popular-model cards are visible without a dead lower viewport.
- Colors and states: the active fulfillment mode uses a solid cobalt fill with white text and icon; inactive, card, divider, price-orange and disclosure colors follow the selected blue/white direction. State is not communicated by color alone.
- Image quality: both popular cards render the licensed, locally served exact-model photos with no broken image, placeholder box, distortion or cross-model fallback. The model-photo provenance checks cover all 46 retained models.
- Copy and content: same-store pickup, exact-model guarantee, transparent fees, unified customer service, live rental period, daily average, period total and the synthetic-data disclosure are all visible. Actual totals intentionally use the server-calculated two-day quote rather than copying the three-day mock values.
- WeChat-native difference: the custom header reserves the platform status bar and capsule while keeping customer-service and order actions visible. This differs from the chrome-free concept image but does not change the content hierarchy.

## Comparison history

1. The first real simulator capture exposed a P1 hierarchy mismatch: an unselected blue promotional hero displaced the search card, popular models were missing, and the lower viewport was empty. It also exposed P2 typography, tab-contrast and CTA-width issues.
2. The native rental home was rebuilt around the selected search-first composition: the hero was removed, the active tab became cobalt, typography and touch targets were enlarged, customer-service/order actions were added, and live popular offers were connected to the existing rental API.
3. The second comparison found the WeChat button host still constrained the CTA. A dedicated full-width flex wrapper was added.
4. The final real-DevTools capture confirms a full-width CTA, two loaded exact-model cards, no horizontal overflow, no broken imagery and no empty lower viewport.

## Primary interaction and responsive checks

- Store selection, pickup/return dates, fulfillment mode, primary search, customer service, order entry, “查看全部”, and each popular-model card remain real native controls.
- Home delivery does not request a store-mode popular offer before a verified same-address location exists; its existing route-proof validation remains in force.
- Layout uses a two-column `minmax(0,1fr)` grid and a 340 px compact breakpoint; the final iPhone capture has no clipped labels, card overflow or hidden CTA.

final result: passed

---

# 微信小程序维修询价闭环设计 QA（2026-08-25）

## Source and implementation evidence

- Selected visual direction (方案 1): `C:\Users\Administrator\.codex\generated_images\01a03039-47b3-7aa2-8535-baf7e8badf3c\exec-d3c20e16-6096-4d6c-bd3a-d58fe251a289.png` (`853 × 1844`).
- Native owner quote implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\repair-marketplace\owner-quotes-native.png` (`149 × 321`).
- Same-canvas comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\repair-marketplace\owner-quotes-design-comparison.png` (`1276 × 1412`), with the selected direction and native mini-program state normalized to the same `149 × 321` content viewport and enlarged 4× for review.
- Native paid receipt: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\repair-marketplace\owner-receipt-native.png` (`149 × 321`).
- Native winning-shop deal: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\repair-marketplace\shop-deal-native.png` (`149 × 321`).
- Verified state: one published inspection report with four faults, three active Tianjin demo-shop quotes, the lowest quote selected by default, then idempotent simulated payment to 津城钣喷中心（演示）.

## Findings

- No actionable P0, P1, or P2 visual, interaction, or accessibility issue remains in the selected owner quote state.
- Hierarchy and density: the ice-blue vehicle/report summary spans the available width; four detected faults remain on one readable line; three price-first quote cards fit the screen; the lowest-price badge, selected border, payment boundary, and sticky total/CTA remain visible without overlap.
- Typography and color: navy hierarchy, cobalt interaction, orange price emphasis, quiet metadata, white cards, subtle borders, and restrained radii match the selected direction and the existing owner mini-program design system.
- Assets: the summary uses the packaged shield-check and calendar-check raster assets. No emoji, CSS drawing, placeholder box, handcrafted SVG, broken image, or stretched source asset is visible.
- WeChat-native difference: platform status/navigation chrome is preserved, so it differs from the chrome-free concept image; the content hierarchy and task flow remain equivalent.
- Privacy boundary: the request freezes only the vehicle/report/fault/close-up snapshot needed to quote. The shop hall hides plate and owner contact details; only the paid winning shop receives the explicitly synthetic demo contact. Inspection overview photos, certificate photos, and unrelated owner data are not exposed.
- Payment boundary: the current implementation is a gated, idempotent simulated payment for prototype acceptance. It does not claim production WeChat Pay, refund, settlement, repair fulfilment, chat, or appointment capabilities.

## Comparison history

1. The first native comparison showed a narrower request-summary card, an extra comparison note, loose quote-card spacing, a weak empty watermark region, and payment-boundary copy longer than the selected direction.
2. The summary was changed to full width, the extra note was removed, quote-card density and first-card top padding were tightened, real packaged watermark/calendar assets were applied, and boundary copy was shortened.
3. The final same-canvas comparison confirms the selected price-first scan pattern, default-lowest selection, three complete shops, sticky payment action, no clipping, and no horizontal overflow.
4. The owner receipt and shop deal were captured from the same native end-to-end run after payment; both render the frozen quote/order details and the correct post-payment contact boundary.

## Functional and regression evidence

- Native WeChat DevTools automation completed report → request → three shops quote → owner selects/pays → owner receipt → winning-shop deal, with no captured console error or runtime exception.
- Mini-program repair model tests pass `10/10`; server repair marketplace tests pass `4/4`, including ownership, report/fault snapshotting, shop isolation, quote upsert/withdraw, concurrent payment idempotency, media scope, cancellation, and demo gates.
- Client TypeScript checking completes, while the current root aggregate stops in the unrelated `server/tests/auth.test.ts` fixture because `previousAliasAppId` and `previousAliasSecret` are undefined. Main-package budget and route/asset/subpackage checks pass; the repair subpackage is `0.162 MiB` and the main package is `1.296 MiB / 1.5 MiB`.
- The repository-wide API aggregate completed `162/167`; all four repair tests passed inside that run. The five failures are outside the repair domain: two PostgreSQL statement timeouts plus three existing backoffice/domain assertions. The two customer-center assertions pass when rerun in isolation, supporting environment/load isolation rather than a repair regression.
- The full mini-program aggregate reaches the existing wash-store picker Node-origin expectation mismatch after its earlier stages pass. The production fail-closed API-origin behavior was intentionally not weakened for this unrelated test harness issue.

final result: passed

# 年检车辆体检故障特写闭环验收（2026-08-23）

## 产品与视觉边界

- 车辆故障定位继续沿用项目既有的浅冰蓝、白色卡片和蓝色交互体系；红橙色仅用于故障热点与材料缺失提示，不采用与后台、小程序割裂的深色 HUD 风格。
- 固定现场基准照片（左前、右前、左后、右后、启动后仪表盘）、年检标照片和逐故障特写是三个独立材料域，不混合计数。
- 每项故障关联 1–3 张检测站现场特写。报告草稿允许暂缺，正式回传必须逐项完整；图片只绑定稳定故障 ID，同部位的多条故障也不能串图。
- 检测站编辑页支持拍摄/相册、预览、替换、删除和失败重试；后台、车主报告和打印稿均把特写放在对应故障的描述与建议下方。

## 自动化与真实链路证据

- 后端全量 API：132 / 132 通过；新增覆盖稳定故障 ID、1–3 张上限、缺图阻断、跨故障隔离、幂等上传、原子替换、发布与历史兼容。
- 原生小程序 `npm run check` 全绿；车辆体检专项 18 / 18，通过类型检查、主包预算和所有业务测试。
- 后台完整 Playwright：26 / 26 通过；覆盖状态机时间节点、自驾/代驾履约信息、故障图文报告、故障组内大图预览、历史缺图提示和打印展开。
- 真实接口测试单 `YXM202608204A3A48`：发布前因 2 项故障均缺图返回 `VEHICLE_CHECKUP_FAULT_PHOTOS_REQUIRED`；随后两项故障分别上传 1 张与 3 张，尝试第 4 张返回 `VEHICLE_CHECKUP_FAULT_PHOTO_LIMIT`；重复上传和重复发布均幂等。
- 发布后 operator / admin / owner 三个详情均返回 2 项故障、4 张特写，所有特写读取均为 HTTP 200；自驾订单推进至 `completed` 后报告、故障和照片仍完整。

## QA 限制

- 本轮原生与后台交互由编译、业务单测、Playwright 和真实 API 链路共同验证。Codex 内置浏览器控制运行时因受信 RPC 路径初始化失败，未把无法完成的浏览器截图检查冒充为视觉证据；微信开发者工具仍可由人工刷新后进行真机视觉复核。

final result: passed

---

# 微信小程序洗车门店选择页设计 QA（2026-08-23）

## Source and implementation evidence

- Source visual truth: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\wash-store-picker-design-qa\stations-reference-363x785.png` (`363 × 785`). It is the existing annual-inspection station picker used as the structural reference, not a pixel-for-pixel wash-store mock.
- Final list implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\wash-store-picker-design-qa\wash-store-list-unselected-363x785.png` (`363 × 785`).
- Expanded store details: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\wash-store-picker-design-qa\wash-store-details-363x785.png` (`363 × 785`).
- Selected-store return state: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\wash-store-picker-design-qa\wash-booking-selected-store-363x785.png` (`363 × 785`).
- Full-view same-canvas comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\wash-store-picker-design-qa\wash-store-list-comparison-final.png` (`750 × 785`; station reference left, wash implementation right).
- Focused same-canvas card comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\wash-store-picker-design-qa\wash-store-card-focus-comparison-final.png` (`750 × 380`; equal-scale native crops).
- Simulator: iPhone 12/13 Pro preset; `390 × 844` CSS screen, `390 × 762` app window, pixel ratio `3`. Source and implementation were captured through the same WeChat DevTools display scale as equal `363 × 785` PNGs. Neither side of either comparison was resized or density-resampled.
- State: self-drive wash booking, sedan price category, no location permission, three active demo stores, first store not selected for the direct structural comparison. The expanded and return captures exercise their named interaction states.

## Findings

- No actionable P0, P1, or P2 visual or interaction issue remains.
- Fonts and typography: both flows use the same native Chinese system stack and preserve the established hierarchy of route kicker, strong page title, muted explanation, store name, compact metadata, emphasized price, and primary action. Long names and notices remain contained; no visible control text clips or wraps into adjacent content.
- Spacing and layout rhythm: the implementation deliberately preserves the station picker's sequence—task heading, current-origin context, distance disclosure, then a vertical store list—while making each wash card richer. The first card still exposes its complete comparison metrics and selection action above the fold; cards do not overlap the navigation chrome or screen edges.
- Colors and visual tokens: restrained blue-white surfaces, navy hierarchy, orange price emphasis, green booking-availability state, quiet dividers, and low-elevation cards stay consistent with the existing owner-service design. Status is labelled “可预约 / 暂停预约”, not a fabricated real-time “营业中”.
- Image quality and asset fidelity: the fallback is a real raster wash-bay image generated for the measured card slot, compressed to `720 × 480` WebP (`20,994 B`) without a broken crop, logo, or watermark. It is explicitly marked “服务环境示意”; real operator-uploaded gallery images take precedence. No emoji, CSS drawing, placeholder box, or handcrafted SVG substitutes a visible asset.
- Copy and content: the list distinguishes current vehicle price, distance source, nearest available slot, hours, tags, facilities, synthetic rating, and demo-store/image boundaries. “价格读取失败” has a retry action and is not misreported as “当前车型暂无套餐”. The expanded content uses neutral “门店图片” copy for real uploads.
- Icons and accessibility: the page reuses the existing icon family. Store cover and gallery thumbnails have button roles and readable labels; phone/location actions expose clear text; selected, disabled, loading, empty, and error states do not rely on color alone.
- Interaction evidence: WeChat DevTools automation completed booking page → store picker → expand details → choose store → return to booking. The chosen store, its thumbnail, hours, and current sedan prices refreshed correctly. No console error/assert or runtime exception was captured during the flow.
- Responsive evidence: the official native screenshots cover the project simulator's phone width. The page has no horizontal overflow in the captured states, and the main store action remains visible before the next card. Desktop/tablet breakpoints are not applicable to this native mini-program page.

## Comparison history

1. The first capture pass produced only `149 × 321` simulator thumbnails, which was insufficient evidence for typography and card details. The capture was changed to the DevTools screenshot protocol with `{ scale: 1 }`, route and visible-text assertions, and a minimum `363 × 785` dimension assertion; all final evidence was recaptured.
2. Review found misleading real-time wording and mixed real/demo gallery copy. The UI was changed from “营业中 / 暂停营业” to “可预约 / 暂停预约”, real gallery count became “门店图片”, and only the fallback remains labelled “服务环境示意”.
3. Review found that relative server image URLs would fail in the native image component and that a detail refresh could erase an already displayed distance. Image URLs now normalize against the configured API origin with a load-error fallback, while detail hydration preserves the list's distance fields. Final list, expanded detail, and selected-return screenshots verify the repaired states.
4. The post-fix same-canvas comparison shows the existing station information architecture retained and the wash-specific card expanded intentionally for imagery, current-vehicle price, availability, hours, details, and selection. No P0/P1/P2 mismatch remains.

## Follow-up polish

- [P3] Until operations uploads real store-specific galleries, all demo stores intentionally reuse one compact environment illustration. This is truthful and package-safe, but real store photos will make the list feel less repetitive once available through the completed admin gallery.

final result: passed

---

# 微信小程序车辆品牌车型与动态车辆 UI（2026-08-20）

## Source and implementation evidence

- Source visual truth (年检查询): `C:\Users\Administrator\.codex\generated_images\01a0192e-a682-7df1-a643-647de41e39bf\exec-54c719c3-7479-4ea8-b172-12ea11c40b80.png` (`853 x 1844`).
- Source visual truth (首页): `C:\Users\Administrator\AppData\Local\Temp\codex-clipboard-eb0b65a4-3037-4e42-838a-f077da99dc16.png` (`492 x 860`).
- Implementation (年检查询): `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-eligibility-mercedes-s.png` (`363 x 785`).
- Implementation (首页): `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-home-mercedes-s.png` (`363 x 785`).
- Implementation (品牌车型面板): `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-vehicle-catalog-sheet.png` (`363 x 785`).
- Implementation (实时车辆预览): `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-vehicle-form-mercedes-s-preview.png` (`363 x 785`).
- Implementation (车辆管理，修复后): `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-vehicles-dynamic-fixed.png` (`363 x 785`).
- Same-canvas comparisons: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\design-qa-eligibility-comparison.png` and `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\design-qa-home-comparison.png`.
- Viewport/state: WeChat DevTools iPhone simulator at `363 x 785` CSS px and 1x capture density; current vehicle was temporarily assigned “奔驰 S级” while preserving the existing plate. The original brand/model/default state was restored automatically after the regression.
- Density normalization: both source screenshots were proportionally resized to `785 px` high for the comparison canvas; implementation captures were not stretched or density-resampled. Device chrome differences were excluded from fidelity findings.
- Focused comparison: no separate crop was necessary because the full-height normalized comparisons retain readable hero typography, car edges, special-condition rows, CTAs, and service icons. The two dedicated vehicle-form captures provide readable evidence for the new panel and live preview, which had no earlier source screen.

## Findings

- No actionable P0, P1, or P2 issue remains.
- Fonts and typography: the native system Chinese stack preserves the existing strong navy heading, compact gray vehicle facts, large orange countdown, and blue CTA hierarchy. “奔驰 S级”, “车型示意图”, and the non-calculation disclosure stay readable without wrapping into controls.
- Spacing and layout rhythm: home keeps the source proportions and all conversion actions above the fold. The annual-query implementation intentionally adds the required current/temporary mode switch and horizontal vehicle selector, so its question area is denser than the visual target; the sticky calculation CTA remains visible and no essential control is pushed below an undiscoverable result.
- Colors and tokens: the split Tianjin hero retains the existing pale blue/white atmosphere, navy text, blue active state, orange deadline emphasis, restrained borders, and white cards. The brand/model sheet reuses the same tokens instead of introducing a second visual language.
- Image quality and asset fidelity: 12 ImageGen vehicle illustrations are packaged in the mini-program as local `720 x 405` transparent PNG assets, not CSS art or placeholders. The right-front three-quarter crops are consistent, sharp at simulator and 3x phone density, and remain fully inside the hero and model tiles. The local PNG fallback prevents blank regions for legacy records, network restrictions, transparent-WebP incompatibility, or load failures. Manufacturer logos are local PNG assets as well; visible imagery is labelled “车型示意图”.
- Copy and content: “品牌车型只用于车辆识别与界面展示，不会自动修改座位数、动力类型或年检测算” accurately separates identity from inspection facts. Home and annual query retain the original business copy and conversion CTA.
- Interactions and accessibility: car/model regions are labelled tap targets, the plate continues to open vehicle switching, brand/model cards are practical mobile tap sizes, the catalog and plate keyboard are mutually exclusive, and selected states use both border/fill and text rather than color alone.
- Intentional differences: the source year-inspection mock does not show the required horizontal vehicle selector or temporary-query tab; these product requirements were added without changing the core question order or CTA. Existing legacy vehicles show “品牌车型待设置” with the generic vehicle instead of inventing a brand.

## Comparison history

1. First rendered pass found one P2 issue on the vehicle-management cards: native WeChat button minimum widths overrode the three-column grid, pushing “移除” outside the `360 px` card and screen.
2. Fix applied: replaced that action grid with three explicit `33.333%` flex children and `min-width: 0` in `pages/vehicles/vehicles.wxss`.
3. Post-fix evidence: `qa-vehicles-dynamic-fixed.png` shows “当前车辆/设为当前车辆”, “编辑车辆”, and “移除” fully contained. Runtime inspection measured every action at approximately `120 px` within the `360 px` card; the rightmost edge ends at `374.95 px`, inside the page viewport.

## Primary interactions and runtime checks

- Opened the bottom brand/model selector, confirmed 6 brands, selected the first of 3 Mercedes models, and verified the live “奔驰 S级” hero preview.
- Temporarily persisted the identity, then verified the same name and vehicle image on home and annual query; the original record was restored in `finally`.
- Used “设为当前车辆”, verified the API default changed, and restored the original current vehicle.
- Completed annual-inspection calculation and reached the actionable result/booking CTA.
- Home, annual query, vehicle form, catalog sheet, and vehicle management were captured from the real WeChat simulator with no console error/assert or runtime exception.

## Follow-up polish

- [P3] The annual-query implementation is necessarily denser than the source after adding two switching controls. A later large-screen variant could give the hero slightly more vertical breathing room, but the current compact layout preserves the CTA and has no clipping.

final result: passed

---

# 年检车辆体检报告与故障定位视觉 QA（2026-08-23）

## Source and evidence

- 交互与空间感参考：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\vehicle-checkup-tech-reference.png`（774 × 413）。
- 后台完整报告：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\design-qa-admin-checkup-full.png`（550 × 1062）。
- 故障定位模块聚焦证据：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\design-qa-admin-checkup-panel.png`（550 × 554）。
- 同画布对照：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\design-qa-checkup-comparison.png`（1652 × 594），左侧为参考图，右侧为最终实现；两侧按 554 px 等高归一化，无拉伸。
- 浏览器视口：1440 × 1000；固定状态为“报告草稿、左侧视图、左前门故障选中、故障气泡展开、3 项故障”。
- 小程序运行证据：原生 TypeScript/模板检查与专项测试全部通过，真实 API PUT/GET 冒烟通过。当前 Nightly 微信开发者工具与仓库 `miniprogram-automator 0.12.1` 协议不兼容，因此本轮没有把不可复现的模拟器截图作为视觉签收证据。

## Findings

- 未遗留可执行的 P0、P1 或 P2 视觉问题。
- 视觉方向：保留参考图的真实车辆、立体展台、热点高亮、悬浮说明与故障列表联动，但主动采用产品已有的浅冰蓝、白色卡片、深蓝正文和克制红橙告警，不复制深黑 HUD；该差异符合用户明确提出的“不与后台和小程序割裂”。
- 字体与层级：标题、视图切换、故障气泡、编号列表、结果状态和辅助说明层级稳定；故障标签既有编号和文字，也有颜色/边框状态，不依赖单一色彩表达。
- 间距与布局：车辆主体始终完整，气泡不遮挡选中部位；三视图切换、热点、列表与报告摘要均在卡片边界内，无横向溢出或裁切。完整报告中的现场影像和结果信息沿用后台抽屉的既有栅格与圆角。
- 图像质量：俯视、左侧、右侧均使用本地真实白色 SUV 位图素材，底部采用生成的浅冰蓝立体展台；无 CSS 假车、占位图、emoji 或手绘 SVG。俯视资产为正交鸟瞰，热点坐标不会因透视方向漂移。
- 交互与内容：20 个稳定车身区域、同一区域多故障、单气泡展开、图下列表双向选中、故障类型/程度/备注、5 张现场照和合格标照片均有真实数据链路。故障记录不阻断检测结论，年检结果与平台车辆体检信息分层展示。
- 响应状态：草稿、已发布、无明显异常、多个故障、合格/不合格/待复核、照片缺失与上传完成均有明确文案；后台草稿明确不可见于车主端，避免误以为已交付。

## Comparison history

1. 初始参考采用深色科技舱，但与现有运营后台和原生小程序的蓝白服务体系过于割裂。
2. 根据用户反馈，最终改为浅冰蓝立体场景，保留真实车辆和热点交互，只用红橙色表达故障；三端复用同一车辆资产和稳定区域代码。
3. 最终浏览器渲染对照确认：立体感、热点聚焦和信息联动均保留，车辆与气泡可读性优于把参考图整体缩进手机卡片的方案；后台聚焦 E2E 复跑 `1 passed (4.9s)`。

final result: passed

---

# 年检后台全景状态与文字报告视觉 QA（2026-08-23）

## Source and evidence

- 用户提供的缺陷状态：`C:\Users\Administrator\AppData\Local\Temp\codex-clipboard-cb9e2cd6-d875-4ac1-9ffb-4008c3fd2170.png`（650 × 692）。该图证明两项问题：故障 #2 的热点显示为 1，且右后翼子板热点落在后轮区域；同时报告主体只有故障定位，没有完整文字报告。
- 修复后右后翼子板定位：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\design-qa-admin-checkup-right-fender-fixed.png`（550 × 554）。
- 自驾履约全景：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\annual-inspection-admin-global-self-drive-top.png`（620 × 1000）。
- 代驾履约全景：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\annual-inspection-admin-global-valet-top.png`（620 × 1000）。
- 完整车辆体检报告：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\annual-inspection-admin-global-checkup-report-full.png`（550 × 1963）。
- 故障明细聚焦：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\annual-inspection-admin-global-checkup-fault-details.png`（550 × 273）。
- 同画布定位修复对照：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\design-qa-right-fender-before-after.png`（1203 × 594）。
- 同画布报告扩展对照：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\design-qa-admin-report-before-after.png`（1273 × 660）。左侧是用户的“仅故障定位”问题态，右侧是报告基本信息、年检结论、文字车况和后续定位模块；这是功能扩展对照，不作像素级克隆判断。
- 自驾/代驾同画布状态覆盖：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\audit\design-qa-admin-journeys-self-vs-valet.png`（1304 × 1040）。
- 浏览器测试视口为 1440 × 1000，抽屉内容截图分别以 620 px 和 550 px 宽度保存，deviceScaleFactor 1；实现图未经密度重采样。

## Findings

- 未遗留可执行的 P0、P1 或 P2 视觉问题。
- 信息架构：详情首屏现在先给出“当前状态 → 全链路节点 → 服务方式与履约人员/地址”，再进入交易与后台操作；后台不再要求用户从零散卡片自行推断订单走到哪里。
- 自驾/代驾：自驾展示到站检测站、联系人和预约时段；代驾展示 9 节点链、同址取送地址、车主联系人、司机、调度、送检站点与协调备注。缺失的司机/调度数据会明确显示“未回传/未记录”，不会造人名或电话。
- 时间节点：已经发生的步骤读取订单事件真实时间，当前节点使用蓝色描边、状态环和文字三重强调；未发生节点显示“待进行”。支付待确认历史态只在视觉上归一到“已确认”，不再驱动新业务语义。
- 文字报告：保留原三视图之前，新增平台报告编号、车辆/站点/服务信息、年检结论、检测说明和车身状态文字结论；之后以表格把每个故障的部位、类型、程度、现场描述和自动建议完整套入，并提供汇总建议、备注、附件清单及打印入口。
- 边界真实性：版式参考 GB 38900-2020 附录 G 的“基本信息—结论—人工记录—备注”层次，但标题保持“车辆体检报告”，不生成检测机构授权签字、盖章或官方报告号。完成态若没有结构化报告，后台显示“材料闭环不完整”，不会静默缺失或自动补造。
- 字体与排版：继续使用现有后台中文系统字体与深蓝标题层级；状态时间、地址、电话号码、故障描述和建议均能在 550–620 px 抽屉宽度内换行，无裁切或横向溢出。
- 间距与布局：7/9 个状态节点在固定网格内分行，自驾和代驾卡片保持同一视觉语法；完整报告的元信息、结果、定位图、表格与附件之间有清晰分区，打印样式只输出报告正文。
- 颜色与视觉 token：沿用后台白色卡片、浅冰蓝信息面、品牌蓝当前态、绿色合格与克制红橙故障色。没有新增与现有产品割裂的深色 HUD。
- 图片质量：三视图继续使用本地白色 SUV 位图和浅冰蓝立体展台；热点 #2 已移动到后轮拱上方钣金，徽标、气泡和明细表的全局序号一致。
- 文案与可访问性：状态机、报告、故障表和热点都有明确语义标签；信息不只靠颜色表达。打印、三视图、故障列表和图片预览使用真实按钮，聚焦 E2E 覆盖核心交互。

## Comparison history

1. [P1] 用户截图中故障气泡和列表为 #2，热点却显示区域计数 1；右后翼子板热点位于轮毂。修复为全局故障序号，并把热点上移至后轮拱上方钣金。后置证据见 `design-qa-right-fender-before-after.png`。
2. [P1] 详情没有可扫描的业务状态机，自驾/代驾资料分散；报告只有图形定位。修复为自驾 7 节点、代驾 9 节点的履约全景，集中服务信息，并加入完整文字报告模板。后置证据见三张 `annual-inspection-admin-global-*` 截图。
3. [P1] 服务端车辆品牌/车型可能是对象，前端原类型会渲染 `[object Object]`。修复为兼容字符串或 `{id,name}`，优先显示名称，并以真实 DTO 形状加入回归断言。
4. 最终聚焦 Playwright 两条用例通过；后台 TypeScript 通过；原生小程序完整检查通过，车辆体检专项 12/12。当前微信 Nightly 与仓库自动化协议不兼容，因此原生报告未使用不可复现的模拟器截图作为本节视觉证据，原生端以模板/类型/交互测试和真实 API 契约作为功能验收。

## Follow-up product data

- [P3] 当前执行司机与调度人员没有结构化写入接口；后台能诚实展示缺失状态和内部协调备注，但正式上线前仍应增加司机/调度对象、分配时间和交接凭证。
- [P3] 官方安检报告、排放报告和电子检验标志是三个独立凭证域；本轮完成的是平台车辆体检与履约报告。后续接入检测机构时应上传并校验原件，不能用平台模板替代。

final result: passed

---

# 洗车预约页设计 QA

## Evidence

- Source visual truth: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\selected-wash-booking-ui.png`
- Browser-rendered implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\implementation-wash-booking-393x852.png`
- Raw browser capture: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\implementation-wash-booking-full.png`
- Full-view comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\wash-booking-design-qa-comparison.png`
- Focused comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\wash-booking-design-qa-focus.png`
- Route/state: `/?screen=wash`; sedan, standard wash, first demo store, first available slot.
- CSS viewport: 393 × 852 px app screen at device scale factor 1. A temporary capture-only scale override produced the measured 1:1 evidence; it was removed immediately afterward, and `npm run check:runtime` passes with all 28 protected files intact. The surrounding browser canvas was 1280 × 720 and the capture document was 1016 px tall.
- Source pixels: 852 × 1848. It was normalized to 393 × 852 only for the comparison canvas.
- Implementation pixels: 393 × 852, captured from a measured 393 × 852 `[data-testid="device-screen"]` region. No density resampling was applied to the implementation.

## Findings

- No actionable P0, P1, or P2 fidelity issue remains.
- Fonts and typography: the implementation preserves the source hierarchy—centered service title, strong one-line booking headline, compact section labels, prominent package prices, and legible secondary copy. The implementation uses the product runtime's system Chinese font stack; weights and wrapping remain stable at 393 px.
- Spacing and layout rhythm: vehicle, headline, vertically stacked packages, recommended store, date/time chips, and sticky price CTA follow the source order and visual rhythm. All controls remain inside the app screen without horizontal overflow or footer overlap.
- Colors and tokens: the cool blue-white surface, blue selection border, orange price accent, restrained gray copy, and primary blue CTA map to the source intent while remaining consistent with the existing 驭小满 product tokens.
- Image quality and assets: the source contains no photographic content. Visible controls use the existing Phosphor icon library; no placeholder imagery, emoji, handcrafted SVG, or CSS illustration substitutes are present. The black outer corners in the implementation evidence belong to the protected iPhone runtime bezel rather than app content.
- Copy and content: the implementation keeps the short booking language, explicitly marks synthetic stores as “演示”, and adds only useful product detail—vehicle price category, package duration/items, list-price comparison, and real opening hours. It avoids the reference product's long service explanation and photo-upload form.
- Icons and states: vehicle, wash package, store, selected/unselected package, selected date/slot, loading, disabled CTA, bottom sheets, and navigation affordances are implemented with a single icon family and practical tap targets.
- Accessibility/responsiveness: semantic buttons and labelled selectors are keyboard reachable; focus behavior remains inherited from the mobile runtime. The one-screen hierarchy was also exercised at the project’s responsive device presets, while the operations UI was separately covered at 1440 × 900 and 1024 × 768.
- Intentional differences: the protected runtime includes the iPhone status bar/device bezel, whereas the source visual starts at the mini-program navigation bar. Package icons, recommendation labels, list prices, capacity-backed slots, and the separate total/CTA treatment are intentional functional enhancements, not fidelity regressions.

## Comparison History

1. First full-view comparison found one P2 issue: the pre-payment redemption explanation was partially hidden behind the sticky footer. It also exposed a transient “未找到可用洗车套餐” toast while fallback IDs were being replaced by API data.
2. Fixes applied: removed the redundant pre-payment note from the booking screen, aligned fallback store/package IDs with the seeded API contract, and kept code guidance on the payment screen where it is actionable.
3. Post-fix evidence: the stable 393 × 852 capture and both comparison images show an unobstructed sticky footer, selectable package/store/date/time controls, no visible error state, and no overlap or clipped text. Focused comparison was retained because the package typography, prices, icons, selection controls, and store hierarchy needed readable inspection.

## Primary Interactions Checked

- Package, store, date, and slot selection.
- Quote creation, 15-minute pending order, and mock payment.
- Six-digit code display and copy affordance.
- Mixed annual-inspection/wash order list.
- Admin code search, manual redemption with WeChat source/note, and offline settlement registration.
- Owner order refresh to redeemed/settled terminal state with “再次预约” as the remaining action.

final result: passed

# 车险披露后台实时客户端预览验收（2026-08-20）

## Source and evidence

- User-provided failure state: `C:\Users\Administrator\AppData\Local\Temp\codex-clipboard-af694acb-d6ff-4a9d-822d-7561733d8268.png` (`1311 x 1178`). It proves the P1 issue: static client screenshots showed values that did not match the editable configuration above them.
- Final focused implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\insurance-admin-live-preview.png` (`1148 x 1267`), captured from the disclosure component at a `1440 x 920` browser viewport after changing the draft values.
- Narrow-desktop implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\insurance-admin-live-preview-980.png` (`776 x 1322`), captured at a `980 x 920` viewport after the same edits.
- Same-canvas comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\insurance-admin-live-preview-comparison.png` (`1820 x 1041`). The source disclosure region and final component were normalized to equal `900 px` columns; the source was cropped to its relevant `1245 x 1170` region before proportional resizing, and neither column was stretched.
- State: demo partner selected; upper draft changed to “津门续保服务二组”, “身份证明，车辆资料，续保时间”, “核验续保需求并安排专员回访”, “服务完成后 90 日内删除”, “2 个工作小时内联系”, and the matching authorization copy. The preview is expanded and visibly marked “草稿未保存 · 8 项映射”.

## Findings

- No actionable P0, P1, or P2 visual issue remains.
- Information architecture: the default-collapsed guide is now “客户端实时预览”. It explicitly says upper edits are reflected immediately in the same-numbered client locations but are not distributed until the operator saves.
- Mapping accuracy: the upper labels, live-preview markers, and legend share the exact 1–8 vocabulary. Markers 1 and 2 correctly share the real client's combined “信息接收方” row; the preview displays the selected partner name without its internal “启用中” suffix and appends the draft recipient only when it differs.
- Data fidelity: all client-visible text is rendered from the normalized current draft. The data-scope field uses the same Chinese-comma/comma/newline splitter as the save request and renders each item separately. Purpose, retention, authorization copy, and ETA never fall back to old screenshot text.
- Version truthfulness: an unchanged draft displays the current server version. An edited draft displays “保存后生成新版本” with the current version as context; the UI does not invent the future hash or attach the old version to new draft content.
- State coverage: three equal-width DOM previews model the saved disclosure basics, authorization confirmation, and new submission receipt. ETA appears in both its form-top sentence and receipt contexts. Non-configurable receipt values are labelled “由用户提交后生成”, and the note states that historical receipts are not rewritten.
- Typography and spacing: the live values remain readable at `1440 px` and `980 px`; long partner and ETA strings wrap inside their rows without clipping. The 1–8 badges stay subordinate to field labels while remaining easy to match. No horizontal overflow, card overlap, or footer obstruction is visible.
- Colors and tokens: the preview reuses the operations console's blue/white palette, pale-blue surfaces, orange disclosure warning, restrained borders, radii, and Phosphor icon family. The preview remains visually secondary to the editable fields and save action.
- Image quality and assets: the misleading embedded raster screenshots were removed from the UI. The only visible icon assets are the existing Phosphor components; there are no broken images, placeholders, emoji, handcrafted SVGs, or fake client screenshots.
- Copy and content: “实时预览”, “保存后才会对新页面生效”, “草稿未保存”, and the version note accurately distinguish local drafting, server save, stale-page reauthorization, and historical receipt behavior.

## Comparison history

1. The previous 1–8 pass fixed lookup names and numbering but retained three static Web screenshots. The screenshots showed an older partner, recipient, purpose, retention, consent copy, ETA, and disclosure version than the values above; the user correctly identified this as a P1 trust and comprehension failure.
2. The static image layer and image imports were removed. Three code-native client states were bound to one normalized preview model sourced from the current draft, and version handling was split into saved versus unsaved states.
3. Post-fix evidence shows the edited upper values repeated verbatim in their matching numbered preview locations at both viewport widths. The same-canvas comparison makes the elimination of stale screenshot values visible.

## Verification

- Root TypeScript: passed.
- Admin production build: passed.
- Protected mobile runtime integrity: `28` files passed.
- Focused insurance-admin E2E: `2 passed`.
- Full admin Playwright suite: `11 passed`, including three live preview states, no embedded image, exact unique 1–8 markers and legend items, initial server values, immediate draft updates, removal of old values, unsaved-version semantics, and collapsed/expanded behavior.

final result: passed

## 洗车自驾 / 代驾取送视觉 QA（2026-08-19）

### 视觉基准与证据

- 原始视觉基准：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\selected-wash-booking-ui.png`。
- 原生小程序自驾态：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-smoke-wash-booking-self-drive-final.png`（363 × 785）。
- 原生小程序代驾成功态：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-wash-valet-success.png`（363 × 785）。
- 原生小程序真实路线失败态：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-smoke-wash-booking-valet.png`（363 × 785）。
- 同画布三态对照：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\qa\wash-valet-design-qa.png`；从左至右为选定视觉基准、自驾实现、代驾费用明细。
- 代驾成功态使用 DevTools `page.setData` 注入 canonical 展示数据，仅验证布局：腾讯单程 11.7 km / 约 24 分钟、往返 23.4 km 已含、洗车 ¥38、代驾基础 ¥59、超程 ¥12、代驾合计 ¥71、总计 ¥109。生产报价逻辑未被替换，真实接口不可用时仍 fail closed。
- React 端通过 TypeScript、受保护运行时完整性和生产构建；本轮桌面内置浏览器连接因其已安装服务路径未获当前运行时信任而无法生成新的 React 截图，因此不虚构浏览器证据。React 继续使用既有选定洗车视觉、Phosphor 图标与相同信息结构。

### 结论

- 没有遗留可执行的 P0、P1 或 P2 视觉问题。
- 自驾态保持既有“车辆 → 标题 → 套餐 → 门店 → 时段 → 固定总价”的轻量层级；新增服务方式采用同一卡片内的双选分段，没有引入独立复杂流程。
- 代驾态只增加完成任务所需的信息：精确取送地址、同址往返说明、真实单程路线、服务半径、费用拆分和联系用途。取车时间明确为线下确认，不把门店洗车时段伪装成司机上门时间。
- 价格层级清晰：洗车费、代驾基础费、超程费、代驾合计和订单总计均可核对；“返程已包含、不重复收费”同时出现在路线卡和固定栏保证用户不会误解。
- 真实路线不可用、超服务半径或缺少规则时，页面用可见错误卡阻止提交，并提供重试/改选自驾，不展示估算价格或可点击的虚假 CTA。
- 支付与订单页使用“取送核销码 / 车辆交接时向平台司机出示”的语义；自驾仍是到店向门店出示。两种模式沿用同一六态订单，不制造司机实时状态。
- 所有可见业务图标来自同一 Phosphor 导出体系；没有 emoji、手绘 SVG、占位图标或假地图资产。固定提交栏保留底部安全区，页面内容底部留白大于提交栏高度，错误卡与费用明细可滚动到提交栏上方完整阅读。

### 交互检查

1. 自驾 / 代驾切换会废弃旧报价；保留的地址在切回代驾时重新获取报价。
2. 地址联想、地图选点、详细位置和交接备注都会进入最终不可变报价快照；车辆、门店、套餐或时段变化均重新报价。
3. 代驾只接受 `tencent_matrix + driving_route`，按单程计价；失败、超半径和缺规则分别阻断。
4. 模拟支付、六位码、订单列表/详情、取消、改期和再次预约均回显模式、取送地址、路线与总价；改期只变更门店服务时段，不重写已冻结地址和费用。
5. 原生小程序 TypeScript、27 个 JSON、self-drive/valet/payment/detail DevTools smoke 与 canonical 成功态视觉断言均通过。

final result: passed

# 年检查询方案 2 闭环改版（2026-08-19）

## Visual source and evidence

- Selected design direction: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\eligibility-redesign\option-2-reference.png`.
- Native mini-program form: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\eligibility-redesign-native.png` (`375 × 783`).
- Native mini-program result: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\eligibility-redesign-native-result.png` (`375 × 783`).
- Same-canvas form comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\eligibility-redesign\reference-vs-native.png` (left: selected visual; right: native implementation).
- Conversion comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\eligibility-redesign\old-result-vs-native-result.png` (left: former unknown-result dead end; right: new result-to-booking state).
- The matching React presentation surface is implemented in `src/Prototype.tsx` and `src/prototype.css`; `npm run typecheck` and `npm run build` both pass. The in-app browser connector could not initialize because its installed service path was not trusted by the current desktop runtime, so this section does not claim a new browser-rendered React capture.

## Final findings

- No actionable P0, P1, or P2 issue remains in the native mini-program flow.
- Layout and hierarchy: the form now follows the selected direction—step progress, one vehicle hero, five compact exception summaries, two high-confidence decision controls, and one fixed result CTA. Both decision controls are visible above the fixed CTA on the 375 × 783 simulator.
- Conversion: the calculation replaces the form with a dedicated result state and restores scroll position to the top. For the seeded demo vehicle, the first viewport shows “需要上线检验”, the due date and window, and “选择检测站并预约” before policy evidence.
- Truthfulness: only an explicitly labelled synthetic vehicle (`MVP`/`demo`) receives the preselected “均不符合” demonstration path. Real or temporary vehicles start without a special-case decision and cannot calculate until the user confirms one of the two branches.
- Typography and spacing: plate number, question title, compact list, selected action, and primary CTA form a clear descending hierarchy. No text or border is clipped, no horizontal overflow is visible, and the fixed CTA respects the system safe area.
- Colors and surfaces: cobalt selection/CTA, white cards, soft blue background, restrained borders, and the semantic green result state remain within the existing 驭小满 owner-service palette.
- Imagery and icons: the hero uses the existing local Tianjin/vehicle asset; controls use the existing local icon family. There are no emoji, placeholder boxes, handcrafted SVGs, or CSS illustrations.
- Accessibility and behavior: all key choices are native buttons or button-role views with practical tap heights; the detailed three-state questions appear only after the user selects the exception/uncertain branch. Loading, error, manual-review, official-guide, and booking branches remain connected.
- Intentional differences from the generated visual: the production mini-program retains the WeChat navigation chrome, a compact query-mode switch, and the product's existing photographic Tianjin vehicle hero instead of the generated white illustration. These preserve functionality and brand continuity without weakening the selected interaction model.

## Comparison and interaction history

1. The first implementation pass still pushed the two critical decision controls beneath the fixed CTA at the simulator height. Progress, mode tabs, hero height, summary rows, and action spacing were compacted without reducing tap-target size or removing content.
2. The second form capture shows both branches fully visible, a full-width fixed CTA, and the reassurance copy in the safe-area dock.
3. `npm run qa:eligibility` tapped the real calculation CTA through WeChat DevTools automation. It returned “需要上线检验” with `canBookInspection: true` and captured the independent result state.
4. The result comparison confirms the previous official/manual-review dead end is replaced, for the seeded eligible demo facts, by a visible booking action while detailed evidence remains available below.

final result: passed

## Owner home v2, root tabs, and inspection stages

### Source, state, and capture geometry

- Visual source of truth: `E:\\yuxiaoman\\Yuxiaoman-MVP-macOS\\references\\selected-owner-home-v2.png` (852 x 1846 source pixels), normalized to a 393 x 852 comparison canvas.
- Browser implementation evidence: `E:\\yuxiaoman\\Yuxiaoman-MVP-macOS\\qa\\owner-home-qa-pass1.png` (393 x 852 CSS-pixel device region at device scale factor 1).
- Full browser canvas: `E:\\yuxiaoman\\Yuxiaoman-MVP-macOS\\qa\\owner-canvas-qa-pass1.png` (1400 x 1200).
- Side-by-side evidence: `E:\\yuxiaoman\\Yuxiaoman-MVP-macOS\\qa\\owner-home-comparison-pass1.png`.
- Focused evidence: `E:\\yuxiaoman\\Yuxiaoman-MVP-macOS\\qa\\owner-home-hero-comparison.png` and `E:\\yuxiaoman\\Yuxiaoman-MVP-macOS\\qa\\owner-home-flow-services-comparison.png`.
- Initial state: owner Home tab, default vehicle, normal loaded data, no dialog, toast, keyboard, or transient loading overlay.
- Responsive checks: iPhone 393 x 852 and Pixel 427 x 952 logical screens; both had zero horizontal overflow and an unobstructed safe-area footer.
- The implementation capture retains the protected iPhone status bar, rounded bezel, and home indicator. The source image omits that chrome; it is therefore excluded from fidelity scoring.

### Findings and interaction checks

- No actionable P0, P1, or P2 issue remains.
- The visual hierarchy matches the selected direction: vehicle/inspection hero, two distinct annual-inspection actions, four compact stage entries, a unified 3 x 2 owner-service section, and persistent Home / Orders / Profile navigation.
- The primary action opens the station-booking journey. `Query inspection` opens the independent rule-estimation flow and does not create a booking.
- Each inspection-stage icon opens its parameterized stage page. In particular, the result stage does not open the generic order list and only presents a passed result or 12123 guidance when a real `inspectionResult` exists.
- Orders and Profile behave as root tabs; booking, payment, order details, and inspection-stage pages omit the root footer.
- Typography uses the established Chinese system sans stack and preserves the source hierarchy. Phosphor icons remain the single icon family; there are no emoji, placeholder icons, handcrafted SVG substitutes, or fake government assets.
- The final browser console check contained no errors or warnings.
- The remaining P3 differences are intentional product constraints: the protected device chrome reduces usable height, a completed step number may use the real semantic success color, dynamic vehicle/date content differs from the static concept, and insurance/used-car helper copy reflects the features actually implemented.

### Comparison history

1. Pass 0 found a P1 issue: the owner-services grid extended beneath the fixed footer on the 393 x 852 screen.
2. The hero actions, four-stage process, service rows, and vertical gaps were compressed without changing order, tap targets, or information architecture.
3. Pass 1 measured the services section bottom at about 802.9 px and the footer top at about 804.9 px. The complete 3 x 2 grid is visible above the footer with no overlap.
4. Browser checks then covered booking versus query routing, all four stage entries, all three root tabs, secondary-page footer hiding, result truthfulness, responsive width, and clean console output.

final result: passed

## 车险续保对接视觉 QA

### Source and evidence

- 唯一视觉基准：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\insurance-lead-selected.png`（852 × 1852，SHA-256 `7CABA3E5E79544C5368B8F31B36552498EC0A670EE6492FED5CCC314B8C4A3D5`）。
- iPhone 最终实现：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\insurance-design-qa\implementation-iphone-393x852.png`。
- Pixel 10 最终实现：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\insurance-design-qa\implementation-pixel-427x952.png`。
- 全屏同画布对照：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\insurance-design-qa\comparison-full-final.png`（左为视觉稿，右为 Pixel 10 实现）。
- 核心表单同画布对照：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\insurance-design-qa\comparison-focus-final.png`（左为视觉稿，右为实现；均从信任条开始）。
- 路由与状态：`/?screen=insurance`；默认车辆 `津A·MVP26`、30 天内、上午、联系人为空、行驶证未上传、授权未勾选。

### Final findings

- 未遗留可执行的 P0、P1 或 P2 问题。蓝白层级、低信息密度、车辆摘要、三段续保时间、线性输入、四段联系时段、单图上传、固定主按钮和服务边界均与选定视觉稿一致。
- 页面使用现有 Phosphor 图标和受保护移动运行时，没有手绘 SVG、emoji、占位资产或横向溢出。
- iPhone 393 × 852 与 Pixel 10 427 × 952 均保留状态栏、标题栏、固定 CTA、底部系统安全区；行驶证与授权通过表单自身滚动可达，设备容器不滚动。
- 模拟键盘打开后，联系人和手机号会由当前 `.mobile-scroll` 滚到固定 CTA 上方；CTA 与键盘顶边相接，关闭键盘后 `device-screen.scrollTop === 0`。该几何关系已在浏览器中复验并由 Playwright 自动断言覆盖。
- 授权弹层明确展示演示环境、具体信息接收方、用途、资料范围和保存期限；默认授权保持未勾选。
- 成功凭证只呈现编号、用户本地提交时间、车辆、脱敏手机号和预计联系时间，不包含顾问电话、报价或用户时间线。

### Iteration history

1. [P2] 直达保险路由在车辆接口返回后曾保留临时车辆 ID，导致车辆摘要短暂不可用。修复为在真实车辆列表到达时重新选择默认车辆。
2. [P2] 信任条一度把完整 ETA 与固定句式重复拼接。修复为单一后端披露文案，浏览器最终显示“提交需求，专业服务人员将在 1 个工作日内联系”。
3. [P1] iPhone 键盘出现时，焦点输入框曾被固定 CTA 遮挡。修复为仅滚动保险页 `.mobile-scroll`，以 CTA 顶部为可视下界，并在键盘动画结束后再次校准；联系人与手机号均通过。
4. [P1] 后端 UTC 提交时间曾被直接截取为本地文案。修复为浏览器本地时区格式化，并增加精确回归断言。
5. 修复后重新生成全屏与核心表单并排图；视觉稿与实现的剩余差异均为明确产品边界：60 秒而非 30 秒、授权默认不勾选、演示资料警示，以及受保护 Web 设备状态栏/安全区替代微信胶囊。

final result: passed

## Annual-inspection query visual QA

### Source truth and final evidence

- Reference form: the first user-provided “查询年检” screenshot, normalized to `393 × 852` for comparison.
- Reference result: the second user-provided “年检查询结果” screenshot, normalized to `393 × 852` for comparison.
- Final form: `artifacts/inspection-query-form-final-393x852.png`.
- Final result: `artifacts/inspection-query-result-final-393x852.png`.
- Side-by-side evidence: `artifacts/inspection-query-form-comparison.png` and `artifacts/inspection-query-result-comparison.png`.

The implementation preserves the reference task model—vehicle facts, exception declarations, one calculation action, and an explained result—while replacing the reference's orange sales treatment with the project's blue/white owner-service design. Orange is reserved for genuine urgency elsewhere; the inspected not-open result remains blue, and eligible/on-site states use the established semantic colors.

### Interaction and responsive evidence

- iPhone logical app screen: `393 × 852` CSS px; passed.
- Horizontal overflow: `0 px` on both the form and result (`scrollWidth === clientWidth`); passed.
- All three-state declaration controls are at least `44 px` high; the mode tabs and primary calculation action exceed that target.
- Temporary calculation with `2026-08`, 5 seats, non-operational small passenger car, and all declarations set to “no” returned `2028-08-31`, an application window of `2028-06-01` through `2028-08-31`, and “办理窗口尚未开始”.
- A simulated stale backend returning `404 ROUTE_NOT_FOUND` automatically used the shared local rules instead of exposing “请求的接口不存在”.
- The form introduction now says “公开车检规则测算 / 这次需要上线验车吗？” and places the 交管12123 boundary in plain language in the same card.

### Iteration history

#### Iteration 1 — blocked

- [P1] When the Web preview was newer than a still-running API process, the page exposed the raw backend message “请求的接口不存在”.
- [P2] “规则测算 · 非政务实时查询” was accurate but implementation-oriented and easy for a driver to misread.
- [P2] Three-state declaration controls were `40 px` high, below the selected phone target.

#### Final iteration — passed

- Route/network/5xx failures now fall back to the same shared pure rule function used by the API, while genuine validation failures still remain explicit.
- The introduction uses driver-facing language and keeps the official-data boundary visible without leading with technical terminology.
- Three-state targets are `44 px`; no text overlap, truncation, or horizontal overflow remains at `393 × 852`.
- Form and result screenshots were recaptured after the fixes and the side-by-side comparison artifacts were regenerated.

final result: passed

## Current delivery verdict — 车险续保对接

本次交付以“车险续保对接视觉 QA”一节及其 `comparison-full-final.png`、`comparison-focus-final.png` 为当前验收依据；全屏、核心表单、键盘、安全区与双设备检查均无遗留 P0–P2。

final result: passed

## 二手车交易视觉 QA

### 视觉基准与最终证据

- 品牌选择基准：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\used-car-brand-picker-selected.png`（853 × 1844）。
- 双列展厅基准：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\used-car-showroom-selected.png`（852 × 1846）。
- Web 品牌实现：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\used-car-brand-web-content.png`（394 × 852）。
- Web 展厅实现：`E:\yuxiaoman\Yuxiaoman-MVP-macOS\artifacts\used-car-showroom-web-content.png`（394 × 852）。
- 全屏并排对照：`artifacts/used-car-brand-comparison.png`、`artifacts/used-car-showroom-comparison.png`，均为左侧视觉稿、右侧浏览器实现。
- 聚焦并排对照：`artifacts/used-car-brand-comparison-focus.png`、`artifacts/used-car-showroom-comparison-focus.png`。
- 路由与状态：`/?screen=used-car-brand` 为理想已选品牌态；`/?screen=used-car` 为理想 L7、推荐排序、四辆具体库存态。
- 参考稿按视觉尺寸归一化至 394 × 852；实现图从 900 × 1824 高分辨率浏览器画布中的 394 × 852 设备屏区域无缩放裁切。受保护的 iPhone 运行时状态栏、灵动岛、圆角与安全区保留在实现侧，未计作页面偏差。

### 最终结论

- 未遗留可执行的 P0、P1 或 P2 视觉问题。页面保持现有蓝白车主服务设计系统，同时忠实实现所选品牌页的信息密度、热门品牌布局、A–Z 索引、选中态，以及展厅双列卡片、筛选工具栏和固定客服入口。
- 品牌严格按拼音首字母分组；B 组顺序为“宝马、奔驰、本田、比亚迪”，热门区为“理想、比亚迪、特斯拉、宝马、奔驰”。真实车标均为本地化图片资源，不使用文字代替、手绘 SVG 或远程热链。
- 展厅的一车一档卡片完整展示年款、配置、里程、所在地、数据标签和一口价；四辆理想 L7 的图片、配置、颜色、里程、上牌日期和价格互不相同。
- 参考稿中的数量属于视觉占位，最终实现展示 30 辆种子库存的实时在售聚合，因此部分品牌数量有意不同；实现额外保留“精选”和图集数量标识，以承载后台推荐权重与多图数据。
- 车辆图片均为合成演示数据且在页面明确披露；卡片图片比例、裁切主体和清晰度已经逐张检查。重点 8 辆具有多角度图集，详情页支持图集预览。
- 页面在 394 × 852 手机逻辑屏内无横向溢出；品牌行、索引、车型卡、筛选项和客服按钮均保持可用点击区域，底部内容不被安全区遮挡。

### 交互与数据链路检查

- 已在 Codex 内置浏览器完整执行：首页入口 → 品牌搜索/选择理想 → L7 车型 → 四辆具体车源 → 单车详情。
- 品牌变化会清空旧车型；零库存车型保留可见并呈现明确空态；排序、价格、车龄、里程和能源筛选可组合使用。
- 详情图集、一口价、指导价、车辆档案、车况说明、瑕疵披露与数据声明均与列表/API 数据一致；下架或售出状态进入“车源已不可用”。
- 浏览边界符合产品约束：只复用统一客服入口，不新增留资、预约、订金、支付或订单。
- 刷新后的浏览器日志时间窗内无 `error` 或 `warn`；早前一次 Vite 热更新错误为编辑过程中的瞬时日志，刷新后未复现。

### 迭代记录

1. 第一轮对照发现品牌列表过疏、热门区顺序与视觉稿不一致、B 组并非严格拼音序，展厅卡片高度与客服卡占用空间偏大。
2. 第二轮收紧品牌行高、分组标题、搜索框、热门品牌尺寸、展厅卡片间距、价格层级和客服卡高度，并将品牌热度及拼音顺序固定到后端与 Web 回退数据。
3. 最终轮补上“理想”选中态，重截品牌与展厅画面并重新生成两组左右并排证据；可见层级、密度、图片和核心交互均达到选定视觉基线。

final result: passed
# 微信小程序车险续保三列阻断验收（2026-08-17）

## Source and evidence

- Source visual truth: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\references\insurance-lead-selected.png`.
- Pre-fix bug evidence: `C:\Users\Administrator\AppData\Local\Temp\codex-clipboard-a87f1a6a-6464-41b0-b73e-0b5a9f975b43.png`.
- Post-fix implementation: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-insurance-renewal-fixed.png`.
- Full-view and focused same-canvas comparison: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\design-qa-insurance-renewal-focused.png`.
- State: 车险续保表单、默认车辆、页面已稳定加载。源视觉选中“30天内”，前态与修复后证据选中“3个月以上”；源图在本轮仅作为三列栅格、间距和层级基准，不把不同选中项当作视觉缺陷。
- Source pixels: `853 x 1844`; normalized to `363 x 785` for the comparison canvas. The aspect ratios match, so no crop or stretch was needed.
- Post-fix pixels / viewport evidence: `363 x 785`; used at native 1:1 pixel size with no density resampling.
- Pre-fix pixels: `386 x 810`; normalized proportionally to `363 x 762` and padded to `363 x 785` only as historical context. It is not used for pixel-perfect source scoring because its viewport differs.

## Findings

- No actionable P0, P1, or P2 issue remains.
- Fonts and typography: all three labels remain on one line, centered, and fully legible. The selected “3个月以上” label retains the intended blue emphasis without touching its border. Text weight and hierarchy are reasonable at the captured viewport.
- Spacing and layout rhythm: the post-fix selector uses three visually equal columns with consistent internal gaps. The first and third controls retain clear, balanced outer margins; the third control’s complete right border and both right-side corners are visible. No horizontal overflow, overlap, or clipping is visible.
- Colors and visual tokens: selected blue border/text, quiet gray unselected controls, white surface, and orange helper copy preserve the source hierarchy. The helper copy remains visually subordinate to the selector.
- Image and icon fidelity: every timing icon is visible and centered with its label; there are no broken, masked, or clipped assets. The implementation uses a smaller circular timing glyph than the source’s calendar-style glyph; this is a non-blocking P3 icon-fidelity refinement.
- Copy and content: “30天内 / 1-3个月 / 3个月以上” are complete and correctly ordered. No label wraps or truncates.
- Responsive/accessibility evidence limit: this pass proves the fixed `363 x 785` screenshot only. Static screenshots cannot verify focus behavior, semantic roles, text scaling, or alternate device widths; those are not claimed here.

## Comparison history

1. Pre-fix evidence showed a P1 layout defect: the selected third option expanded into the right edge, hiding its outer breathing room and clipping the right border/corners.
2. The implementation was corrected before this QA pass by redistributing the renewal selector into three equal-width columns with contained gaps and edge margins. This QA agent made no business-code changes.
3. Post-fix evidence shows all three controls fully contained. The third option’s icon, full label, blue border, and rounded right corners are visible, with a clear right margin. The focused crop in `design-qa-insurance-renewal-focused.png` records the target, failure state, and corrected state in one image.

## Follow-up polish

- [P3] If exact icon fidelity is desired later, increase the timing icon’s optical size slightly or use the same calendar-family glyph as the source. This does not affect containment, readability, or acceptance.

final result: passed

# 微信小程序年检特殊情况三列阻断验收（2026-08-17）

## Source and evidence

- Pre-fix source evidence: `C:\Users\Administrator\AppData\Local\Temp\codex-clipboard-8341490e-7b31-43ec-a35f-40bf0e925a5c.png` (`409 x 813`).
- Post-fix implementation evidence: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\qa-eligibility-special-fixed.png` (`363 x 785`).
- Same-content side-by-side evidence: `E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram\artifacts\design-qa-eligibility-special-focused.png` (`758 x 444`).
- State: 年检查询的“影响免检的特殊情况”区域。前态为“否”选中但右侧越界、“不清楚”列消失；修复后为“不清楚”选中且完整三列。选中值不同，因此本轮只比较控件结构、边界、层级和文案完整性，不把状态色差异当作设计漂移。
- Normalization: 前态裁取 `x=20, y=390, 363 x 386`，修复后裁取 `x=0, y=93, 363 x 386`；两侧均从分区标题开始并覆盖第 1–3 题完整内容。没有缩放、拉伸或密度重采样。
- Full-view evidence: 两张原始截图均已逐张打开检查。由于整页滚动位置不同，未用页面顶部做伪精确比较；同语义、同尺寸裁切是本轮阻断判定的主证据。

## Findings

- No actionable P0, P1, or P2 issue remains.
- Fonts and typography: 分区标题、说明、问题标题和辅助文案均清楚可读；“是 / 否 / 不清楚”在各自控件内单行居中，没有挤压、换行或截断。选中的“不清楚”通过更高字重与蓝色文字保持明确层级。
- Spacing and layout rhythm: 修复后每题都是三列等宽控件，列间距一致，左右边界均保留可见留白。三个控件的完整描边和圆角都在卡片内，没有横向溢出、重叠或跨题串行。
- Colors and visual tokens: 未选项使用低对比灰色描边/文字，选中“不清楚”使用浅蓝底、蓝色描边和强调文字；问题序号与 `02` 分区标识延续统一蓝色。状态区分清晰且未依赖裁切或位置判断。
- Image and icon fidelity: 此区域没有照片或插画。`02` 标识、1–3 数字圆标均完整、清晰、对齐稳定，没有破损、遮挡或临时占位资产。
- Copy and content: “不确定时请选择‘不清楚’”“以上情况均不符合”及第 1–3 题问题/说明均完整可见；每行均恢复“是 / 否 / 不清楚”三个选择，没有内容消失。
- Responsiveness: 修复证据宽度仅 `363 px`，且比前态 `409 px` 更窄，三列仍完整包含在卡片内，原 P1 已被直接反证。静态证据不覆盖更窄设备、文字放大、焦点或真实点击热区，这些不在本轮截图结论内。

## Comparison history

1. Pre-fix evidence recorded a P1 layout failure: each row effectively rendered as two oversized tracks; selected “否” extended beyond the right boundary and the required “不清楚” option disappeared.
2. The implementation was corrected before this QA pass to render three contained, equal-width choices per question. This QA agent made no business-code changes.
3. Post-fix evidence at the narrower `363 px` viewport shows “是 / 否 / 不清楚” fully visible on all inspected rows. Right borders, rounded corners, inter-column gaps, and card margins are intact; the former P1 is eliminated.

## Follow-up polish

- No P3 visual refinement is required for this focused control.

final result: passed
