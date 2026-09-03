import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  assertCapability,
  auditBackofficeEvent,
  backofficeTestFallbackEnabled,
  BackofficeError,
  requireBackoffice,
  type BackofficeCapability,
  type BackofficeSession,
} from "./backoffice.js";
import type { AppDatabase, DatabaseValue } from "./database.js";
import { readAdminSubsidyConsultationMaterial } from "./subsidy-consultation.js";

type Row = Record<string, unknown>;

const CUSTOMER_TAGS = ["重点客户", "待跟进", "复购客户", "资料待补"] as const;
const CUSTOMER_DOMAINS = [
  "annual_inspection",
  "car_wash",
  "car_rental",
  "insurance",
  "driving_school",
  "subsidy_consultation",
  "repair",
] as const;
const MATERIAL_DOMAINS = [
  "annual_inspection",
  "insurance",
  "driving_school",
  "subsidy_consultation",
  "vehicle_checkup",
  "repair",
] as const;

type CustomerDomain = typeof CUSTOMER_DOMAINS[number];
type MaterialDomain = typeof MATERIAL_DOMAINS[number];

const customerListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  dataKind: z.enum(["real", "demo", "unknown"]).optional(),
  serviceType: z.enum(CUSTOMER_DOMAINS).optional(),
  tag: z.enum(CUSTOMER_TAGS).optional(),
  activeWithinDays: z.coerce.number().int().refine((value) => [7, 30, 90].includes(value)).optional(),
  cursor: z.string().max(1_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const recordsQuerySchema = z.object({
  domain: z.enum(CUSTOMER_DOMAINS).optional(),
  cursor: z.string().max(1_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const materialsQuerySchema = z.object({
  domain: z.enum(MATERIAL_DOMAINS).optional(),
  state: z.enum(["active", "retained", "withdrawn", "expired", "deleted"]).optional(),
  cursor: z.string().max(1_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const noteSchema = z.object({
  content: z.string().trim().min(1, "备注不能为空").max(1_000, "备注不能超过 1000 字"),
});
const tagsSchema = z.object({
  tags: z.array(z.enum(CUSTOMER_TAGS)).max(CUSTOMER_TAGS.length),
});

const RECORD_EVENTS_CTE = `
  customer_record_events AS (
    SELECT user_id, 'annual_inspection'::text AS domain, id AS source_id,
      COALESCE(fulfillment_status, status) AS status, created_at AS occurred_at,
      CASE WHEN COALESCE(fulfillment_status, status) IN ('completed','cancelled','no_show') THEN 0 ELSE 1 END AS is_pending
    FROM bookings
    UNION ALL
    SELECT user_id, 'car_wash', id, status, created_at,
      CASE WHEN status IN ('redeemed','cancelled','refunded','expired') THEN 0 ELSE 1 END
    FROM wash_orders
    UNION ALL
    SELECT user_id, 'car_rental', id, status, created_at,
      CASE WHEN status IN ('completed','cancelled','expired') THEN 0 ELSE 1 END
    FROM car_rental_orders
    UNION ALL
    SELECT user_id, 'insurance', id, status, submitted_at,
      CASE WHEN status IN ('closed','withdrawn') THEN 0 ELSE 1 END
    FROM service_leads
    UNION ALL
    SELECT user_id, 'driving_school', id, status, submitted_at,
      CASE WHEN status IN ('resolved','closed','withdrawn') THEN 0 ELSE 1 END
    FROM driving_school_inquiries
    UNION ALL
    SELECT user_id, 'subsidy_consultation', id, status, submitted_at,
      CASE WHEN status IN ('handled','withdrawn','expired') THEN 0 ELSE 1 END
    FROM subsidy_consultations
    UNION ALL
    SELECT user_id, 'repair', id, status, created_at,
      CASE WHEN status IN ('paid','cancelled') THEN 0 ELSE 1 END
    FROM repair_requests
  )
`;

const RECORD_DETAILS_CTE = `
  customer_records AS (
    SELECT b.user_id, 'annual_inspection'::text AS domain, 'booking'::text AS record_type,
      b.id AS source_id, b.booking_number AS business_code, b.vehicle_id,
      COALESCE(b.fulfillment_status, b.status) AS status, b.service_fee_fen AS amount_fen,
      b.created_at AS occurred_at, '年检预约'::text AS title
    FROM bookings b
    UNION ALL
    SELECT o.user_id, 'car_wash', 'order', o.id, o.order_number, o.vehicle_id,
      o.status, o.total_fee_fen, o.created_at, '洗车订单'
    FROM wash_orders o
    UNION ALL
    SELECT o.user_id, 'car_rental', 'order', o.id, o.order_number, NULL,
      o.status, q.total_fee_fen, o.created_at, '租车订单'
    FROM car_rental_orders o
    LEFT JOIN car_rental_quote_snapshots q ON q.id = o.quote_id
    UNION ALL
    SELECT l.user_id, 'insurance', 'lead', l.id, l.lead_code, l.vehicle_id,
      l.status, NULL, l.submitted_at, '保险续保需求'
    FROM service_leads l
    UNION ALL
    SELECT i.user_id, 'driving_school', 'inquiry', i.id, i.inquiry_code, NULL,
      i.status, NULL, i.submitted_at, '驾校咨询'
    FROM driving_school_inquiries i
    UNION ALL
    SELECT c.user_id, 'subsidy_consultation', 'consultation', c.id, c.consultation_code, c.vehicle_id,
      c.status, c.consultation_fee_fen, c.submitted_at, '政策与资料咨询'
    FROM subsidy_consultations c
    UNION ALL
    SELECT r.user_id, 'repair', 'request', r.id, r.request_no, r.source_vehicle_id,
      r.status, o.total_price_fen, r.created_at, '维修报价请求'
    FROM repair_requests r
    LEFT JOIN repair_orders o ON o.request_id = r.id
  )
`;

const MATERIALS_CTE = `
  customer_materials AS (
    SELECT m.user_id, m.id, 'annual_inspection'::text AS domain,
      m.booking_id AS business_id, b.booking_number AS business_code, m.kind,
      CASE WHEN b.id IS NULL THEN 'staged' ELSE 'bound' END AS source_state,
      COALESCE(b.fulfillment_status, b.status) AS business_status,
      m.mime_type, m.size_bytes, m.created_at, m.expires_at, NULL::text AS delete_after,
      NULL::text AS withdrawn_at, '年检预约资料核验'::text AS purpose,
      NULL::text AS authorization_version,
      m.storage_key IS NOT NULL AS storage_present
    FROM booking_media m
    LEFT JOIN bookings b ON b.id = m.booking_id AND b.user_id = m.user_id
    UNION ALL
    SELECT l.user_id, m.id, 'insurance', l.id, l.lead_code, m.kind,
      CASE WHEN m.deleted_at IS NULL THEN 'bound' ELSE 'deleted' END,
      l.status, m.mime_type, m.size_bytes, m.created_at, NULL, m.delete_after,
      l.withdrawn_at, '保险续保需求对接', l.disclosure_version,
      m.storage_key IS NOT NULL AND m.deleted_at IS NULL
    FROM service_lead_media m
    JOIN service_leads l ON l.id = m.lead_id
    UNION ALL
    SELECT COALESCE(c.user_id, m.user_id), m.id, 'subsidy_consultation', c.id,
      c.consultation_code, m.kind, m.state, c.status, m.mime_type, m.size_bytes, m.created_at,
      m.staged_expires_at, m.delete_after, c.withdrawn_at,
      '政策与资料咨询', c.disclosure_version,
      m.storage_key IS NOT NULL AND m.deleted_at IS NULL
        AND c.pii_purged_at IS NULL
        AND (m.state <> 'bound' OR m.user_id = c.user_id)
    FROM subsidy_consultation_materials m
    LEFT JOIN subsidy_consultations c ON c.id = m.consultation_id
    WHERE COALESCE(c.user_id, m.user_id) IS NOT NULL
      AND (m.state <> 'bound' OR m.user_id = c.user_id)
    UNION ALL
    SELECT b.user_id, m.id, 'vehicle_checkup', r.id, r.report_no, m.kind,
      m.status, r.status, m.mime_type, m.size_bytes, m.created_at, m.expires_at, r.retain_until,
      NULL, '检测站车辆状况记录', NULL,
      m.storage_key IS NOT NULL AND m.status = 'bound' AND r.status = 'published'
    FROM vehicle_checkup_media m
    JOIN vehicle_checkup_reports r ON r.id = m.report_id AND r.booking_id = m.booking_id
    JOIN bookings b ON b.id = r.booking_id
    JOIN vehicles v ON v.id = b.vehicle_id AND v.user_id = b.user_id
    UNION ALL
    SELECT r.user_id, m.id, 'repair', r.id, r.request_no, m.kind,
      'bound', r.status, m.mime_type, m.size_bytes, m.created_at, sm.expires_at, p.retain_until,
      NULL, '维修报价范围确认', NULL,
      m.storage_key IS NOT NULL AND sm.status = 'bound' AND p.status = 'published'
    FROM repair_request_media m
    JOIN repair_requests r ON r.id = m.request_id
    JOIN vehicle_checkup_media sm ON sm.id = m.source_media_id
      AND sm.storage_key = m.storage_key AND sm.sha256 = m.sha256
    JOIN vehicle_checkup_reports p ON p.id = r.source_report_id
      AND p.id = sm.report_id AND p.booking_id = r.source_booking_id
      AND p.booking_id = sm.booking_id
    JOIN bookings b ON b.id = r.source_booking_id
      AND b.id = p.booking_id AND b.user_id = r.user_id
      AND b.vehicle_id = r.source_vehicle_id
    JOIN vehicles v ON v.id = r.source_vehicle_id AND v.user_id = r.user_id
  ),
  customer_material_view AS (
    SELECT *, CASE
      WHEN source_state = 'deleted' THEN 'deleted'
      WHEN (expires_at IS NOT NULL AND expires_at::timestamptz <= CURRENT_TIMESTAMP)
        OR (delete_after IS NOT NULL AND delete_after::timestamptz <= CURRENT_TIMESTAMP)
        THEN 'expired'
      WHEN business_status = 'withdrawn' THEN 'withdrawn'
      WHEN business_status = 'expired' THEN 'expired'
      WHEN business_status IN ('completed','cancelled','no_show','closed','handled','published','paid')
        THEN 'retained'
      ELSE 'active'
    END AS state
    FROM customer_materials
  )
`;

export async function migrateCustomerCenterDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS customer_admin_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      content TEXT NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 1000),
      actor_account_id TEXT,
      actor_display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS customer_admin_notes_user_created_index
      ON customer_admin_notes(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS customer_admin_tags (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      tag TEXT NOT NULL CHECK (tag IN ('重点客户','待跟进','复购客户','资料待补')),
      actor_account_id TEXT,
      actor_display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, tag)
    );

    CREATE INDEX IF NOT EXISTS customer_admin_tags_tag_user_index
      ON customer_admin_tags(tag, user_id);

    CREATE OR REPLACE FUNCTION reject_customer_admin_note_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'customer_admin_notes is append-only';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS customer_admin_notes_immutable ON customer_admin_notes;
    CREATE TRIGGER customer_admin_notes_immutable
      BEFORE UPDATE OR DELETE ON customer_admin_notes
      FOR EACH ROW EXECUTE FUNCTION reject_customer_admin_note_mutation();

    DROP TRIGGER IF EXISTS customer_admin_notes_no_truncate ON customer_admin_notes;
    CREATE TRIGGER customer_admin_notes_no_truncate
      BEFORE TRUNCATE ON customer_admin_notes
      FOR EACH STATEMENT EXECUTE FUNCTION reject_customer_admin_note_mutation();

    CREATE INDEX IF NOT EXISTS service_leads_user_submitted_index
      ON service_leads(user_id, submitted_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS subsidy_consultations_user_submitted_index
      ON subsidy_consultations(user_id, submitted_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS driving_school_inquiries_user_submitted_index
      ON driving_school_inquiries(user_id, submitted_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS booking_media_user_created_index
      ON booking_media(user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS subsidy_materials_owner_created_index
      ON subsidy_consultation_materials(user_id, created_at DESC, id DESC)
      WHERE user_id IS NOT NULL;
  `);

  // These historical columns were introduced without hard foreign keys. Abort
  // visibly on legacy orphans instead of deleting snapshots or silently adding
  // constraints that cannot be trusted.
  await database.execute(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM bookings b
        LEFT JOIN quote_snapshots q ON q.id = b.quote_snapshot_id
        WHERE b.quote_snapshot_id IS NOT NULL
          AND (
            q.id IS NULL
            OR q.user_id IS DISTINCT FROM b.user_id
            OR q.vehicle_id IS DISTINCT FROM b.vehicle_id
            OR q.station_id IS DISTINCT FROM b.station_id
          )
      ) THEN
        RAISE EXCEPTION 'customer-center migration blocked: inconsistent booking quote snapshot ownership chain';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'bookings_quote_snapshot_restrict_fk'
          AND conrelid = 'bookings'::regclass
      ) THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_quote_snapshot_restrict_fk
          FOREIGN KEY (quote_snapshot_id) REFERENCES quote_snapshots(id) ON DELETE RESTRICT;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM vehicle_checkup_media m
        LEFT JOIN vehicle_checkup_reports p ON p.id = m.report_id
        LEFT JOIN bookings b ON b.id = p.booking_id
        LEFT JOIN vehicles v ON v.id = b.vehicle_id
        WHERE p.id IS NULL OR b.id IS NULL OR v.id IS NULL
          OR m.booking_id IS DISTINCT FROM p.booking_id
          OR v.user_id IS DISTINCT FROM b.user_id
      ) THEN
        RAISE EXCEPTION 'customer-center migration blocked: inconsistent vehicle checkup media ownership chain';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vehicle_checkup_reports_id_booking_unique'
          AND conrelid = 'vehicle_checkup_reports'::regclass
      ) THEN
        ALTER TABLE vehicle_checkup_reports
          ADD CONSTRAINT vehicle_checkup_reports_id_booking_unique UNIQUE (id, booking_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vehicle_checkup_media_report_booking_fk'
          AND conrelid = 'vehicle_checkup_media'::regclass
      ) THEN
        ALTER TABLE vehicle_checkup_media
          ADD CONSTRAINT vehicle_checkup_media_report_booking_fk
          FOREIGN KEY (report_id, booking_id)
          REFERENCES vehicle_checkup_reports(id, booking_id) ON DELETE CASCADE;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM subsidy_consultation_materials m
        LEFT JOIN subsidy_consultations c ON c.id = m.consultation_id
        WHERE m.state = 'bound'
          AND (c.id IS NULL OR m.user_id IS NULL OR m.user_id IS DISTINCT FROM c.user_id)
      ) THEN
        RAISE EXCEPTION 'customer-center migration blocked: inconsistent subsidy material ownership chain';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'subsidy_consultations_id_user_unique'
          AND conrelid = 'subsidy_consultations'::regclass
      ) THEN
        ALTER TABLE subsidy_consultations
          ADD CONSTRAINT subsidy_consultations_id_user_unique UNIQUE (id, user_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'subsidy_material_consultation_owner_fk'
          AND conrelid = 'subsidy_consultation_materials'::regclass
      ) THEN
        ALTER TABLE subsidy_consultation_materials
          ADD CONSTRAINT subsidy_material_consultation_owner_fk
          FOREIGN KEY (consultation_id, user_id)
          REFERENCES subsidy_consultations(id, user_id) ON DELETE CASCADE;
      END IF;

      IF EXISTS (
        SELECT 1 FROM repair_requests r
        LEFT JOIN vehicle_checkup_reports p ON p.id = r.source_report_id
        LEFT JOIN bookings b ON b.id = r.source_booking_id
        LEFT JOIN vehicles v ON v.id = r.source_vehicle_id
        WHERE p.id IS NULL OR b.id IS NULL OR v.id IS NULL
          OR p.booking_id IS DISTINCT FROM r.source_booking_id
          OR b.vehicle_id IS DISTINCT FROM r.source_vehicle_id
          OR b.user_id IS DISTINCT FROM r.user_id
          OR v.user_id IS DISTINCT FROM r.user_id
      ) THEN
        RAISE EXCEPTION 'customer-center migration blocked: inconsistent repair source ownership chain';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM repair_request_faults f
        LEFT JOIN repair_requests r ON r.id = f.request_id
        LEFT JOIN vehicle_checkup_faults sf ON sf.id = f.source_fault_id
        WHERE r.id IS NULL OR sf.id IS NULL
          OR sf.report_id IS DISTINCT FROM r.source_report_id
      ) THEN
        RAISE EXCEPTION 'customer-center migration blocked: inconsistent repair fault source';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM repair_request_media m
        LEFT JOIN repair_requests r ON r.id = m.request_id
        LEFT JOIN vehicle_checkup_media sm ON sm.id = m.source_media_id
        LEFT JOIN vehicle_checkup_reports p ON p.id = r.source_report_id
        LEFT JOIN bookings b ON b.id = r.source_booking_id
        LEFT JOIN vehicles v ON v.id = r.source_vehicle_id
        LEFT JOIN repair_request_faults f ON f.request_id = m.request_id AND f.id = m.fault_id
        WHERE r.id IS NULL OR sm.id IS NULL OR p.id IS NULL OR b.id IS NULL OR v.id IS NULL
          OR sm.report_id IS DISTINCT FROM r.source_report_id
          OR sm.booking_id IS DISTINCT FROM r.source_booking_id
          OR p.booking_id IS DISTINCT FROM r.source_booking_id
          OR b.vehicle_id IS DISTINCT FROM r.source_vehicle_id
          OR b.user_id IS DISTINCT FROM r.user_id
          OR v.user_id IS DISTINCT FROM r.user_id
          OR sm.storage_key IS DISTINCT FROM m.storage_key
          OR sm.sha256 IS DISTINCT FROM m.sha256
          OR sm.kind IS DISTINCT FROM m.kind
          OR sm.sequence_no IS DISTINCT FROM m.sequence_no
          OR (m.fault_id IS NULL) IS DISTINCT FROM (sm.fault_id IS NULL)
          OR (m.fault_id IS NOT NULL AND (f.id IS NULL OR f.source_fault_id IS DISTINCT FROM sm.fault_id))
      ) THEN
        RAISE EXCEPTION 'customer-center migration blocked: inconsistent repair media source';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vehicles_id_user_unique' AND conrelid = 'vehicles'::regclass
      ) THEN
        ALTER TABLE vehicles ADD CONSTRAINT vehicles_id_user_unique UNIQUE (id, user_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'bookings_id_vehicle_user_unique' AND conrelid = 'bookings'::regclass
      ) THEN
        ALTER TABLE bookings
          ADD CONSTRAINT bookings_id_vehicle_user_unique UNIQUE (id, vehicle_id, user_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_requests_source_report_restrict_fk'
          AND conrelid = 'repair_requests'::regclass
      ) THEN
        ALTER TABLE repair_requests ADD CONSTRAINT repair_requests_source_report_restrict_fk
          FOREIGN KEY (source_report_id) REFERENCES vehicle_checkup_reports(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_requests_source_booking_restrict_fk'
          AND conrelid = 'repair_requests'::regclass
      ) THEN
        ALTER TABLE repair_requests ADD CONSTRAINT repair_requests_source_booking_restrict_fk
          FOREIGN KEY (source_booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_requests_source_vehicle_restrict_fk'
          AND conrelid = 'repair_requests'::regclass
      ) THEN
        ALTER TABLE repair_requests ADD CONSTRAINT repair_requests_source_vehicle_restrict_fk
          FOREIGN KEY (source_vehicle_id) REFERENCES vehicles(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_requests_report_booking_restrict_fk'
          AND conrelid = 'repair_requests'::regclass
      ) THEN
        ALTER TABLE repair_requests ADD CONSTRAINT repair_requests_report_booking_restrict_fk
          FOREIGN KEY (source_report_id, source_booking_id)
          REFERENCES vehicle_checkup_reports(id, booking_id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_requests_booking_vehicle_user_restrict_fk'
          AND conrelid = 'repair_requests'::regclass
      ) THEN
        ALTER TABLE repair_requests ADD CONSTRAINT repair_requests_booking_vehicle_user_restrict_fk
          FOREIGN KEY (source_booking_id, source_vehicle_id, user_id)
          REFERENCES bookings(id, vehicle_id, user_id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_requests_vehicle_user_restrict_fk'
          AND conrelid = 'repair_requests'::regclass
      ) THEN
        ALTER TABLE repair_requests ADD CONSTRAINT repair_requests_vehicle_user_restrict_fk
          FOREIGN KEY (source_vehicle_id, user_id)
          REFERENCES vehicles(id, user_id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_request_faults_source_fault_restrict_fk'
          AND conrelid = 'repair_request_faults'::regclass
      ) THEN
        ALTER TABLE repair_request_faults ADD CONSTRAINT repair_request_faults_source_fault_restrict_fk
          FOREIGN KEY (source_fault_id) REFERENCES vehicle_checkup_faults(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repair_request_media_source_media_restrict_fk'
          AND conrelid = 'repair_request_media'::regclass
      ) THEN
        ALTER TABLE repair_request_media ADD CONSTRAINT repair_request_media_source_media_restrict_fk
          FOREIGN KEY (source_media_id) REFERENCES vehicle_checkup_media(id) ON DELETE RESTRICT;
      END IF;
    END;
    $$;
  `);
}

function validationError(error: z.ZodError): BackofficeError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) fields[issue.path.join(".") || "request"] ??= issue.message;
  return new BackofficeError(400, "CUSTOMER_VALIDATION_ERROR", "提交的信息有误，请检查后重试", fields);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

async function principalFor(
  request: FastifyRequest,
  database: AppDatabase,
  capability: BackofficeCapability,
): Promise<BackofficeSession> {
  const principal = await requireBackoffice(request, database, {
    allowTestFallback: backofficeTestFallbackEnabled(),
  });
  return assertCapability(principal, capability);
}

async function requireCustomer(database: AppDatabase, userId: string): Promise<Row> {
  const row = await database.prepare<Row>(`
    SELECT id, customer_number, display_name, avatar_url, status, data_kind,
      created_at, updated_at
    FROM users WHERE id = ? LIMIT 1
  `).get(userId);
  if (!row) throw new BackofficeError(404, "CUSTOMER_NOT_FOUND", "未找到该客户");
  return row;
}

function maskSubject(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length <= 6 ? `••••${text.slice(-2)}` : `••••••${text.slice(-6)}`;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sortCustomerTags(values: readonly string[]): string[] {
  return [...values].sort((left, right) => CUSTOMER_TAGS.indexOf(left as typeof CUSTOMER_TAGS[number])
    - CUSTOMER_TAGS.indexOf(right as typeof CUSTOMER_TAGS[number]));
}

type Cursor = { at: string; id: string; domain?: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | undefined, options: { requireDomain?: boolean } = {}): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.at !== "string" || !parsed.at || typeof parsed.id !== "string" || !parsed.id) throw new Error();
    if (options.requireDomain && (typeof parsed.domain !== "string" || !parsed.domain)) throw new Error();
    if (Number.isNaN(new Date(parsed.at).getTime())) throw new Error();
    return { at: parsed.at, id: parsed.id, domain: parsed.domain };
  } catch {
    throw new BackofficeError(400, "CUSTOMER_CURSOR_INVALID", "分页游标无效");
  }
}

function detailPath(domain: CustomerDomain, id: string): string | null {
  const encoded = encodeURIComponent(id);
  switch (domain) {
    case "annual_inspection": return `/bookings?booking=${encoded}`;
    case "car_wash": return `/wash/orders?order=${encoded}`;
    case "car_rental": return `/car-rental?tab=orders&order=${encoded}`;
    case "insurance": return `/insurance?lead=${encoded}`;
    case "driving_school": return `/driving-schools?inquiry=${encoded}`;
    case "subsidy_consultation": return `/subsidy-consultation?consultation=${encoded}`;
    case "repair": return null;
  }
}

function recordDto(row: Row) {
  const domain = String(row.domain) as CustomerDomain;
  const sourceId = String(row.source_id);
  return {
    domain,
    recordType: String(row.record_type),
    sourceId,
    businessCode: row.business_code == null ? null : String(row.business_code),
    vehicleId: row.vehicle_id == null ? null : String(row.vehicle_id),
    status: String(row.status),
    amountFen: row.amount_fen == null ? null : Number(row.amount_fen),
    occurredAt: iso(row.occurred_at),
    detailPath: detailPath(domain, sourceId),
    title: String(row.title),
  };
}

function materialLabel(kind: string): string {
  const labels: Record<string, string> = {
    license_front: "行驶证主页",
    license_back: "行驶证副页",
    license_photo: "行驶证主页",
    id_card_front: "身份证人像面",
    id_card_back: "身份证国徽面",
    driving_license_front: "行驶证主页",
    driving_license_back: "行驶证副页",
    vehicle_front_left: "车辆左前方",
    vehicle_front_right: "车辆右前方",
    vehicle_rear_left: "车辆左后方",
    vehicle_rear_right: "车辆右后方",
    front_left: "车辆左前方",
    front_right: "车辆右前方",
    rear_left: "车辆左后方",
    rear_right: "车辆右后方",
    dashboard_started: "启动后仪表盘",
    safety_inspection_report: "机动车安全技术检验报告",
    emissions_inspection_report: "排放检验报告",
    annual_inspection_mark: "检验合格标志/电子凭证留证",
    fault_closeup: "故障近照",
  };
  return labels[kind] ?? kind;
}

function materialAvailable(row: Row, now = Date.now()): boolean {
  if (!Boolean(row.storage_present) || String(row.source_state) !== "bound") return false;
  if (!["active", "retained"].includes(String(row.state))) return false;
  if (row.business_id == null) return false;
  const expiresAt = row.expires_at == null ? null : Date.parse(String(row.expires_at));
  const deleteAfter = row.delete_after == null ? null : Date.parse(String(row.delete_after));
  return !(expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= now)
    && !(deleteAfter != null && Number.isFinite(deleteAfter) && deleteAfter <= now);
}

function materialDto(row: Row) {
  const domain = String(row.domain) as MaterialDomain;
  const id = String(row.id);
  const available = materialAvailable(row);
  return {
    id,
    domain,
    businessId: row.business_id == null ? null : String(row.business_id),
    businessCode: row.business_code == null ? null : String(row.business_code),
    kind: String(row.kind),
    label: materialLabel(String(row.kind)),
    state: String(row.state),
    sourceState: String(row.source_state),
    purpose: row.purpose == null ? null : String(row.purpose),
    authorizationVersion: row.authorization_version == null ? null : String(row.authorization_version),
    retentionPolicy: row.delete_after == null && row.expires_at == null
      ? null
      : "按对应业务授权与留存期限管理",
    retention: row.delete_after == null && row.expires_at == null
      ? null
      : "按对应业务授权与留存期限管理",
    retentionUntil: iso(row.delete_after ?? row.expires_at),
    withdrawnAt: iso(row.withdrawn_at),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    deleteAfter: iso(row.delete_after),
    available,
    contentPath: available
      ? `/api/admin/customers/${encodeURIComponent(String(row.user_id))}/materials/${domain}/${encodeURIComponent(id)}/content`
      : null,
  };
}

function customerAuditLabel(action: unknown): string {
  const value = String(action);
  const labels: Record<string, string> = {
    "customer.note.add": "添加客户备注",
    "customer.tags.update": "更新客户标签",
    "customer.identity.reveal": "查看完整身份标识",
    "customer.material.read": "查看客户资料",
    "backoffice.authorization.denied": "访问被拒绝",
  };
  return labels[value] ?? "后台操作";
}

async function listRecords(
  database: AppDatabase,
  userId: string,
  options: { domain?: CustomerDomain; cursor?: string; limit: number },
) {
  const cursor = decodeCursor(options.cursor, { requireDomain: true });
  const conditions = ["user_id = ?"];
  const parameters: DatabaseValue[] = [userId];
  if (options.domain) {
    conditions.push("domain = ?");
    parameters.push(options.domain);
  }
  if (cursor) {
    conditions.push("(occurred_at::timestamptz, domain, source_id) < (?::timestamptz, ?, ?)");
    parameters.push(cursor.at, cursor.domain!, cursor.id);
  }
  const rows = await database.prepare<Row>(`
    WITH ${RECORD_DETAILS_CTE}
    SELECT * FROM customer_records
    WHERE ${conditions.join(" AND ")}
    ORDER BY occurred_at::timestamptz DESC, domain DESC, source_id DESC
    LIMIT ?
  `).all(...parameters, options.limit + 1);
  const hasMore = rows.length > options.limit;
  const items = rows.slice(0, options.limit);
  const tail = items.at(-1);
  return {
    items: items.map(recordDto),
    nextCursor: hasMore && tail
      ? encodeCursor({ at: iso(tail.occurred_at)!, domain: String(tail.domain), id: String(tail.source_id) })
      : null,
  };
}

async function listMaterials(
  database: AppDatabase,
  userId: string,
  options: { domain?: MaterialDomain; state?: string; cursor?: string; limit: number },
) {
  const cursor = decodeCursor(options.cursor, { requireDomain: true });
  const conditions = ["user_id = ?"];
  const parameters: DatabaseValue[] = [userId];
  if (options.domain) {
    conditions.push("domain = ?");
    parameters.push(options.domain);
  }
  if (options.state) {
    conditions.push("state = ?");
    parameters.push(options.state);
  }
  if (cursor) {
    conditions.push("(created_at::timestamptz, domain, id) < (?::timestamptz, ?, ?)");
    parameters.push(cursor.at, cursor.domain!, cursor.id);
  }
  const rows = await database.prepare<Row>(`
    WITH ${MATERIALS_CTE}
    SELECT * FROM customer_material_view
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at::timestamptz DESC, domain DESC, id DESC
    LIMIT ?
  `).all(...parameters, options.limit + 1);
  const hasMore = rows.length > options.limit;
  const items = rows.slice(0, options.limit);
  const tail = items.at(-1);
  return {
    items: items.map(materialDto),
    nextCursor: hasMore && tail
      ? encodeCursor({ at: iso(tail.created_at)!, domain: String(tail.domain), id: String(tail.id) })
      : null,
  };
}

async function listCustomers(database: AppDatabase, query: z.infer<typeof customerListQuerySchema>) {
  const cursor = decodeCursor(query.cursor);
  const conditions: string[] = [];
  const parameters: DatabaseValue[] = [];
  if (query.status) {
    conditions.push("status = ?");
    parameters.push(query.status);
  }
  if (query.dataKind) {
    conditions.push("data_kind = ?");
    parameters.push(query.dataKind);
  }
  if (query.tag) {
    conditions.push("EXISTS (SELECT 1 FROM customer_admin_tags t WHERE t.user_id = base.id AND t.tag = ?)");
    parameters.push(query.tag);
  }
  if (query.serviceType) {
    conditions.push("EXISTS (SELECT 1 FROM customer_record_events e WHERE e.user_id = base.id AND e.domain = ?)");
    parameters.push(query.serviceType);
  }
  if (query.activeWithinDays) {
    conditions.push("last_active_at >= ?::timestamptz");
    parameters.push(new Date(Date.now() - query.activeWithinDays * 86_400_000).toISOString());
  }
  if (query.q) {
    const pattern = `%${query.q.toLocaleLowerCase("zh-CN")}%`;
    const plate = `%${query.q.replace(/[·.\s-]/gu, "").toLocaleUpperCase("zh-CN")}%`;
    conditions.push(`(
      lower(customer_number) LIKE ? OR lower(COALESCE(display_name, '')) LIKE ?
      OR EXISTS (
        SELECT 1 FROM vehicles v WHERE v.user_id = base.id
          AND upper(regexp_replace(v.plate_normalized, '[·.\\s-]', '', 'g')) LIKE ?
      )
      OR EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = base.id AND lower(b.booking_number) LIKE ?)
      OR EXISTS (SELECT 1 FROM wash_orders o WHERE o.user_id = base.id AND lower(o.order_number) LIKE ?)
      OR EXISTS (SELECT 1 FROM car_rental_orders o WHERE o.user_id = base.id AND lower(o.order_number) LIKE ?)
      OR EXISTS (SELECT 1 FROM service_leads l WHERE l.user_id = base.id AND lower(l.lead_code) LIKE ?)
      OR EXISTS (SELECT 1 FROM driving_school_inquiries i WHERE i.user_id = base.id AND lower(i.inquiry_code) LIKE ?)
      OR EXISTS (SELECT 1 FROM subsidy_consultations c WHERE c.user_id = base.id AND lower(c.consultation_code) LIKE ?)
      OR EXISTS (SELECT 1 FROM repair_requests r WHERE r.user_id = base.id AND lower(r.request_no) LIKE ?)
    )`);
    parameters.push(pattern, pattern, plate, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (cursor) {
    conditions.push("(last_active_at, id) < (?::timestamptz, ?)");
    parameters.push(cursor.at, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await database.prepare<Row>(`
    WITH ${RECORD_EVENTS_CTE},
    record_stats AS (
      SELECT user_id, COUNT(*)::integer AS record_count,
        COALESCE(SUM(is_pending), 0)::integer AS pending_count,
        MAX(occurred_at::timestamptz) AS last_record_at
      FROM customer_record_events GROUP BY user_id
    ),
    vehicle_stats AS (
      SELECT user_id, COUNT(*)::integer AS vehicle_count
      FROM vehicles GROUP BY user_id
    ),
    session_stats AS (
      SELECT user_id, MAX(COALESCE(last_seen_at, created_at)::timestamptz) AS last_session_at
      FROM user_sessions
      GROUP BY user_id
    ),
    base AS (
      SELECT u.*, COALESCE(v.vehicle_count, 0) AS vehicle_count,
        COALESCE(r.record_count, 0) AS record_count,
        COALESCE(r.pending_count, 0) AS pending_count,
        GREATEST(
          u.updated_at::timestamptz,
          COALESCE(r.last_record_at, u.created_at::timestamptz),
          COALESCE(s.last_session_at, u.created_at::timestamptz)
        ) AS last_active_at,
        identity.provider AS identity_provider,
        identity.provider_subject AS identity_subject,
        COALESCE(tags.tags, ARRAY[]::text[]) AS tags
      FROM users u
      LEFT JOIN record_stats r ON r.user_id = u.id
      LEFT JOIN vehicle_stats v ON v.user_id = u.id
      LEFT JOIN session_stats s ON s.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT i.provider, i.provider_subject
        FROM user_identities i WHERE i.user_id = u.id AND i.provider = 'wechat'
        ORDER BY i.created_at DESC
        LIMIT 1
      ) identity ON TRUE
      LEFT JOIN LATERAL (
        SELECT array_agg(t.tag ORDER BY CASE t.tag
          WHEN '重点客户' THEN 1 WHEN '待跟进' THEN 2
          WHEN '复购客户' THEN 3 WHEN '资料待补' THEN 4 ELSE 99 END) AS tags
        FROM customer_admin_tags t WHERE t.user_id = u.id
      ) tags ON TRUE
    )
    SELECT * FROM base ${where}
    ORDER BY last_active_at DESC, id DESC
    LIMIT ?
  `).all(...parameters, query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const tail = page.at(-1);

  const summary = await database.prepare<Row>(`
    WITH ${RECORD_EVENTS_CTE}
    SELECT
      COUNT(*) FILTER (WHERE u.data_kind = 'real')::integer AS real,
      COUNT(*) FILTER (WHERE u.data_kind = 'demo')::integer AS demo,
      COUNT(*) FILTER (WHERE u.data_kind = 'unknown')::integer AS unknown,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = 'wechat'
      ))::integer AS wechat_bound,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM customer_record_events e WHERE e.user_id = u.id
      ))::integer AS with_business_records
    FROM users u
  `).get();

  return {
    items: page.map((row) => ({
      id: String(row.id),
      customerNumber: String(row.customer_number),
      displayName: row.display_name == null ? null : String(row.display_name),
      avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
      status: String(row.status),
      dataKind: String(row.data_kind),
      identity: {
        bound: row.identity_provider != null,
        provider: row.identity_provider == null ? null : String(row.identity_provider),
        maskedSubject: maskSubject(row.identity_subject),
      },
      tags: strings(row.tags),
      vehicleCount: Number(row.vehicle_count),
      recordCount: Number(row.record_count),
      pendingCount: Number(row.pending_count),
      lastActiveAt: iso(row.last_active_at),
      createdAt: iso(row.created_at),
    })),
    summary: {
      real: Number(summary?.real ?? 0),
      demo: Number(summary?.demo ?? 0),
      unknown: Number(summary?.unknown ?? 0),
      wechatBound: Number(summary?.wechat_bound ?? 0),
      withBusinessRecords: Number(summary?.with_business_records ?? 0),
    },
    nextCursor: hasMore && tail
      ? encodeCursor({ at: iso(tail.last_active_at)!, id: String(tail.id) })
      : null,
  };
}

async function customerDetail(database: AppDatabase, userId: string) {
  const customer = await requireCustomer(database, userId);
  const [identities, tags, notes, vehicles, records, vehicleLastServices, recordStats, materialCount, audits] = await Promise.all([
    database.prepare<Row>(`
      SELECT id, provider, provider_app_id, provider_subject, union_subject, created_at
      FROM user_identities WHERE user_id = ? AND provider = 'wechat'
      ORDER BY created_at DESC
    `).all(userId),
    database.prepare<Row>(`SELECT tag FROM customer_admin_tags WHERE user_id = ? ORDER BY CASE tag
      WHEN '重点客户' THEN 1 WHEN '待跟进' THEN 2
      WHEN '复购客户' THEN 3 WHEN '资料待补' THEN 4 ELSE 99 END`).all(userId),
    database.prepare<Row>(`
      SELECT id, content, actor_account_id, actor_display_name, created_at
      FROM customer_admin_notes WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(userId),
    database.prepare<Row>(`
      SELECT * FROM vehicles WHERE user_id = ? ORDER BY deleted_at NULLS FIRST, is_default DESC, created_at DESC
    `).all(userId),
    listRecords(database, userId, { limit: 20 }),
    database.prepare<Row>(`
      WITH ${RECORD_DETAILS_CTE}
      SELECT DISTINCT ON (vehicle_id) * FROM customer_records
      WHERE user_id = ? AND vehicle_id IS NOT NULL
      ORDER BY vehicle_id, occurred_at::timestamptz DESC, source_id DESC
    `).all(userId),
    database.prepare<Row>(`
      WITH ${RECORD_EVENTS_CTE}
      SELECT COUNT(*)::integer AS count, COALESCE(SUM(is_pending), 0)::integer AS pending
      FROM customer_record_events WHERE user_id = ?
    `).get(userId),
    database.prepare<Row>(`WITH ${MATERIALS_CTE} SELECT COUNT(*)::integer AS count FROM customer_materials WHERE user_id = ?`).get(userId),
    database.prepare<Row>(`
      SELECT id, action, outcome, actor_display_name, resource_type, resource_id,
        metadata_json, occurred_at
      FROM backoffice_audit_events
      WHERE (resource_type = 'customer' AND resource_id = ?)
        OR metadata_json->>'customerId' = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 30
    `).all(userId, userId),
  ]);

  const recentByVehicle = new Map<string, ReturnType<typeof recordDto>>();
  for (const row of vehicleLastServices) {
    const record = recordDto(row);
    if (record.vehicleId && !recentByVehicle.has(record.vehicleId)) recentByVehicle.set(record.vehicleId, record);
  }
  const preferredIdentity = identities[0];

  const auditActivity = audits.map((row) => ({
    id: String(row.id),
    type: "admin_audit",
    label: customerAuditLabel(row.action),
    description: row.resource_type == null ? "后台操作" : String(row.resource_type),
    occurredAt: iso(row.occurred_at),
    actorName: row.actor_display_name == null ? null : String(row.actor_display_name),
    domain: "customer",
    resourceId: row.resource_id == null ? null : String(row.resource_id),
    outcome: String(row.outcome),
  }));
  const recentActivity = [...auditActivity]
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))
    .slice(0, 30);

  return {
    customer: {
      id: String(customer.id),
      customerNumber: String(customer.customer_number),
      displayName: customer.display_name == null ? null : String(customer.display_name),
      avatarUrl: customer.avatar_url == null ? null : String(customer.avatar_url),
      status: String(customer.status),
      dataKind: String(customer.data_kind),
      identity: {
        bound: Boolean(preferredIdentity),
        provider: preferredIdentity == null ? null : String(preferredIdentity.provider),
        maskedSubject: preferredIdentity == null ? null : maskSubject(preferredIdentity.provider_subject),
      },
      createdAt: iso(customer.created_at),
      updatedAt: iso(customer.updated_at),
    },
    identities: identities.map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      providerAppId: String(row.provider_app_id),
      maskedProviderSubject: maskSubject(row.provider_subject),
      maskedUnionSubject: maskSubject(row.union_subject),
      boundAt: iso(row.created_at),
    })),
    tags: tags.map((row) => String(row.tag)),
    notes: notes.map((row) => ({
      id: String(row.id),
      content: String(row.content),
      author: {
        id: row.actor_account_id == null ? null : String(row.actor_account_id),
        displayName: String(row.actor_display_name),
      },
      createdAt: iso(row.created_at),
    })),
    stats: {
      vehicles: vehicles.length,
      records: Number(recordStats?.count ?? 0),
      pending: Number(recordStats?.pending ?? 0),
      materials: Number(materialCount?.count ?? 0),
    },
    vehicles: vehicles.map((row) => ({
      id: String(row.id),
      plateNumber: String(row.plate_number),
      plateNormalized: String(row.plate_normalized),
      brand: row.brand_name == null ? null : String(row.brand_name),
      model: row.model_name == null ? null : String(row.model_name),
      brandName: row.brand_name == null ? null : String(row.brand_name),
      modelName: row.model_name == null ? null : String(row.model_name),
      vehicleType: String(row.vehicle_type),
      usageNature: String(row.usage_nature),
      seats: Number(row.seats),
      registrationDate: String(row.registration_date),
      inspectionDueDate: String(row.inspection_due_date),
      inspectionValidUntil: String(row.inspection_due_date),
      inspectionDueDateSource: row.inspection_due_date_source == null ? null : String(row.inspection_due_date_source),
      isDefault: Number(row.is_default) === 1,
      deletedAt: iso(row.deleted_at),
      isDeleted: row.deleted_at != null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      recentService: recentByVehicle.get(String(row.id)) ?? null,
      lastServiceAt: recentByVehicle.get(String(row.id))?.occurredAt ?? null,
    })),
    recentRecords: records.items,
    recentActivity,
    audits: recentActivity,
  };
}

async function readOwnedMaterial(
  database: AppDatabase,
  options: {
    userId: string;
    domain: MaterialDomain;
    materialId: string;
    uploadDir: string;
    insuranceUploadDir: string;
    subsidyConsultationUploadDir: string;
    actor: string;
  },
): Promise<{ data: Buffer; mimeType: string }> {
  const now = new Date().toISOString();
  let row: Row | undefined;
  let filename: string;
  switch (options.domain) {
    case "annual_inspection":
      row = await database.prepare<Row>(`
        SELECT m.storage_key, m.mime_type
        FROM booking_media m
        JOIN bookings b ON b.id = m.booking_id AND b.user_id = m.user_id
        WHERE m.id = ? AND b.user_id = ? AND m.expires_at > ?
      `).get(options.materialId, options.userId, now);
      if (!row) break;
      filename = join(options.uploadDir, String(row.storage_key));
      return { data: await safeRead(filename), mimeType: String(row.mime_type) };
    case "insurance":
      row = await database.prepare<Row>(`
        SELECT m.storage_key, m.mime_type
        FROM service_lead_media m JOIN service_leads l ON l.id = m.lead_id
        WHERE m.id = ? AND l.user_id = ? AND l.status <> 'withdrawn'
          AND m.deleted_at IS NULL AND m.delete_after > ?
      `).get(options.materialId, options.userId, now);
      if (!row) break;
      filename = join(options.insuranceUploadDir, String(row.storage_key));
      return { data: await safeRead(filename), mimeType: String(row.mime_type) };
    case "subsidy_consultation": {
      row = await database.prepare<Row>(`
        SELECT m.consultation_id
        FROM subsidy_consultation_materials m
        JOIN subsidy_consultations c ON c.id = m.consultation_id
        WHERE m.id = ? AND c.user_id = ? AND m.user_id = c.user_id AND m.state = 'bound'
          AND c.status NOT IN ('withdrawn', 'expired') AND c.pii_purged_at IS NULL
          AND m.deleted_at IS NULL AND m.storage_key IS NOT NULL
          AND (m.delete_after IS NULL OR m.delete_after > ?)
      `).get(options.materialId, options.userId, now);
      if (!row?.consultation_id) break;
      const material = await readAdminSubsidyConsultationMaterial(
        database,
        String(row.consultation_id),
        options.materialId,
        options.subsidyConsultationUploadDir,
        { actor: options.actor },
      );
      return { data: material.data, mimeType: material.mimeType };
    }
    case "driving_school":
      break;
    case "vehicle_checkup":
      row = await database.prepare<Row>(`
        SELECT m.storage_key, m.mime_type
        FROM vehicle_checkup_media m
        JOIN vehicle_checkup_reports p ON p.id = m.report_id AND p.booking_id = m.booking_id
        JOIN bookings b ON b.id = p.booking_id
        JOIN vehicles v ON v.id = b.vehicle_id AND v.user_id = b.user_id
        WHERE m.id = ? AND b.user_id = ? AND p.status = 'published'
          AND m.status = 'bound' AND m.expires_at > ?
          AND (p.retain_until IS NULL OR p.retain_until > ?)
      `).get(options.materialId, options.userId, now, now);
      if (!row) break;
      filename = join(options.uploadDir, "vehicle-checkup", String(row.storage_key));
      return { data: await safeRead(filename), mimeType: String(row.mime_type) };
    case "repair":
      row = await database.prepare<Row>(`
        SELECT m.storage_key, m.mime_type
        FROM repair_request_media m
        JOIN repair_requests r ON r.id = m.request_id
        JOIN vehicle_checkup_media sm ON sm.id = m.source_media_id
          AND sm.storage_key = m.storage_key AND sm.sha256 = m.sha256
        JOIN vehicle_checkup_reports p ON p.id = r.source_report_id
          AND p.id = sm.report_id AND p.booking_id = r.source_booking_id
          AND p.booking_id = sm.booking_id
        JOIN bookings b ON b.id = r.source_booking_id
          AND b.id = p.booking_id AND b.user_id = r.user_id
          AND b.vehicle_id = r.source_vehicle_id
        JOIN vehicles v ON v.id = r.source_vehicle_id AND v.user_id = r.user_id
        WHERE m.id = ? AND r.user_id = ? AND p.status = 'published'
          AND sm.status = 'bound' AND sm.expires_at > ?
          AND (p.retain_until IS NULL OR p.retain_until > ?)
      `).get(options.materialId, options.userId, now, now);
      if (!row) break;
      filename = join(options.uploadDir, "vehicle-checkup", String(row.storage_key));
      return { data: await safeRead(filename), mimeType: String(row.mime_type) };
  }
  throw new BackofficeError(404, "CUSTOMER_MATERIAL_NOT_FOUND", "资料不存在或已按策略清理");
}

async function safeRead(filename: string): Promise<Buffer> {
  try {
    return await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BackofficeError(404, "CUSTOMER_MATERIAL_NOT_FOUND", "资料不存在或已按策略清理");
    }
    throw error;
  }
}

export function registerCustomerCenterRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: {
    uploadDir: string;
    insuranceUploadDir: string;
    subsidyConsultationUploadDir: string;
  },
): void {
  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/customers", async (request) => {
    await principalFor(request, database, "customers.read");
    const query = parse(customerListQuerySchema, request.query);
    return { data: await listCustomers(database, query) };
  });

  app.get<{ Params: { userId: string } }>("/api/admin/customers/:userId", async (request) => {
    await principalFor(request, database, "customers.read");
    return { data: await customerDetail(database, request.params.userId) };
  });

  app.get<{ Params: { userId: string }; Querystring: Record<string, unknown> }>(
    "/api/admin/customers/:userId/records",
    async (request) => {
      await principalFor(request, database, "customers.read");
      await requireCustomer(database, request.params.userId);
      const query = parse(recordsQuerySchema, request.query);
      return { data: await listRecords(database, request.params.userId, query) };
    },
  );

  app.get<{ Params: { userId: string }; Querystring: Record<string, unknown> }>(
    "/api/admin/customers/:userId/materials",
    async (request) => {
      await principalFor(request, database, "customers.read");
      await requireCustomer(database, request.params.userId);
      const query = parse(materialsQuerySchema, request.query);
      return { data: await listMaterials(database, request.params.userId, query) };
    },
  );

  app.get<{ Params: { userId: string; domain: string; materialId: string } }>(
    "/api/admin/customers/:userId/materials/:domain/:materialId/content",
    async (request, reply) => {
      const principal = await principalFor(request, database, "customers.sensitive.read");
      await requireCustomer(database, request.params.userId);
      const parsedDomain = z.enum(MATERIAL_DOMAINS).safeParse(request.params.domain);
      if (!parsedDomain.success) {
        throw new BackofficeError(404, "CUSTOMER_MATERIAL_NOT_FOUND", "资料不存在或已按策略清理");
      }
      const content = await readOwnedMaterial(database, {
        userId: request.params.userId,
        domain: parsedDomain.data,
        materialId: request.params.materialId,
        ...options,
        actor: principal.account.displayName,
      });
      await auditBackofficeEvent(database, {
        request,
        principal,
        action: "customer.material.read",
        outcome: "success",
        resource: { type: "customer_material", id: request.params.materialId },
        metadata: {
          customerId: request.params.userId,
          materialDomain: parsedDomain.data,
          materialId: request.params.materialId,
        },
        presentation: { category: "customer", actionLabel: "查看客户资料", summary: "逐项查看客户资料" },
      });
      reply.header("cache-control", "private, no-store");
      reply.header("content-disposition", "inline");
      reply.type(content.mimeType);
      return reply.send(content.data);
    },
  );

  app.post<{ Params: { userId: string } }>("/api/admin/customers/:userId/notes", async (request, reply) => {
    const principal = await principalFor(request, database, "customers.notes.write");
    await requireCustomer(database, request.params.userId);
    const body = parse(noteSchema, request.body);
    const note = {
      id: randomUUID(),
      content: body.content,
      author: { id: principal.account.id, displayName: principal.account.displayName },
      createdAt: new Date().toISOString(),
    };
    await database.transaction(async (transaction) => {
      await transaction.prepare(`
        INSERT INTO customer_admin_notes (
          id, user_id, content, actor_account_id, actor_display_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?::timestamptz)
      `).run(note.id, request.params.userId, note.content, principal.account.id, principal.account.displayName, note.createdAt);
      await auditBackofficeEvent(transaction, {
        request,
        principal,
        action: "customer.note.add",
        outcome: "success",
        resource: { type: "customer", id: request.params.userId },
        metadata: { customerId: request.params.userId, noteId: note.id, contentLength: note.content.length },
        presentation: { category: "customer", actionLabel: "添加客户备注", summary: "添加一条只读内部备注" },
      });
    });
    return reply.code(201).send({ data: { note } });
  });

  app.put<{ Params: { userId: string } }>("/api/admin/customers/:userId/tags", async (request) => {
    const principal = await principalFor(request, database, "customers.notes.write");
    await requireCustomer(database, request.params.userId);
    const body = parse(tagsSchema, request.body);
    const tags = sortCustomerTags([...new Set(body.tags)]);
    const beforeRows = await database.prepare<Row>(
      "SELECT tag FROM customer_admin_tags WHERE user_id = ? ORDER BY tag",
    ).all(request.params.userId);
    const before = beforeRows.map((row) => String(row.tag));
    await database.transaction(async (transaction) => {
      await transaction.prepare("DELETE FROM customer_admin_tags WHERE user_id = ?").run(request.params.userId);
      const createdAt = new Date().toISOString();
      for (const tag of tags) {
        await transaction.prepare(`
          INSERT INTO customer_admin_tags (
            user_id, tag, actor_account_id, actor_display_name, created_at
          ) VALUES (?, ?, ?, ?, ?::timestamptz)
        `).run(request.params.userId, tag, principal.account.id, principal.account.displayName, createdAt);
      }
      await auditBackofficeEvent(transaction, {
        request,
        principal,
        action: "customer.tags.update",
        outcome: "success",
        resource: { type: "customer", id: request.params.userId },
        before: { tags: before },
        after: { tags },
        metadata: { customerId: request.params.userId },
        presentation: { category: "customer", actionLabel: "更新客户标签", summary: "更新客户内部运营标签" },
      });
    });
    return { data: { tags } };
  });

  app.post<{ Params: { userId: string; identityId: string } }>(
    "/api/admin/customers/:userId/identities/:identityId/reveal",
    async (request, reply) => {
      const principal = await principalFor(request, database, "customers.sensitive.read");
      await requireCustomer(database, request.params.userId);
      const identity = await database.prepare<Row>(`
        SELECT id, provider, provider_app_id, provider_subject, union_subject
        FROM user_identities WHERE id = ? AND user_id = ? AND provider = 'wechat' LIMIT 1
      `).get(request.params.identityId, request.params.userId);
      if (!identity) throw new BackofficeError(404, "CUSTOMER_IDENTITY_NOT_FOUND", "未找到该身份绑定");
      await auditBackofficeEvent(database, {
        request,
        principal,
        action: "customer.identity.reveal",
        outcome: "success",
        resource: { type: "customer_identity", id: request.params.identityId },
        metadata: { customerId: request.params.userId, identityId: request.params.identityId },
        presentation: { category: "customer", actionLabel: "查看完整身份标识", summary: "查看客户微信身份完整标识" },
      });
      reply.header("cache-control", "private, no-store");
      return reply.send({
        data: {
          identity: {
            id: String(identity.id),
            provider: String(identity.provider),
            providerAppId: String(identity.provider_app_id),
            providerSubject: String(identity.provider_subject),
            unionSubject: identity.union_subject == null ? null : String(identity.union_subject),
          },
        },
      });
    },
  );
}
