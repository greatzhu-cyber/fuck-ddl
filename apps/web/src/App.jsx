import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowsClockwise,
  CalendarBlank,
  CaretDown,
  ChartBar,
  Check,
  CheckCircle,
  Clock,
  Coffee,
  Crosshair,
  Exam,
  Flag,
  Folder,
  Gear,
  GithubLogo,
  ListChecks,
  MagnifyingGlass,
  NotePencil,
  Pause,
  Play,
  Plus,
  PushPin,
  SidebarSimple,
  SlidersHorizontal,
  SignOut,
  Stop,
  Target,
  Timer,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { createInitialTasks, initialGoals } from "./data.js";
import {
  deadlineHoursUntil,
  distractionRestShare,
  estimatedPomodoros,
  formatDuration,
  formatRemaining,
  sortTasks,
  taskScore,
  timeRemainingRatio,
  urgencyMeta,
  workDistractionRate,
} from "@fuck-ddl/domain";
import {
  isArray,
  isGoalList,
  isInboxList,
  isProjectList,
  isTodayPlanOrder,
  isString,
  isTaskList,
  STORAGE_KEYS,
  usePersistentState,
  writePersistentState,
} from "./persistence.js";
import {
  createFocusState,
  defaultPresets,
  isFocusState,
  pauseFocus,
  resetForNewDay,
  localDayKey,
  resumeFromDistraction,
  startDistraction,
  startFocus,
  startRest,
  stopActiveTimer,
  stopFocus,
  tickFocus,
  timerDisplaySeconds,
} from "./focus.js";
import {
  mergeSourceUpdates,
  registerSourceAdapter,
  SOURCE_SYNC_INTERVAL_MS,
  syncSources,
} from "./source-sync.js";
import { sendSilentNotification } from "./desktop-notifications.js";
import {
  createPintiaDesktopAdapter,
  isTauriDesktop,
  openPintiaLogin,
  resetPintiaSession,
} from "./integrations/pintia-desktop.js";
import {
  createZjuDesktopAdapter,
  listZjuCourses,
  openZjuLogin,
  ZJU_PROGRESS_UI_EVENT,
} from "./integrations/zju-desktop.js";
import { setEdgeFocusActive } from "./integrations/edge-desktop.js";
import {
  authErrorMessage,
  githubIdentity,
  getSupabaseAuthClient,
  readSupabaseConfig,
  signInWithGithub,
} from "./auth.js";
import {
  migrateTaskSourceNames,
  SOURCE_PTA,
  SOURCE_ZJU,
} from "./source-names.js";
import {
  appendCompletionRecords,
  completionRecordsFromSync,
  createCompletionRecord,
  isCompletionHistory,
} from "./completion-history.js";
import {
  addDailyWorkSecond,
  calculateTodayMetrics,
  createDailyWork,
  focusEntriesForLocalDay,
  isDailyWork,
  resetDailyWork,
} from "./daily-metrics.js";
import {
  createBackupDocument,
  downloadBackupDocument,
  restoreBackupDocument,
} from "./backup.js";
import { saveDesktopBackup } from "./desktop-backup.js";
import { GradebookView } from "./GradebookView.jsx";
import {
  DEFAULT_GRADE_SYNC_SETTINGS,
  finalPtaGradeIds,
  isGradeRecordList,
  isGradeSyncSettings,
  isZjuCourseCatalog,
  mergeGradeRecords,
  normalizeGradeSyncSettings,
  normalizeZjuCourseCatalog,
} from "./grades.js";

const navItems = [
  { id: "deadlines", label: "最近 DDL", icon: Clock },
  { id: "today", label: "今日计划", icon: CalendarBlank },
  { id: "completed", label: "今日完成", icon: CheckCircle },
  { id: "grades", label: "成绩", icon: Exam },
  { id: "inbox", label: "收件箱", icon: Archive },
  { id: "goals", label: "目标", icon: Target },
  { id: "projects", label: "项目", icon: Folder },
  { id: "overdue", label: "过期任务", icon: WarningCircle },
  { id: "stats", label: "统计", icon: ChartBar },
  { id: "integrations", label: "集成", icon: ArrowsClockwise },
];

const importanceLabel = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "紧急",
};

function pintiaStatusFromResult(result) {
  if (result.syncedSources?.includes(SOURCE_PTA)) return "verified";
  const pintiaError = result.errors?.find(
    (error) => error.source === SOURCE_PTA,
  );
  if (!pintiaError) return null;
  if (pintiaError.message.includes("pta-session-corrupt"))
    return "session-corrupt";
  return pintiaError.message.includes("pintia-login-required")
    ? "login-required"
    : "failed";
}

function zjuStatusFromResult(result) {
  if (result.syncedSources?.includes(SOURCE_ZJU)) return "verified";
  const zjuError = result.errors?.find((error) => error.source === SOURCE_ZJU);
  if (!zjuError) return null;
  return zjuError.message.includes("zju-login-required")
    ? "login-required"
    : "failed";
}

function SourceBadge({ source }) {
  const className =
    source === SOURCE_PTA
      ? "source-pta"
      : source === SOURCE_ZJU
        ? "source-zju"
        : "source-manual";
  return <span className={`source-badge ${className}`}>{source}</span>;
}

function ProgressPair({ task }) {
  const meta = urgencyMeta(task.deadlineHours);
  const urgencyColor = `var(--${meta.tone})`;
  const timeWidth = `${Math.round(timeRemainingRatio(task.deadlineHours) * 100)}%`;
  const progressLabel = task.sourceProgressEstimated
    ? "部分完成"
    : `${task.progress}%`;
  return (
    <div className="progress-pair" aria-label={`${task.title}进度`}>
      <div className="progress-line">
        <span>完成程度</span>
        <div className="track">
          <span style={{ width: `${task.progress}%` }} />
        </div>
        <strong>{progressLabel}</strong>
      </div>
      <div className="progress-line time-line">
        <span>剩余时间</span>
        <div className="track">
          <span style={{ width: timeWidth, background: urgencyColor }} />
        </div>
        <strong style={{ color: urgencyColor }}>
          {formatRemaining(task.deadlineHours)}
        </strong>
      </div>
    </div>
  );
}

function TaskTable({
  tasks,
  onStart,
  onTogglePin,
  onSelect,
  onMove,
  ariaLabel = "最近 DDL 任务",
}) {
  return (
    <div className="task-table" role="table" aria-label={ariaLabel}>
      <div className="task-header" role="row">
        <span>任务</span>
        <span>进度</span>
        <span>来源</span>
        <span>DDL</span>
        <span>重要性</span>
        <span>置顶</span>
        <span>开始</span>
      </div>
      <div className="task-list">
        {tasks.map((task) => {
          const meta = urgencyMeta(task.deadlineHours);
          return (
            <div
              className={`task-row urgency-${meta.key}`}
              key={task.id}
              role="row"
              tabIndex={0}
              onClick={() => onSelect(task.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSelect(task.id);
              }}
            >
              <div className="task-name-cell">
                <strong>{task.title}</strong>
                <span>{task.subtitle}</span>
                {meta.rank <= 1 && <em>{meta.label}</em>}
                {onMove && (
                  <div className="plan-order-actions">
                    <button
                      className="icon-button"
                      disabled={tasks[0].id === task.id}
                      aria-label={`上移 ${task.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onMove(task.id, -1);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-button"
                      disabled={tasks.at(-1).id === task.id}
                      aria-label={`下移 ${task.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onMove(task.id, 1);
                      }}
                    >
                      ↓
                    </button>
                  </div>
                )}
              </div>
              <ProgressPair task={task} />
              <div>
                <SourceBadge source={task.source} />
              </div>
              <div className={`deadline-cell urgency-text-${meta.key}`}>
                <strong>{formatRemaining(task.deadlineHours)}</strong>
                <span>
                  {task.deadlineHours <= 24
                    ? "今天截止"
                    : `${Math.ceil(task.deadlineHours / 24)} 天内`}
                </span>
              </div>
              <div className="importance-cell">
                <Flag weight={meta.rank <= 2 ? "fill" : "regular"} />
                <span>{importanceLabel[task.importance]}</span>
              </div>
              <button
                className={`icon-button pin-button ${task.pinned ? "is-pinned" : ""}`}
                aria-label={
                  task.pinned ? `取消置顶${task.title}` : `置顶${task.title}`
                }
                title={task.pinned ? "取消置顶" : "置顶"}
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePin(task.id);
                }}
              >
                <PushPin weight={task.pinned ? "fill" : "regular"} />
              </button>
              <button
                className="start-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onStart(task.id);
                }}
              >
                <Play weight="fill" /> 开始
              </button>
            </div>
          );
        })}
      </div>
      <div className="task-footer">
        共 {tasks.length} 项任务 · 越快截止越靠上 · 手动置顶优先
      </div>
    </div>
  );
}

