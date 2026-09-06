import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { requestOwnerWorkflowSubscriptions } from "../miniprogram/services/workflow";
import {
  canonicalWorkflowActionCode,
  normalizeWorkflowNotificationPage,
  normalizeWorkflowTaskPage,
  normalizeWorkflowTaskSummary,
  resolveWorkflowActionTarget,
  workflowDueLabel,
  workflowNotificationView,
} from "../miniprogram/utils/workflow";

const NOW = Date.parse("2026-09-05T02:00:00.000Z");

test("消息动作只解析本地白名单路由且完全忽略服务端 URL", () => {
  assert.equal(canonicalWorkflowActionCode("OPEN_ANNUAL_REPORT"), "annual.report.detail");
  assert.equal(resolveWorkflowActionTarget("annual.report.detail", { bookingId: "booking/1" }, "owner"), "/packages/inspection/pages/checkup-report/checkup-report?id=booking%2F1");
  assert.equal(resolveWorkflowActionTarget("repair.quotes", { repairRequestId: "repair-1" }, "owner"), "/packages/repair/pages/owner-quotes/owner-quotes?id=repair-1");
  assert.equal(resolveWorkflowActionTarget("operator.booking.detail", { bookingId: "booking-1" }, "owner"), null, "车主不能由消息跳入检测站端");
  assert.equal(resolveWorkflowActionTarget("https://evil.example/steal", { resourceId: "booking-1" }, "owner"), null);
  assert.equal(resolveWorkflowActionTarget("annual.order.detail", {}, "owner"), null);

  const page = normalizeWorkflowNotificationPage({
    items: [{
      id: "notice-1",
      title: "报告已生成",
      body: "点击查看本次年检结论",
      actionCode: "annual.report.detail",
      actionParams: { bookingId: "booking-1", url: "https://evil.example" },
      url: "https://evil.example",
      createdAt: "2026-09-05T01:00:00.000Z",
    }],
  }, NOW);
  assert.deepEqual(page.items[0].actionParams, {
    bookingId: "booking-1",
    reportId: undefined,
    repairRequestId: undefined,
    requestId: undefined,
    taskId: undefined,
    resourceId: undefined,
  });
  assert.equal(resolveWorkflowActionTarget(page.items[0].actionCode, page.items[0].actionParams), "/packages/inspection/pages/checkup-report/checkup-report?id=booking-1");
});

test("消息列表规范化未读、紧急度、计数、游标并按时间倒序", () => {
  const page = normalizeWorkflowNotificationPage({
    data: {
      notifications: [
        { id: "older", category: "repair", title: "收到首份报价", content: "已有维修店报价", status: "read", created_at: "2026-09-05T00:40:00.000Z" },
        { id: "newer", category: "annual_inspection", title: "预检待处理", body: "请补充资料", due_at: "2026-09-05T01:30:00.000Z", created_at: "2026-09-05T01:00:00.000Z" },
      ],
      summary: { unread_count: 4, attention_count: 2, overdue_count: 1 },
      next_cursor: "opaque-cursor",
    },
  }, NOW);
  assert.deepEqual(page.items.map((item) => item.id), ["newer", "older"]);
  assert.equal(page.items[0].urgency, "overdue");
  assert.equal(page.items[0].readState, "unread");
  assert.equal(page.items[1].category, "repair_quote");
  assert.equal(page.items[1].readState, "read");
  assert.equal(page.unreadCount, 4);
  assert.equal(page.attentionCount, 2);
  assert.equal(page.overdueCount, 1);
  assert.equal(page.nextCursor, "opaque-cursor");
});

test("消息展示区分普通、需关注和超时且报告入口文案明确", () => {
  const item = normalizeWorkflowNotificationPage({
    items: [{
      id: "notice-1",
      category: "annual_inspection",
      urgency: "attention",
      title: "检测报告已生成",
      body: "本次年检结论为通过",
      actionCode: "annual.report.detail",
      actionParams: { bookingId: "booking-1" },
      dueAt: "2026-09-05T02:30:00.000Z",
      createdAt: "2026-09-05T01:00:00.000Z",
    }],
  }, NOW).items[0];
  const view = workflowNotificationView(item, NOW);
  assert.equal(view.actionLabel, "查看检测报告");
  assert.equal(view.actionable, true);
  assert.equal(view.dueLabel, "还剩 30 分钟");
  assert.match(view.className, /tone-attention/);
  assert.match(view.ariaLabel, /点击查看详情/);
  assert.equal(workflowDueLabel("2026-09-05T01:30:00.000Z", "overdue", NOW), "已超时 30 分钟");
});

