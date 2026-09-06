import type { AppDatabase } from "./database.js";

export const REPAIR_SEED_MARKER = "repair-seed-v1";

export const DEMO_REPAIR_SHOPS = [
  {
    id: "shop-jincheng-bodypaint",
    name: "津城钣喷中心（演示）",
    district: "河西区",
    address: "天津市河西区黑牛城道 188 号（合成演示地址）",
    distanceKm: 3.2,
    rating: 4.8,
    basePriceFen: 168000,
    quoteNote: "钣金修复+喷漆，使用原厂漆，质保1年",
    contactName: "刘师傅（演示）",
    contactPhone: "13800006101",
    openHours: "09:00-18:00（演示）",
    sortOrder: 10,
  },
  {
    id: "shop-haihe-auto",
    name: "海河汽车服务（演示）",
    district: "河东区",
    address: "天津市河东区成林道 66 号（合成演示地址）",
    distanceKm: 4.6,
    rating: 4.6,
    basePriceFen: 198000,
    quoteNote: "钣金修复+喷漆，标准工艺，质保1年",
    contactName: "张师傅（演示）",
    contactPhone: "13800006102",
    openHours: "08:30-18:30（演示）",
    sortOrder: 20,
  },
  {
    id: "shop-landun-repair",
    name: "蓝盾精修工坊（演示）",
    district: "南开区",
    address: "天津市南开区红旗南路 218 号（合成演示地址）",
    distanceKm: 5.1,
    rating: 4.5,
    basePriceFen: 235000,
    quoteNote: "钣金修复+喷漆，进口漆料，质保1年",
    contactName: "王师傅（演示）",
    contactPhone: "13800006103",
    openHours: "09:00-19:00（演示）",
    sortOrder: 30,
  },
] as const;

