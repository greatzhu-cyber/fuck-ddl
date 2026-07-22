import Database from "@tauri-apps/plugin-sql";
import { isTauriDesktop } from "./integrations/pintia-desktop.js";

const DATABASE_URL = "sqlite:fuck-ddl.db";
const CREATE_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS app_state (
    state_key TEXT PRIMARY KEY NOT NULL,
    encoded_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

let databasePromise = null;
let writeQueue = Promise.resolve();

export function resetDesktopDatabaseForTests() {
  databasePromise = null;
  writeQueue = Promise.resolve();
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
        throw error;
      });
  }
  return databasePromise;
}

export async function restoreDesktopState({
  storage = window.localStorage,
  openDatabase = openDesktopDatabase,
} = {}) {
  const database = await openDatabase();
  if (!database) return { restored: 0, skipped: true };
  const rows = await database.select(
    "SELECT state_key, encoded_value FROM app_state ORDER BY updated_at ASC",
  );
  let restored = 0;
  rows.forEach((row) => {
    if (
      typeof row.state_key !== "string" ||
      typeof row.encoded_value !== "string"
    ) {
      return;
    }
    try {
      JSON.parse(row.encoded_value);
      storage.setItem(row.state_key, row.encoded_value);
      restored += 1;
    } catch {
      // Never replace a usable local value with a malformed database row.
    }
  });
  return { restored, skipped: false };
}

export function persistDesktopState(
  key,
  encodedValue,
  {
    openDatabase = openDesktopDatabase,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (
    !isTauriDesktop() ||
    typeof key !== "string" ||
    typeof encodedValue !== "string"
  ) {
    return Promise.resolve(false);
  }
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const database = await openDatabase();
      if (!database) return false;
      await database.execute(
        `INSERT INTO app_state (state_key, encoded_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
           encoded_value = excluded.encoded_value,
           updated_at = excluded.updated_at`,
        [key, encodedValue, now()],
      );
      return true;
    });
  return writeQueue;
}
