import {
  DATABASE_URL,
  SCHEMA_STATEMENTS,
  STATE_PREFIX,
} from "./sqlite-schema.js";
import { outboxLeaseExpiry, outboxRetryAt } from "./outbox-policy.js";

const DEFAULT_OUTBOX_LIMIT = 50;
const OUTBOX_STATUSES = new Set(["pending", "in-flight", "sent", "failed"]);

function asText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function asJson(value) {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return null;
    }
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return null;
  }
}

function affectedRows(result) {
  const count = Number(result?.rowsAffected ?? result?.rows_affected);
  return Number.isFinite(count) ? count > 0 : true;
}

export function normalizeOutboxOperation(
  operation,
  now = () => new Date().toISOString(),
) {
  if (!operation || typeof operation !== "object") return null;
  const operationId = asText(operation.operationId ?? operation.id);
  const entityType = asText(operation.entityType);
  const entityId = asText(operation.entityId);
  const operationKind = asText(operation.operationKind ?? operation.operation);
  const payload = asJson(operation.payload);
  if (
    !operationId ||
    !entityType ||
    !entityId ||
    !operationKind ||
    payload === null
  ) {
    return null;
  }
  const status = asText(operation.status) ?? "pending";
  if (!OUTBOX_STATUSES.has(status)) return null;
  return {
    operationId,
    entityType,
    entityId,
    operationKind,
    payload,
    version: Math.max(1, Number(operation.version) || 1),
    status,
    attempts: Math.max(0, Number(operation.attempts) || 0),
    availableAt: asText(operation.availableAt) ?? now(),
    createdAt: asText(operation.createdAt) ?? now(),
    updatedAt: asText(operation.updatedAt) ?? now(),
    lastError: asText(operation.lastError),
  };
}

