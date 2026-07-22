import { SOURCE_ZJU } from "../source-names.js";
import { normalizeGradeRecord } from "../grades.js";

// Real pages use zero-padded and non-padded months/days, "-" or "/".
const DATE_TIME_PATTERN =
  /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})/g;

function shanghaiIso(match) {
  const [, year, month, day, hour, minute] = match;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  return new Date(`${year}-${mm}-${dd}T${hh}:${minute}:00+08:00`).toISOString();
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function completionMeta(text) {
  if (/(?:已完成|已交(?:付)?|已提交|已批阅|已评分)/.test(text))
    return { progress: 100, status: "completed" };
  if (/部分完成/.test(text)) return { progress: 50, status: "partial" };
  return { progress: 0, status: "active" };
}

function extractDeadlineMatch(text) {
  const matches = [...String(text ?? "").matchAll(DATE_TIME_PATTERN)];
  if (matches.length === 0) return null;
  // Ranges like "2026-07-09 18:00 ~ 2026-07-23 23:59" use the last timestamp as DDL.
  return matches.at(-1);
}

function cleanImportedTitle(title, text = "") {
  let cleaned = String(title ?? "").trim();
  // Reject deadline-only titles like "结束时间: 2026-07-27 23:59"
  if (/^(结束时间|时间)\s*[:：]?/i.test(cleaned)) cleaned = "";
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(cleaned)) cleaned = "";
  cleaned = cleaned
    .replace(/\s*结束时间\s*[:：]?.*$/g, "")
    .replace(/\s*时间\s*[:：]?.*$/g, "")
    .replace(
      /\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?(?:\s*[~～\-—]+\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?)?.*$/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^(结束时间|时间)/.test(cleaned)) {
    cleaned = String(text ?? "")
      .replace(/\s*结束时间\s*[:：]?.*$/g, "")
      .replace(/\s*时间\s*[:：]?.*$/g, "")
      .replace(/\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?.*$/g, "")
      .replace(
        /\s*已交(?:付)?(?:\s*\d+(?:\.\d+)?\s*分)?|已结束|已截止|未完成|部分完成|完成指标[:：]?.*$/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
  }
  if (
    !cleaned ||
    /^(结束时间|时间)/.test(cleaned) ||
    /^\d{4}[-/.]/.test(cleaned)
  ) {
    return "";
  }
  return cleaned.slice(0, 160);
}

export function parseZjuHomework(
  { courseId, courseTitle, courseUrl, activityId, title, text },
  syncedAt = new Date().toISOString(),
) {
  const body = String(text ?? "");
  const normalizedTitle = cleanImportedTitle(title, body);
  const normalizedCourseId = String(courseId ?? "").trim();
  // Prefer dates from full text; some crawls put the label only in title.
  const deadlineMatch =
    extractDeadlineMatch(body) || extractDeadlineMatch(String(title ?? ""));
  if (!normalizedCourseId || !normalizedTitle || !deadlineMatch) return null;

  const deadlineAt = shanghaiIso(deadlineMatch);
  const completion = completionMeta(`${normalizedTitle} ${body}`);
  const expired = Date.parse(deadlineAt) <= Date.parse(syncedAt);
  const sourceId =
    String(activityId ?? "").trim() ||
    `${normalizedCourseId}:${stableHash(`${normalizedTitle}|${deadlineAt}`)}`;

  return {
    id: `zju:${sourceId}`,
    sourceId,
    title: normalizedTitle,
    subtitle: `${String(courseTitle ?? SOURCE_ZJU).trim()} · #ZJU-${sourceId}`,
    source: SOURCE_ZJU,
    sourceUrl: String(courseUrl ?? ""),
    deadlineAt,
    progress: completion.progress,
    importance: "medium",
    pinned: false,
    sourceLocked: true,
    sourceStatus:
      completion.status === "completed"
        ? "completed"
        : expired
          ? "expired"
          : "active",
    sourceProgressEstimated: completion.status === "partial",
    sourceSyncedAt: syncedAt,
  };
}

/** Explain why raw records failed to become tasks (for the sync debug panel). */
export function diagnoseZjuRecords(
  records,
  syncedAt = new Date().toISOString(),
) {
  return (records || []).slice(0, 12).map((record, index) => {
    const title = String(record?.title ?? "").trim();
    const courseId = String(record?.courseId ?? "").trim();
    const text = String(record?.text ?? "");
    const reasons = [];
    if (!courseId) reasons.push("缺courseId");
    if (!title) reasons.push("缺title");
    if (!extractDeadlineMatch(text) && !extractDeadlineMatch(title)) {
      reasons.push(`缺DDL text="${text.slice(0, 60).replace(/\s+/g, " ")}"`);
    }
    const parsed = parseZjuHomework(record, syncedAt);
    return {
      index,
      title: title || "(无标题)",
      courseId: courseId || "?",
      status: parsed?.sourceStatus ?? "unparsed",
      reasons: parsed ? [] : reasons,
    };
  });
}

export function importableZjuTasks(records, syncedAt) {
  return snapshotZjuTasks(records, syncedAt).updates;
}

export function snapshotZjuTasks(records, syncedAt, { mode = "tasks" } = {}) {
  const syncMode = mode === "grades" ? "grades" : "tasks";
  const parsed = records
    .map((record) => parseZjuHomework(record, syncedAt))
    .filter(Boolean);
  const grades =
    syncMode === "grades"
      ? records
          .map((record) => {
            if (!record?.gradeStatus) return null;
            const task = parseZjuHomework(record, syncedAt);
            const sourceId =
              String(record.activityId ?? "").trim() ||
              task?.sourceId ||
              `${String(record.courseId ?? "").trim()}:${stableHash(String(record.title ?? ""))}`;
            // 已交*分 → published; 已交无分 → unpublished; 未交截止 → missed.
            // Missed items still land in the grade ledger as 错过 DDL (no score cell).
            // Normalize bad published/0 without "0分" → unpublished (list chips).
            let gradeStatus = record.gradeStatus;
            let score = record.score;
            const text = String(record.text ?? "");
            if (
              gradeStatus === "published" &&
              (score === 0 || score === "0") &&
              !/已交(?:付)?\s*0\s*分/.test(text)
            ) {
              // Prefer real "已交 5分"; bare 已交 with bogus 0 is 未公布.
              if (/已交(?:付)?\s*(\d+(?:\.\d+)?)\s*分/.test(text)) {
                const m = text.match(/已交(?:付)?\s*(\d+(?:\.\d+)?)\s*分/);
                score = m ? Number(m[1]) : score;
              } else if (/已交|已提交|已交付/.test(text)) {
                gradeStatus = "unpublished";
                score = undefined;
              }
            }
            const cleanTitle =
              cleanImportedTitle(record.title, text) || record.title;
            return normalizeGradeRecord({
              sourceName: SOURCE_ZJU,
              sourceId,
              courseId: record.courseId,
              courseName: record.courseTitle,
              title: cleanTitle,
              score,
              maxScore: record.maxScore,
              gradeStatus,
              submitted: gradeStatus !== "missed",
              closed:
                gradeStatus === "missed" ||
                gradeStatus === "published" ||
                /已结束|已截止|截止交付/.test(text),
              canStart: gradeStatus !== "missed",
              deadlineAt: task?.deadlineAt ?? null,
              // Content-page only: never require activity detail URLs.
              sourceUrl: record.courseUrl || record.activityUrl || "",
              syncedAt,
            });
          })
          .filter(Boolean)
      : [];
  if (syncMode === "grades") {
    // Grades refresh may also clear submitted items from the active DDL list:
    // pre-deadline 已交 → completion + 未公布 grade; post-deadline 已交 → same.
    return {
      updates: [],
      completions: parsed.filter((task) => task.sourceStatus === "completed"),
      expirations: parsed.filter((task) => task.sourceStatus === "expired"),
      grades,
    };
  }
  return {
    updates: parsed.filter((task) => task.sourceStatus === "active"),
    completions: parsed.filter((task) => task.sourceStatus === "completed"),
    expirations: parsed.filter((task) => task.sourceStatus === "expired"),
    grades: [],
    // Surface parse failures so the UI can show why raw>0 but tasks=0.
    parseDiagnostics:
      records.length > 0 && parsed.length === 0
        ? diagnoseZjuRecords(records, syncedAt)
        : undefined,
  };
}
