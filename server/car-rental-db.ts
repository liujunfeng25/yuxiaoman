import type { AppDatabase } from "./database.js";

export const CAR_RENTAL_SEED_MARKER = "car-rental-seed-v1";

export async function migrateCarRentalDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS car_rental_brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      logo_url TEXT NOT NULL,
      initial TEXT NOT NULL CHECK (length(initial) BETWEEN 1 AND 2),
      is_hot INTEGER NOT NULL DEFAULT 0 CHECK (is_hot IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_models (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES car_rental_brands(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      cover_image_url TEXT,
      body_type TEXT NOT NULL CHECK (body_type IN ('sedan','suv','mpv','hatchback','coupe','pickup')),
      energy_type TEXT NOT NULL CHECK (energy_type IN ('gasoline','diesel','hybrid','plug_in_hybrid','pure_electric','range_extended')),
      transmission TEXT NOT NULL CHECK (transmission IN ('automatic','manual','cvt','dct','single_speed','e_cvt')),
      seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 20),
      luggage INTEGER NOT NULL DEFAULT 2 CHECK (luggage BETWEEN 0 AND 12),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (brand_id, name)
    );

    CREATE TABLE IF NOT EXISTS car_rental_model_images (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES car_rental_models(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      storage_key TEXT,
      mime_type TEXT NOT NULL DEFAULT 'image/webp',
      size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
      width INTEGER NOT NULL DEFAULT 1 CHECK (width > 0),
      height INTEGER NOT NULL DEFAULT 1 CHECK (height > 0),
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      district TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      open_hours TEXT NOT NULL,
      phone TEXT,
      delivery_base_fee_fen INTEGER NOT NULL DEFAULT 2900 CHECK (delivery_base_fee_fen >= 0),
      delivery_included_km REAL NOT NULL DEFAULT 3 CHECK (delivery_included_km >= 0),
      delivery_per_km_fen INTEGER NOT NULL DEFAULT 600 CHECK (delivery_per_km_fen >= 0),
      delivery_max_radius_km REAL CHECK (delivery_max_radius_km IS NULL OR delivery_max_radius_km > 0),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_vehicles (
      id TEXT PRIMARY KEY,
      stock_no TEXT NOT NULL UNIQUE,
      model_id TEXT NOT NULL REFERENCES car_rental_models(id) ON DELETE RESTRICT,
      store_id TEXT NOT NULL REFERENCES car_rental_stores(id) ON DELETE RESTRICT,
      plate_number TEXT,
      color TEXT NOT NULL,
      model_year INTEGER NOT NULL CHECK (model_year BETWEEN 1990 AND 2100),
      mileage_km INTEGER NOT NULL DEFAULT 0 CHECK (mileage_km >= 0),
      status TEXT NOT NULL CHECK (status IN ('draft','active','maintenance','offline','retired')),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_rate_plans (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES car_rental_models(id) ON DELETE RESTRICT,
      store_id TEXT REFERENCES car_rental_stores(id) ON DELETE RESTRICT,
      weekday_rate_fen INTEGER NOT NULL CHECK (weekday_rate_fen > 0),
      weekend_rate_fen INTEGER NOT NULL CHECK (weekend_rate_fen > 0),
      basic_protection_daily_fen INTEGER NOT NULL DEFAULT 6000 CHECK (basic_protection_daily_fen >= 0),
      prep_fee_fen INTEGER NOT NULL DEFAULT 3500 CHECK (prep_fee_fen >= 0),
      optional_protection_daily_fen INTEGER NOT NULL DEFAULT 6000 CHECK (optional_protection_daily_fen >= 0),
      vehicle_deposit_fen INTEGER NOT NULL CHECK (vehicle_deposit_fen >= 0),
      violation_deposit_fen INTEGER NOT NULL DEFAULT 200000 CHECK (violation_deposit_fen >= 0),
      included_mileage_km_per_day INTEGER CHECK (included_mileage_km_per_day IS NULL OR included_mileage_km_per_day > 0),
      overage_per_km_fen INTEGER NOT NULL DEFAULT 0 CHECK (overage_per_km_fen >= 0),
      fuel_policy TEXT NOT NULL DEFAULT 'same_level_return',
      cancellation_policy TEXT NOT NULL DEFAULT '取车前24小时可免费取消；24小时内取消以订单页规则为准',
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_rate_overrides (
      id TEXT PRIMARY KEY,
      rate_plan_id TEXT NOT NULL REFERENCES car_rental_rate_plans(id) ON DELETE CASCADE,
      date TEXT NOT NULL CHECK (length(date) = 10),
      daily_rate_fen INTEGER CHECK (daily_rate_fen IS NULL OR daily_rate_fen > 0),
      is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (rate_plan_id, date)
    );

    CREATE TABLE IF NOT EXISTS car_rental_policy_versions (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      policy_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_quote_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      model_id TEXT NOT NULL REFERENCES car_rental_models(id),
      store_id TEXT NOT NULL REFERENCES car_rental_stores(id),
      rate_plan_id TEXT NOT NULL REFERENCES car_rental_rate_plans(id),
      service_mode TEXT NOT NULL CHECK (service_mode IN ('store_pickup','home_delivery')),
      pickup_at TEXT NOT NULL,
      return_at TEXT NOT NULL,
      billable_days INTEGER NOT NULL CHECK (billable_days BETWEEN 1 AND 30),
      delivery_address_json TEXT,
      route_json TEXT,
      model_snapshot_json TEXT NOT NULL,
      store_snapshot_json TEXT NOT NULL,
      rates_json TEXT NOT NULL,
      policies_json TEXT NOT NULL,
      rental_fee_fen INTEGER NOT NULL CHECK (rental_fee_fen >= 0),
      basic_protection_fee_fen INTEGER NOT NULL CHECK (basic_protection_fee_fen >= 0),
      prep_fee_fen INTEGER NOT NULL CHECK (prep_fee_fen >= 0),
      optional_protection_fee_fen INTEGER NOT NULL CHECK (optional_protection_fee_fen >= 0),
      delivery_fee_fen INTEGER NOT NULL CHECK (delivery_fee_fen >= 0),
      total_fee_fen INTEGER NOT NULL CHECK (total_fee_fen >= 0),
      vehicle_deposit_fen INTEGER NOT NULL CHECK (vehicle_deposit_fen >= 0),
      violation_deposit_fen INTEGER NOT NULL CHECK (violation_deposit_fen >= 0),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      quote_id TEXT NOT NULL REFERENCES car_rental_quote_snapshots(id),
      model_id TEXT NOT NULL REFERENCES car_rental_models(id),
      store_id TEXT NOT NULL REFERENCES car_rental_stores(id),
      assigned_vehicle_id TEXT REFERENCES car_rental_vehicles(id) ON DELETE RESTRICT,
      service_mode TEXT NOT NULL CHECK (service_mode IN ('store_pickup','home_delivery')),
      pickup_at TEXT NOT NULL,
      return_at TEXT NOT NULL,
      billable_days INTEGER NOT NULL CHECK (billable_days BETWEEN 1 AND 30),
      driver_name TEXT NOT NULL,
      driver_phone TEXT NOT NULL,
      license_confirmed INTEGER NOT NULL CHECK (license_confirmed IN (0, 1)),
      delivery_address_json TEXT,
      route_json TEXT,
      model_snapshot_json TEXT NOT NULL,
      store_snapshot_json TEXT NOT NULL,
      fee_breakdown_json TEXT NOT NULL,
      deposits_json TEXT NOT NULL,
      policies_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','ready_for_pickup','in_use','return_pending','completed','cancelled','expired')),
      idempotency_key TEXT NOT NULL,
      hold_expires_at TEXT,
      paid_at TEXT,
      cancelled_at TEXT,
      completed_at TEXT,
      internal_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS car_rental_order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES car_rental_orders(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT,
      actor_type TEXT NOT NULL,
      actor_name TEXT,
      note TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS car_rental_mock_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES car_rental_orders(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      amount_fen INTEGER NOT NULL CHECK (amount_fen >= 0),
      status TEXT NOT NULL CHECK (status IN ('confirmed','void')),
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      UNIQUE (order_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS car_rental_order_adjustments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES car_rental_orders(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('overtime','fuel_or_charge','cleaning','other')),
      amount_fen INTEGER NOT NULL,
      note TEXT NOT NULL,
      operator TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS car_rental_models_catalog_index ON car_rental_models(brand_id, is_active, sort_order, id);
    CREATE INDEX IF NOT EXISTS car_rental_vehicles_capacity_index ON car_rental_vehicles(store_id, model_id, status, id);
    CREATE INDEX IF NOT EXISTS car_rental_orders_overlap_index ON car_rental_orders(store_id, model_id, pickup_at, return_at, status);
    CREATE INDEX IF NOT EXISTS car_rental_orders_user_index ON car_rental_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS car_rental_events_order_index ON car_rental_order_events(order_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS car_rental_model_images_one_cover_unique ON car_rental_model_images(model_id) WHERE is_cover = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS car_rental_rate_plan_scope_unique ON car_rental_rate_plans(model_id, COALESCE(store_id, ''));

    ALTER TABLE car_rental_model_images ADD COLUMN IF NOT EXISTS storage_key TEXT;
    ALTER TABLE car_rental_model_images ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'image/webp';
    ALTER TABLE car_rental_model_images ADD COLUMN IF NOT EXISTS size_bytes INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE car_rental_model_images ADD COLUMN IF NOT EXISTS width INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE car_rental_model_images ADD COLUMN IF NOT EXISTS height INTEGER NOT NULL DEFAULT 1;
  `);
}

export async function clearCarRentalData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM car_rental_order_adjustments;
    DELETE FROM car_rental_mock_payments;
    DELETE FROM car_rental_order_events;
    DELETE FROM car_rental_orders;
    DELETE FROM car_rental_quote_snapshots;
    DELETE FROM car_rental_rate_overrides;
    DELETE FROM car_rental_rate_plans;
    DELETE FROM car_rental_vehicles;
    DELETE FROM car_rental_stores;
    DELETE FROM car_rental_model_images;
    DELETE FROM car_rental_models;
    DELETE FROM car_rental_brands;
    DELETE FROM car_rental_policy_versions;
  `);
}

const STORE_SEED = [
  { id: "rental-store-hexi", name: "驭小满天津滨海机场店（演示）", district: "东丽区", address: "天津滨海国际机场停车区附近（演示）", latitude: 39.1244, longitude: 117.3462, openHours: "07:00-23:00", phone: "400-000-2026" },
  { id: "rental-store-nankai", name: "驭小满天津南开店（演示）", district: "南开区", address: "天津市南开区水上公园北道附近（演示）", latitude: 39.0878, longitude: 117.1776, openHours: "08:00-21:00", phone: "400-000-2026" },
  { id: "rental-store-hedong", name: "驭小满天津河东店（演示）", district: "河东区", address: "天津市河东区津滨大道附近（演示）", latitude: 39.1171, longitude: 117.2631, openHours: "08:00-21:00", phone: "400-000-2026" },
] as const;

const RENTAL_MODEL_IDS = [
  "model-byd-qin-plus", "model-volkswagen-magotan", "model-tesla-model-3", "model-li-l7",
  "model-honda-odyssey", "model-li-l9", "model-toyota-camry", "model-toyota-highlander",
  "model-tesla-model-y", "model-bmw-3-series", "model-volkswagen-tiguan-l", "model-byd-song-plus",
] as const;

const DAILY_RATES: Record<string, number> = {
  "model-byd-qin-plus": 15_800,
  "model-volkswagen-magotan": 21_800,
  "model-tesla-model-3": 29_800,
  "model-li-l7": 49_800,
  "model-honda-odyssey": 49_800,
  "model-li-l9": 69_800,
  "model-toyota-camry": 26_800,
  "model-toyota-highlander": 52_800,
  "model-tesla-model-y": 39_800,
  "model-bmw-3-series": 43_800,
  "model-volkswagen-tiguan-l": 28_800,
  "model-byd-song-plus": 22_800,
};

function normalizedEnergy(value: string): string {
  if (value === "petrol") return "gasoline";
  if (value === "electric") return "pure_electric";
  return value;
}

export async function seedCarRentalDemoData(
  database: AppDatabase,
  options: { force?: boolean; now?: string } = {},
): Promise<void> {
  const applied = await database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(CAR_RENTAL_SEED_MARKER);
  if (applied && !options.force) return;
  if (options.force) await clearCarRentalData(database);
  const now = options.now ?? "2026-08-22T00:00:00.000Z";

  const sourceBrands = await database.prepare<Record<string, unknown>>(`
    SELECT * FROM used_car_brands ORDER BY sort_order, id
  `).all();
  const sourceModels = await database.prepare<Record<string, unknown>>(`
    SELECT * FROM used_car_models ORDER BY brand_id, sort_order, id
  `).all();
  if (sourceBrands.length !== 15 || sourceModels.length !== 46) {
    throw new Error(`Car-rental seed requires the stable 15-brand/46-model catalog; got ${sourceBrands.length}/${sourceModels.length}`);
  }

  for (const row of sourceBrands) {
    await database.prepare(`
      INSERT INTO car_rental_brands (id,name,logo_url,initial,is_hot,sort_order,is_active,is_synthetic,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,1,?,?)
      ON CONFLICT (id) DO UPDATE SET name=excluded.name,logo_url=excluded.logo_url,initial=excluded.initial,
        is_hot=excluded.is_hot,sort_order=excluded.sort_order,is_active=1,updated_at=excluded.updated_at
    `).run(row.id as string, row.name as string, row.logo_url as string, row.initial as string, Number(row.is_hot), Number(row.sort_order), now, now);
  }
  for (const row of sourceModels) {
    const bodyType = String(row.body_type);
    const seats = bodyType === "mpv" ? 7 : bodyType === "suv" && ["model-li-l8", "model-li-l9", "model-aito-m9"].includes(String(row.id)) ? 6 : 5;
    const transmission = ["petrol", "diesel"].includes(String(row.energy_type)) ? "automatic" : "single_speed";
    await database.prepare(`
      INSERT INTO car_rental_models (id,brand_id,name,cover_image_url,body_type,energy_type,transmission,seats,luggage,sort_order,is_active,is_synthetic,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,1,?,?)
      ON CONFLICT (id) DO UPDATE SET brand_id=excluded.brand_id,name=excluded.name,cover_image_url=excluded.cover_image_url,
        body_type=excluded.body_type,energy_type=excluded.energy_type,transmission=excluded.transmission,seats=excluded.seats,
        luggage=excluded.luggage,sort_order=excluded.sort_order,is_active=1,updated_at=excluded.updated_at
    `).run(row.id as string, row.brand_id as string, row.name as string, row.cover_image_url as string, bodyType,
      normalizedEnergy(String(row.energy_type)), transmission, seats, bodyType === "mpv" ? 4 : 2, Number(row.sort_order), now, now);
    await database.prepare(`
      INSERT INTO car_rental_model_images (id,model_id,image_url,sort_order,is_cover,is_synthetic,created_at)
      VALUES (?,?,?,0,1,1,?) ON CONFLICT (id) DO UPDATE SET image_url=excluded.image_url
    `).run(`rental-image-${String(row.id)}`, row.id as string, row.cover_image_url as string, now);
  }

  for (const [index, store] of STORE_SEED.entries()) {
    await database.prepare(`
      INSERT INTO car_rental_stores (id,name,district,address,latitude,longitude,open_hours,phone,
        delivery_base_fee_fen,delivery_included_km,delivery_per_km_fen,delivery_max_radius_km,sort_order,is_active,is_synthetic,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,2900,3,600,20,?,1,1,?,?)
      ON CONFLICT (id) DO UPDATE SET name=excluded.name,district=excluded.district,address=excluded.address,
        latitude=excluded.latitude,longitude=excluded.longitude,open_hours=excluded.open_hours,phone=excluded.phone,
        is_active=1,updated_at=excluded.updated_at
    `).run(store.id, store.name, store.district, store.address, store.latitude, store.longitude, store.openHours, store.phone, index * 10, now, now);
  }

  const colors = ["珍珠白", "曜石黑", "星空灰", "冰川蓝", "银色", "深海蓝"];
  for (let index = 0; index < 36; index += 1) {
    const status = index < 30 ? "active" : index < 33 ? "maintenance" : index < 35 ? "offline" : "retired";
    const modelId = RENTAL_MODEL_IDS[index % RENTAL_MODEL_IDS.length];
    const storeId = STORE_SEED[index % STORE_SEED.length].id;
    const sequence = String(index + 1).padStart(3, "0");
    await database.prepare(`
      INSERT INTO car_rental_vehicles (id,stock_no,model_id,store_id,plate_number,color,model_year,mileage_km,status,is_synthetic,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT (id) DO UPDATE SET model_id=excluded.model_id,store_id=excluded.store_id,status=excluded.status,updated_at=excluded.updated_at
    `).run(`rental-vehicle-${sequence}`, `YXM-R-${sequence}`, modelId, storeId, `津A${String(20000 + index)}`, colors[index % colors.length],
      2024 + (index % 2), 3200 + index * 731, status, now, now);
  }

  for (const [index, row] of sourceModels.entries()) {
    const modelId = String(row.id);
    const weekday = DAILY_RATES[modelId] ?? Math.min(69_800, 18_800 + index * 900);
    const bodyType = String(row.body_type);
    const deposit = weekday >= 45_000 ? 800_000 : weekday >= 28_000 ? 500_000 : 300_000;
    await database.prepare(`
      INSERT INTO car_rental_rate_plans (id,model_id,store_id,weekday_rate_fen,weekend_rate_fen,
        basic_protection_daily_fen,prep_fee_fen,optional_protection_daily_fen,vehicle_deposit_fen,
        violation_deposit_fen,included_mileage_km_per_day,overage_per_km_fen,fuel_policy,cancellation_policy,is_active,created_at,updated_at)
      VALUES (?,?,NULL,?,?,6000,3500,6000,?,200000,300,100,'same_level_return',
        '取车前24小时可免费取消；24小时内取消以订单页规则为准',1,?,?)
      ON CONFLICT (id) DO UPDATE SET weekday_rate_fen=excluded.weekday_rate_fen,weekend_rate_fen=excluded.weekend_rate_fen,
        vehicle_deposit_fen=excluded.vehicle_deposit_fen,is_active=1,updated_at=excluded.updated_at
    `).run(`rental-rate-${modelId}`, modelId, weekday, Math.ceil(weekday * 1.15), deposit, now, now);
  }

  await database.prepare(`
    INSERT INTO car_rental_policy_versions (id,version,policy_json,is_active,created_at)
    VALUES ('rental-policy-v1','2026.08.22',?,1,?)
    ON CONFLICT (id) DO UPDATE SET policy_json=excluded.policy_json,is_active=1
  `).run(JSON.stringify({
    billing: "每24小时计1天，不足1天向上取整；最少1天，最多30天",
    graceMinutes: 30,
    exactModel: "保证所选车型，车辆颜色以实际交付为准",
    mileage: "默认每日含300公里，超出按价格方案计费",
    fuel: "同油量或同电量归还",
    payment: "演示环境使用模拟支付，不发生真实资金流转",
  }), now);

  await database.prepare(`
    INSERT INTO app_metadata (key,value,updated_at) VALUES (?, 'applied', ?)
    ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `).run(CAR_RENTAL_SEED_MARKER, now);
}
