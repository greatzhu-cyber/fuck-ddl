export const SOURCE_SYNC_INTERVAL_MS = 45 * 60 * 1000;

const adapters = new Map();

function normalizeSnapshot(value) {
  if (Array.isArray(value)) {
    return { updates: value, completions: [], expirations: [], grades: [] };
  }
  return {
    updates: Array.isArray(value?.updates) ? value.updates : [],
    completions: Array.isArray(value?.completions) ? value.completions : [],
    expirations: Array.isArray(value?.expirations) ? value.expirations : [],
    grades: Array.isArray(value?.grades) ? value.grades : [],
  };
}

export function registerSourceAdapter(source, adapter) {
  if (!source || typeof adapter?.sync !== "function") {
    throw new TypeError("A source name and sync adapter are required");
  }
  adapters.set(source, adapter);
  return () => adapters.delete(source);
}

export function connectedSourceCount() {
  return adapters.size;
}

function snapshotCounts(snapshot) {
  return {
    updates: snapshot.updates.length,
    completions: snapshot.completions.length,
    expirations: snapshot.expirations.length,
    grades: snapshot.grades.length,
  };
}

/**
 * @param {{
 *   task?: object | null,
 *   mode?: "tasks" | "grades",
 *   sources?: string[] | null,
 *   onProgress?: (event: { message: string, at: number, [key: string]: unknown }) => void
 * }} [options]
 */
export async function syncSources({
  task = null,
  mode = "tasks",
  sources = null,
  onProgress,
} = {}) {
  const effectiveMode = task ? "tasks" : mode === "grades" ? "grades" : "tasks";
  const startedAt = Date.now();
  const steps = [];
  const pushStep = (message, extra = {}) => {
    const step = {
      message,
      at: Date.now(),
      elapsedMs: Date.now() - startedAt,
      ...extra,
    };
    steps.push(step);
    try {
      onProgress?.(step);
    } catch {
      // UI progress hooks must not break sync.
    }
    if (typeof console !== "undefined" && console.info) {
      console.info("[fuck-ddl sync]", message, extra);
    }
  };

  const selected = task?.source
    ? [[task.source, adapters.get(task.source)]]
    : Array.isArray(sources) && sources.length > 0
      ? sources
          .map((source) => [source, adapters.get(source)])
          .filter(([, adapter]) => adapter)
      : [...adapters];
  const available = selected.filter(([, adapter]) => adapter);
  if (available.length === 0) {
    pushStep("无已注册来源适配器", { status: "disconnected" });
    return {
      status: "disconnected",
      syncedAt: null,
      updates: [],
      completions: [],
      expirations: [],
      grades: [],
      errors: [],
      syncedSources: [],
      fullSync: false,
      syncMode: effectiveMode,
      targetTaskId: task?.id ?? null,
      targetSource: task?.source ?? null,
      debug: {
        mode: effectiveMode,
        totalMs: Date.now() - startedAt,
        sources: available.map(([source]) => source),
        steps,
      },
    };
  }

  pushStep(
    `开始${effectiveMode === "grades" ? "成绩" : "任务"}同步：${available
      .map(([source]) => source)
      .join(" → ")}`,
    { mode: effectiveMode, sourceCount: available.length },
  );

  // Sequential sources: parallel PTA+ZJU WebViews were crashing WebView2.
  const settled = [];
  for (const [source, adapter] of available) {
    const sourceStarted = Date.now();
    pushStep(`正在读取 ${source}…`, { source, phase: "start" });
    try {
      const raw = await adapter.sync(
        task ? { task, mode: "tasks" } : { mode: effectiveMode },
      );
      const snapshot = normalizeSnapshot(raw);
      const counts = snapshotCounts(snapshot);
      const ms = Date.now() - sourceStarted;
      const adapterDebug = raw && typeof raw === "object" ? raw.debug : null;
      const failureHint =
        Array.isArray(adapterDebug?.parseFailures) &&
        adapterDebug.parseFailures.length > 0
          ? ` · 解析失败样例: ${adapterDebug.parseFailures.join(" | ")}`
          : Array.isArray(adapterDebug?.gradeSamples) &&
              adapterDebug.gradeSamples.length > 0
            ? ` · 成绩样例: ${adapterDebug.gradeSamples.join(" / ")}`
            : Array.isArray(adapterDebug?.noStatusSamples) &&
                adapterDebug.noStatusSamples.length > 0 &&
                counts.grades === 0
              ? ` · 无状态原文: ${adapterDebug.noStatusSamples.join(" / ")}`
              : Array.isArray(adapterDebug?.sampleTitles) &&
                  adapterDebug.sampleTitles.length > 0 &&
                  counts.updates +
                    counts.completions +
                    counts.expirations +
                    counts.grades ===
                    0
                ? ` · 原始标题: ${adapterDebug.sampleTitles.join(" / ")}`
                : adapterDebug?.skipped
                  ? ` · 跳过: ${adapterDebug.skipped}`
                  : "";
      pushStep(
        `${source} 完成 ${ms}ms · 活跃${counts.updates}/完成${counts.completions}/过期${counts.expirations}/成绩${counts.grades}` +
          (adapterDebug?.rawCount != null
            ? ` · 原始${adapterDebug.rawCount}条`
            : "") +
          (adapterDebug?.courseCount != null && effectiveMode === "grades"
            ? ` · 选课${adapterDebug.courseCount}`
            : "") +
          failureHint,
        {
          source,
          phase: "ok",
          ms,
          counts,
          adapterDebug: adapterDebug ?? undefined,
        },
      );
      settled.push({
        status: "fulfilled",
        value: { source, ...snapshot },
      });
    } catch (reason) {
      const ms = Date.now() - sourceStarted;
      const message = String(reason?.message ?? reason);
      pushStep(`${source} 失败 ${ms}ms · ${message}`, {
        source,
        phase: "error",
        ms,
        error: message,
      });
      settled.push({
        status: "rejected",
        reason,
        source,
      });
    }
  }
  const updates = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.updates : [],
  );
  const completions = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.completions : [],
  );
  const expirations = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.expirations : [],
  );
  const grades = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.grades : [],
  );
  const errors = settled.flatMap((result) =>
    result.status === "rejected"
      ? [
          {
            source: result.source,
            message: String(result.reason?.message ?? result.reason),
          },
        ]
      : [],
  );
  // Only sources that finished without error may mirror/remove missing tasks.
  const syncedSources = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value.source] : [],
  );
  const anyTaskPayload =
    updates.length + completions.length + expirations.length > 0;
  const status = errors.length === available.length ? "failed" : "success";
  const totalMs = Date.now() - startedAt;
  pushStep(
    `汇总 ${status} · ${totalMs}ms · 成功[${syncedSources.join(",") || "无"}]` +
      (errors.length
        ? ` · 失败[${errors.map((item) => `${item.source}:${item.message}`).join("; ")}]`
        : ""),
    { status, totalMs },
  );

  return {
    status,
    syncedAt: new Date().toISOString(),
    updates,
    completions,
    expirations,
    grades,
    errors,
    syncedSources,
    // Task full-mirror only when at least one source succeeded. Empty successful
    // snapshots (true "no problem sets") still mirror that source alone.
    fullSync:
      task === null && effectiveMode === "tasks" && syncedSources.length > 0,
    syncMode: effectiveMode,
    targetTaskId: task?.id ?? null,
    targetSource: task?.source ?? null,
    // retained for diagnostics/toasts; empty + success is still valid empty mirror
    hadTaskPayload: anyTaskPayload,
    debug: {
      mode: effectiveMode,
      totalMs,
      sources: available.map(([source]) => source),
      steps,
    },
  };
}

