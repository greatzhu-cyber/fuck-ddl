export const SYNC_CONFLICT_STRATEGIES = Object.freeze([
  "manual",
  "local-wins",
  "remote-wins",
]);

export function classifySyncConflict({
  localChanged = false,
  remoteChanged = false,
  localVersion = 0,
  remoteVersion = 0,
} = {}) {
  if (localChanged && remoteChanged) {
    return {
      kind: "conflict",
      localVersion: Math.max(0, Number(localVersion) || 0),
      remoteVersion: Math.max(0, Number(remoteVersion) || 0),
    };
  }
  if (localChanged) return { kind: "local-only" };
  if (remoteChanged) return { kind: "remote-only" };
  return { kind: "none" };
}

export function resolveSyncConflict(conflict, { strategy = "manual" } = {}) {
  const selected = SYNC_CONFLICT_STRATEGIES.includes(strategy)
    ? strategy
    : "manual";
  const kind = conflict?.kind ?? "none";
  if (kind === "local-only")
    return { action: "apply-local", strategy: selected };
  if (kind === "remote-only") {
    return { action: "apply-remote", strategy: selected };
  }
  if (kind !== "conflict") return { action: "noop", strategy: selected };
  if (selected === "local-wins") {
    return { action: "apply-local", strategy: selected };
  }
  if (selected === "remote-wins") {
    return { action: "apply-remote", strategy: selected };
  }
  return { action: "hold", strategy: "manual" };
}
