import { describe, expect, it } from "vitest";
import {
  GRADE_STATUS,
  finalPtaGradeIds,
  filterGradeRecords,
  isGradeRecordList,
  isGradeSyncSettings,
  mergeGradeRecords,
  normalizeGradeRecord,
  normalizeGradeSyncSettings,
  summarizeGrades,
} from "./grades.js";

function grade(overrides = {}) {
  return {
    sourceName: "PTA",
    sourceId: "set-1",
    courseId: "fds",
    courseName: "数据结构基础",
    title: "期末试卷",
    score: 73,
    maxScore: 100,
    status: "published",
    ...overrides,
  };
}

describe("normalizeGradeRecord", () => {
  it("normalizes legacy source names and keeps a real zero score", () => {
    const record = normalizeGradeRecord(
      grade({ sourceName: "Pintia", score: 0, maxScore: 40 }),
    );

    expect(record).toMatchObject({
      id: "grade:PTA:set-1",
      sourceName: "PTA",
      sourceId: "set-1",
      score: 0,
      maxScore: 40,
      status: GRADE_STATUS.PUBLISHED,
    });
  });

  it("marks an unanswered closed activity that cannot start as missed", () => {
    expect(
      normalizeGradeRecord(
        grade({
          score: 0,
          status: undefined,
          submitted: false,
          closed: true,
          canStart: false,
        }),
      ).status,
    ).toBe(GRADE_STATUS.MISSED);
  });

  it("distinguishes a submitted but unpublished ZJU grade", () => {
    expect(
      normalizeGradeRecord({
        sourceName: "浙大课程",
        sourceId: "activity-3",
        courseName: "大学物理",
        title: "第3章作业",
        submitted: true,
        gradePublished: false,
      }),
    ).toMatchObject({
      sourceName: "学在浙大",
      score: null,
      status: GRADE_STATUS.UNPUBLISHED,
    });
  });

  it("rejects unsupported sources and records without a source ID", () => {
    expect(normalizeGradeRecord(grade({ sourceName: "手动" }))).toBeNull();
    expect(normalizeGradeRecord(grade({ sourceId: "" }))).toBeNull();
  });
});

describe("grade sync scope", () => {
  it("normalizes bounded settings and only returns immutable PTA IDs", () => {
    expect(
      normalizeGradeSyncSettings({ sinceDate: "2026-02-01", maxItems: 50 }),
    ).toEqual({
      sinceDate: "2026-02-01",
      maxItems: 50,
      includePta: true,
      zjuCourseIds: [],
    });
    expect(
      normalizeGradeSyncSettings({
        sinceDate: "2026-02-01",
        maxItems: 50,
        includePta: false,
        zjuCourseIds: ["99089", "99089", "bad", "95870"],
      }),
    ).toEqual({
      sinceDate: "2026-02-01",
      maxItems: 50,
      includePta: false,
      zjuCourseIds: ["99089", "95870"],
    });
    expect(isGradeSyncSettings({ sinceDate: "2026-02-01", maxItems: 50 })).toBe(
      true,
    );
    expect(
      isGradeSyncSettings({
        sinceDate: "2026-02-01",
        maxItems: 50,
        includePta: true,
        zjuCourseIds: ["99089"],
      }),
    ).toBe(true);
    expect(
      finalPtaGradeIds([
        grade({ sourceId: "123", status: GRADE_STATUS.PUBLISHED }),
        grade({ sourceId: "waiting", status: GRADE_STATUS.UNPUBLISHED }),
        grade({ sourceId: "456", status: GRADE_STATUS.MISSED }),
        grade({ sourceName: "学在浙大", sourceId: "zju" }),
      ]),
    ).toEqual(["123", "456"]);
  });
});

describe("mergeGradeRecords", () => {
  it("overwrites a duplicate platform source ID and is idempotent", () => {
    const initial = [grade({ score: 40, syncedAt: "old" })];
    const update = grade({ score: 73, syncedAt: "new" });
    const once = mergeGradeRecords(initial, [update]);
    const twice = mergeGradeRecords(once, [update]);

    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ score: 73, syncedAt: "new" });
    expect(twice).toEqual(once);
  });

  it("does not collide when two platforms reuse a source ID", () => {
    const records = mergeGradeRecords(
      [],
      [
        grade({ sourceName: "PTA", sourceId: "42" }),
        grade({ sourceName: "学在浙大", sourceId: "42", score: 5 }),
      ],
    );
    expect(records).toHaveLength(2);
  });

  it("uses the final item when an incoming snapshot repeats an ID", () => {
    const records = mergeGradeRecords(
      [],
      [grade({ score: 40 }), grade({ score: 73 })],
    );
    expect(records).toHaveLength(1);
    expect(records[0].score).toBe(73);
  });
});

describe("grade filtering and summaries", () => {
  const records = [
    grade({ sourceId: "published", score: 73, maxScore: 100 }),
    grade({
      sourceId: "zero",
      courseId: "bonus",
      courseName: "加分题",
      score: 0,
      maxScore: 40,
    }),
    grade({
      sourceName: "学在浙大",
      sourceId: "hidden",
      score: null,
      maxScore: 5,
      status: "unpublished",
      submitted: true,
    }),
    grade({
      sourceName: "学在浙大",
      sourceId: "missed",
      score: null,
      maxScore: 20,
      status: "missed",
    }),
    grade({
      sourceId: "unknown",
      score: null,
      maxScore: 1000,
      status: "unknown",
    }),
  ];

  it("filters by canonical source and course fields", () => {
    expect(
      filterGradeRecords(records, { sourceName: "浙大课程" }),
    ).toHaveLength(2);
    expect(filterGradeRecords(records, { courseId: "bonus" })).toMatchObject([
      { sourceId: "zero", courseName: "加分题" },
    ]);
    expect(filterGradeRecords(records, { sourceName: "其他" })).toEqual([]);
  });

  it("reports published, unpublished, missed, and unknown separately", () => {
    const summary = summarizeGrades(records);
    expect(summary).toMatchObject({
      totalRecords: 5,
      totalPublished: 2,
      totalUnpublished: 1,
      totalMissed: 1,
      totalUnknown: 1,
      earnedScore: 73,
      possibleScore: 160,
    });
    expect(summary.scoreRate).toBeCloseTo(73 / 160);
  });

  it("excludes unpublished and unknown results from score averages", () => {
    const summary = summarizeGrades(records);
    expect(summary.averageScoreRate).toBeCloseTo((0.73 + 0 + 0) / 3);
    expect(summary.possibleScore).not.toBe(1165);
  });

  it("returns null rates when no grade has a known denominator", () => {
    const summary = summarizeGrades([
      grade({ score: null, maxScore: 10, status: "unknown" }),
    ]);
    expect(summary.scoreRate).toBeNull();
    expect(summary.averageScoreRate).toBeNull();
  });

  it("validates normalized lists for persistence", () => {
    const normalized = mergeGradeRecords([], records);
    expect(isGradeRecordList(normalized)).toBe(true);
    expect(isGradeRecordList(records)).toBe(false);
    expect(isGradeRecordList([{ sourceName: "手动" }])).toBe(false);
  });
});
