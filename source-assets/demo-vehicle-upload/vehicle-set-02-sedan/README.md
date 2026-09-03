# 小轿车真实上传测试素材：Mercedes-Benz S 级 W223

本目录用于小程序车辆四角照片、缩略图和演示流程测试。素材均为真实拍摄照片，不是 AI 生成图。

## 文件与上传位置

| 文件 | 画面 | 当前 API `MediaKind` | 用途 |
| --- | --- | --- | --- |
| `01-vehicle-front-left.jpg` | 车辆左前 | `vehicle_front_left` | 可直接用于现有四角照片上传 |
| `02-vehicle-front-right.jpg` | 车辆右前 | `vehicle_front_right` | 可直接用于现有四角照片上传 |
| `03-vehicle-rear-left.jpg` | 车辆左后 | `vehicle_rear_left` | 可直接用于现有四角照片上传 |
| `04-vehicle-rear-right.jpg` | 车辆右后 | `vehicle_rear_right` | 可直接用于现有四角照片上传 |
| `05-dashboard-powered-on.jpg` | 通电后仪表盘 | 暂不支持 | 当前接口会以 `MEDIA_KIND_INVALID` 拒绝该类型 |

完整的上门取送年检预约还需要行驶证主页和副页，本目录的五张图不能单独完成全部资料上传。

## 一致性说明

- 四张外观均为黑色 Mercedes-Benz S 400d 4MATIC AMG Line（W223），车型、配置和颜色一致。
- `01` 与 `03` 来自 2024-02-23 的同一拍摄序列；`02` 与 `04` 来自 2023-12-26 的同一拍摄序列。
- Wikimedia Commons 没有提供 VIN，不能承诺四张外观都来自同一物理车辆。
- `05` 是同代 W223 家族的 Mercedes-AMG S 63 E PERFORMANCE 内饰，数字仪表和中控屏已点亮；它与外观照片不是同一车辆，也不是同一动力配置。

## 处理方式

下载日期：2026-08-22。输出统一为 1920 × 1440、JPEG、质量 84；自动校正方向，以浅灰底完整适配 4:3，不裁掉车辆主体，并移除 EXIF、ICC 和 XMP 元数据。外观照片中的主车牌已由原作者模糊。

## 来源与授权

- 左前：[Mercedes-Benz W223 S 400d Obsidian Black (5)](https://commons.wikimedia.org/wiki/File%3AMercedes-Benz_W223_S_400d_4MATIC_AMG_Line_Obsidian_Black_%285%29.jpg)，作者 Damian B Oh，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。
- 右前：[Mercedes-Benz W223 S 400d Obsidian Black (1)](https://commons.wikimedia.org/wiki/File%3AMercedes-Benz_W223_S_400d_4MATIC_AMG_Line_Obsidian_Black_%281%29.jpg)，作者 Damian B Oh，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。
- 左后：[Mercedes-Benz W223 S 400d Obsidian Black (15)](https://commons.wikimedia.org/wiki/File%3AMercedes-Benz_W223_S_400d_4MATIC_AMG_Line_Obsidian_Black_%2815%29.jpg)，作者 Damian B Oh，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。
- 右后：[Mercedes-Benz W223 S 400d Obsidian Black (2)](https://commons.wikimedia.org/wiki/File%3AMercedes-Benz_W223_S_400d_4MATIC_AMG_Line_Obsidian_Black_%282%29.jpg)，作者 Damian B Oh，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。
- 通电仪表盘：[Mercedes-AMG S 63 E PERFORMANCE (W223) interior](https://commons.wikimedia.org/wiki/File%3AMercedes-AMG_S_63_E_PERFORMANCE_%28W223%29_interior.jpg)，作者 Tokumeigakarinoaoshima，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。

本项目副本做过缩放、留边、JPEG 转换和元数据移除。详细来源与 SHA-256 见 `manifest.json`。