test("截止时间按真实毫秒正负判断并稳定跨越分钟与小时边界", () => {
  const dueAt = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();
  for (const seconds of [1, 29, 31]) {
    assert.equal(workflowDueLabel(dueAt(seconds * 1000), "attention", NOW), "还剩 1 分钟");
    assert.equal(workflowDueLabel(dueAt(-seconds * 1000), "overdue", NOW), "已超时 1 分钟");
  }
  assert.equal(workflowDueLabel(dueAt(59 * 60 * 1000 + 59 * 1000), "attention", NOW), "还剩 60 分钟");
  assert.equal(workflowDueLabel(dueAt(60 * 60 * 1000), "attention", NOW), "还剩 1 小时");
  assert.equal(workflowDueLabel(dueAt(60 * 60 * 1000 + 1000), "attention", NOW), "还剩 2 小时");
  assert.equal(workflowDueLabel(dueAt(-(59 * 60 * 1000 + 59 * 1000)), "overdue", NOW), "已超时 60 分钟");
  assert.equal(workflowDueLabel(dueAt(-60 * 60 * 1000), "overdue", NOW), "已超时 1 小时");
  assert.equal(workflowDueLabel(dueAt(-(60 * 60 * 1000 + 1000)), "overdue", NOW), "已超时 1 小时");
});

test("检测站、维修门店与司机工作台共用同一个截止时间文案函数", () => {
  for (const relativePath of [
    "../miniprogram/packages/operator/pages/operator/operator.ts",
    "../miniprogram/packages/repair/pages/shop-hall/shop-hall.ts",
    "../miniprogram/packages/driver/pages/task/task.ts",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /import \{ workflowDueLabel \} from/);
    assert.match(source, /workflowDueLabel\(summary\.nextDueAt, urgency\)/);
  }
});

test("角色待办按超时优先排序并只允许各自端内动作", () => {
  const page = normalizeWorkflowTaskPage({
    tasks: [
      { id: "normal", title: "待预检", urgency: "normal", dueAt: "2026-09-05T04:00:00.000Z", actionCode: "operator.precheck.detail", actionParams: { bookingId: "b-1" } },
      { id: "overdue", title: "报告未发布", urgency: "overdue", dueAt: "2026-09-05T01:00:00.000Z", actionCode: "operator.booking.detail", actionParams: { bookingId: "b-2" } },
      { id: "attention", title: "即将超时", urgency: "attention", dueAt: "2026-09-05T02:15:00.000Z", actionCode: "operator.booking.detail", actionParams: { bookingId: "b-3" } },
    ],
    summary: { openCount: 3, dueSoonCount: 1, overdueCount: 1, nextDueAt: "2026-09-05T01:00:00.000Z" },
  }, NOW);
  assert.deepEqual(page.items.map((item) => item.id), ["overdue", "attention", "normal"]);
  assert.equal(page.openCount, 3);
  assert.equal(resolveWorkflowActionTarget(page.items[0].actionCode, page.items[0].actionParams, "operator"), "/packages/operator/pages/operator-detail/operator-detail?id=b-2");
  assert.equal(resolveWorkflowActionTarget(page.items[0].actionCode, page.items[0].actionParams, "repair_shop"), null);
});

test("到站待开检与报告生成节点使用明确且不同的业务标签", () => {
  const page = normalizeWorkflowTaskPage({
    tasks: [
      { id: "start", nodeCode: "annual.inspection.start", entityId: "booking-1", actionCode: "operator.booking.detail", actionParams: { bookingId: "booking-1" } },
      { id: "report", nodeCode: "annual.inspection.report", entityId: "booking-1", actionCode: "operator.booking.detail", actionParams: { bookingId: "booking-1" } },
      { id: "ready", nodeCode: "annual.report.ready", entityId: "booking-1", actionCode: "annual.report.detail", actionParams: { bookingId: "booking-1" } },
    ],
  }, NOW);
  assert.deepEqual(Object.fromEntries(page.items.map((item) => [item.id, item.title])), {
    start: "车辆待开始检测",
    report: "检测报告待发布",
    ready: "检测报告已生成",
  });
});

