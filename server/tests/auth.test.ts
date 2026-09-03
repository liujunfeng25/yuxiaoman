import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import {
  createDevelopmentSession,
  createUserSession,
  createWechatUserSession,
  DEVELOPMENT_IDENTITY_PROVIDER,
  DEVELOPMENT_PROVIDER_APP_ID,
  DEVELOPMENT_USER_ID,
  migrateAuthDatabase,
} from "../auth.js";
import { buildApp } from "../app.js";
import { demoResetBlockers, type Database } from "../db.js";
import { createTestDatabase } from "./test-database.js";

process.env.YUXIAOMAN_ENABLE_DEVELOPMENT_AUTH = "true";
process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "false";
process.env.YUXIAOMAN_ENV = "test";

type Json = Record<string, any>;

async function fixture(prefix = "auth"): Promise<{
  app: FastifyInstance;
  database: Database;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase(prefix);
  const privateRoot = mkdtempSync(join(tmpdir(), "yuxiaoman-auth-"));
  const app = await buildApp({
    database,
    uploadDir: join(privateRoot, "uploads"),
    insuranceUploadDir: join(privateRoot, "insurance"),
  });
  await app.ready();
  return {
    app,
    database,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(privateRoot, { recursive: true, force: true });
    },
  };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function uploadProfileAvatar(app: FastifyInstance, token: string, image: Buffer) {
  const boundary = `----profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: "/api/auth/profile/avatar",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    payload: body,
  });
}

async function createVehicle(app: FastifyInstance, token: string, plateNumber: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/vehicles",
    headers: bearer(token),
    payload: {
      plateNumber,
      vehicleType: "小型轿车",
      usageNature: "非营运",
      seats: 5,
      registrationDate: "2020-01-01",
      inspectionValidity: { mode: "unconfirmed" },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Json>().data;
}

test("development session 复用开发身份并返回可用的 Bearer token", async () => {
  const { app, database, close } = await fixture("auth_session");
  try {
    const first = await app.inject({ method: "POST", url: "/api/auth/development/session" });
    const second = await app.inject({ method: "POST", url: "/api/auth/development/session" });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);

    const firstSession = first.json<Json>();
    const secondSession = second.json<Json>();
    assert.equal(firstSession.userId, DEVELOPMENT_USER_ID);
    assert.equal(secondSession.userId, DEVELOPMENT_USER_ID);
    assert.match(firstSession.token, /^yxm_[A-Za-z0-9_-]+$/u);
    assert.match(secondSession.token, /^yxm_[A-Za-z0-9_-]+$/u);
    assert.notEqual(firstSession.token, secondSession.token);
    assert.notEqual(firstSession.sessionId, secondSession.sessionId);

    for (const token of [firstSession.token, secondSession.token]) {
      const current = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: bearer(token),
      });
      assert.equal(current.statusCode, 200, current.body);
      assert.deepEqual(current.json<Json>(), { authenticated: true, userId: DEVELOPMENT_USER_ID });
    }

    const identityCount = await database.prepare<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM user_identities
      WHERE user_id = ? AND provider = ? AND provider_app_id = ? AND provider_subject = ?
    `).get(
      DEVELOPMENT_USER_ID,
      DEVELOPMENT_IDENTITY_PROVIDER,
      DEVELOPMENT_PROVIDER_APP_ID,
      DEVELOPMENT_USER_ID,
    );
    const sessionCount = await database.prepare<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM user_sessions WHERE user_id = ?
    `).get(DEVELOPMENT_USER_ID);
    assert.equal(identityCount?.count, "1");
    assert.equal(sessionCount?.count, "2");
  } finally {
    await close();
  }
});

test("两个开发身份的车辆数据相互隔离", async () => {
  const { app, database, close } = await fixture("auth_isolation");
  try {
    const userA = await createDevelopmentSession(database, { userId: "auth-user-a" });
    const userB = await createDevelopmentSession(database, { userId: "auth-user-b" });
    const vehicleA = await createVehicle(app, userA.token, "津B·A1234");
    const vehicleB = await createVehicle(app, userB.token, "津C·B5678");

    const listA = await app.inject({ method: "GET", url: "/api/vehicles", headers: bearer(userA.token) });
    const listB = await app.inject({ method: "GET", url: "/api/vehicles", headers: bearer(userB.token) });
    assert.equal(listA.statusCode, 200, listA.body);
    assert.equal(listB.statusCode, 200, listB.body);
    assert.deepEqual(listA.json<Json>().data.map((vehicle: Json) => vehicle.id), [vehicleA.id]);
    assert.deepEqual(listB.json<Json>().data.map((vehicle: Json) => vehicle.id), [vehicleB.id]);

    const crossRead = await app.inject({
      method: "GET",
      url: `/api/vehicles/${vehicleA.id}`,
      headers: bearer(userB.token),
    });
    assert.equal(crossRead.statusCode, 404, crossRead.body);
    assert.equal(crossRead.json<Json>().error.code, "VEHICLE_NOT_FOUND");
  } finally {
    await close();
  }
});

test("关闭 demo fallback 后无 token 的车主接口返回 401", async () => {
  const { app, close } = await fixture("auth_required");
  try {
    const response = await app.inject({ method: "GET", url: "/api/vehicles" });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.json<Json>().error.code, "AUTHENTICATION_REQUIRED");
  } finally {
    await close();
  }
});

test("身份唯一键包含 provider_app_id", async () => {
  const database = await createTestDatabase("auth_provider_app");
  try {
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO users (id, display_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?), (?, ?, 'active', ?, ?)
    `).run(
      "provider-user-a",
      "应用身份 A",
      now,
      now,
      "provider-user-b",
      "应用身份 B",
      now,
      now,
    );

    await database.prepare(`
      INSERT INTO user_identities (
        id, user_id, provider, provider_app_id, provider_subject, union_subject, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run("identity-app-a", "provider-user-a", "wechat", "mini-app-a", "same-openid", now, now);
    await database.prepare(`
      INSERT INTO user_identities (
        id, user_id, provider, provider_app_id, provider_subject, union_subject, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run("identity-app-b", "provider-user-b", "wechat", "mini-app-b", "same-openid", now, now);

    const identities = await database.prepare<{ provider_app_id: string; user_id: string }>(`
      SELECT provider_app_id, user_id
      FROM user_identities
      WHERE provider = 'wechat' AND provider_subject = 'same-openid'
      ORDER BY provider_app_id
    `).all();
    assert.deepEqual(identities, [
      { provider_app_id: "mini-app-a", user_id: "provider-user-a" },
      { provider_app_id: "mini-app-b", user_id: "provider-user-b" },
    ]);

    await assert.rejects(
      database.prepare(`
        INSERT INTO user_identities (
          id, user_id, provider, provider_app_id, provider_subject, union_subject, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run("identity-app-a-duplicate", "provider-user-b", "wechat", "mini-app-a", "same-openid", now, now),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
  } finally {
    await database.close();
  }
});

test("微信 code2Session 只返回应用 Bearer 且同一 OpenID 幂等绑定真实客户", async () => {
  const { app, database, close } = await fixture("auth_wechat_session");
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.WECHAT_MINIPROGRAM_APP_ID;
  const previousSecret = process.env.WECHAT_MINIPROGRAM_APP_SECRET;
  try {
    process.env.WECHAT_MINIPROGRAM_APP_ID = "wx-test-app-a";
    process.env.WECHAT_MINIPROGRAM_APP_SECRET = "server-only-test-secret";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      openid: "openid-owner-a",
      unionid: "union-owner-a",
      session_key: "must-never-be-returned",
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/wechat/session",
      payload: { code: "one-time-code-a" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/wechat/session",
      payload: { code: "one-time-code-b" },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    for (const response of [first, second]) {
      const payload = response.json<Json>();
      assert.deepEqual(Object.keys(payload).sort(), ["expiresAt", "token"]);
      assert.match(payload.token, /^yxm_[A-Za-z0-9_-]+$/u);
      assert.equal(response.body.includes("openid-owner-a"), false);
      assert.equal(response.body.includes("union-owner-a"), false);
      assert.equal(response.body.includes("session_key"), false);
      assert.equal(response.body.includes("server-only-test-secret"), false);
    }

    const identities = await database.prepare<Json>(`
      SELECT i.user_id, u.data_kind, u.customer_number
      FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = 'wechat' AND i.provider_app_id = ? AND i.provider_subject = ?
    `).all("wx-test-app-a", "openid-owner-a");
    assert.equal(identities.length, 1);
    assert.equal(identities[0].data_kind, "real");
    assert.match(identities[0].customer_number, /^CUS-[A-F0-9]{12}$/u);
    const sessionCount = await database.prepare<Json>(`
      SELECT COUNT(*)::integer AS count FROM user_sessions WHERE user_id = ?
    `).get(identities[0].user_id);
    assert.equal(sessionCount?.count, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId == null) delete process.env.WECHAT_MINIPROGRAM_APP_ID;
    else process.env.WECHAT_MINIPROGRAM_APP_ID = previousAppId;
    if (previousSecret == null) delete process.env.WECHAT_MINIPROGRAM_APP_SECRET;
    else process.env.WECHAT_MINIPROGRAM_APP_SECRET = previousSecret;
    await close();
  }
});

test("微信 UnionID 可安全跨 AppID 关联，但拒绝冲突或演示客户串线", async () => {
  const database = await createTestDatabase("auth_wechat_union");
  try {
    await createWechatUserSession(database, {
      appId: "wx-union-a",
      openId: "openid-union-a",
      unionId: "union-safe-owner",
    });
    await createWechatUserSession(database, {
      appId: "wx-union-b",
      openId: "openid-union-b",
      unionId: "union-safe-owner",
    });
    const safeRows = await database.prepare<Json>(`
      SELECT DISTINCT user_id FROM user_identities
      WHERE provider = 'wechat' AND union_subject = ?
    `).all("union-safe-owner");
    assert.equal(safeRows.length, 1);

    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO user_identities (
        id, user_id, provider, provider_app_id, provider_subject, union_subject, created_at, updated_at
      ) VALUES (?, ?, 'wechat', ?, ?, ?, ?, ?)
    `).run(
      "identity-demo-wechat-conflict",
      DEVELOPMENT_USER_ID,
      "wx-demo-conflict",
      "openid-demo-conflict",
      "union-demo-conflict",
      now,
      now,
    );
    await assert.rejects(
      createWechatUserSession(database, {
        appId: "wx-demo-conflict",
        openId: "openid-demo-conflict",
        unionId: "union-demo-conflict",
      }),
      (error: unknown) => (error as Json).code === "WECHAT_IDENTITY_CONFLICT",
    );

    await assert.rejects(
      createWechatUserSession(database, {
        appId: "wx-union-a",
        openId: "openid-union-a",
        unionId: "different-union",
      }),
      (error: unknown) => (error as Json).code === "WECHAT_IDENTITY_CONFLICT",
    );
  } finally {
    await database.close();
  }
});

