import { useEffect, useState } from "react";
import { persistDesktopState } from "./desktop-sqlite.js";

const STORAGE_VERSION = 1;
const identity = (value) => value;

export const STORAGE_KEYS = Object.freeze({
  tasks: "fuck-ddl:v1:tasks",
  goals: "fuck-ddl:v1:goals",
  projects: "fuck-ddl:v1:projects",
  activeTaskId: "fuck-ddl:v1:active-task-id",
  timerMode: "fuck-ddl:v1:timer-mode",
  timerSeconds: "fuck-ddl:v1:timer-seconds",
  timerRunning: "fuck-ddl:v1:timer-running",
  workedSeconds: "fuck-ddl:v1:worked-seconds",
  dailyWork: "fuck-ddl:v1:daily-work",
  completionHistory: "fuck-ddl:v1:completion-history",
  focusState: "fuck-ddl:v1:focus-state",
  customPresets: "fuck-ddl:v1:custom-presets",
  focusHistory: "fuck-ddl:v1:focus-history",
  lastSourceSyncAt: "fuck-ddl:v1:last-source-sync-at",
  permanentWhitelist: "fuck-ddl:v1:permanent-whitelist",
  inbox: "fuck-ddl:v1:inbox",
  todayPlanOrder: "fuck-ddl:v1:today-plan-order",
  gradeRecords: "fuck-ddl:v1:grade-records",
  gradeSyncSettings: "fuck-ddl:v1:grade-sync-settings",
  zjuCourseCatalog: "fuck-ddl:v1:zju-course-catalog",
  lastAutomaticBackupDay: "fuck-ddl:v1:last-automatic-backup-day",
});

export function encodePersistedState(value) {
  return JSON.stringify({ version: STORAGE_VERSION, value });
}

export function decodePersistedState(raw, fallback, validate = () => true) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== STORAGE_VERSION || !validate(parsed.value))
      return fallback;
    return parsed.value;
  } catch {
    return fallback;
  }
}

export function isTaskList(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (task) =>
        task &&
        typeof task.id === "string" &&
        typeof task.title === "string" &&
        Number.isFinite(Number(task.progress)) &&
        (typeof task.deadlineAt === "string" ||
          Number.isFinite(Number(task.deadlineHours))),
    )
  );
}

export function isGoalList(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (goal) =>
        goal &&
        typeof goal.id === "string" &&
        typeof goal.name === "string" &&
        Number.isFinite(Number(goal.progress)),
    )
  );
}

export function isProjectList(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (project) =>
        project &&
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        typeof project.color === "string",
    )
  );
}

export const isBoolean = (value) => typeof value === "boolean";
export const isNonNegativeNumber = (value) =>
  Number.isFinite(value) && value >= 0;
export const isString = (value) => typeof value === "string";
export const isTimerMode = (value) =>
  ["25+5", "50+10", "自由计时"].includes(value);
export const isArray = (value) => Array.isArray(value);
export const isInboxList = (value) =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      item &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.createdAt === "string",
  );
export const isTodayPlanOrder = (value) =>
  value &&
  typeof value.dayKey === "string" &&
  Array.isArray(value.taskIds) &&
  value.taskIds.every((taskId) => typeof taskId === "string");

export function writePersistentState(key, value) {
  try {
    const encodedValue = encodePersistedState(value);
    window.localStorage.setItem(key, encodedValue);
    void persistDesktopState(key, encodedValue).catch(() => {
      // SQLite is a desktop resilience layer. Browser local storage remains usable.
    });
  } catch {
    // Storage can be unavailable in private mode. In-memory state remains usable.
  }
}

export function usePersistentState(
  key,
  initialValue,
  validate,
  migrate = identity,
) {
  const [state, setState] = useState(() => {
    const fallback =
      typeof initialValue === "function" ? initialValue() : initialValue;
    if (typeof window === "undefined") return fallback;
    return migrate(
      decodePersistedState(
        window.localStorage.getItem(key),
        fallback,
        validate,
      ),
    );
  });

  useEffect(() => {
    writePersistentState(key, state);
  }, [key, state]);

  useEffect(() => {
    function handleStorage(event) {
      if (event.key !== key || event.newValue === null) return;
      setState((current) =>
        migrate(decodePersistedState(event.newValue, current, validate)),
      );
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [key, migrate, validate]);

  return [state, setState];
}
