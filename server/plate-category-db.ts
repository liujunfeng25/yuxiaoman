import type { AppDatabase } from "./database.js";
import { PLATE_CATEGORIES } from "../wechat-miniprogram/miniprogram/utils/plate-categories.js";

const marker = "plate-category-plans-v1";
const legacyGeneratedLabels = new Map([
  ["new_energy_small_truck", "蓝牌（新能源）小型货车"],
  ["new_energy_large_bus", "黄牌（新能源）大型普通客车"],
  ["new_energy_large_tractor", "黄牌（新能源）大型牵引车"],
  ["new_energy_large_truck", "黄牌（新能源）大型货车"],
]);

export async function migratePlateCategories(database: AppDatabase) {
  await database.execute(`
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS plate_category TEXT;
    ALTER TABLE inspection_price_plans ADD COLUMN IF NOT EXISTS plate_categories_json TEXT;
    ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_seats_check;
    ALTER TABLE inspection_price_plans DROP CONSTRAINT IF EXISTS inspection_price_plans_min_seats_check;
    DO $migration$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_seats_check_v2' AND conrelid = 'vehicles'::regclass) THEN
        ALTER TABLE vehicles ADD CONSTRAINT vehicles_seats_check_v2 CHECK (seats BETWEEN 0 AND 99);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_price_plans_min_seats_check_v2' AND conrelid = 'inspection_price_plans'::regclass) THEN
        ALTER TABLE inspection_price_plans ADD CONSTRAINT inspection_price_plans_min_seats_check_v2 CHECK (min_seats >= 0);
      END IF;
    END $migration$;
  `);
  const renamedAt = new Date().toISOString();
  for (const category of PLATE_CATEGORIES) {
    const legacyLabel = legacyGeneratedLabels.get(category.code);
    if (!legacyLabel) continue;
    // Only rename untouched generated rows; preserve every operations-authored name.
    await database.prepare(`UPDATE inspection_price_plans SET name = ?, updated_at = ?
      WHERE id = ? AND name = ?`).run(category.label, renamedAt, `plan-${category.code}`, legacyLabel);
  }
}

/** Adds editable definitions once, with no station support or guessed prices. */
export async function seedPlateCategoryPlans(database: AppDatabase, force = false) {
  if (!force && await database.prepare("SELECT 1 FROM app_metadata WHERE key = ?").get(marker)) return;
  const now = new Date().toISOString();
  for (const [index, category] of PLATE_CATEGORIES.entries()) {
    if (category.vehicleClassCode === "passenger_car") continue;
    const trailer = category.vehicleClassCode === "trailer";
    await database.prepare(`
      INSERT INTO inspection_price_plans (
        id, code, name, description, powertrain_types_json, min_seats, max_seats,
        usage_natures_json, vehicle_class_codes_json, exclude_vans, plate_categories_json,
        inspection_items_json, sort_order, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      `plan-${category.code}`, category.code, category.label,
      "请按实际承检范围配置动力、座位、使用性质和检验项目，再为站点启用并填写价格。",
      JSON.stringify(trailer ? ["gasoline", "diesel", "hybrid", "pure_electric", "phev", "erev", "other", "unknown"] : ["gasoline", "diesel", "hybrid", "pure_electric", "phev", "erev", "other"]),
      trailer ? 0 : 1, 99, JSON.stringify(["非营运", "营运", "货运", "公路客运", "旅游客运", "公交客运"]),
      JSON.stringify([category.vehicleClassCode]), JSON.stringify([category.code]),
      JSON.stringify(["safety_basic"]), 100 + index, now, now,
    );
  }
  await database.prepare(`INSERT INTO app_metadata (key, value, updated_at) VALUES (?, '1', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(marker, now);
}
