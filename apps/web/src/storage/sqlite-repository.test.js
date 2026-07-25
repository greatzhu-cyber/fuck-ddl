import { describe, expect, it, vi } from "vitest";
import {
  createSqliteRepository,
  normalizeOutboxOperation,
} from "./sqlite-repository.js";
import { SCHEMA_STATEMENTS } from "./sqlite-schema.js";

function createDatabase() {
  return {
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    select: vi.fn().mockResolvedValue([]),
  };
}

describe("SQLite repository boundary", () => {
  it("applies the schema in one transaction", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-24T00:00:00.000Z",
    });

    await repository.ensureSchema();

    expect(database.execute.mock.calls[0][0]).toBe("BEGIN");
    expect(
      database.execute.mock.calls.slice(1, -1).map(([sql]) => sql),
    ).toEqual(SCHEMA_STATEMENTS);
    expect(database.execute.mock.calls.at(-1)[0]).toBe("COMMIT");
  });

  it("rolls back a failed schema transaction", async () => {
    const database = createDatabase();
    database.execute
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("migration failed"))
      .mockResolvedValue({});
    const repository = createSqliteRepository(database);

    await expect(repository.ensureSchema()).rejects.toThrow("migration failed");
    expect(database.execute.mock.calls.at(-1)[0]).toBe("ROLLBACK");
  });

  it("normalizes and enqueues an idempotent operation", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-24T00:00:00.000Z",
    });

    await expect(
      repository.enqueueOutbox({
        operationId: "op-1",
        entityType: "task",
        entityId: "task-1",
        operationKind: "upsert",
        payload: { title: "完成作业" },
        version: 3,
      }),
    ).resolves.toBe(true);

    expect(database.execute).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT(operation_id) DO NOTHING"),
      [
        "op-1",
        "task",
        "task-1",
        "upsert",
        '{"title":"完成作业"}',
        3,
        "pending",
        0,
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
        null,
      ],
    );
  });

  it("rejects incomplete operations before touching SQLite", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database);

    await expect(
      repository.enqueueOutbox({ entityType: "task" }),
    ).resolves.toBe(false);
    expect(database.execute).not.toHaveBeenCalled();
    expect(normalizeOutboxOperation({ operationId: "op-1" })).toBeNull();
  });

  it("reads ready operations and advances cursors through the boundary", async () => {
    const database = createDatabase();
    database.select
      .mockResolvedValueOnce([{ operation_id: "op-1" }])
      .mockResolvedValueOnce([
        {
          source_name: "PTA",
          cursor_value: "cursor-2",
          updated_at: "2026-07-24T00:00:00.000Z",
        },
      ]);
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-24T00:01:00.000Z",
    });

    await expect(
      repository.listPendingOutbox({
        limit: 10,
        at: "2026-07-24T00:00:00.000Z",
      }),
    ).resolves.toEqual([{ operation_id: "op-1" }]);
    await expect(repository.readSyncCursor("PTA")).resolves.toMatchObject({
      cursor_value: "cursor-2",
    });
    await expect(repository.writeSyncCursor("PTA", "cursor-3")).resolves.toBe(
      true,
    );
    expect(database.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO sync_cursors"),
      ["PTA", "cursor-3", "2026-07-24T00:01:00.000Z"],
    );
  });
});

describe("SQLite outbox execution boundary", () => {
  it("claims pending operations under a lease", async () => {
    const database = createDatabase();
    database.select.mockResolvedValue([
      {
        operation_id: "op-1",
        attempts: 0,
        status: "pending",
      },
    ]);
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-24T00:00:00.000Z",
    });

    await expect(
      repository.claimOutbox({
        limit: 1,
        at: "2026-07-24T00:00:00.000Z",
        leaseMs: 30_000,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        operation_id: "op-1",
        status: "in-flight",
        attempts: 1,
        available_at: "2026-07-24T00:00:30.000Z",
      }),
    ]);
    expect(database.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("UPDATE sync_outbox SET status = ?"),
      [
        "in-flight",
        "2026-07-24T00:00:30.000Z",
        "2026-07-24T00:00:00.000Z",
        "op-1",
        "pending",
      ],
    );
  });

  it("acknowledges and retries claimed operations without losing the idempotency key", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-24T00:00:00.000Z",
    });

    await expect(
      repository.acknowledgeOutbox(
        "op-1",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      ),
    ).resolves.toBe(true);
    await expect(
      repository.retryOutbox("op-1", {
        attempts: 2,
        error: "temporary failure",
        at: "2026-07-24T00:00:00.000Z",
        claimedAt: "2026-07-24T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    expect(database.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("status = ?, available_at = ?"),
      [
        "pending",
        "2026-07-24T00:00:02.000Z",
        "2026-07-24T00:00:00.000Z",
        "temporary failure",
        "op-1",
        "in-flight",
        "2026-07-24T00:00:00.000Z",
      ],
    );
  });

  it("marks an exhausted leased operation as terminally failed", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database);

    await expect(
      repository.failOutbox("op-1", {
        error: "retry limit reached",
        at: "2026-07-24T00:01:00.000Z",
        claimedAt: "2026-07-24T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    expect(database.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("status = ? AND updated_at = ?"),
      [
        "failed",
        "2026-07-24T00:01:00.000Z",
        "retry limit reached",
        "op-1",
        "in-flight",
        "2026-07-24T00:00:00.000Z",
      ],
    );
  });

  it("recovers leases left in flight after a crash", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-24T00:01:00.000Z",
    });

    await expect(
      repository.recoverStaleOutbox({
        at: "2026-07-24T00:01:00.000Z",
        leaseMs: 30_000,
      }),
    ).resolves.toBe(true);
    expect(database.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("status = ? AND available_at <= ?"),
      [
        "pending",
        "2026-07-24T00:01:00.000Z",
        "2026-07-24T00:01:00.000Z",
        "lease-expired",
        "in-flight",
        "2026-07-24T00:01:00.000Z",
      ],
    );
  });

  it("rejects an acknowledgement from an expired lease owner", async () => {
    const database = createDatabase();
    database.execute.mockResolvedValue({ rowsAffected: 0 });
    const repository = createSqliteRepository(database);

    await expect(
      repository.acknowledgeOutbox(
        "op-1",
        "2026-07-24T00:01:00.000Z",
        "2026-07-24T00:00:00.000Z",
      ),
    ).resolves.toBe(false);
    expect(database.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("AND updated_at = ?"),
      [
        "sent",
        "2026-07-24T00:01:00.000Z",
        null,
        "op-1",
        "in-flight",
        "2026-07-24T00:00:00.000Z",
      ],
    );
  });
});
