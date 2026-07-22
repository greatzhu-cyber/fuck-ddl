import { describe, expect, it } from "vitest";
import {
  canEditTaskField,
  deadlineHoursUntil,
  distractionRestShare,
  earnedBreakSeconds,
  estimatedPomodoros,
  formatDuration,
  formatRemaining,
  isImportedTask,
  isValidCustomPreset,
  normalizeProgress,
  shouldSuggestMoreRest,
  sortTasks,
  taskScore,
  timeRemainingRatio,
  urgencyMeta,
  workDistractionRate,
  type TaskLike,
} from "./index.js";

describe("pomodoro accounting", () => {
  it("earns break credit only after fifteen focused minutes", () => {
    const preset = { focusMinutes: 50, breakMinutes: 10 };
    expect(earnedBreakSeconds(14 * 60 + 59, preset)).toBe(0);
    expect(earnedBreakSeconds(50 * 60, preset)).toBe(10 * 60);
    expect(earnedBreakSeconds(100 * 60, preset)).toBe(20 * 60);
  });

  it("uses the default twenty percent ratio for free timing", () => {
    expect(
      earnedBreakSeconds(25 * 60, { focusMinutes: null, breakMinutes: 5 }),
    ).toBe(5 * 60);
  });

  it("validates custom presets and estimates planned cycles", () => {
    expect(isValidCustomPreset({ focusMinutes: 50, breakMinutes: 20 })).toBe(
      true,
    );
    expect(isValidCustomPreset({ focusMinutes: 10, breakMinutes: 20 })).toBe(
      false,
    );
    expect(estimatedPomodoros(100, 50)).toBe(2);
    expect(estimatedPomodoros(0, 50)).toBeNull();
  });

  it("calculates both approved distraction metrics", () => {
    expect(distractionRestShare(20 * 60, 10 * 60)).toBeCloseTo(2 / 3);
    expect(workDistractionRate(20 * 60, 30 * 60)).toBeCloseTo(0.4);
    expect(distractionRestShare(0, 0)).toBeNull();
    expect(workDistractionRate(0, 0)).toBeNull();
  });

  it("suggests more rest after three negative days in a week", () => {
    expect(shouldSuggestMoreRest([true, false, true, false, true])).toBe(true);
    expect(shouldSuggestMoreRest([true, false, true])).toBe(false);
  });
});

describe("timeRemainingRatio", () => {
  it.each([
    [200, 1],
    [168, 1],
    [48, 0.75],
    [24, 0.5],
    [2, 0.15],
    [0, 0],
    [-2, 0],
    [Number.NaN, 0],
  ])("maps %s hours to %s", (hours, expected) => {
    expect(timeRemainingRatio(hours)).toBeCloseTo(expected, 5);
  });

  it("decreases monotonically as the deadline approaches", () => {
    const values = [168, 96, 48, 24, 12, 2, 1, 0].map(timeRemainingRatio);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });
});

describe("task priority", () => {
  const base: TaskLike = {
    progress: 50,
    importance: "medium",
    deadlineHours: 72,
  };

  it("raises the score for closer deadlines", () => {
    expect(taskScore({ ...base, deadlineHours: 2 })).toBeGreaterThan(
      taskScore(base),
    );
  });

  it("raises the score for unfinished critical work", () => {
    expect(
      taskScore({ ...base, progress: 0, importance: "critical" }),
    ).toBeGreaterThan(taskScore(base));
  });

  it("clamps invalid completion values", () => {
    expect(normalizeProgress(-10)).toBe(0);
    expect(normalizeProgress(120)).toBe(100);
    expect(normalizeProgress(Number.NaN)).toBe(0);
  });

  it("keeps manual pins first and far deadlines lower", () => {
    const tasks = [
      { ...base, id: "far", title: "far", pinned: false, deadlineHours: 100 },
      { ...base, id: "near", title: "near", pinned: false, deadlineHours: 4 },
      {
        ...base,
        id: "pinned",
        title: "pinned",
        pinned: true,
        deadlineHours: 150,
      },
    ];
    expect(sortTasks(tasks).map((task) => task.id)).toEqual([
      "pinned",
      "near",
      "far",
    ]);
  });

  it("uses a deterministic title tie-breaker", () => {
    const tasks = [
      { ...base, id: "b", title: "乙", pinned: false },
      { ...base, id: "a", title: "甲", pinned: false },
    ];
    expect(sortTasks(tasks).map((task) => task.title)).toEqual(["甲", "乙"]);
  });
});

describe("deadline labels and formatting", () => {
  it("uses explicit urgency states and semantic tones", () => {
    expect(urgencyMeta(1)).toMatchObject({
      key: "last-call",
      tone: "critical",
    });
    expect(urgencyMeta(12).key).toBe("urgent");
    expect(urgencyMeta(36).key).toBe("warning");
    expect(urgencyMeta(-1)).toMatchObject({ key: "overdue", tone: "expired" });
  });

  it("formats remaining time and timer duration", () => {
    expect(formatRemaining(25)).toBe("1天 01:00:00");
    expect(formatRemaining(1.5)).toBe("01:30:00");
    expect(formatDuration(3661)).toBe("01:01:01");
    expect(formatDuration(Number.NaN)).toBe("00:00");
  });

  it("derives remaining hours from an absolute deadline", () => {
    const now = Date.parse("2026-07-07T00:00:00.000Z");
    expect(deadlineHoursUntil("2026-07-08T12:00:00.000Z", now)).toBe(36);
    expect(deadlineHoursUntil("invalid", now)).toBe(0);
  });
});

describe("imported task permissions", () => {
  const imported: TaskLike = { source: "PTA", sourceLocked: true };
  const manual: TaskLike = { source: "手动", sourceLocked: false };

  it("recognizes source-controlled tasks", () => {
    expect(isImportedTask(imported)).toBe(true);
    expect(isImportedTask(manual)).toBe(false);
  });

  it("locks synchronized fields but keeps local metadata editable", () => {
    expect(canEditTaskField(imported, "progress")).toBe(false);
    expect(canEditTaskField(imported, "deadlineHours")).toBe(false);
    expect(canEditTaskField(imported, "pinned")).toBe(true);
    expect(canEditTaskField(manual, "progress")).toBe(true);
  });
});
