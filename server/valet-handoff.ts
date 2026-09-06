import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import { assertAnnualBookingFinancialClosureReady } from "./annual-booking-finance.js";
import { auditBackofficeEvent, backofficeForRequest } from "./backoffice.js";
import type { AppDatabase } from "./database.js";
import {
  acknowledgeAnnualDriverClaim,
  syncAnnualWorkflowForBooking,
  type WorkflowSyncOptions,
} from "./workflow-integration.js";

type Row = Record<string, unknown>;
type ProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

export const VALET_EVIDENCE_POLICY_VERSION = "valet-handoff-v1";

export const valetEvidenceStages = [
  "owner_pickup",
  "station_arrival",
  "inspection_complete",
  "owner_return",
] as const;
export type ValetEvidenceStage = typeof valetEvidenceStages[number];

export const valetEvidenceKinds = [
  "front_left",
  "front_right",
  "rear_left",
  "rear_right",
  "dashboard_started",
] as const;
export type ValetEvidenceKind = typeof valetEvidenceKinds[number];

type EvidenceAudience = "owner" | "admin" | "operator" | "driver";

const evidenceKindSchema = z.enum(valetEvidenceKinds);
const assignmentSchema = z.object({
  receptionistName: z.string().trim().min(2).max(40),
  receptionistPhone: z.string().trim().regex(/^1\d{10}$/u, "请输入有效的 11 位手机号"),
});
const taskExchangeSchema = z.object({
  taskCode: z.string().trim().min(20).max(240).optional(),
  verificationCode: z.string().trim().regex(/^\d{6}$/u, "请输入 6 位数字验证码").optional(),
}).superRefine((value, context) => {
  if (Boolean(value.taskCode) === Boolean(value.verificationCode)) {
    context.addIssue({
      code: "custom",
      path: ["verificationCode"],
      message: "请提交一种代驾任务凭证",
    });
  }
});
const completionSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(160) });
const stationCompletionSchema = completionSchema.extend({
  verification: z.object({
    plateMatched: z.boolean(),
    materialsReady: z.boolean(),
    exteriorRecorded: z.boolean(),
    vehicleConditionConfirmed: z.boolean(),
    notes: z.string().trim().max(500).optional(),
  }),
});

const stageLabels: Record<ValetEvidenceStage, string> = {
  owner_pickup: "上门取车留证",
  station_arrival: "检测站到车留证",
  inspection_complete: "检测完成留证",
  owner_return: "车辆送回留证",
};

const verificationCodeFirstClaimTtlMs = 24 * 60 * 60 * 1_000;
const driverSessionTtlMs = 7 * 24 * 60 * 60 * 1_000;
const driverCodeUserFailureLimit = 5;
const driverCodeIpFailureLimit = 20;
const driverCodeFailureWindowMinutes = 15;
const demoDriverCodeDataKey = createHash("sha256")
  .update("yuxiaoman-valet-driver-code-demo-data-key-v1")
  .digest();
const demoDriverCodeHmacKey = "yuxiaoman-valet-driver-code-demo-hmac-key-v1";

function productionEnvironment(): boolean {
  return process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
}

