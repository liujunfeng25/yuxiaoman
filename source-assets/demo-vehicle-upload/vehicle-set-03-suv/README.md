# SUV 真实上传测试素材：2019 Toyota RAV4 XA50

本目录用于小程序车辆四角照片、缩略图和演示流程测试。五张素材均为真实拍摄照片，不是 AI 生成图。

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

- 五张图均为白色 2019 Toyota RAV4 4x2 XLE（XA50），由同一作者在同一展厅连续 102 秒内拍摄。
- 外观位置、轮毂、展位和库存标签“1947”一致，因此高置信为同一物理车辆；Commons 未提供 VIN，不能表述为已经独立验证。
- 仪表组合屏和车门警示灯已亮，能够证明点火或附件电源开启；静态照片不能证明发动机一定在运行。

## 处理方式

下载日期：2026-08-22。输出统一为 1920 × 1440、JPEG、质量 84；自动校正方向，以浅灰底完整适配 4:3，不裁掉车辆主体，并移除 EXIF、ICC 和 XMP 元数据。外观使用的是展车展示牌，不含真实主车牌。

## 来源与授权

五张照片作者均为 [Captainmorlypogi1959](https://commons.wikimedia.org/wiki/User:Captainmorlypogi1959)，许可均为 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)：

- 左前：[Toyota RAV4 4x2 XLE 2019 (2)](https://commons.wikimedia.org/wiki/File:Toyota_RAV4_4x2_XLE_2019_%282%29.jpg)
- 右前：[Toyota RAV4 4x2 XLE 2019 (1)](https://commons.wikimedia.org/wiki/File:Toyota_RAV4_4x2_XLE_2019_%281%29.jpg)
- 左后：[Toyota RAV4 4x2 XLE 2019 (5)](https://commons.wikimedia.org/wiki/File:Toyota_RAV4_4x2_XLE_2019_%285%29.jpg)
- 右后：[Toyota RAV4 4x2 XLE 2019 (7)](https://commons.wikimedia.org/wiki/File:Toyota_RAV4_4x2_XLE_2019_%287%29.jpg)
- 通电仪表盘：[Toyota RAV4 4x2 XLE 2019 Interior](https://commons.wikimedia.org/wiki/File:Toyota_RAV4_4x2_XLE_2019_Interior.jpg)

本项目副本做过缩放、留边、JPEG 转换和元数据移除。详细来源与 SHA-256 见 `manifest.json`。
