import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createOperatorSessionStore,
  normalizeOperatorSession,
  type OperatorSessionRuntime,
  type StoredOperatorSession,
} from "../miniprogram/services/operator-session";
import {
  createOperatorMediaLocalizer,
  operatorMediaSourceUrl,
  type OperatorMediaRuntime,
} from "../miniprogram/services/operator-media";
import { apiOrigin } from "../miniprogram/config/env";

function futureExpiry(): string { return new Date(Date.now() + 60 * 60_000).toISOString(); }

function stationSession(token = "yxm_bo_station-token"): StoredOperatorSession {
  return {
    token,
    expiresAt: futureExpiry(),
    account: { id: "account-1", loginName: "station-hexi", displayName: "河西站负责人", role: "inspection_station_admin" },
    subject: { type: "inspection_station", id: "station-hexi-1", name: "河西机动车检测站" },
    capabilities: ["inspection:read", "inspection:write"],
  };
}

function sessionFixture(options: { stored?: unknown } = {}) {
  let stored = options.stored;
  let clearCalls = 0;
  const runtime: OperatorSessionRuntime = {
    now: () => Date.now(),
    read: () => stored,
    write: (value) => { stored = value; },
    clear: () => { stored = undefined; clearCalls += 1; },
  };
  return { store: createOperatorSessionStore(runtime), stats: () => ({ stored, clearCalls }) };
}

test("检测站会话只接受未过期 yxm_bo_ 凭证与绑定站点主体", () => {
  const valid = stationSession();
  assert.deepEqual(normalizeOperatorSession({ data: valid }), valid);
  assert.equal(normalizeOperatorSession(stationSession("owner-token")), null);
  assert.equal(normalizeOperatorSession({ ...valid, expiresAt: new Date().toISOString() }), null);
  assert.equal(normalizeOperatorSession({ ...valid, subject: null }), null);
  assert.equal(normalizeOperatorSession({ ...valid, account: { ...valid.account, role: "platform_admin" } }), null);
  assert.equal(normalizeOperatorSession({ ...valid, account: { ...valid.account, loginName: "" } }), null);
});

test("正式检测请求注入独立 Bearer、忽略调用方 Authorization，401 后立即清理", async () => {
  const { store, stats } = sessionFixture({ stored: stationSession() });
  const seen = await store.withAuthorization(
    { authorization: "Bearer owner-controlled", "Idempotency-Key": "station-1" },
    async (headers) => headers,
  );
  assert.deepEqual(seen, { "Idempotency-Key": "station-1", Authorization: "Bearer yxm_bo_station-token" });

  await assert.rejects(store.withAuthorization({}, async () => {
    throw Object.assign(new Error("revoked"), { statusCode: 401 });
  }), /revoked/u);
  assert.equal(stats().stored, undefined);
  assert.ok(stats().clearCalls >= 1);
});

test("开发工具、真机与正式环境均不允许匿名检测请求", () => {
  const session = sessionFixture();
  assert.throws(() => session.store.headers({ "content-type": "application/json" }), /请先登录检测站账号/u);
});

test("检测站私图携带 station Bearer 下载且失败不回退裸 URL", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let attempt = 0;
  const runtime: OperatorMediaRuntime = {
    authorize: async (operation) => operation({ Authorization: "Bearer yxm_bo_station-token" }),
    download: async (url, headers) => {
      calls.push({ url, headers });
      attempt += 1;
      return attempt === 1
        ? { statusCode: 503, tempFilePath: "" }
        : { statusCode: 200, tempFilePath: "wxfile://operator-private.jpg" };
    },
  };
  const localizer = createOperatorMediaLocalizer(runtime);
  const source = "/api/operator/bookings/booking-1/evidence/station_arrival/media/media-1";
  await assert.rejects(localizer.localize(source), /安全读取失败/u);
  assert.equal(await localizer.localize(source), "wxfile://operator-private.jpg");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.headers.Authorization, "Bearer yxm_bo_station-token");
  assert.equal(calls[0]?.url, operatorMediaSourceUrl(source));
  assert.notEqual("wxfile://operator-private.jpg", calls[0]?.url);
});

test("检测站私图固化保存，本地文件被清理后重新下载", async () => {
  let exists = true;
  let downloads = 0;
  const localizer = createOperatorMediaLocalizer({
    authorize: async (operation) => operation({ Authorization: "Bearer yxm_bo_station-token" }),
    download: async () => ({ statusCode: 200, tempFilePath: `wxfile://operator-temp-${++downloads}.jpg` }),
    persist: async (path) => path.replace("temp-", "saved-"),
    exists: async () => exists,
  });
  const source = "/api/operator/bookings/booking-1/private-photo";

  assert.equal(await localizer.localize(source), "wxfile://operator-saved-1.jpg");
  assert.equal(await localizer.localize(source), "wxfile://operator-saved-1.jpg");
  assert.equal(downloads, 1);
  exists = false;
  assert.equal(await localizer.localize(source), "wxfile://operator-saved-2.jpg");
  assert.equal(downloads, 2);
});

