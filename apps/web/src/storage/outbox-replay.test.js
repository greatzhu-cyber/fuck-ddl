import { describe, expect, it, vi } from "vitest";
import { replayOutbox } from "./outbox-replay.js";

function createRepository(operations) {
  return {
    claimOutbox: vi.fn().mockResolvedValue(operations),
    acknowledgeOutbox: vi.fn().mockResolvedValue(true),
    retryOutbox: vi.fn().mockResolvedValue(true),
    failOutbox: vi.fn().mockResolvedValue(true),
  };
}

describe("offline outbox replay", () => {
  it("passes the idempotency key to the sender and acknowledges success", async () => {
    const repository = createRepository([
      { operation_id: "op-1", attempts: 1, payload: '{"title":"A"}' },
    ]);
    const send = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      replayOutbox({
        repository,
        send,
        at: () => "2026-07-24T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({ claimed: 1, sent: 1, retried: 0 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-1" }),
    );
    expect(repository.acknowledgeOutbox).toHaveBeenCalledWith(
      "op-1",
      "2026-07-24T01:00:00.000Z",
      undefined,
    );
  });

  it("returns rejected delivery to pending with the original attempt count", async () => {
    const repository = createRepository([
      { operation_id: "op-2", attempts: 2 },
    ]);

    const result = await replayOutbox({
      repository,
      send: vi.fn().mockResolvedValue({ ok: false, error: "offline" }),
      at: () => "2026-07-24T01:00:00.000Z",
    });

    expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
    expect(repository.retryOutbox).toHaveBeenCalledWith(
      "op-2",
      expect.objectContaining({ attempts: 2, error: "offline" }),
    );
  });

  it("moves an exhausted operation to failed instead of retrying forever", async () => {
    const repository = createRepository([
      {
        operation_id: "op-failed",
        attempts: 8,
        updated_at: "2026-07-24T01:00:00.000Z",
      },
    ]);

    await expect(
      replayOutbox({
        repository,
        send: vi.fn().mockRejectedValue(new Error("still offline")),
      }),
    ).resolves.toMatchObject({
      sent: 0,
      retried: 0,
      failed: 1,
      results: [{ operationId: "op-failed", status: "failed" }],
    });
    expect(repository.failOutbox).toHaveBeenCalledWith(
      "op-failed",
      expect.objectContaining({
        error: "still offline",
        claimedAt: "2026-07-24T01:00:00.000Z",
      }),
    );
    expect(repository.retryOutbox).not.toHaveBeenCalled();
  });

  it("leaves an acknowledged operation in-flight when acknowledgement fails", async () => {
    const repository = createRepository([{ operation_id: "op-3" }]);
    repository.acknowledgeOutbox.mockRejectedValue(new Error("db locked"));

    await expect(
      replayOutbox({ repository, send: vi.fn().mockResolvedValue(true) }),
    ).resolves.toMatchObject({
      claimed: 1,
      sent: 0,
      retried: 0,
      results: [{ operationId: "op-3", status: "ack-pending" }],
    });
    expect(repository.retryOutbox).not.toHaveBeenCalled();
  });

  it("does not confirm a lease that has already been recycled", async () => {
    const repository = createRepository([
      {
        operation_id: "op-stale",
        attempts: 1,
        updated_at: "2026-07-24T01:00:00.000Z",
      },
    ]);
    repository.acknowledgeOutbox.mockResolvedValue(false);

    await expect(
      replayOutbox({ repository, send: vi.fn().mockResolvedValue(true) }),
    ).resolves.toMatchObject({
      sent: 0,
      retried: 0,
      results: [{ operationId: "op-stale", status: "stale" }],
    });
  });

  it("fails fast when the replay boundary is incomplete", async () => {
    await expect(replayOutbox({ send: vi.fn() })).rejects.toThrow(
      "outbox repository",
    );
    await expect(
      replayOutbox({ repository: createRepository([]) }),
    ).rejects.toThrow("outbox sender");
  });
});
