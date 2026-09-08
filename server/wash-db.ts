import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";

export const WASH_SEED_MARKER = "wash-seed-v1";
export const WASH_MPV_PRICE_SEED_V2_MARKER = "wash-mpv-price-seed-v2";
export const WASH_STORE_IDS = {
  haihe: "wash-store-haihe-demo",
  aoche: "wash-store-aoche-demo",
  jingang: "wash-store-jingang-demo",
} as const;
export const WASH_PACKAGE_IDS = {
  standard: "wash-package-standard",
  detailing: "wash-package-detailing",
} as const;

export type WashSeedOptions = {
  force?: boolean;
  businessDate: string;
  now: string;
};

export async function migrateWashDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS wash_stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      legal_name TEXT,
      district TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      phone TEXT,
      cover_image_url TEXT,
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      facilities_json TEXT NOT NULL DEFAULT '[]',
      open_hours TEXT NOT NULL,
      weekly_schedule_json TEXT NOT NULL DEFAULT '{}',
      business_hours_notice TEXT,
      advance_booking_days INTEGER NOT NULL DEFAULT 14 CHECK (advance_booking_days BETWEEN 1 AND 60),
      rating REAL NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
      review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
      data_kind TEXT NOT NULL DEFAULT 'demo' CHECK (data_kind IN ('demo', 'real')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_priority INTEGER NOT NULL DEFAULT 0,
      internal_contact_name TEXT,
      internal_contact_phone TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Existing installations may predate the information-rich store picker.
    -- CREATE TABLE IF NOT EXISTS never adds missing columns, so keep every
    -- owner-visible detail column additive and safe to rerun.
    ALTER TABLE wash_stores
      ADD COLUMN IF NOT EXISTS legal_name TEXT,
      ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS tags_json TEXT NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS facilities_json TEXT NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS weekly_schedule_json TEXT NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS business_hours_notice TEXT,
      ADD COLUMN IF NOT EXISTS advance_booking_days INTEGER NOT NULL DEFAULT 14
        CHECK (advance_booking_days BETWEEN 1 AND 60),
      ADD COLUMN IF NOT EXISTS rating REAL NOT NULL DEFAULT 0
        CHECK (rating >= 0 AND rating <= 5),
      ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0
        CHECK (review_count >= 0),
      ADD COLUMN IF NOT EXISTS data_kind TEXT NOT NULL DEFAULT 'demo';

    ALTER TABLE wash_stores
      DROP CONSTRAINT IF EXISTS wash_stores_data_kind_check;
    ALTER TABLE wash_stores
      ADD CONSTRAINT wash_stores_data_kind_check
      CHECK (data_kind IN ('demo', 'real'));

    CREATE TABLE IF NOT EXISTS wash_packages (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      short_description TEXT NOT NULL DEFAULT '',
      service_items_json TEXT NOT NULL DEFAULT '[]',
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wash_store_images (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL REFERENCES wash_stores(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
      is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0, 1)),
      data_kind TEXT NOT NULL DEFAULT 'demo' CHECK (data_kind IN ('demo', 'real')),
      created_at TEXT NOT NULL
    );

    ALTER TABLE wash_store_images
      DROP CONSTRAINT IF EXISTS wash_store_images_data_kind_check;
    ALTER TABLE wash_store_images
      ADD CONSTRAINT wash_store_images_data_kind_check
      CHECK (data_kind IN ('demo', 'real'));

    CREATE TABLE IF NOT EXISTS wash_store_offers (
      store_id TEXT NOT NULL REFERENCES wash_stores(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL REFERENCES wash_packages(id) ON DELETE CASCADE,
      vehicle_category TEXT NOT NULL CHECK (vehicle_category IN ('sedan', 'suv', 'mpv')),
      sale_price_fen INTEGER NOT NULL CHECK (sale_price_fen >= 0),
      list_price_fen INTEGER CHECK (list_price_fen IS NULL OR list_price_fen >= sale_price_fen),
      estimated_settlement_fen INTEGER CHECK (estimated_settlement_fen IS NULL OR estimated_settlement_fen >= 0),
      is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (store_id, package_id, vehicle_category)
    );

    CREATE TABLE IF NOT EXISTS wash_slots (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL REFERENCES wash_stores(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (store_id, date, start_time)
    );

    CREATE TABLE IF NOT EXISTS wash_quote_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
      store_id TEXT NOT NULL REFERENCES wash_stores(id),
      package_id TEXT NOT NULL REFERENCES wash_packages(id),
      slot_id TEXT NOT NULL REFERENCES wash_slots(id),
      vehicle_category TEXT NOT NULL CHECK (vehicle_category IN ('sedan', 'suv', 'mpv', 'suv_mpv')),
      sale_price_fen INTEGER NOT NULL CHECK (sale_price_fen >= 0),
      list_price_fen INTEGER,
      estimated_settlement_fen INTEGER,
      vehicle_snapshot_json TEXT NOT NULL,
      store_snapshot_json TEXT NOT NULL,
      package_snapshot_json TEXT NOT NULL,
      slot_snapshot_json TEXT NOT NULL,
      offer_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wash_orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
      store_id TEXT NOT NULL REFERENCES wash_stores(id),
      package_id TEXT NOT NULL REFERENCES wash_packages(id),
      slot_id TEXT NOT NULL REFERENCES wash_slots(id),
      quote_snapshot_id TEXT NOT NULL UNIQUE REFERENCES wash_quote_snapshots(id),
      vehicle_category TEXT NOT NULL CHECK (vehicle_category IN ('sedan', 'suv', 'mpv', 'suv_mpv')),
      contact_name TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      total_fee_fen INTEGER NOT NULL CHECK (total_fee_fen >= 0),
      estimated_settlement_fen INTEGER,
      status TEXT NOT NULL CHECK (
        status IN ('pending_payment', 'awaiting_redemption', 'redeemed', 'cancelled', 'refunded', 'expired')
      ),
      payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'paid', 'refunded')),
      redemption_code TEXT UNIQUE,
      notes TEXT,
      internal_note TEXT,
      appointment_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      vehicle_snapshot_json TEXT NOT NULL,
      store_snapshot_json TEXT NOT NULL,
      package_snapshot_json TEXT NOT NULL,
      slot_snapshot_json TEXT NOT NULL,
      hold_expires_at TEXT NOT NULL,
      paid_at TEXT,
      redeemed_at TEXT,
      cancelled_at TEXT,
      refunded_at TEXT,
      expired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS wash_order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES wash_orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'operator', 'system')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wash_order_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES wash_orders(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('charge', 'refund')),
      idempotency_key TEXT NOT NULL,
      amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      out_trade_no TEXT,
      UNIQUE (provider, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS wash_order_settlements (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES wash_orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('unsettled', 'settled', 'void')),
      amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
      operator TEXT,
      reason TEXT,
      note TEXT,
      settled_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wash_store_valet_pricing_overrides (
      store_id TEXT PRIMARY KEY REFERENCES wash_stores(id) ON DELETE CASCADE,
      base_fee_fen INTEGER NOT NULL CHECK (base_fee_fen >= 0),
      included_km REAL NOT NULL CHECK (included_km >= 0),
      per_km_fen INTEGER NOT NULL CHECK (per_km_fen >= 0),
      max_radius_km REAL CHECK (max_radius_km IS NULL OR max_radius_km > 0),
      updated_at TEXT NOT NULL
    );

    ALTER TABLE wash_quote_snapshots
      ADD COLUMN IF NOT EXISTS service_mode TEXT NOT NULL DEFAULT 'self_drive'
        CHECK (service_mode IN ('self_drive', 'valet')),
      ADD COLUMN IF NOT EXISTS trip_type TEXT
        CHECK (trip_type IS NULL OR trip_type = 'round_trip_same_address'),
      ADD COLUMN IF NOT EXISTS pickup_address_json TEXT,
      ADD COLUMN IF NOT EXISTS wash_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS valet_fee_fen INTEGER NOT NULL DEFAULT 0 CHECK (valet_fee_fen >= 0),
      ADD COLUMN IF NOT EXISTS total_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS one_way_distance_km REAL,
      ADD COLUMN IF NOT EXISTS round_trip_distance_km REAL,
      ADD COLUMN IF NOT EXISTS billable_distance_km REAL,
      ADD COLUMN IF NOT EXISTS drive_minutes INTEGER,
      ADD COLUMN IF NOT EXISTS distance_source TEXT NOT NULL DEFAULT 'not_calculated',
      ADD COLUMN IF NOT EXISTS distance_basis TEXT NOT NULL DEFAULT 'no_origin',
      ADD COLUMN IF NOT EXISTS quote_extra_km INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS valet_rule_json TEXT,
      ADD COLUMN IF NOT EXISTS fee_breakdown_json TEXT NOT NULL DEFAULT '{}';

    UPDATE wash_quote_snapshots
    SET wash_fee_fen = sale_price_fen
    WHERE wash_fee_fen IS NULL;
    UPDATE wash_quote_snapshots
    SET total_fee_fen = sale_price_fen + valet_fee_fen
    WHERE total_fee_fen IS NULL;
    ALTER TABLE wash_quote_snapshots
      ALTER COLUMN wash_fee_fen SET NOT NULL,
      ALTER COLUMN total_fee_fen SET NOT NULL;

    ALTER TABLE wash_orders
      ADD COLUMN IF NOT EXISTS service_mode TEXT NOT NULL DEFAULT 'self_drive'
        CHECK (service_mode IN ('self_drive', 'valet')),
      ADD COLUMN IF NOT EXISTS trip_type TEXT
        CHECK (trip_type IS NULL OR trip_type = 'round_trip_same_address'),
      ADD COLUMN IF NOT EXISTS pickup_address_json TEXT,
      ADD COLUMN IF NOT EXISTS wash_fee_fen INTEGER,
      ADD COLUMN IF NOT EXISTS valet_fee_fen INTEGER NOT NULL DEFAULT 0 CHECK (valet_fee_fen >= 0),
      ADD COLUMN IF NOT EXISTS one_way_distance_km REAL,
      ADD COLUMN IF NOT EXISTS round_trip_distance_km REAL,
      ADD COLUMN IF NOT EXISTS billable_distance_km REAL,
      ADD COLUMN IF NOT EXISTS drive_minutes INTEGER,
      ADD COLUMN IF NOT EXISTS distance_source TEXT NOT NULL DEFAULT 'not_calculated',
      ADD COLUMN IF NOT EXISTS distance_basis TEXT NOT NULL DEFAULT 'no_origin',
      ADD COLUMN IF NOT EXISTS quote_extra_km INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS valet_rule_json TEXT,
      ADD COLUMN IF NOT EXISTS fee_breakdown_json TEXT NOT NULL DEFAULT '{}';

    UPDATE wash_orders
    SET wash_fee_fen = total_fee_fen
    WHERE wash_fee_fen IS NULL;
    ALTER TABLE wash_orders ALTER COLUMN wash_fee_fen SET NOT NULL;

    -- v2: split the legacy combined SUV/MPV price class. Historical quote/order
    -- rows intentionally keep their frozen category and monetary snapshots.
    ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_wash_vehicle_category_check;
    ALTER TABLE wash_store_offers DROP CONSTRAINT IF EXISTS wash_store_offers_vehicle_category_check;
    ALTER TABLE wash_quote_snapshots DROP CONSTRAINT IF EXISTS wash_quote_snapshots_vehicle_category_check;
    ALTER TABLE wash_orders DROP CONSTRAINT IF EXISTS wash_orders_vehicle_category_check;

    UPDATE vehicles
    SET wash_vehicle_category = CASE
      WHEN UPPER(CONCAT_WS(' ', vehicle_type, model_name, brand_name)) ~ '(MPV|商务|多用途|面包)'
        THEN 'mpv'
      ELSE 'suv'
    END
    WHERE wash_vehicle_category = 'suv_mpv';

    INSERT INTO wash_store_offers (
      store_id, package_id, vehicle_category, sale_price_fen, list_price_fen,
      estimated_settlement_fen, is_available, updated_at
    )
    SELECT store_id, package_id, 'suv', sale_price_fen, list_price_fen,
      estimated_settlement_fen, is_available, updated_at
    FROM wash_store_offers
    WHERE vehicle_category = 'suv_mpv'
    ON CONFLICT (store_id, package_id, vehicle_category) DO NOTHING;

    INSERT INTO wash_store_offers (
      store_id, package_id, vehicle_category, sale_price_fen, list_price_fen,
      estimated_settlement_fen, is_available, updated_at
    )
    SELECT store_id, package_id, 'mpv', sale_price_fen, list_price_fen,
      estimated_settlement_fen, is_available, updated_at
    FROM wash_store_offers
    WHERE vehicle_category = 'suv_mpv'
    ON CONFLICT (store_id, package_id, vehicle_category) DO NOTHING;

    DELETE FROM wash_store_offers WHERE vehicle_category = 'suv_mpv';

    ALTER TABLE vehicles
      ADD CONSTRAINT vehicles_wash_vehicle_category_check
      CHECK (wash_vehicle_category IS NULL OR wash_vehicle_category IN ('sedan', 'suv', 'mpv'));
    ALTER TABLE wash_store_offers
      ADD CONSTRAINT wash_store_offers_vehicle_category_check
      CHECK (vehicle_category IN ('sedan', 'suv', 'mpv'));
    ALTER TABLE wash_quote_snapshots
      ADD CONSTRAINT wash_quote_snapshots_vehicle_category_check
      CHECK (vehicle_category IN ('sedan', 'suv', 'mpv', 'suv_mpv'));
    ALTER TABLE wash_orders
      ADD CONSTRAINT wash_orders_vehicle_category_check
      CHECK (vehicle_category IN ('sedan', 'suv', 'mpv', 'suv_mpv'));

    CREATE INDEX IF NOT EXISTS wash_stores_active_sort_index
      ON wash_stores(is_active, sort_priority DESC, id);
    CREATE INDEX IF NOT EXISTS wash_store_images_store_sort_index
      ON wash_store_images(store_id, sort_order, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS wash_store_images_one_cover_unique
      ON wash_store_images(store_id) WHERE is_cover = 1;
    CREATE INDEX IF NOT EXISTS wash_offers_store_available_index
      ON wash_store_offers(store_id, is_available, package_id);
    CREATE INDEX IF NOT EXISTS wash_slots_store_date_index
      ON wash_slots(store_id, date, start_time);
    CREATE INDEX IF NOT EXISTS wash_quotes_expiry_index
      ON wash_quote_snapshots(expires_at);
    CREATE INDEX IF NOT EXISTS wash_orders_user_created_index
      ON wash_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS wash_orders_store_date_status_index
      ON wash_orders(store_id, appointment_date, status);
    CREATE INDEX IF NOT EXISTS wash_orders_slot_status_index
      ON wash_orders(slot_id, status, hold_expires_at);
    CREATE INDEX IF NOT EXISTS wash_events_order_created_index
      ON wash_order_events(order_id, created_at);
    CREATE INDEX IF NOT EXISTS wash_payments_order_created_index
      ON wash_order_payments(order_id, created_at);

    ALTER TABLE wash_order_payments ADD COLUMN IF NOT EXISTS out_trade_no TEXT;
    ALTER TABLE wash_order_payments ALTER COLUMN confirmed_at DROP NOT NULL;
    ALTER TABLE wash_order_payments DROP CONSTRAINT IF EXISTS wash_order_payments_status_check;
    ALTER TABLE wash_order_payments
      ADD CONSTRAINT wash_order_payments_status_check
      CHECK (status IN ('pending', 'confirmed'));
    CREATE UNIQUE INDEX IF NOT EXISTS wash_order_payments_out_trade_no_uidx
      ON wash_order_payments(out_trade_no) WHERE out_trade_no IS NOT NULL;
  `);

  await database.transaction(async (tx) => {
    if (await tx.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(WASH_MPV_PRICE_SEED_V2_MARKER)) return;
    const migratedAt = new Date().toISOString();
    await tx.prepare(`
      UPDATE wash_store_offers AS offer
      SET sale_price_fen = CASE
            WHEN offer.package_id = ? THEN 5800
            WHEN offer.package_id = ? THEN 12800
            ELSE offer.sale_price_fen
          END,
          list_price_fen = CASE
            WHEN offer.package_id = ? THEN 6800
            WHEN offer.package_id = ? THEN 14800
            ELSE offer.list_price_fen
          END,
          estimated_settlement_fen = CASE
            WHEN offer.package_id = ? THEN 5800
            WHEN offer.package_id = ? THEN 12800
            ELSE offer.estimated_settlement_fen
          END,
          updated_at = ?
      WHERE offer.store_id IN (?, ?, ?)
        AND offer.vehicle_category = 'mpv'
        AND offer.updated_at = (
          SELECT metadata.updated_at FROM app_metadata AS metadata WHERE metadata.key = ?
        )
        AND (
          (offer.package_id = ?
            AND offer.sale_price_fen = 4800
            AND offer.list_price_fen = 5800
            AND offer.estimated_settlement_fen = 4800)
          OR
          (offer.package_id = ?
            AND offer.sale_price_fen = 10800
            AND offer.list_price_fen = 12800
            AND offer.estimated_settlement_fen = 10800)
        )
    `).run(
      WASH_PACKAGE_IDS.standard,
      WASH_PACKAGE_IDS.detailing,
      WASH_PACKAGE_IDS.standard,
      WASH_PACKAGE_IDS.detailing,
      WASH_PACKAGE_IDS.standard,
      WASH_PACKAGE_IDS.detailing,
      migratedAt,
      WASH_STORE_IDS.haihe,
      WASH_STORE_IDS.aoche,
      WASH_STORE_IDS.jingang,
      WASH_SEED_MARKER,
      WASH_PACKAGE_IDS.standard,
      WASH_PACKAGE_IDS.detailing,
    );
    await tx.prepare(`
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, 'applied', ?)
      ON CONFLICT (key) DO NOTHING
    `).run(WASH_MPV_PRICE_SEED_V2_MARKER, migratedAt);
  });

}

export async function clearWashData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM wash_order_settlements;
    DELETE FROM wash_order_payments;
    DELETE FROM wash_order_events;
    DELETE FROM wash_orders;
    DELETE FROM wash_quote_snapshots;
    DELETE FROM wash_slots;
    DELETE FROM wash_store_offers;
    DELETE FROM wash_store_valet_pricing_overrides;
    DELETE FROM wash_packages;
    DELETE FROM wash_stores;
  `);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function seedWashDemoData(database: AppDatabase, options: WashSeedOptions): Promise<void> {
  const alreadyApplied = Boolean(
    await database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(WASH_SEED_MARKER),
  );
  if (!options.force && alreadyApplied) return;

  const weeklySchedule = JSON.stringify({
    mon: [{ start: "08:00", end: "20:00" }],
    tue: [{ start: "08:00", end: "20:00" }],
    wed: [{ start: "08:00", end: "20:00" }],
    thu: [{ start: "08:00", end: "20:00" }],
    fri: [{ start: "08:00", end: "20:00" }],
    sat: [{ start: "08:00", end: "20:00" }],
    sun: [{ start: "08:00", end: "20:00" }],
  });
  const stores = [
    {
      id: WASH_STORE_IDS.haihe,
      name: "海河焕新洗车工坊（演示）",
      district: "河西区",
      address: "黑牛城道演示服务区 18 号",
      latitude: 39.0797,
      longitude: 117.2167,
      phone: "022-0000-3800",
      description: "提供预约制标准洗车与精致洗护，门店及服务数据均为合成演示。",
      tags: ["预约优先", "休息区", "新能源友好"],
      facilities: ["休息区", "充电位"],
      rating: 4.9,
      reviewCount: 236,
      sortPriority: 30,
    },
    {
      id: WASH_STORE_IDS.aoche,
      name: "奥城清洁站（演示）",
      district: "南开区",
      address: "宾水西道演示停车场 B2 区",
      latitude: 39.0868,
      longitude: 117.1756,
      phone: "022-0000-4800",
      description: "商圈停车场内的预约洗车演示门店。",
      tags: ["商圈停车", "晚间可约"],
      facilities: ["商场休息区"],
      rating: 4.8,
      reviewCount: 168,
      sortPriority: 20,
    },
    {
      id: WASH_STORE_IDS.jingang,
      name: "津港汽车洗护中心（演示）",
      district: "滨海新区",
      address: "第二大街演示园区 66 号",
      latitude: 39.0229,
      longitude: 117.7048,
      phone: "022-0000-1080",
      description: "面向滨海车主的合成演示洗护门店。",
      tags: ["宽敞工位", "SUV 友好"],
      facilities: ["室内等候区"],
      rating: 4.7,
      reviewCount: 92,
      sortPriority: 10,
    },
  ];
  const insertStore = database.prepare(`
    INSERT INTO wash_stores (
      id, name, district, address, latitude, longitude, phone, cover_image_url,
      description, tags_json, facilities_json, open_hours, weekly_schedule_json,
      business_hours_notice, advance_booking_days, rating, review_count, data_kind,
      is_active, sort_priority, internal_contact_name, internal_contact_phone,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '08:00-20:00', ?, ?, 14, ?, ?, 'demo', 1, ?, NULL, NULL, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  for (const store of stores) {
    await insertStore.run(
      store.id,
      store.name,
      store.district,
      store.address,
      store.latitude,
      store.longitude,
      store.phone,
      store.description,
      JSON.stringify(store.tags),
      JSON.stringify(store.facilities),
      weeklySchedule,
      "实际营业时间以门店预约时段为准；当前为合成演示数据。",
      store.rating,
      store.reviewCount,
      store.sortPriority,
      options.now,
      options.now,
    );
  }

  const insertPackage = database.prepare(`
    INSERT INTO wash_packages (
      id, code, name, short_description, service_items_json,
      duration_minutes, sort_order, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  await insertPackage.run(
    WASH_PACKAGE_IDS.standard,
    "standard_wash",
    "标准洗车",
    "日常外观清洁，流程清楚、用时可控",
    JSON.stringify(["车身预冲", "泡沫清洗", "轮毂清洁", "擦干收水", "脚垫吸尘"]),
    45,
    10,
    options.now,
    options.now,
  );
  await insertPackage.run(
    WASH_PACKAGE_IDS.detailing,
    "detailing_wash",
    "精致洗护",
    "加强外观细节与基础内饰清洁",
    JSON.stringify(["标准洗车全流程", "缝隙细节清洁", "玻璃清洁", "内饰吸尘", "轮胎护理"]),
    60,
    20,
    options.now,
    options.now,
  );

  const insertOffer = database.prepare(`
    INSERT INTO wash_store_offers (
      store_id, package_id, vehicle_category, sale_price_fen,
      list_price_fen, estimated_settlement_fen, is_available, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT DO NOTHING
  `);
  for (const store of stores) {
    await insertOffer.run(store.id, WASH_PACKAGE_IDS.standard, "sedan", 3800, 4800, 3800, options.now);
    await insertOffer.run(store.id, WASH_PACKAGE_IDS.standard, "suv", 4800, 5800, 4800, options.now);
    await insertOffer.run(store.id, WASH_PACKAGE_IDS.standard, "mpv", 5800, 6800, 5800, options.now);
    await insertOffer.run(store.id, WASH_PACKAGE_IDS.detailing, "sedan", 8800, 10800, 8800, options.now);
    await insertOffer.run(store.id, WASH_PACKAGE_IDS.detailing, "suv", 10800, 12800, 10800, options.now);
    await insertOffer.run(store.id, WASH_PACKAGE_IDS.detailing, "mpv", 12800, 14800, 12800, options.now);
  }

  const insertSlot = database.prepare(`
    INSERT INTO wash_slots (
      id, store_id, date, start_time, end_time, capacity,
      is_open, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 4, 1, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  for (const store of stores) {
    for (let offset = 0; offset <= 14; offset += 1) {
      const date = addDays(options.businessDate, offset);
      for (let hour = 9; hour < 18; hour += 1) {
        const start = `${String(hour).padStart(2, "0")}:00`;
        const end = `${String(hour + 1).padStart(2, "0")}:00`;
        await insertSlot.run(
          `wash-slot-${store.id}-${date}-${String(hour).padStart(2, "0")}00`,
          store.id,
          date,
          start,
          end,
          options.now,
          options.now,
        );
      }
    }
  }

  await database.prepare(`
    UPDATE vehicles
    SET wash_vehicle_category = CASE
      WHEN UPPER(vehicle_type) ~ '(MPV|商务|多用途|面包)' THEN 'mpv'
      WHEN UPPER(vehicle_type) LIKE '%SUV%' OR seats >= 7 THEN 'suv'
      ELSE 'sedan'
    END
    WHERE wash_vehicle_category IS NULL
      AND (user_id = 'demo-user' OR user_id LIKE 'operator-user-%')
  `).run();

  await database.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES (?, 'applied', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(WASH_SEED_MARKER, options.now);
}

export function newWashId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