test("兼容服务端实体参数、任务摘要字段和节点元数据", () => {
  const page = normalizeWorkflowTaskPage({
    tasks: [{
      id: "task-1",
      domain: "repair_quote",
      nodeCode: "repair.request.opportunity",
      entityId: "repair-request-1",
      status: "open",
      urgency: "due_soon",
      dueAt: "2026-09-05T02:10:00.000Z",
      actionCode: "repair.shop.request.detail",
      actionParams: { entityType: "repair_request", entityId: "repair-request-1", taskId: "task-1" },
      metadata: { maskedBusinessCode: "WX***19" },
      createdAt: "2026-09-05T01:00:00.000Z",
    }],
    summary: { pending: 1, dueSoon: 1, overdue: 0, escalated: 0, blocking: 0 },
  }, NOW);
  assert.equal(page.openCount, 1);
  assert.equal(page.dueSoonCount, 1);
  assert.equal(page.nextDueAt, "2026-09-05T02:10:00.000Z");
  assert.equal(page.items[0].businessType, "repair_quote");
  assert.equal(page.items[0].businessId, "repair-request-1");
  assert.equal(page.items[0].businessNoMasked, "WX***19");
  assert.equal(page.items[0].title, "新的维修报价机会");
  assert.equal(page.items[0].actionParams.resourceId, "repair-request-1");
  assert.equal(
    resolveWorkflowActionTarget(page.items[0].actionCode, page.items[0].actionParams, "repair_shop"),
    "/packages/repair/pages/shop-request-detail/shop-request-detail?id=repair-request-1",
  );

  const repairNotice = normalizeWorkflowNotificationPage({
    notifications: [{
      id: "notice-1",
      title: "已收到首份维修报价",
      actionCode: "repair.request.detail",
      actionParams: { entityId: "repair-request-1" },
      createdAt: "2026-09-05T01:00:00.000Z",
    }],
  }, NOW).items[0];
  assert.equal(repairNotice.category, "repair_quote");
  assert.equal(repairNotice.actionParams.resourceId, "repair-request-1");
});

test("角色待办汇总兼容服务端已合并升级任务的已超时字段", () => {
  assert.deepEqual(normalizeWorkflowTaskSummary({
    pending: 1,
    dueSoon: 0,
    overdue: 1,
    escalated: 1,
  }), {
    openCount: 1,
    dueSoonCount: 0,
    overdueCount: 1,
    nextDueAt: null,
  });
});

