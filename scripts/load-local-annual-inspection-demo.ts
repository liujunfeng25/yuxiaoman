import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";

type Json = Record<string, any>;
type HttpMethod = "GET" | "POST" | "PUT";
type Crop = { left: number; top: number; width: number; height: number };
type SourceRef = { msgId: string; crop?: Crop };
type VehicleMediaManifest = {
  frontLeft: SourceRef;
  frontRight: SourceRef;
  rearLeft: SourceRef;
  rearRight: SourceRef;
  dashboardStarted: SourceRef;
  licenseFront: SourceRef;
  licenseBack: SourceRef | null;
  annualInspectionMark: SourceRef | null;
  safetyInspectionReport?: SourceRef | null;
};
type VehicleManifest = {
  plateNumber: string;
  vehicleType: string;
  registrationDate: string;
  inspectionDueDate: string;
  washVehicleCategory: "sedan" | "suv";
  media: VehicleMediaManifest;
};
type LocalManifest = {
  manifestVersion: number;
  sourceDirectory: string;
  selfDrive: VehicleManifest;
  valet: VehicleManifest;
};
type PreparedMedia = {
  path: string;
  sha256: string;
  provenance: "real_local_source" | "synthetic_test_placeholder";
};
type PreparedVehicleMedia = Record<Exclude<keyof VehicleMediaManifest, "safetyInspectionReport">, PreparedMedia> & {
  safetyInspectionReport: PreparedMedia;
};
type DemoEligibilityOverride = {
  enabled: true;
  effectiveDueDate: string;
  confirmedAt: string;
};
type DemoBackofficeCredential = {
  loginName: string;
  password: string;
  role: "platform_admin" | "inspection_station_admin" | "repair_shop_admin";
  stationId: string | null;
  repairShopId: string | null;
};

