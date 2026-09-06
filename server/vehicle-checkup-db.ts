import type { AppDatabase } from "./database.js";

/**
 * PostgreSQL schema for the station-authored vehicle-condition report that is
 * delivered together with an annual-inspection result. The report is distinct
 * from the official inspection-line result and from the owner's booking media.
 */
export async function migrateVehicleCheckupDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS vehicle_checkup_reports (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      report_no TEXT NOT NULL UNIQUE,
      schema_version TEXT NOT NULL DEFAULT 'vehicle-checkup-v2',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
      observation_mode TEXT CHECK (
        observation_mode IS NULL OR observation_mode IN ('no_visible_faults', 'faults_recorded')
      ),
      diagram_version TEXT NOT NULL DEFAULT 'sedan-3view-v1',
      -- Storage keeps the retired conditional literal readable for historical
      -- rows. Application write validation permits only passed/failed.
      annual_conclusion TEXT CHECK (
        annual_conclusion IS NULL OR annual_conclusion IN ('passed', 'conditional', 'failed')
      ),
      annual_failure_details_json TEXT,
      annual_mark_status TEXT CHECK (
        annual_mark_status IS NULL OR annual_mark_status IN ('issued', 'not_issued')
      ),
      summary_json TEXT NOT NULL DEFAULT '{}',
      vehicle_snapshot_json TEXT NOT NULL DEFAULT '{}',
      station_snapshot_json TEXT NOT NULL DEFAULT '{}',
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      retain_until TEXT
    );

    CREATE TABLE IF NOT EXISTS vehicle_checkup_faults (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES vehicle_checkup_reports(id) ON DELETE CASCADE,
      client_key TEXT,
      sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
      view_id TEXT NOT NULL CHECK (view_id IN ('top', 'left', 'right')),
      region_code TEXT NOT NULL,
      fault_type TEXT NOT NULL CHECK (
        fault_type IN ('scratch', 'dent', 'paint_damage', 'crack', 'broken', 'rust', 'warning_light', 'malfunction', 'abnormal_noise', 'leakage', 'wear', 'other')
      ),
      severity TEXT NOT NULL CHECK (severity IN ('minor', 'moderate', 'severe')),
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(report_id, sequence_no),
      CONSTRAINT vehicle_checkup_faults_report_id_id_key UNIQUE(report_id, id)
    );

    CREATE TABLE IF NOT EXISTS vehicle_checkup_media (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      report_id TEXT NOT NULL REFERENCES vehicle_checkup_reports(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CONSTRAINT vehicle_checkup_media_kind_check_v3 CHECK (
        kind IN (
          'front_left', 'front_right', 'rear_left', 'rear_right',
          'dashboard_started', 'safety_inspection_report',
          'emissions_inspection_report', 'annual_inspection_mark', 'fault_closeup'
        )
      ),
      fault_id TEXT,
      sequence_no INTEGER,
      status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'bound')),
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      sha256 TEXT NOT NULL,
      upload_idempotency_key TEXT,
      upload_request_hash TEXT,
      uploader_actor_type TEXT NOT NULL DEFAULT 'operator' CHECK (
        uploader_actor_type IN ('operator', 'external_system', 'system')
      ),
      created_at TEXT NOT NULL,
      bound_at TEXT,
      expires_at TEXT NOT NULL,
      CONSTRAINT vehicle_checkup_media_fault_shape_check CHECK (
        (
          kind = 'fault_closeup'
          AND fault_id IS NOT NULL
          AND sequence_no BETWEEN 1 AND 3
        ) OR (
          kind <> 'fault_closeup'
          AND fault_id IS NULL
          AND sequence_no IS NULL
        )
      ),
      CONSTRAINT vehicle_checkup_media_fault_report_fk
        FOREIGN KEY(report_id, fault_id)
        REFERENCES vehicle_checkup_faults(report_id, id)
        ON DELETE CASCADE
    );

    -- Upgrade existing v1 databases without rewriting published evidence. New
    -- and still-editable drafts use the v2 composition rules; published v1
    -- rows remain immutable/readable historical reports.
    ALTER TABLE vehicle_checkup_reports
      ALTER COLUMN schema_version SET DEFAULT 'vehicle-checkup-v2',
      ADD COLUMN IF NOT EXISTS annual_failure_details_json TEXT;

    ALTER TABLE inspection_results
      ADD COLUMN IF NOT EXISTS failure_details_json TEXT;

    ALTER TABLE vehicle_checkup_faults
      ADD COLUMN IF NOT EXISTS client_key TEXT;

    ALTER TABLE vehicle_checkup_faults
      DROP CONSTRAINT IF EXISTS vehicle_checkup_faults_fault_type_check;

    ALTER TABLE vehicle_checkup_faults
      ADD CONSTRAINT vehicle_checkup_faults_fault_type_check CHECK (
        fault_type IN (
          'scratch', 'dent', 'paint_damage', 'crack', 'broken', 'rust',
          'warning_light', 'malfunction', 'abnormal_noise', 'leakage', 'wear', 'other'
        )
      );

    ALTER TABLE vehicle_checkup_media
      ADD COLUMN IF NOT EXISTS fault_id TEXT,
      ADD COLUMN IF NOT EXISTS sequence_no INTEGER,
      ADD COLUMN IF NOT EXISTS upload_idempotency_key TEXT,
      ADD COLUMN IF NOT EXISTS upload_request_hash TEXT;

    ALTER TABLE vehicle_checkup_media
      DROP CONSTRAINT IF EXISTS vehicle_checkup_media_kind_check,
      DROP CONSTRAINT IF EXISTS vehicle_checkup_media_kind_check_v2,
      DROP CONSTRAINT IF EXISTS vehicle_checkup_media_report_id_kind_key;

    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vehicle_checkup_faults_report_id_id_key'
          AND conrelid = 'vehicle_checkup_faults'::regclass
      ) THEN
        ALTER TABLE vehicle_checkup_faults
          ADD CONSTRAINT vehicle_checkup_faults_report_id_id_key UNIQUE(report_id, id);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vehicle_checkup_media_kind_check_v3'
          AND conrelid = 'vehicle_checkup_media'::regclass
      ) THEN
        ALTER TABLE vehicle_checkup_media
          ADD CONSTRAINT vehicle_checkup_media_kind_check_v3 CHECK (
            kind IN (
              'front_left', 'front_right', 'rear_left', 'rear_right',
              'dashboard_started', 'safety_inspection_report',
              'emissions_inspection_report', 'annual_inspection_mark', 'fault_closeup'
            )
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vehicle_checkup_media_fault_shape_check'
          AND conrelid = 'vehicle_checkup_media'::regclass
      ) THEN
        ALTER TABLE vehicle_checkup_media
          ADD CONSTRAINT vehicle_checkup_media_fault_shape_check CHECK (
            (
              kind = 'fault_closeup'
              AND fault_id IS NOT NULL
              AND sequence_no BETWEEN 1 AND 3
            ) OR (
              kind <> 'fault_closeup'
              AND fault_id IS NULL
              AND sequence_no IS NULL
            )
          );
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vehicle_checkup_media_fault_report_fk'
          AND conrelid = 'vehicle_checkup_media'::regclass
      ) THEN
        ALTER TABLE vehicle_checkup_media
          ADD CONSTRAINT vehicle_checkup_media_fault_report_fk
          FOREIGN KEY(report_id, fault_id)
          REFERENCES vehicle_checkup_faults(report_id, id)
          ON DELETE CASCADE;
      END IF;
    END
    $migration$;

    UPDATE vehicle_checkup_reports
    SET schema_version = 'vehicle-checkup-v2'
    WHERE status = 'draft' AND schema_version = 'vehicle-checkup-v1';

    CREATE INDEX IF NOT EXISTS vehicle_checkup_faults_report_index
      ON vehicle_checkup_faults(report_id, sequence_no);

    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_checkup_faults_client_key_unique
      ON vehicle_checkup_faults(report_id, client_key)
      WHERE client_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS vehicle_checkup_media_booking_index
      ON vehicle_checkup_media(booking_id, kind);

    CREATE INDEX IF NOT EXISTS vehicle_checkup_media_expiry_index
      ON vehicle_checkup_media(status, expires_at);

    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_checkup_media_fixed_kind_unique
      ON vehicle_checkup_media(report_id, kind)
      WHERE kind <> 'fault_closeup';

    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_checkup_media_fault_sequence_unique
      ON vehicle_checkup_media(fault_id, sequence_no)
      WHERE kind = 'fault_closeup';

    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_checkup_media_upload_idempotency_unique
      ON vehicle_checkup_media(report_id, upload_idempotency_key)
      WHERE upload_idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS vehicle_checkup_media_fault_index
      ON vehicle_checkup_media(fault_id, sequence_no)
      WHERE kind = 'fault_closeup';

    CREATE INDEX IF NOT EXISTS vehicle_checkup_reports_retention_index
      ON vehicle_checkup_reports(status, retain_until);

    CREATE INDEX IF NOT EXISTS vehicle_checkup_reports_owner_list_index
      ON vehicle_checkup_reports(published_at DESC, id DESC)
      WHERE status = 'published' AND published_at IS NOT NULL;
  `);
}
