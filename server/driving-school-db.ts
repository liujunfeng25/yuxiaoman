import { createHash } from "node:crypto";
import type { AppDatabase } from "./database.js";

export const DEMO_DRIVING_SCHOOL_IDS = [
  "driving-school-demo-nankai",
  "driving-school-demo-hexi",
  "driving-school-demo-binhai",
] as const;

export type DrivingSchoolDisclosureInput = {
  schoolId: string;
  schoolName: string;
  recipientName: string;
  dataScope: string[];
  purpose: string;
  retentionText: string;
  consentText: string;
  contactEtaText: string;
};

export function computeDrivingSchoolDisclosureVersion(input: DrivingSchoolDisclosureInput): string {
  return `driving-school-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16)}`;
}

export async function migrateDrivingSchoolDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS driving_license_classes (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vehicle_scope TEXT NOT NULL,
      initial_allowed INTEGER NOT NULL CHECK (initial_allowed IN (0, 1)),
      upgrade_allowed INTEGER NOT NULL CHECK (upgrade_allowed IN (0, 1)),
      conditions_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS driving_schools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      legal_name TEXT,
      description TEXT NOT NULL DEFAULT '',
      data_kind TEXT NOT NULL CHECK (data_kind IN ('demo', 'real')),
      district TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      map_poi_id TEXT NOT NULL,
      location_title TEXT NOT NULL,
      location_source TEXT NOT NULL CHECK (location_source IN ('tencent', 'wechat', 'demo')),
      public_phone TEXT,
      internal_contact_name TEXT,
      internal_contact_phone TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      facilities_json TEXT NOT NULL DEFAULT '[]',
      open_hours TEXT NOT NULL DEFAULT '',
      weekly_schedule_json TEXT NOT NULL DEFAULT '{}',
      regulatory_type TEXT NOT NULL CHECK (regulatory_type IN ('filing', 'legacy_license')),
      regulatory_number TEXT NOT NULL,
      regulatory_authority TEXT NOT NULL,
      regulatory_source_url TEXT,
      regulatory_source_label TEXT NOT NULL,
      regulatory_valid_from TEXT,
      regulatory_valid_until TEXT,
      regulatory_verified_at TEXT,
      regulatory_status TEXT NOT NULL CHECK (
        regulatory_status IN ('pending', 'verified', 'rejected', 'expired', 'demo')
      ),
      capability_level TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
      sort_priority INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS driving_schools_public_index
      ON driving_schools(is_published, is_active, sort_priority DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS driving_schools_district_index
      ON driving_schools(district, is_published, is_active);

    CREATE TABLE IF NOT EXISTS driving_school_images (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES driving_schools(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      alt_text TEXT NOT NULL DEFAULT '',
      is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS driving_school_cover_image_unique
      ON driving_school_images(school_id) WHERE is_cover = 1;

    CREATE TABLE IF NOT EXISTS driving_school_training_classes (
      school_id TEXT NOT NULL REFERENCES driving_schools(id) ON DELETE CASCADE,
      license_class_code TEXT NOT NULL REFERENCES driving_license_classes(code),
      initial_available INTEGER NOT NULL DEFAULT 0 CHECK (initial_available IN (0, 1)),
      upgrade_available INTEGER NOT NULL DEFAULT 0 CHECK (upgrade_available IN (0, 1)),
      training_capability_level TEXT,
      training_capability_note TEXT,
      conditions_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (school_id, license_class_code),
      CHECK (initial_available = 1 OR upgrade_available = 1)
    );
    CREATE INDEX IF NOT EXISTS driving_school_training_class_filter_index
      ON driving_school_training_classes(license_class_code, is_active, initial_available, upgrade_available);

    CREATE TABLE IF NOT EXISTS driving_school_offers (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES driving_schools(id) ON DELETE CASCADE,
      license_class_code TEXT NOT NULL REFERENCES driving_license_classes(code),
      name TEXT NOT NULL,
      price_type TEXT NOT NULL CHECK (price_type IN ('fixed', 'starting_from', 'range', 'inquiry')),
      min_price_fen INTEGER CHECK (min_price_fen IS NULL OR min_price_fen >= 0),
      max_price_fen INTEGER CHECK (max_price_fen IS NULL OR max_price_fen >= 0),
      application_modes_json TEXT NOT NULL DEFAULT '[]',
      unit TEXT NOT NULL DEFAULT '人/期',
      included_items_json TEXT NOT NULL DEFAULT '[]',
      excluded_items_json TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      valid_from TEXT,
      valid_until TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (price_type = 'fixed' AND min_price_fen IS NOT NULL AND max_price_fen = min_price_fen)
        OR (price_type = 'starting_from' AND min_price_fen IS NOT NULL AND max_price_fen IS NULL)
        OR (price_type = 'range' AND min_price_fen IS NOT NULL AND max_price_fen IS NOT NULL AND max_price_fen >= min_price_fen)
        OR (price_type = 'inquiry' AND min_price_fen IS NULL AND max_price_fen IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS driving_school_offer_public_index
      ON driving_school_offers(school_id, is_active, valid_until, min_price_fen);

    CREATE TABLE IF NOT EXISTS driving_school_inquiry_recipients (
      school_id TEXT PRIMARY KEY REFERENCES driving_schools(id) ON DELETE CASCADE,
      recipient_name TEXT NOT NULL,
      data_scope_json TEXT NOT NULL,
      purpose TEXT NOT NULL,
      retention_text TEXT NOT NULL,
      consent_text TEXT NOT NULL,
      contact_eta_text TEXT NOT NULL,
      disclosure_version TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 1 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS driving_school_inquiries (
      id TEXT PRIMARY KEY,
      inquiry_code TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      school_id TEXT NOT NULL REFERENCES driving_schools(id),
      license_class_code TEXT NOT NULL REFERENCES driving_license_classes(code),
      offer_id TEXT REFERENCES driving_school_offers(id) ON DELETE SET NULL,
      application_mode TEXT NOT NULL CHECK (application_mode IN ('initial', 'upgrade')),
      status TEXT NOT NULL CHECK (status IN ('new', 'contacting', 'resolved', 'closed', 'withdrawn')),
      source TEXT NOT NULL CHECK (source = 'wechat-owner-services'),
      contact_ciphertext TEXT,
      phone_hmac TEXT,
      contact_name_masked TEXT,
      masked_phone TEXT,
      contact_window TEXT NOT NULL CHECK (contact_window IN ('morning', 'afternoon', 'evening', 'anytime')),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT,
      withdraw_token_hash TEXT NOT NULL UNIQUE,
      disclosure_version TEXT NOT NULL,
      consent_snapshot_json TEXT NOT NULL,
      school_snapshot_json TEXT NOT NULL,
      recipient_school_id TEXT NOT NULL REFERENCES driving_school_inquiry_recipients(school_id),
      internal_note TEXT,
      is_synthetic INTEGER NOT NULL DEFAULT 1 CHECK (is_synthetic IN (0, 1)),
      submitted_at TEXT NOT NULL,
      contacting_at TEXT,
      resolved_at TEXT,
      closed_at TEXT,
      withdrawn_at TEXT,
      pii_delete_after TEXT,
      pii_purged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS driving_school_inquiry_recent_dedup_index
      ON driving_school_inquiries(user_id, school_id, license_class_code, phone_hmac, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS driving_school_inquiry_admin_index
      ON driving_school_inquiries(status, submitted_at DESC);

    CREATE TABLE IF NOT EXISTS driving_school_inquiry_events (
      id TEXT PRIMARY KEY,
      inquiry_id TEXT NOT NULL REFERENCES driving_school_inquiries(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'admin', 'system')),
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      delete_after TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS driving_school_inquiry_event_index
      ON driving_school_inquiry_events(inquiry_id, created_at ASC);
  `);
  await database.execute(`
    ALTER TABLE driving_school_training_classes
      ADD COLUMN IF NOT EXISTS training_capability_note TEXT;

    -- Earlier admin builds stored a free-form school note in the field that was
    -- originally named as a per-class "level". Preserve only those free-form
    -- values as notes. Legacy level_1/2/3 values are institution-level concepts
    -- and intentionally remain outside the new note field.
    UPDATE driving_school_training_classes
    SET training_capability_note = COALESCE(training_capability_note, training_capability_level),
        training_capability_level = NULL
    WHERE training_capability_level IS NOT NULL
      AND training_capability_level NOT IN ('level_1', 'level_2', 'level_3');

    ALTER TABLE driving_school_inquiries ALTER COLUMN contact_name_masked DROP NOT NULL;
    ALTER TABLE driving_school_inquiries ALTER COLUMN masked_phone DROP NOT NULL;
    ALTER TABLE driving_school_inquiries ALTER COLUMN request_hash DROP NOT NULL;

    -- Legacy request hashes were unsalted SHA-256 values. They cannot safely be
    -- retained or compared after the HMAC migration, so keep the idempotency
    -- receipt but mark its historical request body as unverifiable.
    UPDATE driving_school_inquiries
    SET request_hash = NULL
    WHERE request_hash IS NOT NULL AND request_hash NOT LIKE 'hmac-v1:%';
  `);
}

type LicenseClassSeed = [string, string, string, boolean, boolean, string[]];

const LICENSE_CLASSES: LicenseClassSeed[] = [
  ["A1", "大型客车", "大型载客汽车", false, true, ["须通过符合现行规定的增驾路径取得；年龄、驾龄和记分条件以办理时规则为准"]],
  ["A2", "重型牵引挂车", "重型、中型全挂/半挂汽车列车", false, true, ["须通过符合现行规定的增驾路径取得；年龄、驾龄和记分条件以办理时规则为准"]],
  ["A3", "城市公交车", "核载 10 人以上的城市公共汽车", true, true, ["报名年龄、身体条件及实习期限制以办理时规则为准"]],
  ["B1", "中型客车", "中型载客汽车", false, true, ["须通过符合现行规定的增驾路径取得；驾龄和记分条件以办理时规则为准"]],
  ["B2", "大型货车", "重型、中型载货汽车及专项作业车", true, true, ["报名年龄和身体条件以办理时规则为准"]],
  ["C1", "小型汽车", "小型、微型载客汽车及轻型、微型载货汽车", true, true, ["可初次申领；身体条件以办理时规则为准"]],
  ["C2", "小型自动挡汽车", "小型、微型自动挡载客汽车及轻型、微型自动挡载货汽车", true, true, ["可初次申领；身体条件以办理时规则为准"]],
  ["C3", "低速载货汽车", "低速载货汽车", true, true, ["可初次申领；身体条件以办理时规则为准"]],
  ["C4", "三轮汽车", "三轮汽车", true, true, ["可初次申领；身体条件以办理时规则为准"]],
  ["C5", "残疾人专用小型自动挡载客汽车", "符合规定的残疾人专用小型、微型自动挡载客汽车", true, true, ["须符合相应身体条件并按规定完成体检"]],
  ["C6", "轻型牵引挂车", "总质量小于（不包含等于）4500kg 的汽车列车", false, true, ["仅可通过增驾取得", "已取得 C1 或 C2 准驾车型资格满一年，并满足本记分周期和申请前最近一个记分周期无满分记录等现行条件"]],
  ["D", "普通三轮摩托车", "发动机排量大于 50ml 或最高设计车速大于 50km/h 的三轮摩托车", true, true, ["报名年龄和身体条件以办理时规则为准"]],
  ["E", "普通二轮摩托车", "发动机排量大于 50ml 或最高设计车速大于 50km/h 的二轮摩托车", true, true, ["报名年龄和身体条件以办理时规则为准"]],
  ["F", "轻便摩托车", "发动机排量小于等于 50ml 且最高设计车速小于等于 50km/h 的摩托车", true, true, ["报名年龄和身体条件以办理时规则为准"]],
  ["M", "轮式专用机械车", "轮式专用机械车", true, true, ["培训供给较少，请先向机构确认当地受理与培训安排"]],
  ["N", "无轨电车", "无轨电车", true, true, ["培训供给较少，请先向机构确认当地受理与培训安排"]],
  ["P", "有轨电车", "有轨电车", true, true, ["培训供给较少，请先向机构确认当地受理与培训安排"]],
];

async function seedLicenseClasses(database: AppDatabase, now: string): Promise<void> {
  for (const [code, name, scope, initial, upgrade, conditions] of LICENSE_CLASSES) {
    await database.prepare(`
      INSERT INTO driving_license_classes (
        code, name, vehicle_scope, initial_allowed, upgrade_allowed, conditions_json,
        sort_order, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (code) DO UPDATE SET
        name = excluded.name, vehicle_scope = excluded.vehicle_scope,
        initial_allowed = excluded.initial_allowed, upgrade_allowed = excluded.upgrade_allowed,
        conditions_json = excluded.conditions_json, sort_order = excluded.sort_order,
        is_active = 1, updated_at = excluded.updated_at
    `).run(
      code, name, scope, initial ? 1 : 0, upgrade ? 1 : 0,
      JSON.stringify(conditions), LICENSE_CLASSES.findIndex((item) => item[0] === code) * 10 + 10,
      now, now,
    );
  }
}

type DemoSchoolSeed = {
  id: string;
  name: string;
  district: string;
  address: string;
  latitude: number;
  longitude: number;
  phone: string;
  tags: string[];
  facilities: string[];
  classes: Array<[string, boolean, boolean]>;
  prices: Array<[string, string, string, number | null, number | null, string[]]>;
};

const DEMO_SCHOOLS: DemoSchoolSeed[] = [
  {
    id: DEMO_DRIVING_SCHOOL_IDS[0], name: "津城启程驾校（演示）", district: "南开区",
    address: "红旗南路 100 号附近（演示地址）", latitude: 39.0916, longitude: 117.1554,
    phone: "022-0000-6101", tags: ["C1/C2/C6", "周末班", "演示数据"],
    facilities: ["模拟训练室（演示）", "学员休息区（演示）"],
    classes: [["C1", true, true], ["C2", true, true], ["C6", false, true]],
    prices: [
      ["C1", "C1 常规班（演示）", "fixed", 398000, 398000, ["initial"]],
      ["C2", "C2 预约计时班（演示）", "starting_from", 428000, null, ["initial", "upgrade"]],
      ["C6", "C6 增驾咨询（演示）", "inquiry", null, null, ["upgrade"]],
    ],
  },
  {
    id: DEMO_DRIVING_SCHOOL_IDS[1], name: "海河安心驾校（演示）", district: "河西区",
    address: "解放南路 200 号附近（演示地址）", latitude: 39.0462, longitude: 117.2241,
    phone: "022-0000-6102", tags: ["A3/B2", "大车培训咨询", "演示数据"],
    facilities: ["室内报名区（演示）", "基础训练场（演示）"],
    classes: [["A3", true, true], ["B2", true, true]],
    prices: [
      ["A3", "A3 城市公交培训（演示）", "range", 868000, 988000, ["initial", "upgrade"]],
      ["B2", "B2 大型货车培训（演示）", "starting_from", 798000, null, ["initial", "upgrade"]],
    ],
  },
  {
    id: DEMO_DRIVING_SCHOOL_IDS[2], name: "滨海新程驾校（演示）", district: "滨海新区",
    address: "第五大街 88 号附近（演示地址）", latitude: 39.0377, longitude: 117.7008,
    phone: "022-0000-6103", tags: ["D/E/F", "摩托车培训咨询", "演示数据"],
    facilities: ["综合训练场（演示）", "理论学习区（演示）"],
    classes: [["D", true, true], ["E", true, true], ["F", true, true]],
    prices: [
      ["D", "D 照培训（演示）", "fixed", 118000, 118000, ["initial", "upgrade"]],
      ["E", "E 照培训（演示）", "starting_from", 88000, null, ["initial", "upgrade"]],
      ["F", "F 照培训咨询（演示）", "inquiry", null, null, ["initial", "upgrade"]],
    ],
  },
];

export async function seedDrivingSchoolDemoData(database: AppDatabase, now = new Date().toISOString()): Promise<void> {
  await seedLicenseClasses(database, now);
  for (let index = 0; index < DEMO_SCHOOLS.length; index += 1) {
    const school = DEMO_SCHOOLS[index];
    const capabilityLevel = school.classes.length >= 3 ? "level_1" : school.classes.length === 2 ? "level_2" : "level_3";
    await database.prepare(`
      INSERT INTO driving_schools (
        id, name, legal_name, description, data_kind, district, address, latitude,
        longitude, map_poi_id, location_title, location_source, public_phone,
        tags_json, facilities_json, open_hours, weekly_schedule_json,
        regulatory_type, regulatory_number, regulatory_authority,
        regulatory_source_url, regulatory_source_label, regulatory_valid_from,
        regulatory_valid_until, regulatory_verified_at, regulatory_status,
        capability_level, is_active, is_published, sort_priority, published_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'demo', ?, ?, ?, ?, ?, ?, 'demo', ?, ?, ?, ?, ?,
        'filing', ?, ?, NULL, ?, NULL, NULL, NULL, 'demo', ?, 1, 1, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        tags_json = excluded.tags_json,
        capability_level = excluded.capability_level,
        updated_at = excluded.updated_at
    `).run(
      school.id, school.name, `${school.name}虚构主体`,
      "本页面为功能演示，机构、场地、资质与价格均为合成数据，不代表真实驾校或监管备案。",
      school.district, school.address, school.latitude, school.longitude,
      `demo-poi-${index + 1}`, school.name, school.phone,
      JSON.stringify(school.tags), JSON.stringify(school.facilities), "08:00-18:00（演示）",
      JSON.stringify({ mon: [{ start: "08:00", end: "18:00" }], sat: [{ start: "08:00", end: "17:00" }] }),
      `DEMO-FILING-${index + 1}`, "演示字段占位（非真实监管机关）", "演示备案资料（非真实核验）",
      capabilityLevel, 300 - index * 10, now, now, now,
    );

    const recipient = {
      schoolId: school.id,
      schoolName: school.name,
      recipientName: "驭小满驾校服务团队",
      dataScope: ["联系人姓名", "手机号", "意向准驾车型", "联系时段", "咨询备注（如填写）"],
      purpose: "仅由驭小满平台内部了解报名意向并跟进咨询，不向驾校或其他第三方转交",
      retentionText: "线索解决、关闭或撤回后 180 天清除联系资料；审计事件保留 365 天",
      consentText: "我已阅读并同意由驭小满驾校服务团队在平台内部处理上述合成演示资料，用于本次咨询；资料不会转交驾校。",
      contactEtaText: "演示咨询人员预计 1 个工作日内联系（不会真实外呼）",
    };
    await database.prepare(`
      INSERT INTO driving_school_inquiry_recipients (
        school_id, recipient_name, data_scope_json, purpose, retention_text,
        consent_text, contact_eta_text, disclosure_version, is_active, is_synthetic,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
      ON CONFLICT (school_id) DO NOTHING
    `).run(
      school.id, recipient.recipientName, JSON.stringify(recipient.dataScope), recipient.purpose,
      recipient.retentionText, recipient.consentText, recipient.contactEtaText,
      computeDrivingSchoolDisclosureVersion(recipient), now, now,
    );

    await database.prepare(`
      INSERT INTO driving_school_images (
        id, school_id, image_url, alt_text, is_cover, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(
      `${school.id}-image-cover`, school.id,
      `/assets/driving-schools/${["c-class.webp", "large-vehicle.webp", "motorcycle.webp"][index]}`,
      `${school.name}合成演示配图`, now, now,
    );

    for (const [code, initial, upgrade] of school.classes) {
      await database.prepare(`
        INSERT INTO driving_school_training_classes (
          school_id, license_class_code, initial_available, upgrade_available,
          training_capability_level, training_capability_note, conditions_json,
          is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, '[]', 1, ?, ?)
        ON CONFLICT (school_id, license_class_code) DO UPDATE SET
          initial_available = excluded.initial_available,
          upgrade_available = excluded.upgrade_available,
          training_capability_level = NULL,
          is_active = excluded.is_active,
          updated_at = excluded.updated_at
      `).run(school.id, code, initial ? 1 : 0, upgrade ? 1 : 0, now, now);
    }

    for (let priceIndex = 0; priceIndex < school.prices.length; priceIndex += 1) {
      const [code, name, type, min, max, modes] = school.prices[priceIndex];
      await database.prepare(`
        INSERT INTO driving_school_offers (
          id, school_id, license_class_code, name, price_type, min_price_fen,
          max_price_fen, application_modes_json, unit, included_items_json,
          excluded_items_json, description, valid_from, valid_until, is_active,
          sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '人/期', ?, ?, ?, NULL, NULL, 1, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING
      `).run(
        `${school.id}-offer-${priceIndex + 1}`, school.id, code, name, type, min, max,
        JSON.stringify(modes), JSON.stringify(["培训服务（演示）", "基础学习资料（演示）"]),
        JSON.stringify(["体检及考试部门收取的费用", "补考或额外训练费用"]),
        "价格为合成演示信息，具体组成以咨询说明为准。", priceIndex * 10, now, now,
      );
    }
  }
}

export async function clearDrivingSchoolData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM driving_school_inquiry_events;
    DELETE FROM driving_school_inquiries;
    DELETE FROM driving_school_inquiry_recipients;
    DELETE FROM driving_school_offers;
    DELETE FROM driving_school_training_classes;
    DELETE FROM driving_school_images;
    DELETE FROM driving_schools;
  `);
}