type DemoRepairShop = {
  id: string;
  name: string;
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const runtimeRoot = join(repositoryRoot, ".runtime", "annual-demo-media");
const defaultManifestPath = join(runtimeRoot, "manifest.local.json");
const defaultSchema = "local_annual_demo";
const eventStepDelayMs = 50;

function loadRepositoryEnv(): void {
  const envPath = join(repositoryRoot, ".env");
  try {
    for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (!["TEST_DATABASE_URL", "DATABASE_URL"].includes(key) || process.env[key]?.trim()) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) process.env[key] = value;
    }
  } catch {
    // The caller may provide both URLs through the environment.
  }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数值`);
  return value;
}

function databaseTarget(value: string, variableName: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} 必须是有效的 PostgreSQL URL`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${variableName} 必须使用 postgres/postgresql 协议`);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const port = parsed.port || "5432";
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/gu, ""));
  if (!host || !database) throw new Error(`${variableName} 必须包含主机和数据库名`);
  return { host, port, database };
}

function assertIsolatedTarget(testUrl: string, schema: string): void {
  const test = databaseTarget(testUrl, "TEST_DATABASE_URL");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(test.host)) {
    throw new Error(`拒绝连接非本机测试库：${test.host}`);
  }
  if (!/test/iu.test(test.database)) {
    throw new Error(`拒绝连接数据库名不含 test 的目标：${test.database}`);
  }
  if (!/^local_annual_demo(?:_[a-z0-9_]+)?$/u.test(schema)) {
    throw new Error(`隔离 schema 必须以 local_annual_demo 开头，当前为 ${schema}`);
  }
  const runtimeUrl = process.env.DATABASE_URL?.trim();
  if (!runtimeUrl) return;
  const runtime = databaseTarget(runtimeUrl, "DATABASE_URL");
  if (test.host === runtime.host && test.port === runtime.port && test.database === runtime.database) {
    throw new Error("拒绝执行：TEST_DATABASE_URL 与 DATABASE_URL 指向同一个数据库");
  }
}

function dateAfterDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function randomDemoPassword(): string {
  return `Yxm-${randomBytes(18).toString("base64url")}`;
}

function readManifest(path: string): LocalManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as LocalManifest;
  if (parsed.manifestVersion !== 1) throw new Error("仅支持 manifestVersion=1");
  if (!parsed.sourceDirectory || !parsed.selfDrive?.media || !parsed.valet?.media) {
    throw new Error("本机素材 manifest 结构不完整");
  }
  return parsed;
}

function assertLocalMaterialPolicy(manifest: LocalManifest, allowSyntheticDocument: boolean): void {
  if (
    (!manifest.selfDrive.media.safetyInspectionReport || !manifest.valet.media.safetyInspectionReport)
    && !allowSyntheticDocument
  ) {
    throw new Error(
      "两套素材都必须提供机动车安全技术检验报告或检测结果单；"
      + "仅隔离测试可显式追加 --allow-synthetic-document 生成永久水印占位。",
    );
  }
  if (!manifest.valet.media.licenseBack && !allowSyntheticDocument) {
    throw new Error(
      `${manifest.valet.plateNumber} 缺少真实行驶证副页；默认拒绝伪装完整资料。`
      + "仅允许在隔离测试库中显式追加 --allow-synthetic-document，生成带“仅测试·行驶证副页占位”水印的占位图。",
    );
  }
  if (!manifest.selfDrive.media.annualInspectionMark && !allowSyntheticDocument) {
    throw new Error(
      `${manifest.selfDrive.plateNumber} 没有对应的真实年检合格标志；通过结论发布需要标志图片。`
      + "隔离测试可用 --allow-synthetic-document 生成显著标记的测试占位图。",
    );
  }
}

function sourceFileFor(reference: SourceRef, sourceDirectory: string): string {
  if (!/^\d{6,25}$/u.test(reference.msgId)) throw new Error(`非法 MsgID：${reference.msgId}`);
  const matches = readdirSync(sourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes(`MsgID=${reference.msgId}`))
    .map((entry) => join(sourceDirectory, entry.name));
  if (matches.length !== 1) {
    throw new Error(`MsgID=${reference.msgId} 应命中且只能命中 1 张图片，实际为 ${matches.length}`);
  }
  if (statSync(matches[0]!).size <= 0) throw new Error(`MsgID=${reference.msgId} 是空文件`);
  return matches[0]!;
}

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizePlateText(value: string): string {
  return value.replace(/[·•\s-]/gu, "").toUpperCase();
}

async function normalizeRealImage(
  reference: SourceRef,
  sourceDirectory: string,
  destination: string,
): Promise<PreparedMedia> {
  const source = sourceFileFor(reference, sourceDirectory);
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new Error(`MsgID=${reference.msgId} 不是可解析的图片`);
  }
  let pipeline = sharp(source).rotate();
  if (reference.crop) {
    const { left, top, width, height } = reference.crop;
    if (
      ![left, top, width, height].every(Number.isInteger)
      || left < 0 || top < 0 || width <= 0 || height <= 0
      || left + width > metadata.width || top + height > metadata.height
    ) {
      throw new Error(`MsgID=${reference.msgId} 的 crop 超出图片范围`);
    }
    pipeline = pipeline.extract(reference.crop);
  }
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline.jpeg({ quality: 90, mozjpeg: true }).toFile(destination);
  const normalized = readFileSync(destination);
  return { path: destination, sha256: digest(normalized), provenance: "real_local_source" };
}

async function createSyntheticPlaceholder(
  destination: string,
  title: string,
  detail: string,
): Promise<PreparedMedia> {
  const svg = Buffer.from(`
    <svg width="1400" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="1400" height="900" fill="#fffaf7"/>
      <rect x="24" y="24" width="1352" height="852" rx="32" fill="none" stroke="#c62828" stroke-width="12"/>
      <g transform="rotate(-18 700 450)" fill="#c62828" opacity="0.10"
         font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="76" font-weight="700">
        <text x="40" y="250">仅测试 · TEST ONLY</text>
        <text x="370" y="490">仅测试 · TEST ONLY</text>
        <text x="700" y="730">仅测试 · TEST ONLY</text>
      </g>
      <text x="700" y="355" text-anchor="middle" fill="#9d1c1c"
        font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="70" font-weight="800">${title}</text>
      <text x="700" y="465" text-anchor="middle" fill="#3d4552"
        font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="42">${detail}</text>
      <text x="700" y="555" text-anchor="middle" fill="#c62828"
        font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="38" font-weight="700">不得作为真实车辆资料或检测机构签发凭证</text>
    </svg>
  `);
  mkdirSync(dirname(destination), { recursive: true });
  await sharp(svg).jpeg({ quality: 94 }).toFile(destination);
  const buffer = readFileSync(destination);
  return { path: destination, sha256: digest(buffer), provenance: "synthetic_test_placeholder" };
}

async function prepareVehicleMedia(
  name: "self-drive" | "valet",
  vehicle: VehicleManifest,
  sourceDirectory: string,
  preparedRoot: string,
  allowSyntheticDocument: boolean,
): Promise<PreparedVehicleMedia> {
  const output = {} as PreparedVehicleMedia;
  const realKeys = [
    "frontLeft",
    "frontRight",
    "rearLeft",
    "rearRight",
    "dashboardStarted",
    "licenseFront",
  ] as const;
  for (const key of realKeys) {
    output[key] = await normalizeRealImage(
      vehicle.media[key],
      sourceDirectory,
      join(preparedRoot, name, `${key}.jpg`),
    );
  }
  if (vehicle.media.licenseBack) {
    output.licenseBack = await normalizeRealImage(
      vehicle.media.licenseBack,
      sourceDirectory,
      join(preparedRoot, name, "licenseBack.jpg"),
    );
  } else {
    if (!allowSyntheticDocument) throw new Error(`${vehicle.plateNumber} 缺少行驶证副页`);
    output.licenseBack = await createSyntheticPlaceholder(
      join(preparedRoot, name, "licenseBack.TEST-ONLY.jpg"),
      "仅测试·行驶证副页占位",
      `${vehicle.plateNumber} 未提供真实副页`,
    );
  }
  if (vehicle.media.annualInspectionMark) {
    output.annualInspectionMark = await normalizeRealImage(
      vehicle.media.annualInspectionMark,
      sourceDirectory,
      join(preparedRoot, name, "annualInspectionMark.jpg"),
    );
  } else {
    if (!allowSyntheticDocument) throw new Error(`${vehicle.plateNumber} 缺少年检合格标志`);
    output.annualInspectionMark = await createSyntheticPlaceholder(
      join(preparedRoot, name, "annualInspectionMark.TEST-ONLY.jpg"),
      "仅测试·年检标占位",
      `${vehicle.plateNumber} 未提供真实检测机构签发标志`,
    );
  }
  if (vehicle.media.safetyInspectionReport) {
    output.safetyInspectionReport = await normalizeRealImage(
      vehicle.media.safetyInspectionReport,
      sourceDirectory,
      join(preparedRoot, name, "safetyInspectionReport.jpg"),
    );
  } else {
    if (!allowSyntheticDocument) throw new Error(`${vehicle.plateNumber} 缺少机动车安全技术检验报告`);
    output.safetyInspectionReport = await createSyntheticPlaceholder(
      join(preparedRoot, name, "safetyInspectionReport.TEST-ONLY.jpg"),
      "仅测试·安全技术检验报告占位",
      `${vehicle.plateNumber} 未提供检测机构正式报告`,
    );
  }
  return output;
}

function multipartBody(kind: string, image: Buffer) {
  const boundary = `----yuxiaoman-local-demo-${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${kind}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

async function uploadImage(
  app: FastifyInstance,
  url: string,
  kind: string,
  media: PreparedMedia,
  token?: string,
): Promise<Json> {
  const { boundary, body } = multipartBody(kind, readFileSync(media.path));
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body,
  });
  if (response.statusCode !== 201) {
    throw new Error(`上传 ${kind} 到 ${url} 失败（${response.statusCode}）：${response.body}`);
  }
  return response.json<Json>().data;
}