test("消息中心有完整空态、错误恢复、分页与安全动作实现", () => {
  const page = readFileSync(new URL("../miniprogram/packages/notifications/pages/messages/messages.ts", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../miniprogram/packages/notifications/pages/messages/messages.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/packages/notifications/pages/messages/messages.wxss", import.meta.url), "utf8");
  const service = readFileSync(new URL("../miniprogram/services/workflow.ts", import.meta.url), "utf8");
  for (const text of ["消息中心", "年检进度", "维修报价", "全部消息", "未读", "消息读取失败", "没有未读消息", "暂无履约消息", "加载更多消息", "全部已读"]) {
    assert.match(markup, new RegExp(text));
  }
  assert.match(page, /resolveWorkflowActionTarget\(item\.actionCode, item\.actionParams, "owner"\)/);
  assert.doesNotMatch(page, /item\.(url|path)|actionParams\.(url|path)/);
  assert.match(page, /onReachBottom\(\)/);
  assert.match(page, /ownerWorkflowApi\.markRead\(id\)/);
  assert.match(page, /ownerWorkflowApi\.markAllRead\(\)/);
  assert.match(service, /\/workflow\/notifications\/summary/);
  assert.match(service, /\/workflow\/notifications\/\$\{encodeURIComponent\(id\)\}\/read/);
  assert.match(service, /applyOwnerWorkflowUnreadBadge/);
  assert.match(service, /\/workflow\/wechat-subscription-templates/);
  assert.match(service, /wx\.requestSubscribeMessage/);
  assert.doesNotMatch(service, /remainingUses|providerAppId/);
  assert.match(page, /requestOwnerWorkflowSubscriptions\(orderedIds, "message_center"\)/);
  assert.match(markup, /wx:if="\{\{wechatSubscriptionAvailable\}\}"/);
  assert.match(markup, /bindtap="enableWechatReminders"/);
  assert.match(markup, /授权仅在你点击后发起/);
  assert.match(style, /\.message-card\s*\{[^}]*min-height:\s*176rpx/);
  assert.match(style, /\.wechat-reminder-card > button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(style, /\.state-card button\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(style, /env\(safe-area-inset-bottom\)/);
});

test("消息铃铛与角色督办摘要组件均提供可访问名称和足够触控区", () => {
  const bell = readFileSync(new URL("../miniprogram/components/workflow-bell/workflow-bell.wxml", import.meta.url), "utf8");
  const bellStyle = readFileSync(new URL("../miniprogram/components/workflow-bell/workflow-bell.wxss", import.meta.url), "utf8");
  const summary = readFileSync(new URL("../miniprogram/components/workflow-task-summary/workflow-task-summary.wxml", import.meta.url), "utf8");
  const summaryStyle = readFileSync(new URL("../miniprogram/components/workflow-task-summary/workflow-task-summary.wxss", import.meta.url), "utf8");
  assert.match(bell, /aria-label="消息中心/);
  assert.match(bellStyle, /\.workflow-bell\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(summary, /待处理[\s\S]*即将超时[\s\S]*已超时/);
  assert.match(summary, /aria-label="\{\{title\}\}/);
  assert.match(summaryStyle, /\.workflow-summary\s*\{[^}]*min-height:\s*202rpx/);
});

test("检测站、维修门店与司机的待办 API 留在各自分包并保持主体会话隔离", () => {
  const ownerService = readFileSync(new URL("../miniprogram/services/workflow.ts", import.meta.url), "utf8");
  const operatorApi = readFileSync(new URL("../miniprogram/packages/operator/services/workflow-api.ts", import.meta.url), "utf8");
  const repairApi = readFileSync(new URL("../miniprogram/packages/repair/services/workflow-api.ts", import.meta.url), "utf8");
  const driverApi = readFileSync(new URL("../miniprogram/packages/driver/services/workflow-api.ts", import.meta.url), "utf8");
  assert.doesNotMatch(ownerService, /packages\/(operator|repair|driver)/, "主包不能反向导入普通分包");
  assert.match(operatorApi, /withOperatorAuthorization/);
  assert.match(repairApi, /withRepairOperatorAuthorization/);
  assert.match(driverApi, /driverAuthorizationHeaders/);
  assert.match(operatorApi, /\/operator\/workflow\/tasks/);
  assert.match(repairApi, /\/repair-operator\/workflow\/tasks/);
  assert.match(driverApi, /\/driver\/tasks\/\$\{encodeURIComponent\(bookingId\)\}\/workflow/);
});

test("检测站与维修门店有独立的主体范围待办列表页面", () => {
  const operatorPage = readFileSync(new URL("../miniprogram/packages/operator/pages/workflow-tasks/workflow-tasks.ts", import.meta.url), "utf8");
  const operatorMarkup = readFileSync(new URL("../miniprogram/packages/operator/pages/workflow-tasks/workflow-tasks.wxml", import.meta.url), "utf8");
  const repairPage = readFileSync(new URL("../miniprogram/packages/repair/pages/shop-workflow-tasks/shop-workflow-tasks.ts", import.meta.url), "utf8");
  const repairMarkup = readFileSync(new URL("../miniprogram/packages/repair/pages/shop-workflow-tasks/shop-workflow-tasks.wxml", import.meta.url), "utf8");
  const style = readFileSync(new URL("../miniprogram/styles/workflow-task-page.wxss", import.meta.url), "utf8");
  assert.match(operatorPage, /ensureOperatorPageAccess/);
  assert.match(operatorPage, /operatorWorkflowApi\.tasks/);
  assert.match(operatorPage, /resolveWorkflowActionTarget\(item\.actionCode, item\.actionParams, "operator"\)/);
  assert.match(repairPage, /ensureRepairOperatorPageAccess/);
  assert.match(repairPage, /repairWorkflowApi\.tasks/);
  assert.match(repairPage, /resolveWorkflowActionTarget\(item\.actionCode, item\.actionParams, "repair_shop"\)/);
  assert.match(operatorMarkup, /系统提醒不会替代预检、接车、检测或报告发布动作/);
  assert.match(repairMarkup, /只督办首份报价，不要求第二家或第三家强制报价/);
  for (const markup of [operatorMarkup, repairMarkup]) assert.match(markup, /待处理[\s\S]*即将超时[\s\S]*已超时/);
  assert.match(style, /\.workflow-task\s*\{[^}]*min-height:\s*184rpx/);
  assert.match(style, /env\(safe-area-inset-bottom\)/);
});

test("消息中心与角色待办路由已注册且根 Tab 始终只有三个", () => {
  const app = JSON.parse(readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8")) as {
    pages: string[];
    tabBar: { list: Array<{ pagePath: string }> };
    subPackages: Array<{ root: string; pages: string[] }>;
  };
  assert.deepEqual(app.pages, ["pages/home/home", "pages/orders/orders", "pages/profile/profile"]);
  assert.deepEqual(app.tabBar.list.map((item) => item.pagePath), app.pages);
  assert.equal(app.tabBar.list.length, 3);
  const packages = new Map(app.subPackages.map((item) => [item.root, item.pages]));
  assert.deepEqual(packages.get("packages/notifications"), ["pages/messages/messages"]);
  assert.ok(packages.get("packages/operator")?.includes("pages/workflow-tasks/workflow-tasks"));
  assert.ok(packages.get("packages/repair")?.includes("pages/shop-workflow-tasks/shop-workflow-tasks"));
  for (const extension of ["ts", "json", "wxml", "wxss"]) {
    assert.equal(existsSync(new URL(`../miniprogram/packages/notifications/pages/tasks/tasks.${extension}`, import.meta.url)), false);
  }

  const ownerService = readFileSync(new URL("../miniprogram/services/workflow.ts", import.meta.url), "utf8");
  assert.match(ownerService, /Promise\.all\([\s\S]*\/workflow\/notifications\/summary/);
  assert.match(ownerService, /\{ templateId, state: stateMap\[result\]/);
  for (const page of ["home", "orders", "profile"]) {
    const config = readFileSync(new URL(`../miniprogram/pages/${page}/${page}.json`, import.meta.url), "utf8");
    assert.match(config, /"workflow-bell"/);
  }
});

test("微信订阅请求由点击路径直接发起且客户端不提交 AppID 或可用次数", async () => {
  const previousWx = (globalThis as Record<string, unknown>).wx;
  const events: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  (globalThis as Record<string, unknown>).wx = {
    getStorageSync: () => ({ token: "owner-session", expiresAt: "2099-01-01T00:00:00.000Z" }),
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    requestSubscribeMessage: (options: {
      tmplIds: string[];
      success(result: Record<string, string>): void;
    }) => {
      events.push(`subscribe:${options.tmplIds.join(",")}`);
      options.success(Object.fromEntries(options.tmplIds.map((id, index) => [id, index === 0 ? "accept" : "reject"])));
    },
    request: (options: {
      data?: Record<string, unknown>;
      success(result: { statusCode: number; data: unknown }): void;
    }) => {
      events.push("record");
      payloads.push(options.data || {});
      options.success({ statusCode: 200, data: { data: { recorded: true } } });
    },
  };
  try {
    const result = await requestOwnerWorkflowSubscriptions(["tpl-a", "tpl-b", "tpl-c", "tpl-d"], "message_center");
    assert.deepEqual(result, {
      requestedTemplateIds: ["tpl-a", "tpl-b", "tpl-c"],
      acceptedCount: 1,
    });
    assert.equal(events[0], "subscribe:tpl-a,tpl-b,tpl-c");
    assert.deepEqual(events.slice(1), ["record", "record", "record"]);
    assert.deepEqual(payloads, [
      { templateId: "tpl-a", state: "accepted" },
      { templateId: "tpl-b", state: "rejected" },
      { templateId: "tpl-c", state: "rejected" },
    ]);
    for (const payload of payloads) {
      assert.equal("providerAppId" in payload, false);
      assert.equal("remainingUses" in payload, false);
    }
  } finally {
    if (previousWx === undefined) delete (globalThis as Record<string, unknown>).wx;
    else (globalThis as Record<string, unknown>).wx = previousWx;
  }
});
