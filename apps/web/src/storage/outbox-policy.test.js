import { describe, expect, it } from "vitest";
import {
  outboxAttemptsExhausted,
  outboxLeaseExpiry,
  outboxRetryAt,
  outboxRetryDelayMs,
  outboxStaleBefore,
} from "./outbox-policy.js";

describe("outbox retry policy", () => {
  it("uses capped exponential retry delays", () => {
    expect(outboxRetryDelayMs(1)).toBe(1_000);
    expect(outboxRetryDelayMs(2)).toBe(2_000);
    expect(outboxRetryDelayMs(20)).toBe(15 * 60 * 1_000);
  });

  it("stops automatic retries at the bounded attempt limit", () => {
    expect(outboxAttemptsExhausted(7)).toBe(false);
    expect(outboxAttemptsExhausted(8)).toBe(true);
    expect(outboxAttemptsExhausted(2, 2)).toBe(true);
  });

  it("derives retry and lease timestamps from an explicit clock", () => {
    const now = "2026-07-24T00:00:00.000Z";
    expect(outboxRetryAt(2, now)).toBe("2026-07-24T00:00:02.000Z");
    expect(outboxLeaseExpiry(now, 30_000)).toBe("2026-07-24T00:00:30.000Z");
    expect(outboxStaleBefore(now, 30_000)).toBe("2026-07-23T23:59:30.000Z");
  });

  it("rejects invalid clock values instead of creating a bad schedule", () => {
    expect(outboxRetryAt(1, "not-a-date")).toBeNull();
    expect(outboxLeaseExpiry("not-a-date")).toBeNull();
    expect(outboxStaleBefore("not-a-date")).toBeNull();
  });
});
