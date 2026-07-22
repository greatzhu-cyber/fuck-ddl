import { SOURCE_PTA } from "../source-names.js";
import { normalizeGradeRecord } from "../grades.js";

const PROBLEM_SET_ID_PATTERN = /\/problem-sets\/(\d+)(?:\/|$)/;
// PTA cards sometimes use full-width colons or "截止时间".
const CLOSE_TIME_PATTERN =
  /(?:关闭时间|截止时间)\s*[:：]?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})/;

function shanghaiIso([, year, month, day, hour, minute]) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  return new Date(`${year}-${mm}-${dd}T${hh}:${minute}:00+08:00`).toISOString();
}

export function pintiaProgress(typeSummaries = []) {
  const totals = typeSummaries.reduce(
    (result, summary) => {
      for (const match of String(summary).matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
        result.completed += Number(match[1]);
        result.total += Number(match[2]);
      }
      return result;
    },
    { completed: 0, total: 0 },
  );
  return totals.total === 0
    ? 0
    : Math.round((totals.completed / totals.total) * 100);
}

export function parsePintiaProblemSet(
  { href, text, typeSummaries = [] },
  syncedAt = new Date().toISOString(),
) {
  const sourceId = String(href).match(PROBLEM_SET_ID_PATTERN)?.[1];
  const closeMatch = String(text).match(CLOSE_TIME_PATTERN);
  if (!sourceId || !closeMatch) return null;

  const title = String(text).slice(0, closeMatch.index).trim();
  if (!title) return null;
  const closed = /已关闭/.test(text);
  const progress = pintiaProgress(
    typeSummaries.length > 0 ? typeSummaries : [text],
  );
  return {
    id: `pintia:${sourceId}`,
    sourceId,
    title,
    subtitle: `#PTA-${sourceId}`,
    source: SOURCE_PTA,
    deadlineAt: shanghaiIso(closeMatch),
    progress,
    importance: "medium",
    pinned: false,
    sourceLocked: true,
    sourceStatus: progress >= 100 ? "completed" : closed ? "expired" : "active",
    sourceSyncedAt: syncedAt,
  };
}

export function snapshotPintiaTasks(cards, syncedAt, { mode = "tasks" } = {}) {
  const syncMode = mode === "grades" ? "grades" : "tasks";
  const parsed = cards
    .map((card) => parsePintiaProblemSet(card, syncedAt))
    .filter(Boolean);
  const grades =
    syncMode === "grades"
      ? cards
          .map((card) => {
            if (!card?.gradeStatus) return null;
            const sourceId = String(card.href).match(
              PROBLEM_SET_ID_PATTERN,
            )?.[1];
            if (!sourceId) return null;
            const task = parsePintiaProblemSet(card, syncedAt);
            const rankMatch = String(card.rank ?? "").match(/^(\d+)\/(\d+)$/);
            const fallbackTitle = String(card.text ?? "")
              .replace(/\s+(?:已结束|已关闭|未答题|关闭时间:).*$/u, "")
              .trim()
              .slice(0, 500);
            return normalizeGradeRecord({
              sourceName: SOURCE_PTA,
              sourceId,
              courseName: SOURCE_PTA,
              title: task?.title || fallbackTitle || `PTA 题目集 ${sourceId}`,
              score: card.score,
              maxScore: card.maxScore,
              gradeStatus: card.gradeStatus,
              submitted: card.gradeStatus !== "missed",
              closed: true,
              canStart: card.gradeStatus !== "missed",
              deadlineAt: task?.deadlineAt ?? null,
              sourceUrl: card.sourceUrl || card.href,
              rank: rankMatch ? Number(rankMatch[1]) : null,
              rankingTotal: rankMatch ? Number(rankMatch[2]) : null,
              syncedAt,
            });
          })
          .filter(Boolean)
      : [];
  if (syncMode === "grades") {
    return {
      updates: [],
      completions: [],
      expirations: [],
      grades,
    };
  }
  return {
    updates: parsed.filter((task) => task.sourceStatus === "active"),
    completions: parsed.filter((task) => task.sourceStatus === "completed"),
    expirations: parsed.filter((task) => task.sourceStatus === "expired"),
    grades: [],
  };
}

export function importablePintiaTasks(cards, syncedAt) {
  return snapshotPintiaTasks(cards, syncedAt).updates;
}
