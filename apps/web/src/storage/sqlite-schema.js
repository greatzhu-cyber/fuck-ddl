export const DATABASE_URL = "sqlite:fuck-ddl.db";
export const STATE_PREFIX = "fuck-ddl:v1:";

export const SCHEMA_STATEMENTS = Object.freeze([
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS app_state (state_key TEXT PRIMARY KEY NOT NULL, encoded_value TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sync_outbox (operation_id TEXT PRIMARY KEY NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation_kind TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_sync_outbox_ready ON sync_outbox (status, available_at, created_at)",
  "CREATE TABLE IF NOT EXISTS sync_cursors (source_name TEXT PRIMARY KEY NOT NULL, cursor_value TEXT, updated_at TEXT NOT NULL)",
]);