export async function migrateRepairDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS repair_shops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      district TEXT NOT NULL,
      address TEXT NOT NULL,
      distance_km REAL NOT NULL CHECK (distance_km >= 0),
      rating REAL NOT NULL CHECK (rating BETWEEN 0 AND 5),
      base_price_fen INTEGER NOT NULL CHECK (base_price_fen > 0),
      quote_note TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      open_hours TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0, 1)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repair_requests (
      id TEXT PRIMARY KEY,
      request_no TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      source_report_id TEXT NOT NULL,
      source_booking_id TEXT NOT NULL,
      source_vehicle_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
      vehicle_snapshot_json TEXT NOT NULL,
      report_snapshot_json TEXT NOT NULL,
      synthetic_owner_contact_json TEXT NOT NULL,
      selected_quote_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT,
      cancelled_at TEXT,
      UNIQUE (source_report_id)
    );

    CREATE TABLE IF NOT EXISTS repair_request_faults (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
      source_fault_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
      view_id TEXT NOT NULL,
      region_code TEXT NOT NULL,
      fault_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (request_id, source_fault_id),
      UNIQUE (request_id, sequence_no),
      UNIQUE (request_id, id)
    );

    CREATE TABLE IF NOT EXISTS repair_request_media (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
      fault_id TEXT,
      source_media_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      sequence_no INTEGER,
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (request_id, source_media_id),
      CONSTRAINT repair_request_media_fault_fk
        FOREIGN KEY (request_id, fault_id)
        REFERENCES repair_request_faults(request_id, id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repair_quotes (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES repair_requests(id) ON DELETE RESTRICT,
      shop_id TEXT NOT NULL REFERENCES repair_shops(id) ON DELETE RESTRICT,
      total_price_fen INTEGER NOT NULL CHECK (total_price_fen > 0),
      note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 200),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'selected', 'lost')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      withdrawn_at TEXT,
      selected_at TEXT,
      UNIQUE (request_id, shop_id),
      UNIQUE (request_id, id)
    );

    CREATE TABLE IF NOT EXISTS repair_orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL UNIQUE REFERENCES repair_requests(id) ON DELETE RESTRICT,
      quote_id TEXT NOT NULL UNIQUE REFERENCES repair_quotes(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      shop_id TEXT NOT NULL REFERENCES repair_shops(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'paid' CHECK (status = 'paid'),
      total_price_fen INTEGER NOT NULL CHECK (total_price_fen > 0),
      request_snapshot_json TEXT NOT NULL,
      quote_snapshot_json TEXT NOT NULL,
      shop_snapshot_json TEXT NOT NULL,
      owner_contact_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      paid_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repair_mock_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES repair_orders(id) ON DELETE RESTRICT,
      request_id TEXT NOT NULL UNIQUE REFERENCES repair_requests(id) ON DELETE RESTRICT,
      quote_id TEXT NOT NULL REFERENCES repair_quotes(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      provider TEXT NOT NULL DEFAULT 'mock' CHECK (provider = 'mock'),
      idempotency_key TEXT NOT NULL,
      amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status = 'confirmed'),
      created_at TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS repair_requests_owner_index
      ON repair_requests(user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS repair_requests_lobby_index
      ON repair_requests(status, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS repair_request_faults_request_index
      ON repair_request_faults(request_id, sequence_no);
    CREATE INDEX IF NOT EXISTS repair_request_media_request_index
      ON repair_request_media(request_id, kind, sequence_no, id);
    CREATE INDEX IF NOT EXISTS repair_quotes_request_index
      ON repair_quotes(request_id, status, total_price_fen, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS repair_quotes_one_active_per_shop
      ON repair_quotes(request_id, shop_id)
      WHERE status = 'active';
    ALTER TABLE repair_requests ALTER COLUMN source_report_id DROP NOT NULL;
    ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'report';
    ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS source_precheck_version INTEGER;
    ALTER TABLE repair_request_faults ALTER COLUMN source_fault_id DROP NOT NULL;
    ALTER TABLE repair_request_faults ADD COLUMN IF NOT EXISTS precheck_reason_code TEXT;
    ALTER TABLE repair_request_media ALTER COLUMN source_media_id DROP NOT NULL;
    ALTER TABLE repair_request_media ADD COLUMN IF NOT EXISTS precheck_media_id TEXT REFERENCES booking_media(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS repair_precheck_media_unique ON repair_request_media(request_id, precheck_media_id);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repair_request_source_kind_check' AND conrelid = 'repair_requests'::regclass) THEN
        ALTER TABLE repair_requests ADD CONSTRAINT repair_request_source_kind_check CHECK (
          (source_type = 'report' AND source_report_id IS NOT NULL) OR
          (source_type = 'precheck' AND source_report_id IS NULL AND source_precheck_version IS NOT NULL));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repair_fault_source_kind_check' AND conrelid = 'repair_request_faults'::regclass) THEN
        ALTER TABLE repair_request_faults ADD CONSTRAINT repair_fault_source_kind_check CHECK (
          (source_fault_id IS NOT NULL AND precheck_reason_code IS NULL) OR
          (source_fault_id IS NULL AND precheck_reason_code IS NOT NULL AND precheck_reason_code IN ('body_damage', 'dashboard_warning')));
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS repair_precheck_active_request
      ON repair_requests(source_booking_id) WHERE source_type = 'precheck' AND status IN ('open', 'paid');
  `);
}

export async function clearRepairData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM repair_mock_payments;
    DELETE FROM repair_orders;
    DELETE FROM repair_quotes;
    DELETE FROM repair_request_media;
    DELETE FROM repair_request_faults;
    DELETE FROM repair_requests;
  `);
}

export async function seedRepairDemoData(
  database: AppDatabase,
  now = new Date().toISOString(),
): Promise<void> {
  for (const shop of DEMO_REPAIR_SHOPS) {
    await database.prepare(`
      INSERT INTO repair_shops (
        id, name, district, address, distance_km, rating, base_price_fen,
        quote_note, contact_name, contact_phone, open_hours, is_demo,
        is_active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        district = excluded.district,
        address = excluded.address,
        distance_km = excluded.distance_km,
        rating = excluded.rating,
        base_price_fen = excluded.base_price_fen,
        quote_note = excluded.quote_note,
        contact_name = excluded.contact_name,
        contact_phone = excluded.contact_phone,
        open_hours = excluded.open_hours,
        is_demo = 1,
        is_active = 1,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `).run(
      shop.id,
      shop.name,
      shop.district,
      shop.address,
      shop.distanceKm,
      shop.rating,
      shop.basePriceFen,
      shop.quoteNote,
      shop.contactName,
      shop.contactPhone,
      shop.openHours,
      shop.sortOrder,
      now,
      now,
    );
  }
  await database.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES (?, 'applied', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(REPAIR_SEED_MARKER, now);
}
