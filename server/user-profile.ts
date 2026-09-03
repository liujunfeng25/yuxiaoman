import { createReadStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { AuthenticationError, requireCurrentUser } from "./auth.js";
import type { AppDatabase } from "./database.js";

const AVATAR_ROUTE_PREFIX = "/api/user-avatars/";
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const displayNameSchema = z.string().trim().min(1, "昵称不能为空").max(32, "昵称不能超过 32 个字");
const profileUpdateSchema = z.object({
  displayName: displayNameSchema,
});
const profileSyncSchema = z.object({
  displayName: displayNameSchema.optional(),
  nickName: displayNameSchema.optional(),
  avatarUrl: z.string().url().max(2000).optional(),
}).refine((value) => Boolean(value.displayName || value.nickName || value.avatarUrl), {
  message: "缺少可同步的资料",
});

const WECHAT_AVATAR_HOSTS = new Set([
  "thirdwx.qlogo.cn",
  "wx.qlogo.cn",
  "mmbiz.qpic.cn",
]);

export type UserProfile = {
  displayName: string | null;
  avatarUrl: string | null;
  profileComplete: boolean;
};

function avatarDirectory(uploadDir: string): string {
  return join(uploadDir, "user-avatars");
}

function avatarStoragePath(uploadDir: string, userId: string): string {
  return join(avatarDirectory(uploadDir), `${userId}.jpg`);
}

function avatarPublicPath(userId: string): string {
  return `${AVATAR_ROUTE_PREFIX}${encodeURIComponent(userId)}`;
}

function profileValidationError(error: z.ZodError): AuthenticationError {
  const message = error.issues[0]?.message ?? "提交的信息有误，请检查后重试";
  return new AuthenticationError(message, "PROFILE_VALIDATION_ERROR", 400);
}

function assertUserId(userId: string): string {
  const value = userId.trim();
  if (!USER_ID_PATTERN.test(value)) {
    throw new AuthenticationError("用户标识无效", "PROFILE_USER_INVALID", 400);
  }
  return value;
}

async function readUserProfile(database: AppDatabase, userId: string): Promise<UserProfile> {
  const row = await database.prepare<{ display_name: string | null; avatar_url: string | null }>(`
    SELECT display_name, avatar_url
    FROM users
    WHERE id = ? AND status = 'active'
    LIMIT 1
  `).get(userId);
  if (!row) throw new AuthenticationError("用户不存在或已停用");
  const displayName = row.display_name == null ? null : String(row.display_name).trim() || null;
  const avatarUrl = row.avatar_url == null ? null : String(row.avatar_url).trim() || null;
  return {
    displayName,
    avatarUrl,
    profileComplete: Boolean(displayName && avatarUrl),
  };
}

async function avatarFileExists(uploadDir: string, userId: string): Promise<boolean> {
  try {
    await access(avatarStoragePath(uploadDir, userId));
    return true;
  } catch {
    return false;
  }
}

export async function saveUserAvatar(
  database: AppDatabase,
  uploadDir: string,
  userId: string,
  source: Buffer,
): Promise<UserProfile> {
  if (source.length === 0) {
    throw new AuthenticationError("请选择头像图片", "PROFILE_AVATAR_REQUIRED", 400);
  }
  if (source.length > 5 * 1024 * 1024) {
    throw new AuthenticationError("头像不能超过 5MB", "PROFILE_AVATAR_TOO_LARGE", 413);
  }

  let processed;
  try {
    processed = await sharp(source, { failOn: "error" })
      .rotate()
      .resize({ width: 512, height: 512, fit: "cover", withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AuthenticationError("头像图片已损坏或无法识别，请重新选择", "PROFILE_AVATAR_INVALID", 400);
  }

  await mkdir(avatarDirectory(uploadDir), { recursive: true });
  await writeFile(avatarStoragePath(uploadDir, userId), processed.data, { flag: "w" });

  const now = new Date().toISOString();
  const avatarUrl = avatarPublicPath(userId);
  await database.prepare(`
    UPDATE users
    SET avatar_url = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(avatarUrl, now, userId);

  return readUserProfile(database, userId);
}

function resolvedDisplayName(input: { displayName?: string; nickName?: string }): string | null {
  const value = (input.displayName ?? input.nickName ?? "").trim();
  if (!value || value === "微信用户") return null;
  return value;
}

export async function importAvatarFromRemoteUrl(
  database: AppDatabase,
  uploadDir: string,
  userId: string,
  remoteUrl: string,
): Promise<UserProfile> {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new AuthenticationError("头像地址无效", "PROFILE_AVATAR_URL_INVALID", 400);
  }
  if (parsed.protocol !== "https:" || !WECHAT_AVATAR_HOSTS.has(parsed.hostname)) {
    throw new AuthenticationError("头像地址无效", "PROFILE_AVATAR_URL_INVALID", 400);
  }

  let response: Response;
  try {
    response = await fetch(remoteUrl, { method: "GET", signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new AuthenticationError("头像下载失败", "PROFILE_AVATAR_FETCH_FAILED", 502);
  }
  if (!response.ok) {
    throw new AuthenticationError("头像下载失败", "PROFILE_AVATAR_FETCH_FAILED", 502);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return saveUserAvatar(database, uploadDir, userId, buffer);
}

export async function applyUserProfile(
  database: AppDatabase,
  uploadDir: string,
  userId: string,
  input: { displayName?: string | null; nickName?: string | null; avatarUrl?: string | null },
): Promise<UserProfile> {
  const displayName = resolvedDisplayName({
    displayName: input.displayName ?? undefined,
    nickName: input.nickName ?? undefined,
  });
  const now = new Date().toISOString();
  if (displayName) {
    await database.prepare(`
      UPDATE users
      SET display_name = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(displayName, now, userId);
  }

  const avatarUrl = input.avatarUrl?.trim();
  if (avatarUrl) {
    if (/^https:\/\//iu.test(avatarUrl)) {
      await importAvatarFromRemoteUrl(database, uploadDir, userId, avatarUrl);
    } else if (avatarUrl.startsWith("/api/user-avatars/")) {
      await database.prepare(`
        UPDATE users
        SET avatar_url = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(avatarUrl, now, userId);
    }
  }

  return readUserProfile(database, userId);
}

export function registerUserProfileRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: { uploadDir: string },
): void {
  const { uploadDir } = options;

  app.get("/api/auth/profile", async (request) => {
    const userId = await requireCurrentUser(request, database);
    return { data: await readUserProfile(database, userId) };
  });

  app.put("/api/auth/profile", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const parsed = profileUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw profileValidationError(parsed.error);

    const now = new Date().toISOString();
    const result = await database.prepare(`
      UPDATE users
      SET display_name = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(parsed.data.displayName, now, userId);
    if (!result.changes) throw new AuthenticationError("用户不存在或已停用");

    return { data: await readUserProfile(database, userId) };
  });

  app.post("/api/auth/profile/avatar", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    let part;
    try {
      part = await request.file();
    } catch {
      throw new AuthenticationError("头像不能超过 5MB", "PROFILE_AVATAR_TOO_LARGE", 413);
    }
    if (!part) throw new AuthenticationError("请选择头像图片", "PROFILE_AVATAR_REQUIRED", 400);
    if (!/^image\/(jpeg|png|webp|heic|heif)$/iu.test(part.mimetype)) {
      throw new AuthenticationError("仅支持 JPEG、PNG、WebP 或 HEIC 图片", "PROFILE_AVATAR_TYPE_INVALID", 415);
    }

    let source: Buffer;
    try {
      source = await part.toBuffer();
    } catch {
      throw new AuthenticationError("头像不能超过 5MB", "PROFILE_AVATAR_TOO_LARGE", 413);
    }

    const profile = await saveUserAvatar(database, uploadDir, userId, source);
    return reply.send({ data: profile });
  });

  app.post("/api/auth/profile/sync", async (request) => {
    const userId = await requireCurrentUser(request, database);
    const parsed = profileSyncSchema.safeParse(request.body);
    if (!parsed.success) throw profileValidationError(parsed.error);
    return {
      data: await applyUserProfile(database, uploadDir, userId, parsed.data),
    };
  });

  app.get<{ Params: { userId: string } }>("/api/user-avatars/:userId", async (request, reply) => {
    const userId = assertUserId(request.params.userId);
    const filePath = avatarStoragePath(uploadDir, userId);
    if (!(await avatarFileExists(uploadDir, userId))) {
      return avatarNotFound(reply);
    }
    reply.header("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
    reply.type("image/jpeg");
    return reply.send(createReadStream(filePath));
  });
}

function avatarNotFound(reply: FastifyReply) {
  return reply.status(404).send({
    error: { code: "USER_AVATAR_NOT_FOUND", message: "未找到用户头像" },
  });
}
