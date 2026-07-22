import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriDesktop } from "./pintia-desktop.js";
import { diagnoseZjuRecords, snapshotZjuTasks } from "./zju.js";

const SYNC_EVENT = "fuck-ddl:zju-sync";
const COURSES_EVENT = "fuck-ddl:zju-courses";
const PROGRESS_EVENT = "fuck-ddl:zju-progress";
const LOGIN_REQUIRED_EVENT = "fuck-ddl:zju-login-required";
const EXTRACT_FAILED_EVENT = "fuck-ddl:zju-extract-failed";
/** Browser-side event so App.jsx can show live ZJU crawl lines during any mode. */
export const ZJU_PROGRESS_UI_EVENT = "fuck-ddl:zju-progress-ui";
const TASK_SYNC_TIMEOUT_MS = 120_000;
const GRADE_SYNC_TIMEOUT_MS = 180_000;
const COURSES_SYNC_TIMEOUT_MS = 120_000;

function emitProgressUi(message) {
  if (!message || typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(ZJU_PROGRESS_UI_EVENT, { detail: String(message) }),
    );
  } catch {
    // ignore
  }
}

function normalizeSyncMode(mode) {
  if (mode === "grades") return "grades";
  if (mode === "courses") return "courses";
  return "tasks";
}

function logDebug(...args) {
  if (typeof console !== "undefined" && console.info) {
    console.info("[fuck-ddl ZJU]", ...args);
  }
}

function normalizeCourseOptions(courses, { limit = 80 } = {}) {
  if (!Array.isArray(courses)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of courses) {
    const courseId = String(raw?.courseId ?? "").trim();
    const courseTitle = String(raw?.courseTitle ?? raw?.title ?? "").trim();
    const courseUrl = String(
      raw?.courseUrl ??
        (courseId
          ? `https://courses.zju.edu.cn/course/${courseId}/content`
          : ""),
    ).trim();
    const semester =
      String(raw?.semester ?? raw?.text ?? "未知学期")
        .trim()
        .replace(/\s+/g, "")
        .replace("–", "-") || "未知学期";
    if (
      !courseId ||
      !/^\d+$/.test(courseId) ||
      !courseTitle ||
      seen.has(courseId)
    ) {
      continue;
    }
    seen.add(courseId);
    out.push({ courseId, courseTitle, courseUrl, semester });
    if (out.length >= limit) break;
  }
  return out;
}

export async function openZjuLogin() {
  if (!isTauriDesktop()) throw new Error("desktop-required");
  await invoke("open_zju_login");
}

/**
 * Lightweight catalog scrape of 学在浙大 → 我的课程.
 * @param {{ onProgress?: (message: string) => void }} [options]
 * @returns {Promise<Array<{courseId:string, courseTitle:string, courseUrl:string, semester:string}>>}
 */
export async function listZjuCourses({ onProgress } = {}) {
  if (!isTauriDesktop()) throw new Error("desktop-required");
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const stopListening = [];
    let timeout;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      stopListening.splice(0).forEach((unlisten) => unlisten());
      callback();
    };
    timeout = window.setTimeout(() => {
      finish(() =>
        reject(
          new Error(`zju-courses-timeout after ${COURSES_SYNC_TIMEOUT_MS}ms`),
        ),
      );
    }, COURSES_SYNC_TIMEOUT_MS);

    void (async () => {
      try {
        stopListening.push(
          await listen(PROGRESS_EVENT, (event) => {
            const message =
              typeof event.payload === "string"
                ? event.payload
                : String(event.payload?.message || event.payload || "");
            if (!message) return;
            logDebug("progress", message);
            emitProgressUi(message);
            try {
              onProgress?.(message);
            } catch {
              // UI hooks must not break catalog scrape.
            }
          }),
        );
        stopListening.push(
          await listen(COURSES_EVENT, (event) => {
            const courses = normalizeCourseOptions(
              Array.isArray(event.payload) ? event.payload : [],
              { limit: 120 },
            );
            logDebug("event zju-courses", {
              ms: Date.now() - startedAt,
              count: courses.length,
            });
            finish(() => resolve(courses));
          }),
        );
        stopListening.push(
          await listen(LOGIN_REQUIRED_EVENT, () => {
            finish(() => reject(new Error("zju-login-required")));
          }),
        );
        stopListening.push(
          await listen(EXTRACT_FAILED_EVENT, () => {
            finish(() => reject(new Error("zju-extract-failed")));
          }),
        );
        if (!settled) {
          onProgress?.("打开学在浙大「我的课程」…");
          await invoke("sync_zju", { options: { mode: "courses" } });
        }
      } catch (error) {
        finish(() => reject(error));
      }
    })();
  });
}

