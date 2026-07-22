import { describe, expect, it } from "vitest";
import {
  addDailyWorkSecond,
  calculateTodayMetrics,
  createDailyWork,
  entriesForLocalDay,
  resetDailyWork,
} from "./daily-metrics.js";

describe("本地自然日指标", () => {
  it("跨过本地午夜后把今日工作时间清零", () => {
    const dayOne = new Date(2026, 6, 10, 23, 59, 59);
    const dayTwo = new Date(2026, 6, 11, 0, 0, 0);
    const worked = { ...createDailyWork(dayOne), seconds: 3_600 };

    expect(resetDailyWork(worked, dayTwo)).toEqual({
      dayKey: "2026-07-11",
      seconds: 0,
    });
    expect(addDailyWorkSecond(worked, dayTwo)).toEqual({
      dayKey: "2026-07-11",
      seconds: 1,
    });
  });

  it("只展示本地当天完成的记录", () => {
    const records = [
      {
        taskId: "yesterday",
        completedAt: new Date(2026, 6, 9, 23, 59).toISOString(),
      },
      {
        taskId: "today",
        completedAt: new Date(2026, 6, 10, 10).toISOString(),
      },
    ];
    expect(entriesForLocalDay(records, new Date(2026, 6, 10, 12))).toEqual([
      records[1],
    ]);
  });

  it("用今日完成和今天仍到期的任务计算真实完成率", () => {
    const now = new Date(2026, 6, 11, 12);
    const tasks = [
      {
        id: "due-today",
        progress: 40,
        deadlineAt: new Date(2026, 6, 11, 20).toISOString(),
      },
      {
        id: "due-later",
        progress: 0,
        deadlineAt: new Date(2026, 6, 12, 20).toISOString(),
      },
    ];
    const completionHistory = [
      {
        taskId: "finished",
        completedAt: new Date(2026, 6, 11, 10).toISOString(),
      },
    ];

    expect(calculateTodayMetrics(tasks, completionHistory, now)).toMatchObject({
      completedCount: 1,
      inProgressCount: 1,
      notStartedCount: 0,
      totalCount: 2,
      completionRate: 0.5,
    });
  });

  it("没有今日任务时完成率为空而不是伪造 0%", () => {
    expect(calculateTodayMetrics([], [], new Date(2026, 6, 11))).toMatchObject({
      totalCount: 0,
      completionRate: null,
    });
  });
});
