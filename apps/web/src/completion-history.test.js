import { describe, expect, it } from "vitest";
import {
  appendCompletionRecords,
  completionRecordsFromSync,
  createCompletionRecord,
} from "./completion-history.js";

const currentTask = {
  id: "zju:95870:homework",
  title: "大物乙I 布置的所有习题",
  source: "学在浙大",
  sourceLocked: true,
  progress: 0,
  deadlineAt: "2026-07-18T04:06:00.000Z",
};

describe("完成历史", () => {
  it("把明确完成且原本在待办里的来源任务归档", () => {
    expect(
      completionRecordsFromSync([currentTask], {
        status: "success",
        syncedAt: "2026-07-11T02:00:00.000Z",
        syncedSources: ["学在浙大"],
        completions: [
          { ...currentTask, progress: 100, sourceStatus: "completed" },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        taskId: currentTask.id,
        title: currentTask.title,
        finalProgress: 100,
        reason: "source-sync",
        completedDay: "2026-07-11",
      }),
    ]);
  });

  it("不把缺失、过期、失败同步或历史完成记录伪装成今日完成", () => {
    expect(
      completionRecordsFromSync([currentTask], {
        status: "success",
        syncedSources: ["学在浙大"],
        completions: [],
        expirations: [currentTask],
      }),
    ).toEqual([]);
    expect(
      completionRecordsFromSync([currentTask], {
        status: "failed",
        syncedSources: [],
        completions: [currentTask],
      }),
    ).toEqual([]);
    expect(
      completionRecordsFromSync([], {
        status: "success",
        syncedSources: ["学在浙大"],
        completions: [currentTask],
      }),
    ).toEqual([]);
  });

  it("同一任务只归档一次", () => {
    const record = createCompletionRecord(
      currentTask,
      "2026-07-11T02:00:00.000Z",
    );
    expect(appendCompletionRecords([record], [record])).toEqual([record]);
  });
});
