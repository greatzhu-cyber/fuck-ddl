import { useMemo, useState } from "react";
import { Exam, WarningCircle } from "@phosphor-icons/react";
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
  const [sourceFilter, setSourceFilter] = useState(() => {
    if (records.some((record) => record.sourceName === SOURCE_PTA)) {
      return SOURCE_PTA;
    }
    return SOURCE_ZJU;
  });
  const [courseFilter, setCourseFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [viewSinceDate, setViewSinceDate] = useState("");
  const [viewLimit, setViewLimit] = useState("50");
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
  const activeSemester = useMemo(
    () =>
      selectedSemester && zjuSemesters.includes(selectedSemester)
        ? selectedSemester
        : "",
    [selectedSemester, zjuSemesters],
  );
  const coursesInSemester = useMemo(
    () =>
      zjuCourses.filter(
        (course) =>
          activeSemester && (course.semester || "未知学期") === activeSemester,
      ),
    [activeSemester, zjuCourses],
  );
  const zjuViewCourses = useMemo(
    () =>
      coursesInSemester
        .map((course) => course.courseTitle)
        .filter(Boolean)
        .filter((courseName, index, list) => list.indexOf(courseName) === index)
        .sort((left, right) => left.localeCompare(right, "zh-CN")),
    [coursesInSemester],
  );
  const sourceCounts = useMemo(
    () => ({
      [SOURCE_PTA]: records.filter((record) => record.sourceName === SOURCE_PTA)
        .length,
      [SOURCE_ZJU]: records.filter((record) => record.sourceName === SOURCE_ZJU)
        .length,
    }),
    [records],
  );

  function patchSyncSettings(patch) {
    onSyncSettingsChange({
      ...syncSettings,
      ...patch,
    });
  }

  function selectGradeSource(source) {
    setSourceFilter(source);
    setCourseFilter("all");
    setStatusFilter("all");
    if (source === SOURCE_ZJU) {
      setSelectedSemester("");
    }
  }

  function selectZjuViewSemester(value) {
    setSourceFilter(SOURCE_ZJU);
    setSelectedSemester(value);
    setCourseFilter("all");
  }

  function selectZjuCourse(course) {
    setSourceFilter(SOURCE_ZJU);
    setSelectedSemester(course.semester || "未知学期");
    setCourseFilter(course.courseTitle);
    if (!selectedZjuIds.has(String(course.courseId))) {
      patchSyncSettings({
        zjuCourseIds: [...selectedZjuIds, String(course.courseId)],
      });
    }
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
    }).filter(
      (record) =>
        sourceFilter !== SOURCE_ZJU ||
        courseFilter !== "all" ||
        zjuCourses.length === 0 ||
        zjuViewCourses.includes(record.courseName),
    );
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
    zjuCourses,
    zjuViewCourses,
    viewSinceDate,
  ]);
  const summary = useMemo(() => summarizeGrades(filtered), [filtered]);
  const rate =
    summary.scoreRate === null
      ? "—"
      : `${(summary.scoreRate * 100).toFixed(1)}%`;
  const showSemesterPrompt =
    sourceFilter === SOURCE_ZJU && zjuCourses.length > 0 && !activeSemester;

  return (
    <section
      className={`gradebook-view ${showSemesterPrompt ? "is-semester-prompt" : ""}`}
    >
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

      <section className="grade-source-directory" aria-label="选择查看成绩">
        <div className="grade-directory-heading">
          <div>
            <p className="eyebrow">成绩目录</p>
            <h2>按平台找到课程</h2>
          </div>
          <span>{syncSummary}</span>
        </div>

        <div className="grade-directory-columns">
          <article
            className={`grade-directory-panel grade-directory-pta ${sourceFilter === SOURCE_PTA ? "is-active" : ""}`}
          >
            <button
              type="button"
              className="grade-directory-root"
              aria-pressed={sourceFilter === SOURCE_PTA}
              onClick={() => selectGradeSource(SOURCE_PTA)}
            >
              <span className="grade-directory-monogram is-pta">PTA</span>
              <span>
                <strong>PTA</strong>
                <small>点击查看全部 PTA 成绩</small>
              </span>
              <b>{sourceCounts[SOURCE_PTA]}</b>
            </button>
            <div className="grade-directory-pta-body">
              <p>PTA 不再拆分课程目录，进入后直接汇总所有题集成绩。</p>
              <label className="grade-directory-check">
                <input
                  type="checkbox"
                  checked={includePta}
                  onChange={(event) =>
                    patchSyncSettings({ includePta: event.target.checked })
                  }
                  aria-label="更新时读取 PTA 成绩"
                />
                更新成绩时读取 PTA
              </label>
            </div>
          </article>

          <article
            className={`grade-directory-panel grade-directory-zju ${sourceFilter === SOURCE_ZJU ? "is-active" : ""}`}
          >
            <div className="grade-directory-zju-head">
              <button
                type="button"
                className="grade-directory-root"
                aria-pressed={sourceFilter === SOURCE_ZJU}
                onClick={() => selectGradeSource(SOURCE_ZJU)}
              >
                <span className="grade-directory-monogram is-zju">ZJU</span>
                <span>
                  <strong>学在浙大</strong>
                  <small>学期 → 课程</small>
                </span>
                <b>{sourceCounts[SOURCE_ZJU]}</b>
              </button>
              <div className="grade-directory-zju-actions">
                <span className="grade-connection-pill">
                  <i />
                  {zjuCourses.length > 0 ? "已连接" : "未读取"}
                </span>
                <button
                  type="button"
                  className="grade-directory-import"
                  onClick={onLoadZjuCourses}
                  disabled={loadingZjuCourses || syncing}
                >
                  {loadingZjuCourses ? "读取中…" : "读取课程"}
                </button>
              </div>
            </div>

            {zjuCourses.length === 0 ? (
              <div className="grade-directory-empty">
                <span>还没有课程目录</span>
                <small>读取后会按学期归档，不会与 PTA 混在一起。</small>
              </div>
            ) : (
              <div className="grade-zju-directory-body">
                <div className="grade-semester-control">
                  <label>
                    <span>学期</span>
                    <select
                      aria-label="学在浙大学期"
                      value={activeSemester}
                      onChange={(event) =>
                        selectZjuViewSemester(event.target.value)
                      }
                    >
                      <option value="">请选择学期</option>
                      {zjuSemesters.map((semester) => (
                        <option value={semester} key={semester}>
                          {semester}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="grade-semester-actions">
                    <button type="button" onClick={selectAllZjuCourses}>
                      全选
                    </button>
                    <button type="button" onClick={clearZjuCourses}>
                      清空
                    </button>
                  </div>
                </div>
                {activeSemester && (
                  <ul
                    role="tree"
                    className="grade-course-tree"
                    aria-label="学在浙大学期课程目录"
                  >
                    {coursesInSemester.map((course) => {
                      const courseId = String(course.courseId);
                      const checked = selectedZjuIds.has(courseId);
                      const active =
                        sourceFilter === SOURCE_ZJU &&
                        courseFilter === course.courseTitle;
                      return (
                        <li
                          key={courseId}
                          className={active ? "is-active" : ""}
                        >
                          <button
                            type="button"
                            onClick={() => selectZjuCourse(course)}
                            aria-pressed={active}
                          >
                            <span>{course.courseTitle}</span>
                            <small>{active ? "正在查看" : "查看成绩"}</small>
                          </button>
                          <label title="勾选后参与下一次成绩更新">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleZjuCourse(courseId)}
                              aria-label={`更新课程 ${course.courseTitle}`}
                            />
                            <span>更新</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </article>
        </div>

        <div className="grade-directory-footer">
          <span>更新范围</span>
          <label>
            <span>从</span>
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
            <span>最多</span>
            <select
              aria-label="成绩更新条目数"
              value={syncSettings.maxItems}
              onChange={(event) =>
                patchSyncSettings({ maxItems: Number(event.target.value) })
              }
            >
              {[20, 50, 100, 200].map((limit) => (
                <option value={limit} key={limit}>
                  {limit} 项
                </option>
              ))}
            </select>
          </label>
          <small>课程行用于查看；右侧“更新”勾选决定下一次读取哪些课程。</small>
        </div>
      </section>
      <div className="gradebook-filters" aria-label="成绩筛选">
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

      {showSemesterPrompt ? (
        <div className="gradebook-semester-empty">
          <Exam weight="duotone" />
          <h2>未选择学期，课程列表暂不显示</h2>
          <p>请选择学在浙大的学期后查看课程列表</p>
        </div>
      ) : records.length === 0 ? (
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
