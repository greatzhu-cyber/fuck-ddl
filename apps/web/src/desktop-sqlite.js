import Database from "@tauri-apps/plugin-sql";
import { isTauriDesktop } from "./integrations/pintia-desktop.js";
import {
  createSqliteRepository,
  DATABASE_URL,
  STATE_PREFIX,
} from "./storage/sqlite-repository.js";
import { replayOutbox } from "./storage/outbox-replay.js";

export const DESKTOP_DATABASE_STATUS_EVENT = "fuck-ddl:desktop-database-status";

let databasePromise = null;
let writeQueue = Promise.resolve();
let replayPromise = null;
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
    if (isVersionedState(key, encodedValue)) entries.push([key, encodedValue]);
  }
  return entries;
}

function repositoryFor(database, now) {
  return createSqliteRepository(database, { now });
}

export function getDesktopDatabaseStatus() {
  return { ...databaseStatus };
}

export function resetDesktopDatabaseForTests() {
  databasePromise = null;
  writeQueue = Promise.resolve();
  replayPromise = null;
  databaseStatus = createInitialStatus();
  knownStateKeys = new Set();
}

export async function openDesktopDatabase({ load = Database.load } = {}) {
  if (!isTauriDesktop()) return null;
  if (!databasePromise) {
    databasePromise = load(DATABASE_URL)
      .then(async (database) => {
        const repository = repositoryFor(database);
        await repository.ensureSchema();
        if (typeof database.select === "function") {
          await repository.recoverStaleOutbox();
        }
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
    const rows = await repositoryFor(database).selectStateRows();
    return { restored: restoreRows(rows, storage), skipped: false };
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

    const repository = repositoryFor(database, now);
    const rows = await repository.selectStateRows();
    const restored = restoreRows(rows, storage);
    const localEntries = collectLocalState(storage);
    knownStateKeys = new Set(
      rows
        .filter((row) => isVersionedState(row?.state_key, row?.encoded_value))
        .map((row) => row.state_key),
    );
    for (const [key, encodedValue] of localEntries) {
      await repository.upsertState(key, encodedValue, now());
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
        await repositoryFor(database, now).upsertState(
          key,
          encodedValue,
          now(),
        );
        knownStateKeys.add(key);
        publishStatus({
          state: "ready",
          rowCount: Math.max(databaseStatus.rowCount, knownStateKeys.size),
          lastWriteAt: now(),
        });
        return true;
      } catch (error) {
        markDatabaseDegraded();
        throw error;
      }
    });
  return writeQueue;
}

export function enqueueDesktopOutbox(
  operation,
  {
    openDatabase = openDesktopDatabase,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (!isTauriDesktop()) return Promise.resolve(false);
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const database = await openDatabase();
        if (!database) return false;
        return repositoryFor(database, now).enqueueOutbox(operation);
      } catch (error) {
        markDatabaseDegraded();
        throw error;
      }
    });
  return writeQueue;
}
export function replayDesktopOutbox(
  send,
  {
    openDatabase = openDesktopDatabase,
    now = () => new Date().toISOString(),
    limit = 50,
    leaseMs,
    maxAttempts,
  } = {},
) {
  if (!isTauriDesktop()) {
    return Promise.resolve({
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      results: [],
      skipped: true,
    });
  }
  if (typeof send !== "function") {
    return Promise.reject(new TypeError("An outbox sender is required"));
  }
  if (replayPromise) return replayPromise;

  replayPromise = (async () => {
    try {
      const database = await openDatabase();
      if (!database) {
        return {
          claimed: 0,
          sent: 0,
          retried: 0,
          failed: 0,
          results: [],
          skipped: true,
        };
      }
      const repository = repositoryFor(database, now);
      await repository.recoverStaleOutbox({ at: now() });
      return replayOutbox({
        repository,
        send,
        limit,
        leaseMs,
        maxAttempts,
        at: now,
      });
    } catch (error) {
      markDatabaseDegraded();
      throw error;
    } finally {
      replayPromise = null;
    }
  })();
  return replayPromise;
}
