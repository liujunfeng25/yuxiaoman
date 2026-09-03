# 年检业务闭环验收说明（去标识化）

## 结论

年检模块已覆盖自驾、代驾、检测站结果回传、代驾四阶段留证、客户报告、后台全景、报价与模拟支付。正式年检结论仅允许“通过 / 未通过”；车身故障独立记录，不改变年检结论。

## 隐私边界

- 本文件不记录真实车牌、车辆 ID、订单号、报告号、微信下载 MsgID、私人照片路径或原始截图。
- 本机运行清单、断点状态、机器结果和可视证据统一保存在 `.runtime/private-audit/full-inspection-closure-20260826/`，该目录已被 Git 忽略。
- 可提交脚本只读取 `QA_SCENARIO_CONFIG_PATH` 指向的本机私有清单；配置格式见 `scenario-config.example.json`。
- 原始私有 QA 证据已迁移到上述 `.runtime` 目录，未删除。

## 可公开的验收范围

- 一笔自驾订单：非零冻结报价、模拟支付金额一致、完整检测现场材料、结构化未通过原因、报告发布和服务完成。
- 一笔代驾订单：非零冻结报价、模拟支付金额一致、取车/到站/检测完成/送回四阶段各 5 张留证、结构化通过报告和服务完成。
- 客户端、检测站端和后台的订单状态、年检结论、报告编号及留证数量一致。
- 时间线节点严格递增，正式结论只出现 `passed` 或 `failed`。

## 运行方式

1. 复制 `scenario-config.example.json` 到 `.runtime/private-audit/full-inspection-closure-20260826/scenario-config.local.json`。
2. 在本机文件中填写真实车牌、车辆 ID（可选）和相对于 `photoDirectory` 的照片文件名。
3. 设置 `QA_ADMIN_PASSWORD`、`QA_OPERATOR_PASSWORD` 后运行脚本。需要改路径时可使用 `QA_SCENARIO_CONFIG_PATH` 和 `QA_ARTIFACT_DIR`。

运行产生的 `service-closure-state.json` 与 `service-closure-result.json` 仅留在 `.runtime`，不得复制回可提交目录。
