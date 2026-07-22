export const DEADLINE_HOURS = Object.freeze({
  LAST_CALL: 2,
  URGENT: 24,
  WARNING: 48,
  RUNWAY: 168,
});

export const IMPORTANCE_WEIGHT = Object.freeze({
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1,
});

export const MIN_CREDITABLE_FOCUS_SECONDS = 15 * 60;

export interface PomodoroPreset {
  id: string;
  label: string;
  focusMinutes: number | null;
  breakMinutes: number;
  system: boolean;
}

export const SYSTEM_POMODORO_PRESETS: readonly PomodoroPreset[] = Object.freeze(
  [
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
      breakMinutes: 0,
      system: true,
    },
  ],
);

export type Importance = keyof typeof IMPORTANCE_WEIGHT;
export type UrgencyTone =
  "critical" | "expired" | "focus" | "muted" | "warning";

export interface TaskLike {
  title?: string;
  deadlineHours?: number;
  progress?: number;
  importance?: Importance;
  pinned?: boolean;
  source?: string;
  sourceLocked?: boolean;
  sourceId?: string;
}

export interface UrgencyMeta {
  key: "last-call" | "later" | "overdue" | "soon" | "urgent" | "warning";
  label: string;
  rank: number;
  tone: UrgencyTone;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeProgress(progress: unknown): number {
  return Math.min(100, Math.max(0, finiteNumber(progress)));
}

export function isValidCustomPreset(preset: Partial<PomodoroPreset>): boolean {
  return (
    Number.isFinite(preset.focusMinutes) &&
    Number(preset.focusMinutes) >= 15 &&
    Number(preset.focusMinutes) <= 180 &&
    Number.isFinite(preset.breakMinutes) &&
    Number(preset.breakMinutes) >= 5 &&
    Number(preset.breakMinutes) <= 60
  );
}

export function earnedBreakSeconds(
  actualFocusSeconds: unknown,
  preset: Pick<PomodoroPreset, "focusMinutes" | "breakMinutes">,
): number {
  const actual = Math.max(0, finiteNumber(actualFocusSeconds));
  if (actual < MIN_CREDITABLE_FOCUS_SECONDS) return 0;
  const focusMinutes = preset.focusMinutes ?? 5 * preset.breakMinutes;
  if (!focusMinutes || focusMinutes <= 0 || preset.breakMinutes <= 0) return 0;
  return Math.round(actual * (preset.breakMinutes / focusMinutes));
}

export function estimatedPomodoros(
  estimatedMinutes: unknown,
  focusMinutes: unknown,
): number | null {
  const estimate = finiteNumber(estimatedMinutes);
  const focus = finiteNumber(focusMinutes);
  if (estimate <= 0 || focus <= 0) return null;
  return Math.ceil(estimate / focus);
}

export function distractionRestShare(
  distractionSeconds: unknown,
  formalRestSeconds: unknown,
): number | null {
  const distraction = Math.max(0, finiteNumber(distractionSeconds));
  const rest = Math.max(0, finiteNumber(formalRestSeconds));
  const total = distraction + rest;
  return total > 0 ? distraction / total : null;
}

export function workDistractionRate(
  distractionSeconds: unknown,
  focusedWorkSeconds: unknown,
): number | null {
  const distraction = Math.max(0, finiteNumber(distractionSeconds));
  const work = Math.max(0, finiteNumber(focusedWorkSeconds));
  const total = distraction + work;
  return total > 0 ? distraction / total : null;
}

export function shouldSuggestMoreRest(
  negativeBalanceDays: readonly boolean[],
): boolean {
  return negativeBalanceDays.slice(-7).filter(Boolean).length >= 3;
}

export function deadlineHoursUntil(
  deadlineAt: unknown,
  now = Date.now(),
): number {
  const deadline =
    typeof deadlineAt === "string" || deadlineAt instanceof Date
      ? new Date(deadlineAt)
      : null;
  const deadlineMs = deadline?.getTime();
  if (!Number.isFinite(deadlineMs)) return 0;
  return (Number(deadlineMs) - finiteNumber(now, Date.now())) / 3_600_000;
}

export function timeRemainingRatio(hours: unknown): number {
  const remaining = finiteNumber(hours);
  if (remaining >= DEADLINE_HOURS.RUNWAY) return 1;
  if (remaining >= DEADLINE_HOURS.WARNING) {
    return 0.75 + (0.25 * (remaining - DEADLINE_HOURS.WARNING)) / 120;
  }
  if (remaining >= DEADLINE_HOURS.URGENT) {
    return 0.5 + (0.25 * (remaining - DEADLINE_HOURS.URGENT)) / 24;
  }
  if (remaining >= DEADLINE_HOURS.LAST_CALL) {
    return 0.15 + (0.35 * (remaining - DEADLINE_HOURS.LAST_CALL)) / 22;
  }
  if (remaining > 0) return (0.15 * remaining) / DEADLINE_HOURS.LAST_CALL;
  return 0;
}

export function urgencyMeta(hours: unknown): UrgencyMeta {
  const remaining = finiteNumber(hours);
  if (remaining <= 0) {
    return { key: "overdue", label: "已过期", rank: 5, tone: "expired" };
  }
  if (remaining <= DEADLINE_HOURS.LAST_CALL) {
    return { key: "last-call", label: "最后期限", rank: 0, tone: "critical" };
  }
  if (remaining <= DEADLINE_HOURS.URGENT) {
    return { key: "urgent", label: "紧急", rank: 1, tone: "critical" };
  }
  if (remaining <= DEADLINE_HOURS.WARNING) {
    return { key: "warning", label: "重点", rank: 2, tone: "warning" };
  }
  if (remaining <= DEADLINE_HOURS.RUNWAY) {
    return { key: "soon", label: "7 天内", rank: 3, tone: "focus" };
  }
  return { key: "later", label: "较远", rank: 4, tone: "muted" };
}

export function taskScore(task: TaskLike): number {
  const urgency = 1 - timeRemainingRatio(task.deadlineHours);
  const unfinished = 1 - normalizeProgress(task.progress) / 100;
  const importance = task.importance
    ? IMPORTANCE_WEIGHT[task.importance]
    : IMPORTANCE_WEIGHT.medium;
  return 100 * (0.65 * urgency + 0.2 * unfinished + 0.15 * importance);
}

export function sortTasks<T extends TaskLike>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;

