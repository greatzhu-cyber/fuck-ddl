import { describe, expect, it } from "vitest";
import {
  importablePintiaTasks,
  parsePintiaProblemSet,
  pintiaProgress,
  snapshotPintiaTasks,
} from "./pintia.js";

describe("PTA 只读解析器", () => {
  it("calculates progress from completed problem counts, not scores", () => {
    expect(pintiaProgress(["判断题 2/3", "单选题 4/6", "编程题 1/1"])).toBe(70);
    expect(pintiaProgress(["判断题 2/3 编程题 1/2"])).toBe(60);
  });

  it("maps an active problem set to a locked task", () => {
    expect(
      parsePintiaProblemSet(
        {
          href: "https://pintia.cn/problem-sets/123456/overview",
          text: "数据结构练习 关闭时间: 2026-07-20 23:59 浙江大学 teacher",
          typeSummaries: ["判断题 2/3", "编程题 1/2"],
        },
        "2026-07-08T02:00:00.000Z",
      ),
    ).toMatchObject({
      id: "pintia:123456",
      title: "数据结构练习",
      source: "PTA",
      deadlineAt: "2026-07-20T15:59:00.000Z",
      progress: 60,
      sourceLocked: true,
      sourceStatus: "active",
    });
  });

  it("does not import already closed history as new DDL tasks", () => {
    expect(
      importablePintiaTasks([
        {
          href: "https://pintia.cn/problem-sets/987654/overview",
          text: "旧作业 关闭时间: 2026-06-30 16:05 已关闭 浙江大学 teacher",
        },
      ]),
    ).toEqual([]);
  });

  it("把完成 100% 的题目集作为明确完成快照", () => {
    const snapshot = snapshotPintiaTasks(
      [
        {
          href: "https://pintia.cn/problem-sets/123456/overview",
          text: "数据结构练习 关闭时间: 2026-07-20 23:59 判断题 3/3 编程题 2/2",
        },
      ],
      "2026-07-11T02:00:00.000Z",
    );
    expect(snapshot.updates).toEqual([]);
    expect(snapshot.completions).toEqual([
      expect.objectContaining({
        id: "pintia:123456",
        progress: 100,
        sourceStatus: "completed",
      }),
    ]);
  });

  it("rejects cards without a stable problem-set id or deadline", () => {
    expect(
      parsePintiaProblemSet({
        href: "https://pintia.cn/explore",
        text: "推荐",
      }),
    ).toBeNull();
  });

  it("accepts full-width colons and alternate deadline labels", () => {
    expect(
      parsePintiaProblemSet({
        href: "https://pintia.cn/problem-sets/42/overview",
        text: "额外练习 关闭时间：2026-8-1 9:05 判断题 1/2",
      }),
    ).toMatchObject({
      id: "pintia:42",
      title: "额外练习",
      deadlineAt: "2026-08-01T01:05:00.000Z",
      progress: 50,
    });
    expect(
      parsePintiaProblemSet({
        href: "https://pintia.cn/problem-sets/43/overview",
        text: "补交 截止时间: 2026-12-31 23:59",
      }),
    ).toMatchObject({
      id: "pintia:43",
      title: "补交",
    });
  });

  it("archives ended scores and keeps missed distinct from unpublished", () => {
    const snapshot = snapshotPintiaTasks(
      [
        {
          href: "https://pintia.cn/problem-sets/2030925912772153344/overview",
          sourceUrl:
            "https://pintia.cn/problem-sets/2030925912772153344/exam/overview",
          text: "ZJUFDS-2026-Mon-Bonus 已结束",
          score: 40,
          maxScore: 40,
          rank: "1/115",
          gradeStatus: "published",
        },
        {
          href: "https://pintia.cn/problem-sets/2067965583855030272/overview",
          text: "Code of Academic Honesty 未答题 已关闭",
          score: 0,
          gradeStatus: "missed",
        },
        {
          href: "https://pintia.cn/problem-sets/2067965583855030273/overview",
          text: "等待教师公布 已结束",
          gradeStatus: "unpublished",
        },
      ],
      "2026-07-11T08:30:00.000Z",
      { mode: "grades" },
    );
    expect(snapshot.grades).toEqual([
      expect.objectContaining({
        sourceId: "2030925912772153344",
        score: 40,
        maxScore: 40,
        rank: 1,
        rankingTotal: 115,
        status: "published",
      }),
      expect.objectContaining({
        sourceId: "2067965583855030272",
        score: 0,
        status: "missed",
      }),
      expect.objectContaining({
        sourceId: "2067965583855030273",
        score: null,
        status: "unpublished",
      }),
    ]);
    expect(snapshot.updates).toEqual([]);
  });
});
