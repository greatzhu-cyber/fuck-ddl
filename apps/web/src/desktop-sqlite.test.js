import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistDesktopState,
  resetDesktopDatabaseForTests,
  restoreDesktopState,
} from "./desktop-sqlite.js";

vi.mock("./integrations/pintia-desktop.js", () => ({
  isTauriDesktop: () => true,
}));

describe("desktop SQLite state mirror", () => {
  beforeEach(() => resetDesktopDatabaseForTests());

  it("restores only valid serialized state rows", async () => {
    const setItem = vi.fn();
    const result = await restoreDesktopState({
      storage: { setItem },
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

  it("writes state through a serialized queue", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const database = { execute };
    const openDatabase = vi.fn().mockResolvedValue(database);
    await Promise.all([
      persistDesktopState("first", '{"version":1,"value":1}', {
        openDatabase,
        now: () => "2026-07-11T00:00:00.000Z",
      }),
      persistDesktopState("second", '{"version":1,"value":2}', {
        openDatabase,
        now: () => "2026-07-11T00:00:01.000Z",
      }),
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toEqual([
      "first",
      '{"version":1,"value":1}',
      "2026-07-11T00:00:00.000Z",
    ]);
  });
});
