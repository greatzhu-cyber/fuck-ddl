import { createInitialTasks, initialGoals } from "./data.js";
import { createFocusState, localDayKey, isFocusState } from "./focus.js";
import { migrateTaskSourceNames } from "./source-names.js";
import {
  DEFAULT_GRADE_SYNC_SETTINGS,
  isGradeRecordList,
  isGradeSyncSettings,
  isZjuCourseCatalog,
  normalizeGradeSyncSettings,
  normalizeZjuCourseCatalog,
} from "./grades.js";
import { isCompletionHistory } from "./completion-history.js";
import { createDailyWork, isDailyWork } from "./daily-metrics.js";
import {
  isArray,
  isGoalList,
  isInboxList,
  isProjectList,
  isString,
  isTaskList,
  isTodayPlanOrder,
  STORAGE_KEYS,
  usePersistentState,
} from "./persistence.js";

export function useAppPersistentState() {
  const [tasks, setTasks] = usePersistentState(
    STORAGE_KEYS.tasks,
    createInitialTasks,
    isTaskList,
    migrateTaskSourceNames,
  );
  const [goals, setGoals] = usePersistentState(
    STORAGE_KEYS.goals,
    initialGoals,
    isGoalList,
  );
  const [projects, setProjects] = usePersistentState(
    STORAGE_KEYS.projects,
    [],
    isProjectList,
  );
  const [activeTaskId, setActiveTaskId] = usePersistentState(
    STORAGE_KEYS.activeTaskId,
    "",
    isString,
  );
  const [focusState, setFocusState] = usePersistentState(
    STORAGE_KEYS.focusState,
    createFocusState,
    isFocusState,
  );
  const [customPresets, setCustomPresets] = usePersistentState(
    STORAGE_KEYS.customPresets,
    [],
    isArray,
  );
  const [focusHistory, setFocusHistory] = usePersistentState(
    STORAGE_KEYS.focusHistory,
    [],
    isArray,
  );
  const [completionHistory, setCompletionHistory] = usePersistentState(
    STORAGE_KEYS.completionHistory,
    [],
    isCompletionHistory,
  );
  const [lastSourceSyncAt, setLastSourceSyncAt] = usePersistentState(
    STORAGE_KEYS.lastSourceSyncAt,
    null,
    (value) => value === null || typeof value === "string",
  );
  const [permanentWhitelist, setPermanentWhitelist] = usePersistentState(
    STORAGE_KEYS.permanentWhitelist,
    ["pintia.cn", "courses.zju.edu.cn"],
    isArray,
  );
  const [inbox, setInbox] = usePersistentState(
    STORAGE_KEYS.inbox,
    [],
    isInboxList,
  );
  const [todayPlanOrder, setTodayPlanOrder] = usePersistentState(
    STORAGE_KEYS.todayPlanOrder,
    () => ({ dayKey: localDayKey(), taskIds: [] }),
    isTodayPlanOrder,
  );
  const [gradeRecords, setGradeRecords] = usePersistentState(
    STORAGE_KEYS.gradeRecords,
    [],
    isGradeRecordList,
  );
  const [gradeSyncSettings, setGradeSyncSettings] = usePersistentState(
    STORAGE_KEYS.gradeSyncSettings,
    DEFAULT_GRADE_SYNC_SETTINGS,
    isGradeSyncSettings,
    (value) => ({
      ...DEFAULT_GRADE_SYNC_SETTINGS,
      ...normalizeGradeSyncSettings(value),
    }),
  );
  const [zjuCourseCatalog, setZjuCourseCatalog] = usePersistentState(
    STORAGE_KEYS.zjuCourseCatalog,
    [],
    isZjuCourseCatalog,
    normalizeZjuCourseCatalog,
  );
  const [lastAutomaticBackupDay, setLastAutomaticBackupDay] =
    usePersistentState(STORAGE_KEYS.lastAutomaticBackupDay, "", isString);
  const [dailyWork, setDailyWork] = usePersistentState(
    STORAGE_KEYS.dailyWork,
    createDailyWork,
    isDailyWork,
  );

  return {
    activeTaskId,
    completionHistory,
    customPresets,
    dailyWork,
    focusHistory,
    focusState,
    goals,
    gradeRecords,
    gradeSyncSettings,
    inbox,
    lastAutomaticBackupDay,
    lastSourceSyncAt,
    permanentWhitelist,
    projects,
    setActiveTaskId,
    setCompletionHistory,
    setCustomPresets,
    setDailyWork,
    setFocusHistory,
    setFocusState,
    setGoals,
    setGradeRecords,
    setGradeSyncSettings,
    setInbox,
    setLastAutomaticBackupDay,
    setLastSourceSyncAt,
    setPermanentWhitelist,
    setProjects,
    setTasks,
    setTodayPlanOrder,
    setZjuCourseCatalog,
    tasks,
    todayPlanOrder,
    zjuCourseCatalog,
  };
}
