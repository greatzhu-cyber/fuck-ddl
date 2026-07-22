import { describe, expect, it } from "vitest";
import {
  createFocusState,
  pauseFocus,
  resetForNewDay,
  resumeFromDistraction,
  startDistraction,
  startFocus,
  startRest,
  stopFocus,
  tickFocus,
} from "./focus.js";

const preset = {
  id: "test",
  label: "15+5",
  focusMinutes: 15,
  breakMinutes: 5,
  system: false,
};

describe("focus state machine", () => {
  it("completes one timer and credits its configured break", () => {
    let state = startFocus(createFocusState(), preset, "task-1");
    state = { ...state, focusSeconds: 15 * 60 - 1 };
    state = tickFocus(state, preset);
    expect(state.phase).toBe("focus-complete");
    expect(state.restBalanceSeconds).toBe(5 * 60);
    expect(state.completedPomodorosToday).toBe(1);
    expect(state.pendingProgressTaskId).toBe("task-1");
  });

  it("does not count paused seconds", () => {
    const state = pauseFocus(startFocus(createFocusState(), preset));
    expect(tickFocus(state, preset)).toEqual(state);
  });

  it("saves partial focus and credits only sessions of at least 15 minutes", () => {
    let state = startFocus(createFocusState(), preset, "task-1");
    state = stopFocus({ ...state, focusSeconds: 14 * 60 }, preset);
    expect(state.restBalanceSeconds).toBe(0);

    state = startFocus(createFocusState(), preset, "task-1");
    state = stopFocus({ ...state, focusSeconds: 15 * 60 }, preset);
    expect(state.restBalanceSeconds).toBe(5 * 60);
  });

  it("allows rest and distraction to spend the balance below zero", () => {
    let rest = startRest({ ...createFocusState(), restBalanceSeconds: 0 });
    rest = tickFocus(rest, preset);
    expect(rest.restBalanceSeconds).toBe(-1);
    expect(rest.formalRestSecondsToday).toBe(1);

    let distracted = startFocus(createFocusState(), preset);
    distracted = startDistraction(distracted, "example.com");
    distracted = tickFocus(distracted, preset);
    expect(distracted.distractionSecondsToday).toBe(1);
    expect(distracted.restBalanceSeconds).toBe(-1);
    expect(resumeFromDistraction(distracted).phase).toBe("focusing");
  });

  it("resets daily accounting without changing the selected mode", () => {
    const state = {
      ...createFocusState(new Date(2026, 6, 7)),
      modeId: "50+10",
      restBalanceSeconds: -300,
    };
    const next = resetForNewDay(state, new Date(2026, 6, 8));
    expect(next.modeId).toBe("50+10");
    expect(next.restBalanceSeconds).toBe(0);
  });
});
