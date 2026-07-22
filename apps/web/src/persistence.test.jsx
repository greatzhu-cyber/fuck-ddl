import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodePersistedState,
  encodePersistedState,
  isTaskList,
  STORAGE_KEYS,
  usePersistentState,
} from "./persistence.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("versioned local persistence", () => {
  it("round-trips valid state", () => {
    const value = [
      { id: "task-1", title: "任务", progress: 0, deadlineHours: 1 },
    ];
    expect(
      decodePersistedState(encodePersistedState(value), [], isTaskList),
    ).toEqual(value);
  });

  it("falls back for malformed, old or invalid data", () => {
    const fallback = [{ id: "fallback" }];
    expect(decodePersistedState("not-json", fallback)).toBe(fallback);
    expect(decodePersistedState('{"version":0,"value":[]}', fallback)).toBe(
      fallback,
    );
    expect(
      decodePersistedState(
        encodePersistedState([{ title: "缺少 ID" }]),
        fallback,
        isTaskList,
      ),
    ).toBe(fallback);
  });

  it("persists hook updates in a versioned envelope", () => {
    const { result } = renderHook(() =>
      usePersistentState(STORAGE_KEYS.timerSeconds, 10, (value) =>
        Number.isFinite(value),
      ),
    );

    act(() => result.current[1](25));
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEYS.timerSeconds)),
    ).toEqual({
      version: 1,
      value: 25,
    });
  });
});
