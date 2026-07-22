import { localDayKey } from "./focus.js";

export function isCompletionHistory(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.taskId === "string" &&
        typeof entry.title === "string" &&
        typeof entry.completedAt === "string" &&
        typeof entry.completedDay === "string",
    )
  );
}

export function createCompletionRecord(
  task,
  completedAt = new Date().toISOString(),
  reason = "manual",
) {
  const date = new Date(completedAt);
  const safeCompletedAt = Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
  return {
    id: `completed:${task.id}`,
    taskId: task.id,
    title: task.title,
    subtitle: task.subtitle ?? "",
    source: task.source ?? "手动",
    sourceId: task.sourceId ?? null,
    sourceUrl: task.sourceUrl ?? "",
    deadlineAt: task.deadlineAt ?? null,
    importance: task.importance ?? "medium",
    finalProgress: 100,
    reason,
    completedAt: safeCompletedAt,
    completedDay: localDayKey(new Date(safeCompletedAt)),
  };
}

export function appendCompletionRecords(history, records) {
  const taskIds = new Set(history.map((entry) => entry.taskId));
  const next = [...history];
  for (const record of records) {
    if (!record?.taskId || taskIds.has(record.taskId)) continue;
    taskIds.add(record.taskId);
    next.push(record);
  }
  return next;
}

export function completionRecordsFromSync(
  tasks,
  result,
  completedAt = result.syncedAt ?? new Date().toISOString(),
) {
  if (result.status !== "success") return [];
  const completedById = new Map(
    (result.completions ?? []).map((task) => [task.id, task]),
  );
  return tasks.flatMap((task) => {
    const completed = completedById.get(task.id);
    if (!task.sourceLocked || !completed) return [];
    if (!result.syncedSources?.includes(task.source)) return [];
    return [
      createCompletionRecord(
        { ...task, ...completed, progress: 100 },
        completedAt,
        "source-sync",
      ),
    ];
  });
}