async function requestData(
  app: FastifyInstance,
  method: HttpMethod,
  url: string,
  expectedStatus: number,
  options: { payload?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<Json> {
  const response = await app.inject({
    method,
    url,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
  });
  if (response.statusCode !== expectedStatus) {
    throw new Error(`${method} ${url} 失败（${response.statusCode}）：${response.body}`);
  }
  return response.json<Json>().data;
}

async function statePause(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, eventStepDelayMs));
}

async function mutate(
  app: FastifyInstance,
  method: Exclude<HttpMethod, "GET">,
  url: string,
  expectedStatus: number,
  options: { payload?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<Json> {
  const data = await requestData(app, method, url, expectedStatus, options);
  await statePause();
  return data;
}

async function createVehicle(
  app: FastifyInstance,
  database: Json,
  token: string,
  manifest: VehicleManifest,
  eligibilityOverride: DemoEligibilityOverride | null,
): Promise<Json> {
  const vehicle = await mutate(app, "POST", "/api/vehicles", 201, {
    token,
    payload: {
      plateNumber: manifest.plateNumber,
      vehicleType: manifest.vehicleType,
      usageNature: "非营运",
      seats: 5,
      registrationDate: manifest.registrationDate,
      inspectionDueDate: manifest.inspectionDueDate,
      powertrainType: "gasoline",
      vehicleClassCode: "passenger_car",
      isVan: false,
      washVehicleCategory: manifest.washVehicleCategory,
    },
  });
  if (!eligibilityOverride) return vehicle;
  const updated = await database.prepare(`
    UPDATE vehicles SET
      inspection_due_date = ?,
      inspection_due_date_source = 'internal_placeholder',
      inspection_due_date_confirmed_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    eligibilityOverride.effectiveDueDate,
    eligibilityOverride.confirmedAt,
    eligibilityOverride.confirmedAt,
    vehicle.id,
  );
  if (updated.changes !== 1) throw new Error("隔离演示有效期覆盖没有写入车辆档案");
  const status = await requestData(app, "GET", `/api/inspection/status/${vehicle.id}`, 200, { token });
  if (
    status.canBook !== true
    || status.inspectionDueDateSource !== "internal_placeholder"
    || status.inspectionValidity?.mode !== "confirmed"
    || status.inspectionValidity?.demoOnly !== true
    || status.dateEvidence?.comparison !== "matched"
  ) {
    throw new Error(`隔离演示有效期覆盖未形成可预约状态：${JSON.stringify(status)}`);
  }
  return { ...vehicle, inspectionDueDate: eligibilityOverride.effectiveDueDate };
}

async function createDemoBackofficeCredentials(
  database: Json,
  stationId: string,
  repairShops: readonly DemoRepairShop[],
): Promise<{
  platformAdmin: DemoBackofficeCredential;
  stationAdmin: DemoBackofficeCredential;
  repairAdmins: DemoBackofficeCredential[];
}> {
  const { hashBackofficePassword } = await import("../server/backoffice.js");
  const platformAdmin: DemoBackofficeCredential = {
    loginName: "local.demo.platform",
    password: randomDemoPassword(),
    role: "platform_admin",
    stationId: null,
    repairShopId: null,
  };
  const stationAdmin: DemoBackofficeCredential = {
    loginName: "station",
    password: randomDemoPassword(),
    role: "inspection_station_admin",
    stationId,
    repairShopId: null,
  };
  const repairAdmins = repairShops.map((shop, index): DemoBackofficeCredential => ({
    loginName: `demo${index + 1}`,
    password: randomDemoPassword(),
    role: "repair_shop_admin",
    stationId: null,
    repairShopId: shop.id,
  }));
  const credentials = [platformAdmin, stationAdmin, ...repairAdmins];
  const passwordHashes = new Map<string, string>();
  for (const credential of credentials) {
    passwordHashes.set(credential.loginName, await hashBackofficePassword(credential.password));
  }
  const now = new Date().toISOString();

  await database.transaction(async (tx: Json) => {
    const accountIds = new Map<string, string>();
    for (const credential of credentials) {
      const normalized = credential.loginName.toLocaleLowerCase("en-US");
      const existing = await tx.prepare(`
        SELECT id FROM backoffice_accounts WHERE login_name_normalized = ?
      `).get(normalized) as Json | undefined;
      const accountId = existing?.id ? String(existing.id) : randomUUID();
      accountIds.set(credential.loginName, accountId);
      await tx.prepare(`
        INSERT INTO backoffice_accounts (
          id, login_name, login_name_normalized, display_name, password_hash,
          role, status, permission_version, last_login_at, created_at, updated_at, disabled_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, NULL, ?::timestamptz, ?::timestamptz, NULL)
        ON CONFLICT (id) DO UPDATE SET
          login_name = excluded.login_name,
          login_name_normalized = excluded.login_name_normalized,
          display_name = excluded.display_name,
          password_hash = excluded.password_hash,
          role = excluded.role,
          status = 'active',
          permission_version = backoffice_accounts.permission_version + 1,
          updated_at = excluded.updated_at,
          disabled_at = NULL
      `).run(
        accountId,
        credential.loginName,
        normalized,
        credential.role === "platform_admin"
          ? "本机演示平台管理员"
          : credential.role === "inspection_station_admin"
            ? "本机演示检测站管理员"
            : `${repairShops.find((shop) => shop.id === credential.repairShopId)?.name || "演示维修门店"}管理员`,
        passwordHashes.get(credential.loginName),
        credential.role,
        now,
        now,
      );
      await tx.prepare(`
        UPDATE backoffice_sessions SET revoked_at = ?::timestamptz
        WHERE account_id = ? AND revoked_at IS NULL
      `).run(now, accountId);
      await tx.prepare(`
        UPDATE backoffice_invites SET invalidated_at = ?::timestamptz
        WHERE account_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
      `).run(now, accountId);
      await tx.prepare(`
        UPDATE backoffice_subject_assignments
        SET status = 'revoked', revoked_at = ?::timestamptz
        WHERE account_id = ? AND status IN ('pending', 'active')
      `).run(now, accountId);
      await tx.prepare(`
        DELETE FROM backoffice_login_attempts WHERE login_name_normalized = ?
      `).run(normalized);
    }

    await tx.prepare(`
      UPDATE backoffice_subject_assignments
      SET status = 'revoked', revoked_at = ?::timestamptz
      WHERE subject_type = 'inspection_station' AND subject_id = ?
        AND status IN ('pending', 'active')
    `).run(now, stationId);
    await tx.prepare(`
      INSERT INTO backoffice_subject_assignments (
        id, account_id, subject_type, subject_id, status,
        replaces_assignment_id, created_at, activated_at, revoked_at
      ) VALUES (?, ?, 'inspection_station', ?, 'active', NULL,
        ?::timestamptz, ?::timestamptz, NULL)
    `).run(
      randomUUID(),
      accountIds.get(stationAdmin.loginName),
      stationId,
      now,
      now,
    );

    for (const credential of repairAdmins) {
      await tx.prepare(`
        UPDATE backoffice_subject_assignments
        SET status = 'revoked', revoked_at = ?::timestamptz
        WHERE subject_type = 'repair_shop' AND subject_id = ?
          AND status IN ('pending', 'active')
      `).run(now, credential.repairShopId);
      await tx.prepare(`
        INSERT INTO backoffice_subject_assignments (
          id, account_id, subject_type, subject_id, status,
          replaces_assignment_id, created_at, activated_at, revoked_at
        ) VALUES (?, ?, 'repair_shop', ?, 'active', NULL,
          ?::timestamptz, ?::timestamptz, NULL)
      `).run(
        randomUUID(),
        accountIds.get(credential.loginName),
        credential.repairShopId,
        now,
        now,
      );
    }
  });

  return { platformAdmin, stationAdmin, repairAdmins };
}

const bookingKindMap = {
  frontLeft: "vehicle_front_left",
  frontRight: "vehicle_front_right",
  rearLeft: "vehicle_rear_left",
  rearRight: "vehicle_rear_right",
  dashboardStarted: "dashboard_started",
  licenseFront: "license_front",
  licenseBack: "license_back",
} as const;

const sceneKindMap = {
  frontLeft: "front_left",
  frontRight: "front_right",
  rearLeft: "rear_left",
  rearRight: "rear_right",
  dashboardStarted: "dashboard_started",
} as const;

async function uploadBookingMedia(
  app: FastifyInstance,
  token: string,
  prepared: PreparedVehicleMedia,
  mode: "self_drive" | "valet",
): Promise<string[]> {
  const keys = mode === "self_drive"
    ? (Object.keys(bookingKindMap) as Array<keyof typeof bookingKindMap>)
    : (["licenseFront", "licenseBack"] as const);
  const ids: string[] = [];
  for (const key of keys) {
    const uploaded = await uploadImage(app, "/api/media", bookingKindMap[key], prepared[key], token);
    ids.push(String(uploaded.id));
  }
  return ids;
}

async function uploadSceneMedia(
  app: FastifyInstance,
  url: string,
  prepared: PreparedVehicleMedia,
  token?: string,
): Promise<void> {
  for (const key of Object.keys(sceneKindMap) as Array<keyof typeof sceneKindMap>) {
    await uploadImage(app, url, sceneKindMap[key], prepared[key], token);
  }
}

async function preparePassedReport(
  app: FastifyInstance,
  bookingId: string,
  prepared: PreparedVehicleMedia,
  note: string,
): Promise<void> {
  await mutate(app, "PUT", `/api/operator/bookings/${bookingId}/checkup-report`, 200, {
    payload: {
      observationMode: "no_visible_faults",
      diagramVersion: "sedan-3view-v1",
      annualInspection: { conclusion: "passed" },
      summary: { conclusionLabel: "检验合格", note },
      faults: [],
    },
  });
  await uploadSceneMedia(app, `/api/operator/bookings/${bookingId}/checkup-report/media`, prepared);
  await uploadImage(
    app,
    `/api/operator/bookings/${bookingId}/checkup-report/media`,
    "safety_inspection_report",
    prepared.safetyInspectionReport,
  );
  await uploadImage(
    app,
    `/api/operator/bookings/${bookingId}/checkup-report/media`,
    "annual_inspection_mark",
    prepared.annualInspectionMark,
  );
}

async function createBooking(
  app: FastifyInstance,
  token: string,
  values: {
    vehicleId: string;
    stationId: string;
    slotId: string;
    mode: "self_drive" | "valet";
    prepared: PreparedVehicleMedia;
    pickupAddress?: Json;
    notes: string;
  },
): Promise<Json> {
  const quote = await mutate(app, "POST", "/api/bookings/quote", 200, {
    token,
    payload: {
      vehicleId: values.vehicleId,
      stationId: values.stationId,
      serviceMode: values.mode,
      ...(values.pickupAddress ? { pickupAddress: values.pickupAddress } : {}),
    },
  });
  if (quote.serviceable !== true || quote.pricingEligibility !== "supported") {
    throw new Error(`${values.mode} 报价未进入可预约状态：${JSON.stringify(quote)}`);
  }
  const mediaIds = await uploadBookingMedia(app, token, values.prepared, values.mode);
  return mutate(app, "POST", "/api/bookings", 201, {
    token,
    payload: {
      vehicleId: values.vehicleId,
      stationId: values.stationId,
      slotId: values.slotId,
      contactName: values.mode === "valet" ? "刘先生" : "李女士",
      contactPhone: values.mode === "valet" ? "13800138001" : "13800138002",
      serviceMode: values.mode,
      ...(values.pickupAddress ? { pickupAddress: values.pickupAddress } : {}),
      quoteSnapshotId: quote.quoteSnapshotId,
      mediaIds,
      notes: values.notes,
    },
  });
}

async function pay(app: FastifyInstance, token: string, booking: Json, key: string): Promise<void> {
  const result = await mutate(app, "POST", `/api/bookings/${booking.id}/payments`, 201, {
    token,
    payload: { provider: "mock", idempotencyKey: key, quoteSnapshotId: booking.quoteSnapshotId },
  });
  if (result.booking?.fulfillmentStatus !== "confirmed") throw new Error("模拟支付后订单未自动进入已确认");
}

async function runSelfDriveFlow(
  app: FastifyInstance,
  database: Json,
  token: string,
  vehicleManifest: VehicleManifest,
  prepared: PreparedVehicleMedia,
  stationId: string,
  slotId: string,
  eligibilityOverride: DemoEligibilityOverride | null,
): Promise<string> {
  const vehicle = await createVehicle(app, database, token, vehicleManifest, eligibilityOverride);
  const eligibilityNote = eligibilityOverride
    ? `DEMO-ONLY：素材记录有效期为${vehicleManifest.inspectionDueDate}；隔离演示档案临时设为${eligibilityOverride.effectiveDueDate}。`
    : "";
  const booking = await createBooking(app, token, {
    vehicleId: vehicle.id,
    stationId,
    slotId,
    mode: "self_drive",
    prepared,
    notes: `本机隔离演示：使用用户提供的${vehicleManifest.plateNumber}真实车辆与证件照片；年检标为显著标记的测试占位图。${eligibilityNote}`,
  });
  await pay(app, token, booking, "local-selfdrive-payment-0001");
  await mutate(app, "POST", `/api/operator/bookings/${booking.id}/accept`, 200, { payload: {} });
  await mutate(app, "POST", `/api/operator/bookings/${booking.id}/check-in`, 200, {
    payload: {
      plateMatched: true,
      materialsReady: true,
      exteriorRecorded: true,
      vehicleConditionConfirmed: true,
      notes: "本机真实素材闭环测试：到站核验通过",
    },
  });
  await mutate(app, "POST", `/api/operator/bookings/${booking.id}/handoff`, 200, { payload: {} });
  await preparePassedReport(
    app,
    booking.id,
    prepared,
    `本机隔离流程测试：五张现场照片来自${vehicleManifest.plateNumber}真实素材；年检标为仅测试占位图，不代表检测机构真实签发。${eligibilityNote}`,
  );
  const published = await mutate(app, "POST", `/api/operator/bookings/${booking.id}/inspection-result`, 200, {
    payload: {},
    headers: { "idempotency-key": "local-selfdrive-result-0001" },
  });
  if (published.inspectionResult?.conclusion !== "passed") throw new Error("自驾报告未发布为通过");
  // New self-drive reports atomically complete the service when they are
  // published. Keep the fallback for an older compatible API so this local
  // fixture loader remains usable across both lifecycle implementations.
  const completed = published.fulfillmentStatus === "completed"
    ? published
    : await mutate(app, "POST", `/api/operator/bookings/${booking.id}/complete`, 200, { payload: {} });
  if (completed.fulfillmentStatus !== "completed") throw new Error("自驾订单未完成");
  return String(booking.id);
}

async function runValetFlow(
  app: FastifyInstance,
  database: Json,
  ownerToken: string,
  vehicleManifest: VehicleManifest,
  prepared: PreparedVehicleMedia,
  stationId: string,
  slotId: string,
  eligibilityOverride: DemoEligibilityOverride | null,
): Promise<string> {
  const vehicle = await createVehicle(app, database, ownerToken, vehicleManifest, eligibilityOverride);
  const eligibilityNote = eligibilityOverride
    ? `DEMO-ONLY：素材记录有效期为${vehicleManifest.inspectionDueDate}；隔离演示档案临时设为${eligibilityOverride.effectiveDueDate}。`
    : "";
  const pickupAddress = {
    poiId: "local-annual-demo-pickup",
    title: "天津文化中心地下停车场",
    address: "天津市河西区平江道58号 B2层演示取车位",
    district: "河西区",
    latitude: 39.0837,
    longitude: 117.2197,
    source: "tencent",
    note: "本机隔离测试地址，不接触真实车辆",
  };
  const booking = await createBooking(app, ownerToken, {
    vehicleId: vehicle.id,
    stationId,
    slotId,
    mode: "valet",
    prepared,
    pickupAddress,
    notes: `本机隔离演示：${vehicleManifest.plateNumber}缺少真实行驶证副页，预约资料中的副页为带永久水印的测试占位图，不得视作真实证件。${eligibilityNote}`,
  });
  await pay(app, ownerToken, booking, "local-valet-payment-0001");

  const assignment = await mutate(app, "POST", `/api/admin/bookings/${booking.id}/driver-assignment`, 201, {
    payload: { receptionistName: "王大海", receptionistPhone: "13900139000" },
  });
  const verificationCode = String(assignment.assignment?.verificationCode ?? assignment.verificationCode ?? "");
  if (!/^\d{6}$/u.test(verificationCode)) throw new Error("后台未生成 6 位代驾验证码");
  const exchanged = await mutate(app, "POST", "/api/driver/task-sessions/exchange", 201, {
    token: ownerToken,
    payload: { verificationCode },
  });
  const driverToken = String(exchanged.token ?? "");
  if (!driverToken.startsWith("yxm_drv_")) throw new Error("代驾验证码兑换未返回司机令牌");

  await uploadSceneMedia(
    app,
    `/api/driver/tasks/${booking.id}/evidence/owner_pickup/media`,
    prepared,
    driverToken,
  );
  const pickedUp = await mutate(app, "POST", `/api/driver/tasks/${booking.id}/evidence/owner_pickup/complete`, 200, {
    token: driverToken,
    payload: { idempotencyKey: "local-owner-pickup-complete-0001" },
  });
  if (pickedUp.status !== "picked_up") throw new Error("取车留证未推进为已取车");

  await uploadSceneMedia(app, `/api/operator/bookings/${booking.id}/evidence/station_arrival/media`, prepared);
  const arrived = await mutate(app, "POST", `/api/operator/bookings/${booking.id}/evidence/station_arrival/complete`, 200, {
    payload: {
      idempotencyKey: "local-station-arrival-complete-0001",
      verification: {
        plateMatched: true,
        materialsReady: true,
        exteriorRecorded: true,
        vehicleConditionConfirmed: true,
        notes: "本机真实素材闭环测试：检测站接车核验通过",
      },
    },
  });
  if (arrived.fulfillmentStatus !== "checked_in") throw new Error("检测站接车未推进为已到站");
  await mutate(app, "POST", `/api/operator/bookings/${booking.id}/handoff`, 200, { payload: {} });

  await preparePassedReport(
    app,
    booking.id,
    prepared,
    `本机隔离流程测试：五张检测照片与机动车检验合格标志均引用${vehicleManifest.plateNumber}的用户提供真实素材。${eligibilityNote}`,
  );
  const published = await mutate(app, "POST", `/api/operator/bookings/${booking.id}/inspection-result`, 200, {
    payload: {},
    headers: { "idempotency-key": "local-valet-result-0001" },
  });
  if (published.inspectionResult?.conclusion !== "passed") throw new Error("代驾报告未发布为通过");

  const returning = await mutate(app, "POST", `/api/driver/tasks/${booking.id}/start-return`, 200, {
    token: driverToken,
    payload: { idempotencyKey: "local-start-return-0001" },
  });
  if (returning.status !== "returning") throw new Error("代驾任务未推进为送回中");
  await uploadSceneMedia(
    app,
    `/api/driver/tasks/${booking.id}/evidence/owner_return/media`,
    prepared,
    driverToken,
  );
  const completed = await mutate(app, "POST", `/api/driver/tasks/${booking.id}/evidence/owner_return/complete`, 200, {
    token: driverToken,
    payload: { idempotencyKey: "local-owner-return-complete-0001" },
  });
  if (completed.status !== "completed") throw new Error("送回留证未推进为服务完成");
  return String(booking.id);
}

async function verifyBooking(
  app: FastifyInstance,
  database: Json,
  ownerToken: string,
  bookingId: string,
  expected: { mode: "self_drive" | "valet"; bookingPhotos: number; plateNormalized: string },
): Promise<Json> {
  const owner = await requestData(app, "GET", `/api/bookings/${bookingId}`, 200, { token: ownerToken });
  const admin = await requestData(app, "GET", `/api/admin/bookings/${bookingId}`, 200);
  if (owner.fulfillmentStatus !== "completed" || owner.serviceMode !== expected.mode) {
    throw new Error(`${bookingId} 车主详情状态或服务方式不正确`);
  }
  if (owner.media?.length !== expected.bookingPhotos) {
    throw new Error(`${bookingId} 预约照片应为 ${expected.bookingPhotos} 张，实际 ${owner.media?.length ?? 0}`);
  }
  const displayedPlate = owner.vehicle?.plateNumber ?? owner.vehicleSnapshot?.plateNumber ?? "";
  const normalizedPlate = normalizePlateText(String(displayedPlate));
  if (normalizedPlate !== expected.plateNormalized) {
    throw new Error(`${bookingId} 车牌与预期 ${expected.plateNormalized} 不一致`);
  }
  if (owner.inspectionResult?.conclusion !== "passed" || owner.vehicleCheckupReport?.status !== "published") {
    throw new Error(`${bookingId} 没有已发布的通过报告`);
  }
  if (owner.vehicleCheckupReport.media?.length !== 7) throw new Error(`${bookingId} 报告材料不是 7 张`);
  if (expected.mode === "valet") {
    const packages = owner.evidencePackages ?? [];
    if (packages.length !== 4 || packages.some((item: Json) => item.status !== "completed" || item.photos?.length !== 5)) {
      throw new Error(`${bookingId} 的四组代驾留证未全部达到 5/5`);
    }
    if (!String(admin.notes ?? "").includes("测试占位图")) {
      throw new Error(`${bookingId} 后台没有披露行驶证副页为测试占位图`);
    }
  }
  const events = await database.prepare(`
    SELECT status, title, actor_type, created_at
    FROM booking_events WHERE booking_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(bookingId) as Json[];
  for (let index = 1; index < events.length; index += 1) {
    const previous = Date.parse(String(events[index - 1]!.created_at));
    const current = Date.parse(String(events[index]!.created_at));
    if (!(current > previous)) {
      throw new Error(
        `${bookingId} 时间线不是严格递增：${events[index - 1]!.title}=${events[index - 1]!.created_at}, `
        + `${events[index]!.title}=${events[index]!.created_at}`,
      );
    }
  }
  return {
    bookingId,
    bookingNumber: owner.bookingNumber,
    plateNumber: owner.vehicle?.plateNumber ?? owner.vehicleSnapshot?.plateNumber,
    serviceMode: owner.serviceMode,
    status: owner.fulfillmentStatus,
    amountFen: owner.priceBreakdown?.totalFeeFen,
    bookingPhotoCount: owner.media.length,
    reportNo: owner.vehicleCheckupReport.reportNo,
    reportPhotoCount: owner.vehicleCheckupReport.media.length,
    evidence: (owner.evidencePackages ?? []).map((item: Json) => ({
      stage: item.stage,
      status: item.status,
      photoCount: item.photos?.length ?? 0,
    })),
    eventCount: events.length,
    firstEventAt: events[0]?.created_at,
    lastEventAt: events.at(-1)?.created_at,
    timeline: events.map((event) => ({
      status: event.status,
      title: event.title,
      actorType: event.actor_type,
      createdAt: event.created_at,
    })),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      "用法：npm run demo:load-annual-local -- [--manifest <path>] [--schema <name>] --allow-synthetic-document --allow-demo-eligibility-override\n"
      + "默认拒绝缺少真实行驶证副页或年检标的素材，也不会改写素材中的真实有效期。"
      + "两个 allow 开关只允许隔离 TEST_DATABASE_URL；有效期覆盖会标记 internal_placeholder/DEMO-ONLY。",
    );
    return;
  }
  const allowSyntheticDocument = process.argv.includes("--allow-synthetic-document");
  const allowDemoEligibilityOverride = process.argv.includes("--allow-demo-eligibility-override");
  const manifestOption = optionValue("--manifest");
  const manifestPath = manifestOption
    ? (isAbsolute(manifestOption) ? manifestOption : resolve(repositoryRoot, manifestOption))
    : defaultManifestPath;
  const schema = optionValue("--schema") ?? defaultSchema;

  loadRepositoryEnv();
  if (process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production") {
    throw new Error("拒绝在 production 环境运行本机演示素材 loader");
  }
  const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!testDatabaseUrl) throw new Error("缺少 TEST_DATABASE_URL，不能证明目标是隔离测试库");
  assertIsolatedTarget(testDatabaseUrl, schema);

  const manifest = readManifest(manifestPath);
  assertLocalMaterialPolicy(manifest, allowSyntheticDocument);
  const sourceDirectory = isAbsolute(manifest.sourceDirectory)
    ? manifest.sourceDirectory
    : resolve(dirname(manifestPath), manifest.sourceDirectory);
  const runDirectory = join(
    runtimeRoot,
    "runs",
    `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`,
  );
  const preparedRoot = join(runDirectory, "prepared");
  const uploadRoot = join(runDirectory, "uploads");
  process.env.XDG_CACHE_HOME = join(runtimeRoot, "font-cache");
  mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
  mkdirSync(preparedRoot, { recursive: true });
  mkdirSync(uploadRoot, { recursive: true });

  const selfDriveMedia = await prepareVehicleMedia(
    "self-drive",
    manifest.selfDrive,
    sourceDirectory,
    preparedRoot,
    allowSyntheticDocument,
  );
  const valetMedia = await prepareVehicleMedia(
    "valet",
    manifest.valet,
    sourceDirectory,
    preparedRoot,
    allowSyntheticDocument,
  );

  process.env.NODE_ENV = "test";
  delete process.env.YUXIAOMAN_ENV;
  process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "true";
  process.env.YUXIAOMAN_ALLOW_BACKOFFICE_TEST_FALLBACK = "true";
  process.env.ALLOW_DEMO_RESET = "true";
  process.env.ALLOW_DEMO_WORKFLOW = "true";
  if (allowDemoEligibilityOverride) process.env.ALLOW_DEMO_ELIGIBILITY_OVERRIDE = "true";
  else delete process.env.ALLOW_DEMO_ELIGIBILITY_OVERRIDE;
  process.env.ALLOW_MOCK_PAYMENT = "true";
  process.env.TENCENT_MAP_KEY = "local-isolated-demo-key";
  process.env.YUXIAOMAN_DB_SCHEMA = schema;
  process.env.YUXIAOMAN_UPLOAD_DIR = uploadRoot;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    status: 0,
    result: { rows: [{ elements: [{ distance: 7_800, duration: 1_200 }] }] },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  const { createDevelopmentSession } = await import("../server/auth.js");
  const { buildApp } = await import("../server/app.js");
  const { createDatabase, DEMO_STATION_ID } = await import("../server/db.js");
  const { DEMO_REPAIR_SHOPS } = await import("../server/repair-db.js");
  const database = await createDatabase({
    connectionString: testDatabaseUrl,
    schema,
    createSchema: true,
    dropSchemaOnClose: false,
    forceSeed: true,
    max: 4,
    applicationName: "yuxiaoman-local-annual-demo-loader",
  });
  let app: FastifyInstance | undefined;
  try {
    const ownerSession = await createDevelopmentSession(database, { userId: "demo-user" });
    app = await buildApp({ database, uploadDir: uploadRoot });
    await app.ready();
    const stations = await requestData(app, "GET", "/api/stations", 200);
    const station = stations.find((item: Json) => item.id === DEMO_STATION_ID);
    if (!station) throw new Error(`找不到演示检测站 ${DEMO_STATION_ID}`);
    const credentials = await createDemoBackofficeCredentials(database, station.id, DEMO_REPAIR_SHOPS);
    const platformLogin = await requestData(app, "POST", "/api/backoffice/sessions", 200, {
      payload: {
        loginName: credentials.platformAdmin.loginName,
        password: credentials.platformAdmin.password,
      },
    });
    if (platformLogin.account?.role !== "platform_admin") throw new Error("平台管理员夹具无法登录");
    const stationLogin = await requestData(app, "POST", "/api/operator/sessions", 200, {
      payload: {
        loginName: credentials.stationAdmin.loginName,
        password: credentials.stationAdmin.password,
      },
    });
    if (
      stationLogin.account?.role !== "inspection_station_admin"
      || stationLogin.subject?.type !== "inspection_station"
      || stationLogin.subject?.id !== station.id
    ) {
      throw new Error("检测站管理员夹具无法登录或站点范围不正确");
    }
    for (const credential of credentials.repairAdmins) {
      const repairLogin = await requestData(app, "POST", "/api/repair-operator/sessions", 200, {
        payload: {
          loginName: credential.loginName,
          password: credential.password,
        },
      });
      if (
        repairLogin.account?.role !== "repair_shop_admin"
        || repairLogin.subject?.type !== "repair_shop"
        || repairLogin.subject?.id !== credential.repairShopId
      ) {
        throw new Error(`维修门店管理员夹具无法登录或门店范围不正确：${credential.repairShopId}`);
      }
    }
    const slots = (await requestData(app, "GET", `/api/stations/${station.id}/slots`, 200))
      .filter((item: Json) => Number(item.remaining) > 0);
    if (slots.length < 2) throw new Error("至少需要两个未开始且有余量的检测时段");

    const eligibilityOverride: DemoEligibilityOverride | null = allowDemoEligibilityOverride
      ? {
          enabled: true,
          effectiveDueDate: dateAfterDays(30),
          confirmedAt: new Date().toISOString(),
        }
      : null;

    const selfDriveBookingId = await runSelfDriveFlow(
      app,
      database,
      ownerSession.token,
      manifest.selfDrive,
      selfDriveMedia,
      station.id,
      slots[0].id,
      eligibilityOverride,
    );
    const valetBookingId = await runValetFlow(
      app,
      database,
      ownerSession.token,
      manifest.valet,
      valetMedia,
      station.id,
      slots[1].id,
      eligibilityOverride,
    );

    const selfDrive = await verifyBooking(app, database, ownerSession.token, selfDriveBookingId, {
      mode: "self_drive",
      bookingPhotos: 7,
      plateNormalized: normalizePlateText(manifest.selfDrive.plateNumber),
    });
    const valet = await verifyBooking(app, database, ownerSession.token, valetBookingId, {
      mode: "valet",
      bookingPhotos: 2,
      plateNormalized: normalizePlateText(manifest.valet.plateNumber),
    });
    const result = {
      generatedAt: new Date().toISOString(),
      database: {
        host: databaseTarget(testDatabaseUrl, "TEST_DATABASE_URL").host,
        database: databaseTarget(testDatabaseUrl, "TEST_DATABASE_URL").database,
        schema,
      },
      isolation: "local-test-only",
      placeholders: {
        valetLicenseBack: valetMedia.licenseBack.provenance === "synthetic_test_placeholder",
        selfDriveAnnualInspectionMark: selfDriveMedia.annualInspectionMark.provenance === "synthetic_test_placeholder",
        selfDriveSafetyInspectionReport: selfDriveMedia.safetyInspectionReport.provenance === "synthetic_test_placeholder",
        valetSafetyInspectionReport: valetMedia.safetyInspectionReport.provenance === "synthetic_test_placeholder",
      },
      eligibilityOverride: eligibilityOverride
        ? {
            marker: "internal_placeholder",
            demoOnly: true,
            confirmed: true,
            effectiveDueDate: eligibilityOverride.effectiveDueDate,
            sourceInspectionDueDates: {
              selfDrive: manifest.selfDrive.inspectionDueDate,
              valet: manifest.valet.inspectionDueDate,
            },
          }
        : { demoOnly: false },
      orders: { selfDrive, valet },
      credentials,
      runtime: {
        manifestPath,
        uploadRoot,
        startCommand:
          `$env:DATABASE_URL=$env:TEST_DATABASE_URL; $env:YUXIAOMAN_DB_SCHEMA='${schema}'; `
          + `${allowDemoEligibilityOverride ? "$env:NODE_ENV='test'; $env:ALLOW_DEMO_ELIGIBILITY_OVERRIDE='true'; " : ""}`
          + `$env:YUXIAOMAN_UPLOAD_DIR='${uploadRoot}'; npm run api:mini:qa-map`,
      },
    };
    const resultPath = join(runtimeRoot, "result.local.json");
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      generatedAt: result.generatedAt,
      database: result.database,
      isolation: result.isolation,
      placeholders: result.placeholders,
      eligibilityOverride: result.eligibilityOverride,
      orders: result.orders,
      credentials: {
        platformAdmin: {
          loginName: credentials.platformAdmin.loginName,
          role: credentials.platformAdmin.role,
          passwordStoredOnlyIn: resultPath,
        },
        stationAdmin: {
          loginName: credentials.stationAdmin.loginName,
          role: credentials.stationAdmin.role,
          stationId: credentials.stationAdmin.stationId,
          passwordStoredOnlyIn: resultPath,
        },
        repairAdmins: credentials.repairAdmins.map((credential) => ({
          loginName: credential.loginName,
          role: credential.role,
          repairShopId: credential.repairShopId,
          passwordStoredOnlyIn: resultPath,
        })),
      },
      runtime: result.runtime,
      resultPath,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
    if (app) await app.close();
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
