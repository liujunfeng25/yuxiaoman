import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;

export type BackofficeRole =
  | "platform_admin"
  | "wash_store_admin"
  | "inspection_station_admin"
  | "repair_shop_admin";
export type BackofficeSubjectType = "wash_store" | "inspection_station" | "repair_shop";
export type BackofficeCapability =
  | "admin.all"
  | "backoffice.accounts.manage"
  | "audit.all.read"
  | "audit.self.read"
  | "customers.read"
  | "customers.notes.write"
  | "customers.sensitive.read"
  | "wash.dashboard.read"
  | "wash.orders.read"
  | "wash.orders.redeem"
  | "wash.slots.read"
  | "wash.slots.write"
  | "wash.store.read"
  | "wash.store.write"
  | "wash.offers.read"
  | "wash.offers.write"
  | "wash.settlements.read"
  | "inspection.workbench.read"
  | "inspection.bookings.read"
  | "inspection.bookings.write"
  | "inspection.slots.write"
  | "inspection.reports.read"
  | "inspection.reports.write"
  | "repair.requests.read"
  | "repair.quotes.read"
  | "repair.quotes.write"
  | "repair.authorized_details.read"
  | "workflow.tasks.read"
  | "workflow.tasks.remind"
  | "workflow.settings.manage";

export type BackofficeSubject = {
  type: BackofficeSubjectType;
  id: string;
  name: string;
};

export type BackofficeSession = {
  sessionId: string | null;
  permissionVersion: number;
  account: {
    id: string;
    loginName: string;
    displayName: string;
    role: BackofficeRole;
  };
  subject: BackofficeSubject | null;
  capabilities: BackofficeCapability[];
  expiresAt: string;
};

declare module "fastify" {
  interface FastifyRequest {
    backoffice: BackofficeSession | null;
    backofficeDeniedAudited?: boolean;
  }
}

const PLATFORM_CAPABILITIES: BackofficeCapability[] = [
  "admin.all",
  "backoffice.accounts.manage",
  "audit.all.read",
  "customers.read",
  "customers.notes.write",
  "customers.sensitive.read",
  "wash.dashboard.read",
  "wash.orders.read",
  "wash.orders.redeem",
  "wash.slots.read",
  "wash.slots.write",
  "wash.store.read",
  "wash.store.write",
  "wash.offers.read",
  "wash.offers.write",
  "wash.settlements.read",
  "inspection.workbench.read",
  "inspection.bookings.read",
  "inspection.bookings.write",
  "inspection.slots.write",
  "inspection.reports.read",
  "inspection.reports.write",
  "repair.requests.read",
  "repair.quotes.read",
  "repair.quotes.write",
  "repair.authorized_details.read",
  "workflow.tasks.read",
  "workflow.tasks.remind",
  "workflow.settings.manage",
];

export const WASH_STORE_CAPABILITIES: BackofficeCapability[] = [
  "wash.dashboard.read",
  "wash.orders.read",
  "wash.orders.redeem",
  "wash.slots.read",
  "wash.slots.write",
  "wash.store.read",
  "wash.store.write",
  "wash.offers.read",
  "wash.offers.write",
  "wash.settlements.read",
  "audit.self.read",
];

export const INSPECTION_STATION_CAPABILITIES: BackofficeCapability[] = [
  "inspection.workbench.read",
  "inspection.bookings.read",
  "inspection.bookings.write",
  "inspection.slots.write",
  "inspection.reports.read",
  "inspection.reports.write",
  "workflow.tasks.read",
  "audit.self.read",
];

export const REPAIR_SHOP_CAPABILITIES: BackofficeCapability[] = [
  "repair.requests.read",
  "repair.quotes.read",
  "repair.quotes.write",
  "repair.authorized_details.read",
  "workflow.tasks.read",
  "audit.self.read",
];

const COOKIE_NAME = "yxm_backoffice_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const INVITE_TTL_SECONDS = 24 * 60 * 60;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_FAILURE_LIMIT = 5;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$eXV4aWFvbWFuLWJvLWR1bW15LXNhbHQ$wkHBahKJCZrB4p-d8ZAHvTz2V-iUfLROHSro2sncxmNzZpCGIsRc__AqZIC4TGgaC4IZTw61D0H3huAF1L4v_Q";
const SAFE_ORIGIN_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const loginNameSchema = z.string().trim().min(3).max(80).regex(
  /^[A-Za-z0-9._@+-]+$/u,
  "登录名只能包含字母、数字和 . _ @ + -",
);
const displayNameSchema = z.string().trim().min(2).max(80).regex(
  /^[^\u0000-\u001F\u007F]+$/u,
  "姓名不能包含控制字符",
);
const passwordSchema = z.string().min(12, "密码至少需要 12 位").max(200);
const subjectSchema = z.object({
  type: z.enum(["wash_store", "inspection_station", "repair_shop"]),
  id: z.string().trim().min(1).max(120),
});
const invitationSchema = z.object({
  loginName: loginNameSchema,
  displayName: displayNameSchema,
  role: z.enum(["platform_admin", "wash_store_admin", "inspection_station_admin", "repair_shop_admin"]),
  subject: subjectSchema.nullable().optional(),
}).superRefine((value, context) => {
  if (value.role !== "platform_admin" && !value.subject) {
    context.addIssue({ code: "custom", path: ["subject"], message: "服务主体账号必须绑定对应门店" });
  }
  if (value.role === "wash_store_admin" && value.subject?.type !== "wash_store") {
    context.addIssue({ code: "custom", path: ["subject"], message: "洗车店管理员必须绑定洗车门店" });
  }
  if (value.role === "inspection_station_admin" && value.subject?.type !== "inspection_station") {
    context.addIssue({ code: "custom", path: ["subject"], message: "检测站管理员必须绑定检测站" });
  }
  if (value.role === "repair_shop_admin" && value.subject?.type !== "repair_shop") {
    context.addIssue({ code: "custom", path: ["subject"], message: "维修门店管理员必须绑定维修门店" });
  }
  if (value.role === "platform_admin" && value.subject) {
    context.addIssue({ code: "custom", path: ["subject"], message: "平台管理员不能绑定服务商主体" });
  }
});

export class BackofficeError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "BackofficeError";
  }
}

export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
}

export function backofficeTestFallbackEnabled(): boolean {
  return process.env.NODE_ENV === "test"
    && !isProductionEnvironment()
    && process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK === "true";
}

export function backofficeDirectPasswordEnabled(): boolean {
  return !isProductionEnvironment()
    && process.env.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD === "true";
}

const invitationBodySchema = invitationSchema.extend({
  password: passwordSchema.optional(),
});

function parseInvitationBody(body: unknown): z.infer<typeof invitationBodySchema> {
  const input = parseInput(invitationBodySchema, body);
  if (input.password && !backofficeDirectPasswordEnabled()) {
    throw new BackofficeError(403, "BACKOFFICE_DIRECT_PASSWORD_FORBIDDEN", "当前环境不支持直接设置密码，请使用激活链接");
  }
  return input;
}

function parseDirectPasswordBody(body: unknown): string {
  if (!backofficeDirectPasswordEnabled()) {
    throw new BackofficeError(403, "BACKOFFICE_DIRECT_PASSWORD_FORBIDDEN", "当前环境不支持直接设置密码，请使用激活链接");
  }
  return parseInput(z.object({ password: passwordSchema }), body).password;
}

export function backofficeOriginAllowed(origin: string | undefined): boolean {
  if (!origin || !isProductionEnvironment()) return true;
  let requestedOrigin: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:") return false;
    requestedOrigin = parsed.origin;
  } catch {
    return false;
  }
  const allowed = new Set(
    (process.env.BACKOFFICE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .flatMap((value) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol === "https:" ? [parsed.origin] : [];
        } catch {
          return [];
        }
      }),
  );
  return allowed.has(requestedOrigin);
}

