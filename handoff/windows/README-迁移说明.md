# 驭小满小程序 + 后台迁移说明（Windows）

这份迁移包可在另一台 Windows 电脑上恢复完整演示环境：原生微信小程序、API、运营后台、PostgreSQL 业务数据、上传文件、静态车辆素材和当前已经配置的服务端密钥。

## 安全提醒

迁移包中的以下文件都属于敏感资料：

- 项目根目录 `.env`：现有服务端配置和已经配置的第三方密钥。
- `handoff/windows/transfer.env`：新目标数据库的账号和随机密码。
- `database/yuxiaoman_dev.pgdump`：用户、车辆、订单等业务数据备份。
- `data/uploads` 与 `data/private`：用户上传文件及私有资料目录。

只传输加密包，解密密码请通过另一种通信方式发送。解压后的目录不要上传网盘公开链接、不要提交 Git，也不要发给无关人员。迁移完成后，建议妥善保管或删除传输副本。

微信 `AppSecret` 不应存在于小程序客户端代码中。本包只会迁移项目里原本已经存在的密钥；如果当前后台尚未配置微信 `AppSecret`，迁移包不会凭空生成。另一台电脑仍需由该小程序项目的管理员扫码登录微信开发者工具。

## 目标电脑准备

请先安装并启动：

1. Docker Desktop（使用 Linux containers，并等待主界面显示 Docker 正常运行）。
2. Node.js 24 x64（自带 npm）。
3. 微信开发者工具，并使用有该 AppID 开发权限的微信账号登录。

手机和目标电脑应连接同一个 Wi-Fi/局域网。公共 Wi-Fi、访客网络或开启“客户端隔离”的路由器可能阻止真机访问电脑。

## 一键恢复与启动

解密并解压后，在项目目录打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd .\handoff\windows
.\Start-All.ps1
```

首次运行会自动完成：

1. 检查 Node.js、npm 与 Docker。
2. 检测目标电脑的局域网 IPv4，并只修改小程序 `DEVICE_LAN_HOST`。
3. 启动带密码认证的 PostgreSQL 17.9，只绑定 `127.0.0.1:55432`。
4. 在空数据库中恢复迁移备份，并创建隔离的测试数据库。
5. 根据锁文件执行 `npm ci`，后台启动 API 与运营后台，日志写入 `.runtime/handoff-logs`。

启动完成后可访问：

- API 健康检查：`http://127.0.0.1:8792/api/health`
- 运营后台：`http://127.0.0.1:5174`
- 微信开发者工具导入目录：`wechat-miniprogram`

微信开发者工具中应导入上面的原生小程序目录，不要导入旧的 `wx` 目录或 React MVP。导入后确认 AppID 正确，再点“编译”。

以后再次启动时可跳过重复安装依赖：

```powershell
.\Start-All.ps1 -SkipInstall
```

数据库已有业务表时，恢复脚本会自动跳过覆盖，因此日常启动不会清空新数据。

## 局域网 IP 与真机调试

通常 `Start-All.ps1` 会自动选择带默认网关的真实 Wi-Fi/以太网地址。如果选错，先用 `ipconfig` 确认电脑地址，再手动指定：

```powershell
.\Configure-Target.ps1 -LanIp 192.168.1.23
.\Start-All.ps1 -SkipLanConfigure -SkipInstall -SkipRestore
```

如果开发者工具模拟器可用、手机却请求失败，优先检查：

1. 手机与电脑是否处于同一局域网。
2. Windows 网络配置是否为“专用网络”。
3. Windows 防火墙是否允许 Node.js 在专用网络通信。
4. 路由器是否开启访客网络/客户端隔离。

需要显式开放端口时，请以管理员身份打开 PowerShell，运行：

```powershell
cd <项目目录>\handoff\windows
.\Configure-Target.ps1 -OpenFirewall
```

该命令只创建专用网络 TCP 8792 入站规则；数据库端口 55432 始终只绑定本机，不向局域网开放。

## 停止服务

```powershell
.\Stop-All.ps1
```

它会停止本次脚本启动的 API、运营后台和 PostgreSQL 容器。数据库内容仍保存在 Docker 卷 `yuxiaoman_postgres_data` 中，不会删除。

如果希望停止 API 和后台、但让 PostgreSQL 继续运行：

```powershell
.\Stop-All.ps1 -KeepDatabase
```

## 手动恢复数据库

仅恢复/检查数据库：

```powershell
.\Restore-Database.ps1
```

当目标数据库已含业务表时，脚本默认拒绝覆盖。只有明确要用迁移快照替换目标机现有数据时，才运行下面的破坏性命令：

```powershell
.\Restore-Database.ps1 -Force
```

`-Force` 会删除目标机 `yuxiaoman_dev` 的现有内容后恢复备份。它不会删除迁移包中的 dump，也不会删除 Docker 数据卷。

## 常见问题

### Docker 提示无法连接

先手动启动 Docker Desktop，等待引擎完全就绪，再运行脚本。首次启动还需要联网拉取 `postgres:17.9` 镜像。

### `npm ci` 下载失败

检查目标电脑能否访问 npm registry。依赖不会被打进迁移包，脚本会严格按 `package-lock.json` 安装，以避免两台电脑依赖版本漂移。

### 后台打不开

查看 `.runtime/handoff-logs` 中最新的 `api-*.err.log` 和 `admin-*.err.log`。也可先访问 API 健康检查地址判断数据库/API 是否正常。

### 车辆图片在真机不显示

当前车型示意图已改为小程序本地 PNG；确认微信开发者工具导入的是迁移包内的 `wechat-miniprogram`，并重新编译、清除缓存。无需让手机访问后台静态图片地址。

### 微信开发者工具提示无权限

AppID 可以随项目配置迁移，但开发者身份不会随文件迁移。请让小程序管理员在微信公众平台添加目标微信号为开发成员，然后重新扫码登录。
