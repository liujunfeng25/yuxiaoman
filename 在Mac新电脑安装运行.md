# 在 Mac 新电脑继续开发

本项目的 Mac 迁移包不带 Windows `node_modules`、Windows 微信开发者工具缓存或临时日志，因为这些文件在 macOS 上无法使用。源码、原生小程序、运营后台、API、当前 PostgreSQL 数据、上传资料、测试素材、QA 证据、PPT 及生成源码均会保留。

解压后先阅读 `handoff/macos/README-迁移说明.md`，然后运行：

```bash
bash handoff/macos/start-all.sh
```

Mac 和 Apple Silicon 不影响业务功能；首次运行会按锁文件安装对应 macOS 架构的依赖。
