import { earnedBreakSeconds } from "@fuck-ddl/domain";

export const FOCUS_PHASES = Object.freeze([
  "idle",
  "focusing",
  "paused",
  "focus-complete",
  "resting",
  "distracted",
]);

export const defaultPresets = Object.freeze([
  {
    id: "25+5",
    label: "25+5",
    focusMinutes: 25,
    breakMinutes: 5,
    system: true,
  },
  {
    id: "50+10",
    label: "50+10",
    focusMinutes: 50,
    breakMinutes: 10,
    system: true,
  },
  {
    id: "free",
    label: "自由计时",
    focusMinutes: null,
    breakMinutes: 5,
    system: true,
  },
]);

export function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createFocusState(date = new Date()) {
  return {
    phase: "idle",
    sessionId: null,
    modeId: "25+5",
    taskId: null,
    focusSeconds: 0,
    targetFocusSeconds: 25 * 60,
    restBalanceSeconds: 0,
    focusedSecondsToday: 0,
    formalRestSecondsToday: 0,
    distractionSecondsToday: 0,
    completedPomodorosToday: 0,
    interruptedSessionsToday: 0,
    pendingProgressTaskId: null,
    distractionDomain: null,
    dayKey: localDayKey(date),
  };
}

export function isFocusState(value) {
  return (
    value &&
    FOCUS_PHASES.includes(value.phase) &&
    typeof value.modeId === "string" &&
    Number.isFinite(value.focusSeconds) &&
    Number.isFinite(value.restBalanceSeconds) &&
    Number.isFinite(value.focusedSecondsToday) &&
    Number.isFinite(value.formalRestSecondsToday) &&
    Number.isFinite(value.distractionSecondsToday) &&
    typeof value.dayKey === "string"
  );
}

export function resetForNewDay(state, date = new Date()) {
  const dayKey = localDayKey(date);
  if (state.dayKey === dayKey) return state;
  return {
    ...createFocusState(date),
    modeId: state.modeId,
  };
}

export function startFocus(state, preset, taskId = null, now = Date.now()) {
  return {
    ...state,
    phase: "focusing",
    sessionId: `focus-${now}`,
    modeId: preset.id,
    taskId,
    focusSeconds: 0,
    targetFocusSeconds:
      preset.focusMinutes === null ? null : preset.focusMinutes * 60,
    pendingProgressTaskId: null,
    distractionDomain: null,
  };
}

export function pauseFocus(state) {
  if (state.phase === "focusing") return { ...state, phase: "paused" };
  if (state.phase === "paused") return { ...state, phase: "focusing" };
  return state;
}

export function tickFocus(state, preset) {
  if (state.phase === "focusing") {
    const focusSeconds = state.focusSeconds + 1;
    const completed =
      state.targetFocusSeconds !== null &&
      focusSeconds >= state.targetFocusSeconds;
    return {
      ...state,
      phase: completed ? "focus-complete" : "focusing",
      focusSeconds,
      focusedSecondsToday: state.focusedSecondsToday + 1,
      restBalanceSeconds: completed
        ? state.restBalanceSeconds + earnedBreakSeconds(focusSeconds, preset)
        : state.restBalanceSeconds,
      completedPomodorosToday: completed
        ? state.completedPomodorosToday + 1
        : state.completedPomodorosToday,
      pendingProgressTaskId: completed ? state.taskId : null,
    };
  }
  if (state.phase === "resting") {
    return {
      ...state,
      restBalanceSeconds: state.restBalanceSeconds - 1,
      formalRestSecondsToday: state.formalRestSecondsToday + 1,
    };
  }
  if (state.phase === "distracted") {
    return {
      ...state,
      restBalanceSeconds: state.restBalanceSeconds - 1,
      distractionSecondsToday: state.distractionSecondsToday + 1,
    };
  }
  return state;
}

export function stopFocus(state, preset) {
  if (!["focusing", "paused"].includes(state.phase)) return state;
  const target = state.targetFocusSeconds;
  const interrupted = target !== null && state.focusSeconds < target;
  return {
    ...state,
    phase: "idle",
    restBalanceSeconds:
      state.restBalanceSeconds + earnedBreakSeconds(state.focusSeconds, preset),
    interruptedSessionsToday: interrupted
      ? state.interruptedSessionsToday + 1
      : state.interruptedSessionsToday,
    pendingProgressTaskId: state.taskId,
  };
}

export function startRest(state) {
  return {
    ...state,
    phase: "resting",
    pendingProgressTaskId: null,
    taskId: null,
    focusSeconds: 0,
    distractionDomain: null,
  };
}

export function startDistraction(state, domain) {
  if (state.phase !== "focusing") return state;
  return {
    ...state,
    phase: "distracted",
    distractionDomain: domain,
  };
}

export function resumeFromDistraction(state) {
  if (state.phase !== "distracted") return state;
  return {
    ...state,
    phase: "focusing",
    distractionDomain: null,
  };
}

export function stopActiveTimer(state) {
  if (!["resting", "distracted", "focus-complete"].includes(state.phase)) {
    return state;
  }
  return {
    ...state,
    phase: "idle",
    distractionDomain: null,
  };
}

export function timerDisplaySeconds(state) {
  if (state.phase === "resting" || state.phase === "distracted") {
    return Math.abs(state.restBalanceSeconds);
  }
  if (state.targetFocusSeconds === null) return state.focusSeconds;
  return Math.max(0, state.targetFocusSeconds - state.focusSeconds);
}
