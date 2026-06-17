import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const db = new Database(join(__dirname, '..', 'providers.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    pubkey            TEXT PRIMARY KEY,
    name              TEXT,
    description       TEXT,
    version           TEXT,
    endpoint          TEXT,
    onion_url         TEXT,
    mints             TEXT,
    child_key_cost_msats INTEGER DEFAULT 0,
    last_seen         INTEGER,
    last_check        INTEGER,
    is_online         INTEGER DEFAULT 0,
    response_ms       INTEGER,
    uptime_ok_24h     INTEGER DEFAULT 0,
    uptime_total_24h  INTEGER DEFAULT 0,
    raw_event         TEXT,
    network           TEXT DEFAULT 'routstr',
    auth_type         TEXT DEFAULT 'lightning',
    -- legacy columns kept for backwards compat
    models            TEXT,
    price_msat        INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS models (
    id                      TEXT NOT NULL,
    provider_pubkey         TEXT NOT NULL,
    canonical_id            TEXT,
    name                    TEXT,
    context_length          INTEGER,
    max_completion_tokens   INTEGER,
    modality                TEXT,
    input_modalities        TEXT,
    output_modalities       TEXT,
    pricing_sats_prompt     REAL,
    pricing_sats_completion REAL,
    pricing_sats_per_1k_prompt     REAL,
    pricing_sats_per_1k_completion REAL,
    pricing_usd_prompt             REAL,
    pricing_usd_completion         REAL,
    pricing_usd_per_1k_prompt      REAL,
    pricing_usd_per_1k_completion  REAL,
    supported_parameters    TEXT,
    is_moderated            INTEGER DEFAULT 0,
    enabled                 INTEGER DEFAULT 1,
    raw                     TEXT,
    updated_at              INTEGER,
    PRIMARY KEY (id, provider_pubkey)
  );

  CREATE TABLE IF NOT EXISTS uptime_history (
    provider_pubkey TEXT NOT NULL,
    checked_at      INTEGER NOT NULL,
    is_online       INTEGER NOT NULL,
    response_ms     INTEGER,
    PRIMARY KEY (provider_pubkey, checked_at)
  );

  CREATE TABLE IF NOT EXISTS invoices (
    payment_hash TEXT PRIMARY KEY,
    bolt11       TEXT,
    created_at   INTEGER,
    used_at      INTEGER,
    amount_sats  INTEGER
  );
`)

// Migrations: add new columns if they don't exist
const providerCols = db.pragma('table_info(providers)').map(c => c.name)
const newProviderCols = {
  description:          'TEXT',
  version:              'TEXT',
  onion_url:            'TEXT',
  mints:                'TEXT',
  child_key_cost_msats: 'INTEGER DEFAULT 0',
  uptime_ok_24h:        'INTEGER DEFAULT 0',
  uptime_total_24h:     'INTEGER DEFAULT 0',
  network:              "TEXT DEFAULT 'routstr'",
  auth_type:            "TEXT DEFAULT 'lightning'",
}
for (const [col, type] of Object.entries(newProviderCols)) {
  if (!providerCols.includes(col)) {
    db.exec(`ALTER TABLE providers ADD COLUMN ${col} ${type}`)
  }
}

const invoiceCols = db.pragma('table_info(invoices)').map(c => c.name)
if (!invoiceCols.includes('amount_sats')) {
  db.exec('ALTER TABLE invoices ADD COLUMN amount_sats INTEGER')
}
if (!invoiceCols.includes('used_at')) {
  db.exec('ALTER TABLE invoices ADD COLUMN used_at INTEGER')
}

const modelCols = db.pragma('table_info(models)').map(c => c.name)
const newModelCols = {
  pricing_usd_prompt:            'REAL',
  pricing_usd_completion:        'REAL',
  pricing_usd_per_1k_prompt:     'REAL',
  pricing_usd_per_1k_completion: 'REAL',
}
for (const [col, type] of Object.entries(newModelCols)) {
  if (!modelCols.includes(col)) {
    db.exec(`ALTER TABLE models ADD COLUMN ${col} ${type}`)
  }
}

export default db
