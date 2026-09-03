# 驭小满完整项目迁移说明（macOS）

此迁移包包含原生微信小程序、运营后台、API、PostgreSQL 业务快照、上传资料、测试素材、QA 证据、PPT 成品及生成源码。压缩包未加密，`.env` 与业务数据均为明文，仅应在你自己的设备之间传输。

## Mac 需要安装

1. Docker Desktop for Mac（Apple Silicon 或 Intel 版本均可）。
2. Node.js 24.x（自带 npm 11.x）。
3. macOS 版微信开发者工具，并使用有当前 AppID 开发权限的微信账号登录。
4. 如需编辑 PPT，建议安装 Microsoft PowerPoint；如需由 Codex 重新生成 PPT，让新电脑上的 Codex 加载其本机 Presentations 运行时即可，不要复制 Windows 的 `node_modules`。

Apple Silicon 没有业务层兼容问题。依赖会通过锁文件在 Mac 上重新安装为 `darwin-arm64` 版本；PostgreSQL 17.9 容器也支持 Apple Silicon。

## 首次启动

先打开 Docker Desktop，等待引擎显示正常，然后在 Terminal 中进入解压目录：

```bash
bash handoff/macos/start-all.sh
```

首次执行会：

1. 识别 Mac 当前局域网地址，并更新小程序真机 API 地址。
2. 启动 PostgreSQL 17.9 容器。
3. 从 `database/yuxiaoman_dev.pgdump` 和 `database/yuxiaoman_test.pgdump` 恢复当前运行库与完整测试库。
4. 执行根项目和小程序目录的 `npm ci`。
5. 启动 API 与运营后台。

启动完成后：

- 运营后台：`http://127.0.0.1:5174`
- API 健康检查：`http://127.0.0.1:8792/api/health`
- 微信开发者工具导入目录：`wechat-miniprogram`

小程序真机和 Mac 必须在同一局域网。若自动识别 IP 不正确，可手动运行：

```bash
LAN_IP=192.168.1.23 bash handoff/macos/start-all.sh
```

日常再次启动时可跳过依赖安装和数据库恢复检查：

```bash
SKIP_INSTALL=1 SKIP_RESTORE=1 bash handoff/macos/start-all.sh
```

## 停止服务

```bash
bash handoff/macos/stop-all.sh
```

如需保留数据库容器运行：

```bash
KEEP_DATABASE=1 bash handoff/macos/stop-all.sh
```

## 数据库恢复规则

默认只会在目标数据库没有业务表时恢复，避免覆盖你在新电脑上继续产生的数据。仅当你明确要用迁移快照覆盖目标库时运行：

```bash
FORCE_RESTORE=1 bash handoff/macos/restore-database.sh
```

这会删除目标容器中的 `yuxiaoman_dev` 数据库并重新恢复；不会删除迁移包内的 `.pgdump` 文件。

## 微信开发者工具

- 导入 `wechat-miniprogram`，不要导入旧 React MVP。
- AppID 随 `project.config.json` 保留，但开发者登录身份不会随文件迁移；新 Mac 仍需扫码登录。
- `project.private.config.json` 属于单机私有状态，没有打包；开发者工具会在新 Mac 自动重建。
- 如真机请求失败，优先检查同一 Wi-Fi、VPN、访客网络隔离及 macOS 防火墙。

## PPT

- 成品：`deliverables/驭小满年检与维修报价业务闭环操作手册.pptx`
- 生成源码：`deliverables/deck-work/build-business-closure-deck.mjs`
- 原始证据：`.runtime/annual-demo-media/`

PPT 可直接在 Mac 打开。Mac 缺少 Microsoft YaHei 时可能发生字体替换，但不影响文件内容；如继续生成，让 Codex 使用新 Mac 自己的演示文稿依赖运行时。

## 完整性校验

压缩包旁边的 `.sha256` 文件记录整个 ZIP 的 SHA-256。解压后，根目录 `MANIFEST.json` 记录打包范围与数据库校验结果，`SHA256SUMS.txt` 记录包内文件哈希。
