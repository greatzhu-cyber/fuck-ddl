import {
  OUTBOX_MAX_ATTEMPTS,
  outboxAttemptsExhausted,
} from "./outbox-policy.js";

function operationIdOf(operation) {
  return String(operation?.operation_id ?? operation?.operationId ?? "").trim();
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? "outbox delivery failed");
}

function deliveryRejected(response) {
  return (
    response === false || response?.ok === false || response?.accepted === false
  );
}

export async function replayOutbox({
  repository,
  send,
  limit = 50,
  at = () => new Date().toISOString(),
  leaseMs,
  maxAttempts = OUTBOX_MAX_ATTEMPTS,
} = {}) {
  const repositoryMethods = [
    "claimOutbox",
    "acknowledgeOutbox",
    "retryOutbox",
    "failOutbox",
  ];
  if (
    !repository ||
    repositoryMethods.some((method) => typeof repository[method] !== "function")
  ) {
    throw new TypeError("A complete outbox repository is required");
  }
  if (typeof send !== "function") {
    throw new TypeError("An outbox sender is required");
  }

  const claimedAt = typeof at === "function" ? at() : at;
  const claimed = await repository.claimOutbox({
    limit,
    at: claimedAt,
    leaseMs,
  });
  const results = [];

  for (const operation of claimed) {
    const operationId = operationIdOf(operation);
    if (!operationId) {
      results.push({ status: "invalid", operation });
      continue;
    }

    try {
      const response = await send({ ...operation, operationId });
      if (deliveryRejected(response)) {
        throw new Error(response?.error ?? "outbox delivery rejected");
      }
    } catch (error) {
      const releasedAt = typeof at === "function" ? at() : at;
      const failure = errorMessage(error);
      const exhausted = outboxAttemptsExhausted(
        operation.attempts,
        maxAttempts,
      );
      try {
        const released = exhausted
          ? await repository.failOutbox(operationId, {
              error: failure,
              at: releasedAt,
              claimedAt: operation.updated_at ?? operation.updatedAt,
            })
          : await repository.retryOutbox(operationId, {
              attempts: operation.attempts,
              error: failure,
              at: releasedAt,
              claimedAt: operation.updated_at ?? operation.updatedAt,
            });
        if (!released) {
          results.push({
            operationId,
            status: "stale",
            error: "outbox lease no longer belongs to this replay",
          });
          continue;
        }
        results.push({
          operationId,
          status: exhausted ? "failed" : "pending",
          error: failure,
        });
      } catch (releaseError) {
        results.push({
          operationId,
          status: "release-failed",
          error: errorMessage(releaseError),
        });
      }
      continue;
    }

    try {
      const acknowledgedAt = typeof at === "function" ? at() : at;
      const acknowledged = await repository.acknowledgeOutbox(
        operationId,
        acknowledgedAt,
        operation.updated_at ?? operation.updatedAt,
      );
      if (!acknowledged) {
        results.push({
          operationId,
          status: "stale",
          error: "outbox lease no longer belongs to this replay",
        });
        continue;
      }
      results.push({ operationId, status: "sent" });
    } catch (error) {
      results.push({
        operationId,
        status: "ack-pending",
        error: errorMessage(error),
      });
    }
  }

  return {
    claimed: claimed.length,
    sent: results.filter((result) => result.status === "sent").length,
    retried: results.filter((result) => result.status === "pending").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}