function parseDriverCodeDataKey(): Buffer | null {
  const value = process.env.VALET_DRIVER_CODE_DATA_KEY?.trim();
  if (!value) return null;
  if (/^[a-f0-9]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function driverCodeDataKey(problem?: ProblemFactory): Buffer | null {
  const configured = parseDriverCodeDataKey();
  if (configured) return configured;
  if (!productionEnvironment()) return demoDriverCodeDataKey;
  if (problem) throw problem(503, "DRIVER_CODE_CRYPTO_UNAVAILABLE", "代驾验证码安全配置不可用");
  return null;
}

function driverCodeHmacKey(problem?: ProblemFactory): string | null {
  const configured = process.env.VALET_DRIVER_CODE_HMAC_KEY?.trim();
  if (configured && configured.length >= 32) return configured;
  if (!productionEnvironment()) return demoDriverCodeHmacKey;
  if (problem) throw problem(503, "DRIVER_CODE_CRYPTO_UNAVAILABLE", "代驾验证码安全配置不可用");
  return null;
}

function driverVerificationCodeHmac(code: string, problem?: ProblemFactory): string | null {
  const key = driverCodeHmacKey(problem);
  return key ? createHmac("sha256", key).update(`verification-code:v1:${code}`).digest("hex") : null;
}

function encryptDriverVerificationCode(code: string, assignmentId: string, problem: ProblemFactory): string {
  const key = driverCodeDataKey(problem)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`valet-driver-assignment:${assignmentId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptDriverVerificationCode(value: unknown, assignmentId: string): string | null {
  if (!value) return null;
  const key = driverCodeDataKey();
  if (!key) return null;
  const [version, ivValue, tagValue, ciphertextValue] = String(value).split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(Buffer.from(`valet-driver-assignment:${assignmentId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return /^\d{6}$/u.test(plaintext) ? plaintext : null;
  } catch {
    return null;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function driverCodeIpHash(request: FastifyRequest, problem: ProblemFactory): string {
  const key = driverCodeHmacKey(problem)!;
  // Fastify derives request.ip from the socket or a separately configured
  // trusted proxy. Never consume X-Forwarded-For directly here.
  return createHmac("sha256", key)
    .update(`driver-code-ip:v1:${request.ip || "unknown"}`)
    .digest("hex");
}

async function lockDriverCodeBuckets(
  database: AppDatabase,
  userId: string,
  ipHash: string,
): Promise<void> {
  for (const bucket of [`driver-code-ip:${ipHash}`, `driver-code-user:${userId}`].sort()) {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(bucket);
  }
}

async function driverCodeIsRateLimited(
  database: AppDatabase,
  userId: string,
  ipHash: string,
): Promise<boolean> {
  const row = await database.prepare<{ user_count: string; ip_count: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE user_id = ?)::text AS user_count,
      COUNT(*) FILTER (WHERE ip_hash = ?)::text AS ip_count
    FROM valet_driver_code_attempts
    WHERE succeeded = FALSE
      AND attempted_at > NOW() - INTERVAL '${driverCodeFailureWindowMinutes} minutes'
  `).get(userId, ipHash);
  return Number(row?.user_count ?? 0) >= driverCodeUserFailureLimit
    || Number(row?.ip_count ?? 0) >= driverCodeIpFailureLimit;
}

async function recordDriverCodeAttempt(
  database: AppDatabase,
  userId: string,
  ipHash: string,
  succeeded: boolean,
  now: string,
): Promise<void> {
  await database.prepare(`
    INSERT INTO valet_driver_code_attempts (id, user_id, ip_hash, succeeded, attempted_at)
    VALUES (?, ?, ?, ?, ?::timestamptz)
  `).run(randomUUID(), userId, ipHash, succeeded, now);
  if (succeeded) {
    await database.prepare(`
      DELETE FROM valet_driver_code_attempts
      WHERE succeeded = FALSE AND user_id = ? AND ip_hash = ?
    `).run(userId, ipHash);
  }
  await database.prepare(`
    DELETE FROM valet_driver_code_attempts
    WHERE attempted_at < NOW() - INTERVAL '1 day'
  `).run();
}

async function generateDriverVerificationCode(
  database: AppDatabase,
  assignmentId: string,
  problem: ProblemFactory,
): Promise<{ code: string; hmac: string; ciphertext: string }> {
  // A six-digit namespace is intentionally small enough for a person to type.
  // Serialize generation and enforce the unique HMAC index so two concurrent
  // assignments can never issue the same active code.
  await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .get("valet-driver-verification-code-generation:v1");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const hmac = driverVerificationCodeHmac(code, problem)!;
    const existing = await database.prepare<Row>(`
      SELECT id FROM valet_driver_assignments WHERE verification_code_hmac = ?
    `).get(hmac);
    if (!existing) {
      return {
        code,
        hmac,
        ciphertext: encryptDriverVerificationCode(code, assignmentId, problem),
      };
    }
  }
  throw problem(503, "DRIVER_CODE_GENERATION_UNAVAILABLE", "暂时无法生成代驾验证码，请稍后重试");
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalStatus(row: Row): string {
  const fulfillment = String(row.fulfillment_status ?? "legacy");
  return fulfillment === "legacy" ? String(row.status) : fulfillment;
}

function isEvidencePolicyBooking(row: Row): boolean {
  return String(row.service_mode) === "valet"
    && String(row.evidence_policy_version ?? "legacy") === VALET_EVIDENCE_POLICY_VERSION;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, problem: ProblemFactory): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join("."), issue.message]));
    throw problem(400, "VALIDATION_ERROR", "请检查提交内容", fields);
  }
  return parsed.data;
}

function maskPhone(value: string): string {
  return value.replace(/^(\d{3})\d{4}(\d{4})$/u, "$1****$2");
}

function ownerDriverName(value: string): string {
  const first = [...value.trim()][0];
  return first ? `${first}师傅` : "代驾司机";
}

type VerificationCodeStatus = "active" | "bound" | "expired" | "completed" | "cancelled" | "unavailable";

function verificationCodeView(row: Row): {
  verificationCode: string | null;
  verificationCodeExpiresAt: string | null;
  verificationCodeStatus: VerificationCodeStatus;
} {
  const assignmentStatus = String(row.status);
  const expiresAt = row.verification_code_expires_at == null
    ? null
    : String(row.verification_code_expires_at);
  if (assignmentStatus === "completed") {
    return { verificationCode: null, verificationCodeExpiresAt: expiresAt, verificationCodeStatus: "completed" };
  }
  if (assignmentStatus === "cancelled") {
    return { verificationCode: null, verificationCodeExpiresAt: expiresAt, verificationCodeStatus: "cancelled" };
  }
  const code = decryptDriverVerificationCode(row.verification_code_ciphertext, String(row.id));
  if (!code) {
    return { verificationCode: null, verificationCodeExpiresAt: expiresAt, verificationCodeStatus: "unavailable" };
  }
  if (row.bound_user_id != null) {
    return { verificationCode: code, verificationCodeExpiresAt: expiresAt, verificationCodeStatus: "bound" };
  }
  if (!expiresAt || expiresAt <= new Date().toISOString()) {
    return { verificationCode: code, verificationCodeExpiresAt: expiresAt, verificationCodeStatus: "expired" };
  }
  return { verificationCode: code, verificationCodeExpiresAt: expiresAt, verificationCodeStatus: "active" };
}

function assignmentDto(row: Row, audience: EvidenceAudience, revealVerificationCode = false) {
  const full = audience !== "owner";
  const receptionistName = String(row.receptionist_name ?? row.driver_name ?? "");
  const receptionistPhone = String(row.receptionist_phone ?? row.driver_phone ?? "");
  // Compatibility: keep driverName/Phone aliases until pickup/return executors ship.
  const driverName = receptionistName;
  const driverPhone = receptionistPhone;
  return {
    id: String(row.id),
    status: String(row.status),
    receptionistName: full ? receptionistName : ownerDriverName(receptionistName),
    receptionistPhone: full ? receptionistPhone : maskPhone(receptionistPhone),
    driverName: full ? driverName : ownerDriverName(driverName),
    driverPhone: full ? driverPhone : maskPhone(driverPhone),
    assignedAt: String(row.assigned_at),
    boundAt: row.bound_at == null ? null : String(row.bound_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    ...(audience === "admin" && revealVerificationCode ? verificationCodeView(row) : {}),
  };
}

function evidenceMediaUrl(
  audience: EvidenceAudience,
  bookingId: string,
  packageId: string,
  stage: ValetEvidenceStage,
  mediaId: string,
): string {
  if (audience === "driver") {
    return `/api/driver/tasks/${bookingId}/evidence/${stage}/media/${mediaId}`;
  }
  return `/api/${audience === "owner" ? "bookings" : `${audience}/bookings`}/${bookingId}/evidence/${packageId}/media/${mediaId}`;
}

function mediaDto(
  row: Row,
  audience: EvidenceAudience,
  bookingId: string,
  packageId: string,
  stage: ValetEvidenceStage,
) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    url: evidenceMediaUrl(audience, bookingId, packageId, stage, String(row.id)),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: String(row.created_at),
  };
}

async function assignmentForBooking(database: AppDatabase, bookingId: string): Promise<Row | undefined> {
  return database.prepare<Row>(`
    SELECT * FROM valet_driver_assignments WHERE booking_id = ? AND status <> 'cancelled'
  `).get(bookingId);
}

async function persistedBackofficeAccountId(database: AppDatabase, accountId: string): Promise<string | null> {
  const row = await database.prepare<Row>("SELECT id FROM backoffice_accounts WHERE id = ?").get(accountId);
  return row ? String(row.id) : null;
}

async function reportMediaForPackage(database: AppDatabase, packageRow: Row): Promise<Row[]> {
  if (String(packageRow.source_type) !== "checkup_report" || packageRow.source_report_id == null) return [];
  return database.prepare<Row>(`
    SELECT * FROM vehicle_checkup_media
    WHERE report_id = ? AND kind = ANY(?)
    ORDER BY created_at ASC, id ASC
  `).all(String(packageRow.source_report_id), [...valetEvidenceKinds]);
}

async function uploadedMediaForPackages(database: AppDatabase, packageIds: string[]): Promise<Row[]> {
  if (!packageIds.length) return [];
  return database.prepare<Row>(`
    SELECT * FROM valet_evidence_media WHERE package_id = ANY(?) ORDER BY created_at ASC, id ASC
  `).all(packageIds);
}

export async function valetHandoffDetail(
  database: AppDatabase,
  bookingId: string,
  audience: EvidenceAudience,
  options: { revealDriverVerificationCode?: boolean } = {},
): Promise<{
  evidencePolicyVersion: string;
  driverAssignment: ReturnType<typeof assignmentDto> | null;
  evidencePackages: Array<Record<string, unknown>>;
}> {
  const booking = await database.prepare<Row>(`
    SELECT id, service_mode, evidence_policy_version FROM bookings WHERE id = ?
  `).get(bookingId);
  if (!booking) return { evidencePolicyVersion: "legacy", driverAssignment: null, evidencePackages: [] };
  const policy = String(booking.evidence_policy_version ?? "legacy");
  const assignment = await assignmentForBooking(database, bookingId);
  if (String(booking.service_mode) !== "valet" || policy !== VALET_EVIDENCE_POLICY_VERSION) {
    return {
      evidencePolicyVersion: policy,
      driverAssignment: assignment
        ? assignmentDto(assignment, audience, options.revealDriverVerificationCode === true)
        : null,
      evidencePackages: [],
    };
  }

  const packageRows = await database.prepare<Row>(`
    SELECT * FROM valet_evidence_packages WHERE booking_id = ? ORDER BY created_at ASC, id ASC
  `).all(bookingId);
  const packageByStage = new Map(packageRows.map((row) => [String(row.stage), row]));
  const uploaded = await uploadedMediaForPackages(
    database,
    packageRows.filter((row) => String(row.source_type) === "uploaded").map((row) => String(row.id)),
  );
  const uploadedByPackage = new Map<string, Row[]>();
  for (const row of uploaded) {
    const key = String(row.package_id);
    const rows = uploadedByPackage.get(key) ?? [];
    rows.push(row);
    uploadedByPackage.set(key, rows);
  }

  const evidencePackages: Array<Record<string, unknown>> = [];
  for (const stage of valetEvidenceStages) {
    const packageRow = packageByStage.get(stage);
    if (!packageRow) {
      evidencePackages.push({
        id: null,
        stage,
        label: stageLabels[stage],
        status: "pending",
        capturedAt: null,
        capturedByLabel: null,
        photos: [],
      });
      continue;
    }
    const packageId = String(packageRow.id);
    const mediaRows = String(packageRow.source_type) === "checkup_report"
      ? await reportMediaForPackage(database, packageRow)
      : uploadedByPackage.get(packageId) ?? [];
    const ownerMaySeePhotos = audience !== "owner" || String(packageRow.status) === "completed";
    const capturedByLabel = packageRow.captured_by_label == null
      ? null
      : audience === "owner" && String(packageRow.captured_by_actor_type) === "driver"
        ? ownerDriverName(String(packageRow.captured_by_label))
        : String(packageRow.captured_by_label);
    evidencePackages.push({
      id: packageId,
      stage,
      label: stageLabels[stage],
      status: String(packageRow.status),
      capturedAt: packageRow.completed_at == null ? null : String(packageRow.completed_at),
      capturedByLabel,
      photos: ownerMaySeePhotos
        ? mediaRows.map((row) => mediaDto(row, audience, bookingId, packageId, stage))
        : [],
    });
  }
  return {
    evidencePolicyVersion: policy,
    driverAssignment: assignment
      ? assignmentDto(assignment, audience, options.revealDriverVerificationCode === true)
      : null,
    evidencePackages,
  };
}

async function insertBookingEvent(
  database: AppDatabase,
  bookingId: string,
  status: string,
  title: string,
  description: string,
  actorType: "operator" | "driver",
  metadata: Record<string, unknown>,
  createdAt: string,
  workflowOptions: Pick<WorkflowSyncOptions, "verificationCode" | "forceReopenNodeCodes" | "suppressNodeCodes"> = {},
): Promise<void> {
  await database.prepare(`
    INSERT INTO booking_events (
      id, booking_id, status, title, description, actor_type, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), bookingId, status, title, description, actorType, JSON.stringify(metadata), createdAt);
  await syncAnnualWorkflowForBooking(database, bookingId, {
    ...workflowOptions,
    now: new Date(createdAt),
    actorType: actorType === "operator" ? "station" : "driver",
  });
}

async function ensurePendingPackage(
  database: AppDatabase,
  bookingId: string,
  stage: ValetEvidenceStage,
  now: string,
): Promise<Row> {
  let row = await database.prepare<Row>(`
    SELECT * FROM valet_evidence_packages WHERE booking_id = ? AND stage = ? FOR UPDATE
  `).get(bookingId, stage);
  if (row) return row;
  const id = randomUUID();
  await database.prepare(`
    INSERT INTO valet_evidence_packages (
      id, booking_id, stage, status, source_type, source_report_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', 'uploaded', NULL, ?, ?)
  `).run(id, bookingId, stage, now, now);
  row = await database.prepare<Row>("SELECT * FROM valet_evidence_packages WHERE id = ? FOR UPDATE").get(id);
  if (!row) throw new Error("evidence package insert did not persist");
  return row;
}

async function assertUploadedPackageComplete(
  database: AppDatabase,
  packageRow: Row,
  problem: ProblemFactory,
): Promise<void> {
  const rows = await database.prepare<Row>(`
    SELECT kind FROM valet_evidence_media WHERE package_id = ?
  `).all(String(packageRow.id));
  const kinds = new Set(rows.map((row) => String(row.kind)));
  const missing = valetEvidenceKinds.filter((kind) => !kinds.has(kind));
  if (missing.length) {
    throw problem(409, "VALET_EVIDENCE_INCOMPLETE", "请先补齐本节点的 5 张车辆留证照片", {
      photos: `缺少：${missing.join("、")}`,
    });
  }
}

export async function assertValetEvidenceCompleted(
  database: AppDatabase,
  bookingRow: Row,
  stage: ValetEvidenceStage,
  problem: ProblemFactory,
): Promise<void> {
  if (!isEvidencePolicyBooking(bookingRow)) return;
  const row = await database.prepare<Row>(`
    SELECT status FROM valet_evidence_packages WHERE booking_id = ? AND stage = ?
  `).get(String(bookingRow.id), stage);
  if (!row || String(row.status) !== "completed") {
    throw problem(409, "VALET_EVIDENCE_REQUIRED", `请先完成${stageLabels[stage]}`);
  }
}

/**
 * Protects the generic admin status editor from bypassing the dedicated,
 * atomic evidence actions. Resuming an on-hold order is still possible, but
 * only after the corresponding action has already committed its proof marker.
 */
export async function assertValetAdminTransitionReady(
  database: AppDatabase,
  bookingRow: Row,
  targetStatus: string,
  problem: ProblemFactory,
): Promise<void> {
  if (!isEvidencePolicyBooking(bookingRow)) return;
  if (targetStatus === "driver_arranged") {
    const assignment = await database.prepare<Row>(`
      SELECT id FROM valet_driver_assignments
      WHERE booking_id = ? AND status IN ('assigned', 'bound', 'in_progress', 'completed')
    `).get(String(bookingRow.id));
    if (!assignment) {
      throw problem(409, "VALET_DRIVER_ASSIGNMENT_REQUIRED", "请通过安排司机功能生成代驾任务后再推进");
    }
    return;
  }
  const stageByStatus: Partial<Record<string, ValetEvidenceStage>> = {
    picked_up: "owner_pickup",
    checked_in: "station_arrival",
    inspecting: "station_arrival",
    result_received: "inspection_complete",
    returning: "inspection_complete",
    completed: "owner_return",
  };
  const stage = stageByStatus[targetStatus];
  if (!stage) return;
  await assertValetEvidenceCompleted(database, bookingRow, stage, problem);
  if (targetStatus === "returning") {
    const assignment = await database.prepare<Row>(`
      SELECT return_start_idempotency_key FROM valet_driver_assignments
      WHERE booking_id = ? AND status IN ('in_progress', 'completed')
    `).get(String(bookingRow.id));
    if (!assignment || assignment.return_start_idempotency_key == null) {
      throw problem(409, "VALET_DRIVER_RETURN_REQUIRED", "请由已绑定司机从任务入口开始返程");
    }
  }
  if (targetStatus === "completed") {
    const assignment = await database.prepare<Row>(`
      SELECT status FROM valet_driver_assignments WHERE booking_id = ?
    `).get(String(bookingRow.id));
    if (!assignment || String(assignment.status) !== "completed") {
      throw problem(409, "VALET_DRIVER_RETURN_REQUIRED", "请由已绑定司机完成送回留证");
    }
  }
}

type DriverPrincipal = {
  sessionId: string;
  assignmentId: string;
  bookingId: string;
  userId: string;
  driverName: string;
};

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/iu);
  return match?.[1];
}

async function requireDriverPrincipal(
  request: FastifyRequest,
  database: AppDatabase,
  problem: ProblemFactory,
  bookingId?: string,
): Promise<DriverPrincipal> {
  const token = bearerToken(request);
  if (!token || !token.startsWith("yxm_drv_")) {
    throw problem(401, "DRIVER_AUTHENTICATION_REQUIRED", "需要有效的代驾任务会话");
  }
  const now = new Date().toISOString();
  const row = await database.prepare<Row>(`
    SELECT s.id AS session_id, s.user_id, a.id AS assignment_id, a.booking_id,
      a.driver_name, a.status AS assignment_status, a.bound_user_id
    FROM valet_driver_sessions s
    JOIN valet_driver_assignments a ON a.id = s.assignment_id
    JOIN bookings b ON b.id = a.booking_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      AND a.status NOT IN ('completed', 'cancelled') AND a.bound_user_id = s.user_id
      AND b.status NOT IN ('completed', 'cancelled', 'no_show')
      AND COALESCE(b.fulfillment_status, 'legacy') NOT IN ('completed', 'cancelled', 'no_show')
    LIMIT 1
  `).get(sha256(token), now);
  if (!row || (bookingId && String(row.booking_id) !== bookingId)) {
    throw problem(404, "DRIVER_TASK_NOT_FOUND", "未找到可访问的代驾任务");
  }
  await database.prepare(`
    UPDATE valet_driver_sessions SET last_seen_at = ?
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
  `).run(now, String(row.session_id), new Date(Date.parse(now) - 5 * 60_000).toISOString());
  return {
    sessionId: String(row.session_id),
    assignmentId: String(row.assignment_id),
    bookingId: String(row.booking_id),
    userId: String(row.user_id),
    driverName: String(row.driver_name),
  };
}

type NormalizedPhoto = {
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
  kind: ValetEvidenceKind;
};

function multipartField(fields: unknown, name: string): string {
  if (!fields || typeof fields !== "object") return "";
  const candidate = (fields as Record<string, unknown>)[name];
  if (!candidate || typeof candidate !== "object" || !("value" in candidate)) return "";
  return String((candidate as { value: unknown }).value ?? "");
}

async function normalizeUploadedPhoto(request: FastifyRequest, problem: ProblemFactory): Promise<NormalizedPhoto> {
  let part;
  try {
    part = await request.file();
  } catch {
    throw problem(413, "VALET_EVIDENCE_MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
  }
  if (!part) throw problem(400, "VALET_EVIDENCE_MEDIA_REQUIRED", "请选择要上传的照片");
  const kind = evidenceKindSchema.safeParse(multipartField(part.fields, "kind"));
  if (!kind.success) throw problem(400, "VALET_EVIDENCE_KIND_INVALID", "照片位置无效");
  if (!/^image\/(jpeg|png|webp|heic|heif)$/iu.test(part.mimetype)) {
    throw problem(415, "VALET_EVIDENCE_MEDIA_TYPE_INVALID", "仅支持 JPEG、PNG、WebP 或 HEIC 图片");
  }
  let source: Buffer;
  try {
    source = await part.toBuffer();
  } catch {
    throw problem(413, "VALET_EVIDENCE_MEDIA_TOO_LARGE", "单张原图不能超过 10MB");
  }
  let processed;
  try {
    processed = await sharp(source, { failOn: "error" })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw problem(400, "VALET_EVIDENCE_MEDIA_INVALID", "图片已损坏或无法识别，请重新拍摄");
  }
  return {
    data: processed.data,
    width: processed.info.width,
    height: processed.info.height,
    sha256: sha256(processed.data),
    kind: kind.data,
  };
}

async function unlinkStored(directory: string, storageKey: unknown): Promise<void> {
  if (typeof storageKey !== "string" || !storageKey) return;
  await unlink(join(directory, storageKey)).catch(() => undefined);
}

async function requireTaskBooking(
  database: AppDatabase,
  bookingId: string,
  problem: ProblemFactory,
  lock = false,
): Promise<Row> {
  const row = await database.prepare<Row>(`
    SELECT * FROM bookings WHERE id = ?${lock ? " FOR UPDATE" : ""}
  `).get(bookingId);
  if (!row
    || !isEvidencePolicyBooking(row)
    || ["cancelled", "no_show"].includes(String(row.status))
    || ["cancelled", "no_show"].includes(String(row.fulfillment_status))) {
    throw problem(404, "DRIVER_TASK_NOT_FOUND", "未找到可访问的代驾任务");
  }
  return row;
}

/**
 * Invalidates every driver entry point for a booking inside the caller's
 * transaction. Cancellation must revoke both the task code and already-issued
 * sessions so neither a fresh exchange nor a cached bearer can outlive the
 * booking.
 */
export async function cancelValetDriverTaskForBooking(
  database: AppDatabase,
  bookingId: string,
  now = new Date().toISOString(),
): Promise<void> {
  const assignment = await database.prepare<Row>(`
    SELECT id FROM valet_driver_assignments WHERE booking_id = ? FOR UPDATE
  `).get(bookingId);
  if (!assignment) return;
  await database.prepare(`
    UPDATE valet_driver_assignments SET status = 'cancelled', task_code_hash = NULL,
      task_code_expires_at = NULL, verification_code_hmac = NULL,
      verification_code_ciphertext = NULL, verification_code_expires_at = NULL,
      cancelled_at = COALESCE(cancelled_at, ?), updated_at = ?
    WHERE id = ?
  `).run(now, now, String(assignment.id));
  await database.prepare(`
    UPDATE valet_driver_sessions SET revoked_at = COALESCE(revoked_at, ?)
    WHERE assignment_id = ? AND revoked_at IS NULL
  `).run(now, String(assignment.id));
}

async function driverTaskDto(
  database: AppDatabase,
  bookingId: string,
): Promise<Record<string, unknown>> {
  const booking = await database.prepare<Row>(`
    SELECT b.*, v.plate_number, v.vehicle_type, v.brand_name, v.model_name,
      s.name AS station_name, s.address AS station_address, s.district AS station_district,
      s.latitude AS station_latitude, s.longitude AS station_longitude
    FROM bookings b
    LEFT JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN stations s ON s.id = b.station_id
    WHERE b.id = ?
  `).get(bookingId);
  if (!booking) throw new Error("driver task booking disappeared");
  const vehicleSnapshot = jsonObject(booking.vehicle_snapshot_json);
  const snapshotBrand = jsonObject(vehicleSnapshot.brand);
  const snapshotModel = jsonObject(vehicleSnapshot.model);
  const assignment = await assignmentForBooking(database, bookingId);
  if (!assignment) throw new Error("driver task assignment disappeared");
  const events = await database.prepare<Row>(`
    SELECT * FROM booking_events WHERE booking_id = ? ORDER BY created_at ASC, id ASC
  `).all(bookingId);
  const handoff = await valetHandoffDetail(database, bookingId, "driver");
  return {
    taskId: String(assignment.id),
    bookingId,
    bookingNumber: String(booking.booking_number),
    status: canonicalStatus(booking),
    appointmentDate: String(booking.appointment_date),
    startTime: String(booking.start_time),
    endTime: String(booking.end_time),
    evidencePolicyVersion: handoff.evidencePolicyVersion,
    vehicle: {
      plateNumber: String(vehicleSnapshot.plateNumber ?? booking.plate_number ?? ""),
      brandName: snapshotBrand.name == null
        ? (booking.brand_name == null ? null : String(booking.brand_name))
        : String(snapshotBrand.name),
      modelName: snapshotModel.name == null
        ? (booking.model_name == null ? null : String(booking.model_name))
        : String(snapshotModel.name),
      vehicleType: vehicleSnapshot.vehicleType == null
        ? (booking.vehicle_type == null ? null : String(booking.vehicle_type))
        : String(vehicleSnapshot.vehicleType),
      exteriorColor: vehicleSnapshot.exteriorColor == null ? null : String(vehicleSnapshot.exteriorColor),
    },
    owner: {
      contactName: String(booking.contact_name),
      contactPhone: String(booking.contact_phone),
    },
    pickupAddress: booking.pickup_poi_id == null ? null : {
      title: String(booking.pickup_title),
      address: String(booking.pickup_address),
      district: String(booking.pickup_district),
      latitude: Number(booking.pickup_latitude),
      longitude: Number(booking.pickup_longitude),
      detail: booking.pickup_detail == null ? "" : String(booking.pickup_detail),
      note: booking.pickup_note == null ? "" : String(booking.pickup_note),
    },
    station: {
      id: String(booking.station_id),
      name: String(booking.station_name ?? "检测站"),
      address: String(booking.station_address ?? ""),
      district: String(booking.station_district ?? ""),
      latitude: Number(booking.station_latitude ?? 0),
      longitude: Number(booking.station_longitude ?? 0),
    },
    driverAssignment: assignmentDto(assignment, "driver"),
    evidencePackages: handoff.evidencePackages,
    events: events.map((event) => ({
      id: String(event.id),
      status: String(event.status),
      title: String(event.title),
      description: String(event.description),
      actorType: String(event.actor_type),
      createdAt: String(event.created_at),
    })),
  };
}

async function requireEditableEvidenceStage(
  booking: Row,
  stage: ValetEvidenceStage,
  actor: "driver" | "operator",
  problem: ProblemFactory,
): Promise<void> {
  const status = canonicalStatus(booking);
  if (actor === "driver" && stage === "owner_pickup" && status === "driver_arranged") return;
  if (actor === "driver" && stage === "owner_return" && status === "returning") return;
  if (actor === "operator" && stage === "station_arrival" && status === "picked_up") return;
  throw problem(409, "VALET_EVIDENCE_STAGE_NOT_EDITABLE", "当前履约状态不能编辑该节点留证");
}

async function saveUploadedEvidence(
  database: AppDatabase,
  evidenceUploadDir: string,
  bookingId: string,
  stage: ValetEvidenceStage,
  actor: "driver" | "operator",
  actorUserId: string | null,
  actorAccountId: string | null,
  normalized: NormalizedPhoto,
  problem: ProblemFactory,
): Promise<Row> {
  const id = randomUUID();
  const storageKey = `${randomUUID()}.jpg`;
  await writeFile(join(evidenceUploadDir, storageKey), normalized.data, { flag: "wx" });
  let previous: Row | undefined;
  try {
    await database.transaction(async (tx) => {
      const booking = await requireTaskBooking(tx, bookingId, problem, true);
      await requireEditableEvidenceStage(booking, stage, actor, problem);
      const now = new Date().toISOString();
      const packageRow = await ensurePendingPackage(tx, bookingId, stage, now);
      if (String(packageRow.status) === "completed") {
        throw problem(409, "VALET_EVIDENCE_IMMUTABLE", "该节点留证已提交，不能再修改");
      }
      previous = await tx.prepare<Row>(`
        SELECT * FROM valet_evidence_media WHERE package_id = ? AND kind = ? FOR UPDATE
      `).get(String(packageRow.id), normalized.kind);
      if (previous) {
        await tx.prepare("DELETE FROM valet_evidence_media WHERE id = ?").run(String(previous.id));
      }
      await tx.prepare(`
        INSERT INTO valet_evidence_media (
          id, package_id, kind, storage_key, mime_type, size_bytes, width, height,
          sha256, uploader_actor_type, uploader_user_id, uploader_account_id, created_at
        ) VALUES (?, ?, ?, ?, 'image/jpeg', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        String(packageRow.id),
        normalized.kind,
        storageKey,
        normalized.data.length,
        normalized.width,
        normalized.height,
        normalized.sha256,
        actor,
        actorUserId,
        actorAccountId,
        now,
      );
      await tx.prepare("UPDATE valet_evidence_packages SET updated_at = ? WHERE id = ?")
        .run(now, String(packageRow.id));
    });
  } catch (error) {
    await unlinkStored(evidenceUploadDir, storageKey);
    throw error;
  }
  if (previous) await unlinkStored(evidenceUploadDir, previous.storage_key);
  const row = await database.prepare<Row>("SELECT * FROM valet_evidence_media WHERE id = ?").get(id);
  if (!row) throw problem(500, "VALET_EVIDENCE_MEDIA_PERSISTENCE_FAILED", "照片保存失败，请重试");
  return row;
}

async function deleteUploadedEvidence(
  database: AppDatabase,
  evidenceUploadDir: string,
  bookingId: string,
  stage: ValetEvidenceStage,
  mediaId: string,
  actor: "driver" | "operator",
  problem: ProblemFactory,
): Promise<void> {
  let row: Row | undefined;
  await database.transaction(async (tx) => {
    const booking = await requireTaskBooking(tx, bookingId, problem, true);
    await requireEditableEvidenceStage(booking, stage, actor, problem);
    row = await tx.prepare<Row>(`
      SELECT m.*, p.status AS package_status FROM valet_evidence_media m
      JOIN valet_evidence_packages p ON p.id = m.package_id
      WHERE m.id = ? AND p.booking_id = ? AND p.stage = ? FOR UPDATE
    `).get(mediaId, bookingId, stage);
    if (!row) throw problem(404, "VALET_EVIDENCE_MEDIA_NOT_FOUND", "留证照片不存在");
    if (String(row!.package_status) === "completed") {
      throw problem(409, "VALET_EVIDENCE_IMMUTABLE", "该节点留证已提交，不能再修改");
    }
    await tx.prepare("DELETE FROM valet_evidence_media WHERE id = ?").run(mediaId);
  });
  await unlinkStored(evidenceUploadDir, row?.storage_key);
}

async function completeDriverEvidence(
  database: AppDatabase,
  principal: DriverPrincipal,
  stage: "owner_pickup" | "owner_return",
  idempotencyKey: string,
  problem: ProblemFactory,
): Promise<void> {
  await database.transaction(async (tx) => {
    const booking = await requireTaskBooking(tx, principal.bookingId, problem, true);
    const packageRow = await tx.prepare<Row>(`
      SELECT * FROM valet_evidence_packages WHERE booking_id = ? AND stage = ? FOR UPDATE
    `).get(principal.bookingId, stage);
    if (packageRow && String(packageRow.status) === "completed") {
      if (String(packageRow.completion_idempotency_key) !== idempotencyKey) {
        throw problem(409, "IDEMPOTENCY_KEY_CONFLICT", "该节点已经使用其他幂等键提交");
      }
      return;
    }
    await requireEditableEvidenceStage(booking, stage, "driver", problem);
    if (!packageRow) throw problem(409, "VALET_EVIDENCE_INCOMPLETE", "请先拍摄本节点车辆留证照片");
    await assertUploadedPackageComplete(tx, packageRow, problem);
    if (stage === "owner_return") {
      await assertAnnualBookingFinancialClosureReady(tx, principal.bookingId, problem);
    }
    const now = new Date().toISOString();
    await tx.prepare(`
      UPDATE valet_evidence_packages SET status = 'completed', captured_by_actor_type = 'driver',
        captured_by_user_id = ?, captured_by_account_id = NULL, captured_by_label = ?,
        completion_idempotency_key = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(principal.userId, principal.driverName, idempotencyKey, now, now, String(packageRow.id));
    const nextStatus = stage === "owner_pickup" ? "picked_up" : "completed";
    const legacyStatus = stage === "owner_pickup" ? "awaiting_arrival" : "completed";
    await tx.prepare(`
      UPDATE bookings SET fulfillment_status = ?, status = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
      WHERE id = ?
    `).run(nextStatus, legacyStatus, now, nextStatus, now, principal.bookingId);
    await tx.prepare(`
      UPDATE valet_driver_assignments SET status = ?, completed_at = ?,
        task_code_hash = CASE WHEN ? = 'owner_return' THEN NULL ELSE task_code_hash END,
        task_code_expires_at = CASE WHEN ? = 'owner_return' THEN NULL ELSE task_code_expires_at END,
        task_code_consumed_at = CASE WHEN ? = 'owner_return' THEN NULL ELSE task_code_consumed_at END,
        verification_code_hmac = CASE WHEN ? = 'owner_return' THEN NULL ELSE verification_code_hmac END,
        verification_code_ciphertext = CASE WHEN ? = 'owner_return' THEN NULL ELSE verification_code_ciphertext END,
        verification_code_expires_at = CASE WHEN ? = 'owner_return' THEN NULL ELSE verification_code_expires_at END,
        updated_at = ? WHERE id = ?
    `).run(
      stage === "owner_pickup" ? "in_progress" : "completed",
      stage === "owner_return" ? now : null,
      stage,
      stage,
      stage,
      stage,
      stage,
      stage,
      now,
      principal.assignmentId,
    );
    if (stage === "owner_return") {
      await tx.prepare(`
        UPDATE valet_driver_sessions SET revoked_at = COALESCE(revoked_at, ?)
        WHERE assignment_id = ? AND revoked_at IS NULL
      `).run(now, principal.assignmentId);
    }
    await insertBookingEvent(
      tx,
      principal.bookingId,
      nextStatus,
      stage === "owner_pickup" ? "司机已取车" : "车辆已送回",
      stage === "owner_pickup" ? "代驾司机已完成取车车况留证，车辆正在送往检测站" : "代驾司机已完成送回车况留证，本次履约闭环完成",
      "driver",
      { evidencePackageId: String(packageRow.id), evidenceStage: stage, photoCount: 5 },
      now,
    );
  });
}

async function completeStationArrival(
  database: AppDatabase,
  bookingId: string,
  accountId: string | null,
  accountLabel: string,
  input: z.infer<typeof stationCompletionSchema>,
  problem: ProblemFactory,
): Promise<void> {
  await database.transaction(async (tx) => {
    const booking = await requireTaskBooking(tx, bookingId, problem, true);
    const packageRow = await tx.prepare<Row>(`
      SELECT * FROM valet_evidence_packages WHERE booking_id = ? AND stage = 'station_arrival' FOR UPDATE
    `).get(bookingId);
    if (packageRow && String(packageRow.status) === "completed") {
      if (String(packageRow.completion_idempotency_key) !== input.idempotencyKey) {
        throw problem(409, "IDEMPOTENCY_KEY_CONFLICT", "到站留证已经使用其他幂等键提交");
      }
      return;
    }
    await requireEditableEvidenceStage(booking, "station_arrival", "operator", problem);
    if (!packageRow) throw problem(409, "VALET_EVIDENCE_INCOMPLETE", "请先拍摄检测站到车留证照片");
    await assertUploadedPackageComplete(tx, packageRow, problem);
    const verification = input.verification;
    const allPassed = verification.plateMatched
      && verification.materialsReady
      && verification.exteriorRecorded
      && verification.vehicleConditionConfirmed;
    if (!allPassed) {
      throw problem(409, "VERIFICATION_INCOMPLETE", "请先完成全部到站核验项");
    }
    const now = new Date().toISOString();
    await tx.prepare(`
      INSERT INTO booking_verifications (
        id, booking_id, plate_matched, materials_ready, exterior_recorded,
        condition_confirmed, notes, verified_at, updated_at
      ) VALUES (?, ?, 1, 1, 1, 1, ?, ?, ?)
      ON CONFLICT(booking_id) DO UPDATE SET
        plate_matched = 1, materials_ready = 1, exterior_recorded = 1,
        condition_confirmed = 1, notes = excluded.notes,
        verified_at = excluded.verified_at, updated_at = excluded.updated_at
    `).run(randomUUID(), bookingId, verification.notes ?? null, now, now);
    await tx.prepare(`
      UPDATE valet_evidence_packages SET status = 'completed', captured_by_actor_type = 'operator',
        captured_by_user_id = NULL, captured_by_account_id = ?, captured_by_label = ?,
        completion_idempotency_key = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(accountId, accountLabel, input.idempotencyKey, now, now, String(packageRow.id));
    await tx.prepare(`
      UPDATE bookings SET fulfillment_status = 'checked_in', status = 'checked_in', updated_at = ? WHERE id = ?
    `).run(now, bookingId);
    await insertBookingEvent(
      tx,
      bookingId,
      "checked_in",
      "车辆已到检测站",
      "检测站已完成五张到车留证及车辆资料核验",
      "operator",
      { evidencePackageId: String(packageRow.id), evidenceStage: "station_arrival", photoCount: 5 },
      now,
    );
  });
}

async function startReturn(
  database: AppDatabase,
  principal: DriverPrincipal,
  idempotencyKey: string,
  problem: ProblemFactory,
): Promise<void> {
  await database.transaction(async (tx) => {
    const booking = await requireTaskBooking(tx, principal.bookingId, problem, true);
    const assignment = await tx.prepare<Row>(`
      SELECT * FROM valet_driver_assignments WHERE id = ? AND booking_id = ? FOR UPDATE
    `).get(principal.assignmentId, principal.bookingId);
    if (!assignment) throw problem(404, "DRIVER_TASK_NOT_FOUND", "未找到可访问的代驾任务");
    const currentStatus = canonicalStatus(booking);
    if (currentStatus === "returning") {
      if (String(assignment.return_start_idempotency_key ?? "") !== idempotencyKey) {
        throw problem(409, "IDEMPOTENCY_KEY_CONFLICT", "返程已经使用其他幂等键开始");
      }
      return;
    }
    if (currentStatus !== "result_received") {
      throw problem(409, "INVALID_FULFILLMENT_TRANSITION", "仅检测结果已回传的任务可以开始返程");
    }
    const evidencePackage = await tx.prepare<Row>(`
      SELECT * FROM valet_evidence_packages
      WHERE booking_id = ? AND stage = 'inspection_complete' FOR UPDATE
    `).get(principal.bookingId);
    if (!evidencePackage
      || String(evidencePackage.status) !== "completed"
      || String(evidencePackage.source_type) !== "checkup_report") {
      throw problem(409, "VALET_EVIDENCE_INCOMPLETE", "检测完成留证尚未形成，不能开始返程");
    }
    const report = await tx.prepare<Row>(`
      SELECT * FROM vehicle_checkup_reports WHERE booking_id = ? AND status = 'published' FOR UPDATE
    `).get(principal.bookingId);
    if (!report) throw problem(409, "VEHICLE_CHECKUP_REPORT_INCOMPLETE", "车辆体检报告尚未完整发布");
    const sitePhotos = await tx.prepare<Row>(`
      SELECT kind FROM vehicle_checkup_media WHERE report_id = ? AND kind = ANY(?)
    `).all(String(report.id), [...valetEvidenceKinds]);
    const kinds = new Set(sitePhotos.map((row) => String(row.kind)));
    const missing = valetEvidenceKinds.filter((kind) => !kinds.has(kind));
    if (missing.length) throw problem(409, "VALET_EVIDENCE_INCOMPLETE", "检测完成留证照片不完整");
    const now = new Date().toISOString();
    await tx.prepare(`
      UPDATE bookings SET fulfillment_status = 'returning', status = 'result_received', updated_at = ? WHERE id = ?
    `).run(now, principal.bookingId);
    await tx.prepare(`
      UPDATE valet_driver_assignments SET status = 'in_progress',
        return_start_idempotency_key = ?, updated_at = ? WHERE id = ?
    `).run(idempotencyKey, now, principal.assignmentId);
    await insertBookingEvent(
      tx,
      principal.bookingId,
      "returning",
      "车辆开始送回",
      "检测结果及检测完成留证已形成，代驾司机正在将车辆送回原地址",
      "driver",
      { evidencePackageId: String(evidencePackage.id), evidenceStage: "inspection_complete", photoCount: 5 },
      now,
    );
  });
}

async function sendEvidenceMedia(
  database: AppDatabase,
  evidenceUploadDir: string,
  checkupUploadDir: string,
  bookingId: string,
  packageId: string,
  mediaId: string,
  reply: FastifyReply,
  problem: ProblemFactory,
  completedOnly: boolean,
): Promise<FastifyReply> {
  const packageRow = await database.prepare<Row>(`
    SELECT * FROM valet_evidence_packages WHERE id = ? AND booking_id = ?
  `).get(packageId, bookingId);
  if (!packageRow || (completedOnly && String(packageRow.status) !== "completed")) {
    throw problem(404, "VALET_EVIDENCE_MEDIA_NOT_FOUND", "留证照片不存在或不可查看");
  }
  let media: Row | undefined;
  let directory = evidenceUploadDir;
  if (String(packageRow.source_type) === "checkup_report") {
    media = await database.prepare<Row>(`
      SELECT * FROM vehicle_checkup_media WHERE id = ? AND report_id = ? AND kind = ANY(?)
    `).get(mediaId, String(packageRow.source_report_id), [...valetEvidenceKinds]);
    directory = checkupUploadDir;
  } else {
    media = await database.prepare<Row>(`
      SELECT * FROM valet_evidence_media WHERE id = ? AND package_id = ?
    `).get(mediaId, packageId);
  }
  if (!media) throw problem(404, "VALET_EVIDENCE_MEDIA_NOT_FOUND", "留证照片不存在或不可查看");
  reply.type("image/jpeg").header("Cache-Control", "private, max-age=3600");
  return reply.send(createReadStream(join(directory, String(media.storage_key))));
}

export type ValetHandoffRouteOptions = {
  uploadDir: string;
  problem: ProblemFactory;
  getBookingDetail: (bookingId: string, audience: "owner" | "operator" | "admin") => Promise<unknown>;
};

export async function registerValetHandoffRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: ValetHandoffRouteOptions,
): Promise<void> {
  const evidenceUploadDir = join(options.uploadDir, "valet-evidence");
  const checkupUploadDir = join(options.uploadDir, "vehicle-checkup");
  await mkdir(evidenceUploadDir, { recursive: true });

  app.post<{ Params: { id: string } }>("/api/admin/bookings/:id/driver-assignment", async (request, reply) => {
    const input = parseInput(assignmentSchema, request.body, options.problem);
    const principal = backofficeForRequest(request);
    const now = new Date().toISOString();
    let assignmentId = "";
    let verificationCode = "";
    await database.transaction(async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!booking) throw options.problem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      if (String(booking.service_mode) !== "valet") {
        throw options.problem(409, "VALET_ASSIGNMENT_NOT_ALLOWED", "仅上门取送订单可以安排代驾司机");
      }
      if (!isEvidencePolicyBooking(booking)) {
        throw options.problem(409, "VALET_ASSIGNMENT_LEGACY_BOOKING", "历史订单继续使用原线下司机安排方式");
      }
      if (String(booking.payment_status) !== "paid") {
        throw options.problem(409, "PAYMENT_REQUIRED", "支付确认后才能安排代驾司机");
      }
      if (!["confirmed", "driver_arranged"].includes(canonicalStatus(booking))) {
        throw options.problem(409, "VALET_ASSIGNMENT_NOT_EDITABLE", "当前履约阶段不能更换司机");
      }
      const current = await tx.prepare<Row>(`
        SELECT * FROM valet_driver_assignments WHERE booking_id = ? FOR UPDATE
      `).get(request.params.id);
      assignmentId = current ? String(current.id) : randomUUID();
      const generatedCode = await generateDriverVerificationCode(tx, assignmentId, options.problem);
      verificationCode = generatedCode.code;
      const verificationCodeExpiresAt = new Date(
        Date.parse(now) + verificationCodeFirstClaimTtlMs,
      ).toISOString();
      const persistedAccountId = await persistedBackofficeAccountId(tx, principal.account.id);
      if (current) {
        // Re-arrange regenerates pickup code: clear bound/pickup/return/handoff executors.
        await tx.prepare(`
          UPDATE valet_driver_assignments SET
            receptionist_name = ?, receptionist_phone = ?,
            driver_name = ?, driver_phone = ?, status = 'assigned',
            task_code_hash = NULL, task_code_expires_at = NULL, task_code_consumed_at = NULL,
            verification_code_hmac = ?, verification_code_ciphertext = ?,
            verification_code_expires_at = ?, verification_code_created_at = ?,
            bound_user_id = NULL, bound_at = NULL,
            pickup_driver_phone = NULL, pickup_bound_user_id = NULL, pickup_bound_at = NULL,
            return_driver_phone = NULL, return_bound_user_id = NULL, return_bound_at = NULL,
            handoff_verification_code_hmac = NULL, handoff_verification_code_ciphertext = NULL,
            handoff_verification_code_expires_at = NULL, handoff_verification_code_created_at = NULL,
            assigned_by_account_id = ?, assigned_at = ?,
            completed_at = NULL, cancelled_at = NULL, updated_at = ? WHERE id = ?
        `).run(
          input.receptionistName,
          input.receptionistPhone,
          input.receptionistName,
          input.receptionistPhone,
          generatedCode.hmac,
          generatedCode.ciphertext,
          verificationCodeExpiresAt,
          now,
          persistedAccountId,
          now,
          now,
          assignmentId,
        );
        await tx.prepare("UPDATE valet_driver_sessions SET revoked_at = ? WHERE assignment_id = ? AND revoked_at IS NULL")
          .run(now, assignmentId);
      } else {
        await tx.prepare(`
          INSERT INTO valet_driver_assignments (
            id, booking_id, receptionist_name, receptionist_phone,
            driver_name, driver_phone, status,
            verification_code_hmac, verification_code_ciphertext,
            verification_code_expires_at, verification_code_created_at,
            assigned_by_account_id, assigned_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          assignmentId,
          request.params.id,
          input.receptionistName,
          input.receptionistPhone,
          input.receptionistName,
          input.receptionistPhone,
          generatedCode.hmac,
          generatedCode.ciphertext,
          verificationCodeExpiresAt,
          now,
          persistedAccountId,
          now,
          now,
        );
      }
      await tx.prepare(`
        UPDATE bookings SET fulfillment_status = 'driver_arranged', status = 'confirmed', updated_at = ? WHERE id = ?
      `).run(now, request.params.id);
      await insertBookingEvent(
        tx,
        request.params.id,
        "driver_arranged",
        "检测站接待人已安排",
        `接待人${ownerDriverName(input.receptionistName)}已登记，取车任务验证码已生成`,
        "operator",
        {
          assignmentId,
          receptionistLabel: ownerDriverName(input.receptionistName),
          receptionistPhoneMasked: maskPhone(input.receptionistPhone),
        },
        now,
        { verificationCode, forceReopenNodeCodes: ["annual.driver.claim"] },
      );
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.driver_assignment.upsert",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before: current ? assignmentDto(current, "admin") : null,
        after: {
          assignmentId,
          receptionistName: input.receptionistName,
          receptionistPhoneMasked: maskPhone(input.receptionistPhone),
        },
        presentation: {
          category: "inspection",
          actionLabel: current ? "重发取车任务验证码" : "安排接待人",
          summary: `预约已安排接待人 ${input.receptionistName}`,
          changes: [{ field: "driverAssignment", label: "接待人", after: input.receptionistName }],
        },
      });
    });
    const row = await database.prepare<Row>("SELECT * FROM valet_driver_assignments WHERE id = ?").get(assignmentId);
    return reply.status(201).send({
      data: {
        assignment: assignmentDto(row!, "admin", true),
        verificationCode,
        taskCode: null,
        scene: null,
        entryPath: null,
        driverEntryPath: "/packages/driver/pages/login/login",
      },
    });
  });

  app.delete<{ Params: { id: string } }>("/api/admin/bookings/:id/driver-assignment", async (request) => {
    const now = new Date().toISOString();
    await database.transaction(async (tx) => {
      const booking = await tx.prepare<Row>("SELECT * FROM bookings WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!booking) throw options.problem(404, "BOOKING_NOT_FOUND", "未找到该预约");
      if (!isEvidencePolicyBooking(booking)) {
        throw options.problem(404, "VALET_ASSIGNMENT_NOT_FOUND", "未找到代驾司机安排");
      }
      const assignment = await tx.prepare<Row>(`
        SELECT * FROM valet_driver_assignments WHERE booking_id = ? FOR UPDATE
      `).get(request.params.id);
      if (!assignment || String(assignment.status) === "cancelled") {
        return;
      }
      if (!["confirmed", "driver_arranged"].includes(canonicalStatus(booking))) {
        throw options.problem(409, "VALET_ASSIGNMENT_NOT_EDITABLE", "车辆已取走，不能撤销司机安排");
      }
      await tx.prepare(`
        UPDATE valet_driver_assignments SET status = 'cancelled', task_code_hash = NULL,
          task_code_expires_at = NULL, verification_code_hmac = NULL,
          verification_code_ciphertext = NULL, verification_code_expires_at = NULL,
          cancelled_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, String(assignment.id));
      await tx.prepare("UPDATE valet_driver_sessions SET revoked_at = ? WHERE assignment_id = ? AND revoked_at IS NULL")
        .run(now, String(assignment.id));
      await tx.prepare(`
        UPDATE bookings SET fulfillment_status = 'confirmed', status = 'confirmed', updated_at = ? WHERE id = ?
      `).run(now, request.params.id);
      await insertBookingEvent(
        tx,
        request.params.id,
        "confirmed",
        "代驾司机安排已撤销",
        "订单已恢复为等待安排司机",
        "operator",
        { assignmentId: String(assignment.id) },
        now,
      );
      await auditBackofficeEvent(tx, {
        request,
        action: "booking.driver_assignment.delete",
        outcome: "success",
        resource: { type: "booking", id: request.params.id },
        before: assignmentDto(assignment, "admin"),
        after: null,
        presentation: {
          category: "inspection",
          actionLabel: "撤销代驾司机",
          summary: "预约的代驾司机安排已撤销",
          changes: [{ field: "driverAssignment", label: "代驾司机", before: String(assignment.driver_name), after: "未安排" }],
        },
      });
    });
    return { data: { deleted: true } };
  });

  app.post("/api/driver/task-sessions/exchange", async (request, reply) => {
    const input = parseInput(taskExchangeSchema, request.body, options.problem);
    const userId = await requireCurrentUser(request, database);
    const now = new Date().toISOString();
    const token = `yxm_drv_${randomBytes(32).toString("base64url")}`;
    let assignment: Row | undefined;
    let exchangeFailure: "invalid" | "limited" | null = null;
    const ipHash = input.verificationCode
      ? driverCodeIpHash(request, options.problem)
      : null;
    await database.transaction(async (tx) => {
      if (input.verificationCode && ipHash) {
        await lockDriverCodeBuckets(tx, userId, ipHash);
        if (await driverCodeIsRateLimited(tx, userId, ipHash)) {
          exchangeFailure = "limited";
          return;
        }
      }

      const credentialHash = input.verificationCode
        ? driverVerificationCodeHmac(input.verificationCode, options.problem)!
        : sha256(input.taskCode!);
      const credentialColumn = input.verificationCode
        ? "verification_code_hmac"
        : "task_code_hash";
      const candidate = await tx.prepare<Row>(`
        SELECT booking_id FROM valet_driver_assignments WHERE ${credentialColumn} = ?
      `).get(credentialHash);
      if (!candidate) {
        if (input.verificationCode && ipHash) {
          await recordDriverCodeAttempt(tx, userId, ipHash, false, now);
          exchangeFailure = "invalid";
          return;
        }
        throw options.problem(404, "DRIVER_TASK_CODE_INVALID", "任务入口无效、已过期或已撤销");
      }
      // Match the booking -> assignment lock order used by cancellation, so a
      // simultaneous cancel/exchange cannot deadlock or mint a post-cancel token.
      const booking = await tx.prepare<Row>(`
        SELECT status, fulfillment_status, service_mode, evidence_policy_version
        FROM bookings WHERE id = ? FOR UPDATE
      `).get(String(candidate.booking_id));
      assignment = await tx.prepare<Row>(`
        SELECT * FROM valet_driver_assignments WHERE ${credentialColumn} = ? FOR UPDATE
      `).get(credentialHash);
      const invalidBooking = !assignment
        || !booking
        || String(assignment.booking_id) !== String(candidate.booking_id)
        || !isEvidencePolicyBooking(booking)
        || ["completed", "cancelled", "no_show"].includes(String(booking.status))
        || ["completed", "cancelled", "no_show"].includes(String(booking.fulfillment_status));
      const boundToAnotherUser = assignment?.bound_user_id != null
        && String(assignment.bound_user_id) !== userId;
      const credentialInvalid = input.verificationCode
        ? !assignment
          || ["completed", "cancelled"].includes(String(assignment.status))
          || invalidBooking
          || boundToAnotherUser
          || (assignment.bound_user_id == null && (
            !assignment.verification_code_expires_at
            || String(assignment.verification_code_expires_at) <= now
          ))
        : !assignment
          || ["completed", "cancelled"].includes(String(assignment.status))
          || !assignment.task_code_expires_at
          || String(assignment.task_code_expires_at) <= now
          || invalidBooking
          || boundToAnotherUser;
      if (credentialInvalid) {
        if (input.verificationCode && ipHash) {
          await recordDriverCodeAttempt(tx, userId, ipHash, false, now);
          exchangeFailure = "invalid";
          return;
        }
        throw options.problem(404, "DRIVER_TASK_CODE_INVALID", "任务入口无效、已过期或已撤销");
      }
      if (input.verificationCode && ipHash) {
        await recordDriverCodeAttempt(tx, userId, ipHash, true, now);
      }
      if (!assignment) {
        throw options.problem(404, "DRIVER_TASK_CODE_INVALID", "任务入口无效、已过期或已撤销");
      }
      const matchedAssignment = assignment;
      const firstBinding = matchedAssignment.bound_user_id == null;
      if (firstBinding) {
        await tx.prepare(`
          UPDATE valet_driver_assignments SET bound_user_id = ?, bound_at = ?,
            task_code_consumed_at = ?,
            status = CASE WHEN status = 'assigned' THEN 'bound' ELSE status END,
            task_code_hash = NULL, task_code_expires_at = NULL,
            verification_code_hmac = NULL, verification_code_ciphertext = NULL,
            verification_code_expires_at = NULL,
            updated_at = ? WHERE id = ?
        `).run(userId, now, now, now, String(matchedAssignment.id));
      } else {
        await tx.prepare(`
          UPDATE valet_driver_assignments SET
            task_code_consumed_at = COALESCE(task_code_consumed_at, ?),
            task_code_hash = NULL, task_code_expires_at = NULL,
            verification_code_hmac = NULL, verification_code_ciphertext = NULL,
            verification_code_expires_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, now, String(matchedAssignment.id));
      }
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.parse(now) + driverSessionTtlMs).toISOString();
      await tx.prepare(`
        INSERT INTO valet_driver_sessions (
          id, assignment_id, user_id, token_hash, expires_at, last_seen_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, String(matchedAssignment.id), userId, sha256(token), expiresAt, now, now);
      assignment = await tx.prepare<Row>("SELECT * FROM valet_driver_assignments WHERE id = ?").get(String(matchedAssignment.id));
      await acknowledgeAnnualDriverClaim(tx, String(matchedAssignment.booking_id), {
        now: new Date(now),
        actorType: "driver",
        actorId: userId,
      });
    });
    if (exchangeFailure === "limited") {
      throw options.problem(429, "DRIVER_TASK_CODE_RATE_LIMITED", "验证码尝试过多，请稍后再试");
    }
    if (exchangeFailure === "invalid" || !assignment) {
      throw options.problem(404, "DRIVER_TASK_CODE_INVALID", "任务入口无效、已过期或已撤销");
    }
    return reply.status(201).send({
      data: {
        token,
        expiresAt: new Date(Date.parse(now) + driverSessionTtlMs).toISOString(),
        taskId: String(assignment!.id),
        bookingId: String(assignment!.booking_id),
      },
    });
  });

  app.get<{ Params: { id: string } }>("/api/driver/tasks/:id", async (request) => {
    await requireDriverPrincipal(request, database, options.problem, request.params.id);
    return { data: await driverTaskDto(database, request.params.id) };
  });

  app.post<{ Params: { id: string; stage: string } }>(
    "/api/driver/tasks/:id/evidence/:stage/media",
    async (request, reply) => {
      const stage = request.params.stage;
      if (stage !== "owner_pickup" && stage !== "owner_return") {
        throw options.problem(403, "DRIVER_EVIDENCE_STAGE_FORBIDDEN", "司机只能提交取车或送回留证");
      }
      const principal = await requireDriverPrincipal(request, database, options.problem, request.params.id);
      const normalized = await normalizeUploadedPhoto(request, options.problem);
      const row = await saveUploadedEvidence(
        database,
        evidenceUploadDir,
        request.params.id,
        stage,
        "driver",
        principal.userId,
        null,
        normalized,
        options.problem,
      );
      const packageRow = await database.prepare<Row>(`
        SELECT * FROM valet_evidence_packages WHERE booking_id = ? AND stage = ?
      `).get(request.params.id, stage);
      return reply.status(201).send({
        data: mediaDto(row, "driver", request.params.id, String(packageRow!.id), stage),
      });
    },
  );

  app.delete<{ Params: { id: string; stage: string; mediaId: string } }>(
    "/api/driver/tasks/:id/evidence/:stage/media/:mediaId",
    async (request) => {
      const stage = request.params.stage;
      if (stage !== "owner_pickup" && stage !== "owner_return") {
        throw options.problem(403, "DRIVER_EVIDENCE_STAGE_FORBIDDEN", "司机只能删除取车或送回留证");
      }
      await requireDriverPrincipal(request, database, options.problem, request.params.id);
      await deleteUploadedEvidence(
        database,
        evidenceUploadDir,
        request.params.id,
        stage,
        request.params.mediaId,
        "driver",
        options.problem,
      );
      return { data: { id: request.params.mediaId, deleted: true } };
    },
  );

  app.post<{ Params: { id: string; stage: string } }>(
    "/api/driver/tasks/:id/evidence/:stage/complete",
    async (request) => {
      const stage = request.params.stage;
      if (stage !== "owner_pickup" && stage !== "owner_return") {
        throw options.problem(403, "DRIVER_EVIDENCE_STAGE_FORBIDDEN", "司机只能完成取车或送回留证");
      }
      const input = parseInput(completionSchema, request.body, options.problem);
      const principal = await requireDriverPrincipal(request, database, options.problem, request.params.id);
      await completeDriverEvidence(database, principal, stage, input.idempotencyKey, options.problem);
      return { data: await driverTaskDto(database, request.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>("/api/driver/tasks/:id/start-return", async (request) => {
    const input = parseInput(completionSchema, request.body, options.problem);
    const principal = await requireDriverPrincipal(request, database, options.problem, request.params.id);
    await startReturn(database, principal, input.idempotencyKey, options.problem);
    return { data: await driverTaskDto(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>(
    "/api/operator/bookings/:id/evidence/station_arrival/media",
    async (request, reply) => {
      const principal = backofficeForRequest(request);
      const accountId = await persistedBackofficeAccountId(database, principal.account.id);
      const normalized = await normalizeUploadedPhoto(request, options.problem);
      const row = await saveUploadedEvidence(
        database,
        evidenceUploadDir,
        request.params.id,
        "station_arrival",
        "operator",
        null,
        accountId,
        normalized,
        options.problem,
      );
      const packageRow = await database.prepare<Row>(`
        SELECT * FROM valet_evidence_packages WHERE booking_id = ? AND stage = 'station_arrival'
      `).get(request.params.id);
      return reply.status(201).send({
        data: mediaDto(row, "operator", request.params.id, String(packageRow!.id), "station_arrival"),
      });
    },
  );

  app.delete<{ Params: { id: string; mediaId: string } }>(
    "/api/operator/bookings/:id/evidence/station_arrival/media/:mediaId",
    async (request) => {
      backofficeForRequest(request);
      await deleteUploadedEvidence(
        database,
        evidenceUploadDir,
        request.params.id,
        "station_arrival",
        request.params.mediaId,
        "operator",
        options.problem,
      );
      return { data: { id: request.params.mediaId, deleted: true } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/operator/bookings/:id/evidence/station_arrival/complete",
    async (request) => {
      const principal = backofficeForRequest(request);
      const input = parseInput(stationCompletionSchema, request.body, options.problem);
      const accountId = await persistedBackofficeAccountId(database, principal.account.id);
      await completeStationArrival(
        database,
        request.params.id,
        accountId,
        principal.account.displayName,
        input,
        options.problem,
      );
      return { data: await options.getBookingDetail(request.params.id, "operator") };
    },
  );

  app.get<{ Params: { id: string; packageId: string; mediaId: string } }>(
    "/api/bookings/:id/evidence/:packageId/media/:mediaId",
    async (request, reply) => {
      const userId = await requireCurrentUser(request, database);
      const booking = await database.prepare<Row>("SELECT id FROM bookings WHERE id = ? AND user_id = ?")
        .get(request.params.id, userId);
      if (!booking) throw options.problem(404, "VALET_EVIDENCE_MEDIA_NOT_FOUND", "留证照片不存在或不可查看");
      return sendEvidenceMedia(
        database,
        evidenceUploadDir,
        checkupUploadDir,
        request.params.id,
        request.params.packageId,
        request.params.mediaId,
        reply,
        options.problem,
        true,
      );
    },
  );

  for (const audience of ["admin", "operator"] as const) {
    app.get<{ Params: { id: string; packageId: string; mediaId: string } }>(
      `/api/${audience}/bookings/:id/evidence/:packageId/media/:mediaId`,
      async (request, reply) => sendEvidenceMedia(
        database,
        evidenceUploadDir,
        checkupUploadDir,
        request.params.id,
        request.params.packageId,
        request.params.mediaId,
        reply,
        options.problem,
        false,
      ),
    );
  }

  app.get<{ Params: { id: string; stage: string; mediaId: string } }>(
    "/api/driver/tasks/:id/evidence/:stage/media/:mediaId",
    async (request, reply) => {
      const stage = z.enum(valetEvidenceStages).safeParse(request.params.stage);
      if (!stage.success) throw options.problem(404, "VALET_EVIDENCE_MEDIA_NOT_FOUND", "留证照片不存在");
      await requireDriverPrincipal(request, database, options.problem, request.params.id);
      const packageRow = await database.prepare<Row>(`
        SELECT id FROM valet_evidence_packages WHERE booking_id = ? AND stage = ?
      `).get(request.params.id, stage.data);
      if (!packageRow) throw options.problem(404, "VALET_EVIDENCE_MEDIA_NOT_FOUND", "留证照片不存在");
      return sendEvidenceMedia(
        database,
        evidenceUploadDir,
        checkupUploadDir,
        request.params.id,
        String(packageRow.id),
        request.params.mediaId,
        reply,
        options.problem,
        false,
      );
    },
  );
}