function EmptyView({ icon: Icon, title, description, action }) {
  return (
    <section className="empty-view">
      <Icon size={32} />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

function GoalsView({ goals, onCreate, onEdit, onDelete }) {
  return (
    <section className="goals-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">长期方向</p>
          <h1>目标</h1>
        </div>
        <button className="primary-button" onClick={onCreate}>
          <Plus /> 新建目标
        </button>
      </div>
      <div className="goal-list">
        {goals.map((goal) => (
          <article className="goal-row" key={goal.id}>
            <div className="goal-mark">
              <Crosshair weight="duotone" />
            </div>
            <div className="goal-copy">
              <h2>{goal.name}</h2>
              <p>{goal.description}</p>
              <div className="goal-next">下一项：{goal.next}</div>
            </div>
            <div className="goal-progress">
              <div>
                <span>整体进度</span>
                <strong>{goal.progress}%</strong>
              </div>
              <div className="track">
                <span style={{ width: `${goal.progress}%` }} />
              </div>
              <small>目标日期 {goal.target}</small>
            </div>
            <div className="goal-actions">
              <button
                className="icon-button"
                onClick={() => onEdit(goal.id)}
                aria-label={`编辑目标 ${goal.name}`}
                title="编辑目标"
              >
                <NotePencil />
              </button>
              <button
                className="icon-button danger-icon-button"
                onClick={() => onDelete(goal.id)}
                aria-label={`删除目标 ${goal.name}`}
                title="删除目标"
              >
                <Trash />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function TodayPlanView({ tasks, onStart, onTogglePin, onSelect, onMove }) {
  if (tasks.length === 0) {
    return (
      <EmptyView
        icon={CalendarBlank}
        title="今日没有待处理的 DDL"
        description="置顶任务、24 小时内截止任务会自动出现在这里；你仍可从最近 DDL 主动开始专注。"
      />
    );
  }
  return (
    <section className="deadlines-view">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">置顶优先 · 接着处理 24 小时内 DDL</p>
          <h1>今日计划</h1>
        </div>
        <span className="result-count">{tasks.length} 项</span>
      </div>
      <TaskTable
        tasks={tasks}
        ariaLabel="今日计划任务"
        onStart={onStart}
        onTogglePin={onTogglePin}
        onSelect={onSelect}
        onMove={onMove}
      />
    </section>
  );
}

function InboxView({ items, onCapture, onRemove, onSchedule }) {
  return (
    <section className="settings-view">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">先记下来，稍后再排 DDL</p>
          <h1>收件箱</h1>
        </div>
        <span className="result-count">{items.length} 条</span>
      </div>
      <article className="settings-block">
        <form className="domain-form" onSubmit={onCapture}>
          <input
            name="title"
            required
            placeholder="例如：找论文参考资料"
            aria-label="收件箱内容"
          />
          <button className="primary-button" type="submit">
            <Plus /> 记录
          </button>
        </form>
      </article>
      {items.length === 0 ? (
        <EmptyView
          icon={Archive}
          title="收件箱是空的"
          description="临时想法不会强迫你立刻填写 DDL；准备好时再把它转成任务。"
        />
      ) : (
        <div className="goal-list">
          {items.map((item) => (
            <article className="inbox-row" key={item.id}>
              <div className="goal-copy">
                <h2>{item.title}</h2>
                <p>记录于 {new Date(item.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <div className="goal-actions">
                <button
                  className="secondary-button"
                  onClick={() => onSchedule(item.id)}
                >
                  安排 DDL
                </button>
                <button
                  className="icon-button"
                  onClick={() => onRemove(item.id)}
                  aria-label={`删除收件箱条目 ${item.title}`}
                >
                  <Trash />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectsView({ projects, tasks, onCreate, onEdit, onDelete }) {
  return (
    <section className="goals-view projects-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">课程、实验与个人工作流</p>
          <h1>项目</h1>
        </div>
        <button className="primary-button" onClick={onCreate}>
          <Plus /> 新建项目
        </button>
      </div>
      {projects.length === 0 ? (
        <EmptyView
          icon={Folder}
          title="还没有手动项目"
          description="创建项目后，可在添加或编辑手动任务时归类；平台同步任务仍按来源管理。"
        />
      ) : (
        <div className="goal-list">
          {projects.map((project) => {
            const projectTasks = tasks.filter(
              (task) => task.projectId === project.id,
            );
            const focusedSeconds = projectTasks.reduce(
              (sum, task) => sum + Number(task.focusedSeconds ?? 0),
              0,
            );
            return (
              <article className="goal-row project-row" key={project.id}>
                <div
                  className="goal-mark project-mark"
                  style={{ "--project-color": project.color }}
                >
                  <Folder weight="duotone" />
                </div>
                <div className="goal-copy">
                  <h2>{project.name}</h2>
                  <p>{project.description || "尚未添加项目说明。"}</p>
                  <div className="goal-next">
                    {projectTasks.length} 项任务 · 已专注{" "}
                    {formatDuration(focusedSeconds)}
                  </div>
                </div>
                <div className="project-task-summary">
                  <strong>{projectTasks.length}</strong>
                  <span>当前任务</span>
                </div>
                <div className="goal-actions">
                  <button
                    className="icon-button"
                    onClick={() => onEdit(project.id)}
                    aria-label={`编辑项目 ${project.name}`}
                  >
                    <NotePencil />
                  </button>
                  <button
                    className="icon-button danger-icon-button"
                    onClick={() => onDelete(project.id)}
                    aria-label={`删除项目 ${project.name}`}
                  >
                    <Trash />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CompletedTodayView({ entries, onSelect }) {
  if (entries.length === 0) {
    return (
      <EmptyView
        icon={CheckCircle}
        title="今天还没有完成记录"
        description="手动任务完成归档，或来源网站明确返回已完成后，会按完成时间记录在这里。"
      />
    );
  }
  return (
    <section className="completed-view">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">本地自然日 · 完成后自动留痕</p>
          <h1>今日完成</h1>
        </div>
        <span className="result-count">{entries.length} 项</span>
      </div>
      <div className="completion-ledger" role="list" aria-label="今日完成任务">
        {entries.map((entry) => {
          const completedAt = new Date(entry.completedAt);
          const deadlineAt = entry.deadlineAt
            ? new Date(entry.deadlineAt)
            : null;
          return (
            <article
              className={`completion-entry ${entry.source === "手动" ? "is-editable" : ""}`}
              role="listitem"
              key={entry.id}
              tabIndex={entry.source === "手动" ? 0 : undefined}
              onClick={() => entry.source === "手动" && onSelect(entry.id)}
              onKeyDown={(event) => {
                if (entry.source === "手动" && event.key === "Enter") {
                  onSelect(entry.id);
                }
              }}
            >
              <div className="completion-stamp" aria-hidden="true">
                <Check weight="bold" />
              </div>
              <div className="completion-entry-copy">
                <div>
                  <h2>{entry.title}</h2>
                  <SourceBadge source={entry.source} />
                </div>
                <p>{entry.subtitle || "已完成并从当前 DDL 中移除"}</p>
                {deadlineAt && !Number.isNaN(deadlineAt.getTime()) && (
                  <small>
                    原 DDL：
                    {deadlineAt.toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </small>
                )}
              </div>
              <time dateTime={entry.completedAt}>
                {completedAt.toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </time>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function StatsView({
  focusState,
  workedSeconds,
  history,
  tasks,
  onAddManual,
  onDeleteManual,
}) {
  const restShare = distractionRestShare(
    focusState.distractionSecondsToday,
    focusState.formalRestSecondsToday,
  );
  const workRate = workDistractionRate(
    focusState.distractionSecondsToday,
    focusState.focusedSecondsToday,
  );
  const percent = (value) =>
    value === null ? "暂无数据" : `${(value * 100).toFixed(1)}%`;
  return (
    <section className="stats-view">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">今日专注账本</p>
          <h1>统计</h1>
        </div>
        <div className="section-actions">
          <span className="result-count">{history.length} 条记录</span>
          <button className="secondary-button" onClick={onAddManual}>
            <Plus /> 补录时间
          </button>
        </div>
      </div>
      <div className="stats-grid">
        <article>
          <span>有效工作</span>
          <strong>{formatDuration(workedSeconds)}</strong>
          <small>{focusState.completedPomodorosToday} 个完整番茄</small>
        </article>
        <article>
          <span>正式休息</span>
          <strong>{formatDuration(focusState.formalRestSecondsToday)}</strong>
          <small>
            额度余额 {focusState.restBalanceSeconds < 0 ? "−" : "+"}
            {formatDuration(Math.abs(focusState.restBalanceSeconds))}
          </small>
        </article>
        <article className="distraction-card">
          <span>摸鱼时间</span>
          <strong>{formatDuration(focusState.distractionSecondsToday)}</strong>
          <small>仅统计非白名单域名超出阈值后的时间</small>
        </article>
      </div>
      <div className="ratio-grid">
        <article>
          <div>
            <span>摸鱼休息占比</span>
            <strong>{percent(restShare)}</strong>
          </div>
          <p>摸鱼 ÷（摸鱼 + 正式休息）</p>
        </article>
        <article>
          <div>
            <span>工作过程摸鱼率</span>
            <strong>{percent(workRate)}</strong>
          </div>
          <p>摸鱼 ÷（有效工作 + 摸鱼）</p>
        </article>
      </div>
      <div className="time-ledger" role="list" aria-label="今日时间记录">
        {history
          .slice()
          .sort(
            (left, right) =>
              Date.parse(right.endedAt) - Date.parse(left.endedAt),
          )
          .map((entry) => {
            const task = tasks.find((item) => item.id === entry.taskId);
            return (
              <article role="listitem" key={entry.id}>
                <div>
                  <strong>{task?.title ?? "临时专注"}</strong>
                  <span>
                    {entry.manual
                      ? "手动补录"
                      : entry.completed
                        ? "完整专注"
                        : "提前结束"}
                  </span>
                </div>
                <time dateTime={entry.endedAt}>
                  {new Date(entry.endedAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </time>
                <strong>{formatDuration(entry.focusedSeconds)}</strong>
                {entry.manual && (
                  <button
                    className="icon-button danger-icon-button"
                    onClick={() => onDeleteManual(entry.id)}
                    aria-label="删除补录时间"
                  >
                    <Trash />
                  </button>
                )}
              </article>
            );
          })}
      </div>
    </section>
  );
}

function SettingsView({
  whitelist,
  onAddDomain,
  onRemoveDomain,
  onExportBackup,
  onImportBackup,
}) {
  return (
    <section className="settings-view">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">专注与隐私</p>
          <h1>设置</h1>
        </div>
      </div>
      <article className="settings-block">
        <div>
          <h2>工作网站白名单</h2>
          <p>只保存域名。完整 URL、网页标题和搜索内容不会进入记录。</p>
        </div>
        <div className="domain-list">
          {whitelist.map((domain) => (
            <span key={domain}>
              {domain}
              <button
                className="icon-button"
                onClick={() => onRemoveDomain(domain)}
                aria-label={`移除 ${domain}`}
              >
                <X />
              </button>
            </span>
          ))}
        </div>
        <form className="domain-form" onSubmit={onAddDomain}>
          <input
            name="domain"
            required
            placeholder="例如：docs.example.com"
            aria-label="添加工作网站域名"
          />
          <button className="secondary-button" type="submit">
            <Plus /> 添加域名
          </button>
        </form>
      </article>
      <article className="settings-block backup-block">
        <div>
          <h2>本地备份</h2>
          <p>
            导出任务、项目、目标、计时和设置；不会包含平台 Cookie、密码或 GitHub
            会话。桌面端每天会在本机保留最近 14
            份自动备份；导入前也会先保存当前恢复点。
          </p>
        </div>
        <div className="backup-actions">
          <button className="secondary-button" onClick={onExportBackup}>
            导出 JSON
          </button>
          <label className="secondary-button file-button">
            导入备份
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => onImportBackup(event.target.files?.[0])}
            />
          </label>
        </div>
      </article>
    </section>
  );
}

function IntegrationsView({
  lastSyncAt,
  pintiaStatus,
  zjuStatus,
  onConnectPintia,
  onConnectZju,
}) {
  const pintiaState = {
    checking: "正在验证本机会话",
    verified: "会话已验证",
    "login-required": "需要登录",
    "session-corrupt": "登录状态需要重置",
    failed: "读取失败",
    "desktop-required": "仅桌面端可连接",
  }[pintiaStatus];
  const zjuState = {
    checking: "正在验证本机会话",
    verified: "会话已验证",
    "login-required": "需要登录",
    failed: "读取失败",
    "desktop-required": "仅桌面端可连接",
  }[zjuStatus];
  return (
    <section className="integrations-view">
      <div className="section-heading integration-heading">
        <div>
          <p className="eyebrow">本机会话 · 只读同步</p>
          <h1>任务来源</h1>
        </div>
      </div>
      <p className="integration-sync-hint">
        这里只负责登录与连接状态。更新任务请到「最近
        DDL」，更新成绩请到「成绩」页；两条读取路径分开，避免一次全量拖慢。
      </p>
      <div className="integration-track" aria-label="来源连接状态">
        <article className="integration-source is-ready">
          <span className="source-index">P</span>
          <div>
            <p className="source-kicker">PTA</p>
            <h2>题目集 → DDL 与成绩</h2>
            <p>
              任务：活跃题目集关闭时间与完成题数。成绩：已结束题目集详情中的分数、排名与错过状态。
            </p>
          </div>
          <div className="source-actions">
            <span className="connection-state">{pintiaState}</span>
            <button className="primary-button" onClick={onConnectPintia}>
              {pintiaStatus === "session-corrupt"
                ? "重置 PTA 登录"
                : pintiaStatus === "verified"
                  ? "查看 PTA"
                  : "登录 PTA"}
            </button>
          </div>
        </article>
        <article className="integration-source is-ready">
          <span className="source-index">Z</span>
          <div>
            <p className="source-kicker">学在浙大</p>
            <h2>课程作业 → DDL 与成绩</h2>
            <p>
              任务：课程内容页摘要中的结束时间与提交状态。成绩：再打开作业详情确认已出分、未公布或错过
              DDL。
            </p>
          </div>
          <div className="source-actions">
            <span className="connection-state">{zjuState}</span>
            <button className="primary-button" onClick={onConnectZju}>
              {zjuStatus === "verified" ? "查看学在浙大" : "登录学在浙大"}
            </button>
          </div>
        </article>
        <article className="integration-source is-linked">
          <span className="source-index">E</span>
          <div>
            <p className="source-kicker">Edge Focus Guard</p>
            <h2>域名停留 → 摸鱼记录</h2>
            <p>只传输 hostname；Native Host 与 Windows 无声通知已通过。</p>
          </div>
          <span className="connection-state">已注册 · 状态见扩展弹窗</span>
        </article>
      </div>
      <p className="integration-footnote">
        上次成功读取：
        {lastSyncAt ? new Date(lastSyncAt).toLocaleString("zh-CN") : "尚无"}
      </p>
    </section>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function dateTimeLocalValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function App() {
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
  const [activeView, setActiveView] = useState("deadlines");
  const [search, setSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [draftInboxId, setDraftInboxId] = useState(null);
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editingGoalId, setEditingGoalId] = useState(null);
  const [editingProjectId, setEditingProjectId] = useState(null);
  const [selectedCompletionId, setSelectedCompletionId] = useState(null);
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const [showManualTime, setShowManualTime] = useState(false);
  const [completedSession, setCompletedSession] = useState(null);
  const [progressDraft, setProgressDraft] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
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
  const [loadingZjuCourses, setLoadingZjuCourses] = useState(false);
  const [lastAutomaticBackupDay, setLastAutomaticBackupDay] =
    usePersistentState(STORAGE_KEYS.lastAutomaticBackupDay, "", isString);
  const [dailyWork, setDailyWork] = usePersistentState(
    STORAGE_KEYS.dailyWork,
    createDailyWork,
    isDailyWork,
  );
  const [nowMs, setNowMs] = useState(Date.now);
  const workedSeconds = dailyWork.seconds;
  const [accountOpen, setAccountOpen] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authStatus, setAuthStatus] = useState(() =>
    readSupabaseConfig() ? "checking" : "not-configured",
  );
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeSyncMode, setActiveSyncMode] = useState("tasks");
  const [syncDebugLines, setSyncDebugLines] = useState([]);
  const [syncDebugOpen, setSyncDebugOpen] = useState(false);
  const [pintiaStatus, setPintiaStatus] = useState(() =>
    isTauriDesktop() ? "checking" : "desktop-required",
  );
  const [zjuStatus, setZjuStatus] = useState(() =>
    isTauriDesktop() ? "checking" : "desktop-required",
  );
  const [sessionWhitelist, setSessionWhitelist] = useState([]);
  const [toast, setToast] = useState("");
  const previousPhase = useRef(focusState.phase);
  const stateRef = useRef(focusState);
  const tasksRef = useRef(tasks);
  const historyRef = useRef(focusHistory);
  const gradeRecordsRef = useRef(gradeRecords);
  const gradeSyncSettingsRef = useRef(gradeSyncSettings);
  const zjuCourseCatalogRef = useRef(zjuCourseCatalog);

  const presets = useMemo(
    () => [...defaultPresets, ...customPresets],
    [customPresets],
  );
  const supabaseConfig = useMemo(() => readSupabaseConfig(), []);
  const supabaseAuth = useMemo(() => getSupabaseAuthClient(), []);
  const githubUser = useMemo(() => githubIdentity(authUser), [authUser]);
  const activePreset =
    presets.find((preset) => preset.id === focusState.modeId) ??
    defaultPresets[0];
  const todayMetrics = useMemo(
    () => calculateTodayMetrics(tasks, completionHistory, new Date(nowMs)),
    [completionHistory, nowMs, tasks],
  );
  const todayFocusHistory = useMemo(
    () => focusEntriesForLocalDay(focusHistory, new Date(nowMs)),
    [focusHistory, nowMs],
  );
  const todayCompletionPercent =
    todayMetrics.completionRate === null
      ? null
      : Math.round(todayMetrics.completionRate * 100);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!supabaseAuth) {
      return undefined;
    }
    let alive = true;
    void supabaseAuth.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error) setAuthError(authErrorMessage(error));
      setAuthUser(data?.session?.user ?? null);
      setAuthStatus("ready");
    });
    const { data } = supabaseAuth.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setAuthUser(session?.user ?? null);
      setAuthStatus("ready");
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [supabaseAuth]);

  const startGithubLogin = useCallback(async () => {
    setAuthBusy(true);
    setAuthError("");
    try {
      await signInWithGithub(supabaseAuth, { config: supabaseConfig });
    } catch (error) {
      setAuthError(authErrorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }, [supabaseAuth, supabaseConfig]);

  const signOutGithub = useCallback(async () => {
    if (!supabaseAuth) return;
    setAuthBusy(true);
    const { error } = await supabaseAuth.auth.signOut();
    if (error) setAuthError(authErrorMessage(error));
    else setAccountOpen(false);
    setAuthBusy(false);
  }, [supabaseAuth]);

  useEffect(() => {
    stateRef.current = focusState;
  }, [focusState]);

  useEffect(() => {
    void setEdgeFocusActive(focusState.phase === "focusing").catch(() => {
      // Edge integration degrades independently when the desktop bridge is unavailable.
    });
  }, [focusState.phase]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    historyRef.current = focusHistory;
  }, [focusHistory]);

  useEffect(() => {
    gradeRecordsRef.current = gradeRecords;
  }, [gradeRecords]);

  useEffect(() => {
    gradeSyncSettingsRef.current = gradeSyncSettings;
  }, [gradeSyncSettings]);

  useEffect(() => {
    zjuCourseCatalogRef.current = zjuCourseCatalog;
  }, [zjuCourseCatalog]);

  // Live 学在浙大 crawl lines (catalog + grades + tasks).
  useEffect(() => {
    function handleZjuProgress(event) {
      const message = String(event?.detail || "").trim();
      if (!message) return;
      const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      setSyncDebugOpen(true);
      setSyncDebugLines((current) => [
        ...current.slice(-100),
        `[${stamp}] ${message}`,
      ]);
    }
    window.addEventListener(ZJU_PROGRESS_UI_EVENT, handleZjuProgress);
    return () =>
      window.removeEventListener(ZJU_PROGRESS_UI_EVENT, handleZjuProgress);
  }, []);

  useEffect(() => {
    const date = new Date();
    setFocusState((current) => resetForNewDay(current, date));
    setDailyWork((current) => resetDailyWork(current, date));
  }, [setDailyWork, setFocusState, todayMetrics.dayKey]);

  useEffect(() => {
    function handleDomainThreshold(event) {
      const domain = String(event.detail?.domain ?? "").toLowerCase();
      const allowed = [...permanentWhitelist, ...sessionWhitelist].some(
        (item) => domain === item || domain.endsWith(`.${item}`),
      );
      if (!domain || allowed || stateRef.current.phase !== "focusing") return;
      setFocusState((current) => startDistraction(current, domain));
      setToast(`已暂停专注：${domain} 开始计入摸鱼时间`);
      void sendSilentNotification(
        "专注已暂停",
        `${domain} 开始计入摸鱼时间。返回后点击继续专注。`,
      );
    }
    function handleDomainLeft(event) {
      const domain = String(event.detail?.domain ?? "").toLowerCase();
      if (
        stateRef.current.phase !== "distracted" ||
        stateRef.current.distractionDomain !== domain
      )
        return;
      void sendSilentNotification(
        "可以继续专注",
        `你已离开 ${domain}；计时不会自动恢复。`,
      );
    }
    window.addEventListener("fuck-ddl:domain-threshold", handleDomainThreshold);
    window.addEventListener("fuck-ddl:domain-left", handleDomainLeft);
    return () => {
      window.removeEventListener(
        "fuck-ddl:domain-threshold",
        handleDomainThreshold,
      );
      window.removeEventListener("fuck-ddl:domain-left", handleDomainLeft);
    };
  }, [permanentWhitelist, sessionWhitelist, setFocusState]);

  useEffect(() => {
    if (!["focusing", "resting", "distracted"].includes(focusState.phase))
      return undefined;
    const interval = window.setInterval(() => {
      if (stateRef.current.phase === "focusing") {
        setDailyWork((current) => addDailyWorkSecond(current));
      }
      setFocusState((current) => {
        const preset =
          presets.find((item) => item.id === current.modeId) ??
          defaultPresets[0];
        return tickFocus(resetForNewDay(current), preset);
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [focusState.phase, presets, setDailyWork, setFocusState]);

  useEffect(() => {
    if (!toast) return undefined;
    // Sync diagnostics stay readable longer than short status toasts.
    const duration = toast.includes("[同步]") ? 8000 : 2400;
    const timeout = window.setTimeout(() => setToast(""), duration);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!isTauriDesktop()) return undefined;
    const unregisterPintia = registerSourceAdapter(
      SOURCE_PTA,
      createPintiaDesktopAdapter(() => ({
        ...gradeSyncSettingsRef.current,
        knownFinalIds: finalPtaGradeIds(gradeRecordsRef.current),
      })),
    );
    const unregisterZju = registerSourceAdapter(
      SOURCE_ZJU,
      createZjuDesktopAdapter(() => {
        const settings = gradeSyncSettingsRef.current;
        const catalog = zjuCourseCatalogRef.current;
        const selected = new Set(
          Array.isArray(settings.zjuCourseIds)
            ? settings.zjuCourseIds.map(String)
            : [],
        );
        const courses = catalog.filter((course) =>
          selected.has(String(course.courseId)),
        );
        return { courses };
      }),
    );
    return () => {
      unregisterPintia();
      unregisterZju();
    };
  }, []);

  const applySuccessfulSourceSync = useCallback(
    (result) => {
      const before = tasksRef.current;
      const incomingGrades = Array.isArray(result.grades) ? result.grades : [];
      const next = mergeSourceUpdates(before, result.updates, result);
      const completions = completionRecordsFromSync(before, result);
      const beforeIds = new Set(before.map((item) => item.id));
      const nextIds = new Set(next.map((item) => item.id));
      tasksRef.current = next;
      setTasks(next);
      if (completions.length > 0) {
        setCompletionHistory((current) =>
          appendCompletionRecords(current, completions),
        );
      }
      if (incomingGrades.length > 0) {
        setGradeRecords((current) =>
          mergeGradeRecords(current, incomingGrades),
        );
      }
      setActiveTaskId((current) =>
        !current || nextIds.has(current) ? current : "",
      );
      setSelectedTaskId((current) =>
        !current || nextIds.has(current) ? current : null,
      );
      return {
        added: next.filter((item) => !beforeIds.has(item.id)).length,
        removed: before.filter((item) => !nextIds.has(item.id)).length,
        completed: completions.length,
        grades: incomingGrades.length,
      };
    },
    [setActiveTaskId, setCompletionHistory, setGradeRecords, setTasks],
  );

  useEffect(() => {
    let active = true;
    async function runScheduledSync() {
      // Background only; never auto-run on first paint (was hanging/crashing startup).
      const result = await syncSources({ mode: "tasks" });
      if (!active) return;
      const nextPintiaStatus = pintiaStatusFromResult(result);
      if (nextPintiaStatus) setPintiaStatus(nextPintiaStatus);
      const nextZjuStatus = zjuStatusFromResult(result);
      if (nextZjuStatus) setZjuStatus(nextZjuStatus);
      if (result.status === "success") {
        applySuccessfulSourceSync(result);
        setLastSourceSyncAt(result.syncedAt);
      }
    }
    const interval = window.setInterval(
      runScheduledSync,
      SOURCE_SYNC_INTERVAL_MS,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [applySuccessfulSourceSync, setLastSourceSyncAt]);

  useEffect(() => {
    let active = true;
    async function writeDailyBackup() {
      const dayKey = localDayKey();
      if (dayKey === lastAutomaticBackupDay) return;
      try {
        const saved = await saveDesktopBackup(
          createBackupDocument(window.localStorage),
        );
        if (active && saved) setLastAutomaticBackupDay(dayKey);
      } catch {
        // The app stays usable if a desktop backup cannot be written.
      }
    }
    void writeDailyBackup();
    const interval = window.setInterval(writeDailyBackup, 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [lastAutomaticBackupDay, setLastAutomaticBackupDay]);

  useEffect(() => {
    const justCompleted =
      focusState.phase === "focus-complete" &&
      previousPhase.current !== "focus-complete";
    previousPhase.current = focusState.phase;
    if (!justCompleted) return;

    const entry = {
      id: focusState.sessionId,
      taskId: focusState.taskId,
      modeId: focusState.modeId,
      focusedSeconds: focusState.focusSeconds,
      completed: true,
      endedAt: new Date().toISOString(),
    };
    setFocusHistory((current) =>
      current.some((item) => item.id === entry.id)
        ? current
        : [...current, entry],
    );
    if (focusState.taskId) {
      const nextTasks = tasksRef.current.map((task) =>
        task.id === focusState.taskId
          ? {
              ...task,
              focusedSeconds:
                Number(task.focusedSeconds ?? 0) + focusState.focusSeconds,
              completedPomodoros: Number(task.completedPomodoros ?? 0) + 1,
            }
          : task,
      );
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
    }
    const task = tasksRef.current.find((item) => item.id === focusState.taskId);
    if (task?.sourceLocked) {
      setSyncing(true);
      void syncSources({ task }).then((result) => {
        setSyncing(false);
        const nextPintiaStatus = pintiaStatusFromResult(result);
        if (nextPintiaStatus) setPintiaStatus(nextPintiaStatus);
        const nextZjuStatus = zjuStatusFromResult(result);
        if (nextZjuStatus) setZjuStatus(nextZjuStatus);
        if (result.status === "success") {
          const summary = applySuccessfulSourceSync(result);
          setLastSourceSyncAt(result.syncedAt);
          setToast(
            summary.completed > 0
              ? `${task.source} 已确认完成，已记入今日完成`
              : `${task.source} 进度已更新`,
          );
        } else {
          setToast(`已保存计时；${task.source} 尚未连接，进度未刷新`);
        }
      });
    }
    setProgressDraft(task?.progress ?? 0);
    setCompletedSession(entry);
    void sendSilentNotification(
      "专注完成",
      `已完成 ${formatDuration(focusState.focusSeconds)}，请选择休息或继续一轮。`,
    );
  }, [
    applySuccessfulSourceSync,
    focusState,
    setFocusHistory,
    setLastSourceSyncAt,
    setTasks,
  ]);

  useEffect(() => {
    function saveBeforeClose() {
      const current = stateRef.current;
      const preset =
        presets.find((item) => item.id === current.modeId) ?? defaultPresets[0];
      let finalState = current;
      if (["focusing", "paused"].includes(current.phase)) {
        finalState = stopFocus(current, preset);
        const entry = {
          id: current.sessionId,
          taskId: current.taskId,
          modeId: current.modeId,
          focusedSeconds: current.focusSeconds,
          completed: false,
          endedAt: new Date().toISOString(),
        };
        const history = historyRef.current.some((item) => item.id === entry.id)
          ? historyRef.current
          : [...historyRef.current, entry];
        writePersistentState(STORAGE_KEYS.focusHistory, history);
        if (current.taskId && current.focusSeconds > 0) {
          const nextTasks = tasksRef.current.map((task) =>
            task.id === current.taskId
              ? {
                  ...task,
                  focusedSeconds:
                    Number(task.focusedSeconds ?? 0) + current.focusSeconds,
                }
              : task,
          );
          writePersistentState(STORAGE_KEYS.tasks, nextTasks);
        }
      } else if (["resting", "distracted"].includes(current.phase)) {
        finalState = stopActiveTimer(current);
      }
      writePersistentState(STORAGE_KEYS.focusState, finalState);
    }

    window.addEventListener("beforeunload", saveBeforeClose);
    return () => window.removeEventListener("beforeunload", saveBeforeClose);
  }, [presets]);

  const displayTasks = useMemo(
    () =>
      tasks.map((task) => ({
        ...task,
        deadlineHours: task.deadlineAt
          ? deadlineHoursUntil(task.deadlineAt, nowMs)
          : task.deadlineHours,
      })),
    [tasks, nowMs],
  );

  const sortedTasks = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    const filtered = normalized
      ? displayTasks.filter((task) =>
          `${task.title} ${task.subtitle} ${task.source}`
            .toLowerCase()
            .includes(normalized),
        )
      : displayTasks;
    return sortTasks(filtered);
  }, [displayTasks, search]);
  const todayPlanTasks = useMemo(() => {
    const base = sortedTasks.filter(
      (task) =>
        task.pinned || (task.deadlineHours > 0 && task.deadlineHours <= 24),
    );
    if (todayPlanOrder.dayKey !== todayMetrics.dayKey) return base;
    const position = new Map(
      todayPlanOrder.taskIds.map((taskId, index) => [taskId, index]),
    );
    return base.slice().sort((left, right) => {
      const leftIndex = position.get(left.id);
      const rightIndex = position.get(right.id);
      if (leftIndex === undefined && rightIndex === undefined) return 0;
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    });
  }, [sortedTasks, todayMetrics.dayKey, todayPlanOrder]);

  const activeTask = activeTaskId
    ? (displayTasks.find((task) => task.id === activeTaskId) ?? null)
    : null;
  const selectedTask = displayTasks.find((task) => task.id === selectedTaskId);
  const editingTask = tasks.find(
    (task) => task.id === editingTaskId && !task.sourceLocked,
  );
  const editingGoal = goals.find((goal) => goal.id === editingGoalId);
  const editingProject = projects.find(
    (project) => project.id === editingProjectId,
  );
  const selectedCompletion = completionHistory.find(
    (entry) => entry.id === selectedCompletionId && entry.source === "手动",
  );
  const timerSeconds = timerDisplaySeconds(focusState);
  const timerRunning = ["focusing", "resting", "distracted"].includes(
    focusState.phase,
  );

  function selectTask(taskId) {
    setSelectedTaskId(taskId);
    setActiveTaskId(taskId);
  }

  function selectFocusTask(taskId) {
    if (focusState.phase !== "idle") return;
    setActiveTaskId(taskId);
    setToast(taskId ? "已选择专注任务" : "已切换为临时专注");
  }

  function togglePin(taskId) {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, pinned: !task.pinned } : task,
      ),
    );
    setToast("任务置顶状态已更新");
  }

  function moveTodayTask(taskId, delta) {
    const taskIds = todayPlanTasks.map((task) => task.id);
    const currentIndex = taskIds.indexOf(taskId);
    const nextIndex = currentIndex + delta;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= taskIds.length)
      return;
    [taskIds[currentIndex], taskIds[nextIndex]] = [
      taskIds[nextIndex],
      taskIds[currentIndex],
    ];
    setTodayPlanOrder({ dayKey: todayMetrics.dayKey, taskIds });
  }

  function recordPartialSession(snapshot) {
    if (!snapshot.sessionId || snapshot.focusSeconds <= 0) return;
    const entry = {
      id: snapshot.sessionId,
      taskId: snapshot.taskId,
      modeId: snapshot.modeId,
      focusedSeconds: snapshot.focusSeconds,
      completed: false,
      endedAt: new Date().toISOString(),
    };
    setFocusHistory((current) =>
      current.some((item) => item.id === entry.id)
        ? current
        : [...current, entry],
    );
    if (snapshot.taskId) {
      setTasks((current) =>
        current.map((task) =>
          task.id === snapshot.taskId
            ? {
                ...task,
                focusedSeconds:
                  Number(task.focusedSeconds ?? 0) + snapshot.focusSeconds,
              }
            : task,
        ),
      );
    }
  }

  function startTask(taskId = null) {
    let base = focusState;
    if (["focusing", "paused"].includes(base.phase)) {
      recordPartialSession(base);
      base = stopFocus(base, activePreset);
    } else if (
      ["resting", "distracted", "focus-complete"].includes(base.phase)
    ) {
      base = stopActiveTimer(base);
    }
    setActiveTaskId(taskId ?? "");
    setFocusState(startFocus(base, activePreset, taskId));
    setCompletedSession(null);
    setToast(taskId ? "已开始任务专注" : "已开始临时专注");
  }

  function changeMode(modeId) {
    if (focusState.phase !== "idle") {
      setToast("请先结束当前计时再切换模式");
      return;
    }
    const preset = presets.find((item) => item.id === modeId);
    if (!preset) return;
    setFocusState((current) => ({
      ...current,
      modeId,
      targetFocusSeconds:
        preset.focusMinutes === null ? null : preset.focusMinutes * 60,
      focusSeconds: 0,
    }));
  }

  function togglePause() {
    if (["focusing", "paused"].includes(focusState.phase)) {
      setFocusState((current) => pauseFocus(current));
      return;
    }
    if (focusState.phase === "idle") startTask(activeTask?.id ?? null);
  }

  function finishCurrentFocus() {
    if (!["focusing", "paused"].includes(focusState.phase)) return;
    recordPartialSession(focusState);
    const next = stopFocus(focusState, activePreset);
    setFocusState(next);
    const task = tasks.find((item) => item.id === focusState.taskId);
    if (task?.sourceLocked) void requestSourceSync({ taskId: task.id });
    setProgressDraft(task?.progress ?? 0);
    setCompletedSession({
      id: focusState.sessionId,
      taskId: focusState.taskId,
      modeId: focusState.modeId,
      focusedSeconds: focusState.focusSeconds,
      completed: false,
    });
  }

  function completeManualTask(task) {
    if (!task || task.sourceLocked) return false;
    if (
      task.id === focusState.taskId &&
      ["focusing", "paused", "distracted"].includes(focusState.phase)
    ) {
      setToast("请先停止当前专注，再完成并归档任务");
      return false;
    }
    const record = createCompletionRecord(
      { ...task, progress: 100 },
      new Date().toISOString(),
      "manual",
    );
    const nextTasks = tasksRef.current.filter((item) => item.id !== task.id);
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    setCompletionHistory((current) =>
      appendCompletionRecords(current, [record]),
    );
    setActiveTaskId((current) => (current === task.id ? "" : current));
    setSelectedTaskId((current) => (current === task.id ? null : current));
    setToast("任务已完成并记入今日完成");
    return true;
  }

  function deleteManualTask(taskId) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task || task.sourceLocked) return;
    if (
      task.id === focusState.taskId &&
      ["focusing", "paused", "distracted"].includes(focusState.phase)
    ) {
      setToast("请先停止当前专注，再删除任务");
      return;
    }
    const nextTasks = tasksRef.current.filter((item) => item.id !== taskId);
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    setActiveTaskId((current) => (current === taskId ? "" : current));
    setSelectedTaskId((current) => (current === taskId ? null : current));
    setEditingTaskId((current) => (current === taskId ? null : current));
    setToast("手动任务已删除");
  }

  function saveCompletionProgress() {
    const taskId = completedSession?.taskId;
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!taskId || !task || task.sourceLocked) return false;
    if (progressDraft >= 100) return completeManualTask(task);
    const nextTasks = tasksRef.current.map((item) =>
      item.id === taskId ? { ...item, progress: progressDraft } : item,
    );
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    return false;
  }

  function beginRest() {
    saveCompletionProgress();
    setFocusState((current) => startRest(current));
    setCompletedSession(null);
    setToast("开始休息；额度将实时扣减");
  }

  function continueFocusCycle() {
    const taskCompleted = saveCompletionProgress();
    const taskId = taskCompleted
      ? null
      : (completedSession?.taskId ?? focusState.taskId);
    setFocusState((current) =>
      startFocus(stopActiveTimer(current), activePreset, taskId),
    );
    setCompletedSession(null);
    setToast("已保留休息额度并继续一轮");
  }

  function closeCompletion() {
    saveCompletionProgress();
    setFocusState((current) => stopActiveTimer(current));
    setCompletedSession(null);
    setToast("专注记录已保存");
  }

  function stopRestTimer() {
    setFocusState((current) => stopActiveTimer(current));
    setToast("休息记录已保存");
  }

  function resumeDistractedFocus() {
    setFocusState((current) => resumeFromDistraction(current));
    setToast("已继续专注");
  }

  function allowCurrentDomain(permanent = false) {
    const domain = focusState.distractionDomain;
    if (!domain) return;
    if (permanent) {
      setPermanentWhitelist((current) =>
        current.includes(domain) ? current : [...current, domain],
      );
    } else {
      setSessionWhitelist((current) =>
        current.includes(domain) ? current : [...current, domain],
      );
    }
    setFocusState((current) => resumeFromDistraction(current));
    setToast(`${domain} 已设为${permanent ? "永久" : "本轮"}工作网站`);
  }

  async function requestLoadZjuCourses() {
    if (loadingZjuCourses || syncing) return;
    if (!isTauriDesktop()) {
      setToast("读取学在浙大课程列表只能在 Windows 桌面端使用");
      return;
    }
    setLoadingZjuCourses(true);
    setSyncDebugOpen(true);
    setActiveSyncMode("grades");
    const stamp = () =>
      new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setSyncDebugLines([
      `[${stamp()}] 自动打开学在浙大「我的课程」，读取课程列表并写入本地…`,
    ]);
    try {
      const courses = normalizeZjuCourseCatalog(
        await listZjuCourses({
          onProgress: (message) => {
            setSyncDebugLines((current) => [
              ...current.slice(-100),
              `[${stamp()}] ${message}`,
            ]);
          },
        }),
      );
      // Persist catalog for the grade-source tree multi-select.
      setZjuCourseCatalog(courses);
      zjuCourseCatalogRef.current = courses;
      // Drop selections that disappeared from the catalog.
      setGradeSyncSettings((current) => {
        const next = {
          ...current,
          zjuCourseIds: (current.zjuCourseIds || []).filter((id) =>
            courses.some((course) => String(course.courseId) === String(id)),
          ),
        };
        gradeSyncSettingsRef.current = next;
        return next;
      });
      const bySemester = courses.reduce((map, course) => {
        const key = course.semester || "未知学期";
        map.set(key, (map.get(key) || 0) + 1);
        return map;
      }, new Map());
      const semesterSummary = [...bySemester.entries()]
        .map(([name, count]) => `${name} ${count}门`)
        .join(" · ");
      setToast(
        courses.length > 0
          ? `已写入 ${courses.length} 门课（${semesterSummary || "无学期"}）；请先选学期再勾课`
          : "未读到课程；请先在集成页登录学在浙大后重试",
      );
      // Force UI to show the new catalog (semester select + checkboxes).
      setSyncDebugLines((current) => [
        ...current,
        `[${stamp()}] ✓ 课程列表已写入本地 ${courses.length} 门` +
          (semesterSummary ? ` · ${semesterSummary}` : ""),
        ...[...bySemester.entries()].map(
          ([name, count]) => `[${stamp()}]   学期 ${name}：${count} 门`,
        ),
        ...courses
          .slice(0, 30)
          .map(
            (course, index) =>
              `[${stamp()}]   ${index + 1}. [${course.semester || "未知学期"}] ${course.courseTitle} (#${course.courseId})`,
          ),
        ...(courses.length > 30
          ? [`[${stamp()}]   … 另有 ${courses.length - 30} 门未全部列出`]
          : []),
        `[${stamp()}] 请在「学在浙大 → 学期」下拉中切换学期后勾选课程`,
      ]);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes("zju-login-required")) {
        setZjuStatus("login-required");
        setToast("学在浙大需登录；请先在集成页登录，再点「读取课程列表」");
      } else {
        setToast(`读取课程列表失败：${message}`);
      }
      setSyncDebugLines((current) => [
        ...current,
        `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 课程列表失败 · ${message}`,
      ]);
    } finally {
      setLoadingZjuCourses(false);
    }
  }

  async function requestSourceSync({
    taskId = null,
    silent = false,
    mode = "tasks",
  } = {}) {
    if (syncing || loadingZjuCourses) return;
    const syncMode = taskId ? "tasks" : mode === "grades" ? "grades" : "tasks";
    const includePta = gradeSyncSettings.includePta !== false;
    const zjuSelected = Array.isArray(gradeSyncSettings.zjuCourseIds)
      ? gradeSyncSettings.zjuCourseIds.length
      : 0;
    let gradeSources = null;
    if (syncMode === "grades") {
      gradeSources = [];
      if (includePta) gradeSources.push(SOURCE_PTA);
      if (zjuSelected > 0) gradeSources.push(SOURCE_ZJU);
      if (gradeSources.length === 0) {
        setToast("请先勾选 PTA，或导入并勾选至少一门学在浙大课程");
        setSyncDebugOpen(true);
        setSyncDebugLines([
          `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 未选择任何成绩来源（PTA 未勾选，学在浙大选课 0）`,
        ]);
        return;
      }
    }
    setActiveSyncMode(syncMode);
    setSyncing(true);
    setSyncDebugOpen(true);
    setSyncDebugLines([
      `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 用户触发${syncMode === "grades" ? "成绩" : "任务"}同步` +
        (syncMode === "grades"
          ? ` · 来源 ${gradeSources.join(" → ")}` +
            (zjuSelected ? ` · 学在浙大 ${zjuSelected} 门课` : "")
          : ""),
    ]);
    const task = taskId
      ? tasksRef.current.find((item) => item.id === taskId)
      : null;
    try {
      const result = await syncSources({
        task,
        mode: syncMode,
        sources: gradeSources,
        onProgress: (step) => {
          setSyncDebugLines((current) => {
            const stamp = new Date(step.at).toLocaleTimeString("zh-CN", {
              hour12: false,
            });
            const line = `[${stamp} +${step.elapsedMs ?? 0}ms] ${step.message}`;
            return [...current.slice(-100), line];
          });
        },
      });
      // onProgress already recorded steps; avoid duplicating formatSyncDebugLines.
      const nextPintiaStatus = pintiaStatusFromResult(result);
      if (nextPintiaStatus) setPintiaStatus(nextPintiaStatus);
      const nextZjuStatus = zjuStatusFromResult(result);
      if (nextZjuStatus) setZjuStatus(nextZjuStatus);
      const totalMs = result.debug?.totalMs ?? 0;
      const errorSummary = (result.errors || [])
        .map((item) => `${item.source}:${item.message}`)
        .join("; ");
      if (result.status === "success") {
        const { added, removed, completed, grades } =
          applySuccessfulSourceSync(result);
        setLastSourceSyncAt(result.syncedAt);
        if (!silent) {
          if (syncMode === "grades") {
            setToast(
              grades > 0
                ? `[同步] 成绩写入 ${grades} 项 · ${totalMs}ms · 成功 ${result.syncedSources.join("/") || "无"}`
                : `[同步] 成绩无新增 · ${totalMs}ms · 成功 ${result.syncedSources.join("/") || "无"}` +
                    (errorSummary ? ` · 部分失败 ${errorSummary}` : ""),
            );
          } else {
            const pintiaUpdates = result.updates.filter(
              (item) => item.source === SOURCE_PTA,
            );
            if (
              result.fullSync &&
              completed === 0 &&
              result.updates.length === 0 &&
              result.syncedSources.length === 1 &&
              result.syncedSources.includes(SOURCE_PTA) &&
              pintiaUpdates.length === 0
            ) {
              setToast(
                removed > 0
                  ? `[同步] PTA 无活跃题集，移出 ${removed} · ${totalMs}ms`
                  : `[同步] PTA 无活跃题集 · ${totalMs}ms`,
              );
            } else {
              setToast(
                `[同步] 任务 +${added}/完成${completed}/移出${Math.max(0, removed - completed)} · ${totalMs}ms · ${result.syncedSources.join("/") || "无"}` +
                  (errorSummary ? ` · 部分失败 ${errorSummary}` : ""),
              );
            }
          }
        }
      } else if (result.status === "failed") {
        if (!silent) {
          setToast(
            nextPintiaStatus === "login-required"
              ? `[同步] PTA 需登录 · ${totalMs}ms · ${errorSummary || "pintia-login-required"}`
              : nextPintiaStatus === "session-corrupt"
                ? `[同步] PTA 会话损坏，请重置 · ${totalMs}ms`
                : nextZjuStatus === "login-required"
                  ? `[同步] 学在浙大需登录 · ${totalMs}ms · ${errorSummary || "zju-login-required"}`
                  : `[同步] 失败 ${totalMs}ms · ${errorSummary || "unknown"}（旧数据已保留）`,
          );
        }
      } else if (!silent) {
        setToast("[同步] 来源未连接；请先在集成页登录 PTA 或学在浙大");
      }
    } catch (error) {
      const message = String(error?.message ?? error);
      setSyncDebugLines((current) => [...current, `异常: ${message}`]);
      if (!silent) setToast(`[同步] 异常: ${message}`);
    } finally {
      setSyncing(false);
    }
  }

  async function connectPintia() {
    try {
      if (pintiaStatus === "session-corrupt") {
        await resetPintiaSession();
      } else {
        await openPintiaLogin();
      }
      setPintiaStatus((current) =>
        current === "verified" ? current : "checking",
      );
      setToast(
        pintiaStatus === "session-corrupt"
          ? "已只重置 PTA 登录数据；请重新登录，任务数据未受影响"
          : "已打开 PTA；登录完成后请到「最近 DDL」点更新任务验证会话",
      );
    } catch {
      setToast("PTA 登录窗口只能在 Windows 桌面端打开");
    }
  }

  async function connectZju() {
    try {
      await openZjuLogin();
      setZjuStatus((current) =>
        current === "verified" ? current : "checking",
      );
      setToast("已打开学在浙大；登录完成后请到「最近 DDL」点更新任务验证会话");
    } catch {
      setToast("学在浙大登录窗口只能在 Windows 桌面端打开");
    }
  }

  function createPreset(event) {
    event.preventDefault();
    if (customPresets.length >= 5) {
      setToast("最多保存 5 套自定义模式");
      return;
    }
    const data = new FormData(event.currentTarget);
    const focusMinutes = Number(data.get("focusMinutes"));
    const breakMinutes = Number(data.get("breakMinutes"));
    const preset = {
      id: `custom-${Date.now()}`,
      label: `${focusMinutes}+${breakMinutes}`,
      focusMinutes,
      breakMinutes,
      system: false,
    };
    setCustomPresets((current) => [...current, preset]);
    setFocusState((current) => ({
      ...current,
      modeId: preset.id,
      targetFocusSeconds: focusMinutes * 60,
      focusSeconds: 0,
    }));
    setShowPresetEditor(false);
    setToast(`已保存 ${preset.label} 模式`);
  }

  function deletePreset(presetId) {
    setCustomPresets((current) =>
      current.filter((preset) => preset.id !== presetId),
    );
    if (focusState.modeId === presetId) {
      changeMode("25+5");
    }
    setToast("自定义模式已删除");
  }

  function addWhitelistDomain(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const raw = String(data.get("domain")).trim().toLowerCase();
    const domain = raw
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .replace(/:\d+$/, "");
    if (!domain || !domain.includes(".")) {
      setToast("请输入有效域名，例如 docs.example.com");
      return;
    }
    setPermanentWhitelist((current) =>
      current.includes(domain) ? current : [...current, domain],
    );
    event.currentTarget.reset();
    setToast(`${domain} 已加入工作白名单`);
  }

  function removeWhitelistDomain(domain) {
    setPermanentWhitelist((current) =>
      current.filter((item) => item !== domain),
    );
    setToast(`${domain} 已移出工作白名单`);
  }

  function exportLocalBackup() {
    const backup = createBackupDocument(window.localStorage);
    downloadBackupDocument(backup);
    void saveDesktopBackup(backup).catch(() => undefined);
    setToast("本地备份已导出");
  }

  async function importLocalBackup(file) {
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      await saveDesktopBackup(createBackupDocument(window.localStorage));
      const restored = restoreBackupDocument(backup, window.localStorage);
      setToast(`已恢复 ${restored} 项数据，正在重新加载`);
      window.setTimeout(() => window.location.reload(), 300);
    } catch {
      setToast("备份文件无效，未修改当前数据");
    }
  }

  function saveTaskEdit(event) {
    event.preventDefault();
    const task = tasksRef.current.find((item) => item.id === editingTaskId);
    if (!task || task.sourceLocked) return;
    const data = new FormData(event.currentTarget);
    const deadline = new Date(String(data.get("deadline")));
    const title = String(data.get("title") ?? "").trim();
    if (!title || Number.isNaN(deadline.getTime())) {
      setToast("请填写有效的任务名称和 DDL");
      return;
    }
    const nextTasks = tasksRef.current.map((item) =>
      item.id === task.id
        ? {
            ...item,
            title,
            deadlineAt: deadline.toISOString(),
            deadlineHours: Math.max(
              0,
              (deadline.getTime() - Date.now()) / 3_600_000,
            ),
            importance: String(data.get("importance")),
            goalId: String(data.get("goal")) || null,
            projectId: String(data.get("project")) || null,
            notes: String(data.get("notes") ?? "").trim(),
            estimatedMinutes: Number(data.get("estimatedMinutes")) || null,
          }
        : item,
    );
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    setEditingTaskId(null);
    setToast("任务已保存");
  }

  function saveCompletionRecord(event) {
    event.preventDefault();
    const entry = completionHistory.find(
      (item) => item.id === selectedCompletionId && item.source === "手动",
    );
    if (!entry) return;
    const data = new FormData(event.currentTarget);
    const deadline = new Date(String(data.get("deadline")));
    const title = String(data.get("title") ?? "").trim();
    if (!title || Number.isNaN(deadline.getTime())) {
      setToast("请填写有效的任务名称和原 DDL");
      return;
    }
    setCompletionHistory((current) =>
      current.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              title,
              deadlineAt: deadline.toISOString(),
              importance: String(data.get("importance")),
            }
          : item,
      ),
    );
    setSelectedCompletionId(null);
    setToast("完成记录已保存");
  }

  function deleteCompletionRecord(entryId) {
    const entry = completionHistory.find(
      (item) => item.id === entryId && item.source === "手动",
    );
    if (!entry) return;
    setCompletionHistory((current) =>
      current.filter((item) => item.id !== entryId),
    );
    setSelectedCompletionId(null);
    setToast("完成记录已删除");
  }

  function createTask(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const deadline = new Date(data.get("deadline"));
    const deadlineHours = Math.max(
      0,
      (deadline.getTime() - Date.now()) / 3600000,
    );
    const id = `manual-${Date.now()}`;
    setTasks((current) => [
      ...current,
      {
        id,
        title: String(data.get("title")),
        subtitle: `#MANUAL-${String(Date.now()).slice(-5)}`,
        source: "手动",
        progress: 0,
        deadlineHours,
        deadlineAt: deadline.toISOString(),
        importance: String(data.get("importance")),
        pinned: false,
        sourceLocked: false,
        goalId: String(data.get("goal")) || null,
        projectId: String(data.get("project")) || null,
        notes: String(data.get("notes") ?? "").trim(),
        subtasks: [],
        estimatedMinutes: Number(data.get("estimatedMinutes")) || null,
        focusedSeconds: 0,
        completedPomodoros: 0,
      },
    ]);
    setShowAddTask(false);
    if (draftInboxId) {
      setInbox((current) => current.filter((item) => item.id !== draftInboxId));
      setDraftInboxId(null);
    }
    setToast("任务已添加");
  }

  function captureInboxItem(event) {
    event.preventDefault();
    const title = String(
      new FormData(event.currentTarget).get("title") ?? "",
    ).trim();
    if (!title) return;
    setInbox((current) => [
      { id: `inbox-${Date.now()}`, title, createdAt: new Date().toISOString() },
      ...current,
    ]);
    event.currentTarget.reset();
    setToast("已记录到收件箱");
  }

  function scheduleInboxItem(itemId) {
    setDraftInboxId(itemId);
    setShowAddTask(true);
  }

  function closeAddTask() {
    setShowAddTask(false);
    setDraftInboxId(null);
  }

  function createProject(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    setProjects((current) => [
      ...current,
      {
        id: `project-${Date.now()}`,
        name,
        description: String(data.get("description") ?? "").trim(),
        color: String(data.get("color") || "#315efb"),
      },
    ]);
    setShowAddProject(false);
    setToast("项目已创建");
  }

  function saveProjectEdit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    setProjects((current) =>
      current.map((project) =>
        project.id === editingProjectId
          ? {
              ...project,
              name,
              description: String(data.get("description") ?? "").trim(),
              color: String(data.get("color") || project.color),
            }
          : project,
      ),
    );
    setEditingProjectId(null);
    setToast("项目已保存");
  }

  function deleteProject(projectId) {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    setProjects((current) => current.filter((item) => item.id !== projectId));
    const nextTasks = tasksRef.current.map((task) =>
      task.projectId === projectId ? { ...task, projectId: null } : task,
    );
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    setEditingProjectId(null);
    setToast(`项目“${project.name}”已删除，任务已保留`);
  }

  function createManualTimeEntry(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const endedAt = new Date(String(data.get("endedAt")));
    const focusedSeconds = Math.round(Number(data.get("minutes")) * 60);
    const taskId = String(data.get("task")) || null;
    if (
      Number.isNaN(endedAt.getTime()) ||
      endedAt.getTime() > Date.now() ||
      focusedSeconds <= 0 ||
      focusedSeconds > 24 * 60 * 60
    ) {
      setToast("请填写不晚于现在、且不超过 24 小时的有效时长");
      return;
    }
    const entry = {
      id: `manual-time-${Date.now()}`,
      taskId,
      modeId: "manual",
      focusedSeconds,
      completed: false,
      manual: true,
      endedAt: endedAt.toISOString(),
    };
    setFocusHistory((current) => [...current, entry]);
    if (taskId) {
      setTasks((current) =>
        current.map((task) =>
          task.id === taskId
            ? {
                ...task,
                focusedSeconds:
                  Number(task.focusedSeconds ?? 0) + focusedSeconds,
              }
            : task,
        ),
      );
    }
    if (localDayKey(endedAt) === dailyWork.dayKey) {
      setDailyWork((current) => ({
        ...current,
        seconds: current.seconds + focusedSeconds,
      }));
    }
    setShowManualTime(false);
    setToast("工作时间已补录");
  }

  function deleteManualTimeEntry(entryId) {
    const entry = focusHistory.find(
      (item) => item.id === entryId && item.manual,
    );
    if (!entry) return;
    setFocusHistory((current) => current.filter((item) => item.id !== entryId));
    if (entry.taskId) {
      setTasks((current) =>
        current.map((task) =>
          task.id === entry.taskId
            ? {
                ...task,
                focusedSeconds: Math.max(
                  0,
                  Number(task.focusedSeconds ?? 0) - entry.focusedSeconds,
                ),
              }
            : task,
        ),
      );
    }
    if (localDayKey(new Date(entry.endedAt)) === dailyWork.dayKey) {
      setDailyWork((current) => ({
        ...current,
        seconds: Math.max(0, current.seconds - entry.focusedSeconds),
      }));
    }
    setToast("补录时间已删除");
  }

  function createGoal(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setGoals((current) => [
      ...current,
      {
        id: `goal-${Date.now()}`,
        name: String(data.get("name")),
        description: String(data.get("description")) || "尚未添加说明。",
        progress: 0,
        target: String(data.get("target")) || "未设置",
        next: "添加第一项任务",
      },
    ]);
    setShowAddGoal(false);
    setToast("目标已创建");
  }

  function saveGoalEdit(event) {
    event.preventDefault();
    const goal = goals.find((item) => item.id === editingGoalId);
    if (!goal) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setToast("请填写目标名称");
      return;
    }
    setGoals((current) =>
      current.map((item) =>
        item.id === goal.id
          ? {
              ...item,
              name,
              description:
                String(data.get("description") ?? "").trim() ||
                "尚未添加说明。",
              target: String(data.get("target")) || "未设置",
              next: String(data.get("next") ?? "").trim() || "添加下一项任务",
              progress: Math.max(
                0,
                Math.min(100, Number(data.get("progress")) || 0),
              ),
            }
          : item,
      ),
    );
    setEditingGoalId(null);
    setToast("目标已保存");
  }

  function deleteGoal(goalId) {
    const goal = goals.find((item) => item.id === goalId);
    if (!goal) return;
    setGoals((current) => current.filter((item) => item.id !== goalId));
    const nextTasks = tasksRef.current.map((task) =>
      task.goalId === goalId ? { ...task, goalId: null } : task,
    );
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    setEditingGoalId((current) => (current === goalId ? null : current));
    setToast(`目标“${goal.name}”已删除，关联任务已保留`);
  }

  function updateSelectedProgress(progress) {
    const nextTasks = tasksRef.current.map((task) =>
      task.id === selectedTaskId ? { ...task, progress } : task,
    );
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
  }

  function addSubtask(event, taskId) {
    event.preventDefault();
    const title = String(
      new FormData(event.currentTarget).get("subtask") ?? "",
    ).trim();
    if (!title) return;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              subtasks: [
                ...(task.subtasks ?? []),
                { id: `subtask-${Date.now()}`, title, completed: false },
              ],
            }
          : task,
      ),
    );
    event.currentTarget.reset();
  }

  function toggleSubtask(taskId, subtaskId) {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              subtasks: (task.subtasks ?? []).map((subtask) =>
                subtask.id === subtaskId
                  ? { ...subtask, completed: !subtask.completed }
                  : subtask,
              ),
            }
          : task,
      ),
    );
  }

  function deleteSubtask(taskId, subtaskId) {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              subtasks: (task.subtasks ?? []).filter(
                (subtask) => subtask.id !== subtaskId,
              ),
            }
          : task,
      ),
    );
  }

  const viewTitles = {
    deadlines: "最近 DDL",
    today: "今日计划",
    completed: "今日完成",
    grades: "成绩",
    inbox: "收件箱",
    goals: "目标",
    projects: "项目",
    overdue: "过期任务",
    stats: "统计",
    integrations: "集成",
    settings: "设置",
  };

  function renderMainContent() {
    if (activeView === "goals")
      return (
        <GoalsView
          goals={goals}
          onCreate={() => setShowAddGoal(true)}
          onEdit={setEditingGoalId}
          onDelete={deleteGoal}
        />
      );
    if (activeView === "completed")
      return (
        <CompletedTodayView
          entries={todayMetrics.completedToday}
          onSelect={setSelectedCompletionId}
        />
      );
    if (activeView === "grades")
      return (
        <GradebookView
          records={gradeRecords}
          search={search}
          syncSettings={gradeSyncSettings}
          onSyncSettingsChange={setGradeSyncSettings}
          onSync={() => requestSourceSync({ mode: "grades" })}
          syncing={syncing && activeSyncMode === "grades"}
          zjuCourses={zjuCourseCatalog}
          onLoadZjuCourses={requestLoadZjuCourses}
          loadingZjuCourses={loadingZjuCourses}
        />
      );
    if (activeView === "today") {
      return (
        <TodayPlanView
          tasks={todayPlanTasks}
          onStart={startTask}
          onTogglePin={togglePin}
          onSelect={selectTask}
          onMove={moveTodayTask}
        />
      );
    }
    if (activeView === "inbox") {
      return (
        <InboxView
          items={inbox}
          onCapture={captureInboxItem}
          onRemove={(itemId) =>
            setInbox((current) => current.filter((item) => item.id !== itemId))
          }
          onSchedule={scheduleInboxItem}
        />
      );
    }
    if (activeView === "projects") {
      return (
        <ProjectsView
          projects={projects}
          tasks={displayTasks}
          onCreate={() => setShowAddProject(true)}
          onEdit={setEditingProjectId}
          onDelete={deleteProject}
        />
      );
    }
    if (activeView === "stats")
      return (
        <StatsView
          focusState={focusState}
          workedSeconds={workedSeconds}
          history={todayFocusHistory}
          tasks={displayTasks}
          onAddManual={() => setShowManualTime(true)}
          onDeleteManual={deleteManualTimeEntry}
        />
      );
    if (activeView === "settings")
      return (
        <SettingsView
          whitelist={permanentWhitelist}
          onAddDomain={addWhitelistDomain}
          onRemoveDomain={removeWhitelistDomain}
          onExportBackup={exportLocalBackup}
          onImportBackup={(file) => void importLocalBackup(file)}
        />
      );
    if (activeView === "deadlines") {
      return (
        <section className="deadlines-view">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">按 DDL 升序 · 手动置顶优先</p>
              <h1>最近 DDL</h1>
            </div>
            <div className="section-heading-actions">
              <span className="result-count">{sortedTasks.length} 项</span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void requestSourceSync({ mode: "tasks" })}
                disabled={syncing}
                title={
                  lastSourceSyncAt
                    ? `上次任务更新：${new Date(lastSourceSyncAt).toLocaleString()}`
                    : "只更新活跃任务 DDL，不扫成绩详情"
                }
              >
                <ArrowsClockwise />{" "}
                {syncing && activeSyncMode === "tasks"
                  ? "正在更新任务"
                  : "更新任务"}
              </button>
            </div>
          </div>
          <TaskTable
            tasks={sortedTasks}
            onStart={startTask}
            onTogglePin={togglePin}
            onSelect={selectTask}
          />
        </section>
      );
    }
    if (activeView === "overdue") {
      const overdueTasks = sortedTasks.filter(
        (task) => task.deadlineHours <= 0,
      );
      if (overdueTasks.length === 0) {
        return (
          <EmptyView
            icon={WarningCircle}
            title="没有过期任务"
            description="手动任务过期后可在这里编辑 DDL、完成或删除；来源任务保持只读。"
          />
        );
      }
      return (
        <section className="deadlines-view">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">先处理仍未完成的历史 DDL</p>
              <h1>过期任务</h1>
            </div>
            <span className="result-count">{overdueTasks.length} 项</span>
          </div>
          <TaskTable
            tasks={overdueTasks}
            ariaLabel="过期任务"
            onStart={startTask}
            onTogglePin={togglePin}
            onSelect={selectTask}
          />
        </section>
      );
    }
    if (activeView === "integrations") {
      return (
        <IntegrationsView
          lastSyncAt={lastSourceSyncAt}
          pintiaStatus={pintiaStatus}
          zjuStatus={zjuStatus}
          onConnectPintia={() => void connectPintia()}
          onConnectZju={() => void connectZju()}
        />
      );
    }
    const placeholders = {
      overdue: [
        WarningCircle,
        "过期任务",
        "手动任务可选择完成、延期或放弃；来源任务保持只读。",
      ],
      stats: [
        ChartBar,
        "统计",
        "工作时间、完成率和预计与实际差异会汇总在这里。",
      ],
      settings: [Gear, "设置", "调整通知、计时、隐私、备份和同步。"],
    };
    const [Icon, title, description] = placeholders[activeView];
    return (
      <EmptyView
        icon={Icon}
        title={title}
        description={description}
        action={
          <button
            className="secondary-button"
            onClick={() => setToast(`${title}设置将在下一阶段接入`)}
          >
            查看说明
          </button>
        }
      />
    );
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <Timer weight="duotone" />
          </div>
          <strong>Fuck DDL</strong>
          <button
            className="icon-button collapse-button"
            aria-label="折叠侧边栏"
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <SidebarSimple />
          </button>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          {navItems.map(({ id, label, icon: Icon }) => {
            const badge =
              id === "completed"
                ? todayMetrics.completedCount
                : id === "overdue"
                  ? todayMetrics.overdueCount
                  : 0;
            return (
              <button
                className={activeView === id ? "active" : ""}
                key={id}
                onClick={() => setActiveView(id)}
                title={label}
              >
                <Icon weight={activeView === id ? "fill" : "regular"} />
                <span>{label}</span>
                {badge > 0 && <em>{badge}</em>}
              </button>
            );
          })}
        </nav>
        <nav className="utility-nav" aria-label="辅助导航">
          <button
            className={activeView === "settings" ? "active" : ""}
            onClick={() => setActiveView("settings")}
          >
            <Gear />
            <span>设置</span>
          </button>
        </nav>
      </aside>

      <header className="topbar">
        <button
          className="primary-button quick-add"
          onClick={() => {
            setDraftInboxId(null);
            setShowAddTask(true);
          }}
        >
          <Plus weight="bold" /> 快速添加 <CaretDown />
        </button>
        <label className="search-box">
          <MagnifyingGlass />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索任务、项目或备注"
            aria-label="搜索"
          />
          <kbd>Ctrl K</kbd>
        </label>
        <div className="topbar-spacer" />
        <button
          className={`timer-chip ${timerRunning ? "is-running" : ""}`}
          onClick={togglePause}
          aria-label={focusState.phase === "paused" ? "继续专注" : "切换计时"}
        >
          {focusState.phase === "focusing" ? (
            <Pause weight="fill" />
          ) : (
            <Play weight="fill" />
          )}
          <span>{formatDuration(timerSeconds)}</span>
          <CaretDown />
        </button>
        <div className="account-wrap">
          <button
            className="account-button"
            aria-label="账户菜单"
            onClick={() => setAccountOpen((value) => !value)}
          >
            <GithubLogo weight="fill" />
            <CaretDown />
          </button>
          {accountOpen && (
            <div className="account-menu">
              {authStatus === "checking" && <span>正在恢复登录状态…</span>}
              {authStatus === "not-configured" && (
                <>
                  <strong>GitHub 登录未配置</strong>
                  <span>
                    本地任务可继续使用；请配置 Supabase 后启用跨设备登录。
                  </span>
                </>
              )}
              {authStatus === "ready" && !authUser && (
                <>
                  <strong>使用 GitHub 登录</strong>
                  <span>仅允许已加入白名单的 GitHub 账号注册。</span>
                  <button
                    onClick={() => void startGithubLogin()}
                    disabled={authBusy}
                  >
                    <GithubLogo weight="fill" />{" "}
                    {authBusy ? "正在跳转…" : "使用 GitHub 登录"}
                  </button>
                </>
              )}
              {authStatus === "ready" && authUser && (
                <>
                  <strong>
                    {githubUser.login || authUser.email || "GitHub 用户"}
                  </strong>
                  <span>GitHub 已授权 · 云端同步将在下一阶段接入</span>
                  <button
                    onClick={() => void signOutGithub()}
                    disabled={authBusy}
                  >
                    <SignOut /> 退出登录
                  </button>
                </>
              )}
              {authError && (
                <p className="account-error" role="alert">
                  {authError}
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="main-content" aria-label={viewTitles[activeView]}>
        {renderMainContent()}
      </main>

      <aside className="insight-rail">
        <section>
          <h2>
            <CalendarBlank /> 今日概览
          </h2>
          <span className="metric-label">今日工作时间</span>
          <strong className="work-time">
            {Math.floor(workedSeconds / 3600)}小时
            {Math.floor((workedSeconds % 3600) / 60)}分
          </strong>
          <span className="metric-label completion-label">今日完成率</span>
          <strong className="completion-value">
            {todayCompletionPercent === null
              ? "—"
              : `${todayCompletionPercent}%`}
          </strong>
          <div className="track overview-track">
            <span style={{ width: `${todayCompletionPercent ?? 0}%` }} />
          </div>
          <small>
            {todayMetrics.totalCount === 0
              ? "今天还没有到期或完成任务"
              : `完成任务 ${todayMetrics.completedCount} / ${todayMetrics.totalCount}`}
          </small>
          <div className="rest-ledger-summary">
            <span className="metric-label">今日休息额度</span>
            <strong
              className={focusState.restBalanceSeconds < 0 ? "is-negative" : ""}
            >
              {focusState.restBalanceSeconds < 0 ? "−" : "+"}
              {formatDuration(Math.abs(focusState.restBalanceSeconds))}
            </strong>
            <div className="ledger-track" aria-hidden="true">
              <span className="ledger-zero" />
              <span
                className={
                  focusState.restBalanceSeconds < 0
                    ? "ledger-value negative"
                    : "ledger-value positive"
                }
                style={{
                  width: `${Math.min(50, Math.abs(focusState.restBalanceSeconds) / 36)}%`,
                }}
              />
            </div>
          </div>
        </section>
        <section className="focus-panel">
          <h2>
            <Crosshair /> 当前专注
          </h2>
          <div className="focus-task">
            <span />
            <strong>{activeTask?.title ?? "临时专注"}</strong>
          </div>
          <label className="focus-task-picker">
            <span>专注任务</span>
            <select
              value={activeTaskId}
              onChange={(event) => selectFocusTask(event.target.value)}
              disabled={focusState.phase !== "idle"}
              aria-label="专注任务"
            >
              <option value="">临时专注</option>
              {displayTasks.map((task) => (
                <option value={task.id} key={task.id}>
                  {task.title} · {task.source}
                </option>
              ))}
            </select>
          </label>
          {activeTask && (
            <div className="focus-meta">
              <SourceBadge source={activeTask.source} />
              <span
                style={{
                  color: `var(--${urgencyMeta(activeTask.deadlineHours).tone})`,
                }}
              >
                {formatRemaining(activeTask.deadlineHours)}
              </span>
            </div>
          )}
          <span className="metric-label">
            {focusState.phase === "resting"
              ? "正在休息"
              : focusState.phase === "distracted"
                ? `摸鱼 · ${focusState.distractionDomain}`
                : focusState.phase === "paused"
                  ? "专注已暂停"
                  : "专注计时"}
          </span>
          <strong className="focus-duration">
            {formatDuration(timerSeconds)}
          </strong>
          <div className="mode-switch" aria-label="计时模式">
            {presets.map((preset) => (
              <button
                className={focusState.modeId === preset.id ? "active" : ""}
                key={preset.id}
                onClick={() => changeMode(preset.id)}
                disabled={focusState.phase !== "idle"}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="focus-controls">
            {focusState.phase === "distracted" ? (
              <button
                className="primary-button"
                onClick={resumeDistractedFocus}
              >
                <Play weight="fill" /> 继续专注
              </button>
            ) : focusState.phase === "resting" ? (
              <button className="secondary-button" onClick={stopRestTimer}>
                <Stop weight="fill" /> 结束休息
              </button>
            ) : (
              <>
                <button className="primary-button" onClick={togglePause}>
                  {focusState.phase === "focusing" ? (
                    <Pause weight="fill" />
                  ) : (
                    <Play weight="fill" />
                  )}
                  {focusState.phase === "focusing"
                    ? "暂停"
                    : focusState.phase === "paused"
                      ? "继续"
                      : "开始"}
                </button>
                {focusState.phase === "paused" ||
                focusState.phase === "focusing" ? (
                  <button
                    className="secondary-button"
                    onClick={finishCurrentFocus}
                  >
                    <Stop weight="fill" /> 停止
                  </button>
                ) : (
                  <button className="secondary-button" onClick={beginRest}>
                    <Coffee /> 休息
                  </button>
                )}
              </>
            )}
          </div>
          {focusState.phase === "distracted" && (
            <div className="domain-actions">
              <button onClick={() => allowCurrentDomain(false)}>
                本轮允许
              </button>
              <button onClick={() => allowCurrentDomain(true)}>永久允许</button>
            </div>
          )}
          <div className="focus-links">
            <button
              className="preset-link"
              onClick={() => setShowPresetEditor(true)}
              disabled={focusState.phase !== "idle"}
            >
              <SlidersHorizontal /> 调整模式
            </button>
            <button
              className="preset-link"
              onClick={() => startTask(null)}
              disabled={focusState.phase !== "idle"}
            >
              <Timer /> 临时专注
            </button>
          </div>
          {activeTask?.estimatedMinutes && activePreset.focusMinutes && (
            <small className="estimate-note">
              已完成 {activeTask.completedPomodoros ?? 0} / 预计{" "}
              {estimatedPomodoros(
                activeTask.estimatedMinutes,
                activePreset.focusMinutes,
              )}{" "}
              个番茄
            </small>
          )}
        </section>
        <section>
          <h2>
            <ListChecks /> 今日待办
          </h2>
          <dl className="status-list">
            <div>
              <dt>进行中</dt>
              <dd>{todayMetrics.inProgressCount}</dd>
            </div>
            <div>
              <dt>待开始</dt>
              <dd>{todayMetrics.notStartedCount}</dd>
            </div>
            <div>
              <dt>已完成</dt>
              <dd>{todayMetrics.completedCount}</dd>
            </div>
            <div>
              <dt>过期</dt>
              <dd className="critical-number">{todayMetrics.overdueCount}</dd>
            </div>
          </dl>
        </section>
        <section className="notes-section">
          <h2>
            <NotePencil /> 备注
          </h2>
          <button
            onClick={() => {
              if (activeTask && !activeTask.sourceLocked) {
                setEditingTaskId(activeTask.id);
              } else {
                setToast("请先选择一个手动任务");
              }
            }}
          >
            {activeTask?.notes || "点击编辑当前任务备注…"}
          </button>
        </section>
      </aside>

      {focusState.phase !== "idle" && (
        <div className={`mini-timer phase-${focusState.phase}`}>
          <span className="mini-pulse" />
          <div>
            <small>
              {focusState.phase === "resting"
                ? "正式休息"
                : focusState.phase === "distracted"
                  ? `摸鱼 · ${focusState.distractionDomain}`
                  : (activeTask?.title ?? "临时专注")}
            </small>
            <strong>{formatDuration(timerSeconds)}</strong>
          </div>
          {["focusing", "paused"].includes(focusState.phase) && (
            <button className="icon-button" onClick={togglePause}>
              {focusState.phase === "focusing" ? <Pause /> : <Play />}
            </button>
          )}
          {focusState.phase === "resting" && (
            <button className="icon-button" onClick={stopRestTimer}>
              <Stop weight="fill" />
            </button>
          )}
          {focusState.phase === "distracted" && (
            <button className="icon-button" onClick={resumeDistractedFocus}>
              <Play weight="fill" />
            </button>
          )}
        </div>
      )}

      <nav className="mobile-nav" aria-label="移动端导航">
        {navItems.slice(0, 5).map(({ id, label, icon: Icon }) => (
          <button
            className={activeView === id ? "active" : ""}
            key={id}
            onClick={() => setActiveView(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {showAddTask && (
        <Modal title="快速添加任务" onClose={closeAddTask}>
          <form className="form-stack" onSubmit={createTask}>
            <label>
              任务名称
              <input
                name="title"
                required
                autoFocus
                defaultValue={
                  inbox.find((item) => item.id === draftInboxId)?.title ?? ""
                }
                placeholder="例如：完成实验报告"
              />
            </label>
            <label>
              DDL
              <input name="deadline" type="datetime-local" required />
            </label>
            <label>
              备注（可选）
              <textarea
                name="notes"
                rows="2"
                placeholder="记录交付要求、资料位置或下一步"
              />
            </label>
            <div className="form-grid">
              <label>
                重要程度
                <select name="importance" defaultValue="medium">
                  <option value="low">低</option>
                  <option value="medium">普通</option>
                  <option value="high">重要</option>
                  <option value="critical">关键</option>
                </select>
              </label>
              <label>
                所属目标
                <select name="goal" defaultValue="">
                  <option value="">不关联目标</option>
                  {goals.map((goal) => (
                    <option value={goal.id} key={goal.id}>
                      {goal.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                所属项目
                <select name="project" defaultValue="">
                  <option value="">不关联项目</option>
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                预计耗时（分钟，可选）
                <input
                  name="estimatedMinutes"
                  type="number"
                  min="1"
                  step="5"
                  placeholder="例如：100"
                />
              </label>
            </div>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={closeAddTask}
              >
                取消
              </button>
              <button className="primary-button" type="submit">
                <Check /> 添加任务
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {editingTask && (
        <Modal title="编辑任务" onClose={() => setEditingTaskId(null)}>
          <form className="form-stack" onSubmit={saveTaskEdit}>
            <label>
              任务名称
              <input
                name="title"
                required
                autoFocus
                defaultValue={editingTask.title}
              />
            </label>
            <label>
              DDL
              <input
                name="deadline"
                type="datetime-local"
                required
                defaultValue={dateTimeLocalValue(editingTask.deadlineAt)}
              />
            </label>
            <label>
              备注（可选）
              <textarea
                name="notes"
                rows="3"
                defaultValue={editingTask.notes ?? ""}
              />
            </label>
            <div className="form-grid">
              <label>
                重要程度
                <select name="importance" defaultValue={editingTask.importance}>
                  <option value="low">低</option>
                  <option value="medium">普通</option>
                  <option value="high">重要</option>
                  <option value="critical">关键</option>
                </select>
              </label>
              <label>
                所属目标
                <select name="goal" defaultValue={editingTask.goalId ?? ""}>
                  <option value="">不关联目标</option>
                  {goals.map((goal) => (
                    <option value={goal.id} key={goal.id}>
                      {goal.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                所属项目
                <select
                  name="project"
                  defaultValue={editingTask.projectId ?? ""}
                >
                  <option value="">不关联项目</option>
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                预计耗时（分钟，可选）
                <input
                  name="estimatedMinutes"
                  type="number"
                  min="1"
                  step="5"
                  defaultValue={editingTask.estimatedMinutes ?? ""}
                />
              </label>
            </div>
            <footer className="editor-footer">
              <button
                type="button"
                className="danger-button compact-danger"
                onClick={() => deleteManualTask(editingTask.id)}
              >
                <Trash /> 删除任务
              </button>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setEditingTaskId(null)}
                >
                  取消
                </button>
                <button className="primary-button" type="submit">
                  <Check /> 保存任务
                </button>
              </div>
            </footer>
          </form>
        </Modal>
      )}

      {showManualTime && (
        <Modal title="补录工作时间" onClose={() => setShowManualTime(false)}>
          <form className="form-stack" onSubmit={createManualTimeEntry}>
            <label>
              结束时间
              <input
                name="endedAt"
                type="datetime-local"
                required
                max={dateTimeLocalValue(new Date().toISOString())}
                defaultValue={dateTimeLocalValue(new Date().toISOString())}
              />
            </label>
            <div className="form-grid">
              <label>
                工作时长（分钟）
                <input
                  name="minutes"
                  type="number"
                  min="1"
                  max="1440"
                  step="1"
                  required
                  defaultValue="30"
                />
              </label>
              <label>
                对应任务（可选）
                <select name="task" defaultValue="">
                  <option value="">临时工作</option>
                  {displayTasks.map((task) => (
                    <option value={task.id} key={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowManualTime(false)}
              >
                取消
              </button>
              <button className="primary-button" type="submit">
                <Check /> 保存补录
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {showAddProject && (
        <Modal title="新建项目" onClose={() => setShowAddProject(false)}>
          <form className="form-stack" onSubmit={createProject}>
            <label>
              项目名称
              <input
                name="name"
                required
                autoFocus
                placeholder="例如：信息安全综合实践"
              />
            </label>
            <label>
              说明
              <textarea
                name="description"
                rows="3"
                placeholder="这个项目包含哪些工作？"
              />
            </label>
            <label>
              项目标记色
              <input name="color" type="color" defaultValue="#315efb" />
            </label>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowAddProject(false)}
              >
                取消
              </button>
              <button className="primary-button" type="submit">
                <Check /> 创建项目
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {editingProject && (
        <Modal title="编辑项目" onClose={() => setEditingProjectId(null)}>
          <form className="form-stack" onSubmit={saveProjectEdit}>
            <label>
              项目名称
              <input
                name="name"
                required
                autoFocus
                defaultValue={editingProject.name}
              />
            </label>
            <label>
              说明
              <textarea
                name="description"
                rows="3"
                defaultValue={editingProject.description}
              />
            </label>
            <label>
              项目标记色
              <input
                name="color"
                type="color"
                defaultValue={editingProject.color}
              />
            </label>
            <footer className="editor-footer">
              <button
                type="button"
                className="danger-button compact-danger"
                onClick={() => deleteProject(editingProject.id)}
              >
                <Trash /> 删除项目
              </button>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setEditingProjectId(null)}
                >
                  取消
                </button>
                <button className="primary-button" type="submit">
                  <Check /> 保存项目
                </button>
              </div>
            </footer>
          </form>
        </Modal>
      )}

      {showAddGoal && (
        <Modal title="新建目标" onClose={() => setShowAddGoal(false)}>
          <form className="form-stack" onSubmit={createGoal}>
            <label>
              目标名称
              <input
                name="name"
                required
                autoFocus
                placeholder="例如：完成本学期课程"
              />
            </label>
            <label>
              说明
              <textarea
                name="description"
                rows="3"
                placeholder="这个目标为什么重要？"
              />
            </label>
            <label>
              目标日期
              <input name="target" type="date" />
            </label>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowAddGoal(false)}
              >
                取消
              </button>
              <button className="primary-button" type="submit">
                <Check /> 创建目标
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {editingGoal && (
        <Modal title="编辑目标" onClose={() => setEditingGoalId(null)}>
          <form className="form-stack" onSubmit={saveGoalEdit}>
            <label>
              目标名称
              <input
                name="name"
                required
                autoFocus
                defaultValue={editingGoal.name}
              />
            </label>
            <label>
              说明
              <textarea
                name="description"
                rows="3"
                defaultValue={editingGoal.description}
              />
            </label>
            <div className="form-grid">
              <label>
                目标日期
                <input
                  name="target"
                  type="date"
                  defaultValue={
                    editingGoal.target === "未设置" ? "" : editingGoal.target
                  }
                />
              </label>
              <label>
                下一项
                <input name="next" defaultValue={editingGoal.next} />
              </label>
              <label>
                整体进度（%）
                <input
                  name="progress"
                  type="number"
                  min="0"
                  max="100"
                  defaultValue={editingGoal.progress}
                />
              </label>
            </div>
            <footer className="editor-footer">
              <button
                type="button"
                className="danger-button compact-danger"
                onClick={() => deleteGoal(editingGoal.id)}
              >
                <Trash /> 删除目标
              </button>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setEditingGoalId(null)}
                >
                  取消
                </button>
                <button className="primary-button" type="submit">
                  <Check /> 保存目标
                </button>
              </div>
            </footer>
          </form>
        </Modal>
      )}

      {selectedCompletion && (
        <Modal
          title="编辑已完成任务"
          onClose={() => setSelectedCompletionId(null)}
        >
          <form className="form-stack" onSubmit={saveCompletionRecord}>
            <p className="completion-record-note">
              完成于
              {new Date(selectedCompletion.completedAt).toLocaleString("zh-CN")}
            </p>
            <label>
              任务名称
              <input
                name="title"
                required
                autoFocus
                defaultValue={selectedCompletion.title}
              />
            </label>
            <div className="form-grid">
              <label>
                原 DDL
                <input
                  name="deadline"
                  type="datetime-local"
                  required
                  defaultValue={dateTimeLocalValue(
                    selectedCompletion.deadlineAt,
                  )}
                />
              </label>
              <label>
                重要程度
                <select
                  name="importance"
                  defaultValue={selectedCompletion.importance}
                >
                  <option value="low">低</option>
                  <option value="medium">普通</option>
                  <option value="high">重要</option>
                  <option value="critical">关键</option>
                </select>
              </label>
            </div>
            <footer className="editor-footer">
              <button
                type="button"
                className="danger-button compact-danger"
                onClick={() => deleteCompletionRecord(selectedCompletion.id)}
              >
                <Trash /> 删除记录
              </button>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setSelectedCompletionId(null)}
                >
                  取消
                </button>
                <button className="primary-button" type="submit">
                  <Check /> 保存记录
                </button>
              </div>
            </footer>
          </form>
        </Modal>
      )}

      {showPresetEditor && (
        <Modal title="调整番茄模式" onClose={() => setShowPresetEditor(false)}>
          <div className="preset-editor">
            <div className="preset-list">
              {presets.map((preset) => (
                <div key={preset.id}>
                  <span>
                    <strong>{preset.label}</strong>
                    <small>
                      {preset.focusMinutes === null
                        ? "自由计时，默认按 20%产生休息额度"
                        : `${preset.focusMinutes} 分钟专注 / ${preset.breakMinutes} 分钟额度`}
                    </small>
                  </span>
                  {!preset.system && (
                    <button
                      className="icon-button"
                      onClick={() => deletePreset(preset.id)}
                      aria-label={`删除 ${preset.label}`}
                    >
                      <Trash />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <form className="form-stack preset-form" onSubmit={createPreset}>
              <div className="form-grid">
                <label>
                  专注分钟
                  <input
                    name="focusMinutes"
                    type="number"
                    min="15"
                    max="180"
                    defaultValue="50"
                    required
                  />
                </label>
                <label>
                  休息分钟
                  <input
                    name="breakMinutes"
                    type="number"
                    min="5"
                    max="60"
                    defaultValue="20"
                    required
                  />
                </label>
              </div>
              <footer>
                <small>{customPresets.length} / 5 套自定义模式</small>
                <button className="primary-button" type="submit">
                  <Plus /> 保存模式
                </button>
              </footer>
            </form>
          </div>
        </Modal>
      )}

      {completedSession && (
        <Modal title="本轮专注已记录" onClose={closeCompletion}>
          <div className="completion-dialog">
            <div className="completion-time">
              <span>
                {completedSession.completed ? "完整番茄" : "提前结束"}
              </span>
              <strong>{formatDuration(completedSession.focusedSeconds)}</strong>
            </div>
            {(() => {
              const task = tasks.find(
                (item) => item.id === completedSession.taskId,
              );
              if (!task) return <p>本次为临时专注，没有绑定任务。</p>;
              if (task.sourceLocked)
                return (
                  <div className="source-progress-note">
                    <SourceBadge source={task.source} />
                    <p>完成程度由来源网站读取，不能手动修改。</p>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        void requestSourceSync({ taskId: task.id })
                      }
                      disabled={syncing}
                    >
                      <ArrowsClockwise />
                      {syncing ? "正在更新" : "立即更新"}
                    </button>
                  </div>
                );
              return (
                <label className="completion-slider">
                  <span>
                    更新完成程度 <strong>{progressDraft}%</strong>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={progressDraft}
                    onChange={(event) =>
                      setProgressDraft(Number(event.target.value))
                    }
                  />
                  <small>保持当前值即可跳过更新。</small>
                </label>
              );
            })()}
            <div className="completion-actions">
              <button className="primary-button" onClick={beginRest}>
                <Coffee /> 开始休息
              </button>
              <button className="secondary-button" onClick={continueFocusCycle}>
                <Play /> 继续一轮
              </button>
              <button className="secondary-button" onClick={closeCompletion}>
                结束
              </button>
            </div>
          </div>
        </Modal>
      )}

      {selectedTask && (
        <div
          className="drawer-backdrop"
          onMouseDown={() => setSelectedTaskId(null)}
        >
          <aside
            className="task-drawer"
            onMouseDown={(event) => event.stopPropagation()}
            aria-label="任务详情"
          >
            <header>
              <div>
                <SourceBadge source={selectedTask.source} />
                <h2>{selectedTask.title}</h2>
                <p>{selectedTask.subtitle}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setSelectedTaskId(null)}
                aria-label="关闭"
              >
                <X />
              </button>
            </header>
            <div className="drawer-section">
              <span>优先级分数</span>
              <strong>{taskScore(selectedTask).toFixed(1)}</strong>
            </div>
            <div className="drawer-section">
              <ProgressPair task={selectedTask} />
            </div>
            <div className="drawer-section">
              <label>
                完成程度{" "}
                {selectedTask.sourceProgressEstimated
                  ? "部分完成（平台未提供百分比）"
                  : `${selectedTask.progress}%`}
              </label>
              <input
                type="range"
                min="0"
                max="100"
                value={selectedTask.progress}
                disabled={selectedTask.sourceLocked}
                onChange={(event) =>
                  updateSelectedProgress(Number(event.target.value))
                }
              />
              {selectedTask.sourceLocked && (
                <small>
                  该字段由 {selectedTask.source} 同步，无法手动修改。
                </small>
              )}
            </div>
            <div className="drawer-section task-notes-block">
              <span>备注</span>
              <p>{selectedTask.notes || "暂无备注"}</p>
            </div>
            <div className="drawer-section subtask-block">
              <div className="subtask-heading">
                <span>子任务</span>
                <strong>{(selectedTask.subtasks ?? []).length} 项</strong>
              </div>
              {(selectedTask.subtasks ?? []).map((subtask) => (
                <div className="subtask-row" key={subtask.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={subtask.completed}
                      disabled={selectedTask.sourceLocked}
                      onChange={() =>
                        toggleSubtask(selectedTask.id, subtask.id)
                      }
                    />
                    <span>{subtask.title}</span>
                  </label>
                  {!selectedTask.sourceLocked && (
                    <button
                      className="icon-button danger-icon-button"
                      onClick={() => deleteSubtask(selectedTask.id, subtask.id)}
                      aria-label={`删除子任务 ${subtask.title}`}
                    >
                      <X />
                    </button>
                  )}
                </div>
              ))}
              {!selectedTask.sourceLocked && (
                <form
                  className="subtask-form"
                  onSubmit={(event) => addSubtask(event, selectedTask.id)}
                >
                  <input
                    name="subtask"
                    required
                    placeholder="添加下一步"
                    aria-label="子任务名称"
                  />
                  <button
                    className="icon-button"
                    type="submit"
                    aria-label="添加子任务"
                  >
                    <Plus />
                  </button>
                </form>
              )}
            </div>
            <div className="drawer-actions">
              <button
                className="primary-button"
                onClick={() => startTask(selectedTask.id)}
              >
                <Play weight="fill" /> 开始任务
              </button>
              {!selectedTask.sourceLocked && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    setEditingTaskId(selectedTask.id);
                    setSelectedTaskId(null);
                  }}
                >
                  <NotePencil /> 编辑任务
                </button>
              )}
              <button
                className="secondary-button"
                onClick={() => togglePin(selectedTask.id)}
              >
                <PushPin /> {selectedTask.pinned ? "取消置顶" : "置顶"}
              </button>
              {!selectedTask.sourceLocked && (
                <button
                  className="secondary-button complete-task-button"
                  onClick={() => completeManualTask(selectedTask)}
                >
                  <CheckCircle weight="fill" /> 完成并归档
                </button>
              )}
            </div>
            {!selectedTask.sourceLocked && (
              <button
                className="danger-button"
                onClick={() => deleteManualTask(selectedTask.id)}
              >
                <Trash /> 删除任务
              </button>
            )}
          </aside>
        </div>
      )}

      {syncDebugOpen && syncDebugLines.length > 0 && (
        <aside className="sync-debug-panel" aria-label="同步调试信息">
          <header>
            <strong>同步调试</strong>
            <span>
              {syncing
                ? activeSyncMode === "grades"
                  ? "成绩同步中…"
                  : "任务同步中…"
                : "最近一次"}
            </span>
            <div className="sync-debug-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void navigator.clipboard?.writeText?.(
                    syncDebugLines.join("\n"),
                  );
                  setToast("[同步] 调试信息已复制");
                }}
              >
                复制
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setSyncDebugOpen(false);
                  setSyncDebugLines([]);
                }}
              >
                关闭
              </button>
            </div>
          </header>
          <pre>{syncDebugLines.join("\n")}</pre>
        </aside>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle weight="fill" /> {toast}
        </div>
      )}
    </div>
  );
}
