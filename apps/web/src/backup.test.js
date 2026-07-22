import { describe, expect, it } from "vitest";
import { createBackupDocument, restoreBackupDocument } from "./backup.js";

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("local backup contract", () => {
  it("exports only versioned business state and excludes auth or sessions", () => {
    const storage = memoryStorage({
      "fuck-ddl:v1:tasks": '{"version":1,"value":[]}',
      "fuck-ddl:auth": "secret-session",
      other: "ignored",
    });
    const backup = createBackupDocument(
      storage,
      new Date("2026-07-11T12:00:00.000Z"),
    );
    expect(Object.keys(backup.state)).toEqual(["fuck-ddl:v1:tasks"]);
  });

  it("keeps a pre-import snapshot and restores valid rows", () => {
    const storage = memoryStorage({
      "fuck-ddl:v1:tasks": '{"version":1,"value":["old"]}',
    });
    const restored = restoreBackupDocument(
      {
        format: "fuck-ddl-backup",
        version: 1,
        state: {
          "fuck-ddl:v1:tasks": '{"version":1,"value":["new"]}',
          "fuck-ddl:auth": "must-not-restore",
        },
      },
      storage,
    );
    expect(restored).toBe(1);
    expect(storage.getItem("fuck-ddl:v1:tasks")).toContain("new");
    expect(storage.getItem("fuck-ddl:backup:pre-import")).toContain("old");
    expect(storage.getItem("fuck-ddl:auth")).toBeNull();
  });
});
