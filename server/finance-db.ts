import type { AppDatabase } from "./database.js";

/**
 * Unified finance projection. Domain orders remain authoritative for payment
 * and fulfilment; these tables are an append-only accounting projection used
 * for reconciliation and offline payouts.
 */
export async function migrateFinanceDatabase(database: AppDatabase): Promise<void> {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS finance_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      cutover_at TIMESTAMPTZ,
      default_valet_company_id TEXT,
      updated_by_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    INSERT INTO finance_settings (id, enabled, cutover_at, default_valet_company_id, updated_at)
    VALUES (1, FALSE, NULL, NULL, now())
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS valet_companies (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      contact_name TEXT,
      contact_phone TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE finance_settings
      DROP CONSTRAINT IF EXISTS finance_settings_default_valet_company_fk;
    ALTER TABLE finance_settings
      ADD CONSTRAINT finance_settings_default_valet_company_fk
      FOREIGN KEY (default_valet_company_id) REFERENCES valet_companies(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS finance_rule_versions (
      id TEXT PRIMARY KEY,
      business_type TEXT NOT NULL CHECK (
        business_type IN ('annual_inspection', 'car_wash', 'repair', 'valet')
      ),
      rule_kind TEXT NOT NULL CHECK (rule_kind IN ('commission', 'valet_cost')),
      calculation_mode TEXT NOT NULL CHECK (
        calculation_mode IN ('percentage', 'fixed', 'distance')
      ),
      rate_bps INTEGER CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
      fixed_fen INTEGER CHECK (fixed_fen IS NULL OR fixed_fen >= 0),
      base_fee_fen INTEGER CHECK (base_fee_fen IS NULL OR base_fee_fen >= 0),
      included_km REAL CHECK (included_km IS NULL OR included_km >= 0),
      per_km_fen INTEGER CHECK (per_km_fen IS NULL OR per_km_fen >= 0),
      effective_from DATE NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
      created_by_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      published_by_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL,
      published_at TIMESTAMPTZ,
      UNIQUE (business_type, version),
      CHECK (
        (rule_kind = 'commission' AND business_type <> 'valet'
          AND calculation_mode IN ('percentage', 'fixed'))
        OR
        (rule_kind = 'valet_cost' AND business_type = 'valet'
          AND calculation_mode = 'distance')
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS finance_rule_one_active_type
      ON finance_rule_versions(business_type) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS finance_payment_transactions (
      id TEXT PRIMARY KEY,
      source_payment_type TEXT NOT NULL,
      source_payment_id TEXT NOT NULL,
      source_order_type TEXT NOT NULL CHECK (
        source_order_type IN ('annual_inspection', 'car_wash', 'repair')
      ),
      source_order_id TEXT NOT NULL,
      order_number TEXT NOT NULL,
      transaction_kind TEXT NOT NULL CHECK (transaction_kind IN ('charge', 'refund')),
      provider TEXT NOT NULL,
      listed_amount_fen INTEGER NOT NULL CHECK (listed_amount_fen >= 0),
      channel_amount_fen INTEGER NOT NULL CHECK (channel_amount_fen >= 0),
      transaction_id TEXT,
      out_trade_no TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'anomaly')),
      is_real BOOLEAN NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (source_payment_type, source_payment_id, transaction_kind)
    );

    CREATE INDEX IF NOT EXISTS finance_payment_order_index
      ON finance_payment_transactions(source_order_type, source_order_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS finance_payment_occurred_index
      ON finance_payment_transactions(occurred_at DESC, id DESC);

    ALTER TABLE finance_payment_transactions
      DROP CONSTRAINT IF EXISTS finance_payment_transactions_status_check;
    ALTER TABLE finance_payment_transactions
      ADD CONSTRAINT finance_payment_transactions_status_check
      CHECK (status IN ('pending', 'confirmed', 'failed', 'anomaly'));

    CREATE TABLE IF NOT EXISTS finance_daily_statements (
      id TEXT PRIMARY KEY,
      statement_number TEXT NOT NULL UNIQUE,
      statement_date DATE NOT NULL,
      counterparty_type TEXT NOT NULL CHECK (
        counterparty_type IN ('inspection_station', 'wash_store', 'repair_shop', 'valet_company')
      ),
      counterparty_id TEXT NOT NULL,
      counterparty_name TEXT NOT NULL,
      opening_balance_fen INTEGER NOT NULL DEFAULT 0,
      gross_amount_fen INTEGER NOT NULL DEFAULT 0,
      commission_amount_fen INTEGER NOT NULL DEFAULT 0,
      item_net_amount_fen INTEGER NOT NULL DEFAULT 0,
      payable_amount_fen INTEGER NOT NULL DEFAULT 0 CHECK (payable_amount_fen >= 0),
      closing_balance_fen INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
      status TEXT NOT NULL CHECK (
        status IN ('pending_payment', 'paid', 'carried_forward', 'void')
      ),
      generated_at TIMESTAMPTZ NOT NULL,
      paid_at TIMESTAMPTZ,
      voided_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL
    );

    -- Allow a voided statement to coexist with a replacement for the same day.
    ALTER TABLE finance_daily_statements
      DROP CONSTRAINT IF EXISTS finance_daily_statements_statement_date_counterparty_type_counterparty_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS finance_daily_statements_one_active_per_day
      ON finance_daily_statements(statement_date, counterparty_type, counterparty_id)
      WHERE status <> 'void';

    CREATE TABLE IF NOT EXISTS finance_accruals (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      source_order_type TEXT NOT NULL CHECK (
        source_order_type IN ('annual_inspection', 'car_wash', 'repair')
      ),
      source_order_id TEXT NOT NULL,
      order_number TEXT NOT NULL,
      component_type TEXT NOT NULL CHECK (
        component_type IN ('inspection_fee', 'wash_fee', 'repair_fee', 'valet_cost')
      ),
      entry_kind TEXT NOT NULL CHECK (entry_kind IN ('accrual', 'reversal')),
      reversal_of_id TEXT REFERENCES finance_accruals(id) ON DELETE RESTRICT,
      counterparty_type TEXT NOT NULL CHECK (
        counterparty_type IN ('inspection_station', 'wash_store', 'repair_shop', 'valet_company')
      ),
      counterparty_id TEXT NOT NULL,
      counterparty_name TEXT NOT NULL,
      gross_amount_fen INTEGER NOT NULL,
      commission_amount_fen INTEGER NOT NULL,
      net_amount_fen INTEGER NOT NULL,
      customer_component_amount_fen INTEGER NOT NULL,
      one_way_distance_km REAL,
      rule_version_id TEXT NOT NULL REFERENCES finance_rule_versions(id) ON DELETE RESTRICT,
      rule_snapshot_json JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending_statement', 'statemented')),
      eligible_at TIMESTAMPTZ NOT NULL,
      eligible_date DATE NOT NULL,
      statement_id TEXT REFERENCES finance_daily_statements(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS finance_accrual_pending_index
      ON finance_accruals(status, eligible_date, counterparty_type, counterparty_id);
    CREATE INDEX IF NOT EXISTS finance_accrual_order_index
      ON finance_accruals(source_order_type, source_order_id, component_type, created_at);

    CREATE TABLE IF NOT EXISTS finance_statement_items (
      id TEXT PRIMARY KEY,
      statement_id TEXT NOT NULL REFERENCES finance_daily_statements(id) ON DELETE RESTRICT,
      accrual_id TEXT NOT NULL UNIQUE REFERENCES finance_accruals(id) ON DELETE RESTRICT,
      sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
      order_number TEXT NOT NULL,
      component_type TEXT NOT NULL,
      entry_kind TEXT NOT NULL,
      gross_amount_fen INTEGER NOT NULL,
      commission_amount_fen INTEGER NOT NULL,
      net_amount_fen INTEGER NOT NULL,
      eligible_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (statement_id, sequence_no)
    );

    CREATE TABLE IF NOT EXISTS finance_counterparty_balances (
      counterparty_type TEXT NOT NULL,
      counterparty_id TEXT NOT NULL,
      balance_fen INTEGER NOT NULL DEFAULT 0 CHECK (balance_fen <= 0),
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (counterparty_type, counterparty_id)
    );

    CREATE TABLE IF NOT EXISTS finance_payouts (
      id TEXT PRIMARY KEY,
      statement_id TEXT NOT NULL REFERENCES finance_daily_statements(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL UNIQUE,
      amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
      payment_method TEXT NOT NULL CHECK (payment_method IN ('bank_transfer', 'other')),
      bank_reference TEXT NOT NULL,
      note TEXT,
      evidence_storage_key TEXT,
      evidence_mime_type TEXT,
      status TEXT NOT NULL CHECK (status IN ('posted', 'voided')),
      posted_by_account_id TEXT REFERENCES backoffice_accounts(id) ON DELETE SET NULL,
      posted_by_name TEXT NOT NULL,
      paid_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      voided_at TIMESTAMPTZ,
      void_reason TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS finance_payout_one_posted_statement
      ON finance_payouts(statement_id) WHERE status = 'posted';
  `);
}

export async function clearFinanceRuntimeData(database: AppDatabase): Promise<void> {
  await database.execute(`
    DELETE FROM finance_payouts;
    DELETE FROM finance_statement_items;
    DELETE FROM finance_accruals;
    DELETE FROM finance_daily_statements;
    DELETE FROM finance_counterparty_balances;
    DELETE FROM finance_payment_transactions;
  `);
}
