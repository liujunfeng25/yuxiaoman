# 驭小满原生微信小程序

这是独立于现有 React 客户端、Fastify 服务、PostgreSQL 数据库和桌面运营后台的原生微信小程序工程。小程序只复用既有 API 契约，不改动或替换 Web 客户端运行时。

## 当前工程

- 小程序 AppID（正式号，与线上一致）：`wxc2bcae6b519337e0`（以 `project.config.json` 为准）
- 微信开发者工具导入目录：本 `wechat-miniprogram/` 目录
- 小程序源码目录：`miniprogram/`
- 模拟器 / 开发版请求地址：`http://127.0.0.1:8792/api`（或真机局域网 IP，见 `miniprogram/config/env.ts`）
- 真机联调监听地址：`0.0.0.0:8792`（仅用于服务端监听；手机请求时必须使用开发机局域网 IP）
- 体验版 / 正式版 API：`https://app.yuxiaomancs.com/api`（已在 `env.ts` 的 `PRODUCTION_API_BASE`；须在公众平台配置为 request/upload/download 合法域名）
- 服务端须配置 `WECHAT_MINIPROGRAM_APP_ID` / `WECHAT_MINIPROGRAM_APP_SECRET`（与上列正式 AppID 一致）；切勿把 AppSecret 写进小程序代码

历史上曾用过开发测试号 `wxd0ab9d695ded7eda`，**已废弃**，不要再按该 AppID 配置或上传。

## Windows 本地联调

先在仓库根目录用小程序专用入口启动 API：

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run api:mini
```

`api:mini` 固定监听 `0.0.0.0:8792`，不会被仓库 `.env` 中供普通 Web 开发使用的 `HOST=127.0.0.1` 覆盖。模拟器仍请求 `127.0.0.1:8792`；`0.0.0.0` 只是监听地址，不能写进小程序请求 URL。`npm run api:dev` 会继续遵循 `.env`，不用于真机局域网联调。

小程序启动后会通过 `wx.login()` 获取一次性 `code`，只把该 `code` 发给 `/api/auth/wechat/session`，并在本地保存服务端返回的不透明应用 token 与过期时间。所有业务请求和上传统一携带 Bearer；401 只会触发一次重新登录和重试。OpenID、UnionID、内部用户 ID、`session_key` 和 AppSecret 均不进入客户端。

若本地服务尚未配置微信身份交换，开发版会继续发送无 Bearer 请求；只有服务端在非生产环境显式设置 `YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK=true` 时，这些请求才会归属到 `demo-user`。正式版不会执行该降级，必须配置生产 HTTPS API，并且只在服务端环境中设置 `WECHAT_MINIPROGRAM_APP_ID` 与 `WECHAT_MINIPROGRAM_APP_SECRET`。

然后在微信开发者工具导入本目录。当前 `project.config.json` 已配置正确的 AppID、TypeScript 编译插件和 `miniprogram/` 源码根目录；本地调试使用 `urlCheck: false`，仅用于模拟器联调。

### 真机调试 / 预览

模拟器里的 `127.0.0.1` 指向开发机，但真机上的 `127.0.0.1` 是手机自身，因此会出现 `request:fail errcode:-102`（连接被拒绝）。

1. 用 `ipconfig` 查看电脑局域网 IP，写入 `miniprogram/config/env.ts` 的 `DEVICE_LAN_HOST`（当前示例为 `192.168.1.16`）。
2. 确保 `npm run api:mini` 正在运行；需要本地腾讯地图确定性桩时可改用 `npm run api:mini:qa-map`。两个入口都固定绑定到 `0.0.0.0:8792`，允许局域网访问。
3. 手机与电脑连接同一 Wi-Fi；Windows 防火墙若拦截，需放行 8792 端口。
4. 微信开发者工具勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」后再点真机调试。

如需通过 Nightly CLI 打开并启用自动化：

```powershell
& 'D:\微信web开发者工具\cli.bat' open --project 'E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram' --lang zh
& 'D:\微信web开发者工具\cli.bat' auto --project 'E:\yuxiaoman\Yuxiaoman-MVP-macOS\wechat-miniprogram' --port 9420 --auto-port 9421 --trust-project --lang zh
```

## 已实现流程

- 车主：首页、车辆档案和车牌键盘、年检测算、材料、服务方式、检测站、时段、预约、订单与结果。
- 洗车：车辆、套餐、门店、日期时段、报价、模拟支付、核销码、取消/退款或改期。
- 车险：续保需求登记、行驶证图片、知情同意、提交凭证、防重复提交和撤回。
- 汽车租赁：同店取还或同址送取、地点与时间搜索、品牌 A–Z 筛选、指定车型、透明报价、驾驶资格确认、订单、模拟支付、取消与履约状态。车型、库存、价格、押金和订单均明确标注为合成演示数据。
- 检测端：工作台、任务详情、导航、到车核验、挂起/恢复、检测交接、模拟结果回传、完成服务和站点号源。

## 校验

TypeScript 静态检查：

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run check
```

`check` 同时执行 TypeScript、会话与 401 重试测试、JSON/页面注册、字面路由、跨包 import、静态资源与 WXS 路径校验，并检查各业务流程的关键契约。主包只保留首页、订单、我的三个 Tab；年检、洗车、车险、租车、车辆档案和运营工作台均为可复用主包共享代码的普通分包。

其中 `9420` 是开发者工具 HTTP 服务端口，`9421` 才是 `miniprogram-automator` 使用的 WebSocket 端口。在自动化端口 `9421` 已启动后，执行真实微信编译、渲染和截图冒烟：

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run qa:smoke
```

可以通过 `WECHAT_QA_ROUTE`、`WECHAT_QA_SCREENSHOT` 和 `WECHAT_QA_WAIT_MS` 指定页面、截图名和等待时间。截图输出到忽略提交的 `artifacts/`。

## 资源与发布边界

微信包内图片已压缩为适配移动端的 JPG/PNG/WebP。`check:main-package` 以主包不超过 1.5 MiB 为项目预算，并同步阻断单包超过微信 2 MiB、全部包超过 20 MiB；业务专用工具和资源跟随其普通分包，高分辨率源图保存在 `source-assets/`，不会随小程序上传。

正式发布前还需：配置 `miniprogram/config/env.ts` 的生产 HTTPS API、在微信后台登记域名、用正式账号完成隐私与类目配置，并在真机验证图片选择、上传、定位、拨号和客服能力。仓库中不应保存 AppSecret、地图密钥或其他服务密钥。
