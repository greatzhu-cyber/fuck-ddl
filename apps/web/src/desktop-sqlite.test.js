import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapDesktopState,
  flushDesktopState,
  getDesktopDatabaseStatus,
  openDesktopDatabase,
  persistDesktopState,
  persistDesktopStateEntries,
  replayDesktopOutbox,
  resetDesktopDatabaseForTests,
  restoreDesktopState,
} from "./desktop-sqlite.js";

vi.mock("./integrations/pintia-desktop.js", () => ({
  isTauriDesktop: () => true,
}));

function createStorage(initial = {}) {
  const state = new Map(Object.entries(initial));
  return {
    get length() {
      return state.size;
    },
    key(index) {
      return [...state.keys()][index] ?? null;
    },
    getItem(key) {
      return state.get(key) ?? null;
    },
    setItem(key, value) {
      state.set(key, value);
    },
  };
}

describe("desktop SQLite state mirror", () => {
  beforeEach(() => resetDesktopDatabaseForTests());

  it("creates the state table when opening the desktop database", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    const load = vi.fn().mockResolvedValue({ execute });

    await expect(openDesktopDatabase({ load })).resolves.toEqual({ execute });

    expect(load).toHaveBeenCalledWith("sqlite:fuck-ddl.db");
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS app_state"),
    );
  });

  it("restores only valid serialized state rows", async () => {
    const storage = createStorage();
    const setItem = vi.spyOn(storage, "setItem");
    const result = await restoreDesktopState({
      storage,
      openDatabase: async () => ({
        select: async () => [
          {
            state_key: "fuck-ddl:v1:tasks",
            encoded_value: '{"version":1,"value":[]}',
          },
          { state_key: "broken", encoded_value: "not-json" },
        ],
      }),
    });
    expect(result).toEqual({ restored: 1, skipped: false });
    expect(setItem).toHaveBeenCalledWith(
      "fuck-ddl:v1:tasks",
      '{"version":1,"value":[]}',
    );
  });

  it("does not overwrite a valid local value with an older mirror row", async () => {
    const storage = createStorage({
      "fuck-ddl:v1:tasks": '{"version":1,"value":["local"]}',
    });
    const setItem = vi.spyOn(storage, "setItem");

    await expect(
      restoreDesktopState({
        storage,
        openDatabase: async () => ({
          select: async () => [
            {
              state_key: "fuck-ddl:v1:tasks",
              encoded_value: '{"version":1,"value":["database"]}',
            },
          ],
        }),
      }),
    ).resolves.toEqual({ restored: 0, skipped: false });

    expect(setItem).not.toHaveBeenCalled();
    expect(storage.getItem("fuck-ddl:v1:tasks")).toContain("local");
  });

  it("uses SQLite as the startup source of truth when local state is stale", async () => {
    const storage = createStorage({
      "fuck-ddl:v1:tasks": '{"version":1,"value":["one-local-task"]}',
    });
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const databaseTasks = '{"version":1,"value":["thirteen-database-tasks"]}';

    await expect(
      bootstrapDesktopState({
        storage,
        openDatabase: async () => ({
          execute,
          select: async () => [
            {
              state_key: "fuck-ddl:v1:tasks",
              encoded_value: databaseTasks,
            },
          ],
        }),
        now: () => "2026-07-26T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      state: "ready",
      rowCount: 1,
      restored: 1,
      mirrored: 0,
      lastWriteAt: null,
    });

    expect(storage.getItem("fuck-ddl:v1:tasks")).toBe(databaseTasks);
    expect(execute).not.toHaveBeenCalled();
  });

  it("restores missing rows and backfills all valid local business state", async () => {
    const storage = createStorage({
      "fuck-ddl:v1:tasks": '{"version":1,"value":[]}',
      "fuck-ddl:auth": '{"version":1,"value":"secret"}',
      "fuck-ddl:v1:old": '{"version":0,"value":"ignored"}',
    });
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const select = vi.fn().mockResolvedValue([
      {
        state_key: "fuck-ddl:v1:goals",
        encoded_value: '{"version":1,"value":[]}',
      },
    ]);

    await expect(
      bootstrapDesktopState({
        storage,
        openDatabase: async () => ({ execute, select }),
        now: () => "2026-07-23T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      state: "ready",
      rowCount: 2,
      restored: 1,
      mirrored: 1,
      lastWriteAt: "2026-07-23T00:00:00.000Z",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map((call) => call[1][0])).toEqual([
      "fuck-ddl:v1:tasks",
    ]);
  });

  it("reports degraded state while preserving startup fallback on failure", async () => {
    await expect(
      bootstrapDesktopState({
        storage: createStorage(),
        openDatabase: async () => {
          throw new Error("permission denied");
        },
      }),
    ).rejects.toThrow("permission denied");

    expect(getDesktopDatabaseStatus()).toMatchObject({
      state: "degraded",
      rowCount: 0,
    });
  });

  it("blocks stale local state writes after bootstrap failure", async () => {
    const openDatabase = vi
      .fn()
      .mockRejectedValue(new Error("database locked"));

    await expect(
      bootstrapDesktopState({
        storage: createStorage(),
        openDatabase,
      }),
    ).rejects.toThrow("database locked");

    await expect(
      persistDesktopState("fuck-ddl:v1:tasks", '{"version":1,"value":[]}', {
        openDatabase,
      }),
    ).resolves.toBe(false);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it("writes state through a serialized queue", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const database = { execute };
    const openDatabase = vi.fn().mockResolvedValue(database);
    await Promise.all([
      persistDesktopState("fuck-ddl:v1:first", '{"version":1,"value":1}', {
        openDatabase,
        now: () => "2026-07-11T00:00:00.000Z",
      }),
      persistDesktopState("fuck-ddl:v1:second", '{"version":1,"value":2}', {
        openDatabase,
        now: () => "2026-07-11T00:00:01.000Z",
      }),
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toEqual([
      "fuck-ddl:v1:first",
      '{"version":1,"value":1}',
      "2026-07-11T00:00:00.000Z",
    ]);
    expect(getDesktopDatabaseStatus()).toMatchObject({
      state: "ready",
      rowCount: 2,
      lastWriteAt: "2026-07-11T00:00:01.000Z",
    });
  });

  it("flushes writes already queued before desktop exit", async () => {
    let release;
    const execute = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const openDatabase = vi.fn().mockResolvedValue({ execute });
    const write = persistDesktopState(
      "fuck-ddl:v1:tasks",
      '{"version":1,"value":[]}',
      { openDatabase, now: () => "2026-07-26T00:00:00.000Z" },
    );

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const flush = flushDesktopState();
    let settled = false;
    void flush.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release({ rowsAffected: 1 });
    await expect(write).resolves.toBe(true);
    await expect(flush).resolves.toBe(true);
  });
  it("persists every imported state row before the next reload", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const openDatabase = vi.fn().mockResolvedValue({ execute });
    const entries = [
      ["fuck-ddl:v1:tasks", '{"version":1,"value":["restored"]}'],
      ["fuck-ddl:v1:goals", '{"version":1,"value":[]}'],
    ];

    await expect(
      persistDesktopStateEntries(entries, { openDatabase }),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((call) => call[1][0])).toEqual([
      "fuck-ddl:v1:tasks",
      "fuck-ddl:v1:goals",
    ]);
  });

  it("rejects non-business or malformed state before it reaches SQLite", async () => {
    const openDatabase = vi.fn();

    await expect(
      persistDesktopState("fuck-ddl:auth", '{"version":1,"value":"secret"}', {
        openDatabase,
      }),
    ).resolves.toBe(false);
    await expect(
      persistDesktopState("fuck-ddl:v1:tasks", "not-json", { openDatabase }),
    ).resolves.toBe(false);

    expect(openDatabase).not.toHaveBeenCalled();
  });
  it("runs only one desktop outbox replay at a time", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const select = vi.fn().mockResolvedValue([
      {
        operation_id: "op-1",
        status: "pending",
        attempts: 0,
        updated_at: "2026-07-25T00:00:00.000Z",
      },
    ]);
    const openDatabase = vi.fn().mockResolvedValue({ execute, select });
    const send = vi.fn().mockResolvedValue({ ok: true });
    const now = () => "2026-07-25T00:00:00.000Z";

    const [first, second] = await Promise.all([
      replayDesktopOutbox(send, { openDatabase, now }),
      replayDesktopOutbox(send, { openDatabase, now }),
    ]);

    expect(first).toMatchObject({ claimed: 1, sent: 1 });
    expect(second).toEqual(first);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
