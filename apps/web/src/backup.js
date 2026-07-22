const BACKUP_VERSION = 1;
const STATE_PREFIX = "fuck-ddl:v1:";
const PRE_IMPORT_KEY = "fuck-ddl:backup:pre-import";

export function createBackupDocument(storage, now = new Date()) {
  const state = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(STATE_PREFIX)) continue;
    const encoded = storage.getItem(key);
    try {
      const parsed = JSON.parse(encoded);
      if (parsed?.version === 1) state[key] = encoded;
    } catch {
      // Skip malformed rows instead of exporting an unusable backup.
    }
  }
  return {
    format: "fuck-ddl-backup",
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    state,
  };
}

export function restoreBackupDocument(document, storage) {
  if (
    document?.format !== "fuck-ddl-backup" ||
    document?.version !== BACKUP_VERSION ||
    !document.state ||
    typeof document.state !== "object"
  ) {
    throw new Error("backup-format-invalid");
  }
  const validEntries = Object.entries(document.state).filter(([key, value]) => {
    if (!key.startsWith(STATE_PREFIX) || typeof value !== "string")
      return false;
    try {
      return JSON.parse(value)?.version === 1;
    } catch {
      return false;
    }
  });
  if (validEntries.length === 0) throw new Error("backup-empty");

  storage.setItem(
    PRE_IMPORT_KEY,
    JSON.stringify(createBackupDocument(storage)),
  );
  validEntries.forEach(([key, value]) => storage.setItem(key, value));
  return validEntries.length;
}

export function downloadBackupDocument(
  document,
  documentObject = window.document,
) {
  const blob = new Blob([JSON.stringify(document, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = documentObject.createElement("a");
  link.href = url;
  link.download = `fuck-ddl-backup-${document.createdAt.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