test("微信会话未配置时 503，失效 code 不会降级到 demo 用户", async () => {
  const { app, close } = await fixture("auth_wechat_fail_closed");
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.WECHAT_MINIPROGRAM_APP_ID;
  const previousSecret = process.env.WECHAT_MINIPROGRAM_APP_SECRET;
  const previousAliasAppId = process.env.WECHAT_APP_ID;
  const previousAliasSecret = process.env.WECHAT_APP_SECRET;
  try {
    delete process.env.WECHAT_MINIPROGRAM_APP_ID;
    delete process.env.WECHAT_MINIPROGRAM_APP_SECRET;
    delete process.env.WECHAT_APP_ID;
    delete process.env.WECHAT_APP_SECRET;
    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/wechat/session",
      payload: { code: "one-time-code" },
    });
    assert.equal(missing.statusCode, 503, missing.body);
    assert.equal(missing.json<Json>().error.code, "WECHAT_AUTH_NOT_CONFIGURED");

    process.env.WECHAT_MINIPROGRAM_APP_ID = "wx-fail-closed";
    process.env.WECHAT_MINIPROGRAM_APP_SECRET = "server-only-secret";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      errcode: 40029,
      errmsg: "invalid code",
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const invalid = await app.inject({
      method: "POST",
      url: "/api/auth/wechat/session",
      payload: { code: "expired-code" },
    });
    assert.equal(invalid.statusCode, 401, invalid.body);
    assert.equal(invalid.json<Json>().error.code, "WECHAT_LOGIN_CODE_INVALID");
    assert.equal(invalid.body.includes("demo-user"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId == null) delete process.env.WECHAT_MINIPROGRAM_APP_ID;
    else process.env.WECHAT_MINIPROGRAM_APP_ID = previousAppId;
    if (previousSecret == null) delete process.env.WECHAT_MINIPROGRAM_APP_SECRET;
    else process.env.WECHAT_MINIPROGRAM_APP_SECRET = previousSecret;
    if (previousAliasAppId == null) delete process.env.WECHAT_APP_ID;
    else process.env.WECHAT_APP_ID = previousAliasAppId;
    if (previousAliasSecret == null) delete process.env.WECHAT_APP_SECRET;
    else process.env.WECHAT_APP_SECRET = previousAliasSecret;
    await close();
  }
});

