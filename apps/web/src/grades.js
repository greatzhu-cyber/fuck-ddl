import { SOURCE_PTA, SOURCE_ZJU, normalizeSourceName } from "./source-names.js";

export const GRADE_STATUS = Object.freeze({
  PUBLISHED: "published",
  UNPUBLISHED: "unpublished",
  MISSED: "missed",
  UNKNOWN: "unknown",
});

export const DEFAULT_GRADE_SYNC_SETTINGS = Object.freeze({
  sinceDate: "",
  maxItems: 100,
  /** Whether PTA participates in grade refresh. */
  includePta: true,
  /** Selected 学在浙大 course IDs for grade refresh. Default none. */
  zjuCourseIds: Object.freeze([]),
});

const VALID_SYNC_LIMITS = new Set([20, 50, 100, 200]);

function normalizeZjuCourseIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const raw of value) {
    const id = String(raw ?? "").trim();
    if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 20) break;
  }
  return ids;
}

export function normalizeGradeSyncSettings(value = {}) {
  const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value.sinceDate ?? ""))
    ? String(value.sinceDate)
    : "";
  const maxItems = Number(value.maxItems);
  return {
    sinceDate,
    maxItems: VALID_SYNC_LIMITS.has(maxItems) ? maxItems : 100,
    includePta: value.includePta !== false,
    zjuCourseIds: normalizeZjuCourseIds(value.zjuCourseIds),
  };
}

export function isGradeSyncSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sinceDate = String(value.sinceDate ?? "");
  if (sinceDate && !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) return false;
  if (!VALID_SYNC_LIMITS.has(Number(value.maxItems))) return false;
  if (value.includePta !== undefined && typeof value.includePta !== "boolean") {
    return false;
  }
  // Legacy snapshots may omit zjuCourseIds — treat as valid empty selection.
  if (value.zjuCourseIds === undefined) return true;
  if (!Array.isArray(value.zjuCourseIds)) return false;
  return value.zjuCourseIds.every((id) => /^\d+$/.test(String(id ?? "")));
}

function normalizeSemesterLabel(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace("–", "-");
  if (!text || text === "catalog") return "未知学期";
  if (/^20\d{2}-20\d{2}[春夏秋冬]{1,4}$/.test(text)) return text;
  if (text.length > 0 && text.length <= 40) return text;
  return "未知学期";
}

export function normalizeZjuCourseCatalog(value = []) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const courses = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const courseId = String(raw.courseId ?? "").trim();
    const courseTitle = String(raw.courseTitle ?? raw.title ?? "").trim();
    const courseUrl = String(
      raw.courseUrl ??
        (courseId
          ? `https://courses.zju.edu.cn/course/${courseId}/content`
          : ""),
    ).trim();
    const semester = normalizeSemesterLabel(
      raw.semester ?? raw.text ?? raw.term,
    );
    if (
      !courseId ||
      !/^\d+$/.test(courseId) ||
      !courseTitle ||
      seen.has(courseId)
    ) {
      continue;
    }
    seen.add(courseId);
    courses.push({ courseId, courseTitle, courseUrl, semester });
    if (courses.length >= 120) break;
  }
  return courses;
}

export function isZjuCourseCatalog(value) {
  if (!Array.isArray(value)) return false;
  // Accept legacy items missing semester; normalize on migrate/read.
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const courseId = String(item.courseId ?? "").trim();
    const courseTitle = String(item.courseTitle ?? item.title ?? "").trim();
    return Boolean(courseId && /^\d+$/.test(courseId) && courseTitle);
  });
}

/** Sort semesters newest-first: 2025-2026春夏 before 2024-2025秋冬. */
export function listZjuSemesters(courses = []) {
  const set = new Set(
    normalizeZjuCourseCatalog(courses).map((course) => course.semester),
  );
  return [...set].sort((left, right) => {
    const yearLeft = Number(String(left).match(/^(\d{4})/)?.[1] || 0);
    const yearRight = Number(String(right).match(/^(\d{4})/)?.[1] || 0);
    if (yearLeft !== yearRight) return yearRight - yearLeft;
    const rank = (value) => {
      if (/春夏/.test(value)) return 2;
      if (/秋冬/.test(value)) return 1;
      return 0;
    };
    return rank(right) - rank(left) || left.localeCompare(right, "zh-CN");
  });
}

export function finalPtaGradeIds(records = []) {
  return records.flatMap((record) => {
    const normalized = normalizeGradeRecord(record);
    if (
      !normalized ||
      normalized.sourceName !== SOURCE_PTA ||
      ![GRADE_STATUS.PUBLISHED, GRADE_STATUS.MISSED].includes(normalized.status)
    ) {
      return [];
    }
    return [normalized.sourceId];
  });
}

const VALID_SOURCES = new Set([SOURCE_PTA, SOURCE_ZJU]);
const VALID_STATUSES = new Set(Object.values(GRADE_STATUS));

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const valueText = String(value).trim();
  return valueText.length > 0 ? valueText : null;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function normalizeStatus(record, score, submitted, closed, canStart) {
  const explicit = textOrNull(record.status ?? record.gradeStatus);
  if (VALID_STATUSES.has(explicit)) return explicit;

  if (record.missed === true) return GRADE_STATUS.MISSED;
  if (
    submitted === false &&
    (closed === true || canStart === false || record.deadlinePassed === true)
  ) {
    return GRADE_STATUS.MISSED;
  }
  if (
    score === 0 &&
    closed === true &&
    canStart === false &&
    submitted !== true
  ) {
    return GRADE_STATUS.MISSED;
  }
  if (score !== null) return GRADE_STATUS.PUBLISHED;
  if (
    submitted === true &&
    (record.gradePublished === false ||
      record.scorePublished === false ||
      score === null)
  ) {
    return GRADE_STATUS.UNPUBLISHED;
  }
  return GRADE_STATUS.UNKNOWN;
}

