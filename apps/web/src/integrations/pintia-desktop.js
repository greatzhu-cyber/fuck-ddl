import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { snapshotPintiaTasks } from "./pintia.js";

const SYNC_EVENT = "fuck-ddl:pintia-sync";
const LOGIN_REQUIRED_EVENT = "fuck-ddl:pintia-login-required";
const EXTRACT_FAILED_EVENT = "fuck-ddl:pintia-extract-failed";
const SESSION_CORRUPT_EVENT = "fuck-ddl:pintia-session-corrupt";
const TASK_SYNC_TIMEOUT_MS = 120_000;
const GRADE_SYNC_TIMEOUT_MS = 180_000;

export function isTauriDesktop() {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function openPintiaLogin() {
  if (!isTauriDesktop()) throw new Error("desktop-required");
  await invoke("open_pintia_login");
}

export async function resetPintiaSession() {
  if (!isTauriDesktop()) throw new Error("desktop-required");
  await invoke("reset_pintia_session");
}

function normalizeSyncMode(mode) {
  return mode === "grades" ? "grades" : "tasks";
}

function logDebug(...args) {
  if (typeof console !== "undefined" && console.info) {
    console.info("[fuck-ddl PTA]", ...args);
  }
}

export function createPintiaDesktopAdapter(getSyncOptions = () => ({})) {
  let pending = null;
  return {
    sync(request = {}) {
      if (!isTauriDesktop())
        return Promise.reject(new Error("desktop-required"));
      if (pending) return pending;
      const mode = normalizeSyncMode(request.mode);
      const timeoutMs =
        mode === "grades" ? GRADE_SYNC_TIMEOUT_MS : TASK_SYNC_TIMEOUT_MS;
      const startedAt = Date.now();
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
              new Error(
                `pintia-sync-timeout after ${timeoutMs}ms (mode=${mode})`,
              ),
            ),
          );
        }, timeoutMs);

        void (async () => {
          try {
            stopListening.push(
              await listen(SYNC_EVENT, (event) => {
                const cards = Array.isArray(event.payload) ? event.payload : [];
                const snapshot = snapshotPintiaTasks(
                  cards,
                  new Date().toISOString(),
                  { mode },
                );
                const ms = Date.now() - startedAt;
                const taskLike = cards.filter((card) => !card?.gradeStatus);
                const taskCount =
                  snapshot.updates.length +
                  snapshot.completions.length +
                  snapshot.expirations.length;
                logDebug("event pintia-sync", {
                  mode,
                  ms,
                  rawCount: cards.length,
                  taskLike: taskLike.length,
                  taskCount,
                  grades: snapshot.grades.length,
                });
                // Combined scanner returns active + grade cards. Only fail when
                // task-like cards exist but none parse (do not wipe on grade-only payloads).
                if (
                  mode === "tasks" &&
                  taskLike.length > 0 &&
                  taskCount === 0
                ) {
                  finish(() =>
                    reject(
                      new Error(
                        `pintia-extract-failed (raw=${cards.length}, unparsed task-like=${taskLike.length})`,
                      ),
                    ),
                  );
                  return;
                }
                finish(() =>
                  resolve({
                    ...snapshot,
                    debug: {
                      source: "PTA",
                      mode,
                      ms,
                      rawCount: cards.length,
                      taskLike: taskLike.length,
                      taskCount,
                      gradeCount: snapshot.grades.length,
                    },
                  }),
                );
              }),
            );
            stopListening.push(
              await listen(LOGIN_REQUIRED_EVENT, () => {
                logDebug("login-required", { mode });
                finish(() => reject(new Error("pintia-login-required")));
              }),
            );
            stopListening.push(
              await listen(EXTRACT_FAILED_EVENT, () => {
                logDebug("extract-failed", { mode });
                finish(() => reject(new Error("pintia-extract-failed")));
              }),
            );
            stopListening.push(
              await listen(SESSION_CORRUPT_EVENT, () => {
                logDebug("session-corrupt", { mode });
                finish(() => reject(new Error("pta-session-corrupt")));
              }),
            );
            if (!settled) {
              const baseOptions =
                typeof getSyncOptions === "function" ? getSyncOptions() : {};
              const options = {
                ...baseOptions,
                mode,
              };
              logDebug("invoke sync_pintia", options);
              await invoke("sync_pintia", { options });
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
