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
import type { FastifyInstance, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requireCurrentUser } from "./auth.js";
import { assertCapability, auditBackofficeEvent, backofficeForRequest } from "./backoffice.js";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;
type ProblemFactory = (statusCode: number, code: string, message: string, fields?: Record<string, string>) => Error;
type Stage = "owner_pickup" | "owner_return";

export type WashValetRouteOptions = { uploadDir: string; problem: ProblemFactory; now?: () => Date };

const assignmentSchema = z.object({
  dispatcherName: z.string().trim().min(2).max(40),
  dispatcherPhone: z.string().trim().regex(/^1\d{10}$/u),
});
const exchangeSchema = z.object({
  verificationCode: z.string().trim().regex(/^\d{6}$/u),
  driverPhone: z.string().trim().regex(/^1\d{10}$/u),
});
const completionSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(160) });
const CODE_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CODE_FAILURE_WINDOW_MINUTES = 15;
const CODE_USER_FAILURE_LIMIT = 5;
const CODE_IP_FAILURE_LIMIT = 20;

function production(): boolean {
  return process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
}

function cryptoKey(problem?: ProblemFactory): Buffer | null {
  const configured = process.env.VALET_DRIVER_CODE_DATA_KEY?.trim();
  if (configured) {
    if (/^[a-f0-9]{64}$/iu.test(configured)) return Buffer.from(configured, "hex");
    try {
      const decoded = Buffer.from(configured, "base64");
      if (decoded.length === 32) return decoded;
    } catch { /* fail closed below */ }
  }
  if (!production()) return createHash("sha256").update("yuxiaoman-wash-valet-demo-data-key-v1").digest();
  if (problem) throw problem(503, "DRIVER_CODE_CRYPTO_UNAVAILABLE", "代驾验证码安全配置不可用");
  return null;
}

function hmacKey(problem?: ProblemFactory): string | null {
  const configured = process.env.VALET_DRIVER_CODE_HMAC_KEY?.trim();
  if (configured && configured.length >= 32) return configured;
  if (!production()) return "yuxiaoman-wash-valet-demo-hmac-key-v1";
  if (problem) throw problem(503, "DRIVER_CODE_CRYPTO_UNAVAILABLE", "代驾验证码安全配置不可用");
  return null;
}

function codeHmac(code: string, prefix: "wash" | "annual", problem?: ProblemFactory): string {
  const payload = prefix === "wash" ? `wash-verification-code:v1:${code}` : `verification-code:v1:${code}`;
  return createHmac("sha256", hmacKey(problem)!).update(payload).digest("hex");
}

function codeIpHash(request: FastifyRequest, problem: ProblemFactory): string {
  return createHmac("sha256", hmacKey(problem)!).update(`driver-code-ip:v1:${request.ip || "unknown"}`).digest("hex");
}

async function lockCodeBuckets(database: AppDatabase, userId: string, ipHash: string): Promise<void> {
  for (const bucket of [`driver-code-ip:${ipHash}`, `driver-code-user:${userId}`].sort()) {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(bucket);
  }
}

async function codeRateLimited(database: AppDatabase, userId: string, ipHash: string): Promise<boolean> {
  const row = await database.prepare<{ user_count: string; ip_count: string }>(`
    SELECT COUNT(*) FILTER (WHERE user_id = ?)::text AS user_count,
      COUNT(*) FILTER (WHERE ip_hash = ?)::text AS ip_count
    FROM valet_driver_code_attempts
    WHERE succeeded = FALSE AND attempted_at > NOW() - INTERVAL '${CODE_FAILURE_WINDOW_MINUTES} minutes'
  `).get(userId, ipHash);
  return Number(row?.user_count ?? 0) >= CODE_USER_FAILURE_LIMIT || Number(row?.ip_count ?? 0) >= CODE_IP_FAILURE_LIMIT;
}

async function recordCodeAttempt(database: AppDatabase, userId: string, ipHash: string, succeeded: boolean, at: string): Promise<void> {
  await database.prepare(`INSERT INTO valet_driver_code_attempts (id, user_id, ip_hash, succeeded, attempted_at)
    VALUES (?, ?, ?, ?, ?::timestamptz)`).run(randomUUID(), userId, ipHash, succeeded, at);
  if (succeeded) await database.prepare("DELETE FROM valet_driver_code_attempts WHERE succeeded = FALSE AND user_id = ? AND ip_hash = ?").run(userId, ipHash);
}

