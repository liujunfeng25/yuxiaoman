import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createRepairOperatorSessionStore,
  isDemoRepairOperatorSubject,
  normalizeRepairOperatorSession,
  type RepairOperatorSessionRuntime,
  type StoredRepairOperatorSession,
} from "../miniprogram/packages/repair/services/operator-session";
import {
  createRepairOperatorMediaLocalizer,
  repairOperatorMediaSourceUrl,
  type RepairOperatorMediaRuntime,
} from "../miniprogram/packages/repair/services/operator-media";

function futureExpiry(): string { return new Date(Date.now() + 60 * 60_000).toISOString(); }

function repairSession(token = "yxm_bo_repair-token"): StoredRepairOperatorSession {
  return {
    token,
    expiresAt: futureExpiry(),
    account: { id: "account-repair", loginName: "jincheng", displayName: "津城钣喷中心管理员", role: "repair_shop_admin" },
    subject: { type: "repair_shop", id: "shop-jincheng-bodypaint", name: "津城钣喷中心（演示）" },
    capabilities: ["repair.requests.read", "repair.quotes.write"],
  };
}

function sessionFixture(options: { stored?: unknown } = {}) {
  let stored = options.stored;
  let clearCalls = 0;
  const runtime: RepairOperatorSessionRuntime = {
    now: () => Date.now(),
    read: () => stored,
    write: (value) => { stored = value; },
    clear: () => { stored = undefined; clearCalls += 1; },
  };
  return { store: createRepairOperatorSessionStore(runtime), stats: () => ({ stored, clearCalls }) };
}

test("维修会话只接受未过期的维修门店账号与唯一绑定主体", () => {
  const valid = repairSession();
  assert.deepEqual(normalizeRepairOperatorSession({ data: valid }), valid);
  assert.equal(normalizeRepairOperatorSession(repairSession("owner-token")), null);
  assert.equal(normalizeRepairOperatorSession({ ...valid, expiresAt: new Date().toISOString() }), null);
  assert.equal(normalizeRepairOperatorSession({ ...valid, account: { ...valid.account, role: "inspection_station_admin" } }), null);
  assert.equal(normalizeRepairOperatorSession({ ...valid, subject: { ...valid.subject, type: "wash_store" } }), null);
  assert.equal(isDemoRepairOperatorSubject(valid.subject), true);
  assert.equal(isDemoRepairOperatorSubject({ ...valid.subject, id: "shop-real-1" }), false);
});

test("维修请求注入独立 Bearer、忽略调用方 Authorization，401 后清理", async () => {
  const { store, stats } = sessionFixture({ stored: repairSession() });
  const seen = await store.withAuthorization(
    { authorization: "Bearer owner-controlled", "Idempotency-Key": "repair-1" },
    async (headers) => headers,
  );
  assert.deepEqual(seen, { "Idempotency-Key": "repair-1", Authorization: "Bearer yxm_bo_repair-token" });

  await assert.rejects(store.withAuthorization({}, async () => {
    throw Object.assign(new Error("revoked"), { statusCode: 401 });
  }), /revoked/u);
  assert.equal(stats().stored, undefined);
  assert.ok(stats().clearCalls >= 1);
});

test("维修私图携带维修 Bearer 下载且失败不回退裸地址", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let attempt = 0;
  const runtime: RepairOperatorMediaRuntime = {
    authorize: async (operation) => operation({ Authorization: "Bearer yxm_bo_repair-token" }),
    download: async (url, headers) => {
      calls.push({ url, headers });
      attempt += 1;
      return attempt === 1
        ? { statusCode: 503, tempFilePath: "" }
        : { statusCode: 200, tempFilePath: "wxfile://repair-private.jpg" };
    },
  };
  const localizer = createRepairOperatorMediaLocalizer(runtime);
  const source = "/api/repair-operator/requests/request-1/media/media-1";
  await assert.rejects(localizer.localize(source), /安全读取失败/u);
  assert.equal(await localizer.localize(source), "wxfile://repair-private.jpg");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.headers.Authorization, "Bearer yxm_bo_repair-token");
  assert.equal(calls[0]?.url, repairOperatorMediaSourceUrl(source));
});

test("工作人员入口和维修页面使用实名登录、固定门店与正式接口", () => {
  const manifest = readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8");
  const staffSource = readFileSync(new URL("../miniprogram/packages/operator/pages/staff-entry/staff-entry.ts", import.meta.url), "utf8");
  const staffMarkup = readFileSync(new URL("../miniprogram/packages/operator/pages/staff-entry/staff-entry.wxml", import.meta.url), "utf8");
  const profileSource = readFileSync(new URL("../miniprogram/pages/profile/profile.ts", import.meta.url), "utf8");
  const profileMarkup = readFileSync(new URL("../miniprogram/pages/profile/profile.wxml", import.meta.url), "utf8");
  const loginSource = readFileSync(new URL("../miniprogram/packages/repair/pages/shop-login/shop-login.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../miniprogram/packages/repair/services/operator-session.ts", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../miniprogram/packages/repair/services/operator-api.ts", import.meta.url), "utf8");
  const ownerApiSource = readFileSync(new URL("../miniprogram/services/api.ts", import.meta.url), "utf8");
  const hallSource = readFileSync(new URL("../miniprogram/packages/repair/pages/shop-hall/shop-hall.ts", import.meta.url), "utf8");
  const detailSource = readFileSync(new URL("../miniprogram/packages/repair/pages/shop-request-detail/shop-request-detail.ts", import.meta.url), "utf8");
  const quoteSource = readFileSync(new URL("../miniprogram/packages/repair/pages/shop-quote/shop-quote.ts", import.meta.url), "utf8");

  assert.match(manifest, /pages\/shop-login\/shop-login/u);
  assert.match(staffSource, /enterRepair\(\)[\s\S]*packages\/repair\/pages\/shop-login\/shop-login/u);
  assert.match(staffMarkup, /维修门店端[\s\S]*账号登录/u);
  assert.doesNotMatch(`${profileSource}\n${profileMarkup}`, /enterRepairShop|repair-shop-switcher|shop-jincheng-bodypaint/u);
  assert.match(loginSource, /loginRepairOperator\(loginName, this\.data\.password\)/u);
  assert.match(sessionSource, /"\/repair-operator\/sessions", "POST"/u);
  assert.match(sessionSource, /"\/repair-operator\/session", "GET"/u);
  assert.match(apiSource, /withRepairOperatorAuthorization/u);
  assert.match(apiSource, /"\/repair-operator\/requests"/u);
  assert.match(apiSource, /Idempotency-Key/u);
  assert.doesNotMatch(apiSource, /\/demo\/repair-shops|shopId/u);
  assert.doesNotMatch(ownerApiSource, /\/demo\/repair-shops/u);
  assert.match(ownerApiSource, /"\/repair\/requests"/u, "车主维修流程仍保留独立 owner API");
  assert.match(hallSource, /readRepairOperatorSession[\s\S]*session\.subject\.name/u);
  assert.match(hallSource, /logoutRepairOperator/u);
  assert.doesNotMatch(`${hallSource}\n${detailSource}\n${quoteSource}`, /shopId|localizeOwnerMedia|storeRepairShopId/u);
  assert.match(detailSource, /localizeRepairOperatorMedia/u);
});
