# 车主车型展示素材全量覆盖

目标是为车主车型库的 148 个品牌/车辆形式、1,581 个车型 ID 各提供一张独立且通过复核的展示素材。展示标准固定为白色车辆、左前 45°、视线高度、整车入镜、透明背景、相同比例规则和轻微接地阴影。

## 当前覆盖

- 全量清单：`references/owner-vehicle-presentation-inventory.json`
- 供应商导入表：`references/owner-vehicle-presentation-provider-intake.csv`
- 已复核并发布：1,581 款
- 待补充和逐条复核：0 款
- 乘用车：1,561 款已全部完成
- 客车、轻卡、重卡、牵引车和 7 种挂车形式：20 款已全部完成

运行 `npm run export:owner-vehicle-presentation-inventory` 会从服务端车型目录重新生成这两份文件，并在品牌或车型总数偏离 148/1,581 时失败。`npm run check:owner-vehicle-assets` 检查全量 1,581 个展示资源、精确 ID 映射与目录清单是否一致。

## 批量素材来源

乘用车和轻型商用车可使用 IMAGIN.studio 作为参考候选来源。请求固定使用 `angle=28`、`paintDescription=white`、`zoomType=relative`、`fileType=webp` 和 `width=800`。候选只用于确认精确车系；最终展示图统一保存为自有源 PNG，经过审核后构建为 WebP，并由服务端目录向小程序按需提供。

没有供应商凭据时，可运行 `npm run probe:owner-vehicle-commons -- --offset 0 --limit 50`，从 Wikimedia Commons API 建立带作者和许可信息的精确车系参考候选。标题匹配只负责提名，候选仍需逐张确认车型身份，再用统一角度模板生成展示图；参考来源记录在 `references/owner-vehicle-commons-sources.json`。

供应商可能在精确车型尚未生成时返回相近车型或占位图，所以 HTTP 成功不能直接发布。配置 `IMAGIN_STUDIO_CUSTOMER_KEY` 后可运行 `npm run probe:owner-vehicle-imagin -- --limit 50`，脚本会记录供应商的匹配响应头并生成可续跑的探测报告。所有候选都必须经车型、视角、完整车身、透明通道、尺寸和重复哈希复核后，才可替换全量展示素材。

最终展示素材由驭小满服务器提供，小程序按需加载，不进入小程序包。供应商候选遵循其许可限制，不作为未经审核的线上展示资产。

全量素材的完成流程是：以制造商或车身形式的精确参考图确认车型，制作统一角度的自有透明展示源 PNG，检查车型身份、视角、完整车身、透明通道、尺寸和重复哈希，再构建 WebP 并加入 `server/vehicle-catalog-images.ts`。每个 ID 必须独立对应一张素材，禁止复用、通用图和占位图。