export async function migrateBackofficeDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS backoffice_accounts (
      id TEXT PRIMARY KEY,
      login_name TEXT NOT NULL,
      login_name_normalized TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL CHECK (
        role IN ('platform_admin', 'wash_store_admin', 'inspection_station_admin', 'repair_shop_admin')
      ),
      status TEXT NOT NULL CHECK (
        status IN ('pending_activation', 'active', 'password_reset', 'disabled')
      ),
      permission_version INTEGER NOT NULL DEFAULT 1 CHECK (permission_version > 0),
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      disabled_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS backoffice_subject_assignments (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES backoffice_accounts(id) ON DELETE RESTRICT,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('wash_store', 'inspection_station', 'repair_shop')),
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
      replaces_assignment_id TEXT REFERENCES backoffice_subject_assignments(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL,
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS backoffice_assignment_account_current_unique
      ON backoffice_subject_assignments(account_id)
      WHERE status IN ('pending', 'active');
    CREATE UNIQUE INDEX IF NOT EXISTS backoffice_assignment_subject_active_unique
      ON backoffice_subject_assignments(subject_type, subject_id)
      WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS backoffice_assignment_subject_pending_unique
      ON backoffice_subject_assignments(subject_type, subject_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS backoffice_assignment_subject_index
      ON backoffice_subject_assignments(subject_type, subject_id, status);

    CREATE TABLE IF NOT EXISTS backoffice_invites (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES backoffice_accounts(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('activation', 'password_reset')),
      token_hash TEXT NOT NULL UNIQUE,
      created_by_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      invalidated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS backoffice_invites_account_index
      ON backoffice_invites(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS backoffice_invites_active_token_index
      ON backoffice_invites(token_hash, expires_at)
      WHERE consumed_at IS NULL AND invalidated_at IS NULL;

    CREATE TABLE IF NOT EXISTS backoffice_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES backoffice_accounts(id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL UNIQUE,
      permission_version INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS backoffice_sessions_account_index
      ON backoffice_sessions(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS backoffice_sessions_active_token_index
      ON backoffice_sessions(token_hash, expires_at)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS backoffice_login_attempts (
      id TEXT PRIMARY KEY,
      login_name_normalized TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      succeeded BOOLEAN NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS backoffice_login_attempts_window_index
      ON backoffice_login_attempts(login_name_normalized, ip_hash, attempted_at DESC);

    CREATE TABLE IF NOT EXISTS backoffice_redemption_attempts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES backoffice_accounts(id) ON DELETE CASCADE,
      store_id TEXT NOT NULL REFERENCES wash_stores(id) ON DELETE CASCADE,
      ip_hash TEXT NOT NULL,
      succeeded BOOLEAN NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS backoffice_redemption_attempts_window_index
      ON backoffice_redemption_attempts(store_id, account_id, ip_hash, attempted_at DESC);

    CREATE TABLE IF NOT EXISTS backoffice_audit_events (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      actor_login_name TEXT,
      actor_display_name TEXT,
      actor_role TEXT,
      subject_type TEXT,
      subject_id TEXT,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
      resource_type TEXT,
      resource_id TEXT,
      request_id TEXT,
      before_json JSONB,
      after_json JSONB,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS backoffice_audit_occurred_index
      ON backoffice_audit_events(occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS backoffice_audit_account_index
      ON backoffice_audit_events(account_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS backoffice_audit_subject_index
      ON backoffice_audit_events(subject_type, subject_id, occurred_at DESC);

    CREATE OR REPLACE FUNCTION reject_backoffice_audit_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'backoffice_audit_events is append-only';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS backoffice_audit_events_immutable ON backoffice_audit_events;
    CREATE TRIGGER backoffice_audit_events_immutable
      BEFORE UPDATE OR DELETE ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_backoffice_audit_mutation();

    DROP TRIGGER IF EXISTS backoffice_audit_events_no_truncate ON backoffice_audit_events;
    CREATE TRIGGER backoffice_audit_events_no_truncate
      BEFORE TRUNCATE ON backoffice_audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION reject_backoffice_audit_mutation();

    -- These tables may predate the inspection-station role. Rebuild only the
    -- enum-like checks so the additive migration is repeatable on an existing
    -- PostgreSQL database without rewriting accounts or assignments.
    ALTER TABLE backoffice_accounts
      DROP CONSTRAINT IF EXISTS backoffice_accounts_role_check;
    ALTER TABLE backoffice_accounts
      ADD CONSTRAINT backoffice_accounts_role_check
      CHECK (role IN ('platform_admin', 'wash_store_admin', 'inspection_station_admin', 'repair_shop_admin'));
    ALTER TABLE backoffice_subject_assignments
      DROP CONSTRAINT IF EXISTS backoffice_subject_assignments_subject_type_check;
    ALTER TABLE backoffice_subject_assignments
      ADD CONSTRAINT backoffice_subject_assignments_subject_type_check
      CHECK (subject_type IN ('wash_store', 'inspection_station', 'repair_shop'));
  `);
}

function normalizeLoginName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function addSeconds(value: Date, seconds: number): string {
  return new Date(value.getTime() + seconds * 1_000).toISOString();
}

function parseCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseBackofficeBearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = authorization.match(/^Bearer\s+(yxm_bo_[A-Za-z0-9_-]+)$/u);
  return match?.[1];
}

function presentedBackofficeToken(request: FastifyRequest): string | undefined {
  return parseCookie(request, COOKIE_NAME) ?? parseBackofficeBearer(request);
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = isProductionEnvironment() ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie(): string {
  const secure = isProductionEnvironment() ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (error, result) => error ? reject(error) : resolve(result as Buffer),
    );
  });
}

export async function hashBackofficePassword(password: string): Promise<string> {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) {
    throw new BackofficeError(400, "BACKOFFICE_PASSWORD_INVALID", "密码至少需要 12 位", {
      password: parsed.error.issues[0]?.message ?? "密码不符合要求",
    });
  }
  const salt = randomBytes(16);
  const derived = await derivePassword(parsed.data, salt);
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

async function verifyBackofficePassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded) return false;
  const [algorithm, cost, blockSize, parallelization, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const numericCost = Number(cost);
  const numericBlockSize = Number(blockSize);
  const numericParallelization = Number(parallelization);
  if (
    numericCost !== SCRYPT_COST
    || numericBlockSize !== SCRYPT_BLOCK_SIZE
    || numericParallelization !== SCRYPT_PARALLELIZATION
  ) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = await derivePassword(password, Buffer.from(saltValue, "base64url"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function capabilitiesForRole(role: BackofficeRole): BackofficeCapability[] {
  if (role === "platform_admin") return [...PLATFORM_CAPABILITIES];
  if (role === "inspection_station_admin") return [...INSPECTION_STATION_CAPABILITIES];
  if (role === "repair_shop_admin") return [...REPAIR_SHOP_CAPABILITIES];
  return [...WASH_STORE_CAPABILITIES];
}

function testPrincipal(): BackofficeSession {
  return {
    sessionId: null,
    permissionVersion: 1,
    account: {
      id: "backoffice-test-platform-admin",
      loginName: "test-platform-admin",
      displayName: "自动化测试平台管理员",
      role: "platform_admin",
    },
    subject: null,
    capabilities: capabilitiesForRole("platform_admin"),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

function publicSession(principal: BackofficeSession) {
  return {
    account: {
      id: principal.account.id,
      displayName: principal.account.displayName,
      role: principal.account.role,
    },
    subject: principal.subject,
    capabilities: principal.capabilities,
    expiresAt: principal.expiresAt,
  };
}

function publicBearerSession(issued: IssuedSession) {
  return {
    token: issued.token,
    ...publicOperatorSession(issued.principal),
  };
}

function publicOperatorSession(principal: BackofficeSession) {
  return {
    ...publicSession(principal),
    account: {
      id: principal.account.id,
      loginName: principal.account.loginName,
      displayName: principal.account.displayName,
      role: principal.account.role,
    },
  };
}

function principalFromRow(row: Row): BackofficeSession {
  const role = String(row.role) as BackofficeRole;
  const subject = row.subject_id
    ? {
        type: String(row.subject_type) as BackofficeSubjectType,
        id: String(row.subject_id),
        name: String(row.subject_name ?? row.subject_id),
      }
    : null;
  return {
    sessionId: String(row.session_id),
    permissionVersion: Number(row.permission_version),
    account: {
      id: String(row.account_id),
      loginName: String(row.login_name),
      displayName: String(row.display_name),
      role,
    },
    subject,
    capabilities: capabilitiesForRole(role),
    expiresAt: iso(row.expires_at),
  };
}

async function resolveBackofficeToken(
  request: FastifyRequest,
  database: AppDatabase,
  token: string,
): Promise<BackofficeSession | null> {
  const now = new Date().toISOString();
  const row = await database.prepare<Row>(`
    SELECT s.id AS session_id, s.expires_at, a.id AS account_id, a.login_name,
      a.display_name, a.role, a.permission_version,
      sa.subject_type, sa.subject_id, COALESCE(ws.name, ist.name, rs.name) AS subject_name
    FROM backoffice_sessions s
    JOIN backoffice_accounts a ON a.id = s.account_id
    LEFT JOIN backoffice_subject_assignments sa
      ON sa.account_id = a.id AND sa.status = 'active'
    LEFT JOIN wash_stores ws
      ON sa.subject_type = 'wash_store' AND ws.id = sa.subject_id
    LEFT JOIN stations ist
      ON sa.subject_type = 'inspection_station' AND ist.id = sa.subject_id
    LEFT JOIN repair_shops rs
      ON sa.subject_type = 'repair_shop' AND rs.id = sa.subject_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?::timestamptz
      AND s.permission_version = a.permission_version
      AND a.status = 'active'
      -- A scoped session is valid only while both its active assignment and
      -- the assigned tenant resource still exist.
      AND (
        a.role = 'platform_admin'
        OR (a.role = 'wash_store_admin' AND ws.id IS NOT NULL)
        OR (a.role = 'inspection_station_admin' AND ist.id IS NOT NULL)
        OR (a.role = 'repair_shop_admin' AND rs.id IS NOT NULL AND rs.is_active = 1)
      )
    LIMIT 1
  `).get(sha256(token), now);
  if (!row) return null;
  const principal = principalFromRow(row);
  request.backoffice = principal;
  await database.prepare(`
    UPDATE backoffice_sessions
    SET last_seen_at = ?::timestamptz
    WHERE id = ?
      AND (last_seen_at IS NULL OR last_seen_at < (?::timestamptz - INTERVAL '5 minutes'))
  `).run(now, principal.sessionId, now);
  return principal;
}

export async function resolveBackoffice(
  request: FastifyRequest,
  database: AppDatabase,
  options: { allowTestFallback?: boolean } = {},
): Promise<BackofficeSession | null> {
  if (request.backoffice) return request.backoffice;
  // Desktop cookies intentionally win if both credentials are presented.
  // Native station clients use the same revocable session rows through a
  // Bearer token and never receive a second, weaker identity model.
  const token = presentedBackofficeToken(request);
  if (!token) {
    if (options.allowTestFallback) return testPrincipal();
    return null;
  }
  return resolveBackofficeToken(request, database, token);
}

export async function requireBackoffice(
  request: FastifyRequest,
  database: AppDatabase,
  options: { allowTestFallback?: boolean } = {},
): Promise<BackofficeSession> {
  const principal = await resolveBackoffice(request, database, options);
  if (!principal) {
    throw new BackofficeError(401, "BACKOFFICE_AUTHENTICATION_REQUIRED", "需要有效的后台账号会话");
  }
  request.backoffice = principal;
  return principal;
}

async function requireInspectionStationBearer(
  request: FastifyRequest,
  database: AppDatabase,
): Promise<{ token: string; principal: BackofficeSession }> {
  const token = parseBackofficeBearer(request);
  if (!token) {
    throw new BackofficeError(401, "OPERATOR_AUTHENTICATION_REQUIRED", "需要有效的检测站账号会话");
  }
  const principal = await resolveBackofficeToken(request, database, token);
  if (!principal) {
    throw new BackofficeError(401, "OPERATOR_AUTHENTICATION_REQUIRED", "检测站账号会话无效或已过期");
  }
  if (principal.account.role !== "inspection_station_admin" || principal.subject?.type !== "inspection_station") {
    throw new BackofficeError(403, "OPERATOR_ACCOUNT_REQUIRED", "仅检测站管理员可以访问检测站端");
  }
  return { token, principal };
}

/**
 * Resolve the native inspection-station Bearer when one is presented on a
 * private resource that does not live below `/api/operator/*`.
 *
 * An absent station Bearer is intentionally different from an invalid one:
 * callers may fall back to their owner authentication path only when the
 * request did not present a `yxm_bo_` credential at all.
 */
export async function resolveInspectionStationBearer(
  request: FastifyRequest,
  database: AppDatabase,
): Promise<BackofficeSession | null> {
  if (!parseBackofficeBearer(request)) return null;
  return (await requireInspectionStationBearer(request, database)).principal;
}

/**
 * Authenticate the native repair-shop surface with a revocable backoffice
 * Bearer. Browser cookies and every other backoffice role are deliberately
 * rejected so a platform or station session cannot be reused as shop authority.
 */
export async function requireRepairShopBearer(
  request: FastifyRequest,
  database: AppDatabase,
): Promise<BackofficeSession> {
  const token = parseBackofficeBearer(request);
  if (!token) {
    throw new BackofficeError(401, "REPAIR_OPERATOR_AUTHENTICATION_REQUIRED", "需要有效的维修门店账号会话");
  }
  const principal = await resolveBackofficeToken(request, database, token);
  if (!principal) {
    throw new BackofficeError(401, "REPAIR_OPERATOR_AUTHENTICATION_REQUIRED", "维修门店账号会话无效或已过期");
  }
  if (principal.account.role !== "repair_shop_admin" || principal.subject?.type !== "repair_shop") {
    throw new BackofficeError(403, "REPAIR_OPERATOR_ACCOUNT_REQUIRED", "仅维修门店管理员可以访问维修门店端");
  }
  return principal;
}

export function hasCapability(principal: BackofficeSession, capability: BackofficeCapability): boolean {
  return principal.account.role === "platform_admin" || principal.capabilities.includes(capability);
}

export function assertCapability(
  principal: BackofficeSession,
  capability: BackofficeCapability,
): BackofficeSession {
  if (!hasCapability(principal, capability)) {
    throw new BackofficeError(403, "BACKOFFICE_FORBIDDEN", "当前账号无权执行此操作");
  }
  return principal;
}

export async function requireCapability(
  request: FastifyRequest,
  database: AppDatabase,
  capability: BackofficeCapability,
): Promise<BackofficeSession> {
  return assertCapability(await requireBackoffice(request, database), capability);
}

export function backofficeForRequest(request: FastifyRequest): BackofficeSession {
  if (!request.backoffice) {
    throw new BackofficeError(401, "BACKOFFICE_AUTHENTICATION_REQUIRED", "需要有效的后台账号会话");
  }
  return request.backoffice;
}

export function assertSubjectResource(
  principal: BackofficeSession,
  subjectType: BackofficeSubjectType,
  subjectId: string,
): void {
  if (principal.account.role === "platform_admin") return;
  if (principal.subject?.type !== subjectType || principal.subject.id !== subjectId) {
    throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
  }
}

export function scopedWashStoreId(
  principal: BackofficeSession,
  requestedStoreId?: string | null,
): string | undefined {
  if (principal.account.role === "platform_admin") return requestedStoreId?.trim() || undefined;
  if (principal.subject?.type !== "wash_store") {
    throw new BackofficeError(403, "BACKOFFICE_SUBJECT_REQUIRED", "当前账号未绑定洗车门店");
  }
  if (requestedStoreId && requestedStoreId !== principal.subject.id) {
    throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
  }
  return principal.subject.id;
}

export function scopedInspectionStationId(
  principal: BackofficeSession,
  requestedStationId?: string | null,
): string | undefined {
  if (principal.account.role === "platform_admin") return requestedStationId?.trim() || undefined;
  if (principal.subject?.type !== "inspection_station") {
    throw new BackofficeError(403, "BACKOFFICE_SUBJECT_REQUIRED", "当前账号未绑定检测站");
  }
  if (requestedStationId && requestedStationId !== principal.subject.id) {
    throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
  }
  return principal.subject.id;
}

export function scopedRepairShopId(
  principal: BackofficeSession,
  requestedShopId?: string | null,
): string | undefined {
  if (principal.account.role === "platform_admin") return requestedShopId?.trim() || undefined;
  if (principal.subject?.type !== "repair_shop") {
    throw new BackofficeError(403, "BACKOFFICE_SUBJECT_REQUIRED", "当前账号未绑定维修门店");
  }
  if (requestedShopId && requestedShopId !== principal.subject.id) {
    throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
  }
  return principal.subject.id;
}

const sensitiveAuditKey = /(?:password|passphrase|credential|authorization|cookie|sessiontoken|sessionhash|token|invite|secret|openid|unionid|providersubject|storagekey|sha256|hmac|cipher|encrypted|phone|mobile|contact|address|latitude|longitude|poi|pickup|redemption|locationproof)/iu;
const omittedAuditKey = /(?:^note$|internalnote|drivernote|notesprovided|comment|remark)/iu;
const sensitiveAuditString = /(?:yxm_bo_|yxm_activate_|(?:\+?86[- ]?)?1[3-9]\d{9})/iu;
const auditPlatePattern = /([京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z])[·\s-]?([A-HJ-NP-Z0-9]{5,6})/gu;

function maskAuditPlates(value: string): string {
  return value.replace(auditPlatePattern, (_match, prefix: string, suffix: string) => `${prefix}***${suffix.slice(-1)}`);
}

function sanitizeAuditValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return sensitiveAuditString.test(value) ? "[redacted]" : maskAuditPlates(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return "[binary]";
  if (depth >= 6) return "[truncated]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeAuditValue(item, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/gu, "");
    if (omittedAuditKey.test(normalizedKey)) continue;
    result[key] = sensitiveAuditKey.test(normalizedKey)
      ? "[redacted]"
      : sanitizeAuditValue(item, depth + 1, seen);
  }
  return result;
}

function jsonForAudit(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const serialized = JSON.stringify(sanitizeAuditValue(value));
  if (serialized.length <= 16_000) return serialized;
  return JSON.stringify({ truncated: true, preview: serialized.slice(0, 15_900) });
}

export type BackofficeAuditInput = {
  request?: FastifyRequest;
  principal?: BackofficeSession | null;
  action: string;
  outcome: "success" | "denied" | "failure";
  subject?: BackofficeSubject | null;
  resource?: { type: string; id?: string | null };
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  presentation?: BackofficeAuditPresentation;
  occurredAt?: string;
};

export type BackofficeAuditCategory =
  | "account_security"
  | "customer"
  | "inspection"
  | "wash"
  | "repair"
  | "car_rental"
  | "insurance"
  | "driving_school"
  | "subsidy";

export type BackofficeAuditDisplayChange = {
  field?: string;
  label: string;
  before?: unknown;
  after?: unknown;
};

export type BackofficeAuditPresentation = {
  category?: BackofficeAuditCategory;
  actionLabel?: string;
  summary?: string;
  subjectName?: string | null;
  resourceLabel?: string | null;
  changes?: BackofficeAuditDisplayChange[];
  reason?: string | null;
};

export async function auditBackofficeEvent(
  database: AppDatabase,
  input: BackofficeAuditInput,
): Promise<string> {
  const principal = input.principal ?? input.request?.backoffice ?? null;
  const subject = input.subject === undefined ? principal?.subject ?? null : input.subject;
  const id = randomUUID();
  const embeddedPresentation = input.metadata?.presentation
    && typeof input.metadata.presentation === "object"
    && !Array.isArray(input.metadata.presentation)
    ? input.metadata.presentation as BackofficeAuditPresentation
    : undefined;
  const requestedPresentation = input.presentation ?? embeddedPresentation;
  const definition = AUDIT_ACTION_DEFINITIONS[input.action];
  const presentation = requestedPresentation || subject?.name || definition
    ? {
        ...(requestedPresentation ?? {}),
        ...(definition ? { category: definition.category, actionLabel: definition.label } : {}),
        ...(subject?.name && requestedPresentation?.subjectName == null ? { subjectName: subject.name } : {}),
      }
    : undefined;
  const metadata = {
    ...(input.metadata ?? {}),
    ...(presentation ? { presentation } : {}),
  };
  await database.prepare(`
    INSERT INTO backoffice_audit_events (
      id, account_id, actor_login_name, actor_display_name, actor_role,
      subject_type, subject_id, action, outcome, resource_type, resource_id,
      request_id, before_json, after_json, metadata_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::timestamptz)
  `).run(
    id,
    principal?.account.id ?? null,
    principal?.account.loginName ?? null,
    principal?.account.displayName ?? null,
    principal?.account.role ?? null,
    subject?.type ?? null,
    subject?.id ?? null,
    input.action,
    input.outcome,
    input.resource?.type ?? null,
    input.resource?.id ?? null,
    input.request?.id ?? null,
    jsonForAudit(input.before),
    jsonForAudit(input.after),
    jsonForAudit(metadata) ?? "{}",
    input.occurredAt ?? new Date().toISOString(),
  );
  return id;
}

function validationError(error: z.ZodError): BackofficeError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    if (!fields[key]) fields[key] = issue.message;
  }
  return new BackofficeError(400, "BACKOFFICE_VALIDATION_ERROR", "提交的信息有误，请检查后重试", fields);
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

function requestIpHash(request: FastifyRequest): string {
  // Fastify resolves request.ip from the socket (or from a configured trusted proxy).
  // Never trust X-Forwarded-For directly: clients can forge it and bypass the IP bucket.
  const value = request.ip || "unknown";
  return sha256(`${process.env.BACKOFFICE_AUDIT_IP_SALT ?? "yuxiaoman-backoffice-ip"}:${value}`);
}

async function lockLoginBuckets(
  database: AppDatabase,
  loginNameNormalized: string,
  ipHash: string,
): Promise<void> {
  const buckets = [
    `backoffice-login-ip:${ipHash}`,
    `backoffice-login-name:${loginNameNormalized}`,
  ].sort();
  for (const bucket of buckets) {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(bucket);
  }
}

async function assertLoginNotLimited(
  database: AppDatabase,
  loginNameNormalized: string,
  ipHash: string,
): Promise<void> {
  const row = await database.prepare<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM backoffice_login_attempts
    WHERE succeeded = FALSE
      AND attempted_at > NOW() - INTERVAL '${LOGIN_WINDOW_MINUTES} minutes'
      AND (login_name_normalized = ? OR ip_hash = ?)
  `).get(loginNameNormalized, ipHash);
  if (Number(row?.count ?? 0) >= LOGIN_FAILURE_LIMIT) {
    throw new BackofficeError(429, "BACKOFFICE_LOGIN_RATE_LIMITED", "登录尝试过多，请稍后再试");
  }
}

async function recordLoginAttempt(
  database: AppDatabase,
  loginNameNormalized: string,
  ipHash: string,
  succeeded: boolean,
  now: string,
): Promise<void> {
  await database.prepare(`
    INSERT INTO backoffice_login_attempts (
      id, login_name_normalized, ip_hash, succeeded, attempted_at
    ) VALUES (?, ?, ?, ?, ?::timestamptz)
  `).run(randomUUID(), loginNameNormalized, ipHash, succeeded, now);
}

async function clearFailedLoginAttempts(
  database: AppDatabase,
  loginNameNormalized: string,
): Promise<void> {
  await database.prepare(`
    DELETE FROM backoffice_login_attempts
    WHERE succeeded = FALSE AND login_name_normalized = ?
  `).run(loginNameNormalized);
}

type IssuedSession = { token: string; principal: BackofficeSession };

async function issueBackofficeSession(
  database: AppDatabase,
  accountId: string,
  now = new Date(),
): Promise<IssuedSession> {
  const account = await database.prepare<Row>(`
    SELECT a.id AS account_id, a.login_name, a.display_name, a.role, a.permission_version,
      sa.subject_type, sa.subject_id, COALESCE(ws.name, ist.name, rs.name) AS subject_name
    FROM backoffice_accounts a
    LEFT JOIN backoffice_subject_assignments sa
      ON sa.account_id = a.id AND sa.status = 'active'
    LEFT JOIN wash_stores ws
      ON sa.subject_type = 'wash_store' AND ws.id = sa.subject_id
    LEFT JOIN stations ist
      ON sa.subject_type = 'inspection_station' AND ist.id = sa.subject_id
    LEFT JOIN repair_shops rs
      ON sa.subject_type = 'repair_shop' AND rs.id = sa.subject_id
    WHERE a.id = ? AND a.status = 'active'
      AND (
        a.role = 'platform_admin'
        OR (a.role = 'wash_store_admin' AND ws.id IS NOT NULL)
        OR (a.role = 'inspection_station_admin' AND ist.id IS NOT NULL)
        OR (a.role = 'repair_shop_admin' AND rs.id IS NOT NULL AND rs.is_active = 1)
      )
    LIMIT 1
  `).get(accountId);
  if (!account) {
    throw new BackofficeError(401, "BACKOFFICE_ACCOUNT_UNAVAILABLE", "后台账号不存在、未激活或已停用");
  }
  const token = `yxm_bo_${randomBytes(32).toString("base64url")}`;
  const sessionId = randomUUID();
  const createdAt = now.toISOString();
  const expiresAt = addSeconds(now, SESSION_TTL_SECONDS);
  await database.prepare(`
    INSERT INTO backoffice_sessions (
      id, account_id, token_hash, permission_version, expires_at,
      revoked_at, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, ?::timestamptz, NULL, ?::timestamptz, ?::timestamptz)
  `).run(
    sessionId,
    accountId,
    sha256(token),
    Number(account.permission_version),
    expiresAt,
    createdAt,
    createdAt,
  );
  return {
    token,
    principal: principalFromRow({
      ...account,
      session_id: sessionId,
      expires_at: expiresAt,
    }),
  };
}

async function authenticateBackofficeAccount(
  database: AppDatabase,
  request: FastifyRequest,
  credentials: { loginName: string; password: string },
  options: {
    requiredRole?: BackofficeRole;
    requiredRoleError?: { code: string; message: string };
  } = {},
): Promise<IssuedSession> {
  const loginNameNormalized = normalizeLoginName(credentials.loginName);
  const ipHash = requestIpHash(request);
  const now = new Date();
  const result = await database.transaction(async (tx): Promise<{
    issued?: IssuedSession;
    error?: BackofficeError;
  }> => {
    await lockLoginBuckets(tx, loginNameNormalized, ipHash);
    try {
      await assertLoginNotLimited(tx, loginNameNormalized, ipHash);
    } catch (error) {
      if (!(error instanceof BackofficeError)) throw error;
      await auditBackofficeEvent(tx, {
        request,
        action: "backoffice.session.login",
        outcome: "denied",
        metadata: { loginName: loginNameNormalized, reason: error.code },
      });
      return { error };
    }

    const account = await tx.prepare<Row>(`
      SELECT id, login_name, display_name, password_hash, role, status
      FROM backoffice_accounts WHERE login_name_normalized = ?
      FOR UPDATE
    `).get(loginNameNormalized);
    const passwordHash = account?.password_hash ? String(account.password_hash) : DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyBackofficePassword(credentials.password, passwordHash);
    const credentialsValid = Boolean(account && String(account.status) === "active" && passwordMatches);
    await recordLoginAttempt(tx, loginNameNormalized, ipHash, credentialsValid, now.toISOString());
    if (!credentialsValid || !account) {
      await auditBackofficeEvent(tx, {
        request,
        action: "backoffice.session.login",
        outcome: "denied",
        resource: account ? { type: "backoffice_account", id: String(account.id) } : undefined,
        metadata: { loginName: loginNameNormalized, reason: "invalid_credentials" },
      });
      return {
        error: new BackofficeError(401, "BACKOFFICE_INVALID_CREDENTIALS", "登录名或密码错误"),
      };
    }

    if (options.requiredRole && String(account.role) !== options.requiredRole) {
      const roleError = options.requiredRoleError ?? {
        code: "OPERATOR_ACCOUNT_REQUIRED",
        message: "仅检测站管理员可以登录检测站端",
      };
      await clearFailedLoginAttempts(tx, loginNameNormalized);
      await auditBackofficeEvent(tx, {
        request,
        action: "backoffice.session.login",
        outcome: "denied",
        resource: { type: "backoffice_account", id: String(account.id) },
        metadata: { loginName: loginNameNormalized, reason: roleError.code },
      });
      return {
        error: new BackofficeError(403, roleError.code, roleError.message),
      };
    }

    await clearFailedLoginAttempts(tx, loginNameNormalized);
    await tx.prepare(`
      UPDATE backoffice_accounts SET last_login_at = ?::timestamptz, updated_at = ?::timestamptz
      WHERE id = ? AND status = 'active'
    `).run(now.toISOString(), now.toISOString(), String(account.id));
    const session = await issueBackofficeSession(tx, String(account.id), now);
    await auditBackofficeEvent(tx, {
      request,
      principal: session.principal,
      action: "backoffice.session.login",
      outcome: "success",
      resource: { type: "backoffice_session", id: session.principal.sessionId },
    });
    return { issued: session };
  });
  if (result.error) throw result.error;
  if (!result.issued) throw new Error("Backoffice login transaction returned no result");
  return result.issued;
}

async function revokeAccountSessions(
  database: AppDatabase,
  accountId: string,
  now: string,
  exceptSessionId?: string | null,
): Promise<number> {
  const result = exceptSessionId
    ? await database.prepare(`
        UPDATE backoffice_sessions SET revoked_at = ?::timestamptz
        WHERE account_id = ? AND revoked_at IS NULL AND id <> ?
      `).run(now, accountId, exceptSessionId)
    : await database.prepare(`
        UPDATE backoffice_sessions SET revoked_at = ?::timestamptz
        WHERE account_id = ? AND revoked_at IS NULL
      `).run(now, accountId);
  return result.changes;
}

function invitationUrl(token: string): string {
  const base = process.env.BACKOFFICE_ACTIVATION_BASE_URL?.trim() || "/activate";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}token=${encodeURIComponent(token)}`;
}

async function issueInvite(
  database: AppDatabase,
  accountId: string,
  kind: "activation" | "password_reset",
  createdByAccountId: string | null,
  now = new Date(),
): Promise<{ token: string; url: string; expiresAt: string }> {
  const token = `yxm_activate_${randomBytes(32).toString("base64url")}`;
  const createdAt = now.toISOString();
  const expiresAt = addSeconds(now, INVITE_TTL_SECONDS);
  await database.prepare(`
    UPDATE backoffice_invites SET invalidated_at = ?::timestamptz
    WHERE account_id = ? AND kind = ?
      AND consumed_at IS NULL AND invalidated_at IS NULL
  `).run(createdAt, accountId, kind);
  await database.prepare(`
    INSERT INTO backoffice_invites (
      id, account_id, kind, token_hash, created_by_account_id,
      expires_at, consumed_at, invalidated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?::timestamptz, NULL, NULL, ?::timestamptz)
  `).run(
    randomUUID(),
    accountId,
    kind,
    sha256(token),
    createdByAccountId,
    expiresAt,
    createdAt,
  );
  return { token, url: invitationUrl(token), expiresAt };
}

function accountDto(row: Row) {
  const subject = row.subject_id
    ? {
        type: String(row.subject_type),
        id: String(row.subject_id),
        name: String(row.subject_name ?? row.subject_id),
        assignmentStatus: String(row.assignment_status),
      }
    : null;
  return {
    id: String(row.id),
    loginName: String(row.login_name),
    displayName: String(row.display_name),
    role: String(row.role),
    status: String(row.status),
    subject,
    lastLoginAt: row.last_login_at ? iso(row.last_login_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const accountSelectSql = `
  SELECT a.*,
    assignment.subject_type, assignment.subject_id,
    assignment.status AS assignment_status,
    COALESCE(ws.name, ist.name, rs.name) AS subject_name
  FROM backoffice_accounts a
  LEFT JOIN LATERAL (
    SELECT sa.subject_type, sa.subject_id, sa.status, sa.created_at
    FROM backoffice_subject_assignments sa
    WHERE sa.account_id = a.id AND sa.status IN ('active', 'pending')
    ORDER BY CASE WHEN sa.status = 'active' THEN 0 ELSE 1 END, sa.created_at DESC
    LIMIT 1
  ) assignment ON TRUE
  LEFT JOIN wash_stores ws
    ON assignment.subject_type = 'wash_store' AND ws.id = assignment.subject_id
  LEFT JOIN stations ist
    ON assignment.subject_type = 'inspection_station' AND ist.id = assignment.subject_id
  LEFT JOIN repair_shops rs
    ON assignment.subject_type = 'repair_shop' AND rs.id = assignment.subject_id
`;

async function getAccount(database: AppDatabase, accountId: string): Promise<Row | undefined> {
  return database.prepare<Row>(`${accountSelectSql} WHERE a.id = ?`).get(accountId);
}

async function requireWashStore(
  database: AppDatabase,
  storeId: string,
  options: { lock?: boolean } = {},
): Promise<Row> {
  const store = await database.prepare<Row>(`
    SELECT id, name, is_active FROM wash_stores WHERE id = ?${options.lock ? " FOR UPDATE" : ""}
  `).get(storeId);
  if (!store) throw new BackofficeError(404, "WASH_STORE_NOT_FOUND", "未找到该洗车门店");
  return store;
}

async function requireInspectionStation(
  database: AppDatabase,
  stationId: string,
  options: { lock?: boolean } = {},
): Promise<Row> {
  const station = await database.prepare<Row>(`
    SELECT id, name, is_active FROM stations WHERE id = ?${options.lock ? " FOR UPDATE" : ""}
  `).get(stationId);
  if (!station) throw new BackofficeError(404, "INSPECTION_STATION_NOT_FOUND", "未找到该检测站");
  return station;
}

async function requireRepairShop(
  database: AppDatabase,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<Row> {
  const shop = await database.prepare<Row>(`
    SELECT id, name, is_demo, is_active FROM repair_shops WHERE id = ?${options.lock ? " FOR UPDATE" : ""}
  `).get(shopId);
  if (!shop) throw new BackofficeError(404, "REPAIR_SHOP_NOT_FOUND", "未找到该维修门店");
  if (Number(shop.is_active) !== 1) {
    throw new BackofficeError(409, "REPAIR_SHOP_INACTIVE", "该维修门店已停用，不能绑定管理员");
  }
  return shop;
}

async function assertLoginNameAvailable(
  tx: AppDatabase,
  loginNameNormalized: string,
  exceptAccountId?: string,
): Promise<void> {
  const existing = await tx.prepare<Row>(`
    SELECT id FROM backoffice_accounts WHERE login_name_normalized = ?
  `).get(loginNameNormalized);
  if (existing && String(existing.id) !== exceptAccountId) {
    throw new BackofficeError(409, "BACKOFFICE_LOGIN_NAME_TAKEN", "登录名已被使用，请换一个");
  }
}

async function activateSubjectAssignmentForAccount(
  tx: AppDatabase,
  accountId: string,
  role: BackofficeRole,
  now: string,
): Promise<void> {
  if (role === "platform_admin") return;

  const pendingAssignment = await tx.prepare<Row>(`
    SELECT * FROM backoffice_subject_assignments
    WHERE account_id = ? AND status = 'pending'
    FOR UPDATE
  `).get(accountId);
  if (!pendingAssignment) {
    throw new BackofficeError(409, "BACKOFFICE_ASSIGNMENT_MISSING", "账号缺少待激活的服务主体绑定");
  }

  const activeAssignment = await tx.prepare<Row>(`
    SELECT * FROM backoffice_subject_assignments
    WHERE subject_type = ? AND subject_id = ? AND status = 'active'
    FOR UPDATE
  `).get(String(pendingAssignment.subject_type), String(pendingAssignment.subject_id));
  if (activeAssignment && String(activeAssignment.account_id) !== accountId) {
    if (String(pendingAssignment.replaces_assignment_id ?? "") !== String(activeAssignment.id)) {
      throw new BackofficeError(
        409,
        "BACKOFFICE_REPLACEMENT_STALE",
        "门店管理员已发生变化，请刷新后重试",
      );
    }
    const oldAccountId = String(activeAssignment.account_id);
    await tx.prepare(`
      UPDATE backoffice_subject_assignments
      SET status = 'revoked', revoked_at = ?::timestamptz
      WHERE id = ? AND status = 'active'
    `).run(now, String(activeAssignment.id));
    await tx.prepare(`
      UPDATE backoffice_accounts
      SET status = 'disabled', permission_version = permission_version + 1,
        updated_at = ?::timestamptz, disabled_at = ?::timestamptz
      WHERE id = ?
    `).run(now, now, oldAccountId);
    await revokeAccountSessions(tx, oldAccountId, now);
    await tx.prepare(`
      UPDATE backoffice_invites SET invalidated_at = ?::timestamptz
      WHERE account_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
    `).run(now, oldAccountId);
  }

  await tx.prepare(`
    UPDATE backoffice_subject_assignments
    SET status = 'active', activated_at = ?::timestamptz
    WHERE id = ? AND status = 'pending'
  `).run(now, String(pendingAssignment.id));
}

async function applyDirectAccountPassword(
  tx: AppDatabase,
  accountId: string,
  password: string,
  now: string,
): Promise<void> {
  const account = await tx.prepare<Row>(`
    SELECT id, role, status FROM backoffice_accounts WHERE id = ? FOR UPDATE
  `).get(accountId);
  if (!account) throw new BackofficeError(404, "BACKOFFICE_ACCOUNT_NOT_FOUND", "未找到该后台账号");
  if (String(account.status) === "disabled") {
    throw new BackofficeError(403, "BACKOFFICE_ACCOUNT_DISABLED", "该后台账号已停用");
  }

  const role = String(account.role) as BackofficeRole;
  if (["pending_activation", "password_reset"].includes(String(account.status))) {
    await activateSubjectAssignmentForAccount(tx, accountId, role, now);
  }

  const passwordHash = await hashBackofficePassword(password);
  await tx.prepare(`
    UPDATE backoffice_accounts
    SET password_hash = ?, status = 'active', permission_version = permission_version + 1,
      updated_at = ?::timestamptz, disabled_at = NULL
    WHERE id = ?
  `).run(passwordHash, now, accountId);
  await revokeAccountSessions(tx, accountId, now);
  await tx.prepare(`
    UPDATE backoffice_invites SET invalidated_at = ?::timestamptz
    WHERE account_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
  `).run(now, accountId);
}

async function createInvitedAccount(
  database: AppDatabase,
  input: z.infer<typeof invitationBodySchema>,
  creator: BackofficeSession,
  replacementAssignmentId?: string,
): Promise<{ account: ReturnType<typeof accountDto>; activation?: { token: string; url: string; expiresAt: string } }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const accountId = randomUUID();
  const loginNameNormalized = normalizeLoginName(input.loginName);
  const directPassword = input.password?.trim() || null;
  return database.transaction(async (tx) => {
    await assertLoginNameAvailable(tx, loginNameNormalized);
    if (input.subject) {
      // Lock the store itself so two first invitations cannot both observe an
      // empty assignment set and race into the pending unique index.
      if (input.subject.type === "wash_store") {
        await requireWashStore(tx, input.subject.id, { lock: true });
      } else if (input.subject.type === "inspection_station") {
        await requireInspectionStation(tx, input.subject.id, { lock: true });
      } else {
        await requireRepairShop(tx, input.subject.id, { lock: true });
      }
      const assignments = await tx.prepare<Row>(`
        SELECT id, status FROM backoffice_subject_assignments
        WHERE subject_type = ? AND subject_id = ? AND status IN ('active', 'pending')
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
        FOR UPDATE
      `).all(input.subject.type, input.subject.id);
      const active = assignments.find((assignment) => String(assignment.status) === "active");
      const pending = assignments.find((assignment) => String(assignment.status) === "pending");
      if (!replacementAssignmentId) {
        if (active) {
          throw new BackofficeError(
            409,
            "BACKOFFICE_SUBJECT_ALREADY_ASSIGNED",
            "该门店已有有效管理员，请使用更换管理员操作",
          );
        }
        if (pending) {
          throw new BackofficeError(
            409,
            "BACKOFFICE_SUBJECT_INVITATION_PENDING",
            "该门店已有待激活的管理员邀请",
          );
        }
      } else {
        if (pending) {
          throw new BackofficeError(
            409,
            "BACKOFFICE_REPLACEMENT_PENDING",
            "该门店已有待激活的新管理员",
          );
        }
        if (String(active?.id ?? "") !== replacementAssignmentId) {
          throw new BackofficeError(
            409,
            "BACKOFFICE_REPLACEMENT_STALE",
            "门店管理员已发生变化，请刷新后重试",
          );
        }
      }
    }

    const initialStatus = directPassword ? "active" : "pending_activation";
    const passwordHash = directPassword ? await hashBackofficePassword(directPassword) : null;
    await tx.prepare(`
      INSERT INTO backoffice_accounts (
        id, login_name, login_name_normalized, display_name, password_hash,
        role, status, permission_version, last_login_at, created_at, updated_at, disabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL,
        ?::timestamptz, ?::timestamptz, NULL)
    `).run(
      accountId,
      input.loginName.trim(),
      loginNameNormalized,
      input.displayName.trim(),
      passwordHash,
      input.role,
      initialStatus,
      nowIso,
      nowIso,
    );

    if (input.subject) {
      const assignmentStatus = directPassword && !replacementAssignmentId ? "active" : "pending";
      await tx.prepare(`
        INSERT INTO backoffice_subject_assignments (
          id, account_id, subject_type, subject_id, status, replaces_assignment_id,
          created_at, activated_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?::timestamptz, ?, NULL)
      `).run(
        randomUUID(),
        accountId,
        input.subject.type,
        input.subject.id,
        assignmentStatus,
        replacementAssignmentId ?? null,
        nowIso,
        assignmentStatus === "active" ? nowIso : null,
      );
      if (directPassword && replacementAssignmentId) {
        await activateSubjectAssignmentForAccount(tx, accountId, input.role, nowIso);
      }
    }

    let activation: { token: string; url: string; expiresAt: string } | undefined;
    if (!directPassword) {
      activation = await issueInvite(tx, accountId, "activation", creator.account.id, now);
    }
    const row = await getAccount(tx, accountId);
    if (!row) throw new Error("Backoffice account insert did not persist");
    await auditBackofficeEvent(tx, {
      principal: creator,
      action: directPassword
        ? "backoffice.account.activated"
        : (replacementAssignmentId ? "backoffice.account.replacement_invited" : "backoffice.account.invited"),
      outcome: "success",
      subject: input.subject
        ? { type: input.subject.type, id: input.subject.id, name: String(row.subject_name ?? input.subject.id) }
        : null,
      resource: { type: "backoffice_account", id: accountId },
      after: accountDto(row),
    });
    return { account: accountDto(row), activation };
  });
}

export async function createInitialPlatformAdmin(
  database: AppDatabase,
  input: { loginName: string; displayName: string; password: string },
): Promise<ReturnType<typeof accountDto>> {
  const loginName = parseInput(loginNameSchema, input.loginName);
  const displayName = parseInput(displayNameSchema, input.displayName);
  const passwordHash = await hashBackofficePassword(input.password);
  const now = new Date().toISOString();
  return database.transaction(async (tx) => {
    await tx.execute("SELECT pg_advisory_xact_lock(hashtext('yuxiaoman-backoffice-initial-admin'))");
    const existing = await tx.prepare<Row>(`
      SELECT id FROM backoffice_accounts
      WHERE role = 'platform_admin' AND status = 'active'
      FOR UPDATE
    `).get();
    if (existing) {
      throw new BackofficeError(
        409,
        "BACKOFFICE_PLATFORM_ADMIN_EXISTS",
        "已存在有效的平台管理员，请在后台通过邀请创建其他账号",
      );
    }
    const id = randomUUID();
    await tx.prepare(`
      INSERT INTO backoffice_accounts (
        id, login_name, login_name_normalized, display_name, password_hash,
        role, status, permission_version, last_login_at, created_at, updated_at, disabled_at
      ) VALUES (?, ?, ?, ?, ?, 'platform_admin', 'active', 1, NULL,
        ?::timestamptz, ?::timestamptz, NULL)
    `).run(id, loginName, normalizeLoginName(loginName), displayName, passwordHash, now, now);
    const row = await getAccount(tx, id);
    if (!row) throw new Error("Initial platform admin insert did not persist");
    const principal: BackofficeSession = {
      sessionId: null,
      permissionVersion: 1,
      account: { id, loginName, displayName, role: "platform_admin" },
      subject: null,
      capabilities: capabilitiesForRole("platform_admin"),
      expiresAt: now,
    };
    await auditBackofficeEvent(tx, {
      principal,
      action: "backoffice.account.bootstrap_created",
      outcome: "success",
      resource: { type: "backoffice_account", id },
      after: accountDto(row),
      occurredAt: now,
    });
    return accountDto(row);
  });
}

function isProtectedBackofficePath(path: string): boolean {
  if (
    path === "/api/operator/sessions"
    || path === "/api/operator/session"
    || path === "/api/repair-operator/sessions"
    || path === "/api/repair-operator/session"
  ) return false;
  return path === "/api/admin"
    || path.startsWith("/api/admin/")
    || path === "/api/operator"
    || path.startsWith("/api/operator/")
    || path === "/api/repair-operator"
    || path.startsWith("/api/repair-operator/");
}

export function isBackofficeOriginControlledPath(path: string): boolean {
  return path === "/api/backoffice"
    || path.startsWith("/api/backoffice/")
    || isProtectedBackofficePath(path);
}

function mayWashStoreAccessPath(path: string): boolean {
  return path === "/api/admin/wash"
    || path.startsWith("/api/admin/wash/")
    || path === "/api/admin/audit-events"
    || path.startsWith("/api/admin/audit-events/");
}

function mayProviderReadWorkflowPath(path: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return path === "/api/admin/workflow/summary"
    || path === "/api/admin/workflow/tasks"
    || /^\/api\/admin\/workflow\/tasks\/[^/]+$/u.test(path)
    || path === "/api/admin/workflow/policies/current";
}

function mayInspectionStationAccessPath(path: string, method: string): boolean {
  return path === "/api/operator"
    || path.startsWith("/api/operator/")
    || path === "/api/admin/audit-events"
    || path.startsWith("/api/admin/audit-events/")
    || mayProviderReadWorkflowPath(path, method);
}

function mayRepairShopAccessPath(path: string, method: string): boolean {
  return path === "/api/repair-operator"
    || path.startsWith("/api/repair-operator/")
    || path === "/api/admin/audit-events"
    || path.startsWith("/api/admin/audit-events/")
    || mayProviderReadWorkflowPath(path, method);
}

function repairOperatorCapability(path: string, method: string): BackofficeCapability {
  if (path.includes("/media/")) return "repair.authorized_details.read";
  if (method !== "GET" && method !== "HEAD") return "repair.quotes.write";
  if (path.includes("/quote")) return "repair.quotes.read";
  return "repair.requests.read";
}

function operatorCapability(path: string, method: string): BackofficeCapability {
  if (path === "/api/operator/workflow/tasks" || path === "/api/operator/workflow/tasks/summary") {
    return "workflow.tasks.read";
  }
  if (path === "/api/operator/workbench") return "inspection.workbench.read";
  if (path.startsWith("/api/operator/station-slots/")) return "inspection.slots.write";
  if (path.includes("/checkup-report") || path.endsWith("/inspection-result")) {
    return method === "GET" || method === "HEAD"
      ? "inspection.reports.read"
      : "inspection.reports.write";
  }
  return method === "GET" || method === "HEAD"
    ? "inspection.bookings.read"
    : "inspection.bookings.write";
}

function decodedPathId(value: string): string | null {
  try {
    const id = decodeURIComponent(value).trim();
    return id || null;
  } catch {
    return null;
  }
}

async function enforceInspectionStationOperatorScope(
  database: AppDatabase,
  principal: BackofficeSession,
  path: string,
  method: string,
): Promise<void> {
  if (principal.account.role !== "inspection_station_admin") return;
  assertCapability(principal, operatorCapability(path, method));
  const stationId = scopedInspectionStationId(principal);
  if (
    path === "/api/operator"
    || path === "/api/operator/workbench"
    || path === "/api/operator/prechecks"
    || path === "/api/operator/workflow/tasks"
    || path === "/api/operator/workflow/tasks/summary"
  ) return;

  const precheckMatch = path.match(/^\/api\/operator\/prechecks\/([^/]+)(?:\/|$)/u);
  if (precheckMatch) {
    const bookingId = decodedPathId(precheckMatch[1]);
    const booking = bookingId
      ? await database.prepare<Row>("SELECT station_id FROM bookings WHERE id = ?").get(bookingId)
      : undefined;
    if (!booking || String(booking.station_id) !== stationId) {
      throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
    }
    return;
  }

  const bookingMatch = path.match(/^\/api\/operator\/bookings\/([^/]+)(?:\/|$)/u);
  if (bookingMatch) {
    const bookingId = decodedPathId(bookingMatch[1]);
    const booking = bookingId
      ? await database.prepare<Row>("SELECT station_id FROM bookings WHERE id = ?").get(bookingId)
      : undefined;
    if (!booking || String(booking.station_id) !== stationId) {
      throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
    }
    return;
  }

  const slotMatch = path.match(/^\/api\/operator\/station-slots\/([^/]+)(?:\/|$)/u);
  if (slotMatch) {
    const slotId = decodedPathId(slotMatch[1]);
    const slot = slotId
      ? await database.prepare<Row>("SELECT station_id FROM station_slots WHERE id = ?").get(slotId)
      : undefined;
    if (!slot || String(slot.station_id) !== stationId) {
      throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
    }
    return;
  }

  throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

async function activateWithPassword(
  database: AppDatabase,
  token: string,
  password: string,
  request: FastifyRequest,
): Promise<IssuedSession> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  return database.transaction(async (tx) => {
    const invite = await tx.prepare<Row>(`
      SELECT i.id AS invite_id, i.account_id, i.kind, i.expires_at,
        a.login_name, a.display_name, a.role, a.status
      FROM backoffice_invites i
      JOIN backoffice_accounts a ON a.id = i.account_id
      WHERE i.token_hash = ? AND i.consumed_at IS NULL AND i.invalidated_at IS NULL
      FOR UPDATE OF i, a
    `).get(sha256(token));
    if (!invite || new Date(iso(invite.expires_at)).getTime() <= nowDate.getTime()) {
      throw new BackofficeError(410, "BACKOFFICE_INVITE_INVALID", "激活链接无效或已过期");
    }
    if (String(invite.status) === "disabled") {
      throw new BackofficeError(403, "BACKOFFICE_ACCOUNT_DISABLED", "该后台账号已停用");
    }

    const accountId = String(invite.account_id);
    const role = String(invite.role) as BackofficeRole;
    const inviteKind = String(invite.kind) as "activation" | "password_reset";
    const expectedStatus = inviteKind === "activation" ? "pending_activation" : "password_reset";
    if (String(invite.status) !== expectedStatus) {
      throw new BackofficeError(409, "BACKOFFICE_INVITE_STATE_MISMATCH", "账号状态已变化，请申请新的链接");
    }

    if (inviteKind === "activation" && role !== "platform_admin") {
      await activateSubjectAssignmentForAccount(tx, accountId, role, now);
    }

    // Hash only after the invite and account state have been validated. Invalid
    const passwordHash = await hashBackofficePassword(password);

    await tx.prepare(`
      UPDATE backoffice_accounts
      SET password_hash = ?, status = 'active', permission_version = permission_version + 1,
        updated_at = ?::timestamptz, disabled_at = NULL
      WHERE id = ?
    `).run(passwordHash, now, accountId);
    await revokeAccountSessions(tx, accountId, now);
    await tx.prepare(`
      UPDATE backoffice_invites SET consumed_at = ?::timestamptz WHERE id = ?
    `).run(now, String(invite.invite_id));
    await tx.prepare(`
      UPDATE backoffice_invites SET invalidated_at = ?::timestamptz
      WHERE account_id = ? AND id <> ? AND consumed_at IS NULL AND invalidated_at IS NULL
    `).run(now, accountId, String(invite.invite_id));

    const issued = await issueBackofficeSession(tx, accountId, nowDate);
    await auditBackofficeEvent(tx, {
      request,
      principal: issued.principal,
      action: inviteKind === "activation" ? "backoffice.account.activated" : "backoffice.password.reset_completed",
      outcome: "success",
      resource: { type: "backoffice_account", id: accountId },
    });
    return issued;
  });
}

const AUDIT_CATEGORY_LABELS: Record<BackofficeAuditCategory, string> = {
  account_security: "账号与安全",
  customer: "客户中心",
  inspection: "预约与检测",
  wash: "洗车服务",
  repair: "维修服务",
  car_rental: "汽车租赁",
  insurance: "车险服务",
  driving_school: "驾校服务",
  subsidy: "补贴咨询",
};

const AUDIT_ACTION_DEFINITIONS: Record<string, { category: BackofficeAuditCategory; label: string }> = {
  "customer.note.add": { category: "customer", label: "添加客户备注" },
  "customer.tags.update": { category: "customer", label: "更新客户标签" },
  "customer.identity.reveal": { category: "customer", label: "查看完整身份标识" },
  "customer.material.read": { category: "customer", label: "查看客户资料" },
  "backoffice.account.invited": { category: "account_security", label: "邀请后台账号" },
  "backoffice.account.replacement_invited": { category: "account_security", label: "发起更换门店管理员" },
  "backoffice.account.bootstrap_created": { category: "account_security", label: "创建首个平台管理员" },
  "backoffice.account.activated": { category: "account_security", label: "激活后台账号" },
  "backoffice.account.activation": { category: "account_security", label: "激活后台账号" },
  "backoffice.account.disabled": { category: "account_security", label: "停用后台账号" },
  "backoffice.password.changed": { category: "account_security", label: "修改登录密码" },
  "backoffice.password.change": { category: "account_security", label: "修改登录密码" },
  "backoffice.password.reset_requested": { category: "account_security", label: "发起密码重置" },
  "backoffice.password.reset_completed": { category: "account_security", label: "完成密码重置" },
  "backoffice.session.login": { category: "account_security", label: "登录运营后台" },
  "backoffice.session.logout": { category: "account_security", label: "退出运营后台" },
  "backoffice.authorization.denied": { category: "account_security", label: "访问未授权功能" },
  "booking.cancel": { category: "inspection", label: "取消预约" },
  "booking.refund.record": { category: "inspection", label: "登记订单退款" },
  "booking.surcharge.create": { category: "inspection", label: "新增附加费" },
  "booking.fulfillment.update": { category: "inspection", label: "调整履约状态" },
  "booking.fulfillment.accept": { category: "inspection", label: "检测站接单" },
  "booking.precheck.approve": { category: "inspection", label: "预约资料预审通过" },
  "booking.precheck.reject": { category: "inspection", label: "预约资料预审不通过" },
  "booking.precheck.refund.retry": { category: "inspection", label: "重试预审退款" },
  "booking.fulfillment.check_in": { category: "inspection", label: "确认车辆到站" },
  "booking.fulfillment.hold": { category: "inspection", label: "挂起预约" },
  "booking.fulfillment.resume": { category: "inspection", label: "恢复预约" },
  "booking.fulfillment.handoff": { category: "inspection", label: "交接检测" },
  "booking.fulfillment.complete": { category: "inspection", label: "完成服务" },
  "booking.fulfillment.no_show": { category: "inspection", label: "标记车主爽约" },
  "booking.checkup_photo.delete": { category: "inspection", label: "删除体检照片" },
  "booking.inspection_result.submit": { category: "inspection", label: "提交检验结果" },
  "inspection.station.create": { category: "inspection", label: "新建检测站" },
  "inspection.station.update": { category: "inspection", label: "修改检测站配置" },
  "inspection.slot.create": { category: "inspection", label: "新增预约时段" },
  "inspection.slot.update": { category: "inspection", label: "调整预约时段" },
  "inspection.slot.capacity_update": { category: "inspection", label: "调整号源容量" },
  "inspection.slot.delete": { category: "inspection", label: "删除预约时段" },
  "inspection.station_offers.update": { category: "inspection", label: "调整检测站检验报价" },
  "inspection.price_plan.create": { category: "inspection", label: "新建检验价格方案" },
  "inspection.price_plan.update": { category: "inspection", label: "修改检验价格方案" },
  "inspection.price_plan.disable": { category: "inspection", label: "停用检验价格方案" },
  "inspection.valet_rule.global_update": { category: "inspection", label: "修改全局取送计价规则" },
  "inspection.valet_rule.station_override": { category: "inspection", label: "设置站点取送计价规则" },
  "inspection.valet_rule.station_inherit": { category: "inspection", label: "恢复继承全局取送规则" },
  "car_rental.brand.created": { category: "car_rental", label: "新增租赁品牌" },
  "car_rental.brand.updated": { category: "car_rental", label: "修改租赁品牌" },
  "car_rental.brand.enabled": { category: "car_rental", label: "启用租赁品牌" },
  "car_rental.brand.disabled": { category: "car_rental", label: "停用租赁品牌" },
  "car_rental.brand.logo_updated": { category: "car_rental", label: "更换品牌车标" },
  "car_rental.model.created": { category: "car_rental", label: "新增租赁车型" },
  "car_rental.model.updated": { category: "car_rental", label: "修改租赁车型" },
  "car_rental.model.enabled": { category: "car_rental", label: "启用租赁车型" },
  "car_rental.model.disabled": { category: "car_rental", label: "停用租赁车型" },
  "car_rental.model_image.added": { category: "car_rental", label: "添加车型图片" },
  "car_rental.model_image.removed": { category: "car_rental", label: "删除车型图片" },
  "car_rental.model_images.arranged": { category: "car_rental", label: "调整车型图片展示" },
  "car_rental.store.created": { category: "car_rental", label: "新增租赁门店" },
  "car_rental.store.updated": { category: "car_rental", label: "修改租赁门店" },
  "car_rental.store.enabled": { category: "car_rental", label: "启用租赁门店" },
  "car_rental.store.disabled": { category: "car_rental", label: "停用租赁门店" },
  "car_rental.vehicle.created": { category: "car_rental", label: "新增车队车辆" },
  "car_rental.vehicle.updated": { category: "car_rental", label: "修改车队车辆" },
  "car_rental.vehicle.status_changed": { category: "car_rental", label: "调整车辆运营状态" },
  "car_rental.vehicle.retired": { category: "car_rental", label: "退役车辆" },
  "car_rental.rate_plan.created": { category: "car_rental", label: "新增租赁价格方案" },
  "car_rental.rate_plan.updated": { category: "car_rental", label: "调整租赁价格方案" },
  "car_rental.rate_plan.enabled": { category: "car_rental", label: "启用租赁价格方案" },
  "car_rental.rate_plan.disabled": { category: "car_rental", label: "停用租赁价格方案" },
  "car_rental.rate_override.created": { category: "car_rental", label: "设置指定日期价格或停售" },
  "car_rental.rate_override.updated": { category: "car_rental", label: "调整指定日期价格或停售" },
  "car_rental.rate_override.removed": { category: "car_rental", label: "取消指定日期覆盖" },
  "car_rental.order.vehicle_assigned": { category: "car_rental", label: "为订单分配车辆" },
  "car_rental.order.vehicle_changed": { category: "car_rental", label: "更换订单履约车辆" },
  "car_rental.order.status_changed": { category: "car_rental", label: "推进租赁订单履约" },
  "car_rental.order.adjustment_created": { category: "car_rental", label: "登记租后费用调整" },
  "insurance.lead.handoff": { category: "insurance", label: "转交车险线索" },
  "insurance.lead.close": { category: "insurance", label: "关闭车险线索" },
  "insurance.disclosure.update": { category: "insurance", label: "更新车险授权说明" },
  "driving_school.school.create": { category: "driving_school", label: "新增驾校" },
  "driving_school.school.update": { category: "driving_school", label: "修改驾校资料" },
  "driving_school.school.delete": { category: "driving_school", label: "删除驾校" },
  "driving_school.school.publish": { category: "driving_school", label: "发布驾校" },
  "driving_school.school.unpublish": { category: "driving_school", label: "下线驾校" },
  "driving_school.image.create": { category: "driving_school", label: "添加驾校图片" },
  "driving_school.image.update": { category: "driving_school", label: "修改驾校图片" },
  "driving_school.image.delete": { category: "driving_school", label: "删除驾校图片" },
  "driving_school.training_class.create": { category: "driving_school", label: "添加培训车型" },
  "driving_school.training_class.update": { category: "driving_school", label: "修改培训车型" },
  "driving_school.training_class.delete": { category: "driving_school", label: "删除培训车型" },
  "driving_school.offer.create": { category: "driving_school", label: "新增服务报价" },
  "driving_school.offer.update": { category: "driving_school", label: "修改服务报价" },
  "driving_school.offer.delete": { category: "driving_school", label: "删除服务报价" },
  "driving_school.inquiry.followup_update": { category: "driving_school", label: "更新驾校咨询跟进" },
  "subsidy.fee_plan.publish": { category: "subsidy", label: "发布补贴咨询价格方案" },
  "subsidy.disclosure.publish": { category: "subsidy", label: "发布补贴咨询授权说明" },
  "subsidy.consultation.handle": { category: "subsidy", label: "处理补贴咨询" },
  "wash.store.create": { category: "wash", label: "新增洗车门店" },
  "wash.store.update": { category: "wash", label: "修改洗车门店资料" },
  "wash.store.archive": { category: "wash", label: "归档洗车门店" },
  "wash.store.delete": { category: "wash", label: "删除洗车门店" },
  "wash.store_image.create": { category: "wash", label: "上传门店图片" },
  "wash.store_image.reorder": { category: "wash", label: "调整门店图片顺序" },
  "wash.store_image.delete": { category: "wash", label: "删除门店图片" },
  "wash.valet_rule.update": { category: "wash", label: "修改洗车取送计价规则" },
  "wash.valet_rule.delete": { category: "wash", label: "恢复洗车取送全局规则" },
  "wash.package.create": { category: "wash", label: "新增洗车套餐" },
  "wash.package.update": { category: "wash", label: "修改洗车套餐" },
  "wash.package.disable": { category: "wash", label: "停用洗车套餐" },
  "wash.store_offers.update": { category: "wash", label: "调整门店套餐售价" },
  "wash.slot.create": { category: "wash", label: "新增洗车预约时段" },
  "wash.slot.batch_create": { category: "wash", label: "批量新增洗车预约时段" },
  "wash.slot.update": { category: "wash", label: "调整洗车预约时段" },
  "wash.slot.delete": { category: "wash", label: "删除洗车预约时段" },
  "wash.order.redeem": { category: "wash", label: "核销洗车订单" },
  "wash.order.cancel": { category: "wash", label: "取消洗车订单" },
  "wash.order.refund": { category: "wash", label: "办理洗车订单退款" },
  "wash.settlement.update": { category: "wash", label: "登记或修正洗车结算" },
  "repair.quote.create": { category: "repair", label: "提交维修报价" },
  "repair.quote.update": { category: "repair", label: "修改维修报价" },
  "repair.quote.delete": { category: "repair", label: "撤回维修报价" },
};

const AUDIT_FIELD_LABELS: Record<string, string> = {
  status: "状态",
  role: "账号角色",
  displayName: "姓名",
  loginName: "登录名",
  name: "名称",
  legalName: "法定主体",
  isActive: "启用状态",
  active: "启用状态",
  enabled: "启用状态",
  sortOrder: "后台排序",
  sortPriority: "后台排序",
  dataKind: "数据类型",
  openHours: "营业时间",
  appointmentDate: "预约日期",
  date: "日期",
  startTime: "开始时间",
  endTime: "结束时间",
  capacity: "容量",
  bookedCount: "已预约数",
  priceFen: "价格",
  amountFen: "金额",
  paymentStatus: "支付状态",
  orderStatus: "订单状态",
  fulfillmentStatus: "履约状态",
  settlementStatus: "结算状态",
  isAvailable: "可售状态",
  isSupported: "支持状态",
  isCover: "封面状态",
};

const AUDIT_STATUS_LABELS: Record<string, string> = {
  success: "成功", denied: "已拒绝", failure: "失败",
  active: "启用", inactive: "停用", disabled: "已停用", pending_activation: "待激活",
  password_reset: "待重置密码", pending_payment: "待支付", confirmed: "已确认",
  awaiting_arrival: "等待到站", checked_in: "已到站", inspecting: "检测中",
  result_received: "结果已回传", on_hold: "已挂起", completed: "已完成",
  cancelled: "已取消", refunded: "已退款", no_show: "爽约",
  awaiting_redemption: "待核销", redeemed: "已核销", expired: "已过期",
  unsettled: "未结算", settled: "已结算", void: "已作废",
};

const AUDIT_REASON_LABELS: Record<string, string> = {
  origin_required: "请求缺少可信来源信息",
  origin_not_allowed: "请求来源不在后台白名单中",
  BACKOFFICE_ORIGIN_FORBIDDEN: "请求来源不在后台白名单中",
  BACKOFFICE_UNAUTHENTICATED: "后台会话无效或已过期",
  BACKOFFICE_FORBIDDEN: "当前账号没有该功能权限",
  OPERATOR_ACCOUNT_REQUIRED: "仅检测站管理员可以访问检测站端",
  REPAIR_OPERATOR_ACCOUNT_REQUIRED: "仅维修门店管理员可以访问维修门店端",
  REPAIR_OPERATOR_AUTHENTICATION_REQUIRED: "维修门店账号会话无效或已过期",
  BACKOFFICE_RESOURCE_NOT_FOUND: "尝试访问不属于当前账号的数据",
  BACKOFFICE_INVALID_CREDENTIALS: "登录名或密码错误",
  BACKOFFICE_LOGIN_RATE_LIMITED: "失败次数过多，登录已被暂时限制",
  WASH_ORDER_NOT_FOUND: "核销码无效、已失效或订单不属于当前门店",
  WASH_REDEMPTION_RATE_LIMITED: "核销失败次数过多，请稍后再试",
  invalid_credentials: "登录名或密码错误",
  internal_error: "操作未能完成",
};

function auditObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function auditCategoryFor(action: string, presentation: Record<string, unknown>): BackofficeAuditCategory {
  const explicit = String(presentation.category ?? "") as BackofficeAuditCategory;
  if (explicit in AUDIT_CATEGORY_LABELS) return explicit;
  const known = AUDIT_ACTION_DEFINITIONS[action]?.category;
  if (known) return known;
  if (action.startsWith("customer.")) return "customer";
  if (action.startsWith("booking.") || action.startsWith("inspection.")) return "inspection";
  if (action.startsWith("wash.")) return "wash";
  if (action.startsWith("repair.")) return "repair";
  if (action.startsWith("rental.") || action.startsWith("car_rental.")) return "car_rental";
  if (action.startsWith("insurance.")) return "insurance";
  if (action.startsWith("driving_school.") || action.startsWith("driving.")) return "driving_school";
  if (action.startsWith("subsidy.")) return "subsidy";
  return "account_security";
}

function auditRoleLabel(role: unknown): string {
  if (role === "platform_admin") return "平台管理员";
  if (role === "wash_store_admin") return "洗车店管理员";
  if (role === "inspection_station_admin") return "检测站管理员";
  if (role === "repair_shop_admin") return "维修门店管理员";
  return "系统";
}

function auditDisplayValue(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    if (/Fen$/u.test(field)) return `¥${(value / 100).toFixed(2)}`;
    return String(value);
  }
  if (typeof value === "string") return AUDIT_STATUS_LABELS[value] ?? maskAuditPlates(value);
  if (Array.isArray(value)) return `${value.length} 项`;
  return null;
}

function fallbackAuditChanges(row: Row): BackofficeAuditDisplayChange[] {
  const before = auditObject(row.before_json);
  const after = auditObject(row.after_json);
  const changes: BackofficeAuditDisplayChange[] = [];
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const label = AUDIT_FIELD_LABELS[field];
    if (!label || JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    changes.push({
      field,
      label,
      before: auditDisplayValue(field, before[field]),
      after: auditDisplayValue(field, after[field]),
    });
  }
  return changes.slice(0, 30);
}

function auditTargetLabel(row: Row, presentation: Record<string, unknown>, subjectName: string | null): string | null {
  if (presentation.resourceLabel) return maskAuditPlates(String(presentation.resourceLabel));
  const after = auditObject(row.after_json);
  const before = auditObject(row.before_json);
  const candidate = after.orderNumber ?? after.name ?? after.displayName ?? after.label ?? after.stockNo
    ?? before.orderNumber ?? before.name ?? before.displayName ?? before.label ?? before.stockNo;
  if (candidate) return maskAuditPlates(String(candidate));
  if (String(row.resource_type ?? "") === "wash_store" && subjectName) return subjectName;
  if (String(row.resource_type ?? "") === "repair_shop" && subjectName) return subjectName;
  const resourceLabels: Record<string, string> = {
    route: "后台功能",
    backoffice_account: "后台账号",
    wash_store: "洗车门店",
    wash_store_image: "门店图片",
    wash_package: "洗车套餐",
    wash_slot: "预约时段",
    wash_order: "洗车订单",
    wash_order_settlement: "洗车结算",
    repair_shop: "维修门店",
    repair_request: "维修需求",
    repair_quote: "维修报价",
  };
  return resourceLabels[String(row.resource_type ?? "")] ?? null;
}

export function backofficeAuditEventDto(row: Row, includeDetails = false) {
  const metadata = auditObject(row.metadata_json);
  const presentation = auditObject(metadata.presentation);
  const action = String(row.action);
  const categoryCode = auditCategoryFor(action, presentation);
  const actionLabel = String(presentation.actionLabel ?? AUDIT_ACTION_DEFINITIONS[action]?.label ?? "关键操作");
  const subjectName = presentation.subjectName
    ? String(presentation.subjectName)
    : row.subject_name ? String(row.subject_name) : null;
  const targetLabel = auditTargetLabel(row, presentation, subjectName);
  const outcomeCode = String(row.outcome) as "success" | "denied" | "failure";
  const rawReason = presentation.reason ?? metadata.reason ?? metadata.code;
  const reason = rawReason
    ? AUDIT_REASON_LABELS[String(rawReason)] ?? "操作未能完成或被系统拒绝"
    : null;
  const presentationChanges = Array.isArray(presentation.changes)
    ? presentation.changes.map((item, index) => {
        const change = auditObject(item);
        return {
          field: String(change.field ?? `change_${index + 1}`),
          label: String(change.label ?? "变更内容"),
          before: auditDisplayValue(String(change.field ?? ""), change.before),
          after: auditDisplayValue(String(change.field ?? ""), change.after),
        };
      }).slice(0, 30)
    : fallbackAuditChanges(row);
  const summary = maskAuditPlates(String(
    presentation.summary
      ?? (outcomeCode === "denied"
        ? `${actionLabel}，系统已拒绝本次请求`
        : targetLabel ? `${actionLabel}：${targetLabel}` : actionLabel),
  ));
  const result = {
    id: String(row.id),
    category: { code: categoryCode, label: AUDIT_CATEGORY_LABELS[categoryCode] },
    actionLabel,
    summary,
    actor: {
      id: row.account_id ? String(row.account_id) : null,
      displayName: row.actor_display_name ? String(row.actor_display_name) : "系统",
      roleLabel: auditRoleLabel(row.actor_role),
    },
    subject: row.subject_id
      ? {
          type: String(row.subject_type),
          id: String(row.subject_id),
          name: subjectName ?? "当前业务主体",
        }
      : null,
    target: row.resource_type
      ? {
          type: String(row.resource_type),
          id: String(row.resource_type) === "route" ? null : row.resource_id ? String(row.resource_id) : null,
          label: targetLabel,
        }
      : null,
    outcome: { code: outcomeCode, label: AUDIT_STATUS_LABELS[outcomeCode] ?? "未知" },
    occurredAt: iso(row.occurred_at),
    hasDetails: presentationChanges.length > 0 || Boolean(reason),
  };
  return includeDetails ? { ...result, changes: presentationChanges, reason } : result;
}

export function registerBackofficeRoutes(app: FastifyInstance, database: AppDatabase): void {
  const allowTestFallback = backofficeTestFallbackEnabled();
  if (!app.hasRequestDecorator("backoffice")) app.decorateRequest("backoffice", null);
  if (!app.hasRequestDecorator("backofficeDeniedAudited")) app.decorateRequest("backofficeDeniedAudited", false);

  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request);
    if (!isBackofficeOriginControlledPath(path)) return;

    reply.header("cache-control", "no-store");
    if (isProductionEnvironment()) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }

    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const nativeOperatorSessionPath = path === "/api/operator/sessions"
      || path === "/api/operator/session"
      || path === "/api/repair-operator/sessions"
      || path === "/api/repair-operator/session";
    const nativeOperatorBearerRequest = (
      path.startsWith("/api/operator/") || path.startsWith("/api/repair-operator/")
    )
      && !parseCookie(request, COOKIE_NAME)
      && Boolean(parseBackofficeBearer(request));
    const missingRequiredOrigin = isProductionEnvironment()
      && !SAFE_ORIGIN_METHODS.has(request.method)
      && !origin
      && !nativeOperatorSessionPath
      && !nativeOperatorBearerRequest;
    if (missingRequiredOrigin || !backofficeOriginAllowed(origin)) {
      await auditBackofficeEvent(database, {
        request,
        action: "backoffice.authorization.denied",
        outcome: "denied",
        resource: { type: "route", id: path },
        metadata: {
          method: request.method,
          reason: missingRequiredOrigin ? "origin_required" : "origin_not_allowed",
        },
      }).catch(() => undefined);
      request.backofficeDeniedAudited = true;
      throw new BackofficeError(403, "BACKOFFICE_ORIGIN_FORBIDDEN", "请求来源不在后台白名单中");
    }

    if (!isProtectedBackofficePath(path) || request.method === "OPTIONS") return;

    try {
      const repairOperatorRequest = path === "/api/repair-operator"
        || path.startsWith("/api/repair-operator/");
      const principal = repairOperatorRequest
        ? await requireRepairShopBearer(request, database)
        : await requireBackoffice(request, database, { allowTestFallback });
      request.backoffice = principal;
      const bearerOnlyOperatorRequest = path.startsWith("/api/operator/")
        && !parseCookie(request, COOKIE_NAME)
        && Boolean(parseBackofficeBearer(request));
      if (
        bearerOnlyOperatorRequest
        && (
          principal.account.role !== "inspection_station_admin"
          || principal.subject?.type !== "inspection_station"
        )
      ) {
        throw new BackofficeError(403, "OPERATOR_ACCOUNT_REQUIRED", "仅检测站管理员可以访问检测站端");
      }
      if (principal.account.role === "wash_store_admin" && !mayWashStoreAccessPath(path)) {
        throw new BackofficeError(403, "BACKOFFICE_FORBIDDEN", "当前账号无权访问该后台模块");
      }
      if (
        principal.account.role === "inspection_station_admin"
        && !mayInspectionStationAccessPath(path, request.method)
      ) {
        throw new BackofficeError(403, "BACKOFFICE_FORBIDDEN", "当前账号无权访问该后台模块");
      }
      if (principal.account.role === "repair_shop_admin" && !mayRepairShopAccessPath(path, request.method)) {
        throw new BackofficeError(403, "BACKOFFICE_FORBIDDEN", "当前账号无权访问该后台模块");
      }
      if (path === "/api/operator" || path.startsWith("/api/operator/")) {
        await enforceInspectionStationOperatorScope(database, principal, path, request.method);
      }
      if (repairOperatorRequest) {
        assertCapability(principal, repairOperatorCapability(path, request.method));
        scopedRepairShopId(principal);
      }
    } catch (error) {
      if (error instanceof BackofficeError) {
        await auditBackofficeEvent(database, {
          request,
          action: "backoffice.authorization.denied",
          outcome: "denied",
          resource: { type: "route", id: path },
          metadata: { method: request.method, reason: error.code },
        }).catch(() => undefined);
        request.backofficeDeniedAudited = true;
      }
      throw error;
    }
  });

  app.post("/api/backoffice/sessions", async (request, reply) => {
    const body = parseInput(z.object({ loginName: loginNameSchema, password: z.string().max(200) }), request.body);
    const issued = await authenticateBackofficeAccount(database, request, body);
    request.backoffice = issued.principal;
    reply.header("set-cookie", sessionCookie(issued.token, SESSION_TTL_SECONDS));
    reply.header("cache-control", "no-store");
    return { data: publicSession(issued.principal) };
  });

  app.post("/api/operator/sessions", async (request, reply) => {
    const body = parseInput(
      z.object({ loginName: loginNameSchema, password: z.string().max(200) }),
      request.body,
    );
    const issued = await authenticateBackofficeAccount(database, request, body, {
      requiredRole: "inspection_station_admin",
    });
    request.backoffice = issued.principal;
    reply.header("cache-control", "no-store");
    return { data: publicBearerSession(issued) };
  });

  app.get("/api/operator/session", async (request, reply) => {
    const { principal } = await requireInspectionStationBearer(request, database);
    request.backoffice = principal;
    reply.header("cache-control", "no-store");
    return { data: publicOperatorSession(principal) };
  });

  app.delete("/api/operator/session", async (request, reply) => {
    const { token, principal } = await requireInspectionStationBearer(request, database);
    const now = new Date().toISOString();
    await database.transaction(async (tx) => {
      await tx.prepare(`
        UPDATE backoffice_sessions SET revoked_at = ?::timestamptz
        WHERE token_hash = ? AND revoked_at IS NULL
      `).run(now, sha256(token));
      await auditBackofficeEvent(tx, {
        request,
        principal,
        action: "backoffice.session.logout",
        outcome: "success",
        resource: { type: "backoffice_session", id: principal.sessionId },
      });
    });
    return reply.code(204).send();
  });

  app.post("/api/repair-operator/sessions", async (request, reply) => {
    const body = parseInput(
      z.object({ loginName: loginNameSchema, password: z.string().max(200) }),
      request.body,
    );
    const issued = await authenticateBackofficeAccount(database, request, body, {
      requiredRole: "repair_shop_admin",
      requiredRoleError: {
        code: "REPAIR_OPERATOR_ACCOUNT_REQUIRED",
        message: "仅维修门店管理员可以登录维修门店端",
      },
    });
    request.backoffice = issued.principal;
    reply.header("cache-control", "no-store");
    return { data: publicBearerSession(issued) };
  });

  app.get("/api/repair-operator/session", async (request, reply) => {
    const principal = await requireRepairShopBearer(request, database);
    request.backoffice = principal;
    reply.header("cache-control", "no-store");
    return { data: publicOperatorSession(principal) };
  });

  app.delete("/api/repair-operator/session", async (request, reply) => {
    const token = parseBackofficeBearer(request);
    const principal = await requireRepairShopBearer(request, database);
    if (!token) {
      throw new BackofficeError(401, "REPAIR_OPERATOR_AUTHENTICATION_REQUIRED", "需要有效的维修门店账号会话");
    }
    const now = new Date().toISOString();
    await database.transaction(async (tx) => {
      await tx.prepare(`
        UPDATE backoffice_sessions SET revoked_at = ?::timestamptz
        WHERE token_hash = ? AND revoked_at IS NULL
      `).run(now, sha256(token));
      await auditBackofficeEvent(tx, {
        request,
        principal,
        action: "backoffice.session.logout",
        outcome: "success",
        resource: { type: "backoffice_session", id: principal.sessionId },
      });
    });
    return reply.code(204).send();
  });

  app.get("/api/backoffice/session", async (request, reply) => {
    const principal = await requireBackoffice(request, database, { allowTestFallback });
    request.backoffice = principal;
    reply.header("cache-control", "no-store");
    return { data: publicSession(principal) };
  });

  app.delete("/api/backoffice/session", async (request, reply) => {
    const principal = await requireBackoffice(request, database, { allowTestFallback });
    const token = parseCookie(request, COOKIE_NAME);
    const now = new Date().toISOString();
    await database.transaction(async (tx) => {
      if (token) {
        await tx.prepare(`
          UPDATE backoffice_sessions SET revoked_at = ?::timestamptz
          WHERE token_hash = ? AND revoked_at IS NULL
        `).run(now, sha256(token));
      }
      await auditBackofficeEvent(tx, {
        request,
        principal,
        action: "backoffice.session.logout",
        outcome: "success",
        resource: { type: "backoffice_session", id: principal.sessionId },
      });
    });
    reply.header("set-cookie", clearSessionCookie());
    return reply.code(204).send();
  });

  app.post("/api/backoffice/activations", async (request, reply) => {
    let issued: IssuedSession;
    try {
      const body = parseInput(z.object({
        token: z.string().trim().min(20).max(200),
        password: passwordSchema,
      }), request.body);
      issued = await activateWithPassword(database, body.token, body.password, request);
    } catch (error) {
      await auditBackofficeEvent(database, {
        request,
        action: "backoffice.account.activation",
        outcome: error instanceof BackofficeError ? "denied" : "failure",
        resource: { type: "backoffice_invite" },
        metadata: { reason: error instanceof BackofficeError ? error.code : "internal_error" },
      }).catch(() => undefined);
      throw error;
    }
    request.backoffice = issued.principal;
    reply.header("set-cookie", sessionCookie(issued.token, SESSION_TTL_SECONDS));
    reply.header("cache-control", "no-store");
    return { data: publicSession(issued.principal) };
  });

  app.put("/api/backoffice/password", async (request, reply) => {
    const principal = await requireBackoffice(request, database, { allowTestFallback });
    if (!principal.sessionId) {
      throw new BackofficeError(403, "BACKOFFICE_TEST_SESSION_IMMUTABLE", "测试后台会话不能修改密码");
    }
    const body = parseInput(z.object({
      currentPassword: z.string().max(200),
      newPassword: passwordSchema,
    }), request.body);
    const nowDate = new Date();
    let issued: IssuedSession;
    try {
      issued = await database.transaction(async (tx) => {
        const account = await tx.prepare<Row>(`
          SELECT id, password_hash FROM backoffice_accounts
          WHERE id = ? AND status = 'active' FOR UPDATE
        `).get(principal.account.id);
        if (!account || !(await verifyBackofficePassword(
          body.currentPassword,
          account.password_hash ? String(account.password_hash) : DUMMY_PASSWORD_HASH,
        ))) {
          throw new BackofficeError(401, "BACKOFFICE_CURRENT_PASSWORD_INVALID", "当前密码错误");
        }
        const passwordHash = await hashBackofficePassword(body.newPassword);
        await tx.prepare(`
          UPDATE backoffice_accounts
          SET password_hash = ?, permission_version = permission_version + 1,
            updated_at = ?::timestamptz
          WHERE id = ?
        `).run(passwordHash, nowDate.toISOString(), principal.account.id);
        await revokeAccountSessions(tx, principal.account.id, nowDate.toISOString());
        const next = await issueBackofficeSession(tx, principal.account.id, nowDate);
        await auditBackofficeEvent(tx, {
          request,
          principal: next.principal,
          action: "backoffice.password.changed",
          outcome: "success",
          resource: { type: "backoffice_account", id: principal.account.id },
        });
        return next;
      });
    } catch (error) {
      await auditBackofficeEvent(database, {
        request,
        principal,
        action: "backoffice.password.change",
        outcome: error instanceof BackofficeError ? "denied" : "failure",
        resource: { type: "backoffice_account", id: principal.account.id },
        metadata: { reason: error instanceof BackofficeError ? error.code : "internal_error" },
      }).catch(() => undefined);
      throw error;
    }
    request.backoffice = issued.principal;
    reply.header("set-cookie", sessionCookie(issued.token, SESSION_TTL_SECONDS));
    return { data: publicSession(issued.principal) };
  });

  app.get("/api/admin/backoffice/accounts", async (request) => {
    const principal = assertCapability(backofficeForRequest(request), "backoffice.accounts.manage");
    const query = parseInput(z.object({
      role: z.enum([
        "platform_admin", "wash_store_admin", "inspection_station_admin", "repair_shop_admin",
      ]).optional(),
      status: z.enum(["pending_activation", "active", "password_reset", "disabled"]).optional(),
      subjectId: z.string().trim().min(1).max(120).optional(),
    }), request.query);
    const clauses = ["1=1"];
    const values: string[] = [];
    if (query.role) { clauses.push("a.role = ?"); values.push(query.role); }
    if (query.status) { clauses.push("a.status = ?"); values.push(query.status); }
    if (query.subjectId) { clauses.push("assignment.subject_id = ?"); values.push(query.subjectId); }
    const rows = await database.prepare<Row>(`
      ${accountSelectSql}
      WHERE ${clauses.join(" AND ")}
      ORDER BY a.created_at DESC, a.id DESC
    `).all(...values);
    return { data: { items: rows.map(accountDto) }, meta: { directPasswordEnabled: backofficeDirectPasswordEnabled() } };
  });

  app.get("/api/admin/repair/shops", async (request) => {
    assertCapability(backofficeForRequest(request), "backoffice.accounts.manage");
    const rows = await database.prepare<Row>(`
      SELECT id, name, is_demo, is_active
      FROM repair_shops
      ORDER BY sort_order, name, id
    `).all();
    return {
      data: {
        items: rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          isDemo: Boolean(Number(row.is_demo)),
          isActive: Boolean(Number(row.is_active)),
        })),
      },
    };
  });

  app.post("/api/admin/backoffice/accounts/invitations", async (request, reply) => {
    const principal = assertCapability(backofficeForRequest(request), "backoffice.accounts.manage");
    const input = parseInvitationBody(request.body);
    const created = await createInvitedAccount(database, input, principal);
    return reply.code(201).send({ data: created, meta: { directPasswordEnabled: backofficeDirectPasswordEnabled() } });
  });

  app.post<{ Params: { id: string } }>(
    "/api/admin/backoffice/accounts/:id/password",
    async (request) => {
      const principal = assertCapability(backofficeForRequest(request), "backoffice.accounts.manage");
      const password = parseDirectPasswordBody(request.body);
      const nowIso = new Date().toISOString();
      return database.transaction(async (tx) => {
        await applyDirectAccountPassword(tx, request.params.id, password, nowIso);
        const row = await getAccount(tx, request.params.id);
        if (!row) throw new Error("Backoffice account disappeared while setting password");
        await auditBackofficeEvent(tx, {
          request,
          principal,
          action: "backoffice.password.reset_completed",
          outcome: "success",
          resource: { type: "backoffice_account", id: request.params.id },
        });
        return { data: { account: accountDto(row) }, meta: { directPasswordEnabled: true } };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/backoffice/accounts/:id/password-reset",
    async (request) => {
      const principal = assertCapability(backofficeForRequest(request), "backoffice.accounts.manage");
      const directPassword = backofficeDirectPasswordEnabled()
        ? parseInput(z.object({ password: passwordSchema.optional() }), request.body ?? {}).password?.trim()
        : undefined;
      if (directPassword) {
        const nowIso = new Date().toISOString();
        return database.transaction(async (tx) => {
          await applyDirectAccountPassword(tx, request.params.id, directPassword, nowIso);
          const row = await getAccount(tx, request.params.id);
          if (!row) throw new Error("Backoffice account disappeared while resetting password");
          await auditBackofficeEvent(tx, {
            request,
            principal,
            action: "backoffice.password.reset_completed",
            outcome: "success",
            resource: { type: "backoffice_account", id: request.params.id },
          });
          return { data: { account: accountDto(row) }, meta: { directPasswordEnabled: true } };
        });
      }
      const now = new Date();
      return database.transaction(async (tx) => {
        const account = await tx.prepare<Row>(`
          SELECT * FROM backoffice_accounts WHERE id = ? FOR UPDATE
        `).get(request.params.id);
        if (!account) throw new BackofficeError(404, "BACKOFFICE_ACCOUNT_NOT_FOUND", "未找到该后台账号");
        if (String(account.status) === "disabled" || String(account.status) === "pending_activation") {
          throw new BackofficeError(409, "BACKOFFICE_PASSWORD_RESET_NOT_ALLOWED", "该账号当前不能重置密码");
        }
        const nowIso = now.toISOString();
        await tx.prepare(`
          UPDATE backoffice_accounts
          SET status = 'password_reset', permission_version = permission_version + 1,
            updated_at = ?::timestamptz
          WHERE id = ?
        `).run(nowIso, request.params.id);
        await revokeAccountSessions(tx, request.params.id, nowIso);
        const activation = await issueInvite(tx, request.params.id, "password_reset", principal.account.id, now);
        const row = await getAccount(tx, request.params.id);
        if (!row) throw new Error("Backoffice account disappeared during password reset");
        await auditBackofficeEvent(tx, {
          request,
          principal,
          action: "backoffice.password.reset_requested",
          outcome: "success",
          resource: { type: "backoffice_account", id: request.params.id },
        });
        return { data: { account: accountDto(row), activation } };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/backoffice/accounts/:id/disable",
    async (request) => {
      const principal = assertCapability(backofficeForRequest(request), "backoffice.accounts.manage");
      if (request.params.id === principal.account.id) {
        throw new BackofficeError(409, "BACKOFFICE_SELF_DISABLE_FORBIDDEN", "不能停用当前登录账号");
      }
      const now = new Date().toISOString();
      return database.transaction(async (tx) => {
        const before = await getAccount(tx, request.params.id);
        if (!before) throw new BackofficeError(404, "BACKOFFICE_ACCOUNT_NOT_FOUND", "未找到该后台账号");
        if (String(before.status) === "disabled") return { data: accountDto(before) };
        await tx.prepare(`
          UPDATE backoffice_accounts
          SET status = 'disabled', permission_version = permission_version + 1,
            updated_at = ?::timestamptz, disabled_at = ?::timestamptz
          WHERE id = ?
        `).run(now, now, request.params.id);
        await tx.prepare(`
          UPDATE backoffice_subject_assignments
          SET status = 'revoked', revoked_at = ?::timestamptz
          WHERE account_id = ? AND status IN ('active', 'pending')
        `).run(now, request.params.id);
        await revokeAccountSessions(tx, request.params.id, now);
        await tx.prepare(`
          UPDATE backoffice_invites SET invalidated_at = ?::timestamptz
          WHERE account_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
        `).run(now, request.params.id);
        const after = await getAccount(tx, request.params.id);
        if (!after) throw new Error("Backoffice account disappeared while disabling");
        await auditBackofficeEvent(tx, {
          request,
          principal,
          action: "backoffice.account.disabled",
          outcome: "success",
          resource: { type: "backoffice_account", id: request.params.id },
          before: accountDto(before),
          after: accountDto(after),
        });
        return { data: accountDto(after) };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/backoffice/accounts/:id/replacements",
    async (request, reply) => {
      const principal = assertCapability(backofficeForRequest(request), "backoffice.accounts.manage");
      const body = parseInput(z.object({
        loginName: loginNameSchema,
        displayName: displayNameSchema,
        password: passwordSchema.optional(),
      }), request.body);
      if (body.password && !backofficeDirectPasswordEnabled()) {
        throw new BackofficeError(403, "BACKOFFICE_DIRECT_PASSWORD_FORBIDDEN", "当前环境不支持直接设置密码，请使用激活链接");
      }
      const current = await database.prepare<Row>(`
        SELECT a.id, a.role, a.status, sa.id AS assignment_id, sa.subject_type, sa.subject_id
        FROM backoffice_accounts a
        JOIN backoffice_subject_assignments sa ON sa.account_id = a.id AND sa.status = 'active'
        WHERE a.id = ?
      `).get(request.params.id);
      if (!current) throw new BackofficeError(404, "BACKOFFICE_ACCOUNT_NOT_FOUND", "未找到有效的服务主体管理员");
      const currentRole = String(current.role) as BackofficeRole;
      if (
        !["wash_store_admin", "inspection_station_admin", "repair_shop_admin"].includes(currentRole)
        || String(current.status) !== "active"
      ) {
        throw new BackofficeError(409, "BACKOFFICE_REPLACEMENT_NOT_ALLOWED", "仅有效的服务主体管理员可以被更换");
      }
      const pending = await database.prepare<Row>(`
        SELECT id FROM backoffice_subject_assignments
        WHERE subject_type = ? AND subject_id = ? AND status = 'pending'
      `).get(String(current.subject_type), String(current.subject_id));
      if (pending) {
        throw new BackofficeError(409, "BACKOFFICE_REPLACEMENT_PENDING", "该门店已有待激活的新管理员");
      }
      const created = await createInvitedAccount(database, {
        ...body,
        role: currentRole,
        subject: {
          type: String(current.subject_type) as BackofficeSubjectType,
          id: String(current.subject_id),
        },
      }, principal, String(current.assignment_id));
      return reply.code(201).send({ data: created });
    },
  );

  const visibleAuditSql = `
    e.action NOT LIKE 'backoffice.http.%'
    AND e.action <> 'backoffice.accounts.listed'
    AND e.action <> 'wash.request.rejected'
    AND e.action <> 'wash.order.note_update'
    AND e.action NOT LIKE 'customer.%'
    AND (
      e.metadata_json ?? 'presentation'
      OR e.action LIKE 'backoffice.%'
      OR e.action LIKE 'wash.%'
      OR e.action LIKE 'booking.%'
      OR e.action LIKE 'inspection.%'
      OR e.action LIKE 'repair.%'
      OR e.action LIKE 'car_rental.%'
      OR e.action LIKE 'rental.%'
      OR e.action LIKE 'insurance.%'
      OR e.action LIKE 'driving_school.%'
      OR e.action LIKE 'driving.%'
      OR e.action LIKE 'subsidy.%'
    )
  `;
  const auditCategorySql = `COALESCE(
    e.metadata_json #>> '{presentation,category}',
    CASE
      WHEN e.action LIKE 'backoffice.%' THEN 'account_security'
      WHEN e.action LIKE 'booking.%' OR e.action LIKE 'inspection.%' THEN 'inspection'
      WHEN e.action LIKE 'wash.%' THEN 'wash'
      WHEN e.action LIKE 'repair.%' THEN 'repair'
      WHEN e.action LIKE 'rental.%' OR e.action LIKE 'car_rental.%' THEN 'car_rental'
      WHEN e.action LIKE 'insurance.%' THEN 'insurance'
      WHEN e.action LIKE 'driving_school.%' OR e.action LIKE 'driving.%' THEN 'driving_school'
      WHEN e.action LIKE 'subsidy.%' THEN 'subsidy'
      ELSE 'account_security'
    END
  )`;

  app.get("/api/admin/audit-events", async (request) => {
    const principal = backofficeForRequest(request);
    if (!hasCapability(principal, "audit.all.read") && !hasCapability(principal, "audit.self.read")) {
      throw new BackofficeError(403, "BACKOFFICE_FORBIDDEN", "当前账号无权查看操作日志");
    }
    const query = parseInput(z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
      category: z.enum([
        "account_security", "inspection", "wash", "repair", "car_rental",
        "insurance", "driving_school", "subsidy",
      ]).optional(),
      outcome: z.enum(["success", "denied", "failure"]).optional(),
      accountId: z.string().trim().min(1).max(120).optional(),
      subjectId: z.string().trim().min(1).max(120).optional(),
      keyword: z.string().trim().min(1).max(120).optional(),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    }), request.query);
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new BackofficeError(400, "BACKOFFICE_AUDIT_DATE_RANGE_INVALID", "结束日期不能早于开始日期");
    }
    const clauses = [`(${visibleAuditSql})`];
    const values: Array<string | number> = [];
    if (principal.account.role !== "platform_admin") {
      if (query.accountId && query.accountId !== principal.account.id) {
        throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
      }
      if (!principal.subject) {
        throw new BackofficeError(403, "BACKOFFICE_SUBJECT_REQUIRED", "当前账号未绑定服务主体");
      }
      if (query.subjectId && query.subjectId !== principal.subject.id) {
        throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该资源");
      }
      clauses.push("e.account_id = ?", "e.subject_type = ?", "e.subject_id = ?");
      values.push(principal.account.id, principal.subject.type, principal.subject.id);
    } else {
      if (query.accountId) { clauses.push("e.account_id = ?"); values.push(query.accountId); }
      if (query.subjectId) { clauses.push("e.subject_id = ?"); values.push(query.subjectId); }
    }
    if (query.category) { clauses.push(`${auditCategorySql} = ?`); values.push(query.category); }
    if (query.outcome) { clauses.push("e.outcome = ?"); values.push(query.outcome); }
    if (query.dateFrom) { clauses.push("e.occurred_at >= ?::date"); values.push(query.dateFrom); }
    if (query.dateTo) { clauses.push("e.occurred_at < (?::date + INTERVAL '1 day')"); values.push(query.dateTo); }
    if (query.keyword) {
      clauses.push(`(
        e.actor_display_name ILIKE ?
        OR e.actor_login_name ILIKE ?
        OR COALESCE(e.metadata_json ->> 'loginName', '') ILIKE ?
        OR COALESCE(e.metadata_json #>> '{presentation,subjectName}', ws.name, ist.name, rs.name, '') ILIKE ?
        OR COALESCE(e.metadata_json #>> '{presentation,resourceLabel}', '') ILIKE ?
        OR COALESCE(e.metadata_json #>> '{presentation,summary}', '') ILIKE ?
      )`);
      const keyword = `%${query.keyword}%`;
      values.push(keyword, keyword, keyword, keyword, keyword, keyword);
    }
    const where = clauses.join(" AND ");
    const count = await database.prepare<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM backoffice_audit_events e
      LEFT JOIN wash_stores ws ON e.subject_type = 'wash_store' AND ws.id = e.subject_id
      LEFT JOIN stations ist ON e.subject_type = 'inspection_station' AND ist.id = e.subject_id
      LEFT JOIN repair_shops rs ON e.subject_type = 'repair_shop' AND rs.id = e.subject_id
      WHERE ${where}
    `).get(...values);
    const rows = await database.prepare<Row>(`
      SELECT e.*, COALESCE(ws.name, ist.name, rs.name) AS subject_name
      FROM backoffice_audit_events e
      LEFT JOIN wash_stores ws ON e.subject_type = 'wash_store' AND ws.id = e.subject_id
      LEFT JOIN stations ist ON e.subject_type = 'inspection_station' AND ist.id = e.subject_id
      LEFT JOIN repair_shops rs ON e.subject_type = 'repair_shop' AND rs.id = e.subject_id
      WHERE ${where}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ? OFFSET ?
    `).all(...values, query.pageSize, (query.page - 1) * query.pageSize);
    return {
      data: { items: rows.map((row) => backofficeAuditEventDto(row)) },
      meta: { page: query.page, pageSize: query.pageSize, total: Number(count?.count ?? 0) },
    };
  });

  app.get<{ Params: { id: string } }>("/api/admin/audit-events/:id", async (request) => {
    const principal = backofficeForRequest(request);
    if (!hasCapability(principal, "audit.all.read") && !hasCapability(principal, "audit.self.read")) {
      throw new BackofficeError(403, "BACKOFFICE_FORBIDDEN", "当前账号无权查看操作记录");
    }
    const clauses = ["e.id = ?", `(${visibleAuditSql})`];
    const values: string[] = [request.params.id];
    if (principal.account.role !== "platform_admin") {
      if (!principal.subject) {
        throw new BackofficeError(403, "BACKOFFICE_SUBJECT_REQUIRED", "当前账号未绑定服务主体");
      }
      clauses.push("e.account_id = ?", "e.subject_type = ?", "e.subject_id = ?");
      values.push(principal.account.id, principal.subject.type, principal.subject.id);
    }
    const row = await database.prepare<Row>(`
      SELECT e.*, COALESCE(ws.name, ist.name, rs.name) AS subject_name
      FROM backoffice_audit_events e
      LEFT JOIN wash_stores ws ON e.subject_type = 'wash_store' AND ws.id = e.subject_id
      LEFT JOIN stations ist ON e.subject_type = 'inspection_station' AND ist.id = e.subject_id
      LEFT JOIN repair_shops rs ON e.subject_type = 'repair_shop' AND rs.id = e.subject_id
      WHERE ${clauses.join(" AND ")}
      LIMIT 1
    `).get(...values);
    if (!row) throw new BackofficeError(404, "BACKOFFICE_RESOURCE_NOT_FOUND", "未找到该操作记录");
    return { data: backofficeAuditEventDto(row, true) };
  });
}
