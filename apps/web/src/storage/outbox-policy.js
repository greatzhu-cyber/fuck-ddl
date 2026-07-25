export const OUTBOX_LEASE_MS = 30_000;
export const OUTBOX_RETRY_BASE_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 15 * 60 * 1_000;
export const OUTBOX_MAX_ATTEMPTS = 8;

export function outboxRetryDelayMs(
  attempts,
  { baseMs = OUTBOX_RETRY_BASE_MS, maxMs = OUTBOX_RETRY_MAX_MS } = {},
) {
  const safeAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  const safeBase = Math.max(1, Number(baseMs) || OUTBOX_RETRY_BASE_MS);
  const safeMax = Math.max(safeBase, Number(maxMs) || OUTBOX_RETRY_MAX_MS);
  return Math.min(safeMax, safeBase * 2 ** (safeAttempts - 1));
}

export function outboxRetryAt(
  attempts,
  now = new Date().toISOString(),
  options,
) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return new Date(
    timestamp + outboxRetryDelayMs(attempts, options),
  ).toISOString();
}

export function outboxLeaseExpiry(
  now = new Date().toISOString(),
  leaseMs = OUTBOX_LEASE_MS,
) {
  const timestamp = new Date(now).getTime();
  const duration = Math.max(1, Number(leaseMs) || OUTBOX_LEASE_MS);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + duration).toISOString();
}

export function outboxStaleBefore(
  now = new Date().toISOString(),
  leaseMs = OUTBOX_LEASE_MS,
) {
  const timestamp = new Date(now).getTime();
  const duration = Math.max(1, Number(leaseMs) || OUTBOX_LEASE_MS);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp - duration).toISOString();
}
export function outboxAttemptsExhausted(
  attempts,
  maxAttempts = OUTBOX_MAX_ATTEMPTS,
) {
  const current = Math.max(0, Math.floor(Number(attempts) || 0));
  const maximum = Math.max(
    1,
    Math.floor(Number(maxAttempts) || OUTBOX_MAX_ATTEMPTS),
  );
  return current >= maximum;
}
