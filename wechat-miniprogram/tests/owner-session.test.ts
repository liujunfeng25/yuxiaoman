import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOwnerSessionManager,
  type OwnerSessionRuntime,
  type StoredOwnerSession,
} from "../miniprogram/services/session";

function futureExpiry(offsetMs = 60 * 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fixture(options: {
  strict?: boolean;
  stored?: unknown;
  exchange?: (code: string) => Promise<unknown>;
} = {}) {
  let stored = options.stored;
  let loginCalls = 0;
  let exchangeCalls = 0;
  let clearCalls = 0;
  const writes: StoredOwnerSession[] = [];

  const runtime: OwnerSessionRuntime = {
    now: () => Date.now(),
    strictAuthentication: () => options.strict === true,
    readStoredSession: () => stored,
    writeStoredSession: (session) => {
      stored = session;
      writes.push(session);
    },
    clearStoredSession: () => {
      stored = undefined;
      clearCalls += 1;
    },
    login: async () => {
      loginCalls += 1;
      return `wx-code-${loginCalls}`;
    },
    exchange: async (code) => {
      exchangeCalls += 1;
      if (options.exchange) return options.exchange(code);
      return { token: `opaque-token-${exchangeCalls}`, expiresAt: futureExpiry() };
    },
  };

  return {
    manager: createOwnerSessionManager(runtime),
    stats: () => ({ stored, loginCalls, exchangeCalls, clearCalls, writes }),
  };
}

test("并发页面共用一次 wx.login 会话交换，且只保存不透明 token 与过期时间", async () => {
  const { manager, stats } = fixture({
    exchange: async () => ({
      data: {
        token: "opaque-application-token",
        expiresAt: futureExpiry(),
        userId: "must-not-be-persisted",
        openid: "must-not-be-persisted",
      },
    }),
  });

  const [first, second, third] = await Promise.all([
    manager.ensureSession(),
    manager.ensureSession(),
    manager.ensureSession(),
  ]);

  assert.equal(first, "opaque-application-token");
  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(stats().loginCalls, 1);
  assert.equal(stats().exchangeCalls, 1);
  assert.deepEqual(Object.keys(stats().writes[0]).sort(), ["expiresAt", "token"]);
  assert.equal((stats().stored as Record<string, unknown>).userId, undefined);
  assert.equal((stats().stored as Record<string, unknown>).openid, undefined);
});

test("有效本地会话直接注入 Bearer，同时保留业务请求头", async () => {
  const { manager, stats } = fixture({
    stored: { token: "cached-token", expiresAt: futureExpiry() },
  });

  const result = await manager.withAuthorization(
    { "Idempotency-Key": "idem-1", authorization: "Bearer caller-controlled" },
    async (headers) => headers,
  );

  assert.deepEqual(result, {
    "Idempotency-Key": "idem-1",
    Authorization: "Bearer cached-token",
  });
  assert.equal(stats().loginCalls, 0);
  assert.equal(stats().exchangeCalls, 0);
});

test("业务请求遇到 401 后清除旧会话、重新登录并且只重试一次", async () => {
  const { manager, stats } = fixture({
    stored: { token: "expired-server-token", expiresAt: futureExpiry() },
    exchange: async () => ({ token: "refreshed-token", expiresAt: futureExpiry() }),
  });
  const seenAuthorization: Array<string | undefined> = [];

  const result = await manager.withAuthorization({}, async (headers) => {
    seenAuthorization.push(headers.Authorization);
    if (seenAuthorization.length === 1) {
      throw Object.assign(new Error("expired"), { statusCode: 401 });
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(seenAuthorization, ["Bearer expired-server-token", "Bearer refreshed-token"]);
  assert.equal(stats().loginCalls, 1);
  assert.equal(stats().exchangeCalls, 1);

  let attempts = 0;
  await assert.rejects(
    manager.withAuthorization({}, async () => {
      attempts += 1;
      throw Object.assign(new Error("still unauthorized"), { statusCode: 401 });
    }),
    /still unauthorized/u,
  );
  assert.equal(attempts, 2);
});

test("多个业务请求同时遇到 401 时只共享一次会话刷新", async () => {
  const { manager, stats } = fixture({
    stored: { token: "shared-expired-token", expiresAt: futureExpiry() },
    exchange: async () => {
      await Promise.resolve();
      return { token: "shared-refreshed-token", expiresAt: futureExpiry() };
    },
  });
  const attempts = [0, 0];

  const run = (index: number) => manager.withAuthorization({}, async (headers) => {
    attempts[index] += 1;
    if (headers.Authorization === "Bearer shared-expired-token") {
      throw Object.assign(new Error("expired"), { statusCode: 401 });
    }
    assert.equal(headers.Authorization, "Bearer shared-refreshed-token");
    return `ok-${index}`;
  });

  assert.deepEqual(await Promise.all([run(0), run(1)]), ["ok-0", "ok-1"]);
  assert.deepEqual(attempts, [2, 2]);
  assert.equal(stats().loginCalls, 1);
  assert.equal(stats().exchangeCalls, 1);
});

test("真实 Bearer 失效且刷新失败时不降级重放为 demo 匿名请求", async () => {
  const { manager } = fixture({
    stored: { token: "expired-real-owner-token", expiresAt: futureExpiry() },
    exchange: async () => {
      throw Object.assign(new Error("wechat unavailable"), { statusCode: 503 });
    },
  });
  const seenAuthorization: Array<string | undefined> = [];

  await assert.rejects(
    manager.withAuthorization({}, async (headers) => {
      seenAuthorization.push(headers.Authorization);
      throw Object.assign(new Error("expired"), { statusCode: 401 });
    }),
    /wechat unavailable/u,
  );
  assert.deepEqual(seenAuthorization, ["Bearer expired-real-owner-token"]);
});

test("本地真实会话已过期且刷新失败时也不降级为 demo 匿名请求", async () => {
  const { manager } = fixture({
    stored: { token: "locally-expired-real-token", expiresAt: new Date(Date.now() - 1_000).toISOString() },
    exchange: async () => {
      throw Object.assign(new Error("wechat unavailable"), { statusCode: 503 });
    },
  });
  let operationCalled = false;

  await assert.rejects(
    manager.withAuthorization({}, async () => {
      operationCalled = true;
      return "unexpected";
    }),
    /wechat unavailable/u,
  );
  assert.equal(operationCalled, false);
});

test("开发模式交换不可用时不伪造身份，由服务端 demo fallback 决定匿名请求", async () => {
  const { manager, stats } = fixture({
    exchange: async () => {
      throw Object.assign(new Error("not configured"), { statusCode: 404 });
    },
  });
  const headers = await manager.withAuthorization(
    { "content-type": "application/json" },
    async (value) => value,
  );
  assert.deepEqual(headers, { "content-type": "application/json" });
  assert.equal(await manager.ensureSession(), null);
  assert.equal(stats().loginCalls, 1);
  assert.equal(stats().exchangeCalls, 1);
});

test("正式模式交换失败时拒绝业务请求，不降级到 demo 身份", async () => {
  const { manager } = fixture({
    strict: true,
    exchange: async () => {
      throw Object.assign(new Error("not configured"), { statusCode: 503 });
    },
  });
  let operationCalled = false;

  await assert.rejects(
    manager.withAuthorization({}, async () => {
      operationCalled = true;
      return "unexpected";
    }),
    /not configured/u,
  );
  assert.equal(operationCalled, false);
});