    const aMeta = urgencyMeta(a.deadlineHours);
    const bMeta = urgencyMeta(b.deadlineHours);
    if (aMeta.rank !== bMeta.rank) return aMeta.rank - bMeta.rank;

    const scoreDifference = taskScore(b) - taskScore(a);
    if (Math.abs(scoreDifference) > 0.001) return scoreDifference;

    const deadlineDifference =
      finiteNumber(a.deadlineHours) - finiteNumber(b.deadlineHours);
    if (deadlineDifference !== 0) return deadlineDifference;

    const progressDifference =
      normalizeProgress(a.progress) - normalizeProgress(b.progress);
    if (progressDifference !== 0) return progressDifference;

    return String(a.title).localeCompare(String(b.title), "zh-CN");
  });
}

export function formatRemaining(hours: unknown): string {
  const safeHours = Math.max(0, finiteNumber(hours));
  const totalSeconds = Math.round(safeHours * 3600);
  const days = Math.floor(totalSeconds / 86400);
  const rest = totalSeconds % 86400;
  const hh = String(Math.floor(rest / 3600)).padStart(2, "0");
  const mm = String(Math.floor((rest % 3600) / 60)).padStart(2, "0");
  const ss = String(rest % 60).padStart(2, "0");
  return days > 0 ? `${days}天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

export function formatDuration(seconds: unknown): string {
  const safeSeconds = Math.max(0, Math.floor(finiteNumber(seconds)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function isImportedTask(task: TaskLike): boolean {
  return (
    Boolean(task.sourceLocked) ||
    task.source === "PTA" ||
    task.source === "学在浙大" ||
    task.source === "Pintia" ||
    task.source === "浙大课程"
  );
}

export function canEditTaskField(task: TaskLike, field: string): boolean {
  if (!isImportedTask(task)) return true;
  return !["title", "deadlineHours", "progress", "source", "sourceId"].includes(
    field,
  );
}
