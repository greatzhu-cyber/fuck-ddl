import { describe, expect, it } from "vitest";
import {
  importableZjuTasks,
  parseZjuHomework,
  snapshotZjuTasks,
} from "./zju.js";

const syncedAt = "2026-07-10T06:00:00.000Z";

describe("学在浙大只读解析器", () => {
  it("解析课程、DDL 和未完成状态", () => {
    expect(
      parseZjuHomework(
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          courseUrl: "https://courses.zju.edu.cn/course/99089/content",
          title: "Lab 1 - Pwn 基础",
          text: "时间: 2026-07-09 18:00 ~ 2026-07-23 23:59 未完成 完成指标：提交作业",
        },
        syncedAt,
      ),
    ).toMatchObject({
      title: "Lab 1 - Pwn 基础",
      source: "学在浙大",
      deadlineAt: "2026-07-23T15:59:00.000Z",
      progress: 0,
      sourceLocked: true,
      sourceStatus: "active",
    });
  });

  it("解析章节页真实文案：结束时间与时间范围", () => {
    // Matches desktop screenshot 信息安全课程综合实践 / course 99089 content tab.
    const snapshot = snapshotZjuTasks(
      [
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          courseUrl: "https://courses.zju.edu.cn/course/99089/content",
          title: "Lab0",
          text: "Lab0 结束时间: 2026-07-21 23:59",
        },
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          title: "Web导论 — Homework",
          text: "Web导论 — Homework 结束时间: 2026-07-22 23:59",
        },
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          title: "Lab 1 - Pwn 基础",
          text: "Lab 1 - Pwn 基础 时间: 2026-07-09 18:00 ~ 2026-07-23 23:59",
        },
      ],
      "2026-07-15T05:40:00.000Z",
    );
    expect(snapshot.updates.map((task) => task.title).sort()).toEqual([
      "Lab 1 - Pwn 基础",
      "Lab0",
      "Web导论 — Homework",
    ]);
  });

  it("拒绝把结束时间标签当成任务标题", () => {
    expect(
      parseZjuHomework(
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          title: "结束时间: 2026-07-27 23:59",
          text: "结束时间: 2026-07-27 23:59",
        },
        "2026-07-15T05:40:00.000Z",
      ),
    ).toBeNull();

    expect(
      parseZjuHomework(
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          title: "Lab1 - Crypto 基础 结束时间: 2026-07-28 23:59",
          text: "Lab1 - Crypto 基础 结束时间: 2026-07-28 23:59",
        },
        "2026-07-15T05:40:00.000Z",
      ),
    ).toMatchObject({
      title: "Lab1 - Crypto 基础",
      deadlineAt: "2026-07-28T15:59:00.000Z",
    });
  });

  it("将网页的部分完成映射为明确标记的估算进度", () => {
    expect(
      parseZjuHomework(
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          title: "Web导论 — Homework",
          text: "结束时间: 2026-07-22 23:59 部分完成 完成指标：提交作业",
        },
        syncedAt,
      ),
    ).toMatchObject({ progress: 50, sourceProgressEstimated: true });
  });

  it("相同课程、标题和 DDL 生成稳定来源键", () => {
    const raw = {
      courseId: "99089",
      courseTitle: "信息安全课程综合实践",
      title: "Lab0",
      text: "结束时间: 2026-07-21 23:59 部分完成",
    };
    expect(parseZjuHomework(raw, syncedAt).id).toBe(
      parseZjuHomework(raw, syncedAt).id,
    );
  });

  it("不导入已完成、已过期或没有 DDL 的活动", () => {
    expect(
      importableZjuTasks(
        [
          {
            courseId: "99089",
            title: "已交作业",
            text: "结束时间: 2026-07-22 23:59 已完成",
          },
          {
            courseId: "99089",
            title: "旧作业",
            text: "结束时间: 2026-06-22 23:59 未完成",
          },
          { courseId: "99089", title: "无截止资料", text: "参考资料" },
        ],
        syncedAt,
      ),
    ).toEqual([]);
  });

  it("把真实页面的已交付作业视为完成并从活跃 DDL 中移除", () => {
    const record = {
      courseId: "95870",
      courseTitle: "大学物理（乙）I",
      title: "大物乙I 布置的所有习题",
      text: "活动时间 2026-03-21 12:06 - 2026-07-18 12:06 已交付 完成指标 提交作业",
    };
    expect(parseZjuHomework(record, syncedAt)).toMatchObject({
      progress: 100,
      sourceStatus: "completed",
    });
    expect(importableZjuTasks([record], syncedAt)).toEqual([]);
    expect(snapshotZjuTasks([record], syncedAt).completions).toEqual([
      expect.objectContaining({
        title: "大物乙I 布置的所有习题",
        sourceStatus: "completed",
      }),
    ]);
  });

  it("识别课程内容页使用的已交状态", () => {
    const record = {
      courseId: "95870",
      courseTitle: "大学物理（乙）I",
      title: "大物乙I 布置的所有习题",
      text: "大物乙I 布置的所有习题 已交 已结束 活动时间 2026-03-21 12:06 - 2026-07-18 12:06",
    };
    expect(parseZjuHomework(record, syncedAt)).toMatchObject({
      progress: 100,
      sourceStatus: "completed",
    });
    expect(importableZjuTasks([record], syncedAt)).toEqual([]);
  });

  it("分别保存已出分、未公布和错过 DDL 的成绩", () => {
    const base = {
      courseId: "95870",
      courseTitle: "大学物理（乙）I",
      courseUrl: "https://courses.zju.edu.cn/course/95870/content",
      text: "活动时间 2026-03-21 12:06 - 2026-07-18 12:06 已结束",
    };
    const snapshot = snapshotZjuTasks(
      [
        {
          ...base,
          activityId: "1100067",
          title: "第10章作业",
          text: "第10章作业 已交 5分 已结束 活动时间 2026-03-21 12:06 - 2026-07-18 12:06",
          score: 5,
          maxScore: 5,
          gradeStatus: "published",
        },
        {
          ...base,
          activityId: "1100053",
          title: "第3章作业",
          text: "第3章作业 已交 已结束 活动时间 2026-03-21 12:06 - 2026-07-18 12:06",
          gradeStatus: "unpublished",
        },
        {
          ...base,
          activityId: "1127860",
          title: "补交通道",
          text: "补交通道 已结束",
          gradeStatus: "missed",
        },
      ],
      syncedAt,
      { mode: "grades" },
    );
    expect(snapshot.grades).toEqual([
      expect.objectContaining({
        sourceId: "1100067",
        score: 5,
        maxScore: 5,
        status: "published",
      }),
      expect.objectContaining({
        sourceId: "1100053",
        score: null,
        status: "unpublished",
      }),
      expect.objectContaining({
        sourceId: "1127860",
        score: null,
        status: "missed",
      }),
    ]);
    expect(snapshot.updates).toEqual([]);
    // 已交 items leave the active DDL list via completions.
    expect(snapshot.completions.map((task) => task.title).sort()).toEqual([
      "第10章作业",
      "第3章作业",
    ]);
  });

  it("未到截止日期但已交：从 DDL 移除并记未公布", () => {
    const snapshot = snapshotZjuTasks(
      [
        {
          courseId: "99089",
          courseTitle: "信息安全课程综合实践",
          courseUrl: "https://courses.zju.edu.cn/course/99089/content",
          activityId: "1",
          title: "Lab0",
          text: "Lab0 结束时间: 2026-07-21 23:59 已交",
          gradeStatus: "unpublished",
        },
      ],
      "2026-07-15T05:40:00.000Z",
      { mode: "grades" },
    );
    expect(snapshot.grades).toEqual([
      expect.objectContaining({
        sourceId: "1",
        status: "unpublished",
        score: null,
      }),
    ]);
    expect(snapshot.completions).toEqual([
      expect.objectContaining({
        title: "Lab0",
        sourceStatus: "completed",
      }),
    ]);
  });
});
