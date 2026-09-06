# 车主车辆品牌／车系目录

2026-09-05：原目录仅 6 个品牌、12 款车型，现扩展为 148 个品牌／车辆形式、1,581 款车系，覆盖国内常见合资、自主、新能源、进口、部分停产品牌，以及常见客车、轻卡、重卡、牵引车和挂车形式。它用于车主添加、编辑和识别自己的车辆，不是租赁库存，也不是在售车型或逐年逐配置数据库。不声称覆盖所有车辆或实时同步厂商。

## 维护

- 数据文件：`server/vehicle-catalog-data.ts`。每个品牌和车系使用显式、固定的英文编号，显示名可包含中文；不要依赖行号生成编号。
- 原 12 个 `vehicle-*` 编号和品牌关联继续兼容。已保存车辆继续使用服务端名称快照。
- 新条目只填品牌、车系和搜索别名。不根据车系自动推断座位数、动力类型、洗车价格类别、检验政策或可预约性。
- 车型展示层采用显式 ID 映射，148 个品牌/车辆形式的 1,581 款车型均有审核过的统一角度展示素材：1,561 款乘用车，以及目录内全部 20 款客车、轻卡、重卡、牵引车和挂车形式。所有素材使用白色车身、左前 45°、完整车身、统一比例、透明背景和克制棚拍阴影。道路、展厅、车尾和不同裁切角度的照片不得进入车主选择器或首页；每个车型必须使用自己的精确车系素材，不得复用、通用图或占位图。完整名称目录和展示素材均由服务端映射加载，以保持稳定 ID 与历史记录兼容。映射在 `server/vehicle-catalog-images.ts`，源素材与生成规格在 `references/owner-vehicle-presentation-v2.json`。
- 每个车型都声明 `vehicleClassCodes`。选择号牌类型后，原生车型选择器只显示对应车辆类别：乘用车、轻型货车、大型客车、大型牵引车、挂车或大型货车。切换到不兼容类别时清除已选车型；API 也会拒绝类别错配。
- 小型普通客车和大型普通客车可保存车身颜色。常用颜色由界面选择，字段允许为空；切换到货车、牵引车或挂车后服务端将颜色清空，避免无关档案数据进入后续页面。
- 型号按车系粒度登记。例如秦PLUS 的动力及年款配置仍由车主独立填写。部分改名车系保留历史名称，方便老车登记；“收录”不代表仍在售。
- 目录和车型展示图均由 API 下发，不加入小程序主包。可视选择器先过滤为已完成统一展示图且符合当前车辆类别的车型，再按当前品牌懒加载图片；搜索支持中文、品牌英文／拼音别名、品牌加车系、大小写、空格与常见分隔符。
- 添加或更正车型时核对厂商资料，保留已有 ID。按需扩展 `keywords`，不要为检索便利伪造品牌或车型。

## 本轮参考入口

人工整理车系名，并抽查下列厂商公开目录／产品页面（2026-09-04）。这些链接用于后续校订，不表示每一个历史条目都完成了厂商逐项认证。

- [大众中国全系车型](https://www.vw.com.cn/CarModelList.html)
- [比亚迪王朝车型](https://www.byd.com/cn/dynasty-home/models)
- [比亚迪秦PLUS](https://bydauto.com.cn/cn/dynasty-home/models/qin/26-qin-plus-dm-i)
- [奇瑞汽车](https://www.chery.cn/)
- [吉利汽车中国车型入口](https://dh.geely.com/Home)
- [理想汽车](https://www.lixiang.com/)
- [小鹏汽车](https://www.xiaopeng.com/)
- [小米汽车](https://www.xiaomiev.com/)
- [鸿蒙智行品牌入口](https://hima.auto/)
- [智己汽车](https://www.immotors.com/)
- [天津一汽夏利历史年报](https://disc.static.szse.cn/download/disc/disk01/finalpage/2018-03-31/ee7a724f-b261-4188-aea3-e689c5aa21c0.PDF)
- [江西五十铃车型及发展历程](https://www.jiangxi-isuzu.cn/Brand/course.shtml)
- [马牌传动系统售后车型适配目录（含开瑞历史车系）](https://www.continental-engineparts.com/cn/zh/Automotive-Aftermarket/Service-Support/Downloads/docs/continental_2020_set_catalogue.pdf)

2026-09-05 商用车补录还核对了下列厂商产品入口；图片本身采用可追溯、可复用许可的 Wikimedia Commons 文件页，并逐项记录在商用车来源清单中。

- [一汽解放产品布局](https://www.fawjiefang.com.cn/fawjiefang/gywm12/gsjj/cpbj/index.html)
- [福田汽车产品中心](https://www.foton.com.cn/webback/about/brandMoble/carListFfstFKf2.html)
- [福田欧马可产品中心](https://aumark.foton.com.cn/productShow?id=15)
- [江淮轻卡车型](https://yika.jac.com.cn/model/)
- [陕汽商用车产品手册入口](https://www.shacman.com/product/user-guide)

## 验证

- `npm --prefix wechat-miniprogram run test:vehicle-catalog`：编号唯一性、关联、1,581 张固定角度展示图不复用及资源存在性；全量车型均由服务端加载；旧 ID 兼容；车辆类别筛选；搜索；车型与颜色保存；失败重试。
- `node --import tsx --test --test-name-pattern="车辆品牌车型目录" server/tests/api.test.ts`：独立 PostgreSQL 测试库中的新增／编辑／读取、名称快照、错配拒绝、清除、旧车兼容。
- `npm --prefix wechat-miniprogram run typecheck` 与 `npm --prefix wechat-miniprogram run check:main-package`。
- `npm --prefix wechat-miniprogram run qa:vehicle-catalog`：通过新版 `wechatide` CLI 在开发者工具中验证实际搜索、切换、回显及空状态并截图；需要已登录并授权的本机 CLI，不提交或修改车主车辆。`WECHATIDE_CLI` 可指定 CLI 绝对路径。

本地修改需要共享 API 重新加载和开发者工具重新编译；体验版／正式版需要另行部署 API 并发布小程序版本。