export function createSqliteRepository(
  database,
  { now = () => new Date().toISOString() } = {},
) {
  if (
    !database ||
    (typeof database.execute !== "function" &&
      typeof database.select !== "function")
  ) {
    throw new TypeError(
      "A SQLite database with execute and select is required",
    );
  }

  async function ensureSchema() {
    await database.execute("BEGIN");
    try {
      for (const statement of SCHEMA_STATEMENTS) {
        await database.execute(statement);
      }
      await database.execute("COMMIT");
    } catch (error) {
      await database.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  return {
    async ensureSchema() {
      return ensureSchema();
    },

    async selectStateRows() {
      return database.select(
        "SELECT state_key, encoded_value FROM app_state ORDER BY updated_at ASC",
      );
    },

    async upsertState(key, encodedValue, updatedAt = now()) {
      return database.execute(
        "INSERT INTO app_state (state_key, encoded_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET encoded_value = excluded.encoded_value, updated_at = excluded.updated_at",
        [key, encodedValue, updatedAt],
      );
    },

    async enqueueOutbox(operation) {
      const normalized = normalizeOutboxOperation(operation, now);
      if (!normalized) return false;
      await database.execute(
        "INSERT INTO sync_outbox (operation_id, entity_type, entity_id, operation_kind, payload, version, status, attempts, available_at, created_at, updated_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(operation_id) DO NOTHING",
        [
          normalized.operationId,
          normalized.entityType,
          normalized.entityId,
          normalized.operationKind,
          normalized.payload,
          normalized.version,
          normalized.status,
          normalized.attempts,
          normalized.availableAt,
          normalized.createdAt,
          normalized.updatedAt,
          normalized.lastError,
        ],
      );
      return true;
    },

    async listPendingOutbox({ limit = DEFAULT_OUTBOX_LIMIT, at = now() } = {}) {
      const boundedLimit = Math.min(
        200,
        Math.max(1, Math.floor(Number(limit) || DEFAULT_OUTBOX_LIMIT)),
      );
      return database.select(
        "SELECT operation_id, entity_type, entity_id, operation_kind, payload, version, status, attempts, available_at, created_at, updated_at, last_error FROM sync_outbox WHERE status = ? AND available_at <= ? ORDER BY created_at ASC LIMIT ?",
        ["pending", at, boundedLimit],
      );
    },

    async claimOutbox({
      limit = DEFAULT_OUTBOX_LIMIT,
      at = now(),
      leaseMs,
    } = {}) {
      const rows = await this.listPendingOutbox({ limit, at });
      const leaseUntil = outboxLeaseExpiry(at, leaseMs);
      if (!leaseUntil) return [];
      const claimed = [];
      for (const row of rows) {
        const result = await database.execute(
          "UPDATE sync_outbox SET status = ?, attempts = attempts + 1, available_at = ?, updated_at = ? WHERE operation_id = ? AND status = ?",
          ["in-flight", leaseUntil, at, row.operation_id, "pending"],
        );
        if (!affectedRows(result)) continue;
        claimed.push({
          ...row,
          status: "in-flight",
          attempts: Number(row.attempts ?? 0) + 1,
          available_at: leaseUntil,
          updated_at: at,
        });
      }
      return claimed;
    },

    async acknowledgeOutbox(operationId, at = now(), claimedAt = null) {
      const leaseFence = asText(claimedAt);
      if (!asText(operationId) || !leaseFence) return false;
      const result = await database.execute(
        "UPDATE sync_outbox SET status = ?, updated_at = ?, last_error = ? WHERE operation_id = ? AND status = ? AND updated_at = ?",
        ["sent", at, null, operationId, "in-flight", leaseFence],
      );
      return affectedRows(result);
    },

    async retryOutbox(
      operationId,
      {
        error = null,
        attempts = null,
        at = now(),
        retryAt = null,
        claimedAt = null,
      } = {},
    ) {
      const leaseFence = asText(claimedAt);
      if (!asText(operationId) || !leaseFence) return false;
      let effectiveAttempts = Number(attempts);
      if (!Number.isFinite(effectiveAttempts)) {
        const rows = await database.select(
          "SELECT attempts FROM sync_outbox WHERE operation_id = ?",
          [operationId],
        );
        effectiveAttempts = Number(rows[0]?.attempts ?? 1);
      }
      const nextAt = retryAt ?? outboxRetryAt(effectiveAttempts, at);
      if (!nextAt) return false;
      const result = await database.execute(
        "UPDATE sync_outbox SET status = ?, available_at = ?, updated_at = ?, last_error = ? WHERE operation_id = ? AND status = ? AND updated_at = ?",
        [
          "pending",
          nextAt,
          at,
          asText(error),
          operationId,
          "in-flight",
          leaseFence,
        ],
      );
      return affectedRows(result);
    },

    async failOutbox(
      operationId,
      { error = null, at = now(), claimedAt = null } = {},
    ) {
      const leaseFence = asText(claimedAt);
      if (!asText(operationId) || !leaseFence) return false;
      const result = await database.execute(
        "UPDATE sync_outbox SET status = ?, updated_at = ?, last_error = ? WHERE operation_id = ? AND status = ? AND updated_at = ?",
        ["failed", at, asText(error), operationId, "in-flight", leaseFence],
      );
      return affectedRows(result);
    },

    async recoverStaleOutbox({ at = now() } = {}) {
      const result = await database.execute(
        "UPDATE sync_outbox SET status = ?, available_at = ?, updated_at = ?, last_error = COALESCE(last_error, ?) WHERE status = ? AND available_at <= ?",
        ["pending", at, at, "lease-expired", "in-flight", at],
      );
      return affectedRows(result);
    },

    async updateOutbox(
      operationId,
      {
        status = "sent",
        error = null,
        retryAt = null,
        claimedAt = null,
        at = now(),
      } = {},
    ) {
      if (status === "sent") {
        return this.acknowledgeOutbox(operationId, at, claimedAt);
      }
      if (status === "pending") {
        return this.retryOutbox(operationId, {
          error,
          retryAt,
          claimedAt,
          at,
        });
      }
      if (status === "failed") {
        return this.failOutbox(operationId, { error, claimedAt, at });
      }
      return false;
    },

    async readSyncCursor(sourceName) {
      const source = asText(sourceName);
      if (!source) return null;
      const rows = await database.select(
        "SELECT source_name, cursor_value, updated_at FROM sync_cursors WHERE source_name = ?",
        [source],
      );
      return rows[0] ?? null;
    },

    async writeSyncCursor(sourceName, cursorValue) {
      const source = asText(sourceName);
      if (!source) return false;
      await database.execute(
        "INSERT INTO sync_cursors (source_name, cursor_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(source_name) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at",
        [
          source,
          cursorValue === null || cursorValue === undefined
            ? null
            : String(cursorValue),
          now(),
        ],
      );
      return true;
    },
  };
}

export { DATABASE_URL, STATE_PREFIX };
