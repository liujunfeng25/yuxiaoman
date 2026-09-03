# 真实车辆上传测试素材

这里集中存放小程序车辆照片上传、缩略图、订单资料和演示流程使用的真实车辆照片。图片均来自 Wikimedia Commons 的开放授权素材，不是 AI 生成图。

## 素材组

| 目录 | 类型 | 主要车型 | 图片数 | 一致性摘要 |
| --- | --- | --- | --- | --- |
| `vehicle-set-01` | 轿车/新能源 | Nissan Leaf ZE1 | 5 | 同代车型，不全是同一辆实车 |
| `vehicle-set-02-sedan` | 小轿车 | Mercedes-Benz S 级 W223 | 5 | 外观同车型同色，分两次拍摄；仪表为同代不同配置 |
| `vehicle-set-03-suv` | SUV | 2019 Toyota RAV4 XA50 | 5 | 同一展厅连续拍摄，高置信为同一辆实车 |
| `vehicle-set-04-mpv` | MPV | 2013 Honda Odyssey | 5 | 外观由两辆同款白色实车组成；仪表来自 Toyota Sienta |

每组都包含以下统一文件：

- `01-vehicle-front-left.jpg`：车辆左前
- `02-vehicle-front-right.jpg`：车辆右前
- `03-vehicle-rear-left.jpg`：车辆左后
- `04-vehicle-rear-right.jpg`：车辆右后
- `05-dashboard-powered-on.jpg`：车辆通电后的仪表盘

前四张可对应当前 API 的四种车辆照片 `MediaKind`。仪表盘目前没有对应的 `MediaKind`，直接上传会返回 `MEDIA_KIND_INVALID`，因此当前仅作为测试和演示素材。完整上门取送年检预约还需要行驶证主页和副页。

## 使用规则

- 演示时按各目录 `README.md` 的“一致性说明”介绍，不得把不同车辆说成同一辆。
- “通电后仪表盘”只说明点火或附件电源已开启；静态照片不能单独证明发动机正在运行。
- 每张图片的来源、作者、许可、处理说明、文件大小和 SHA-256 记录在同目录 `manifest.json`。
- 修改后的 CC BY-SA 图片仍需保留署名、许可链接、改动说明，并按相同或兼容许可分享；不得暗示原作者为本项目背书。

所有输出均为 1920 × 1440 JPEG，使用浅灰留边完整适配 4:3，并移除了 EXIF、ICC 和 XMP 元数据。
