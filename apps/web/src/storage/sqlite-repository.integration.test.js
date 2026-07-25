import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replayOutbox } from "./outbox-replay.js";
import { createSqliteRepository } from "./sqlite-repository.js";

const databases = [];

function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  return {
    async execute(sql, params = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        sqlite.exec(sql);
        return { rowsAffected: 0 };
      }
      const result = sqlite.prepare(sql).run(...params);
      return { rowsAffected: Number(result.changes) };
    },
    async select(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
  };
}

function operation(operationId = "op-1") {
  return {
    operationId,
    entityType: "task",
    entityId: "task-1",
    operationKind: "upsert",
    payload: { title: "完成作业" },
    version: 1,
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop().close();
});

describe("SQLite outbox recovery integration", () => {
  it("does not resurrect a sent operation when the same id is enqueued again", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-25T00:00:00.000Z",
    });
    await repository.ensureSchema();
    await repository.enqueueOutbox(operation());
    const [claimed] = await repository.claimOutbox({
      at: "2026-07-25T00:00:00.000Z",
    });

    await expect(
      repository.acknowledgeOutbox(
        "op-1",
        "2026-07-25T00:00:01.000Z",
        claimed.updated_at,
      ),
    ).resolves.toBe(true);
    await repository.enqueueOutbox({ ...operation(), version: 2 });

    await expect(
      database.select(
        "SELECT status, version FROM sync_outbox WHERE operation_id = ?",
        ["op-1"],
      ),
    ).resolves.toEqual([{ status: "sent", version: 1 }]);
  });

  it("recovers only after the actual lease expiry and fences the old owner", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-25T00:00:00.000Z",
    });
    await repository.ensureSchema();
    await repository.enqueueOutbox(operation());
    const [firstClaim] = await repository.claimOutbox({
      at: "2026-07-25T00:00:00.000Z",
      leaseMs: 30_000,
    });

    await expect(
      repository.recoverStaleOutbox({ at: "2026-07-25T00:00:29.000Z" }),
    ).resolves.toBe(false);
    await expect(
      repository.recoverStaleOutbox({ at: "2026-07-25T00:00:31.000Z" }),
    ).resolves.toBe(true);
    const [secondClaim] = await repository.claimOutbox({
      at: "2026-07-25T00:00:31.000Z",
      leaseMs: 30_000,
    });

    await expect(
      repository.acknowledgeOutbox(
        "op-1",
        "2026-07-25T00:00:32.000Z",
        firstClaim.updated_at,
      ),
    ).resolves.toBe(false);
    await expect(
      repository.acknowledgeOutbox(
        "op-1",
        "2026-07-25T00:00:32.000Z",
        secondClaim.updated_at,
      ),
    ).resolves.toBe(true);
  });

  it("stops claiming an operation after it reaches the terminal failure limit", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-25T00:00:00.000Z",
    });
    await repository.ensureSchema();
    await repository.enqueueOutbox(operation("op-terminal"));
    const send = vi.fn().mockResolvedValue({ ok: false, error: "offline" });

    await expect(
      replayOutbox({
        repository,
        send,
        maxAttempts: 1,
        at: () => "2026-07-25T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ failed: 1, retried: 0 });
    await expect(
      replayOutbox({
        repository,
        send,
        maxAttempts: 1,
        at: () => "2026-07-25T00:01:00.000Z",
      }),
    ).resolves.toMatchObject({ claimed: 0 });

    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      database.select(
        "SELECT status, last_error FROM sync_outbox WHERE operation_id = ?",
        ["op-terminal"],
      ),
    ).resolves.toEqual([{ status: "failed", last_error: "offline" }]);
  });

  it("replays after an acknowledgement crash without applying the remote change twice", async () => {
    const database = createDatabase();
    const repository = createSqliteRepository(database, {
      now: () => "2026-07-25T00:00:00.000Z",
    });
    await repository.ensureSchema();
    await repository.enqueueOutbox(operation("op-crash"));
    const applied = new Set();
    let appliedCount = 0;
    const send = vi.fn(async ({ operationId }) => {
      if (!applied.has(operationId)) {
        applied.add(operationId);
        appliedCount += 1;
      }
      return { ok: true };
    });
    const crashRepository = {
      claimOutbox: (...args) => repository.claimOutbox(...args),
      retryOutbox: (...args) => repository.retryOutbox(...args),
      failOutbox: (...args) => repository.failOutbox(...args),
      acknowledgeOutbox: vi.fn().mockRejectedValue(new Error("db locked")),
    };

    await expect(
      replayOutbox({
        repository: crashRepository,
        send,
        at: () => "2026-07-25T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      results: [{ operationId: "op-crash", status: "ack-pending" }],
    });

    await repository.recoverStaleOutbox({
      at: "2026-07-25T00:00:31.000Z",
    });
    await expect(
      replayOutbox({
        repository,
        send,
        at: () => "2026-07-25T00:00:31.000Z",
      }),
    ).resolves.toMatchObject({ sent: 1 });

    expect(send).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(new Set(["op-crash"]));
    expect(appliedCount).toBe(1);
    await expect(
      database.select("SELECT status FROM sync_outbox WHERE operation_id = ?", [
        "op-crash",
      ]),
    ).resolves.toEqual([{ status: "sent" }]);
  });
});
