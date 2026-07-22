export const SOURCE_PTA = "PTA";
export const SOURCE_ZJU = "学在浙大";

const LEGACY_SOURCE_NAMES = Object.freeze({
  Pintia: SOURCE_PTA,
  浙大课程: SOURCE_ZJU,
});

export function normalizeSourceName(source) {
  return LEGACY_SOURCE_NAMES[source] ?? source;
}

export function migrateTaskSourceNames(tasks) {
  let changed = false;
  const migrated = tasks.map((task) => {
    const source = normalizeSourceName(task.source);
    if (source === task.source) return task;
    changed = true;
    return { ...task, source };
  });
  return changed ? migrated : tasks;
}
