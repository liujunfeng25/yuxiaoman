import type { AppDatabase } from "./database.js";

/**
 * Driver task binding and immutable, stage-scoped valet evidence.
 *
 * Existing bookings intentionally remain on the `legacy` evidence policy. Only
 * newly-created valet bookings opt into `valet-handoff-v1`, so deploying this
 * migration cannot strand an order that is already in flight.
 */
export async function migrateValetHandoffDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS evidence_policy_version TEXT NOT NULL DEFAULT 'legacy';

    ALTER TABLE booking_events
      DROP CONSTRAINT IF EXISTS booking_events_actor_type_check;
    ALTER TABLE booking_events
      ADD CONSTRAINT booking_events_actor_type_check CHECK (
        actor_type IN ('owner', 'operator', 'driver', 'external_system', 'system')
      );

    CREATE TABLE IF NOT EXISTS valet_driver_assignments (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      driver_name TEXT NOT NULL,
      driver_phone TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('assigned', 'bound', 'in_progress', 'completed', 'cancelled')
      ),
      task_code_hash TEXT UNIQUE,
      task_code_expires_at TEXT,
      task_code_consumed_at TEXT,
      bound_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      assigned_by_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      assigned_at TEXT NOT NULL,
      bound_at TEXT,
      completed_at TEXT,
      return_start_idempotency_key TEXT,
      cancelled_at TEXT,
      updated_at TEXT NOT NULL
    );

    ALTER TABLE valet_driver_assignments
      ADD COLUMN IF NOT EXISTS return_start_idempotency_key TEXT;

    ALTER TABLE valet_driver_assignments
      ADD COLUMN IF NOT EXISTS verification_code_hmac TEXT;
    ALTER TABLE valet_driver_assignments
      ADD COLUMN IF NOT EXISTS verification_code_ciphertext TEXT;
    ALTER TABLE valet_driver_assignments
      ADD COLUMN IF NOT EXISTS verification_code_expires_at TEXT;
    ALTER TABLE valet_driver_assignments
      ADD COLUMN IF NOT EXISTS verification_code_created_at TEXT;

    CREATE TABLE IF NOT EXISTS valet_driver_sessions (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES valet_driver_assignments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS valet_driver_code_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_hash TEXT NOT NULL,
      succeeded BOOLEAN NOT NULL DEFAULT FALSE,
      attempted_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE valet_driver_code_attempts
      ALTER COLUMN attempted_at TYPE TIMESTAMPTZ USING attempted_at::timestamptz;

    CREATE TABLE IF NOT EXISTS valet_evidence_packages (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK (
        stage IN ('owner_pickup', 'station_arrival', 'inspection_complete', 'owner_return')
      ),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      source_type TEXT NOT NULL DEFAULT 'uploaded' CHECK (
        source_type IN ('uploaded', 'checkup_report')
      ),
      source_report_id TEXT REFERENCES vehicle_checkup_reports(id) ON DELETE RESTRICT,
      captured_by_actor_type TEXT CHECK (
        captured_by_actor_type IS NULL OR captured_by_actor_type IN ('driver', 'operator')
      ),
      captured_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      captured_by_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      captured_by_label TEXT,
      completion_idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(booking_id, stage),
      CONSTRAINT valet_evidence_package_source_check CHECK (
        (source_type = 'uploaded' AND source_report_id IS NULL)
        OR (source_type = 'checkup_report' AND source_report_id IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS valet_evidence_media (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES valet_evidence_packages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('front_left', 'front_right', 'rear_left', 'rear_right', 'dashboard_started')
      ),
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      sha256 TEXT NOT NULL,
      uploader_actor_type TEXT NOT NULL CHECK (uploader_actor_type IN ('driver', 'operator')),
      uploader_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      uploader_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(package_id, kind)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS valet_evidence_package_completion_key_unique
      ON valet_evidence_packages(booking_id, completion_idempotency_key)
      WHERE completion_idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS valet_driver_assignments_bound_user_index
      ON valet_driver_assignments(bound_user_id, status, updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS valet_driver_assignments_verification_code_unique
      ON valet_driver_assignments(verification_code_hmac)
      WHERE verification_code_hmac IS NOT NULL;

    CREATE INDEX IF NOT EXISTS valet_driver_sessions_active_index
      ON valet_driver_sessions(token_hash, expires_at)
      WHERE revoked_at IS NULL;

    CREATE INDEX IF NOT EXISTS valet_driver_code_attempts_user_index
      ON valet_driver_code_attempts(user_id, attempted_at DESC)
      WHERE succeeded = FALSE;

    CREATE INDEX IF NOT EXISTS valet_driver_code_attempts_ip_index
      ON valet_driver_code_attempts(ip_hash, attempted_at DESC)
      WHERE succeeded = FALSE;

    CREATE INDEX IF NOT EXISTS valet_evidence_media_package_index
      ON valet_evidence_media(package_id, kind);

    ALTER TABLE valet_driver_assignments
      ADD COLUMN IF NOT EXISTS receptionist_name TEXT,
      ADD COLUMN IF NOT EXISTS receptionist_phone TEXT,
      ADD COLUMN IF NOT EXISTS pickup_driver_phone TEXT,
      ADD COLUMN IF NOT EXISTS pickup_bound_user_id TEXT,
      ADD COLUMN IF NOT EXISTS pickup_bound_at TEXT,
      ADD COLUMN IF NOT EXISTS return_driver_phone TEXT,
      ADD COLUMN IF NOT EXISTS return_bound_user_id TEXT,
      ADD COLUMN IF NOT EXISTS return_bound_at TEXT,
      ADD COLUMN IF NOT EXISTS handoff_verification_code_hmac TEXT,
      ADD COLUMN IF NOT EXISTS handoff_verification_code_ciphertext TEXT,
      ADD COLUMN IF NOT EXISTS handoff_verification_code_expires_at TEXT,
      ADD COLUMN IF NOT EXISTS handoff_verification_code_created_at TEXT;

    ALTER TABLE valet_driver_assignments
      ALTER COLUMN pickup_bound_at TYPE TEXT USING pickup_bound_at::text,
      ALTER COLUMN return_bound_at TYPE TEXT USING return_bound_at::text,
      ALTER COLUMN handoff_verification_code_expires_at TYPE TEXT USING handoff_verification_code_expires_at::text,
      ALTER COLUMN handoff_verification_code_created_at TYPE TEXT USING handoff_verification_code_created_at::text;

    UPDATE valet_driver_assignments
    SET receptionist_name = COALESCE(receptionist_name, driver_name),
        receptionist_phone = COALESCE(receptionist_phone, driver_phone)
    WHERE receptionist_name IS NULL;
  `);
}
