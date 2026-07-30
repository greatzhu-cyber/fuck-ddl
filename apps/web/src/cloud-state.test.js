import { describe, expect, it, vi } from "vitest";
import {
  applyCloudRemoteState,
  createSupabaseCloudStateClient,
  normalizeCloudStateEntries,
  planCloudStateMerge,
} from "./cloud-state.js";

const state = (value) => JSON.stringify({ version: 1, value });

function fakeClient(response = { data: [], error: null }) {
  const mutation = {
    eq: vi.fn(() => mutation),
    in: vi.fn(() => mutation),
    is: vi.fn(() => mutation),
    select: vi.fn(() => Promise.resolve(response)),
  };
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    order: vi.fn(() => Promise.resolve(response)),
    upsert: vi.fn(() => ({
      select: vi.fn(() => Promise.resolve(response)),
    })),
    update: vi.fn(() => mutation),
    delete: vi.fn(() => mutation),
  };
  return {
    query,
    from: vi.fn(() => query),
  };
}

describe("staging cloud state contract", () => {
  it("keeps only versioned business state and excludes auth/session keys", () => {
    expect(
      normalizeCloudStateEntries({
        "fuck-ddl:v1:tasks": state([]),
        "fuck-ddl:auth": state("must-not-upload"),
        "fuck-ddl:v1:broken": "not-json",
      }),
    ).toEqual([{ stateKey: "fuck-ddl:v1:tasks", encodedValue: state([]) }]);
  });

  it("holds conflicting state unless a strategy is explicitly selected", () => {
    const local = [["fuck-ddl:v1:tasks", state(["local"])]];
    const remote = [
      { state_key: "fuck-ddl:v1:tasks", encoded_value: state(["remote"]) },
    ];
    expect(planCloudStateMerge(local, remote).conflicts[0].resolution).toEqual({
      action: "hold",
      strategy: "manual",
    });
    expect(
      planCloudStateMerge(local, remote, { strategy: "local-wins" }).applyLocal,
    ).toHaveLength(1);
    expect(
      planCloudStateMerge(local, remote, { strategy: "remote-wins" })
        .applyRemote,
    ).toHaveLength(1);
  });

  it("merges non-conflicting local-only and remote-only state", () => {
    const local = [["fuck-ddl:v1:tasks", state(["local-only"])]];
    const remote = [
      { state_key: "fuck-ddl:v1:goals", encoded_value: state(["remote-only"]) },
    ];
    const manual = planCloudStateMerge(local, remote);
    expect(manual.localOnly).toHaveLength(1);
    expect(manual.remoteOnly).toHaveLength(1);
    expect(manual.applyLocal).toHaveLength(1);
    expect(manual.applyRemote).toHaveLength(1);

    const storageState = new Map();
    const storage = {
      setItem: (key, value) => storageState.set(key, value),
    };
    expect(applyCloudRemoteState(storage, manual.applyRemote)).toBe(1);
    expect(storageState.get("fuck-ddl:v1:goals")).toBe(state(["remote-only"]));
  });

  it("probes cross-user read, update, and delete with the real client contract", async () => {
    const client = fakeClient({ data: [], error: null });
    const cloud = createSupabaseCloudStateClient({
      client,
      userId: "user-a",
      now: () => "2026-07-29T00:00:00.000Z",
    });
    await expect(cloud.probeIsolation("user-b")).resolves.toEqual({
      visible: 0,
      updated: 0,
      deleted: 0,
    });
    expect(client.query.update).toHaveBeenCalledWith({
      updated_at: "2026-07-29T00:00:00.000Z",
    });
    expect(client.query.delete).toHaveBeenCalledTimes(1);

    const exposed = createSupabaseCloudStateClient({
      client: fakeClient({
        data: [{ state_key: "fuck-ddl:v1:rls-probe" }],
        error: null,
      }),
      userId: "user-a",
    });
    await expect(exposed.probeIsolation("user-b")).rejects.toThrow(
      "cloud-state-rls-isolation-failed",
    );
  });

  it("uses the authenticated user id and reports Supabase errors", async () => {
    const client = fakeClient({
      data: [{ state_key: "fuck-ddl:v1:tasks" }],
      error: null,
    });
    const cloud = createSupabaseCloudStateClient({
      client,
      userId: "user-a",
      now: () => "2026-07-27T00:00:00.000Z",
    });
    await expect(
      cloud.upsertState([["fuck-ddl:v1:tasks", state([])]]),
    ).resolves.toEqual([{ state_key: "fuck-ddl:v1:tasks" }]);
    expect(client.from).toHaveBeenCalledWith("cloud_state");
    expect(client.query.upsert).toHaveBeenCalledWith(
      [
        {
          user_id: "user-a",
          state_key: "fuck-ddl:v1:tasks",
          encoded_value: state([]),
          version: 1,
          deleted_at: null,
          updated_at: "2026-07-27T00:00:00.000Z",
        },
      ],
      { onConflict: "user_id,state_key" },
    );

    const failing = fakeClient({ data: null, error: new Error("RLS denied") });
    const failingCloud = createSupabaseCloudStateClient({
      client: failing,
      userId: "user-a",
    });
    await expect(
      failingCloud.upsertState([["fuck-ddl:v1:tasks", state([])]]),
    ).rejects.toThrow("RLS denied");
  });
});