test("生产环境拒绝历史 demo Bearer，但真实客户会话保持可用", async () => {
  const { app, database, close } = await fixture("auth_production_demo_session");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousYxmEnv = process.env.YUXIAOMAN_ENV;
  try {
    const demo = await createDevelopmentSession(database);
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO users (id, data_kind, display_name, status, created_at, updated_at)
      VALUES ('auth-production-real', 'real', '生产真实客户', 'active', ?, ?)
    `).run(now, now);
    const real = await createUserSession(database, "auth-production-real");

    process.env.NODE_ENV = "production";
    process.env.YUXIAOMAN_ENV = "production";
    const denied = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: bearer(demo.token),
    });
    assert.equal(denied.statusCode, 401, denied.body);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: bearer(real.token),
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json<Json>().userId, "auth-production-real");
  } finally {
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousYxmEnv == null) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = previousYxmEnv;
    await close();
  }
});

test("历史 nullable data_kind 会回填 unknown、恢复 NOT NULL 并阻止演示重置", async () => {
  const database = await createTestDatabase("auth_nullable_data_kind");
  try {
    await database.execute("ALTER TABLE users ALTER COLUMN data_kind DROP NOT NULL");
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO users (id, data_kind, display_name, status, created_at, updated_at)
      VALUES ('legacy-null-data-kind', NULL, '历史未分类客户', 'active', ?, ?)
    `).run(now, now);
    assert.ok((await demoResetBlockers(database)).unsafeCustomers > 0);

    await migrateAuthDatabase(database);
    const migrated = await database.prepare<Json>(
      "SELECT data_kind FROM users WHERE id = 'legacy-null-data-kind'",
    ).get();
    assert.equal(migrated?.data_kind, "unknown");
    const column = await database.prepare<Json>(`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'data_kind'
    `).get();
    assert.equal(column?.is_nullable, "NO");
    assert.match(String(column?.column_default), /unknown/u);
  } finally {
    await database.close();
  }
});