export function createZjuDesktopAdapter(getSyncOptions = () => ({})) {
  let pending = null;
  return {
    sync(request = {}) {
      if (!isTauriDesktop())
        return Promise.reject(new Error("desktop-required"));
      if (pending) return pending;
      const mode = normalizeSyncMode(request.mode);
      const baseOptions =
        typeof getSyncOptions === "function" ? getSyncOptions() : {};
      const courses = normalizeCourseOptions(
        request.courses ?? baseOptions.courses ?? baseOptions.zjuCourses,
        { limit: 20 },
      );
      const timeoutMs =
        mode === "grades" ? GRADE_SYNC_TIMEOUT_MS : TASK_SYNC_TIMEOUT_MS;
      const startedAt = Date.now();

      // Grades without a course selection must not crawl the whole semester.
      if (mode === "grades" && courses.length === 0) {
        logDebug("grades skipped — no courses selected");
        return Promise.resolve({
          updates: [],
          completions: [],
          expirations: [],
          grades: [],
          debug: {
            source: "学在浙大",
            mode,
            ms: 0,
            rawCount: 0,
            taskCount: 0,
            gradeCount: 0,
            courseCount: 0,
            skipped: "no-courses-selected（请先读取课程列表并勾选至少一门课）",
          },
        });
      }

      pending = new Promise((resolve, reject) => {
        let settled = false;
        const stopListening = [];
        let timeout;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          stopListening.splice(0).forEach((unlisten) => unlisten());
          callback();
        };
        timeout = window.setTimeout(() => {
          logDebug("timeout", { mode, timeoutMs });
          finish(() =>
            reject(
              new Error(`zju-sync-timeout after ${timeoutMs}ms (mode=${mode})`),
            ),
          );
        }, timeoutMs);

        void (async () => {
          try {
            stopListening.push(
              await listen(PROGRESS_EVENT, (event) => {
                const message =
                  typeof event.payload === "string"
                    ? event.payload
                    : String(event.payload?.message || event.payload || "");
                if (!message) return;
                logDebug("progress", message);
                emitProgressUi(message);
              }),
            );
            stopListening.push(
              await listen(SYNC_EVENT, (event) => {
                const records = Array.isArray(event.payload)
                  ? event.payload
                  : [];
                const syncedAt = new Date().toISOString();
                const snapshot = snapshotZjuTasks(records, syncedAt, { mode });
                const ms = Date.now() - startedAt;
                const taskCount =
                  snapshot.updates.length +
                  snapshot.completions.length +
                  snapshot.expirations.length;
                const diagnostics =
                  mode === "tasks" && records.length > 0 && taskCount === 0
                    ? diagnoseZjuRecords(records, syncedAt)
                    : snapshot.parseDiagnostics;
                const gradeSamples = records
                  .filter((item) => item?.gradeStatus)
                  .slice(0, 6)
                  .map(
                    (item) =>
                      `${String(item.title || "").slice(0, 24)}:${item.gradeStatus}${
                        item.score != null ? `=${item.score}` : ""
                      }`,
                  );
                const noStatusSamples = records
                  .filter((item) => !item?.gradeStatus)
                  .slice(0, 4)
                  .map((item) =>
                    String(item?.title || item?.text || "")
                      .replace(/\s+/g, " ")
                      .slice(0, 36),
                  );
                logDebug("event zju-sync", {
                  mode,
                  ms,
                  rawCount: records.length,
                  updates: snapshot.updates.length,
                  completions: snapshot.completions.length,
                  grades: snapshot.grades.length,
                  courses: courses.length,
                  diagnostics,
                  gradeSamples,
                });
                finish(() =>
                  resolve({
                    ...snapshot,
                    debug: {
                      source: "学在浙大",
                      mode,
                      ms,
                      rawCount: records.length,
                      taskCount,
                      gradeCount: snapshot.grades.length,
                      courseCount: courses.length,
                      sampleTitles: records
                        .slice(0, 5)
                        .map((item) => String(item?.title || "").slice(0, 40)),
                      gradeSamples,
                      noStatusSamples,
                      parseFailures: diagnostics
                        ?.filter((item) => item.reasons?.length)
                        .slice(0, 5)
                        .map(
                          (item) => `${item.title}: ${item.reasons.join(",")}`,
                        ),
                    },
                  }),
                );
              }),
            );
            stopListening.push(
              await listen(LOGIN_REQUIRED_EVENT, () => {
                logDebug("login-required", { mode });
                finish(() => reject(new Error("zju-login-required")));
              }),
            );
            stopListening.push(
              await listen(EXTRACT_FAILED_EVENT, () => {
                logDebug("extract-failed", { mode });
                finish(() => reject(new Error("zju-extract-failed")));
              }),
            );
            if (!settled) {
              const options = {
                mode,
                ...(mode === "grades" ? { courses } : {}),
              };
              logDebug("invoke sync_zju", options);
              await invoke("sync_zju", { options });
            }
          } catch (error) {
            logDebug("invoke error", error);
            finish(() => reject(error));
          }
        })();
      }).finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