test("检测站历史 localhost 私图地址改写当前 API origin", () => {
  const rewritten = operatorMediaSourceUrl("http://localhost:8000/api/operator/media/legacy");
  assert.equal(rewritten, `${apiOrigin}/api/operator/media/legacy`);
  assert.doesNotMatch(rewritten, /:8000/u);
});

test("检测站入口先经登录页，operator JSON/上传和报告私图共用 station 会话", () => {
  const manifest = readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8");
  const profile = readFileSync(new URL("../miniprogram/pages/profile/profile.ts", import.meta.url), "utf8");
  const operatorPage = readFileSync(new URL("../miniprogram/packages/operator/pages/operator/operator.ts", import.meta.url), "utf8");
  const loginPage = readFileSync(new URL("../miniprogram/packages/operator/pages/operator-login/operator-login.ts", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../miniprogram/services/operator-session.ts", import.meta.url), "utf8");
  const detailSource = readFileSync(new URL("../miniprogram/packages/operator/pages/operator-detail/operator-detail.ts", import.meta.url), "utf8");

  assert.match(manifest, /pages\/operator-login\/operator-login/u);
  assert.match(profile, /operatorLoginRequired\(\)[\s\S]*operator-login/u);
  assert.match(operatorPage, /ensureOperatorPageAccess/u);
  assert.match(operatorPage, /stationLocked/u);
  assert.match(loginPage, /loginOperator\(loginName, this\.data\.password\)/u);
  assert.doesNotMatch(loginPage, /DemoFallback|enterLocalDemo/u);
  assert.match(sessionSource, /"\/operator\/sessions", "POST", \{ loginName: loginName\.trim\(\), password \}/u);
  assert.match(sessionSource, /"\/operator\/session", "GET"/u);
  assert.match(sessionSource, /token: current\?\.token, expiresAt: current\?\.expiresAt/u);
  assert.match(sessionSource, /accountRole !== "inspection_station_admin"/u);
  assert.match(sessionSource, /statusCode === 401\) redirectOperatorLogin\(\)/u);
  assert.match(sessionSource, /currentOperatorPageUrl\(\)/u);
  assert.match(sessionSource, /redirect=\$\{encodeURIComponent\(returnUrl\)\}/u);
  assert.match(apiSource, /function operatorRequestEnvelope[\s\S]*withOperatorAuthorization/u);
  assert.match(apiSource, /function operatorRequestEnvelope[\s\S]*const hasBody = data !== undefined[\s\S]*hasBody \? \{ "content-type": "application\/json", \.\.\.headers \} : headers/u);
  assert.match(apiSource, /\.\.\.\(hasBody \? \{ data \} : \{\}\)/u, "无正文 DELETE 不应发送空 data");
  assert.match(apiSource, /function uploadOperatorEnvelope[\s\S]*withOperatorAuthorization/u);
  assert.match(apiSource, /localizedOperatorBooking/u);
  assert.match(apiSource, /localizedOperatorCheckupReport/u);
  assert.doesNotMatch(detailSource, /mediaUrl\(photo\.url\)/u);
});

test("检测站预审队列和详情注册完整，并固定核对七类照片与二次退款确认", () => {
  const manifest = readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8");
  const listSource = readFileSync(new URL("../miniprogram/packages/operator/pages/precheck-list/precheck-list.ts", import.meta.url), "utf8");
  const detailSource = readFileSync(new URL("../miniprogram/packages/operator/pages/precheck-detail/precheck-detail.ts", import.meta.url), "utf8");
  const detailTemplate = readFileSync(new URL("../miniprogram/packages/operator/pages/precheck-detail/precheck-detail.wxml", import.meta.url), "utf8");
  const ownerDetail = readFileSync(new URL("../miniprogram/packages/annual/pages/order-detail/order-detail.wxml", import.meta.url), "utf8");

  assert.match(manifest, /pages\/precheck-list\/precheck-list/u);
  assert.match(manifest, /pages\/precheck-detail\/precheck-detail/u);
  assert.match(listSource, /operatorPrechecks\(\)/u);
  for (const kind of ["license_front", "license_back", "vehicle_front_left", "vehicle_front_right", "vehicle_rear_left", "vehicle_rear_right", "dashboard_started"]) {
    assert.match(detailSource, new RegExp(kind, "u"));
  }
  assert.match(detailSource, /wx\.previewImage/u);
  assert.match(detailSource, /approveIdempotencyKey/u);
  assert.match(detailSource, /rejectIdempotencyKey/u);
  assert.match(detailSource, /确认发送问题处理清单/u);
  assert.doesNotMatch(detailSource, /确认不通过并退款/u);
  assert.match(detailTemplate, /车损 \/ 故障灯/u);
  assert.match(detailTemplate, /booking\.precheck\.status === 'pending'/u);
  assert.match(ownerDetail, /检测站预审已通过/u);
  assert.match(ownerDetail, /模拟退款已完成/u);
});
