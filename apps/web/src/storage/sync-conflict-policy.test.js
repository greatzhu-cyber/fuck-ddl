import { describe, expect, it } from "vitest";
import {
  classifySyncConflict,
  resolveSyncConflict,
  SYNC_CONFLICT_STRATEGIES,
} from "./sync-conflict-policy.js";

describe("sync conflict policy", () => {
  it("classifies local-only, remote-only, and simultaneous changes", () => {
    expect(classifySyncConflict({ localChanged: true })).toEqual({
      kind: "local-only",
    });
    expect(classifySyncConflict({ remoteChanged: true })).toEqual({
      kind: "remote-only",
    });
    expect(
      classifySyncConflict({
        localChanged: true,
        remoteChanged: true,
        localVersion: 3,
        remoteVersion: 4,
      }),
    ).toEqual({ kind: "conflict", localVersion: 3, remoteVersion: 4 });
  });

  it("holds simultaneous changes by default and resolves only by explicit policy", () => {
    const conflict = classifySyncConflict({
      localChanged: true,
      remoteChanged: true,
    });
    expect(resolveSyncConflict(conflict)).toEqual({
      action: "hold",
      strategy: "manual",
    });
    expect(resolveSyncConflict(conflict, { strategy: "local-wins" })).toEqual({
      action: "apply-local",
      strategy: "local-wins",
    });
    expect(resolveSyncConflict(conflict, { strategy: "remote-wins" })).toEqual({
      action: "apply-remote",
      strategy: "remote-wins",
    });
  });

  it("normalizes unknown strategies to manual and keeps equal state untouched", () => {
    expect(SYNC_CONFLICT_STRATEGIES).toEqual([
      "manual",
      "local-wins",
      "remote-wins",
    ]);
    expect(
      resolveSyncConflict(classifySyncConflict(), { strategy: "latest-wins" }),
    ).toEqual({ action: "noop", strategy: "manual" });
  });
});
