import { localDayKey } from "./focus.js";

export function createDailyWork(date = new Date()) {
  return { dayKey: localDayKey(date), seconds: 0 };
}

export function isDailyWork(value) {
  return (
    value &&
    typeof value.dayKey === "string" &&
    Number.isFinite(value.seconds) &&
    value.seconds >= 0
  );
}

export function resetDailyWork(state, date = new Date()) {
  const dayKey = localDayKey(date);
  return state.dayKey === dayKey ? state : { dayKey, seconds: 0 };
}

export function addDailyWorkSecond(state, date = new Date()) {
  const current = resetDailyWork(state, date);
  return { ...current, seconds: current.seconds + 1 };
}

function localDayOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localDayKey(date);
}

export function entriesForLocalDay(entries, date = new Date()) {
  const dayKey = localDayKey(date);
  return entries.filter((entry) => localDayOf(entry.completedAt) === dayKey);
}

export function focusEntriesForLocalDay(entries, date = new Date()) {
  const dayKey = localDayKey(date);
  return entries.filter((entry) => localDayOf(entry.endedAt) === dayKey);
}

export function calculateTodayMetrics(
  tasks,
  completionHistory,
  date = new Date(),
) {
  const dayKey = localDayKey(date);
  const nowMs = date.getTime();
  const completedToday = entriesForLocalDay(completionHistory, date).sort(
    (left, right) =>
      Date.parse(right.completedAt) - Date.parse(left.completedAt),
  );
  const completedTaskIds = new Set(completedToday.map((entry) => entry.taskId));
  const dueToday = tasks.filter(
    (task) =>
      !completedTaskIds.has(task.id) &&
      Number(task.progress) < 100 &&
      localDayOf(task.deadlineAt) === dayKey,
  );
  const trackedTaskIds = new Set([
    ...completedTaskIds,
    ...dueToday.map((task) => task.id),
  ]);
  const totalCount = trackedTaskIds.size;

  return {
    dayKey,
    completedToday,
    completedCount: completedTaskIds.size,
    dueToday,
    inProgressCount: dueToday.filter((task) => Number(task.progress) > 0)
      .length,
    notStartedCount: dueToday.filter((task) => Number(task.progress) <= 0)
      .length,
    overdueCount: tasks.filter(
      (task) =>
        Number(task.progress) < 100 &&
        Number.isFinite(Date.parse(task.deadlineAt)) &&
        Date.parse(task.deadlineAt) < nowMs,
    ).length,
    totalCount,
    completionRate:
      totalCount === 0 ? null : completedTaskIds.size / totalCount,
  };
}