export function mergeSourceUpdates(
  tasks,
  updates,
  {
    syncedSources = [],
    fullSync = false,
    targetTaskId = null,
    targetSource = null,
    completions = [],
    expirations = [],
  } = {},
) {
  const scopedUpdates = targetTaskId
    ? updates.filter((update) => update.id === targetTaskId)
    : updates;
  const byId = new Map(scopedUpdates.map((update) => [update.id, update]));
  const mirroredSources = new Set(fullSync ? syncedSources : []);
  const explicitlyRemovedIds = new Set(
    [...completions, ...expirations]
      .filter((task) => !targetTaskId || task.id === targetTaskId)
      .map((task) => task.id),
  );
  const targetWasSynced =
    targetTaskId && targetSource && syncedSources.includes(targetSource);
  const retained = tasks.filter(
    (task) =>
      !task.sourceLocked ||
      (!explicitlyRemovedIds.has(task.id) &&
        (!mirroredSources.has(task.source) || byId.has(task.id)) &&
        (!targetWasSynced || task.id !== targetTaskId || byId.has(task.id))),
  );
  const merged = retained.map((task) => {
    const update = byId.get(task.id);
    if (!update || !task.sourceLocked) return task;
    const mergedTask = {
      ...task,
      title: update.title ?? task.title,
      subtitle: update.subtitle ?? task.subtitle,
      sourceId: update.sourceId ?? task.sourceId,
      sourceUrl: update.sourceUrl ?? task.sourceUrl,
      deadlineAt: update.deadlineAt ?? task.deadlineAt,
      progress: update.progress ?? task.progress,
      sourceStatus: update.sourceStatus ?? task.sourceStatus,
      sourceSyncedAt: update.sourceSyncedAt ?? task.sourceSyncedAt,
    };
    if (Object.hasOwn(update, "sourceProgressEstimated")) {
      mergedTask.sourceProgressEstimated = Boolean(
        update.sourceProgressEstimated,
      );
    }
    return mergedTask;
  });
  const existingIds = new Set(retained.map((task) => task.id));
  const imported = scopedUpdates.filter(
    (update) =>
      !existingIds.has(update.id) &&
      update.sourceLocked === true &&
      typeof update.title === "string" &&
      typeof update.deadlineAt === "string" &&
      Number.isFinite(update.progress),
  );
  return [...merged, ...imported];
}

export function formatSyncDebugLines(debug) {
  if (!debug?.steps?.length) return [];
  return debug.steps.map((step) => {
    const stamp = new Date(step.at).toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    return `[${stamp} +${step.elapsedMs ?? 0}ms] ${step.message}`;
  });
}
