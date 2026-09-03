import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDatabase } from "./database.js";
import { applyUserProfile } from "./user-profile.js";

export const DEVELOPMENT_USER_ID = "demo-user";
export const DEVELOPMENT_IDENTITY_PROVIDER = "development";
export const DEVELOPMENT_PROVIDER_APP_ID = "yuxiaoman-development";

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: string;
};

export class AuthenticationError extends Error {
  constructor(
    message = "需要有效的用户会话",
    readonly code = "AUTHENTICATION_REQUIRED",
    readonly statusCode = 401,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export async function migrateAuthDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      customer_number TEXT,
      data_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (data_kind IN ('real', 'demo', 'unknown')),
      display_name TEXT,
      avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_app_id TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      union_subject TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider, provider_app_id, provider_subject)
    );

    CREATE INDEX IF NOT EXISTS user_identities_user_index
      ON user_identities(user_id, provider, provider_app_id);
    CREATE INDEX IF NOT EXISTS user_identities_union_index
      ON user_identities(provider, provider_app_id, union_subject)
      WHERE union_subject IS NOT NULL;
    CREATE INDEX IF NOT EXISTS user_identities_cross_app_union_index
      ON user_identities(provider, union_subject, user_id)
      WHERE union_subject IS NOT NULL;

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS user_sessions_user_created_index
      ON user_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS user_sessions_active_token_index
      ON user_sessions(token_hash, expires_at)
      WHERE revoked_at IS NULL;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS customer_number TEXT,
      ADD COLUMN IF NOT EXISTS data_kind TEXT NOT NULL DEFAULT 'unknown';

    -- A partially applied historical migration may already have created a
    -- nullable or unconstrained column. Repair it before relying on the value
    -- for real/demo isolation or destructive-reset guards.
    UPDATE users
    SET data_kind = 'unknown'
    WHERE data_kind IS NULL OR data_kind NOT IN ('real', 'demo', 'unknown');

    UPDATE users
    SET customer_number = 'CUS-' || upper(substr(md5(id), 1, 12))
    WHERE customer_number IS NULL OR customer_number = '';

    UPDATE users
    SET data_kind = 'demo'
    WHERE id = 'demo-user' OR id LIKE 'operator-user-%';

    UPDATE users u
    SET data_kind = 'real'
    WHERE u.data_kind = 'unknown'
      AND EXISTS (
        SELECT 1 FROM user_identities i
        WHERE i.user_id = u.id AND i.provider = 'wechat'
      );

    CREATE OR REPLACE FUNCTION assign_user_customer_number()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.customer_number IS NULL OR NEW.customer_number = '' THEN
        NEW.customer_number := 'CUS-' || upper(substr(md5(NEW.id), 1, 12));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS users_assign_customer_number ON users;
    CREATE TRIGGER users_assign_customer_number
      BEFORE INSERT ON users
      FOR EACH ROW EXECUTE FUNCTION assign_user_customer_number();

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_data_kind_check;
    ALTER TABLE users
      ADD CONSTRAINT users_data_kind_check CHECK (data_kind IN ('real', 'demo', 'unknown'));
    ALTER TABLE users
      ALTER COLUMN data_kind SET DEFAULT 'unknown',
      ALTER COLUMN data_kind SET NOT NULL;
    ALTER TABLE users ALTER COLUMN customer_number SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS users_customer_number_unique
      ON users(customer_number);
  `);
}

export async function seedDevelopmentUser(
  database: AppDatabase,
  userId = DEVELOPMENT_USER_ID,
  now = new Date().toISOString(),
): Promise<void> {
  await database.prepare(`
    INSERT INTO users (
      id, customer_number, data_kind, display_name, status, created_at, updated_at
    )
    VALUES (?, ?, 'demo', '驭小满演示车主', 'active', ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      display_name = excluded.display_name,
      data_kind = 'demo',
      status = 'active',
      updated_at = excluded.updated_at
  `).run(userId, customerNumberForUser(userId), now, now);

  await database.prepare(`
    INSERT INTO user_identities (
      id, user_id, provider, provider_app_id, provider_subject, union_subject, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT (provider, provider_app_id, provider_subject) DO UPDATE SET
      user_id = excluded.user_id,
      updated_at = excluded.updated_at
  `).run(
    `identity-development-${userId}`,
    userId,
    DEVELOPMENT_IDENTITY_PROVIDER,
    DEVELOPMENT_PROVIDER_APP_ID,
    userId,
    now,
    now,
  );
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function customerNumberForUser(userId: string): string {
  return `CUS-${createHash("md5").update(userId).digest("hex").slice(0, 12).toUpperCase()}`;
}

function expiryFromNow(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1_000).toISOString();
}

export async function createUserSession(
  database: AppDatabase,
  userId: string,
  options: { ttlSeconds?: number; now?: string } = {},
): Promise<{ token: string; sessionId: string; userId: string; expiresAt: string }> {
  const user = await database.prepare<{ id: string }>(
    "SELECT id FROM users WHERE id = ? AND status = 'active'",
  ).get(userId);
  if (!user) throw new AuthenticationError("用户不存在或已停用");

  const now = options.now ?? new Date().toISOString();
  const ttlSeconds = options.ttlSeconds ?? 30 * 24 * 60 * 60;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Session ttlSeconds must be a positive safe integer");
  }
  const token = `yxm_${randomBytes(32).toString("base64url")}`;
  const sessionId = randomUUID();
  const expiresAt = options.now
    ? new Date(new Date(options.now).getTime() + ttlSeconds * 1_000).toISOString()
    : expiryFromNow(ttlSeconds);
  await database.prepare(`
    INSERT INTO user_sessions (
      id, user_id, token_hash, expires_at, revoked_at, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?)
  `).run(sessionId, userId, tokenHash(token), expiresAt, now, now);
  return { token, sessionId, userId, expiresAt };
}

export async function createDevelopmentSession(
  database: AppDatabase,
  options: { userId?: string; ttlSeconds?: number } = {},
): Promise<{ token: string; sessionId: string; userId: string; expiresAt: string }> {
  if (isProductionEnvironment()) {
    throw new Error("Development sessions are disabled in production");
  }
  const userId = options.userId ?? DEVELOPMENT_USER_ID;
  await seedDevelopmentUser(database, userId);
  return createUserSession(database, userId, { ttlSeconds: options.ttlSeconds });
}

export async function revokeUserSession(
  database: AppDatabase,
  token: string,
  now = new Date().toISOString(),
): Promise<boolean> {
  const result = await database.prepare(`
    UPDATE user_sessions
    SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `).run(now, tokenHash(token));
  return result.changes > 0;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/iu);
  if (!match) throw new AuthenticationError("Authorization 请求头格式无效");
  return match[1];
}

function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
}

export function demoAuthFallbackEnabled(): boolean {
  return !isProductionEnvironment() && process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK === "true";
}

export async function currentUserId(request: FastifyRequest, database: AppDatabase): Promise<string> {
  const token = bearerToken(request);
  if (!token) {
    if (demoAuthFallbackEnabled()) return DEVELOPMENT_USER_ID;
    throw new AuthenticationError();
  }

  const now = new Date().toISOString();
  const session = await database.prepare<SessionRow>(`
    SELECT s.id, s.user_id, s.expires_at
    FROM user_sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND u.status = 'active'
      ${isProductionEnvironment() ? "AND u.data_kind IS DISTINCT FROM 'demo'" : ""}
    LIMIT 1
  `).get(tokenHash(token), now);
  if (!session) throw new AuthenticationError("用户会话无效或已过期");

  await database.prepare(`
    UPDATE user_sessions SET last_seen_at = ?
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
  `).run(now, session.id, new Date(Date.now() - 5 * 60_000).toISOString());
  return session.user_id;
}

export async function requireCurrentUser(request: FastifyRequest, database: AppDatabase): Promise<string> {
  return currentUserId(request, database);
}

type WechatCode2SessionPayload = {
  openid?: unknown;
  unionid?: unknown;
  session_key?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
};

function wechatConfiguration(): { appId: string; appSecret: string } {
  const appId = (process.env.WECHAT_MINIPROGRAM_APP_ID ?? process.env.WECHAT_APP_ID ?? "").trim();
  const appSecret = (process.env.WECHAT_MINIPROGRAM_APP_SECRET ?? process.env.WECHAT_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) {
    throw new AuthenticationError(
      "微信登录服务尚未配置",
      "WECHAT_AUTH_NOT_CONFIGURED",
      503,
    );
  }
  return { appId, appSecret };
}

async function exchangeWechatCode(
  code: string,
  configuration: { appId: string; appSecret: string },
): Promise<{ openId: string; unionId: string | null }> {
  const query = new URLSearchParams({
    appid: configuration.appId,
    secret: configuration.appSecret,
    js_code: code,
    grant_type: "authorization_code",
  });
  let response: Response;
  try {
    response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${query.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AuthenticationError("微信登录服务暂时不可用", "WECHAT_AUTH_UPSTREAM_UNAVAILABLE", 502);
  }
  if (!response.ok) {
    throw new AuthenticationError("微信登录服务暂时不可用", "WECHAT_AUTH_UPSTREAM_UNAVAILABLE", 502);
  }
  let payload: WechatCode2SessionPayload;
  try {
    payload = await response.json() as WechatCode2SessionPayload;
  } catch {
    throw new AuthenticationError("微信登录服务返回异常", "WECHAT_AUTH_UPSTREAM_INVALID", 502);
  }
  if (payload.errcode != null && Number(payload.errcode) !== 0) {
    throw new AuthenticationError("微信登录凭证无效或已过期", "WECHAT_LOGIN_CODE_INVALID", 401);
  }
  const openId = typeof payload.openid === "string" ? payload.openid.trim() : "";
  const unionId = typeof payload.unionid === "string" && payload.unionid.trim()
    ? payload.unionid.trim()
    : null;
  if (!openId) {
    throw new AuthenticationError("微信登录服务返回异常", "WECHAT_AUTH_UPSTREAM_INVALID", 502);
  }
  return { openId, unionId };
}

export async function createWechatUserSession(
  database: AppDatabase,
  identity: { appId: string; openId: string; unionId: string | null },
  options: {
    uploadDir?: string;
    profile?: { nickName?: string | null; avatarUrl?: string | null };
  } = {},
): Promise<{ token: string; expiresAt: string }> {
  return database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`wechat-openid:${identity.appId}:${identity.openId}`);
    if (identity.unionId) {
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .get(`wechat-unionid:${identity.unionId}`);
    }

    const exact = await transaction.prepare<{ id: string; user_id: string; union_subject: string | null }>(`
      SELECT id, user_id, union_subject
      FROM user_identities
      WHERE provider = 'wechat' AND provider_app_id = ? AND provider_subject = ?
      LIMIT 1
    `).get(identity.appId, identity.openId);

    let userId = exact?.user_id ?? null;
    if (exact?.union_subject && identity.unionId && exact.union_subject !== identity.unionId) {
      throw new AuthenticationError(
        "微信身份存在冲突，请联系平台处理",
        "WECHAT_IDENTITY_CONFLICT",
        409,
      );
    }
    if (identity.unionId) {
      const unionUsers = await transaction.prepare<{ user_id: string }>(`
        SELECT DISTINCT user_id
        FROM user_identities
        WHERE provider = 'wechat' AND union_subject = ?
        ORDER BY user_id
        LIMIT 2
      `).all(identity.unionId);
      if (unionUsers.length > 1 || (userId && unionUsers.length === 1 && unionUsers[0].user_id !== userId)) {
        throw new AuthenticationError(
          "微信身份存在冲突，请联系平台处理",
          "WECHAT_IDENTITY_CONFLICT",
          409,
        );
      }
      if (!userId && unionUsers.length === 1) userId = unionUsers[0].user_id;
    }

    if (userId) {
      const owner = await transaction.prepare<{ data_kind: string }>(
        "SELECT data_kind FROM users WHERE id = ? LIMIT 1",
      ).get(userId);
      if (!owner || owner.data_kind === "demo") {
        throw new AuthenticationError(
          "微信真实身份不能绑定演示客户",
          "WECHAT_IDENTITY_CONFLICT",
          409,
        );
      }
    }

    const now = new Date().toISOString();
    if (!userId) {
      userId = randomUUID();
      await transaction.prepare(`
        INSERT INTO users (
          id, customer_number, data_kind, display_name, avatar_url,
          status, created_at, updated_at
        ) VALUES (?, ?, 'real', NULL, NULL, 'active', ?, ?)
      `).run(userId, customerNumberForUser(userId), now, now);
    } else {
      await transaction.prepare(`
        UPDATE users
        SET data_kind = CASE WHEN data_kind = 'unknown' THEN 'real' ELSE data_kind END,
          updated_at = ?
        WHERE id = ?
      `).run(now, userId);
    }

    if (exact) {
      if (identity.unionId && !exact.union_subject) {
        await transaction.prepare(`
          UPDATE user_identities SET union_subject = ?, updated_at = ? WHERE id = ?
        `).run(identity.unionId, now, exact.id);
      }
    } else {
      await transaction.prepare(`
        INSERT INTO user_identities (
          id, user_id, provider, provider_app_id, provider_subject,
          union_subject, created_at, updated_at
        ) VALUES (?, ?, 'wechat', ?, ?, ?, ?, ?)
      `).run(randomUUID(), userId, identity.appId, identity.openId, identity.unionId, now, now);
    }

    if (options.uploadDir && (options.profile?.nickName || options.profile?.avatarUrl)) {
      await applyUserProfile(transaction, options.uploadDir, userId, {
        nickName: options.profile.nickName,
        avatarUrl: options.profile.avatarUrl,
      });
    }

    const session = await createUserSession(transaction, userId);
    return { token: session.token, expiresAt: session.expiresAt };
  }, { isolationLevel: "serializable" });
}

export function registerAuthRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: { uploadDir?: string } = {},
): void {
  app.post("/api/auth/wechat/session", async (request) => {
    const body = request.body as {
      code?: unknown;
      nickName?: unknown;
      avatarUrl?: unknown;
    } | null | undefined;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code || code.length > 512) {
      throw new AuthenticationError("微信登录凭证格式无效", "WECHAT_LOGIN_CODE_INVALID", 400);
    }
    const nickName = typeof body?.nickName === "string" ? body.nickName.trim() : "";
    const avatarUrl = typeof body?.avatarUrl === "string" ? body.avatarUrl.trim() : "";
    const configuration = wechatConfiguration();
    const identity = await exchangeWechatCode(code, configuration);
    return createWechatUserSession(database, { appId: configuration.appId, ...identity }, {
      uploadDir: options.uploadDir,
      profile: {
        nickName: nickName || null,
        avatarUrl: avatarUrl || null,
      },
    });
  });

  app.post("/api/auth/development/session", async (_request, reply) => {
    if (isProductionEnvironment() || process.env.YUXIAOMAN_ENABLE_DEVELOPMENT_AUTH !== "true") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "接口不存在" });
    }
    const session = await createDevelopmentSession(database);
    return reply.code(201).send(session);
  });

  app.get("/api/auth/session", async (request) => {
    const userId = await requireCurrentUser(request, database);
    return { authenticated: true, userId };
  });

  app.delete("/api/auth/session", async (request, reply) => {
    const token = bearerToken(request);
    if (!token) throw new AuthenticationError();
    await revokeUserSession(database, token);
    return reply.code(204).send();
  });
}
