# 真实车辆上传测试素材 01

本目录用于小程序车辆照片上传、缩略图、订单资料和演示流程测试。素材均为真实拍摄的 Nissan Leaf ZE1（第二代）照片，不是 AI 生成图。

## 文件与上传位置

| 文件 | 画面 | 当前 API `MediaKind` | 用途 |
| --- | --- | --- | --- |
| `01-vehicle-front-left.jpg` | 车辆左前 | `vehicle_front_left` | 可直接用于现有四角照片上传 |
| `02-vehicle-front-right.jpg` | 车辆右前 | `vehicle_front_right` | 可直接用于现有四角照片上传 |
| `03-vehicle-rear-left.jpg` | 车辆左后 | `vehicle_rear_left` | 可直接用于现有四角照片上传 |
| `04-vehicle-rear-right.jpg` | 车辆右后 | `vehicle_rear_right` | 可直接用于现有四角照片上传 |
| `05-dashboard-powered-on.jpg` | 通电后仪表盘 | 暂不支持 | 仅用于测试素材和演示；当前接口会以 `MEDIA_KIND_INVALID` 拒绝该类型 |

完整的上门取送年检预约目前还需要行驶证主页和副页，本目录的五张图不能单独完成六项资料上传。

## 一致性说明

- `01`、`02`、`04` 是同一辆 2018 Nissan Leaf SV 银色实车在同一组拍摄中的三个角度。
- `03` 是另一辆 2019 Nissan Leaf ZE1 白色实车。
- `05` 是另一辆同代 Nissan Leaf ZE1 的通电仪表盘。
- 因此这是一组“同车型测试素材”，不能对外宣称五张照片来自同一辆车。照片中的车辆、牌照和场景与本项目演示账户没有真实关联。

## 处理方式

下载日期：2026-08-22。

输出统一为 1920 × 1440、JPEG、质量 84。处理时自动校正方向，以浅灰底完整适配 4:3，不裁掉车辆主体；主要可辨识车牌已模糊，并移除 EXIF、ICC 和 XMP 元数据。最终五张图均已逐张核对角度和显示完整性。

## 来源与授权

- 左前：[2018 Nissan Leaf SV in Brilliant Silver, front left](https://commons.wikimedia.org/wiki/File:2018_Nissan_Leaf_SV_in_Brilliant_Silver,_front_left.jpg)，作者 Mr.choppers，[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)。
- 右前：[2018 Nissan Leaf SV in Brilliant Silver, front right](https://commons.wikimedia.org/wiki/File:2018_Nissan_Leaf_SV_in_Brilliant_Silver,_front_right.jpg)，作者 Mr.choppers，[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)。
- 左后：[2019 Nissan Leaf (NY), rear left](https://commons.wikimedia.org/wiki/File:2019_Nissan_Leaf_%28NY%29,_rear_left.jpg)，作者 Mr.choppers，[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)。
- 右后：[2018 Nissan Leaf SV in Brilliant Silver, rear right](https://commons.wikimedia.org/wiki/File:2018_Nissan_Leaf_SV_in_Brilliant_Silver,_rear_right.jpg)，作者 Mr.choppers，[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)。
- 通电仪表盘：[Nissan Leaf ZE1 Cockpit](https://commons.wikimedia.org/wiki/File:Nissan_Leaf_ZE1_Cockpit.jpg)，作者 223系新快速，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。

本项目副本做过缩放、留边、JPEG 转换、车牌模糊和元数据移除。每张文件的来源、许可、尺寸和 SHA-256 详见 `manifest.json`。
