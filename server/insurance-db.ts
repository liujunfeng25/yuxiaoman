import { createHash } from "node:crypto";
import type { AppDatabase } from "./database.js";

export const DEMO_INSURANCE_PARTNER_ID = "insurance-demo-partner";

type DisclosureVersionInput = {
  id: string;
  name: string;
  recipientName: string;
  dataScope: string[];
  purpose: string;
  retentionText: string;
  consentText: string;
  contactEtaText: string;
};

export function computeInsuranceDisclosureVersion(partner: DisclosureVersionInput): string {
  return `insurance-${createHash("sha256").update(JSON.stringify({
    partnerId: partner.id,
    partnerName: partner.name,
    recipientName: partner.recipientName,
    dataScope: partner.dataScope,
    purpose: partner.purpose,
    retentionText: partner.retentionText,
    consentText: partner.consentText,
    contactEtaText: partner.contactEtaText,
  })).digest("hex").slice(0, 16)}`;
}

export async function migrateInsuranceDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS service_partners (
      id TEXT PRIMARY KEY,
      service_type TEXT NOT NULL CHECK (service_type = 'insurance'),
      name TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      data_scope_json TEXT NOT NULL,
      purpose TEXT NOT NULL,
      retention_text TEXT NOT NULL,
      consent_text TEXT NOT NULL,
      contact_eta_text TEXT NOT NULL,
      disclosure_version TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      is_synthetic INTEGER NOT NULL DEFAULT 1 CHECK (is_synthetic IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS service_partners_insurance_default_unique
      ON service_partners(service_type)
      WHERE is_default = 1 AND is_active = 1;

    CREATE TABLE IF NOT EXISTS service_leads (
      id TEXT PRIMARY KEY,
      lead_code TEXT NOT NULL UNIQUE,
      service_type TEXT NOT NULL CHECK (service_type = 'insurance'),
      user_id TEXT NOT NULL REFERENCES users(id),
      vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
      vehicle_plate_masked TEXT NOT NULL,
      vehicle_model_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('new', 'handed_off', 'closed', 'withdrawn')),
      source TEXT NOT NULL CHECK (source = 'web-owner-services'),
      contact_ciphertext TEXT,
      phone_hmac TEXT,
      contact_name_masked TEXT NOT NULL,
      masked_phone TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT,
      withdraw_token_hash TEXT NOT NULL UNIQUE,
      disclosure_version TEXT NOT NULL,
      consent_snapshot_json TEXT NOT NULL,
      partner_id TEXT NOT NULL REFERENCES service_partners(id),
      handoff_snapshot_json TEXT,
      is_synthetic INTEGER NOT NULL DEFAULT 1 CHECK (is_synthetic IN (0, 1)),
      submitted_at TEXT NOT NULL,
      handed_off_at TEXT,
      closed_at TEXT,
      withdrawn_at TEXT,
      close_result TEXT CHECK (
        close_result IS NULL OR close_result IN (
          'completed_referral', 'customer_declined', 'unable_to_contact', 'invalid_lead'
        )
      ),
      pii_delete_after TEXT,
      pii_purged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS service_leads_phone_vehicle_recent_index
      ON service_leads(phone_hmac, vehicle_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS service_leads_status_submitted_index
      ON service_leads(status, submitted_at DESC);

    CREATE TABLE IF NOT EXISTS insurance_lead_details (
      lead_id TEXT PRIMARY KEY REFERENCES service_leads(id) ON DELETE CASCADE,
      renewal_window TEXT NOT NULL CHECK (
        renewal_window IN ('within_30_days', 'one_to_three_months', 'over_three_months')
      ),
      contact_window TEXT NOT NULL CHECK (
        contact_window IN ('morning', 'afternoon', 'evening', 'anytime')
      ),
      vehicle_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_lead_media (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL UNIQUE REFERENCES service_leads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind = 'license_photo'),
      storage_key TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      content_hash TEXT NOT NULL,
      delete_after TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS service_lead_media_expiry_index
      ON service_lead_media(delete_after)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS service_lead_events (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES service_leads(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'admin', 'system')),
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      delete_after TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS service_lead_events_lead_created_index
      ON service_lead_events(lead_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS service_lead_events_expiry_index
      ON service_lead_events(delete_after);
  `);
}

function environmentPartner() {
  const id = process.env.INSURANCE_PARTNER_ID?.trim();
  const name = process.env.INSURANCE_PARTNER_NAME?.trim();
  const recipientName = process.env.INSURANCE_PARTNER_RECIPIENT?.trim();
  if (!id || !name || !recipientName) return null;
  const dataScope = (process.env.INSURANCE_PARTNER_DATA_SCOPE ?? "联系人姓名、手机号、车辆档案、续保需求、行驶证照片")
    .split(/[，,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    id,
    name,
    recipientName,
    dataScope,
    purpose: process.env.INSURANCE_PARTNER_PURPOSE?.trim() || "核验续保需求并安排专业服务人员联系",
    retentionText: process.env.INSURANCE_PARTNER_RETENTION?.trim() || "合作方按其已披露规则保存；平台关闭线索后 180 天清除个人信息",
    consentText: process.env.INSURANCE_PARTNER_CONSENT_TEXT?.trim()
      || `我同意驭小满将上述资料提供给${name}（具体接收人：${recipientName}），仅用于续保需求登记与专业服务人员对接。`,
    contactEtaText: process.env.INSURANCE_PARTNER_CONTACT_ETA?.trim() || "专业服务人员将在 1 个工作日内联系",
  };
}

export async function seedInsurancePartner(database: AppDatabase, now = new Date().toISOString()): Promise<void> {
  const configured = environmentPartner();
  const demoPartner = {
    id: DEMO_INSURANCE_PARTNER_ID,
    name: "驭小满保险服务演示专员",
    recipientName: "驭小满保险服务演示团队（非真实保险机构）",
    dataScope: ["合成联系人姓名和手机号", "合成车辆档案", "合成续保需求", "合成行驶证示意图"],
    purpose: "仅用于演示车辆保险需求登记、转交与进度闭环",
    retentionText: "未转交图片 60 天、转交后图片 30 天、关闭后个人信息 180 天、审计记录 1 年",
    consentText: "我已知悉当前为演示模式，仅提交合成演示资料；资料不会转交真实保险机构。",
    contactEtaText: "专业服务人员将在 1 个工作日内联系",
  };
  const existingDefault = await database.prepare<{ id?: string }>(`
    SELECT id FROM service_partners
    WHERE service_type = 'insurance' AND is_active = 1 AND is_default = 1
  `).get();
  const upsert = database.prepare(`
    INSERT INTO service_partners (
      id, service_type, name, recipient_name, data_scope_json, purpose,
      retention_text, consent_text, contact_eta_text, disclosure_version, is_active, is_default,
      is_synthetic, created_at, updated_at
    ) VALUES (?, 'insurance', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      recipient_name = excluded.recipient_name,
      data_scope_json = excluded.data_scope_json,
      purpose = excluded.purpose,
      retention_text = excluded.retention_text,
      consent_text = excluded.consent_text,
      contact_eta_text = excluded.contact_eta_text,
      disclosure_version = excluded.disclosure_version,
      is_active = excluded.is_active,
      is_default = excluded.is_default,
      is_synthetic = excluded.is_synthetic,
      updated_at = excluded.updated_at
  `);
  const insert = async (
    partner: typeof demoPartner,
    options: { isDefault: boolean; isSynthetic: boolean },
  ): Promise<void> => {
    const disclosureVersion = computeInsuranceDisclosureVersion(partner);
    await upsert.run(
      partner.id,
      partner.name,
      partner.recipientName,
      JSON.stringify(partner.dataScope),
      partner.purpose,
      partner.retentionText,
      partner.consentText,
      partner.contactEtaText,
      disclosureVersion,
      options.isDefault ? 1 : 0,
      options.isSynthetic ? 1 : 0,
      now,
      now,
    );
  };

  await insert(demoPartner, {
    isDefault: !configured && (!existingDefault?.id || existingDefault.id === DEMO_INSURANCE_PARTNER_ID),
    isSynthetic: true,
  });
  if (configured) {
    await database.prepare(`
      UPDATE service_partners SET is_default = 0, updated_at = ?
      WHERE service_type = 'insurance' AND is_default = 1 AND id <> ?
    `).run(now, configured.id);
    await insert(configured, { isDefault: true, isSynthetic: false });
  }
}

export async function clearInsuranceData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM service_lead_events;
    DELETE FROM service_lead_media;
    DELETE FROM insurance_lead_details;
    DELETE FROM service_leads;
    DELETE FROM service_partners;
  `);
}
