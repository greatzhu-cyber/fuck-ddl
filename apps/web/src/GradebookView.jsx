import { useMemo, useState } from "react";
import {
  CaretDown,
  CaretRight,
  Exam,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  DEFAULT_GRADE_SYNC_SETTINGS,
  GRADE_STATUS,
  filterGradeRecords,
  listZjuSemesters,
  summarizeGrades,
} from "./grades.js";
import { SOURCE_PTA, SOURCE_ZJU } from "./source-names.js";

const STATUS_COPY = Object.freeze({
  [GRADE_STATUS.PUBLISHED]: "已出分",
  [GRADE_STATUS.UNPUBLISHED]: "未公布",
  [GRADE_STATUS.MISSED]: "错过 DDL",
  [GRADE_STATUS.UNKNOWN]: "待确认",
});

function displayNumber(value) {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function displayDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function scoreLabel(record) {
  if (record.status === GRADE_STATUS.MISSED) return "错过";
  if (record.status !== GRADE_STATUS.PUBLISHED) return "—";
  return displayNumber(record.score);
}

function GradeBand({ records }) {
  if (records.length === 0) return null;
  return (
    <div className="grade-band" aria-label="成绩状态带">
      {records.slice(0, 40).map((record) => {
        const ratio =
          record.status === GRADE_STATUS.PUBLISHED &&
          Number.isFinite(record.score) &&
          Number.isFinite(record.maxScore) &&
          record.maxScore > 0
            ? Math.max(0, Math.min(1, record.score / record.maxScore))
            : 0;
        return (
          <span
            key={record.id}
            className={`grade-band-mark is-${record.status}`}
            title={`${record.title} · ${STATUS_COPY[record.status]}`}
            aria-label={`${record.title}，${STATUS_COPY[record.status]}`}
          >
            <i style={{ height: `${Math.max(8, ratio * 100)}%` }} />
          </span>
        );
      })}
    </div>
  );
}

export function GradebookView({
  records,
  search = "",
  syncSettings = DEFAULT_GRADE_SYNC_SETTINGS,
  onSyncSettingsChange = () => {},
  onSync = () => {},
  syncing = false,
  zjuCourses = [],
  onLoadZjuCourses = () => {},
  loadingZjuCourses = false,
}) {
  const [sourceFilter, setSourceFilter] = useState("all");
  const [courseFilter, setCourseFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [viewSinceDate, setViewSinceDate] = useState("");
  const [viewLimit, setViewLimit] = useState("50");
  // Always show source tree by default — users need PTA + 学在浙大→学期→课程.
  const [showSyncScope, setShowSyncScope] = useState(true);
  const [zjuBranchOpen, setZjuBranchOpen] = useState(true);
  const includePta = syncSettings.includePta !== false;
  const selectedZjuIds = useMemo(
    () =>
      new Set(
        Array.isArray(syncSettings.zjuCourseIds)
          ? syncSettings.zjuCourseIds.map(String)
          : [],
      ),
    [syncSettings.zjuCourseIds],
  );
  const zjuSemesters = useMemo(
    () => listZjuSemesters(zjuCourses),
    [zjuCourses],
  );
  const [selectedSemester, setSelectedSemester] = useState("");
  const activeSemester = useMemo(() => {
    if (selectedSemester && zjuSemesters.includes(selectedSemester)) {
      return selectedSemester;
    }
    return zjuSemesters[0] || "";
  }, [selectedSemester, zjuSemesters]);
  const coursesInSemester = useMemo(
    () =>
      zjuCourses.filter(
        (course) =>
          !activeSemester || (course.semester || "未知学期") === activeSemester,
      ),
    [activeSemester, zjuCourses],
  );
  const courseOptions = useMemo(
    () =>
      [
        ...new Set(records.map((record) => record.courseName).filter(Boolean)),
      ].sort((left, right) => left.localeCompare(right, "zh-CN")),
    [records],
  );

  function patchSyncSettings(patch) {
    onSyncSettingsChange({
      ...syncSettings,
      ...patch,
    });
  }

  function toggleZjuCourse(courseId) {
    const id = String(courseId);
    const next = new Set(selectedZjuIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patchSyncSettings({ zjuCourseIds: [...next] });
  }

  function clearZjuCourses() {
    patchSyncSettings({ zjuCourseIds: [] });
  }

  function selectAllZjuCourses() {
    // Select all courses in the active semester only.
    const ids = new Set(selectedZjuIds);
    for (const course of coursesInSemester) {
      ids.add(String(course.courseId));
    }
    patchSyncSettings({ zjuCourseIds: [...ids] });
  }

  const syncSummary = [
    includePta ? "PTA" : null,
    selectedZjuIds.size > 0
      ? `学在浙大 ${selectedZjuIds.size} 门`
      : "学在浙大未选课",
  ]
    .filter(Boolean)
    .join(" · ");
  const filtered = useMemo(() => {
    const selected = filterGradeRecords(records, {
      sourceName: sourceFilter === "all" ? null : sourceFilter,
      courseName: courseFilter === "all" ? null : courseFilter,
      status: statusFilter === "all" ? null : statusFilter,
    });
    const query = search.trim().toLowerCase();
    const sorted = selected
      .filter(
        (record) =>
          !query ||
          record.title.toLowerCase().includes(query) ||
          record.courseName.toLowerCase().includes(query),
      )
      .sort(
        (left, right) =>
          Date.parse(right.deadlineAt ?? right.completedAt ?? 0) -
          Date.parse(left.deadlineAt ?? left.completedAt ?? 0),
      );
    const dated = viewSinceDate
      ? sorted.filter((record) => {
          const value =
            record.startedAt ?? record.deadlineAt ?? record.completedAt;
          return (
            value &&
            Date.parse(value) >= Date.parse(`${viewSinceDate}T00:00:00+08:00`)
          );
        })
      : sorted;
    return viewLimit === "all" ? dated : dated.slice(0, Number(viewLimit));
  }, [
    courseFilter,
    records,
    search,
    sourceFilter,
    statusFilter,
    viewLimit,
    viewSinceDate,
  ]);
  const summary = useMemo(() => summarizeGrades(filtered), [filtered]);
  const rate =
    summary.scoreRate === null
      ? "—"
      : `${(summary.scoreRate * 100).toFixed(1)}%`;

  return (
    <section className="gradebook-view">
      <div className="section-heading gradebook-heading">
        <div>
          <p className="eyebrow">来源成绩 · 只读归档</p>
          <h1>成绩</h1>
          <p className="gradebook-intro">
            已出分参与得分率；未公布保持空白；未提交且截止的任务单独记为错过
            DDL。
          </p>
        </div>
        <div className="section-heading-actions">
          <span className="result-count">{summary.totalRecords} 项</span>
          <button
            type="button"
            className="secondary-button"
            onClick={onLoadZjuCourses}
            disabled={loadingZjuCourses || syncing}
            aria-label="读取课程列表"
            title="自动打开学在浙大「我的课程」并导入本地"
          >
            {loadingZjuCourses ? "正在读取课程列表…" : "读取课程列表"}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onSync}
            disabled={syncing || loadingZjuCourses}
          >
            {syncing ? "正在更新成绩" : "更新成绩"}
          </button>
        </div>
      </div>

      <section className="grade-sync-scope" aria-label="成绩更新来源">
        <button
          type="button"
          className="grade-sync-scope-toggle"
          aria-expanded={showSyncScope}
          onClick={() => setShowSyncScope((current) => !current)}
        >
          <span>更新成绩来源</span>
          <strong>
            {syncSummary}
            {syncSettings.sinceDate ? ` · 自 ${syncSettings.sinceDate}` : ""} ·
            最多 {syncSettings.maxItems} 项
          </strong>
        </button>
        {showSyncScope && (
          <div className="grade-sync-scope-body">
            <div className="grade-sync-scope-controls">
              <label>
                <span>从这天开始</span>
                <input
                  aria-label="成绩更新起始日期"
                  type="date"
                  value={syncSettings.sinceDate}
                  onChange={(event) =>
                    patchSyncSettings({ sinceDate: event.target.value })
                  }
                />
              </label>
              <label>
                <span>最多纳入</span>
                <select
                  aria-label="成绩更新条目数"
                  value={syncSettings.maxItems}
                  onChange={(event) =>
                    patchSyncSettings({
                      maxItems: Number(event.target.value),
                    })
                  }
                >
                  {[20, 50, 100, 200].map((limit) => (
                    <option value={limit} key={limit}>
                      {limit} 项
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grade-source-tree" aria-label="成绩来源树">
              <label className="grade-source-node">
                <input
                  type="checkbox"
                  checked={includePta}
                  onChange={(event) =>
                    patchSyncSettings({ includePta: event.target.checked })
                  }
                  aria-label="更新 PTA 成绩"
                />
                <span className="grade-source-node-title">PTA</span>
                <small>勾选后随「更新成绩」读取 PTA</small>
              </label>

              <div className="grade-source-branch">
                <div className="grade-source-node grade-source-node-branch">
                  <button
                    type="button"
                    className="grade-source-branch-toggle"
                    aria-expanded={zjuBranchOpen}
                    onClick={() => setZjuBranchOpen((current) => !current)}
                    aria-label={
                      zjuBranchOpen
                        ? "折叠学在浙大课程列表"
                        : "展开学在浙大课程列表"
                    }
                  >
                    {zjuBranchOpen ? <CaretDown /> : <CaretRight />}
                  </button>
                  <span className="grade-source-node-title">学在浙大</span>
                  <small>
                    学期 → 课程（已导入 {zjuCourses.length} 门 · 已选{" "}
                    {selectedZjuIds.size} 门）
                  </small>
                </div>

                {zjuBranchOpen && (
                  <div
                    className="grade-zju-course-picker"
                    aria-label="学在浙大课程列表"
                  >
                    <div className="grade-zju-course-picker-head">
                      <span>学期 / 课程</span>
                      <div className="grade-zju-course-picker-actions">
                        <button
                          type="button"
                          className="primary-button grade-zju-import-button"
                          onClick={onLoadZjuCourses}
                          disabled={loadingZjuCourses || syncing}
                          aria-label="读取并导入课程列表"
                        >
                          {loadingZjuCourses
                            ? "正在自动读取写入…"
                            : "读取课程列表"}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={selectAllZjuCourses}
                          disabled={
                            coursesInSemester.length === 0 ||
                            syncing ||
                            loadingZjuCourses
                          }
                        >
                          全选本学期
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={clearZjuCourses}
                          disabled={selectedZjuIds.size === 0 || syncing}
                        >
                          清空
                        </button>
                      </div>
                    </div>
                    {zjuCourses.length === 0 ? (
                      <p className="grade-zju-course-empty">
                        尚未导入课程。点「读取课程列表」会自动翻页抓取学在浙大「我的课程」（含学期标签），写入本地后再：先选学期
                        → 再勾课程。
                      </p>
                    ) : (
                      <>
                        <label className="grade-zju-semester-label">
                          <span>学期</span>
                          <select
                            aria-label="学在浙大学期"
                            value={activeSemester}
                            onChange={(event) =>
                              setSelectedSemester(event.target.value)
                            }
                          >
                            {zjuSemesters.map((semester) => (
                              <option value={semester} key={semester}>
                                {semester}（
                                {
                                  zjuCourses.filter(
                                    (course) =>
                                      (course.semester || "未知学期") ===
                                      semester,
                                  ).length
                                }{" "}
                                门）
                              </option>
                            ))}
                          </select>
                        </label>
                        <ul className="grade-zju-course-list">
                          {coursesInSemester.map((course) => {
                            const checked = selectedZjuIds.has(
                              String(course.courseId),
                            );
                            return (
                              <li key={course.courseId}>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() =>
                                      toggleZjuCourse(course.courseId)
                                    }
                                    aria-label={`选择课程 ${course.courseTitle}`}
                                  />
                                  <span>{course.courseTitle}</span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    )}
                    <small>
                      先选学期再勾课。已交+分数→直接入成绩；仅已交→未公布；未交已截止→错过
                      DDL。
                    </small>
                  </div>
                )}
              </div>
            </div>

            <p className="grade-sync-hint">
              点右上角「更新成绩」时：按上方勾选分别跑 PTA /
              学在浙大选中课程。至少勾选 PTA 或一门学在浙大课。
            </p>
          </div>
        )}
      </section>

      <div className="gradebook-filters" aria-label="成绩筛选">
        <label>
          <span>来源</span>
          <select
            aria-label="成绩来源"
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value)}
          >
            <option value="all">全部来源</option>
            <option value={SOURCE_PTA}>PTA</option>
            <option value={SOURCE_ZJU}>学在浙大</option>
          </select>
        </label>
        <label>
          <span>课程</span>
          <select
            aria-label="成绩课程"
            value={courseFilter}
            onChange={(event) => setCourseFilter(event.target.value)}
          >
            <option value="all">全部课程</option>
            {courseOptions.map((courseName) => (
              <option value={courseName} key={courseName}>
                {courseName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>状态</span>
          <select
            aria-label="成绩状态"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">全部状态</option>
            <option value={GRADE_STATUS.PUBLISHED}>已出分</option>
            <option value={GRADE_STATUS.UNPUBLISHED}>未公布</option>
            <option value={GRADE_STATUS.MISSED}>错过 DDL</option>
            <option value={GRADE_STATUS.UNKNOWN}>待确认</option>
          </select>
        </label>
        <label>
          <span>从</span>
          <input
            aria-label="成绩查看起始日期"
            type="date"
            value={viewSinceDate}
            onChange={(event) => setViewSinceDate(event.target.value)}
          />
        </label>
        <label>
          <span>显示</span>
          <select
            aria-label="成绩显示条目数"
            value={viewLimit}
            onChange={(event) => setViewLimit(event.target.value)}
          >
            <option value="20">20 项</option>
            <option value="50">50 项</option>
            <option value="100">100 项</option>
            <option value="all">全部</option>
          </select>
        </label>
      </div>

      {records.length === 0 ? (
        <div className="gradebook-empty">
          <Exam weight="duotone" />
          <h2>还没有成绩记录</h2>
          <p>
            在本页设置更新范围后点击「更新成绩」，已结束或已批阅的来源记录会出现在这里。任务请到「最近
            DDL」单独更新。
          </p>
        </div>
      ) : (
        <>
          <section className="grade-scoreboard" aria-label="成绩概览">
            <div className="grade-rate">
              <span>可计算得分率</span>
              <strong>{rate}</strong>
              <small>
                {summary.possibleScore > 0
                  ? `${displayNumber(summary.earnedScore)} / ${displayNumber(summary.possibleScore)} 分`
                  : "暂无已公布且有满分的成绩"}
              </small>
            </div>
            <div className="grade-band-panel">
              <div className="grade-counts">
                <span>
                  已出分 <strong>{summary.totalPublished}</strong>
                </span>
                <span>
                  未公布 <strong>{summary.totalUnpublished}</strong>
                </span>
                <span className="is-missed">
                  错过 DDL <strong>{summary.totalMissed}</strong>
                </span>
              </div>
              <GradeBand records={filtered} />
              <small>每一格代表一项成绩；高度表示该项得分率。</small>
            </div>
          </section>

          {filtered.length === 0 ? (
            <div className="gradebook-filter-empty">
              <WarningCircle /> 当前筛选下没有成绩
            </div>
          ) : (
            <div className="grade-ledger" role="table" aria-label="成绩记录">
              <div className="grade-ledger-header" role="row">
                <span>成绩</span>
                <span>任务与课程</span>
                <span>来源</span>
                <span>状态</span>
                <span>时间</span>
              </div>
              {filtered.map((record) => (
                <article
                  className={`grade-entry is-${record.status}`}
                  role="row"
                  key={record.id}
                >
                  <div className="grade-entry-score" role="cell">
                    <strong>{scoreLabel(record)}</strong>
                    {record.status === GRADE_STATUS.PUBLISHED && (
                      <span>/ {displayNumber(record.maxScore)}</span>
                    )}
                  </div>
                  <div className="grade-entry-copy" role="cell">
                    <strong>{record.title}</strong>
                    <span>{record.courseName}</span>
                    {record.rank !== null && (
                      <small>
                        排名 {displayNumber(record.rank)}
                        {record.rankingTotal !== null
                          ? ` / ${displayNumber(record.rankingTotal)}`
                          : ""}
                      </small>
                    )}
                  </div>
                  <div role="cell">
                    <span
                      className={`source-badge ${record.sourceName === SOURCE_PTA ? "source-pta" : "source-zju"}`}
                    >
                      {record.sourceName}
                    </span>
                  </div>
                  <div role="cell">
                    <span className={`grade-status is-${record.status}`}>
                      {STATUS_COPY[record.status]}
                    </span>
                  </div>
                  <time
                    role="cell"
                    dateTime={record.deadlineAt ?? record.completedAt ?? ""}
                  >
                    {displayDate(record.deadlineAt ?? record.completedAt)}
                  </time>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
