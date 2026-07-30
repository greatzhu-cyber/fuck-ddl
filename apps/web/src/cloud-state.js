import { resolveSyncConflict } from "./storage/sync-conflict-policy.js";

export const CLOUD_STATE_TABLE = "cloud_state";
export const CLOUD_STATE_PREFIX = "fuck-ddl:v1:";

function isValidEncodedState(key, encodedValue) {
  if (
    typeof key !== "string" ||
    !key.startsWith(CLOUD_STATE_PREFIX) ||
    typeof encodedValue !== "string"
  ) {
    return false;
  }
  try {
    return JSON.parse(encodedValue)?.version === 1;
  } catch {
    return false;
  }
}

export function normalizeCloudStateEntries(input) {
  const pairs = Array.isArray(input)
    ? input.map((entry) =>
        Array.isArray(entry) ? entry : [entry?.stateKey, entry?.encodedValue],
      )
    : Object.entries(input ?? {});
  return pairs.flatMap((entry) => {
    const [stateKey, encodedValue] = entry ?? [];
    return isValidEncodedState(stateKey, encodedValue)
      ? [{ stateKey, encodedValue }]
      : [];
  });
}

function normalizeRemoteRows(rows) {
  return normalizeCloudStateEntries(
    (Array.isArray(rows) ? rows : []).map((row) => [
      row?.state_key,
      row?.encoded_value,
    ]),
  );
}

export function planCloudStateMerge(
  localEntries,
  remoteRows,
  { strategy = "manual" } = {},
) {
  const local = new Map(
    normalizeCloudStateEntries(localEntries).map((entry) => [
      entry.stateKey,
      entry,
    ]),
  );
  const remote = new Map(
    normalizeRemoteRows(remoteRows).map((entry) => [entry.stateKey, entry]),
  );
  const keys = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const plan = {
    localOnly: [],
    remoteOnly: [],
    same: [],
    conflicts: [],
    applyLocal: [],
    applyRemote: [],
  };

  keys.forEach((stateKey) => {
    const localEntry = local.get(stateKey);
    const remoteEntry = remote.get(stateKey);
    if (localEntry && !remoteEntry) {
      plan.localOnly.push(localEntry);
      plan.applyLocal.push(localEntry);
      return;
    }
    if (!localEntry && remoteEntry) {
      plan.remoteOnly.push(remoteEntry);
      plan.applyRemote.push(remoteEntry);
      return;
    }
    if (localEntry.encodedValue === remoteEntry.encodedValue) {
      plan.same.push(localEntry);
      return;
    }

    const conflict = {
      stateKey,
      local: localEntry,
      remote: remoteEntry,
      resolution: resolveSyncConflict(
        { kind: "conflict", localChanged: true, remoteChanged: true },
        { strategy },
      ),
    };
    plan.conflicts.push(conflict);
    if (conflict.resolution.action === "apply-local") {
      plan.applyLocal.push(localEntry);
    } else if (conflict.resolution.action === "apply-remote") {
      plan.applyRemote.push(remoteEntry);
    }
  });

  return plan;
}

export function applyCloudRemoteState(storage, entries) {
  if (!storage || typeof storage.setItem !== "function") return 0;
  let applied = 0;
  for (const entry of normalizeCloudStateEntries(entries)) {
    storage.setItem(entry.stateKey, entry.encodedValue);
    applied += 1;
  }
  return applied;
}

function assertResponse(response) {
  if (response?.error) throw response.error;
  return response?.data ?? [];
}

export function createSupabaseCloudStateClient({
  client,
  userId,
  now = () => new Date().toISOString(),
} = {}) {
  if (!client || typeof client.from !== "function") {
    throw new TypeError("A Supabase client is required");
  }
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new TypeError("An authenticated user id is required");
  }

  return {
    async listState() {
      const response = await client
        .from(CLOUD_STATE_TABLE)
        .select("state_key, encoded_value, version, updated_at, deleted_at")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("state_key", { ascending: true });
      return assertResponse(response);
    },

    async upsertState(entries) {
      const normalized = normalizeCloudStateEntries(entries);
      if (normalized.length === 0) return [];
      const rows = normalized.map(({ stateKey, encodedValue }) => ({
        user_id: userId,
        state_key: stateKey,
        encoded_value: encodedValue,
        version: 1,
        deleted_at: null,
        updated_at: now(),
      }));
      const response = await client
        .from(CLOUD_STATE_TABLE)
        .upsert(rows, { onConflict: "user_id,state_key" })
        .select("state_key, encoded_value, version, updated_at, deleted_at");
      return assertResponse(response);
    },

    async softDeleteState(stateKeys) {
      const keys = [...new Set(stateKeys)].filter(
        (key) => typeof key === "string" && key.startsWith(CLOUD_STATE_PREFIX),
      );
      if (keys.length === 0) return [];
      const response = await client
        .from(CLOUD_STATE_TABLE)
        .update({ deleted_at: now(), updated_at: now() })
        .eq("user_id", userId)
        .in("state_key", keys)
        .is("deleted_at", null)
        .select("state_key, deleted_at");
      return assertResponse(response);
    },

    async probeIsolation(
      targetUserId,
      { stateKey = "fuck-ddl:v1:rls-probe" } = {},
    ) {
      if (
        typeof targetUserId !== "string" ||
        targetUserId.trim() === "" ||
        targetUserId === userId
      ) {
        throw new TypeError("A different target user id is required");
      }

      const visibleRows = assertResponse(
        await client
          .from(CLOUD_STATE_TABLE)
          .select("state_key")
          .eq("user_id", targetUserId)
          .eq("state_key", stateKey)
          .order("state_key", { ascending: true }),
      );
      const updatedRows = assertResponse(
        await client
          .from(CLOUD_STATE_TABLE)
          .update({ updated_at: now() })
          .eq("user_id", targetUserId)
          .eq("state_key", stateKey)
          .select("state_key"),
      );
      const deletedRows = assertResponse(
        await client
          .from(CLOUD_STATE_TABLE)
          .delete()
          .eq("user_id", targetUserId)
          .eq("state_key", stateKey)
          .select("state_key"),
      );
      const result = {
        visible: visibleRows.length,
        updated: updatedRows.length,
        deleted: deletedRows.length,
      };
      if (result.visible || result.updated || result.deleted) {
        throw new Error("cloud-state-rls-isolation-failed");
      }
      return result;
    },

    async syncState(localEntries, { strategy = "manual" } = {}) {
      const remoteRows = await this.listState();
      const plan = planCloudStateMerge(localEntries, remoteRows, { strategy });
      const pushed = await this.upsertState(plan.applyLocal);
      return { ...plan, remoteRows, pushed };
    },
  };
}
