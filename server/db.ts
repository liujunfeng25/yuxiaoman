import { createHash, randomUUID } from "node:crypto";
import { migratePlateCategories, seedPlateCategoryPlans } from "./plate-category-db.js";
import { DEVELOPMENT_USER_ID, migrateAuthDatabase, seedDevelopmentUser } from "./auth.js";
import { migrateBackofficeDatabase } from "./backoffice.js";
import {
  createPostgresDatabase,
  type AppDatabase,
  type DatabaseOptions,
  type DatabaseValue,
} from "./database.js";
import { clearInsuranceData, migrateInsuranceDatabase, seedInsurancePartner } from "./insurance-db.js";
import {
  clearSubsidyConsultationData,
  migrateSubsidyConsultationDatabase,
  seedSubsidyConsultationData,
} from "./subsidy-consultation.js";
import { clearUsedCarData, migrateUsedCarDatabase, seedUsedCarDemoData } from "./used-car-db.js";
import { clearWashData, migrateWashDatabase, seedWashDemoData } from "./wash-db.js";
import { clearCarRentalData, migrateCarRentalDatabase, seedCarRentalDemoData } from "./car-rental-db.js";
import { migrateVehicleCheckupDatabase } from "./vehicle-checkup-db.js";
import { migrateValetHandoffDatabase } from "./valet-handoff-db.js";
import { migrateCustomerCenterDatabase } from "./customer-center.js";
import {
  clearDrivingSchoolData,
  migrateDrivingSchoolDatabase,
  seedDrivingSchoolDemoData,
} from "./driving-school-db.js";
import { clearRepairData, migrateRepairDatabase, seedRepairDemoData } from "./repair-db.js";
import {
  clearWorkflowRuntimeData,
  migrateWorkflowDatabase,
  seedDefaultWorkflowConfiguration,
} from "./workflow-db.js";

export const DEMO_USER_ID = DEVELOPMENT_USER_ID;
export const DEMO_STATION_ID = "station-hexi-1";
export const HUAYANG_STATION_ID = "station-huayang-1";
export const DEMO_INTEGRATION_SECRET = "yuxiaoman-demo-integration-secret";
const BASELINE_SEED_MARKER = "baseline-seed-v2";

export const INSPECTION_PRICE_PLAN_IDS = {
  smallIce: "plan-small-ice-1-6",
  smallPureElectric: "plan-small-pure-electric-1-6",
  smallPlugIn: "plan-small-plug-in-1-6",
  passengerPureElectric: "plan-passenger-pure-electric-7-9",
  passengerCombustion: "plan-passenger-combustion-7-9",
} as const;

export type Database = AppDatabase;

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function toIsoDate(value: Date): string {
  const parts = shanghaiDateFormatter.formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return read("year") + "-" + read("month") + "-" + read("day");
}