test("车主资料可在登录后通过微信授权同步，并写入 users 主数据", async () => {
  const { app, database, close } = await fixture("auth_profile");
  try {
    const session = await app.inject({ method: "POST", url: "/api/auth/development/session" });
    assert.equal(session.statusCode, 201, session.body);
    const token = session.json<Json>().token as string;

    const initial = await app.inject({ method: "GET", url: "/api/auth/profile", headers: bearer(token) });
    assert.equal(initial.statusCode, 200, initial.body);
    const initialProfile = initial.json<Json>().data;
    assert.equal(initialProfile.displayName, "驭小满演示车主");
    assert.equal(initialProfile.avatarUrl, null);
    assert.equal(initialProfile.profileComplete, false);

    const avatarPng = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2878d1" } }).png().toBuffer();
    const synced = await app.inject({
      method: "POST",
      url: "/api/auth/profile/sync",
      headers: bearer(token),
      payload: { nickName: "天津李女士" },
    });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json<Json>().data.displayName, "天津李女士");

    const avatarUpload = await uploadProfileAvatar(app, token, avatarPng);
    assert.equal(avatarUpload.statusCode, 200, avatarUpload.body);
    const avatarProfile = avatarUpload.json<Json>().data;
    assert.match(String(avatarProfile.avatarUrl), /^\/api\/user-avatars\/demo-user$/u);
    assert.equal(avatarProfile.profileComplete, true);

    const avatarResponse = await app.inject({ method: "GET", url: String(avatarProfile.avatarUrl) });
    assert.equal(avatarResponse.statusCode, 200, avatarResponse.body);
    assert.match(String(avatarResponse.headers["content-type"]), /image\/jpeg/u);

    const row = await database.prepare<Json>(
      "SELECT display_name, avatar_url FROM users WHERE id = ?",
    ).get(DEVELOPMENT_USER_ID);
    assert.equal(row?.display_name, "天津李女士");
    assert.equal(row?.avatar_url, avatarProfile.avatarUrl);
  } finally {
    await close();
  }
});
