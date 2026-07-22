import Database from "@tauri-apps/plugin-sql";
import { isTauriDesktop } from "./integrations/pintia-desktop.js";

const DATABASE_URL = "sqlite:fuck-ddl.db";
const STATE_PREFIX = "fuck-ddl:v1:";
const CREATE_STATE_TABLE =
  "CREATE TABLE IF NOT EXISTS app_state (state_key TEXT PRIMARY KEY NOT NULL, encoded_value TEXT NOT NULL, updated_at TEXT NOT NULL)";
const SELECT_STATE =
  "SELECT state_key, encoded_value FROM app_state ORDER BY updated_at ASC";

const UPSERT_STATE =
  "INSERT INTO app_state (state_key, encoded_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET encoded_value = excluded.encoded_value, updated_at = excluded.updated_at";

export const DESKTOP_DATABASE_STATUS_EVENT = "fuck-ddl:desktop-database-status";

let databasePromise = null;
let writeQueue = Promise.resolve();
let databaseStatus = createInitialStatus();
let knownStateKeys = new Set();

function createInitialStatus() {
  return {
    state: isTauriDesktop() ? "starting" : "browser",
    rowCount: 0,
    restored: 0,
    mirrored: 0,
    lastWriteAt: null,
  };
}

function publishStatus(patch) {
  databaseStatus = { ...databaseStatus, ...patch };
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(DESKTOP_DATABASE_STATUS_EVENT, {
        detail: { ...databaseStatus },
      }),
    );
  }
  return getDesktopDatabaseStatus();
}

function markDatabaseDegraded() {
  return publishStatus({ state: "degraded" });
}

function isVersionedState(key, encodedValue) {
  if (
    typeof key !== "string" ||
    !key.startsWith(STATE_PREFIX) ||
    typeof encodedValue !== "string"
  ) {
    return false;
  }
  try {
    return JSON.parse(encodedValue)?.version === 1;
  } catch {
    return false;
  }
}

function restoreRows(rows, storage) {
  let restored = 0;
  rows.forEach((row) => {
    if (!isVersionedState(row?.state_key, row?.encoded_value)) return;
    const localValue = storage.getItem?.(row.state_key);
    if (isVersionedState(row.state_key, localValue)) return;
    storage.setItem(row.state_key, row.encoded_value);
    restored += 1;
  });
  return restored;
}

function collectLocalState(storage) {
  const entries = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const encodedValue = key ? storage.getItem(key) : null;
    if (isVersionedState(key, encodedValue)) {
      entries.push([key, encodedValue]);
    }
  }
  return entries;
}

export function getDesktopDatabaseStatus() {
  return { ...databaseStatus };
}

export function resetDesktopDatabaseForTests() {
  databasePromise = null;
  writeQueue = Promise.resolve();
  databaseStatus = createInitialStatus();
  knownStateKeys = new Set();
}

export async function openDesktopDatabase({ load = Database.load } = {}) {
  if (!isTauriDesktop()) return null;
  if (!databasePromise) {
    databasePromise = load(DATABASE_URL)
      .then(async (database) => {
        await database.execute(CREATE_STATE_TABLE);
        return database;
      })
      .catch((error) => {
        databasePromise = null;
        markDatabaseDegraded();
        throw error;
      });
  }
  return databasePromise;
}

export async function restoreDesktopState({
  storage = window.localStorage,
  openDatabase = openDesktopDatabase,
} = {}) {
  try {
    const database = await openDatabase();
    if (!database) return { restored: 0, skipped: true };
    const rows = await database.select(SELECT_STATE);
    const restored = restoreRows(rows, storage);
    return { restored, skipped: false };
  } catch (error) {
    markDatabaseDegraded();
    throw error;
  }
}

export async function bootstrapDesktopState({
  storage = window.localStorage,
  openDatabase = openDesktopDatabase,
  now = () => new Date().toISOString(),
} = {}) {
  try {
    const database = await openDatabase();
    if (!database) {
      return publishStatus({
        state: "browser",
        rowCount: 0,
        restored: 0,
        mirrored: 0,
      });
    }

    const rows = await database.select(SELECT_STATE);
    const restored = restoreRows(rows, storage);
    const localEntries = collectLocalState(storage);
    knownStateKeys = new Set(
      rows
        .filter((row) => isVersionedState(row?.state_key, row?.encoded_value))
        .map((row) => row.state_key),
    );
    for (const [key, encodedValue] of localEntries) {
      await database.execute(UPSERT_STATE, [key, encodedValue, now()]);
      knownStateKeys.add(key);
    }
    return publishStatus({
      state: "ready",
      rowCount: knownStateKeys.size,
      restored,
      mirrored: localEntries.length,
      lastWriteAt: localEntries.length > 0 ? now() : null,
    });
  } catch (error) {
    markDatabaseDegraded();
    throw error;
  }
}

export function persistDesktopState(
  key,
  encodedValue,
  {
    openDatabase = openDesktopDatabase,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (!isTauriDesktop() || !isVersionedState(key, encodedValue)) {
    return Promise.resolve(false);
  }
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const database = await openDatabase();
        if (!database) return false;
        const writtenAt = now();
        await database.execute(UPSERT_STATE, [key, encodedValue, writtenAt]);
        knownStateKeys.add(key);
        publishStatus({
          state: "ready",
          rowCount: Math.max(databaseStatus.rowCount, knownStateKeys.size),
          lastWriteAt: writtenAt,
        });
        return true;
      } catch (error) {
        markDatabaseDegraded();
        throw error;
      }
    });
  return writeQueue;
}