export function businessDate(): string {
  return process.env.YUXIAOMAN_DEMO_DATE ?? toIsoDate(new Date());
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
      .join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export function inspectionResultRequestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function dateFromBusinessDay(days: number): string {
  const base = new Date(businessDate() + "T12:00:00+08:00");
  return toIsoDate(new Date(base.getTime() + days * 86_400_000));
}

function dateYearsAgo(years: number): string {
  const [year, month, day] = businessDate().split("-").map(Number);
  return String(year - years).padStart(4, "0") + "-" +
    String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

export async function migrateDatabase(database: AppDatabase): Promise<void> {
  await migrateAuthDatabase(database);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      plate_number TEXT NOT NULL,
      plate_normalized TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      usage_nature TEXT NOT NULL,
      seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 99),
      registration_date TEXT NOT NULL,
      inspection_due_date TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , powertrain_type TEXT, vehicle_class_code TEXT, is_van INTEGER, wash_vehicle_category TEXT, inspection_due_date_source TEXT NOT NULL DEFAULT 'legacy_unverified', inspection_due_date_confirmed_at TEXT, brand_id TEXT, brand_name TEXT, model_id TEXT, model_name TEXT, exterior_color TEXT);

    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      district TEXT NOT NULL,
      address TEXT NOT NULL,
      distance_km REAL NOT NULL,
      drive_minutes INTEGER NOT NULL,
      rating REAL NOT NULL,
      review_count INTEGER NOT NULL,
      tags_json TEXT NOT NULL,
      service_fee_fen INTEGER NOT NULL CHECK (service_fee_fen >= 0),
      open_hours TEXT NOT NULL,
      phone TEXT,
      created_at TEXT NOT NULL
    , latitude REAL NOT NULL DEFAULT 39.0842, longitude REAL NOT NULL DEFAULT 117.2009, is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)), updated_at TEXT, legal_name TEXT, data_kind TEXT NOT NULL DEFAULT 'demo', is_direct_operated INTEGER NOT NULL DEFAULT 0 CHECK (is_direct_operated IN (0, 1)), is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)), sort_priority INTEGER NOT NULL DEFAULT 0, map_poi_id TEXT, weekly_schedule_json TEXT NOT NULL DEFAULT '{}', business_hours_notice TEXT, internal_contact_name TEXT, internal_contact_phone TEXT);

    CREATE TABLE IF NOT EXISTS station_slots (
      id TEXT PRIMARY KEY,
      station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      booked_count INTEGER NOT NULL DEFAULT 0 CHECK (booked_count >= 0),
      created_at TEXT NOT NULL,
      UNIQUE(station_id, date, start_time)
    );

    CREATE TABLE IF NOT EXISTS station_slot_seed_tombstones (
      slot_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inspection_price_plans (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      powertrain_types_json TEXT NOT NULL,
      min_seats INTEGER NOT NULL CHECK (min_seats > 0),
      max_seats INTEGER NOT NULL CHECK (max_seats >= min_seats),
      usage_natures_json TEXT NOT NULL,
      vehicle_class_codes_json TEXT NOT NULL,
      exclude_vans INTEGER NOT NULL DEFAULT 1 CHECK (exclude_vans IN (0, 1)),
      inspection_items_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS station_inspection_price_plans (
      station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES inspection_price_plans(id) ON DELETE CASCADE,
      is_supported INTEGER NOT NULL DEFAULT 1 CHECK (is_supported IN (0, 1)),
      price_fen INTEGER NOT NULL CHECK (price_fen >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (station_id, plan_id)
    );

    CREATE TABLE IF NOT EXISTS station_vehicle_prices (
      station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('fuel_small', 'new_energy_small', 'seven_seat')),
      price_fen INTEGER NOT NULL CHECK (price_fen >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (station_id, category)
    );

    CREATE TABLE IF NOT EXISTS valet_pricing_rules (
      id TEXT PRIMARY KEY,
      base_fee_fen INTEGER NOT NULL CHECK (base_fee_fen >= 0),
      included_km REAL NOT NULL CHECK (included_km >= 0),
      per_km_fen INTEGER NOT NULL CHECK (per_km_fen >= 0),
      max_radius_km REAL NOT NULL CHECK (max_radius_km > 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      updated_at TEXT NOT NULL
    , max_radius_km_limit REAL);

    CREATE TABLE IF NOT EXISTS station_valet_pricing_overrides (
      station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
      base_fee_fen INTEGER NOT NULL CHECK (base_fee_fen >= 0),
      included_km REAL NOT NULL CHECK (included_km >= 0),
      per_km_fen INTEGER NOT NULL CHECK (per_km_fen >= 0),
      max_radius_km REAL CHECK (max_radius_km IS NULL OR max_radius_km > 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quote_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
      station_id TEXT NOT NULL REFERENCES stations(id),
      service_mode TEXT NOT NULL,
      trip_type TEXT,
      vehicle_facts_json TEXT NOT NULL,
      price_plan_id TEXT,
      pricing_eligibility TEXT NOT NULL,
      inspection_items_json TEXT NOT NULL,
      inspection_fee_fen INTEGER NOT NULL,
      valet_base_fee_fen INTEGER NOT NULL,
      valet_distance_fee_fen INTEGER NOT NULL,
      valet_fee_fen INTEGER NOT NULL,
      service_fee_fen INTEGER NOT NULL,
      one_way_distance_km REAL,
      round_trip_distance_km REAL,
      billable_distance_km REAL,
      extra_km INTEGER,
      distance_source TEXT NOT NULL,
      distance_basis TEXT NOT NULL,
      drive_minutes INTEGER,
      rule_scope TEXT,
      rule_station_id TEXT,
      rule_base_fee_fen INTEGER,
      rule_included_km REAL,
      rule_per_km_fen INTEGER,
      rule_max_radius_km REAL,
      pickup_address_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    , snapshot_version TEXT NOT NULL DEFAULT 'quote-v1', vehicle_snapshot_json TEXT NOT NULL DEFAULT '{}', vehicle_facts_version TEXT NOT NULL DEFAULT 'vehicle-facts-v1', vehicle_facts_hash TEXT, station_snapshot_json TEXT NOT NULL DEFAULT '{}', price_plan_snapshot_json TEXT, inspection_item_amounts_json TEXT NOT NULL DEFAULT '[]', rule_snapshot_json TEXT, rule_updated_at TEXT, rule_version TEXT);

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      booking_number TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
      station_id TEXT NOT NULL REFERENCES stations(id),
      slot_id TEXT NOT NULL REFERENCES station_slots(id),
      contact_name TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      service_fee_fen INTEGER NOT NULL CHECK (service_fee_fen >= 0),
      status TEXT NOT NULL CHECK (
        status IN (
          'confirmed', 'awaiting_arrival', 'checked_in', 'inspecting',
          'result_received', 'completed', 'on_hold', 'cancelled', 'no_show'
        )
      ),
      appointment_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cancelled_at TEXT,
      completed_at TEXT
    , service_mode TEXT NOT NULL DEFAULT 'self_drive', inspection_fee_fen INTEGER NOT NULL DEFAULT 0, valet_fee_fen INTEGER NOT NULL DEFAULT 0, vehicle_price_category TEXT NOT NULL DEFAULT 'fuel_small', quote_distance_km REAL, quote_source TEXT NOT NULL DEFAULT 'station_price', pickup_poi_id TEXT, pickup_title TEXT, pickup_address TEXT, pickup_district TEXT, pickup_latitude REAL, pickup_longitude REAL, pickup_detail TEXT, pickup_note TEXT, quote_snapshot_id TEXT, trip_type TEXT, one_way_distance_km REAL, round_trip_distance_km REAL, billable_distance_km REAL, quote_extra_km INTEGER, price_plan_id TEXT, pricing_eligibility TEXT NOT NULL DEFAULT 'legacy', inspection_items_json TEXT NOT NULL DEFAULT '[]', valet_base_fee_fen INTEGER NOT NULL DEFAULT 0, valet_distance_fee_fen INTEGER NOT NULL DEFAULT 0, rule_scope TEXT, rule_station_id TEXT, rule_base_fee_fen INTEGER, rule_included_km REAL, rule_per_km_fen INTEGER, rule_max_radius_km REAL, quote_expires_at TEXT, payment_status TEXT NOT NULL DEFAULT 'unpaid', fulfillment_status TEXT NOT NULL DEFAULT 'legacy', internal_driver_note TEXT, pricing_snapshot_version TEXT, vehicle_snapshot_json TEXT, vehicle_facts_version TEXT, vehicle_facts_hash TEXT, station_snapshot_json TEXT, price_plan_snapshot_json TEXT, inspection_item_amounts_json TEXT, rule_snapshot_json TEXT, rule_updated_at TEXT, rule_version TEXT);

    CREATE TABLE IF NOT EXISTS booking_events (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'system' CHECK (
        actor_type IN ('owner', 'operator', 'driver', 'external_system', 'system')
      ),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminder_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      days_before INTEGER NOT NULL DEFAULT 30 CHECK (days_before BETWEEN 1 AND 365),
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, vehicle_id)
    );

    CREATE TABLE IF NOT EXISTS booking_verifications (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    plate_matched INTEGER NOT NULL DEFAULT 0 CHECK (plate_matched IN (0, 1)),
    materials_ready INTEGER NOT NULL DEFAULT 0 CHECK (materials_ready IN (0, 1)),
    exterior_recorded INTEGER NOT NULL DEFAULT 0 CHECK (exterior_recorded IN (0, 1)),
    condition_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (condition_confirmed IN (0, 1)),
    notes TEXT,
    verified_at TEXT,
    updated_at TEXT NOT NULL
  );

    -- The retired conditional literal remains in the storage constraint only
    -- so existing databases migrate without rewriting it to failed. All
    -- current write APIs accept only passed/failed.
    CREATE TABLE IF NOT EXISTS inspection_results (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    external_result_id TEXT NOT NULL UNIQUE,
    conclusion TEXT NOT NULL CHECK (conclusion IN ('passed', 'conditional', 'failed')),
    failure_details_json TEXT,
    summary_json TEXT NOT NULL,
    source TEXT NOT NULL,
    received_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL
  );

    CREATE TABLE IF NOT EXISTS booking_payments (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      out_trade_no TEXT,
      UNIQUE(provider, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS booking_ledger_entries (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount_fen INTEGER NOT NULL,
      description TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      payment_id TEXT REFERENCES booking_payments(id),
      idempotency_key TEXT,
      created_at TEXT NOT NULL, confirmation_status TEXT NOT NULL DEFAULT 'confirmed', confirmation_idempotency_key TEXT, confirmed_at TEXT,
      UNIQUE(booking_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS booking_media (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CONSTRAINT booking_media_kind_check_v2 CHECK (
        kind IN ('vehicle_front_left', 'vehicle_front_right', 'vehicle_rear_left',
                 'vehicle_rear_right', 'dashboard_started', 'license_front', 'license_back')
      ),
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      bound_at TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS booking_prechecks (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      station_id TEXT NOT NULL REFERENCES stations(id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewer_account_id TEXT,
      reviewer_name TEXT,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      reason_text TEXT,
      issue_photo_kinds_json TEXT NOT NULL DEFAULT '[]',
      decision_idempotency_key TEXT,
      refund_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (
        refund_status IN ('not_requested', 'refund_pending', 'refunded', 'refund_failed')
      ),
      refund_amount_fen INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount_fen >= 0),
      refund_error TEXT,
      refund_requested_at TEXT,
      refund_completed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS vehicles_active_plate_unique
      ON vehicles(user_id, plate_normalized)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS bookings_user_created_index
      ON bookings(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS bookings_created_index
      ON bookings(created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS bookings_vehicle_active_index
      ON bookings(vehicle_id, status);

    CREATE INDEX IF NOT EXISTS booking_events_booking_index
      ON booking_events(booking_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS booking_media_booking_index ON booking_media(booking_id, kind);

    CREATE INDEX IF NOT EXISTS booking_media_expiry_index ON booking_media(expires_at);

    CREATE INDEX IF NOT EXISTS booking_prechecks_station_queue_index
      ON booking_prechecks(station_id, status, submitted_at ASC);

    CREATE INDEX IF NOT EXISTS bookings_station_date_index ON bookings(station_id, appointment_date, start_time);

    CREATE INDEX IF NOT EXISTS station_price_plans_station_index ON station_inspection_price_plans(station_id, is_supported);

    CREATE INDEX IF NOT EXISTS quote_snapshots_expiry_index ON quote_snapshots(expires_at);

    CREATE INDEX IF NOT EXISTS booking_payments_booking_index ON booking_payments(booking_id, created_at);

    CREATE INDEX IF NOT EXISTS booking_ledger_booking_index ON booking_ledger_entries(booking_id, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS booking_ledger_confirmation_idempotency
      ON booking_ledger_entries(booking_id, confirmation_idempotency_key)
      WHERE confirmation_idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS vehicles_user_default_index ON vehicles(user_id, is_default DESC, created_at DESC) WHERE deleted_at IS NULL;
  `);
  await database.execute(`
    ALTER TABLE booking_media
      DROP CONSTRAINT IF EXISTS booking_media_kind_check;

    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'booking_media_kind_check_v2'
          AND conrelid = 'booking_media'::regclass
      ) THEN
        ALTER TABLE booking_media
          ADD CONSTRAINT booking_media_kind_check_v2 CHECK (
            kind IN (
              'vehicle_front_left', 'vehicle_front_right', 'vehicle_rear_left',
              'vehicle_rear_right', 'dashboard_started', 'license_front', 'license_back'
            )
          );
      END IF;
    END $migration$;
  `);
  await database.execute(`
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS brand_id TEXT;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS brand_name TEXT;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model_id TEXT;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model_name TEXT;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS exterior_color TEXT;
  `);
  const autoConfirmMigrationAt = new Date().toISOString();
  await migratePlateCategories(database);
  await database.prepare(`
    INSERT INTO booking_events (
      id, booking_id, status, title, description, actor_type, metadata_json, created_at
    )
    SELECT 'event-auto-confirm-' || b.id, b.id, 'confirmed',
      '预约已自动确认', '系统根据已确认支付自动恢复预约，无需后台人工确认',
      'system', '{"migration":"payment-auto-confirm-v1"}', ?
    FROM bookings b
    WHERE b.fulfillment_status = 'paid_pending_confirmation'
      AND b.payment_status = 'paid'
      AND EXISTS (
        SELECT 1 FROM booking_payments p
        WHERE p.booking_id = b.id AND p.status = 'confirmed'
      )
    ON CONFLICT (id) DO NOTHING
  `).run(autoConfirmMigrationAt);
  await database.prepare(`
    UPDATE bookings SET fulfillment_status = 'confirmed', updated_at = ?
    WHERE fulfillment_status = 'paid_pending_confirmation'
      AND payment_status = 'paid'
      AND EXISTS (
        SELECT 1 FROM booking_payments p
        WHERE p.booking_id = bookings.id AND p.status = 'confirmed'
      )
  `).run(autoConfirmMigrationAt);
  await migrateVehicleCheckupDatabase(database);
  await database.execute(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS precheck_slot_released INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE booking_media ADD COLUMN IF NOT EXISTS is_current INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE booking_prechecks ADD COLUMN IF NOT EXISTS history_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE booking_prechecks ADD COLUMN IF NOT EXISTS resolution_note TEXT;
    ALTER TABLE booking_prechecks ADD COLUMN IF NOT EXISTS resubmission_key TEXT;
    ALTER TABLE booking_prechecks ADD COLUMN IF NOT EXISTS resubmission_hash TEXT;
    ALTER TABLE booking_prechecks ADD COLUMN IF NOT EXISTS decision_hash TEXT;
    ALTER TABLE booking_payments ADD COLUMN IF NOT EXISTS out_trade_no TEXT;
    ALTER TABLE booking_payments ALTER COLUMN confirmed_at DROP NOT NULL;
  `);
  await database.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS booking_payments_out_trade_no_uidx
      ON booking_payments(out_trade_no) WHERE out_trade_no IS NOT NULL;
  `);
  await migrateRepairDatabase(database);
  await migrateWashDatabase(database);
  await database.execute(`CREATE TABLE IF NOT EXISTS precheck_wash_links (
    wash_order_id TEXT PRIMARY KEY REFERENCES wash_orders(id) ON DELETE CASCADE,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  )`);
  await migrateBackofficeDatabase(database);
  await migrateWorkflowDatabase(database);
  await seedDefaultWorkflowConfiguration(database);
  await migrateValetHandoffDatabase(database);
  await migrateInsuranceDatabase(database);
  await migrateSubsidyConsultationDatabase(database);
  await migrateUsedCarDatabase(database);
  await migrateCarRentalDatabase(database);
  await migrateDrivingSchoolDatabase(database);
  await migrateCustomerCenterDatabase(database);
  await database.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES ('schema-version', 'postgres-v1', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(new Date().toISOString());
}

type SeedOptions = {
  force?: boolean;
};

export async function demoResetBlockers(database: AppDatabase): Promise<{
  unsafeCustomers: number;
  appendOnlyNotes: number;
}> {
  const unsafeCustomers = await database.prepare<{ count: number }>(`
    SELECT COUNT(*)::integer AS count
    FROM users u
    WHERE u.data_kind IS DISTINCT FROM 'demo'
      OR EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = 'wechat')
  `).get();
  const appendOnlyNotes = await database.prepare<{ count: number }>(`
    SELECT COUNT(*)::integer AS count FROM customer_admin_notes
  `).get();
  return {
    unsafeCustomers: Number(unsafeCustomers?.count ?? 0),
    appendOnlyNotes: Number(appendOnlyNotes?.count ?? 0),
  };
}

async function assertForcedDemoSeedSafe(database: AppDatabase): Promise<void> {
  const blockers = await demoResetBlockers(database);
  if (blockers.unsafeCustomers > 0 || blockers.appendOnlyNotes > 0) {
    throw new DemoResetUnsafeError();
  }
}

export class DemoResetUnsafeError extends Error {
  readonly code = "DEMO_RESET_UNSAFE";

  constructor() {
    super("DEMO_RESET_UNSAFE: real/unknown customers or append-only customer notes exist");
    this.name = "DemoResetUnsafeError";
  }
}

const BASELINE_CONFIGURATION = {"stations":[{"id":"station-hexi-1","name":"海河机动车检测服务中心（演示）","district":"河西区","address":"解放南路与浯水道交口东侧（演示地址）","distance_km":3.2,"drive_minutes":12,"rating":4.9,"review_count":328,"tags_json":"[\"休息区\",\"新能源\",\"周末可约\"]","service_fee_fen":26000,"open_hours":"08:30-17:00","phone":"022-0000-5208","created_at":"2026-08-14T12:04:13.646Z","latitude":39.0413,"longitude":117.2264,"is_active":1,"updated_at":"2026-08-16T13:25:09.309Z","legal_name":null,"data_kind":"demo","is_direct_operated":0,"is_pinned":0,"sort_priority":0,"map_poi_id":null,"weekly_schedule_json":"{}","business_hours_notice":null,"internal_contact_name":null,"internal_contact_phone":null},{"id":"station-nankai-1","name":"津门快捷检测站（演示）","district":"南开区","address":"红旗南路辅路 188 号（演示地址）","distance_km":5.6,"drive_minutes":20,"rating":4.8,"review_count":216,"tags_json":"[\"材料预审\",\"咖啡休息区\"]","service_fee_fen":23800,"open_hours":"08:00-17:30","phone":"022-0000-1314","created_at":"2026-08-14T12:04:13.646Z","latitude":39.0944,"longitude":117.1518,"is_active":1,"updated_at":"2026-08-16T13:25:09.309Z","legal_name":null,"data_kind":"demo","is_direct_operated":0,"is_pinned":0,"sort_priority":0,"map_poi_id":null,"weekly_schedule_json":"{}","business_hours_notice":null,"internal_contact_name":null,"internal_contact_phone":null},{"id":"station-hedong-1","name":"津东安心车辆检测站（演示）","district":"河东区","address":"成林道 66 号院内（演示地址）","distance_km":8.1,"drive_minutes":27,"rating":4.7,"review_count":152,"tags_json":"[\"代办咨询\",\"大型停车场\"]","service_fee_fen":21800,"open_hours":"08:30-16:30","phone":"022-0000-8899","created_at":"2026-08-14T12:04:13.646Z","latitude":39.1266,"longitude":117.2639,"is_active":1,"updated_at":"2026-08-16T13:25:09.309Z","legal_name":null,"data_kind":"demo","is_direct_operated":0,"is_pinned":0,"sort_priority":0,"map_poi_id":null,"weekly_schedule_json":"{}","business_hours_notice":null,"internal_contact_name":null,"internal_contact_phone":null},{"id":"station-huayang-1","name":"华洋机动车检测站","district":"滨海新区","address":"天津自贸试验区（天津港保税区）海滨大道3680号","distance_km":0,"drive_minutes":0,"rating":5.0,"review_count":0,"tags_json":"[\"官方自营\",\"真实站点\",\"营业时间请电话确认\"]","service_fee_fen":26000,"open_hours":"周一至周五、周日 08:00-17:00；周六休息","phone":"022-25781772","created_at":"2026-08-16T13:25:09.309Z","latitude":39.010471,"longitude":117.729669,"is_active":1,"updated_at":"2026-08-16T13:25:09.309Z","legal_name":"天津市华洋机动车检测有限公司","data_kind":"real","is_direct_operated":1,"is_pinned":1,"sort_priority":1000,"map_poi_id":"10292096120912059203","weekly_schedule_json":"{\"mon\":[{\"start\":\"08:00\",\"end\":\"17:00\"}],\"tue\":[{\"start\":\"08:00\",\"end\":\"17:00\"}],\"wed\":[{\"start\":\"08:00\",\"end\":\"17:00\"}],\"thu\":[{\"start\":\"08:00\",\"end\":\"17:00\"}],\"fri\":[{\"start\":\"08:00\",\"end\":\"17:00\"}],\"sat\":[],\"sun\":[{\"start\":\"08:00\",\"end\":\"17:00\"}]}","business_hours_notice":"营业时间可能临时调整，到站前请电话确认。","internal_contact_name":"孙磊","internal_contact_phone":"15332115222"}],"inspection_price_plans":[{"id":"plan-small-ice-1-6","code":"small_ice_1_6","name":"1–6 座燃油乘用车","description":"非营运 1–6 座汽油或柴油乘用车","powertrain_types_json":"[\"gasoline\",\"diesel\",\"hybrid\"]","min_seats":1,"max_seats":6,"usage_natures_json":"[\"非营运\"]","vehicle_class_codes_json":"[\"passenger_car\"]","exclude_vans":1,"inspection_items_json":"[\"safety_basic\",\"emissions_gasoline\",\"emissions_diesel\"]","sort_order":10,"is_active":1,"created_at":"2026-08-16T13:25:09.309Z","updated_at":"2026-08-16T18:49:01.066Z"},{"id":"plan-small-pure-electric-1-6","code":"small_pure_electric_1_6","name":"1–6 座纯电乘用车","description":"非营运 1–6 座纯电乘用车，不包含尾气检测","powertrain_types_json":"[\"pure_electric\"]","min_seats":1,"max_seats":6,"usage_natures_json":"[\"非营运\"]","vehicle_class_codes_json":"[\"passenger_car\"]","exclude_vans":1,"inspection_items_json":"[\"safety_basic\",\"new_energy_safety\"]","sort_order":20,"is_active":1,"created_at":"2026-08-16T13:25:09.309Z","updated_at":"2026-08-16T13:25:09.309Z"},{"id":"plan-small-plug-in-1-6","code":"small_plug_in_1_6","name":"1–6 座插混/增程乘用车","description":"非营运 1–6 座插混或增程乘用车","powertrain_types_json":"[\"phev\",\"erev\"]","min_seats":1,"max_seats":6,"usage_natures_json":"[\"非营运\"]","vehicle_class_codes_json":"[\"passenger_car\"]","exclude_vans":1,"inspection_items_json":"[\"safety_basic\",\"new_energy_safety\",\"emissions_gasoline\"]","sort_order":30,"is_active":1,"created_at":"2026-08-16T13:25:09.309Z","updated_at":"2026-08-16T13:25:09.309Z"},{"id":"plan-passenger-pure-electric-7-9","code":"passenger_pure_electric_7_9","name":"7–9 座纯电乘用车","description":"非营运 7–9 座纯电乘用车，不包含尾气检测","powertrain_types_json":"[\"pure_electric\"]","min_seats":7,"max_seats":9,"usage_natures_json":"[\"非营运\"]","vehicle_class_codes_json":"[\"passenger_car\"]","exclude_vans":1,"inspection_items_json":"[\"safety_basic\",\"safety_chassis_extended\",\"new_energy_safety\"]","sort_order":40,"is_active":1,"created_at":"2026-08-16T13:25:09.309Z","updated_at":"2026-08-16T13:25:09.309Z"},{"id":"plan-passenger-combustion-7-9","code":"passenger_combustion_7_9","name":"7–9 座燃油/插混乘用车","description":"非营运 7–9 座燃油、插混或增程乘用车","powertrain_types_json":"[\"gasoline\",\"diesel\",\"phev\",\"erev\",\"hybrid\"]","min_seats":7,"max_seats":9,"usage_natures_json":"[\"非营运\"]","vehicle_class_codes_json":"[\"passenger_car\"]","exclude_vans":1,"inspection_items_json":"[\"safety_basic\",\"safety_chassis_extended\",\"emissions_gasoline\",\"emissions_diesel\",\"new_energy_safety\"]","sort_order":50,"is_active":1,"created_at":"2026-08-16T13:25:09.309Z","updated_at":"2026-08-16T18:49:01.067Z"}],"station_inspection_price_plans":[{"station_id":"station-huayang-1","plan_id":"plan-small-ice-1-6","is_supported":1,"price_fen":26000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-huayang-1","plan_id":"plan-small-pure-electric-1-6","is_supported":1,"price_fen":24000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-huayang-1","plan_id":"plan-small-plug-in-1-6","is_supported":1,"price_fen":26000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-huayang-1","plan_id":"plan-passenger-pure-electric-7-9","is_supported":1,"price_fen":30000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-huayang-1","plan_id":"plan-passenger-combustion-7-9","is_supported":1,"price_fen":30000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hexi-1","plan_id":"plan-small-ice-1-6","is_supported":1,"price_fen":26000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hexi-1","plan_id":"plan-small-pure-electric-1-6","is_supported":1,"price_fen":24000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hexi-1","plan_id":"plan-small-plug-in-1-6","is_supported":1,"price_fen":24000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hexi-1","plan_id":"plan-passenger-pure-electric-7-9","is_supported":1,"price_fen":30000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hexi-1","plan_id":"plan-passenger-combustion-7-9","is_supported":1,"price_fen":30000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-nankai-1","plan_id":"plan-small-ice-1-6","is_supported":1,"price_fen":23800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-nankai-1","plan_id":"plan-small-pure-electric-1-6","is_supported":1,"price_fen":21800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-nankai-1","plan_id":"plan-small-plug-in-1-6","is_supported":1,"price_fen":21800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-nankai-1","plan_id":"plan-passenger-pure-electric-7-9","is_supported":1,"price_fen":27800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-nankai-1","plan_id":"plan-passenger-combustion-7-9","is_supported":1,"price_fen":27800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hedong-1","plan_id":"plan-small-ice-1-6","is_supported":1,"price_fen":21800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hedong-1","plan_id":"plan-small-pure-electric-1-6","is_supported":1,"price_fen":19800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hedong-1","plan_id":"plan-small-plug-in-1-6","is_supported":1,"price_fen":19800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hedong-1","plan_id":"plan-passenger-pure-electric-7-9","is_supported":1,"price_fen":25800,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-hedong-1","plan_id":"plan-passenger-combustion-7-9","is_supported":1,"price_fen":25800,"updated_at":"2026-08-16T13:25:09.309Z"}],"station_vehicle_prices":[{"station_id":"station-hexi-1","category":"fuel_small","price_fen":26000,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-hexi-1","category":"new_energy_small","price_fen":24000,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-hexi-1","category":"seven_seat","price_fen":30000,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-nankai-1","category":"fuel_small","price_fen":23800,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-nankai-1","category":"new_energy_small","price_fen":21800,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-nankai-1","category":"seven_seat","price_fen":27800,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-hedong-1","category":"fuel_small","price_fen":21800,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-hedong-1","category":"new_energy_small","price_fen":19800,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-hedong-1","category":"seven_seat","price_fen":25800,"updated_at":"2026-08-14T12:04:13.646Z"},{"station_id":"station-huayang-1","category":"fuel_small","price_fen":26000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-huayang-1","category":"new_energy_small","price_fen":24000,"updated_at":"2026-08-16T13:25:09.309Z"},{"station_id":"station-huayang-1","category":"seven_seat","price_fen":30000,"updated_at":"2026-08-16T13:25:09.309Z"}],"valet_pricing_rules":[{"id":"default","base_fee_fen":10900,"included_km":10,"per_km_fen":800,"max_radius_km":1000000,"is_active":1,"updated_at":"2026-08-16T14:50:38.374Z","max_radius_km_limit":null}],"station_valet_pricing_overrides":[{"station_id":"station-huayang-1","base_fee_fen":9900,"included_km":10,"per_km_fen":800,"max_radius_km":null,"updated_at":"2026-08-16T13:25:09.309Z"}]} as Record<string, Array<Record<string, DatabaseValue>>>;

async function insertRows(
  database: AppDatabase,
  table: string,
  rows: Array<Record<string, DatabaseValue>>,
): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) continue;
    const placeholders = columns.map(() => "?").join(", ");
    const statement = database.prepare(
      "INSERT INTO " + table + " (" + columns.join(", ") + ") VALUES (" + placeholders + ") ON CONFLICT DO NOTHING",
    );
    await statement.run(...columns.map((column) => row[column]));
  }
}

const OPERATOR_DEMO_DATE_MARKER = "operator-demo-business-date-v1";
const OPERATOR_DEMO_FINANCIALS_MARKER = "operator-demo-financials-v1";

/** 运营演示单 booking-op-*：仅测试默认开启；线上/演示库默认关闭，避免后台列表被污染。 */
function operatorDemoBookingsEnabled(): boolean {
  if (process.env.SEED_OPERATOR_DEMO_BOOKINGS === "true") return true;
  if (process.env.SEED_OPERATOR_DEMO_BOOKINGS === "false") return false;
  return process.env.NODE_ENV === "test";
}

const OPERATOR_SLOT_TIMES = [
  ["08:30", "09:30"],
  ["10:00", "11:00"],
  ["13:30", "14:30"],
  ["15:00", "16:00"],
] as const;
const OPERATOR_BOOKING_SPECS = [
  ["booking-op-1", "operator-user-1", "vehicle-op-1", "awaiting_arrival", 0, "王女士", "13800001001", null],
  ["booking-op-2", "operator-user-2", "vehicle-op-2", "checked_in", 1, "赵先生", "13800001002", null],
  ["booking-op-3", "operator-user-3", "vehicle-op-3", "inspecting", 1, "陈女士", "13800001003", null],
  ["booking-op-4", "operator-user-4", "vehicle-op-4", "completed", 2, "李先生", "13800001004", null],
  ["booking-op-5", "operator-user-5", "vehicle-op-5", "on_hold", 2, "周女士", "13800001005", "车辆信息待复核"],
  ["booking-op-6", "operator-user-6", "vehicle-op-6", "result_received", 3, "孙先生", "13800001006", null],
] as const;
const OPERATOR_BOOKING_IDS = OPERATOR_BOOKING_SPECS.map(([id]) => id);
const OPERATOR_BOOKING_FINANCIALS: Record<string, {
  vehiclePriceCategory: "fuel_small" | "new_energy_small" | "seven_seat";
  inspectionItems: string[];
  feeFen: number;
}> = {
  "booking-op-1": { vehiclePriceCategory: "fuel_small", inspectionItems: ["safety_basic", "emissions_gasoline"], feeFen: 26000 },
  "booking-op-2": { vehiclePriceCategory: "fuel_small", inspectionItems: ["safety_basic", "emissions_gasoline"], feeFen: 26000 },
  "booking-op-3": { vehiclePriceCategory: "new_energy_small", inspectionItems: ["safety_basic", "new_energy_safety"], feeFen: 24000 },
  "booking-op-4": { vehiclePriceCategory: "fuel_small", inspectionItems: ["safety_basic", "emissions_gasoline"], feeFen: 26000 },
  "booking-op-5": { vehiclePriceCategory: "new_energy_small", inspectionItems: ["safety_basic", "new_energy_safety"], feeFen: 24000 },
  "booking-op-6": { vehiclePriceCategory: "seven_seat", inspectionItems: ["safety_basic", "safety_chassis_extended", "emissions_gasoline"], feeFen: 30000 },
};

class OperatorDemoRolloverUnavailable extends Error {}

function operatorSlotId(date: string, slotIndex: number): string {
  return "slot-" + DEMO_STATION_ID + "-" + date + "-" + OPERATOR_SLOT_TIMES[slotIndex][0].replace(":", "");
}

async function writeOperatorDemoDate(database: AppDatabase, date: string, now: string): Promise<void> {
  await database.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(OPERATOR_DEMO_DATE_MARKER, date, now);
}

async function seedOperatorDemoBookings(
  database: AppDatabase,
  date: string,
  now: string,
  replaceExisting: boolean,
): Promise<void> {
  if (!operatorDemoBookingsEnabled()) return;
  await database.transaction(async (transaction) => {
    const targetSlotIds = OPERATOR_SLOT_TIMES.map((_, index) => operatorSlotId(date, index));
    const station = await transaction.prepare<{ id: string }>(
      "SELECT id FROM stations WHERE id = ?",
    ).get(DEMO_STATION_ID);
    const tombstone = await transaction.prepare<{ count: number }>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM station_slot_seed_tombstones
      WHERE slot_id = ANY(?)
    `).get(targetSlotIds);
    if (!station || Number(tombstone?.count ?? 0) > 0) {
      throw new OperatorDemoRolloverUnavailable();
    }

    for (const [index, [start, end]] of OPERATOR_SLOT_TIMES.entries()) {
      await transaction.prepare(`
        INSERT INTO station_slots (
          id, station_id, date, start_time, end_time, capacity, booked_count, created_at
        ) VALUES (?, ?, ?, ?, ?, 4, 0, ?)
        ON CONFLICT (id) DO NOTHING
      `).run(targetSlotIds[index], DEMO_STATION_ID, date, start, end, now);
    }

    const availableSlots = await transaction.prepare<{ count: number }>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM station_slots
      WHERE id = ANY(?) AND station_id = ? AND date = ?
    `).get(targetSlotIds, DEMO_STATION_ID, date);
    if (Number(availableSlots?.count ?? 0) !== OPERATOR_SLOT_TIMES.length) {
      throw new OperatorDemoRolloverUnavailable();
    }

    if (replaceExisting) {
      await transaction.prepare("DELETE FROM bookings WHERE id = ANY(?)").run(OPERATOR_BOOKING_IDS);
    }

    const bookings = OPERATOR_BOOKING_SPECS.map(([
      id,
      userId,
      vehicleId,
      status,
      slotIndex,
      contactName,
      contactPhone,
      note,
    ], index) => {
      const financial = OPERATOR_BOOKING_FINANCIALS[id];
      return {
        id,
        booking_number: "YXM" + date.replaceAll("-", "") + "OP" + (index + 1),
        user_id: userId,
        vehicle_id: vehicleId,
        station_id: DEMO_STATION_ID,
        slot_id: targetSlotIds[slotIndex],
        contact_name: contactName,
        contact_phone: contactPhone,
        service_mode: "self_drive",
        trip_type: null,
        vehicle_price_category: financial.vehiclePriceCategory,
        pricing_eligibility: "eligible",
        inspection_items_json: JSON.stringify(financial.inspectionItems),
        service_fee_fen: financial.feeFen,
        inspection_fee_fen: financial.feeFen,
        valet_base_fee_fen: 0,
        valet_distance_fee_fen: 0,
        valet_fee_fen: 0,
        quote_source: "station_price",
        payment_status: "paid",
        fulfillment_status: status,
        status,
        appointment_date: date,
        start_time: OPERATOR_SLOT_TIMES[slotIndex][0],
        end_time: OPERATOR_SLOT_TIMES[slotIndex][1],
        notes: note,
        created_at: now,
        updated_at: now,
        cancelled_at: null,
        completed_at: status === "completed" ? now : null,
      };
    }) as Array<Record<string, DatabaseValue>>;
    await insertRows(transaction, "bookings", bookings);

    const paymentAt = new Date(Date.parse(now) - 60_000).toISOString();
    const payments = OPERATOR_BOOKING_SPECS.map(([id]) => {
      const financial = OPERATOR_BOOKING_FINANCIALS[id];
      return {
        id: "payment-" + id,
        booking_id: id,
        provider: "mock",
        idempotency_key: "seed-payment-" + id,
        amount_fen: financial.feeFen,
        status: "confirmed",
        created_at: paymentAt,
        confirmed_at: paymentAt,
      };
    }) as Array<Record<string, DatabaseValue>>;
    await insertRows(transaction, "booking_payments", payments);

    const ledgerEntries = OPERATOR_BOOKING_SPECS.map(([id]) => {
      const financial = OPERATOR_BOOKING_FINANCIALS[id];
      return {
        id: "ledger-" + id,
        booking_id: id,
        kind: "booking_charge",
        amount_fen: financial.feeFen,
        description: "年检预约服务费（模拟支付）",
        actor_type: "system",
        payment_id: "payment-" + id,
        idempotency_key: "seed-charge-" + id,
        confirmation_status: "confirmed",
        confirmed_at: paymentAt,
        created_at: paymentAt,
      };
    }) as Array<Record<string, DatabaseValue>>;
    await insertRows(transaction, "booking_ledger_entries", ledgerEntries);

    const paymentEvents = OPERATOR_BOOKING_SPECS.map(([id]) => {
      const financial = OPERATOR_BOOKING_FINANCIALS[id];
      return {
        id: "event-payment-" + id,
        booking_id: id,
        status: "confirmed",
        title: "模拟支付已确认，预约自动生效",
        description: `本地 mock 交易已记录 ¥${(financial.feeFen / 100).toFixed(2)}，预约已自动进入履约队列；未调用真实支付 SDK`,
        actor_type: "system",
        metadata_json: JSON.stringify({ provider: "mock", amountFen: financial.feeFen }),
        created_at: paymentAt,
      };
    }) as Array<Record<string, DatabaseValue>>;
    const taskEvents = OPERATOR_BOOKING_SPECS.map(([id, , , status, , , , note]) => ({
      id: "event-" + id,
      booking_id: id,
      status,
      title: status === "on_hold" ? "业务已挂起" : "演示任务已就绪",
      description: status === "on_hold" ? String(note) : "检测站今日履约演示任务",
      actor_type: status === "result_received" ? "external_system" : "system",
      metadata_json: status === "on_hold"
        ? JSON.stringify({ previousStatus: "checked_in", reasonCode: "vehicle_mismatch" })
        : "{}",
      created_at: now,
    })) as Array<Record<string, DatabaseValue>>;
    await insertRows(transaction, "booking_events", [...paymentEvents, ...taskEvents]);

    const verifications = OPERATOR_BOOKING_SPECS.slice(1).map(([id, , , status]) => ({
      id: "verification-" + id,
      booking_id: id,
      plate_matched: status === "on_hold" ? 0 : 1,
      materials_ready: 1,
      exterior_recorded: 1,
      condition_confirmed: 1,
      notes: status === "on_hold" ? "车辆信息待复核" : null,
      verified_at: now,
      updated_at: now,
    })) as Array<Record<string, DatabaseValue>>;
    await insertRows(transaction, "booking_verifications", verifications);

    const results = ["booking-op-4", "booking-op-6"].map((bookingId) => {
      const summary = { conclusionLabel: "检验合格", itemsPassed: 12, itemsTotal: 12 };
      return {
        id: "result-" + bookingId,
        booking_id: bookingId,
        external_result_id: "EXT-" + bookingId.toUpperCase(),
        conclusion: "passed",
        summary_json: JSON.stringify(summary),
        source: "external_inspection_system",
        received_at: now,
        idempotency_key: "seed-" + bookingId,
        request_hash: inspectionResultRequestHash({ bookingId, summary }),
      };
    }) as Array<Record<string, DatabaseValue>>;
    await insertRows(transaction, "inspection_results", results);

    await transaction.prepare(`
      UPDATE station_slots s
      SET booked_count = (
        SELECT COUNT(*)::INTEGER
        FROM bookings b
        WHERE b.slot_id = s.id AND b.status NOT IN ('cancelled', 'no_show')
      )
      WHERE s.station_id = ?
    `).run(DEMO_STATION_ID);
    await transaction.prepare(`
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, 'applied', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(OPERATOR_DEMO_FINANCIALS_MARKER, now);
    await writeOperatorDemoDate(transaction, date, now);
  });
}

async function upgradeOperatorDemoFinancialsIfNeeded(database: AppDatabase, now: string): Promise<void> {
  if (!operatorDemoBookingsEnabled()) return;
  if (await database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(OPERATOR_DEMO_FINANCIALS_MARKER)) return;

  const rows = await database.prepare<{ id: string; status: string }>(`
    SELECT id, status FROM bookings WHERE id = ANY(?)
  `).all(OPERATOR_BOOKING_IDS);
  if (!rows.length) return;

  const paymentAt = new Date(Date.parse(now) - 60_000).toISOString();
  for (const row of rows) {
    const financial = OPERATOR_BOOKING_FINANCIALS[row.id];
    if (!financial) continue;
    const paymentId = "payment-" + row.id;
    await database.prepare(`
      UPDATE bookings SET
        vehicle_price_category = ?, pricing_eligibility = 'eligible', inspection_items_json = ?,
        service_fee_fen = ?, inspection_fee_fen = ?, payment_status = 'paid',
        fulfillment_status = CASE WHEN fulfillment_status = 'legacy' THEN status ELSE fulfillment_status END,
        updated_at = ?
      WHERE id = ?
    `).run(
      financial.vehiclePriceCategory,
      JSON.stringify(financial.inspectionItems),
      financial.feeFen,
      financial.feeFen,
      now,
      row.id,
    );
    await database.prepare(`
      INSERT INTO booking_payments (
        id, booking_id, provider, idempotency_key, amount_fen, status, created_at, confirmed_at
      ) VALUES (?, ?, 'mock', ?, ?, 'confirmed', ?, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(paymentId, row.id, "seed-payment-" + row.id, financial.feeFen, paymentAt, paymentAt);
    await database.prepare(`
      INSERT INTO booking_ledger_entries (
        id, booking_id, kind, amount_fen, description, actor_type, payment_id,
        idempotency_key, confirmation_status, confirmed_at, created_at
      ) VALUES (?, ?, 'booking_charge', ?, '年检预约服务费（模拟支付）', 'system', ?, ?, 'confirmed', ?, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(
      "ledger-" + row.id,
      row.id,
      financial.feeFen,
      paymentId,
      "seed-charge-" + row.id,
      paymentAt,
      paymentAt,
    );
    await database.prepare(`
      INSERT INTO booking_events (
        id, booking_id, status, title, description, actor_type, metadata_json, created_at
      ) VALUES (?, ?, 'paid_pending_confirmation', '模拟支付已确认', ?, 'system', ?, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(
      "event-payment-" + row.id,
      row.id,
      `本地 mock 交易已记录 ¥${(financial.feeFen / 100).toFixed(2)}，未调用真实支付 SDK`,
      JSON.stringify({ provider: "mock", amountFen: financial.feeFen }),
      paymentAt,
    );
  }

  await database.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES (?, 'applied', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(OPERATOR_DEMO_FINANCIALS_MARKER, now);
}

async function rollOperatorDemoBookingsIfNeeded(
  database: AppDatabase,
  date: string,
  now: string,
): Promise<void> {
  if (!operatorDemoBookingsEnabled()) return;
  const marker = await database.prepare<{ value: string }>(
    "SELECT value FROM app_metadata WHERE key = ?",
  ).get(OPERATOR_DEMO_DATE_MARKER);
  if (marker?.value === date) return;

  const existing = await database.prepare<{ appointment_date: string }>(`
    SELECT appointment_date
    FROM bookings
    WHERE id = ANY(?)
    ORDER BY appointment_date DESC
    LIMIT 1
  `).get(OPERATOR_BOOKING_IDS);

  if (!marker && !existing) {
    await writeOperatorDemoDate(database, date, now);
    return;
  }
  if (!marker && existing?.appointment_date === date) {
    await writeOperatorDemoDate(database, date, now);
    return;
  }

  try {
    await seedOperatorDemoBookings(database, date, now, true);
  } catch (error) {
    if (error instanceof OperatorDemoRolloverUnavailable) return;
    throw error;
  }
}

async function clearCoreDemoData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM valet_evidence_media;
    DELETE FROM valet_evidence_packages;
    DELETE FROM valet_driver_code_attempts;
    DELETE FROM valet_driver_sessions;
    DELETE FROM valet_driver_assignments;
    DELETE FROM vehicle_checkup_media;
    DELETE FROM vehicle_checkup_faults;
    DELETE FROM vehicle_checkup_reports;
    DELETE FROM booking_media;
    DELETE FROM booking_ledger_entries;
    DELETE FROM booking_payments;
    DELETE FROM inspection_results;
    DELETE FROM booking_verifications;
    DELETE FROM reminder_preferences;
    DELETE FROM booking_events;
    DELETE FROM bookings;
    DELETE FROM quote_snapshots;
    DELETE FROM station_inspection_price_plans;
    DELETE FROM station_vehicle_prices;
    DELETE FROM station_valet_pricing_overrides;
    DELETE FROM valet_pricing_rules;
    DELETE FROM inspection_price_plans;
    DELETE FROM station_slot_seed_tombstones;
    DELETE FROM station_slots;
    DELETE FROM stations;
    DELETE FROM vehicles;
    DELETE FROM customer_admin_tags;
    DELETE FROM user_sessions;
    DELETE FROM user_identities;
    DELETE FROM users;
  `);
}

async function seedDemoDataInCurrentTransaction(database: AppDatabase, options: SeedOptions = {}): Promise<void> {
  const now = new Date().toISOString();
  const today = businessDate();
  const alreadyApplied = Boolean(
    await database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(BASELINE_SEED_MARKER),
  );

  if (options.force) {
    await assertForcedDemoSeedSafe(database);
    await clearWorkflowRuntimeData(database);
    await clearRepairData(database);
    await clearDrivingSchoolData(database);
    await clearCarRentalData(database);
    await clearSubsidyConsultationData(database);
    await clearInsuranceData(database);
    await clearUsedCarData(database);
    await clearWashData(database);
    await clearCoreDemoData(database);
  }

  if (options.force || !alreadyApplied) {
    await seedDevelopmentUser(database, DEMO_USER_ID, now);
    const operatorUsers = Array.from({ length: 6 }, (_, index) => ({
      id: "operator-user-" + (index + 1),
      customer_number: `CUS-${createHash("md5").update("operator-user-" + (index + 1)).digest("hex").slice(0, 12).toUpperCase()}`,
      data_kind: "demo",
      display_name: "履约演示车主 " + (index + 1),
      status: "active",
      created_at: now,
      updated_at: now,
    }));
    await insertRows(database, "users", operatorUsers);

    const vehicles = [
      {
        id: "vehicle-demo-1", user_id: DEMO_USER_ID, plate_number: "津A·88888",
        plate_normalized: "津A88888", vehicle_type: "小型轿车", usage_nature: "非营运",
        seats: 5, registration_date: dateYearsAgo(6), inspection_due_date: dateFromBusinessDay(18),
        inspection_due_date_source: "internal_placeholder", inspection_due_date_confirmed_at: null,
        powertrain_type: null, vehicle_class_code: null, is_van: null,
        brand_id: "brand-mercedes", brand_name: "奔驰", model_id: "vehicle-mercedes-s", model_name: "S级",
        wash_vehicle_category: "sedan", is_default: 1, created_at: now, updated_at: now, deleted_at: null,
      },
      ...[
        ["vehicle-op-1", "operator-user-1", "津B·T1001", "津BT1001", "白色轿车", 5, "sedan"],
        ["vehicle-op-2", "operator-user-2", "津C·M2036", "津CM2036", "灰色 SUV", 5, "suv"],
        ["vehicle-op-3", "operator-user-3", "津D·D35520", "津DD35520", "小型新能源轿车", 5, "sedan"],
        ["vehicle-op-4", "operator-user-4", "津E·Q8168", "津EQ8168", "蓝色轿车", 5, "sedan"],
        ["vehicle-op-5", "operator-user-5", "津F·F66218", "津FF66218", "小型新能源 SUV", 5, "suv"],
        ["vehicle-op-6", "operator-user-6", "津G·V5208", "津GV5208", "黑色 MPV", 7, "mpv"],
      ].map(([id, userId, plate, normalized, vehicleType, seats, washCategory]) => ({
        id, user_id: userId, plate_number: plate, plate_normalized: normalized,
        vehicle_type: vehicleType, usage_nature: "非营运", seats,
        registration_date: dateYearsAgo(5), inspection_due_date: dateFromBusinessDay(30),
        inspection_due_date_source: "internal_placeholder", inspection_due_date_confirmed_at: null,
        powertrain_type: null, vehicle_class_code: null, is_van: null,
        wash_vehicle_category: washCategory, is_default: 1, created_at: now, updated_at: now, deleted_at: null,
      })),
    ] as Array<Record<string, DatabaseValue>>;
    await insertRows(database, "vehicles", vehicles);

    for (const table of [
      "stations",
      "inspection_price_plans",
      "station_vehicle_prices",
      "station_inspection_price_plans",
      "valet_pricing_rules",
      "station_valet_pricing_overrides",
    ]) {
      await insertRows(database, table, BASELINE_CONFIGURATION[table] ?? []);
    }

    const slotTimes = [
      ["08:30", "09:30"],
      ["10:00", "11:00"],
      ["13:30", "14:30"],
      ["15:00", "16:00"],
    ];
    const stationIds = BASELINE_CONFIGURATION.stations.map((station) => String(station.id));
    const slots: Array<Record<string, DatabaseValue>> = [];
    for (const stationId of stationIds) {
      for (let offset = 0; offset <= 16; offset += 1) {
        const date = dateFromBusinessDay(offset);
        for (const [start, end] of slotTimes) {
          slots.push({
            id: "slot-" + stationId + "-" + date + "-" + start.replace(":", ""),
            station_id: stationId,
            date,
            start_time: start,
            end_time: end,
            capacity: 4,
            booked_count: 0,
            created_at: now,
          });
        }
      }
    }
    await insertRows(database, "station_slots", slots);

    await seedOperatorDemoBookings(database, today, now, false);
    await insertRows(database, "reminder_preferences", [{
      id: randomUUID(),
      user_id: DEMO_USER_ID,
      vehicle_id: "vehicle-demo-1",
      enabled: 1,
      days_before: 30,
      updated_at: now,
    }]);

    await database.prepare(`
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, 'applied', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(BASELINE_SEED_MARKER, now);
  } else {
    await rollOperatorDemoBookingsIfNeeded(database, today, now);
  }

  await upgradeOperatorDemoFinancialsIfNeeded(database, now);

  await seedWashDemoData(database, { force: options.force, businessDate: today, now });
  await seedInsurancePartner(database, now);
  await seedSubsidyConsultationData(database, now);
  await seedUsedCarDemoData(database, { force: options.force, now });
  await seedCarRentalDemoData(database, { force: options.force, now });
  await seedDrivingSchoolDemoData(database, now);
  await seedRepairDemoData(database, now);
}

async function lockForcedDemoSeed(database: AppDatabase): Promise<void> {
  await database.execute("SELECT pg_advisory_xact_lock(hashtext('yuxiaoman-demo-reset-v2'))");
  await database.execute(`
    LOCK TABLE users, user_identities, customer_admin_notes, customer_admin_tags
    IN SHARE ROW EXCLUSIVE MODE
  `);
}

export async function seedDemoData(database: AppDatabase, options: SeedOptions = {}): Promise<void> {
  if (!options.force) {
    await seedDemoDataInCurrentTransaction(database, options);
    await seedPlateCategoryPlans(database);
    return;
  }

  // The table locks close the safety-check/delete race: inserts of a new user,
  // WeChat identity or append-only customer note must finish before blockers
  // are evaluated, and cannot begin again until the reset commits.
  await database.transaction(async (transaction) => {
    await lockForcedDemoSeed(transaction);
    await seedDemoDataInCurrentTransaction(transaction, options);
    await seedPlateCategoryPlans(transaction, true);
  });
}

export type CreateDatabaseOptions = DatabaseOptions & {
  migrate?: boolean;
  seed?: boolean;
  forceSeed?: boolean;
};

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<AppDatabase> {
  const database = await createPostgresDatabase(options);
  const shouldMigrate = options.migrate !== false;
  const isProduction = process.env.NODE_ENV === "production" || process.env.YUXIAOMAN_ENV === "production";
  const shouldSeed = options.seed ?? !isProduction;
  try {
    if (shouldMigrate || shouldSeed) {
      await database.transaction(async (transaction) => {
        await transaction.execute(
          "SELECT pg_advisory_xact_lock(hashtext('yuxiaoman-postgres-schema-v1'))",
        );
        if (shouldMigrate) await migrateDatabase(transaction);
        if (shouldSeed && options.forceSeed) {
          await lockForcedDemoSeed(transaction);
          await seedDemoDataInCurrentTransaction(transaction, { force: true });
        } else if (shouldSeed) {
          await seedDemoDataInCurrentTransaction(transaction);
        }
        if (shouldMigrate) await seedPlateCategoryPlans(transaction, options.forceSeed);
      });
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