/**
 * Converts a source adapter result into the stable grade-record shape.
 * Invalid sources or missing source IDs are ignored by returning null.
 */
export function normalizeGradeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const sourceName = normalizeSourceName(record.sourceName ?? record.source);
  const sourceId = textOrNull(record.sourceId ?? record.externalId);
  if (!VALID_SOURCES.has(sourceName) || sourceId === null) return null;

  const score = finiteNumberOrNull(record.score);
  const maxScore = finiteNumberOrNull(
    record.maxScore ?? record.fullScore ?? record.possibleScore,
  );
  const submitted = booleanOrNull(record.submitted);
  const closed = booleanOrNull(record.closed ?? record.ended);
  const canStart = booleanOrNull(record.canStart ?? record.canAnswer);
  const status = normalizeStatus(record, score, submitted, closed, canStart);
  const title = textOrNull(record.title ?? record.activityName) ?? "未命名成绩";
  const courseName =
    textOrNull(record.courseName ?? record.courseTitle) ?? "未分组课程";

  return {
    id: `grade:${sourceName}:${sourceId}`,
    sourceName,
    sourceId,
    courseId: textOrNull(record.courseId),
    courseName,
    title,
    status,
    score,
    maxScore,
    submitted,
    closed,
    canStart,
    deadlineAt: textOrNull(record.deadlineAt),
    startedAt: textOrNull(record.startedAt),
    completedAt: textOrNull(record.completedAt ?? record.submittedAt),
    sourceUrl: textOrNull(record.sourceUrl) ?? "",
    rank: finiteNumberOrNull(record.rank),
    rankingTotal: finiteNumberOrNull(
      record.rankingTotal ?? record.participantCount,
    ),
    syncedAt: textOrNull(record.syncedAt),
  };
}

export function isGradeRecordList(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (record) =>
        record &&
        typeof record === "object" &&
        VALID_SOURCES.has(record.sourceName) &&
        typeof record.sourceId === "string" &&
        record.sourceId.length > 0 &&
        record.id === `grade:${record.sourceName}:${record.sourceId}` &&
        typeof record.title === "string" &&
        typeof record.courseName === "string" &&
        VALID_STATUSES.has(record.status) &&
        (record.score === null || Number.isFinite(record.score)) &&
        (record.maxScore === null || Number.isFinite(record.maxScore)),
    )
  );
}

function recordKey(record) {
  return `${record.sourceName}\u0000${record.sourceId}`;
}

/**
 * Merges complete source snapshots. A later record with the same platform and
 * source ID replaces the earlier record in place; repeated merges are
 * therefore idempotent. IDs from different platforms never collide.
 */
export function mergeGradeRecords(currentRecords = [], incomingRecords = []) {
  const merged = [];
  const indexByKey = new Map();

  for (const rawRecord of [...currentRecords, ...incomingRecords]) {
    const record = normalizeGradeRecord(rawRecord);
    if (!record) continue;
    const key = recordKey(record);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(record);
    } else {
      merged[existingIndex] = record;
    }
  }

  return merged;
}

export function filterGradeRecords(
  records,
  { sourceName = null, courseId = null, courseName = null, status = null } = {},
) {
  const normalizedSource = sourceName ? normalizeSourceName(sourceName) : null;
  if (normalizedSource && !VALID_SOURCES.has(normalizedSource)) return [];

  return records.flatMap((rawRecord) => {
    const record = normalizeGradeRecord(rawRecord);
    if (!record) return [];
    if (normalizedSource && record.sourceName !== normalizedSource) return [];
    if (courseId !== null && record.courseId !== String(courseId)) return [];
    if (courseName !== null && record.courseName !== String(courseName)) {
      return [];
    }
    if (status !== null && record.status !== status) return [];
    return [record];
  });
}

/**
 * scoreRate is a 0..1 weighted total (earned points / known possible points).
 * Unpublished and unknown records never enter the denominator. A missed item
 * with a known maximum is treated as zero points, even if the source omits 0.
 */
export function summarizeGrades(records, filters = {}) {
  const filteredRecords = filterGradeRecords(records, filters);
  let earnedScore = 0;
  let possibleScore = 0;
  let ratioSum = 0;
  let ratioCount = 0;

  for (const record of filteredRecords) {
    if (record.maxScore === null || record.maxScore <= 0) continue;
    if (record.status === GRADE_STATUS.PUBLISHED && record.score !== null) {
      earnedScore += record.score;
      possibleScore += record.maxScore;
      ratioSum += record.score / record.maxScore;
      ratioCount += 1;
    } else if (record.status === GRADE_STATUS.MISSED) {
      possibleScore += record.maxScore;
      ratioCount += 1;
    }
  }

  const totalPublished = filteredRecords.filter(
    (record) => record.status === GRADE_STATUS.PUBLISHED,
  ).length;
  const totalUnpublished = filteredRecords.filter(
    (record) => record.status === GRADE_STATUS.UNPUBLISHED,
  ).length;
  const totalMissed = filteredRecords.filter(
    (record) => record.status === GRADE_STATUS.MISSED,
  ).length;
  const totalUnknown = filteredRecords.filter(
    (record) => record.status === GRADE_STATUS.UNKNOWN,
  ).length;

  return {
    records: filteredRecords,
    totalRecords: filteredRecords.length,
    totalPublished,
    totalUnpublished,
    totalMissed,
    totalUnknown,
    earnedScore,
    possibleScore,
    scoreRate: possibleScore > 0 ? earnedScore / possibleScore : null,
    averageScoreRate: ratioCount > 0 ? ratioSum / ratioCount : null,
  };
}
