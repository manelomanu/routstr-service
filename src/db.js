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

  CREATE TABLE IF NOT EXISTS memory (
    agent_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at INTEGER,
    PRIMARY KEY (agent_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory(agent_id);

  CREATE TABLE IF NOT EXISTS request_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,
    endpoint       TEXT    NOT NULL,
    method         TEXT    DEFAULT 'GET',
    status         INTEGER,
    response_ms    INTEGER,
    payment_type   TEXT,
    payment_id     TEXT,
    wallet_address TEXT,
    agent_id       TEXT,
    model          TEXT,
    ip_hash        TEXT,
    user_agent     TEXT,
    query_text     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_rl_ts         ON request_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_rl_wallet     ON request_log(wallet_address) WHERE wallet_address IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_rl_endpoint   ON request_log(endpoint);
  CREATE INDEX IF NOT EXISTS idx_rl_ip         ON request_log(ip_hash);

  CREATE TABLE IF NOT EXISTS counters (
    agent_id   TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    value      INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (agent_id, name)
  );

  CREATE TABLE IF NOT EXISTS agent_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   TEXT    NOT NULL,
    event      TEXT    NOT NULL,
    data       TEXT,
    created_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_agent_log ON agent_log(agent_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS job_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT    NOT NULL,
    payload      TEXT,
    status       TEXT    DEFAULT 'pending',
    result       TEXT,
    created_at   INTEGER,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS iota_txs (
    tx_hash      TEXT PRIMARY KEY,
    from_address TEXT,
    amount_base  TEXT,
    used_at      INTEGER NOT NULL
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