function encryptCode(code: string, assignmentId: string, problem: ProblemFactory): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cryptoKey(problem)!, iv);
  cipher.setAAD(Buffer.from(`wash-valet-assignment:${assignmentId}`));
  const data = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

function decryptCode(value: unknown, assignmentId: string): string | null {
  if (!value) return null;
  const key = cryptoKey();
  if (!key) return null;
  const [version, iv, tag, data] = String(value).split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`wash-valet-assignment:${assignmentId}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const code = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    return /^\d{6}$/u.test(code) ? code : null;
  } catch { return null; }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function bearer(request: FastifyRequest): string {
  const value = request.headers.authorization ?? "";
  return /^Bearer\s+/iu.test(value) ? value.replace(/^Bearer\s+/iu, "").trim() : "";
}

async function generateCode(database: AppDatabase, assignmentId: string, problem: ProblemFactory) {
  await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get("wash-valet-code-generation:v1");
  for (let index = 0; index < 40; index += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const washHmac = codeHmac(code, "wash", problem);
    const [wash, annual] = await Promise.all([
      database.prepare("SELECT 1 FROM wash_valet_assignments WHERE verification_code_hmac = ?").get(washHmac),
      database.prepare("SELECT 1 FROM valet_driver_assignments WHERE verification_code_hmac = ? OR handoff_verification_code_hmac = ?")
        .get(codeHmac(code, "annual", problem), codeHmac(code, "annual", problem)),
    ]);
    if (!wash && !annual) return { code, hmac: washHmac, ciphertext: encryptCode(code, assignmentId, problem) };
  }
  throw problem(503, "DRIVER_CODE_UNAVAILABLE", "暂时无法生成验证码，请稍后重试");
}

async function requireDriver(database: AppDatabase, request: FastifyRequest, orderId: string, problem: ProblemFactory): Promise<Row> {
  const token = bearer(request);
  if (!token.startsWith("yxm_wdrv_")) throw problem(401, "DRIVER_AUTHENTICATION_REQUIRED", "需要有效的代驾任务会话");
  const row = await database.prepare<Row>(`
    SELECT s.id AS session_id, s.user_id, a.*, o.fulfillment_status
    FROM wash_valet_sessions s JOIN wash_valet_assignments a ON a.id = s.assignment_id
    JOIN wash_orders o ON o.id = a.order_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > now()
      AND a.bound_user_id = s.user_id AND a.status NOT IN ('completed', 'cancelled')
      AND o.id = ? AND o.fulfillment_status NOT IN ('completed', 'cancelled', 'refunded', 'expired')
  `).get(sha256(token), orderId);
  if (!row) throw problem(404, "DRIVER_TASK_NOT_FOUND", "未找到可访问的代驾任务");
  return row;
}

function json(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try { return JSON.parse(String(value ?? "{}")) as Record<string, unknown>; } catch { return {}; }
}

function address(value: unknown) {
  const row = json(value);
  return {
    title: String(row.name ?? row.title ?? "取送地址"), address: String(row.address ?? ""),
    detail: String(row.detail ?? ""), note: String(row.note ?? ""),
    latitude: Number(row.latitude ?? 0), longitude: Number(row.longitude ?? 0),
  };
}

async function taskDto(database: AppDatabase, orderId: string) {
  const row = await database.prepare<Row>(`
    SELECT o.*, a.id AS assignment_id, a.dispatcher_name, a.dispatcher_phone,
      a.driver_phone, a.status AS assignment_status, s.name AS store_name,
      s.address AS store_address, s.latitude AS store_latitude, s.longitude AS store_longitude,
      s.internal_contact_phone AS store_phone
    FROM wash_orders o JOIN wash_valet_assignments a ON a.order_id = o.id
    JOIN wash_stores s ON s.id = o.store_id WHERE o.id = ?
  `).get(orderId);
  if (!row) return null;
  const vehicle = json(row.vehicle_snapshot_json);
  const evidence = await database.prepare<Row>("SELECT * FROM wash_valet_evidence WHERE order_id = ? ORDER BY stage").all(orderId);
  const events = await database.prepare<Row>("SELECT * FROM wash_order_events WHERE order_id = ? ORDER BY created_at, id").all(orderId);
  const packageFor = (stage: Stage) => {
    const media = evidence.find((item) => item.stage === stage);
    return {
      stage, status: media?.completed_at ? "completed" : media ? "in_progress" : "pending",
      capturedAt: media?.completed_at ? String(media.completed_at) : null,
      capturedByLabel: "代驾司机",
      photos: media ? [{ id: String(media.id), stage, kind: "vehicle_panorama", url: `/api/wash-driver/tasks/${orderId}/evidence/${stage}/media/${media.id}`, createdAt: String(media.created_at) }] : [],
    };
  };
  return {
    serviceType: "car_wash", requiredPhotoKinds: ["vehicle_panorama"], taskId: String(row.assignment_id),
    bookingId: orderId, bookingNumber: String(row.order_number), status: String(row.status),
    fulfillmentStatus: String(row.fulfillment_status), appointmentDate: String(row.appointment_date),
    startTime: String(row.start_time), endTime: String(row.end_time),
    driverAssignment: {
      id: String(row.assignment_id), receptionistName: String(row.dispatcher_name), receptionistPhone: String(row.dispatcher_phone),
      driverName: "执行司机", driverPhoneMasked: row.driver_phone ? String(row.driver_phone).replace(/(\d{3})\d{4}(\d{4})/u, "$1****$2") : "",
      pickupDriverPhone: String(row.driver_phone ?? ""), returnDriverPhone: String(row.driver_phone ?? ""),
      status: String(row.assignment_status), handoffCodePending: false,
    },
    vehicle: { plateNumber: String(vehicle.plateNumber ?? "车牌待同步"), displayName: String(vehicle.displayName ?? vehicle.vehicleType ?? "预约车辆"), vehicleType: String(vehicle.vehicleType ?? "") },
    owner: { contactName: String(row.contact_name), contactPhone: String(row.contact_phone), contactPhoneMasked: "" },
    pickupAddress: address(row.pickup_address_json),
    station: { id: String(row.store_id), name: String(row.store_name), title: String(row.store_name), address: String(row.store_address), detail: "", note: "", latitude: Number(row.store_latitude ?? 0), longitude: Number(row.store_longitude ?? 0), phone: String(row.store_phone ?? "") },
    evidencePackages: [packageFor("owner_pickup"), packageFor("owner_return")],
    events: events.map((item) => ({ id: String(item.id), status: String(item.status), title: String(item.title), description: String(item.description), createdAt: String(item.created_at) })),
  };
}

async function savePhoto(database: AppDatabase, directory: string, orderId: string, stage: Stage, userId: string, request: FastifyRequest, problem: ProblemFactory): Promise<Row> {
  let part;
  try { part = await request.file(); } catch { throw problem(413, "WASH_VALET_PHOTO_TOO_LARGE", "现场照片不能超过 10MB"); }
  if (!part || !/^image\/(jpeg|png|webp|heic|heif)$/iu.test(part.mimetype)) throw problem(415, "WASH_VALET_PHOTO_INVALID", "请使用现场相机拍摄车辆全景");
  let processed;
  try {
    processed = await sharp(await part.toBuffer()).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  } catch { throw problem(400, "WASH_VALET_PHOTO_INVALID", "照片损坏或无法识别，请重新拍摄"); }
  const current = await database.prepare<Row>("SELECT * FROM wash_valet_evidence WHERE order_id = ? AND stage = ?").get(orderId, stage);
  if (current?.completed_at) throw problem(409, "WASH_VALET_EVIDENCE_COMPLETED", "当前留证已封存，不能替换");
  const id = current ? String(current.id) : randomUUID();
  const storageKey = `${id}.jpg`;
  await writeFile(join(directory, storageKey), processed.data, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    await writeFile(join(directory, storageKey), processed.data);
  });
  await database.prepare(`
    INSERT INTO wash_valet_evidence (id, order_id, stage, storage_key, mime_type, size_bytes, width, height, sha256, uploader_user_id, completion_idempotency_key, completed_at, created_at)
    VALUES (?, ?, ?, ?, 'image/jpeg', ?, ?, ?, ?, ?, NULL, NULL, now())
    ON CONFLICT (order_id, stage) DO UPDATE SET storage_key = excluded.storage_key,
      mime_type = excluded.mime_type, size_bytes = excluded.size_bytes, width = excluded.width,
      height = excluded.height, sha256 = excluded.sha256, uploader_user_id = excluded.uploader_user_id
  `).run(id, orderId, stage, storageKey, processed.data.length, processed.info.width, processed.info.height, sha256(processed.data), userId);
  return (await database.prepare<Row>("SELECT * FROM wash_valet_evidence WHERE order_id = ? AND stage = ?").get(orderId, stage))!;
}

export async function registerWashValetRoutes(app: FastifyInstance, database: AppDatabase, options: WashValetRouteOptions): Promise<void> {
  const now = options.now ?? (() => new Date());
  const directory = join(options.uploadDir, "wash-valet");
  await mkdir(directory, { recursive: true });

  app.post<{ Params: { id: string } }>("/api/admin/wash/orders/:id/driver-assignment", async (request, reply) => {
    const principal = assertCapability(backofficeForRequest(request), "admin.all");
    const parsed = assignmentSchema.safeParse(request.body);
    if (!parsed.success) throw options.problem(400, "WASH_VALET_ASSIGNMENT_INVALID", "请填写代驾公司调度联系人");
    let code = "";
    let assignmentId = "";
    await database.transaction(async (tx) => {
      const order = await tx.prepare<Row>("SELECT * FROM wash_orders WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!order) throw options.problem(404, "WASH_ORDER_NOT_FOUND", "未找到洗车订单");
      if (String(order.service_mode) !== "valet" || String(order.payment_status) !== "paid" || !["awaiting_assignment", "driver_arranged"].includes(String(order.fulfillment_status))) {
        throw options.problem(409, "WASH_VALET_ASSIGNMENT_NOT_ALLOWED", "当前订单不能安排代驾");
      }
      const company = await tx.prepare<Row>(`
        SELECT c.* FROM finance_settings f JOIN valet_companies c ON c.id = f.default_valet_company_id
        WHERE f.enabled = TRUE AND c.is_active = TRUE AND f.id = 1
      `).get();
      if (!company) throw options.problem(409, "VALET_COMPANY_NOT_CONFIGURED", "请先在财务中心启用合作代驾公司");
      const current = await tx.prepare<Row>("SELECT * FROM wash_valet_assignments WHERE order_id = ? FOR UPDATE").get(request.params.id);
      assignmentId = current ? String(current.id) : randomUUID();
      const generated = await generateCode(tx, assignmentId, options.problem);
      code = generated.code;
      const at = now().toISOString();
      const expiresAt = new Date(Date.parse(at) + CODE_TTL_MS).toISOString();
      if (current) {
        await tx.prepare(`UPDATE wash_valet_assignments SET valet_company_id = ?, dispatcher_name = ?, dispatcher_phone = ?,
          status = 'assigned', verification_code_hmac = ?, verification_code_ciphertext = ?, verification_code_expires_at = ?::timestamptz,
          bound_user_id = NULL, driver_phone = NULL, bound_at = NULL, completed_at = NULL,
          assigned_by_account_id = ?, assigned_at = ?::timestamptz, updated_at = ?::timestamptz WHERE id = ?`)
          .run(String(company.id), parsed.data.dispatcherName, parsed.data.dispatcherPhone, generated.hmac, generated.ciphertext, expiresAt, principal.account.id, at, at, assignmentId);
        await tx.prepare("UPDATE wash_valet_sessions SET revoked_at = ?::timestamptz WHERE assignment_id = ? AND revoked_at IS NULL").run(at, assignmentId);
      } else {
        await tx.prepare(`INSERT INTO wash_valet_assignments (id, order_id, valet_company_id, dispatcher_name, dispatcher_phone,
          status, verification_code_hmac, verification_code_ciphertext, verification_code_expires_at, bound_user_id,
          driver_phone, assigned_by_account_id, assigned_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?::timestamptz, NULL, NULL, ?, ?::timestamptz, ?::timestamptz)`)
          .run(assignmentId, request.params.id, String(company.id), parsed.data.dispatcherName, parsed.data.dispatcherPhone, generated.hmac, generated.ciphertext, expiresAt, principal.account.id, at, at);
      }
      await tx.prepare("UPDATE wash_orders SET fulfillment_status = 'driver_arranged', updated_at = ? WHERE id = ?").run(at, request.params.id);
      await tx.prepare(`INSERT INTO wash_order_events (id, order_id, status, title, description, actor_type, metadata_json, created_at)
        VALUES (?, ?, 'driver_arranged', '代驾任务已发布', '六位验证码已生成，由合作代驾公司司机认领', 'operator', ?, ?)`)
        .run(randomUUID(), request.params.id, JSON.stringify({ companyId: company.id, assignmentId }), at);
      await auditBackofficeEvent(tx, { request, action: "wash.valet.assignment.upsert", outcome: "success", resource: { type: "wash_order", id: request.params.id }, presentation: { category: "wash", actionLabel: "安排洗车代驾", summary: String(order.order_number) } });
    });
    return reply.status(201).send({ data: { assignmentId, verificationCode: code, expiresAt: new Date(now().getTime() + CODE_TTL_MS).toISOString() } });
  });

  app.get<{ Params: { id: string } }>("/api/admin/wash/orders/:id/driver-assignment", async (request) => {
    assertCapability(backofficeForRequest(request), "admin.all");
    const row = await database.prepare<Row>("SELECT * FROM wash_valet_assignments WHERE order_id = ?").get(request.params.id);
    if (!row) throw options.problem(404, "WASH_VALET_ASSIGNMENT_NOT_FOUND", "未找到代驾安排");
    const completed = ["completed", "cancelled"].includes(String(row.status));
    return { data: { id: String(row.id), status: String(row.status), dispatcherName: String(row.dispatcher_name), dispatcherPhone: String(row.dispatcher_phone), driverPhone: row.driver_phone ? String(row.driver_phone) : null, verificationCode: completed ? null : decryptCode(row.verification_code_ciphertext, String(row.id)), expiresAt: row.verification_code_expires_at ? String(row.verification_code_expires_at) : null } };
  });

  app.post("/api/wash-driver/task-sessions/exchange", async (request, reply) => {
    const userId = await requireCurrentUser(request, database);
    const parsed = exchangeSchema.safeParse(request.body);
    if (!parsed.success) throw options.problem(400, "DRIVER_CODE_INVALID", "请输入六位验证码和执行司机手机号");
    const at = now().toISOString();
    const token = `yxm_wdrv_${randomBytes(32).toString("base64url")}`;
    let assignment: Row | undefined;
    let failure: "invalid" | "limited" | null = null;
    const ipHash = codeIpHash(request, options.problem);
    await database.transaction(async (tx) => {
      await lockCodeBuckets(tx, userId, ipHash);
      if (await codeRateLimited(tx, userId, ipHash)) { failure = "limited"; return; }
      assignment = await tx.prepare<Row>("SELECT * FROM wash_valet_assignments WHERE verification_code_hmac = ? FOR UPDATE")
        .get(codeHmac(parsed.data.verificationCode, "wash", options.problem));
      const firstClaim = assignment && !assignment.bound_user_id;
      const invalid = !assignment
        || ["completed", "cancelled"].includes(String(assignment.status))
        || (firstClaim && (String(assignment.status) !== "assigned" || String(assignment.verification_code_expires_at) <= at))
        || (!firstClaim && String(assignment.bound_user_id) !== userId);
      if (invalid) {
        await recordCodeAttempt(tx, userId, ipHash, false, at);
        assignment = undefined;
        failure = "invalid";
        return;
      }
      if (firstClaim) {
        await tx.prepare(`UPDATE wash_valet_assignments SET bound_user_id = ?, driver_phone = ?, bound_at = ?::timestamptz,
          status = 'bound', updated_at = ?::timestamptz WHERE id = ?`)
          .run(userId, parsed.data.driverPhone, at, at, String(assignment!.id));
      }
      await recordCodeAttempt(tx, userId, ipHash, true, at);
      await tx.prepare(`INSERT INTO wash_valet_sessions (id, assignment_id, user_id, token_hash, expires_at, revoked_at, created_at)
        VALUES (?, ?, ?, ?, ?::timestamptz, NULL, ?::timestamptz)`)
        .run(randomUUID(), String(assignment!.id), userId, sha256(token), new Date(Date.parse(at) + SESSION_TTL_MS).toISOString(), at);
    });
    if (failure === "limited") throw options.problem(429, "DRIVER_TASK_CODE_RATE_LIMITED", "验证码尝试过多，请稍后再试");
    if (failure === "invalid" || !assignment) throw options.problem(404, "DRIVER_TASK_CODE_INVALID", "验证码无效、已过期或已被认领");
    return reply.status(201).send({ data: { token, expiresAt: new Date(Date.parse(at) + SESSION_TTL_MS).toISOString(), taskId: String(assignment!.id), bookingId: String(assignment!.order_id), serviceType: "car_wash" } });
  });

  app.get<{ Params: { id: string } }>("/api/wash-driver/tasks/:id", async (request) => {
    await requireDriver(database, request, request.params.id, options.problem);
    const task = await taskDto(database, request.params.id);
    if (!task) throw options.problem(404, "DRIVER_TASK_NOT_FOUND", "未找到代驾任务");
    return { data: task };
  });

  app.post<{ Params: { id: string; stage: Stage } }>("/api/wash-driver/tasks/:id/evidence/:stage/media", async (request, reply) => {
    if (!(["owner_pickup", "owner_return"] as string[]).includes(request.params.stage)) throw options.problem(403, "DRIVER_EVIDENCE_STAGE_FORBIDDEN", "当前留证节点不可操作");
    const principal = await requireDriver(database, request, request.params.id, options.problem);
    const row = await savePhoto(database, directory, request.params.id, request.params.stage, String(principal.user_id), request, options.problem);
    return reply.status(201).send({ data: { id: String(row.id), stage: request.params.stage, kind: "vehicle_panorama", url: `/api/wash-driver/tasks/${request.params.id}/evidence/${request.params.stage}/media/${row.id}`, createdAt: String(row.created_at) } });
  });

  app.delete<{ Params: { id: string; stage: Stage; mediaId: string } }>("/api/wash-driver/tasks/:id/evidence/:stage/media/:mediaId", async (request) => {
    await requireDriver(database, request, request.params.id, options.problem);
    const row = await database.prepare<Row>("SELECT * FROM wash_valet_evidence WHERE id = ? AND order_id = ? AND stage = ?").get(request.params.mediaId, request.params.id, request.params.stage);
    if (!row || row.completed_at) throw options.problem(404, "WASH_VALET_PHOTO_NOT_FOUND", "未找到可删除的现场照片");
    await database.prepare("DELETE FROM wash_valet_evidence WHERE id = ?").run(request.params.mediaId);
    await unlink(join(directory, String(row.storage_key))).catch(() => undefined);
    return { data: { deleted: true } };
  });

  app.post<{ Params: { id: string; stage: Stage } }>("/api/wash-driver/tasks/:id/evidence/:stage/complete", async (request) => {
    const parsed = completionSchema.safeParse(request.body);
    if (!parsed.success) throw options.problem(400, "IDEMPOTENCY_KEY_REQUIRED", "请重新提交当前节点");
    const principal = await requireDriver(database, request, request.params.id, options.problem);
    await database.transaction(async (tx) => {
      const order = await tx.prepare<Row>("SELECT * FROM wash_orders WHERE id = ? FOR UPDATE").get(request.params.id);
      const evidence = await tx.prepare<Row>("SELECT * FROM wash_valet_evidence WHERE order_id = ? AND stage = ? FOR UPDATE").get(request.params.id, request.params.stage);
      if (!order || !evidence) throw options.problem(409, "WASH_VALET_PHOTO_REQUIRED", "请先拍摄一张车辆全景");
      if (evidence.completed_at) {
        if (String(evidence.completion_idempotency_key) !== parsed.data.idempotencyKey) throw options.problem(409, "WASH_VALET_COMPLETION_CONFLICT", "当前节点已经提交");
        return;
      }
      const expected = request.params.stage === "owner_pickup" ? "driver_arranged" : "returning";
      if (String(order.fulfillment_status) !== expected) throw options.problem(409, "WASH_VALET_STAGE_NOT_READY", "当前履约状态不能提交此留证");
      const at = now().toISOString();
      const next = request.params.stage === "owner_pickup" ? "picked_up" : "completed";
      await tx.prepare("UPDATE wash_valet_evidence SET completion_idempotency_key = ?, completed_at = ?::timestamptz WHERE id = ?")
        .run(parsed.data.idempotencyKey, at, String(evidence.id));
      await tx.prepare(`UPDATE wash_orders SET fulfillment_status = ?, completed_at = CASE WHEN ? = 'completed' THEN ?::timestamptz ELSE completed_at END, updated_at = ? WHERE id = ?`)
        .run(next, next, at, at, request.params.id);
      await tx.prepare(`UPDATE wash_valet_assignments SET status = ?,
        completed_at = CASE WHEN ? = 'completed' THEN ?::timestamptz ELSE completed_at END,
        verification_code_hmac = CASE WHEN ? = 'completed' THEN NULL ELSE verification_code_hmac END,
        verification_code_ciphertext = CASE WHEN ? = 'completed' THEN NULL ELSE verification_code_ciphertext END,
        verification_code_expires_at = CASE WHEN ? = 'completed' THEN NULL ELSE verification_code_expires_at END,
        updated_at = ?::timestamptz WHERE order_id = ?`)
        .run(next === "completed" ? "completed" : "in_progress", next, at, next, next, next, at, request.params.id);
      await tx.prepare(`INSERT INTO wash_order_events (id, order_id, status, title, description, actor_type, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'driver', ?, ?)`)
        .run(randomUUID(), request.params.id, next, next === "completed" ? "车辆已送回" : "司机已取车", next === "completed" ? "送回全景照已封存，洗车代驾履约完成" : "取车全景照已封存，车辆前往洗车门店", JSON.stringify({ userId: principal.user_id, evidenceId: evidence.id }), at);
      if (next === "completed") await tx.prepare("UPDATE wash_valet_sessions SET revoked_at = ?::timestamptz WHERE assignment_id = ? AND revoked_at IS NULL").run(at, String(principal.id));
    });
    return { data: await taskDto(database, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/wash-driver/tasks/:id/start-return", async (request) => {
    const parsed = completionSchema.safeParse(request.body);
    if (!parsed.success) throw options.problem(400, "IDEMPOTENCY_KEY_REQUIRED", "请重新发起返程");
    const principal = await requireDriver(database, request, request.params.id, options.problem);
    await database.transaction(async (tx) => {
      const order = await tx.prepare<Row>("SELECT * FROM wash_orders WHERE id = ? FOR UPDATE").get(request.params.id);
      if (!order) throw options.problem(404, "DRIVER_TASK_NOT_FOUND", "未找到代驾任务");
      if (String(order.fulfillment_status) === "returning") return;
      if (String(order.fulfillment_status) !== "store_service_completed" || String(order.status) !== "redeemed") {
        throw options.problem(409, "WASH_STORE_REDEMPTION_REQUIRED", "洗车门店核销完成后才能开始返程");
      }
      const at = now().toISOString();
      await tx.prepare("UPDATE wash_orders SET fulfillment_status = 'returning', updated_at = ? WHERE id = ?").run(at, request.params.id);
      await tx.prepare(`INSERT INTO wash_order_events (id, order_id, status, title, description, actor_type, metadata_json, created_at)
        VALUES (?, ?, 'returning', '司机开始返程', '门店已核销，车辆正在送回车主取送地址', 'driver', ?, ?)`)
        .run(randomUUID(), request.params.id, JSON.stringify({ userId: principal.user_id, idempotencyKey: parsed.data.idempotencyKey }), at);
    });
    return { data: await taskDto(database, request.params.id) };
  });

  app.get<{ Params: { id: string; stage: Stage; mediaId: string } }>("/api/wash-driver/tasks/:id/evidence/:stage/media/:mediaId", async (request, reply) => {
    await requireDriver(database, request, request.params.id, options.problem);
    const row = await database.prepare<Row>("SELECT * FROM wash_valet_evidence WHERE id = ? AND order_id = ? AND stage = ?").get(request.params.mediaId, request.params.id, request.params.stage);
    if (!row) throw options.problem(404, "WASH_VALET_PHOTO_NOT_FOUND", "未找到现场照片");
    reply.type(String(row.mime_type)).header("cache-control", "private, max-age=3600");
    return reply.send(createReadStream(join(directory, String(row.storage_key))));
  });
}
